import type { Knex } from "knex";

import type {
  DatabaseMigration,
  DatabaseMigrationForwardCompatibility,
  DatabaseMigrationStatus,
  EnvironmentLike,
} from "@/lib/databaseMigrations";
import {
  DATABASE_MIGRATIONS,
  inspectDatabaseMigrations,
  prepareDatabaseForApplication,
  runtimeSchemaCompatibilityFromEnvironment,
} from "@/lib/databaseMigrations";
import {
  RELEASE_ARTIFACT_FORMAT,
  RELEASE_ARTIFACT_MANIFEST_VERSION,
} from "@/lib/releaseArtifactManifestContract";
import { getReleaseIdentity } from "@/lib/releaseIdentity";
import {
  RELEASE_ARTIFACT_TABLE,
  RELEASE_DEPLOYMENT_TABLE,
  WORKER_RELEASE_CONTROL_TABLE,
} from "@/lib/migrations/releaseDeploymentOrchestration";
import {
  releaseSchemaCompatibilityError,
  releaseSchemaCompatibilityProofSha256,
  schemaCompatibilitySupports,
} from "@/release-controller/schemaCompatibility";
import type {
  ReleaseSchemaCompatibility,
  ReleaseSchemaMode,
} from "@/release-controller/types";
import {
  decodeWorkerSchemaBridgeFence,
  workerSchemaBridgeFenceMatches,
} from "@/release-controller/workerSchemaBridge";

const MAX_CHECKPOINT_BYTES = 1_048_576;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

interface RuntimeArtifact {
  id: string;
  sha256: string;
  releaseId: string;
  sourceCommit: string;
  schemaVersion: number;
  schemaMode: ReleaseSchemaMode;
  schemaCompatibility: ReleaseSchemaCompatibility;
}

interface RuntimeDeploymentRow {
  id: unknown;
  artifactId: unknown;
  previousArtifactId: unknown;
  status: unknown;
  activeScope: unknown;
  environment: unknown;
  checkpointJson: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string")
    || new Set(value).size !== value.length
  ) {
    return null;
  }
  return value as string[];
}

function safeCheckpoint(value: unknown): Record<string, unknown> | null {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_CHECKPOINT_BYTES
  ) {
    return null;
  }
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function runtimeArtifact(rowValue: unknown): RuntimeArtifact | null {
  const row = record(rowValue);
  if (
    !row
    || row.status !== "ready"
    || !Number.isSafeInteger(Number(row.verifiedAt))
    || Number(row.verifiedAt) < 1
    || typeof row.id !== "string"
    || typeof row.releaseId !== "string"
    || typeof row.sourceCommit !== "string"
    || !SOURCE_COMMIT_RE.test(row.sourceCommit)
    || typeof row.sha256 !== "string"
    || !SHA256_RE.test(row.sha256)
    || typeof row.manifestJson !== "string"
    || Buffer.byteLength(row.manifestJson, "utf8") > MAX_CHECKPOINT_BYTES
  ) {
    return null;
  }
  let manifest: Record<string, unknown> | null;
  try {
    manifest = record(JSON.parse(row.manifestJson));
  } catch {
    return null;
  }
  if (
    !manifest
    || manifest.manifestVersion !== RELEASE_ARTIFACT_MANIFEST_VERSION
    || manifest.format !== RELEASE_ARTIFACT_FORMAT
    || typeof manifest.releaseId !== "string"
    || manifest.releaseId.length < 1
    || manifest.releaseId.length > 128
    || manifest.releaseId !== row.releaseId
    || manifest.sourceCommit !== row.sourceCommit
    || (manifest.schemaMode !== "schema-neutral"
      && manifest.schemaMode !== "migration")
    || !Number.isSafeInteger(manifest.schemaVersion)
    || Number(manifest.schemaVersion) < 1
  ) {
    return null;
  }
  const schemaMode = manifest.schemaMode;
  const schemaVersion = Number(manifest.schemaVersion);
  if (releaseSchemaCompatibilityError(
    schemaMode,
    schemaVersion,
    manifest.schemaCompatibility,
  )) {
    return null;
  }
  return {
    id: row.id,
    sha256: row.sha256,
    releaseId: manifest.releaseId,
    sourceCommit: row.sourceCommit,
    schemaVersion,
    schemaMode,
    schemaCompatibility:
      manifest.schemaCompatibility as ReleaseSchemaCompatibility,
  };
}

