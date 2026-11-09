import type { Knex } from "knex";

import {
  isPostgresClient,
  quoteSqlIdentifier,
} from "@/lib/dbDialect";

const DELETION_OPERATION_TABLE = "o_deletion_operation";

export const DELETION_CHECKPOINT_TABLE =
  "o_deletion_operation_checkpoint";
export const DELETION_MANIFEST_CHUNK_TABLE =
  "o_deletion_manifest_chunk";
export const DELETION_AUDIT_CHUNK_TABLE =
  "o_deletion_audit_chunk";

export const DELETION_CHUNK_STORE_INDEXES = {
  checkpointPhase: "idx_o_deletion_checkpoint_phase",
  checkpointProviderScope: "idx_o_deletion_checkpoint_provider_scope",
  manifestTraversal: "idx_o_deletion_manifest_chunk_traversal",
  manifestContent: "uq_o_deletion_manifest_chunk_content",
  auditTraversal: "idx_o_deletion_audit_chunk_traversal",
  auditContent: "uq_o_deletion_audit_chunk_content",
} as const;

const CHECKPOINT_GUARD_TRIGGER =
  "trg_o_deletion_checkpoint_evidence_guard";
const CHECKPOINT_GUARD_FUNCTION =
  "fanjin_guard_deletion_checkpoint_evidence";
const MANIFEST_CHUNK_GUARD_TRIGGER =
  "trg_o_deletion_manifest_chunk_evidence_guard";
const MANIFEST_CHUNK_GUARD_FUNCTION =
  "fanjin_guard_deletion_manifest_chunk_evidence";
const AUDIT_CHUNK_GUARD_TRIGGER =
  "trg_o_deletion_audit_chunk_evidence_guard";
const AUDIT_CHUNK_GUARD_FUNCTION =
  "fanjin_guard_deletion_audit_chunk_evidence";

async function createDeletionCheckpointTable(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(DELETION_CHECKPOINT_TABLE)) return;
  await trx.schema.createTable(DELETION_CHECKPOINT_TABLE, (table) => {
    table
      .text("operationId")
      .notNullable()
      .primary()
      .references("id")
      .inTable(DELETION_OPERATION_TABLE)
      .onDelete("RESTRICT");
    table.text("leaseOwner").notNullable();
    table.bigInteger("leaseFence").notNullable();
    table.text("phase").notNullable();
    table.bigInteger("epoch").notNullable();
    table.text("providerId").notNullable();
    table.text("providerFingerprint").notNullable();
    table.text("bucket").notNullable();
    table.text("objectPrefix").notNullable();
    table.text("keyMarker");
    table.text("versionIdMarker");
    table.text("cursorHash").notNullable();
    table.bigInteger("nextManifestChunkOrdinal").notNullable();
    table.text("manifestChainHash").notNullable();
    table.bigInteger("manifestItemCount").notNullable();
    table.bigInteger("auditTableOrdinal").notNullable();
    table.text("auditTableName");
    table.text("auditCursorJson");
    table.text("auditCursorHash");
    table.bigInteger("nextAuditChunkOrdinal").notNullable();
    table.text("auditChainHash").notNullable();
    table.bigInteger("auditRowCount").notNullable();
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    table.index(
      ["phase", "updatedAt", "operationId"],
      DELETION_CHUNK_STORE_INDEXES.checkpointPhase,
    );
    table.index(
      ["providerFingerprint", "bucket", "objectPrefix"],
      DELETION_CHUNK_STORE_INDEXES.checkpointProviderScope,
    );
    table.check(
      "\"phase\" IN ('source_scan', 'storage_scan', 'dispatch',"
        + " 'verify', 'db_finalize', 'completed')",
      {},
      "chk_o_deletion_checkpoint_phase",
    );
    table.check(
      "\"leaseFence\" >= 0"
        + " AND \"epoch\" >= 0"
        + " AND \"nextManifestChunkOrdinal\" >= 0"
        + " AND \"manifestItemCount\" >= 0"
        + " AND \"auditTableOrdinal\" >= 0"
        + " AND \"nextAuditChunkOrdinal\" >= 0"
        + " AND \"auditRowCount\" >= 0"
        + " AND \"createdAt\" >= 0"
        + " AND \"updatedAt\" >= \"createdAt\"",
      {},
      "chk_o_deletion_checkpoint_counters",
    );
    table.check(
      "length(\"providerFingerprint\") = 64"
        + " AND length(\"cursorHash\") = 64"
        + " AND length(\"manifestChainHash\") = 64"
        + " AND length(\"auditChainHash\") = 64"
        + " AND (\"auditCursorHash\" IS NULL"
        + " OR length(\"auditCursorHash\") = 64)",
      {},
      "chk_o_deletion_checkpoint_hashes",
    );
    table.check(
      "length(\"providerId\") BETWEEN 1 AND 255"
        + " AND \"providerId\" = trim(\"providerId\")"
        + " AND length(\"leaseOwner\") BETWEEN 1 AND 255"
        + " AND \"leaseOwner\" = trim(\"leaseOwner\")"
        + " AND length(\"bucket\") BETWEEN 1 AND 255"
        + " AND \"bucket\" = trim(\"bucket\")"
        + " AND length(\"objectPrefix\") BETWEEN 1 AND 4096"
        + " AND \"objectPrefix\" = trim(\"objectPrefix\")",
      {},
      "chk_o_deletion_checkpoint_provider_scope",
    );
    table.check(
      "(\"keyMarker\" IS NULL AND \"versionIdMarker\" IS NULL)"
        + " OR (\"keyMarker\" IS NOT NULL"
        + " AND \"versionIdMarker\" IS NOT NULL"
        + " AND length(\"keyMarker\") BETWEEN 1 AND 4096"
        + " AND length(\"versionIdMarker\") BETWEEN 1 AND 4096"
        + " AND \"phase\" IN ('source_scan', 'storage_scan', 'verify'))",
      {},
      "chk_o_deletion_checkpoint_markers",
    );
    table.check(
      "(\"auditTableName\" IS NULL"
        + " AND \"auditCursorJson\" IS NULL"
        + " AND \"auditCursorHash\" IS NULL)"
        + " OR (\"phase\" IN ('db_finalize', 'completed')"
        + " AND length(\"auditTableName\") BETWEEN 1 AND 128"
        + " AND \"auditTableName\" = trim(\"auditTableName\")"
        + " AND length(\"auditCursorJson\") BETWEEN 1 AND 65536"
        + " AND length(\"auditCursorHash\") = 64)",
      {},
      "chk_o_deletion_checkpoint_audit_cursor",
    );
  });
}

