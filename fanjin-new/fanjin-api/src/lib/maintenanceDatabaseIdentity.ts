import { createHash } from "node:crypto";

import type { Knex } from "knex";

export class MaintenanceMigrationCheckpointError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MaintenanceMigrationCheckpointError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new MaintenanceMigrationCheckpointError(code, message);
}

function rawRows(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === "object" && !Array.isArray(row)
    ))
    : [];
}

export interface MaintenanceDatabaseIdentity {
  databaseName: string;
  schemaName: string;
  serverAddress: string;
  serverPort: string;
  sha256: string;
}

/** Lightweight database identity probe with no backup, AWS, or logger graph. */
export async function readMaintenanceDatabaseIdentity(
  database: Knex,
): Promise<MaintenanceDatabaseIdentity> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = rawRows(await database.raw(
      `SELECT current_database() AS database_name,
              current_schema() AS schema_name,
              COALESCE(inet_server_addr()::text, 'local') AS server_address,
              COALESCE(inet_server_port()::text, 'local') AS server_port`,
    ));
  } catch {
    return fail(
      "MAINTENANCE_CHECKPOINT_DATABASE_IDENTITY_UNAVAILABLE",
      "database identity cannot be verified",
    );
  }
  const row = rows[0];
  const databaseName = String(row?.database_name || "").trim();
  const schemaName = String(row?.schema_name || "").trim();
  const serverAddress = String(row?.server_address || "").trim();
  const serverPort = String(row?.server_port || "").trim();
  if (!databaseName || !schemaName || !serverAddress || !serverPort) {
    fail(
      "MAINTENANCE_CHECKPOINT_DATABASE_IDENTITY_INVALID",
      "database identity is incomplete",
    );
  }
  const canonical = JSON.stringify({
    databaseName,
    schemaName,
    serverAddress,
    serverPort,
  });
  return {
    databaseName,
    schemaName,
    serverAddress,
    serverPort,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}
