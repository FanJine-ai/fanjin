import { PROCUREMENT_DISCOUNT_BPS } from "./commercialPricingPolicy";
/**
 * Official Volcano Ark provider-cost reference. These CNY values are for
 * operator margin review only; customer GU debit remains defined exclusively
 * by o_pricing_rule.unitPriceMicros/pricingExpr.
 */
export const VOLCENGINE_PROVIDER_COST_SOURCE = {
  document: "火山方舟_文档指南_1786643963.pdf",
  reviewedAt: "2026-08-14",
  currency: "CNY",
  pricingLayer: "provider_cost_reference",
} as const;

const SEED_20_PRO_COST = {
  billingUnit: "million_tokens",
  nonAudioTokenTiers: [
    { contextTokens: { minExclusive: -1, maxInclusive: 32_000 }, inputCny: 3.2, outputCny: 16, cacheHitCny: 0.64 },
    { contextTokens: { minExclusive: 32_000, maxInclusive: 128_000 }, inputCny: 4.8, outputCny: 24, cacheHitCny: 0.96 },
    { contextTokens: { minExclusive: 128_000, maxInclusive: 256_000 }, inputCny: 9.6, outputCny: 48, cacheHitCny: 1.92 },
  ],
  cacheStorageCnyPerMillionTokensHour: 0.017,
  sourceDocumentPage: 65,
} as const;

const SEEDREAM_50_LITE_COST = {
  billingUnit: "image",
  inputImageCny: 0,
  outputImageCny: 0.22,
  sourceDocumentPages: [77, 78, 79, 80, 81, 82, 83],
} as const;

const SEEDANCE_20_FAST_COST = {
  billingUnit: "million_tokens",
  inputWithoutVideoCny: 37,
  inputWithVideoCny: 22,
  promotionalMultiplier: 0.75,
  promotionEndsAt: "2026-09-07T14:00:00+08:00",
  examples: {
    fiveSeconds480pWithoutInputVideoCny: 1.86,
    fiveSeconds720pWithoutInputVideoCny: 4,
  },
  sourceDocumentPages: [77, 78, 79, 80, 81, 82, 83],
} as const;

export function volcengineProviderCostReferenceForModel(model: string): Record<string, unknown> | null {
  const normalized = String(model || "").trim();
  let price: Record<string, unknown> | null = null;
  if (normalized === "doubao-seed-2-0-pro-260215") price = SEED_20_PRO_COST;
  if (["doubao-seedream-5-0-260128", "doubao-seedream-5-0-lite-260128"].includes(normalized)) {
    price = SEEDREAM_50_LITE_COST;
  }
  if (normalized === "doubao-seedance-2-0-fast-260128") price = SEEDANCE_20_FAST_COST;
  return price ? { ...VOLCENGINE_PROVIDER_COST_SOURCE, ...price } : null;
}

/**
 * R7 估算供应商成本（CNY micros）：
 * - 图片模型（Seedream，按张计费）：units × 每张官方参考价。
 * - 文本模型：必须提供 input/output/cache 的可信拆分，按上下文档位计算。
 * - 视频模型：可信 completion token 可直接计价，并按是否含视频输入选择档位。
 * - 计量证据不足时返回 null，由调用方通过 metadata.providerCostMicros 显式提供。
 * 绝不用零售 GU 价格冒充供应商成本。
 */
