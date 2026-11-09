import { resolveCreditPackage, addMembershipMonths } from "./commercialPricingPolicy";
import { MembershipError, parseMembershipQuote, type MembershipSelection } from "./membershipCatalog";
import { changeMembershipRefund, openMembershipSubscription, processDueMembershipPeriods, quotePurchasableMembership } from "./membership";
import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { AccountGiftRefundError, applyAccountWalletCredit, applyAccountWalletDebit, grantAccountGiftInTransaction, refundOrderGiftInTransaction } from "@/lib/accountWallet";
import { ledgerAtomsPerCnyMicro, guMicrosPerGu } from "@/lib/billingUnits";
import {
  COMMERCIAL_CREDIT_LOT_TABLE,
  CommercialTenantError,
  creditTenantSettlementInTransaction,
  createCommercialCreditLotInTransaction,
  type CommercialTenant,
  runtimeCommercialTenantById,
} from "@/lib/commercialTenant";
import {
  createProviderOrder,
  OnlinePaymentGatewayError,
  paymentPayloadDigest,
  queryProviderRefund,
  queryProviderOrder,
  refundProviderOrder,
  type ProviderCallbackEvidence,
  type ProviderPaymentOrder,
  type ProviderPaymentResult,
} from "@/lib/onlinePaymentGateway";
import {
  configuredOnlinePaymentChannel,
  normalizePaymentProtocol,
  PaymentConfigError,
  resolvePaymentNotifyUrl,
  resolveTenantPaymentConfiguration,
} from "@/lib/tenantPaymentConfig";
import { ONLINE_PAYMENT_EVENT_TABLE, ONLINE_PAYMENT_ORDER_TABLE } from "@/lib/migrations/onlinePaymentOrder";
import { readUserAttribution } from "@/lib/tenantAttribution";
import { db } from "@/utils/db";

export type OnlinePaymentOrderStatus =
  | "created"
  | "pending"
  | "pending_reconcile"
  | "paid"
  | "failed"
  | "closed"
  | "refunding"
  | "refunded";

export class OnlinePaymentError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "ONLINE_PAYMENT_ERROR") {
    super(message);
    this.name = "OnlinePaymentError";
    this.status = status;
    this.code = code;
  }
}

function clean(value: unknown): string {
  return String(value || "").trim();
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(clean(value) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assertAmountMicros(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 10_000 !== 0) {
    throw new OnlinePaymentError("充值金额必须是大于 0 且精确到分的 CNY micros", 400, "PAYMENT_AMOUNT_INVALID");
  }
  return amount;
}

function guMicrosForCny(amountMicros: number): number {
  const result = amountMicros * ledgerAtomsPerCnyMicro;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new OnlinePaymentError("充值 GU 金额超出安全范围", 400, "PAYMENT_AMOUNT_INVALID");
  }
  return result;
}

function newOutTradeNo(): string {
  return `FJ${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(7).toString("hex").toUpperCase()}`.slice(0, 32);
}

