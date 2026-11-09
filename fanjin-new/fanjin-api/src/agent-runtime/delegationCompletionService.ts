import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import {
  type A4DelegatedAgentRole,
  type AgentTaskResultReview,
  type AgentTaskResultStatus,
  type AnyAgentTask,
  type AnyAgentTaskResult,
} from "@/agent-runtime/delegationContracts";
import {
  type DelegatedAgentTerminalCommitInput,
  type DelegatedAgentTerminalCommitResult,
  type DelegatedAgentTerminalCommitter,
} from "@/agent-runtime/delegatedAgentRunProcessor";
import type { A4DelegatedRunPolicySnapshot } from "@/agent-runtime/delegatedRunPolicy";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { hasValidDelegationModelCheckpointFields } from "@/agent-runtime/delegationModelCheckpoint";
import { appendAgentEvent, type AppendAgentEventInput } from "@/agent-runtime/eventStore";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  AGENT_MAIN_PROMPT_KEY,
  resolveAgentRuntimeConfigSnapshot,
} from "@/agent-runtime/runtimeConfigRegistry";
import type {
  DelegatedRecoveryHandler,
  DelegatedRecoveryOutcome,
} from "@/agent-runtime/knexRunLeaseRepository";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import type { AgentContentPart } from "@/agent-runtime/types";
import {
  normalizeA4ReviewReport,
  type A4ReviewReport,
} from "@/agent-runtime/reviewReportContracts";
import { A4ReviewReportService } from "@/agent-runtime/reviewReportService";
import {
  AGENT_DELEGATION_COMPACT_LIMITS,
  agentDelegateWaitingOutputSchema,
  getAgentDelegateContractForPromptVersion,
  parseAgentDelegateInputForPromptVersion,
  type AgentDelegateContract,
  type AnyAgentDelegationCompactResult,
} from "@/agent-runtime/tools/packages/delegation";

const TERMINAL_TASK_STATUSES = ["succeeded", "needs_input", "failed", "cancelled"] as const;
const TERMINAL_CHILD_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const RESULT_STEP_KEY_PREFIX = "agent-delegated-result";
const REVIEW_REPORT_STEP_KEY_PREFIX = "agent-review-report";
const RESULT_REF = "delegated_task_result";
const REVIEW_REPORT_REF = "review_report";
const MODEL_RESULT_REF = "model_turn_result";
const MODEL_DISPATCH_REF = "model_dispatch_state";
const DELEGATED_MODEL_RESULT_REF = "delegated_model_turn_result";
const MAX_INTERNAL_MESSAGE_BYTES = 131_072;

const CANCELLED_ERROR = Object.freeze({
  code: "run_cancelled",
  message: "Agent 运行已取消",
});

const DELEGATED_CANCELLED_ERROR = Object.freeze({
  code: "run_cancelled",
  message: "专项 Agent 运行已取消",
});

const UNCERTAIN_ERROR = Object.freeze({
  code: "delegated_model_outcome_uncertain",
  message: "专项模型请求发出后未能安全保存结果，已禁止自动重试",
});

const MAX_ATTEMPTS_ERROR = Object.freeze({
  code: "delegated_max_attempts_exhausted",
  message: "专项 Agent 恢复次数已用尽",
});

const GRANT_UNAVAILABLE_ERROR = Object.freeze({
  code: "delegation_grant_unavailable",
  message: "专项 Agent 授权已失效",
});

const SAFE_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;

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
  checkpointStepSeq: number | string;
  sideEffectsCommitted: number | string | boolean;
  leaseOwner: string | null;
  leaseExpiresAt: number | string | null;
  heartbeatAt: number | string | null;
  attempt: number | string;
  maxAttempts: number | string;
  recoveryCount: number | string;
  error: unknown;
  version: number | string;
  completedAt: number | string | null;
}

interface RawGrant extends Record<string, unknown> {
  id: string;
  status: string;
  actorUserId: number | string;
  workspaceId: string;
  projectId: number | string;
  parentRunId: string;
  parentStepId: string;
  boundRunId: string | null;
  granteeRole: string;
  expiresAt: number | string;
  revokedAt: number | string | null;
  revokedBy: number | string | null;
  revision: number | string;
  taskVersion: number | string | null;
  taskJson: unknown;
  taskHash: string | null;
  taskStatus: string | null;
  resultJson: unknown;
  resultHash: string | null;
  resultMessageId: string | null;
  startedAt: number | string | null;
  completedAt: number | string | null;
  safeError: unknown;
}

interface RawStep extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  runId: string;
  parentStepId: string | null;
  seq: number | string;
  agentRole: string;
  kind: string;
  status: string;
  toolName: string | null;
  argumentsDigest: string | null;
  inputRefs: unknown;
  outputRefs: unknown;
  idempotencyKey: string | null;
  resolvedModel: string | null;
  provider: string | null;
  usage: unknown;
  costMicros: number | string | null;
  errorCategory: string | null;
  safeError: unknown;
  createdAt: number | string;
  updatedAt: number | string;
  startedAt: number | string | null;
  completedAt: number | string | null;
}

interface RawThread extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  projectId: number | string;
  status: string;
  activeRootRunId: string | null;
  messageSeq: number | string;
  eventSeq: number | string;
  lastMessageAt: number | string | null;
  version: number | string;
}

interface RawMessage extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  runId: string | null;
  replyToId: string | null;
  seq: number | string;
  role: string;
  agentRole: string | null;
  visibility: string;
  status: string;
  content: unknown;
  createdBy: number | string | null;
  error: unknown;
}

interface FamilyHint {
  rootRunId: string;
  parentStepId: string;
  childRunIds: string[];
  currentRunId: string;
  currentGrantId: string;
}

interface LockedFamily {
  root: RawRun;
  children: RawRun[];
  childById: Map<string, RawRun>;
  childPolicyById: Map<string, A4DelegatedRunPolicySnapshot>;
  grants: RawGrant[];
  grantByRunId: Map<string, RawGrant>;
  delegationStep: RawStep;
  modelStep: RawStep;
  childSteps: RawStep[];
  thread: RawThread;
  receiptChildRunIds: string[];
  delegationContract: AgentDelegateContract;
}

interface ParentModelCheckpoint {
  result: Record<string, unknown>;
  callId: string;
  toolResults: unknown[];
}

interface PendingEvent {
  runId?: string | null;
  messageId?: string | null;
  stepId?: string | null;
  type: string;
  payload: Record<string, unknown>;
}

interface TerminalCommand {
  runId: string;
  responseMessageId: string | null;
  resultStepId: string;
  task: AnyAgentTask;
  taskHash: string;
  result: AnyAgentTaskResult;
  resultHash: string;
  messageContent: AgentContentPart[];
  reviewReport: A4ReviewReport | null;
  safeError: { code: string; message: string } | null;
  source: "processor" | "recovery";
  workerId?: string;
  attempt?: number;
  knownModelResultStepId?: string | null;
  expectedRecoveryStatus?: "running" | "cancelling" | "queued";
  closeRunningModelSteps?: "failed" | "cancelled" | "uncertain" | null;
  closeStepError?: { code: string; message: string } | null;
  recoveryCount?: number;
}

export interface DelegationCompletionServiceOptions {
  database: Knex;
  clock?: () => number;
  stepIdFactory?: () => string;
  messageIdFactory?: () => string;
  eventAppender?: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
  reviewReportSink?: Pick<A4ReviewReportService, "appendInTransaction">;
}

export interface RecoverExpiredDelegatedRunInput {
  runId: string;
  now: number;
  maxAttempts: number;
}

export type RecoverExpiredDelegatedRunResult = {
  status: "requeued" | "failed" | "cancelled";
  runId: string;
} | null;

function fail(code: string, message: string, status = 409): never {
  throw new AgentRuntimeError(status, code, message);
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.length;
  return Number(value || 0);
}

function cleanId(value: unknown, field: string): string {
  if (typeof value !== "string") fail("delegation_completion_input_invalid", `${field} 格式无效`, 400);
  const id = value.trim();
  if (!id || id.length > 200 || !SAFE_ID_PATTERN.test(id)) {
    fail("delegation_completion_input_invalid", `${field} 格式无效`, 400);
  }
  return id;
}

function safeInteger(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; status?: number } = {},
): number {
  const number = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail("delegation_completion_record_invalid", `${field} 不是安全整数`, options.status ?? 409);
  }
  return number;
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    fail("delegation_completion_record_invalid", `${field} 无法解析`);
  }
}

function parseArray(value: unknown, field: string): unknown[] {
  const parsed = parseJson(value, field);
  if (!Array.isArray(parsed)) fail("delegation_completion_record_invalid", `${field} 必须是数组`);
  return parsed;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function terminalRunStatus(status: AgentTaskResultStatus): "succeeded" | "failed" | "cancelled" {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "succeeded";
}

function terminalMessageStatus(status: AgentTaskResultStatus): "completed" | "error" | "stopped" {
  if (status === "failed") return "error";
  if (status === "cancelled") return "stopped";
  return "completed";
}

function processResult(
  status: AgentTaskResultStatus,
  runId: string,
  responseMessageId: string,
): DelegatedAgentTerminalCommitResult {
  return { status, runId, responseMessageId };
}

function resultStepKey(runId: string): string {
  return `${RESULT_STEP_KEY_PREFIX}:${runId}`;
}

function reviewReportStepKey(runId: string): string {
  return `${REVIEW_REPORT_STEP_KEY_PREFIX}:${hashIdempotencyRequest({ runId })}`;
}

function dispatchState(step: Pick<RawStep, "inputRefs">): "prepared" | "dispatched" | null {
  const ref = parseArray(step.inputRefs, "modelStep.inputRefs")
    .find((item) => item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).type === MODEL_DISPATCH_REF) as Record<string, unknown> | undefined;
  return ref?.value === "prepared" || ref?.value === "dispatched" ? ref.value : null;
}

