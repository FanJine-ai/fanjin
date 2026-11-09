import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { toSafeAgentApprovalDto } from "@/agent-runtime/approvalDto";
import {
  AgentApprovalService,
  autoApproveAgentApprovalInTransaction,
  type AgentApproval,
  type AgentApprovalRevisionApplication,
} from "@/agent-runtime/approvalService";
import type { AgentDelegationCoordinator } from "@/agent-runtime/delegationCoordinator";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { appendAgentEvent, type AppendAgentEventInput } from "@/agent-runtime/eventStore";
import { isAgentAutoApproveEnabled } from "@/agent-runtime/featureFlags";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  agentMessageContextUsageFromSnapshot,
  agentMessageReferenceRefsMatchContextSnapshot,
} from "@/agent-runtime/messageContextSnapshot";
import {
  isMainAgentR1ModelToolIdV3,
  mayExposeMainAgentModelTool,
} from "@/agent-runtime/modelToolExposure";
import type { AgentRunProcessInput, AgentRunProcessResult } from "@/agent-runtime/runProcessor";
import { resolveAgentRuntimeConfigSnapshot } from "@/agent-runtime/runtimeConfigRegistry";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import { AgentMessageStreamSnapshotWriter } from "@/agent-runtime/messageStreamSnapshot";
import { publishAgentMessageDelta } from "@/agent-runtime/streamBus";
import type { AgentContentPart, AgentStep } from "@/agent-runtime/types";
import type { AgentToolGateway, AgentToolGatewayExecuteResult } from "@/agent-runtime/tools/gateway";
import { parseAgentDelegateInputForPromptVersion } from "@/agent-runtime/tools/packages/delegation";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import type { AgentToolCatalogDefinition } from "@/agent-runtime/tools/registry";
import {
  AGENT_PROJECT_BUDGET_COLUMN,
  AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
  PROJECT_TABLE,
} from "@/lib/migrations/agentProjectBudget";
import { logger } from "@/lib/logger";
import type { RelayChatResult } from "@/lib/relayChat";
import {
  buildToolLoopTranscript,
  findModelStep,
  countPersistedToolCalls,
} from "./toolLoopSnapshot";

const MODEL_STEP_PREFIX = "agent-model";
const MODEL_REQUEST_PREFIX = "agent-run";
const TOOL_LOOP_RESULT_REF = "model_turn_result";
const TOOL_LOOP_TURN_REF = "model_turn";
const MODEL_DISPATCH_REF = "model_dispatch_state";

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 16;
const DEFAULT_MAX_ARGUMENT_BYTES = 32 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_MAX_FINAL_TEXT_BYTES = 64 * 1024;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000;
const HARD_MAX_TURNS = 8;
const HARD_MAX_TOOL_CALLS = 32;
const HARD_MAX_ARGUMENT_BYTES = 64 * 1024;
const HARD_MAX_RESULT_BYTES = 256 * 1024;
const HARD_MAX_FINAL_TEXT_BYTES = 128 * 1024;

const TOOL_LOOP_UNCERTAIN_ERROR = {
  code: "model_outcome_uncertain",
  message: "模型请求发出后未能安全保存结果，已禁止自动重试",
} as const;

const CANCELLED_MESSAGE_ERROR = {
  code: "run_cancelled",
  message: "Agent 运行已取消",
} as const;

interface RawRun {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  rootRunId: string;
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
}

interface RawThread {
  id: string;
  activeRootRunId: string | null;
  messageSeq: number | string | null;
  eventSeq: number | string | null;
  version: number | string | null;
}

interface RawMessage {
  id: string;
  threadId: string;
  role: string;
  status: string;
  content: unknown;
  referenceRefs: unknown;
  metadata: unknown;
}

export interface RawStep {
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

export interface AgentToolLoopToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolLoopToolResult {
  callId: string;
  name: string;
  stepId: string;
  output: unknown;
}

export type AgentToolLoopModelResult =
  | { kind: "tool_calls"; calls: AgentToolLoopToolCall[]; assistantText?: string; reasoningContent?: string }
  | { kind: "final"; content: AgentContentPart[] };

export type AgentToolLoopTranscriptItem =
  | { role: "user"; content: AgentContentPart[] }
  | { role: "assistant"; text: string; reasoningContent?: string; toolCalls: AgentToolLoopToolCall[] }
  | { role: "tool"; callId: string; name: string; output: unknown };

export interface AgentToolLoopModelTurnInput {
  run: {
    id: string;
    workspaceId: string;
    projectId: number;
    threadId: string;
    agentRole: string;
  };
  turn: number;
  requestId: string;
  idempotencyKey: string;
  transcript: readonly AgentToolLoopTranscriptItem[];
  tools: readonly AgentToolCatalogDefinition[];
  checkpointExternalDispatch(): Promise<void>;
  recordBilling?(billing: { costMicros: number; usage: Record<string, unknown> }): Promise<void>;
  /**
   * 流式灰度(REVAMP-PLAN 4.1):模型 Turn 边收边推的增量正文回调。
   * 实现方必须同步、不抛异常;仅在 FANJIN_AGENT_STREAM_ENABLED 开启且
   * relay 真实返回 SSE 流时才会被调用,回调缺失时模型退回一次性响应。
   */
  onAssistantDelta?(delta: { turn: number; text: string }): void;
}

export interface AgentToolLoopModel {
  executeTurn(input: AgentToolLoopModelTurnInput): Promise<AgentToolLoopModelResult>;
}

export interface AgentToolLoopLifecycleHooks {
  /** Test-only crash seam after Gateway commit and before the loop checkpoint. */
  afterToolExecute?(input: {
    runId: string;
    turn: number;
    call: AgentToolLoopToolCall;
    result: AgentToolGatewayExecuteResult;
  }): Promise<void>;
  /** Test-only crash seam after the model Step durably records Tool results. */
  afterToolResultsRecorded?(input: {
    runId: string;
    turn: number;
    toolResults: readonly AgentToolLoopToolResult[];
  }): Promise<void>;
}

export interface AgentToolLoopProcessorOptions {
  database: Knex;
  model: AgentToolLoopModel;
  gateway: AgentToolGateway;
  approvalService?: AgentApprovalService;
  delegationCoordinator?: Pick<AgentDelegationCoordinator, "start">;
  clock?: () => number;
  messageIdFactory?: () => string;
  stepIdFactory?: () => string;
  maxTurns?: number;
  maxToolCalls?: number;
  maxArgumentBytes?: number;
  maxResultBytes?: number;
  maxFinalTextBytes?: number;
  hooks?: AgentToolLoopLifecycleHooks;
  eventAppender?: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
}

interface PreparedLoop {
  kind: "ready";
  run: RawRun;
  trigger: RawMessage;
  responseMessageId: string;
}

interface LostLoop {
  kind: "lease_lost";
  responseMessageId: string | null;
}

interface CancelledLoop {
  kind: "cancelled";
  responseMessageId: string;
}

type CancellationBoundaryResult =
  | { kind: "continue" }
  | { kind: "cancellation_pending" }
  | { kind: "cancelled" }
  | { kind: "lease_lost" }
  | { kind: "outcome_uncertain" };

/**
 * Audit marker written into the model-turn checkpoint when a
 * decide-with-revision rewrote the call arguments (REVAMP-PLAN 1.2-5). The
 * marker exempts the checkpoint from the pause-time calls-hash assertion and
 * lets recovery prove the executed call reflects the decided revision.
 */
export interface AgentApprovalCheckpointRevisionMarker {
  approvalId: string;
  revision: number;
  at: number;
}

interface AgentApprovalCheckpointCanonicalizationMarker {
  sourceArgumentsHash: string;
  canonicalArgumentsHash: string;
  at: number;
}

interface StoredModelTurnResult {
  type: typeof TOOL_LOOP_RESULT_REF;
  turn: number;
  outcome: "tool_calls" | "final";
  assistantText: string;
  reasoningContent?: string;
  calls: AgentToolLoopToolCall[];
  toolResults: AgentToolLoopToolResult[];
  content: AgentContentPart[];
  approvalId: string | null;
  argumentsRevised?: AgentApprovalCheckpointRevisionMarker | null;
  argumentsCanonicalized?: AgentApprovalCheckpointCanonicalizationMarker | null;
}

export class ToolLoopSafeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolLoopSafeError";
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
  hardMax: number,
  field: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > hardMax) {
    throw new TypeError(`${field} 必须是 1-${hardMax} 的整数`);
  }
  return normalized;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
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
  return `${MODEL_REQUEST_PREFIX}:${runId}:model-turn:${turn}`;
}

function toolCallKey(turn: number, index: number, call: AgentToolLoopToolCall): string {
  return `loop-t${turn}-c${index}-${hashIdempotencyRequest(call).slice(0, 24)}`;
}