function clientReturnUrl(raw: unknown, tenant: CommercialTenant): string | null {
  const text = clean(raw);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new OnlinePaymentError("支付完成返回地址无效", 400, "PAYMENT_RETURN_URL_INVALID");
  }
  const local = process.env.NODE_ENV === "test" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new OnlinePaymentError("支付完成返回地址必须使用 HTTPS", 400, "PAYMENT_RETURN_URL_INVALID");
  }
  if (!local && !tenant.hosts.includes(url.hostname.toLowerCase())) {
    throw new OnlinePaymentError("支付完成返回地址不属于当前租户域名", 400, "PAYMENT_RETURN_URL_INVALID");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

function publicOrder(row: any) {
  const metadata = parseMetadata(row.metadata);
  const status = clean(row.status) as OnlinePaymentOrderStatus;
  const canContinuePayment = ["created", "pending", "pending_reconcile"].includes(status);
  return {
    id: clean(row.id),
    outTradeNo: clean(row.outTradeNo),
    sellerTenantId: clean(row.sellerTenantId),
    workspaceId: clean(row.workspaceId),
    channelKey: clean(row.channelKey),
    protocol: clean(row.protocol),
    status,
    amountMicros: Number(row.amountMicros || 0),
    amountYuan: Number(row.amountMicros || 0) / 1_000_000,
    creditedGuMicros: Number(row.creditedGuMicros || 0),
    creditedGu: (Number(row.creditedGuMicros || 0) + Number(parseMetadata(metadata.creditPackage).giftGuMicros || 0)) / guMicrosPerGu,
    permanentGu: Number(row.creditedGuMicros || 0) / guMicrosPerGu,
    giftExpiresAt: metadata.giftExpiresAt || null,
    package: metadata.creditPackage || null,
    membership: metadata.membershipQuote || null,
    membershipFulfillment: metadata.membershipFulfillment || null,
    membershipStartsAt: metadata.membershipStartsAt || null,
    refundedAmountMicros: Number(row.refundedAmountMicros || 0),
    currency: clean(row.currency) || "CNY",
    providerOrderId: clean(row.providerOrderId) || null,
    paymentUrl: canContinuePayment ? clean(metadata.paymentUrl) || null : null,
    qrCodeUrl: canContinuePayment ? clean(metadata.qrCodeUrl) || null : null,
    expiresAt: Number(row.expiresAt || 0),
    paidAt: row.paidAt == null ? null : Number(row.paidAt),
    refundedAt: row.refundedAt == null ? null : Number(row.refundedAt),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

function providerOrderInput(row: any, notifyUrl: string): ProviderPaymentOrder {
  return {
    outTradeNo: clean(row.outTradeNo),
    amountMicros: Number(row.amountMicros),
    description: clean(row.description),
    notifyUrl,
    returnUrl: clean(row.clientReturnUrl) || null,
    expiresAt: Number(row.expiresAt),
  };
}

function providerExpectedMerchant(channel: any): string {
  return normalizePaymentProtocol(channel) === "alipay"
    ? clean(channel.merchantId)
    : clean(channel.mchId || channel.merchantId);
}

/**
 * 0.1.4 真实收款租户解析：
 * 通道配置显式声明 collectorTenantId 时必须指向已登记商业租户（DB 权威）；
 * 未声明时回退为承载该通道配置的入口租户。
 */
async function resolveCollectorTenantId(
  database: Knex | Knex.Transaction,
  channel: any,
  entryTenantId: string,
): Promise<string> {
  const declared = clean(channel?.collectorTenantId).toUpperCase();
  if (!declared) return entryTenantId;
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(declared)) {
    throw new PaymentConfigError(`支付通道 collectorTenantId 无效：${declared}`);
  }
  try {
    await runtimeCommercialTenantById(database, declared);
  } catch {
    throw new PaymentConfigError(`支付通道 collectorTenantId 未登记：${declared}`);
  }
  return declared;
}

function providerExpectedApp(channel: any): string {
  return clean(channel.appId || channel.alipayAppId || channel.merchantId);
}

async function insertPaymentEvent(trx: Knex.Transaction, input: {
  orderId: string;
  eventKey: string;
  eventType: string;
  payloadDigest: string;
  status: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const existing = await trx(ONLINE_PAYMENT_EVENT_TABLE).where({ eventKey: input.eventKey }).first();
  if (existing) return false;
  try {
    await trx(ONLINE_PAYMENT_EVENT_TABLE).insert({
      id: uuid(),
      ...input,
      metadata: JSON.stringify(input.metadata || {}),
      createdAt: Date.now(),
      processedAt: Date.now(),
    });
    return true;
  } catch (error) {
    const raced = await trx(ONLINE_PAYMENT_EVENT_TABLE).where({ eventKey: input.eventKey }).first();
    if (raced) return false;
    throw error;
  }
}

async function settlePaidOrder(input: {
  tenant: CommercialTenant;
  evidence: ProviderPaymentResult;
  outTradeNo: string;
  eventKey: string;
  eventType: string;
}) {
  return await db.transaction(async (trx) => {
    const order = await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ outTradeNo: input.outTradeNo }).forUpdate().first();
    if (!order || clean(order.sellerTenantId) !== input.tenant.id) {
      throw new OnlinePaymentError("支付订单不存在", 404, "PAYMENT_ORDER_NOT_FOUND");
    }
    if (input.evidence.status !== "paid") return order;
    if (Number(input.evidence.amountMicros) !== Number(order.amountMicros) || clean(input.evidence.currency) !== "CNY") {
      throw new OnlinePaymentError("支付金额或币种与订单不一致", 409, "PAYMENT_EVIDENCE_MISMATCH");
    }
    const freshEvent = await insertPaymentEvent(trx, {
      orderId: clean(order.id),
      eventKey: input.eventKey,
      eventType: input.eventType,
      payloadDigest: input.evidence.payloadDigest,
      status: "verified",
      metadata: { providerOrderId: input.evidence.providerOrderId || null },
    });
    if (clean(order.status) === "paid" || clean(order.status) === "refunding" || clean(order.status) === "refunded") return order;
    if (!freshEvent) return await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
    const membershipSnapshot = parseMetadata(order.metadata).membershipQuote;
    if (membershipSnapshot) {
      const quote = parseMembershipQuote(membershipSnapshot);
      if (quote.amountMicros !== Number(order.amountMicros) || Number(order.creditedGuMicros) !== 0) {
        throw new MembershipError("会员订单金额与快照不符", "MEMBERSHIP_SNAPSHOT_INVALID", 409);
      }
      const paidAt = Date.now();
      const subscription = await openMembershipSubscription(trx, order, quote, paidAt);
      await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).update({
        status: "paid", providerOrderId: input.evidence.providerOrderId || null,
        providerPayloadDigest: input.evidence.payloadDigest, paidAt, updatedAt: paidAt,
        metadata: JSON.stringify({ ...parseMetadata(order.metadata), membershipSubscriptionId: subscription.id,
          membershipFulfillment: Number(subscription.startsAt) > paidAt ? "scheduled" : "pending", membershipStartsAt: Number(subscription.startsAt) }),
        revision: Number(order.revision || 0) + 1,
      });
      return await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
    }
    const walletCredit = await applyAccountWalletCredit(trx, {
      userId: Number(order.userId),
      workspaceId: clean(order.workspaceId),
      currency: "GU",
      type: "recharge",
      amountMicros: Number(order.creditedGuMicros),
      idempotencyKey: `online-payment:${order.id}`,
      description: `${input.tenant.name}线上充值`,
      metadata: { source: "online_payment", paymentOrderId: order.id, sellerTenantId: input.tenant.id },
    });
    const lot = await createCommercialCreditLotInTransaction(trx, {
      userId: Number(order.userId),
      sellerTenantId: input.tenant.id,
      amountMicros: Number(order.creditedGuMicros),
      retailAmountMicros: Number(order.amountMicros),
      accountWalletLedgerId: walletCredit.ledger.id,
      sourceType: "online_payment",
      sourceId: clean(order.id),
      idempotencyKey: `credit-lot:online-payment:${order.id}`,
      collectorTenantId: clean(order.collectorTenantId) || input.tenant.id,
      metadata: { workspaceId: order.workspaceId, outTradeNo: order.outTradeNo },
    });
    const updatedAt = Date.now();
    const orderMetadata = parseMetadata(order.metadata);
    const purchasedPackage = parseMetadata(orderMetadata.creditPackage);
    const giftAmountMicros = Number(purchasedPackage.giftGuMicros || 0);
    if (giftAmountMicros > 0) {
      const giftExpiresAt = addMembershipMonths(updatedAt, 12);
      const gift = await grantAccountGiftInTransaction(trx, {
        userId: Number(order.userId), workspaceId: clean(order.workspaceId), currency: "GU", type: "gift_grant",
        amountMicros: giftAmountMicros, expiresAt: giftExpiresAt, campaignName: String(purchasedPackage.name),
        description: "会员充值赠分，有效期一年，会员到期不提前失效",
        idempotencyKey: `online-payment-membership-gift:${order.id}`,
        metadata: { paymentOrderId: order.id, source: "membership_purchase" },
      });
      orderMetadata.giftGrantId = gift.grant.id;
      orderMetadata.giftExpiresAt = giftExpiresAt;
    }
    await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).update({
      metadata: JSON.stringify(orderMetadata),
      status: "paid",
      providerOrderId: input.evidence.providerOrderId || order.providerOrderId || null,
      providerPayloadDigest: input.evidence.payloadDigest,
      walletLedgerId: walletCredit.ledger.id,
      creditLotId: lot.lot.id,
      paidAt: updatedAt,
      updatedAt,
      revision: Number(order.revision || 0) + 1,
    });
    return await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
  });
}

