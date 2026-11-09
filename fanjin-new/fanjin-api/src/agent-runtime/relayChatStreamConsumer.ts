/**
 * relay chat SSE 流 → 一次性 OpenAI 响应的累积器(REVAMP-PLAN 4.1)。
 *
 * executeRelayChat(stream:true) 返回的 ReadableStream 是 OpenAI chunk 的 SSE
 * 直通(Anthropic 上游亦由 protocolConverter 转成同构 chunk)。本模块把增量
 * chunk 累积成 parseRelayToolLoopModelResult 可接受的非流式 response,从而
 * 复用既有全部校验(参数 JSON、字节上限、tool_calls 协议投影)。
 *
 * 计费纪律:relay 在流被完整消费时才结算(否则保留预扣待核账),因此
 * consumeRelayChatCompletionStream 无论解析是否出错都必须把流读到底,
 * 错误在排空完成后统一抛出。
 *
 * tool_calls 增量累积写法参照已删除的 workflow-studio 实现
 * (openaiCompatibleChat.ts:72-121):按 index 分桶,id/name 覆盖式更新,
 * arguments 以字符串追加,终态按 index 排序并丢弃缺 id/name 的残桶。
 */
import { ToolLoopSafeError } from "@/agent-runtime/toolLoopProcessor";

interface StreamToolCallBucket {
  id: string;
  name: string;
  arguments: string;
}

export interface RelayChatStreamAccumulator {
  /** 处理一条 SSE data 载荷;返回本条携带的正文增量(无则 null)。 */
  pushData(data: string): string | null;
  /** 流结束后构建合成非流式 response;终态不完整时抛 ToolLoopSafeError。 */
  finish(): { response: unknown };
}

function mergeStreamToolCallDelta(
  accumulator: Map<number, StreamToolCallBucket>,
  raw: unknown,
): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const index = typeof record.index === "number" && Number.isFinite(record.index)
      ? record.index
      : 0;
    const existing = accumulator.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof record.id === "string" && record.id) existing.id = record.id;
    const fn = record.function;
    if (typeof fn === "object" && fn !== null) {
      const name = (fn as { name?: unknown }).name;
      const args = (fn as { arguments?: unknown }).arguments;
      if (typeof name === "string" && name) existing.name = name;
      if (typeof args === "string") existing.arguments += args;
    }
    accumulator.set(index, existing);
  }
}

function finalizeStreamToolCalls(accumulator: Map<number, StreamToolCallBucket>) {
  return [...accumulator.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => ({
      id: item.id,
      type: "function" as const,
      function: { name: item.name, arguments: item.arguments },
    }))
    .filter((call) => call.id && call.function.name);
}

export function createRelayChatStreamAccumulator(): RelayChatStreamAccumulator {
  const toolCalls = new Map<number, StreamToolCallBucket>();
  let content = "";
  let reasoningContent = "";
  let finishReason: string | null = null;
  let sawDone = false;
  let streamError: { code: string; message: string } | null = null;

  return {
    pushData(data) {
      if (data === "[DONE]") {
        sawDone = true;
        return null;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        // relay 原样透传的非 JSON 厂商事件(心跳等)不是错误,跳过。
        return null;
      }
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return null;
      const record = chunk as Record<string, unknown>;
      const error = record.error;
      if (!streamError && error && typeof error === "object" && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        streamError = {
          code: "model_stream_failed",
          message: typeof message === "string" && message ? message : "模型响应流中断",
        };
      }
      const choices = Array.isArray(record.choices) ? record.choices : [];
      const choice = choices[0];
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) return null;
      const choiceRecord = choice as Record<string, unknown>;
      if (typeof choiceRecord.finish_reason === "string" && choiceRecord.finish_reason) {
        finishReason = choiceRecord.finish_reason;
      }
      const delta = choiceRecord.delta;
      if (!delta || typeof delta !== "object" || Array.isArray(delta)) return null;
      const deltaRecord = delta as Record<string, unknown>;
      mergeStreamToolCallDelta(toolCalls, deltaRecord.tool_calls);
      if (typeof deltaRecord.reasoning_content === "string") {
        reasoningContent += deltaRecord.reasoning_content;
      }
      return typeof deltaRecord.content === "string" && deltaRecord.content
        ? (content += deltaRecord.content, deltaRecord.content)
        : null;
    },
    finish() {
      if (streamError) throw new ToolLoopSafeError(streamError.code, streamError.message);
      if (!sawDone) {
        throw new ToolLoopSafeError("model_stream_incomplete", "模型响应流未正常结束");
      }
      const calls = finalizeStreamToolCalls(toolCalls);
      const message: Record<string, unknown> = { role: "assistant", content };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (calls.length > 0) message.tool_calls = calls;
      return {
        response: {
          choices: [{
            index: 0,
            message,
            finish_reason: finishReason ?? (calls.length > 0 ? "tool_calls" : "stop"),
          }],
        },
      };
    },
  };
}

function nextSseFrame(buffer: string): { frame: string; rest: string } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (lfIndex < 0 && crlfIndex < 0) return null;
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) {
    const end = crlfIndex + 4;
    return { frame: buffer.slice(0, end), rest: buffer.slice(end) };
  }
  const end = lfIndex + 2;
  return { frame: buffer.slice(0, end), rest: buffer.slice(end) };
}

function readSseFrameData(frame: string): string | null {
  const dataLines = frame
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

/**
 * 完整排空 relay SSE 流,逐帧累积并向 onTextDelta 直推正文增量。
 * 返回合成的非流式 response(喂给 parseRelayToolLoopModelResult)。
 * 任何帧错误都先记录、排空后再抛,保证 relay 计费结算不被中断。
 */
export async function consumeRelayChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
  handlers: { onTextDelta?: (text: string) => void } = {},
): Promise<unknown> {
  const accumulator = createRelayChatStreamAccumulator();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleFrame = (frame: string) => {
    const data = readSseFrameData(frame);
    if (data === null) return;
    const textDelta = accumulator.pushData(data);
    if (textDelta && handlers.onTextDelta) {
      try {
        handlers.onTextDelta(textDelta);
      } catch {
        // 增量预览回调(进程内推送)异常不影响模型 Turn 本身。
      }
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const next = nextSseFrame(buffer);
        if (!next) break;
        buffer = next.rest;
        handleFrame(next.frame);
      }
    }
    buffer += decoder.decode();
    if (buffer) handleFrame(buffer);
  } finally {
    reader.releaseLock();
  }
  return accumulator.finish().response;
}
