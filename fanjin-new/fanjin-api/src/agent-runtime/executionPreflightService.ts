import { Buffer } from "node:buffer";
import type { Knex } from "knex";
import type { AgentApproval, AgentApprovalService } from "@/agent-runtime/approvalService";
import type { DelegationGrantRecord, DelegationGrantService } from "@/agent-runtime/delegationGrantService";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import {
  hashExecutionSpec,
  normalizeExecutionSpec,
  validateExecutionSpecBindings,
  type ExecutionSpec,
  type ExecutionSpecBindingEvidence,
  type ExecutionSpecInputRef,
} from "@/agent-runtime/executionSpec";
import {
  verifyAgentGenerationQuoteForExecution,
  type GenerationQuoteBinding,
  type VerifiedAgentGenerationQuote,
} from "@/agent-runtime/generationQuoteService";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  AssetLibraryError,
  assertProjectAssetReferencePermission,
} from "@/lib/accountWorkspaceAssetLibrary";

type PreflightDatabase = Knex | Knex.Transaction;

export interface ExecutionPreflightInput {
  /** Server-owned workspace identity. Never accept this from model output. */
  workspaceId: string;
  /** Server-owned, already-claimed executor Run identity. */
  executionRunId: string;
  /** Untrusted contract proposed upstream; every binding is reloaded below. */
  spec: unknown;
}

export interface ExecutionPreflightResult {
  checkedAt: number;
  spec: ExecutionSpec;
  specHash: string;
}

export interface ExecutionPreflightQuoteVerifier {
  (input: {
    database: PreflightDatabase;
    quoteId: string;
    workspaceId: string;
    projectId: number;
    runId: string;
    expected: GenerationQuoteBinding;
    now: number;
  }): Promise<VerifiedAgentGenerationQuote>;
}

export interface ExecutionPreflightApprovalReader {
  getInTransaction(
    trx: Knex.Transaction,
    input: { workspaceId: string; projectId: number; approvalId: string },
    now?: number,
  ): Promise<AgentApproval>;
}

export interface ExecutionPreflightGrantReader {
  verifyToolExecutionPreflightInTransaction(
    trx: Knex.Transaction,
    input: {
      grantId: string;
      workspaceId: string;
      projectId: number;
      runId: string;
      actorUserId: number;
      agentRole: "executor";
      toolId: ExecutionSpec["tool"]["id"];
      resourceRefs: Array<{
        type: "scriptIds" | "assetIds" | "assetVersionIds" | "storyboardIds" | "canvasIds";
        id: string;
      }>;
      estimatedMicros: number;
      actualMicros: number;
      idempotencyKey: string;
    },
    now: number,
  ): Promise<DelegationGrantRecord>;
}

export interface ExecutionPreflightServiceOptions {
  database: Knex;
  approvals: Pick<AgentApprovalService, "getInTransaction"> | ExecutionPreflightApprovalReader;
  grants: Pick<DelegationGrantService, "verifyToolExecutionPreflightInTransaction">
    | ExecutionPreflightGrantReader;
  clock?: () => number;
  /** Internal seam for deterministic tests; production defaults to the persisted quote verifier. */
  quoteVerifier?: ExecutionPreflightQuoteVerifier;
}

interface ExecutionRunScope {
  workspaceId: string;
  projectId: number;
  projectRevision: number;
  parentRunId: string;
  executionRunId: string;
  actorUserId: number;
  sessionId: string | undefined;
}

const SAFE_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const MAX_CANVAS_JSON_BYTES = 512 * 1_024;
export const EXECUTION_RESOURCE_VERSION_ALGORITHM = "execution-resource-sha256-v1" as const;

function fail(status: number, code: string, message: string): never {
  throw new AgentRuntimeError(status, code, message);
}

function cleanId(value: unknown, field: string, maxLength = 200): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > maxLength || !SAFE_ID_PATTERN.test(id)) {
    fail(400, "execution_preflight_input_invalid", `${field} 无效`);
  }
  return id;
}

function safeInteger(value: unknown, field: string, minimum = 0, status = 500): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(status, "execution_preflight_evidence_invalid", `${field} 不是有效安全整数`);
  }
  return parsed;
}

