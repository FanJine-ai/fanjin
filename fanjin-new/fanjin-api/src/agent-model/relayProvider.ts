/**
 * 生产 Provider：包装 executeRelayChat。
 * 只做协议适配（agent-model 类型 <-> relay 请求/SSE），不碰计费与通道。
 */
import { executeRelayChat } from "@/lib/relayChat";
import type { RelayChatRequest, RelayChatContext, ChatMessage as RelayChatMessage } from "@/lib/relayChat";
import type { ModelProvider } from "./provider";
import type {
  ChatMessage, ChatChunk, ToolSchema, ChatOptions,
  ToolCall, TokenUsage, FinishReason, ModelMetadata,
} from "./types";
import { parseRelaySseStream, mapOpenAiChunk } from "./sseParser";

/** RelayModelProvider 配置 */
export interface RelayProviderConfig {
  modelId: string;
  /** 直接透传给 RelayChatContext，字段与 relayChat.ts 完全一致 */
  relayContext: RelayChatContext;
  metadata?: Partial<ModelMetadata>;
}

/** 生产环境模型供应商：包装 executeRelayChat，只做协议适配 */
export class RelayModelProvider implements ModelProvider {
  readonly metadata: ModelMetadata;
  private readonly config: RelayProviderConfig;

  constructor(config: RelayProviderConfig) {
    this.config = config;
    this.metadata = {
      modelId: config.modelId,
      provider: "relay",
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsVision: true,
      ...config.metadata,
    };
  }

  async *chat(
    messages: ChatMessage[],
    tools: ToolSchema[],
    options: ChatOptions = {},
  ): AsyncIterableIterator<ChatChunk> {
    const request: RelayChatRequest = {
      model: this.config.modelId,
      messages: this.toRelayMessages(messages),
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? options.toolChoice ?? "auto" : undefined,
      temperature: options.temperature,
      max_tokens: options.maxTokens ?? this.metadata.maxOutputTokens,
      top_p: options.topP,
      presence_penalty: options.presencePenalty,
      frequency_penalty: options.frequencyPenalty,
      stop: options.stop,
      stream: true,
      stream_options: { include_usage: true },
    };

    const result = await executeRelayChat(request, this.config.relayContext);

    if (result.stream) {
      yield* parseRelaySseStream(result.stream, this.config.modelId);
      return;
    }
    // 非流式兜底：把完整 response 转成单个 ChatChunk
    // 非流式响应的 choices[0] 用 message 字段而非 delta，需转换
    if (result.response) {
      const choices = result.response.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const choice = choices[0];
        const deltaChoice = {
          ...choice,
          delta: choice.message ?? choice.delta ?? {},
          finish_reason: choice.finish_reason ?? choice.delta?.finish_reason,
        };
        const chunk = mapOpenAiChunk(
          { ...result.response, choices: [deltaChoice] },
          this.config.modelId,
        );
        if (chunk) yield chunk;
      }
      return;
    }
    throw new Error("relay 返回既无 stream 也无 response");
  }

  /** 从 chunk 中提取工具调用列表 */
  parseToolCalls(chunk: ChatChunk): ToolCall[] {
    return chunk.delta.toolCalls ?? [];
  }

  /** 从 chunk 中提取 token 用量 */
  getUsage(chunk: ChatChunk): TokenUsage | null {
    return chunk.usage ?? null;
  }

  /** 从 chunk 中提取停止原因 */
  getFinishReason(chunk: ChatChunk): FinishReason {
    return chunk.finishReason ?? null;
  }

  /** agent-model ChatMessage → relay ChatMessage（content/toolCalls 结构映射） */
  private toRelayMessages(messages: ChatMessage[]): RelayChatMessage[] {
    return messages.map((msg) => {
      const relay: RelayChatMessage = {
        role: msg.role,
        content: msg.content,
      };

      // assistant + toolCalls → tool_calls
      if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        (relay as unknown as Record<string, unknown>).tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
        }));
      }

      // tool 结果 → tool_call_id
      if (msg.role === "tool" && msg.toolCallId) {
        (relay as unknown as Record<string, unknown>).tool_call_id = msg.toolCallId;
      }

      // name 字段透传
      if (msg.name) {
        (relay as unknown as Record<string, unknown>).name = msg.name;
      }

      return relay;
    });
  }
}
