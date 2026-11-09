import { publicH3ModelCapability } from "@/lib/minimaxH3PublicIdentity";
import { findVolcengineModel } from "@/lib/volcengineModelManifest";
import type { FulfillmentPlan, VideoFulfillmentRecipe } from "@/lib/videoFulfillment/recipes";

export const FANJIN_VALUE_VIDEO_OFFER_VERSION =
  "fanjin-value-video-offer/v1" as const;
export const FANJIN_VALUE_VIDEO_TARGET_RESOLUTION = "720p" as const;
export const FANJIN_VALUE_VIDEO_GENERATION_RESOLUTION = "480p" as const;
export const FANJIN_VALUE_VIDEO_RESOLUTION_PAIRS = Object.freeze([
  Object.freeze({ generationResolution: "480p" as const, targetResolution: "720p" as const }),
  Object.freeze({ generationResolution: "720p" as const, targetResolution: "1080p" as const }),
]);
export type FanjinValueTargetResolution = "720p" | "1080p";
export type FanjinValueGenerationResolution = "480p" | "720p";
export function fanjinValueVideoResolutionPair(target: unknown) {
  return FANJIN_VALUE_VIDEO_RESOLUTION_PAIRS.find((pair) => pair.targetResolution === String(target || "").trim().toLowerCase()) ?? null;
}
export const FANJIN_VALUE_VIDEO_MARKUP_BPS = 0 as const;
// Existing task snapshots keep their agreed price when they settle.
export const FANJIN_VALUE_VIDEO_LEGACY_MARKUP_BPS = 2_000 as const;
export type FanjinValueVideoMarkupBps = typeof FANJIN_VALUE_VIDEO_MARKUP_BPS | typeof FANJIN_VALUE_VIDEO_LEGACY_MARKUP_BPS;
export const FANJIN_VALUE_VIDEO_MIN_DURATION_SECONDS = 4 as const;
// Retained for historical configuration/receipts. New work uses the exact
// upstream model's duration contract via fanjinValueVideoDuration.
export const FANJIN_VALUE_VIDEO_MAX_DURATION_SECONDS = 15 as const;
export const FANJIN_VALUE_VIDEO_DEFAULT_DURATION_SECONDS = 5 as const;
export const FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID =
  "fanjin-value-video-volcano-generation" as const;
export const FANJIN_VALUE_VIDEO_UPSCALE_CHANNEL_ID =
  "fanjin-value-video-mediakit-upscale" as const;
export const FANJIN_VALUE_VIDEO_UPSCALE_MODE = "generative" as const;
export const FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT =
  "https://mediakit.cn-beijing.volces.com/api/v1/tools/enhance-video-generative" as const;
export const FANJIN_VALUE_VIDEO_UPSCALE_RESOLUTIONS = Object.freeze([
  "720p", "1080p", "2k",
] as const);
export const FANJIN_VALUE_VIDEO_UPSCALE_PRICING_RULE_ID =
  "fanjin-value-video-upscale-pricing-480p-to-720p" as const;

export interface FanjinValueVideoOfferDefinition {
  publicModel: string;
  displayName: string;
  publicDescription: string;
  upstreamModel: string;
  generationResolution: FanjinValueGenerationResolution;
  targetResolution: FanjinValueTargetResolution;
  markupBps: typeof FANJIN_VALUE_VIDEO_MARKUP_BPS;
}

