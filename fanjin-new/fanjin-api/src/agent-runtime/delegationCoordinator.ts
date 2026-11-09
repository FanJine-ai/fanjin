import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { AgentRuntimeConfigService } from "@/agent-runtime/agentRuntimeConfigService";
import {
  AGENT_TASK_STATUSES,
  agentTaskWriteTargetKey,
  agentTaskWriteTargetSchema,
  type A4DelegatedAgentRole,
  type AgentTask,
  type AgentTaskRef,
  type AnyAgentTaskWriteTarget,
} from "@/agent-runtime/delegationContracts";
import {
  type DelegationGrantService,
  AGENT_EXECUTOR_DELEGATION_MAX_TTL_MS,
} from "@/agent-runtime/delegationGrantService";
import { A4_DELEGATED_RUN_POLICY_VERSION_V3 } from "@/agent-runtime/delegatedRunPolicy";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { hasValidDelegationModelCheckpointFields } from "@/agent-runtime/delegationModelCheckpoint";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { appendAgentEvent, type AppendAgentEventInput } from "@/agent-runtime/eventStore";
import { canonicalizeIdempotencyRequest, hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4,
  AGENT_MAIN_PROMPT_KEY,
  createAgentRuntimeConfigSnapshotFromSelection,
  resolveAgentRuntimeConfigSnapshot,
  type AgentRuntimeConfigSnapshot,
} from "@/agent-runtime/runtimeConfigRegistry";
import { RUN_STATUSES } from "@/agent-runtime/stateMachine";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import {
  getAgentDelegateContractForPromptVersion,
  parseAgentDelegateInputForPromptVersion,
  agentDelegateWaitingOutputSchema,
  type AgentDelegateContract,
  type AgentDelegateTaskInput,
  type AgentDelegateWaitingOutput,
} from "@/agent-runtime/tools/packages/delegation";
import { AGENT_DELEGATION_TABLE } from "@/lib/migrations/agentApprovalDelegation";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const MAX_ACTIVE_DELEGATED_RUNS = 3;
const SAFE_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;

type AgentEventAppender = (
  trx: Knex.Transaction,
  input: AppendAgentEventInput,
) => Promise<string>;

export interface StartAgentDelegationInput {
  parentRunId: string;
  modelStepId: string;
  workerId: string;
  attempt: number;
  idempotencyKey: string;
  tasks: readonly AgentDelegateTaskInput[];
}

export interface AgentDelegationCoordinatorReceipt extends AgentDelegateWaitingOutput {
  replayed: boolean;
}

export interface AgentDelegationCoordinatorOptions {
  grantService: DelegationGrantService;
  clock?: () => number;
  stepIdFactory?: () => string;
  runIdFactory?: () => string;
  messageIdFactory?: () => string;
  eventAppender?: AgentEventAppender;
}

interface ParsedModelDelegateCall {
  callHash: string;
  tasks: AgentDelegateTaskInput[];
}

interface PreparedTask {
  task: AgentTask;
  taskHash: string;
  resourceScope: Record<string, readonly string[]>;
}

interface RawParentRun extends Record<string, unknown> {
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
  status: string;
  waitType: string | null;
  waitRef: string | null;
  policySnapshot: unknown;
  leaseOwner: string | null;
  leaseExpiresAt: number | string | null;
  heartbeatAt: number | string | null;
  attempt: number | string;
  maxAttempts: number | string;
  checkpointStepSeq: number | string;
  spendLimitMicros: number | string;
  actualSpendMicros: number | string;
  version: number | string;
}

interface RawThread extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  projectId: number | string;
  sessionId: string | null;
  status: string;
  activeRootRunId: string | null;
  messageSeq: number | string;
  eventSeq: number | string;
  version: number | string;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new AgentRuntimeError(status, code, message, details);
}

function cleanId(value: unknown, field: string, maxLength = 200, status = 400): string {
  if (typeof value !== "string") fail(status, "delegation_coordinator_input_invalid", `${field} 格式无效`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !SAFE_ID_PATTERN.test(normalized)) {
    fail(status, "delegation_coordinator_input_invalid", `${field} 格式无效`);
  }
  return normalized;
}

function safeInteger(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; status?: number } = {},
): number {
  const result = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    fail(options.status ?? 409, "delegation_coordinator_record_invalid", `${field} 不是安全整数`);
  }
  return result;
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    fail(409, "delegation_coordinator_record_invalid", `${field} 无法解析`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return Number(value || 0);
}

function canonicalPositiveId(value: string, field: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    fail(409, "agent_task_ref_invalid", `${field} 对象 ID 无效`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || String(id) !== value) {
    fail(409, "agent_task_ref_invalid", `${field} 对象 ID 无效`);
  }
  return id;
}

