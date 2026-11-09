import type { RedisCutoverCoordinator } from "./redisCutoverCoordinator";
import type {
  ReleaseSchemaCompatibilityBridgeV1,
  ReleaseSchemaCompatibilityV1,
} from "@/lib/releaseSchemaCompatibility";
import type { ReleaseContainerDeploymentV1 } from "@/lib/releaseArtifactManifest";

export type ReleaseDeploymentMode = "archive-systemd" | "container-image";

export type ReleaseSchemaMode = "schema-neutral" | "migration";

/**
 * The sole signed schema-compatibility shape accepted by v0.0.7.
 *
 * Keep this alias for the release-controller's internal interfaces, but never
 * reintroduce the retired T6 read/write-range contract at an artifact,
 * checkpoint, Node Agent, or readiness boundary.
 */
export type ReleaseSchemaCompatibility = ReleaseSchemaCompatibilityV1;

export type ReleaseOperationStatus = "running" | "succeeded" | "failed";

export type ReleasePhase =
  | "preflight"
  | "stage"
  | "schema-migration"
  | "rolling"
  | "worker-rolling"
  | "public-smoke"
  | "redis-cutover"
  | "rollback"
  | "success"
  | "failed";

export type BackendHealth = "up" | "down" | "unknown";

/**
 * A release artifact deliberately contains no download URL or credentials.
 * The NodeAgent resolves the opaque id to a short-lived credential outside of
 * the durable release checkpoint.
 */
export interface ReleaseArtifact {
  id: string;
  /** Platform release identity copied from the signed artifact manifest. */
  releaseId?: string;
  version: string;
  sha256: string;
  /** Immutable Git identity copied from the independently attested manifest. */
  sourceCommit?: string;
  /** Database compatibility generation bound into the immutable manifest. */
  schemaVersion: number;
  /** Must match the immutable manifest and the enclosing ReleasePlan. */
  schemaMode?: ReleaseSchemaMode;
  /** Explicit read/write range used to prove N/N-1 schema compatibility. */
  schemaCompatibility?: ReleaseSchemaCompatibility;
  /** Queue/task payload compatibility generation shared by API and Worker. */
  workerProtocolVersion: number;
  /** Signed runtime features that remain safe after an irreversible cutover. */
  runtimeCapabilities?: readonly string[];
  /** Signed container identity; absent for historical archive/systemd artifacts. */
  deployment?: ReleaseContainerDeploymentV1;
  /** Persisted independently from the archive SHA for checkpoint auditability. */
  deploymentMode?: ReleaseDeploymentMode;
  /** OCI digest only; never substituted for the release archive SHA. */
  imageDigest?: string | null;
}

export interface ReleasePlan {
  /** Caller-generated idempotency key. Reusing it resumes the same operation. */
  operationId: string;
  artifact: ReleaseArtifact;
  /** Immutable, attested N-1 identity retained through bridge cleanup. */
  previousArtifact?: ReleaseArtifact;
  schemaMode: ReleaseSchemaMode;
  /** Exact server-derived N/N-1 bridge; absent for same-generation releases. */
  schemaCompatibility?: ReleaseSchemaCompatibilityBridgeV1 | null;
  /** Optional allow-list/order. If omitted, the load balancer order is used. */
  nodeIds?: readonly string[];
  /** Trusted API inventory. `nodeIds` remains the backwards-compatible alias. */
  apiNodeIds?: readonly string[];
  /** Trusted worker inventory. Worker targets are never inferred from CLB. */
  workerNodeIds?: readonly string[];
  /** Minimum number of workers that must remain fresh and accepting work. */
  minHealthyWorkers?: number;
}

export interface RollingPolicy {
  /** At least two consecutive CLB observations are always required. */
  clbUpConfirmations: number;
  clbPollIntervalMs: number;
  /** Application connection counters must be zero twice within this window. */
  drainTimeoutMs: number;
  drainPollIntervalMs: number;
  bakeTimeMs: number;
}

export interface ReleaseActionContext {
  operationId: string;
  /** Stable across retries so adapters can make side effects idempotent. */
  actionId: string;
  artifactSha256: string;
}

export interface NodePreflightPolicy {
  /**
   * A node that has crossed the durable activation-attempt boundary may
   * legitimately expose either the exact previous release or the exact target
   * release while the controller re-samples runtime state or recovers a lost
   * response. Untouched nodes must keep this false so an unexpected early
   * target switch still fails closed.
   */
  allowTargetCurrent?: boolean;
}

export interface LoadBalancerBackend {
  nodeId: string;
  weight: number;
  health: BackendHealth;
}

export interface DrainResult {
  drained: boolean;
  activeConnections?: number;
}

