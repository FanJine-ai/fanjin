import { internalModelId, MINIMAX_H3_CINEMA_MODEL, isFanjinH3Model, publicH3ModelCapability } from "@/lib/minimaxH3PublicIdentity";
import { autoDLH3OutputPrice } from "@/lib/autodlH3Pricing";
import { isAutoDLH3LocalLightWorkflow } from "@/lib/autodlH3Manifest";
import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import {
  selectChannelCandidates,
  selectPreferredModelRouteScope,
} from "@/lib/channelRouter";
import {
  inspectProviderChannelConfiguration,
  type ProviderChannelRecord,
} from "@/lib/providerChannelHealth";
import { success } from "@/lib/responseFormat";
import type { RelayChannel } from "@/lib/sharedTypes";
import {
  getRequestedWorkspaceId,
  isPlatformAdmin,
  requireWorkspacePermission,
} from "@/middleware/permissions";
import {
  buildWorkbenchModelCatalog,
  explainManagedLogicalModelPublication,
} from "@/lib/workbenchModelCatalog";
import { resolveUserVisibleModelOffer } from "@/lib/userVisibleModelOffer";
import { isManagedModelRoute } from "@/lib/modelRouteGroups";
import {
  isFanjinValueVideoModel,
  publicWorkbenchModelCapability,
  sanitizePublicModelDirectoryText,
} from "@/lib/fanjinValueVideoOffers";

const router = express.Router();
router.use(requireWorkspacePermission("api_key:read"));

const publicEndpointTypes = [
  "text",
  "embedding",
  "multimodal_embedding",
  "transcription",
  "tts",
  "rerank",
  "video_generation",
  "image_generation",
] as const;

type PublicEndpointType = (typeof publicEndpointTypes)[number];
type PublicStatus = "active" | "unavailable";

type PublicCatalogItem = {
  category: string;
  endpointType: PublicEndpointType;
  model: string;
  name: string;
  apiStyle: string;
  modalities: string[];
  output: string;
  resolutions: string[];
  defaultResolution: string | null;
  qualities: string[];
  defaultQuality: string | null;
  pricing: {
    unit: string;
    currency: string;
    unitPriceMicros: number;
  } | null;
  note: string;
  status: PublicStatus;
};

type ModelRouteGroup = {
  endpointType: PublicEndpointType;
  model: string;
  routes: Array<Record<string, any>>;
};

const publicRouteFields = [
  "scope",
  "workspaceId",
  "endpointType",
  "model",
  "disabled",
  "channelId",
  "provider",
  "displayName",
  "routeConfig",
] as const;

const publicEndpointOrder = new Map(
  publicEndpointTypes.map((endpointType, index) => [endpointType, index]),
);
const publicEndpointSet = new Set<string>(publicEndpointTypes);
const mediaEndpointSet = new Set<PublicEndpointType>([
  "video_generation",
  "image_generation",
]);

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  endpointType: z.string().optional().nullable(),
});

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function ownDataArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const length = readOwnDataProperty(value, "length");
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > 10_000
  ) {
    return [];
  }

  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return [];
      items.push(descriptor.value);
    } catch {
      return [];
    }
  }
  return items;
}

function snapshotPublicRoute(value: unknown): Record<string, any> | null {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return null;
  }
  const snapshot: Record<string, any> = {};
  for (const field of publicRouteFields) {
    snapshot[field] = readOwnDataProperty(value, field);
  }
  return snapshot;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authorizedWorkspaceId(req: express.Request): string | null {
  if (isPlatformAdmin(req)) {
    return cleanString(getRequestedWorkspaceId(req)) || null;
  }

  // The permission middleware resolves and authorizes body/query/params/auth
  // precedence once. Its member row is the authoritative workspace boundary.
  return cleanString((req as any).workspaceMember?.workspaceId) || null;
}

function applyScope(query: any, workspaceId: string) {
  query.where((builder: any) => {
    builder
      .where((platform: any) => (
        platform.where({ scope: "platform" }).whereNull("workspaceId")
      ))
      .orWhere({ scope: "workspace", workspaceId });
  });
  return query;
}