function resolveRootDelegationContract(root: RawRun): AgentDelegateContract {
  const parsed = parseJson(root.policySnapshot, "root.policySnapshot");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("delegation_parent_policy_invalid", "父 Run 缺少固定委派策略快照");
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
    || policy.phase !== "A4-delegation") {
    fail("delegation_parent_policy_invalid", "父 Run 固定委派策略快照无效");
  }
  let resolved: ReturnType<typeof resolveAgentRuntimeConfigSnapshot>;
  try {
    resolved = resolveAgentRuntimeConfigSnapshot(policy.agentConfig, "main");
  } catch {
    fail("delegation_parent_policy_invalid", "父 Run 的 main Agent 配置快照无效");
  }
  const contract = getAgentDelegateContractForPromptVersion(resolved.prompt.version);
  if (resolved.prompt.key !== AGENT_MAIN_PROMPT_KEY
    || !contract
    || !resolved.execution.enabled
    || policy.modelAlias !== resolved.execution.modelAlias
    || !resolved.modelProfile.capabilities.includes("tools")
    || hashIdempotencyRequest(policy.delegation)
      !== hashIdempotencyRequest(contract.parentPolicySnapshot)) {
    fail("delegation_parent_policy_invalid", "父 Run 未固定到受支持的委派契约");
  }
  return contract;
}

function parseParentModelCheckpoint(
  step: RawStep,
  contract: AgentDelegateContract,
): ParentModelCheckpoint {
  if (step.kind !== "model" || step.status !== "succeeded") {
    fail("delegation_parent_model_step_invalid", "父模型 Step 不是已成功的委派检查点");
  }
  const refs = parseArray(step.outputRefs, "parentModelStep.outputRefs");
  if (refs.length !== 1 || !refs[0] || typeof refs[0] !== "object" || Array.isArray(refs[0])) {
    fail("delegation_parent_model_step_invalid", "父模型 Step 检查点格式无效");
  }
  const result = refs[0] as Record<string, unknown>;
  if (!hasValidDelegationModelCheckpointFields(result)
    || result.type !== MODEL_RESULT_REF
    || result.outcome !== "tool_calls"
    || !Number.isSafeInteger(Number(result.turn))
    || Number(result.turn) <= 0
    || typeof result.assistantText !== "string"
    || !Array.isArray(result.content)
    || result.content.length !== 0
    || result.approvalId !== null
    || !Array.isArray(result.calls)
    || result.calls.length !== 1
    || !Array.isArray(result.toolResults)
    || result.toolResults.length > 1) {
    fail("delegation_parent_model_step_invalid", "父模型 Step 不是唯一 agent.delegate 检查点");
  }
  const call = result.calls[0];
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    fail("delegation_parent_model_step_invalid", "agent.delegate 调用格式无效");
  }
  const callRecord = call as Record<string, unknown>;
  const delegateInput = parseAgentDelegateInputForPromptVersion(
    contract.promptVersion,
    callRecord.arguments,
  );
  if (!exactKeys(callRecord, ["arguments", "id", "name"])
    || callRecord.name !== "agent.delegate"
    || !delegateInput) {
    fail("delegation_parent_model_step_invalid", "agent.delegate 调用绑定无效");
  }
  return {
    result,
    callId: cleanId(callRecord.id, "parentModelStep.callId"),
    toolResults: result.toolResults as unknown[],
  };
}

function parseStoredTask(
  grant: RawGrant,
  projectId: number,
  contract: AgentDelegateContract,
): AnyAgentTask {
  if (Number(grant.taskVersion) !== contract.taskVersion || typeof grant.taskHash !== "string") {
    fail("delegation_task_checkpoint_invalid", "AgentTask 检查点不完整");
  }
  let task: AnyAgentTask;
  try {
    task = contract.normalizeTask(
      parseJson(grant.taskJson, "grant.taskJson"),
      { expectedProjectId: projectId },
    );
  } catch {
    fail("delegation_task_checkpoint_invalid", "AgentTask 检查点格式无效");
  }
  if (task.role !== grant.granteeRole || hashIdempotencyRequest(task) !== grant.taskHash) {
    fail("delegation_task_checkpoint_invalid", "AgentTask 与 Grant 绑定无效");
  }
  return task;
}

function parseStoredResult(
  grant: RawGrant,
  contract: AgentDelegateContract,
): AnyAgentTaskResult | null {
  if (grant.resultJson == null) return null;
  try {
    return contract.normalizeResult(parseJson(grant.resultJson, "grant.resultJson"));
  } catch {
    fail("delegation_result_checkpoint_invalid", "AgentTaskResult 检查点格式无效");
  }
}

function resultReview(result: AnyAgentTaskResult): AgentTaskResultReview | undefined {
  return "review" in result ? result.review : undefined;
}

function parseChildPolicy(
  contract: AgentDelegateContract,
  value: unknown,
  options: {
    expectedRole: A4DelegatedAgentRole;
    expectedDelegationId: string;
    expectedParentRunId: string;
    expectedParentStepId: string;
    expectedTaskHash: string;
  },
): A4DelegatedRunPolicySnapshot {
  const parse = contract.parseChildPolicy as (
    policy: unknown,
    expected: typeof options,
  ) => A4DelegatedRunPolicySnapshot;
  return parse(value, options);
}

function validateArtifactBinding(result: AnyAgentTaskResult, responseMessageId: string): void {
  const exactSucceededArtifact = result.artifactRefs.length === 1
    && result.artifactRefs[0].type === "message"
    && result.artifactRefs[0].id === responseMessageId
    && result.artifactRefs[0].version === null;
  if ((result.status === "succeeded" && !exactSucceededArtifact)
    || (result.status !== "succeeded" && result.artifactRefs.length !== 0)) {
    fail("delegation_result_artifact_invalid", "AgentTaskResult artifactRefs 与 internal Message 绑定无效");
  }
}

function assertTaskResultRoleBinding(
  task: AnyAgentTask,
  result: AnyAgentTaskResult,
  source: "input" | "persisted" = "persisted",
): void {
  const review = resultReview(result);
  const valid = task.role === "reviewer"
    ? (result.status === "succeeded" ? review !== undefined : review === undefined)
    : review === undefined;
  if (!valid) {
    fail(
      source === "input" ? "delegation_terminal_input_invalid" : "delegation_result_role_binding_invalid",
      "AgentTaskResult review 摘要与专项角色或终态不一致",
      source === "input" ? 400 : 409,
    );
  }
}

function validateMessageContent(status: AgentTaskResultStatus, value: AgentContentPart[]): AgentContentPart[] {
  if (!Array.isArray(value)) fail("delegation_terminal_input_invalid", "专项结果消息格式无效", 400);
  const content = value.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      fail("delegation_terminal_input_invalid", "专项结果消息格式无效", 400);
    }
    const record = part as Record<string, unknown>;
    if (!exactKeys(record, ["text", "type"])
      || record.type !== "text"
      || typeof record.text !== "string"
      || !record.text.trim()) {
      fail("delegation_terminal_input_invalid", "专项结果消息只能包含非空文本", 400);
    }
    return { type: "text", text: record.text };
  });
  if ((status === "succeeded" && content.length !== 1)
    || (status === "needs_input" && content.length !== 1)
    || ((status === "failed" || status === "cancelled") && content.length !== 0)
    || Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_INTERNAL_MESSAGE_BYTES) {
    fail("delegation_terminal_input_invalid", "专项结果消息与终态不一致", 400);
  }
  return content;
}

function parseReviewReportMessage(
  content: readonly AgentContentPart[],
  projectId: number,
  source: "input" | "persisted",
): A4ReviewReport {
  const invalid = (): never => {
    if (source === "input") {
      fail("delegation_terminal_input_invalid", "Reviewer internal Message 与报告绑定无效", 400);
    }
    fail("delegation_result_message_invalid", "持久化 Reviewer internal Message 与报告绑定无效");
  };
  if (content.length !== 1
    || !content[0]
    || typeof content[0] !== "object"
    || Array.isArray(content[0])) return invalid();
  const part = content[0] as unknown as Record<string, unknown>;
  if (!exactKeys(part, ["text", "type"])
    || part.type !== "text"
    || typeof part.text !== "string"
    || !part.text.trim()) return invalid();
  try {
    return normalizeA4ReviewReport(JSON.parse(part.text), { expectedProjectId: projectId });
  } catch {
    return invalid();
  }
}

function parsePersistedMessageContent(value: unknown): AgentContentPart[] {
  const parsed = parseJson(value, "response.content");
  if (!Array.isArray(parsed)) {
    fail("delegation_result_message_invalid", "持久化专项 internal Message 格式无效");
  }
  return parsed as AgentContentPart[];
}

function sameReviewReport(left: A4ReviewReport, right: A4ReviewReport): boolean {
  return left.canonicalHash === right.canonicalHash
    && hashIdempotencyRequest(left) === hashIdempotencyRequest(right);
}

