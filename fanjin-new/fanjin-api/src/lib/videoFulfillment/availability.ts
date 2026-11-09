import type { Knex } from "knex";
import { findMediaService, mediaKitRuntimeConfig } from "@/lib/mediaServices";
import {
  resolveProviderSpecificPricingRule,
  type PricingRule,
} from "@/lib/providerSpecificPricingReadModel";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  isPreviewProviderDispatchDisabled,
  providerCredentialFallbackEnvNames,
  resolveChannelApiKey,
  resolveChannelBaseUrl,
} from "@/lib/relayChannelCredential";
import { readVideoTokenReservationUpperBound } from "@/lib/productionPricing";
import {
  calculateResolvedVideoInputCost,
  resolveVideoInputPricing,
} from "@/lib/videoInputPricing";
import {
  isPublicVideoResolution,
  normalizeVideoResolution,
  type PublicVideoResolution,
} from "@/lib/videoResolutions";
import {
  listFailoverCandidateRecipes,
  planFromRecipe,
  type FulfillmentPlan,
  type VideoFulfillmentRecipe,
} from "@/lib/videoFulfillment/recipes";
import {
  isExactFanjinValueVideoRecipe,
  isFanjinValueVideoModel,
} from "@/lib/fanjinValueVideoOffers";
import { VIDEO_PUBLIC_OFFER_TABLE } from "@/lib/migrations/videoFulfillmentRecipe";
import {
  parseFanjinValueVideoPricingContract,
  resolveFanjinValueVideoPricingSnapshot,
} from "@/lib/fanjinValueVideoPricing";

type DatabaseRow = Record<string, any>;

const HIGH_RESOLUTIONS = new Set<PublicVideoResolution>(["2k", "4k"]);
const VIDEO_PRICING_UNITS = new Set(["task", "video", "token"]);

export function isHighPublicVideoResolution(value: unknown): boolean {
  const normalized = normalizeVideoResolution(value);
  return Boolean(
    normalized
    && isPublicVideoResolution(normalized)
    && HIGH_RESOLUTIONS.has(normalized),
  );
}

function inWorkspaceScope(row: DatabaseRow, workspaceId: string): boolean {
  const scope = String(row.scope || "");
  if (scope === "platform") return row.workspaceId == null;
  return scope === "workspace" && String(row.workspaceId || "") === workspaceId;
}

function isHealthy(row: DatabaseRow): boolean {
  return String(row.healthStatus || "").trim().toLowerCase() === "ok";
}

function channelRuntimeConfig(row: DatabaseRow): {
  id: string;
  credentialCiphertext: string | null;
  credentialRef: string | null;
  baseUrl: string | null;
  config: Record<string, unknown>;
} {
  return {
    id: String(row.id || ""),
    credentialCiphertext: row.credentialCiphertext ?? null,
    credentialRef: row.credentialRef ?? null,
    baseUrl: row.baseUrl ?? null,
    config: parseProviderChannelConfig(row.configJson),
  };
}

function supportsUpscaleTarget(row: DatabaseRow, target: PublicVideoResolution): boolean {
  const config = parseProviderChannelConfig(row.configJson);
  const declared = Array.isArray(config.supportedResolutions)
    ? config.supportedResolutions
    : Array.isArray(config.resolutions)
      ? config.resolutions
      : [];
  if (!declared.length) return true;
  return declared
    .map((item) => normalizeVideoResolution(item))
    .some((item) => item === target);
}

function channelReady(input: {
  row: DatabaseRow | null;
  workspaceId: string;
  endpointType: "video_generation" | "video_upscale";
  targetResolution?: PublicVideoResolution;
}): input is typeof input & { row: DatabaseRow } {
  if (isPreviewProviderDispatchDisabled()) return false;
  const row = input.row;
  if (
    !row
    || Number(row.disabled || 0) === 1
    || String(row.endpointType || "") !== input.endpointType
    || !inWorkspaceScope(row, input.workspaceId)
    || !isHealthy(row)
  ) {
    return false;
  }

  const runtime = channelRuntimeConfig(row);
  const fallbackKeys = providerCredentialFallbackEnvNames(
    row.provider,
    input.endpointType,
  );
  if (!resolveChannelApiKey(runtime, fallbackKeys)) return false;
  if (!resolveChannelBaseUrl(runtime)) return false;
  if (
    input.endpointType === "video_upscale"
    && input.targetResolution
    && !supportsUpscaleTarget(row, input.targetResolution)
  ) {
    return false;
  }
  return true;
}

