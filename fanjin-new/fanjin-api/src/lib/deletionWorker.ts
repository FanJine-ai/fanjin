import crypto from "node:crypto";
import os from "node:os";
import type { Knex } from "knex";

import {
  DeletionOutboxRepository,
  type ConditionalDeletionProviderV1,
} from "@/lib/deletionOutbox";
import {
  assertDeletionOutboxManifestBeforeProviderCall,
  claimDueDeletionOperations,
  DeletionWorkflowError,
  finalizeDeletionOperation,
  recordDeletionOperationFailure,
  renewDeletionOperationClaim,
  type ClaimedDeletionOperation,
  type DeletionOperationLease,
  type DeletionWorkflowRuntime,
} from "@/lib/deletionWorkflow";
import {
  createObjectStorageConditionalDeletionProvider,
} from "@/lib/objectStorageDeletion";
import {
  runObjectWriteCompensationBatch,
} from "@/lib/objectWriteCompensationWorker";
import { getReleaseIdentity } from "@/lib/releaseIdentity";

export interface DeletionWorkerBatchInput {
  workerId: string;
  database?: Knex;
  clock?: () => number;
  provider?: ConditionalDeletionProviderV1;
  providerFactory?: () => ConditionalDeletionProviderV1;
  workflowRuntime?: DeletionWorkflowRuntime;
  dispatchLimit?: number;
  reconciliationLimit?: number;
  operationLimit?: number;
  leaseMs?: number;
  providerTimeoutMs?: number;
  operationHeartbeatScheduler?: DeletionOperationHeartbeatScheduler;
}

export interface DeletionOperationHeartbeatScheduler {
  schedule(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): unknown;
  cancel(handle: unknown): void;
}

export interface DeletionWorkerBatchResult {
  dispatchClaimed: number;
  dispatchCompleted: number;
  reconciliationClaimed: number;
  reconciliationCompleted: number;
  operationsClaimed: number;
  operationsCompleted: number;
  operationsBlocked: number;
  failures: number;
}

function defaultDeletionWorkerDatabase(): Knex {
  const databaseModule = require("@/utils/db") as typeof import("@/utils/db");
  return databaseModule.db as unknown as Knex;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum
    ? number
    : fallback;
}

function workerId(value: unknown): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > 255
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("DELETION_WORKER_ID_INVALID");
  }
  return value;
}

const defaultOperationHeartbeatScheduler: DeletionOperationHeartbeatScheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(() => {
      void Promise.resolve(callback()).catch(() => undefined);
    }, delayMs);
    handle.unref?.();
    return handle;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function heartbeatFailure(cause: unknown): DeletionWorkflowError {
  if (cause instanceof DeletionWorkflowError) return cause;
  const error = new DeletionWorkflowError(
    "删除 operation 续租失败，已中止长任务",
    "DELETION_OPERATION_LEASE_RENEWAL_FAILED",
    503,
  ) as DeletionWorkflowError & { cause?: unknown };
  error.cause = cause;
  return error;
}

function sameLease(
  expected: DeletionOperationLease,
  actual: DeletionOperationLease,
): boolean {
  return expected.operationId === actual.operationId
    && expected.workerId === actual.workerId
    && expected.coordinatorFence === actual.coordinatorFence;
}

