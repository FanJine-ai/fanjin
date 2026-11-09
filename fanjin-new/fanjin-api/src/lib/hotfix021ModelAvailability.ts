import type { Knex } from "knex";

import { writeAuditLog } from "@/lib/audit";
import {
  FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID,
  FANJIN_VALUE_VIDEO_DEFAULT_DURATION_SECONDS,
  fanjinValueVideoDuration,
  FANJIN_VALUE_VIDEO_MIN_DURATION_SECONDS,
  FANJIN_VALUE_VIDEO_OFFERS,
  FANJIN_VALUE_VIDEO_UPSCALE_CHANNEL_ID,
  fanjinValueVideoPricingRuleId,
  fanjinValueVideoRecipeId,
  fanjinValueVideoRouteId,
} from "@/lib/fanjinValueVideoOffers";
import {
  parseFanjinValueVideoPricingContract,
  resolveFanjinValueVideoPricingSnapshot,
} from "@/lib/fanjinValueVideoPricing";
import {
  openProviderChannelCredential,
  readProviderChannelCredentialCiphertext,
  sealProviderChannelCredential,
  withProviderChannelCredentialCiphertext,
} from "@/lib/providerChannelCredentials";
import {
  MEDIAKIT_HEALTH_PROBE_TASK_ID,
  probeProviderChannel,
  type ProviderChannelProbeResult,
  type ProviderChannelRecord,
} from "@/lib/providerChannelHealth";
import {
  mergeProviderChannelConfigForUpdate,
  parseProviderChannelConfig,
} from "@/lib/providerChannelSecrets";
import { redactSensitive } from "@/lib/requestLog";
import { findVolcengineModel } from "@/lib/volcengineModelManifest";
import {
  evaluateModelRouteCertification,
  type ModelRouteCertificationReadiness,
} from "@/lib/modelRouteCertification";
import { VIDEO_FULFILLMENT_RECIPE_TABLE } from "@/lib/migrations/videoFulfillmentRecipe";
import { DEFAULT_PRICING_GROUP } from "@/lib/pricingAudience";
import { resolveProviderSpecificPricingRuleWithAudience } from "@/lib/providerSpecificPricingReadModel";
import {
  calculateResolvedVideoInputCost,
  resolveVideoInputPricing,
} from "@/lib/videoInputPricing";
import { normalizeVideoResolution } from "@/lib/videoResolutions";
import { buildWorkbenchRouteCapabilityContractForOperator } from "@/lib/workbenchModelCatalog";

export const MODEL_AVAILABILITY_HOTFIX_ID =
  "fanjin-0.2.1-model-availability-hotfix/v1" as const;
export const MODEL_AVAILABILITY_HOTFIX_ACK =
  "apply-fanjin-0.2.1-model-availability-hotfix" as const;

export const SEEDANCE20_CANONICAL_ROUTE_ID =
  "51443aab-1c89-4b8c-84da-3ab7ef113838" as const;
export const SEEDANCE20_STALE_FALLBACK_ROUTE_ID =
  "8951a96d-200a-40f7-98eb-75e88a3cb692" as const;
export const CANONICAL_VOLCANO_VIDEO_CHANNEL_ID =
  "4fb391c6-984b-4645-93d5-ab1e93d64bcb" as const;
export const SEEDREAM45_ROUTE_ID =
  "78949912-71d0-40ca-883f-017683883ec2" as const;
export const SEEDREAM45_PRICING_RULE_ID =
  "fanjin-volcano-doubao-seedream-4-5-251128-pricing" as const;
const VOLCANO_ARK_ORIGIN = "https://ark.cn-beijing.volces.com" as const;
const VOLCANO_ARK_HEALTH_PROBE_URL = `${VOLCANO_ARK_ORIGIN}/api/v3/models` as const;
const VOLCANO_MEDIAKIT_ORIGIN = "https://mediakit.cn-beijing.volces.com" as const;
const VOLCANO_MEDIAKIT_SUBMIT_URL =
  `${VOLCANO_MEDIAKIT_ORIGIN}/api/v1/tools/enhance-video-fast` as const;
const VOLCANO_MEDIAKIT_STATUS_URL =
  `${VOLCANO_MEDIAKIT_ORIGIN}/api/v1/tasks/{taskId}` as const;
const VOLCANO_MEDIAKIT_HEALTH_PROBE_URL =
  `${VOLCANO_MEDIAKIT_ORIGIN}/api/v1/tasks/${MEDIAKIT_HEALTH_PROBE_TASK_ID}` as const;

type Row = Record<string, any>;