function assertExactParentPolicy(parent: RawParentRun): AgentDelegateContract {
  const parsed = parseJson(parent.policySnapshot, "parentRun.policySnapshot");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(409, "parent_delegation_policy_invalid", "父 Run 缺少 A4 委派策略快照");
  }
  const policy = parsed as Record<string, unknown>;
  if (!exactKeys(policy, [
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
    || policy.phase !== "A4-delegation"
    || !policy.delegation
    || typeof policy.delegation !== "object"
    || Array.isArray(policy.delegation)) {
    fail(409, "parent_delegation_policy_invalid", "父 Run 的 A4 委派策略快照不完整");
  }
  let resolved: ReturnType<typeof resolveAgentRuntimeConfigSnapshot>;
  try {
    resolved = resolveAgentRuntimeConfigSnapshot(policy.agentConfig, "main");
  } catch {
    fail(409, "parent_delegation_policy_invalid", "父 Run 的 main Agent 配置快照无效");
  }
  const contract = getAgentDelegateContractForPromptVersion(resolved.prompt.version);
  if (resolved.prompt.key !== AGENT_MAIN_PROMPT_KEY
    || !contract
    || !resolved.execution.enabled
    || policy.modelAlias !== resolved.execution.modelAlias
    || !resolved.modelProfile.capabilities.includes("tools")
    || canonicalizeIdempotencyRequest(policy.delegation)
      !== canonicalizeIdempotencyRequest(contract.parentPolicySnapshot)) {
    fail(409, "parent_delegation_policy_invalid", "父 Run 未固定到受支持的委派配置");
  }
  return contract;
}

function assertRootIdentity(parent: RawParentRun, contract: AgentDelegateContract): void {
  if (String(parent.kind) !== "root"
    || String(parent.agentRole) !== "main"
    || String(parent.rootRunId) !== String(parent.id)
    || parent.parentRunId != null
    || parent.delegationId != null
    || safeInteger(parent.projectId, "parentRun.projectId", { min: 1 }) <= 0) {
    fail(409, "parent_run_invalid", "只有完整的 main/root Run 可以创建 A4 委派");
  }
  // v4/v5（零花费合同）保持原不变量：父 Run 必须零预算零花费。
  // v10（V3/executor 合同）：父 Run 是完整 ToolLoop Run，允许非零模型
  // 预算；executor Grant 的 spend 由 Grant 服务按剩余额度钳制。
  if (contract.policyVersion !== A4_DELEGATED_RUN_POLICY_VERSION_V3
    && (safeInteger(parent.spendLimitMicros, "parentRun.spendLimitMicros") !== 0
      || safeInteger(parent.actualSpendMicros, "parentRun.actualSpendMicros") !== 0)) {
    fail(409, "parent_run_invalid", "零花费委派合同要求父 Run 零预算");
  }
}

function parseModelDelegateCall(
  step: Record<string, unknown>,
  requestedTasks: readonly AgentDelegateTaskInput[],
  contract: AgentDelegateContract,
): ParsedModelDelegateCall {
  if (String(step.kind) !== "model" || String(step.status) !== "succeeded") {
    fail(409, "delegation_model_step_invalid", "委派必须来自已成功持久化的模型 Step");
  }
  const outputRefs = parseJson(step.outputRefs, "modelStep.outputRefs");
  if (!Array.isArray(outputRefs) || outputRefs.length !== 1) {
    fail(409, "delegation_model_step_invalid", "模型 Step 缺少唯一委派调用检查点");
  }
  const turnResult = outputRefs[0];
  if (!turnResult || typeof turnResult !== "object" || Array.isArray(turnResult)) {
    fail(409, "delegation_model_step_invalid", "模型 Step 检查点格式无效");
  }
  const result = turnResult as Record<string, unknown>;
  if (!hasValidDelegationModelCheckpointFields(result)
    || result.type !== "model_turn_result"
    || result.outcome !== "tool_calls"
    || typeof result.assistantText !== "string"
    || safeInteger(result.turn, "modelStep.turn", { min: 1 }) < 1
    || !Array.isArray(result.content)
    || result.content.length !== 0
    || !Array.isArray(result.toolResults)
    || result.toolResults.length !== 0
    || result.approvalId !== null
    || !Array.isArray(result.calls)
    || result.calls.length !== 1) {
    fail(409, "delegation_model_step_invalid", "模型 Step 不是未消费的单一 agent.delegate 调用");
  }
  const call = result.calls[0];
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    fail(409, "delegation_model_call_invalid", "agent.delegate 调用格式无效");
  }
  const rawCall = call as Record<string, unknown>;
  if (!exactKeys(rawCall, ["arguments", "id", "name"])
    || cleanId(rawCall.id, "modelCall.id", 200, 409) !== rawCall.id
    || rawCall.name !== "agent.delegate") {
    fail(409, "delegation_model_call_invalid", "模型调用不是唯一的 agent.delegate");
  }
  const persistedInput = parseAgentDelegateInputForPromptVersion(
    contract.promptVersion,
    rawCall.arguments,
  );
  const requestedInput = parseAgentDelegateInputForPromptVersion(
    contract.promptVersion,
    { tasks: requestedTasks },
  );
  if (!persistedInput || !requestedInput) {
    fail(400, "delegation_request_invalid", "agent.delegate tasks 格式无效");
  }
  const persistedCallHash = hashIdempotencyRequest(rawCall);
  const requestedCallHash = hashIdempotencyRequest({
    id: rawCall.id,
    name: "agent.delegate",
    arguments: requestedInput,
  });
  if (persistedCallHash !== requestedCallHash) {
    fail(409, "delegation_model_call_mismatch", "请求与持久化 agent.delegate 调用不一致");
  }
  return { callHash: persistedCallHash, tasks: requestedInput.tasks };
}

async function assertRowsMatch(
  query: Knex.QueryBuilder,
  expectedIds: readonly string[],
  field: string,
): Promise<void> {
  if (expectedIds.length === 0) return;
  const rows = await query;
  const found = new Set(rows.map((row: Record<string, unknown>) => String(row.id)));
  if (found.size !== expectedIds.length || expectedIds.some((id) => !found.has(id))) {
    fail(409, "agent_task_ref_invalid", `${field} 包含不存在或跨项目对象`);
  }
}

function assertUnversioned(refs: readonly AgentTaskRef[], type: AgentTaskRef["type"]): void {
  if (refs.some((ref) => ref.type === type && ref.version !== null)) {
    fail(409, "agent_task_ref_version_invalid", `${type} 当前没有可验证版本，version 必须为 null`);
  }
}

