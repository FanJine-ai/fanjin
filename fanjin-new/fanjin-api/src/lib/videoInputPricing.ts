import { ceilGuChargeMicros } from "./billingUnits";
import { AUTODL_H3_CINEMA_PRICING_VERSION, autoDLH3OutputPrice } from "@/lib/autodlH3Pricing";

export type VideoInputPricingTier = "with_video_input" | "without_video_input";

export interface ResolvedVideoInputPricing {
  tier: VideoInputPricingTier;
  configured: boolean;
  unitPriceMicros: number;
  multiplier: number;
  minimumMicros: number;
  reservationUpperBoundTokens: number | null;
}

export class VideoInputPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoInputPricingError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new VideoInputPricingError(`${label} 必须是正安全整数`);
  }
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VideoInputPricingError(`${label} 必须是非负安全整数`);
  }
  return parsed;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new VideoInputPricingError(`${label} 必须是正数`);
  }
  return parsed;
}

export function videoInputPricingTierForRequestPayload(
  requestPayload: unknown,
): VideoInputPricingTier {
  const payload = record(requestPayload);
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content.some((item) => record(item)?.type === "video_url")
    ? "with_video_input"
    : "without_video_input";
}

/**
 * Selects one immutable video price from a single provider/model rule. The
 * contract intentionally keeps both tiers in the same rule so workspace/model
 * precedence remains unambiguous and certification hashes both prices at once.
 * Legacy one-price rules remain readable until operators migrate them.
 */
function resolveInputTier(input: {
  ruleConfig: unknown;
  requestPayload: unknown;
  baseUnitPriceMicros: unknown;
}): ResolvedVideoInputPricing {
  const config = record(input.ruleConfig) ?? {};
  const tier = videoInputPricingTierForRequestPayload(input.requestPayload);
  const baseUnitPriceMicros = positiveSafeInteger(
    input.baseUnitPriceMicros,
    "unitPriceMicros",
  );
  const baseMultiplier = positiveNumber(config.multiplier ?? 1, "multiplier");
  const baseMinimum = nonNegativeSafeInteger(config.minimumMicros ?? 0, "minimumMicros");
  const baseReservation = config.reservationUpperBoundTokens == null
    ? null
    : positiveSafeInteger(config.reservationUpperBoundTokens, "reservationUpperBoundTokens");

  if (config.videoInputPricing === undefined) {
    return {
      tier,
      configured: false,
      unitPriceMicros: baseUnitPriceMicros,
      multiplier: baseMultiplier,
      minimumMicros: baseMinimum,
      reservationUpperBoundTokens: baseReservation,
    };
  }

  // resolveVideoInputPricing already selected and flattened one resolution.
  // Re-reading the outer map here would mistake the whole resolution entry
  // for an input-tier contract and bypass dormant-tier validation.
  const contract = record(config.videoInputPricing);
  if (!contract) throw new VideoInputPricingError("videoInputPricing 必须是对象");
  const unknownContractKeys = Object.keys(contract)
    .filter((key) => key !== "withVideoInput" && key !== "withoutVideoInput");
  if (unknownContractKeys.length > 0) {
    throw new VideoInputPricingError(`videoInputPricing 含未知字段: ${unknownContractKeys.sort().join(", ")}`);
  }
  const withVideoInput = record(contract.withVideoInput);
  const withoutVideoInput = record(contract.withoutVideoInput);
  if (!withVideoInput || !withoutVideoInput) {
    throw new VideoInputPricingError("videoInputPricing 必须同时配置 withVideoInput 与 withoutVideoInput");
  }
  const validateTier = (
    selected: Record<string, unknown>,
    label: "with_video_input" | "without_video_input",
  ): Omit<ResolvedVideoInputPricing, "tier" | "configured"> => {
    const unknownTierKeys = Object.keys(selected).filter((key) => ![
      "unitPriceMicros",
      "multiplier",
      "minimumMicros",
      "reservationUpperBoundTokens",
    ].includes(key));
    if (unknownTierKeys.length > 0) {
      throw new VideoInputPricingError(`${label} 含未知字段: ${unknownTierKeys.sort().join(", ")}`);
    }
    return {
      unitPriceMicros: positiveSafeInteger(selected.unitPriceMicros, `${label}.unitPriceMicros`),
      multiplier: positiveNumber(selected.multiplier ?? baseMultiplier, `${label}.multiplier`),
      minimumMicros: nonNegativeSafeInteger(selected.minimumMicros ?? baseMinimum, `${label}.minimumMicros`),
      reservationUpperBoundTokens: selected.reservationUpperBoundTokens == null
        ? baseReservation
        : positiveSafeInteger(
            selected.reservationUpperBoundTokens,
            `${label}.reservationUpperBoundTokens`,
          ),
    };
  };
  // Validate both tiers before selecting one. A malformed dormant tier must
  // not remain hidden until a user happens to send that input shape.
  const validatedWithVideo = validateTier(withVideoInput, "with_video_input");
  const validatedWithoutVideo = validateTier(withoutVideoInput, "without_video_input");
  const selected = tier === "with_video_input"
    ? validatedWithVideo
    : validatedWithoutVideo;

  return {
    tier,
    configured: true,
    ...selected,
  };
}

