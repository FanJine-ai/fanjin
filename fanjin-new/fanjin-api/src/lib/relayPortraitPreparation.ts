export const PORTRAIT_PREPARATION_VERSION = "relay-portrait-preparation/v1";
export const PORTRAIT_PREPARATION_MESSAGE = "正在登记参考素材，通过后自动生成";
export const PORTRAIT_PREPARATION_TIMEOUT_MS = 24 * 60 * 60_000;

export type RelayPortraitPreparation = {
  version: typeof PORTRAIT_PREPARATION_VERSION;
  state: "waiting" | "ready" | "failed" | "cancelled";
  requestedAt: number;
  deadlineAt: number;
  nextAttemptAt: number;
  attempts: number;
  maximumCostMicros: number;
  accountFingerprint: string;
  initialPolicyEvidenceDigest?: string | null;
  readyAt?: number;
  errorCode?: string;
  errorMessage?: string;
};

type PreparationTask = {
  status: string;
  providerTaskId?: string | null;
  resultPayload?: Record<string, any>;
  providerPayload?: Record<string, any>;
};

/** Server-owned checkpoint. Never read a preparation marker from request JSON. */
export function readRelayPortraitPreparation(task: PreparationTask): RelayPortraitPreparation | null {
  const value = task.resultPayload?.internal?.portraitPreparation;
  return value?.version === PORTRAIT_PREPARATION_VERSION ? value : null;
}

export function isRelayPortraitPreparing(task: PreparationTask): boolean {
  return task.status === "queued" && !task.providerTaskId
    && readRelayPortraitPreparation(task)?.state === "waiting";
}

export function relayPortraitPreparationView(task: PreparationTask) {
  const preparing = isRelayPortraitPreparing(task);
  return {
    preparationStage: preparing ? "portrait_registration" as const : null,
    statusMessage: preparing ? PORTRAIT_PREPARATION_MESSAGE : null,
  };
}

/** Only non-dispatch preparation errors may be deferred. Refusals and revoked rights are final. */
export function isPortraitPreparationPending(error: unknown): boolean {
  const value = error as { code?: string; retryable?: boolean } | null;
  return value?.retryable !== false && [
    "portrait_provider_binding_pending", "portrait_source_digest_pending",
    "portrait_source_digest_missing",
  ].includes(String(value?.code));
}