async function validateAndCompleteRefs(
  trx: Knex.Transaction,
  task: AgentDelegateTaskInput,
  parent: RawParentRun,
  thread: RawThread,
  projectRevision: number,
): Promise<AgentTaskRef[]> {
  const projectId = safeInteger(parent.projectId, "parentRun.projectId", { min: 1 });
  const refs = task.inputRefs.map((ref) => ({ ...ref })) as AgentTaskRef[];
  const projectRefs = refs.filter((ref) => ref.type === "project");
  if (projectRefs.length > 1) {
    fail(409, "agent_task_project_scope_invalid", "专项任务只能引用当前项目一次");
  }
  const expectedProjectRef: AgentTaskRef = {
    type: "project",
    id: String(projectId),
    version: String(projectRevision),
  };
  if (projectRefs.length === 0) {
    refs.push(expectedProjectRef);
  } else if (canonicalizeIdempotencyRequest(projectRefs[0])
    !== canonicalizeIdempotencyRequest(expectedProjectRef)) {
    fail(409, "agent_task_project_scope_invalid", "模型提交的项目引用与当前项目版本不匹配");
  }

  const sessionRefs = refs.filter((ref) => ref.type === "session");
  if (sessionRefs.length > 1 || (sessionRefs.length === 1 && sessionRefs[0].id !== thread.sessionId)) {
    fail(409, "agent_task_ref_invalid", "session 引用必须精确绑定当前 Thread");
  }
  if (sessionRefs.length === 1) {
    const session = await trx("o_creation_session")
      .where({
        id: sessionRefs[0].id,
        workspaceId: parent.workspaceId,
        projectId,
        status: "active",
      })
      .whereNull("archivedAt")
      .select("id", "version")
      .first();
    if (!session || sessionRefs[0].version !== String(safeInteger(session.version, "session.version", { min: 1 }))) {
      fail(409, "agent_task_ref_version_invalid", "session 引用不存在或版本不匹配");
    }
  }

  for (const type of ["script", "asset", "asset_version", "storyboard", "canvas", "message"] as const) {
    assertUnversioned(refs, type);
  }
  const ids = (type: AgentTaskRef["type"]) => refs.filter((ref) => ref.type === type).map((ref) => ref.id);
  const numericIds = (type: AgentTaskRef["type"]) => ids(type).map((id) => canonicalPositiveId(id, type));
  const scriptIds = numericIds("script");
  const assetIds = numericIds("asset");
  const assetVersionIds = numericIds("asset_version");
  const storyboardIds = numericIds("storyboard");
  const canvasIds = numericIds("canvas");
  await assertRowsMatch(
    trx("o_script").where({ projectId }).whereIn("id", scriptIds).select("id"),
    scriptIds.map(String),
    "script",
  );
  await assertRowsMatch(
    trx("o_assets").where({ projectId }).whereIn("id", assetIds).select("id"),
    assetIds.map(String),
    "asset",
  );
  await assertRowsMatch(
    trx("o_image as image")
      .join("o_assets as asset", "asset.id", "image.assetsId")
      .where("asset.projectId", projectId)
      .whereIn("image.id", assetVersionIds)
      .select({ id: "image.id" }),
    assetVersionIds.map(String),
    "asset_version",
  );
  await assertRowsMatch(
    trx("o_storyboard").where({ projectId }).whereIn("id", storyboardIds).select("id"),
    storyboardIds.map(String),
    "storyboard",
  );
  await assertRowsMatch(
    trx("o_workflow_graph").where({ projectId }).whereIn("id", canvasIds).select("id"),
    canvasIds.map(String),
    "canvas",
  );
  await assertRowsMatch(
    trx("o_agent_message")
      .where({ workspaceId: parent.workspaceId, projectId, threadId: parent.threadId })
      .whereIn("id", ids("message"))
      .select("id"),
    ids("message"),
    "message",
  );
  return refs;
}

function deriveWriteTargets(
  role: A4DelegatedAgentRole,
  taskType: string,
  projectId: number,
  refs: readonly AgentTaskRef[],
): AnyAgentTaskWriteTarget[] {
  const refIds = (type: AgentTaskRef["type"]) => refs
    .filter((ref) => ref.type === type)
    .map((ref) => ref.id);
  let targets: AnyAgentTaskWriteTarget[];
  if (role === "writer") {
    const anchors = refIds("script");
    targets = (anchors.length > 0 ? anchors : [`project:${projectId}`])
      .map((id) => ({ type: "script_draft" as const, id }));
  } else if (role === "visual") {
    const anchors = refIds("asset");
    targets = (anchors.length > 0 ? anchors : [`project:${projectId}`])
      .map((id) => ({ type: "asset_design_draft" as const, id }));
  } else if (role === "reviewer") {
    targets = [{ type: "review_report" as const, id: `project:${projectId}` }];
  } else if (role === "executor") {
    // executor 唯一写目标：管线产出的成片（服务端固定，模型不可指定）。
    targets = [{ type: "merged_video" as const, id: `project:${projectId}` }];
  } else if (taskType === "storyboard.canvas_layout_plan") {
    const anchors = refIds("canvas");
    targets = (anchors.length > 0 ? anchors : [`project:${projectId}`])
      .map((id) => ({ type: "canvas_draft" as const, id }));
  } else {
    const storyboardAnchors = refIds("storyboard");
    const scriptAnchors = refIds("script");
    const anchors = storyboardAnchors.length > 0
      ? storyboardAnchors
      : scriptAnchors.length > 0
        ? scriptAnchors
        : [`project:${projectId}`];
    targets = anchors.map((id) => ({ type: "storyboard_draft" as const, id }));
  }
  const byKey = new Map(targets.map((target) => [agentTaskWriteTargetKey(target), target]));
  const normalized = [...byKey.values()].sort((left, right) => (
    agentTaskWriteTargetKey(left).localeCompare(agentTaskWriteTargetKey(right))
  ));
  if (normalized.length === 0 || normalized.length > 6) {
    fail(409, "agent_task_write_target_invalid", "无法为专项任务派生有界写目标");
  }
  return normalized;
}

function deriveResourceScope(task: AgentTask): Record<string, readonly string[]> {
  const mapping = {
    script: "scriptIds",
    asset: "assetIds",
    asset_version: "assetVersionIds",
    storyboard: "storyboardIds",
    canvas: "canvasIds",
  } as const;
  const result: Record<string, readonly string[]> = {};
  for (const [refType, scopeKey] of Object.entries(mapping) as Array<[
    keyof typeof mapping,
    (typeof mapping)[keyof typeof mapping],
  ]>) {
    const values = task.inputRefs.filter((ref) => ref.type === refType).map((ref) => ref.id);
    if (values.length > 0) result[scopeKey] = [...values].sort();
  }
  return result;
}