function nullableSafeInteger(value: unknown, field: string): number | null {
  if (value == null) return null;
  return safeInteger(value, field);
}

function numericResourceId(value: string, field: string): number {
  if (!/^[1-9]\d{0,15}$/.test(value)) {
    fail(409, "execution_preflight_resource_invalid", `${field} 不是有效持久化资源 ID`);
  }
  return safeInteger(value, field, 1, 409);
}

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function nullableResourceInteger(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  return safeInteger(value, field, 0);
}

function resourceNotFound(ref: ExecutionSpecInputRef): never {
  fail(
    409,
    "execution_preflight_resource_not_found",
    `ExecutionSpec 引用的 ${ref.type} 资源不存在、跨项目或无法验证`,
  );
}

function versionHash(type: ExecutionSpecInputRef["type"], row: Record<string, unknown>): string {
  try {
    return hashIdempotencyRequest({ algorithm: EXECUTION_RESOURCE_VERSION_ALGORITHM, type, record: row });
  } catch {
    fail(500, "execution_preflight_resource_invalid", "权威资源记录无法形成稳定版本");
  }
}

function canonicalCanvasJson(
  value: unknown,
  field: "nodes" | "edges" | "viewport",
): unknown {
  let parsed = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_CANVAS_JSON_BYTES) {
      fail(409, "execution_preflight_resource_invalid", `canvas.${field} 超出版本快照上限`);
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      fail(409, "execution_preflight_resource_invalid", `canvas.${field} 不是有效 JSON`);
    }
  } else {
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch {
      fail(409, "execution_preflight_resource_invalid", `canvas.${field} 无法规范化`);
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_CANVAS_JSON_BYTES) {
      fail(409, "execution_preflight_resource_invalid", `canvas.${field} 超出版本快照上限`);
    }
  }
  const isRecord = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if ((field === "viewport" && !isRecord) || (field !== "viewport" && !Array.isArray(parsed))) {
    fail(409, "execution_preflight_resource_invalid", `canvas.${field} 结构无效`);
  }
  return parsed;
}