function normalizeTerminalInput(
  input: DelegatedAgentTerminalCommitInput,
  contract: AgentDelegateContract,
): TerminalCommand {
  let task: AnyAgentTask;
  let result: AnyAgentTaskResult;
  try {
    task = contract.normalizeTask(input.task, { expectedProjectId: input.run.projectId });
    result = contract.normalizeResult(input.result);
  } catch {
    fail("delegation_terminal_input_invalid", "专项任务终态输入格式无效", 400);
  }
  const responseMessageId = cleanId(input.responseMessageId, "responseMessageId");
  const messageContent = validateMessageContent(result.status, input.messageContent);
  assertTaskResultRoleBinding(task, result, "input");
  let reviewReport: A4ReviewReport | null = null;
  const review = resultReview(result);
  if (task.role === "reviewer" && result.status === "succeeded") {
    if (input.reviewReport == null || review === undefined) {
      fail("delegation_terminal_input_invalid", "Reviewer 成功终态缺少完整报告", 400);
    }
    try {
      reviewReport = normalizeA4ReviewReport(input.reviewReport, { expectedProjectId: input.run.projectId });
    } catch {
      fail("delegation_terminal_input_invalid", "Reviewer 完整报告格式无效", 400);
    }
    const messageReport = parseReviewReportMessage(messageContent, input.run.projectId, "input");
    if (reviewReport.canonicalHash !== review.reportDigest
      || reviewReport.overall.verdict !== review.verdict
      || !sameReviewReport(reviewReport, messageReport)) {
      fail("delegation_terminal_input_invalid", "Reviewer 报告、摘要与 internal Message 绑定无效", 400);
    }
  } else if (input.reviewReport !== null) {
    fail("delegation_terminal_input_invalid", "非 Reviewer 成功终态不得携带完整审核报告", 400);
  }
  if (task.role !== input.run.agentRole
    || task.projectId !== input.run.projectId
    || hashIdempotencyRequest(task) !== input.taskHash
    || hashIdempotencyRequest(result) !== input.resultHash
    || input.claimedRun.id !== input.run.id
    || input.claimedRun.leaseOwner !== input.workerId
    || ((result.status === "failed" || result.status === "cancelled") && !input.safeError)
    || ((result.status === "succeeded" || result.status === "needs_input") && input.safeError !== null)) {
    fail("delegation_terminal_input_invalid", "专项任务终态输入绑定无效", 400);
  }
  validateArtifactBinding(result, responseMessageId);
  return {
    runId: cleanId(input.run.id, "run.id"),
    responseMessageId,
    resultStepId: cleanId(input.resultStepId, "resultStepId"),
    task,
    taskHash: input.taskHash,
    result,
    resultHash: input.resultHash,
    messageContent,
    reviewReport,
    safeError: input.safeError,
    source: "processor",
    workerId: cleanId(input.workerId, "workerId"),
    attempt: safeInteger(input.claimedRun.attempt, "claimedRun.attempt", { min: 1, status: 400 }),
    knownModelResultStepId: input.knownModelResultStepId,
  };
}

function compactResult(
  child: RawRun,
  task: AnyAgentTask,
  result: AnyAgentTaskResult,
  responseMessageId: string,
  contract: AgentDelegateContract,
): AnyAgentDelegationCompactResult {
  const review = resultReview(result);
  return contract.compactResultSchema.parse({
    childRunId: child.id,
    role: task.role,
    taskType: task.taskType,
    status: result.status,
    summary: truncateCompactText(result.summary, AGENT_DELEGATION_COMPACT_LIMITS.summaryCharacters),
    assumptions: compactTextList(result.assumptions),
    issues: compactTextList(result.issues),
    suggestedNextActions: compactTextList(result.suggestedNextActions),
    artifactRefs: result.artifactRefs,
    internalMessageRef: { type: "message", id: responseMessageId, version: null },
    ...(review === undefined ? {} : { review }),
  });
}

function truncateCompactText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  let end = maxCharacters;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return value.slice(0, end).trimEnd();
}

function compactTextList(values: readonly string[]): string[] {
  return values
    .slice(0, AGENT_DELEGATION_COMPACT_LIMITS.listItems)
    .map((value) => truncateCompactText(value, AGENT_DELEGATION_COMPACT_LIMITS.listItemCharacters));
}

function parseDelegatedUsage(steps: readonly RawStep[]): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const step of steps.filter((candidate) => candidate.kind === "model" && candidate.status === "succeeded")) {
    const ref = parseArray(step.outputRefs, "delegatedModelStep.outputRefs")
      .find((item) => item && typeof item === "object" && !Array.isArray(item)
        && (item as Record<string, unknown>).type === DELEGATED_MODEL_RESULT_REF) as Record<string, unknown> | undefined;
    if (!ref || !ref.usage || typeof ref.usage !== "object" || Array.isArray(ref.usage)) {
      fail("delegation_model_checkpoint_invalid", "专项模型 usage 检查点无效");
    }
    const usage = ref.usage as Record<string, unknown>;
    const nextInput = inputTokens + safeInteger(usage.inputTokens, "usage.inputTokens");
    const nextOutput = outputTokens + safeInteger(usage.outputTokens, "usage.outputTokens");
    inputTokens = safeInteger(nextInput, "usage.totalInputTokens");
    outputTokens = safeInteger(nextOutput, "usage.totalOutputTokens");
  }
  return { inputTokens, outputTokens };
}

export class DelegationCompletionService implements DelegatedAgentTerminalCommitter {
  private readonly database: Knex;
  private readonly clock: () => number;
  private readonly stepIdFactory: () => string;
  private readonly messageIdFactory: () => string;
  private readonly eventAppender: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
  private readonly reviewReportSink: Pick<A4ReviewReportService, "appendInTransaction">;

  constructor(options: DelegationCompletionServiceOptions) {
    this.database = options.database;
    this.clock = options.clock ?? Date.now;
    this.stepIdFactory = options.stepIdFactory ?? randomUUID;
    this.messageIdFactory = options.messageIdFactory ?? randomUUID;
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
    this.reviewReportSink = options.reviewReportSink ?? new A4ReviewReportService(options.database);
  }

  /**
   * Thin lease-repository adapter. Only the candidate id is used as a scan
   * hint; recoverExpiredRun performs the authoritative root-first re-read.
   */
  readonly delegatedRecoveryHandler: DelegatedRecoveryHandler = async ({ candidate, recovery }) => {
    const outcome = await this.recoverExpiredRun({
      runId: candidate.runId,
      now: recovery.now,
      maxAttempts: recovery.maxAttempts,
    });
    return outcome ? ({ status: outcome.status } satisfies Exclude<DelegatedRecoveryOutcome, null>) : null;
  };

  async commit(input: DelegatedAgentTerminalCommitInput): Promise<DelegatedAgentTerminalCommitResult> {
    const inputRunId = cleanId(input.run.id, "run.id");
    const hint = await this.familyHintForDelegation(input.run.delegationId, inputRunId);
    if (!hint
      || hint.rootRunId !== input.run.rootRunId
      || hint.rootRunId !== input.run.parentRunId) {
      return { status: "lease_lost", runId: input.run.id, responseMessageId: input.responseMessageId };
    }
    return this.database.transaction(async (trx) => {
      const family = await this.lockFamily(trx, hint);
      const now = this.clock();
      if (!family) {
        return { status: "lease_lost", runId: input.run.id, responseMessageId: input.responseMessageId };
      }
      // The locked root Prompt selects the only accepted persistence version.
      // Never select a normalizer from the processor-supplied task/result version.
      const command = normalizeTerminalInput(input, family.delegationContract);
      const child = family.childById.get(command.runId);
      const grant = family.grantByRunId.get(command.runId);
      if (!child || !grant
        || family.root.workspaceId !== input.run.workspaceId
        || Number(family.root.projectId) !== input.run.projectId
        || family.root.threadId !== input.run.threadId
        || child.agentRole !== input.run.agentRole
        || child.delegationId !== input.run.delegationId) {
        return { status: "lease_lost", runId: input.run.id, responseMessageId: input.responseMessageId };
      }

      const replay = await this.exactTerminalReplay(trx, family, child, grant, command);
      if (replay) {
        const replayEvents: PendingEvent[] = [];
        await this.finalizeParentIfReady(trx, family, now, replayEvents);
        await this.flushThreadAndEvents(trx, family, now, replayEvents, 0, false);
        return replay;
      }

      const uncertainFailure = command.result.status === "failed"
        && command.safeError?.code === UNCERTAIN_ERROR.code;
      const expectedStatuses = command.result.status === "cancelled"
        ? ["cancelling"]
        : uncertainFailure ? ["running", "cancelling"] : ["running"];
      if (!expectedStatuses.includes(child.status)
        || child.leaseOwner !== command.workerId
        || Number(child.attempt) !== command.attempt
        || Number(child.leaseExpiresAt || 0) <= now) {
        return { status: "lease_lost", runId: child.id, responseMessageId: command.responseMessageId };
      }

      const runningModelSteps = family.childSteps
        .filter((step) => step.runId === child.id && step.kind === "model" && step.status === "running");
      if (command.result.status === "cancelled") {
        const unsafe = runningModelSteps.some((step) => (
          dispatchState(step) === "dispatched" && step.id !== command.knownModelResultStepId
        ));
        if (unsafe) return { status: "lease_lost", runId: child.id, responseMessageId: command.responseMessageId };
        command.closeRunningModelSteps = "cancelled";
        command.closeStepError = DELEGATED_CANCELLED_ERROR;
      } else if (uncertainFailure) {
        command.closeRunningModelSteps = "uncertain";
        command.closeStepError = UNCERTAIN_ERROR;
      } else if (runningModelSteps.length > 0) {
        fail("delegation_model_checkpoint_invalid", "专项模型仍存在未完成检查点");
      }

      const events: PendingEvent[] = [];
      await this.commitReviewReport(trx, family, child, command, now, events);
      await this.commitChildTerminal(trx, family, child, grant, command, now, events);
      await this.finalizeParentIfReady(trx, family, now, events);
      await this.flushThreadAndEvents(trx, family, now, events, 0, false);
      return processResult(command.result.status, child.id, command.responseMessageId!);
    });
  }

