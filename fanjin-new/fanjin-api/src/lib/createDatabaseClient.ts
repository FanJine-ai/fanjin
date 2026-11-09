import fs from "node:fs";
import path from "node:path";
import knex, { type Knex } from "knex";
import { configurePostgresTypeParsers, normalizeDatabaseClient } from "@/lib/dbDialect";
import { postgresConnectionFromEnv } from "@/lib/databaseConfig";
import { logRuntimePath } from "@/lib/candidateRuntimeLogProjection";
import getPath from "@/utils/getPath";

type EnvironmentLike = Record<string, string | undefined>;

export interface DatabasePoolConfiguration {
  postgres: {
    min: number;
    max: number;
    acquireConnectionTimeout: number;
  };
  sqlite: {
    max: number;
  };
}

export interface CreateDatabaseClientOptions {
  /**
   * Release evidence tools must keep stdout machine-readable and must not
   * disclose an absolute database path. Runtime callers retain the existing
   * diagnostic logging by default.
   */
  logConfiguration?: boolean;
}

export type SqliteJournalMode = "WAL" | "DELETE";

export function resolveSqliteReadonlyMode(
  environment: EnvironmentLike = process.env,
): boolean {
  const raw = String(environment.FANJIN_SQLITE_READONLY ?? "").trim();
  if (!raw || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error("FANJIN_SQLITE_READONLY must be 0 or 1");
}

export function resolveSqliteJournalMode(
  environment: EnvironmentLike = process.env,
): SqliteJournalMode {
  const raw = String(
    environment.FANJIN_SQLITE_JOURNAL_MODE ?? "",
  ).trim();
  if (!raw) return "WAL";
  const normalized = raw.toUpperCase();
  if (normalized !== "WAL" && normalized !== "DELETE") {
    throw new Error(
      "FANJIN_SQLITE_JOURNAL_MODE must be WAL or DELETE",
    );
  }
  return normalized;
}

function strictInteger(
  environment: EnvironmentLike,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = String(environment[name] ?? "").trim();
  if (!raw) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`${name} must be a strict integer`);
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${name} is outside its allowed range`);
  }
  return value;
}

export function resolveDatabasePoolConfiguration(
  environment: EnvironmentLike = process.env,
): DatabasePoolConfiguration {
  const minimum = strictInteger(
    environment,
    "FANJIN_DATABASE_POOL_MIN",
    0,
    0,
    200,
  );
  const maximum = strictInteger(
    environment,
    "FANJIN_DATABASE_POOL_MAX",
    10,
    1,
    200,
  );
  if (minimum > maximum) {
    throw new Error(
      "FANJIN_DATABASE_POOL_MIN must not exceed FANJIN_DATABASE_POOL_MAX",
    );
  }
  return {
    postgres: {
      min: minimum,
      max: maximum,
      acquireConnectionTimeout: strictInteger(
        environment,
        "FANJIN_DATABASE_ACQUIRE_TIMEOUT_MS",
        60_000,
        100,
        24 * 60 * 60_000,
      ),
    },
    sqlite: {
      max: strictInteger(
        environment,
        "FANJIN_SQLITE_POOL_MAX",
        1,
        1,
        32,
      ),
    },
  };
}

export function createDatabaseClient(
  options: CreateDatabaseClientOptions = {},
): Knex {
  const logConfiguration = options.logConfiguration !== false;
  const databaseClient = normalizeDatabaseClient();
  const pool = resolveDatabasePoolConfiguration();
  if (databaseClient === "postgres") {
    configurePostgresTypeParsers();
    if (logConfiguration) console.log("数据库客户端: postgres");
    return knex({
      client: "pg",
      connection: postgresConnectionFromEnv(),
      pool: {
        min: pool.postgres.min,
        max: pool.postgres.max,
      },
      acquireConnectionTimeout:
        pool.postgres.acquireConnectionTimeout,
    });
  }

  const dbPath = getPath("db2.sqlite");
  const sqliteJournalMode = resolveSqliteJournalMode();
  const sqliteReadonly = resolveSqliteReadonlyMode();
  if (logConfiguration) logRuntimePath("数据库目录:", dbPath);
  const dbDir = path.dirname(dbPath);
  if (sqliteReadonly) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dbPath);
    } catch {
      throw new Error("FANJIN_SQLITE_READONLY requires an existing database");
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("FANJIN_SQLITE_READONLY database must be a regular file");
    }
  } else {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, "");
  }

  // SQLite 同一时刻仍只有一个写者；WAL 只放宽读写并发，扩大连接池不能解决
  // “外层写事务等待内层独立写事务”的自锁。Agent 付费写工具因此在 Gateway
  // 使用短事务 prepare/commit、事务外 Relay/Billing、短事务 finalize 的专用
  // 协议。这里保留可配置池用于普通并发与读取，busy_timeout 仅用于短暂竞争，
  // 绝不能被当作嵌套写事务的正确性机制。
  return knex({
    client: "better-sqlite3",
    connection: {
      filename: dbPath,
      ...(sqliteReadonly ? { options: { readonly: true } } : {}),
    },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: pool.sqlite.max,
      afterCreate: (conn: any, done: any) => {
        if (sqliteReadonly) {
          conn.pragma("query_only = ON");
          if (Number(conn.pragma("query_only", { simple: true })) !== 1) {
            done(new Error("SQLite query_only could not be enabled"));
            return;
          }
        } else {
          conn.pragma(`journal_mode = ${sqliteJournalMode}`);
        }
        conn.pragma("busy_timeout = 5000");
        done();
      },
    },
  });
}