async function loadResourceVersion(
  trx: Knex.Transaction,
  workspaceId: string,
  actorUserId: number,
  projectId: number,
  ref: ExecutionSpecInputRef,
): Promise<string> {
  const id = numericResourceId(ref.id, `${ref.type}.id`);
  if (ref.type === "script") {
    const row = await trx("o_script")
      .where({ id, projectId })
      .select("id", "projectId", "name", "content", "extractState", "createTime")
      .first();
    if (!row) resourceNotFound(ref);
    return versionHash(ref.type, {
      id: safeInteger(row.id, "script.id", 1),
      projectId: safeInteger(row.projectId, "script.projectId", 1),
      name: nullableText(row.name),
      content: nullableText(row.content),
      extractState: nullableResourceInteger(row.extractState, "script.extractState"),
      createTime: nullableResourceInteger(row.createTime, "script.createTime"),
    });
  }

  if (ref.type === "asset") {
    try {
      await assertProjectAssetReferencePermission({
        database: trx,
        workspaceId,
        actorUserId,
        projectId,
        assetId: id,
        permission: "use",
      });
    } catch (error) {
      if (error instanceof AssetLibraryError) resourceNotFound(ref);
      throw error;
    }
    const row = await trx("o_assets")
      .where({ id })
      .select(
        "id",
        "projectId",
        "name",
        "prompt",
        "remark",
        "type",
        "describe",
        "scriptId",
        "imageId",
        "assetsId",
        "flowId",
        "startTime",
        "promptState",
      )
      .first();
    if (!row) resourceNotFound(ref);
    return versionHash(ref.type, {
      id: safeInteger(row.id, "asset.id", 1),
      projectId: safeInteger(row.projectId, "asset.projectId", 1),
      name: nullableText(row.name),
      prompt: nullableText(row.prompt),
      remark: nullableText(row.remark),
      type: nullableText(row.type),
      describe: nullableText(row.describe),
      scriptId: nullableResourceInteger(row.scriptId, "asset.scriptId"),
      imageId: nullableResourceInteger(row.imageId, "asset.imageId"),
      assetsId: nullableResourceInteger(row.assetsId, "asset.assetsId"),
      flowId: nullableResourceInteger(row.flowId, "asset.flowId"),
      startTime: nullableResourceInteger(row.startTime, "asset.startTime"),
      promptState: nullableText(row.promptState),
    });
  }

  if (ref.type === "asset_version") {
    const row = await trx("o_image as image")
      .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
      .where({ "image.id": id })
      .select({
        id: "image.id",
        assetId: "image.assetsId",
        projectId: "asset.projectId",
        filePath: "image.filePath",
        type: "image.type",
        model: "image.model",
        resolution: "image.resolution",
        state: "image.state",
      })
      .first();
    if (!row) resourceNotFound(ref);
    try {
      await assertProjectAssetReferencePermission({
        database: trx,
        workspaceId,
        actorUserId,
        projectId,
        assetId: safeInteger(row.assetId, "asset_version.assetId", 1),
        assetVersionId: id,
        permission: "use",
      });
    } catch (error) {
      if (error instanceof AssetLibraryError) resourceNotFound(ref);
      throw error;
    }
    return versionHash(ref.type, {
      id: safeInteger(row.id, "asset_version.id", 1),
      assetId: safeInteger(row.assetId, "asset_version.assetId", 1),
      projectId: safeInteger(row.projectId, "asset_version.projectId", 1),
      filePath: nullableText(row.filePath),
      type: nullableText(row.type),
      model: nullableText(row.model),
      resolution: nullableText(row.resolution),
      state: nullableText(row.state),
    });
  }

  if (ref.type === "storyboard") {
    const row = await trx("o_storyboard")
      .where({ id, projectId })
      .select(
        "id",
        "projectId",
        "scriptId",
        "prompt",
        "filePath",
        "duration",
        "state",
        "trackId",
        "track",
        "videoDesc",
        "shouldGenerateImage",
        "flowId",
        "index",
        "createTime",
      )
      .first();
    if (!row) resourceNotFound(ref);
    return versionHash(ref.type, {
      id: safeInteger(row.id, "storyboard.id", 1),
      projectId: safeInteger(row.projectId, "storyboard.projectId", 1),
      scriptId: nullableResourceInteger(row.scriptId, "storyboard.scriptId"),
      prompt: nullableText(row.prompt),
      filePath: nullableText(row.filePath),
      duration: nullableText(row.duration),
      state: nullableText(row.state),
      trackId: nullableResourceInteger(row.trackId, "storyboard.trackId"),
      track: nullableText(row.track),
      videoDesc: nullableText(row.videoDesc),
      shouldGenerateImage: nullableResourceInteger(row.shouldGenerateImage, "storyboard.shouldGenerateImage"),
      flowId: nullableResourceInteger(row.flowId, "storyboard.flowId"),
      index: nullableResourceInteger(row.index, "storyboard.index"),
      createTime: nullableResourceInteger(row.createTime, "storyboard.createTime"),
    });
  }

  const row = await trx("o_workflow_graph")
    .where({ id, projectId })
    .select("id", "projectId", "episodesId", "name", "nodes", "edges", "viewport", "createTime", "updateTime")
    .first();
  if (!row) resourceNotFound(ref);
  return versionHash(ref.type, {
    id: safeInteger(row.id, "canvas.id", 1),
    projectId: safeInteger(row.projectId, "canvas.projectId", 1),
    episodesId: nullableResourceInteger(row.episodesId, "canvas.episodesId"),
    name: nullableText(row.name),
    nodes: canonicalCanvasJson(row.nodes, "nodes"),
    edges: canonicalCanvasJson(row.edges, "edges"),
    viewport: canonicalCanvasJson(row.viewport, "viewport"),
    createTime: nullableResourceInteger(row.createTime, "canvas.createTime"),
    updateTime: nullableResourceInteger(row.updateTime, "canvas.updateTime"),
  });
}

