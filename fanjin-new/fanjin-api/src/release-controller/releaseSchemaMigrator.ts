import crypto from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { Knex } from "knex";

import {
  DATABASE_MIGRATIONS,
  SCHEMA_MIGRATION_RUN_TABLE,
  isReviewedConstraintlessDatabaseMigration,
  inspectDatabaseMigrations,
  runDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationRunEvidence,
  type MigrationRunnerTimeouts,
  type MigrationSafetyContext,
  type MigrationSchemaVerification,
  type VerifiedMigrationBackupCheckpoint,
} from "@/lib/databaseMigrations";
import {
  WORKSPACE_OWNER_TRANSFER_COMMAND_IDENTITY_INDEX,
} from "@/lib/migrations/identityAuthorityIntegrity";

import type {
  ReleaseActionContext,
  ReleaseSchemaMigrationObservation,
  ReleaseSchemaMigrationRequest,
  ReleaseSchemaMigrator,
} from "./types";

export const RELEASE_MIGRATION_BACKUP_CHECKPOINT_FORMAT =
  "fanjin-release-migration-backup-checkpoint/v2";

const MAX_CHECKPOINT_BYTES = 64 * 1024;
const MAX_CHECKPOINT_AGE_MS = 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const SOURCE_COMMIT_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,255}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const REQUIRED_CONSTRAINT_RE = /^[a-z][A-Za-z0-9_.:-]{0,127}$/;
// Schema 48 intentionally proves hundreds of immutable catalog facts. Keep a finite
// compile-time ceiling to bound catalog verification while admitting the
// reviewed 40→48 maintenance chain, the ordinary 47→48 adjacent edge, and the
// cumulative 49/50/51 additive chain that already exceeds the historical 512
// bound. Never raise this past what the reviewed migration catalog requires.
const MAX_REQUIRED_CONSTRAINTS = 1280;

function invariant(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) invariant("MIGRATION_ABORTED", "migration lease was aborted");
}

function databaseClientName(client: Knex | Knex.Transaction): string {
  return String(client.client.config.client || "").toLowerCase();
}

function rawRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const rows = Array.isArray(result[0]) ? result[0] : result;
    return rows.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === "object" && !Array.isArray(row)
    ));
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === "object" && !Array.isArray(row)
    ))
    : [];
}

function stableCatalogEntry(prefix: string, row: Record<string, unknown>): string {
  return `${prefix}:${Object.keys(row)
    .sort()
    .map((key) => `${key}=${String(row[key] ?? "")}`)
    .join("\0")}`;
}

