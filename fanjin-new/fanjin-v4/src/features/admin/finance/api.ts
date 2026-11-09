import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type { AdjustmentForm, FinanceCaseStatus, FinanceOverview, FinanceRecord, PagePayload } from "./types";
import { dateInputToMillis, guToMicros, yuanToMicros } from "./utils";

export async function loadFinanceOverview() {
  return apiPost<FinanceOverview>("/admin/finance/overview", {});
}

export async function loadFinancePage(endpoint: string, payload: Record<string, unknown>): Promise<PagePayload> {
  const data = await apiPost<unknown>(endpoint, payload);
  if (Array.isArray(data)) return { items: data as FinanceRecord[], total: data.length };
  return (data || {}) as PagePayload;
}

export async function createAdjustment(form: AdjustmentForm, idempotencyKey: string) {
  const body: Record<string, unknown> = {
    workspaceId: form.workspaceId.trim(),
    operation: form.operation,
    amountMicros: guToMicros(form.amount),
    description: form.description.trim(),
    idempotencyKey,
  };
  if (form.operation === "recharge" && form.incomeAmount.trim()) {
    body.incomeAmountMicros = yuanToMicros(form.incomeAmount);
  }
  if (form.operation === "gift_grant") {
    if (form.campaignName.trim()) body.campaignName = form.campaignName.trim();
    const expiresAt = dateInputToMillis(form.giftExpiresAt);
    if (expiresAt) body.giftExpiresAt = expiresAt;
  }
  return apiPostWithStepUp<FinanceRecord>("/admin/finance/adjustments/create", body, "admin.finance.adjustment");
}

export async function updateFinanceCase(id: string, status: FinanceCaseStatus, reviewNote: string) {
  return apiPostWithStepUp<FinanceRecord>("/admin/finance/cases/update", {
    id,
    status,
    reviewNote: reviewNote.trim() || null,
  }, "admin.finance.case");
}

export async function revokeGiftGrant(id: string) {
  return apiPostWithStepUp<FinanceRecord>("/admin/finance/gift-grants/revoke", { id }, "admin.finance.gift_grant");
}
