import type { Knex } from "knex";

import {
  getKnexClientName,
  isPostgresClient,
  quoteSqlIdentifier,
  rawRows,
} from "@/lib/dbDialect";
import {
  OBJECT_WRITE_INTENT_INDEXES,
  OBJECT_WRITE_INTENT_TABLE,
} from "@/lib/migrations/objectWriteIntent";
import {
  inspectObjectStorageConfiguration,
  normalizeStableObjectBaseUrl,
} from "@/lib/objectStorageConfig";

type EnvironmentLike = Record<string, string | undefined>;
type SupportedInspectionDialect = "postgres" | "sqlite";

interface RequiredColumn {
  name: string;
  type: "text" | "bigint" | "boolean";
  notNull: boolean;
}

interface ColumnSnapshot {
  name: string;
  type: string;
  notNull: boolean;
  primary: boolean;
}

interface IndexSnapshot {
  name: string;
  columns: string[];
  unique: boolean;
  valid: boolean;
  ready: boolean;
}

interface ConstraintSnapshot {
  name: string;
  type: string;
  validated: boolean;
}

interface TriggerSnapshot {
  name: string;
  enabled: string;
  definition: string;
}

interface PhysicalSchemaSnapshot {
  dialect: SupportedInspectionDialect;
  columns: ColumnSnapshot[];
  indexes: IndexSnapshot[];
  constraints: ConstraintSnapshot[];
  triggers: TriggerSnapshot[];
}

const REQUIRED_COLUMNS: readonly RequiredColumn[] = Object.freeze([
  { name: "id", type: "text", notNull: true },
  { name: "requestHash", type: "text", notNull: true },
  { name: "purpose", type: "text", notNull: true },
  { name: "workspaceId", type: "text", notNull: true },
  { name: "projectId", type: "bigint", notNull: true },
  { name: "provider", type: "text", notNull: true },
  { name: "providerFingerprint", type: "text", notNull: true },
  { name: "bucket", type: "text", notNull: true },
  { name: "region", type: "text", notNull: true },
  { name: "endpoint", type: "text", notNull: true },
  { name: "keyPrefix", type: "text", notNull: true },
  { name: "forcePathStyle", type: "boolean", notNull: true },
  { name: "objectKey", type: "text", notNull: true },
  { name: "expectedSize", type: "bigint", notNull: true },
  { name: "expectedSha256", type: "text", notNull: true },
  { name: "status", type: "text", notNull: true },
  { name: "writeReceiptJson", type: "text", notNull: false },
  { name: "writeReceiptHash", type: "text", notNull: false },
  { name: "referenceJson", type: "text", notNull: false },
  { name: "referenceHash", type: "text", notNull: false },
  { name: "compensationEvidenceJson", type: "text", notNull: false },
  { name: "compensationEvidenceHash", type: "text", notNull: false },
  { name: "errorCode", type: "text", notNull: false },
  { name: "leaseOwner", type: "text", notNull: false },
  { name: "leaseExpiresAt", type: "bigint", notNull: false },
  { name: "leaseFence", type: "bigint", notNull: true },
  { name: "retryCount", type: "bigint", notNull: true },
  { name: "maxRetries", type: "bigint", notNull: true },
  { name: "nextAttemptAt", type: "bigint", notNull: true },
  { name: "createdAt", type: "bigint", notNull: true },
  { name: "updatedAt", type: "bigint", notNull: true },
  { name: "putCompletedAt", type: "bigint", notNull: false },
  { name: "committedAt", type: "bigint", notNull: false },
  { name: "compensatedAt", type: "bigint", notNull: false },
]);

const REQUIRED_CHECK_CONSTRAINTS = Object.freeze([
  "chk_o_object_write_intent_purpose",
  "chk_o_object_write_intent_provider",
  "chk_o_object_write_intent_status",
  "chk_o_object_write_intent_identity",
  "chk_o_object_write_intent_counters",
  "chk_o_object_write_intent_lease",
  "chk_o_object_write_intent_receipt",
  "chk_o_object_write_intent_reference",
  "chk_o_object_write_intent_compensation",
  "chk_o_object_write_intent_lifecycle",
] as const);

const POSTGRES_GUARD_TRIGGER =
  "trg_o_object_write_intent_evidence_guard";
const POSTGRES_GUARD_FUNCTION =
  "fanjin_guard_object_write_intent_evidence";
const SQLITE_GUARD_TRIGGERS = Object.freeze([
  `${POSTGRES_GUARD_TRIGGER}_identity`,
  `${POSTGRES_GUARD_TRIGGER}_receipt`,
  `${POSTGRES_GUARD_TRIGGER}_reference`,
  `${POSTGRES_GUARD_TRIGGER}_terminal`,
  `${POSTGRES_GUARD_TRIGGER}_delete`,
] as const);

