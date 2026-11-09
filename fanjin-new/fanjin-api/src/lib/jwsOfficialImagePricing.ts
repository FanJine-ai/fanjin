/** Retail prices are independent of the JWS account's purchase/quote currency. */
export const JWS_DOMESTIC_IMAGE_PRICES = {
  "Seedream 5.0 Pro": { officialCny: 0.6, lowPixelCny: 0.3, additionalReferenceCny: 0.02 },
  "Wan 2.7 Image": { officialCny: 0.2 },
  "Wan 2.7 Image Pro": { officialCny: 0.5 },
} as const;

export type JwsOfficialImagePolicy = {
  version: "jws-official-image-price.v1";
  model: keyof typeof JWS_DOMESTIC_IMAGE_PRICES;
  factor: 0.45;
  guPerCny: 10;
  verifiedAt: "2026-09-16";
};

export function jwsOfficialImagePolicy(config: Record<string, unknown>): JwsOfficialImagePolicy | null {
  if (config.jwsOfficialPricing === undefined) return null;
  const policy = config.jwsOfficialPricing as JwsOfficialImagePolicy;
  if (!policy || policy.version !== "jws-official-image-price.v1"
    || !Object.hasOwn(JWS_DOMESTIC_IMAGE_PRICES, policy.model)
    || policy.factor !== 0.45 || policy.guPerCny !== 10 || policy.verifiedAt !== "2026-09-16"
    || config.jwsUpstreamPricing !== undefined) throw Error("JWS_OFFICIAL_IMAGE_POLICY_INVALID");
  const reference = config.referenceImagePricing as Record<string, unknown> | undefined;
  if (policy.model === "Seedream 5.0 Pro") {
    if (!reference || reference.firstIncluded !== 1 || reference.additionalUnitPriceMicros !== 9_000_000 || reference.maximumReferenceImages !== 10) throw Error("JWS_OFFICIAL_REFERENCE_PRICING_INVALID");
  } else if (reference !== undefined) throw Error("JWS_OFFICIAL_REFERENCE_PRICING_INVALID");
  return policy;
}

export function jwsOfficialImageCost(policy: JwsOfficialImagePolicy, input: {
  size?: unknown; count: number; referenceCount: number;
}): { unitPriceMicros: number; referenceCostMicros: number; costMicros: number } {
  if (!Number.isSafeInteger(input.count) || input.count < 0
    || !Number.isSafeInteger(input.referenceCount) || input.referenceCount < 0) throw Error("JWS_IMAGE_QUANTITY_INVALID");
  let officialCny: number = JWS_DOMESTIC_IMAGE_PRICES[policy.model].officialCny;
  let referenceCostMicros = 0;
  if (policy.model === "Seedream 5.0 Pro") {
    // An unknown/auto size reserves the upper tier; never silently assume 1K.
    const match = /^(\d+)x(\d+)$/.exec(String(input.size || ""));
    if (match) {
      const pixels = Number(match[1]) * Number(match[2]);
      if (!Number.isSafeInteger(pixels) || pixels <= 0) throw Error("JWS_IMAGE_SIZE_INVALID");
      if (pixels <= 2_610_000) officialCny = 0.3;
    }
    referenceCostMicros = Math.round(Math.max(0, input.referenceCount - 1) * 0.02 * 0.45 * 1e9);
  }
  const unitPriceMicros = Math.round(officialCny * 0.45 * 1e9);
  const costMicros = input.count === 0 ? 0 : unitPriceMicros * input.count + referenceCostMicros;
  if (!Number.isSafeInteger(costMicros)) throw Error("JWS_IMAGE_AMOUNT_OVERFLOW");
  return { unitPriceMicros, referenceCostMicros, costMicros };
}
