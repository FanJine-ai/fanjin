import type { Knex } from "knex";

export const CACHE_STORAGE_ACCRUAL_TABLE = "o_cache_storage_accrual";

export const CACHE_STORAGE_ACCRUAL_INDEXES = {
  sourceUsage: "uq_o_cache_storage_accrual_source_usage",
  claim: "idx_o_cache_storage_accrual_claim",
  lease: "idx_o_cache_storage_accrual_lease",
  workspace: "idx_o_cache_storage_accrual_workspace",
} as const;

export const CACHE_STORAGE_ACCRUAL_REQUIRED_CONSTRAINTS = [
  `table:${CACHE_STORAGE_ACCRUAL_TABLE}`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.sourceUsageRecordId`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.sourceReservationId`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.cacheWriteTokens`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.priceMicrosPerMTokenHour`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.ttlSeconds`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.startedAt`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.expiresAt`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.billedThroughAt`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.billedMicros`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.status`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.fence`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.processingThroughAt`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.processingTotalMicros`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.processingDeltaMicros`,
  `column:${CACHE_STORAGE_ACCRUAL_TABLE}.processingIdempotencyKey`,
  `index:${CACHE_STORAGE_ACCRUAL_TABLE}.${CACHE_STORAGE_ACCRUAL_INDEXES.sourceUsage}`,
  `index:${CACHE_STORAGE_ACCRUAL_TABLE}.${CACHE_STORAGE_ACCRUAL_INDEXES.claim}`,
  `index:${CACHE_STORAGE_ACCRUAL_TABLE}.${CACHE_STORAGE_ACCRUAL_INDEXES.lease}`,
  `index:${CACHE_STORAGE_ACCRUAL_TABLE}.${CACHE_STORAGE_ACCRUAL_INDEXES.workspace}`,
] as const;

/**
 * Durable, immutable-price cache-storage accruals. A row is created inside
 * the authoritative text-usage settlement transaction. Later worker charges
 * advance only the cumulative billed watermark.
 */
