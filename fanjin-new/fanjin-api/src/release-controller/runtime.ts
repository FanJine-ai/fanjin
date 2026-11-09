import { createHash } from "node:crypto";
import { hostname } from "node:os";

import type {
  ReleaseArtifactRecord,
  ReleaseDeploymentClaim,
} from "@/lib/releaseDeployments";
import {
  defaultReleaseSchemaCompatibility,
  resolveReleaseSchemaCompatibilityBridge,
} from "@/lib/releaseSchemaCompatibility";

import type {
  LoadBalancer,
  NodeAgent,
  ReleaseCheckpoint,
  ReleaseConfigurationVerifier,
  ReleasePlan,
  ReleaseSchemaMigrator,
  WorkerControlPlane,
  WorkerNodeAgent,
} from "./types";
import {
  databaseReleaseRuntimeRepository,
  KnexReleaseStore,
  ReleaseLeaseLostError,
  type ReleaseRuntimeRepository,
} from "./knexReleaseStore";
import { ReleaseHandoffRequestedError } from "./errors";
import type { RedisCutoverCoordinator } from "./redisCutoverCoordinator";
import { exactReleaseSchemaCompatibility } from "./schemaCompatibility";

export interface ReleaseRuntimeLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  error(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

export interface ReleaseRuntimeClock {
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface ReleaseLeaseGuard {
  assertActive(): void;
  readonly lost: boolean;
  readonly signal: AbortSignal;
}

export interface ReleaseExecutor {
  execute(plan: ReleasePlan): Promise<ReleaseCheckpoint>;
}

export interface ReleaseExecutionFactoryInput {
  claim: ReleaseDeploymentClaim;
  store: KnexReleaseStore;
  artifact: ReleaseArtifactRecord;
  previousArtifact: ReleaseArtifactRecord | null;
  leaseGuard: ReleaseLeaseGuard;
  shouldCancel(): Promise<boolean>;
}

export type ReleaseExecutionFactory = (
  input: ReleaseExecutionFactoryInput,
) => Promise<ReleaseExecutor> | ReleaseExecutor;

export type ReleaseArtifactPreflight = (input: {
  artifact: ReleaseArtifactRecord;
  previousArtifact: ReleaseArtifactRecord | null;
  signal: AbortSignal;
}) => Promise<void>;

const systemClock: ReleaseRuntimeClock = {
  sleep: (milliseconds, signal) => new Promise<void>((resolve) => {
    if (milliseconds <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  }),
};

const consoleLogger: ReleaseRuntimeLogger = {
  info: (event, fields = {}) => console.log(JSON.stringify({ level: "info", event, ...fields })),
  warn: (event, fields = {}) => console.warn(JSON.stringify({ level: "warn", event, ...fields })),
  error: (event, fields = {}) => console.error(JSON.stringify({ level: "error", event, ...fields })),
};

function errorCode(error: unknown): string {
  const value = String((error as { code?: unknown })?.code || "RELEASE_RUNTIME_ERROR").toUpperCase();
  return /^[A-Z0-9_.-]{1,80}$/.test(value) ? value : "RELEASE_RUNTIME_ERROR";
}

function runtimeInvariant(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function positiveInteger(value: number, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be >= ${minimum}`);
  return value;
}

export function stableReleaseWorkerId(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = String(environment.FANJIN_RELEASE_CONTROLLER_WORKER_ID || "").trim();
  if (configured) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configured)) {
      throw new Error("FANJIN_RELEASE_CONTROLLER_WORKER_ID format is invalid");
    }
    return configured;
  }
  const host = hostname().toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 80);
  if (host && /^[a-z0-9]/.test(host)) return `release-controller:${host}`;
  const digest = createHash("sha256").update(hostname()).digest("hex").slice(0, 24);
  return `release-controller:${digest}`;
}

class MutableLeaseGuard implements ReleaseLeaseGuard {
  private failure: ReleaseLeaseLostError | null = null;
  private readonly abortController = new AbortController();

  get lost(): boolean {
    return this.failure !== null;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  lose(error?: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof ReleaseLeaseLostError
      ? error
      : new ReleaseLeaseLostError();
    this.abortController.abort();
  }

  assertActive(): void {
    if (this.failure) throw this.failure;
  }
}

async function whileLeaseActive<T>(lease: ReleaseLeaseGuard, operation: () => Promise<T>): Promise<T> {
  lease.assertActive();
  const result = await operation();
  lease.assertActive();
  return result;
}

export function guardLoadBalancer(
  loadBalancer: LoadBalancer,
  lease: ReleaseLeaseGuard,
): LoadBalancer {
  return {
    async listBackends(context) {
      return whileLeaseActive(lease, () => loadBalancer.listBackends(context));
    },
    async getBackend(nodeId, context) {
      return whileLeaseActive(lease, () => loadBalancer.getBackend(nodeId, context));
    },
    async setWeight(nodeId, weight, context) {
      return whileLeaseActive(lease, () => loadBalancer.setWeight(nodeId, weight, context));
    },
    async waitForDrain(nodeId, context) {
      return whileLeaseActive(lease, () => loadBalancer.waitForDrain(nodeId, context));
    },
    async publicSmoke(artifact, context) {
      return whileLeaseActive(lease, () => loadBalancer.publicSmoke(artifact, context));
    },
  };
}

export function guardNodeAgent(nodeAgent: NodeAgent, lease: ReleaseLeaseGuard): NodeAgent {
  return {
    async preflight(nodeId, artifact, schemaMode, context, policy) {
      return whileLeaseActive(
        lease,
        () => nodeAgent.preflight(nodeId, artifact, schemaMode, context, policy),
      );
    },
    async currentIdentity(nodeId, context) {
      return whileLeaseActive(lease, () => nodeAgent.currentIdentity(nodeId, context));
    },
    ...(typeof nodeAgent.armRedisCutoverSchedule === "function" ? {
      async armRedisCutoverSchedule(nodeId, expected, context) {
        return whileLeaseActive(
          lease,
          () => nodeAgent.armRedisCutoverSchedule!(nodeId, expected, context),
        );
      },
    } : {}),
    ...(typeof nodeAgent.observeRedisCutover === "function" ? {
      async observeRedisCutover(nodeId, expected, context) {
        return whileLeaseActive(
          lease,
          () => nodeAgent.observeRedisCutover!(nodeId, expected, context),
        );
      },
    } : {}),
    async stage(nodeId, artifact, context) {
      return whileLeaseActive(lease, () => nodeAgent.stage(nodeId, artifact, context));
    },
    async beginDrain(nodeId, expectedCurrentArtifactSha256, context) {
      return whileLeaseActive(
        lease,
        () => nodeAgent.beginDrain(nodeId, expectedCurrentArtifactSha256, context),
      );
    },
    async drainStatus(nodeId, expectedCurrentArtifactSha256, context) {
      return whileLeaseActive(
        lease,
        () => nodeAgent.drainStatus(nodeId, expectedCurrentArtifactSha256, context),
      );
    },
    async cancelDrain(nodeId, expectedCurrentArtifactSha256, context) {
      return whileLeaseActive(
        lease,
        () => nodeAgent.cancelDrain(nodeId, expectedCurrentArtifactSha256, context),
      );
    },
    async activate(nodeId, artifact, context) {
      return whileLeaseActive(lease, () => nodeAgent.activate(nodeId, artifact, context));
    },
    async directReadiness(nodeId, context) {
      return whileLeaseActive(lease, () => nodeAgent.directReadiness(nodeId, context));
    },
    async rollback(nodeId, previousArtifactSha256, context) {
      return whileLeaseActive(lease, () => nodeAgent.rollback(nodeId, previousArtifactSha256, context));
    },
  };
}

export function guardRedisCutoverCoordinator(
  coordinator: RedisCutoverCoordinator,
  lease: ReleaseLeaseGuard,
): RedisCutoverCoordinator {
  return {
    async inspect() {
      return whileLeaseActive(lease, () => coordinator.inspect());
    },
    async schedule(request) {
      return whileLeaseActive(lease, () => coordinator.schedule(request));
    },
  };
}

export function guardReleaseSchemaMigrator(
  migrator: ReleaseSchemaMigrator,
  lease: ReleaseLeaseGuard,
): ReleaseSchemaMigrator {
  return {
    async inspect(request, context) {
      return whileLeaseActive(lease, () => migrator.inspect(request, context));
    },
    async apply(request, context) {
      return whileLeaseActive(lease, () => migrator.apply(request, context));
    },
  };
}

export function guardReleaseConfigurationVerifier(
  verifier: ReleaseConfigurationVerifier,
  lease: ReleaseLeaseGuard,
): ReleaseConfigurationVerifier {
  return {
    async verify(artifact, input, context) {
      return whileLeaseActive(
        lease,
        () => verifier.verify(artifact, input, context),
      );
    },
  };
}

export function guardWorkerControlPlane(
  control: WorkerControlPlane,
  lease: ReleaseLeaseGuard,
): WorkerControlPlane {
  return {
    async listWorkers(context) {
      lease.assertActive();
      const result = await control.listWorkers(context);
      lease.assertActive();
      return result;
    },
    async assertHealthyCapacity(nodeId, minimumHealthy, context) {
      lease.assertActive();
      await control.assertHealthyCapacity(nodeId, minimumHealthy, context);
      lease.assertActive();
    },
    async requestDrain(nodeId, context) {
      lease.assertActive();
      await control.requestDrain(nodeId, context);
      lease.assertActive();
    },
    async waitForDrained(nodeId, context) {
      lease.assertActive();
      const result = await control.waitForDrained(nodeId, context);
      lease.assertActive();
      return result;
    },
    async waitForArtifact(nodeId, expectation, context) {
      lease.assertActive();
      const result = await control.waitForArtifact(nodeId, expectation, context);
      lease.assertActive();
      return result;
    },
    async authorizeSchemaBridge(nodeId, expectation, context) {
      lease.assertActive();
      await control.authorizeSchemaBridge(nodeId, expectation, context);
      lease.assertActive();
    },
    async resume(nodeId, context) {
      lease.assertActive();
      await control.resume(nodeId, context);
      lease.assertActive();
    },
    async waitForServing(nodeId, expectation, context) {
      lease.assertActive();
      const result = await control.waitForServing(nodeId, expectation, context);
      lease.assertActive();
      return result;
    },
  };
}

export function guardWorkerNodeAgent(
  nodeAgent: WorkerNodeAgent,
  lease: ReleaseLeaseGuard,
): WorkerNodeAgent {
  return {
    async stage(nodeId, artifact, context) {
      return whileLeaseActive(lease, () => nodeAgent.stage(nodeId, artifact, context));
    },
    async activate(nodeId, artifact, context) {
      return whileLeaseActive(lease, () => nodeAgent.activate(nodeId, artifact, context));
    },
    ...(typeof nodeAgent.configurationIdentity === "function" ? {
      async configurationIdentity(nodeId, context) {
        return whileLeaseActive(
          lease,
          () => nodeAgent.configurationIdentity!(nodeId, context),
        );
      },
    } : {}),
    ...(typeof nodeAgent.armRedisCutoverSchedule === "function" ? {
      async armRedisCutoverSchedule(nodeId, expected, context) {
        return whileLeaseActive(
          lease,
          () => nodeAgent.armRedisCutoverSchedule!(nodeId, expected, context),
        );
      },
    } : {}),
    async observeRedisCutover(nodeId, expected, context) {
      return whileLeaseActive(
        lease,
        () => nodeAgent.observeRedisCutover(nodeId, expected, context),
      );
    },
    async rollback(nodeId, previousArtifactSha256, targetArtifact, context) {
      lease.assertActive();
      await nodeAgent.rollback(nodeId, previousArtifactSha256, targetArtifact, context);
      lease.assertActive();
    },
  };
}

function releasePlanFor(
  claim: ReleaseDeploymentClaim,
  artifact: ReleaseArtifactRecord,
  previousArtifact: ReleaseArtifactRecord | null,
): ReleasePlan {
  const checkpoint = claim.checkpoint;
  const checkpointSchemaMode =
    checkpoint.artifact.schemaMode ?? checkpoint.schemaMode;
  const checkpointSchemaCompatibility = checkpoint.artifact.schemaCompatibility
    ?? (checkpointSchemaMode === "schema-neutral"
      ? exactReleaseSchemaCompatibility(checkpoint.artifact.schemaVersion)
      : null);
  const deploymentSchemaMode =
    claim.deployment.plan.artifactSchemaMode ?? "schema-neutral";
  const deploymentSchemaCompatibility =
    claim.deployment.plan.artifactSchemaCompatibility
    ?? (deploymentSchemaMode === "schema-neutral"
      ? exactReleaseSchemaCompatibility(claim.deployment.plan.artifactSchemaVersion)
      : null);
  const artifactSchemaCompatibility = artifact.manifest.schemaCompatibility
    ?? defaultReleaseSchemaCompatibility(artifact.manifest.schemaVersion);
  if (artifact.id !== claim.deployment.artifactId
    || artifact.status !== "ready"
    || artifact.manifest.releaseId !== checkpoint.artifact.releaseId
    || artifact.sha256 !== checkpoint.artifact.sha256
    || artifact.manifest.sourceCommit !== checkpoint.artifact.sourceCommit
    || artifact.manifest.schemaVersion !== checkpoint.artifact.schemaVersion
    || artifact.manifest.workerProtocolVersion !== checkpoint.artifact.workerProtocolVersion
    || JSON.stringify(artifact.manifest.runtimeCapabilities)
      !== JSON.stringify(checkpoint.artifact.runtimeCapabilities ?? [])
    || JSON.stringify(artifact.manifest.deployment ?? null)
      !== JSON.stringify(checkpoint.artifact.deployment ?? null)
    || (checkpoint.artifact.deploymentMode ?? "archive-systemd")
      !== (artifact.manifest.deployment ? "container-image" : "archive-systemd")
    || (checkpoint.artifact.imageDigest ?? null)
      !== (artifact.manifest.deployment?.imageDigest ?? null)
    || artifact.manifest.schemaVersion !== claim.deployment.plan.artifactSchemaVersion
    || deploymentSchemaMode !== artifact.manifest.schemaMode
    || JSON.stringify(deploymentSchemaCompatibility)
      !== JSON.stringify(artifactSchemaCompatibility)
    || artifact.manifest.workerProtocolVersion
      !== claim.deployment.plan.artifactWorkerProtocolVersion
    || artifact.id !== claim.deployment.plan.artifactId
    || checkpoint.schemaMode !== artifact.manifest.schemaMode
    || checkpointSchemaMode !== artifact.manifest.schemaMode
    || JSON.stringify(checkpointSchemaCompatibility)
      !== JSON.stringify(artifactSchemaCompatibility)) {
    runtimeInvariant("RELEASE_ARTIFACT_CLAIM_MISMATCH");
  }
  if (!claim.deployment.previousReleaseId || !claim.deployment.previousArtifactId) {
    runtimeInvariant("RELEASE_PREVIOUS_BASELINE_REQUIRED");
  }
  if (previousArtifact
    && previousArtifact.manifest.workerProtocolVersion
      !== artifact.manifest.workerProtocolVersion) {
    runtimeInvariant("RELEASE_WORKER_PROTOCOL_VERSION_MISMATCH");
  }
  if (!previousArtifact
    || !checkpoint.previousArtifact
    || previousArtifact.id !== claim.deployment.previousArtifactId
    || previousArtifact.releaseId !== claim.deployment.previousReleaseId
    || previousArtifact.status !== "ready"
    || previousArtifact.manifest.releaseId
      !== checkpoint.previousArtifact.releaseId
    || previousArtifact.sha256 !== checkpoint.previousArtifact.sha256
    || previousArtifact.manifest.sourceCommit
      !== checkpoint.previousArtifact.sourceCommit
    || previousArtifact.manifest.schemaVersion
      !== checkpoint.previousArtifact.schemaVersion
    || previousArtifact.manifest.schemaMode
      !== checkpoint.previousArtifact.schemaMode
    || JSON.stringify(
      previousArtifact.manifest.schemaCompatibility
        ?? defaultReleaseSchemaCompatibility(
          previousArtifact.manifest.schemaVersion,
        ),
    ) !== JSON.stringify(
      checkpoint.previousArtifact.schemaCompatibility
        ?? defaultReleaseSchemaCompatibility(
          checkpoint.previousArtifact.schemaVersion,
        ),
    )
    || previousArtifact.manifest.workerProtocolVersion
      !== checkpoint.previousArtifact.workerProtocolVersion
    || JSON.stringify(previousArtifact.manifest.runtimeCapabilities)
      !== JSON.stringify(checkpoint.previousArtifact.runtimeCapabilities ?? [])
    || JSON.stringify(previousArtifact.manifest.deployment ?? null)
      !== JSON.stringify(checkpoint.previousArtifact.deployment ?? null)
    || (checkpoint.previousArtifact.deploymentMode ?? "archive-systemd")
      !== (previousArtifact.manifest.deployment
        ? "container-image"
        : "archive-systemd")
    || (checkpoint.previousArtifact.imageDigest ?? null)
      !== (previousArtifact.manifest.deployment?.imageDigest ?? null)) {
    runtimeInvariant("RELEASE_PREVIOUS_ARTIFACT_PROVENANCE_MISSING");
  }
  let schemaCompatibility;
  try {
    schemaCompatibility = resolveReleaseSchemaCompatibilityBridge({
      previous: {
        releaseId: previousArtifact.manifest.releaseId,
        sourceCommit: previousArtifact.manifest.sourceCommit,
        artifactSha256: previousArtifact.sha256,
        schemaVersion: previousArtifact.manifest.schemaVersion,
        schemaCompatibility: previousArtifact.manifest.schemaCompatibility
          ?? defaultReleaseSchemaCompatibility(previousArtifact.manifest.schemaVersion),
      },
      target: {
        releaseId: artifact.manifest.releaseId,
        sourceCommit: artifact.manifest.sourceCommit,
        artifactSha256: artifact.sha256,
        schemaVersion: artifact.manifest.schemaVersion,
        schemaCompatibility: artifact.manifest.schemaCompatibility
          ?? defaultReleaseSchemaCompatibility(artifact.manifest.schemaVersion),
      },
      databaseVersion: artifact.manifest.schemaVersion,
    });
  } catch {
    runtimeInvariant("RELEASE_SCHEMA_COMPATIBILITY_INVALID");
  }
  if (JSON.stringify(schemaCompatibility)
    !== JSON.stringify(claim.deployment.plan.schemaCompatibility ?? null)
    || JSON.stringify(schemaCompatibility)
      !== JSON.stringify(checkpoint.schemaCompatibility ?? null)) {
    runtimeInvariant("RELEASE_SCHEMA_COMPATIBILITY_CLAIM_MISMATCH");
  }
  const apiNodeIds = claim.deployment.plan.targets
    .filter((target) => target.role === "api")
    .map((target) => target.key);
  const workerNodeIds = claim.deployment.plan.targets
    .filter((target) => target.role === "worker")
    .map((target) => target.key);
  const allNodeIds = [...apiNodeIds, ...workerNodeIds];
  if (apiNodeIds.length < 2
    || (workerNodeIds.length > 0 && workerNodeIds.length < 2)
    || new Set(allNodeIds).size !== allNodeIds.length) {
    runtimeInvariant("RELEASE_TARGET_INVENTORY_INVALID");
  }
  return {
    operationId: claim.deployment.id,
    artifact: {
      id: artifact.id,
      releaseId: artifact.manifest.releaseId,
      version: checkpoint.artifact.version,
      sha256: artifact.sha256,
      sourceCommit: artifact.manifest.sourceCommit,
      schemaVersion: artifact.manifest.schemaVersion,
      schemaMode: artifact.manifest.schemaMode,
      schemaCompatibility: artifactSchemaCompatibility,
      workerProtocolVersion: artifact.manifest.workerProtocolVersion,
      runtimeCapabilities: [...artifact.manifest.runtimeCapabilities],
      ...(artifact.manifest.deployment
        ? { deployment: artifact.manifest.deployment }
        : {}),
      deploymentMode: artifact.manifest.deployment
        ? "container-image"
        : "archive-systemd",
      imageDigest: artifact.manifest.deployment?.imageDigest ?? null,
    },
    previousArtifact: {
      id: previousArtifact.id,
      releaseId: previousArtifact.manifest.releaseId,
      version: previousArtifact.manifest.releaseId,
      sha256: previousArtifact.sha256,
      sourceCommit: previousArtifact.manifest.sourceCommit,
      schemaVersion: previousArtifact.manifest.schemaVersion,
      schemaMode: previousArtifact.manifest.schemaMode,
      schemaCompatibility: previousArtifact.manifest.schemaCompatibility
        ?? defaultReleaseSchemaCompatibility(
          previousArtifact.manifest.schemaVersion,
        ),
      workerProtocolVersion: previousArtifact.manifest.workerProtocolVersion,
      runtimeCapabilities: [...previousArtifact.manifest.runtimeCapabilities],
      ...(previousArtifact.manifest.deployment
        ? { deployment: previousArtifact.manifest.deployment }
        : {}),
      deploymentMode: previousArtifact.manifest.deployment
        ? "container-image"
        : "archive-systemd",
      imageDigest: previousArtifact.manifest.deployment?.imageDigest ?? null,
    },
    schemaMode: artifact.manifest.schemaMode,
    schemaCompatibility,
    nodeIds: apiNodeIds,
    apiNodeIds,
    workerNodeIds,
    minHealthyWorkers: claim.deployment.plan.minHealthyWorkers,
  };
}

export class ReleaseControllerRuntime {
  private readonly repository: ReleaseRuntimeRepository;
  private readonly createExecution: ReleaseExecutionFactory;
  private readonly verifyArtifacts: ReleaseArtifactPreflight;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly takeoverGraceMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: ReleaseRuntimeClock;
  private readonly logger: ReleaseRuntimeLogger;
  private stopping = false;
  private idleAbort = new AbortController();
  private activeOperationId: string | null = null;
  private activeLeaseGuard: MutableLeaseGuard | null = null;

  constructor(options: {
    createExecution: ReleaseExecutionFactory;
    verifyArtifacts: ReleaseArtifactPreflight;
    repository?: ReleaseRuntimeRepository;
    workerId?: string;
    leaseMs?: number;
    heartbeatMs?: number;
    takeoverGraceMs?: number;
    pollIntervalMs?: number;
    clock?: ReleaseRuntimeClock;
    logger?: ReleaseRuntimeLogger;
  }) {
    this.repository = options.repository ?? databaseReleaseRuntimeRepository;
    this.createExecution = options.createExecution;
    this.verifyArtifacts = options.verifyArtifacts;
    this.workerId = options.workerId ?? stableReleaseWorkerId();
    this.leaseMs = positiveInteger(options.leaseMs ?? 60_000, "leaseMs", 5_000);
    this.heartbeatMs = positiveInteger(
      options.heartbeatMs ?? Math.floor(this.leaseMs / 3),
      "heartbeatMs",
      1_000,
    );
    if (this.heartbeatMs >= this.leaseMs / 2) {
      throw new Error("heartbeatMs must be smaller than half of leaseMs");
    }
    this.takeoverGraceMs = positiveInteger(
      options.takeoverGraceMs ?? 20 * 60_000,
      "takeoverGraceMs",
      0,
    );
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 2_000, "pollIntervalMs", 100);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
  }

  get activeOperation(): string | null {
    return this.activeOperationId;
  }

  requestStop(): void {
    this.stopping = true;
    this.idleAbort.abort();
  }

  async runOnce(): Promise<boolean> {
    if (this.stopping) return false;
    const claim = await this.repository.claimNext({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
      takeoverGraceMs: this.takeoverGraceMs,
    });
    if (!claim) return false;

    this.activeOperationId = claim.deployment.id;
    const store = new KnexReleaseStore({
      claim,
      workerId: this.workerId,
      repository: this.repository,
      leaseMs: this.leaseMs,
    });
    const leaseGuard = new MutableLeaseGuard();
    this.activeLeaseGuard = leaseGuard;
    const heartbeatAbort = new AbortController();
    const heartbeat = this.heartbeat(store, leaseGuard, heartbeatAbort.signal);
    let executionInvoked = false;

    this.logger.info("release.claimed", {
      operationId: claim.deployment.id,
      fencingToken: claim.fencingToken,
    });
    try {
      const artifact = await this.repository.getArtifact(claim.deployment.artifactId);
      const previousArtifact = claim.deployment.previousArtifactId
        ? await this.repository.getArtifact(claim.deployment.previousArtifactId)
        : null;
      leaseGuard.assertActive();
      await this.verifyArtifacts({
        artifact,
        previousArtifact,
        signal: leaseGuard.signal,
      });
      leaseGuard.assertActive();
      if (this.stopping && !(await store.cancellationRequested())) {
        await store.handoff();
        this.logger.info("release.handed_off", {
          operationId: claim.deployment.id,
        });
        return false;
      }
      const plan = releasePlanFor(claim, artifact, previousArtifact);
      const execution = await this.createExecution({
        claim,
        store,
        artifact,
        previousArtifact,
        leaseGuard,
        shouldCancel: async () => {
          leaseGuard.assertActive();
          const cancellationRequested = await store.cancellationRequested();
          if (!cancellationRequested && this.stopping) {
            throw new ReleaseHandoffRequestedError();
          }
          return cancellationRequested;
        },
      });
      executionInvoked = true;
      await execution.execute(plan);
      leaseGuard.assertActive();
      this.logger.info("release.finished", { operationId: claim.deployment.id });
      return true;
    } catch (error) {
      if (error instanceof ReleaseHandoffRequestedError && this.stopping) {
        await store.handoff();
        this.logger.info("release.handed_off", {
          operationId: claim.deployment.id,
        });
        return false;
      }
      if (leaseGuard.lost || error instanceof ReleaseLeaseLostError) {
        this.logger.error("release.lease_lost", {
          operationId: claim.deployment.id,
          code: errorCode(error),
        });
        throw error instanceof ReleaseLeaseLostError ? error : new ReleaseLeaseLostError();
      }
      // Controller normally persists its own terminal checkpoint. Re-read it
      // under the same fence and only fill the gap when it is still running.
      // This also covers validatePlan/checkpoint-integrity failures that occur
      // before RollingReleaseController enters its internal try/catch.
      await this.persistPreExecutionFailure(store, claim, error, !executionInvoked);
      // RollingReleaseController has already persisted its safe failed/
      // cancelled terminal checkpoint. Only a safe code is logged here.
      this.logger.warn("release.execution_stopped", {
        operationId: claim.deployment.id,
        code: errorCode(error),
      });
      return true;
    } finally {
      heartbeatAbort.abort();
      await heartbeat;
      if (this.activeLeaseGuard === leaseGuard) this.activeLeaseGuard = null;
      this.activeOperationId = null;
    }
  }

  private async persistPreExecutionFailure(
    store: KnexReleaseStore,
    claim: ReleaseDeploymentClaim,
    error: unknown,
    beforeExecution: boolean,
  ): Promise<void> {
    const checkpoint = await store.get(claim.deployment.id);
    if (!checkpoint || checkpoint.status !== "running") return;
    const workerStateIsPristine = checkpoint.workerOrder.length === 0
      ? checkpoint.workerPreflightComplete
        && checkpoint.workerStageComplete
        && checkpoint.workerRollingComplete
      : !checkpoint.workerPreflightComplete
        && !checkpoint.workerStageComplete
        && !checkpoint.workerRollingComplete;
    const safeToReleaseScope = checkpoint.phase === "preflight"
      && !checkpoint.preflightComplete
      && !checkpoint.stageComplete
      && workerStateIsPristine
      && checkpoint.currentNodeId === null;
    const at = Date.now();
    const code = errorCode(error);
    const failedPhase = checkpoint.phase;
    checkpoint.status = "failed";
    checkpoint.phase = "failed";
    checkpoint.currentNodeId = null;
    checkpoint.manualInterventionRequired = checkpoint.manualInterventionRequired || !safeToReleaseScope;
    checkpoint.error = {
      code,
      message: safeToReleaseScope
        ? "发布启动前安全校验失败"
        : "发布恢复前安全校验失败，需要人工核验现场",
      phase: failedPhase,
      nodeId: null,
      at,
    };
    checkpoint.updatedAt = at;
    checkpoint.events.push({
      sequence: checkpoint.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1,
      operationId: checkpoint.operationId,
      type: "operation.failed",
      phase: "failed",
      nodeId: null,
      at,
      observations: {
        code,
        manualInterventionRequired: checkpoint.manualInterventionRequired,
        beforeExecution,
      },
    });
    await store.save(checkpoint, checkpoint.revision);
  }

  async runForever(): Promise<void> {
    this.logger.info("release.runtime_started", { workerId: this.workerId });
    while (!this.stopping) {
      const claimed = await this.runOnce();
      if (this.stopping) break;
      if (!claimed) {
        this.idleAbort = new AbortController();
        await this.clock.sleep(this.pollIntervalMs, this.idleAbort.signal);
      }
    }
    // SIGTERM never turns into a deployment cancellation. A cooperative
    // execution returns its valid lease at a durable action boundary; a
    // process that cannot reach one remains fenced and follows manual
    // reconciliation after lease expiry.
    this.logger.info("release.runtime_stopped", { workerId: this.workerId });
  }

  private async heartbeat(
    store: KnexReleaseStore,
    leaseGuard: MutableLeaseGuard,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      await this.clock.sleep(this.heartbeatMs, signal);
      if (signal.aborted) return;
      try {
        await store.renewLease();
      } catch (error) {
        leaseGuard.lose(error);
        return;
      }
    }
  }
}
