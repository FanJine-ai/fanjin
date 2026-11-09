import type { Knex } from "knex";

import { isPostgresClient, rawRows } from "@/lib/dbDialect";

export interface RuntimeSchemaTableContract {
  name: string;
  columns: readonly string[];
}

export interface RuntimeSchemaIndexContract {
  name: string;
  table: string;
  unique: boolean;
  columns: readonly string[];
  predicate: string | null;
}

export interface RuntimeSchemaContract {
  errorCode: string;
  label: string;
  tables: readonly RuntimeSchemaTableContract[];
  indexes: readonly RuntimeSchemaIndexContract[];
}

export class RuntimeSchemaVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeSchemaVerificationError";
    this.code = code;
  }
}

function stableArray(value: readonly string[]): string {
  return JSON.stringify([...value]);
}

function normalizedSql(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function invalid(contract: RuntimeSchemaContract): never {
  throw new RuntimeSchemaVerificationError(
    contract.errorCode,
    `${contract.label} runtime schema is not prepared by the trusted migration`,
  );
}

/**
 * Verify a migration-owned PostgreSQL runtime contract without attempting any
 * CREATE/ALTER/repair statement. Production application roles deliberately do
 * not own tables, so lazy `CREATE INDEX IF NOT EXISTS` is not a safe no-op.
 */
export async function verifyPostgresRuntimeSchema(
  database: Knex | Knex.Transaction,
  contract: RuntimeSchemaContract,
): Promise<void> {
  if (!isPostgresClient(database)) return;

  try {
    const tableNames = contract.tables.map((table) => table.name);
    const columnResult = await database.raw(
      `select cls.relname as "tableName", att.attname as "columnName"
         from pg_catalog.pg_class cls
         join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
         join pg_catalog.pg_attribute att on att.attrelid = cls.oid
        where nsp.nspname = current_schema()
          and cls.relkind in ('r', 'p')
          and cls.relname = any(?::text[])
          and att.attnum > 0
          and not att.attisdropped`,
      [tableNames],
    );
    const columnsByTable = new Map<string, Set<string>>();
    for (const row of rawRows<Record<string, unknown>>(columnResult)) {
      const tableName = String(row.tableName ?? "");
      const columns = columnsByTable.get(tableName) ?? new Set<string>();
      columns.add(String(row.columnName ?? ""));
      columnsByTable.set(tableName, columns);
    }
    for (const table of contract.tables) {
      const actual = columnsByTable.get(table.name);
      if (!actual || table.columns.some((column) => !actual.has(column))) {
        invalid(contract);
      }
    }

    const indexNames = contract.indexes.map((index) => index.name);
    const indexResult = await database.raw(
      `select idx.relname as "indexName",
              tbl.relname as "tableName",
              ind.indisunique as "isUnique",
              ind.indisvalid as "isValid",
              ind.indisready as "isReady",
              array(
                select pg_get_indexdef(ind.indexrelid, ordinal, true)
                  from generate_series(1, ind.indnkeyatts) ordinal
                 order by ordinal
              ) as columns,
              pg_get_expr(ind.indpred, ind.indrelid, true) as predicate
         from pg_catalog.pg_index ind
         join pg_catalog.pg_class idx on idx.oid = ind.indexrelid
         join pg_catalog.pg_class tbl on tbl.oid = ind.indrelid
         join pg_catalog.pg_namespace nsp on nsp.oid = tbl.relnamespace
        where nsp.nspname = current_schema()
          and idx.relname = any(?::text[])`,
      [indexNames],
    );
    const indexes = new Map<string, Record<string, unknown>>();
    for (const row of rawRows<Record<string, unknown>>(indexResult)) {
      indexes.set(String(row.indexName ?? ""), row);
    }
    for (const expected of contract.indexes) {
      const actual = indexes.get(expected.name);
      const columns = Array.isArray(actual?.columns)
        ? actual.columns.map((column) => String(column).replaceAll('"', ""))
        : [];
      if (
        !actual
        || String(actual.tableName ?? "") !== expected.table
        || Boolean(actual.isUnique) !== expected.unique
        || actual.isValid !== true
        || actual.isReady !== true
        || stableArray(columns) !== stableArray(expected.columns)
        || normalizedSql(actual.predicate) !== normalizedSql(expected.predicate)
      ) {
        invalid(contract);
      }
    }
  } catch (error) {
    if (error instanceof RuntimeSchemaVerificationError) throw error;
    invalid(contract);
  }
}
