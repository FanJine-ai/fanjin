import crypto from "node:crypto";

import type {
  ReleaseMaintenanceExecutionResult,
  ReleaseMaintenanceProgressRecord,
  ReleaseMaintenanceProgressRecorder as OrchestratorProgressRecorder,
} from "@/lib/releaseMaintenanceActivationOrchestrator";
import {
  advanceReleaseMaintenanceExecution,
  completeReleaseMaintenanceExecution,
  failReleaseMaintenanceExecution,
  releaseMaintenanceExecutionFailureCodes,
  renewReleaseMaintenanceExecutionLease,
  RELEASE_MAINTENANCE_EXECUTOR_KIND,
  RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2,
  type ReleaseMaintenanceExecutionClaim,
  type ReleaseMaintenanceExecutionDependencies,
  type ReleaseMaintenanceExecutionFailureCode,
  type ReleaseMaintenanceExecutionPhase,
  type ReleaseMaintenanceExecutionState,
  type ReleaseMaintenanceExecutionTransition,
  type ReleaseMaintenanceTrafficMode,
} from "@/lib/releaseMaintenanceActivationExecution";

export const RELEASE_MAINTENANCE_PROGRESS_FORMAT =
  "fanjin-release-maintenance-progress/v1" as const;

export type ReleaseMaintenanceDurableProgressEvent =
  | ReleaseMaintenanceProgressRecord["event"]
  | "listener-baseline-verified"
  | "listeners-disabled"
  | "homogeneous-isolated-ready"
  | "private-validation-passed"
  | "traffic-restore-attempted"
  | "listener-enable-attempted"
  | "listeners-enabled"
  | "canary-planned"
  | "canary-opened"
  | "canary-observation-passed"
  | "canary-contained"
  | "canary-contained-after-failure";

export type ReleaseMaintenanceDurableProgressRecord = Omit<
  ReleaseMaintenanceProgressRecord,
  "event"
> & {
  event: ReleaseMaintenanceDurableProgressEvent;
};

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/u;

const orchestratorPhases = [
  "maintenance-draining",
  "maintenance-quiesced",
  "maintenance-checkpoint",
  "maintenance-migrating",
  "maintenance-backfill",
  "maintenance-api-activation",
  "maintenance-worker-activation",
  "maintenance-worker-resume",
  "maintenance-traffic-restore",
  "maintenance-public-smoke",
] as const;

type OrchestratorPhase = (typeof orchestratorPhases)[number];

const exactOrchestratorFailureMap: Readonly<Record<string, ReleaseMaintenanceExecutionFailureCode>> = {
  RELEASE_MAINTENANCE_API_BASELINE_INVALID: "MAINTENANCE_API_DRAIN_FAILED",
  RELEASE_MAINTENANCE_API_DRAIN_LOST: "MAINTENANCE_API_DRAIN_FAILED",
  RELEASE_MAINTENANCE_API_DRAIN_TIMEOUT: "MAINTENANCE_API_DRAIN_FAILED",
  RELEASE_MAINTENANCE_WORKER_BASELINE_INVALID: "MAINTENANCE_WORKER_DRAIN_FAILED",
  RELEASE_MAINTENANCE_WORKER_NOT_DRAINED: "MAINTENANCE_WORKER_DRAIN_FAILED",
  RELEASE_MAINTENANCE_DATABASE_IDENTITY_MISMATCH: "MAINTENANCE_BACKUP_FAILED",
  RELEASE_MAINTENANCE_SCHEMA_TERMINAL_MISMATCH: "MAINTENANCE_SCHEMA_MIGRATION_FAILED",
  RELEASE_MAINTENANCE_BACKFILL_RECEIPT_MISMATCH: "MAINTENANCE_BACKFILL_FAILED",
  RELEASE_MAINTENANCE_API_READINESS_MISMATCH: "MAINTENANCE_API_ACTIVATION_FAILED",
  RELEASE_MAINTENANCE_WORKER_READINESS_MISMATCH: "MAINTENANCE_WORKER_ACTIVATION_FAILED",
  RELEASE_MAINTENANCE_HOMOGENEOUS_FLEET_MISMATCH: "MAINTENANCE_WORKER_ACTIVATION_FAILED",
  RELEASE_MAINTENANCE_WORKER_RESUME_MISMATCH: "MAINTENANCE_WORKER_RESUME_FAILED",
  RELEASE_MAINTENANCE_CANARY_PLAN_MISMATCH: "MAINTENANCE_TRAFFIC_RESTORE_FAILED",
  RELEASE_MAINTENANCE_CANARY_RECEIPT_MISMATCH: "MAINTENANCE_TRAFFIC_RESTORE_FAILED",
  RELEASE_MAINTENANCE_CANARY_OBSERVATION_FAILED: "MAINTENANCE_TRAFFIC_RESTORE_FAILED",
  RELEASE_MAINTENANCE_CANARY_CONTAINMENT_FAILED: "MAINTENANCE_TRAFFIC_RESTORE_FAILED",
  RELEASE_MAINTENANCE_CONTAINMENT_FAILED: "MAINTENANCE_TRAFFIC_RESTORE_FAILED",
  RELEASE_MAINTENANCE_API_CONTAINMENT_FAILED: "MAINTENANCE_API_DRAIN_FAILED",
  RELEASE_MAINTENANCE_WORKER_CONTAINMENT_FAILED: "MAINTENANCE_WORKER_DRAIN_FAILED",
  RELEASE_MAINTENANCE_PUBLIC_SMOKE_FAILED: "MAINTENANCE_PUBLIC_SMOKE_FAILED",
  RELEASE_MAINTENANCE_LISTENER_BARRIER_FAILED: "MAINTENANCE_LISTENER_BARRIER_FAILED",
  CLB_LISTENER_BARRIER_UNSAFE: "MAINTENANCE_LISTENER_BARRIER_FAILED",
  CLB_LISTENER_BARRIER_TIMEOUT: "MAINTENANCE_LISTENER_BARRIER_FAILED",
};

export class ReleaseMaintenanceProgressRecorderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseMaintenanceProgressRecorderError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseMaintenanceProgressRecorderError(code, message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RELEASE_MAINTENANCE_PROGRESS_INPUT_INVALID", `${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail("RELEASE_MAINTENANCE_PROGRESS_INPUT_INVALID", `${label} fields are not exact`);
  }
  return object;
}

function exactSha(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA256_RE.test(normalized)) {
    fail("RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID", `${label} must be sha256`);
  }
  return normalized;
}

function exactId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    fail("RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail("RELEASE_MAINTENANCE_PROGRESS_INPUT_INVALID", `${label} must be a positive integer`);
  }
  return parsed;
}

function sameExactSet(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return (
    left.length === right.length
    && new Set(left).size === left.length
    && left.every((value, index) => value === right[index])
  );
}

function assertNoEvidence(record: ReleaseMaintenanceDurableProgressRecord): void {
  if (record.evidence !== undefined) {
    fail(
      "RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID",
      `${record.event} must not carry evidence`,
    );
  }
}

function assertNoTarget(record: ReleaseMaintenanceDurableProgressRecord): void {
  if (record.targetKey !== undefined) {
    fail(
      "RELEASE_MAINTENANCE_PROGRESS_TARGET_INVALID",
      `${record.event} must not carry targetKey`,
    );
  }
}