export const FANJIN_VALUE_VIDEO_OFFERS = Object.freeze([
  Object.freeze({
    publicModel: "fanjin-seedance-2-5-value-720p",
    displayName: "Doubao-Seedance-2.5繁境特价版",
    publicDescription: "720p / 1080p 高清输出 · 支持同步音频 · 4–30 秒",
    upstreamModel: "doubao-seedance-2-5-260628",
    generationResolution: FANJIN_VALUE_VIDEO_GENERATION_RESOLUTION,
    targetResolution: FANJIN_VALUE_VIDEO_TARGET_RESOLUTION,
    markupBps: FANJIN_VALUE_VIDEO_MARKUP_BPS,
  }),
  Object.freeze({
    publicModel: "fanjin-seedance-2-0-value-720p",
    displayName: "Doubao-Seedance-2.0繁境特价版",
    publicDescription: "720p / 1080p 高清输出 · 支持同步音频 · 4–15 秒",
    upstreamModel: "doubao-seedance-2-0-260128",
    generationResolution: FANJIN_VALUE_VIDEO_GENERATION_RESOLUTION,
    targetResolution: FANJIN_VALUE_VIDEO_TARGET_RESOLUTION,
    markupBps: FANJIN_VALUE_VIDEO_MARKUP_BPS,
  }),
  Object.freeze({
    publicModel: "fanjin-seedance-2-0-mini-value-720p",
    displayName: "Doubao-Seedance-2.0-mini繁境特价版",
    publicDescription: "720p / 1080p 高清输出 · 支持同步音频 · 4–15 秒",
    upstreamModel: "doubao-seedance-2-0-mini-260615",
    generationResolution: FANJIN_VALUE_VIDEO_GENERATION_RESOLUTION,
    targetResolution: FANJIN_VALUE_VIDEO_TARGET_RESOLUTION,
    markupBps: FANJIN_VALUE_VIDEO_MARKUP_BPS,
  }),
  Object.freeze({
    publicModel: "fanjin-seedance-2-0-fast-value-720p",
    displayName: "Doubao-Seedance-2.0-fast繁境特价版",
    publicDescription: "720p / 1080p 高清输出 · 支持同步音频 · 4–15 秒",
    upstreamModel: "doubao-seedance-2-0-fast-260128",
    generationResolution: FANJIN_VALUE_VIDEO_GENERATION_RESOLUTION,
    targetResolution: FANJIN_VALUE_VIDEO_TARGET_RESOLUTION,
    markupBps: FANJIN_VALUE_VIDEO_MARKUP_BPS,
  }),
] satisfies readonly FanjinValueVideoOfferDefinition[]);

export function fanjinValueVideoRouteId(publicModel: string): string {
  return `fanjin-value-video-route-${publicModel}`;
}

export function fanjinValueVideoRecipeId(publicModel: string, targetResolution: FanjinValueTargetResolution = "720p"): string {
  const pair = fanjinValueVideoResolutionPair(targetResolution)!;
  return `fanjin-value-video-recipe-${publicModel}-${pair.generationResolution}-to-${pair.targetResolution}`;
}

export function fanjinValueVideoPricingRuleId(publicModel: string): string {
  return `fanjin-value-video-pricing-${publicModel}`;
}

const FANJIN_VALUE_VIDEO_OFFER_BY_MODEL = new Map<string, FanjinValueVideoOfferDefinition>(
  FANJIN_VALUE_VIDEO_OFFERS.map((definition) => [definition.publicModel, definition] as const),
);

export function fanjinValueVideoOfferDefinition(
  publicModel: unknown,
): FanjinValueVideoOfferDefinition | null {
  return FANJIN_VALUE_VIDEO_OFFER_BY_MODEL.get(String(publicModel || "").trim()) ?? null;
}

export function isFanjinValueVideoModel(publicModel: unknown): boolean {
  return fanjinValueVideoOfferDefinition(publicModel) !== null;
}

/** Fixed durations follow the exact upstream; enhancement still bills seconds. */
export function fanjinValueVideoDuration(publicModel: unknown) {
  const definition = fanjinValueVideoOfferDefinition(publicModel);
  const upstream = definition && findVolcengineModel(definition.upstreamModel, "video_generation");
  if (!upstream || upstream.endpointType !== "video_generation" || !upstream.durations.length) {
    throw new Error("繁境特价版缺少上游时长能力");
  }
  return {
    min: upstream.durations[0],
    max: upstream.durations[upstream.durations.length - 1],
    step: 1,
    default: FANJIN_VALUE_VIDEO_DEFAULT_DURATION_SECONDS,
  };
}

const FANJIN_VALUE_PUBLIC_INTERNAL_KEYS = new Set([
  "name",
  "routeId",
  "routeName",
  "enhanceDisplayName",
  "enhanceChannelId",
  "recipeId",
  "generationResolution",
  "targetResolution",
  "upstreamModel",
  "needsEnhancement",
  "resolutionDeliveries",
  "nativeResolutions",
  "fulfillmentResolutions",
]);

