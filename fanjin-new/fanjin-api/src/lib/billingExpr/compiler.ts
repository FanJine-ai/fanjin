/**
 * 表达式编译器 — 白名单 AST 解析 + LRU 缓存
 *
 * P0 修复：不再使用正则黑名单 + vm2 执行。compileExpr 现在调用
 * parser.parseExpr 做严格白名单解析（变量/函数/字面量/运算符全集
 * 在解析期定死），非法标识符与语法错误在编译期直接拒绝。
 *
 * 表达式语法示例：
 *   p*0.002 + c*0.006                     — 文本分价
 *   cr*0.0002 + (p-cr)*0.002 + c*0.006    — 带缓存读取
 *   img*0.05                              — 图片按 token
 *   max(img*0.05, 50000)                  — 图片有底价
 *   tier("480p", 200000) + tier("1080p", 500000)  — 视频分档
 */

import { createHash } from "crypto";
import { BILLING_EXPR_LIMITS, parseExpr } from "./parser";
import type { CompiledExpr } from "./types";

/** LRU 缓存，key = SHA-256(expr) */
const cache = new Map<string, CompiledExpr>();
const CACHE_MAX = 500;

/**
 * 编译定价表达式。返回缓存的 CompiledExpr。
 * 表达式必须是纯数学表达式，只能使用允许的变量和函数。
 */
export function compileExpr(expr: string): CompiledExpr {
  if (expr.length > BILLING_EXPR_LIMITS.maxSourceLength) {
    throw new Error(`pricingExpr 长度超过限制 (${BILLING_EXPR_LIMITS.maxSourceLength})`);
  }
  const trimmed = expr.trim();
  if (!trimmed) throw new Error("pricingExpr 不能为空");

  const hash = sha256(trimmed);
  const cached = cache.get(hash);
  if (cached) return cached;

  // 严格白名单解析：不允许的标识符/保留字/成员访问/语法错误在此拦截。
  const ast = parseExpr(trimmed);

  const compiled: CompiledExpr = {
    ast,
    hash,
    expr: trimmed,
  };

  // LRU：超限则删除最旧的
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(hash, compiled);
  return compiled;
}

/** 清空编译缓存（测试用） */
export function clearExprCache(): void {
  cache.clear();
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
