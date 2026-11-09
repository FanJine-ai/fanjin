export const DEFAULT_WORKER_HEARTBEAT_FUTURE_SKEW_MS = 5_000;
export const MAX_WORKER_HEARTBEAT_FUTURE_SKEW_MS = 60_000;
export const WORKER_HEARTBEAT_FUTURE_SKEW_ENV = "FANJIN_WORKER_HEARTBEAT_FUTURE_SKEW_MS";

/**
 * Limits how far a Worker heartbeat may be ahead of the Controller/API clock.
 * A strict upper bound prevents a bad clock or forged timestamp from keeping
 * an incarnation "fresh" indefinitely.
 */
export function resolveWorkerHeartbeatFutureSkewMs(
  raw: unknown = process.env[WORKER_HEARTBEAT_FUTURE_SKEW_ENV],
): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_WORKER_HEARTBEAT_FUTURE_SKEW_MS;
  }
  const normalized = typeof raw === "number" ? raw : String(raw).trim();
  const value = typeof normalized === "number"
    ? normalized
    : /^\d+$/.test(normalized)
      ? Number(normalized)
      : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_WORKER_HEARTBEAT_FUTURE_SKEW_MS) {
    throw new TypeError(
      `${WORKER_HEARTBEAT_FUTURE_SKEW_ENV} must be an integer between 0 and ${MAX_WORKER_HEARTBEAT_FUTURE_SKEW_MS}`,
    );
  }
  return value;
}