export function estimateVolcengineProviderCostMicros(input: {
  model: string;
  units: number;
  unit: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  videoInputPricingTier?: "with_video_input" | "without_video_input" | null;
  pricedAt?: number | string | Date | null;
  resolution?: string | null;
  referenceImageCount?: number | null;
  textTokens?: number | null;
  mediaTokens?: number | null;
}): { estimatedCostMicros: number; providerPriceRevision: string } | null {
  const current = currentProviderCost(input);
  if (current) return current;
  const pricedAt = input.pricedAt == null ? Date.now() : new Date(input.pricedAt).getTime();
  // Missing current metering evidence must not silently select the old price table.
  if (pricedAt >= Date.parse("2026-09-09T00:00:00+08:00") && (
    CURRENT_TEXT_LIST[input.model] || CURRENT_VIDEO_LIST[input.model]
    || input.model === "doubao-seed-character-260628"
    || /^doubao-(seedream|embedding-vision)-/.test(input.model)
  )) return null;
  const reference = volcengineProviderCostReferenceForModel(input.model);
  if (!reference) return null;
  const units = Math.floor(Number(input.units || 0));
  if (units <= 0) return null;
  const billingUnit = String(reference.billingUnit || "");
  const unit = String(input.unit || "").trim().toLowerCase();
  if (billingUnit === "image" && ["image", "images", "task"].includes(unit)) {
    const perUnitCny = Number(reference.outputImageCny || 0);
    if (!(perUnitCny > 0)) return null;
    return {
      estimatedCostMicros: Math.round(perUnitCny * 1_000_000 * units),
      providerPriceRevision: String(VOLCENGINE_PROVIDER_COST_SOURCE.reviewedAt),
    };
  }
  if (input.model === "doubao-seed-2-0-pro-260215" && unit === "token") {
    const inputTokens = Math.floor(Number(input.inputTokens));
    const outputTokens = Math.floor(Number(input.outputTokens));
    const cachedTokens = Math.floor(Number(input.cachedTokens || 0));
    if (
      !Number.isSafeInteger(inputTokens)
      || !Number.isSafeInteger(outputTokens)
      || !Number.isSafeInteger(cachedTokens)
      || inputTokens < 0
      || outputTokens < 0
      || cachedTokens < 0
      || cachedTokens > inputTokens
      || inputTokens + outputTokens <= 0
    ) return null;
    const tier = SEED_20_PRO_COST.nonAudioTokenTiers.find((candidate) => (
      inputTokens > candidate.contextTokens.minExclusive
      && inputTokens <= candidate.contextTokens.maxInclusive
    ));
    if (!tier) return null;
    const nonCachedTokens = inputTokens - cachedTokens;
    const estimatedCostMicros = Math.round(
      nonCachedTokens * tier.inputCny
      + cachedTokens * tier.cacheHitCny
      + outputTokens * tier.outputCny,
    );
    if (estimatedCostMicros <= 0) return null;
    return {
      estimatedCostMicros,
      providerPriceRevision: String(VOLCENGINE_PROVIDER_COST_SOURCE.reviewedAt),
    };
  }
  if (input.model === "doubao-seedance-2-0-fast-260128" && unit === "token") {
    const tokenCount = Math.floor(Number(input.outputTokens ?? input.units));
    if (!Number.isSafeInteger(tokenCount) || tokenCount <= 0) return null;
    const hasVideoInput = input.videoInputPricingTier === "with_video_input";
    const baseCnyPerMillion = hasVideoInput
      ? SEEDANCE_20_FAST_COST.inputWithVideoCny
      : SEEDANCE_20_FAST_COST.inputWithoutVideoCny;
    const pricedAt = input.pricedAt == null ? Date.now() : new Date(input.pricedAt).getTime();
    if (!Number.isFinite(pricedAt)) return null;
    const promotionEndsAt = new Date(SEEDANCE_20_FAST_COST.promotionEndsAt).getTime();
    const multiplier = pricedAt <= promotionEndsAt
      ? SEEDANCE_20_FAST_COST.promotionalMultiplier
      : 1;
    return {
      estimatedCostMicros: Math.round(tokenCount * baseCnyPerMillion * multiplier),
      providerPriceRevision: String(VOLCENGINE_PROVIDER_COST_SOURCE.reviewedAt),
    };
  }
  return null;
}


