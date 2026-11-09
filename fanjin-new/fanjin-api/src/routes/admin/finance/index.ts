import express from "express";
import { z } from "zod";
import {
  BillingError,
  billingCurrency,
  billingLedgerStatuses,
  deductWorkspace,
  guMicrosFromYuan,
  guMicrosPerYuan,
  allocateAccountWalletToWorkspaceInTransaction,
  refundWorkspace,
} from "@/lib/billing";
import {
  billingServiceRequestStatuses,
  billingServiceRequestTypes,
  updateBillingServiceRequest,
} from "@/lib/billingServiceRequests";
import {
  createFinanceIncomeRecord,
  ensureFinanceIncomeTable,
  financeIncomeStatuses,
} from "@/lib/financeIncome";
import {
  applyAccountWalletCredit,
  expireAccountGiftGrants,
  grantAccountGiftInTransaction,
  linkAccountWalletLedgerToIncomeRecord,
  listAccountGiftGrants,
  revokeAccountGiftGrant,
  setAccountCreditLimitInTransaction,
} from "@/lib/accountWallet";
import { readPlatformSettings } from "@/lib/platformSettings";
import { success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requireFinancePermission } from "@/middleware/permissions";
import { db } from "@/utils/db";
import { provisionMissingActiveWorkspaceBillingAccounts } from "@/lib/workspaceBillingAccount";

type RawPaymentChannel = Record<string, unknown>;

const router = express.Router();

const caseCategories = ["all", ...billingServiceRequestTypes] as const;
const caseStatuses = ["all", ...billingServiceRequestStatuses] as const;
const ledgerStatusFilters = ["all", ...billingLedgerStatuses] as const;
const incomeStatusFilters = ["all", ...financeIncomeStatuses] as const;
const adjustmentOperations = ["recharge", "deduct", "refund", "credit_increase", "credit_limit", "gift_grant"] as const;

const listCaseSchema = z.object({
  category: z.enum(caseCategories).optional().default("all"),
  status: z.enum(caseStatuses).optional().default("all"),
  workspaceId: z.string().trim().optional().nullable(),
  keyword: z.string().trim().optional().default(""),
  pageNum: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(200).optional().default(20),
});

const updateCaseSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(billingServiceRequestStatuses),
  reviewNote: z.string().trim().max(1000).optional().nullable(),
});

const listAccountSchema = z.object({
  keyword: z.string().trim().optional().default(""),
  status: z.enum(["all", "active", "suspended", "closed"]).optional().default("all"),
  billingMode: z.enum(["all", "prepaid", "postpaid", "hybrid"]).optional().default("all"),
  pageNum: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(200).optional().default(20),
});

const listLedgerSchema = z.object({
  workspaceId: z.string().trim().optional().nullable(),
  type: z.string().trim().optional().default("all"),
  status: z.enum(ledgerStatusFilters).optional().default("all"),
  keyword: z.string().trim().optional().default(""),
  pageNum: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(200).optional().default(20),
});

const listIncomeSchema = z.object({
  workspaceId: z.string().trim().optional().nullable(),
  channel: z.string().trim().optional().default("all"),
  status: z.enum(incomeStatusFilters).optional().default("all"),
  keyword: z.string().trim().optional().default(""),
  pageNum: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(200).optional().default(20),
});

const listGiftGrantSchema = z.object({
  userId: z.number().int().positive().optional().nullable(),
  status: z.enum(["all", "active", "expired", "exhausted", "revoked"]).optional().default("active"),
  expiringDays: z.number().int().positive().max(365).optional().nullable(),
  pageNum: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(200).optional().default(20),
});

const revokeGiftGrantSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().max(300).optional().nullable(),
});

