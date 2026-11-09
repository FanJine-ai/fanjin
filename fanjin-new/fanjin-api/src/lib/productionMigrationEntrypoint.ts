import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { Knex } from "knex";

import {
  DATABASE_MIGRATIONS,
  inspectDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationStatus,
  type MigrationRunnerTimeouts,
} from "@/lib/databaseMigrations";
import { isPostgresClient } from "@/lib/dbDialect";
import { RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV } from "@/lib/releaseArtifactAttestation";
import {
  isApprovedAdditiveSchemaWindow,
  type ReleaseSchemaCompatibilityV1,
} from "@/lib/releaseSchemaCompatibility";
import { verifyCachedMigrationArtifactProvenance } from "@/release-controller/artifactAttestation";
import type { CachedMigrationArtifactProvenance } from "@/release-controller/artifactAttestation";
import { KnexReleaseSchemaMigrator } from "@/release-controller/releaseSchemaMigrator";

const SHA256_RE = /^[a-f0-9]{64}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const OPERATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
export const PRODUCTION_MIGRATION_TRUSTED_KEYS_FILE =
  "/etc/fanjin/release-attestation-public-keys.json";
export const PRODUCTION_MAINTENANCE_BOOTSTRAP_APPROVAL =
  "v0.0.7-schema-34-to-40" as const;
export const PRODUCTION_MAINTENANCE_BOOTSTRAP_FROM_VERSION = 34;
export const PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION = 40;
export const PRODUCTION_MAINTENANCE_UPGRADE_APPROVAL =
  "v0.1.1-schema-40-to-48" as const;
export const PRODUCTION_MAINTENANCE_UPGRADE_FROM_VERSION = 40;
export const PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION = 48;
// This maintenance entrypoint is an immutable historical schema 40 -> 48
// contract. Additive migrations introduced by later releases must use the
// adjacent-generation entrypoint instead of changing its checksum chain.
export const PRODUCTION_MAINTENANCE_UPGRADE_DATABASE_MIGRATIONS = Object.freeze(
  DATABASE_MIGRATIONS.slice(0, PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION),
);
export const PRODUCTION_014_MAINTENANCE_UPGRADE_APPROVAL =
  "v0.1.4-schema-50-to-52" as const;
export const PRODUCTION_014_MAINTENANCE_UPGRADE_FROM_VERSION = 50;
export const PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION = 52;
// 0.1.4 has its own immutable maintenance contract. Do not widen the
// historical 0.1.1 schema 40 -> 48 entrypoint or reuse its approval switch.
export const PRODUCTION_014_MAINTENANCE_UPGRADE_DATABASE_MIGRATIONS =
  Object.freeze(
    DATABASE_MIGRATIONS.slice(0, PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION),
  );
const MAX_TRUST_STORE_BYTES = 64 * 1024;

export interface ProductionMigrationEntrypointConfiguration {
  runId: string;
  artifactSha256: string;
  artifactArchivePath: string;
  trustedKeysFile: typeof PRODUCTION_MIGRATION_TRUSTED_KEYS_FILE;
  operatorIdentity: string;
  checkpointDirectory: string;
  expectedFromVersion: number;
  expectedToVersion: number;
  timeouts: MigrationRunnerTimeouts;
}

export class ProductionMigrationEntrypointError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProductionMigrationEntrypointError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductionMigrationEntrypointError(code, message);
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = String(environment[name] || "").trim();
  if (!value) fail("PRODUCTION_MIGRATION_CONFIGURATION_REQUIRED", `${name} is required`);
  return value;
}

