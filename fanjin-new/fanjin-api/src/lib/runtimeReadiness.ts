import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { getWebPath } from "@/utils/getPath";
import { inspectObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import { inspectObjectStorageCapabilityAttestation } from "@/lib/objectStorageCapabilityAttestation";
import { inspectRealtimeRelayConfiguration } from "@/lib/realtimeRelaySafety";
import { getReleaseIdentity } from "@/lib/releaseIdentity";
import {
  DATABASE_MIGRATIONS,
  type DatabaseMigration,
  type EnvironmentLike,
} from "@/lib/databaseMigrations";
import {
  inspectRuntimeDatabaseMigrations,
} from "@/lib/runtimeDatabaseCompatibility";
import { WORKER_RELEASE_CONTROL_TABLE } from "@/lib/migrations/releaseDeploymentOrchestration";
import { resolveWorkerHeartbeatFutureSkewMs } from "@/lib/workerHeartbeatPolicy";
import { schemaCompatibilitySupports } from "@/release-controller/schemaCompatibility";
import {
  decodeWorkerSchemaBridgeFence,
  workerSchemaBridgeFenceMatches,
} from "@/release-controller/workerSchemaBridge";
import {
  inspectDurableObjectWriteConfiguration,
  inspectDurableObjectWriteReadiness,
  type DurableObjectWriteReadinessInspection,
} from "@/lib/durableObjectWriteReadiness";
import {
  inspectEnabledVendorVmSources,
  type EnabledVendorVmSafetyInspection,
} from "@/lib/vendorVmSafety";
import { inspectAuthHandoffConfiguration } from "@/lib/authHandoff";
import {
  inspectAgentGenerationSubmitConfiguration,
  inspectAgentSurfaceReadiness,
  type AgentGenerationSubmitConfigurationInspection,
  type AgentSurfaceReadinessInspection,
} from "@/agent-runtime/featureFlags";
import { isProductionRuntime } from "@/lib/legacyAsyncRelaySafety";
import {
  inspectPortraitRuntimeReadiness,
  type PortraitRuntimeReadinessInspection,
} from "@/lib/portraitRuntimeReadiness";
import { processBootIdentity } from "@/lib/processBootIdentity";
import { productionRuntimeConfigIdentity } from "@/lib/productionRuntimeConfigIdentity";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_MAX_AGE_MS = 45_000;
const DEFAULT_DATABASE_TIMEOUT_MS = 2_000;

let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatDatabase: Knex | null = null;
let heartbeatId: string | null = null;
let heartbeatNodeId: string | null = null;
let heartbeatLifecycle: WorkerReleaseHeartbeatLifecycle | null = null;
let heartbeatReconcile: Promise<void> | null = null;
let heartbeatAdmission: "starting" | "accepting" | "draining" | "drained" = "starting";
let heartbeatStopping = false;
let heartbeatMigrationDefinitions: readonly DatabaseMigration[] =
  DATABASE_MIGRATIONS;
let heartbeatEnvironment: EnvironmentLike = process.env;

export interface WorkerReleaseHeartbeatLifecycle {
  startWork(): void | Promise<void>;
  stopWork(): Promise<void>;
}

export interface WorkerReleaseHeartbeatOptions {
  migrationDefinitions?: readonly DatabaseMigration[];
  environment?: EnvironmentLike;
}

function workerHealthFile(): string | null {
  const configured = String(process.env.FANJIN_WORKER_HEALTH_FILE || "").trim();
  return configured ? path.resolve(configured) : null;
}

async function writeWorkerHealthFile(payload: Record<string, unknown>): Promise<void> {
  const filePath = workerHealthFile();
  if (!filePath) return;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporaryPath, filePath);
}

function positiveNumber(raw: unknown, fallback: number, minimum = 1): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function workerId(): string {
  return processBootIdentity().incarnationId;
}

function releaseWorkerNodeId(
  environment: EnvironmentLike = process.env,
): string | null {
  const value = String(
    environment.FANJIN_RELEASE_NODE_ID
      || environment.FANJIN_NODE_ID
      || "",
  ).trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("FANJIN_RELEASE_NODE_ID format is invalid");
  }
  return value;
}

interface WorkerReleaseControlRow {
  nodeId: string;
  desiredState: "running" | "draining";
  operationId: string | null;
  revision: number | string;
}

