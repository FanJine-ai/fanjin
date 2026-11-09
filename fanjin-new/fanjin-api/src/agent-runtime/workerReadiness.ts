import os from "node:os";
import type { Knex } from "knex";
import { isProductionRuntime } from "@/lib/legacyAsyncRelaySafety";
import { getReleaseIdentity } from "@/lib/releaseIdentity";
import { resolveWorkerHeartbeatFutureSkewMs } from "@/lib/workerHeartbeatPolicy";

export const AGENT_RUNTIME_WORKER_HEARTBEAT_ROLE = "agent-runtime";
export const AGENT_RUNTIME_WORKER_HEARTBEAT_INTERVAL_ENV =
  "FANJIN_AGENT_WORKER_READINESS_HEARTBEAT_MS";
export const AGENT_RUNTIME_WORKER_HEARTBEAT_MAX_AGE_ENV =
  "FANJIN_AGENT_WORKER_READINESS_MAX_AGE_MS";

const DEFAULT_AGENT_WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_AGENT_WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;
const DEFAULT_AGENT_WORKER_DATABASE_TIMEOUT_MS = 2_000;

type EnvironmentLike = Record<string, string | undefined>;

function positiveInteger(
  raw: unknown,
  fallback: number,
  minimum: number,
  field: string,
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const normalized = typeof raw === "number" ? raw : String(raw).trim();
  const value = typeof normalized === "number"
    ? normalized
    : /^\d+$/.test(normalized)
      ? Number(normalized)
      : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${field} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function releaseNodeId(environment: EnvironmentLike): string | null {
  const value = String(
    environment.FANJIN_RELEASE_NODE_ID
      || environment.FANJIN_NODE_ID
      || "",
  ).trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError("FANJIN_RELEASE_NODE_ID format is invalid");
  }
  return value;
}

function expectedDedicatedNodeIds(environment: EnvironmentLike): string[] {
  const raw = String(environment.FANJIN_RELEASE_WORKER_TARGETS || "[]");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new TypeError("FANJIN_RELEASE_WORKER_TARGETS must be an array");
  const ids = parsed.map((entry) => String(entry?.nodeId || "").trim()).filter(Boolean);
  if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
    throw new TypeError("FANJIN_RELEASE_WORKER_TARGETS contains an invalid nodeId");
  }
  return ids;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("agent_worker_readiness_timeout")),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type AgentRuntimeWorkerReadinessReason =
  | "ready"
  | "invalid_configuration"
  | "database_unavailable"
  | "release_identity_unavailable"
  | "heartbeat_unavailable";

export interface AgentRuntimeWorkerReadinessInspection {
  ready: boolean;
  reason: AgentRuntimeWorkerReadinessReason;
  freshHeartbeatCount: number;
  matchingHeartbeatCount: number;
}

export interface ProbeAgentRuntimeWorkerReadinessOptions {
  environment?: NodeJS.ProcessEnv;
  now?: number;
  maxAgeMs?: number;
  futureSkewMs?: number;
  databaseTimeoutMs?: number;
}

/**
 * Proves that the Agent-specific Run poller is accepting work.
 *
 * A generic `background` heartbeat is deliberately insufficient: relay,
 * deletion, billing or other workers can remain healthy while the Agent
 * service was never started. In production the proof is also bound to the
 * exact API artifact (and, for dedicated topology, to a configured node).
 */