function modelToolExposureScope(run: Pick<RawRun, "agentRole" | "policySnapshot">): {
  promptKey: string;
  promptVersion: string;
  delegationEnabled: unknown;
} {
  const policy = parseObject(run.policySnapshot);
  try {
    if (run.agentRole !== "main") throw new Error("unsupported Agent role");
    const config = resolveAgentRuntimeConfigSnapshot(policy.agentConfig, "main");
    return {
      promptKey: config.prompt.key,
      promptVersion: config.prompt.version,
      delegationEnabled: policy.delegationEnabled,
    };
  } catch {
    throw new ToolLoopSafeError(
      "agent_config_snapshot_invalid",
      "Run 的固定 Agent 配置快照无效，不能开放模型工具",
    );
  }
}

function filterModelToolCandidates(
  run: Pick<RawRun, "agentRole" | "policySnapshot">,
  candidates: readonly AgentToolCatalogDefinition[],
): readonly AgentToolCatalogDefinition[] {
  const scope = modelToolExposureScope(run);
  return candidates.filter(({ manifest }) => mayExposeMainAgentModelTool({
    ...scope,
    manifest,
  }));
}

function dispatchState(step: RawStep): "prepared" | "dispatched" | null {
  const value = parseArray<Record<string, unknown>>(step.inputRefs)
    .find((ref) => ref?.type === MODEL_DISPATCH_REF)?.value;
  return value === "prepared" || value === "dispatched" ? value : null;
}

function withDispatchState(value: unknown, state: "prepared" | "dispatched"): Record<string, unknown>[] {
  const refs = parseArray<Record<string, unknown>>(value);
  const next = refs.filter((ref) => ref?.type !== MODEL_DISPATCH_REF);
  next.unshift({ type: MODEL_DISPATCH_REF, value: state });
  return next;
}

function byteLength(value: unknown, code: string, message: string, limit: number): number {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ToolLoopSafeError(code, message);
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > limit) throw new ToolLoopSafeError(code, message);
  return bytes;
}

function cleanToolCalls(value: unknown, maxArgumentBytes: number): AgentToolLoopToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolLoopSafeError("model_tool_calls_invalid", "模型返回的工具调用格式无效");
  }
  const calls = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ToolLoopSafeError("model_tool_calls_invalid", "模型返回的工具调用格式无效");
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const args = record.arguments;
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)
      || !name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)
      || !args || typeof args !== "object" || Array.isArray(args)) {
      throw new ToolLoopSafeError("model_tool_calls_invalid", "模型返回的工具调用格式无效");
    }
    byteLength(args, "model_tool_arguments_too_large", "模型工具参数超过安全上限", maxArgumentBytes);
    return { id, name, arguments: JSON.parse(JSON.stringify(args)) as Record<string, unknown> };
  });
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw new ToolLoopSafeError("model_tool_calls_invalid", "同一模型 Turn 包含重复 tool_call id");
  }
  return calls;
}

function cleanFinalContent(value: unknown, maxBytes: number): AgentContentPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolLoopSafeError("model_final_content_invalid", "模型未返回有效最终文本");
  }
  const content = value.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new ToolLoopSafeError("model_final_content_invalid", "模型未返回有效最终文本");
    }
    const record = part as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string" || !record.text.trim()) {
      throw new ToolLoopSafeError("model_final_content_invalid", "模型未返回有效最终文本");
    }
    return { type: "text", text: record.text };
  });
  byteLength(content, "model_final_content_too_large", "模型最终文本超过安全上限", maxBytes);
  return content;
}

/**
 * Strict OpenAI-compatible relay response projection used by the upcoming
 * real model-turn adapter. Keeping it pure lets the persistent controller be
 * tested with a fake model while pinning the accepted tool_calls protocol now.
 */
export function parseRelayToolLoopModelResult(
  relay: Pick<RelayChatResult, "response">,
  limits: { maxArgumentBytes?: number; maxFinalTextBytes?: number } = {},
): AgentToolLoopModelResult {
  const response = relay.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new ToolLoopSafeError("model_response_invalid", "模型响应格式无效");
  }
  const choice = Array.isArray((response as Record<string, unknown>).choices)
    ? ((response as Record<string, unknown>).choices as unknown[])[0]
    : null;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new ToolLoopSafeError("model_response_invalid", "模型响应格式无效");
  }
  const choiceRecord = choice as Record<string, unknown>;
  const message = choiceRecord.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new ToolLoopSafeError("model_response_invalid", "模型响应格式无效");
  }
  const messageRecord = message as Record<string, unknown>;
  const toolCalls = messageRecord.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const calls = toolCalls.map((call) => {
      if (!call || typeof call !== "object" || Array.isArray(call)) {
        throw new ToolLoopSafeError("model_tool_calls_invalid", "模型返回的工具调用格式无效");
      }
      const callRecord = call as Record<string, unknown>;
      const fn = callRecord.function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
        throw new ToolLoopSafeError("model_tool_calls_invalid", "模型返回的工具调用格式无效");
      }
      const functionRecord = fn as Record<string, unknown>;
      if (typeof functionRecord.arguments !== "string") {
        throw new ToolLoopSafeError("model_tool_calls_invalid", "模型工具参数必须是 JSON 字符串");
      }
      let args: unknown;
      try {
        args = JSON.parse(functionRecord.arguments);
      } catch {
        throw new ToolLoopSafeError("model_tool_calls_invalid", "模型工具参数不是有效 JSON");
      }
      return {
        id: callRecord.id,
        name: functionRecord.name,
        arguments: args,
      };
    });
    const content = messageRecord.content;
    const reasoningContent = typeof messageRecord.reasoning_content === "string"
      ? messageRecord.reasoning_content.slice(0, 32_000)
      : "";
    return {
      kind: "tool_calls",
      assistantText: typeof content === "string" ? content.slice(0, 8_000) : "",
      ...(reasoningContent ? { reasoningContent } : {}),
      calls: cleanToolCalls(calls, boundedPositiveInteger(
        limits.maxArgumentBytes,
        DEFAULT_MAX_ARGUMENT_BYTES,
        HARD_MAX_ARGUMENT_BYTES,
        "maxArgumentBytes",
      )),
    };
  }
  if (choiceRecord.finish_reason === "tool_calls") {
    throw new ToolLoopSafeError("model_tool_calls_invalid", "模型声明工具调用但未返回有效调用");
  }
  const rawContent = messageRecord.content;
  const text = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part) => (
          part && typeof part === "object" && !Array.isArray(part)
            && typeof (part as Record<string, unknown>).text === "string"
            ? String((part as Record<string, unknown>).text)
            : ""
        )).join("")
      : "";
  return {
    kind: "final",
    content: cleanFinalContent(
      [{ type: "text", text }],
      boundedPositiveInteger(
        limits.maxFinalTextBytes,
        DEFAULT_MAX_FINAL_TEXT_BYTES,
        HARD_MAX_FINAL_TEXT_BYTES,
        "maxFinalTextBytes",
      ),
    ),
  };
}

function storedRevisionMarker(value: unknown): AgentApprovalCheckpointRevisionMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const approvalId = typeof record.approvalId === "string" ? record.approvalId : "";
  const revision = Number(record.revision);
  const at = Number(record.at);
  if (!approvalId || approvalId.length > 200
    || !Number.isSafeInteger(revision) || revision <= 0
    || !Number.isSafeInteger(at) || at < 0) {
    return null;
  }
  return { approvalId, revision, at };
}

function storedCanonicalizationMarker(value: unknown): AgentApprovalCheckpointCanonicalizationMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sourceArgumentsHash = typeof record.sourceArgumentsHash === "string"
    ? record.sourceArgumentsHash
    : "";
  const canonicalArgumentsHash = typeof record.canonicalArgumentsHash === "string"
    ? record.canonicalArgumentsHash
    : "";
  const at = Number(record.at);
  if (!/^[a-f0-9]{64}$/.test(sourceArgumentsHash)
    || !/^[a-f0-9]{64}$/.test(canonicalArgumentsHash)
    || !Number.isSafeInteger(at)
    || at < 0) {
    return null;
  }
  return { sourceArgumentsHash, canonicalArgumentsHash, at };
}

function storedTurnResult(step: Pick<RawStep, "outputRefs">): StoredModelTurnResult | null {
  const ref = parseArray<Record<string, unknown>>(step.outputRefs)
    .find((item) => item?.type === TOOL_LOOP_RESULT_REF);
  if (!ref) return null;
  const turn = Number(ref.turn);
  const outcome = ref.outcome;
  if (!Number.isSafeInteger(turn) || turn <= 0 || (outcome !== "tool_calls" && outcome !== "final")) return null;
  return {
    type: TOOL_LOOP_RESULT_REF,
    turn,
    outcome,
    assistantText: typeof ref.assistantText === "string" ? ref.assistantText : "",
    reasoningContent: typeof ref.reasoningContent === "string" ? ref.reasoningContent : "",
    calls: Array.isArray(ref.calls) ? ref.calls as AgentToolLoopToolCall[] : [],
    toolResults: Array.isArray(ref.toolResults) ? ref.toolResults as AgentToolLoopToolResult[] : [],
    content: Array.isArray(ref.content) ? ref.content as AgentContentPart[] : [],
    approvalId: typeof ref.approvalId === "string" && ref.approvalId ? ref.approvalId : null,
    argumentsRevised: storedRevisionMarker(ref.argumentsRevised),
    argumentsCanonicalized: storedCanonicalizationMarker(ref.argumentsCanonicalized),
  };
}

