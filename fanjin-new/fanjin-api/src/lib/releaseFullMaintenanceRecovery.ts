import { createHash } from "node:crypto";

import type { Knex } from "knex";

import {
  failReleaseMaintenanceExecution,
  readReleaseMaintenanceExecution,
  renewReleaseMaintenanceExecutionLease,
  RELEASE_FULL_MAINTENANCE_RECOVERY_LEASE_MS,
  RELEASE_MAINTENANCE_EXECUTOR_KIND,
  takeoverReleaseFullMaintenanceRecoveryExecution,
  type ReleaseMaintenanceExecutionClaim,
  type ReleaseMaintenanceExecutionState,
} from "@/lib/releaseMaintenanceActivationExecution";
import type { ReleaseFullMaintenanceProcessBoundaryBinding } from
  "@/lib/releaseFullMaintenanceProcessLock";
import { assertReleaseFullMaintenanceSshMutationUncertaintyBinding } from "@/lib/releaseFullMaintenanceSshMutationUncertainty";
import type {
  FullMaintenanceListenerBarrierReceipt,
  FullMaintenanceBackendWeightReceipt,
  FullMaintenanceMutationUncertaintyReceipt,
  MaintenanceNodeActivationBinding,
  MaintenanceNodeAgent,
  MaintenanceNodeContainResult,
  MaintenanceNodeObservation,
  MaintenanceNodeQuiesceResult,
  MaintenanceLoadBalancer,
  NodeAgent,
  ReleaseActionContext,
  WorkerControlPlane,
  WorkerRuntimeSnapshot,
} from "@/release-controller/types";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const DEFAULT_API_DRAIN_TIMEOUT_MS = 310_000;
const DEFAULT_API_DRAIN_POLL_INTERVAL_MS = 1_000;
const CLB_API_REQUEST_TIMEOUT_UPPER_BOUND_MS = 120_000;
const CLB_OPERATION_CONVERGENCE_UPPER_BOUND_MS = 360_000;
const CLB_POLL_INTERVAL_UPPER_BOUND_MS = 360_000;

export const RELEASE_FULL_MAINTENANCE_RECOVERY_FORMAT =
  "fanjin-release-full-maintenance-recovery/v1" as const;

export class ReleaseFullMaintenanceRecoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenanceRecoveryError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenanceRecoveryError(code, message);
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

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function assertMutationUncertaintyReceipt(
  receipt: FullMaintenanceMutationUncertaintyReceipt,
  state: ReleaseMaintenanceExecutionState,
): number {
  const barrier = state.contract.publicTrafficBarrier;
  const expectedTargetCount = barrier.backends.length;
  const withoutEvidence = {
    format: receipt.format,
    loadBalancerId: receipt.loadBalancerId,
    serverGroupId: receipt.serverGroupId,
    backendBindings: receipt.backendBindings,
    targetCount: receipt.targetCount,
    apiRequestTimeoutUpperBoundMs: receipt.apiRequestTimeoutUpperBoundMs,
    requestRetryBudgetUpperBoundMs: receipt.requestRetryBudgetUpperBoundMs,
    operationConvergenceUpperBoundMs: receipt.operationConvergenceUpperBoundMs,
    pollIntervalUpperBoundMs: receipt.pollIntervalUpperBoundMs,
    sequentialApiCallSlots: receipt.sequentialApiCallSlots,
    convergenceWindowSlots: receipt.convergenceWindowSlots,
    settleMs: receipt.settleMs,
  };
  const expectedApiCallSlots = 5 * expectedTargetCount + 2;
  const expectedConvergenceWindowSlots = 2 * expectedTargetCount + 1;
  const expectedSettleMs =
    expectedApiCallSlots * CLB_API_REQUEST_TIMEOUT_UPPER_BOUND_MS
    + expectedConvergenceWindowSlots * (
      CLB_OPERATION_CONVERGENCE_UPPER_BOUND_MS
      + CLB_API_REQUEST_TIMEOUT_UPPER_BOUND_MS
    );
  if (
    receipt.format !== "fanjin-full-maintenance-mutation-uncertainty/v1"
    || receipt.loadBalancerId !== barrier.loadBalancerId
    || receipt.serverGroupId !== barrier.serverGroupId
    || canonicalJson(receipt.backendBindings) !== canonicalJson(barrier.backends)
    || receipt.targetCount !== expectedTargetCount
    || receipt.apiRequestTimeoutUpperBoundMs !== CLB_API_REQUEST_TIMEOUT_UPPER_BOUND_MS
    || receipt.requestRetryBudgetUpperBoundMs !== 0
    || receipt.operationConvergenceUpperBoundMs
      !== CLB_OPERATION_CONVERGENCE_UPPER_BOUND_MS
    || receipt.pollIntervalUpperBoundMs !== CLB_POLL_INTERVAL_UPPER_BOUND_MS
    || receipt.sequentialApiCallSlots !== expectedApiCallSlots
    || receipt.convergenceWindowSlots !== expectedConvergenceWindowSlots
    || !Number.isSafeInteger(expectedSettleMs)
    || receipt.settleMs !== expectedSettleMs
    || receipt.evidenceSha256 !== sha256Hex(withoutEvidence)
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_MUTATION_UNCERTAINTY_INVALID",
      "CLB mutation uncertainty receipt is not exact",
    );
  }
  return receipt.settleMs;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("RELEASE_FULL_MAINTENANCE_RECOVERY_CONFIG_INVALID", `${label} is invalid`);
  }
  return parsed;
}

