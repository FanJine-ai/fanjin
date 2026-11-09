import type { Knex } from "knex";

import {
  isPostgresClient,
  quoteSqlIdentifier,
} from "@/lib/dbDialect";

export const OBJECT_WRITE_INTENT_TABLE = "o_object_write_intent";

export const OBJECT_WRITE_INTENT_INDEXES = {
  providerKey: "uq_o_object_write_intent_provider_key",
  due: "idx_o_object_write_intent_due",
  project: "idx_o_object_write_intent_project",
} as const;

const OBJECT_WRITE_INTENT_GUARD_TRIGGER =
  "trg_o_object_write_intent_evidence_guard";
const OBJECT_WRITE_INTENT_GUARD_FUNCTION =
  "fanjin_guard_object_write_intent_evidence";

async function ensureObjectWriteIntentGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  const table = quoteSqlIdentifier(OBJECT_WRITE_INTENT_TABLE);
  if (isPostgresClient(database)) {
    const trigger = quoteSqlIdentifier(OBJECT_WRITE_INTENT_GUARD_TRIGGER);
    const fn = quoteSqlIdentifier(OBJECT_WRITE_INTENT_GUARD_FUNCTION);
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${fn}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION '${OBJECT_WRITE_INTENT_TABLE} is durable evidence'
            USING ERRCODE = '55000';
        END IF;
        IF OLD."status" IN ('committed', 'compensated', 'dead') THEN
          RAISE EXCEPTION 'terminal object write intent is immutable'
            USING ERRCODE = '55000';
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
          OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
          OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
          OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
          OR NEW."provider" IS DISTINCT FROM OLD."provider"
          OR NEW."providerFingerprint" IS DISTINCT FROM OLD."providerFingerprint"
          OR NEW."bucket" IS DISTINCT FROM OLD."bucket"
          OR NEW."region" IS DISTINCT FROM OLD."region"
          OR NEW."endpoint" IS DISTINCT FROM OLD."endpoint"
          OR NEW."keyPrefix" IS DISTINCT FROM OLD."keyPrefix"
          OR NEW."forcePathStyle" IS DISTINCT FROM OLD."forcePathStyle"
          OR NEW."objectKey" IS DISTINCT FROM OLD."objectKey"
          OR NEW."expectedSize" IS DISTINCT FROM OLD."expectedSize"
          OR NEW."expectedSha256" IS DISTINCT FROM OLD."expectedSha256"
          OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
        THEN
          RAISE EXCEPTION 'object write intent identity is immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD."writeReceiptJson" IS NOT NULL
          AND (
            NEW."writeReceiptJson" IS DISTINCT FROM OLD."writeReceiptJson"
            OR NEW."writeReceiptHash" IS DISTINCT FROM OLD."writeReceiptHash"
            OR NEW."putCompletedAt" IS DISTINCT FROM OLD."putCompletedAt"
          )
        THEN
          RAISE EXCEPTION 'object write receipt is immutable'
            USING ERRCODE = '55000';
        END IF;
        IF OLD."referenceJson" IS NOT NULL
          AND (
            NEW."referenceJson" IS DISTINCT FROM OLD."referenceJson"
            OR NEW."referenceHash" IS DISTINCT FROM OLD."referenceHash"
            OR NEW."committedAt" IS DISTINCT FROM OLD."committedAt"
          )
        THEN
          RAISE EXCEPTION 'object write reference evidence is immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.raw(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    await database.raw(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${fn}()
    `);
    return;
  }

  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${OBJECT_WRITE_INTENT_GUARD_TRIGGER}_identity`)}
    BEFORE UPDATE OF
      "id", "requestHash", "purpose", "workspaceId", "projectId",
      "provider", "providerFingerprint", "bucket", "region", "endpoint",
      "keyPrefix", "forcePathStyle", "objectKey", "expectedSize",
      "expectedSha256", "createdAt"
    ON ${table}
    BEGIN
      SELECT RAISE(ABORT, 'object write intent identity is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${OBJECT_WRITE_INTENT_GUARD_TRIGGER}_receipt`)}
    BEFORE UPDATE OF "writeReceiptJson", "writeReceiptHash", "putCompletedAt"
    ON ${table}
    FOR EACH ROW WHEN OLD."writeReceiptJson" IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'object write receipt is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${OBJECT_WRITE_INTENT_GUARD_TRIGGER}_reference`)}
    BEFORE UPDATE OF "referenceJson", "referenceHash", "committedAt"
    ON ${table}
    FOR EACH ROW WHEN OLD."referenceJson" IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'object write reference evidence is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${OBJECT_WRITE_INTENT_GUARD_TRIGGER}_terminal`)}
    BEFORE UPDATE ON ${table}
    FOR EACH ROW WHEN OLD."status" IN ('committed', 'compensated', 'dead')
    BEGIN
      SELECT RAISE(ABORT, 'terminal object write intent is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${OBJECT_WRITE_INTENT_GUARD_TRIGGER}_delete`)}
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(
        ABORT,
        '${OBJECT_WRITE_INTENT_TABLE} is durable evidence'
      );
    END
  `);
}

export async function upObjectWriteIntent(
  trx: Knex.Transaction,
): Promise<void> {
  if (!(await trx.schema.hasTable(OBJECT_WRITE_INTENT_TABLE))) {
    await trx.schema.createTable(OBJECT_WRITE_INTENT_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("requestHash").notNullable().unique();
      table.text("purpose").notNullable();
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("provider").notNullable();
      table.text("providerFingerprint").notNullable();
      table.text("bucket").notNullable();
      table.text("region").notNullable();
      table.text("endpoint").notNullable();
      table.text("keyPrefix").notNullable();
      table.boolean("forcePathStyle").notNullable();
      table.text("objectKey").notNullable();
      table.bigInteger("expectedSize").notNullable();
      table.text("expectedSha256").notNullable();
      table.text("status").notNullable();
      table.text("writeReceiptJson");
      table.text("writeReceiptHash");
      table.text("referenceJson");
      table.text("referenceHash");
      table.text("compensationEvidenceJson");
      table.text("compensationEvidenceHash");
      table.text("errorCode");
      table.text("leaseOwner");
      table.bigInteger("leaseExpiresAt");
      table.bigInteger("leaseFence").notNullable();
      table.bigInteger("retryCount").notNullable();
      table.bigInteger("maxRetries").notNullable();
      table.bigInteger("nextAttemptAt").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.bigInteger("putCompletedAt");
      table.bigInteger("committedAt");
      table.bigInteger("compensatedAt");

      table.unique(
        ["providerFingerprint", "objectKey"],
        OBJECT_WRITE_INTENT_INDEXES.providerKey,
      );
      table.index(
        ["status", "nextAttemptAt", "leaseExpiresAt"],
        OBJECT_WRITE_INTENT_INDEXES.due,
      );
      table.index(
        ["workspaceId", "projectId", "createdAt"],
        OBJECT_WRITE_INTENT_INDEXES.project,
      );
      table.check(
        "\"purpose\" IN ('relay_final', 'video_enhance',"
          + " 'agent_generation', 'direct_upload')",
        {},
        "chk_o_object_write_intent_purpose",
      );
      table.check(
        "\"provider\" IN ('local', 's3', 'tos')",
        {},
        "chk_o_object_write_intent_provider",
      );
      table.check(
        "\"status\" IN ('prepared', 'stored', 'committed',"
          + " 'compensation_pending', 'compensating', 'compensated', 'dead')",
        {},
        "chk_o_object_write_intent_status",
      );
      table.check(
        "\"projectId\" > 0 AND \"expectedSize\" >= 0"
          + " AND length(\"expectedSha256\") = 64"
          + " AND length(\"requestHash\") = 64"
          + " AND length(\"providerFingerprint\") = 64",
        {},
        "chk_o_object_write_intent_identity",
      );
      table.check(
        "\"retryCount\" BETWEEN 0 AND 101"
          + " AND \"maxRetries\" BETWEEN 0 AND 100"
          + " AND \"leaseFence\" >= 1"
          + " AND \"nextAttemptAt\" >= 0"
          + " AND \"createdAt\" >= 0"
          + " AND \"updatedAt\" >= 0",
        {},
        "chk_o_object_write_intent_counters",
      );
      table.check(
        "(\"status\" IN ('prepared', 'stored', 'compensating')"
          + " AND \"leaseOwner\" IS NOT NULL"
          + " AND \"leaseExpiresAt\" IS NOT NULL"
          + ") OR (\"status\" IN ('compensation_pending', 'committed',"
          + " 'compensated', 'dead')"
          + " AND \"leaseOwner\" IS NULL"
          + " AND \"leaseExpiresAt\" IS NULL)",
        {},
        "chk_o_object_write_intent_lease",
      );
      table.check(
        "(\"writeReceiptJson\" IS NULL AND \"writeReceiptHash\" IS NULL"
          + " AND \"putCompletedAt\" IS NULL)"
          + " OR (\"writeReceiptJson\" IS NOT NULL"
          + " AND \"writeReceiptHash\" IS NOT NULL"
          + " AND length(\"writeReceiptHash\") = 64"
          + " AND \"putCompletedAt\" IS NOT NULL)",
        {},
        "chk_o_object_write_intent_receipt",
      );
      table.check(
        "(\"referenceJson\" IS NULL AND \"referenceHash\" IS NULL"
          + " AND \"committedAt\" IS NULL)"
          + " OR (\"referenceJson\" IS NOT NULL"
          + " AND \"referenceHash\" IS NOT NULL"
          + " AND length(\"referenceHash\") = 64"
          + " AND \"committedAt\" IS NOT NULL)",
        {},
        "chk_o_object_write_intent_reference",
      );
      table.check(
        "(\"status\" <> 'compensated'"
          + " AND \"compensationEvidenceJson\" IS NULL"
          + " AND \"compensationEvidenceHash\" IS NULL"
          + " AND \"compensatedAt\" IS NULL)"
          + " OR (\"status\" = 'compensated'"
          + " AND \"compensationEvidenceJson\" IS NOT NULL"
          + " AND \"compensationEvidenceHash\" IS NOT NULL"
          + " AND length(\"compensationEvidenceHash\") = 64"
          + " AND \"compensatedAt\" IS NOT NULL)",
        {},
        "chk_o_object_write_intent_compensation",
      );
      table.check(
        "(\"status\" = 'prepared' AND \"writeReceiptJson\" IS NULL"
          + " AND \"referenceJson\" IS NULL)"
          + " OR (\"status\" = 'stored' AND \"writeReceiptJson\" IS NOT NULL"
          + " AND \"referenceJson\" IS NULL)"
          + " OR (\"status\" = 'committed' AND \"writeReceiptJson\" IS NOT NULL"
          + " AND \"referenceJson\" IS NOT NULL)"
          + " OR (\"status\" IN ('compensation_pending', 'compensating')"
          + " AND \"referenceJson\" IS NULL)"
          + " OR (\"status\" = 'dead' AND \"writeReceiptJson\" IS NOT NULL"
          + " AND \"referenceJson\" IS NULL)"
          + " OR (\"status\" = 'compensated' AND \"referenceJson\" IS NULL"
          + " AND \"writeReceiptJson\" IS NOT NULL"
          + " AND \"compensationEvidenceJson\" IS NOT NULL)",
        {},
        "chk_o_object_write_intent_lifecycle",
      );
    });
  }
  await ensureObjectWriteIntentGuards(trx);
}

export async function downObjectWriteIntent(): Promise<void> {
  throw new Error(
    "Migration object_write_intent cannot be rolled back safely because PUT receipts, references and compensation receipts are audit evidence.",
  );
}
