import type { Knex } from "knex";
import {
  AGENT_TASK_STATUSES,
  type A4DelegatedAgentRole,
  type AgentTask,
  type AgentTaskResult,
} from "@/agent-runtime/delegationContracts";
import {
  type DelegationGrantRecord,
  type DelegationGrantService,
} from "@/agent-runtime/delegationGrantService";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { appendAgentEvent, type AppendAgentEventInput } from "@/agent-runtime/eventStore";
import { canonicalizeIdempotencyRequest, hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  AGENT_MAIN_PROMPT_KEY,
  resolveAgentRuntimeConfigSnapshot,
} from "@/agent-runtime/runtimeConfigRegistry";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import {
  agentDelegateWaitingOutputSchema,
  getAgentDelegateContractForPromptVersion,
  type AgentDelegateContract,
} from "@/agent-runtime/tools/packages/delegation";
import type { AgentRun } from "@/agent-runtime/types";
import { AGENT_DELEGATION_TABLE } from "@/lib/migrations/agentApprovalDelegation";

const CANCELLED_ERROR = Object.freeze({
  code: "run_cancelled",
  message: "Agent 运行已取消",
});
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const CHILD_RUN_STATUSES = new Set([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);
const SAFE_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type EventAppender = (
  trx: Knex.Transaction,
  input: AppendAgentEventInput,
) => Promise<string>;

interface RawRun extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  rootRunId: string;
  parentRunId: string | null;
  delegationId: string | null;
  kind: string;
  agentRole: string;
  triggerMessageId: string;
  responseMessageId: string | null;
  status: string;
  waitType: string | null;
  waitRef: string | null;
  wakeAt: number | string | null;
  policySnapshot: unknown;
  leaseOwner: string | null;
  leaseExpiresAt: number | string | null;
  heartbeatAt: number | string | null;
  checkpointStepSeq: number | string;
  sideEffectsCommitted: number | string | boolean;
  cancelRequestedAt: number | string | null;
  cancelRequestedBy: number | string | null;
  cancelReason: string | null;
  version: number | string;
  startedAt: number | string | null;
  completedAt: number | string | null;
}

interface RawDelegation extends Record<string, unknown> {
  id: string;
  status: string;
  workspaceId: string;
  projectId: number | string;
  parentRunId: string;
  parentStepId: string;
  boundRunId: string | null;
  granteeRole: string;
  taskVersion: number | string | null;
  taskJson: unknown;
  taskHash: string | null;
  writeTargets: unknown;
  taskStatus: string | null;
  resultJson: unknown;
  resultHash: string | null;
  resultMessageId: string | null;
  startedAt: number | string | null;
  completedAt: number | string | null;
  safeError: unknown;
}

interface PreparedChild {
  run: RawRun;
  delegation: RawDelegation;
  grant: DelegationGrantRecord;
  task: AgentTask;
  role: A4DelegatedAgentRole;
  taskHash: string;
  modelProfile: string;
  action: "cancel_queued" | "request_cancel" | "none";
}

interface PendingEvent extends Omit<AppendAgentEventInput, "seq" | "createdAt"> {}

export interface CancelDelegationRootInput {
  workspaceId: string;
  rootRunId: string;
  requestedBy: number;
  reason?: string | null;
  now?: number;
}

export interface DelegationCancellationResult {
  run: AgentRun;
  replayed: boolean;
}

export interface DelegationCancellationServiceOptions {
  grantService: DelegationGrantService;
  clock?: () => number;
  eventAppender?: EventAppender;
}

function fail(code: string, message: string, status = 409): never {
  throw new AgentRuntimeError(status, code, message);
}

function safeInteger(value: unknown, field: string, min = 0): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min) {
    fail("delegation_cancel_record_invalid", `${field} 不是安全整数`, 500);
  }
  return result;
}

