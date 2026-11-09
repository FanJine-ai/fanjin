import crypto from "node:crypto";
import type { Knex } from "knex";
import { db } from "@/utils/db";
import { readRelayPortraitPreparation } from "@/lib/relayPortraitPreparation";
import {
  canonicalVideoGenerationRequest,
  videoGenerationRequestDigest,
  type VideoGenerationRequest,
} from "@/lib/videoGenerationContract";

export const VIDEO_GENERATION_RELAY_BILLING_AUDIT_VERSION =
  "video-generation-relay-billing-audit/v1" as const;

export type VideoGenerationRelayBillingStatus =
  | "not_started"
  | "reserved"
  | "settled"
  | "released"
  | "pending_reconcile";

type VideoGenerationReservedBillingAudit = {
  version: typeof VIDEO_GENERATION_RELAY_BILLING_AUDIT_VERSION;
  taskId: string;
  workspaceId: string;
  projectId: number;
  requestDigest: string;
  pricingRuleId: string;
  pricingRuleUpdatedAt: number;
  reservationId: string;
  usageRecordId: string;
  reservationUnits: number;
  settlementUnits: number;
  unit: "task" | "video" | "token";
  maximumGuMicros: number;
  actualGuMicros: number;
  status: Exclude<VideoGenerationRelayBillingStatus, "not_started">;
  terminalEvidenceId: string | null;
  terminalEvidenceIds: string[];
  providerRequestId: string | null;
  providerAccepted: boolean;
};
export type VideoGenerationRelayBillingAudit = VideoGenerationReservedBillingAudit | (
  Pick<VideoGenerationReservedBillingAudit, "version" | "taskId" | "workspaceId" | "projectId" | "requestDigest">
  & { status: "not_started"; pricingRuleId: null; pricingRuleUpdatedAt: null; reservationId: null; usageRecordId: null;
    reservationUnits: 0; settlementUnits: 0; unit: null; maximumGuMicros: 0; actualGuMicros: 0;
    terminalEvidenceId: null; terminalEvidenceIds: []; providerRequestId: null; providerAccepted: false }
);

export class VideoGenerationRelayBillingAuditError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VideoGenerationRelayBillingAuditError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new VideoGenerationRelayBillingAuditError(code, message);
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stableJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function safeInteger(value: unknown, code: string, field: string, minimum = 0): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    fail(code, `${field} 无效`);
  }
  return normalized;
}

function requestDigestFromTask(task: Record<string, unknown>): string {
  const resultPayload = object(task.resultPayload);
  const internal = object(resultPayload.internal);
  const binding = object(internal.canonicalVideoGeneration);
  const rawRequest = object(binding.request);
  if (!Object.keys(rawRequest).length) {
    fail("video_billing_canonical_request_missing", "视频任务缺少统一请求快照");
  }
  let request: VideoGenerationRequest;
  try {
    request = canonicalVideoGenerationRequest(rawRequest as unknown as VideoGenerationRequest);
  } catch {
    fail("video_billing_canonical_request_invalid", "视频任务的统一请求快照无效");
  }
  const calculated = videoGenerationRequestDigest(request!);
  if (text(binding.digest) !== calculated) {
    fail("video_billing_canonical_digest_mismatch", "视频任务的统一请求摘要不一致");
  }
  return calculated;
}

function providerBilling(task: Record<string, unknown>): Record<string, unknown> {
  return object(object(task.providerPayload).billing);
}

function providerSubmission(task: Record<string, unknown>): Record<string, unknown> {
  return object(object(task.providerPayload).submission);
}

function assertedPublicState(
  task: Record<string, unknown>,
  status: VideoGenerationRelayBillingStatus,
): void {
  const state = text(providerSubmission(task).state);
  if (!state) {
    if (status !== "reserved") {
      fail("video_billing_submission_state_missing", "视频终态账务缺少派发状态证据");
    }
    return;
  }
  const projected = state.startsWith("pending_reconcile")
    ? "pending_reconcile"
    : state === "captured"
      ? "settled"
      : ["released", "definitive_rejected", "cancelled_before_dispatch", "portrait_preparation_failed"].includes(state)
        ? "released"
        : "reserved";
  if (projected !== status) {
    fail("video_billing_submission_state_mismatch", "派发状态与权威账务终态不一致");
  }
}

