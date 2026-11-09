import type { Knex } from "knex";
import type { BillingLedger, UsageRecord } from "./billing";
import { isPostgresClient } from "./dbDialect";
import { scriptAssetExtractionBillingIdentity } from "./scriptAssetExtraction";

export const SCRIPT_ASSET_ABSORPTION_CONTRACT = "billing-platform-absorption.script-assets.v1";

function object(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Atomically fence a lost text extraction before releasing its exact reserve.
 * A timeout is not evidence of zero provider cost. No proposal may have been
 * delivered, and the loss is explicitly retained for later provider billing.
 */
export async function buildScriptAssetPlatformAbsorption(input: {
  transaction: Knex.Transaction;
  reservation: BillingLedger;
  usage: UsageRecord;
  commandId?: string;
  operatorUserId?: number | null;
  reconcileJobId: string;
  fail: (message: string, status: number) => Error;
}): Promise<Record<string, unknown>> {
  const { transaction: trx, reservation, usage, fail } = input;
  const workspaceId = reservation.workspaceId;
  const operator = input.operatorUserId
    ? await trx("o_user").where({ id: input.operatorUserId }).first() : null;
  if (!operator || !["root", "admin", "super_admin"].includes(String(operator.role))) {
    throw fail("只有平台管理员可以承担资产提取的上游不确定成本", 403);
  }
  let query = trx("o_agent_idempotency").where({
    id: input.commandId || "", workspaceId, resourceType: "project",
  }).first();
  if (isPostgresClient(trx)) query = query.forUpdate();
  const command = await query;
  const checkpoint = object(command?.responseBody);
  const metadata = reservation.metadata || {};
  const identity = scriptAssetExtractionBillingIdentity({
    workspaceId, actorUserId: Number(command?.actorUserId),
    commandId: String(command?.id || ""), attempt: Number(checkpoint.attempt),
  });
  const job = await trx("o_billing_reconcile_job").where({
    id: input.reconcileJobId, workspaceId, reservationId: reservation.id,
    usageRecordId: usage.id, endpointType: "text", reason: "chat_upstream_outcome_unknown",
  }).first();
  const channel = usage.channelId
    ? await trx("o_provider_channel").where({ id: usage.channelId }).first() : null;
  const dispatchStartedAt = Number(metadata.dispatchStartedAt);
  const safeAfter = dispatchStartedAt + Math.max(15 * 60_000, Number(channel?.timeoutMs || 0) + 60_000);
  const related = await trx("o_billing_ledger")
    .where({ workspaceId, relatedLedgerId: reservation.id }).whereIn("type", ["deduct", "release"]);
  if (!command || command.status !== "checkpointed" || command.responseStatus != null
    || command.scopeKey !== `script:asset-extraction:proposal:${workspaceId}:${Number(command.actorUserId)}`
    || checkpoint.phase !== "dispatching" || checkpoint.storedProposal || checkpoint.recoveryTargetId
    || String(checkpoint.projectId) !== String(command.resourceId)
    || !Array.isArray(checkpoint.scripts) || !checkpoint.scripts.length
    || !Number.isSafeInteger(checkpoint.attempt) || checkpoint.attempt < 0
    || !Number.isSafeInteger(checkpoint.claimEpoch) || checkpoint.claimEpoch <= 0
    || String(checkpoint.model) !== String(usage.model)
    || reservation.idempotencyKey !== identity.reservationIdempotencyKey
    || reservation.usageRecordId !== usage.id || usage.workspaceId !== workspaceId
    || usage.endpointType !== "text" || usage.status !== "pending_reconcile" || Number(usage.costMicros) !== 0
    || metadata.reconcileReason !== "chat_upstream_outcome_unknown" || metadata.billingLifecycleState !== "pending_reconcile"
    || !Number.isSafeInteger(dispatchStartedAt) || dispatchStartedAt <= 0 || !Number.isFinite(safeAfter) || Date.now() < safeAfter
    || reservation.taskId != null || usage.taskId != null || related.length
    || !job || job.status !== "leased" || Number(job.leaseExpiresAt) <= Date.now()
    || !String(job.leaseOwner || "").startsWith("manual-billing-reconcile-")
    || object(job.evidence).billingKey !== identity.billingKey
    || String(job.requestId) !== String(reservation.requestId)
    || String(job.channelId || "") !== String(usage.channelId || "")) {
    throw fail("平台承担释放缺少匹配的资产提取、无交付及终止等待证据", 409);
  }
  const completedAt = Date.now();
  const changed = await trx("o_agent_idempotency").where({
    id: command.id, workspaceId, status: "checkpointed", responseBody: command.responseBody,
  }).update({
    status: "completed", responseStatus: 409,
    responseBody: JSON.stringify({
      code: "script_asset_extraction_retry_allowed",
      message: "本次预扣已释放，可能的上游成本由平台承担。可主动发起新的提取。",
      claimEpoch: checkpoint.claimEpoch,
      data: { referenceId: command.id, canStartNewAttempt: true },
    }),
    updatedAt: completedAt, expiresAt: completedAt + 24 * 60 * 60_000,
  });
  if (Number(changed) !== 1) throw fail("资产提取状态已变化，释放已撤销", 409);
  return {
    contractVersion: SCRIPT_ASSET_ABSORPTION_CONTRACT,
    reason: "chat_upstream_outcome_unknown", commandId: command.id,
    projectId: checkpoint.projectId, attempt: checkpoint.attempt,
    customerDeliveryStatus: "none", customerChargeMicros: 0,
    providerBillingStatus: "possible_not_confirmed",
    customerReleaseMicros: reservation.amountMicros,
    maximumProviderExposureMicros: reservation.amountMicros,
    estimatedPlatformLossMicros: reservation.amountMicros,
    estimateBasis: "reserved_customer_amount_proxy_not_confirmed_provider_cost",
    operatorUserId: input.operatorUserId, resolvedAt: completedAt,
  };
}
