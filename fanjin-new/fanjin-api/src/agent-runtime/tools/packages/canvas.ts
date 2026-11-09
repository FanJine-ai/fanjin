import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  CanvasCommandContractError,
  assembleCanvasCommandSetFromModelInput,
  canvasCommandsApplyModelInputSchema,
  type CanvasCommandSet,
} from "@/agent-runtime/canvasCommandContracts";
import {
  CanvasCommandService,
  canvasCommandApplyResultSchema,
  computeCanvasCommandVersion,
} from "@/agent-runtime/canvasCommandService";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  defineAgentTool,
  type AgentToolAuthorizationContext,
  type AgentToolAuthorizationEvidence,
} from "@/agent-runtime/tools/registry";
import { CANVAS_COMMAND_MUTATION_TABLE } from "@/lib/migrations/canvasCommandMutation";

const MAX_GRAPH_JSON_BYTES = 512 * 1_024;
const MAX_RAW_NODES = 5_000;
const MAX_RAW_EDGES = 10_000;
const MAX_NODES = 500;
const MAX_EDGES = 1_000;
const MAX_NODE_TEXT = 4_000;

const canvasIdSchema = z.string().trim().regex(/^[1-9]\d{0,14}$/);

export const canvasGetInputSchema = z.object({
  canvasId: canvasIdSchema.nullable().default(null),
}).strict();

const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

const canvasNodeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().max(100).nullable(),
  title: z.string().max(MAX_NODE_TEXT).nullable(),
  subtitle: z.string().max(MAX_NODE_TEXT).nullable(),
  body: z.string().max(MAX_NODE_TEXT).nullable(),
  position: pointSchema.nullable(),
}).strict();

const canvasEdgeSchema = z.object({
  id: z.string().min(1).max(200),
  sourceNodeId: z.string().min(1).max(200),
  targetNodeId: z.string().min(1).max(200),
}).strict();

const viewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().positive(),
}).strict();

export const canvasGetOutputSchema = z.object({
  id: canvasIdSchema,
  name: z.string().max(500).nullable(),
  episodeId: z.number().int().positive().nullable(),
  nodes: z.array(canvasNodeSchema).max(MAX_NODES),
  edges: z.array(canvasEdgeSchema).max(MAX_EDGES),
  viewport: viewportSchema,
  totalNodes: z.number().int().nonnegative(),
  totalEdges: z.number().int().nonnegative(),
  nodesTruncated: z.boolean(),
  edgesTruncated: z.boolean(),
  updatedAt: z.number().int().nonnegative().nullable(),
}).strict();

type CanvasGetInput = z.infer<typeof canvasGetInputSchema>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, maxLength: number): string | null {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, maxLength);
  return text || null;
}

function safeIdentifier(value: unknown): string | null {
  const id = safeText(value, 200)?.trim() ?? "";
  return id ? id : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nullableTimestamp(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseGraphArray(value: unknown, field: "nodes" | "edges"): unknown[] {
  let parsed: unknown;
  let text: string;
  if (Array.isArray(value)) {
    try {
      text = JSON.stringify(value);
      parsed = value;
    } catch {
      throw new AgentToolGatewayError("canvas_snapshot_invalid", `画布 ${field} 快照无效`, { status: 409 });
    }
  } else {
    text = value == null ? "[]" : String(value);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_GRAPH_JSON_BYTES) {
    throw new AgentToolGatewayError("canvas_snapshot_too_large", `画布 ${field} 快照过大，已拒绝直接读取`, { status: 409 });
  }
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgentToolGatewayError("canvas_snapshot_invalid", `画布 ${field} 快照无效`, { status: 409 });
    }
  }
  if (!Array.isArray(parsed)) {
    throw new AgentToolGatewayError("canvas_snapshot_invalid", `画布 ${field} 快照无效`, { status: 409 });
  }
  const maxItems = field === "nodes" ? MAX_RAW_NODES : MAX_RAW_EDGES;
  if (parsed.length > maxItems) {
    throw new AgentToolGatewayError("canvas_snapshot_too_large", `画布 ${field} 项目过多，已拒绝直接读取`, { status: 409 });
  }
  return parsed;
}

