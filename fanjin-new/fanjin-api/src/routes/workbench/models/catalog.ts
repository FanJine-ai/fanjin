import { autoDLH3SupportsResolution } from "@/lib/autodlH3Manifest";
import { internalModelId, publicModelId, isFanjinH3Model } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import {
  cacheAside,
  CacheAsideSourceValidationError,
  inspectRedisBusinessCacheConfiguration,
  REDIS_BUSINESS_CACHE_ENABLED_ENV,
} from "@/lib/cacheAside";
import { success } from "@/lib/responseFormat";
import {
  buildWorkbenchModelCatalog,
  explainManagedLogicalModelPublication,
  listWorkbenchRouteModels,
  type WorkbenchModelCapability,
  type WorkbenchRouteModelSummary,
} from "@/lib/workbenchModelCatalog";
import {
  readPlatformModelDefaults,
  type PlatformModelDefaults,
} from "@/lib/platformSettings";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";
import { isPublicVideoResolution } from "@/lib/videoResolutions";
import { isMiniMaxH3Model } from "@/lib/minimaxH3Manifest";
import {
  isFanjinValueVideoModel,
  publicWorkbenchModelCapability,
  sanitizePublicModelDirectoryProjection,
} from "@/lib/fanjinValueVideoOffers";
import { resolveWorkspacePricingGroup } from "@/lib/pricingAudience";
import { db } from "@/utils/db";

const router = express.Router();

/**
 * GET /api/workbench/models/catalog?type=video|image|text|audio
 *
 * 统一画布模型目录(登录即可,无需管理员)。模型目录随后台 o_model_route
 * 变更:image/video 走 lib/workbenchModelCatalog.ts 的完整能力解析(通道
 * 健康 + capability 契约),text/audio 同样要求当前 scope 下存在健康、
 * 凭据完整的真实通道与 provider-specific 正 GU 定价。displayName 为空时回退 name;超分组合映射名经
 * routeConfig.enhanceDisplayName 透出。isDefault 由 platformSettings 的
 * platform.model.defaults(JSON 键 image/video/text/agentChat,值为模型
 * id)标记;audio 暂无默认配置位,isDefault 恒为 false。
 */
const CATALOG_TYPES = ["video", "image", "text", "audio"] as const;
type CatalogType = (typeof CATALOG_TYPES)[number];
type CatalogResponseType = CatalogType | "all";

// This cache is deliberately limited to the read-only, already-sanitized API
// DTO. Generation/quote/submit paths still resolve capabilities directly from
// PostgreSQL. Short jittered TTL bounds admin-change staleness and spreads
// expiration load across distinct directory keys.
export const WORKBENCH_MODEL_DIRECTORY_CACHE_SCHEMA = "workbench-model-directory-v11";
export const WORKBENCH_MODEL_DIRECTORY_CACHE_ENABLED_ENV = REDIS_BUSINESS_CACHE_ENABLED_ENV;
const WORKBENCH_MODEL_DIRECTORY_CACHE_NAMESPACE = "workbench-models";
const WORKBENCH_MODEL_DIRECTORY_CACHE_TTL_MS = 15_000;
const WORKBENCH_MODEL_DIRECTORY_CACHE_JITTER = 0.2;

export function isWorkbenchModelDirectoryCacheEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isRecoveryOnlyMode(environment)
    && inspectRedisBusinessCacheConfiguration(environment).enabled;
}

// text/audio 到 o_model_route.endpointType 的映射:audio 对应语音生成(tts)。
const GENERIC_ENDPOINT_TYPES: Record<"text" | "audio", string[]> = {
  text: ["text"],
  audio: ["tts"],
};

export type CatalogEntry = {
  id: string;
  model: string;
  type: CatalogType;
  name: string;
  displayName: string;
  enhanceDisplayName?: string | null;
  capabilities: Record<string, unknown>;
  isDefault: boolean;
};

export type WorkbenchModelDirectoryDto = {
  type: CatalogResponseType;
  defaults: PlatformModelDefaults;
  models: CatalogEntry[];
};

