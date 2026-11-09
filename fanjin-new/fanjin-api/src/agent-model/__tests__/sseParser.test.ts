import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRelaySseStream, nextSseEvent, readSseData, mapOpenAiChunk } from "@/agent-model/sseParser";
import { ModelProviderStreamError } from "@/agent-model/errors";

/** 把字符串转成 ReadableStream<Uint8Array>（整块写入） */
function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

/** 收集 parseRelaySseStream 产出的所有 ChatChunk */
async function collect(sse: string, model = "test") {
  const chunks = [];
  for await (const c of parseRelaySseStream(streamFromString(sse), model)) chunks.push(c);
  return chunks;
}

const fixturesDir = join(__dirname, "fixtures");

describe("nextSseEvent", () => {
  it("\\n\\n 分隔符：正确切分", () => {
    const buf = "data: hello\n\ndata: world\n\n";
    const r1 = nextSseEvent(buf);
    expect(r1).not.toBeNull();
    expect(r1!.event).toBe("data: hello\n\n");
    const r2 = nextSseEvent(r1!.rest);
    expect(r2).not.toBeNull();
    expect(r2!.event).toBe("data: world\n\n");
  });

  it("\\r\\n\\r\\n 分隔符：正确切分", () => {
    const buf = "data: hello\r\n\r\ndata: world\r\n\r\n";
    const r1 = nextSseEvent(buf);
    expect(r1).not.toBeNull();
    expect(r1!.event).toBe("data: hello\r\n\r\n");
  });

  it("混合分隔符：取更靠前者", () => {
    // \n\n 出现在 \r\n\r\n 之前
    const buf = "data: a\n\ndata: b\r\n\r\n";
    const r = nextSseEvent(buf);
    expect(r).not.toBeNull();
    expect(r!.event).toBe("data: a\n\n");
  });

  it("无完整事件：返回 null", () => {
    expect(nextSseEvent("data: hello")).toBeNull();
    expect(nextSseEvent("data: hello\n")).toBeNull();
  });
});

describe("readSseData", () => {
  it("单行 data", () => {
    expect(readSseData("data: hello\n\n")).toBe("hello");
  });

  it("多行 data 用 \\n 连接", () => {
    expect(readSseData("data: line1\ndata: line2\n\n")).toBe("line1\nline2");
  });

  it("无 data 行返回 null", () => {
    expect(readSseData("event: ping\n\n")).toBeNull();
  });

  it("data: 前缀后无空格", () => {
    expect(readSseData("data:nospace\n\n")).toBe("nospace");
  });

  it("data 行只有一个前导空格被去掉", () => {
    expect(readSseData("data:  two-spaces\n\n")).toBe(" two-spaces");
  });
});

