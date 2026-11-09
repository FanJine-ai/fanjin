import { apiPost } from "../../../../api/http";
import { apiPostWithStepUp } from "../../../../api/stepUp";
import type {
  LogicalModelPriceDraft,
  ModelPublicationStatus,
} from "../../modelOperations/types";
import type { PricingRule, PricingRulePayload } from "./types";

export interface LogicalModelPricingView {
  groupKey: string;
  scope: "platform" | "workspace";
  workspaceId: string | null;
  endpointType: string;
  publicModel: string;
  displayName: string;
  targetCount: number;
  pricing: {
    unit: string;
    unitPriceMicros: number;
    currency: string;
  } | null;
  publication: { status: ModelPublicationStatus };
}

function items<T>(value: unknown): T[] {
  const payload = value && typeof value === "object" && "data" in value ? (value as { data?: unknown }).data : value;
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && "items" in payload && Array.isArray((payload as { items?: unknown }).items)) return (payload as { items: T[] }).items;
  return [];
}

export async function listPricingRules() { return items<PricingRule>(await apiPost<unknown>("/admin/pricingRules/list", { includeDisabled: true })); }
export async function listLogicalModelPricing() {
  return items<LogicalModelPricingView>(await apiPost<unknown>("/admin/pricingRules/list", {
    view: "logicalModels",
    includeDisabled: true,
  }));
}
export async function updateLogicalModelPricing(groupKey: string, pricing: LogicalModelPriceDraft) {
  return apiPostWithStepUp<LogicalModelPricingView>(
    "/admin/pricingRules/update",
    { groupKey, pricing },
    "admin.pricing_rule",
  );
}
export async function savePricingRule(id: string, payload: PricingRulePayload) {
  return id
    ? apiPostWithStepUp<PricingRule>("/admin/pricingRules/update", { id, ...payload }, "admin.pricing_rule")
    : apiPostWithStepUp<PricingRule>("/admin/pricingRules/create", { ...payload }, "admin.pricing_rule");
}
export async function setPricingRuleDisabled(id: string, disabled: boolean) {
  return disabled
    ? apiPostWithStepUp("/admin/pricingRules/delete", { id }, "admin.pricing_rule")
    : apiPostWithStepUp("/admin/pricingRules/update", { id, disabled: 0 }, "admin.pricing_rule");
}
