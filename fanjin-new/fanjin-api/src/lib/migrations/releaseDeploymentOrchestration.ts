import type { Knex } from "knex";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import { WORKER_HEARTBEAT_TABLE } from "@/lib/migrations/operationalRuntimeSchema";

export const RELEASE_ARTIFACT_TABLE = "o_release_artifact";
export const RELEASE_DEPLOYMENT_TABLE = "o_release_deployment";
export const RELEASE_DEPLOYMENT_TARGET_TABLE = "o_release_deployment_target";
export const RELEASE_DEPLOYMENT_EVENT_TABLE = "o_release_deployment_event";
export const WORKER_RELEASE_CONTROL_TABLE = "o_worker_release_control";

export const RELEASE_ARTIFACT_INDEXES = {
  idempotencyKey: "uq_o_release_artifact_idempotency",
  releaseSha: "uq_o_release_artifact_release_sha",
  storageKey: "uq_o_release_artifact_storage_key",
  releaseStatus: "idx_o_release_artifact_release_status",
  statusCreated: "idx_o_release_artifact_status_created",
} as const;

export const RELEASE_DEPLOYMENT_INDEXES = {
  idempotencyKey: "uq_o_release_deployment_idempotency",
  activeScope: "uq_o_release_deployment_active_scope",
  releaseCreated: "idx_o_release_deployment_release_created",
  statusCreated: "idx_o_release_deployment_status_created",
  lease: "idx_o_release_deployment_lease",
} as const;

export const RELEASE_DEPLOYMENT_TARGET_INDEXES = {
  deploymentTarget: "uq_o_release_target_deployment_key",
  deploymentOrdinal: "uq_o_release_target_deployment_ordinal",
  deploymentStatus: "idx_o_release_target_deployment_status",
  targetStatus: "idx_o_release_target_key_status",
} as const;

export const RELEASE_DEPLOYMENT_EVENT_INDEXES = {
  deploymentSequence: "uq_o_release_event_deployment_sequence",
  deploymentCreated: "idx_o_release_event_deployment_created",
  targetCreated: "idx_o_release_event_target_created",
  deploymentType: "idx_o_release_event_deployment_type",
} as const;

const ARTIFACT_STATUSES = ["registered", "ready", "rejected"] as const;
const DEPLOYMENT_ACTIVE_STATUSES = ["queued", "running", "cancelling", "rolling_back"] as const;
const DEPLOYMENT_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "rolled_back", "degraded_manual"] as const;
const DEPLOYMENT_SCOPE_BLOCKING_STATUSES = [...DEPLOYMENT_ACTIVE_STATUSES, "degraded_manual"] as const;
const DEPLOYMENT_SCOPE_RELEASING_STATUSES = ["succeeded", "failed", "cancelled", "rolled_back"] as const;
const TARGET_ACTIVE_STATUSES = ["pending", "draining", "deploying", "verifying", "rolling_back"] as const;
const TARGET_TERMINAL_STATUSES = ["succeeded", "failed", "skipped", "cancelled", "rolled_back"] as const;
const EVENT_LEVELS = ["info", "warning", "error"] as const;
const EVENT_ACTORS = ["operator", "orchestrator", "target"] as const;

function quotedValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