export interface ReleaseFullMaintenanceRecoveryClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const systemClock: ReleaseFullMaintenanceRecoveryClock = {
  now: () => Date.now(),
  sleep: async (milliseconds) => {
    if (milliseconds > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    }
  },
};

type RecoveryLoadBalancer = Pick<
  MaintenanceLoadBalancer,
  | "fullMaintenanceContainListeners"
  | "fullMaintenanceContainAll"
  | "fullMaintenanceInspectBackendWeights"
> & Required<Pick<MaintenanceLoadBalancer, "fullMaintenanceMutationUncertainty">>;

type RecoveryApiNodeAgent = Pick<
  NodeAgent,
  "beginDrain" | "drainStatus"
> & Required<Pick<
  MaintenanceNodeAgent,
  "observeMaintenance" | "maintenanceContain" | "maintenanceQuiesce"
>>;

type RecoveryWorkerNodeAgent = Required<Pick<
  MaintenanceNodeAgent,
  "observeMaintenance" | "maintenanceContain" | "maintenanceQuiesce"
>>;

type RecoveryWorkerControlPlane = Pick<
  WorkerControlPlane,
  "requestDrain" | "waitForDrained"
>;

export interface ReleaseFullMaintenanceRecoveryDependencies {
  database: Knex;
  loadBalancer: RecoveryLoadBalancer;
  apiNodeAgent: RecoveryApiNodeAgent;
  workerNodeAgent: RecoveryWorkerNodeAgent;
  workerControlPlane: RecoveryWorkerControlPlane;
  clock?: ReleaseFullMaintenanceRecoveryClock;
  apiDrainTimeoutMs?: number;
  apiDrainPollIntervalMs?: number;
  takeover?: typeof takeoverReleaseFullMaintenanceRecoveryExecution;
  readExecution?: typeof readReleaseMaintenanceExecution;
  terminalize?: typeof failReleaseMaintenanceExecution;
  renewLease?: typeof renewReleaseMaintenanceExecutionLease;
}

export function assertReleaseFullMaintenanceRecoveryRoot(
  effectiveUid: number | undefined = process.geteuid?.(),
): void {
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid !== 0) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_ROOT_REQUIRED",
      "full-maintenance recovery must run as root",
    );
  }
}

function actionContext(
  state: ReleaseMaintenanceExecutionState,
  actionId: string,
): ReleaseActionContext {
  return {
    operationId: state.deploymentId,
    actionId,
    artifactSha256: state.contract.target.artifactSha256,
  };
}

function originalWeights(state: ReleaseMaintenanceExecutionState): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(
    state.checkpoint.originalApiTrafficWeights.map(({ targetKey, weight }) => [targetKey, weight]),
  ));
}

function assertClaimReadback(
  claim: ReleaseMaintenanceExecutionClaim,
  state: ReleaseMaintenanceExecutionState,
): void {
  if (
    state.deploymentId !== claim.deploymentId
    || state.status !== "running"
    || state.activeScope !== claim.activeScope
    || state.workerId !== claim.workerId
    || state.revision !== claim.revision
    || state.fencingToken !== claim.fencingToken
    || state.leaseExpiresAt !== claim.leaseExpiresAt
    || state.checkpoint.format !== "fanjin-release-maintenance-execution/v2"
    || state.checkpoint.trafficMode !== "full-maintenance"
    || state.contract.trafficMode !== "full-maintenance"
    || state.checkpoint.phase !== claim.checkpoint.phase
    || state.checkpoint.revision !== claim.checkpoint.revision
    || state.checkpoint.workerId !== claim.workerId
    || state.contract.contractSha256 !== claim.checkpoint.contractSha256
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_READBACK_INVALID",
      "recovery claim readback is not exact",
    );
  }
}

