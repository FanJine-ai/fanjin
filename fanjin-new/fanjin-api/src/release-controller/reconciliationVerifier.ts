import type {
  ReleaseDeploymentReconciliationClaim,
  ReleaseReconciliationEvidence,
} from "@/lib/releaseDeploymentReconciliation";
import type { ReleaseArtifactRecord } from "@/lib/releaseDeployments";
import { defaultReleaseSchemaCompatibility } from "@/lib/releaseSchemaCompatibility";

import type {
  LoadBalancer,
  NodeAgent,
  NodePreflightResult,
  ReleaseActionContext,
  ReleaseArtifact,
  WorkerControlPlane,
  WorkerNodeAgent,
  WorkerRuntimeSnapshot,
} from "./types";
import type {
  RedisCutoverCoordinator,
  RedisCutoverCoordinatorInspection,
} from "./redisCutoverCoordinator";
import {
  releaseSchemaCompatibilityProofSha256,
  schemaCompatibilitySupports,
} from "./schemaCompatibility";

const REDIS_RATE_LIMIT_CAPABILITY = "redis-rate-limit-v1";
const RUNTIME_CAPABILITY_RE =
  /^(?=.{1,64}$)[a-z][a-z0-9-]*(?:[._][a-z0-9][a-z0-9-]*)*$/;
const REDIS_TIME_SAMPLE_MAX_SPAN_MS = 30_000;

export class ReleaseReconciliationVerificationError extends Error {
  readonly code: string;
  readonly evidence: Record<string, unknown>;

  constructor(code: string, message: string, evidence: Record<string, unknown> = {}) {
    super(message);
    this.name = "ReleaseReconciliationVerificationError";
    this.code = code;
    this.evidence = evidence;
  }
}

function exactInventory(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactCapabilities(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseRuntimeCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const capabilities: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !RUNTIME_CAPABILITY_RE.test(entry)) return null;
    capabilities.push(entry);
  }
  if (new Set(capabilities).size !== capabilities.length) return null;
  return capabilities.sort();
}

function sameCentralInspection(
  left: RedisCutoverCoordinatorInspection,
  right: RedisCutoverCoordinatorInspection,
): boolean {
  return left.centralState.state === right.centralState.state
    && left.centralState.contractFingerprint === right.centralState.contractFingerprint
    && left.centralState.cutoverAtMs === right.centralState.cutoverAtMs
    && left.centralState.scheduledAtRedisMs === right.centralState.scheduledAtRedisMs
    && left.centralState.activatedAtRedisMs === right.centralState.activatedAtRedisMs
    && left.expected.contractFingerprint === right.expected.contractFingerprint
    && left.expected.cutoverAtMs === right.expected.cutoverAtMs
    && left.expected.ttlGraceMs === right.expected.ttlGraceMs
    && left.expected.mode === right.expected.mode
    && exactInventory(left.expected.windowsMs.map(String), right.expected.windowsMs.map(String));
}

/**
 * Reconciliation never resumes activation or rollback. Its bounded recovery
 * mutations are:
 * - fail-closed containment for an incomplete migration; and
 * - releasing a stale Worker drain fence only when a schema-neutral
 *   previous-intent fleet already reports the exact registered previous
 *   artifact and the fence is still owned by the original deployment.
 *
 * Once the central Redis latch is armed, reconciliation may also perform the
 * monotonic, idempotent marker observation needed to make that irreversible
 * global fact locally enforceable. A successful reconciliation otherwise only
 * proves a fully converged target or pre-migration previous fleet.
 */
export class ReleaseReconciliationVerifier {
  private readonly loadBalancer: LoadBalancer;
  private readonly nodeAgent: NodeAgent;
  private readonly workerControl: WorkerControlPlane;
  private readonly workerRedisCutoverObserver?: Pick<WorkerNodeAgent, "observeRedisCutover">;
  private readonly redisCutoverCoordinator: RedisCutoverCoordinator;

  constructor(options: {
    loadBalancer: LoadBalancer;
    nodeAgent: NodeAgent;
    workerControl: WorkerControlPlane;
    workerRedisCutoverObserver?: Pick<WorkerNodeAgent, "observeRedisCutover">;
    redisCutoverCoordinator: RedisCutoverCoordinator;
  }) {
    this.loadBalancer = options.loadBalancer;
    this.nodeAgent = options.nodeAgent;
    this.workerControl = options.workerControl;
    this.workerRedisCutoverObserver = options.workerRedisCutoverObserver;
    this.redisCutoverCoordinator = options.redisCutoverCoordinator;
  }