function createOperationClaimHeartbeat(input: {
  claim: ClaimedDeletionOperation;
  leaseMs: number;
  runtime: DeletionWorkflowRuntime;
  scheduler: DeletionOperationHeartbeatScheduler;
}) {
  const intervalMs = Math.floor(input.leaseMs / 3);
  if (intervalMs < 1 || intervalMs > input.leaseMs / 3) {
    throw new Error("DELETION_OPERATION_HEARTBEAT_INTERVAL_INVALID");
  }
  const controller = new AbortController();
  const lease: DeletionOperationLease = {
    operationId: input.claim.id,
    workerId: input.claim.coordinatorLeaseOwner,
    coordinatorFence: input.claim.coordinatorFence,
  };
  let scheduled: unknown;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let commitPhase = false;
  let failure: DeletionWorkflowError | null = null;

  const cancelScheduled = () => {
    if (scheduled === undefined) return;
    input.scheduler.cancel(scheduled);
    scheduled = undefined;
  };
  const loseLease = (cause: unknown) => {
    if (failure) return;
    failure = heartbeatFailure(cause);
    cancelScheduled();
    controller.abort(failure);
  };
  const assertHealthy = () => {
    if (failure) throw failure;
    controller.signal.throwIfAborted();
  };
  const renew = async () => {
    await renewDeletionOperationClaim({
      ...lease,
      status: input.claim.status,
      leaseMs: input.leaseMs,
    }, input.runtime);
  };
  const schedule = () => {
    if (stopped || commitPhase || failure) return;
    try {
      scheduled = input.scheduler.schedule(async () => {
        scheduled = undefined;
        if (stopped || commitPhase || failure) return;
        const renewal = renew()
          .catch((error) => loseLease(error))
          .finally(() => {
            if (inFlight === renewal) inFlight = null;
            schedule();
          });
        inFlight = renewal;
        await renewal;
      }, intervalMs);
    } catch (error) {
      loseLease(error);
    }
  };
  schedule();

  return {
    signal: controller.signal,
    get failure(): DeletionWorkflowError | null {
      return failure;
    },
    async enterCommitPhase(actualLease: DeletionOperationLease) {
      if (!sameLease(lease, actualLease)) {
        loseLease(new DeletionWorkflowError(
          "删除 operation 提交租约与 heartbeat 不一致",
          "DELETION_OPERATION_LEASE_LOST",
          409,
        ));
      }
      commitPhase = true;
      cancelScheduled();
      const pending = inFlight;
      if (pending) await pending;
      assertHealthy();
      try {
        // This is the final renewal before the transaction takes FOR UPDATE.
        // Heartbeats stay paused while that row lock is held: a second
        // connection cannot prove renewal without waiting on the same lock.
        await renew();
      } catch (error) {
        loseLease(error);
      }
      assertHealthy();
    },
    async stop() {
      stopped = true;
      commitPhase = true;
      cancelScheduled();
      const pending = inFlight;
      if (pending) await pending;
    },
  };
}