function assertListenerContainmentReceipt(
  receipt: FullMaintenanceListenerBarrierReceipt,
  state: ReleaseMaintenanceExecutionState,
): void {
  const expected = state.contract.publicTrafficBarrier;
  const { evidenceSha256: receiptEvidenceSha256, ...commitment } = receipt;
  if (
    receipt.format !== "fanjin-full-maintenance-listener-barrier/v1"
    || receipt.operationId !== state.deploymentId
    || receipt.artifactSha256 !== state.contract.target.artifactSha256
    || receipt.loadBalancerId !== expected.loadBalancerId
    || receipt.serverGroupId !== expected.serverGroupId
    || receipt.httpListenerId !== expected.listeners[0].listenerId
    || receipt.httpsListenerId !== expected.listeners[1].listenerId
    || receipt.phase !== "contained"
    || receipt.observedState !== "all-off"
    || receipt.stableReadCount !== 2
    || !SHA256_RE.test(receiptEvidenceSha256)
    || receiptEvidenceSha256 !== sha256Hex(commitment)
    || receipt.listeners.length !== 2
    || receipt.listeners[0].protocol !== "HTTP"
    || receipt.listeners[0].listenerId !== expected.listeners[0].listenerId
    || receipt.listeners[0].serverGroupId !== expected.serverGroupId
    || receipt.listeners[0].port !== 80
    || receipt.listeners[0].enabled !== false
    || receipt.listeners[0].status !== "Disabled"
    || receipt.listeners[1].protocol !== "HTTPS"
    || receipt.listeners[1].listenerId !== expected.listeners[1].listenerId
    || receipt.listeners[1].serverGroupId !== expected.serverGroupId
    || receipt.listeners[1].port !== 443
    || receipt.listeners[1].enabled !== false
    || receipt.listeners[1].status !== "Disabled"
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_LISTENER_CONTAINMENT_INVALID",
      "listener containment receipt is not exact",
    );
  }
}

function assertBackendContainmentReceipt(
  receipt: FullMaintenanceBackendWeightReceipt,
  state: ReleaseMaintenanceExecutionState,
): void {
  const expectedNodeIds = state.contract.inventory.targets
    .filter(({ role }) => role === "api")
    .map(({ key }) => key)
    .sort();
  const observedNodeIds = receipt.backends.map(({ nodeId }) => nodeId).sort();
  const { evidenceSha256: _evidence, ...withoutEvidence } = receipt;
  if (
    receipt.format !== "fanjin-full-maintenance-backend-weight/v1"
    || receipt.operationId !== state.deploymentId
    || receipt.artifactSha256 !== state.contract.target.artifactSha256
    || receipt.loadBalancerId !== state.contract.publicTrafficBarrier.loadBalancerId
    || receipt.serverGroupId !== state.contract.publicTrafficBarrier.serverGroupId
    || canonicalJson(receipt.backendBindings)
      !== canonicalJson(state.contract.publicTrafficBarrier.backends)
    || receipt.expectedState !== "all-zero"
    || receipt.stableReadCount !== 2
    || observedNodeIds.length !== expectedNodeIds.length
    || expectedNodeIds.some((nodeId, index) => nodeId !== observedNodeIds[index])
    || receipt.backends.some(({ weight }) => weight !== 0)
    || receipt.evidenceSha256 !== sha256Hex(withoutEvidence)
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_BACKEND_PROOF_INVALID",
      "final all-zero backend proof is not exact",
    );
  }
}

function maintenanceNodeBinding(
  state: ReleaseMaintenanceExecutionState,
  nodeId: string,
  role: "api" | "worker",
): MaintenanceNodeActivationBinding {
  const target = state.contract.target;
  if (!target.deployment || target.deployment.mode !== "container-image") {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_NODE_BINDING_INVALID",
      "recovery target is not the immutable container deployment",
    );
  }
  return {
    nodeId,
    role,
    expectedCurrentReleaseId: state.contract.previous.releaseId,
    expectedCurrentArtifactSha256: state.contract.previous.artifactSha256,
    targetReleaseId: target.releaseId,
    targetArtifactSha256: target.artifactSha256,
    targetSourceCommit: target.sourceCommit,
    targetSchemaVersion: target.schemaVersion,
    targetDeploymentMode: "container-image",
    targetImageDigest: target.deployment.imageDigest,
  };
}

type MaintenanceObservedArtifact = "previous" | "target";

