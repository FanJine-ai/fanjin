import type { Knex } from "knex";

import {
  isPostgresClient,
  quoteSqlIdentifier,
  rawRows,
} from "@/lib/dbDialect";

export const USER_NAME_UNIQUE_INDEX = "idx_o_user_name_unique";
export const USER_EMAIL_LOWER_UNIQUE_INDEX =
  "idx_o_user_email_lower_unique";
export const WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE =
  "o_workspace_owner_transfer_command";
export const WORKSPACE_OWNER_TRANSFER_COMMAND_IDENTITY_INDEX =
  "idx_o_workspace_owner_transfer_command_identity";
export const WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_FUNCTION =
  "fanjin_reject_owner_transfer_command_mutation";
export const WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_TRIGGER =
  "o_workspace_owner_transfer_command_immutable";
export const WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_UPDATE_TRIGGER =
  `${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}_immutable_update`;
export const WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_DELETE_TRIGGER =
  `${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}_immutable_delete`;
export const WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_INSERT_GUARD_TRIGGER =
  `${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}_immutable_insert_guard`;

export const WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS = [
  "id",
  "workspaceId",
  "actorUserId",
  "idempotencyKey",
  "payloadHash",
  "action",
  "formerOwnerUserId",
  "targetUserId",
  "formerOwnerRole",
  "resultJson",
  "createdAt",
] as const;

export const WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMN_TYPES = Object.freeze({
  id: "text",
  workspaceId: "text",
  actorUserId: "bigint",
  idempotencyKey: "text",
  payloadHash: "text",
  action: "text",
  formerOwnerUserId: "bigint",
  targetUserId: "bigint",
  formerOwnerRole: "text",
  resultJson: "text",
  createdAt: "bigint",
} satisfies Record<
  (typeof WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS)[number],
  "text" | "bigint"
>);

export const IDENTITY_AUTHORITY_REQUIRED_CONSTRAINTS = [
  "unique-column:o_user.name",
  "unique-normalized:o_user.email",
  `table:${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}`,
  `primary-key:${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}.id`,
  ...WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS.map(
    (columnName) =>
      `not-null:${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}.${columnName}`,
  ),
  ...WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS.map(
    (columnName) =>
      `type:${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}.${columnName}.${WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMN_TYPES[columnName]}`,
  ),
  `unique-tuple:${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}.workspaceId.actorUserId.idempotencyKey`,
  `append-only:${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}`,
] as const;

async function requireUserIdentityColumns(
  trx: Knex.Transaction,
): Promise<void> {
  if (!(await trx.schema.hasTable("o_user"))) {
    throw new Error(
      "Migration identity_authority_integrity requires table o_user",
    );
  }
  for (const columnName of ["id", "name", "email"]) {
    if (!(await trx.schema.hasColumn("o_user", columnName))) {
      throw new Error(
        `Migration identity_authority_integrity requires column o_user.${columnName}`,
      );
    }
  }
}

async function assertNoDuplicateUserPrincipals(
  trx: Knex.Transaction,
): Promise<void> {
  const duplicateName = await trx("o_user")
    .whereNotNull("name")
    .select("name")
    .count({ total: "*" })
    .groupBy("name")
    .havingRaw("COUNT(*) > 1")
    .first();
  if (duplicateName) {
    throw new Error(
      "Migration identity_authority_integrity blocked: duplicate user names must be resolved before release",
    );
  }

  const duplicateEmail = await trx("o_user")
    .whereNotNull("email")
    .select(trx.raw('lower("email") AS "normalizedEmail"'))
    .count({ total: "*" })
    .groupByRaw('lower("email")')
    .havingRaw("COUNT(*) > 1")
    .first();
  if (duplicateEmail) {
    throw new Error(
      "Migration identity_authority_integrity blocked: duplicate normalized user emails must be resolved before release",
    );
  }
}

