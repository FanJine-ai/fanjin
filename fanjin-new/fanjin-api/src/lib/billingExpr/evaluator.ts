/**
 * 表达式执行器 — 白名单 AST 解释执行
 *
 * P0 修复：替代 vm2 沙箱执行。compiler 已把表达式解析为受限 AST，
 * 这里直接遍历求值：变量来自 token 参数，函数是固定白名单实现，
 * 不执行任何用户代码，不存在沙箱逃逸面。
 *
 * 环境变量与 NewAPI 对齐：p, c, len, cr, cc, cc1h, img, img_o, ai, ao；
 * t 是旧候选/迁移表达式使用的总 token 兼容别名。
 */

import { BILLING_EXPR_LIMITS, type ExprNode } from "./parser";
import type { CompiledExpr, ExprResult, TokenParams } from "./types";

export interface PricingEvaluationContext {
  /** Freeze expression time for reservation/settlement parity and deterministic tests. */
  evaluatedAt?: number | Date;
}

function dateInZone(value: number | Date | undefined, timezone: unknown): {
  hour: number;
  minute: number;
  weekday: number;
  month: number;
  day: number;
} {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  const requestedTimezone = typeof timezone === "string" ? timezone.trim() : "";
  const timeZone = requestedTimezone || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      hour: Number(values.hour || 0),
      minute: Number(values.minute || 0),
      weekday: Math.max(0, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday)),
      month: Number(values.month || 1),
      day: Number(values.day || 1),
    };
  } catch {
    return {
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      weekday: date.getUTCDay(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
}

type EvalValue = number | string | boolean | null;

interface EvalState {
  matchedTier: string | null;
  evaluatedNodes: number;
}

function isTruthy(value: EvalValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  return false;
}

function toNumber(value: EvalValue, detail: string): number {
  if (typeof value !== "number") {
    throw new Error(`pricingExpr 执行失败: ${detail} 需要数值`);
  }
  return value;
}

function totalTokenValue(params: TokenParams): number {
  if (typeof params.t === "number") return params.t;
  if (params.len > 0) return params.len;
  return params.p + params.c;
}

function evaluate(
  node: ExprNode,
  params: TokenParams,
  state: EvalState,
  context: PricingEvaluationContext,
  depth = 1,
): EvalValue {
  if (depth > BILLING_EXPR_LIMITS.maxAstDepth) {
    throw new Error(`pricingExpr 执行失败: AST 递归深度超过限制 (${BILLING_EXPR_LIMITS.maxAstDepth})`);
  }
  state.evaluatedNodes += 1;
  if (state.evaluatedNodes > BILLING_EXPR_LIMITS.maxAstNodes) {
    throw new Error(`pricingExpr 执行失败: AST 节点数量超过限制 (${BILLING_EXPR_LIMITS.maxAstNodes})`);
  }
  switch (node.kind) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "variable": {
      if (node.name === "t") return totalTokenValue(params);
      const value = params[node.name as keyof TokenParams];
      if (typeof value !== "number") {
        throw new Error(`pricingExpr 执行失败: 变量 ${node.name} 缺少数值`);
      }
      return value;
    }
    case "unary": {
      const operand = evaluate(node.operand, params, state, context, depth + 1);
      if (node.op === "!") return !isTruthy(operand);
      const value = toNumber(operand, "一元运算");
      return node.op === "-" ? -value : value;
    }
    case "binary": {
      const left = toNumber(evaluate(node.left, params, state, context, depth + 1), "算术运算");
      const right = toNumber(evaluate(node.right, params, state, context, depth + 1), "算术运算");
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "%": return left % right;
      }
      break;
    }
    case "compare": {
      const left = evaluate(node.left, params, state, context, depth + 1);
      const right = evaluate(node.right, params, state, context, depth + 1);
      switch (node.op) {
        case ">": return toNumber(left, "比较运算") > toNumber(right, "比较运算");
        case ">=": return toNumber(left, "比较运算") >= toNumber(right, "比较运算");
        case "<": return toNumber(left, "比较运算") < toNumber(right, "比较运算");
        case "<=": return toNumber(left, "比较运算") <= toNumber(right, "比较运算");
        case "===": return left === right;
        case "!==": return left !== right;
        case "==": return left == right; // eslint-disable-line eqeqeq
        case "!=": return left != right; // eslint-disable-line eqeqeq
      }
      break;
    }
    case "logical": {
      const left = evaluate(node.left, params, state, context, depth + 1);
      if (node.op === "&&") {
        return isTruthy(left) ? evaluate(node.right, params, state, context, depth + 1) : left;
      }
      return isTruthy(left) ? left : evaluate(node.right, params, state, context, depth + 1);
    }
    case "conditional": {
      const test = evaluate(node.test, params, state, context, depth + 1);
      return isTruthy(test)
        ? evaluate(node.consequent, params, state, context, depth + 1)
        : evaluate(node.alternate, params, state, context, depth + 1);
    }
    case "call":
      return evaluateCall(node.name, node.args, params, state, context, depth);
  }
  throw new Error("pricingExpr 执行失败: 未知表达式节点");
}

