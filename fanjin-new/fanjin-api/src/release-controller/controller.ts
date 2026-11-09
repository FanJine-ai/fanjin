import {
  ReleaseControllerError,
  ReleaseHandoffRequestedError,
  ReleaseInvariantError,
  redactReleaseErrorMessage,
} from "./errors";
import type {
  LoadBalancerBackend,
  ReleaseActionContext,
  ReleaseCheckpoint,
  ReleaseClock,
  ReleaseControllerDependencies,
  ReleaseEventType,
  ReleaseNodeCheckpoint,
  ReleasePhase,
  ReleasePlan,
  RollingPolicy,
  SafeReleaseError,
  WorkerRuntimeSnapshot,
  ReleaseWorkerCheckpoint,
  NodePreflightResult,
  RedisRateLimitScheduleGuard,
  RedisScheduleGuardObservation,
  RedisRateLimitCutoverMarker,
  ReleaseSchemaMigrationRequest,
  WorkerSchemaExpectation,
  ReleaseConfigurationVerificationStage,
  ReleaseNodeConfigurationObservation,
} from "./types";
import {
  REDIS_CUTOVER_FINAL_SCHEDULE_LEAD_MS,
  type RedisCutoverCoordinatorInspection,
} from "./redisCutoverCoordinator";
import {
  exactReleaseSchemaCompatibility,
  releaseSchemaCompatibilityProofSha256,
  releaseSchemaCompatibilityError,
} from "./schemaCompatibility";
import {
  assertReleaseSchemaCompatibilityBridge,
  expectedPreviousSchemaVersion,
} from "@/lib/releaseSchemaCompatibility";

const REDIS_RATE_LIMIT_CAPABILITY = "redis-rate-limit-v1";
const RUNTIME_CAPABILITY_RE =
  /^(?=.{1,64}$)[a-z][a-z0-9-]*(?:[._][a-z0-9][a-z0-9-]*)*$/;
const REDIS_TIME_SAMPLE_MAX_SPAN_MS = 30_000;

const DEFAULT_POLICY: RollingPolicy = {
  clbUpConfirmations: 3,
  clbPollIntervalMs: 2_000,
  drainTimeoutMs: 310_000,
  drainPollIntervalMs: 1_000,
  bakeTimeMs: 30_000,
};

const systemClock: ReleaseClock = {
  now: () => Date.now(),
  sleep: async (milliseconds) => {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function scalarCode(value: unknown, fallback: string): string {
  const normalized = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9_-]{1,64}$/.test(normalized) ? normalized : fallback;
}

function requireRedisRuntimeFingerprint(value: unknown, nodeId: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseInvariantError(
      "REDIS_RUNTIME_FINGERPRINT_MISSING",
      `节点 ${nodeId} 未提供 Redis 运行时配置指纹`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ReleaseInvariantError(
      "REDIS_RUNTIME_FINGERPRINT_INVALID",
      `节点 ${nodeId} 返回的 Redis 运行时配置指纹无效`,
    );
  }
  return value;
}

function requireRuntimeCapabilities(value: unknown, nodeId: string): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ReleaseInvariantError(
      "RUNTIME_CAPABILITIES_MISSING",
      `节点 ${nodeId} 未提供可信运行时能力清单`,
    );
  }
  const capabilities = value.map((entry) => {
    if (typeof entry !== "string" || !RUNTIME_CAPABILITY_RE.test(entry)) {
      throw new ReleaseInvariantError(
        "RUNTIME_CAPABILITIES_INVALID",
        `节点 ${nodeId} 返回的运行时能力清单无效`,
      );
    }
    return entry;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new ReleaseInvariantError(
      "RUNTIME_CAPABILITIES_INVALID",
      `节点 ${nodeId} 返回了重复的运行时能力`,
    );
  }
  return [...capabilities].sort();
}

function assertNonEmpty(value: string, code: string, label: string): void {
  if (!value.trim()) throw new ReleaseInvariantError(code, `${label}不能为空`);
}

function checkpointNode(nodeId: string, backend: LoadBalancerBackend): ReleaseNodeCheckpoint {
  return {
    nodeId,
    originalWeight: backend.weight,
    previousArtifactSha256: "",
    preflightComplete: false,
    staged: false,
    othersHealthyConfirmed: false,
    weightZeroAttempted: false,
    weightZero: false,
    drainStarted: false,
    drained: false,
    activationAttempted: false,
    activated: false,
    directReady: false,
    weightRestored: false,
    clbUpConfirmationCount: 0,
    baked: false,
    completed: false,
    isolated: false,
    rolledBack: false,
    rollbackVerified: false,
  };
}

function checkpointWorker(nodeId: string): ReleaseWorkerCheckpoint {
  return {
    nodeId,
    previousArtifactSha256: "",
    preflightComplete: false,
    staged: false,
    capacityConfirmed: false,
    drainRequested: false,
    drained: false,
    activationAttempted: false,
    activated: false,
    artifactReady: false,
    bridgeAuthorized: false,
    bridgeFinalized: false,
    resumed: false,
    serving: false,
    completed: false,
    isolated: false,
    rolledBack: false,
    rollbackVerified: false,
  };
}

/**
 * Pure orchestration core. All I/O is behind adapters, and every side effect
 * receives a stable actionId so a resumed checkpoint can safely retry it.
 */
export class RollingReleaseController {
  private readonly loadBalancer: ReleaseControllerDependencies["loadBalancer"];
  private readonly nodeAgent: ReleaseControllerDependencies["nodeAgent"];
  private readonly workerControlPlane: ReleaseControllerDependencies["workerControlPlane"];
  private readonly workerNodeAgent: ReleaseControllerDependencies["workerNodeAgent"];
  private readonly schemaMigrator: ReleaseControllerDependencies["schemaMigrator"];
  private readonly releaseConfigurationVerifier:
    ReleaseControllerDependencies["releaseConfigurationVerifier"];
  private readonly store: ReleaseControllerDependencies["store"];
  private readonly redisCutoverCoordinator: ReleaseControllerDependencies["redisCutoverCoordinator"];
  private readonly clock: ReleaseClock;
  private readonly policy: RollingPolicy;
  private readonly observer: ReleaseControllerDependencies["observer"];
  private readonly shouldCancel: ReleaseControllerDependencies["shouldCancel"];

  constructor(dependencies: ReleaseControllerDependencies) {
    this.loadBalancer = dependencies.loadBalancer;
    this.nodeAgent = dependencies.nodeAgent;
    this.workerControlPlane = dependencies.workerControlPlane;
    this.workerNodeAgent = dependencies.workerNodeAgent;
    this.schemaMigrator = dependencies.schemaMigrator;
    this.releaseConfigurationVerifier = dependencies.releaseConfigurationVerifier;
    this.store = dependencies.store;
    this.redisCutoverCoordinator = dependencies.redisCutoverCoordinator;
    this.clock = dependencies.clock || systemClock;
    this.observer = dependencies.observer;
    this.shouldCancel = dependencies.shouldCancel;
    this.policy = {
      ...DEFAULT_POLICY,
      ...dependencies.policy,
      clbUpConfirmations: Math.max(2, Math.floor(
        dependencies.policy?.clbUpConfirmations ?? DEFAULT_POLICY.clbUpConfirmations,
      )),
      clbPollIntervalMs: Math.max(0, Math.floor(
        dependencies.policy?.clbPollIntervalMs ?? DEFAULT_POLICY.clbPollIntervalMs,
      )),
      drainTimeoutMs: Math.max(1, Math.floor(
        dependencies.policy?.drainTimeoutMs ?? DEFAULT_POLICY.drainTimeoutMs,
      )),
      drainPollIntervalMs: Math.max(0, Math.floor(
        dependencies.policy?.drainPollIntervalMs ?? DEFAULT_POLICY.drainPollIntervalMs,
      )),
      bakeTimeMs: Math.max(0, Math.floor(
        dependencies.policy?.bakeTimeMs ?? DEFAULT_POLICY.bakeTimeMs,
      )),
    };
  }

  async getOperation(operationId: string): Promise<ReleaseCheckpoint | null> {
    const checkpoint = await this.store.get(operationId);
    return checkpoint ? clone(checkpoint) : null;
  }

  /** Start a new operation or resume an existing running checkpoint. */
  async execute(plan: ReleasePlan): Promise<ReleaseCheckpoint> {
    this.validatePlan(plan);
    let checkpoint = await this.store.get(plan.operationId);

    if (checkpoint) {
      this.ensureWorkerCheckpointShape(checkpoint);
      this.assertSameOperation(checkpoint, plan);
      this.assertCheckpointConsistent(checkpoint);
      if (checkpoint.status === "succeeded") return clone(checkpoint);
      if (checkpoint.status === "failed") {
        throw new ReleaseControllerError(checkpoint.error || {
          code: "RELEASE_PREVIOUSLY_FAILED",
          message: "发布操作已经失败，需创建新的 operation id 重试",
          phase: "failed",
          nodeId: checkpoint.currentNodeId,
          at: checkpoint.updatedAt,
        });
      }
    } else {
      checkpoint = await this.createCheckpoint(plan);
    }

    try {
      await this.runPreflight(checkpoint, plan);
      await this.stageAll(checkpoint);
      // A crash/lease loss can occur after the migration transaction commits
      // but before its response is durably reflected in the checkpoint. On
      // takeover, reconcile the immutable run evidence before touching a
      // Worker whose heartbeat may already observe toVersion.
      if (
        checkpoint.schemaMode === "migration"
        && checkpoint.schemaMigrationAttempted
        && !checkpoint.schemaMigrationComplete
      ) {
        await this.runSchemaMigration(checkpoint);
      }
      // Establish one target-version Worker as a compatibility bridge, then
      // move the complete API fleet while both old and target Worker versions
      // are still serving. Only after every API is on the target version may
      // the remaining Workers move. This preserves at least one exact
      // API/Worker release pair throughout the rollout.
      if (
        checkpoint.schemaMode === "schema-neutral"
        || !checkpoint.schemaMigrationComplete
      ) {
        await this.rollWorkerBridge(checkpoint, plan);
        await this.authorizePreviousWorkerBridges(checkpoint);
        await this.runSchemaMigration(checkpoint);
      }
      if (checkpoint.schemaMode === "migration" && checkpoint.schemaMigrationComplete) {
        // A prior controller may have contained the target bridge after an
        // ambiguous apply response. Once the same immutable run is proven
        // committed, restore that already-activated Worker before moving APIs
        // or draining any N-1 peer.
        await this.rollWorkerBridge(checkpoint, plan);
      }
      await this.rollAllNodes(checkpoint);
      await this.rollAllWorkers(checkpoint, plan);
      await this.finalizeTargetWorkerBridge(checkpoint);
      await this.verifyAllWorkersServing(checkpoint);
      await this.verifyFinalTopology(checkpoint);
      await this.runPublicSmoke(checkpoint);
      await this.scheduleRedisCutover(checkpoint);
      checkpoint.phase = "success";
      checkpoint.status = "succeeded";
      checkpoint.currentNodeId = null;
      checkpoint.error = null;
      await this.record(checkpoint, "operation.succeeded");
      return clone(checkpoint);
    } catch (error) {
      if (error instanceof ReleaseHandoffRequestedError) throw error;
      return this.fail(checkpoint, error);
    }
  }

  /** Alias that reads naturally at adapter call sites. */
  async run(plan: ReleasePlan): Promise<ReleaseCheckpoint> {
    return this.execute(plan);
  }

