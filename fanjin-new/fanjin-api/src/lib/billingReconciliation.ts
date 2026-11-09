import { SCRIPT_ASSET_ABSORPTION_CONTRACT } from "./scriptAssetPlatformAbsorption";
import { assertArkVideoCheckpoint, hasArkVideoResult, isArkVideoTask } from "./arkVideoProtocol";
import { prepareExpiredVideoReservations, VIDEO_RESERVATION_EXPIRY_POLICY } from "./videoReservationExpiry";
import { v4 as uuid } from "uuid";
import { createHash } from "node:crypto";
import { applyGuChargeRounding } from "./billingUnits";
import {
  BillingError,
  releaseApiTaskReservation,
  reservationAllowsSettlementOverage,
  settleApiTaskReservation,
  type VideoSubmitHttp400PlatformAbsorptionFence,
} from "@/lib/billing";
import { decideApiKeyQuotaCompletion } from "@/lib/apiKeyQuotaPolicy";
import { isDefinitiveVideoRejection } from "@/lib/definitiveVideoRejection";
import { isDefinitiveVideoTerminalRejection } from "@/lib/videoTerminalRejection";
import { isPostgresClient } from "@/lib/dbDialect";
import { USER_VIDEO_ENHANCE_TASK_TABLE } from "@/lib/migrations/userVideoEnhanceTask";
import {
  createUserEnhanceAssetEvidenceDescriptor,
  publishRelayVideoDelivery,
  publishUserVideoEnhanceDelivery,
  readRelayMediaProbe,
  readUserEnhanceAssetEvidenceDescriptor,
  readUserEnhanceMediaProbe,
  userEnhanceSourceAssetIdentity,
} from "@/lib/videoFulfillment/deliveryConsumer";
import {
  validateTrustedPersistentVideoAsset,
} from "@/lib/videoFulfillment/trustedPersistentAsset";
import { videoResolutionHeight } from "@/lib/videoResolutions";
import { db } from "@/utils/db";

export type BillingReconcileJobStatus = "pending" | "leased" | "manual_required" | "resolved";

export interface BillingReconcileFinancialProjection {
  reservation: {
    id: string;
    status: string;
    amountMicros: number;
    remainingMicros: number;
  } | null;
  usage: {
    id: string;
    status: string;
    costMicros: number;
    units: number;
    unit: string;
  } | null;
  relatedLedgers: Array<{
    id: string;
    type: "deduct" | "release";
    status: string;
    amountMicros: number;
  }>;
  deductedMicros: number;
  releasedMicros: number;
}

export interface BillingReconcileJob {
  id: string;
  dedupeKey: string;
  workspaceId: string;
  reservationId: string;
  usageRecordId: string | null;
  requestId: string | null;
  endpointType: string | null;
  provider: string | null;
  channelId: string | null;
  status: BillingReconcileJobStatus;
  reason: string;
  evidence: Record<string, unknown>;
  decision: string | null;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  resolvedAt: number | null;
  createTime: number;
  updateTime: number;
  /**
   * Read-only financial projection used by the Admin reconciliation screen.
   * Mutation paths keep returning the historical job shape and the screen
   * reloads this projection after every decision.
   */
  billingProjection?: BillingReconcileFinancialProjection;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatJob(row: any): BillingReconcileJob {
  return {
    id: String(row.id),
    dedupeKey: String(row.dedupeKey),
    workspaceId: String(row.workspaceId),
    reservationId: String(row.reservationId),
    usageRecordId: row.usageRecordId ?? null,
    requestId: row.requestId ?? null,
    endpointType: row.endpointType ?? null,
    provider: row.provider ?? null,
    channelId: row.channelId ?? null,
    status: row.status,
    reason: String(row.reason || "unknown"),
    evidence: parseObject(row.evidence),
    decision: row.decision ?? null,
    attempts: Number(row.attempts || 0),
    nextAttemptAt: Number(row.nextAttemptAt || 0),
    leaseOwner: row.leaseOwner ?? null,
    leaseExpiresAt: row.leaseExpiresAt == null ? null : Number(row.leaseExpiresAt),
    lastError: row.lastError ?? null,
    resolvedAt: row.resolvedAt == null ? null : Number(row.resolvedAt),
    createTime: Number(row.createTime || 0),
    updateTime: Number(row.updateTime || 0),
  };
}

function safeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

type BillingResolutionAction = "settle" | "release";

async function assertBillingResolutionAction(
  job: BillingReconcileJob,
  expected?: BillingResolutionAction,
): Promise<BillingResolutionAction> {
  const reservation = await db("o_billing_ledger")
    .where({ id: job.reservationId, workspaceId: job.workspaceId, type: "freeze" })
    .first();
  if (!reservation || Number(reservation.remainingMicros || 0) !== 0) {
    throw new BillingError("核账冻结流水尚未完成", 409);
  }
  const usage = reservation.relatedUsageId
    ? await db("o_usage_record").where({ id: reservation.relatedUsageId }).first()
    : null;
  const usageStatus = String(usage?.status || "");
  const actual =
    usageStatus === "released"
      ? "release"
      : ["charged", "free"].includes(usageStatus)
        ? "settle"
        : null;
  if (!actual) throw new BillingError("核账完成后用量状态无有效业务决策", 409);
  if (expected && actual !== expected) {
    throw new BillingError("冻结流水已按不同核账决策完成，不能覆盖", 409);
  }
  return actual;
}

async function hasTrustedUserEnhanceSettlementEvidence(
  client: any,
  job: BillingReconcileJob,
  task: any,
): Promise<boolean> {
  if (!task?.resultAssetId || !task?.resultUrl) return false;
  const asset = await client("o_media_asset")
    .where({
      id: String(task.resultAssetId),
      taskId: String(task.id),
      workspaceId: job.workspaceId,
      source: "video_enhance",
      assetType: "video",
      url: String(task.resultUrl),
    })
    .first();
  if (!asset) return false;
  const expectedEvidence = createUserEnhanceAssetEvidenceDescriptor({
    taskId: String(task.id),
    workspaceId: job.workspaceId,
    channelId: String(task.enhanceChannelId || ""),
    providerTaskId: task.providerTaskId == null ? null : String(task.providerTaskId),
    sourceAssetId: userEnhanceSourceAssetIdentity({
      taskId: String(task.id),
      sourceAssetId: task.sourceAssetId == null ? null : String(task.sourceAssetId),
      sourceUrl: task.sourceUrl == null ? null : String(task.sourceUrl),
    }),
    resultAssetId: String(task.resultAssetId),
    resultUrl: String(task.resultUrl),
    sourceResolution: String(task.sourceResolution || ""),
    targetResolution: String(task.targetResolution || ""),
  });
  const assetMetadata = parseObject(asset.metadata);
  const actualEvidence = readUserEnhanceAssetEvidenceDescriptor(assetMetadata.deliveryAssetEvidence);
  const mediaProbe = readUserEnhanceMediaProbe(assetMetadata.mediaProbe);
  const expectedTargetHeight = videoResolutionHeight(String(task.targetResolution || ""));
  if (
    !expectedEvidence
    || !actualEvidence
    || JSON.stringify(actualEvidence) !== JSON.stringify(expectedEvidence)
    || !mediaProbe
    || expectedTargetHeight <= 0
    || Number(asset.width) !== mediaProbe.width
    || Number(asset.height) !== mediaProbe.height
    || Number(asset.durationMs) !== mediaProbe.durationMs
    || String(asset.mimeType || "") !== mediaProbe.mimeType
    || Math.min(mediaProbe.width, mediaProbe.height) < expectedTargetHeight
  ) {
    return false;
  }
  const trustedAsset = await validateTrustedPersistentVideoAsset({
    client,
    asset,
    purpose: "video_enhance",
    workspaceId: job.workspaceId,
    projectId: Number(task.projectId),
    taskId: String(task.id),
    identity: mediaProbe,
  });
  if (!trustedAsset) return false;
  const publication = publishUserVideoEnhanceDelivery(
    { ...task, errorMessage: null },
    [asset],
  );
  return Boolean(
    publication.projection?.taskStatus === "succeeded"
    && publication.projection.metRequestedQuality === true
    && publication.projection.deliveryStatus === "delivered_enhanced"
  );
}

async function validateUserEnhanceSettlementEvidence(
  client: any,
  job: BillingReconcileJob,
  task: any,
): Promise<boolean> {
  if (!task) return false;
  if (
    job.reason !== "settlement_failed"
    || job.evidence.businessTaskKind !== "user_video_enhance"
    || job.evidence.settlementEvidenceComplete !== true
  ) {
    throw new BillingError(
      "该用户视频增强核账缺少可信目标档交付证据，只允许释放客户预扣",
      409,
    );
  }
  if (!await hasTrustedUserEnhanceSettlementEvidence(client, job, task)) {
    throw new BillingError("用户视频增强结果资产缺少可信交付证据，只允许释放客户预扣", 409);
  }
  return true;
}

async function assertUserEnhanceSettlementAllowed(job: BillingReconcileJob): Promise<void> {
  const expectsUserEnhance =
    job.endpointType === "video_enhance"
    || job.evidence.businessTaskKind === "user_video_enhance";
  if (!expectsUserEnhance) return;
  const taskId = String(job.evidence.taskId || "").trim();
  if (!taskId) {
    throw new BillingError("用户视频增强核账证据缺少业务任务身份，只允许释放客户预扣", 409);
  }
  const reservation = await db("o_billing_ledger")
    .where({ id: job.reservationId, workspaceId: job.workspaceId, type: "freeze" })
    .first();
  if (!reservation || String(reservation.relatedTaskId || "") !== taskId) {
    throw new BillingError("用户视频增强核账证据与冻结流水任务指针不一致，只允许释放客户预扣", 409);
  }
  const task = await db(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: taskId,
      workspaceId: job.workspaceId,
      reservationId: job.reservationId,
      kind: "user_video_enhance",
    })
    .first();
  if (!task) {
    throw new BillingError("用户视频增强核账关联的业务任务不存在，只允许释放客户预扣", 409);
  }
  await validateUserEnhanceSettlementEvidence(db, job, task);
}

