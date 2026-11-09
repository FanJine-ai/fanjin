import { apiPost } from "../../../../api/http";
import { apiPostWithStepUp } from "../../../../api/stepUp";
import type { BillingPlan, BillingPlanPayload } from "./types";

function extractItems(value: unknown): BillingPlan[] {
  const payload = value && typeof value === "object" && "data" in value ? (value as { data?: unknown }).data : value;
  if (Array.isArray(payload)) return payload as BillingPlan[];
  if (payload && typeof payload === "object" && "items" in payload && Array.isArray((payload as { items?: unknown }).items)) {
    return (payload as { items: BillingPlan[] }).items;
  }
  return [];
}

export async function listBillingPlans() {
  return extractItems(await apiPost<unknown>("/admin/billing/plans/list", {}));
}

export async function saveBillingPlan(id: string, payload: BillingPlanPayload) {
  if (id) {
    const updatePayload = {
      name: payload.name,
      currency: payload.currency,
      monthlyFeeMicros: payload.monthlyFeeMicros,
      includedCreditsMicros: payload.includedCreditsMicros,
      apiQuota: payload.apiQuota,
      memberLimit: payload.memberLimit,
      keyLimit: payload.keyLimit,
      status: payload.status,
    };
    return apiPostWithStepUp("/admin/billing/plans/update", { id, ...updatePayload }, "admin.billing.plan");
  }
  return apiPostWithStepUp("/admin/billing/plans/create", { ...payload }, "admin.billing.plan");
}

export async function archiveBillingPlan(id: string) {
  return apiPostWithStepUp("/admin/billing/plans/update", { id, status: "archived" }, "admin.billing.plan");
}
