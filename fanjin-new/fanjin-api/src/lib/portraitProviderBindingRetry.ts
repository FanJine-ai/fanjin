import {
  PORTRAIT_IMAGE_REFERENCE_PROTOCOL_UNSUPPORTED_CODE,
  RelayImageError,
} from "@/lib/relayImage";

export const PORTRAIT_PROVIDER_BINDING_PENDING_CODE =
  "portrait_provider_binding_pending" as const;

const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

function boundedPositiveInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

/**
 * Only this exact admission error is safe to put back on a dispatch queue.
 * Relay emits it before a billing reservation or provider POST exists and
 * marks `upstreamMayHaveAccepted=false`. Other 409s must keep their existing
 * terminal/reconciliation semantics.
 */
export function isRetryablePortraitProviderBindingPending(
  error: unknown,
): error is RelayImageError {
  if (!(error instanceof RelayImageError)) return false;
  const metadata = error.reconciliationMetadata || {};
  return error.upstreamMayHaveAccepted === false
    && error.reconcileReason === PORTRAIT_PROVIDER_BINDING_PENDING_CODE
    && metadata.retryable !== false;
}

export function isUnsupportedPortraitImageReference(
  error: unknown,
): error is RelayImageError & {
  reconcileReason: typeof PORTRAIT_IMAGE_REFERENCE_PROTOCOL_UNSUPPORTED_CODE;
} {
  return error instanceof RelayImageError
    && error.upstreamMayHaveAccepted === false
    && error.reconcileReason
      === PORTRAIT_IMAGE_REFERENCE_PROTOCOL_UNSUPPORTED_CODE;
}

export function portraitProviderBindingRetryDelayMs(attempt: number): number {
  const base = boundedPositiveInteger(
    process.env.FANJIN_PORTRAIT_BINDING_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
    60_000,
  );
  const maximum = Math.max(
    base,
    boundedPositiveInteger(
      process.env.FANJIN_PORTRAIT_BINDING_RETRY_MAX_MS,
      DEFAULT_RETRY_MAX_MS,
      15 * 60_000,
    ),
  );
  const normalizedAttempt = Number.isSafeInteger(attempt) && attempt > 0
    ? Math.min(attempt, 16)
    : 1;
  return Math.min(maximum, base * (2 ** (normalizedAttempt - 1)));
}

export function portraitProviderBindingRetrySchedule(input: {
  previousAttempt: number;
  now?: number;
}): { attempt: number; retryAfterMs: number; retryAvailableAt: number } {
  const attempt = Number.isSafeInteger(input.previousAttempt)
    && input.previousAttempt > 0
    ? input.previousAttempt + 1
    : 1;
  const retryAfterMs = portraitProviderBindingRetryDelayMs(attempt);
  return {
    attempt,
    retryAfterMs,
    retryAvailableAt: (input.now ?? Date.now()) + retryAfterMs,
  };
}
