import { ApiError } from "../../api/http";
import {
  resolveStableSubmissionAttempt,
  type StableSubmissionAttempt,
} from "./submissionAttempt";

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StoredSubmissionAttempt = StableSubmissionAttempt & {
  taskId?: number;
};

type StoredAttempt = StoredSubmissionAttempt & {
  savedAt: number;
};

const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1_000;

function persistentAttemptStorage(): AttemptStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function submissionAttemptStorageKey(flow: string, operationKey: string): string {
  return `fanjin-v4:item-attempt:${flow}:${operationKey}`;
}

export function readStoredSubmissionAttempt(
  key: string,
  storage: AttemptStorage | null = persistentAttemptStorage(),
  now = Date.now(),
): StoredSubmissionAttempt | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(key) || "null") as Partial<StoredAttempt> | null;
    if (
      !value
      || typeof value.fingerprint !== "string"
      || typeof value.idempotencyKey !== "string"
      || !value.fingerprint
      || !value.idempotencyKey
      || !Number.isFinite(value.savedAt)
      || Number(value.savedAt) <= now - ATTEMPT_TTL_MS
      || (
        value.taskId !== undefined
        && (!Number.isSafeInteger(Number(value.taskId)) || Number(value.taskId) <= 0)
      )
    ) {
      storage.removeItem(key);
      return null;
    }
    return {
      fingerprint: value.fingerprint,
      idempotencyKey: value.idempotencyKey,
      ...(value.taskId === undefined ? {} : { taskId: Number(value.taskId) }),
    };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeStoredSubmissionAttempt(
  key: string,
  attempt: StoredSubmissionAttempt,
  storage: AttemptStorage | null = persistentAttemptStorage(),
  now = Date.now(),
): void {
  if (!storage) return;
  try {
    let existing: Partial<StoredAttempt> | null = null;
    try {
      existing = JSON.parse(storage.getItem(key) || "null") as Partial<StoredAttempt> | null;
    } catch {
      // Replace malformed storage below.
    }
    if (
      existing?.fingerprint === attempt.fingerprint
      && existing.idempotencyKey === attempt.idempotencyKey
      && (
        existing.taskId === attempt.taskId
        || Number(existing.taskId) === Number(attempt.taskId)
      )
      && Number.isFinite(existing.savedAt)
    ) {
      return;
    }
    storage.setItem(key, JSON.stringify({ ...attempt, savedAt: now }));
  } catch {
    // In-memory retry safety remains available when storage is blocked or full.
  }
}

export function clearStoredSubmissionAttempt(
  key: string,
  storage: AttemptStorage | null = persistentAttemptStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Storage cleanup is best effort.
  }
}

function fingerprintHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function prepareStoredSubmissionAttempt(input: {
  current: StableSubmissionAttempt | null;
  flow: string;
  operationKey: string;
  prefix: string;
  payload: unknown;
  randomId?: () => string;
  storage?: AttemptStorage | null;
}): {
  attempt: StableSubmissionAttempt;
  storageKey: string;
} {
  const fingerprint = JSON.stringify(input.payload);
  const storageKey = submissionAttemptStorageKey(
    input.flow,
    `${input.operationKey}:${fingerprintHash(fingerprint)}`,
  );
  const storage = input.storage === undefined
    ? persistentAttemptStorage()
    : input.storage;
  const current = input.current?.fingerprint === fingerprint
    ? input.current
    : readStoredSubmissionAttempt(storageKey, storage);
  const attempt = resolveStableSubmissionAttempt(
    current,
    input.prefix,
    input.payload,
    input.randomId,
  );
  // Persist before dispatch. A browser refresh or a lost HTTP response must
  // replay the same server command instead of creating another paid request.
  writeStoredSubmissionAttempt(storageKey, attempt, storage);
  return { attempt, storageKey };
}

const AMBIGUOUS_ATTEMPT_ERROR_CODES = new Set([
  "ASSET_PROMPT_PENDING_RECONCILE",
  "ASSET_PROMPT_PERSISTENCE_RETRYABLE",
  "DIRECTOR_PLAN_PENDING_RECONCILE",
  "idempotency_in_progress",
  "idempotency_checkpoint_conflict",
  "idempotency_checkpoint_invalid",
  "image_result_invalid",
  "image_task_in_progress",
  "image_task_not_dispatchable",
  "image_task_pending_reconcile",
  "image_task_persistence_retryable",
  "image_task_provider_result_missing",
  "relay_task_pending_reconcile",
  "video_result_invalid",
  "video_submission_recovery_required",
]);

const DEFINITIVE_ATTEMPT_ERROR_CODES = new Set([
  "ASSET_PROMPT_INSUFFICIENT_BALANCE",
  "ASSET_PROMPT_UNAVAILABLE",
  "ASSET_PROMPT_UPSTREAM_REJECTED",
  "DIRECTOR_PLAN_BILLING_ERROR",
  "DIRECTOR_PLAN_INSUFFICIENT_BALANCE",
  "DIRECTOR_PLAN_UNAVAILABLE",
  "image_task_billing_failed",
  "image_task_upstream_rejected",
  "video_task_insufficient_balance",
  "relay_task_cancelled",
  "relay_task_failed",
]);

export function shouldRetainStoredSubmissionAttempt(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  const code = String(error.code || "");
  if (AMBIGUOUS_ATTEMPT_ERROR_CODES.has(code)) return true;
  if (DEFINITIVE_ATTEMPT_ERROR_CODES.has(code)) return false;
  const status = Number(error.status || 0);
  if (status >= 400 && status < 500) {
    return status === 408 || status === 409 || status === 425 || status === 429;
  }
  return true;
}

export function hasPendingReconcileSubmission(
  tasks: ReadonlyArray<{ status?: unknown; state?: unknown; errorCode?: unknown }>,
): boolean {
  return tasks.some((task) => (
    String(task.status || "").toLowerCase() === "pending_reconcile"
    || String(task.state || "").toLowerCase() === "pending_reconcile"
    || String(task.errorCode || "") === "relay_task_pending_reconcile"
  ));
}