  /**
   * Root-first delegated recovery entry point. The initial reads are scan hints
   * only; every decision is repeated after the root and complete sibling batch
   * have been locked in the canonical order.
   */
  async recoverExpiredRun(input: RecoverExpiredDelegatedRunInput): Promise<RecoverExpiredDelegatedRunResult> {
    const runId = cleanId(input.runId, "runId");
    const now = safeInteger(input.now, "now", { status: 400 });
    const maxAttempts = safeInteger(input.maxAttempts, "maxAttempts", { min: 1, status: 400 });
    const runHint = await this.database<RawRun>("o_agent_run")
      .where({ id: runId, kind: "delegated" })
      .select("id", "delegationId")
      .first();
    if (!runHint?.delegationId) return null;
    const hint = await this.familyHintForDelegation(String(runHint.delegationId), runId);
    if (!hint) return null;

    return this.database.transaction(async (trx): Promise<RecoverExpiredDelegatedRunResult> => {
      const family = await this.lockFamily(trx, hint);
      if (!family) return null;
      const child = family.childById.get(runId);
      const grant = family.grantByRunId.get(runId);
      if (!child || !grant) return null;
      if ((TERMINAL_CHILD_RUN_STATUSES as readonly string[]).includes(child.status)) {
        return null;
      }

      const attempt = safeInteger(child.attempt, "child.attempt");
      const recoveryCount = safeInteger(child.recoveryCount, "child.recoveryCount");
      const rowMaxAttempts = safeInteger(child.maxAttempts, "child.maxAttempts", { min: 1 });
      const effectiveMaxAttempts = Math.min(maxAttempts, rowMaxAttempts);
      const queuedExhausted = child.status === "queued"
        && recoveryCount > 0
        && recoveryCount >= effectiveMaxAttempts;
      const expiredLease = (child.status === "running" || child.status === "cancelling")
        && child.leaseExpiresAt != null
        && Number(child.leaseExpiresAt) <= now;
      if (!queuedExhausted && !expiredLease) return null;

      if (child.status === "running"
        && !queuedExhausted
        && grant.status !== "revoked"
        && grant.status !== "expired"
        && !(grant.status === "active" && Number(grant.expiresAt) <= now)) {
        const steps = family.childSteps
          .filter((step) => step.runId === child.id && step.kind === "model")
          .sort((left, right) => Number(left.seq) - Number(right.seq));
        const latest = steps.at(-1);
        const dispatched = latest?.status === "uncertain"
          || (latest?.status === "running" && dispatchState(latest) === "dispatched");
        const nextRecoveryCount = recoveryCount + 1;
        if (!dispatched && nextRecoveryCount < effectiveMaxAttempts) {
          const version = safeInteger(child.version, "child.version");
          const updated = await trx("o_agent_run")
            .where({
              id: child.id,
              status: child.status,
              version,
              attempt,
              recoveryCount,
              leaseOwner: child.leaseOwner,
              leaseExpiresAt: child.leaseExpiresAt,
            })
            .andWhere("leaseExpiresAt", "<=", now)
            .update({
              status: "queued",
              recoveryCount: nextRecoveryCount,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              error: null,
              completedAt: null,
              version: version + 1,
              updatedAt: now,
            });
          if (affectedRows(updated) !== 1) return null;
          child.status = "queued";
          child.recoveryCount = nextRecoveryCount;
          child.leaseOwner = null;
          child.leaseExpiresAt = null;
          child.version = version + 1;
          const events: PendingEvent[] = [{
            runId: child.id,
            messageId: child.responseMessageId,
            type: "internal.run.requeued",
            payload: {
              runId: child.id,
              status: "queued",
              reason: "lease_expired",
              attempt,
              recoveryCount: nextRecoveryCount,
              maxAttempts: effectiveMaxAttempts,
              visibility: "internal",
            },
          }];
          await this.flushThreadAndEvents(trx, family, now, events, 0, false);
          return { status: "requeued", runId: child.id };
        }
      }

      const isCancelling = child.status === "cancelling";
      const steps = family.childSteps.filter((step) => step.runId === child.id);
      const latestModel = steps
        .filter((step) => step.kind === "model")
        .sort((left, right) => Number(left.seq) - Number(right.seq))
        .at(-1);
      const dispatched = latestModel?.status === "uncertain"
        || (latestModel?.status === "running" && dispatchState(latestModel) === "dispatched");
      const unavailableGrant = grant.status === "revoked"
        || grant.status === "expired"
        || (grant.status === "active" && Number(grant.expiresAt) <= now);
      const error = isCancelling
        ? DELEGATED_CANCELLED_ERROR
        : dispatched ? UNCERTAIN_ERROR : unavailableGrant ? GRANT_UNAVAILABLE_ERROR : MAX_ATTEMPTS_ERROR;
      const status: AgentTaskResultStatus = isCancelling ? "cancelled" : "failed";
      // A missing response message must be created by commitChildTerminal inside
      // this transaction. Supplying a freshly generated id here would make the
      // commit path treat it as an existing pending checkpoint.
      const responseMessageId = child.responseMessageId;
      const task = parseStoredTask(grant, Number(child.projectId), family.delegationContract);
      const usage = parseDelegatedUsage(steps);
      const policy = family.childPolicyById.get(child.id);
      if (!policy) fail("delegation_family_binding_invalid", "专项 Run 策略检查点缺失");
      const result = family.delegationContract.normalizeResult({
        version: family.delegationContract.resultVersion,
        status,
        artifactRefs: [],
        summary: status === "cancelled" ? DELEGATED_CANCELLED_ERROR.message : "专项 Agent 未能完成结构化提案",
        assumptions: [],
        issues: status === "failed" ? [error.message] : [],
        suggestedNextActions: status === "failed"
          ? ["由父 Agent 根据安全错误决定是否修正输入后重新委派"]
          : [],
        usage: {
          modelProfile: `${policy.agentConfig.modelProfile.key}@${policy.agentConfig.modelProfile.version}`,
          ...usage,
          costMicros: null,
        },
      });
      const command: TerminalCommand = {
        runId: child.id,
        responseMessageId,
        resultStepId: cleanId(this.stepIdFactory(), "stepIdFactory"),
        task,
        taskHash: grant.taskHash!,
        result,
        resultHash: hashIdempotencyRequest(result),
        messageContent: [],
        reviewReport: null,
        safeError: error,
        source: "recovery",
        expectedRecoveryStatus: child.status as "running" | "cancelling" | "queued",
        closeRunningModelSteps: isCancelling ? "cancelled" : dispatched ? "uncertain" : "failed",
        closeStepError: error,
        recoveryCount: queuedExhausted || isCancelling ? recoveryCount : recoveryCount + 1,
      };
      const events: PendingEvent[] = [];
      const messageSeqIncrement = child.responseMessageId == null ? 1 : 0;
      await this.commitChildTerminal(trx, family, child, grant, command, now, events);
      await this.finalizeParentIfReady(trx, family, now, events);
      await this.flushThreadAndEvents(trx, family, now, events, messageSeqIncrement, false);
      return { status: isCancelling ? "cancelled" : "failed", runId: child.id };
    });
  }

  private async familyHintForDelegation(delegationIdInput: string, currentRunIdInput: string): Promise<FamilyHint | null> {
    const delegationId = cleanId(delegationIdInput, "delegationId");
    const currentRunId = cleanId(currentRunIdInput, "currentRunId");
    const current = await this.database<RawGrant>("o_agent_delegation")
      .where({ id: delegationId, boundRunId: currentRunId })
      .select("id", "parentRunId", "parentStepId", "boundRunId")
      .first();
    if (!current?.boundRunId) return null;
    const siblings = await this.database<RawGrant>("o_agent_delegation")
      .where({ parentRunId: current.parentRunId, parentStepId: current.parentStepId })
      .whereNotNull("boundRunId")
      .select("id", "boundRunId")
      .orderBy("boundRunId", "asc");
    const childRunIds = siblings.map((row) => String(row.boundRunId || "")).filter(Boolean);
    if (childRunIds.length < 1 || childRunIds.length > 3 || !childRunIds.includes(currentRunId)) return null;
    return {
      rootRunId: String(current.parentRunId),
      parentStepId: String(current.parentStepId),
      childRunIds,
      currentRunId,
      currentGrantId: delegationId,
    };
  }