function cleanId(value: unknown, field: string): string {
  if (typeof value !== "string") fail("delegation_cancel_binding_invalid", `${field} 格式无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !SAFE_ID_PATTERN.test(normalized)) {
    fail("delegation_cancel_binding_invalid", `${field} 格式无效`);
  }
  return normalized;
}

function cleanReason(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return Number(value || 0);
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    fail("delegation_cancel_record_invalid", `${field} 无法解析`, 500);
  }
}

function optionalNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function mapRun(row: RawRun): AgentRun {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    threadId: String(row.threadId),
    rootRunId: String(row.rootRunId),
    parentRunId: row.parentRunId == null ? null : String(row.parentRunId),
    delegationId: row.delegationId == null ? null : String(row.delegationId),
    blockedByRunId: row.blockedByRunId == null ? null : String(row.blockedByRunId),
    kind: String(row.kind) as AgentRun["kind"],
    agentRole: String(row.agentRole) as AgentRun["agentRole"],
    triggerMessageId: String(row.triggerMessageId),
    responseMessageId: row.responseMessageId == null ? null : String(row.responseMessageId),
    status: String(row.status) as AgentRun["status"],
    waitType: row.waitType == null ? null : String(row.waitType),
    waitRef: row.waitRef == null ? null : String(row.waitRef),
    wakeAt: optionalNumber(row.wakeAt),
    policySnapshot: parseJson(row.policySnapshot, "run.policySnapshot") as Record<string, unknown>,
    contextVersion: Number(row.contextVersion || 0),
    spendLimitMicros: Number(row.spendLimitMicros || 0),
    actualSpendMicros: Number(row.actualSpendMicros || 0),
    leaseOwner: row.leaseOwner == null ? null : String(row.leaseOwner),
    leaseExpiresAt: optionalNumber(row.leaseExpiresAt),
    heartbeatAt: optionalNumber(row.heartbeatAt),
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.maxAttempts || 0),
    recoveryCount: Number(row.recoveryCount || 0),
    checkpointStepSeq: Number(row.checkpointStepSeq || 0),
    sideEffectsCommitted: Boolean(Number(row.sideEffectsCommitted || 0)),
    cancelRequestedAt: optionalNumber(row.cancelRequestedAt),
    cancelRequestedBy: optionalNumber(row.cancelRequestedBy),
    cancelReason: row.cancelReason == null ? null : String(row.cancelReason),
    error: row.error == null
      ? null
      : parseJson(row.error, "run.error") as Record<string, unknown>,
    version: Number(row.version || 0),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    startedAt: optionalNumber(row.startedAt),
    completedAt: optionalNumber(row.completedAt),
  };
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return canonicalizeIdempotencyRequest(left) === canonicalizeIdempotencyRequest(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function resolveRootDelegationContract(root: RawRun): AgentDelegateContract {
  const policy = parseJson(root.policySnapshot, "root.policySnapshot");
  if (!isRecord(policy)
    || !hasExactKeys(policy, [
      "agentConfig",
      "delegation",
      "delegationEnabled",
      "modelAlias",
      "modelEnabled",
      "phase",
      "toolsEnabled",
    ])
    || policy.modelEnabled !== true
    || policy.toolsEnabled !== true
    || policy.delegationEnabled !== true
    || policy.phase !== "A4-delegation") {
    fail("delegation_cancel_parent_contract_invalid", "Root Run 委派契约快照无效");
  }

  let resolved: ReturnType<typeof resolveAgentRuntimeConfigSnapshot>;
  try {
    resolved = resolveAgentRuntimeConfigSnapshot(policy.agentConfig, "main");
  } catch {
    fail("delegation_cancel_parent_contract_invalid", "Root Run 委派配置快照无效");
  }
  const contract = resolved.prompt.key === AGENT_MAIN_PROMPT_KEY
    ? getAgentDelegateContractForPromptVersion(resolved.prompt.version)
    : null;
  if (!contract
    || !resolved.execution.enabled
    || policy.modelAlias !== resolved.execution.modelAlias
    || !resolved.modelProfile.capabilities.includes("tools")) {
    fail("delegation_cancel_parent_contract_invalid", "Root Run Prompt 不支持委派取消");
  }
  if (!equalCanonical(policy.delegation, contract.parentPolicySnapshot)) {
    fail("delegation_cancel_parent_contract_invalid", "Root Run 委派契约快照无效");
  }
  return contract;
}

function modelVisibleTask(task: AgentTask): Record<string, unknown> {
  return {
    role: task.role,
    taskType: task.taskType,
    objective: task.objective,
    inputRefs: task.inputRefs,
    constraints: task.constraints,
    expectedArtifacts: task.expectedArtifacts,
    qualityCriteria: task.qualityCriteria,
  };
}

function assertTaskMatchesParentContract(
  task: AgentTask,
  contract: AgentDelegateContract,
): readonly string[] {
  if (!(contract.roles as readonly string[]).includes(task.role)
    || !contract.inputSchema.safeParse({ tasks: [modelVisibleTask(task)] }).success) {
    fail("delegation_cancel_parent_contract_invalid", "AgentTask 超出父 Run 委派契约");
  }
  return contract.getR0ToolIds(task.role);
}

function assertParentModelCheckpointContract(
  checkpoint: Record<string, unknown>,
  contract: AgentDelegateContract,
): void {
  const call = Array.isArray(checkpoint.calls) && checkpoint.calls.length === 1
    ? checkpoint.calls[0]
    : null;
  if (!isRecord(call)
    || call.name !== "agent.delegate"
    || !contract.inputSchema.safeParse(call.arguments).success) {
    fail("delegation_cancel_parent_contract_invalid", "父模型委派检查点超出 Prompt 契约");
  }
}

function deriveResourceScope(task: AgentTask): Record<string, readonly string[]> {
  const mapping = {
    script: "scriptIds",
    asset: "assetIds",
    asset_version: "assetVersionIds",
    storyboard: "storyboardIds",
    canvas: "canvasIds",
  } as const;
  const scope: Record<string, readonly string[]> = {};
  for (const [refType, scopeKey] of Object.entries(mapping) as Array<[
    keyof typeof mapping,
    (typeof mapping)[keyof typeof mapping],
  ]>) {
    const ids = task.inputRefs
      .filter((ref) => ref.type === refType)
      .map((ref) => ref.id)
      .sort();
    if (ids.length > 0) scope[scopeKey] = ids;
  }
  return scope;
}

function expectedInputRefs(task: AgentTask): string[] {
  return task.inputRefs
    .map((ref) => canonicalizeIdempotencyRequest(ref))
    .sort((left, right) => left.localeCompare(right));
}

function assertGrantIntegrity(
  grant: DelegationGrantRecord,
  row: RawDelegation,
  child: RawRun,
  root: RawRun,
  task: AgentTask,
  taskHash: string,
  actorUserId: number,
  expectedAllowedTools: readonly string[],
  contract: AgentDelegateContract,
): void {
  const writeTargets = parseJson(row.writeTargets, "delegation.writeTargets");
  if (grant.workspaceId !== String(root.workspaceId)
    || grant.projectId !== String(root.projectId)
    || grant.actorUserId !== actorUserId
    || grant.parentRunId !== String(root.id)
    || grant.parentStepId !== String(root.waitRef)
    || grant.boundRunId !== String(child.id)
    || grant.issuerRole !== "main"
    || grant.granteeRole !== task.role
    || grant.purpose !== `a4-delegated-task:${task.taskType}`
    || grant.objectiveHash !== hashIdempotencyRequest(task.objective)
    || grant.outputContract !== contract.createOutputContract(taskHash)
    || !equalCanonical(grant.inputRefs, expectedInputRefs(task))
    || !equalCanonical(grant.allowedTools, expectedAllowedTools)
    || !equalCanonical(grant.resourceScope, deriveResourceScope(task))
    || !equalCanonical(grant.limits, contract.parentPolicySnapshot.limits)
    || !equalCanonical(grant.spend, contract.parentPolicySnapshot.spend)
    || !equalCanonical(writeTargets, task.writeTargets)
    || grant.approval !== undefined
    || grant.canDelegate !== false
    || (grant.status === "active" && grant.consumedToolCalls >= grant.limits.maxToolCalls)
    || (grant.status === "consumed" && grant.consumedToolCalls !== grant.limits.maxToolCalls)
    || (grant.status === "revoked") !== (grant.revokedAt !== undefined && grant.revokedBy !== undefined)
    || (grant.status !== "revoked" && (grant.revokedAt !== undefined || grant.revokedBy !== undefined))) {
    fail("delegation_cancel_binding_invalid", "Grant、Run 与 AgentTask 绑定无效");
  }
}

function parseTaskResult(
  row: RawDelegation,
  role: A4DelegatedAgentRole,
  contract: AgentDelegateContract,
): AgentTaskResult | null {
  const hasJson = row.resultJson != null;
  const hasHash = row.resultHash != null;
  if (!hasJson && !hasHash && row.resultMessageId == null) return null;
  if (!hasJson || !hasHash || typeof row.resultHash !== "string" || !HASH_PATTERN.test(row.resultHash)) {
    fail("delegation_cancel_task_result_invalid", "AgentTaskResult 审计字段不完整");
  }
  let result: AgentTaskResult;
  try {
    result = contract.normalizeResult(parseJson(row.resultJson, "delegation.resultJson"), {
      expectedRole: role,
    });
  } catch {
    fail("delegation_cancel_task_result_invalid", "AgentTaskResult 审计内容无效");
  }
  if (result.status !== row.taskStatus || hashIdempotencyRequest(result) !== row.resultHash) {
    fail("delegation_cancel_task_result_invalid", "AgentTaskResult 哈希或状态绑定无效");
  }
  if (result.status !== "cancelled" && row.resultMessageId == null) {
    fail("delegation_cancel_task_result_invalid", "非取消 AgentTaskResult 缺少内部结果消息");
  }
  return result;
}

function assertTaskStatusMatchesRun(row: RawDelegation, run: RawRun, result: AgentTaskResult | null): void {
  const status = String(row.taskStatus || "");
  if (!(AGENT_TASK_STATUSES as readonly string[]).includes(status)) {
    fail("delegation_cancel_task_invalid", "AgentTask 状态无效");
  }
  if (run.status === "queued" && status !== "queued") {
    fail("delegation_cancel_task_invalid", "queued child 与 AgentTask 状态不一致");
  }
  if (run.status === "running" && status !== "queued" && status !== "running") {
    fail("delegation_cancel_task_invalid", "running child 与 AgentTask 状态不一致");
  }
  if (run.status === "cancelling" && status !== "queued" && status !== "running") {
    fail("delegation_cancel_task_invalid", "cancelling child 与 AgentTask 状态不一致");
  }
  const expectedTerminal = run.status === "succeeded"
    ? new Set(["succeeded", "needs_input"])
    : run.status === "failed" ? new Set(["failed"])
      : run.status === "cancelled" ? new Set(["cancelled"])
        : null;
  if (expectedTerminal && (!expectedTerminal.has(status) || !result)) {
    fail("delegation_cancel_task_invalid", "terminal child 与 AgentTaskResult 状态不一致");
  }
  if (!expectedTerminal && result) {
    fail("delegation_cancel_task_result_invalid", "非终态 child 不得已有 AgentTaskResult");
  }
}

function assertRootIdentity(root: RawRun, input: CancelDelegationRootInput): void {
  const status = String(root.status);
  if (String(root.workspaceId) !== input.workspaceId
    || String(root.id) !== input.rootRunId
    || root.kind !== "root"
    || root.agentRole !== "main"
    || String(root.rootRunId) !== String(root.id)
    || root.parentRunId != null
    || root.delegationId != null
    || (status !== "waiting_delegation" && status !== "cancelling")
    || root.waitType !== "delegation"
    || cleanId(root.waitRef, "root.waitRef") === ""
    || root.leaseOwner != null
    || root.leaseExpiresAt != null
    || root.heartbeatAt != null
    || !root.responseMessageId) {
    fail("delegation_root_cancel_invalid", "只有绑定完整的 main/root delegation 等待态可以传播取消");
  }
  safeInteger(root.projectId, "root.projectId", 1);
  safeInteger(root.version, "root.version", 1);
  if (status === "cancelling"
    && (root.cancelRequestedAt == null || safeInteger(root.cancelRequestedBy, "root.cancelRequestedBy", 1) < 1)) {
    fail("delegation_root_cancel_invalid", "cancelling root 缺少取消审计字段");
  }
}

export function isDelegationRootCancellationCandidate(row: Record<string, unknown>): boolean {
  const rootIdentity = String(row.kind) === "root"
    && String(row.agentRole) === "main"
    && String(row.rootRunId) === String(row.id)
    && row.parentRunId == null
    && row.delegationId == null;
  if (!rootIdentity) return false;
  return String(row.status) === "waiting_delegation"
    || (String(row.status) === "cancelling" && String(row.waitType) === "delegation");
}

export class DelegationCancellationService {
  private readonly grantService: DelegationGrantService;
  private readonly clock: () => number;
  private readonly eventAppender: EventAppender;

  constructor(
    private readonly database: Knex,
    options: DelegationCancellationServiceOptions,
  ) {
    this.grantService = options.grantService;
    this.clock = options.clock ?? Date.now;
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
  }

  async cancel(input: CancelDelegationRootInput): Promise<DelegationCancellationResult> {
    const workspaceId = cleanId(input.workspaceId, "workspaceId");
    const rootRunId = cleanId(input.rootRunId, "rootRunId");
    const requestedBy = safeInteger(input.requestedBy, "requestedBy", 1);
    return this.database.transaction(async (trx) => {
      const root = await trx<RawRun>("o_agent_run")
        .where({ id: rootRunId, workspaceId })
        .forUpdate()
        .first();
      if (!root) throw new AgentRuntimeError(404, "run_not_found", "Agent Run 不存在");
      return this.cancelLockedInTransaction(trx, {
        ...input,
        workspaceId,
        rootRunId,
        requestedBy,
      }, root);
    });
  }

  async cancelLockedInTransaction(
    trx: Knex.Transaction,
    input: CancelDelegationRootInput,
    lockedRoot: Record<string, unknown>,
  ): Promise<DelegationCancellationResult> {
    const root = lockedRoot as RawRun;
    const now = safeInteger(input.now ?? this.clock(), "now");
    const requestedBy = safeInteger(input.requestedBy, "requestedBy", 1);
    assertRootIdentity(root, input);
    const parentContract = resolveRootDelegationContract(root);
    const projectId = safeInteger(root.projectId, "root.projectId", 1);
    const delegationStepId = cleanId(root.waitRef, "root.waitRef");
    const replayed = root.status === "cancelling";
    const requestedAt = replayed
      ? safeInteger(root.cancelRequestedAt, "root.cancelRequestedAt")
      : now;
    const cancellationActor = replayed
      ? safeInteger(root.cancelRequestedBy, "root.cancelRequestedBy", 1)
      : requestedBy;
    const cancellationReason = replayed ? root.cancelReason : cleanReason(input.reason);
    const events: PendingEvent[] = [];

    // The root is the race winner fence.  Every later validation/mutation is
    // in this transaction, so a corrupt child/Grant/task rolls this back too.
    if (!replayed) {
      const version = safeInteger(root.version, "root.version", 1);
      const updated = await trx("o_agent_run")
        .where({
          id: root.id,
          workspaceId: root.workspaceId,
          status: "waiting_delegation",
          version,
          waitType: "delegation",
          waitRef: delegationStepId,
        })
        .update({
          status: "cancelling",
          cancelRequestedAt: requestedAt,
          cancelRequestedBy: cancellationActor,
          cancelReason: cancellationReason,
          version: version + 1,
          updatedAt: now,
        });
      if (affectedRows(updated) !== 1) {
        fail("delegation_root_cancel_conflict", "Root Run 取消状态发生并发冲突");
      }
      root.status = "cancelling";
      root.cancelRequestedAt = requestedAt;
      root.cancelRequestedBy = cancellationActor;
      root.cancelReason = cancellationReason;
      root.version = version + 1;
      root.updatedAt = now;
      events.push({
        workspaceId: String(root.workspaceId),
        projectId,
        threadId: String(root.threadId),
        runId: String(root.id),
        messageId: String(root.responseMessageId),
        stepId: delegationStepId,
        type: "run.status",
        payload: { runId: root.id, status: "cancelling", waitType: "delegation", waitRef: delegationStepId },
      });
    }

    // Fixed lock order: root, then every child Run ordered by id.
    const children = await trx<RawRun>("o_agent_run")
      .where({ kind: "delegated" })
      .andWhere((builder) => {
        builder.where("rootRunId", root.id).orWhere("parentRunId", root.id);
      })
      .orderBy("id", "asc")
      .forUpdate();
    if (children.length < 1 || children.length > 3) {
      fail("delegation_cancel_binding_invalid", "Root Run 的 child Run 数量无效");
    }
    const childIds = children.map((child) => cleanId(child.id, "child.id"));

    // Fixed lock order: all Grant/task rows after all child Runs.  The OR
    // deliberately includes partially-corrupt links so they fail validation
    // instead of being silently omitted from propagation.
    const grantRows = await trx<RawDelegation>(AGENT_DELEGATION_TABLE)
      .where((builder) => {
        builder
          .where("parentRunId", root.id)
          .orWhere("parentStepId", delegationStepId)
          .orWhereIn("boundRunId", childIds);
      })
      .orderBy("boundRunId", "asc")
      .orderBy("id", "asc")
      .forUpdate();
    if (grantRows.length !== children.length) {
      fail("delegation_cancel_binding_invalid", "child Run 与 Grant/task 数量不一致");
    }
    const grantByRun = new Map<string, RawDelegation>();
    for (const row of grantRows) {
      const boundRunId = cleanId(row.boundRunId, "delegation.boundRunId");
      if (grantByRun.has(boundRunId)) {
        fail("delegation_cancel_binding_invalid", "多个 Grant 绑定同一 child Run");
      }
      grantByRun.set(boundRunId, row);
    }

    const parentTrigger = await trx("o_agent_message")
      .where({
        id: root.triggerMessageId,
        workspaceId: root.workspaceId,
        projectId,
        threadId: root.threadId,
        runId: root.id,
        role: "user",
      })
      .select("id", "createdBy")
      .first();
    const actorUserId = safeInteger(parentTrigger?.createdBy, "parentTrigger.createdBy", 1);
    const prepared: PreparedChild[] = [];

    for (const child of children) {
      const childId = cleanId(child.id, "child.id");
      const delegation = grantByRun.get(childId);
      if (!delegation
        || String(child.workspaceId) !== String(root.workspaceId)
        || safeInteger(child.projectId, "child.projectId", 1) !== projectId
        || String(child.threadId) !== String(root.threadId)
        || String(child.rootRunId) !== String(root.id)
        || String(child.parentRunId) !== String(root.id)
        || String(child.delegationId) !== String(delegation.id)
        || child.kind !== "delegated"
        || !CHILD_RUN_STATUSES.has(String(child.status))) {
        fail("delegation_cancel_binding_invalid", "child Run 父链或状态绑定无效");
      }
      const role = String(child.agentRole) as A4DelegatedAgentRole;
      if (!(parentContract.roles as readonly string[]).includes(role)) {
        fail("delegation_cancel_parent_contract_invalid", "child Run 角色超出父 Run 委派契约");
      }
      if (String(delegation.workspaceId) !== String(root.workspaceId)
        || safeInteger(delegation.projectId, "delegation.projectId", 1) !== projectId
        || String(delegation.parentRunId) !== String(root.id)
        || String(delegation.parentStepId) !== delegationStepId
        || String(delegation.boundRunId) !== childId
        || String(delegation.granteeRole) !== role
        || safeInteger(delegation.taskVersion, "delegation.taskVersion", 1) !== parentContract.taskVersion
        || typeof delegation.taskHash !== "string"
        || !HASH_PATTERN.test(delegation.taskHash)) {
        fail("delegation_cancel_binding_invalid", "Grant/task 基础绑定无效");
      }
      let task: AgentTask;
      try {
        task = parentContract.normalizeTask(parseJson(delegation.taskJson, "delegation.taskJson"), {
          expectedProjectId: projectId,
        });
      } catch {
        fail("delegation_cancel_task_invalid", "AgentTask 内容无效");
      }
      const expectedAllowedTools = assertTaskMatchesParentContract(task, parentContract);
      const taskHash = hashIdempotencyRequest(task);
      if (taskHash !== delegation.taskHash || task.role !== role) {
        fail("delegation_cancel_binding_invalid", "AgentTask 哈希或角色绑定无效");
      }
      const grant = await this.grantService.getInTransaction(trx, {
        grantId: String(delegation.id),
        workspaceId: String(root.workspaceId),
        projectId,
      });
      assertGrantIntegrity(
        grant,
        delegation,
        child,
        root,
        task,
        taskHash,
        actorUserId,
        expectedAllowedTools,
        parentContract,
      );
      const policy = parentContract.parseChildPolicy(child.policySnapshot, {
        expectedRole: role,
        expectedDelegationId: String(delegation.id),
        expectedParentRunId: String(root.id),
        expectedParentStepId: delegationStepId,
        expectedTaskHash: taskHash,
      });
      if (policy.delegatedTask.version !== parentContract.policyVersion
        || policy.delegatedTask.taskVersion !== parentContract.taskVersion
        || !equalCanonical(policy.delegatedTask.allowedTools, expectedAllowedTools)) {
        fail("delegation_cancel_parent_contract_invalid", "Delegated Run 策略超出父 Run 委派契约");
      }
      const modelProfile = `${policy.agentConfig.modelProfile.key}@${policy.agentConfig.modelProfile.version}`;
      const result = parseTaskResult(delegation, role, parentContract);
      assertTaskStatusMatchesRun(delegation, child, result);

      const trigger = await trx("o_agent_message")
        .where({
          id: child.triggerMessageId,
          workspaceId: root.workspaceId,
          projectId,
          threadId: root.threadId,
          runId: child.id,
          replyToId: root.triggerMessageId,
          role: "user",
          agentRole: role,
          visibility: "internal",
          status: "completed",
          createdBy: actorUserId,
        })
        .select("id", "content", "referenceRefs", "metadata")
        .first();
      const triggerMetadata = parseJson(trigger?.metadata, "childTrigger.metadata") as Record<string, unknown> | undefined;
      const triggerContent = parseJson(trigger?.content, "childTrigger.content");
      const triggerRefs = parseJson(trigger?.referenceRefs, "childTrigger.referenceRefs");
      if (!trigger
        || triggerMetadata?.kind !== "agent_task_trigger"
        || triggerMetadata.delegationId !== String(delegation.id)
        || Number(triggerMetadata.taskVersion) !== parentContract.taskVersion
        || triggerMetadata.taskHash !== taskHash
        || !equalCanonical(triggerContent, [{ type: "text", text: task.objective }])
        || !equalCanonical(triggerRefs, task.inputRefs)) {
        fail("delegation_cancel_binding_invalid", "child trigger Message 绑定无效");
      }

      let action: PreparedChild["action"] = "none";
      if (child.status === "queued") {
        if (child.leaseOwner != null
          || child.leaseExpiresAt != null
          || child.heartbeatAt != null
          || child.responseMessageId != null
          || child.startedAt != null
          || safeInteger(child.checkpointStepSeq, "child.checkpointStepSeq") !== 0
          || Boolean(Number(child.sideEffectsCommitted || 0))) {
          fail("delegation_cancel_child_invalid", "queued child 已包含执行痕迹，不能直接取消");
        }
        action = "cancel_queued";
      } else if (child.status === "running") {
        if (!child.leaseOwner || child.leaseExpiresAt == null || child.heartbeatAt == null) {
          fail("delegation_cancel_child_invalid", "running child 缺少执行租约");
        }
        action = "request_cancel";
      }
      prepared.push({ run: child, delegation, grant, task, role, taskHash, modelProfile, action });
    }

    for (const item of prepared) {
      let grant = item.grant;
      // `getInTransaction` exposes an elapsed active row as effective
      // `expired`.  Still route the durable raw `active` row through the
      // transactional revoke helper: it atomically persists `expired` and
      // reports the terminal condition.  Catch only that exact signal inside
      // this outer transaction, then authenticate the committed-in-transaction
      // row again before continuing cancellation.
      if (item.delegation.status === "active") {
        try {
          grant = await this.grantService.revokeInTransaction(trx, {
            grantId: grant.id,
            workspaceId: String(root.workspaceId),
            projectId,
            revokedBy: cancellationActor,
            expectedRevision: grant.revision,
            now,
          });
        } catch (error) {
          if (!(error instanceof AgentRuntimeError) || error.code !== "delegation_expired") throw error;
          grant = await this.grantService.getInTransaction(trx, {
            grantId: grant.id,
            workspaceId: String(root.workspaceId),
            projectId,
          });
          if (grant.status !== "expired") {
            fail("delegation_cancel_grant_conflict", "过期 Grant 未形成可验证终态");
          }
        }
      }

      if (item.action === "cancel_queued") {
        const result = parentContract.normalizeResult({
          version: parentContract.resultVersion,
          status: "cancelled",
          artifactRefs: [],
          summary: CANCELLED_ERROR.message,
          assumptions: [],
          issues: [],
          suggestedNextActions: [],
          usage: {
            modelProfile: item.modelProfile,
            inputTokens: 0,
            outputTokens: 0,
            costMicros: null,
          },
        }, { expectedRole: item.role });
        const resultHash = hashIdempotencyRequest(result);
        const taskUpdated = await trx(AGENT_DELEGATION_TABLE)
          .where({
            id: item.delegation.id,
            boundRunId: item.run.id,
            taskHash: item.taskHash,
            taskStatus: "queued",
          })
          .whereNull("resultJson")
          .whereNull("resultHash")
          .whereNull("resultMessageId")
          .update({
            taskStatus: "cancelled",
            resultJson: JSON.stringify(result),
            resultHash,
            completedAt: now,
            safeError: JSON.stringify(CANCELLED_ERROR),
            updatedAt: now,
          });
        if (affectedRows(taskUpdated) !== 1) {
          fail("delegation_cancel_task_conflict", "queued AgentTask 取消审计写入冲突");
        }
        const childVersion = safeInteger(item.run.version, "child.version", 1);
        const childUpdated = await trx("o_agent_run")
          .where({ id: item.run.id, status: "queued", version: childVersion })
          .whereNull("leaseOwner")
          .update({
            status: "cancelled",
            waitType: null,
            waitRef: null,
            wakeAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            cancelRequestedAt: requestedAt,
            cancelRequestedBy: cancellationActor,
            cancelReason: cancellationReason,
            error: JSON.stringify(CANCELLED_ERROR),
            completedAt: now,
            version: childVersion + 1,
            updatedAt: now,
          });
        if (affectedRows(childUpdated) !== 1) {
          fail("delegation_cancel_child_conflict", "queued child 取消发生并发冲突");
        }
        item.run.status = "cancelled";
        item.run.version = childVersion + 1;
        item.run.completedAt = now;
        events.push({
          workspaceId: String(root.workspaceId),
          projectId,
          threadId: String(root.threadId),
          runId: String(item.run.id),
          stepId: delegationStepId,
          type: "internal.run.cancelled",
          payload: { runId: item.run.id, status: "cancelled", agentRole: item.role, visibility: "internal" },
        });
      } else if (item.action === "request_cancel") {
        const childVersion = safeInteger(item.run.version, "child.version", 1);
        const childUpdated = await trx("o_agent_run")
          .where({ id: item.run.id, status: "running", version: childVersion })
          .update({
            status: "cancelling",
            cancelRequestedAt: requestedAt,
            cancelRequestedBy: cancellationActor,
            cancelReason: cancellationReason,
            version: childVersion + 1,
            updatedAt: now,
          });
        if (affectedRows(childUpdated) !== 1) {
          fail("delegation_cancel_child_conflict", "running child 取消发生并发冲突");
        }
        item.run.status = "cancelling";
        item.run.version = childVersion + 1;
        events.push({
          workspaceId: String(root.workspaceId),
          projectId,
          threadId: String(root.threadId),
          runId: String(item.run.id),
          messageId: item.run.responseMessageId,
          stepId: delegationStepId,
          type: "internal.run.cancelling",
          payload: { runId: item.run.id, status: "cancelling", agentRole: item.role, visibility: "internal" },
        });
      }
    }

    const allChildrenTerminal = prepared.every(({ run }) => TERMINAL_RUN_STATUSES.has(String(run.status)));

    // Fixed lock order: delegation Step follows Grant/task rows.
    const delegationStep = await trx("o_agent_step")
      .where({
        id: delegationStepId,
        workspaceId: root.workspaceId,
        projectId,
        threadId: root.threadId,
        runId: root.id,
        kind: "delegation",
        toolName: "agent.delegate",
      })
      .forUpdate()
      .first();
    if (!delegationStep || (delegationStep.status !== "waiting_external" && delegationStep.status !== "cancelled")) {
      fail("delegation_cancel_step_invalid", "Delegation Step 状态或绑定无效");
    }
    const outputRefs = parseJson(delegationStep.outputRefs, "delegationStep.outputRefs");
    const receipt = Array.isArray(outputRefs) && outputRefs.length === 1
      ? agentDelegateWaitingOutputSchema.safeParse(outputRefs[0])
      : null;
    if (!receipt?.success
      || receipt.data.delegationStepId !== delegationStepId
      || receipt.data.acceptedTaskCount !== childIds.length
      || !equalCanonical([...receipt.data.childRunIds].sort(), [...childIds].sort())) {
      fail("delegation_cancel_step_invalid", "Delegation Step receipt 与 child Run 不一致");
    }
    if (!allChildrenTerminal && delegationStep.status !== "waiting_external") {
      fail("delegation_cancel_step_invalid", "仍有 active child 时 Delegation Step 不得提前终态");
    }
    const modelStep = delegationStep.parentStepId
      ? await trx("o_agent_step")
        .where({ id: delegationStep.parentStepId, runId: root.id, kind: "model", status: "succeeded" })
        .first()
      : null;
    const modelOutputRefs = parseJson(modelStep?.outputRefs, "parentModelStep.outputRefs");
    const modelCheckpoint = Array.isArray(modelOutputRefs) && modelOutputRefs.length === 1
      && modelOutputRefs[0] && typeof modelOutputRefs[0] === "object" && !Array.isArray(modelOutputRefs[0])
      ? modelOutputRefs[0] as Record<string, unknown>
      : null;
    if (!modelStep || !modelCheckpoint || !Array.isArray(modelCheckpoint.toolResults)
      || modelCheckpoint.toolResults.length !== 0) {
      fail("delegation_cancel_step_invalid", "父模型委派检查点已消费或无效");
    }
    assertParentModelCheckpointContract(modelCheckpoint, parentContract);

    // Fixed lock order: Thread is last.
    const thread = await trx("o_agent_thread")
      .where({
        id: root.threadId,
        workspaceId: root.workspaceId,
        projectId,
      })
      .forUpdate()
      .first();
    if (!thread
      || thread.status !== "active"
      || String(thread.activeRootRunId || "") !== String(root.id)) {
      fail("delegation_cancel_thread_invalid", "Root Run 的 active Thread 绑定无效");
    }
    for (const item of prepared) {
      if (item.grant.sessionId !== (thread.sessionId == null ? undefined : String(thread.sessionId))) {
        fail("delegation_cancel_binding_invalid", "Grant 与 Thread Session 绑定无效");
      }
      if (item.delegation.resultMessageId) {
        const expectedMessageStatus = item.delegation.taskStatus === "failed"
          ? "error"
          : item.delegation.taskStatus === "cancelled" ? "stopped" : "completed";
        const resultMessage = await trx("o_agent_message")
          .where({
            id: item.delegation.resultMessageId,
            workspaceId: root.workspaceId,
            projectId,
            threadId: root.threadId,
            runId: item.run.id,
            role: "assistant",
            agentRole: item.role,
            visibility: "internal",
            status: expectedMessageStatus,
          })
          .first();
        if (!resultMessage) {
          fail("delegation_cancel_task_result_invalid", "AgentTaskResult 内部消息绑定无效");
        }
      }
    }

    let responseMessageStopped = false;
    if (allChildrenTerminal) {
      if (delegationStep.status !== "waiting_external") {
        fail("delegation_cancel_step_invalid", "未完成 Root Run 已包含 terminal Delegation Step");
      }
      const stepUpdated = await trx("o_agent_step")
        .where({ id: delegationStepId, status: "waiting_external" })
        .update({
          status: "cancelled",
          errorCategory: CANCELLED_ERROR.code,
          safeError: JSON.stringify(CANCELLED_ERROR),
          completedAt: now,
          updatedAt: now,
        });
      if (affectedRows(stepUpdated) !== 1) {
        fail("delegation_cancel_step_conflict", "Delegation Step 取消发生并发冲突");
      }
      delegationStep.status = "cancelled";
      delegationStep.errorCategory = CANCELLED_ERROR.code;
      delegationStep.safeError = JSON.stringify(CANCELLED_ERROR);
      delegationStep.completedAt = now;
      delegationStep.updatedAt = now;
      const rootVersion = safeInteger(root.version, "root.version", 1);
      const rootUpdated = await trx("o_agent_run")
        .where({ id: root.id, status: "cancelling", version: rootVersion })
        .update({
          status: "cancelled",
          waitType: null,
          waitRef: null,
          wakeAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: JSON.stringify(CANCELLED_ERROR),
          completedAt: now,
          version: rootVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(rootUpdated) !== 1) {
        fail("delegation_root_cancel_conflict", "Root Run 终态取消发生并发冲突");
      }
      root.status = "cancelled";
      root.waitType = null;
      root.waitRef = null;
      root.version = rootVersion + 1;
      root.completedAt = now;

      const responseUpdated = await trx("o_agent_message")
        .where({
          id: root.responseMessageId,
          workspaceId: root.workspaceId,
          projectId,
          threadId: root.threadId,
          runId: root.id,
          role: "assistant",
        })
        .whereIn("status", ["pending", "streaming"])
        .update({
          status: "stopped",
          error: JSON.stringify(CANCELLED_ERROR),
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(responseUpdated) !== 1) {
        fail("delegation_cancel_response_conflict", "Root Run 回复消息停止发生并发冲突");
      }
      responseMessageStopped = true;
      events.push(
        {
          workspaceId: String(root.workspaceId),
          projectId,
          threadId: String(root.threadId),
          runId: String(root.id),
          stepId: delegationStepId,
          type: "step.cancelled",
          payload: { step: toAgentStepDto(mapAgentStep(delegationStep)) },
        },
        {
          workspaceId: String(root.workspaceId),
          projectId,
          threadId: String(root.threadId),
          runId: String(root.id),
          messageId: String(root.responseMessageId),
          type: "message.stopped",
          payload: { messageId: root.responseMessageId, status: "stopped", code: CANCELLED_ERROR.code },
        },
        {
          workspaceId: String(root.workspaceId),
          projectId,
          threadId: String(root.threadId),
          runId: String(root.id),
          messageId: String(root.responseMessageId),
          stepId: delegationStepId,
          type: "run.cancelled",
          payload: { runId: root.id, status: "cancelled" },
        },
      );
    }

    const threadVersion = safeInteger(thread.version, "thread.version", 1);
    const eventSeq = safeInteger(thread.eventSeq, "thread.eventSeq");
    if (events.length > 0) {
      const threadPatch: Record<string, unknown> = {
        eventSeq: eventSeq + events.length,
        version: threadVersion + 1,
        updatedAt: now,
      };
      if (responseMessageStopped) {
        threadPatch.activeRootRunId = null;
        threadPatch.lastMessageAt = now;
      }
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, version: threadVersion, activeRootRunId: root.id })
        .update(threadPatch);
      if (affectedRows(threadUpdated) !== 1) {
        fail("delegation_cancel_thread_conflict", "Thread 取消序列发生并发冲突");
      }
      for (let index = 0; index < events.length; index += 1) {
        await this.eventAppender(trx, {
          ...events[index],
          seq: eventSeq + index + 1,
          createdAt: now,
        });
      }
    }

    const updated = await trx("o_agent_run")
      .where({ id: root.id, workspaceId: root.workspaceId })
      .first();
    if (!updated) fail("delegation_root_cancel_missing", "Root Run 更新后无法读取", 500);
    return { run: mapRun(updated as RawRun), replayed };
  }
}