function assertMaintenanceObservation(input: {
  state: ReleaseMaintenanceExecutionState;
  nodeId: string;
  role: "api" | "worker";
  observation: MaintenanceNodeObservation;
}): MaintenanceObservedArtifact {
  const { state, nodeId, role, observation } = input;
  const binding = maintenanceNodeBinding(state, nodeId, role);
  const receipt = observation.maintenance;
  if (
    typeof observation.processStopped !== "boolean"
    || !observation.current
    || observation.current.nodeId !== nodeId
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_NODE_OBSERVATION_INVALID",
      "maintenance node observation is not bound to the immutable inventory",
    );
  }
  const current = observation.current;
  const observed: MaintenanceObservedArtifact =
    current.releaseId === binding.expectedCurrentReleaseId
      && current.artifactSha256 === binding.expectedCurrentArtifactSha256
      ? "previous"
      : current.releaseId === binding.targetReleaseId
        && current.artifactSha256 === binding.targetArtifactSha256
        && current.schemaVersion === binding.targetSchemaVersion
        && current.deploymentMode === binding.targetDeploymentMode
        && current.imageDigest === binding.targetImageDigest
        ? "target"
        : fail(
          "RELEASE_FULL_MAINTENANCE_RECOVERY_NODE_IDENTITY_INVALID",
          "maintenance node is neither the exact previous nor exact target artifact",
        );
  if (receipt === null) {
    if (observed !== "previous") {
      fail(
        "RELEASE_FULL_MAINTENANCE_RECOVERY_NODE_STATE_INVALID",
        "target current cannot exist without a bound maintenance authority",
      );
    }
    return observed;
  }
  if (
    receipt.format !== "fanjin-node-maintenance-activation/v1"
    || receipt.operationId !== state.deploymentId
    || receipt.nodeId !== nodeId
    || receipt.role !== role
    || receipt.expectedCurrentReleaseId !== binding.expectedCurrentReleaseId
    || receipt.expectedCurrentArtifactSha256 !== binding.expectedCurrentArtifactSha256
    || receipt.targetReleaseId !== binding.targetReleaseId
    || receipt.targetArtifactSha256 !== binding.targetArtifactSha256
    || receipt.targetSchemaVersion !== binding.targetSchemaVersion
    || receipt.targetDeploymentMode !== binding.targetDeploymentMode
    || receipt.targetImageDigest !== binding.targetImageDigest
    || !SHA256_RE.test(receipt.bindingSha256)
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_NODE_OBSERVATION_INVALID",
      "maintenance node observation is not bound to the immutable contract",
    );
  }
  if (
    ((receipt.state === "quiescing" || receipt.state === "quiesced")
      && observed !== "previous")
    || (receipt.state === "consumed" && observed !== "target")
    || ![
      "quiescing",
      "quiesced",
      "activation-attempted",
      "consumed",
    ].includes(receipt.state)
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_NODE_STATE_INVALID",
      "maintenance state conflicts with the exact current artifact",
    );
  }
  return observed;
}

function assertMaintenanceQuiesceResult(input: {
  state: ReleaseMaintenanceExecutionState;
  nodeId: string;
  role: "api" | "worker";
  result: MaintenanceNodeQuiesceResult;
}): void {
  const binding = maintenanceNodeBinding(input.state, input.nodeId, input.role);
  const receipt = input.result.maintenance;
  if (
    input.result.processStopped !== true
    || (receipt.state !== "quiesced" && receipt.state !== "activation-attempted")
    || receipt.operationId !== input.state.deploymentId
    || receipt.nodeId !== input.nodeId
    || receipt.role !== input.role
    || receipt.expectedCurrentReleaseId !== binding.expectedCurrentReleaseId
    || receipt.expectedCurrentArtifactSha256 !== binding.expectedCurrentArtifactSha256
    || receipt.targetReleaseId !== binding.targetReleaseId
    || receipt.targetArtifactSha256 !== binding.targetArtifactSha256
    || receipt.targetSchemaVersion !== binding.targetSchemaVersion
    || receipt.targetDeploymentMode !== binding.targetDeploymentMode
    || receipt.targetImageDigest !== binding.targetImageDigest
    || !SHA256_RE.test(receipt.bindingSha256)
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_NODE_QUIESCE_INVALID",
      "maintenance quiesce did not prove the exact previous runtime stopped",
    );
  }
}

async function observeAndContainMaintenanceNode(input: {
  state: ReleaseMaintenanceExecutionState;
  nodeId: string;
  role: "api" | "worker";
  agent: Required<Pick<
    MaintenanceNodeAgent,
    "observeMaintenance" | "maintenanceContain" | "maintenanceQuiesce"
  >>;
}): Promise<Readonly<{
  observation: MaintenanceNodeObservation;
  artifact: MaintenanceObservedArtifact;
}>> {
  const binding = maintenanceNodeBinding(input.state, input.nodeId, input.role);
  const context = actionContext(
    input.state,
    `full-maintenance-recovery-node-observe:${input.nodeId}`,
  );
  let observation = await input.agent.observeMaintenance(binding, context);
  let artifact = assertMaintenanceObservation({ ...input, observation });
  if (
    artifact === "previous"
    && (
      observation.maintenance === null
      || observation.maintenance.state === "quiescing"
      || !observation.processStopped
    )
  ) {
    const quiesced = await input.agent.maintenanceQuiesce(
      binding,
      actionContext(
        input.state,
        `full-maintenance-recovery-node-quiesce:${input.nodeId}`,
      ),
    );
    assertMaintenanceQuiesceResult({ ...input, result: quiesced });
    observation = await input.agent.observeMaintenance(binding, context);
    artifact = assertMaintenanceObservation({ ...input, observation });
  }
  if (
    artifact === "previous"
    && (observation.maintenance === null || !observation.processStopped)
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_PREVIOUS_RUNTIME_NOT_STOPPED",
      "previous runtime was not durably stopped by the maintenance Node Agent",
    );
  }
  return { observation, artifact };
}