  private async lockFamily(trx: Knex.Transaction, hint: FamilyHint): Promise<LockedFamily | null> {
    // Canonical lock order: root -> all children -> all Grants/tasks ->
    // delegation/model/child Steps -> Thread. No method in this service locks
    // a child before its root.
    const root = await trx<RawRun>("o_agent_run").where({ id: hint.rootRunId }).forUpdate().first();
    if (!root || root.kind !== "root" || root.agentRole !== "main"
      || root.rootRunId !== root.id || root.parentRunId != null || root.delegationId != null) return null;
    const delegationContract = resolveRootDelegationContract(root);

    const childIds = [...new Set(hint.childRunIds)].sort();
    const children = await trx<RawRun>("o_agent_run")
      .whereIn("id", childIds)
      .orderBy("id", "asc")
      .forUpdate();
    if (children.length !== childIds.length) return null;

    const grants = await trx<RawGrant>("o_agent_delegation")
      .where({ parentRunId: root.id, parentStepId: hint.parentStepId })
      .whereIn("boundRunId", childIds)
      .orderBy("boundRunId", "asc")
      .forUpdate();
    if (grants.length !== childIds.length) return null;

    const delegationStep = await trx<RawStep>("o_agent_step")
      .where({ id: hint.parentStepId, runId: root.id, kind: "delegation" })
      .forUpdate()
      .first();
    if (!delegationStep?.parentStepId) return null;
    const modelStep = await trx<RawStep>("o_agent_step")
      .where({ id: delegationStep.parentStepId, runId: root.id, kind: "model" })
      .forUpdate()
      .first();
    if (!modelStep) return null;
    const childSteps = await trx<RawStep>("o_agent_step")
      .whereIn("runId", childIds)
      .orderBy("runId", "asc")
      .orderBy("seq", "asc")
      .forUpdate();
    const thread = await trx<RawThread>("o_agent_thread")
      .where({ id: root.threadId, workspaceId: root.workspaceId, projectId: Number(root.projectId) })
      .forUpdate()
      .first();
    if (!thread || thread.status !== "active") return null;

    const receiptRefs = parseArray(delegationStep.outputRefs, "delegationStep.outputRefs");
    if (receiptRefs.length !== 1) fail("delegation_step_checkpoint_invalid", "Delegation Step receipt 无效");
    const receipt = agentDelegateWaitingOutputSchema.safeParse(receiptRefs[0]);
    if (!receipt.success
      || receipt.data.delegationStepId !== delegationStep.id
      || receipt.data.childRunIds.length !== childIds.length
      || [...receipt.data.childRunIds].sort().some((id, index) => id !== childIds[index])) {
      fail("delegation_step_checkpoint_invalid", "Delegation Step receipt 与 child Run 不一致");
    }
    parseParentModelCheckpoint(modelStep, delegationContract);

    const childById = new Map(children.map((child) => [String(child.id), child]));
    const childPolicyById = new Map<string, A4DelegatedRunPolicySnapshot>();
    const grantByRunId = new Map<string, RawGrant>();
    for (const grant of grants) {
      const childId = String(grant.boundRunId || "");
      const child = childById.get(childId);
      if (!child
        || child.workspaceId !== root.workspaceId
        || Number(child.projectId) !== Number(root.projectId)
        || child.threadId !== root.threadId
        || child.rootRunId !== root.id
        || child.parentRunId !== root.id
        || child.kind !== "delegated"
        || child.delegationId !== grant.id
        || child.agentRole !== grant.granteeRole
        || grant.workspaceId !== root.workspaceId
        || Number(grant.projectId) !== Number(root.projectId)
        || grantByRunId.has(childId)) {
        fail("delegation_family_binding_invalid", "父子 Run、Grant 与任务绑定无效");
      }
      const task = parseStoredTask(grant, Number(root.projectId), delegationContract);
      if (!(delegationContract.roles as readonly string[]).includes(task.role)) {
        fail("delegation_family_binding_invalid", "子任务角色超出父 Run 的固定委派契约");
      }
      const childPolicy = parseChildPolicy(delegationContract, child.policySnapshot, {
        expectedRole: task.role,
        expectedDelegationId: grant.id,
        expectedParentRunId: root.id,
        expectedParentStepId: delegationStep.id,
        expectedTaskHash: grant.taskHash!,
      });
      childPolicyById.set(childId, childPolicy);
      grantByRunId.set(childId, grant);
    }
    return {
      root,
      children,
      childById,
      childPolicyById,
      grants,
      grantByRunId,
      delegationStep,
      modelStep,
      childSteps,
      thread,
      receiptChildRunIds: receipt.data.childRunIds,
      delegationContract,
    };
  }

  private async exactTerminalReplay(
    trx: Knex.Transaction,
    family: LockedFamily,
    child: RawRun,
    grant: RawGrant,
    command: TerminalCommand,
  ): Promise<DelegatedAgentTerminalCommitResult | null> {
    if (!(TERMINAL_CHILD_RUN_STATUSES as readonly string[]).includes(child.status)) return null;
    const persisted = parseStoredResult(grant, family.delegationContract);
    if (persisted) assertTaskResultRoleBinding(command.task, persisted);
    const expectedRunStatus = terminalRunStatus(command.result.status);
    const response = await trx<RawMessage>("o_agent_message")
      .where({
        id: command.responseMessageId,
        runId: child.id,
        threadId: child.threadId,
        workspaceId: child.workspaceId,
        projectId: Number(child.projectId),
        role: "assistant",
        agentRole: child.agentRole,
        visibility: "internal",
      })
      .first();
    if (child.status !== expectedRunStatus
      || grant.taskStatus !== command.result.status
      || grant.resultHash !== command.resultHash
      || grant.resultMessageId !== command.responseMessageId
      || !persisted
      || hashIdempotencyRequest(persisted) !== command.resultHash
      || response?.status !== terminalMessageStatus(command.result.status)) {
      return { status: "lease_lost", runId: child.id, responseMessageId: command.responseMessageId };
    }
    validateArtifactBinding(persisted, command.responseMessageId!);
    if (command.reviewReport) {
      const persistedMessageReport = parseReviewReportMessage(
        parsePersistedMessageContent(response.content),
        Number(child.projectId),
        "persisted",
      );
      if (!sameReviewReport(command.reviewReport, persistedMessageReport)) {
        fail("delegation_result_message_invalid", "持久化 Reviewer internal Message 与报告摘要不一致");
      }
      await this.verifyReviewReportReplay(trx, family, child, command);
    }
    if (grant.status === "active") {
      await this.closeGrantForTerminalTask(trx, grant, this.clock());
    }
    return processResult(command.result.status, child.id, command.responseMessageId!);
  }

  private reviewReportSteps(family: LockedFamily, child: RawRun): RawStep[] {
    const key = reviewReportStepKey(child.id);
    return family.childSteps.filter((step) => step.runId === child.id && (
      step.id === key
      || step.idempotencyKey === key
      || step.toolName === "review.report.create"
    ));
  }

  private expectedReviewReportInputRefs(taskHash: string, report: A4ReviewReport): Record<string, unknown>[] {
    return [
      { type: "delegated_task_hash", value: taskHash },
      { type: "review_report_digest", value: report.canonicalHash },
    ];
  }

  private expectedReviewReportOutputRefs(report: A4ReviewReport): Record<string, unknown>[] {
    return [{
      type: REVIEW_REPORT_REF,
      version: report.version,
      canonicalHash: report.canonicalHash,
    }];
  }

  private assertReviewReportStep(
    family: LockedFamily,
    child: RawRun,
    taskHash: string,
    report: A4ReviewReport,
  ): RawStep {
    const key = reviewReportStepKey(child.id);
    const steps = this.reviewReportSteps(family, child);
    if (steps.length !== 1) {
      fail("delegation_review_report_step_invalid", "Reviewer 报告 Tool Step 缺失或重复");
    }
    const step = steps[0];
    if (step.id !== key
      || step.workspaceId !== child.workspaceId
      || Number(step.projectId) !== Number(child.projectId)
      || step.threadId !== child.threadId
      || step.runId !== child.id
      || step.parentStepId !== null
      || step.agentRole !== "reviewer"
      || step.kind !== "tool"
      || step.status !== "succeeded"
      || step.toolName !== "review.report.create"
      || step.argumentsDigest !== report.canonicalHash
      || step.idempotencyKey !== key
      || hashIdempotencyRequest(parseArray(step.inputRefs, "reviewReportStep.inputRefs"))
        !== hashIdempotencyRequest(this.expectedReviewReportInputRefs(taskHash, report))
      || hashIdempotencyRequest(parseArray(step.outputRefs, "reviewReportStep.outputRefs"))
        !== hashIdempotencyRequest(this.expectedReviewReportOutputRefs(report))
      || Number(step.seq) <= 0
      || Number(step.seq) > Number(child.checkpointStepSeq)
      || step.completedAt == null) {
      fail("delegation_review_report_step_invalid", "Reviewer 报告 Tool Step 绑定无效");
    }
    return step;
  }

  private async appendAndValidateReviewReport(
    trx: Knex.Transaction,
    child: RawRun,
    step: RawStep,
    report: A4ReviewReport,
  ): Promise<void> {
    const stored = await this.reviewReportSink.appendInTransaction(trx, {
      workspaceId: child.workspaceId,
      projectId: Number(child.projectId),
      reviewerRunId: child.id,
      reviewerStepId: step.id,
      report,
    });
    if (!stored
      || stored.workspaceId !== child.workspaceId
      || stored.projectId !== Number(child.projectId)
      || stored.reviewerRunId !== child.id
      || stored.reviewerStepId !== step.id
      || !sameReviewReport(stored.report, report)) {
      fail("delegation_review_report_record_invalid", "Reviewer append-only 报告绑定无效");
    }
  }

  private async verifyReviewReportReplay(
    trx: Knex.Transaction,
    family: LockedFamily,
    child: RawRun,
    command: TerminalCommand,
  ): Promise<void> {
    const step = this.assertReviewReportStep(family, child, command.taskHash, command.reviewReport!);
    await this.appendAndValidateReviewReport(trx, child, step, command.reviewReport!);
  }

  private async verifyPersistedReviewerResult(
    trx: Knex.Transaction,
    family: LockedFamily,
    child: RawRun,
    grant: RawGrant,
    task: AnyAgentTask,
    result: AnyAgentTaskResult,
    response: RawMessage,
  ): Promise<void> {
    assertTaskResultRoleBinding(task, result);
    if (task.role !== child.agentRole) {
      fail("delegation_result_role_binding_invalid", "AgentTask 角色与 child Run 不一致");
    }
    if (task.role !== "reviewer" || result.status !== "succeeded") return;
    const report = parseReviewReportMessage(
      parsePersistedMessageContent(response.content),
      Number(child.projectId),
      "persisted",
    );
    const review = resultReview(result);
    if (!review
      || review.reportDigest !== report.canonicalHash
      || review.verdict !== report.overall.verdict) {
      fail("delegation_review_report_record_invalid", "Reviewer 报告与持久化结果摘要不一致");
    }
    const taskHash = typeof grant.taskHash === "string"
      ? grant.taskHash
      : fail("delegation_task_checkpoint_invalid", "Reviewer AgentTask hash 缺失");
    const step = this.assertReviewReportStep(family, child, taskHash, report);
    await this.appendAndValidateReviewReport(trx, child, step, report);
  }

