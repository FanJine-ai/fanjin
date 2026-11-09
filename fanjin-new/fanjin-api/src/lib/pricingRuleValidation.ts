import {jwsOfficialImagePolicy} from "./jwsOfficialImagePricing";
import { textCacheWriteBillingMode } from "./textCacheWriteBilling";
import {jwsImagePricePolicy} from "./jwsImagePricing";
import type { Knex } from "knex";
import { compileExpr } from "@/lib/billingExpr/compiler";
import { readVideoTokenReservationUpperBound, relayPricingUnits } from "@/lib/productionPricing";
import { resolveVideoInputPricing } from "@/lib/videoInputPricing";
import { parseCacheWriteAccountingContract } from "@/lib/cacheStorageAccountingContract";
import { validatePricingAudienceContract } from "@/lib/pricingAudience";
import { validateTimePricingConfig } from "@/lib/timePricing";

export interface PricingRuleSelectorInput {
  scope: unknown;
  workspaceId?: unknown;
  endpointType: unknown;
  provider?: unknown;
  model?: unknown;
  unit: unknown;
  disabled: unknown;
}

export interface NormalizedPricingRuleSelector {
  scope: "platform" | "workspace";
  workspaceId: string | null;
  endpointType: string;
  provider: string | null;
  model: string | null;
  unit: string;
  disabled: 0 | 1;
}

export interface PricingRuleValidationIssue {
  path: string[];
  message: string;
}