export interface PublicSmokeResult {
  ok: boolean;
  artifactSha256?: string;
  code?: string;
}

/** Adapter for CLB (or another layer-7 load balancer). */
export interface LoadBalancer {
  listBackends(context: ReleaseActionContext): Promise<readonly LoadBalancerBackend[]>;
  getBackend(nodeId: string, context: ReleaseActionContext): Promise<LoadBalancerBackend>;
  setWeight(nodeId: string, weight: number, context: ReleaseActionContext): Promise<void>;
  waitForDrain(nodeId: string, context: ReleaseActionContext): Promise<DrainResult>;
  publicSmoke(artifact: ReleaseArtifact, context: ReleaseActionContext): Promise<PublicSmokeResult>;
}

/**
 * Immutable receipt produced before opening the separately provisioned
 * maintenance canary traffic gate. The digest is calculated over every field
 * except itself, including the exact API inventory and the independently
 * authorized canary percentage. It is safe to persist; it contains no
 * credential or request-routing secret.
 */
export interface MaintenanceCanaryPlanReceipt {
  format: "fanjin-maintenance-canary-plan/v1";
  operationId: string;
  artifactSha256: string;
  productionListenerId: string;
  productionServerGroupId: string;
  canaryListenerId: string;
  trafficGateId: string;
  maintenanceServerGroupId: string;
  canaryServerGroupId: string;
  apiNodeIds: readonly string[];
  productionTargets: readonly Readonly<{ nodeId: string; serverId: string }>[];
  canaryTargets: readonly Readonly<{ nodeId: string; serverId: string }>[];
  /** Provider receipt extension: classic production group must remain all-zero. */
  productionBackendWeight?: 0;
  /** Provider receipt extension: protected maintenance share; open + canary = 100. */
  maintenanceTrafficWeightPercent?: number;
  trafficWeightPercent: number;
  /** Provider-enforced deadline that returns the dedicated gate to contained. */
  autoContainAfterMs: number;
  /**
   * Exact provider control-plane revision observed while the dedicated gate
   * was contained. The provider must compare-and-swap this revision when
   * opening traffic; a plan is invalid after any intervening gate mutation.
   */
  expectedContainedProviderRevision: string;
  authorizationSha256: string;
  planDigestSha256: string;
}

/**
 * Crash-recoverable observation of the dedicated maintenance canary gate.
 * `contained` means the gate routes zero traffic to the target fleet;
 * production backend weights remain a separate all-zero invariant until the
 * final restore.
 */
export interface MaintenanceCanaryTrafficReceipt {
  format: "fanjin-maintenance-canary-traffic/v1";
  operationId: string;
  artifactSha256: string;
  planDigestSha256: string;
  state: "open" | "contained";
  observedTrafficWeightPercent: number;
  /** Provider receipt extension emitted by the concrete dedicated traffic gate. */
  observedMaintenanceTrafficWeightPercent?: number;
  /** Provider-enforced deadline copied from the immutable plan. */
  autoContainAfterMs: number;
  productionBackendsAllZero: true;
  canaryListenerId: string;
  trafficGateId: string;
  maintenanceServerGroupId: string;
  canaryServerGroupId: string;
  apiNodeIds: readonly string[];
  /** Opaque non-secret cloud control-plane revision for durable evidence. */
  providerRevision: string;
}

export type FullMaintenanceListenerBarrierPhase =
  | "baseline"
  | "disabled"
  | "enabled"
  | "contained";

/**
 * Durable proof for the fixed production HTTP/HTTPS listener barrier. The
 * evidence digest covers every field except itself. A receipt never describes
 * a mixed state: callers may persist it only after two consecutive exact
 * provider readbacks agree on all-on or all-off.
 */
export interface FullMaintenanceListenerBarrierReceipt {
  format: "fanjin-full-maintenance-listener-barrier/v1";
  operationId: string;
  artifactSha256: string;
  loadBalancerId: string;
  /**
   * Exact production server group proven by both fixed listener readbacks.
   * Optional only for source compatibility with already persisted v1 test
   * fixtures; newly emitted provider receipts always include it.
   */
  serverGroupId?: string;
  httpListenerId: string;
  httpsListenerId: string;
  phase: FullMaintenanceListenerBarrierPhase;
  observedState: "all-on" | "all-off";
  listeners: readonly [
    Readonly<{
      protocol: "HTTP";
      listenerId: string;
      /** Present on every newly emitted provider receipt. */
      serverGroupId?: string;
      port: 80;
      enabled: boolean;
      status: "Active" | "Disabled";
    }>,
    Readonly<{
      protocol: "HTTPS";
      listenerId: string;
      /** Present on every newly emitted provider receipt. */
      serverGroupId?: string;
      port: 443;
      enabled: boolean;
      status: "Active" | "Disabled";
    }>,
  ];
  stableReadCount: 2;
  evidenceSha256: string;
}