export interface ModelAvailabilityHotfixReceipt {
  format: typeof MODEL_AVAILABILITY_HOTFIX_ID;
  mode: "dry-run" | "apply";
  readyToApply: boolean;
  actions: Array<{ resource: string; action: string; needed: boolean }>;
  probes: {
    generation: { status: string; httpStatus: number | null };
    upscale: { status: string; httpStatus: number | null; contract: string | null };
  };
  models: Array<{ id: string; publicName: string }>;
  blockers: string[];
  completedAt: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function parseJson(value: unknown): Record<string, unknown> {
  return parseProviderChannelConfig(value);
}

function number(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function publicModelBlockerPrefix(publicModel: string): string {
  return `VALUE_VIDEO_${publicModel.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`;
}

function stringArray(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.map((item) => text(item)).filter(Boolean) : [];
}

export function modelAvailabilityValueOfferAdmissionBlockers(input: {
  offer: (typeof FANJIN_VALUE_VIDEO_OFFERS)[number];
  route?: Row | null;
  publicOffer?: Row | null;
  pricingRule?: Row | null;
  recipe?: Row | null;
  routePeers?: Row[];
  certification?: Pick<
    ModelRouteCertificationReadiness,
    "valid" | "hiddenFromUserCatalog" | "requiredOperations" | "operations"
  > | null;
  pricingContractReady: boolean;
  publicAudienceReady: boolean;
  capabilityContractReady: boolean;
}): string[] {
  const { offer, route, publicOffer, pricingRule, recipe, certification } = input;
  const prefix = publicModelBlockerPrefix(offer.publicModel);
  const routeConfig = parseJson(route?.routeConfig);
  const fulfillment = parseJson(routeConfig.fulfillment);
  const pricingReady = Boolean(
    pricingRule
    && text(pricingRule.id) === fanjinValueVideoPricingRuleId(offer.publicModel)
    && text(pricingRule.scope) === "platform"
    && !text(pricingRule.workspaceId)
    && text(pricingRule.endpointType) === "video_generation"
    && text(pricingRule.provider) === "volcano"
    && text(pricingRule.model) === offer.publicModel
    && text(pricingRule.unit) === "token"
    && text(pricingRule.currency).toUpperCase() === "GU"
    && number(pricingRule.unitPriceMicros) > 0
    && number(pricingRule.disabled) === 0
    && input.pricingContractReady
    && input.publicAudienceReady
  );
  const certificationReady = Boolean(
    certification?.valid
    && !certification.hiddenFromUserCatalog
    && certification.requiredOperations.length > 0
    && certification.requiredOperations.every((operationKey) => (
      certification.operations.some((operation) => (
        operation.operationKey === operationKey && operation.valid
      ))
    ))
  );
  const visibleResolutions = stringArray(publicOffer?.visibleResolutions)
    .map((resolution) => normalizeVideoResolution(resolution))
    .filter(Boolean);
  const fulfillmentReady = Boolean(
    route
    && text(route.id) === fanjinValueVideoRouteId(offer.publicModel)
    && text(route.scope) === "platform"
    && !text(route.workspaceId)
    && text(route.endpointType) === "video_generation"
    && text(route.model) === offer.publicModel
    && text(route.provider) === "volcano"
    && text(route.channelId) === FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID
    && number(route.disabled) === 0
    && input.capabilityContractReady
    && input.routePeers?.filter((peer) => number(peer.disabled) === 0).length === 1
    && text(input.routePeers?.find((peer) => number(peer.disabled) === 0)?.id) === text(route.id)
    && text(routeConfig.capabilityStatus) === "verified"
    && text(routeConfig.upstreamModel) === offer.upstreamModel
    && text(fulfillment.pipeline) === "generate_then_enhance"
    && normalizeVideoResolution(fulfillment.generationResolution) === offer.generationResolution
    && normalizeVideoResolution(fulfillment.targetResolution) === offer.targetResolution
    && number(fulfillment.markupBps) === offer.markupBps
    && publicOffer
    && text(publicOffer.publicModel) === offer.publicModel
    && number(publicOffer.enabled) === 1
    && visibleResolutions.length === 1
    && visibleResolutions[0] === offer.targetResolution
    && recipe
    && text(recipe.id) === fanjinValueVideoRecipeId(offer.publicModel)
    && text(recipe.publicModel) === offer.publicModel
    && normalizeVideoResolution(recipe.targetResolution) === offer.targetResolution
    && normalizeVideoResolution(recipe.generateResolution) === offer.generationResolution
    && text(recipe.upstreamModel) === offer.upstreamModel
    && text(recipe.generateChannelId) === FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID
    && number(recipe.enhanceEnabled) === 1
    && text(recipe.enhanceChannelId) === FANJIN_VALUE_VIDEO_UPSCALE_CHANNEL_ID
    && number(recipe.enabled) === 1
  );
  return [
    ...(!pricingReady ? [`${prefix}_PRICING_NOT_READY`] : []),
    ...(!certificationReady ? [`${prefix}_CERTIFICATION_NOT_READY`] : []),
    ...(!fulfillmentReady ? [`${prefix}_FULFILLMENT_NOT_READY`] : []),
  ];
}

export function modelAvailabilityValueCapabilityContractReady(
  offer: (typeof FANJIN_VALUE_VIDEO_OFFERS)[number],
  route: Row | null | undefined,
  pricingRule: Row | null | undefined,
): boolean {
  if (!route) return false;
  const capability = buildWorkbenchRouteCapabilityContractForOperator(
    route,
    pricingRule ?? null,
  );
  const directory = capability.videoGeneration;
  const duration = capability.duration;
  const upstreamDuration = fanjinValueVideoDuration(offer.publicModel);
  const allowedDurations = Array.isArray(duration?.allowed)
    ? duration.allowed.filter((value): value is number => Number.isSafeInteger(value))
    : [];
  const supportsEveryPublicDuration = Boolean(
    duration
    && duration.min <= FANJIN_VALUE_VIDEO_MIN_DURATION_SECONDS
    && duration.max >= upstreamDuration.max
    && duration.default === FANJIN_VALUE_VIDEO_DEFAULT_DURATION_SECONDS
    && (allowedDurations.length > 0
      ? Array.from(
          {
            length: upstreamDuration.max
              - FANJIN_VALUE_VIDEO_MIN_DURATION_SECONDS + 1,
          },
          (_, index) => FANJIN_VALUE_VIDEO_MIN_DURATION_SECONDS + index,
        ).every((value) => allowedDurations.includes(value))
      : duration.step === 1)
  );
  return Boolean(
    capability.canSubmit
    && capability.capabilityStatus === "verified"
    && capability.resolutions?.length === 1
    && capability.resolutions[0] === offer.targetResolution
    && capability.defaultResolution === offer.targetResolution
    && capability.aspectRatios?.length
    && capability.defaultAspectRatio
    && supportsEveryPublicDuration
    && capability.modes?.length
    && typeof capability.supportsGenerateAudio === "boolean"
    && directory?.dispatchable
  );
}

async function valuePricingContractReady(
  database: Knex,
  offer: (typeof FANJIN_VALUE_VIDEO_OFFERS)[number],
  pricingRule: Row | null | undefined,
): Promise<boolean> {
  if (!pricingRule) return false;
  try {
    const contract = parseFanjinValueVideoPricingContract({
      publicModel: offer.publicModel,
      ruleConfig: pricingRule.ruleConfig,
    });
    if (!contract) return false;
    const selected = resolveVideoInputPricing({
      ruleConfig: pricingRule.ruleConfig,
      requestPayload: { content: [{ type: "text", text: "readiness" }], duration: contract.maxDurationSeconds },
      baseUnitPriceMicros: pricingRule.unitPriceMicros,
    });
    if (selected.reservationUpperBoundTokens == null) return false;
    return Boolean(await resolveFanjinValueVideoPricingSnapshot({
      database,
      workspaceId: "__model-availability-hotfix__",
      publicModel: offer.publicModel,
      ruleConfig: pricingRule.ruleConfig,
      requestPayload: { duration: contract.maxDurationSeconds },
      generationReservationCostMicros: calculateResolvedVideoInputCost(
        selected,
        selected.reservationUpperBoundTokens,
      ),
    }));
  } catch {
    return false;
  }
}

async function valuePublicAudienceReady(
  database: Knex,
  offer: (typeof FANJIN_VALUE_VIDEO_OFFERS)[number],
  pricingRule: Row | null | undefined,
): Promise<boolean> {
  if (!pricingRule) return false;
  const resolved = await resolveProviderSpecificPricingRuleWithAudience({
    endpointType: "video_generation",
    provider: "volcano",
    model: offer.publicModel,
    workspaceId: "__public_model_catalog__",
    pricingGroup: DEFAULT_PRICING_GROUP,
  }, database);
  return Boolean(
    resolved.rule
    && resolved.baseRule
    && resolved.baseRule.id === fanjinValueVideoPricingRuleId(offer.publicModel)
    && resolved.decision?.visible !== false
  );
}

function safeProbe(probe: ProviderChannelProbeResult): {
  status: string;
  httpStatus: number | null;
  contract?: string | null;
} {
  return {
    status: probe.healthStatus,
    httpStatus: number(probe.payload.httpStatus) || null,
    ...(probe.payload.probeContract
      ? { contract: text(probe.payload.probeContract) || null }
      : {}),
  };
}

function probeHealthUpdate(probe: ProviderChannelProbeResult, checkedAt: number): Row {
  return {
    healthStatus: probe.healthStatus,
    lastHealthCheckAt: checkedAt,
    lastHealthLatencyMs: probe.latencyMs,
    lastHealthError: probe.errorMessage,
    lastHealthPayload: JSON.stringify(redactSensitive(probe.payload)),
    updateTime: checkedAt,
  };
}

function hasLegacyCredentialColumn(row: Row): boolean {
  return Object.prototype.hasOwnProperty.call(row, "credentialCiphertext");
}

export function modelAvailabilityProbeChannel(
  channel: Row,
  configJson: Record<string, unknown>,
  preferCanonicalConfigCredential: boolean,
): ProviderChannelRecord {
  return {
    ...(channel as ProviderChannelRecord),
    // Runtime gives the historical column precedence over the reserved config
    // slot. Candidate probes must exercise the value that apply will make
    // canonical, never a stale legacy column that would mask it.
    ...(preferCanonicalConfigCredential ? { credentialCiphertext: null } : {}),
    configJson,
  };
}

function canonicalChannelCredentialUpdate(
  channel: Row,
  configJson: Record<string, unknown>,
  probe: ProviderChannelProbeResult,
  checkedAt: number,
): Row {
  return {
    configJson: JSON.stringify(configJson),
    // Newer schemas keep the sealed value only in the reserved config slot.
    // On an upgraded legacy schema, clear the precedence-taking column in the
    // same transaction so dispatch and subsequent probes resolve that slot.
    ...(hasLegacyCredentialColumn(channel) ? { credentialCiphertext: null } : {}),
    ...probeHealthUpdate(probe, checkedAt),
  };
}

export function modelAvailabilityExactChannelReady(row: Row | undefined, input: {
  id: string;
  provider: string;
  endpointType: string;
  targetResolution?: string;
}): boolean {
  if (!row) return false;
  if (
    text(row.id) !== input.id
    || text(row.provider) !== input.provider
    || text(row.endpointType) !== input.endpointType
    || text(row.scope) !== "platform"
    || row.workspaceId != null
    || number(row.disabled) !== 0
  ) return false;
  const config = parseJson(row.configJson);
  const expectedOrigin = input.endpointType === "video_upscale"
    ? VOLCANO_MEDIAKIT_ORIGIN
    : VOLCANO_ARK_ORIGIN;
  try {
    const baseUrl = new URL(text(row.baseUrl));
    if (
      baseUrl.protocol !== "https:"
      || baseUrl.origin !== expectedOrigin
      || !["", "/"].includes(baseUrl.pathname)
      || baseUrl.search
      || baseUrl.hash
      || baseUrl.username
      || baseUrl.password
    ) return false;
  } catch {
    return false;
  }
  if (input.endpointType !== "video_upscale") {
    const healthProbeUrl = text(config.healthProbeUrl);
    return !healthProbeUrl || healthProbeUrl === VOLCANO_ARK_HEALTH_PROBE_URL;
  }
  if (
    text(config.submitEndpoint) !== VOLCANO_MEDIAKIT_SUBMIT_URL
    || text(config.statusEndpoint) !== VOLCANO_MEDIAKIT_STATUS_URL
    || text(config.healthProbeUrl) !== VOLCANO_MEDIAKIT_HEALTH_PROBE_URL
    || text(config.enhanceSubmitEndpoint)
    || text(config.enhanceStatusEndpoint)
    || text(config.mode)
  ) return false;
  if (!input.targetResolution) return true;
  const declared = Array.isArray(config.supportedResolutions)
    ? config.supportedResolutions
    : Array.isArray(config.resolutions)
      ? config.resolutions
      : [];
  return declared.length === 0 || declared.some((resolution) => (
    normalizeVideoResolution(resolution) === normalizeVideoResolution(input.targetResolution)
  ));
}

function assertExactChannel(row: Row | undefined, input: {
  id: string;
  provider: string;
  endpointType: string;
  targetResolution?: string;
}): asserts row is Row {
  if (!row) throw new Error(`MODEL_HOTFIX_CHANNEL_MISSING:${input.id}`);
  if (!modelAvailabilityExactChannelReady(row, input)) {
    throw new Error(`MODEL_HOTFIX_CHANNEL_IDENTITY_MISMATCH:${input.id}`);
  }
}

function assertExactSeedanceRoutes(canonical: Row | undefined, stale: Row | undefined): void {
  if (
    !canonical
    || text(canonical.id) !== SEEDANCE20_CANONICAL_ROUTE_ID
    || text(canonical.model) !== "doubao-seedance-2-0-260128"
    || text(canonical.endpointType) !== "video_generation"
    || text(canonical.channelId) !== CANONICAL_VOLCANO_VIDEO_CHANNEL_ID
    || number(canonical.disabled) !== 0
  ) throw new Error("MODEL_HOTFIX_SEEDANCE20_CANONICAL_ROUTE_MISMATCH");
  if (
    !stale
    || text(stale.id) !== SEEDANCE20_STALE_FALLBACK_ROUTE_ID
    || text(stale.model) !== "doubao-seedance-2-0-260128"
    || text(stale.endpointType) !== "video_generation"
  ) throw new Error("MODEL_HOTFIX_SEEDANCE20_STALE_ROUTE_MISMATCH");
  const staleConfig = parseJson(stale.routeConfig);
  if (
    Object.keys(staleConfig).length > 0
    || text(stale.channelId) === CANONICAL_VOLCANO_VIDEO_CHANNEL_ID
  ) throw new Error("MODEL_HOTFIX_SEEDANCE20_STALE_ROUTE_PRECONDITION_FAILED");
}

/** Mirrors the public catalog's route-local narrowing + official-manifest fallback. */
export function requiredSeedream45QualityOperations(routeConfig: unknown): string[] {
  const config = parseJson(routeConfig);
  const capabilities = parseJson(config.capabilities);
  const configured = [
    ...(Array.isArray(config.qualities) ? config.qualities : []),
    ...(Array.isArray(config.resolutions) ? config.resolutions : []),
    ...(Array.isArray(capabilities.qualities) ? capabilities.qualities : []),
    ...(Array.isArray(capabilities.resolutions) ? capabilities.resolutions : []),
  ]
    .map((value) => text(value).toUpperCase())
    .filter((value, index, list) => (
      ["2K", "4K"].includes(value) && list.indexOf(value) === index
    ));
  const official = findVolcengineModel(
    "doubao-seedream-4-5-251128",
    "image_generation",
  );
  const qualities = configured.length > 0
    ? configured
    : official?.endpointType === "image_generation"
      ? official.qualities.map((value) => text(value).toUpperCase())
      : [];
  if (qualities.length === 0) {
    throw new Error("MODEL_HOTFIX_SEEDREAM45_PUBLIC_QUALITIES_MISSING");
  }
  return qualities.map((quality) => `quality:${quality}`);
}

async function readRows(database: Knex): Promise<{
  canonicalRoute: Row;
  staleRoute: Row;
  sourceChannel: Row;
  generationChannel: Row;
  upscaleChannel: Row;
  valueRoutes: Row[];
  valueRoutePeers: Row[];
  valueOffers: Row[];
  valuePricingRules: Row[];
  valueRecipes: Row[];
  valueAdmissionBlockers: string[];
  seedreamRoute: Row;
  seedreamPricingRule: Row;
  requiredSeedreamQualityOperations: string[];
  missingSeedreamQualityOperations: string[];
}> {
  const [canonicalRoute, staleRoute, sourceChannel, generationChannel, upscaleChannel, seedreamRoute, seedreamPricingRule] = await Promise.all([
    database("o_model_route").where({ id: SEEDANCE20_CANONICAL_ROUTE_ID }).first(),
    database("o_model_route").where({ id: SEEDANCE20_STALE_FALLBACK_ROUTE_ID }).first(),
    database("o_provider_channel").where({ id: CANONICAL_VOLCANO_VIDEO_CHANNEL_ID }).first(),
    database("o_provider_channel").where({ id: FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID }).first(),
    database("o_provider_channel").where({ id: FANJIN_VALUE_VIDEO_UPSCALE_CHANNEL_ID }).first(),
    database("o_model_route").where({ id: SEEDREAM45_ROUTE_ID }).first(),
    database("o_pricing_rule").where({ id: SEEDREAM45_PRICING_RULE_ID }).first(),
  ]);
  assertExactSeedanceRoutes(canonicalRoute, staleRoute);
  assertExactChannel(sourceChannel, {
    id: CANONICAL_VOLCANO_VIDEO_CHANNEL_ID,
    provider: "volcano",
    endpointType: "video_generation",
  });
  assertExactChannel(generationChannel, {
    id: FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID,
    provider: "volcano",
    endpointType: "video_generation",
  });
  assertExactChannel(upscaleChannel, {
    id: FANJIN_VALUE_VIDEO_UPSCALE_CHANNEL_ID,
    provider: "volcano",
    endpointType: "video_upscale",
    targetResolution: "720p",
  });
  if (
    !seedreamRoute
    || text(seedreamRoute.id) !== SEEDREAM45_ROUTE_ID
    || text(seedreamRoute.model) !== "doubao-seedream-4-5-251128"
    || text(seedreamRoute.endpointType) !== "image_generation"
    || number(seedreamRoute.disabled) !== 0
  ) throw new Error("MODEL_HOTFIX_SEEDREAM45_ROUTE_MISMATCH");
  if (
    !seedreamPricingRule
    || text(seedreamPricingRule.id) !== SEEDREAM45_PRICING_RULE_ID
    || text(seedreamPricingRule.model) !== "doubao-seedream-4-5-251128"
    || text(seedreamPricingRule.endpointType) !== "image_generation"
    || text(seedreamPricingRule.provider) !== "volcano"
    || number(seedreamPricingRule.disabled) !== 0
  ) throw new Error("MODEL_HOTFIX_SEEDREAM45_PRICING_MISMATCH");

  const routeIds = FANJIN_VALUE_VIDEO_OFFERS.map((offer) => fanjinValueVideoRouteId(offer.publicModel));
  const publicModels = FANJIN_VALUE_VIDEO_OFFERS.map((offer) => offer.publicModel);
  const pricingRuleIds = FANJIN_VALUE_VIDEO_OFFERS.map((offer) => (
    fanjinValueVideoPricingRuleId(offer.publicModel)
  ));
  const recipeIds = FANJIN_VALUE_VIDEO_OFFERS.map((offer) => (
    fanjinValueVideoRecipeId(offer.publicModel)
  ));
  const requiredSeedreamQualityOperations = requiredSeedream45QualityOperations(
    seedreamRoute.routeConfig,
  );
  const [valueRoutes, valueRoutePeers, valueOffers, valuePricingRules, valueRecipes] = await Promise.all([
    database("o_model_route").whereIn("id", routeIds),
    database("o_model_route")
      .where({ endpointType: "video_generation" })
      .whereIn("model", publicModels),
    database("o_video_public_offer").whereIn("publicModel", publicModels),
    database("o_pricing_rule").whereIn("id", pricingRuleIds),
    database(VIDEO_FULFILLMENT_RECIPE_TABLE).whereIn("id", recipeIds),
  ]);
  if (valueRoutes.length !== routeIds.length) throw new Error("MODEL_HOTFIX_VALUE_ROUTE_SET_MISMATCH");
  if (valueOffers.length !== publicModels.length) throw new Error("MODEL_HOTFIX_VALUE_OFFER_SET_MISMATCH");
  for (const offer of FANJIN_VALUE_VIDEO_OFFERS) {
    const route = valueRoutes.find((row) => text(row.model) === offer.publicModel);
    const publicOffer = valueOffers.find((row) => text(row.publicModel) === offer.publicModel);
    if (
      !route
      || text(route.id) !== fanjinValueVideoRouteId(offer.publicModel)
      || text(route.channelId) !== FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID
      || number(route.disabled) !== 0
      || !publicOffer
      || number(publicOffer.enabled) !== 1
    ) throw new Error(`MODEL_HOTFIX_VALUE_OFFER_PRECONDITION_FAILED:${offer.publicModel}`);
  }
  const seedreamCertification = await evaluateModelRouteCertification({
    database,
    route: seedreamRoute,
    pricingRule: seedreamPricingRule,
  });
  const valueAdmissionBlockers = (await Promise.all(
    FANJIN_VALUE_VIDEO_OFFERS.map(async (offer) => {
      const route = valueRoutes.find((row) => text(row.model) === offer.publicModel);
      const publicOffer = valueOffers.find((row) => text(row.publicModel) === offer.publicModel);
      const routePeers = valueRoutePeers.filter((row) => text(row.model) === offer.publicModel);
      const pricingRule = valuePricingRules.find((row) => (
        text(row.id) === fanjinValueVideoPricingRuleId(offer.publicModel)
      ));
      const recipe = valueRecipes.find((row) => (
        text(row.id) === fanjinValueVideoRecipeId(offer.publicModel)
      ));
      const certification = route
        ? await evaluateModelRouteCertification({ database, route, pricingRule: pricingRule ?? null })
        : null;
      return modelAvailabilityValueOfferAdmissionBlockers({
        offer,
        route,
        publicOffer,
        routePeers,
        pricingRule,
        recipe,
        certification,
        pricingContractReady: await valuePricingContractReady(database, offer, pricingRule),
        publicAudienceReady: await valuePublicAudienceReady(database, offer, pricingRule),
        capabilityContractReady: modelAvailabilityValueCapabilityContractReady(
          offer,
          route,
          pricingRule,
        ),
      });
    }),
  )).flat();
  return {
    canonicalRoute,
    staleRoute,
    sourceChannel,
    generationChannel,
    upscaleChannel,
    valueRoutes,
    valueRoutePeers,
    valueOffers,
    valuePricingRules,
    valueRecipes,
    valueAdmissionBlockers,
    seedreamRoute,
    seedreamPricingRule,
    requiredSeedreamQualityOperations,
    missingSeedreamQualityOperations: requiredSeedreamQualityOperations.filter((operationKey) => (
      !seedreamCertification.operations.some((operation) => (
        operation.operationKey === operationKey && operation.valid
      ))
    )),
  };
}

function migratedGenerationConfig(sourceChannel: Row, generationChannel: Row): Record<string, unknown> {
  const sourceCiphertext = text(sourceChannel.credentialCiphertext)
    || readProviderChannelCredentialCiphertext(sourceChannel.configJson);
  const sourcePlaintext = openProviderChannelCredential(
    CANONICAL_VOLCANO_VIDEO_CHANNEL_ID,
    sourceCiphertext,
  );
  if (!sourcePlaintext) throw new Error("MODEL_HOTFIX_CANONICAL_VOLCANO_CREDENTIAL_UNREADABLE");
  const existingDestinationCiphertext = text(generationChannel.credentialCiphertext)
    || readProviderChannelCredentialCiphertext(generationChannel.configJson);
  const existingDestinationPlaintext = openProviderChannelCredential(
    FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID,
    existingDestinationCiphertext,
  );
  const destinationCiphertext = existingDestinationPlaintext === sourcePlaintext
    ? existingDestinationCiphertext
    : sealProviderChannelCredential(FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID, sourcePlaintext);
  return withProviderChannelCredentialCiphertext(generationChannel.configJson, destinationCiphertext);
}

export function migratedUpscaleConfig(
  upscaleChannel: Row,
  dedicatedMediaKitCredential: string,
): Record<string, unknown> {
  const credential = text(dedicatedMediaKitCredential);
  if (!credential) throw new Error("MODEL_HOTFIX_DEDICATED_MEDIAKIT_CREDENTIAL_REQUIRED");
  const existing = parseJson(upscaleChannel.configJson);
  const configured = mergeProviderChannelConfigForUpdate(existing, {
    ...existing,
    submitEndpoint: VOLCANO_MEDIAKIT_SUBMIT_URL,
    statusEndpoint: VOLCANO_MEDIAKIT_STATUS_URL,
    healthProbeUrl: VOLCANO_MEDIAKIT_HEALTH_PROBE_URL,
  });
  delete configured.enhanceSubmitEndpoint;
  delete configured.enhanceStatusEndpoint;
  delete configured.mode;
  // Never inherit the runtime VOLCANO_MEDIAKIT_API_KEY fallback here.  The
  // production incident was caused by that slot pointing at a normal Ark/
  // non-MediaKit account.  Only the dedicated operator input is re-sealed for
  // this exact channel identity.
  return withProviderChannelCredentialCiphertext(
    configured,
    sealProviderChannelCredential(FANJIN_VALUE_VIDEO_UPSCALE_CHANNEL_ID, credential),
  );
}

export function modelAvailabilityValueOfferUpdateNeeded(rows: {
  publicOffer: Row;
}, offer: (typeof FANJIN_VALUE_VIDEO_OFFERS)[number]): boolean {
  // Route rows are certification evidence. Even a presentation-only edit
  // bumps updateTime and invalidates routeSnapshotHash. Public API projection
  // owns customer-facing copy; this operator may only normalize the separate
  // public-offer label, which is outside the certification snapshot.
  return text(rows.publicOffer.displayName) !== offer.displayName;
}

export function modelAvailabilityChannelBlockers(input: {
  mode: "dry-run" | "apply";
  dedicatedMediaKitCredentialPresent: boolean;
  generationHealthStatus: string;
  upscaleHealthStatus: string;
}): string[] {
  const blockers: string[] = [];
  if (input.generationHealthStatus !== "ok") {
    blockers.push("VALUE_VIDEO_GENERATION_CHANNEL_NOT_HEALTHY");
  }
  // Apply must never reuse an unknown persisted credential, but a later
  // read-only verification intentionally probes the credential sealed by the
  // successful apply. Requiring the transient secret file forever would make
  // release readiness impossible after operators securely delete it.
  if (input.mode === "apply" && !input.dedicatedMediaKitCredentialPresent) {
    blockers.push("VALUE_VIDEO_DEDICATED_MEDIAKIT_CANDIDATE_REQUIRED");
  }
  if (input.upscaleHealthStatus !== "ok") {
    blockers.push("VALUE_VIDEO_UPSCALE_CHANNEL_NOT_HEALTHY");
  }
  return blockers;
}

export function modelAvailabilityReadyToApply(blockers: readonly string[]): boolean {
  return blockers.length === 0;
}

export function modelAvailabilityAdmissionChanged(
  expected: readonly string[],
  current: readonly string[],
): boolean {
  return expected.length !== current.length
    || expected.some((blocker, index) => blocker !== current[index]);
}

function rowUpdateTimes(rows: Row[], field: string): Map<string, number> {
  return new Map(rows.map((row) => [text(row.id || row.publicModel), number(row[field])]));
}

function sameUpdateTimes(left: Row[], right: Row[], field: string): boolean {
  const expected = rowUpdateTimes(left, field);
  return right.length === left.length && right.every((row) => (
    expected.get(text(row.id || row.publicModel)) === number(row[field])
  ));
}

export async function runModelAvailabilityHotfix(input: {
  database: Knex;
  mode: "dry-run" | "apply";
  dedicatedMediaKitCredential?: string;
  actorUserId?: number;
  now?: number;
}): Promise<ModelAvailabilityHotfixReceipt> {
  const now = input.now ?? Date.now();
  const rows = await readRows(input.database);
  const generationConfig = migratedGenerationConfig(rows.sourceChannel, rows.generationChannel);
  const dedicatedMediaKitCredential = text(input.dedicatedMediaKitCredential);
  const upscaleConfig = dedicatedMediaKitCredential
    ? migratedUpscaleConfig(rows.upscaleChannel, dedicatedMediaKitCredential)
    : mergeProviderChannelConfigForUpdate(parseJson(rows.upscaleChannel.configJson), {
        ...parseJson(rows.upscaleChannel.configJson),
        healthProbeUrl:
          `https://mediakit.cn-beijing.volces.com/api/v1/tasks/${MEDIAKIT_HEALTH_PROBE_TASK_ID}`,
      });
  const generationProbe = await probeProviderChannel({
    ...modelAvailabilityProbeChannel(rows.generationChannel, generationConfig, true),
  });
  const upscaleProbe: ProviderChannelProbeResult = await probeProviderChannel(
    modelAvailabilityProbeChannel(
      rows.upscaleChannel,
      upscaleConfig,
      Boolean(dedicatedMediaKitCredential),
    ),
  );
  const blockers = modelAvailabilityChannelBlockers({
    mode: input.mode,
    dedicatedMediaKitCredentialPresent: Boolean(dedicatedMediaKitCredential),
    generationHealthStatus: generationProbe.healthStatus,
    upscaleHealthStatus: upscaleProbe.healthStatus,
  });
  blockers.push(...rows.valueAdmissionBlockers);
  for (const operationKey of rows.missingSeedreamQualityOperations) {
    blockers.push(
      `SEEDREAM45_${operationKey.replace(":", "_").toUpperCase()}_CERTIFICATION_REQUIRED`,
    );
  }

  const actions = [
    {
      resource: SEEDANCE20_STALE_FALLBACK_ROUTE_ID,
      action: "disable_stale_fallback_route",
      needed: number(rows.staleRoute.disabled) === 0,
    },
    {
      resource: FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID,
      action: "rebind_canonical_volcano_credential_and_record_live_health",
      needed: JSON.stringify(parseJson(rows.generationChannel.configJson)) !== JSON.stringify(generationConfig)
        || Boolean(text(rows.generationChannel.credentialCiphertext))
        || text(rows.generationChannel.healthStatus) !== "ok",
    },
    {
      resource: FANJIN_VALUE_VIDEO_UPSCALE_CHANNEL_ID,
      action: "rebind_dedicated_mediakit_credential_install_authenticated_probe_and_record_live_health",
      needed: JSON.stringify(parseJson(rows.upscaleChannel.configJson)) !== JSON.stringify(upscaleConfig)
        || Boolean(text(rows.upscaleChannel.credentialCiphertext))
        || text(rows.upscaleChannel.healthStatus) !== "ok",
    },
    ...rows.requiredSeedreamQualityOperations.map((operationKey) => ({
      resource: `${SEEDREAM45_ROUTE_ID}/${operationKey}`,
      action: "certify_with_exact_successful_task_and_charged_usage",
      needed: rows.missingSeedreamQualityOperations.includes(operationKey),
    })),
    ...FANJIN_VALUE_VIDEO_OFFERS.map((offer) => ({
      resource: offer.publicModel,
      action: "normalize_public_offer_display_name",
      needed: (() => {
        const publicOffer = rows.valueOffers.find((candidate) => text(candidate.publicModel) === offer.publicModel)!;
        return modelAvailabilityValueOfferUpdateNeeded({ publicOffer }, offer);
      })(),
    })),
    ...FANJIN_VALUE_VIDEO_OFFERS.map((offer) => ({
      resource: offer.publicModel,
      action: "verify_pricing_certification_and_fulfillment_admission",
      needed: rows.valueAdmissionBlockers.some((blocker) => (
        blocker.startsWith(publicModelBlockerPrefix(offer.publicModel))
      )),
    })),
  ];

  if (input.mode === "apply") {
    if (!Number.isSafeInteger(input.actorUserId) || Number(input.actorUserId) <= 0) {
      throw new Error("MODEL_HOTFIX_ACTOR_USER_ID_REQUIRED");
    }
    const fatalBlockers = blockers.filter((blocker) => !blocker.startsWith("SEEDREAM45_"));
    if (fatalBlockers.length) throw new Error(`MODEL_HOTFIX_PREFLIGHT_FAILED:${fatalBlockers.join(",")}`);
    await input.database.transaction(async (transaction) => {
      await transaction.raw(
        "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))",
        ["fanjin-hotfix", MODEL_AVAILABILITY_HOTFIX_ID],
      );
      const current = await readRows(transaction);
      if (
        number(current.canonicalRoute.updateTime) !== number(rows.canonicalRoute.updateTime)
        || number(current.staleRoute.updateTime) !== number(rows.staleRoute.updateTime)
        || number(current.sourceChannel.updateTime) !== number(rows.sourceChannel.updateTime)
        || number(current.generationChannel.updateTime) !== number(rows.generationChannel.updateTime)
        || text(current.generationChannel.credentialCiphertext) !== text(rows.generationChannel.credentialCiphertext)
        || number(current.upscaleChannel.updateTime) !== number(rows.upscaleChannel.updateTime)
        || text(current.upscaleChannel.credentialCiphertext) !== text(rows.upscaleChannel.credentialCiphertext)
        || number(current.seedreamRoute.updateTime) !== number(rows.seedreamRoute.updateTime)
        || number(current.seedreamPricingRule.updateTime) !== number(rows.seedreamPricingRule.updateTime)
        || !sameUpdateTimes(rows.valueRoutes, current.valueRoutes, "updateTime")
        || !sameUpdateTimes(rows.valueRoutePeers, current.valueRoutePeers, "updateTime")
        || !sameUpdateTimes(rows.valueOffers, current.valueOffers, "updatedAt")
        || !sameUpdateTimes(rows.valuePricingRules, current.valuePricingRules, "updateTime")
        || !sameUpdateTimes(rows.valueRecipes, current.valueRecipes, "updatedAt")
        || modelAvailabilityAdmissionChanged(
          rows.valueAdmissionBlockers,
          current.valueAdmissionBlockers,
        )
      ) throw new Error("MODEL_HOTFIX_CONCURRENT_CONFIGURATION_CHANGE");

      if (number(current.staleRoute.disabled) === 0) {
        await transaction("o_model_route")
          .where({ id: SEEDANCE20_STALE_FALLBACK_ROUTE_ID, disabled: 0 })
          .update({ disabled: 1, updateTime: now });
      }
      await transaction("o_provider_channel")
        .where({ id: FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID })
        .update(canonicalChannelCredentialUpdate(
          current.generationChannel,
          generationConfig,
          generationProbe,
          now,
        ));
      await transaction("o_provider_channel")
        .where({ id: FANJIN_VALUE_VIDEO_UPSCALE_CHANNEL_ID })
        .update(canonicalChannelCredentialUpdate(
          current.upscaleChannel,
          upscaleConfig,
          upscaleProbe,
          now,
        ));
      for (const offer of FANJIN_VALUE_VIDEO_OFFERS) {
        const publicOffer = current.valueOffers.find((candidate) => (
          text(candidate.publicModel) === offer.publicModel
        ))!;
        if (text(publicOffer.displayName) !== offer.displayName) {
          await transaction("o_video_public_offer")
            .where({ publicModel: offer.publicModel })
            .update({ displayName: offer.displayName, updatedAt: now });
        }
      }
      await writeAuditLog(
        { actor: { actorUserId: Number(input.actorUserId), actorKind: "user" } },
        {
          action: "operator.model_availability_hotfix.apply",
          resourceType: "model_availability_hotfix",
          resourceId: MODEL_AVAILABILITY_HOTFIX_ID,
          required: true,
          metadata: {
            sourceChannelId: CANONICAL_VOLCANO_VIDEO_CHANNEL_ID,
            staleRouteId: SEEDANCE20_STALE_FALLBACK_ROUTE_ID,
            valueOfferCount: FANJIN_VALUE_VIDEO_OFFERS.length,
            seedream45RequiredQualityOperations: current.requiredSeedreamQualityOperations,
            seedream45MissingQualityOperations: current.missingSeedreamQualityOperations,
          },
        },
        transaction,
      );
    });
  }

  return {
    format: MODEL_AVAILABILITY_HOTFIX_ID,
    mode: input.mode,
    readyToApply: modelAvailabilityReadyToApply(blockers),
    actions,
    probes: {
      generation: safeProbe(generationProbe),
      upscale: {
        ...safeProbe(upscaleProbe),
        contract: text(upscaleProbe.payload.probeContract) || null,
      },
    },
    models: FANJIN_VALUE_VIDEO_OFFERS.map((offer) => ({
      id: offer.publicModel,
      publicName: offer.displayName,
    })),
    blockers,
    completedAt: now,
  };
}