async function dropIndexOnlyFromExpectedTable(
  trx: Knex.Transaction,
  indexName: string,
  tableName: string,
): Promise<void> {
  const owners = isPostgresClient(trx)
    ? rawRows<{ table_name: string }>(await trx.raw(
      `SELECT table_relation.relname AS table_name
         FROM pg_catalog.pg_class AS index_relation
         JOIN pg_catalog.pg_index AS index_entry
           ON index_entry.indexrelid = index_relation.oid
         JOIN pg_catalog.pg_class AS table_relation
           ON table_relation.oid = index_entry.indrelid
         JOIN pg_catalog.pg_namespace AS namespace_row
           ON namespace_row.oid = index_relation.relnamespace
        WHERE namespace_row.nspname = current_schema()
          AND index_relation.relname = ?`,
      [indexName],
    ))
    : rawRows<{ table_name: string }>(await trx.raw(
      `SELECT tbl_name AS table_name
         FROM sqlite_master
        WHERE type = 'index'
          AND name = ?`,
      [indexName],
    ));
  if (
    owners.length > 1
    || (owners.length === 1 && owners[0]?.table_name !== tableName)
  ) {
    throw new Error(
      `Migration identity_authority_integrity blocked: index ${indexName} belongs to an unexpected table`,
    );
  }
  await trx.raw(
    `DROP INDEX IF EXISTS ${quoteSqlIdentifier(indexName)}`,
  );
}

async function createUserIdentityIndexes(
  trx: Knex.Transaction,
): Promise<void> {
  await dropIndexOnlyFromExpectedTable(
    trx,
    USER_NAME_UNIQUE_INDEX,
    "o_user",
  );
  await trx.raw(
    `CREATE UNIQUE INDEX ${quoteSqlIdentifier(USER_NAME_UNIQUE_INDEX)}
       ON ${quoteSqlIdentifier("o_user")} (${quoteSqlIdentifier("name")})`,
  );
  await dropIndexOnlyFromExpectedTable(
    trx,
    USER_EMAIL_LOWER_UNIQUE_INDEX,
    "o_user",
  );
  await trx.raw(
    `CREATE UNIQUE INDEX ${quoteSqlIdentifier(USER_EMAIL_LOWER_UNIQUE_INDEX)}
       ON ${quoteSqlIdentifier("o_user")} (lower(${quoteSqlIdentifier("email")}))
       WHERE ${quoteSqlIdentifier("email")} IS NOT NULL`,
  );
}

/**
 * Take the user-id sequence lock before the write-conflicting o_user lock.
 *
 * PostgreSQL's normal generated-id path locks the sequence before inserting
 * into o_user. Taking these locks in the opposite order lets a direct
 * nextval caller deadlock the migration. ALTER SEQUENCE is a semantic no-op
 * here, but holds the sequence relation lock until the migration transaction
 * ends. Its o_user lock is only ACCESS SHARE, so an in-flight writer can
 * finish before we attempt the stronger table lock.
 */
async function lockPostgresUserSequence(
  trx: Knex.Transaction,
): Promise<void> {
  if (!isPostgresClient(trx)) return;
  await trx.raw(`
    DO $fanjin$
    DECLARE
      sequence_name text;
      sequence_oid oid;
    BEGIN
      sequence_name := pg_get_serial_sequence(
        format('%I.%I', current_schema(), 'o_user'),
        'id'
      );
      IF sequence_name IS NULL THEN
        RETURN;
      END IF;
      sequence_oid := sequence_name::regclass;

      /*
       * Reasserting the existing serial ownership is deliberately a semantic
       * no-op. It serializes the later read/repair with direct nextval callers
       * before this transaction attempts its write-conflicting o_user lock.
       */
      EXECUTE format(
        'ALTER SEQUENCE %s OWNED BY %I.%I.%I',
        sequence_oid::regclass,
        current_schema(),
        'o_user',
        'id'
      );
    END;
    $fanjin$
  `);
}

