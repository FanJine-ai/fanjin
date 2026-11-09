import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  BillingError,
  billApiTask,
  type ApiTaskChargeResult,
  type BillingLedger,
  type UsageRecord,
} from "@/lib/billing";
import {
  CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION,
  CACHE_STORAGE_HOUR_MS,
  CACHE_STORAGE_MILLION_TOKENS,
  CacheStorageAccountingContractValidationError,
  calculateCumulativeCacheStorageMicros,
  parseCacheWriteAccountingContract,
  type CacheWriteAccountingContract,
} from "@/lib/cacheStorageAccountingContract";
import { CACHE_STORAGE_ACCRUAL_TABLE } from "@/lib/migrations/cacheStorageAccrual";
import { db } from "@/utils/db";

export {
  CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION,
  CACHE_STORAGE_HOUR_MS,
  CACHE_STORAGE_MILLION_TOKENS,
  type CacheWriteAccountingContract,
};
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_BILL_INTERVAL_MS = 60_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;

type CacheStorageDb = Knex | Knex.Transaction;

export interface CacheStorageAccrualRow {
  id: string;
  sourceUsageRecordId: string;
  sourceReservationId: string;
  workspaceId: string;
  apiKeyId: string | null;
  requestId: string | null;
  provider: string;
  channelId: string;
  model: string;
  pricingRuleId: string;
  contractVersion: string;
  cacheWriteTokens: number | string | bigint;
  priceMicrosPerMTokenHour: number | string | bigint;
  ttlSeconds: number | string | bigint;
  startedAt: number | string | bigint;
  expiresAt: number | string | bigint;
  billedThroughAt: number | string | bigint;
  billedMicros: number | string | bigint;
  status: "active" | "processing" | "closed" | "manual_required";
  nextBillAt: number | string | bigint;
  leaseOwner: string | null;
  leaseExpiresAt: number | string | bigint | null;
  fence: number | string | bigint;
  processingThroughAt: number | string | bigint | null;
  processingTotalMicros: number | string | bigint | null;
  processingDeltaMicros: number | string | bigint | null;
  processingIdempotencyKey: string | null;
  lastChargeUsageRecordId: string | null;
  lastChargeLedgerId: string | null;
  chargeCount: number | string | bigint;
  manualReason: string | null;
  reconcileJobId: string | null;
  closedAt: number | string | bigint | null;
  createdAt: number | string | bigint;
  updatedAt: number | string | bigint;
}

export interface CacheStorageBillingMetrics {
  createdTotal: number;
  chargeAttemptsTotal: number;
  chargeSuccessTotal: number;
  chargeFailuresTotal: number;
  insufficientBalanceTotal: number;
  manualRequiredTotal: number;
  recoveredExpiredProcessingTotal: number;
  databaseFailuresTotal: number;
  lastRunAt: number;
  lastRunSucceeded: boolean;
  active: number;
  processing: number;
  manualRequired: number;
  oldestDueAgeSeconds: number;
}

const cacheStorageMetrics: CacheStorageBillingMetrics = {
  createdTotal: 0,
  chargeAttemptsTotal: 0,
  chargeSuccessTotal: 0,
  chargeFailuresTotal: 0,
  insufficientBalanceTotal: 0,
  manualRequiredTotal: 0,
  recoveredExpiredProcessingTotal: 0,
  databaseFailuresTotal: 0,
  lastRunAt: 0,
  lastRunSucceeded: true,
  active: 0,
  processing: 0,
  manualRequired: 0,
  oldestDueAgeSeconds: 0,
};

export class CacheStorageBillingContractError extends BillingError {
  readonly code = "CACHE_STORAGE_BILLING_CONTRACT_INVALID";

  constructor(message: string) {
    super(message, 500);
    this.name = "CacheStorageBillingContractError";
  }
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
    throw new CacheStorageBillingContractError(
      `${field} 必须是${options.positive ? "正" : "非负"}安全整数`,
    );
  }
  return value;
}

/**
 * Parse the only accepted pricing-rule contract. The surrounding ruleConfig
 * may contain other pricing fields, but the nested accounting object is
 * closed: unknown, missing, float or string-valued fields fail closed.
 */
