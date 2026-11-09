export const TIME_PRICING_CONFIG_KEY = "timePricing";
export const DEFAULT_TIME_PRICING_TIMEZONE = "Asia/Shanghai";

export interface TimePricingPeriod {
  id: string;
  name: string;
  daysOfWeek: number[];
  startMinute: number;
  endMinute: number;
  multiplierBps: number;
}

export interface TimePricingConfig {
  enabled: boolean;
  timezone: string;
  periods: TimePricingPeriod[];
}

export interface TimePricingSnapshot {
  configured: boolean;
  evaluatedAt: number;
  timezone: string;
  multiplierBps: number;
  multiplier: number;
  periodId: string | null;
  periodName: string | null;
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
}

export interface TimePricingValidationIssue {
  path: string[];
  message: string;
}

const MAX_PERIODS = 24;
const MAX_MULTIPLIER_BPS = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function integer(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function normalizeDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(integer).filter((day): day is number => day != null && day >= 0 && day <= 6))]
    .sort((left, right) => left - right);
}

function normalizePeriod(value: unknown, index: number): TimePricingPeriod | null {
  if (!isRecord(value)) return null;
  const startMinute = integer(value.startMinute);
  const endMinute = integer(value.endMinute);
  const multiplierBps = integer(value.multiplierBps);
  if (startMinute == null || endMinute == null || multiplierBps == null) return null;
  return {
    id: String(value.id || `period-${index + 1}`).trim() || `period-${index + 1}`,
    name: String(value.name || `时段 ${index + 1}`).trim() || `时段 ${index + 1}`,
    daysOfWeek: normalizeDays(value.daysOfWeek),
    startMinute,
    endMinute,
    multiplierBps,
  };
}

export function readTimePricingConfig(ruleConfig: unknown): TimePricingConfig | null {
  if (!isRecord(ruleConfig)) return null;
  const raw = ruleConfig[TIME_PRICING_CONFIG_KEY];
  if (!isRecord(raw)) return null;
  const timezone = String(raw.timezone || DEFAULT_TIME_PRICING_TIMEZONE).trim() || DEFAULT_TIME_PRICING_TIMEZONE;
  const periods = Array.isArray(raw.periods)
    ? raw.periods.map(normalizePeriod).filter((period): period is TimePricingPeriod => period != null)
    : [];
  return {
    enabled: raw.enabled === true,
    timezone,
    periods,
  };
}

type ExpandedSegment = { day: number; start: number; end: number; periodIndex: number };

function expandedSegments(period: TimePricingPeriod, periodIndex: number): ExpandedSegment[] {
  return period.daysOfWeek.flatMap((day) => {
    if (period.startMinute < period.endMinute) {
      return [{ day, start: period.startMinute, end: period.endMinute, periodIndex }];
    }
    return [
      { day, start: period.startMinute, end: 1_440, periodIndex },
      { day: (day + 1) % 7, start: 0, end: period.endMinute, periodIndex },
    ];
  });
}

