import { allocateAccountWalletToWorkspaceInTransaction } from "./billing";
import { parseMembershipFundingRules, readMembershipEligibleModels, validateMembershipFundingRules } from "./membershipFunding";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { addMembershipMonths } from "./commercialPricingPolicy";
import { grantAccountGiftInTransaction, listActiveGiftGrants, readAccountWalletReadonly, refundOrderGiftInTransaction } from "./accountWallet";
import { guMicrosPerGu } from "./billingUnits";
import { MEMBERSHIP_FEATURES, MEMBERSHIP_PLANS, MEMBERSHIP_VERSION, MembershipError,
  parseMembershipQuote, quoteMembership, type MembershipFeature, type MembershipQuote, type MembershipSelection } from "./membershipCatalog";
import { MEMBERSHIP_TABLES as T } from "./migrations/membershipEntitlements";
import { workspaceMembershipPolicy, assertMembershipSharedWrite } from "./membershipPolicy";
import { initializeWorkspaceResourceInventory, workspaceResourceUsage } from "./workspaceResources";

type Client = Knex | Knex.Transaction;
function object(value: unknown): Record<string, any> {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" ? value as Record<string, any> : {};
}
export async function readMembershipControl(client: Client = db, tenantId = "FANJIN") {
  // Allows the schema upgrade to be staged before activating the new catalogue.
  if (!await client.schema.hasTable(T.control)) return { salesEnabled: false, authorizationEnabled: false };
  const row = await client(T.control).where({ tenantId }).first();
  return { salesEnabled: row?.salesEnabled === true || row?.salesEnabled === 1,
    authorizationEnabled: row?.authorizationEnabled === true || row?.authorizationEnabled === 1 };
}

export async function quotePurchasableMembership(input: MembershipSelection & { tenantId: string; workspaceId: string; userId: number }) {
  const control = await readMembershipControl(db, input.tenantId);
  if (!control.salesEnabled || !control.authorizationEnabled) throw new MembershipError("会员订阅暂未开放", "MEMBERSHIP_SALES_CLOSED", 409);
  const workspace = await db("o_workspace").where({ id: input.workspaceId }).first();
  if (!workspace || Number(workspace.ownerUserId) !== input.userId) throw new MembershipError("请由工作区所有者购买会员", "MEMBERSHIP_OWNER_REQUIRED", 403);
  await initializeWorkspaceResourceInventory(db, input.workspaceId);
  const resources = await workspaceResourceUsage(db, input.workspaceId);
  if (!resources?.inventoryReady) throw new MembershipError("工作区云空间尚未核对完成，会员暂不可购买", "WORKSPACE_STORAGE_INVENTORY_PENDING", 409);
  const product = await db(T.product).where({ id: input.planId, enabled: true, version: MEMBERSHIP_VERSION }).first();
  if (!product) throw new MembershipError("该会员方案暂不可购买", "MEMBERSHIP_PRODUCT_UNAVAILABLE", 409);
  const config = await db(T.control).where({ tenantId: input.tenantId }).first();
  await validateMembershipFundingRules(db, parseMembershipFundingRules(config.fundingRules));
  return quoteMembership(input);
}

/** Called with the payment order locked, in the verified-payment transaction. */
export async function openMembershipSubscription(client: Knex.Transaction, order: any, quote: MembershipQuote, at: number) {
  const workspace = await client("o_workspace").where({ id: order.workspaceId }).forUpdate().first();
  if (!workspace) throw new MembershipError("会员所属工作区不存在", "MEMBERSHIP_WORKSPACE_MISSING", 409);
  const existing = await client(T.subscription).where({ paymentOrderId: order.id }).first();
  if (existing) return existing;
  const ownerUserId = Number(object(order.metadata).membershipOwnerUserId);
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) throw new MembershipError("会员订单缺少权益归属者", "MEMBERSHIP_OWNER_MISSING", 409);
  const previous = await client(T.subscription).where({ workspaceId: order.workspaceId, tenantId: order.sellerTenantId }).whereIn("status", ["active", "refund_pending"])
    .orderBy("endsAt", "desc").first();
  const startsAt = Math.max(at, Number(previous?.endsAt || 0));
  const subscription = { id: uuid(), paymentOrderId: order.id, tenantId: order.sellerTenantId, workspaceId: order.workspaceId,
    ownerUserId, payerUserId: Number(order.userId), planId: quote.planId, quote: JSON.stringify(quote), status: "active",
    startsAt, endsAt: addMembershipMonths(startsAt, quote.months), createdAt: at, updatedAt: at };
  await client(T.subscription).insert(subscription);
  await client(T.period).insert(Array.from({ length: quote.months }, (_, periodIndex) => ({
    id: uuid(), subscriptionId: subscription.id, periodIndex, dueAt: addMembershipMonths(startsAt, periodIndex),
    status: "pending", grantIds: "[]", updatedAt: at,
  })));
  return subscription;
}