async function repairPostgresUserSequence(
  trx: Knex.Transaction,
): Promise<void> {
  if (!isPostgresClient(trx)) return;
  await trx.raw(`
    DO $fanjin$
    DECLARE
      sequence_name text;
      sequence_oid oid;
      sequence_increment bigint;
      sequence_minimum bigint;
      sequence_maximum bigint;
      sequence_cycles boolean;
      sequence_last_value bigint;
      sequence_is_called boolean;
      maximum_user_id bigint;
      current_next_value numeric;
      repaired_next_value numeric;
    BEGIN
      sequence_name := pg_get_serial_sequence(
        format('%I.%I', current_schema(), 'o_user'),
        'id'
      );
      IF sequence_name IS NULL THEN
        RETURN;
      END IF;
      sequence_oid := sequence_name::regclass;

      SELECT seqincrement, seqmin, seqmax, seqcycle
        INTO
          sequence_increment,
          sequence_minimum,
          sequence_maximum,
          sequence_cycles
        FROM pg_catalog.pg_sequence
       WHERE seqrelid = sequence_oid;
      IF
        sequence_increment IS NULL
        OR sequence_increment <= 0
        OR sequence_cycles
      THEN
        RAISE EXCEPTION
          'identity_authority_integrity requires an ascending non-cycling o_user id sequence';
      END IF;
      EXECUTE format(
        'SELECT last_value::bigint, is_called FROM %s',
        sequence_oid::regclass
      ) INTO sequence_last_value, sequence_is_called;
      SELECT COALESCE(MAX("id"), 0)
        INTO maximum_user_id
        FROM "o_user";

      current_next_value := CASE
        WHEN sequence_is_called
          THEN sequence_last_value::numeric + sequence_increment::numeric
        ELSE sequence_last_value::numeric
      END;
      repaired_next_value := GREATEST(
        current_next_value,
        maximum_user_id::numeric + 1
      );
      IF
        current_next_value < sequence_minimum::numeric
        OR repaired_next_value > sequence_maximum::numeric
      THEN
        RAISE EXCEPTION
          'identity_authority_integrity cannot repair out-of-bounds o_user id sequence';
      END IF;

      /*
       * setval is intentionally treated as non-transactional. It is invoked
       * only when moving the next value strictly forward, after every other
       * migration validation/DDL step has succeeded. If the runner's ledger
       * insert or commit later fails, the surviving sequence state is still
       * monotonic and collision-safe.
       */
      IF repaired_next_value > current_next_value THEN
        PERFORM setval(
          sequence_oid::regclass,
          repaired_next_value::bigint,
          false
        );
      END IF;
    END;
    $fanjin$
  `);
}

async function requireOwnerTransferCommandColumns(
  trx: Knex.Transaction,
): Promise<void> {
  for (const columnName of WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS) {
    if (!(await trx.schema.hasColumn(
      WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
      columnName,
    ))) {
      throw new Error(
        `Migration identity_authority_integrity requires column ${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}.${columnName}`,
      );
    }
  }
}

async function assertOwnerTransferCommandColumnTypes(
  trx: Knex.Transaction,
): Promise<void> {
  const actualTypes = new Map<string, string>();
  if (isPostgresClient(trx)) {
    const rows = rawRows<{
      column_name: string;
      data_type: string;
      udt_name: string;
    }>(await trx.raw(
      `SELECT column_name, data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ?
        ORDER BY ordinal_position`,
      [WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE],
    ));
    for (const row of rows) {
      const type = row.data_type === "text" && row.udt_name === "text"
        ? "text"
        : row.data_type === "bigint" && row.udt_name === "int8"
          ? "bigint"
          : "";
      actualTypes.set(String(row.column_name), type);
    }
  } else {
    const rows = rawRows<{
      name: string;
      type: string;
    }>(await trx.raw(
      `SELECT name, type
         FROM pragma_table_info(?)
        ORDER BY cid`,
      [WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE],
    ));
    for (const row of rows) {
      const declaredType = String(row.type || "").trim().toLowerCase();
      actualTypes.set(
        String(row.name),
        ["text", "bigint"].includes(declaredType) ? declaredType : "",
      );
    }
  }
  if (
    actualTypes.size !== WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS.length
    || [...actualTypes.keys()].some(
      (columnName) =>
        !WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS.includes(
          columnName as (typeof WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS)[number],
        ),
    )
  ) {
    throw new Error(
      "Migration identity_authority_integrity blocked: owner-transfer command ledger has unexpected columns",
    );
  }
  for (const columnName of WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS) {
    if (
      actualTypes.get(columnName)
      !== WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMN_TYPES[columnName]
    ) {
      throw new Error(
        `Migration identity_authority_integrity blocked: column ${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}.${columnName} has a non-canonical type`,
      );
    }
  }
}

