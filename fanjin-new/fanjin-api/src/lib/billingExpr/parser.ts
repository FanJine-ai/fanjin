/**
 * 定价表达式解析器 — 白名单 AST 解析，零代码执行
 *
 * P0 修复：替代 vm2 沙箱执行。表达式被解析为受限 AST（仅允许列出的
 * 变量与函数、字面量、算术/比较/逻辑/三元运算），由 evaluator 直接
 * 解释执行。任何未列入白名单的标识符、保留字、成员访问都会在解析期
 * 被拒绝，因此不存在沙箱逃逸面。
 *
 * 支持语法（与历史用法对齐）：
 *   p*0.002 + c*0.006
 *   max(img*50000, 100000)
 *   tier("480p", 200000) + tier("1080p", 500000)
 *   p * (hour("Asia/Shanghai") >= 22 || hour("Asia/Shanghai") < 6 ? 0.8 : 1)
 */

export type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: "-" | "+" | "!"; operand: ExprNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%"; left: ExprNode; right: ExprNode }
  | { kind: "compare"; op: ">" | ">=" | "<" | "<=" | "===" | "!==" | "==" | "!="; left: ExprNode; right: ExprNode }
  | { kind: "logical"; op: "&&" | "||"; left: ExprNode; right: ExprNode }
  | { kind: "conditional"; test: ExprNode; consequent: ExprNode; alternate: ExprNode }
  | { kind: "call"; name: string; args: readonly ExprNode[] };

/**
 * Hard parser/evaluator budgets. Pricing expressions are operator-authored but
 * still cross a persisted configuration boundary, so malformed rows must not
 * be able to consume unbounded CPU, memory, or call stack during a request.
 */
export const BILLING_EXPR_LIMITS = Object.freeze({
  maxSourceLength: 8_192,
  maxTokens: 2_048,
  maxAstNodes: 512,
  maxAstDepth: 64,
  maxStringLength: 512,
  maxFunctionArguments: 32,
});

/** 允许作为变量引用的 token 维度。 */
export const EXPR_VARIABLES: ReadonlySet<string> = new Set([
  "p", "c", "len", "t", "cr", "cc", "cc1h", "img", "img_o", "ai", "ao",
]);

/**
 * 允许调用的函数及其参数个数。
 *
 * max/min 在旧 VM 中接受任意数量实参；这里保留多实参能力但统一受 32
 * 个参数的硬上限约束。header/param/has 在旧 VM 中会忽略实参并返回占位
 * 值，允许 0 或 1 个实参可兼容既有 `header("key")` 一类表达式，同时拒绝
 * 无意义的大参数列表。
 */
export const EXPR_FUNCTIONS: ReadonlyMap<string, { min: number; max: number }> = new Map([
  ["tier", { min: 2, max: 2 }],
  ["max", { min: 1, max: BILLING_EXPR_LIMITS.maxFunctionArguments }],
  ["min", { min: 1, max: BILLING_EXPR_LIMITS.maxFunctionArguments }],
  ["abs", { min: 1, max: 1 }],
  ["ceil", { min: 1, max: 1 }],
  ["floor", { min: 1, max: 1 }],
  ["hour", { min: 1, max: 1 }],
  ["minute", { min: 1, max: 1 }],
  ["weekday", { min: 1, max: 1 }],
  ["month", { min: 1, max: 1 }],
  ["day", { min: 1, max: 1 }],
  ["header", { min: 0, max: 1 }],
  ["param", { min: 0, max: 1 }],
  ["has", { min: 0, max: 1 }],
]);

