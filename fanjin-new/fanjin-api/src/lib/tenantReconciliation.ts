import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { db } from "@/utils/db";
import {
  CONSUMPTION_ALLOCATION_TABLE,
  PROVIDER_COST_LEDGER_TABLE,
  TENANT_SETTLEMENT_PERIOD_TABLE,
  settlementV2Mode,
} from "@/lib/tenantAttribution";
import {
  TENANT_SETTLEMENT_LEDGER_TABLE,
  COMMERCIAL_CREDIT_LOT_TABLE,
} from "@/lib/commercialTenant";

export type ReconciliationDb = Knex | Knex.Transaction;

export type TenantDimensionKey = "collectorTenantId" | "registeredTenantIdSnapshot" | "ownerTenantIdSnapshot";

export type PaymentDimensionSummary = {
  tenantId: string;
  paidOrders: number;
  paidAmountMicros: number;
  refundedAmountMicros: number;
  netAmountMicros: number;
};

export type ConsumptionDimensionSummary = {
  tenantId: string;
  allocations: number;
  chargedGuMicros: number;
  retailPortionMicros: number;
  wholesaleAccrualMicros: number;
};

export type ProviderCostSummary = {
  provider: string;
  estimatedCostMicros: number;
  officialCostMicros: number;
  differenceMicros: number;
  pendingConfirmation: number;
};

export type ShadowAlignmentRow = {
  tenantId: string;
  legacyChargedMicros: number;
  shadowAccruedMicros: number;
  unconsumedMicros: number;
  differenceMicros: number;
};

export type ReconciliationSummary = {
  mode: "off" | "shadow" | "active";
  byCollector: PaymentDimensionSummary[];
  consumptionByCollector: ConsumptionDimensionSummary[];
  consumptionByRegistered: ConsumptionDimensionSummary[];
  consumptionByOwner: ConsumptionDimensionSummary[];
  providerCosts: ProviderCostSummary[];
  shadowAlignment: {
    aligned: boolean;
    rows: ShadowAlignmentRow[];
    note: string;
  };
};

function tenantNameOf(tenantId: string): string {
  return tenantId;
}

async function paymentSummaryByCollector(database: ReconciliationDb): Promise<PaymentDimensionSummary[]> {
  const rows = await (database as any)("o_payment_order")
    .where({ status: "paid" })
    .select("collectorTenantId", "sellerTenantId")
    .count("* as paidOrders")
    .sum("amountMicros as paidAmountMicros")
    .sum("refundedAmountMicros as refundedAmountMicros")
    .groupBy("collectorTenantId", "sellerTenantId");
  const merged = new Map<string, PaymentDimensionSummary>();
  for (const row of rows) {
    const tenantId = String(row.collectorTenantId || row.sellerTenantId || "FANJIN");
    const paidAmountMicros = Number(row.paidAmountMicros || 0);
    const refundedAmountMicros = Number(row.refundedAmountMicros || 0);
    const existing = merged.get(tenantId);
    if (existing) {
      existing.paidOrders += Number(row.paidOrders || 0);
      existing.paidAmountMicros += paidAmountMicros;
      existing.refundedAmountMicros += refundedAmountMicros;
      existing.netAmountMicros = existing.paidAmountMicros - existing.refundedAmountMicros;
    } else {
      merged.set(tenantId, {
        tenantId,
        paidOrders: Number(row.paidOrders || 0),
        paidAmountMicros,
        refundedAmountMicros,
        netAmountMicros: paidAmountMicros - refundedAmountMicros,
      });
    }
  }
  return [...merged.values()].sort((left, right) => left.tenantId.localeCompare(right.tenantId));
}

async function consumptionSummary(
  database: ReconciliationDb,
  dimension: TenantDimensionKey,
): Promise<ConsumptionDimensionSummary[]> {
  const rows = await (database as any)(CONSUMPTION_ALLOCATION_TABLE)
    .select(dimension)
    .count("* as allocations")
    .sum("chargedGuMicros as chargedGuMicros")
    .sum("retailPortionMicros as retailPortionMicros")
    .sum("wholesaleAccrualMicros as wholesaleAccrualMicros")
    .groupBy(dimension);
  return rows.map((row: any) => ({
    tenantId: String(row[dimension] || "FANJIN"),
    allocations: Number(row.allocations || 0),
    chargedGuMicros: Number(row.chargedGuMicros || 0),
    retailPortionMicros: Number(row.retailPortionMicros || 0),
    wholesaleAccrualMicros: Number(row.wholesaleAccrualMicros || 0),
  })).sort((left: ConsumptionDimensionSummary, right: ConsumptionDimensionSummary) =>
    left.tenantId.localeCompare(right.tenantId));
}

