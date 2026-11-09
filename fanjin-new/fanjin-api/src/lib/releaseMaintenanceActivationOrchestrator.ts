import crypto from "node:crypto";

import type {
  ReleaseMaintenanceActivationReservationRead,
} from "@/lib/releaseMaintenanceActivation";
import {
  assertReleaseFullMaintenancePrivateValidationEvidenceManifest,
  assertPersistedReleaseFullMaintenancePrivateValidationReceipt,
  createReleaseFullMaintenancePrivateValidationAuthority,
  createReleaseFullMaintenancePrivateValidationBinding,
  releaseFullMaintenancePrivateApiInventorySha256,
  type ReleaseFullMaintenancePrivateApiOrigin,
  type ReleaseFullMaintenancePrivateValidationBinding,
  type RootVerifiedPersistedReleaseFullMaintenancePrivateValidationReceipt,
} from "@/lib/releaseFullMaintenancePrivateValidation";
export type {
  ReleaseFullMaintenancePrivateValidationBinding,
  RootVerifiedPersistedReleaseFullMaintenancePrivateValidationReceipt,
} from "@/lib/releaseFullMaintenancePrivateValidation";
import {
  createMaintenanceWriterQuiescenceProof,
  type MaintenanceWriterQuiescenceProof,
  type MaintenanceWriterSessionSnapshot,
  type PersistedMaintenanceWriterQuiescenceProof,
} from "@/lib/maintenanceWriterQuiescence";
import type {
  MaintenanceBackfillCheckpointBinding,
  PersistedMaintenanceBackfillReceipt,
} from "../../scripts/lib/maintenance-backfill-plan";
import type {
  MaintenanceLoadBalancer,
  FullMaintenanceBackendHealthReceipt,
  FullMaintenanceBackendWeightReceipt,
  FullMaintenanceListenerBarrierReceipt,
  FullMaintenanceMutationUncertaintyReceipt,
  MaintenanceCanaryPlanReceipt,
  MaintenanceCanaryTrafficReceipt,
  MaintenanceNodeActivationBinding,
  MaintenanceNodeActivationResult,
  MaintenanceNodeAgent,
  NodeAgent,
  ReleaseActionContext,
  ReleaseArtifact,
  WorkerControlPlane,
  WorkerRuntimeSnapshot,
} from "@/release-controller/types";
import {
  assertReleaseMaintenanceProductionObservationReceipt,
  type PersistedReleaseMaintenanceProductionObservationReceipt,
  type ReleaseMaintenanceProductionCanaryObserver,
  type ReleaseMaintenanceProductionObservationBinding,
  type ReleaseMaintenanceProductionObservationReceipt,
} from "@/release-controller/trustedVolcengineMaintenanceControlPlane";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/u;

export type ReleaseMaintenanceExecutionPhase =
  | "maintenance-draining"
  | "maintenance-quiesced"
  | "maintenance-checkpoint"
  | "maintenance-migrating"
  | "maintenance-backfill"
  | "maintenance-api-activation"
  | "maintenance-worker-activation"
  | "maintenance-worker-resume"
  | "maintenance-traffic-restore"
  | "maintenance-public-smoke";

export type ReleaseMaintenanceExecutionEvent =
  | "listener-baseline-verified"
  | "listeners-disabled"
  | "traffic-baseline-recorded"
  | "traffic-drained"
  | "api-drained"
  | "worker-drained"
  | "node-quiesced"
  | "writer-proof-recorded"
  | "backup-checkpoint-recorded"
  | "schema-migration-attempted"
  | "schema-migration-completed"
  | "maintenance-backfill-completed"
  | "target-activation-attempted"
  | "target-activated"
  | "worker-isolation-verified"
  | "homogeneous-isolated-ready"
  | "worker-resumed"
  | "private-validation-passed"
  | "traffic-restore-attempted"
  | "canary-planned"
  | "canary-opened"
  | "canary-observation-passed"
  | "canary-contained"
  | "canary-contained-after-failure"
  | "traffic-restored"
  | "listener-enable-attempted"
  | "listeners-enabled"
  | "public-smoke-completed";

export interface ReleaseMaintenanceProgressRecord {
  event: ReleaseMaintenanceExecutionEvent;
  phase: ReleaseMaintenanceExecutionPhase;
  targetKey?: string;
  evidence?: Readonly<Record<string, unknown>>;
}

/** Durable ledger boundary. Implementations must CAS every record by lease and fencing token. */
export interface ReleaseMaintenanceProgressRecorder {
  record(record: ReleaseMaintenanceProgressRecord): Promise<void>;
  fail(input: {
    phase: ReleaseMaintenanceExecutionPhase;
    code: string;
    migrationAttempted: boolean;
  }): Promise<void>;
  succeed(input: ReleaseMaintenanceExecutionResult): Promise<void>;
}

export interface PreparedMaintenanceCheckpointEvidence {
  contentSha256: string;
  binding: MaintenanceBackfillCheckpointBinding;
}

export interface MaintenanceMigrationResult {
  schemaVersion: 48;
  runId: string;
  runStatus: "succeeded";
  pendingMigrationCount: 0;
}

export interface ReleaseMaintenanceActivationOrchestratorDependencies {
  loadBalancer: MaintenanceLoadBalancer;
  apiNodeAgent: NodeAgent & MaintenanceNodeAgent;
  workerNodeAgent: MaintenanceNodeAgent;
  workerControlPlane: WorkerControlPlane;
  recorder: ReleaseMaintenanceProgressRecorder;
  collectWriterSnapshot(): Promise<MaintenanceWriterSessionSnapshot>;
  prepareCheckpoint(): Promise<PreparedMaintenanceCheckpointEvidence>;
  persistWriterProof(
    proof: MaintenanceWriterQuiescenceProof,
  ): Promise<PersistedMaintenanceWriterQuiescenceProof>;
  applyMigration(): Promise<MaintenanceMigrationResult>;
  runBackfills(input: {
    checkpoint: PreparedMaintenanceCheckpointEvidence;
    writerProof: PersistedMaintenanceWriterQuiescenceProof;
  }): Promise<PersistedMaintenanceBackfillReceipt>;
  /**
   * Independent real private validation. Its implementation owns upstream
   * calls, billing readback and owner-only receipt persistence.
   */
  privateValidation?: (
    binding: ReleaseFullMaintenancePrivateValidationBinding,
  ) => Promise<RootVerifiedPersistedReleaseFullMaintenancePrivateValidationReceipt>;
  /**
   * Non-secret, immutable private API node-to-origin mapping. Production
   * provides it independently of the protected session config so the
   * orchestrator commits it into the dynamic validation binding.
   */
  privateApiInventory?: readonly ReleaseFullMaintenancePrivateApiOrigin[];
  /** Legacy v1 canary recovery only. Never called by full-maintenance. */
  canaryObserver?: ReleaseMaintenanceProductionCanaryObserver;
  /** Owner-only content-addressed persistence before the durable PASS transition. */
  persistCanaryObservationReceipt?(
    receipt: ReleaseMaintenanceProductionObservationReceipt,
  ): Promise<PersistedReleaseMaintenanceProductionObservationReceipt>;
  clock?: {
    now(): number;
    sleep(milliseconds: number): Promise<void>;
  };
  apiDrainTimeoutMs?: number;
  apiDrainPollIntervalMs?: number;
  minimumWriterSampleIntervalMs?: number;
  /** Fixed protected observation interval; production defaults to five minutes. */
  canaryObservationWindowMs?: number;
}

export interface ReleaseMaintenanceExecutionResult {
  deploymentId: string;
  targetArtifactSha256: string;
  databaseIdentitySha256: string;
  writerQuiescenceProofSha256: string;
  writerQuiescenceProofContentSha256: string;
  backupCheckpointEvidenceSha256: string;
  maintenanceBackfillReceiptSha256: string;
  apiNodeIds: string[];
  workerNodeIds: string[];
  privateValidationReceiptSha256?: string;
  privateValidationEvidenceManifestSha256?: string;
  restoreAttemptEvidenceSha256?: string;
  listenerBaselineEvidenceSha256?: string;
  listenerDisableEvidenceSha256?: string;
  listenerEnableAttemptEvidenceSha256?: string;
  listenerEnableEvidenceSha256?: string;
  publicSmokeComplete: true;
}

export class ReleaseMaintenanceActivationOrchestratorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseMaintenanceActivationOrchestratorError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseMaintenanceActivationOrchestratorError(code, message);
}

