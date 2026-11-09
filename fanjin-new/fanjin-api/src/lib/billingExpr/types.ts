/**
 * 表达式计费类型定义
 *
 * 对齐 NewAPI billingexpr 模块，所有模态共享同一套 TokenParams。
 */

/** 所有 token 维度 — 上游 usage 映射目标 */
export interface TokenParams {
  /** 文本 prompt tokens（已含 cachedTokens，OpenAI 语义） */
  p: number;
  /** 文本 completion tokens */
  c: number;
  /** 总输入上下文长度（用于 tier 条件，不扣除缓存） */
  len: number;
  /**
   * 总 token 数（旧候选/迁移表达式兼容别名）。调用方未显式提供时，
   * evaluator 会优先使用 len，再回落到 p + c。
   */
  t?: number;
  /** 缓存读取（命中）tokens */
  cr: number;
  /** 缓存创建 tokens（5 分钟 TTL） */
  cc: number;
  /** 缓存创建 tokens — 1 小时 TTL（仅 Claude） */
  cc1h: number;
  /** 图片输入 tokens */
  img: number;
  /** 图片输出 tokens */
  img_o: number;
  /** 音频输入 tokens */
  ai: number;
  /** 音频输出 tokens */
  ao: number;
}

/** 创建全零 TokenParams */
export function emptyTokenParams(): TokenParams {
  return { p: 0, c: 0, len: 0, cr: 0, cc: 0, cc1h: 0, img: 0, img_o: 0, ai: 0, ao: 0 };
}

/** 从上游 OpenAI 格式 usage 构造 TokenParams */
export function tokenParamsFromOpenAIUsage(usage: {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
    text_tokens?: number;
    image_tokens?: number;
    audio_tokens?: number;
  };
  completion_tokens_details?: {
    text_tokens?: number;
    image_tokens?: number;
    audio_tokens?: number;
  };
}): TokenParams {
  const pt = usage.prompt_tokens_details;
  const ct = usage.completion_tokens_details;
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  return {
    p: promptTokens,
    c: completionTokens,
    len: promptTokens,
    t: usage.total_tokens ?? (promptTokens + completionTokens),
    cr: pt?.cached_tokens || 0,
    cc: pt?.cache_creation_tokens || 0,
    cc1h: 0,
    img: pt?.image_tokens || 0,
    img_o: ct?.image_tokens || 0,
    ai: pt?.audio_tokens || 0,
    ao: ct?.audio_tokens || 0,
  };
}

/** 合并部分参数到默认值 */
export function mergeTokenParams(partial?: Partial<TokenParams>): TokenParams {
  const base = emptyTokenParams();
  if (!partial) return base;
  return { ...base, ...partial };
}

/** 表达式编译结果 */
export interface CompiledExpr {
  /** 白名单解析产物（P0 修复：替代 vm2 执行，改为 AST 解释） */
  ast: import("./parser").ExprNode;
  /** SHA-256 哈希 */
  hash: string;
  /** 原始表达式 */
  expr: string;
}

/** 表达式结算结果 */
export interface ExprResult {
  /** 最终费用（micros） */
  costMicros: number;
  /** 匹配的 tier 名称（无 tier 时为 null） */
  matchedTier: string | null;
}
