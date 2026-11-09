export interface OpenAITextTokenUsage {
  /** OpenAI semantics: promptTokens includes cachedTokens. */
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  /** Reserved for providers that report cache writes separately. */
  cacheWriteTokens?: number;
}

/**
 * @deprecated 旧文本定价参数。新规则应使用 ruleConfig.pricingExpr 表达式代替。
 * 例如 `cr*200 + (p-cr)*2000 + c*6000` 等价于以下字段组合。
 * 保留此接口用于向后兼容未迁移的旧规则。
 */
export interface TextTokenPricing {
  /** @deprecated 改用 pricingExpr 中的 p 系数 */
  inputPriceMicros: number;
  /** @deprecated 改用 pricingExpr 中的 c 系数 */
  outputPriceMicros: number;
  /** @deprecated 改用 pricingExpr 中的 cr 系数 */
  cacheReadPriceMicros: number;
  /** @deprecated 改用 pricingExpr 中的 cc 系数 */
  cacheWritePriceMicros?: number;
  /** @deprecated 改用 groupRatio 或表达式内乘法 */
  multiplier?: number;
  /** @deprecated 改用 max(expr, N) */
  minimumMicros?: number;
}

export interface TextTokenPricingResult {
  promptTokens: number;
  nonCachedInputTokens: number;
  cachedTokens: number;
  completionTokens: number;
  cacheWriteTokens: number;
  rawCostMicros: number;
  multipliedCostMicros: number;
  costMicros: number;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegativeFiniteNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`);
  }
  return value;
}

function safeRawCost(parts: ReadonlyArray<readonly [number, number]>): number {
  const rawCost = parts.reduce(
    (total, [units, unitPrice]) => total + BigInt(units) * BigInt(unitPrice),
    0n,
  );
  if (rawCost > MAX_SAFE_BIGINT) {
    throw new RangeError("rawCostMicros exceeds Number.MAX_SAFE_INTEGER");
  }
  return Number(rawCost);
}

/**
 * Calculates text cost using OpenAI token semantics.
 *
 * promptTokens includes cachedTokens, so cached input is removed from the
 * normal input bucket before the cache-read price is applied. Cache writes are
 * an explicit, separately reported bucket and default to zero.
 */
export function calculateOpenAITextTokenPricing(
  usage: OpenAITextTokenUsage,
  pricing: TextTokenPricing,
): TextTokenPricingResult {
  const promptTokens = nonNegativeSafeInteger(usage.promptTokens, "promptTokens");
  const completionTokens = nonNegativeSafeInteger(usage.completionTokens, "completionTokens");
  const cachedTokens = nonNegativeSafeInteger(usage.cachedTokens ?? 0, "cachedTokens");
  const cacheWriteTokens = nonNegativeSafeInteger(usage.cacheWriteTokens ?? 0, "cacheWriteTokens");
  if (cachedTokens > promptTokens) {
    throw new RangeError("cachedTokens cannot exceed promptTokens under OpenAI semantics");
  }

  const inputPriceMicros = nonNegativeSafeInteger(pricing.inputPriceMicros, "inputPriceMicros");
  const outputPriceMicros = nonNegativeSafeInteger(pricing.outputPriceMicros, "outputPriceMicros");
  const cacheReadPriceMicros = nonNegativeSafeInteger(pricing.cacheReadPriceMicros, "cacheReadPriceMicros");
  const cacheWritePriceMicros = nonNegativeSafeInteger(pricing.cacheWritePriceMicros ?? 0, "cacheWritePriceMicros");
  const minimumMicros = nonNegativeSafeInteger(pricing.minimumMicros ?? 0, "minimumMicros");
  const multiplier = nonNegativeFiniteNumber(pricing.multiplier ?? 1, "multiplier");

  const nonCachedInputTokens = promptTokens - cachedTokens;
  const rawCostMicros = safeRawCost([
    [nonCachedInputTokens, inputPriceMicros],
    [cachedTokens, cacheReadPriceMicros],
    [completionTokens, outputPriceMicros],
    [cacheWriteTokens, cacheWritePriceMicros],
  ]);

  const multipliedCostMicros = Math.round(rawCostMicros * multiplier);
  if (!Number.isSafeInteger(multipliedCostMicros) || multipliedCostMicros < 0) {
    throw new RangeError("multipliedCostMicros exceeds the safe integer range");
  }

  return {
    promptTokens,
    nonCachedInputTokens,
    cachedTokens,
    completionTokens,
    cacheWriteTokens,
    rawCostMicros,
    multipliedCostMicros,
    costMicros: Math.max(multipliedCostMicros, minimumMicros),
  };
}