async function assertRelayVideoSettlementAllowed(job: BillingReconcileJob): Promise<void> {
  if (job.endpointType !== "video_generation") return;
  const taskId = String(job.evidence.taskId || "").trim();
  if (!taskId) {
    throw new BillingError("Relay 视频核账证据缺少业务任务身份，只允许释放客户预扣", 409);
  }
  const reservation = await db("o_billing_ledger")
    .where({ id: job.reservationId, workspaceId: job.workspaceId, type: "freeze" })
    .first();
  if (!reservation || String(reservation.relatedTaskId || "") !== taskId) {
    throw new BillingError("Relay 视频核账证据与冻结流水任务指针不一致，只允许释放客户预扣", 409);
  }
  const task = await db("o_relay_task")
    .where({ id: taskId, workspaceId: job.workspaceId, endpointType: "video_generation" })
    .first();
  if (!task) {
    throw new BillingError("Relay 视频核账关联的业务任务不存在，只允许释放客户预扣", 409);
  }
  if (job.evidence.settlementEvidenceComplete !== true) {
    throw new BillingError("Relay 视频核账缺少完整结算证据，只允许释放客户预扣", 409);
  }
  const nativeTask = { ...task, projectId: task.projectId ?? null,
    requestPayload: parseObject(task.requestPayload), resultPayload: parseObject(task.resultPayload) };
  if (isArkVideoTask(nativeTask)) {
    assertArkVideoCheckpoint(nativeTask);
    const response = parseObject(parseObject(task.providerPayload).response);
    if (task.provider !== job.provider || task.channelId !== job.channelId
      || !task.providerTaskId || response.id !== task.providerTaskId
      || response.status !== "succeeded" || !hasArkVideoResult(response)) {
      throw new BillingError("官方中转缺少与原任务匹配的上游交付证据，只允许释放客户预扣", 409);
    }
    // This protocol intentionally does not retain video bytes. Its durable,
    // scoped upstream receipt replaces the managed-file delivery evidence.
    return;
  }
  const assets = await db("o_media_asset")
    .where({
      taskId,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
    })
    .orderBy("createTime", "asc");
  const providerPayload = parseObject(task.providerPayload);
  const submission = parseObject(providerPayload.submission);
  delete submission.reconcileReason;
  const publication = publishRelayVideoDelivery({
    ...task,
    requestPayload: parseObject(task.requestPayload),
    providerPayload: {
      ...providerPayload,
      submission: { ...submission, state: "captured" },
    },
    resultPayload: parseObject(task.resultPayload),
  }, assets);
  if (
    publication.projection?.taskStatus !== "succeeded"
    || publication.projection.metRequestedQuality !== true
    || !["delivered_native", "delivered_enhanced"].includes(publication.projection.deliveryStatus)
  ) {
    throw new BillingError("Relay 视频没有可信的目标档交付证据，只允许释放客户预扣", 409);
  }
  const finalAssets = assets.filter(
    (asset: any) => String(asset.source || "") === "relay_final"
      && String(asset.assetType || "") === "video",
  );
  const finalAsset = finalAssets.length === 1 ? finalAssets[0] : null;
  const mediaProbe = finalAsset
    ? readRelayMediaProbe(parseObject(finalAsset.metadata).mediaProbe)
    : null;
  if (!finalAsset || !mediaProbe) {
    throw new BillingError("Relay 视频结果缺少可复验的托管媒体证明，只允许释放客户预扣", 409);
  }
  const trustedAsset = await validateTrustedPersistentVideoAsset({
    client: db,
    asset: finalAsset,
    purpose: "relay_final",
    workspaceId: String(task.workspaceId),
    projectId: Number(task.projectId),
    taskId,
    identity: mediaProbe,
  });
  if (!trustedAsset) {
    throw new BillingError("Relay 视频媒体证明与当前托管文件不一致，只允许释放客户预扣", 409);
  }
}

async function assertBillableVideoDeliveryEvidence(job: BillingReconcileJob): Promise<void> {
  await assertUserEnhanceSettlementAllowed(job);
  await assertRelayVideoSettlementAllowed(job);
}

/**
 * Close the business task that owns a reconciled reservation. This is an exact
 * reservation/workspace binding and a row-locked, idempotent projection; jobs
 * for every other billing subject are intentionally a no-op.
 */
async function convergeUserEnhanceTaskAfterBillingResolution(
  job: BillingReconcileJob,
  action: BillingResolutionAction,
): Promise<void> {
  await db.transaction(async (trx) => {
    const query = trx(USER_VIDEO_ENHANCE_TASK_TABLE).where({
      workspaceId: job.workspaceId,
      reservationId: job.reservationId,
      kind: "user_video_enhance",
    });
    if (isPostgresClient(trx)) query.forUpdate();
    const task = await query.first();
    if (!task) return;

    const hasAssetId = Boolean(task.resultAssetId);
    const hasResultUrl = Boolean(task.resultUrl);
    if (hasAssetId !== hasResultUrl) {
      throw new BillingError("用户视频增强任务存在不完整的结果资产绑定", 409);
    }
    let hasTrustedBoundAsset = false;
    if (hasAssetId && hasResultUrl) {
      if (action === "settle") {
        hasTrustedBoundAsset = await validateUserEnhanceSettlementEvidence(trx, job, task);
      } else {
        hasTrustedBoundAsset = await hasTrustedUserEnhanceSettlementEvidence(trx, job, task);
      }
    }

    const desiredStatus = hasTrustedBoundAsset
      ? "succeeded"
      : "failed";
    const desiredError =
      desiredStatus === "succeeded"
        ? null
        : action === "release"
          ? "人工核账已确认供应商未计费，视频增强任务已结束"
          : "人工核账已确认供应商计费，但增强产物未能恢复";
    if (
      String(task.status) === desiredStatus
      && (task.errorMessage == null ? null : String(task.errorMessage)) === desiredError
    ) {
      return;
    }
    const affected = await trx(USER_VIDEO_ENHANCE_TASK_TABLE)
      .where({
        id: task.id,
        workspaceId: job.workspaceId,
        reservationId: job.reservationId,
        updatedAt: task.updatedAt,
      })
      .update({
        status: desiredStatus,
        errorMessage: desiredError,
        updatedAt: Date.now(),
      });
    if (Number(affected || 0) !== 1) {
      throw new BillingError("用户视频增强任务核账终态写入发生竞态", 409);
    }
  });
}

