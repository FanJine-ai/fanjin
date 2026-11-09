export const GU_PER_YUAN = 10;
export const GU_MICROS_PER_GU = 100_000_000;
export const CNY_MICROS_PER_YUAN = 1_000_000;
export const GU_MICROS_PER_YUAN = GU_PER_YUAN * GU_MICROS_PER_GU;

export function guMicrosFromYuan(value?: number | null): number {
  return Math.round(Number(value || 0) * GU_MICROS_PER_YUAN);
}

export function guMicrosFromGu(value?: number | null): number {
  return Math.round(Number(value || 0) * GU_MICROS_PER_GU);
}

export function cnyMicrosFromYuan(value?: number | null): number {
  return Math.round(Number(value || 0) * CNY_MICROS_PER_YUAN);
}

export function guFromMicros(value?: number | null): number {
  return Number(value || 0) / GU_MICROS_PER_GU;
}

export function yuanFromGuMicros(value?: number | null): number {
  return Number(value || 0) / GU_MICROS_PER_YUAN;
}

/** Display whole charges at cent-GU precision. Keep integer strings exact, even
 * beyond Number.MAX_SAFE_INTEGER; refund signs retain the same magnitude. */
export function formatGuMicros(
  value?: number | string | null,
  maximumFractionDigits = 2,
  rounding: "up" | "down" = "up",
): string {
  const text = typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : String(value ?? 0);
  if (!/^-?\d+$/.test(text)) return "—";
  const amount = BigInt(text);
  const digits = Math.min(8, Math.max(0, Math.trunc(maximumFractionDigits)));
  const step = 10n ** BigInt(8 - digits);
  const magnitude = amount < 0n ? -amount : amount;
  const rounded = (magnitude + (rounding === "up" || amount < 0n ? step - 1n : 0n)) / step;
  const scale = 10n ** BigInt(digits);
  const whole = String(rounded / scale).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = String(rounded % scale).padStart(digits, "0").replace(/0+$/, "");
  return `${amount < 0n && rounded ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""} GU`;
}

export function formatYuanMicros(value?: number | null): string {
  return `¥${(Number(value || 0) / CNY_MICROS_PER_YUAN).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatYuanFromGuMicros(value?: number | null): string {
  return `¥${yuanFromGuMicros(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