function assertRecordEnvelope(
  record: ReleaseMaintenanceDurableProgressRecord,
  expectedKeys: readonly string[],
  expectedPhase: OrchestratorPhase,
): void {
  exactKeys(record, expectedKeys, "progress record");
  if (record.phase !== expectedPhase) {
    fail(
      "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
      `${record.event} is not valid in ${String(record.phase)}`,
    );
  }
}

function phaseFallbackFailureCode(
  orchestratorPhase: unknown,
  ledgerPhase: ReleaseMaintenanceExecutionPhase,
): ReleaseMaintenanceExecutionFailureCode {
  switch (orchestratorPhase) {
    case "maintenance-draining":
      return ledgerPhase === "maintenance-api-drained"
        ? "MAINTENANCE_WORKER_DRAIN_FAILED"
        : "MAINTENANCE_API_DRAIN_FAILED";
    case "maintenance-checkpoint":
      return ledgerPhase === "maintenance-writers-quiesced"
        ? "MAINTENANCE_BACKUP_FAILED"
        : "MAINTENANCE_WRITER_QUIESCENCE_FAILED";
    case "maintenance-migrating": return "MAINTENANCE_SCHEMA_MIGRATION_FAILED";
    case "maintenance-backfill": return "MAINTENANCE_BACKFILL_FAILED";
    case "maintenance-api-activation": return "MAINTENANCE_API_ACTIVATION_FAILED";
    case "maintenance-worker-activation": return "MAINTENANCE_WORKER_ACTIVATION_FAILED";
    case "maintenance-worker-resume": return "MAINTENANCE_WORKER_RESUME_FAILED";
    case "maintenance-traffic-restore": return "MAINTENANCE_TRAFFIC_RESTORE_FAILED";
    case "maintenance-public-smoke": return "MAINTENANCE_PUBLIC_SMOKE_FAILED";
    default: return "MAINTENANCE_INTERNAL_FAILED";
  }
}

function orchestratorPhaseMatchesLedger(
  orchestratorPhase: unknown,
  ledgerPhase: ReleaseMaintenanceExecutionPhase,
): boolean {
  const allowed: Partial<Record<OrchestratorPhase, readonly ReleaseMaintenanceExecutionPhase[]>> = {
    "maintenance-draining": [
      "maintenance-draining",
      "maintenance-listener-baseline-verifying",
      "maintenance-listener-baseline-verified",
      "maintenance-listeners-disabled",
      "maintenance-api-drained",
      "maintenance-workers-drained",
    ],
    "maintenance-quiesced": ["maintenance-workers-drained", "maintenance-nodes-quiesced"],
    "maintenance-checkpoint": [
      "maintenance-nodes-quiesced",
      "maintenance-writers-quiesced",
      "maintenance-backup-checkpointed",
    ],
    "maintenance-migrating": [
      "maintenance-backup-checkpointed",
      "maintenance-schema-migrating",
      "maintenance-schema-migrated",
    ],
    "maintenance-backfill": [
      "maintenance-schema-migrated",
      "maintenance-backfills-completed",
    ],
    "maintenance-api-activation": [
      "maintenance-backfills-completed",
      "maintenance-api-target-active",
    ],
    "maintenance-worker-activation": [
      "maintenance-api-target-active",
      "maintenance-worker-target-active",
      "maintenance-homogeneous-isolated-ready",
    ],
    "maintenance-worker-resume": [
      "maintenance-worker-target-active",
      "maintenance-homogeneous-isolated-ready",
      "maintenance-workers-resumed",
    ],
    "maintenance-traffic-restore": [
      "maintenance-workers-resumed",
      "maintenance-private-validation-passed",
      "maintenance-traffic-restore-attempted",
      "maintenance-canary-planned",
      "maintenance-canary-opened",
      "maintenance-canary-observation-passed",
      "maintenance-canary-contained",
      "maintenance-traffic-restored",
      "maintenance-listener-enable-attempted",
      "maintenance-listeners-enabled",
    ],
    "maintenance-public-smoke": [
      "maintenance-traffic-restored",
      "maintenance-listeners-enabled",
      "maintenance-public-smoke-passed",
    ],
  };
  return typeof orchestratorPhase === "string"
    && (allowed[orchestratorPhase as OrchestratorPhase] ?? []).includes(ledgerPhase);
}

/**
 * Converts public orchestrator errors to the fixed, non-sensitive terminal
 * failure vocabulary accepted by the durable execution ledger.
 */
export function mapReleaseMaintenanceOrchestratorFailureCode(input: {
  code: unknown;
  orchestratorPhase: unknown;
  ledgerPhase: ReleaseMaintenanceExecutionPhase;
}): ReleaseMaintenanceExecutionFailureCode {
  const code = typeof input.code === "string" ? input.code : "";
  if (releaseMaintenanceExecutionFailureCodes.includes(code as ReleaseMaintenanceExecutionFailureCode)) {
    return code as ReleaseMaintenanceExecutionFailureCode;
  }
  return exactOrchestratorFailureMap[code]
    ?? phaseFallbackFailureCode(input.orchestratorPhase, input.ledgerPhase);
}

export interface ReleaseMaintenanceProgressRecorderInput {
  initialState: ReleaseMaintenanceExecutionState;
  dependencies: ReleaseMaintenanceExecutionDependencies;
}

export interface ReleaseMaintenanceProgressLease {
  revision: number;
  fencingToken: number;
  leaseExpiresAt: number;
}

interface WriterEvidence {
  writerQuiescenceProofSha256: string;
  writerQuiescenceProofContentSha256: string;
  databaseIdentitySha256: string;
}

/**
 * Narrow adapter between node-level maintenance orchestration events and the
 * aggregate, CAS-protected execution ledger. This object is intentionally
 * single-owner and non-resumable: every ledger mutation is serialized through
 * one promise queue and fenced by the current revision/token pair.
 */
export class ReleaseMaintenanceProgressRecorder implements OrchestratorProgressRecorder {
  private readonly dependencies: ReleaseMaintenanceExecutionDependencies;
  private readonly deploymentId: string;
  private readonly workerId: string;
  private readonly apiTargetKeys: string[];
  private readonly workerTargetKeys: string[];
  private readonly allTargetKeys: string[];
  private readonly originalApiWeights: Map<string, number>;
  private readonly targetArtifactSha256: string;
  private readonly migrationRunId: string;
  private readonly trafficMode: ReleaseMaintenanceTrafficMode;

  private revision: number;
  private fencingToken: number;
  private leaseExpiresAt: number;
  private ledgerPhase: ReleaseMaintenanceExecutionPhase;
  private tail: Promise<void> = Promise.resolve();
  private terminal = false;

  private trafficBaselineRecorded = false;
  private listenerBaselineVerified = false;
  private listenerBaselineEvidenceSha256: string | null = null;
  private listenersDisabled = false;
  private listenerDisableEvidenceSha256: string | null = null;
  private trafficDrained = false;
  private readonly apiDrained = new Set<string>();
  private readonly workersDrained = new Set<string>();
  private readonly nodesQuiesced = new Set<string>();
  private writerEvidence: WriterEvidence | null = null;
  private backupCheckpointEvidenceSha256: string | null = null;
  private migrationAttempted = false;
  private migrationCompleted = false;
  private maintenanceBackfillReceiptSha256: string | null = null;
  private readonly apiActivationAttempted = new Set<string>();
  private readonly apiActivated = new Set<string>();
  private readonly workerActivationAttempted = new Set<string>();
  private readonly workerActivated = new Set<string>();
  private readonly workerIsolationVerified = new Set<string>();
  private homogeneousIsolatedReady = false;
  private readonly workersResumed = new Set<string>();
  private canaryOperationId: string | null = null;
  private canaryPlanSha256: string | null = null;
  private canaryOpenedReceiptSha256: string | null = null;
  private canaryObservationReceiptSha256: string | null = null;
  private canaryContainmentReceiptSha256: string | null = null;
  private privateValidationReceiptSha256: string | null = null;
  private privateValidationEvidenceManifestSha256: string | null = null;
  private restoreAttemptEvidenceSha256: string | null = null;
  private trafficRestored = false;
  private listenerEnableAttempted = false;
  private listenerEnableAttemptEvidenceSha256: string | null = null;
  private listenersEnabled = false;
  private listenerEnableEvidenceSha256: string | null = null;
  private publicSmokePassed = false;