function exactSha(value: unknown, label: string): string {
  const normalized = String(value || "");
  if (!SHA256_RE.test(normalized)) fail("RELEASE_MAINTENANCE_EVIDENCE_INVALID", `${label} is invalid`);
  return normalized;
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

function evidenceSha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertFullMaintenanceListenerBarrierReceipt(input: {
  receipt: FullMaintenanceListenerBarrierReceipt;
  reservation: ReleaseMaintenanceActivationReservationRead;
  expectedPhase: "baseline" | "disabled" | "enabled" | "contained";
  expectedState: "all-on" | "all-off";
}): string {
  const binding = input.reservation.contract.publicTrafficBarrier;
  if (!binding) {
    fail(
      "RELEASE_MAINTENANCE_LISTENER_BARRIER_INVALID",
      "full-maintenance contract is missing its public traffic barrier",
    );
  }
  const expectedEnabled = input.expectedState === "all-on";
  const expectedStatus = expectedEnabled ? "Active" : "Disabled";
  const { evidenceSha256: receiptEvidenceSha256, ...commitment } = input.receipt;
  if (
    input.receipt.format !== "fanjin-full-maintenance-listener-barrier/v1"
    || input.receipt.operationId !== input.reservation.deploymentId
    || input.receipt.artifactSha256 !== input.reservation.contract.target.artifactSha256
    || input.receipt.loadBalancerId !== binding.loadBalancerId
    || input.receipt.serverGroupId !== binding.serverGroupId
    || input.receipt.httpListenerId !== binding.listeners[0].listenerId
    || input.receipt.httpsListenerId !== binding.listeners[1].listenerId
    || input.receipt.phase !== input.expectedPhase
    || input.receipt.observedState !== input.expectedState
    || input.receipt.stableReadCount !== 2
    || input.receipt.listeners.length !== 2
    || input.receipt.listeners[0]?.protocol !== "HTTP"
    || input.receipt.listeners[0]?.listenerId !== binding.listeners[0].listenerId
    || input.receipt.listeners[0]?.serverGroupId !== binding.serverGroupId
    || input.receipt.listeners[0]?.port !== binding.listeners[0].port
    || input.receipt.listeners[0]?.enabled !== expectedEnabled
    || input.receipt.listeners[0]?.status !== expectedStatus
    || input.receipt.listeners[1]?.protocol !== "HTTPS"
    || input.receipt.listeners[1]?.listenerId !== binding.listeners[1].listenerId
    || input.receipt.listeners[1]?.serverGroupId !== binding.serverGroupId
    || input.receipt.listeners[1]?.port !== binding.listeners[1].port
    || input.receipt.listeners[1]?.enabled !== expectedEnabled
    || input.receipt.listeners[1]?.status !== expectedStatus
    || exactSha(receiptEvidenceSha256, "listener barrier evidenceSha256")
      !== evidenceSha256(commitment)
  ) {
    fail(
      "RELEASE_MAINTENANCE_LISTENER_BARRIER_INVALID",
      "listener barrier receipt does not match the immutable contract",
    );
  }
  return receiptEvidenceSha256;
}

function expectedFullMaintenanceBackends(
  expectedWeights: Readonly<Record<string, number>>,
  expectedState: "all-zero" | "original",
): Array<{ nodeId: string; weight: number }> {
  return Object.entries(expectedWeights)
    .map(([nodeId, weight]) => ({
      nodeId,
      weight: expectedState === "all-zero" ? 0 : weight,
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function assertFullMaintenanceBackendWeightReceipt(input: {
  receipt: FullMaintenanceBackendWeightReceipt;
  reservation: ReleaseMaintenanceActivationReservationRead;
  expectedWeights: Readonly<Record<string, number>>;
  expectedState: "all-zero" | "original";
  expectedServerGroupId?: string;
}): FullMaintenanceBackendWeightReceipt {
  const barrier = input.reservation.contract.publicTrafficBarrier;
  const expectedBackends = expectedFullMaintenanceBackends(
    input.expectedWeights,
    input.expectedState,
  );
  const { evidenceSha256: receiptEvidenceSha256, ...commitment } = input.receipt;
  if (
    !barrier
    || input.receipt.format !== "fanjin-full-maintenance-backend-weight/v1"
    || input.receipt.operationId !== input.reservation.deploymentId
    || input.receipt.artifactSha256 !== input.reservation.contract.target.artifactSha256
    || input.receipt.loadBalancerId !== barrier.loadBalancerId
    || input.receipt.serverGroupId !== barrier.serverGroupId
    || (input.expectedServerGroupId !== undefined
      && input.receipt.serverGroupId !== input.expectedServerGroupId)
    || canonicalJson(input.receipt.backendBindings) !== canonicalJson(barrier.backends)
    || input.receipt.expectedState !== input.expectedState
    || input.receipt.stableReadCount !== 2
    || canonicalJson(input.receipt.backends) !== canonicalJson(expectedBackends)
    || exactSha(receiptEvidenceSha256, "backend weight evidenceSha256")
      !== evidenceSha256(commitment)
  ) {
    fail(
      "RELEASE_MAINTENANCE_BACKEND_WEIGHT_RECEIPT_INVALID",
      "backend weight receipt does not match the immutable full-maintenance fleet",
    );
  }
  return input.receipt;
}

function assertFullMaintenanceLoadBalancerTopology(input: {
  receipt: FullMaintenanceMutationUncertaintyReceipt;
  reservation: ReleaseMaintenanceActivationReservationRead;
}): void {
  const barrier = input.reservation.contract.publicTrafficBarrier;
  const { evidenceSha256: receiptEvidenceSha256, ...commitment } = input.receipt;
  if (
    !barrier
    || input.receipt.format !== "fanjin-full-maintenance-mutation-uncertainty/v1"
    || input.receipt.loadBalancerId !== barrier.loadBalancerId
    || input.receipt.serverGroupId !== barrier.serverGroupId
    || canonicalJson(input.receipt.backendBindings) !== canonicalJson(barrier.backends)
    || input.receipt.targetCount !== barrier.backends.length
    || input.receipt.requestRetryBudgetUpperBoundMs !== 0
    || !Number.isSafeInteger(input.receipt.apiRequestTimeoutUpperBoundMs)
    || input.receipt.apiRequestTimeoutUpperBoundMs < 1
    || !Number.isSafeInteger(input.receipt.operationConvergenceUpperBoundMs)
    || input.receipt.operationConvergenceUpperBoundMs < 1
    || !Number.isSafeInteger(input.receipt.pollIntervalUpperBoundMs)
    || input.receipt.pollIntervalUpperBoundMs < 1
    || !Number.isSafeInteger(input.receipt.settleMs)
    || input.receipt.settleMs < 1
    || exactSha(receiptEvidenceSha256, "CLB mutation uncertainty evidenceSha256")
      !== evidenceSha256(commitment)
  ) {
    fail(
      "RELEASE_MAINTENANCE_CLB_TOPOLOGY_BINDING_INVALID",
      "full-maintenance CLB topology differs from the immutable contract",
    );
  }
}

function assertFullMaintenanceBackendHealthReceipt(input: {
  receipt: FullMaintenanceBackendHealthReceipt;
  reservation: ReleaseMaintenanceActivationReservationRead;
  expectedWeights: Readonly<Record<string, number>>;
  expectedServerGroupId: string;
}): FullMaintenanceBackendHealthReceipt {
  const barrier = input.reservation.contract.publicTrafficBarrier;
  const expectedBackends = expectedFullMaintenanceBackends(
    input.expectedWeights,
    "original",
  ).map(({ nodeId, weight }) => ({ nodeId, weight, health: "up" as const }));
  const expectedSnapshots = [
    {
      protocol: "HTTP" as const,
      listenerId: barrier?.listeners[0].listenerId,
      backends: expectedBackends,
    },
    {
      protocol: "HTTPS" as const,
      listenerId: barrier?.listeners[1].listenerId,
      backends: expectedBackends,
    },
  ];
  const { evidenceSha256: receiptEvidenceSha256, ...commitment } = input.receipt;
  if (
    !barrier
    || input.receipt.format !== "fanjin-full-maintenance-backend-health/v1"
    || input.receipt.operationId !== input.reservation.deploymentId
    || input.receipt.artifactSha256 !== input.reservation.contract.target.artifactSha256
    || input.receipt.loadBalancerId !== barrier.loadBalancerId
    || input.receipt.serverGroupId !== input.expectedServerGroupId
    || input.receipt.httpListenerId !== barrier.listeners[0].listenerId
    || input.receipt.httpsListenerId !== barrier.listeners[1].listenerId
    || input.receipt.stableReadCount !== 2
    || canonicalJson(input.receipt.backends) !== canonicalJson(expectedBackends)
    || canonicalJson(input.receipt.listenerHealthSnapshots) !== canonicalJson(expectedSnapshots)
    || exactSha(receiptEvidenceSha256, "backend health evidenceSha256")
      !== evidenceSha256(commitment)
  ) {
    fail(
      "RELEASE_MAINTENANCE_BACKEND_HEALTH_RECEIPT_INVALID",
      "enabled listener health receipt does not match the exact restored fleet",
    );
  }
  return input.receipt;
}

function safeErrorCode(error: unknown): string {
  const candidate = String((error as { code?: unknown } | null)?.code || "");
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(candidate)
    ? candidate
    : "RELEASE_MAINTENANCE_EXECUTION_FAILED";
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const result = [...values].sort();
  if (!result.length || new Set(result).size !== result.length) {
    fail("RELEASE_MAINTENANCE_INVENTORY_INVALID", `${label} is invalid`);
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function actionContext(
  reservation: ReleaseMaintenanceActivationReservationRead,
  actionId: string,
): ReleaseActionContext {
  return {
    operationId: reservation.deploymentId,
    actionId,
    artifactSha256: reservation.contract.target.artifactSha256,
  };
}

function targetArtifact(
  reservation: ReleaseMaintenanceActivationReservationRead,
): ReleaseArtifact {
  const target = reservation.contract.target;
  if (!target.deployment || target.deployment.mode !== "container-image") {
    fail(
      "RELEASE_MAINTENANCE_TARGET_DEPLOYMENT_INVALID",
      "maintenance activation requires a signed container target",
    );
  }
  return {
    id: target.artifactId,
    releaseId: target.releaseId,
    version: target.releaseVersion,
    sha256: target.artifactSha256,
    sourceCommit: target.sourceCommit,
    schemaVersion: target.schemaVersion,
    schemaMode: "schema-neutral",
    workerProtocolVersion: target.workerProtocolVersion,
    runtimeCapabilities: target.runtimeCapabilities,
    deployment: target.deployment,
    deploymentMode: "container-image",
    imageDigest: target.deployment.imageDigest,
  };
}

function nodeBinding(
  reservation: ReleaseMaintenanceActivationReservationRead,
  nodeId: string,
  role: "api" | "worker",
): MaintenanceNodeActivationBinding {
  const target = reservation.contract.target;
  if (!target.deployment || target.deployment.mode !== "container-image") {
    fail(
      "RELEASE_MAINTENANCE_TARGET_DEPLOYMENT_INVALID",
      "maintenance activation requires a signed container target",
    );
  }
  return {
    nodeId,
    role,
    expectedCurrentReleaseId: reservation.contract.previous.releaseId,
    expectedCurrentArtifactSha256: reservation.contract.previous.artifactSha256,
    targetReleaseId: target.releaseId,
    targetArtifactSha256: target.artifactSha256,
    targetSourceCommit: target.sourceCommit,
    targetSchemaVersion: target.schemaVersion,
    targetDeploymentMode: "container-image",
    targetImageDigest: target.deployment.imageDigest,
  };
}

function assertMaintenanceActivationResult(input: {
  result: MaintenanceNodeActivationResult;
  binding: MaintenanceNodeActivationBinding;
  reservation: ReleaseMaintenanceActivationReservationRead;
}): string {
  const { result, binding, reservation } = input;
  const maintenance = result.maintenance;
  const readiness = result.readiness;
  if (
    maintenance.format !== "fanjin-node-maintenance-activation/v1"
    || maintenance.operationId !== reservation.deploymentId
    || maintenance.nodeId !== binding.nodeId
    || maintenance.role !== binding.role
    || maintenance.state !== "consumed"
    || maintenance.expectedCurrentReleaseId !== binding.expectedCurrentReleaseId
    || maintenance.expectedCurrentArtifactSha256 !== binding.expectedCurrentArtifactSha256
    || maintenance.targetReleaseId !== binding.targetReleaseId
    || maintenance.targetArtifactSha256 !== binding.targetArtifactSha256
    || maintenance.targetSchemaVersion !== binding.targetSchemaVersion
    || maintenance.targetDeploymentMode !== binding.targetDeploymentMode
    || maintenance.targetImageDigest !== binding.targetImageDigest
    || !readiness.ready
    || readiness.role !== binding.role
    || readiness.releaseId !== binding.targetReleaseId
    || readiness.artifactSha256 !== binding.targetArtifactSha256
    || readiness.sourceCommit !== binding.targetSourceCommit
    || readiness.schemaVersion !== binding.targetSchemaVersion
    || readiness.deploymentMode !== binding.targetDeploymentMode
    || readiness.imageDigest !== binding.targetImageDigest
    || (binding.role === "worker" && (
      readiness.role !== "worker"
      || !readiness.isolated
      || readiness.acceptingWork
      || readiness.activeTaskCount !== 0
      || readiness.drainOperationId !== reservation.deploymentId
    ))
  ) {
    fail(
      "RELEASE_MAINTENANCE_ACTIVATION_RECEIPT_MISMATCH",
      `maintenance activation receipt for ${binding.nodeId} is not exact`,
    );
  }
  return exactSha(maintenance.bindingSha256, "maintenance.bindingSha256");
}

export interface ReleaseMaintenanceHomogeneousFleetEvidence {
  format: "fanjin-release-maintenance-homogeneous-fleet/v2";
  deploymentId: string;
  prestageEvidenceSha256: string;
  inventorySha256: string;
  target: {
    releaseId: string;
    artifactSha256: string;
    sourceCommit: string;
    schemaVersion: 48;
    deploymentMode: "container-image";
    imageDigest: string;
  };
  loadBalancerWeightEvidenceSha256: string;
  loadBalancer: Array<{ nodeId: string; weight: 0 }>;
  api: Array<{ nodeId: string; activationBindingSha256: string }>;
  workers: Array<{
    nodeId: string;
    activationBindingSha256: string;
    heartbeatAt: number;
  }>;
  targetEvidenceSha256ByKey: Record<string, string>;
  observedAt: number;
  evidenceSha256: string;
}

function createHomogeneousFleetEvidence(input: Omit<
  ReleaseMaintenanceHomogeneousFleetEvidence,
  "format" | "targetEvidenceSha256ByKey" | "evidenceSha256"
>): ReleaseMaintenanceHomogeneousFleetEvidence {
  const shared = {
    format: "fanjin-release-maintenance-homogeneous-target/v2" as const,
    deploymentId: input.deploymentId,
    prestageEvidenceSha256: input.prestageEvidenceSha256,
    inventorySha256: input.inventorySha256,
    target: input.target,
    loadBalancerWeightEvidenceSha256: input.loadBalancerWeightEvidenceSha256,
    loadBalancer: input.loadBalancer,
    observedAt: input.observedAt,
  };
  const targetEvidenceSha256ByKey = Object.fromEntries([
    ...input.api.map((entry) => [
      entry.nodeId,
      evidenceSha256({ ...shared, role: "api", ...entry }),
    ] as const),
    ...input.workers.map((entry) => [
      entry.nodeId,
      evidenceSha256({ ...shared, role: "worker", ...entry }),
    ] as const),
  ].sort(([left], [right]) => left.localeCompare(right)));
  const commitment = {
    format: "fanjin-release-maintenance-homogeneous-fleet/v2" as const,
    ...input,
    targetEvidenceSha256ByKey,
  };
  return { ...commitment, evidenceSha256: evidenceSha256(commitment) };
}

function assertCanaryPlan(input: {
  plan: MaintenanceCanaryPlanReceipt;
  reservation: ReleaseMaintenanceActivationReservationRead;
  apiNodeIds: readonly string[];
  authorizationSha256: string;
  observationWindowMs: number;
}): MaintenanceCanaryPlanReceipt {
  const { plan, reservation, apiNodeIds, authorizationSha256, observationWindowMs } = input;
  if (
    plan.format !== "fanjin-maintenance-canary-plan/v1"
    || plan.operationId !== reservation.deploymentId
    || plan.artifactSha256 !== reservation.contract.target.artifactSha256
    || plan.authorizationSha256 !== authorizationSha256
    || !SHA256_RE.test(plan.planDigestSha256)
    || !Number.isSafeInteger(plan.trafficWeightPercent)
    || plan.trafficWeightPercent < 1
    || plan.trafficWeightPercent > 10
    || plan.productionBackendWeight !== 0
    || plan.maintenanceTrafficWeightPercent !== 100 - plan.trafficWeightPercent
    || !Number.isSafeInteger(plan.autoContainAfterMs)
    || plan.autoContainAfterMs < observationWindowMs + 30_000
    || plan.autoContainAfterMs > 60 * 60_000
    || typeof plan.expectedContainedProviderRevision !== "string"
    || !plan.expectedContainedProviderRevision
    || plan.expectedContainedProviderRevision.length > 256
    || /[\u0000-\u001f\u007f]/u.test(plan.expectedContainedProviderRevision)
    || !sameStrings(plan.apiNodeIds, apiNodeIds)
    || !sameStrings(plan.productionTargets.map(({ nodeId }) => nodeId), apiNodeIds)
    || !sameStrings(plan.canaryTargets.map(({ nodeId }) => nodeId), apiNodeIds)
  ) {
    fail(
      "RELEASE_MAINTENANCE_CANARY_PLAN_MISMATCH",
      "maintenance canary plan is not bound to the exact deployment and API fleet",
    );
  }
  return plan;
}

function assertCanaryTrafficReceipt(input: {
  receipt: MaintenanceCanaryTrafficReceipt;
  plan: MaintenanceCanaryPlanReceipt;
  expectedState: "open" | "contained";
}): string {
  const { receipt, plan, expectedState } = input;
  const expectedPercent = expectedState === "open" ? plan.trafficWeightPercent : 0;
  if (
    receipt.format !== "fanjin-maintenance-canary-traffic/v1"
    || receipt.operationId !== plan.operationId
    || receipt.artifactSha256 !== plan.artifactSha256
    || receipt.planDigestSha256 !== plan.planDigestSha256
    || receipt.state !== expectedState
    || receipt.observedTrafficWeightPercent !== expectedPercent
    || receipt.observedMaintenanceTrafficWeightPercent !== 100 - expectedPercent
    || receipt.autoContainAfterMs !== plan.autoContainAfterMs
    || receipt.productionBackendsAllZero !== true
    || receipt.canaryListenerId !== plan.canaryListenerId
    || receipt.trafficGateId !== plan.trafficGateId
    || receipt.maintenanceServerGroupId !== plan.maintenanceServerGroupId
    || receipt.canaryServerGroupId !== plan.canaryServerGroupId
    || !sameStrings(receipt.apiNodeIds, plan.apiNodeIds)
    || typeof receipt.providerRevision !== "string"
    || !receipt.providerRevision
    || receipt.providerRevision.length > 256
    || /[\u0000-\u001f\u007f]/u.test(receipt.providerRevision)
  ) {
    fail(
      "RELEASE_MAINTENANCE_CANARY_RECEIPT_MISMATCH",
      `maintenance canary did not prove ${expectedState}`,
    );
  }
  return evidenceSha256(receipt);
}

function assertWorkerDrained(
  snapshot: WorkerRuntimeSnapshot,
  nodeId: string,
  reservation: ReleaseMaintenanceActivationReservationRead,
): void {
  if (
    snapshot.nodeId !== nodeId
    || !snapshot.healthy
    || snapshot.acceptingWork
    || snapshot.activeTaskCount !== 0
    || snapshot.drainOperationId !== reservation.deploymentId
  ) {
    fail("RELEASE_MAINTENANCE_WORKER_NOT_DRAINED", `worker ${nodeId} is not isolated`);
  }
}

async function drainApiConnections(input: {
  reservation: ReleaseMaintenanceActivationReservationRead;
  nodeId: string;
  expectedArtifactSha256: string;
  agent: NodeAgent;
  clock: NonNullable<ReleaseMaintenanceActivationOrchestratorDependencies["clock"]>;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<void> {
  const context = actionContext(input.reservation, `maintenance-api-drain:${input.nodeId}`);
  let status = await input.agent.beginDrain(
    input.nodeId,
    input.expectedArtifactSha256,
    context,
  );
  const startedAt = input.clock.now();
  while (true) {
    if (status.draining && status.totalConnections === 0) return;
    if (!status.draining) {
      fail("RELEASE_MAINTENANCE_API_DRAIN_LOST", `api ${input.nodeId} drain fence is not active`);
    }
    if (input.clock.now() - startedAt >= input.timeoutMs) {
      fail("RELEASE_MAINTENANCE_API_DRAIN_TIMEOUT", `api ${input.nodeId} did not drain`);
    }
    await input.clock.sleep(input.pollIntervalMs);
    status = await input.agent.drainStatus(
      input.nodeId,
      input.reservation.contract.previous.artifactSha256,
      context,
    );
  }
}

const systemClock = {
  now: () => Date.now(),
  sleep: async (milliseconds: number) => {
    if (milliseconds > 0) await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};

/**
 * Executes the one-way, all-fleet schema 40 -> 48 activation. On any failure
 * this function leaves CLB at zero and workers drained; only the dedicated
 * ledger failure transition may take ownership for manual recovery.
 */
export async function executeReleaseMaintenanceActivation(input: {
  reservation: ReleaseMaintenanceActivationReservationRead;
  nonce: string;
  databaseIdentitySha256: string;
  dependencies: ReleaseMaintenanceActivationOrchestratorDependencies;
}): Promise<ReleaseMaintenanceExecutionResult> {
  const { reservation, dependencies } = input;
  let phase: ReleaseMaintenanceExecutionPhase = "maintenance-draining";
  let migrationAttempted = false;
  let trafficMutationAttempted = false;
  let listenerContainmentRequired = false;
  let originalWeightsForContainment: Readonly<Record<string, number>> | null = null;
  let workerContainmentRequired = false;
  let workerNodeIdsForContainment: readonly string[] = [];
  const apiArtifactsForContainment = new Map<string, string>();
  let canaryPlanForContainment: MaintenanceCanaryPlanReceipt | null = null;
  let canaryPlanRecorded = false;
  let canaryOpenedRecorded = false;
  let canaryObservationRecorded = false;
  let canaryContainedRecorded = false;
  let privateValidationReceiptSha256: string | undefined;
  let privateValidationEvidenceManifestSha256: string | undefined;
  let restoreAttemptEvidenceSha256: string | undefined;
  let listenerBaselineEvidenceSha256: string | undefined;
  let listenerDisableEvidenceSha256: string | undefined;
  let listenerEnableAttemptEvidenceSha256: string | undefined;
  let listenerEnableEvidenceSha256: string | undefined;
  try {
    if (!SAFE_NONCE_RE.test(input.nonce)) {
      fail("RELEASE_MAINTENANCE_NONCE_INVALID", "maintenance nonce is invalid");
    }
    if (
      crypto.createHash("sha256").update(input.nonce).digest("hex")
        !== reservation.contract.nonceSha256
    ) {
      fail("RELEASE_MAINTENANCE_NONCE_MISMATCH", "maintenance nonce does not match reservation");
    }
    const fullMaintenanceMode = reservation.contract.trafficMode === "full-maintenance";
    const databaseIdentitySha256 = exactSha(
      input.databaseIdentitySha256,
      "databaseIdentitySha256",
    );
    const apiNodeIds = sortedUnique(
      reservation.targets.filter(({ role }) => role === "api").map(({ key }) => key),
      "api inventory",
    );
    const workerNodeIds = sortedUnique(
      reservation.targets.filter(({ role }) => role === "worker").map(({ key }) => key),
      "worker inventory",
    );
    workerNodeIdsForContainment = workerNodeIds;
    const target = targetArtifact(reservation);
    if (target.schemaVersion !== 48 || reservation.contract.previous.schemaVersion !== 40) {
      fail("RELEASE_MAINTENANCE_SCHEMA_CONTRACT_INVALID", "maintenance schema jump must be 40 to 48");
    }
    const clock = dependencies.clock ?? systemClock;
    const apiDrainTimeoutMs = dependencies.apiDrainTimeoutMs ?? 310_000;
    const apiDrainPollIntervalMs = dependencies.apiDrainPollIntervalMs ?? 1_000;
    const minimumWriterSampleIntervalMs = dependencies.minimumWriterSampleIntervalMs ?? 2_000;
    const canaryObservationWindowMs = dependencies.canaryObservationWindowMs ?? 300_000;
    if (
      !Number.isSafeInteger(apiDrainTimeoutMs)
      || apiDrainTimeoutMs < 1_000
      || !Number.isSafeInteger(apiDrainPollIntervalMs)
      || apiDrainPollIntervalMs < 0
      || !Number.isSafeInteger(minimumWriterSampleIntervalMs)
      || minimumWriterSampleIntervalMs < 1_000
      || (!fullMaintenanceMode && (
        !Number.isSafeInteger(canaryObservationWindowMs)
        || canaryObservationWindowMs < 60_000
        || canaryObservationWindowMs > 60 * 60_000
      ))
    ) {
      fail("RELEASE_MAINTENANCE_POLICY_INVALID", "maintenance execution timing is invalid");
    }

    const privateValidation = dependencies.privateValidation;
    let privateApiInventorySha256: string | undefined;
    if (fullMaintenanceMode) {
      if (!privateValidation) {
        fail(
          "RELEASE_MAINTENANCE_PRIVATE_VALIDATION_UNAVAILABLE",
          "full-maintenance requires an independent private validation implementation",
        );
      }
      if (
        !dependencies.privateApiInventory
        || !sameStrings(
          dependencies.privateApiInventory.map(({ nodeId }) => nodeId),
          apiNodeIds,
        )
      ) {
        fail(
          "RELEASE_MAINTENANCE_PRIVATE_API_INVENTORY_INVALID",
          "full-maintenance private API inventory is absent or differs from the committed API fleet",
        );
      }
      privateApiInventorySha256 = releaseFullMaintenancePrivateApiInventorySha256(
        dependencies.privateApiInventory,
      );
      if (
        reservation.contract.privateApiInventorySha256 !== privateApiInventorySha256
      ) {
        fail(
          "RELEASE_MAINTENANCE_PRIVATE_API_INVENTORY_INVALID",
          "private API mapping differs from the Root-authorized activation contract",
        );
      }
    }

    let listenerBaselineReceiptEvidenceSha256: string | undefined;
    if (fullMaintenanceMode) {
      if (!dependencies.loadBalancer.fullMaintenanceMutationUncertainty) {
        fail(
          "RELEASE_MAINTENANCE_CLB_TOPOLOGY_BINDING_UNAVAILABLE",
          "full-maintenance load balancer does not expose an immutable topology receipt",
        );
      }
      assertFullMaintenanceLoadBalancerTopology({
        receipt: dependencies.loadBalancer.fullMaintenanceMutationUncertainty(),
        reservation,
      });
      listenerBaselineReceiptEvidenceSha256 = assertFullMaintenanceListenerBarrierReceipt({
        receipt: await dependencies.loadBalancer.fullMaintenanceInspectListenerBaseline(
          actionContext(reservation, "full-maintenance-listener-baseline"),
        ),
        reservation,
        expectedPhase: "baseline",
        expectedState: "all-on",
      });
    }

    const backends = await dependencies.loadBalancer.listBackends(
      actionContext(reservation, "maintenance-traffic-baseline"),
    );
    if (
      !sameStrings(backends.map(({ nodeId }) => nodeId), apiNodeIds)
      || backends.some(({ health, weight }) => health !== "up" || weight < 1 || weight > 100)
    ) {
      fail(
        "RELEASE_MAINTENANCE_API_BASELINE_INVALID",
        "the exact API fleet must be healthy and weighted before maintenance",
      );
    }
    const originalWeights = Object.fromEntries(
      [...backends].sort((left, right) => left.nodeId.localeCompare(right.nodeId))
        .map(({ nodeId, weight }) => [nodeId, weight]),
    );
    if (fullMaintenanceMode) {
      const committedOriginalWeights = Object.fromEntries(
        reservation.contract.publicTrafficBarrier.backends
          .map(({ nodeId, originalWeight }) => [nodeId, originalWeight]),
      );
      if (canonicalJson(originalWeights) !== canonicalJson(committedOriginalWeights)) {
        fail(
          "RELEASE_MAINTENANCE_API_BASELINE_WEIGHT_DRIFT",
          "the CLB baseline weights differ from the Root-authorized immutable contract",
        );
      }
    }
    originalWeightsForContainment = originalWeights;
    const apiReadinessBefore = fullMaintenanceMode
      ? await Promise.all(apiNodeIds.map(async (nodeId) => ({
        nodeId,
        readiness: await dependencies.apiNodeAgent.directReadiness(
          nodeId,
          actionContext(reservation, `full-maintenance-api-baseline-ready:${nodeId}`),
        ),
      })))
      : [];
    if (
      fullMaintenanceMode
      && apiReadinessBefore.some(({ readiness }) => (
        !readiness.ready
        || readiness.artifactSha256 !== reservation.contract.previous.artifactSha256
        || readiness.sourceCommit !== reservation.contract.previous.sourceCommit
        || readiness.schemaVersion !== 40
        || readiness.deploymentMode
          !== (reservation.contract.previous.deployment?.mode ?? "archive-systemd")
        || (readiness.imageDigest ?? null)
          !== (reservation.contract.previous.deployment?.imageDigest ?? null)
      ))
    ) {
      fail(
        "RELEASE_MAINTENANCE_API_BASELINE_INVALID",
        "the exact previous API fleet must be direct-ready before listeners are disabled",
      );
    }
    const workersBefore = await dependencies.workerControlPlane.listWorkers(
      actionContext(reservation, "maintenance-worker-baseline"),
    );
    if (
      !sameStrings(workersBefore.map(({ nodeId }) => nodeId), workerNodeIds)
      || workersBefore.some((snapshot) => (
        !snapshot.healthy
        || !snapshot.acceptingWork
        || snapshot.artifactSha256 !== reservation.contract.previous.artifactSha256
        || snapshot.observedDatabaseSchemaVersion !== 40
        || snapshot.schemaRuntimeMode !== "normal"
        || snapshot.drainOperationId !== null
      ))
    ) {
      fail(
        "RELEASE_MAINTENANCE_WORKER_BASELINE_INVALID",
        "the exact Worker fleet must be healthy and accepting before maintenance",
      );
    }
    if (fullMaintenanceMode) {
      listenerBaselineEvidenceSha256 = evidenceSha256({
        format: "fanjin-release-full-maintenance-serving-baseline/v1",
        trafficMode: "full-maintenance",
        deploymentId: reservation.deploymentId,
        contractSha256: reservation.contract.contractSha256,
        listenerBarrierEvidenceSha256: listenerBaselineReceiptEvidenceSha256,
        backends: backends
          .map(({ nodeId, health, weight }) => ({ nodeId, health, weight }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        apiReadiness: apiReadinessBefore
          .map(({ nodeId, readiness }) => ({
            nodeId,
            ready: readiness.ready,
            artifactSha256: readiness.artifactSha256,
            sourceCommit: readiness.sourceCommit,
            schemaVersion: readiness.schemaVersion,
            deploymentMode: readiness.deploymentMode,
            imageDigest: readiness.imageDigest ?? null,
          }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        workers: workersBefore
          .map((snapshot) => ({
            nodeId: snapshot.nodeId,
            healthy: snapshot.healthy,
            acceptingWork: snapshot.acceptingWork,
            artifactSha256: snapshot.artifactSha256,
            observedDatabaseSchemaVersion: snapshot.observedDatabaseSchemaVersion,
            schemaRuntimeMode: snapshot.schemaRuntimeMode,
            drainOperationId: snapshot.drainOperationId,
          }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        observedAt: clock.now(),
      });
      await dependencies.recorder.record({
        event: "listener-baseline-verified",
        phase,
        evidence: { evidenceSha256: listenerBaselineEvidenceSha256 },
      });
    }
    await dependencies.recorder.record({
      event: "traffic-baseline-recorded",
      phase,
      evidence: { originalWeights },
    });
    if (fullMaintenanceMode) {
      // Once a disable call starts, a lost response can mean exactly one
      // listener changed. Every subsequent failure must converge both to off.
      listenerContainmentRequired = true;
      listenerDisableEvidenceSha256 = assertFullMaintenanceListenerBarrierReceipt({
        receipt: await dependencies.loadBalancer.fullMaintenanceDisableListeners(
          actionContext(reservation, "full-maintenance-listeners-disable"),
        ),
        reservation,
        expectedPhase: "disabled",
        expectedState: "all-off",
      });
      await dependencies.recorder.record({
        event: "listeners-disabled",
        phase,
        evidence: { evidenceSha256: listenerDisableEvidenceSha256 },
      });
    }
    const armInitialRuntimeContainment = () => {
      trafficMutationAttempted = true;
      workerContainmentRequired = true;
      for (const nodeId of apiNodeIds) {
        apiArtifactsForContainment.set(nodeId, reservation.contract.previous.artifactSha256);
      }
    };
    try {
      if (fullMaintenanceMode) {
        await dependencies.loadBalancer.fullMaintenanceDrainAll(
          originalWeights,
          actionContext(reservation, "full-maintenance-traffic-drain-all"),
        );
      } else {
        await dependencies.loadBalancer.maintenanceDrainAll(
          originalWeights,
          actionContext(reservation, "maintenance-traffic-drain-all"),
        );
      }
    } catch (error) {
      if ((error as { productionMutationMayHaveOccurred?: unknown })
        ?.productionMutationMayHaveOccurred !== false) {
        armInitialRuntimeContainment();
      }
      throw error;
    }
    armInitialRuntimeContainment();
    await dependencies.recorder.record({ event: "traffic-drained", phase });

    for (const nodeId of apiNodeIds) {
      await drainApiConnections({
        reservation,
        nodeId,
        expectedArtifactSha256: reservation.contract.previous.artifactSha256,
        agent: dependencies.apiNodeAgent,
        clock,
        timeoutMs: apiDrainTimeoutMs,
        pollIntervalMs: apiDrainPollIntervalMs,
      });
      apiArtifactsForContainment.delete(nodeId);
      await dependencies.recorder.record({ event: "api-drained", phase, targetKey: nodeId });
    }
    for (const nodeId of workerNodeIds) {
      const context = actionContext(reservation, `maintenance-worker-drain:${nodeId}`);
      await dependencies.workerControlPlane.requestDrain(nodeId, context);
      const snapshot = await dependencies.workerControlPlane.waitForDrained(nodeId, context);
      assertWorkerDrained(snapshot, nodeId, reservation);
      await dependencies.recorder.record({ event: "worker-drained", phase, targetKey: nodeId });
    }
    workerContainmentRequired = false;

    phase = "maintenance-quiesced";
    for (const nodeId of apiNodeIds) {
      const result = await dependencies.apiNodeAgent.maintenanceQuiesce(
        nodeBinding(reservation, nodeId, "api"),
        actionContext(reservation, `maintenance-quiesce:${nodeId}`),
      );
      if (!result.processStopped || result.maintenance.state !== "quiesced") {
        fail("RELEASE_MAINTENANCE_NODE_NOT_QUIESCED", `api ${nodeId} did not stop`);
      }
      await dependencies.recorder.record({ event: "node-quiesced", phase, targetKey: nodeId });
    }
    for (const nodeId of workerNodeIds) {
      const result = await dependencies.workerNodeAgent.maintenanceQuiesce(
        nodeBinding(reservation, nodeId, "worker"),
        actionContext(reservation, `maintenance-quiesce:${nodeId}`),
      );
      if (!result.processStopped || result.maintenance.state !== "quiesced") {
        fail("RELEASE_MAINTENANCE_NODE_NOT_QUIESCED", `worker ${nodeId} did not stop`);
      }
      await dependencies.recorder.record({ event: "node-quiesced", phase, targetKey: nodeId });
    }

    phase = "maintenance-checkpoint";
    const firstSample = await dependencies.collectWriterSnapshot();
    const sampleStartedAt = clock.now();
    const checkpoint = await dependencies.prepareCheckpoint();
    exactSha(checkpoint.contentSha256, "checkpoint.contentSha256");
    if (checkpoint.binding.sourceDatabaseIdentitySha256 !== databaseIdentitySha256) {
      fail(
        "RELEASE_MAINTENANCE_DATABASE_IDENTITY_MISMATCH",
        "immutable backup source database differs from the reserved writer proof database",
      );
    }
    const elapsed = clock.now() - sampleStartedAt;
    if (elapsed < minimumWriterSampleIntervalMs) {
      await clock.sleep(minimumWriterSampleIntervalMs - elapsed);
    }
    const secondSample = await dependencies.collectWriterSnapshot();
    const writerProof = createMaintenanceWriterQuiescenceProof({
      deploymentId: reservation.deploymentId,
      nonce: input.nonce,
      databaseIdentitySha256,
      allowedDatabaseRoles: reservation.contract.databaseRoles.allowedDatabaseRoles,
      applicationDatabaseRoles: reservation.contract.databaseRoles.applicationDatabaseRoles,
      first: firstSample,
      second: secondSample,
      minimumSampleIntervalMs: minimumWriterSampleIntervalMs,
    });
    const persistedWriterProof = await dependencies.persistWriterProof(writerProof);
    exactSha(persistedWriterProof.contentSha256, "writerProof.contentSha256");
    await dependencies.recorder.record({
      event: "writer-proof-recorded",
      phase,
      evidence: {
        writerQuiescenceProofSha256: writerProof.proofSha256,
        writerQuiescenceProofContentSha256: persistedWriterProof.contentSha256,
        databaseIdentitySha256,
      },
    });
    await dependencies.recorder.record({
      event: "backup-checkpoint-recorded",
      phase,
      evidence: {
        backupCheckpointEvidenceSha256: checkpoint.contentSha256,
        checkpointId: checkpoint.binding.checkpointId,
        remoteObjectIdentitySha256: checkpoint.binding.remoteObjectIdentitySha256,
      },
    });

    phase = "maintenance-migrating";
    await dependencies.recorder.record({ event: "schema-migration-attempted", phase });
    migrationAttempted = true;
    const migration = await dependencies.applyMigration();
    if (
      migration.schemaVersion !== 48
      || migration.runId !== reservation.contract.migration.runId
      || migration.runStatus !== "succeeded"
      || migration.pendingMigrationCount !== 0
    ) {
      fail(
        "RELEASE_MAINTENANCE_SCHEMA_TERMINAL_MISMATCH",
        "database did not reach the exact migration terminal state",
      );
    }
    await dependencies.recorder.record({
      event: "schema-migration-completed",
      phase,
      evidence: { schemaVersion: 48, migrationRunId: migration.runId },
    });

    phase = "maintenance-backfill";
    const receipt = await dependencies.runBackfills({
      checkpoint,
      writerProof: persistedWriterProof,
    });
    exactSha(receipt.contentSha256, "maintenanceBackfillReceipt.contentSha256");
    if (
      receipt.receipt.runId !== reservation.contract.migration.runId
      || receipt.receipt.artifactSha256 !== target.sha256
      || receipt.receipt.checkpoint.contentSha256 !== checkpoint.contentSha256
      || receipt.receipt.maintenanceWriterQuiescence.proofSha256 !== writerProof.proofSha256
    ) {
      fail(
        "RELEASE_MAINTENANCE_BACKFILL_RECEIPT_MISMATCH",
        "maintenance backfill receipt does not match the activation evidence",
      );
    }
    await dependencies.recorder.record({
      event: "maintenance-backfill-completed",
      phase,
      evidence: { maintenanceBackfillReceiptSha256: receipt.contentSha256 },
    });

    const apiActivationBindings = new Map<string, string>();
    const workerActivationBindings = new Map<string, string>();
    phase = "maintenance-api-activation";
    for (const nodeId of apiNodeIds) {
      await dependencies.recorder.record({
        event: "target-activation-attempted",
        phase,
        targetKey: nodeId,
      });
      const binding = nodeBinding(reservation, nodeId, "api");
      const activation = await dependencies.apiNodeAgent.activateMaintenance(
        binding,
        actionContext(reservation, `maintenance-activate:${nodeId}`),
      );
      apiActivationBindings.set(nodeId, assertMaintenanceActivationResult({
        result: activation,
        binding,
        reservation,
      }));
      const readiness = await dependencies.apiNodeAgent.directReadiness(
        nodeId,
        actionContext(reservation, `maintenance-api-ready:${nodeId}`),
      );
      if (
        !readiness.ready
        || readiness.artifactSha256 !== target.sha256
        || readiness.sourceCommit !== target.sourceCommit
        || readiness.schemaVersion !== 48
        || readiness.deploymentMode !== "container-image"
        || readiness.imageDigest !== target.imageDigest
      ) {
        fail("RELEASE_MAINTENANCE_API_READINESS_MISMATCH", `api ${nodeId} target is not exact-ready`);
      }
      await dependencies.recorder.record({ event: "target-activated", phase, targetKey: nodeId });
    }

    phase = "maintenance-worker-activation";
    for (const nodeId of workerNodeIds) {
      await dependencies.recorder.record({
        event: "target-activation-attempted",
        phase,
        targetKey: nodeId,
      });
      const binding = nodeBinding(reservation, nodeId, "worker");
      const activation = await dependencies.workerNodeAgent.activateMaintenance(
        binding,
        actionContext(reservation, `maintenance-activate:${nodeId}`),
      );
      workerActivationBindings.set(nodeId, assertMaintenanceActivationResult({
        result: activation,
        binding,
        reservation,
      }));
      const snapshot = await dependencies.workerControlPlane.waitForArtifact(
        nodeId,
        {
          artifactSha256: target.sha256,
          targetSchemaVersion: 48,
          observedDatabaseSchemaVersion: 48,
          runtimeMode: "isolated",
        },
        actionContext(reservation, `maintenance-worker-isolated:${nodeId}`),
      );
      assertWorkerDrained(snapshot, nodeId, reservation);
      if (
        snapshot.artifactSha256 !== target.sha256
        || snapshot.observedDatabaseSchemaVersion !== 48
        || snapshot.schemaRuntimeMode !== "isolated"
      ) {
        fail("RELEASE_MAINTENANCE_WORKER_READINESS_MISMATCH", `worker ${nodeId} target is not isolated-ready`);
      }
      await dependencies.recorder.record({ event: "target-activated", phase, targetKey: nodeId });
      await dependencies.recorder.record({
        event: "worker-isolation-verified",
        phase,
        targetKey: nodeId,
      });
    }

    const zeroBackendWeightReceipt = fullMaintenanceMode
      ? assertFullMaintenanceBackendWeightReceipt({
        receipt: await dependencies.loadBalancer.fullMaintenanceInspectBackendWeights(
          originalWeights,
          "all-zero",
          actionContext(reservation, "full-maintenance-homogeneous-fleet-lb-zero"),
        ),
        reservation,
        expectedWeights: originalWeights,
        expectedState: "all-zero",
      })
      : undefined;
    const legacyZeroBackends = fullMaintenanceMode
      ? undefined
      : await dependencies.loadBalancer.listBackends(
        actionContext(reservation, "maintenance-homogeneous-fleet-lb-zero"),
      );
    const zeroBackends = zeroBackendWeightReceipt?.backends ?? legacyZeroBackends!;
    if (
      !sameStrings(zeroBackends.map(({ nodeId }) => nodeId), apiNodeIds)
      || zeroBackends.some(({ weight }) => weight !== 0)
      || legacyZeroBackends?.some(({ health }) => health !== "up")
    ) {
      fail(
        "RELEASE_MAINTENANCE_HOMOGENEOUS_FLEET_MISMATCH",
        fullMaintenanceMode
          ? "homogeneous fleet requires the exact API server-group inventory at weight zero"
          : "homogeneous fleet requires the exact healthy API inventory at weight zero",
      );
    }
    const finalApiReadiness = await Promise.all(apiNodeIds.map(async (nodeId) => ({
      nodeId,
      readiness: await dependencies.apiNodeAgent.directReadiness(
        nodeId,
        actionContext(reservation, `maintenance-homogeneous-api-ready:${nodeId}`),
      ),
    })));
    if (finalApiReadiness.some(({ readiness }) => (
      !readiness.ready
      || readiness.artifactSha256 !== target.sha256
      || readiness.sourceCommit !== target.sourceCommit
      || readiness.schemaVersion !== 48
      || readiness.deploymentMode !== "container-image"
      || readiness.imageDigest !== target.imageDigest
    ))) {
      fail(
        "RELEASE_MAINTENANCE_HOMOGENEOUS_FLEET_MISMATCH",
        "homogeneous fleet API identity drifted before protected validation",
      );
    }
    const finalWorkerIsolation = await Promise.all(workerNodeIds.map(async (nodeId) => ({
      nodeId,
      snapshot: await dependencies.workerControlPlane.waitForArtifact(
        nodeId,
        {
          artifactSha256: target.sha256,
          targetSchemaVersion: 48,
          observedDatabaseSchemaVersion: 48,
          runtimeMode: "isolated",
        },
        actionContext(reservation, `maintenance-homogeneous-worker-isolated:${nodeId}`),
      ),
    })));
    for (const { nodeId, snapshot } of finalWorkerIsolation) {
      assertWorkerDrained(snapshot, nodeId, reservation);
      if (
        snapshot.artifactSha256 !== target.sha256
        || snapshot.observedDatabaseSchemaVersion !== 48
        || snapshot.schemaRuntimeMode !== "isolated"
      ) {
        fail(
          "RELEASE_MAINTENANCE_HOMOGENEOUS_FLEET_MISMATCH",
          `homogeneous fleet Worker ${nodeId} drifted before protected validation`,
        );
      }
    }
    if (!target.imageDigest) {
      fail(
        "RELEASE_MAINTENANCE_TARGET_DEPLOYMENT_INVALID",
        "homogeneous fleet requires a digest-pinned target image",
      );
    }
    const homogeneousFleet = createHomogeneousFleetEvidence({
      deploymentId: reservation.deploymentId,
      prestageEvidenceSha256: exactSha(
        reservation.contract.prestageEvidenceSha256,
        "prestageEvidenceSha256",
      ),
      inventorySha256: exactSha(
        reservation.contract.inventory.sha256,
        "inventorySha256",
      ),
      target: {
        releaseId: reservation.contract.target.releaseId,
        artifactSha256: target.sha256,
        sourceCommit: reservation.contract.target.sourceCommit,
        schemaVersion: 48,
        deploymentMode: "container-image",
        imageDigest: target.imageDigest,
      },
      loadBalancerWeightEvidenceSha256: zeroBackendWeightReceipt?.evidenceSha256
        ?? evidenceSha256({
          format: "fanjin-release-maintenance-legacy-backend-weight/v1",
          deploymentId: reservation.deploymentId,
          backends: zeroBackends
            .map(({ nodeId, weight }) => ({ nodeId, weight }))
            .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        }),
      loadBalancer: [...zeroBackends]
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
        .map(({ nodeId }) => ({ nodeId, weight: 0 as const })),
      api: apiNodeIds.map((nodeId) => ({
        nodeId,
        activationBindingSha256: apiActivationBindings.get(nodeId)!,
      })),
      workers: finalWorkerIsolation.map(({ nodeId, snapshot }) => ({
        nodeId,
        activationBindingSha256: workerActivationBindings.get(nodeId)!,
        heartbeatAt: snapshot.heartbeatAt,
      })),
      observedAt: clock.now(),
    });
    await dependencies.recorder.record({
      event: "homogeneous-isolated-ready",
      phase: "maintenance-worker-activation",
      evidence: {
        schemaVersion: 48,
        artifactSha256: target.sha256,
        fleetEvidenceSha256: homogeneousFleet.evidenceSha256,
        targetEvidenceSha256ByKey: homogeneousFleet.targetEvidenceSha256ByKey,
      },
    });

    phase = "maintenance-worker-resume";
    workerContainmentRequired = true;
    for (const nodeId of workerNodeIds) {
      const context = actionContext(reservation, `maintenance-worker-resume:${nodeId}`);
      await dependencies.workerControlPlane.resume(nodeId, context);
      const snapshot = await dependencies.workerControlPlane.waitForServing(
        nodeId,
        {
          artifactSha256: target.sha256,
          targetSchemaVersion: 48,
          observedDatabaseSchemaVersion: 48,
          runtimeMode: "normal",
        },
        context,
      );
      if (
        !snapshot.healthy
        || !snapshot.acceptingWork
        || snapshot.artifactSha256 !== target.sha256
        || snapshot.observedDatabaseSchemaVersion !== 48
      ) {
        fail("RELEASE_MAINTENANCE_WORKER_RESUME_MISMATCH", `worker ${nodeId} did not resume exact target`);
      }
      await dependencies.recorder.record({ event: "worker-resumed", phase, targetKey: nodeId });
    }

    phase = "maintenance-traffic-restore";
    if (fullMaintenanceMode) {
      if (!target.imageDigest) {
        fail(
          "RELEASE_MAINTENANCE_TARGET_DEPLOYMENT_INVALID",
          "full-maintenance private validation requires a digest-pinned target image",
        );
      }
      const privateValidationBinding = createReleaseFullMaintenancePrivateValidationBinding({
        deploymentId: reservation.deploymentId,
        contractSha256: reservation.contract.contractSha256,
        validationAuthority: createReleaseFullMaintenancePrivateValidationAuthority({
          deploymentId: reservation.deploymentId,
          contractSha256: reservation.contract.contractSha256,
          validationPlanIntentSha256:
            reservation.contract.privateValidation.validationPlanIntentSha256,
          authorization: reservation.contract.authorization,
        }),
        target: {
          releaseId: reservation.contract.target.releaseId,
          artifactId: reservation.contract.target.artifactId,
          artifactSha256: target.sha256,
          sourceCommit: reservation.contract.target.sourceCommit,
          schemaVersion: 48,
          imageDigest: target.imageDigest,
        },
        homogeneousFleetEvidenceSha256: homogeneousFleet.evidenceSha256,
        homogeneousFleetEvidence: homogeneousFleet,
        privateApiInventorySha256: privateApiInventorySha256!,
        apiNodeIds,
        workerNodeIds,
        originalWeights,
        requestedAt: clock.now(),
      });
      const rootVerifiedPrivateValidation = await privateValidation!(privateValidationBinding);
      const persistedPrivateValidation = assertPersistedReleaseFullMaintenancePrivateValidationReceipt({
        persisted: rootVerifiedPrivateValidation,
        binding: privateValidationBinding,
        now: clock.now(),
      });
      const evidenceManifest = assertReleaseFullMaintenancePrivateValidationEvidenceManifest({
        manifest: rootVerifiedPrivateValidation.evidenceManifest,
        persisted: persistedPrivateValidation,
      });

      // Validation may be long-running. Re-prove the complete fleet and the
      // all-zero public boundary immediately before recording restore intent.
      const validatedBackendWeights = assertFullMaintenanceBackendWeightReceipt({
        receipt: await dependencies.loadBalancer.fullMaintenanceInspectBackendWeights(
          originalWeights,
          "all-zero",
          actionContext(reservation, "full-maintenance-post-validation-fleet-zero"),
        ),
        reservation,
        expectedWeights: originalWeights,
        expectedState: "all-zero",
        expectedServerGroupId: zeroBackendWeightReceipt?.serverGroupId,
      });
      const validatedApiReadiness = await Promise.all(apiNodeIds.map(async (nodeId) => ({
        nodeId,
        readiness: await dependencies.apiNodeAgent.directReadiness(
          nodeId,
          actionContext(reservation, `full-maintenance-post-validation-api:${nodeId}`),
        ),
      })));
      const validatedWorkerReadiness = await Promise.all(workerNodeIds.map(async (nodeId) => ({
        nodeId,
        snapshot: await dependencies.workerControlPlane.waitForServing(
          nodeId,
          {
            artifactSha256: target.sha256,
            targetSchemaVersion: 48,
            observedDatabaseSchemaVersion: 48,
            runtimeMode: "normal",
          },
          actionContext(reservation, `full-maintenance-post-validation-worker:${nodeId}`),
        ),
      })));
      if (
        validatedApiReadiness.some(({ readiness }) => (
          !readiness.ready
          || readiness.artifactSha256 !== target.sha256
          || readiness.sourceCommit !== target.sourceCommit
          || readiness.schemaVersion !== 48
          || readiness.deploymentMode !== "container-image"
          || readiness.imageDigest !== target.imageDigest
        ))
        || validatedWorkerReadiness.some(({ snapshot }) => (
          !snapshot.healthy
          || !snapshot.acceptingWork
          || snapshot.artifactSha256 !== target.sha256
          || snapshot.observedDatabaseSchemaVersion !== 48
          || snapshot.schemaRuntimeMode !== "normal"
        ))
      ) {
        fail(
          "RELEASE_MAINTENANCE_POST_VALIDATION_FLEET_DRIFT",
          "full-maintenance fleet drifted after private validation",
        );
      }
      const postValidationFleetEvidenceSha256 = evidenceSha256({
        format: "fanjin-release-full-maintenance-post-validation-fleet/v1",
        trafficMode: "full-maintenance",
        deploymentId: reservation.deploymentId,
        bindingSha256: privateValidationBinding.bindingSha256,
        validationReceiptSha256: persistedPrivateValidation.receipt.receiptSha256,
        contentSha256: persistedPrivateValidation.contentSha256,
        evidenceManifestSha256: evidenceManifest.manifestSha256,
        backendWeightEvidenceSha256: validatedBackendWeights.evidenceSha256,
        productionBackends: validatedBackendWeights.backends
          .map(({ nodeId, weight }) => ({ nodeId, weight }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        apiNodeIds,
        workerNodeIds,
        observedAt: clock.now(),
      });
      await dependencies.recorder.record({
        event: "private-validation-passed",
        phase,
        evidence: {
          validationReceiptSha256: persistedPrivateValidation.receipt.receiptSha256,
          validationReceiptContentSha256: persistedPrivateValidation.contentSha256,
          validationBindingSha256: privateValidationBinding.bindingSha256,
          evidenceManifestSha256: evidenceManifest.manifestSha256,
          postValidationFleetEvidenceSha256,
        },
      });
      privateValidationReceiptSha256 = persistedPrivateValidation.receipt.receiptSha256;
      privateValidationEvidenceManifestSha256 = evidenceManifest.manifestSha256;

      // Register target connection containment before the durable irreversible
      // boundary; a restore response may be lost after one backend is opened.
      for (const nodeId of apiNodeIds) {
        apiArtifactsForContainment.set(nodeId, target.sha256);
      }
      restoreAttemptEvidenceSha256 = evidenceSha256({
        format: "fanjin-release-full-maintenance-restore-attempt/v1",
        trafficMode: "full-maintenance",
        deploymentId: reservation.deploymentId,
        contractSha256: reservation.contract.contractSha256,
        validationReceiptSha256: privateValidationReceiptSha256,
        evidenceManifestSha256: privateValidationEvidenceManifestSha256,
        postValidationFleetEvidenceSha256,
        originalWeights,
      });
      await dependencies.recorder.record({
        event: "traffic-restore-attempted",
        phase,
        evidence: { restoreAttemptEvidenceSha256 },
      });
      assertFullMaintenanceListenerBarrierReceipt({
        receipt: await dependencies.loadBalancer.fullMaintenanceContainListeners(
          actionContext(reservation, "full-maintenance-listeners-recontain-before-weight-restore"),
        ),
        reservation,
        expectedPhase: "contained",
        expectedState: "all-off",
      });
      await dependencies.loadBalancer.fullMaintenanceRestoreAll(
        originalWeights,
        privateValidationReceiptSha256,
        actionContext(reservation, "full-maintenance-traffic-restore-all"),
      );
      const restoredBackendWeights = assertFullMaintenanceBackendWeightReceipt({
        receipt: await dependencies.loadBalancer.fullMaintenanceInspectBackendWeights(
          originalWeights,
          "original",
          actionContext(reservation, "full-maintenance-restored-backend-weight-proof"),
        ),
        reservation,
        expectedWeights: originalWeights,
        expectedState: "original",
        expectedServerGroupId: validatedBackendWeights.serverGroupId,
      });
      await dependencies.recorder.record({ event: "traffic-restored", phase });
      listenerEnableAttemptEvidenceSha256 = evidenceSha256({
        format: "fanjin-release-full-maintenance-listener-enable-attempt/v1",
        deploymentId: reservation.deploymentId,
        contractSha256: reservation.contract.contractSha256,
        publicTrafficBarrierSha256: reservation.contract.publicTrafficBarrier.bindingSha256,
        listenerDisableEvidenceSha256,
        restoreAttemptEvidenceSha256,
        backendWeightEvidenceSha256: restoredBackendWeights.evidenceSha256,
        restoredBackends: restoredBackendWeights.backends
          .map(({ nodeId, weight }) => ({ nodeId, weight }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      });
      await dependencies.recorder.record({
        event: "listener-enable-attempted",
        phase,
        evidence: { evidenceSha256: listenerEnableAttemptEvidenceSha256 },
      });
      const listenerBarrierEnabledEvidenceSha256 = assertFullMaintenanceListenerBarrierReceipt({
        receipt: await dependencies.loadBalancer.fullMaintenanceEnableListeners(
          actionContext(reservation, "full-maintenance-listeners-enable"),
        ),
        reservation,
        expectedPhase: "enabled",
        expectedState: "all-on",
      });
      const enabledBackendHealth = assertFullMaintenanceBackendHealthReceipt({
        receipt: await dependencies.loadBalancer.fullMaintenanceVerifyEnabledBackendHealth(
          originalWeights,
          actionContext(reservation, "full-maintenance-enabled-backend-health"),
        ),
        reservation,
        expectedWeights: originalWeights,
        expectedServerGroupId: restoredBackendWeights.serverGroupId,
      });
      const enabledApiReadiness = await Promise.all(apiNodeIds.map(async (nodeId) => ({
        nodeId,
        readiness: await dependencies.apiNodeAgent.directReadiness(
          nodeId,
          actionContext(reservation, `full-maintenance-enabled-api-ready:${nodeId}`),
        ),
      })));
      const enabledWorkers = await dependencies.workerControlPlane.listWorkers(
        actionContext(reservation, "full-maintenance-enabled-worker-fleet"),
      );
      if (
        enabledApiReadiness.some(({ readiness }) => (
          !readiness.ready
          || readiness.artifactSha256 !== target.sha256
          || readiness.sourceCommit !== target.sourceCommit
          || readiness.schemaVersion !== 48
          || readiness.deploymentMode !== "container-image"
          || readiness.imageDigest !== target.imageDigest
        ))
        || !sameStrings(enabledWorkers.map(({ nodeId }) => nodeId), workerNodeIds)
        || enabledWorkers.some((snapshot) => (
          !snapshot.healthy
          || !snapshot.acceptingWork
          || snapshot.artifactSha256 !== target.sha256
          || snapshot.observedDatabaseSchemaVersion !== 48
          || snapshot.schemaRuntimeMode !== "normal"
          || snapshot.drainOperationId !== null
        ))
      ) {
        fail(
          "RELEASE_MAINTENANCE_ENABLED_FLEET_DRIFT",
          "enabled listener fleet differs from the exact validated API and Worker target",
        );
      }
      listenerEnableEvidenceSha256 = evidenceSha256({
        format: "fanjin-release-full-maintenance-enabled-serving-fleet/v1",
        trafficMode: "full-maintenance",
        deploymentId: reservation.deploymentId,
        contractSha256: reservation.contract.contractSha256,
        listenerBarrierEvidenceSha256: listenerBarrierEnabledEvidenceSha256,
        backendHealthEvidenceSha256: enabledBackendHealth.evidenceSha256,
        apiReadiness: enabledApiReadiness
          .map(({ nodeId, readiness }) => ({
            nodeId,
            artifactSha256: readiness.artifactSha256,
            sourceCommit: readiness.sourceCommit,
            schemaVersion: readiness.schemaVersion,
            deploymentMode: readiness.deploymentMode,
            imageDigest: readiness.imageDigest,
          }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        workers: enabledWorkers
          .map((snapshot) => ({
            nodeId: snapshot.nodeId,
            artifactSha256: snapshot.artifactSha256,
            observedDatabaseSchemaVersion: snapshot.observedDatabaseSchemaVersion,
            schemaRuntimeMode: snapshot.schemaRuntimeMode,
            acceptingWork: snapshot.acceptingWork,
          }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        observedAt: clock.now(),
      });
      await dependencies.recorder.record({
        event: "listeners-enabled",
        phase,
        evidence: { evidenceSha256: listenerEnableEvidenceSha256 },
      });
    } else {
    if (!dependencies.canaryObserver || !dependencies.persistCanaryObservationReceipt) {
      fail(
        "RELEASE_MAINTENANCE_CANARY_OBSERVER_UNAVAILABLE",
        "legacy maintenance recovery requires its signed canary observer",
      );
    }
    const canaryObserver = dependencies.canaryObserver;
    const persistCanaryObservationReceipt = dependencies.persistCanaryObservationReceipt;
    const canaryAuthorizationSha256 = evidenceSha256({
      format: "fanjin-release-maintenance-canary-authorization/v1",
      deploymentId: reservation.deploymentId,
      contractSha256: reservation.contract.contractSha256,
      authorization: reservation.contract.authorization,
    });
    const canaryPlan = assertCanaryPlan({
      plan: await dependencies.loadBalancer.maintenancePlanCanary(
        canaryAuthorizationSha256,
        actionContext(reservation, "maintenance-canary-plan"),
      ),
      reservation,
      apiNodeIds,
      authorizationSha256: canaryAuthorizationSha256,
      observationWindowMs: canaryObservationWindowMs,
    });
    canaryPlanForContainment = canaryPlan;
    await dependencies.recorder.record({
      event: "canary-planned",
      phase,
      evidence: {
        operationId: canaryPlan.operationId,
        planSha256: canaryPlan.planDigestSha256,
      },
    });
    canaryPlanRecorded = true;

    // The provider may open traffic and lose the response. Register every API
    // for target-artifact connection containment before making that call.
    for (const nodeId of apiNodeIds) {
      apiArtifactsForContainment.set(nodeId, target.sha256);
    }
    const openedCanary = await dependencies.loadBalancer.maintenanceOpenCanary(
      canaryPlan,
      actionContext(reservation, "maintenance-canary-open"),
    );
    const openedReceiptSha256 = assertCanaryTrafficReceipt({
      receipt: openedCanary,
      plan: canaryPlan,
      expectedState: "open",
    });
    await dependencies.recorder.record({
      event: "canary-opened",
      phase,
      evidence: {
        operationId: canaryPlan.operationId,
        planSha256: canaryPlan.planDigestSha256,
        openedReceiptSha256,
      },
    });
    canaryOpenedRecorded = true;

    const canaryObservationStartedAt = clock.now();
    const canarySmokeStarted = await dependencies.loadBalancer.publicSmoke(
      target,
      actionContext(reservation, "maintenance-canary-public-smoke-start"),
    );
    if (
      !canarySmokeStarted.ok
      || canarySmokeStarted.artifactSha256 !== target.sha256
    ) {
      fail(
        "RELEASE_MAINTENANCE_CANARY_OBSERVATION_FAILED",
        "protected canary did not prove the exact target at observation start",
      );
    }
    await clock.sleep(canaryObservationWindowMs);
    const observedCanary = await dependencies.loadBalancer.maintenanceObserveCanary(
      canaryPlan.planDigestSha256,
      actionContext(reservation, "maintenance-canary-observe"),
    );
    const providerObservationReceiptSha256 = assertCanaryTrafficReceipt({
      receipt: observedCanary,
      plan: canaryPlan,
      expectedState: "open",
    });
    if (observedCanary.providerRevision !== openedCanary.providerRevision) {
      fail(
        "RELEASE_MAINTENANCE_CANARY_OBSERVATION_FAILED",
        "maintenance canary provider revision changed during the protected window",
      );
    }
    const canarySmokeCompleted = await dependencies.loadBalancer.publicSmoke(
      target,
      actionContext(reservation, "maintenance-canary-public-smoke-complete"),
    );
    const canaryBackends = await dependencies.loadBalancer.listBackends(
      actionContext(reservation, "maintenance-canary-production-fleet-zero"),
    );
    const canaryApiReadiness = await Promise.all(apiNodeIds.map(async (nodeId) => ({
      nodeId,
      readiness: await dependencies.apiNodeAgent.directReadiness(
        nodeId,
        actionContext(reservation, `maintenance-canary-api-ready:${nodeId}`),
      ),
    })));
    const canaryWorkerReadiness = await Promise.all(workerNodeIds.map(async (nodeId) => ({
      nodeId,
      snapshot: await dependencies.workerControlPlane.waitForServing(
        nodeId,
        {
          artifactSha256: target.sha256,
          targetSchemaVersion: 48,
          observedDatabaseSchemaVersion: 48,
          runtimeMode: "normal",
        },
        actionContext(reservation, `maintenance-canary-worker-serving:${nodeId}`),
      ),
    })));
    const canaryObservationCompletedAt = clock.now();
    if (
      canaryObservationCompletedAt - canaryObservationStartedAt < canaryObservationWindowMs
      || !canarySmokeCompleted.ok
      || canarySmokeCompleted.artifactSha256 !== target.sha256
      || !sameStrings(canaryBackends.map(({ nodeId }) => nodeId), apiNodeIds)
      || canaryBackends.some(({ health, weight }) => health !== "up" || weight !== 0)
      || canaryApiReadiness.some(({ readiness }) => (
        !readiness.ready
        || readiness.artifactSha256 !== target.sha256
        || readiness.sourceCommit !== target.sourceCommit
        || readiness.schemaVersion !== 48
        || readiness.deploymentMode !== "container-image"
        || readiness.imageDigest !== target.imageDigest
      ))
      || canaryWorkerReadiness.some(({ snapshot }) => (
        !snapshot.healthy
        || !snapshot.acceptingWork
        || snapshot.artifactSha256 !== target.sha256
        || snapshot.observedDatabaseSchemaVersion !== 48
        || snapshot.schemaRuntimeMode !== "normal"
      ))
    ) {
      fail(
        "RELEASE_MAINTENANCE_CANARY_OBSERVATION_FAILED",
        "protected canary observation did not prove the exact target for the full window",
      );
    }
    const canaryObservationBinding: ReleaseMaintenanceProductionObservationBinding = {
      format: "fanjin-release-maintenance-production-observation-binding/v1",
      operationId: canaryPlan.operationId,
      planSha256: canaryPlan.planDigestSha256,
      openedReceiptSha256,
      providerObservationReceiptSha256,
      providerRevision: observedCanary.providerRevision,
      artifactSha256: target.sha256,
      sourceCommit: reservation.contract.target.sourceCommit,
      schemaVersion: 48,
      imageDigest: target.imageDigest!,
      homogeneousFleetEvidenceSha256: homogeneousFleet.evidenceSha256,
      observedFrom: canaryObservationStartedAt,
      observedUntil: canaryObservationCompletedAt,
      publicSmokeStart: { ok: true, artifactSha256: target.sha256 },
      publicSmokeComplete: { ok: true, artifactSha256: target.sha256 },
      productionBackends: canaryBackends
        .map(({ nodeId }) => ({ nodeId, health: "up" as const, weight: 0 as const }))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      apiReadiness: canaryApiReadiness
        .map(({ nodeId }) => ({
          nodeId,
          ready: true as const,
          artifactSha256: target.sha256,
          sourceCommit: reservation.contract.target.sourceCommit,
          schemaVersion: 48 as const,
          deploymentMode: "container-image" as const,
          imageDigest: target.imageDigest!,
        }))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      workerReadiness: canaryWorkerReadiness
        .map(({ nodeId }) => ({
          nodeId,
          healthy: true as const,
          acceptingWork: true as const,
          artifactSha256: target.sha256,
          observedDatabaseSchemaVersion: 48 as const,
          schemaRuntimeMode: "normal" as const,
        }))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    };
    const observedProductionReceipt = assertReleaseMaintenanceProductionObservationReceipt({
      receipt: await canaryObserver.observe(canaryObservationBinding),
      expectedBinding: canaryObservationBinding,
      expectedPolicy: canaryObserver.policy,
      expectedObserverId: canaryObserver.observerId,
    });
    const persistedProductionReceipt = await persistCanaryObservationReceipt(
      observedProductionReceipt,
    );
    const expectedContentSha256 = crypto.createHash("sha256")
      .update(`${JSON.stringify(observedProductionReceipt)}\n`)
      .digest("hex");
    const persistedReceipt = assertReleaseMaintenanceProductionObservationReceipt({
      receipt: persistedProductionReceipt.receipt,
      expectedBinding: canaryObservationBinding,
      expectedPolicy: canaryObserver.policy,
      expectedObserverId: canaryObserver.observerId,
    });
    if (
      persistedProductionReceipt.receiptSha256 !== observedProductionReceipt.receiptSha256
      || persistedReceipt.receiptSha256 !== observedProductionReceipt.receiptSha256
      || persistedProductionReceipt.contentSha256 !== expectedContentSha256
    ) {
      fail(
        "RELEASE_MAINTENANCE_CANARY_OBSERVATION_PERSISTENCE_FAILED",
        "protected production observation receipt was not durably persisted byte-for-byte",
      );
    }
    await dependencies.recorder.record({
      event: "canary-observation-passed",
      phase,
      evidence: {
        operationId: canaryPlan.operationId,
        planSha256: canaryPlan.planDigestSha256,
        observationReceiptSha256: persistedProductionReceipt.receiptSha256,
        verdict: "PASS",
      },
    });
    canaryObservationRecorded = true;

    const containedCanary = await dependencies.loadBalancer.maintenanceContainCanary(
      canaryPlan.planDigestSha256,
      actionContext(reservation, "maintenance-canary-contain"),
    );
    const containmentReceiptSha256 = assertCanaryTrafficReceipt({
      receipt: containedCanary,
      plan: canaryPlan,
      expectedState: "contained",
    });
    await dependencies.recorder.record({
      event: "canary-contained",
      phase,
      evidence: {
        operationId: canaryPlan.operationId,
        planSha256: canaryPlan.planDigestSha256,
        containmentReceiptSha256,
      },
    });
    canaryContainedRecorded = true;

    await dependencies.loadBalancer.maintenanceRestoreAll(
      originalWeights,
      canaryPlan.planDigestSha256,
      actionContext(reservation, "maintenance-traffic-restore-all"),
    );
    await dependencies.recorder.record({ event: "traffic-restored", phase });
    }

    phase = "maintenance-public-smoke";
    const smoke = await dependencies.loadBalancer.publicSmoke(
      target,
      actionContext(reservation, "maintenance-public-smoke"),
    );
    if (!smoke.ok || smoke.artifactSha256 !== target.sha256) {
      fail("RELEASE_MAINTENANCE_PUBLIC_SMOKE_FAILED", "public smoke did not prove the exact target");
    }
    await dependencies.recorder.record({
      event: "public-smoke-completed",
      phase,
      evidence: { artifactSha256: target.sha256 },
    });

    const result: ReleaseMaintenanceExecutionResult = {
      deploymentId: reservation.deploymentId,
      targetArtifactSha256: target.sha256,
      databaseIdentitySha256,
      writerQuiescenceProofSha256: writerProof.proofSha256,
      writerQuiescenceProofContentSha256: persistedWriterProof.contentSha256,
      backupCheckpointEvidenceSha256: checkpoint.contentSha256,
      maintenanceBackfillReceiptSha256: receipt.contentSha256,
      apiNodeIds,
      workerNodeIds,
      ...(privateValidationReceiptSha256
        ? { privateValidationReceiptSha256 }
        : {}),
      ...(privateValidationEvidenceManifestSha256
        ? { privateValidationEvidenceManifestSha256 }
        : {}),
      ...(restoreAttemptEvidenceSha256
        ? { restoreAttemptEvidenceSha256 }
        : {}),
      ...(listenerBaselineEvidenceSha256
        && listenerDisableEvidenceSha256
        && listenerEnableAttemptEvidenceSha256
        && listenerEnableEvidenceSha256
        ? {
          listenerBaselineEvidenceSha256,
          listenerDisableEvidenceSha256,
          listenerEnableAttemptEvidenceSha256,
          listenerEnableEvidenceSha256,
        }
        : {}),
      publicSmokeComplete: true,
    };
    await dependencies.recorder.succeed(result);
    return result;
  } catch (error) {
    let code = safeErrorCode(error);
    let containmentFailed = false;
    if (
      reservation.contract.trafficMode === "full-maintenance"
      && listenerContainmentRequired
    ) {
      try {
        assertFullMaintenanceListenerBarrierReceipt({
          receipt: await dependencies.loadBalancer.fullMaintenanceContainListeners(
            actionContext(reservation, "full-maintenance-listeners-contain-after-failure"),
          ),
          reservation,
          expectedPhase: "contained",
          expectedState: "all-off",
        });
      } catch {
        code = "RELEASE_MAINTENANCE_LISTENER_BARRIER_FAILED";
        containmentFailed = true;
      }
    }
    if (canaryPlanForContainment && !canaryContainedRecorded) {
      try {
        const containedCanary = await dependencies.loadBalancer.maintenanceContainCanary(
          canaryPlanForContainment.planDigestSha256,
          actionContext(reservation, "maintenance-canary-containment-after-failure"),
        );
        const containmentReceiptSha256 = assertCanaryTrafficReceipt({
          receipt: containedCanary,
          plan: canaryPlanForContainment,
          expectedState: "contained",
        });
        if (canaryPlanRecorded) {
          try {
            await dependencies.recorder.record({
              event: canaryObservationRecorded
                ? "canary-contained"
                : "canary-contained-after-failure",
              phase: "maintenance-traffic-restore",
              evidence: {
                operationId: canaryPlanForContainment.operationId,
                planSha256: canaryPlanForContainment.planDigestSha256,
                containmentReceiptSha256,
              },
            });
            canaryContainedRecorded = true;
          } catch {
            // Provider containment is authoritative for immediate safety. The
            // durable plan forces the next recovery owner to inspect/contain
            // again when this evidence CAS could not be committed.
          }
        }
      } catch {
        code = "RELEASE_MAINTENANCE_CANARY_CONTAINMENT_FAILED";
        containmentFailed = true;
      }
    }
    if (trafficMutationAttempted && originalWeightsForContainment) {
      try {
        if (reservation.contract.trafficMode === "full-maintenance") {
          await dependencies.loadBalancer.fullMaintenanceContainAll(
            originalWeightsForContainment,
            actionContext(reservation, "full-maintenance-traffic-containment-after-failure"),
          );
        } else {
          await dependencies.loadBalancer.maintenanceContainAll(
            originalWeightsForContainment,
            actionContext(reservation, "maintenance-traffic-containment-after-failure"),
          );
        }
      } catch {
        code = "RELEASE_MAINTENANCE_CONTAINMENT_FAILED";
        containmentFailed = true;
      }
    }
    if (apiArtifactsForContainment.size > 0) {
      let apiContainmentFailed = false;
      for (const [nodeId, expectedArtifactSha256] of apiArtifactsForContainment) {
        try {
          await drainApiConnections({
            reservation,
            nodeId,
            expectedArtifactSha256,
            agent: dependencies.apiNodeAgent,
            clock: dependencies.clock ?? systemClock,
            timeoutMs: dependencies.apiDrainTimeoutMs ?? 310_000,
            pollIntervalMs: dependencies.apiDrainPollIntervalMs ?? 1_000,
          });
        } catch {
          apiContainmentFailed = true;
        }
      }
      if (apiContainmentFailed) {
        code = "RELEASE_MAINTENANCE_API_CONTAINMENT_FAILED";
        containmentFailed = true;
      }
    }
    if (workerContainmentRequired) {
      let workerContainmentFailed = false;
      for (const nodeId of workerNodeIdsForContainment) {
        try {
          const context = actionContext(
            reservation,
            `maintenance-worker-containment-after-failure:${nodeId}`,
          );
          await dependencies.workerControlPlane.requestDrain(nodeId, context);
          const snapshot = await dependencies.workerControlPlane.waitForDrained(nodeId, context);
          assertWorkerDrained(snapshot, nodeId, reservation);
        } catch {
          workerContainmentFailed = true;
        }
      }
      if (workerContainmentFailed) {
        code = "RELEASE_MAINTENANCE_WORKER_CONTAINMENT_FAILED";
        containmentFailed = true;
      }
    }
    try {
      await dependencies.recorder.fail({ phase, code, migrationAttempted });
    } catch {
      // The original failure remains authoritative. Lease/fencing loss means
      // another recovery owner is responsible for durable incident marking.
    }
    if (!containmentFailed && error instanceof ReleaseMaintenanceActivationOrchestratorError) {
      throw error;
    }
    throw new ReleaseMaintenanceActivationOrchestratorError(
      code,
      `maintenance activation failed during ${phase}`,
    );
  }
}
