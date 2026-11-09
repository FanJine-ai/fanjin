import { createCanvasRuns } from "./canvasRuns";
import { canvasRunDefinitions } from "./canvasRunContracts";
import { planCanvasGroupExecution } from "../../../../contracts/canvas/groupExecution";
import type { CommercialTenant } from "@/lib/commercialTenant";
import { invalidToolArguments } from "./inputGuidance";
import { canvasToolDefinitions } from "./canvasContracts";
import { editCanvas } from "./canvasEditing";
import { studioOperations, studioOperation, describeStudioOperation, studioToolDefinitions } from "./studioCatalog";
import type { StudioGateway } from "./studioRuntime";
import { studioInputSchema } from "./studioSchema";
import { humanContinuation } from "./humanContinuation";
import { requireLiveWorkspaceAuthority, WorkspaceAuthorityError } from "@/lib/workspaceAccess";
import { publicModelId, publicH3ModelCapability, modelAllowlistIncludes } from "@/lib/minimaxH3PublicIdentity";
import { managedPortraitWorkflow } from "@/lib/portraitAccessGuidance";
import { createAnalyticsService, type AnalyticsAudit } from "@/analytics/service";
import { AnalyticsError } from "@/analytics/contracts";
import { createCreationService, type CreationGateway } from "./creationService";
import { creationToolDefinitions, generationRequestSchema } from "./creationContracts";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import { getEffectiveWorkspacePermissions } from "@/middleware/permissions";
import type { WorkbenchModelCatalog, WorkbenchModelCapability } from "@/lib/workbenchModelCatalog";
import { assertToolSize, GU_UNITS, guAmount, ledgerAmount, MAX_TOOL_BYTES, TOOL_API_VERSION, ToolError, toolDefinitions, toolFailure, type ToolName, type ToolResponse } from "./contracts";

export type ToolConnection = { commercialTenant?: CommercialTenant; apiKeyId: string; defaultProjectId?: number; defaultCanvasId?: number; transport: "http" | "mcp"; source?: "api" | "cli" | "mcp" };
type Identity = { commercialTenant?: CommercialTenant; workspaceId: string; userId: number; keyId: string; permissions: string[]; memberPermissions: string[]; modelAllowlist: string[]; keyQuotaLimit: number; defaultProjectId?: number; source?: "api" | "cli" | "mcp" };
type Dependencies = { database: Knex; catalog: (workspaceId: string) => Promise<WorkbenchModelCatalog>; now?: () => number; creationGateway?: CreationGateway; analyticsAudit?: AnalyticsAudit; studioGateway?: StudioGateway };
const memberRoles = new Set(["owner", "workspace_admin", "creator"]);
const text = (value: unknown, limit = 200): string | null => value == null ? null : String(value).slice(0, limit);
const coordinate = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;

function list(raw: unknown, allowNull = false): string[] {
  if (raw == null && allowNull) return [];
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch { /* Malformed authorization data must not become an unrestricted list. */ }
  throw new ToolError("INVALID_KEY_POLICY", "密钥授权配置无效", 403);
}

function permits(values: string[], permission: string) {
  return values.some((value) => value === "*" || value === permission || (value.endsWith(":*") && permission.startsWith(value.slice(0, -1))));
}

function allowed(identity: Identity, name: ToolName) {
  if (name === "fanjin_analytics_query" && !["usage:read", "usage:read:workspace", "billing:read", "account:read"].some(p => permits(identity.permissions, p))) return false;
  const definition = toolDefinitions[name];
  return (!definition.keyPermission || permits(identity.permissions, definition.keyPermission)) &&
    (!definition.memberPermission || permits(identity.memberPermissions, definition.memberPermission));
}

const cursorSchema = z.strictObject({ scope: z.string(), after: z.union([z.string(), z.number().int().positive()]) });
function readCursor(cursor: string | undefined, scope: string) {
  if (!cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (value.scope !== scope) throw new Error();
    return value.after;
  } catch { throw new ToolError("INVALID_CURSOR", "分页游标无效，或不属于当前查询"); }
}
function cursorFor(scope: string, after: string | number) {
  return Buffer.from(JSON.stringify({ scope, after })).toString("base64url");
}