async function convergeRelayVideoTaskAfterBillingResolution(
  job: BillingReconcileJob,
  action: BillingResolutionAction,
): Promise<void> {
  if (action === "settle") {
    await assertRelayVideoSettlementAllowed(job);
  }
  const reservationIdentity = await db("o_billing_ledger")
    .where({
      id: job.reservationId,
      workspaceId: job.workspaceId,
      type: "freeze",
    })
    .select("relatedTaskId")
    .first();
  if (!reservationIdentity) {
    throw new BillingError("Relay 核账关联的冻结流水不存在", 404);
  }
  const taskId = String(reservationIdentity.relatedTaskId || "").trim();
  const evidenceTaskId = String(job.evidence.taskId || "").trim();
  const expectsRelayVideo = job.endpointType === "video_generation";
  if (!taskId) {
    if (expectsRelayVideo) {
      throw new BillingError("Relay 视频冻结流水缺少业务任务指针", 409);
    }
    return;
  }
  if (expectsRelayVideo && evidenceTaskId && evidenceTaskId !== taskId) {
    throw new BillingError(
      "Relay 视频核账证据与冻结流水任务指针不一致",
      409,
    );
  }
  await db.transaction(async (trx) => {
    const taskQuery = trx("o_relay_task").where({
      id: taskId,
      workspaceId: job.workspaceId,
      endpointType: "video_generation",
    });
    if (isPostgresClient(trx)) taskQuery.forUpdate();
    const task = await taskQuery.first();
    if (!task) {
      if (expectsRelayVideo) throw new BillingError("Relay 视频核账关联的业务任务不存在", 409);
      return;
    }
    const reservationQuery = trx("o_billing_ledger").where({
      id: job.reservationId,
      workspaceId: job.workspaceId,
      type: "freeze",
      relatedTaskId: taskId,
    });
    if (isPostgresClient(trx)) reservationQuery.forUpdate();
    const reservation = await reservationQuery.first();
    if (!reservation) {
      throw new BillingError(
        "Relay 核账冻结流水与业务任务指针不一致",
        409,
      );
    }
    if (action === "settle" && String(task.status || "") !== "succeeded") {
      throw new BillingError("Relay 视频任务未形成可信成功终态，禁止收口为已结算", 409);
    }

    const providerPayload = parseObject(task.providerPayload);
    const rawSubmission = providerPayload.submission;
    const submission = rawSubmission && typeof rawSubmission === "object" && !Array.isArray(rawSubmission)
      ? { ...rawSubmission as Record<string, unknown> }
      : {};
    const desiredState = action === "settle" ? "captured" : "released";
    const usage = job.usageRecordId ? await trx("o_usage_record")
      .where({ id: job.usageRecordId, workspaceId: job.workspaceId, taskId }).first() : null;
    const resolvedCost = action === "release" ? 0 : Number(usage?.costMicros);
    if (!Number.isSafeInteger(resolvedCost) || resolvedCost < 0) {
      throw new BillingError("Relay 视频核账缺少有效结算金额", 409);
    }
    const active = ["queued", "running", "enhancing"].includes(String(task.status || ""));
    const desiredStatus = action === "release" && active ? "failed" : String(task.status || "");
    const timestamp = Date.now();
    if (
      String(submission.state || "") === desiredState
      && String(task.status || "") === desiredStatus
      && Number(task.costMicros) === resolvedCost
      && !active
    ) {
      return;
    }
    const affected = await trx("o_relay_task")
      .where({
        id: taskId,
        workspaceId: job.workspaceId,
        endpointType: "video_generation",
        updateTime: task.updateTime,
      })
      .update({
        providerPayload: JSON.stringify({
          ...providerPayload,
          submission: {
            ...submission,
            state: desiredState,
            billingReconciledAt: timestamp,
            billingReconcileJobId: job.id,
          },
        }),
        status: desiredStatus,
        costMicros: resolvedCost,
        errorMessage:
          action === "release" && active
            ? "人工核账已释放预扣，Relay 视频任务已终止"
            : task.errorMessage,
        completedAt:
          action === "release" && active
            ? timestamp
            : task.completedAt,
        leaseOwner: action === "release" && active ? null : task.leaseOwner,
        leaseExpiresAt: action === "release" && active ? null : task.leaseExpiresAt,
        heartbeatAt: action === "release" && active ? null : task.heartbeatAt,
        updateTime: timestamp,
      });
    if (Number(affected || 0) !== 1) {
      throw new BillingError("Relay 视频任务核账终态写入发生竞态", 409);
    }
  });
}

async function convergeBusinessTaskAfterBillingResolution(
  job: BillingReconcileJob,
  action: BillingResolutionAction,
): Promise<void> {
  await convergeUserEnhanceTaskAfterBillingResolution(job, action);
  await convergeRelayVideoTaskAfterBillingResolution(job, action);
}

async function claimBillingReconcileJobs(input: {
  workerId: string;
  limit: number;
  now: number;
  leaseMs: number;
}): Promise<BillingReconcileJob[]> {
  const candidates = await db("o_billing_reconcile_job")
    .where((builder) => {
      builder
        .where((pending) => pending.where({ status: "pending" }).andWhere("nextAttemptAt", "<=", input.now))
        .orWhere((expired) => expired.where({ status: "leased" }).andWhere("leaseExpiresAt", "<=", input.now));
    })
    .orderBy("nextAttemptAt", "asc")
    .limit(Math.max(1, Math.min(input.limit, 100)) * 3);

  const claimed: BillingReconcileJob[] = [];
  for (const row of candidates) {
    if (claimed.length >= input.limit) break;
    const affected = await db("o_billing_reconcile_job")
      .where({ id: row.id })
      .where((builder) => {
        builder
          .where((pending) => pending.where({ status: "pending" }).andWhere("nextAttemptAt", "<=", input.now))
          .orWhere((expired) => expired.where({ status: "leased" }).andWhere("leaseExpiresAt", "<=", input.now));
      })
      .update({
        status: "leased",
        leaseOwner: input.workerId,
        leaseExpiresAt: input.now + input.leaseMs,
        attempts: db.raw("COALESCE(attempts, 0) + 1"),
        updateTime: input.now,
      });
    if (Number(affected || 0) !== 1) continue;
    const claimedRow = await db("o_billing_reconcile_job").where({ id: row.id }).first();
    if (claimedRow) claimed.push(formatJob(claimedRow));
  }
  return claimed;
}

async function finishJob(
  job: BillingReconcileJob,
  workerId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const affected = await db("o_billing_reconcile_job")
    .where({ id: job.id, status: "leased", leaseOwner: workerId })
    .update({ ...patch, leaseOwner: null, leaseExpiresAt: null, updateTime: Date.now() });
  if (Number(affected || 0) !== 1) throw new BillingError("核账任务租约已失效", 409);
}

/**
 * Promote a stale post-dispatch reservation to an explicit manual
 * reconciliation state. The upstream outcome is unknowable after a hard
 * process crash, so this path deliberately never charges or releases funds.
 */
async function processDispatchWatchdogJob(job: BillingReconcileJob, workerId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const reservation = await trx("o_billing_ledger")
      .where({ id: job.reservationId, workspaceId: job.workspaceId, type: "freeze" })
      .forUpdate()
      .first();
    // The global billing lock order is relay task (when applicable) -> freeze
    // ledger -> reconciliation job. The watchdog does not mutate a relay task,
    // so it starts at the ledger and only then fences its claimed job.
    const currentJobRow = await trx("o_billing_reconcile_job")
      .where({ id: job.id, status: "leased", leaseOwner: workerId })
      .forUpdate()
      .first();
    if (!currentJobRow || String(currentJobRow.reason) !== "dispatch_watchdog") return;

    const timestamp = Date.now();
    if (!reservation) {
      await trx("o_billing_reconcile_job")
        .where({ id: job.id, status: "leased", leaseOwner: workerId })
        .update({
          status: "manual_required",
          decision: "reservation_missing",
          lastError: "冻结流水不存在",
          leaseOwner: null,
          leaseExpiresAt: null,
          updateTime: timestamp,
        });
      return;
    }
    if (Number(reservation.remainingMicros || 0) <= 0) {
      await trx("o_billing_reconcile_job")
        .where({ id: job.id, status: "leased", leaseOwner: workerId })
        .update({
          status: "resolved",
          decision: "already_finalized",
          lastError: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          resolvedAt: timestamp,
          updateTime: timestamp,
        });
      return;
    }

    const metadata = parseObject(reservation.metadata);
    const usage = reservation.relatedUsageId
      ? await trx("o_usage_record").where({ id: reservation.relatedUsageId }).forUpdate().first()
      : null;
    if (!usage) {
      await trx("o_billing_reconcile_job")
        .where({ id: job.id, status: "leased", leaseOwner: workerId })
        .update({
          status: "manual_required",
          decision: "ledger_invariant_failed",
          lastError: "冻结流水关联的用量记录不存在",
          leaseOwner: null,
          leaseExpiresAt: null,
          updateTime: timestamp,
        });
      return;
    }

    const lifecycleState = String(metadata.billingLifecycleState || "");
    if (lifecycleState !== "dispatch_started" && lifecycleState !== "pending_reconcile") {
      await trx("o_billing_reconcile_job")
        .where({ id: job.id, status: "leased", leaseOwner: workerId })
        .update({
          status: "manual_required",
          decision: "ledger_invariant_failed",
          lastError: `watchdog 发现无效计费生命周期：${lifecycleState || "missing"}`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updateTime: timestamp,
        });
      return;
    }

    const reconcileEvidence = {
      ...metadata,
      billingLifecycleState: "pending_reconcile",
      reconcileReason: "dispatch_watchdog_expired",
      reconcileEvidenceVersion: 1,
      reconcileJobId: job.id,
      watchdogExpiredAt: timestamp,
      actualUnits: Number(usage.units || 0),
      actualCostMicros: Number(usage.costMicros || 0),
    };
    const ledgerUpdated = await trx("o_billing_ledger")
      .where({ id: reservation.id, workspaceId: job.workspaceId, type: "freeze" })
      .where("remainingMicros", ">", 0)
      .update({ metadata: JSON.stringify(reconcileEvidence), updatedAt: timestamp });
    if (Number(ledgerUpdated || 0) !== 1) {
      throw new BillingError("dispatch watchdog 更新冻结流水失败", 409);
    }
    await trx("o_usage_record")
      .where({ id: usage.id })
      .update({ status: "pending_reconcile" });
    const jobUpdated = await trx("o_billing_reconcile_job")
      .where({ id: job.id, status: "leased", leaseOwner: workerId })
      .update({
        status: "manual_required",
        reason: "dispatch_watchdog_expired",
        evidence: JSON.stringify(reconcileEvidence),
        decision: "dispatch_outcome_unknown",
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updateTime: timestamp,
      });
    if (Number(jobUpdated || 0) !== 1) throw new BillingError("dispatch watchdog 核账任务租约已失效", 409);
  });
}