const CURRENT_TEXT_LIST: Record<string, [number, number, number]> = {
  "agent-main": [6, 1.2, 30],
  "doubao-seed-2-1-pro-260628": [6, 1.2, 30],
  "doubao-seed-2-1-turbo-260628": [3, 0.6, 15],
  "doubao-seed-evolving": [6, 1.2, 30],
  "glm-5-2-260617": [8, 2, 28],
  "deepseek-v4-flash-260425": [3, 0.1, 9],
  "deepseek-v4-flash-ga-260731": [3, 0.1, 9],
  "deepseek-v4-pro-260425": [9, 0.3, 27],
};
const CURRENT_VIDEO_LIST: Record<string, [number, number]> = {
  "doubao-seedance-2-0-260128": [46, 28],
  "doubao-seedance-2-0-fast-260128": [37, 22],
  "doubao-seedance-2-0-mini-260615": [23, 14],
  "doubao-seedance-2-5-260628": [70, 42],
};

/** Contract estimate, not an invoice. The 85% discount never stacks with a public promotion. */
function currentProviderCost(input: Parameters<typeof estimateVolcengineProviderCostMicros>[0]): ReturnType<typeof estimateVolcengineProviderCostMicros> {
  const at = input.pricedAt == null ? Date.now() : new Date(input.pricedAt).getTime();
  if (!Number.isFinite(at) || at < Date.parse("2026-09-09T00:00:00+08:00")) return null;
  if (!Number.isSafeInteger(input.units) || input.units <= 0) return null;
  let listCnyMicros: number | null = null;
  if (input.unit === "image") {
    const imagePrice: Record<string, number> = { "doubao-seedream-4-5-251128": .25, "doubao-seedream-5-0-260128": .22 };
    if (imagePrice[input.model]) listCnyMicros = input.units * imagePrice[input.model] * 1_000_000;
    if (input.model === "doubao-seedream-5-0-pro-260628" && Number.isSafeInteger(input.referenceImageCount) && Number(input.referenceImageCount) >= 0) {
      listCnyMicros = input.units * 600_000 + Math.max(0, Number(input.referenceImageCount) - 1) * 20_000;
    }
  }
  if (input.unit === "token" && CURRENT_VIDEO_LIST[input.model] && input.videoInputPricingTier) {
    const resolution = String(input.resolution || "").toLowerCase();
    const resolutionPrices: Record<string, Record<string, [number, number]>> = {
      "doubao-seedance-2-0-260128": { "480p": [46, 28], "720p": [46, 28], "1080p": [51, 31], "4k": [26, 16] },
      "doubao-seedance-2-5-260628": { "480p": [70, 42], "720p": [70, 42], "1080p": [77, 46] },
    };
    // A changed resolution must not retain a cheaper estimate. Unknown evidence
    // remains unavailable instead of assuming the default tier.
    const tiers = resolutionPrices[input.model];
    const prices = tiers ? tiers[resolution] : CURRENT_VIDEO_LIST[input.model];
    if (prices) listCnyMicros = input.units * prices[input.videoInputPricingTier === "with_video_input" ? 1 : 0];
  }

  const prompt = Number(input.inputTokens), output = Number(input.outputTokens), cache = Number(input.cachedTokens ?? 0);
  let textPrices = CURRENT_TEXT_LIST[input.model];
  if (input.model === "doubao-seed-character-260628" && prompt <= 128000) textPrices = prompt <= 32000 ? [.8,.16,2] : [1.2,.16,6];
  if (input.unit === "token" && textPrices && [prompt,output,cache].every(Number.isSafeInteger) && prompt >= cache && output >= 0 && cache >= 0) {
    listCnyMicros = (prompt-cache)*textPrices[0] + cache*textPrices[1] + output*textPrices[2];
  }
  if (input.unit === "token" && /^doubao-embedding-vision-(250615|251215)$/.test(input.model)) {
    const text=Number(input.textTokens), media=Number(input.mediaTokens);
    if ([text,media].every(Number.isSafeInteger) && text>=0 && media>=0 && text+media===input.units) listCnyMicros=text*.7+media*1.8;
  }
  if (listCnyMicros == null || !Number.isFinite(listCnyMicros) || listCnyMicros <= 0) return null;
  return { estimatedCostMicros: Math.ceil(listCnyMicros * PROCUREMENT_DISCOUNT_BPS / 10_000), providerPriceRevision: "2026-09-09-contract85" };
}