export function readCacheWriteAccountingContract(
  ruleConfig: unknown,
): CacheWriteAccountingContract | null {
  try {
    return parseCacheWriteAccountingContract(ruleConfig);
  } catch (error) {
    if (error instanceof CacheStorageAccountingContractValidationError) {
      throw new CacheStorageBillingContractError(error.message);
    }
    throw error;
  }
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
    throw new CacheStorageBillingContractError(`${field} 必须是精确整数`);
  }
  if (options.positive ? parsed <= 0n : parsed < 0n) {
    throw new CacheStorageBillingContractError(
      `${field} 必须是${options.positive ? "正" : "非负"}整数`,
    );
  }
  return parsed;
}

function safeNumber(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new CacheStorageBillingContractError(`${field} 超出安全整数范围`);
  }
  return Number(value);
}

export function cumulativeCacheStorageMicros(input: {
  cacheWriteTokens: number | string | bigint;
  priceMicrosPerMTokenHour: number | string | bigint;
  startedAt: number | string | bigint;
  throughAt: number | string | bigint;
}): number {
  try {
    return calculateCumulativeCacheStorageMicros(input);
  } catch (error) {
    if (error instanceof CacheStorageAccountingContractValidationError) {
      throw new CacheStorageBillingContractError(error.message);
    }
    throw error;
  }
}

function deterministicId(namespace: string, identity: string): string {
  return crypto
    .createHash("sha256")
    .update(`${namespace}:${identity}`, "utf8")
    .digest("hex");
}

function exactTimestamp(value: unknown, field: string): number {
  return safeNumber(exactBigInt(value, field), field);
}

function exactRowNumber(
  value: unknown,
  field: string,
  options: { positive?: boolean } = {},
): number {
  return safeNumber(exactBigInt(value, field, options), field);
}