async function createDeletionManifestChunkTable(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(DELETION_MANIFEST_CHUNK_TABLE)) return;
  await trx.schema.createTable(DELETION_MANIFEST_CHUNK_TABLE, (table) => {
    table
      .text("operationId")
      .notNullable()
      .references("operationId")
      .inTable(DELETION_CHECKPOINT_TABLE)
      .onDelete("RESTRICT");
    table.bigInteger("epoch").notNullable();
    table.text("phase").notNullable();
    table.bigInteger("ordinal").notNullable();
    table.text("providerId").notNullable();
    table.text("providerFingerprint").notNullable();
    table.text("bucket").notNullable();
    table.text("objectPrefix").notNullable();
    table.text("inputKeyMarker");
    table.text("inputVersionIdMarker");
    table.text("outputKeyMarker");
    table.text("outputVersionIdMarker");
    table.text("inputCursorHash").notNullable();
    table.text("outputCursorHash").notNullable();
    table.bigInteger("itemCount").notNullable();
    table.text("contentHash").notNullable();
    table.text("previousChainHash").notNullable();
    table.text("chunkHash").notNullable();
    table.text("chainHash").notNullable();
    table.bigInteger("createdAt").notNullable();

    table.primary(
      ["operationId", "epoch", "ordinal"],
      "pk_o_deletion_manifest_chunk",
    );
    table.unique(
      ["operationId", "chunkHash"],
      DELETION_CHUNK_STORE_INDEXES.manifestContent,
    );
    table.index(
      ["operationId", "phase", "epoch", "ordinal"],
      DELETION_CHUNK_STORE_INDEXES.manifestTraversal,
    );
    table.check(
      "\"phase\" IN ('source_scan', 'storage_scan', 'verify')",
      {},
      "chk_o_deletion_manifest_chunk_phase",
    );
    table.check(
      "\"epoch\" >= 0 AND \"ordinal\" >= 0"
        + " AND \"itemCount\" BETWEEN 0 AND 500"
        + " AND \"createdAt\" >= 0",
      {},
      "chk_o_deletion_manifest_chunk_counters",
    );
    table.check(
      "length(\"providerFingerprint\") = 64"
        + " AND length(\"inputCursorHash\") = 64"
        + " AND length(\"outputCursorHash\") = 64"
        + " AND length(\"contentHash\") = 64"
        + " AND length(\"previousChainHash\") = 64"
        + " AND length(\"chunkHash\") = 64"
        + " AND length(\"chainHash\") = 64",
      {},
      "chk_o_deletion_manifest_chunk_hashes",
    );
    table.check(
      "length(\"providerId\") BETWEEN 1 AND 255"
        + " AND \"providerId\" = trim(\"providerId\")"
        + " AND length(\"bucket\") BETWEEN 1 AND 255"
        + " AND \"bucket\" = trim(\"bucket\")"
        + " AND length(\"objectPrefix\") BETWEEN 1 AND 4096"
        + " AND \"objectPrefix\" = trim(\"objectPrefix\")",
      {},
      "chk_o_deletion_manifest_chunk_scope",
    );
    table.check(
      "((\"inputKeyMarker\" IS NULL"
        + " AND \"inputVersionIdMarker\" IS NULL)"
        + " OR (\"inputKeyMarker\" IS NOT NULL"
        + " AND \"inputVersionIdMarker\" IS NOT NULL"
        + " AND length(\"inputKeyMarker\") BETWEEN 1 AND 4096"
        + " AND length(\"inputVersionIdMarker\") BETWEEN 1 AND 4096))"
        + " AND ((\"outputKeyMarker\" IS NULL"
        + " AND \"outputVersionIdMarker\" IS NULL)"
        + " OR (\"outputKeyMarker\" IS NOT NULL"
        + " AND \"outputVersionIdMarker\" IS NOT NULL"
        + " AND length(\"outputKeyMarker\") BETWEEN 1 AND 4096"
        + " AND length(\"outputVersionIdMarker\") BETWEEN 1 AND 4096))",
      {},
      "chk_o_deletion_manifest_chunk_markers",
    );
  });
}

