import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RelayChatContext } from "@/lib/relayChat";

// 在 vitest mock 之前声明，后续通过 vi.mocked 访问
const mockExecuteRelayChat = vi.fn();

vi.mock("@/lib/relayChat", () => ({
  executeRelayChat: (...args: unknown[]) => mockExecuteRelayChat(...args),
}));

import { RelayModelProvider } from "@/agent-model/relayProvider";
import type { ChatMessage as AgentChatMessage, ToolSchema as AgentToolSchema } from "@/agent-model/types";

const dummyContext: RelayChatContext = {
  workspaceId: "ws-1",
  apiKeyId: "key-1",
  principalId: "user-1",
  channelId: "ch-1",
  requestId: "req-1",
  idempotencyKey: "idem-1",
};

function makeSseStream(events: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

const emptyMessages: AgentChatMessage[] = [{ role: "user", content: "hi" }];
const emptyTools: AgentToolSchema[] = [];

/** 收集 async iterator 所有产出 */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) items.push(item);
  return items;
}

describe("RelayModelProvider", () => {
  beforeEach(() => {
    mockExecuteRelayChat.mockReset();
  });

  it("流式模式：正确解析 SSE 字节流产出 ChatChunk", async () => {
    const sseEvents = [
      'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"content":" there"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join("");

    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream(sseEvents),
    });

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    const text = chunks.map(c => c.delta.content ?? "").join("");
    expect(text).toBe("Hi there");
    expect(chunks.at(-1)?.finishReason).toBe("stop");
  });

  it("流式模式：并行 tool_calls 的 index 穿过 Provider 保留", async () => {
    const sseEvents = [
      'data: {"id":"c-tools","model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"tool_b","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c-tools","model":"gpt-4o","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ].join("");
    mockExecuteRelayChat.mockResolvedValue({ stream: makeSseStream(sseEvents) });
    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks.flatMap((chunk) => chunk.delta.toolCalls ?? [])[0]).toMatchObject({
      index: 1,
      id: "call_2",
      function: { name: "tool_b" },
    });
  });

  it("非流式模式：response 映射为单块 ChatChunk", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      response: {
        id: "resp-1",
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "Sure thing" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].delta.content).toBe("Sure thing");
    expect(chunks[0].finishReason).toBe("stop");
    expect(chunks[0].usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("构造正确的 RelayChatRequest（stream + stream_options）", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream('data: [DONE]\n\n'),
    });

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    await collect(provider.chat(emptyMessages, emptyTools));

    expect(mockExecuteRelayChat).toHaveBeenCalledTimes(1);
    const [request, ctx] = mockExecuteRelayChat.mock.calls[0];
    expect(request.stream).toBe(true);
    expect(request.stream_options).toEqual({ include_usage: true });
    expect(request.model).toBe("gpt-4o");
    expect(ctx).toEqual(dummyContext);
  });

  it("toRelayMessages：assistant toolCalls 映射为 tool_calls", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream('data: [DONE]\n\n'),
    });

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    const messages: AgentChatMessage[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "tool_a", arguments: "{}" } }],
      },
      { role: "tool", content: "result", toolCallId: "call_1" },
    ];

    await collect(provider.chat(messages, emptyTools));

    expect(mockExecuteRelayChat).toHaveBeenCalledTimes(1);
    const [request] = mockExecuteRelayChat.mock.calls[0];
    // 验证 messages 被正确映射
    expect(request.messages).toHaveLength(3);
    // assistant 消息带 tool_calls
    expect(request.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "tool_a", arguments: "{}" } }],
    });
    // tool 消息带 tool_call_id
    expect(request.messages[2]).toMatchObject({
      role: "tool",
      content: "result",
      tool_call_id: "call_1",
    });
  });

  it("工具定义传入时设置 tool_choice=auto", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream('data: [DONE]\n\n'),
    });

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    const tools: AgentToolSchema[] = [{
      type: "function",
      function: {
        name: "search",
        description: "Search the web",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    }];

    await collect(provider.chat(emptyMessages, tools));

    const [request] = mockExecuteRelayChat.mock.calls[0];
    expect(request.tools).toEqual(tools);
    expect(request.tool_choice).toBe("auto");
  });

  it("不传工具时 tools 和 tool_choice 为 undefined", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream('data: [DONE]\n\n'),
    });

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    await collect(provider.chat(emptyMessages, []));

    const [request] = mockExecuteRelayChat.mock.calls[0];
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
  });

  it("relay 抛错时原样上抛，不 catch", async () => {
    const error = new Error("relay failed") as Error & { statusCode: number; upstreamMayHaveAccepted: boolean };
    error.statusCode = 502;
    error.upstreamMayHaveAccepted = true;
    mockExecuteRelayChat.mockRejectedValue(error);

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    await expect(async () => {
      for await (const _ of provider.chat(emptyMessages, emptyTools)) { /* consume */ }
    }).rejects.toThrow("relay failed");
  });

  it("relay 返回顶层 SSE error 帧时上抛模型流错误", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream('data: {"error":{"message":"provider exploded","type":"server_error"}}\n\n'),
    });
    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    await expect(collect(provider.chat(emptyMessages, emptyTools))).rejects.toMatchObject({
      code: "model_stream_failed",
      message: "provider exploded",
      providerErrorType: "server_error",
    });
  });

  it("relay 流缺少 [DONE] 时不接受半截结果", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n'),
    });
    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    await expect(collect(provider.chat(emptyMessages, emptyTools))).rejects.toMatchObject({
      code: "model_stream_incomplete",
    });
  });

  it("relay 返回既无 stream 也无 response 时抛错", async () => {
    mockExecuteRelayChat.mockResolvedValue({});

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    await expect(async () => {
      for await (const _ of provider.chat(emptyMessages, emptyTools)) { /* consume */ }
    }).rejects.toThrow("relay 返回既无 stream 也无 response");
  });

  it("parseToolCalls / getUsage / getFinishReason 辅助方法", () => {
    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    const chunkWithTool = {
      id: "c1", model: "gpt-4o",
      delta: { toolCalls: [{ id: "tc1", type: "function" as const, function: { name: "f", arguments: "{}" } }] },
    };
    expect(provider.parseToolCalls(chunkWithTool)).toHaveLength(1);

    const chunkWithUsage = {
      id: "c2", model: "gpt-4o",
      delta: {},
      usage: { inputTokens: 1, outputTokens: 2, cacheTokens: 0, cacheWriteTokens: 0, totalTokens: 3 },
    };
    expect(provider.getUsage(chunkWithUsage)).toMatchObject({ inputTokens: 1 });

    const chunkWithFinish = { id: "c3", model: "gpt-4o", delta: {}, finishReason: "stop" as const };
    expect(provider.getFinishReason(chunkWithFinish)).toBe("stop");
  });

  it("metadata 字段正确", () => {
    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });
    expect(provider.metadata.modelId).toBe("gpt-4o");
    expect(provider.metadata.provider).toBe("relay");
    expect(provider.metadata.supportsToolCalls).toBe(true);
    expect(provider.metadata.supportsStreaming).toBe(true);
    expect(provider.metadata.supportsVision).toBe(true);
  });

  it("metadata 可通过 config 覆盖", () => {
    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
      metadata: { maxContextTokens: 32_000 },
    });
    expect(provider.metadata.maxContextTokens).toBe(32_000);
    expect(provider.metadata.maxOutputTokens).toBe(4_096); // 默认值保留
  });

  it("options 参数正确透传", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream('data: [DONE]\n\n'),
    });

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    await collect(provider.chat(emptyMessages, emptyTools, {
      temperature: 0.7,
      maxTokens: 2048,
      topP: 0.9,
      stop: ["END"],
    }));

    const [request] = mockExecuteRelayChat.mock.calls[0];
    expect(request.temperature).toBe(0.7);
    expect(request.max_tokens).toBe(2048);
    expect(request.top_p).toBe(0.9);
    expect(request.stop).toEqual(["END"]);
  });

  it("绝不触发真实计费：mockExecuteRelayChat 返回空流时不抛计费相关错误", async () => {
    mockExecuteRelayChat.mockResolvedValue({
      stream: makeSseStream('data: [DONE]\n\n'),
    });

    const provider = new RelayModelProvider({
      modelId: "gpt-4o",
      relayContext: dummyContext,
    });

    // 只要不抛 BillingError 就行
    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks).toHaveLength(0);
  });
});
