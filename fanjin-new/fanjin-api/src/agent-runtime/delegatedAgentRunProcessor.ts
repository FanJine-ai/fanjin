import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import {
  type A4DelegatedAgentRoleV2,
  type A4DelegatedAgentRoleV3,
  type AgentTask,
  type AgentTaskResult,
  type AgentTaskResultStatus,
} from "@/agent-runtime/delegationContracts";
import {
  parseA4DelegatedRunPolicySnapshot,
  type A4DelegatedRunPolicySnapshot,
} from "@/agent-runtime/delegatedRunPolicy";
import {
  getAgentDelegationPersistenceContractForPolicyVersion,
  getAgentDelegationPersistenceContractForTaskVersion,
  type AgentDelegationPersistenceContract,
} from "@/agent-runtime/tools/packages/delegation";
import type {
  DelegatedAgentModel,
  DelegatedAgentModelResult,
  DelegatedAgentModelTranscriptItem,
  DelegatedAgentRelayUsage,
} from "@/agent-runtime/delegatedAgentModel";
import {
  a4ReviewReportDraftSchema,
  createA4ReviewReport,
  type A4ReviewReport,
  type A4ReviewReportDraft,
} from "@/agent-runtime/reviewReportContracts";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { appendAgentEvent, type AppendAgentEventInput } from "@/agent-runtime/eventStore";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import type { AgentRunProcessInput, AgentRunProcessResult } from "@/agent-runtime/runProcessor";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import type { AgentContentPart, AgentStep } from "@/agent-runtime/types";
import type {
  AgentToolGatewayExecuteResult,
} from "@/agent-runtime/tools/gateway";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import type { AgentToolCatalogDefinition } from "@/agent-runtime/tools/registry";
import type { AgentRuntimeClaimedRun } from "@/agent-runtime/worker";

const MODEL_STEP_PREFIX = "agent-delegated-model";
const RESULT_STEP_PREFIX = "agent-delegated-result";
const MODEL_RESULT_REF = "delegated_model_turn_result";
const MODEL_TURN_REF = "delegated_model_turn";
const MODEL_DISPATCH_REF = "model_dispatch_state";
const RESULT_REF = "delegated_task_result";

const MAX_TURNS = 4;
const MAX_TOOL_CALLS = 8;
const MAX_ARGUMENT_BYTES = 32_768;
const MAX_RESULT_BYTES = 65_536;
const MAX_FINAL_BYTES = 131_072;

const UNCERTAIN_ERROR = Object.freeze({
  code: "delegated_model_outcome_uncertain",
  message: "专项模型请求发出后未能安全保存结果，已禁止自动重试",
});

const CANCELLED_ERROR = Object.freeze({
  code: "run_cancelled",
  message: "专项 Agent 运行已取消",
});

const GENERIC_FAILURE = Object.freeze({
  code: "delegated_agent_failed",
  message: "专项 Agent 运行失败",
});

interface RawRun {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  rootRunId: string;
  parentRunId: string | null;
  delegationId: string | null;
  kind: string;
  triggerMessageId: string;
  responseMessageId: string | null;
  agentRole: string;
  status: string;
  policySnapshot: unknown;
  checkpointStepSeq: number | string | null;
  sideEffectsCommitted: number | string | boolean | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | string | null;
  attempt: number | string | null;
  version: number | string | null;
  error: unknown;
  completedAt: number | string | null;
}

interface RawThread {
  id: string;
  activeRootRunId: string | null;
  messageSeq: number | string | null;
  eventSeq: number | string | null;
  lastMessageAt: number | string | null;
  version: number | string | null;
}

interface RawMessage {
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
  referenceRefs: unknown;
  createdBy: number | string | null;
  error: unknown;
}

interface RawDelegation {
  id: string;
  actorUserId: number | string;
  workspaceId: string;
  projectId: number | string;
  parentRunId: string;
  parentStepId: string;
  boundRunId: string | null;
  granteeRole: string;
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
  updatedAt: number | string;
}

