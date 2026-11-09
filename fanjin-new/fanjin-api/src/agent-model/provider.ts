/**
 * ModelProvider 统一接口。
 * 实现者：RelayModelProvider（生产）、MockModelProvider（测试）。
 */
import type {
  ChatMessage, ChatChunk, ToolSchema, ChatOptions,
  ToolCall, TokenUsage, FinishReason, ModelMetadata,
} from "./types";

/** 模型供应商统一接口 */
export interface ModelProvider {
  readonly metadata: ModelMetadata;

  /**
   * 流式聊天。逐块产出统一 ChatChunk。
   * 失败时抛错（不吞错），由上层决定计费/重试语义。
   */
  chat(
    messages: ChatMessage[],
    tools: ToolSchema[],
    options?: ChatOptions,
  ): AsyncIterableIterator<ChatChunk>;

  /** 从 chunk 中提取工具调用列表 */
  parseToolCalls(chunk: ChatChunk): ToolCall[];
  /** 从 chunk 中提取 token 用量，无用量返回 null */
  getUsage(chunk: ChatChunk): TokenUsage | null;
  /** 从 chunk 中提取停止原因 */
  getFinishReason(chunk: ChatChunk): FinishReason;
}

/** 按 modelId 构造 ModelProvider 的工厂函数类型 */
export type ModelProviderFactory = (modelId: string) => ModelProvider;