export async function runDeletionWorkerBatch(
  input: DeletionWorkerBatchInput,
): Promise<DeletionWorkerBatchResult> {
  const database = input.database ?? defaultDeletionWorkerDatabase();
  const owner = workerId(input.workerId);
  const leaseMs = positiveInteger(
    input.leaseMs,
    5 * 60_000,
    24 * 60 * 60_000,
  );
  if (leaseMs < 3) {
    throw new Error("DELETION_OPERATION_LEASE_TOO_SHORT");
  }
  const dispatchLimit = positiveInteger(input.dispatchLimit, 20, 100);
  const reconciliationLimit = positiveInteger(
    input.reconciliationLimit,
    20,
    100,
  );
  const operationLimit = positiveInteger(input.operationLimit, 20, 100);
  const providerTimeoutMs = positiveInteger(
    input.providerTimeoutMs,
    30_000,
    24 * 60 * 60_000,
  );
  const repository = new DeletionOutboxRepository(database, {
    clock: input.clock,
    defaultLeaseMs: leaseMs,
    defaultProviderTimeoutMs: providerTimeoutMs,
    requireDispatchableParentOperation: true,
  });
  const result: DeletionWorkerBatchResult = {
    dispatchClaimed: 0,
    dispatchCompleted: 0,
    reconciliationClaimed: 0,
    reconciliationCompleted: 0,
    operationsClaimed: 0,
    operationsCompleted: 0,
    operationsBlocked: 0,
    failures: 0,
  };
  let resolvedProvider: ConditionalDeletionProviderV1 | null = null;
  const provider = () => {
    if (!resolvedProvider) {
      resolvedProvider = input.provider
        ?? (
          input.providerFactory
            ? input.providerFactory()
            : createObjectStorageConditionalDeletionProvider({ database })
        );
    }
    return resolvedProvider;
  };

  for (let index = 0; index < dispatchLimit; index += 1) {
    let claim;
    try {
      [claim] = await repository.claimDue({
        workerId: `${owner}:dispatch`,
        leaseMs,
        limit: 1,
      });
    } catch {
      result.failures += 1;
      break;
    }
    if (!claim) break;
    result.dispatchClaimed += 1;
    try {
      await assertDeletionOutboxManifestBeforeProviderCall(
        {
          operationId: claim.operationId,
          outboxId: claim.id,
        },
        { database, ...(input.clock ? { clock: input.clock } : {}) },
      );
      const processed = await repository.processClaim({
        claim,
        provider: provider(),
        providerTimeoutMs,
      });
      if (processed.status === "completed") result.dispatchCompleted += 1;
    } catch {
      // A repository-level lease/storage error cannot be acknowledged safely.
      // The durable lease expires and another cycle recovers it.
      result.failures += 1;
    }
  }

  for (let index = 0; index < reconciliationLimit; index += 1) {
    let claim;
    try {
      [claim] = await repository.claimDueReconciliations({
        workerId: `${owner}:reconcile`,
        leaseMs,
        limit: 1,
      });
    } catch {
      result.failures += 1;
      break;
    }
    if (!claim) break;
    result.reconciliationClaimed += 1;
    try {
      await assertDeletionOutboxManifestBeforeProviderCall(
        {
          operationId: claim.operationId,
          outboxId: claim.id,
          phase: "reconcile",
        },
        { database, ...(input.clock ? { clock: input.clock } : {}) },
      );
      const processed = await repository.processReconciliation({
        claim,
        provider: provider(),
        providerTimeoutMs,
      });
      if (processed.status === "completed") {
        result.reconciliationCompleted += 1;
      }
    } catch {
      result.failures += 1;
    }
  }

  const workflowRuntime: DeletionWorkflowRuntime = {
    ...input.workflowRuntime,
    database,
    ...(input.clock ? { clock: input.clock } : {}),
  };
  for (let index = 0; index < operationLimit; index += 1) {
    let claim;
    try {
      [claim] = await claimDueDeletionOperations(
        {
          workerId: `${owner}:operation`,
          leaseMs,
          limit: 1,
        },
        workflowRuntime,
      );
    } catch {
      result.failures += 1;
      break;
    }
    if (!claim) break;
    result.operationsClaimed += 1;
    const heartbeat = createOperationClaimHeartbeat({
      claim,
      leaseMs,
      runtime: workflowRuntime,
      scheduler: input.operationHeartbeatScheduler
        ?? defaultOperationHeartbeatScheduler,
    });
    const claimSignal = input.workflowRuntime?.signal
      ? AbortSignal.any([
          input.workflowRuntime.signal,
          heartbeat.signal,
        ])
      : heartbeat.signal;
    const existingBeforeCommit =
      input.workflowRuntime?.beforeClaimedOperationCommit;
    const claimedRuntime: DeletionWorkflowRuntime = {
      ...workflowRuntime,
      signal: claimSignal,
      beforeClaimedOperationCommit: async (operationLease) => {
        if (existingBeforeCommit) {
          await existingBeforeCommit(operationLease);
        }
        await heartbeat.enterCommitPhase(operationLease);
      },
    };
    try {
      const operation = await finalizeDeletionOperation(
        claim.id,
        claimedRuntime,
        {
          operationId: claim.id,
          workerId: claim.coordinatorLeaseOwner,
          coordinatorFence: claim.coordinatorFence,
        },
      );
      await heartbeat.stop();
      if (heartbeat.failure) throw heartbeat.failure;
      if (operation.status === "completed") result.operationsCompleted += 1;
      if (operation.status === "blocked") result.operationsBlocked += 1;
    } catch (error) {
      await heartbeat.stop();
      result.failures += 1;
      try {
        const operation = await recordDeletionOperationFailure(
          claim,
          heartbeat.failure ?? error,
          workflowRuntime,
        );
        if (operation.status === "blocked") result.operationsBlocked += 1;
      } catch {
        // The claim may have expired or moved while the failed operation was
        // running. Never overwrite the newer owner's state.
      }
    }
  }
  return result;
}

