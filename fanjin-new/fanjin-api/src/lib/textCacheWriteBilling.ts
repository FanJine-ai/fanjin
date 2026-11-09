/** Cache writes priced per token do not imply separately billed storage. */
export type TextCacheWriteBillingMode = "token_only" | "none" | "storage";

export function textCacheWriteBillingMode(
  config: Record<string, unknown>,
  provider: string,
): TextCacheWriteBillingMode {
  const mode = config.cacheWriteBillingMode;
  if (mode === undefined) return "storage";
  if (provider !== "openai" || (mode !== "token_only" && mode !== "none")) {
    throw new Error("TEXT_CACHE_WRITE_BILLING_MODE_INVALID");
  }
  if (config.cacheWriteAccounting != null) throw new Error("TEXT_CACHE_WRITE_DOUBLE_BILLING_CONTRACT");
  if (mode === "token_only" && !(Number(config.cacheWritePriceMicros) > 0)) {
    throw new Error("TEXT_CACHE_WRITE_TOKEN_PRICE_REQUIRED");
  }
  return mode;
}