function normalizedSql(value: unknown): string {
  return String(value || "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    .toLowerCase();
}

function simpleUniqueIndexColumns(
  indexDefinition: unknown,
): string[] | null {
  const definition = String(indexDefinition || "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !/^CREATE UNIQUE INDEX\b/i.test(definition)
    || /\bWHERE\b/i.test(definition)
    || /\bINCLUDE\s*\(/i.test(definition)
  ) {
    return null;
  }
  const match = definition.match(
    /\(\s*((?:"[_A-Za-z][_A-Za-z0-9]*"|`[_A-Za-z][_A-Za-z0-9]*`|[_A-Za-z][_A-Za-z0-9]*)(?:\s*,\s*(?:"[_A-Za-z][_A-Za-z0-9]*"|`[_A-Za-z][_A-Za-z0-9]*`|[_A-Za-z][_A-Za-z0-9]*))*)\s*\)\s*;?$/,
  );
  if (!match?.[1]) return null;
  return match[1].split(",").map((columnName) => (
    columnName.trim().replace(/^["`]|["`]$/g, "")
  ));
}

function normalizedUniqueIndexColumn(
  indexDefinition: unknown,
): string | null {
  const definition = normalizedSql(indexDefinition);
  if (!definition.startsWith("create unique index ")) return null;
  const match = definition.match(
    /\(lower\(([a-z_][a-z0-9_]*)\)\)\s+where\s+\(?\1\s+is\s+not\s+null\)?$/,
  );
  return match?.[1] || null;
}

function addUniqueIndexProofs(
  identifiers: Set<string>,
  input: {
    tableName: unknown;
    definition: unknown;
    validUnique?: boolean;
  },
): void {
  if (input.validUnique === false) return;
  const tableName = String(input.tableName || "");
  const columns = simpleUniqueIndexColumns(input.definition);
  if (columns?.length === 1) {
    identifiers.add(`unique-column:${tableName}.${columns[0]}`);
  }
  if (columns && columns.length > 0) {
    identifiers.add(`unique-tuple:${tableName}.${columns.join(".")}`);
  }
  const normalizedColumn = normalizedUniqueIndexColumn(input.definition);
  if (normalizedColumn) {
    identifiers.add(
      `unique-normalized:${tableName}.${normalizedColumn}`,
    );
  }
}

function primaryKeyColumns(definition: unknown): string[] | null {
  const match = String(definition || "")
    .replace(/\s+/g, " ")
    .trim()
    .match(
      /^PRIMARY KEY\s*\(\s*("?[_A-Za-z][_A-Za-z0-9]*"?(?:\s*,\s*"?[_A-Za-z][_A-Za-z0-9]*"?)*)\s*\)$/i,
    );
  if (!match?.[1]) return null;
  return match[1].split(",").map((columnName) => (
    columnName.trim().replace(/^"|"$/g, "")
  ));
}

function postgresAppendOnlyTables(
  triggers: Array<Record<string, unknown>>,
): Set<string> {
  const immutableSource = normalizedSql(`
    BEGIN
      RAISE EXCEPTION
        'workspace owner transfer command evidence is immutable'
        USING ERRCODE = '55000';
    END
  `);
  return new Set(
    triggers.filter((row) => {
      const definition = normalizedSql(row.trigger_definition);
      const triggerType = Number(row.trigger_type);
      const functionMatch = definition.match(
        /\bexecute function (?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\(\)$/,
      );
      return (
        String(row.trigger_enabled || "") === "O"
        && row.has_when_clause === false
        && (triggerType & 1) === 0
        && (triggerType & 2) === 2
        && (triggerType & 4) === 0
        && (triggerType & 8) === 8
        && (triggerType & 16) === 16
        && (triggerType & 32) === 32
        && definition.includes(" for each statement execute function ")
        && !definition.includes(" or insert ")
        && functionMatch?.[1] === String(row.function_name || "")
        && String(row.function_arguments || "") === ""
        && String(row.function_language || "") === "plpgsql"
        && row.security_definer !== true
        && String(row.volatility || "") === "v"
        && normalizedSql(row.function_source) === immutableSource
      );
    }).map((row) => String(row.table_name || "")),
  );
}

function sqliteAppendOnlyTables(
  objects: Array<Record<string, unknown>>,
  exactUniqueIndexTables: ReadonlySet<string>,
): Set<string> {
  const triggersByTable = new Map<string, Map<string, string>>();
  for (const row of objects.filter((entry) => entry.type === "trigger")) {
    const tableName = String(row.table_name || "");
    const tableTriggers = triggersByTable.get(tableName)
      || new Map<string, string>();
    tableTriggers.set(
      String(row.name || ""),
      normalizedSql(row.sql),
    );
    triggersByTable.set(tableName, tableTriggers);
  }
  const proven = new Set<string>();
  for (const [tableName, triggers] of triggersByTable) {
    const update = triggers.get(`${tableName}_immutable_update`) || "";
    const deletion = triggers.get(`${tableName}_immutable_delete`) || "";
    const insertGuard =
      triggers.get(`${tableName}_immutable_insert_guard`) || "";
    const updateExpected = normalizedSql(`
      CREATE TRIGGER ${tableName}_immutable_update
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(
          ABORT,
          'workspace owner transfer command evidence is immutable'
        );
      END
    `);
    const deleteExpected = normalizedSql(`
      CREATE TRIGGER ${tableName}_immutable_delete
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(
          ABORT,
          'workspace owner transfer command evidence is immutable'
        );
      END
    `);
    const insertExpected = normalizedSql(`
      CREATE TRIGGER ${tableName}_immutable_insert_guard
      BEFORE INSERT ON ${tableName}
      WHEN EXISTS (
        SELECT 1
          FROM ${tableName}
         WHERE id = NEW.id
            OR (
              workspaceId = NEW.workspaceId
              AND actorUserId = NEW.actorUserId
              AND idempotencyKey = NEW.idempotencyKey
            )
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'workspace owner transfer command evidence is immutable'
        );
      END
    `);
    if (
      update === updateExpected
      && deletion === deleteExpected
      && insertGuard === insertExpected
      && exactUniqueIndexTables.has(tableName)
    ) {
      proven.add(tableName);
    }
  }
  return proven;
}

async function sqliteExactAppendOnlyUniqueIndexTables(
  client: Knex | Knex.Transaction,
  tableNames: readonly string[],
): Promise<Set<string>> {
  const proven = new Set<string>();
  for (const tableName of tableNames) {
    const tableShape = rawRows(await client.raw(
      `SELECT wr AS without_rowid
         FROM pragma_table_list
        WHERE "schema" = 'main'
          AND type = 'table'
          AND name = ?`,
      [tableName],
    ));
    if (
      tableShape.length !== 1
      || Number(tableShape[0]?.without_rowid) !== 1
    ) {
      continue;
    }
    const indexes = rawRows(await client.raw(
      `SELECT name, "unique", origin, partial
         FROM pragma_index_list(?)
        WHERE "unique" = 1
        ORDER BY name`,
      [tableName],
    ));
    if (indexes.length !== 2) continue;
    let primaryKeyFound = false;
    let identityKeyFound = false;
    let invalid = false;
    for (const index of indexes) {
      const columns = rawRows(await client.raw(
        `SELECT
           cid,
           name,
           "desc" AS descending,
           coll AS collation,
           "key" AS key_column
         FROM pragma_index_xinfo(?)
        WHERE "key" = 1
        ORDER BY seqno`,
        [String(index.name || "")],
      ));
      const exactColumns = columns.every((column) => (
        Number(column.cid) >= 0
        && typeof column.name === "string"
        && Number(column.descending) === 0
        && String(column.collation || "").toUpperCase() === "BINARY"
        && Number(column.key_column) === 1
      ))
        ? columns.map((column) => String(column.name))
        : [];
      const isPrimaryKey = (
        String(index.origin) === "pk"
        && Number(index.partial) === 0
        && JSON.stringify(exactColumns) === JSON.stringify(["id"])
      );
      const isIdentityKey = (
        String(index.name)
          === WORKSPACE_OWNER_TRANSFER_COMMAND_IDENTITY_INDEX
        && String(index.origin) === "c"
        && Number(index.partial) === 0
        && JSON.stringify(exactColumns) === JSON.stringify([
          "workspaceId",
          "actorUserId",
          "idempotencyKey",
        ])
      );
      if (isPrimaryKey && !primaryKeyFound) {
        primaryKeyFound = true;
      } else if (isIdentityKey && !identityKeyFound) {
        identityKeyFound = true;
      } else {
        invalid = true;
        break;
      }
    }
    if (!invalid && primaryKeyFound && identityKeyFound) {
      proven.add(tableName);
    }
  }
  return proven;
}

async function postgresCatalog(
  client: Knex | Knex.Transaction,
): Promise<{ entries: string[]; identifiers: Set<string> }> {
  const [
    columnsResult,
    indexesResult,
    constraintsResult,
    triggersResult,
    functionsResult,
    viewsResult,
  ] = await Promise.all([
    client.raw(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable,
              COALESCE(column_default, '') AS column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
        ORDER BY table_name, ordinal_position`,
    ),
    client.raw(
      `SELECT
         listed_index.tablename AS table_name,
         listed_index.indexname AS index_name,
         listed_index.indexdef,
         index_entry.indisunique AS is_unique,
         index_entry.indisvalid AS is_valid,
         index_entry.indisready AS is_ready
       FROM pg_indexes AS listed_index
       JOIN pg_catalog.pg_class AS index_relation
         ON index_relation.relname = listed_index.indexname
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = index_relation.relnamespace
        AND namespace_row.nspname = listed_index.schemaname
       JOIN pg_catalog.pg_index AS index_entry
         ON index_entry.indexrelid = index_relation.oid
      WHERE listed_index.schemaname = current_schema()
      ORDER BY listed_index.tablename, listed_index.indexname`,
    ),
    client.raw(
      `SELECT relation.relname AS table_name,
              constraint_entry.conname AS constraint_name,
              constraint_entry.contype AS constraint_type,
              pg_get_constraintdef(constraint_entry.oid, true) AS constraint_definition,
              constraint_entry.condeferrable AS is_deferrable,
              constraint_entry.condeferred AS is_deferred,
              constraint_entry.convalidated AS is_validated
         FROM pg_constraint AS constraint_entry
         JOIN pg_class AS relation
           ON relation.oid = constraint_entry.conrelid
         JOIN pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = current_schema()
        ORDER BY relation.relname, constraint_entry.conname`,
    ),
    client.raw(
      `SELECT relation.relname AS table_name,
              trigger_entry.tgname AS trigger_name,
              trigger_entry.tgtype::integer AS trigger_type,
              (trigger_entry.tgqual IS NOT NULL) AS has_when_clause,
              pg_get_triggerdef(trigger_entry.oid, true) AS trigger_definition,
              trigger_entry.tgenabled AS trigger_enabled,
              function_entry.proname AS function_name,
              pg_get_function_identity_arguments(function_entry.oid)
                AS function_arguments,
              language_entry.lanname AS function_language,
              function_entry.provolatile AS volatility,
              function_entry.prosecdef AS security_definer,
              function_entry.prosrc AS function_source
         FROM pg_catalog.pg_trigger AS trigger_entry
         JOIN pg_catalog.pg_class AS relation
           ON relation.oid = trigger_entry.tgrelid
         JOIN pg_catalog.pg_namespace AS namespace_row
           ON namespace_row.oid = relation.relnamespace
         JOIN pg_catalog.pg_proc AS function_entry
           ON function_entry.oid = trigger_entry.tgfoid
         JOIN pg_catalog.pg_language AS language_entry
           ON language_entry.oid = function_entry.prolang
        WHERE namespace_row.nspname = current_schema()
          AND NOT trigger_entry.tgisinternal
        ORDER BY relation.relname, trigger_entry.tgname`,
    ),
    client.raw(
      `SELECT function_entry.proname AS function_name,
              pg_get_function_identity_arguments(function_entry.oid) AS identity_arguments,
              pg_get_function_result(function_entry.oid) AS result_type,
              language_entry.lanname AS language_name,
              function_entry.provolatile AS volatility,
              function_entry.prosecdef AS security_definer,
              function_entry.prosrc AS function_source,
              pg_get_functiondef(function_entry.oid) AS function_definition
         FROM pg_catalog.pg_proc AS function_entry
         JOIN pg_catalog.pg_namespace AS namespace_row
           ON namespace_row.oid = function_entry.pronamespace
         JOIN pg_catalog.pg_language AS language_entry
           ON language_entry.oid = function_entry.prolang
        WHERE namespace_row.nspname = current_schema()
          AND function_entry.prokind = 'f'
        ORDER BY function_entry.proname,
                 pg_get_function_identity_arguments(function_entry.oid)`,
    ),
    client.raw(
      `SELECT viewname AS view_name, definition AS view_definition
         FROM pg_catalog.pg_views
        WHERE schemaname = current_schema()
        ORDER BY viewname`,
    ),
  ]);
  const columns = rawRows(columnsResult);
  const indexes = rawRows(indexesResult);
  const constraints = rawRows(constraintsResult);
  const triggers = rawRows(triggersResult);
  const functions = rawRows(functionsResult);
  const views = rawRows(viewsResult);
  const identifiers = new Set<string>();
  for (const row of columns) {
    identifiers.add(`table:${String(row.table_name)}`);
    identifiers.add(`column:${String(row.table_name)}.${String(row.column_name)}`);
    if (String(row.is_nullable) === "NO") {
      identifiers.add(
        `not-null:${String(row.table_name)}.${String(row.column_name)}`,
      );
    }
    const canonicalType = row.data_type === "text" && row.udt_name === "text"
      ? "text"
      : row.data_type === "bigint" && row.udt_name === "int8"
        ? "bigint"
        : "";
    if (canonicalType) {
      identifiers.add(
        `type:${String(row.table_name)}.${String(row.column_name)}.${canonicalType}`,
      );
    }
  }
  for (const row of indexes) {
    identifiers.add(`index:${String(row.table_name)}.${String(row.index_name)}`);
    addUniqueIndexProofs(identifiers, {
      tableName: row.table_name,
      definition: row.indexdef,
      validUnique: (
        row.is_unique === true
        && row.is_valid === true
        && row.is_ready === true
      ),
    });
  }
  for (const row of constraints) {
    identifiers.add(`constraint:${String(row.table_name)}.${String(row.constraint_name)}`);
    if (
      String(row.constraint_type) === "p"
      && row.is_deferrable !== true
      && row.is_deferred !== true
      && row.is_validated === true
    ) {
      const columns = primaryKeyColumns(row.constraint_definition);
      if (columns?.length) {
        identifiers.add(
          `primary-key:${String(row.table_name)}.${columns.join(".")}`,
        );
      }
    }
  }
  for (const row of triggers) {
    identifiers.add(`trigger:${String(row.table_name)}.${String(row.trigger_name)}`);
  }
  for (const row of functions) {
    identifiers.add(`function:${String(row.function_name)}`);
  }
  for (const row of views) {
    identifiers.add(`view:${String(row.view_name)}`);
  }
  for (const tableName of postgresAppendOnlyTables(triggers)) {
    identifiers.add(`append-only:${tableName}`);
  }
  return {
    entries: [
      ...columns.map((row) => stableCatalogEntry("column", row)),
      ...indexes.map((row) => stableCatalogEntry("index", row)),
      ...constraints.map((row) => stableCatalogEntry("constraint", row)),
      ...triggers.map((row) => stableCatalogEntry("trigger", row)),
      ...functions.map((row) => stableCatalogEntry("function", row)),
      ...views.map((row) => stableCatalogEntry("view", row)),
    ].sort(),
    identifiers,
  };
}

async function sqliteCatalog(
  client: Knex | Knex.Transaction,
): Promise<{ entries: string[]; identifiers: Set<string> }> {
  const objects = rawRows(await client.raw(
    `SELECT type, name, tbl_name AS table_name, COALESCE(sql, '') AS sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND type IN ('table', 'index', 'trigger', 'view')
      ORDER BY type, name`,
  ));
  const identifiers = new Set<string>();
  const entries = objects.map((row) => stableCatalogEntry("object", row));
  const tables = objects
    .filter((row) => row.type === "table")
    .map((row) => String(row.name));
  const appendOnlyCandidateTables = Array.from(new Set(
    objects
      .filter((row) => (
        row.type === "trigger"
        && /_immutable_(?:update|delete|insert_guard)$/.test(
          String(row.name || ""),
        )
      ))
      .map((row) => String(row.table_name || ""))
      .filter(Boolean),
  ));
  const exactAppendOnlyUniqueIndexTables =
    await sqliteExactAppendOnlyUniqueIndexTables(
      client,
      appendOnlyCandidateTables,
    );
  for (const tableName of tables) {
    identifiers.add(`table:${tableName}`);
    const columns = rawRows(await client.raw(
      `SELECT name, type, "notnull" AS not_null, dflt_value, pk
         FROM pragma_table_info(?)
        ORDER BY cid`,
      [tableName],
    ));
    for (const column of columns) {
      identifiers.add(`column:${tableName}.${String(column.name)}`);
      entries.push(stableCatalogEntry(`column:${tableName}`, column));
      if (Number(column.not_null) === 1) {
        identifiers.add(`not-null:${tableName}.${String(column.name)}`);
      }
      const canonicalType = String(column.type || "").trim().toLowerCase();
      if (["text", "bigint"].includes(canonicalType)) {
        identifiers.add(
          `type:${tableName}.${String(column.name)}.${canonicalType}`,
        );
      }
    }
    const primaryKey = columns
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => String(column.name));
    if (primaryKey.length > 0) {
      identifiers.add(`primary-key:${tableName}.${primaryKey.join(".")}`);
    }
  }
  for (const row of objects.filter((entry) => entry.type === "index")) {
    identifiers.add(`index:${String(row.table_name)}.${String(row.name)}`);
    addUniqueIndexProofs(identifiers, {
      tableName: row.table_name,
      definition: row.sql,
    });
  }
  for (const row of objects.filter((entry) => entry.type === "trigger")) {
    identifiers.add(`trigger:${String(row.table_name)}.${String(row.name)}`);
  }
  for (const tableName of sqliteAppendOnlyTables(
    objects,
    exactAppendOnlyUniqueIndexTables,
  )) {
    identifiers.add(`append-only:${tableName}`);
  }
  return { entries: entries.sort(), identifiers };
}

export async function verifyReleaseMigrationSchema(
  client: Knex | Knex.Transaction,
  requiredConstraints: readonly string[],
  signal?: AbortSignal,
): Promise<MigrationSchemaVerification> {
  abortIfNeeded(signal);
  const clientName = databaseClientName(client);
  const catalog = ["pg", "postgres", "postgresql"].includes(clientName)
    ? await postgresCatalog(client)
    : ["sqlite3", "better-sqlite3"].includes(clientName)
      ? await sqliteCatalog(client)
      : invariant("MIGRATION_SCHEMA_VERIFICATION_FAILED", "unsupported database client");
  abortIfNeeded(signal);
  const fingerprint = crypto
    .createHash("sha256")
    .update(catalog.entries.join("\n"))
    .digest("hex");
  return {
    fingerprint,
    validatedConstraints: requiredConstraints
      .filter((constraint) => catalog.identifiers.has(constraint))
      .sort(),
  };
}

interface BackupCheckpointDocument {
  format: typeof RELEASE_MIGRATION_BACKUP_CHECKPOINT_FORMAT;
  runId: string;
  checkpointId: string;
  artifactSha256: string;
  backupSha256: string;
  backupSize: number;
  sourceCommit: string;
  schemaVersion: number;
  checksumChain: string;
  schemaFingerprint: string;
  verifiedAt: number;
  expiresAt: number;
  remoteCopyVerified: true;
  remoteObjectIdentitySha256: string;
  remoteObjectVersionId: string;
  remoteRetentionMode: "COMPLIANCE";
  remoteRetainUntil: number;
  restoreDrillId: string;
  restoreDatabaseIdentitySha256: string;
  restoreDataSummarySha256: string;
  restoreRpoMs: number;
  restoreRtoMs: number;
  sourceDatabaseIdentitySha256: string;
}

function checkpointFileName(runId: string): string {
  return `${crypto.createHash("sha256").update(runId).digest("hex")}.json`;
}

function checkpointMetadataIsUnsafe(
  metadata: Stats,
  currentUid: number,
  expectedKind: "directory" | "file",
): boolean {
  const hasExpectedKind = expectedKind === "directory"
    ? metadata.isDirectory()
    : metadata.isFile();
  return (
    !hasExpectedKind
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o022) !== 0
    || (expectedKind === "file" && (metadata.mode & 0o777) !== 0o600)
    || (metadata.uid !== 0 && metadata.uid !== currentUid)
    || (expectedKind === "file" && metadata.nlink !== 1)
  );
}

async function safeCheckpointLstat(
  targetPath: string,
): Promise<Stats> {
  try {
    return await fs.lstat(targetPath);
  } catch {
    return invariant(
      "MIGRATION_BACKUP_CHECKPOINT_INVALID",
      "checkpoint evidence is unavailable",
    );
  }
}

async function safeCheckpointRealpath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return invariant(
      "MIGRATION_BACKUP_CHECKPOINT_INVALID",
      "checkpoint directory cannot be resolved safely",
    );
  }
}