export const DURABLE_OBJECT_WRITE_READINESS_DEFAULTS = Object.freeze({
  databasePoolMin: 0,
  databasePoolMax: 10,
  databaseAcquireTimeoutMs: 60_000,
  agentWorkerBatchSize: 1,
  deletionWorkerIntervalMs: 5_000,
  workerHeartbeatMaxAgeMs: 45_000,
  compensationLeaseMs: 5 * 60_000,
  compensationBatchLimit: 20,
  compensationOperationTimeoutMs: 30_000,
  putTimeoutMs: 10 * 60_000,
  settlementGraceMs: 5 * 60_000,
  staleGraceMs: 2 * 60_000,
});

export interface DurableObjectWriteConfigurationInspection {
  ready: boolean;
  production: boolean;
  processRole: "all" | "api" | "worker" | "invalid";
  databaseClient: "postgres" | "sqlite" | "invalid";
  databasePoolMin: number | null;
  databasePoolMax: number | null;
  databaseAcquireTimeoutMs: number | null;
  requiredDatabasePoolMax: number | null;
  workerBatchSize: number | null;
  submitEnabled: boolean;
  mirrorRequired: boolean;
  mirrorReady: boolean;
  stableVideoDeliveryReady: boolean;
  singleConcurrencyReady: boolean;
  poolBudgetReady: boolean;
  compensationWorkerReady: boolean;
  compensationTimingReady: boolean;
  objectWriteTimingReady: boolean;
  deletionWorkerIntervalMs: number | null;
  workerHeartbeatMaxAgeMs: number | null;
  compensationLeaseMs: number | null;
  compensationBatchLimit: number | null;
  compensationOperationTimeoutMs: number | null;
  putTimeoutMs: number | null;
  settlementGraceMs: number | null;
  staleGraceMs: number | null;
  invalidVariables: string[];
}

export interface DurableObjectWritePhysicalSchemaInspection {
  ready: boolean;
  inspectionFailed: boolean;
  dialect: SupportedInspectionDialect | "unsupported";
  tableExists: boolean;
  columnsReady: boolean;
  indexesReady: boolean;
  constraintsReady: boolean;
  triggersReady: boolean;
  missingColumns: string[];
  unexpectedColumns: string[];
  invalidColumns: string[];
  missingIndexes: string[];
  invalidIndexes: string[];
  missingConstraints: string[];
  invalidConstraints: string[];
  missingTriggers: string[];
  invalidTriggers: string[];
}

export interface DurableObjectWriteBacklogInspection {
  ready: boolean;
  available: boolean;
  deadCount: number | null;
  dueCount: number | null;
  staleDueCount: number | null;
  oldestDueAgeMs: number | null;
}

export interface DurableObjectWriteReadinessInspection {
  ready: boolean;
  configuration: DurableObjectWriteConfigurationInspection;
  physicalSchema: DurableObjectWritePhysicalSchemaInspection;
  backlog: DurableObjectWriteBacklogInspection;
}

export interface DurableObjectWriteReadinessOptions {
  environment?: EnvironmentLike;
  now?: number;
  staleGraceMs?: number;
}

function environmentValue(
  environment: EnvironmentLike,
  name: string,
): string {
  return String(environment[name] ?? "").trim();
}

function strictInteger(
  environment: EnvironmentLike,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): { value: number | null; valid: boolean } {
  const raw = environmentValue(environment, name);
  if (!raw) return { value: fallback, valid: true };
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    return { value: null, valid: false };
  }
  const value = Number(raw);
  return {
    value: Number.isSafeInteger(value)
      && value >= minimum
      && value <= maximum
      ? value
      : null,
    valid: Number.isSafeInteger(value)
      && value >= minimum
      && value <= maximum,
  };
}

function binaryFlag(
  environment: EnvironmentLike,
  name: string,
  fallback: boolean,
): { value: boolean; valid: boolean } {
  const raw = environmentValue(environment, name);
  if (!raw) return { value: fallback, valid: true };
  if (raw === "1") return { value: true, valid: true };
  if (raw === "0") return { value: false, valid: true };
  return { value: false, valid: false };
}

function normalizedProcessRole(
  environment: EnvironmentLike,
): DurableObjectWriteConfigurationInspection["processRole"] {
  const raw = (
    environmentValue(environment, "FANJIN_PROCESS_ROLE")
    || environmentValue(environment, "FANJIN_SERVICE_ROLE")
    || "all"
  ).toLowerCase();
  if (raw === "all") return "all";
  if (["api", "server", "web"].includes(raw)) return "api";
  if (["worker", "relay-worker", "relay_worker"].includes(raw)) {
    return "worker";
  }
  return "invalid";
}