function mapNode(value: unknown) {
  const node = record(value);
  if (!node) return null;
  const data = record(node.data);
  const id = safeIdentifier(node.id);
  if (!id) return null;
  const position = record(node.position);
  const x = finiteNumber(position?.x ?? node.x);
  const y = finiteNumber(position?.y ?? node.y);
  return {
    id,
    type: safeText(node.type ?? data?.kind ?? data?.type, 100),
    title: safeText(node.title ?? data?.title ?? data?.label, MAX_NODE_TEXT),
    subtitle: safeText(node.subtitle ?? data?.subtitle, MAX_NODE_TEXT),
    body: safeText(node.body ?? node.content ?? node.script ?? data?.body ?? data?.content ?? data?.script, MAX_NODE_TEXT),
    position: x == null || y == null ? null : { x, y },
  };
}

function mapEdge(value: unknown, index: number) {
  const edge = record(value);
  if (!edge) return null;
  const sourceNodeId = safeIdentifier(edge.source ?? edge.fromNodeId);
  const targetNodeId = safeIdentifier(edge.target ?? edge.toNodeId);
  if (!sourceNodeId || !targetNodeId) return null;
  return {
    id: safeIdentifier(edge.id) ?? `edge-${index + 1}`,
    sourceNodeId,
    targetNodeId,
  };
}

function parseViewport(value: unknown) {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 16 * 1_024) {
      throw new AgentToolGatewayError("canvas_snapshot_invalid", "画布 viewport 快照无效", { status: 409 });
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AgentToolGatewayError("canvas_snapshot_invalid", "画布 viewport 快照无效", { status: 409 });
    }
  }
  if (parsed == null || parsed === "") return { x: 0, y: 0, zoom: 1 };
  const viewport = record(parsed);
  if (!viewport) {
    throw new AgentToolGatewayError("canvas_snapshot_invalid", "画布 viewport 快照无效", { status: 409 });
  }
  const x = finiteNumber(viewport?.x) ?? 0;
  const y = finiteNumber(viewport?.y) ?? 0;
  const zoom = finiteNumber(viewport?.zoom);
  return { x, y, zoom: zoom != null && zoom > 0 ? zoom : 1 };
}

async function deriveBoundCanvasId(context: AgentToolAuthorizationContext): Promise<string> {
  const thread = await context.database("o_agent_thread")
    .where({
      id: context.threadId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      status: "active",
    })
    .select("sessionId")
    .first();
  const sessionId = safeIdentifier(thread?.sessionId);
  if (!sessionId) {
    throw new AgentToolGatewayError("canvas_not_bound", "当前 Thread 未绑定可读取的画布", { status: 404 });
  }
  const session = await context.database("o_creation_session")
    .where({
      id: sessionId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      status: "active",
    })
    .whereNull("archivedAt")
    .select("canvasId")
    .first();
  const canvasId = safeIdentifier(session?.canvasId);
  const parsedCanvasId = canvasIdSchema.safeParse(canvasId);
  if (!parsedCanvasId.success) {
    throw new AgentToolGatewayError("canvas_not_bound", "当前创作会话未绑定可读取的持久化画布", { status: 404 });
  }
  return parsedCanvasId.data;
}

async function loadCanvasRow(input: CanvasGetInput, context: AgentToolAuthorizationContext) {
  const canvasId = input.canvasId ?? await deriveBoundCanvasId(context);
  const row = await context.database("o_workflow_graph")
    .where({ id: Number(canvasId), projectId: context.projectId })
    .select("id", "episodesId", "name", "nodes", "edges", "viewport", "updateTime")
    .first();
  if (!row) {
    throw new AgentToolGatewayError("canvas_not_found", "画布不存在或不属于当前项目", { status: 404 });
  }
  return row;
}