function projectView(row: Record<string, any>, details = false) {
  return {
    id: Number(row.id), name: text(row.name), projectType: text(row.projectType), mode: text(row.mode),
    revision: Number(row.revision || 1), createdAt: Number(row.createTime || 0), updatedAt: Number(row.updatedAt || 0),
    ...(details ? { intro: text(row.intro, 20000), type: text(row.type, 500), artStyle: text(row.artStyle, 2000), videoRatio: text(row.videoRatio, 100), directorManual: text(row.directorManual, 20000), imageModel: text(row.imageModel), videoModel: text(row.videoModel), imageQuality: text(row.imageQuality) } : {}),
  };
}

function modelView(model: WorkbenchModelCapability) {
  model = publicH3ModelCapability(model);
  return {
    modelId: model.id, model: model.model, label: model.label,
    type: model.endpointType === "image_generation" ? "image" : "video",
    capabilityStatus: model.capabilityStatus, canSubmit: model.canSubmit,
    qualities: model.qualities ?? [], resolutions: model.resolutions ?? [], aspectRatios: model.aspectRatios,
    defaultQuality: model.defaultQuality, defaultResolution: model.defaultResolution, defaultAspectRatio: model.defaultAspectRatio,
    duration: model.duration ? { auto: model.duration.auto, min: model.duration.min, max: model.duration.max, step: model.duration.step, default: model.duration.default, allowed: model.duration.allowed } : null,
    inputSlots: model.inputSlots ?? [],
    // Operation-specific settings are authoritative for native source edits.
    // Never expose route/account or formal pricing evidence through MCP.
    videoGeneration: model.videoGeneration ? {
      version: model.videoGeneration.version,
      contractFamily: model.videoGeneration.contractFamily,
      dispatchable: model.videoGeneration.dispatchable,
      outputFormats: model.videoGeneration.outputFormats,
      defaultOutputFormat: model.videoGeneration.defaultOutputFormat,
      draft: model.videoGeneration.draft,
      operations: model.videoGeneration.operations.map(operation => ({
        operation: operation.operation, enabled: operation.enabled, modes: operation.modes,
        aspectRatios: operation.aspectRatios, duration: operation.duration,
        nativeResolutions: operation.nativeResolutions, fulfillmentResolutions: operation.fulfillmentResolutions,
      })),
      inputSlots: model.videoGeneration.inputSlots,
      totalInputLimit: model.videoGeneration.totalInputLimit,
      mediaTypeLimits: model.videoGeneration.mediaTypeLimits,
      supportsPreserveSourceAudio: model.videoGeneration.supportsPreserveSourceAudio,
      supportsTimeRange: model.videoGeneration.supportsTimeRange,
      supportsMask: model.videoGeneration.supportsMask,
    } : null,
    modes: model.modes ?? [], supportsGenerateAudio: model.supportsGenerateAudio ?? false,
  };
}

function graphList(raw: unknown): Record<string, any>[] {
  if (typeof raw === "string" && Buffer.byteLength(raw) > MAX_TOOL_BYTES) throw new ToolError("CANVAS_TOO_LARGE", "画布超过摘要读取上限", 413);
  let value: unknown;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw ?? []; } catch { throw new ToolError("INVALID_CANVAS", "画布数据暂时无法读取", 503); }
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new ToolError("INVALID_CANVAS", "画布数据暂时无法读取", 503);
  return value;
}