async function providerCostSummary(database: ReconciliationDb): Promise<ProviderCostSummary[]> {
  const rows = await (database as any)(PROVIDER_COST_LEDGER_TABLE)
    .select("provider")
    .count("* as total")
    .sum("estimatedCostMicros as estimatedCostMicros")
    .sum("officialCostMicros as officialCostMicros")
    .sum("differenceMicros as differenceMicros")
    .groupBy("provider");
  return rows.map((row: any) => ({
    provider: String(row.provider || "unknown"),
    estimatedCostMicros: Number(row.estimatedCostMicros || 0),
    officialCostMicros: Number(row.officialCostMicros || 0),
    differenceMicros: Number(row.differenceMicros || 0),
    pendingConfirmation: Number(row.total || 0),
  }));
}

/**
 * 影子账对齐（设计文档 §7.9/§21 MT-P0-06）：
 * - 旧账：o_tenant_settlement_ledger 的 recharge_wholesale 累计借记（充值时点）
 * - 新账：o_commercial_consumption_allocation 的 wholesaleAccrual 累计（消费时点）
 * - 差异 = 旧账借记 - 新账应计；其经济含义是"充值已扣但尚未消费"的批发部分。
 *   只有当所有批次完全消费或完全退款时两口径才会相等。
 */
export async function shadowAlignmentReport(database: ReconciliationDb): Promise<{
  aligned: boolean;
  rows: ShadowAlignmentRow[];
}> {
  const legacyRows = await (database as any)(TENANT_SETTLEMENT_LEDGER_TABLE)
    .where({ type: "recharge_wholesale", direction: "debit" })
    .select("tenantId")
    .sum("amountMicros as chargedMicros")
    .groupBy("tenantId");
  const legacyByTenant = new Map<string, number>();
  for (const row of legacyRows) {
    legacyByTenant.set(String(row.tenantId), Number(row.chargedMicros || 0));
  }

  const refundRows = await (database as any)(TENANT_SETTLEMENT_LEDGER_TABLE)
    .where({ type: "recharge_wholesale", direction: "credit" })
    .select("tenantId")
    .sum("amountMicros as refundedMicros")
    .groupBy("tenantId");
  for (const row of refundRows) {
    const tenantId = String(row.tenantId);
    legacyByTenant.set(tenantId, (legacyByTenant.get(tenantId) || 0) - Number(row.refundedMicros || 0));
  }

  const shadowRows = await (database as any)(CONSUMPTION_ALLOCATION_TABLE)
    .select("collectorTenantId")
    .sum("wholesaleAccrualMicros as accruedMicros")
    .groupBy("collectorTenantId");
  const shadowByTenant = new Map<string, number>();
  for (const row of shadowRows) {
    const tenantId = String(row.collectorTenantId || "FANJIN");
    shadowByTenant.set(tenantId, (shadowByTenant.get(tenantId) || 0) + Number(row.accruedMicros || 0));
  }

  const tenantIds = new Set([...legacyByTenant.keys(), ...shadowByTenant.keys()]);
  const rows: ShadowAlignmentRow[] = [];
  let aligned = true;
  for (const tenantId of tenantIds) {
    const legacyChargedMicros = legacyByTenant.get(tenantId) || 0;
    const shadowAccruedMicros = shadowByTenant.get(tenantId) || 0;
    const differenceMicros = legacyChargedMicros - shadowAccruedMicros;
    if (differenceMicros !== 0) aligned = false;
    rows.push({
      tenantId: tenantNameOf(tenantId),
      legacyChargedMicros,
      shadowAccruedMicros,
      unconsumedMicros: Math.max(0, differenceMicros),
      differenceMicros,
    });
  }
  rows.sort((left, right) => left.tenantId.localeCompare(right.tenantId));
  return { aligned, rows };
}

export async function reconciliationSummary(database: ReconciliationDb = db): Promise<ReconciliationSummary> {
  const [
    byCollector,
    consumptionByCollector,
    consumptionByRegistered,
    consumptionByOwner,
    providerCosts,
    alignment,
  ] = await Promise.all([
    paymentSummaryByCollector(database),
    consumptionSummary(database, "collectorTenantId"),
    consumptionSummary(database, "registeredTenantIdSnapshot"),
    consumptionSummary(database, "ownerTenantIdSnapshot"),
    providerCostSummary(database),
    shadowAlignmentReport(database),
  ]);
  return {
    mode: settlementV2Mode(),
    byCollector,
    consumptionByCollector,
    consumptionByRegistered,
    consumptionByOwner,
    providerCosts,
    shadowAlignment: {
      aligned: alignment.aligned,
      rows: alignment.rows,
      note: "差异=充值时已扣批发结算-实际消费应计批发；仅当批次全部消费或退款后归零",
    },
  };
}