const DTO_FIELDS = new Set(["type", "defaults", "models"]);
const ENTRY_FIELDS = new Set([
  "id",
  "model",
  "type",
  "name",
  "displayName",
  "enhanceDisplayName",
  "capabilities",
  "isDefault",
]);
const MANAGED_VALUE_ENTRY_FIELDS = new Set(
  [...ENTRY_FIELDS].filter((key) => key !== "enhanceDisplayName"),
);
const DEFAULT_FIELDS = new Set(["image", "video", "text", "agentChat"]);
const GENERIC_CAPABILITY_FIELDS = new Set(["status", "canSubmit", "unavailableReason"]);
const MEDIA_CAPABILITY_FIELDS = new Set([
  "status",
  "canSubmit",
  "unavailableReason",
  "aliases",
  "description",
  "aspectRatios",
  "defaultAspectRatio",
  "inputSlots",
]);
const IMAGE_CAPABILITY_FIELDS = new Set([
  ...MEDIA_CAPABILITY_FIELDS,
  "qualities",
  "defaultQuality",
  "maxOutputs",
]);
const VIDEO_CAPABILITY_FIELDS = new Set([
  ...MEDIA_CAPABILITY_FIELDS,
  "resolutions",
  "defaultResolution",
  "duration",
  "supportsGenerateAudio",
  "modes",
  "videoGeneration",
]);
const INPUT_SLOT_FIELDS = new Set(["id", "label", "role", "roles", "accepts", "min", "max", "modes", "required"]);
const DURATION_FIELDS = new Set(["min", "max", "step", "default", "allowed", "auto"]);
const REQUIRED_DURATION_FIELDS = ["min", "max", "step", "default"] as const;
const VIDEO_GENERATION_FIELDS = new Set([
  "version",
  "contractFamily",
  "dispatchable",
  "operations",
  "inputSlots",
  "totalInputLimit",
  "mediaTypeLimits",
  "supportsGenerateAudio",
  "supportsPreserveSourceAudio",
  "supportsMask",
  "supportsTimeRange",
  "supportsSourceTaskContinuation",
]);
const VIDEO_OPERATION_FIELDS = new Set(["operation", "enabled", "modes", "duration", "resolutions", "aspectRatios"]);
const VIDEO_INPUT_SLOT_FIELDS = new Set([
  "id",
  "label",
  "mediaTypes",
  "roles",
  "operations",
  "modes",
  "min",
  "max",
  "allowDuplicateAsset",
  "supportsTrim",
]);
const VIDEO_MEDIA_LIMIT_FIELDS = new Set(["image", "video", "audio"]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
    && allowed.size === Object.keys(value).length;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100
    && value.every((item) => typeof item === "string");
}

function publicStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, 100);
}

function publicInputSlot(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  const projected: Record<string, unknown> = {};
  for (const key of INPUT_SLOT_FIELDS) {
    const child = value[key];
    if (child === undefined) continue;
    if (["id", "label", "role"].includes(key) && typeof child === "string") projected[key] = child;
    else if (["roles", "accepts", "modes"].includes(key) && Array.isArray(child)) {
      projected[key] = publicStrings(child);
    }
    else if (["min", "max"].includes(key) && typeof child === "number" && Number.isFinite(child)) projected[key] = child;
    else if (key === "required" && typeof child === "boolean") projected[key] = child;
  }
  return typeof projected.id === "string" || typeof projected.role === "string"
    ? projected
    : null;
}

function publicInputSlots(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100)
    .map(publicInputSlot)
    .filter((slot): slot is Record<string, unknown> => Boolean(slot));
}

function isPublicInputSlot(value: unknown): boolean {
  if (!record(value) || !Object.keys(value).every((key) => INPUT_SLOT_FIELDS.has(key))) return false;
  if (typeof value.id !== "string" && typeof value.role !== "string") return false;
  return Object.entries(value).every(([key, child]) => {
    if (["id", "label", "role"].includes(key)) return typeof child === "string";
    if (["roles", "accepts", "modes"].includes(key)) return strings(child);
    if (["min", "max"].includes(key)) return typeof child === "number" && Number.isFinite(child);
    return key === "required" && typeof child === "boolean";
  });
}