export async function createOnlinePayment(input: {
  tenant: CommercialTenant;
  userId: number;
  workspaceId: string;
  channelKey: string;
  amountMicros: number;
  packageId?: string | null;
  membership?: MembershipSelection;
  idempotencyKey: string;
  returnUrl?: string | null;
}) {
  const amountMicros = assertAmountMicros(input.amountMicros);
  if (input.membership && input.packageId) throw new MembershipError("不能同时购买两种商品");
  let creditPackage: ReturnType<typeof resolveCreditPackage> | null = null;
  if (input.packageId) {
    if (input.tenant.id !== "FANJIN") throw new OnlinePaymentError("该租户未开通创作套餐", 409, "PAYMENT_PACKAGE_UNAVAILABLE");
    try { creditPackage = resolveCreditPackage(input.packageId); } catch { throw new OnlinePaymentError("创作套餐不可用", 400, "PAYMENT_PACKAGE_UNAVAILABLE"); }
    if (creditPackage.amountMicros !== amountMicros) throw new OnlinePaymentError("套餐支付金额不匹配", 400, "PAYMENT_PACKAGE_AMOUNT_MISMATCH");
  }
  const userId = Number(input.userId);
  const workspaceId = clean(input.workspaceId);
  const idempotencyKey = clean(input.idempotencyKey);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !workspaceId || !idempotencyKey || idempotencyKey.length > 200) {
    throw new OnlinePaymentError("线上支付订单参数无效", 400, "PAYMENT_ORDER_INVALID");
  }
  const existing = await db(ONLINE_PAYMENT_ORDER_TABLE).where({
    sellerTenantId: input.tenant.id,
    userId,
    idempotencyKey,
  }).first();
  if (existing) {
    const previousMembership = parseMetadata(parseMetadata(existing.metadata).membershipQuote);
    const previousSelection = previousMembership.planId
      ? [previousMembership.planId, previousMembership.months, previousMembership.seedanceShare, previousMembership.version] : null;
    const requestedSelection = input.membership
      ? [input.membership.planId, input.membership.months, input.membership.seedanceShare, input.membership.version] : null;
    if (JSON.stringify(previousSelection) !== JSON.stringify(requestedSelection)) {
      throw new OnlinePaymentError("支付幂等键已用于不同会员方案", 409, "PAYMENT_IDEMPOTENCY_CONFLICT");
    }
    if (String(parseMetadata(parseMetadata(existing.metadata).creditPackage).id || "") !== String(input.packageId || "")) throw new OnlinePaymentError("支付幂等键已用于不同套餐", 409, "PAYMENT_IDEMPOTENCY_CONFLICT");
    if (Number(existing.amountMicros) !== amountMicros || clean(existing.channelKey) !== clean(input.channelKey) || clean(existing.workspaceId) !== workspaceId) {
      throw new OnlinePaymentError("支付幂等键已用于不同请求", 409, "PAYMENT_IDEMPOTENCY_CONFLICT");
    }
    return publicOrder(existing);
  }
  const membershipQuote = input.membership ? await quotePurchasableMembership({ ...input.membership,
    tenantId: input.tenant.id, workspaceId: clean(input.workspaceId), userId: Number(input.userId) }) : null;
  if (membershipQuote && membershipQuote.amountMicros !== amountMicros) throw new MembershipError("会员报价与付款金额不一致", "MEMBERSHIP_AMOUNT_MISMATCH");
  const channel = await configuredOnlinePaymentChannel(input.tenant, input.channelKey);
  const config = await resolveTenantPaymentConfiguration(input.tenant);
  // 0.1.4 真实收款租户：以通道商户配置声明的 collectorTenantId 为准；
  // 未声明时默认为承载该通道配置的入口租户。不从用户所属租户推断。
  const collectorTenantId = await resolveCollectorTenantId(db, channel, input.tenant.id);
  const attribution = await readUserAttribution(db as any, userId);
  const amountYuan = amountMicros / 1_000_000;
  const channelMin = membershipQuote ? Number(channel.minAmountYuan || 0) : Number(channel.minAmountYuan || config.minTopupYuan || 0);
  const channelMax = Number(channel.maxAmountYuan || 0);
  if (amountYuan < channelMin || (channelMax > 0 && amountYuan > channelMax)) {
    throw new OnlinePaymentError("充值金额超出支付渠道允许范围", 400, "PAYMENT_AMOUNT_OUT_OF_RANGE");
  }
  const timestamp = Date.now();
  const row = {
    id: uuid(),
    outTradeNo: newOutTradeNo(),
    sellerTenantId: input.tenant.id,
    collectorTenantId,
    registeredTenantIdSnapshot: attribution.registeredTenantId,
    ownerTenantIdSnapshot: attribution.ownerTenantId,
    workspaceId,
    userId,
    channelKey: clean(input.channelKey),
    protocol: normalizePaymentProtocol(channel),
    providerOrderId: null,
    status: "created",
    amountMicros,
    creditedGuMicros: membershipQuote ? 0 : creditPackage?.creditedGuMicros ?? guMicrosForCny(amountMicros),
    refundedAmountMicros: 0,
    currency: "CNY",
    description: membershipQuote ? `${input.tenant.name} ${membershipQuote.name} ${membershipQuote.months}个月` : creditPackage ? `${input.tenant.name} ${creditPackage.name}` : `${input.tenant.name} GU 充值`,
    clientReturnUrl: clientReturnUrl(input.returnUrl, input.tenant),
    idempotencyKey,
    providerPayloadDigest: null,
    walletLedgerId: null,
    creditLotId: null,
    metadata: JSON.stringify(membershipQuote ? { membershipQuote, membershipOwnerUserId: userId } : creditPackage ? { creditPackage } : {}),
    expiresAt: timestamp + 30 * 60 * 1000,
    paidAt: null,
    refundedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0,
  };
  try {
    await db.transaction(async trx => {
      if (membershipQuote) {
        const owner = await trx("o_workspace").where({ id: workspaceId }).forUpdate().first();
        if (Number(owner?.ownerUserId) !== userId) throw new MembershipError("工作区所有者已变化，请重新购买", "MEMBERSHIP_OWNER_CHANGED", 409);
      }
      await trx(ONLINE_PAYMENT_ORDER_TABLE).insert(row);
    });
  } catch (error) {
    const raced = await db(ONLINE_PAYMENT_ORDER_TABLE).where({ sellerTenantId: input.tenant.id, userId, idempotencyKey }).first();
    if (raced) {
      if (parseMetadata(parseMetadata(raced.metadata).membershipQuote).quoteHash !== membershipQuote?.quoteHash) throw new OnlinePaymentError("支付幂等键已用于不同会员方案", 409, "PAYMENT_IDEMPOTENCY_CONFLICT");
      if (Number(raced.amountMicros) !== amountMicros || clean(raced.channelKey) !== clean(input.channelKey) || clean(raced.workspaceId) !== workspaceId
        || String(parseMetadata(parseMetadata(raced.metadata).creditPackage).id || "") !== String(input.packageId || "")) {
        throw new OnlinePaymentError("支付幂等键已用于不同请求", 409, "PAYMENT_IDEMPOTENCY_CONFLICT");
      }
      return publicOrder(raced);
    }
    throw error;
  }
  const notifyUrl = resolvePaymentNotifyUrl(input.tenant.id, channel);
  if (!notifyUrl) {
    await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: row.id }).update({ status: "failed", updatedAt: Date.now() });
    throw new PaymentConfigError("支付回调地址未配置");
  }
  try {
    const provider = await createProviderOrder(channel, providerOrderInput(row, notifyUrl));
    const metadata = JSON.stringify({ ...parseMetadata(row.metadata), paymentUrl: provider.paymentUrl || null, qrCodeUrl: provider.qrCodeUrl || null });
    await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: row.id, status: "created" }).update({
      status: "pending",
      providerOrderId: provider.providerOrderId || null,
      providerPayloadDigest: provider.payloadDigest,
      metadata,
      updatedAt: Date.now(),
      revision: 1,
    });
  } catch (error) {
    const unknown = error instanceof OnlinePaymentGatewayError && error.outcomeUnknown;
    await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: row.id, status: "created" }).update({
      status: unknown ? "pending_reconcile" : "failed",
      providerPayloadDigest: paymentPayloadDigest(error instanceof Error ? error.name : "payment_error"),
      updatedAt: Date.now(),
      revision: 1,
    });
    throw error;
  }
  return publicOrder(await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: row.id }).first());
}