function normalizeEndpointType(value: unknown): PublicEndpointType | null {
  const endpointType = cleanString(value);
  return publicEndpointSet.has(endpointType)
    ? endpointType as PublicEndpointType
    : null;
}

function isDisabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function publicStatus(isCallable: boolean): PublicStatus {
  return isCallable ? "active" : "unavailable";
}

function stringList(value: unknown): string[] {
  const normalized: string[] = [];
  for (const item of ownDataArray(value)) {
    const text = cleanString(item);
    if (text && !normalized.includes(text)) normalized.push(text);
  }
  return normalized;
}

function validDefault(value: unknown, values: string[]): string | null {
  const normalized = cleanString(value);
  return normalized && values.includes(normalized) ? normalized : null;
}

function hasMalformedPublicMediaCapability(input: {
  endpointType: PublicEndpointType;
  resolutions: string[];
  defaultResolution: string | null;
  qualities: string[];
  defaultQuality: string | null;
}): boolean {
  if (input.endpointType === "video_generation") {
    return input.resolutions.length === 0 || input.defaultResolution === null;
  }
  if (input.endpointType === "image_generation") {
    return input.qualities.length === 0 || input.defaultQuality === null;
  }
  return false;
}

function publicNote(isCallable: boolean, malformed = false): string {
  if (isCallable) return "可通过 Developer API 调用。";
  if (malformed) return "模型能力暂不可用，请联系管理员检查配置。";
  return "模型暂不可用，请稍后重试或联系管理员。";
}

function projectPublicPricing(rule: unknown, model: string): PublicCatalogItem["pricing"] {
  const unit = cleanString(readOwnDataProperty(rule, "unit"));
  const currency = cleanString(readOwnDataProperty(rule, "currency"));
  const unitPriceMicros = Number(readOwnDataProperty(rule, "unitPriceMicros"));
  if (
    !unit
    || !currency
    || !Number.isSafeInteger(unitPriceMicros)
    || unitPriceMicros <= 0
  ) {
    return null;
  }
  if (isFanjinH3Model(model)) {
    if (unit !== "video" || currency !== "GU") return null;
    try {
      // The stored video price is a duration sample, not a flat per-video fee.
      // Use the same output-duration contract as reservation and settlement.
      const config = readOwnDataProperty(rule, "ruleConfig");
      const contract = readOwnDataProperty(config, "autodlH3Pricing");
      return {
        unit: model !== "autodl-h3-cinema" && model !== MINIMAX_H3_CINEMA_MODEL && isAutoDLH3LocalLightWorkflow() ? "video" : "second",
        currency,
        unitPriceMicros: autoDLH3OutputPrice(contract, { model: internalModelId(model), resolution: "768p", duration: 1 }),
      };
    } catch {
      return null;
    }
  }
  return { unit, currency, unitPriceMicros };
}

function isSafePublicText(value: unknown): value is string {
  const normalized = cleanString(value);
  return Boolean(normalized)
    && normalized.length <= 120;
}

function safePublicName(displayName: unknown, model: string): string {
  return sanitizePublicModelDirectoryText(
    isSafePublicText(displayName) ? displayName.trim() : model,
  );
}

function isSafePublicModel(value: unknown): value is string {
  const normalized = cleanString(value);
  return Boolean(normalized)
    && normalized.length <= 200;
}

function selectEffectiveModelRouteGroups(
  rows: unknown[],
  workspaceId: string,
): ModelRouteGroup[] {
  const grouped = new Map<string, ModelRouteGroup>();
  for (const row of rows) {
    const route = snapshotPublicRoute(row);
    if (!route) continue;
    const endpointType = normalizeEndpointType(route.endpointType);
    const modelValue = route.model;
    const model = cleanString(modelValue);
    if (!endpointType || !isSafePublicModel(modelValue)) continue;
    const key = `${endpointType}\u0000${model}`;
    const group = grouped.get(key) || { endpointType, model, routes: [] };
    group.routes.push(route);
    grouped.set(key, group);
  }

  const selected: ModelRouteGroup[] = [];
  for (const group of grouped.values()) {
    try {
      const routes = selectPreferredModelRouteScope(group.routes, workspaceId);
      if (routes.length) selected.push({ ...group, routes });
    } catch {
      // A malformed or hostile producer row must fail closed for that model.
    }
  }
  return selected;
}

