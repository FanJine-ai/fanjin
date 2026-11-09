import { AgentRuntimeError } from "@/agent-runtime/errors";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import type { AgentContentPart, AgentMessage, AgentRun, AgentStep } from "@/agent-runtime/types";

const AGENT_SAFE_RETRY_CLIENT_MESSAGE_PREFIX = "agent-safe-retry:";
const MODEL_STEP_IDEMPOTENCY_PREFIX = "agent-model:";
const TOOL_LOOP_MODEL_REQUEST_PREFIX = "agent-run:";
const TOOL_LOOP_MODEL_TURN_REFERENCE_TYPE = "model_turn";
const MODEL_PREPARED_REFERENCE_TYPES = new Set([
  "model_dispatch_state",
  "model_request_id_digest",
  "model_idempotency_key_digest",
]);
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function agentSafeRetryClientMessageId(sourceRunId: string) {
  return `${AGENT_SAFE_RETRY_CLIENT_MESSAGE_PREFIX}${sourceRunId}`;
}

function hasOnlyPreparedModelStepEvidence(
  sourceRun: AgentRun,
  sourceSteps: readonly AgentStep[],
) {
  if (sourceSteps.length === 0) {
    return sourceRun.checkpointStepSeq === 0;
  }
  if (sourceSteps.length !== 1) return false;
  const step = sourceSteps[0];
  if (
    sourceRun.checkpointStepSeq !== step.seq
    || step.seq <= 0
    || step.workspaceId !== sourceRun.workspaceId
    || step.projectId !== sourceRun.projectId
    || step.threadId !== sourceRun.threadId
    || step.runId !== sourceRun.id
    || step.parentStepId !== null
    || step.kind !== "model"
    || step.status !== (sourceRun.status === "cancelled" ? "cancelled" : "failed")
    || step.toolName !== null
    || step.argumentsDigest !== null
    || step.provider !== null
    || step.outputRefs.length !== 0
    || Object.keys(step.usage).length !== 0
    || step.costMicros !== 0
    || !step.errorCategory
    || !step.safeError
    || step.startedAt === null
    || step.completedAt === null
  ) {
    return false;
  }
  const refs = new Map<string, unknown>();
  for (const ref of step.inputRefs) {
    const type = typeof ref.type === "string" ? ref.type : "";
    if ((!MODEL_PREPARED_REFERENCE_TYPES.has(type) && type !== TOOL_LOOP_MODEL_TURN_REFERENCE_TYPE)
      || refs.has(type)) {
      return false;
    }
    refs.set(type, ref.value);
  }
  if (refs.get("model_dispatch_state") !== "prepared") return false;

  const legacyPrepared = step.idempotencyKey === `${MODEL_STEP_IDEMPOTENCY_PREFIX}${sourceRun.id}`
    && refs.size === MODEL_PREPARED_REFERENCE_TYPES.size
    && [...MODEL_PREPARED_REFERENCE_TYPES].every((type) => refs.has(type))
    && SHA256_HEX.test(String(refs.get("model_request_id_digest") || ""))
    && SHA256_HEX.test(String(refs.get("model_idempotency_key_digest") || ""));
  if (legacyPrepared) return true;

  // Tool-loop Runs use a turn-scoped Step/request identity. Only turn 1 can be
  // retried: a later turn proves an earlier model/tool result already exists.
  // Bind both persisted digests to the exact request key instead of accepting
  // an arbitrary SHA-shaped value.
  const turn = 1;
  const requestKey = `${TOOL_LOOP_MODEL_REQUEST_PREFIX}${sourceRun.id}:model-turn:${turn}`;
  return step.seq === 1
    && step.idempotencyKey === `${MODEL_STEP_IDEMPOTENCY_PREFIX}${sourceRun.id}:turn:${turn}`
    && refs.size === MODEL_PREPARED_REFERENCE_TYPES.size + 1
    && [...MODEL_PREPARED_REFERENCE_TYPES].every((type) => refs.has(type))
    && refs.get(TOOL_LOOP_MODEL_TURN_REFERENCE_TYPE) === turn
    && refs.get("model_request_id_digest") === hashIdempotencyRequest({ requestId: requestKey })
    && refs.get("model_idempotency_key_digest") === hashIdempotencyRequest({ idempotencyKey: requestKey });
}