/**
 * Durable proof that the exact restored production fleet became healthy only
 * after both fixed production listeners were stably re-enabled. Health is not
 * part of the all-off maintenance window because a disabled listener may
 * legitimately omit or retain stale listener-health rows.
 */
export interface FullMaintenanceBackendHealthReceipt {
  format: "fanjin-full-maintenance-backend-health/v1";
  operationId: string;
  artifactSha256: string;
  loadBalancerId: string;
  serverGroupId: string;
  httpListenerId: string;
  httpsListenerId: string;
  backends: readonly Readonly<{
    nodeId: string;
    weight: number;
    health: "up";
  }>[];
  listenerHealthSnapshots: readonly [
    Readonly<{
      protocol: "HTTP";
      listenerId: string;
      backends: readonly Readonly<{ nodeId: string; weight: number; health: "up" }>[];
    }>,
    Readonly<{
      protocol: "HTTPS";
      listenerId: string;
      backends: readonly Readonly<{ nodeId: string; weight: number; health: "up" }>[];
    }>,
  ];
  stableReadCount: 2;
  evidenceSha256: string;
}

/**
 * Health-independent proof of exact production server-group membership and
 * weights while the fixed listener barrier may be stopped.
 */
export interface FullMaintenanceBackendWeightReceipt {
  format: "fanjin-full-maintenance-backend-weight/v1";
  operationId: string;
  artifactSha256: string;
  loadBalancerId: string;
  serverGroupId: string;
  backendBindings: readonly Readonly<{
    nodeId: string;
    serverId: string;
    port: number;
    originalWeight: number;
  }>[];
  expectedState: "all-zero" | "original";
  backends: readonly Readonly<{ nodeId: string; weight: number }>[];
  stableReadCount: 2;
  evidenceSha256: string;
}

/**
 * Local, immutable bound for a cloud mutation accepted by a prior owner but
 * whose response or convergence proof was lost. The in-tree OpenAPI transport
 * performs no retries, so the retry budget is deliberately exact zero.
 */
export interface FullMaintenanceMutationUncertaintyReceipt {
  format: "fanjin-full-maintenance-mutation-uncertainty/v1";
  loadBalancerId: string;
  serverGroupId: string;
  backendBindings: readonly Readonly<{
    nodeId: string;
    serverId: string;
    port: number;
    originalWeight: number;
  }>[];
  targetCount: number;
  apiRequestTimeoutUpperBoundMs: number;
  requestRetryBudgetUpperBoundMs: 0;
  operationConvergenceUpperBoundMs: number;
  pollIntervalUpperBoundMs: number;
  sequentialApiCallSlots: number;
  convergenceWindowSlots: number;
  settleMs: number;
  evidenceSha256: string;
}

/**
 * Dedicated all-fleet maintenance boundary. Ordinary rolling code must keep
 * using `setWeight`, whose minimum-healthy guard deliberately refuses to
 * remove the final backend. These methods require the exact full inventory
 * and exact pre-recorded weights so an incompatible offline schema upgrade
 * cannot silently omit or invent an API target.
 */