// ---------------------------------------------------------------------------
// 账期管理
// ---------------------------------------------------------------------------

export type PeriodPreflightBlocker = {
  code: string;
  detail: string;
  count: number;
};

export type PeriodPreflightResult = {
  periodKey: string;
  passed: boolean;
  blockers: PeriodPreflightBlocker[];
  checkedAt: number;
};

const PERIOD_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizePeriodKey(value: unknown): string {
  const periodKey = String(value || "").trim();
  if (!PERIOD_KEY_RE.test(periodKey)) {
    throw new TenantReconciliationError("账期格式必须为 YYYY-MM", 422, "PERIOD_KEY_INVALID");
  }
  return periodKey;
}

export class TenantReconciliationError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "TENANT_RECONCILIATION_ERROR") {
    super(message);
    this.name = "TenantReconciliationError";
    this.status = status;
    this.code = code;
  }
}

function periodBounds(periodKey: string): { startAt: number; endAt: number } {
  const [year, month] = periodKey.split("-").map(Number);
  const startAt = new Date(Date.UTC(year, month - 1, 1)).getTime();
  const endAt = new Date(Date.UTC(year, month, 1)).getTime() - 1;
  return { startAt, endAt };
}

/**
 * 账期预检（设计文档 §14.6）：
 * 阻断项包括：未确认官方成本、存在支付争议（pending_reconcile 订单）、
 * 负数消费差异、影子账与旧账口径存在无法解释的负差异。
 */
export async function preflightSettlementPeriod(
  periodKeyInput: string,
  database: ReconciliationDb = db,
): Promise<PeriodPreflightResult> {
  const periodKey = normalizePeriodKey(periodKeyInput);
  const { startAt, endAt } = periodBounds(periodKey);
  const blockers: PeriodPreflightBlocker[] = [];
  const checkedAt = Date.now();

  const unconfirmed = await (database as any)(PROVIDER_COST_LEDGER_TABLE)
    .where({ state: "estimated" })
    .whereBetween("createdAt", [startAt, endAt])
    .count("* as total")
    .first();
  if (Number(unconfirmed?.total || 0) > 0) {
    blockers.push({
      code: "UNCONFIRMED_PROVIDER_COST",
      detail: "账期内存在未导入官方账单确认的成本记录",
      count: Number(unconfirmed.total),
    });
  }

  const disputed = await (database as any)("o_payment_order")
    .where({ status: "pending_reconcile" })
    .whereBetween("createdAt", [startAt, endAt])
    .count("* as total")
    .first();
  if (Number(disputed?.total || 0) > 0) {
    blockers.push({
      code: "PAYMENT_DISPUTE_OPEN",
      detail: "账期内存在待对账/争议支付订单",
      count: Number(disputed.total),
    });
  }

  const negativeDiff = await (database as any)(PROVIDER_COST_LEDGER_TABLE)
    .where({ state: "adjusted" })
    .whereBetween("createdAt", [startAt, endAt])
    .where("differenceMicros", "<", 0)
    .count("* as total")
    .first();
  if (Number(negativeDiff?.total || 0) > 0) {
    blockers.push({
      code: "NEGATIVE_COST_DIFFERENCE",
      detail: "官方成本低于估算的差异需要财务复核后才能关账",
      count: Number(negativeDiff.total),
    });
  }

  const alignment = await shadowAlignmentReport(database);
  const negativeShadow = alignment.rows.filter((row) => row.differenceMicros < 0);
  if (negativeShadow.length) {
    blockers.push({
      code: "SHADOW_NEGATIVE_DIFFERENCE",
      detail: "消费应计超过充值时扣减的批发结算，禁止关账",
      count: negativeShadow.length,
    });
  }

  return { periodKey, passed: blockers.length === 0, blockers, checkedAt };
}

export type SettlementPeriodRecord = {
  id: string;
  periodKey: string;
  status: "open" | "closed";
  preflightResult: PeriodPreflightResult | null;
  settlementPolicyId: string | null;
  settlementPolicyRevision: number | null;
  closedAt: number | null;
  closedByUserId: number | null;
  createdAt: number;
  updatedAt: number;
};