async function loadRunScope(
  trx: Knex.Transaction,
  workspaceId: string,
  executionRunId: string,
  spec: ExecutionSpec,
): Promise<ExecutionRunScope> {
  const run = await trx("o_agent_run")
    .where({ id: executionRunId, workspaceId })
    .select(
      "id",
      "workspaceId",
      "projectId",
      "threadId",
      "rootRunId",
      "parentRunId",
      "delegationId",
      "agentRole",
      "kind",
      "status",
      "triggerMessageId",
    )
    .first();
  if (!run) fail(404, "execution_preflight_run_not_found", "Executor Run 不存在");
  const projectId = safeInteger(run.projectId, "executionRun.projectId", 1);
  const parentRunId = cleanId(run.parentRunId, "executionRun.parentRunId");
  if (String(run.kind) !== "delegated"
    || String(run.agentRole) !== "executor"
    || String(run.status) !== "running") {
    fail(409, "execution_preflight_run_inactive", "只有 running Executor Delegated Run 可以预检");
  }
  if (String(run.delegationId || "") !== spec.authorization.grant.grantId) {
    fail(409, "execution_preflight_run_scope_invalid", "Executor Run 与 opaque Grant id 不匹配");
  }

  const parent = await trx("o_agent_run")
    .where({ id: parentRunId, workspaceId, projectId })
    .select(
      "id",
      "threadId",
      "rootRunId",
      "parentRunId",
      "delegationId",
      "agentRole",
      "kind",
      "status",
      "triggerMessageId",
    )
    .first();
  if (!parent
    || String(parent.kind) !== "root"
    || String(parent.agentRole) !== "main"
    || parent.parentRunId != null
    || parent.delegationId != null
    || String(parent.rootRunId) !== parentRunId
    || String(run.rootRunId) !== parentRunId
    || String(parent.threadId) !== String(run.threadId)
    || !["running", "waiting_delegation"].includes(String(parent.status))) {
    fail(409, "execution_preflight_run_scope_invalid", "Executor Run 与父 Run 持久化拓扑无效");
  }

  const project = await trx("o_project")
    .where({ id: projectId, workspaceId })
    .select("id", "revision")
    .first();
  if (!project) fail(404, "execution_preflight_project_not_found", "Executor Run 项目不存在");
  const projectRevision = safeInteger(project.revision, "project.revision", 1);
  const [childTrigger, parentTrigger, thread] = await Promise.all([
    trx("o_agent_message")
      .where({
        id: run.triggerMessageId,
        runId: executionRunId,
        threadId: run.threadId,
        workspaceId,
        projectId,
      })
      .select("createdBy")
      .first(),
    trx("o_agent_message")
      .where({
        id: parent.triggerMessageId,
        runId: parentRunId,
        threadId: parent.threadId,
        workspaceId,
        projectId,
      })
      .select("createdBy")
      .first(),
    trx("o_agent_thread")
      .where({ id: run.threadId, workspaceId, projectId, status: "active" })
      .select("sessionId")
      .first(),
  ]);
  const actorUserId = safeInteger(childTrigger?.createdBy, "executionRun.actorUserId", 1);
  if (!parentTrigger || safeInteger(parentTrigger.createdBy, "parentRun.actorUserId", 1) !== actorUserId) {
    fail(409, "execution_preflight_run_scope_invalid", "父子 Run 发起用户不一致");
  }
  if (!thread) fail(409, "execution_preflight_run_scope_invalid", "Executor Thread 不再 active");
  const sessionId = thread.sessionId == null ? undefined : cleanId(thread.sessionId, "thread.sessionId");
  return {
    workspaceId,
    projectId,
    projectRevision,
    parentRunId,
    executionRunId,
    actorUserId,
    sessionId,
  };
}

/**
 * Reload all versions from authoritative project-owned tables. Missing,
 * cross-project and unsupported references fail closed; Spec versions are
 * never used as a fallback.
 */
