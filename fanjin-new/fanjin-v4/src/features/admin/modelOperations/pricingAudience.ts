export const PRICING_AUDIENCE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PRICING_GROUP = "default" as const;

export interface PricingAudienceGroupDraft {
  group: string;
  visible: boolean;
  discountBps: number;
}

export interface PricingAudienceDraft {
  defaultVisible: boolean;
  groups: PricingAudienceGroupDraft[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizePricingGroup(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function pricingAudienceDraftFromRuleConfig(ruleConfig: unknown): PricingAudienceDraft {
  const config = record(ruleConfig) ?? {};
  const contract = record(config.audiencePricing);
  if (!contract || contract.schemaVersion !== PRICING_AUDIENCE_SCHEMA_VERSION) {
    return { defaultVisible: true, groups: [] };
  }
  const groups = Array.isArray(contract.groups)
    ? contract.groups.flatMap((candidate) => {
        const value = record(candidate);
        const group = normalizePricingGroup(value?.group);
        const discountBps = Number(value?.discountBps);
        if (!group || group === DEFAULT_PRICING_GROUP) return [];
        return [{
          group,
          visible: value?.visible !== false,
          discountBps: Number.isSafeInteger(discountBps) && discountBps >= 1 && discountBps <= 10_000
            ? discountBps
            : 10_000,
        }];
      })
    : [];
  return {
    defaultVisible: contract.defaultVisible !== false,
    groups,
  };
}

export function validatePricingAudienceDraft(draft: PricingAudienceDraft): string {
  if (draft.groups.length > 100) return "单个价格最多配置 100 个用户分组。";
  const seen = new Set<string>();
  for (const candidate of draft.groups) {
    const group = normalizePricingGroup(candidate.group);
    if (!group) return "请填写用户分组代码。";
    if (group === DEFAULT_PRICING_GROUP) return "default 是系统保留分组，请使用“未单独配置的用户”开关。";
    if (group.length > 48 || /[\u0000-\u001f\u007f]/.test(group)) return "用户分组代码需为 1-48 个非控制字符。";
    if (seen.has(group)) return `用户分组 ${group} 重复。`;
    seen.add(group);
    if (!Number.isSafeInteger(candidate.discountBps) || candidate.discountBps < 1 || candidate.discountBps > 10_000) {
      return `${group} 的折扣必须在 0.01%-100% 之间。`;
    }
  }
  return "";
}

export function editableLogicalPriceRuleConfig(ruleConfig: unknown): Record<string, unknown> {
  const config = { ...(record(ruleConfig) ?? {}) };
  for (const key of [
    "schemaVersion",
    "kind",
    "groupKey",
    "parentGroupKey",
    "logicalCatalogOnly",
    "audiencePricingEffective",
  ]) delete config[key];
  return config;
}

export function writePricingAudienceDraft(
  ruleConfig: Record<string, unknown>,
  draft: PricingAudienceDraft,
): Record<string, unknown> {
  const error = validatePricingAudienceDraft(draft);
  if (error) throw new Error(error);
  const output = { ...ruleConfig };
  delete output.audiencePricingEffective;
  const groups = draft.groups.map((candidate) => ({
    group: normalizePricingGroup(candidate.group),
    visible: candidate.visible,
    discountBps: candidate.discountBps,
  }));
  if (draft.defaultVisible && groups.length === 0) {
    delete output.audiencePricing;
  } else {
    output.audiencePricing = {
      schemaVersion: PRICING_AUDIENCE_SCHEMA_VERSION,
      defaultVisible: draft.defaultVisible,
      groups,
    };
  }
  return output;
}

export function discountedPriceMicros(baseMicros: number, discountBps: number): number {
  if (!Number.isSafeInteger(baseMicros) || baseMicros <= 0) return 0;
  if (!Number.isSafeInteger(discountBps) || discountBps < 1 || discountBps > 10_000) return baseMicros;
  return Math.max(1, Math.round((baseMicros * discountBps) / 10_000));
}

export function discountLabel(discountBps: number): string {
  if (discountBps === 10_000) return "原价";
  const percent = discountBps / 100;
  return `${percent.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}
