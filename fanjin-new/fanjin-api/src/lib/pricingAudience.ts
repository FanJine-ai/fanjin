import type { Knex } from "knex";
import { readTokenPriceRate, multiplyTokenPriceRate } from "./tokenPriceRate";

export const PRICING_AUDIENCE_SCHEMA_VERSION = 1 as const;
export const PRICING_AUDIENCE_CONFIG_KEY = "audiencePricing" as const;
export const PRICING_AUDIENCE_EFFECTIVE_KEY = "audiencePricingEffective" as const;
export const DEFAULT_PRICING_GROUP = "default" as const;

export interface PricingAudienceGroupRule {
  group: string;
  visible: boolean;
  discountBps: number;
}

export interface PricingAudienceContract {
  schemaVersion: typeof PRICING_AUDIENCE_SCHEMA_VERSION;
  defaultVisible: boolean;
  groups: PricingAudienceGroupRule[];
}

export interface PricingAudienceValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface PricingAudienceDecision {
  pricingGroup: string;
  visible: boolean;
  discountBps: number;
  matchedBy: "legacy_default" | "default" | "group" | "invalid";
}

export interface PricingRuleLike {
  unitPriceMicros: number;
  ruleConfig: Record<string, unknown>;
}

export interface AudiencePricingResolution<TRule extends PricingRuleLike> {
  baseRule: TRule | null;
  rule: TRule | null;
  decision: PricingAudienceDecision | null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function normalizePricingGroup(value: unknown): string {
  const group = String(value || "").trim().toLowerCase();
  return group || DEFAULT_PRICING_GROUP;
}

function validGroupName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = normalizePricingGroup(value);
  return normalized !== DEFAULT_PRICING_GROUP
    && normalized.length >= 1
    && normalized.length <= 48
    && !/[\u0000-\u001f\u007f]/.test(normalized);
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: Array<string | number>,
): PricingAudienceValidationIssue[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort()
    .map((key) => ({ path: [...path, key], message: `不支持字段 ${key}` }));
}

export function validatePricingAudienceContract(
  ruleConfig: unknown,
): PricingAudienceValidationIssue[] {
  const config = record(ruleConfig) ?? {};
  const issues: PricingAudienceValidationIssue[] = [];
  if (config[PRICING_AUDIENCE_EFFECTIVE_KEY] !== undefined) {
    issues.push({
      path: [PRICING_AUDIENCE_EFFECTIVE_KEY],
      message: "生效后的用户分组价格是运行时字段，不能写入价格规则",
    });
  }
  if (config[PRICING_AUDIENCE_CONFIG_KEY] === undefined) return issues;
  const contract = record(config[PRICING_AUDIENCE_CONFIG_KEY]);
  const root = [PRICING_AUDIENCE_CONFIG_KEY];
  if (!contract) return [...issues, { path: root, message: "用户分组定价必须是对象" }];

  issues.push(...strictKeys(contract, ["schemaVersion", "defaultVisible", "groups"], root));
  if (contract.schemaVersion !== PRICING_AUDIENCE_SCHEMA_VERSION) {
    issues.push({ path: [...root, "schemaVersion"], message: "用户分组定价版本必须为 1" });
  }
  if (typeof contract.defaultVisible !== "boolean") {
    issues.push({ path: [...root, "defaultVisible"], message: "defaultVisible 必须是布尔值" });
  }
  if (!Array.isArray(contract.groups)) {
    issues.push({ path: [...root, "groups"], message: "groups 必须是数组" });
    return issues;
  }
  if (contract.groups.length > 100) {
    issues.push({ path: [...root, "groups"], message: "单个价格最多配置 100 个用户分组" });
  }

  const seen = new Set<string>();
  contract.groups.forEach((candidate, index) => {
    const path = [...root, "groups", index];
    const groupRule = record(candidate);
    if (!groupRule) {
      issues.push({ path, message: "分组规则必须是对象" });
      return;
    }
    issues.push(...strictKeys(groupRule, ["group", "visible", "discountBps"], path));
    if (!validGroupName(groupRule.group)) {
      issues.push({
        path: [...path, "group"],
        message: "分组代码需为 1-48 个非控制字符，default 为系统保留分组",
      });
    } else {
      const group = normalizePricingGroup(groupRule.group);
      if (seen.has(group)) issues.push({ path: [...path, "group"], message: "分组代码不能重复" });
      seen.add(group);
    }
    if (typeof groupRule.visible !== "boolean") {
      issues.push({ path: [...path, "visible"], message: "visible 必须是布尔值" });
    }
    const discountBps = Number(groupRule.discountBps);
    if (!Number.isSafeInteger(discountBps) || discountBps < 1 || discountBps > 10_000) {
      issues.push({ path: [...path, "discountBps"], message: "折扣基点必须是 1-10000 的整数" });
    }
  });
  return issues;
}