async function ownedOrder(input: { tenant: CommercialTenant; orderId: string; userId: number; workspaceId: string }) {
  const order = await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: clean(input.orderId) }).first();
  if (
    !order
    || clean(order.sellerTenantId) !== input.tenant.id
    || Number(order.userId) !== Number(input.userId)
    || clean(order.workspaceId) !== clean(input.workspaceId)
  ) {
    throw new OnlinePaymentError("支付订单不存在", 404, "PAYMENT_ORDER_NOT_FOUND");
  }
  return order;
}

export async function queryOnlinePayment(input: { tenant: CommercialTenant; orderId: string; userId: number; workspaceId: string }) {
  let order = await ownedOrder(input);
  if (["pending", "pending_reconcile"].includes(clean(order.status))) {
    const channel = await configuredOnlinePaymentChannel(input.tenant, order.channelKey);
    const evidence = await queryProviderOrder(channel, clean(order.outTradeNo));
    if (evidence.status === "paid") {
      order = await settlePaidOrder({
        tenant: input.tenant,
        evidence,
        outTradeNo: clean(order.outTradeNo),
        eventKey: `query:${order.outTradeNo}:${evidence.providerOrderId || evidence.payloadDigest}`,
        eventType: "provider_query_paid",
      });
    } else if (evidence.status === "closed") {
      await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).whereIn("status", ["pending", "pending_reconcile"]).update({
        status: "closed", providerPayloadDigest: evidence.payloadDigest, updatedAt: Date.now(), revision: Number(order.revision || 0) + 1,
      });
      order = await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
    }
  } else if (clean(order.status) === "refunding") {
    const channel = await configuredOnlinePaymentChannel(input.tenant, order.channelKey);
    const notifyUrl = resolvePaymentNotifyUrl(input.tenant.id, channel);
    const evidence = await queryProviderRefund(channel, providerOrderInput(order, notifyUrl));
    if (evidence.status === "refunded") {
      assertRefundEvidenceMatchesOrder(order, evidence);
      order = await finalizeRefund(clean(order.id), evidence);
    }
  }
  if (clean(order.status) === "paid" && parseMetadata(order.metadata).membershipQuote) {
    await processDueMembershipPeriods({ orderId: order.id });
    order = await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
  }
  return publicOrder(order);
}

