import type { Knex } from "knex";

import { tableColumns } from "@/lib/dbDialect";
import {
  DATABASE_MIGRATIONS,
  isReviewedConstraintlessDatabaseMigration,
  inspectDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationStatus,
  type EnvironmentLike,
} from "@/lib/databaseMigrations";
import { WORKER_HEARTBEAT_TABLE } from "@/lib/migrations/operationalRuntimeSchema";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import {
  RELEASE_ARTIFACT_TABLE,
  RELEASE_DEPLOYMENT_EVENT_TABLE,
  RELEASE_DEPLOYMENT_TABLE,
  RELEASE_DEPLOYMENT_TARGET_TABLE,
  WORKER_RELEASE_CONTROL_TABLE,
} from "@/lib/migrations/releaseDeploymentOrchestration";
import {
  RELEASE_DEPLOYMENT_RECONCILIATION_TABLE,
} from "@/lib/migrations/releaseDeploymentReconciliation";

const RELEASE_CONTROLLER_BASE_MIGRATION = "release_deployment_reconciliation";
const REVIEWED_CONSTRAINT_RE = /^[a-z][A-Za-z0-9_.:-]{0,127}$/;
const MAX_REVIEWED_CONSTRAINTS_PER_MIGRATION = 1_024;
// Several independently reviewed migrations can legitimately be pending while
// the Controller is still running the source schema. Keep both an individual
// and an aggregate bound so a large reviewed migration is accepted without
// allowing an unbounded compiled allowlist.
const MAX_REVIEWED_CONSTRAINTS = 2_048;

export const RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES = {
  BASE_SCHEMA_MISSING: "RELEASE_CONTROLLER_BASE_SCHEMA_MISSING",
  LEDGER_INVALID: "RELEASE_CONTROLLER_MIGRATION_LEDGER_INVALID",
  LEDGER_MISSING: "RELEASE_CONTROLLER_MIGRATION_LEDGER_MISSING",
  PENDING_MIGRATION_UNREVIEWED: "RELEASE_CONTROLLER_PENDING_MIGRATION_UNREVIEWED",
  TABLE_MALFORMED: "RELEASE_CONTROLLER_TABLE_MALFORMED",
  TABLE_MISSING: "RELEASE_CONTROLLER_TABLE_MISSING",
  TABLE_UNAVAILABLE: "RELEASE_CONTROLLER_TABLE_UNAVAILABLE",
} as const;

export type ReleaseControllerDatabaseReadinessErrorCode =
  (typeof RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES)[
    keyof typeof RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES
  ];

export class ReleaseControllerDatabaseReadinessError extends Error {
  readonly code: ReleaseControllerDatabaseReadinessErrorCode;

  constructor(code: ReleaseControllerDatabaseReadinessErrorCode, message: string) {
    super(message);
    this.name = "ReleaseControllerDatabaseReadinessError";
    this.code = code;
  }
}

interface RequiredControllerTable {
  name: string;
  columns: readonly string[];
}

/**
 * Tables read or mutated by the independent Controller before/while it owns a
 * deployment lease. This is deliberately narrower than the application
 * schema, but validates every column consumed by the Controller adapters.
 *
 * `o_schema_migration_run` is intentionally not a startup prerequisite. The
 * hardened runner creates that append-only evidence table under its migration
 * lock before the first reviewed migration; requiring it here would strand
 * existing v34 databases that have never executed the new runner.
 */