  private async commitReviewReport(
    trx: Knex.Transaction,
    family: LockedFamily,
    child: RawRun,
    command: TerminalCommand,
    now: number,
    events: PendingEvent[],
  ): Promise<void> {
    if (!command.reviewReport) return;
    if (child.agentRole !== "reviewer" || child.status !== "running" || this.reviewReportSteps(family, child).length !== 0) {
      fail("delegation_review_report_step_invalid", "Reviewer 报告 Tool Step 初始状态无效");
    }
    const stepId = reviewReportStepKey(child.id);
    if (command.resultStepId === stepId) {
      fail("delegation_review_report_step_invalid", "Reviewer 报告与结果 Step 标识冲突");
    }
    const maxSeq = family.childSteps
      .filter((step) => step.runId === child.id)
      .reduce((max, step) => Math.max(max, Number(step.seq)), Number(child.checkpointStepSeq || 0));
    const step: RawStep = {
      id: stepId,
      workspaceId: child.workspaceId,
      projectId: Number(child.projectId),
      threadId: child.threadId,
      runId: child.id,
      parentStepId: null,
      seq: maxSeq + 1,
      agentRole: "reviewer",
      kind: "tool",
      status: "running",
      toolName: "review.report.create",
      argumentsDigest: command.reviewReport.canonicalHash,
      inputRefs: this.expectedReviewReportInputRefs(command.taskHash, command.reviewReport),
      outputRefs: [],
      idempotencyKey: stepId,
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
    };
    await trx("o_agent_step").insert({
      ...step,
      inputRefs: JSON.stringify(step.inputRefs),
      outputRefs: JSON.stringify(step.outputRefs),
      usage: JSON.stringify(step.usage),
    });
    family.childSteps.push(step);
    events.push({
      runId: child.id,
      messageId: command.responseMessageId,
      stepId: step.id,
      type: "internal.step.started",
      payload: { stepId: step.id, status: "running", toolName: step.toolName, visibility: "internal" },
    });

    await this.appendAndValidateReviewReport(trx, child, step, command.reviewReport);

    const outputRefs = this.expectedReviewReportOutputRefs(command.reviewReport);
    const updated = await trx("o_agent_step")
      .where({
        id: step.id,
        workspaceId: child.workspaceId,
        projectId: Number(child.projectId),
        runId: child.id,
        agentRole: "reviewer",
        kind: "tool",
        status: "running",
        toolName: "review.report.create",
        idempotencyKey: step.id,
      })
      .update({
        status: "succeeded",
        outputRefs: JSON.stringify(outputRefs),
        updatedAt: now,
        completedAt: now,
      });
    if (affectedRows(updated) !== 1) {
      fail("delegation_review_report_step_conflict", "Reviewer 报告 Tool Step 终态冲突");
    }
    step.status = "succeeded";
    step.outputRefs = outputRefs;
    step.updatedAt = now;
    step.completedAt = now;
    events.push({
      runId: child.id,
      messageId: command.responseMessageId,
      stepId: step.id,
      type: "internal.step.completed",
      payload: {
        stepId: step.id,
        status: "succeeded",
        toolName: step.toolName,
        reportDigest: command.reviewReport.canonicalHash,
        visibility: "internal",
      },
    });
  }