async function readBackupCheckpointDocument(
  directory: string,
  context: MigrationSafetyContext,
  artifactSha256: string,
  signal?: AbortSignal,
): Promise<VerifiedMigrationBackupCheckpoint> {
  abortIfNeeded(signal);
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "checkpoint directory is not absolute");
  }
  if (typeof process.getuid !== "function") {
    invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "controller uid is unavailable");
  }
  const currentUid = process.getuid();
  const directoryStat = await safeCheckpointLstat(directory);
  if (
    checkpointMetadataIsUnsafe(
      directoryStat,
      currentUid,
      "directory",
    )
  ) {
    invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "checkpoint directory is unsafe");
  }
  const canonicalDirectory = await safeCheckpointRealpath(directory);
  const canonicalDirectoryStat = await safeCheckpointLstat(canonicalDirectory);
  if (
    checkpointMetadataIsUnsafe(
      canonicalDirectoryStat,
      currentUid,
      "directory",
    )
    || canonicalDirectoryStat.dev !== directoryStat.dev
    || canonicalDirectoryStat.ino !== directoryStat.ino
  ) {
    invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "checkpoint directory is unsafe");
  }
  const checkpointPath = path.join(canonicalDirectory, checkpointFileName(context.runId));
  const entryStat = await safeCheckpointLstat(checkpointPath);
  if (
    checkpointMetadataIsUnsafe(
      entryStat,
      currentUid,
      "file",
    )
    || entryStat.size < 2
    || entryStat.size > MAX_CHECKPOINT_BYTES
  ) {
    invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "checkpoint file metadata is unsafe");
  }
  const noFollowFlag = fs.constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollowFlag) || noFollowFlag === 0) {
    invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "safe checkpoint open is unsupported");
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      checkpointPath,
      fs.constants.O_RDONLY | noFollowFlag,
    );
  } catch {
    return invariant(
      "MIGRATION_BACKUP_CHECKPOINT_INVALID",
      "checkpoint evidence cannot be opened safely",
    );
  }
  try {
    let metadata: Stats;
    try {
      metadata = await handle.stat();
    } catch {
      return invariant(
        "MIGRATION_BACKUP_CHECKPOINT_INVALID",
        "checkpoint file metadata is unavailable",
      );
    }
    if (
      checkpointMetadataIsUnsafe(
        metadata,
        currentUid,
        "file",
      )
      || metadata.dev !== entryStat.dev
      || metadata.ino !== entryStat.ino
      || metadata.size < 2
      || metadata.size > MAX_CHECKPOINT_BYTES
    ) {
      invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "checkpoint file metadata is unsafe");
    }
    abortIfNeeded(signal);
    let raw: string;
    try {
      raw = await handle.readFile({ encoding: "utf8" });
    } catch {
      return invariant(
        "MIGRATION_BACKUP_CHECKPOINT_INVALID",
        "checkpoint evidence cannot be read safely",
      );
    }
    abortIfNeeded(signal);
    let document: BackupCheckpointDocument;
    try {
      document = JSON.parse(raw) as BackupCheckpointDocument;
    } catch {
      invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "checkpoint file is not valid JSON");
    }
    const observedAt = Date.now();
    const expectedKeys = [
      "artifactSha256",
      "backupSha256",
      "backupSize",
      "checkpointId",
      "checksumChain",
      "expiresAt",
      "format",
      "remoteCopyVerified",
      "remoteObjectIdentitySha256",
      "remoteObjectVersionId",
      "remoteRetainUntil",
      "remoteRetentionMode",
      "restoreDataSummarySha256",
      "restoreDatabaseIdentitySha256",
      "restoreDrillId",
      "restoreRpoMs",
      "restoreRtoMs",
      "runId",
      "schemaFingerprint",
      "schemaVersion",
      "sourceCommit",
      "sourceDatabaseIdentitySha256",
      "verifiedAt",
    ];
    if (
      !document
      || typeof document !== "object"
      || Array.isArray(document)
      || Object.keys(document).sort().join("\0") !== expectedKeys.join("\0")
      || document.format !== RELEASE_MIGRATION_BACKUP_CHECKPOINT_FORMAT
      || document.runId !== context.runId
      || !SAFE_ID_RE.test(String(document.checkpointId || ""))
      || document.artifactSha256 !== artifactSha256
      || !SHA256_RE.test(String(document.backupSha256 || ""))
      || !Number.isSafeInteger(document.backupSize)
      || document.backupSize < 1
      || document.sourceCommit !== context.sourceCommit
      || document.schemaVersion !== context.fromVersion
      || document.checksumChain !== context.appliedChecksumChain
      || !SHA256_RE.test(String(document.schemaFingerprint || ""))
      || !Number.isSafeInteger(document.verifiedAt)
      || !Number.isSafeInteger(document.expiresAt)
      || document.verifiedAt > observedAt + CLOCK_SKEW_MS
      || document.verifiedAt < observedAt - MAX_CHECKPOINT_AGE_MS
      || document.expiresAt <= observedAt
      || document.expiresAt <= document.verifiedAt
      || document.expiresAt > document.verifiedAt + MAX_CHECKPOINT_AGE_MS
      || document.remoteCopyVerified !== true
      || !SHA256_RE.test(String(document.remoteObjectIdentitySha256 || ""))
      || typeof document.remoteObjectVersionId !== "string"
      || document.remoteObjectVersionId.length < 1
      || document.remoteObjectVersionId.length > 1024
      || /[\0\r\n]/u.test(document.remoteObjectVersionId)
      || document.remoteRetentionMode !== "COMPLIANCE"
      || !Number.isSafeInteger(document.remoteRetainUntil)
      || document.remoteRetainUntil < document.expiresAt
      || !SAFE_ID_RE.test(String(document.restoreDrillId || ""))
      || !SHA256_RE.test(String(document.restoreDatabaseIdentitySha256 || ""))
      || !SHA256_RE.test(String(document.restoreDataSummarySha256 || ""))
      || !SHA256_RE.test(String(document.sourceDatabaseIdentitySha256 || ""))
      || !Number.isSafeInteger(document.restoreRpoMs)
      || document.restoreRpoMs < 0
      || document.restoreRpoMs > 30 * 24 * 60 * 60_000
      || !Number.isSafeInteger(document.restoreRtoMs)
      || document.restoreRtoMs < 0
      || document.restoreRtoMs > 30 * 24 * 60 * 60_000
    ) {
      invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "checkpoint evidence does not match migration");
    }
    const [finalDirectoryStat, finalEntryStat] = await Promise.all([
      safeCheckpointLstat(canonicalDirectory),
      safeCheckpointLstat(checkpointPath),
    ]);
    let finalOpenedStat: Stats;
    try {
      finalOpenedStat = await handle.stat();
    } catch {
      return invariant(
        "MIGRATION_BACKUP_CHECKPOINT_INVALID",
        "checkpoint file metadata changed during validation",
      );
    }
    if (
      checkpointMetadataIsUnsafe(
        finalDirectoryStat,
        currentUid,
        "directory",
      )
      || finalDirectoryStat.dev !== canonicalDirectoryStat.dev
      || finalDirectoryStat.ino !== canonicalDirectoryStat.ino
      || checkpointMetadataIsUnsafe(finalEntryStat, currentUid, "file")
      || checkpointMetadataIsUnsafe(finalOpenedStat, currentUid, "file")
      || finalEntryStat.dev !== entryStat.dev
      || finalEntryStat.ino !== entryStat.ino
      || finalEntryStat.size !== entryStat.size
      || finalEntryStat.mtimeMs !== entryStat.mtimeMs
      || finalOpenedStat.dev !== entryStat.dev
      || finalOpenedStat.ino !== entryStat.ino
      || finalOpenedStat.size !== entryStat.size
      || finalOpenedStat.mtimeMs !== entryStat.mtimeMs
      || document.expiresAt <= Date.now()
    ) {
      invariant("MIGRATION_BACKUP_CHECKPOINT_INVALID", "checkpoint evidence changed during validation");
    }
    abortIfNeeded(signal);
    return {
      checkpointId: document.checkpointId,
      sourceCommit: document.sourceCommit,
      schemaVersion: document.schemaVersion,
      checksumChain: document.checksumChain,
      schemaFingerprint: document.schemaFingerprint,
      evidenceDigest: crypto.createHash("sha256").update(raw).digest("hex"),
      verifiedAt: document.verifiedAt,
    };
  } finally {
    try {
      await handle.close();
    } catch {
      invariant(
        "MIGRATION_BACKUP_CHECKPOINT_INVALID",
        "checkpoint evidence cannot be closed safely",
      );
    }
  }
}