export function validateTimePricingConfig(ruleConfig: unknown): TimePricingValidationIssue[] {
  if (!isRecord(ruleConfig) || ruleConfig[TIME_PRICING_CONFIG_KEY] == null) return [];
  const raw = ruleConfig[TIME_PRICING_CONFIG_KEY];
  const root = ["ruleConfig", TIME_PRICING_CONFIG_KEY];
  if (!isRecord(raw)) return [{ path: root, message: "分时定价必须是对象" }];

  const issues: TimePricingValidationIssue[] = [];
  if (typeof raw.enabled !== "boolean") {
    issues.push({ path: [...root, "enabled"], message: "enabled 必须是布尔值" });
  }
  const timezone = String(raw.timezone || "").trim();
  if (!timezone || !validTimezone(timezone)) {
    issues.push({ path: [...root, "timezone"], message: "请使用有效的 IANA 时区，例如 Asia/Shanghai" });
  }
  if (!Array.isArray(raw.periods)) {
    issues.push({ path: [...root, "periods"], message: "periods 必须是数组" });
    return issues;
  }
  if (raw.periods.length > MAX_PERIODS) {
    issues.push({ path: [...root, "periods"], message: `分时时段最多 ${MAX_PERIODS} 个` });
  }
  if (raw.enabled === true && raw.periods.length === 0) {
    issues.push({ path: [...root, "periods"], message: "启用分时定价后至少需要一个时段" });
  }

  const normalized: TimePricingPeriod[] = [];
  const ids = new Set<string>();
  raw.periods.forEach((value, index) => {
    const path = [...root, "periods", String(index)];
    if (!isRecord(value)) {
      issues.push({ path, message: "时段必须是对象" });
      return;
    }
    const period = normalizePeriod(value, index);
    const id = String(value.id || "").trim();
    if (!id) issues.push({ path: [...path, "id"], message: "时段 id 不能为空" });
    else if (ids.has(id)) issues.push({ path: [...path, "id"], message: "时段 id 不能重复" });
    else ids.add(id);
    const days = normalizeDays(value.daysOfWeek);
    if (!Array.isArray(value.daysOfWeek) || days.length === 0 || days.length !== value.daysOfWeek.length) {
      issues.push({ path: [...path, "daysOfWeek"], message: "至少选择一天，且星期值必须为 0-6 的不重复整数" });
    }
    const startMinute = integer(value.startMinute);
    const endMinute = integer(value.endMinute);
    if (startMinute == null || startMinute < 0 || startMinute > 1_439) {
      issues.push({ path: [...path, "startMinute"], message: "开始时间必须是 0-1439 的整数分钟" });
    }
    if (endMinute == null || endMinute < 0 || endMinute > 1_439) {
      issues.push({ path: [...path, "endMinute"], message: "结束时间必须是 0-1439 的整数分钟" });
    }
    if (startMinute != null && endMinute != null && startMinute === endMinute) {
      issues.push({ path: [...path, "endMinute"], message: "开始和结束时间不能相同" });
    }
    const multiplierBps = integer(value.multiplierBps);
    if (multiplierBps == null || multiplierBps <= 0 || multiplierBps > MAX_MULTIPLIER_BPS) {
      issues.push({ path: [...path, "multiplierBps"], message: "价格倍率必须大于 0 且不超过 100 倍" });
    }
    if (period) normalized.push(period);
  });

  if (issues.length === 0) {
    const segments = normalized.flatMap(expandedSegments);
    for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
      const left = segments[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
        const right = segments[rightIndex];
        if (left.periodIndex === right.periodIndex || left.day !== right.day) continue;
        if (Math.max(left.start, right.start) < Math.min(left.end, right.end)) {
          issues.push({
            path: [...root, "periods", String(right.periodIndex)],
            message: `时段与「${normalized[left.periodIndex].name}」重叠，请调整星期或时间`,
          });
          return issues;
        }
      }
    }
  }
  return issues;
}

function zonedParts(at: number, timezone: string): { weekday: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
  return {
    weekday: weekday < 0 ? 0 : weekday,
    minuteOfDay: Number(values.hour || 0) * 60 + Number(values.minute || 0),
  };
}

function matchesPeriod(period: TimePricingPeriod, weekday: number, minuteOfDay: number): boolean {
  if (period.startMinute < period.endMinute) {
    return period.daysOfWeek.includes(weekday)
      && minuteOfDay >= period.startMinute
      && minuteOfDay < period.endMinute;
  }
  if (minuteOfDay >= period.startMinute) return period.daysOfWeek.includes(weekday);
  if (minuteOfDay < period.endMinute) return period.daysOfWeek.includes((weekday + 6) % 7);
  return false;
}

export function resolveTimePricing(ruleConfig: unknown, evaluatedAt = Date.now()): TimePricingSnapshot {
  const config = readTimePricingConfig(ruleConfig);
  const fallback: TimePricingSnapshot = {
    configured: Boolean(config?.enabled),
    evaluatedAt,
    timezone: config?.timezone || DEFAULT_TIME_PRICING_TIMEZONE,
    multiplierBps: 10_000,
    multiplier: 1,
    periodId: null,
    periodName: null,
    daysOfWeek: [],
    startMinute: null,
    endMinute: null,
  };
  if (!config?.enabled || validateTimePricingConfig({ [TIME_PRICING_CONFIG_KEY]: config }).length > 0) return fallback;

  const { weekday, minuteOfDay } = zonedParts(evaluatedAt, config.timezone);
  const period = config.periods.find((candidate) => matchesPeriod(candidate, weekday, minuteOfDay));
  if (!period) return fallback;
  return {
    configured: true,
    evaluatedAt,
    timezone: config.timezone,
    multiplierBps: period.multiplierBps,
    multiplier: period.multiplierBps / 10_000,
    periodId: period.id,
    periodName: period.name,
    daysOfWeek: [...period.daysOfWeek],
    startMinute: period.startMinute,
    endMinute: period.endMinute,
  };
}

export function multiplyPricingMicros(value: number, multiplier: number, field = "costMicros"): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer`);
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new RangeError("time pricing multiplier must be positive");
  const result = Math.round(value * multiplier);
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${field} exceeds Number.MAX_SAFE_INTEGER`);
  return result;
}