export function assertAgentSafeRetryAllowed(input: {
  sourceRun: AgentRun;
  sourceMessage: AgentMessage;
  sourceSteps: readonly AgentStep[];
  threadId: string;
  clientMessageId: string;
  incomingContent: readonly AgentContentPart[];
  incomingContextDigest: string;
  incomingChatModelId: string;
}) {
  const { sourceRun } = input;
  if (sourceRun.threadId !== input.threadId || sourceRun.kind !== "root") {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_source_mismatch",
      "安全重试来源不属于当前 Thread 的根 Run",
    );
  }
  if (sourceRun.status !== "failed" && sourceRun.status !== "cancelled") {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_source_not_terminal",
      "原运行尚未明确失败或取消，只能恢复原运行",
    );
  }
  if (sourceRun.sideEffectsCommitted) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_side_effects_committed",
      "原运行已提交外部副作用，禁止自动重试",
    );
  }
  if (
    sourceRun.actualSpendMicros !== 0
    || !hasOnlyPreparedModelStepEvidence(sourceRun, input.sourceSteps)
  ) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_execution_started",
      "原运行已进入模型、Relay 或工具执行，无法证明未派发，禁止创建第二次运行",
    );
  }
  const billing = sourceRun.policySnapshot.chatBilling;
  const billingRecord = billing && typeof billing === "object" && !Array.isArray(billing)
    ? billing as Record<string, unknown>
    : null;
  const billingIsFree = billingRecord?.status === "free"
    && Number(billingRecord.costMicros || 0) === 0;
  const billingWasRefunded = billingRecord?.status === "charged"
    && Number.isFinite(Number(billingRecord.refundedAt))
    && Number(billingRecord.refundedAt) > 0;
  // Token-metered Agent runs reserve an authorization amount but do not charge
  // it until authoritative usage is returned. The execution-evidence guard
  // above has already proved that no provider dispatch started and that actual
  // spend is zero, so this state is as safe to retry as a free/refunded run.
  const tokenAuthorizationWasNotCharged = billingRecord?.status === "token_metered"
    && billingRecord.billingMode === "token"
    && billingRecord.settlement === "authoritative_usage"
    && sourceRun.actualSpendMicros === 0;
  if (!billingIsFree && !billingWasRefunded && !tokenAuthorizationWasNotCharged) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_billing_unsettled",
      "原运行费用尚未确认免费或完成退款，禁止再次计费",
    );
  }
  const sourceChatModel = sourceRun.policySnapshot.chatModel;
  const sourceChatModelId = sourceChatModel
    && typeof sourceChatModel === "object"
    && !Array.isArray(sourceChatModel)
    && typeof (sourceChatModel as Record<string, unknown>).id === "string"
    ? String((sourceChatModel as Record<string, unknown>).id)
    : "";
  if (!sourceChatModelId || sourceChatModelId !== input.incomingChatModelId) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_model_mismatch",
      "安全重试必须使用原运行的对话模型",
    );
  }
  if (
    input.sourceMessage.id !== sourceRun.triggerMessageId
    || input.sourceMessage.threadId !== sourceRun.threadId
    || input.sourceMessage.runId !== sourceRun.id
    || input.sourceMessage.role !== "user"
  ) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_message_mismatch",
      "原运行的触发消息证据不完整",
    );
  }
  if (hashIdempotencyRequest(input.sourceMessage.content) !== hashIdempotencyRequest(input.incomingContent)) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_content_mismatch",
      "安全重试的消息正文与原运行不一致",
    );
  }
  const sourceSnapshot = input.sourceMessage.metadata.contextSnapshot;
  const sourceContextDigest = sourceSnapshot
    && typeof sourceSnapshot === "object"
    && !Array.isArray(sourceSnapshot)
    && typeof (sourceSnapshot as Record<string, unknown>).digest === "string"
    ? String((sourceSnapshot as Record<string, unknown>).digest)
    : "";
  if (!sourceContextDigest || sourceContextDigest !== input.incomingContextDigest) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_context_mismatch",
      "安全重试的持久化创作上下文与原运行不一致",
    );
  }
  if (input.clientMessageId !== agentSafeRetryClientMessageId(sourceRun.id)) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_client_message_id_invalid",
      "安全重试必须使用与原 Run 绑定的稳定 clientMessageId",
    );
  }
}