export function createToolService({ database: db, catalog, now = Date.now, creationGateway, analyticsAudit, studioGateway }: Dependencies) {
  async function identityFor(connection: ToolConnection, database: Knex | Knex.Transaction = db): Promise<Identity> {
    const key = await database("o_api_key").where({ id: connection.apiKeyId }).first();
    if (!key || Number(key.disabled) !== 0 || Number(key.revokedAt || 0) !== 0 || !Number.isFinite(Number(key.expiresAt || 0)) || Number(key.expiresAt || 0) < 0 || (Number(key.expiresAt || 0) > 0 && Number(key.expiresAt) <= now())) {
      throw new ToolError("KEY_UNAVAILABLE", "密钥无效、停用或已过期", 401);
    }
    if (key.scope !== "workspace" || !key.workspaceId || !Number.isSafeInteger(Number(key.ownerUserId)) || Number(key.ownerUserId) <= 0) {
      throw new ToolError("WORKSPACE_KEY_REQUIRED", "工具需要绑定成员和工作区的 API Key", 403);
    }
    const workspaceId = String(key.workspaceId);
    const userId = Number(key.ownerUserId);
    const user = await database("o_user").where({ id: userId, status: "active" }).first();
    const workspace = await database("o_workspace").where({ id: workspaceId, status: "active" }).first();
    const member = await database("o_workspace_member").where({ workspaceId, userId, status: "active" }).first();
    if (!user || !workspace || !member || !memberRoles.has(String(member.role))) {
      throw new ToolError("MEMBERSHIP_REQUIRED", "所属账号或工作区成员权限不可用", 403);
    }
    const memberRole = getConsistentWorkspaceRole({ userId, memberRole: member.role, ownerUserId: workspace.ownerUserId });
    if (!memberRole) throw new ToolError("MEMBERSHIP_REQUIRED", "工作区成员身份需要核对", 403);
    const identity: Identity = {
      commercialTenant: connection.commercialTenant, workspaceId, userId, keyId: String(key.id), source: connection.source || (connection.transport === "mcp" ? "mcp" : "api"), permissions: list(key.permissions),
      memberPermissions: getEffectiveWorkspacePermissions({ role: memberRole, permissions: member.permissions }),
      modelAllowlist: list(key.modelAllowlist, true), keyQuotaLimit: Number(key.quotaLimit || 0), defaultProjectId: connection.defaultProjectId,
    };
    if (connection.transport === "mcp" && !permits(identity.permissions, "mcp:connect")) throw new ToolError("PERMISSION_DENIED", "密钥未授权 MCP 连接", 403);
    return identity;
  }

  const creation = creationGateway ? createCreationService(db, creationGateway, keyId => identityFor({ apiKeyId: keyId, transport: "http" }), now) : undefined;
  const canvasRuns = creation ? createCanvasRuns(db, async (keyId, name, input) => {
    const response = await execute({ apiKeyId: keyId, transport: "http" }, name, input);
    if (!response.body.ok) throw new ToolError(response.body.error!.code, response.body.error!.message, response.status);
    return response.body.data as Record<string, any>;
  }, keyId => identityFor({ apiKeyId: keyId, transport: "http" }), now) : undefined;
  const enabled = (name: string) => Object.hasOwn(canvasRunDefinitions, name) ? Boolean(canvasRuns) : Object.hasOwn(studioToolDefinitions, name) ? Boolean(studioGateway) : Boolean(creation) || !Object.hasOwn(creationToolDefinitions, name);

  async function requireProject(identity: Identity, inputId: number | undefined) {
    const projectId = inputId ?? identity.defaultProjectId;
    if (!projectId) throw new ToolError("PROJECT_REQUIRED", "请提供 projectId");
    const project = await db("o_project").where({ id: projectId, workspaceId: identity.workspaceId, deletionState: "active" }).first();
    if (!project) throw new ToolError("PROJECT_NOT_FOUND", "项目不存在或无权访问", 404);
    return project;
  }

  async function modelsFor(identity: Identity, type?: "image" | "video") {
    const result = await catalog(identity.workspaceId);
    return result.models.filter((model) =>
      (!type || model.endpointType === `${type}_generation`) &&
      // Relay enforces model names, so route IDs and aliases cannot expand a key's allow-list.
      (!identity.modelAllowlist.length || modelAllowlistIncludes(identity.modelAllowlist, model.model)),
    ).map(modelView).sort((a, b) => `${a.type}:${a.modelId}`.localeCompare(`${b.type}:${b.modelId}`, "en"));
  }

  async function execute(connection: ToolConnection, name: string, raw: unknown): Promise<{ status: number; body: ToolResponse }> {
    const requestId = randomUUID();
    try {
      if (!Object.hasOwn(toolDefinitions, name) || !enabled(name)) throw new ToolError("TOOL_NOT_FOUND", "工具不存在或尚未开放", 404);
      assertToolSize(raw);
      const toolName = name as ToolName;
      const candidate = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } as Record<string, any> : raw;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const input = candidate as Record<string, any>;
        if (connection.defaultProjectId && Object.hasOwn(toolDefinitions[toolName].schema.shape, "projectId") && input.projectId === undefined) input.projectId = connection.defaultProjectId;
        if (toolName === "fanjin_generation_quote" && connection.defaultProjectId && input.request && typeof input.request === "object" && !Array.isArray(input.request) && input.request.projectId === undefined) input.request = { ...input.request, projectId: connection.defaultProjectId };
        if ((Object.hasOwn(canvasToolDefinitions, toolName) || ["fanjin_canvas_get", "fanjin_canvas_attach"].includes(toolName)) && connection.defaultCanvasId && input.canvasId === undefined && input.projectId === connection.defaultProjectId) input.canvasId = connection.defaultCanvasId;
      }
      const parsed = toolDefinitions[toolName].schema.safeParse(candidate);
      if (!parsed.success) throw invalidToolArguments(parsed.error);
      const identity = await identityFor(connection);
      if (!allowed(identity, toolName)) throw new ToolError("PERMISSION_DENIED", "密钥或所属成员未获授权", 403);
      const input = parsed.data as Record<string, any>;
      if (Object.hasOwn(creationToolDefinitions, toolName) && Object.hasOwn(toolDefinitions[toolName].schema.shape, "projectId") && !input.projectId) throw new ToolError("PROJECT_REQUIRED", "请指定 projectId，或在 MCP 连接地址绑定项目");
      if (toolName === "fanjin_generation_quote") {
        if (!input.request.projectId) throw new ToolError("PROJECT_REQUIRED", "请指定 projectId，或在 MCP 连接地址绑定项目");
        if (input.request.renderMode !== "finalize" && input.request.operation === "generate" && (!input.request.aspectRatio || !input.request.resolution || input.request.type === "video" && input.request.duration === undefined)) {
          const model = (await modelsFor(identity, input.request.type)).find(m => m.modelId === publicModelId(input.request.modelId));
          if (!model) throw new ToolError("MODEL_NOT_FOUND", "模型不存在或未获授权", 404);
          input.request.aspectRatio ??= model.defaultAspectRatio || model.aspectRatios?.[0];
          input.request.resolution ??= input.request.renderMode === "draft" ? "480p" : model.defaultResolution || model.defaultQuality || model.resolutions?.[0] || model.qualities?.[0];
          if (input.request.type === "video") input.request.duration ??= model.duration?.default;
        }
        const canonical = generationRequestSchema.safeParse(input.request);
        if (!canonical.success) throw invalidToolArguments(canonical.error);
        input.request = canonical.data;
      }
      let data: Record<string, unknown>;
      switch (toolName) {
        case "fanjin_canvas_run_start":
        case "fanjin_canvas_run_get":
        case "fanjin_canvas_runs_list":
        case "fanjin_canvas_run_control": {
          data = await canvasRuns!.execute(identity, toolName, input); break;
        }
        case "fanjin_human_continue": {
          data = humanContinuation(input.action);
          break;
        }
        case "fanjin_studio_operations": {
          const operations = studioOperations.filter(op => (!input.module || op.module === input.module) && (!input.operation || op.name === input.operation)
            && permits(identity.permissions, op.keyPermission) && permits(identity.memberPermissions, op.memberPermission));
          data = { operations: await Promise.all(operations.map(async op => input.operation || input.module ? describeStudioOperation(op, await studioInputSchema(op)) : { name: op.name, title: op.title, module: op.module, readOnly: op.readOnly })), detailHint: "提供 operation 或 module 查看参数定义" };
          break;
        }
        case "fanjin_studio_execute": {
          const operation = studioOperation(input.operation);
          if (!operation) throw new ToolError("OPERATION_NOT_FOUND", "操作不存在，请查询工作台操作目录", 404);
          if (!permits(identity.permissions, operation.keyPermission) || !permits(identity.memberPermissions, operation.memberPermission)) throw new ToolError("PERMISSION_DENIED", "密钥或成员未获此操作授权", 403);
          // Composite workflow runners select several models internally. A
          // restricted key must not use that path to escape its model list.
          if (operation.execution && identity.modelAllowlist.length) throw new ToolError("WORKFLOW_MODEL_SCOPE_REQUIRED", "组合制作流程需要允许其全部模型的专用密钥；受限密钥请使用逐项报价生成工具", 403);
          // Browser workflows spawn their own jobs and charge the workspace.
          // They do not carry a key's quota reservation through every worker;
          // never allow a capped key to bypass its cap via this adapter.
          if (operation.execution && (!Number.isFinite(identity.keyQuotaLimit) || identity.keyQuotaLimit !== 0)) throw new ToolError("WORKFLOW_KEY_QUOTA_UNSUPPORTED", "组合制作暂不支持密钥级额度上限；请使用逐项报价生成工具，额度仍按原设置执行", 403);
          const parameters = { ...input.parameters };
          const schema = await studioInputSchema(operation);
          if (connection.defaultProjectId && "projectId" in schema.shape && parameters.projectId === undefined) parameters.projectId = connection.defaultProjectId;
          const parsed = schema.safeParse(parameters);
          if (!parsed.success) throw invalidToolArguments(parsed.error);
          data = await studioGateway!(identity, operation, parsed.data);
          break;
        }
        case "fanjin_canvas_execution_plan": {
          if (!input.groupId && !input.nodeIds?.length) throw new ToolError("SELECTION_REQUIRED", "请选择分组或 nodeIds");
          const project = await requireProject(identity, input.projectId);
          const query = db("o_workflow_graph").where({ projectId: project.id });
          if (input.canvasId) query.where({ id: input.canvasId });
          const canvas = await query.orderBy("updateTime", "desc").first();
          if (!canvas) throw new ToolError("CANVAS_NOT_FOUND", "画布不存在", 404);
          const group = input.groupId ? graphList(canvas.groups).find(g => g.id === input.groupId) : null;
          if (input.groupId && !group) throw new ToolError("GROUP_NOT_FOUND", "分组不存在", 404);
          const ids = new Set<string>(input.nodeIds || group!.nodeIds), all = graphList(canvas.nodes), edges = graphList(canvas.edges).map(e => ({ fromNodeId: e.fromNodeId ?? e.source, toNodeId: e.toNodeId ?? e.target }));
          if ([...ids].some(id => !all.some(n => n.id === id))) throw new ToolError("NODE_NOT_FOUND", "部分节点不存在", 404);
          const selected = all.filter(n => ids.has(n.id)).map(n => ({ ...n, ...(n.data || {}), x: coordinate(n.position?.x ?? n.x), y: coordinate(n.position?.y ?? n.y) }));
          const busy = selected.filter(n => n.isGenerating || ["running", "queued", "processing", "submitting"].includes(n.taskStatus));
          const executable = selected.filter(n => ["image", "video"].includes(n.type) && !busy.includes(n) && (n.prompt?.trim() || edges.some(e => e.toNodeId === n.id) || !(n.imageUrl || n.videoUrl || n.referenceAssetUri)));
          const plan = planCanvasGroupExecution(executable as any[], edges);
          data = { canvasId: canvas.id, revision: canvas.revision, orderedNodeIds: plan.orderedNodes.map(n => n.id), cycleNodeIds: plan.cycleNodeIds, busyNodeIds: busy.map(n => n.id), canStart: !plan.cycleNodeIds.length && !busy.length, generationSubmitted: false,
            steps: ["canvas_get(includeContent=true)", "generation_quote", "generation_submit", "task_wait", "canvas_attach", "读取新 revision 后执行下一节点"] };
          break;
        }
        case "fanjin_canvas_viewport_set":
        case "fanjin_canvas_nodes_create":
        case "fanjin_canvas_graph_edit":
        case "fanjin_canvas_nodes_update":
        case "fanjin_canvas_arrange": {
          const resolvedAssets = new Map<string, Record<string, any>>();
          for (const command of input.commands || []) if (command.action === "assets.attach") {
            if (!creationGateway?.prepareCanvasOutput || !creationGateway.validateCanvasAsset || !permits(identity.permissions, "asset:read")) throw new ToolError("PERMISSION_DENIED", "绑定资产需要可用的资产读取权限", 403);
            const asset = await creationGateway.prepareCanvasOutput(identity, { projectId: input.projectId, asset: command });
            resolvedAssets.set(`${command.assetId}:${command.assetVersionId}`, asset);
          }
          data = await db.transaction(async tx => {
            try {
              await requireLiveWorkspaceAuthority({ database: tx, actorUserId: identity.userId, workspaceId: identity.workspaceId,
                authenticatedWorkspaceId: identity.workspaceId, permission: "project:write", additionalMemberUserIds: [identity.userId] });
            } catch (e) {
              if (e instanceof WorkspaceAuthorityError) throw new ToolError(e.code, e.message, e.status);
              throw e;
            }
            // Keep the common user -> workspace -> member -> key lock order.
            await tx("o_api_key").where({ id: identity.keyId }).forUpdate().first();
            const live = await identityFor(connection, tx);
            if (live.userId !== identity.userId || live.workspaceId !== identity.workspaceId || !allowed(live, toolName)) throw new ToolError("PERMISSION_DENIED", "画布写入授权已变化", 403);
            return editCanvas(tx, live, toolName, input, now(), async (assetId, assetVersionId) => {
              if (!permits(live.permissions, "asset:read")) throw new ToolError("PERMISSION_DENIED", "资产读取授权已撤销", 403);
              const asset = resolvedAssets.get(`${assetId}:${assetVersionId}`);
              if (!asset || !creationGateway?.validateCanvasAsset) throw new ToolError("ASSET_NOT_FOUND", "素材未就绪", 404);
              await creationGateway.validateCanvasAsset(live, input.projectId, asset, tx);
              return asset;
            });
          });
          break;
        }
        case "fanjin_analytics_query": {
          const { action, ...filters } = input;
          try { data = await createAnalyticsService(db, now, analyticsAudit).execute({ userId: identity.userId, workspaceId: identity.workspaceId, keyId: identity.keyId }, action, filters); }
          catch (error) { if (error instanceof AnalyticsError) throw new ToolError(error.code, error.message, error.status); throw error; }
          break;
        }
        default:
          if (!creation) throw new ToolError("TOOL_NOT_FOUND", "创作工具尚未配置", 404);
          data = await creation.execute(identity, toolName, input);
          break;
        case "fanjin_context_get": {
          const workspace = await db("o_workspace").where({ id: identity.workspaceId }).first();
          const boundProject = connection.defaultProjectId && allowed(identity, "fanjin_project_get")
            ? projectView(await requireProject(identity, connection.defaultProjectId)) : null;
          if (boundProject && connection.defaultCanvasId && !await db("o_workflow_graph").where({ id: connection.defaultCanvasId, projectId: boundProject.id }).first()) throw new ToolError("CANVAS_NOT_FOUND", "绑定画布不存在或不属于当前项目", 404);
          data = { workspaceId: identity.workspaceId, userId: identity.userId, units: GU_UNITS, tools: Object.keys(toolDefinitions).filter((name) => enabled(name) && allowed(identity, name as ToolName)), readOnly: !creation && !allowed(identity, "fanjin_analytics_query") && !allowed(identity, "fanjin_canvas_nodes_create"),
            workspace: workspace ? { id: workspace.id, name: text(workspace.name) } : null, capabilitiesVersion: "studio-complete-20261101",
            studio: studioGateway ? { discoveryTool: "fanjin_studio_operations", executeTool: "fanjin_studio_execute", availableOperations: studioOperations.filter(op => permits(identity.permissions, op.keyPermission) && permits(identity.memberPermissions, op.memberPermission)).length, refreshHint: "如果客户端缺少这里列出的工具，请重连以刷新 tools/list。" } : null,
            context: { project: boundProject, canvasId: boundProject ? connection.defaultCanvasId ?? null : null, source: "connection", autoSelectProject: false },
            ...(creation ? { workflows: { portraitReferences: managedPortraitWorkflow,
              creation: { steps: ["reuse_or_upload_assets", "quote", "submit_with_authorized_budget", "wait", "use_assets"],
                preferredTools: ["fanjin_canvas_get", "fanjin_canvas_nodes_create", "fanjin_canvas_nodes_update", "fanjin_canvas_arrange", "fanjin_assets_list", "fanjin_generation_quote", "fanjin_generation_submit", "fanjin_task_wait", "fanjin_task_billing", "fanjin_canvas_attach"].filter(n => enabled(n) && allowed(identity, n as ToolName)),
                message: "项目和画布可在连接地址绑定。素材登记由后台处理，已有预算授权可直接提交报价，无需单独批准工具。使用原任务编号等待结果，费用单独查询，不要求用户核账，不换键重投。" } } } : {}) };
          break;
        }
        case "fanjin_projects_list": {
          const scope = JSON.stringify([toolName, identity.workspaceId, identity.keyId, identity.userId]);
          const after = readCursor(input.cursor, scope);
          if (after !== null && (typeof after !== "number" || !Number.isSafeInteger(after))) throw new ToolError("INVALID_CURSOR", "项目游标无效");
          const query = db("o_project").where({ workspaceId: identity.workspaceId, deletionState: "active" });
          if (after !== null) query.where("id", "<", after);
          const rows = await query.select("id", "name", "projectType", "mode", "revision", "createTime", "updatedAt").orderBy("id", "desc").limit(input.limit + 1);
          const selected = rows.slice(0, input.limit);
          data = { workspaceId: identity.workspaceId, projects: selected.map((row) => projectView(row)), nextCursor: rows.length > input.limit ? cursorFor(scope, Number(selected.at(-1)!.id)) : null };
          break;
        }
        case "fanjin_project_get":
          data = { project: projectView(await requireProject(identity, input.projectId), true) };
          break;
        case "fanjin_models_list": {
          const scope = JSON.stringify([toolName, identity.workspaceId, identity.keyId, identity.userId, input.type ?? null, input.available]);
          const after = readCursor(input.cursor, scope);
          const rows = (await modelsFor(identity, input.type)).filter((model) => !input.available || model.canSubmit);
          const index = after === null ? -1 : rows.findIndex((model) => `${model.type}:${model.modelId}` === after);
          if (after !== null && index === -1) throw new ToolError("INVALID_CURSOR", "模型目录已变化，请重新查询");
          const selected = rows.slice(index + 1, index + 1 + input.limit);
          const last = selected.at(-1);
          data = { models: selected, nextCursor: last && index + 1 + input.limit < rows.length ? cursorFor(scope, `${last.type}:${last.modelId}`) : null };
          break;
        }
        case "fanjin_model_get": {
          const rows = (await modelsFor(identity, input.type)).filter((model) => model.modelId === publicModelId(input.modelId));
          if (!rows.length) throw new ToolError("MODEL_NOT_FOUND", "模型不存在或未获授权", 404);
          if (rows.length > 1) throw new ToolError("MODEL_TYPE_REQUIRED", "请同时指定图片或视频类型");
          data = { model: rows[0] };
          break;
        }
        case "fanjin_billing_balance": {
          const account = await db("o_billing_account").where({ workspaceId: identity.workspaceId }).select("balanceMicros", "creditLimitMicros", "reservedMicros", "currency", "status").first();
          if (!account) throw new ToolError("BILLING_ACCOUNT_NOT_FOUND", "工作区尚未建立账本", 404);
          if (account.currency !== "GU") throw new ToolError("BILLING_UNIT_UNSUPPORTED", "账本单位尚未完成核对", 503);
          const balance = ledgerAmount(account.balanceMicros);
          const credit = ledgerAmount(account.creditLimitMicros);
          const frozen = ledgerAmount(account.reservedMicros);
          data = { workspaceId: identity.workspaceId, scope: "workspace_ledger", units: GU_UNITS, status: account.status,
            balance: guAmount(balance), creditLimit: guAmount(credit), frozen: guAmount(frozen), available: guAmount(balance - frozen),
            includesPersonalWallet: false, generationAuthorization: false };
          break;
        }
        case "fanjin_canvas_get": {
          const project = await requireProject(identity, input.projectId);
          const query = db("o_workflow_graph").where({ projectId: project.id });
          if (input.canvasId) query.where({ id: input.canvasId });
          const row = await query.orderBy("updateTime", "desc").orderBy("id", "desc").first();
          if (!row) throw new ToolError("CANVAS_NOT_FOUND", "项目没有已保存的画布", 404);
          const nodes = graphList(row.nodes); const edges = graphList(row.edges);
          data = { canvas: { id: Number(row.id), projectId: Number(project.id), name: text(row.name, 500), summaryOnly: !input.includeContent, revision: Number(row.revision || 1), viewport: (() => { try { const v = typeof row.viewport === "string" ? JSON.parse(row.viewport) : row.viewport; return { x: coordinate(v?.x), y: coordinate(v?.y), zoom: Number(v?.zoom) || 1 }; } catch { return { x: 0, y: 0, zoom: 1 }; } })(),
            nodes: nodes.slice(input.nodeOffset, input.nodeOffset + input.limit).map((node) => {
              const data = node.data && typeof node.data === "object" ? node.data : node;
              return { id: text(node.id), type: text(node.type), label: text(data.label ?? data.title ?? data.name, 500), position: { x: coordinate(node.position?.x ?? node.x), y: coordinate(node.position?.y ?? node.y) },
                assetVersionId: Number.isSafeInteger(Number(data.assetVersionId)) && Number(data.assetVersionId) > 0 ? Number(data.assetVersionId) : null,
                ...(input.includeContent ? { settings: Object.fromEntries(["model", "ratio", "resolution", "quality", "duration", "quantity", "maxImages", "videoGenerateAudio", "videoMode", "videoRenderMode", "width", "height", "textBackgroundColor", "textHeading", "textFontSize", "textBold", "textItalic", "textListStyle", "textDivider", "textExpanded", "composeTimeline", "composeMuted", "videoRedrawDraft", "videoRedrawSourceNodeId"].filter(key => data[key] !== undefined).map(key => [key, data[key]])), prompt: text(data.prompt, 8000), body: text(data.outputText ?? data.body ?? data.textContent, 16000) } : {}) };
            }),
            edges: edges.slice(input.edgeOffset, input.edgeOffset + input.limit * 2).map((edge) => ({ id: text(edge.id), source: text(edge.fromNodeId ?? edge.source), target: text(edge.toNodeId ?? edge.target), fromSide: text(edge.fromSide), toSide: text(edge.toSide) })),
            groups: graphList(row.groups).map(group => ({ id: text(group.id), title: text(group.title), nodeIds: Array.isArray(group.nodeIds) ? group.nodeIds : [], layoutMode: text(group.layoutMode), themeColor: text(group.themeColor) })),
            totalNodes: nodes.length, totalEdges: edges.length, nodesTruncated: nodes.length > input.nodeOffset + input.limit, edgesTruncated: edges.length > input.edgeOffset + input.limit * 2, nextNodeOffset: nodes.length > input.nodeOffset + input.limit ? input.nodeOffset + input.limit : null, nextEdgeOffset: edges.length > input.edgeOffset + input.limit * 2 ? input.edgeOffset + input.limit * 2 : null, updatedAt: Number(row.updateTime || 0) } };
          break;
        }
      }
      const body: ToolResponse = { apiVersion: TOOL_API_VERSION, requestId, ok: true, data };
      assertToolSize(body);
      return { status: 200, body };
    } catch (error) { return toolFailure(error, requestId); }
  }

  return { execute, creation, canvasRuns, async authorize(connection: ToolConnection, name: ToolName) {
    const identity = await identityFor(connection);
    if (!enabled(name) || !allowed(identity, name)) throw new ToolError("PERMISSION_DENIED", "当前身份未获授权", 403);
    return identity;
  }, async discover(connection: ToolConnection) {
    const identity = await identityFor(connection);
    return (Object.keys(toolDefinitions) as ToolName[]).filter((name) => enabled(name) && allowed(identity, name));
  } };
}
export type ToolService = ReturnType<typeof createToolService>;