function isDuration(value: unknown): boolean {
  if (value === null) return true;
  if (
    !record(value)
    || !Object.keys(value).every((key) => DURATION_FIELDS.has(key))
    || !REQUIRED_DURATION_FIELDS.every((key) => Object.hasOwn(value, key))
  ) return false;
  if (![value.min, value.max, value.step, value.default]
    .every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  if (value.auto !== undefined && typeof value.auto !== "boolean") return false;
  return value.allowed === undefined
    || (Array.isArray(value.allowed)
      && value.allowed.every((item) => typeof item === "number" && Number.isFinite(item)));
}

function isVideoGeneration(
  value: unknown,
): value is Record<string, unknown> {
  if (!record(value) || !exactFields(value, value.draft === undefined ? VIDEO_GENERATION_FIELDS : new Set([...VIDEO_GENERATION_FIELDS, "draft"]))) return false;
  if (value.draft !== undefined && (!record(value.draft)
    || !exactFields(value.draft, new Set(["enabled", "resolution", "finalResolution", "ttlSeconds"]))
    || typeof value.draft.enabled !== "boolean" || value.draft.resolution !== "480p"
    || value.draft.finalResolution !== "1080p" || value.draft.ttlSeconds !== 604800)) return false;
  if (
    value.version !== "workbench-video-generation/v1"
    || (value.contractFamily !== null && typeof value.contractFamily !== "string")
    || typeof value.dispatchable !== "boolean"
    || !Number.isSafeInteger(value.totalInputLimit)
    || Number(value.totalInputLimit) < 0
    || typeof value.supportsGenerateAudio !== "boolean"
    || typeof value.supportsPreserveSourceAudio !== "boolean"
    || typeof value.supportsMask !== "boolean"
    || typeof value.supportsTimeRange !== "boolean"
    || typeof value.supportsSourceTaskContinuation !== "boolean"
    || !record(value.mediaTypeLimits)
    || !exactFields(value.mediaTypeLimits, VIDEO_MEDIA_LIMIT_FIELDS)
    || !Object.values(value.mediaTypeLimits).every((limit) => Number.isSafeInteger(limit) && Number(limit) >= 0)
    || !Array.isArray(value.operations)
    || !Array.isArray(value.inputSlots)
  ) return false;
  if (!value.operations.every((operation) => (
    record(operation)
    && exactFields(operation, VIDEO_OPERATION_FIELDS)
    && ["generate", "extend", "edit"].includes(String(operation.operation))
    && typeof operation.enabled === "boolean"
    && strings(operation.modes)
    && strings(operation.aspectRatios)
    && isDuration(operation.duration)
    && strings(operation.resolutions)
  ))) return false;
  if (!value.inputSlots.every((slot) => (
    record(slot)
    && exactFields(slot, VIDEO_INPUT_SLOT_FIELDS)
    && typeof slot.id === "string"
    && typeof slot.label === "string"
    && strings(slot.mediaTypes)
    && slot.mediaTypes.every((item) => ["image", "video", "audio"].includes(item))
    && strings(slot.roles)
    && strings(slot.operations)
    && strings(slot.modes)
    && slot.operations.every((item) => ["generate", "extend", "edit"].includes(item))
    && Number.isSafeInteger(slot.min)
    && Number.isSafeInteger(slot.max)
    && typeof slot.allowDuplicateAsset === "boolean"
    && typeof slot.supportsTrim === "boolean"
  ))) return false;
  return true;
}

function isUserFacingCatalogResolution(model: unknown, resolution: unknown): boolean {
  const normalized = String(resolution || "").trim().toLowerCase();
  if (isFanjinH3Model(model)) return autoDLH3SupportsResolution(internalModelId(String(model)), normalized);
  if (isMiniMaxH3Model(model)) {
    return model === "MiniMax-H3"
      ? ["768p", "2k"].includes(normalized)
      : ["480p", "768p"].includes(normalized);
  }
  return isPublicVideoResolution(normalized);
}

export function publicVideoGeneration(
  value: unknown,
  model?: unknown,
  advertisedResolutions?: readonly string[],
): Record<string, unknown> {
  const advertised = advertisedResolutions
    ? new Set(publicStrings(advertisedResolutions).map((resolution) => resolution.toLowerCase()))
    : null;
  const generation = record(value)
    ? {
      version: value.version,
      contractFamily: value.contractFamily,
      dispatchable: value.dispatchable,
      operations: Array.isArray(value.operations)
        ? value.operations.map((operation) => record(operation) ? {
          operation: operation.operation,
          enabled: operation.enabled,
          modes: operation.modes,
          aspectRatios: publicStrings(operation.aspectRatios),
          duration: record(operation.duration) ? {
            min: operation.duration.min,
            max: operation.duration.max,
            step: operation.duration.step,
            default: operation.duration.default,
            ...(operation.duration.auto === undefined ? {} : { auto: operation.duration.auto }),
            ...(operation.duration.allowed === undefined
              ? {}
              : { allowed: operation.duration.allowed }),
          } : operation.duration,
          resolutions: Array.from(new Set([
            ...publicStrings(operation.resolutions),
            ...publicStrings(operation.nativeResolutions),
            ...publicStrings(operation.fulfillmentResolutions),
          ])).filter((resolution) => (
            advertised
              ? advertised.has(resolution.toLowerCase())
              : isUserFacingCatalogResolution(model, resolution)
          )),
        } : operation)
        : value.operations,
      inputSlots: Array.isArray(value.inputSlots)
        ? value.inputSlots.map((slot) => record(slot) ? {
          id: slot.id,
          label: slot.label,
          mediaTypes: slot.mediaTypes,
          roles: slot.roles,
          operations: slot.operations,
          modes: slot.modes,
          min: slot.min,
          max: slot.max,
          allowDuplicateAsset: slot.allowDuplicateAsset,
          supportsTrim: slot.supportsTrim,
        } : slot)
        : value.inputSlots,
      totalInputLimit: value.totalInputLimit,
      mediaTypeLimits: record(value.mediaTypeLimits) ? {
        image: value.mediaTypeLimits.image,
        video: value.mediaTypeLimits.video,
        audio: value.mediaTypeLimits.audio,
      } : value.mediaTypeLimits,
      supportsGenerateAudio: value.supportsGenerateAudio,
      supportsPreserveSourceAudio: value.supportsPreserveSourceAudio,
      supportsMask: value.supportsMask ?? false,
      supportsTimeRange: value.supportsTimeRange ?? false,
      supportsSourceTaskContinuation: value.supportsSourceTaskContinuation ?? false,
      ...(record(value.draft) ? { draft: { enabled: value.draft.enabled, resolution: value.draft.resolution, finalResolution: value.draft.finalResolution, ttlSeconds: value.draft.ttlSeconds } } : {}),
    }
    : null;
  if (!isVideoGeneration(generation)) {
    return {
      version: "workbench-video-generation/v1",
      contractFamily: null,
      dispatchable: false,
      operations: [],
      inputSlots: [],
      totalInputLimit: 0,
      mediaTypeLimits: { image: 0, video: 0, audio: 0 },
      supportsGenerateAudio: false,
      supportsPreserveSourceAudio: false,
      supportsMask: false,
      supportsTimeRange: false,
      supportsSourceTaskContinuation: false,
    };
  }
  return {
    ...generation,
    operations: (generation.operations as Array<Record<string, unknown>>).map((operation) => ({
      ...operation,
    })),
  };
}

function isMediaCapabilities(
  value: Record<string, unknown>,
  type: "image" | "video",
  managedValueOffer = false,
): boolean {
  const allowed = type === "image" ? IMAGE_CAPABILITY_FIELDS : VIDEO_CAPABILITY_FIELDS;
  if (!exactFields(value, allowed)) return false;
  if (
    typeof value.status !== "string"
    || typeof value.canSubmit !== "boolean"
    || (value.unavailableReason !== null && typeof value.unavailableReason !== "string")
    || (value.description !== null && typeof value.description !== "string")
    || !strings(value.aliases)
    || !strings(value.aspectRatios)
    || (value.defaultAspectRatio !== null && typeof value.defaultAspectRatio !== "string")
    || !Array.isArray(value.inputSlots)
    || !value.inputSlots.every(isPublicInputSlot)
  ) return false;
  if (type === "image") {
    return strings(value.qualities)
      && (value.defaultQuality === null || typeof value.defaultQuality === "string")
      && Number.isSafeInteger(value.maxOutputs)
      && Number(value.maxOutputs) === 1;
  }
  return strings(value.resolutions)
    && (value.defaultResolution === null || typeof value.defaultResolution === "string")
    && isDuration(value.duration)
    && (value.supportsGenerateAudio === null || typeof value.supportsGenerateAudio === "boolean")
    && strings(value.modes)
    && isVideoGeneration(value.videoGeneration);
}

function isCatalogEntry(value: unknown, expectedType: CatalogResponseType): value is CatalogEntry {
  if (!record(value)) return false;
  const managedValueOffer = isFanjinValueVideoModel(value.model);
  if (!exactFields(value, managedValueOffer ? MANAGED_VALUE_ENTRY_FIELDS : ENTRY_FIELDS)) return false;
  if (!CATALOG_TYPES.includes(value.type as CatalogType)) return false;
  if (expectedType !== "all" && value.type !== expectedType) return false;
  if (
    typeof value.id !== "string" || !value.id
    || typeof value.model !== "string" || !value.model
    || typeof value.name !== "string" || !value.name
    || typeof value.displayName !== "string" || !value.displayName
    || (!managedValueOffer
      && value.enhanceDisplayName !== null
      && typeof value.enhanceDisplayName !== "string")
    || typeof value.isDefault !== "boolean"
    || !record(value.capabilities)
  ) return false;
  if (value.type === "image" || value.type === "video") {
    return isMediaCapabilities(value.capabilities, value.type, managedValueOffer);
  }
  return exactFields(value.capabilities, GENERIC_CAPABILITY_FIELDS)
    && typeof value.capabilities.status === "string"
    && typeof value.capabilities.canSubmit === "boolean"
    && (value.capabilities.unavailableReason === null
      || typeof value.capabilities.unavailableReason === "string");
}

/** Rejects malformed/poisoned cache data and any secret-shaped nested field. */
export function isWorkbenchModelDirectoryDto(
  value: unknown,
  expectedType: CatalogResponseType,
): value is WorkbenchModelDirectoryDto {
  if (!record(value) || !exactFields(value, DTO_FIELDS) || value.type !== expectedType) return false;
  if (!record(value.defaults) || !Object.keys(value.defaults).every((key) => DEFAULT_FIELDS.has(key))) return false;
  if (!Object.values(value.defaults).every((id) => typeof id === "string" && Boolean(id.trim()))) return false;
  if (!Array.isArray(value.models) || value.models.length > 10_000) return false;
  return value.models.every((entry) => isCatalogEntry(entry, expectedType));
}

function mediaCapabilities(capability: WorkbenchModelCapability): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {
    status: capability.capabilityStatus,
    canSubmit: capability.canSubmit,
    unavailableReason: capability.unavailableReason ?? null,
    aliases: publicStrings(capability.aliases),
    description: capability.description ?? null,
    aspectRatios: publicStrings(capability.aspectRatios),
    defaultAspectRatio: capability.defaultAspectRatio ?? null,
    inputSlots: publicInputSlots(capability.inputSlots),
  };
  if (capability.endpointType === "image_generation") {
    capabilities.qualities = publicStrings(capability.qualities);
    capabilities.defaultQuality = capability.defaultQuality ?? null;
    capabilities.maxOutputs = 1;
  } else {
    // buildWorkbenchModelCatalog already intersects certification inventory
    // with the exact Relay dispatch policy. Do not derive a second, divergent
    // resolution surface here.
    capabilities.resolutions = publicStrings(capability.resolutions);
    capabilities.defaultResolution = capability.defaultResolution ?? null;
    capabilities.duration = capability.duration ?? null;
    capabilities.supportsGenerateAudio = capability.supportsGenerateAudio ?? null;
    capabilities.modes = publicStrings(capability.modes);
    capabilities.videoGeneration = publicVideoGeneration(
      capability.videoGeneration,
      capability.model,
      capability.resolutions,
    );
  }
  return capabilities;
}