  private async resumeExactSchemaNeutralPreviousWorkers(input: {
    claim: ReleaseDeploymentReconciliationClaim;
    artifact: ReleaseArtifactRecord;
    workers: readonly WorkerRuntimeSnapshot[];
    expectedWorkerIds: readonly string[];
  }): Promise<readonly WorkerRuntimeSnapshot[]> {
    const { claim, artifact, workers, expectedWorkerIds } = input;
    if (
      claim.reconciliation.intent !== "previous"
      || artifact.manifest.schemaMode !== "schema-neutral"
    ) {
      return workers;
    }
    const compatibility = artifact.manifest.schemaCompatibility
      ?? defaultReleaseSchemaCompatibility(artifact.manifest.schemaVersion);
    const recoverable = workers.filter((worker) => (
      worker.healthy
      && !worker.acceptingWork
      && worker.activeTaskCount === 0
      && worker.artifactSha256 === artifact.sha256
      && worker.schemaRuntimeMode === "isolated"
      && worker.drainOperationId === claim.deployment.id
      && schemaCompatibilitySupports(
        compatibility,
        worker.observedDatabaseSchemaVersion,
      )
    ));
    if (recoverable.length === 0) return workers;

    for (const worker of recoverable) {
      const context: ReleaseActionContext = {
        operationId: claim.deployment.id,
        actionId: `${claim.reconciliation.id}:resume-previous:${worker.nodeId}`,
        artifactSha256: artifact.sha256,
      };
      try {
        await this.workerControl.resume(worker.nodeId, context);
        await this.workerControl.waitForServing(
          worker.nodeId,
          {
            artifactSha256: artifact.sha256,
            targetSchemaVersion: artifact.manifest.schemaVersion,
            observedDatabaseSchemaVersion: worker.observedDatabaseSchemaVersion,
            runtimeMode: "normal",
          },
          context,
        );
      } catch {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_WORKER_RESUME_FAILED",
          `Worker target ${worker.nodeId} could not release the stale deployment drain fence`,
          { nodeId: worker.nodeId },
        );
      }
    }

