import type {
  AgentMessageAttachmentInput,
  AgentMessageContextSnapshot,
  AgentMessageContextSnapshotInput,
  AgentMessageSkillRefInput,
  AgentRuntimeRun,
  AgentRuntimeStep,
} from "./types";

export const AGENT_RUN_RECOVERY_LABEL = "连接中断，等待恢复";
const AGENT_SAFE_RETRY_CLIENT_MESSAGE_PREFIX = "agent-safe-retry:";

export type AgentRunRecoveryState = {
  threadId: string;
  runId: string;
  clientMessageId: string | null;
  phase: "watching" | "recovering" | "succeeded" | "failed" | "cancelled";
  safeRetryAllowed: boolean;
};

/**
 * A transport failure is not a Run failure. Keep every server identity so a
 * reconnect or page refresh can query the same Run instead of creating a
 * second billable/effectful attempt.
 */
export function markAgentRunTransportDisconnected(
  state: Pick<AgentRunRecoveryState, "threadId" | "runId" | "clientMessageId">,
): AgentRunRecoveryState {
  return {
    ...state,
    phase: "recovering",
    safeRetryAllowed: false,
  };
}

export function isAgentRunSafeRetryable(
  run: Pick<AgentRuntimeRun, "status" | "sideEffectsCommitted">,
) {
  return (run.status === "failed" || run.status === "cancelled")
    && run.sideEffectsCommitted === false;
}

/**
 * An error code alone cannot rule out tools completed on earlier turns.
 * Only a complete history containing the initial model step is eligible;
 * another model request may still cost money and needs confirmation.
 */
const CONFIRMABLE_AGENT_RETRY_ERRORS = new Set([
  "invalid_tool_arguments",
  "model_tool_calls_invalid",
  "tool_not_available",
  "model_outcome_uncertain",
]);

export function isAgentRunConfirmableRetry(
  run: Pick<AgentRuntimeRun, "id" | "status" | "sideEffectsCommitted" | "error">,
  steps: ReadonlyArray<Pick<AgentRuntimeStep, "runId" | "kind">>,
) {
  return (run.status === "failed" || run.status === "cancelled")
    && run.sideEffectsCommitted === true
    && CONFIRMABLE_AGENT_RETRY_ERRORS.has(run.error?.code || "")
    && steps.length === 1
    && steps[0].runId === run.id
    && steps[0].kind === "model";
}

export function agentConfirmedRetryClientMessageId(sourceRunId: string) {
  return `agent-confirmed-retry:${sourceRunId}`;
}

/**
 * Reconcile a refresh/reconnect snapshot without ever changing the tracked
 * thread, Run or client-message identity.
 */
export function reconcileAgentRunRecoverySnapshot(
  state: Pick<AgentRunRecoveryState, "threadId" | "runId" | "clientMessageId">,
  run: Pick<AgentRuntimeRun, "id" | "threadId" | "status" | "sideEffectsCommitted">,
): AgentRunRecoveryState {
  if (run.id !== state.runId || run.threadId !== state.threadId) {
    throw new Error("Agent Run 恢复快照与原运行不匹配");
  }
  const phase = run.status === "succeeded"
    ? "succeeded"
    : run.status === "failed"
      ? "failed"
      : run.status === "cancelled"
        ? "cancelled"
        : "watching";
  return {
    ...state,
    phase,
    safeRetryAllowed: isAgentRunSafeRetryable(run),
  };
}

/**
 * One source Run maps to exactly one retry client-message identity. Browser
 * double-clicks and HTTP retries therefore replay the same retry Run.
 */
export function agentSafeRetryClientMessageId(sourceRunId: string) {
  return `${AGENT_SAFE_RETRY_CLIENT_MESSAGE_PREFIX}${sourceRunId}`;
}

export type AgentSafeRetryContext = {
  attachments: AgentMessageAttachmentInput[];
  skillRefs: AgentMessageSkillRefInput[];
  contextSnapshot: AgentMessageContextSnapshotInput;
};

/**
 * Reconstruct the persisted portion of the server-confirmed context. URL-only
 * references cannot be safely invented; durable assetVersion references can.
 */
export function agentSafeRetryContextFromSnapshot(
  snapshot: AgentMessageContextSnapshot | null | undefined,
): AgentSafeRetryContext {
  if (!snapshot) {
    return { attachments: [], skillRefs: [], contextSnapshot: {} };
  }
  return {
    attachments: snapshot.attachments.map((attachment) => ({
      kind: String(attachment.kind || "").toLowerCase() === "image" ? "image" : "file",
      name: attachment.name,
      assetRef: attachment.assetVersionId,
    })),
    skillRefs: snapshot.skills.map((skill) => ({
      key: skill.key,
      version: skill.version,
    })),
    contextSnapshot: {
      assetRefs: snapshot.assets.map((asset) => ({ assetId: asset.assetId })),
      style: snapshot.style,
      ...(snapshot.generationPreferences
        ? { generationPreferences: snapshot.generationPreferences }
        : {}),
    },
  };
}