export async function probeAgentRuntimeWorkerReadiness(
  database: Knex,
  options: ProbeAgentRuntimeWorkerReadinessOptions = {},
): Promise<AgentRuntimeWorkerReadinessInspection> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now();
  try {
    const maxAgeMs = positiveInteger(
      options.maxAgeMs ?? environment[AGENT_RUNTIME_WORKER_HEARTBEAT_MAX_AGE_ENV],
      DEFAULT_AGENT_WORKER_HEARTBEAT_MAX_AGE_MS,
      1_000,
      AGENT_RUNTIME_WORKER_HEARTBEAT_MAX_AGE_ENV,
    );
    const heartbeatIntervalMs = positiveInteger(
      environment[AGENT_RUNTIME_WORKER_HEARTBEAT_INTERVAL_ENV],
      DEFAULT_AGENT_WORKER_HEARTBEAT_INTERVAL_MS,
      1_000,
      AGENT_RUNTIME_WORKER_HEARTBEAT_INTERVAL_ENV,
    );
    if (heartbeatIntervalMs > Math.floor(maxAgeMs / 2)) {
      throw new TypeError(
        `${AGENT_RUNTIME_WORKER_HEARTBEAT_MAX_AGE_ENV} must be at least twice ${AGENT_RUNTIME_WORKER_HEARTBEAT_INTERVAL_ENV}`,
      );
    }
    const databaseTimeoutMs = positiveInteger(
      options.databaseTimeoutMs,
      DEFAULT_AGENT_WORKER_DATABASE_TIMEOUT_MS,
      100,
      "agentWorkerDatabaseTimeoutMs",
    );
    const futureSkewMs = resolveWorkerHeartbeatFutureSkewMs(
      options.futureSkewMs
        ?? environment.FANJIN_WORKER_HEARTBEAT_FUTURE_SKEW_MS,
    );
    const rows = await withTimeout(
      database<any>("o_worker_heartbeat")
        .where({ role: AGENT_RUNTIME_WORKER_HEARTBEAT_ROLE })
        .where("heartbeatAt", ">=", now - maxAgeMs)
        .orderBy("heartbeatAt", "desc"),
      databaseTimeoutMs,
    );
    if (!Array.isArray(rows)) {
      return {
        ready: false,
        reason: "database_unavailable",
        freshHeartbeatCount: 0,
        matchingHeartbeatCount: 0,
      };
    }
    if (rows.some((row: any) => (
      !Number.isSafeInteger(Number(row.heartbeatAt))
      || Number(row.heartbeatAt) > now + futureSkewMs
    ))) {
      return {
        ready: false,
        reason: "heartbeat_unavailable",
        freshHeartbeatCount: rows.length,
        matchingHeartbeatCount: 0,
      };
    }

    const topology = String(
      environment.FANJIN_RELEASE_WORKER_TOPOLOGY || "",
    ).trim().toLowerCase();
    const production = isProductionRuntime(environment.NODE_ENV);
    const requireExactIdentity = production || topology === "dedicated";
    const release = getReleaseIdentity(environment);
    if (
      requireExactIdentity
      && (
        !release.artifactSha256
        || release.schemaVersion === null
        || !release.schemaCompatibility
      )
    ) {
      return {
        ready: false,
        reason: "release_identity_unavailable",
        freshHeartbeatCount: rows.length,
        matchingHeartbeatCount: 0,
      };
    }

    const expectedNodeIds = topology === "dedicated"
      ? expectedDedicatedNodeIds(environment)
      : [];
    if (
      topology === "dedicated"
      && (
        expectedNodeIds.length === 0
        || new Set(expectedNodeIds).size !== expectedNodeIds.length
        || rows.some((row: any) => (
          typeof row.nodeId !== "string"
          || !expectedNodeIds.includes(row.nodeId)
        ))
        || expectedNodeIds.some((nodeId) => (
          rows.filter((row: any) => row.nodeId === nodeId).length > 1
        ))
      )
    ) {
      return {
        ready: false,
        reason: "heartbeat_unavailable",
        freshHeartbeatCount: rows.length,
        matchingHeartbeatCount: 0,
      };
    }

    const matchingRows = rows.filter((row: any) => (
      (row.acceptingWork === true || Number(row.acceptingWork) === 1)
      && (
        topology !== "dedicated"
        || (
          typeof row.nodeId === "string"
          && expectedNodeIds.includes(row.nodeId)
        )
      )
      && (
        !requireExactIdentity
        || (
          row.artifactSha256 === release.artifactSha256
          && Number(row.schemaVersion) === release.schemaVersion
        )
      )
    ));
    return {
      ready: matchingRows.length > 0,
      reason: matchingRows.length > 0 ? "ready" : "heartbeat_unavailable",
      freshHeartbeatCount: rows.length,
      matchingHeartbeatCount: matchingRows.length,
    };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof TypeError
        || error instanceof SyntaxError
        ? "invalid_configuration"
        : "database_unavailable",
      freshHeartbeatCount: 0,
      matchingHeartbeatCount: 0,
    };
  }
}

