import crypto from "node:crypto";

import type { Knex } from "knex";

import { isPostgresClient } from "@/lib/dbDialect";
import { ReleaseDeploymentError } from "@/lib/releaseDeploymentError";
import {
  RELEASE_DEPLOYMENT_EVENT_TABLE,
  RELEASE_DEPLOYMENT_TABLE,
  RELEASE_DEPLOYMENT_TARGET_TABLE,
} from "@/lib/migrations/releaseDeploymentOrchestration";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import {
  assertReleaseControllerStoppedEvidence,
  assertSameReleaseControllerIdentity,
  readReleaseMaintenanceActivationReservation,
  RELEASE_MAINTENANCE_ACTIVATION_FORMAT,
  RELEASE_MAINTENANCE_ACTIVATION_PHASE,
  type ReleaseMaintenanceActivationContract,
  type ReleaseControllerStoppedEvidence,
} from "@/lib/releaseMaintenanceActivation";
import {
  assertReleaseFullMaintenanceProcessBoundaryBinding,
  type ReleaseFullMaintenanceProcessBoundaryBinding,
} from "@/lib/releaseFullMaintenanceProcessLock";
import {
  assertReleaseFullMaintenanceSshMutationUncertaintyBinding,
  releaseFullMaintenanceSshMutationUncertaintyBinding,
  type ReleaseFullMaintenanceSshMutationUncertaintyBinding,
} from "@/lib/releaseFullMaintenanceSshMutationUncertainty";

export const RELEASE_MAINTENANCE_EXECUTION_FORMAT =
  "fanjin-release-maintenance-execution/v1" as const;
export const RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2 =
  "fanjin-release-maintenance-execution/v2" as const;
export const RELEASE_MAINTENANCE_EXECUTOR_KIND =
  "offline-maintenance-activator" as const;

export type ReleaseMaintenanceTrafficMode = "canary" | "full-maintenance";

export const releaseMaintenanceExecutionFailureCodes = [
  "MAINTENANCE_LISTENER_BARRIER_FAILED",
  "MAINTENANCE_API_DRAIN_FAILED",
  "MAINTENANCE_WORKER_DRAIN_FAILED",
  "MAINTENANCE_WRITER_QUIESCENCE_FAILED",
  "MAINTENANCE_BACKUP_FAILED",
  "MAINTENANCE_SCHEMA_MIGRATION_FAILED",
  "MAINTENANCE_BACKFILL_FAILED",
  "MAINTENANCE_API_ACTIVATION_FAILED",
  "MAINTENANCE_WORKER_ACTIVATION_FAILED",
  "MAINTENANCE_WORKER_RESUME_FAILED",
  "MAINTENANCE_PRIVATE_VALIDATION_FAILED",
  "MAINTENANCE_TRAFFIC_RESTORE_FAILED",
  "MAINTENANCE_PUBLIC_SMOKE_FAILED",
  "MAINTENANCE_INTERNAL_FAILED",
] as const;

export type ReleaseMaintenanceExecutionFailureCode =
  (typeof releaseMaintenanceExecutionFailureCodes)[number];

export const releaseMaintenanceExecutionRunningPhases = [
  "maintenance-draining",
  "maintenance-listener-baseline-verifying",
  "maintenance-listener-baseline-verified",
  "maintenance-listeners-disabled",
  "maintenance-api-drained",
  "maintenance-workers-drained",
  "maintenance-nodes-quiesced",
  "maintenance-writers-quiesced",
  "maintenance-backup-checkpointed",
  "maintenance-schema-migrating",
  "maintenance-schema-migrated",
  "maintenance-backfills-completed",
  "maintenance-api-target-active",
  "maintenance-worker-target-active",
  "maintenance-homogeneous-isolated-ready",
  "maintenance-workers-resumed",
  "maintenance-private-validation-passed",
  "maintenance-traffic-restore-attempted",
  "maintenance-listener-enable-attempted",
  "maintenance-listeners-enabled",
  "maintenance-canary-planned",
  "maintenance-canary-opened",
  "maintenance-canary-observation-passed",
  "maintenance-canary-contained",
  "maintenance-traffic-restored",
  "maintenance-public-smoke-passed",
] as const;

export const releaseMaintenanceExecutionTerminalPhases = [
  "maintenance-succeeded",
  "maintenance-degraded-manual",
] as const;

export type ReleaseMaintenanceExecutionRunningPhase =
  (typeof releaseMaintenanceExecutionRunningPhases)[number];
export type ReleaseMaintenanceExecutionTerminalPhase =
  (typeof releaseMaintenanceExecutionTerminalPhases)[number];
export type ReleaseMaintenanceExecutionPhase =
  | ReleaseMaintenanceExecutionRunningPhase
  | ReleaseMaintenanceExecutionTerminalPhase;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/u;
const MAINTENANCE_WORKER_PREFIX = "maintenance-activator:";
const MAINTENANCE_WORKER_ID_RE = /^maintenance-activator:[a-z0-9][a-z0-9._-]{2,63}$/u;
export const RELEASE_FULL_MAINTENANCE_RECOVERY_WORKER_PREFIX =
  "maintenance-activator:recovery-" as const;
export const RELEASE_FULL_MAINTENANCE_RECOVERY_LEASE_MS = 60_000 as const;
const RELEASE_FULL_MAINTENANCE_RECOVERY_WORKER_ID_RE =
  /^maintenance-activator:recovery-[a-z0-9][a-z0-9._-]{2,54}$/u;
const RELEASE_MUTATION_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))";

type ReleaseDb = Knex | Knex.Transaction;
type RawRow = Record<string, any>;

export class ReleaseMaintenanceExecutionError extends ReleaseDeploymentError {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, 409, code, details);
    this.name = "ReleaseMaintenanceExecutionError";
  }
}

function fail(message: string, code: string, details?: Record<string, unknown>): never {
  throw new ReleaseMaintenanceExecutionError(message, code, details);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function objectDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail(`${label} 不是有效 JSON`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label} 不是 JSON object`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} 字段不精确`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID", { label });
  }
}

function exactId(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!SAFE_KEY_RE.test(normalized)) {
    fail(`${label} 格式无效`, "RELEASE_MAINTENANCE_EXECUTION_INPUT_INVALID", { label });
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${label} 必须为正整数`, "RELEASE_MAINTENANCE_EXECUTION_INPUT_INVALID", { label });
  }
  return parsed;
}

function exactSha256(value: unknown, label: string): string {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!SHA256_RE.test(digest)) {
    fail(`${label} 必须为 sha256`, "RELEASE_MAINTENANCE_EXECUTION_EVIDENCE_INVALID", { label });
  }
  return digest;
}

function exactTimestamp(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${label} 时间戳无效`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID", { label });
  }
  return parsed;
}

function assertExecutor(input: { executorKind: unknown; workerId: unknown }): string {
  if (input.executorKind !== RELEASE_MAINTENANCE_EXECUTOR_KIND) {
    fail(
      "普通发布控制器无权调用离线维护执行状态机",
      "RELEASE_MAINTENANCE_EXECUTOR_REQUIRED",
    );
  }
  const workerId = exactId(input.workerId, "workerId");
  if (!MAINTENANCE_WORKER_ID_RE.test(workerId)) {
    fail(
      `维护执行 workerId 必须以 ${MAINTENANCE_WORKER_PREFIX} 开头`,
      "RELEASE_MAINTENANCE_EXECUTOR_REQUIRED",
    );
  }
  return workerId;
}

function assertRecoveryWorkerId(value: unknown): string {
  const workerId = exactId(value, "workerId");
  if (!RELEASE_FULL_MAINTENANCE_RECOVERY_WORKER_ID_RE.test(workerId)) {
    fail(
      `恢复 workerId 必须以 ${RELEASE_FULL_MAINTENANCE_RECOVERY_WORKER_PREFIX} 开头`,
      "RELEASE_FULL_MAINTENANCE_RECOVERY_EXECUTOR_REQUIRED",
    );
  }
  return workerId;
}

function leaseDuration(value: unknown): number {
  const leaseMs = value == null ? 60_000 : Number(value);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 60 * 60_000) {
    fail("leaseMs 必须在 5000-3600000 之间", "RELEASE_MAINTENANCE_LEASE_INVALID");
  }
  return leaseMs;
}

async function acquireReleaseMutationLock(trx: Knex.Transaction): Promise<void> {
  if (!isPostgresClient(trx)) return;
  await trx.raw(RELEASE_MUTATION_LOCK_SQL, ["fanjin-release-deployment", "production-fleet"]);
}

export interface ReleaseMaintenanceOriginalApiWeight {
  targetKey: string;
  weight: number;
}

export interface ReleaseMaintenanceEvidenceStep {
  completed: boolean;
  evidenceSha256: string | null;
  completedAt: number | null;
}

export interface ReleaseMaintenanceSchemaMigrationStep {
  attempted: boolean;
  attemptEvidenceSha256: string | null;
  attemptedAt: number | null;
  completed: boolean;
  completionEvidenceSha256: string | null;
  completedAt: number | null;
}

export interface ReleaseMaintenanceHomogeneousIsolatedReadyStep
  extends ReleaseMaintenanceEvidenceStep {
  schemaVersion: 48 | null;
  artifactSha256: string | null;
  targetEvidenceSha256ByKey: Record<string, string>;
}

export interface ReleaseMaintenanceCanaryCheckpoint {
  operationId: string | null;
  planSha256: string | null;
  plannedAt: number | null;
  opened: boolean;
  openedReceiptSha256: string | null;
  openedAt: number | null;
  observationPassed: boolean;
  observationReceiptSha256: string | null;
  observationPassedAt: number | null;
  contained: boolean;
  containmentReceiptSha256: string | null;
  containedAt: number | null;
}

export interface ReleaseMaintenanceExecutionFailure {
  code: string;
  failedPhase: ReleaseMaintenanceExecutionRunningPhase;
  irreversibleSchemaBoundaryCrossed: boolean;
  at: number;
}

export interface ReleaseMaintenanceExecutionCheckpoint {
  format:
    | typeof RELEASE_MAINTENANCE_EXECUTION_FORMAT
    | typeof RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2;
  /** Present and exact only on v2 full-maintenance checkpoints. */
  trafficMode?: "full-maintenance";
  operationId: string;
  status: "running" | "succeeded" | "degraded_manual";
  phase: ReleaseMaintenanceExecutionPhase;
  contractSha256: string;
  requestSha256: string;
  nonceSha256: string;
  executorKind: typeof RELEASE_MAINTENANCE_EXECUTOR_KIND;
  workerId: string;
  originalApiTrafficWeights: ReleaseMaintenanceOriginalApiWeight[];
  apiDrain: ReleaseMaintenanceEvidenceStep;
  workerDrain: ReleaseMaintenanceEvidenceStep;
  nodesQuiescence: ReleaseMaintenanceEvidenceStep;
  writerQuiescenceProofSha256: string | null;
  writerQuiescenceConfirmedAt: number | null;
  backupCheckpointEvidenceSha256: string | null;
  backupCheckpointCapturedAt: number | null;
  schemaMigration: ReleaseMaintenanceSchemaMigrationStep;
  maintenanceBackfillReceiptSha256: string | null;
  maintenanceBackfillCompletedAt: number | null;
  apiTargetActivation: ReleaseMaintenanceEvidenceStep;
  workerTargetActivation: ReleaseMaintenanceEvidenceStep;
  homogeneousIsolatedReady: ReleaseMaintenanceHomogeneousIsolatedReadyStep;
  workerResume: ReleaseMaintenanceEvidenceStep;
  canary: ReleaseMaintenanceCanaryCheckpoint;
  /** Present only on v2 full-maintenance checkpoints. */
  listenerBaseline?: ReleaseMaintenanceEvidenceStep;
  /** Present only on v2 full-maintenance checkpoints. */
  listenerDisable?: ReleaseMaintenanceEvidenceStep;
  /** Present only on v2 full-maintenance checkpoints. */
  privateValidation?: ReleaseMaintenanceEvidenceStep;
  /** Present only on v2; exact Root-recomputed three-file acceptance manifest. */
  privateValidationEvidenceManifestSha256?: string | null;
  /** Present only on v2 full-maintenance checkpoints. */
  trafficRestoreAttempt?: ReleaseMaintenanceEvidenceStep;
  trafficRestore: ReleaseMaintenanceEvidenceStep;
  /** Present only on v2 full-maintenance checkpoints. */
  listenerEnableAttempt?: ReleaseMaintenanceEvidenceStep;
  /** Present only on v2 full-maintenance checkpoints. */
  listenerEnable?: ReleaseMaintenanceEvidenceStep;
  /** Present and immutable only on v2 full-maintenance checkpoints. */
  sshMutationUncertainty?: ReleaseFullMaintenanceSshMutationUncertaintyBinding;
  /** Current systemd/flock owner plus a bounded takeover chain; v2 only. */
  processBoundary?: ReleaseFullMaintenanceProcessBoundaryCheckpoint;
  publicSmoke: ReleaseMaintenanceEvidenceStep;
  irreversibleSchemaBoundaryCrossed: boolean;
  failure: ReleaseMaintenanceExecutionFailure | null;
  completedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseFullMaintenanceProcessBoundaryCheckpoint {
  format: "fanjin-release-full-maintenance-process-boundary-checkpoint/v1";
  current: ReleaseFullMaintenanceProcessBoundaryBinding;
  previousProcessTokenSha256: string | null;
  generation: number;
}

export interface ReleaseMaintenanceExecutionDependencies {
  database: Knex;
  inspectControllerStopped?: () => (
    ReleaseControllerStoppedEvidence | Promise<ReleaseControllerStoppedEvidence>
  );
  now?: () => number;
  randomUUID?: () => string;
}

export interface ReleaseMaintenanceExecutionClaim {
  deploymentId: string;
  releaseId: string;
  artifactId: string;
  activeScope: string;
  workerId: string;
  revision: number;
  fencingToken: number;
  leaseExpiresAt: number;
  checkpoint: ReleaseMaintenanceExecutionCheckpoint;
}

export interface ReleaseMaintenanceExecutionState {
  deploymentId: string;
  releaseId: string;
  artifactId: string;
  activeScope: string | null;
  status: "running" | "succeeded" | "degraded_manual";
  phase: ReleaseMaintenanceExecutionPhase;
  workerId: string | null;
  revision: number;
  fencingToken: number;
  leaseExpiresAt: number | null;
  contract: ReleaseMaintenanceActivationContract;
  checkpoint: ReleaseMaintenanceExecutionCheckpoint;
}

export interface ReleaseMaintenanceCanaryRecoverySnapshot {
  format: "fanjin-release-maintenance-canary-recovery/v1";
  deploymentId: string;
  operationId: string;
  planSha256: string;
  opened: boolean;
  openedReceiptSha256: string | null;
  observationPassed: boolean;
  observationReceiptSha256: string | null;
  contained: boolean;
  containmentReceiptSha256: string | null;
  inspectRequired: true;
  containmentRequired: boolean;
  originalApiTrafficWeights: ReleaseMaintenanceOriginalApiWeight[];
  irreversibleSchemaBoundaryCrossed: boolean;
}

function normalizeOriginalWeights(
  values: readonly ReleaseMaintenanceOriginalApiWeight[],
  apiTargetKeys: readonly string[],
): ReleaseMaintenanceOriginalApiWeight[] {
  if (!Array.isArray(values)) {
    fail("原始 API 权重缺失", "RELEASE_MAINTENANCE_TRAFFIC_WEIGHTS_INVALID");
  }
  const expected = [...apiTargetKeys].sort();
  const normalized = values.map((value) => {
    const targetKey = exactId(value?.targetKey, "originalApiTrafficWeights.targetKey");
    const weight = Number(value?.weight);
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 100) {
      fail("CLB API 原始权重必须为 1-100 的整数", "RELEASE_MAINTENANCE_TRAFFIC_WEIGHTS_INVALID");
    }
    return { targetKey, weight };
  }).sort((left, right) => left.targetKey.localeCompare(right.targetKey));
  if (
    normalized.length !== expected.length
    || normalized.some((value, index) => value.targetKey !== expected[index])
    || new Set(normalized.map(({ targetKey }) => targetKey)).size !== normalized.length
  ) {
    fail(
      "CLB 原始 API 权重必须精确覆盖所有 API 目标",
      "RELEASE_MAINTENANCE_TRAFFIC_WEIGHTS_INVALID",
    );
  }
  return normalized;
}

