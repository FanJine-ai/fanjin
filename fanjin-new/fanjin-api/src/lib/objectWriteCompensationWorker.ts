import type { Knex } from "knex";

import {
  processClaimedObjectWriteCompensation,
  type ObjectWriteCompensationRuntime,
} from "@/lib/objectWriteCompensation";
import {
  claimDueObjectWriteCompensations,
  renewObjectWriteCompensationClaim,
  type ClaimedObjectWriteIntent,
  type ObjectWriteIntentClaim,
} from "@/lib/objectWriteIntent";

export interface ObjectWriteCompensationHeartbeatScheduler {
  schedule(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): unknown;
  cancel(handle: unknown): void;
}

export interface ObjectWriteCompensationBatchInput
  extends ObjectWriteCompensationRuntime {
  workerId: string;
  leaseMs?: number;
  limit?: number;
  operationTimeoutMs?: number;
  heartbeatScheduler?: ObjectWriteCompensationHeartbeatScheduler;
}

export interface ObjectWriteCompensationBatchResult {
  claimed: number;
  completed: number;
  deferred: number;
  failed: number;
}

function defaultDatabase(): Knex {
  const databaseModule = require("@/utils/db") as typeof import("@/utils/db");
  return databaseModule.db as unknown as Knex;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number)
    && number > 0
    && number <= maximum
    ? number
    : fallback;
}

const defaultHeartbeatScheduler: ObjectWriteCompensationHeartbeatScheduler = {
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

function sameClaim(
  expected: ClaimedObjectWriteIntent,
  actual: ClaimedObjectWriteIntent,
): boolean {
  return expected.id === actual.id
    && expected.leaseOwner === actual.leaseOwner
    && expected.leaseFence === actual.leaseFence;
}

function createCompensationHeartbeat(input: {
  claim: ClaimedObjectWriteIntent;
  leaseMs: number;
  database: Knex;
  clock?: () => number;
  scheduler: ObjectWriteCompensationHeartbeatScheduler;
}) {
  const intervalMs = Math.floor(input.leaseMs / 3);
  if (intervalMs < 1) {
    throw Object.assign(
      new Error("OBJECT_WRITE_COMPENSATION_LEASE_TOO_SHORT"),
      { code: "OBJECT_WRITE_COMPENSATION_LEASE_TOO_SHORT" },
    );
  }
  const controller = new AbortController();
  const lease: ObjectWriteIntentClaim = {
    id: input.claim.id,
    owner: input.claim.leaseOwner,
    fence: input.claim.leaseFence,
  };
  let scheduled: unknown;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let commitPhase = false;
  let failure: unknown | null = null;

  const cancelScheduled = () => {
    if (scheduled === undefined) return;
    input.scheduler.cancel(scheduled);
    scheduled = undefined;
  };
  const loseLease = (error: unknown) => {
    if (failure) return;
    failure = error;
    cancelScheduled();
    controller.abort(error);
  };
  const assertHealthy = () => {
    if (failure) throw failure;
    controller.signal.throwIfAborted();
  };
  const renew = async () => {
    await renewObjectWriteCompensationClaim(
      lease,
      input.leaseMs,
      {
        database: input.database,
        ...(input.clock ? { clock: input.clock } : {}),
      },
    );
  };
  const schedule = () => {
    if (stopped || commitPhase || failure) return;
    try {
      scheduled = input.scheduler.schedule(async () => {
        scheduled = undefined;
        if (stopped || commitPhase || failure) return;
        const renewal = renew()
          .catch(loseLease)
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
    get failure(): unknown | null {
      return failure;
    },
    async enterCommitPhase(actual: ClaimedObjectWriteIntent) {
      if (!sameClaim(input.claim, actual)) {
        loseLease(Object.assign(
          new Error("OBJECT_WRITE_COMPENSATION_CLAIM_MISMATCH"),
          { code: "OBJECT_WRITE_COMPENSATION_CLAIM_MISMATCH" },
        ));
      }
      commitPhase = true;
      cancelScheduled();
      const pending = inFlight;
      if (pending) await pending;
      assertHealthy();
      try {
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

export async function runObjectWriteCompensationBatch(
  input: ObjectWriteCompensationBatchInput,
): Promise<ObjectWriteCompensationBatchResult> {
  const database = input.database ?? defaultDatabase();
  const leaseMs = positiveInteger(
    input.leaseMs,
    5 * 60_000,
    24 * 60 * 60_000,
  );
  if (leaseMs < 3) {
    throw new Error("OBJECT_WRITE_COMPENSATION_LEASE_TOO_SHORT");
  }
  const limit = positiveInteger(input.limit, 20, 100);
  const operationTimeoutMs = positiveInteger(
    input.operationTimeoutMs,
    30_000,
    24 * 60 * 60_000,
  );
  const result: ObjectWriteCompensationBatchResult = {
    claimed: 0,
    completed: 0,
    deferred: 0,
    failed: 0,
  };
  for (let index = 0; index < limit; index += 1) {
    let claim;
    try {
      [claim] = await claimDueObjectWriteCompensations({
        workerId: input.workerId,
        leaseMs,
        limit: 1,
      }, {
        database,
        ...(input.clock ? { clock: input.clock } : {}),
        ...(input.configuration
          ? { configuration: input.configuration }
          : {}),
      });
    } catch {
      result.failed += 1;
      break;
    }
    if (!claim) break;
    result.claimed += 1;
    const heartbeat = createCompensationHeartbeat({
      claim,
      leaseMs,
      database,
      clock: input.clock,
      scheduler: input.heartbeatScheduler ?? defaultHeartbeatScheduler,
    });
    const operationTimeoutSignal = AbortSignal.timeout(operationTimeoutMs);
    const claimSignal = AbortSignal.any([
      heartbeat.signal,
      operationTimeoutSignal,
      ...(input.signal ? [input.signal] : []),
    ]);
    const existingBeforeClaimCommit = input.beforeClaimCommit;
    try {
      const outcome = await processClaimedObjectWriteCompensation(claim, {
        ...input,
        database,
        signal: claimSignal,
        beforeClaimCommit: async (actualClaim) => {
          await existingBeforeClaimCommit?.(actualClaim);
          await heartbeat.enterCommitPhase(actualClaim);
        },
      });
      await heartbeat.stop();
      if (heartbeat.failure) throw heartbeat.failure;
      if (outcome === "compensated") result.completed += 1;
      else result.deferred += 1;
    } catch {
      await heartbeat.stop();
      result.failed += 1;
    }
  }
  return result;
}
