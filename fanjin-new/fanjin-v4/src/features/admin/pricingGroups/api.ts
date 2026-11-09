import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type { PricingGroup, PricingGroupDraft } from "./types";

function unwrap<T>(value: unknown): T {
  if (value && typeof value === "object" && "data" in value) return (value as { data: T }).data;
  return value as T;
}

export async function listPricingGroups(): Promise<PricingGroup[]> {
  const value = unwrap<unknown>(await apiPost("/admin/pricingGroups/list", {}));
  return Array.isArray(value) ? value as PricingGroup[] : [];
}

export function createPricingGroup(input: Omit<PricingGroupDraft, "status">) {
  return apiPostWithStepUp("/admin/pricingGroups/create", input, "admin.pricing_rule");
}

export function updatePricingGroup(input: Omit<PricingGroupDraft, "code"> & { code: string }) {
  return apiPostWithStepUp("/admin/pricingGroups/update", input, "admin.pricing_rule");
}

export function deletePricingGroup(code: string) {
  return apiPostWithStepUp("/admin/pricingGroups/delete", { code }, "admin.pricing_rule");
}

export function assignUsersToPricingGroup(userIds: number[], code: string) {
  return apiPostWithStepUp(
    "/admin/pricingGroups/assignUsers",
    { userIds, code: code === "default" ? null : code },
    "admin.user.commercial",
  );
}