async function ensureArtifactTable(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(RELEASE_ARTIFACT_TABLE)) return;

  await trx.schema.createTable(RELEASE_ARTIFACT_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("releaseId").notNullable();
    table.text("idempotencyKey").notNullable();
    table.text("requestHash").notNullable();
    table.text("storageKey").notNullable();
    table.text("fileName");
    table.text("mediaType");
    table.text("format");
    table.bigInteger("byteSize");
    table.text("sha256").notNullable();
    table.text("sourceCommit");
    table.text("manifestJson").notNullable().defaultTo("{}");
    table.text("status").notNullable().defaultTo("registered");
    table.text("rejectionReason");
    table.bigInteger("createdByUserId");
    table.bigInteger("verifiedAt");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    table
      .foreign("releaseId", "fk_o_release_artifact_release")
      .references("id")
      .inTable(PLATFORM_RELEASE_TABLE)
      .onDelete("RESTRICT");
    table.unique(["idempotencyKey"], RELEASE_ARTIFACT_INDEXES.idempotencyKey);
    table.unique(["releaseId", "sha256"], RELEASE_ARTIFACT_INDEXES.releaseSha);
    table.unique(["storageKey"], RELEASE_ARTIFACT_INDEXES.storageKey);
    table.index(["releaseId", "status", "createdAt"], RELEASE_ARTIFACT_INDEXES.releaseStatus);
    table.index(["status", "createdAt"], RELEASE_ARTIFACT_INDEXES.statusCreated);

    table.check(`"status" IN (${quotedValues(ARTIFACT_STATUSES)})`, {}, "chk_o_release_artifact_status");
    table.check('"byteSize" IS NULL OR "byteSize" > 0', {}, "chk_o_release_artifact_byte_size");
    table.check('length("sha256") = 64', {}, "chk_o_release_artifact_sha256");
    table.check('length("requestHash") = 64', {}, "chk_o_release_artifact_request_hash");
    table.check('"revision" >= 1', {}, "chk_o_release_artifact_revision");
    table.check(
      '("status" = \'registered\' AND "verifiedAt" IS NULL) OR '
        + '("status" IN (\'ready\', \'rejected\') AND "verifiedAt" IS NOT NULL)',
      {},
      "chk_o_release_artifact_verification",
    );
    table.check(
      '("status" = \'rejected\' AND "rejectionReason" IS NOT NULL) OR '
        + '("status" <> \'rejected\' AND "rejectionReason" IS NULL)',
      {},
      "chk_o_release_artifact_rejection",
    );
  });
}