function checkpointArtifactMatches(
  value: unknown,
  artifact: RuntimeArtifact,
): boolean {
  const candidate = record(value);
  if (
    !candidate
    || candidate.id !== artifact.id
    || candidate.sha256 !== artifact.sha256
    || candidate.schemaVersion !== artifact.schemaVersion
    || candidate.schemaMode !== artifact.schemaMode
  ) {
    return false;
  }
  const compatibility = candidate.schemaCompatibility;
  return !releaseSchemaCompatibilityError(
    artifact.schemaMode,
    artifact.schemaVersion,
    compatibility,
  )
    && releaseSchemaCompatibilityProofSha256(
      compatibility as ReleaseSchemaCompatibility,
    ) === releaseSchemaCompatibilityProofSha256(
      artifact.schemaCompatibility,
    );
}

async function readActiveDeployment(
  database: Knex,
): Promise<RuntimeDeploymentRow | null> {
  if (
    !(await database.schema.hasTable(RELEASE_DEPLOYMENT_TABLE))
    || !(await database.schema.hasTable(RELEASE_ARTIFACT_TABLE))
  ) {
    return null;
  }
  const rows = await database<RuntimeDeploymentRow>(RELEASE_DEPLOYMENT_TABLE)
    .select(
      "id",
      "artifactId",
      "previousArtifactId",
      "status",
      "activeScope",
      "environment",
      "checkpointJson",
    )
    .whereNotNull("activeScope")
    .limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0];
  return (
    ["prod", "production"].includes(
      String(row.environment).trim().toLowerCase(),
    )
    && ["running", "cancelling", "degraded_manual"].includes(
      String(row.status),
    )
  )
    ? row
    : null;
}

async function readArtifact(
  database: Knex,
  id: unknown,
): Promise<RuntimeArtifact | null> {
  if (typeof id !== "string" || !id) return null;
  return runtimeArtifact(
    await database(RELEASE_ARTIFACT_TABLE)
      .select(
        "id",
        "releaseId",
        "sourceCommit",
        "sha256",
        "status",
        "verifiedAt",
        "manifestJson",
      )
      .where({ id })
      .first(),
  );
}

function manifestAttestsPreviousRuntime(input: {
  previous: RuntimeArtifact;
  release: ReturnType<typeof getReleaseIdentity>;
  fromVersion: number;
  toVersion: number;
}): boolean {
  const { previous, release, fromVersion, toVersion } = input;
  return previous.sha256 === release.artifactSha256
    && previous.releaseId === release.releaseId
    && previous.schemaVersion === fromVersion
    && previous.schemaMode === "schema-neutral"
    && previous.schemaCompatibility.migration === null
    && release.schemaVersion === fromVersion
    && release.schemaMode === "schema-neutral"
    && release.schemaCompatibility?.migration === null
    && schemaCompatibilitySupports(previous.schemaCompatibility, fromVersion)
    && schemaCompatibilitySupports(previous.schemaCompatibility, toVersion)
    && schemaCompatibilitySupports(release.schemaCompatibility, fromVersion)
    && schemaCompatibilitySupports(release.schemaCompatibility, toVersion)
    && release.schemaCompatibilityProofSha256
      === releaseSchemaCompatibilityProofSha256(
        previous.schemaCompatibility,
      );
}

function manifestAttestsTargetMigrationRuntime(input: {
  target: RuntimeArtifact;
  release: ReturnType<typeof getReleaseIdentity>;
  fromVersion: number;
  toVersion: number;
}): boolean {
  const { target, release, fromVersion, toVersion } = input;
  const migration = target.schemaCompatibility.migration;
  return target.sha256 === release.artifactSha256
    && target.releaseId === release.releaseId
    && target.sourceCommit === release.sourceCommit
    && target.schemaVersion === toVersion
    && target.schemaMode === "migration"
    && migration?.fromVersion === fromVersion
    && migration.toVersion === toVersion
    && release.schemaVersion === toVersion
    && release.schemaMode === "migration"
    && release.schemaCompatibility?.migration?.fromVersion === fromVersion
    && release.schemaCompatibility.migration.toVersion === toVersion
    && schemaCompatibilitySupports(target.schemaCompatibility, fromVersion)
    && schemaCompatibilitySupports(target.schemaCompatibility, toVersion)
    && schemaCompatibilitySupports(release.schemaCompatibility, fromVersion)
    && schemaCompatibilitySupports(release.schemaCompatibility, toVersion)
    && release.schemaCompatibilityProofSha256
      === releaseSchemaCompatibilityProofSha256(
        target.schemaCompatibility,
      );
}