async function ensureWorkerControl(database: Knex, nodeId: string): Promise<WorkerReleaseControlRow> {
  const existing = await database<WorkerReleaseControlRow>(WORKER_RELEASE_CONTROL_TABLE)
    .where({ nodeId })
    .first();
  if (existing) return existing;
  const now = Date.now();
  try {
    await database(WORKER_RELEASE_CONTROL_TABLE).insert({
      nodeId,
      desiredState: "running",
      operationId: null,
      requestedAt: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // Another incarnation on the same trusted node may have won first insert.
  }
  const created = await database<WorkerReleaseControlRow>(WORKER_RELEASE_CONTROL_TABLE)
    .where({ nodeId })
    .first();
  if (!created) throw new Error("worker release control record is unavailable");
  return created;
}

async function writeHeartbeat(
  database: Knex,
  id: string,
  options: {
    nodeId: string | null;
    observedDatabaseSchemaVersion: number;
    schemaRuntimeMode: "normal" | "migration-bridge" | "isolated";
    acceptingWork: boolean;
    activeTaskCount: number;
    drainOperationId: string | null;
    controlRevision: number | null;
  },
): Promise<void> {
  const timestamp = Date.now();
  const release = getReleaseIdentity(heartbeatEnvironment);
  const patch = {
    role: "background",
    hostname: os.hostname(),
    processId: process.pid,
    nodeId: options.nodeId,
    incarnationId: id,
    releaseId: release.releaseId,
    artifactSha256: release.artifactSha256,
    // This legacy database column now has one unambiguous meaning: the
    // independently observed migration-ledger version. Artifact target schema
    // remains bound to release.artifactSha256 + the immutable manifest.
    schemaVersion: options.observedDatabaseSchemaVersion,
    acceptingWork: options.acceptingWork ? 1 : 0,
    activeTaskCount: options.activeTaskCount,
    drainOperationId: options.drainOperationId,
    controlRevision: options.controlRevision,
    heartbeatAt: timestamp,
    updatedAt: timestamp,
  };
  const updated = await database<any>("o_worker_heartbeat").where({ id }).update(patch);
  if (Number(updated || 0) === 0) {
    try {
      await database<any>("o_worker_heartbeat").insert({
        id,
        ...patch,
        startedAt: timestamp,
        createdAt: timestamp,
      });
    } catch (error) {
      // A concurrent first heartbeat may have inserted the same process row.
      const retried = await database<any>("o_worker_heartbeat").where({ id }).update(patch);
      if (Number(retried || 0) === 0) throw error;
    }
  }
  // Only refresh the container-local probe after the durable DB heartbeat is
  // confirmed. A healthy file therefore implies both a live event loop and a
  // working database connection.
  await writeWorkerHealthFile({
    runtimeConfig: productionRuntimeConfigIdentity(heartbeatEnvironment),
    nodeId: options.nodeId,
    incarnationId: id,
    releaseId: release.releaseId,
    artifactSha256: release.artifactSha256,
    targetSchemaVersion: release.schemaVersion,
    observedDatabaseSchemaVersion: options.observedDatabaseSchemaVersion,
    schemaRuntimeMode: options.schemaRuntimeMode,
    schemaCompatibilityProofSha256:
      release.schemaCompatibilityProofSha256,
    state: heartbeatAdmission,
    acceptingWork: options.acceptingWork,
    activeTaskCount: options.activeTaskCount,
    drainOperationId: options.drainOperationId,
    heartbeatAt: timestamp,
  });
}

async function observedDatabaseSchemaVersion(database: Knex): Promise<number> {
  const status = await inspectRuntimeDatabaseMigrations(
    database,
    heartbeatEnvironment,
    heartbeatMigrationDefinitions,
  );
  const version = status.applied.at(-1)?.version ?? 0;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("worker cannot prove the observed database schema version");
  }
  return version;
}

function validWorkerBridge(input: {
  release: ReturnType<typeof getReleaseIdentity>;
  observedDatabaseSchemaVersion: number;
  control: WorkerReleaseControlRow;
}): boolean {
  const fence = decodeWorkerSchemaBridgeFence(input.control.operationId);
  const { release } = input;
  if (
    input.control.desiredState !== "draining"
    || !fence
    || !release.artifactSha256
    || release.schemaVersion === null
    || !release.schemaCompatibility
    || !release.schemaCompatibilityProofSha256
    || !workerSchemaBridgeFenceMatches({
      fence,
      operationId: fence.operationId,
      artifactSha256: release.artifactSha256,
      artifactSchemaVersion: release.schemaVersion,
      observedDatabaseSchemaVersion:
        input.observedDatabaseSchemaVersion,
      compatibility: release.schemaCompatibility,
    })
  ) {
    return false;
  }
  const migration = release.schemaCompatibility.migration;
  if (release.schemaVersion === fence.toVersion) {
    return release.schemaMode === "migration"
      && migration?.fromVersion === fence.fromVersion
      && migration.toVersion === fence.toVersion;
  }
  return release.schemaVersion === fence.fromVersion
    && release.schemaMode === "schema-neutral"
    && migration === null;
}

async function reconcileWorkerAdmission(): Promise<void> {
  if (!heartbeatDatabase || !heartbeatId) return;
  const database = heartbeatDatabase;
  const id = heartbeatId;
  const nodeId = heartbeatNodeId;
  if (heartbeatStopping) return;
  const observedSchemaVersion = await observedDatabaseSchemaVersion(database);
  if (!nodeId) {
    if (heartbeatAdmission !== "accepting") {
      await heartbeatLifecycle?.startWork();
      heartbeatAdmission = "accepting";
    }
    await writeHeartbeat(database, id, {
      nodeId: null,
      observedDatabaseSchemaVersion: observedSchemaVersion,
      schemaRuntimeMode: "normal",
      acceptingWork: true,
      activeTaskCount: 0,
      drainOperationId: null,
      controlRevision: null,
    });
    return;
  }

  const release = getReleaseIdentity(heartbeatEnvironment);
  if (!release.releaseId || !release.artifactSha256 || release.schemaVersion === null) {
    throw new Error("release-capable Worker requires exact release identity");
  }
  const control = await ensureWorkerControl(database, nodeId);
  const revision = Number(control.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("worker release control revision is invalid");
  const bridgeAuthorized = validWorkerBridge({
    release,
    observedDatabaseSchemaVersion: observedSchemaVersion,
    control,
  });
  if (bridgeAuthorized) {
    if (heartbeatAdmission !== "accepting") {
      await heartbeatLifecycle?.startWork();
      heartbeatAdmission = "accepting";
    }
    await writeHeartbeat(database, id, {
      nodeId,
      observedDatabaseSchemaVersion: observedSchemaVersion,
      schemaRuntimeMode: "migration-bridge",
      acceptingWork: true,
      activeTaskCount: 0,
      drainOperationId: control.operationId,
      controlRevision: revision,
    });
    return;
  }
  if (control.desiredState === "draining") {
    heartbeatAdmission = "draining";
    // Calling stopWork synchronously disables every poller before its first
    // await. Only then can the DB advertise admission=false; the returned
    // promise resolves after all in-flight work has drained.
    const draining = heartbeatLifecycle?.stopWork() ?? Promise.resolve();
    await writeHeartbeat(database, id, {
      nodeId,
      observedDatabaseSchemaVersion: observedSchemaVersion,
      schemaRuntimeMode: "isolated",
      acceptingWork: false,
      activeTaskCount: 1,
      drainOperationId: control.operationId,
      controlRevision: revision,
    });
    const pulseIntervalMs = positiveNumber(
      process.env.FANJIN_WORKER_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      1_000,
    );
    let pulseWrite: Promise<void> | null = null;
    const pulse = setInterval(() => {
      if (pulseWrite) return;
      let tracked: Promise<void>;
      tracked = writeHeartbeat(database, id, {
        nodeId,
        observedDatabaseSchemaVersion: observedSchemaVersion,
        schemaRuntimeMode: "isolated",
        acceptingWork: false,
        activeTaskCount: 1,
        drainOperationId: control.operationId,
        controlRevision: revision,
      }).catch((error: any) => {
        console.warn("[worker-heartbeat] drain pulse failed", error?.message || error);
      }).finally(() => {
        if (pulseWrite === tracked) pulseWrite = null;
      });
      pulseWrite = tracked;
    }, pulseIntervalMs);
    pulse.unref?.();
    try {
      await draining;
    } finally {
      clearInterval(pulse);
      if (pulseWrite) await pulseWrite;
    }
    heartbeatAdmission = "drained";
    await writeHeartbeat(database, id, {
      nodeId,
      observedDatabaseSchemaVersion: observedSchemaVersion,
      schemaRuntimeMode: "isolated",
      acceptingWork: false,
      activeTaskCount: 0,
      drainOperationId: control.operationId,
      controlRevision: revision,
    });
    return;
  }
  if (control.desiredState !== "running" || control.operationId !== null) {
    throw new Error("worker release control state is invalid");
  }
  // Database inspection above has verified the ledger and immutable manifest.
  // A reviewed N/N+1 bridge must keep claiming work after online expansion;
  // explicit drain controls still take precedence over binary compatibility.
  const compatibleDatabase = release.schemaVersion === observedSchemaVersion
    || (release.schemaCompatibility !== null
      && release.schemaCompatibilityProofSha256 !== null
      && schemaCompatibilitySupports(release.schemaCompatibility, observedSchemaVersion));
  if (!compatibleDatabase) {
    if (heartbeatAdmission === "accepting") {
      await heartbeatLifecycle?.stopWork();
    }
    heartbeatAdmission = "drained";
    await writeHeartbeat(database, id, {
      nodeId,
      observedDatabaseSchemaVersion: observedSchemaVersion,
      schemaRuntimeMode: "isolated",
      acceptingWork: false,
      activeTaskCount: 0,
      drainOperationId: null,
      controlRevision: revision,
    });
    return;
  }
  if (heartbeatAdmission !== "accepting") {
    await heartbeatLifecycle?.startWork();
    heartbeatAdmission = "accepting";
  }
  await writeHeartbeat(database, id, {
    nodeId,
    observedDatabaseSchemaVersion: observedSchemaVersion,
    schemaRuntimeMode: "normal",
    acceptingWork: true,
    activeTaskCount: 0,
    drainOperationId: null,
    controlRevision: revision,
  });
}

function scheduleWorkerHeartbeat(): void {
  if (heartbeatReconcile) return;
  const running = reconcileWorkerAdmission();
  let tracked: Promise<void>;
  tracked = running.finally(() => {
    if (heartbeatReconcile === tracked) heartbeatReconcile = null;
  });
  heartbeatReconcile = tracked;
  void heartbeatReconcile.catch((error: any) => {
    console.warn("[worker-heartbeat] write failed", error?.message || error);
  });
}

export async function startWorkerHeartbeat(
  database: Knex,
  lifecycle?: WorkerReleaseHeartbeatLifecycle,
  options: WorkerReleaseHeartbeatOptions = {},
): Promise<void> {
  if (heartbeatTimer) return;
  heartbeatDatabase = database;
  heartbeatId = workerId();
  heartbeatLifecycle = lifecycle ?? null;
  heartbeatMigrationDefinitions =
    options.migrationDefinitions ?? DATABASE_MIGRATIONS;
  heartbeatEnvironment = options.environment ?? process.env;
  heartbeatNodeId = releaseWorkerNodeId(heartbeatEnvironment);
  heartbeatAdmission = "starting";
  heartbeatStopping = false;
  if (String(heartbeatEnvironment.FANJIN_RELEASE_WORKER_TOPOLOGY || "").trim().toLowerCase() === "dedicated"
    && !heartbeatNodeId) {
    throw new Error("dedicated Worker requires FANJIN_RELEASE_NODE_ID");
  }
  await reconcileWorkerAdmission();
  const intervalMs = positiveNumber(
    process.env.FANJIN_WORKER_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    1_000,
  );
  heartbeatTimer = setInterval(() => {
    scheduleWorkerHeartbeat();
  }, intervalMs);
  heartbeatTimer.unref?.();
}

export async function stopWorkerHeartbeat(): Promise<void> {
  heartbeatStopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  const database = heartbeatDatabase;
  const id = heartbeatId;
  heartbeatDatabase = null;
  heartbeatId = null;
  heartbeatNodeId = null;
  heartbeatLifecycle = null;
  heartbeatMigrationDefinitions = DATABASE_MIGRATIONS;
  heartbeatEnvironment = process.env;
  if (heartbeatReconcile) await heartbeatReconcile.catch(() => undefined);
  heartbeatReconcile = null;
  heartbeatAdmission = "starting";
  heartbeatStopping = false;
  const healthFile = workerHealthFile();
  if (healthFile) await fs.promises.unlink(healthFile).catch(() => undefined);
  if (!database || !id) return;
  await database<any>("o_worker_heartbeat").where({ id }).delete().catch(() => undefined);
}

/** Prevent a shutdown race from re-starting pollers while they are draining. */
export function beginWorkerHeartbeatShutdown(): void {
  heartbeatStopping = true;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RuntimeReadinessOptions {
  requireWorker?: boolean;
  requireDeletionWorker?: boolean;
  requireDurableObjectWrite?: boolean;
  requireObjectStorageCapabilityAttestation?: boolean;
  requireVendorVmSafety?: boolean;
  requireWeb?: boolean;
  requirePortraitRuntime?: boolean;
  now?: number;
  databaseTimeoutMs?: number;
  workerMaxAgeMs?: number;
  workerFutureSkewMs?: number;
  webDir?: string;
  objectStorageCapabilityAttestationFile?: string;
  objectStorageCapabilityAttestationMaxAgeMs?: number;
  vendorDirectory?: string;
}

export interface RuntimeDurableObjectWriteReadinessSummary {
  required: boolean;
  inspected: boolean;
  invalidVariables: string[];
  missingColumnCount: number | null;
  unexpectedColumnCount: number | null;
  invalidColumnCount: number | null;
  missingIndexCount: number | null;
  invalidIndexCount: number | null;
  missingConstraintCount: number | null;
  invalidConstraintCount: number | null;
  missingTriggerCount: number | null;
  invalidTriggerCount: number | null;
  deadCount: number | null;
  dueCount: number | null;
  staleDueCount: number | null;
  oldestDueAgeMs: number | null;
}

export interface CloudBackupUploadInspection {
  enabled: boolean;
}

export interface RuntimeVendorVmSafetySummary
  extends EnabledVendorVmSafetyInspection {
  required: boolean;
  inspected: boolean;
}

export function inspectCloudBackupUpload(
  environment: Record<string, string | undefined> = process.env,
): CloudBackupUploadInspection {
  return {
    enabled: String(
      environment.FANJIN_BACKUP_UPLOAD_TO_CLOUD ?? "",
    ).trim() === "1",
  };
}

export interface RuntimeReadinessResult {
  ready: boolean;
  checks: {
    database: boolean;
    worker: boolean;
    deletionWorker: boolean;
    web: boolean;
    objectStorage: boolean;
    conditionalDeletionStorage: boolean;
    objectStorageCapabilityAttestation: boolean;
    realtime: boolean;
    realtimeConfigured: boolean;
    realtimeExternalValidationRequired: boolean;
    durableObjectWrite: boolean;
    durableObjectWriteConfiguration: boolean;
    durableObjectWritePhysicalSchema: boolean;
    durableObjectWriteBacklog: boolean;
    durableObjectWriteDead: boolean;
    durableObjectWriteSummary: RuntimeDurableObjectWriteReadinessSummary;
    vendorVmSafety: boolean;
    vendorVmSafetySummary: RuntimeVendorVmSafetySummary;
    cloudBackupDr: boolean;
    cloudBackupSummary: CloudBackupUploadInspection;
    authHandoff: boolean;
    agentSurface: boolean;
    agentSurfaceSummary: AgentSurfaceReadinessInspection;
    agentGenerationSubmit: boolean;
    agentGenerationSubmitSummary: AgentGenerationSubmitConfigurationInspection;
    portraitRuntime: boolean;
    portraitRuntimeSummary: PortraitRuntimeReadinessInspection;
  };
}

function vendorVmSafetySummary(
  required: boolean,
  inspection: EnabledVendorVmSafetyInspection | null,
): RuntimeVendorVmSafetySummary {
  if (!inspection) {
    return {
      required,
      inspected: false,
      ready: !required,
      available: false,
      enabledCount: null,
      safeCount: null,
      bundledCapabilityCount: null,
      explicitManifestCount: null,
      invalidIdCount: null,
      missingSourceCount: null,
      missingManifestCount: null,
      invalidCapabilityCount: null,
      forbiddenSourceCount: null,
      rawStorageWriteCount: null,
    };
  }
  return {
    required,
    inspected: true,
    ...inspection,
  };
}

function durableObjectWriteSummary(
  required: boolean,
  inspection: DurableObjectWriteReadinessInspection | null,
): RuntimeDurableObjectWriteReadinessSummary {
  if (!inspection) {
    return {
      required,
      inspected: false,
      invalidVariables: [],
      missingColumnCount: null,
      unexpectedColumnCount: null,
      invalidColumnCount: null,
      missingIndexCount: null,
      invalidIndexCount: null,
      missingConstraintCount: null,
      invalidConstraintCount: null,
      missingTriggerCount: null,
      invalidTriggerCount: null,
      deadCount: null,
      dueCount: null,
      staleDueCount: null,
      oldestDueAgeMs: null,
    };
  }
  return {
    required,
    inspected: true,
    invalidVariables: inspection.configuration.invalidVariables,
    missingColumnCount: inspection.physicalSchema.missingColumns.length,
    unexpectedColumnCount: inspection.physicalSchema.unexpectedColumns.length,
    invalidColumnCount: inspection.physicalSchema.invalidColumns.length,
    missingIndexCount: inspection.physicalSchema.missingIndexes.length,
    invalidIndexCount: inspection.physicalSchema.invalidIndexes.length,
    missingConstraintCount:
      inspection.physicalSchema.missingConstraints.length,
    invalidConstraintCount:
      inspection.physicalSchema.invalidConstraints.length,
    missingTriggerCount: inspection.physicalSchema.missingTriggers.length,
    invalidTriggerCount: inspection.physicalSchema.invalidTriggers.length,
    deadCount: inspection.backlog.deadCount,
    dueCount: inspection.backlog.dueCount,
    staleDueCount: inspection.backlog.staleDueCount,
    oldestDueAgeMs: inspection.backlog.oldestDueAgeMs,
  };
}

export async function probeRuntimeReadiness(
  database: Knex,
  options: RuntimeReadinessOptions = {},
): Promise<RuntimeReadinessResult> {
  const now = options.now ?? Date.now();
  const production = isProductionRuntime();
  const requireWorker = options.requireWorker ?? false;
  const requireDeletionWorker = options.requireDeletionWorker
    ?? production;
  const requireDurableObjectWrite = options.requireDurableObjectWrite
    ?? production;
  const requireObjectStorageCapabilityAttestation =
    options.requireObjectStorageCapabilityAttestation
    ?? production;
  const requireVendorVmSafety = options.requireVendorVmSafety
    ?? production;
  const requireWeb = options.requireWeb ?? false;
  const requirePortraitRuntime = options.requirePortraitRuntime ?? production;
  const cloudBackup = inspectCloudBackupUpload(process.env);
  const cloudBackupReady =
    !production || !cloudBackup.enabled;
  const authHandoffReady = inspectAuthHandoffConfiguration(process.env).ready;
  const agentGenerationSubmit =
    inspectAgentGenerationSubmitConfiguration(process.env);
  const agentSurface = inspectAgentSurfaceReadiness(process.env);
  const databaseTimeoutMs = positiveNumber(
    options.databaseTimeoutMs ?? process.env.FANJIN_READINESS_DATABASE_TIMEOUT_MS,
    DEFAULT_DATABASE_TIMEOUT_MS,
    100,
  );
  const workerMaxAgeMs = positiveNumber(
    options.workerMaxAgeMs ?? process.env.FANJIN_WORKER_HEARTBEAT_MAX_AGE_MS,
    DEFAULT_HEARTBEAT_MAX_AGE_MS,
    1_000,
  );
  let databaseReady = false;
  try {
    await withTimeout(Promise.resolve(database.raw("SELECT 1")), databaseTimeoutMs, "database_probe");
    databaseReady = true;
  } catch {
    databaseReady = false;
  }

  let vendorVmSafetyInspection: EnabledVendorVmSafetyInspection | null = null;
  let vendorVmSafetyReady = !requireVendorVmSafety;
  if (databaseReady && requireVendorVmSafety) {
    try {
      vendorVmSafetyInspection = await withTimeout(
        inspectEnabledVendorVmSources(database, {
          vendorDirectory: options.vendorDirectory,
        }),
        databaseTimeoutMs,
        "vendor_vm_safety_probe",
      );
      vendorVmSafetyReady = vendorVmSafetyInspection.ready;
    } catch {
      vendorVmSafetyInspection = null;
      vendorVmSafetyReady = false;
    }
  }
  const vendorVmReadinessSummary = vendorVmSafetySummary(
    requireVendorVmSafety,
    vendorVmSafetyInspection,
  );

  let durableObjectWriteInspection:
    DurableObjectWriteReadinessInspection | null = null;
  let durableObjectWriteConfigurationReady = !requireDurableObjectWrite;
  let durableObjectWritePhysicalSchemaReady = !requireDurableObjectWrite;
  let durableObjectWriteBacklogReady = !requireDurableObjectWrite;
  let durableObjectWriteDeadReady = !requireDurableObjectWrite;
  if (requireDurableObjectWrite) {
    durableObjectWriteConfigurationReady =
      inspectDurableObjectWriteConfiguration(process.env).ready;
    if (databaseReady) {
      try {
        durableObjectWriteInspection = await withTimeout(
          inspectDurableObjectWriteReadiness(database, {
            environment: process.env,
            now,
          }),
          databaseTimeoutMs,
          "durable_object_write_probe",
        );
        durableObjectWriteConfigurationReady =
          durableObjectWriteInspection.configuration.ready;
        durableObjectWritePhysicalSchemaReady =
          durableObjectWriteInspection.physicalSchema.ready;
        durableObjectWriteBacklogReady =
          durableObjectWriteInspection.backlog.available
          && durableObjectWriteInspection.backlog.staleDueCount === 0;
        durableObjectWriteDeadReady =
          durableObjectWriteInspection.backlog.available
          && durableObjectWriteInspection.backlog.deadCount === 0;
      } catch {
        // Readiness is a process admission boundary. A catalog query, backlog
        // aggregate, or timeout must make the process unavailable, never crash
        // the endpoint or reflect database/provider data into its response.
        durableObjectWriteInspection = null;
      }
    }
  }
  const durableObjectWriteReady =
    durableObjectWriteConfigurationReady
    && durableObjectWritePhysicalSchemaReady
    && durableObjectWriteBacklogReady
    && durableObjectWriteDeadReady;
  const durableObjectWriteReadinessSummary = durableObjectWriteSummary(
    requireDurableObjectWrite,
    durableObjectWriteInspection,
  );

  let workerReady = !requireWorker;
  if (databaseReady && requireWorker) {
    try {
      const workerFutureSkewMs = resolveWorkerHeartbeatFutureSkewMs(options.workerFutureSkewMs);
      const heartbeats = await database<any>("o_worker_heartbeat")
        .where({ role: "background" })
        .where("heartbeatAt", ">=", now - workerMaxAgeMs)
        .orderBy("heartbeatAt", "desc");
      if (heartbeats.some((row: any) => (
        Number.isSafeInteger(Number(row.heartbeatAt))
        && Number(row.heartbeatAt) > now + workerFutureSkewMs
      ))) {
        throw new Error("worker heartbeat timestamp is ahead of the allowed clock skew");
      }
      const release = getReleaseIdentity();
      const topology = String(process.env.FANJIN_RELEASE_WORKER_TOPOLOGY || "").trim().toLowerCase();
      const requireExactIdentity = topology === "dedicated" || production;
      const identityIsValid = (row: any) => (
        Boolean(release.artifactSha256)
        && release.schemaVersion !== null
        && release.schemaCompatibility !== null
        && typeof row.artifactSha256 === "string"
        && /^[a-f0-9]{64}$/.test(row.artifactSha256)
        && row.schemaVersion !== null
        && row.schemaVersion !== undefined
        && row.schemaVersion !== ""
        && Number.isSafeInteger(Number(row.schemaVersion))
        && schemaCompatibilitySupports(
          release.schemaCompatibility!,
          Number(row.schemaVersion),
        )
        && row.activeTaskCount !== null
        && row.activeTaskCount !== undefined
        && row.activeTaskCount !== ""
        && Number.isSafeInteger(Number(row.activeTaskCount))
        && Number(row.activeTaskCount) >= 0
      );
      const identityMatches = (row: any) => !requireExactIdentity || (
        identityIsValid(row)
        && row.artifactSha256 === release.artifactSha256
        && (row.acceptingWork === true || Number(row.acceptingWork) === 1)
      );
      if (topology === "dedicated") {
        const configured = JSON.parse(String(process.env.FANJIN_RELEASE_WORKER_TARGETS || "[]"));
        const expectedNodeIds = Array.isArray(configured)
          ? configured.map((entry) => String(entry?.nodeId || "")).filter(Boolean)
          : [];
        const trustedFreshRows = heartbeats.filter((row: any) => (
          typeof row.nodeId === "string" && expectedNodeIds.includes(row.nodeId)
        ));
        const minimumServingWorkers = Math.max(1, expectedNodeIds.length - 1);
        workerReady = expectedNodeIds.length >= 2
          && new Set(expectedNodeIds).size === expectedNodeIds.length
          // A fresh legacy/unidentified Worker is still capable of claiming
          // work. Dedicated topology must therefore reject it instead of
          // silently treating it as outside the release fleet.
          && trustedFreshRows.length === heartbeats.length
          // Two live incarnations for one logical node cannot both be proven
          // drained by a single node action.
          && expectedNodeIds.every((nodeId) => (
            trustedFreshRows.filter((row: any) => row.nodeId === nodeId).length <= 1
          ))
          && trustedFreshRows.every(identityIsValid)
          && trustedFreshRows.filter((row: any) => (
            identityIsValid(row)
            && (row.acceptingWork === true || Number(row.acceptingWork) === 1)
          )).length >= minimumServingWorkers
          // Readiness is a service-availability gate, not the final release
          // convergence gate. During a rolling release one trusted Worker may
          // be absent, drained, or already on the target SHA. At least one
          // accepting Worker must still match this API binary exactly. The
          // Controller separately requires the complete fleet at preflight
          // and before declaring the deployment successful.
          && trustedFreshRows.some(identityMatches);
      } else {
        workerReady = heartbeats.some(identityMatches);
      }
    } catch {
      workerReady = false;
    }
  }

  let deletionWorkerReady = !requireDeletionWorker;
  if (
    process.env.FANJIN_DISABLE_DELETION_WORKER === "1"
    && requireDeletionWorker
  ) {
    deletionWorkerReady = false;
  } else if (databaseReady && requireDeletionWorker) {
    try {
      const workerFutureSkewMs = resolveWorkerHeartbeatFutureSkewMs(
        options.workerFutureSkewMs,
      );
      const heartbeats = await database<any>("o_worker_heartbeat")
        .where({ role: "deletion" })
        .where("heartbeatAt", ">=", now - workerMaxAgeMs)
        .orderBy("heartbeatAt", "desc");
      if (heartbeats.some((row: any) => (
        Number.isSafeInteger(Number(row.heartbeatAt))
        && Number(row.heartbeatAt) > now + workerFutureSkewMs
      ))) {
        throw new Error(
          "deletion worker heartbeat timestamp is ahead of the allowed clock skew",
        );
      }
      const release = getReleaseIdentity();
      const topology = String(
        process.env.FANJIN_RELEASE_WORKER_TOPOLOGY || "",
      ).trim().toLowerCase();
      const requireExactIdentity =
        topology === "dedicated" || production;
      const expectedNodeIds = topology === "dedicated"
        ? JSON.parse(
          String(process.env.FANJIN_RELEASE_WORKER_TARGETS || "[]"),
        )
        : [];
      const trustedNodeIds = Array.isArray(expectedNodeIds)
        ? expectedNodeIds
          .map((entry) => String(entry?.nodeId || ""))
          .filter(Boolean)
        : [];
      deletionWorkerReady = heartbeats.some((row: any) => (
        (row.acceptingWork === true || Number(row.acceptingWork) === 1)
        && (
          topology !== "dedicated"
          || (
            typeof row.nodeId === "string"
            && trustedNodeIds.includes(row.nodeId)
          )
        )
        && (
          !requireExactIdentity
          || (
            Boolean(release.artifactSha256)
            && release.schemaVersion !== null
            && row.artifactSha256 === release.artifactSha256
            && Number(row.schemaVersion) === release.schemaVersion
          )
        )
      ));
    } catch {
      deletionWorkerReady = false;
    }
  }

  const webDir = options.webDir || getWebPath();
  const webReady = !requireWeb || fs.existsSync(path.join(webDir, "index.html"));
  const objectStorage = inspectObjectStorageConfiguration();
  const remoteStorageConfigured = objectStorage.supported
    && ["s3", "tos"].includes(objectStorage.effectiveProvider);
  const objectStorageCapabilityAttestation = requireObjectStorageCapabilityAttestation
    ? inspectObjectStorageCapabilityAttestation({
        now,
        filePath: options.objectStorageCapabilityAttestationFile,
        maximumAgeMs: options.objectStorageCapabilityAttestationMaxAgeMs,
      })
    : null;
  const objectStorageCapabilityAttestationReady =
    !requireObjectStorageCapabilityAttestation
    || objectStorageCapabilityAttestation?.ready === true;
  const requireConditionalDeletionStorage =
    requireObjectStorageCapabilityAttestation
    || production;
  const conditionalDeletionStorageReady =
    requireConditionalDeletionStorage
      ? remoteStorageConfigured
        && objectStorageCapabilityAttestationReady
      : objectStorage.supported;
  const objectStorageReady = conditionalDeletionStorageReady;
  const realtime = inspectRealtimeRelayConfiguration();
  const portraitRuntime = await inspectPortraitRuntimeReadiness({
    database,
    required: requirePortraitRuntime,
  });
  return {
    ready: databaseReady
      && workerReady
      && deletionWorkerReady
      && webReady
      && objectStorageReady
      && durableObjectWriteReady
      && vendorVmSafetyReady
      && cloudBackupReady
      && authHandoffReady
      && agentSurface.ready
      && agentGenerationSubmit.ready
      && portraitRuntime.ready
      && realtime.ready,
    checks: {
      database: databaseReady,
      worker: workerReady,
      deletionWorker: deletionWorkerReady,
      web: webReady,
      objectStorage: objectStorageReady,
      conditionalDeletionStorage: conditionalDeletionStorageReady,
      objectStorageCapabilityAttestation: objectStorageCapabilityAttestationReady,
      realtime: realtime.ready,
      realtimeConfigured: realtime.status === "configured",
      realtimeExternalValidationRequired: realtime.externalValidationRequired,
      durableObjectWrite: durableObjectWriteReady,
      durableObjectWriteConfiguration:
        durableObjectWriteConfigurationReady,
      durableObjectWritePhysicalSchema:
        durableObjectWritePhysicalSchemaReady,
      durableObjectWriteBacklog: durableObjectWriteBacklogReady,
      durableObjectWriteDead: durableObjectWriteDeadReady,
      durableObjectWriteSummary: durableObjectWriteReadinessSummary,
      vendorVmSafety: vendorVmSafetyReady,
      vendorVmSafetySummary: vendorVmReadinessSummary,
      cloudBackupDr: cloudBackupReady,
      cloudBackupSummary: cloudBackup,
      authHandoff: authHandoffReady,
      agentSurface: agentSurface.ready,
      agentSurfaceSummary: agentSurface,
      agentGenerationSubmit: agentGenerationSubmit.ready,
      agentGenerationSubmitSummary: agentGenerationSubmit,
      portraitRuntime: portraitRuntime.ready,
      portraitRuntimeSummary: portraitRuntime,
    },
  };
}