type PaymentListInput = { tenant: CommercialTenant; userId: number; workspaceId: string; limit?: number; cursor?: string };
export async function listOnlinePayments(input: PaymentListInput) {
  return (await listOnlinePaymentPage(input)).items;
}
export async function listOnlinePaymentPage(input: PaymentListInput) {
  const userId = Number(input.userId), workspaceId = clean(input.workspaceId);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !workspaceId) throw new OnlinePaymentError("线上支付订单查询参数无效", 400, "PAYMENT_ORDER_INVALID");
  const limit = Number.isSafeInteger(input.limit) ? Math.min(20, Math.max(1, input.limit!)) : 8;
  const binding = crypto.createHash("sha256").update(JSON.stringify([input.tenant.id, userId, workspaceId])).digest("hex");
  let snapshotAt = Date.now(), after: { at: number; id: string } | null = null;
  if (input.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      if (cursor.binding !== binding || !Number.isSafeInteger(cursor.snapshotAt) || cursor.snapshotAt > snapshotAt || snapshotAt - cursor.snapshotAt > 86400000 || !Number.isSafeInteger(cursor.at) || typeof cursor.id !== "string" || cursor.id.length > 128) throw new Error();
      snapshotAt = cursor.snapshotAt; after = cursor;
    } catch { throw new OnlinePaymentError("订单分页已过期或不属于当前工作区，请刷新", 400, "PAYMENT_CURSOR_INVALID"); }
  }
  const q = db(ONLINE_PAYMENT_ORDER_TABLE).where({ sellerTenantId: input.tenant.id, userId, workspaceId }).where("createdAt", "<=", snapshotAt);
  if (after) q.where(b => b.where("createdAt", "<", after!.at).orWhere(b => b.where("createdAt", after!.at).where("id", "<", after!.id)));
  const rows = await q.orderBy("createdAt", "desc").orderBy("id", "desc").limit(limit + 1), selected = rows.slice(0, limit), last = selected.at(-1);
  return { items: selected.map(publicOrder), snapshotAt, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ binding, snapshotAt, at: Number(last.createdAt), id: last.id })).toString("base64url") : null };
}

