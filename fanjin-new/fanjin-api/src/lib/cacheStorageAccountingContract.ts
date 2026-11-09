/**
 * Pure cache-storage pricing contract.
 *
 * This module deliberately has no database or wallet imports so the same
 * closed contract can be enforced while an administrator saves a pricing
 * rule, during production readiness checks, and again at relay settlement.
 * Values are already certified GU micros; currency conversion never occurs
 * in the billing runtime.
 */
export const CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION =
  "cache-storage-accrual.v1" as const;
export const CACHE_STORAGE_MILLION_TOKENS = 1_000_000n;
export const CACHE_STORAGE_HOUR_MS = 3_600_000n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface CacheWriteAccountingContract {
  version: typeof CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION;
  priceMicrosPerMTokenHour: number;
  ttlSeconds: number;
}

export class CacheStorageAccountingContractValidationError extends Error {
  readonly code = "CACHE_STORAGE_ACCOUNTING_CONTRACT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CacheStorageAccountingContractValidationError";
  }
}

function fail(message: string): never {
  throw new CacheStorageAccountingContractValidationError(message);
}

function exactObject(value: unknown, field: string): Record<string, unknown> {
  const prototype = value && typeof value === "object"
    ? Object.getPrototypeOf(value)
    : null;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    fail(`${field} 必须是精确对象`);
  }
  return value as Record<string, unknown>;
}

function exactSafeInteger(
  value: unknown,
  field: string,
  options: { positive?: boolean } = {},
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || (options.positive ? value <= 0 : value < 0)
  ) {
    fail(`${field} 必须是${options.positive ? "正" : "非负"}安全整数`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) {
    fail(`${field} 字段必须精确为 ${required.join(",")}`);
  }
}

/**
 * Parse the only accepted pricing-rule contract. The surrounding ruleConfig
 * may contain other pricing fields, but the nested accounting object is
 * closed: unknown, missing, float or string-valued fields fail closed.
 */
export function parseCacheWriteAccountingContract(
  ruleConfig: unknown,
): CacheWriteAccountingContract | null {
  const config = exactObject(ruleConfig, "ruleConfig");
  if (!("cacheWriteAccounting" in config)) return null;
  const accounting = exactObject(
    config.cacheWriteAccounting,
    "ruleConfig.cacheWriteAccounting",
  );
  assertExactKeys(
    accounting,
    ["version", "priceMicrosPerMTokenHour", "ttlSeconds"],
    "ruleConfig.cacheWriteAccounting",
  );
  if (accounting.version !== CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION) {
    fail("cacheWriteAccounting.version 不受支持");
  }
  const priceMicrosPerMTokenHour = exactSafeInteger(
    accounting.priceMicrosPerMTokenHour,
    "cacheWriteAccounting.priceMicrosPerMTokenHour",
    { positive: true },
  );
  const ttlSeconds = exactSafeInteger(
    accounting.ttlSeconds,
    "cacheWriteAccounting.ttlSeconds",
    { positive: true },
  );
  if (BigInt(ttlSeconds) * 1_000n > MAX_SAFE_BIGINT) {
    fail("cacheWriteAccounting.ttlSeconds 派生毫秒超出安全整数范围");
  }
  return {
    version: CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION,
    priceMicrosPerMTokenHour,
    ttlSeconds,
  };
}

function exactBigInt(
  value: unknown,
  field: string,
  options: { positive?: boolean } = {},
): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    fail(`${field} 必须是精确整数`);
  }
  if (options.positive ? parsed <= 0n : parsed < 0n) {
    fail(`${field} 必须是${options.positive ? "正" : "非负"}整数`);
  }
  return parsed;
}

function safeNumber(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    fail(`${field} 超出安全整数范围`);
  }
  return Number(value);
}

/** Exact cumulative floor in GU micros; no floating point or CNY conversion. */
export function calculateCumulativeCacheStorageMicros(input: {
  cacheWriteTokens: number | string | bigint;
  priceMicrosPerMTokenHour: number | string | bigint;
  startedAt: number | string | bigint;
  throughAt: number | string | bigint;
}): number {
  const tokens = exactBigInt(input.cacheWriteTokens, "cacheWriteTokens", {
    positive: true,
  });
  const price = exactBigInt(
    input.priceMicrosPerMTokenHour,
    "priceMicrosPerMTokenHour",
    { positive: true },
  );
  const startedAt = exactBigInt(input.startedAt, "startedAt");
  const throughAt = exactBigInt(input.throughAt, "throughAt");
  if (throughAt < startedAt) fail("throughAt 不得早于 startedAt");
  const numerator = tokens * price * (throughAt - startedAt);
  const denominator = CACHE_STORAGE_MILLION_TOKENS * CACHE_STORAGE_HOUR_MS;
  return safeNumber(numerator / denominator, "cumulative cache storage micros");
}
