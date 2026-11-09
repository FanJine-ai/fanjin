import type { Knex } from "knex";
import { isPostgresClient } from "@/lib/dbDialect";
import { OBJECT_WRITE_INTENT_TABLE } from "@/lib/migrations/objectWriteIntent";

export const OBJECT_WRITE_ABSENCE_AUDIT_TABLE = "o_object_write_absence_reconciliation";
export const OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY = Object.freeze({
  version: 54,
  name: "object_write_absence_reconciliation",
  immutableRevision: "2026-09-06.1",
});
export const OBJECT_WRITE_ABSENCE_FORMAT = "object-write-absence-reconciliation.v1";
const LIFECYCLE = "chk_o_object_write_intent_lifecycle";

// This is a new v54 edge. The applied v35 migration and its checksums remain
// untouched. No original PUT receipt, timestamp, or error is manufactured.
function lifecycleCheck(postgres: boolean): string {
  const field = (key: string) => postgres
    ? `("compensationEvidenceJson"::jsonb ->> '${key}')`
    : `json_extract("compensationEvidenceJson", '$.${key}')`;
  return `(
    ("status" = 'prepared' AND "writeReceiptJson" IS NULL AND "referenceJson" IS NULL)
    OR ("status" = 'stored' AND "writeReceiptJson" IS NOT NULL AND "referenceJson" IS NULL)
    OR ("status" = 'committed' AND "writeReceiptJson" IS NOT NULL AND "referenceJson" IS NOT NULL)
    OR ("status" IN ('compensation_pending', 'compensating') AND "referenceJson" IS NULL)
    OR ("status" = 'dead' AND "writeReceiptJson" IS NOT NULL AND "referenceJson" IS NULL)
    OR ("status" = 'compensated' AND "referenceJson" IS NULL
      AND "compensationEvidenceJson" IS NOT NULL AND (
        "writeReceiptJson" IS NOT NULL OR (
          "writeReceiptJson" IS NULL AND "writeReceiptHash" IS NULL AND "putCompletedAt" IS NULL
          AND "referenceHash" IS NULL AND "committedAt" IS NULL
          AND "purpose" = 'direct_upload' AND "provider" IN ('tos', 's3')
          AND "errorCode" = 'OBJECT_WRITE_PUT_OUTCOME_UNCERTAIN'
          AND ${field("format")} = '${OBJECT_WRITE_ABSENCE_FORMAT}'
          AND ${field("mode")} = 'remote_now_absent_no_put_claim'
          AND ${field("intentId")} = "id"
          AND ${field("objectKey")} = "objectKey"
          AND ${field("providerFingerprint")} = "providerFingerprint"
          AND length(${field("operationId")}) BETWEEN 6 AND 128
        )
      ))) IS TRUE`;
}