export const RELEASE_CONTROLLER_REQUIRED_TABLES: readonly RequiredControllerTable[] = [
  {
    name: PLATFORM_RELEASE_TABLE,
    columns: [
      "id",
      "version",
      "title",
      "channel",
      "summary",
      "releaseNotes",
      "status",
      "revision",
      "createdByUserId",
      "updatedByUserId",
      "publishedByUserId",
      "archivedByUserId",
      "publishedAt",
      "archivedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    name: RELEASE_ARTIFACT_TABLE,
    columns: [
      "id",
      "releaseId",
      "idempotencyKey",
      "requestHash",
      "storageKey",
      "fileName",
      "mediaType",
      "format",
      "byteSize",
      "sha256",
      "sourceCommit",
      "manifestJson",
      "status",
      "rejectionReason",
      "createdByUserId",
      "verifiedAt",
      "revision",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    name: RELEASE_DEPLOYMENT_TABLE,
    columns: [
      "id",
      "releaseId",
      "artifactId",
      "previousReleaseId",
      "previousArtifactId",
      "environment",
      "strategy",
      "status",
      "phase",
      "activeScope",
      "idempotencyKey",
      "requestHash",
      "planJson",
      "checkpointJson",
      "manualInterventionRequired",
      "fencingToken",
      "targetCount",
      "completedTargetCount",
      "succeededTargetCount",
      "failedTargetCount",
      "maxUnavailable",
      "minHealthyTargets",
      "drainTimeoutMs",
      "readinessTimeoutMs",
      "rollbackOnFailure",
      "requestedByUserId",
      "leaseOwner",
      "leaseExpiresAt",
      "startedAt",
      "completedAt",
      "cancelRequestedAt",
      "cancelRequestedByUserId",
      "cancelReason",
      "errorCode",
      "safeError",
      "revision",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    name: RELEASE_DEPLOYMENT_TARGET_TABLE,
    columns: [
      "id",
      "deploymentId",
      "targetKey",
      "targetLabel",
      "role",
      "ordinal",
      "targetMetadataJson",
      "status",
      "attempt",
      "previousReleaseId",
      "previousArtifactId",
      "observedArtifactId",
      "observedVersion",
      "drainStartedAt",
      "deployStartedAt",
      "verifiedAt",
      "completedAt",
      "errorCode",
      "safeError",
      "revision",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    name: RELEASE_DEPLOYMENT_EVENT_TABLE,
    columns: [
      "id",
      "deploymentId",
      "targetId",
      "sequence",
      "eventType",
      "phase",
      "level",
      "actor",
      "actorUserId",
      "requestId",
      "message",
      "payloadJson",
      "createdAt",
    ],
  },
  {
    name: WORKER_HEARTBEAT_TABLE,
    columns: [
      "id",
      "role",
      "hostname",
      "processId",
      "startedAt",
      "heartbeatAt",
      "nodeId",
      "incarnationId",
      "releaseId",
      "artifactSha256",
      "schemaVersion",
      "acceptingWork",
      "activeTaskCount",
      "drainOperationId",
      "controlRevision",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    name: WORKER_RELEASE_CONTROL_TABLE,
    columns: [
      "nodeId",
      "desiredState",
      "operationId",
      "requestedAt",
      "revision",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    name: RELEASE_DEPLOYMENT_RECONCILIATION_TABLE,
    columns: [
      "id",
      "deploymentId",
      "activeDeploymentId",
      "intent",
      "status",
      "reason",
      "idempotencyKey",
      "requestHash",
      "requestedDeploymentRevision",
      "requestedByUserId",
      "leaseOwner",
      "leaseExpiresAt",
      "fencingToken",
      "evidenceJson",
      "errorCode",
      "safeError",
      "startedAt",
      "completedAt",
      "revision",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    // Redis rate-limit cutover uses a controller-owned state key in the
    // baseline setting table and must fail before a lease is claimed if the
    // least-privilege database role cannot read it.
    name: "o_setting",
    columns: ["key", "value"],
  },
] as const;

export interface ReleaseControllerDatabaseReadiness {
  schemaVersion: number;
  targetSchemaVersion: number;
  state: "source" | "target";
  migrationStatus: DatabaseMigrationStatus;
}

function fail(
  code: ReleaseControllerDatabaseReadinessErrorCode,
  message: string,
): never {
  throw new ReleaseControllerDatabaseReadinessError(code, message);
}

export function usesReleaseControllerDatabaseReadiness(
  env: EnvironmentLike = process.env,
): boolean {
  return String(env.FANJIN_PROCESS_ROLE || "").trim() === "release-controller";
}

function assertReviewedPendingDefinitions(
  status: DatabaseMigrationStatus,
  definitions: readonly DatabaseMigration[],
): void {
  const pendingIdentities = new Set(status.pending.map((migration) => (
    `${migration.version}\0${migration.name}\0${migration.checksum}`
  )));
  const pending = definitions.filter((definition) => pendingIdentities.has(
    `${definition.version}\0${definition.name}\0${definition.checksum}`,
  ));
  if (pending.length !== status.pending.length) {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.LEDGER_INVALID,
      "Controller migration definitions do not exactly match the pending ledger suffix.",
    );
  }

  const constraints: string[] = [];
  for (const definition of pending) {
    const reviewed = definition.requiredConstraints;
    const reviewedConstraintless = isReviewedConstraintlessDatabaseMigration(definition);
    if (
      !Array.isArray(reviewed)
      || (reviewed.length === 0 && !reviewedConstraintless)
      || reviewed.length > MAX_REVIEWED_CONSTRAINTS_PER_MIGRATION
      || reviewed.some((constraint) => (
        typeof constraint !== "string" || !REVIEWED_CONSTRAINT_RE.test(constraint)
      ))
    ) {
      fail(
        RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.PENDING_MIGRATION_UNREVIEWED,
        "Every pending Controller migration must declare reviewed requiredConstraints.",
      );
    }
    constraints.push(...reviewed);
  }
  if (
    constraints.length > MAX_REVIEWED_CONSTRAINTS
    || new Set(constraints).size !== constraints.length
  ) {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.PENDING_MIGRATION_UNREVIEWED,
      "Pending Controller migration constraints are duplicate or exceed the reviewed bound.",
    );
  }
}

async function assertControllerTable(
  client: Knex,
  requirement: RequiredControllerTable,
): Promise<void> {
  let exists: boolean;
  try {
    exists = await client.schema.hasTable(requirement.name);
  } catch {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.TABLE_UNAVAILABLE,
      `Controller table ${requirement.name} could not be inspected.`,
    );
  }
  if (!exists) {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.TABLE_MISSING,
      `Controller table ${requirement.name} is missing.`,
    );
  }

  let actualColumns: string[];
  try {
    actualColumns = await tableColumns(client, requirement.name);
  } catch {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.TABLE_UNAVAILABLE,
      `Controller table ${requirement.name} columns could not be inspected.`,
    );
  }
  const actual = new Set(actualColumns);
  const missing = requirement.columns.filter((column) => !actual.has(column));
  if (missing.length > 0) {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.TABLE_MALFORMED,
      `Controller table ${requirement.name} is missing required columns.`,
    );
  }

  try {
    await client(requirement.name).select([...requirement.columns]).limit(0);
  } catch {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.TABLE_UNAVAILABLE,
      `Controller table ${requirement.name} is not readable.`,
    );
  }
}