async function hasStoredDefinitiveVideoRejection(job: BillingReconcileJob, reservation: any, usage: any): Promise<boolean> {
  if (job.endpointType !== "video_generation" || !["submit_http_400", "provider_terminal_without_qualified_delivery", "cancel_after_dispatch_without_qualified_delivery"].includes(job.reason)
    || !usage?.taskId || String(reservation?.relatedTaskId) !== String(usage.taskId)
    || String(reservation?.relatedUsageId) !== String(job.usageRecordId)) return false;
  const task = await db("o_relay_task").where({ id: usage.taskId, workspaceId: job.workspaceId, endpointType: "video_generation" }).whereIn("status", ["failed", "cancelled"]).first();
  if (!task || task.provider !== job.provider || (task.channelId || null) !== (job.channelId || null)) return false;
  const payload = parseObject(task.providerPayload), submission = parseObject(payload.submission);
  const rejected = job.reason === "submit_http_400"
    ? isDefinitiveVideoRejection({ provider: task.provider, providerTaskId: task.providerTaskId,
      httpStatus: submission.httpStatus ?? (submission.reconcileReason === "submit_http_400" ? 400 : null), response: payload.response })
    : isDefinitiveVideoTerminalRejection({ provider: task.provider, providerTaskId: task.providerTaskId,
      responseOk: job.evidence.providerResponseOk === true, response: payload.response });
  if (!rejected) return false;
  return !await db("o_media_asset").where({ taskId: task.id, workspaceId: job.workspaceId }).first("id");
}

async function verifiedLegacyVideoSettlement(job: BillingReconcileJob, reservation: any, usage: any): Promise<Record<string, unknown> | null> {
  if (job.reason !== "video_delivery_unverified_after_provider_success" || job.endpointType !== "video_generation"
    || !usage?.taskId || reservation?.relatedTaskId !== usage.taskId || reservation.relatedUsageId !== job.usageRecordId) return null;
  const task = await db("o_relay_task").where({ id: usage.taskId, workspaceId: job.workspaceId, status: "succeeded", endpointType: "video_generation" }).first();
  if (!task || task.provider !== "volcano" || task.provider !== job.provider || task.channelId !== job.channelId) return null;
  const response = parseObject(parseObject(task.providerPayload).response), actualUsage = parseObject(response.usage);
  const metadata = parseObject(reservation.metadata), price = parseObject(metadata.priceSnapshot);
  const tokens = actualUsage.completion_tokens;
  if (!task.providerTaskId || response.id !== task.providerTaskId || response.status !== "succeeded"
    || typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens <= 0 || tokens > Number(usage.units)
    || (actualUsage.total_tokens != null && (typeof actualUsage.total_tokens !== "number" || !Number.isSafeInteger(actualUsage.total_tokens) || actualUsage.total_tokens < tokens))
    || price.fanjinValueVideoPricing || price.unit !== "token" || price.provider !== task.provider || price.model !== task.model
    || !Number.isSafeInteger(price.unitPriceMicros) || Number(price.unitPriceMicros) <= 0
    || !Number.isFinite(Number(price.multiplier)) || Number(price.multiplier) <= 0) return null;
  const rawCost = Math.max(Math.round(tokens * Number(price.unitPriceMicros) * Number(price.multiplier)), Number(price.minimumMicros || 0));
  if (!Number.isSafeInteger(rawCost) || rawCost <= 0) return null;
  const cost = applyGuChargeRounding(rawCost, metadata);
  if (cost > Number(reservation.amountMicros)) return null;
  const evidence = { ...job.evidence, taskId: task.id, settlementEvidenceComplete: true,
    actualCostMicros: cost, actualUnits: tokens, settlementUnit: "token", authoritativeUsagePath: "usage.completion_tokens",
    requestHash: createHash("sha256").update(JSON.stringify([task.id, reservation.id, response.id, tokens, price])).digest("hex"),
    recoveredFrom: job.reason, recoveredAt: Date.now() };
  try { await assertRelayVideoSettlementAllowed({ ...job, evidence }); } catch { return null; }
  return evidence;
}

