import { ApiError } from "../../api/http";
import type { AgentRuntimeRun } from "../../features/agent-runtime/types";

const CONVERSATION_STORAGE_KEY_PREFIX = "fanjin-agent-conversations:v2";
const PENDING_AGENT_SUBMISSION_KEY_PREFIX = "fanjin-agent-pending:v1";
const PENDING_AGENT_SUBMISSION_TTL_MS = 24 * 60 * 60 * 1_000;

type AgentSubmissionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PendingAgentSubmission = {
  projectId: number | null;
  brief: string;
  idempotencyKey: string;
  clientMessageId: string;
  threadId: string | null;
  createdAt: number;
};

function localStorageForSubmission(): AgentSubmissionStorage {
  return window.localStorage;
}

export function generateStorageScope(
  userId: string | number | null | undefined,
  workspaceId: string | number | null | undefined,
) {
  if (
    userId === null
    || userId === undefined
    || workspaceId === null
    || workspaceId === undefined
  ) return null;
  return `${encodeURIComponent(String(userId))}:${encodeURIComponent(String(workspaceId))}`;
}

export function generateConversationStorageKey(scope: string | null) {
  return scope ? `${CONVERSATION_STORAGE_KEY_PREFIX}:${scope}` : null;
}

export function pendingAgentSubmissionKey(scope: string | null, projectId: number | null) {
  return scope ? `${PENDING_AGENT_SUBMISSION_KEY_PREFIX}:${scope}:${projectId ?? "new"}` : null;
}

export function agentProjectRecoveryKey(scope: string | null, projectId: number | null) {
  return scope && projectId !== null ? `${scope}:${projectId}` : null;
}

export function readPendingAgentSubmission(
  key: string | null,
  storage: AgentSubmissionStorage = localStorageForSubmission(),
  now = Date.now(),
): PendingAgentSubmission | null {
  if (!key) return null;
  try {
    const value = JSON.parse(storage.getItem(key) || "null") as Partial<PendingAgentSubmission> | null;
    const createdAt = Number(value?.createdAt || 0);
    if (
      !value
      || (value.projectId !== null && !Number.isInteger(value.projectId))
      || typeof value.brief !== "string"
      || typeof value.idempotencyKey !== "string"
      || typeof value.clientMessageId !== "string"
      || !Number.isFinite(createdAt)
      || createdAt <= now - PENDING_AGENT_SUBMISSION_TTL_MS
    ) {
      storage.removeItem(key);
      return null;
    }
    return {
      projectId: value.projectId === null ? null : Number(value.projectId),
      brief: value.brief,
      idempotencyKey: value.idempotencyKey,
      clientMessageId: value.clientMessageId,
      threadId: typeof value.threadId === "string" && value.threadId ? value.threadId : null,
      createdAt,
    };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writePendingAgentSubmission(
  key: string | null,
  value: PendingAgentSubmission,
  storage: AgentSubmissionStorage = localStorageForSubmission(),
) {
  if (!key) return;
  storage.setItem(key, JSON.stringify(value));
}

export function clearPendingAgentSubmission(
  key: string | null,
  clientMessageId?: string,
  storage: AgentSubmissionStorage = localStorageForSubmission(),
  now = Date.now(),
) {
  if (!key) return;
  if (clientMessageId) {
    const current = readPendingAgentSubmission(key, storage, now);
    if (current && current.clientMessageId !== clientMessageId) return;
  }
  storage.removeItem(key);
}

export function isTerminalAgentRun(run: Pick<AgentRuntimeRun, "status">) {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

export function isDefinitiveAgentClientError(error: ApiError) {
  const status = Number(error.status || 0);
  return status >= 400 && status < 500 && ![401, 408, 409, 425, 429].includes(status);
}

export function isRetryableAgentStreamError(error: unknown) {
  if ((error as { name?: string })?.name === "AbortError") return false;
  if (!(error instanceof ApiError)) return true;
  const status = Number(error.status || 0);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
