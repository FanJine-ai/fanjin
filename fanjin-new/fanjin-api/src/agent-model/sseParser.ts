/**
 * 把 relay 返回的 OpenAI 兼容 SSE 字节流解析为统一 ChatChunk。
 * 关键点：
 * - 事件分隔符可能是 \n\n 或 \r\n\r\n（沿用 relayChat 的 nextSseEvent 逻辑）。
 * - data 行去掉 "data:" 前缀与一个可选前导空格。
 * - "[DONE]" 是终止哨兵，不产出 chunk。
 * - 非 JSON 的 vendor 事件跳过（返回 undefined 表示忽略）。
 * - usage 可能在末尾块（include_usage）出现。
 */
import type { ChatChunk, ToolCall, TokenUsage, FinishReason } from "./types";
import { ModelProviderStreamError } from "./errors";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 与 relayChat.readUsageInteger 保持相同的非负安全整数语义。 */
function readUsageInteger(value: unknown, required: boolean): number | null {
  if (value == null) return required ? null : 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function mapTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
  const inputTokens = readUsageInteger(value.prompt_tokens, true);
  const outputTokens = readUsageInteger(value.completion_tokens, true);
  const cacheTokens = readUsageInteger(details?.cached_tokens, false);
  const cacheWriteTokens = readUsageInteger(details?.cache_write_tokens, false);
  if (inputTokens == null || outputTokens == null || cacheTokens == null || cacheWriteTokens == null) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** 从缓冲区切出一个完整 SSE 事件，返回事件文本与剩余缓冲。 */
export function nextSseEvent(buffer: string): { event: string; rest: string } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (lfIndex < 0 && crlfIndex < 0) return null;
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) {
    const end = crlfIndex + 4;
    return { event: buffer.slice(0, end), rest: buffer.slice(end) };
  }
  const end = lfIndex + 2;
  return { event: buffer.slice(0, end), rest: buffer.slice(end) };
}

/** 从事件文本抽取 data 负载（多行 data 用 \n 连接），无 data 返回 null。 */
export function readSseData(event: string): string | null {
  const dataLines = event
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

/** 映射 OpenAI 兼容 finish_reason 字符串到统一 FinishReason */
function mapFinishReason(raw: string | null | undefined): FinishReason {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "tool_calls") return "tool_calls";
  if (raw === "content_filter") return "content_filter";
  return null;
}

/**
 * 把单个 OpenAI 兼容 chunk JSON 映射为统一 ChatChunk。
 * 传入的是已 JSON.parse 的对象。返回 null 表示该 chunk 无有效 delta（跳过）。
 */
export function mapOpenAiChunk(raw: Record<string, unknown>, fallbackModel: string): ChatChunk | null {
  const choices = raw.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const delta = choice?.delta as Record<string, unknown> | undefined;
  const finishReasonRaw = choice?.finish_reason as string | null | undefined;
  const finishReason = finishReasonRaw != null ? mapFinishReason(finishReasonRaw) : undefined;

  // 映射 usage（可能出现在末尾块）；非法值不伪造成 0。
  const usage = mapTokenUsage(raw.usage);

  // 有 delta 内容
  const hasContent = typeof delta?.content === "string" && delta.content.length > 0;
  const rawToolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined;
  const toolCalls: ToolCall[] | undefined = rawToolCalls
    ?.filter(isRecord)
    .map((tc) => {
      const fn = isRecord(tc.function) ? tc.function : undefined;
      const index = typeof tc.index === "number" && Number.isSafeInteger(tc.index) && tc.index >= 0
        ? tc.index
        : undefined;
      return {
        ...(index === undefined ? {} : { index }),
        id: String(tc.id ?? ""),
        type: "function" as const,
        function: {
          name: String(fn?.name ?? ""),
          arguments: String(fn?.arguments ?? ""),
        },
      };
    });

  const hasToolCalls = toolCalls != null && toolCalls.length > 0;
  const hasFinish = finishReason != null;
  const hasUsage = usage != null;

  // 无有效 delta 且无 finish/usage 时返回 null
  if (!hasContent && !hasToolCalls && !hasFinish && !hasUsage) return null;

  const chunk: ChatChunk = {
    id: String(raw.id ?? `chunk-${Date.now()}`),
    model: String(raw.model ?? fallbackModel),
    delta: {
      role: delta?.role === "assistant" ? "assistant" : undefined,
      content: hasContent ? (delta!.content as string) : undefined,
      toolCalls: hasToolCalls ? toolCalls : undefined,
    },
    finishReason: hasFinish ? finishReason : undefined,
    usage: hasUsage ? usage : undefined,
  };
  return chunk;
}