async function containTargetRuntime(input: {
  state: ReleaseMaintenanceExecutionState;
  nodeId: string;
  role: "api" | "worker";
  agent: Required<Pick<
    MaintenanceNodeAgent,
    "observeMaintenance" | "maintenanceContain"
  >>;
}): Promise<void> {
  const binding = maintenanceNodeBinding(input.state, input.nodeId, input.role);
  const result: MaintenanceNodeContainResult = await input.agent.maintenanceContain(
    binding,
    actionContext(
      input.state,
      `full-maintenance-recovery-node-contain:${input.nodeId}`,
    ),
  );
  if (result.processStopped !== true) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_TARGET_CONTAINMENT_INVALID",
      "maintenance containment did not stop the fixed target runtime",
    );
  }
  const containedArtifact = assertMaintenanceObservation({
    ...input,
    observation: {
      processStopped: result.processStopped,
      maintenance: result.maintenance,
      current: result.current,
    },
  });
  if (containedArtifact !== "target") {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_TARGET_CONTAINMENT_INVALID",
      "maintenance containment did not bind the exact target runtime",
    );
  }
  const observation = await input.agent.observeMaintenance(
    binding,
    actionContext(
      input.state,
      `full-maintenance-recovery-node-observe:${input.nodeId}`,
    ),
  );
  if (
    assertMaintenanceObservation({ ...input, observation }) !== "target"
    || !observation.processStopped
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_TARGET_CONTAINMENT_INVALID",
      "target runtime did not remain durably stopped after containment",
    );
  }
}

async function recontainAndProveMaintenanceNodeStopped(input: {
  state: ReleaseMaintenanceExecutionState;
  nodeId: string;
  role: "api" | "worker";
  agent: Required<Pick<
    MaintenanceNodeAgent,
    "observeMaintenance" | "maintenanceContain" | "maintenanceQuiesce"
  >>;
}): Promise<void> {
  await observeAndContainMaintenanceNode(input);
  const binding = maintenanceNodeBinding(input.state, input.nodeId, input.role);
  const contained = await input.agent.maintenanceContain(
    binding,
    actionContext(
      input.state,
      `full-maintenance-recovery-node-final-contain:${input.nodeId}`,
    ),
  );
  if (contained.processStopped !== true) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_FINAL_NODE_CONTAINMENT_INVALID",
      "final maintenance containment did not stop the exact runtime",
    );
  }
  const containedObservation: MaintenanceNodeObservation = {
    processStopped: contained.processStopped,
    maintenance: contained.maintenance,
    current: contained.current,
  };
  const containedArtifact = assertMaintenanceObservation({
    ...input,
    observation: containedObservation,
  });
  const stableObservations: MaintenanceNodeObservation[] = [];
  for (const stableRead of [1, 2] as const) {
    const observation = await input.agent.observeMaintenance(
      binding,
      actionContext(
        input.state,
        `full-maintenance-recovery-node-final-stopped-${stableRead}:${input.nodeId}`,
      ),
    );
    const observedArtifact = assertMaintenanceObservation({ ...input, observation });
    if (
      observation.processStopped !== true
      || observation.maintenance === null
      || observedArtifact !== containedArtifact
    ) {
      fail(
        "RELEASE_FULL_MAINTENANCE_RECOVERY_FINAL_NODE_CONTAINMENT_INVALID",
        "final maintenance observation did not prove the contained runtime stopped",
      );
    }
    stableObservations.push(observation);
  }
  if (canonicalJson(stableObservations[0]) !== canonicalJson(stableObservations[1])) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_FINAL_NODE_CONTAINMENT_INVALID",
      "final maintenance stopped observations were not stable",
    );
  }
}