async function assertCanonicalOwnerTransferCommandRows(
  trx: Knex.Transaction,
): Promise<void> {
  const tableName = quoteSqlIdentifier(
    WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
  );
  const nullPredicate = WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS
    .map((columnName) => `${quoteSqlIdentifier(columnName)} IS NULL`)
    .join(" OR ");
  if (rawRows(await trx.raw(
    `SELECT 1 FROM ${tableName} WHERE ${nullPredicate} LIMIT 1`,
  )).length > 0) {
    throw new Error(
      "Migration identity_authority_integrity blocked: owner-transfer command rows contain NULL critical evidence",
    );
  }
  if (rawRows(await trx.raw(`
    SELECT 1
      FROM ${tableName}
     GROUP BY ${quoteSqlIdentifier("id")}
    HAVING COUNT(*) > 1
     LIMIT 1
  `)).length > 0) {
    throw new Error(
      "Migration identity_authority_integrity blocked: duplicate owner-transfer command ids",
    );
  }
  if (rawRows(await trx.raw(`
    SELECT 1
      FROM ${tableName}
     GROUP BY
       ${quoteSqlIdentifier("workspaceId")},
       ${quoteSqlIdentifier("actorUserId")},
       ${quoteSqlIdentifier("idempotencyKey")}
    HAVING COUNT(*) > 1
     LIMIT 1
  `)).length > 0) {
    throw new Error(
      "Migration identity_authority_integrity blocked: duplicate owner-transfer command identities",
    );
  }
}

async function ensurePostgresOwnerTransferCommandShape(
  trx: Knex.Transaction,
): Promise<void> {
  const tableName = quoteSqlIdentifier(
    WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
  );
  for (const columnName of WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS) {
    await trx.raw(
      `ALTER TABLE ${tableName}
       ALTER COLUMN ${quoteSqlIdentifier(columnName)} SET NOT NULL`,
    );
  }

  const primaryKeys = rawRows<{
    columns: string[];
    is_deferrable: boolean;
    is_deferred: boolean;
    is_validated: boolean;
  }>(await trx.raw(
    `SELECT
       json_agg(attribute.attname ORDER BY key_entry.ordinality)
         AS columns,
       constraint_entry.condeferrable AS is_deferrable,
       constraint_entry.condeferred AS is_deferred,
       constraint_entry.convalidated AS is_validated
     FROM pg_catalog.pg_constraint AS constraint_entry
     JOIN pg_catalog.pg_class AS relation
       ON relation.oid = constraint_entry.conrelid
     JOIN pg_catalog.pg_namespace AS namespace_row
       ON namespace_row.oid = relation.relnamespace
     CROSS JOIN LATERAL unnest(constraint_entry.conkey)
       WITH ORDINALITY AS key_entry(attnum, ordinality)
     JOIN pg_catalog.pg_attribute AS attribute
       ON attribute.attrelid = relation.oid
      AND attribute.attnum = key_entry.attnum
    WHERE namespace_row.nspname = current_schema()
      AND relation.relname = ?
      AND constraint_entry.contype = 'p'
    GROUP BY
      constraint_entry.oid,
      constraint_entry.condeferrable,
      constraint_entry.condeferred,
      constraint_entry.convalidated`,
    [WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE],
  ));
  if (primaryKeys.length === 0) {
    await trx.raw(
      `ALTER TABLE ${tableName}
       ADD CONSTRAINT ${quoteSqlIdentifier(
         `${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}_pkey`,
       )} PRIMARY KEY (${quoteSqlIdentifier("id")})`,
    );
  } else if (
    primaryKeys.length !== 1
    || primaryKeys[0]?.columns?.length !== 1
    || primaryKeys[0]?.columns?.[0] !== "id"
    || primaryKeys[0]?.is_deferrable
    || primaryKeys[0]?.is_deferred
    || !primaryKeys[0]?.is_validated
  ) {
    throw new Error(
      "Migration identity_authority_integrity blocked: owner-transfer command primary key is not exactly id",
    );
  }
}

