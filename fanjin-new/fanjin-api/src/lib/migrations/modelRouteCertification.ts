import type { Knex } from "knex";

export const MODEL_ROUTE_CERTIFICATION_TABLE = "o_model_route_certification";
export const MODEL_ROUTE_CERTIFICATION_BATCH_TABLE = "o_model_route_certification_batch";

export const MODEL_ROUTE_CERTIFICATION_INDEXES = {
  batchOperation: "uq_o_model_route_certification_batch_operation",
  routeOperationCertified: "idx_o_model_route_certification_route_operation_certified",
  pricingRule: "idx_o_model_route_certification_pricing_rule",
  taskEvidence: "idx_o_model_route_certification_task_evidence",
  usageEvidence: "idx_o_model_route_certification_usage_evidence",
  validity: "idx_o_model_route_certification_validity",
} as const;

export const MODEL_ROUTE_CERTIFICATION_TRIGGERS = {
  immutable: "trg_o_model_route_certification_immutable",
  deleteBlocked: "trg_o_model_route_certification_delete_blocked",
  batchImmutable: "trg_o_model_route_certification_batch_immutable",
  batchDeleteBlocked: "trg_o_model_route_certification_batch_delete_blocked",
} as const;

export const MODEL_ROUTE_CERTIFICATION_REQUIRED_CONSTRAINTS = [
  `table:${MODEL_ROUTE_CERTIFICATION_TABLE}`,
  `table:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}`,
  `column:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.batchId`,
  `column:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.batchDigest`,
  `column:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.releaseId`,
  `column:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.sourceCommit`,
  `column:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.actorUserId`,
  `column:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.entryCount`,
  `column:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.appliedAt`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.routeId`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.pricingRuleId`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.operationKey`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.batchId`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.releaseId`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.sourceCommit`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.priceSourceUrl`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.priceSourceDigest`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.priceCheckedAt`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.upstreamCurrency`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.upstreamUnitPriceMicros`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.billingCurrency`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.billingDimension`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.taskEvidenceId`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.usageEvidenceId`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.routeSnapshotHash`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.pricingSnapshotHash`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.certifiedByUserId`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.certifiedAt`,
  `column:${MODEL_ROUTE_CERTIFICATION_TABLE}.validUntil`,
  `index:${MODEL_ROUTE_CERTIFICATION_TABLE}.${MODEL_ROUTE_CERTIFICATION_INDEXES.routeOperationCertified}`,
  `index:${MODEL_ROUTE_CERTIFICATION_TABLE}.${MODEL_ROUTE_CERTIFICATION_INDEXES.batchOperation}`,
  `index:${MODEL_ROUTE_CERTIFICATION_TABLE}.${MODEL_ROUTE_CERTIFICATION_INDEXES.pricingRule}`,
  `index:${MODEL_ROUTE_CERTIFICATION_TABLE}.${MODEL_ROUTE_CERTIFICATION_INDEXES.taskEvidence}`,
  `index:${MODEL_ROUTE_CERTIFICATION_TABLE}.${MODEL_ROUTE_CERTIFICATION_INDEXES.usageEvidence}`,
  `index:${MODEL_ROUTE_CERTIFICATION_TABLE}.${MODEL_ROUTE_CERTIFICATION_INDEXES.validity}`,
  `trigger:${MODEL_ROUTE_CERTIFICATION_TABLE}.${MODEL_ROUTE_CERTIFICATION_TRIGGERS.immutable}`,
  `trigger:${MODEL_ROUTE_CERTIFICATION_TABLE}.${MODEL_ROUTE_CERTIFICATION_TRIGGERS.deleteBlocked}`,
  `trigger:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.${MODEL_ROUTE_CERTIFICATION_TRIGGERS.batchImmutable}`,
  `trigger:${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}.${MODEL_ROUTE_CERTIFICATION_TRIGGERS.batchDeleteBlocked}`,
] as const;

function buildModelRouteCertificationBatchTable(table: Knex.CreateTableBuilder): void {
  table.text("batchId").notNullable().primary();
  table.text("batchDigest").notNullable();
  table.text("releaseId").notNullable();
  table.text("sourceCommit").notNullable();
  table.bigInteger("actorUserId").notNullable()
    .references("id")
    .inTable("o_user")
    .onUpdate("CASCADE")
    .onDelete("RESTRICT");
  table.integer("entryCount").notNullable();
  table.bigInteger("appliedAt").notNullable();
  table.bigInteger("createdAt").notNullable();
}

function buildModelRouteCertificationTable(table: Knex.CreateTableBuilder): void {
  table.text("id").notNullable().primary();
  table.text("routeId").notNullable()
    .references("id")
    .inTable("o_model_route")
    .onUpdate("CASCADE")
    .onDelete("RESTRICT");
  table.text("pricingRuleId").notNullable()
    .references("id")
    .inTable("o_pricing_rule")
    .onUpdate("CASCADE")
    .onDelete("RESTRICT");
  table.text("operationKey").notNullable();
  table.text("batchId").notNullable();
  table.text("releaseId");
  table.text("sourceCommit");
  table.text("priceSourceUrl").notNullable();
  table.text("priceSourceDigest").notNullable();
  table.bigInteger("priceCheckedAt").notNullable();
  table.text("upstreamCurrency").notNullable();
  table.bigInteger("upstreamUnitPriceMicros").notNullable();
  table.text("billingCurrency").notNullable();
  table.text("billingDimension").notNullable();
  table.text("taskEvidenceId").notNullable()
    .references("id")
    .inTable("o_relay_task")
    .onUpdate("CASCADE")
    .onDelete("RESTRICT");
  table.text("usageEvidenceId").notNullable()
    .references("id")
    .inTable("o_usage_record")
    .onUpdate("CASCADE")
    .onDelete("RESTRICT");
  table.text("routeSnapshotHash").notNullable();
  table.text("pricingSnapshotHash").notNullable();
  table.bigInteger("certifiedByUserId").notNullable()
    .references("id")
    .inTable("o_user")
    .onUpdate("CASCADE")
    .onDelete("RESTRICT");
  table.bigInteger("certifiedAt").notNullable();
  table.bigInteger("validUntil").notNullable();
  table.bigInteger("revokedByUserId")
    .references("id")
    .inTable("o_user")
    .onUpdate("CASCADE")
    .onDelete("RESTRICT");
  table.bigInteger("revokedAt");
  table.text("revokeReason");
  table.bigInteger("createdAt").notNullable();
  table.bigInteger("updatedAt").notNullable();

  table.index(
    ["routeId", "operationKey", "certifiedAt"],
    MODEL_ROUTE_CERTIFICATION_INDEXES.routeOperationCertified,
  );
  table.unique(
    ["batchId", "routeId", "operationKey"],
    { indexName: MODEL_ROUTE_CERTIFICATION_INDEXES.batchOperation },
  );
  table.index(
    ["pricingRuleId", "routeId"],
    MODEL_ROUTE_CERTIFICATION_INDEXES.pricingRule,
  );
  table.index(
    ["taskEvidenceId"],
    MODEL_ROUTE_CERTIFICATION_INDEXES.taskEvidence,
  );
  table.index(
    ["usageEvidenceId"],
    MODEL_ROUTE_CERTIFICATION_INDEXES.usageEvidence,
  );
  table.index(
    ["validUntil", "revokedAt"],
    MODEL_ROUTE_CERTIFICATION_INDEXES.validity,
  );
}

const IMMUTABLE_COLUMNS = [
  "id",
  "routeId",
  "pricingRuleId",
  "operationKey",
  "batchId",
  "releaseId",
  "sourceCommit",
  "priceSourceUrl",
  "priceSourceDigest",
  "priceCheckedAt",
  "upstreamCurrency",
  "upstreamUnitPriceMicros",
  "billingCurrency",
  "billingDimension",
  "taskEvidenceId",
  "usageEvidenceId",
  "routeSnapshotHash",
  "pricingSnapshotHash",
  "certifiedByUserId",
  "certifiedAt",
  "validUntil",
  "createdAt",
] as const;

async function installCertificationGuards(trx: Knex.Transaction): Promise<void> {
  const dialect = String(trx.client.config.client || "").toLowerCase();
  if (["pg", "postgres", "postgresql"].includes(dialect)) {
    const oldRow = IMMUTABLE_COLUMNS.map((column) => `OLD."${column}"`).join(", ");
    const newRow = IMMUTABLE_COLUMNS.map((column) => `NEW."${column}"`).join(", ");
    await trx.raw(`
      CREATE OR REPLACE FUNCTION fanjin_model_route_certification_update_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(${oldRow}) IS DISTINCT FROM ROW(${newRow}) THEN
          RAISE EXCEPTION 'MODEL_ROUTE_CERTIFICATION_IMMUTABLE';
        END IF;
        IF OLD."revokedAt" IS NOT NULL THEN
          IF ROW(OLD."revokedAt", OLD."revokedByUserId", OLD."revokeReason")
             IS DISTINCT FROM
             ROW(NEW."revokedAt", NEW."revokedByUserId", NEW."revokeReason") THEN
            RAISE EXCEPTION 'MODEL_ROUTE_CERTIFICATION_REVOCATION_IRREVERSIBLE';
          END IF;
        ELSIF NEW."revokedAt" IS NULL THEN
          IF NEW."revokedByUserId" IS NOT NULL OR NEW."revokeReason" IS NOT NULL THEN
            RAISE EXCEPTION 'MODEL_ROUTE_CERTIFICATION_REVOCATION_INVALID';
          END IF;
        ELSIF NEW."revokedByUserId" IS NULL
           OR COALESCE(BTRIM(NEW."revokeReason"), '') = '' THEN
          RAISE EXCEPTION 'MODEL_ROUTE_CERTIFICATION_REVOCATION_INVALID';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await trx.raw(`
      CREATE OR REPLACE FUNCTION fanjin_model_route_certification_delete_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'MODEL_ROUTE_CERTIFICATION_DELETE_FORBIDDEN';
      END;
      $$
    `);
    await trx.raw(`
      CREATE TRIGGER "${MODEL_ROUTE_CERTIFICATION_TRIGGERS.immutable}"
      BEFORE UPDATE ON "${MODEL_ROUTE_CERTIFICATION_TABLE}"
      FOR EACH ROW EXECUTE FUNCTION fanjin_model_route_certification_update_guard()
    `);
    await trx.raw(`
      CREATE TRIGGER "${MODEL_ROUTE_CERTIFICATION_TRIGGERS.deleteBlocked}"
      BEFORE DELETE ON "${MODEL_ROUTE_CERTIFICATION_TABLE}"
      FOR EACH ROW EXECUTE FUNCTION fanjin_model_route_certification_delete_guard()
    `);
    return;
  }

  const immutableChanged = IMMUTABLE_COLUMNS
    .map((column) => `OLD."${column}" IS NOT NEW."${column}"`)
    .join(" OR ");
  await trx.raw(`
    CREATE TRIGGER "${MODEL_ROUTE_CERTIFICATION_TRIGGERS.immutable}"
    BEFORE UPDATE ON "${MODEL_ROUTE_CERTIFICATION_TABLE}"
    WHEN (${immutableChanged})
      OR (
        OLD."revokedAt" IS NOT NULL
        AND (
          OLD."revokedAt" IS NOT NEW."revokedAt"
          OR OLD."revokedByUserId" IS NOT NEW."revokedByUserId"
          OR OLD."revokeReason" IS NOT NEW."revokeReason"
        )
      )
      OR (
        OLD."revokedAt" IS NULL
        AND NEW."revokedAt" IS NULL
        AND (NEW."revokedByUserId" IS NOT NULL OR NEW."revokeReason" IS NOT NULL)
      )
      OR (
        OLD."revokedAt" IS NULL
        AND NEW."revokedAt" IS NOT NULL
        AND (
          NEW."revokedByUserId" IS NULL
          OR COALESCE(TRIM(NEW."revokeReason"), '') = ''
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'MODEL_ROUTE_CERTIFICATION_IMMUTABLE_OR_REVOCATION_INVALID');
    END
  `);
  await trx.raw(`
    CREATE TRIGGER "${MODEL_ROUTE_CERTIFICATION_TRIGGERS.deleteBlocked}"
    BEFORE DELETE ON "${MODEL_ROUTE_CERTIFICATION_TABLE}"
    BEGIN
      SELECT RAISE(ABORT, 'MODEL_ROUTE_CERTIFICATION_DELETE_FORBIDDEN');
    END
  `);
}