export async function fulfillMembershipPeriod(periodId: string, at = Date.now(), client: Knex = db) {
  const hint = await client(T.period).where({ id: periodId }).first();
  if (!hint) return false;
  const parent = await client(T.subscription).where({ id: hint.subscriptionId }).first();
  if (!parent) throw new MembershipError("会员发放计划缺少订阅", "MEMBERSHIP_PERIOD_ORPHANED", 500);
  return client.transaction(async trx => {
    const order = await trx("o_payment_order").where({ id: parent.paymentOrderId }).forUpdate().first();
    await trx("o_workspace").where({ id: parent.workspaceId }).forUpdate().first();
    const subscription = await trx(T.subscription).where({ id: parent.id }).forUpdate().first();
    const period = await trx(T.period).where({ id: periodId }).forUpdate().first();
    if (!order || order.status !== "paid" || subscription?.status !== "active" || period?.status !== "pending" || Number(period.dueAt) > at) return false;
    const quote = parseMembershipQuote(object(subscription.quote));
    const grantIds: string[] = [];
    for (const scope of ["seedance", "h3"] as const) {
      const gift = await grantAccountGiftInTransaction(trx, {
        userId: Number(subscription.ownerUserId), workspaceId: subscription.workspaceId,
        amountMicros: scope === "seedance" ? quote.seedanceMicros : quote.h3Micros,
        expiresAt: addMembershipMonths(at, 12), campaignName: quote.name,
        idempotencyKey: `membership:${period.id}:${scope}`,
        description: `${quote.name}第 ${Number(period.periodIndex) + 1} 期 ${scope === "seedance" ? "Seedance" : "H3"} 专属额度（一年有效）`,
        metadata: { paymentOrderId: order.id, membership: { scope, workspaceId: subscription.workspaceId, tenantId: subscription.tenantId,
          subscriptionId: subscription.id, periodId: period.id, paymentOrderId: order.id, version: quote.version } },
      });
      await allocateAccountWalletToWorkspaceInTransaction(trx, {
        userId: Number(subscription.ownerUserId), workspaceId: subscription.workspaceId,
        amountMicros: scope === "seedance" ? quote.seedanceMicros : quote.h3Micros,
        idempotencyKey: `membership-quota:${period.id}:${scope}`,
        description: `${quote.name}第 ${Number(period.periodIndex) + 1} 期工作区消费额度`,
        metadata: { membershipPeriodId: period.id, giftGrantId: gift.grant.id, scope },
      });
      grantIds.push(gift.grant.id);
    }
    await trx(T.period).where({ id: periodId }).update({ status: "granted", grantedAt: at, grantIds: JSON.stringify(grantIds), lastError: null, updatedAt: at });
    if (Number(period.periodIndex) === 0) await trx("o_payment_order").where({ id: order.id }).update({
      metadata: JSON.stringify({ ...object(order.metadata), membershipFulfillment: "complete", membershipFirstGrantAt: at }), updatedAt: at,
    });
    return true;
  });
}

export async function processDueMembershipPeriods(options: { at?: number; orderId?: string; limit?: number } = {}, client: Knex = db) {
  if (!await client.schema.hasTable(T.period)) return { granted: 0, failed: 0 };
  const at = options.at ?? Date.now();
  const query = client(`${T.period} as p`).join(`${T.subscription} as s`, "s.id", "p.subscriptionId")
    .where("p.status", "pending").where("s.status", "active").where("p.dueAt", "<=", at)
    .orderBy("p.dueAt").orderBy("p.id").limit(Math.min(100, options.limit ?? 25)).select("p.id");
  if (options.orderId) query.where("s.paymentOrderId", options.orderId);
  const due = await query;
  let granted = 0, failed = 0;
  for (const period of due) {
    try { if (await fulfillMembershipPeriod(period.id, at, client)) granted++; }
    catch (error) {
      failed++;
      await client(T.period).where({ id: period.id, status: "pending" }).update({
        lastError: error instanceof MembershipError ? error.code : "MEMBERSHIP_GRANT_RETRY_REQUIRED", updatedAt: at,
      });
    }
  }
  return { granted, failed };
}