function requiredVersion(
  environment: NodeJS.ProcessEnv,
  name: string,
): number {
  const raw = requiredEnvironment(environment, name);
  if (!/^[1-9][0-9]*$/.test(raw)) {
    fail("PRODUCTION_MIGRATION_SCHEMA_VERSION_INVALID", `${name} is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail("PRODUCTION_MIGRATION_SCHEMA_VERSION_INVALID", `${name} is invalid`);
  }
  return value;
}

function requiredTimeout(
  environment: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = requiredEnvironment(environment, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    fail("PRODUCTION_MIGRATION_TIMEOUT_INVALID", `${name} is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("PRODUCTION_MIGRATION_TIMEOUT_INVALID", `${name} is invalid`);
  }
  return value;
}

function loadProductionMigrationConfiguration(
  environment: NodeJS.ProcessEnv,
  mode:
    | "adjacent"
    | "maintenance-bootstrap"
    | "maintenance-upgrade"
    | "maintenance-0.1.4",
): ProductionMigrationEntrypointConfiguration {
  const runId = requiredEnvironment(environment, "FANJIN_MIGRATION_RUN_ID");
  const artifactSha256 = requiredEnvironment(
    environment,
    "FANJIN_MIGRATION_ARTIFACT_SHA256",
  );
  const artifactArchivePath = requiredEnvironment(
    environment,
    "FANJIN_MIGRATION_ARTIFACT_ARCHIVE_PATH",
  );
  const trustedKeysFile = requiredEnvironment(
    environment,
    "FANJIN_MIGRATION_ATTESTATION_TRUSTED_KEYS_FILE",
  );
  const operatorIdentity = requiredEnvironment(
    environment,
    "FANJIN_MIGRATION_OPERATOR",
  );
  const checkpointDirectory = requiredEnvironment(
    environment,
    "FANJIN_MIGRATION_CHECKPOINT_DIR",
  );
  const expectedFromVersion = requiredVersion(
    environment,
    "FANJIN_MIGRATION_EXPECTED_FROM_VERSION",
  );
  const expectedToVersion = requiredVersion(
    environment,
    "FANJIN_MIGRATION_EXPECTED_TO_VERSION",
  );
  const lockTimeoutMs = requiredTimeout(
    environment,
    "FANJIN_MIGRATION_LOCK_TIMEOUT_MS",
    100,
    300_000,
  );
  const lockPollIntervalMs = requiredTimeout(
    environment,
    "FANJIN_MIGRATION_LOCK_POLL_INTERVAL_MS",
    10,
    5_000,
  );
  const statementTimeoutMs = requiredTimeout(
    environment,
    "FANJIN_MIGRATION_STATEMENT_TIMEOUT_MS",
    1_000,
    900_000,
  );
  const idleInTransactionTimeoutMs = requiredTimeout(
    environment,
    "FANJIN_MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT_MS",
    1_000,
    900_000,
  );
  const overallTimeoutMs = requiredTimeout(
    environment,
    "FANJIN_MIGRATION_OVERALL_TIMEOUT_MS",
    1_000,
    3_600_000,
  );

  if (!RUN_ID_RE.test(runId)) {
    fail("PRODUCTION_MIGRATION_RUN_ID_INVALID", "migration run identity is invalid");
  }
  if (!SHA256_RE.test(artifactSha256)) {
    fail("PRODUCTION_MIGRATION_ARTIFACT_INVALID", "artifact sha256 is invalid");
  }
  if (!OPERATOR_RE.test(operatorIdentity)) {
    fail("PRODUCTION_MIGRATION_OPERATOR_INVALID", "operator identity is invalid");
  }
  if (
    !path.isAbsolute(artifactArchivePath)
    || path.normalize(artifactArchivePath) !== artifactArchivePath
  ) {
    fail(
      "PRODUCTION_MIGRATION_ARTIFACT_PATH_INVALID",
      "artifact archive path must be a normalized absolute path",
    );
  }
  if (trustedKeysFile !== PRODUCTION_MIGRATION_TRUSTED_KEYS_FILE) {
    fail(
      "PRODUCTION_MIGRATION_TRUST_STORE_PATH_INVALID",
      "migration attestation trust store path is not the protected system path",
    );
  }
  if (
    !path.isAbsolute(checkpointDirectory)
    || path.normalize(checkpointDirectory) !== checkpointDirectory
  ) {
    fail(
      "PRODUCTION_MIGRATION_CHECKPOINT_DIRECTORY_INVALID",
      "checkpoint directory must be a normalized absolute path",
    );
  }
  if (
    mode === "adjacent"
    && expectedToVersion !== expectedFromVersion + 1
  ) {
    fail(
      "PRODUCTION_MIGRATION_NON_ADJACENT_PATH_REFUSED",
      "production migration entrypoint accepts one exact adjacent generation only",
    );
  }
  if (
    mode === "maintenance-bootstrap"
    && (
      environment.FANJIN_MIGRATION_MAINTENANCE_BOOTSTRAP
        !== PRODUCTION_MAINTENANCE_BOOTSTRAP_APPROVAL
      || expectedFromVersion !== PRODUCTION_MAINTENANCE_BOOTSTRAP_FROM_VERSION
      || expectedToVersion !== PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION
    )
  ) {
    fail(
      "PRODUCTION_MIGRATION_MAINTENANCE_BOOTSTRAP_REFUSED",
      "maintenance bootstrap requires the exact reviewed v0.0.7 schema 34 to 40 contract",
    );
  }
  if (
    mode === "maintenance-upgrade"
    && (
      environment.FANJIN_MIGRATION_MAINTENANCE_UPGRADE
        !== PRODUCTION_MAINTENANCE_UPGRADE_APPROVAL
      || expectedFromVersion !== PRODUCTION_MAINTENANCE_UPGRADE_FROM_VERSION
      || expectedToVersion !== PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION
    )
  ) {
    fail(
      "PRODUCTION_MIGRATION_MAINTENANCE_UPGRADE_REFUSED",
      "maintenance upgrade requires the exact reviewed v0.1.1 schema 40 to 48 contract",
    );
  }
  if (
    mode === "maintenance-0.1.4"
    && (
      environment.FANJIN_MIGRATION_0_1_4_MAINTENANCE_UPGRADE
        !== PRODUCTION_014_MAINTENANCE_UPGRADE_APPROVAL
      || expectedFromVersion !== PRODUCTION_014_MAINTENANCE_UPGRADE_FROM_VERSION
      || expectedToVersion !== PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    )
  ) {
    fail(
      "PRODUCTION_MIGRATION_0_1_4_MAINTENANCE_UPGRADE_REFUSED",
      "0.1.4 maintenance upgrade requires the exact reviewed schema 50 to 52 contract",
    );
  }
  if (
    lockPollIntervalMs > lockTimeoutMs
    || overallTimeoutMs
      < lockTimeoutMs
        + lockPollIntervalMs
        + Math.max(statementTimeoutMs, idleInTransactionTimeoutMs)
  ) {
    fail(
      "PRODUCTION_MIGRATION_TIMEOUT_INVALID",
      "production migration timeout ordering is invalid",
    );
  }

  return {
    runId,
    artifactSha256,
    artifactArchivePath,
    trustedKeysFile,
    operatorIdentity,
    checkpointDirectory,
    expectedFromVersion,
    expectedToVersion,
    timeouts: {
      lockTimeoutMs,
      lockPollIntervalMs,
      statementTimeoutMs,
      idleInTransactionTimeoutMs,
      overallTimeoutMs,
    },
  };
}

export function loadProductionMigrationEntrypointConfiguration(
  environment: NodeJS.ProcessEnv,
): ProductionMigrationEntrypointConfiguration {
  return loadProductionMigrationConfiguration(environment, "adjacent");
}

export function loadProductionMaintenanceBootstrapConfiguration(
  environment: NodeJS.ProcessEnv,
): ProductionMigrationEntrypointConfiguration {
  return loadProductionMigrationConfiguration(environment, "maintenance-bootstrap");
}

export function loadProductionMaintenanceUpgradeConfiguration(
  environment: NodeJS.ProcessEnv,
): ProductionMigrationEntrypointConfiguration {
  return loadProductionMigrationConfiguration(environment, "maintenance-upgrade");
}

export function loadProduction014MaintenanceUpgradeConfiguration(
  environment: NodeJS.ProcessEnv,
): ProductionMigrationEntrypointConfiguration {
  return loadProductionMigrationConfiguration(environment, "maintenance-0.1.4");
}

async function readProtectedMigrationTrustStore(
  filePath: typeof PRODUCTION_MIGRATION_TRUSTED_KEYS_FILE,
): Promise<string> {
  let original;
  let canonicalPath: string;
  let canonical;
  try {
    original = await fs.lstat(filePath);
    canonicalPath = await fs.realpath(filePath);
    canonical = await fs.lstat(canonicalPath);
  } catch {
    return fail(
      "PRODUCTION_MIGRATION_TRUST_STORE_UNAVAILABLE",
      "protected migration attestation trust store is unavailable",
    );
  }
  if (
    canonicalPath !== filePath
    || original.isSymbolicLink()
    || canonical.isSymbolicLink()
    || !original.isFile()
    || !canonical.isFile()
    || original.dev !== canonical.dev
    || original.ino !== canonical.ino
    || canonical.uid !== 0
    || canonical.nlink !== 1
    || (canonical.mode & 0o777) !== 0o444
    || canonical.size < 2
    || canonical.size > MAX_TRUST_STORE_BYTES
  ) {
    return fail(
      "PRODUCTION_MIGRATION_TRUST_STORE_UNSAFE",
      "protected migration attestation trust store is unsafe",
    );
  }
  let handle;
  try {
    handle = await fs.open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (
      opened.dev !== canonical.dev
      || opened.ino !== canonical.ino
      || opened.size !== canonical.size
    ) {
      return fail(
        "PRODUCTION_MIGRATION_TRUST_STORE_CHANGED",
        "migration attestation trust store changed during validation",
      );
    }
    const raw = await handle.readFile("utf8");
    const final = await fs.lstat(canonicalPath);
    if (
      final.dev !== canonical.dev
      || final.ino !== canonical.ino
      || final.size !== canonical.size
      || final.mtimeMs !== canonical.mtimeMs
    ) {
      return fail(
        "PRODUCTION_MIGRATION_TRUST_STORE_CHANGED",
        "migration attestation trust store changed during validation",
      );
    }
    return raw;
  } catch (error) {
    if (error instanceof ProductionMigrationEntrypointError) throw error;
    return fail(
      "PRODUCTION_MIGRATION_TRUST_STORE_UNAVAILABLE",
      "protected migration attestation trust store cannot be read safely",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function assertProductionMigrationBaseline(
  status: DatabaseMigrationStatus,
  definitions: readonly DatabaseMigration[],
  configuration: ProductionMigrationEntrypointConfiguration,
): void {
  const target = definitions.at(-1);
  const pending = status.pending;
  if (
    !status.tableExists
    || status.current
    || status.databaseVersion !== configuration.expectedFromVersion
    || status.knownLatestVersion !== configuration.expectedToVersion
    || status.latestVersion !== configuration.expectedToVersion
    || target?.version !== configuration.expectedToVersion
    || pending.length !== 1
    || pending[0]?.version !== target.version
    || pending[0]?.name !== target.name
    || pending[0]?.checksum !== target.checksum
  ) {
    fail(
      "PRODUCTION_MIGRATION_BASELINE_MISMATCH",
      "database history is not the exact reviewed one-generation migration baseline",
    );
  }
}

/**
 * An adjacent production migration is authorized only by the signed native N
 * target artifact. Its manifest must bind the same repository-approved edge
 * that the already deployed N-1 outgoing bridge declared. This keeps the
 * migration runtime and the final target bytes identical while preventing an
 * outgoing compatibility artifact from being mistaken for the target.
 */
export function assertProductionMigrationArtifactProvenance(
  provenance: Pick<
    CachedMigrationArtifactProvenance,
    "schemaVersion" | "schemaCompatibility"
  >,
  configuration: Pick<
    ProductionMigrationEntrypointConfiguration,
    "expectedFromVersion" | "expectedToVersion"
  >,
): void {
  const compatibility: ReleaseSchemaCompatibilityV1 =
    provenance.schemaCompatibility;
  const migration = compatibility.migration;
  const nativeTarget = provenance.schemaVersion === configuration.expectedToVersion
    && compatibility.binarySchemaVersion === configuration.expectedToVersion
    && compatibility.supportedDatabaseVersions.length === 1
    && compatibility.supportedDatabaseVersions[0] === configuration.expectedToVersion
    && migration !== null
    && migration.fromVersion === configuration.expectedFromVersion
    && migration.toVersion === configuration.expectedToVersion
    && isApprovedAdditiveSchemaWindow(migration);
  if (!nativeTarget) {
    fail(
      "PRODUCTION_MIGRATION_ARTIFACT_PROVENANCE_MISMATCH",
      "signed artifact is not the native target for the expected approved migration generation",
    );
  }
}

export function assertProductionMaintenanceBootstrapBaseline(
  status: DatabaseMigrationStatus,
  definitions: readonly DatabaseMigration[],
  configuration: ProductionMigrationEntrypointConfiguration,
): void {
  const expectedApplied = definitions.slice(
    0,
    PRODUCTION_MAINTENANCE_BOOTSTRAP_FROM_VERSION,
  );
  const expectedPending = definitions.slice(
    PRODUCTION_MAINTENANCE_BOOTSTRAP_FROM_VERSION,
  );
  const sameIdentity = (
    observed: { version: number; name: string; checksum: string },
    expected: DatabaseMigration,
  ) => observed.version === expected.version
    && observed.name === expected.name
    && observed.checksum === expected.checksum;
  if (
    configuration.expectedFromVersion
      !== PRODUCTION_MAINTENANCE_BOOTSTRAP_FROM_VERSION
    || configuration.expectedToVersion
      !== PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION
    || definitions.length !== PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION
    || definitions.some((definition, index) => definition.version !== index + 1)
    || !status.tableExists
    || status.current
    || status.databaseVersion
      !== PRODUCTION_MAINTENANCE_BOOTSTRAP_FROM_VERSION
    || status.knownLatestVersion
      !== PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION
    || status.latestVersion
      !== PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION
    || status.applied.length !== expectedApplied.length
    || status.pending.length !== expectedPending.length
    || status.applied.some((entry, index) => (
      !sameIdentity(entry, expectedApplied[index]!)
    ))
    || status.pending.some((entry, index) => (
      !sameIdentity(entry, expectedPending[index]!)
    ))
  ) {
    fail(
      "PRODUCTION_MIGRATION_MAINTENANCE_BASELINE_MISMATCH",
      "database history is not the exact reviewed v0.0.7 schema 34 maintenance baseline",
    );
  }
}

export function assertProductionMaintenanceUpgradeBaseline(
  status: DatabaseMigrationStatus,
  definitions: readonly DatabaseMigration[],
  configuration: ProductionMigrationEntrypointConfiguration,
): void {
  const expectedApplied = definitions.slice(
    0,
    PRODUCTION_MAINTENANCE_UPGRADE_FROM_VERSION,
  );
  const expectedPending = definitions.slice(
    PRODUCTION_MAINTENANCE_UPGRADE_FROM_VERSION,
  );
  const sameIdentity = (
    observed: { version: number; name: string; checksum: string },
    expected: DatabaseMigration,
  ) => observed.version === expected.version
    && observed.name === expected.name
    && observed.checksum === expected.checksum;
  if (
    configuration.expectedFromVersion
      !== PRODUCTION_MAINTENANCE_UPGRADE_FROM_VERSION
    || configuration.expectedToVersion
      !== PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION
    || definitions.length !== PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION
    || definitions.some((definition, index) => definition.version !== index + 1)
    || !status.tableExists
    || status.current
    || status.databaseVersion
      !== PRODUCTION_MAINTENANCE_UPGRADE_FROM_VERSION
    || status.knownLatestVersion
      !== PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION
    || status.latestVersion
      !== PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION
    || status.applied.length !== expectedApplied.length
    || status.pending.length !== expectedPending.length
    || status.applied.some((entry, index) => (
      !sameIdentity(entry, expectedApplied[index]!)
    ))
    || status.pending.some((entry, index) => (
      !sameIdentity(entry, expectedPending[index]!)
    ))
  ) {
    fail(
      "PRODUCTION_MIGRATION_MAINTENANCE_UPGRADE_BASELINE_MISMATCH",
      "database history is not the exact reviewed v0.1.1 schema 40 maintenance baseline",
    );
  }
}

export function assertProduction014MaintenanceUpgradeBaseline(
  status: DatabaseMigrationStatus,
  definitions: readonly DatabaseMigration[],
  configuration: ProductionMigrationEntrypointConfiguration,
): void {
  const expectedApplied = definitions.slice(
    0,
    PRODUCTION_014_MAINTENANCE_UPGRADE_FROM_VERSION,
  );
  const expectedPending = definitions.slice(
    PRODUCTION_014_MAINTENANCE_UPGRADE_FROM_VERSION,
  );
  const sameIdentity = (
    observed: { version: number; name: string; checksum: string },
    expected: DatabaseMigration,
  ) => observed.version === expected.version
    && observed.name === expected.name
    && observed.checksum === expected.checksum;
  if (
    configuration.expectedFromVersion
      !== PRODUCTION_014_MAINTENANCE_UPGRADE_FROM_VERSION
    || configuration.expectedToVersion
      !== PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    || definitions.length !== PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    || definitions.some((definition, index) => definition.version !== index + 1)
    || !status.tableExists
    || status.current
    || status.databaseVersion
      !== PRODUCTION_014_MAINTENANCE_UPGRADE_FROM_VERSION
    || status.knownLatestVersion
      !== PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    || status.latestVersion
      !== PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    || status.applied.length !== expectedApplied.length
    || status.pending.length !== expectedPending.length
    || status.applied.some((entry, index) => (
      !sameIdentity(entry, expectedApplied[index]!)
    ))
    || status.pending.some((entry, index) => (
      !sameIdentity(entry, expectedPending[index]!)
    ))
  ) {
    fail(
      "PRODUCTION_MIGRATION_0_1_4_MAINTENANCE_BASELINE_MISMATCH",
      "database history is not the exact reviewed 0.1.4 schema 50 maintenance baseline",
    );
  }
}

export function assertProduction014MaintenanceArtifactProvenance(
  provenance: Pick<
    CachedMigrationArtifactProvenance,
    "schemaVersion" | "schemaCompatibility"
  >,
): void {
  const compatibility = provenance.schemaCompatibility;
  const migration = compatibility.migration;
  const nativeTarget =
    provenance.schemaVersion === PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    && compatibility.binarySchemaVersion
      === PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    && compatibility.supportedDatabaseVersions.length === 1
    && compatibility.supportedDatabaseVersions[0]
      === PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    // The signed target manifest proves the final native 51 -> 52 generation.
    // Exact 50 -> 51 and 51 -> 52 identities are independently pinned by the
    // compiled migration catalog and baseline assertion above.
    && migration?.fromVersion
      === PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION - 1
    && migration.toVersion === PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    && isApprovedAdditiveSchemaWindow(migration);
  if (!nativeTarget) {
    fail(
      "PRODUCTION_MIGRATION_0_1_4_ARTIFACT_PROVENANCE_MISMATCH",
      "signed artifact is not the native schema 52 target for the reviewed 0.1.4 maintenance contract",
    );
  }
}

export async function runProductionDatabaseMigrationUp(
  database: Knex,
  environment: NodeJS.ProcessEnv = process.env,
  definitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): Promise<DatabaseMigrationStatus> {
  const configuration = loadProductionMigrationEntrypointConfiguration(environment);
  const trustedKeys = await readProtectedMigrationTrustStore(
    configuration.trustedKeysFile,
  );
  const runtimeEntrypointPath = path.resolve(String(process.argv[1] || ""));
  const provenance = await verifyCachedMigrationArtifactProvenance({
    archivePath: configuration.artifactArchivePath,
    runtimeEntrypointPath,
    expectedArtifactSha256: configuration.artifactSha256,
    environment: {
      [RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV]: trustedKeys,
    },
  });
  if (provenance.artifactSha256 !== configuration.artifactSha256) {
    fail(
      "PRODUCTION_MIGRATION_ARTIFACT_PROVENANCE_MISMATCH",
      "signed artifact identity does not match the expected migration target",
    );
  }
  assertProductionMigrationArtifactProvenance(provenance, configuration);
  if (!isPostgresClient(database)) {
    fail(
      "PRODUCTION_MIGRATION_POSTGRES_REQUIRED",
      "production migration entrypoint requires PostgreSQL",
    );
  }

  const before = await inspectDatabaseMigrations(database, definitions);
  assertProductionMigrationBaseline(before, definitions, configuration);

  const migrator = new KnexReleaseSchemaMigrator({
    database,
    sourceCommit: provenance.sourceCommit,
    artifactSourceCommit: provenance.sourceCommit,
    operatorIdentity: configuration.operatorIdentity,
    artifactSha256: configuration.artifactSha256,
    checkpointDirectory: configuration.checkpointDirectory,
    migrationDefinitions: definitions,
    timeouts: configuration.timeouts,
  });
  const request = {
    runId: configuration.runId,
    fromVersion: configuration.expectedFromVersion,
    toVersion: configuration.expectedToVersion,
    artifactSha256: configuration.artifactSha256,
  };
  await migrator.apply(request, {
    operationId: configuration.runId,
    actionId: `production-schema-migration:${configuration.expectedFromVersion}-${configuration.expectedToVersion}`,
    artifactSha256: configuration.artifactSha256,
  });

  const after = await inspectDatabaseMigrations(database, definitions);
  if (
    !after.current
    || after.databaseVersion !== configuration.expectedToVersion
    || after.pending.length !== 0
  ) {
    fail(
      "PRODUCTION_MIGRATION_TERMINAL_VERIFICATION_FAILED",
      "database did not reach the exact expected schema generation",
    );
  }
  return after;
}

export async function runProductionMaintenanceBootstrap(
  database: Knex,
  environment: NodeJS.ProcessEnv = process.env,
  definitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): Promise<DatabaseMigrationStatus> {
  const configuration =
    loadProductionMaintenanceBootstrapConfiguration(environment);
  const trustedKeys = await readProtectedMigrationTrustStore(
    configuration.trustedKeysFile,
  );
  const runtimeEntrypointPath = path.resolve(String(process.argv[1] || ""));
  const provenance = await verifyCachedMigrationArtifactProvenance({
    archivePath: configuration.artifactArchivePath,
    runtimeEntrypointPath,
    runtimeManifestPath: "app/build/migrate-maintenance-bootstrap.js",
    expectedArtifactSha256: configuration.artifactSha256,
    environment: {
      [RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV]: trustedKeys,
    },
  });
  if (
    provenance.artifactSha256 !== configuration.artifactSha256
    || provenance.schemaVersion !== PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION
  ) {
    fail(
      "PRODUCTION_MIGRATION_ARTIFACT_PROVENANCE_MISMATCH",
      "signed artifact identity does not match the reviewed maintenance target",
    );
  }
  if (!isPostgresClient(database)) {
    fail(
      "PRODUCTION_MIGRATION_POSTGRES_REQUIRED",
      "production maintenance bootstrap requires PostgreSQL",
    );
  }

  const before = await inspectDatabaseMigrations(database, definitions);
  assertProductionMaintenanceBootstrapBaseline(
    before,
    definitions,
    configuration,
  );

  const migrator = new KnexReleaseSchemaMigrator({
    database,
    sourceCommit: provenance.sourceCommit,
    artifactSourceCommit: provenance.sourceCommit,
    operatorIdentity: configuration.operatorIdentity,
    artifactSha256: configuration.artifactSha256,
    checkpointDirectory: configuration.checkpointDirectory,
    migrationDefinitions: definitions,
    timeouts: configuration.timeouts,
  });
  const request = {
    runId: configuration.runId,
    fromVersion: PRODUCTION_MAINTENANCE_BOOTSTRAP_FROM_VERSION,
    toVersion: PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION,
    artifactSha256: configuration.artifactSha256,
  };
  await migrator.apply(request, {
    operationId: configuration.runId,
    actionId: "production-maintenance-bootstrap:34-40",
    artifactSha256: configuration.artifactSha256,
  });

  const after = await inspectDatabaseMigrations(database, definitions);
  if (
    !after.current
    || after.databaseVersion !== PRODUCTION_MAINTENANCE_BOOTSTRAP_TO_VERSION
    || after.pending.length !== 0
  ) {
    fail(
      "PRODUCTION_MIGRATION_TERMINAL_VERIFICATION_FAILED",
      "database did not reach the exact maintenance bootstrap target",
    );
  }
  return after;
}

export async function runProductionMaintenanceUpgrade(
  database: Knex,
  environment: NodeJS.ProcessEnv = process.env,
  definitions: readonly DatabaseMigration[] =
    PRODUCTION_MAINTENANCE_UPGRADE_DATABASE_MIGRATIONS,
): Promise<DatabaseMigrationStatus> {
  const configuration =
    loadProductionMaintenanceUpgradeConfiguration(environment);
  const trustedKeys = await readProtectedMigrationTrustStore(
    configuration.trustedKeysFile,
  );
  const runtimeEntrypointPath = path.resolve(String(process.argv[1] || ""));
  const provenance = await verifyCachedMigrationArtifactProvenance({
    archivePath: configuration.artifactArchivePath,
    runtimeEntrypointPath,
    runtimeManifestPath: "app/build/migrate-maintenance-upgrade.js",
    expectedArtifactSha256: configuration.artifactSha256,
    environment: {
      [RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV]: trustedKeys,
    },
  });
  if (
    provenance.artifactSha256 !== configuration.artifactSha256
    || provenance.schemaVersion !== PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION
  ) {
    fail(
      "PRODUCTION_MIGRATION_ARTIFACT_PROVENANCE_MISMATCH",
      "signed artifact identity does not match the reviewed maintenance upgrade target",
    );
  }
  if (!isPostgresClient(database)) {
    fail(
      "PRODUCTION_MIGRATION_POSTGRES_REQUIRED",
      "production maintenance upgrade requires PostgreSQL",
    );
  }

  const before = await inspectDatabaseMigrations(database, definitions);
  assertProductionMaintenanceUpgradeBaseline(
    before,
    definitions,
    configuration,
  );

  const migrator = new KnexReleaseSchemaMigrator({
    database,
    sourceCommit: provenance.sourceCommit,
    artifactSourceCommit: provenance.sourceCommit,
    operatorIdentity: configuration.operatorIdentity,
    artifactSha256: configuration.artifactSha256,
    checkpointDirectory: configuration.checkpointDirectory,
    migrationDefinitions: definitions,
    timeouts: configuration.timeouts,
  });
  const request = {
    runId: configuration.runId,
    fromVersion: PRODUCTION_MAINTENANCE_UPGRADE_FROM_VERSION,
    toVersion: PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION,
    artifactSha256: configuration.artifactSha256,
  };
  await migrator.apply(request, {
    operationId: configuration.runId,
    actionId: "production-maintenance-upgrade:40-48",
    artifactSha256: configuration.artifactSha256,
  });

  const after = await inspectDatabaseMigrations(database, definitions);
  if (
    !after.current
    || after.databaseVersion !== PRODUCTION_MAINTENANCE_UPGRADE_TO_VERSION
    || after.pending.length !== 0
  ) {
    fail(
      "PRODUCTION_MIGRATION_TERMINAL_VERIFICATION_FAILED",
      "database did not reach the exact maintenance upgrade target",
    );
  }
  return after;
}

export async function runProduction014MaintenanceUpgrade(
  database: Knex,
  environment: NodeJS.ProcessEnv = process.env,
  definitions: readonly DatabaseMigration[] =
    PRODUCTION_014_MAINTENANCE_UPGRADE_DATABASE_MIGRATIONS,
): Promise<DatabaseMigrationStatus> {
  const configuration =
    loadProduction014MaintenanceUpgradeConfiguration(environment);
  const trustedKeys = await readProtectedMigrationTrustStore(
    configuration.trustedKeysFile,
  );
  const runtimeEntrypointPath = path.resolve(String(process.argv[1] || ""));
  const provenance = await verifyCachedMigrationArtifactProvenance({
    archivePath: configuration.artifactArchivePath,
    runtimeEntrypointPath,
    runtimeManifestPath: "app/build/migrate-0.1.4-maintenance-upgrade.js",
    expectedArtifactSha256: configuration.artifactSha256,
    environment: {
      [RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV]: trustedKeys,
    },
  });
  if (provenance.artifactSha256 !== configuration.artifactSha256) {
    fail(
      "PRODUCTION_MIGRATION_0_1_4_ARTIFACT_PROVENANCE_MISMATCH",
      "signed artifact identity does not match the reviewed 0.1.4 maintenance target",
    );
  }
  assertProduction014MaintenanceArtifactProvenance(provenance);
  if (!isPostgresClient(database)) {
    fail(
      "PRODUCTION_MIGRATION_POSTGRES_REQUIRED",
      "production 0.1.4 maintenance upgrade requires PostgreSQL",
    );
  }

  const before = await inspectDatabaseMigrations(database, definitions);
  assertProduction014MaintenanceUpgradeBaseline(
    before,
    definitions,
    configuration,
  );

  const migrator = new KnexReleaseSchemaMigrator({
    database,
    sourceCommit: provenance.sourceCommit,
    artifactSourceCommit: provenance.sourceCommit,
    operatorIdentity: configuration.operatorIdentity,
    artifactSha256: configuration.artifactSha256,
    checkpointDirectory: configuration.checkpointDirectory,
    migrationDefinitions: definitions,
    timeouts: configuration.timeouts,
  });
  await migrator.apply({
    runId: configuration.runId,
    fromVersion: PRODUCTION_014_MAINTENANCE_UPGRADE_FROM_VERSION,
    toVersion: PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION,
    artifactSha256: configuration.artifactSha256,
  }, {
    operationId: configuration.runId,
    actionId: "production-0.1.4-maintenance-upgrade:50-52",
    artifactSha256: configuration.artifactSha256,
  });

  const after = await inspectDatabaseMigrations(database, definitions);
  if (
    !after.current
    || after.databaseVersion !== PRODUCTION_014_MAINTENANCE_UPGRADE_TO_VERSION
    || after.pending.length !== 0
  ) {
    fail(
      "PRODUCTION_MIGRATION_TERMINAL_VERIFICATION_FAILED",
      "database did not reach the exact 0.1.4 maintenance target",
    );
  }
  return after;
}
