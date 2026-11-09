import { apiGet, apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";

export interface PaymentDimensionSummary {
  tenantId: string;
  paidOrders: number;
  paidAmountMicros: number;
  refundedAmountMicros: number;
  netAmountMicros: number;
}

export interface ConsumptionDimensionSummary {
  tenantId: string;
  allocations: number;
  chargedGuMicros: number;
  retailPortionMicros: number;
  wholesaleAccrualMicros: number;
}

export interface ProviderCostSummary {
  provider: string;
  estimatedCostMicros: number;
  officialCostMicros: number;
  differenceMicros: number;
  pendingConfirmation: number;
}

export interface ShadowAlignmentRow {
  tenantId: string;
  legacyChargedMicros: number;
  shadowAccruedMicros: number;
  unconsumedMicros: number;
  differenceMicros: number;
}

export interface ReconciliationSummaryPayload {
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
}

export interface PeriodPreflightBlocker {
  code: string;
  detail: string;
  count: number;
}

export interface PeriodPreflightPayload {
  periodKey: string;
  passed: boolean;
  blockers: PeriodPreflightBlocker[];
  checkedAt: number;
}

export interface SettlementPeriodRecord {
  id: string;
  periodKey: string;
  status: "open" | "closed";
  settlementPolicyId: string | null;
  settlementPolicyRevision: number | null;
  closedAt: number | null;
  closedByUserId: number | null;
  createdAt: number;
  updatedAt: number;
}

export function fetchReconciliationSummary() {
  return apiGet<ReconciliationSummaryPayload>("/admin/tenantReconciliation/summary");
}

export function fetchSettlementPeriods() {
  return apiGet<{ items: SettlementPeriodRecord[] }>("/admin/tenantReconciliation/periods");
}

export function preflightSettlementPeriod(periodKey: string) {
  return apiPost<PeriodPreflightPayload>(`/admin/tenantReconciliation/periods/${periodKey}/preflight`, {});
}

export function closeSettlementPeriod(periodKey: string, input: {
  settlementPolicyId?: string;
  settlementPolicyRevision?: number;
} = {}) {
  return apiPostWithStepUp(
    `/admin/tenantReconciliation/periods/${periodKey}/close`,
    input,
    "admin.tenant_reconciliation",
    `关闭账期 ${periodKey} 并生成正式结算单`,
  );
}

export function exportSettlementPeriod(periodKey: string) {
  return apiGet<Record<string, unknown>>(`/admin/tenantReconciliation/periods/${periodKey}/export`);
}

export function importProviderInvoices(items: Array<{
  usageId: string;
  provider: string;
  officialCostMicros: number;
  invoiceId?: string;
  billingPeriod?: string;
}>) {
  return apiPostWithStepUp(
    "/admin/tenantReconciliation/provider-invoices/import",
    { items },
    "admin.tenant_reconciliation",
    `导入 ${items.length} 条官方供应商账单`,
  );
}