function apiNodeFenceMatches(
  checkpoint: Record<string, unknown>,
  nodeId: string,
  previousSha256: string,
): boolean {
  const order = exactStringArray(checkpoint.nodeOrder);
  const nodes = record(checkpoint.nodes);
  const node = record(nodes?.[nodeId]);
  return Boolean(
    order
      && order.includes(nodeId)
      && node
      && node.nodeId === nodeId
      && node.previousArtifactSha256 === previousSha256
      && node.preflightComplete === true
      && node.activationAttempted === false
      && node.activated === false
      && node.completed === false
      && node.isolated === false,
  );
}

async function workerNodeFenceMatches(
  database: Knex,
  checkpoint: Record<string, unknown>,
  nodeId: string,
  operationId: string,
  previous: RuntimeArtifact,
  fromVersion: number,
  toVersion: number,
): Promise<boolean> {
  const order = exactStringArray(checkpoint.workerOrder);
  const workers = record(checkpoint.workers);
  const worker = record(workers?.[nodeId]);
  if (
    !order
    || !order.includes(nodeId)
    || !worker
    || worker.nodeId !== nodeId
    || worker.previousArtifactSha256 !== previous.sha256
    || worker.preflightComplete !== true
    || worker.bridgeAuthorized !== true
    || worker.activationAttempted !== false
    || worker.activated !== false
    || worker.completed !== false
    || worker.isolated !== false
    || !(await database.schema.hasTable(WORKER_RELEASE_CONTROL_TABLE))
  ) {
    return false;
  }
  const control = await database(WORKER_RELEASE_CONTROL_TABLE)
    .select("desiredState", "operationId")
    .where({ nodeId })
    .first();
  const fence = decodeWorkerSchemaBridgeFence(control?.operationId);
  return control?.desiredState === "draining"
    && Boolean(fence)
    && workerSchemaBridgeFenceMatches({
      fence: fence!,
      operationId,
      artifactSha256: previous.sha256,
      artifactSchemaVersion: fromVersion,
      observedDatabaseSchemaVersion: fromVersion,
      compatibility: previous.schemaCompatibility,
    })
    && fence!.fromVersion === fromVersion
    && fence!.toVersion === toVersion;
}

function targetWorkerBootstrapProgressMatches(
  worker: Record<string, unknown>,
): boolean {
  const booleanFields = [
    "preflightComplete",
    "staged",
    "capacityConfirmed",
    "drainRequested",
    "drained",
    "activationAttempted",
    "activated",
    "artifactReady",
    "bridgeAuthorized",
    "bridgeFinalized",
    "resumed",
    "serving",
    "completed",
    "isolated",
    "rolledBack",
    "rollbackVerified",
  ];
  if (booleanFields.some((field) => typeof worker[field] !== "boolean")) {
    return false;
  }
  if (
    worker.preflightComplete !== true
    || worker.staged !== true
    || worker.capacityConfirmed !== true
    || worker.drainRequested !== true
    || worker.drained !== true
    || worker.activationAttempted !== true
    || worker.bridgeAuthorized !== true
    || worker.bridgeFinalized !== false
    || worker.rolledBack !== false
    || worker.rollbackVerified !== false
  ) {
    return false;
  }
  if (
    worker.activated !== true
    && (
      worker.artifactReady === true
      || worker.resumed === true
      || worker.serving === true
      || worker.completed === true
    )
  ) {
    return false;
  }
  if (
    worker.artifactReady === true
    && worker.activated !== true
  ) {
    return false;
  }
  if (
    worker.resumed === true
    && (worker.activated !== true || worker.artifactReady !== true)
  ) {
    return false;
  }
  if (
    worker.serving === true
    && (
      worker.activated !== true
      || worker.artifactReady !== true
      || worker.resumed !== true
      || worker.isolated !== false
    )
  ) {
    return false;
  }
  if (
    worker.completed === true
    && (
      worker.activated !== true
      || worker.artifactReady !== true
      || worker.resumed !== true
      || worker.serving !== true
      || worker.isolated !== false
    )
  ) {
    return false;
  }
  return worker.serving === true || worker.isolated === true;
}