async function installBatchGuards(trx: Knex.Transaction): Promise<void> {
  const dialect = String(trx.client.config.client || "").toLowerCase();
  if (["pg", "postgres", "postgresql"].includes(dialect)) {
    await trx.raw(`
      CREATE OR REPLACE FUNCTION fanjin_model_route_certification_batch_update_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'MODEL_ROUTE_CERTIFICATION_BATCH_IMMUTABLE';
      END;
      $$
    `);
    await trx.raw(`
      CREATE OR REPLACE FUNCTION fanjin_model_route_certification_batch_delete_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'MODEL_ROUTE_CERTIFICATION_BATCH_DELETE_FORBIDDEN';
      END;
      $$
    `);
    await trx.raw(`
      CREATE TRIGGER "${MODEL_ROUTE_CERTIFICATION_TRIGGERS.batchImmutable}"
      BEFORE UPDATE ON "${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}"
      FOR EACH ROW EXECUTE FUNCTION fanjin_model_route_certification_batch_update_guard()
    `);
    await trx.raw(`
      CREATE TRIGGER "${MODEL_ROUTE_CERTIFICATION_TRIGGERS.batchDeleteBlocked}"
      BEFORE DELETE ON "${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}"
      FOR EACH ROW EXECUTE FUNCTION fanjin_model_route_certification_batch_delete_guard()
    `);
    return;
  }
  await trx.raw(`
    CREATE TRIGGER "${MODEL_ROUTE_CERTIFICATION_TRIGGERS.batchImmutable}"
    BEFORE UPDATE ON "${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}"
    BEGIN
      SELECT RAISE(ABORT, 'MODEL_ROUTE_CERTIFICATION_BATCH_IMMUTABLE');
    END
  `);
  await trx.raw(`
    CREATE TRIGGER "${MODEL_ROUTE_CERTIFICATION_TRIGGERS.batchDeleteBlocked}"
    BEFORE DELETE ON "${MODEL_ROUTE_CERTIFICATION_BATCH_TABLE}"
    BEGIN
      SELECT RAISE(ABORT, 'MODEL_ROUTE_CERTIFICATION_BATCH_DELETE_FORBIDDEN');
    END
  `);
}