interface RawStep {
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

export interface DelegatedAgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface DelegatedAgentToolResult {
  callId: string;
  name: string;
  stepId: string;
  output: unknown;
}

interface StoredModelTurnResult {
  type: typeof MODEL_RESULT_REF;
  turn: number;
  outcome: "tool_calls" | "final";
  assistantText: string;
  calls: DelegatedAgentToolCall[];
  toolResults: DelegatedAgentToolResult[];
  finalOutput: {
    status: "succeeded" | "needs_input";
    proposal?: string | null;
    reviewReport?: A4ReviewReportDraft | null;
    summary: string;
    assumptions: string[];
    issues: string[];
    suggestedNextActions: string[];
  } | null;
  usage: DelegatedAgentRelayUsage;
}

interface PreparedDelegatedLoop {
  kind: "ready";
  run: RawRun;
  trigger: RawMessage;
  delegation: RawDelegation;
  task: AgentTask;
  policy: A4DelegatedRunPolicySnapshot;
  contract: AgentDelegationPersistenceContract;
  responseMessageId: string;
}

interface LostDelegatedLoop {
  kind: "lease_lost";
  responseMessageId: string | null;
}

interface TerminalDelegatedLoop {
  kind: "terminal";
  result: AgentRunProcessResult;
}

type PrepareResult = PreparedDelegatedLoop | LostDelegatedLoop | TerminalDelegatedLoop;

export interface DelegatedAgentToolGateway {
  listDelegatedModelToolCandidates(runId: string): Promise<readonly AgentToolCatalogDefinition[]>;
  assertDelegatedModelDispatchAuthorizedInTransaction(
    trx: Knex.Transaction,
    runId: string,
  ): Promise<void>;
  execute(input: {
    runId: string;
    toolName: string;
    arguments: unknown;
    approvalId?: string | null;
    idempotencyKey: string;
    claimFence: { workerId: string; attempt: number };
  }): Promise<AgentToolGatewayExecuteResult>;
}

export interface DelegatedAgentModelExecutor {
  executeTurn(input: Parameters<DelegatedAgentModel["executeTurn"]>[0]): ReturnType<DelegatedAgentModel["executeTurn"]>;
}

export interface DelegatedAgentRunProcessorHooks {
  /** Crash seam after the model Step is prepared but before any provider call. */
  afterModelStepPrepared?(input: { runId: string; turn: number; stepId: string }): Promise<void>;
  /** Crash seam after durable dispatch CAS and before the provider dispatch continues. */
  afterModelDispatchCheckpoint?(input: { runId: string; turn: number; stepId: string }): Promise<void>;
  /** Crash seam after the provider returned but before its result is persisted. */
  afterModelProviderReturned?(input: { runId: string; turn: number; stepId: string }): Promise<void>;
  /** Crash seam after the complete model result and usage have committed. */
  afterModelResultRecorded?(input: { runId: string; turn: number; stepId: string }): Promise<void>;
  /** Crash seam after a Gateway Tool Step committed and before the model checkpoint records it. */
  afterToolExecute?(input: {
    runId: string;
    turn: number;
    call: DelegatedAgentToolCall;
    result: AgentToolGatewayExecuteResult;
  }): Promise<void>;
  /** Crash seam after all Tool results for one Turn have committed to the model Step. */
  afterToolResultsRecorded?(input: {
    runId: string;
    turn: number;
    toolResults: readonly DelegatedAgentToolResult[];
  }): Promise<void>;
  /** Crash seam after the child terminal result is completely durable. */
  afterTerminalResultCommitted?(input: {
    runId: string;
    taskStatus: AgentTaskResultStatus;
    resultMessageId: string;
  }): Promise<void>;
}

export interface DelegatedAgentTerminalCommitInput {
  claimedRun: AgentRuntimeClaimedRun;
  workerId: string;
  run: {
    id: string;
    workspaceId: string;
    projectId: number;
    threadId: string;
    rootRunId: string;
    parentRunId: string;
    delegationId: string;
    agentRole: A4DelegatedAgentRoleV3;
  };
  responseMessageId: string;
  task: AgentTask;
  taskHash: string;
  result: AgentTaskResult;
  resultHash: string;
  resultStepId: string;
  messageContent: AgentContentPart[];
  /** Full canonical Reviewer report, committed only by the terminal committer. */
  reviewReport: A4ReviewReport | null;
  safeError: { code: string; message: string } | null;
  knownModelResultStepId: string | null;
}

export type DelegatedAgentTerminalCommitResult =
  | {
    status: "succeeded" | "needs_input" | "failed" | "cancelled";
    runId: string;
    responseMessageId: string;
  }
  | { status: "lease_lost"; runId: string; responseMessageId: string | null };

/**
 * A4 parent wake-up is intentionally not implemented here. A later committer
 * can replace this child-only implementation and acquire root -> child locks
 * before atomically aggregating the last sibling and re-queueing the parent.
 */
export interface DelegatedAgentTerminalCommitter {
  commit(input: DelegatedAgentTerminalCommitInput): Promise<DelegatedAgentTerminalCommitResult>;
}

export interface DelegatedAgentRunProcessorOptions {
  database: Knex;
  model: DelegatedAgentModelExecutor;
  gateway: DelegatedAgentToolGateway;
  terminalCommitter?: DelegatedAgentTerminalCommitter;
  clock?: () => number;
  messageIdFactory?: () => string;
  stepIdFactory?: () => string;
  maxTurns?: number;
  maxToolCalls?: number;
  maxArgumentBytes?: number;
  maxResultBytes?: number;
  maxFinalBytes?: number;
  hooks?: DelegatedAgentRunProcessorHooks;
  eventAppender?: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
}

class DelegatedProcessorSafeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DelegatedProcessorSafeError";
  }
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${field} 必须是 1-${maximum} 的整数`);
  }
  return resolved;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArray<T>(value: unknown): T[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function cleanRole(value: unknown): A4DelegatedAgentRoleV2 {
  if (value !== "writer" && value !== "visual" && value !== "storyboard" && value !== "reviewer") {
    throw new DelegatedProcessorSafeError(
      "delegated_run_role_unsupported",
      "A4 模型专项运行仅支持 writer、visual、storyboard 或 reviewer；executor 走确定性处理器",
    );
  }
  return value;
}

function persistenceContractForPolicy(
  policy: A4DelegatedRunPolicySnapshot,
): AgentDelegationPersistenceContract {
  const contract = getAgentDelegationPersistenceContractForPolicyVersion(
    policy.delegatedTask.version,
  );
  if (!contract || policy.delegatedTask.taskVersion !== contract.taskVersion) {
    throw new DelegatedProcessorSafeError(
      "delegated_run_policy_invalid",
      "专项 Agent Run 的持久化版本契约无效",
    );
  }
  return contract;
}

function cleanId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f\s]/.test(id)) {
    throw new DelegatedProcessorSafeError("delegated_checkpoint_invalid", "专项运行检查点格式无效");
  }
  return id;
}

function byteLength(value: unknown, code: string, message: string, limit: number): number {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new DelegatedProcessorSafeError(code, message);
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > limit) throw new DelegatedProcessorSafeError(code, message);
  return bytes;
}

function hasCurrentLiveLease(run: RawRun, workerId: string, attempt: number, now: number): boolean {
  return run.leaseOwner === workerId
    && Number(run.attempt || 0) === attempt
    && Number(run.leaseExpiresAt || 0) > now;
}

function hasLiveLease(run: RawRun, workerId: string, attempt: number, now: number): boolean {
  return run.status === "running" && hasCurrentLiveLease(run, workerId, attempt, now);
}

function modelStepKey(runId: string, turn: number): string {
  return `${MODEL_STEP_PREFIX}:${runId}:turn:${turn}`;
}

function modelRequestKey(runId: string, turn: number): string {
  return `agent-run:${runId}:delegated-model-turn:${turn}`;
}

function resultStepKey(runId: string): string {
  return `${RESULT_STEP_PREFIX}:${runId}`;
}

function toolCallKey(turn: number, index: number, call: DelegatedAgentToolCall): string {
  return `delegated-t${turn}-c${index}-${hashIdempotencyRequest(call).slice(0, 24)}`;
}

function dispatchState(step: Pick<RawStep, "inputRefs">): "prepared" | "dispatched" | null {
  const state = parseArray<Record<string, unknown>>(step.inputRefs)
    .find((ref) => ref?.type === MODEL_DISPATCH_REF)?.value;
  return state === "prepared" || state === "dispatched" ? state : null;
}

function withDispatchState(value: unknown, state: "prepared" | "dispatched"): Record<string, unknown>[] {
  const next = parseArray<Record<string, unknown>>(value)
    .filter((ref) => ref?.type !== MODEL_DISPATCH_REF);
  next.unshift({ type: MODEL_DISPATCH_REF, value: state });
  return next;
}

function cleanToolCalls(value: unknown, maxArgumentBytes: number): DelegatedAgentToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DelegatedProcessorSafeError("delegated_model_tool_calls_invalid", "专项模型工具调用格式无效");
  }
  const calls = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new DelegatedProcessorSafeError("delegated_model_tool_calls_invalid", "专项模型工具调用格式无效");
    }
    const record = item as Record<string, unknown>;
    const id = cleanId(record.id);
    const name = cleanId(record.name);
    const args = record.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new DelegatedProcessorSafeError("delegated_model_tool_calls_invalid", "专项模型工具参数格式无效");
    }
    byteLength(args, "delegated_model_tool_arguments_too_large", "专项模型工具参数超过安全上限", maxArgumentBytes);
    return { id, name, arguments: JSON.parse(JSON.stringify(args)) as Record<string, unknown> };
  });
  if (new Set(calls.map(({ id }) => id)).size !== calls.length) {
    throw new DelegatedProcessorSafeError("delegated_model_tool_calls_invalid", "同一专项模型 Turn 包含重复调用 id");
  }
  return calls;
}

function cleanUsage(value: unknown): DelegatedAgentRelayUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DelegatedProcessorSafeError("delegated_model_usage_invalid", "专项模型 usage 格式无效");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\u0000") !== ["costMicros", "inputTokens", "outputTokens"].sort().join("\u0000")
    || !Number.isSafeInteger(record.inputTokens)
    || Number(record.inputTokens) < 0
    || !Number.isSafeInteger(record.outputTokens)
    || Number(record.outputTokens) < 0
    || record.costMicros !== null) {
    throw new DelegatedProcessorSafeError("delegated_model_usage_invalid", "专项模型 usage 格式无效");
  }
  return {
    inputTokens: Number(record.inputTokens),
    outputTokens: Number(record.outputTokens),
    costMicros: null,
  };
}

function cleanText(value: unknown, field: string, maxCharacters: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxCharacters || text.includes("\u0000")) {
    throw new DelegatedProcessorSafeError("delegated_model_final_invalid", `专项模型 ${field} 格式无效`);
  }
  return text;
}

function cleanTextList(value: unknown, field: string, maxItems: number, maxCharacters: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DelegatedProcessorSafeError("delegated_model_final_invalid", `专项模型 ${field} 格式无效`);
  }
  return value.map((item) => cleanText(item, field, maxCharacters));
}

function cleanFinalOutput(
  value: unknown,
  maxFinalBytes: number,
  role: A4DelegatedAgentRoleV3,
): StoredModelTurnResult["finalOutput"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DelegatedProcessorSafeError("delegated_model_final_invalid", "专项模型最终输出格式无效");
  }
  const record = value as Record<string, unknown>;
  const outputKey = role === "reviewer" ? "reviewReport" : "proposal";
  const expectedKeys = ["status", outputKey, "summary", "assumptions", "issues", "suggestedNextActions"];
  if (Object.keys(record).sort().join("\u0000") !== expectedKeys.sort().join("\u0000")
    || (record.status !== "succeeded" && record.status !== "needs_input")) {
    throw new DelegatedProcessorSafeError("delegated_model_final_invalid", "专项模型最终输出格式无效");
  }
  const status = record.status as "succeeded" | "needs_input";
  let outputArtifact: { proposal: string | null } | { reviewReport: A4ReviewReportDraft | null };
  if (role === "reviewer") {
    if (status === "needs_input") {
      if (record.reviewReport !== null) {
        throw new DelegatedProcessorSafeError("delegated_model_final_invalid", "Reviewer needs_input 不得包含 ReviewReport");
      }
      outputArtifact = { reviewReport: null };
    } else {
      const draft = a4ReviewReportDraftSchema.safeParse(record.reviewReport);
      if (!draft.success) {
        throw new DelegatedProcessorSafeError("delegated_model_final_invalid", "Reviewer ReviewReport 格式无效");
      }
      try {
        createA4ReviewReport({
          ...draft.data,
          modelUsage: { modelProfile: "validation@0", inputTokens: 0, outputTokens: 0, costMicros: null },
        });
      } catch {
        throw new DelegatedProcessorSafeError("delegated_model_final_invalid", "Reviewer ReviewReport 契约无效");
      }
      outputArtifact = { reviewReport: draft.data };
    }
  } else {
    const proposal = record.proposal === null ? null : cleanText(record.proposal, "proposal", 120_000);
    if ((status === "succeeded" && proposal === null) || (status === "needs_input" && proposal !== null)) {
      throw new DelegatedProcessorSafeError("delegated_model_final_invalid", "专项模型最终状态与 proposal 不一致");
    }
    outputArtifact = { proposal };
  }
  const output = {
    status,
    ...outputArtifact,
    summary: cleanText(record.summary, "summary", 4_000),
    assumptions: cleanTextList(record.assumptions, "assumptions", 32, 1_000),
    issues: cleanTextList(record.issues, "issues", 32, 1_000),
    suggestedNextActions: cleanTextList(record.suggestedNextActions, "suggestedNextActions", 16, 1_000),
  };
  if (status === "needs_input" && (output.issues.length === 0 || output.suggestedNextActions.length === 0)) {
    throw new DelegatedProcessorSafeError(
      "delegated_model_final_invalid",
      "专项模型 needs_input 必须说明缺口与最小补充动作",
    );
  }
  byteLength(output, "delegated_model_final_too_large", "专项模型最终输出超过安全上限", maxFinalBytes);
  return output;
}

function cleanModelResult(
  value: DelegatedAgentModelResult,
  turn: number,
  limits: { maxArgumentBytes: number; maxToolCalls: number; maxFinalBytes: number },
  role: A4DelegatedAgentRoleV3,
): StoredModelTurnResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DelegatedProcessorSafeError("delegated_model_result_invalid", "专项模型结果格式无效");
  }
  const usage = cleanUsage((value as Record<string, unknown>).usage);
  if (value.kind === "tool_calls") {
    const calls = cleanToolCalls(value.calls, limits.maxArgumentBytes);
    if (calls.length > limits.maxToolCalls) {
      throw new DelegatedProcessorSafeError("delegated_tool_call_limit_exceeded", "专项模型工具调用超过安全上限");
    }
    return {
      type: MODEL_RESULT_REF,
      turn,
      outcome: "tool_calls",
      assistantText: typeof value.assistantText === "string" ? value.assistantText.slice(0, 8_000) : "",
      calls,
      toolResults: [],
      finalOutput: null,
      usage,
    };
  }
  if (value.kind === "final") {
    return {
      type: MODEL_RESULT_REF,
      turn,
      outcome: "final",
      assistantText: "",
      calls: [],
      toolResults: [],
      finalOutput: cleanFinalOutput(value.output, limits.maxFinalBytes, role),
      usage,
    };
  }
  throw new DelegatedProcessorSafeError("delegated_model_result_invalid", "专项模型结果格式无效");
}

function storedTurnResult(step: Pick<RawStep, "outputRefs" | "usage" | "agentRole">): StoredModelTurnResult | null {
  const ref = parseArray<Record<string, unknown>>(step.outputRefs)
    .find((item) => item?.type === MODEL_RESULT_REF);
  if (!ref) return null;
  const turn = Number(ref.turn);
  if (!Number.isSafeInteger(turn) || turn <= 0 || (ref.outcome !== "tool_calls" && ref.outcome !== "final")) return null;
  try {
    const usage = cleanUsage(ref.usage ?? parseJson(step.usage));
    const calls = ref.outcome === "tool_calls" ? cleanToolCalls(ref.calls, MAX_ARGUMENT_BYTES) : [];
    const rawToolResults = Array.isArray(ref.toolResults) ? ref.toolResults : [];
    const toolResults = rawToolResults.map((item): DelegatedAgentToolResult => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid tool result");
      const record = item as Record<string, unknown>;
      const output = record.output;
      byteLength(output, "delegated_tool_result_too_large", "专项工具结果超过模型回注安全上限", MAX_RESULT_BYTES);
      return {
        callId: cleanId(record.callId),
        name: cleanId(record.name),
        stepId: cleanId(record.stepId),
        output,
      };
    });
    if (ref.outcome === "tool_calls"
      && toolResults.length !== 0
      && (toolResults.length !== calls.length || toolResults.some((item, index) => (
        item.callId !== calls[index].id || item.name !== calls[index].name
      )))) return null;
    if (ref.outcome === "final"
      && (calls.length !== 0 || toolResults.length !== 0 || ref.finalOutput == null)) return null;
    return {
      type: MODEL_RESULT_REF,
      turn,
      outcome: ref.outcome,
      assistantText: typeof ref.assistantText === "string" ? ref.assistantText : "",
      calls,
      toolResults,
      finalOutput: ref.outcome === "final"
        ? cleanFinalOutput(ref.finalOutput, MAX_FINAL_BYTES, cleanRole(step.agentRole))
        : null,
      usage,
    };
  } catch {
    return null;
  }
}

function asAgentStep(row: RawStep): AgentStep {
  return mapAgentStep(row);
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof DelegatedProcessorSafeError) return { code: error.code, message: error.message };
  if (error instanceof AgentToolGatewayError) return { code: error.code, message: error.message };
  return GENERIC_FAILURE;
}

function parsePersistedTaskResult(
  value: unknown,
  contract: AgentDelegationPersistenceContract,
  role?: A4DelegatedAgentRoleV3,
): AgentTaskResult | null {
  try {
    return contract.normalizeResult(parseJson(value), { expectedRole: role });
  } catch {
    return null;
  }
}

function assertCatalog(
  catalog: readonly AgentToolCatalogDefinition[],
  policy: A4DelegatedRunPolicySnapshot,
): readonly AgentToolCatalogDefinition[] {
  // A fully verified Grant may have exhausted maxToolCalls after a previous
  // Turn. Gateway projects an empty final-only directory in that state so the
  // model can still synthesize the proposal from durable Tool results.
  if (catalog.length === 0) return catalog;
  const expected = [...policy.delegatedTask.allowedTools].sort();
  const actual = catalog.map(({ manifest }) => manifest.name).sort();
  if (actual.length !== expected.length
    || actual.some((name, index) => name !== expected[index])
    || catalog.some(({ manifest }) => (
      manifest.riskClass !== "R0"
      || manifest.mutatesState
      || manifest.metered
      || manifest.availability.state !== "available"
      || manifest.name === "agent.delegate"
    ))) {
    throw new DelegatedProcessorSafeError(
      "delegated_model_catalog_invalid",
      "专项模型 R0 工具目录与固定授权边界不一致",
    );
  }
  return catalog;
}

function compactNeedsInputContent(result: AgentTaskResult): AgentContentPart[] {
  const lines = [result.summary];
  if (result.issues.length > 0) lines.push(`缺少信息：${result.issues.join("；")}`);
  if (result.suggestedNextActions.length > 0) {
    lines.push(`建议补充：${result.suggestedNextActions.join("；")}`);
  }
  return [{ type: "text", text: lines.join("\n").slice(0, 16_000) }];
}

function addUsage(
  total: { inputTokens: number; outputTokens: number },
  usage: DelegatedAgentRelayUsage,
): void {
  const inputTokens = total.inputTokens + usage.inputTokens;
  const outputTokens = total.outputTokens + usage.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
    throw new DelegatedProcessorSafeError("delegated_model_usage_invalid", "专项模型 usage 累计溢出");
  }
  total.inputTokens = inputTokens;
  total.outputTokens = outputTokens;
}

function terminalProcessStatus(taskStatus: AgentTaskResultStatus): AgentTaskResultStatus {
  return taskStatus;
}

export class ChildOnlyDelegatedAgentTerminalCommitter implements DelegatedAgentTerminalCommitter {
  private readonly database: Knex;
  private readonly clock: () => number;
  private readonly eventAppender: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;

  constructor(options: {
    database: Knex;
    clock?: () => number;
    eventAppender?: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
  }) {
    this.database = options.database;
    this.clock = options.clock ?? Date.now;
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
  }

  async commit(input: DelegatedAgentTerminalCommitInput): Promise<DelegatedAgentTerminalCommitResult> {
    const requestedContract = getAgentDelegationPersistenceContractForTaskVersion(
      input.task && typeof input.task === "object" ? input.task.version : null,
    );
    let normalizedTask: AgentTask;
    let normalizedResult: AgentTaskResult;
    try {
      if (!requestedContract) throw new Error("unsupported persistence contract");
      normalizedTask = requestedContract.normalizeTask(input.task, { expectedProjectId: input.run.projectId });
      normalizedResult = requestedContract.normalizeResult(input.result, { expectedRole: input.run.agentRole });
    } catch {
      throw new DelegatedProcessorSafeError("delegated_terminal_input_invalid", "专项任务终态输入格式无效");
    }
    if (normalizedTask.role !== input.run.agentRole
      || hashIdempotencyRequest(normalizedTask) !== input.taskHash
      || hashIdempotencyRequest(normalizedResult) !== input.resultHash) {
      throw new DelegatedProcessorSafeError("delegated_terminal_input_invalid", "专项任务终态输入绑定无效");
    }
    return this.database.transaction(async (trx): Promise<DelegatedAgentTerminalCommitResult> => {
      const run = await trx<RawRun>("o_agent_run").where({ id: input.run.id }).forUpdate().first();
      const now = this.clock();
      if (!run) return { status: "lease_lost", runId: input.run.id, responseMessageId: input.responseMessageId };
      let policy: A4DelegatedRunPolicySnapshot;
      try {
        policy = parseA4DelegatedRunPolicySnapshot(run.policySnapshot, {
          expectedRole: input.run.agentRole,
          expectedDelegationId: input.run.delegationId,
          expectedParentRunId: input.run.parentRunId,
          expectedTaskHash: input.taskHash,
        });
      } catch {
        throw new DelegatedProcessorSafeError("delegated_run_policy_invalid", "专项 Agent Run 的固定策略无效");
      }
      const contract = persistenceContractForPolicy(policy);
      if (!requestedContract
        || contract.policyVersion !== requestedContract.policyVersion
        || normalizedTask.version !== contract.taskVersion
        || normalizedResult.version !== contract.resultVersion) {
        throw new DelegatedProcessorSafeError("delegated_terminal_input_invalid", "专项任务终态版本绑定无效");
      }
      if (normalizedTask.role === "reviewer") {
        throw new DelegatedProcessorSafeError(
          "delegated_reviewer_committer_required",
          "Reviewer 终态必须由支持报告原子持久化的 Completion Service 提交",
        );
      }

      const expectedProcessStatus = terminalProcessStatus(normalizedResult.status);
      if (["succeeded", "failed", "cancelled"].includes(run.status)) {
        const delegation = await trx<RawDelegation>("o_agent_delegation")
          .where({ id: input.run.delegationId, boundRunId: input.run.id })
          .first();
        const response = await trx<RawMessage>("o_agent_message")
          .where({ id: input.responseMessageId, runId: input.run.id, visibility: "internal" })
          .first();
        const persisted = parsePersistedTaskResult(delegation?.resultJson, contract, normalizedTask.role);
        const expectedRunStatus = normalizedResult.status === "failed"
          ? "failed"
          : normalizedResult.status === "cancelled" ? "cancelled" : "succeeded";
        const expectedMessageStatus = normalizedResult.status === "failed"
          ? "error"
          : normalizedResult.status === "cancelled" ? "stopped" : "completed";
        if (run.status === expectedRunStatus
          && delegation?.taskVersion != null
          && Number(delegation.taskVersion) === contract.taskVersion
          && delegation?.taskStatus === normalizedResult.status
          && delegation.resultMessageId === input.responseMessageId
          && delegation.resultHash === input.resultHash
          && response?.status === expectedMessageStatus
          && persisted?.status === normalizedResult.status
          && hashIdempotencyRequest(persisted) === input.resultHash) {
          return { status: expectedProcessStatus, runId: run.id, responseMessageId: input.responseMessageId };
        }
        return { status: "lease_lost", runId: run.id, responseMessageId: input.responseMessageId };
      }

      const expectedRunStatuses = normalizedResult.status === "cancelled"
        ? ["cancelling"]
        : normalizedResult.status === "failed" && input.safeError?.code === UNCERTAIN_ERROR.code
          ? ["running", "cancelling"]
          : ["running"];
      if (!expectedRunStatuses.includes(run.status)
        || !hasCurrentLiveLease(run, input.workerId, input.claimedRun.attempt, now)
        || run.workspaceId !== input.run.workspaceId
        || Number(run.projectId) !== input.run.projectId
        || run.threadId !== input.run.threadId
        || run.rootRunId !== input.run.rootRunId
        || run.parentRunId !== input.run.parentRunId
        || run.delegationId !== input.run.delegationId
        || run.kind !== "delegated"
        || run.agentRole !== input.run.agentRole
        || run.responseMessageId !== input.responseMessageId) {
        return { status: "lease_lost", runId: input.run.id, responseMessageId: input.responseMessageId };
      }

      const delegation = await trx<RawDelegation>("o_agent_delegation")
        .where({
          id: input.run.delegationId,
          workspaceId: input.run.workspaceId,
          projectId: input.run.projectId,
          parentRunId: input.run.parentRunId,
          boundRunId: input.run.id,
          granteeRole: input.run.agentRole,
        })
        .first();
      if (!delegation
        || Number(delegation.taskVersion) !== contract.taskVersion
        || delegation.taskHash !== input.taskHash
        || hashIdempotencyRequest(contract.normalizeTask(parseJson(delegation.taskJson), {
          expectedProjectId: input.run.projectId,
        })) !== input.taskHash
        || delegation.resultJson != null
        || delegation.resultHash != null
        || delegation.resultMessageId != null) {
        throw new DelegatedProcessorSafeError("delegated_task_checkpoint_invalid", "专项任务终态检查点无效");
      }
      const allowedTaskStatuses = normalizedResult.status === "cancelled" ? ["queued", "running"] : ["running"];
      if (!allowedTaskStatuses.includes(String(delegation.taskStatus))) {
        return { status: "lease_lost", runId: run.id, responseMessageId: input.responseMessageId };
      }

      const response = await trx<RawMessage>("o_agent_message")
        .where({
          id: input.responseMessageId,
          workspaceId: input.run.workspaceId,
          projectId: input.run.projectId,
          threadId: input.run.threadId,
          runId: input.run.id,
          role: "assistant",
          agentRole: input.run.agentRole,
          visibility: "internal",
          status: "pending",
        })
        .first();
      if (!response) throw new DelegatedProcessorSafeError("delegated_response_invalid", "专项结果消息检查点无效");

      const runningModelSteps = await trx<RawStep>("o_agent_step")
        .where({ runId: run.id, kind: "model", status: "running" })
        .orderBy("seq", "asc");
      if (normalizedResult.status !== "cancelled" && runningModelSteps.length > 0) {
        throw new DelegatedProcessorSafeError("delegated_model_checkpoint_invalid", "专项模型仍存在未完成检查点");
      }
      if (normalizedResult.status === "cancelled" && runningModelSteps.some((step) => (
        dispatchState(step) === "dispatched" && step.id !== input.knownModelResultStepId
      ))) {
        return { status: "lease_lost", runId: run.id, responseMessageId: input.responseMessageId };
      }

      const maxStep = await trx("o_agent_step").where({ runId: run.id }).max({ seq: "seq" }).first();
      const resultStepSeq = Math.max(Number(run.checkpointStepSeq || 0), Number(maxStep?.seq || 0)) + 1;
      const resultStepStatus = normalizedResult.status === "failed"
        ? "failed"
        : normalizedResult.status === "cancelled" ? "cancelled" : "succeeded";
      const resultStep: RawStep = {
        id: input.resultStepId,
        workspaceId: input.run.workspaceId,
        projectId: input.run.projectId,
        threadId: input.run.threadId,
        runId: input.run.id,
        parentStepId: null,
        seq: resultStepSeq,
        agentRole: input.run.agentRole,
        kind: "artifact",
        status: resultStepStatus,
        toolName: null,
        argumentsDigest: null,
        inputRefs: [{ type: "delegated_task_hash", value: input.taskHash }],
        outputRefs: [{
          type: RESULT_REF,
          status: normalizedResult.status,
          resultHash: input.resultHash,
          resultMessageId: input.responseMessageId,
        }],
        idempotencyKey: resultStepKey(input.run.id),
        resolvedModel: null,
        provider: null,
        usage: normalizedResult.usage,
        costMicros: 0,
        errorCategory: input.safeError?.code ?? null,
        safeError: input.safeError,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: now,
      };

      // Win the child completion/cancellation race before writing any sibling
      // terminal record. Later writes remain in this transaction and therefore
      // roll back together if any invariant fails.
      const terminalRunStatus = normalizedResult.status === "failed"
        ? "failed"
        : normalizedResult.status === "cancelled" ? "cancelled" : "succeeded";
      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          leaseOwner: input.workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .whereIn("status", expectedRunStatuses)
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: terminalRunStatus,
          waitType: null,
          waitRef: null,
          wakeAt: null,
          checkpointStepSeq: resultStepSeq,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: input.safeError ? JSON.stringify(input.safeError) : null,
          completedAt: now,
          version: runVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(runUpdated) !== 1) {
        return { status: "lease_lost", runId: run.id, responseMessageId: input.responseMessageId };
      }

      for (const step of runningModelSteps) {
        const updated = await trx("o_agent_step")
          .where({ id: step.id, runId: run.id, kind: "model", status: "running" })
          .update({
            status: "cancelled",
            errorCategory: CANCELLED_ERROR.code,
            safeError: JSON.stringify(CANCELLED_ERROR),
            updatedAt: now,
            completedAt: now,
          });
        if (affectedRows(updated) !== 1) {
          throw new DelegatedProcessorSafeError("delegated_cancel_conflict", "专项模型取消状态冲突");
        }
      }

      await trx("o_agent_step").insert({
        ...resultStep,
        inputRefs: JSON.stringify(resultStep.inputRefs),
        outputRefs: JSON.stringify(resultStep.outputRefs),
        usage: JSON.stringify(resultStep.usage),
        safeError: input.safeError ? JSON.stringify(input.safeError) : null,
      });

      const delegationUpdated = await trx("o_agent_delegation")
        .where({ id: delegation.id, taskStatus: delegation.taskStatus, taskHash: input.taskHash })
        .whereNull("resultJson")
        .whereNull("resultHash")
        .whereNull("resultMessageId")
        .update({
          taskStatus: normalizedResult.status,
          resultJson: JSON.stringify(normalizedResult),
          resultHash: input.resultHash,
          resultMessageId: input.responseMessageId,
          completedAt: now,
          safeError: input.safeError ? JSON.stringify(input.safeError) : null,
          updatedAt: now,
        });
      if (affectedRows(delegationUpdated) !== 1) {
        throw new DelegatedProcessorSafeError("delegated_result_conflict", "专项任务结果写入冲突");
      }

      const messageStatus = normalizedResult.status === "failed"
        ? "error"
        : normalizedResult.status === "cancelled" ? "stopped" : "completed";
      const responseUpdated = await trx("o_agent_message")
        .where({ id: input.responseMessageId, runId: run.id, status: "pending", visibility: "internal" })
        .update({
          status: messageStatus,
          content: JSON.stringify(input.messageContent),
          error: input.safeError ? JSON.stringify(input.safeError) : null,
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(responseUpdated) !== 1) {
        throw new DelegatedProcessorSafeError("delegated_result_message_conflict", "专项任务结果消息写入冲突");
      }

      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: input.run.projectId })
        .first();
      if (!thread) throw new Error(`Delegated Run ${run.id} 对应 Thread 不存在`);
      const firstEventSeq = Number(thread.eventSeq || 0) + 1;
      const eventCount = runningModelSteps.length + 3;
      const threadVersion = Number(thread.version || 0);
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({
          eventSeq: firstEventSeq + eventCount - 1,
          version: threadVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Delegated Run ${run.id} 终态 Thread 版本冲突`);

      let eventSeq = firstEventSeq;
      for (const step of runningModelSteps) {
        const cancelled = asAgentStep({
          ...step,
          status: "cancelled",
          errorCategory: CANCELLED_ERROR.code,
          safeError: CANCELLED_ERROR,
          updatedAt: now,
          completedAt: now,
        });
        await this.eventAppender(trx, {
          workspaceId: run.workspaceId,
          projectId: input.run.projectId,
          threadId: run.threadId,
          runId: run.id,
          messageId: input.responseMessageId,
          stepId: step.id,
          seq: eventSeq++,
          type: "internal.step.cancelled",
          payload: { step: toAgentStepDto(cancelled), visibility: "internal" },
          createdAt: now,
        });
      }
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: input.run.projectId,
        threadId: run.threadId,
        runId: run.id,
        messageId: input.responseMessageId,
        stepId: input.resultStepId,
        seq: eventSeq++,
        type: `internal.step.${resultStepStatus === "succeeded" ? "completed" : resultStepStatus}`,
        payload: { step: toAgentStepDto(asAgentStep(resultStep)), visibility: "internal" },
        createdAt: now,
      });
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: input.run.projectId,
        threadId: run.threadId,
        runId: run.id,
        messageId: input.responseMessageId,
        seq: eventSeq++,
        type: `internal.message.${messageStatus}`,
        payload: { messageId: input.responseMessageId, status: messageStatus, visibility: "internal" },
        createdAt: now,
      });
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: input.run.projectId,
        threadId: run.threadId,
        runId: run.id,
        messageId: input.responseMessageId,
        seq: eventSeq,
        type: `internal.run.${terminalRunStatus}`,
        payload: { runId: run.id, status: terminalRunStatus, agentRole: input.run.agentRole, visibility: "internal" },
        createdAt: now,
      });

      // Deliberately leave thread.activeRootRunId and lastMessageAt untouched.
      return { status: expectedProcessStatus, runId: run.id, responseMessageId: input.responseMessageId };
    });
  }
}