async function targetMigrationWorkerFenceMatches(
  database: Knex,
  checkpoint: Record<string, unknown>,
  nodeId: string,
  operationId: string,
  target: RuntimeArtifact,
  previous: RuntimeArtifact,
  fromVersion: number,
  toVersion: number,
): Promise<boolean> {
  const order = exactStringArray(checkpoint.workerOrder);
  const workers = record(checkpoint.workers);
  const worker = record(workers?.[nodeId]);
  if (
    !order
    || order.length < 2
    || order[0] !== nodeId
    || !workers
    || Object.keys(workers).length !== order.length
    || order.some((candidate) => !record(workers[candidate]))
    || !worker
    || worker.nodeId !== nodeId
    || worker.previousArtifactSha256 !== previous.sha256
    || !targetWorkerBootstrapProgressMatches(worker)
    || (
      worker.completed === true
        ? checkpoint.currentNodeId !== null
          && checkpoint.currentNodeId !== nodeId
        : checkpoint.currentNodeId !== nodeId
    )
    || !(await database.schema.hasTable(WORKER_RELEASE_CONTROL_TABLE))
  ) {
    return false;
  }
  const control = await database(WORKER_RELEASE_CONTROL_TABLE)
    .select("desiredState", "operationId")
    .where({ nodeId })
    .first();
  const fence = decodeWorkerSchemaBridgeFence(control?.operationId);
  return control?.desiredState === "draining"
    && Boolean(fence)
    && workerSchemaBridgeFenceMatches({
      fence: fence!,
      operationId,
      artifactSha256: target.sha256,
      artifactSchemaVersion: toVersion,
      observedDatabaseSchemaVersion: fromVersion,
      compatibility: target.schemaCompatibility,
    })
    && fence!.fromVersion === fromVersion
    && fence!.toVersion === toVersion;
}

function exactTargetBootstrapMigrationStatus(
  status: DatabaseMigrationStatus,
  migrationDefinitions: readonly DatabaseMigration[],
  fromVersion: number,
  toVersion: number,
): boolean {
  const appliedVersion = status.applied.at(-1)?.version ?? 0;
  const targetVersion = migrationDefinitions.at(-1)?.version ?? 0;
  return status.tableExists
    && !status.current
    && appliedVersion === fromVersion
    && targetVersion === toVersion
    && status.pending.length === toVersion - fromVersion
    && status.pending.every(
      (migration, index) => migration.version === fromVersion + index + 1,
    );
}

/**
 * Resolve the one pre-DDL startup exception for the first target migration
 * Worker. Unlike N-1 forward compatibility, this does not alter ordinary
 * inspection semantics: it only lets dbReady return the strictly inspected
 * fromVersion status while an exact target bridge fence is active.
 */
