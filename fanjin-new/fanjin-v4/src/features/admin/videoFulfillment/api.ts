import { apiGet } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type {
  EnhanceOverview,
  EnhancePricingRule,
  VideoChannelOption,
  VideoOffer,
  VideoRecipe,
} from "./types";

export function listOffers(signal?: AbortSignal) {
  return apiGet<{ offers?: VideoOffer[] }>("/admin/videoFulfillment/offers", undefined, { signal });
}

export function listRecipes(publicModel: string, targetResolution: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ publicModel, targetResolution });
  return apiGet<{ recipes?: VideoRecipe[] }>(`/admin/videoFulfillment/recipes?${query.toString()}`, undefined, { signal });
}

export function listVideoChannels(signal?: AbortSignal) {
  return apiGet<{ channels?: VideoChannelOption[] }>("/admin/videoFulfillment/channels", undefined, { signal });
}

export function getEnhanceOverview(signal?: AbortSignal) {
  return apiGet<EnhanceOverview>("/admin/videoFulfillment/enhance/overview", undefined, { signal });
}

export interface OfferUpdatePayload {
  publicModel: string;
  displayName?: string;
  visibleResolutions?: string[];
  enabled?: boolean;
}

export function saveOffer(payload: OfferUpdatePayload) {
  return apiPostWithStepUp<{ offer: VideoOffer; updatedModelRoutes: number }>(
    "/admin/videoFulfillment/offers/update",
    payload as unknown as Record<string, unknown>,
    "admin.video_fulfillment",
    "保存公开模型显示名 / 可见档需要管理员二次验证",
  );
}

export interface RecipeSavePayload {
  id?: string;
  publicModel?: string;
  targetResolution?: string;
  name?: string;
  generateChannelId?: string;
  generateResolution?: string;
  upstreamModel?: string | null;
  enhanceEnabled?: boolean;
  enhanceChannelId?: string | null;
  weight?: number;
  priority?: number;
  enabled?: boolean;
}

export function createRecipe(payload: RecipeSavePayload) {
  return apiPostWithStepUp<{ recipe: VideoRecipe; warnings?: string[] }>(
    "/admin/videoFulfillment/recipes/create",
    payload as unknown as Record<string, unknown>,
    "admin.video_fulfillment",
    "新增兑现配方需要管理员二次验证",
  );
}

export function updateRecipe(id: string, patch: RecipeSavePayload) {
  return apiPostWithStepUp<{ recipe: VideoRecipe; warnings?: string[] }>(
    "/admin/videoFulfillment/recipes/update",
    { id, ...patch } as unknown as Record<string, unknown>,
    "admin.video_fulfillment",
    "修改兑现配方需要管理员二次验证",
  );
}

export function deleteRecipe(id: string) {
  return apiPostWithStepUp<{ id: string }>(
    "/admin/videoFulfillment/recipes/delete",
    { id },
    "admin.video_fulfillment",
    "删除兑现配方需要管理员二次验证",
  );
}

export interface EnhancePricingPayload {
  sourceResolution: string;
  targetResolution: string;
  unitPriceMicros: number;
  unit?: string;
  disabled?: boolean;
  name?: string;
}

export function saveEnhancePricing(payload: EnhancePricingPayload) {
  return apiPostWithStepUp<{ rule: EnhancePricingRule }>(
    "/admin/videoFulfillment/enhance/pricing/update",
    payload as unknown as Record<string, unknown>,
    "admin.pricing_rule",
    "修改画质增强价目需要管理员二次验证",
  );
}
