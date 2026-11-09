import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
export const pricingProviders = ["", "volcano", "autodl", "custom", "openai", "anthropic", "codex", "gemini", "azure"] as const;
export const pricingEndpoints = [
  "text",
  "embedding",
  "multimodal_embedding",
  "image_generation",
  "video_generation",
  "tts",
  "transcription",
  "rerank",
] as const;
export const pricingScopes = ["platform", "workspace"] as const;
export const pricingUnits = ["token", "image", "task", "video", "second", "document"] as const;

export type PricingScope = (typeof pricingScopes)[number];
export type PricingEndpoint = (typeof pricingEndpoints)[number];
export type PricingUnit = (typeof pricingUnits)[number];

// Mirrors fanjin-api/src/lib/productionPricing.ts. Keep the selector form on
// the same endpoint -> unit contract that production billing enforces.
export const pricingUnitsByEndpoint: Record<PricingEndpoint, readonly PricingUnit[]> = {
  text: ["token"],
  embedding: ["token"],
  multimodal_embedding: ["token"],
  image_generation: ["image"],
  video_generation: ["token", "task", "video"],
  tts: ["task"],
  transcription: ["second"],
  rerank: ["document"],
};

export interface PricingRule {
  id: string;
  name?: string | null;
  scope?: string | null;
  workspaceId?: string | null;
  endpointType?: string | null;
  provider?: string | null;
  model?: string | null;
  unit?: string | null;
  unitPriceMicros?: number | null;
  currency?: string | null;
  ruleConfig?: Record<string, unknown> | null;
  disabled?: boolean | number | null;
  createTime?: string | number | null;
  updateTime?: string | number | null;
}

export interface PricingRuleForm {
  id: string;
  name: string;
  scope: PricingScope;
  workspaceId: string;
  endpointType: string;
  provider: string;
  model: string;
  unit: string;
  unitPriceGu: number;
  disabled: boolean;
  ruleConfigText: string;
}

export interface PricingRulePayload {
  name: string;
  scope: PricingScope;
  workspaceId: string | null;
  endpointType: PricingEndpoint;
  provider: string | null;
  model: string | null;
  unit: PricingUnit;
  unitPriceMicros: number;
  currency: "GU";
  ruleConfig: Record<string, unknown>;
  disabled: number;
}

export const endpointLabels: Record<PricingEndpoint, string> = {
  text: "文本",
  embedding: "文本向量",
  multimodal_embedding: "多模态向量",
  image_generation: "图片生成",
  video_generation: "视频生成",
  tts: "语音合成",
  transcription: "音频转写",
  rerank: "文本重排",
};

export function isPricingEndpoint(value: unknown): value is PricingEndpoint {
  return pricingEndpoints.includes(value as PricingEndpoint);
}

export function pricingUnitsForEndpoint(value: unknown): readonly PricingUnit[] {
  return isPricingEndpoint(value) ? pricingUnitsByEndpoint[value] : [];
}

export function isPricingUnitForEndpoint(endpointType: unknown, unit: unknown): unit is PricingUnit {
  return typeof unit === "string" && pricingUnitsForEndpoint(endpointType).includes(unit as PricingUnit);
}

export const unitLabels: Record<string, string> = {
  token: "GU / M tokens",
  task: "每任务",
  image: "每张图片",
  video: "每段视频",
  second: "每秒",
  document: "每文档",
};

export function createEmptyPricingForm(): PricingRuleForm {
  return { id: "", name: "", scope: "platform", workspaceId: "", endpointType: "video_generation", provider: "", model: "", unit: "task", unitPriceGu: 0, disabled: false, ruleConfigText: "{}" };
}

/**
 * Ledger atoms remain stable; one million tokens uses 1/100 as many displayed
 * GU as the old denomination. Round trips preserve the stored integer price.
 */
export function pricingAmountFromMicros(value: unknown, unit: unknown): number {
  const micros = Number(value || 0);
  if (!Number.isFinite(micros)) return 0;
  return unit === "token" ? micros * (1_000_000 / GU_MICROS_PER_GU) : micros / GU_MICROS_PER_GU;
}

export function pricingMicrosFromAmount(value: number, unit: unknown): number {
  return Math.round(unit === "token" ? value * (GU_MICROS_PER_GU / 1_000_000) : value * GU_MICROS_PER_GU);
}