  constructor(input: ReleaseMaintenanceProgressRecorderInput) {
    exactKeys(input, ["initialState", "dependencies"], "recorder input");
    const state = input.initialState;
    if (
      !state
      || state.status !== "running"
      || !(
        state.phase === "maintenance-draining"
        || state.phase === "maintenance-listener-baseline-verifying"
      )
      || state.checkpoint.phase !== state.phase
      || state.checkpoint.status !== "running"
      || state.checkpoint.executorKind !== RELEASE_MAINTENANCE_EXECUTOR_KIND
      || !state.workerId
      || state.workerId !== state.checkpoint.workerId
      || state.activeScope == null
    ) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_INITIAL_STATE_INVALID",
        "recorder requires a fresh maintenance execution claim",
      );
    }
    this.deploymentId = exactId(state.deploymentId, "deploymentId");
    this.workerId = exactId(state.workerId, "workerId");
    this.revision = positiveInteger(state.revision, "revision");
    this.fencingToken = positiveInteger(state.fencingToken, "fencingToken");
    this.leaseExpiresAt = positiveInteger(state.leaseExpiresAt, "leaseExpiresAt");
    this.ledgerPhase = state.phase;
    this.dependencies = input.dependencies;

    const contractTrafficMode = (state.contract as unknown as {
      trafficMode?: unknown;
    }).trafficMode;
    const expectedTrafficMode: ReleaseMaintenanceTrafficMode = contractTrafficMode == null
      || contractTrafficMode === "canary"
      ? "canary"
      : contractTrafficMode === "full-maintenance"
        ? "full-maintenance"
        : fail(
          "RELEASE_MAINTENANCE_PROGRESS_INITIAL_STATE_INVALID",
          "contract trafficMode is invalid",
        );
    const checkpointTrafficMode: ReleaseMaintenanceTrafficMode =
      state.checkpoint.format === RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
        && state.checkpoint.trafficMode === "full-maintenance"
        ? "full-maintenance"
        : state.checkpoint.format !== RELEASE_MAINTENANCE_EXECUTION_FORMAT_V2
          && state.checkpoint.trafficMode === undefined
          ? "canary"
          : fail(
            "RELEASE_MAINTENANCE_PROGRESS_INITIAL_STATE_INVALID",
            "checkpoint trafficMode is invalid",
          );
    if (checkpointTrafficMode !== expectedTrafficMode) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_INITIAL_STATE_INVALID",
        "checkpoint trafficMode differs from the immutable contract",
      );
    }
    this.trafficMode = checkpointTrafficMode;
    const expectedInitialPhase = checkpointTrafficMode === "full-maintenance"
      ? "maintenance-listener-baseline-verifying"
      : "maintenance-draining";
    if (state.phase !== expectedInitialPhase) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_INITIAL_STATE_INVALID",
        "fresh checkpoint phase differs from immutable trafficMode",
      );
    }

    const inventory = state.contract?.inventory?.targets;
    if (!Array.isArray(inventory)) {
      fail("RELEASE_MAINTENANCE_PROGRESS_INITIAL_STATE_INVALID", "target inventory is missing");
    }
    this.apiTargetKeys = inventory
      .filter(({ role }) => role === "api")
      .map(({ key }) => exactId(key, "api target key"))
      .sort();
    this.workerTargetKeys = inventory
      .filter(({ role }) => role === "worker")
      .map(({ key }) => exactId(key, "worker target key"))
      .sort();
    this.allTargetKeys = [...this.apiTargetKeys, ...this.workerTargetKeys].sort();
    if (
      this.apiTargetKeys.length < 1
      || this.workerTargetKeys.length < 1
      || new Set(this.allTargetKeys).size !== this.allTargetKeys.length
      || this.allTargetKeys.length !== inventory.length
    ) {
      fail("RELEASE_MAINTENANCE_PROGRESS_INITIAL_STATE_INVALID", "target inventory is not exact");
    }

    this.originalApiWeights = new Map(
      state.checkpoint.originalApiTrafficWeights.map(({ targetKey, weight }) => [targetKey, weight]),
    );
    if (
      this.originalApiWeights.size !== this.apiTargetKeys.length
      || this.apiTargetKeys.some((key) => !this.originalApiWeights.has(key))
    ) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_INITIAL_STATE_INVALID",
        "original API traffic weights are not exact",
      );
    }
    this.targetArtifactSha256 = exactSha(
      state.contract.target.artifactSha256,
      "target artifact sha256",
    );
    this.migrationRunId = exactId(state.contract.migration.runId, "migration run id");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertRunning(): void {
    if (this.terminal) {
      fail("RELEASE_MAINTENANCE_PROGRESS_TERMINAL", "maintenance ledger is already terminal");
    }
  }

  private assertLedgerPhase(expected: ReleaseMaintenanceExecutionPhase, event: string): void {
    if (this.ledgerPhase !== expected) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
        `${event} cannot advance from ${this.ledgerPhase}`,
      );
    }
  }

  private assertTrafficMode(expected: ReleaseMaintenanceTrafficMode, event: string): void {
    if (this.trafficMode !== expected) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
        `${event} is not valid for ${this.trafficMode}`,
      );
    }
  }

  private exactTarget(
    value: unknown,
    expected: readonly string[],
    event: string,
  ): string {
    if (typeof value !== "string" || !expected.includes(value)) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_TARGET_INVALID",
        `${event} target is outside the committed inventory`,
      );
    }
    return value;
  }

  private addTarget(
    seen: Set<string>,
    targetKey: string,
    event: string,
  ): void {
    if (seen.has(targetKey)) {
      fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", `${event} target was already recorded`);
    }
    seen.add(targetKey);
  }

  private aggregateEvidence(event: string, targetKeys: readonly string[]): string {
    return sha256({
      format: RELEASE_MAINTENANCE_PROGRESS_FORMAT,
      deploymentId: this.deploymentId,
      event,
      targetKeys: [...targetKeys].sort(),
    });
  }

  private singleEvidence(event: string, evidence?: Record<string, unknown>): string {
    return sha256({
      format: RELEASE_MAINTENANCE_PROGRESS_FORMAT,
      deploymentId: this.deploymentId,
      event,
      ...(evidence ? { evidence } : {}),
    });
  }

  private assertCanaryReceiptEvidence(
    value: unknown,
    receiptField: "openedReceiptSha256" | "observationReceiptSha256" | "containmentReceiptSha256",
    label: string,
    expectedKeys: readonly string[] = ["operationId", "planSha256", receiptField],
  ): { receiptSha256: string } {
    if (!this.canaryOperationId || !this.canaryPlanSha256) {
      fail("RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID", "canary plan is missing");
    }
    const evidence = exactKeys(value, expectedKeys, label);
    const operationId = exactId(evidence.operationId, "canary.operationId");
    const planSha256 = exactSha(evidence.planSha256, "canary.planSha256");
    if (operationId !== this.canaryOperationId || planSha256 !== this.canaryPlanSha256) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID",
        "canary receipt does not match the durable plan",
      );
    }
    return { receiptSha256: exactSha(evidence[receiptField], `canary.${receiptField}`) };
  }

  private async advance(transition: ReleaseMaintenanceExecutionTransition): Promise<void> {
    const expectedRevision = this.revision;
    const result = await advanceReleaseMaintenanceExecution({
      executorKind: RELEASE_MAINTENANCE_EXECUTOR_KIND,
      deploymentId: this.deploymentId,
      workerId: this.workerId,
      expectedRevision,
      fencingToken: this.fencingToken,
      transition,
    }, this.dependencies);
    this.assertAdvanceResult(result, expectedRevision);
    this.revision = result.revision;
    this.fencingToken = result.fencingToken;
    this.leaseExpiresAt = result.leaseExpiresAt;
    this.ledgerPhase = result.checkpoint.phase;
  }

  private assertAdvanceResult(
    result: ReleaseMaintenanceExecutionClaim,
    expectedRevision: number,
  ): void {
    if (
      result.deploymentId !== this.deploymentId
      || result.workerId !== this.workerId
      || result.revision !== expectedRevision + 1
      || result.checkpoint.revision !== result.revision
      || result.fencingToken !== this.fencingToken
      || result.leaseExpiresAt < 1
    ) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_LEDGER_RESPONSE_INVALID",
        "maintenance ledger returned an invalid CAS cursor",
      );
    }
  }

  record(record: ReleaseMaintenanceDurableProgressRecord): Promise<void> {
    return this.enqueue(async () => {
      this.assertRunning();
      await this.recordSerialized(record);
    });
  }

  private async recordSerialized(record: ReleaseMaintenanceDurableProgressRecord): Promise<void> {
    switch (record.event) {
      case "listener-baseline-verified": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-draining");
        assertNoTarget(record);
        this.assertTrafficMode("full-maintenance", record.event);
        this.assertLedgerPhase("maintenance-listener-baseline-verifying", record.event);
        if (this.listenerBaselineVerified) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "listener baseline was already recorded");
        }
        const evidence = exactKeys(
          record.evidence,
          ["evidenceSha256"],
          "listener baseline evidence",
        );
        const evidenceSha256 = exactSha(
          evidence.evidenceSha256,
          "listenerBaselineEvidenceSha256",
        );
        await this.advance({
          kind: "listener-baseline-verified",
          evidenceSha256,
        });
        this.listenerBaselineVerified = true;
        this.listenerBaselineEvidenceSha256 = evidenceSha256;
        return;
      }
      case "listeners-disabled": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-draining");
        assertNoTarget(record);
        this.assertTrafficMode("full-maintenance", record.event);
        this.assertLedgerPhase("maintenance-listener-baseline-verified", record.event);
        if (!this.listenerBaselineVerified || this.listenersDisabled) {
          fail(
            this.listenersDisabled
              ? "RELEASE_MAINTENANCE_PROGRESS_DUPLICATE"
              : "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
            "listener disable requires one durable baseline",
          );
        }
        const evidence = exactKeys(
          record.evidence,
          ["evidenceSha256"],
          "listener disable evidence",
        );
        const evidenceSha256 = exactSha(
          evidence.evidenceSha256,
          "listenerDisableEvidenceSha256",
        );
        await this.advance({
          kind: "listeners-disabled",
          evidenceSha256,
        });
        this.listenersDisabled = true;
        this.listenerDisableEvidenceSha256 = evidenceSha256;
        return;
      }
      case "traffic-baseline-recorded": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-draining");
        assertNoTarget(record);
        this.assertLedgerPhase(
          this.trafficMode === "full-maintenance"
            ? "maintenance-listener-baseline-verified"
            : "maintenance-draining",
          record.event,
        );
        if (this.trafficMode === "full-maintenance" && !this.listenerBaselineVerified) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
            "backend baseline requires the durable full serving baseline",
          );
        }
        if (this.trafficBaselineRecorded) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "traffic baseline was already recorded");
        }
        const evidence = exactKeys(record.evidence, ["originalWeights"], "traffic baseline evidence");
        const weights = exactKeys(
          evidence.originalWeights,
          this.apiTargetKeys,
          "traffic baseline weights",
        );
        for (const key of this.apiTargetKeys) {
          if (
            !Number.isSafeInteger(Number(weights[key]))
            || Number(weights[key]) !== this.originalApiWeights.get(key)
          ) {
            fail(
              "RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID",
              "traffic baseline differs from the acquired ledger",
            );
          }
        }
        this.trafficBaselineRecorded = true;
        return;
      }
      case "traffic-drained":
        assertRecordEnvelope(record, ["event", "phase"], "maintenance-draining");
        assertNoTarget(record);
        assertNoEvidence(record);
        this.assertLedgerPhase(
          this.trafficMode === "full-maintenance"
            ? "maintenance-listeners-disabled"
            : "maintenance-draining",
          record.event,
        );
        if (!this.trafficBaselineRecorded) {
          fail("RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID", "traffic baseline is missing");
        }
        if (this.trafficDrained) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "traffic drain was already recorded");
        }
        this.trafficDrained = true;
        return;
      case "api-drained": {
        assertRecordEnvelope(record, ["event", "phase", "targetKey"], "maintenance-draining");
        assertNoEvidence(record);
        this.assertLedgerPhase(
          this.trafficMode === "full-maintenance"
            ? "maintenance-listeners-disabled"
            : "maintenance-draining",
          record.event,
        );
        if (!this.trafficDrained) {
          fail("RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID", "traffic drain is missing");
        }
        const targetKey = this.exactTarget(record.targetKey, this.apiTargetKeys, record.event);
        this.addTarget(this.apiDrained, targetKey, record.event);
        if (this.apiDrained.size === this.apiTargetKeys.length) {
          await this.advance({
            kind: "api-drained",
            evidenceSha256: this.aggregateEvidence("api-drained", this.apiTargetKeys),
          });
        }
        return;
      }
      case "worker-drained": {
        assertRecordEnvelope(record, ["event", "phase", "targetKey"], "maintenance-draining");
        assertNoEvidence(record);
        this.assertLedgerPhase("maintenance-api-drained", record.event);
        const targetKey = this.exactTarget(record.targetKey, this.workerTargetKeys, record.event);
        this.addTarget(this.workersDrained, targetKey, record.event);
        if (this.workersDrained.size === this.workerTargetKeys.length) {
          await this.advance({
            kind: "workers-drained",
            evidenceSha256: this.aggregateEvidence("workers-drained", this.workerTargetKeys),
          });
        }
        return;
      }
      case "node-quiesced": {
        assertRecordEnvelope(record, ["event", "phase", "targetKey"], "maintenance-quiesced");
        assertNoEvidence(record);
        this.assertLedgerPhase("maintenance-workers-drained", record.event);
        const targetKey = this.exactTarget(record.targetKey, this.allTargetKeys, record.event);
        this.addTarget(this.nodesQuiesced, targetKey, record.event);
        if (this.nodesQuiesced.size === this.allTargetKeys.length) {
          await this.advance({
            kind: "nodes-quiesced",
            evidenceSha256: this.aggregateEvidence("nodes-quiesced", this.allTargetKeys),
          });
        }
        return;
      }
      case "writer-proof-recorded": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-checkpoint");
        assertNoTarget(record);
        this.assertLedgerPhase("maintenance-nodes-quiesced", record.event);
        if (this.writerEvidence) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "writer proof was already recorded");
        }
        const evidence = exactKeys(record.evidence, [
          "writerQuiescenceProofSha256",
          "writerQuiescenceProofContentSha256",
          "databaseIdentitySha256",
        ], "writer proof evidence");
        const writerEvidence = {
          writerQuiescenceProofSha256: exactSha(
            evidence.writerQuiescenceProofSha256,
            "writerQuiescenceProofSha256",
          ),
          writerQuiescenceProofContentSha256: exactSha(
            evidence.writerQuiescenceProofContentSha256,
            "writerQuiescenceProofContentSha256",
          ),
          databaseIdentitySha256: exactSha(
            evidence.databaseIdentitySha256,
            "databaseIdentitySha256",
          ),
        };
        await this.advance({
          kind: "writers-quiesced",
          writerQuiescenceProofSha256: writerEvidence.writerQuiescenceProofSha256,
        });
        this.writerEvidence = writerEvidence;
        return;
      }
      case "backup-checkpoint-recorded": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-checkpoint");
        assertNoTarget(record);
        this.assertLedgerPhase("maintenance-writers-quiesced", record.event);
        if (this.backupCheckpointEvidenceSha256) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "backup checkpoint was already recorded");
        }
        const evidence = exactKeys(record.evidence, [
          "backupCheckpointEvidenceSha256",
          "checkpointId",
          "remoteObjectIdentitySha256",
        ], "backup checkpoint evidence");
        const backupCheckpointEvidenceSha256 = exactSha(
          evidence.backupCheckpointEvidenceSha256,
          "backupCheckpointEvidenceSha256",
        );
        exactId(evidence.checkpointId, "checkpointId");
        exactSha(evidence.remoteObjectIdentitySha256, "remoteObjectIdentitySha256");
        await this.advance({ kind: "backup-checkpointed", backupCheckpointEvidenceSha256 });
        this.backupCheckpointEvidenceSha256 = backupCheckpointEvidenceSha256;
        return;
      }
      case "schema-migration-attempted":
        assertRecordEnvelope(record, ["event", "phase"], "maintenance-migrating");
        assertNoTarget(record);
        assertNoEvidence(record);
        this.assertLedgerPhase("maintenance-backup-checkpointed", record.event);
        if (this.migrationAttempted) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "migration attempt was already recorded");
        }
        await this.advance({
          kind: "schema-migration-attempted",
          migrationAttemptEvidenceSha256: this.singleEvidence("schema-migration-attempted"),
        });
        this.migrationAttempted = true;
        return;
      case "schema-migration-completed": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-migrating");
        assertNoTarget(record);
        this.assertLedgerPhase("maintenance-schema-migrating", record.event);
        if (this.migrationCompleted) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "migration completion was already recorded");
        }
        const evidence = exactKeys(
          record.evidence,
          ["schemaVersion", "migrationRunId"],
          "migration completion evidence",
        );
        if (evidence.schemaVersion !== 48 || evidence.migrationRunId !== this.migrationRunId) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID",
            "migration completion does not match the reserved migration",
          );
        }
        await this.advance({
          kind: "schema-migration-completed",
          migrationCompletionEvidenceSha256: this.singleEvidence(
            "schema-migration-completed",
            { schemaVersion: 48, migrationRunId: this.migrationRunId },
          ),
        });
        this.migrationCompleted = true;
        return;
      }
      case "maintenance-backfill-completed": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-backfill");
        assertNoTarget(record);
        this.assertLedgerPhase("maintenance-schema-migrated", record.event);
        if (this.maintenanceBackfillReceiptSha256) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "backfill receipt was already recorded");
        }
        const evidence = exactKeys(
          record.evidence,
          ["maintenanceBackfillReceiptSha256"],
          "backfill evidence",
        );
        const maintenanceBackfillReceiptSha256 = exactSha(
          evidence.maintenanceBackfillReceiptSha256,
          "maintenanceBackfillReceiptSha256",
        );
        await this.advance({ kind: "backfills-completed", maintenanceBackfillReceiptSha256 });
        this.maintenanceBackfillReceiptSha256 = maintenanceBackfillReceiptSha256;
        return;
      }
      case "target-activation-attempted": {
        assertRecordEnvelope(record, ["event", "phase", "targetKey"], record.phase);
        assertNoEvidence(record);
        if (record.phase === "maintenance-api-activation") {
          this.assertLedgerPhase("maintenance-backfills-completed", record.event);
          const targetKey = this.exactTarget(record.targetKey, this.apiTargetKeys, record.event);
          this.addTarget(this.apiActivationAttempted, targetKey, record.event);
          return;
        }
        if (record.phase === "maintenance-worker-activation") {
          this.assertLedgerPhase("maintenance-api-target-active", record.event);
          const targetKey = this.exactTarget(record.targetKey, this.workerTargetKeys, record.event);
          this.addTarget(this.workerActivationAttempted, targetKey, record.event);
          return;
        }
        fail(
          "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
          "target activation attempt has an invalid phase",
        );
      }
      case "target-activated": {
        assertRecordEnvelope(record, ["event", "phase", "targetKey"], record.phase);
        assertNoEvidence(record);
        if (record.phase === "maintenance-api-activation") {
          this.assertLedgerPhase("maintenance-backfills-completed", record.event);
          const targetKey = this.exactTarget(record.targetKey, this.apiTargetKeys, record.event);
          if (!this.apiActivationAttempted.has(targetKey)) {
            fail("RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID", "API activation attempt is missing");
          }
          this.addTarget(this.apiActivated, targetKey, record.event);
          if (this.apiActivated.size === this.apiTargetKeys.length) {
            await this.advance({
              kind: "api-target-activated",
              evidenceSha256: this.aggregateEvidence("api-target-activated", this.apiTargetKeys),
            });
          }
          return;
        }
        if (record.phase === "maintenance-worker-activation") {
          this.assertLedgerPhase("maintenance-api-target-active", record.event);
          const targetKey = this.exactTarget(record.targetKey, this.workerTargetKeys, record.event);
          if (!this.workerActivationAttempted.has(targetKey)) {
            fail("RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID", "Worker activation attempt is missing");
          }
          this.addTarget(this.workerActivated, targetKey, record.event);
          return;
        }
        fail(
          "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
          "target activation has an invalid phase",
        );
      }
      case "worker-isolation-verified": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "targetKey"],
          "maintenance-worker-activation",
        );
        assertNoEvidence(record);
        this.assertLedgerPhase("maintenance-api-target-active", record.event);
        const targetKey = this.exactTarget(record.targetKey, this.workerTargetKeys, record.event);
        if (!this.workerActivated.has(targetKey)) {
          fail("RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID", "Worker activation is missing");
        }
        this.addTarget(this.workerIsolationVerified, targetKey, record.event);
        if (this.workerIsolationVerified.size === this.workerTargetKeys.length) {
          if (
            this.workerActivationAttempted.size !== this.workerTargetKeys.length
            || this.workerActivated.size !== this.workerTargetKeys.length
          ) {
            fail(
              "RELEASE_MAINTENANCE_PROGRESS_INCOMPLETE",
              "Worker activation evidence is incomplete",
            );
          }
          await this.advance({
            kind: "worker-target-activated",
            evidenceSha256: this.aggregateEvidence(
              "worker-target-activated",
              this.workerTargetKeys,
            ),
          });
        }
        return;
      }
      case "homogeneous-isolated-ready": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "evidence"],
          "maintenance-worker-activation",
        );
        assertNoTarget(record);
        this.assertLedgerPhase("maintenance-worker-target-active", record.event);
        if (this.homogeneousIsolatedReady) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_DUPLICATE",
            "homogeneous isolated readiness was already recorded",
          );
        }
        if (
          this.apiActivated.size !== this.apiTargetKeys.length
          || this.workerActivated.size !== this.workerTargetKeys.length
          || this.workerIsolationVerified.size !== this.workerTargetKeys.length
        ) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_INCOMPLETE",
            "homogeneous isolated readiness requires every target",
          );
        }
        const evidence = exactKeys(record.evidence, [
          "artifactSha256",
          "fleetEvidenceSha256",
          "schemaVersion",
          "targetEvidenceSha256ByKey",
        ], "homogeneous isolated readiness evidence");
        const artifactSha256 = exactSha(evidence.artifactSha256, "artifactSha256");
        const fleetEvidenceSha256 = exactSha(
          evidence.fleetEvidenceSha256,
          "fleetEvidenceSha256",
        );
        if (evidence.schemaVersion !== 48 || artifactSha256 !== this.targetArtifactSha256) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID",
            "homogeneous readiness is not bound to the schema 48 target artifact",
          );
        }
        const targetEvidence = exactKeys(
          evidence.targetEvidenceSha256ByKey,
          this.allTargetKeys,
          "homogeneous target evidence",
        );
        const targetEvidenceSha256ByKey = Object.fromEntries(
          this.allTargetKeys.map((targetKey) => [
            targetKey,
            exactSha(targetEvidence[targetKey], `targetEvidence.${targetKey}`),
          ]),
        );
        await this.advance({
          kind: "homogeneous-isolated-ready",
          evidenceSha256: fleetEvidenceSha256,
          schemaVersion: 48,
          artifactSha256,
          targetEvidenceSha256ByKey,
        });
        this.homogeneousIsolatedReady = true;
        return;
      }
      case "worker-resumed": {
        assertRecordEnvelope(record, ["event", "phase", "targetKey"], "maintenance-worker-resume");
        assertNoEvidence(record);
        this.assertLedgerPhase("maintenance-homogeneous-isolated-ready", record.event);
        const targetKey = this.exactTarget(record.targetKey, this.workerTargetKeys, record.event);
        this.addTarget(this.workersResumed, targetKey, record.event);
        if (this.workersResumed.size === this.workerTargetKeys.length) {
          await this.advance({
            kind: "workers-resumed",
            evidenceSha256: this.aggregateEvidence("workers-resumed", this.workerTargetKeys),
          });
        }
        return;
      }
      case "private-validation-passed": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "evidence"],
          "maintenance-traffic-restore",
        );
        assertNoTarget(record);
        this.assertTrafficMode("full-maintenance", record.event);
        this.assertLedgerPhase("maintenance-workers-resumed", record.event);
        if (this.privateValidationReceiptSha256) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_DUPLICATE",
            "private validation was already recorded",
          );
        }
        const evidence = exactKeys(
          record.evidence,
          [
            "evidenceManifestSha256",
            "postValidationFleetEvidenceSha256",
            "validationBindingSha256",
            "validationReceiptContentSha256",
            "validationReceiptSha256",
          ],
          "private validation evidence",
        );
        const validationReceiptSha256 = exactSha(
          evidence.validationReceiptSha256,
          "validationReceiptSha256",
        );
        const evidenceManifestSha256 = exactSha(
          evidence.evidenceManifestSha256,
          "evidenceManifestSha256",
        );
        exactSha(evidence.validationReceiptContentSha256, "validationReceiptContentSha256");
        exactSha(evidence.validationBindingSha256, "validationBindingSha256");
        exactSha(
          evidence.postValidationFleetEvidenceSha256,
          "postValidationFleetEvidenceSha256",
        );
        await this.advance({
          kind: "private-validation-passed",
          validationReceiptSha256,
          evidenceManifestSha256,
        });
        this.privateValidationReceiptSha256 = validationReceiptSha256;
        this.privateValidationEvidenceManifestSha256 = evidenceManifestSha256;
        return;
      }
      case "traffic-restore-attempted": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "evidence"],
          "maintenance-traffic-restore",
        );
        assertNoTarget(record);
        this.assertTrafficMode("full-maintenance", record.event);
        this.assertLedgerPhase("maintenance-private-validation-passed", record.event);
        if (this.restoreAttemptEvidenceSha256) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_DUPLICATE",
            "traffic restore attempt was already recorded",
          );
        }
        const evidence = exactKeys(
          record.evidence,
          ["restoreAttemptEvidenceSha256"],
          "traffic restore attempt evidence",
        );
        const restoreAttemptEvidenceSha256 = exactSha(
          evidence.restoreAttemptEvidenceSha256,
          "restoreAttemptEvidenceSha256",
        );
        await this.advance({
          kind: "traffic-restore-attempted",
          restoreAttemptEvidenceSha256,
        });
        this.restoreAttemptEvidenceSha256 = restoreAttemptEvidenceSha256;
        return;
      }
      case "canary-planned": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "evidence"],
          "maintenance-traffic-restore",
        );
        assertNoTarget(record);
        this.assertTrafficMode("canary", record.event);
        this.assertLedgerPhase("maintenance-workers-resumed", record.event);
        if (this.canaryPlanSha256) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "canary plan was already recorded");
        }
        const evidence = exactKeys(
          record.evidence,
          ["operationId", "planSha256"],
          "canary plan evidence",
        );
        const operationId = exactId(evidence.operationId, "canary.operationId");
        if (operationId !== this.deploymentId) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID",
            "canary operation does not match the deployment",
          );
        }
        const planSha256 = exactSha(evidence.planSha256, "canary.planSha256");
        await this.advance({
          kind: "canary-planned",
          canaryOperationId: operationId,
          canaryPlanSha256: planSha256,
        });
        this.canaryOperationId = operationId;
        this.canaryPlanSha256 = planSha256;
        return;
      }
      case "canary-opened": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "evidence"],
          "maintenance-traffic-restore",
        );
        assertNoTarget(record);
        this.assertTrafficMode("canary", record.event);
        this.assertLedgerPhase("maintenance-canary-planned", record.event);
        if (this.canaryOpenedReceiptSha256) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "canary open was already recorded");
        }
        const evidence = this.assertCanaryReceiptEvidence(
          record.evidence,
          "openedReceiptSha256",
          "canary open evidence",
        );
        await this.advance({
          kind: "canary-opened",
          canaryOpenedReceiptSha256: evidence.receiptSha256,
        });
        this.canaryOpenedReceiptSha256 = evidence.receiptSha256;
        return;
      }
      case "canary-observation-passed": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "evidence"],
          "maintenance-traffic-restore",
        );
        assertNoTarget(record);
        this.assertTrafficMode("canary", record.event);
        this.assertLedgerPhase("maintenance-canary-opened", record.event);
        if (this.canaryObservationReceiptSha256) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_DUPLICATE",
            "canary observation was already recorded",
          );
        }
        const raw = exactKeys(record.evidence, [
          "observationReceiptSha256",
          "operationId",
          "planSha256",
          "verdict",
        ], "canary observation evidence");
        if (raw.verdict !== "PASS") {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID",
            "canary observation verdict must be PASS",
          );
        }
        const evidence = this.assertCanaryReceiptEvidence(
          raw,
          "observationReceiptSha256",
          "canary observation evidence",
          ["operationId", "planSha256", "observationReceiptSha256", "verdict"],
        );
        await this.advance({
          kind: "canary-observation-passed",
          canaryObservationReceiptSha256: evidence.receiptSha256,
        });
        this.canaryObservationReceiptSha256 = evidence.receiptSha256;
        return;
      }
      case "canary-contained": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "evidence"],
          "maintenance-traffic-restore",
        );
        assertNoTarget(record);
        this.assertTrafficMode("canary", record.event);
        this.assertLedgerPhase("maintenance-canary-observation-passed", record.event);
        if (this.canaryContainmentReceiptSha256) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "canary containment was already recorded");
        }
        const evidence = this.assertCanaryReceiptEvidence(
          record.evidence,
          "containmentReceiptSha256",
          "canary containment evidence",
        );
        await this.advance({
          kind: "canary-contained",
          canaryContainmentReceiptSha256: evidence.receiptSha256,
        });
        this.canaryContainmentReceiptSha256 = evidence.receiptSha256;
        return;
      }
      case "canary-contained-after-failure": {
        assertRecordEnvelope(
          record,
          ["event", "phase", "evidence"],
          "maintenance-traffic-restore",
        );
        assertNoTarget(record);
        this.assertTrafficMode("canary", record.event);
        if (
          this.ledgerPhase !== "maintenance-canary-planned"
          && this.ledgerPhase !== "maintenance-canary-opened"
        ) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
            `${record.event} cannot advance from ${this.ledgerPhase}`,
          );
        }
        if (this.canaryContainmentReceiptSha256) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "canary containment was already recorded");
        }
        if (this.canaryObservationReceiptSha256) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
            "failed canary containment cannot follow a PASS observation",
          );
        }
        const evidence = this.assertCanaryReceiptEvidence(
          record.evidence,
          "containmentReceiptSha256",
          "failed canary containment evidence",
        );
        await this.advance({
          kind: "canary-contained-after-failure",
          canaryContainmentReceiptSha256: evidence.receiptSha256,
        });
        this.canaryContainmentReceiptSha256 = evidence.receiptSha256;
        return;
      }
      case "traffic-restored":
        assertRecordEnvelope(record, ["event", "phase"], "maintenance-traffic-restore");
        assertNoTarget(record);
        assertNoEvidence(record);
        this.assertLedgerPhase(
          this.trafficMode === "full-maintenance"
            ? "maintenance-traffic-restore-attempted"
            : "maintenance-canary-contained",
          record.event,
        );
        if (this.trafficRestored) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "traffic restore was already recorded");
        }
        await this.advance({
          kind: "traffic-restored",
          evidenceSha256: this.singleEvidence("traffic-restored"),
        });
        this.trafficRestored = true;
        return;
      case "listener-enable-attempted": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-traffic-restore");
        assertNoTarget(record);
        this.assertTrafficMode("full-maintenance", record.event);
        this.assertLedgerPhase("maintenance-traffic-restored", record.event);
        if (!this.trafficRestored || this.listenerEnableAttempted) {
          fail(
            this.listenerEnableAttempted
              ? "RELEASE_MAINTENANCE_PROGRESS_DUPLICATE"
              : "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
            "listener enable attempt requires restored backend proof",
          );
        }
        const evidence = exactKeys(
          record.evidence,
          ["evidenceSha256"],
          "listener enable attempt evidence",
        );
        const evidenceSha256 = exactSha(
          evidence.evidenceSha256,
          "listenerEnableAttemptEvidenceSha256",
        );
        await this.advance({
          kind: "listener-enable-attempted",
          evidenceSha256,
        });
        this.listenerEnableAttempted = true;
        this.listenerEnableAttemptEvidenceSha256 = evidenceSha256;
        return;
      }
      case "listeners-enabled": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-traffic-restore");
        assertNoTarget(record);
        this.assertTrafficMode("full-maintenance", record.event);
        this.assertLedgerPhase("maintenance-listener-enable-attempted", record.event);
        if (!this.listenerEnableAttempted || this.listenersEnabled) {
          fail(
            this.listenersEnabled
              ? "RELEASE_MAINTENANCE_PROGRESS_DUPLICATE"
              : "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
            "listener enable receipt requires a durable attempt",
          );
        }
        const evidence = exactKeys(
          record.evidence,
          ["evidenceSha256"],
          "listener enable evidence",
        );
        const evidenceSha256 = exactSha(
          evidence.evidenceSha256,
          "listenerEnableEvidenceSha256",
        );
        await this.advance({
          kind: "listeners-enabled",
          evidenceSha256,
        });
        this.listenersEnabled = true;
        this.listenerEnableEvidenceSha256 = evidenceSha256;
        return;
      }
      case "public-smoke-completed": {
        assertRecordEnvelope(record, ["event", "phase", "evidence"], "maintenance-public-smoke");
        assertNoTarget(record);
        this.assertLedgerPhase(
          this.trafficMode === "full-maintenance"
            ? "maintenance-listeners-enabled"
            : "maintenance-traffic-restored",
          record.event,
        );
        if (this.trafficMode === "full-maintenance" && !this.listenersEnabled) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_ORDER_INVALID",
            "public smoke requires both listeners durably enabled",
          );
        }
        if (this.publicSmokePassed) {
          fail("RELEASE_MAINTENANCE_PROGRESS_DUPLICATE", "public smoke was already recorded");
        }
        const evidence = exactKeys(record.evidence, ["artifactSha256"], "public smoke evidence");
        const artifactSha256 = exactSha(evidence.artifactSha256, "artifactSha256");
        if (artifactSha256 !== this.targetArtifactSha256) {
          fail(
            "RELEASE_MAINTENANCE_PROGRESS_EVIDENCE_INVALID",
            "public smoke is not bound to the target artifact",
          );
        }
        await this.advance({ kind: "public-smoke-passed", evidenceSha256: artifactSha256 });
        this.publicSmokePassed = true;
        return;
      }
      default:
        fail("RELEASE_MAINTENANCE_PROGRESS_EVENT_INVALID", "unknown maintenance event");
    }
  }

  fail(input: {
    phase: OrchestratorPhase;
    code: string;
    migrationAttempted: boolean;
  }): Promise<void> {
    return this.enqueue(async () => {
      this.assertRunning();
      exactKeys(input, ["phase", "code", "migrationAttempted"], "failure input");
      const phaseKnown = orchestratorPhases.includes(input.phase as OrchestratorPhase);
      const migrationFactMismatch = (
        typeof input.migrationAttempted !== "boolean"
        || input.migrationAttempted !== this.migrationAttempted
      );
      const failureCode = migrationFactMismatch
        || !phaseKnown
        || !orchestratorPhaseMatchesLedger(input.phase, this.ledgerPhase)
        ? "MAINTENANCE_INTERNAL_FAILED"
        : mapReleaseMaintenanceOrchestratorFailureCode({
          code: input.code,
          orchestratorPhase: input.phase,
          ledgerPhase: this.ledgerPhase,
        });
      const result = await failReleaseMaintenanceExecution({
        executorKind: RELEASE_MAINTENANCE_EXECUTOR_KIND,
        deploymentId: this.deploymentId,
        workerId: this.workerId,
        expectedRevision: this.revision,
        fencingToken: this.fencingToken,
        failureCode,
      }, this.dependencies);
      this.assertTerminalResult(result, "degraded_manual");
      this.revision = result.revision;
      this.ledgerPhase = result.phase;
      this.leaseExpiresAt = 0;
      this.terminal = true;
    });
  }

  succeed(input: ReleaseMaintenanceExecutionResult): Promise<void> {
    return this.enqueue(async () => {
      this.assertRunning();
      const successKeys = [
        "deploymentId",
        "targetArtifactSha256",
        "databaseIdentitySha256",
        "writerQuiescenceProofSha256",
        "writerQuiescenceProofContentSha256",
        "backupCheckpointEvidenceSha256",
        "maintenanceBackfillReceiptSha256",
        "apiNodeIds",
        "workerNodeIds",
        "publicSmokeComplete",
      ];
      const result = exactKeys(input, this.trafficMode === "full-maintenance"
        ? [
          ...successKeys,
          "listenerBaselineEvidenceSha256",
          "listenerDisableEvidenceSha256",
          "listenerEnableAttemptEvidenceSha256",
          "listenerEnableEvidenceSha256",
          "privateValidationReceiptSha256",
          "privateValidationEvidenceManifestSha256",
          "restoreAttemptEvidenceSha256",
        ]
        : successKeys, "success input");
      const trafficModeProgressComplete = this.trafficMode === "full-maintenance"
        ? Boolean(
          this.listenerBaselineVerified
          && this.listenersDisabled
          && this.privateValidationReceiptSha256
          && this.privateValidationEvidenceManifestSha256
          && this.restoreAttemptEvidenceSha256
          && this.listenerEnableAttempted
          && this.listenersEnabled
        )
        : Boolean(
          this.canaryOperationId
          && this.canaryPlanSha256
          && this.canaryOpenedReceiptSha256
          && this.canaryObservationReceiptSha256
          && this.canaryContainmentReceiptSha256
        );
      if (
        this.ledgerPhase !== "maintenance-public-smoke-passed"
        || !this.publicSmokePassed
        || this.apiDrained.size !== this.apiTargetKeys.length
        || this.workersDrained.size !== this.workerTargetKeys.length
        || this.nodesQuiesced.size !== this.allTargetKeys.length
        || this.apiActivated.size !== this.apiTargetKeys.length
        || this.workerIsolationVerified.size !== this.workerTargetKeys.length
        || !this.homogeneousIsolatedReady
        || this.workersResumed.size !== this.workerTargetKeys.length
        || !trafficModeProgressComplete
        || !this.trafficRestored
        || !this.writerEvidence
        || !this.backupCheckpointEvidenceSha256
        || !this.migrationAttempted
        || !this.migrationCompleted
        || !this.maintenanceBackfillReceiptSha256
      ) {
        fail(
          "RELEASE_MAINTENANCE_PROGRESS_INCOMPLETE",
          "maintenance progress is incomplete",
        );
      }
      if (
        result.deploymentId !== this.deploymentId
        || exactSha(result.targetArtifactSha256, "targetArtifactSha256") !== this.targetArtifactSha256
        || exactSha(result.databaseIdentitySha256, "databaseIdentitySha256")
          !== this.writerEvidence.databaseIdentitySha256
        || exactSha(result.writerQuiescenceProofSha256, "writerQuiescenceProofSha256")
          !== this.writerEvidence.writerQuiescenceProofSha256
        || exactSha(
          result.writerQuiescenceProofContentSha256,
          "writerQuiescenceProofContentSha256",
        ) !== this.writerEvidence.writerQuiescenceProofContentSha256
        || exactSha(result.backupCheckpointEvidenceSha256, "backupCheckpointEvidenceSha256")
          !== this.backupCheckpointEvidenceSha256
        || exactSha(
          result.maintenanceBackfillReceiptSha256,
          "maintenanceBackfillReceiptSha256",
        ) !== this.maintenanceBackfillReceiptSha256
        || !Array.isArray(result.apiNodeIds)
        || !sameExactSet(result.apiNodeIds as string[], this.apiTargetKeys)
        || !Array.isArray(result.workerNodeIds)
        || !sameExactSet(result.workerNodeIds as string[], this.workerTargetKeys)
        || result.publicSmokeComplete !== true
        || (
          this.trafficMode === "full-maintenance"
          && (
            exactSha(
              result.listenerBaselineEvidenceSha256,
              "listenerBaselineEvidenceSha256",
            ) !== this.listenerBaselineEvidenceSha256
            || exactSha(
              result.listenerDisableEvidenceSha256,
              "listenerDisableEvidenceSha256",
            ) !== this.listenerDisableEvidenceSha256
            || exactSha(
              result.privateValidationReceiptSha256,
              "privateValidationReceiptSha256",
            ) !== this.privateValidationReceiptSha256
            || exactSha(
              result.privateValidationEvidenceManifestSha256,
              "privateValidationEvidenceManifestSha256",
            ) !== this.privateValidationEvidenceManifestSha256
            || exactSha(
              result.restoreAttemptEvidenceSha256,
              "restoreAttemptEvidenceSha256",
            ) !== this.restoreAttemptEvidenceSha256
            || exactSha(
              result.listenerEnableAttemptEvidenceSha256,
              "listenerEnableAttemptEvidenceSha256",
            ) !== this.listenerEnableAttemptEvidenceSha256
            || exactSha(
              result.listenerEnableEvidenceSha256,
              "listenerEnableEvidenceSha256",
            ) !== this.listenerEnableEvidenceSha256
          )
        )
      ) {
        fail(
          "RELEASE_MAINTENANCE_PROGRESS_SUCCESS_MISMATCH",
          "success result does not match recorded evidence",
        );
      }
      const completed = await completeReleaseMaintenanceExecution({
        executorKind: RELEASE_MAINTENANCE_EXECUTOR_KIND,
        deploymentId: this.deploymentId,
        workerId: this.workerId,
        expectedRevision: this.revision,
        fencingToken: this.fencingToken,
      }, this.dependencies);
      this.assertTerminalResult(completed, "succeeded");
      this.revision = completed.revision;
      this.ledgerPhase = completed.phase;
      this.leaseExpiresAt = 0;
      this.terminal = true;
    });
  }

  renewLease(leaseMs?: number): Promise<ReleaseMaintenanceProgressLease> {
    return this.enqueue(async () => {
      this.assertRunning();
      const result = await renewReleaseMaintenanceExecutionLease({
        executorKind: RELEASE_MAINTENANCE_EXECUTOR_KIND,
        deploymentId: this.deploymentId,
        workerId: this.workerId,
        expectedRevision: this.revision,
        fencingToken: this.fencingToken,
        ...(leaseMs === undefined ? {} : { leaseMs }),
      }, this.dependencies);
      if (
        result.revision !== this.revision
        || result.fencingToken !== this.fencingToken
        || !Number.isSafeInteger(result.leaseExpiresAt)
        || result.leaseExpiresAt < 1
      ) {
        fail(
          "RELEASE_MAINTENANCE_PROGRESS_LEDGER_RESPONSE_INVALID",
          "maintenance lease renewal returned an invalid cursor",
        );
      }
      this.leaseExpiresAt = result.leaseExpiresAt;
      return result;
    });
  }

  private assertTerminalResult(
    result: ReleaseMaintenanceExecutionState,
    expectedStatus: "succeeded" | "degraded_manual",
  ): void {
    if (
      result.deploymentId !== this.deploymentId
      || result.status !== expectedStatus
      || result.revision !== this.revision + 1
      || result.fencingToken !== this.fencingToken
      || result.workerId !== null
      || result.leaseExpiresAt !== null
    ) {
      fail(
        "RELEASE_MAINTENANCE_PROGRESS_LEDGER_RESPONSE_INVALID",
        "maintenance terminal transition returned an invalid cursor",
      );
    }
  }
}