function grantInputRefs(task: AgentTask): string[] {
  return task.inputRefs.map((ref) => canonicalizeIdempotencyRequest(ref));
}

function grantPurpose(task: AgentTask): string {
  return `a4-delegated-task:${task.taskType}`;
}

function grantOutputContract(taskHash: string, contract: AgentDelegateContract): string {
  return `${contract.outputContractPrefix}${taskHash}`;
}

async function prepareTasks(
  trx: Knex.Transaction,
  modelTasks: readonly AgentDelegateTaskInput[],
  parent: RawParentRun,
  thread: RawThread,
  contract: AgentDelegateContract,
): Promise<PreparedTask[]> {
  const projectId = safeInteger(parent.projectId, "parentRun.projectId", { min: 1 });
  const project = await trx("o_project")
    .where({ id: projectId, workspaceId: parent.workspaceId })
    .select("id", "revision")
    .first();
  if (!project) fail(409, "agent_task_project_scope_invalid", "父 Run 项目不存在");
  const projectRevision = safeInteger(project.revision, "project.revision", { min: 1 });
  const prepared: PreparedTask[] = [];
  const batchTargets = new Set<string>();
  for (const modelTask of modelTasks) {
    const refs = await validateAndCompleteRefs(trx, modelTask, parent, thread, projectRevision);
    if (modelTask.role === "executor" && modelTask.executionSpec !== undefined) {
      await assertExecutorStoryVideoFrames(trx, projectId, modelTask.executionSpec);
    }
    const writeTargets = deriveWriteTargets(modelTask.role, modelTask.taskType, projectId, refs);
    const task = contract.normalizeTask({
      ...modelTask,
      version: contract.taskVersion,
      projectId,
      inputRefs: refs,
      writeTargets,
    }, { expectedProjectId: projectId });
    for (const target of task.writeTargets) {
      const key = agentTaskWriteTargetKey(target);
      if (batchTargets.has(key)) {
        fail(409, "agent_task_write_target_conflict", "同批专项任务写目标冲突");
      }
      batchTargets.add(key);
    }
    const taskHash = hashIdempotencyRequest(task);
    prepared.push({ task, taskHash, resourceScope: deriveResourceScope(task) });
  }
  return prepared;
}

/**
 * executor.story_video 的帧资产验证：executionSpec 的每个
 * storyboardAssetVersionId 都必须是当前项目真实存在的图片资产版本。
 * 结构校验（帧数=场景数+1、不重复）已由 storyVideoPipelineSpecSchema
 * 在输入解析阶段完成。
 */
async function assertExecutorStoryVideoFrames(
  trx: Knex.Transaction,
  projectId: number,
  executionSpec: unknown,
): Promise<void> {
  const spec = executionSpec as { storyboardAssetVersionIds?: unknown } | null;
  const frameIds = Array.isArray(spec?.storyboardAssetVersionIds)
    ? spec.storyboardAssetVersionIds.map((value) => Number(value))
    : [];
  if (frameIds.length === 0) {
    fail(400, "delegation_request_invalid", "executor 任务缺少 storyVideo 帧序列");
  }
  const rows = await trx("o_image as image")
    .join("o_assets as asset", "asset.id", "image.assetsId")
    .where("asset.projectId", projectId)
    .whereIn("image.id", frameIds)
    .select({ id: "image.id" });
  const found = new Set(rows.map((row: Record<string, unknown>) => String(row.id)));
  const missing = frameIds.filter((frameId) => !found.has(String(frameId)));
  if (missing.length > 0) {
    fail(409, "agent_task_ref_invalid", `storyVideo 帧资产版本不存在或跨项目：${missing.join(", ")}`);
  }
}

function parseStoredWriteTargets(value: unknown): AnyAgentTaskWriteTarget[] {
  const parsed = parseJson(value, "delegation.writeTargets");
  const result = agentTaskWriteTargetSchema.array().min(1).max(6).safeParse(parsed);
  if (!result.success) {
    fail(409, "active_delegation_corrupt", "现存 active DelegationGrant 缺少有效写目标");
  }
  return result.data;
}

async function assertActiveCapacityAndTargets(
  trx: Knex.Transaction,
  parent: RawParentRun,
  tasks: readonly PreparedTask[],
): Promise<void> {
  const activeRuns = await trx("o_agent_run")
    .where({ rootRunId: parent.id, kind: "delegated" })
    .whereNotIn("status", TERMINAL_RUN_STATUSES)
    .select("id", "delegationId", "parentRunId");
  if (activeRuns.length + tasks.length > MAX_ACTIVE_DELEGATED_RUNS) {
    fail(409, "delegation_active_limit_exceeded", "同一父 Run 最多允许 3 个 active 专项任务");
  }
  const grantIds = activeRuns.map((run) => cleanId(run.delegationId, "activeRun.delegationId", 200, 409));
  const grants = grantIds.length === 0
    ? []
    : await trx(AGENT_DELEGATION_TABLE)
      .whereIn("id", grantIds)
      .select("id", "boundRunId", "parentRunId", "writeTargets");
  if (grants.length !== activeRuns.length) {
    fail(409, "active_delegation_corrupt", "active Delegated Run 与 Grant 绑定不完整");
  }
  const grantById = new Map(grants.map((grant) => [String(grant.id), grant]));
  const existingTargets = new Set<string>();
  for (const run of activeRuns) {
    const grant = grantById.get(String(run.delegationId));
    if (!grant
      || String(grant.boundRunId || "") !== String(run.id)
      || String(grant.parentRunId || "") !== String(parent.id)
      || String(run.parentRunId || "") !== String(parent.id)) {
      fail(409, "active_delegation_corrupt", "active Delegated Run 与 Grant 绑定不一致");
    }
    for (const target of parseStoredWriteTargets(grant.writeTargets)) {
      existingTargets.add(agentTaskWriteTargetKey(target));
    }
  }
  for (const prepared of tasks) {
    for (const target of prepared.task.writeTargets) {
      if (existingTargets.has(agentTaskWriteTargetKey(target))) {
        fail(409, "agent_task_write_target_conflict", "专项任务写目标与 active 子任务冲突");
      }
    }
  }
}

