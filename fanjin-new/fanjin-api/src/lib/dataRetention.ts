import os from "node:os";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { cleanupExpiredReleaseArtifactMultipartUploads } from "@/lib/releaseArtifactMultipartUpload";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DATA_RETENTION_LEASE_ID = "maintenance:data-retention";
const DATA_RETENTION_LEASE_ROLE = "maintenance:data-retention-lease";
const REQUEST_LOG_RETENTION_KEY = "platform.operations.logRetentionDays";
const DEFAULT_REQUEST_LOG_RETENTION_DAYS = 90;
const DEFAULT_RATE_LIMIT_RETENTION_MINUTES = 120;
const DEFAULT_WORKER_HEARTBEAT_RETENTION_HOURS = 24;
const DEFAULT_LOGIN_STATE_RETENTION_DAYS = 7;
const DEFAULT_CALLBACK_DELIVERED_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 400;
const DEFAULT_MAX_BATCHES = 25;
const DEFAULT_LEASE_MS = 15 * MINUTE_MS;
const DEFAULT_INTERVAL_MS = 15 * MINUTE_MS;
const DATA_RETENTION_WORKER_OWNER = `data-retention:${os.hostname()}:${process.pid}:${uuid()}`;

interface DataRetentionPolicy {
  requestLogRetentionDays: number;
  rateLimitMaxAgeMs: number;
  workerHeartbeatMaxAgeMs: number;
  loginStateMaxAgeMs: number;
  callbackDeliveredRetentionDays: number;
}

export interface DataRetentionDeletedCounts {
  requestLogs: number;
  apiKeyRateLimits: number;
  workerHeartbeats: number;
  loginStates: number;
  deliveredCallbacks: number;
}

export interface DataRetentionRunResult {
  acquired: boolean;
  rounds: number;
  stopped: boolean;
  leaseLost: boolean;
  deleted: DataRetentionDeletedCounts;
  multipartUploads: {
    examined: number;
    expired: number;
    completed: number;
    failed: number;
  };
  policy: DataRetentionPolicy | null;
}

export interface DataRetentionRunOptions {
  database?: Knex;
  now?: number;
  ownerId?: string;
  leaseMs?: number;
  batchSize?: number;
  maxBatches?: number;
  requestLogRetentionDays?: number;
  rateLimitMaxAgeMs?: number;
  workerHeartbeatMaxAgeMs?: number;
  loginStateMaxAgeMs?: number;
  callbackDeliveredRetentionDays?: number;
  shouldContinue?: () => boolean;
}

export interface DataRetentionLease {
  ownerId: string;
  renew: (now?: number) => Promise<boolean>;
  release: () => Promise<void>;
}