const PUBLIC_MODEL_FULFILLMENT_KEYS = new Set([
  "resolutionDeliveries",
  "nativeResolutions",
  "fulfillmentResolutions",
  "formalPricingReadback",
]);

function omitFanjinValuePublicInternalFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitFanjinValuePublicInternalFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !FANJIN_VALUE_PUBLIC_INTERNAL_KEYS.has(key))
      .map(([key, child]) => [key, omitFanjinValuePublicInternalFields(child)]),
  );
}

/**
 * The customer selects an output tier, not an internal fulfillment route.
 * Keep the actual recipe and delivery evidence on the server while omitting
 * implementation metadata from public model-directory responses.
 */
export function publicFanjinValueVideoCapability<T extends Record<string, any>>(
  capability: T,
): T {
  const definition = fanjinValueVideoOfferDefinition(capability.model ?? capability.id);
  if (!definition) return capability;
  const projectedCapability = publicVideoOperationResolutions({ ...capability,
    resolutions: Array.isArray(capability.resolutions) ? capability.resolutions.filter((resolution: unknown) => fanjinValueVideoResolutionPair(resolution)) : [],
  });
  // Route/recipe names are operator-owned implementation metadata.  A managed
  // offer must always project its stable product identity and capability copy,
  // even if a stale production row contains an internal route name.
  const upstreamDuration = fanjinValueVideoDuration(definition.publicModel);
  // An older deployment may still have a 15-second route. Do not advertise
  // longer requests until its route and pricing configuration are upgraded.
  const configuredDuration = projectedCapability.duration;
  const publicDuration = {
    ...upstreamDuration,
    min: Math.max(upstreamDuration.min, configuredDuration?.min ?? upstreamDuration.min),
    max: Math.min(upstreamDuration.max, configuredDuration?.max ?? upstreamDuration.max),
  };
  const videoGeneration = projectedCapability.videoGeneration;
  return omitFanjinValuePublicInternalFields({
    ...projectedCapability,
    label: definition.displayName,
    displayName: definition.displayName,
    description: definition.publicDescription.replace(/4–\d+ 秒/u, `${publicDuration.min}–${publicDuration.max} 秒`),
    duration: publicDuration,
    ...(videoGeneration && typeof videoGeneration === "object" && !Array.isArray(videoGeneration)
      ? {
          videoGeneration: {
            ...videoGeneration,
            operations: Array.isArray(videoGeneration.operations)
              ? videoGeneration.operations.map((operation: unknown) => (
                  operation && typeof operation === "object" && !Array.isArray(operation)
                    ? { ...operation, duration: publicDuration }
                    : operation
                ))
              : videoGeneration.operations,
          },
        }
      : {}),
  }) as T;
}

const PUBLIC_MODEL_INTERNAL_TERM_PATTERN =
  /(?:480p(?:\s*(?:→|->|至)\s*|[-_\s]*to[-_\s]*)720p|履约超分|超分|健康配方|MediaKit|quality[_ -]?enhancement)/iu;

export function sanitizePublicModelDirectoryText(value: string): string {
  return value
    .replace(/480p(?:\s*(?:→|->|至)\s*|[-_\s]*to[-_\s]*)720p/giu, "720p 高清输出")
    .replace(/履约超分|超分/giu, "高清输出")
    .replace(/健康配方/giu, "服务配置")
    .replace(/MediaKit/giu, "服务")
    .replace(/quality[_ -]?enhancement/giu, "高清输出")
    .trim();
}

function sanitizePublicModelDirectoryValue(value: unknown): unknown {
  if (typeof value === "string") {
    return PUBLIC_MODEL_INTERNAL_TERM_PATTERN.test(value)
      ? sanitizePublicModelDirectoryText(value)
      : value;
  }
  if (Array.isArray(value)) return value.map(sanitizePublicModelDirectoryValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PUBLIC_MODEL_FULFILLMENT_KEYS.has(key))
      .map(([key, child]) => [key, sanitizePublicModelDirectoryValue(child)]),
  );
}

/** Apply the global public redaction policy without re-projecting product identity. */
export function sanitizePublicModelDirectoryProjection<T>(value: T): T {
  return sanitizePublicModelDirectoryValue(value) as T;
}