const adjustmentSchema = z.object({
  workspaceId: z.string().trim().min(1),
  operation: z.enum(adjustmentOperations),
  amountMicros: z.number().int().min(0),
  description: z.string().trim().min(2).max(300),
  incomeAmountMicros: z.number().int().positive().optional().nullable(),
  incomeChannel: z.string().trim().max(80).optional().nullable(),
  incomeChannelName: z.string().trim().max(120).optional().nullable(),
  incomeMethod: z.string().trim().max(40).optional().nullable(),
  incomeTradeNo: z.string().trim().max(120).optional().nullable(),
  payerName: z.string().trim().max(120).optional().nullable(),
  paymentTime: z.number().int().positive().optional().nullable(),
  giftExpiresAt: z.number().int().positive().optional().nullable(),
  campaignName: z.string().trim().max(120).optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(200),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function operatorUserIdOf(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown): string {
  return String(value || "").trim();
}

function pageOffset(pageNum: number, pageSize: number): number {
  return (Math.max(1, pageNum) - 1) * Math.max(1, pageSize);
}

async function projectGiftGrantWorkspaces(items: any[]) {
  if (!items.length) return items;
  const userIds = Array.from(new Set(items.map((item) => Number(item.userId || 0)).filter((value) => value > 0)));
  const walletLedgers = userIds.length
    ? await db("o_account_wallet_ledger")
        .whereIn("userId", userIds)
        .where({ type: "gift_grant" })
        .select("userId", "workspaceId", "metadata", "createdAt")
        .orderBy("createdAt", "desc")
    : [];
  const workspaceByGrantId = new Map<string, string>();
  for (const ledger of walletLedgers) {
    const giftGrantId = cleanString(parseJsonObject(ledger.metadata).giftGrantId);
    const workspaceId = cleanString(ledger.workspaceId);
    if (giftGrantId && workspaceId && !workspaceByGrantId.has(giftGrantId)) {
      workspaceByGrantId.set(giftGrantId, workspaceId);
    }
  }
  const workspaceIds = Array.from(new Set(items.map((item) => {
    const metadataWorkspaceId = cleanString(parseJsonObject(item.metadata).workspaceId);
    return metadataWorkspaceId || workspaceByGrantId.get(String(item.id || "")) || "";
  }).filter(Boolean)));
  const workspaces = workspaceIds.length
    ? await db("o_workspace").whereIn("id", workspaceIds).select("id", "name")
    : [];
  const workspaceNames = new Map(workspaces.map((workspace: any) => [String(workspace.id), String(workspace.name || "")]));
  return items.map((item) => {
    const metadataWorkspaceId = cleanString(parseJsonObject(item.metadata).workspaceId);
    const workspaceId = metadataWorkspaceId || workspaceByGrantId.get(String(item.id || "")) || null;
    return {
      ...item,
      workspaceId,
      workspaceName: workspaceId ? workspaceNames.get(workspaceId) || null : null,
    };
  });
}

function requestPrefix(type: string): string {
  if (type === "offline_payment") return "PAY";
  if (type === "credit_limit") return "CRD";
  if (type === "invoice") return "INV";
  return "FIN";
}

function caseNo(row: any): string {
  const date = new Date(Number(row.createdAt || Date.now()));
  const datePart = Number.isNaN(date.getTime()) ? "00000000" : date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${requestPrefix(row.type)}-${datePart}-${String(row.id || "").slice(0, 8).toUpperCase()}`;
}

function amountViews(row: any) {
  const amountMicros = Number(row.amountMicros || 0);
  const currency = cleanString(row.currency || (row.type === "credit_limit" ? billingCurrency : "CNY")).toUpperCase();
  if (row.type === "credit_limit" || currency === billingCurrency) {
    return {
      amountMicros,
      currency: billingCurrency,
      amountGuMicros: amountMicros,
      amountCnyMicros: Math.round((amountMicros / guMicrosPerYuan) * 1_000_000),
    };
  }
  return {
    amountMicros,
    currency: "CNY",
    amountGuMicros: guMicrosFromYuan(amountMicros / 1_000_000),
    amountCnyMicros: amountMicros,
  };
}

function normalizeCase(row: any) {
  return {
    id: String(row.id),
    caseNo: caseNo(row),
    workspaceId: String(row.workspaceId || ""),
    workspaceName: row.workspaceName || row.workspaceId || "-",
    type: String(row.type),
    status: String(row.status || "pending"),
    ...amountViews(row),
    subjectName: row.subjectName || null,
    taxId: row.taxId || null,
    contactName: row.contactName || null,
    contactEmail: row.contactEmail || null,
    contactPhone: row.contactPhone || null,
    note: row.note || null,
    reviewNote: row.reviewNote || null,
    submittedByUserId: row.submittedByUserId == null ? null : Number(row.submittedByUserId),
    submittedByName: row.submittedByName || null,
    reviewedByUserId: row.reviewedByUserId == null ? null : Number(row.reviewedByUserId),
    reviewedByName: row.reviewedByName || null,
    reviewedAt: row.reviewedAt == null ? null : Number(row.reviewedAt),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

function normalizeLedger(row: any) {
  const metadata = parseJsonObject(row.metadata);
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId || ""),
    workspaceName: row.workspaceName || row.workspaceId || "-",
    scope: row.ledgerScope || "workspace",
    accountId: row.accountId || null,
    type: String(row.type || ""),
    direction: String(row.direction || ""),
    status: String(row.status || metadata.status || "succeeded"),
    amountMicros: Number(row.amountMicros || 0),
    currency: cleanString(row.currency || billingCurrency).toUpperCase(),
    balanceBeforeMicros: Number(row.balanceBeforeMicros ?? row.balanceBefore ?? 0),
    balanceAfterMicros: Number(row.balanceAfterMicros ?? row.balanceAfter ?? 0),
    reservedBeforeMicros: Number(row.reservedBefore ?? row.frozenBeforeMicros ?? 0),
    reservedAfterMicros: Number(row.reservedAfter ?? row.frozenAfterMicros ?? 0),
    remainingMicros: Number(row.remainingMicros ?? metadata.remainingMicros ?? 0),
    relatedLedgerId: row.relatedLedgerId || metadata.relatedLedgerId || null,
    taskId: row.relatedTaskId || row.taskId || metadata.taskId || null,
    usageRecordId: row.relatedUsageId || metadata.usageRecordId || null,
    requestId: row.requestId || metadata.requestId || null,
    description: row.description || null,
    metadata,
    operatorUserId: row.operatorUserId == null && row.createdBy == null ? null : Number(row.operatorUserId ?? row.createdBy),
    operatorName: row.operatorName || null,
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

function normalizeIncome(row: any) {
  const metadata = parseJsonObject(row.metadata);
  return {
    id: String(row.id || ""),
    workspaceId: String(row.workspaceId || ""),
    workspaceName: row.workspaceName || row.workspaceId || "-",
    ledgerId: row.ledgerId || null,
    ledgerType: row.ledgerType || null,
    serviceRequestId: row.serviceRequestId || null,
    channel: String(row.channel || "manual"),
    channelName: row.channelName || null,
    method: row.method || null,
    status: String(row.status || "confirmed"),
    amountMicros: Number(row.amountMicros || 0),
    currency: String(row.currency || "CNY").toUpperCase(),
    tradeNo: row.tradeNo || null,
    payerName: row.payerName || null,
    subjectName: row.subjectName || null,
    description: row.description || null,
    metadata,
    operatorUserId: row.operatorUserId == null ? null : Number(row.operatorUserId),
    operatorName: row.operatorName || null,
    paymentTime: row.paymentTime == null ? null : Number(row.paymentTime),
    confirmedAt: row.confirmedAt == null ? null : Number(row.confirmedAt),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

function normalizeAccount(row: any, lastLedgerAt?: number | null) {
  const balanceMicros = Number(row.balanceMicros || 0);
  const creditLimitMicros = Number(row.accountCreditLimitMicros ?? row.creditLimitMicros ?? 0);
  const reservedMicros = Number(row.reservedMicros || 0);
  const accountWalletBalanceMicros = Number(row.accountWalletBalanceMicros || 0);
  const accountGiftBalanceMicros = Number(row.accountGiftBalanceMicros || 0);
  const accountCashReservedMicros = Number(row.accountCashReservedMicros || 0);
  const accountGiftReservedMicros = Number(row.accountGiftReservedMicros || 0);
  const accountCreditUsedMicros = Number(row.accountCreditUsedMicros || 0);
  const accountCreditReservedMicros = Number(row.accountCreditReservedMicros || 0);
  const accountCashAvailableMicros = Math.max(0, accountWalletBalanceMicros - accountCashReservedMicros);
  const accountGiftAvailableMicros = Math.max(0, accountGiftBalanceMicros - accountGiftReservedMicros);
  const accountCreditAvailableMicros = Math.max(0, creditLimitMicros - accountCreditUsedMicros - accountCreditReservedMicros);
  const accountTotalAvailableMicros = accountCashAvailableMicros + accountGiftAvailableMicros + accountCreditAvailableMicros;
  const remainingQuotaMicros = Math.max(0, balanceMicros - reservedMicros);
  return {
    id: String(row.id || ""),
    workspaceId: String(row.workspaceId || ""),
    workspaceName: row.workspaceName || row.workspaceId || "-",
    ownerUserId: row.ownerUserId == null ? null : Number(row.ownerUserId),
    ownerName: row.ownerName || null,
    ownerEmail: row.ownerEmail || null,
    defaultWorkspaceId: row.defaultWorkspaceId || null,
    isDefaultWorkspace: Boolean(row.defaultWorkspaceId && row.defaultWorkspaceId === row.workspaceId),
    currency: cleanString(row.currency || billingCurrency).toUpperCase(),
    balanceMicros,
    creditLimitMicros,
    reservedMicros,
    availableMicros: Math.min(remainingQuotaMicros, accountTotalAvailableMicros),
    allocatedQuotaMicros: balanceMicros,
    remainingQuotaMicros,
    accountWalletId: row.accountWalletId || null,
    accountWalletBalanceMicros,
    accountGiftBalanceMicros,
    accountCashReservedMicros,
    accountGiftReservedMicros,
    accountCreditUsedMicros,
    accountCreditReservedMicros,
    accountCashAvailableMicros,
    accountGiftAvailableMicros,
    accountCreditAvailableMicros,
    accountTotalAvailableMicros,
    status: String(row.status || "active"),
    billingMode: String(row.billingMode || "prepaid"),
    planId: row.planId || null,
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    lastLedgerAt: lastLedgerAt || null,
  };
}

function parseChannels(raw: unknown): RawPaymentChannel[] {
  let parsed = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
  }
  return Array.isArray(parsed) ? (parsed.filter((item) => item && typeof item === "object") as RawPaymentChannel[]) : [];
}

function hasAnyField(channel: RawPaymentChannel, keys: string[]): boolean {
  return keys.some((key) => Boolean(cleanString(channel[key])));
}

function normalizeProtocol(channel: RawPaymentChannel): string {
  const protocol = cleanString(channel.protocol);
  if (protocol) return protocol;
  const key = cleanString(channel.key);
  if (key === "wechat_pay_v2") return "wechat_v2";
  if (key === "wechat_pay" || key === "wechat_pay_v3") return "wechat_v3";
  if (key === "alipay") return "alipay";
  if (key === "bank_card") return "offline_bank";
  if (key === "corporate_transfer") return "offline_corporate";
  return cleanString(channel.method) || "manual";
}

function channelCredentialConfigured(channel: RawPaymentChannel): boolean {
  const protocol = normalizeProtocol(channel);
  if (protocol === "wechat_v3") return hasAnyField(channel, ["appId", "mchId", "merchantId"]) && hasAnyField(channel, ["merchantSerialNo", "apiV3KeyRef", "privateKeyRef"]);
  if (protocol === "wechat_v2") return hasAnyField(channel, ["appId", "mchId", "merchantId"]) && hasAnyField(channel, ["apiV2KeyRef", "certP12Ref"]);
  if (protocol === "alipay") return hasAnyField(channel, ["alipayAppId", "merchantId"]) && hasAnyField(channel, ["alipayPrivateKeyRef", "alipayPublicKeyRef"]);
  if (cleanString(channel.method) === "manual") return true;
  return Boolean(
    cleanString(channel.accountName)
    && ((cleanString(channel.accountNo) && cleanString(channel.bankName)) || cleanString(channel.qrCodeUrl)),
  );
}

async function paymentChannels() {
  const { settings } = await readPlatformSettings();
  return parseChannels(settings["platform.payment.channels"])
    .map((channel) => ({
      key: cleanString(channel.key),
      name: cleanString(channel.name) || cleanString(channel.key),
      method: cleanString(channel.method) || "manual",
      protocol: normalizeProtocol(channel),
      scene: cleanString(channel.scene) || null,
      enabled: Boolean(channel.enabled),
      default: Boolean(channel.default),
      autoConfirm: Boolean(channel.autoConfirm),
      minAmountYuan: Number(channel.minAmountYuan || 0),
      maxAmountYuan: Number(channel.maxAmountYuan || 0),
      sort: Number(channel.sort || 0),
      credentialConfigured: channelCredentialConfigured(channel),
    }))
    .filter((channel) => channel.key)
    .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
}

async function paymentChannelMeta(key?: string | null) {
  const channelKey = cleanString(key);
  if (!channelKey || channelKey === "manual") {
    return { key: "manual", name: "财务手动入账", method: "manual" };
  }
  const channel = (await paymentChannels()).find((item) => (
    item.key === channelKey
    && item.enabled
    && item.credentialConfigured
    && item.method !== "online"
  ));
  if (!channel) return null;
  return {
    key: channelKey,
    name: channel.name,
    method: channel.method,
  };
}

async function workspaceOwnerUserId(workspaceId: string): Promise<number> {
  const row = await db("o_workspace").where({ id: workspaceId }).select("ownerUserId").first();
  const userId = Number(row?.ownerUserId || 0);
  if (!userId) throw new BillingError("找不到工作区负责人，无法给账号钱包入账", 400);
  return userId;
}

async function latestLedgerMap(workspaceIds: string[]): Promise<Map<string, number>> {
  if (!workspaceIds.length) return new Map();
  const rows = await db("o_billing_ledger")
    .whereIn("workspaceId", workspaceIds)
    .select("workspaceId")
    .max<{ workspaceId: string; lastLedgerAt: number }[]>({ lastLedgerAt: "createdAt" })
    .groupBy("workspaceId");
  return new Map(rows.map((row: any) => [String(row.workspaceId), Number(row.lastLedgerAt || 0)]));
}

async function overview() {
  await ensureFinanceIncomeTable();
  await provisionMissingActiveWorkspaceBillingAccounts(db);
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const [accountRows, walletRows, requestRows, todayLedgerRows, todayIncomeRows, channels] = await Promise.all([
    db("o_billing_account").select("*"),
    db("o_account_wallet").select("*"),
    db("o_billing_service_request").select("*"),
    db("o_billing_ledger").where("createdAt", ">=", todayStart).select("type", "amountMicros", "direction", "status"),
    db("o_finance_income_record").where("createdAt", ">=", todayStart).select("amountMicros", "channel", "method", "status"),
    paymentChannels(),
  ]);

  const accounts = accountRows.map((row: any) => normalizeAccount(row));
  const cases = requestRows.map((row: any) => normalizeCase(row));
  const pendingCases = cases.filter((item) => item.status === "pending");
  const onlineChannels = channels.filter((channel) => channel.method === "online");
  const offlineChannels = channels.filter((channel) => channel.method === "offline");

  const sum = (rows: Array<Record<string, any>>, key: string) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const countBy = (rows: Array<Record<string, any>>, key: string) =>
    rows.reduce<Record<string, number>>((acc, row) => {
      const value = String(row[key] || "unknown");
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    }, {});

  const todayCreditMicros = todayLedgerRows
    .filter((row: any) => row.direction === "credit")
    .reduce((total: number, row: any) => total + Number(row.amountMicros || 0), 0);
  const todayDebitMicros = todayLedgerRows
    .filter((row: any) => row.direction === "debit")
    .reduce((total: number, row: any) => total + Number(row.amountMicros || 0), 0);

  return {
    account: {
      total: accounts.length,
      active: accounts.filter((item) => item.status === "active").length,
      prepaid: accounts.filter((item) => item.billingMode === "prepaid").length,
      postpaid: accounts.filter((item) => item.billingMode === "postpaid").length,
      hybrid: accounts.filter((item) => item.billingMode === "hybrid").length,
      balanceMicros: sum(accounts, "balanceMicros"),
      creditLimitMicros: sum(accounts, "creditLimitMicros"),
      reservedMicros: sum(accounts, "reservedMicros"),
      availableMicros: sum(accounts, "availableMicros"),
      walletTotal: walletRows.length,
      accountWalletBalanceMicros: walletRows.reduce((total: number, row: any) => total + Number(row.balanceMicros || 0), 0),
    },
    cases: {
      total: cases.length,
      pending: pendingCases.length,
      byType: countBy(cases, "type"),
      byStatus: countBy(cases, "status"),
      pendingCnyMicros: pendingCases.reduce((total, item) => total + Number(item.amountCnyMicros || 0), 0),
      pendingGuMicros: pendingCases.reduce((total, item) => total + Number(item.amountGuMicros || 0), 0),
    },
    ledger: {
      todayCreditMicros,
      todayDebitMicros,
      todayCount: todayLedgerRows.length,
    },
    income: {
      todayCnyMicros: todayIncomeRows
        .filter((row: any) => row.status === "confirmed")
        .reduce((total: number, row: any) => total + Number(row.amountMicros || 0), 0),
      todayCount: todayIncomeRows.length,
      byChannel: countBy(todayIncomeRows, "channel"),
    },
    reconciliation: {
      pendingOfflinePayments: pendingCases.filter((item) => item.type === "offline_payment").length,
      approvedOfflinePayments: cases.filter((item) => item.type === "offline_payment" && item.status === "approved").length,
      enabledChannels: channels.filter((channel) => channel.enabled).length,
      onlineChannels: onlineChannels.length,
      offlineChannels: offlineChannels.length,
      channelsMissingCredentials: channels.filter((channel) => channel.enabled && !channel.credentialConfigured).length,
    },
    channels,
    generatedAt: Date.now(),
  };
}

router.use(requireFinancePermission("finance:read"));

router.post("/overview", async (_req, res) => {
  await expireAccountGiftGrants();
  res.status(200).send(success(await overview()));
});

router.post("/cases/list", async (req, res) => {
  const parsed = listCaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const filters = parsed.data;
  const query = db("o_billing_service_request as r")
    .leftJoin("o_workspace as w", "r.workspaceId", "w.id")
    .leftJoin("o_user as submitter", "r.submittedByUserId", "submitter.id")
    .leftJoin("o_user as reviewer", "r.reviewedByUserId", "reviewer.id");

  if (filters.category !== "all") query.where("r.type", filters.category);
  if (filters.status !== "all") query.where("r.status", filters.status);
  if (filters.workspaceId) query.where("r.workspaceId", filters.workspaceId);
  if (filters.keyword) {
    const keyword = `%${filters.keyword}%`;
    query.where((builder) => {
      builder
        .where("r.id", "like", keyword)
        .orWhere("r.subjectName", "like", keyword)
        .orWhere("r.taxId", "like", keyword)
        .orWhere("r.contactName", "like", keyword)
        .orWhere("r.contactPhone", "like", keyword)
        .orWhere("r.note", "like", keyword)
        .orWhere("w.name", "like", keyword);
    });
  }

  const countRow = await query.clone().count<{ total: number }[]>({ total: "r.id" }).first();
  const rows = await query
    .clone()
    .select(
      "r.*",
      "w.name as workspaceName",
      "submitter.displayName as submittedByName",
      "reviewer.displayName as reviewedByName",
    )
    .orderBy("r.createdAt", "desc")
    .limit(filters.pageSize)
    .offset(pageOffset(filters.pageNum, filters.pageSize));

  res.status(200).send(success({ items: rows.map(normalizeCase), total: Number((countRow as any)?.total || 0), pageNum: filters.pageNum, pageSize: filters.pageSize }));
});

router.post("/cases/update", requireFinancePermission("finance:approve"), async (req, res) => {
  const parsed = updateCaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const data = await updateBillingServiceRequest({
      ...parsed.data,
      reviewedByUserId: operatorUserIdOf(req),
    });
    await writeAuditLog(req, {
      workspaceId: data.workspaceId,
      action: "finance.case.update",
      resourceType: "billing_service_request",
      resourceId: data.id,
      metadata: parsed.data,
    });
    res.status(200).send(success(data));
  } catch (err) {
    if (err instanceof BillingError) return res.status(err.status).send({ message: err.message });
    throw err;
  }
});

router.post("/accounts/list", async (req, res) => {
  const parsed = listAccountSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  await expireAccountGiftGrants();
  await provisionMissingActiveWorkspaceBillingAccounts(db);
  const filters = parsed.data;
  const query = db("o_billing_account as a")
    .leftJoin("o_workspace as w", "a.workspaceId", "w.id")
    .leftJoin("o_user as owner", "w.ownerUserId", "owner.id")
    .leftJoin("o_account_wallet as aw", "w.ownerUserId", "aw.userId");

  if (filters.status !== "all") query.where("a.status", filters.status);
  if (filters.billingMode !== "all") query.where("a.billingMode", filters.billingMode);
  if (filters.keyword) {
    const keyword = `%${filters.keyword}%`;
    query.where((builder) => {
      builder
        .where("a.workspaceId", "like", keyword)
        .orWhere("w.name", "like", keyword)
        .orWhere("owner.name", "like", keyword)
        .orWhere("owner.displayName", "like", keyword)
        .orWhere("owner.email", "like", keyword);
    });
  }

  const countRow = await query.clone().count<{ total: number }[]>({ total: "a.id" }).first();
  const rows = await query
    .clone()
    .select(
      "a.*",
      "w.name as workspaceName",
      "w.ownerUserId",
      "owner.displayName as ownerName",
      "owner.email as ownerEmail",
      "owner.defaultWorkspaceId",
      "aw.id as accountWalletId",
      "aw.balanceMicros as accountWalletBalanceMicros",
      "aw.giftBalanceMicros as accountGiftBalanceMicros",
      "aw.cashReservedMicros as accountCashReservedMicros",
      "aw.giftReservedMicros as accountGiftReservedMicros",
      "aw.creditLimitMicros as accountCreditLimitMicros",
      "aw.creditUsedMicros as accountCreditUsedMicros",
      "aw.creditReservedMicros as accountCreditReservedMicros",
    )
    .orderBy("a.updatedAt", "desc")
    .limit(filters.pageSize)
    .offset(pageOffset(filters.pageNum, filters.pageSize));

  const lastLedger = await latestLedgerMap(rows.map((row: any) => String(row.workspaceId)).filter(Boolean));
  res.status(200).send(
    success({
      items: rows.map((row: any) => normalizeAccount(row, lastLedger.get(String(row.workspaceId)) || null)),
      total: Number((countRow as any)?.total || 0),
      pageNum: filters.pageNum,
      pageSize: filters.pageSize,
    }),
  );
});

router.post("/gift-grants/list", async (req, res) => {
  const parsed = listGiftGrantSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  await expireAccountGiftGrants();
  const expiringBefore = parsed.data.expiringDays ? Date.now() + parsed.data.expiringDays * 24 * 60 * 60 * 1000 : null;
  const result = await listAccountGiftGrants({
    userId: parsed.data.userId,
    status: parsed.data.status,
    expiringBefore,
    pageNum: parsed.data.pageNum,
    pageSize: parsed.data.pageSize,
  });
  res.status(200).send(success({
    ...result,
    items: await projectGiftGrantWorkspaces(result.items),
  }));
});

router.post("/gift-grants/revoke", requireFinancePermission("finance:approve"), async (req, res) => {
  const parsed = revokeGiftGrantSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const result = await revokeAccountGiftGrant({
      id: parsed.data.id,
      description: parsed.data.description || "后台撤销赠送 GU",
      operatorUserId: operatorUserIdOf(req),
    });
    await writeAuditLog(req, {
      workspaceId: null,
      action: "finance.giftGrant.revoke",
      resourceType: "account_gift_grant",
      resourceId: parsed.data.id,
      metadata: { amountMicros: result.ledger.amountMicros, description: parsed.data.description || null },
    });
    res.status(200).send(success(result));
  } catch (err: any) {
    res.status(/不存在/.test(err?.message || "") ? 404 : 400).send({ message: err?.message || "撤销赠送 GU 失败" });
  }
});

router.post("/ledger/list", async (req, res) => {
  const parsed = listLedgerSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const filters = parsed.data;
  const limitForMerge = pageOffset(filters.pageNum, filters.pageSize) + filters.pageSize;
  const query = db("o_billing_ledger as l")
    .leftJoin("o_workspace as w", "l.workspaceId", "w.id")
    .leftJoin("o_user as operator", "l.createdBy", "operator.id");
  const walletQuery = db("o_account_wallet_ledger as l")
    .leftJoin("o_workspace as w", "l.workspaceId", "w.id")
    .leftJoin("o_user as operator", "l.operatorUserId", "operator.id");

  if (filters.workspaceId) query.where("l.workspaceId", filters.workspaceId);
  if (filters.type !== "all") query.where("l.type", filters.type);
  if (filters.status !== "all") query.where("l.status", filters.status);
  if (filters.keyword) {
    const keyword = `%${filters.keyword}%`;
    query.where((builder) => {
      builder
        .where("l.id", "like", keyword)
        .orWhere("l.description", "like", keyword)
        .orWhere("l.requestId", "like", keyword)
        .orWhere("w.name", "like", keyword);
    });
  }
  if (filters.workspaceId) walletQuery.where("l.workspaceId", filters.workspaceId);
  if (filters.type !== "all") walletQuery.where("l.type", filters.type);
  if (filters.status !== "all" && filters.status !== "succeeded") walletQuery.whereRaw("1 = 0");
  if (filters.keyword) {
    const keyword = `%${filters.keyword}%`;
    walletQuery.where((builder) => {
      builder
        .where("l.id", "like", keyword)
        .orWhere("l.description", "like", keyword)
        .orWhere("l.requestId", "like", keyword)
        .orWhere("w.name", "like", keyword);
    });
  }

  const [countRow, walletCountRow, rows, walletRows] = await Promise.all([
    query.clone().count<{ total: number }[]>({ total: "l.id" }).first(),
    walletQuery.clone().count<{ total: number }[]>({ total: "l.id" }).first(),
    query
      .clone()
      .select(
        "l.*",
        "w.name as workspaceName",
        "operator.displayName as operatorName",
        db.raw("? AS ??", ["workspace", "ledgerScope"]),
      )
      .orderBy("l.createdAt", "desc")
      .limit(limitForMerge),
    walletQuery
      .clone()
      .select(
        "l.*",
        "w.name as workspaceName",
        "operator.displayName as operatorName",
        db.raw("? AS ??", ["account_wallet", "ledgerScope"]),
      )
      .orderBy("l.createdAt", "desc")
      .limit(limitForMerge),
  ]);
  const offset = pageOffset(filters.pageNum, filters.pageSize);
  const rowsForPage = [...rows, ...walletRows]
    .sort((a: any, b: any) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(offset, offset + filters.pageSize);

  res.status(200).send(
    success({
      items: rowsForPage.map(normalizeLedger),
      total: Number((countRow as any)?.total || 0) + Number((walletCountRow as any)?.total || 0),
      pageNum: filters.pageNum,
      pageSize: filters.pageSize,
    }),
  );
});

router.post("/income/list", async (req, res) => {
  const parsed = listIncomeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  await ensureFinanceIncomeTable();
  const filters = parsed.data;
  const query = db("o_finance_income_record as i")
    .leftJoin("o_workspace as w", "i.workspaceId", "w.id")
    .leftJoin("o_billing_ledger as l", "i.ledgerId", "l.id")
    .leftJoin("o_user as operator", "i.operatorUserId", "operator.id");

  if (filters.workspaceId) query.where("i.workspaceId", filters.workspaceId);
  if (filters.channel !== "all") query.where("i.channel", filters.channel);
  if (filters.status !== "all") query.where("i.status", filters.status);
  if (filters.keyword) {
    const keyword = `%${filters.keyword}%`;
    query.where((builder) => {
      builder
        .where("i.id", "like", keyword)
        .orWhere("i.tradeNo", "like", keyword)
        .orWhere("i.payerName", "like", keyword)
        .orWhere("i.subjectName", "like", keyword)
        .orWhere("i.description", "like", keyword)
        .orWhere("i.channelName", "like", keyword)
        .orWhere("w.name", "like", keyword);
    });
  }

  const countRow = await query.clone().count<{ total: number }[]>({ total: "i.id" }).first();
  const rows = await query
    .clone()
    .select("i.*", "w.name as workspaceName", "l.type as ledgerType", "operator.displayName as operatorName")
    .orderBy("i.createdAt", "desc")
    .limit(filters.pageSize)
    .offset(pageOffset(filters.pageNum, filters.pageSize));

  res.status(200).send(success({ items: rows.map(normalizeIncome), total: Number((countRow as any)?.total || 0), pageNum: filters.pageNum, pageSize: filters.pageSize }));
});

router.post("/reconciliation/list", async (req, res) => {
  const parsed = listCaseSchema.safeParse({ ...(req.body || {}), category: "offline_payment" });
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  await ensureFinanceIncomeTable();
  const filters = parsed.data;
  const casesQuery = db("o_billing_service_request as r")
    .leftJoin("o_workspace as w", "r.workspaceId", "w.id")
    .where("r.type", "offline_payment");
  if (filters.status !== "all") casesQuery.where("r.status", filters.status);
  if (filters.workspaceId) casesQuery.where("r.workspaceId", filters.workspaceId);

  const countRow = await casesQuery.clone().count<{ total: number }[]>({ total: "r.id" }).first();
  const rows = await casesQuery
    .clone()
    .select("r.*", "w.name as workspaceName")
    .orderBy("r.createdAt", "desc")
    .limit(filters.pageSize)
    .offset(pageOffset(filters.pageNum, filters.pageSize));
  const ledgers = await db("o_billing_ledger as l")
    .leftJoin("o_workspace as w", "l.workspaceId", "w.id")
    .where("l.type", "recharge")
    .orderBy("l.createdAt", "desc")
    .limit(30)
    .select("l.*", "w.name as workspaceName", db.raw("? AS ??", ["workspace", "ledgerScope"]));
  const walletLedgers = await db("o_account_wallet_ledger as l")
    .leftJoin("o_workspace as w", "l.workspaceId", "w.id")
    .whereIn("l.type", ["recharge", "manual_credit"])
    .orderBy("l.createdAt", "desc")
    .limit(30)
    .select("l.*", "w.name as workspaceName", db.raw("? AS ??", ["account_wallet", "ledgerScope"]));
  const incomeRows = await db("o_finance_income_record as i")
    .leftJoin("o_workspace as w", "i.workspaceId", "w.id")
    .leftJoin("o_billing_ledger as l", "i.ledgerId", "l.id")
    .orderBy("i.createdAt", "desc")
    .limit(30)
    .select("i.*", "w.name as workspaceName", "l.type as ledgerType");

  res.status(200).send(
    success({
      channels: await paymentChannels(),
      offlinePayments: rows.map(normalizeCase),
      recentRechargeLedgers: [...ledgers, ...walletLedgers]
        .sort((a: any, b: any) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, 30)
        .map(normalizeLedger),
      recentIncomeRecords: incomeRows.map(normalizeIncome),
      total: Number((countRow as any)?.total || 0),
      pageNum: filters.pageNum,
      pageSize: filters.pageSize,
    }),
  );
});

router.post("/adjustments/create", requireFinancePermission("finance:approve"), async (req, res) => {
  const parsed = adjustmentSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const data = parsed.data;
  const operatorUserId = operatorUserIdOf(req);
  const idempotencyKey = data.idempotencyKey;
  const metadata = {
    ...(data.metadata || {}),
    source: "finance_center",
    operation: data.operation,
    workspaceId: data.workspaceId,
  };

  try {
    if (data.operation !== "credit_limit" && data.amountMicros <= 0) {
      throw new BillingError("调账金额必须大于 0");
    }
    const ownerUserId = await workspaceOwnerUserId(data.workspaceId);
    const ownerWallet = await db("o_account_wallet").where({ userId: ownerUserId }).first();
    const currentAccountCreditMicros = Number(ownerWallet?.creditLimitMicros || 0);
    const creditTargetMicros =
      data.operation === "credit_increase"
        ? currentAccountCreditMicros + data.amountMicros
        : data.amountMicros;
    const expectedIncomeAmountMicros = Math.round((data.amountMicros / guMicrosPerYuan) * 1_000_000);
    const incomeAmountMicros = data.operation === "recharge"
      ? Number(data.incomeAmountMicros ?? expectedIncomeAmountMicros)
      : 0;
    if (data.operation === "recharge" && incomeAmountMicros !== expectedIncomeAmountMicros) {
      throw new BillingError("人民币收款金额与 GU 充值金额不匹配");
    }
    const channelMeta = data.operation === "recharge" ? await paymentChannelMeta(data.incomeChannel) : null;
    if (data.operation === "recharge" && data.incomeChannel && !channelMeta) {
      throw new BillingError("未知付款渠道，拒绝充值入账");
    }
    let result: any;
    let incomeRecord: Awaited<ReturnType<typeof createFinanceIncomeRecord>> | null = null;
    if (data.operation === "recharge") {
      await ensureFinanceIncomeTable();
      const atomicRecharge = await db.transaction(async (trx) => {
        const walletCredit = await applyAccountWalletCredit(trx, {
          userId: ownerUserId,
          workspaceId: data.workspaceId,
          amountMicros: data.amountMicros,
          currency: billingCurrency,
          type: "manual_credit",
          description: data.description,
          metadata: {
            ...metadata,
            accountWalletUserId: ownerUserId,
          },
          idempotencyKey,
          operatorUserId,
        });
        const income = await createFinanceIncomeRecord({
          workspaceId: data.workspaceId,
          amountMicros: incomeAmountMicros,
          channel: channelMeta?.key || "manual",
          channelName: data.incomeChannelName || channelMeta?.name || "财务手动入账",
          method: data.incomeMethod || channelMeta?.method || "manual",
          status: "confirmed",
          ledgerId: null,
          tradeNo: data.incomeTradeNo || null,
          payerName: data.payerName || null,
          subjectName: data.payerName || null,
          description: data.description,
          paymentTime: data.paymentTime || null,
          idempotencyKey: `finance-income-adjustment-${walletCredit.ledger.id}`,
          metadata: {
            ...metadata,
            guAmountMicros: data.amountMicros,
            inputIncomeAmountMicros: data.incomeAmountMicros ?? null,
            accountWalletLedgerId: walletCredit.ledger.id,
            accountWalletUserId: walletCredit.wallet.userId,
          },
          operatorUserId,
        }, trx);
        await linkAccountWalletLedgerToIncomeRecord(trx, walletCredit.ledger.id, income.id);
        return { result: walletCredit, incomeRecord: income };
      });
      result = atomicRecharge.result;
      incomeRecord = atomicRecharge.incomeRecord;
    } else if (data.operation === "deduct") {
      result = await deductWorkspace({
        workspaceId: data.workspaceId,
        amountMicros: data.amountMicros,
        currency: billingCurrency,
        description: data.description,
        metadata: { ...metadata, skipAccountWalletAutoFund: true },
        idempotencyKey,
        operatorUserId,
      });
    } else if (data.operation === "refund") {
      result = await refundWorkspace({
        workspaceId: data.workspaceId,
        amountMicros: data.amountMicros,
        currency: billingCurrency,
        description: data.description,
        metadata,
        idempotencyKey,
        operatorUserId,
      });
    } else if (data.operation === "gift_grant") {
      result = await db.transaction(async (trx) => {
        const gift = await grantAccountGiftInTransaction(trx, {
          userId: ownerUserId,
          workspaceId: data.workspaceId,
          amountMicros: data.amountMicros,
          currency: billingCurrency,
          description: data.description,
          campaignName: data.campaignName,
          expiresAt: data.giftExpiresAt,
          metadata,
          idempotencyKey,
          operatorUserId,
        });
        const allocation = await allocateAccountWalletToWorkspaceInTransaction(trx, {
          userId: ownerUserId,
          workspaceId: data.workspaceId,
          amountMicros: data.amountMicros,
          description: `${data.description}（同步到工作区可用额度）`,
          metadata: {
            ...metadata,
            source: "admin_gift_grant",
            giftGrantId: gift.grant.id,
          },
          idempotencyKey: idempotencyKey ? `gift-allocation:${idempotencyKey}` : null,
          operatorUserId,
        });
        return {
          ...gift,
          workspaceAccount: allocation.workspaceAccount,
          workspaceLedger: allocation.workspaceLedger,
        };
      });
    } else {
      result = await db.transaction(async (trx) => {
        const credit = await setAccountCreditLimitInTransaction(trx, {
          userId: ownerUserId,
          workspaceId: data.workspaceId,
          amountMicros: Math.abs(creditTargetMicros - currentAccountCreditMicros),
          creditLimitMicros: creditTargetMicros,
          currency: billingCurrency,
          description: data.description,
          metadata: {
            ...metadata,
            creditDeltaMicros: data.operation === "credit_increase" ? data.amountMicros : null,
          },
          idempotencyKey,
          operatorUserId,
        });
        const positiveDeltaMicros = credit.ledger.direction === "credit"
          ? Number(credit.ledger.amountMicros || 0)
          : 0;
        if (!positiveDeltaMicros) return credit;
        const allocation = await allocateAccountWalletToWorkspaceInTransaction(trx, {
          userId: ownerUserId,
          workspaceId: data.workspaceId,
          amountMicros: positiveDeltaMicros,
          description: `${data.description}（同步到工作区可用额度）`,
          metadata: {
            ...metadata,
            source: "admin_credit_limit",
            accountWalletLedgerId: credit.ledger.id,
            creditTargetMicros,
          },
          idempotencyKey: `credit-allocation:${idempotencyKey}`,
          operatorUserId,
        });
        return {
          ...credit,
          workspaceAccount: allocation.workspaceAccount,
          workspaceLedger: allocation.workspaceLedger,
        };
      });
    }

    await writeAuditLog(req, {
      workspaceId: data.workspaceId,
      action: "finance.adjustment.create",
      resourceType: ["recharge", "gift_grant", "credit_increase", "credit_limit"].includes(data.operation)
        ? "account_wallet_ledger"
        : "billing_ledger",
      resourceId: result.ledger.id,
      metadata: {
        ...metadata,
        amountMicros: data.amountMicros,
        creditTargetMicros: data.operation === "credit_increase" || data.operation === "credit_limit" ? creditTargetMicros : null,
        incomeRecordId: incomeRecord?.id || null,
        description: data.description,
      },
    });

    res.status(200).send(success({ ...result, incomeRecord }));
  } catch (err) {
    if (err instanceof BillingError) return res.status(err.status).send({ message: err.message });
    const message = err instanceof Error ? err.message : "财务调账失败";
    if (/不足/.test(message)) return res.status(402).send({ message });
    return res.status(400).send({ message });
  }
});

export default router;