async function loadCanvas(input: CanvasGetInput, context: AgentToolAuthorizationContext) {
  const row = await loadCanvasRow(input, context);
  const rawNodes = parseGraphArray(row.nodes, "nodes");
  const rawEdges = parseGraphArray(row.edges, "edges");
  const mappedNodes = rawNodes.map(mapNode);
  const mappedEdges = rawEdges.map(mapEdge);
  if (mappedNodes.some((item) => item === null) || mappedEdges.some((item) => item === null)) {
    throw new AgentToolGatewayError("canvas_snapshot_invalid", "画布包含无法安全识别的节点或连线", { status: 409 });
  }
  const nodes = mappedNodes as Array<NonNullable<(typeof mappedNodes)[number]>>;
  const edges = mappedEdges as Array<NonNullable<(typeof mappedEdges)[number]>>;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  if (nodeIds.size !== nodes.length || edgeIds.size !== edges.length) {
    throw new AgentToolGatewayError("canvas_snapshot_invalid", "画布包含重复节点或连线 ID", { status: 409 });
  }
  if (edges.some((edge) => !nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId))) {
    throw new AgentToolGatewayError("canvas_snapshot_invalid", "画布连线引用了不存在的节点", { status: 409 });
  }
  const visibleNodes = nodes.slice(0, MAX_NODES);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = edges
    .filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))
    .slice(0, MAX_EDGES);
  const id = canvasIdSchema.safeParse(String(row.id));
  if (!id.success) {
    throw new AgentToolGatewayError("canvas_snapshot_invalid", "画布记录 ID 无效", { status: 409 });
  }
  return {
    id: id.data,
    name: safeText(row.name, 500),
    episodeId: nullablePositiveInteger(row.episodesId),
    nodes: visibleNodes,
    edges: visibleEdges,
    viewport: parseViewport(row.viewport),
    totalNodes: nodes.length,
    totalEdges: edges.length,
    nodesTruncated: nodes.length > visibleNodes.length,
    edgesTruncated: edges.length > visibleEdges.length,
    updatedAt: nullableTimestamp(row.updateTime),
  };
}

export const CANVAS_GET_TOOL = defineAgentTool({
  manifest: {
    name: "canvas.get",
    version: "1.0.0",
    displayName: "读取项目画布",
    description: "读取当前项目持久化画布的节点、连线和视口安全摘要，不返回媒体 URL、签名或供应商字段。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["canvas"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: canvasGetInputSchema,
  outputSchema: canvasGetOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const result = await loadCanvas(input, context);
    return {
      resourceRefs: [{ type: "canvasIds", id: result.id }],
      resourceVersions: { [`canvas:${result.id}`]: hashIdempotencyRequest(result) },
    };
  },
  execute: loadCanvas,
});

function positiveSafeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

async function loadCanvasCommandVersionRow(canvasId: string, context: AgentToolAuthorizationContext) {
  const row = await context.database("o_workflow_graph")
    .where({ id: Number(canvasId), projectId: context.projectId })
    .select(
      "id",
      "projectId",
      "episodesId",
      "name",
      "nodes",
      "edges",
      "viewport",
      "createTime",
      "updateTime",
      "revision",
    )
    .first();
  if (!row) {
    throw new AgentToolGatewayError("canvas_not_found", "画布不存在或不属于当前项目", { status: 404 });
  }
  return row;
}

function canvasCommandResourceVersions(canvasId: string, revision: number, version: string) {
  return {
    [`canvas:${canvasId}`]: String(revision),
    [`canvas_version:${canvasId}`]: version,
  };
}

/**
 * Evidence for the R1 canvas write. The input is the server-assembled V1
 * command set (projectId derived from this context, so the scope check below
 * is defense-in-depth; cross-project canvases fail closed at the scoped row
 * load). A first execution binds the current server-owned canvas
 * revision/version; an idempotent replay of an already-applied command set
 * re-binds the journal's base revision/version so the Gateway evidence digest
 * matches the original execution, and fails closed when the canvas moved
 * after the recorded apply.
 */
async function resolveCanvasCommandsApplyEvidence(
  input: CanvasCommandSet,
  context: AgentToolAuthorizationContext,
): Promise<AgentToolAuthorizationEvidence> {
  if (input.projectId !== context.projectId) {
    throw new AgentToolGatewayError(
      "canvas_command_scope_mismatch",
      "画布命令集项目与当前 Run 项目不一致",
      { status: 403 },
    );
  }
  const existing = await context.database(CANVAS_COMMAND_MUTATION_TABLE)
    .where({
      workspaceId: context.workspaceId,
      projectId: input.projectId,
      canvasId: Number(input.canvasId),
      idempotencyKey: input.idempotencyKey,
    })
    .select("baseRevision", "baseVersion", "newRevision", "newVersion")
    .first();

  if (existing) {
    const baseRevision = positiveSafeInteger(existing.baseRevision);
    const newRevision = positiveSafeInteger(existing.newRevision);
    const baseVersion = String(existing.baseVersion || "");
    const newVersion = String(existing.newVersion || "");
    const row = await loadCanvasCommandVersionRow(input.canvasId, context);
    const currentRevision = positiveSafeInteger(row.revision);
    if (baseRevision === null
      || newRevision === null
      || currentRevision === null
      || currentRevision !== newRevision
      || computeCanvasCommandVersion(row) !== newVersion) {
      throw new AgentToolGatewayError(
        "tool_replay_scope_changed",
        "画布在命令应用后已发生变化，旧结果不能重放",
        { status: 409 },
      );
    }
    return {
      resourceRefs: [{ type: "canvasIds", id: input.canvasId }],
      resourceVersions: canvasCommandResourceVersions(input.canvasId, baseRevision, baseVersion),
    };
  }

  const row = await loadCanvasCommandVersionRow(input.canvasId, context);
  const revision = positiveSafeInteger(row.revision);
  if (revision === null) {
    throw new AgentToolGatewayError("canvas_snapshot_invalid", "画布 revision 无效", { status: 409 });
  }
  return {
    resourceRefs: [{ type: "canvasIds", id: input.canvasId }],
    resourceVersions: canvasCommandResourceVersions(
      input.canvasId,
      revision,
      computeCanvasCommandVersion(row),
    ),
  };
}