/**
 * Append-only price/route certification evidence.
 *
 * A certification row binds one route operation to the exact route and price
 * snapshots plus one successful provider task and its charged usage record.
 * Superseding/revoking a certification never deletes the historical row.
 */
export async function upModelRouteCertification(
  trx: Knex.Transaction,
): Promise<void> {
  const [certificationTableExists, batchTableExists] = await Promise.all([
    trx.schema.hasTable(MODEL_ROUTE_CERTIFICATION_TABLE),
    trx.schema.hasTable(MODEL_ROUTE_CERTIFICATION_BATCH_TABLE),
  ]);
  if (certificationTableExists && batchTableExists) return;
  if (certificationTableExists || batchTableExists) {
    throw new Error("Migration model_route_certification found a partial schema-43 installation");
  }
  for (const requiredTable of [
    "o_model_route",
    "o_pricing_rule",
    "o_relay_task",
    "o_usage_record",
    "o_user",
  ]) {
    if (!(await trx.schema.hasTable(requiredTable))) {
      throw new Error(
        `Migration model_route_certification requires table ${requiredTable}`,
      );
    }
  }
  await trx.schema.createTable(
    MODEL_ROUTE_CERTIFICATION_BATCH_TABLE,
    buildModelRouteCertificationBatchTable,
  );
  await trx.schema.createTable(
    MODEL_ROUTE_CERTIFICATION_TABLE,
    buildModelRouteCertificationTable,
  );
  await installBatchGuards(trx);
  await installCertificationGuards(trx);
}

export async function downModelRouteCertification(): Promise<never> {
  throw new Error(
    "Migration model_route_certification cannot be rolled back safely because certification evidence is an auditable production control record.",
  );
}
