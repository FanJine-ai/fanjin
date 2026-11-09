import {
  claimNextReleaseDeploymentReconciliation,
  completeReleaseDeploymentReconciliation,
  failOneExpiredReleaseDeploymentReconciliation,
  failReleaseDeploymentReconciliation,
  renewReleaseDeploymentReconciliationLease,
  type ReleaseDeploymentReconciliationClaim,
} from "@/lib/releaseDeploymentReconciliation";
import {
  assertReleaseArtifactSchemaCurrent,
  getReleaseArtifact,
  type ReleaseArtifactRecord,
} from "@/lib/releaseDeployments";

import type { ReleaseLeaseGuard, ReleaseRuntimeClock, ReleaseRuntimeLogger } from "./runtime";
import {
  ReleaseReconciliationVerificationError,
  type ReleaseReconciliationVerifier,
} from "./reconciliationVerifier";

const clockDefault: ReleaseRuntimeClock = {
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

const loggerDefault: ReleaseRuntimeLogger = {
  info: (event, fields = {}) => console.log(JSON.stringify({ level: "info", event, ...fields })),
  warn: (event, fields = {}) => console.warn(JSON.stringify({ level: "warn", event, ...fields })),
  error: (event, fields = {}) => console.error(JSON.stringify({ level: "error", event, ...fields })),
};

class ReconciliationLeaseGuard implements ReleaseLeaseGuard {
  private failure: Error | null = null;
  private readonly controller = new AbortController();

  get lost(): boolean { return this.failure !== null; }
  get signal(): AbortSignal { return this.controller.signal; }

  lose(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error("RELEASE_RECONCILE_LEASE_LOST");
    this.controller.abort();
  }

  assertActive(): void {
    if (this.failure) throw this.failure;
  }
}

export type ReleaseReconciliationVerifierFactory = (input: {
  claim: ReleaseDeploymentReconciliationClaim;
  artifact: ReleaseArtifactRecord;
  leaseGuard: ReleaseLeaseGuard;
}) => ReleaseReconciliationVerifier | Promise<ReleaseReconciliationVerifier>;

/**
 * Independent queue consumer for Root-authored verification and the bounded
 * fail-closed containment of possible migration targets.
 */
export class ReleaseReconciliationControllerRuntime {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollIntervalMs: number;
  private readonly createVerifier: ReleaseReconciliationVerifierFactory;
  private readonly clock: ReleaseRuntimeClock;
  private readonly logger: ReleaseRuntimeLogger;
  private stopping = false;
  private idleAbort = new AbortController();

  constructor(options: {
    workerId: string;
    createVerifier: ReleaseReconciliationVerifierFactory;
    leaseMs?: number;
    heartbeatMs?: number;
    pollIntervalMs?: number;
    clock?: ReleaseRuntimeClock;
    logger?: ReleaseRuntimeLogger;
  }) {
    this.workerId = options.workerId;
    this.createVerifier = options.createVerifier;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.floor(this.leaseMs / 3);
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.clock = options.clock ?? clockDefault;
    this.logger = options.logger ?? loggerDefault;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 5_000
      || !Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 1_000
      || this.heartbeatMs >= this.leaseMs / 2
      || !Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 100) {
      throw new Error("release reconciliation runtime timing configuration is invalid");
    }
  }

  requestStop(): void {
    this.stopping = true;
    this.idleAbort.abort();
  }

  async runOnce(): Promise<boolean> {
    if (this.stopping) return false;
    if (await failOneExpiredReleaseDeploymentReconciliation()) return true;
    const claim = await claimNextReleaseDeploymentReconciliation({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
    if (!claim) return false;
    const guard = new ReconciliationLeaseGuard();
    const heartbeatAbort = new AbortController();
    const heartbeat = this.heartbeat(claim, guard, heartbeatAbort.signal);
    const desiredArtifactId = claim.reconciliation.intent === "target"
      ? claim.deployment.artifactId
      : claim.deployment.previousArtifactId;
    this.logger.info("release.reconcile_claimed", {
      reconciliationId: claim.reconciliation.id,
      operationId: claim.deployment.id,
      fencingToken: claim.reconciliation.fencingToken,
    });
    try {
      if (!desiredArtifactId) throw new ReleaseReconciliationVerificationError(
        "RELEASE_RECONCILE_PREVIOUS_UNAVAILABLE",
        "previous artifact is not registered",
      );
      const artifact = await getReleaseArtifact(desiredArtifactId);
      const targetArtifact = desiredArtifactId === claim.deployment.artifactId
        ? artifact
        : await getReleaseArtifact(claim.deployment.artifactId);
      const previousArtifact = claim.deployment.previousArtifactId
        ? desiredArtifactId === claim.deployment.previousArtifactId
          ? artifact
          : await getReleaseArtifact(claim.deployment.previousArtifactId)
        : null;
      guard.assertActive();
      const verifier = await this.createVerifier({ claim, artifact, leaseGuard: guard });
      guard.assertActive();
      await verifier.containIncompleteMigration({
        claim,
        targetArtifact,
        previousArtifact,
      });
      guard.assertActive();
      await assertReleaseArtifactSchemaCurrent(
        artifact,
      );
      guard.assertActive();
      const evidence = await verifier.verify({ claim, artifact });
      guard.assertActive();
      await completeReleaseDeploymentReconciliation({
        id: claim.reconciliation.id,
        workerId: this.workerId,
        revision: claim.reconciliation.revision,
        fencingToken: claim.reconciliation.fencingToken,
        evidence,
      });
      this.logger.info("release.reconcile_succeeded", {
        reconciliationId: claim.reconciliation.id,
        operationId: claim.deployment.id,
      });
      return true;
    } catch (error) {
      if (guard.lost) {
        this.logger.error("release.reconcile_lease_lost", {
          reconciliationId: claim.reconciliation.id,
          operationId: claim.deployment.id,
        });
        return true;
      }
      const verificationError = error instanceof ReleaseReconciliationVerificationError ? error : null;
      const code = verificationError?.code || "RELEASE_RECONCILE_FAILED";
      const message = verificationError?.message || "人工收敛核验未完成";
      await failReleaseDeploymentReconciliation({
        id: claim.reconciliation.id,
        workerId: this.workerId,
        revision: claim.reconciliation.revision,
        fencingToken: claim.reconciliation.fencingToken,
        code,
        message,
        evidence: verificationError?.evidence,
      }).catch((persistenceError) => {
        this.logger.error("release.reconcile_failure_persist_failed", {
          reconciliationId: claim.reconciliation.id,
          operationId: claim.deployment.id,
          code: String((persistenceError as { code?: unknown })?.code || "RELEASE_RECONCILE_WRITE_FAILED"),
        });
      });
      this.logger.warn("release.reconcile_failed", {
        reconciliationId: claim.reconciliation.id,
        operationId: claim.deployment.id,
        code,
      });
      return true;
    } finally {
      heartbeatAbort.abort();
      await heartbeat;
    }
  }

  async runForever(): Promise<void> {
    this.logger.info("release.reconciliation_runtime_started", { workerId: this.workerId });
    while (!this.stopping) {
      const processed = await this.runOnce();
      if (this.stopping) break;
      if (!processed) {
        this.idleAbort = new AbortController();
        await this.clock.sleep(this.pollIntervalMs, this.idleAbort.signal);
      }
    }
    this.logger.info("release.reconciliation_runtime_stopped", { workerId: this.workerId });
  }

  private async heartbeat(
    claim: ReleaseDeploymentReconciliationClaim,
    guard: ReconciliationLeaseGuard,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      await this.clock.sleep(this.heartbeatMs, signal);
      if (signal.aborted) return;
      try {
        await renewReleaseDeploymentReconciliationLease({
          id: claim.reconciliation.id,
          workerId: this.workerId,
          revision: claim.reconciliation.revision,
          fencingToken: claim.reconciliation.fencingToken,
          leaseMs: this.leaseMs,
        });
      } catch (error) {
        guard.lose(error);
        return;
      }
    }
  }
}