export async function createCacheStorageAccrualInTransaction(input: {
  transaction: Knex.Transaction;
  sourceUsageRecordId: string;
  sourceReservationId: string;
  workspaceId: string;
  apiKeyId: string | null;
  requestId: string | null;
  provider: string;
  channelId: string;
  model: string;
  pricingRuleId: string;
  cacheWriteTokens: number;
  contract: CacheWriteAccountingContract;
  startedAt: number;
}): Promise<CacheStorageAccrualRow> {
  const tokens = exactSafeInteger(input.cacheWriteTokens, "cacheWriteTokens", {
    positive: true,
  });
  const startedAt = exactSafeInteger(input.startedAt, "startedAt");
  const ttlMs = BigInt(input.contract.ttlSeconds) * 1_000n;
  const expiresAt = safeNumber(BigInt(startedAt) + ttlMs, "expiresAt");
  for (const [field, value] of Object.entries({
    sourceUsageRecordId: input.sourceUsageRecordId,
    sourceReservationId: input.sourceReservationId,
    workspaceId: input.workspaceId,
    provider: input.provider,
    channelId: input.channelId,
    model: input.model,
    pricingRuleId: input.pricingRuleId,
  })) {
    if (!String(value || "").trim()) {
      throw new CacheStorageBillingContractError(`${field} 不得为空`);
    }
  }

  const usage = await input.transaction("o_usage_record")
    .where({ id: input.sourceUsageRecordId })
    .first();
  const reservation = await input.transaction("o_billing_ledger")
    .where({ id: input.sourceReservationId })
    .first();
  if (
    !usage
    || String(usage.workspaceId || "") !== input.workspaceId
    || String(usage.endpointType || "") !== "text"
    || !["charged", "free"].includes(String(usage.status || ""))
    || String(usage.provider || "") !== input.provider
    || String(usage.channelId || "") !== input.channelId
    || String(usage.model || "") !== input.model
  ) {
    throw new CacheStorageBillingContractError(
      "权威 cache write usage 与结算上下文不一致",
    );
  }
  if (
    !reservation
    || String(reservation.workspaceId || "") !== input.workspaceId
    || String(reservation.type || "") !== "freeze"
    || String(reservation.relatedUsageId || "") !== input.sourceUsageRecordId
    || exactRowNumber(reservation.remainingMicros, "reservation.remainingMicros") !== 0
  ) {
    throw new CacheStorageBillingContractError(
      "cache storage accrual 必须绑定已完成的原子结算冻结流水",
    );
  }

  const row = {
    id: deterministicId("cache-storage-accrual", input.sourceUsageRecordId),
    sourceUsageRecordId: input.sourceUsageRecordId,
    sourceReservationId: input.sourceReservationId,
    workspaceId: input.workspaceId,
    apiKeyId: input.apiKeyId,
    requestId: input.requestId,
    provider: input.provider,
    channelId: input.channelId,
    model: input.model,
    pricingRuleId: input.pricingRuleId,
    contractVersion: input.contract.version,
    cacheWriteTokens: tokens,
    priceMicrosPerMTokenHour: input.contract.priceMicrosPerMTokenHour,
    ttlSeconds: input.contract.ttlSeconds,
    startedAt,
    expiresAt,
    billedThroughAt: startedAt,
    billedMicros: 0,
    status: "active",
    nextBillAt: Math.min(expiresAt, startedAt + DEFAULT_BILL_INTERVAL_MS),
    leaseOwner: null,
    leaseExpiresAt: null,
    fence: 0,
    processingThroughAt: null,
    processingTotalMicros: null,
    processingDeltaMicros: null,
    processingIdempotencyKey: null,
    lastChargeUsageRecordId: null,
    lastChargeLedgerId: null,
    chargeCount: 0,
    manualReason: null,
    reconcileJobId: null,
    closedAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  await input.transaction(CACHE_STORAGE_ACCRUAL_TABLE)
    .insert(row)
    .onConflict("sourceUsageRecordId")
    .ignore();
  const persisted = await input.transaction<CacheStorageAccrualRow>(
    CACHE_STORAGE_ACCRUAL_TABLE,
  )
    .where({ sourceUsageRecordId: input.sourceUsageRecordId })
    .first();
  if (!persisted) {
    throw new CacheStorageBillingContractError(
      "cache storage accrual 原子创建失败",
    );
  }
  const immutableExpected: Record<string, string> = {
    sourceReservationId: input.sourceReservationId,
    workspaceId: input.workspaceId,
    provider: input.provider,
    channelId: input.channelId,
    model: input.model,
    pricingRuleId: input.pricingRuleId,
    contractVersion: input.contract.version,
    cacheWriteTokens: String(tokens),
    priceMicrosPerMTokenHour: String(input.contract.priceMicrosPerMTokenHour),
    ttlSeconds: String(input.contract.ttlSeconds),
    startedAt: String(startedAt),
    expiresAt: String(expiresAt),
  };
  for (const [field, expected] of Object.entries(immutableExpected)) {
    if (String((persisted as unknown as Record<string, unknown>)[field]) !== expected) {
      throw new CacheStorageBillingContractError(
        `cache storage accrual 幂等冲突: ${field}`,
      );
    }
  }
  cacheStorageMetrics.createdTotal += 1;
  return persisted;
}

function parsePositiveEnvInteger(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = Number(process.env[name] || fallback);
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : fallback;
}

function billingIntervalMs(): number {
  return parsePositiveEnvInteger(
    "FANJIN_CACHE_STORAGE_BILLING_INTERVAL_MS",
    DEFAULT_BILL_INTERVAL_MS,
    3_600_000,
  );
}

function leaseMs(): number {
  return parsePositiveEnvInteger(
    "FANJIN_CACHE_STORAGE_BILLING_LEASE_MS",
    DEFAULT_LEASE_MS,
    600_000,
  );
}

function sanitizeReason(reason: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(reason)
    ? reason
    : "invariant_failed";
}

async function insertManualReconcileJob(
  transaction: Knex.Transaction,
  row: CacheStorageAccrualRow,
  reason: string,
  timestamp: number,
): Promise<string> {
  const normalizedReason = sanitizeReason(reason);
  const dedupeKey = `cache-storage:${row.id}`;
  const jobId = deterministicId("cache-storage-reconcile", row.id);
  const evidence = {
    evidenceVersion: "cache-storage-reconcile.v1",
    accrualId: row.id,
    sourceUsageRecordId: row.sourceUsageRecordId,
    sourceReservationId: row.sourceReservationId,
    cacheWriteTokens: String(row.cacheWriteTokens),
    priceMicrosPerMTokenHour: String(row.priceMicrosPerMTokenHour),
    ttlSeconds: String(row.ttlSeconds),
    billedMicros: String(row.billedMicros),
    processingTotalMicros: row.processingTotalMicros == null
      ? null
      : String(row.processingTotalMicros),
    processingIdempotencyKey: row.processingIdempotencyKey,
    reason: normalizedReason,
  };
  await transaction("o_billing_reconcile_job")
    .insert({
      id: jobId,
      dedupeKey,
      workspaceId: row.workspaceId,
      reservationId: row.sourceReservationId,
      usageRecordId: row.sourceUsageRecordId,
      requestId: row.requestId,
      endpointType: "cache_storage",
      provider: row.provider,
      channelId: row.channelId,
      status: "manual_required",
      reason: `cache_storage_${normalizedReason}`,
      evidence: JSON.stringify(evidence),
      decision: null,
      attempts: 0,
      nextAttemptAt: timestamp,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      resolvedAt: null,
      createTime: timestamp,
      updateTime: timestamp,
    })
    .onConflict("dedupeKey")
    .ignore();
  const job = await transaction("o_billing_reconcile_job")
    .where({ dedupeKey })
    .first();
  if (!job) throw new Error("CACHE_STORAGE_RECONCILE_JOB_CREATE_FAILED");
  return String(job.id);
}

async function markManualRequired(input: {
  database: Knex;
  row: CacheStorageAccrualRow;
  reason: string;
  now: number;
  expectedWorkerId?: string;
  expectedFence?: number;
}): Promise<boolean> {
  return input.database.transaction(async (transaction) => {
    const current = await transaction<CacheStorageAccrualRow>(
      CACHE_STORAGE_ACCRUAL_TABLE,
    )
      .where({ id: input.row.id })
      .first();
    if (!current || current.status === "closed") return false;
    if (current.status === "manual_required") return true;
    if (
      input.expectedWorkerId
      && (
        current.status !== "processing"
        || current.leaseOwner !== input.expectedWorkerId
        || exactRowNumber(current.fence, "fence") !== input.expectedFence
      )
    ) return false;
    const reconcileJobId = await insertManualReconcileJob(
      transaction,
      current,
      input.reason,
      input.now,
    );
    const query = transaction(CACHE_STORAGE_ACCRUAL_TABLE)
      .where({ id: current.id, status: current.status });
    if (current.status === "processing") {
      query
        .andWhere("leaseOwner", current.leaseOwner)
        .andWhere("fence", current.fence as any);
    }
    const affected = await query.update({
      status: "manual_required",
      nextBillAt: input.now,
      leaseOwner: null,
      leaseExpiresAt: null,
      processingThroughAt: null,
      processingTotalMicros: null,
      processingDeltaMicros: null,
      processingIdempotencyKey: null,
      manualReason: sanitizeReason(input.reason),
      reconcileJobId,
      updatedAt: input.now,
    });
    if (Number(affected || 0) !== 1) return false;
    cacheStorageMetrics.manualRequiredTotal += 1;
    return true;
  });
}

async function recoverExpiredProcessing(
  database: Knex,
  timestamp: number,
  limit: number,
): Promise<number> {
  const rows = await database<CacheStorageAccrualRow>(
    CACHE_STORAGE_ACCRUAL_TABLE,
  )
    .where({ status: "processing" })
    .whereNotNull("leaseExpiresAt")
    .andWhere("leaseExpiresAt", "<=", timestamp)
    .orderBy("leaseExpiresAt", "asc")
    .limit(limit);
  let recovered = 0;
  for (const row of rows) {
    if (await markManualRequired({
      database,
      row,
      reason: "processing_lease_expired",
      now: timestamp,
      expectedWorkerId: row.leaseOwner || undefined,
      expectedFence: exactRowNumber(row.fence, "fence"),
    })) recovered += 1;
  }
  cacheStorageMetrics.recoveredExpiredProcessingTotal += recovered;
  return recovered;
}

interface ClaimedAccrual {
  row: CacheStorageAccrualRow;
  fence: number;
  throughAt: number;
  totalMicros: number;
  deltaMicros: number;
  idempotencyKey: string;
}

async function claimAccrual(input: {
  database: Knex;
  row: CacheStorageAccrualRow;
  workerId: string;
  now: number;
  intervalMs: number;
  leaseMs: number;
}): Promise<ClaimedAccrual | null> {
  const startedAt = exactTimestamp(input.row.startedAt, "startedAt");
  const expiresAt = exactTimestamp(input.row.expiresAt, "expiresAt");
  const billedMicros = exactRowNumber(input.row.billedMicros, "billedMicros");
  const currentFence = exactRowNumber(input.row.fence, "fence");
  const throughAt = Math.max(startedAt, Math.min(input.now, expiresAt));
  const totalMicros = cumulativeCacheStorageMicros({
    cacheWriteTokens: input.row.cacheWriteTokens,
    priceMicrosPerMTokenHour: input.row.priceMicrosPerMTokenHour,
    startedAt,
    throughAt,
  });
  if (totalMicros < billedMicros) {
    await markManualRequired({
      database: input.database,
      row: input.row,
      reason: "cumulative_regression",
      now: input.now,
    });
    return null;
  }
  const deltaMicros = totalMicros - billedMicros;
  if (deltaMicros === 0) {
    const closed = throughAt >= expiresAt;
    await input.database(CACHE_STORAGE_ACCRUAL_TABLE)
      .where({ id: input.row.id, status: "active", fence: currentFence })
      .update({
        billedThroughAt: throughAt,
        status: closed ? "closed" : "active",
        nextBillAt: closed
          ? expiresAt
          : Math.min(expiresAt, throughAt + input.intervalMs),
        closedAt: closed ? input.now : null,
        updatedAt: input.now,
      });
    return null;
  }

  const fence = currentFence + 1;
  if (!Number.isSafeInteger(fence)) {
    await markManualRequired({
      database: input.database,
      row: input.row,
      reason: "fence_overflow",
      now: input.now,
    });
    return null;
  }
  const idempotencyKey = `cache-storage:${input.row.id}:total:${totalMicros}`;
  const affected = await input.database(CACHE_STORAGE_ACCRUAL_TABLE)
    .where({ id: input.row.id, status: "active", fence: currentFence })
    .andWhere("billedMicros", input.row.billedMicros as any)
    .update({
      status: "processing",
      leaseOwner: input.workerId,
      leaseExpiresAt: input.now + input.leaseMs,
      fence,
      processingThroughAt: throughAt,
      processingTotalMicros: totalMicros,
      processingDeltaMicros: deltaMicros,
      processingIdempotencyKey: idempotencyKey,
      updatedAt: input.now,
    });
  if (Number(affected || 0) !== 1) return null;
  const claimed = await input.database<CacheStorageAccrualRow>(
    CACHE_STORAGE_ACCRUAL_TABLE,
  )
    .where({
      id: input.row.id,
      status: "processing",
      leaseOwner: input.workerId,
      fence,
    })
    .first();
  return claimed
    ? { row: claimed, fence, throughAt, totalMicros, deltaMicros, idempotencyKey }
    : null;
}

export type CacheStorageCharge = (
  input: Parameters<typeof billApiTask>[0],
) => Promise<ApiTaskChargeResult>;

async function finalizeCharge(input: {
  database: Knex;
  claim: ClaimedAccrual;
  workerId: string;
  now: number;
  intervalMs: number;
  result: ApiTaskChargeResult;
}): Promise<void> {
  if (!input.result.ledger || input.result.costMicros !== input.claim.deltaMicros) {
    throw new Error("CACHE_STORAGE_CHARGE_EVIDENCE_INVALID");
  }
  const expiresAt = exactTimestamp(input.claim.row.expiresAt, "expiresAt");
  const closed = input.claim.throughAt >= expiresAt;
  const affected = await input.database(CACHE_STORAGE_ACCRUAL_TABLE)
    .where({
      id: input.claim.row.id,
      status: "processing",
      leaseOwner: input.workerId,
      fence: input.claim.fence,
      processingIdempotencyKey: input.claim.idempotencyKey,
    })
    .update({
      billedThroughAt: input.claim.throughAt,
      billedMicros: input.claim.totalMicros,
      status: closed ? "closed" : "active",
      nextBillAt: closed
        ? expiresAt
        : Math.min(expiresAt, input.claim.throughAt + input.intervalMs),
      leaseOwner: null,
      leaseExpiresAt: null,
      processingThroughAt: null,
      processingTotalMicros: null,
      processingDeltaMicros: null,
      processingIdempotencyKey: null,
      lastChargeUsageRecordId: input.result.usage.id,
      lastChargeLedgerId: input.result.ledger.id,
      chargeCount: input.database.raw('COALESCE("chargeCount", 0) + 1'),
      closedAt: closed ? input.now : null,
      updatedAt: input.now,
    });
  if (Number(affected || 0) !== 1) {
    throw new Error("CACHE_STORAGE_CHARGE_FINALIZE_FENCE_LOST");
  }
}

async function chargeClaim(input: {
  database: Knex;
  claim: ClaimedAccrual;
  workerId: string;
  now: number;
  intervalMs: number;
  charge: CacheStorageCharge;
}): Promise<void> {
  cacheStorageMetrics.chargeAttemptsTotal += 1;
  try {
    const result = await input.charge({
      endpointType: "cache_storage",
      provider: input.claim.row.provider,
      model: input.claim.row.model,
      workspaceId: input.claim.row.workspaceId,
      apiKeyId: input.claim.row.apiKeyId,
      channelId: input.claim.row.channelId,
      requestId: input.claim.row.requestId,
      units: exactRowNumber(
        input.claim.row.cacheWriteTokens,
        "cacheWriteTokens",
        { positive: true },
      ),
      unit: "cache_token_hour",
      costMicros: input.claim.deltaMicros,
      currency: "GU",
      chargeMode: "charge",
      idempotencyKey: input.claim.idempotencyKey,
      description: `Cache storage: ${input.claim.row.model}`,
      metadata: {
        contractVersion: CACHE_STORAGE_ACCRUAL_CONTRACT_VERSION,
        accrualId: input.claim.row.id,
        sourceUsageRecordId: input.claim.row.sourceUsageRecordId,
        sourceReservationId: input.claim.row.sourceReservationId,
        pricingRuleId: input.claim.row.pricingRuleId,
        cacheWriteTokens: String(input.claim.row.cacheWriteTokens),
        priceMicrosPerMTokenHour: String(
          input.claim.row.priceMicrosPerMTokenHour,
        ),
        ttlSeconds: String(input.claim.row.ttlSeconds),
        cumulativeThroughAt: input.claim.throughAt,
        cumulativeTotalMicros: input.claim.totalMicros,
      },
    });
    await finalizeCharge({
      database: input.database,
      claim: input.claim,
      workerId: input.workerId,
      now: input.now,
      intervalMs: input.intervalMs,
      result,
    });
    cacheStorageMetrics.chargeSuccessTotal += 1;
  } catch (error) {
    cacheStorageMetrics.chargeFailuresTotal += 1;
    const insufficient = error instanceof BillingError && error.status === 402;
    if (insufficient) cacheStorageMetrics.insufficientBalanceTotal += 1;
    try {
      await markManualRequired({
        database: input.database,
        row: input.claim.row,
        reason: insufficient ? "insufficient_balance" : "charge_outcome_uncertain",
        now: input.now,
        expectedWorkerId: input.workerId,
        expectedFence: input.claim.fence,
      });
    } catch {
      // The durable processing target and idempotency key intentionally remain
      // in place. Expired-processing recovery will escalate without retrying.
      cacheStorageMetrics.databaseFailuresTotal += 1;
    }
  }
}

async function updateDatabaseSnapshot(database: Knex, timestamp: number): Promise<void> {
  const grouped = await database(CACHE_STORAGE_ACCRUAL_TABLE)
    .select("status")
    .count<{ status: string; count: string | number }[]>({ count: "*" })
    .groupBy("status");
  const counts = new Map(grouped.map((row) => [String(row.status), Number(row.count || 0)]));
  const oldest = await database(CACHE_STORAGE_ACCRUAL_TABLE)
    .where({ status: "active" })
    .where("nextBillAt", "<=", timestamp)
    .min<{ oldest: string | number | null }[]>({ oldest: "nextBillAt" })
    .first();
  cacheStorageMetrics.active = counts.get("active") || 0;
  cacheStorageMetrics.processing = counts.get("processing") || 0;
  cacheStorageMetrics.manualRequired = counts.get("manual_required") || 0;
  cacheStorageMetrics.oldestDueAgeSeconds = oldest?.oldest == null
    ? 0
    : Math.max(0, Math.floor((timestamp - Number(oldest.oldest)) / 1_000));
}

export async function runCacheStorageBillingBatch(options: {
  database?: Knex;
  now?: number;
  workerId?: string;
  limit?: number;
  intervalMs?: number;
  leaseMs?: number;
  charge?: CacheStorageCharge;
} = {}): Promise<{ claimed: number; recovered: number }> {
  const database = options.database || db;
  const timestamp = options.now ?? Date.now();
  const workerId = String(options.workerId || `cache-storage-${process.pid}-${crypto.randomUUID()}`);
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_BATCH_SIZE, 100));
  const interval = options.intervalMs ?? billingIntervalMs();
  const claimLeaseMs = options.leaseMs ?? leaseMs();
  if (
    !Number.isSafeInteger(timestamp)
    || timestamp < 0
    || !Number.isSafeInteger(interval)
    || interval <= 0
    || !Number.isSafeInteger(claimLeaseMs)
    || claimLeaseMs <= 0
  ) {
    throw new CacheStorageBillingContractError(
      "cache storage worker 时间参数必须是正安全整数",
    );
  }
  cacheStorageMetrics.lastRunAt = timestamp;
  try {
    const recovered = await recoverExpiredProcessing(database, timestamp, limit);
    const rows = await database<CacheStorageAccrualRow>(
      CACHE_STORAGE_ACCRUAL_TABLE,
    )
      .where({ status: "active" })
      .andWhere((query) => {
        query.where("nextBillAt", "<=", timestamp).orWhere("expiresAt", "<=", timestamp);
      })
      .orderBy("nextBillAt", "asc")
      .limit(limit * 3);
    let claimedCount = 0;
    for (const row of rows) {
      if (claimedCount >= limit) break;
      let claim: ClaimedAccrual | null;
      try {
        claim = await claimAccrual({
          database,
          row,
          workerId,
          now: timestamp,
          intervalMs: interval,
          leaseMs: claimLeaseMs,
        });
      } catch {
        cacheStorageMetrics.databaseFailuresTotal += 1;
        try {
          await markManualRequired({
            database,
            row,
            reason: "claim_invariant_failed",
            now: timestamp,
          });
        } catch {
          cacheStorageMetrics.databaseFailuresTotal += 1;
        }
        continue;
      }
      if (!claim) continue;
      claimedCount += 1;
      await chargeClaim({
        database,
        claim,
        workerId,
        now: timestamp,
        intervalMs: interval,
        charge: options.charge || billApiTask,
      });
    }
    await updateDatabaseSnapshot(database, timestamp);
    cacheStorageMetrics.lastRunSucceeded = true;
    return { claimed: claimedCount, recovered };
  } catch (error) {
    cacheStorageMetrics.databaseFailuresTotal += 1;
    cacheStorageMetrics.lastRunSucceeded = false;
    throw error;
  }
}

