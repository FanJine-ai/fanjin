/**
 * 统一计费入口 — 自动选择表达式或旧逻辑
 *
 * 当 PricingRule.ruleConfig.pricingExpr 存在时走表达式计算，
 * 否则回退到 unitPriceMicros × units × multiplier（旧逻辑）。
 */

import { compileExpr } from "./compiler";
import { computeExprCost, type PricingEvaluationContext } from "./evaluator";
import type { ExprResult, TokenParams } from "./types";

/** 最小 PricingRule 接口 — 只取需要的字段，避免循环依赖 */
interface PricingRuleLike {
  unitPriceMicros: number;
  ruleConfig: Record<string, unknown>;
}

export interface ComputePricingInput {
  /** 定价规则 */
  rule: PricingRuleLike;
  /** Token 维度（表达式模式） */
  tokenParams?: Partial<TokenParams>;
  /** 单位数量（旧模式 fallback） */
  units?: number;
  /** 分组倍率（默认 1） */
  groupRatio?: number;
  /** 结算时间上下文，用于 hour/minute/weekday 等分时函数 */
  evaluationContext?: PricingEvaluationContext;
}

/**
 * 统一计费：有表达式走表达式，无表达式走旧逻辑。
 * 两种模式的成本计算结果保持相同精度（micros 整数）。
 */
export function computeUnifiedPricingCost(input: ComputePricingInput): ExprResult {
  const { rule, tokenParams, units = 1, groupRatio = 1, evaluationContext } = input;

  const pricingExpr = typeof rule.ruleConfig.pricingExpr === "string"
    ? rule.ruleConfig.pricingExpr.trim()
    : "";

  if (pricingExpr && tokenParams) {
    // ── 表达式模式：必须同时有 pricingExpr 和 tokenParams ──
    const compiled = compileExpr(pricingExpr);
    const merged: TokenParams = {
      p: 0, c: 0, len: 0, cr: 0, cc: 0, cc1h: 0, img: 0, img_o: 0, ai: 0, ao: 0,
      ...tokenParams,
    };
    return computeExprCost(compiled, merged, groupRatio, evaluationContext);
  }

  // ── 旧模式 fallback ──
  const safeUnits = Math.max(0, Math.round(units));
  const baseCost = rule.unitPriceMicros * safeUnits;
  const multiplier = Number(rule.ruleConfig.multiplier ?? 1) || 1;
  const adjustedCost = Math.round(baseCost * multiplier);
  const minimumMicros = Number(rule.ruleConfig.minimumMicros || 0);
  const costMicros = Math.max(
    adjustedCost,
    Number.isFinite(minimumMicros) ? minimumMicros : 0,
  );

  return { costMicros, matchedTier: null };
}

/**
 * 从 PricingRule 读取分组倍率。
 * 新增 ruleConfig.groupRatio 字段，默认 1。
 */
export function readGroupRatio(ruleConfig: Record<string, unknown>): number {
  const raw = Number(ruleConfig.groupRatio);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export { compileExpr, clearExprCache } from "./compiler";
export type { TokenParams, ExprResult, CompiledExpr } from "./types";
export { emptyTokenParams, mergeTokenParams, tokenParamsFromOpenAIUsage } from "./types";