export async function loadExecutionResourceVersionsInTransaction(
  trx: Knex.Transaction,
  input: {
    workspaceId: string;
    actorUserId: number;
    projectId: number;
    projectRevision: number;
    spec: ExecutionSpec;
  },
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {
    [`project:${input.projectId}`]: String(safeInteger(input.projectRevision, "project.revision", 1)),
  };
  for (const ref of input.spec.inputRefs) {
    versions[`${ref.type}:${ref.id}`] = await loadResourceVersion(
      trx,
      input.workspaceId,
      input.actorUserId,
      input.projectId,
      ref,
    );
  }
  return versions;
}

function assertQuoteNumbers(quote: VerifiedAgentGenerationQuote): void {
  safeInteger(quote.quote.units, "quote.units", 1);
  safeInteger(quote.quote.estimatedCostMicros, "quote.estimatedCostMicros");
  safeInteger(quote.quote.maximumCostMicros, "quote.maximumCostMicros");
  safeInteger(quote.quote.expiresAt, "quote.expiresAt");
  safeInteger(quote.approvalQuote.estimatedCostMicros, "quote.approval.estimatedCostMicros");
  safeInteger(quote.approvalQuote.maximumCostMicros, "quote.approval.maximumCostMicros");
  safeInteger(quote.approvalQuote.expiresAt, "quote.approval.expiresAt");
}

function assertApprovalNumbers(approval: AgentApproval): void {
  safeInteger(approval.projectId, "approval.projectId", 1);
  safeInteger(approval.requestedBy, "approval.requestedBy", 1);
  nullableSafeInteger(approval.decidedBy, "approval.decidedBy");
  nullableSafeInteger(approval.decidedAt, "approval.decidedAt");
  safeInteger(approval.expiresAt, "approval.expiresAt");
  nullableSafeInteger(approval.consumedAt, "approval.consumedAt");
  nullableSafeInteger(approval.revokedAt, "approval.revokedAt");
  nullableSafeInteger(approval.revokedBy, "approval.revokedBy");
  safeInteger(approval.revision, "approval.revision", 1);
  safeInteger(approval.createdAt, "approval.createdAt");
  safeInteger(approval.updatedAt, "approval.updatedAt");
}

function assertGrantNumbers(grant: DelegationGrantRecord): void {
  safeInteger(grant.actorUserId, "grant.actorUserId", 1);
  safeInteger(grant.issuedAt, "grant.issuedAt");
  safeInteger(grant.expiresAt, "grant.expiresAt");
  nullableSafeInteger(grant.revokedAt, "grant.revokedAt");
  nullableSafeInteger(grant.revokedBy, "grant.revokedBy");
  safeInteger(grant.limits.maxToolCalls, "grant.limits.maxToolCalls", 1);
  if (grant.limits.maxOutputCount !== undefined) {
    safeInteger(grant.limits.maxOutputCount, "grant.limits.maxOutputCount", 1);
  }
  if (grant.limits.maxDurationSeconds !== undefined) {
    safeInteger(grant.limits.maxDurationSeconds, "grant.limits.maxDurationSeconds", 1);
  }
  safeInteger(grant.spend.maxEstimatedMicros, "grant.spend.maxEstimatedMicros");
  safeInteger(grant.spend.maxActualMicros, "grant.spend.maxActualMicros");
  safeInteger(grant.consumedToolCalls, "grant.consumedToolCalls");
  safeInteger(grant.consumedEstimatedMicros, "grant.consumedEstimatedMicros");
  safeInteger(grant.consumedActualMicros, "grant.consumedActualMicros");
  safeInteger(grant.revision, "grant.revision", 1);
  safeInteger(grant.updatedAt, "grant.updatedAt");
}

function grantResourceRefs(spec: ExecutionSpec): Array<{
  type: "scriptIds" | "assetIds" | "assetVersionIds" | "storyboardIds" | "canvasIds";
  id: string;
}> {
  const types = {
    script: "scriptIds",
    asset: "assetIds",
    asset_version: "assetVersionIds",
    storyboard: "storyboardIds",
    canvas: "canvasIds",
  } as const;
  return spec.inputRefs.map((ref) => ({ type: types[ref.type], id: ref.id }));
}