function normalizedDatabaseClient(
  environment: EnvironmentLike,
): DurableObjectWriteConfigurationInspection["databaseClient"] {
  const raw = (
    environmentValue(environment, "FANJIN_DATABASE_CLIENT")
    || "sqlite"
  ).toLowerCase();
  if (["postgres", "postgresql", "pg"].includes(raw)) return "postgres";
  if (["sqlite", "better-sqlite3", "sqlite3"].includes(raw)) return "sqlite";
  return "invalid";
}

function pushInvalid(
  target: string[],
  name: string,
  valid: boolean,
): void {
  if (!valid) target.push(name);
}

export function inspectDurableObjectWriteConfiguration(
  environment: EnvironmentLike = process.env,
): DurableObjectWriteConfigurationInspection {
  const nodeEnvironment = environmentValue(environment, "NODE_ENV")
    .toLowerCase();
  const production = nodeEnvironment === "prod"
    || nodeEnvironment === "production";
  const processRole = normalizedProcessRole(environment);
  const databaseClient = normalizedDatabaseClient(environment);
  const submit = binaryFlag(
    environment,
    "FANJIN_AGENT_GENERATION_SUBMIT_ENABLED",
    false,
  );
  const deletionDisabled = binaryFlag(
    environment,
    "FANJIN_DISABLE_DELETION_WORKER",
    false,
  );
  const externalWorker = binaryFlag(
    environment,
    "FANJIN_EXPECT_EXTERNAL_WORKER",
    false,
  );
  const mirror = binaryFlag(
    environment,
    "FANJIN_MIRROR_RELAY_MEDIA",
    true,
  );
  const poolMin = strictInteger(
    environment,
    "FANJIN_DATABASE_POOL_MIN",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.databasePoolMin,
    0,
    200,
  );
  const poolMax = strictInteger(
    environment,
    "FANJIN_DATABASE_POOL_MAX",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.databasePoolMax,
    1,
    200,
  );
  const workerBatchSize = strictInteger(
    environment,
    "FANJIN_AGENT_WORKER_BATCH_SIZE",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.agentWorkerBatchSize,
    1,
    100,
  );
  const databaseAcquireTimeoutMs = strictInteger(
    environment,
    "FANJIN_DATABASE_ACQUIRE_TIMEOUT_MS",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.databaseAcquireTimeoutMs,
    100,
    24 * 60 * 60_000,
  );
  const deletionWorkerIntervalMs = strictInteger(
    environment,
    "FANJIN_DELETION_WORKER_INTERVAL_MS",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.deletionWorkerIntervalMs,
    1,
    24 * 60 * 60_000,
  );
  const workerHeartbeatMaxAgeMs = strictInteger(
    environment,
    "FANJIN_WORKER_HEARTBEAT_MAX_AGE_MS",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.workerHeartbeatMaxAgeMs,
    1_000,
    24 * 60 * 60_000,
  );
  const compensationLeaseMs = strictInteger(
    environment,
    "FANJIN_OBJECT_WRITE_COMPENSATION_LEASE_MS",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.compensationLeaseMs,
    1,
    24 * 60 * 60_000,
  );
  const compensationBatchLimit = strictInteger(
    environment,
    "FANJIN_OBJECT_WRITE_COMPENSATION_BATCH_LIMIT",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.compensationBatchLimit,
    1,
    100,
  );
  const compensationOperationTimeoutMs = strictInteger(
    environment,
    "FANJIN_OBJECT_WRITE_COMPENSATION_OPERATION_TIMEOUT_MS",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS
      .compensationOperationTimeoutMs,
    1,
    24 * 60 * 60_000,
  );
  const putTimeoutMs = strictInteger(
    environment,
    "FANJIN_OBJECT_WRITE_PUT_TIMEOUT_MS",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.putTimeoutMs,
    1,
    24 * 60 * 60_000,
  );
  const settlementGraceMs = strictInteger(
    environment,
    "FANJIN_OBJECT_WRITE_SETTLEMENT_GRACE_MS",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.settlementGraceMs,
    1,
    24 * 60 * 60_000,
  );
  const staleGraceMs = strictInteger(
    environment,
    "FANJIN_OBJECT_WRITE_COMPENSATION_MAX_OVERDUE_MS",
    DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.staleGraceMs,
    0,
    24 * 60 * 60_000,
  );
  const invalidVariables: string[] = [];
  pushInvalid(
    invalidVariables,
    "FANJIN_AGENT_GENERATION_SUBMIT_ENABLED",
    submit.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_DISABLE_DELETION_WORKER",
    deletionDisabled.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_EXPECT_EXTERNAL_WORKER",
    externalWorker.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_MIRROR_RELAY_MEDIA",
    mirror.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_DATABASE_POOL_MIN",
    poolMin.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_DATABASE_POOL_MAX",
    poolMax.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_AGENT_WORKER_BATCH_SIZE",
    workerBatchSize.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_DATABASE_ACQUIRE_TIMEOUT_MS",
    databaseAcquireTimeoutMs.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_DELETION_WORKER_INTERVAL_MS",
    deletionWorkerIntervalMs.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_WORKER_HEARTBEAT_MAX_AGE_MS",
    workerHeartbeatMaxAgeMs.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_OBJECT_WRITE_COMPENSATION_LEASE_MS",
    compensationLeaseMs.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_OBJECT_WRITE_COMPENSATION_BATCH_LIMIT",
    compensationBatchLimit.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_OBJECT_WRITE_COMPENSATION_OPERATION_TIMEOUT_MS",
    compensationOperationTimeoutMs.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_OBJECT_WRITE_PUT_TIMEOUT_MS",
    putTimeoutMs.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_OBJECT_WRITE_SETTLEMENT_GRACE_MS",
    settlementGraceMs.valid,
  );
  pushInvalid(
    invalidVariables,
    "FANJIN_OBJECT_WRITE_COMPENSATION_MAX_OVERDUE_MS",
    staleGraceMs.valid,
  );
  if (processRole === "invalid") {
    invalidVariables.push("FANJIN_PROCESS_ROLE");
  }
  if (databaseClient === "invalid") {
    invalidVariables.push("FANJIN_DATABASE_CLIENT");
  }
  if (
    poolMin.value !== null
    && poolMax.value !== null
    && poolMin.value > poolMax.value
  ) {
    invalidVariables.push(
      "FANJIN_DATABASE_POOL_MIN",
      "FANJIN_DATABASE_POOL_MAX",
    );
  }

  const contractRequired = production || submit.value;
  const objectStorage = inspectObjectStorageConfiguration(environment);
  // The current Gateway executes a submit inside one transaction and performs
  // relay/durable work through the root Knex pool. B concurrent Runs can hold B
  // outer connections while asking for B nested connections; two additional
  // slots keep lease/deletion heartbeats serviceable.
  const requiredDatabasePoolMax = workerBatchSize.value === null
    ? null
    : workerBatchSize.value * 2 + 2;
  const mirrorReady = !contractRequired
    || environmentValue(environment, "FANJIN_MIRROR_RELAY_MEDIA") === "1";
  const stableVideoDeliveryReady = !contractRequired
    || (
      objectStorage.supported
      && (
        objectStorage.effectiveProvider === "local"
        || (
          ["s3", "tos"].includes(objectStorage.effectiveProvider)
          && objectStorage.urlMode === "cdn"
          && objectStorage.cdnConfigured
          && Boolean(normalizeStableObjectBaseUrl(
            objectStorage.cdnBaseUrl,
          ))
        )
      )
    );
  const singleConcurrencyReady = !contractRequired
    || workerBatchSize.value === 1;
  const poolBudgetReady = !contractRequired || (
    databaseClient === "postgres"
    && poolMax.value !== null
    && requiredDatabasePoolMax !== null
    && poolMax.value >= requiredDatabasePoolMax
  );
  const compensationWorkerReady = !contractRequired
    || (
      processRole !== "invalid"
      && (
        processRole === "api"
          ? externalWorker.value
          : !deletionDisabled.value
      )
    );
  const compensationTimingReady =
    deletionWorkerIntervalMs.value !== null
    && workerHeartbeatMaxAgeMs.value !== null
    && compensationLeaseMs.value !== null
    && compensationOperationTimeoutMs.value !== null
    && deletionWorkerIntervalMs.value
      <= Math.floor(workerHeartbeatMaxAgeMs.value / 3)
    && compensationLeaseMs.value > deletionWorkerIntervalMs.value
    && compensationOperationTimeoutMs.value < compensationLeaseMs.value;
  const objectWriteTimingReady =
    putTimeoutMs.value !== null
    && settlementGraceMs.value !== null
    && putTimeoutMs.value + settlementGraceMs.value
      <= 24 * 60 * 60_000;
  const databaseReady = !production || databaseClient === "postgres";

  return {
    ready: invalidVariables.length === 0
      && databaseReady
      && mirrorReady
      && stableVideoDeliveryReady
      && singleConcurrencyReady
      && poolBudgetReady
      && compensationWorkerReady
      && compensationTimingReady
      && objectWriteTimingReady,
    production,
    processRole,
    databaseClient,
    databasePoolMin: poolMin.value,
    databasePoolMax: poolMax.value,
    databaseAcquireTimeoutMs: databaseAcquireTimeoutMs.value,
    requiredDatabasePoolMax,
    workerBatchSize: workerBatchSize.value,
    submitEnabled: submit.value,
    mirrorRequired: contractRequired,
    mirrorReady,
    stableVideoDeliveryReady,
    singleConcurrencyReady,
    poolBudgetReady,
    compensationWorkerReady,
    compensationTimingReady,
    objectWriteTimingReady,
    deletionWorkerIntervalMs: deletionWorkerIntervalMs.value,
    workerHeartbeatMaxAgeMs: workerHeartbeatMaxAgeMs.value,
    compensationLeaseMs: compensationLeaseMs.value,
    compensationBatchLimit: compensationBatchLimit.value,
    compensationOperationTimeoutMs:
      compensationOperationTimeoutMs.value,
    putTimeoutMs: putTimeoutMs.value,
    settlementGraceMs: settlementGraceMs.value,
    staleGraceMs: staleGraceMs.value,
    invalidVariables: [...new Set(invalidVariables)].sort(),
  };
}