export interface AgentRuntimeWorkerReadinessReporter {
  start(): void;
  markReady(): Promise<void>;
  markUnready(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateAgentRuntimeWorkerReadinessReporterOptions {
  database: Knex;
  workerId: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Publishes a dedicated Agent heartbeat only after the service completed a
 * real queue/recovery poll. The periodic pulse then proves that the exact
 * Agent service event loop and database connection remain alive while a model
 * call is in flight.
 */
export function createAgentRuntimeWorkerReadinessReporter(
  options: CreateAgentRuntimeWorkerReadinessReporterOptions,
): AgentRuntimeWorkerReadinessReporter {
  const environment = options.environment ?? process.env;
  const workerId = String(options.workerId || "").trim();
  if (!workerId) throw new TypeError("Agent Worker workerId 不能为空");
  const intervalMs = positiveInteger(
    environment[AGENT_RUNTIME_WORKER_HEARTBEAT_INTERVAL_ENV],
    DEFAULT_AGENT_WORKER_HEARTBEAT_INTERVAL_MS,
    1_000,
    AGENT_RUNTIME_WORKER_HEARTBEAT_INTERVAL_ENV,
  );
  const maxAgeMs = positiveInteger(
    environment[AGENT_RUNTIME_WORKER_HEARTBEAT_MAX_AGE_ENV],
    DEFAULT_AGENT_WORKER_HEARTBEAT_MAX_AGE_MS,
    1_000,
    AGENT_RUNTIME_WORKER_HEARTBEAT_MAX_AGE_ENV,
  );
  if (intervalMs > Math.floor(maxAgeMs / 2)) {
    throw new TypeError(
      `${AGENT_RUNTIME_WORKER_HEARTBEAT_MAX_AGE_ENV} must be at least twice ${AGENT_RUNTIME_WORKER_HEARTBEAT_INTERVAL_ENV}`,
    );
  }
  const nodeId = releaseNodeId(environment);
  const release = getReleaseIdentity(environment);
  const now = options.now ?? Date.now;
  const id = `${AGENT_RUNTIME_WORKER_HEARTBEAT_ROLE}:${workerId}`;
  const startedAt = now();
  let started = false;
  let ready = false;
  let timer: NodeJS.Timeout | null = null;
  let pending: Promise<void> | null = null;
  let lastSignalAt: number | null = null;
  let lastPersistedSignalAt: number | null = null;

  const write = async (signalAt: number): Promise<void> => {
    const writeAt = now();
    const patch = {
      role: AGENT_RUNTIME_WORKER_HEARTBEAT_ROLE,
      hostname: os.hostname(),
      processId: process.pid,
      nodeId,
      incarnationId: workerId,
      releaseId: release.releaseId,
      artifactSha256: release.artifactSha256,
      schemaVersion: release.schemaVersion,
      acceptingWork: 1,
      activeTaskCount: 0,
      drainOperationId: null,
      controlRevision: null,
      // Persist the last successful Agent queue/lease operation, not the
      // timer's wall clock. If the poller hangs, repeated timer callbacks
      // cannot keep an old proof fresh indefinitely.
      heartbeatAt: signalAt,
      updatedAt: writeAt,
    };
    const updated = await options.database<any>("o_worker_heartbeat")
      .where({ id })
      .update(patch);
    if (Number(updated || 0) > 0) return;
    try {
      await options.database<any>("o_worker_heartbeat").insert({
        id,
        ...patch,
        startedAt,
        createdAt: startedAt,
      });
    } catch (error) {
      const retried = await options.database<any>("o_worker_heartbeat")
        .where({ id })
        .update(patch);
      if (Number(retried || 0) === 0) throw error;
    }
  };

  const pulse = (): Promise<void> => {
    if (!started || !ready || lastSignalAt === null) return Promise.resolve();
    if (pending) return pending;
    const signalAt = lastSignalAt;
    if (lastPersistedSignalAt === signalAt) return Promise.resolve();
    let tracked: Promise<void>;
    tracked = write(signalAt)
      .then(() => {
        lastPersistedSignalAt = signalAt;
      })
      .finally(() => {
        if (pending === tracked) pending = null;
      });
    pending = tracked;
    return tracked;
  };

  const remove = async (): Promise<void> => {
    if (pending) await pending.catch(() => undefined);
    await options.database<any>("o_worker_heartbeat")
      .where({ id })
      .delete();
  };

  return {
    start() {
      if (started) return;
      started = true;
      timer = setInterval(() => {
        void pulse().catch(() => undefined);
      }, intervalMs);
      timer.unref?.();
    },
    async markReady() {
      if (!started) return;
      ready = true;
      lastSignalAt = now();
      // First proof (or a failed first write) is immediate. Later successful
      // polls only update the in-memory signal; the bounded timer coalesces
      // them into one durable write per interval.
      if (lastPersistedSignalAt === null) await pulse();
    },
    async markUnready() {
      ready = false;
      lastSignalAt = null;
      await remove();
      lastPersistedSignalAt = null;
    },
    async stop() {
      started = false;
      ready = false;
      lastSignalAt = null;
      if (timer) clearInterval(timer);
      timer = null;
      await remove();
      lastPersistedSignalAt = null;
    },
  };
}