function mediaEntry(
  capability: WorkbenchModelCapability,
  type: "image" | "video",
  defaults: PlatformModelDefaults,
): CatalogEntry {
  const publicCapability = publicWorkbenchModelCapability(capability);
  const managedValueOffer = isFanjinValueVideoModel(publicCapability.model);
  const name = publicCapability.routeName || publicCapability.label || publicCapability.model;
  const sceneDefault = type === "image" ? defaults.image : defaults.video;
  return {
    id: publicCapability.id,
    model: publicCapability.model,
    type,
    name,
    displayName: publicCapability.displayName || name,
    ...(managedValueOffer
      ? {}
      : { enhanceDisplayName: publicCapability.enhanceDisplayName ?? null }),
    capabilities: mediaCapabilities(publicCapability),
    isDefault: Boolean(sceneDefault) && internalModelId(publicCapability.id) === internalModelId(sceneDefault),
  };
}

function genericEntry(
  summary: WorkbenchRouteModelSummary,
  type: "text" | "audio",
  defaults: PlatformModelDefaults,
): CatalogEntry {
  const sceneDefault = type === "text" ? defaults.text : undefined;
  return {
    id: summary.id,
    model: summary.model,
    type,
    name: summary.name,
    displayName: summary.displayName || summary.name,
    enhanceDisplayName: summary.enhanceDisplayName,
    capabilities: {
      status: summary.capabilityStatus,
      canSubmit: summary.canSubmit,
      unavailableReason: summary.unavailableReason ?? null,
    },
    isDefault: Boolean(sceneDefault) && summary.id === sceneDefault,
  };
}