export async function applyVerifiedProviderCallback(input: {
  tenantId: string;
  channelKey: string;
  evidence: ProviderCallbackEvidence;
}) {
  const tenant = await runtimeCommercialTenantById(db, input.tenantId);
  const channel = await configuredOnlinePaymentChannel(tenant, input.channelKey);
  const expectedMerchant = providerExpectedMerchant(channel);
  const expectedApp = providerExpectedApp(channel);
  if (
    !input.evidence.outTradeNo
    || (expectedMerchant && clean(input.evidence.merchantId) !== expectedMerchant)
    || (input.evidence.appId && expectedApp && clean(input.evidence.appId) !== expectedApp)
  ) {
    throw new OnlinePaymentError("支付回调商户或应用不匹配", 409, "PAYMENT_EVIDENCE_MISMATCH");
  }
  if (input.evidence.status !== "paid") return { accepted: true, credited: false };
  const result = await settlePaidOrder({
    tenant,
    evidence: input.evidence,
    outTradeNo: input.evidence.outTradeNo,
    eventKey: `${tenant.id}:${clean(input.channelKey)}:${normalizePaymentProtocol(channel)}:${input.evidence.eventKey || input.evidence.payloadDigest}`,
    eventType: "provider_callback_paid",
  });
  if (clean(result.status) === "paid" && parseMetadata(result.metadata).membershipQuote) {
    // Payment evidence is durable before issuance. A failed grant is retried by
    // the period worker; it must not cause another upstream payment request.
    await processDueMembershipPeriods({ orderId: result.id });
    const updated = await db(ONLINE_PAYMENT_ORDER_TABLE).where({ id: result.id }).first();
    return { accepted: true, credited: parseMetadata(updated.metadata).membershipFulfillment === "complete", order: publicOrder(updated) };
  }
  return { accepted: true, credited: clean(result.status) === "paid", order: publicOrder(result) };
}

async function reserveRefundFunds(orderId: string) {
  return await db.transaction(async (trx) => {
    const order = await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: orderId }).forUpdate().first();
    if (!order) throw new OnlinePaymentError("支付订单不存在", 404, "PAYMENT_ORDER_NOT_FOUND");
    const status = clean(order.status);
    if (status === "refunded") return order;
    if (status !== "paid" && status !== "refunding") {
      throw new OnlinePaymentError("只有已支付订单可以退款", 409, "PAYMENT_ORDER_NOT_REFUNDABLE");
    }
    if (parseMetadata(order.metadata).membershipQuote) {
      await changeMembershipRefund(trx, order, "reserve");
      await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).update({ status: "refunding", updatedAt: Date.now() });
      return await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
    }
    const lot = await trx(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: order.creditLotId, userId: order.userId })
      .forUpdate()
      .first();
    const lotStatus = clean(lot?.status);
    if (
      !lot
      || Number(lot.remainingMicros) !== Number(lot.amountMicros)
      || Number(lot.reservedMicros) !== 0
      || !["active", "refund_pending"].includes(lotStatus)
    ) {
      throw new OnlinePaymentError("该笔充值已有 GU 被消耗或冻结，不能整单退款", 409, "PAYMENT_CREDIT_ALREADY_USED");
    }
    if (lotStatus === "refund_pending") return order;

    const wallet = await trx("o_account_wallet").where({ userId: order.userId }).forUpdate().first();
    const refundGuMicros = Number(order.creditedGuMicros);
    const cashReservedMicros = Number(wallet?.cashReservedMicros || 0);
    const balanceMicros = Number(wallet?.balanceMicros || 0);
    if (
      !wallet
      || !Number.isSafeInteger(refundGuMicros)
      || refundGuMicros <= 0
      || balanceMicros - cashReservedMicros < refundGuMicros
      || !Number.isSafeInteger(cashReservedMicros + refundGuMicros)
    ) {
      throw new OnlinePaymentError("该笔充值 GU 当前不可退款", 409, "PAYMENT_CREDIT_ALREADY_USED");
    }
    const giftGrantId = clean(parseMetadata(order.metadata).giftGrantId);
    if (giftGrantId) await refundOrderGiftInTransaction(trx, { userId: Number(order.userId), grantId: giftGrantId, orderId: order.id, phase: "reserve" });
    const now = Date.now();
    const walletUpdated = await trx("o_account_wallet")
      .where({ userId: order.userId, balanceMicros, cashReservedMicros })
      .update({ cashReservedMicros: cashReservedMicros + refundGuMicros, updatedAt: now });
    const lotUpdated = await trx(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: lot.id, status: "active", remainingMicros: lot.remainingMicros, reservedMicros: 0 })
      .update({ status: "refund_pending", updatedAt: now });
    if (Number(walletUpdated || 0) !== 1 || Number(lotUpdated || 0) !== 1) {
      throw new OnlinePaymentError("退款占用发生并发变化，请重试", 409, "PAYMENT_REFUND_RESERVATION_CONFLICT");
    }
    if (status === "paid") {
      const orderUpdated = await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id, status: "paid" }).update({
        status: "refunding",
        updatedAt: now,
        revision: Number(order.revision || 0) + 1,
      });
      if (Number(orderUpdated || 0) !== 1) {
        throw new OnlinePaymentError("退款订单发生并发变化，请重试", 409, "PAYMENT_REFUND_RESERVATION_CONFLICT");
      }
    }
    return await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
  });
}