let deletionWorkerTimer: NodeJS.Timeout | null = null;
let deletionWorkerHeartbeatTimer: NodeJS.Timeout | null = null;
let deletionWorkerStarting: Promise<void> | null = null;
let deletionWorkerRunning: Promise<DeletionWorkerBatchResult> | null = null;
let deletionWorkerHeartbeatWrite: Promise<void> | null = null;
let deletionWorkerDatabase: Knex | null = null;
let deletionWorkerStopRequested = false;
let deletionWorkerOwner = "";
let deletionWorkerHeartbeatId = "";
let deletionWorkerStartedAt = 0;
let deletionWorkerHasSuccessfulPoll = false;
let deletionWorkerLastPollHealthy = false;

function deletionWorkerNodeId(): string | null {
  const value = String(
    process.env.FANJIN_RELEASE_NODE_ID
      || process.env.FANJIN_NODE_ID
      || "",
  ).trim();
  return value || null;
}

async function writeDeletionWorkerHeartbeat(
  activeTaskCount: 0 | 1,
  acceptingWork: 0 | 1,
): Promise<void> {
  if (!deletionWorkerHeartbeatId || deletionWorkerStopRequested) return;
  const timestamp = Date.now();
  const release = getReleaseIdentity();
  const patch = {
    role: "deletion",
    hostname: os.hostname(),
    processId: process.pid,
    nodeId: deletionWorkerNodeId(),
    incarnationId: deletionWorkerHeartbeatId,
    releaseId: release.releaseId,
    artifactSha256: release.artifactSha256,
    schemaVersion: release.schemaVersion,
    acceptingWork,
    activeTaskCount,
    drainOperationId: null,
    controlRevision: null,
    heartbeatAt: timestamp,
    updatedAt: timestamp,
  };
  const database =
    deletionWorkerDatabase ?? defaultDeletionWorkerDatabase();
  const updated = await database("o_worker_heartbeat")
    .where({ id: deletionWorkerHeartbeatId })
    .update(patch);
  if (Number(updated) > 0) return;
  try {
    await database("o_worker_heartbeat").insert({
      id: deletionWorkerHeartbeatId,
      ...patch,
      startedAt: deletionWorkerStartedAt || timestamp,
      createdAt: deletionWorkerStartedAt || timestamp,
    });
  } catch (error) {
    const retried = await database("o_worker_heartbeat")
      .where({ id: deletionWorkerHeartbeatId })
      .update(patch);
    if (Number(retried) === 0) throw error;
  }
}

function scheduleDeletionWorkerHeartbeat(): void {
  if (
    deletionWorkerStopRequested
    || deletionWorkerHeartbeatWrite
    || !deletionWorkerHeartbeatId
  ) {
    return;
  }
  const running = writeDeletionWorkerHeartbeat(
    deletionWorkerRunning ? 1 : 0,
    deletionWorkerHasSuccessfulPoll && deletionWorkerLastPollHealthy ? 1 : 0,
  );
  let tracked: Promise<void>;
  tracked = running
    .catch((error: unknown) => {
      console.warn(
        "[deletion-worker] heartbeat failed",
        error instanceof Error ? error.message : String(error),
      );
    })
    .finally(() => {
      if (deletionWorkerHeartbeatWrite === tracked) {
        deletionWorkerHeartbeatWrite = null;
      }
    });
  deletionWorkerHeartbeatWrite = tracked;
}

async function waitForScheduledDeletionWorkerHeartbeat(): Promise<void> {
  const pending = deletionWorkerHeartbeatWrite;
  if (pending) await pending.catch(() => undefined);
}