describe("mapOpenAiChunk", () => {
  it("纯文本 delta → ChatChunk", () => {
    const raw = {
      id: "cmpl-1",
      model: "gpt-4o",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    };
    const chunk = mapOpenAiChunk(raw, "fallback");
    expect(chunk).not.toBeNull();
    expect(chunk!.delta.content).toBe("hi");
    expect(chunk!.model).toBe("gpt-4o");
  });

  it("无有效 delta 且无 finish/usage 返回 null", () => {
    const raw = {
      id: "cmpl-2",
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    };
    expect(mapOpenAiChunk(raw, "fallback")).toBeNull();
  });

  it("finish_reason stop 映射正确", () => {
    const raw = {
      id: "cmpl-3",
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    const chunk = mapOpenAiChunk(raw, "fallback");
    expect(chunk).not.toBeNull();
    expect(chunk!.finishReason).toBe("stop");
  });

  it("usage 映射正确", () => {
    const raw = {
      id: "cmpl-4",
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
      },
    };
    const chunk = mapOpenAiChunk(raw, "fallback");
    expect(chunk).not.toBeNull();
    expect(chunk!.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheTokens: 20,
      cacheWriteTokens: 5,
      totalTokens: 150,
    });
  });

  it("tool_calls delta 映射正确", () => {
    const raw = {
      id: "cmpl-5",
      model: "gpt-4o",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_abc",
            type: "function",
            function: { name: "search", arguments: '{"q":"test"}' },
          }],
        },
        finish_reason: null,
      }],
    };
    const chunk = mapOpenAiChunk(raw, "fallback");
    expect(chunk).not.toBeNull();
    expect(chunk!.delta.toolCalls).toHaveLength(1);
    expect(chunk!.delta.toolCalls![0].index).toBe(0);
    expect(chunk!.delta.toolCalls![0].function.name).toBe("search");
  });

  it("tool_calls 保留并行增量的 index", () => {
    const raw = {
      id: "cmpl-parallel-tools",
      choices: [{
        delta: {
          tool_calls: [
            { index: 1, function: { arguments: "part-b" } },
            { index: 0, function: { arguments: "part-a" } },
          ],
        },
        finish_reason: null,
      }],
    };
    const chunk = mapOpenAiChunk(raw, "fallback");
    expect(chunk?.delta.toolCalls?.map((call) => call.index)).toEqual([1, 0]);
  });

  it.each([
    ["缺少必填字段", {}],
    ["负数", { prompt_tokens: -1, completion_tokens: 2 }],
    ["小数", { prompt_tokens: 1, completion_tokens: 2.5 }],
    ["超出安全整数", { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 2 }],
    ["负数缓存 token", {
      prompt_tokens: 1,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: -1 },
    }],
  ])("usage %s 时不伪造 token 统计", (_label, usage) => {
    const chunk = mapOpenAiChunk({
      id: "cmpl-invalid-usage",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage,
    }, "fallback");
    expect(chunk).not.toBeNull();
    expect(chunk?.usage).toBeUndefined();
  });

  it("usage 可选缓存字段缺失时按 relay 语义映射为 0", () => {
    const chunk = mapOpenAiChunk({
      id: "cmpl-usage-no-cache",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }, "fallback");
    expect(chunk?.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      cacheTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 5,
    });
  });

  it("无 id 时生成占位 id", () => {
    const raw = {
      model: "gpt-4o",
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
    };
    const chunk = mapOpenAiChunk(raw, "fallback");
    expect(chunk).not.toBeNull();
    expect(chunk!.id).toBeTruthy();
  });

  it("无 model 时使用 fallbackModel", () => {
    const raw = {
      id: "cmpl-6",
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
    };
    const chunk = mapOpenAiChunk(raw, "my-fallback");
    expect(chunk!.model).toBe("my-fallback");
  });
});