async function buildModelDirectoryDto(input: {
  workspaceId: string;
  types: CatalogType[];
  responseType: CatalogResponseType;
}): Promise<WorkbenchModelDirectoryDto> {
  const defaults = await readPlatformModelDefaults();

  const needsMediaCatalog = input.types.some((type) => type === "image" || type === "video");
  const mediaCatalog = needsMediaCatalog ? await buildWorkbenchModelCatalog(input.workspaceId) : null;

  const models: CatalogEntry[] = [];
  for (const type of input.types) {
    if (type === "image") {
      for (const capability of mediaCatalog?.imageModels ?? []) models.push(mediaEntry(capability, "image", defaults));
      continue;
    }
    if (type === "video") {
      for (const capability of mediaCatalog?.videoModels ?? []) models.push(mediaEntry(capability, "video", defaults));
      continue;
    }
    const summaries = await listWorkbenchRouteModels({
      workspaceId: input.workspaceId,
      endpointTypes: GENERIC_ENDPOINT_TYPES[type],
    });
    for (const summary of summaries) models.push(genericEntry(summary, type, defaults));
  }
  const submittableModels = models.filter((model) => model.capabilities.canSubmit === true);
  const publication = await Promise.all(submittableModels.map(async (model) => {
    const endpointType = model.type === "image"
      ? "image_generation"
      : model.type === "video"
        ? "video_generation"
        : model.type === "audio"
          ? "tts"
          : "text";
    return await explainManagedLogicalModelPublication({
      workspaceId: input.workspaceId,
      endpointType,
      model: model.model,
    });
  }));
  const publishedModels = submittableModels.filter((_, index) => (
    !publication[index].managed || publication[index].ready
  )).map(sanitizePublicModelDirectoryProjection);

  return {
    type: input.responseType,
    defaults: Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, publicModelId(value)])),
    models: publishedModels,
  };
}