async function releaseRefundFunds(orderId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const order = await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: orderId }).forUpdate().first();
    if (!order || clean(order.status) !== "refunding") return;
    if (parseMetadata(order.metadata).membershipQuote) {
      await changeMembershipRefund(trx, order, "release");
      await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).update({ status: "paid", updatedAt: Date.now() });
      return;
    }
    const lot = await trx(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: order.creditLotId, userId: order.userId })
      .forUpdate()
      .first();
    if (!lot || clean(lot.status) !== "refund_pending") {
      throw new OnlinePaymentError("退款占用证据缺失，需要财务对账", 409, "PAYMENT_REFUND_RECONCILIATION_REQUIRED");
    }
    const wallet = await trx("o_account_wallet").where({ userId: order.userId }).forUpdate().first();
    const refundGuMicros = Number(order.creditedGuMicros);
    const cashReservedMicros = Number(wallet?.cashReservedMicros || 0);
    if (!wallet || cashReservedMicros < refundGuMicros) {
      throw new OnlinePaymentError("退款钱包占用证据缺失，需要财务对账", 409, "PAYMENT_REFUND_RECONCILIATION_REQUIRED");
    }
    const giftGrantId = clean(parseMetadata(order.metadata).giftGrantId);
    if (giftGrantId) await refundOrderGiftInTransaction(trx, { userId: Number(order.userId), grantId: giftGrantId, orderId: order.id, phase: "release" });
    const now = Date.now();
    const walletUpdated = await trx("o_account_wallet").where({ userId: order.userId, cashReservedMicros }).update({
      cashReservedMicros: cashReservedMicros - refundGuMicros,
      updatedAt: now,
    });
    const lotUpdated = await trx(COMMERCIAL_CREDIT_LOT_TABLE).where({ id: lot.id, status: "refund_pending" }).update({
      status: "active",
      updatedAt: now,
    });
    const orderUpdated = await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id, status: "refunding" }).update({
      status: "paid",
      updatedAt: now,
      revision: Number(order.revision || 0) + 1,
    });
    if (Number(walletUpdated || 0) !== 1 || Number(lotUpdated || 0) !== 1 || Number(orderUpdated || 0) !== 1) {
      throw new OnlinePaymentError("退款占用释放发生并发变化，需要财务对账", 409, "PAYMENT_REFUND_RECONCILIATION_REQUIRED");
    }
  });
}

async function finalizeRefund(orderId: string, evidence: ProviderPaymentResult) {
  return await db.transaction(async (trx) => {
    const order = await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: orderId }).forUpdate().first();
    if (!order) throw new OnlinePaymentError("支付订单不存在", 404, "PAYMENT_ORDER_NOT_FOUND");
    if (clean(order.status) === "refunded") return order;
    if (parseMetadata(order.metadata).membershipQuote) {
      await changeMembershipRefund(trx, order, "finalize");
      await insertPaymentEvent(trx, { orderId: order.id, eventKey: `refund:${order.id}:${evidence.providerOrderId || evidence.payloadDigest}`,
        eventType: "provider_refund_confirmed", payloadDigest: evidence.payloadDigest, status: "verified" });
      await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).update({ status: "refunded", refundedAmountMicros: Number(order.amountMicros),
        refundedAt: Date.now(), updatedAt: Date.now(), providerPayloadDigest: evidence.payloadDigest });
      return await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
    }
    const lot = await trx(COMMERCIAL_CREDIT_LOT_TABLE).where({ id: order.creditLotId, userId: order.userId }).forUpdate().first();
    if (
      !lot
      || clean(lot.status) !== "refund_pending"
      || Number(lot.remainingMicros) !== Number(lot.amountMicros)
      || Number(lot.reservedMicros) !== 0
    ) {
      throw new OnlinePaymentError("退款已成功但 GU 批次状态异常，需要财务对账", 409, "PAYMENT_REFUND_RECONCILIATION_REQUIRED");
    }
    const wallet = await trx("o_account_wallet").where({ userId: order.userId }).forUpdate().first();
    const refundGuMicros = Number(order.creditedGuMicros);
    const cashReservedMicros = Number(wallet?.cashReservedMicros || 0);
    if (!wallet || cashReservedMicros < refundGuMicros) {
      throw new OnlinePaymentError("退款已成功但钱包占用证据异常，需要财务对账", 409, "PAYMENT_REFUND_RECONCILIATION_REQUIRED");
    }
    const walletReservationReleased = await trx("o_account_wallet")
      .where({ userId: order.userId, cashReservedMicros })
      .update({ cashReservedMicros: cashReservedMicros - refundGuMicros, updatedAt: Date.now() });
    if (Number(walletReservationReleased || 0) !== 1) {
      throw new OnlinePaymentError("退款钱包占用已变化，需要财务对账", 409, "PAYMENT_REFUND_RECONCILIATION_REQUIRED");
    }
    const giftGrantId = clean(parseMetadata(order.metadata).giftGrantId);
    if (giftGrantId) await refundOrderGiftInTransaction(trx, { userId: Number(order.userId), grantId: giftGrantId, orderId: order.id, phase: "finalize" });
    await applyAccountWalletDebit(trx, {
      userId: Number(order.userId),
      workspaceId: clean(order.workspaceId),
      currency: "GU",
      type: "refund",
      amountMicros: Number(order.creditedGuMicros),
      idempotencyKey: `online-payment-refund:${order.id}`,
      description: "退还未使用的线上充值",
      metadata: { source: "online_payment_refund", paymentOrderId: order.id },
    });
    const lotUpdated = await trx(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: lot.id, status: "refund_pending", remainingMicros: lot.remainingMicros, reservedMicros: 0 })
      .update({ remainingMicros: 0, status: "refunded", updatedAt: Date.now() });
    if (Number(lotUpdated || 0) !== 1) throw new OnlinePaymentError("GU 批次已变化，需要财务对账", 409);
    const wholesaleAmount = Number(lot.wholesaleAmountMicros || 0);
    if (wholesaleAmount > 0) {
      await creditTenantSettlementInTransaction(trx, {
        tenantId: clean(order.sellerTenantId),
        amountMicros: wholesaleAmount,
        idempotencyKey: `refund-wholesale:${order.id}`,
        description: "用户充值退款，返还租户结算金",
        metadata: { paymentOrderId: order.id, creditLotId: lot.id },
      });
    }
    const now = Date.now();
    await insertPaymentEvent(trx, {
      orderId: clean(order.id),
      eventKey: `refund:${order.id}:${evidence.providerOrderId || evidence.payloadDigest}`,
      eventType: "provider_refund_confirmed",
      payloadDigest: evidence.payloadDigest,
      status: "verified",
    });
    await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).update({
      status: "refunded",
      refundedAmountMicros: Number(order.amountMicros),
      providerPayloadDigest: evidence.payloadDigest,
      refundedAt: now,
      updatedAt: now,
      revision: Number(order.revision || 0) + 1,
    });
    return await trx(ONLINE_PAYMENT_ORDER_TABLE).where({ id: order.id }).first();
  });
}

