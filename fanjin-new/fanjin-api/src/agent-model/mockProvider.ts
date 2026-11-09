/**
 * 测试用 Provider。不调用外部，按预设队列产出 ChatChunk。
 */
import type { ModelProvider } from "./provider";
import type {
  ChatMessage, ChatChunk, ToolSchema, ChatOptions,
  ToolCall, TokenUsage, FinishReason, ModelMetadata,
} from "./types";

/** Mock 响应预设 */
export interface MockResponse {
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: FinishReason;
  usage?: TokenUsage;
  delayMs?: number;
}

/** MockProvider 配置 */
export interface MockProviderConfig {
  modelId?: string;
  responses?: MockResponse[];      // 队列，循环取用
  defaultResponse?: MockResponse;
}

/** 测试用模型供应商：按预设队列产出 ChatChunk，不做任何网络/DB 调用 */
export class MockModelProvider implements ModelProvider {
  readonly metadata: ModelMetadata;
  private readonly responses: MockResponse[];
  private callCount = 0;

  constructor(config: MockProviderConfig = {}) {
    this.metadata = {
      modelId: config.modelId ?? "mock-model",
      provider: "mock",
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsVision: false,
    };
    this.responses = config.responses ?? [config.defaultResponse ?? { content: "mock", finishReason: "stop" }];
  }

  async *chat(_m: ChatMessage[], _t: ToolSchema[], _o?: ChatOptions): AsyncIterableIterator<ChatChunk> {
    const res = this.responses[this.callCount % this.responses.length];
    this.callCount++;

    if (res.delayMs && res.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, res.delayMs));
    }

    const baseChunk: Omit<ChatChunk, "delta" | "finishReason" | "usage"> = {
      id: `mock-${this.callCount}`,
      model: this.metadata.modelId,
    };

    // 有 content 则产内容块
    if (res.content) {
      yield {
        ...baseChunk,
        delta: { role: "assistant", content: res.content },
      };
    }

    // 有 toolCalls 则产工具块
    if (res.toolCalls && res.toolCalls.length > 0) {
      yield {
        ...baseChunk,
        delta: { role: "assistant", toolCalls: res.toolCalls },
      };
    }

    // 末尾块：finishReason（默认 stop），usage 挂末尾
    yield {
      ...baseChunk,
      delta: {},
      finishReason: res.finishReason ?? "stop",
      usage: res.usage ?? { inputTokens: 10, outputTokens: 5, cacheTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
    };
  }

  /** 从 chunk 中提取工具调用列表 */
  parseToolCalls(chunk: ChatChunk): ToolCall[] { return chunk.delta.toolCalls ?? []; }
  /** 从 chunk 中提取 token 用量 */
  getUsage(chunk: ChatChunk): TokenUsage | null { return chunk.usage ?? null; }
  /** 从 chunk 中提取停止原因 */
  getFinishReason(chunk: ChatChunk): FinishReason { return chunk.finishReason ?? null; }

  /** 重置调用计数（测试用） */
  resetCallCount(): void { this.callCount = 0; }
}