export interface MaintenanceLoadBalancer extends LoadBalancer {
  /** Returns the adapter-derived, non-overridable prior-mutation settle bound. */
  fullMaintenanceMutationUncertainty?(): FullMaintenanceMutationUncertaintyReceipt;
  /**
   * Planned-outage traffic boundary. Unlike the legacy maintenance-canary
   * methods below, these operations never consult or mutate a canary gate.
   * They accept only the exact weighted baseline whose health was captured
   * while the fixed listener pair was still on.
   */
  fullMaintenanceDrainAll(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<void>;
  /**
   * Restores the exact recorded weights only from an all-zero fleet. The
   * validation receipt digest is a durable full-maintenance proof binding;
   * it is deliberately not interchangeable with a canary plan digest.
   */
  fullMaintenanceRestoreAll(
    expectedWeights: Readonly<Record<string, number>>,
    validationReceiptSha256: string,
    context: ReleaseActionContext,
  ): Promise<void>;
  /**
   * Fail-closed recovery after a restore request may have been accepted.
   * Every backend must be either zero or its exact recorded weight.
   */
  fullMaintenanceContainAll(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<void>;
  /**
   * Read-only, health-independent proof for the stopped-listener window.
   */
  fullMaintenanceInspectBackendWeights(
    expectedWeights: Readonly<Record<string, number>>,
    expectedState: "all-zero" | "original",
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceBackendWeightReceipt>;
  /** Proves the fixed production HTTP/HTTPS listener inventory is stably on. */
  fullMaintenanceInspectListenerBaseline(
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt>;
  /** Disables both fixed production listeners and proves a stable all-off state. */
  fullMaintenanceDisableListeners(
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt>;
  /**
   * Enables both listeners only from a stable all-off state. The caller must
   * first prove exact backend-weight restoration; any failure re-disables both.
   * Backend health is proven separately after both listeners are on/Active.
   */
  fullMaintenanceEnableListeners(
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt>;
  /**
   * After both listeners are stably on, proves two consecutive exact samples
   * of the restored backend weights and listener health.
   */
  fullMaintenanceVerifyEnabledBackendHealth(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceBackendHealthReceipt>;
  /** Idempotently forces and proves the fixed listener pair stably all-off. */
  fullMaintenanceContainListeners(
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt>;
  /** Legacy protected-canary boundary retained for v1 recovery only. */
  maintenanceDrainAll(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<void>;
  maintenanceRestoreAll(
    expectedWeights: Readonly<Record<string, number>>,
    canaryPlanDigestSha256: string,
    context: ReleaseActionContext,
  ): Promise<void>;
  /**
   * Fail-closed containment after restore has started. Each backend may be at
   * either its recorded weight or zero; every other value is treated as drift.
   */
  maintenanceContainAll(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<void>;
  /**
   * Proves the production inventory is exactly all-zero and the dedicated gate
   * is contained before recording a canary plan. `authorizationSha256` binds
   * the pre-authorized percentage without exposing the authorization itself.
   */
  maintenancePlanCanary(
    authorizationSha256: string,
    context: ReleaseActionContext,
  ): Promise<MaintenanceCanaryPlanReceipt>;
  /** Opens only the dedicated gate; ordinary backend `setWeight` is not used. */
  maintenanceOpenCanary(
    plan: Readonly<MaintenanceCanaryPlanReceipt>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceCanaryTrafficReceipt>;
  /** Re-inspects cloud state after restart using operation id + plan digest. */
  maintenanceObserveCanary(
    planDigestSha256: string,
    context: ReleaseActionContext,
  ): Promise<MaintenanceCanaryTrafficReceipt>;
  /** Idempotently returns the dedicated gate to zero traffic. */
  maintenanceContainCanary(
    planDigestSha256: string,
    context: ReleaseActionContext,
  ): Promise<MaintenanceCanaryTrafficReceipt>;
}

export interface NodePreflightResult {
  ok: boolean;
  currentArtifactSha256: string;
  /**
   * SHA-256 over the effective, non-secret Redis runtime configuration
   * reported by this API node's fixed release agent from the application's
   * shared environment. The Controller treats an absent value as unsafe so
   * older Node Agents fail closed.
   */
  redisRuntimeFingerprint?: string;
  runtimeCapabilities?: readonly string[];
  redisRateLimitCutover?: RedisRateLimitCutoverAttestation | null;
  redisRateLimitCutoverMarker?: RedisRateLimitCutoverMarker | null;
  code?: string;
}

/**
 * Exact release pointer reported by the fixed Node Agent status action.
 *
 * Unlike `NodePreflightResult`, this read deliberately does not depend on the
 * application's HTTP readiness state. A node is expected to report
 * `readiness.ready=false` while it is intentionally draining immediately
 * before activation, but its immutable release identity must remain readable.
 */
export interface NodeCurrentReleaseIdentity {
  nodeId: string;
  releaseId: string;
  artifactSha256: string;
  schemaMode: ReleaseSchemaMode | null;
  schemaVersion: number | null;
  deploymentMode?: ReleaseDeploymentMode;
  imageDigest?: string | null;
}

export interface RedisRateLimitCutoverAttestation {
  valid: boolean;
  state: "unarmed" | "scheduled" | "active" | null;
  active: boolean;
  contractMatched: boolean | null;
  cutoverAtMs: number | null;
  scheduledAtRedisMs: number | null;
  activatedAtRedisMs: number | null;
  redisServerTimeMs: number | null;
  errorCode: string | null;
}

export interface RedisRateLimitCutoverMarker {
  format: "fanjin-redis-rate-limit-cutover/v1";
  cutoverAtMs: number;
  redisRuntimeFingerprint: string;
}

export interface RedisRateLimitScheduleGuard {
  format: "fanjin-redis-rate-limit-schedule-guard/v1";
  cutoverAtMs: number;
  redisRuntimeFingerprint: string;
}

export interface WorkerRedisCutoverObservation {
  nodeId: string;
  currentArtifactSha256: string;
  runtimeCapabilities: readonly string[];
  redisRuntimeFingerprint: string;
  marker: RedisRateLimitCutoverMarker;
}

export interface RedisScheduleGuardObservation {
  nodeId: string;
  currentArtifactSha256: string;
  runtimeCapabilities: readonly string[];
  redisRuntimeFingerprint: string;
  guard: RedisRateLimitScheduleGuard;
}

export interface StageResult {
  artifactSha256: string;
  deploymentMode?: ReleaseDeploymentMode;
  imageDigest?: string | null;
}

export interface ReleaseSchemaMigrationRequest {
  /** Stable idempotency/evidence identity for this immutable release operation. */
  runId: string;
  fromVersion: number;
  toVersion: number;
  artifactSha256: string;
}

export interface ReleaseSchemaMigrationObservation {
  /** Last version proven by the immutable migration ledger. */
  schemaVersion: number;
  /** Highest migration version known by the target release controller. */
  latestVersion: number;
  /** Terminal evidence belongs to this run only; null means no matching run. */
  runId: string | null;
  runStatus: "started" | "succeeded" | "failed" | null;
}

/**
 * Privileged database migration boundary. Implementations must use the same
 * durable runId for runner evidence and must not return succeeded until an
 * independent ledger read proves the target version.
 */
export interface ReleaseSchemaMigrator {
  inspect(
    request: ReleaseSchemaMigrationRequest,
    context: ReleaseActionContext,
  ): Promise<ReleaseSchemaMigrationObservation>;
  apply(
    request: ReleaseSchemaMigrationRequest,
    context: ReleaseActionContext,
  ): Promise<ReleaseSchemaMigrationObservation>;
}

export interface ReleaseNodeConfigurationObservation {
  artifactSha256: string;
  deploymentMode?: ReleaseDeploymentMode;
  imageDigest?: string | null;
  /** Source/schema are read from the node's verified release descriptor. */
  sourceCommit?: string;
  schemaVersion?: number;
  /** SHA-256 over the effective non-secret Agent surface configuration. */
  agentSurfaceFingerprint?: string;
}

export interface DirectReadinessResult extends ReleaseNodeConfigurationObservation {
  ready: boolean;
  code?: string;
}

export type ReleaseConfigurationVerificationStage =
  | "preflight"
  | "api-direct"
  | "api-post-bake"
  | "api-final"
  | "worker-artifact"
  | "worker-final";

export interface ReleaseConfigurationVerificationResult {
  /** Stable identity of release + DB expectation + Agent + semantic contract. */
  fingerprint: string;
}

/**
 * Read-only boundary for the production configuration contract. Implementations
 * must never repair drift. A mismatch rejects the rollout and lets the normal
 * Controller rollback/isolation choreography contain already-activated nodes.
 */
export interface ReleaseConfigurationVerifier {
  verify(
    artifact: ReleaseArtifact,
    input: Readonly<{
      stage: ReleaseConfigurationVerificationStage;
      nodeId?: string;
      observation?: ReleaseNodeConfigurationObservation;
    }>,
    context: ReleaseActionContext,
  ): Promise<ReleaseConfigurationVerificationResult>;
}

export interface NodeDrainStatus {
  draining: boolean;
  httpInflight: number;
  sseConnections: number;
  socketIoConnections: number;
  realtimeWsConnections: number;
  totalConnections: number;
}

/** Adapter for a privileged, mutually-authenticated agent on each API node. */
export interface NodeAgent {
  preflight(
    nodeId: string,
    artifact: ReleaseArtifact,
    schemaMode: ReleaseSchemaMode,
    context: ReleaseActionContext,
    policy?: Readonly<NodePreflightPolicy>,
  ): Promise<NodePreflightResult>;
  currentIdentity(
    nodeId: string,
    context: ReleaseActionContext,
  ): Promise<NodeCurrentReleaseIdentity>;
  /** Required whenever the release Controller is configured to arm Redis. */
  armRedisCutoverSchedule?(
    nodeId: string,
    expected: RedisRateLimitScheduleGuard,
    context: ReleaseActionContext,
  ): Promise<RedisScheduleGuardObservation>;
  /** Required to persist the marker after the Controller proves central state. */
  observeRedisCutover?(
    nodeId: string,
    expected: RedisRateLimitCutoverMarker,
    context: ReleaseActionContext,
  ): Promise<WorkerRedisCutoverObservation>;
  stage(nodeId: string, artifact: ReleaseArtifact, context: ReleaseActionContext): Promise<StageResult>;
  beginDrain(
    nodeId: string,
    expectedCurrentArtifactSha256: string,
    context: ReleaseActionContext,
  ): Promise<NodeDrainStatus>;
  drainStatus(
    nodeId: string,
    expectedCurrentArtifactSha256: string,
    context: ReleaseActionContext,
  ): Promise<NodeDrainStatus>;
  cancelDrain(
    nodeId: string,
    expectedCurrentArtifactSha256: string,
    context: ReleaseActionContext,
  ): Promise<NodeDrainStatus>;
  activate(nodeId: string, artifact: ReleaseArtifact, context: ReleaseActionContext): Promise<void>;
  directReadiness(nodeId: string, context: ReleaseActionContext): Promise<DirectReadinessResult>;
  rollback(
    nodeId: string,
    previousArtifactSha256: string,
    context: ReleaseActionContext,
  ): Promise<void>;
}

export type MaintenanceNodeRole = "api" | "worker";
export type MaintenanceNodeState =
  | "quiescing"
  | "quiesced"
  | "activation-attempted"
  | "consumed";

/**
 * Immutable, pre-authorized identity sent to the fixed Node Agent maintenance
 * protocol.  It intentionally contains no credential, rollback target, or
 * process-manager command supplied by the caller.
 */
export interface MaintenanceNodeActivationBinding {
  nodeId: string;
  role: MaintenanceNodeRole;
  expectedCurrentReleaseId: string;
  expectedCurrentArtifactSha256: string;
  targetReleaseId: string;
  targetArtifactSha256: string;
  targetSourceCommit: string;
  targetSchemaVersion: number;
  targetDeploymentMode: ReleaseDeploymentMode;
  targetImageDigest: string | null;
}

export interface MaintenanceNodeReceiptSummary {
  format: "fanjin-node-maintenance-activation/v1";
  operationId: string;
  nodeId: string;
  role: MaintenanceNodeRole;
  state: MaintenanceNodeState;
  expectedCurrentReleaseId: string;
  expectedCurrentArtifactSha256: string;
  targetReleaseId: string;
  targetArtifactSha256: string;
  targetSchemaVersion: number;
  targetDeploymentMode: ReleaseDeploymentMode;
  targetImageDigest: string | null;
  bindingSha256: string;
}

export interface MaintenanceNodeQuiesceResult {
  idempotent: boolean;
  processStopped: true;
  maintenance: MaintenanceNodeReceiptSummary & {
    state: "quiesced" | "activation-attempted";
  };
}

export interface MaintenanceNodeActivationResult {
  idempotent: boolean;
  recovered: boolean;
  maintenance: MaintenanceNodeReceiptSummary & { state: "consumed" };
  /** Exact target identity proven by the role-specific readiness response. */
  readiness: ({
    ready: true;
    role: "api";
    releaseId: string;
    artifactSha256: string;
    sourceCommit: string;
    schemaVersion: number;
    deploymentMode: ReleaseDeploymentMode;
    imageDigest: string | null;
  } | {
    ready: true;
    role: "worker";
    isolated: true;
    acceptingWork: false;
    activeTaskCount: 0;
    drainOperationId: string;
    releaseId: string;
    artifactSha256: string;
    sourceCommit: string;
    schemaVersion: number;
    deploymentMode: ReleaseDeploymentMode;
    imageDigest: string | null;
  });
}

/**
 * Read-only, contract-bound observation used by crash recovery.  A stopped
 * process is a valid containment fact and deliberately does not require
 * application readiness or a fresh Worker heartbeat.
 */
export interface MaintenanceNodeObservation {
  processStopped: boolean;
  /** Null means no authority exists yet; only an exact previous current is safe. */
  maintenance: MaintenanceNodeReceiptSummary | null;
  current: NodeCurrentReleaseIdentity;
}

export interface MaintenanceNodeContainResult {
  idempotent: boolean;
  processStopped: true;
  maintenance: MaintenanceNodeReceiptSummary;
  current: NodeCurrentReleaseIdentity;
}

/**
 * Dedicated one-way maintenance boundary for an incompatible schema jump.
 * There is deliberately no rollback method: after activation authority is
 * advanced, only exact target recovery/readiness can establish success.
 */
export interface MaintenanceNodeAgent {
  observeMaintenance?(
    binding: Readonly<MaintenanceNodeActivationBinding>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceNodeObservation>;
  maintenanceContain?(
    binding: Readonly<MaintenanceNodeActivationBinding>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceNodeContainResult>;
  maintenanceQuiesce(
    binding: Readonly<MaintenanceNodeActivationBinding>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceNodeQuiesceResult>;
  activateMaintenance(
    binding: Readonly<MaintenanceNodeActivationBinding>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceNodeActivationResult>;
}

export interface WorkerRuntimeSnapshot {
  nodeId: string;
  healthy: boolean;
  acceptingWork: boolean;
  activeTaskCount: number;
  artifactSha256: string;
  /** @deprecated Database column compatibility alias; never artifact target. */
  schemaVersion: number;
  /** Version independently read from the database migration ledger. */
  observedDatabaseSchemaVersion: number;
  /**
   * Artifact target is recoverable from an armed fence. While isolated it is
   * intentionally null: the signed artifact SHA remains the source of truth.
   */
  targetSchemaVersion: number | null;
  schemaRuntimeMode: "normal" | "migration-bridge" | "isolated";
  bridgeOperationId: string | null;
  bridgeCompatibilityProofSha256: string | null;
  heartbeatAt: number;
  drainOperationId: string | null;
}

export interface WorkerSchemaExpectation {
  artifactSha256: string;
  targetSchemaVersion: number;
  observedDatabaseSchemaVersion: number;
  runtimeMode: "normal" | "migration-bridge" | "isolated";
  migration?: {
    fromVersion: number;
    toVersion: number;
    compatibilityProofSha256: string;
  };
}

/**
 * Database-backed worker control plane. A returned promise is a durable
 * acknowledgement, not a best-effort process signal.
 */
export interface WorkerControlPlane {
  listWorkers(context: ReleaseActionContext): Promise<readonly WorkerRuntimeSnapshot[]>;
  assertHealthyCapacity(
    excludedNodeId: string,
    minimumHealthy: number,
    context: ReleaseActionContext,
  ): Promise<void>;
  requestDrain(nodeId: string, context: ReleaseActionContext): Promise<void>;
  waitForDrained(nodeId: string, context: ReleaseActionContext): Promise<WorkerRuntimeSnapshot>;
  waitForArtifact(
    nodeId: string,
    expectation: WorkerSchemaExpectation,
    context: ReleaseActionContext,
  ): Promise<WorkerRuntimeSnapshot>;
  authorizeSchemaBridge(
    nodeId: string,
    expectation: WorkerSchemaExpectation,
    context: ReleaseActionContext,
  ): Promise<void>;
  resume(nodeId: string, context: ReleaseActionContext): Promise<void>;
  waitForServing(
    nodeId: string,
    expectation: WorkerSchemaExpectation,
    context: ReleaseActionContext,
  ): Promise<WorkerRuntimeSnapshot>;
}

export interface WorkerActivationResult {
  artifactSha256: string;
  deploymentMode?: ReleaseDeploymentMode;
  imageDigest?: string | null;
  sourceCommit?: string;
  targetSchemaVersion: number;
  schemaMode: ReleaseSchemaMode;
  schemaCompatibilityProofSha256: string;
  agentSurfaceFingerprint?: string;
}

/**
 * Worker activation deliberately has no HTTP readiness method. The exact
 * post-activation identity is proven by WorkerControlPlane DB heartbeats.
 */
export interface WorkerNodeAgent {
  stage(nodeId: string, artifact: ReleaseArtifact, context: ReleaseActionContext): Promise<StageResult>;
  activate(
    nodeId: string,
    artifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<WorkerActivationResult>;
  /** Read-only exact node config identity used after resume and before smoke. */
  configurationIdentity?(
    nodeId: string,
    context: ReleaseActionContext,
  ): Promise<ReleaseNodeConfigurationObservation>;
  /** Required whenever the release Controller is configured to arm Redis. */
  armRedisCutoverSchedule?(
    nodeId: string,
    expected: RedisRateLimitScheduleGuard,
    context: ReleaseActionContext,
  ): Promise<RedisScheduleGuardObservation>;
  observeRedisCutover(
    nodeId: string,
    expected: RedisRateLimitCutoverMarker,
    context: ReleaseActionContext,
  ): Promise<WorkerRedisCutoverObservation>;
  rollback(
    nodeId: string,
    previousArtifactSha256: string,
    targetArtifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<void>;
}

export interface SafeReleaseError {
  code: string;
  message: string;
  phase: ReleasePhase;
  nodeId: string | null;
  at: number;
}

export type ReleaseEventType =
  | "operation.started"
  | "preflight.completed"
  | "stage.completed"
  | "schema-migration.started"
  | "schema-migration.completed"
  | "node.others-healthy"
  | "node.weight-zero"
  | "node.drained"
  | "node.activated"
  | "node.direct-ready"
  | "node.weight-restored"
  | "node.clb-up"
  | "node.baked"
  | "node.completed"
  | "worker.capacity-confirmed"
  | "worker.drain-requested"
  | "worker.drained"
  | "worker.activated"
  | "worker.artifact-ready"
  | "worker.resumed"
  | "worker.completed"
  | "public-smoke.completed"
  | "redis-cutover.scheduled"
  | "rollback.started"
  | "rollback.completed"
  | "rollback.failed"
  | "operation.succeeded"
  | "operation.failed";

export interface ReleaseEvent {
  sequence: number;
  operationId: string;
  type: ReleaseEventType;
  phase: ReleasePhase;
  nodeId: string | null;
  at: number;
  /** Only controller-authored, non-secret scalar observations are allowed. */
  observations?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ReleaseNodeCheckpoint {
  nodeId: string;
  originalWeight: number;
  previousArtifactSha256: string;
  preflightComplete: boolean;
  staged: boolean;
  othersHealthyConfirmed: boolean;
  weightZeroAttempted: boolean;
  weightZero: boolean;
  drainStarted: boolean;
  drained: boolean;
  activationAttempted: boolean;
  activated: boolean;
  directReady: boolean;
  weightRestored: boolean;
  clbUpConfirmationCount: number;
  baked: boolean;
  completed: boolean;
  isolated: boolean;
  rolledBack: boolean;
  rollbackVerified: boolean;
}

export interface ReleaseWorkerCheckpoint {
  nodeId: string;
  previousArtifactSha256: string;
  preflightComplete: boolean;
  staged: boolean;
  capacityConfirmed: boolean;
  drainRequested: boolean;
  drained: boolean;
  activationAttempted: boolean;
  activated: boolean;
  artifactReady: boolean;
  bridgeAuthorized?: boolean;
  bridgeFinalized?: boolean;
  resumed: boolean;
  serving: boolean;
  completed: boolean;
  isolated: boolean;
  rolledBack: boolean;
  rollbackVerified: boolean;
}

export interface ReleaseCheckpoint {
  operationId: string;
  status: ReleaseOperationStatus;
  phase: ReleasePhase;
  artifact: ReleaseArtifact;
  previousArtifact?: ReleaseArtifact;
  schemaMode: ReleaseSchemaMode;
  schemaCompatibility?: ReleaseSchemaCompatibilityBridgeV1 | null;
  nodeOrder: string[];
  nodes: Record<string, ReleaseNodeCheckpoint>;
  /** Immutable semantic configuration identity proven during this operation. */
  releaseConfigFingerprint?: string;
  /** Last Redis runtime fingerprint proven identical across every API node. */
  redisRuntimeFingerprint?: string;
  /** Point-of-no-return guard: a schedule call may have committed before an I/O error. */
  redisCutoverScheduleAttempted?: boolean;
  /** True only after the central latch and every node marker were re-attested. */
  redisCutoverScheduled?: boolean;
  redisCutoverState?: "unarmed" | "scheduled" | "active";
  redisCutoverAtMs?: number | null;
  workerOrder: string[];
  workers: Record<string, ReleaseWorkerCheckpoint>;
  preflightComplete: boolean;
  stageComplete: boolean;
  workerPreflightComplete: boolean;
  workerStageComplete: boolean;
  workerRollingComplete: boolean;
  /** Stable migration evidence identity; null for schema-neutral releases. */
  schemaMigrationRunId?: string | null;
  /** Durable point of no automatic binary rollback. */
  schemaMigrationAttempted?: boolean;
  /** Set only after target ledger + matching succeeded evidence are re-read. */
  schemaMigrationComplete?: boolean;
  publicSmokeComplete: boolean;
  currentNodeId: string | null;
  error: SafeReleaseError | null;
  manualInterventionRequired: boolean;
  events: ReleaseEvent[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Persistence is optimistic. Implementations must reject save when
 * expectedRevision is stale and return the newly persisted snapshot.
 */
export interface ReleaseStore {
  get(operationId: string): Promise<ReleaseCheckpoint | null>;
  create(checkpoint: ReleaseCheckpoint): Promise<ReleaseCheckpoint>;
  save(checkpoint: ReleaseCheckpoint, expectedRevision: number): Promise<ReleaseCheckpoint>;
}

export interface ReleaseClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export type ReleaseObserver = (checkpoint: Readonly<ReleaseCheckpoint>) => void | Promise<void>;

/**
 * Durable cancellation must use this guard, never the best-effort observer.
 * The controller supplies a clone so the guard cannot mutate live state.
 */
export type ReleaseCancellationGuard = (
  checkpoint: Readonly<ReleaseCheckpoint>,
) => boolean | Promise<boolean>;

export interface ReleaseControllerDependencies {
  loadBalancer: LoadBalancer;
  nodeAgent: NodeAgent;
  workerControlPlane?: WorkerControlPlane;
  workerNodeAgent?: WorkerNodeAgent;
  schemaMigrator?: ReleaseSchemaMigrator;
  releaseConfigurationVerifier?: ReleaseConfigurationVerifier;
  store: ReleaseStore;
  redisCutoverCoordinator?: RedisCutoverCoordinator;
  clock?: ReleaseClock;
  policy?: Partial<RollingPolicy>;
  observer?: ReleaseObserver;
  shouldCancel?: ReleaseCancellationGuard;
}