function inspectionDialect(
  database: Knex,
): SupportedInspectionDialect | "unsupported" {
  if (isPostgresClient(database)) return "postgres";
  const client = getKnexClientName(database);
  if (["sqlite", "sqlite3", "better-sqlite3"].includes(client)) {
    return "sqlite";
  }
  return "unsupported";
}

function normalizeColumnType(
  dialect: SupportedInspectionDialect,
  value: unknown,
): RequiredColumn["type"] | "invalid" {
  const type = String(value ?? "").trim().toLowerCase();
  if (type === "text") return "text";
  if (type === "bigint" || dialect === "sqlite" && type === "integer") {
    return "bigint";
  }
  if (type === "boolean" || dialect === "sqlite" && type === "bool") {
    return "boolean";
  }
  return "invalid";
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((column, index) => column === right[index]);
}

function emptyPhysicalInspection(
  dialect: DurableObjectWritePhysicalSchemaInspection["dialect"],
  input: { tableExists?: boolean; inspectionFailed?: boolean } = {},
): DurableObjectWritePhysicalSchemaInspection {
  return {
    ready: false,
    inspectionFailed: input.inspectionFailed ?? false,
    dialect,
    tableExists: input.tableExists ?? false,
    columnsReady: false,
    indexesReady: false,
    constraintsReady: false,
    triggersReady: false,
    missingColumns: REQUIRED_COLUMNS.map((column) => column.name),
    unexpectedColumns: [],
    invalidColumns: [],
    missingIndexes: [
      "requestHash_unique",
      OBJECT_WRITE_INTENT_INDEXES.providerKey,
      OBJECT_WRITE_INTENT_INDEXES.due,
      OBJECT_WRITE_INTENT_INDEXES.project,
    ],
    invalidIndexes: [],
    missingConstraints: [...REQUIRED_CHECK_CONSTRAINTS, "primary_key"],
    invalidConstraints: [],
    missingTriggers: dialect === "sqlite"
      ? [...SQLITE_GUARD_TRIGGERS]
      : [POSTGRES_GUARD_TRIGGER],
    invalidTriggers: [],
  };
}