export async function upCacheStorageAccrual(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(CACHE_STORAGE_ACCRUAL_TABLE)) return;

  for (const requiredTable of [
    "o_usage_record",
    "o_billing_ledger",
    "o_billing_reconcile_job",
  ]) {
    if (!(await trx.schema.hasTable(requiredTable))) {
      throw new Error(
        `Migration cache_storage_accrual requires table ${requiredTable}`,
      );
    }
  }

  await trx.schema.createTable(CACHE_STORAGE_ACCRUAL_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("sourceUsageRecordId").notNullable();
    table.text("sourceReservationId").notNullable();
    table.text("workspaceId").notNullable();
    table.text("apiKeyId");
    table.text("requestId");
    table.text("provider").notNullable();
    table.text("channelId").notNullable();
    table.text("model").notNullable();
    table.text("pricingRuleId").notNullable();
    table.text("contractVersion").notNullable();
    table.bigInteger("cacheWriteTokens").notNullable();
    table.bigInteger("priceMicrosPerMTokenHour").notNullable();
    table.bigInteger("ttlSeconds").notNullable();
    table.bigInteger("startedAt").notNullable();
    table.bigInteger("expiresAt").notNullable();
    table.bigInteger("billedThroughAt").notNullable();
    table.bigInteger("billedMicros").notNullable().defaultTo(0);
    table.text("status").notNullable().defaultTo("active");
    table.bigInteger("nextBillAt").notNullable();
    table.text("leaseOwner");
    table.bigInteger("leaseExpiresAt");
    table.bigInteger("fence").notNullable().defaultTo(0);
    table.bigInteger("processingThroughAt");
    table.bigInteger("processingTotalMicros");
    table.bigInteger("processingDeltaMicros");
    table.text("processingIdempotencyKey");
    table.text("lastChargeUsageRecordId");
    table.text("lastChargeLedgerId");
    table.bigInteger("chargeCount").notNullable().defaultTo(0);
    table.text("manualReason");
    table.text("reconcileJobId");
    table.bigInteger("closedAt");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    table.foreign("sourceUsageRecordId", "fk_o_cache_storage_source_usage")
      .references("id")
      .inTable("o_usage_record")
      .onDelete("RESTRICT");
    table.foreign("sourceReservationId", "fk_o_cache_storage_source_reservation")
      .references("id")
      .inTable("o_billing_ledger")
      .onDelete("RESTRICT");
    table.foreign("lastChargeUsageRecordId", "fk_o_cache_storage_charge_usage")
      .references("id")
      .inTable("o_usage_record")
      .onDelete("RESTRICT");
    table.foreign("lastChargeLedgerId", "fk_o_cache_storage_charge_ledger")
      .references("id")
      .inTable("o_billing_ledger")
      .onDelete("RESTRICT");
    table.foreign("reconcileJobId", "fk_o_cache_storage_reconcile_job")
      .references("id")
      .inTable("o_billing_reconcile_job")
      .onDelete("RESTRICT");

    table.unique(
      ["sourceUsageRecordId"],
      CACHE_STORAGE_ACCRUAL_INDEXES.sourceUsage,
    );
    table.index(
      ["status", "nextBillAt", "expiresAt"],
      CACHE_STORAGE_ACCRUAL_INDEXES.claim,
    );
    table.index(
      ["status", "leaseExpiresAt"],
      CACHE_STORAGE_ACCRUAL_INDEXES.lease,
    );
    table.index(
      ["workspaceId", "status", "createdAt"],
      CACHE_STORAGE_ACCRUAL_INDEXES.workspace,
    );

    table.check(
      '"status" IN (\'active\', \'processing\', \'closed\', \'manual_required\')',
      {},
      "chk_o_cache_storage_status",
    );
    table.check(
      '"contractVersion" = \'cache-storage-accrual.v1\''
        + ' AND "cacheWriteTokens" > 0'
        + ' AND "priceMicrosPerMTokenHour" > 0'
        + ' AND "ttlSeconds" > 0'
        + ' AND "expiresAt" > "startedAt"'
        + ' AND "billedThroughAt" >= "startedAt"'
        + ' AND "billedThroughAt" <= "expiresAt"'
        + ' AND "billedMicros" >= 0'
        + ' AND "fence" >= 0'
        + ' AND "chargeCount" >= 0',
      {},
      "chk_o_cache_storage_amounts",
    );
    table.check(
      '("status" = \'processing\''
        + ' AND "leaseOwner" IS NOT NULL'
        + ' AND "leaseExpiresAt" IS NOT NULL'
        + ' AND "processingThroughAt" IS NOT NULL'
        + ' AND "processingTotalMicros" IS NOT NULL'
        + ' AND "processingDeltaMicros" IS NOT NULL'
        + ' AND "processingIdempotencyKey" IS NOT NULL)'
        + ' OR ("status" <> \'processing\''
        + ' AND "leaseOwner" IS NULL'
        + ' AND "leaseExpiresAt" IS NULL'
        + ' AND "processingThroughAt" IS NULL'
        + ' AND "processingTotalMicros" IS NULL'
        + ' AND "processingDeltaMicros" IS NULL'
        + ' AND "processingIdempotencyKey" IS NULL)',
      {},
      "chk_o_cache_storage_processing",
    );
    table.check(
      '("status" = \'closed\' AND "closedAt" IS NOT NULL)'
        + ' OR ("status" <> \'closed\' AND "closedAt" IS NULL)',
      {},
      "chk_o_cache_storage_closed",
    );
  });
}

export async function downCacheStorageAccrual(): Promise<void> {
  throw new Error(
    "Migration cache_storage_accrual cannot be rolled back safely because accrued usage and immutable price snapshots are financial evidence.",
  );
}