function boundedInteger(raw: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function emptyDeletedCounts(): DataRetentionDeletedCounts {
  return {
    requestLogs: 0,
    apiKeyRateLimits: 0,
    workerHeartbeats: 0,
    loginStates: 0,
    deliveredCallbacks: 0,
  };
}

async function readRequestLogRetentionDays(database: Knex, override?: number): Promise<number> {
  if (override !== undefined) {
    return boundedInteger(override, DEFAULT_REQUEST_LOG_RETENTION_DAYS, 0, 3650);
  }
  const row = await database<any>("o_setting")
    .where({ key: REQUEST_LOG_RETENTION_KEY })
    .select("value")
    .first();
  return boundedInteger(row?.value, DEFAULT_REQUEST_LOG_RETENTION_DAYS, 0, 3650);
}

async function resolvePolicy(database: Knex, input: DataRetentionRunOptions): Promise<DataRetentionPolicy> {
  return {
    requestLogRetentionDays: await readRequestLogRetentionDays(database, input.requestLogRetentionDays),
    rateLimitMaxAgeMs: boundedInteger(
      input.rateLimitMaxAgeMs ?? Number(process.env.FANJIN_DATA_RETENTION_RATE_LIMIT_MINUTES) * MINUTE_MS,
      DEFAULT_RATE_LIMIT_RETENTION_MINUTES * MINUTE_MS,
      2 * MINUTE_MS,
      30 * DAY_MS,
    ),
    workerHeartbeatMaxAgeMs: boundedInteger(
      input.workerHeartbeatMaxAgeMs ?? Number(process.env.FANJIN_DATA_RETENTION_WORKER_HEARTBEAT_HOURS) * HOUR_MS,
      DEFAULT_WORKER_HEARTBEAT_RETENTION_HOURS * HOUR_MS,
      HOUR_MS,
      30 * DAY_MS,
    ),
    loginStateMaxAgeMs: boundedInteger(
      input.loginStateMaxAgeMs ?? Number(process.env.FANJIN_DATA_RETENTION_LOGIN_STATE_DAYS) * DAY_MS,
      DEFAULT_LOGIN_STATE_RETENTION_DAYS * DAY_MS,
      DAY_MS,
      365 * DAY_MS,
    ),
    callbackDeliveredRetentionDays: boundedInteger(
      input.callbackDeliveredRetentionDays ?? process.env.FANJIN_DATA_RETENTION_CALLBACK_DELIVERED_DAYS,
      DEFAULT_CALLBACK_DELIVERED_RETENTION_DAYS,
      0,
      3650,
    ),
  };
}

/**
 * Reuse the durable worker-heartbeat table as a single-row CAS lease. The
 * dedicated role is excluded from readiness and stale-heartbeat cleanup.
 * A process crash leaves an expiring row that another worker may claim.
 */
export async function tryAcquireDataRetentionLease(
  database: Knex,
  input: { ownerId: string; now?: number; leaseMs?: number },
): Promise<DataRetentionLease | null> {
  const ownerId = String(input.ownerId || "").trim();
  if (!ownerId) throw new Error("data retention lease ownerId is required");
  const timestamp = input.now ?? Date.now();
  const leaseMs = boundedInteger(input.leaseMs, DEFAULT_LEASE_MS, MINUTE_MS, 60 * MINUTE_MS);
  const leasePatch = {
    role: DATA_RETENTION_LEASE_ROLE,
    hostname: ownerId,
    processId: process.pid,
    startedAt: timestamp,
    heartbeatAt: timestamp + leaseMs,
    updatedAt: timestamp,
  };

  let acquired = false;
  const existing = await database<any>("o_worker_heartbeat").where({ id: DATA_RETENTION_LEASE_ID }).first();
  if (!existing) {
    try {
      await database<any>("o_worker_heartbeat").insert({
        id: DATA_RETENTION_LEASE_ID,
        ...leasePatch,
        createdAt: timestamp,
      });
      acquired = true;
    } catch (error) {
      // A competing worker may have inserted the fixed lease row after our
      // read. Only suppress that expected race when the row now exists.
      const raced = await database<any>("o_worker_heartbeat").where({ id: DATA_RETENTION_LEASE_ID }).first();
      if (!raced) throw error;
    }
  }

  if (!acquired) {
    const updated = await database<any>("o_worker_heartbeat")
      .where({ id: DATA_RETENTION_LEASE_ID })
      .andWhere("heartbeatAt", "<=", timestamp)
      .update(leasePatch);
    acquired = Number(updated || 0) === 1;
  }
  if (!acquired) return null;

  let released = false;
  return {
    ownerId,
    renew: async (now = Date.now()) => {
      if (released) return false;
      const renewed = await database<any>("o_worker_heartbeat")
        .where({
          id: DATA_RETENTION_LEASE_ID,
          role: DATA_RETENTION_LEASE_ROLE,
          hostname: ownerId,
          processId: process.pid,
        })
        .andWhere("heartbeatAt", ">", now)
        .update({ heartbeatAt: now + leaseMs, updatedAt: now });
      return Number(renewed || 0) === 1;
    },
    release: async () => {
      if (released) return;
      released = true;
      await database<any>("o_worker_heartbeat")
        .where({
          id: DATA_RETENTION_LEASE_ID,
          role: DATA_RETENTION_LEASE_ROLE,
          hostname: ownerId,
          processId: process.pid,
        })
        .delete();
    },
  };
}

async function deleteRequestLogBatch(database: Knex, cutoff: number, batchSize: number): Promise<number> {
  const rows = await database<any>("o_request_log")
    .where("createdAt", "<", cutoff)
    .select("id")
    .orderBy("createdAt", "asc")
    .limit(batchSize);
  const ids = rows.map((row: any) => String(row.id));
  if (!ids.length) return 0;
  const deleted = await database<any>("o_request_log")
    .whereIn("id", ids)
    .andWhere("createdAt", "<", cutoff)
    .delete();
  return Number(deleted || 0);
}

async function deleteRateLimitBatch(database: Knex, cutoff: number, batchSize: number): Promise<number> {
  const rows = await database<any>("o_api_key_rate_limit")
    .where("windowStart", "<", cutoff)
    .select("apiKeyId", "windowStart")
    .orderBy("windowStart", "asc")
    .limit(batchSize);
  if (!rows.length) return 0;
  const keys = rows.map((row: any) => [String(row.apiKeyId), Number(row.windowStart)]);
  const deleted = await database<any>("o_api_key_rate_limit")
    .whereIn(["apiKeyId", "windowStart"], keys)
    .andWhere("windowStart", "<", cutoff)
    .delete();
  return Number(deleted || 0);
}

async function deleteWorkerHeartbeatBatch(database: Knex, cutoff: number, batchSize: number): Promise<number> {
  const rows = await database<any>("o_worker_heartbeat")
    .where({ role: "background" })
    .andWhere("heartbeatAt", "<", cutoff)
    .select("id")
    .orderBy("heartbeatAt", "asc")
    .limit(batchSize);
  const ids = rows.map((row: any) => String(row.id));
  if (!ids.length) return 0;
  const deleted = await database<any>("o_worker_heartbeat")
    .whereIn("id", ids)
    .andWhere({ role: "background" })
    .andWhere("heartbeatAt", "<", cutoff)
    .delete();
  return Number(deleted || 0);
}

async function deleteLoginStateBatch(
  database: Knex,
  cutoff: number,
  now: number,
  batchSize: number,
): Promise<number> {
  const eligible = (query: Knex.QueryBuilder) => {
    query.whereNull("lockedUntil").orWhere("lockedUntil", "<=", now);
  };
  const rows = await database<any>("o_auth_login_state")
    .where("updatedAt", "<", cutoff)
    .andWhere(eligible)
    .select("identityHash")
    .orderBy("updatedAt", "asc")
    .limit(batchSize);
  const ids = rows.map((row: any) => String(row.identityHash));
  if (!ids.length) return 0;
  const deleted = await database<any>("o_auth_login_state")
    .whereIn("identityHash", ids)
    .andWhere("updatedAt", "<", cutoff)
    .andWhere(eligible)
    .delete();
  return Number(deleted || 0);
}

async function deleteDeliveredCallbackBatch(database: Knex, cutoff: number, batchSize: number): Promise<number> {
  const rows = await database<any>("o_relay_callback_delivery")
    .where({ status: "delivered" })
    .whereNotNull("deliveredAt")
    .andWhere("deliveredAt", "<", cutoff)
    .select("id")
    .orderBy("deliveredAt", "asc")
    .limit(batchSize);
  const ids = rows.map((row: any) => String(row.id));
  if (!ids.length) return 0;
  const deleted = await database<any>("o_relay_callback_delivery")
    .whereIn("id", ids)
    .andWhere({ status: "delivered" })
    .whereNotNull("deliveredAt")
    .andWhere("deliveredAt", "<", cutoff)
    .delete();
  return Number(deleted || 0);
}

export async function runDataRetentionCycle(input: DataRetentionRunOptions = {}): Promise<DataRetentionRunResult> {
  const database = input.database || db;
  const referenceNow = input.now ?? Date.now();
  const leaseNow = input.now ?? Date.now();
  const ownerId = String(input.ownerId || DATA_RETENTION_WORKER_OWNER);
  const leaseMs = boundedInteger(
    input.leaseMs ?? process.env.FANJIN_DATA_RETENTION_LEASE_MS,
    DEFAULT_LEASE_MS,
    MINUTE_MS,
    60 * MINUTE_MS,
  );
  const batchSize = boundedInteger(
    input.batchSize ?? process.env.FANJIN_DATA_RETENTION_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    1,
    400,
  );
  const maxBatches = boundedInteger(
    input.maxBatches ?? process.env.FANJIN_DATA_RETENTION_MAX_BATCHES,
    DEFAULT_MAX_BATCHES,
    1,
    100,
  );
  const result: DataRetentionRunResult = {
    acquired: false,
    rounds: 0,
    stopped: false,
    leaseLost: false,
    deleted: emptyDeletedCounts(),
    multipartUploads: { examined: 0, expired: 0, completed: 0, failed: 0 },
    policy: null,
  };
  const lease = await tryAcquireDataRetentionLease(database, { ownerId, now: leaseNow, leaseMs });
  if (!lease) return result;
  result.acquired = true;

  try {
    const policy = await resolvePolicy(database, input);
    result.policy = policy;
    // This worker already owns a cluster-wide expiring CAS lease, so it is the
    // canonical place to abort provider uploads and terminalize expired
    // resumable sessions exactly once per retention cycle.
    result.multipartUploads = await cleanupExpiredReleaseArtifactMultipartUploads(
      { limit: batchSize, now: referenceNow },
      { database },
    );
    const requestLogCutoff = policy.requestLogRetentionDays > 0
      ? referenceNow - policy.requestLogRetentionDays * DAY_MS
      : null;
    const rateLimitCutoff = referenceNow - policy.rateLimitMaxAgeMs;
    const heartbeatCutoff = referenceNow - policy.workerHeartbeatMaxAgeMs;
    const loginStateCutoff = referenceNow - policy.loginStateMaxAgeMs;
    const callbackCutoff = policy.callbackDeliveredRetentionDays > 0
      ? referenceNow - policy.callbackDeliveredRetentionDays * DAY_MS
      : null;

    for (let round = 0; round < maxBatches; round += 1) {
      if (input.shouldContinue && !input.shouldContinue()) {
        result.stopped = true;
        break;
      }
      const leaseValid = await lease.renew(input.now ?? Date.now());
      if (!leaseValid) {
        result.leaseLost = true;
        break;
      }

      let deletedThisRound = 0;
      const runBatch = async (work: () => Promise<number>): Promise<number> => {
        if (input.shouldContinue && !input.shouldContinue()) {
          result.stopped = true;
          return 0;
        }
        const deleted = await work();
        deletedThisRound += deleted;
        return deleted;
      };

      if (requestLogCutoff != null) {
        result.deleted.requestLogs += await runBatch(
          () => deleteRequestLogBatch(database, requestLogCutoff, batchSize),
        );
      }
      result.deleted.apiKeyRateLimits += await runBatch(
        () => deleteRateLimitBatch(database, rateLimitCutoff, batchSize),
      );
      result.deleted.workerHeartbeats += await runBatch(
        () => deleteWorkerHeartbeatBatch(database, heartbeatCutoff, batchSize),
      );
      result.deleted.loginStates += await runBatch(
        () => deleteLoginStateBatch(database, loginStateCutoff, referenceNow, batchSize),
      );
      if (callbackCutoff != null) {
        result.deleted.deliveredCallbacks += await runBatch(
          () => deleteDeliveredCallbackBatch(database, callbackCutoff, batchSize),
        );
      }

      result.rounds += 1;
      if (result.stopped || deletedThisRound === 0) break;
    }
    return result;
  } finally {
    await lease.release();
  }
}

let dataRetentionTimer: NodeJS.Timeout | null = null;
let dataRetentionRunning: Promise<DataRetentionRunResult> | null = null;
let dataRetentionStopRequested = false;

function runDataRetentionWorkerTick(): Promise<DataRetentionRunResult> | null {
  if (dataRetentionRunning || dataRetentionStopRequested) return dataRetentionRunning;
  dataRetentionRunning = runDataRetentionCycle({
    ownerId: DATA_RETENTION_WORKER_OWNER,
    shouldContinue: () => !dataRetentionStopRequested,
  })
    .then((result) => {
      const totalDeleted = Object.values(result.deleted).reduce((sum, count) => sum + count, 0);
      if (totalDeleted > 0) {
        console.log(`[data-retention] deleted=${totalDeleted}`, result.deleted);
      }
      return result;
    })
    .catch((error: any) => {
      console.warn("[data-retention] batch failed", error?.message || error);
      throw error;
    })
    .finally(() => {
      dataRetentionRunning = null;
    });
  // The timer-driven worker reports failures via its logger; do not create an
  // unhandled rejection when nobody is awaiting an immediate startup tick.
  void dataRetentionRunning.catch(() => undefined);
  return dataRetentionRunning;
}

export function startDataRetentionWorker(): void {
  if (dataRetentionTimer || dataRetentionRunning || process.env.FANJIN_DISABLE_DATA_RETENTION_WORKER === "1") return;
  dataRetentionStopRequested = false;
  const intervalMs = boundedInteger(
    process.env.FANJIN_DATA_RETENTION_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    MINUTE_MS,
    7 * DAY_MS,
  );
  void runDataRetentionWorkerTick();
  dataRetentionTimer = setInterval(() => {
    void runDataRetentionWorkerTick();
  }, intervalMs);
  dataRetentionTimer.unref?.();
}

export async function stopDataRetentionWorker(): Promise<void> {
  dataRetentionStopRequested = true;
  if (dataRetentionTimer) clearInterval(dataRetentionTimer);
  dataRetentionTimer = null;
  const running = dataRetentionRunning;
  if (running) await running.catch(() => undefined);
}