export type VideoInputPricingTierKey = "withVideoInput" | "withoutVideoInput";

export interface VideoInputPricingFormState {
  enabled: boolean;
  valid: boolean;
  withVideoInputPriceGu: number;
  withoutVideoInputPriceGu: number;
}

function configRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const MAX_TIME_PRICING_PERIODS = 24;
const MAX_TIME_PRICING_MULTIPLIER_BPS = 1_000_000;

function validTimePricingTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

type TimePricingSegment = {
  day: number;
  start: number;
  end: number;
  periodIndex: number;
  periodName: string;
};

/**
 * Mirrors the production time-pricing contract so the visual editor cannot
 * submit a schedule that the API will reject (or silently ignore at runtime).
 */
export function validateTimePricingRuleConfig(ruleConfig: Record<string, unknown>): string {
  if (ruleConfig.timePricing == null) return "";
  const raw = configRecord(ruleConfig.timePricing);
  if (!raw) return "分时定价必须是对象";
  if (typeof raw.enabled !== "boolean") return "分时定价的 enabled 必须是布尔值";

  const timezone = String(raw.timezone || "").trim();
  if (!timezone || !validTimePricingTimezone(timezone)) {
    return "请使用有效的 IANA 时区，例如 Asia/Shanghai";
  }
  if (!Array.isArray(raw.periods)) return "分时定价的 periods 必须是数组";
  if (raw.periods.length > MAX_TIME_PRICING_PERIODS) {
    return `分时时段最多 ${MAX_TIME_PRICING_PERIODS} 个`;
  }
  if (raw.enabled && raw.periods.length === 0) return "启用分时定价后至少需要一个时段";

  const ids = new Set<string>();
  const segments: TimePricingSegment[] = [];
  for (let index = 0; index < raw.periods.length; index += 1) {
    const period = configRecord(raw.periods[index]);
    if (!period) return `第 ${index + 1} 个分时时段必须是对象`;
    const id = String(period.id || "").trim();
    if (!id) return `第 ${index + 1} 个时段的 id 不能为空`;
    if (ids.has(id)) return "分时时段的 id 不能重复";
    ids.add(id);

    const rawDays = period.daysOfWeek;
    const days = Array.isArray(rawDays)
      ? rawDays.map(Number).filter((day) => Number.isSafeInteger(day) && day >= 0 && day <= 6)
      : [];
    if (!Array.isArray(rawDays) || !days.length || new Set(days).size !== rawDays.length) {
      return "每个时段至少选择一天，且星期值必须是 0-6 的不重复整数";
    }
    const startMinute = Number(period.startMinute);
    const endMinute = Number(period.endMinute);
    if (!Number.isSafeInteger(startMinute) || startMinute < 0 || startMinute > 1_439) {
      return "开始时间必须是 0-1439 的整数分钟";
    }
    if (!Number.isSafeInteger(endMinute) || endMinute < 0 || endMinute > 1_439) {
      return "结束时间必须是 0-1439 的整数分钟";
    }
    if (startMinute === endMinute) return "时段的开始和结束时间不能相同";

    const multiplierBps = Number(period.multiplierBps);
    if (!Number.isSafeInteger(multiplierBps) || multiplierBps <= 0 || multiplierBps > MAX_TIME_PRICING_MULTIPLIER_BPS) {
      return "价格倍率必须大于 0 且不超过 100 倍";
    }

    const periodName = String(period.name || `时段 ${index + 1}`);
    for (const day of days) {
      if (startMinute < endMinute) {
        segments.push({ day, start: startMinute, end: endMinute, periodIndex: index, periodName });
      } else {
        segments.push({ day, start: startMinute, end: 1_440, periodIndex: index, periodName });
        segments.push({ day: (day + 1) % 7, start: 0, end: endMinute, periodIndex: index, periodName });
      }
    }
  }

  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const right = segments[rightIndex];
      if (left.periodIndex === right.periodIndex || left.day !== right.day) continue;
      if (Math.max(left.start, right.start) < Math.min(left.end, right.end)) {
        return `时段与「${left.periodName}」重叠，请调整星期或时间`;
      }
    }
  }
  return "";
}

