/**
 * Agent Core 契约类型。
 *
 * 从 agent-runtime/toolLoopProcessor.ts 搬来的「抽象缝」，
 * 是 core 与 runtime 之间的稳定边界。
 * 依赖：仅自身。禁止 knex / db / 任何 service / 任何 agent-runtime 运行时值。
 */

/** 多模态内容片段。与 AgentContentPart 结构等价。 */
export interface CoreContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** 单次工具调用（模型请求）。等价于 AgentToolLoopToolCall。 */
export interface CoreToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 单次工具结果（执行回填）。等价于 AgentToolLoopToolResult。 */
export interface CoreToolResult {
  callId: string;
  name: string;
  stepId: string;
  output: unknown;
}

/** 模型一轮的产出：要么请求工具，要么给出终稿。等价于 AgentToolLoopModelResult。 */
export type CoreModelResult =
  | { kind: "tool_calls"; calls: CoreToolCall[]; assistantText?: string }
  | { kind: "final"; content: CoreContentPart[] };

/** 对话轨迹项。等价于 AgentToolLoopTranscriptItem。 */
export type CoreTranscriptItem =
  | { role: "user"; content: CoreContentPart[] }
  | { role: "assistant"; text: string; toolCalls: CoreToolCall[] }
  | { role: "tool"; callId: string; name: string; output: unknown };

/** core 决策所需的字节/轮次上限。纯配置，无默认——由调用方显式传入。 */
export interface CoreLoopLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxArgumentBytes: number;
  maxResultBytes: number;
  maxFinalTextBytes: number;
}

/** 单个工具的授权/风险元数据（从 manifest 物化而来）。 */
export interface CoreToolMeta {
  name: string;
  riskClass: "R0" | "R1" | "R2" | "R3" | "R4";
  mutatesState: boolean;
  metered: boolean;
}