async function replaceSqliteLifecycle(trx: Knex.Transaction): Promise<void> {
  const row = await trx("sqlite_master").where({ type: "table", name: OBJECT_WRITE_INTENT_TABLE }).first();
  const sql = String(row?.sql || "");
  const marker = /constraint\s+["`\[]?chk_o_object_write_intent_lifecycle["`\]]?\s+check\s*\(/iu.exec(sql);
  if (!marker || marker.index === undefined) throw new Error("OBJECT_WRITE_ABSENCE_LIFECYCLE_MISSING");
  let depth = 1;
  let end = marker.index + marker[0].length;
  // The immutable v35 expression has no parentheses inside quoted literals.
  for (; end < sql.length && depth; end += 1) {
    if (sql[end] === "(") depth += 1;
    if (sql[end] === ")") depth -= 1;
  }
  if (depth) throw new Error("OBJECT_WRITE_ABSENCE_LIFECYCLE_INVALID");
  const replacement = "o_object_write_intent_absence_v54_tmp";
  if (await trx.schema.hasTable(replacement)) throw new Error("OBJECT_WRITE_ABSENCE_TEMP_TABLE_EXISTS");
  const retained = await trx("sqlite_master").where({ tbl_name: OBJECT_WRITE_INTENT_TABLE })
    .whereIn("type", ["trigger", "index"]).whereNotNull("sql").orderBy("name");
  const revised = (sql.slice(0, marker.index) + `CONSTRAINT "${LIFECYCLE}" CHECK (${lifecycleCheck(false)})` + sql.slice(end))
    .replace(/^CREATE TABLE\s+["`\[]?o_object_write_intent["`\]]?/iu, `CREATE TABLE "${replacement}"`);
  if (!revised.startsWith(`CREATE TABLE "${replacement}"`)) throw new Error("OBJECT_WRITE_ABSENCE_TABLE_SHAPE_INVALID");
  await trx.raw(revised);
  await trx.raw(`INSERT INTO "${replacement}" SELECT * FROM "${OBJECT_WRITE_INTENT_TABLE}"`);
  await trx.raw(`DROP TABLE "${OBJECT_WRITE_INTENT_TABLE}"`);
  await trx.raw(`ALTER TABLE "${replacement}" RENAME TO "${OBJECT_WRITE_INTENT_TABLE}"`);
  for (const item of retained) await trx.raw(String(item.sql));
  const violations = await trx.raw("PRAGMA foreign_key_check");
  if (violations.length) throw new Error("OBJECT_WRITE_ABSENCE_FOREIGN_KEY_INVALID");
}

export async function upObjectWriteAbsenceReconciliation(trx: Knex.Transaction): Promise<void> {
  const postgres = isPostgresClient(trx);
  if (!(await trx.schema.hasTable(OBJECT_WRITE_INTENT_TABLE))) {
    throw new Error("OBJECT_WRITE_ABSENCE_INTENT_TABLE_MISSING");
  }
  if (!(await trx.schema.hasTable(OBJECT_WRITE_ABSENCE_AUDIT_TABLE))) {
    await trx.schema.createTable(OBJECT_WRITE_ABSENCE_AUDIT_TABLE, (table) => {
      table.text("operationId").primary();
      table.text("requestSha256").notNullable().unique();
      table.text("planJson").notNullable();
      table.text("authorizationJson").notNullable();
      table.text("beforeRowsJson").notNullable();
      table.text("afterRowsJson").notNullable();
      table.text("evidenceJson").notNullable();
      table.text("receiptJson").notNullable();
      table.text("receiptSha256").notNullable();
      table.bigInteger("completedAt").notNullable();
      table.check('length("requestSha256") = 64 AND length("receiptSha256") = 64 AND "completedAt" > 0', {}, "chk_object_write_absence_audit_identity");
    });
  }
  if (postgres) {
    await trx.raw(`ALTER TABLE "${OBJECT_WRITE_INTENT_TABLE}" DROP CONSTRAINT "${LIFECYCLE}"`);
    await trx.raw(`ALTER TABLE "${OBJECT_WRITE_INTENT_TABLE}" ADD CONSTRAINT "${LIFECYCLE}" CHECK (${lifecycleCheck(true)})`);
    await trx.raw(`CREATE OR REPLACE FUNCTION fanjin_guard_object_write_absence_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'object write absence audit is immutable' USING ERRCODE = '55000'; END; $$`);
    await trx.raw(`CREATE TRIGGER trg_object_write_absence_audit_immutable BEFORE UPDATE OR DELETE ON "${OBJECT_WRITE_ABSENCE_AUDIT_TABLE}"
      FOR EACH ROW EXECUTE FUNCTION fanjin_guard_object_write_absence_audit()`);
    await trx.raw(`CREATE TRIGGER trg_object_write_absence_audit_truncate BEFORE TRUNCATE ON "${OBJECT_WRITE_ABSENCE_AUDIT_TABLE}"
      FOR EACH STATEMENT EXECUTE FUNCTION fanjin_guard_object_write_absence_audit()`);
    await trx.raw(`CREATE OR REPLACE FUNCTION fanjin_guard_object_write_absence_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."status" = 'compensated' AND NEW."writeReceiptJson" IS NULL THEN
          IF TG_OP <> 'UPDATE' THEN
            RAISE EXCEPTION 'receiptless terminal intents cannot be inserted' USING ERRCODE = '55000';
          END IF;
          IF OLD."status" <> 'compensation_pending'
            OR OLD."writeReceiptJson" IS NOT NULL OR OLD."writeReceiptHash" IS NOT NULL OR OLD."putCompletedAt" IS NOT NULL
            OR OLD."referenceJson" IS NOT NULL OR OLD."referenceHash" IS NOT NULL OR OLD."committedAt" IS NOT NULL
            OR OLD."compensationEvidenceJson" IS NOT NULL OR OLD."compensationEvidenceHash" IS NOT NULL OR OLD."compensatedAt" IS NOT NULL
            OR OLD."leaseOwner" IS NOT NULL OR OLD."leaseExpiresAt" IS NOT NULL
            OR NEW."errorCode" IS DISTINCT FROM OLD."errorCode" OR NEW."nextAttemptAt" IS DISTINCT FROM OLD."nextAttemptAt"
            OR NEW."leaseFence" IS DISTINCT FROM OLD."leaseFence" OR NEW."retryCount" IS DISTINCT FROM OLD."retryCount"
            OR NEW."maxRetries" IS DISTINCT FROM OLD."maxRetries"
            OR NOT EXISTS (
              SELECT 1 FROM "${OBJECT_WRITE_ABSENCE_AUDIT_TABLE}" a
              WHERE a."operationId" = (NEW."compensationEvidenceJson"::jsonb ->> 'operationId')
                AND a."beforeRowsJson"::jsonb @> jsonb_build_array(to_jsonb(OLD))
                AND a."afterRowsJson"::jsonb @> jsonb_build_array(to_jsonb(NEW))
                AND jsonb_array_length(a."beforeRowsJson"::jsonb) = 9
                AND jsonb_array_length(a."afterRowsJson"::jsonb) = 9
                AND a."completedAt" = NEW."compensatedAt"
            ) THEN RAISE EXCEPTION 'object write absence transition lacks exact atomic audit' USING ERRCODE = '55000'; END IF;
        END IF;
        RETURN NEW;
      END; $$`);
    await trx.raw(`CREATE TRIGGER trg_object_write_absence_transition BEFORE INSERT OR UPDATE ON "${OBJECT_WRITE_INTENT_TABLE}"
      FOR EACH ROW EXECUTE FUNCTION fanjin_guard_object_write_absence_transition()`);
  } else {
    await replaceSqliteLifecycle(trx);
    for (const action of ["UPDATE", "DELETE"]) {
      await trx.raw(`CREATE TRIGGER trg_object_write_absence_audit_${action.toLowerCase()} BEFORE ${action} ON "${OBJECT_WRITE_ABSENCE_AUDIT_TABLE}"
        BEGIN SELECT RAISE(ABORT, 'object write absence audit is immutable'); END`);
    }
    // The executable recovery is PostgreSQL-only. SQLite records the same
    // migration boundary but cannot perform a receiptless durable transition.
    await trx.raw(`CREATE TRIGGER trg_object_write_absence_transition BEFORE UPDATE ON "${OBJECT_WRITE_INTENT_TABLE}"
      FOR EACH ROW WHEN NEW."status" = 'compensated' AND NEW."writeReceiptJson" IS NULL
      BEGIN SELECT RAISE(ABORT, 'object write absence recovery requires PostgreSQL'); END`);
    await trx.raw(`CREATE TRIGGER trg_object_write_absence_insert BEFORE INSERT ON "${OBJECT_WRITE_INTENT_TABLE}"
      FOR EACH ROW WHEN NEW."status" = 'compensated' AND NEW."writeReceiptJson" IS NULL
      BEGIN SELECT RAISE(ABORT, 'receiptless terminal intents cannot be inserted'); END`);
  }
}

export async function downObjectWriteAbsenceReconciliation(): Promise<void> {
  throw new Error("Object write absence reconciliation audit is durable evidence; rollback requires a compatible binary, not deleting the audit or reverting schema.");
}