async function createDeletionAuditChunkTable(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(DELETION_AUDIT_CHUNK_TABLE)) return;
  await trx.schema.createTable(DELETION_AUDIT_CHUNK_TABLE, (table) => {
    table
      .text("operationId")
      .notNullable()
      .references("operationId")
      .inTable(DELETION_CHECKPOINT_TABLE)
      .onDelete("RESTRICT");
    table.bigInteger("epoch").notNullable();
    table.bigInteger("tableOrdinal").notNullable();
    table.text("tableName").notNullable();
    table.bigInteger("ordinal").notNullable();
    table.text("inputAuditCursorJson").notNullable();
    table.text("inputAuditCursorHash").notNullable();
    table.text("outputAuditCursorJson").notNullable();
    table.text("outputAuditCursorHash").notNullable();
    table.text("inputCursorHash").notNullable();
    table.text("outputCursorHash").notNullable();
    table.bigInteger("rowCount").notNullable();
    table.text("rowsHash").notNullable();
    table.text("previousChainHash").notNullable();
    table.text("chunkHash").notNullable();
    table.text("chainHash").notNullable();
    table.bigInteger("createdAt").notNullable();

    table.primary(
      ["operationId", "epoch", "tableOrdinal", "ordinal"],
      "pk_o_deletion_audit_chunk",
    );
    table.unique(
      ["operationId", "chunkHash"],
      DELETION_CHUNK_STORE_INDEXES.auditContent,
    );
    table.index(
      ["operationId", "epoch", "tableName", "ordinal"],
      DELETION_CHUNK_STORE_INDEXES.auditTraversal,
    );
    table.check(
      "\"epoch\" >= 0 AND \"tableOrdinal\" >= 0"
        + " AND \"ordinal\" >= 0"
        + " AND \"rowCount\" BETWEEN 0 AND 500"
        + " AND \"createdAt\" >= 0",
      {},
      "chk_o_deletion_audit_chunk_counters",
    );
    table.check(
      "length(\"tableName\") BETWEEN 1 AND 128"
        + " AND \"tableName\" = trim(\"tableName\")"
        + " AND length(\"inputAuditCursorJson\") BETWEEN 1 AND 65536"
        + " AND length(\"outputAuditCursorJson\") BETWEEN 1 AND 65536",
      {},
      "chk_o_deletion_audit_chunk_cursors",
    );
    table.check(
      "length(\"inputAuditCursorHash\") = 64"
        + " AND length(\"outputAuditCursorHash\") = 64"
        + " AND length(\"inputCursorHash\") = 64"
        + " AND length(\"outputCursorHash\") = 64"
        + " AND length(\"rowsHash\") = 64"
        + " AND length(\"previousChainHash\") = 64"
        + " AND length(\"chunkHash\") = 64"
        + " AND length(\"chainHash\") = 64",
      {},
      "chk_o_deletion_audit_chunk_hashes",
    );
  });
}