function resolutionPriceTiers(config: Record<string, unknown>): Record<string, Record<string, unknown>> | null {
  if (config.videoResolutionPricing === undefined) return null;
  const raw = record(config.videoResolutionPricing);
  if (!raw || Object.keys(raw).length === 0) {
    throw new VideoInputPricingError("videoResolutionPricing 必须配置分辨率价格");
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [resolution, value] of Object.entries(raw)) {
    const entry = record(value);
    if (!["480p", "720p", "768p", "1080p", "2k", "4k"].includes(resolution) || !entry
      || Object.keys(entry).some(key => !["unitPriceMicros", "videoInputPricing", "reservationUpperBoundTokens"].includes(key))) {
      throw new VideoInputPricingError(`无效的分辨率定价: ${resolution}`);
    }
    positiveSafeInteger(entry.unitPriceMicros, `${resolution}.unitPriceMicros`);
    if (!record(entry.videoInputPricing)) {
      throw new VideoInputPricingError(`${resolution} 必须同时配置有视频和无视频输入价格`);
    }
    result[resolution] = entry;
  }
  return result;
}

/** Select the output resolution first, then the actual video-input tier. */
export function resolveVideoInputPricing(input: {
  evaluatedAt?: number;
  ruleConfig: unknown;
  requestPayload: unknown;
  baseUnitPriceMicros: unknown;
}): ResolvedVideoInputPricing {
  const config = record(input.ruleConfig) ?? {};
  if (config.autodlH3Pricing !== undefined) {
    if (config.videoInputPricing !== undefined || config.videoResolutionPricing !== undefined || config.reservationUpperBoundTokens !== undefined) {
      throw new VideoInputPricingError("AutoDL H3 按输出秒计价，不能混用 token 或其他视频定价");
    }
    return { ...resolveInputTier(input), configured: true, unitPriceMicros: autoDLH3OutputPrice(config.autodlH3Pricing, record(input.requestPayload), input.evaluatedAt) };
  }
  const tiers = resolutionPriceTiers(config);
  if (!tiers) return resolveInputTier(input);
  const payload = record(input.requestPayload);
  const resolution = String(payload?.resolution ?? config.defaultResolution ?? "720p").trim().toLowerCase();
  // Validate every dormant price too; a bad 4K tier must not pass validation
  // simply because the current request uses 720p.
  const prices = Object.fromEntries(Object.entries(tiers).map(([key, entry]) => [key, resolveInputTier({
    ruleConfig: { ...config, ...entry },
    baseUnitPriceMicros: entry.unitPriceMicros,
    requestPayload: input.requestPayload,
  })]));
  if (!prices[resolution]) throw new VideoInputPricingError(`当前模型未配置 ${resolution} 定价`);
  return prices[resolution];
}

export function calculateResolvedVideoInputCost(
  pricing: Pick<ResolvedVideoInputPricing, "unitPriceMicros" | "multiplier" | "minimumMicros">,
  units: number,
): number {
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new VideoInputPricingError("视频计费 units 必须是正安全整数");
  }
  const base = pricing.unitPriceMicros * units;
  const adjusted = Math.round(base * pricing.multiplier);
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(adjusted) || adjusted < 0) {
    throw new VideoInputPricingError("视频输入分档价格超出安全整数范围");
  }
  return Math.max(adjusted, pricing.minimumMicros);
}

/**
 * Computes the fail-safe exposure used before the request shape is known.
 * Token-priced rules use each tier's own reservation ceiling; task/video rules
 * use the supplied request units. This prevents a cheaper base price from
 * under-reserving a more expensive video-input tier.
 */
export function calculateMaximumVideoInputCost(input: {
  ruleConfig: unknown;
  baseUnitPriceMicros: unknown;
  units: number;
  timePricingMultiplier?: number;
}): number {
  if (!Number.isSafeInteger(input.units) || input.units <= 0) {
    throw new VideoInputPricingError("视频计费 units 必须是正安全整数");
  }
  const timePricingMultiplier = input.timePricingMultiplier ?? 1;
  if (!Number.isFinite(timePricingMultiplier) || timePricingMultiplier <= 0) {
    throw new VideoInputPricingError("视频分时定价倍率必须是正数");
  }
  const config = record(input.ruleConfig) ?? {};
  if (config.autodlH3Pricing !== undefined) {
    const cinema = record(config.autodlH3Pricing)?.version === AUTODL_H3_CINEMA_PRICING_VERSION;
    // Unknown request shape must reserve the most expensive resolution/period.
    const pricing = resolveVideoInputPricing({ ...input,
      evaluatedAt: Date.parse("2026-10-28T08:00:00+08:00"),
      requestPayload: { duration: 15, resolution: cinema ? "960p" : "768p" },
    });
    return ceilGuChargeMicros(calculateResolvedVideoInputCost({ ...pricing, multiplier: pricing.multiplier * timePricingMultiplier }, input.units));
  }
  const resolutions = Object.keys(resolutionPriceTiers(config) ?? {});
  const pricingForTier = (tier: VideoInputPricingTier, resolution?: string): ResolvedVideoInputPricing => {
    const pricing = resolveVideoInputPricing({
      ruleConfig: input.ruleConfig,
      baseUnitPriceMicros: input.baseUnitPriceMicros,
      requestPayload: { resolution, content: tier === "with_video_input"
        ? [{ type: "video_url" }]
        : [{ type: "text", text: "pricing" }] },
    });
    return {
      ...pricing,
      // Relay freezes the active time-pricing snapshot before precharge and
      // multiplies it with the selected input-tier multiplier. Maximum-budget
      // callers must use the identical composition or peak periods can be
      // under-reserved and discounted periods can drift during consent.
      multiplier: pricing.multiplier * timePricingMultiplier,
    };
  };
  return ceilGuChargeMicros(Math.max(...(resolutions.length ? resolutions : [undefined]).flatMap(resolution => (
    (["with_video_input", "without_video_input"] as const).map(tier => {
      const pricing = pricingForTier(tier, resolution);
      return calculateResolvedVideoInputCost(pricing, pricing.reservationUpperBoundTokens ?? input.units);
    })
  ))));
}
