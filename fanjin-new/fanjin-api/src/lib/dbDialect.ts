import type { Knex } from "knex";

export type SupportedDatabaseClient = "sqlite" | "postgres";

export interface DbIndexRow {
  name: string;
  unique?: number | boolean;
}

export function normalizeDatabaseClient(raw = process.env.FANJIN_DATABASE_CLIENT): SupportedDatabaseClient {
  const value = String(raw || "sqlite").trim().toLowerCase();
  if (["sqlite", "better-sqlite3", "sqlite3"].includes(value)) return "sqlite";
  if (["postgres", "postgresql", "pg"].includes(value)) return "postgres";
  throw new Error(`Unsupported FANJIN_DATABASE_CLIENT=${value}`);
}

export function configurePostgresTypeParsers() {
  const pg = require("pg");
  pg.types.setTypeParser(20, (value: string) => Number(value));
  pg.types.setTypeParser(1700, (value: string) => Number(value));
}

export function getKnexClientName(client: Knex | Knex.Transaction | any): string {
  return String(client?.client?.config?.client || client?.client?.dialect || "").toLowerCase();
}

export function isPostgresClient(client: Knex | Knex.Transaction | any): boolean {
  const name = getKnexClientName(client);
  return name === "pg" || name === "postgres" || name === "postgresql";
}

export function quoteSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function rawRows<T = any>(result: any): T[] {
  if (Array.isArray(result)) return result as T[];
  if (Array.isArray(result?.rows)) return result.rows as T[];
  if (Array.isArray(result?.[0])) return result[0] as T[];
  return [];
}

export async function listUserTables(client: Knex | Knex.Transaction | any): Promise<{ name: string }[]> {
  if (isPostgresClient(client)) {
    const result = await client.raw(
      `SELECT tablename AS name
       FROM pg_catalog.pg_tables
       WHERE schemaname = current_schema()
         AND tablename NOT LIKE 'knex_%'
       ORDER BY tablename`,
    );
    return rawRows<{ name: string }>(result);
  }

  const result = await client.raw(
    `SELECT name
     FROM sqlite_master
     WHERE type='table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'knex_%'
     ORDER BY name`,
  );
  return rawRows<{ name: string }>(result);
}

export async function tableExists(client: Knex | Knex.Transaction | any, tableName: string): Promise<boolean> {
  if (isPostgresClient(client)) {
    const result = await client.raw(
      `SELECT 1
       FROM pg_catalog.pg_tables
       WHERE schemaname = current_schema()
         AND tablename = ?
       LIMIT 1`,
      [tableName],
    );
    return rawRows(result).length > 0;
  }

  const result = await client.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [tableName]);
  return rawRows(result).length > 0;
}

export async function tableColumns(client: Knex | Knex.Transaction | any, tableName: string): Promise<string[]> {
  if (isPostgresClient(client)) {
    const result = await client.raw(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ?
       ORDER BY ordinal_position`,
      [tableName],
    );
    return rawRows<{ name: string }>(result).map((row) => String(row.name || ""));
  }

  const result = await client.raw(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`);
  return rawRows<{ name: string }>(result).map((row) => String(row.name || ""));
}

export async function tableIndexRows(client: Knex | Knex.Transaction | any, tableName: string): Promise<DbIndexRow[]> {
  if (isPostgresClient(client)) {
    const result = await client.raw(
      `SELECT index_class.relname AS name, pg_index.indisunique AS unique
       FROM pg_class table_class
       JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
       JOIN pg_index ON table_class.oid = pg_index.indrelid
       JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
       WHERE namespace.nspname = current_schema()
         AND table_class.relname = ?
       ORDER BY index_class.relname`,
      [tableName],
    );
    return rawRows<DbIndexRow>(result);
  }

  const result = await client.raw(`PRAGMA index_list(${quoteSqlIdentifier(tableName)})`);
  return rawRows<DbIndexRow>(result);
}

export async function dropAllUserTables(client: Knex | Knex.Transaction | any) {
  const tables = await listUserTables(client);
  if (isPostgresClient(client)) {
    for (const table of tables) {
      await client.raw(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(table.name)} CASCADE`);
    }
    return;
  }

  await client.raw("PRAGMA foreign_keys = OFF");
  try {
    for (const table of tables) {
      await client.schema.dropTableIfExists(table.name);
    }
  } finally {
    await client.raw("PRAGMA foreign_keys = ON");
  }
}

export async function insertAndReturnId(client: Knex | Knex.Transaction | any, tableName: string, row: Record<string, unknown>): Promise<number> {
  const result = isPostgresClient(client)
    ? await client(tableName).insert(row).returning("id")
    : await client(tableName).insert(row);
  const first = Array.isArray(result) ? result[0] : result;
  const id = first && typeof first === "object" && "id" in first
    ? Number((first as { id: unknown }).id)
    : Number(first);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Insert into ${tableName} did not return a valid numeric id`);
  }
  return id;
}

export function orderStoryboardAssetLinks<T extends Knex.QueryBuilder>(query: T): T {
  return query.orderBy("sortOrder", "asc").orderBy("assetId", "asc") as T;
}