/**
 * Model-facing boundary for the R1 canvas write. The flat model input is
 * re-validated at the tool boundary, assembled back into the untrusted V1
 * contract (projectId from the server-owned context, idempotency key
 * generated by the server) and only then handed to evidence resolution and
 * execution, so canvasCommandSetSchema remains the single executable
 * contract with unchanged defenses.
 */
function assembleCanvasCommandsApplyInput(
  input: unknown,
  context: AgentToolAuthorizationContext,
): CanvasCommandSet {
  const modelInput = canvasCommandsApplyModelInputSchema.safeParse(input);
  if (!modelInput.success) {
    throw new AgentToolGatewayError("invalid_tool_arguments", "工具参数不符合服务端 Schema", { status: 400 });
  }
  try {
    return assembleCanvasCommandSetFromModelInput(modelInput.data, { projectId: context.projectId });
  } catch (error) {
    if (error instanceof CanvasCommandContractError) {
      const status = error.code === "canvas_command_invalid" || error.code === "canvas_command_batch_limit"
        ? 400
        : 409;
      throw new AgentToolGatewayError(error.code, error.message, { status });
    }
    throw error;
  }
}

export const CANVAS_COMMANDS_APPLY_TOOL = defineAgentTool({
  manifest: {
    name: "canvas.commands.apply",
    version: "1.0.0",
    displayName: "应用画布结构化命令",
    description: "以 revision 乐观锁和幂等键把画布结构化命令（node.create/node.update/edge.create/edge.update/viewport.update）原子应用到当前项目画布，返回新的画布 revision 与版本。调用前必须先用 canvas.get 读取画布当前状态，把返回的 revision 与版本原样作为 expectedCanvasRevision/expectedCanvasVersion 提交。每条命令是扁平对象：op、commandId 和该 op 相关字段，其余字段必须为 null——node.create 需要 nodeId/nodeType/title/position（subtitle/body 可空）；node.update 需要 nodeId 且 title/subtitle/body/position 至少一个非 null；edge.create 需要 edgeId/sourceNodeId/targetNodeId（label 可空）；edge.update 需要 edgeId 且 sourceNodeId/targetNodeId/label 至少一个非 null；viewport.update 需要 viewport。projectId 与幂等键由服务端派生，不得提供。负例：缺少或伪造 revision/version 绑定、重复 commandId、更新不存在的节点或连线、构造悬空边、文本携带 URL 或凭据、整图覆盖写、超出批量上限。",
    riskClass: "R1",
    availability: { state: "available", sincePhase: "A5" },
    requiredPermissions: ["project:write"],
    resourceTypes: ["canvas", "canvas_command_mutation"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: canvasCommandsApplyModelInputSchema,
  outputSchema: canvasCommandApplyResultSchema,
  resolveAuthorizationEvidence(input, context) {
    return resolveCanvasCommandsApplyEvidence(assembleCanvasCommandsApplyInput(input, context), context);
  },
  async execute(input, context) {
    const commandSet = assembleCanvasCommandsApplyInput(input, context);
    const service = new CanvasCommandService(context.database);
    // A savepoint keeps the Canvas row update and the append-only journal
    // atomic while still letting the outer Gateway transaction persist a
    // redacted failed Step when the command set is rejected.
    return context.database.transaction((trx) => service.applyInTransaction(trx, {
      workspaceId: context.workspaceId,
      actorUserId: context.actorUserId,
      commandSet,
    }));
  },
});
