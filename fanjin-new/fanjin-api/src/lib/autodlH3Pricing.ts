import { guMicrosPerGu, guMicrosPerYuan } from "./billingUnits";
import { AUTODL_H3_CINEMA_MODEL, AUTODL_H3_CINEMA_RESOLUTIONS, isAutoDLH3LocalLightWorkflow } from "./autodlH3Manifest";

// User-approved retail: CNY 0.06 per requested output second (10 GU/CNY).
export const AUTODL_H3_RETAIL_CNY_PER_SECOND = 0.06;
export const AUTODL_H3_RETAIL_MICROS_PER_SECOND = guMicrosPerYuan / 100 * 6;
export const AUTODL_H3_RETAIL_GU_PER_SECOND = AUTODL_H3_RETAIL_MICROS_PER_SECOND / guMicrosPerGu;

export const AUTODL_H3_PRICING_VERSION = "autodl-h3-output-second/v1";

export const AUTODL_H3_CINEMA_PRICING_VERSION = "autodl-h3-cinema-output-second/v1";
// Ledger atoms: 1 CNY = 1e9 atoms; 1 GU = 1e8 atoms. Cost × 1.5, not 50% margin.
export const AUTODL_H3_CINEMA_RATES = {
  peak: { "480p": 60_000_000, "768p": 75_000_000, "960p": 135_000_000 },
  offPeak: { "480p": 45_000_000, "768p": 60_000_000, "960p": 120_000_000 },
} as const;

export function autoDLH3CinemaPeriod(evaluatedAt: number): "peak" | "offPeak" {
  if (!Number.isFinite(evaluatedAt) || !Number.isFinite(new Date(evaluatedAt).getTime())) {
    throw new Error("H3 影视版计价时间无效");
  }
  // Asia/Shanghai, UTC+08:00; off-peak is [00:00, 08:00).
  return new Date(evaluatedAt + 8 * 3_600_000).getUTCHours() < 8 ? "offPeak" : "peak";
}

/** Price is frozen from requested output seconds, never data.duration (GPU runtime). */
export function autoDLH3OutputPrice(contract: unknown, requestPayload: unknown, evaluatedAt = Date.now()): number {
  const value = contract as Record<string, any> | null;
  const payload = requestPayload as Record<string, unknown> | null;
  const cinema = value?.version === AUTODL_H3_CINEMA_PRICING_VERSION;
  if ((payload?.model === AUTODL_H3_CINEMA_MODEL && !cinema)
    || (cinema && payload?.model != null && payload.model !== AUTODL_H3_CINEMA_MODEL)) {
    throw new Error("H3 模型与定价合同不一致");
  }
  if (cinema) {
    const period = autoDLH3CinemaPeriod(evaluatedAt);
    for (const key of ["peak", "offPeak"] as const) {
      const rates = value.outputMicrosPerSecond?.[key];
      if (!rates || typeof rates !== "object" || Array.isArray(rates)
        || Object.keys(rates).length !== AUTODL_H3_CINEMA_RESOLUTIONS.length
        || AUTODL_H3_CINEMA_RESOLUTIONS.some(resolution => !Number.isSafeInteger(rates[resolution]) || rates[resolution] <= 0)) {
        throw new Error("H3 影视版必须配置三档分辨率的高峰与空闲每秒价格");
      }
    }
    const resolution = String(payload?.resolution ?? "768p").toLowerCase();
    if (!(AUTODL_H3_CINEMA_RESOLUTIONS as readonly string[]).includes(resolution)) throw new Error("H3 影视版分辨率未配置价格");
    const seconds = payload?.duration ?? 5;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 15) throw new Error("H3 影视版时长必须为 1–15 秒整数");
    const cost = value.outputMicrosPerSecond[period][resolution] * seconds;
    if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error("H3 影视版价格超出安全整数范围");
    return cost;
  }
  if (!value || value.version !== AUTODL_H3_PRICING_VERSION) throw new Error("AutoDL H3 定价合同无效");
  const rates = value.outputMicrosPerSecond;
  if (!rates || typeof rates !== "object" || Array.isArray(rates)
    || Object.keys(rates).length !== 1 || !Number.isSafeInteger(rates["768p"]) || rates["768p"] <= 0) {
    throw new Error("AutoDL H3 必须配置 768p 每秒价格");
  }
  if (String(payload?.resolution ?? "768p").toLowerCase() !== "768p") throw new Error("AutoDL H3 分辨率未配置价格");
  const seconds = payload?.duration ?? 5;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 15) throw new Error("AutoDL H3 时长必须为 1–15 秒整数");
  if (isAutoDLH3LocalLightWorkflow()) return guMicrosPerGu;
  const cost = rates["768p"] * seconds;
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error("AutoDL H3 价格超出安全整数范围");
  return cost;
}
