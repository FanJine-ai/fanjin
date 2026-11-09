import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";

export const LEGACY_ASYNC_RELAY_UNAVAILABLE_MESSAGE =
  "该遗留异步中转已接入统一计费，但幂等任务映射尚未完成，生产环境继续关闭";

export function isProductionRuntime(nodeEnv = process.env.NODE_ENV): boolean {
  const value = String(nodeEnv || "").trim().toLowerCase();
  return value === "prod" || value === "production";
}

/**
 * Midjourney and Suno now use the unified billing reservation/reconciliation
 * lifecycle and disable submit replay. Their provider task ids are still not
 * durably mapped to tenant-scoped local ids, so production exposure remains
 * closed until that separate authorization/idempotency boundary is complete.
 */
export function legacyAsyncRelayAvailable(
  nodeEnv = process.env.NODE_ENV,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isProductionRuntime(nodeEnv) && !isRecoveryOnlyMode(environment);
}