function parseRuleConfigText(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text.trim() || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("规则配置必须是合法的 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

export function readVideoInputPricingFormState(
  ruleConfigText: string,
  unit: unknown,
  fallbackPriceGu: number,
): VideoInputPricingFormState {
  let config: Record<string, unknown>;
  try {
    config = parseRuleConfigText(ruleConfigText);
  } catch {
    return {
      enabled: false,
      valid: false,
      withVideoInputPriceGu: fallbackPriceGu,
      withoutVideoInputPriceGu: fallbackPriceGu,
    };
  }
  if (config.videoInputPricing === undefined) {
    return {
      enabled: false,
      valid: true,
      withVideoInputPriceGu: fallbackPriceGu,
      withoutVideoInputPriceGu: fallbackPriceGu,
    };
  }
  const contract = configRecord(config.videoInputPricing);
  const withVideoInput = configRecord(contract?.withVideoInput);
  const withoutVideoInput = configRecord(contract?.withoutVideoInput);
  const withMicros = Number(withVideoInput?.unitPriceMicros);
  const withoutMicros = Number(withoutVideoInput?.unitPriceMicros);
  const valid = Boolean(
    contract
    && withVideoInput
    && withoutVideoInput
    && Number.isSafeInteger(withMicros)
    && withMicros > 0
    && Number.isSafeInteger(withoutMicros)
    && withoutMicros > 0,
  );
  return {
    enabled: true,
    valid,
    withVideoInputPriceGu: Number.isSafeInteger(withMicros) && withMicros > 0
      ? pricingAmountFromMicros(withMicros, unit)
      : fallbackPriceGu,
    withoutVideoInputPriceGu: Number.isSafeInteger(withoutMicros) && withoutMicros > 0
      ? pricingAmountFromMicros(withoutMicros, unit)
      : fallbackPriceGu,
  };
}

export function writeVideoInputPricingEnabled(
  ruleConfigText: string,
  unit: unknown,
  fallbackPriceGu: number,
  enabled: boolean,
): string {
  const config = parseRuleConfigText(ruleConfigText);
  if (!enabled) {
    delete config.videoInputPricing;
    return JSON.stringify(config, null, 2);
  }
  const fallbackMicros = pricingMicrosFromAmount(fallbackPriceGu, unit);
  if (!Number.isSafeInteger(fallbackMicros) || fallbackMicros <= 0) {
    throw new Error("请先设置大于 0 的基础价格");
  }
  const existing = configRecord(config.videoInputPricing);
  const tier = (key: VideoInputPricingTierKey) => {
    const current = configRecord(existing?.[key]) ?? {};
    const currentMicros = Number(current.unitPriceMicros);
    return {
      ...current,
      unitPriceMicros: Number.isSafeInteger(currentMicros) && currentMicros > 0
        ? currentMicros
        : fallbackMicros,
    };
  };
  config.videoInputPricing = {
    withVideoInput: tier("withVideoInput"),
    withoutVideoInput: tier("withoutVideoInput"),
  };
  return JSON.stringify(config, null, 2);
}

export function writeVideoInputPricingTierPrice(
  ruleConfigText: string,
  unit: unknown,
  tier: VideoInputPricingTierKey,
  priceGu: number,
): string {
  const config = parseRuleConfigText(ruleConfigText);
  const contract = configRecord(config.videoInputPricing);
  if (!contract) throw new Error("请先启用视频输入分档定价");
  const unitPriceMicros = pricingMicrosFromAmount(priceGu, unit);
  if (!Number.isSafeInteger(unitPriceMicros) || unitPriceMicros <= 0) {
    throw new Error("视频输入分档单价必须大于 0");
  }
  const currentTier = configRecord(contract[tier]) ?? {};
  config.videoInputPricing = {
    ...contract,
    [tier]: { ...currentTier, unitPriceMicros },
  };
  return JSON.stringify(config, null, 2);
}

export function pricingFormFromRule(rule: PricingRule): PricingRuleForm {
  const endpointType = String(rule.endpointType || "");
  const storedUnit = String(rule.unit || "");
  const ruleConfig = rule.ruleConfig && typeof rule.ruleConfig === "object" && !Array.isArray(rule.ruleConfig)
    ? rule.ruleConfig
    : {};
  const configuredInputPrice = Number(ruleConfig.inputPriceMicros);
  const unitPriceMicros = endpointType === "text"
    && storedUnit === "token"
    && Number.isFinite(configuredInputPrice)
    && configuredInputPrice > 0
    ? configuredInputPrice
    : Number(rule.unitPriceMicros || 0);
  return {
    id: String(rule.id || ""),
    name: String(rule.name || ""),
    scope: rule.scope === "workspace" ? "workspace" : "platform",
    workspaceId: String(rule.workspaceId || ""),
    endpointType,
    provider: String(rule.provider || ""),
    model: String(rule.model || ""),
    unit: storedUnit,
    unitPriceGu: pricingAmountFromMicros(unitPriceMicros, storedUnit),
    disabled: Boolean(rule.disabled),
    ruleConfigText: JSON.stringify(ruleConfig, null, 2),
  };
}

export function buildPricingPayload(form: PricingRuleForm): PricingRulePayload {
  if (!form.name.trim()) throw new Error("请填写规则名称");
  if (form.scope === "workspace" && !form.workspaceId.trim()) throw new Error("工作区规则需要填写 Workspace ID");
  if (!isPricingEndpoint(form.endpointType)) {
    throw new Error(`不支持的能力类型「${form.endpointType || "空值"}」，请选择有效能力后再保存`);
  }
  if (!isPricingUnitForEndpoint(form.endpointType, form.unit)) {
    const allowedUnits = pricingUnitsForEndpoint(form.endpointType);
    throw new Error(`${endpointLabels[form.endpointType]}仅支持计费单位：${allowedUnits.join("、")}`);
  }
  if (!Number.isFinite(form.unitPriceGu) || form.unitPriceGu < 0) throw new Error("单价必须是非负数");
  if (!form.disabled && form.unitPriceGu <= 0) throw new Error("启用的价格规则单价必须大于 0 GU");
  let ruleConfig: Record<string, unknown>;
  try {
    const parsed = JSON.parse(form.ruleConfigText.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    ruleConfig = parsed;
  } catch {
    throw new Error("规则配置必须是合法的 JSON 对象");
  }
  const textTokenPricing = form.endpointType === "text" && form.unit === "token";
  if (form.unit === "token" && !textTokenPricing && Math.abs(form.unitPriceGu * (GU_MICROS_PER_GU / 1_000_000) - Math.round(form.unitPriceGu * (GU_MICROS_PER_GU / 1_000_000))) > 1e-8) {
    throw new Error("Token 单价最多支持两位小数 GU / M tokens");
  }
  const tokenRate = Number((form.unitPriceGu * (GU_MICROS_PER_GU / 1_000_000)).toPrecision(15));
  const unitPriceMicros = textTokenPricing && tokenRate > 0
    ? Math.max(1, Math.round(tokenRate))
    : pricingMicrosFromAmount(form.unitPriceGu, form.unit);
  if (textTokenPricing) {
    if (tokenRate > Number.MAX_SAFE_INTEGER) throw new Error("Token 单价超出支持范围");
    ruleConfig.inputPriceMicros = tokenRate;
    const configuredOutputPrice = Number(ruleConfig.outputPriceMicros);
    const outputPriceMicros = Number.isFinite(configuredOutputPrice) && configuredOutputPrice > 0 && configuredOutputPrice <= Number.MAX_SAFE_INTEGER
      ? configuredOutputPrice
      : tokenRate;
    ruleConfig.outputPriceMicros = outputPriceMicros;
  }
  if (form.endpointType === "video_generation" && form.unit === "token") {
    if (!form.disabled && form.provider.trim() !== "volcano") {
      throw new Error("视频 Token 计费目前只能启用在火山引擎渠道");
    }
    const reservationUpperBoundTokens = Number(ruleConfig.reservationUpperBoundTokens);
    if (!form.disabled && (!Number.isSafeInteger(reservationUpperBoundTokens) || reservationUpperBoundTokens <= 0)) {
      throw new Error("视频 Token 计费需要填写大于 0 的单次最大预扣 Token");
    }
    if (Number.isSafeInteger(reservationUpperBoundTokens) && reservationUpperBoundTokens > 0) {
      ruleConfig.reservationUpperBoundTokens = reservationUpperBoundTokens;
    } else {
      delete ruleConfig.reservationUpperBoundTokens;
    }
  } else {
    delete ruleConfig.reservationUpperBoundTokens;
  }
  if (form.endpointType === "video_generation" && ruleConfig.videoInputPricing !== undefined) {
    const contract = configRecord(ruleConfig.videoInputPricing);
    const withVideoInput = configRecord(contract?.withVideoInput);
    const withoutVideoInput = configRecord(contract?.withoutVideoInput);
    for (const [label, tier] of [["有视频输入", withVideoInput], ["无视频输入", withoutVideoInput]] as const) {
      const price = Number(tier?.unitPriceMicros);
      if (!tier || !Number.isSafeInteger(price) || price <= 0) {
        throw new Error(`${label}分档单价必须大于 0`);
      }
    }
  } else if (form.endpointType !== "video_generation") {
    delete ruleConfig.videoInputPricing;
  }
  const timePricingError = validateTimePricingRuleConfig(ruleConfig);
  if (timePricingError) throw new Error(timePricingError);
  return {
    name: form.name.trim(), scope: form.scope,
    workspaceId: form.scope === "workspace" ? form.workspaceId.trim() : null,
    endpointType: form.endpointType, provider: form.provider.trim() || null,
    model: form.model.trim() || null, unit: form.unit,
    unitPriceMicros, currency: "GU",
    ruleConfig, disabled: form.disabled ? 1 : 0,
  };
}

/**
 * The visual model-pricing editor represents direct prices, not arbitrary
 * billing expressions. Archive active expression modifiers before switching
 * to the direct contract so the values shown in the editor are the values the
 * billing runtime will actually use.
 */
export function buildDirectModelPricingPayload(form: PricingRuleForm): PricingRulePayload {
  const payload = buildPricingPayload(form);
  const ruleConfig = { ...payload.ruleConfig };
  const advancedKeys = ["pricingExpr", "multiplier", "minimumMicros", "groupRatio"] as const;
  const activeAdvancedConfig = Object.fromEntries(
    advancedKeys
      .filter((key) => ruleConfig[key] !== undefined)
      .map((key) => [key, ruleConfig[key]]),
  );
  if (Object.keys(activeAdvancedConfig).length) {
    const existingBackup = ruleConfig.directPricingBackup;
    ruleConfig.directPricingBackup = {
      ...(existingBackup && typeof existingBackup === "object" && !Array.isArray(existingBackup)
        ? existingBackup as Record<string, unknown>
        : {}),
      ...activeAdvancedConfig,
    };
  }
  advancedKeys.forEach((key) => delete ruleConfig[key]);
  if (form.endpointType === "text" && form.unit === "token") {
    const rates = [ruleConfig.inputPriceMicros, ruleConfig.outputPriceMicros,
      ruleConfig.cacheReadPriceMicros ?? ruleConfig.inputPriceMicros,
      ruleConfig.cacheWritePriceMicros ?? 0].map(Number);
    if (rates.some((rate) => !Number.isFinite(rate) || rate < 0 || rate > Number.MAX_SAFE_INTEGER)) {
      throw new Error("Token 单价必须是支持范围内的非负数");
    }
    // The legacy direct calculator requires whole atoms per token. Use the
    // existing expression engine for fractional rates, rounding only the total.
    if (rates.some((rate) => !Number.isSafeInteger(rate))) {
      const [input, output, cacheRead, cacheWrite] = rates;
      ruleConfig.pricingExpr = `(p-cr)*${input}+cr*${cacheRead}+c*${output}+cc*${cacheWrite}`;
    }
  }
  ruleConfig.pricingMode = "direct";
  return { ...payload, ruleConfig };
}

export function pricingSelector(rule: Pick<PricingRule, "scope" | "workspaceId" | "endpointType" | "provider" | "model" | "unit">) {
  const scope = rule.scope === "workspace" ? "workspace" : "platform";
  const normalized = (value: unknown) => typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return [
    scope,
    scope === "workspace" ? normalized(rule.workspaceId) : "",
    normalized(rule.endpointType),
    normalized(rule.provider),
    normalized(rule.model),
    normalized(rule.unit),
  ].join("|");
}
