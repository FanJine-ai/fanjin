import type { Knex } from "knex";
import type { BillingLedger, UsageRecord } from "./billing";
import { isPostgresClient } from "./dbDialect";

export const VIDEO_RESERVATION_EXPIRY_POLICY = "video-reservation-24h-platform-absorption/v1";
export const VIDEO_RESERVATION_MAX_HOLD_MS = 24 * 60 * 60_000;
export const VIDEO_RESERVATION_RECHECK_MS = 60_000;
export const VIDEO_RESERVATION_EXPIRED_MESSAGE = "任务未能完成交付，冻结已满 24 小时，预占额度已自动退回；可能的上游费用由平台承担，不会再次自动扣款。";

function object(value: unknown): Record<string, any> {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Reuse the Relay worker for a final GET-only check before the refund deadline.
 * This is durable across process restarts and never creates a supplier task.
 */
export async function prepareExpiredVideoReservations(database: Knex, now = Date.now()): Promise<void> {
  const rows = await database("o_billing_reconcile_job as j")
    .join("o_billing_ledger as f", "f.id", "j.reservationId")
    .join("o_usage_record as u", "u.id", "j.usageRecordId")
    .where("j.endpointType", "video_generation").whereIn("j.status", ["pending", "manual_required"])
    .where({ "f.type": "freeze", "u.status": "pending_reconcile" })
    .where("f.remainingMicros", ">", 0).where("f.createdAt", "<=", now - VIDEO_RESERVATION_MAX_HOLD_MS)
    .orderBy("f.createdAt", "asc").limit(100)
    .select("j.id", "j.workspaceId", "j.reservationId", "j.usageRecordId", "u.taskId");
  for (const row of rows) {
    if (!row.taskId) continue;
    await database.transaction(async trx => {
      const query = trx("o_relay_task").where({ id: row.taskId, workspaceId: row.workspaceId, endpointType: "video_generation" });
      if (isPostgresClient(trx)) query.forUpdate();
      const task = await query.first();
      if (!task || task.status === "succeeded" || Number(task.leaseExpiresAt || 0) > now) return;
      const job = await trx("o_billing_reconcile_job").where({ id: row.id }).first();
      if (!job || !["pending", "manual_required"].includes(job.status)) return;
      const freeze = await trx("o_billing_ledger").where({ id: row.reservationId, workspaceId: row.workspaceId }).first();
      if (!freeze || freeze.relatedTaskId !== task.id || freeze.relatedUsageId !== row.usageRecordId
        || Number(freeze.remainingMicros) !== Number(freeze.amountMicros) || Number(freeze.remainingMicros) <= 0) return;
      if (await trx("o_media_asset").where({ taskId: task.id, workspaceId: row.workspaceId, source: "relay_final" }).first("id")) return;
      const evidence = object(job.evidence), previous = object(evidence.nextDayRelease);
      const dueAt = Number(freeze.createdAt) + VIDEO_RESERVATION_MAX_HOLD_MS;
      const check = previous.policy === VIDEO_RESERVATION_EXPIRY_POLICY ? previous : {
        policy: VIDEO_RESERVATION_EXPIRY_POLICY, taskId: task.id, dueAt, checkStartedAt: now,
        readyAt: now + (task.providerTaskId ? VIDEO_RESERVATION_RECHECK_MS : 0),
        lookup: task.providerTaskId ? "existing_provider_task_only" : "no_provider_task_id",
      };
      if (previous.policy !== VIDEO_RESERVATION_EXPIRY_POLICY && task.providerTaskId) {
        const payload = object(task.providerPayload);
        await trx("o_relay_task").where({ id: task.id, updateTime: task.updateTime }).update({
          status: "running", completedAt: null, updateTime: now,
          providerPayload: JSON.stringify({ ...payload, poll: null, billingRecovery: {
            mode: "existing_provider_task", providerTaskId: task.providerTaskId,
            reconcileJobId: job.id, originalStatus: task.status, startedAt: now, purpose: "next_day_release_check",
          } }),
        });
      }
      await trx("o_billing_reconcile_job").where({ id: job.id, status: job.status, updateTime: job.updateTime }).update({
        evidence: JSON.stringify({ ...evidence, nextDayRelease: check }),
        status: now >= Number(check.readyAt) ? "pending" : "manual_required",
        decision: "next_day_release_check", nextAttemptAt: Number(check.readyAt), updateTime: now,
      });
    });
  }
}

/** Validate policy, ownership, deadline and absence of delivery under the same
 * task lock as finalization. All task/ledger/job changes commit with the refund.
 */
export async function buildVideoExpiryAbsorption(input: {
  transaction: Knex.Transaction; reservation: BillingLedger; usage: UsageRecord;
  jobId: string; workerId: string; fail: (message: string, status: number) => Error;
}): Promise<Record<string, unknown>> {
  const { transaction: trx, reservation, usage, fail } = input;
  const now = Date.now(), workspaceId = reservation.workspaceId;
  const query = trx("o_relay_task").where({ id: usage.taskId || "", workspaceId, endpointType: "video_generation" });
  if (isPostgresClient(trx)) query.forUpdate();
  const task = await query.first();
  const freezeQuery = trx("o_billing_ledger").where({ id: reservation.id, workspaceId, type: "freeze" });
  if (isPostgresClient(trx)) freezeQuery.forUpdate();
  const freeze = await freezeQuery.first();
  const jobQuery = trx("o_billing_reconcile_job").where({ id: input.jobId, workspaceId,
    reservationId: reservation.id, usageRecordId: usage.id, endpointType: "video_generation" });
  if (isPostgresClient(trx)) jobQuery.forUpdate();
  const job = await jobQuery.first();
  const checkpoint = object(object(job?.evidence).nextDayRelease);
  const dueAt = Number(freeze?.createdAt) + VIDEO_RESERVATION_MAX_HOLD_MS;
  if (!task || !["failed", "cancelled", "running", "queued", "enhancing"].includes(task.status)
    || Number(task.leaseExpiresAt || 0) > now || !freeze || Number(freeze.amountMicros) <= 0
    || Number(freeze.remainingMicros) !== Number(freeze.amountMicros)
    || freeze.relatedTaskId !== task.id || reservation.taskId !== task.id || usage.taskId !== task.id
    || freeze.relatedUsageId !== usage.id || usage.workspaceId !== workspaceId
    || usage.endpointType !== "video_generation" || usage.status !== "pending_reconcile"
    || task.provider !== usage.provider || (task.channelId || null) !== (usage.channelId || null)
    || !Number.isSafeInteger(Number(freeze.createdAt)) || Number(freeze.createdAt) <= 0 || now < dueAt
    || !job || job.status !== "leased" || job.leaseOwner !== input.workerId || Number(job.leaseExpiresAt) <= now
    || job.provider !== task.provider || (job.channelId || null) !== (task.channelId || null)
    || checkpoint.policy !== VIDEO_RESERVATION_EXPIRY_POLICY || checkpoint.taskId !== task.id
    || checkpoint.dueAt !== dueAt || !Number.isSafeInteger(checkpoint.checkStartedAt) || checkpoint.checkStartedAt < dueAt
    || !Number.isSafeInteger(checkpoint.readyAt) || checkpoint.readyAt < checkpoint.checkStartedAt
    || now < checkpoint.readyAt
    || (task.providerTaskId && checkpoint.readyAt < checkpoint.checkStartedAt + VIDEO_RESERVATION_RECHECK_MS)) {
    throw fail("视频冻结尚未满足 24 小时无交付自动退款条件", 409);
  }
  if (await trx("o_media_asset").where({ taskId: task.id, workspaceId, source: "relay_final" }).first("id")
    || await trx("o_billing_ledger").where({ relatedLedgerId: reservation.id, workspaceId }).whereIn("type", ["deduct", "release"]).first("id")) {
    throw fail("任务已有交付或账务已处理，禁止超时退款", 409);
  }
  const absorption = { contractVersion: VIDEO_RESERVATION_EXPIRY_POLICY,
    reason: job.reason, taskId: task.id, providerTaskId: task.providerTaskId || null,
    reservationCreatedAt: Number(freeze.createdAt), dueAt, releasedAt: now,
    customerDeliveryStatus: "none", customerChargeMicros: 0, customerReleaseMicros: reservation.amountMicros,
    providerBillingStatus: "possible_not_confirmed", maximumProviderExposureMicros: reservation.amountMicros,
    estimateBasis: "reserved_customer_amount_proxy_not_confirmed_provider_cost", providerFollowupRequired: true,
    noAutomaticCustomerRecapture: true, check: checkpoint };
  const payload = object(task.providerPayload);
  await trx("o_relay_task").where({ id: task.id, updateTime: task.updateTime }).update({
    status: "failed", costMicros: 0, completedAt: now, updateTime: now,
    leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, errorMessage: VIDEO_RESERVATION_EXPIRED_MESSAGE,
    providerPayload: JSON.stringify({ ...payload, poll: null,
      submission: { ...object(payload.submission), state: "released", billingFinalizedAt: now, retryAllowed: false },
      customerSettlement: absorption }),
  });
  await trx("o_billing_ledger").where({ id: reservation.id }).update({
    metadata: JSON.stringify({ ...object(freeze.metadata), customerSettlementFinal: VIDEO_RESERVATION_EXPIRY_POLICY }), updatedAt: now,
  });
  await trx("o_billing_reconcile_job").where({ id: job.id, leaseOwner: input.workerId }).update({
    evidence: JSON.stringify({ ...object(job.evidence), platformAbsorption: absorption }), updateTime: now,
  });
  return absorption;
}