function isConfiguredCandidate(channel: RelayChannel): boolean {
  try {
    return inspectProviderChannelConfiguration(
      channel as ProviderChannelRecord,
    ).status === "ready";
  } catch {
    // Tampered credential envelopes and malformed channel JSON fail closed.
    return false;
  }
}

async function canonicalReadyCandidates(
  group: ModelRouteGroup,
  workspaceId: string,
): Promise<RelayChannel[]> {
  try {
    const candidates = await selectChannelCandidates({
      endpointType: group.endpointType,
      model: group.model,
      workspaceId,
    });
    return candidates.filter(isConfiguredCandidate);
  } catch {
    // Candidate selection parses persisted channel JSON. One corrupt routing
    // group must not turn the entire public catalog into a 500 response.
    return [];
  }
}

function routeUsesReadyCandidate(
  route: Record<string, any>,
  candidates: RelayChannel[],
): boolean {
  if (isDisabled(readOwnDataProperty(route, "disabled"))) return false;
  const channelId = cleanString(readOwnDataProperty(route, "channelId"));
  const provider = cleanString(readOwnDataProperty(route, "provider"));
  if (!channelId && !provider) return false;

  return candidates.some((candidate) => {
    const candidateId = cleanString(readOwnDataProperty(candidate, "id"));
    const candidateProvider = cleanString(
      readOwnDataProperty(candidate, "provider"),
    );
    if (channelId && candidateId !== channelId) return false;
    if (provider && candidateProvider !== provider) return false;
    return Boolean(candidateId && candidateProvider);
  });
}

async function projectNonMediaRouteGroup(
  group: ModelRouteGroup,
  workspaceId: string,
): Promise<PublicCatalogItem | null> {
  if (mediaEndpointSet.has(group.endpointType)) return null;
  const requiresLogicalPublication = group.routes.some(isManagedModelRoute);
  const offer = await resolveUserVisibleModelOffer({
    workspaceId,
    endpointType: group.endpointType,
    model: group.model,
  }).catch(() => null);
  const publication = requiresLogicalPublication
    ? await explainManagedLogicalModelPublication({
        workspaceId,
        endpointType: group.endpointType,
        model: group.model,
      }).catch(() => ({ managed: true, ready: false }))
    : { managed: false, ready: true };
  const priceAdmitted = !requiresLogicalPublication || Boolean(offer) && publication.ready;
  if (requiresLogicalPublication && !priceAdmitted) return null;
  const candidates = priceAdmitted ? await canonicalReadyCandidates(group, workspaceId) : [];
  const callableRoute = priceAdmitted ? group.routes.find((route) => (
    routeUsesReadyCandidate(route, candidates)
  )) : null;
  const displayRoute = callableRoute || group.routes[0];
  if (!displayRoute) return null;

  const presentation = endpointPresentation(group.endpointType);
  const isCallable = Boolean(callableRoute);
  return {
    category: presentation.category,
    endpointType: group.endpointType,
    model: group.model,
    name: safePublicName(
      readOwnDataProperty(displayRoute, "displayName"),
      group.model,
    ),
    apiStyle: presentation.apiStyle,
    modalities: presentation.modalities,
    output: presentation.output,
    resolutions: [],
    defaultResolution: null,
    qualities: [],
    defaultQuality: null,
    pricing: projectPublicPricing(offer?.pricingRule, group.model),
    note: publicNote(isCallable),
    status: publicStatus(isCallable),
  };
}