async function drainApiNode(input: {
  state: ReleaseMaintenanceExecutionState;
  nodeId: string;
  expectedArtifactSha256: string;
  agent: RecoveryApiNodeAgent;
  clock: ReleaseFullMaintenanceRecoveryClock;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<void> {
  const context = actionContext(
    input.state,
    `full-maintenance-recovery-api-drain:${input.nodeId}`,
  );
  let status = await input.agent.beginDrain(
    input.nodeId,
    input.expectedArtifactSha256,
    context,
  );
  const startedAt = input.clock.now();
  while (true) {
    if (!status.draining) {
      fail(
        "RELEASE_FULL_MAINTENANCE_RECOVERY_API_DRAIN_INVALID",
        "API drain fence is not active",
      );
    }
    if (status.totalConnections === 0) return;
    if (input.clock.now() - startedAt >= input.timeoutMs) {
      fail(
        "RELEASE_FULL_MAINTENANCE_RECOVERY_API_DRAIN_TIMEOUT",
        "API connections did not drain before the recovery deadline",
      );
    }
    await input.clock.sleep(input.pollIntervalMs);
    status = await input.agent.drainStatus(
      input.nodeId,
      input.expectedArtifactSha256,
      context,
    );
  }
}

function assertWorkerDrained(
  snapshot: WorkerRuntimeSnapshot,
  nodeId: string,
  state: ReleaseMaintenanceExecutionState,
  expectedArtifactSha256: string,
): void {
  if (
    snapshot.nodeId !== nodeId
    || !snapshot.healthy
    || snapshot.acceptingWork
    || snapshot.activeTaskCount !== 0
    || snapshot.drainOperationId !== state.deploymentId
    || snapshot.artifactSha256 !== expectedArtifactSha256
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_WORKER_DRAIN_INVALID",
      "Worker drain proof is not exact",
    );
  }
}

function checkpointProgressIdentity(state: ReleaseMaintenanceExecutionState): string {
  const checkpoint = state.checkpoint;
  const {
    status: _status,
    phase: _phase,
    failure: _failure,
    completedAt: _completedAt,
    revision: _revision,
    updatedAt: _updatedAt,
    ...progress
  } = checkpoint;
  return canonicalJson(progress);
}

function assertTerminalRecoveryState(
  before: ReleaseMaintenanceExecutionState,
  after: ReleaseMaintenanceExecutionState,
): void {
  if (
    after.deploymentId !== before.deploymentId
    || after.status !== "degraded_manual"
    || after.phase !== "maintenance-degraded-manual"
    || after.activeScope !== before.activeScope
    || after.workerId !== null
    || after.leaseExpiresAt !== null
    || after.fencingToken !== before.fencingToken
    || after.revision !== before.revision + 1
    || after.checkpoint.failure?.failedPhase !== before.phase
    || after.checkpoint.failure?.irreversibleSchemaBoundaryCrossed
      !== before.checkpoint.schemaMigration.attempted
    || after.checkpoint.irreversibleSchemaBoundaryCrossed
      !== before.checkpoint.irreversibleSchemaBoundaryCrossed
    || checkpointProgressIdentity(after) !== checkpointProgressIdentity(before)
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_TERMINAL_STATE_INVALID",
      "recovery terminal state changed migration progress",
    );
  }
}

function stageFailure(code: string, message: string, error: unknown): never {
  if (error instanceof ReleaseFullMaintenanceRecoveryError) throw error;
  fail(code, message);
}

interface ReleaseFullMaintenanceRecoveryHeartbeat {
  assertActive(): void;
  stop(): Promise<void>;
}

function startRecoveryLeaseHeartbeat(input: {
  claim: ReleaseMaintenanceExecutionClaim;
  database: Knex;
  now: () => number;
  renewLease: typeof renewReleaseMaintenanceExecutionLease;
}): ReleaseFullMaintenanceRecoveryHeartbeat {
  const intervalMs = Math.floor(RELEASE_FULL_MAINTENANCE_RECOVERY_LEASE_MS / 3);
  let stopped = false;
  let failure: unknown = null;
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;
  const wait = () => new Promise<void>((resolve) => {
    wake = resolve;
    timer = setTimeout(() => {
      timer = null;
      wake = null;
      resolve();
    }, intervalMs);
    timer.unref?.();
  });
  const running = (async () => {
    while (!stopped) {
      await wait();
      if (stopped) break;
      try {
        await input.renewLease({
          executorKind: RELEASE_MAINTENANCE_EXECUTOR_KIND,
          deploymentId: input.claim.deploymentId,
          workerId: input.claim.workerId,
          expectedRevision: input.claim.revision,
          fencingToken: input.claim.fencingToken,
          leaseMs: RELEASE_FULL_MAINTENANCE_RECOVERY_LEASE_MS,
        }, {
          database: input.database,
          now: input.now,
        });
      } catch (error) {
        failure = error;
        break;
      }
    }
  })();
  return {
    assertActive() {
      if (failure) {
        fail(
          "RELEASE_FULL_MAINTENANCE_RECOVERY_LEASE_LOST",
          "recovery lease heartbeat was lost",
        );
      }
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        const release = wake;
        wake = null;
        release?.();
      }
      await running;
    },
  };
}

/**
 * Fail-forward crash recovery. It never resumes schema/binary work and never
 * rolls back. The recovery claim remains active when any containment action
 * fails, so the same idempotent sequence can be retried after lease expiry.
 */
