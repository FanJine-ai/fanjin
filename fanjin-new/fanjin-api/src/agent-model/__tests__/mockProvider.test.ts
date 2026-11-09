import { describe, it, expect } from "vitest";
import { MockModelProvider } from "@/agent-model/mockProvider";
import type { ChatMessage, ToolSchema } from "@/agent-model/types";

const emptyMessages: ChatMessage[] = [];
const emptyTools: ToolSchema[] = [];

/** 收集 async iterator 所有产出 */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) items.push(item);
  return items;
}

describe("MockModelProvider", () => {
  it("默认响应：产出 content + finishReason=stop + usage", async () => {
    const provider = new MockModelProvider();
    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks).toHaveLength(2); // content chunk + finish chunk
    expect(chunks[0].delta.content).toBe("mock");
    expect(chunks[0].delta.role).toBe("assistant");
    expect(chunks[1].finishReason).toBe("stop");
    expect(chunks[1].usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("自定义响应：指定 content", async () => {
    const provider = new MockModelProvider({
      responses: [{ content: "hello world", finishReason: "stop" }],
    });
    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks[0].delta.content).toBe("hello world");
    expect(chunks[1].finishReason).toBe("stop");
  });

  it("响应队列循环取用", async () => {
    const provider = new MockModelProvider({
      responses: [
        { content: "first" },
        { content: "second" },
      ],
    });
    // 第一次调用
    const chunks1 = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks1[0].delta.content).toBe("first");
    // 第二次调用
    const chunks2 = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks2[0].delta.content).toBe("second");
    // 第三次调用循环回第一个
    const chunks3 = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks3[0].delta.content).toBe("first");
  });

  it("resetCallCount 重置计数器", async () => {
    const provider = new MockModelProvider({
      responses: [{ content: "a" }, { content: "b" }],
    });
    await collect(provider.chat(emptyMessages, emptyTools)); // callCount=1
    provider.resetCallCount();
    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks[0].delta.content).toBe("a"); // 从头开始
  });

  it("延迟：delayMs > 0 时不会立即返回", async () => {
    const provider = new MockModelProvider({
      responses: [{ content: "delayed", delayMs: 50 }],
    });
    const start = Date.now();
    await collect(provider.chat(emptyMessages, emptyTools));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // 允许少量时钟误差
  });

  it("工具调用块：toolCalls 产出对应 delta", async () => {
    const provider = new MockModelProvider({
      responses: [{
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: { name: "search", arguments: '{"q":"test"}' },
        }],
        finishReason: "tool_calls",
      }],
    });
    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    // toolCalls chunk + finish chunk
    const toolChunk = chunks.find(c => c.delta.toolCalls && c.delta.toolCalls.length > 0);
    expect(toolChunk).toBeDefined();
    expect(toolChunk!.delta.toolCalls![0].function.name).toBe("search");
    const finishChunk = chunks.at(-1);
    expect(finishChunk!.finishReason).toBe("tool_calls");
  });

  it("content + toolCalls 同时存在时分两个块产出", async () => {
    const provider = new MockModelProvider({
      responses: [{
        content: "thinking...",
        toolCalls: [{
          id: "call_2",
          type: "function",
          function: { name: "calc", arguments: '{"a":1}' },
        }],
        finishReason: "tool_calls",
      }],
    });
    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    // content chunk + toolCalls chunk + finish chunk
    expect(chunks).toHaveLength(3);
    expect(chunks[0].delta.content).toBe("thinking...");
    expect(chunks[1].delta.toolCalls).toHaveLength(1);
    expect(chunks[2].finishReason).toBe("tool_calls");
  });

  it("自定义 usage 可挂到末尾块", async () => {
    const customUsage = { inputTokens: 100, outputTokens: 200, cacheTokens: 0, cacheWriteTokens: 0, totalTokens: 300 };
    const provider = new MockModelProvider({
      responses: [{ content: "x", usage: customUsage, finishReason: "stop" }],
    });
    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    expect(chunks.at(-1)!.usage).toEqual(customUsage);
  });

  it("metadata 字段正确", () => {
    const provider = new MockModelProvider({ modelId: "my-mock" });
    expect(provider.metadata.modelId).toBe("my-mock");
    expect(provider.metadata.provider).toBe("mock");
    expect(provider.metadata.supportsToolCalls).toBe(true);
    expect(provider.metadata.supportsStreaming).toBe(true);
    expect(provider.metadata.supportsVision).toBe(false);
  });

  it("parseToolCalls / getUsage / getFinishReason 辅助方法", async () => {
    const provider = new MockModelProvider({
      responses: [{
        toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 2, cacheTokens: 0, cacheWriteTokens: 0, totalTokens: 3 },
      }],
    });
    const chunks = await collect(provider.chat(emptyMessages, emptyTools));
    const toolChunk = chunks.find(c => c.delta.toolCalls && c.delta.toolCalls.length > 0)!;
    expect(provider.parseToolCalls(toolChunk)).toHaveLength(1);
    const finishChunk = chunks.at(-1)!;
    expect(provider.getFinishReason(finishChunk)).toBe("tool_calls");
    expect(provider.getUsage(finishChunk)).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  });
});