function projectMediaCapability(
  capability: unknown,
  requestedEndpointType: PublicEndpointType | null,
): PublicCatalogItem | null {
  const endpointType = normalizeEndpointType(
    readOwnDataProperty(capability, "endpointType"),
  );
  const modelValue = readOwnDataProperty(capability, "model");
  const model = cleanString(modelValue);
  if (
    !endpointType
    || !mediaEndpointSet.has(endpointType)
    || !isSafePublicModel(modelValue)
    || (requestedEndpointType && endpointType !== requestedEndpointType)
  ) {
    return null;
  }

  const presentation = endpointPresentation(endpointType);
  const resolutions = endpointType === "video_generation"
    ? stringList(readOwnDataProperty(capability, "resolutions"))
    : [];
  const qualities = endpointType === "image_generation"
    ? stringList(readOwnDataProperty(capability, "qualities"))
    : [];
  const defaultResolution = endpointType === "video_generation"
    ? validDefault(
        readOwnDataProperty(capability, "defaultResolution"),
        resolutions,
      )
    : null;
  const defaultQuality = endpointType === "image_generation"
    ? validDefault(
        readOwnDataProperty(capability, "defaultQuality"),
        qualities,
      )
    : null;
  const malformed = hasMalformedPublicMediaCapability({
    endpointType,
    resolutions,
    defaultResolution,
    qualities,
    defaultQuality,
  });
  // Public visible means truly submit-ready. Admin diagnostics retain
  // unavailable rows; the Developer catalog must not advertise them.
  const isCallable = readOwnDataProperty(capability, "canSubmit") === true
    && !malformed;
  if (!isCallable) return null;
  const publicIdentity = publicWorkbenchModelCapability({
    model,
    displayName: readOwnDataProperty(capability, "displayName"),
    name: readOwnDataProperty(capability, "displayName"),
    description: readOwnDataProperty(capability, "description"),
    routeName: readOwnDataProperty(capability, "routeName"),
    enhanceDisplayName: readOwnDataProperty(capability, "enhanceDisplayName"),
    resolutionDeliveries: readOwnDataProperty(capability, "resolutionDeliveries"),
  });

  return {
    category: presentation.category,
    endpointType,
    model,
    name: safePublicName(
      publicIdentity.displayName || publicIdentity.name,
      model,
    ),
    apiStyle: isFanjinValueVideoModel(model)
      ? "Fanjin media generation API"
      : presentation.apiStyle,
    modalities: presentation.modalities,
    output: presentation.output,
    resolutions,
    defaultResolution,
    qualities,
    defaultQuality,
    pricing: null,
    note: publicNote(isCallable, malformed),
    status: publicStatus(isCallable),
  };
}

function dedupeAndSortItems(items: PublicCatalogItem[]): PublicCatalogItem[] {
  const byKey = new Map<string, PublicCatalogItem>();
  for (const item of items) {
    const key = `${item.endpointType}\u0000${item.model}`;
    const existing = byKey.get(key);
    if (
      !existing
      || (existing.status !== "active" && item.status === "active")
    ) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values()).sort((left, right) => {
    const endpointDelta = (
      publicEndpointOrder.get(left.endpointType) ?? 99
    ) - (publicEndpointOrder.get(right.endpointType) ?? 99);
    if (endpointDelta) return endpointDelta;
    return left.model.localeCompare(right.model);
  });
}

function emptySummary() {
  return {
    total: 0,
    active: 0,
    unavailable: 0,
    video: 0,
    llm: 0,
    embedding: 0,
  };
}

