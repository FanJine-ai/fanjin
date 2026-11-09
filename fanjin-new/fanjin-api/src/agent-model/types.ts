/**
 * Agent Model 层类型定义。
 * 职责：定义与供应商无关的统一模型 I/O 类型。
 * 依赖：无（纯类型）。
 */

/** 消息角色：系统 / 用户 / 助手 / 工具结果 */
export type AgentModelRole = "system" | "user" | "assistant" | "tool";

/** 多模态内容片段：纯文本或图片 URL */
export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "auto" | "low" | "high" };
}

/** 统一聊天消息 */
export interface ChatMessage {
  role: AgentModelRole;
  content: string | ChatContentPart[];
  /** assistant 发起的工具调用 */
  toolCalls?: ToolCall[];
  /** role === "tool" 时，对应的调用 id */
  toolCallId?: string;
  /** 可选名字（function/tool 名） */
  name?: string;
}

/** 单个工具调用 */
export interface ToolCall {
  /** OpenAI 流式 tool_calls 的增量槽位，上层按此合并并行调用。 */
  index?: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string /* JSON 字符串 */ };
}

/** 工具定义 schema */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>; // JSON Schema
    strict?: boolean;
  };
}

/** 停止原因 */
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;

/** Token 用量统计 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/**
 * 统一的流式增量块。一次 chat() 产出多个 delta，最后一个块带 finishReason，
 * usage 可能只出现在末尾（供应商差异由 Provider 内部吸收）。
 */
export interface ChatChunk {
  id: string;
  model: string;
  delta: {
    role?: "assistant";
    content?: string;
    toolCalls?: ToolCall[];
  };
  finishReason?: FinishReason;
  usage?: TokenUsage | null;
}

/** 聊天请求选项 */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string[];
  /** 透传 tool_choice；默认 auto */
  toolChoice?: unknown;
}

/** 模型元数据 */
export interface ModelMetadata {
  modelId: string;
  provider: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsToolCalls: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
}