function rowToPeriod(row: any): SettlementPeriodRecord {
  let preflightResult: PeriodPreflightResult | null = null;
  if (row.preflightResult) {
    try {
      preflightResult = JSON.parse(String(row.preflightResult));
    } catch {
      preflightResult = null;
    }
  }
  return {
    id: String(row.id),
    periodKey: String(row.periodKey),
    status: String(row.status || "open") as "open" | "closed",
    preflightResult,
    settlementPolicyId: row.settlementPolicyId ? String(row.settlementPolicyId) : null,
    settlementPolicyRevision: row.settlementPolicyRevision == null ? null : Number(row.settlementPolicyRevision),
    closedAt: row.closedAt == null ? null : Number(row.closedAt),
    closedByUserId: row.closedByUserId == null ? null : Number(row.closedByUserId),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

export async function listSettlementPeriods(database: ReconciliationDb = db): Promise<SettlementPeriodRecord[]> {
  const rows = await (database as any)(TENANT_SETTLEMENT_PERIOD_TABLE).orderBy("periodKey", "desc");
  return rows.map(rowToPeriod);
}

/**
 * 账期关账（幂等，设计文档 §14.6/§21 MT-P1-03）：
 * - 预检必须通过（阻断项为空）
 * - 已关账期间重复关账返回幂等结果
 * - 关账时冻结结算策略版本（settlementPolicyId + revision）
 */
export async function closeSettlementPeriod(input: {
  periodKey: string;
  operatorUserId: number;
  settlementPolicyId?: string | null;
  settlementPolicyRevision?: number | null;
  database?: ReconciliationDb;
  audit?: (period: SettlementPeriodRecord, trx: Knex.Transaction) => Promise<void>;
}): Promise<{ period: SettlementPeriodRecord; idempotent: boolean }> {
  const periodKey = normalizePeriodKey(input.periodKey);
  const database = input.database ?? db;
  const preflight = await preflightSettlementPeriod(periodKey, database);
  if (!preflight.passed) {
    throw new TenantReconciliationError(
      `账期 ${periodKey} 预检未通过：${preflight.blockers.map((blocker) => blocker.code).join(", ")}`,
      409,
      "PERIOD_PREFLIGHT_FAILED",
    );
  }
  const run = async (client: ReconciliationDb) => {
    const existing = await (client as any)(TENANT_SETTLEMENT_PERIOD_TABLE)
      .where({ periodKey })
      .forUpdate()
      .first();
    if (existing && String(existing.status) === "closed") {
      return { period: rowToPeriod(existing), idempotent: true };
    }
    const timestamp = Date.now();
    if (existing) {
      await (client as any)(TENANT_SETTLEMENT_PERIOD_TABLE)
        .where({ id: existing.id })
        .update({
          status: "closed",
          preflightResult: JSON.stringify(preflight),
          settlementPolicyId: input.settlementPolicyId ?? null,
          settlementPolicyRevision: input.settlementPolicyRevision ?? null,
          closedAt: timestamp,
          closedByUserId: input.operatorUserId,
          updatedAt: timestamp,
        });
      const updated = await (client as any)(TENANT_SETTLEMENT_PERIOD_TABLE).where({ id: existing.id }).first();
      return { period: rowToPeriod(updated), idempotent: false };
    }
    const record = {
      id: uuid(),
      periodKey,
      status: "closed",
      preflightResult: JSON.stringify(preflight),
      settlementPolicyId: input.settlementPolicyId ?? null,
      settlementPolicyRevision: input.settlementPolicyRevision ?? null,
      closedAt: timestamp,
      closedByUserId: input.operatorUserId,
      metadata: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await (client as any)(TENANT_SETTLEMENT_PERIOD_TABLE).insert(record);
    return { period: rowToPeriod(record), idempotent: false };
  };
  if (input.database) return await run(input.database);
  return await db.transaction(async (trx) => {
    const result = await run(trx);
    if (input.audit) await input.audit(result.period, trx as Knex.Transaction);
    return result;
  });
}

/**
 * MT-P1-03：账期重开审批（仅平台 Root + MFA；写不可变重开记录）。
 * 重开后账期回到 open，可重新导入账单/调整差异，再次关账需重新预检。
 */
export async function reopenSettlementPeriod(input: {
  periodKey: string;
  reason: string;
  operatorUserId: number;
  audit?: (period: SettlementPeriodRecord, reopenEntry: Record<string, unknown>, trx: Knex.Transaction) => Promise<void>;
}): Promise<{ period: SettlementPeriodRecord; reopenCount: number }> {
  const periodKey = normalizePeriodKey(input.periodKey);
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) {
    throw new TenantReconciliationError("重开原因必填（至少 5 字符）", 422, "PERIOD_REOPEN_REASON_REQUIRED");
  }
  return await db.transaction(async (trx) => {
    const row = await (trx as any)(TENANT_SETTLEMENT_PERIOD_TABLE)
      .where({ periodKey })
      .forUpdate()
      .first();
    if (!row) throw new TenantReconciliationError("账期不存在", 404, "PERIOD_NOT_FOUND");
    if (String(row.status) !== "closed") {
      throw new TenantReconciliationError("仅已关账的账期可以重开", 409, "PERIOD_NOT_CLOSED");
    }
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(String(row.metadata || "{}"));
    } catch {
      metadata = {};
    }
    const history = Array.isArray(metadata.reopens) ? metadata.reopens : [];
    const reopenEntry = {
      reopenedAt: Date.now(),
      reopenedByUserId: input.operatorUserId,
      reason,
      previousClosedAt: Number(row.closedAt || 0),
    };
    history.push(reopenEntry);
    const timestamp = Date.now();
    await (trx as any)(TENANT_SETTLEMENT_PERIOD_TABLE)
      .where({ id: row.id })
      .update({
        status: "open",
        closedAt: null,
        closedByUserId: null,
        metadata: JSON.stringify({ ...metadata, reopens: history }),
        updatedAt: timestamp,
      });
    const updated = await (trx as any)(TENANT_SETTLEMENT_PERIOD_TABLE).where({ id: row.id }).first();
    const period = rowToPeriod(updated);
    if (input.audit) {
      await input.audit(period, reopenEntry, trx as Knex.Transaction);
    }
    return { period, reopenCount: history.length };
  });
}

/**
 * 账期导出（不可变快照：收款/退款/消费应计/官方成本/影子对齐/结算策略版本）。
 */
export async function exportSettlementPeriod(
  periodKeyInput: string,
  database: ReconciliationDb = db,
): Promise<Record<string, unknown>> {
  const periodKey = normalizePeriodKey(periodKeyInput);
  const { startAt, endAt } = periodBounds(periodKey);
  const periodRow = await (database as any)(TENANT_SETTLEMENT_PERIOD_TABLE).where({ periodKey }).first();
  if (!periodRow || String(periodRow.status) !== "closed") {
    throw new TenantReconciliationError(`账期 ${periodKey} 尚未关账，无法导出`, 409, "PERIOD_NOT_CLOSED");
  }
  const payments = await (database as any)("o_payment_order")
    .whereBetween("createdAt", [startAt, endAt])
    .whereIn("status", ["paid", "refunded"]);
  const allocations = await (database as any)(CONSUMPTION_ALLOCATION_TABLE)
    .whereBetween("capturedAt", [startAt, endAt]);
  const costs = await (database as any)(PROVIDER_COST_LEDGER_TABLE)
    .whereBetween("createdAt", [startAt, endAt]);
  const alignment = await shadowAlignmentReport(database);
  return {
    periodKey,
    closedAt: Number(periodRow.closedAt || 0),
    settlementPolicyId: periodRow.settlementPolicyId || null,
    settlementPolicyRevision: periodRow.settlementPolicyRevision ?? null,
    payments: payments.map((row: any) => ({
      orderId: String(row.id),
      collectorTenantId: String(row.collectorTenantId || row.sellerTenantId || ""),
      registeredTenantIdSnapshot: row.registeredTenantIdSnapshot || null,
      ownerTenantIdSnapshot: row.ownerTenantIdSnapshot || null,
      amountMicros: Number(row.amountMicros || 0),
      refundedAmountMicros: Number(row.refundedAmountMicros || 0),
      status: String(row.status),
    })),
    consumptionAllocations: allocations.map((row: any) => ({
      collectorTenantId: String(row.collectorTenantId || ""),
      registeredTenantIdSnapshot: String(row.registeredTenantIdSnapshot || ""),
      ownerTenantIdSnapshot: String(row.ownerTenantIdSnapshot || ""),
      chargedGuMicros: Number(row.chargedGuMicros || 0),
      retailPortionMicros: Number(row.retailPortionMicros || 0),
      wholesaleAccrualMicros: Number(row.wholesaleAccrualMicros || 0),
      settlementMode: String(row.settlementMode || ""),
    })),
    providerCosts: costs.map((row: any) => ({
      provider: String(row.provider || ""),
      estimatedCostMicros: Number(row.estimatedCostMicros || 0),
      officialCostMicros: row.officialCostMicros == null ? null : Number(row.officialCostMicros),
      differenceMicros: row.differenceMicros == null ? null : Number(row.differenceMicros),
      state: String(row.state || ""),
    })),
    shadowAlignment: alignment,
  };
}

export { COMMERCIAL_CREDIT_LOT_TABLE };