function validVideoPricingRule(
  rule: PricingRule | null,
  provider: string,
): rule is PricingRule {
  if (
    !rule
    || rule.endpointType !== "video_generation"
    || rule.provider !== provider
    || rule.currency !== "GU"
    || !VIDEO_PRICING_UNITS.has(rule.unit)
    || !Number.isSafeInteger(rule.unitPriceMicros)
    || rule.unitPriceMicros <= 0
  ) {
    return false;
  }
  if (
    rule.unit === "token"
    && (
      provider !== "volcano"
      || readVideoTokenReservationUpperBound(rule.ruleConfig) == null
    )
  ) {
    return false;
  }
  const multiplier = Number(rule.ruleConfig?.multiplier ?? 1);
  const minimumMicros = Number(rule.ruleConfig?.minimumMicros ?? 0);
  return Number.isFinite(multiplier)
    && multiplier > 0
    && Number.isSafeInteger(minimumMicros)
    && minimumMicros >= 0;
}

async function runnableVideoPrice(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  publicModel: string;
  provider: string;
}): Promise<PricingRule | null> {
  if (!input.provider) return null;
  const rule = await resolveProviderSpecificPricingRule({
    endpointType: "video_generation",
    provider: input.provider,
    model: input.publicModel,
    workspaceId: input.workspaceId,
  }, input.database);
  return validVideoPricingRule(rule, input.provider) ? rule : null;
}

async function managedValueVideoPricingReady(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  publicModel: string;
  rule: PricingRule;
  targetResolution: PublicVideoResolution;
}): Promise<boolean> {
  if (!isFanjinValueVideoModel(input.publicModel)) return true;
  try {
    const contract = parseFanjinValueVideoPricingContract({
      publicModel: input.publicModel,
      ruleConfig: input.rule.ruleConfig,
      targetResolution: input.targetResolution,
    });
    if (!contract || input.rule.unit !== "token") return false;
    const selected = resolveVideoInputPricing({
      ruleConfig: input.rule.ruleConfig,
      requestPayload: {
        content: [{ type: "text", text: "readiness" }],
        duration: contract.maxDurationSeconds,
        resolution: input.targetResolution,
      },
      baseUnitPriceMicros: input.rule.unitPriceMicros,
    });
    const reservationUnits = selected.reservationUpperBoundTokens;
    if (reservationUnits == null) return false;
    const snapshot = await resolveFanjinValueVideoPricingSnapshot({
      database: input.database,
      workspaceId: input.workspaceId,
      publicModel: input.publicModel,
      ruleConfig: input.rule.ruleConfig,
      requestPayload: { duration: contract.maxDurationSeconds, resolution: input.targetResolution },
      generationReservationCostMicros: calculateResolvedVideoInputCost(
        selected,
        reservationUnits,
      ),
    });
    return snapshot !== null;
  } catch {
    return false;
  }
}

async function channelById(
  database: Knex | Knex.Transaction,
  id: string | null | undefined,
): Promise<DatabaseRow | null> {
  const normalized = String(id || "").trim();
  if (!normalized) return null;
  return await database("o_provider_channel").where({ id: normalized }).first() || null;
}