export async function resolveTargetMigrationWorkerBootstrap(
  database: Knex,
  environment: EnvironmentLike = process.env,
  migrationDefinitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): Promise<DatabaseMigrationStatus | null> {
  try {
    const role = String(environment.FANJIN_PROCESS_ROLE || "")
      .trim()
      .toLowerCase();
    const nodeEnvironment = String(environment.NODE_ENV || "")
      .trim()
      .toLowerCase();
    const topology = String(
      environment.FANJIN_RELEASE_WORKER_TOPOLOGY || "",
    ).trim().toLowerCase();
    const nodeId = String(
      environment.FANJIN_RELEASE_NODE_ID
        || environment.FANJIN_NODE_ID
        || "",
    ).trim();
    const hasImmutableManifest = Boolean(
      String(environment.FANJIN_RELEASE_MANIFEST_FILE || "").trim()
        || String(environment.FANJIN_APP_ROOT || "").trim(),
    );
    const hasImmutableArchiveMetadata = Boolean(
      String(environment.FANJIN_RELEASE_META_FILE || "").trim(),
    );
    if (
      (nodeEnvironment !== "prod" && nodeEnvironment !== "production")
      || role !== "worker"
      || topology !== "dedicated"
      || !NODE_ID_RE.test(nodeId)
      || !hasImmutableManifest
      || !hasImmutableArchiveMetadata
      || String(environment.FANJIN_AUTO_MIGRATE || "").trim() === "1"
    ) {
      return null;
    }

    const release = getReleaseIdentity(environment);
    if (
      !release.releaseId
      || !release.sourceCommit
      || !SOURCE_COMMIT_RE.test(release.sourceCommit)
      || !release.artifactSha256
      || release.schemaVersion === null
      || release.schemaMode !== "migration"
      || !release.schemaCompatibility
      || !release.schemaCompatibilityProofSha256
    ) {
      return null;
    }

    const deployment = await readActiveDeployment(database);
    const checkpoint = safeCheckpoint(deployment?.checkpointJson);
    if (
      !deployment
      || !checkpoint
      || typeof deployment.id !== "string"
      || deployment.status !== "running"
      || deployment.activeScope == null
      || checkpoint.operationId !== deployment.id
      || checkpoint.schemaMode !== "migration"
      || !["worker-rolling", "schema-migration"].includes(
        String(checkpoint.phase),
      )
      || checkpoint.status !== "running"
      || typeof checkpoint.schemaMigrationAttempted !== "boolean"
      || checkpoint.schemaMigrationComplete !== false
      || checkpoint.preflightComplete !== true
      || checkpoint.stageComplete !== true
      || checkpoint.workerPreflightComplete !== true
      || checkpoint.workerStageComplete !== true
      || checkpoint.workerRollingComplete !== false
    ) {
      return null;
    }

    const [target, previous] = await Promise.all([
      readArtifact(database, deployment.artifactId),
      readArtifact(database, deployment.previousArtifactId),
    ]);
    const migration = target?.schemaCompatibility.migration;
    if (
      !target
      || !previous
      || target.id !== deployment.artifactId
      || previous.id !== deployment.previousArtifactId
      || target.schemaMode !== "migration"
      || previous.schemaMode !== "schema-neutral"
      || previous.schemaCompatibility.migration !== null
      || !migration
      || migration.fromVersion !== previous.schemaVersion
      || migration.toVersion !== target.schemaVersion
      || !checkpointArtifactMatches(checkpoint.artifact, target)
      || !checkpointArtifactMatches(checkpoint.previousArtifact, previous)
      || !manifestAttestsTargetMigrationRuntime({
        target,
        release,
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
      })
      || !(await targetMigrationWorkerFenceMatches(
        database,
        checkpoint,
        nodeId,
        deployment.id,
        target,
        previous,
        migration.fromVersion,
        migration.toVersion,
      ))
    ) {
      return null;
    }

    const status = await inspectDatabaseMigrations(
      database,
      migrationDefinitions,
    );
    return exactTargetBootstrapMigrationStatus(
      status,
      migrationDefinitions,
      migration.fromVersion,
      migration.toVersion,
    )
      ? status
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the only production exception that may let N-1 observe schema N.
 *
 * The local immutable manifest is cross-checked with the server-verified
 * previous artifact, the signed target migration contract, the active
 * deployment checkpoint, exact node identity, and (for Workers) the node's
 * durable bridge fence. Any missing or malformed evidence returns null so the
 * ordinary migration inspector remains fail closed.
 */
export async function resolveRuntimeDatabaseForwardCompatibility(
  database: Knex,
  environment: EnvironmentLike = process.env,
): Promise<DatabaseMigrationForwardCompatibility | null> {
  try {
    const role = String(environment.FANJIN_PROCESS_ROLE || "")
      .trim()
      .toLowerCase();
    const nodeEnvironment = String(environment.NODE_ENV || "")
      .trim()
      .toLowerCase();
    const topology = String(
      environment.FANJIN_RELEASE_WORKER_TOPOLOGY || "",
    ).trim().toLowerCase();
    const nodeId = String(
      environment.FANJIN_RELEASE_NODE_ID
        || environment.FANJIN_NODE_ID
        || "",
    ).trim();
    const hasImmutableManifest = Boolean(
      String(environment.FANJIN_RELEASE_MANIFEST_FILE || "").trim()
        || String(environment.FANJIN_APP_ROOT || "").trim(),
    );
    if (
      (nodeEnvironment !== "prod" && nodeEnvironment !== "production")
      || (role !== "api" && role !== "worker")
      || topology !== "dedicated"
      || !NODE_ID_RE.test(nodeId)
      || !hasImmutableManifest
    ) {
      return null;
    }

    const release = getReleaseIdentity(environment);
    if (
      !release.releaseId
      || !release.artifactSha256
      || release.schemaVersion === null
      || release.schemaMode !== "schema-neutral"
      || !release.schemaCompatibility
      || !release.schemaCompatibilityProofSha256
    ) {
      return null;
    }

    const deployment = await readActiveDeployment(database);
    const checkpoint = safeCheckpoint(deployment?.checkpointJson);
    if (
      !deployment
      || !checkpoint
      || typeof deployment.id !== "string"
      || deployment.activeScope == null
      || checkpoint.operationId !== deployment.id
      || checkpoint.schemaMode !== "migration"
      || !["schema-migration", "rolling", "worker-rolling", "failed"].includes(
        String(checkpoint.phase),
      )
      || (checkpoint.status !== "running" && checkpoint.status !== "failed")
      || checkpoint.schemaMigrationAttempted !== true
      || checkpoint.preflightComplete !== true
      || checkpoint.stageComplete !== true
      || checkpoint.workerPreflightComplete !== true
      || checkpoint.workerStageComplete !== true
    ) {
      return null;
    }

    const [target, previous] = await Promise.all([
      readArtifact(database, deployment.artifactId),
      readArtifact(database, deployment.previousArtifactId),
    ]);
    const migration = target?.schemaCompatibility.migration;
    if (
      !target
      || !previous
      || target.id !== deployment.artifactId
      || previous.id !== deployment.previousArtifactId
      || target.schemaMode !== "migration"
      || !migration
      || migration.fromVersion !== previous.schemaVersion
      || migration.toVersion !== target.schemaVersion
      || !checkpointArtifactMatches(checkpoint.artifact, target)
      || !checkpointArtifactMatches(checkpoint.previousArtifact, previous)
      || !manifestAttestsPreviousRuntime({
        previous,
        release,
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
      })
    ) {
      return null;
    }

    const nodeFenceMatches = role === "api"
      ? apiNodeFenceMatches(checkpoint, nodeId, previous.sha256)
      : await workerNodeFenceMatches(
          database,
          checkpoint,
          nodeId,
          deployment.id,
          previous,
          migration.fromVersion,
          migration.toVersion,
        );
    if (!nodeFenceMatches) return null;

    return {
      contractVersion: "fanjin-database-forward-compatibility.v1",
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
    };
  } catch {
    return null;
  }
}

export async function inspectRuntimeDatabaseMigrations(
  database: Knex,
  environment: EnvironmentLike = process.env,
  migrationDefinitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): Promise<DatabaseMigrationStatus> {
  try {
    // The same immutable per-binary declaration used at startup must also
    // govern ongoing health/Worker heartbeat checks after an online expansion.
    return await inspectDatabaseMigrations(database, migrationDefinitions, {
      runtimeCompatibility: runtimeSchemaCompatibilityFromEnvironment(environment),
    });
  } catch (strictError) {
    const forwardCompatibility =
      await resolveRuntimeDatabaseForwardCompatibility(database, environment);
    if (!forwardCompatibility) throw strictError;
    return inspectDatabaseMigrations(
      database,
      migrationDefinitions,
      { forwardCompatibility },
    );
  }
}

export async function prepareDatabaseForRuntimeApplication(
  database: Knex,
  environment: EnvironmentLike = process.env,
  migrationDefinitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): Promise<DatabaseMigrationStatus> {
  try {
    return await prepareDatabaseForApplication(
      database,
      environment,
      migrationDefinitions,
    );
  } catch (strictError) {
    const forwardCompatibility =
      await resolveRuntimeDatabaseForwardCompatibility(database, environment);
    if (forwardCompatibility) {
      return prepareDatabaseForApplication(
        database,
        environment,
        migrationDefinitions,
        { forwardCompatibility },
      );
    }
    const targetWorkerBootstrap =
      await resolveTargetMigrationWorkerBootstrap(
        database,
        environment,
        migrationDefinitions,
      );
    if (targetWorkerBootstrap) return targetWorkerBootstrap;
    throw strictError;
  }
}
