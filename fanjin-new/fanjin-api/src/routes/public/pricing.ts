import { autoDLH3OutputPrice } from "@/lib/autodlH3Pricing";
import { AUTODL_H3_CINEMA_MODEL, isAutoDLH3LocalLightWorkflow } from "@/lib/autodlH3Manifest";
import { internalModelId, isFanjinH3Model, publicH3ModelCapability } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import { db } from "@/utils/db";
import { resolveSessionFromAuthorization } from "@/lib/auth";
import { relayEndpointTypes, type RelayEndpointType } from "@/lib/relay";
import { success } from "@/lib/responseFormat";
import { resolveUserVisibleModelOffers } from "@/lib/userVisibleModelOffer";
import { endpointPresentation } from "../developer/models";
import {
  buildWorkbenchModelCatalog,
  explainManagedLogicalModelPublication,
} from "@/lib/workbenchModelCatalog";
import { parseJsonRecord } from "@/lib/modelRouteGroups";
import { readTokenPriceRate, multiplyTokenPriceRate } from "@/lib/tokenPriceRate";
import {
  DEFAULT_PRICING_GROUP,
  PRICING_AUDIENCE_EFFECTIVE_KEY,
  resolveWorkspacePricingGroup,
} from "@/lib/pricingAudience";
import {
  multiplyPricingMicros,
  readTimePricingConfig,
  resolveTimePricing,
} from "@/lib/timePricing";
import {
  isFanjinValueVideoModel,
  publicWorkbenchModelCapability,
  sanitizePublicModelDirectoryText,
} from "@/lib/fanjinValueVideoOffers";

const router = express.Router();
const PUBLIC_CATALOG_WORKSPACE_ID = "__public_model_catalog__";

async function requestPricingWorkspaceId(req: express.Request): Promise<string> {
  const authorization = String(req.headers.authorization || "").trim();
  if (!authorization) return PUBLIC_CATALOG_WORKSPACE_ID;
  try {
    const resolved = await resolveSessionFromAuthorization(db, authorization, {
      touchSession: false,
      revokeExpiredSession: false,
    });
    return String(resolved?.workspaceId || "").trim() || PUBLIC_CATALOG_WORKSPACE_ID;
  } catch {
    // This endpoint remains public. A missing, stale, or invalid optional
    // session can only fall back to the default public audience; it never
    // selects another account's pricing group.
    return PUBLIC_CATALOG_WORKSPACE_ID;
  }
}

function positiveSafeInteger(value: unknown): number {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : 0;
}