export default router.get("/", async (req, res) => {
  const rawType = String(req.query.type ?? "").trim().toLowerCase();
  if (rawType && !CATALOG_TYPES.includes(rawType as CatalogType)) {
    return res.status(400).send({ message: "type 参数无效，支持 video | image | text | audio" });
  }

  const auth = (req as any).auth;
  const authenticatedWorkspaceId = String(auth?.workspaceId || "").trim();
  if (!authenticatedWorkspaceId || !auth?.user?.id) {
    return res.status(401).send({ message: "未提供有效的工作区认证" });
  }
  const workspaceId = authenticatedWorkspaceId;
  const pricingGroup = await resolveWorkspacePricingGroup(db, workspaceId);
  const types = rawType ? [rawType as CatalogType] : [...CATALOG_TYPES];
  const responseType: CatalogResponseType = rawType ? rawType as CatalogType : "all";
  const validator = (value: unknown): value is WorkbenchModelDirectoryDto => (
    isWorkbenchModelDirectoryDto(value, responseType)
  );
  const load = async () => {
    const fresh = await buildModelDirectoryDto({ workspaceId, types, responseType });
    if (!validator(fresh)) throw new CacheAsideSourceValidationError();
    return fresh;
  };

  // The payer/owner pricing group is an explicit cache dimension: a group
  // change must never reuse another audience's model visibility snapshot.
  const dto = isWorkbenchModelDirectoryCacheEnabled()
    ? await cacheAside({
        namespace: WORKBENCH_MODEL_DIRECTORY_CACHE_NAMESPACE,
        schemaVersion: WORKBENCH_MODEL_DIRECTORY_CACHE_SCHEMA,
        keyParts: {
          workspaceId: authenticatedWorkspaceId,
          pricingGroup,
          queryType: responseType,
          audience: "authenticated",
        },
        ttlMs: WORKBENCH_MODEL_DIRECTORY_CACHE_TTL_MS,
        jitterRatio: WORKBENCH_MODEL_DIRECTORY_CACHE_JITTER,
        validator,
        load,
      })
    : await load();

  res.status(200).send(success(dto));
});
