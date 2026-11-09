import type {
  ReleaseArtifactRecord,
  ReleaseDeploymentClaim,
  ReleaseDeploymentDetail,
} from "@/lib/releaseDeployments";

import type { ReleaseCheckpoint, ReleaseStore } from "./types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface ReleaseRuntimeRepository {
  claimNext(input: { workerId: string; leaseMs?: number; takeoverGraceMs?: number }): Promise<ReleaseDeploymentClaim | null>;
  renewLease(input: {
    id: string;
    workerId: string;
    expectedRevision: number;
    fencingToken: number;
    leaseMs?: number;
  }): Promise<ReleaseDeploymentClaim>;
  saveCheckpoint(input: {
    id: string;
    workerId: string;
    expectedRevision: number;
    fencingToken: number;
    checkpoint: ReleaseCheckpoint;
  }): Promise<ReleaseCheckpoint>;
  handoff(input: {
    id: string;
    workerId: string;
    expectedRevision: number;
    fencingToken: number;
  }): Promise<ReleaseDeploymentDetail>;
  getDeployment(id: string): Promise<ReleaseDeploymentDetail>;
  getArtifact(id: string): Promise<ReleaseArtifactRecord>;
}

export const databaseReleaseRuntimeRepository: ReleaseRuntimeRepository = {
  claimNext: async (input) => (await import("@/lib/releaseDeployments"))
    .claimNextReleaseDeployment(input),
  renewLease: async (input) => (await import("@/lib/releaseDeployments"))
    .renewReleaseDeploymentLease(input),
  saveCheckpoint: async (input) => (await import("@/lib/releaseDeployments"))
    .saveReleaseDeploymentCheckpoint(input),
  handoff: async (input) => (await import("@/lib/releaseDeployments"))
    .handoffReleaseDeployment(input),
  getDeployment: async (id) => (await import("@/lib/releaseDeployments"))
    .getReleaseDeployment(id),
  getArtifact: async (id) => (await import("@/lib/releaseDeployments"))
    .getReleaseArtifact(id),
};

export class ReleaseStoreRegistrationError extends Error {
  readonly code = "RELEASE_OPERATION_NOT_REGISTERED";

  constructor() {
    super("发布控制器不能创建未在后台登记的 operation");
    this.name = "ReleaseStoreRegistrationError";
  }
}

export class ReleaseLeaseLostError extends Error {
  readonly code = "RELEASE_DEPLOYMENT_LEASE_LOST";

  constructor(message = "发布任务租约或 fencing token 已失效") {
    super(message);
    this.name = "ReleaseLeaseLostError";
  }
}

/**
 * ReleaseStore view over one already-claimed deployment.
 *
 * Controller checkpoint revisions and deployment row revisions normally move
 * together. An operator cancellation is the one intentional exception: it
 * advances the row while retaining the previous checkpoint. We keep both
 * revisions so the next controller save can durably acknowledge cancellation
 * without weakening optimistic checkpoint checks.
 */