    const refreshed = await this.workerControl.listWorkers({
      operationId: claim.deployment.id,
      actionId: `${claim.reconciliation.id}:resume-previous:verify`,
      artifactSha256: artifact.sha256,
    });
    if (!exactInventory(refreshed.map((worker) => worker.nodeId), expectedWorkerIds)) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_WORKER_INVENTORY_MISMATCH",
        "Worker inventory changed while stale drain fences were being released",
        {
          expectedWorkerIds,
          observedWorkerIds: refreshed.map((worker) => worker.nodeId),
        },
      );
    }
    return refreshed;
  }

  /**
   * A Root-authored reconciliation may contain a crashed migration rollout,
   * but it never resumes arbitrary CLB/SSH activation steps. If the fleet is
   * not already fully converged on the target, isolate every node that either
   * reports the target SHA or crossed an activation-attempt checkpoint, while
   * retaining a proven N-1 API/Worker pair. The thrown evidence is persisted
   * on the failed reconciliation and the production scope remains locked.
   */
  async containIncompleteMigration(input: {
    claim: ReleaseDeploymentReconciliationClaim;
    targetArtifact: ReleaseArtifactRecord;
    previousArtifact: ReleaseArtifactRecord | null;
  }): Promise<void> {
    const { claim, targetArtifact, previousArtifact } = input;
    const checkpoint = claim.deployment.checkpoint;
    const plan = claim.deployment.plan;
    const schemaMode = String(plan.artifactSchemaMode ?? "schema-neutral");
    if (schemaMode !== "migration") return;
    if (
      !checkpoint
      || checkpoint.operationId !== claim.deployment.id
      || checkpoint.schemaMode !== "migration"
      || checkpoint.artifact.id !== targetArtifact.id
      || checkpoint.artifact.sha256 !== targetArtifact.sha256
      || checkpoint.artifact.schemaVersion !== targetArtifact.manifest.schemaVersion
      || !previousArtifact
      || checkpoint.previousArtifact?.id !== previousArtifact.id
      || checkpoint.previousArtifact.sha256 !== previousArtifact.sha256
    ) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_CHECKPOINT_IDENTITY_INVALID",
        "migration reconciliation checkpoint does not bind the registered target and previous artifacts",
      );
    }

    const expectedApiIds = plan.targets
      .filter((target) => target.role === "api")
      .map((target) => target.key);
    const expectedWorkerIds = plan.targets
      .filter((target) => target.role === "worker")
      .map((target) => target.key);
    if (
      expectedWorkerIds.length < 2
      || !exactInventory(checkpoint.workerOrder, expectedWorkerIds)
      || !exactInventory(Object.keys(checkpoint.workers), expectedWorkerIds)
    ) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_MIGRATION_WORKER_INVENTORY_REQUIRED",
        "migration reconciliation requires the exact dedicated Worker inventory from the immutable plan",
        {
          expectedWorkerIds,
          checkpointWorkerIds: checkpoint.workerOrder,
        },
      );
    }
    const context: ReleaseActionContext = {
      // Reclaim an existing bridge/drain fence under the original operation.
      // The reconciliation id remains visible in the bounded action id.
      operationId: claim.deployment.id,
      actionId: `${claim.reconciliation.id}:contain-migration`,
      artifactSha256: targetArtifact.sha256,
    };
    const targetReleaseArtifact: ReleaseArtifact = {
      id: targetArtifact.id,
      version: targetArtifact.manifest.releaseId,
      sha256: targetArtifact.sha256,
      schemaVersion: targetArtifact.manifest.schemaVersion,
      schemaMode: targetArtifact.manifest.schemaMode,
      schemaCompatibility: targetArtifact.manifest.schemaCompatibility,
      workerProtocolVersion: targetArtifact.manifest.workerProtocolVersion,
      runtimeCapabilities: [...targetArtifact.manifest.runtimeCapabilities],
    };
    const [backends, workers] = await Promise.all([
      this.loadBalancer.listBackends(context),
      this.workerControl.listWorkers(context),
    ]);
    if (!exactInventory(backends.map((backend) => backend.nodeId), expectedApiIds)
      || !exactInventory(workers.map((worker) => worker.nodeId), expectedWorkerIds)) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_CONTAINMENT_INVENTORY_MISMATCH",
        "cannot contain migration targets while API or Worker inventory differs from the immutable plan",
        {
          expectedApiIds,
          observedApiIds: backends.map((backend) => backend.nodeId),
          expectedWorkerIds,
          observedWorkerIds: workers.map((worker) => worker.nodeId),
        },
      );
    }

    const apiObservations = await Promise.all(expectedApiIds.map(async (nodeId) => {
      try {
        const result = await this.nodeAgent.preflight(
          nodeId,
          targetReleaseArtifact,
          "migration",
          {
            ...context,
            actionId: `${context.actionId}:api:${nodeId}`,
          },
        );
        return { nodeId, result };
      } catch {
        return {
          nodeId,
          result: {
            ok: false,
            currentArtifactSha256: "",
            code: "NODE_PREFLIGHT_UNAVAILABLE",
          } satisfies NodePreflightResult,
        };
      }
    }));
    const targetSchemaVersion = targetArtifact.manifest.schemaVersion;
    const allTargetApis = apiObservations.every(({ nodeId, result }) => {
      const backend = backends.find((candidate) => candidate.nodeId === nodeId)!;
      return result.ok
        && result.currentArtifactSha256 === targetArtifact.sha256
        && backend.health === "up"
        && backend.weight > 0;
    });
    const allTargetWorkers = workers.every((worker) => (
      worker.healthy
      && worker.acceptingWork
      && worker.artifactSha256 === targetArtifact.sha256
      && worker.observedDatabaseSchemaVersion === targetSchemaVersion
      && worker.targetSchemaVersion === targetSchemaVersion
      && worker.schemaRuntimeMode === "normal"
      && worker.bridgeOperationId === null
    ));
    if (
      claim.reconciliation.intent === "target"
      && allTargetApis
      && allTargetWorkers
    ) {
      return;
    }
    const allPreviousApis = apiObservations.every(({ nodeId, result }) => {
      const backend = backends.find((candidate) => candidate.nodeId === nodeId)!;
      return result.ok
        && result.currentArtifactSha256 === previousArtifact.sha256
        && backend.health === "up"
        && backend.weight > 0;
    });
    const allPreviousWorkers = workers.every((worker) => (
      worker.healthy
      && worker.acceptingWork
      && worker.artifactSha256 === previousArtifact.sha256
      && worker.observedDatabaseSchemaVersion
        === previousArtifact.manifest.schemaVersion
      && worker.targetSchemaVersion === previousArtifact.manifest.schemaVersion
      && worker.schemaRuntimeMode === "normal"
      && worker.bridgeOperationId === null
    ));
    if (
      claim.reconciliation.intent === "previous"
      && allPreviousApis
      && allPreviousWorkers
    ) {
      return;
    }

    const checkpointTargetApis = new Set(
      Object.values(checkpoint.nodes)
        .filter((node) => (
          node.activationAttempted
          || node.activated
          || node.directReady
          || node.completed
        ))
        .map((node) => node.nodeId),
    );
    const targetApiIds = apiObservations
      .filter(({ nodeId, result }) => (
        result.currentArtifactSha256 === targetArtifact.sha256
        || checkpointTargetApis.has(nodeId)
      ))
      .map(({ nodeId }) => nodeId);
    const checkpointTargetWorkers = new Set(
      Object.values(checkpoint.workers)
        .filter((worker) => (
          worker.activationAttempted
          || worker.activated
          || worker.artifactReady
          || worker.completed
        ))
        .map((worker) => worker.nodeId),
    );
    const targetWorkerIds = workers
      .filter((worker) => (
        worker.artifactSha256 === targetArtifact.sha256
        || checkpointTargetWorkers.has(worker.nodeId)
      ))
      .map((worker) => worker.nodeId);

    const previousProof = releaseSchemaCompatibilityProofSha256(
      previousArtifact.manifest.schemaCompatibility
        ?? defaultReleaseSchemaCompatibility(
          previousArtifact.manifest.schemaVersion,
        ),
    );
    const preservedOldWorkers = workers.filter((worker) => (
      !targetWorkerIds.includes(worker.nodeId)
      && worker.healthy
      && worker.acceptingWork
      && worker.artifactSha256 === previousArtifact.sha256
      && schemaCompatibilitySupports(
        previousArtifact.manifest.schemaCompatibility
          ?? defaultReleaseSchemaCompatibility(
            previousArtifact.manifest.schemaVersion,
          ),
        worker.observedDatabaseSchemaVersion,
      )
      && worker.targetSchemaVersion === previousArtifact.manifest.schemaVersion
      && (
        (
          worker.schemaRuntimeMode === "normal"
          && worker.observedDatabaseSchemaVersion
            === previousArtifact.manifest.schemaVersion
          && worker.bridgeOperationId === null
        )
        || (
          worker.schemaRuntimeMode === "migration-bridge"
          && worker.bridgeOperationId === claim.deployment.id
          && worker.bridgeCompatibilityProofSha256 === previousProof
        )
      )
    )).map((worker) => worker.nodeId);
    const preservedOldApis = apiObservations.filter(({ nodeId, result }) => {
      const backend = backends.find((candidate) => candidate.nodeId === nodeId)!;
      return !targetApiIds.includes(nodeId)
        && result.ok
        && result.currentArtifactSha256 === previousArtifact.sha256
        && backend.health === "up"
        && backend.weight > 0;
    }).map(({ nodeId }) => nodeId);
    const hasPossibleTarget =
      targetWorkerIds.length > 0 || targetApiIds.length > 0;
    if (
      hasPossibleTarget
      && (preservedOldWorkers.length < 1 || preservedOldApis.length < 1)
    ) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_CONTAINMENT_CAPACITY_UNPROVEN",
        "migration targets cannot be isolated without a proven serving N-1 API/Worker pair",
        {
          targetApiIds,
          targetWorkerIds,
          preservedOldApis,
          preservedOldWorkers,
        },
      );
    }

    const isolatedTargetWorkers: string[] = [];
    for (const nodeId of targetWorkerIds) {
      await this.workerControl.requestDrain(nodeId, {
        ...context,
        actionId: `${context.actionId}:worker:${nodeId}:request-drain`,
      });
      const drained = await this.workerControl.waitForDrained(nodeId, {
        ...context,
        actionId: `${context.actionId}:worker:${nodeId}:wait-drained`,
      });
      if (
        !drained.healthy
        || drained.acceptingWork
        || drained.activeTaskCount !== 0
        || drained.drainOperationId !== claim.deployment.id
      ) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_CONTAINMENT_INCOMPLETE",
          `target Worker ${nodeId} did not prove durable isolation`,
          { nodeId, isolatedTargetWorkers },
        );
      }
      isolatedTargetWorkers.push(nodeId);
    }

    const isolatedTargetApis: string[] = [];
    for (const nodeId of targetApiIds) {
      await this.loadBalancer.setWeight(nodeId, 0, {
        ...context,
        actionId: `${context.actionId}:api:${nodeId}:isolate`,
      });
      const backend = await this.loadBalancer.getBackend(nodeId, {
        ...context,
        actionId: `${context.actionId}:api:${nodeId}:verify-isolated`,
      });
      if (backend.weight !== 0) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_CONTAINMENT_INCOMPLETE",
          `target API ${nodeId} did not prove CLB isolation`,
          { nodeId, isolatedTargetApis, isolatedTargetWorkers },
        );
      }
      isolatedTargetApis.push(nodeId);
    }
    throw new ReleaseReconciliationVerificationError(
      "RELEASE_RECONCILE_MIGRATION_TARGETS_ISOLATED",
      "migration target nodes are durably isolated; production lock remains for fix-forward",
      {
        targetSchemaVersion,
        isolatedTargetApis,
        isolatedTargetWorkers,
        preservedOldApis,
        preservedOldWorkers,
      },
    );
  }

  private async inspectRedisCutover(): Promise<RedisCutoverCoordinatorInspection> {
    try {
      return await this.redisCutoverCoordinator.inspect();
    } catch {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_REDIS_CENTRAL_UNAVAILABLE",
        "central Redis cutover state is unavailable or invalid",
      );
    }
  }

  private assertArtifactCompatibleWithCutover(
    artifact: ReleaseArtifactRecord,
    inspection: RedisCutoverCoordinatorInspection,
  ): void {
    if (
      inspection.centralState.state !== "unarmed"
      && !artifact.manifest.runtimeCapabilities.includes(REDIS_RATE_LIMIT_CAPABILITY)
    ) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_REDIS_ARTIFACT_CAPABILITY_MISSING",
        "chosen reconciliation artifact cannot serve the irreversible Redis cutover contract",
        { artifactId: artifact.id, centralState: inspection.centralState.state },
      );
    }
  }

  private assertApiRedisState(input: {
    artifact: ReleaseArtifactRecord;
    inspection: RedisCutoverCoordinatorInspection;
    nodeId: string;
    result: NodePreflightResult;
  }): void {
    const { artifact, inspection, nodeId, result } = input;
    if (!result.ok || result.currentArtifactSha256 !== artifact.sha256) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_API_SHA_MISMATCH",
        `API target ${nodeId} does not serve the chosen artifact`,
        {
          nodeId,
          observedArtifactSha256: result.currentArtifactSha256,
          preflightOk: result.ok,
          code: result.code || null,
        },
      );
    }
    if (result.redisRuntimeFingerprint !== inspection.expected.contractFingerprint) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_REDIS_FINGERPRINT_MISMATCH",
        `API target ${nodeId} does not match the central Redis runtime contract`,
        { nodeId },
      );
    }

    const central = inspection.centralState;
    const marker = result.redisRateLimitCutoverMarker ?? null;
    const capabilities = result.runtimeCapabilities === undefined
      ? null
      : parseRuntimeCapabilities(result.runtimeCapabilities);
    const artifactCapabilities = parseRuntimeCapabilities(artifact.manifest.runtimeCapabilities);
    if (artifactCapabilities === null) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_REDIS_ARTIFACT_CAPABILITIES_INVALID",
        "chosen reconciliation artifact has an invalid signed runtime capability set",
        { artifactId: artifact.id },
      );
    }
    const artifactIsCapable = artifactCapabilities.includes(REDIS_RATE_LIMIT_CAPABILITY);
    const nodeIsCapable = capabilities?.includes(REDIS_RATE_LIMIT_CAPABILITY) === true;
    const attestation = result.redisRateLimitCutover ?? null;

    if (central.state === "unarmed") {
      if (marker !== null) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_REDIS_MARKER_PREMATURE",
          `API target ${nodeId} has an irreversible marker while the central latch is unarmed`,
          { nodeId },
        );
      }
      // A legacy, signed artifact can still be selected before the point of no
      // return. A capable artifact cannot hide or omit its runtime identity.
      if (
        artifactIsCapable
          ? capabilities === null || !exactCapabilities(capabilities, artifactCapabilities)
          : capabilities !== null && !exactCapabilities(capabilities, artifactCapabilities)
      ) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_REDIS_CAPABILITY_MISMATCH",
          `API target ${nodeId} runtime capabilities do not match the signed artifact`,
          { nodeId },
        );
      }
      if (artifactIsCapable || nodeIsCapable || attestation !== null) {
        if (
          !artifactIsCapable
          || !nodeIsCapable
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
          throw new ReleaseReconciliationVerificationError(
            "RELEASE_RECONCILE_REDIS_NODE_STATE_MISMATCH",
            `API target ${nodeId} did not prove the central Redis latch is unarmed`,
            { nodeId },
          );
        }
      }
      return;
    }

    if (
      capabilities === null
      || !nodeIsCapable
      || !exactCapabilities(capabilities, artifactCapabilities)
    ) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_REDIS_CAPABILITY_MISMATCH",
        `API target ${nodeId} runtime capabilities do not match the signed artifact`,
        { nodeId },
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
      || Math.abs(attestation.redisServerTimeMs - inspection.redisTimeMs) > REDIS_TIME_SAMPLE_MAX_SPAN_MS
      || attestation.errorCode !== null
    ) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_REDIS_NODE_STATE_MISMATCH",
        `API target ${nodeId} Redis cutover attestation does not match the central latch`,
        { nodeId },
      );
    }
    if (
      marker === null
      || marker.format !== "fanjin-redis-rate-limit-cutover/v1"
      || marker.cutoverAtMs !== central.cutoverAtMs
      || marker.redisRuntimeFingerprint !== inspection.expected.contractFingerprint
    ) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_REDIS_MARKER_MISMATCH",
        `API target ${nodeId} does not have the matching irreversible Redis cutover marker`,
        { nodeId },
      );
    }
  }

  private async verifyApiFleet(input: {
    artifact: ReleaseArtifactRecord;
    releaseArtifact: ReleaseArtifact;
    context: ReleaseActionContext;
    expectedApiIds: readonly string[];
    backends: Awaited<ReturnType<LoadBalancer["listBackends"]>>;
  }): Promise<{
    inspection: RedisCutoverCoordinatorInspection;
    apiNodes: ReleaseReconciliationEvidence["apiNodes"];
  }> {
    const { artifact, releaseArtifact, context, expectedApiIds, backends } = input;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const before = await this.inspectRedisCutover();
      this.assertArtifactCompatibleWithCutover(artifact, before);
      const observations: Array<{ nodeId: string; result: NodePreflightResult }> = [];
      for (const nodeId of expectedApiIds) {
        const result = await this.nodeAgent.preflight(
          nodeId,
          releaseArtifact,
          artifact.manifest.schemaMode,
          {
            ...context,
            actionId: `${context.actionId}:redis-preflight:${attempt}:${nodeId}`,
          },
        );
        observations.push({ nodeId, result });
      }
      if (before.centralState.state !== "unarmed") {
        const observer = this.nodeAgent.observeRedisCutover;
        if (typeof observer !== "function") {
          throw new ReleaseReconciliationVerificationError(
            "RELEASE_RECONCILE_REDIS_API_OBSERVER_MISSING",
            "armed Redis reconciliation requires the bounded API marker observer",
          );
        }
        const expectedMarker = {
          format: "fanjin-redis-rate-limit-cutover/v1" as const,
          cutoverAtMs: before.centralState.cutoverAtMs,
          redisRuntimeFingerprint: before.expected.contractFingerprint,
        };
        for (const observation of observations) {
          let markerObservation: Awaited<ReturnType<typeof observer>>;
          try {
            markerObservation = await observer.call(
              this.nodeAgent,
              observation.nodeId,
              expectedMarker,
              {
                ...context,
                actionId: `${context.actionId}:redis-api-observe:${attempt}:${observation.nodeId}`,
              },
            );
          } catch {
            throw new ReleaseReconciliationVerificationError(
              "RELEASE_RECONCILE_REDIS_API_OBSERVATION_FAILED",
              `API target ${observation.nodeId} could not persist the armed Redis marker`,
              { nodeId: observation.nodeId },
            );
          }
          if (
            markerObservation.nodeId !== observation.nodeId
            || markerObservation.currentArtifactSha256 !== artifact.sha256
            || markerObservation.redisRuntimeFingerprint !== expectedMarker.redisRuntimeFingerprint
            || markerObservation.marker.format !== expectedMarker.format
            || markerObservation.marker.cutoverAtMs !== expectedMarker.cutoverAtMs
            || markerObservation.marker.redisRuntimeFingerprint !== expectedMarker.redisRuntimeFingerprint
          ) {
            throw new ReleaseReconciliationVerificationError(
              "RELEASE_RECONCILE_REDIS_API_MARKER_MISMATCH",
              `API target ${observation.nodeId} Redis marker proof does not match the chosen artifact`,
              { nodeId: observation.nodeId },
            );
          }
          observation.result.redisRateLimitCutoverMarker = markerObservation.marker;
        }
      }
      const after = await this.inspectRedisCutover();
      if (!sameCentralInspection(before, after)) {
        if (attempt < 2) continue;
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_REDIS_STATE_CHANGED",
          "central Redis cutover state changed while the API fleet was being verified",
        );
      }
      this.assertArtifactCompatibleWithCutover(artifact, after);
      const apiNodes = [] as ReleaseReconciliationEvidence["apiNodes"];
      for (const observation of observations) {
        const backend = backends.find((candidate) => candidate.nodeId === observation.nodeId)!;
        this.assertApiRedisState({
          artifact,
          inspection: after,
          nodeId: observation.nodeId,
          result: observation.result,
        });
        apiNodes.push({
          nodeId: observation.nodeId,
          artifactSha256: observation.result.currentArtifactSha256,
          weight: backend.weight,
          health: "up",
        });
      }
      return { inspection: after, apiNodes };
    }
    throw new ReleaseReconciliationVerificationError(
      "RELEASE_RECONCILE_REDIS_STATE_CHANGED",
      "central Redis cutover state could not be sampled consistently",
    );
  }

  async verify(input: {
    claim: ReleaseDeploymentReconciliationClaim;
    artifact: ReleaseArtifactRecord;
  }): Promise<ReleaseReconciliationEvidence> {
    const { claim, artifact } = input;
    const expectedArtifactId = claim.reconciliation.intent === "target"
      ? claim.deployment.artifactId
      : claim.deployment.previousArtifactId;
    if (!expectedArtifactId || artifact.id !== expectedArtifactId || artifact.status !== "ready") {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_ARTIFACT_MISMATCH",
        "chosen reconciliation artifact is not the registered ready artifact",
      );
    }
    const expectedSchemaVersion = claim.reconciliation.intent === "target"
      ? claim.deployment.plan.artifactSchemaVersion
      : claim.deployment.plan.schemaCompatibility?.previous.schemaVersion
        ?? claim.deployment.plan.artifactSchemaVersion;
    if (artifact.manifest.schemaMode !== "schema-neutral"
      || artifact.manifest.schemaVersion !== expectedSchemaVersion) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_SCHEMA_MISMATCH",
        "chosen artifact schema identity does not match the immutable deployment plan",
      );
    }
    if (artifact.manifest.workerProtocolVersion
      !== claim.deployment.plan.artifactWorkerProtocolVersion) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_WORKER_PROTOCOL_MISMATCH",
        "chosen artifact Worker protocol does not match the immutable deployment plan",
      );
    }

    const releaseArtifact: ReleaseArtifact = {
      id: artifact.id,
      // publicSmoke currently validates the immutable SHA; retain a stable,
      // non-secret release identity for adapter logging.
      version: artifact.manifest.releaseId,
      sha256: artifact.sha256,
      schemaVersion: artifact.manifest.schemaVersion,
      schemaMode: artifact.manifest.schemaMode,
      schemaCompatibility: artifact.manifest.schemaCompatibility,
      workerProtocolVersion: artifact.manifest.workerProtocolVersion,
      runtimeCapabilities: [...artifact.manifest.runtimeCapabilities],
    };
    const context: ReleaseActionContext = {
      operationId: claim.reconciliation.id,
      actionId: `${claim.reconciliation.id}:verify-full-fleet`,
      artifactSha256: artifact.sha256,
    };
    const expectedApiIds = claim.deployment.plan.targets
      .filter((target) => target.role === "api")
      .map((target) => target.key);
    const expectedWorkerIds = claim.deployment.plan.targets
      .filter((target) => target.role === "worker")
      .map((target) => target.key);
    const deploymentSchemaMode = String(
      claim.deployment.plan.artifactSchemaMode ?? "schema-neutral",
    );
    if (deploymentSchemaMode === "migration" && expectedWorkerIds.length < 2) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_MIGRATION_WORKER_INVENTORY_REQUIRED",
        "migration reconciliation cannot accept an empty or undersized Worker inventory",
        { expectedWorkerIds },
      );
    }

    const backends = await this.loadBalancer.listBackends(context);
    if (!exactInventory(backends.map((backend) => backend.nodeId), expectedApiIds)) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_API_INVENTORY_MISMATCH",
        "CLB inventory differs from the immutable deployment plan",
        { expectedApiIds, observedApiIds: backends.map((backend) => backend.nodeId) },
      );
    }
    for (const nodeId of expectedApiIds) {
      const backend = backends.find((candidate) => candidate.nodeId === nodeId)!;
      if (backend.health !== "up" || backend.weight <= 0) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_API_NOT_SERVING",
          `API target ${nodeId} is not healthy and in service`,
          { nodeId, health: backend.health, weight: backend.weight },
        );
      }
    }
    const { inspection, apiNodes } = await this.verifyApiFleet({
      artifact,
      releaseArtifact,
      context,
      expectedApiIds,
      backends,
    });

    let workers = await this.workerControl.listWorkers(context);
    if (!exactInventory(workers.map((worker) => worker.nodeId), expectedWorkerIds)) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_WORKER_INVENTORY_MISMATCH",
        "Worker inventory differs from the immutable deployment plan",
        { expectedWorkerIds, observedWorkerIds: workers.map((worker) => worker.nodeId) },
      );
    }
    workers = await this.resumeExactSchemaNeutralPreviousWorkers({
      claim,
      artifact,
      workers,
      expectedWorkerIds,
    });
    const workerEvidence = [] as ReleaseReconciliationEvidence["workers"];
    const observedSchemaVersions = new Set(
      workers.map((worker) => worker.observedDatabaseSchemaVersion),
    );
    if (observedSchemaVersions.size !== 1) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_WORKER_SCHEMA_MIXED",
        "Worker fleet reports mixed observed database schema versions",
      );
    }
    for (const worker of workers) {
      if (!worker.healthy
        || !worker.acceptingWork
        || worker.artifactSha256 !== artifact.sha256
        || worker.schemaRuntimeMode !== "normal"
        || !schemaCompatibilitySupports(
          artifact.manifest.schemaCompatibility
            ?? defaultReleaseSchemaCompatibility(
              artifact.manifest.schemaVersion,
            ),
          worker.observedDatabaseSchemaVersion,
        )) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_WORKER_SHA_MISMATCH",
          `Worker target ${worker.nodeId} does not serve the chosen artifact`,
          {
            nodeId: worker.nodeId,
            healthy: worker.healthy,
            acceptingWork: worker.acceptingWork,
            observedArtifactSha256: worker.artifactSha256,
            observedSchemaVersion:
              worker.observedDatabaseSchemaVersion,
          },
        );
      }
      workerEvidence.push({
        nodeId: worker.nodeId,
        artifactSha256: worker.artifactSha256,
        schemaVersion: worker.observedDatabaseSchemaVersion,
        healthy: true,
        acceptingWork: true,
      });
    }

    if (inspection.centralState.state !== "unarmed" && workers.length > 0) {
      const observer = this.workerRedisCutoverObserver;
      if (!observer) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_REDIS_WORKER_OBSERVER_MISSING",
          "armed Redis reconciliation requires the bounded Worker marker observer",
        );
      }
      const cutoverAtMs = inspection.centralState.cutoverAtMs;
      if (!Number.isSafeInteger(cutoverAtMs) || (cutoverAtMs ?? 0) < 1) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_REDIS_WORKER_CONTRACT_INVALID",
          "central Redis cutover state has no valid Worker marker boundary",
        );
      }
      const expectedMarker = {
        format: "fanjin-redis-rate-limit-cutover/v1" as const,
        cutoverAtMs: cutoverAtMs!,
        redisRuntimeFingerprint: inspection.expected.contractFingerprint,
      };
      const expectedCapabilities = parseRuntimeCapabilities(artifact.manifest.runtimeCapabilities);
      if (expectedCapabilities === null) {
        throw new ReleaseReconciliationVerificationError(
          "RELEASE_RECONCILE_REDIS_ARTIFACT_CAPABILITIES_INVALID",
          "chosen reconciliation artifact has an invalid signed runtime capability set",
          { artifactId: artifact.id },
        );
      }
      for (const worker of workers) {
        let observation: Awaited<ReturnType<typeof observer.observeRedisCutover>>;
        try {
          observation = await observer.observeRedisCutover(
            worker.nodeId,
            expectedMarker,
            {
              ...context,
              actionId: `${context.actionId}:redis-worker-observe:${worker.nodeId}`,
            },
          );
        } catch {
          throw new ReleaseReconciliationVerificationError(
            "RELEASE_RECONCILE_REDIS_WORKER_OBSERVATION_FAILED",
            `Worker target ${worker.nodeId} could not persist the armed Redis marker`,
            { nodeId: worker.nodeId },
          );
        }
        const capabilities = parseRuntimeCapabilities(observation.runtimeCapabilities);
        if (
          observation.nodeId !== worker.nodeId
          || observation.currentArtifactSha256 !== artifact.sha256
          || observation.redisRuntimeFingerprint !== expectedMarker.redisRuntimeFingerprint
          || capabilities === null
          || !exactCapabilities(capabilities, expectedCapabilities)
          || observation.marker.format !== expectedMarker.format
          || observation.marker.cutoverAtMs !== expectedMarker.cutoverAtMs
          || observation.marker.redisRuntimeFingerprint !== expectedMarker.redisRuntimeFingerprint
        ) {
          throw new ReleaseReconciliationVerificationError(
            "RELEASE_RECONCILE_REDIS_WORKER_MARKER_MISMATCH",
            `Worker target ${worker.nodeId} Redis marker proof does not match the chosen artifact`,
            { nodeId: worker.nodeId },
          );
        }
      }
    }

    const publicSmoke = await this.loadBalancer.publicSmoke(releaseArtifact, context);
    if (!publicSmoke.ok || publicSmoke.artifactSha256 !== artifact.sha256) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_PUBLIC_SMOKE_FAILED",
        "public readiness endpoint does not serve the chosen artifact",
        { code: publicSmoke.code || null, observedArtifactSha256: publicSmoke.artifactSha256 || null },
      );
    }
    const finalInspection = await this.inspectRedisCutover();
    if (!sameCentralInspection(inspection, finalInspection)) {
      throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_REDIS_STATE_CHANGED",
        "central Redis cutover state changed before reconciliation evidence was finalized",
      );
    }
    this.assertArtifactCompatibleWithCutover(artifact, finalInspection);
    return {
      evidenceVersion: 1,
      artifactId: artifact.id,
      artifactSha256: artifact.sha256,
      schemaVersion: artifact.manifest.schemaVersion,
      apiNodes,
      workers: workerEvidence,
      publicSmoke: { ok: true, artifactSha256: artifact.sha256 },
      verifiedAt: Date.now(),
    };
  }
}
