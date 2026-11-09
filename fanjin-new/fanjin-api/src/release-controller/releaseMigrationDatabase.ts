import knex, { type Knex } from "knex";

import { postgresConnectionFromEnv } from "@/lib/databaseConfig";
import {
  configurePostgresTypeParsers,
  normalizeDatabaseClient,
} from "@/lib/dbDialect";

export const RELEASE_MIGRATION_DATABASE_URL_ENV =
  "FANJIN_RELEASE_MIGRATION_DATABASE_URL";

interface DatabaseRoleObservation {
  databaseName: string;
  schemaName: string;
  serverAddress: string;
  serverPort: number;
  serverVersionNum: number;
  roleName: string;
  superuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  replication: boolean;
  bypassRowLevelSecurity: boolean;
  canCreateInSchema: boolean;
  canAlterSchemaObjects: boolean;
  hasTriggerPrivilege: boolean;
}

export interface ReleaseDatabaseSeparationEvidence {
  databaseName: string;
  schemaName: string;
  serverAddress: string;
  serverPort: number;
  serverVersionNum: number;
  controlRole: string;
  migrationRole: string;
}

function configurationError(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t";
}

function resultRow(result: unknown): Record<string, unknown> {
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length !== 1) {
    configurationError("RELEASE_DATABASE_ROLE_OBSERVATION_INVALID");
  }
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    configurationError("RELEASE_DATABASE_ROLE_OBSERVATION_INVALID");
  }
  return row as Record<string, unknown>;
}

function safeText(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    configurationError("RELEASE_DATABASE_ROLE_OBSERVATION_INVALID");
  }
  return normalized;
}

function safeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    configurationError("RELEASE_DATABASE_ROLE_OBSERVATION_INVALID");
  }
  return parsed;
}

async function observeRole(database: Knex): Promise<DatabaseRoleObservation> {
  const row = resultRow(await database.raw(`
    SELECT
      current_database() AS "databaseName",
      current_schema() AS "schemaName",
      COALESCE(inet_server_addr()::text, 'local') AS "serverAddress",
      COALESCE(inet_server_port(), 0) AS "serverPort",
      current_setting('server_version_num')::bigint AS "serverVersionNum",
      current_user AS "roleName",
      role.rolsuper AS "superuser",
      role.rolcreatedb AS "canCreateDatabase",
      role.rolcreaterole AS "canCreateRole",
      role.rolreplication AS "replication",
      role.rolbypassrls AS "bypassRowLevelSecurity",
      has_schema_privilege(current_user, current_schema(), 'CREATE')
        AS "canCreateInSchema",
      EXISTS (
        SELECT 1
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = current_schema()
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
           AND pg_has_role(current_user, relation.relowner, 'USAGE')
      ) AS "canAlterSchemaObjects",
      EXISTS (
        SELECT 1
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = current_schema()
           AND relation.relkind IN ('r', 'p')
           AND has_table_privilege(current_user, relation.oid, 'TRIGGER')
      ) AS "hasTriggerPrivilege"
      FROM pg_roles AS role
     WHERE role.rolname = current_user
  `));
  return {
    databaseName: safeText(row.databaseName),
    schemaName: safeText(row.schemaName),
    serverAddress: safeText(row.serverAddress),
    serverPort: safeInteger(row.serverPort),
    serverVersionNum: safeInteger(row.serverVersionNum),
    roleName: safeText(row.roleName),
    superuser: booleanValue(row.superuser),
    canCreateDatabase: booleanValue(row.canCreateDatabase),
    canCreateRole: booleanValue(row.canCreateRole),
    replication: booleanValue(row.replication),
    bypassRowLevelSecurity: booleanValue(row.bypassRowLevelSecurity),
    canCreateInSchema: booleanValue(row.canCreateInSchema),
    canAlterSchemaObjects: booleanValue(row.canAlterSchemaObjects),
    hasTriggerPrivilege: booleanValue(row.hasTriggerPrivilege),
  };
}

/**
 * Construct the privileged connection from one explicit secret only. There is
 * intentionally no DATABASE_URL or per-field fallback.
 */
export function createReleaseMigrationDatabase(
  environment: NodeJS.ProcessEnv = process.env,
): Knex {
  if (normalizeDatabaseClient(environment.FANJIN_DATABASE_CLIENT) !== "postgres") {
    configurationError("RELEASE_MIGRATION_DATABASE_POSTGRES_REQUIRED");
  }
  const migrationUrl = String(
    environment[RELEASE_MIGRATION_DATABASE_URL_ENV] || "",
  ).trim();
  if (!migrationUrl) {
    configurationError("RELEASE_MIGRATION_DATABASE_URL_REQUIRED");
  }
  const ordinaryUrl = String(environment.DATABASE_URL || "").trim();
  if (ordinaryUrl && ordinaryUrl === migrationUrl) {
    configurationError("RELEASE_MIGRATION_DATABASE_CREDENTIAL_REUSED");
  }
  configurePostgresTypeParsers();
  const connection = postgresConnectionFromEnv({
    ...environment,
    DATABASE_URL: migrationUrl,
  });
  return knex({
    client: "pg",
    connection,
    pool: {
      min: 0,
      max: 2,
    },
    acquireConnectionTimeout: Number(
      environment.FANJIN_DATABASE_ACQUIRE_TIMEOUT_MS || 60_000,
    ),
  });
}

/**
 * Prove same physical database identity while enforcing independent,
 * least-privilege roles. Only the returned non-secret identity is safe to
 * persist; callers must never log either connection configuration.
 */
export async function assertReleaseDatabaseRoleSeparation(
  controlDatabase: Knex,
  migrationDatabase: Knex,
): Promise<ReleaseDatabaseSeparationEvidence> {
  const [control, migration] = await Promise.all([
    observeRole(controlDatabase),
    observeRole(migrationDatabase),
  ]);
  if (
    control.databaseName !== migration.databaseName
    || control.schemaName !== migration.schemaName
    || control.serverAddress !== migration.serverAddress
    || control.serverPort !== migration.serverPort
    || control.serverVersionNum !== migration.serverVersionNum
  ) {
    configurationError("RELEASE_MIGRATION_DATABASE_IDENTITY_MISMATCH");
  }
  if (control.roleName === migration.roleName) {
    configurationError("RELEASE_MIGRATION_DATABASE_ROLE_REUSED");
  }
  if (
    control.superuser
    || control.canCreateDatabase
    || control.canCreateRole
    || control.replication
    || control.bypassRowLevelSecurity
    || control.canCreateInSchema
    || control.canAlterSchemaObjects
    || control.hasTriggerPrivilege
  ) {
    configurationError("RELEASE_CONTROL_DATABASE_ROLE_OVERPRIVILEGED");
  }
  if (
    migration.superuser
    || migration.canCreateDatabase
    || migration.canCreateRole
    || migration.replication
    || migration.bypassRowLevelSecurity
  ) {
    configurationError("RELEASE_MIGRATION_DATABASE_ROLE_OVERPRIVILEGED");
  }
  if (
    !migration.canCreateInSchema
    || !migration.canAlterSchemaObjects
  ) {
    configurationError("RELEASE_MIGRATION_DATABASE_ROLE_UNDERPRIVILEGED");
  }
  return {
    databaseName: control.databaseName,
    schemaName: control.schemaName,
    serverAddress: control.serverAddress,
    serverPort: control.serverPort,
    serverVersionNum: control.serverVersionNum,
    controlRole: control.roleName,
    migrationRole: migration.roleName,
  };
}