export async function readWorkspaceMembership(workspaceId: string, tenantId = "FANJIN", at = Date.now(), client: Client = db) {
  const control = await readMembershipControl(client, tenantId);
  if (!await client.schema.hasTable(T.subscription)) return { ...control, current: null, next: [], level: -1, features: [] as MembershipFeature[], balances: null };
  const subscriptions = await client(T.subscription).where({ workspaceId, tenantId, status: "active" }).where("endsAt", ">", at).orderBy("startsAt");
  const active = subscriptions.find(row => Number(row.startsAt) <= at);
  const format = (row: any) => { const quote = parseMembershipQuote(object(row.quote)); return {
    id: row.id, planId: quote.planId, name: quote.name, level: quote.level, startsAt: Number(row.startsAt), expiresAt: Number(row.endsAt),
    months: quote.months, seedanceShare: quote.seedanceShare, seedanceGu: quote.seedanceGu, h3Gu: quote.h3Gu,
    features: Object.keys(MEMBERSHIP_FEATURES) as MembershipFeature[], version: quote.version,
  }; };
  const current = active ? format(active) : null;
  const workspace = await client("o_workspace").where({ id: workspaceId }).first();
  let balances = null;
  if (workspace) {
    const wallet = await readAccountWalletReadonly(client, Number(workspace.ownerUserId));
    const gifts = wallet ? await listActiveGiftGrants(client, Number(workspace.ownerUserId), at) : [];
    const sums = { seedance: 0, h3: 0, generalGift: 0 };
    for (const grant of gifts) {
      const restriction = object(grant.metadata).membership;
      const amount = Math.max(0, grant.remainingMicros - grant.reservedMicros);
      if (!restriction) sums.generalGift += amount;
      else if (restriction.workspaceId === workspaceId && restriction.tenantId === tenantId && (restriction.scope === "seedance" || restriction.scope === "h3")) sums[restriction.scope as "seedance" | "h3"] += amount;
    }
    balances = { permanentGu: Math.max(0, Number(wallet?.balanceMicros || 0) - Number(wallet?.cashReservedMicros || 0)) / guMicrosPerGu,
      seedanceGu: sums.seedance / guMicrosPerGu, h3Gu: sums.h3 / guMicrosPerGu, generalGiftGu: sums.generalGift / guMicrosPerGu };
  }
  return { ...control, policy: await workspaceMembershipPolicy(client, workspaceId, at), current, eligibleModels: await readMembershipEligibleModels(client, tenantId), next: subscriptions.filter(row => Number(row.startsAt) > at).map(format),
    resources: await workspaceResourceUsage(client, workspaceId), level: current?.level ?? -1, features: current?.features ?? [], balances };
}

export async function assertMembershipFeature(workspaceId: string, feature: MembershipFeature, client: Client = db) {
  const policy = await workspaceMembershipPolicy(client, workspaceId);
  if (policy.authorizationEnabled && !policy.paid) throw new MembershipError(
    `${MEMBERSHIP_FEATURES[feature].name}需开通会员，任意会员档位均可使用`, "MEMBERSHIP_FEATURE_REQUIRED", 403);
  if (policy.authorizationEnabled && ["shared", "workflow", "rewrite", "director", "storyboard", "analysis"].includes(feature))
    await assertMembershipSharedWrite(client, workspaceId);
}

/** Payment row is locked by the caller. Freeze every grant before any provider refund call. */
export async function changeMembershipRefund(client: Knex.Transaction, order: any, phase: "reserve" | "release" | "finalize") {
  await client("o_workspace").where({ id: order.workspaceId }).forUpdate().first();
  const subscription = await client(T.subscription).where({ paymentOrderId: order.id }).forUpdate().first();
  if (!subscription) throw new MembershipError("会员退款缺少订阅记录", "MEMBERSHIP_REFUND_RECONCILIATION_REQUIRED", 409);
  if (phase === "reserve" && subscription.status === "refund_pending") return;
  const expectedStatus = phase === "reserve" ? "active" : "refund_pending";
  if (subscription.status !== expectedStatus) throw new MembershipError("会员退款状态不一致，请联系财务核对", "MEMBERSHIP_REFUND_STATE_CONFLICT", 409);
  const periods = await client(T.period).where({ subscriptionId: subscription.id }).orderBy("periodIndex").forUpdate();
  for (const period of periods) {
    const grantIds: string[] = JSON.parse(String(period.grantIds));
    for (const grantId of grantIds) await refundOrderGiftInTransaction(client, { userId: Number(subscription.ownerUserId), grantId, orderId: order.id, phase });
  }
  const at = Date.now();
  await client(T.subscription).where({ id: subscription.id }).update({ status: phase === "reserve" ? "refund_pending" : phase === "release" ? "active" : "refunded", updatedAt: at });
  if (phase === "finalize") await client(T.period).where({ subscriptionId: subscription.id, status: "pending" }).update({ status: "cancelled", updatedAt: at });
}

/** Caller holds the workspace lock, shared with order creation and settlement. */
export async function assertMembershipOwnerTransferable(client: Client, workspaceId: string) {
  if (!await client.schema.hasTable(T.subscription)) return;
  const orders = await client("o_payment_order").where({ workspaceId }).whereNotIn("status", ["refunded", "failed"]).select("metadata");
  if (orders.some(order => object(order.metadata).membershipQuote)) {
    throw new MembershipError("该工作区有会员订单，请先联系财务处理权益归属后再转让", "MEMBERSHIP_OWNER_TRANSFER_REVIEW", 409);
  }
}