async function ensureDeploymentTable(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(RELEASE_DEPLOYMENT_TABLE)) return;

  await trx.schema.createTable(RELEASE_DEPLOYMENT_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("releaseId").notNullable();
    table.text("artifactId").notNullable();
    table.text("previousReleaseId");
    table.text("previousArtifactId");
    table.text("environment").notNullable().defaultTo("production");
    table.text("strategy").notNullable().defaultTo("rolling");
    table.text("status").notNullable().defaultTo("queued");
    table.text("phase").notNullable().defaultTo("queued");
    table.text("activeScope");
    table.text("idempotencyKey").notNullable();
    table.text("requestHash").notNullable();
    table.text("planJson").notNullable().defaultTo("{}");
    table.text("checkpointJson").notNullable().defaultTo("{}");
    table.bigInteger("manualInterventionRequired").notNullable().defaultTo(0);
    table.bigInteger("fencingToken").notNullable().defaultTo(1);
    table.bigInteger("targetCount").notNullable();
    table.bigInteger("completedTargetCount").notNullable().defaultTo(0);
    table.bigInteger("succeededTargetCount").notNullable().defaultTo(0);
    table.bigInteger("failedTargetCount").notNullable().defaultTo(0);
    table.bigInteger("maxUnavailable").notNullable().defaultTo(1);
    table.bigInteger("minHealthyTargets").notNullable().defaultTo(1);
    table.bigInteger("drainTimeoutMs").notNullable().defaultTo(310_000);
    table.bigInteger("readinessTimeoutMs").notNullable().defaultTo(120_000);
    table.bigInteger("rollbackOnFailure").notNullable().defaultTo(1);
    table.bigInteger("requestedByUserId");
    table.text("leaseOwner");
    table.bigInteger("leaseExpiresAt");
    table.bigInteger("startedAt");
    table.bigInteger("completedAt");
    table.bigInteger("cancelRequestedAt");
    table.bigInteger("cancelRequestedByUserId");
    table.text("cancelReason");
    table.text("errorCode");
    table.text("safeError");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    table
      .foreign("releaseId", "fk_o_release_deployment_release")
      .references("id")
      .inTable(PLATFORM_RELEASE_TABLE)
      .onDelete("RESTRICT");
    table
      .foreign("artifactId", "fk_o_release_deployment_artifact")
      .references("id")
      .inTable(RELEASE_ARTIFACT_TABLE)
      .onDelete("RESTRICT");
    table
      .foreign("previousReleaseId", "fk_o_release_deployment_previous_release")
      .references("id")
      .inTable(PLATFORM_RELEASE_TABLE)
      .onDelete("RESTRICT");
    table
      .foreign("previousArtifactId", "fk_o_release_deployment_previous_artifact")
      .references("id")
      .inTable(RELEASE_ARTIFACT_TABLE)
      .onDelete("RESTRICT");
    table.unique(["idempotencyKey"], RELEASE_DEPLOYMENT_INDEXES.idempotencyKey);
    // PostgreSQL and SQLite both permit multiple NULL values in a unique
    // constraint. Active deployments hold this scope; terminal transitions
    // must clear it in the same write that records the terminal status.
    table.unique(["activeScope"], RELEASE_DEPLOYMENT_INDEXES.activeScope);
    table.index(["releaseId", "createdAt"], RELEASE_DEPLOYMENT_INDEXES.releaseCreated);
    table.index(["status", "createdAt"], RELEASE_DEPLOYMENT_INDEXES.statusCreated);
    table.index(["leaseExpiresAt", "status"], RELEASE_DEPLOYMENT_INDEXES.lease);

    table.check(
      `"status" IN (${quotedValues([...DEPLOYMENT_ACTIVE_STATUSES, ...DEPLOYMENT_TERMINAL_STATUSES])})`,
      {},
      "chk_o_release_deployment_status",
    );
    table.check('"strategy" = \'rolling\'', {}, "chk_o_release_deployment_strategy");
    table.check('"targetCount" > 0', {}, "chk_o_release_deployment_target_count");
    table.check(
      '"completedTargetCount" >= 0 AND "completedTargetCount" <= "targetCount" '
        + 'AND "succeededTargetCount" >= 0 AND "failedTargetCount" >= 0 '
        + 'AND "succeededTargetCount" + "failedTargetCount" <= "completedTargetCount"',
      {},
      "chk_o_release_deployment_progress",
    );
    table.check(
      '"maxUnavailable" >= 1 AND "maxUnavailable" <= "targetCount" '
        + 'AND "minHealthyTargets" >= 1 AND "minHealthyTargets" <= "targetCount"',
      {},
      "chk_o_release_deployment_availability",
    );
    table.check(
      '"drainTimeoutMs" > 0 AND "readinessTimeoutMs" > 0',
      {},
      "chk_o_release_deployment_timeouts",
    );
    table.check('"rollbackOnFailure" IN (0, 1)', {}, "chk_o_release_deployment_rollback");
    table.check(
      '"manualInterventionRequired" IN (0, 1)',
      {},
      "chk_o_release_deployment_manual_intervention",
    );
    table.check('"fencingToken" >= 1', {}, "chk_o_release_deployment_fencing_token");
    table.check('length("requestHash") = 64', {}, "chk_o_release_deployment_request_hash");
    table.check('"revision" >= 1', {}, "chk_o_release_deployment_revision");
    table.check(
      '("leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL) OR '
        + '("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)',
      {},
      "chk_o_release_deployment_lease",
    );
    table.check(
      `("status" IN (${quotedValues(DEPLOYMENT_SCOPE_BLOCKING_STATUSES)}) AND "activeScope" IS NOT NULL) OR `
        + `("status" IN (${quotedValues(DEPLOYMENT_SCOPE_RELEASING_STATUSES)}) AND "activeScope" IS NULL)`,
      {},
      "chk_o_release_deployment_active_scope",
    );
  });
}