async function ensurePostgresDeletionChunkGuards(
  database: Knex.Transaction,
): Promise<void> {
  const operationTable = quoteSqlIdentifier(DELETION_OPERATION_TABLE);
  const checkpointTable = quoteSqlIdentifier(DELETION_CHECKPOINT_TABLE);
  const manifestTable = quoteSqlIdentifier(DELETION_MANIFEST_CHUNK_TABLE);
  const auditTable = quoteSqlIdentifier(DELETION_AUDIT_CHUNK_TABLE);
  const checkpointFunction = quoteSqlIdentifier(CHECKPOINT_GUARD_FUNCTION);
  const manifestFunction = quoteSqlIdentifier(
    MANIFEST_CHUNK_GUARD_FUNCTION,
  );
  const auditFunction = quoteSqlIdentifier(AUDIT_CHUNK_GUARD_FUNCTION);

  await database.raw(`
    CREATE OR REPLACE FUNCTION ${checkpointFunction}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        PERFORM 1
        FROM ${operationTable} AS operation
        WHERE operation."id" = NEW."operationId"
          AND operation."status" IN ('preparing', 'deleting')
          AND operation."coordinatorLeaseOwner" = NEW."leaseOwner"
          AND operation."coordinatorFence" = NEW."leaseFence"
          AND operation."coordinatorLeaseExpiresAt" IS NOT NULL
        FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'deletion checkpoint parent operation is not writable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '${DELETION_CHECKPOINT_TABLE} is durable evidence'
          USING ERRCODE = '55000';
      END IF;
      IF NEW."operationId" IS DISTINCT FROM OLD."operationId"
        OR NEW."epoch" IS DISTINCT FROM OLD."epoch"
        OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
        OR NEW."providerFingerprint" IS DISTINCT FROM OLD."providerFingerprint"
        OR NEW."bucket" IS DISTINCT FROM OLD."bucket"
        OR NEW."objectPrefix" IS DISTINCT FROM OLD."objectPrefix"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      THEN
        RAISE EXCEPTION 'deletion checkpoint identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF OLD."phase" = 'completed' THEN
        RAISE EXCEPTION 'completed deletion checkpoint is immutable'
          USING ERRCODE = '55000';
      END IF;
      PERFORM 1
      FROM ${operationTable} AS operation
      WHERE operation."id" = NEW."operationId"
        AND operation."status" IN ('preparing', 'deleting')
        AND operation."coordinatorLeaseOwner" = NEW."leaseOwner"
        AND operation."coordinatorFence" = NEW."leaseFence"
        AND operation."coordinatorLeaseExpiresAt" IS NOT NULL
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'deletion checkpoint lease binding is invalid'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await database.raw(
    `DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(CHECKPOINT_GUARD_TRIGGER)}`
      + ` ON ${checkpointTable}`,
  );
  await database.raw(`
    CREATE TRIGGER ${quoteSqlIdentifier(CHECKPOINT_GUARD_TRIGGER)}
    BEFORE INSERT OR UPDATE OR DELETE ON ${checkpointTable}
    FOR EACH ROW EXECUTE FUNCTION ${checkpointFunction}()
  `);

  await database.raw(`
    CREATE OR REPLACE FUNCTION ${manifestFunction}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '${DELETION_MANIFEST_CHUNK_TABLE} is immutable evidence'
          USING ERRCODE = '55000';
      END IF;
      PERFORM 1
      FROM ${checkpointTable} AS checkpoint
      WHERE checkpoint."operationId" = NEW."operationId"
        AND checkpoint."epoch" = NEW."epoch"
        AND checkpoint."phase" = NEW."phase"
        AND checkpoint."nextManifestChunkOrdinal" = NEW."ordinal"
        AND checkpoint."cursorHash" = NEW."inputCursorHash"
        AND checkpoint."manifestChainHash" = NEW."previousChainHash"
        AND checkpoint."providerId" = NEW."providerId"
        AND checkpoint."providerFingerprint" = NEW."providerFingerprint"
        AND checkpoint."bucket" = NEW."bucket"
        AND checkpoint."objectPrefix" = NEW."objectPrefix"
        AND checkpoint."keyMarker" IS NOT DISTINCT FROM NEW."inputKeyMarker"
        AND checkpoint."versionIdMarker"
          IS NOT DISTINCT FROM NEW."inputVersionIdMarker"
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'deletion manifest chunk checkpoint mismatch'
          USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await database.raw(
    `DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(MANIFEST_CHUNK_GUARD_TRIGGER)}`
      + ` ON ${manifestTable}`,
  );
  await database.raw(`
    CREATE TRIGGER ${quoteSqlIdentifier(MANIFEST_CHUNK_GUARD_TRIGGER)}
    BEFORE INSERT OR UPDATE OR DELETE ON ${manifestTable}
    FOR EACH ROW EXECUTE FUNCTION ${manifestFunction}()
  `);

  await database.raw(`
    CREATE OR REPLACE FUNCTION ${auditFunction}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '${DELETION_AUDIT_CHUNK_TABLE} is immutable evidence'
          USING ERRCODE = '55000';
      END IF;
      PERFORM 1
      FROM ${checkpointTable} AS checkpoint
      WHERE checkpoint."operationId" = NEW."operationId"
        AND checkpoint."epoch" = NEW."epoch"
        AND checkpoint."phase" = 'db_finalize'
        AND checkpoint."auditTableOrdinal" = NEW."tableOrdinal"
        AND checkpoint."auditTableName" = NEW."tableName"
        AND checkpoint."nextAuditChunkOrdinal" = NEW."ordinal"
        AND checkpoint."auditCursorJson" = NEW."inputAuditCursorJson"
        AND checkpoint."auditCursorHash" = NEW."inputAuditCursorHash"
        AND checkpoint."cursorHash" = NEW."inputCursorHash"
        AND checkpoint."auditChainHash" = NEW."previousChainHash"
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'deletion audit chunk checkpoint mismatch'
          USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await database.raw(
    `DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(AUDIT_CHUNK_GUARD_TRIGGER)}`
      + ` ON ${auditTable}`,
  );
  await database.raw(`
    CREATE TRIGGER ${quoteSqlIdentifier(AUDIT_CHUNK_GUARD_TRIGGER)}
    BEFORE INSERT OR UPDATE OR DELETE ON ${auditTable}
    FOR EACH ROW EXECUTE FUNCTION ${auditFunction}()
  `);
}

async function ensureSqliteDeletionChunkGuards(
  database: Knex.Transaction,
): Promise<void> {
  const operationTable = quoteSqlIdentifier(DELETION_OPERATION_TABLE);
  const checkpointTable = quoteSqlIdentifier(DELETION_CHECKPOINT_TABLE);
  const manifestTable = quoteSqlIdentifier(DELETION_MANIFEST_CHUNK_TABLE);
  const auditTable = quoteSqlIdentifier(DELETION_AUDIT_CHUNK_TABLE);

  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${CHECKPOINT_GUARD_TRIGGER}_parent`)}
    BEFORE INSERT ON ${checkpointTable}
    FOR EACH ROW WHEN NOT EXISTS (
      SELECT 1
      FROM ${operationTable} AS operation
      WHERE operation."id" = NEW."operationId"
        AND operation."status" IN ('preparing', 'deleting')
        AND operation."coordinatorLeaseOwner" = NEW."leaseOwner"
        AND operation."coordinatorFence" = NEW."leaseFence"
        AND operation."coordinatorLeaseExpiresAt" IS NOT NULL
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'deletion checkpoint parent operation is not writable'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${CHECKPOINT_GUARD_TRIGGER}_lease`)}
    BEFORE UPDATE ON ${checkpointTable}
    FOR EACH ROW WHEN NOT EXISTS (
      SELECT 1
      FROM ${operationTable} AS operation
      WHERE operation."id" = NEW."operationId"
        AND operation."status" IN ('preparing', 'deleting')
        AND operation."coordinatorLeaseOwner" = NEW."leaseOwner"
        AND operation."coordinatorFence" = NEW."leaseFence"
        AND operation."coordinatorLeaseExpiresAt" IS NOT NULL
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'deletion checkpoint lease binding is invalid'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${CHECKPOINT_GUARD_TRIGGER}_terminal`)}
    BEFORE UPDATE ON ${checkpointTable}
    FOR EACH ROW WHEN OLD."phase" = 'completed'
    BEGIN
      SELECT RAISE(ABORT, 'completed deletion checkpoint is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${CHECKPOINT_GUARD_TRIGGER}_identity`)}
    BEFORE UPDATE OF
      "operationId", "epoch", "providerId", "providerFingerprint",
      "bucket", "objectPrefix", "createdAt"
    ON ${checkpointTable}
    BEGIN
      SELECT RAISE(ABORT, 'deletion checkpoint identity is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${CHECKPOINT_GUARD_TRIGGER}_delete`)}
    BEFORE DELETE ON ${checkpointTable}
    BEGIN
      SELECT RAISE(
        ABORT,
        '${DELETION_CHECKPOINT_TABLE} is durable evidence'
      );
    END
  `);

  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${MANIFEST_CHUNK_GUARD_TRIGGER}_parent`)}
    BEFORE INSERT ON ${manifestTable}
    FOR EACH ROW WHEN NOT EXISTS (
      SELECT 1
      FROM ${checkpointTable} AS checkpoint
      WHERE checkpoint."operationId" = NEW."operationId"
        AND checkpoint."epoch" = NEW."epoch"
        AND checkpoint."phase" = NEW."phase"
        AND checkpoint."nextManifestChunkOrdinal" = NEW."ordinal"
        AND checkpoint."cursorHash" = NEW."inputCursorHash"
        AND checkpoint."manifestChainHash" = NEW."previousChainHash"
        AND checkpoint."providerId" = NEW."providerId"
        AND checkpoint."providerFingerprint" = NEW."providerFingerprint"
        AND checkpoint."bucket" = NEW."bucket"
        AND checkpoint."objectPrefix" = NEW."objectPrefix"
        AND checkpoint."keyMarker" IS NEW."inputKeyMarker"
        AND checkpoint."versionIdMarker" IS NEW."inputVersionIdMarker"
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'deletion manifest chunk checkpoint mismatch'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${MANIFEST_CHUNK_GUARD_TRIGGER}_update`)}
    BEFORE UPDATE ON ${manifestTable}
    BEGIN
      SELECT RAISE(
        ABORT,
        '${DELETION_MANIFEST_CHUNK_TABLE} is immutable evidence'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${MANIFEST_CHUNK_GUARD_TRIGGER}_delete`)}
    BEFORE DELETE ON ${manifestTable}
    BEGIN
      SELECT RAISE(
        ABORT,
        '${DELETION_MANIFEST_CHUNK_TABLE} is immutable evidence'
      );
    END
  `);

  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${AUDIT_CHUNK_GUARD_TRIGGER}_parent`)}
    BEFORE INSERT ON ${auditTable}
    FOR EACH ROW WHEN NOT EXISTS (
      SELECT 1
      FROM ${checkpointTable} AS checkpoint
      WHERE checkpoint."operationId" = NEW."operationId"
        AND checkpoint."epoch" = NEW."epoch"
        AND checkpoint."phase" = 'db_finalize'
        AND checkpoint."auditTableOrdinal" = NEW."tableOrdinal"
        AND checkpoint."auditTableName" = NEW."tableName"
        AND checkpoint."nextAuditChunkOrdinal" = NEW."ordinal"
        AND checkpoint."auditCursorJson" = NEW."inputAuditCursorJson"
        AND checkpoint."auditCursorHash" = NEW."inputAuditCursorHash"
        AND checkpoint."cursorHash" = NEW."inputCursorHash"
        AND checkpoint."auditChainHash" = NEW."previousChainHash"
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'deletion audit chunk checkpoint mismatch'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${AUDIT_CHUNK_GUARD_TRIGGER}_update`)}
    BEFORE UPDATE ON ${auditTable}
    BEGIN
      SELECT RAISE(
        ABORT,
        '${DELETION_AUDIT_CHUNK_TABLE} is immutable evidence'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${AUDIT_CHUNK_GUARD_TRIGGER}_delete`)}
    BEFORE DELETE ON ${auditTable}
    BEGIN
      SELECT RAISE(
        ABORT,
        '${DELETION_AUDIT_CHUNK_TABLE} is immutable evidence'
      );
    END
  `);
}

async function ensureDeletionChunkGuards(
  trx: Knex.Transaction,
): Promise<void> {
  if (isPostgresClient(trx)) {
    await ensurePostgresDeletionChunkGuards(trx);
    return;
  }
  await ensureSqliteDeletionChunkGuards(trx);
}

/**
 * Installs the durable, bounded deletion checkpoint and chunk evidence store.
 * The parent deletion operation table must already exist.
 */
export async function upDeletionChunkStoreSchema(
  trx: Knex.Transaction,
): Promise<void> {
  await createDeletionCheckpointTable(trx);
  await createDeletionManifestChunkTable(trx);
  await createDeletionAuditChunkTable(trx);
  await ensureDeletionChunkGuards(trx);
}