export class DelegatedAgentRunProcessor {
  private readonly database: Knex;
  private readonly model: DelegatedAgentModelExecutor;
  private readonly gateway: DelegatedAgentToolGateway;
  private readonly terminalCommitter: DelegatedAgentTerminalCommitter;
  private readonly clock: () => number;
  private readonly messageIdFactory: () => string;
  private readonly stepIdFactory: () => string;
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  private readonly maxArgumentBytes: number;
  private readonly maxResultBytes: number;
  private readonly maxFinalBytes: number;
  private readonly hooks: DelegatedAgentRunProcessorHooks;
  private readonly eventAppender: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;

  constructor(options: DelegatedAgentRunProcessorOptions) {
    this.database = options.database;
    this.model = options.model;
    this.gateway = options.gateway;
    this.clock = options.clock ?? Date.now;
    this.messageIdFactory = options.messageIdFactory ?? randomUUID;
    this.stepIdFactory = options.stepIdFactory ?? randomUUID;
    this.maxTurns = boundedPositiveInteger(options.maxTurns, MAX_TURNS, MAX_TURNS, "maxTurns");
    this.maxToolCalls = boundedPositiveInteger(options.maxToolCalls, MAX_TOOL_CALLS, MAX_TOOL_CALLS, "maxToolCalls");
    this.maxArgumentBytes = boundedPositiveInteger(
      options.maxArgumentBytes,
      MAX_ARGUMENT_BYTES,
      MAX_ARGUMENT_BYTES,
      "maxArgumentBytes",
    );
    this.maxResultBytes = boundedPositiveInteger(
      options.maxResultBytes,
      MAX_RESULT_BYTES,
      MAX_RESULT_BYTES,
      "maxResultBytes",
    );
    this.maxFinalBytes = boundedPositiveInteger(
      options.maxFinalBytes,
      MAX_FINAL_BYTES,
      MAX_FINAL_BYTES,
      "maxFinalBytes",
    );
    this.hooks = options.hooks ?? {};
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
    this.terminalCommitter = options.terminalCommitter ?? new ChildOnlyDelegatedAgentTerminalCommitter({
      database: this.database,
      clock: this.clock,
      eventAppender: this.eventAppender,
    });
  }