/** JS 保留字：出现即视为语法错误（而不是"不允许的标识符"）。 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "var", "let", "const", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "throw", "try", "catch",
  "finally", "new", "delete", "typeof", "instanceof", "in", "of", "class",
  "extends", "super", "this", "null", "true", "false", "yield", "await",
  "async", "with", "debugger", "void", "static", "get", "set", "enum",
  "implements", "interface", "package", "private", "protected", "public",
  "export", "import", "default",
]);

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "eof" };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pushToken = (token: Token): void => {
    if (tokens.length >= BILLING_EXPR_LIMITS.maxTokens) {
      throw new Error(`pricingExpr 超过 token 数量限制 (${BILLING_EXPR_LIMITS.maxTokens})`);
    }
    tokens.push(token);
  };
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    // 数字字面量（含小数与科学计数法）
    const numberMatch = /^(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (numberMatch) {
      const text = numberMatch[0];
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`pricingExpr 语法错误: 无效数字 ${text}`);
      pushToken({ type: "number", value });
      index += text.length;
      continue;
    }
    // 字符串字面量
    if (ch === '"' || ch === "'") {
      const quote = ch;
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === "\\") {
          const next = source[index + 1];
          if (next === undefined) break;
          const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
          value += escapes[next] ?? next;
          if (value.length > BILLING_EXPR_LIMITS.maxStringLength) {
            throw new Error(`pricingExpr 字符串长度超过限制 (${BILLING_EXPR_LIMITS.maxStringLength})`);
          }
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        value += current;
        if (value.length > BILLING_EXPR_LIMITS.maxStringLength) {
          throw new Error(`pricingExpr 字符串长度超过限制 (${BILLING_EXPR_LIMITS.maxStringLength})`);
        }
        index += 1;
      }
      if (!closed) throw new Error("pricingExpr 语法错误: 字符串未闭合");
      pushToken({ type: "string", value });
      continue;
    }
    // 标识符 / 保留字
    const identMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
    if (identMatch) {
      pushToken({ type: "ident", value: identMatch[0] });
      index += identMatch[0].length;
      continue;
    }
    // 多字符运算符优先
    const multiOps = ["===", "!==", ">=", "<=", "&&", "||", "==", "!="];
    const multi = multiOps.find((op) => source.startsWith(op, index));
    if (multi) {
      pushToken({ type: "op", value: multi });
      index += multi.length;
      continue;
    }
    if ("+-*/%()?:,><!.".includes(ch)) {
      pushToken({ type: "op", value: ch });
      index += 1;
      continue;
    }
    throw new Error(`pricingExpr 语法错误: 无法识别的字符 ${JSON.stringify(ch)}`);
  }
  tokens.push({ type: "eof" });
  return tokens;
}

class ExprParser {
  private index = 0;
  private nodeCount = 0;
  private nestedParseDepth = 0;
  private readonly nodeDepths = new WeakMap<object, number>();

  constructor(private readonly tokens: Token[]) {}

  private makeNode<T extends ExprNode>(node: T, children: readonly ExprNode[] = []): T {
    this.nodeCount += 1;
    if (this.nodeCount > BILLING_EXPR_LIMITS.maxAstNodes) {
      throw new Error(`pricingExpr AST 节点数量超过限制 (${BILLING_EXPR_LIMITS.maxAstNodes})`);
    }
    const depth = 1 + children.reduce(
      (maximum, child) => Math.max(maximum, this.nodeDepths.get(child) ?? 1),
      0,
    );
    if (depth > BILLING_EXPR_LIMITS.maxAstDepth) {
      throw new Error(`pricingExpr AST 递归深度超过限制 (${BILLING_EXPR_LIMITS.maxAstDepth})`);
    }
    Object.freeze(node);
    this.nodeDepths.set(node, depth);
    return node;
  }