async function resumeCancelledVideoResultLookup(job: BillingReconcileJob, reservation: any, usage: any): Promise<void> {
  if (!reservation || job.reason !== "cancel_after_dispatch_without_qualified_delivery" || job.provider !== "volcano"
    || Number(reservation?.remainingMicros) <= 0 || usage?.status !== "pending_reconcile"
    || !usage.taskId || reservation.relatedTaskId !== usage.taskId || reservation.relatedUsageId !== usage.id) return;
  const task = await db("o_relay_task").where({ id: usage.taskId, workspaceId: job.workspaceId,
    endpointType: "video_generation", status: "cancelled", provider: job.provider }).first();
  if (!task?.providerTaskId || !task.channelId || task.channelId !== job.channelId) return;
  const payload = parseObject(task.providerPayload);
  // A local cancellation is not evidence that the supplier stopped. Continue
  // querying that exact task, with a durable fence against POST/failover.
  await db("o_relay_task").where({ id: task.id, status: "cancelled", updateTime: task.updateTime })
    .where(builder => builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", Date.now()))
    .update({ status: "running", completedAt: null, errorMessage: null, updateTime: Date.now(),
      providerPayload: JSON.stringify({ ...payload, billingRecovery: {
        mode: "existing_provider_task", providerTaskId: task.providerTaskId,
        reconcileJobId: job.id, originalStatus: "cancelled", startedAt: Date.now(),
      } }) });
}

async function processBillingReconcileJob(job: BillingReconcileJob, workerId: string): Promise<void> {
  if (job.reason === "dispatch_watchdog") {
    await processDispatchWatchdogJob(job, workerId);
    return;
  }
  const reservation = await db("o_billing_ledger")
    .where({ id: job.reservationId, workspaceId: job.workspaceId, type: "freeze" })
    .first();
  if (!reservation) {
    await finishJob(job, workerId, {
      status: "manual_required",
      decision: "reservation_missing",
      lastError: "冻结流水不存在",
    });
    return;
  }

  if (Number(reservation.remainingMicros || 0) <= 0) {
    try {
      const action = await assertBillingResolutionAction(job);
      await convergeBusinessTaskAfterBillingResolution(job, action);
      await finishJob(job, workerId, {
        status: "resolved",
        decision: "already_finalized_business_task_converged",
        lastError: null,
        resolvedAt: Date.now(),
      });
    } catch (error: any) {
      await finishJob(job, workerId, {
        status: "manual_required",
        decision: "business_task_finalization_failed",
        lastError: String(error?.message || error).slice(0, 2000),
      });
    }
    return;
  }

  const usage = reservation.relatedUsageId
    ? await db("o_usage_record").where({ id: reservation.relatedUsageId }).first()
    : null;
  if (!usage || String(usage.status || "") !== "pending_reconcile") {
    await finishJob(job, workerId, {
      status: "manual_required",
      decision: "ledger_invariant_failed",
      lastError: "开放冻结与 pending_reconcile Usage 不一致",
    });
    return;
  }

  const evidence = job.evidence;
  if (await hasStoredDefinitiveVideoRejection(job, reservation, usage)) {
    try {
      await releaseApiTaskReservation({ workspaceId: job.workspaceId, reservationId: job.reservationId,
        requestId: job.requestId, provider: job.provider, channelId: job.channelId,
        idempotencyKey: `video-rejection:${job.reservationId}`, releaseProof: "definitive_not_billable",
        description: "供应商明确拒绝视频提交，自动释放预占",
        metadata: { source: "billing-reconciler", reconcileJobId: job.id },
      });
      await assertBillingResolutionAction(job, "release");
      await convergeBusinessTaskAfterBillingResolution(job, "release");
      await finishJob(job, workerId, { status: "resolved", decision: "auto_released_definitive_video_rejection", lastError: null, resolvedAt: Date.now() });
    } catch (error: any) {
      await finishJob(job, workerId, { status: "pending", nextAttemptAt: Date.now() + Math.min(3_600_000, 5_000 * 2 ** Math.min(10, job.attempts)),
        decision: "definitive_video_rejection_release_pending", lastError: String(error?.message || error).slice(0, 2000) });
    }
    return;
  }
  const actualCostMicros = safeInteger(evidence.actualCostMicros);
  const expiry = parseObject(evidence.nextDayRelease);
  if (job.endpointType === "video_generation" && expiry.policy === VIDEO_RESERVATION_EXPIRY_POLICY
    && Number(expiry.readyAt) <= Date.now()
    && !await db("o_media_asset").where({ taskId: usage.taskId, workspaceId: job.workspaceId, source: "relay_final" }).first("id")) {
    try {
      await releaseApiTaskReservation({ workspaceId: job.workspaceId, reservationId: job.reservationId,
        requestId: job.requestId, provider: job.provider, channelId: job.channelId,
        idempotencyKey: `video-24h-release:${job.reservationId}`, releaseProof: "customer_not_delivered_timeout",
        videoExpiryContext: { jobId: job.id, workerId },
        description: "视频冻结满 24 小时且未交付，自动退回预占，上游费用由平台承担",
        metadata: { source: "billing-reconciler", reconcileJobId: job.id },
      });
      await assertBillingResolutionAction(job, "release");
      await finishJob(job, workerId, { status: "resolved", decision: "auto_released_after_24h", lastError: null, resolvedAt: Date.now() });
    } catch (error: any) {
      await finishJob(job, workerId, { status: "pending", nextAttemptAt: Date.now() + 60_000,
        decision: "next_day_release_retry", lastError: String(error?.message || error).slice(0, 2000) });
    }
    return;
  }
  const actualUnits = safeInteger(evidence.actualUnits);
  const billingKey = String(evidence.billingKey || "").trim();
  const requestHash = String(evidence.requestHash || "").trim();
  const settlementUnit = String(evidence.settlementUnit || usage.unit || "").trim();
  const allowOverage = reservationAllowsSettlementOverage(
    parseObject(reservation.metadata),
    settlementUnit,
  );
  const automaticSettlementReason =
    job.reason === "settlement_failed"
    || (
      job.reason === "video_terminal_settlement_failed"
      && job.endpointType === "video_generation"
      && String(evidence.taskId || "").trim() !== ""
    );
  const mayAutoSettle =
    automaticSettlementReason &&
    evidence.settlementEvidenceComplete === true &&
    actualCostMicros != null &&
    actualUnits != null &&
    (actualCostMicros <= Number(reservation.amountMicros || 0) || allowOverage) &&
    Boolean(billingKey && requestHash && settlementUnit);

  if (!mayAutoSettle) {
    await finishJob(job, workerId, {
      status: "manual_required",
      decision: "insufficient_authoritative_evidence",
      lastError: null,
    });
    return;
  }

  try {
    await assertBillableVideoDeliveryEvidence(job);
    await settleApiTaskReservation({
      workspaceId: job.workspaceId,
      reservationId: job.reservationId,
      actualCostMicros,
      units: actualUnits,
      unit: settlementUnit,
      provider: job.provider,
      channelId: job.channelId,
      requestId: job.requestId,
      idempotencyKey: billingKey,
      description: `billing reconciler: ${job.reason}`,
      metadata: {
        source: "billing-reconciler",
        requestHash,
        reconcileJobId: job.id,
        priceSnapshot: evidence.priceSnapshot || null,
      },
      allowOverage,
    });
    await assertBillingResolutionAction(job, "settle");
    await convergeBusinessTaskAfterBillingResolution(job, "settle");
    await finishJob(job, workerId, {
      status: "resolved",
      decision: "auto_settled_authoritative_evidence",
      lastError: null,
      resolvedAt: Date.now(),
    });
  } catch (error: any) {
    const finalizedAction = await assertBillingResolutionAction(job).catch(() => null);
    if (finalizedAction) {
      const delayMs = Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, job.attempts - 1));
      await finishJob(job, workerId, {
        status: "pending",
        nextAttemptAt: Date.now() + delayMs,
        decision: "billing_finalized_business_task_pending",
        lastError: String(error?.message || error).slice(0, 2000),
      });
      return;
    }
    const maxAttempts = Math.max(1, Number(process.env.FANJIN_BILLING_RECONCILE_MAX_ATTEMPTS || 5));
    if (job.attempts >= maxAttempts || error instanceof BillingError && error.status >= 400 && error.status < 500) {
      await finishJob(job, workerId, {
        status: "manual_required",
        decision: "automatic_settlement_failed",
        lastError: String(error?.message || error).slice(0, 2000),
      });
      return;
    }
    const delayMs = Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, job.attempts - 1));
    await finishJob(job, workerId, {
      status: "pending",
      nextAttemptAt: Date.now() + delayMs,
      decision: null,
      lastError: String(error?.message || error).slice(0, 2000),
    });
  }
}

export async function processBillingReconciliationBatch(input: {
  workerId?: string;
  limit?: number;
  leaseMs?: number;
  now?: number;
} = {}): Promise<{ claimed: number; processed: number }> {
  const workerId = String(input.workerId || `billing-reconcile-${uuid()}`);
  const now = input.now ?? Date.now();
  await prepareExpiredVideoReservations(db, now);
  // Recover legacy terminal holds from stored receipts, or query an existing
  // supplier task after an unconfirmed cancellation. Never repeat a supplier POST.
  const historical = await db("o_billing_reconcile_job").where({ status: "manual_required", endpointType: "video_generation" })
    .whereIn("reason", ["submit_http_400", "provider_terminal_without_qualified_delivery", "cancel_after_dispatch_without_qualified_delivery", "video_delivery_unverified_after_provider_success"])
    .whereIn("decision", ["insufficient_authoritative_evidence", "automatic_settlement_failed"])
    .orderBy("updateTime", "desc").limit(100);
  for (const row of historical) {
    const job = formatJob(row);
    const reservation = await db("o_billing_ledger").where({ id: job.reservationId, workspaceId: job.workspaceId, type: "freeze" }).first();
    const usage = job.usageRecordId ? await db("o_usage_record").where({ id: job.usageRecordId, workspaceId: job.workspaceId }).first() : null;
    const settlementEvidence = await verifiedLegacyVideoSettlement(job, reservation, usage);
    if (settlementEvidence) {
      await db("o_billing_reconcile_job").where({ id: job.id, status: "manual_required", updateTime: row.updateTime })
        .update({ status: "pending", reason: "video_terminal_settlement_failed", evidence: JSON.stringify(settlementEvidence), nextAttemptAt: now, updateTime: now });
      continue;
    }
    if (!await hasStoredDefinitiveVideoRejection(job, reservation, usage)) {
      await resumeCancelledVideoResultLookup(job, reservation, usage);
      continue;
    }
    await db("o_billing_reconcile_job").where({ id: job.id, status: "manual_required", updateTime: row.updateTime })
      .update({ status: "pending", nextAttemptAt: now, decision: "stored_video_rejection_recovered", updateTime: now });
  }
  const jobs = await claimBillingReconcileJobs({
    workerId,
    limit: Math.max(1, Math.min(Number(input.limit || 20), 100)),
    now,
    leaseMs: Math.max(10_000, Number(input.leaseMs || 60_000)),
  });
  let processed = 0;
  for (const job of jobs) {
    await processBillingReconcileJob(job, workerId);
    processed += 1;
  }
  return { claimed: jobs.length, processed };
}

export async function reconcileExpiredApiKeyQuotaReservations(input: {
  now?: number;
  limit?: number;
} = {}): Promise<{ processed: number; consumed: number; released: number; manualRequired: number }> {
  const now = input.now ?? Date.now();
  const rows = await db("o_api_key_quota_reservation")
    .where({ status: "reserved" })
    .andWhere("expiresAt", "<=", now)
    .orderBy("expiresAt", "asc")
    .limit(Math.max(1, Math.min(Number(input.limit || 100), 500)));
  let consumed = 0;
  let released = 0;
  let manualRequired = 0;

  for (const candidate of rows) {
    const outcome = await db.transaction(async (trx) => {
      const reservation = await trx("o_api_key_quota_reservation")
        .where({ id: candidate.id, status: "reserved" })
        .first();
      if (!reservation) return "skipped" as const;
      const billingLedger = await trx("o_billing_ledger")
        .where({ apiKeyId: reservation.apiKeyId, requestId: reservation.requestId, type: "freeze" })
        .orderBy("createdAt", "desc")
        .first();
      const billingMetadata = parseObject(billingLedger?.metadata);
      const usage = billingLedger?.relatedUsageId
        ? await trx("o_usage_record").where({ id: billingLedger.relatedUsageId }).first()
        : null;
      const evidenceDecision = decideApiKeyQuotaCompletion({
        httpSucceeded: false,
        hasFreeze: Boolean(billingLedger),
        billingLifecycleState: String(billingMetadata.billingLifecycleState || ""),
        usageStatus: usage?.status == null ? null : String(usage.status),
      });
      // This path only handles reservations whose full safety TTL elapsed, so
      // an otherwise ambiguous pre-dispatch freeze is now safe to release.
      const decision = evidenceDecision === "deferred" ? "released" : evidenceDecision;
      const units = Math.max(1, Math.floor(Number(reservation.units) || 1));
      const claimed = await trx("o_api_key_quota_reservation")
        .where({ id: reservation.id, status: "reserved" })
        .update({ status: decision, updateTime: now });
      if (Number(claimed || 0) !== 1) return "skipped" as const;
      const keyUpdated = await trx("o_api_key")
        .where({ id: reservation.apiKeyId })
        .whereRaw("COALESCE(??, 0) >= ?", ["quotaReserved", units])
        .update({
          quotaReserved: trx.raw("COALESCE(??, 0) - ?", ["quotaReserved", units]),
          quotaUsed: decision === "consumed"
            ? trx.raw("COALESCE(??, 0) + ?", ["quotaUsed", units])
            : trx.raw("COALESCE(??, 0)", ["quotaUsed"]),
          updateTime: now,
        });
      if (Number(keyUpdated || 0) !== 1) {
        await trx("o_api_key_quota_reservation")
          .where({ id: reservation.id, status: decision })
          .update({ status: "manual_required", updateTime: now });
        return "manual_required" as const;
      }
      return decision;
    });
    if (outcome === "consumed") consumed += 1;
    if (outcome === "released") released += 1;
    if (outcome === "manual_required") manualRequired += 1;
  }

  return { processed: consumed + released + manualRequired, consumed, released, manualRequired };
}