export interface StoredPricingExpressionIssue extends PricingRuleValidationIssue {
  id: string;
  disabled: boolean;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function optionalString(value: unknown): string | null {
  return trimmedString(value) || null;
}

function ruleConfigObject(value: unknown): Record<string, unknown> | null {
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

export function validatePricingExpressionConfig(ruleConfig: unknown): PricingRuleValidationIssue[] {
  const parsedRuleConfig = ruleConfigObject(ruleConfig);
  if (parsedRuleConfig === null) {
    if (typeof ruleConfig === "string" && ruleConfig.trim()) {
      return [{ path: ["ruleConfig"], message: "ruleConfig 不是有效的 JSON 对象" }];
    }
    if (ruleConfig != null && (typeof ruleConfig !== "object" || Array.isArray(ruleConfig))) {
      return [{ path: ["ruleConfig"], message: "ruleConfig 必须是对象" }];
    }
    return [];
  }
  if (!Object.prototype.hasOwnProperty.call(parsedRuleConfig, "pricingExpr")) return [];

  const pricingExpr = parsedRuleConfig.pricingExpr;
  if (typeof pricingExpr !== "string" || !pricingExpr.trim()) {
    return [{ path: ["ruleConfig", "pricingExpr"], message: "pricingExpr 必须是非空字符串" }];
  }
  try {
    compileExpr(pricingExpr);
    return [];
  } catch (error) {
    return [{
      path: ["ruleConfig", "pricingExpr"],
      message: `pricingExpr 不兼容安全表达式语法：${error instanceof Error ? error.message : "unknown"}`,
    }];
  }
}

/**
 * 发布前扫描所有持久化规则（包括 disabled 规则），防止旧 vm2 表达式在
 * 新 AST 解释器上线后才于请求路径爆炸，或被管理员重新启用时绕过校验。
 */
export function findStoredPricingExpressionIssues(
  rows: ReadonlyArray<{ id?: unknown; disabled?: unknown; ruleConfig?: unknown }>,
): StoredPricingExpressionIssue[] {
  return rows.flatMap((row) => validatePricingExpressionConfig(row.ruleConfig).map((issue) => ({
    ...issue,
    id: trimmedString(row.id) || "(unknown)",
    disabled: Number(row.disabled) === 1,
  })));
}

export function normalizePricingRuleSelector(input: PricingRuleSelectorInput): NormalizedPricingRuleSelector {
  const scope = input.scope === "workspace" ? "workspace" : "platform";
  return {
    scope,
    workspaceId: scope === "workspace" ? optionalString(input.workspaceId) : null,
    endpointType: trimmedString(input.endpointType),
    provider: optionalString(input.provider),
    model: optionalString(input.model),
    unit: trimmedString(input.unit),
    disabled: Number(input.disabled) === 1 ? 1 : 0,
  };
}

export function validatePricingRuleSelector(
  selector: NormalizedPricingRuleSelector,
  ruleConfig?: unknown,
): PricingRuleValidationIssue[] {
  const issues: PricingRuleValidationIssue[] = [];
  issues.push(...validatePricingExpressionConfig(ruleConfig));
  for (const issue of validatePricingAudienceContract(ruleConfig)) {
    issues.push({ path: ["ruleConfig", ...issue.path.map(String)], message: issue.message });
  }
  const allowedUnits = relayPricingUnits(selector.endpointType);
  if (!allowedUnits) {
    issues.push({
      path: ["endpointType"],
      message: `能力类型 ${selector.endpointType || "(empty)"} 没有可用的生产计费契约`,
    });
  } else if (!allowedUnits.includes(selector.unit)) {
    issues.push({
      path: ["unit"],
      message: `能力类型 ${selector.endpointType} 仅支持计费单位：${allowedUnits.join("、")}`,
    });
  }
  const isEnabledVideoTokenRule =
    selector.disabled === 0 &&
    selector.endpointType === "video_generation" &&
    selector.unit === "token" &&
    Boolean(allowedUnits?.includes(selector.unit));
  if (isEnabledVideoTokenRule) {
    if (selector.provider !== "volcano") {
      issues.push({
        path: ["provider"],
        message: "启用的视频 token 计费目前必须明确选择 volcano 供应商",
      });
    }
    if (readVideoTokenReservationUpperBound(ruleConfig) == null) {
      issues.push({
        path: ["ruleConfig", "reservationUpperBoundTokens"],
        message: "视频 token 计费必须配置正整数 reservationUpperBoundTokens，作为调用上游前的硬性预扣上限",
      });
    }
  }
  const parsedRuleConfig = ruleConfigObject(ruleConfig);
  if (parsedRuleConfig?.cacheWriteBillingMode !== undefined) {
    try {
      if(selector.endpointType !== "text") throw new Error("Only text rules support cache write billing");
      textCacheWriteBillingMode(parsedRuleConfig,selector.provider || "openai");
    } catch(error) {
      issues.push({path:["ruleConfig","cacheWriteBillingMode"],message:error instanceof Error ? error.message : "Invalid cache write billing"});
    }
  }
  if (parsedRuleConfig?.jwsOfficialPricing !== undefined) {
    try {
      jwsOfficialImagePolicy(parsedRuleConfig);
      if (selector.endpointType !== "image_generation" || selector.unit !== "image" || selector.provider !== "openai") throw Error("JWS 官方价仅支持 OpenAI 图片通道");
      if (parsedRuleConfig.pricingExpr || parsedRuleConfig.timePricing || (parsedRuleConfig.multiplier !== undefined && parsedRuleConfig.multiplier !== 1) || parsedRuleConfig.minimumMicros) throw Error("官方价不能叠加其他倍率或费用");
    } catch (error) {
      issues.push({path: ["ruleConfig", "jwsOfficialPricing"], message: error instanceof Error ? error.message : "Invalid official pricing"});
    }
  }
  if(parsedRuleConfig?.jwsUpstreamPricing !== undefined) {
    try {
      jwsImagePricePolicy(parsedRuleConfig);
      if(selector.endpointType!=="image_generation" || selector.unit!=="image" || (selector.provider && selector.provider!=="openai"))throw new Error("JWS direct pricing requires OpenAI image routes");
      if(parsedRuleConfig.pricingExpr || parsedRuleConfig.referenceImagePricing || parsedRuleConfig.timePricing || (parsedRuleConfig.multiplier!==undefined && Number(parsedRuleConfig.multiplier)!==1))throw new Error("JWS direct pricing cannot include additional markups");
    } catch(error) {
      issues.push({path:["ruleConfig","jwsUpstreamPricing"],message:error instanceof Error?error.message:"Invalid JWS pricing"});
    }
  }

  if (
    selector.disabled === 0
    && selector.endpointType === "video_generation"
    && (parsedRuleConfig?.videoInputPricing !== undefined || parsedRuleConfig?.videoResolutionPricing !== undefined)
  ) {
    try {
      resolveVideoInputPricing({
        ruleConfig,
        requestPayload: {},
        // Selector validation does not receive the rule's base price. A safe
        // placeholder still validates the complete two-tier contract because
        // configured tiers must carry their own positive integer prices.
        baseUnitPriceMicros: 1,
      });
    } catch (error) {
      issues.push({
        path: ["ruleConfig", "videoInputPricing"],
        message: `视频输入分档定价无效：${error instanceof Error ? error.message : "unknown"}`,
      });
    }
  }
  if (
    selector.disabled === 0
    && selector.endpointType === "text"
    && parsedRuleConfig?.cacheWriteAccounting !== undefined
  ) {
    try {
      parseCacheWriteAccountingContract(parsedRuleConfig);
    } catch (error) {
      issues.push({
        path: ["ruleConfig", "cacheWriteAccounting"],
        message: `cache storage 计费合同无效：${error instanceof Error ? error.message : "unknown"}`,
      });
    }
  }
  if (selector.scope === "workspace" && !selector.workspaceId) {
    issues.push({
      path: ["workspaceId"],
      message: "工作区范围的价格规则必须提供 workspaceId",
    });
  }
  issues.push(...validateTimePricingConfig(ruleConfig));
  return issues;
}

export async function pricingRuleWorkspaceExists(
  client: Knex | Knex.Transaction,
  selector: NormalizedPricingRuleSelector,
): Promise<boolean> {
  if (selector.scope !== "workspace" || !selector.workspaceId) return selector.scope === "platform";
  const workspace = await client("o_workspace")
    .where({ id: selector.workspaceId, status: "active" })
    .select("id")
    .first();
  return Boolean(workspace);
}

function sameOptionalValue(left: unknown, right: string | null): boolean {
  return optionalString(left) === right;
}

export async function findEnabledPricingRuleSelectorDuplicate(
  client: Knex | Knex.Transaction,
  selector: NormalizedPricingRuleSelector,
  excludeId?: string,
): Promise<string | null> {
  if (selector.disabled !== 0) return null;

  const query = client("o_pricing_rule")
    .where({
      scope: selector.scope,
      endpointType: selector.endpointType,
      unit: selector.unit,
      disabled: 0,
    })
    .select("id", "workspaceId", "provider", "model");
  if (excludeId) query.whereNot("id", excludeId);

  const rows = await query;
  const duplicate = rows.find((row: Record<string, unknown>) => {
    const workspaceMatches = selector.scope === "platform"
      ? true
      : sameOptionalValue(row.workspaceId, selector.workspaceId);
    return (
      workspaceMatches &&
      sameOptionalValue(row.provider, selector.provider) &&
      sameOptionalValue(row.model, selector.model)
    );
  });
  return duplicate ? trimmedString((duplicate as Record<string, unknown>).id) : null;
}

// SQLite test/development deployments run in one Node process. Serializing the
// selector check and write closes the read-then-insert race there. PostgreSQL
// additionally takes a transaction-scoped table lock in each route, covering
// multiple API processes without adding a unique index that could break on
// legacy duplicate rows.
let pricingRuleMutationTail: Promise<void> = Promise.resolve();

export async function serializePricingRuleMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = pricingRuleMutationTail;
  let release = () => {};
  pricingRuleMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function lockPricingRuleTableForMutation(client: Knex.Transaction): Promise<void> {
  const dialect = String(client.client.config.client || "").toLowerCase();
  if (dialect === "pg" || dialect === "postgres" || dialect === "postgresql") {
    await client.raw('LOCK TABLE "o_pricing_rule" IN SHARE ROW EXCLUSIVE MODE');
  }
}