/**
 * Read-only startup gate for the independent release Controller.
 *
 * Unlike application readiness, this accepts an exact known schema prefix so
 * the Controller can start on the source side of an approved migration. It
 * never creates metadata, runs migrations, or weakens API/Worker dbReady.
 */
export async function prepareDatabaseForReleaseController(
  client: Knex,
  migrationDefinitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): Promise<ReleaseControllerDatabaseReadiness> {
  let status: DatabaseMigrationStatus;
  try {
    status = await inspectDatabaseMigrations(client, migrationDefinitions);
  } catch {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.LEDGER_INVALID,
      "Controller migration ledger is not an exact known prefix.",
    );
  }
  if (!status.tableExists) {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.LEDGER_MISSING,
      "Controller migration ledger is missing.",
    );
  }

  const baseDefinition = migrationDefinitions.find(
    (definition) => definition.name === RELEASE_CONTROLLER_BASE_MIGRATION,
  );
  const schemaVersion = status.applied.at(-1)?.version ?? 0;
  if (!baseDefinition || schemaVersion < baseDefinition.version) {
    fail(
      RELEASE_CONTROLLER_DATABASE_READINESS_ERROR_CODES.BASE_SCHEMA_MISSING,
      "Controller base schema has not been applied.",
    );
  }

  assertReviewedPendingDefinitions(status, migrationDefinitions);
  for (const requirement of RELEASE_CONTROLLER_REQUIRED_TABLES) {
    await assertControllerTable(client, requirement);
  }

  return {
    schemaVersion,
    targetSchemaVersion: status.latestVersion,
    state: status.current ? "target" : "source",
    migrationStatus: status,
  };
}