  private async commitChildTerminal(
    trx: Knex.Transaction,
    family: LockedFamily,
    child: RawRun,
    grant: RawGrant,
    command: TerminalCommand,
    now: number,
    events: PendingEvent[],
  ): Promise<void> {
    const storedTask = parseStoredTask(grant, Number(child.projectId), family.delegationContract);
    if (grant.taskHash !== command.taskHash
      || hashIdempotencyRequest(storedTask) !== command.taskHash
      || hashIdempotencyRequest(command.task) !== command.taskHash
      || hashIdempotencyRequest(command.result) !== command.resultHash
      || grant.resultJson != null
      || grant.resultHash != null
      || grant.resultMessageId != null
      || grant.completedAt != null) {
      fail("delegation_task_checkpoint_invalid", "专项任务终态检查点无效");
    }
    const allowedTaskStatuses = command.result.status === "cancelled" ? ["queued", "running"] : ["running"];
    if (!allowedTaskStatuses.includes(String(grant.taskStatus))) {
      fail("delegation_task_status_conflict", "专项任务状态无法转换到终态");
    }

    let responseMessageId = command.responseMessageId;
    let response = responseMessageId
      ? await trx<RawMessage>("o_agent_message").where({
          id: responseMessageId,
          workspaceId: child.workspaceId,
          projectId: Number(child.projectId),
          threadId: child.threadId,
          runId: child.id,
          role: "assistant",
          agentRole: child.agentRole,
          visibility: "internal",
          status: "pending",
        }).first()
      : null;
    if (responseMessageId && !response) fail("delegation_result_message_invalid", "专项 internal response 检查点无效");
    if (!responseMessageId) {
      responseMessageId = cleanId(this.messageIdFactory(), "messageIdFactory");
      command.responseMessageId = responseMessageId;
    }
    validateArtifactBinding(command.result, responseMessageId);

    const childModelSteps = family.childSteps
      .filter((step) => step.runId === child.id && step.kind === "model" && step.status === "running");
    if (command.closeRunningModelSteps) {
      for (const step of childModelSteps) {
        const stepStatus = command.closeRunningModelSteps;
        const error = command.closeStepError ?? command.safeError ?? MAX_ATTEMPTS_ERROR;
        const updated = await trx("o_agent_step")
          .where({ id: step.id, runId: child.id, kind: "model", status: "running" })
          .update({
            status: stepStatus,
            errorCategory: error.code,
            safeError: JSON.stringify(error),
            updatedAt: now,
            completedAt: now,
          });
        if (affectedRows(updated) !== 1) fail("delegation_model_step_conflict", "专项模型 Step 终态冲突");
        step.status = stepStatus;
        step.errorCategory = error.code;
        step.safeError = error;
        step.updatedAt = now;
        step.completedAt = now;
        events.push({
          runId: child.id,
          messageId: responseMessageId,
          stepId: step.id,
          type: `internal.step.${stepStatus}`,
          payload: { stepId: step.id, status: stepStatus, error, visibility: "internal" },
        });
      }
    } else if (childModelSteps.length > 0) {
      fail("delegation_model_checkpoint_invalid", "专项模型仍存在未完成检查点");
    }

    const maxSeq = family.childSteps
      .filter((step) => step.runId === child.id)
      .reduce((max, step) => Math.max(max, Number(step.seq)), Number(child.checkpointStepSeq || 0));
    const resultSeq = maxSeq + 1;
    const resultStepStatus = terminalRunStatus(command.result.status) === "succeeded"
      ? "succeeded" : terminalRunStatus(command.result.status);
    const resultStep: RawStep = {
      id: command.resultStepId,
      workspaceId: child.workspaceId,
      projectId: Number(child.projectId),
      threadId: child.threadId,
      runId: child.id,
      parentStepId: null,
      seq: resultSeq,
      agentRole: child.agentRole,
      kind: "artifact",
      status: resultStepStatus,
      toolName: null,
      argumentsDigest: null,
      inputRefs: [{ type: "delegated_task_hash", value: command.taskHash }],
      outputRefs: [{
        type: RESULT_REF,
        status: command.result.status,
        resultHash: command.resultHash,
        resultMessageId: responseMessageId,
      }],
      idempotencyKey: resultStepKey(child.id),
      resolvedModel: null,
      provider: null,
      usage: command.result.usage,
      costMicros: 0,
      errorCategory: command.safeError?.code ?? null,
      safeError: command.safeError,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
    };

    const expectedStatus = command.source === "processor"
      ? child.status
      : command.expectedRecoveryStatus!;
    const runVersion = safeInteger(child.version, "child.version");
    const runQuery = trx("o_agent_run").where({
      id: child.id,
      status: expectedStatus,
      version: runVersion,
      attempt: Number(child.attempt),
    });
    if (command.source === "processor") {
      runQuery
        .where({ leaseOwner: command.workerId, leaseExpiresAt: child.leaseExpiresAt })
        .andWhere("leaseExpiresAt", ">", now);
    } else if (expectedStatus !== "queued") {
      runQuery
        .where({ leaseOwner: child.leaseOwner, leaseExpiresAt: child.leaseExpiresAt })
        .andWhere("leaseExpiresAt", "<=", now);
    }
    const runUpdated = await runQuery.update({
      status: terminalRunStatus(command.result.status),
      responseMessageId,
      waitType: null,
      waitRef: null,
      wakeAt: null,
      recoveryCount: command.recoveryCount ?? Number(child.recoveryCount || 0),
      checkpointStepSeq: resultSeq,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      error: command.safeError ? JSON.stringify(command.safeError) : null,
      completedAt: now,
      version: runVersion + 1,
      updatedAt: now,
    });
    if (affectedRows(runUpdated) !== 1) fail("delegation_child_terminal_conflict", "child Run 终态 CAS 冲突");
    child.status = terminalRunStatus(command.result.status);
    child.responseMessageId = responseMessageId;
    child.leaseOwner = null;
    child.leaseExpiresAt = null;
    child.checkpointStepSeq = resultSeq;
    child.version = runVersion + 1;
    child.completedAt = now;

    await trx("o_agent_step").insert({
      ...resultStep,
      inputRefs: JSON.stringify(resultStep.inputRefs),
      outputRefs: JSON.stringify(resultStep.outputRefs),
      usage: JSON.stringify(resultStep.usage),
      safeError: command.safeError ? JSON.stringify(command.safeError) : null,
    });
    family.childSteps.push(resultStep);

    await this.closeGrantForTerminalTask(trx, grant, now, {
      taskStatus: command.result.status,
      resultJson: JSON.stringify(command.result),
      resultHash: command.resultHash,
      resultMessageId: responseMessageId,
      completedAt: now,
      safeError: command.safeError ? JSON.stringify(command.safeError) : null,
    });
    grant.taskStatus = command.result.status;
    grant.resultJson = JSON.stringify(command.result);
    grant.resultHash = command.resultHash;
    grant.resultMessageId = responseMessageId;
    grant.completedAt = now;
    grant.safeError = command.safeError;

    const messageStatus = terminalMessageStatus(command.result.status);
    if (response) {
      const updated = await trx("o_agent_message")
        .where({ id: responseMessageId, runId: child.id, visibility: "internal", status: "pending" })
        .update({
          status: messageStatus,
          content: JSON.stringify(command.messageContent),
          error: command.safeError ? JSON.stringify(command.safeError) : null,
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(updated) !== 1) fail("delegation_result_message_conflict", "专项结果 Message 终态冲突");
    } else {
      const trigger = await trx<RawMessage>("o_agent_message")
        .where({
          id: child.triggerMessageId,
          runId: child.id,
          threadId: child.threadId,
          workspaceId: child.workspaceId,
          projectId: Number(child.projectId),
          role: "user",
          visibility: "internal",
          status: "completed",
        })
        .first();
      if (!trigger || Number(trigger.createdBy) !== Number(grant.actorUserId)) {
        fail("delegation_trigger_invalid", "专项内部触发 Message 无效");
      }
      const messageSeq = safeInteger(family.thread.messageSeq, "thread.messageSeq") + 1;
      await trx("o_agent_message").insert({
        id: responseMessageId,
        workspaceId: child.workspaceId,
        projectId: Number(child.projectId),
        threadId: child.threadId,
        runId: child.id,
        replyToId: trigger.id,
        clientMessageId: null,
        seq: messageSeq,
        role: "assistant",
        agentRole: child.agentRole,
        visibility: "internal",
        status: messageStatus,
        content: JSON.stringify(command.messageContent),
        referenceRefs: JSON.stringify([]),
        createdBy: null,
        error: command.safeError ? JSON.stringify(command.safeError) : null,
        metadata: JSON.stringify({ source: "agent-runtime-delegated-r0", taskHash: command.taskHash }),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });
      response = {
        id: responseMessageId,
        workspaceId: child.workspaceId,
        projectId: Number(child.projectId),
        threadId: child.threadId,
        runId: child.id,
        replyToId: trigger.id,
        seq: messageSeq,
        role: "assistant",
        agentRole: child.agentRole,
        visibility: "internal",
        status: messageStatus,
        content: command.messageContent,
        createdBy: null,
        error: command.safeError,
      };
    }

    events.push(
      {
        runId: child.id,
        messageId: responseMessageId,
        stepId: resultStep.id,
        type: `internal.step.${resultStepStatus === "succeeded" ? "completed" : resultStepStatus}`,
        payload: { stepId: resultStep.id, status: resultStepStatus, visibility: "internal" },
      },
      {
        runId: child.id,
        messageId: responseMessageId,
        type: `internal.message.${messageStatus}`,
        payload: { messageId: responseMessageId, status: messageStatus, visibility: "internal" },
      },
      {
        runId: child.id,
        messageId: responseMessageId,
        type: `internal.run.${child.status}`,
        payload: { runId: child.id, status: child.status, agentRole: child.agentRole, visibility: "internal" },
      },
    );
  }

  private async closeGrantForTerminalTask(
    trx: Knex.Transaction,
    grant: RawGrant,
    now: number,
    taskPatch: Record<string, unknown> = {},
  ): Promise<void> {
    if (!["active", "consumed", "revoked", "expired"].includes(grant.status)) {
      fail("delegation_grant_state_invalid", "DelegationGrant 状态无效");
    }
    const nextStatus = grant.status === "active"
      ? Number(grant.expiresAt) <= now ? "expired" : "revoked"
      : grant.status;
    const revision = safeInteger(grant.revision, "grant.revision", { min: 1 });
    const patch: Record<string, unknown> = {
      ...taskPatch,
      status: nextStatus,
      revision: revision + 1,
      updatedAt: now,
    };
    if (grant.status === "active" && nextStatus === "revoked") {
      patch.revokedAt = now;
      patch.revokedBy = safeInteger(grant.actorUserId, "grant.actorUserId", { min: 1 });
    }
    const updated = await trx("o_agent_delegation")
      .where({ id: grant.id, status: grant.status, revision })
      .update(patch);
    if (affectedRows(updated) !== 1) fail("delegation_grant_terminal_conflict", "DelegationGrant 终态 CAS 冲突");
    grant.status = nextStatus;
    grant.revision = revision + 1;
    if (nextStatus === "revoked") {
      grant.revokedAt = now;
      grant.revokedBy = Number(grant.actorUserId);
    }
  }

  private async finalizeParentIfReady(
    trx: Knex.Transaction,
    family: LockedFamily,
    now: number,
    events: PendingEvent[],
  ): Promise<void> {
    const terminal = family.receiptChildRunIds.every((runId) => {
      const child = family.childById.get(runId);
      const grant = family.grantByRunId.get(runId);
      return Boolean(child && grant
        && (TERMINAL_CHILD_RUN_STATUSES as readonly string[]).includes(child.status)
        && (TERMINAL_TASK_STATUSES as readonly string[]).includes(String(grant.taskStatus)));
    });
    if (!terminal) {
      if (family.delegationStep.status !== "waiting_external"
        || !["waiting_delegation", "cancelling"].includes(family.root.status)
        || family.root.waitType !== "delegation"
        || family.root.waitRef !== family.delegationStep.id) {
        fail("delegation_parent_wait_invalid", "父 Run 委派等待检查点无效");
      }
      return;
    }

    const completedBatchReplayAfterRootCancel = family.root.status === "cancelled"
      && family.delegationStep.status === "succeeded";
    if (!completedBatchReplayAfterRootCancel
      && (family.root.status === "cancelling" || family.root.status === "cancelled")) {
      await this.finalizeCancelledRoot(trx, family, now, events);
      return;
    }

    const compactResults: AnyAgentDelegationCompactResult[] = [];
    for (const runId of family.receiptChildRunIds) {
      const child = family.childById.get(runId)!;
      const grant = family.grantByRunId.get(runId)!;
      const task = parseStoredTask(grant, Number(family.root.projectId), family.delegationContract);
      const result = parseStoredResult(grant, family.delegationContract);
      if (result) assertTaskResultRoleBinding(task, result);
      if (!result
        || task.role !== child.agentRole
        || grant.resultHash !== hashIdempotencyRequest(result)
        || grant.resultMessageId == null
        || result.status !== grant.taskStatus
        || terminalRunStatus(result.status) !== child.status
        || grant.status === "active") {
        fail("delegation_result_checkpoint_invalid", "子任务终态审计记录不一致");
      }
      validateArtifactBinding(result, grant.resultMessageId);
      const response = await trx<RawMessage>("o_agent_message")
        .where({
          id: grant.resultMessageId,
          runId: child.id,
          threadId: child.threadId,
          workspaceId: child.workspaceId,
          projectId: Number(child.projectId),
          role: "assistant",
          agentRole: child.agentRole,
          visibility: "internal",
          status: terminalMessageStatus(result.status),
        })
        .first();
      if (!response) fail("delegation_result_message_invalid", "子任务 internal result Message 无效");
      await this.verifyPersistedReviewerResult(trx, family, child, grant, task, result, response);
      compactResults.push(compactResult(
        child,
        task,
        result,
        grant.resultMessageId,
        family.delegationContract,
      ));
    }
    const output = family.delegationContract.completedOutputSchema.parse({
      status: "completed",
      delegationStepId: family.delegationStep.id,
      results: compactResults,
    });
    if (Buffer.byteLength(JSON.stringify(output), "utf8") > AGENT_DELEGATION_COMPACT_LIMITS.maxUtf8Bytes) {
      fail("delegation_parent_tool_result_too_large", "父 Agent 委派聚合结果超过安全上限");
    }
    const checkpoint = parseParentModelCheckpoint(family.modelStep, family.delegationContract);
    const toolResult = {
      callId: checkpoint.callId,
      name: "agent.delegate",
      stepId: family.delegationStep.id,
      output,
    };
    if (completedBatchReplayAfterRootCancel) {
      if (checkpoint.toolResults.length !== 1
        || hashIdempotencyRequest(checkpoint.toolResults) !== hashIdempotencyRequest([toolResult])) {
        fail("delegation_parent_model_result_conflict", "已取消父 Run 的完成委派重放检查点不一致");
      }
      return;
    }
    if (checkpoint.toolResults.length === 0) {
      const updated = await trx("o_agent_step")
        .where({ id: family.modelStep.id, runId: family.root.id, kind: "model", status: "succeeded" })
        .update({
          outputRefs: JSON.stringify([{ ...checkpoint.result, toolResults: [toolResult] }]),
          updatedAt: now,
        });
      if (affectedRows(updated) !== 1) fail("delegation_parent_model_result_conflict", "父模型委派结果回注冲突");
      family.modelStep.outputRefs = [{ ...checkpoint.result, toolResults: [toolResult] }];
    } else if (hashIdempotencyRequest(checkpoint.toolResults) !== hashIdempotencyRequest([toolResult])) {
      fail("delegation_parent_model_result_conflict", "父模型委派结果幂等冲突");
    }

    if (family.delegationStep.status === "waiting_external") {
      const updated = await trx("o_agent_step")
        .where({ id: family.delegationStep.id, runId: family.root.id, status: "waiting_external" })
        .update({ status: "succeeded", updatedAt: now, completedAt: now });
      if (affectedRows(updated) !== 1) fail("delegation_step_terminal_conflict", "Delegation Step 终态冲突");
      family.delegationStep.status = "succeeded";
      family.delegationStep.updatedAt = now;
      family.delegationStep.completedAt = now;
      events.push({
        runId: family.root.id,
        stepId: family.delegationStep.id,
        type: "step.completed",
        payload: { step: toAgentStepDto(mapAgentStep(family.delegationStep)) },
      });
    } else if (family.delegationStep.status !== "succeeded") {
      fail("delegation_step_terminal_conflict", "Delegation Step 终态无效");
    }

    if (family.root.status === "waiting_delegation") {
      if (family.root.waitType !== "delegation" || family.root.waitRef !== family.delegationStep.id) {
        fail("delegation_parent_wait_invalid", "父 Run 等待引用与 Delegation Step 不一致");
      }
      const version = safeInteger(family.root.version, "root.version");
      const updated = await trx("o_agent_run")
        .where({ id: family.root.id, status: "waiting_delegation", version })
        .update({
          status: "queued",
          waitType: null,
          waitRef: null,
          wakeAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: null,
          completedAt: null,
          version: version + 1,
          updatedAt: now,
        });
      if (affectedRows(updated) !== 1) fail("delegation_parent_resume_conflict", "父 Run 恢复 CAS 冲突");
      family.root.status = "queued";
      family.root.waitType = null;
      family.root.waitRef = null;
      family.root.version = version + 1;
      events.push({
        runId: family.root.id,
        messageId: family.root.responseMessageId,
        type: "run.requeued",
        payload: { runId: family.root.id, status: "queued", reason: "delegation_completed" },
      });
    } else if (family.root.status === "queued") {
      if (family.root.waitType != null || family.root.waitRef != null) {
        fail("delegation_parent_resume_conflict", "已恢复父 Run 仍包含等待引用");
      }
    } else if (family.delegationStep.status === "succeeded") {
      // An exact old-batch replay may arrive after the root has already been
      // claimed or entered a later wait. The immutable model Tool result above
      // is the batch's idempotency evidence; never rewrite the newer root state.
      return;
    } else {
      fail("delegation_parent_resume_conflict", "父 Run 当前不可恢复委派");
    }
  }

  private async finalizeCancelledRoot(
    trx: Knex.Transaction,
    family: LockedFamily,
    now: number,
    events: PendingEvent[],
  ): Promise<void> {
    for (const runId of family.receiptChildRunIds) {
      const child = family.childById.get(runId)!;
      const grant = family.grantByRunId.get(runId)!;
      const task = parseStoredTask(grant, Number(family.root.projectId), family.delegationContract);
      const result = parseStoredResult(grant, family.delegationContract);
      if (result) assertTaskResultRoleBinding(task, result);
      if (!result
        || task.role !== child.agentRole
        || grant.taskStatus !== result.status
        || grant.resultHash !== hashIdempotencyRequest(result)
        || terminalRunStatus(result.status) !== child.status
        || grant.status === "active"
        || (grant.resultMessageId == null && result.status !== "cancelled")) {
        fail("delegation_cancel_audit_invalid", "取消委派的 child Run、Grant 与 AgentTaskResult 不一致");
      }
      if (grant.resultMessageId != null) {
        validateArtifactBinding(result, grant.resultMessageId);
        const response = await trx<RawMessage>("o_agent_message")
          .where({
            id: grant.resultMessageId,
            runId: child.id,
            threadId: child.threadId,
            workspaceId: child.workspaceId,
            projectId: Number(child.projectId),
            role: "assistant",
            agentRole: child.agentRole,
            visibility: "internal",
            status: terminalMessageStatus(result.status),
          })
          .first();
        if (!response) fail("delegation_cancel_audit_invalid", "取消委派的 internal result Message 无效");
      } else if (result.artifactRefs.length !== 0) {
        fail("delegation_cancel_audit_invalid", "无 internal Message 的取消结果不得声明 artifactRefs");
      }
    }
    const checkpoint = parseParentModelCheckpoint(family.modelStep, family.delegationContract);
    if (checkpoint.toolResults.length !== 0) {
      fail("delegation_cancel_aggregation_conflict", "取消父 Run 不得回注委派工具结果");
    }
    if (family.root.status === "cancelled") {
      if (family.delegationStep.status !== "cancelled"
        || family.thread.activeRootRunId === family.root.id) {
        fail("delegation_root_cancel_conflict", "父 Run 取消审计检查点不完整");
      }
      return;
    }
    if (family.root.status !== "cancelling"
      || family.root.waitType !== "delegation"
      || family.root.waitRef !== family.delegationStep.id) {
      fail("delegation_root_cancel_conflict", "父 Run 不是当前委派的 cancelling 状态");
    }
    if (family.delegationStep.status === "waiting_external") {
      const updated = await trx("o_agent_step")
        .where({ id: family.delegationStep.id, runId: family.root.id, status: "waiting_external" })
        .update({
          status: "cancelled",
          errorCategory: CANCELLED_ERROR.code,
          safeError: JSON.stringify(CANCELLED_ERROR),
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(updated) !== 1) fail("delegation_step_terminal_conflict", "Delegation Step 取消冲突");
      family.delegationStep.status = "cancelled";
      family.delegationStep.errorCategory = CANCELLED_ERROR.code;
      family.delegationStep.safeError = CANCELLED_ERROR;
      family.delegationStep.updatedAt = now;
      family.delegationStep.completedAt = now;
      events.push({
        runId: family.root.id,
        stepId: family.delegationStep.id,
        type: "step.cancelled",
        payload: { step: toAgentStepDto(mapAgentStep(family.delegationStep)) },
      });
    } else if (family.delegationStep.status !== "cancelled") {
      fail("delegation_step_terminal_conflict", "Delegation Step 取消终态无效");
    }

    const version = safeInteger(family.root.version, "root.version");
    const updated = await trx("o_agent_run")
      .where({ id: family.root.id, status: "cancelling", version })
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
        version: version + 1,
        updatedAt: now,
      });
    if (affectedRows(updated) !== 1) fail("delegation_root_cancel_conflict", "父 Run 取消 CAS 冲突");
    family.root.status = "cancelled";
    family.root.version = version + 1;
    family.root.waitType = null;
    family.root.waitRef = null;

    if (family.root.responseMessageId) {
      const response = await trx<RawMessage>("o_agent_message")
        .where({
          id: family.root.responseMessageId,
          runId: family.root.id,
          threadId: family.root.threadId,
          workspaceId: family.root.workspaceId,
          projectId: Number(family.root.projectId),
          role: "assistant",
        })
        .first();
      if (response && ["pending", "streaming"].includes(response.status)) {
        const responseUpdated = await trx("o_agent_message")
          .where({ id: response.id, runId: family.root.id, status: response.status })
          .update({
            status: "stopped",
            error: JSON.stringify(CANCELLED_ERROR),
            updatedAt: now,
            completedAt: now,
          });
        if (affectedRows(responseUpdated) !== 1) fail("delegation_root_message_conflict", "父 Run response 取消冲突");
        events.push({
          runId: family.root.id,
          messageId: response.id,
          type: "message.stopped",
          payload: { messageId: response.id, status: "stopped", error: CANCELLED_ERROR },
        });
      } else if (response?.status !== "stopped") {
        fail("delegation_root_message_conflict", "父 Run response 终态无效");
      }
    }
    events.push({
      runId: family.root.id,
      messageId: family.root.responseMessageId,
      type: "run.cancelled",
      payload: { runId: family.root.id, status: "cancelled", reason: "delegated_children_cancelled" },
    });
  }