export function endpointPresentation(endpointType: string) {
  if (endpointType === "text") {
    return {
      category: "llm",
      apiStyle: "OpenAI chat compatible",
      modalities: ["text"],
      output: "text",
    };
  }
  if (endpointType === "embedding") {
    return {
      category: "embedding",
      apiStyle: "OpenAI embeddings compatible",
      modalities: ["text"],
      output: "embedding",
    };
  }
  if (endpointType === "multimodal_embedding") {
    return {
      category: "embedding",
      apiStyle: "Volcano Ark multimodal embeddings compatible",
      modalities: ["text", "image_url", "video_url"],
      output: "embedding",
    };
  }
  if (endpointType === "transcription") {
    return {
      category: "audio",
      apiStyle: "OpenAI audio transcription compatible",
      modalities: ["audio"],
      output: "text",
    };
  }
  if (endpointType === "tts") {
    return {
      category: "audio",
      apiStyle: "OpenAI text-to-speech compatible",
      modalities: ["text"],
      output: "audio",
    };
  }
  if (endpointType === "rerank") {
    return {
      category: "ranking",
      apiStyle: "Cohere/Jina rerank compatible",
      modalities: ["text"],
      output: "ranking",
    };
  }
  if (endpointType === "video_generation") {
    return {
      category: "video",
      apiStyle: "Volcano Ark compatible",
      modalities: ["text", "image_url"],
      output: "video",
    };
  }
  if (endpointType === "image_generation") {
    return {
      category: "image",
      apiStyle: "Volcano Ark compatible",
      modalities: ["text", "image_url"],
      output: "image",
    };
  }
  if (endpointType === "video_upscale") {
    return {
      category: "internal",
      apiStyle: "Internal only",
      modalities: ["video"],
      output: "video",
    };
  }
  return {
    category: "unknown",
    apiStyle: "Unsupported",
    modalities: [],
    output: "unknown",
  };
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({ message: "参数错误" });
  }

  const workspaceId = authorizedWorkspaceId(req);
  if (!workspaceId) {
    return res.status(403).send({ message: "缺少工作区上下文" });
  }

  const requestedEndpointType = parsed.data.endpointType == null
    ? null
    : normalizeEndpointType(parsed.data.endpointType);
  if (parsed.data.endpointType != null && !requestedEndpointType) {
    return res.status(200).send(success({
      workspaceId,
      items: [],
      summary: emptySummary(),
    }));
  }

  const routeQuery = applyScope(db("o_model_route"), workspaceId);
  if (requestedEndpointType) {
    routeQuery.andWhere({ endpointType: requestedEndpointType });
  } else {
    routeQuery.whereIn(
      "endpointType",
      publicEndpointTypes as unknown as string[],
    );
  }

  const [routes, mediaCatalog] = await Promise.all([
    routeQuery
      .orderBy("priority", "asc")
      .orderBy("fallbackOrder", "asc")
      .orderBy("createTime", "asc")
      .orderBy("id", "asc"),
    buildWorkbenchModelCatalog(workspaceId),
  ]);

  const items: PublicCatalogItem[] = [];
  const routeGroups = selectEffectiveModelRouteGroups(
    ownDataArray(routes),
    workspaceId,
  );
  for (const group of routeGroups) {
    const item = await projectNonMediaRouteGroup(group, workspaceId);
    if (item) items.push(item);
  }

  const mediaModels = ownDataArray(
    readOwnDataProperty(mediaCatalog, "models"),
  );
  for (const capability of mediaModels) {
    const item = projectMediaCapability(capability, requestedEndpointType);
    if (!item) continue;
    const publication = await explainManagedLogicalModelPublication({
      workspaceId,
      endpointType: item.endpointType,
      model: item.model,
    }).catch(() => ({ managed: true, ready: false }));
    if (!publication.managed || publication.ready) {
      const offer = await resolveUserVisibleModelOffer({
        workspaceId,
        endpointType: item.endpointType,
        model: item.model,
      }).catch(() => null);
      items.push({
        ...item,
        pricing: projectPublicPricing(offer?.pricingRule, item.model),
      });
    }
  }

  const publicItems = dedupeAndSortItems(items).map(publicH3ModelCapability);
  return res.status(200).send(
    success({
      workspaceId,
      items: publicItems,
      summary: {
        total: publicItems.length,
        active: publicItems.filter((item) => item.status === "active").length,
        unavailable: publicItems.filter(
          (item) => item.status === "unavailable",
        ).length,
        video: publicItems.filter((item) => item.category === "video").length,
        llm: publicItems.filter((item) => item.category === "llm").length,
        embedding: publicItems.filter(
          (item) => item.category === "embedding",
        ).length,
      },
    }),
  );
});
