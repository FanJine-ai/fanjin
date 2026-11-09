/**
 * `mocked` is an internal synthetic-provider result used by automated tests.
 * It may remain terminal for worker/idempotency purposes, but production must
 * never expose it as real success or capture a user's reserved balance for it.
 */
export function relayMockIsSuccessful(runtime = process.env.NODE_ENV): boolean {
  return runtime === "test";
}

export const RELAY_SYNTHETIC_QUARANTINE_MESSAGE =
  "历史测试模拟结果已隔离，请重新生成";

export function shouldQuarantineRelayArtifacts(
  status: unknown,
  runtime = process.env.NODE_ENV,
): boolean {
  return (
    String(status || "").trim().toLowerCase() === "mocked"
    && !relayMockIsSuccessful(runtime)
  );
}

export function isRelayBillingSuccess(status: unknown, runtime = process.env.NODE_ENV): boolean {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "mocked") return relayMockIsSuccessful(runtime);
  return ["succeeded", "success", "completed"].includes(normalized);
}

export function publicRelayStatus(status: string, runtime = process.env.NODE_ENV): string {
  if (status === "mocked") return relayMockIsSuccessful(runtime) ? "succeeded" : "failed";
  if (status === "enhancing") return "running";
  return status;
}

export function relaySuccessFilterStatuses(runtime = process.env.NODE_ENV): string[] {
  return relayMockIsSuccessful(runtime) ? ["succeeded", "mocked"] : ["succeeded"];
}