export async function listBillingReconciliationJobs(input: {
  workspaceId?: string | null;
  status?: BillingReconcileJobStatus | null;
  limit?: number;
} = {}): Promise<BillingReconcileJob[]> {
  const transactionConfig = isPostgresClient(db)
    ? { isolationLevel: "repeatable read" as const, readOnly: true }
    : undefined;
  return db.transaction(async (trx) => {
    const query = trx("o_billing_reconcile_job");
    if (input.workspaceId) query.where({ workspaceId: input.workspaceId });
    if (input.status) query.where({ status: input.status });
    const rows = await query
      .orderBy("createTime", "desc")
      .limit(Math.max(1, Math.min(Number(input.limit || 100), 500)));
    const jobs = rows.map(formatJob);
    if (!jobs.length) return jobs;

    const reservationIds = [...new Set(jobs.map((job) => job.reservationId).filter(Boolean))];
    const usageRecordIds = [...new Set(jobs.map((job) => job.usageRecordId).filter((id): id is string => Boolean(id)))];
    const reservationRows = await trx("o_billing_ledger").whereIn("id", reservationIds);
    const usageRows = usageRecordIds.length
      ? await trx("o_usage_record").whereIn("id", usageRecordIds)
      : [];
    const relatedLedgerRows = await trx("o_billing_ledger")
      .whereIn("relatedLedgerId", reservationIds)
      .whereIn("type", ["deduct", "release"])
      .orderBy("createdAt", "asc");
    const reservationsById = new Map(
      reservationRows.map((row: any) => [String(row.id), row]),
    );
    const usagesById = new Map(
      usageRows.map((row: any) => [String(row.id), row]),
    );
    const relatedByReservationId = new Map<string, any[]>();
    for (const row of relatedLedgerRows) {
      const reservationId = String(row.relatedLedgerId || "");
      const current = relatedByReservationId.get(reservationId) || [];
      current.push(row);
      relatedByReservationId.set(reservationId, current);
    }

    return jobs.map((job) => {
      const reservation = reservationsById.get(job.reservationId) || null;
      const usage = job.usageRecordId
        ? usagesById.get(job.usageRecordId) || null
        : null;
      const relatedLedgers = (relatedByReservationId.get(job.reservationId) || [])
        .map((row: any) => ({
          id: String(row.id),
          type: String(row.type) as "deduct" | "release",
          status: String(row.status || "succeeded"),
          amountMicros: Number(row.amountMicros || 0),
        }));
      return {
        ...job,
        billingProjection: {
          reservation: reservation
            ? {
                id: String(reservation.id),
                status: String(reservation.status || "frozen"),
                amountMicros: Number(reservation.amountMicros || 0),
                remainingMicros: Number(reservation.remainingMicros || 0),
              }
            : null,
          usage: usage
            ? {
                id: String(usage.id),
                status: String(usage.status || "unknown"),
                costMicros: Number(usage.costMicros || 0),
                units: Number(usage.units || 0),
                unit: String(usage.unit || "task"),
              }
            : null,
          relatedLedgers,
          deductedMicros: relatedLedgers
            .filter((ledger) => ledger.type === "deduct")
            .reduce((total, ledger) => total + ledger.amountMicros, 0),
          releasedMicros: relatedLedgers
            .filter((ledger) => ledger.type === "release")
            .reduce((total, ledger) => total + ledger.amountMicros, 0),
        },
      };
    });
  }, transactionConfig);
}

type ManualBillingResolutionAction =
  | "settle"
  | "release"
  | "platform_absorb_release";

type NormalizedManualSettlement = {
  actualCostMicros: number | null;
  units: number | null;
  unit: string;
} | null;