function publicVideoOperationResolutions<T extends Record<string, any>>(capability: T): T {
  const videoGeneration = capability.videoGeneration;
  if (
    !videoGeneration
    || typeof videoGeneration !== "object"
    || Array.isArray(videoGeneration)
    || !Array.isArray(videoGeneration.operations)
  ) return capability;
  const publicResolutions = Array.isArray(capability.resolutions)
    ? capability.resolutions.filter((value: unknown): value is string => (
        typeof value === "string" && Boolean(value.trim())
      ))
    : [];
  const publicResolutionByKey = new Map(publicResolutions.map((resolution: string) => [
    resolution.trim().toLowerCase().replace(/\s+/g, ""),
    resolution,
  ]));
  return {
    ...capability,
    videoGeneration: {
      ...videoGeneration,
      operations: videoGeneration.operations.map((operation: unknown) => {
        if (!operation || typeof operation !== "object" || Array.isArray(operation)) return operation;
        const rawOperation = operation as Record<string, unknown>;
        const candidates = [
          ...(Array.isArray(rawOperation.resolutions) ? rawOperation.resolutions : []),
          ...(Array.isArray(rawOperation.nativeResolutions) ? rawOperation.nativeResolutions : []),
          ...(Array.isArray(rawOperation.fulfillmentResolutions) ? rawOperation.fulfillmentResolutions : []),
        ];
        const resolutions = Array.from(new Set(candidates.flatMap((candidate) => {
          const key = typeof candidate === "string"
            ? candidate.trim().toLowerCase().replace(/\s+/g, "")
            : "";
          const publicResolution = publicResolutionByKey.get(key);
          return publicResolution ? [publicResolution] : [];
        })));
        return { ...rawOperation, resolutions };
      }),
    },
  };
}

/** Final public-API projection: product-specific metadata hiding + global text redaction. */
export function publicWorkbenchModelCapability<T extends Record<string, any>>(
  capability: T,
): T {
  return sanitizePublicModelDirectoryProjection(
    publicH3ModelCapability(publicFanjinValueVideoCapability(publicVideoOperationResolutions(capability))),
  );
}

/**
 * Managed value offers are product pipelines, not aliases for an upstream
 * Seedance model.  This validator prevents an operator mistake from silently
 * serving native 720p (or a different provider model) under the discounted
 * 480p + MediaKit product identity.
 */
export function isExactFanjinValueVideoRecipe(
  publicModel: unknown,
  recipe: Pick<
    VideoFulfillmentRecipe,
    | "publicModel"
    | "targetResolution"
    | "generateResolution"
    | "upstreamModel"
    | "enhanceEnabled"
    | "enhanceChannelId"
  >,
): boolean {
  const definition = fanjinValueVideoOfferDefinition(publicModel);
  const pair = fanjinValueVideoResolutionPair(recipe.targetResolution);
  return Boolean(
    definition
    && pair
    && recipe.publicModel === definition.publicModel
    && recipe.targetResolution === pair.targetResolution
    && recipe.generateResolution === pair.generationResolution
    && recipe.upstreamModel === definition.upstreamModel
    && recipe.enhanceEnabled === true
    && String(recipe.enhanceChannelId || "").trim(),
  );
}

export function isExactFanjinValueVideoPlan(
  publicModel: unknown,
  plan: FulfillmentPlan | null | undefined,
): plan is FulfillmentPlan {
  const definition = fanjinValueVideoOfferDefinition(publicModel);
  const pair = fanjinValueVideoResolutionPair(plan?.requestedResolution);
  return Boolean(
    definition
    && plan
    && pair
    && plan.publicModel === definition.publicModel
    && plan.requestedResolution === pair.targetResolution
    && plan.generationResolution === pair.generationResolution
    && plan.finalResolution === pair.targetResolution
    && plan.needsEnhancement === true
    && plan.pipeline === "generate_then_enhance"
    && String(plan.recipeId || "").trim()
    && String(plan.generateChannelId || "").trim()
    && String(plan.enhanceChannelId || "").trim()
    && plan.upstreamModel === definition.upstreamModel,
  );
}