function runDeletionWorkerTick(): Promise<DeletionWorkerBatchResult> | null {
  if (deletionWorkerRunning || deletionWorkerStopRequested) {
    return deletionWorkerRunning;
  }
  deletionWorkerRunning = (async () => {
    const database =
      deletionWorkerDatabase ?? defaultDeletionWorkerDatabase();
    const result = await runDeletionWorkerBatch({
      workerId: deletionWorkerOwner,
      database,
    });
    const objectWriteCompensation = await runObjectWriteCompensationBatch({
      workerId: `${deletionWorkerOwner}:object-write-compensation`,
      database,
      leaseMs: positiveInteger(
        process.env.FANJIN_OBJECT_WRITE_COMPENSATION_LEASE_MS,
        5 * 60_000,
        24 * 60 * 60_000,
      ),
      limit: positiveInteger(
        process.env.FANJIN_OBJECT_WRITE_COMPENSATION_BATCH_LIMIT,
        20,
        100,
      ),
      operationTimeoutMs: positiveInteger(
        process.env
          .FANJIN_OBJECT_WRITE_COMPENSATION_OPERATION_TIMEOUT_MS,
        30_000,
        24 * 60 * 60_000,
      ),
    });
      if (
        result.dispatchClaimed
        || result.reconciliationClaimed
        || result.operationsClaimed
        || result.failures
        || objectWriteCompensation.claimed
        || objectWriteCompensation.failed
      ) {
        console.log("[deletion-worker] batch", {
          ...result,
          objectWriteCompensation,
        });
      }
      if (result.failures > 0 || objectWriteCompensation.failed > 0) {
        throw new Error("DELETION_WORKER_BATCH_FAILED");
    }
    deletionWorkerHasSuccessfulPoll = true;
    deletionWorkerLastPollHealthy = true;
    await waitForScheduledDeletionWorkerHeartbeat();
    await writeDeletionWorkerHeartbeat(0, 1);
    return result;
  })()
    .catch(async (error: unknown) => {
      deletionWorkerLastPollHealthy = false;
      if (deletionWorkerHasSuccessfulPoll) {
        try {
          // A heartbeat scheduled while this batch was still believed healthy
          // must settle before the red write, otherwise it could land last.
          await waitForScheduledDeletionWorkerHeartbeat();
          // Keep refreshing a durable red heartbeat so readiness cannot
          // mistake a live-but-broken poller for a healthy recovery worker.
          await writeDeletionWorkerHeartbeat(0, 0);
        } catch (heartbeatError) {
          console.warn(
            "[deletion-worker] unhealthy heartbeat failed",
            heartbeatError instanceof Error
              ? heartbeatError.message
              : String(heartbeatError),
          );
        }
      }
      console.warn(
        "[deletion-worker] batch failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    })
    .finally(() => {
      deletionWorkerRunning = null;
    });
  void deletionWorkerRunning.catch(() => undefined);
  return deletionWorkerRunning;
}

export function startDeletionWorker(database?: Knex): Promise<void> {
  if (deletionWorkerStarting) return deletionWorkerStarting;
  if (
    deletionWorkerTimer
    || process.env.FANJIN_DISABLE_DELETION_WORKER === "1"
  ) {
    return Promise.resolve();
  }
  if (deletionWorkerRunning) {
    return deletionWorkerRunning.then(() => undefined);
  }
  deletionWorkerStopRequested = false;
  deletionWorkerDatabase =
    database ?? defaultDeletionWorkerDatabase();
  deletionWorkerOwner =
    `deletion-${process.pid}-${crypto.randomUUID()}`;
  deletionWorkerHeartbeatId =
    `deletion:${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  deletionWorkerStartedAt = Date.now();
  deletionWorkerHasSuccessfulPoll = false;
  deletionWorkerLastPollHealthy = false;
  const intervalMs = positiveInteger(
    process.env.FANJIN_DELETION_WORKER_INTERVAL_MS,
    5_000,
    24 * 60 * 60_000,
  );
  const workerHeartbeatMaxAgeMs = positiveInteger(
    process.env.FANJIN_WORKER_HEARTBEAT_MAX_AGE_MS,
    45_000,
    24 * 60 * 60_000,
  );
  const heartbeatIntervalMs = Math.max(
    1,
    Math.min(intervalMs, Math.floor(workerHeartbeatMaxAgeMs / 3)),
  );
  const starting = (async () => {
    try {
      const initialTick = runDeletionWorkerTick();
      if (!initialTick) {
        throw new Error("DELETION_WORKER_INITIAL_TICK_UNAVAILABLE");
      }
      await initialTick;
      if (deletionWorkerStopRequested) return;
      deletionWorkerTimer = setInterval(() => {
        void runDeletionWorkerTick();
      }, intervalMs);
      deletionWorkerTimer.unref?.();
      deletionWorkerHeartbeatTimer = setInterval(() => {
        scheduleDeletionWorkerHeartbeat();
      }, heartbeatIntervalMs);
      deletionWorkerHeartbeatTimer.unref?.();
    } catch (error) {
      deletionWorkerStopRequested = true;
      const failedHeartbeatId = deletionWorkerHeartbeatId;
      const failedHeartbeatDatabase = deletionWorkerDatabase;
      await waitForScheduledDeletionWorkerHeartbeat();
      if (failedHeartbeatId && failedHeartbeatDatabase) {
        await failedHeartbeatDatabase("o_worker_heartbeat")
          .where({ id: failedHeartbeatId, role: "deletion" })
          .delete()
          .catch(() => undefined);
      }
      deletionWorkerOwner = "";
      deletionWorkerHeartbeatId = "";
      deletionWorkerStartedAt = 0;
      deletionWorkerHasSuccessfulPoll = false;
      deletionWorkerLastPollHealthy = false;
      deletionWorkerDatabase = null;
      throw error;
    }
  })();
  let trackedStarting: Promise<void>;
  trackedStarting = starting.finally(() => {
    if (deletionWorkerStarting === trackedStarting) {
      deletionWorkerStarting = null;
    }
  });
  deletionWorkerStarting = trackedStarting;
  return trackedStarting;
}

export async function stopDeletionWorker(): Promise<void> {
  deletionWorkerStopRequested = true;
  if (deletionWorkerTimer) clearInterval(deletionWorkerTimer);
  deletionWorkerTimer = null;
  if (deletionWorkerHeartbeatTimer) {
    clearInterval(deletionWorkerHeartbeatTimer);
  }
  deletionWorkerHeartbeatTimer = null;
  const starting = deletionWorkerStarting;
  const running = deletionWorkerRunning;
  if (starting) await starting.catch(() => undefined);
  if (running) await running.catch(() => undefined);
  if (deletionWorkerHeartbeatWrite) {
    await deletionWorkerHeartbeatWrite.catch(() => undefined);
  }
  deletionWorkerHeartbeatWrite = null;
  const heartbeatId = deletionWorkerHeartbeatId;
  const database = deletionWorkerDatabase;
  deletionWorkerHeartbeatId = "";
  deletionWorkerStartedAt = 0;
  deletionWorkerHasSuccessfulPoll = false;
  deletionWorkerLastPollHealthy = false;
  if (heartbeatId) {
    const heartbeatDatabase =
      database ?? defaultDeletionWorkerDatabase();
    await heartbeatDatabase("o_worker_heartbeat")
      .where({ id: heartbeatId, role: "deletion" })
      .delete()
      .catch(() => undefined);
  }
  deletionWorkerOwner = "";
  deletionWorkerDatabase = null;
}

export function isDeletionWorkerRunning(): boolean {
  return Boolean(
    deletionWorkerStarting
    || deletionWorkerTimer
    || deletionWorkerRunning,
  );
}
