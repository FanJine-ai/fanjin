// The ledger atom remains 1/1,000,000,000 yuan. Changing the displayed GU denomination
// must never rescale balances, freezes, payment callbacks, or historical price snapshots.
export const guUnitVersion = "gu-cny-10/v1";
export const guPerYuan = 10;
export const guMicrosPerGu = 100_000_000;
export const guMicrosPerYuan = 1_000_000_000;
export const cnyMicrosPerYuan = 1_000_000;
export const ledgerAtomsPerCnyMicro = guMicrosPerYuan / cnyMicrosPerYuan;

export const guChargeRoundingVersion = "gu-ceil-2/v1";
export const guChargeQuantumMicros = guMicrosPerGu / 100;

/** Round the whole retail charge once, after token/rate/discount arithmetic.
 * Integer atoms avoid e.g. a floating-point 1.2300000000000002 becoming 1.24. */
export function ceilGuChargeMicros(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error("GU_AMOUNT_INVALID");
  const step = BigInt(guChargeQuantumMicros);
  const rounded = ((BigInt(micros) + step - 1n) / step) * step;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GU_AMOUNT_INVALID");
  return Number(rounded);
}

/** Missing version means a pre-upgrade reservation: honor its original terms. */
export function applyGuChargeRounding(micros: number, metadata: Record<string, unknown> | null | undefined): number {
  return metadata?.guChargeRounding === guChargeRoundingVersion ? ceilGuChargeMicros(micros) : micros;
}

/** Exact GU text for financial review receipts, including amounts below 0.000001 GU. */
export function guStringFromMicros(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error("GU_AMOUNT_INVALID");
  const amount = BigInt(micros);
  const divisor = BigInt(guMicrosPerGu);
  const fraction = String(amount % divisor).padStart(String(guMicrosPerGu).length - 1, "0").replace(/0+$/, "");
  return `${amount / divisor}${fraction ? `.${fraction}` : ""} GU`;
}