function approvedPendingConstraints(
  definitions: readonly DatabaseMigration[],
  request: ReleaseSchemaMigrationRequest,
): { before: string[]; after: string[] } {
  if (
    request.fromVersion < 1
    || request.toVersion <= request.fromVersion
    || definitions.length !== request.toVersion
    || definitions.some((definition, index) => definition.version !== index + 1)
  ) {
    invariant(
      "SCHEMA_MIGRATION_DEFINITION_ALLOWLIST_MISMATCH",
      "reviewed migration definitions do not exactly match the release contract",
    );
  }
  const before = definitions
    .slice(0, request.fromVersion)
    .flatMap((definition) => [...(definition.requiredConstraints || [])]);
  const pendingDefinitions = definitions.slice(request.fromVersion);
  const pending = pendingDefinitions
    .flatMap((definition) => [...(definition.requiredConstraints || [])]);
  const after = [...before, ...pending];
  if (
    pendingDefinitions.length === 0
    || after.length > MAX_REQUIRED_CONSTRAINTS
    || new Set(after).size !== after.length
    || after.some((constraint) => !REQUIRED_CONSTRAINT_RE.test(constraint))
    || pendingDefinitions.some((definition) => (
      !definition.requiredConstraints?.length
      && !isReviewedConstraintlessDatabaseMigration(definition)
    ))
  ) {
    invariant(
      "SCHEMA_MIGRATION_DEFINITION_ALLOWLIST_MISSING",
      "every pending migration must declare reviewed requiredConstraints",
    );
  }
  return { before: before.sort(), after: after.sort() };
}