describe("parseRelaySseStream", () => {
  it("纯文本：拼接内容与预期一致", async () => {
    const sse = readFileSync(join(fixturesDir, "openai-text-only.sse"), "utf8");
    const chunks = await collect(sse);
    const text = chunks.map(c => c.delta.content ?? "").join("");
    expect(text).toBe("Hello world!");
    expect(chunks.at(-1)?.finishReason).toBe("stop");
    expect(chunks.at(-1)?.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
  });

  it("tool_calls：id/name/arguments 无损", async () => {
    const sse = readFileSync(join(fixturesDir, "openai-tool-calls.sse"), "utf8");
    const chunks = await collect(sse);
    // OpenAI 流式 tool_calls 是增量的：首块带 id/name，后续块只有 arguments 片段
    const allCalls = chunks.flatMap(c => c.delta.toolCalls ?? []);
    expect(allCalls.every((call) => call.index === 0)).toBe(true);
    // 首块带完整 id 和 name
    expect(allCalls[0]).toMatchObject({ id: "call_abc123", type: "function", function: { name: "get_weather" } });
    // 拼接所有 arguments 片段得到完整 JSON
    const fullArgs = allCalls.map(c => c.function.arguments).join("");
    expect(fullArgs).toBe('{"location":"Beijing"}');
    expect(chunks.at(-1)?.finishReason).toBe("tool_calls");
    expect(chunks.at(-1)?.usage).toMatchObject({ inputTokens: 20, outputTokens: 7 });
  });

  it("usage：末尾块携带且字段完整", async () => {
    const sse = readFileSync(join(fixturesDir, "openai-with-usage.sse"), "utf8");
    const chunks = await collect(sse);
    const usage = chunks.map(c => c.usage).filter(Boolean).at(-1);
    expect(usage).toMatchObject({ inputTokens: 42, outputTokens: 8, cacheTokens: 10, cacheWriteTokens: 5 });
  });

  it("anthropic-converted：relay 已转 OpenAI 格的 Claude 流正确解析", async () => {
    const sse = readFileSync(join(fixturesDir, "anthropic-converted.sse"), "utf8");
    const chunks = await collect(sse);
    const text = chunks.map(c => c.delta.content ?? "").join("");
    expect(text).toBe("I'll help you with that");
    expect(chunks.at(-1)?.finishReason).toBe("stop");
    // Claude 转换后的 usage
    const usage = chunks.map(c => c.usage).filter(Boolean).at(-1);
    expect(usage).toMatchObject({ inputTokens: 25, outputTokens: 6, cacheTokens: 5 });
  });

  it("跨 chunk 分割：字节流被任意切断仍能正确解析", async () => {
    const sse = readFileSync(join(fixturesDir, "openai-text-only.sse"), "utf8");
    // 把整段按每 7 字节切块，模拟网络分片
    const bytes = new TextEncoder().encode(sse);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); }
    });
    const chunks = [];
    for await (const ch of parseRelaySseStream(stream, "test")) chunks.push(ch);
    const text = chunks.map(c => c.delta.content ?? "").join("");
    expect(text).toBe("Hello world!");
  });

  it("[DONE] 是终止哨兵，不产出 chunk", async () => {
    const chunks = await collect(`data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    expect(chunks).toHaveLength(1);
  });

  it("非 JSON vendor 事件被跳过而不抛错", async () => {
    const chunks = await collect(`data: : keep-alive\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`);
    expect(chunks.map(c => c.delta.content).join("")).toBe("ok");
  });

  it("relay 顶层 error 帧抛出模型流错误", async () => {
    const result = collect([
      `data: {"choices":[{"delta":{"content":"partial"}}]}\n\n`,
      `data: {"error":{"message":"settlement failed","type":"server_error"}}\n\n`,
    ].join(""));
    await expect(result).rejects.toMatchObject({
      name: "ModelProviderStreamError",
      code: "model_stream_failed",
      message: "settlement failed",
      providerErrorType: "server_error",
    });
  });

  it("顶层 error 帧缺少 message 时仍抛出明确错误", async () => {
    await expect(collect(`data: {"error":{"type":"server_error"}}\n\n`))
      .rejects.toBeInstanceOf(ModelProviderStreamError);
  });

  it("物理 EOF 前缺少 [DONE] 时 fail-closed", async () => {
    await expect(collect(`data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n`))
      .rejects.toMatchObject({
        name: "ModelProviderStreamError",
        code: "model_stream_incomplete",
      });
  });

  it("EOF 前无空行的最后一帧仍会被消费，然后按缺 [DONE] 失败", async () => {
    const iterator = parseRelaySseStream(
      streamFromString(`data: {"choices":[{"delta":{"content":"tail"},"finish_reason":"stop"}]}`),
      "test",
    );
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { delta: { content: "tail" } },
    });
    await expect(iterator.next()).rejects.toMatchObject({ code: "model_stream_incomplete" });
  });

  it("EOF 前无空行的顶层 error 帧不会被丢失", async () => {
    await expect(collect(`data: {"error":{"message":"tail error","type":"server_error"}}`))
      .rejects.toMatchObject({
        code: "model_stream_failed",
        message: "tail error",
      });
  });
});