async function ensureDeploymentTargetTable(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(RELEASE_DEPLOYMENT_TARGET_TABLE)) return;

  await trx.schema.createTable(RELEASE_DEPLOYMENT_TARGET_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("deploymentId").notNullable();
    table.text("targetKey").notNullable();
    table.text("targetLabel").notNullable();
    table.text("role").notNullable();
    table.bigInteger("ordinal").notNullable();
    table.text("targetMetadataJson").notNullable().defaultTo("{}");
    table.text("status").notNullable().defaultTo("pending");
    table.bigInteger("attempt").notNullable().defaultTo(0);
    table.text("previousReleaseId");
    table.text("previousArtifactId");
    table.text("observedArtifactId");
    table.text("observedVersion");
    table.bigInteger("drainStartedAt");
    table.bigInteger("deployStartedAt");
    table.bigInteger("verifiedAt");
    table.bigInteger("completedAt");
    table.text("errorCode");
    table.text("safeError");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    table
      .foreign("deploymentId", "fk_o_release_target_deployment")
      .references("id")
      .inTable(RELEASE_DEPLOYMENT_TABLE)
      .onDelete("RESTRICT");
    table
      .foreign("previousReleaseId", "fk_o_release_target_previous_release")
      .references("id")
      .inTable(PLATFORM_RELEASE_TABLE)
      .onDelete("RESTRICT");
    table
      .foreign("previousArtifactId", "fk_o_release_target_previous_artifact")
      .references("id")
      .inTable(RELEASE_ARTIFACT_TABLE)
      .onDelete("RESTRICT");
    table
      .foreign("observedArtifactId", "fk_o_release_target_observed_artifact")
      .references("id")
      .inTable(RELEASE_ARTIFACT_TABLE)
      .onDelete("RESTRICT");
    table.unique(["deploymentId", "targetKey"], RELEASE_DEPLOYMENT_TARGET_INDEXES.deploymentTarget);
    table.unique(["deploymentId", "ordinal"], RELEASE_DEPLOYMENT_TARGET_INDEXES.deploymentOrdinal);
    table.index(["deploymentId", "status", "ordinal"], RELEASE_DEPLOYMENT_TARGET_INDEXES.deploymentStatus);
    table.index(["targetKey", "status"], RELEASE_DEPLOYMENT_TARGET_INDEXES.targetStatus);

    table.check(
      `"status" IN (${quotedValues([...TARGET_ACTIVE_STATUSES, ...TARGET_TERMINAL_STATUSES])})`,
      {},
      "chk_o_release_target_status",
    );
    table.check('"ordinal" >= 0', {}, "chk_o_release_target_ordinal");
    table.check('"attempt" >= 0', {}, "chk_o_release_target_attempt");
    table.check('"revision" >= 1', {}, "chk_o_release_target_revision");
    table.check(
      `("status" IN (${quotedValues(TARGET_ACTIVE_STATUSES)}) AND "completedAt" IS NULL) OR `
        + `("status" IN (${quotedValues(TARGET_TERMINAL_STATUSES)}) AND "completedAt" IS NOT NULL)`,
      {},
      "chk_o_release_target_completion",
    );
    table.check(
      '"status" <> \'succeeded\' OR "observedArtifactId" IS NOT NULL',
      {},
      "chk_o_release_target_observed_artifact",
    );
  });
}

async function ensureDeploymentEventTable(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(RELEASE_DEPLOYMENT_EVENT_TABLE)) return;

  await trx.schema.createTable(RELEASE_DEPLOYMENT_EVENT_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("deploymentId").notNullable();
    table.text("targetId");
    table.bigInteger("sequence").notNullable();
    table.text("eventType").notNullable();
    table.text("phase").notNullable();
    table.text("level").notNullable().defaultTo("info");
    table.text("actor").notNullable().defaultTo("orchestrator");
    table.bigInteger("actorUserId");
    table.text("requestId");
    table.text("message").notNullable();
    table.text("payloadJson").notNullable().defaultTo("{}");
    table.bigInteger("createdAt").notNullable();

    table
      .foreign("deploymentId", "fk_o_release_event_deployment")
      .references("id")
      .inTable(RELEASE_DEPLOYMENT_TABLE)
      .onDelete("RESTRICT");
    table
      .foreign("targetId", "fk_o_release_event_target")
      .references("id")
      .inTable(RELEASE_DEPLOYMENT_TARGET_TABLE)
      .onDelete("RESTRICT");
    table.unique(["deploymentId", "sequence"], RELEASE_DEPLOYMENT_EVENT_INDEXES.deploymentSequence);
    table.index(["deploymentId", "createdAt"], RELEASE_DEPLOYMENT_EVENT_INDEXES.deploymentCreated);
    table.index(["targetId", "createdAt"], RELEASE_DEPLOYMENT_EVENT_INDEXES.targetCreated);
    table.index(["deploymentId", "eventType", "createdAt"], RELEASE_DEPLOYMENT_EVENT_INDEXES.deploymentType);

    table.check('"sequence" >= 1', {}, "chk_o_release_event_sequence");
    table.check(`"level" IN (${quotedValues(EVENT_LEVELS)})`, {}, "chk_o_release_event_level");
    table.check(`"actor" IN (${quotedValues(EVENT_ACTORS)})`, {}, "chk_o_release_event_actor");
  });
}