function emptyEvidenceStep(): ReleaseMaintenanceEvidenceStep {
  return { completed: false, evidenceSha256: null, completedAt: null };
}

function completedEvidenceStep(
  evidenceSha256: string,
  completedAt: number,
): ReleaseMaintenanceEvidenceStep {
  return { completed: true, evidenceSha256, completedAt };
}

function emptyHomogeneousIsolatedReadyStep(): ReleaseMaintenanceHomogeneousIsolatedReadyStep {
  return {
    ...emptyEvidenceStep(),
    schemaVersion: null,
    artifactSha256: null,
    targetEvidenceSha256ByKey: {},
  };
}

function emptyCanaryCheckpoint(): ReleaseMaintenanceCanaryCheckpoint {
  return {
    operationId: null,
    planSha256: null,
    plannedAt: null,
    opened: false,
    openedReceiptSha256: null,
    openedAt: null,
    observationPassed: false,
    observationReceiptSha256: null,
    observationPassedAt: null,
    contained: false,
    containmentReceiptSha256: null,
    containedAt: null,
  };
}

function assertEvidenceStep(value: unknown, label: string): ReleaseMaintenanceEvidenceStep {
  const step = parseObject(value, label);
  exactKeys(step, ["completed", "completedAt", "evidenceSha256"], label);
  if (typeof step.completed !== "boolean") {
    fail(`${label}.completed 无效`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  if (step.completed) {
    exactSha256(step.evidenceSha256, `${label}.evidenceSha256`);
    exactTimestamp(step.completedAt, `${label}.completedAt`);
  } else if (step.evidenceSha256 !== null || step.completedAt !== null) {
    fail(`${label} 未完成状态包含证据`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  return step as unknown as ReleaseMaintenanceEvidenceStep;
}

function assertSchemaMigrationStep(value: unknown): ReleaseMaintenanceSchemaMigrationStep {
  const step = parseObject(value, "checkpoint.schemaMigration");
  exactKeys(step, [
    "attemptEvidenceSha256",
    "attempted",
    "attemptedAt",
    "completed",
    "completedAt",
    "completionEvidenceSha256",
  ], "checkpoint.schemaMigration");
  if (typeof step.attempted !== "boolean" || typeof step.completed !== "boolean") {
    fail("迁移状态布尔值无效", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  if (step.attempted) {
    exactSha256(step.attemptEvidenceSha256, "schemaMigration.attemptEvidenceSha256");
    exactTimestamp(step.attemptedAt, "schemaMigration.attemptedAt");
  } else if (step.attemptEvidenceSha256 !== null || step.attemptedAt !== null) {
    fail("未尝试迁移却包含尝试证据", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  if (step.completed) {
    if (!step.attempted) {
      fail("迁移完成但未记录尝试", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    }
    exactSha256(step.completionEvidenceSha256, "schemaMigration.completionEvidenceSha256");
    exactTimestamp(step.completedAt, "schemaMigration.completedAt");
  } else if (step.completionEvidenceSha256 !== null || step.completedAt !== null) {
    fail("未完成迁移却包含完成证据", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  return step as unknown as ReleaseMaintenanceSchemaMigrationStep;
}

function assertHomogeneousIsolatedReadyStep(
  value: unknown,
): ReleaseMaintenanceHomogeneousIsolatedReadyStep {
  const step = parseObject(value, "checkpoint.homogeneousIsolatedReady");
  exactKeys(step, [
    "artifactSha256",
    "completed",
    "completedAt",
    "evidenceSha256",
    "schemaVersion",
    "targetEvidenceSha256ByKey",
  ], "checkpoint.homogeneousIsolatedReady");
  const evidence = assertEvidenceStep({
    completed: step.completed,
    completedAt: step.completedAt,
    evidenceSha256: step.evidenceSha256,
  }, "checkpoint.homogeneousIsolatedReady.evidence");
  const targetEvidence = parseObject(
    step.targetEvidenceSha256ByKey,
    "checkpoint.homogeneousIsolatedReady.targetEvidenceSha256ByKey",
  );
  const normalizedTargetEvidence = Object.fromEntries(
    Object.keys(targetEvidence).sort().map((key) => [
      exactId(key, "homogeneousIsolatedReady.targetKey"),
      exactSha256(targetEvidence[key], `homogeneousIsolatedReady.${key}`),
    ]),
  );
  if (evidence.completed) {
    if (
      step.schemaVersion !== 48
      || !SHA256_RE.test(String(step.artifactSha256 || ""))
      || Object.keys(normalizedTargetEvidence).length < 1
    ) {
      fail(
        "schema 48 同构隔离就绪证据无效",
        "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
      );
    }
  } else if (
    step.schemaVersion !== null
    || step.artifactSha256 !== null
    || Object.keys(normalizedTargetEvidence).length !== 0
  ) {
    fail(
      "未完成同构隔离就绪却包含证据",
      "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
    );
  }
  return {
    ...evidence,
    schemaVersion: step.schemaVersion as 48 | null,
    artifactSha256: step.artifactSha256 as string | null,
    targetEvidenceSha256ByKey: normalizedTargetEvidence,
  };
}

function assertCanaryCheckpoint(value: unknown): ReleaseMaintenanceCanaryCheckpoint {
  const checkpoint = parseObject(value, "checkpoint.canary");
  exactKeys(checkpoint, [
    "contained",
    "containedAt",
    "containmentReceiptSha256",
    "observationPassed",
    "observationPassedAt",
    "observationReceiptSha256",
    "opened",
    "openedAt",
    "openedReceiptSha256",
    "operationId",
    "planSha256",
    "plannedAt",
  ], "checkpoint.canary");
  if (
    typeof checkpoint.opened !== "boolean"
    || typeof checkpoint.observationPassed !== "boolean"
    || typeof checkpoint.contained !== "boolean"
  ) {
    fail("canary 状态无效", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  const planned = checkpoint.operationId !== null
    || checkpoint.planSha256 !== null
    || checkpoint.plannedAt !== null;
  if (planned) {
    exactId(checkpoint.operationId, "canary.operationId");
    exactSha256(checkpoint.planSha256, "canary.planSha256");
    exactTimestamp(checkpoint.plannedAt, "canary.plannedAt");
  }
  const receiptSteps: Array<[boolean, boolean, unknown, unknown, string]> = [
    [
      checkpoint.opened,
      planned,
      checkpoint.openedReceiptSha256,
      checkpoint.openedAt,
      "canary.opened",
    ],
    [
      checkpoint.observationPassed,
      checkpoint.opened,
      checkpoint.observationReceiptSha256,
      checkpoint.observationPassedAt,
      "canary.observationPassed",
    ],
    [
      checkpoint.contained,
      planned,
      checkpoint.containmentReceiptSha256,
      checkpoint.containedAt,
      "canary.contained",
    ],
  ];
  for (const [completed, prerequisiteCompleted, receiptSha256, at, label] of receiptSteps) {
    if (completed) {
      if (!prerequisiteCompleted) {
        fail(`${label} 越级`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
      }
      exactSha256(receiptSha256, `${label}ReceiptSha256`);
      exactTimestamp(at, `${label}At`);
    } else if (receiptSha256 !== null || at !== null) {
      fail(`${label} 未完成却包含 receipt`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    }
  }
  if (!planned && canonicalJson(checkpoint) !== canonicalJson(emptyCanaryCheckpoint())) {
    fail("未计划 canary 却包含状态", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  return checkpoint as unknown as ReleaseMaintenanceCanaryCheckpoint;
}

export function releaseMaintenanceExecutionTrafficMode(
  checkpoint: Pick<ReleaseMaintenanceExecutionCheckpoint, "format" | "trafficMode">,
): ReleaseMaintenanceTrafficMode {
  if (checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT) {
    if (checkpoint.trafficMode !== undefined) {
      fail(
        "v1 checkpoint 不得声明 full-maintenance trafficMode",
        "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
      );
    }
    return "canary";
  }
  if (
    checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    && checkpoint.trafficMode === "full-maintenance"
  ) {
    return "full-maintenance";
  }
  fail(
    "维护 checkpoint format/trafficMode 组合无效",
    "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
  );
}

function releaseMaintenanceContractTrafficMode(
  contract: ReleaseMaintenanceActivationContract,
): ReleaseMaintenanceTrafficMode {
  const trafficMode = (contract as unknown as {
    trafficMode?: unknown;
  }).trafficMode;
  if (trafficMode == null || trafficMode === "canary") return "canary";
  if (trafficMode === "full-maintenance") return trafficMode;
  fail(
    "维护执行契约 trafficMode 无效",
    "RELEASE_MAINTENANCE_EXECUTION_CONTRACT_INVALID",
  );
}

function assertExecutionTrafficModeBinding(
  checkpoint: ReleaseMaintenanceExecutionCheckpoint,
  contract: ReleaseMaintenanceActivationContract,
): void {
  if (
    releaseMaintenanceExecutionTrafficMode(checkpoint)
    !== releaseMaintenanceContractTrafficMode(contract)
  ) {
    fail(
      "维护执行重启后 trafficMode 与不可变契约不一致",
      "RELEASE_MAINTENANCE_EXECUTION_CONTRACT_INVALID",
    );
  }
}

function assertProcessBoundaryCheckpoint(
  value: unknown,
): ReleaseFullMaintenanceProcessBoundaryCheckpoint {
  const boundary = parseObject(value, "checkpoint.processBoundary");
  exactKeys(boundary, [
    "current",
    "format",
    "generation",
    "previousProcessTokenSha256",
  ], "checkpoint.processBoundary");
  if (
    boundary.format !== "fanjin-release-full-maintenance-process-boundary-checkpoint/v1"
    || !Number.isSafeInteger(boundary.generation)
    || Number(boundary.generation) < 1
  ) {
    fail(
      "full-maintenance process boundary checkpoint 无效",
      "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
    );
  }
  const current = assertReleaseFullMaintenanceProcessBoundaryBinding(boundary.current);
  const previous = boundary.previousProcessTokenSha256;
  if (
    (Number(boundary.generation) === 1 && previous !== null)
    || (Number(boundary.generation) > 1 && !SHA256_RE.test(String(previous || "")))
    || previous === current.processTokenSha256
  ) {
    fail(
      "full-maintenance process boundary takeover 链无效",
      "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
    );
  }
  return Object.freeze({
    format: "fanjin-release-full-maintenance-process-boundary-checkpoint/v1",
    current,
    previousProcessTokenSha256: previous as string | null,
    generation: Number(boundary.generation),
  });
}

const commonExecutionPhases = [
  "maintenance-draining",
  "maintenance-api-drained",
  "maintenance-workers-drained",
  "maintenance-nodes-quiesced",
  "maintenance-writers-quiesced",
  "maintenance-backup-checkpointed",
  "maintenance-schema-migrating",
  "maintenance-schema-migrated",
  "maintenance-backfills-completed",
  "maintenance-api-target-active",
  "maintenance-worker-target-active",
  "maintenance-homogeneous-isolated-ready",
  "maintenance-workers-resumed",
] as const satisfies readonly ReleaseMaintenanceExecutionRunningPhase[];

const canaryExecutionPhases = [
  ...commonExecutionPhases,
  "maintenance-canary-planned",
  "maintenance-canary-opened",
  "maintenance-canary-observation-passed",
  "maintenance-canary-contained",
  "maintenance-traffic-restored",
  "maintenance-public-smoke-passed",
] as const satisfies readonly ReleaseMaintenanceExecutionRunningPhase[];

const fullMaintenanceExecutionPhases = [
  "maintenance-listener-baseline-verifying",
  "maintenance-listener-baseline-verified",
  "maintenance-listeners-disabled",
  ...commonExecutionPhases.slice(1),
  "maintenance-private-validation-passed",
  "maintenance-traffic-restore-attempted",
  "maintenance-traffic-restored",
  "maintenance-listener-enable-attempted",
  "maintenance-listeners-enabled",
  "maintenance-public-smoke-passed",
] as const satisfies readonly ReleaseMaintenanceExecutionRunningPhase[];

function executionPhasesForCheckpoint(
  checkpoint: ReleaseMaintenanceExecutionCheckpoint,
): readonly ReleaseMaintenanceExecutionRunningPhase[] {
  return releaseMaintenanceExecutionTrafficMode(checkpoint) === "full-maintenance"
    ? fullMaintenanceExecutionPhases
    : canaryExecutionPhases;
}

function assertCheckpointProgress(checkpoint: ReleaseMaintenanceExecutionCheckpoint): void {
  const trafficMode = releaseMaintenanceExecutionTrafficMode(checkpoint);
  const commonCompleted = [
    checkpoint.apiDrain.completed,
    checkpoint.workerDrain.completed,
    checkpoint.nodesQuiescence.completed,
    checkpoint.writerQuiescenceProofSha256 !== null,
    checkpoint.backupCheckpointEvidenceSha256 !== null,
    checkpoint.schemaMigration.attempted,
    checkpoint.schemaMigration.completed,
    checkpoint.maintenanceBackfillReceiptSha256 !== null,
    checkpoint.apiTargetActivation.completed,
    checkpoint.workerTargetActivation.completed,
    checkpoint.homogeneousIsolatedReady.completed,
    checkpoint.workerResume.completed,
  ];
  const completed = trafficMode === "full-maintenance"
    ? [
      checkpoint.listenerBaseline?.completed === true,
      checkpoint.listenerDisable?.completed === true,
      ...commonCompleted,
      checkpoint.privateValidation?.completed === true,
      checkpoint.trafficRestoreAttempt?.completed === true,
      checkpoint.trafficRestore.completed,
      checkpoint.listenerEnableAttempt?.completed === true,
      checkpoint.listenerEnable?.completed === true,
      checkpoint.publicSmoke.completed,
    ]
    : [
      ...commonCompleted,
      checkpoint.canary.planSha256 !== null,
      checkpoint.canary.opened,
      checkpoint.canary.observationPassed,
      checkpoint.canary.observationPassed && checkpoint.canary.contained,
      checkpoint.trafficRestore.completed,
      checkpoint.publicSmoke.completed,
    ];
  if (
    trafficMode === "full-maintenance"
    && canonicalJson(checkpoint.canary) !== canonicalJson(emptyCanaryCheckpoint())
  ) {
    fail(
      "full-maintenance checkpoint 不得伪造 canary evidence",
      "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
    );
  }
  let observedIncomplete = false;
  for (const value of completed) {
    if (!value) observedIncomplete = true;
    else if (observedIncomplete) {
      fail("维护 checkpoint 步骤出现越级", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    }
  }
  if (checkpoint.irreversibleSchemaBoundaryCrossed !== checkpoint.schemaMigration.attempted) {
    fail("不可逆迁移边界与迁移尝试状态不一致", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  if (checkpoint.status === "running") {
    const expectedCompleted = executionPhasesForCheckpoint(checkpoint).indexOf(
      checkpoint.phase as ReleaseMaintenanceExecutionRunningPhase,
    );
    if (
      expectedCompleted < 0
      || completed.some((value, index) => value !== (index < expectedCompleted))
      || checkpoint.failure !== null
      || checkpoint.completedAt !== null
    ) {
      fail("维护运行阶段与 checkpoint 进度不一致", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    }
  } else if (checkpoint.status === "succeeded") {
    if (checkpoint.phase !== "maintenance-succeeded" || completed.some((value) => !value)) {
      fail("维护成功 checkpoint 不完整", "RELEASE_MAINTENANCE_EXECUTION_INCOMPLETE");
    }
  } else {
    const expectedFailedPhase = executionPhasesForCheckpoint(checkpoint)[
      completed.filter(Boolean).length
    ];
    if (
      checkpoint.phase !== "maintenance-degraded-manual"
      || checkpoint.failure === null
      || checkpoint.failure.failedPhase !== expectedFailedPhase
      || checkpoint.failure.at !== checkpoint.completedAt
    ) {
      fail("维护失败 checkpoint 不完整", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    }
  }
}

export function assertReleaseMaintenanceExecutionCheckpoint(
  value: unknown,
  expected?: {
    deploymentId?: string;
    contractSha256?: string;
    requestSha256?: string;
    nonceSha256?: string;
    workerId?: string;
    revision?: number;
  },
): ReleaseMaintenanceExecutionCheckpoint {
  const checkpoint = parseObject(value, "deployment.checkpointJson");
  const checkpointKeys = [
    "apiDrain",
    "apiTargetActivation",
    "backupCheckpointCapturedAt",
    "backupCheckpointEvidenceSha256",
    "canary",
    "completedAt",
    "contractSha256",
    "createdAt",
    "executorKind",
    "failure",
    "format",
    "homogeneousIsolatedReady",
    "irreversibleSchemaBoundaryCrossed",
    "maintenanceBackfillCompletedAt",
    "maintenanceBackfillReceiptSha256",
    "nonceSha256",
    "nodesQuiescence",
    "operationId",
    "originalApiTrafficWeights",
    "phase",
    "publicSmoke",
    "requestSha256",
    "revision",
    "schemaMigration",
    "status",
    "trafficRestore",
    "updatedAt",
    "workerDrain",
    "workerId",
    "workerResume",
    "workerTargetActivation",
    "writerQuiescenceConfirmedAt",
    "writerQuiescenceProofSha256",
  ];
  if (checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT) {
    exactKeys(checkpoint, checkpointKeys, "deployment.checkpointJson");
  } else if (checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2) {
    exactKeys(checkpoint, [
      ...checkpointKeys,
      "listenerBaseline",
      "listenerDisable",
      "listenerEnable",
      "listenerEnableAttempt",
      "privateValidation",
      "privateValidationEvidenceManifestSha256",
      "processBoundary",
      "sshMutationUncertainty",
      "trafficMode",
      "trafficRestoreAttempt",
    ], "deployment.checkpointJson");
  } else {
    fail(
      "维护执行 checkpoint format 无效",
      "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
    );
  }
  if (
    checkpoint.executorKind !== RELEASE_MAINTENANCE_EXECUTOR_KIND
    || !SAFE_KEY_RE.test(String(checkpoint.operationId || ""))
    || !SAFE_KEY_RE.test(String(checkpoint.workerId || ""))
    || !MAINTENANCE_WORKER_ID_RE.test(String(checkpoint.workerId))
    || !SHA256_RE.test(String(checkpoint.contractSha256 || ""))
    || !SHA256_RE.test(String(checkpoint.requestSha256 || ""))
    || !SHA256_RE.test(String(checkpoint.nonceSha256 || ""))
    || !Number.isSafeInteger(checkpoint.revision)
    || Number(checkpoint.revision) < 2
    || !Number.isSafeInteger(checkpoint.createdAt)
    || Number(checkpoint.createdAt) < 1
    || !Number.isSafeInteger(checkpoint.updatedAt)
    || Number(checkpoint.updatedAt) < Number(checkpoint.createdAt)
    || !["running", "succeeded", "degraded_manual"].includes(String(checkpoint.status))
    || ![
      ...releaseMaintenanceExecutionRunningPhases,
      ...releaseMaintenanceExecutionTerminalPhases,
    ].includes(checkpoint.phase as any)
    || !Array.isArray(checkpoint.originalApiTrafficWeights)
  ) {
    fail("维护执行 checkpoint 主字段无效", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  const apiDrain = assertEvidenceStep(checkpoint.apiDrain, "checkpoint.apiDrain");
  const workerDrain = assertEvidenceStep(checkpoint.workerDrain, "checkpoint.workerDrain");
  const nodesQuiescence = assertEvidenceStep(
    checkpoint.nodesQuiescence,
    "checkpoint.nodesQuiescence",
  );
  const apiTargetActivation = assertEvidenceStep(
    checkpoint.apiTargetActivation,
    "checkpoint.apiTargetActivation",
  );
  const workerTargetActivation = assertEvidenceStep(
    checkpoint.workerTargetActivation,
    "checkpoint.workerTargetActivation",
  );
  const homogeneousIsolatedReady = assertHomogeneousIsolatedReadyStep(
    checkpoint.homogeneousIsolatedReady,
  );
  const workerResume = assertEvidenceStep(checkpoint.workerResume, "checkpoint.workerResume");
  const canary = assertCanaryCheckpoint(checkpoint.canary);
  const listenerBaseline = checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    ? assertEvidenceStep(checkpoint.listenerBaseline, "checkpoint.listenerBaseline")
    : undefined;
  const listenerDisable = checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    ? assertEvidenceStep(checkpoint.listenerDisable, "checkpoint.listenerDisable")
    : undefined;
  const privateValidation = checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    ? assertEvidenceStep(checkpoint.privateValidation, "checkpoint.privateValidation")
    : undefined;
  const privateValidationEvidenceManifestSha256 =
    checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
      ? checkpoint.privateValidationEvidenceManifestSha256
      : undefined;
  if (
    privateValidationEvidenceManifestSha256 !== undefined
    && privateValidationEvidenceManifestSha256 !== null
  ) exactSha256(
    privateValidationEvidenceManifestSha256,
    "checkpoint.privateValidationEvidenceManifestSha256",
  );
  if (
    checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    && (privateValidation?.completed === true)
      !== (privateValidationEvidenceManifestSha256 !== null)
  ) fail(
    "private validation manifest 与完成状态不一致",
    "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
  );
  const trafficRestoreAttempt = checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    ? assertEvidenceStep(checkpoint.trafficRestoreAttempt, "checkpoint.trafficRestoreAttempt")
    : undefined;
  const trafficRestore = assertEvidenceStep(checkpoint.trafficRestore, "checkpoint.trafficRestore");
  const listenerEnableAttempt = checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    ? assertEvidenceStep(checkpoint.listenerEnableAttempt, "checkpoint.listenerEnableAttempt")
    : undefined;
  const listenerEnable = checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    ? assertEvidenceStep(checkpoint.listenerEnable, "checkpoint.listenerEnable")
    : undefined;
  const sshMutationUncertainty = checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    ? assertReleaseFullMaintenanceSshMutationUncertaintyBinding(
      checkpoint.sshMutationUncertainty,
    )
    : undefined;
  const processBoundary = checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
    ? assertProcessBoundaryCheckpoint(checkpoint.processBoundary)
    : undefined;
  const publicSmoke = assertEvidenceStep(checkpoint.publicSmoke, "checkpoint.publicSmoke");
  const schemaMigration = assertSchemaMigrationStep(checkpoint.schemaMigration);
  const weights = (checkpoint.originalApiTrafficWeights as unknown[]).map((raw) => {
    const value = parseObject(raw, "checkpoint.originalApiTrafficWeights[]");
    exactKeys(value, ["targetKey", "weight"], "checkpoint.originalApiTrafficWeights[]");
    return {
      targetKey: exactId(value.targetKey, "checkpoint.originalApiTrafficWeights.targetKey"),
      weight: Number(value.weight),
    };
  });
  if (
    weights.some(({ weight }) => !Number.isSafeInteger(weight) || weight < 1 || weight > 100)
    || new Set(weights.map(({ targetKey }) => targetKey)).size !== weights.length
    || canonicalJson(weights) !== canonicalJson([...weights].sort((a, b) => a.targetKey.localeCompare(b.targetKey)))
  ) {
    fail("checkpoint 原始 API 权重无效", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  const digestTimePairs: Array<[unknown, unknown, string]> = [
    [checkpoint.writerQuiescenceProofSha256, checkpoint.writerQuiescenceConfirmedAt, "writerQuiescence"],
    [checkpoint.backupCheckpointEvidenceSha256, checkpoint.backupCheckpointCapturedAt, "backupCheckpoint"],
    [checkpoint.maintenanceBackfillReceiptSha256, checkpoint.maintenanceBackfillCompletedAt, "maintenanceBackfill"],
  ];
  for (const [digest, at, label] of digestTimePairs) {
    if (digest === null) {
      if (at !== null) fail(`${label} 时间与摘要不一致`, "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    } else {
      exactSha256(digest, `${label}Sha256`);
      exactTimestamp(at, `${label}At`);
    }
  }
  let failure: ReleaseMaintenanceExecutionFailure | null = null;
  if (checkpoint.failure !== null) {
    const parsed = parseObject(checkpoint.failure, "checkpoint.failure");
    exactKeys(parsed, ["at", "code", "failedPhase", "irreversibleSchemaBoundaryCrossed"], "checkpoint.failure");
    if (
      !releaseMaintenanceExecutionFailureCodes.includes(parsed.code as any)
      || !releaseMaintenanceExecutionRunningPhases.includes(parsed.failedPhase as any)
      || typeof parsed.irreversibleSchemaBoundaryCrossed !== "boolean"
    ) {
      fail("维护失败记录无效", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    }
    exactTimestamp(parsed.at, "checkpoint.failure.at");
    failure = parsed as unknown as ReleaseMaintenanceExecutionFailure;
  }
  const normalized = {
    ...checkpoint,
    originalApiTrafficWeights: weights,
    apiDrain,
    workerDrain,
    nodesQuiescence,
    schemaMigration,
    apiTargetActivation,
    workerTargetActivation,
    homogeneousIsolatedReady,
    workerResume,
    canary,
    ...(listenerBaseline ? { listenerBaseline } : {}),
    ...(listenerDisable ? { listenerDisable } : {}),
    ...(privateValidation ? { privateValidation } : {}),
    ...(trafficRestoreAttempt ? { trafficRestoreAttempt } : {}),
    trafficRestore,
    ...(listenerEnableAttempt ? { listenerEnableAttempt } : {}),
    ...(listenerEnable ? { listenerEnable } : {}),
    ...(sshMutationUncertainty ? { sshMutationUncertainty } : {}),
    ...(processBoundary ? { processBoundary } : {}),
    publicSmoke,
    failure,
  } as unknown as ReleaseMaintenanceExecutionCheckpoint;
  releaseMaintenanceExecutionTrafficMode(normalized);
  if (normalized.status === "running") {
    if (normalized.completedAt !== null) {
      fail("运行中 checkpoint 不得包含完成时间", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
    }
  } else {
    exactTimestamp(normalized.completedAt, "checkpoint.completedAt");
  }
  if (
    normalized.failure
    && normalized.failure.irreversibleSchemaBoundaryCrossed
      !== normalized.irreversibleSchemaBoundaryCrossed
  ) {
    fail("失败记录与不可逆迁移边界不一致", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  if (
    expected?.deploymentId != null && normalized.operationId !== expected.deploymentId
    || expected?.contractSha256 != null && normalized.contractSha256 !== expected.contractSha256
    || expected?.requestSha256 != null && normalized.requestSha256 !== expected.requestSha256
    || expected?.nonceSha256 != null && normalized.nonceSha256 !== expected.nonceSha256
    || expected?.workerId != null && normalized.workerId !== expected.workerId
    || expected?.revision != null && normalized.revision !== expected.revision
  ) {
    fail("维护执行 checkpoint 与任务身份不一致", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
  assertCheckpointProgress(normalized);
  return normalized;
}

/**
 * Produces the non-secret recovery input needed after an activator restart.
 * A durable plan always requires an upstream inspection. When containment was
 * not durably recorded, callers must run the provider's idempotent containment
 * operation even if `opened` is false: the process may have crashed after the
 * provider opened traffic but before the receipt CAS committed.
 */
export function deriveReleaseMaintenanceCanaryRecoverySnapshot(
  value: unknown,
): ReleaseMaintenanceCanaryRecoverySnapshot | null {
  const checkpoint = assertReleaseMaintenanceExecutionCheckpoint(value);
  if (!checkpoint.canary.operationId || !checkpoint.canary.planSha256) return null;
  return {
    format: "fanjin-release-maintenance-canary-recovery/v1",
    deploymentId: checkpoint.operationId,
    operationId: checkpoint.canary.operationId,
    planSha256: checkpoint.canary.planSha256,
    opened: checkpoint.canary.opened,
    openedReceiptSha256: checkpoint.canary.openedReceiptSha256,
    observationPassed: checkpoint.canary.observationPassed,
    observationReceiptSha256: checkpoint.canary.observationReceiptSha256,
    contained: checkpoint.canary.contained,
    containmentReceiptSha256: checkpoint.canary.containmentReceiptSha256,
    inspectRequired: true,
    containmentRequired: !checkpoint.canary.contained,
    originalApiTrafficWeights: checkpoint.originalApiTrafficWeights.map((weight) => ({ ...weight })),
    irreversibleSchemaBoundaryCrossed: checkpoint.irreversibleSchemaBoundaryCrossed,
  };
}

function parseContract(row: RawRow): ReleaseMaintenanceActivationContract {
  const plan = parseObject(row.planJson, "deployment.planJson");
  const contract = parseObject(plan.maintenanceActivation, "deployment.maintenanceActivation");
  const { contractSha256, ...commitment } = contract;
  if (
    plan.planVersion !== 1
    || plan.mode !== "maintenance-schema-upgrade-v1"
    || plan.rollbackOnFailure !== false
    || contract.format !== RELEASE_MAINTENANCE_ACTIVATION_FORMAT
    || contract.deploymentId !== String(row.id)
    || contract.scope !== String(row.activeScope ?? contract.scope)
    || contract.requestSha256 !== String(row.requestHash)
    || !SHA256_RE.test(String(contractSha256 || ""))
    || contractSha256 !== objectDigest(commitment)
    || !SHA256_RE.test(String(contract.nonceSha256 || ""))
    || parseObject(contract.target, "contract.target").releaseId !== String(row.releaseId)
    || parseObject(contract.target, "contract.target").artifactId !== String(row.artifactId)
  ) {
    fail("维护执行契约已变化", "RELEASE_MAINTENANCE_EXECUTION_CONTRACT_INVALID");
  }
  return contract as unknown as ReleaseMaintenanceActivationContract;
}

function assertWeightsMatchContract(
  weights: readonly ReleaseMaintenanceOriginalApiWeight[],
  contract: ReleaseMaintenanceActivationContract,
): void {
  const expected = contract.trafficMode === "full-maintenance"
    ? contract.publicTrafficBarrier.backends
      .map(({ nodeId, originalWeight }) => ({ targetKey: nodeId, weight: originalWeight }))
      .sort((left, right) => left.targetKey.localeCompare(right.targetKey))
    : contract.inventory.targets
      .filter(({ role }) => role === "api")
      .map(({ key }) => ({ targetKey: key, weight: null }))
      .sort((left, right) => left.targetKey.localeCompare(right.targetKey));
  if (
    weights.length !== expected.length
    || weights.some((weight, index) => (
      weight.targetKey !== expected[index]?.targetKey
      || (expected[index]?.weight !== null && weight.weight !== expected[index]?.weight)
    ))
  ) {
    fail(
      "checkpoint 原始 API 权重与维护契约不一致",
      "RELEASE_MAINTENANCE_TRAFFIC_WEIGHTS_INVALID",
    );
  }
}

function assertHomogeneousEvidenceMatchesContract(
  checkpoint: ReleaseMaintenanceExecutionCheckpoint,
  contract: ReleaseMaintenanceActivationContract,
): void {
  if (!checkpoint.homogeneousIsolatedReady.completed) return;
  const expectedKeys = contract.inventory.targets.map(({ key }) => key).sort();
  const observedKeys = Object.keys(
    checkpoint.homogeneousIsolatedReady.targetEvidenceSha256ByKey,
  ).sort();
  if (
    checkpoint.homogeneousIsolatedReady.schemaVersion !== 48
    || checkpoint.homogeneousIsolatedReady.artifactSha256 !== contract.target.artifactSha256
    || canonicalJson(observedKeys) !== canonicalJson(expectedKeys)
  ) {
    fail(
      "schema 48 同构隔离证据与维护契约不一致",
      "RELEASE_MAINTENANCE_HOMOGENEOUS_EVIDENCE_INVALID",
    );
  }
}

async function nextEventSequence(client: ReleaseDb, deploymentId: string): Promise<number> {
  const row = await (client as any)(RELEASE_DEPLOYMENT_EVENT_TABLE)
    .where({ deploymentId })
    .max({ sequence: "sequence" })
    .first();
  return Number(row?.sequence || 0) + 1;
}

async function appendEvent(
  trx: Knex.Transaction,
  input: {
    deploymentId: string;
    eventType: string;
    phase: ReleaseMaintenanceExecutionPhase;
    level?: "info" | "warning" | "error";
    actorUserId?: number | null;
    message: string;
    payload: Record<string, unknown>;
    now: number;
    randomUUID: () => string;
  },
): Promise<void> {
  await trx(RELEASE_DEPLOYMENT_EVENT_TABLE).insert({
    id: input.randomUUID(),
    deploymentId: input.deploymentId,
    targetId: null,
    sequence: await nextEventSequence(trx, input.deploymentId),
    eventType: input.eventType,
    phase: input.phase,
    level: input.level ?? "info",
    actor: "orchestrator",
    actorUserId: input.actorUserId ?? null,
    requestId: null,
    message: input.message,
    payloadJson: JSON.stringify(input.payload),
    createdAt: input.now,
  });
}

async function appendAudit(
  trx: Knex.Transaction,
  input: {
    action: string;
    deploymentId: string;
    actorUserId: number | null;
    metadata: Record<string, unknown>;
    now: number;
    randomUUID: () => string;
  },
): Promise<void> {
  await trx("o_audit_log").insert({
    id: input.randomUUID(),
    workspaceId: null,
    actorUserId: input.actorUserId,
    actorRole: "root",
    action: input.action,
    resourceType: "release_deployment",
    resourceId: input.deploymentId,
    ip: null,
    userAgent: null,
    metadata: JSON.stringify({ ...input.metadata, actorKind: "maintenance_orchestrator" }),
    createdAt: input.now,
  });
}

function executionCheckpointFromReservation(input: {
  deploymentId: string;
  contract: ReleaseMaintenanceActivationContract;
  workerId: string;
  originalApiTrafficWeights: ReleaseMaintenanceOriginalApiWeight[];
  processBoundary?: ReleaseFullMaintenanceProcessBoundaryBinding;
  createdAt: number;
}): ReleaseMaintenanceExecutionCheckpoint {
  const checkpoint: ReleaseMaintenanceExecutionCheckpoint = {
    format: RELEASE_MAINTENANCE_EXECUTION_FORMAT,
    operationId: input.deploymentId,
    status: "running",
    phase: "maintenance-draining",
    contractSha256: input.contract.contractSha256,
    requestSha256: input.contract.requestSha256,
    nonceSha256: input.contract.nonceSha256,
    executorKind: RELEASE_MAINTENANCE_EXECUTOR_KIND,
    workerId: input.workerId,
    originalApiTrafficWeights: input.originalApiTrafficWeights,
    apiDrain: emptyEvidenceStep(),
    workerDrain: emptyEvidenceStep(),
    nodesQuiescence: emptyEvidenceStep(),
    writerQuiescenceProofSha256: null,
    writerQuiescenceConfirmedAt: null,
    backupCheckpointEvidenceSha256: null,
    backupCheckpointCapturedAt: null,
    schemaMigration: {
      attempted: false,
      attemptEvidenceSha256: null,
      attemptedAt: null,
      completed: false,
      completionEvidenceSha256: null,
      completedAt: null,
    },
    maintenanceBackfillReceiptSha256: null,
    maintenanceBackfillCompletedAt: null,
    apiTargetActivation: emptyEvidenceStep(),
    workerTargetActivation: emptyEvidenceStep(),
    homogeneousIsolatedReady: emptyHomogeneousIsolatedReadyStep(),
    workerResume: emptyEvidenceStep(),
    canary: emptyCanaryCheckpoint(),
    trafficRestore: emptyEvidenceStep(),
    publicSmoke: emptyEvidenceStep(),
    irreversibleSchemaBoundaryCrossed: false,
    failure: null,
    completedAt: null,
    revision: 2,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  if (releaseMaintenanceContractTrafficMode(input.contract) === "full-maintenance") {
    const processBoundary = assertReleaseFullMaintenanceProcessBoundaryBinding(
      input.processBoundary,
      "execute",
    );
    return {
      ...checkpoint,
      format: RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2,
      trafficMode: "full-maintenance",
      phase: "maintenance-listener-baseline-verifying",
      listenerBaseline: emptyEvidenceStep(),
      listenerDisable: emptyEvidenceStep(),
      privateValidation: emptyEvidenceStep(),
      privateValidationEvidenceManifestSha256: null,
      trafficRestoreAttempt: emptyEvidenceStep(),
      listenerEnableAttempt: emptyEvidenceStep(),
      listenerEnable: emptyEvidenceStep(),
      sshMutationUncertainty: releaseFullMaintenanceSshMutationUncertaintyBinding(),
      processBoundary: {
        format: "fanjin-release-full-maintenance-process-boundary-checkpoint/v1",
        current: processBoundary,
        previousProcessTokenSha256: null,
        generation: 1,
      },
    };
  }
  return checkpoint;
}

export async function acquireReleaseMaintenanceExecution(
  input: {
    executorKind: typeof RELEASE_MAINTENANCE_EXECUTOR_KIND;
    deploymentId: string;
    nonce: string;
    workerId: string;
    originalApiTrafficWeights: readonly ReleaseMaintenanceOriginalApiWeight[];
    processBoundary?: ReleaseFullMaintenanceProcessBoundaryBinding;
    leaseMs?: number;
  },
  dependencies: ReleaseMaintenanceExecutionDependencies,
): Promise<ReleaseMaintenanceExecutionClaim> {
  const deploymentId = exactId(input.deploymentId, "deploymentId");
  const workerId = assertExecutor(input);
  const leaseMs = leaseDuration(input.leaseMs);
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  return dependencies.database.transaction(async (trx) => {
    await acquireReleaseMutationLock(trx);
    const reservationReadNow = dependencies.now?.() ?? Date.now();
    const reservation = await readReleaseMaintenanceActivationReservation(trx, {
      deploymentId,
      nonce: input.nonce,
      lock: true,
      now: reservationReadNow,
    });
    if (!dependencies.inspectControllerStopped) {
      fail(
        "维护执行缺少发布控制器停止状态复核器",
        "RELEASE_MAINTENANCE_CONTROLLER_RECHECK_REQUIRED",
      );
    }
    const currentControllerStopped = await dependencies.inspectControllerStopped();
    const commitNow = dependencies.now?.() ?? Date.now();
    assertReleaseControllerStoppedEvidence(
      currentControllerStopped,
      commitNow,
    );
    assertReleaseControllerStoppedEvidence(
      reservation.contract.controllerStopped,
      commitNow,
    );
    assertSameReleaseControllerIdentity(
      reservation.contract.controllerStopped,
      currentControllerStopped,
    );
    if (reservation.contract.activationExpiresAt <= commitNow) {
      fail(
        "维护激活预授权在控制器复核期间过期",
        "RELEASE_MAINTENANCE_ACTIVATION_EXPIRED",
      );
    }
    const weights = normalizeOriginalWeights(
      input.originalApiTrafficWeights,
      reservation.contract.inventory.targets
        .filter(({ role }) => role === "api")
        .map(({ key }) => key),
    );
    const leaseExpiresAt = commitNow + leaseMs;
    const checkpoint = executionCheckpointFromReservation({
      deploymentId,
      contract: reservation.contract,
      workerId,
      originalApiTrafficWeights: weights,
      processBoundary: input.processBoundary,
      createdAt: reservation.checkpoint.createdAt,
    });
    assertExecutionTrafficModeBinding(checkpoint, reservation.contract);
    checkpoint.updatedAt = commitNow;
    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({
        id: deploymentId,
        status: "running",
        phase: RELEASE_MAINTENANCE_ACTIVATION_PHASE,
        revision: 1,
        fencingToken: 1,
      })
      .whereNotNull("activeScope")
      .whereNull("leaseOwner")
      .whereNull("leaseExpiresAt")
      .update({
        phase: checkpoint.phase,
        leaseOwner: workerId,
        leaseExpiresAt,
        fencingToken: 2,
        checkpointJson: JSON.stringify(checkpoint),
        updatedAt: commitNow,
        revision: 2,
      });
    if (Number(updated) !== 1) {
      fail("维护执行租约取得 CAS 失败", "RELEASE_MAINTENANCE_ACQUIRE_CONFLICT");
    }
    for (const target of reservation.targets) {
      const targetMetadataJson = JSON.stringify({
        serverId: target.serverId,
        wave: target.wave,
        ...(target.zone ? { zone: target.zone } : {}),
        prestageEvidenceSha256: reservation.contract.prestageEvidenceSha256,
      });
      const drainedTarget = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
        .where({
          id: target.id,
          deploymentId,
          targetKey: target.key,
          targetLabel: target.label,
          role: target.role,
          ordinal: target.ordinal,
          targetMetadataJson,
          status: "pending",
          attempt: 0,
          previousReleaseId: reservation.previousReleaseId,
          previousArtifactId: reservation.previousArtifactId,
          revision: 1,
        })
        .whereNull("observedArtifactId")
        .whereNull("completedAt")
        .update({
          status: "draining",
          drainStartedAt: commitNow,
          updatedAt: commitNow,
          revision: 2,
        });
      if (Number(drainedTarget) !== 1) {
        fail("维护目标排水身份 CAS 失败", "RELEASE_MAINTENANCE_TARGET_LEDGER_INVALID", {
          targetKey: target.key,
        });
      }
    }
    await appendEvent(trx, {
      deploymentId,
      eventType: "maintenance.execution_claimed",
      phase: checkpoint.phase,
      actorUserId: reservation.contract.authorization ? Number(
        (await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).select("requestedByUserId").first())
          ?.requestedByUserId ?? 0,
      ) || null : null,
      message: "离线维护激活器已取得专用租约",
      payload: {
        workerId,
        fencingToken: 2,
        leaseExpiresAt,
        checkpointRevision: 2,
        originalApiTrafficWeightsSha256: objectDigest(weights),
        nonceSha256: reservation.contract.nonceSha256,
        ...(checkpoint.processBoundary ? {
          processBoundaryGeneration: checkpoint.processBoundary.generation,
          processTokenSha256: checkpoint.processBoundary.current.processTokenSha256,
        } : {}),
      },
      now: commitNow,
      randomUUID,
    });
    await appendAudit(trx, {
      action: "admin.release_maintenance.execution_claimed",
      deploymentId,
      actorUserId: Number(
        (await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).select("requestedByUserId").first())
          ?.requestedByUserId ?? 0,
      ) || null,
      metadata: {
        workerId,
        fencingToken: 2,
        checkpointRevision: 2,
        contractSha256: checkpoint.contractSha256,
        nonceSha256: checkpoint.nonceSha256,
        ...(checkpoint.processBoundary ? {
          processBoundaryGeneration: checkpoint.processBoundary.generation,
          processTokenSha256: checkpoint.processBoundary.current.processTokenSha256,
        } : {}),
      },
      now: commitNow,
      randomUUID,
    });
    return {
      deploymentId,
      releaseId: reservation.releaseId,
      artifactId: reservation.artifactId,
      activeScope: reservation.activeScope,
      workerId,
      revision: 2,
      fencingToken: 2,
      leaseExpiresAt,
      checkpoint,
    };
  });
}

/**
 * Fences a crashed full-maintenance v2 activator after its durable lease has
 * expired. The takeover deliberately preserves the current phase and every
 * evidence field: a recovery owner may contain production, but it may never
 * resume the migration or manufacture forward progress.
 */
export async function takeoverReleaseFullMaintenanceRecoveryExecution(
  input: {
    deploymentId: string;
    workerId: string;
    processBoundary?: ReleaseFullMaintenanceProcessBoundaryBinding;
  },
  dependencies: Pick<
    ReleaseMaintenanceExecutionDependencies,
    "database" | "now" | "randomUUID"
  >,
): Promise<ReleaseMaintenanceExecutionClaim> {
  const deploymentId = exactId(input.deploymentId, "deploymentId");
  const workerId = assertRecoveryWorkerId(input.workerId);
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  return dependencies.database.transaction(async (trx) => {
    await acquireReleaseMutationLock(trx);
    const state = await readReleaseMaintenanceExecution(trx, {
      deploymentId,
      lock: true,
    });
    const now = dependencies.now?.() ?? Date.now();
    if (
      state.status !== "running"
      || state.checkpoint.status !== "running"
      || state.checkpoint.format !== RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
      || releaseMaintenanceExecutionTrafficMode(state.checkpoint) !== "full-maintenance"
      || !state.activeScope
      || !state.workerId
      || state.leaseExpiresAt == null
      || state.leaseExpiresAt > now
    ) {
      fail(
        "仅允许接管租约已过期的 v2 full-maintenance 非终态执行",
        "RELEASE_FULL_MAINTENANCE_RECOVERY_NOT_ELIGIBLE",
        {
          status: state.status,
          phase: state.phase,
          hasActiveScope: Boolean(state.activeScope),
          leaseExpired: state.leaseExpiresAt != null && state.leaseExpiresAt <= now,
        },
      );
    }
    const nextRevision = state.revision + 1;
    const nextFencingToken = state.fencingToken + 1;
    if (
      !Number.isSafeInteger(nextRevision)
      || !Number.isSafeInteger(nextFencingToken)
      || nextRevision < 3
      || nextFencingToken < 3
    ) {
      fail(
        "恢复 fencing 计数器无效",
        "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID",
      );
    }
    const leaseExpiresAt = now + RELEASE_FULL_MAINTENANCE_RECOVERY_LEASE_MS;
    const previousProcessBoundary = assertProcessBoundaryCheckpoint(
      state.checkpoint.processBoundary,
    );
    const currentProcessBoundary = assertReleaseFullMaintenanceProcessBoundaryBinding(
      input.processBoundary,
    );
    if (
      currentProcessBoundary.processTokenSha256
        === previousProcessBoundary.current.processTokenSha256
      || currentProcessBoundary.invocationId
        === previousProcessBoundary.current.invocationId
    ) {
      fail(
        "恢复进程不得复用旧 execute/recovery 的 systemd invocation",
        "RELEASE_FULL_MAINTENANCE_RECOVERY_FENCE_CONFLICT",
      );
    }
    const checkpoint: ReleaseMaintenanceExecutionCheckpoint = {
      ...state.checkpoint,
      workerId,
      processBoundary: {
        format: "fanjin-release-full-maintenance-process-boundary-checkpoint/v1",
        current: currentProcessBoundary,
        previousProcessTokenSha256:
          previousProcessBoundary.current.processTokenSha256,
        generation: previousProcessBoundary.generation + 1,
      },
      revision: nextRevision,
      updatedAt: now,
    };
    assertReleaseMaintenanceExecutionCheckpoint(checkpoint, {
      deploymentId,
      contractSha256: state.contract.contractSha256,
      requestSha256: state.contract.requestSha256,
      nonceSha256: state.contract.nonceSha256,
      workerId,
      revision: nextRevision,
    });
    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({
        id: deploymentId,
        status: "running",
        phase: state.phase,
        activeScope: state.activeScope,
        leaseOwner: state.workerId,
        leaseExpiresAt: state.leaseExpiresAt,
        revision: state.revision,
        fencingToken: state.fencingToken,
      })
      .andWhere("leaseExpiresAt", "<=", now)
      .update({
        leaseOwner: workerId,
        leaseExpiresAt,
        fencingToken: nextFencingToken,
        checkpointJson: JSON.stringify(checkpoint),
        updatedAt: now,
        revision: nextRevision,
      });
    if (Number(updated) !== 1) {
      fail(
        "恢复接管 CAS 失败",
        "RELEASE_FULL_MAINTENANCE_RECOVERY_FENCE_CONFLICT",
      );
    }
    await appendEvent(trx, {
      deploymentId,
      eventType: "maintenance.full_maintenance_recovery_claimed",
      phase: state.phase,
      level: "warning",
      actorUserId: null,
      message: "过期的 full-maintenance 执行已由安全恢复器接管",
      payload: {
        previousWorkerId: state.workerId,
        workerId,
        previousRevision: state.revision,
        checkpointRevision: nextRevision,
        previousFencingToken: state.fencingToken,
        fencingToken: nextFencingToken,
        leaseExpiresAt,
        phasePreserved: true,
        automaticResumePermitted: false,
        automaticRollbackPermitted: false,
        processBoundaryGeneration: checkpoint.processBoundary?.generation,
        processTokenSha256: currentProcessBoundary.processTokenSha256,
      },
      now,
      randomUUID,
    });
    await appendAudit(trx, {
      action: "admin.release_maintenance.full_maintenance_recovery_claimed",
      deploymentId,
      actorUserId: null,
      metadata: {
        previousWorkerId: state.workerId,
        workerId,
        checkpointRevision: nextRevision,
        fencingToken: nextFencingToken,
        contractSha256: checkpoint.contractSha256,
        irreversibleSchemaBoundaryCrossed: checkpoint.irreversibleSchemaBoundaryCrossed,
        phasePreserved: true,
        processBoundaryGeneration: checkpoint.processBoundary?.generation,
        processTokenSha256: currentProcessBoundary.processTokenSha256,
      },
      now,
      randomUUID,
    });
    return {
      deploymentId,
      releaseId: state.releaseId,
      artifactId: state.artifactId,
      activeScope: state.activeScope,
      workerId,
      revision: nextRevision,
      fencingToken: nextFencingToken,
      leaseExpiresAt,
      checkpoint,
    };
  });
}

function rowStatusForCheckpoint(checkpoint: ReleaseMaintenanceExecutionCheckpoint): string {
  return checkpoint.status === "degraded_manual" ? "degraded_manual" : checkpoint.status;
}

function assertRowMatchesCheckpoint(row: RawRow, checkpoint: ReleaseMaintenanceExecutionCheckpoint): void {
  if (
    String(row.phase) !== checkpoint.phase
    || String(row.status) !== rowStatusForCheckpoint(checkpoint)
    || Number(row.revision) !== checkpoint.revision
    || String(row.requestHash) !== checkpoint.requestSha256
    || Number(row.rollbackOnFailure) !== 0
    || (checkpoint.status === "running" && !row.activeScope)
    || (checkpoint.status === "succeeded" && row.activeScope != null)
    || (checkpoint.status === "degraded_manual" && !row.activeScope)
  ) {
    fail("维护执行行与 checkpoint 不一致", "RELEASE_MAINTENANCE_EXECUTION_LEDGER_INVALID");
  }
}

export async function readReleaseMaintenanceExecution(
  client: ReleaseDb,
  input: { deploymentId: string; lock?: boolean },
): Promise<ReleaseMaintenanceExecutionState> {
  const deploymentId = exactId(input.deploymentId, "deploymentId");
  let query = (client as any)(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId });
  if (input.lock) query = query.forUpdate();
  const row = await query.first();
  if (!row) fail("维护执行任务不存在", "RELEASE_MAINTENANCE_EXECUTION_NOT_FOUND");
  const contract = parseContract(row as RawRow);
  const checkpoint = assertReleaseMaintenanceExecutionCheckpoint(row.checkpointJson, {
    deploymentId,
    contractSha256: contract.contractSha256,
    requestSha256: contract.requestSha256,
    nonceSha256: contract.nonceSha256,
    revision: Number(row.revision),
  });
  assertExecutionTrafficModeBinding(checkpoint, contract);
  assertWeightsMatchContract(checkpoint.originalApiTrafficWeights, contract);
  assertHomogeneousEvidenceMatchesContract(checkpoint, contract);
  assertRowMatchesCheckpoint(row as RawRow, checkpoint);
  return {
    deploymentId,
    releaseId: String(row.releaseId),
    artifactId: String(row.artifactId),
    activeScope: row.activeScope == null ? null : String(row.activeScope),
    status: String(row.status) as ReleaseMaintenanceExecutionState["status"],
    phase: checkpoint.phase,
    workerId: row.leaseOwner == null ? null : String(row.leaseOwner),
    revision: Number(row.revision),
    fencingToken: Number(row.fencingToken),
    leaseExpiresAt: row.leaseExpiresAt == null ? null : Number(row.leaseExpiresAt),
    contract,
    checkpoint,
  };
}

function assertActiveLease(
  row: RawRow,
  input: { workerId: string; expectedRevision: number; fencingToken: number },
  now: number,
): ReleaseMaintenanceExecutionCheckpoint {
  if (
    String(row.status) !== "running"
    || !releaseMaintenanceExecutionRunningPhases.includes(String(row.phase) as any)
    || !row.activeScope
    || String(row.leaseOwner || "") !== input.workerId
    || Number(row.leaseExpiresAt || 0) <= now
    || Number(row.revision) !== input.expectedRevision
    || Number(row.fencingToken) !== input.fencingToken
  ) {
    fail("维护执行租约、revision 或 fencing token 已失效", "RELEASE_MAINTENANCE_LEASE_LOST", {
      expectedRevision: input.expectedRevision,
      expectedFencingToken: input.fencingToken,
    });
  }
  const contract = parseContract(row);
  const checkpoint = assertReleaseMaintenanceExecutionCheckpoint(row.checkpointJson, {
    deploymentId: String(row.id),
    contractSha256: contract.contractSha256,
    requestSha256: contract.requestSha256,
    nonceSha256: contract.nonceSha256,
    workerId: input.workerId,
    revision: input.expectedRevision,
  });
  assertExecutionTrafficModeBinding(checkpoint, contract);
  assertWeightsMatchContract(checkpoint.originalApiTrafficWeights, contract);
  assertHomogeneousEvidenceMatchesContract(checkpoint, contract);
  return checkpoint;
}

export async function renewReleaseMaintenanceExecutionLease(
  input: {
    executorKind: typeof RELEASE_MAINTENANCE_EXECUTOR_KIND;
    deploymentId: string;
    workerId: string;
    expectedRevision: number;
    fencingToken: number;
    leaseMs?: number;
  },
  dependencies: ReleaseMaintenanceExecutionDependencies,
): Promise<{ revision: number; fencingToken: number; leaseExpiresAt: number }> {
  const deploymentId = exactId(input.deploymentId, "deploymentId");
  const workerId = assertExecutor(input);
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
  const now = dependencies.now?.() ?? Date.now();
  const leaseExpiresAt = now + leaseDuration(input.leaseMs);
  const updated = await dependencies.database(RELEASE_DEPLOYMENT_TABLE)
    .where({
      id: deploymentId,
      status: "running",
      leaseOwner: workerId,
      revision: expectedRevision,
      fencingToken,
    })
    .whereIn("phase", releaseMaintenanceExecutionRunningPhases as unknown as string[])
    .whereNotNull("activeScope")
    .andWhere("leaseExpiresAt", ">", now)
    .update({ leaseExpiresAt, updatedAt: now });
  if (Number(updated) !== 1) {
    fail("维护执行租约续期失败", "RELEASE_MAINTENANCE_LEASE_LOST");
  }
  return { revision: expectedRevision, fencingToken, leaseExpiresAt };
}

export type ReleaseMaintenanceExecutionTransition =
  | { kind: "listener-baseline-verified"; evidenceSha256: string }
  | { kind: "listeners-disabled"; evidenceSha256: string }
  | { kind: "api-drained"; evidenceSha256: string }
  | { kind: "workers-drained"; evidenceSha256: string }
  | { kind: "nodes-quiesced"; evidenceSha256: string }
  | { kind: "writers-quiesced"; writerQuiescenceProofSha256: string }
  | { kind: "backup-checkpointed"; backupCheckpointEvidenceSha256: string }
  | { kind: "schema-migration-attempted"; migrationAttemptEvidenceSha256: string }
  | { kind: "schema-migration-completed"; migrationCompletionEvidenceSha256: string }
  | { kind: "backfills-completed"; maintenanceBackfillReceiptSha256: string }
  | { kind: "api-target-activated"; evidenceSha256: string }
  | { kind: "worker-target-activated"; evidenceSha256: string }
  | {
    kind: "homogeneous-isolated-ready";
    evidenceSha256: string;
    schemaVersion: 48;
    artifactSha256: string;
    targetEvidenceSha256ByKey: Record<string, string>;
  }
  | { kind: "workers-resumed"; evidenceSha256: string }
  | {
    kind: "private-validation-passed";
    validationReceiptSha256: string;
    evidenceManifestSha256: string;
  }
  | { kind: "traffic-restore-attempted"; restoreAttemptEvidenceSha256: string }
  | { kind: "listener-enable-attempted"; evidenceSha256: string }
  | { kind: "listeners-enabled"; evidenceSha256: string }
  | { kind: "canary-planned"; canaryOperationId: string; canaryPlanSha256: string }
  | { kind: "canary-opened"; canaryOpenedReceiptSha256: string }
  | { kind: "canary-observation-passed"; canaryObservationReceiptSha256: string }
  | { kind: "canary-contained"; canaryContainmentReceiptSha256: string }
  | { kind: "canary-contained-after-failure"; canaryContainmentReceiptSha256: string }
  | { kind: "traffic-restored"; evidenceSha256: string }
  | { kind: "public-smoke-passed"; evidenceSha256: string };

const transitionPhases: Record<
  ReleaseMaintenanceExecutionTransition["kind"],
  { from: ReleaseMaintenanceExecutionRunningPhase; to: ReleaseMaintenanceExecutionRunningPhase }
> = {
  "listener-baseline-verified": {
    from: "maintenance-listener-baseline-verifying",
    to: "maintenance-listener-baseline-verified",
  },
  "listeners-disabled": {
    from: "maintenance-listener-baseline-verified",
    to: "maintenance-listeners-disabled",
  },
  "api-drained": { from: "maintenance-draining", to: "maintenance-api-drained" },
  "workers-drained": { from: "maintenance-api-drained", to: "maintenance-workers-drained" },
  "nodes-quiesced": { from: "maintenance-workers-drained", to: "maintenance-nodes-quiesced" },
  "writers-quiesced": { from: "maintenance-nodes-quiesced", to: "maintenance-writers-quiesced" },
  "backup-checkpointed": { from: "maintenance-writers-quiesced", to: "maintenance-backup-checkpointed" },
  "schema-migration-attempted": { from: "maintenance-backup-checkpointed", to: "maintenance-schema-migrating" },
  "schema-migration-completed": { from: "maintenance-schema-migrating", to: "maintenance-schema-migrated" },
  "backfills-completed": { from: "maintenance-schema-migrated", to: "maintenance-backfills-completed" },
  "api-target-activated": { from: "maintenance-backfills-completed", to: "maintenance-api-target-active" },
  "worker-target-activated": { from: "maintenance-api-target-active", to: "maintenance-worker-target-active" },
  "homogeneous-isolated-ready": {
    from: "maintenance-worker-target-active",
    to: "maintenance-homogeneous-isolated-ready",
  },
  "workers-resumed": { from: "maintenance-homogeneous-isolated-ready", to: "maintenance-workers-resumed" },
  "private-validation-passed": {
    from: "maintenance-workers-resumed",
    to: "maintenance-private-validation-passed",
  },
  "traffic-restore-attempted": {
    from: "maintenance-private-validation-passed",
    to: "maintenance-traffic-restore-attempted",
  },
  "listener-enable-attempted": {
    from: "maintenance-traffic-restored",
    to: "maintenance-listener-enable-attempted",
  },
  "listeners-enabled": {
    from: "maintenance-listener-enable-attempted",
    to: "maintenance-listeners-enabled",
  },
  "canary-planned": { from: "maintenance-workers-resumed", to: "maintenance-canary-planned" },
  "canary-opened": { from: "maintenance-canary-planned", to: "maintenance-canary-opened" },
  "canary-observation-passed": {
    from: "maintenance-canary-opened",
    to: "maintenance-canary-observation-passed",
  },
  "canary-contained": {
    from: "maintenance-canary-observation-passed",
    to: "maintenance-canary-contained",
  },
  "canary-contained-after-failure": {
    from: "maintenance-canary-opened",
    to: "maintenance-canary-opened",
  },
  "traffic-restored": { from: "maintenance-canary-contained", to: "maintenance-traffic-restored" },
  "public-smoke-passed": { from: "maintenance-traffic-restored", to: "maintenance-public-smoke-passed" },
};

function transitionEvidence(
  transition: ReleaseMaintenanceExecutionTransition,
): string {
  switch (transition.kind) {
    case "writers-quiesced": return exactSha256(
      transition.writerQuiescenceProofSha256,
      "writerQuiescenceProofSha256",
    );
    case "backup-checkpointed": return exactSha256(
      transition.backupCheckpointEvidenceSha256,
      "backupCheckpointEvidenceSha256",
    );
    case "schema-migration-attempted": return exactSha256(
      transition.migrationAttemptEvidenceSha256,
      "migrationAttemptEvidenceSha256",
    );
    case "schema-migration-completed": return exactSha256(
      transition.migrationCompletionEvidenceSha256,
      "migrationCompletionEvidenceSha256",
    );
    case "backfills-completed": return exactSha256(
      transition.maintenanceBackfillReceiptSha256,
      "maintenanceBackfillReceiptSha256",
    );
    case "private-validation-passed": return exactSha256(
      transition.validationReceiptSha256,
      "validationReceiptSha256",
    );
    case "traffic-restore-attempted": return exactSha256(
      transition.restoreAttemptEvidenceSha256,
      "restoreAttemptEvidenceSha256",
    );
    case "canary-planned": return exactSha256(
      transition.canaryPlanSha256,
      "canaryPlanSha256",
    );
    case "canary-opened": return exactSha256(
      transition.canaryOpenedReceiptSha256,
      "canaryOpenedReceiptSha256",
    );
    case "canary-observation-passed": return exactSha256(
      transition.canaryObservationReceiptSha256,
      "canaryObservationReceiptSha256",
    );
    case "canary-contained": return exactSha256(
      transition.canaryContainmentReceiptSha256,
      "canaryContainmentReceiptSha256",
    );
    case "canary-contained-after-failure": return exactSha256(
      transition.canaryContainmentReceiptSha256,
      "canaryContainmentReceiptSha256",
    );
    default: return exactSha256(transition.evidenceSha256, `${transition.kind}.evidenceSha256`);
  }
}

const canaryOnlyTransitions = new Set<ReleaseMaintenanceExecutionTransition["kind"]>([
  "canary-planned",
  "canary-opened",
  "canary-observation-passed",
  "canary-contained",
  "canary-contained-after-failure",
]);

const fullMaintenanceOnlyTransitions = new Set<ReleaseMaintenanceExecutionTransition["kind"]>([
  "listener-baseline-verified",
  "listeners-disabled",
  "private-validation-passed",
  "traffic-restore-attempted",
  "listener-enable-attempted",
  "listeners-enabled",
]);

function phasesForTransition(
  checkpoint: ReleaseMaintenanceExecutionCheckpoint,
  transition: ReleaseMaintenanceExecutionTransition,
): { from: ReleaseMaintenanceExecutionRunningPhase; to: ReleaseMaintenanceExecutionRunningPhase } {
  const trafficMode = releaseMaintenanceExecutionTrafficMode(checkpoint);
  if (
    trafficMode === "full-maintenance"
      ? canaryOnlyTransitions.has(transition.kind)
      : fullMaintenanceOnlyTransitions.has(transition.kind)
  ) {
    fail(
      "维护执行 transition 与不可变 trafficMode 不一致",
      "RELEASE_MAINTENANCE_TRANSITION_INVALID",
      { trafficMode, transition: transition.kind },
    );
  }
  if (transition.kind === "traffic-restored" && trafficMode === "full-maintenance") {
    return {
      from: "maintenance-traffic-restore-attempted",
      to: "maintenance-traffic-restored",
    };
  }
  if (transition.kind === "api-drained" && trafficMode === "full-maintenance") {
    return {
      from: "maintenance-listeners-disabled",
      to: "maintenance-api-drained",
    };
  }
  if (transition.kind === "public-smoke-passed" && trafficMode === "full-maintenance") {
    return {
      from: "maintenance-listeners-enabled",
      to: "maintenance-public-smoke-passed",
    };
  }
  if (
    transition.kind === "canary-contained-after-failure"
    && checkpoint.phase === "maintenance-canary-planned"
  ) {
    return {
      from: "maintenance-canary-planned",
      to: "maintenance-canary-planned",
    };
  }
  return transitionPhases[transition.kind];
}

function applyTransition(
  checkpoint: ReleaseMaintenanceExecutionCheckpoint,
  transition: ReleaseMaintenanceExecutionTransition,
  now: number,
): ReleaseMaintenanceExecutionCheckpoint {
  const phases = phasesForTransition(checkpoint, transition);
  if (checkpoint.phase !== phases.from || checkpoint.status !== "running") {
    fail("维护执行阶段跳转非法", "RELEASE_MAINTENANCE_TRANSITION_INVALID", {
      currentPhase: checkpoint.phase,
      transition: transition.kind,
      expectedPhase: phases.from,
    });
  }
  const evidence = transitionEvidence(transition);
  const next: ReleaseMaintenanceExecutionCheckpoint = {
    ...checkpoint,
    phase: phases.to,
    revision: checkpoint.revision + 1,
    updatedAt: now,
  };
  switch (transition.kind) {
    case "listener-baseline-verified":
      next.listenerBaseline = completedEvidenceStep(evidence, now);
      break;
    case "listeners-disabled":
      next.listenerDisable = completedEvidenceStep(evidence, now);
      break;
    case "api-drained":
      next.apiDrain = completedEvidenceStep(evidence, now);
      break;
    case "workers-drained":
      next.workerDrain = completedEvidenceStep(evidence, now);
      break;
    case "nodes-quiesced":
      next.nodesQuiescence = completedEvidenceStep(evidence, now);
      break;
    case "writers-quiesced":
      next.writerQuiescenceProofSha256 = evidence;
      next.writerQuiescenceConfirmedAt = now;
      break;
    case "backup-checkpointed":
      next.backupCheckpointEvidenceSha256 = evidence;
      next.backupCheckpointCapturedAt = now;
      break;
    case "schema-migration-attempted":
      next.schemaMigration = {
        ...next.schemaMigration,
        attempted: true,
        attemptEvidenceSha256: evidence,
        attemptedAt: now,
      };
      next.irreversibleSchemaBoundaryCrossed = true;
      break;
    case "schema-migration-completed":
      next.schemaMigration = {
        ...next.schemaMigration,
        completed: true,
        completionEvidenceSha256: evidence,
        completedAt: now,
      };
      break;
    case "backfills-completed":
      next.maintenanceBackfillReceiptSha256 = evidence;
      next.maintenanceBackfillCompletedAt = now;
      break;
    case "api-target-activated":
      next.apiTargetActivation = completedEvidenceStep(evidence, now);
      break;
    case "worker-target-activated":
      next.workerTargetActivation = completedEvidenceStep(evidence, now);
      break;
    case "homogeneous-isolated-ready": {
      if (transition.schemaVersion !== 48) {
        fail(
          "同构隔离就绪必须精确证明 schema 48",
          "RELEASE_MAINTENANCE_HOMOGENEOUS_EVIDENCE_INVALID",
        );
      }
      const rawTargetEvidence = parseObject(
        transition.targetEvidenceSha256ByKey,
        "homogeneousIsolatedReady.targetEvidenceSha256ByKey",
      );
      const targetEvidenceSha256ByKey = Object.fromEntries(
        Object.keys(rawTargetEvidence).sort().map((targetKey) => [
          exactId(targetKey, "homogeneousIsolatedReady.targetKey"),
          exactSha256(
            rawTargetEvidence[targetKey],
            `homogeneousIsolatedReady.${targetKey}`,
          ),
        ]),
      );
      if (Object.keys(targetEvidenceSha256ByKey).length < 1) {
        fail(
          "同构隔离就绪目标证据为空",
          "RELEASE_MAINTENANCE_HOMOGENEOUS_EVIDENCE_INVALID",
        );
      }
      next.homogeneousIsolatedReady = {
        ...completedEvidenceStep(evidence, now),
        schemaVersion: transition.schemaVersion,
        artifactSha256: exactSha256(
          transition.artifactSha256,
          "homogeneousIsolatedReady.artifactSha256",
        ),
        targetEvidenceSha256ByKey,
      };
      break;
    }
    case "workers-resumed":
      next.workerResume = completedEvidenceStep(evidence, now);
      break;
    case "private-validation-passed":
      next.privateValidation = completedEvidenceStep(evidence, now);
      next.privateValidationEvidenceManifestSha256 = exactSha256(
        transition.evidenceManifestSha256,
        "evidenceManifestSha256",
      );
      break;
    case "traffic-restore-attempted":
      next.trafficRestoreAttempt = completedEvidenceStep(evidence, now);
      break;
    case "listener-enable-attempted":
      next.listenerEnableAttempt = completedEvidenceStep(evidence, now);
      break;
    case "listeners-enabled":
      next.listenerEnable = completedEvidenceStep(evidence, now);
      break;
    case "canary-planned": {
      const canaryOperationId = exactId(transition.canaryOperationId, "canaryOperationId");
      if (canaryOperationId !== checkpoint.operationId) {
        fail(
          "canary operationId 与维护任务不一致",
          "RELEASE_MAINTENANCE_CANARY_PLAN_INVALID",
        );
      }
      next.canary = {
        ...next.canary,
        operationId: canaryOperationId,
        planSha256: evidence,
        plannedAt: now,
      };
      break;
    }
    case "canary-opened":
      next.canary = {
        ...next.canary,
        opened: true,
        openedReceiptSha256: evidence,
        openedAt: now,
      };
      break;
    case "canary-observation-passed":
      next.canary = {
        ...next.canary,
        observationPassed: true,
        observationReceiptSha256: evidence,
        observationPassedAt: now,
      };
      break;
    case "canary-contained":
    case "canary-contained-after-failure":
      next.canary = {
        ...next.canary,
        contained: true,
        containmentReceiptSha256: evidence,
        containedAt: now,
      };
      break;
    case "traffic-restored":
      next.trafficRestore = completedEvidenceStep(evidence, now);
      break;
    case "public-smoke-passed":
      next.publicSmoke = completedEvidenceStep(evidence, now);
      break;
  }
  assertCheckpointProgress(next);
  return next;
}

export async function advanceReleaseMaintenanceExecution(
  input: {
    executorKind: typeof RELEASE_MAINTENANCE_EXECUTOR_KIND;
    deploymentId: string;
    workerId: string;
    expectedRevision: number;
    fencingToken: number;
    transition: ReleaseMaintenanceExecutionTransition;
  },
  dependencies: ReleaseMaintenanceExecutionDependencies,
): Promise<ReleaseMaintenanceExecutionClaim> {
  const deploymentId = exactId(input.deploymentId, "deploymentId");
  const workerId = assertExecutor(input);
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  return dependencies.database.transaction(async (trx) => {
    const row = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).forUpdate().first();
    if (!row) fail("维护执行任务不存在", "RELEASE_MAINTENANCE_EXECUTION_NOT_FOUND");
    const now = dependencies.now?.() ?? Date.now();
    const checkpoint = assertActiveLease(row as RawRow, {
      workerId,
      expectedRevision,
      fencingToken,
    }, now);
    const contract = parseContract(row as RawRow);
    const next = applyTransition(checkpoint, input.transition, now);
    assertHomogeneousEvidenceMatchesContract(next, contract);
    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({
        id: deploymentId,
        status: "running",
        phase: checkpoint.phase,
        leaseOwner: workerId,
        revision: expectedRevision,
        fencingToken,
      })
      .whereNotNull("activeScope")
      .andWhere("leaseExpiresAt", ">", now)
      .update({
        phase: next.phase,
        checkpointJson: JSON.stringify(next),
        revision: next.revision,
        updatedAt: now,
      });
    if (Number(updated) !== 1) {
      fail("维护 checkpoint CAS 失败", "RELEASE_MAINTENANCE_LEASE_LOST");
    }
    if (input.transition.kind === "api-target-activated") {
      const activated = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
        .where({ deploymentId, role: "api" })
        .whereIn("status", ["pending", "draining", "deploying"])
        .update({
          status: "verifying",
          observedArtifactId: String(row.artifactId),
          deployStartedAt: now,
          updatedAt: now,
          revision: trx.raw('"revision" + 1'),
        });
      const expected = contract.inventory.targets.filter(({ role }) => role === "api").length;
      if (Number(activated) !== expected) {
        fail("API 目标激活台账不完整", "RELEASE_MAINTENANCE_TARGET_LEDGER_INVALID");
      }
    }
    if (input.transition.kind === "worker-target-activated") {
      const activated = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
        .where({ deploymentId, role: "worker" })
        .whereIn("status", ["pending", "draining", "deploying"])
        .update({
          status: "verifying",
          observedArtifactId: String(row.artifactId),
          deployStartedAt: now,
          updatedAt: now,
          revision: trx.raw('"revision" + 1'),
        });
      const expected = contract.inventory.targets.filter(({ role }) => role === "worker").length;
      if (Number(activated) !== expected) {
        fail("Worker 目标激活台账不完整", "RELEASE_MAINTENANCE_TARGET_LEDGER_INVALID");
      }
    }
    await appendEvent(trx, {
      deploymentId,
      eventType: `maintenance.${input.transition.kind.replaceAll("-", "_")}`,
      phase: next.phase,
      actorUserId: row.requestedByUserId == null ? null : Number(row.requestedByUserId),
      message: "离线维护检查点已保存",
      payload: {
        transition: input.transition.kind,
        checkpointRevision: next.revision,
        evidenceSha256: transitionEvidence(input.transition),
        irreversibleSchemaBoundaryCrossed: next.irreversibleSchemaBoundaryCrossed,
      },
      now,
      randomUUID,
    });
    return {
      deploymentId,
      releaseId: String(row.releaseId),
      artifactId: String(row.artifactId),
      activeScope: String(row.activeScope),
      workerId,
      revision: next.revision,
      fencingToken,
      leaseExpiresAt: Number(row.leaseExpiresAt),
      checkpoint: next,
    };
  });
}

function assertSuccessComplete(checkpoint: ReleaseMaintenanceExecutionCheckpoint): void {
  const commonComplete = (
    checkpoint.phase === "maintenance-public-smoke-passed"
    && checkpoint.status === "running"
    && checkpoint.apiDrain.completed
    && checkpoint.workerDrain.completed
    && checkpoint.nodesQuiescence.completed
    && Boolean(checkpoint.writerQuiescenceProofSha256)
    && Boolean(checkpoint.backupCheckpointEvidenceSha256)
    && checkpoint.schemaMigration.attempted
    && checkpoint.schemaMigration.completed
    && Boolean(checkpoint.maintenanceBackfillReceiptSha256)
    && checkpoint.apiTargetActivation.completed
    && checkpoint.workerTargetActivation.completed
    && checkpoint.homogeneousIsolatedReady.completed
    && checkpoint.workerResume.completed
    && checkpoint.trafficRestore.completed
    && checkpoint.publicSmoke.completed
  );
  const trafficMode = releaseMaintenanceExecutionTrafficMode(checkpoint);
  const trafficModeComplete = trafficMode === "full-maintenance"
    ? (
      checkpoint.listenerBaseline?.completed === true
      && checkpoint.listenerDisable?.completed === true
      && checkpoint.privateValidation?.completed === true
      && Boolean(checkpoint.privateValidationEvidenceManifestSha256)
      && checkpoint.trafficRestoreAttempt?.completed === true
      && checkpoint.listenerEnableAttempt?.completed === true
      && checkpoint.listenerEnable?.completed === true
      && canonicalJson(checkpoint.canary) === canonicalJson(emptyCanaryCheckpoint())
    )
    : (
      Boolean(checkpoint.canary.operationId)
      && Boolean(checkpoint.canary.planSha256)
      && checkpoint.canary.opened
      && Boolean(checkpoint.canary.openedReceiptSha256)
      && checkpoint.canary.observationPassed
      && Boolean(checkpoint.canary.observationReceiptSha256)
      && checkpoint.canary.contained
      && Boolean(checkpoint.canary.containmentReceiptSha256)
    );
  if (!commonComplete || !trafficModeComplete) {
    fail("维护执行证据不完整，不能发布", "RELEASE_MAINTENANCE_EXECUTION_INCOMPLETE");
  }
}

export async function completeReleaseMaintenanceExecution(
  input: {
    executorKind: typeof RELEASE_MAINTENANCE_EXECUTOR_KIND;
    deploymentId: string;
    workerId: string;
    expectedRevision: number;
    fencingToken: number;
  },
  dependencies: ReleaseMaintenanceExecutionDependencies,
): Promise<ReleaseMaintenanceExecutionState> {
  const deploymentId = exactId(input.deploymentId, "deploymentId");
  const workerId = assertExecutor(input);
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const identity = await dependencies.database(RELEASE_DEPLOYMENT_TABLE)
    .where({ id: deploymentId })
    .select("releaseId")
    .first();
  if (!identity) fail("维护执行任务不存在", "RELEASE_MAINTENANCE_EXECUTION_NOT_FOUND");
  return dependencies.database.transaction(async (trx) => {
    await acquireReleaseMutationLock(trx);
    const release = await trx(PLATFORM_RELEASE_TABLE)
      .where({ id: String(identity.releaseId) })
      .forUpdate()
      .first();
    const row = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).forUpdate().first();
    if (!row || !release) {
      fail("维护执行关联版本不存在", "RELEASE_MAINTENANCE_EXECUTION_NOT_FOUND");
    }
    const now = dependencies.now?.() ?? Date.now();
    const checkpoint = assertActiveLease(row as RawRow, {
      workerId,
      expectedRevision,
      fencingToken,
    }, now);
    const contract = parseContract(row as RawRow);
    assertSuccessComplete(checkpoint);
    if (
      String(release.status) !== "deploying"
      || Number(release.revision) !== contract.target.releaseRevision + 1
      || String(release.version) !== contract.target.releaseVersion
      || String(release.channel) !== contract.target.channel
    ) {
      fail("目标版本状态已变化，不能发布", "RELEASE_MAINTENANCE_RELEASE_CONFLICT");
    }
    const targetRows = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
      .where({ deploymentId })
      .orderBy("ordinal", "asc");
    const committedKeys = contract.inventory.targets.map(({ key }) => key);
    if (
      (targetRows as RawRow[]).length !== committedKeys.length
      || (targetRows as RawRow[]).some((target, ordinal) => (
        String(target.targetKey) !== committedKeys[ordinal]
        || !["pending", "draining", "deploying", "verifying"].includes(String(target.status))
      ))
    ) {
      fail("维护目标台账不完整，不能发布", "RELEASE_MAINTENANCE_TARGET_LEDGER_INVALID");
    }
    const next: ReleaseMaintenanceExecutionCheckpoint = {
      ...checkpoint,
      status: "succeeded",
      phase: "maintenance-succeeded",
      completedAt: now,
      revision: expectedRevision + 1,
      updatedAt: now,
    };
    assertCheckpointProgress(next);
    const completedTargets = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).where({ deploymentId }).update({
      status: "succeeded",
      observedArtifactId: String(row.artifactId),
      observedVersion: contract.target.releaseVersion,
      verifiedAt: now,
      completedAt: now,
      errorCode: null,
      safeError: null,
      updatedAt: now,
      revision: trx.raw('"revision" + 1'),
    });
    if (Number(completedTargets) !== contract.inventory.targets.length) {
      fail("维护目标成功终态写入不完整", "RELEASE_MAINTENANCE_TARGET_LEDGER_INVALID");
    }
    const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
      .where({
        id: String(row.releaseId),
        status: "deploying",
        revision: Number(release.revision),
      })
      .update({
        status: "published",
        publishedAt: now,
        publishedByUserId: row.requestedByUserId,
        updatedByUserId: row.requestedByUserId,
        updatedAt: now,
        revision: Number(release.revision) + 1,
      });
    if (Number(releaseUpdated) !== 1) {
      fail("目标版本发布 CAS 失败", "RELEASE_MAINTENANCE_RELEASE_CONFLICT");
    }
    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({
        id: deploymentId,
        status: "running",
        phase: checkpoint.phase,
        leaseOwner: workerId,
        revision: expectedRevision,
        fencingToken,
      })
      .whereNotNull("activeScope")
      .andWhere("leaseExpiresAt", ">", now)
      .update({
        status: "succeeded",
        phase: next.phase,
        activeScope: null,
        checkpointJson: JSON.stringify(next),
        completedTargetCount: Number(row.targetCount),
        succeededTargetCount: Number(row.targetCount),
        failedTargetCount: 0,
        manualInterventionRequired: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        errorCode: null,
        safeError: null,
        updatedAt: now,
        revision: next.revision,
      });
    if (Number(updated) !== 1) {
      fail("维护成功终态 CAS 失败", "RELEASE_MAINTENANCE_LEASE_LOST");
    }
    await appendEvent(trx, {
      deploymentId,
      eventType: "maintenance.execution_succeeded",
      phase: next.phase,
      actorUserId: row.requestedByUserId == null ? null : Number(row.requestedByUserId),
      message: "schema 40→48 离线维护完成并正式发布",
      payload: {
        trafficMode: releaseMaintenanceExecutionTrafficMode(next),
        checkpointRevision: next.revision,
        contractSha256: next.contractSha256,
        nodesQuiescenceEvidenceSha256: next.nodesQuiescence.evidenceSha256,
        writerQuiescenceProofSha256: next.writerQuiescenceProofSha256,
        backupCheckpointEvidenceSha256: next.backupCheckpointEvidenceSha256,
        maintenanceBackfillReceiptSha256: next.maintenanceBackfillReceiptSha256,
        homogeneousIsolatedReadyEvidenceSha256: next.homogeneousIsolatedReady.evidenceSha256,
        ...(releaseMaintenanceExecutionTrafficMode(next) === "full-maintenance" ? {
          listenerBaselineEvidenceSha256: next.listenerBaseline?.evidenceSha256,
          listenerDisableEvidenceSha256: next.listenerDisable?.evidenceSha256,
          privateValidationReceiptSha256: next.privateValidation?.evidenceSha256,
          privateValidationEvidenceManifestSha256:
            next.privateValidationEvidenceManifestSha256,
          trafficRestoreAttemptEvidenceSha256: next.trafficRestoreAttempt?.evidenceSha256,
          listenerEnableAttemptEvidenceSha256: next.listenerEnableAttempt?.evidenceSha256,
          listenerEnableEvidenceSha256: next.listenerEnable?.evidenceSha256,
        } : {
          canaryOperationId: next.canary.operationId,
          canaryPlanSha256: next.canary.planSha256,
          canaryOpenedReceiptSha256: next.canary.openedReceiptSha256,
          canaryObservationReceiptSha256: next.canary.observationReceiptSha256,
          canaryContainmentReceiptSha256: next.canary.containmentReceiptSha256,
        }),
        publicSmokeEvidenceSha256: next.publicSmoke.evidenceSha256,
      },
      now,
      randomUUID,
    });
    await appendAudit(trx, {
      action: "admin.release_maintenance.execution_succeeded",
      deploymentId,
      actorUserId: row.requestedByUserId == null ? null : Number(row.requestedByUserId),
      metadata: {
        releaseId: String(row.releaseId),
        artifactId: String(row.artifactId),
        checkpointRevision: next.revision,
        fencingToken,
        contractSha256: next.contractSha256,
        nonceSha256: next.nonceSha256,
        trafficMode: releaseMaintenanceExecutionTrafficMode(next),
      },
      now,
      randomUUID,
    });
    return {
      deploymentId,
      releaseId: String(row.releaseId),
      artifactId: String(row.artifactId),
      activeScope: null,
      status: "succeeded",
      phase: next.phase,
      workerId: null,
      revision: next.revision,
      fencingToken,
      leaseExpiresAt: null,
      contract,
      checkpoint: next,
    };
  });
}

export async function failReleaseMaintenanceExecution(
  input: {
    executorKind: typeof RELEASE_MAINTENANCE_EXECUTOR_KIND;
    deploymentId: string;
    workerId: string;
    expectedRevision: number;
    fencingToken: number;
    failureCode: ReleaseMaintenanceExecutionFailureCode;
  },
  dependencies: ReleaseMaintenanceExecutionDependencies,
): Promise<ReleaseMaintenanceExecutionState> {
  const deploymentId = exactId(input.deploymentId, "deploymentId");
  const workerId = assertExecutor(input);
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
  const failureCode = String(input.failureCode || "").trim().toUpperCase();
  if (!releaseMaintenanceExecutionFailureCodes.includes(failureCode as any)) {
    fail("failureCode 格式无效", "RELEASE_MAINTENANCE_EXECUTION_INPUT_INVALID");
  }
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const identity = await dependencies.database(RELEASE_DEPLOYMENT_TABLE)
    .where({ id: deploymentId })
    .select("releaseId")
    .first();
  if (!identity) fail("维护执行任务不存在", "RELEASE_MAINTENANCE_EXECUTION_NOT_FOUND");
  return dependencies.database.transaction(async (trx) => {
    const release = await trx(PLATFORM_RELEASE_TABLE)
      .where({ id: String(identity.releaseId) })
      .forUpdate()
      .first();
    const row = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).forUpdate().first();
    if (!row || !release) fail("维护执行任务不存在", "RELEASE_MAINTENANCE_EXECUTION_NOT_FOUND");
    const now = dependencies.now?.() ?? Date.now();
    const checkpoint = assertActiveLease(row as RawRow, {
      workerId,
      expectedRevision,
      fencingToken,
    }, now);
    const contract = parseContract(row as RawRow);
    const trafficMode = releaseMaintenanceExecutionTrafficMode(checkpoint);
    if (
      trafficMode === "canary"
      && checkpoint.canary.planSha256
      && !checkpoint.canary.contained
    ) {
      fail(
        "canary 计划存在但尚无 durable containment receipt，不能进入失败终态",
        "RELEASE_MAINTENANCE_CANARY_CONTAINMENT_REQUIRED",
      );
    }
    if (
      String(release.status) !== "deploying"
      || Number(release.revision) !== contract.target.releaseRevision + 1
      || String(release.version) !== contract.target.releaseVersion
      || String(release.channel) !== contract.target.channel
    ) {
      fail(
        "目标版本已变化，不能形成可靠的维护失败终态",
        "RELEASE_MAINTENANCE_RELEASE_CONFLICT",
      );
    }
    const next: ReleaseMaintenanceExecutionCheckpoint = {
      ...checkpoint,
      status: "degraded_manual",
      phase: "maintenance-degraded-manual",
      failure: {
        code: failureCode,
        failedPhase: checkpoint.phase as ReleaseMaintenanceExecutionRunningPhase,
        irreversibleSchemaBoundaryCrossed: checkpoint.schemaMigration.attempted,
        at: now,
      },
      completedAt: now,
      revision: expectedRevision + 1,
      updatedAt: now,
    };
    assertCheckpointProgress(next);
    const safeError = "离线维护执行失败，需要人工核验并收敛生产集群";
    const failedTargets = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
      .where({ deploymentId })
      .whereIn("status", ["pending", "draining", "deploying", "verifying", "rolling_back"])
      .update({
        status: "failed",
        completedAt: now,
        errorCode: failureCode,
        safeError,
        updatedAt: now,
        revision: trx.raw('"revision" + 1'),
      });
    if (Number(failedTargets) !== Number(row.targetCount)) {
      fail("维护目标失败终态写入不完整", "RELEASE_MAINTENANCE_TARGET_LEDGER_INVALID");
    }
    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({
        id: deploymentId,
        status: "running",
        phase: checkpoint.phase,
        leaseOwner: workerId,
        revision: expectedRevision,
        fencingToken,
      })
      .whereNotNull("activeScope")
      .andWhere("leaseExpiresAt", ">", now)
      .update({
        status: "degraded_manual",
        phase: next.phase,
        checkpointJson: JSON.stringify(next),
        completedTargetCount: Number(row.targetCount),
        succeededTargetCount: 0,
        failedTargetCount: Number(row.targetCount),
        manualInterventionRequired: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        errorCode: failureCode,
        safeError,
        updatedAt: now,
        revision: next.revision,
      });
    if (Number(updated) !== 1) {
      fail("维护失败终态 CAS 失败", "RELEASE_MAINTENANCE_LEASE_LOST");
    }
    await appendEvent(trx, {
      deploymentId,
      eventType: "maintenance.execution_degraded_manual",
      phase: next.phase,
      level: "error",
      actorUserId: row.requestedByUserId == null ? null : Number(row.requestedByUserId),
      message: "离线维护已停止并保留生产范围锁，等待人工收敛",
      payload: {
        trafficMode,
        failureCode,
        failedPhase: checkpoint.phase,
        checkpointRevision: next.revision,
        irreversibleSchemaBoundaryCrossed: next.irreversibleSchemaBoundaryCrossed,
        automaticRollbackAttempted: false,
        oldArtifactRollbackPermitted: !next.irreversibleSchemaBoundaryCrossed,
        ...(trafficMode === "full-maintenance" ? {
          privateValidationPassed: next.privateValidation?.completed === true,
          privateValidationReceiptSha256: next.privateValidation?.evidenceSha256 ?? null,
          privateValidationEvidenceManifestSha256:
            next.privateValidationEvidenceManifestSha256 ?? null,
          trafficRestoreAttempted: next.trafficRestoreAttempt?.completed === true,
          trafficRestoreAttemptEvidenceSha256:
            next.trafficRestoreAttempt?.evidenceSha256 ?? null,
          trafficRestored: next.trafficRestore.completed,
        } : {
          canaryOperationId: next.canary.operationId,
          canaryPlanSha256: next.canary.planSha256,
          canaryOpened: next.canary.opened,
          canaryContained: next.canary.contained,
          canaryContainmentReceiptSha256: next.canary.containmentReceiptSha256,
        }),
        targetReleaseStatus: "deploying",
      },
      now,
      randomUUID,
    });
    await appendAudit(trx, {
      action: "admin.release_maintenance.execution_degraded_manual",
      deploymentId,
      actorUserId: row.requestedByUserId == null ? null : Number(row.requestedByUserId),
      metadata: {
        releaseId: String(row.releaseId),
        artifactId: String(row.artifactId),
        failureCode,
        failedPhase: checkpoint.phase,
        checkpointRevision: next.revision,
        fencingToken,
        contractSha256: next.contractSha256,
        nonceSha256: next.nonceSha256,
        trafficMode,
        irreversibleSchemaBoundaryCrossed: next.irreversibleSchemaBoundaryCrossed,
      },
      now,
      randomUUID,
    });
    return {
      deploymentId,
      releaseId: String(row.releaseId),
      artifactId: String(row.artifactId),
      activeScope: String(row.activeScope),
      status: "degraded_manual",
      phase: next.phase,
      workerId: null,
      revision: next.revision,
      fencingToken,
      leaseExpiresAt: null,
      contract,
      checkpoint: next,
    };
  });
}