function evaluatePhysicalSchemaSnapshot(
  snapshot: PhysicalSchemaSnapshot,
): DurableObjectWritePhysicalSchemaInspection {
  const requiredColumnNames = new Set(
    REQUIRED_COLUMNS.map((column) => column.name),
  );
  const observedColumns = new Map(
    snapshot.columns.map((column) => [column.name, column]),
  );
  const missingColumns = REQUIRED_COLUMNS
    .filter((column) => !observedColumns.has(column.name))
    .map((column) => column.name);
  const unexpectedColumns = snapshot.columns
    .filter((column) => !requiredColumnNames.has(column.name))
    .map((column) => column.name)
    .sort();
  const invalidColumns = REQUIRED_COLUMNS.flatMap((required) => {
    const observed = observedColumns.get(required.name);
    if (!observed) return [];
    return normalizeColumnType(snapshot.dialect, observed.type) !== required.type
      || observed.notNull !== required.notNull
      ? [required.name]
      : [];
  });
  const columnsReady = missingColumns.length === 0
    && unexpectedColumns.length === 0
    && invalidColumns.length === 0;

  const expectedIndexes = [
    {
      label: "requestHash_unique",
      name: null,
      columns: ["requestHash"],
      unique: true,
    },
    {
      label: OBJECT_WRITE_INTENT_INDEXES.providerKey,
      name: OBJECT_WRITE_INTENT_INDEXES.providerKey,
      columns: ["providerFingerprint", "objectKey"],
      unique: true,
    },
    {
      label: OBJECT_WRITE_INTENT_INDEXES.due,
      name: OBJECT_WRITE_INTENT_INDEXES.due,
      columns: ["status", "nextAttemptAt", "leaseExpiresAt"],
      unique: false,
    },
    {
      label: OBJECT_WRITE_INTENT_INDEXES.project,
      name: OBJECT_WRITE_INTENT_INDEXES.project,
      columns: ["workspaceId", "projectId", "createdAt"],
      unique: false,
    },
  ] as const;
  const missingIndexes: string[] = [];
  const invalidIndexes: string[] = [];
  for (const expected of expectedIndexes) {
    const observed = snapshot.indexes.find((index) =>
      expected.name
        ? index.name === expected.name
        : index.unique && sameColumns(index.columns, expected.columns));
    if (!observed) {
      missingIndexes.push(expected.label);
      continue;
    }
    if (
      observed.unique !== expected.unique
      || !sameColumns(observed.columns, expected.columns)
      || !observed.valid
      || !observed.ready
    ) {
      invalidIndexes.push(expected.label);
    }
  }
  const indexesReady = missingIndexes.length === 0
    && invalidIndexes.length === 0;

  const missingConstraints: string[] = [];
  const invalidConstraints: string[] = [];
  for (const name of REQUIRED_CHECK_CONSTRAINTS) {
    const observed = snapshot.constraints.find((entry) =>
      entry.name === name);
    if (!observed) {
      missingConstraints.push(name);
    } else if (observed.type !== "c" || !observed.validated) {
      invalidConstraints.push(name);
    }
  }
  const primaryConstraint = snapshot.dialect === "postgres"
    ? snapshot.constraints.find((entry) => entry.type === "p")
    : snapshot.columns.find((column) =>
        column.name === "id" && column.primary);
  if (!primaryConstraint) missingConstraints.push("primary_key");
  else if (
    snapshot.dialect === "postgres"
    && "validated" in primaryConstraint
    && !primaryConstraint.validated
  ) {
    invalidConstraints.push("primary_key");
  }
  const constraintsReady = missingConstraints.length === 0
    && invalidConstraints.length === 0;

  const requiredTriggers = snapshot.dialect === "postgres"
    ? [POSTGRES_GUARD_TRIGGER]
    : [...SQLITE_GUARD_TRIGGERS];
  const missingTriggers: string[] = [];
  const invalidTriggers: string[] = [];
  for (const name of requiredTriggers) {
    const observed = snapshot.triggers.find((trigger) =>
      trigger.name === name);
    if (!observed) {
      missingTriggers.push(name);
      continue;
    }
    const enabled = snapshot.dialect === "postgres"
      ? ["O", "A"].includes(observed.enabled)
      : observed.enabled === "1";
    const definitionReady = snapshot.dialect !== "postgres"
      || observed.definition.includes(POSTGRES_GUARD_FUNCTION);
    if (!enabled || !definitionReady) invalidTriggers.push(name);
  }
  const triggersReady = missingTriggers.length === 0
    && invalidTriggers.length === 0;

  return {
    ready: columnsReady
      && indexesReady
      && constraintsReady
      && triggersReady,
    inspectionFailed: false,
    dialect: snapshot.dialect,
    tableExists: true,
    columnsReady,
    indexesReady,
    constraintsReady,
    triggersReady,
    missingColumns,
    unexpectedColumns,
    invalidColumns,
    missingIndexes,
    invalidIndexes,
    missingConstraints,
    invalidConstraints,
    missingTriggers,
    invalidTriggers,
  };
}