async function ensureWorkerReleaseControl(trx: Knex.Transaction): Promise<void> {
  const hasWorkerHeartbeat = await trx.schema.hasTable(WORKER_HEARTBEAT_TABLE);
  const heartbeatColumns: Array<{
    name: string;
    add(table: Knex.CreateTableBuilder): void;
  }> = [
    { name: "nodeId", add: (table) => { table.text("nodeId"); } },
    { name: "incarnationId", add: (table) => { table.text("incarnationId"); } },
    { name: "releaseId", add: (table) => { table.text("releaseId"); } },
    { name: "artifactSha256", add: (table) => { table.text("artifactSha256"); } },
    { name: "schemaVersion", add: (table) => { table.bigInteger("schemaVersion"); } },
    { name: "acceptingWork", add: (table) => { table.bigInteger("acceptingWork"); } },
    { name: "activeTaskCount", add: (table) => { table.bigInteger("activeTaskCount"); } },
    { name: "drainOperationId", add: (table) => { table.text("drainOperationId"); } },
    { name: "controlRevision", add: (table) => { table.bigInteger("controlRevision"); } },
  ];
  const missing: typeof heartbeatColumns = [];
  if (hasWorkerHeartbeat) for (const column of heartbeatColumns) {
    if (!(await trx.schema.hasColumn(WORKER_HEARTBEAT_TABLE, column.name))) missing.push(column);
  }
  if (hasWorkerHeartbeat && missing.length) {
    await trx.schema.alterTable(WORKER_HEARTBEAT_TABLE, (table) => {
      for (const column of missing) column.add(table);
    });
  }

  if (await trx.schema.hasTable(WORKER_RELEASE_CONTROL_TABLE)) return;
  await trx.schema.createTable(WORKER_RELEASE_CONTROL_TABLE, (table) => {
    table.text("nodeId").notNullable().primary();
    table.text("desiredState").notNullable().defaultTo("running");
    table.text("operationId");
    table.bigInteger("requestedAt");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
    table.check('"desiredState" IN (\'running\', \'draining\')', {}, "chk_o_worker_release_state");
    table.check('"revision" >= 1', {}, "chk_o_worker_release_revision");
    table.check(
      '("desiredState" = \'running\' AND "operationId" IS NULL AND "requestedAt" IS NULL) OR '
        + '("desiredState" = \'draining\' AND "operationId" IS NOT NULL AND "requestedAt" IS NOT NULL)',
      {},
      "chk_o_worker_release_operation",
    );
  });
}

/**
 * Additive persistence for immutable packages and recoverable, one-at-a-time
 * rolling deployments. Secrets and executable SSH commands must never be
 * written to these audit tables; targetKey is resolved through server-side
 * deployment configuration and every payload is expected to be redacted.
 */
export async function upReleaseDeploymentOrchestration(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(PLATFORM_RELEASE_TABLE))) {
    throw new Error(
      `${PLATFORM_RELEASE_TABLE} is missing; apply platform_release before release_deployment_orchestration.`,
    );
  }
  await ensureArtifactTable(trx);
  await ensureDeploymentTable(trx);
  await ensureDeploymentTargetTable(trx);
  await ensureDeploymentEventTable(trx);
  await ensureWorkerReleaseControl(trx);
}

export async function downReleaseDeploymentOrchestration(): Promise<void> {
  throw new Error(
    "Migration release_deployment_orchestration cannot be rolled back safely because package provenance, rollout state, and deployment audit events must be retained.",
  );
}