function assertRefundEvidenceMatchesOrder(order: any, evidence: ProviderPaymentResult): void {
  if (
    evidence.status === "refunded"
    && (Number(evidence.amountMicros) !== Number(order.amountMicros) || clean(evidence.currency) !== "CNY")
  ) {
    throw new OnlinePaymentError(
      "第三方退款金额或币种与订单不一致，需要财务对账",
      409,
      "PAYMENT_REFUND_EVIDENCE_MISMATCH",
    );
  }
}

export async function refundOnlinePayment(input: { tenant: CommercialTenant; orderId: string; userId: number; workspaceId: string }) {
  let order = await ownedOrder(input);
  if (clean(order.status) === "refunded") return publicOrder(order);
  const channel = await configuredOnlinePaymentChannel(input.tenant, order.channelKey);
  const notifyUrl = resolvePaymentNotifyUrl(input.tenant.id, channel);
  order = await reserveRefundFunds(clean(order.id));
  if (clean(order.status) === "refunded") return publicOrder(order);
  let evidence: ProviderPaymentResult;
  try {
    evidence = await refundProviderOrder(channel, providerOrderInput(order, notifyUrl));
  } catch (error) {
    if (!(error instanceof OnlinePaymentGatewayError) || !error.outcomeUnknown) {
      await releaseRefundFunds(clean(order.id));
    }
    throw error;
  }
  if (evidence.status === "refunded") {
    assertRefundEvidenceMatchesOrder(order, evidence);
    order = await finalizeRefund(clean(order.id), evidence);
  }
  return publicOrder(order);
}

export function onlinePaymentErrorResponse(error: unknown) {
  if (error instanceof MembershipError || error instanceof OnlinePaymentError || error instanceof OnlinePaymentGatewayError || error instanceof PaymentConfigError || error instanceof CommercialTenantError || error instanceof AccountGiftRefundError) {
    return { status: error.status, body: { message: error.message, code: error.code } };
  }
  return null;
}


/** Membership expiration changes entitlements only; it never changes either wallet bucket. */
export async function readPaidMembership(userId: number, tenantId: string, at = Date.now()) {
  const orders = await db(ONLINE_PAYMENT_ORDER_TABLE).where({ userId, sellerTenantId: tenantId, status: "paid" }).orderBy("paidAt", "asc").orderBy("id", "asc").select("metadata", "paidAt");
  let expiresAt = 0; let name = "";
  for (const order of orders) {
    const pack = parseMetadata(parseMetadata(order.metadata).creditPackage);
    if (pack.kind !== "membership" || Number(pack.membershipMonths) !== 1) continue;
    const startsAt = Math.max(Number(order.paidAt), expiresAt);
    expiresAt = addMembershipMonths(startsAt, 1);
    name = String(pack.name || "创作会员");
  }
  return expiresAt ? { name, expiresAt, active: expiresAt > at, balanceExpiresWithMembership: false } : null;
}