async function ensureSqliteOwnerTransferCommandShape(
  trx: Knex.Transaction,
): Promise<void> {
  const tableShape = rawRows<{ without_rowid: number }>(await trx.raw(
    `SELECT wr AS without_rowid
       FROM pragma_table_list
      WHERE "schema" = 'main'
        AND type = 'table'
        AND name = ?`,
    [WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE],
  ));
  if (
    tableShape.length !== 1
    || Number(tableShape[0]?.without_rowid) !== 1
  ) {
    throw new Error(
      "Migration identity_authority_integrity blocked: SQLite owner-transfer command ledger must be WITHOUT ROWID",
    );
  }
  const columns = rawRows<{
    name: string;
    not_null: number;
    pk: number;
  }>(await trx.raw(
    `SELECT name, "notnull" AS not_null, pk
       FROM pragma_table_info(?)
      ORDER BY cid`,
    [WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE],
  ));
  const required = new Set<string>(
    WORKSPACE_OWNER_TRANSFER_COMMAND_COLUMNS,
  );
  const primaryKeyColumns = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk));
  if (
    primaryKeyColumns.length !== 1
    || primaryKeyColumns[0]?.name !== "id"
    || Number(primaryKeyColumns[0]?.pk) !== 1
  ) {
    throw new Error(
      "Migration identity_authority_integrity blocked: SQLite owner-transfer command primary key is not exactly id",
    );
  }
  for (const column of columns) {
    if (required.has(String(column.name)) && Number(column.not_null) !== 1) {
      throw new Error(
        `Migration identity_authority_integrity blocked: SQLite column ${WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE}.${column.name} must be NOT NULL`,
      );
    }
  }
}