function canonicalEvidence(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value)
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEvidence).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => (
        `${JSON.stringify(key)}:${canonicalEvidence(record[key])}`
      ))
      .join(",")}}`;
  }
  return "undefined";
}

async function assertResolvedManualEvidence(
  job: BillingReconcileJob,
  action: ManualBillingResolutionAction,
  normalizedSettlement: NormalizedManualSettlement,
): Promise<void> {
  const manualResolution = parseObject(job.evidence.manualResolution);
  const manualResolvedAt = safeInteger(manualResolution.resolvedAt);
  const expectedBillingAction: BillingResolutionAction =
    action === "settle" ? "settle" : "release";
  if (
    job.status !== "resolved"
    || String(manualResolution.action || "") !== action
    || !String(manualResolution.resolutionNote || "").trim()
    || manualResolvedAt == null
    || manualResolvedAt <= 0
    || job.resolvedAt !== manualResolvedAt
  ) {
    throw new BillingError(
      "核账任务终态缺少完整的人工决策凭证，不能作为幂等成功返回",
      409,
    );
  }
  if (
    action === "settle"
    && (
      !normalizedSettlement
      || Number(manualResolution.actualCostMicros)
        !== normalizedSettlement.actualCostMicros
      || Number(manualResolution.units) !== normalizedSettlement.units
      || String(manualResolution.unit || "") !== normalizedSettlement.unit
    )
  ) {
    throw new BillingError(
      "核账任务终态与本次人工结算参数不一致",
      409,
    );
  }
  await assertBillingResolutionAction(job, expectedBillingAction);
  if (action !== "platform_absorb_release") return;

  const [reservation, relatedLedgers] = await Promise.all([
    db("o_billing_ledger")
      .where({
        id: job.reservationId,
        workspaceId: job.workspaceId,
        type: "freeze",
      })
      .first(),
    db("o_billing_ledger")
      .where({
        workspaceId: job.workspaceId,
        relatedLedgerId: job.reservationId,
      })
      .whereIn("type", ["deduct", "release"]),
  ]);
  const releases = relatedLedgers.filter(
    (ledger: any) => String(ledger.type || "") === "release",
  );
  const deducts = relatedLedgers.filter(
    (ledger: any) => String(ledger.type || "") === "deduct",
  );
  const releaseMetadata = parseObject(releases[0]?.metadata);
  const releaseAbsorption = parseObject(
    releaseMetadata.platformAbsorption,
  );
  const jobAbsorption = parseObject(
    manualResolution.platformAbsorption,
  );
  const amountMicros = Number(reservation?.amountMicros || 0);
  const imageAbsorptionV1 = Boolean(
    job.endpointType === "image_generation"
    && [
      "image_upstream_count_mismatch",
      "image_upstream_outcome_unknown",
    ].includes(job.reason)
    && releaseAbsorption.contractVersion
      === "billing-platform-absorption.v1"
    && String(releaseAbsorption.reason || "") === job.reason,
  );
  const videoAbsorptionV2 = Boolean(
    job.endpointType === "video_generation"
    && job.reason === "submit_http_400"
    && releaseAbsorption.contractVersion
      === "billing-platform-absorption.v2"
    && releaseAbsorption.incidentContract
      === "video-submit-http-400-no-provider-task-no-delivery.v1",
  );
  const scriptAbsorption = job.endpointType === "text" && job.reason === "chat_upstream_outcome_unknown"
    && releaseAbsorption.contractVersion === SCRIPT_ASSET_ABSORPTION_CONTRACT
    && Boolean(releaseAbsorption.commandId);
  if (
    !reservation
    || amountMicros <= 0
    || Number(reservation.remainingMicros || 0) !== 0
    || releases.length !== 1
    || deducts.length !== 0
    || Number(releases[0].amountMicros || 0) !== amountMicros
    || String(releaseMetadata.releaseProof || "")
      !== "customer_not_delivered_platform_absorbed"
    || (!imageAbsorptionV1 && !videoAbsorptionV2 && !scriptAbsorption)
    || Number(releaseAbsorption.customerChargeMicros) !== 0
    || releaseAbsorption.customerDeliveryStatus !== "none"
    || releaseAbsorption.providerBillingStatus !== "possible_not_confirmed"
    || Number(releaseAbsorption.maximumProviderExposureMicros)
      !== amountMicros
    || Number(releaseAbsorption.customerReleaseMicros) !== amountMicros
    || canonicalEvidence(jobAbsorption)
      !== canonicalEvidence(releaseAbsorption)
  ) {
    throw new BillingError(
      "平台承担终态缺少与释放流水完全一致的不可变损失凭证",
      409,
    );
  }
}

export async function manuallyResolveBillingReconciliationJob(input: {
  jobId: string;
  action: ManualBillingResolutionAction;
  actualCostMicros?: number;
  units?: number;
  unit?: string;
  resolutionNote: string;
  operatorUserId?: number | null;
  scriptAssetCommandId?: string;
  /**
   * Internal one-shot fence. Deliberately absent from the admin HTTP schema;
   * required for the isolated video submit-HTTP400 platform absorption path.
   */
  videoSubmitHttp400AbsorptionFence?:
    VideoSubmitHttp400PlatformAbsorptionFence;
  /**
   * Test-only fault injection at the exact boundary after money/business state
   * has converged but before the reconciliation job terminal CAS.
   */
  testOnlyBeforeFinalJobCas?: (context: {
    jobId: string;
    resolverId: string;
    resolutionEvidence: Record<string, unknown>;
  }) => Promise<void>;
}): Promise<BillingReconcileJob> {
  if (
    input.testOnlyBeforeFinalJobCas
    && String(process.env.NODE_ENV || "").toLowerCase() !== "test"
  ) {
    throw new BillingError("核账故障注入仅允许测试环境使用", 500);
  }
  const note = String(input.resolutionNote || "").trim();
  if (!note) throw new BillingError("人工核账必须填写 resolutionNote", 400);
  const normalizedSettlement = input.action === "settle"
    ? {
        actualCostMicros: safeInteger(input.actualCostMicros),
        units: safeInteger(input.units),
        unit: String(input.unit || "").trim(),
      }
    : null;
  if (input.action === "settle") {
    if (
      normalizedSettlement?.actualCostMicros == null ||
      normalizedSettlement.units == null ||
      !normalizedSettlement.unit
    ) {
      throw new BillingError("人工结算必须提供有效的 actualCostMicros、units 和 unit", 400);
    }
  }

  const initialRow = await db("o_billing_reconcile_job").where({ id: input.jobId }).first();
  if (!initialRow) throw new BillingError("核账任务不存在", 404);
  const initialJob = formatJob(initialRow);
  const requestedCount = Number(initialJob.evidence.requestedCount);
  const validReturnedCount = Number(initialJob.evidence.validReturnedCount);
  const hasObservedPartialImageResult =
    initialJob.endpointType === "image_generation"
    && initialJob.reason === "image_upstream_count_mismatch"
    && Number.isSafeInteger(requestedCount)
    && Number.isSafeInteger(validReturnedCount)
    && validReturnedCount > 0
    && validReturnedCount < requestedCount;
  const hasUnknownImageOutcome =
    initialJob.endpointType === "image_generation"
    && initialJob.reason === "image_upstream_outcome_unknown";
  const hasUnknownTextOutcome = initialJob.endpointType === "text"
    && initialJob.reason === "chat_upstream_outcome_unknown";
  if (input.action === "platform_absorb_release" && hasUnknownTextOutcome && !input.scriptAssetCommandId) {
    throw new BillingError("资产提取的平台承担处理必须指定原提取请求编号", 409);
  }
  const hasUnconfirmedVideoSubmitHttp400 =
    initialJob.endpointType === "video_generation"
    && initialJob.reason === "submit_http_400";
  // Historical jobs may predate the automatic rejection handler. Read the
  // stored provider response; an operator note or HTTP 400 alone is not proof.
  let hasProvenVideoRejection = false;
  if (input.action === "release" && hasUnconfirmedVideoSubmitHttp400 && initialJob.usageRecordId) {
    const usage = await db("o_usage_record").where({ id: initialJob.usageRecordId, workspaceId: initialJob.workspaceId }).first();
    const task = usage?.taskId ? await db("o_relay_task").where({ id: usage.taskId, workspaceId: initialJob.workspaceId, endpointType: "video_generation" }).first() : null;
    const payload = parseObject(task?.providerPayload);
    const submission = parseObject(payload.submission);
    hasProvenVideoRejection = task?.status === "failed" && isDefinitiveVideoRejection({
      provider: task?.provider, providerTaskId: task?.providerTaskId,
      httpStatus: submission.httpStatus ?? (submission.reconcileReason === "submit_http_400" ? 400 : null),
      response: payload.response,
    });
  }
  if (
    input.action === "platform_absorb_release"
    && hasUnconfirmedVideoSubmitHttp400
    && !input.videoSubmitHttp400AbsorptionFence
  ) {
    throw new BillingError(
      "视频提交 HTTP 400 平台承担释放必须使用一次性事故围栏",
      409,
    );
  }
  if (
    input.action === "release"
    && (
      hasObservedPartialImageResult
      || hasUnknownImageOutcome
      || hasUnknownTextOutcome
      || (hasUnconfirmedVideoSubmitHttp400 && !hasProvenVideoRejection)
    )
  ) {
    throw new BillingError(
      "上游可能已经计费，普通未计费释放不适用；只能选择平台承担释放",
      409,
    );
  }
  if (
    input.action === "platform_absorb_release"
    && (
      !(
        initialJob.endpointType === "image_generation"
        && [
          "image_upstream_count_mismatch",
          "image_upstream_outcome_unknown",
        ].includes(initialJob.reason)
      )
      && !hasUnconfirmedVideoSubmitHttp400
      && !hasUnknownTextOutcome
    )
  ) {
    throw new BillingError(
      "平台承担释放仅适用于已登记的无客户交付上游不确定事故",
      409,
    );
  }
  const billingAction: BillingResolutionAction =
    input.action === "settle" ? "settle" : "release";
  const expectedDecision =
    input.action === "settle"
      ? "manual_settlement"
      : input.action === "platform_absorb_release"
        ? "platform_absorb_release"
        : "manual_release_confirmed";
  const pendingBusinessDecision = `${expectedDecision}_business_task_pending`;
  if (initialJob.status === "resolved") {
    if (initialJob.decision === expectedDecision) {
      if (hasUnknownTextOutcome && input.action === "platform_absorb_release"
        && parseObject(parseObject(initialJob.evidence.manualResolution).platformAbsorption).commandId !== input.scriptAssetCommandId) {
        throw new BillingError("资产提取请求编号与既有损失凭证不一致", 409);
      }
      await assertResolvedManualEvidence(
        initialJob,
        input.action,
        normalizedSettlement,
      );
      return initialJob;
    }
    throw new BillingError("核账任务已按不同决策处理，不能覆盖既有终态", 409);
  }
  if (
    initialJob.decision
    && initialJob.decision.endsWith("_business_task_pending")
    && initialJob.decision !== pendingBusinessDecision
  ) {
    throw new BillingError("核账流水已按不同决策完成，只允许重试原业务终态回写", 409);
  }

  const timestamp = Date.now();
  const resolverId = `manual-billing-reconcile-${uuid()}`;
  const claimed = await db("o_billing_reconcile_job")
    .where({ id: input.jobId })
    .where((builder) => {
      builder
        .whereIn("status", ["pending", "manual_required"])
        .orWhere((expired) => expired
          .where({ status: "leased" })
          .andWhere((lease) => lease.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<=", timestamp)));
    })
    .update({
      status: "leased",
      leaseOwner: resolverId,
      leaseExpiresAt: timestamp + 5 * 60_000,
      updateTime: timestamp,
    });
  if (Number(claimed || 0) !== 1) {
    const currentRow = await db("o_billing_reconcile_job").where({ id: input.jobId }).first();
    if (currentRow) {
      const current = formatJob(currentRow);
      if (
        current.status === "resolved"
        && current.decision === expectedDecision
      ) {
        await assertResolvedManualEvidence(
          current,
          input.action,
          normalizedSettlement,
        );
        return current;
      }
      if (current.status === "resolved") {
        throw new BillingError("核账任务已按不同决策处理，不能覆盖既有终态", 409);
      }
    }
    throw new BillingError("核账任务正由其他管理员或 worker 处理", 409);
  }

  const claimedRow = await db("o_billing_reconcile_job")
    .where({ id: input.jobId, status: "leased", leaseOwner: resolverId })
    .first();
  if (!claimedRow) throw new BillingError("人工核账任务租约获取失败", 409);
  const job = formatJob(claimedRow);
  let billingFinalized = false;
  let businessTaskFinalized = false;
  let platformAbsorption: Record<string, unknown> | null = null;
  let resolutionEvidence: Record<string, unknown> | null = null;
  let resolutionResolvedAt: number | null = null;
  try {
    const reservation = await db("o_billing_ledger")
      .where({ id: job.reservationId, workspaceId: job.workspaceId, type: "freeze" })
      .first();
    if (!reservation) throw new BillingError("核账任务关联的冻结流水不存在", 404);
    const allowOverage = reservationAllowsSettlementOverage(
      parseObject(reservation.metadata),
      normalizedSettlement?.unit,
    );
    if (
      normalizedSettlement?.actualCostMicros != null &&
      normalizedSettlement.actualCostMicros > Number(reservation.amountMicros || 0) &&
      !allowOverage
    ) {
      throw new BillingError("该预扣未授权超额结算；人工结算金额不能超过原始预扣", 409);
    }

    const evidence = job.evidence;
    const idempotencyKey = `${String(evidence.billingKey || `manual-reconcile:${job.id}`)}:manual`;
    const resolutionMetadata = {
      source: "manual-billing-reconciliation",
      requestHash: evidence.requestHash || null,
      reconcileJobId: job.id,
      resolutionNote: note,
      operatorUserId: input.operatorUserId ?? null,
    };

    if (Number(reservation.remainingMicros || 0) <= 0) {
      await assertBillingResolutionAction(job, billingAction);
    } else {
      if (input.action === "settle" && normalizedSettlement) {
        await assertBillableVideoDeliveryEvidence(job);
        await settleApiTaskReservation({
          workspaceId: job.workspaceId,
          reservationId: job.reservationId,
          actualCostMicros: normalizedSettlement.actualCostMicros!,
          units: normalizedSettlement.units!,
          unit: normalizedSettlement.unit,
          provider: job.provider,
          channelId: job.channelId,
          requestId: job.requestId,
          idempotencyKey,
          description: `人工核账结算：${note}`,
          metadata: resolutionMetadata,
          operatorUserId: input.operatorUserId ?? null,
          allowOverage,
        });
      } else {
        await releaseApiTaskReservation({
          workspaceId: job.workspaceId,
          reservationId: job.reservationId,
          requestId: job.requestId,
          idempotencyKey,
          provider: job.provider,
          channelId: job.channelId,
          description:
            input.action === "platform_absorb_release"
              ? `客户未获得生成交付，平台承担潜在上游成本并释放：${note}`
              : `人工确认供应商未计费后释放：${note}`,
          releaseProof:
            input.action === "platform_absorb_release"
              ? "customer_not_delivered_platform_absorbed"
              : "definitive_not_billable",
          metadata: resolutionMetadata,
          operatorUserId: input.operatorUserId ?? null,
          scriptAssetCommandId: input.scriptAssetCommandId,
          videoSubmitHttp400AbsorptionFence:
            input.videoSubmitHttp400AbsorptionFence,
        });
      }
    }
    await assertBillingResolutionAction(job, billingAction);
    billingFinalized = true;
    if (input.action === "platform_absorb_release") {
      const releaseLedger = await db("o_billing_ledger")
        .where({
          workspaceId: job.workspaceId,
          relatedLedgerId: job.reservationId,
          type: "release",
        })
        .orderBy("createdAt", "desc")
        .first();
      platformAbsorption = parseObject(
        parseObject(releaseLedger?.metadata).platformAbsorption,
      );
      const imageAbsorptionV1 = Boolean(
        job.endpointType === "image_generation"
        && platformAbsorption.contractVersion
          === "billing-platform-absorption.v1"
        && String(platformAbsorption.reason || "") === job.reason,
      );
      const videoAbsorptionV2 = Boolean(
        job.endpointType === "video_generation"
        && job.reason === "submit_http_400"
        && platformAbsorption.contractVersion
          === "billing-platform-absorption.v2"
        && platformAbsorption.incidentContract
          === "video-submit-http-400-no-provider-task-no-delivery.v1",
      );
      const scriptAbsorption = job.endpointType === "text" && job.reason === "chat_upstream_outcome_unknown"
        && platformAbsorption.contractVersion === SCRIPT_ASSET_ABSORPTION_CONTRACT
        && platformAbsorption.commandId === input.scriptAssetCommandId;
      if (!imageAbsorptionV1 && !videoAbsorptionV2 && !scriptAbsorption) {
        throw new BillingError("平台承担释放缺少不可变损失凭证", 409);
      }
    }
    await convergeBusinessTaskAfterBillingResolution(job, billingAction);
    businessTaskFinalized = true;

    resolutionResolvedAt = Date.now();
    resolutionEvidence = {
      ...evidence,
      manualResolution: {
        action: input.action,
        ...(normalizedSettlement || {}),
        resolutionNote: note,
        operatorUserId: input.operatorUserId ?? null,
        resolvedAt: resolutionResolvedAt,
        ...(platformAbsorption ? { platformAbsorption } : {}),
      },
    };
    if (input.testOnlyBeforeFinalJobCas) {
      await input.testOnlyBeforeFinalJobCas({
        jobId: job.id,
        resolverId,
        resolutionEvidence,
      });
    }
    const updatedCount = await db("o_billing_reconcile_job")
      .where({ id: job.id, status: "leased", leaseOwner: resolverId })
      .update({
        status: "resolved",
        decision: expectedDecision,
        evidence: JSON.stringify(resolutionEvidence),
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        resolvedAt: resolutionResolvedAt,
        updateTime: resolutionResolvedAt,
      });
    if (Number(updatedCount || 0) !== 1) throw new BillingError("人工核账任务租约已失效", 409);
  } catch (error: any) {
    const failureTime = Date.now();
    if (billingFinalized && businessTaskFinalized) {
      if (!resolutionEvidence || resolutionResolvedAt == null) {
        throw new BillingError(
          "人工核账资金已终结，但完整终态凭证尚未构造，结果未知",
          409,
        );
      }
      // A transient error before the terminal CAS may be recovered only while
      // this exact resolver still owns the lease. Never overwrite a successor
      // resolver's lease or synthesize a terminal row without full evidence.
      const recovered = await db("o_billing_reconcile_job")
        .where({
          id: job.id,
          status: "leased",
          leaseOwner: resolverId,
        })
        .update({
          status: "resolved",
          decision: expectedDecision,
          evidence: JSON.stringify(resolutionEvidence),
          lastError: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          resolvedAt: resolutionResolvedAt,
          updateTime: resolutionResolvedAt,
        });
      if (Number(recovered || 0) !== 1) {
        const currentRow = await db("o_billing_reconcile_job")
          .where({ id: job.id })
          .first();
        if (currentRow) {
          const current = formatJob(currentRow);
          if (
            current.status === "resolved"
            && current.decision === expectedDecision
          ) {
            await assertResolvedManualEvidence(
              current,
              input.action,
              normalizedSettlement,
            );
            return current;
          }
        }
        throw new BillingError(
          "人工核账资金已终结，但终态租约已变化；结果未知，未覆盖其他处理者",
          409,
        );
      }
    } else if (billingFinalized) {
      // Monetary state is immutable now, but the owning business task is not.
      // Keep the job retryable and fence retries to this exact action.
      await db("o_billing_reconcile_job")
        .where({ id: job.id, status: "leased", leaseOwner: resolverId })
        .update({
          status: "manual_required",
          decision: pendingBusinessDecision,
          lastError: String(error?.message || error).slice(0, 2000),
          leaseOwner: null,
          leaseExpiresAt: null,
          updateTime: failureTime,
        });
    } else {
      await db("o_billing_reconcile_job")
        .where({ id: job.id, status: "leased", leaseOwner: resolverId })
        .update({
          status: "manual_required",
          decision: "manual_resolution_failed",
          lastError: String(error?.message || error).slice(0, 2000),
          leaseOwner: null,
          leaseExpiresAt: null,
          updateTime: failureTime,
        });
    }
    if (!billingFinalized || !businessTaskFinalized) throw error;
  }

  const updated = await db("o_billing_reconcile_job").where({ id: job.id }).first();
  if (!updated) throw new BillingError("核账任务更新失败", 500);
  const formatted = formatJob(updated);
  await assertResolvedManualEvidence(
    formatted,
    input.action,
    normalizedSettlement,
  );
  return formatted;
}

let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationRunning = false;

export function startBillingReconciliationWorker(): void {
  if (reconciliationTimer || process.env.FANJIN_DISABLE_BILLING_RECONCILER === "1") return;
  const workerId = `billing-reconcile-${process.pid}-${uuid()}`;
  const intervalMs = Math.max(5_000, Number(process.env.FANJIN_BILLING_RECONCILE_INTERVAL_MS || 30_000));
  const run = async () => {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
      await reconcileExpiredApiKeyQuotaReservations();
      await processBillingReconciliationBatch({ workerId });
    } catch (error: any) {
      console.warn("[billing-reconciler] batch failed", error?.message || error);
    } finally {
      reconciliationRunning = false;
    }
  };
  void run();
  reconciliationTimer = setInterval(run, intervalMs);
  reconciliationTimer.unref?.();
}

export async function stopBillingReconciliationWorker(): Promise<void> {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = null;
  while (reconciliationRunning) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