function replayExpectedTask(
  modelTask: AgentDelegateTaskInput,
  storedTask: AgentTask,
  contract: AgentDelegateContract,
): AgentTask {
  const modelHasProjectRef = modelTask.inputRefs.some((ref) => ref.type === "project");
  const storedProjectRefs = storedTask.inputRefs.filter((ref) => ref.type === "project");
  if (storedProjectRefs.length !== 1) {
    fail(409, "delegation_replay_corrupt", "持久化 AgentTask 项目绑定无效");
  }
  const refs = modelHasProjectRef
    ? modelTask.inputRefs
    : [...modelTask.inputRefs, storedProjectRefs[0]];
  const writeTargets = deriveWriteTargets(
    modelTask.role,
    modelTask.taskType,
    storedTask.projectId,
    refs,
  );
  return contract.normalizeTask({
    ...modelTask,
    version: contract.taskVersion,
    projectId: storedTask.projectId,
    inputRefs: refs,
    writeTargets,
  }, { expectedProjectId: storedTask.projectId });
}

export class AgentDelegationCoordinator {
  private readonly grantService: DelegationGrantService;
  private readonly clock: () => number;
  private readonly stepIdFactory: () => string;
  private readonly runIdFactory: () => string;
  private readonly messageIdFactory: () => string;
  private readonly eventAppender: AgentEventAppender;

  constructor(
    private readonly database: Knex,
    options: AgentDelegationCoordinatorOptions,
  ) {
    this.grantService = options.grantService;
    this.clock = options.clock ?? Date.now;
    this.stepIdFactory = options.stepIdFactory ?? randomUUID;
    this.runIdFactory = options.runIdFactory ?? randomUUID;
    this.messageIdFactory = options.messageIdFactory ?? randomUUID;
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
  }

