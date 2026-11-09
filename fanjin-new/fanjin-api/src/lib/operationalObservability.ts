import type { Knex } from "knex";

import {
  inspectAgentSurfaceAvailability,
  type AgentSurfaceAvailability,
} from "@/agent-runtime/surfaceAvailability";
import {
  scanAgentApprovalBillingReconciliation,
  type AgentBillingReconcileReport,
} from "@/agent-runtime/agentBillingReconciliation";
import {
  buildWorkbenchModelCatalog,
  listWorkbenchRouteModels,
} from "@/lib/workbenchModelCatalog";

export const OPERATIONAL_OBSERVABILITY_FORMAT =
  "fanjin-operational-observability/v1" as const;

export const OPERATIONAL_ENDPOINT_TYPES = Object.freeze([
  "text",
  "image_generation",
  "video_generation",
] as const);
export const OPERATIONAL_QUEUE_NAMES = Object.freeze([
  "agent_run",
  "relay_task",
  "billing_reconciliation",
] as const);
export const OPERATIONAL_BILLING_RECONCILIATION_CATEGORIES = Object.freeze([
  "overcharge",
  "missing_billing_flow",
  "missing_usage",
  "open_reservation",
  "pending_reconcile",
] as const);

export type OperationalEndpointType = typeof OPERATIONAL_ENDPOINT_TYPES[number];
export type OperationalQueueName = typeof OPERATIONAL_QUEUE_NAMES[number];
export type OperationalBillingReconciliationCategory =
  typeof OPERATIONAL_BILLING_RECONCILIATION_CATEGORIES[number];

export interface OperationalQueueSnapshot {
  backlog: number;
  oldestAgeSeconds: number;
}

export interface OperationalDatabaseFacts {
  agentWorker: {
    freshCount: number;
    latestHeartbeatAgeSeconds: number;
    stale: boolean;
  };
  queues: Record<OperationalQueueName, OperationalQueueSnapshot>;
  reservations: {
    open: number;
    aged: number;
    oldestAgeSeconds: number;
  };
}

export interface OperationalCatalogFacts {
  canSubmit: Record<OperationalEndpointType, number>;
  degraded: Record<OperationalEndpointType, number>;
}

export interface OperationalBillingReconciliationSnapshot {
  lastRunAt: number;
  lastSuccessAt: number;
  succeeded: boolean;
  failuresTotal: number;
  findings: Record<OperationalBillingReconciliationCategory, number>;
  oldestPendingAgeSeconds: number;
}

export interface OperationalObservabilitySnapshot {
  format: typeof OPERATIONAL_OBSERVABILITY_FORMAT;
  collection: {
    lastRunAt: number;
    lastSuccessAt: number;
    succeeded: boolean;
    failuresTotal: number;
  };
  synthetic: {
    /** The check calls read models only; it never reserves or spends GU. */
    zeroGu: true;
    lastRunAt: number;
    lastSuccessAt: number;
    succeeded: boolean;
    failuresTotal: number;
    surfaceAvailable: boolean;
  };
  catalog: OperationalCatalogFacts;
  database: OperationalDatabaseFacts;
  billingReconciliation: OperationalBillingReconciliationSnapshot;
}

export interface OperationalObservabilityDependencies {
  inspectSurface(input: Readonly<{
    database: Knex;
    workspaceId: string;
  }>): Promise<AgentSurfaceAvailability>;
  inspectCatalog(input: Readonly<{
    database: Knex;
    workspaceId: string;
  }>): Promise<OperationalCatalogFacts>;
  inspectDatabase(input: Readonly<{
    database: Knex;
    now: number;
    workerMaxAgeMs: number;
    reservationMaxAgeMs: number;
  }>): Promise<OperationalDatabaseFacts>;
  inspectBillingReconciliation(input: Readonly<{
    database: Knex;
    now: number;
  }>): Promise<AgentBillingReconcileReport>;
}

