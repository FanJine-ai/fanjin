/** Per-token rates may contain fractions of a ledger atom. Round the final charge, not the rate. */
export function readTokenPriceRate(value: unknown): number | null {
  if (!["number", "string"].includes(typeof value) || (typeof value === "string" && !value.trim())) return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= Number.MAX_SAFE_INTEGER ? rate : null;
}

export function multiplyTokenPriceRate(value: number, multiplier: number): number {
  if (readTokenPriceRate(value) == null || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError("Token price and multiplier must be finite non-negative rates");
  }
  const result = value * multiplier;
  if (readTokenPriceRate(result) == null) throw new RangeError("Token price exceeds the safe numeric range");
  return result;
}