function migrationDefinitionChecksumChain(
  definitions: readonly DatabaseMigration[],
): string {
  return crypto
    .createHash("sha256")
    .update(definitions.map(({ version, name, checksum }) => (
      `${version}:${name}:${checksum}`
    )).join("\n"))
    .digest("hex");
}

function safeInteger(value: unknown): number | null {
  if (
    typeof value !== "number"
    && (typeof value !== "string" || !/^-?\d+$/.test(value))
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeFailureCode(value: unknown): boolean {
  return typeof value === "string" && /^MIGRATION_[A-Z0-9_]{3,96}$/.test(value);
}

function safeFailureMessage(value: unknown): boolean {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\0\r\n]/.test(value)
  );
}

export class KnexReleaseSchemaMigrator implements ReleaseSchemaMigrator {
  private readonly database: Knex;
  private readonly definitions: readonly DatabaseMigration[];
  private readonly sourceCommit: string;
  private readonly operatorIdentity: string;
  private readonly artifactSha256: string;
  private readonly checkpointDirectory: string;
  private readonly signal?: AbortSignal;
  private readonly timeouts?: Partial<MigrationRunnerTimeouts>;

  constructor(options: {
    database: Knex;
    /** Source commit of the running release controller. */
    sourceCommit: string;
    /** Attested source commit embedded in the immutable target artifact manifest. */
    artifactSourceCommit: string;
    operatorIdentity: string;
    artifactSha256: string;
    checkpointDirectory: string;
    migrationDefinitions?: readonly DatabaseMigration[];
    signal?: AbortSignal;
    timeouts?: Partial<MigrationRunnerTimeouts>;
  }) {
    if (
      !SOURCE_COMMIT_RE.test(options.sourceCommit)
      || !SOURCE_COMMIT_RE.test(options.artifactSourceCommit)
    ) {
      invariant("SCHEMA_MIGRATION_SOURCE_COMMIT_INVALID", "source commit is not attested");
    }
    if (options.sourceCommit !== options.artifactSourceCommit) {
      invariant(
        "SCHEMA_MIGRATION_SOURCE_COMMIT_MISMATCH",
        "controller and artifact source commits do not match",
      );
    }
    if (!SHA256_RE.test(options.artifactSha256)) {
      invariant("SCHEMA_MIGRATION_ARTIFACT_INVALID", "artifact sha256 is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(options.operatorIdentity)) {
      invariant("SCHEMA_MIGRATION_OPERATOR_INVALID", "operator identity is invalid");
    }
    this.database = options.database;
    this.definitions = options.migrationDefinitions ?? DATABASE_MIGRATIONS;
    this.sourceCommit = options.sourceCommit;
    this.operatorIdentity = options.operatorIdentity;
    this.artifactSha256 = options.artifactSha256;
    this.checkpointDirectory = options.checkpointDirectory;
    this.signal = options.signal;
    this.timeouts = options.timeouts;
  }

  private assertRequest(
    request: ReleaseSchemaMigrationRequest,
    context: ReleaseActionContext,
  ): { before: string[]; after: string[] } {
    abortIfNeeded(this.signal);
    if (
      request.artifactSha256 !== this.artifactSha256
      || context.artifactSha256 !== this.artifactSha256
      || request.runId !== context.operationId
      || !RUN_ID_RE.test(request.runId)
    ) {
      invariant("SCHEMA_MIGRATION_REQUEST_MISMATCH", "migration request identity changed");
    }
    return approvedPendingConstraints(this.definitions, request);
  }

  private async evidence(
    request: ReleaseSchemaMigrationRequest,
    requiredConstraintsAfter: readonly string[],
  ): Promise<Pick<ReleaseSchemaMigrationObservation, "runId" | "runStatus">> {
    abortIfNeeded(this.signal);
    if (!await this.database.schema.hasTable(SCHEMA_MIGRATION_RUN_TABLE)) {
      abortIfNeeded(this.signal);
      return { runId: null, runStatus: null };
    }
    abortIfNeeded(this.signal);
    const rows = await this.database<DatabaseMigrationRunEvidence>(SCHEMA_MIGRATION_RUN_TABLE)
      .where({ runId: request.runId })
      .orderBy("eventOrdinal", "asc");
    abortIfNeeded(this.signal);
    if (rows.length === 0) return { runId: null, runStatus: null };
    const expectedChecksumChain = migrationDefinitionChecksumChain(this.definitions);
    const started = rows[0];
    const startedAt = safeInteger(started?.startedAt);
    if (
      rows.length > 2
      || !started
      || Number(started.eventOrdinal) !== 0
      || started.evidenceId !== `${request.runId}:0`
      || started.status !== "started"
      || startedAt === null
      || startedAt < 1
      || started.finishedAt !== null
      || started.durationMs !== null
      || started.failedVersion !== null
      || started.failureCode !== null
      || started.safeError !== null
      || started.backupCheckpointId !== null
      || started.beforeSchemaFingerprint !== null
      || started.afterSchemaFingerprint !== null
      || rows.some((row, index) => (
        row.runId !== request.runId
        || Number(row.fromVersion) !== request.fromVersion
        || Number(row.toVersion) !== request.toVersion
        || row.sourceCommit !== this.sourceCommit
        || row.operatorIdentity !== this.operatorIdentity
        || row.checksumChain !== expectedChecksumChain
        || Number(row.eventOrdinal) !== index
        || row.evidenceId !== `${request.runId}:${index}`
      ))
    ) {
      invariant("SCHEMA_MIGRATION_EVIDENCE_MISMATCH", "migration run evidence is inconsistent");
    }
    const terminal = rows.find((row) => Number(row.eventOrdinal) === 1);
    if (!terminal) return { runId: request.runId, runStatus: "started" };
    const finishedAt = safeInteger(terminal.finishedAt);
    const durationMs = safeInteger(terminal.durationMs);
    if (
      (terminal.status !== "succeeded" && terminal.status !== "failed")
      || safeInteger(terminal.startedAt) !== startedAt
      || finishedAt === null
      || finishedAt < startedAt
      || durationMs !== finishedAt - startedAt
    ) {
      invariant("SCHEMA_MIGRATION_EVIDENCE_MISMATCH", "terminal migration evidence is invalid");
    }
    if (terminal.status === "succeeded") {
      if (
        terminal.failedVersion !== null
        || terminal.failureCode !== null
        || terminal.safeError !== null
        || !SAFE_ID_RE.test(String(terminal.backupCheckpointId || ""))
        || !SHA256_RE.test(String(terminal.beforeSchemaFingerprint || ""))
        || !SHA256_RE.test(String(terminal.afterSchemaFingerprint || ""))
      ) {
        invariant("SCHEMA_MIGRATION_EVIDENCE_MISMATCH", "terminal migration evidence is invalid");
      }
      const currentSchema = await verifyReleaseMigrationSchema(
        this.database,
        requiredConstraintsAfter,
        this.signal,
      );
      if (
        currentSchema.fingerprint !== terminal.afterSchemaFingerprint
        || currentSchema.validatedConstraints.join("\0")
          !== [...requiredConstraintsAfter].sort().join("\0")
      ) {
        invariant("SCHEMA_MIGRATION_EVIDENCE_MISMATCH", "terminal schema evidence is stale");
      }
    } else if (
      (
        terminal.failedVersion !== null
        && (
          safeInteger(terminal.failedVersion) === null
          || Number(terminal.failedVersion) <= request.fromVersion
          || Number(terminal.failedVersion) > request.toVersion
        )
      )
      || !safeFailureCode(terminal.failureCode)
      || !safeFailureMessage(terminal.safeError)
      || (
        terminal.backupCheckpointId !== null
        && !SAFE_ID_RE.test(String(terminal.backupCheckpointId))
      )
      || (
        terminal.beforeSchemaFingerprint !== null
        && !SHA256_RE.test(String(terminal.beforeSchemaFingerprint))
      )
      || (
        terminal.afterSchemaFingerprint !== null
        && !SHA256_RE.test(String(terminal.afterSchemaFingerprint))
      )
    ) {
      invariant("SCHEMA_MIGRATION_EVIDENCE_MISMATCH", "terminal migration evidence is invalid");
    }
    abortIfNeeded(this.signal);
    return { runId: request.runId, runStatus: terminal.status };
  }

  async inspect(
    request: ReleaseSchemaMigrationRequest,
    context: ReleaseActionContext,
  ): Promise<ReleaseSchemaMigrationObservation> {
    const requiredConstraints = this.assertRequest(request, context);
    const status = await inspectDatabaseMigrations(this.database, this.definitions);
    abortIfNeeded(this.signal);
    const observation = {
      schemaVersion: status.applied.at(-1)?.version ?? 0,
      latestVersion: status.latestVersion,
      ...await this.evidence(request, requiredConstraints.after),
    };
    abortIfNeeded(this.signal);
    return observation;
  }

  async apply(
    request: ReleaseSchemaMigrationRequest,
    context: ReleaseActionContext,
  ): Promise<ReleaseSchemaMigrationObservation> {
    const requiredConstraints = this.assertRequest(request, context);
    const before = await this.inspect(request, context);
    if (
      before.schemaVersion !== request.fromVersion
      || before.latestVersion !== request.toVersion
      || before.runId !== null
      || before.runStatus !== null
    ) {
      invariant("SCHEMA_MIGRATION_BASELINE_MISMATCH", "migration baseline is not pristine");
    }
    await runDatabaseMigrations(this.database, this.definitions, {
      runId: request.runId,
      sourceCommit: this.sourceCommit,
      operatorIdentity: this.operatorIdentity,
      requireSafetyHooks: true,
      requiredConstraintsBefore: requiredConstraints.before,
      requiredConstraintsAfter: requiredConstraints.after,
      signal: this.signal,
      timeouts: this.timeouts,
      hooks: {
        createVerifiedBackupCheckpoint: (context) => (
          readBackupCheckpointDocument(
            this.checkpointDirectory,
            context,
            this.artifactSha256,
            this.signal,
          )
        ),
        verifySchema: async (client, context) => verifyReleaseMigrationSchema(
          client,
          context.requiredConstraints,
          this.signal,
        ),
      },
    });
    return this.inspect(request, context);
  }
}