  private validatePlan(plan: ReleasePlan): void {
    assertNonEmpty(plan.operationId, "INVALID_OPERATION_ID", "operation id");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(plan.operationId)) {
      throw new ReleaseInvariantError("INVALID_OPERATION_ID", "operation id 格式无效");
    }
    assertNonEmpty(plan.artifact.id, "INVALID_ARTIFACT_ID", "artifact id");
    if (
      plan.artifact.releaseId !== undefined
      && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(plan.artifact.releaseId)
    ) {
      throw new ReleaseInvariantError(
        "INVALID_RELEASE_ID",
        "artifact releaseId 格式无效",
      );
    }
    assertNonEmpty(plan.artifact.version, "INVALID_ARTIFACT_VERSION", "artifact version");
    assertNonEmpty(plan.artifact.sha256, "INVALID_ARTIFACT_SHA", "artifact sha256");
    if (/\s/.test(plan.artifact.sha256)) {
      throw new ReleaseInvariantError("INVALID_ARTIFACT_SHA", "artifact sha256 格式无效");
    }
    if (
      plan.artifact.sourceCommit !== undefined
      && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(plan.artifact.sourceCommit)
    ) {
      throw new ReleaseInvariantError(
        "INVALID_ARTIFACT_SOURCE_COMMIT",
        "artifact sourceCommit 格式无效",
      );
    }
    if (!Number.isSafeInteger(plan.artifact.schemaVersion) || plan.artifact.schemaVersion < 0) {
      throw new ReleaseInvariantError("INVALID_SCHEMA_VERSION", "artifact schemaVersion 格式无效");
    }
    if (!Number.isSafeInteger(plan.artifact.workerProtocolVersion)
      || plan.artifact.workerProtocolVersion < 1
      || plan.artifact.workerProtocolVersion > 2_147_483_647) {
      throw new ReleaseInvariantError(
        "INVALID_WORKER_PROTOCOL_VERSION",
        "artifact workerProtocolVersion 格式无效",
      );
    }
    if (plan.artifact.runtimeCapabilities !== undefined) {
      requireRuntimeCapabilities(plan.artifact.runtimeCapabilities, "目标制品");
    }
    if (
      this.redisCutoverCoordinator
      && !plan.artifact.runtimeCapabilities?.includes(REDIS_RATE_LIMIT_CAPABILITY)
    ) {
      throw new ReleaseInvariantError(
        "TARGET_RUNTIME_CAPABILITY_MISSING",
        `目标制品未声明 ${REDIS_RATE_LIMIT_CAPABILITY}，禁止进入 Redis 发布链路`,
      );
    }
    if (plan.schemaMode !== "schema-neutral" && plan.schemaMode !== "migration") {
      throw new ReleaseInvariantError("INVALID_SCHEMA_MODE", "未知的 schema mode");
    }
    if (plan.schemaMode === "migration") {
      throw new ReleaseInvariantError(
        "RELEASE_MIGRATION_MODE_RETIRED_V007",
        "v0.0.7 已退役单次 migration-mode；必须使用独立受审 expand 流程",
      );
    }
    if (plan.artifact.schemaMode && plan.artifact.schemaMode !== plan.schemaMode) {
      throw new ReleaseInvariantError(
        "ARTIFACT_SCHEMA_MODE_MISMATCH",
        "artifact schemaMode 与发布计划不一致",
      );
    }
    const schemaCompatibility = plan.artifact.schemaCompatibility
      ?? (plan.schemaMode === "schema-neutral"
        ? exactReleaseSchemaCompatibility(plan.artifact.schemaVersion)
        : null);
    const schemaCompatibilityError = releaseSchemaCompatibilityError(
      plan.schemaMode,
      plan.artifact.schemaVersion,
      schemaCompatibility,
    );
    if (schemaCompatibilityError) {
      throw new ReleaseInvariantError(
        "ARTIFACT_SCHEMA_COMPATIBILITY_INVALID",
        schemaCompatibilityError,
      );
    }
    if (plan.schemaCompatibility) {
      try {
        assertReleaseSchemaCompatibilityBridge(plan.schemaCompatibility);
        expectedPreviousSchemaVersion({
          targetSchemaVersion: plan.artifact.schemaVersion,
          targetArtifactSha256: plan.artifact.sha256,
          bridge: plan.schemaCompatibility,
        });
        if (
          (
            plan.artifact.releaseId
            && plan.artifact.releaseId
              !== plan.schemaCompatibility.target.releaseId
          )
          ||
          plan.previousArtifact
          && (
            (plan.previousArtifact.releaseId ?? plan.previousArtifact.version)
              !== plan.schemaCompatibility.previous.releaseId
            || plan.previousArtifact.sha256
              !== plan.schemaCompatibility.previous.artifactSha256
            || plan.previousArtifact.schemaVersion
              !== plan.schemaCompatibility.previous.schemaVersion
          )
        ) {
          throw new Error("previous artifact identity mismatch");
        }
      } catch {
        throw new ReleaseInvariantError(
          "INVALID_SCHEMA_COMPATIBILITY_BRIDGE",
          "schema compatibility bridge 无效或与目标制品不匹配",
        );
      }
    }
    if (plan.nodeIds && new Set(plan.nodeIds).size !== plan.nodeIds.length) {
      throw new ReleaseInvariantError("DUPLICATE_NODE", "发布节点不能重复");
    }
    if (plan.apiNodeIds && new Set(plan.apiNodeIds).size !== plan.apiNodeIds.length) {
      throw new ReleaseInvariantError("DUPLICATE_NODE", "API 发布节点不能重复");
    }
    if (plan.nodeIds && plan.apiNodeIds
      && [...plan.nodeIds].join("\0") !== [...plan.apiNodeIds].join("\0")) {
      throw new ReleaseInvariantError("API_NODE_ORDER_CONFLICT", "nodeIds 与 apiNodeIds 不一致");
    }
    if (plan.workerNodeIds && new Set(plan.workerNodeIds).size !== plan.workerNodeIds.length) {
      throw new ReleaseInvariantError("DUPLICATE_WORKER", "Worker 发布节点不能重复");
    }
    if (plan.workerNodeIds?.some((nodeId) => (plan.apiNodeIds || plan.nodeIds || []).includes(nodeId))) {
      throw new ReleaseInvariantError("NODE_ROLE_CONFLICT", "同一节点不能同时作为 API 和 Worker 目标");
    }
    if (plan.workerNodeIds?.length) {
      if (plan.workerNodeIds.length < 2) {
        throw new ReleaseInvariantError("INSUFFICIENT_WORKER_CAPACITY", "无感发布至少需要两个 Worker 节点");
      }
      if (!this.workerControlPlane || !this.workerNodeAgent) {
        throw new ReleaseInvariantError("WORKER_RELEASE_UNSUPPORTED", "Worker 发布控制面未配置");
      }
      const minimum = plan.minHealthyWorkers ?? plan.workerNodeIds.length - 1;
      if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum >= plan.workerNodeIds.length) {
        throw new ReleaseInvariantError("INVALID_MIN_HEALTHY_WORKERS", "Worker 最小健康容量配置无效");
      }
    }
  }

  private assertSameOperation(checkpoint: ReleaseCheckpoint, plan: ReleasePlan): void {
    const same = checkpoint.operationId === plan.operationId
      && checkpoint.artifact.id === plan.artifact.id
      && checkpoint.artifact.releaseId === plan.artifact.releaseId
      && checkpoint.artifact.version === plan.artifact.version
      && checkpoint.artifact.sha256 === plan.artifact.sha256
      && checkpoint.artifact.sourceCommit === plan.artifact.sourceCommit
      && checkpoint.artifact.schemaVersion === plan.artifact.schemaVersion
      && checkpoint.artifact.workerProtocolVersion === plan.artifact.workerProtocolVersion
      && JSON.stringify([...(checkpoint.artifact.runtimeCapabilities || [])].sort())
        === JSON.stringify([...(plan.artifact.runtimeCapabilities || [])].sort())
      && checkpoint.artifact.schemaMode === plan.artifact.schemaMode
      && JSON.stringify(checkpoint.artifact.schemaCompatibility)
        === JSON.stringify(plan.artifact.schemaCompatibility)
      && JSON.stringify(checkpoint.previousArtifact ?? null)
        === JSON.stringify(plan.previousArtifact ?? null)
      && JSON.stringify(checkpoint.schemaCompatibility ?? null)
        === JSON.stringify(plan.schemaCompatibility ?? null)
      && checkpoint.schemaMode === plan.schemaMode;
    if (!same) {
      throw new ReleaseInvariantError(
        "OPERATION_ID_REUSED",
        "operation id 已绑定其他不可变发布参数",
      );
    }
    const apiNodeIds = plan.apiNodeIds || plan.nodeIds;
    if (apiNodeIds && checkpoint.nodeOrder.length > 0) {
      if (checkpoint.nodeOrder.join("\0") !== [...apiNodeIds].join("\0")) {
        throw new ReleaseInvariantError("OPERATION_NODE_ORDER_CHANGED", "断点恢复时节点顺序不可变");
      }
    }
    if (checkpoint.workerOrder.join("\0") !== [...(plan.workerNodeIds || [])].join("\0")) {
      throw new ReleaseInvariantError("OPERATION_WORKER_ORDER_CHANGED", "断点恢复时 Worker 节点顺序不可变");
    }
  }

  private ensureWorkerCheckpointShape(checkpoint: ReleaseCheckpoint): void {
    // Checkpoints created before worker orchestration shipped are safe to
    // resume only as API-only operations. Missing fields are normalized to an
    // explicit empty worker phase; a worker plan still fails identity checks.
    checkpoint.workerOrder ??= [];
    checkpoint.workers ??= {};
    checkpoint.workerPreflightComplete ??= checkpoint.workerOrder.length === 0;
    checkpoint.workerStageComplete ??= checkpoint.workerOrder.length === 0;
    checkpoint.workerRollingComplete ??= checkpoint.workerOrder.length === 0;
    checkpoint.schemaMigrationRunId ??= checkpoint.schemaMode === "migration"
      ? checkpoint.operationId
      : null;
    checkpoint.schemaMigrationAttempted ??= false;
    checkpoint.schemaMigrationComplete ??= checkpoint.schemaMode === "schema-neutral";
    checkpoint.redisCutoverScheduleAttempted ??= false;
    checkpoint.redisCutoverScheduled ??= false;
    checkpoint.redisCutoverState ??= "unarmed";
    checkpoint.redisCutoverAtMs ??= null;
    for (const worker of Object.values(checkpoint.workers)) {
      worker.bridgeAuthorized ??= false;
      worker.bridgeFinalized ??= false;
    }
    for (const node of Object.values(checkpoint.nodes || {})) {
      if (typeof node.drainStarted !== "boolean") {
        if (node.drained && (node.activationAttempted || node.activated)) node.drainStarted = true;
        else {
          node.drainStarted = false;
          // A legacy checkpoint's `drained` bit represented only a fixed CLB
          // grace wait. Force a real application drain before activation.
          node.drained = false;
        }
      }
    }
  }

  private assertCheckpointConsistent(checkpoint: ReleaseCheckpoint): void {
    if (
      checkpoint.releaseConfigFingerprint !== undefined
      && !/^[a-f0-9]{64}$/u.test(checkpoint.releaseConfigFingerprint)
    ) {
      throw new ReleaseInvariantError(
        "CHECKPOINT_CORRUPT",
        "发布断点的配置合同指纹无效",
      );
    }
    const uniqueNodeIds = new Set(checkpoint.nodeOrder);
    if (uniqueNodeIds.size !== checkpoint.nodeOrder.length) {
      throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点包含重复节点");
    }
    if (checkpoint.preflightComplete && checkpoint.nodeOrder.length < 2) {
      throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点缺少滚动容量");
    }
    for (const nodeId of checkpoint.nodeOrder) {
      const node = checkpoint.nodes[nodeId];
      if (!node || node.nodeId !== nodeId) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点节点数据不完整");
      }
      if (node.activated && (!node.activationAttempted || !node.drained)) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点违反激活顺序");
      }
      if (node.drained && !node.drainStarted) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点缺少应用排空确认");
      }
      if (checkpoint.preflightComplete && !node.previousArtifactSha256) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点缺少旧版本身份");
      }
      if (node.directReady && !node.activated) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点违反就绪顺序");
      }
      if (node.weightRestored && !node.directReady && !node.rollbackVerified) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点违反回挂顺序");
      }
      if (node.completed && (!node.baked || !node.weightRestored)) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点违反完成顺序");
      }
      if (checkpoint.stageComplete && !node.staged) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "发布断点的暂存状态不完整");
      }
    }
    if (checkpoint.preflightComplete) {
      const baselines = new Set(
        checkpoint.nodeOrder.map((nodeId) => checkpoint.nodes[nodeId].previousArtifactSha256),
      );
      if (baselines.size !== 1) {
        throw new ReleaseInvariantError("MIXED_API_BASELINE", "API 节点当前版本不一致，禁止滚动发布");
      }
    }
    if (checkpoint.redisCutoverScheduled) {
      if (
        (checkpoint.redisCutoverState !== "scheduled" && checkpoint.redisCutoverState !== "active")
        || !Number.isSafeInteger(checkpoint.redisCutoverAtMs)
        || (checkpoint.redisCutoverAtMs ?? 0) < 1
      ) {
        throw new ReleaseInvariantError(
          "CHECKPOINT_CORRUPT",
          "发布断点中的 Redis 切换确认状态不完整",
        );
      }
    }
    if (checkpoint.schemaMode === "schema-neutral") {
      if (
        checkpoint.schemaMigrationRunId !== null
        || checkpoint.schemaMigrationAttempted
        || !checkpoint.schemaMigrationComplete
      ) {
        throw new ReleaseInvariantError(
          "CHECKPOINT_CORRUPT",
          "schema-neutral 发布断点包含非法迁移状态",
        );
      }
    } else if (
      checkpoint.schemaMigrationRunId !== checkpoint.operationId
      || (checkpoint.schemaMigrationComplete && !checkpoint.schemaMigrationAttempted)
      || (checkpoint.schemaMigrationAttempted && !checkpoint.stageComplete)
    ) {
      throw new ReleaseInvariantError(
        "CHECKPOINT_CORRUPT",
        "migration-mode 发布断点的迁移证据状态不完整",
      );
    }
    for (const nodeId of checkpoint.workerOrder) {
      const worker = checkpoint.workers[nodeId];
      if (!worker || worker.nodeId !== nodeId) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "Worker 发布断点数据不完整");
      }
      if (worker.drained && !worker.drainRequested) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "Worker 发布断点违反排空顺序");
      }
      if (worker.activated && (!worker.activationAttempted || !worker.drained)) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "Worker 发布断点违反激活顺序");
      }
      if (worker.artifactReady && !worker.activated) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "Worker 发布断点违反版本验活顺序");
      }
      if (worker.completed && (!worker.serving || !worker.resumed)) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "Worker 发布断点违反恢复服务顺序");
      }
      if (checkpoint.workerStageComplete && !worker.staged) {
        throw new ReleaseInvariantError("CHECKPOINT_CORRUPT", "Worker 暂存状态不完整");
      }
    }
    if (
      checkpoint.schemaMode === "migration"
      && checkpoint.schemaMigrationAttempted
      && checkpoint.workerOrder.some(
        (nodeId) => !checkpoint.workers[nodeId]?.bridgeAuthorized,
      )
    ) {
      throw new ReleaseInvariantError(
        "CHECKPOINT_CORRUPT",
        "迁移已开始但 Worker 兼容桥 fence 证明不完整",
      );
    }
  }

  private async createCheckpoint(plan: ReleasePlan): Promise<ReleaseCheckpoint> {
    const now = this.clock.now();
    const checkpoint: ReleaseCheckpoint = {
      operationId: plan.operationId,
      status: "running",
      phase: "preflight",
      artifact: clone(plan.artifact),
      previousArtifact: plan.previousArtifact
        ? clone(plan.previousArtifact)
        : undefined,
      schemaMode: plan.schemaMode,
      ...(plan.schemaCompatibility
        ? { schemaCompatibility: clone(plan.schemaCompatibility) }
        : {}),
      nodeOrder: [],
      nodes: {},
      redisRuntimeFingerprint: "",
      redisCutoverScheduleAttempted: false,
      redisCutoverScheduled: false,
      redisCutoverState: "unarmed",
      redisCutoverAtMs: null,
      workerOrder: [...(plan.workerNodeIds || [])],
      workers: Object.fromEntries((plan.workerNodeIds || []).map((nodeId) => [nodeId, checkpointWorker(nodeId)])),
      preflightComplete: false,
      stageComplete: false,
      workerPreflightComplete: (plan.workerNodeIds?.length || 0) === 0,
      workerStageComplete: (plan.workerNodeIds?.length || 0) === 0,
      workerRollingComplete: (plan.workerNodeIds?.length || 0) === 0,
      schemaMigrationRunId: plan.schemaMode === "migration" ? plan.operationId : null,
      schemaMigrationAttempted: false,
      schemaMigrationComplete: plan.schemaMode === "schema-neutral",
      publicSmokeComplete: false,
      currentNodeId: null,
      error: null,
      manualInterventionRequired: false,
      events: [{
        sequence: 1,
        operationId: plan.operationId,
        type: "operation.started",
        phase: "preflight",
        nodeId: null,
        at: now,
      }],
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const created = await this.store.create(clone(checkpoint));
      await this.notify(created);
      return clone(created);
    } catch (error) {
      // A concurrent request may have won create with the same idempotency key.
      const existing = await this.store.get(plan.operationId);
      if (existing) {
        this.assertSameOperation(existing, plan);
        return clone(existing);
      }
      throw error;
    }
  }

  private context(checkpoint: ReleaseCheckpoint, actionId: string): ReleaseActionContext {
    return {
      operationId: checkpoint.operationId,
      actionId,
      artifactSha256: checkpoint.artifact.sha256,
    };
  }

  private async verifyReleaseConfiguration(
    checkpoint: ReleaseCheckpoint,
    stage: ReleaseConfigurationVerificationStage,
    nodeId?: string,
    observation?: ReleaseNodeConfigurationObservation,
  ): Promise<void> {
    if (!this.releaseConfigurationVerifier) return;
    let result;
    try {
      result = await this.releaseConfigurationVerifier.verify(
        checkpoint.artifact,
        { stage, ...(nodeId ? { nodeId } : {}), ...(observation ? { observation } : {}) },
        this.context(
          checkpoint,
          `config:${stage}${nodeId ? `:${nodeId}` : ""}`,
        ),
      );
    } catch (error) {
      throw new ReleaseInvariantError(
        scalarCode(
          (error as { code?: unknown } | null)?.code,
          "RELEASE_CONFIG_VERIFICATION_FAILED",
        ),
        nodeId
          ? `节点 ${nodeId} 发布配置合同验证失败`
          : "发布配置合同验证失败",
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(result.fingerprint)) {
      throw new ReleaseInvariantError(
        "RELEASE_CONFIG_FINGERPRINT_INVALID",
        "发布配置合同未返回有效指纹",
      );
    }
    if (
      checkpoint.releaseConfigFingerprint
      && checkpoint.releaseConfigFingerprint !== result.fingerprint
    ) {
      throw new ReleaseInvariantError(
        "RELEASE_CONFIG_FINGERPRINT_DRIFT",
        "发布配置合同与持久化断点不一致",
      );
    }
    if (!checkpoint.releaseConfigFingerprint) {
      checkpoint.releaseConfigFingerprint = result.fingerprint;
      await this.persist(checkpoint);
    }
  }

  private async changePhase(checkpoint: ReleaseCheckpoint, phase: ReleasePhase): Promise<void> {
    if (checkpoint.phase === phase) return;
    checkpoint.phase = phase;
    await this.persist(checkpoint);
  }

  private async runPreflight(checkpoint: ReleaseCheckpoint, plan: ReleasePlan): Promise<void> {
    // A Controller restart must re-sample every live API node before it can
    // continue toward any traffic mutation. A previously persisted digest is
    // useful evidence, but is not a substitute for current fleet agreement.
    await this.changePhase(checkpoint, "preflight");
    await this.checkCancellation(checkpoint);
    // Re-read the exact production snapshot before any CLB/SSH mutation, even
    // when this is a resumed checkpoint created by an older Controller.
    await this.verifyReleaseConfiguration(checkpoint, "preflight");
    if (checkpoint.preflightComplete) {
      await this.verifyRedisRuntimeFingerprintFleet(checkpoint);
      if (checkpoint.workerPreflightComplete) return;
    }

    if (!checkpoint.preflightComplete && checkpoint.nodeOrder.length === 0) {
      const backends = await this.loadBalancer.listBackends(
        this.context(checkpoint, "preflight:list-backends"),
      );
      const byId = new Map(backends.map((backend) => [backend.nodeId, backend]));
      const configuredApiNodes = plan.apiNodeIds || plan.nodeIds;
      const nodeOrder = configuredApiNodes ? [...configuredApiNodes] : backends.map((backend) => backend.nodeId);

      if (nodeOrder.length < 2) {
        throw new ReleaseInvariantError(
          "INSUFFICIENT_HEALTHY_CAPACITY",
          "无感滚动发布至少需要两个负载均衡节点",
        );
      }
      if (byId.size !== backends.length || new Set(nodeOrder).size !== nodeOrder.length) {
        throw new ReleaseInvariantError("DUPLICATE_NODE", "负载均衡返回了重复节点");
      }
      if (nodeOrder.length !== backends.length || nodeOrder.some((nodeId) => !byId.has(nodeId))) {
        throw new ReleaseInvariantError(
          "BACKEND_SET_MISMATCH",
          "发布节点必须与当前负载均衡后端集合完全一致",
        );
      }

      for (const nodeId of nodeOrder) {
        const backend = byId.get(nodeId)!;
        if (backend.health !== "up" || !Number.isFinite(backend.weight) || backend.weight <= 0) {
          throw new ReleaseInvariantError(
            "BACKEND_NOT_HEALTHY",
            `节点 ${nodeId} 未处于可承载流量状态`,
          );
        }
        checkpoint.nodes[nodeId] = checkpointNode(nodeId, backend);
      }
      checkpoint.nodeOrder = nodeOrder;
      await this.persist(checkpoint);
      await this.checkCancellation(checkpoint);
    }

    if (!checkpoint.preflightComplete) {
      const redisRuntimeFingerprints = new Set<string>();
      for (const nodeId of checkpoint.nodeOrder) {
        const node = checkpoint.nodes[nodeId];
        await this.checkCancellation(checkpoint);
        const result = await this.nodeAgent.preflight(
          nodeId,
          checkpoint.artifact,
          checkpoint.schemaMode,
          this.context(checkpoint, `preflight:${nodeId}`),
        );
        if (!result.ok || !result.currentArtifactSha256.trim()) {
          const code = scalarCode(result.code, "NODE_PREFLIGHT_REJECTED");
          throw new ReleaseInvariantError(code, `节点 ${nodeId} 预检未通过`);
        }
        redisRuntimeFingerprints.add(requireRedisRuntimeFingerprint(
          result.redisRuntimeFingerprint,
          nodeId,
        ));
        node.previousArtifactSha256 = result.currentArtifactSha256;
        node.preflightComplete = true;
        await this.persist(checkpoint);
        await this.checkCancellation(checkpoint);
      }

      const baselines = new Set(
        checkpoint.nodeOrder.map((nodeId) => checkpoint.nodes[nodeId].previousArtifactSha256),
      );
      if (baselines.size !== 1) {
        throw new ReleaseInvariantError("MIXED_API_BASELINE", "API 节点当前版本不一致，禁止滚动发布");
      }
      if (redisRuntimeFingerprints.size !== 1) {
        throw new ReleaseInvariantError(
          "REDIS_RUNTIME_FINGERPRINT_MISMATCH",
          "API 节点 Redis 运行时配置不一致，禁止滚动发布",
        );
      }

      checkpoint.redisRuntimeFingerprint = [...redisRuntimeFingerprints][0];
      checkpoint.preflightComplete = true;
      await this.record(checkpoint, "preflight.completed", null, {
        nodeCount: checkpoint.nodeOrder.length,
        schemaNeutral: checkpoint.schemaMode === "schema-neutral",
      });
      await this.verifyRedisRuntimeFingerprintFleet(checkpoint);
    }
    await this.preflightWorkers(checkpoint, plan);
    await this.checkCancellation(checkpoint);
  }

  private async inspectRedisCutoverCentral(): Promise<RedisCutoverCoordinatorInspection> {
    if (!this.redisCutoverCoordinator) {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_COORDINATOR_MISSING",
        "Redis 切换控制面未配置",
      );
    }
    try {
      return await this.redisCutoverCoordinator.inspect();
    } catch (error) {
      throw new ReleaseInvariantError(
        scalarCode((error as { code?: unknown } | null)?.code, "REDIS_CUTOVER_INSPECTION_FAILED"),
        "Redis 中央切换状态不可用或与发布合同不一致",
      );
    }
  }

  private assertNodeRedisCutoverAttestation(
    checkpoint: ReleaseCheckpoint,
    nodeId: string,
    result: NodePreflightResult,
    inspection: RedisCutoverCoordinatorInspection,
    samplingWindow: {
      beforeRedisTimeMs: number;
      afterRedisTimeMs: number;
    },
  ): void {
    const central = inspection.centralState;
    const marker = result.redisRateLimitCutoverMarker ?? null;
    const capabilities = result.runtimeCapabilities === undefined
      ? null
      : requireRuntimeCapabilities(result.runtimeCapabilities, nodeId);
    const capable = capabilities?.includes(REDIS_RATE_LIMIT_CAPABILITY) === true;
    const attestation = result.redisRateLimitCutover ?? null;

    if (central.state === "unarmed") {
      if (marker !== null) {
        throw new ReleaseInvariantError(
          "REDIS_CUTOVER_MARKER_PREMATURE",
          `节点 ${nodeId} 在中央切换未调度时已存在不可逆 marker`,
        );
      }
      // During the capability-first rollout, old nodes legitimately know
      // nothing about the latch. Every target/current capable binary must,
      // however, prove the explicit unarmed state before it can carry traffic.
      if (result.currentArtifactSha256 === checkpoint.artifact.sha256 && !capable) {
        throw new ReleaseInvariantError(
          "TARGET_RUNTIME_CAPABILITY_MISSING",
          `节点 ${nodeId} 的目标运行时未声明 ${REDIS_RATE_LIMIT_CAPABILITY}`,
        );
      }
      if (capable || attestation !== null) {
        if (
          !capable
          || attestation === null
          || !attestation.valid
          || attestation.state !== "unarmed"
          || attestation.active
          || attestation.contractMatched !== null
          || attestation.cutoverAtMs !== null
          || attestation.scheduledAtRedisMs !== null
          || attestation.activatedAtRedisMs !== null
          || attestation.errorCode !== null
        ) {
          throw new ReleaseInvariantError(
            "REDIS_CUTOVER_NODE_STATE_MISMATCH",
            `节点 ${nodeId} 未证明中央 Redis 切换仍处于 unarmed`,
          );
        }
      }
      return;
    }

    if (!capable) {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_NODE_CAPABILITY_MISSING",
        `节点 ${nodeId} 缺少不可逆切换所需的 ${REDIS_RATE_LIMIT_CAPABILITY}`,
      );
    }
    if (
      attestation === null
      || !attestation.valid
      || attestation.state !== central.state
      || attestation.active !== (central.state === "active")
      || attestation.contractMatched !== true
      || attestation.cutoverAtMs !== central.cutoverAtMs
      || attestation.scheduledAtRedisMs !== central.scheduledAtRedisMs
      || attestation.activatedAtRedisMs !== central.activatedAtRedisMs
      || attestation.redisServerTimeMs === null
      || attestation.redisServerTimeMs
        < samplingWindow.beforeRedisTimeMs - REDIS_TIME_SAMPLE_MAX_SPAN_MS
      || attestation.redisServerTimeMs
        > samplingWindow.afterRedisTimeMs + REDIS_TIME_SAMPLE_MAX_SPAN_MS
      || attestation.errorCode !== null
    ) {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_NODE_STATE_MISMATCH",
        `节点 ${nodeId} 的 Redis 切换证明与中央状态不一致`,
      );
    }
    if (
      marker === null
      || marker.format !== "fanjin-redis-rate-limit-cutover/v1"
      || marker.cutoverAtMs !== central.cutoverAtMs
      || marker.redisRuntimeFingerprint !== inspection.expected.contractFingerprint
    ) {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_MARKER_MISMATCH",
        `节点 ${nodeId} 未持久化匹配的不可逆 Redis 切换 marker`,
      );
    }
  }

  private sameRedisCutoverInspection(
    left: RedisCutoverCoordinatorInspection,
    right: RedisCutoverCoordinatorInspection,
  ): boolean {
    return left.centralState.state === right.centralState.state
      && left.centralState.contractFingerprint === right.centralState.contractFingerprint
      && left.centralState.cutoverAtMs === right.centralState.cutoverAtMs
      && left.centralState.scheduledAtRedisMs === right.centralState.scheduledAtRedisMs
      && left.centralState.activatedAtRedisMs === right.centralState.activatedAtRedisMs
      && left.expected.contractFingerprint === right.expected.contractFingerprint
      && left.expected.cutoverAtMs === right.expected.cutoverAtMs;
  }

  private async observeRedisCutoverWorkers(
    checkpoint: ReleaseCheckpoint,
    inspection: RedisCutoverCoordinatorInspection,
    attempt: number,
  ): Promise<void> {
    if (inspection.centralState.state === "unarmed" || checkpoint.workerOrder.length === 0) {
      return;
    }
    const cutoverAtMs = inspection.centralState.cutoverAtMs;
    if (!Number.isSafeInteger(cutoverAtMs) || (cutoverAtMs ?? 0) < 1) {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_WORKER_CONTRACT_INVALID",
        "Redis 中央切换状态缺少有效的 Worker marker 时间边界",
      );
    }
    const expected = {
      format: "fanjin-redis-rate-limit-cutover/v1" as const,
      cutoverAtMs: cutoverAtMs!,
      redisRuntimeFingerprint: inspection.expected.contractFingerprint,
    };
    const workerAgent = this.requireWorkerNodeAgent();
    for (const nodeId of checkpoint.workerOrder) {
      await this.checkCancellation(checkpoint);
      const observed = await workerAgent.observeRedisCutover(
        nodeId,
        expected,
        this.context(checkpoint, `worker:${nodeId}:redis-cutover-observe:${attempt}`),
      );
      const worker = checkpoint.workers[nodeId];
      const expectedCurrentSha = worker?.activated || worker?.artifactReady || worker?.completed
        ? checkpoint.artifact.sha256
        : worker?.preflightComplete
          ? worker.previousArtifactSha256
          : null;
      const currentShaMatches = expectedCurrentSha === null
        || observed.currentArtifactSha256 === expectedCurrentSha
        || Boolean(
          worker?.activationAttempted
          && observed.currentArtifactSha256 === checkpoint.artifact.sha256,
        );
      if (
        observed.nodeId !== nodeId
        || !currentShaMatches
        || observed.redisRuntimeFingerprint !== expected.redisRuntimeFingerprint
        || !observed.runtimeCapabilities.includes(REDIS_RATE_LIMIT_CAPABILITY)
        || observed.marker.format !== expected.format
        || observed.marker.cutoverAtMs !== expected.cutoverAtMs
        || observed.marker.redisRuntimeFingerprint !== expected.redisRuntimeFingerprint
      ) {
        throw new ReleaseInvariantError(
          "REDIS_CUTOVER_WORKER_MARKER_MISMATCH",
          `Worker ${nodeId} 未持久化匹配的不可逆 Redis 切换 marker`,
        );
      }
    }
  }

  private async observeRedisCutoverApis(
    checkpoint: ReleaseCheckpoint,
    inspection: RedisCutoverCoordinatorInspection,
    attempt: number,
  ): Promise<Map<string, RedisRateLimitCutoverMarker>> {
    const markers = new Map<string, RedisRateLimitCutoverMarker>();
    if (inspection.centralState.state === "unarmed") return markers;
    const observe = this.nodeAgent.observeRedisCutover;
    if (typeof observe !== "function") {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_API_OBSERVER_MISSING",
        "API 节点代理缺少 Redis marker 观察能力",
      );
    }
    const expected: RedisRateLimitCutoverMarker = {
      format: "fanjin-redis-rate-limit-cutover/v1",
      cutoverAtMs: inspection.centralState.cutoverAtMs,
      redisRuntimeFingerprint: inspection.expected.contractFingerprint,
    };
    for (const nodeId of checkpoint.nodeOrder) {
      await this.checkCancellation(checkpoint);
      const observed = await observe.call(
        this.nodeAgent,
        nodeId,
        expected,
        this.context(checkpoint, `api:${nodeId}:redis-cutover-observe:${attempt}`),
      );
      const node = checkpoint.nodes[nodeId];
      const expectedCurrentSha = node?.activated || node?.directReady || node?.completed
        ? checkpoint.artifact.sha256
        : node?.preflightComplete
          ? node.previousArtifactSha256
          : null;
      const currentShaMatches = expectedCurrentSha === null
        || observed.currentArtifactSha256 === expectedCurrentSha
        || Boolean(
          node?.activationAttempted
          && observed.currentArtifactSha256 === checkpoint.artifact.sha256,
        );
      if (
        observed.nodeId !== nodeId
        || !currentShaMatches
        || observed.redisRuntimeFingerprint !== expected.redisRuntimeFingerprint
        || !observed.runtimeCapabilities.includes(REDIS_RATE_LIMIT_CAPABILITY)
        || observed.marker.format !== expected.format
        || observed.marker.cutoverAtMs !== expected.cutoverAtMs
        || observed.marker.redisRuntimeFingerprint !== expected.redisRuntimeFingerprint
      ) {
        throw new ReleaseInvariantError(
          "REDIS_CUTOVER_API_MARKER_MISMATCH",
          `API 节点 ${nodeId} 未持久化匹配的不可逆 Redis 切换 marker`,
        );
      }
      markers.set(nodeId, observed.marker);
    }
    return markers;
  }

  private assertRedisScheduleGuardObservation(
    checkpoint: ReleaseCheckpoint,
    expected: RedisRateLimitScheduleGuard,
    nodeId: string,
    observation: RedisScheduleGuardObservation,
  ): void {
    if (
      observation.nodeId !== nodeId
      || observation.currentArtifactSha256 !== checkpoint.artifact.sha256
      || observation.redisRuntimeFingerprint !== expected.redisRuntimeFingerprint
      || !observation.runtimeCapabilities.includes(REDIS_RATE_LIMIT_CAPABILITY)
      || observation.guard.format !== expected.format
      || observation.guard.cutoverAtMs !== expected.cutoverAtMs
      || observation.guard.redisRuntimeFingerprint !== expected.redisRuntimeFingerprint
    ) {
      throw new ReleaseInvariantError(
        "REDIS_SCHEDULE_GUARD_ATTESTATION_MISMATCH",
        `节点 ${nodeId} 未持久化匹配的 Redis 调度降级保护`,
      );
    }
  }

  private async armRedisCutoverScheduleFleet(
    checkpoint: ReleaseCheckpoint,
    inspection: RedisCutoverCoordinatorInspection,
  ): Promise<void> {
    const expected: RedisRateLimitScheduleGuard = {
      format: "fanjin-redis-rate-limit-schedule-guard/v1",
      cutoverAtMs: inspection.expected.cutoverAtMs,
      redisRuntimeFingerprint: inspection.expected.contractFingerprint,
    };
    const apiArm = this.nodeAgent.armRedisCutoverSchedule;
    if (typeof apiArm !== "function") {
      throw new ReleaseInvariantError(
        "REDIS_SCHEDULE_GUARD_AGENT_MISSING",
        "API 节点代理缺少 Redis 调度降级保护能力",
      );
    }
    for (const nodeId of checkpoint.nodeOrder) {
      await this.checkCancellation(checkpoint);
      const observation = await apiArm.call(
        this.nodeAgent,
        nodeId,
        expected,
        this.context(checkpoint, `api:${nodeId}:redis-schedule-guard`),
      );
      this.assertRedisScheduleGuardObservation(checkpoint, expected, nodeId, observation);
    }

    if (checkpoint.workerOrder.length === 0) return;
    const workerAgent = this.requireWorkerNodeAgent();
    const workerArm = workerAgent.armRedisCutoverSchedule;
    if (typeof workerArm !== "function") {
      throw new ReleaseInvariantError(
        "REDIS_SCHEDULE_GUARD_AGENT_MISSING",
        "Worker 节点代理缺少 Redis 调度降级保护能力",
      );
    }
    for (const nodeId of checkpoint.workerOrder) {
      await this.checkCancellation(checkpoint);
      const observation = await workerArm.call(
        workerAgent,
        nodeId,
        expected,
        this.context(checkpoint, `worker:${nodeId}:redis-schedule-guard`),
      );
      this.assertRedisScheduleGuardObservation(checkpoint, expected, nodeId, observation);
    }
  }

  private async verifyRedisRuntimeFingerprintFleet(
    checkpoint: ReleaseCheckpoint,
  ): Promise<RedisCutoverCoordinatorInspection | null> {
    const attempts = this.redisCutoverCoordinator ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const before = this.redisCutoverCoordinator
        ? await this.inspectRedisCutoverCentral()
        : null;
      const fingerprints = new Set<string>();
      const observations: Array<{ nodeId: string; result: NodePreflightResult }> = [];
      for (const nodeId of checkpoint.nodeOrder) {
        await this.checkCancellation(checkpoint);
        const result = await this.nodeAgent.preflight(
          nodeId,
          checkpoint.artifact,
          checkpoint.schemaMode,
          this.context(
            checkpoint,
            attempt === 1
              ? `preflight:${nodeId}:redis-runtime`
              : `preflight:${nodeId}:redis-runtime:retry`,
          ),
          {
            allowTargetCurrent: Boolean(
              checkpoint.nodes[nodeId]?.activationAttempted
              || checkpoint.nodes[nodeId]?.activated
              || checkpoint.nodes[nodeId]?.directReady
              || checkpoint.nodes[nodeId]?.completed
            ),
          },
        );
        if (!result.ok || !result.currentArtifactSha256.trim()) {
          const code = scalarCode(result.code, "NODE_PREFLIGHT_REJECTED");
          throw new ReleaseInvariantError(code, `节点 ${nodeId} Redis 运行时预检未通过`);
        }
        fingerprints.add(requireRedisRuntimeFingerprint(result.redisRuntimeFingerprint, nodeId));
        observations.push({ nodeId, result });
      }
      if (before) {
        const apiMarkers = await this.observeRedisCutoverApis(checkpoint, before, attempt);
        await this.observeRedisCutoverWorkers(checkpoint, before, attempt);
        for (const observation of observations) {
          const explicitMarker = apiMarkers.get(observation.nodeId);
          if (explicitMarker) {
            observation.result.redisRateLimitCutoverMarker = explicitMarker;
          }
        }
      }
      if (fingerprints.size !== 1) {
        throw new ReleaseInvariantError(
          "REDIS_RUNTIME_FINGERPRINT_MISMATCH",
          "API 节点 Redis 运行时配置不一致，禁止滚动发布",
        );
      }
      const observedFingerprint = [...fingerprints][0];
      const persistedFingerprint = checkpoint.redisRuntimeFingerprint;
      if (persistedFingerprint) {
        if (!/^[0-9a-f]{64}$/.test(persistedFingerprint)) {
          throw new ReleaseInvariantError(
            "REDIS_RUNTIME_FINGERPRINT_INVALID",
            "发布断点中的 Redis 运行时配置指纹无效",
          );
        }
        if (persistedFingerprint !== observedFingerprint) {
          throw new ReleaseInvariantError(
            "REDIS_RUNTIME_FINGERPRINT_CHANGED",
            "API 节点 Redis 运行时配置已偏离发布预检快照，禁止继续滚动发布",
          );
        }
      }

      const after = this.redisCutoverCoordinator
        ? await this.inspectRedisCutoverCentral()
        : null;
      // A scheduled latch can become active while the fleet is sampled. Retry
      // once against the stable, one-way state so every node proves one view.
      if (before && after && !this.sameRedisCutoverInspection(before, after)) {
        if (attempt < attempts) continue;
        throw new ReleaseInvariantError(
          "REDIS_CUTOVER_STATE_CHANGED_DURING_ATTESTATION",
          "Redis 中央切换状态在节点采样期间发生变化",
        );
      }
      if (after) {
        if (
          !before
          || after.redisTimeMs < before.redisTimeMs
        ) {
          throw new ReleaseInvariantError(
            "REDIS_CUTOVER_TIME_REGRESSED",
            "Redis 中央时间在节点采样期间发生倒退",
          );
        }
        if (after.expected.contractFingerprint !== observedFingerprint) {
          throw new ReleaseInvariantError(
            "REDIS_CUTOVER_CONTRACT_FINGERPRINT_MISMATCH",
            "API 节点 Redis 配置与中央切换合同不一致",
          );
        }
        for (const observation of observations) {
          this.assertNodeRedisCutoverAttestation(
            checkpoint,
            observation.nodeId,
            observation.result,
            after,
            {
              beforeRedisTimeMs: before.redisTimeMs,
              afterRedisTimeMs: after.redisTimeMs,
            },
          );
        }
        checkpoint.redisCutoverState = after.centralState.state;
        checkpoint.redisCutoverAtMs = after.centralState.cutoverAtMs;
        checkpoint.redisCutoverScheduled = after.centralState.state !== "unarmed";
      }
      checkpoint.redisRuntimeFingerprint = observedFingerprint;
      await this.persist(checkpoint);
      await this.checkCancellation(checkpoint);
      return after;
    }
    throw new ReleaseInvariantError(
      "REDIS_CUTOVER_ATTESTATION_FAILED",
      "Redis 节点切换证明无法收敛",
    );
  }

  private async preflightWorkers(checkpoint: ReleaseCheckpoint, plan: ReleasePlan): Promise<void> {
    if (checkpoint.workerPreflightComplete) return;
    const workerControl = this.requireWorkerControl();
    const expectedOrder = [...(plan.workerNodeIds || [])];
    if (checkpoint.workerOrder.join("\0") !== expectedOrder.join("\0")) {
      throw new ReleaseInvariantError("WORKER_INVENTORY_CHANGED", "Worker 受信清单与断点不一致");
    }
    const snapshots = await workerControl.listWorkers(
      this.context(checkpoint, "preflight:list-workers"),
    );
    const byId = new Map(snapshots.map((snapshot) => [snapshot.nodeId, snapshot]));
    if (byId.size !== snapshots.length
      || snapshots.length !== expectedOrder.length
      || expectedOrder.some((nodeId) => !byId.has(nodeId))) {
      throw new ReleaseInvariantError("WORKER_SET_MISMATCH", "Worker 心跳集合与受信清单不一致");
    }
    const baselineShas = new Set(snapshots.map((snapshot) => snapshot.artifactSha256));
    if (baselineShas.size !== 1) {
      throw new ReleaseInvariantError("WORKER_BASELINE_MIXED", "Worker 节点当前版本不一致");
    }
    const apiBaselineSha = checkpoint.nodes[checkpoint.nodeOrder[0]]?.previousArtifactSha256;
    if (!apiBaselineSha || !baselineShas.has(apiBaselineSha)) {
      throw new ReleaseInvariantError(
        "WORKER_API_BASELINE_MISMATCH",
        "API 与 Worker 节点当前版本不一致",
      );
    }
    const previousSchemaVersion = this.previousSchemaVersion(checkpoint);
    const observedDatabaseSchemaVersion = checkpoint.schemaMode === "migration"
      ? previousSchemaVersion
      : checkpoint.artifact.schemaVersion;
    for (const nodeId of expectedOrder) {
      const snapshot = byId.get(nodeId)!;
      this.assertWorkerServing(
        snapshot,
        this.normalWorkerExpectation(
          snapshot.artifactSha256,
          previousSchemaVersion,
          observedDatabaseSchemaVersion,
        ),
      );
      const worker = checkpoint.workers[nodeId] || checkpointWorker(nodeId);
      worker.previousArtifactSha256 = snapshot.artifactSha256;
      worker.preflightComplete = true;
      checkpoint.workers[nodeId] = worker;
      await this.persist(checkpoint);
      await this.checkCancellation(checkpoint);
    }
    checkpoint.workerPreflightComplete = true;
    await this.record(checkpoint, "preflight.completed", null, {
      workerCount: expectedOrder.length,
      role: "worker",
    });
  }

  private async stageAll(checkpoint: ReleaseCheckpoint): Promise<void> {
    if (checkpoint.stageComplete) return;
    await this.changePhase(checkpoint, "stage");

    for (const nodeId of checkpoint.nodeOrder) {
      const node = checkpoint.nodes[nodeId];
      if (node.staged) continue;
      await this.checkCancellation(checkpoint);
      await this.verifyRedisRuntimeFingerprintFleet(checkpoint);
      const result = await this.nodeAgent.stage(
        nodeId,
        checkpoint.artifact,
        this.context(checkpoint, `stage:${nodeId}`),
      );
      if (result.artifactSha256 !== checkpoint.artifact.sha256) {
        throw new ReleaseInvariantError(
          "STAGED_ARTIFACT_SHA_MISMATCH",
          `节点 ${nodeId} 暂存制品校验失败`,
        );
      }
      node.staged = true;
      await this.record(checkpoint, "stage.completed", nodeId);
      await this.checkCancellation(checkpoint);
    }

    if (!checkpoint.workerStageComplete) {
      const workerAgent = this.requireWorkerNodeAgent();
      for (const nodeId of checkpoint.workerOrder) {
        const worker = checkpoint.workers[nodeId];
        if (worker.staged) continue;
        await this.checkCancellation(checkpoint);
        await this.verifyRedisRuntimeFingerprintFleet(checkpoint);
        const result = await workerAgent.stage(
          nodeId,
          checkpoint.artifact,
          this.context(checkpoint, `stage:worker:${nodeId}`),
        );
        if (result.artifactSha256 !== checkpoint.artifact.sha256) {
          throw new ReleaseInvariantError(
            "WORKER_STAGED_ARTIFACT_SHA_MISMATCH",
            `Worker ${nodeId} 暂存制品校验失败`,
          );
        }
        worker.staged = true;
        await this.record(checkpoint, "stage.completed", nodeId, { role: "worker" });
      }
      checkpoint.workerStageComplete = true;
      await this.persist(checkpoint);
    }

    checkpoint.stageComplete = true;
    await this.persist(checkpoint);
    await this.checkCancellation(checkpoint);
  }

  private schemaMigrationRequest(
    checkpoint: ReleaseCheckpoint,
  ): ReleaseSchemaMigrationRequest {
    const migration = checkpoint.artifact.schemaCompatibility?.migration;
    if (
      checkpoint.schemaMode !== "migration"
      || !migration
      || checkpoint.schemaMigrationRunId !== checkpoint.operationId
    ) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_CONTRACT_INVALID",
        "发布断点缺少不可变的数据库迁移合同",
      );
    }
    return {
      runId: checkpoint.schemaMigrationRunId,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
      artifactSha256: checkpoint.artifact.sha256,
    };
  }

  private async inspectSchemaMigration(
    checkpoint: ReleaseCheckpoint,
    request: ReleaseSchemaMigrationRequest,
    actionId: string,
  ) {
    try {
      return await this.schemaMigrator!.inspect(
        request,
        this.context(checkpoint, actionId),
      );
    } catch (error) {
      throw new ReleaseInvariantError(
        scalarCode(
          (error as { code?: unknown } | null)?.code,
          "SCHEMA_MIGRATION_INSPECTION_FAILED",
        ),
        "数据库迁移账本或运行证据无法核验",
      );
    }
  }

  private assertSchemaMigrationObservation(
    observation: Awaited<ReturnType<NonNullable<
      ReleaseControllerDependencies["schemaMigrator"]
    >["inspect"]>>,
    request: ReleaseSchemaMigrationRequest,
  ): void {
    if (
      !Number.isSafeInteger(observation.schemaVersion)
      || observation.schemaVersion < 0
      || !Number.isSafeInteger(observation.latestVersion)
      || observation.latestVersion < 1
      || observation.latestVersion !== request.toVersion
      || (
        observation.runStatus === null
          ? observation.runId !== null
          : observation.runId !== request.runId
      )
      || ![null, "started", "succeeded", "failed"].includes(observation.runStatus)
    ) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_OBSERVATION_INVALID",
        "数据库迁移执行器返回了不完整或不一致的证明",
      );
    }
  }

  private async runSchemaMigration(checkpoint: ReleaseCheckpoint): Promise<void> {
    if (checkpoint.schemaMode === "schema-neutral") return;
    await this.changePhase(checkpoint, "schema-migration");
    if (!checkpoint.preflightComplete || !checkpoint.stageComplete) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_BRIDGE_NOT_READY",
        "迁移前尚未完成旧版本兼容桥和目标制品验证",
      );
    }
    if (
      checkpoint.workerOrder.length < 2
      || checkpoint.workerOrder.some(
        (nodeId) => !checkpoint.workers[nodeId]?.bridgeAuthorized,
      )
    ) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_BRIDGE_NOT_READY",
        "迁移前 Worker 兼容桥 fence 尚未全量验活",
      );
    }
    if (!checkpoint.schemaMigrationAttempted) {
      await this.assertMigrationWorkerBridgesLive(checkpoint);
    }

    const request = this.schemaMigrationRequest(checkpoint);
    const before = await this.inspectSchemaMigration(
      checkpoint,
      request,
      "schema-migration:inspect",
    );
    this.assertSchemaMigrationObservation(before, request);

    if (checkpoint.schemaMigrationComplete) {
      if (
        before.schemaVersion !== request.toVersion
        || before.runId !== request.runId
        || before.runStatus !== "succeeded"
      ) {
        throw new ReleaseInvariantError(
          "SCHEMA_MIGRATION_COMPLETION_LOST",
          "发布断点中的迁移完成状态无法由数据库重新证明",
        );
      }
      return;
    }

    if (checkpoint.schemaMigrationAttempted) {
      if (
        before.schemaVersion === request.toVersion
        && before.runId === request.runId
        && before.runStatus === "succeeded"
      ) {
        checkpoint.schemaMigrationComplete = true;
        await this.record(checkpoint, "schema-migration.completed", null, {
          fromVersion: request.fromVersion,
          toVersion: request.toVersion,
          reconciled: true,
        });
        await this.checkCancellation(checkpoint);
        return;
      }
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_RECONCILIATION_REQUIRED",
        "迁移调用结果不确定，禁止自动重试或回滚二进制",
      );
    }

    if (
      before.schemaVersion !== request.fromVersion
      || before.runId !== null
      || before.runStatus !== null
    ) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_BASELINE_MISMATCH",
        "数据库不在迁移合同声明的起始版本，或存在冲突运行证据",
      );
    }
    await this.checkCancellation(checkpoint);

    // Persist before calling the runner: loss of the response is treated as
    // an unknown outcome and can only be closed by matching terminal evidence.
    checkpoint.schemaMigrationAttempted = true;
    await this.record(checkpoint, "schema-migration.started", null, {
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
    });

    let applied;
    try {
      applied = await this.schemaMigrator!.apply(
        request,
        this.context(checkpoint, "schema-migration:apply"),
      );
    } catch (error) {
      throw new ReleaseInvariantError(
        scalarCode(
          (error as { code?: unknown } | null)?.code,
          "SCHEMA_MIGRATION_APPLY_FAILED",
        ),
        "数据库迁移未形成可接受的完成证明",
      );
    }
    this.assertSchemaMigrationObservation(applied, request);
    if (
      applied.schemaVersion !== request.toVersion
      || applied.runId !== request.runId
      || applied.runStatus !== "succeeded"
    ) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_TARGET_NOT_PROVEN",
        "数据库迁移执行结果未证明目标账本版本",
      );
    }

    const verified = await this.inspectSchemaMigration(
      checkpoint,
      request,
      "schema-migration:verify",
    );
    this.assertSchemaMigrationObservation(verified, request);
    if (
      verified.schemaVersion !== request.toVersion
      || verified.runId !== request.runId
      || verified.runStatus !== "succeeded"
    ) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_TARGET_NOT_PROVEN",
        "数据库迁移完成后无法独立重读目标账本与运行证据",
      );
    }

    checkpoint.schemaMigrationComplete = true;
    await this.record(checkpoint, "schema-migration.completed", null, {
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
      reconciled: false,
    });
    await this.checkCancellation(checkpoint);
  }

  private async rollAllWorkers(checkpoint: ReleaseCheckpoint, plan: ReleasePlan): Promise<void> {
    if (checkpoint.workerRollingComplete) return;
    await this.changePhase(checkpoint, "worker-rolling");
    const minimumHealthy = plan.minHealthyWorkers ?? checkpoint.workerOrder.length - 1;
    // workerOrder[0] is the target-version bridge established before API
    // rolling. Keep every old-version peer serving until all APIs have moved.
    for (const nodeId of checkpoint.workerOrder.slice(1)) {
      const worker = checkpoint.workers[nodeId];
      if (worker.completed) continue;
      checkpoint.currentNodeId = nodeId;
      await this.persist(checkpoint);
      await this.checkCancellation(checkpoint);
      await this.rollWorker(checkpoint, worker, minimumHealthy);
    }
    checkpoint.currentNodeId = null;
    checkpoint.workerRollingComplete = true;
    await this.persist(checkpoint);
  }

  private async rollWorkerBridge(
    checkpoint: ReleaseCheckpoint,
    plan: ReleasePlan,
  ): Promise<void> {
    if (checkpoint.schemaMode === "migration" && checkpoint.workerOrder.length < 2) {
      throw new ReleaseInvariantError(
        "RELEASE_MIGRATION_DEDICATED_WORKERS_REQUIRED",
        "migration-mode 发布不能在缺少独立 Worker bridge 的情况下继续",
      );
    }
    if (checkpoint.workerOrder.length === 0 || checkpoint.workerRollingComplete) return;
    const nodeId = checkpoint.workerOrder[0];
    const worker = checkpoint.workers[nodeId];
    if (worker.completed) {
      if (checkpoint.schemaMode === "migration") {
        const expectation = worker.bridgeFinalized
          ? this.normalWorkerExpectation(
              checkpoint.artifact.sha256,
              checkpoint.artifact.schemaVersion,
            )
          : this.bridgeWorkerExpectation(
              checkpoint,
              checkpoint.artifact,
              checkpoint.schemaMigrationComplete
                ? checkpoint.artifact.schemaVersion
                : this.previousSchemaVersion(checkpoint),
            );
        const snapshot = await this.requireWorkerControl().waitForServing(
          nodeId,
          expectation,
          this.context(checkpoint, `worker:${nodeId}:bridge-revalidate`),
        );
        this.assertWorkerServing(snapshot, expectation);
      }
      return;
    }
    await this.changePhase(checkpoint, "worker-rolling");
    checkpoint.currentNodeId = nodeId;
    await this.persist(checkpoint);
    await this.checkCancellation(checkpoint);
    await this.rollWorker(
      checkpoint,
      worker,
      plan.minHealthyWorkers ?? checkpoint.workerOrder.length - 1,
    );
    checkpoint.currentNodeId = null;
    await this.persist(checkpoint);
    await this.checkCancellation(checkpoint);
  }

  private isolatedWorkerExpectation(
    artifactSha256: string,
    targetSchemaVersion: number,
    observedDatabaseSchemaVersion: number,
  ): WorkerSchemaExpectation {
    return {
      artifactSha256,
      targetSchemaVersion,
      observedDatabaseSchemaVersion,
      runtimeMode: "isolated",
    };
  }

  private normalWorkerExpectation(
    artifactSha256: string,
    targetSchemaVersion: number,
    observedDatabaseSchemaVersion = targetSchemaVersion,
  ): WorkerSchemaExpectation {
    return {
      artifactSha256,
      targetSchemaVersion,
      observedDatabaseSchemaVersion,
      runtimeMode: "normal",
    };
  }

  private bridgeWorkerExpectation(
    checkpoint: ReleaseCheckpoint,
    artifact: NonNullable<ReleaseCheckpoint["previousArtifact"]> | ReleaseCheckpoint["artifact"],
    observedDatabaseSchemaVersion: number,
  ): WorkerSchemaExpectation {
    const migration = checkpoint.artifact.schemaCompatibility?.migration;
    const compatibility = artifact.schemaCompatibility;
    if (!migration || !compatibility) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_BRIDGE_CONTRACT_MISSING",
        "Worker bridge 缺少不可变兼容性证明",
      );
    }
    return {
      artifactSha256: artifact.sha256,
      targetSchemaVersion: artifact.schemaVersion,
      observedDatabaseSchemaVersion,
      runtimeMode: "migration-bridge",
      migration: {
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
        compatibilityProofSha256:
          releaseSchemaCompatibilityProofSha256(compatibility),
      },
    };
  }

  private async authorizePreviousWorkerBridges(
    checkpoint: ReleaseCheckpoint,
  ): Promise<void> {
    if (checkpoint.schemaMode !== "migration") return;
    if (checkpoint.workerOrder.length < 2) {
      throw new ReleaseInvariantError(
        "RELEASE_MIGRATION_DEDICATED_WORKERS_REQUIRED",
        "migration-mode 发布不能跳过旧 Worker fence",
      );
    }
    const previous = checkpoint.previousArtifact;
    if (!previous) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_BRIDGE_CONTRACT_MISSING",
        "断点缺少 N-1 Worker 制品身份",
      );
    }
    const control = this.requireWorkerControl();
    const observed = this.previousSchemaVersion(checkpoint);
    for (const nodeId of checkpoint.workerOrder.slice(1)) {
      const worker = checkpoint.workers[nodeId];
      const expectation = this.bridgeWorkerExpectation(
        checkpoint,
        {
          ...previous,
          // Each preflight heartbeat proves the same immutable previous SHA.
          sha256: worker.previousArtifactSha256,
        },
        observed,
      );
      if (!worker.bridgeAuthorized) {
        await control.authorizeSchemaBridge(
          nodeId,
          expectation,
          this.context(checkpoint, `worker:${nodeId}:authorize-previous-bridge`),
        );
      }
      const snapshot = await control.waitForServing(
        nodeId,
        expectation,
        this.context(checkpoint, `worker:${nodeId}:previous-bridge-serving`),
      );
      this.assertWorkerServing(snapshot, expectation);
      worker.bridgeAuthorized = true;
      worker.resumed = true;
      worker.serving = true;
      await this.persist(checkpoint);
      await this.checkCancellation(checkpoint);
    }
  }

  private async assertMigrationWorkerBridgesLive(
    checkpoint: ReleaseCheckpoint,
  ): Promise<void> {
    if (checkpoint.schemaMode !== "migration" || checkpoint.workerOrder.length < 2) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_BRIDGE_NOT_READY",
        "迁移前缺少完整的 dedicated Worker bridge 清单",
      );
    }
    const previous = checkpoint.previousArtifact;
    if (!previous) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_BRIDGE_CONTRACT_MISSING",
        "断点缺少 N-1 Worker 制品身份",
      );
    }
    const control = this.requireWorkerControl();
    const observedDatabaseSchemaVersion = this.previousSchemaVersion(checkpoint);
    const snapshots = await control.listWorkers(
      this.context(checkpoint, "schema-migration:worker-inventory"),
    );
    const byId = new Map(snapshots.map((snapshot) => [snapshot.nodeId, snapshot]));
    if (
      byId.size !== snapshots.length
      || snapshots.length !== checkpoint.workerOrder.length
      || checkpoint.workerOrder.some((nodeId) => !byId.has(nodeId))
    ) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_WORKER_INVENTORY_MISMATCH",
        "DDL 前 Worker 在线集合与受信发布清单不一致",
      );
    }
    for (const [index, nodeId] of checkpoint.workerOrder.entries()) {
      const worker = checkpoint.workers[nodeId];
      if (!worker?.bridgeAuthorized || worker.isolated || !worker.serving) {
        throw new ReleaseInvariantError(
          "SCHEMA_MIGRATION_BRIDGE_NOT_READY",
          `Worker ${nodeId} 未证明 bridge fence 正在接单`,
        );
      }
      const artifact = index === 0
        ? checkpoint.artifact
        : {
            ...previous,
            sha256: worker.previousArtifactSha256,
          };
      const expectation = this.bridgeWorkerExpectation(
        checkpoint,
        artifact,
        observedDatabaseSchemaVersion,
      );
      const snapshot = await control.waitForServing(
        nodeId,
        expectation,
        this.context(checkpoint, `worker:${nodeId}:migration-fence-revalidate`),
      );
      this.assertWorkerServing(snapshot, expectation);
    }
  }

  private async rollWorker(
    checkpoint: ReleaseCheckpoint,
    worker: ReleaseWorkerCheckpoint,
    minimumHealthy: number,
  ): Promise<void> {
    const control = this.requireWorkerControl();
    const agent = this.requireWorkerNodeAgent();
    const nodeId = worker.nodeId;
    const previousSchemaVersion = this.previousSchemaVersion(checkpoint);
    const observedDatabaseSchemaVersion = checkpoint.schemaMode === "migration"
      && !checkpoint.schemaMigrationComplete
      ? previousSchemaVersion
      : checkpoint.artifact.schemaVersion;
    const targetMigrationBridge = checkpoint.schemaMode === "migration"
      && checkpoint.workerOrder[0] === nodeId
      && !worker.bridgeFinalized
      && (!checkpoint.schemaMigrationComplete || worker.bridgeAuthorized);

    // Close the gap between staging and the first Worker drain. If another
    // Controller armed Redis meanwhile, every Worker must persist the same
    // irreversible marker before any process can be switched or isolated.
    await this.verifyRedisRuntimeFingerprintFleet(checkpoint);

    if (!worker.drainRequested) {
      await control.assertHealthyCapacity(
        nodeId,
        minimumHealthy,
        this.context(checkpoint, `worker:${nodeId}:capacity`),
      );
      worker.capacityConfirmed = true;
      await this.record(checkpoint, "worker.capacity-confirmed", nodeId, { minimumHealthy });
      await this.checkCancellation(checkpoint);
      await control.requestDrain(nodeId, this.context(checkpoint, `worker:${nodeId}:request-drain`));
      worker.drainRequested = true;
      worker.resumed = false;
      worker.serving = false;
      await this.record(checkpoint, "worker.drain-requested", nodeId);
    }

    if (!worker.drained) {
      const snapshot = await control.waitForDrained(
        nodeId,
        this.context(checkpoint, `worker:${nodeId}:wait-drained`),
      );
      if (snapshot.acceptingWork || snapshot.activeTaskCount !== 0
        || snapshot.drainOperationId !== checkpoint.operationId) {
        throw new ReleaseInvariantError("WORKER_DRAIN_NOT_ACKNOWLEDGED", `Worker ${nodeId} 未完成排空`);
      }
      worker.drained = true;
      worker.isolated = true;
      await this.record(checkpoint, "worker.drained", nodeId);
      await this.checkCancellation(checkpoint);
    }

    // A migration-mode target Worker must receive its exact durable bridge
    // fence before PM2 starts the target binary. The target binary cannot
    // otherwise pass dbReady against fromVersion and therefore can never
    // publish the heartbeat the Controller is waiting for.
    //
    // Persisting the checkpoint intent before writing the control fence also
    // closes the response-loss window: runtime admission requires both
    // records, while a replay can idempotently finish the fence write.
    if (targetMigrationBridge) {
      if (!worker.bridgeAuthorized) {
        if (!worker.activationAttempted && !worker.activated) {
          const before = await control.waitForArtifact(
            nodeId,
            this.isolatedWorkerExpectation(
              worker.previousArtifactSha256,
              previousSchemaVersion,
              observedDatabaseSchemaVersion,
            ),
            this.context(checkpoint, `worker:${nodeId}:activation-preflight`),
          );
          if (before.acceptingWork || before.activeTaskCount !== 0) {
            throw new ReleaseInvariantError(
              "WORKER_RESTARTED_ACCEPTING_WORK",
              `Worker ${nodeId} 在激活前恢复接单`,
            );
          }
        }
        worker.bridgeAuthorized = true;
        await this.persist(checkpoint);
      }
      await control.authorizeSchemaBridge(
        nodeId,
        this.bridgeWorkerExpectation(
          checkpoint,
          checkpoint.artifact,
          observedDatabaseSchemaVersion,
        ),
        this.context(checkpoint, `worker:${nodeId}:authorize-target-bridge`),
      );
    }

    if (!worker.activated) {
      if (!targetMigrationBridge) {
        const before = await control.waitForArtifact(
          nodeId,
          this.isolatedWorkerExpectation(
            worker.activationAttempted
              ? checkpoint.artifact.sha256
              : worker.previousArtifactSha256,
            worker.activationAttempted
              ? checkpoint.artifact.schemaVersion
              : previousSchemaVersion,
            observedDatabaseSchemaVersion,
          ),
          this.context(checkpoint, `worker:${nodeId}:activation-preflight`),
        ).catch(async (error) => {
          if (!worker.activationAttempted) throw error;
          return control.waitForArtifact(
            nodeId,
            this.isolatedWorkerExpectation(
              worker.previousArtifactSha256,
              previousSchemaVersion,
              observedDatabaseSchemaVersion,
            ),
            this.context(checkpoint, `worker:${nodeId}:activation-preflight-old`),
          );
        });
        if (before.acceptingWork || before.activeTaskCount !== 0) {
          throw new ReleaseInvariantError(
            "WORKER_RESTARTED_ACCEPTING_WORK",
            `Worker ${nodeId} 在激活前恢复接单`,
          );
        }
      }
      if (!worker.activationAttempted) {
        worker.activationAttempted = true;
        await this.persist(checkpoint);
      }
      const activation = await agent.activate(
        nodeId,
        checkpoint.artifact,
        this.context(checkpoint, `worker:${nodeId}:activate`),
      );
      const targetCompatibility = checkpoint.artifact.schemaCompatibility
        ?? (checkpoint.schemaMode === "schema-neutral"
          ? exactReleaseSchemaCompatibility(
            checkpoint.artifact.schemaVersion,
          )
          : null);
      if (
        !targetCompatibility
        || activation.artifactSha256 !== checkpoint.artifact.sha256
        || activation.targetSchemaVersion !== checkpoint.artifact.schemaVersion
        || activation.schemaMode !== checkpoint.schemaMode
        || activation.schemaCompatibilityProofSha256
          !== releaseSchemaCompatibilityProofSha256(targetCompatibility)
      ) {
        throw new ReleaseInvariantError(
          "WORKER_ACTIVATION_SCHEMA_IDENTITY_MISMATCH",
          `Worker ${nodeId} 激活响应未绑定目标 schema 合同`,
        );
      }
      await this.verifyReleaseConfiguration(
        checkpoint,
        "worker-artifact",
        nodeId,
        {
          artifactSha256: activation.artifactSha256,
          ...(activation.sourceCommit ? { sourceCommit: activation.sourceCommit } : {}),
          schemaVersion: activation.targetSchemaVersion,
          ...(activation.agentSurfaceFingerprint
            ? { agentSurfaceFingerprint: activation.agentSurfaceFingerprint }
            : {}),
        },
      );
      worker.activated = true;
      await this.record(checkpoint, "worker.activated", nodeId);
    }

    if (!worker.artifactReady) {
      if (targetMigrationBridge) {
        const expectation = this.bridgeWorkerExpectation(
          checkpoint,
          checkpoint.artifact,
          observedDatabaseSchemaVersion,
        );
        const snapshot = await control.waitForServing(
          nodeId,
          expectation,
          this.context(checkpoint, `worker:${nodeId}:artifact-ready`),
        );
        this.assertWorkerServing(snapshot, expectation);
      } else {
        const snapshot = await control.waitForArtifact(
          nodeId,
          this.isolatedWorkerExpectation(
            checkpoint.artifact.sha256,
            checkpoint.artifact.schemaVersion,
            observedDatabaseSchemaVersion,
          ),
          this.context(checkpoint, `worker:${nodeId}:artifact-ready`),
        );
        if (snapshot.acceptingWork || snapshot.activeTaskCount !== 0) {
          throw new ReleaseInvariantError(
            "WORKER_READY_BEFORE_RESUME",
            `Worker ${nodeId} 未保持排空状态`,
          );
        }
      }
      await this.verifyWorkerReleaseConfiguration(
        checkpoint,
        nodeId,
        "worker-artifact",
      );
      worker.artifactReady = true;
      await this.record(checkpoint, "worker.artifact-ready", nodeId);
    }

    if (!worker.resumed) {
      if (
        checkpoint.schemaMode === "migration"
        && (!checkpoint.schemaMigrationComplete || targetMigrationBridge)
      ) {
        // The target bridge was authorized before activation. Rewriting the
        // same fence here is unnecessary; non-target pre-DDL Workers are
        // never rolled by the migration choreography.
        worker.bridgeAuthorized = true;
      } else {
        await control.resume(nodeId, this.context(checkpoint, `worker:${nodeId}:resume`));
        worker.bridgeFinalized = true;
      }
      worker.resumed = true;
      await this.record(checkpoint, "worker.resumed", nodeId);
    }

    if (!worker.serving) {
      const expectation = checkpoint.schemaMode === "migration"
        && (!checkpoint.schemaMigrationComplete || targetMigrationBridge)
        ? this.bridgeWorkerExpectation(
          checkpoint,
          checkpoint.artifact,
          observedDatabaseSchemaVersion,
        )
        : this.normalWorkerExpectation(
          checkpoint.artifact.sha256,
          checkpoint.artifact.schemaVersion,
          observedDatabaseSchemaVersion,
        );
      const snapshot = await control.waitForServing(
        nodeId,
        expectation,
        this.context(checkpoint, `worker:${nodeId}:serving`),
      );
      this.assertWorkerServing(snapshot, expectation);
      worker.serving = true;
      worker.isolated = false;
      await this.persist(checkpoint);
    }
    worker.completed = true;
    await this.record(checkpoint, "worker.completed", nodeId);
  }

  private assertWorkerServing(
    snapshot: WorkerRuntimeSnapshot,
    expectation: WorkerSchemaExpectation,
  ): void {
    if (!snapshot.healthy || !snapshot.acceptingWork || snapshot.activeTaskCount < 0
      || snapshot.artifactSha256 !== expectation.artifactSha256
      || snapshot.observedDatabaseSchemaVersion
        !== expectation.observedDatabaseSchemaVersion
      || snapshot.schemaRuntimeMode !== expectation.runtimeMode
      || (
        expectation.runtimeMode === "migration-bridge"
        && snapshot.bridgeCompatibilityProofSha256
          !== expectation.migration?.compatibilityProofSha256
      )) {
      throw new ReleaseInvariantError("WORKER_NOT_HEALTHY", `Worker ${snapshot.nodeId} 未处于可接单状态`);
    }
  }

  private async finalizeTargetWorkerBridge(
    checkpoint: ReleaseCheckpoint,
  ): Promise<void> {
    if (checkpoint.schemaMode !== "migration") return;
    if (checkpoint.workerOrder.length < 2) {
      throw new ReleaseInvariantError(
        "RELEASE_MIGRATION_DEDICATED_WORKERS_REQUIRED",
        "migration-mode 发布不能在缺少完整 Worker 清单时清除最后一个 bridge fence",
      );
    }
    if (!checkpoint.schemaMigrationComplete) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_TARGET_NOT_PROVEN",
        "数据库迁移未证明前禁止清除 Worker bridge fence",
      );
    }
    if (
      checkpoint.nodeOrder.some((nodeId) => {
        const node = checkpoint.nodes[nodeId];
        return !node?.completed || node.isolated || !node.weightRestored;
      })
      || checkpoint.workerOrder.slice(1).some((nodeId) => {
        const peer = checkpoint.workers[nodeId];
        return !peer?.completed
          || !peer.serving
          || !peer.resumed
          || peer.isolated;
      })
    ) {
      throw new ReleaseInvariantError(
        "WORKER_SCHEMA_BRIDGE_CLEANUP_PREMATURE",
        "目标 API/Worker 尚未全量稳定，禁止清除最后一个 bridge fence",
      );
    }
    const worker = checkpoint.workers[checkpoint.workerOrder[0]];
    if (worker.bridgeFinalized) return;
    const control = this.requireWorkerControl();
    await control.resume(
      worker.nodeId,
      this.context(checkpoint, `worker:${worker.nodeId}:finalize-target-bridge`),
    );
    const expectation = this.normalWorkerExpectation(
      checkpoint.artifact.sha256,
      checkpoint.artifact.schemaVersion,
    );
    const snapshot = await control.waitForServing(
      worker.nodeId,
      expectation,
      this.context(checkpoint, `worker:${worker.nodeId}:target-after-migration`),
    );
    this.assertWorkerServing(snapshot, expectation);
    worker.bridgeFinalized = true;
    worker.isolated = false;
    worker.resumed = true;
    worker.serving = true;
    await this.persist(checkpoint);
  }

  private previousSchemaVersion(checkpoint: ReleaseCheckpoint): number {
    return expectedPreviousSchemaVersion({
      targetSchemaVersion: checkpoint.artifact.schemaVersion,
      targetArtifactSha256: checkpoint.artifact.sha256,
      bridge: checkpoint.schemaCompatibility,
    });
  }

  private requireWorkerControl(): NonNullable<ReleaseControllerDependencies["workerControlPlane"]> {
    if (!this.workerControlPlane) {
      throw new ReleaseInvariantError("WORKER_CONTROL_MISSING", "Worker 数据库控制面未配置");
    }
    return this.workerControlPlane;
  }

  private requireWorkerNodeAgent(): NonNullable<ReleaseControllerDependencies["workerNodeAgent"]> {
    if (!this.workerNodeAgent) {
      throw new ReleaseInvariantError("WORKER_NODE_AGENT_MISSING", "Worker 节点 Agent 未配置");
    }
    return this.workerNodeAgent;
  }

  private async verifyWorkerReleaseConfiguration(
    checkpoint: ReleaseCheckpoint,
    nodeId: string,
    stage: "worker-artifact" | "worker-final",
  ): Promise<void> {
    if (!this.releaseConfigurationVerifier) return;
    const agent = this.requireWorkerNodeAgent();
    if (typeof agent.configurationIdentity !== "function") {
      throw new ReleaseInvariantError(
        "WORKER_CONFIG_IDENTITY_UNAVAILABLE",
        `Worker ${nodeId} 的固定节点 Agent 不支持配置身份证明`,
      );
    }
    const observation = await agent.configurationIdentity(
      nodeId,
      this.context(checkpoint, `config:${stage}:${nodeId}:identity`),
    );
    await this.verifyReleaseConfiguration(checkpoint, stage, nodeId, observation);
  }

  private async verifyAllWorkersServing(checkpoint: ReleaseCheckpoint): Promise<void> {
    if (checkpoint.workerOrder.length === 0) return;
    const snapshots = await this.requireWorkerControl().listWorkers(
      this.context(checkpoint, "worker:final-inventory"),
    );
    const byId = new Map(snapshots.map((snapshot) => [snapshot.nodeId, snapshot]));
    if (byId.size !== snapshots.length
      || snapshots.length !== checkpoint.workerOrder.length
      || checkpoint.workerOrder.some((nodeId) => !byId.has(nodeId))) {
      throw new ReleaseInvariantError(
        "WORKER_FINAL_SET_MISMATCH",
        "公网冒烟前 Worker 在线集合与受信发布清单不一致",
      );
    }
    for (const nodeId of checkpoint.workerOrder) {
      this.assertWorkerServing(
        byId.get(nodeId)!,
        this.normalWorkerExpectation(
          checkpoint.artifact.sha256,
          checkpoint.artifact.schemaVersion,
        ),
      );
      await this.verifyWorkerReleaseConfiguration(
        checkpoint,
        nodeId,
        "worker-final",
      );
    }
  }

  private async rollAllNodes(checkpoint: ReleaseCheckpoint): Promise<void> {
    await this.changePhase(checkpoint, "rolling");
    for (const nodeId of checkpoint.nodeOrder) {
      const node = checkpoint.nodes[nodeId];
      if (node.completed) continue;
      // Configuration can drift after staging or between nodes. Re-attest the
      // complete API fleet immediately before each possible CLB weight change;
      // agreement only within the new sample is insufficient because it must
      // also match the fingerprint durably bound during initial preflight.
      await this.verifyRedisRuntimeFingerprintFleet(checkpoint);
      checkpoint.currentNodeId = nodeId;
      await this.persist(checkpoint);
      // This is both the node-to-node boundary and the last safe point before
      // the next node can be removed from service.
      await this.checkCancellation(checkpoint);
      await this.rollNode(checkpoint, node);
    }
    checkpoint.currentNodeId = null;
    await this.persist(checkpoint);
    await this.checkCancellation(checkpoint);
  }

  private async rollNode(
    checkpoint: ReleaseCheckpoint,
    node: ReleaseNodeCheckpoint,
  ): Promise<void> {
    const nodeId = node.nodeId;
    let applicationDrainVerified = false;

    // A confirmation checkpoint is intentionally not trusted after a process
    // restart. Until weight-zero has happened, always sample every peer again.
    if (!node.weightZero) {
      await this.checkCancellation(checkpoint);
      await this.confirmOtherNodesHealthy(checkpoint, nodeId);
      node.othersHealthyConfirmed = true;
      await this.record(checkpoint, "node.others-healthy", nodeId);
      await this.checkCancellation(checkpoint);

      node.weightZeroAttempted = true;
      await this.persist(checkpoint);
      await this.loadBalancer.setWeight(
        nodeId,
        0,
        this.context(checkpoint, `roll:${nodeId}:weight-zero`),
      );
      node.weightZero = true;
      node.weightRestored = false;
      node.isolated = true;
      await this.record(checkpoint, "node.weight-zero", nodeId);
      await this.checkCancellation(checkpoint);
    }

    if (!node.drained) {
      await this.checkCancellation(checkpoint);
      const propagation = await this.loadBalancer.waitForDrain(
        nodeId,
        this.context(checkpoint, `roll:${nodeId}:weight-zero-propagated`),
      );
      if (!propagation.drained) {
        throw new ReleaseInvariantError("CLB_WEIGHT_ZERO_NOT_PROPAGATED", `节点 ${nodeId} 摘流权重未生效`);
      }
      await this.waitForApplicationDrain(checkpoint, node, `roll:${nodeId}`);
      applicationDrainVerified = true;
      node.drained = true;
      await this.record(checkpoint, "node.drained", nodeId);
      await this.checkCancellation(checkpoint);
    }

    if (!node.activated) {
      if (!applicationDrainVerified) {
        let currentSha = node.previousArtifactSha256;
        if (node.activationAttempted) {
          const identity = await this.nodeAgent.currentIdentity(
            nodeId,
            this.context(checkpoint, `roll:${nodeId}:resume-identity`),
          );
          if (identity.nodeId !== nodeId) {
            throw new ReleaseInvariantError(
              "NODE_CURRENT_RELEASE_IDENTITY_MISMATCH",
              `节点 ${nodeId} 断点恢复时返回了错误的节点身份`,
            );
          }
          currentSha = identity.artifactSha256;
          if (currentSha !== node.previousArtifactSha256 && currentSha !== checkpoint.artifact.sha256) {
            throw new ReleaseInvariantError(
              "NODE_CURRENT_RELEASE_CONFLICT",
              `节点 ${nodeId} 断点恢复时版本身份未知`,
            );
          }
        }
        // When the target SHA is already current, the remote atomic switch
        // completed before the controller checkpoint. Repeating activation is
        // idempotent and does not require draining the newly started process.
        if (currentSha !== checkpoint.artifact.sha256) {
          await this.waitForApplicationDrain(checkpoint, node, `roll:${nodeId}`, currentSha);
        }
      }
      await this.checkCancellation(checkpoint);
      await this.revalidateActivationIdentity(checkpoint, node);
      await this.checkCancellation(checkpoint);
      if (!node.activationAttempted) {
        node.activationAttempted = true;
        await this.persist(checkpoint);
      }
      await this.nodeAgent.activate(
        nodeId,
        checkpoint.artifact,
        this.context(checkpoint, `roll:${nodeId}:activate`),
      );
      node.activated = true;
      await this.record(checkpoint, "node.activated", nodeId);
      await this.checkCancellation(checkpoint);
    }

    if (!node.directReady) {
      await this.checkCancellation(checkpoint);
      const result = await this.nodeAgent.directReadiness(
        nodeId,
        this.context(checkpoint, `roll:${nodeId}:direct-ready`),
      );
      if (!result.ready) {
        const code = scalarCode(result.code, "NODE_DIRECT_NOT_READY");
        throw new ReleaseInvariantError(code, `节点 ${nodeId} 直连就绪检查失败`);
      }
      if (result.artifactSha256 !== checkpoint.artifact.sha256) {
        throw new ReleaseInvariantError(
          "ACTIVE_ARTIFACT_SHA_MISMATCH",
          `节点 ${nodeId} 当前制品不是目标版本`,
        );
      }
      await this.verifyReleaseConfiguration(
        checkpoint,
        "api-direct",
        nodeId,
        result,
      );
      node.directReady = true;
      await this.record(checkpoint, "node.direct-ready", nodeId);
      await this.checkCancellation(checkpoint);
    }

    if (!node.weightRestored) {
      await this.checkCancellation(checkpoint);
      await this.loadBalancer.setWeight(
        nodeId,
        node.originalWeight,
        this.context(checkpoint, `roll:${nodeId}:restore-weight`),
      );
      node.weightRestored = true;
      node.weightZero = false;
      node.isolated = false;
      await this.record(checkpoint, "node.weight-restored", nodeId, {
        weight: node.originalWeight,
      });
      await this.checkCancellation(checkpoint);
    }

    if (!node.baked) {
      // Persisted partial samples are discarded on method re-entry, ensuring a
      // resumed process establishes a fresh consecutive observation window.
      if (node.clbUpConfirmationCount > 0) {
        node.clbUpConfirmationCount = 0;
        await this.persist(checkpoint);
      }
      while (node.clbUpConfirmationCount < this.policy.clbUpConfirmations) {
        await this.checkCancellation(checkpoint);
        const backend = await this.loadBalancer.getBackend(
          nodeId,
          this.context(
            checkpoint,
            `roll:${nodeId}:clb-up:${node.clbUpConfirmationCount + 1}`,
          ),
        );
        this.assertServingBackend(backend, node);
        node.clbUpConfirmationCount += 1;
        await this.record(checkpoint, "node.clb-up", nodeId, {
          confirmation: node.clbUpConfirmationCount,
          required: this.policy.clbUpConfirmations,
        });
        if (node.clbUpConfirmationCount < this.policy.clbUpConfirmations) {
          await this.clock.sleep(this.policy.clbPollIntervalMs);
        }
      }

      await this.checkCancellation(checkpoint);
      await this.clock.sleep(this.policy.bakeTimeMs);
      await this.checkCancellation(checkpoint);
      const afterBake = await this.loadBalancer.getBackend(
        nodeId,
        this.context(checkpoint, `roll:${nodeId}:post-bake`),
      );
      this.assertServingBackend(afterBake, node);
      const postBakeReadiness = await this.nodeAgent.directReadiness(
        nodeId,
        this.context(checkpoint, `roll:${nodeId}:post-bake-direct-ready`),
      );
      if (
        !postBakeReadiness.ready
        || postBakeReadiness.artifactSha256 !== checkpoint.artifact.sha256
      ) {
        throw new ReleaseInvariantError(
          "POST_BAKE_ARTIFACT_CONFIG_DRIFT",
          `节点 ${nodeId} 烘焙后版本或配置漂移`,
        );
      }
      await this.verifyReleaseConfiguration(
        checkpoint,
        "api-post-bake",
        nodeId,
        postBakeReadiness,
      );
      node.baked = true;
      await this.record(checkpoint, "node.baked", nodeId, {
        bakeTimeMs: this.policy.bakeTimeMs,
      });
      await this.checkCancellation(checkpoint);
    }

    node.completed = true;
    await this.record(checkpoint, "node.completed", nodeId);
    await this.checkCancellation(checkpoint);
  }

  private async waitForApplicationDrain(
    checkpoint: ReleaseCheckpoint,
    node: ReleaseNodeCheckpoint,
    actionPrefix: string,
    expectedCurrentArtifactSha256 = node.previousArtifactSha256,
  ): Promise<void> {
    const startedAt = this.clock.now();
    await this.nodeAgent.beginDrain(
      node.nodeId,
      expectedCurrentArtifactSha256,
      this.context(checkpoint, `${actionPrefix}:begin-drain`),
    );
    if (!node.drainStarted) {
      node.drainStarted = true;
      await this.persist(checkpoint);
    }

    let consecutiveZero = 0;
    let observation = 0;
    while (consecutiveZero < 2) {
      if (actionPrefix.startsWith("roll:")) await this.checkCancellation(checkpoint);
      observation += 1;
      const status = await this.nodeAgent.drainStatus(
        node.nodeId,
        expectedCurrentArtifactSha256,
        this.context(checkpoint, `${actionPrefix}:drain-status:${observation}`),
      );
      if (!status.draining) {
        throw new ReleaseInvariantError("NODE_DRAIN_STATE_LOST", `节点 ${node.nodeId} 排空状态意外解除`);
      }
      consecutiveZero = status.totalConnections === 0 ? consecutiveZero + 1 : 0;
      if (consecutiveZero >= 2) break;

      const elapsed = this.clock.now() - startedAt;
      if (elapsed >= this.policy.drainTimeoutMs) {
        throw new ReleaseInvariantError("NODE_DRAIN_TIMEOUT", `节点 ${node.nodeId} 应用连接排空超时`);
      }
      const sleepMs = Math.min(
        this.policy.drainPollIntervalMs,
        Math.max(0, this.policy.drainTimeoutMs - elapsed),
      );
      if (sleepMs > 0) await this.clock.sleep(sleepMs);
    }
  }

  private async cancelApplicationDrain(
    checkpoint: ReleaseCheckpoint,
    node: ReleaseNodeCheckpoint,
    expectedCurrentArtifactSha256: string,
  ): Promise<void> {
    const status = await this.nodeAgent.cancelDrain(
      node.nodeId,
      expectedCurrentArtifactSha256,
      this.context(checkpoint, `rollback:${node.nodeId}:cancel-drain`),
    );
    if (status.draining) {
      throw new ReleaseInvariantError("NODE_DRAIN_CANCEL_FAILED", `节点 ${node.nodeId} 未退出排空状态`);
    }
    node.drainStarted = false;
    node.drained = false;
    await this.persist(checkpoint);
  }

  /**
   * Re-establish the node Agent's in-memory CAS identity immediately before
   * activation without requiring HTTP readiness. The application has already
   * entered its intentional drain state at this point, so a readiness-coupled
   * preflight would reject every healthy rollout.
   *
   * A Controller process can restart after the durable preflight checkpoint,
   * so relying on an adapter-local cache from that earlier phase would make an
   * otherwise recoverable deployment fail (or tempt an unsafe "expected
   * current" guess).
   *
   * The target SHA is accepted only when activation had already been durably
   * marked as attempted while the node was isolated and drained. That is the
   * crash window where the remote atomic switch may have succeeded before the
   * following checkpoint was saved. At every other point the exact old SHA
   * captured by the first preflight remains mandatory.
   */
  private async revalidateActivationIdentity(
    checkpoint: ReleaseCheckpoint,
    node: ReleaseNodeCheckpoint,
  ): Promise<void> {
    const identity = await this.nodeAgent.currentIdentity(
      node.nodeId,
      this.context(checkpoint, `roll:${node.nodeId}:activation-preflight`),
    );
    if (
      identity.nodeId !== node.nodeId
      || !identity.releaseId.trim()
      || !identity.artifactSha256.trim()
    ) {
      throw new ReleaseInvariantError(
        "NODE_CURRENT_RELEASE_IDENTITY_MISMATCH",
        `节点 ${node.nodeId} 激活前身份复核未通过`,
      );
    }

    const alreadySwitchedInCrashWindow = node.activationAttempted
      && node.weightZero
      && node.drained
      && identity.artifactSha256 === checkpoint.artifact.sha256;
    if (
      identity.artifactSha256 !== node.previousArtifactSha256
      && !alreadySwitchedInCrashWindow
    ) {
      throw new ReleaseInvariantError(
        "NODE_CURRENT_RELEASE_CONFLICT",
        `节点 ${node.nodeId} 当前制品已偏离持久化预检快照`,
      );
    }
  }

  private async confirmOtherNodesHealthy(
    checkpoint: ReleaseCheckpoint,
    targetNodeId: string,
  ): Promise<void> {
    for (const otherNodeId of checkpoint.nodeOrder) {
      if (otherNodeId === targetNodeId) continue;
      const backend = await this.loadBalancer.getBackend(
        otherNodeId,
        this.context(checkpoint, `roll:${targetNodeId}:confirm-peer:${otherNodeId}`),
      );
      if (backend.nodeId !== otherNodeId || backend.health !== "up" || backend.weight <= 0) {
        throw new ReleaseInvariantError(
          "PEER_CAPACITY_NOT_HEALTHY",
          `节点 ${targetNodeId} 摘流前其余容量不健康`,
        );
      }
    }
  }

  private assertServingBackend(
    backend: LoadBalancerBackend,
    node: ReleaseNodeCheckpoint,
  ): void {
    if (
      backend.nodeId !== node.nodeId
      || backend.health !== "up"
      || backend.weight !== node.originalWeight
    ) {
      throw new ReleaseInvariantError(
        "CLB_BACKEND_NOT_UP",
        `节点 ${node.nodeId} 未稳定恢复到负载均衡`,
      );
    }
  }

  private async verifyFinalTopology(checkpoint: ReleaseCheckpoint): Promise<void> {
    await this.checkCancellation(checkpoint);
    const backends = await this.loadBalancer.listBackends(
      this.context(checkpoint, "final:list-backends"),
    );
    const byId = new Map(backends.map((backend) => [backend.nodeId, backend]));
    if (
      byId.size !== backends.length
      || backends.length !== checkpoint.nodeOrder.length
      || checkpoint.nodeOrder.some((nodeId) => !byId.has(nodeId))
    ) {
      throw new ReleaseInvariantError(
        "FINAL_BACKEND_SET_MISMATCH",
        "公网冒烟前负载均衡节点集合与发布断点不一致",
      );
    }
    for (const nodeId of checkpoint.nodeOrder) {
      this.assertServingBackend(byId.get(nodeId)!, checkpoint.nodes[nodeId]);
      const readiness = await this.nodeAgent.directReadiness(
        nodeId,
        this.context(checkpoint, `final:${nodeId}:direct-ready`),
      );
      if (!readiness.ready || readiness.artifactSha256 !== checkpoint.artifact.sha256) {
        throw new ReleaseInvariantError(
          "FINAL_ARTIFACT_SHA_MISMATCH",
          `节点 ${nodeId} 在公网冒烟前发生版本漂移`,
        );
      }
      await this.verifyReleaseConfiguration(
        checkpoint,
        "api-final",
        nodeId,
        readiness,
      );
    }
    await this.checkCancellation(checkpoint);
  }

  private async runPublicSmoke(checkpoint: ReleaseCheckpoint): Promise<void> {
    if (checkpoint.publicSmokeComplete) return;
    await this.changePhase(checkpoint, "public-smoke");
    await this.checkCancellation(checkpoint);
    const result = await this.loadBalancer.publicSmoke(
      checkpoint.artifact,
      this.context(checkpoint, "public-smoke"),
    );
    if (!result.ok) {
      const code = scalarCode(result.code, "PUBLIC_SMOKE_FAILED");
      throw new ReleaseInvariantError(code, "公网发布冒烟检查失败");
    }
    if (result.artifactSha256 && result.artifactSha256 !== checkpoint.artifact.sha256) {
      throw new ReleaseInvariantError(
        "PUBLIC_ARTIFACT_SHA_MISMATCH",
        "公网响应的制品版本与目标版本不一致",
      );
    }
    checkpoint.publicSmokeComplete = true;
    await this.record(checkpoint, "public-smoke.completed");
    await this.checkCancellation(checkpoint);
  }

  private async scheduleRedisCutover(checkpoint: ReleaseCheckpoint): Promise<void> {
    if (!this.redisCutoverCoordinator) return;
    await this.changePhase(checkpoint, "redis-cutover");

    // A resumed operation may have persisted the fully attested schedule but
    // crashed before writing operation.succeeded. Re-prove the irreversible
    // state instead of issuing another side effect blindly.
    if (checkpoint.redisCutoverScheduled) {
      const inspection = await this.verifyRedisRuntimeFingerprintFleet(checkpoint);
      if (!inspection || inspection.centralState.state === "unarmed") {
        throw new ReleaseInvariantError(
          "REDIS_CUTOVER_SCHEDULE_LOST",
          "Redis 切换断点已确认调度，但中央状态仍为 unarmed",
        );
      }
      return;
    }

    const fleetBeforeSchedule = await this.verifyRedisRuntimeFingerprintFleet(checkpoint);
    if (!fleetBeforeSchedule) {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_COORDINATOR_MISSING",
        "Redis 切换控制面未返回中央状态",
      );
    }
    if (fleetBeforeSchedule.centralState.state !== "unarmed") {
      // Another crash-safe invocation may have committed the same immutable
      // schedule before this checkpoint bit was saved. Full marker attestation
      // above proves that treating it as idempotent success is safe.
      checkpoint.redisCutoverScheduled = true;
      checkpoint.redisCutoverState = fleetBeforeSchedule.centralState.state;
      checkpoint.redisCutoverAtMs = fleetBeforeSchedule.centralState.cutoverAtMs;
      await this.record(checkpoint, "redis-cutover.scheduled", null, {
        state: fleetBeforeSchedule.centralState.state,
        cutoverAtMs: fleetBeforeSchedule.centralState.cutoverAtMs,
        cutoverLeadMs: fleetBeforeSchedule.cutoverLeadMs,
        nodeCount: checkpoint.nodeOrder.length,
      });
      return;
    }
    if (fleetBeforeSchedule.cutoverLeadMs < REDIS_CUTOVER_FINAL_SCHEDULE_LEAD_MS) {
      // This rejection is known to occur before any schedule mutation, so it
      // remains on the rollback-safe side of redisCutoverScheduleAttempted.
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_LEAD_TOO_SHORT",
        "Redis 切换边界剩余时间不足，尚未进入不可逆调度",
      );
    }

    if (!checkpoint.redisCutoverScheduleAttempted) {
      checkpoint.redisCutoverScheduleAttempted = true;
      // This durable bit is the point of no automatic rollback: schedule()
      // may commit in PostgreSQL and lose its response. From here onward the
      // whole target fleet must stay in place until an operator proves state.
      await this.persist(checkpoint);
    }

    // Persist an immutable downgrade guard on every API and Worker before the
    // central schedule call. If PostgreSQL commits but the response is lost,
    // the restricted SSH rollback actions can no longer return any node to a
    // pre-capability artifact while the Controller awaits reconciliation.
    await this.armRedisCutoverScheduleFleet(checkpoint, fleetBeforeSchedule);

    let scheduled: RedisCutoverCoordinatorInspection;
    try {
      scheduled = await this.redisCutoverCoordinator.schedule({
        minimumLeadMs: REDIS_CUTOVER_FINAL_SCHEDULE_LEAD_MS,
      });
    } catch (error) {
      throw new ReleaseInvariantError(
        scalarCode((error as { code?: unknown } | null)?.code, "REDIS_CUTOVER_SCHEDULE_FAILED"),
        "Redis 中央切换调度失败；目标版本将保持在线等待人工核验",
      );
    }
    if (scheduled.centralState.state === "unarmed") {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_NOT_SCHEDULED",
        "Redis 中央切换调度未形成持久状态",
      );
    }
    if (scheduled.expected.contractFingerprint !== checkpoint.redisRuntimeFingerprint) {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_CONTRACT_FINGERPRINT_MISMATCH",
        "Redis 中央切换合同与已发布节点配置不一致",
      );
    }

    // Sampling readiness causes each root-owned Node Agent to observe the
    // central scheduled/active state and persist its local rollback marker.
    // Only a complete second attestation makes the checkpoint successful.
    const confirmed = await this.verifyRedisRuntimeFingerprintFleet(checkpoint);
    if (
      !confirmed
      || confirmed.centralState.state === "unarmed"
      || confirmed.centralState.cutoverAtMs !== scheduled.centralState.cutoverAtMs
    ) {
      throw new ReleaseInvariantError(
        "REDIS_CUTOVER_FLEET_CONFIRMATION_FAILED",
        "Redis 中央切换已调度，但全量节点 marker 尚未完成确认",
      );
    }
    checkpoint.redisCutoverScheduled = true;
    checkpoint.redisCutoverState = confirmed.centralState.state;
    checkpoint.redisCutoverAtMs = confirmed.centralState.cutoverAtMs;
    await this.record(checkpoint, "redis-cutover.scheduled", null, {
      state: confirmed.centralState.state,
      cutoverAtMs: confirmed.centralState.cutoverAtMs,
      cutoverLeadMs: confirmed.cutoverLeadMs,
      nodeCount: checkpoint.nodeOrder.length,
    });
  }

  private async checkCancellation(checkpoint: ReleaseCheckpoint): Promise<void> {
    if (!this.shouldCancel) return;
    if (await this.shouldCancel(clone(checkpoint))) {
      throw new ReleaseInvariantError("RELEASE_CANCELLED", "发布已在安全边界取消");
    }
  }

  private async fail(checkpoint: ReleaseCheckpoint, cause: unknown): Promise<never> {
    const failedPhase = checkpoint.phase;
    const failedNodeId = checkpoint.currentNodeId;
    const safeError: SafeReleaseError = {
      code: cause instanceof ReleaseInvariantError
        ? cause.code
        : this.errorCodeForPhase(failedPhase),
      message: redactReleaseErrorMessage(cause),
      phase: failedPhase,
      nodeId: failedNodeId,
      at: this.clock.now(),
    };

    try {
      if (checkpoint.redisCutoverScheduleAttempted) {
        // Do not roll a fully upgraded fleet back after the schedule call may
        // have crossed the durable point of no return. A timeout is ambiguous:
        // PostgreSQL may have committed even when the Controller saw an error.
        checkpoint.manualInterventionRequired = true;
        await this.persist(checkpoint);
      } else if (checkpoint.schemaMode === "schema-neutral") {
        await this.rollbackSchemaNeutralCoordinated(checkpoint, failedPhase, failedNodeId);
      } else {
        // Database state may already have advanced. Never guess that an old
        // binary remains schema-compatible; stop and require an operator.
        checkpoint.manualInterventionRequired = true;
        await this.isolateMigrationFailure(checkpoint, failedNodeId);
      }
    } catch (rollbackError) {
      checkpoint.manualInterventionRequired = true;
      await this.bestEffortRollbackFailureEvent(checkpoint, failedNodeId, rollbackError);
    }

    checkpoint.status = "failed";
    checkpoint.phase = "failed";
    checkpoint.error = safeError;
    await this.record(checkpoint, "operation.failed", failedNodeId, {
      code: safeError.code,
      manualInterventionRequired: checkpoint.manualInterventionRequired,
    });
    throw new ReleaseControllerError(safeError);
  }

  private async rollbackSchemaNeutralCoordinated(
    checkpoint: ReleaseCheckpoint,
    failedPhase: ReleasePhase,
    failedNodeId: string | null,
  ): Promise<void> {
    const apiRollbackRequired = checkpoint.nodeOrder.some((nodeId) => {
      const node = checkpoint.nodes[nodeId];
      return node.weightZeroAttempted
        || node.drainStarted
        || node.activationAttempted
        || node.activated
        || node.completed;
    });

    if (!apiRollbackRequired) {
      await this.rollbackWorkers(checkpoint, failedPhase, failedNodeId);
      return;
    }
    if (checkpoint.workerOrder.length === 0) {
      await this.rollbackSchemaNeutralRelease(checkpoint, failedPhase, failedNodeId);
      return;
    }

    // Never roll APIs back to the previous SHA until one previous-SHA Worker
    // is durably accepting work. Conversely, keep at least one target Worker
    // serving while target APIs still exist. This is the reverse of the
    // rollout bridge and prevents /api/ready from dropping the whole fleet.
    const bridgeReady = await this.ensurePreviousWorkerBridge(
      checkpoint,
      failedNodeId,
    );
    if (!bridgeReady) {
      checkpoint.manualInterventionRequired = true;
      await this.persist(checkpoint);
      return;
    }

    await this.rollbackSchemaNeutralRelease(checkpoint, failedPhase, failedNodeId);
    const apiRollbackComplete = checkpoint.nodeOrder.every((nodeId) => {
      const node = checkpoint.nodes[nodeId];
      const changed = node.weightZeroAttempted
        || node.drainStarted
        || node.activationAttempted
        || node.activated
        || node.completed;
      return !changed || node.rollbackVerified;
    });
    if (!apiRollbackComplete) {
      // Some API may still be serving the target SHA. Preserve its matching
      // target Worker bridge and stop automatic convergence.
      checkpoint.manualInterventionRequired = true;
      await this.persist(checkpoint);
      return;
    }
    await this.rollbackWorkers(checkpoint, failedPhase, failedNodeId);
  }

  private async ensurePreviousWorkerBridge(
    checkpoint: ReleaseCheckpoint,
    failedNodeId: string | null,
  ): Promise<boolean> {
    const previousShas = new Set(
      checkpoint.workerOrder.map((nodeId) => checkpoint.workers[nodeId].previousArtifactSha256),
    );
    if (previousShas.size !== 1 || previousShas.has("")) {
      checkpoint.manualInterventionRequired = true;
      return false;
    }
    const previousSha = [...previousShas][0];
    const previousSchemaVersion = expectedPreviousSchemaVersion({
      targetSchemaVersion: checkpoint.artifact.schemaVersion,
      targetArtifactSha256: checkpoint.artifact.sha256,
      bridge: checkpoint.schemaCompatibility,
    });
    const isPreviousServing = (snapshot: WorkerRuntimeSnapshot) => (
      snapshot.healthy
      && snapshot.acceptingWork
      && snapshot.artifactSha256 === previousSha
      && snapshot.observedDatabaseSchemaVersion
        === checkpoint.artifact.schemaVersion
      && snapshot.schemaRuntimeMode === "normal"
    );
    const current = await this.requireWorkerControl().listWorkers(
      this.context(checkpoint, "rollback:worker:find-previous-bridge"),
    );
    if (current.some(isPreviousServing)) return true;

    const failedWorker = failedNodeId ? checkpoint.workers[failedNodeId] : undefined;
    const bridge = failedWorker && (failedWorker.drainRequested || failedWorker.activationAttempted)
      ? failedWorker
      : [...checkpoint.workerOrder]
        .reverse()
        .map((nodeId) => checkpoint.workers[nodeId])
        .find((worker) => worker.activationAttempted || worker.activated || worker.completed);
    if (!bridge) {
      checkpoint.manualInterventionRequired = true;
      return false;
    }

    try {
      await this.restorePreviousWorker(
        checkpoint,
        bridge,
        Math.max(1, checkpoint.workerOrder.length - 1),
      );
      const verified = await this.requireWorkerControl().listWorkers(
        this.context(checkpoint, "rollback:worker:verify-previous-bridge"),
      );
      if (!verified.some(isPreviousServing)) {
        throw new ReleaseInvariantError(
          "WORKER_ROLLBACK_BRIDGE_UNAVAILABLE",
          "无法建立旧版本 Worker 回切桥",
        );
      }
      return true;
    } catch (error) {
      await this.containWorkerRollbackFailure(checkpoint, bridge, error);
      return false;
    }
  }

  private async rollbackWorkers(
    checkpoint: ReleaseCheckpoint,
    failedPhase: ReleasePhase,
    failedNodeId: string | null,
  ): Promise<void> {
    if (checkpoint.workerOrder.length === 0) return;
    const candidates: ReleaseWorkerCheckpoint[] = [];
    const selected = new Set<string>();
    const failedWorker = failedNodeId ? checkpoint.workers[failedNodeId] : undefined;
    if (failedWorker
      && !failedWorker.rollbackVerified
      && (failedWorker.drainRequested || failedWorker.activationAttempted)) {
      candidates.push(failedWorker);
      selected.add(failedWorker.nodeId);
    }
    for (const workerId of [...checkpoint.workerOrder].reverse()) {
      const worker = checkpoint.workers[workerId];
      if ((!worker.activated && !worker.activationAttempted)
        || worker.rollbackVerified
        || selected.has(workerId)) continue;
      candidates.push(worker);
      selected.add(workerId);
    }
    if (candidates.length === 0) return;

    checkpoint.phase = "rollback";
    await this.record(checkpoint, "rollback.started", failedNodeId, {
      reason: failedPhase,
      role: "worker",
      nodeCount: candidates.length,
    });
    const minimumHealthy = Math.max(1, checkpoint.workerOrder.length - 1);
    for (const worker of candidates) {
      try {
        await this.restorePreviousWorker(checkpoint, worker, minimumHealthy);
      } catch (error) {
        await this.containWorkerRollbackFailure(checkpoint, worker, error);
        break;
      }
    }
  }

  private async containWorkerRollbackFailure(
    checkpoint: ReleaseCheckpoint,
    worker: ReleaseWorkerCheckpoint,
    error: unknown,
  ): Promise<void> {
    checkpoint.manualInterventionRequired = true;
    const isolationWasVerified = worker.isolated && worker.drained && !worker.resumed;
    worker.isolated = isolationWasVerified;
    // Fail closed: a worker whose rollback cannot be proven remains under the
    // durable drain request and is never resumed speculatively.
    try {
      await this.requireWorkerControl().requestDrain(
        worker.nodeId,
        this.context(checkpoint, `rollback:worker:${worker.nodeId}:keep-drained`),
      );
      worker.drainRequested = true;
      worker.resumed = false;
      const drained = await this.requireWorkerControl().waitForDrained(
        worker.nodeId,
        this.context(checkpoint, `rollback:worker:${worker.nodeId}:verify-kept-drained`),
      );
      worker.drained = !drained.acceptingWork
        && drained.activeTaskCount === 0
        && drained.drainOperationId === checkpoint.operationId;
      worker.isolated = worker.drained;
      await this.persist(checkpoint);
    } catch {
      checkpoint.manualInterventionRequired = true;
    }
    await this.bestEffortRollbackFailureEvent(checkpoint, worker.nodeId, error);
  }

  private async restorePreviousWorker(
    checkpoint: ReleaseCheckpoint,
    worker: ReleaseWorkerCheckpoint,
    minimumHealthy: number,
  ): Promise<void> {
    const control = this.requireWorkerControl();
    const agent = this.requireWorkerNodeAgent();
    if (!worker.drainRequested || worker.resumed) {
      await control.assertHealthyCapacity(
        worker.nodeId,
        minimumHealthy,
        this.context(checkpoint, `rollback:worker:${worker.nodeId}:capacity`),
      );
      await control.requestDrain(
        worker.nodeId,
        this.context(checkpoint, `rollback:worker:${worker.nodeId}:request-drain`),
      );
      worker.drainRequested = true;
      worker.resumed = false;
      await this.persist(checkpoint);
    }
    const drained = await control.waitForDrained(
      worker.nodeId,
      this.context(checkpoint, `rollback:worker:${worker.nodeId}:wait-drained`),
    );
    if (drained.acceptingWork || drained.activeTaskCount !== 0
      || drained.drainOperationId !== checkpoint.operationId) {
      throw new ReleaseInvariantError("WORKER_ROLLBACK_DRAIN_FAILED", `Worker ${worker.nodeId} 回切排空失败`);
    }
    worker.drained = true;
    worker.isolated = true;
    await this.persist(checkpoint);

    if (worker.activationAttempted) {
      await agent.rollback(
        worker.nodeId,
        worker.previousArtifactSha256,
        checkpoint.artifact,
        this.context(checkpoint, `rollback:worker:${worker.nodeId}:activate-previous`),
      );
      worker.rolledBack = true;
      await this.persist(checkpoint);
    }
    const previousArtifactSchemaVersion = this.previousSchemaVersion(checkpoint);
    await control.waitForArtifact(
      worker.nodeId,
      this.isolatedWorkerExpectation(
        worker.previousArtifactSha256,
        previousArtifactSchemaVersion,
        checkpoint.artifact.schemaVersion,
      ),
      this.context(checkpoint, `rollback:worker:${worker.nodeId}:artifact-ready`),
    );
    await control.resume(
      worker.nodeId,
      this.context(checkpoint, `rollback:worker:${worker.nodeId}:resume`),
    );
    const serving = await control.waitForServing(
      worker.nodeId,
      this.normalWorkerExpectation(
        worker.previousArtifactSha256,
        previousArtifactSchemaVersion,
        checkpoint.artifact.schemaVersion,
      ),
      this.context(checkpoint, `rollback:worker:${worker.nodeId}:serving`),
    );
    this.assertWorkerServing(
      serving,
      this.normalWorkerExpectation(
        worker.previousArtifactSha256,
        previousArtifactSchemaVersion,
        checkpoint.artifact.schemaVersion,
      ),
    );
    worker.resumed = true;
    worker.serving = true;
    worker.isolated = false;
    worker.completed = false;
    // `rollbackVerified` is the durable "safe to report rolled back" bit.
    // Do not set it after binary identity alone: resume/serving can still
    // fail, in which case the Worker must remain drained and the UI must not
    // claim that it has returned safely to service.
    worker.rollbackVerified = true;
    await this.record(checkpoint, "rollback.completed", worker.nodeId, {
      role: "worker",
      keptIsolated: false,
    });
  }

  private async rollbackSchemaNeutralRelease(
    checkpoint: ReleaseCheckpoint,
    failedPhase: ReleasePhase,
    nodeId: string | null,
  ): Promise<void> {
    const candidates: ReleaseNodeCheckpoint[] = [];
    const selected = new Set<string>();
    const failedNode = nodeId ? checkpoint.nodes[nodeId] : undefined;

    // Recover the node that was removed from service first. It becomes the
    // known-old capacity needed to roll earlier nodes back without downtime.
    if (
      failedPhase === "rolling"
      && failedNode
      && (failedNode.weightZeroAttempted || failedNode.activationAttempted)
    ) {
      candidates.push(failedNode);
      selected.add(failedNode.nodeId);
    }
    for (const candidateId of [...checkpoint.nodeOrder].reverse()) {
      const candidate = checkpoint.nodes[candidateId];
      if (!candidate.activated || candidate.rollbackVerified || selected.has(candidateId)) continue;
      candidates.push(candidate);
      selected.add(candidateId);
    }
    if (candidates.length === 0) return;

    checkpoint.phase = "rollback";
    await this.record(checkpoint, "rollback.started", nodeId, {
      reason: failedPhase === "public-smoke" ? "public-smoke" : "rolling-failure",
      nodeCount: candidates.length,
    });

    for (const node of candidates) {
      let isolationAttempted = false;
      try {
        if (!node.weightZero) {
          await this.confirmOtherNodesHealthy(checkpoint, node.nodeId);
        }
        isolationAttempted = true;
        await this.restorePreviousArtifact(checkpoint, node);
      } catch (error) {
        checkpoint.manualInterventionRequired = true;
        if (isolationAttempted) {
          // Do not claim isolation until CLB has acknowledged weight zero.
          // If both attempts fail, the checkpoint must show the uncertainty so
          // operators do not assume that a broken node is safely out of flow.
          await this.bestEffortSetWeightZero(checkpoint, node);
        }
        await this.bestEffortRollbackFailureEvent(checkpoint, node.nodeId, error);
        // Never remove the last serving node after a recovery failure.
        break;
      }
    }
  }

  private async restorePreviousArtifact(
    checkpoint: ReleaseCheckpoint,
    node: ReleaseNodeCheckpoint,
  ): Promise<void> {
    await this.ensureIsolated(checkpoint, node);

    const propagation = await this.loadBalancer.waitForDrain(
      node.nodeId,
      this.context(checkpoint, `rollback:${node.nodeId}:weight-zero-propagated`),
    );
    if (!propagation.drained) {
      throw new ReleaseInvariantError(
        "ROLLBACK_WEIGHT_ZERO_NOT_PROPAGATED",
        `节点 ${node.nodeId} 回切摘流权重未生效`,
      );
    }

    if (node.activationAttempted) {
      const identity = await this.nodeAgent.preflight(
        node.nodeId,
        checkpoint.artifact,
        checkpoint.schemaMode,
        this.context(checkpoint, `rollback:${node.nodeId}:identity`),
        { allowTargetCurrent: true },
      );
      const currentSha = identity.currentArtifactSha256;
      if (currentSha !== checkpoint.artifact.sha256 && currentSha !== node.previousArtifactSha256) {
        throw new ReleaseInvariantError(
          "ROLLBACK_CURRENT_ARTIFACT_CONFLICT",
          `节点 ${node.nodeId} 回切前版本身份未知`,
        );
      }
      await this.waitForApplicationDrain(
        checkpoint,
        node,
        `rollback:${node.nodeId}`,
        currentSha,
      );
      await this.nodeAgent.rollback(
        node.nodeId,
        node.previousArtifactSha256,
        this.context(checkpoint, `rollback:${node.nodeId}:activate-previous`),
      );
      node.rolledBack = true;
      await this.persist(checkpoint);
    }

    await this.cancelApplicationDrain(checkpoint, node, node.previousArtifactSha256);

    // If failure happened before activation (for example, drain timeout), the
    // node is already on the old release. It still must prove the exact old SHA
    // before receiving traffic again.
    const ready = await this.nodeAgent.directReadiness(
      node.nodeId,
      this.context(checkpoint, `rollback:${node.nodeId}:direct-ready`),
    );
    if (!ready.ready || ready.artifactSha256 !== node.previousArtifactSha256) {
      throw new ReleaseInvariantError(
        "ROLLBACK_ARTIFACT_NOT_READY",
        `节点 ${node.nodeId} 回切版本未通过直连校验`,
      );
    }

    await this.loadBalancer.setWeight(
      node.nodeId,
      node.originalWeight,
      this.context(checkpoint, `rollback:${node.nodeId}:restore-weight`),
    );
    node.weightZero = false;
    node.weightRestored = true;
    node.isolated = false;
    await this.persist(checkpoint);
    await this.confirmRollbackUp(checkpoint, node);
    node.completed = false;
    // Exact old-SHA readiness is necessary but not sufficient. The node is
    // only durably "rolled back" after its original CLB weight is restored
    // and the required consecutive health confirmations have passed.
    node.rollbackVerified = true;
    await this.record(checkpoint, "rollback.completed", node.nodeId, {
      keptIsolated: false,
    });
  }

  private async confirmRollbackUp(
    checkpoint: ReleaseCheckpoint,
    node: ReleaseNodeCheckpoint,
  ): Promise<void> {
    for (let confirmation = 1; confirmation <= this.policy.clbUpConfirmations; confirmation += 1) {
      const backend = await this.loadBalancer.getBackend(
        node.nodeId,
        this.context(checkpoint, `rollback:${node.nodeId}:clb-up:${confirmation}`),
      );
      this.assertServingBackend(backend, node);
      if (confirmation < this.policy.clbUpConfirmations) {
        await this.clock.sleep(this.policy.clbPollIntervalMs);
      }
    }
  }

  private async isolateMigrationFailure(
    checkpoint: ReleaseCheckpoint,
    _nodeId: string | null,
  ): Promise<void> {
    const failures: unknown[] = [];

    // `currentNodeId` is routinely null during DDL and after a Controller
    // crash. Containment must therefore derive every target binary from the
    // durable checkpoint plus a fresh heartbeat sample, never from one cursor.
    let observedTargetWorkers = new Set<string>();
    if (checkpoint.workerOrder.length > 0 && this.workerControlPlane) {
      try {
        const snapshots = await this.workerControlPlane.listWorkers(
          this.context(checkpoint, "migration-failure:list-workers"),
        );
        observedTargetWorkers = new Set(
          snapshots
            .filter((snapshot) => (
              snapshot.artifactSha256 === checkpoint.artifact.sha256
            ))
            .map((snapshot) => snapshot.nodeId),
        );
      } catch (error) {
        failures.push(error);
      }
    }

    if (this.workerControlPlane) {
      for (const workerId of checkpoint.workerOrder) {
        const worker = checkpoint.workers[workerId];
        const isTarget = observedTargetWorkers.has(workerId)
          || worker.activationAttempted
          || worker.activated
          || worker.artifactReady
          || worker.completed;
        if (!isTarget) continue;
        try {
          await this.workerControlPlane.requestDrain(
            workerId,
            this.context(
              checkpoint,
              `migration-failure:${workerId}:request-drain`,
            ),
          );
          worker.drainRequested = true;
          worker.resumed = false;
          worker.serving = false;
          worker.completed = false;
          const drained = await this.workerControlPlane.waitForDrained(
            workerId,
            this.context(
              checkpoint,
              `migration-failure:${workerId}:wait-drained`,
            ),
          );
          worker.drained = drained.healthy
            && !drained.acceptingWork
            && drained.activeTaskCount === 0
            && drained.drainOperationId === checkpoint.operationId;
          worker.isolated = worker.drained;
          await this.persist(checkpoint);
        } catch (error) {
          worker.isolated = false;
          failures.push(error);
        }
      }
    }

    // An interrupted API roll can leave more than the cursor node on the
    // target SHA. Isolate every node whose target activation may have crossed
    // the atomic pointer switch; untouched N-1 nodes retain traffic.
    for (const apiNodeId of checkpoint.nodeOrder) {
      const node = checkpoint.nodes[apiNodeId];
      if (
        !node
        || !(
          node.activationAttempted
          || node.activated
          || node.directReady
          || node.completed
        )
      ) continue;
      try {
        await this.ensureIsolated(checkpoint, node);
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new ReleaseInvariantError(
        "SCHEMA_MIGRATION_CONTAINMENT_INCOMPLETE",
        "迁移失败后部分目标节点未能证明已隔离",
      );
    }
    // No rollback: an irreversible/unknown migration makes the previous binary
    // unsafe until an operator proves schema compatibility.
  }

  private async ensureIsolated(
    checkpoint: ReleaseCheckpoint,
    node: ReleaseNodeCheckpoint,
  ): Promise<void> {
    await this.loadBalancer.setWeight(
      node.nodeId,
      0,
      this.context(checkpoint, `rollback:${node.nodeId}:isolate`),
    );
    node.weightZero = true;
    node.weightRestored = false;
    node.isolated = true;
    await this.persist(checkpoint);
  }

  private async bestEffortSetWeightZero(
    checkpoint: ReleaseCheckpoint,
    node: ReleaseNodeCheckpoint,
  ): Promise<void> {
    try {
      await this.loadBalancer.setWeight(
        node.nodeId,
        0,
        this.context(checkpoint, `rollback:${node.nodeId}:isolate-after-failure`),
      );
      node.weightZero = true;
      node.weightRestored = false;
      node.isolated = true;
      await this.persist(checkpoint);
    } catch {
      checkpoint.manualInterventionRequired = true;
    }
  }

  private async bestEffortRollbackFailureEvent(
    checkpoint: ReleaseCheckpoint,
    nodeId: string | null,
    error: unknown,
  ): Promise<void> {
    try {
      await this.record(checkpoint, "rollback.failed", nodeId, {
        // The value is redacted before crossing the persistence boundary.
        error: redactReleaseErrorMessage(error),
      });
    } catch {
      // If the store is unavailable, the sanitized top-level exception still
      // propagates. Do not replace it with a second persistence error.
    }
  }

  private errorCodeForPhase(phase: ReleasePhase): string {
    switch (phase) {
      case "preflight": return "PREFLIGHT_FAILED";
      case "stage": return "STAGE_FAILED";
      case "schema-migration": return "SCHEMA_MIGRATION_FAILED";
      case "rolling": return "ROLLING_STEP_FAILED";
      case "worker-rolling": return "WORKER_ROLLING_STEP_FAILED";
      case "public-smoke": return "PUBLIC_SMOKE_FAILED";
      case "redis-cutover": return "REDIS_CUTOVER_FAILED";
      case "rollback": return "ROLLBACK_FAILED";
      default: return "RELEASE_FAILED";
    }
  }

  private async record(
    checkpoint: ReleaseCheckpoint,
    type: ReleaseEventType,
    nodeId: string | null = null,
    observations?: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    checkpoint.events.push({
      sequence: (checkpoint.events.at(-1)?.sequence || 0) + 1,
      operationId: checkpoint.operationId,
      type,
      phase: checkpoint.phase,
      nodeId,
      at: this.clock.now(),
      ...(observations ? { observations: clone(observations) } : {}),
    });
    await this.persist(checkpoint);
  }

  private async persist(checkpoint: ReleaseCheckpoint): Promise<void> {
    const expectedRevision = checkpoint.revision;
    checkpoint.updatedAt = this.clock.now();
    const saved = await this.store.save(clone(checkpoint), expectedRevision);
    // Keep nested object identities stable while a node step is in progress.
    // Replacing `nodes` here would leave rollNode holding a stale node object
    // after its first checkpoint. The store may only advance persistence
    // metadata; release state remains controller-authored.
    checkpoint.revision = saved.revision;
    checkpoint.updatedAt = saved.updatedAt;
    await this.notify(checkpoint);
  }

  private async notify(checkpoint: ReleaseCheckpoint): Promise<void> {
    if (!this.observer) return;
    try {
      await this.observer(clone(checkpoint));
    } catch {
      // Monitoring must not be able to mutate or abort a production rollout.
    }
  }
}

export { RollingReleaseController as ReleaseController };