function evaluateCall(
  name: string,
  args: readonly ExprNode[],
  params: TokenParams,
  state: EvalState,
  context: PricingEvaluationContext,
  depth: number,
): EvalValue {
  const evaluated = args.map((arg) => evaluate(arg, params, state, context, depth + 1));
  switch (name) {
    case "tier": {
      const tierName = String(evaluated[0]);
      const value = toNumber(evaluated[1], "tier 调用");
      state.matchedTier = tierName;
      return value;
    }
    case "max": return Math.max(...evaluated.map((value) => toNumber(value, "max 调用")));
    case "min": return Math.min(...evaluated.map((value) => toNumber(value, "min 调用")));
    case "abs": return Math.abs(toNumber(evaluated[0], "abs 调用"));
    case "ceil": return Math.ceil(toNumber(evaluated[0], "ceil 调用"));
    case "floor": return Math.floor(toNumber(evaluated[0], "floor 调用"));
    case "hour": return dateInZone(context.evaluatedAt, evaluated[0]).hour;
    case "minute": return dateInZone(context.evaluatedAt, evaluated[0]).minute;
    case "weekday": return dateInZone(context.evaluatedAt, evaluated[0]).weekday;
    case "month": return dateInZone(context.evaluatedAt, evaluated[0]).month;
    case "day": return dateInZone(context.evaluatedAt, evaluated[0]).day;
    // 占位（保持表达式兼容，不允许实际调用）
    case "header": return "";
    case "param": return null;
    case "has": return false;
  }
  throw new Error(`pricingExpr 执行失败: 未知函数 ${name}`);
}

/**
 * 解释执行已编译的定价表达式 AST。
 *
 * @param compiled  编译结果
 * @param params    上游返回的 token 用量
 * @param groupRatio 分组倍率（默认 1）
 * @returns 费用（micros）和 tier 信息
 */
export function computeExprCost(
  compiled: CompiledExpr,
  params: TokenParams,
  groupRatio = 1,
  context: PricingEvaluationContext = {},
): ExprResult {
  const state: EvalState = { matchedTier: null, evaluatedNodes: 0 };

  let raw: unknown;
  try {
    raw = evaluate(compiled.ast, params, state, context);
  } catch (err: any) {
    if (err instanceof Error && err.message.startsWith("pricingExpr 执行失败")) throw err;
    throw new Error(`pricingExpr 执行失败: ${err?.message || err}`);
  }

  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`pricingExpr 返回了非数值: ${String(raw)}`);
  }

  const costMicros = Math.round(raw * groupRatio);

  return {
    costMicros: costMicros < 0 ? 0 : costMicros,
    matchedTier: state.matchedTier,
  };
}