async function assertSqliteOwnerTransferUniqueIndexesExact(
  trx: Knex.Transaction,
): Promise<void> {
  const indexes = rawRows<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>(await trx.raw(
    `SELECT name, "unique", origin, partial
       FROM pragma_index_list(?)
      WHERE "unique" = 1
      ORDER BY name`,
    [WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE],
  ));
  let primaryKeyFound = false;
  let identityKeyFound = false;
  for (const index of indexes) {
    const columns = rawRows<{
      cid: number;
      name: string | null;
      descending: number;
      collation: string | null;
      key_column: number;
    }>(await trx.raw(
      `SELECT
         cid,
         name,
         "desc" AS descending,
         coll AS collation,
         "key" AS key_column
       FROM pragma_index_xinfo(?)
      WHERE "key" = 1
      ORDER BY seqno`,
      [index.name],
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
      continue;
    }
    if (isIdentityKey && !identityKeyFound) {
      identityKeyFound = true;
      continue;
    }
    throw new Error(
      "Migration identity_authority_integrity blocked: SQLite owner-transfer command ledger has an unexpected unique index",
    );
  }
  if (
    indexes.length !== 2
    || !primaryKeyFound
    || !identityKeyFound
  ) {
    throw new Error(
      "Migration identity_authority_integrity failed to install the exact SQLite owner-transfer command unique indexes",
    );
  }
}

function simpleIndexColumns(indexDefinition: unknown): string[] | null {
  const definition = String(indexDefinition || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^CREATE UNIQUE INDEX\b/i.test(definition) || /\bWHERE\b/i.test(
    definition,
  )) {
    return null;
  }
  const match = definition.match(
    /\(\s*("?[_A-Za-z][_A-Za-z0-9]*"?(?:\s*,\s*"?[_A-Za-z][_A-Za-z0-9]*"?)*)\s*\)\s*;?$/,
  );
  if (!match?.[1]) return null;
  return match[1].split(",").map((columnName) => (
    columnName.trim().replace(/^"|"$/g, "")
  ));
}

async function ensureOwnerTransferCommandIdentityIndex(
  trx: Knex.Transaction,
): Promise<void> {
  const tableName = quoteSqlIdentifier(
    WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
  );
  await dropIndexOnlyFromExpectedTable(
    trx,
    WORKSPACE_OWNER_TRANSFER_COMMAND_IDENTITY_INDEX,
    WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
  );
  await trx.raw(
    `CREATE UNIQUE INDEX ${quoteSqlIdentifier(
      WORKSPACE_OWNER_TRANSFER_COMMAND_IDENTITY_INDEX,
    )}
       ON ${tableName} (
         ${quoteSqlIdentifier("workspaceId")},
         ${quoteSqlIdentifier("actorUserId")},
         ${quoteSqlIdentifier("idempotencyKey")}
       )`,
  );

  let definition: unknown;
  let unique = false;
  let valid = true;
  if (isPostgresClient(trx)) {
    const rows = rawRows<{
      index_definition: string;
      is_unique: boolean;
      is_valid: boolean;
      is_ready: boolean;
    }>(await trx.raw(
      `SELECT
         pg_get_indexdef(index_entry.indexrelid) AS index_definition,
         index_entry.indisunique AS is_unique,
         index_entry.indisvalid AS is_valid,
         index_entry.indisready AS is_ready
       FROM pg_catalog.pg_index AS index_entry
       JOIN pg_catalog.pg_class AS table_relation
         ON table_relation.oid = index_entry.indrelid
       JOIN pg_catalog.pg_class AS index_relation
         ON index_relation.oid = index_entry.indexrelid
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = table_relation.relnamespace
      WHERE namespace_row.nspname = current_schema()
        AND table_relation.relname = ?
        AND index_relation.relname = ?`,
      [
        WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
        WORKSPACE_OWNER_TRANSFER_COMMAND_IDENTITY_INDEX,
      ],
    ));
    definition = rows[0]?.index_definition;
    unique = rows.length === 1 && rows[0]?.is_unique === true;
    valid = rows[0]?.is_valid === true && rows[0]?.is_ready === true;
  } else {
    const indexes = rawRows<{
      name: string;
      unique: number;
    }>(await trx.raw(
      `SELECT name, "unique"
         FROM pragma_index_list(?)`,
      [WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE],
    ));
    const index = indexes.find(
      (candidate) =>
        candidate.name === WORKSPACE_OWNER_TRANSFER_COMMAND_IDENTITY_INDEX,
    );
    const rows = rawRows<{ sql: string }>(await trx.raw(
      `SELECT sql
         FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = ?
          AND name = ?`,
      [
        WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
        WORKSPACE_OWNER_TRANSFER_COMMAND_IDENTITY_INDEX,
      ],
    ));
    definition = rows[0]?.sql;
    unique = Number(index?.unique) === 1;
  }
  if (
    !unique
    || !valid
    || JSON.stringify(simpleIndexColumns(definition))
      !== JSON.stringify(["workspaceId", "actorUserId", "idempotencyKey"])
  ) {
    throw new Error(
      "Migration identity_authority_integrity failed to install the exact owner-transfer command identity constraint",
    );
  }
}

async function createOwnerTransferCommandLedger(
  trx: Knex.Transaction,
): Promise<void> {
  if (!(await trx.schema.hasTable(WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE))) {
    if (isPostgresClient(trx)) {
      await trx.schema.createTable(
        WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
        (table) => {
          table.text("id").notNullable().primary();
          table.text("workspaceId").notNullable();
          table.bigInteger("actorUserId").notNullable();
          table.text("idempotencyKey").notNullable();
          table.text("payloadHash").notNullable();
          table.text("action").notNullable();
          table.bigInteger("formerOwnerUserId").notNullable();
          table.bigInteger("targetUserId").notNullable();
          table.text("formerOwnerRole").notNullable();
          table.text("resultJson").notNullable();
          table.bigInteger("createdAt").notNullable();
        },
      );
    } else {
      /*
       * A rowid table has a hidden uniqueness conflict that SQLite REPLACE
       * can use to delete an evidence row without firing DELETE triggers.
       * WITHOUT ROWID leaves only the two explicitly verified unique keys.
       */
      await trx.raw(`
        CREATE TABLE ${quoteSqlIdentifier(
          WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
        )} (
          ${quoteSqlIdentifier("id")} text NOT NULL PRIMARY KEY,
          ${quoteSqlIdentifier("workspaceId")} text NOT NULL,
          ${quoteSqlIdentifier("actorUserId")} bigint NOT NULL,
          ${quoteSqlIdentifier("idempotencyKey")} text NOT NULL,
          ${quoteSqlIdentifier("payloadHash")} text NOT NULL,
          ${quoteSqlIdentifier("action")} text NOT NULL,
          ${quoteSqlIdentifier("formerOwnerUserId")} bigint NOT NULL,
          ${quoteSqlIdentifier("targetUserId")} bigint NOT NULL,
          ${quoteSqlIdentifier("formerOwnerRole")} text NOT NULL,
          ${quoteSqlIdentifier("resultJson")} text NOT NULL,
          ${quoteSqlIdentifier("createdAt")} bigint NOT NULL
        ) WITHOUT ROWID
      `);
    }
  }
  await requireOwnerTransferCommandColumns(trx);
  await assertOwnerTransferCommandColumnTypes(trx);
  await assertCanonicalOwnerTransferCommandRows(trx);
  if (isPostgresClient(trx)) {
    await ensurePostgresOwnerTransferCommandShape(trx);
  } else {
    await ensureSqliteOwnerTransferCommandShape(trx);
  }
  await ensureOwnerTransferCommandIdentityIndex(trx);
  if (!isPostgresClient(trx)) {
    await assertSqliteOwnerTransferUniqueIndexesExact(trx);
  }
}

function normalizeSqlDefinition(value: unknown): string {
  return String(value || "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    .toLowerCase();
}

function sqliteOwnerTransferTriggerSql(): Record<string, string> {
  const tableName = quoteSqlIdentifier(
    WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
  );
  return {
    [WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_UPDATE_TRIGGER]: `
      CREATE TRIGGER ${quoteSqlIdentifier(
        WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_UPDATE_TRIGGER,
      )}
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(
          ABORT,
          'workspace owner transfer command evidence is immutable'
        );
      END
    `,
    [WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_DELETE_TRIGGER]: `
      CREATE TRIGGER ${quoteSqlIdentifier(
        WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_DELETE_TRIGGER,
      )}
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(
          ABORT,
          'workspace owner transfer command evidence is immutable'
        );
      END
    `,
    [WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_INSERT_GUARD_TRIGGER]: `
      CREATE TRIGGER ${quoteSqlIdentifier(
        WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_INSERT_GUARD_TRIGGER,
      )}
      BEFORE INSERT ON ${tableName}
      WHEN EXISTS (
        SELECT 1
          FROM ${tableName}
         WHERE ${quoteSqlIdentifier("id")} = NEW.${quoteSqlIdentifier("id")}
            OR (
              ${quoteSqlIdentifier("workspaceId")}
                = NEW.${quoteSqlIdentifier("workspaceId")}
              AND ${quoteSqlIdentifier("actorUserId")}
                = NEW.${quoteSqlIdentifier("actorUserId")}
              AND ${quoteSqlIdentifier("idempotencyKey")}
                = NEW.${quoteSqlIdentifier("idempotencyKey")}
            )
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'workspace owner transfer command evidence is immutable'
        );
      END
    `,
  };
}

async function assertOwnerTransferLedgerImmutability(
  trx: Knex.Transaction,
): Promise<void> {
  if (isPostgresClient(trx)) {
    const rows = rawRows<{
      trigger_enabled: string;
      trigger_type: number;
      function_source: string;
      security_definer: boolean;
      volatility: string;
    }>(await trx.raw(
      `SELECT
         trigger_entry.tgenabled AS trigger_enabled,
         trigger_entry.tgtype::integer AS trigger_type,
         function_entry.prosrc AS function_source,
         function_entry.prosecdef AS security_definer,
         function_entry.provolatile AS volatility
       FROM pg_catalog.pg_trigger AS trigger_entry
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = trigger_entry.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = relation.relnamespace
       JOIN pg_catalog.pg_proc AS function_entry
         ON function_entry.oid = trigger_entry.tgfoid
      WHERE namespace_row.nspname = current_schema()
        AND relation.relname = ?
        AND trigger_entry.tgname = ?
        AND function_entry.proname = ?
        AND NOT trigger_entry.tgisinternal`,
      [
        WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
        WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_TRIGGER,
        WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_FUNCTION,
      ],
    ));
    const triggerType = Number(rows[0]?.trigger_type);
    const functionSource = normalizeSqlDefinition(
      rows[0]?.function_source,
    );
    if (
      rows.length !== 1
      || rows[0]?.trigger_enabled !== "O"
      || (triggerType & 1) !== 0
      || (triggerType & 2) !== 2
      || (triggerType & 4) !== 0
      || (triggerType & 8) !== 8
      || (triggerType & 16) !== 16
      || (triggerType & 32) !== 32
      || rows[0]?.security_definer
      || rows[0]?.volatility !== "v"
      || functionSource !== normalizeSqlDefinition(`
        BEGIN
          RAISE EXCEPTION
            'workspace owner transfer command evidence is immutable'
            USING ERRCODE = '55000';
        END
      `)
    ) {
      throw new Error(
        "Migration identity_authority_integrity failed to install the exact PostgreSQL owner-transfer immutability trigger",
      );
    }
    return;
  }

  const expectedDefinitions = sqliteOwnerTransferTriggerSql();
  const rows = rawRows<{ name: string; sql: string }>(await trx.raw(
    `SELECT name, sql
       FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name = ?
        AND name IN (?, ?, ?)
      ORDER BY name`,
    [
      WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
      WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_UPDATE_TRIGGER,
      WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_DELETE_TRIGGER,
      WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_INSERT_GUARD_TRIGGER,
    ],
  ));
  if (
    rows.length !== 3
    || rows.some((row) => (
      normalizeSqlDefinition(row.sql)
      !== normalizeSqlDefinition(expectedDefinitions[row.name])
    ))
  ) {
    throw new Error(
      "Migration identity_authority_integrity failed to install the exact SQLite owner-transfer immutability triggers",
    );
  }
}

async function installOwnerTransferLedgerImmutability(
  trx: Knex.Transaction,
): Promise<void> {
  const tableName = quoteSqlIdentifier(
    WORKSPACE_OWNER_TRANSFER_COMMAND_TABLE,
  );
  if (isPostgresClient(trx)) {
    const functionName = quoteSqlIdentifier(
      WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_FUNCTION,
    );
    const triggerName = quoteSqlIdentifier(
      WORKSPACE_OWNER_TRANSFER_COMMAND_IMMUTABLE_TRIGGER,
    );
    await trx.raw(`
      CREATE OR REPLACE FUNCTION ${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      VOLATILE
      SECURITY INVOKER
      PARALLEL UNSAFE
      AS $fanjin$
      BEGIN
        RAISE EXCEPTION
          'workspace owner transfer command evidence is immutable'
          USING ERRCODE = '55000';
      END;
      $fanjin$
    `);
    await trx.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName}`);
    await trx.raw(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OR DELETE OR TRUNCATE ON ${tableName}
      FOR EACH STATEMENT
      EXECUTE FUNCTION ${functionName}()
    `);
    await assertOwnerTransferLedgerImmutability(trx);
    return;
  }

  const triggerDefinitions = sqliteOwnerTransferTriggerSql();
  for (const [triggerName, definition] of Object.entries(
    triggerDefinitions,
  )) {
    await trx.raw(
      `DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(triggerName)}`,
    );
    await trx.raw(definition);
  }
  await assertOwnerTransferLedgerImmutability(trx);
}

/**
 * Forward-only identity and workspace-authority integrity boundary.
 *
 * PostgreSQL takes a write-conflicting table lock before the duplicate
 * preflight so no register/profile/OAuth writer can slip between validation
 * and index creation. SQLite's migration runner already owns its write lock.
 */
export async function upIdentityAuthorityIntegrity(
  trx: Knex.Transaction,
): Promise<void> {
  await requireUserIdentityColumns(trx);
  if (isPostgresClient(trx)) {
    await lockPostgresUserSequence(trx);
    await trx.raw(
      `LOCK TABLE ${quoteSqlIdentifier("o_user")}
       IN SHARE ROW EXCLUSIVE MODE NOWAIT`,
    );
  }
  await assertNoDuplicateUserPrincipals(trx);
  await createUserIdentityIndexes(trx);
  await createOwnerTransferCommandLedger(trx);
  await installOwnerTransferLedgerImmutability(trx);
  await repairPostgresUserSequence(trx);
}

export async function downIdentityAuthorityIntegrity(): Promise<void> {
  throw new Error(
    "Migration identity_authority_integrity cannot be rolled back safely because removing identity uniqueness or durable owner-transfer commands would reopen authorization ambiguity.",
  );
}