export class KnexReleaseStore implements ReleaseStore {
  readonly operationId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  private readonly repository: ReleaseRuntimeRepository;
  private readonly leaseMs?: number;
  private controllerRevision: number;
  private databaseRevision: number;
  private leaseExpiresAt: number;
  private terminal = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: {
    claim: ReleaseDeploymentClaim;
    workerId: string;
    repository?: ReleaseRuntimeRepository;
    leaseMs?: number;
  }) {
    this.operationId = options.claim.deployment.id;
    this.workerId = options.workerId;
    this.fencingToken = options.claim.fencingToken;
    this.repository = options.repository ?? databaseReleaseRuntimeRepository;
    this.leaseMs = options.leaseMs;
    this.controllerRevision = options.claim.checkpoint.revision;
    this.databaseRevision = options.claim.revision;
    this.leaseExpiresAt = options.claim.leaseExpiresAt;
    if (this.controllerRevision !== this.databaseRevision) {
      throw new ReleaseLeaseLostError("认领后的 checkpoint revision 未与 deployment revision 对齐");
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertOperation(operationId: string): void {
    if (operationId !== this.operationId) throw new ReleaseLeaseLostError("Store operation id 不匹配");
  }

  async get(operationId: string): Promise<ReleaseCheckpoint | null> {
    this.assertOperation(operationId);
    return this.exclusive(async () => {
      const deployment = await this.repository.getDeployment(operationId);
      if (deployment.fencingToken !== this.fencingToken) throw new ReleaseLeaseLostError();
      if (deployment.leaseOwner !== this.workerId && deployment.activeScope !== null) {
        throw new ReleaseLeaseLostError();
      }
      this.databaseRevision = deployment.revision;
      const checkpoint = clone(deployment.checkpoint);
      this.controllerRevision = checkpoint.revision;
      return checkpoint;
    });
  }

  async create(_checkpoint: ReleaseCheckpoint): Promise<ReleaseCheckpoint> {
    // startReleaseDeployment creates the immutable plan and first checkpoint.
    // Accepting arbitrary controller create() calls would bypass permission,
    // idempotency, artifact verification, and the active-scope uniqueness lock.
    throw new ReleaseStoreRegistrationError();
  }

  async save(checkpoint: ReleaseCheckpoint, expectedRevision: number): Promise<ReleaseCheckpoint> {
    this.assertOperation(checkpoint.operationId);
    return this.exclusive(async () => {
      if (expectedRevision !== this.controllerRevision) {
        throw new ReleaseLeaseLostError("checkpoint optimistic revision 已过期");
      }
      const persist = () => this.repository.saveCheckpoint({
        id: this.operationId,
        workerId: this.workerId,
        expectedRevision: this.databaseRevision,
        fencingToken: this.fencingToken,
        checkpoint: clone(checkpoint),
      });
      let saved: ReleaseCheckpoint;
      try {
        saved = await persist();
      } catch (error) {
        // Cancellation changes deployment metadata/revision but deliberately
        // retains the controller checkpoint. If it wins the row lock exactly
        // while a normal checkpoint is being saved, adopt that one metadata
        // revision and retry once instead of waiting for lease expiry before
        // another Controller can perform the rollback.
        const deployment = await this.repository.getDeployment(this.operationId).catch(() => null);
        if (!deployment
          || deployment.fencingToken !== this.fencingToken
          || deployment.leaseOwner !== this.workerId
          || deployment.status !== "cancelling"
          || deployment.checkpoint.revision !== this.controllerRevision) {
          throw error instanceof ReleaseLeaseLostError ? error : new ReleaseLeaseLostError();
        }
        this.databaseRevision = deployment.revision;
        saved = await persist();
      }
      this.controllerRevision = saved.revision;
      this.databaseRevision = saved.revision;
      this.terminal = saved.status !== "running";
      return clone(saved);
    });
  }

  async renewLease(): Promise<number> {
    return this.exclusive(async () => {
      if (this.terminal) return this.leaseExpiresAt;
      try {
        const renewed = await this.repository.renewLease({
          id: this.operationId,
          workerId: this.workerId,
          expectedRevision: this.databaseRevision,
          fencingToken: this.fencingToken,
          leaseMs: this.leaseMs,
        });
        if (renewed.fencingToken !== this.fencingToken || renewed.revision !== this.databaseRevision) {
          throw new ReleaseLeaseLostError("租约续期改变了 fencing token 或 checkpoint revision");
        }
        this.leaseExpiresAt = renewed.leaseExpiresAt;
        return this.leaseExpiresAt;
      } catch (error) {
        // An operator cancellation advances only the deployment row. Adopt
        // that metadata revision and retry once while the same fence remains.
        const deployment = await this.repository.getDeployment(this.operationId).catch(() => null);
        if (!deployment
          || deployment.fencingToken !== this.fencingToken
          || deployment.leaseOwner !== this.workerId
          || deployment.status !== "cancelling") {
          throw error instanceof ReleaseLeaseLostError ? error : new ReleaseLeaseLostError();
        }
        this.databaseRevision = deployment.revision;
        const renewed = await this.repository.renewLease({
          id: this.operationId,
          workerId: this.workerId,
          expectedRevision: this.databaseRevision,
          fencingToken: this.fencingToken,
          leaseMs: this.leaseMs,
        });
        this.leaseExpiresAt = renewed.leaseExpiresAt;
        return this.leaseExpiresAt;
      }
    });
  }

  async handoff(): Promise<void> {
    return this.exclusive(async () => {
      if (this.terminal) return;
      const handedOff = await this.repository.handoff({
        id: this.operationId,
        workerId: this.workerId,
        expectedRevision: this.databaseRevision,
        fencingToken: this.fencingToken,
      });
      this.controllerRevision = handedOff.checkpoint.revision;
      this.databaseRevision = handedOff.revision;
      this.terminal = true;
    });
  }

  async cancellationRequested(): Promise<boolean> {
    return this.exclusive(async () => {
      const deployment = await this.repository.getDeployment(this.operationId);
      if (deployment.fencingToken !== this.fencingToken
        || (deployment.activeScope !== null && deployment.leaseOwner !== this.workerId)) {
        throw new ReleaseLeaseLostError();
      }
      if (deployment.status === "cancelling") {
        // Preserve controllerRevision: cancellation did not write a new core
        // checkpoint. save() maps it onto this newer database revision.
        this.databaseRevision = deployment.revision;
        return true;
      }
      return deployment.status === "cancelled";
    });
  }

  snapshot(): Readonly<{
    operationId: string;
    workerId: string;
    fencingToken: number;
    controllerRevision: number;
    databaseRevision: number;
    leaseExpiresAt: number;
  }> {
    return Object.freeze({
      operationId: this.operationId,
      workerId: this.workerId,
      fencingToken: this.fencingToken,
      controllerRevision: this.controllerRevision,
      databaseRevision: this.databaseRevision,
      leaseExpiresAt: this.leaseExpiresAt,
    });
  }
}