// Public, authentication-free model plaza contract. Only executable and
// billable platform offers are projected; unavailable configuration remains
// visible exclusively in FJAdmin.
router.get("/", async (req, res) => {
  try {
    const workspaceId = await requestPricingWorkspaceId(req);
    const authenticatedAudience = workspaceId !== PUBLIC_CATALOG_WORKSPACE_ID;
    const pricingGroup = authenticatedAudience
      ? await resolveWorkspacePricingGroup(db, workspaceId)
      : DEFAULT_PRICING_GROUP;
    res.vary("Authorization");
    if (authenticatedAudience) res.setHeader("Cache-Control", "private, no-store");
    const [routeRows, mediaCatalog] = await Promise.all([
      db("o_model_route")
        .where({ disabled: 0, scope: "platform" })
        .whereNull("workspaceId")
        .orderBy("priority", "asc")
        .orderBy("fallbackOrder", "asc")
        .orderBy("createTime", "asc")
        .orderBy("id", "asc"),
      buildWorkbenchModelCatalog(workspaceId),
    ]);

    const routes = Array.from(new Map(
      (routeRows as any[])
        .filter((route) => {
          const presentation = endpointPresentation(String(route.endpointType || ""));
          return presentation.category !== "internal" && presentation.category !== "unknown";
        })
        .map((route) => [`${route.endpointType}:${route.model}`, route]),
    ).values()) as any[];
    const mediaCapabilities = new Map(mediaCatalog.models.map((capability) => [
      `${capability.endpointType}:${capability.model}`,
      capability,
    ]));

    const offers = await resolveUserVisibleModelOffers({
      workspaceId,
      pricingGroup,
      models: routes.map((route) => ({
        endpointType: route.endpointType as RelayEndpointType,
        model: String(route.model || ""),
      })),
    });
    const publicationEntries = await Promise.all(routes.map(async (route) => {
      const key = `${route.endpointType}:${route.model}`;
      const readiness = await explainManagedLogicalModelPublication({
        workspaceId,
        endpointType: String(route.endpointType || ""),
        model: String(route.model || ""),
      });
      return [key, readiness] as const;
    }));
    const publications = new Map(publicationEntries);

    const pricingEvaluatedAt = Date.now();
    const models = routes.flatMap((route) => {
      const publication = publications.get(`${route.endpointType}:${route.model}`);
      if (publication?.managed && !publication.ready) return [];
      const offer = offers.get(`${route.endpointType}:${route.model}`);
      if (!offer) return [];
      const mediaCapability = mediaCapabilities.get(`${route.endpointType}:${route.model}`);
      if (
        ["image_generation", "video_generation"].includes(String(route.endpointType || ""))
        && (!mediaCapability || mediaCapability.canSubmit !== true)
      ) return [];
      const publicMediaCapability = mediaCapability
        ? publicWorkbenchModelCapability(mediaCapability)
        : null;
      const publicRoute = publicWorkbenchModelCapability({
        model: String(route.model || ""),
        name: String(route.displayName || route.name || route.model || ""),
        displayName: String(route.displayName || route.name || route.model || ""),
        description: parseJsonRecord(route.routeConfig).description == null
          ? null
          : String(parseJsonRecord(route.routeConfig).description),
        routeName: route.name == null ? null : String(route.name),
        enhanceDisplayName: parseJsonRecord(route.routeConfig).enhanceDisplayName,
        duration: mediaCapability?.duration,
        resolutionDeliveries: mediaCapability?.resolutionDeliveries || [],
      });
      const pricing = offer.pricingRule;
      const presentation = endpointPresentation(route.endpointType);
      const ruleConfig = pricing.ruleConfig || {};
      let h3SecondPrice: number | null = null;
      if (isFanjinH3Model(route.model)) {
        if (pricing.unit !== "video" || pricing.currency !== "GU") return [];
        try {
          // The stored video amount is a duration sample. Publish the same
          // 768p output-second rate used by reservation and settlement.
          h3SecondPrice = autoDLH3OutputPrice(ruleConfig.autodlH3Pricing, { model: internalModelId(route.model), resolution: "768p", duration: 1 }, pricingEvaluatedAt);
        } catch {
          return []; // Never advertise a flat-video fallback for a bad contract.
        }
      }
      const multimodalEmbedding = route.endpointType === "multimodal_embedding";
      const configuredInput = readTokenPriceRate(multimodalEmbedding ? ruleConfig.textTokenPriceMicros : ruleConfig.inputPriceMicros);
      const configuredMediaInput = multimodalEmbedding
        ? readTokenPriceRate(ruleConfig.mediaTokenPriceMicros) ?? readTokenPriceRate(ruleConfig.imageTokenPriceMicros)
        : null;
      const configuredOutput = readTokenPriceRate(ruleConfig.outputPriceMicros);
      const fallbackUnitPrice = h3SecondPrice ?? (positiveSafeInteger(pricing.unitPriceMicros)
        || configuredInput || configuredOutput);
      if (!fallbackUnitPrice) return [];
      const audienceUnitPriceMicros = pricing.unit === "token" && !multimodalEmbedding
        ? configuredInput ?? fallbackUnitPrice
        : fallbackUnitPrice;
      const effectiveAudience = parseJsonRecord(ruleConfig[PRICING_AUDIENCE_EFFECTIVE_KEY]);
      const discountBpsCandidate = Number(effectiveAudience.discountBps);
      const discountBps = h3SecondPrice === null && Number.isSafeInteger(discountBpsCandidate)
        && discountBpsCandidate >= 1
        && discountBpsCandidate <= 10_000
        ? discountBpsCandidate
        : 10_000;
      const baseUnitPriceMicros = h3SecondPrice ?? ((pricing.unit === "token"
        ? readTokenPriceRate(effectiveAudience.baseInputPriceMicros)
        : null) ?? (positiveSafeInteger(effectiveAudience.baseUnitPriceMicros)
        || audienceUnitPriceMicros));

      const audienceInputPriceMicros = pricing.unit === "token"
        ? (multimodalEmbedding ? configuredInput : configuredInput ?? audienceUnitPriceMicros)
        : null;
      const audienceOutputPriceMicros = pricing.unit === "token" && !multimodalEmbedding
        ? configuredOutput ?? audienceUnitPriceMicros
        : null;
      const timePricing = resolveTimePricing(ruleConfig, pricingEvaluatedAt);
      const configuredTimePricing = readTimePricingConfig(ruleConfig);
      const unitPriceMicros = pricing.unit === "token"
        ? multiplyTokenPriceRate(audienceUnitPriceMicros, timePricing.multiplier)
        : multiplyPricingMicros(audienceUnitPriceMicros, timePricing.multiplier, "unitPriceMicros");
      const inputPriceMicros = audienceInputPriceMicros == null
        ? null
        : multiplyTokenPriceRate(audienceInputPriceMicros, timePricing.multiplier);
      const outputPriceMicros = audienceOutputPriceMicros == null
        ? null
        : multiplyTokenPriceRate(audienceOutputPriceMicros, timePricing.multiplier);
      const capabilities: string[] = [];
      if (route.endpointType === "text") capabilities.push("streaming");
      if (presentation.modalities.includes("image_url")) capabilities.push("vision");
      if (ruleConfig.functionCalling) capabilities.push("function_calling");
      if (ruleConfig.structuredOutput) capabilities.push("structured_output");
      const managedValueOffer = isFanjinValueVideoModel(route.model);
      // `buildWorkbenchModelCatalog` is the single admission source for both
      // public capability discovery and the submit path.  A stale
      // publicationTarget must not narrow only this price surface, otherwise
      // a model can be selectable/submittable while its certified tier has no
      // public price (or vice versa).
      const resolutions = publicMediaCapability?.resolutions || [];
      const defaultResolutionCandidate = String(
        publicMediaCapability?.defaultResolution
        || "",
      ).trim();
      const defaultResolution = resolutions.includes(defaultResolutionCandidate)
        ? defaultResolutionCandidate
        : resolutions[0] || null;
      const qualities = publicMediaCapability?.qualities || [];
      const defaultQualityCandidate = String(
        publicMediaCapability?.defaultQuality
        || "",
      ).trim();
      const defaultQuality = qualities.includes(defaultQualityCandidate)
        ? defaultQualityCandidate
        : qualities[0] || null;
      for (const capability of [defaultResolution, ...resolutions, defaultQuality, ...qualities]) {
        if (capability && !capabilities.includes(capability)) capabilities.push(capability);
      }

      return [publicH3ModelCapability({
        // Managed offers are public products. Their backing route and
        // provider are fulfillment implementation details and must not become
        // stable public identifiers in the model plaza response.
        id: managedValueOffer ? String(route.model) : String(route.id),
        model_name: String(route.model),
        name: String(publicRoute.displayName || publicRoute.name || route.model),
        description: publicRoute.description || null,
        vendor_id: null,
        vendor_name: managedValueOffer ? "Fanjin" : offer.provider,
        vendor_icon: managedValueOffer ? "fanjin" : offer.provider.toLowerCase(),
        category: presentation.category,
        endpoint_type: route.endpointType,
        api_style: managedValueOffer
          ? "Fanjin media generation API"
          : presentation.apiStyle,
        modalities: presentation.modalities,
        output: presentation.output,
        status: "active" as const,
        quota_type: pricing.unit === "token" ? 0 : 1,
        unit: h3SecondPrice === null ? pricing.unit : internalModelId(route.model) !== AUTODL_H3_CINEMA_MODEL && isAutoDLH3LocalLightWorkflow() ? "video" : "second",
        currency: pricing.currency,
        unit_price_micros: unitPriceMicros,
        base_unit_price_micros: audienceUnitPriceMicros,
        list_unit_price_micros: baseUnitPriceMicros,
        pricing_group: pricingGroup,
        discount_bps: discountBps,
        pricing_configured: true,
        input_price_micros: inputPriceMicros,
        output_price_micros: outputPriceMicros,
        ...(multimodalEmbedding ? {
          text_input_price_micros: inputPriceMicros,
          media_input_price_micros: configuredMediaInput == null ? null : multiplyTokenPriceRate(configuredMediaInput, timePricing.multiplier),
        } : {}),
        base_input_price_micros: audienceInputPriceMicros,
        base_output_price_micros: audienceOutputPriceMicros,
        time_pricing: configuredTimePricing?.enabled ? {
          enabled: true,
          timezone: timePricing.timezone,
          evaluated_at: timePricing.evaluatedAt,
          multiplier_bps: timePricing.multiplierBps,
          multiplier: timePricing.multiplier,
          current_period_id: timePricing.periodId,
          current_period_name: timePricing.periodName,
          periods: configuredTimePricing.periods,
        } : null,
        model_ratio: inputPriceMicros !== null ? inputPriceMicros / 1_000_000 : 0,
        completion_ratio: outputPriceMicros !== null ? outputPriceMicros / 1_000_000 : 0,
        capabilities,
        resolutions,
        default_resolution: defaultResolution,
        qualities,
        default_quality: defaultQuality,
        context_length: Number(ruleConfig.contextLength) || null,
        max_output_tokens: Number(ruleConfig.maxOutputTokens) || null,
        tags: managedValueOffer
          ? ""
          : sanitizePublicModelDirectoryText(String(route.tags || "")),
        enable_groups: [pricingGroup],
        supported_endpoint_types: [route.endpointType],
      })];
    });

    const vendorNames = Array.from(new Set(models.map((model) => model.vendor_name)));
    const vendors = vendorNames.map((name, index) => ({
      id: index + 1,
      name,
      icon: name.toLowerCase(),
      description: null,
    }));
    const visibleEndpointTypes = new Set(models.map((model) => model.endpoint_type));
    const supportedEndpoint: Record<string, string> = {};
    for (const type of relayEndpointTypes) {
      if (visibleEndpointTypes.has(type)) supportedEndpoint[type] = type;
    }

    return res.status(200).send(success({
      data: models,
      vendors,
      group_ratio: { [pricingGroup]: 1 },
      usable_group: { [pricingGroup]: { desc: pricingGroup, ratio: 1 } },
      supported_endpoint: supportedEndpoint,
      auto_groups: [pricingGroup],
    }));
  } catch (error) {
    console.error("Pricing API error:", error);
    return res.status(500).send({
      success: false,
      message: "Failed to fetch pricing data",
    });
  }
});

export default router;