export async function isVideoFulfillmentRecipeReady(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  publicModel: string;
  targetResolution: PublicVideoResolution;
  recipe: VideoFulfillmentRecipe;
}): Promise<boolean> {
  if (
    isFanjinValueVideoModel(input.publicModel)
    && !isExactFanjinValueVideoRecipe(input.publicModel, input.recipe)
  ) {
    return false;
  }
  const generateChannel = await channelById(input.database, input.recipe.generateChannelId);
  if (
    !generateChannel
    || !channelReady({
      row: generateChannel,
      workspaceId: input.workspaceId,
      endpointType: "video_generation",
    })
  ) {
    return false;
  }
  const provider = String(generateChannel.provider || "").trim();
  const priceRule = await runnableVideoPrice({
    database: input.database,
    workspaceId: input.workspaceId,
    publicModel: input.publicModel,
    provider,
  });
  if (!priceRule || !await managedValueVideoPricingReady({
    database: input.database,
    workspaceId: input.workspaceId,
    publicModel: input.publicModel,
    rule: priceRule,
    targetResolution: input.targetResolution,
  })) {
    return false;
  }

  if (!input.recipe.enhanceEnabled) return true;
  const upscaleChannel = await findMediaService(input.database, String(input.recipe.enhanceChannelId || ""), "mediakit");
  if (upscaleChannel?.kind === "mediakit" && !mediaKitRuntimeConfig(upscaleChannel, input.targetResolution)) return false;
  return channelReady({
    row: upscaleChannel,
    workspaceId: input.workspaceId,
    endpointType: "video_upscale",
    targetResolution: input.targetResolution,
  });
}

async function enabledPublicOfferIncludesTarget(input: {
  database: Knex | Knex.Transaction;
  publicModel: string;
  targetResolution: PublicVideoResolution;
}): Promise<boolean> {
  if (!(await input.database.schema.hasTable(VIDEO_PUBLIC_OFFER_TABLE))) return false;
  const row = await input.database(VIDEO_PUBLIC_OFFER_TABLE)
    .where({ publicModel: input.publicModel, enabled: 1 })
    .first();
  if (!row) return false;
  let resolutions: unknown = row.visibleResolutions;
  if (typeof resolutions === "string") {
    try { resolutions = JSON.parse(resolutions); } catch { return false; }
  }
  return Array.isArray(resolutions)
    && resolutions.map((item) => normalizeVideoResolution(item)).includes(input.targetResolution);
}

/**
 * Resolve only a plan that can be dispatched now. Merely enabled recipe rows
 * are not public capability evidence: generation/upscale channels must be
 * healthy and credential-complete, and Relay billing must have an executable
 * provider-specific GU price for the public model.
 */
export async function resolveReadyVideoFulfillmentPlan(
  database: Knex | Knex.Transaction,
  input: {
    workspaceId: string;
    publicModel: string;
    resolution: unknown;
  },
): Promise<FulfillmentPlan | null> {
  const target = normalizeVideoResolution(input.resolution);
  if (!target || !isPublicVideoResolution(target)) return null;
  if (
    isFanjinValueVideoModel(input.publicModel)
    && !await enabledPublicOfferIncludesTarget({
      database,
      publicModel: input.publicModel,
      targetResolution: target,
    })
  ) {
    return null;
  }
  const recipes = await listFailoverCandidateRecipes(database as Knex, {
    publicModel: input.publicModel,
    targetResolution: target,
    onlyEnabled: true,
  });
  for (const recipe of recipes) {
    if (await isVideoFulfillmentRecipeReady({
      database,
      workspaceId: input.workspaceId,
      publicModel: input.publicModel,
      targetResolution: target,
      recipe,
    })) {
      return planFromRecipe(input.publicModel, recipe);
    }
  }
  return null;
}

/**
 * Native high-resolution claims require the same healthy generation channel
 * and price that Relay will enforce before dispatch. Low public tiers retain
 * their existing compatibility behavior.
 */
export async function isNativeHighResolutionReady(
  database: Knex | Knex.Transaction,
  input: {
    workspaceId: string;
    publicModel: string;
    resolution: unknown;
    generationChannel: DatabaseRow | null;
  },
): Promise<boolean> {
  const target = normalizeVideoResolution(input.resolution);
  if (!target || !isPublicVideoResolution(target) || !HIGH_RESOLUTIONS.has(target)) {
    return false;
  }
  const generationChannel = input.generationChannel;
  if (
    !generationChannel
    || !channelReady({
      row: generationChannel,
      workspaceId: input.workspaceId,
      endpointType: "video_generation",
    })
  ) {
    return false;
  }
  const provider = String(generationChannel.provider || "").trim();
  return Boolean(await runnableVideoPrice({
    database,
    workspaceId: input.workspaceId,
    publicModel: input.publicModel,
    provider,
  }));
}