function asAgentStep(row: RawStep): AgentStep {
  return mapAgentStep(row);
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof ToolLoopSafeError) return { code: error.code, message: error.message };
  if (error instanceof AgentToolGatewayError) return { code: error.code, message: error.message };
  if (error instanceof AgentRuntimeError) return { code: error.code, message: error.message };
  return { code: "tool_loop_failed", message: "Agent 工具循环执行失败" };
}

function isDefinitiveModelDispatchFailure(error: unknown): boolean {
  return error instanceof Error
    && "upstreamMayHaveAccepted" in error
    && (error as Error & { upstreamMayHaveAccepted?: boolean }).upstreamMayHaveAccepted === false;
}

/**
 * Decide-with-revision checkpoint writeback (REVAMP-PLAN 1.2-5). Invoked by
 * ApprovalService inside the decide transaction via its revision hook: the
 * paused model-turn checkpoint's single approval call is rewritten to the
 * server-parsed revised arguments, preserving the model tool-call id/name and
 * stamping an audit marker. After the rewrite the resumed loop derives the
 * tool idempotency key (toolCallKey) from the revised call, so the approved
 * execution creates a fresh Tool Step instead of colliding with the original
 * (never-executed) derivation.
 *
 * The rewrite is guarded by the pre-revision argumentsHash taken from the
 * locked Approval row, so the checkpoint and the Approval must still describe
 * the same original call; any drift fails the whole decide transaction.
 */
export async function reviseAgentApprovalModelTurnCheckpointInTransaction(
  trx: Knex.Transaction,
  input: AgentApprovalRevisionApplication,
): Promise<void> {
  const step = await trx<RawStep>("o_agent_step")
    .where({
      id: input.modelStepId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      kind: "model",
      status: "succeeded",
    })
    .first();
  if (!step) {
    throw new AgentRuntimeError(409, "approval_checkpoint_invalid", "审批模型检查点不存在或未完成");
  }
  const latest = storedTurnResult(step);
  const call = latest && latest.calls.length === 1 ? latest.calls[0] : null;
  if (!latest
    || latest.outcome !== "tool_calls"
    || latest.approvalId !== input.approvalId
    || !call
    || call.name !== input.toolId) {
    throw new AgentRuntimeError(409, "approval_checkpoint_invalid", "审批工具调用检查点无效");
  }
  if (hashIdempotencyRequest(call.arguments) !== input.previousArgumentsHash) {
    throw new AgentRuntimeError(409, "approval_checkpoint_invalid", "审批参数与模型调用检查点不一致");
  }
  const revised: StoredModelTurnResult = {
    ...latest,
    calls: [{
      ...call,
      arguments: JSON.parse(JSON.stringify(input.arguments)) as Record<string, unknown>,
    }],
    argumentsRevised: {
      approvalId: input.approvalId,
      revision: input.revision,
      at: input.now,
    },
  };
  const updated = await trx("o_agent_step")
    .where({ id: step.id, runId: input.runId, kind: "model", status: "succeeded" })
    .update({ outputRefs: JSON.stringify([revised]), updatedAt: input.now });
  if (affectedRows(updated) !== 1) throw new Error("approval checkpoint rewrite lost");
}

/**
 * First persistent A3 vertical slice.
 *
 * The configured production worker reaches this processor only through the
 * immutable Run snapshot router. New admission is independently gated, while
 * already-persisted toolsEnabled=true Runs continue to drain after rollback.
 */
export class AgentToolLoopProcessor {
  private readonly database: Knex;
  private readonly model: AgentToolLoopModel;
  private readonly gateway: AgentToolGateway;
  private readonly approvalService?: AgentApprovalService;
  private readonly delegationCoordinator?: Pick<AgentDelegationCoordinator, "start">;
  private readonly clock: () => number;
  private readonly messageIdFactory: () => string;
  private readonly stepIdFactory: () => string;
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  private readonly maxArgumentBytes: number;
  private readonly maxResultBytes: number;
  private readonly maxFinalTextBytes: number;
  private readonly hooks: AgentToolLoopLifecycleHooks;
  private readonly eventAppender: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;

  constructor(options: AgentToolLoopProcessorOptions) {
    this.database = options.database;
    this.model = options.model;
    this.gateway = options.gateway;
    this.approvalService = options.approvalService;
    this.delegationCoordinator = options.delegationCoordinator;
    this.clock = options.clock ?? Date.now;
    this.messageIdFactory = options.messageIdFactory ?? randomUUID;
    this.stepIdFactory = options.stepIdFactory ?? randomUUID;
    this.maxTurns = boundedPositiveInteger(options.maxTurns, DEFAULT_MAX_TURNS, HARD_MAX_TURNS, "maxTurns");
    this.maxToolCalls = boundedPositiveInteger(
      options.maxToolCalls,
      DEFAULT_MAX_TOOL_CALLS,
      HARD_MAX_TOOL_CALLS,
      "maxToolCalls",
    );
    this.maxArgumentBytes = boundedPositiveInteger(
      options.maxArgumentBytes,
      DEFAULT_MAX_ARGUMENT_BYTES,
      HARD_MAX_ARGUMENT_BYTES,
      "maxArgumentBytes",
    );
    this.maxResultBytes = boundedPositiveInteger(
      options.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      HARD_MAX_RESULT_BYTES,
      "maxResultBytes",
    );
    this.maxFinalTextBytes = boundedPositiveInteger(
      options.maxFinalTextBytes,
      DEFAULT_MAX_FINAL_TEXT_BYTES,
      HARD_MAX_FINAL_TEXT_BYTES,
      "maxFinalTextBytes",
    );
    this.hooks = options.hooks ?? {};
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
  }

  private async lockRunWithFreshClock(
    trx: Knex.Transaction,
    runId: string,
  ): Promise<{ run: RawRun | undefined; now: number }> {
    const run = await trx<RawRun>("o_agent_run")
      .where({ id: runId })
      .forUpdate()
      .first();
    // A transaction can wait behind lease renewal/reclaim/cancellation. The
    // lease decision must use time observed only after the Run lock is held.
    return { run, now: this.clock() };
  }