  private async lockRunWithFreshClock(
    trx: Knex.Transaction,
    runId: string,
  ): Promise<{ run: RawRun | undefined; now: number }> {
    const run = await trx<RawRun>("o_agent_run").where({ id: runId }).forUpdate().first();
    return { run, now: this.clock() };
  }

  async process(input: AgentRunProcessInput): Promise<AgentRunProcessResult> {
    const workerId = input.workerId.trim();
    if (!workerId || input.claimedRun.leaseOwner !== workerId) {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: null };
    }
    const prepared = await this.ensureInternalResponse(input, workerId);
    if (prepared.kind === "lease_lost") {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: prepared.responseMessageId };
    }
    if (prepared.kind === "terminal") return prepared.result;

    const stopAtBoundary = async (knownModelResultStepId: string | null = null): Promise<AgentRunProcessResult | null> => {
      const status = await this.inspectCancellation(prepared, input, workerId, knownModelResultStepId);
      if (status === "continue") return null;
      if (status === "unsafe") {
        await this.markRunningDispatchedUncertain(prepared);
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: UNCERTAIN_ERROR,
          finalOutput: null,
          knownModelResultStepId: null,
        });
      }
      if (status === "lease_lost") {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      await input.beforeFinalize?.();
      return this.commitTerminal(prepared, input, workerId, {
        status: "cancelled",
        safeError: CANCELLED_ERROR,
        finalOutput: null,
        knownModelResultStepId,
      });
    };

    const initiallyCancelled = await stopAtBoundary();
    if (initiallyCancelled) return initiallyCancelled;

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      let step = await this.findModelStep(prepared.run.id, turn);
      if (!step) {
        step = await this.createModelStep(prepared, turn, input, workerId);
        if (!step) {
          const cancelled = await stopAtBoundary();
          return cancelled ?? { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
        }
        await this.hooks.afterModelStepPrepared?.({ runId: prepared.run.id, turn, stepId: step.id });
      }

      if (step.status === "uncertain") {
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: UNCERTAIN_ERROR,
          finalOutput: null,
          knownModelResultStepId: null,
        });
      }
      if (step.status === "running" && dispatchState(step) === "dispatched") {
        await this.markModelUncertain(prepared, step);
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: UNCERTAIN_ERROR,
          finalOutput: null,
          knownModelResultStepId: null,
        });
      }
      if (step.status === "failed") {
        const persistedError = parseJson(step.safeError) as Record<string, unknown> | null;
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: {
            code: typeof persistedError?.code === "string" ? persistedError.code : GENERIC_FAILURE.code,
            message: typeof persistedError?.message === "string" ? persistedError.message : GENERIC_FAILURE.message,
          },
          finalOutput: null,
          knownModelResultStepId: null,
        });
      }
      if (step.status === "running") {
        const stopped = await stopAtBoundary();
        if (stopped) return stopped;
        const execution = await this.executeModelTurn(prepared, step, turn, input, workerId);
        if (execution.kind === "crash") throw execution.error;
        if (execution.kind === "lease_lost") {
          return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
        }
        if (execution.kind === "cancelled") return execution.result;
        if (execution.kind === "failed") {
          await input.beforeFinalize?.();
          return this.commitTerminal(prepared, input, workerId, {
            status: "failed",
            safeError: execution.error,
            finalOutput: null,
            knownModelResultStepId: null,
          });
        }
        step = execution.step;
        await this.hooks.afterModelResultRecorded?.({ runId: prepared.run.id, turn, stepId: step.id });
      }

      const stoppedAfterModel = await stopAtBoundary(step.id);
      if (stoppedAfterModel) return stoppedAfterModel;
      if (step.status !== "succeeded") {
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: { code: "delegated_model_step_invalid", message: "专项模型 Turn 检查点状态无效" },
          finalOutput: null,
          knownModelResultStepId: null,
        });
      }

      const result = storedTurnResult(step);
      if (!result || result.turn !== turn) {
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: { code: "delegated_model_checkpoint_invalid", message: "专项模型 Turn 检查点内容无效" },
          finalOutput: null,
          knownModelResultStepId: null,
        });
      }
      if (result.outcome === "final") {
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: result.finalOutput?.status ?? "failed",
          safeError: result.finalOutput ? null : GENERIC_FAILURE,
          finalOutput: result.finalOutput,
          knownModelResultStepId: step.id,
        });
      }

      let toolResults = result.toolResults;
      if (toolResults.length === 0) {
        const totalBefore = await this.countPersistedToolCalls(prepared.run.id);
        if (totalBefore + result.calls.length > this.maxToolCalls) {
          await input.beforeFinalize?.();
          return this.commitTerminal(prepared, input, workerId, {
            status: "failed",
            safeError: { code: "delegated_tool_call_limit_exceeded", message: "专项模型工具调用数量超过安全上限" },
            finalOutput: null,
            knownModelResultStepId: null,
          });
        }

        let catalog: readonly AgentToolCatalogDefinition[];
        try {
          catalog = assertCatalog(
            await this.gateway.listDelegatedModelToolCandidates(prepared.run.id),
            prepared.policy,
          );
        } catch (error) {
          const cancelled = await stopAtBoundary();
          if (cancelled) return cancelled;
          await input.beforeFinalize?.();
          return this.commitTerminal(prepared, input, workerId, {
            status: "failed",
            safeError: safeError(error),
            finalOutput: null,
            knownModelResultStepId: null,
          });
        }
        const byName = new Map(catalog.map((definition) => [definition.manifest.name, definition]));
        const next: DelegatedAgentToolResult[] = [];
        for (let index = 0; index < result.calls.length; index += 1) {
          const call = result.calls[index];
          const definition = byName.get(call.name as never);
          if (!definition
            || definition.manifest.riskClass !== "R0"
            || definition.manifest.mutatesState
            || definition.manifest.metered
            || call.name === "agent.delegate") {
            await input.beforeFinalize?.();
            return this.commitTerminal(prepared, input, workerId, {
              status: "failed",
              safeError: { code: "delegated_tool_not_available", message: "专项模型请求的工具不在 R0 授权目录内" },
              finalOutput: null,
              knownModelResultStepId: null,
            });
          }
          const stoppedBeforeTool = await stopAtBoundary();
          if (stoppedBeforeTool) return stoppedBeforeTool;
          let gatewayResult: AgentToolGatewayExecuteResult;
          try {
            gatewayResult = await this.gateway.execute({
              runId: prepared.run.id,
              toolName: call.name,
              arguments: call.arguments,
              approvalId: null,
              idempotencyKey: toolCallKey(turn, index, call),
              claimFence: { workerId, attempt: input.claimedRun.attempt },
            });
            byteLength(
              gatewayResult.output,
              "delegated_tool_result_too_large",
              "专项工具结果超过模型回注安全上限",
              this.maxResultBytes,
            );
          } catch (error) {
            const cancelled = await stopAtBoundary();
            if (cancelled) return cancelled;
            await input.beforeFinalize?.();
            return this.commitTerminal(prepared, input, workerId, {
              status: "failed",
              safeError: safeError(error),
              finalOutput: null,
              knownModelResultStepId: null,
            });
          }
          await this.hooks.afterToolExecute?.({ runId: prepared.run.id, turn, call, result: gatewayResult });
          const stoppedAfterTool = await stopAtBoundary();
          if (stoppedAfterTool) return stoppedAfterTool;
          next.push({
            callId: call.id,
            name: call.name,
            stepId: gatewayResult.stepId,
            output: gatewayResult.output,
          });
        }
        toolResults = next;
        const recorded = await this.recordToolResults(prepared, step, result, toolResults, input, workerId);
        if (!recorded) {
          const cancelled = await stopAtBoundary();
          return cancelled ?? { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
        }
        await this.hooks.afterToolResultsRecorded?.({ runId: prepared.run.id, turn, toolResults });
      }

      if (turn === this.maxTurns) {
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: { code: "delegated_model_turn_limit_exceeded", message: "专项模型工具循环超过最大 Turn 数" },
          finalOutput: null,
          knownModelResultStepId: null,
        });
      }
    }

    throw new Error("unreachable delegated loop state");
  }

  private async ensureInternalResponse(
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<PrepareResult> {
    return this.database.transaction(async (trx): Promise<PrepareResult> => {
      const { run, now } = await this.lockRunWithFreshClock(trx, input.claimedRun.id);
      if (!run) return { kind: "lease_lost", responseMessageId: null };

      if (["succeeded", "failed", "cancelled"].includes(run.status) && run.responseMessageId && run.delegationId) {
        const role = cleanRole(run.agentRole);
        const delegation = await trx<RawDelegation>("o_agent_delegation")
          .where({ id: run.delegationId, boundRunId: run.id })
          .first();
        const response = await trx<RawMessage>("o_agent_message")
          .where({ id: run.responseMessageId, runId: run.id, visibility: "internal" })
          .first();
        const taskStatus = delegation?.taskStatus;
        const expectedRunStatus = taskStatus === "failed" ? "failed" : taskStatus === "cancelled" ? "cancelled" : "succeeded";
        const expectedMessageStatus = taskStatus === "failed" ? "error" : taskStatus === "cancelled" ? "stopped" : "completed";
        let contract: AgentDelegationPersistenceContract | null = null;
        let task: AgentTask | null = null;
        try {
          if (!delegation || typeof delegation.taskHash !== "string") throw new Error("missing delegation");
          const policy = parseA4DelegatedRunPolicySnapshot(run.policySnapshot, {
            expectedRole: role,
            expectedDelegationId: run.delegationId,
            expectedParentRunId: cleanId(run.parentRunId),
            expectedParentStepId: delegation.parentStepId,
            expectedTaskHash: delegation.taskHash,
          });
          contract = persistenceContractForPolicy(policy);
          if (Number(delegation.taskVersion) !== contract.taskVersion) throw new Error("task version mismatch");
          task = contract.normalizeTask(parseJson(delegation.taskJson), {
            expectedProjectId: Number(run.projectId),
          });
        } catch {
          contract = null;
          task = null;
        }
        const persistedResult = contract
          ? parsePersistedTaskResult(delegation?.resultJson, contract, role)
          : null;
        if ((taskStatus === "succeeded" || taskStatus === "needs_input" || taskStatus === "failed" || taskStatus === "cancelled")
          && contract !== null
          && task?.role === role
          && delegation?.taskHash === hashIdempotencyRequest(task)
          && run.status === expectedRunStatus
          && response?.status === expectedMessageStatus
          && delegation?.resultMessageId === run.responseMessageId
          && typeof delegation.resultHash === "string"
          && persistedResult?.status === taskStatus
          && hashIdempotencyRequest(persistedResult) === delegation.resultHash) {
          return {
            kind: "terminal",
            result: {
              status: taskStatus,
              runId: run.id,
              responseMessageId: run.responseMessageId,
            },
          };
        }
        return { kind: "lease_lost", responseMessageId: run.responseMessageId };
      }

      if (!hasCurrentLiveLease(run, workerId, input.claimedRun.attempt, now)
        || !["running", "cancelling"].includes(run.status)
        || run.kind !== "delegated"
        || !run.parentRunId
        || !run.delegationId
        || run.rootRunId === run.id) {
        return { kind: "lease_lost", responseMessageId: run.responseMessageId };
      }
      const role = cleanRole(run.agentRole);
      const delegation = await trx<RawDelegation>("o_agent_delegation")
        .where({
          id: run.delegationId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          parentRunId: run.parentRunId,
          boundRunId: run.id,
          granteeRole: role,
        })
        .first();
      if (!delegation || !["queued", "running"].includes(String(delegation.taskStatus))) {
        throw new DelegatedProcessorSafeError("delegated_task_checkpoint_invalid", "专项任务检查点不存在或状态无效");
      }
      let policy: A4DelegatedRunPolicySnapshot;
      let contract: AgentDelegationPersistenceContract;
      try {
        policy = parseA4DelegatedRunPolicySnapshot(run.policySnapshot, {
          expectedRole: role,
          expectedDelegationId: run.delegationId,
          expectedParentRunId: run.parentRunId,
          expectedParentStepId: delegation.parentStepId,
          expectedTaskHash: delegation.taskHash ?? undefined,
        });
        contract = persistenceContractForPolicy(policy);
      } catch {
        throw new DelegatedProcessorSafeError("delegated_run_policy_invalid", "专项 Agent Run 的固定策略无效");
      }
      if (Number(delegation.taskVersion) !== contract.taskVersion) {
        throw new DelegatedProcessorSafeError("delegated_task_checkpoint_invalid", "专项任务持久化版本无效");
      }
      let task: AgentTask;
      try {
        task = contract.normalizeTask(parseJson(delegation.taskJson), { expectedProjectId: Number(run.projectId) });
      } catch {
        throw new DelegatedProcessorSafeError("delegated_task_checkpoint_invalid", "专项任务检查点格式无效");
      }
      if (task.role !== role
        || typeof delegation.taskHash !== "string"
        || hashIdempotencyRequest(task) !== delegation.taskHash
        || delegation.resultJson != null
        || delegation.resultHash != null
        || delegation.resultMessageId != null
        || delegation.completedAt != null) {
        throw new DelegatedProcessorSafeError("delegated_task_checkpoint_invalid", "专项任务检查点绑定无效");
      }
      // This verifies the signed Grant, current actor/project/session access,
      // parent/child/Step binding, task hash and exact role-specific R0 scope.
      await this.gateway.assertDelegatedModelDispatchAuthorizedInTransaction(trx, run.id);

      const trigger = await trx<RawMessage>("o_agent_message")
        .where({
          id: run.triggerMessageId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          role: "user",
          visibility: "internal",
          status: "completed",
        })
        .first();
      if (!trigger || Number(trigger.createdBy) !== Number(delegation.actorUserId)) {
        throw new DelegatedProcessorSafeError("delegated_trigger_invalid", "专项 Agent 内部触发消息无效");
      }
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Delegated Run ${run.id} 对应 Thread 不存在`);

      let responseMessageId = run.responseMessageId;
      if (responseMessageId) {
        const response = await trx<RawMessage>("o_agent_message")
          .where({
            id: responseMessageId,
            workspaceId: run.workspaceId,
            projectId: Number(run.projectId),
            threadId: run.threadId,
            runId: run.id,
            replyToId: trigger.id,
            role: "assistant",
            agentRole: role,
            visibility: "internal",
            status: "pending",
          })
          .first();
        if (!response || delegation.taskStatus !== "running" || delegation.startedAt == null) {
          throw new DelegatedProcessorSafeError("delegated_response_invalid", "专项 Agent 内部响应检查点无效");
        }
      } else {
        responseMessageId = this.messageIdFactory();
        const runVersion = Number(run.version || 0);
        const runUpdated = await trx("o_agent_run")
          .where({
            id: run.id,
            workspaceId: run.workspaceId,
            status: run.status,
            leaseOwner: workerId,
            attempt: input.claimedRun.attempt,
            version: runVersion,
          })
          .andWhere("leaseExpiresAt", ">", now)
          .whereNull("responseMessageId")
          .update({ responseMessageId, version: runVersion + 1, updatedAt: now });
        if (affectedRows(runUpdated) !== 1) return { kind: "lease_lost", responseMessageId: null };

        const nextTaskStatus = run.status === "running" ? "running" : delegation.taskStatus;
        if (run.status === "running") {
          const taskUpdated = await trx("o_agent_delegation")
            .where({ id: delegation.id, taskHash: delegation.taskHash, taskStatus: "queued" })
            .whereNull("startedAt")
            .update({ taskStatus: "running", startedAt: now, updatedAt: now });
          if (delegation.taskStatus === "queued" && affectedRows(taskUpdated) !== 1) {
            throw new DelegatedProcessorSafeError("delegated_task_start_conflict", "专项任务启动检查点冲突");
          }
          if (delegation.taskStatus === "running" && delegation.startedAt == null) {
            const repaired = await trx("o_agent_delegation")
              .where({ id: delegation.id, taskHash: delegation.taskHash, taskStatus: "running" })
              .whereNull("startedAt")
              .update({ startedAt: now, updatedAt: now });
            if (affectedRows(repaired) !== 1) {
              throw new DelegatedProcessorSafeError("delegated_task_start_conflict", "专项任务启动时间写入冲突");
            }
          }
        }

        const messageSeq = Number(thread.messageSeq || 0) + 1;
        const firstEventSeq = Number(thread.eventSeq || 0) + 1;
        const threadVersion = Number(thread.version || 0);
        const threadUpdated = await trx("o_agent_thread")
          .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
          .update({
            messageSeq,
            eventSeq: firstEventSeq + 1,
            version: threadVersion + 1,
            updatedAt: now,
          });
        if (affectedRows(threadUpdated) !== 1) throw new Error(`Delegated Run ${run.id} 创建响应时 Thread 版本冲突`);
        await trx("o_agent_message").insert({
          id: responseMessageId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          replyToId: trigger.id,
          clientMessageId: null,
          seq: messageSeq,
          role: "assistant",
          agentRole: role,
          visibility: "internal",
          status: "pending",
          content: JSON.stringify([]),
          referenceRefs: JSON.stringify([]),
          createdBy: null,
          error: null,
          metadata: JSON.stringify({ source: "agent-runtime-delegated-r0", taskHash: delegation.taskHash }),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
        await this.eventAppender(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          seq: firstEventSeq,
          type: "internal.message.created",
          payload: { messageId: responseMessageId, seq: messageSeq, role: "assistant", status: "pending", visibility: "internal" },
          createdAt: now,
        });
        await this.eventAppender(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          seq: firstEventSeq + 1,
          type: "internal.run.started",
          payload: { runId: run.id, status: run.status, agentRole: role, attempt: input.claimedRun.attempt, visibility: "internal" },
          createdAt: now,
        });
        run.responseMessageId = responseMessageId;
        run.version = runVersion + 1;
        delegation.taskStatus = nextTaskStatus;
        if (run.status === "running") delegation.startedAt = delegation.startedAt ?? now;
      }
      return { kind: "ready", run, trigger, delegation, task, policy, contract, responseMessageId };
    });
  }

  private async findModelStep(runId: string, turn: number): Promise<RawStep | null> {
    return await this.database<RawStep>("o_agent_step")
      .where({ runId, kind: "model", idempotencyKey: modelStepKey(runId, turn) })
      .first() ?? null;
  }

  private async createModelStep(
    prepared: PreparedDelegatedLoop,
    turn: number,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<RawStep | null> {
    return this.database.transaction(async (trx): Promise<RawStep | null> => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return null;
      const existing = await trx<RawStep>("o_agent_step")
        .where({ runId: run.id, kind: "model", idempotencyKey: modelStepKey(run.id, turn) })
        .first();
      if (existing) return existing;
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Delegated Run ${run.id} 创建模型 Turn 时 Thread 不存在`);
      const maxStep = await trx("o_agent_step").where({ runId: run.id }).max({ seq: "seq" }).first();
      const seq = Math.max(Number(run.checkpointStepSeq || 0), Number(maxStep?.seq || 0)) + 1;
      const requestKey = modelRequestKey(run.id, turn);
      const refs = [
        { type: MODEL_DISPATCH_REF, value: "prepared" },
        { type: MODEL_TURN_REF, value: turn },
        { type: "model_request_id_digest", value: hashIdempotencyRequest({ requestId: requestKey }) },
        { type: "model_idempotency_key_digest", value: hashIdempotencyRequest({ idempotencyKey: requestKey }) },
        { type: "delegated_task_hash", value: prepared.delegation.taskHash },
      ];
      const step: RawStep = {
        id: this.stepIdFactory(),
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        parentStepId: null,
        seq,
        agentRole: run.agentRole,
        kind: "model",
        status: "running",
        toolName: null,
        argumentsDigest: null,
        inputRefs: refs,
        outputRefs: [],
        idempotencyKey: modelStepKey(run.id, turn),
        resolvedModel: prepared.policy.modelAlias,
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
      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({ checkpointStepSeq: seq, version: runVersion + 1, updatedAt: now });
      if (affectedRows(runUpdated) !== 1) return null;
      const threadVersion = Number(thread.version || 0);
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Delegated Run ${run.id} 模型 Turn Thread 版本冲突`);
      await trx("o_agent_step").insert({
        ...step,
        inputRefs: JSON.stringify(step.inputRefs),
        outputRefs: JSON.stringify([]),
        usage: JSON.stringify({}),
      });
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: step.id,
        seq: eventSeq,
        type: "internal.step.started",
        payload: { step: toAgentStepDto(asAgentStep(step)), visibility: "internal" },
        createdAt: now,
      });
      return step;
    });
  }

  private async executeModelTurn(
    prepared: PreparedDelegatedLoop,
    step: RawStep,
    turn: number,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<
    | { kind: "succeeded"; step: RawStep }
    | { kind: "failed"; error: { code: string; message: string } }
    | { kind: "cancelled"; result: AgentRunProcessResult }
    | { kind: "lease_lost" }
    | { kind: "crash"; error: unknown }
  > {
    const requestKey = modelRequestKey(prepared.run.id, turn);
    let dispatchCommitted = false;
    let checkpointUsed = false;
    let hookCrash: unknown = null;
    let raw: DelegatedAgentModelResult;
    try {
      const catalog = assertCatalog(
        await this.gateway.listDelegatedModelToolCandidates(prepared.run.id),
        prepared.policy,
      );
      const transcript = await this.buildTranscript(prepared, turn);
      raw = await this.model.executeTurn({
        run: {
          id: prepared.run.id,
          workspaceId: prepared.run.workspaceId,
          projectId: Number(prepared.run.projectId),
          threadId: prepared.run.threadId,
          agentRole: cleanRole(prepared.run.agentRole),
        },
        turn,
        requestId: requestKey,
        idempotencyKey: requestKey,
        transcript,
        tools: catalog,
        checkpointExternalDispatch: async () => {
          if (checkpointUsed) {
            throw new DelegatedProcessorSafeError(
              "delegated_model_dispatch_checkpoint_reused",
              "同一专项模型 Turn 只能 dispatch 一次",
            );
          }
          checkpointUsed = true;
          await this.checkpointModelDispatch(prepared, step, turn, input, workerId);
          dispatchCommitted = true;
          try {
            await this.hooks.afterModelDispatchCheckpoint?.({ runId: prepared.run.id, turn, stepId: step.id });
          } catch (error) {
            hookCrash = error;
            throw error;
          }
        },
      });
      if (!dispatchCommitted) {
        throw new DelegatedProcessorSafeError(
          "delegated_model_dispatch_checkpoint_missing",
          "专项模型调用未执行持久化 dispatch 检查点",
        );
      }
    } catch (error) {
      if (hookCrash !== null) return { kind: "crash", error: hookCrash };
      if (dispatchCommitted) {
        await this.markModelUncertain(prepared, step);
        const run = await this.database<RawRun>("o_agent_run").where({ id: prepared.run.id }).first();
        return run && ["running", "cancelling"].includes(run.status)
          && hasCurrentLiveLease(run, workerId, input.claimedRun.attempt, this.clock())
          ? { kind: "failed", error: UNCERTAIN_ERROR }
          : { kind: "lease_lost" };
      }
      const persisted = await this.markPreparedModelFailed(prepared, step, safeError(error), input, workerId);
      return persisted ? { kind: "failed", error: safeError(error) } : { kind: "lease_lost" };
    }

    // Deliberately outside the model error boundary: this hook represents a
    // process crash after provider return. Recovery must see dispatched and
    // terminate uncertain instead of retrying the provider request.
    await this.hooks.afterModelProviderReturned?.({ runId: prepared.run.id, turn, stepId: step.id });

    let result: StoredModelTurnResult;
    try {
      result = cleanModelResult(raw, turn, {
        maxArgumentBytes: this.maxArgumentBytes,
        maxToolCalls: this.maxToolCalls,
        maxFinalBytes: this.maxFinalBytes,
      }, prepared.task.role);
      const cancellation = await this.inspectCancellation(prepared, input, workerId, step.id);
      if (cancellation === "cancel") {
        await input.beforeFinalize?.();
        const committed = await this.commitTerminal(prepared, input, workerId, {
          status: "cancelled",
          safeError: CANCELLED_ERROR,
          finalOutput: null,
          knownModelResultStepId: step.id,
        });
        return { kind: "cancelled", result: committed };
      }
      if (cancellation !== "continue") {
        await this.markModelUncertain(prepared, step);
        return { kind: "lease_lost" };
      }
      const committed = await this.commitModelResult(prepared, step, result, input, workerId);
      if (!committed) {
        await this.markModelUncertain(prepared, step);
        return { kind: "lease_lost" };
      }
      const stored = await this.findModelStep(prepared.run.id, turn);
      if (!stored) throw new Error("committed delegated model step disappeared");
      return { kind: "succeeded", step: stored };
    } catch (error) {
      await this.markModelUncertain(prepared, step);
      const run = await this.database<RawRun>("o_agent_run").where({ id: prepared.run.id }).first();
      return run && ["running", "cancelling"].includes(run.status)
        && hasCurrentLiveLease(run, workerId, input.claimedRun.attempt, this.clock())
        ? { kind: "failed", error: UNCERTAIN_ERROR }
        : { kind: "lease_lost" };
    }
  }

  private async checkpointModelDispatch(
    prepared: PreparedDelegatedLoop,
    step: RawStep,
    turn: number,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<void> {
    await this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || stored.status !== "running" || dispatchState(stored) !== "prepared") {
        throw new DelegatedProcessorSafeError("delegated_model_dispatch_checkpoint_invalid", "专项模型 dispatch 检查点无效");
      }
      if (!hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        throw new DelegatedProcessorSafeError("delegated_model_dispatch_lease_lost", "专项模型请求发出前租约已失效");
      }
      await this.gateway.assertDelegatedModelDispatchAuthorizedInTransaction(trx, run.id);
      const policy = parseA4DelegatedRunPolicySnapshot(run.policySnapshot, {
        expectedRole: cleanRole(run.agentRole),
        expectedDelegationId: cleanId(run.delegationId),
        expectedParentRunId: cleanId(run.parentRunId),
        expectedParentStepId: prepared.policy.delegatedTask.parentStepId,
        expectedTaskHash: prepared.policy.delegatedTask.taskHash,
      });
      const contract = persistenceContractForPolicy(policy);
      if (contract !== prepared.contract
        || contract.policyVersion !== prepared.contract.policyVersion
        || contract.taskVersion !== prepared.contract.taskVersion
        || contract.resultVersion !== prepared.contract.resultVersion
        || contract.outputContractPrefix !== prepared.contract.outputContractPrefix) {
        throw new DelegatedProcessorSafeError("delegated_run_policy_invalid", "专项 Agent Run 的持久化契约发生变化");
      }
      if (turn > policy.delegatedTask.limits.maxTurns) {
        throw new DelegatedProcessorSafeError("delegated_model_turn_limit_exceeded", "专项模型 Turn 超过固定上限");
      }
      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({ sideEffectsCommitted: 1, version: runVersion + 1, updatedAt: now });
      if (affectedRows(runUpdated) !== 1) {
        throw new DelegatedProcessorSafeError("delegated_model_dispatch_lease_lost", "专项模型请求发出前租约已失效");
      }
      const updated = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "running", kind: "model" })
        .update({ inputRefs: JSON.stringify(withDispatchState(stored.inputRefs, "dispatched")), updatedAt: now });
      if (affectedRows(updated) !== 1) throw new Error("delegated model dispatch checkpoint lost");
    });
  }

  private async commitModelResult(
    prepared: PreparedDelegatedLoop,
    step: RawStep,
    result: StoredModelTurnResult,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx): Promise<boolean> => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;
      if (stored.status !== "running" || dispatchState(stored) !== "dispatched") return false;
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Delegated Run ${run.id} 保存模型 Turn 时 Thread 不存在`);
      const updated = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "running", kind: "model" })
        .update({
          status: "succeeded",
          outputRefs: JSON.stringify([result]),
          usage: JSON.stringify(result.usage),
          costMicros: 0,
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(updated) !== 1) return false;
      const threadVersion = Number(thread.version || 0);
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Delegated Run ${run.id} 模型结果 Thread 版本冲突`);
      const terminal = asAgentStep({
        ...stored,
        status: "succeeded",
        outputRefs: [result],
        usage: result.usage,
        updatedAt: now,
        completedAt: now,
      });
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: stored.id,
        seq: eventSeq,
        type: "internal.step.completed",
        payload: { step: toAgentStepDto(terminal), visibility: "internal" },
        createdAt: now,
      });
      return true;
    });
  }

  private async recordToolResults(
    prepared: PreparedDelegatedLoop,
    step: RawStep,
    result: StoredModelTurnResult,
    toolResults: DelegatedAgentToolResult[],
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx): Promise<boolean> => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;
      const latest = storedTurnResult(stored);
      if (!latest || latest.outcome !== "tool_calls" || latest.turn !== result.turn) {
        throw new DelegatedProcessorSafeError("delegated_tool_checkpoint_invalid", "专项工具回注检查点无效");
      }
      if (latest.toolResults.length > 0) {
        return hashIdempotencyRequest(latest.toolResults) === hashIdempotencyRequest(toolResults);
      }
      const updated = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "succeeded", kind: "model" })
        .update({ outputRefs: JSON.stringify([{ ...latest, toolResults }]), updatedAt: now });
      return affectedRows(updated) === 1;
    });
  }

  private async buildTranscript(
    prepared: PreparedDelegatedLoop,
    beforeTurn: number,
  ): Promise<DelegatedAgentModelTranscriptItem[]> {
    const transcript: DelegatedAgentModelTranscriptItem[] = [{ role: "user", task: prepared.task }];
    const steps = await this.database<RawStep>("o_agent_step")
      .where({ runId: prepared.run.id, kind: "model", status: "succeeded" })
      .orderBy("seq", "asc");
    for (const step of steps) {
      const result = storedTurnResult(step);
      if (!result || result.turn >= beforeTurn || result.outcome === "final") continue;
      transcript.push({ role: "assistant", text: result.assistantText, toolCalls: result.calls });
      for (const toolResult of result.toolResults) {
        transcript.push({
          role: "tool",
          callId: toolResult.callId,
          name: toolResult.name,
          output: toolResult.output,
        });
      }
    }
    return transcript;
  }

  private async countPersistedToolCalls(runId: string): Promise<number> {
    const steps = await this.database<RawStep>("o_agent_step")
      .where({ runId, kind: "model", status: "succeeded" })
      .select("outputRefs", "usage", "agentRole");
    return steps.reduce((total, step) => total + (storedTurnResult(step)?.toolResults.length ?? 0), 0);
  }

  private async aggregateUsage(
    runId: string,
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    const total = { inputTokens: 0, outputTokens: 0 };
    const steps = await this.database<RawStep>("o_agent_step")
      .where({ runId, kind: "model", status: "succeeded" })
      .orderBy("seq", "asc");
    for (const step of steps) {
      const result = storedTurnResult(step);
      if (!result) {
        throw new DelegatedProcessorSafeError("delegated_model_checkpoint_invalid", "专项模型 usage 检查点无效");
      }
      addUsage(total, result.usage);
    }
    return total;
  }

  private async markPreparedModelFailed(
    prepared: PreparedDelegatedLoop,
    step: RawStep,
    error: { code: string; message: string },
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx): Promise<boolean> => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;
      if (stored.status !== "running" || dispatchState(stored) !== "prepared") return false;
      return this.markModelStepTerminalInTransaction(trx, prepared, run, stored, "failed", error, now);
    });
  }

  private async markModelUncertain(prepared: PreparedDelegatedLoop, step: RawStep): Promise<void> {
    await this.database.transaction(async (trx) => {
      const run = await trx<RawRun>("o_agent_run").where({ id: prepared.run.id }).first();
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || stored.status !== "running" || dispatchState(stored) !== "dispatched") return;
      await this.markModelStepTerminalInTransaction(trx, prepared, run, stored, "uncertain", UNCERTAIN_ERROR, this.clock());
    });
  }

  private async markRunningDispatchedUncertain(prepared: PreparedDelegatedLoop): Promise<void> {
    const steps = await this.database<RawStep>("o_agent_step")
      .where({ runId: prepared.run.id, kind: "model", status: "running" })
      .orderBy("seq", "asc");
    for (const step of steps) {
      if (dispatchState(step) === "dispatched") await this.markModelUncertain(prepared, step);
    }
  }

  private async markModelStepTerminalInTransaction(
    trx: Knex.Transaction,
    prepared: PreparedDelegatedLoop,
    run: RawRun,
    step: RawStep,
    status: "failed" | "uncertain",
    error: { code: string; message: string },
    now: number,
  ): Promise<boolean> {
    const updated = await trx("o_agent_step")
      .where({ id: step.id, runId: run.id, status: "running", kind: "model" })
      .update({
        status,
        errorCategory: error.code,
        safeError: JSON.stringify(error),
        updatedAt: now,
        completedAt: now,
      });
    if (affectedRows(updated) !== 1) return false;
    const thread = await trx<RawThread>("o_agent_thread")
      .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
      .first();
    if (!thread) throw new Error(`Delegated Run ${run.id} 标记模型 Step 时 Thread 不存在`);
    const threadVersion = Number(thread.version || 0);
    const eventSeq = Number(thread.eventSeq || 0) + 1;
    const threadUpdated = await trx("o_agent_thread")
      .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
      .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
    if (affectedRows(threadUpdated) !== 1) throw new Error(`Delegated Run ${run.id} 标记模型 Step 时 Thread 版本冲突`);
    const terminal = asAgentStep({
      ...step,
      status,
      errorCategory: error.code,
      safeError: error,
      updatedAt: now,
      completedAt: now,
    });
    await this.eventAppender(trx, {
      workspaceId: run.workspaceId,
      projectId: Number(run.projectId),
      threadId: run.threadId,
      runId: run.id,
      messageId: prepared.responseMessageId,
      stepId: step.id,
      seq: eventSeq,
      type: `internal.step.${status}`,
      payload: { step: toAgentStepDto(terminal), visibility: "internal" },
      createdAt: now,
    });
    return true;
  }

  private async inspectCancellation(
    prepared: PreparedDelegatedLoop,
    input: AgentRunProcessInput,
    workerId: string,
    knownModelResultStepId: string | null,
  ): Promise<"continue" | "cancel" | "unsafe" | "lease_lost"> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || run.responseMessageId !== prepared.responseMessageId
        || !hasCurrentLiveLease(run, workerId, input.claimedRun.attempt, now)) return "lease_lost";
      if (run.status === "running") return "continue";
      if (run.status !== "cancelling") return "lease_lost";
      const running = await trx<RawStep>("o_agent_step")
        .where({ runId: run.id, kind: "model", status: "running" });
      if (running.some((step) => dispatchState(step) === "dispatched" && step.id !== knownModelResultStepId)) {
        return "unsafe";
      }
      return "cancel";
    });
  }

  private async commitTerminal(
    prepared: PreparedDelegatedLoop,
    input: AgentRunProcessInput,
    workerId: string,
    terminal: {
      status: "succeeded" | "needs_input" | "failed" | "cancelled";
      safeError: { code: string; message: string } | null;
      finalOutput: StoredModelTurnResult["finalOutput"];
      knownModelResultStepId: string | null;
    },
  ): Promise<AgentRunProcessResult> {
    const usage = await this.aggregateUsage(prepared.run.id);
    const modelProfile = `${prepared.policy.agentConfig.modelProfile.key}@${prepared.policy.agentConfig.modelProfile.version}`;
    const role = cleanRole(prepared.run.agentRole);
    let reviewReport: A4ReviewReport | null = null;
    if (terminal.status === "succeeded" && role === "reviewer") {
      try {
        reviewReport = createA4ReviewReport({
          ...terminal.finalOutput?.reviewReport,
          modelUsage: { modelProfile, ...usage, costMicros: null },
        }, { expectedProjectId: Number(prepared.run.projectId) });
      } catch {
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: {
            code: "delegated_model_result_invalid",
            message: "专项模型 Reviewer 报告语义无效",
          },
          finalOutput: null,
          knownModelResultStepId: terminal.knownModelResultStepId,
        });
      }
    }
    let result: AgentTaskResult;
    if (terminal.status === "succeeded" && terminal.finalOutput?.status === "succeeded") {
      result = prepared.contract.normalizeResult({
        version: prepared.contract.resultVersion,
        status: "succeeded",
        artifactRefs: [{ type: "message", id: prepared.responseMessageId, version: null }],
        summary: terminal.finalOutput.summary,
        assumptions: terminal.finalOutput.assumptions,
        issues: terminal.finalOutput.issues,
        suggestedNextActions: terminal.finalOutput.suggestedNextActions,
        usage: { modelProfile, ...usage, costMicros: null },
        ...(reviewReport === null
          ? {}
          : {
              review: {
                verdict: reviewReport.overall.verdict,
                reportDigest: reviewReport.canonicalHash,
              },
            }),
      }, { expectedRole: role });
    } else if (terminal.status === "needs_input" && terminal.finalOutput?.status === "needs_input") {
      result = prepared.contract.normalizeResult({
        version: prepared.contract.resultVersion,
        status: "needs_input",
        artifactRefs: [],
        summary: terminal.finalOutput.summary,
        assumptions: terminal.finalOutput.assumptions,
        issues: terminal.finalOutput.issues,
        suggestedNextActions: terminal.finalOutput.suggestedNextActions,
        usage: { modelProfile, ...usage, costMicros: null },
      }, { expectedRole: role });
    } else if (terminal.status === "cancelled") {
      result = prepared.contract.normalizeResult({
        version: prepared.contract.resultVersion,
        status: "cancelled",
        artifactRefs: [],
        summary: CANCELLED_ERROR.message,
        assumptions: [],
        issues: [],
        suggestedNextActions: [],
        usage: { modelProfile, ...usage, costMicros: null },
      }, { expectedRole: role });
    } else {
      const error = terminal.safeError ?? GENERIC_FAILURE;
      result = prepared.contract.normalizeResult({
        version: prepared.contract.resultVersion,
        status: "failed",
        artifactRefs: [],
        summary: "专项 Agent 未能完成结构化产物",
        assumptions: [],
        issues: [error.message],
        suggestedNextActions: ["由父 Agent 根据安全错误决定是否修正输入后重新委派"],
        usage: { modelProfile, ...usage, costMicros: null },
      }, { expectedRole: role });
    }
    const resultHash = hashIdempotencyRequest(result);
    const messageContent = result.status === "succeeded"
      ? [{
          type: "text",
          text: reviewReport === null
            ? terminal.finalOutput?.proposal ?? ""
            : JSON.stringify(reviewReport),
        }]
      : result.status === "needs_input" ? compactNeedsInputContent(result) : [];
    const committed = await this.terminalCommitter.commit({
      claimedRun: input.claimedRun,
      workerId,
      run: {
        id: prepared.run.id,
        workspaceId: prepared.run.workspaceId,
        projectId: Number(prepared.run.projectId),
        threadId: prepared.run.threadId,
        rootRunId: prepared.run.rootRunId,
        parentRunId: cleanId(prepared.run.parentRunId),
        delegationId: cleanId(prepared.run.delegationId),
        agentRole: cleanRole(prepared.run.agentRole),
      },
      responseMessageId: prepared.responseMessageId,
      task: prepared.task,
      taskHash: cleanId(prepared.delegation.taskHash),
      result,
      resultHash,
      resultStepId: this.stepIdFactory(),
      messageContent,
      reviewReport,
      safeError: result.status === "failed" || result.status === "cancelled"
        ? terminal.safeError ?? (result.status === "cancelled" ? CANCELLED_ERROR : GENERIC_FAILURE)
        : null,
      knownModelResultStepId: terminal.knownModelResultStepId,
    });
    if (committed.status === "lease_lost" && terminal.status !== "cancelled") {
      const cancellation = await this.inspectCancellation(
        prepared,
        input,
        workerId,
        terminal.knownModelResultStepId,
      );
      if (cancellation === "cancel") {
        return this.commitTerminal(prepared, input, workerId, {
          status: "cancelled",
          safeError: CANCELLED_ERROR,
          finalOutput: null,
          knownModelResultStepId: terminal.knownModelResultStepId,
        });
      }
    }
    if (committed.status !== "lease_lost") {
      await this.hooks.afterTerminalResultCommitted?.({
        runId: prepared.run.id,
        taskStatus: result.status,
        resultMessageId: prepared.responseMessageId,
      });
    }
    return committed;
  }
}
