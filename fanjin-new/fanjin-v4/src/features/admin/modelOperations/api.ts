import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type {
  LogicalModelPriceDraft,
  ModelPoolItem,
  ModelRouteGroup,
  ModelRouteGroupDraft,
  ModelRouteGroupPreflight,
} from "./types";

export function listModelPool(signal?: AbortSignal) {
  return apiPost<ModelPoolItem[]>("/admin/modelPool/list", { includeDisabled: false }, undefined, { signal });
}

export function listModelRouteGroups(signal?: AbortSignal) {
  return apiPost<ModelRouteGroup[]>("/admin/modelRouteGroups/list", { includeDisabled: true }, undefined, { signal });
}

export function preflightModelRouteGroup(draft: ModelRouteGroupDraft) {
  return apiPost<ModelRouteGroupPreflight>("/admin/modelRouteGroups/preflight", { ...draft });
}

export function saveModelRouteGroup(draft: ModelRouteGroupDraft) {
  return apiPostWithStepUp<ModelRouteGroup>("/admin/modelRouteGroups/save", { ...draft }, "admin.model_route");
}

export function updateModelRouteGroupPrice(groupKey: string, pricing: LogicalModelPriceDraft) {
  return apiPostWithStepUp<ModelRouteGroup>(
    "/admin/modelRouteGroups/updatePrice",
    { groupKey, pricing },
    "admin.pricing_rule",
  );
}

export function unpublishModelRouteGroup(group: ModelRouteGroup) {
  return saveModelRouteGroup({
    existingGroupKey: group.groupKey,
    scope: group.scope,
    workspaceId: group.workspaceId,
    endpointType: group.endpointType,
    publicModel: group.publicModel,
    displayName: group.displayName,
    disabled: true,
    targets: group.targets.map((target) => ({
      id: target.id,
      channelId: target.channelId,
      upstreamModel: target.upstreamModel,
      tier: target.tier,
      trafficWeight: target.trafficWeight,
      routeRecipe: target.routeConfig.routeRecipe && typeof target.routeConfig.routeRecipe === "object"
        ? target.routeConfig.routeRecipe as Record<string, unknown>
        : undefined,
    })),
    pricing: group.pricing ? {
      unit: group.pricing.unit,
      unitPriceMicros: group.pricing.unitPriceMicros,
      currency: "GU",
      ruleConfig: group.pricing.ruleConfig || {},
    } : null,
  });
}

export function simulateModelRouteGroup(groupKey: string) {
  return apiPost<{
    groupKey: string;
    sideEffectFree: true;
    activeTier: ModelRouteGroupTargetDraft["tier"] | null;
    targets: Array<{
      id: string;
      channelName: string;
      provider: string;
      tier: string;
      trafficWeight: number;
      normalizedTrafficPercent: number;
      eligible: boolean;
      selectedTier: boolean;
      health: string;
    }>;
  }>("/admin/modelRouteGroups/simulate", { groupKey });
}

type ModelRouteGroupTargetDraft = ModelRouteGroupDraft["targets"][number];
