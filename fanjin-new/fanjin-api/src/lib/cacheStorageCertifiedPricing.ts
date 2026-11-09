import {
  CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION,
  type CacheWriteAccountingContract,
} from "@/lib/cacheStorageAccountingContract";

/**
 * Certified platform price in GU micros per million cached tokens per hour.
 *
 * Commercial source (checked 2026-08-05):
 * https://www.volcengine.com/product/ark
 * The public list price is represented here only after certification into the
 * platform's GU ledger unit. Billing code consumes this integer unchanged.
 */
export const CERTIFIED_CACHE_STORAGE_PRICE_MICROS_PER_M_TOKEN_HOUR =
  17_000_000;

/**
 * Conservative fixed contract for integrations that do not expose a
 * per-request cache TTL in authoritative usage. Ark accepts 3600..604800s;
 * using its minimum prevents inventing a longer billable retention window.
 * https://api.volcengine.com/api-docs/view?action=ContextCreate&serviceCode=ark&version=2024-01-01
 */
export const CERTIFIED_CACHE_STORAGE_TTL_SECONDS = 3_600;

export const CACHE_STORAGE_CERTIFICATION_METADATA = Object.freeze({
  priceSource: "volcengine-ark-public-list-price-2026-08-05",
  priceSourceUrl: "https://www.volcengine.com/product/ark",
  ttlPolicy: "minimum-supported-provider-ttl",
  ttlSourceUrl:
    "https://api.volcengine.com/api-docs/view?action=ContextCreate&serviceCode=ark&version=2024-01-01",
} as const);

export function certifiedCacheWriteAccountingContract(): CacheWriteAccountingContract {
  return {
    version: CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION,
    priceMicrosPerMTokenHour:
      CERTIFIED_CACHE_STORAGE_PRICE_MICROS_PER_M_TOKEN_HOUR,
    ttlSeconds: CERTIFIED_CACHE_STORAGE_TTL_SECONDS,
  };
}