async function postgresPhysicalSchemaSnapshot(
  database: Knex,
): Promise<PhysicalSchemaSnapshot> {
  const columnsResult = await database.raw(
    `SELECT column_name AS "name",
            data_type AS "type",
            (is_nullable = 'NO') AS "notNull"
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ?
      ORDER BY ordinal_position`,
    [OBJECT_WRITE_INTENT_TABLE],
  );
  const indexResult = await database.raw(
    `SELECT index_class.relname AS "name",
            pg_index.indisunique AS "unique",
            pg_index.indisvalid AS "valid",
            pg_index.indisready AS "ready",
            json_agg(
              attribute.attname::text ORDER BY key.ordinality
            ) FILTER (WHERE attribute.attname IS NOT NULL) AS "columns"
       FROM pg_class table_class
       JOIN pg_namespace namespace
         ON namespace.oid = table_class.relnamespace
       JOIN pg_index
         ON pg_index.indrelid = table_class.oid
       JOIN pg_class index_class
         ON index_class.oid = pg_index.indexrelid
       CROSS JOIN LATERAL unnest(pg_index.indkey)
         WITH ORDINALITY AS key(attnum, ordinality)
       LEFT JOIN pg_attribute attribute
         ON attribute.attrelid = table_class.oid
        AND attribute.attnum = key.attnum
      WHERE namespace.nspname = current_schema()
        AND table_class.relname = ?
      GROUP BY index_class.relname,
               pg_index.indisunique,
               pg_index.indisvalid,
               pg_index.indisready
      ORDER BY index_class.relname`,
    [OBJECT_WRITE_INTENT_TABLE],
  );
  const constraintResult = await database.raw(
    `SELECT constraint_row.conname AS "name",
            constraint_row.contype AS "type",
            constraint_row.convalidated AS "validated"
       FROM pg_constraint constraint_row
       JOIN pg_class table_class
         ON table_class.oid = constraint_row.conrelid
       JOIN pg_namespace namespace
         ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = current_schema()
        AND table_class.relname = ?
      ORDER BY constraint_row.conname`,
    [OBJECT_WRITE_INTENT_TABLE],
  );
  const triggerResult = await database.raw(
    `SELECT trigger_row.tgname AS "name",
            trigger_row.tgenabled AS "enabled",
            pg_get_triggerdef(trigger_row.oid) AS "definition"
       FROM pg_trigger trigger_row
       JOIN pg_class table_class
         ON table_class.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace
         ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = current_schema()
        AND table_class.relname = ?
        AND NOT trigger_row.tgisinternal
      ORDER BY trigger_row.tgname`,
    [OBJECT_WRITE_INTENT_TABLE],
  );
  return {
    dialect: "postgres",
    columns: rawRows<Record<string, unknown>>(columnsResult).map((row) => ({
      name: String(row.name ?? ""),
      type: String(row.type ?? ""),
      notNull: row.notNull === true,
      primary: false,
    })),
    indexes: rawRows<Record<string, unknown>>(indexResult).map((row) => ({
      name: String(row.name ?? ""),
      columns: Array.isArray(row.columns)
        ? row.columns.map((column) => String(column))
        : [],
      unique: row.unique === true,
      valid: row.valid === true,
      ready: row.ready === true,
    })),
    constraints: rawRows<Record<string, unknown>>(constraintResult).map(
      (row) => ({
        name: String(row.name ?? ""),
        type: String(row.type ?? ""),
        validated: row.validated === true,
      }),
    ),
    triggers: rawRows<Record<string, unknown>>(triggerResult).map((row) => ({
      name: String(row.name ?? ""),
      enabled: String(row.enabled ?? ""),
      definition: String(row.definition ?? ""),
    })),
  };
}