export function getCacheStorageBillingMetrics(): CacheStorageBillingMetrics {
  return { ...cacheStorageMetrics };
}

export function resetCacheStorageBillingMetrics(): void {
  Object.assign(cacheStorageMetrics, {
    createdTotal: 0,
    chargeAttemptsTotal: 0,
    chargeSuccessTotal: 0,
    chargeFailuresTotal: 0,
    insufficientBalanceTotal: 0,
    manualRequiredTotal: 0,
    recoveredExpiredProcessingTotal: 0,
    databaseFailuresTotal: 0,
    lastRunAt: 0,
    lastRunSucceeded: true,
    active: 0,
    processing: 0,
    manualRequired: 0,
    oldestDueAgeSeconds: 0,
  });
}

let workerTimer: NodeJS.Timeout | null = null;
let workerRun: Promise<void> | null = null;
let workerDatabase: Knex | null = null;
let workerStopping = false;

async function runWorkerTick(): Promise<void> {
  if (workerStopping || !workerDatabase || workerRun) return;
  workerRun = runCacheStorageBillingBatch({ database: workerDatabase })
    .then(() => undefined)
    .catch((error) => {
      console.error("Cache storage billing worker failed:", error);
    })
    .finally(() => {
      workerRun = null;
    });
  await workerRun;
}

export function startCacheStorageBillingWorker(database: Knex = db): void {
  if (workerTimer) return;
  workerDatabase = database;
  workerStopping = false;
  void runWorkerTick();
  workerTimer = setInterval(() => void runWorkerTick(), billingIntervalMs());
  workerTimer.unref?.();
}

export async function stopCacheStorageBillingWorker(): Promise<void> {
  workerStopping = true;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerRun;
  workerRun = null;
  workerDatabase = null;
}

export type CacheStorageSettlementEvidence = {
  usage: UsageRecord;
  reservation: BillingLedger;
};