  private parseNested<T>(parse: () => T): T {
    this.nestedParseDepth += 1;
    if (this.nestedParseDepth > BILLING_EXPR_LIMITS.maxAstDepth) {
      this.nestedParseDepth -= 1;
      throw new Error(`pricingExpr 解析递归深度超过限制 (${BILLING_EXPR_LIMITS.maxAstDepth})`);
    }
    try {
      return parse();
    } finally {
      this.nestedParseDepth -= 1;
    }
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private peekOp(value: string): boolean {
    const token = this.peek();
    return token.type === "op" && token.value === value;
  }

  private peekOpAny(values: readonly string[]): boolean {
    const token = this.peek();
    return token.type === "op" && values.includes(token.value);
  }

  private advance(): Token {
    const token = this.tokens[this.index];
    if (token.type !== "eof") this.index += 1;
    return token;
  }

  /** 消费一个运算符 token 并返回其值（调用前必须已用 peekOp/peekOpAny 确认）。 */
  private consumeOp(): string {
    const token = this.advance();
    if (token.type !== "op") throw new Error("pricingExpr 语法错误: 期望运算符");
    return token.value;
  }

  private expectOp(value: string): void {
    const token = this.peek();
    if (token.type !== "op" || token.value !== value) {
      throw new Error(`pricingExpr 语法错误: 期望 ${JSON.stringify(value)}`);
    }
    this.advance();
  }

  parse(): ExprNode {
    const node = this.parseConditional();
    if (this.peek().type !== "eof") {
      throw new Error("pricingExpr 语法错误: 表达式末尾存在多余内容");
    }
    return node;
  }

  private parseConditional(): ExprNode {
    const test = this.parseLogicalOr();
    if (this.peekOp("?")) {
      this.advance();
      const consequent = this.parseNested(() => this.parseConditional());
      this.expectOp(":");
      const alternate = this.parseNested(() => this.parseConditional());
      return this.makeNode(
        { kind: "conditional", test, consequent, alternate },
        [test, consequent, alternate],
      );
    }
    return test;
  }

  private parseLogicalOr(): ExprNode {
    let left = this.parseLogicalAnd();
    while (this.peekOp("||")) {
      this.advance();
      const right = this.parseLogicalAnd();
      left = this.makeNode({ kind: "logical", op: "||", left, right }, [left, right]);
    }
    return left;
  }

  private parseLogicalAnd(): ExprNode {
    let left = this.parseEquality();
    while (this.peekOp("&&")) {
      this.advance();
      const right = this.parseEquality();
      left = this.makeNode({ kind: "logical", op: "&&", left, right }, [left, right]);
    }
    return left;
  }

  private parseEquality(): ExprNode {
    let left = this.parseRelational();
    while (this.peekOpAny(["===", "!==", "==", "!="])) {
      const op = this.consumeOp() as "===" | "!==" | "==" | "!=";
      const right = this.parseRelational();
      left = this.makeNode({ kind: "compare", op, left, right }, [left, right]);
    }
    return left;
  }

  private parseRelational(): ExprNode {
    let left = this.parseAdditive();
    while (this.peekOpAny([">", ">=", "<", "<="])) {
      const op = this.consumeOp() as ">" | ">=" | "<" | "<=";
      const right = this.parseAdditive();
      left = this.makeNode({ kind: "compare", op, left, right }, [left, right]);
    }
    return left;
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    while (this.peekOpAny(["+", "-"])) {
      const op = this.consumeOp() as "+" | "-";
      const right = this.parseMultiplicative();
      left = this.makeNode({ kind: "binary", op, left, right }, [left, right]);
    }
    return left;
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    while (this.peekOpAny(["*", "/", "%"])) {
      const op = this.consumeOp() as "*" | "/" | "%";
      const right = this.parseUnary();
      left = this.makeNode({ kind: "binary", op, left, right }, [left, right]);
    }
    return left;
  }

  private parseUnary(): ExprNode {
    const token = this.peek();
    if (token.type === "op" && ["-", "+", "!"].includes(token.value)) {
      this.advance();
      const operand = this.parseNested(() => this.parseUnary());
      return this.makeNode(
        { kind: "unary", op: token.value as "-" | "+" | "!", operand },
        [operand],
      );
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();
    if (token.type === "number") {
      this.advance();
      return this.makeNode({ kind: "number", value: token.value });
    }
    if (token.type === "string") {
      this.advance();
      return this.makeNode({ kind: "string", value: token.value });
    }
    if (token.type === "op" && token.value === "(") {
      this.advance();
      const inner = this.parseNested(() => this.parseConditional());
      this.expectOp(")");
      return inner;
    }
    if (token.type === "ident") {
      this.advance();
      const name = token.value;
      if (RESERVED_WORDS.has(name)) {
        throw new Error(`pricingExpr 语法错误: 不允许的关键字 ${name}`);
      }
      if (EXPR_VARIABLES.has(name)) {
        return this.makeNode({ kind: "variable", name });
      }
      const fn = EXPR_FUNCTIONS.get(name);
      if (!fn) {
        throw new Error(`pricingExpr 包含不允许的标识符: ${name}`);
      }
      this.expectOp("(");
      const args: ExprNode[] = [];
      if (!this.peekOp(")")) {
        args.push(this.parseNested(() => this.parseConditional()));
        while (this.peekOp(",")) {
          this.advance();
          if (args.length >= BILLING_EXPR_LIMITS.maxFunctionArguments) {
            throw new Error(
              `pricingExpr 函数参数数量超过限制 (${BILLING_EXPR_LIMITS.maxFunctionArguments})`,
            );
          }
          args.push(this.parseNested(() => this.parseConditional()));
        }
      }
      this.expectOp(")");
      if (args.length < fn.min || args.length > fn.max) {
        throw new Error(`pricingExpr 语法错误: 函数 ${name} 参数个数不合法`);
      }
      const frozenArgs = Object.freeze([...args]);
      return this.makeNode({ kind: "call", name, args: frozenArgs }, frozenArgs);
    }
    throw new Error("pricingExpr 语法错误: 表达式不完整");
  }
}

/** 解析定价表达式为受限 AST；解析失败抛出中文错误（编译期拦截）。 */
export function parseExpr(source: string): ExprNode {
  if (source.length > BILLING_EXPR_LIMITS.maxSourceLength) {
    throw new Error(`pricingExpr 长度超过限制 (${BILLING_EXPR_LIMITS.maxSourceLength})`);
  }
  const tokens = tokenize(source);
  return new ExprParser(tokens).parse();
}