async function assertGrantTopology(
  trx: Knex.Transaction,
  scope: ExecutionRunScope,
  approval: AgentApproval,
  grant: DelegationGrantRecord,
): Promise<void> {
  if (grant.actorUserId !== scope.actorUserId
    || approval.requestedBy !== scope.actorUserId
    || grant.issuerRole !== "main"
    || grant.canDelegate !== false
    || grant.sessionId !== scope.sessionId) {
    fail(409, "execution_preflight_grant_scope_invalid", "Grant actor、issuer 或 session 绑定无效");
  }
  const parentStep = await trx("o_agent_step")
    .where({
      id: grant.parentStepId,
      runId: scope.parentRunId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "delegation",
    })
    .select("status")
    .first();
  if (!parentStep || !["running", "waiting_external"].includes(String(parentStep.status))) {
    fail(409, "execution_preflight_grant_scope_invalid", "Grant 父 Delegation Step 无效");
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * Admission-only A4 executor preflight.
 *
 * It performs no provider call, reservation, submit, Tool registration,
 * Approval/Grant consumption or dispatch. The returned value is not an
 * execution capability. A future Controller must repeat these reads through
 * the locked prepare APIs and atomically consume authorization immediately
 * before the real side effect.
 */
export class ExecutionPreflightService {
  private readonly clock: () => number;
  private readonly quoteVerifier: ExecutionPreflightQuoteVerifier;

  constructor(private readonly options: ExecutionPreflightServiceOptions) {
    this.clock = options.clock ?? Date.now;
    this.quoteVerifier = options.quoteVerifier ?? verifyAgentGenerationQuoteForExecution;
  }

  async preflight(input: ExecutionPreflightInput): Promise<ExecutionPreflightResult> {
    return this.options.database.transaction((trx) => this.preflightInTransaction(trx, input));
  }

  async preflightInTransaction(
    trx: Knex.Transaction,
    input: ExecutionPreflightInput,
  ): Promise<ExecutionPreflightResult> {
    const now = safeInteger(this.clock(), "now");
    const workspaceId = cleanId(input.workspaceId, "workspaceId");
    const executionRunId = cleanId(input.executionRunId, "executionRunId");
    const proposed = normalizeExecutionSpec(input.spec);
    const scope = await loadRunScope(trx, workspaceId, executionRunId, proposed);
    const resourceVersions = await loadExecutionResourceVersionsInTransaction(trx, {
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      projectId: scope.projectId,
      projectRevision: scope.projectRevision,
      spec: proposed,
    });

    const quote = await this.quoteVerifier({
      database: trx,
      quoteId: proposed.authorization.quote.quoteId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      runId: scope.parentRunId,
      expected: {
        generationType: proposed.intent.generationType,
        provider: proposed.intent.provider,
        model: proposed.intent.model,
        units: proposed.intent.units,
      },
      now,
    });
    const approval = await this.options.approvals.getInTransaction(trx, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      approvalId: proposed.authorization.approval.approvalId,
    }, now);
    const grant = await this.options.grants.verifyToolExecutionPreflightInTransaction(trx, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      grantId: proposed.authorization.grant.grantId,
      runId: scope.executionRunId,
      actorUserId: scope.actorUserId,
      agentRole: "executor",
      toolId: proposed.tool.id,
      resourceRefs: grantResourceRefs(proposed),
      estimatedMicros: proposed.budget.maxEstimatedMicros,
      actualMicros: proposed.budget.maxActualMicros,
      idempotencyKey: proposed.idempotencyKey,
    }, now);

    assertQuoteNumbers(quote);
    assertApprovalNumbers(approval);
    assertGrantNumbers(grant);
    await assertGrantTopology(trx, scope, approval, grant);
    const evidence: ExecutionSpecBindingEvidence = {
      now,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      projectRevision: scope.projectRevision,
      resourceVersions,
      parentRunId: scope.parentRunId,
      executionRunId: scope.executionRunId,
      quote,
      approval,
      grant,
    };
    const canonicalSpec = normalizeExecutionSpec(validateExecutionSpecBindings(proposed, evidence));
    const specHash = hashExecutionSpec(canonicalSpec);
    const spec = deepFreeze(canonicalSpec);
    return Object.freeze({ checkedAt: now, spec, specHash });
  }
}