export function readPricingAudienceContract(ruleConfig: unknown): PricingAudienceContract | null {
  if (validatePricingAudienceContract(ruleConfig).length > 0) return null;
  const config = record(ruleConfig) ?? {};
  const raw = record(config[PRICING_AUDIENCE_CONFIG_KEY]);
  if (!raw) return null;
  return {
    schemaVersion: PRICING_AUDIENCE_SCHEMA_VERSION,
    defaultVisible: raw.defaultVisible as boolean,
    groups: (raw.groups as unknown[]).map((candidate) => {
      const value = record(candidate)!;
      return {
        group: normalizePricingGroup(value.group),
        visible: value.visible as boolean,
        discountBps: Number(value.discountBps),
      };
    }),
  };
}

/** Commercial audience policy is not upstream-price certification evidence. */
export function pricingCertificationRuleConfig(ruleConfig: unknown): Record<string, unknown> {
  const config = { ...(record(ruleConfig) ?? {}) };
  delete config[PRICING_AUDIENCE_CONFIG_KEY];
  delete config[PRICING_AUDIENCE_EFFECTIVE_KEY];
  return config;
}

export function resolvePricingAudienceDecision(
  ruleConfig: unknown,
  pricingGroupValue: unknown,
): PricingAudienceDecision {
  const pricingGroup = normalizePricingGroup(pricingGroupValue);
  const config = record(ruleConfig) ?? {};
  if (config[PRICING_AUDIENCE_CONFIG_KEY] === undefined) {
    return { pricingGroup, visible: true, discountBps: 10_000, matchedBy: "legacy_default" };
  }
  const contract = readPricingAudienceContract(config);
  if (!contract) {
    return { pricingGroup, visible: false, discountBps: 10_000, matchedBy: "invalid" };
  }
  const matched = contract.groups.find((candidate) => candidate.group === pricingGroup);
  if (matched) {
    return {
      pricingGroup,
      visible: matched.visible,
      discountBps: matched.discountBps,
      matchedBy: "group",
    };
  }
  return {
    pricingGroup,
    visible: contract.defaultVisible,
    discountBps: 10_000,
    matchedBy: "default",
  };
}

function discountedMicros(value: unknown, discountBps: number): unknown {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return value;
  if (parsed === 0 || discountBps === 10_000) return parsed;
  const discounted = Math.round((parsed * discountBps) / 10_000);
  if (!Number.isSafeInteger(discounted)) return value;
  return Math.max(1, discounted);
}

function discountedVideoInputPricing(
  value: unknown,
  discountBps: number,
): unknown {
  const contract = record(value);
  if (!contract) return value;
  const output: Record<string, unknown> = { ...contract };
  for (const key of ["withVideoInput", "withoutVideoInput"] as const) {
    const tier = record(contract[key]);
    if (!tier) continue;
    output[key] = {
      ...tier,
      unitPriceMicros: discountedMicros(tier.unitPriceMicros, discountBps),
      minimumMicros: discountedMicros(tier.minimumMicros, discountBps),
    };
  }
  return output;
}