export async function recoverReleaseFullMaintenanceExecution(input: {
  deploymentId: string;
  workerId: string;
  processBoundary?: ReleaseFullMaintenanceProcessBoundaryBinding;
}, dependencies: ReleaseFullMaintenanceRecoveryDependencies): Promise<ReleaseMaintenanceExecutionState> {
  const clock = dependencies.clock ?? systemClock;
  const takeover = dependencies.takeover ?? takeoverReleaseFullMaintenanceRecoveryExecution;
  const readExecution = dependencies.readExecution ?? readReleaseMaintenanceExecution;
  const terminalize = dependencies.terminalize ?? failReleaseMaintenanceExecution;
  const renewLease = dependencies.renewLease ?? renewReleaseMaintenanceExecutionLease;
  const timeoutMs = boundedInteger(
    dependencies.apiDrainTimeoutMs,
    DEFAULT_API_DRAIN_TIMEOUT_MS,
    1_000,
    60 * 60_000,
    "apiDrainTimeoutMs",
  );
  const pollIntervalMs = boundedInteger(
    dependencies.apiDrainPollIntervalMs,
    DEFAULT_API_DRAIN_POLL_INTERVAL_MS,
    10,
    60_000,
    "apiDrainPollIntervalMs",
  );

  let claim: ReleaseMaintenanceExecutionClaim;
  try {
    claim = await takeover({
      deploymentId: input.deploymentId,
      workerId: input.workerId,
      processBoundary: input.processBoundary,
    }, {
      database: dependencies.database,
      now: clock.now,
    });
  } catch (error) {
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_TAKEOVER_FAILED",
      "full-maintenance recovery takeover failed",
      error,
    );
  }

  let state: ReleaseMaintenanceExecutionState;
  try {
    state = await readExecution(dependencies.database, {
      deploymentId: claim.deploymentId,
    });
    assertClaimReadback(claim, state);
  } catch (error) {
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_READBACK_FAILED",
      "full-maintenance recovery readback failed",
      error,
    );
  }

  const heartbeat = startRecoveryLeaseHeartbeat({
    claim,
    database: dependencies.database,
    now: clock.now,
    renewLease,
  });

  let mutationUncertaintySettleMs: number;
  let sshMutationUncertaintySettleMs: number;
  try {
    heartbeat.assertActive();
    sshMutationUncertaintySettleMs =
      assertReleaseFullMaintenanceSshMutationUncertaintyBinding(
        state.checkpoint.sshMutationUncertainty,
      ).settleMs;
    mutationUncertaintySettleMs = assertMutationUncertaintyReceipt(
      dependencies.loadBalancer.fullMaintenanceMutationUncertainty(),
      state,
    );
    heartbeat.assertActive();
  } catch (error) {
    await heartbeat.stop();
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_MUTATION_UNCERTAINTY_INVALID",
      "CLB or SSH mutation uncertainty binding is invalid",
      error,
    );
  }

  try {
    heartbeat.assertActive();
    const receipt = await dependencies.loadBalancer.fullMaintenanceContainListeners(
      actionContext(state, "full-maintenance-recovery-listeners-contain"),
    );
    assertListenerContainmentReceipt(receipt, state);
    heartbeat.assertActive();
  } catch (error) {
    await heartbeat.stop();
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_LISTENER_CONTAINMENT_FAILED",
      "production listener containment failed",
      error,
    );
  }

  try {
    heartbeat.assertActive();
    await dependencies.loadBalancer.fullMaintenanceContainAll(
      originalWeights(state),
      actionContext(state, "full-maintenance-recovery-backends-contain"),
    );
    heartbeat.assertActive();
  } catch (error) {
    await heartbeat.stop();
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_BACKEND_CONTAINMENT_FAILED",
      "production backend containment failed",
      error,
    );
  }

  const apiNodeIds = state.contract.inventory.targets
    .filter(({ role }) => role === "api")
    .map(({ key }) => key);
  try {
    for (const nodeId of apiNodeIds) {
      heartbeat.assertActive();
      const contained = await observeAndContainMaintenanceNode({
        state,
        nodeId,
        role: "api",
        agent: dependencies.apiNodeAgent,
      });
      if (contained.observation.processStopped) {
        heartbeat.assertActive();
        continue;
      }
      try {
        await drainApiNode({
          state,
          nodeId,
          expectedArtifactSha256: contained.observation.current.artifactSha256,
          agent: dependencies.apiNodeAgent,
          clock,
          timeoutMs,
          pollIntervalMs,
        });
      } catch {
        // App readiness is advisory during fail-forward recovery. The trusted
        // Node Agent containment below is the authoritative stop boundary.
      }
      await containTargetRuntime({
        state,
        nodeId,
        role: "api",
        agent: dependencies.apiNodeAgent,
      });
      heartbeat.assertActive();
    }
  } catch (error) {
    await heartbeat.stop();
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_API_DRAIN_FAILED",
      "API recovery drain failed",
      error,
    );
  }

  const workerNodeIds = state.contract.inventory.targets
    .filter(({ role }) => role === "worker")
    .map(({ key }) => key);
  try {
    for (const nodeId of workerNodeIds) {
      heartbeat.assertActive();
      const contained = await observeAndContainMaintenanceNode({
        state,
        nodeId,
        role: "worker",
        agent: dependencies.workerNodeAgent,
      });
      if (contained.observation.processStopped) {
        heartbeat.assertActive();
        continue;
      }
      const context = actionContext(
        state,
        `full-maintenance-recovery-worker-drain:${nodeId}`,
      );
      try {
        await dependencies.workerControlPlane.requestDrain(nodeId, context);
        const snapshot = await dependencies.workerControlPlane.waitForDrained(nodeId, context);
        assertWorkerDrained(
          snapshot,
          nodeId,
          state,
          contained.observation.current.artifactSha256,
        );
      } catch {
        // Worker heartbeat/readiness may be stale or unavailable. The trusted
        // Node Agent containment below is the authoritative stop boundary.
      }
      await containTargetRuntime({
        state,
        nodeId,
        role: "worker",
        agent: dependencies.workerNodeAgent,
      });
      heartbeat.assertActive();
    }
  } catch (error) {
    await heartbeat.stop();
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_WORKER_DRAIN_FAILED",
      "Worker recovery drain failed",
      error,
    );
  }

  try {
    heartbeat.assertActive();
    await clock.sleep(mutationUncertaintySettleMs);
    const remainingSshSettleMs = Math.max(
      0,
      sshMutationUncertaintySettleMs - mutationUncertaintySettleMs,
    );
    if (remainingSshSettleMs > 0) await clock.sleep(remainingSshSettleMs);
    heartbeat.assertActive();
  } catch (error) {
    await heartbeat.stop();
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_MUTATION_UNCERTAINTY_SETTLE_FAILED",
      "prior CLB mutation uncertainty did not settle",
      error,
    );
  }

  try {
    for (const nodeId of apiNodeIds) {
      heartbeat.assertActive();
      await recontainAndProveMaintenanceNodeStopped({
        state,
        nodeId,
        role: "api",
        agent: dependencies.apiNodeAgent,
      });
      heartbeat.assertActive();
    }
    for (const nodeId of workerNodeIds) {
      heartbeat.assertActive();
      await recontainAndProveMaintenanceNodeStopped({
        state,
        nodeId,
        role: "worker",
        agent: dependencies.workerNodeAgent,
      });
      heartbeat.assertActive();
    }
  } catch (error) {
    await heartbeat.stop();
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_FINAL_NODE_CONTAINMENT_FAILED",
      "final all-node maintenance containment proof failed",
      error,
    );
  }

  try {
    heartbeat.assertActive();
    const receipt = await dependencies.loadBalancer.fullMaintenanceContainListeners(
      actionContext(state, "full-maintenance-recovery-listeners-reconfirm"),
    );
    assertListenerContainmentReceipt(receipt, state);
    heartbeat.assertActive();
    await dependencies.loadBalancer.fullMaintenanceContainAll(
      originalWeights(state),
      actionContext(state, "full-maintenance-recovery-backends-reconfirm"),
    );
    heartbeat.assertActive();
    const backendReceipt = await dependencies.loadBalancer.fullMaintenanceInspectBackendWeights(
      originalWeights(state),
      "all-zero",
      actionContext(state, "full-maintenance-recovery-backends-stable"),
    );
    assertBackendContainmentReceipt(backendReceipt, state);
    heartbeat.assertActive();
    const finalReceipt = await dependencies.loadBalancer.fullMaintenanceContainListeners(
      actionContext(state, "full-maintenance-recovery-listeners-final"),
    );
    assertListenerContainmentReceipt(finalReceipt, state);
    heartbeat.assertActive();
  } catch (error) {
    await heartbeat.stop();
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_FINAL_CONTAINMENT_FAILED",
      "final listener and backend containment proof failed",
      error,
    );
  }

  try {
    heartbeat.assertActive();
    await heartbeat.stop();
    heartbeat.assertActive();
    const terminal = await terminalize({
      executorKind: RELEASE_MAINTENANCE_EXECUTOR_KIND,
      deploymentId: state.deploymentId,
      workerId: claim.workerId,
      expectedRevision: claim.revision,
      fencingToken: claim.fencingToken,
      failureCode: "MAINTENANCE_INTERNAL_FAILED",
    }, {
      database: dependencies.database,
      now: clock.now,
    });
    assertTerminalRecoveryState(state, terminal);
    return terminal;
  } catch (error) {
    stageFailure(
      "RELEASE_FULL_MAINTENANCE_RECOVERY_TERMINALIZE_FAILED",
      "recovery containment could not be recorded",
      error,
    );
  }
}