  private async flushThreadAndEvents(
    trx: Knex.Transaction,
    family: LockedFamily,
    now: number,
    events: PendingEvent[],
    messageSeqIncrement: number,
    forceReleaseRoot: boolean,
  ): Promise<void> {
    if (events.length === 0 && messageSeqIncrement === 0 && !forceReleaseRoot) return;
    const version = safeInteger(family.thread.version, "thread.version");
    const eventSeq = safeInteger(family.thread.eventSeq, "thread.eventSeq");
    const messageSeq = safeInteger(family.thread.messageSeq, "thread.messageSeq");
    const releaseRoot = forceReleaseRoot || family.root.status === "cancelled";
    const patch: Record<string, unknown> = {
      eventSeq: eventSeq + events.length,
      messageSeq: messageSeq + messageSeqIncrement,
      version: version + 1,
      updatedAt: now,
    };
    if (releaseRoot) {
      if (family.thread.activeRootRunId !== family.root.id && family.thread.activeRootRunId != null) {
        fail("delegation_thread_root_conflict", "Thread activeRootRunId 与取消父 Run 不一致");
      }
      patch.activeRootRunId = null;
      patch.lastMessageAt = now;
    }
    const updated = await trx("o_agent_thread")
      .where({ id: family.thread.id, workspaceId: family.root.workspaceId, version })
      .update(patch);
    if (affectedRows(updated) !== 1) fail("delegation_thread_conflict", "Delegation Thread 版本冲突");
    family.thread.version = version + 1;
    family.thread.eventSeq = eventSeq + events.length;
    family.thread.messageSeq = messageSeq + messageSeqIncrement;
    if (releaseRoot) family.thread.activeRootRunId = null;

    let seq = eventSeq + 1;
    for (const event of events) {
      await this.eventAppender(trx, {
        workspaceId: family.root.workspaceId,
        projectId: Number(family.root.projectId),
        threadId: family.root.threadId,
        runId: event.runId,
        messageId: event.messageId,
        stepId: event.stepId,
        seq: seq++,
        type: event.type,
        payload: event.payload,
        createdAt: now,
      });
    }
  }
}