export function applyPricingAudienceDecision<TRule extends PricingRuleLike>(
  rule: TRule,
  decision: PricingAudienceDecision,
): TRule | null {
  if (!decision.visible) return null;
  const commercialPolicy = record(rule.ruleConfig?.commercialPolicy);
  if (commercialPolicy?.stackableDiscounts === false && decision.discountBps !== 10_000) return null;
  const currentEffective = record(rule.ruleConfig?.[PRICING_AUDIENCE_EFFECTIVE_KEY]);
  if (
    currentEffective
    && normalizePricingGroup(currentEffective.pricingGroup) === decision.pricingGroup
    && Number(currentEffective.discountBps) === decision.discountBps
  ) return rule;

  const baseConfig = { ...(rule.ruleConfig || {}) };
  delete baseConfig[PRICING_AUDIENCE_EFFECTIVE_KEY];
  const config: Record<string, unknown> = { ...baseConfig };
  const basePricingExpr = typeof config.pricingExpr === "string" ? config.pricingExpr.trim() : "";
  for (const key of [
    "inputPriceMicros",
    "outputPriceMicros",
    "cacheReadPriceMicros",
    "cacheWritePriceMicros",
    "cachePriceMicros",
    "cacheCreatePriceMicros",
    "textTokenPriceMicros",
    "mediaTokenPriceMicros",
    "imageTokenPriceMicros",
    "minimumMicros",
  ]) {
    if (config[key] === undefined) continue;
    const rate = readTokenPriceRate(config[key]);
    config[key] = basePricingExpr && key !== "minimumMicros" && rate != null
      ? multiplyTokenPriceRate(rate, decision.discountBps / 10_000)
      : discountedMicros(config[key], decision.discountBps);
  }
  if (config.videoInputPricing !== undefined) {
    config.videoInputPricing = discountedVideoInputPricing(config.videoInputPricing, decision.discountBps);
  }
  if (basePricingExpr && decision.discountBps !== 10_000) {
    config.pricingExpr = `(${basePricingExpr})*${decision.discountBps}/10000`;
  }
  config[PRICING_AUDIENCE_EFFECTIVE_KEY] = {
    schemaVersion: PRICING_AUDIENCE_SCHEMA_VERSION,
    pricingGroup: decision.pricingGroup,
    visible: true,
    discountBps: decision.discountBps,
    matchedBy: decision.matchedBy,
    baseUnitPriceMicros: Number(rule.unitPriceMicros || 0),
    ...(readTokenPriceRate(baseConfig.inputPriceMicros) == null
      ? {} : { baseInputPriceMicros: readTokenPriceRate(baseConfig.inputPriceMicros) }),
    ...(basePricingExpr ? { basePricingExpr } : {}),
  };
  return {
    ...rule,
    unitPriceMicros: discountedMicros(rule.unitPriceMicros, decision.discountBps) as number,
    ruleConfig: config,
  };
}

export async function resolveWorkspacePricingGroup(
  database: Knex | Knex.Transaction,
  workspaceIdValue: unknown,
): Promise<string> {
  const workspaceId = String(workspaceIdValue || "").trim();
  if (!workspaceId || workspaceId.startsWith("__public_")) return DEFAULT_PRICING_GROUP;
  const workspace = await database("o_workspace")
    .where({ id: workspaceId, status: "active" })
    .select("ownerUserId")
    .first();
  const ownerUserId = Number(workspace?.ownerUserId || 0);
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) return DEFAULT_PRICING_GROUP;
  const profile = await database("o_user_commercial_profile")
    .where({ userId: ownerUserId })
    .select("pricingGroup")
    .first();
  return normalizePricingGroup(profile?.pricingGroup);
}

export async function applyPricingAudienceForWorkspace<TRule extends PricingRuleLike>(
  database: Knex | Knex.Transaction,
  workspaceId: unknown,
  baseRule: TRule | null,
): Promise<AudiencePricingResolution<TRule>> {
  if (!baseRule) return { baseRule: null, rule: null, decision: null };
  const pricingGroup = await resolveWorkspacePricingGroup(database, workspaceId);
  return applyPricingAudienceForGroup(baseRule, pricingGroup);
}

export function applyPricingAudienceForGroup<TRule extends PricingRuleLike>(
  baseRule: TRule | null,
  pricingGroup: unknown,
): AudiencePricingResolution<TRule> {
  if (!baseRule) return { baseRule: null, rule: null, decision: null };
  const decision = resolvePricingAudienceDecision(baseRule.ruleConfig, pricingGroup);
  return {
    baseRule,
    rule: applyPricingAudienceDecision(baseRule, decision),
    decision,
  };
}