export interface OperationalObservabilityOptions {
  database: Knex;
  workspaceId: string;
  now?: () => number;
  intervalMs?: number;
  workerMaxAgeMs?: number;
  reservationMaxAgeMs?: number;
  billingScanIntervalMs?: number;
  dependencies?: Partial<OperationalObservabilityDependencies>;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_WORKER_MAX_AGE_MS = 45_000;
const DEFAULT_RESERVATION_MAX_AGE_MS = 60 * 60_000;
const DEFAULT_BILLING_SCAN_INTERVAL_MS = 15 * 60_000;

function emptyEndpointCounts(): Record<OperationalEndpointType, number> {
  return {
    text: 0,
    image_generation: 0,
    video_generation: 0,
  };
}

function emptyQueues(): Record<OperationalQueueName, OperationalQueueSnapshot> {
  return {
    agent_run: { backlog: 0, oldestAgeSeconds: 0 },
    relay_task: { backlog: 0, oldestAgeSeconds: 0 },
    billing_reconciliation: { backlog: 0, oldestAgeSeconds: 0 },
  };
}

function emptyBillingFindings(): Record<OperationalBillingReconciliationCategory, number> {
  return {
    overcharge: 0,
    missing_billing_flow: 0,
    missing_usage: 0,
    open_reservation: 0,
    pending_reconcile: 0,
  };
}

function emptySnapshot(): OperationalObservabilitySnapshot {
  return {
    format: OPERATIONAL_OBSERVABILITY_FORMAT,
    collection: {
      lastRunAt: 0,
      lastSuccessAt: 0,
      succeeded: false,
      failuresTotal: 0,
    },
    synthetic: {
      zeroGu: true,
      lastRunAt: 0,
      lastSuccessAt: 0,
      succeeded: false,
      failuresTotal: 0,
      surfaceAvailable: false,
    },
    catalog: {
      canSubmit: emptyEndpointCounts(),
      degraded: emptyEndpointCounts(),
    },
    database: {
      agentWorker: {
        freshCount: 0,
        latestHeartbeatAgeSeconds: 0,
        stale: true,
      },
      queues: emptyQueues(),
      reservations: {
        open: 0,
        aged: 0,
        oldestAgeSeconds: 0,
      },
    },
    billingReconciliation: {
      lastRunAt: 0,
      lastSuccessAt: 0,
      succeeded: false,
      failuresTotal: 0,
      findings: emptyBillingFindings(),
      oldestPendingAgeSeconds: 0,
    },
  };
}

let operationalSnapshot = emptySnapshot();
let collectorTimer: NodeJS.Timeout | null = null;
let collectorInFlight: Promise<OperationalObservabilitySnapshot> | null = null;

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function ageSeconds(now: number, observedAt: unknown): number {
  const observed = timestamp(observedAt);
  return observed > 0 ? Math.max(0, (now - observed) / 1000) : 0;
}

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

async function aggregateQueue(
  query: Knex.QueryBuilder,
  timestampColumn: string,
  now: number,
): Promise<OperationalQueueSnapshot> {
  const row = await query
    .clone()
    .count({ count: "*" })
    .min({ oldestAt: timestampColumn })
    .first();
  const aggregate = (row ?? {}) as Record<string, unknown>;
  return {
    backlog: nonNegativeInteger(aggregate.count),
    oldestAgeSeconds: ageSeconds(now, aggregate.oldestAt),
  };
}

export async function inspectOperationalDatabaseFacts(input: Readonly<{
  database: Knex;
  now: number;
  workerMaxAgeMs: number;
  reservationMaxAgeMs: number;
}>): Promise<OperationalDatabaseFacts> {
  const { database, now } = input;
  const freshWorkerQuery = database("o_worker_heartbeat")
    .where({ role: "agent-runtime", acceptingWork: 1 })
    .andWhere("heartbeatAt", ">=", now - input.workerMaxAgeMs);
  const latestWorkerQuery = database("o_worker_heartbeat")
    .where({ role: "agent-runtime" })
    .max({ latestHeartbeatAt: "heartbeatAt" })
    .first();
  const openReservationQuery = database("o_billing_ledger")
    .where({ type: "freeze" })
    .andWhere("remainingMicros", ">", 0);

  const [
    freshWorkerRow,
    latestWorkerRow,
    agentRun,
    relayTask,
    billingReconciliation,
    openReservationRow,
    agedReservationRow,
  ] = await Promise.all([
    freshWorkerQuery.count({ count: "*" }).first(),
    latestWorkerQuery,
    aggregateQueue(
      database("o_agent_run").where({ status: "queued" }),
      "createdAt",
      now,
    ),
    aggregateQueue(
      database("o_relay_task").where({ status: "queued" }),
      "createTime",
      now,
    ),
    aggregateQueue(
      database("o_billing_reconcile_job").where({ status: "pending" }),
      "createTime",
      now,
    ),
    openReservationQuery
      .clone()
      .count({ count: "*" })
      .min({ oldestAt: "createdAt" })
      .first(),
    openReservationQuery
      .clone()
      .andWhere("createdAt", "<", now - input.reservationMaxAgeMs)
      .count({ count: "*" })
      .first(),
  ]);

  const freshCount = nonNegativeInteger(freshWorkerRow?.count);
  return {
    agentWorker: {
      freshCount,
      latestHeartbeatAgeSeconds: ageSeconds(now, latestWorkerRow?.latestHeartbeatAt),
      stale: freshCount === 0,
    },
    queues: {
      agent_run: agentRun,
      relay_task: relayTask,
      billing_reconciliation: billingReconciliation,
    },
    reservations: {
      open: nonNegativeInteger(openReservationRow?.count),
      aged: nonNegativeInteger(agedReservationRow?.count),
      oldestAgeSeconds: ageSeconds(now, openReservationRow?.oldestAt),
    },
  };
}

export async function inspectOperationalCatalogFacts(input: Readonly<{
  database: Knex;
  workspaceId: string;
}>): Promise<OperationalCatalogFacts> {
  const [generation, textRoutes] = await Promise.all([
    buildWorkbenchModelCatalog(input.workspaceId, input.database),
    listWorkbenchRouteModels({
      workspaceId: input.workspaceId,
      endpointTypes: ["text"],
      database: input.database,
    }),
  ]);
  const groups = {
    text: textRoutes,
    image_generation: generation.imageModels,
    video_generation: generation.videoModels,
  };
  const canSubmit = emptyEndpointCounts();
  const degraded = emptyEndpointCounts();
  for (const endpointType of OPERATIONAL_ENDPOINT_TYPES) {
    canSubmit[endpointType] = groups[endpointType]
      .filter((model) => model.canSubmit === true).length;
    degraded[endpointType] = groups[endpointType]
      .filter((model) => model.canSubmit !== true).length;
  }
  return { canSubmit, degraded };
}

const DEFAULT_DEPENDENCIES: OperationalObservabilityDependencies = {
  inspectSurface: ({ database, workspaceId }) => inspectAgentSurfaceAvailability({
    database,
    workspaceId,
  }),
  inspectCatalog: inspectOperationalCatalogFacts,
  inspectDatabase: inspectOperationalDatabaseFacts,
  inspectBillingReconciliation: ({ database, now }) =>
    scanAgentApprovalBillingReconciliation({ database, now, limit: 200 }),
};

type BillingScanAttempt =
  | { attempted: false }
  | { attempted: true; report: AgentBillingReconcileReport | null };

function billingSnapshotFromAttempt(
  previous: OperationalBillingReconciliationSnapshot,
  now: number,
  attempt: BillingScanAttempt,
): OperationalBillingReconciliationSnapshot {
  if (!attempt.attempted) return previous;
  if (!attempt.report) {
    return {
      ...previous,
      lastRunAt: now,
      succeeded: false,
      failuresTotal: previous.failuresTotal + 1,
    };
  }
  const { facts } = attempt.report;
  return {
    lastRunAt: attempt.report.generatedAt,
    lastSuccessAt: attempt.report.generatedAt,
    succeeded: true,
    failuresTotal: previous.failuresTotal,
    findings: {
      overcharge: facts.overcharge,
      missing_billing_flow: facts.missingBillingFlow,
      missing_usage: facts.missingUsage,
      open_reservation: facts.openReservation,
      pending_reconcile: facts.pendingReconcile,
    },
    oldestPendingAgeSeconds: facts.oldestPendingReconcileAgeMs / 1000,
  };
}

/**
 * Runs the same read-only surface truth source used after authenticated Agent
 * entry, plus bounded aggregate DB reads. No dependency in this contract can
 * submit generation, create a task, reserve GU, or mutate billing state.
 */
export async function runOperationalObservabilityCheck(
  options: OperationalObservabilityOptions,
): Promise<OperationalObservabilitySnapshot> {
  const now = (options.now ?? Date.now)();
  const workspaceId = String(options.workspaceId || "").trim();
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const previous = operationalSnapshot;
  if (!workspaceId) {
    operationalSnapshot = {
      ...previous,
      collection: {
        ...previous.collection,
        lastRunAt: now,
        succeeded: false,
        failuresTotal: previous.collection.failuresTotal + 1,
      },
      synthetic: {
        ...previous.synthetic,
        lastRunAt: now,
        succeeded: false,
        surfaceAvailable: false,
        failuresTotal: previous.synthetic.failuresTotal + 1,
      },
    };
    return getOperationalObservabilitySnapshot();
  }

  try {
    const billingScanIntervalMs = positiveInteger(
      options.billingScanIntervalMs,
      DEFAULT_BILLING_SCAN_INTERVAL_MS,
      60_000,
    );
    const billingDue = !previous.billingReconciliation.succeeded
      || previous.billingReconciliation.lastRunAt === 0
      || now - previous.billingReconciliation.lastRunAt >= billingScanIntervalMs;
    const billingAttemptPromise: Promise<BillingScanAttempt> = billingDue
      ? dependencies.inspectBillingReconciliation({ database: options.database, now })
        .then((report) => ({ attempted: true as const, report }))
        .catch(() => ({ attempted: true as const, report: null }))
      : Promise.resolve({ attempted: false as const });
    const [surface, catalog, databaseFacts, billingAttempt] = await Promise.all([
      dependencies.inspectSurface({ database: options.database, workspaceId }),
      dependencies.inspectCatalog({ database: options.database, workspaceId }),
      dependencies.inspectDatabase({
        database: options.database,
        now,
        workerMaxAgeMs: positiveInteger(
          options.workerMaxAgeMs,
          DEFAULT_WORKER_MAX_AGE_MS,
          1_000,
        ),
        reservationMaxAgeMs: positiveInteger(
          options.reservationMaxAgeMs,
          DEFAULT_RESERVATION_MAX_AGE_MS,
          60_000,
        ),
      }),
      billingAttemptPromise,
    ]);
    const succeeded = surface.available === true;
    operationalSnapshot = {
      format: OPERATIONAL_OBSERVABILITY_FORMAT,
      collection: {
        lastRunAt: now,
        lastSuccessAt: now,
        succeeded: true,
        failuresTotal: previous.collection.failuresTotal,
      },
      synthetic: {
        zeroGu: true,
        lastRunAt: now,
        lastSuccessAt: succeeded ? now : previous.synthetic.lastSuccessAt,
        succeeded,
        failuresTotal: previous.synthetic.failuresTotal + (succeeded ? 0 : 1),
        surfaceAvailable: surface.available,
      },
      catalog,
      database: databaseFacts,
      billingReconciliation: billingSnapshotFromAttempt(
        previous.billingReconciliation,
        now,
        billingAttempt,
      ),
    };
  } catch {
    operationalSnapshot = {
      ...previous,
      collection: {
        ...previous.collection,
        lastRunAt: now,
        succeeded: false,
        failuresTotal: previous.collection.failuresTotal + 1,
      },
      synthetic: {
        ...previous.synthetic,
        lastRunAt: now,
        succeeded: false,
        surfaceAvailable: false,
        failuresTotal: previous.synthetic.failuresTotal + 1,
      },
    };
  }
  return getOperationalObservabilitySnapshot();
}

export function getOperationalObservabilitySnapshot(): OperationalObservabilitySnapshot {
  return structuredClone(operationalSnapshot);
}

export function resetOperationalObservabilitySnapshot(): void {
  operationalSnapshot = emptySnapshot();
}

export async function startOperationalObservabilityCollector(
  options: OperationalObservabilityOptions,
): Promise<OperationalObservabilitySnapshot> {
  stopOperationalObservabilityCollector();
  const intervalMs = positiveInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 15_000);
  const run = () => {
    if (collectorInFlight) return collectorInFlight;
    collectorInFlight = runOperationalObservabilityCheck(options)
      .finally(() => {
        collectorInFlight = null;
      });
    return collectorInFlight;
  };
  const initial = await run();
  collectorTimer = setInterval(() => void run(), intervalMs);
  collectorTimer.unref?.();
  return initial;
}

export function stopOperationalObservabilityCollector(): void {
  if (collectorTimer) clearInterval(collectorTimer);
  collectorTimer = null;
}

export async function drainOperationalObservabilityCollector(): Promise<void> {
  stopOperationalObservabilityCollector();
  await collectorInFlight;
}