function assertTerminalLedgerIdentity(input: {
  row: Record<string, unknown>;
  taskId: string;
  usageRecordId: string;
  reservationId: string;
  expectedAmountMicros: number;
  expectedType: "deduct" | "release";
}): void {
  const row = input.row;
  if (
    text(row.type) !== input.expectedType
    || text(row.relatedTaskId) !== input.taskId
    || text(row.relatedUsageId) !== input.usageRecordId
    || text(row.relatedLedgerId) !== input.reservationId
    || safeInteger(
      row.amountMicros,
      "video_billing_terminal_amount_invalid",
      `${input.expectedType} GU micros`,
    ) !== input.expectedAmountMicros
    || safeInteger(
      row.remainingMicros,
      "video_billing_terminal_amount_invalid",
      `${input.expectedType} 后剩余 GU micros`,
    ) !== 0
  ) {
    fail(
      "video_billing_terminal_identity_mismatch",
      "视频终态流水与任务、用量、冻结或金额不一致",
    );
  }
}

function terminalEvidenceIds(rows: Array<Record<string, unknown>>): string[] {
  const ids = rows.map((row) => text(row.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    fail("video_billing_terminal_identity_mismatch", "视频终态流水标识无效或重复");
  }
  return ids;
}

function isExactActiveDispatchWatchdog(input: {
  job: Record<string, unknown>;
  metadata: Record<string, unknown>;
  task: Record<string, unknown>;
  freeze: Record<string, unknown>;
  reservationId: string;
  usageRecordId: string;
  workspaceId: string;
}): boolean {
  const {
    job,
    metadata,
    task,
    freeze,
    reservationId,
    usageRecordId,
    workspaceId,
  } = input;
  const jobStatus = text(job.status);
  return (
    text(metadata.billingLifecycleState) === "dispatch_started"
    && text(metadata.reconcileJobId) === text(job.id)
    && text(job.reason) === "dispatch_watchdog"
    && ["pending", "leased"].includes(jobStatus)
    && text(job.workspaceId) === workspaceId
    && text(job.reservationId) === reservationId
    && text(job.usageRecordId) === usageRecordId
    && text(job.endpointType) === "video_generation"
    && text(job.provider) === text(task.provider)
    && text(job.channelId) === text(task.channelId)
    && text(job.requestId) === text(freeze.requestId)
    && (!text(job.dedupeKey) || text(job.dedupeKey) === `reservation:${reservationId}`)
  );
}

/**
 * Reconstructs the provider-neutral billing state from the authoritative Relay
 * task, reservation, usage, terminal ledger and reconcile job. No HTTP body or
 * provider response can supply these facts. Any ambiguous combination fails
 * closed instead of guessing that GU was charged or released.
 */
type BillingAuditInput = {
  taskId: string;
  workspaceId: string;
  projectId: number;
  database?: Knex | Knex.Transaction;
};

/** Ignore heartbeat-only changes but never combine two billing/dispatch checkpoints. */
export function videoGenerationBillingTaskSnapshot(task: Record<string, unknown>): string {
  return stableJson(Object.fromEntries(["status", "providerTaskId", "submittedAt", "requestPayload", "providerPayload", "resultPayload",
    "quotaReserved", "apiQuotaReserved", "costMicros", "workspaceId", "projectId"].map(key => [key, task[key] ?? null])));
}

function preparingUnderLiveLease(task: Record<string, unknown> | undefined): boolean {
  if (!task) return false;
  const marker = readRelayPortraitPreparation({ status: text(task.status), resultPayload: object(task.resultPayload) });
  return marker?.state === "waiting" && task.status === "queued" && !task.providerTaskId && !Number(task.submittedAt)
    && Boolean(text(task.leaseOwner)) && Number(task.leaseExpiresAt) > Date.now();
}

export async function readVideoGenerationRelayBillingAudit(input: BillingAuditInput): Promise<VideoGenerationRelayBillingAudit> {
  const database = input.database ?? db;
  for (let attempt = 0; attempt < 3; attempt++) {
    let snapshot: Record<string, unknown> | undefined;
    let result: VideoGenerationRelayBillingAudit | undefined;
    let failure: unknown;
    try { result = await readVideoGenerationRelayBillingAuditSnapshot(input, row => { snapshot = row; }); }
    catch (error) { failure = error; }
    if (!snapshot) throw failure;
    const current = await database("o_relay_task").where({ id: text(input.taskId), workspaceId: text(input.workspaceId),
      projectId: Number(input.projectId), endpointType: "video_generation" }).first();
    const changed = !current || videoGenerationBillingTaskSnapshot(snapshot) !== videoGenerationBillingTaskSnapshot(current);
    // Reserving money and attaching its receipt are separate commits. During
    // the worker's live preparation lease an incomplete read is temporary;
    // it is neither a zero-charge result nor a permanent billing quarantine.
    const transition = failure instanceof VideoGenerationRelayBillingAuditError && preparingUnderLiveLease(current);
    if (changed || transition) continue;
    if (failure) throw failure;
    return result!;
  }
  fail("video_billing_snapshot_updating", "任务状态正在同步，请稍后自动刷新");
}

async function readVideoGenerationRelayBillingAuditSnapshot(input: BillingAuditInput,
  onTask: (task: Record<string, unknown>) => void): Promise<VideoGenerationRelayBillingAudit> {
  const database = input.database ?? db;
  const taskId = text(input.taskId);
  const workspaceId = text(input.workspaceId);
  const projectId = safeInteger(
    input.projectId,
    "video_billing_project_invalid",
    "projectId",
    1,
  );
  if (!taskId || !workspaceId) {
    fail("video_billing_scope_invalid", "视频账务审计缺少工作区或任务标识");
  }
  const task = await database("o_relay_task")
    .where({
      id: taskId,
      workspaceId,
      projectId,
      endpointType: "video_generation",
    })
    .first();
  if (!task) fail("video_billing_task_not_found", "视频账务任务不存在");
  onTask(task);

  const requestDigest = requestDigestFromTask(task);
  const freezes = await database("o_billing_ledger")
    .where({ workspaceId, relatedTaskId: taskId, type: "freeze" })
    .orderBy("createdAt", "asc");
  const preparation = readRelayPortraitPreparation({ status: text(task.status), resultPayload: object(task.resultPayload) });
  if (preparation && freezes.length === 0) {
    const expectedTaskStatus = preparation.state === "waiting" ? "queued" : preparation.state;
    const expectedSubmissionState = preparation.state === "waiting" ? "awaiting_portrait"
      : preparation.state === "failed" ? "portrait_preparation_failed" : "cancelled_before_dispatch";
    const submission = providerSubmission(task);
    const requestId = text(task.requestId);
    if (!["waiting", "failed", "cancelled"].includes(preparation.state)
      || text(task.status) !== expectedTaskStatus || !requestId
      || !Number.isSafeInteger(preparation.maximumCostMicros) || preparation.maximumCostMicros <= 0
      || !Number.isSafeInteger(preparation.requestedAt) || preparation.requestedAt <= 0
      || !Number.isSafeInteger(preparation.deadlineAt) || preparation.deadlineAt <= preparation.requestedAt
      || !Number.isSafeInteger(preparation.attempts) || preparation.attempts < 0
      || !text(preparation.accountFingerprint)
      || text(task.providerTaskId) || Number(task.submittedAt) > 0
      || Number(task.quotaReserved || 0) !== 0 || Number(task.costMicros || 0) !== 0 || Number(task.apiQuotaReserved || 0) !== 0
      || Object.keys(providerBilling(task)).length
      || text(submission.state) !== expectedSubmissionState) {
      fail("video_billing_preparation_evidence_invalid", "素材登记等待状态缺少可信的未派发证据");
    }
    const [ledger, usage, reconcile] = await Promise.all([
      database("o_billing_ledger").where({ workspaceId }).andWhere(query => query.where({ relatedTaskId: taskId }).orWhere({ requestId })).first(),
      database("o_usage_record").where({ workspaceId, taskId }).first(),
      database("o_billing_reconcile_job").where({ workspaceId, requestId }).first(),
    ]);
    if (ledger || usage || reconcile) fail("video_billing_preparation_has_billing_evidence", "素材登记等待状态已存在账务证据，不能认定尚未计费");
    return { version: VIDEO_GENERATION_RELAY_BILLING_AUDIT_VERSION, taskId, workspaceId, projectId, requestDigest,
      status: "not_started", pricingRuleId: null, pricingRuleUpdatedAt: null, reservationId: null, usageRecordId: null,
      reservationUnits: 0, settlementUnits: 0, unit: null, maximumGuMicros: 0, actualGuMicros: 0,
      terminalEvidenceId: null, terminalEvidenceIds: [], providerRequestId: null, providerAccepted: false };
  }
  if (freezes.length !== 1) {
    fail("video_billing_reservation_ambiguous", "视频任务必须且只能有一条冻结流水");
  }
  const freeze = freezes[0];
  const reservationId = text(freeze.id);
  const usageRecordId = text(freeze.relatedUsageId);
  if (!reservationId || !usageRecordId) {
    fail("video_billing_reservation_incomplete", "视频冻结流水缺少用量绑定");
  }
  const usage = await database("o_usage_record")
    .where({ id: usageRecordId, workspaceId, taskId, endpointType: "video_generation" })
    .first();
  if (!usage) fail("video_billing_usage_not_found", "视频冻结流水未绑定权威用量");

  const metadata = object(freeze.metadata);
  const priceSnapshot = object(metadata.priceSnapshot);
  const billing = providerBilling(task);
  const maximumGuMicros = safeInteger(
    freeze.amountMicros,
    "video_billing_amount_invalid",
    "冻结 GU micros",
    1,
  );
  const remainingMicros = safeInteger(
    freeze.remainingMicros,
    "video_billing_amount_invalid",
    "剩余 GU micros",
  );
  if (remainingMicros > maximumGuMicros) {
    fail("video_billing_amount_invalid", "剩余冻结额度超过报价上限");
  }
  const unit = text(usage.unit || priceSnapshot.unit);
  if (!(["task", "video", "token"] as string[]).includes(unit)) {
    fail("video_billing_unit_invalid", "视频计费单位无效");
  }
  const reservationUnits = safeInteger(
    priceSnapshot.reservationUnits,
    "video_billing_units_invalid",
    "预扣单位",
    1,
  );
  const settlementUnits = safeInteger(
    usage.units,
    "video_billing_units_invalid",
    "结算单位",
  );
  const actualGuMicros = safeInteger(
    usage.costMicros,
    "video_billing_amount_invalid",
    "实际 GU micros",
  );
  const pricingRuleId = text(priceSnapshot.pricingRuleId);
  const pricingRuleUpdatedAt = safeInteger(
    priceSnapshot.pricingRuleUpdatedAt,
    "video_billing_pricing_revision_invalid",
    "定价规则版本",
  );
  const requestedModel = text(object(task.requestPayload).model || task.model);
  const pricedModel = text(priceSnapshot.model);
  const billingPriceSnapshot = object(billing.priceSnapshot);
  const billingKey = text(metadata.billingKey);
  if (
    !pricingRuleId
    || !billingKey
    || billingKey !== `relay-video:${taskId}`
    || text(priceSnapshot.endpointType) !== "video_generation"
    || text(priceSnapshot.provider) !== text(task.provider)
    || (pricedModel && pricedModel !== requestedModel)
    || text(usage.provider) !== text(task.provider)
    || text(usage.channelId) !== text(task.channelId)
    || text(priceSnapshot.unit) !== unit
    || Number(priceSnapshot.costMicros) !== maximumGuMicros
    || text(billing.reservationId) !== reservationId
    || text(billing.usageRecordId) !== usageRecordId
    || text(billing.billingKey) !== billingKey
    || stableJson(billingPriceSnapshot) !== stableJson(priceSnapshot)
    || (unit === "token"
      ? settlementUnits > reservationUnits
      : settlementUnits !== reservationUnits || reservationUnits !== 1)
    || actualGuMicros > maximumGuMicros
  ) {
    fail("video_billing_identity_mismatch", "任务、价格、冻结或用量身份不一致");
  }

  const terminalLedger = await database("o_billing_ledger")
    .where({ workspaceId, relatedLedgerId: reservationId })
    .whereIn("type", ["deduct", "release"])
    .orderBy("createdAt", "asc");
  const deductions = terminalLedger.filter((row) => row.type === "deduct");
  const releases = terminalLedger.filter((row) => row.type === "release");
  const reconcileJobs = await database("o_billing_reconcile_job")
    .where({ workspaceId, reservationId })
    .whereIn("status", ["pending", "leased", "manual_required"])
    .orderBy("createTime", "asc");
  if (deductions.length > 1 || releases.length > 1) {
    fail("video_billing_terminal_ambiguous", "视频账务存在重复或冲突终态流水");
  }

  const usageStatus = text(usage.status);
  const exactActiveDispatchWatchdog = reconcileJobs.length === 1
    && isExactActiveDispatchWatchdog({
      job: reconcileJobs[0] as Record<string, unknown>,
      metadata,
      task,
      freeze,
      reservationId,
      usageRecordId,
      workspaceId,
    });
  let status: VideoGenerationRelayBillingStatus;
  let terminalEvidenceId: string | null = null;
  let terminalEvidenceIdList: string[] = [];
  if (remainingMicros === 0 && ["charged", "free"].includes(usageStatus)) {
    const expectedCaptureMicros = usageStatus === "charged" ? actualGuMicros : 0;
    const expectedReleaseMicros = maximumGuMicros - expectedCaptureMicros;
    if (
      (expectedCaptureMicros > 0 && deductions.length !== 1)
      || (expectedCaptureMicros === 0 && deductions.length !== 0)
      || (expectedReleaseMicros > 0 && releases.length !== 1)
      || (expectedReleaseMicros === 0 && releases.length !== 0)
      || reconcileJobs.length
    ) {
      fail(
        "video_billing_capture_missing",
        "已结算视频的实扣或差额释放流水不完整",
      );
    }
    if (deductions[0]) {
      assertTerminalLedgerIdentity({
        row: deductions[0],
        taskId,
        usageRecordId,
        reservationId,
        expectedAmountMicros: expectedCaptureMicros,
        expectedType: "deduct",
      });
    }
    if (releases[0]) {
      assertTerminalLedgerIdentity({
        row: releases[0],
        taskId,
        usageRecordId,
        reservationId,
        expectedAmountMicros: expectedReleaseMicros,
        expectedType: "release",
      });
    }
    status = "settled";
    terminalEvidenceIdList = terminalEvidenceIds([
      ...deductions,
      ...releases,
    ]);
    terminalEvidenceId = terminalEvidenceIdList[0] || usageRecordId;
  } else if (remainingMicros === 0 && usageStatus === "released") {
    if (releases.length !== 1 || deductions.length || reconcileJobs.length || actualGuMicros !== 0) {
      fail("video_billing_release_invalid", "已释放视频缺少唯一退款流水或仍有费用");
    }
    assertTerminalLedgerIdentity({
      row: releases[0],
      taskId,
      usageRecordId,
      reservationId,
      expectedAmountMicros: maximumGuMicros,
      expectedType: "release",
    });
    status = "released";
    terminalEvidenceId = text(releases[0].id);
    terminalEvidenceIdList = terminalEvidenceIds(releases);
  } else if (remainingMicros > 0 && usageStatus === "pending_reconcile") {
    if (reconcileJobs.length !== 1 || deductions.length || releases.length) {
      fail("video_billing_reconcile_invalid", "待核视频缺少唯一对账任务或已出现终态流水");
    }
    const reconcileJob = reconcileJobs[0] as Record<string, unknown>;
    if (
      text(reconcileJob.usageRecordId) !== usageRecordId
      || text(reconcileJob.endpointType) !== "video_generation"
      || text(reconcileJob.provider) !== text(task.provider)
      || text(reconcileJob.channelId) !== text(task.channelId)
      || (text(reconcileJob.requestId) && text(reconcileJob.requestId) !== text(freeze.requestId))
    ) {
      fail(
        "video_billing_reconcile_identity_mismatch",
        "待核任务与视频任务、用量或价格身份不一致",
      );
    }
    status = "pending_reconcile";
    terminalEvidenceId = text(reconcileJobs[0].id);
    terminalEvidenceIdList = terminalEvidenceIds(reconcileJobs);
  } else if (
    remainingMicros === maximumGuMicros
    && ["reserved", "pending", "dispatched"].includes(usageStatus)
    && !terminalLedger.length
    // Crossing the provider dispatch boundary atomically creates a watchdog.
    // It is not a pending-reconcile terminal: while the freeze remains intact
    // and that one watchdog is bound exactly to this reservation, the public
    // billing state remains reserved. Any extra or mismatched job still fails
    // closed below instead of being mistaken for a valid in-flight task.
    && (!reconcileJobs.length || exactActiveDispatchWatchdog)
  ) {
    status = "reserved";
  } else {
    fail("video_billing_state_ambiguous", "视频账务状态无法从权威证据唯一确定");
  }
  assertedPublicState(task, status);

  return {
    version: VIDEO_GENERATION_RELAY_BILLING_AUDIT_VERSION,
    taskId,
    workspaceId,
    projectId,
    requestDigest,
    pricingRuleId,
    pricingRuleUpdatedAt,
    reservationId,
    usageRecordId,
    reservationUnits,
    settlementUnits,
    unit: unit as "task" | "video" | "token",
    maximumGuMicros,
    actualGuMicros,
    status,
    terminalEvidenceId,
    terminalEvidenceIds: terminalEvidenceIdList,
    providerRequestId: text(task.providerTaskId) || null,
    providerAccepted: Boolean(text(task.providerTaskId) || Number(task.submittedAt) > 0),
  };
}

export function videoGenerationRelayBillingAuditDigest(
  audit: VideoGenerationRelayBillingAudit,
): string {
  return crypto.createHash("sha256").update(JSON.stringify(audit)).digest("hex");
}