  async start(input: StartAgentDelegationInput): Promise<AgentDelegationCoordinatorReceipt> {
    const parentRunId = cleanId(input.parentRunId, "parentRunId");
    const modelStepId = cleanId(input.modelStepId, "modelStepId");
    const workerId = cleanId(input.workerId, "workerId");
    const idempotencyKey = cleanId(input.idempotencyKey, "idempotencyKey");
    const attempt = safeInteger(input.attempt, "attempt", { min: 1, status: 400 });
    const now = safeInteger(this.clock(), "clock", { status: 500 });

    return this.database.transaction(async (trx) => {
      const parent = await trx<RawParentRun>("o_agent_run")
        .where({ id: parentRunId })
        .forUpdate()
        .first();
      if (!parent) fail(404, "parent_run_not_found", "父 Agent Run 不存在");
      const delegationContract = assertExactParentPolicy(parent);
      assertRootIdentity(parent, delegationContract);
      const projectId = safeInteger(parent.projectId, "parentRun.projectId", { min: 1 });
      const modelStep = await trx("o_agent_step")
        .where({
          id: modelStepId,
          runId: parent.id,
          workspaceId: parent.workspaceId,
          projectId,
          threadId: parent.threadId,
        })
        .forUpdate()
        .first();
      if (!modelStep) fail(404, "delegation_model_step_not_found", "模型 Step 不存在");
      const modelCall = parseModelDelegateCall(modelStep, input.tasks, delegationContract);

      const existingSteps = await trx("o_agent_step")
        .where({
          runId: parent.id,
          parentStepId: modelStepId,
          kind: "delegation",
        })
        .select("*");
      if (existingSteps.length > 1) {
        fail(409, "delegation_replay_corrupt", "同一模型 Step 存在多个 Delegation Step");
      }
      if (existingSteps.length === 1) {
        const step = existingSteps[0];
        if (String(step.idempotencyKey || "") !== idempotencyKey
          || String(step.argumentsDigest || "") !== modelCall.callHash) {
          fail(409, "delegation_idempotency_conflict", "该模型调用已被不同委派请求消费");
        }
        return this.replayInTransaction(trx, parent, step, modelCall.tasks, delegationContract);
      }
      const reusedKey = await trx("o_agent_step")
        .where({ runId: parent.id, kind: "delegation", idempotencyKey })
        .select("id")
        .first();
      if (reusedKey) {
        fail(409, "delegation_idempotency_conflict", "幂等键已用于另一模型调用");
      }

      if (String(parent.status) !== "running"
        || String(parent.leaseOwner || "") !== workerId
        || safeInteger(parent.attempt, "parentRun.attempt") !== attempt
        || parent.leaseExpiresAt == null
        || safeInteger(parent.leaseExpiresAt, "parentRun.leaseExpiresAt") <= now) {
        fail(409, "delegation_parent_lease_lost", "父 Run 不是当前 Worker 持有的 live running Run");
      }
      const thread = await trx<RawThread>("o_agent_thread")
        .where({
          id: parent.threadId,
          workspaceId: parent.workspaceId,
          projectId,
        })
        .forUpdate()
        .first();
      if (!thread
        || String(thread.status) !== "active"
        || String(thread.activeRootRunId || "") !== String(parent.id)) {
        fail(409, "parent_thread_invalid", "父 Run 的 active Thread 绑定无效");
      }
      const trigger = await trx("o_agent_message")
        .where({
          id: parent.triggerMessageId,
          runId: parent.id,
          threadId: parent.threadId,
          workspaceId: parent.workspaceId,
          projectId,
        })
        .select("createdBy")
        .first();
      const actorUserId = safeInteger(trigger?.createdBy, "parentTrigger.createdBy", { min: 1 });
      const preparedTasks = await prepareTasks(trx, modelCall.tasks, parent, thread, delegationContract);
      await assertActiveCapacityAndTargets(trx, parent, preparedTasks);

      const roleSnapshots = new Map<A4DelegatedAgentRole, AgentRuntimeConfigSnapshot>();
      const configService = new AgentRuntimeConfigService(trx as unknown as Knex);
      for (const { task } of preparedTasks) {
        if (roleSnapshots.has(task.role)) continue;
        const selection = await configService.getRoleConfig(task.role);
        if (!selection.enabled) {
          fail(409, "agent_role_disabled", `专项 Agent ${task.role} 当前已停用`);
        }
        const snapshot = createAgentRuntimeConfigSnapshotFromSelection(selection);
        roleSnapshots.set(task.role, snapshot);
      }

      const delegationStepId = cleanId(this.stepIdFactory(), "delegationStepId", 200, 500);
      const childRunIds = preparedTasks.map(() => cleanId(this.runIdFactory(), "childRunId", 200, 500));
      const triggerMessageIds = preparedTasks.map(() => cleanId(this.messageIdFactory(), "triggerMessageId", 200, 500));
      if (new Set(childRunIds).size !== childRunIds.length
        || new Set(triggerMessageIds).size !== triggerMessageIds.length) {
        fail(500, "delegation_id_factory_collision", "专项任务 ID 生成器返回重复 ID");
      }
      const receipt = agentDelegateWaitingOutputSchema.parse({
        status: "waiting_delegation",
        waitType: "delegation",
        delegationStepId,
        acceptedTaskCount: preparedTasks.length,
        childRunIds,
      });
      const maxStep = await trx("o_agent_step")
        .where({ runId: parent.id })
        .max({ maxSeq: "seq" })
        .first();
      const stepSeq = Math.max(
        safeInteger(parent.checkpointStepSeq, "parentRun.checkpointStepSeq"),
        safeInteger(maxStep?.maxSeq ?? 0, "parentRun.maxStepSeq"),
      ) + 1;
      await trx("o_agent_step").insert({
        id: delegationStepId,
        workspaceId: parent.workspaceId,
        projectId,
        threadId: parent.threadId,
        runId: parent.id,
        parentStepId: modelStepId,
        seq: stepSeq,
        agentRole: "main",
        kind: "delegation",
        status: "waiting_external",
        toolName: "agent.delegate",
        argumentsDigest: modelCall.callHash,
        inputRefs: "[]",
        outputRefs: JSON.stringify([receipt]),
        idempotencyKey,
        resolvedModel: null,
        provider: null,
        usage: "{}",
        costMicros: 0,
        errorCategory: null,
        safeError: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: null,
      });

      const messageSeqBase = safeInteger(thread.messageSeq, "thread.messageSeq");
      for (let index = 0; index < preparedTasks.length; index += 1) {
        const prepared = preparedTasks[index];
        const childRunId = childRunIds[index];
        const triggerMessageId = triggerMessageIds[index];
        const isExecutorTask = prepared.task.role === "executor";
        const grant = await this.grantService.issueInTransaction(trx, {
          workspaceId: parent.workspaceId,
          projectId,
          parentRunId: parent.id,
          parentStepId: delegationStepId,
          granteeRole: prepared.task.role,
          purpose: grantPurpose(prepared.task),
          objective: prepared.task.objective,
          inputRefs: grantInputRefs(prepared.task),
          outputContract: grantOutputContract(prepared.taskHash, delegationContract),
          requestedTools: delegationContract.getR0ToolIds(prepared.task.role),
          resourceScope: prepared.resourceScope,
          limits: { ...delegationContract.parentPolicySnapshot.limits },
          spend: { ...delegationContract.parentPolicySnapshot.spend },
          // executor 管线包含逐段审批等待与异步视频生成，TTL 覆盖整个
          // 管线；Grant 服务按 executor 角色放宽 max TTL（24h）。
          ...(isExecutorTask ? { ttlMs: AGENT_EXECUTOR_DELEGATION_MAX_TTL_MS } : {}),
        });
        const childPolicy = delegationContract.createChildPolicy({
          role: prepared.task.role,
          delegationId: grant.id,
          parentRunId: parent.id,
          parentStepId: delegationStepId,
          taskHash: prepared.taskHash,
          agentConfig: roleSnapshots.get(prepared.task.role)!,
        });
        await trx("o_agent_message").insert({
          id: triggerMessageId,
          workspaceId: parent.workspaceId,
          projectId,
          threadId: parent.threadId,
          runId: childRunId,
          replyToId: parent.triggerMessageId,
          clientMessageId: null,
          seq: messageSeqBase + index + 1,
          role: "user",
          agentRole: prepared.task.role,
          visibility: "internal",
          status: "completed",
          content: JSON.stringify([{ type: "text", text: prepared.task.objective }]),
          referenceRefs: JSON.stringify(prepared.task.inputRefs),
          createdBy: actorUserId,
          error: null,
          metadata: JSON.stringify({
            kind: "agent_task_trigger",
            delegationId: grant.id,
            taskVersion: delegationContract.taskVersion,
            taskHash: prepared.taskHash,
          }),
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        });
        await trx("o_agent_run").insert({
          id: childRunId,
          workspaceId: parent.workspaceId,
          projectId,
          threadId: parent.threadId,
          rootRunId: parent.id,
          parentRunId: parent.id,
          delegationId: grant.id,
          blockedByRunId: null,
          kind: "delegated",
          agentRole: prepared.task.role,
          triggerMessageId,
          responseMessageId: null,
          status: "queued",
          waitType: null,
          waitRef: null,
          wakeAt: null,
          policySnapshot: JSON.stringify(childPolicy),
          contextVersion: safeInteger(thread.version, "thread.version"),
          spendLimitMicros: 0,
          actualSpendMicros: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          attempt: 0,
          maxAttempts: 3,
          recoveryCount: 0,
          checkpointStepSeq: 0,
          sideEffectsCommitted: 0,
          cancelRequestedAt: null,
          cancelRequestedBy: null,
          cancelReason: null,
          error: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          completedAt: null,
        });
        const bound = await trx(AGENT_DELEGATION_TABLE)
          .where({
            id: grant.id,
            workspaceId: parent.workspaceId,
            projectId,
            parentRunId: parent.id,
            parentStepId: delegationStepId,
            revision: grant.revision,
          })
          .whereNull("boundRunId")
          .update({
            boundRunId: childRunId,
            taskVersion: delegationContract.taskVersion,
            taskJson: JSON.stringify(prepared.task),
            taskHash: prepared.taskHash,
            writeTargets: JSON.stringify(prepared.task.writeTargets),
            taskStatus: "queued",
            resultJson: null,
            resultHash: null,
            resultMessageId: null,
            startedAt: null,
            completedAt: null,
            safeError: null,
            revision: grant.revision + 1,
            updatedAt: now,
          });
        if (affectedRows(bound) !== 1) {
          fail(409, "delegation_grant_bind_conflict", "DelegationGrant 与 child Run 原子绑定失败");
        }
      }

      const parentVersion = safeInteger(parent.version, "parentRun.version");
      const parentUpdated = await trx("o_agent_run")
        .where({
          id: parent.id,
          workspaceId: parent.workspaceId,
          projectId,
          status: "running",
          version: parentVersion,
          leaseOwner: workerId,
          attempt,
        })
        .update({
          status: "waiting_delegation",
          waitType: "delegation",
          waitRef: delegationStepId,
          wakeAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          checkpointStepSeq: stepSeq,
          version: parentVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(parentUpdated) !== 1) {
        fail(409, "delegation_parent_lease_lost", "暂停父 Run 时执行租约已变化");
      }
      const threadVersion = safeInteger(thread.version, "thread.version");
      const eventSeqBase = safeInteger(thread.eventSeq, "thread.eventSeq");
      const threadUpdated = await trx("o_agent_thread")
        .where({
          id: thread.id,
          workspaceId: parent.workspaceId,
          projectId,
          status: "active",
          activeRootRunId: parent.id,
          version: threadVersion,
        })
        .update({
          messageSeq: messageSeqBase + preparedTasks.length,
          eventSeq: eventSeqBase + preparedTasks.length + 2,
          version: threadVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(threadUpdated) !== 1) {
        fail(409, "delegation_thread_conflict", "更新 Thread 序列时发生并发冲突");
      }

      await this.eventAppender(trx, {
        workspaceId: parent.workspaceId,
        projectId,
        threadId: parent.threadId,
        runId: parent.id,
        stepId: delegationStepId,
        seq: eventSeqBase + 1,
        type: "step.started",
        payload: {
          step: toAgentStepDto(mapAgentStep({
            id: delegationStepId,
            workspaceId: parent.workspaceId,
            projectId,
            threadId: parent.threadId,
            runId: parent.id,
            parentStepId: modelStepId,
            seq: stepSeq,
            agentRole: "main",
            kind: "delegation",
            status: "waiting_external",
            toolName: "agent.delegate",
            argumentsDigest: modelCall.callHash,
            inputRefs: [],
            outputRefs: [receipt],
            idempotencyKey,
            resolvedModel: null,
            provider: null,
            usage: {},
            costMicros: 0,
            errorCategory: null,
            safeError: null,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            completedAt: null,
          })),
        },
        createdAt: now,
      });
      for (let index = 0; index < childRunIds.length; index += 1) {
        await this.eventAppender(trx, {
          workspaceId: parent.workspaceId,
          projectId,
          threadId: parent.threadId,
          runId: childRunIds[index],
          messageId: triggerMessageIds[index],
          stepId: delegationStepId,
          seq: eventSeqBase + index + 2,
          type: "internal.run.queued",
          payload: {
            runId: childRunIds[index],
            status: "queued",
            agentRole: preparedTasks[index].task.role,
            parentRunId: parent.id,
          },
          createdAt: now,
        });
      }
      await this.eventAppender(trx, {
        workspaceId: parent.workspaceId,
        projectId,
        threadId: parent.threadId,
        runId: parent.id,
        stepId: delegationStepId,
        seq: eventSeqBase + preparedTasks.length + 2,
        type: "run.status",
        payload: {
          runId: parent.id,
          status: "waiting_delegation",
          waitType: "delegation",
          waitRef: delegationStepId,
        },
        createdAt: now,
      });
      return { ...receipt, replayed: false };
    });
  }

  private async replayInTransaction(
    trx: Knex.Transaction,
    parent: RawParentRun,
    step: Record<string, unknown>,
    modelTasks: readonly AgentDelegateTaskInput[],
    contract: AgentDelegateContract,
  ): Promise<AgentDelegationCoordinatorReceipt> {
    if (String(parent.status) !== "waiting_delegation"
      || String(parent.waitType) !== "delegation"
      || String(parent.waitRef || "") !== String(step.id)
      || parent.leaseOwner != null
      || parent.leaseExpiresAt != null
      || parent.heartbeatAt != null
      || String(step.status) !== "waiting_external"
      || String(step.toolName) !== "agent.delegate") {
      fail(409, "delegation_replay_corrupt", "父 Run 与 Delegation Step 重放绑定无效");
    }
    const outputRefs = parseJson(step.outputRefs, "delegationStep.outputRefs");
    if (!Array.isArray(outputRefs) || outputRefs.length !== 1) {
      fail(409, "delegation_replay_corrupt", "Delegation Step receipt 缺失");
    }
    const parsedReceipt = agentDelegateWaitingOutputSchema.safeParse(outputRefs[0]);
    if (!parsedReceipt.success
      || parsedReceipt.data.delegationStepId !== String(step.id)
      || parsedReceipt.data.acceptedTaskCount !== modelTasks.length) {
      fail(409, "delegation_replay_corrupt", "Delegation Step receipt 无效");
    }
    const receipt = parsedReceipt.data;
    const projectId = safeInteger(parent.projectId, "parentRun.projectId", { min: 1 });
    const thread = await trx<RawThread>("o_agent_thread")
      .where({
        id: parent.threadId,
        workspaceId: parent.workspaceId,
        projectId,
        status: "active",
        activeRootRunId: parent.id,
      })
      .first();
    if (!thread) fail(409, "delegation_replay_corrupt", "重放时父 Thread 绑定无效");
    const parentTrigger = await trx("o_agent_message")
      .where({
        id: parent.triggerMessageId,
        runId: parent.id,
        threadId: parent.threadId,
        workspaceId: parent.workspaceId,
        projectId,
      })
      .select("createdBy")
      .first();
    const actorUserId = safeInteger(parentTrigger?.createdBy, "parentTrigger.createdBy", { min: 1 });
    const grants = await trx(AGENT_DELEGATION_TABLE)
      .where({ parentRunId: parent.id, parentStepId: step.id })
      .select("id", "boundRunId", "taskVersion", "taskJson", "taskHash", "writeTargets", "taskStatus");
    if (grants.length !== modelTasks.length) {
      fail(409, "delegation_replay_corrupt", "DelegationGrant 数量与 receipt 不一致");
    }
    const grantByRun = new Map(grants.map((grant) => [String(grant.boundRunId || ""), grant]));
    for (let index = 0; index < receipt.childRunIds.length; index += 1) {
      const childRunId = receipt.childRunIds[index];
      const grantRow = grantByRun.get(childRunId);
      if (!grantRow) fail(409, "delegation_replay_corrupt", "child Run 缺少精确 Grant 绑定");
      const grantId = String(grantRow.id);
      const child = await trx("o_agent_run")
        .where({
          id: childRunId,
          workspaceId: parent.workspaceId,
          projectId,
          threadId: parent.threadId,
          rootRunId: parent.id,
          parentRunId: parent.id,
          delegationId: grantId,
          kind: "delegated",
        })
        .first();
      if (!child || String(child.agentRole) !== modelTasks[index].role) {
        fail(409, "delegation_replay_corrupt", "child Run 角色或父链绑定无效");
      }
      if (!(RUN_STATUSES as readonly string[]).includes(String(child.status))) {
        fail(409, "delegation_replay_corrupt", "child Run 状态无效");
      }
      const signedGrant = await this.grantService.getInTransaction(trx, {
        grantId: String(grantId),
        workspaceId: parent.workspaceId,
        projectId,
      });
      if (Number(grantRow.taskVersion) !== contract.taskVersion
        || typeof grantRow.taskHash !== "string"
        || !/^[a-f0-9]{64}$/.test(grantRow.taskHash)
        || !(AGENT_TASK_STATUSES as readonly string[]).includes(String(grantRow.taskStatus))) {
        fail(409, "delegation_replay_corrupt", "持久化 AgentTask 审计字段无效");
      }
      const storedTask = contract.normalizeTask(
        parseJson(grantRow.taskJson, "delegation.taskJson"),
        { expectedProjectId: projectId },
      );
      const taskHash = hashIdempotencyRequest(storedTask);
      const expectedTask = replayExpectedTask(modelTasks[index], storedTask, contract);
      if (taskHash !== grantRow.taskHash
        || hashIdempotencyRequest(expectedTask) !== taskHash
        || canonicalizeIdempotencyRequest(expectedTask)
          !== canonicalizeIdempotencyRequest(storedTask)
        || canonicalizeIdempotencyRequest(parseStoredWriteTargets(grantRow.writeTargets))
          !== canonicalizeIdempotencyRequest(storedTask.writeTargets)
        || signedGrant.actorUserId !== actorUserId
        || signedGrant.boundRunId !== childRunId
        || signedGrant.parentRunId !== parent.id
        || signedGrant.parentStepId !== String(step.id)
        || signedGrant.granteeRole !== expectedTask.role
        || signedGrant.sessionId !== (thread.sessionId == null ? undefined : String(thread.sessionId))
        || signedGrant.purpose !== grantPurpose(expectedTask)
        || signedGrant.objectiveHash !== hashIdempotencyRequest(expectedTask.objective)
        || !exactKeys(
          Object.fromEntries(signedGrant.inputRefs.map((value) => [value, true])),
          grantInputRefs(expectedTask),
        )
        || signedGrant.outputContract !== grantOutputContract(taskHash, contract)
        || canonicalizeIdempotencyRequest(signedGrant.resourceScope)
          !== canonicalizeIdempotencyRequest(deriveResourceScope(expectedTask))
        || canonicalizeIdempotencyRequest(signedGrant.allowedTools)
          !== canonicalizeIdempotencyRequest(contract.getR0ToolIds(expectedTask.role))
        || canonicalizeIdempotencyRequest(signedGrant.limits)
          !== canonicalizeIdempotencyRequest(contract.parentPolicySnapshot.limits)
        || canonicalizeIdempotencyRequest(signedGrant.spend)
          !== canonicalizeIdempotencyRequest(contract.parentPolicySnapshot.spend)) {
        fail(409, "delegation_replay_corrupt", "Grant 与 AgentTask 密码学绑定无效");
      }
      contract.parseChildPolicy(child.policySnapshot, {
        expectedRole: expectedTask.role,
        expectedDelegationId: grantId,
        expectedParentRunId: parent.id,
        expectedParentStepId: String(step.id),
        expectedTaskHash: taskHash,
      });
      const trigger = await trx("o_agent_message")
        .where({
          id: child.triggerMessageId,
          runId: childRunId,
          threadId: parent.threadId,
          workspaceId: parent.workspaceId,
          projectId,
          visibility: "internal",
          status: "completed",
          createdBy: actorUserId,
          role: "user",
          agentRole: expectedTask.role,
        })
        .select("id")
        .first();
      if (!trigger) fail(409, "delegation_replay_corrupt", "child Run trigger Message 绑定无效");
    }
    return { ...receipt, replayed: true };
  }
}