type ParsedRelaySseData =
  | { kind: "done" }
  | { kind: "ignore" }
  | { kind: "error"; error: ModelProviderStreamError }
  | { kind: "chunk"; chunk: ChatChunk };

function parseRelaySseData(data: string, fallbackModel: string): ParsedRelaySseData {
  if (data === "[DONE]") return { kind: "done" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // relay 可原样透传非 JSON vendor 事件（如心跳）。
    return { kind: "ignore" };
  }
  if (!isRecord(parsed)) return { kind: "ignore" };

  if (isRecord(parsed.error)) {
    const message = typeof parsed.error.message === "string" && parsed.error.message.trim()
      ? parsed.error.message
      : "模型响应流失败";
    const providerErrorType = typeof parsed.error.type === "string" && parsed.error.type
      ? parsed.error.type
      : undefined;
    return {
      kind: "error",
      error: new ModelProviderStreamError("model_stream_failed", message, providerErrorType),
    };
  }

  const chunk = mapOpenAiChunk(parsed, fallbackModel);
  return chunk ? { kind: "chunk", chunk } : { kind: "ignore" };
}

/**
 * 消费 relay 的 SSE 字节流，异步产出 ChatChunk。
 * 遇到 [DONE] 结束。忽略无法解析的 vendor 事件。
 */
export async function* parseRelaySseStream(
  stream: ReadableStream<Uint8Array>,
  fallbackModel: string,
): AsyncIterableIterator<ChatChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError: ModelProviderStreamError | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const next = nextSseEvent(buffer);
        if (!next) break;
        buffer = next.rest;

        const data = readSseData(next.event);
        if (data == null) continue;
        const parsed = parseRelaySseData(data, fallbackModel);
        if (parsed.kind === "done") {
          if (streamError) throw streamError;
          return;
        }
        if (parsed.kind === "error") {
          streamError ??= parsed.error;
          continue;
        }
        if (parsed.kind === "chunk" && !streamError) yield parsed.chunk;
      }
    }

    // flush decoder 残余
    buffer += decoder.decode();

    // 处理残余事件
    while (true) {
      const next = nextSseEvent(buffer);
      if (!next) break;
      buffer = next.rest;

      const data = readSseData(next.event);
      if (data == null) continue;
      const parsed = parseRelaySseData(data, fallbackModel);
      if (parsed.kind === "done") {
        if (streamError) throw streamError;
        return;
      }
      if (parsed.kind === "error") {
        streamError ??= parsed.error;
        continue;
      }
      if (parsed.kind === "chunk" && !streamError) yield parsed.chunk;
    }

    // SSE 上游可在物理 EOF 前不补空行；与 relayChat 一样处理最后的残余事件。
    if (buffer) {
      const data = readSseData(buffer);
      if (data != null) {
        const parsed = parseRelaySseData(data, fallbackModel);
        if (parsed.kind === "done") {
          if (streamError) throw streamError;
          return;
        }
        if (parsed.kind === "error") streamError ??= parsed.error;
        if (parsed.kind === "chunk" && !streamError) yield parsed.chunk;
      }
    }

    if (streamError) throw streamError;
    throw new ModelProviderStreamError("model_stream_incomplete", "模型响应流未正常结束");
  } finally {
    reader.releaseLock();
  }
}