async function sqlitePhysicalSchemaSnapshot(
  database: Knex,
): Promise<PhysicalSchemaSnapshot> {
  const table = quoteSqlIdentifier(OBJECT_WRITE_INTENT_TABLE);
  const columnResult = await database.raw(`PRAGMA table_info(${table})`);
  const indexListResult = await database.raw(`PRAGMA index_list(${table})`);
  const indexRows = rawRows<Record<string, unknown>>(indexListResult);
  const indexes: IndexSnapshot[] = [];
  for (const indexRow of indexRows) {
    const name = String(indexRow.name ?? "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    const info = await database.raw(
      `PRAGMA index_info(${quoteSqlIdentifier(name)})`,
    );
    const columns = rawRows<Record<string, unknown>>(info)
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((row) => String(row.name ?? ""));
    indexes.push({
      name,
      columns,
      unique: Number(indexRow.unique) === 1,
      valid: true,
      ready: true,
    });
  }
  const tableDefinitionResult = await database.raw(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [OBJECT_WRITE_INTENT_TABLE],
  );
  const tableDefinition = String(
    rawRows<Record<string, unknown>>(tableDefinitionResult)[0]?.sql ?? "",
  ).toLowerCase();
  const triggerResult = await database.raw(
    `SELECT name, sql AS definition
       FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name = ?
      ORDER BY name`,
    [OBJECT_WRITE_INTENT_TABLE],
  );
  const columns = rawRows<Record<string, unknown>>(columnResult).map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    notNull: Number(row.notnull) === 1,
    primary: Number(row.pk) === 1,
  }));
  return {
    dialect: "sqlite",
    columns,
    indexes,
    constraints: REQUIRED_CHECK_CONSTRAINTS.flatMap((name) =>
      tableDefinition.includes(name.toLowerCase())
        ? [{ name, type: "c", validated: true }]
        : []),
    triggers: rawRows<Record<string, unknown>>(triggerResult).map((row) => ({
      name: String(row.name ?? ""),
      enabled: "1",
      definition: String(row.definition ?? ""),
    })),
  };
}

export async function inspectDurableObjectWritePhysicalSchema(
  database: Knex,
): Promise<DurableObjectWritePhysicalSchemaInspection> {
  const dialect = inspectionDialect(database);
  if (dialect === "unsupported") {
    return emptyPhysicalInspection("unsupported", {
      inspectionFailed: true,
    });
  }
  try {
    const tableExists = await database.schema.hasTable(
      OBJECT_WRITE_INTENT_TABLE,
    );
    if (!tableExists) return emptyPhysicalInspection(dialect);
    const snapshot = dialect === "postgres"
      ? await postgresPhysicalSchemaSnapshot(database)
      : await sqlitePhysicalSchemaSnapshot(database);
    return evaluatePhysicalSchemaSnapshot(snapshot);
  } catch {
    return emptyPhysicalInspection(dialect, {
      tableExists: true,
      inspectionFailed: true,
    });
  }
}

function nullableSafeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function unavailableBacklog(): DurableObjectWriteBacklogInspection {
  return {
    ready: false,
    available: false,
    deadCount: null,
    dueCount: null,
    staleDueCount: null,
    oldestDueAgeMs: null,
  };
}

export async function inspectDurableObjectWriteBacklog(
  database: Knex,
  options: { now?: number; staleGraceMs?: number } = {},
): Promise<DurableObjectWriteBacklogInspection> {
  const now = options.now ?? Date.now();
  const staleGraceMs = options.staleGraceMs
    ?? DURABLE_OBJECT_WRITE_READINESS_DEFAULTS.staleGraceMs;
  if (
    !Number.isSafeInteger(now)
    || now < 0
    || !Number.isSafeInteger(staleGraceMs)
    || staleGraceMs < 0
  ) {
    return unavailableBacklog();
  }
  const staleCutoff = now - staleGraceMs;
  const dueCondition = `(
    (
      "status" = 'compensation_pending'
      AND "leaseOwner" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "nextAttemptAt" <= ?
    )
    OR (
      "status" IN ('prepared', 'stored', 'compensating')
      AND "leaseOwner" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
      AND "nextAttemptAt" <= ?
      AND "leaseExpiresAt" <= ?
    )
  )`;
  const dueTimestamp = `CASE
    WHEN "status" = 'compensation_pending' THEN "nextAttemptAt"
    WHEN "status" IN ('prepared', 'stored', 'compensating')
      THEN CASE
        WHEN "nextAttemptAt" >= "leaseExpiresAt" THEN "nextAttemptAt"
        ELSE "leaseExpiresAt"
      END
    ELSE NULL
  END`;
  try {
    const result = await database.raw(
      `SELECT
         COALESCE(SUM(CASE WHEN "status" = 'dead' THEN 1 ELSE 0 END), 0)
           AS "deadCount",
         COALESCE(SUM(CASE WHEN ${dueCondition} THEN 1 ELSE 0 END), 0)
           AS "dueCount",
         COALESCE(SUM(CASE WHEN ${dueCondition} THEN 1 ELSE 0 END), 0)
           AS "staleDueCount",
         MIN(CASE WHEN ${dueCondition} THEN ${dueTimestamp} ELSE NULL END)
           AS "oldestDueAt"
       FROM ${quoteSqlIdentifier(OBJECT_WRITE_INTENT_TABLE)}`,
      [
        now,
        now,
        now,
        staleCutoff,
        staleCutoff,
        staleCutoff,
        now,
        now,
        now,
      ],
    );
    const row = rawRows<Record<string, unknown>>(result)[0];
    if (!row) return unavailableBacklog();
    const deadCount = nullableSafeInteger(row.deadCount);
    const dueCount = nullableSafeInteger(row.dueCount);
    const staleDueCount = nullableSafeInteger(row.staleDueCount);
    const oldestDueAt = nullableSafeInteger(row.oldestDueAt);
    if (
      deadCount === null
      || dueCount === null
      || staleDueCount === null
    ) {
      return unavailableBacklog();
    }
    return {
      ready: deadCount === 0 && staleDueCount === 0,
      available: true,
      deadCount,
      dueCount,
      staleDueCount,
      oldestDueAgeMs: oldestDueAt === null
        ? null
        : Math.max(0, now - oldestDueAt),
    };
  } catch {
    return unavailableBacklog();
  }
}

export async function inspectDurableObjectWriteReadiness(
  database: Knex,
  options: DurableObjectWriteReadinessOptions = {},
): Promise<DurableObjectWriteReadinessInspection> {
  const configuration = inspectDurableObjectWriteConfiguration(
    options.environment,
  );
  const physicalSchema = await inspectDurableObjectWritePhysicalSchema(
    database,
  );
  const configuredGrace = options.staleGraceMs
    ?? configuration.staleGraceMs;
  const backlog = physicalSchema.tableExists
    && physicalSchema.columnsReady
    && configuredGrace !== null
    ? await inspectDurableObjectWriteBacklog(database, {
        ...(options.now === undefined ? {} : { now: options.now }),
        staleGraceMs: configuredGrace,
      })
    : unavailableBacklog();
  return {
    ready: configuration.ready && physicalSchema.ready && backlog.ready,
    configuration,
    physicalSchema,
    backlog,
  };
}