  async process(input: AgentRunProcessInput): Promise<AgentRunProcessResult> {
    const workerId = input.workerId.trim();
    if (!workerId || input.claimedRun.leaseOwner !== workerId) {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: null };
    }
    const prepared = await this.ensureResponse(input, workerId);
    if (prepared.kind === "lease_lost") {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: prepared.responseMessageId };
    }
    if (prepared.kind === "cancelled") {
      return { status: "cancelled", runId: input.claimedRun.id, responseMessageId: prepared.responseMessageId };
    }

    const stopAtBoundary = async (knownModelResultStepId?: string): Promise<AgentRunProcessResult | null> => {
      const boundary = await this.finishCancellationAtBoundary(
        prepared,
        input,
        workerId,
        knownModelResultStepId,
      );
      if (boundary.kind === "continue") return null;
      return {
        status: boundary.kind === "cancelled" ? "cancelled" : "lease_lost",
        runId: prepared.run.id,
        responseMessageId: prepared.responseMessageId,
      };
    };

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      let step = await findModelStep(this.database, prepared.run.id, turn);
      if (!step) {
        const stopped = await stopAtBoundary();
        if (stopped) return stopped;
        step = await this.createModelStep(prepared, turn, input, workerId);
        if (!step) {
          const cancelled = await stopAtBoundary();
          if (cancelled) return cancelled;
          return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
        }
      }

      if (step.status === "uncertain") {
        await input.beforeFinalize?.();
        return this.finalize(prepared, input, workerId, "failed", TOOL_LOOP_UNCERTAIN_ERROR, []);
      }
      if (step.status === "running" && dispatchState(step) === "dispatched") {
        await this.markModelUncertain(prepared, step, this.clock());
        await input.beforeFinalize?.();
        return this.finalize(prepared, input, workerId, "failed", TOOL_LOOP_UNCERTAIN_ERROR, []);
      }
      if (step.status === "running") {
        const stopped = await stopAtBoundary();
        if (stopped) return stopped;
        const execution = await this.executeModelTurn(prepared, step, turn, input, workerId);
        if (execution.kind === "cancelled") {
          return { status: "cancelled", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
        }
        if (execution.kind === "lease_lost") {
          return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
        }
        if (execution.kind === "failed") {
          await input.beforeFinalize?.();
          return this.finalize(prepared, input, workerId, "failed", execution.error, []);
        }
        step = execution.step;
      }

      const stoppedAfterModel = await stopAtBoundary(step.id);
      if (stoppedAfterModel) return stoppedAfterModel;

      if (step.status !== "succeeded") {
        const error = { code: "model_step_invalid", message: "模型 Turn 检查点状态无效" };
        await input.beforeFinalize?.();
        return this.finalize(prepared, input, workerId, "failed", error, []);
      }
      const result = storedTurnResult(step);
      if (!result || result.turn !== turn) {
        const error = { code: "model_checkpoint_invalid", message: "模型 Turn 检查点内容无效" };
        await input.beforeFinalize?.();
        return this.finalize(prepared, input, workerId, "failed", error, []);
      }
      if (result.outcome === "final") {
        await input.beforeFinalize?.();
        return this.finalize(prepared, input, workerId, "succeeded", null, result.content);
      }

      let toolResults = result.toolResults;
      if (toolResults.length === 0) {
        const totalBefore = await countPersistedToolCalls(this.database, prepared.run.id);
        if (totalBefore + result.calls.length > this.maxToolCalls) {
          const error = { code: "tool_call_limit_exceeded", message: "模型工具调用数量超过安全上限" };
          await input.beforeFinalize?.();
          return this.finalize(prepared, input, workerId, "failed", error, []);
        }
        let candidates: readonly AgentToolCatalogDefinition[];
        try {
          candidates = filterModelToolCandidates(
            prepared.run,
            await this.gateway.listModelToolCandidates(prepared.run.id),
          );
        } catch (error) {
          const cancelled = await stopAtBoundary();
          if (cancelled) return cancelled;
          await input.beforeFinalize?.();
          return this.finalize(prepared, input, workerId, "failed", safeError(error), []);
        }
        const byName = new Map(candidates.map((tool) => [tool.manifest.name, tool]));
        const r1Calls = result.calls.filter((call) => {
          const definition = byName.get(call.name as any);
          return isMainAgentR1ModelToolIdV3(call.name)
            || definition?.manifest.riskClass === "R1";
        });
        if (r1Calls.length > 0 && (r1Calls.length !== 1 || result.calls.length !== 1)) {
          const error = { code: "r1_call_batch_unsupported", message: "R1 写入必须作为当前 Turn 的唯一工具调用" };
          await input.beforeFinalize?.();
          return this.finalize(prepared, input, workerId, "failed", error, []);
        }
        if (r1Calls.length > 0 && result.approvalId) {
          const error = { code: "r1_approval_forbidden", message: "R1 写入不得携带审批授权" };
          await input.beforeFinalize?.();
          return this.finalize(prepared, input, workerId, "failed", error, []);
        }
        const delegationCalls = result.calls.filter((call) => call.name === "agent.delegate");
        if (delegationCalls.length > 0) {
          if (delegationCalls.length !== 1 || result.calls.length !== 1) {
            const error = {
              code: "delegation_call_batch_unsupported",
              message: "Agent 委派必须作为当前 Turn 的唯一工具调用",
            };
            await input.beforeFinalize?.();
            return this.finalize(prepared, input, workerId, "failed", error, []);
          }
          const call = delegationCalls[0];
          const definition = byName.get(call.name as any);
          if (!definition
            || definition.manifest.riskClass !== "R1"
            || definition.manifest.mutatesState !== true
            || definition.manifest.metered !== false) {
            const error = { code: "tool_not_available", message: "模型请求的工具对当前 Run 不可用" };
            await input.beforeFinalize?.();
            return this.finalize(prepared, input, workerId, "failed", error, []);
          }
          const delegationInput = parseAgentDelegateInputForPromptVersion(
            modelToolExposureScope(prepared.run).promptVersion,
            call.arguments,
          );
          if (!delegationInput) {
            const error = { code: "delegation_request_invalid", message: "Agent 委派任务格式无效" };
            await input.beforeFinalize?.();
            return this.finalize(prepared, input, workerId, "failed", error, []);
          }
          if (!this.delegationCoordinator) {
            const error = { code: "delegation_service_unavailable", message: "Agent 委派服务当前不可用" };
            await input.beforeFinalize?.();
            return this.finalize(prepared, input, workerId, "failed", error, []);
          }
          await input.beforeFinalize?.();
          try {
            await this.delegationCoordinator.start({
              parentRunId: prepared.run.id,
              modelStepId: step.id,
              workerId,
              attempt: input.claimedRun.attempt,
              idempotencyKey: toolCallKey(turn, 0, call),
              tasks: delegationInput.tasks,
            });
            return {
              status: "waiting_delegation",
              runId: prepared.run.id,
              responseMessageId: prepared.responseMessageId,
            };
          } catch (error) {
            return this.finalize(prepared, input, workerId, "failed", safeError(error), []);
          }
        }
        const approvalCalls = result.calls.filter((call) => {
          const risk = byName.get(call.name as any)?.manifest.riskClass;
          return risk === "R2" || risk === "R3";
        });
        if (approvalCalls.length > 0 && (approvalCalls.length !== 1 || result.calls.length !== 1)) {
          const error = { code: "approval_call_batch_unsupported", message: "审批工具必须作为单独工具调用提交" };
          await input.beforeFinalize?.();
          return this.finalize(prepared, input, workerId, "failed", error, []);
        }
        if (approvalCalls.length === 1 && !result.approvalId) {
          if (!this.approvalService) {
            await input.beforeFinalize?.();
            return this.finalize(
              prepared,
              input,
              workerId,
              "failed",
              { code: "approval_service_unavailable", message: "审批服务当前不可用" },
              [],
            );
          }
          await input.beforeFinalize?.();
          try {
            const paused = await this.pauseForApproval(
              prepared,
              step,
              result,
              approvalCalls[0],
              input,
              workerId,
            );
            if (paused.status === "lease_lost") {
              const cancelled = await stopAtBoundary();
              if (cancelled) return cancelled;
            }
            return paused;
          } catch (error) {
            return this.finalize(prepared, input, workerId, "failed", safeError(error), []);
          }
        }

        let persistedApprovalStatus: string | null = null;
        if (result.approvalId) {
          if (!this.approvalService || approvalCalls.length !== 1) {
            await input.beforeFinalize?.();
            return this.finalize(
              prepared,
              input,
              workerId,
              "failed",
              { code: "approval_checkpoint_invalid", message: "审批工具检查点无效" },
              [],
            );
          }
          try {
            const approval = await this.approvalService.get({
              workspaceId: prepared.run.workspaceId,
              projectId: Number(prepared.run.projectId),
              approvalId: result.approvalId,
            });
            persistedApprovalStatus = approval.status;
          } catch (error) {
            await input.beforeFinalize?.();
            return this.finalize(prepared, input, workerId, "failed", safeError(error), []);
          }
          if (["denied", "expired", "revoked"].includes(persistedApprovalStatus)) {
            const call = approvalCalls[0];
            toolResults = [{
              callId: call.id,
              name: call.name,
              stepId: step.id,
              output: {
                status: persistedApprovalStatus,
                code: persistedApprovalStatus === "expired" ? "approval_expired" : "approval_denied",
              },
            }];
            const recorded = await this.recordToolResults(
              prepared,
              step,
              result,
              toolResults,
              input,
              workerId,
            );
            if (!recorded) {
              const cancelled = await stopAtBoundary();
              if (cancelled) return cancelled;
              return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
            }
          } else if (persistedApprovalStatus !== "approved" && persistedApprovalStatus !== "consumed") {
            await input.beforeFinalize?.();
            return this.finalize(
              prepared,
              input,
              workerId,
              "failed",
              { code: "approval_not_decided", message: "审批尚未形成可恢复决定" },
              [],
            );
          }
        }

        if (toolResults.length > 0) {
          // A denied/expired decision was durably projected above; continue to
          // the next model turn without creating a misleading Tool Step.
        } else {
          const next: AgentToolLoopToolResult[] = [];
          for (let index = 0; index < result.calls.length; index += 1) {
            const call = result.calls[index];
            const definition = byName.get(call.name as any);
            if (!definition) {
              const error = { code: "tool_not_available", message: "模型请求的工具对当前 Run 不可用" };
              await input.beforeFinalize?.();
              return this.finalize(prepared, input, workerId, "failed", error, []);
            }
            const approvalId = definition.manifest.riskClass === "R2" || definition.manifest.riskClass === "R3"
              ? result.approvalId
              : null;
            const stoppedBeforeTool = await stopAtBoundary();
            if (stoppedBeforeTool) return stoppedBeforeTool;
            let gatewayResult: AgentToolGatewayExecuteResult;
            try {
              gatewayResult = await this.gateway.execute({
                runId: prepared.run.id,
                toolName: call.name,
                arguments: call.arguments,
                approvalId,
                idempotencyKey: toolCallKey(turn, index, call),
                claimFence: { workerId, attempt: input.claimedRun.attempt },
              });
              byteLength(
                gatewayResult.output,
                "tool_result_too_large",
                "工具结果超过模型回注安全上限",
                this.maxResultBytes,
              );
            } catch (error) {
              logger.error(
                {
                  runId: prepared.run.id,
                  turn,
                  callId: call.id,
                  callName: call.name,
                  errorName: error instanceof Error ? error.name : typeof error,
                  errorCode: (error as { code?: unknown } | null)?.code,
                  errorMessage: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "[agent-tool-loop] gateway execute failed",
              );
              const cancelled = await stopAtBoundary();
              if (cancelled) return cancelled;
              if (error instanceof ToolLoopSafeError) {
                await input.beforeFinalize?.();
                return this.finalize(prepared, input, workerId, "failed", safeError(error), []);
              }
              // Gateway owns the detailed safe failure Step. The model loop only
              // exposes a stable aggregate error at the Run/message boundary.
              await input.beforeFinalize?.();
              return this.finalize(
                prepared,
                input,
                workerId,
                "failed",
                safeError(error),
                [],
              );
            }
            // Deliberately outside the Gateway error boundary: this seam models
            // a process crash after the durable Tool Step committed. A restart
            // must replay that Step rather than turn the Run into a tool error.
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
          const recorded = await this.recordToolResults(
            prepared,
            step,
            result,
            toolResults,
            input,
            workerId,
          );
          if (!recorded) {
            const cancelled = await stopAtBoundary();
            if (cancelled) return cancelled;
            return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
          }
          await this.hooks.afterToolResultsRecorded?.({
            runId: prepared.run.id,
            turn,
            toolResults,
          });
        }
      }

      if (turn === this.maxTurns) {
        await input.beforeFinalize?.();
        return this.finalize(
          prepared,
          input,
          workerId,
          "failed",
          { code: "model_turn_limit_exceeded", message: "模型工具循环超过最大 Turn 数" },
          [],
        );
      }
      const stoppedBeforeNextTurn = await stopAtBoundary();
      if (stoppedBeforeNextTurn) return stoppedBeforeNextTurn;
    }

    throw new Error("unreachable tool loop state");
  }

  private async ensureResponse(
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<PreparedLoop | LostLoop | CancelledLoop> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, input.claimedRun.id);
      if (run?.status === "cancelled" && run.responseMessageId) {
        const response = await trx<RawMessage>("o_agent_message")
          .where({ id: run.responseMessageId, runId: run.id, threadId: run.threadId, role: "assistant" })
          .first();
        if (response?.status === "stopped") {
          return { kind: "cancelled", responseMessageId: run.responseMessageId };
        }
      }
      if (
        !run
        || !["running", "cancelling"].includes(run.status)
        || !hasCurrentLiveLease(run, workerId, input.claimedRun.attempt, now)
      ) {
        return { kind: "lease_lost", responseMessageId: run?.responseMessageId ?? null };
      }
      const policy = parseObject(run.policySnapshot);
      if (policy.modelEnabled !== true || policy.toolsEnabled !== true) {
        throw new ToolLoopSafeError("tool_loop_not_enabled", "Run 未固定启用持久化模型工具循环");
      }
      if (run.agentRole !== "main") {
        throw new ToolLoopSafeError("tool_loop_role_unsupported", "当前工具循环竖切仅支持主 Agent");
      }
      const trigger = await trx<RawMessage>("o_agent_message")
        .where({
          id: run.triggerMessageId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
        })
        .first();
      if (!trigger || trigger.role !== "user") throw new Error(`Run ${run.id} 的触发消息不存在`);
      if (!agentMessageReferenceRefsMatchContextSnapshot(
        parseArray(trigger.referenceRefs),
        policy.contextSnapshot,
      )) {
        throw new ToolLoopSafeError(
          "tool_loop_context_references_invalid",
          "消息引用与已确认创作上下文不一致，请重新发送消息",
        );
      }
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Run ${run.id} 对应 Thread 不存在`);

      let responseMessageId = run.responseMessageId;
      if (responseMessageId) {
        const response = await trx<RawMessage>("o_agent_message")
          .where({ id: responseMessageId, runId: run.id, threadId: run.threadId, role: "assistant" })
          .first();
        if (!response || response.status !== "pending") throw new Error(`Run ${run.id} 响应消息状态无效`);
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

        const messageSeq = Number(thread.messageSeq || 0) + 1;
        const firstEventSeq = Number(thread.eventSeq || 0) + 1;
        const threadVersion = Number(thread.version || 0);
        const threadUpdated = await trx("o_agent_thread")
          .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
          .update({
            messageSeq,
            eventSeq: firstEventSeq + 1,
            lastMessageAt: now,
            version: threadVersion + 1,
            updatedAt: now,
          });
        if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 创建响应时 Thread 版本冲突`);
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
          agentRole: run.agentRole,
          visibility: "user",
          status: "pending",
          content: JSON.stringify([]),
          referenceRefs: JSON.stringify([]),
          createdBy: null,
          error: null,
          metadata: JSON.stringify({ source: "agent-runtime-tool-loop-preview" }),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          seq: firstEventSeq,
          type: "message.created",
          payload: { messageId: responseMessageId, seq: messageSeq, role: "assistant", status: "pending" },
          createdAt: now,
        });
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          seq: firstEventSeq + 1,
          type: "run.started",
          payload: { runId: run.id, status: "running", agentRole: run.agentRole, attempt: input.claimedRun.attempt },
          createdAt: now,
        });
        run.responseMessageId = responseMessageId;
        run.version = runVersion + 1;
      }
      return { kind: "ready", run, trigger, responseMessageId };
    });
  }


  private async createModelStep(
    prepared: PreparedLoop,
    turn: number,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<RawStep | null> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return null;
      const existing = await trx<RawStep>("o_agent_step")
        .where({ runId: run.id, idempotencyKey: modelStepKey(run.id, turn) })
        .first();
      if (existing) return existing;
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Run ${run.id} 创建模型 Turn 时 Thread 不存在`);
      const maxStep = await trx("o_agent_step").where({ runId: run.id }).max({ seq: "seq" }).first();
      const seq = Math.max(Number(run.checkpointStepSeq || 0), Number(maxStep?.seq || 0)) + 1;
      const requestKey = modelRequestKey(run.id, turn);
      const refs = [
        { type: MODEL_DISPATCH_REF, value: "prepared" },
        { type: TOOL_LOOP_TURN_REF, value: turn },
        { type: "model_request_id_digest", value: hashIdempotencyRequest({ requestId: requestKey }) },
        { type: "model_idempotency_key_digest", value: hashIdempotencyRequest({ idempotencyKey: requestKey }) },
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
        resolvedModel: typeof parseObject(run.policySnapshot).modelAlias === "string"
          ? String(parseObject(run.policySnapshot).modelAlias)
          : null,
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
          workspaceId: run.workspaceId,
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
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 创建模型 Turn 时 Thread 版本冲突`);
      await trx("o_agent_step").insert({
        ...step,
        inputRefs: JSON.stringify(refs),
        outputRefs: JSON.stringify([]),
        usage: JSON.stringify({}),
      });
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: step.id,
        seq: eventSeq,
        type: "step.started",
        payload: { step: toAgentStepDto(asAgentStep(step)) },
        createdAt: now,
      });
      return step;
    });
  }

  private async executeModelTurn(
    prepared: PreparedLoop,
    step: RawStep,
    turn: number,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<
    | { kind: "succeeded"; step: RawStep }
    | { kind: "failed"; error: { code: string; message: string } }
    | { kind: "cancelled" }
    | { kind: "lease_lost" }
  > {
    const requestKey = modelRequestKey(prepared.run.id, turn);
    let checkpointUsed = false;
    let dispatchCommitted = false;
    let providerReturned = false;
    try {
      // Current actor/project permission is re-read immediately before every
      // model turn. Revocation must fail closed before user context leaves the
      // database boundary, even when the resulting catalog would be empty.
      const tools = filterModelToolCandidates(
        prepared.run,
        await this.gateway.listModelToolCandidates(prepared.run.id),
      );
      const transcript = await buildToolLoopTranscript(
        this.database,
        prepared.run.id,
        parseArray<AgentContentPart>(prepared.trigger.content),
        turn,
      );
      const snapshotWriter = new AgentMessageStreamSnapshotWriter({
        database: this.database,
        workspaceId: prepared.run.workspaceId,
        threadId: prepared.run.threadId,
        runId: prepared.run.id,
        messageId: prepared.responseMessageId,
        clock: this.clock,
      });
      let raw: AgentToolLoopModelResult;
      try {
        raw = await this.model.executeTurn({
          run: {
            id: prepared.run.id,
            workspaceId: prepared.run.workspaceId,
            projectId: Number(prepared.run.projectId),
            threadId: prepared.run.threadId,
            agentRole: prepared.run.agentRole,
          },
          turn,
          requestId: requestKey,
          idempotencyKey: requestKey,
          transcript,
          tools,
          onAssistantDelta: (delta) => {
            // 同进程走低延迟直推；同时合并写入 pending 消息快照，让独立 API
            // 进程可经 SSE 轮询转发。终态 finalize 仍一次性覆盖完整正文。
            snapshotWriter.append(delta.text);
            publishAgentMessageDelta({
              threadId: prepared.run.threadId,
              runId: prepared.run.id,
              messageId: prepared.responseMessageId,
              turn: delta.turn,
              delta: delta.text,
              createdAt: this.clock(),
            });
          },
          recordBilling: async (billing) => {
            if (!Number.isSafeInteger(billing.costMicros) || billing.costMicros < 0) throw new Error("Invalid authoritative model cost");
            await this.database.transaction(async (trx) => {
              const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
              const stored = await trx("o_agent_step").where({ id: step.id, runId: prepared.run.id, kind: "model" }).first();
              if (!run || !stored) throw new Error("Authoritative model billing has no matching run and step");
              const previous = Number(stored.costMicros || 0);
              const delta = billing.costMicros - previous;
              if (!Number.isSafeInteger(delta) || delta < 0) throw new Error("Authoritative model billing cannot reduce recorded spend");
              await trx("o_agent_step").where({ id: step.id, runId: run.id }).update({
                costMicros: billing.costMicros, usage: JSON.stringify(billing.usage), updatedAt: now,
              });
              // Project settled usage immediately, including cancelled/failed runs.
              // Replays add only the unrecorded difference; finalization never adds it again.
              if (delta > 0) await trx("o_agent_run").where({ id: run.id, workspaceId: run.workspaceId }).update({
                actualSpendMicros: trx.raw("?? + ?", ["actualSpendMicros", delta]),
                version: Number(run.version || 0) + 1, updatedAt: now,
              });
            });
          },
          checkpointExternalDispatch: async () => {
            if (checkpointUsed) {
              throw new ToolLoopSafeError("model_dispatch_checkpoint_reused", "同一模型 Turn 只能 dispatch 一次");
            }
            checkpointUsed = true;
            await this.checkpointModelDispatch(prepared, step, input, workerId);
            dispatchCommitted = true;
          },
        });
      } finally {
        await snapshotWriter.close();
      }
      providerReturned = true;
      if (!dispatchCommitted) {
        throw new ToolLoopSafeError("model_dispatch_checkpoint_missing", "模型调用未执行持久化 dispatch 检查点");
      }
      const result: StoredModelTurnResult = raw.kind === "final"
        ? {
            type: TOOL_LOOP_RESULT_REF,
            turn,
            outcome: "final",
            assistantText: "",
            calls: [],
            toolResults: [],
            content: cleanFinalContent(raw.content, this.maxFinalTextBytes),
            approvalId: null,
          }
        : {
            type: TOOL_LOOP_RESULT_REF,
            turn,
            outcome: "tool_calls",
            assistantText: typeof raw.assistantText === "string" ? raw.assistantText.slice(0, 8_000) : "",
            reasoningContent: typeof raw.reasoningContent === "string" ? raw.reasoningContent.slice(0, 32_000) : "",
            calls: cleanToolCalls(raw.calls, this.maxArgumentBytes),
            toolResults: [],
            content: [],
            approvalId: null,
          };
      if (result.calls.length > this.maxToolCalls) {
        throw new ToolLoopSafeError("tool_call_limit_exceeded", "单次模型 Turn 的工具调用数量超过安全上限");
      }
      const cancellation = await this.finishCancellationAtBoundary(
        prepared,
        input,
        workerId,
        step.id,
      );
      if (cancellation.kind === "cancelled") return { kind: "cancelled" };
      if (cancellation.kind !== "continue") {
        await this.markModelUncertain(prepared, step, this.clock());
        return { kind: "lease_lost" };
      }
      const committed = await this.commitModelResult(prepared, step, result, input, workerId);
      if (!committed) {
        const cancelled = await this.finishCancellationAtBoundary(
          prepared,
          input,
          workerId,
          step.id,
        );
        if (cancelled.kind === "cancelled") return { kind: "cancelled" };
        await this.markModelUncertain(prepared, step, this.clock());
        return { kind: "lease_lost" };
      }
      const stored = await findModelStep(this.database, prepared.run.id, turn);
      if (!stored) throw new Error("committed model step disappeared");
      return { kind: "succeeded", step: stored };
    } catch (error) {
      if (dispatchCommitted) {
        if (isDefinitiveModelDispatchFailure(error)) {
          const cancelled = await this.finishCancellationAtBoundary(
            prepared,
            input,
            workerId,
            step.id,
          );
          if (cancelled.kind === "cancelled") return { kind: "cancelled" };
          const definitiveError = safeError(error);
          const persisted = await this.markDispatchedModelFailed(
            prepared,
            step,
            definitiveError,
            input,
            workerId,
          );
          return persisted
            ? { kind: "failed", error: definitiveError }
            : { kind: "lease_lost" };
        }
        if (providerReturned) {
          const cancelled = await this.finishCancellationAtBoundary(
            prepared,
            input,
            workerId,
            step.id,
          );
          if (cancelled.kind === "cancelled") return { kind: "cancelled" };
        }
        await this.markModelUncertain(prepared, step, this.clock());
        const run = await this.database<RawRun>("o_agent_run").where({ id: prepared.run.id }).first();
        return run && hasLiveLease(run, workerId, input.claimedRun.attempt, this.clock())
          ? { kind: "failed", error: TOOL_LOOP_UNCERTAIN_ERROR }
          : { kind: "lease_lost" };
      }
      const cancelled = await this.finishCancellationAtBoundary(prepared, input, workerId);
      if (cancelled.kind === "cancelled") return { kind: "cancelled" };
      const persisted = await this.markPreparedModelFailed(prepared, step, safeError(error), input, workerId);
      return persisted ? { kind: "failed", error: safeError(error) } : { kind: "lease_lost" };
    }
  }

  private async checkpointModelDispatch(
    prepared: PreparedLoop,
    step: RawStep,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<void> {
    await this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || stored.status !== "running" || dispatchState(stored) !== "prepared") {
        throw new ToolLoopSafeError("model_dispatch_checkpoint_invalid", "模型 Turn dispatch 检查点无效");
      }
      if (!hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        throw new ToolLoopSafeError("model_dispatch_lease_lost", "模型请求发出前租约已失效");
      }
      // Close the context-build -> provider-dispatch TOCTOU window. This
      // re-derives actor identity from the persisted trigger and re-reads the
      // current project permission in the same transaction as the dispatch
      // state CAS; revocation leaves the Step safely prepared.
      await this.gateway.assertModelDispatchAuthorizedInTransaction(trx, run.id);
      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          workspaceId: run.workspaceId,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({ sideEffectsCommitted: 1, version: runVersion + 1, updatedAt: now });
      if (affectedRows(runUpdated) !== 1) {
        throw new ToolLoopSafeError("model_dispatch_lease_lost", "模型请求发出前租约已失效");
      }
      const updated = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "running", kind: "model" })
        .update({ inputRefs: JSON.stringify(withDispatchState(stored.inputRefs, "dispatched")), updatedAt: now });
      if (affectedRows(updated) !== 1) throw new Error("model dispatch step checkpoint lost");
    });
  }

  private async commitModelResult(
    prepared: PreparedLoop,
    step: RawStep,
    result: StoredModelTurnResult,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;
      if (stored.status !== "running" || dispatchState(stored) !== "dispatched") return false;
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId }).first();
      if (!thread) throw new Error(`Run ${run.id} 保存模型 Turn 时 Thread 不存在`);
      const outputRefs = [result];
      const updated = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "running", kind: "model" })
        .update({
          status: "succeeded",
          outputRefs: JSON.stringify(outputRefs),
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(updated) !== 1) return false;
      const threadVersion = Number(thread.version || 0);
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 保存模型 Turn 时 Thread 版本冲突`);
      const terminal = asAgentStep({ ...stored, status: "succeeded", outputRefs, updatedAt: now, completedAt: now });
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: stored.id,
        seq: eventSeq,
        type: "step.completed",
        payload: { step: toAgentStepDto(terminal) },
        createdAt: now,
      });
      return true;
    });
  }

  private async recordToolResults(
    prepared: PreparedLoop,
    step: RawStep,
    result: StoredModelTurnResult,
    toolResults: AgentToolLoopToolResult[],
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;
      const latest = storedTurnResult(stored);
      if (!latest || latest.outcome !== "tool_calls" || latest.turn !== result.turn) {
        throw new Error("model tool result checkpoint invalid");
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

  private async pauseForApproval(
    prepared: PreparedLoop,
    step: RawStep,
    result: StoredModelTurnResult,
    call: AgentToolLoopToolCall,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult> {
    const approvals = this.approvalService!;
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      const latest = storedTurnResult(stored);
      // A checkpoint rewritten by a decide-with-revision carries an audit
      // marker; the calls-hash assertion against the original model output is
      // exempt for it (the approval row CAS remains the authoritative gate).
      const checkpointRevised = latest?.argumentsRevised != null;
      if (!latest
        || latest.outcome !== "tool_calls"
        || latest.approvalId
        || latest.calls.length !== 1
        || (!checkpointRevised && hashIdempotencyRequest(latest.calls[0]) !== hashIdempotencyRequest(call))
        || (!checkpointRevised && hashIdempotencyRequest(latest.calls) !== hashIdempotencyRequest(result.calls))) {
        throw new ToolLoopSafeError("approval_checkpoint_invalid", "审批工具调用检查点无效");
      }
      const preparedAction = await this.gateway.prepareModelApprovalInTransaction(trx, {
        runId: run.id,
        stepId: stored.id,
        toolName: call.name,
        arguments: call.arguments,
      });
      if (!preparedAction.arguments
        || typeof preparedAction.arguments !== "object"
        || Array.isArray(preparedAction.arguments)) {
        throw new ToolLoopSafeError("approval_arguments_invalid", "审批工具参数规范化结果无效");
      }
      const sourceArgumentsHash = hashIdempotencyRequest(latest.calls[0].arguments);
      const canonicalArgumentsHash = hashIdempotencyRequest(preparedAction.arguments);
      let approvalCheckpoint = latest;
      if (sourceArgumentsHash !== canonicalArgumentsHash) {
        approvalCheckpoint = {
          ...latest,
          calls: [{
            ...latest.calls[0],
            arguments: preparedAction.arguments as Record<string, unknown>,
          }],
          argumentsCanonicalized: {
            sourceArgumentsHash,
            canonicalArgumentsHash,
            at: now,
          },
        };
        const canonicalized = await trx("o_agent_step")
          .where({ id: stored.id, runId: run.id, status: "succeeded", kind: "model" })
          .update({
            outputRefs: JSON.stringify([approvalCheckpoint]),
            updatedAt: now,
          });
        if (affectedRows(canonicalized) !== 1) {
          throw new Error("approval model checkpoint canonicalization lost");
        }
      }
      let expiresAt = now + DEFAULT_APPROVAL_TTL_MS;
      if (preparedAction.quote?.expiresAt !== undefined) {
        expiresAt = Math.min(expiresAt, preparedAction.quote.expiresAt);
      }
      if (expiresAt <= now) {
        throw new ToolLoopSafeError("approval_evidence_expired", "服务端审批证据已过期");
      }
      const approval = await approvals.requestInTransaction(trx, {
        ...preparedAction,
        toolId: preparedAction.toolId as any,
        expiresAt,
      });
      const checkpointed = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "succeeded", kind: "model" })
        .update({
          outputRefs: JSON.stringify([{ ...approvalCheckpoint, approvalId: approval.id }]),
          updatedAt: now,
        });
      if (affectedRows(checkpointed) !== 1) throw new Error("approval model checkpoint lost");

      // 预算自主审批分叉:灰度开启 + R2 + 有报价 + 项目预算原子预留(CAS)成功时,
      // 同事务自动批准(decidedBy=Run 触发者,预留金额打标进审批行),Run 直接转
      // queued 等待重新认领恢复,不进入 waiting_approval;否则走现有人工路径。
      const autoApproved = await this.tryAutoApproveApprovalWithinBudget(trx, approval, now);

      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update(autoApproved
          ? {
              status: "queued",
              waitType: null,
              waitRef: null,
              wakeAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              version: runVersion + 1,
              updatedAt: now,
            }
          : {
              status: "waiting_approval",
              waitType: "approval",
              waitRef: approval.id,
              wakeAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              version: runVersion + 1,
              updatedAt: now,
            });
      if (affectedRows(runUpdated) !== 1) {
        throw new ToolLoopSafeError("approval_pause_lease_lost", "进入审批等待前执行租约已变化");
      }
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Run ${run.id} 进入审批等待时 Thread 不存在`);
      const threadVersion = Number(thread.version || 0);
      const firstEventSeq = Number(thread.eventSeq || 0) + 1;
      // 人工路径 2 个事件(requested + run.status);自动批准路径 3 个
      // (requested + approved + run.queued),与 decide+resume 的事件序列对齐。
      const eventCount = autoApproved ? 3 : 2;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq: firstEventSeq + eventCount - 1, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 进入审批等待时 Thread 版本冲突`);
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: stored.id,
        seq: firstEventSeq,
        type: "approval.requested",
        payload: { approval: toSafeAgentApprovalDto(approval) },
        createdAt: now,
      });
      if (autoApproved) {
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: prepared.responseMessageId,
          stepId: stored.id,
          seq: firstEventSeq + 1,
          type: "approval.approved",
          payload: { approval: toSafeAgentApprovalDto(autoApproved) },
          createdAt: now,
        });
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: prepared.responseMessageId,
          stepId: stored.id,
          seq: firstEventSeq + 2,
          type: "run.queued",
          payload: { runId: run.id, status: "queued", reason: "approval_auto_approved" },
          createdAt: now,
        });
        return { status: "queued", runId: run.id, responseMessageId: prepared.responseMessageId };
      }
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: stored.id,
        seq: firstEventSeq + 1,
        type: "run.status",
        payload: { runId: run.id, status: "waiting_approval", waitType: "approval" },
        createdAt: now,
      });
      return { status: "waiting_approval", runId: run.id, responseMessageId: prepared.responseMessageId };
    });
  }

  /**
   * 预算自主审批:项目级 GU 预算的原子检查并预留(check-and-reserve CAS)。
   *
   * 仅在灰度开启、审批为 R2 且绑定报价时尝试;项目未设预算
   * (agentBudgetMicros IS NULL)或 预留+报价最高额 > 预算 时条件 UPDATE 命中
   * 0 行,调用方回落人工审批。并发下两个 pause 事务只有一个能先胜出预留;
   * 另一个在锁等待后以最新 reserved 重判 WHERE(Postgres EvalPlanQual /
   * SQLite 串行写),不会超额。预留成功后把审批同事务自动批准;后续失败由
   * 外层事务整体回滚(预留随之回滚)。
   */
  private async tryAutoApproveApprovalWithinBudget(
    trx: Knex.Transaction,
    approval: AgentApproval,
    now: number,
  ): Promise<AgentApproval | null> {
    if (!isAgentAutoApproveEnabled()) return null;
    if (approval.riskClass !== "R2") return null;
    const maximum = approval.quote?.maximumCostMicros;
    if (maximum == null || !Number.isSafeInteger(Number(maximum)) || Number(maximum) < 1) return null;
    const reserved = await trx(PROJECT_TABLE)
      .where({ id: approval.projectId, workspaceId: approval.workspaceId })
      .whereNotNull(AGENT_PROJECT_BUDGET_COLUMN)
      .whereRaw("COALESCE(??, 0) + ? <= ??", [
        AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
        Number(maximum),
        AGENT_PROJECT_BUDGET_COLUMN,
      ])
      .update({
        [AGENT_PROJECT_BUDGET_RESERVED_COLUMN]: trx.raw("COALESCE(??, 0) + ?", [
          AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
          Number(maximum),
        ]),
      });
    if (affectedRows(reserved) !== 1) return null;
    return autoApproveAgentApprovalInTransaction(trx, {
      approval,
      decidedBy: approval.requestedBy,
      budgetReservedMicros: Number(maximum),
      now,
    });
  }

  /**
   * Turns an owned cancelling Run into its terminal state at a deterministic
   * model/tool boundary. A dispatched model Step is only safe to cancel when
   * the caller has the provider result in memory; otherwise recovery must keep
   * the existing uncertain/reconciliation path.
   */
  private async finishCancellationAtBoundary(
    prepared: PreparedLoop,
    input: AgentRunProcessInput,
    workerId: string,
    knownModelResultStepId?: string,
  ): Promise<CancellationBoundaryResult> {
    const inspected = await this.finishCancellationInTransaction(
      prepared,
      input,
      workerId,
      knownModelResultStepId,
      false,
    );
    if (inspected.kind !== "cancellation_pending") return inspected;
    await input.beforeFinalize?.();
    return this.finishCancellationInTransaction(
      prepared,
      input,
      workerId,
      knownModelResultStepId,
      true,
    );
  }

  private async finishCancellationInTransaction(
    prepared: PreparedLoop,
    input: AgentRunProcessInput,
    workerId: string,
    knownModelResultStepId: string | undefined,
    terminalWriteAllowed: boolean,
  ): Promise<CancellationBoundaryResult> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || run.responseMessageId !== prepared.responseMessageId) return { kind: "lease_lost" };
      if (run.status === "cancelled") {
        const stopped = await trx<RawMessage>("o_agent_message")
          .where({
            id: prepared.responseMessageId,
            workspaceId: run.workspaceId,
            threadId: run.threadId,
            runId: run.id,
            status: "stopped",
          })
          .first();
        return stopped ? { kind: "cancelled" } : { kind: "lease_lost" };
      }
      if (!hasCurrentLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { kind: "lease_lost" };
      }
      if (run.status === "running") return { kind: "continue" };
      if (run.status !== "cancelling") return { kind: "lease_lost" };

      const runningModelSteps = await trx<RawStep>("o_agent_step")
        .where({ runId: run.id, workspaceId: run.workspaceId, kind: "model", status: "running" })
        .orderBy("seq", "asc");
      if (runningModelSteps.some((modelStep) => (
        dispatchState(modelStep) === "dispatched" && modelStep.id !== knownModelResultStepId
      ))) {
        return { kind: "outcome_uncertain" };
      }
      if (!terminalWriteAllowed) return { kind: "cancellation_pending" };

      const response = await trx<RawMessage>("o_agent_message")
        .where({
          id: prepared.responseMessageId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
          role: "assistant",
        })
        .first();
      if (!response || !["pending", "streaming"].includes(response.status)) {
        throw new Error(`Run ${run.id} 主动取消时响应消息状态无效`);
      }
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Run ${run.id} 主动取消时 Thread 不存在`);

      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          status: "cancelling",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: "cancelled",
          waitType: null,
          waitRef: null,
          wakeAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: null,
          completedAt: now,
          version: runVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(runUpdated) !== 1) return { kind: "lease_lost" };

      const terminalSteps: AgentStep[] = [];
      for (const modelStep of runningModelSteps) {
        const stepUpdated = await trx("o_agent_step")
          .where({ id: modelStep.id, runId: run.id, kind: "model", status: "running" })
          .update({
            status: "cancelled",
            errorCategory: CANCELLED_MESSAGE_ERROR.code,
            safeError: JSON.stringify(CANCELLED_MESSAGE_ERROR),
            updatedAt: now,
            completedAt: now,
          });
        if (affectedRows(stepUpdated) !== 1) {
          throw new Error(`Run ${run.id} 主动取消时模型 Step 状态冲突`);
        }
        terminalSteps.push(asAgentStep({
          ...modelStep,
          status: "cancelled",
          errorCategory: CANCELLED_MESSAGE_ERROR.code,
          safeError: CANCELLED_MESSAGE_ERROR,
          updatedAt: now,
          completedAt: now,
        }));
      }

      const responseUpdated = await trx("o_agent_message")
        .where({
          id: prepared.responseMessageId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
          status: response.status,
        })
        .update({
          status: "stopped",
          content: JSON.stringify([]),
          error: JSON.stringify(CANCELLED_MESSAGE_ERROR),
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(responseUpdated) !== 1) {
        throw new Error(`Run ${run.id} 主动取消时响应消息状态冲突`);
      }

      const threadVersion = Number(thread.version || 0);
      const firstEventSeq = Number(thread.eventSeq || 0) + 1;
      const messageEventSeq = firstEventSeq + terminalSteps.length;
      const runEventSeq = messageEventSeq + 1;
      const threadPatch: Record<string, unknown> = {
        eventSeq: runEventSeq,
        lastMessageAt: now,
        version: threadVersion + 1,
        updatedAt: now,
      };
      if (thread.activeRootRunId === run.id) threadPatch.activeRootRunId = null;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update(threadPatch);
      if (affectedRows(threadUpdated) !== 1) {
        throw new Error(`Run ${run.id} 主动取消时 Thread 版本冲突`);
      }

      for (let index = 0; index < terminalSteps.length; index += 1) {
        const terminalStep = terminalSteps[index];
        await this.eventAppender(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: prepared.responseMessageId,
          stepId: terminalStep.id,
          seq: firstEventSeq + index,
          type: "step.cancelled",
          payload: { step: toAgentStepDto(terminalStep) },
          createdAt: now,
        });
      }
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        seq: messageEventSeq,
        type: "message.stopped",
        payload: {
          messageId: prepared.responseMessageId,
          status: "stopped",
          code: CANCELLED_MESSAGE_ERROR.code,
        },
        createdAt: now,
      });
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        seq: runEventSeq,
        type: "run.cancelled",
        payload: { runId: run.id, status: "cancelled", reason: "cancel_requested" },
        createdAt: now,
      });
      return { kind: "cancelled" };
    });
  }


  private async markPreparedModelFailed(
    prepared: PreparedLoop,
    step: RawStep,
    error: { code: string; message: string },
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;
      if (stored.status !== "running" || dispatchState(stored) !== "prepared") return false;
      return this.markModelStepTerminalInTransaction(trx, prepared, run, stored, "failed", error, now);
    });
  }

  private async markDispatchedModelFailed(
    prepared: PreparedLoop,
    step: RawStep,
    error: { code: string; message: string },
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;
      if (stored.status !== "running" || dispatchState(stored) !== "dispatched") return false;
      return this.markModelStepTerminalInTransaction(trx, prepared, run, stored, "failed", error, now);
    });
  }

  private async markModelUncertain(prepared: PreparedLoop, step: RawStep, now: number): Promise<void> {
    await this.database.transaction(async (trx) => {
      const run = await trx<RawRun>("o_agent_run").where({ id: prepared.run.id }).first();
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      if (!run || !stored || stored.status !== "running" || dispatchState(stored) !== "dispatched") return;
      await this.markModelStepTerminalInTransaction(
        trx,
        prepared,
        run,
        stored,
        "uncertain",
        TOOL_LOOP_UNCERTAIN_ERROR,
        now,
      );
    });
  }

  private async markModelStepTerminalInTransaction(
    trx: Knex.Transaction,
    prepared: PreparedLoop,
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
      .where({ id: run.threadId, workspaceId: run.workspaceId }).first();
    if (!thread) throw new Error(`Run ${run.id} 标记模型 Step 时 Thread 不存在`);
    const threadVersion = Number(thread.version || 0);
    const eventSeq = Number(thread.eventSeq || 0) + 1;
    const threadUpdated = await trx("o_agent_thread")
      .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
      .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
    if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 标记模型 Step 时 Thread 版本冲突`);
    const terminal = asAgentStep({
      ...step,
      status,
      errorCategory: error.code,
      safeError: error,
      updatedAt: now,
      completedAt: now,
    });
    await appendAgentEvent(trx, {
      workspaceId: run.workspaceId,
      projectId: Number(run.projectId),
      threadId: run.threadId,
      runId: run.id,
      messageId: prepared.responseMessageId,
      stepId: step.id,
      seq: eventSeq,
      type: status === "uncertain" ? "step.uncertain" : "step.failed",
      payload: { step: toAgentStepDto(terminal) },
      createdAt: now,
    });
    return true;
  }

  private async finalize(
    prepared: PreparedLoop,
    input: AgentRunProcessInput,
    workerId: string,
    status: "succeeded" | "failed",
    error: { code: string; message: string } | null,
    content: AgentContentPart[],
  ): Promise<AgentRunProcessResult> {
    const result = await this.database.transaction(async (trx): Promise<AgentRunProcessResult> => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      const response = await trx<RawMessage>("o_agent_message")
        .where({ id: prepared.responseMessageId, runId: run.id, threadId: run.threadId })
        .first();
      if (!response || response.status !== "pending") throw new Error(`Run ${run.id} 最终消息状态无效`);
      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          workspaceId: run.workspaceId,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status,
          error: error ? JSON.stringify(error) : null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt: now,
          version: runVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(runUpdated) !== 1) {
        return { status: "lease_lost", runId: run.id, responseMessageId: prepared.responseMessageId };
      }
      const messageStatus = status === "succeeded" ? "completed" : "error";
      const runPolicy = parseObject(run.policySnapshot);
      const contextUsage = status === "succeeded" && runPolicy.modelEnabled === true
        ? agentMessageContextUsageFromSnapshot(runPolicy.contextSnapshot)
        : null;
      const responseUpdated = await trx("o_agent_message")
        .where({ id: prepared.responseMessageId, runId: run.id, status: "pending" })
        .update({
          status: messageStatus,
          content: JSON.stringify(status === "succeeded" ? content : []),
          error: error ? JSON.stringify(error) : null,
          metadata: JSON.stringify({
            ...parseObject(response.metadata),
            ...(contextUsage ? { contextUsage } : {}),
          }),
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(responseUpdated) !== 1) throw new Error(`Run ${run.id} 最终消息写入失败`);
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId }).first();
      if (!thread) throw new Error(`Run ${run.id} 最终写入时 Thread 不存在`);
      const threadVersion = Number(thread.version || 0);
      const firstEventSeq = Number(thread.eventSeq || 0) + 1;
      const patch: Record<string, unknown> = {
        eventSeq: firstEventSeq + 1,
        lastMessageAt: now,
        version: threadVersion + 1,
        updatedAt: now,
      };
      if (thread.activeRootRunId === run.id) patch.activeRootRunId = null;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update(patch);
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 最终写入时 Thread 版本冲突`);
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        seq: firstEventSeq,
        type: status === "succeeded" ? "message.completed" : "message.error",
        payload: {
          messageId: prepared.responseMessageId,
          status: messageStatus,
          ...(error ? { code: error.code } : {}),
        },
        createdAt: now,
      });
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        seq: firstEventSeq + 1,
        type: status === "succeeded" ? "run.succeeded" : "run.failed",
        payload: { runId: run.id, status, ...(error ? { code: error.code } : {}) },
        createdAt: now,
      });
      return { status, runId: run.id, responseMessageId: prepared.responseMessageId };
    });
    if (result.status === "lease_lost" && error?.code !== TOOL_LOOP_UNCERTAIN_ERROR.code) {
      const cancellation = await this.finishCancellationAtBoundary(prepared, input, workerId);
      if (cancellation.kind === "cancelled") {
        return { status: "cancelled", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
    }
    return result;
  }
}
