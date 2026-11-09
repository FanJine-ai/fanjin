// Claude 协议中转（/v1/messages）。
// 根据上游通道类型自动选择转换路径：
//   - Anthropic 通道：直通（请求/响应都是 Claude 格式，原样转发）
//   - OpenAI 兼容通道：Claude 请求 → OpenAI 请求，OpenAI 响应 → Claude 响应
//
// 计费与 LLM/OpenAI 中转共用同一套 o_pricing_rule + billApiTask（endpointType=text）。
import axios from "axios";
import type { RelayChannel } from "@/lib/relay";
import { joinProviderApiPath, withChannelRetry } from "@/lib/channelRouter";
import { BillingError } from "@/lib/billing";
import {
  beginRelayTextBilling,
  markRelayBillingDispatchStarted,
  markRelayBillingPending,
  releaseRelayBillingSession,
  settleRelayTextBilling,
  type RelayBillingContext,
  type RelayTextBillingSession,
  type RelayTextUsage,
} from "@/lib/relayBillingSession";
import { resolveChannelApiKey, resolveChannelBaseUrl } from "@/lib/relayChannelCredential";
import {
  claudeRequestToOpenAI,
  openAIResponseToClaude,
  createClaudeStreamConverter,
  openAIErrorToClaude,
  type ClaudeRequest,
} from "@/lib/protocolConverter";

export class RelayMessagesError extends Error {
  statusCode: number;
  claudeError: boolean; // 标记返回 Claude 格式错误
  upstreamMayHaveAccepted: boolean;
  constructor(message: string, statusCode: number, claudeError = true, upstreamMayHaveAccepted = true) {
    super(message);
    this.name = "RelayMessagesError";
    this.statusCode = statusCode;
    this.claudeError = claudeError;
    this.upstreamMayHaveAccepted = upstreamMayHaveAccepted;
  }
}

function upstreamMayHaveAcceptedStatus(status: number): boolean {
  return ![400, 401, 402, 403, 404, 405, 406, 411, 413, 414, 415, 422, 429].includes(status);
}

function readUsageInteger(value: unknown, required: boolean): number | null {
  if (value == null) return required ? null : 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function uncertainMessagesUpstreamError(error: unknown, fallback: string): RelayMessagesError {
  const value = error as any;
  const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status);
  const message = value?.response?.data?.error?.message || value?.message || fallback;
  return new RelayMessagesError(
    String(message),
    Number.isFinite(status) ? status : 502,
    true,
    upstreamMayHaveAcceptedStatus(status),
  );
}

export interface RelayMessagesResult {
  // 流式：返回 ReadableStream（Claude SSE 格式）
  stream?: ReadableStream<Uint8Array>;
  // 非流式：返回完整 Claude 响应
  response?: any;
  usage?: RelayTextUsage;
}

/**
 * 执行 Claude /v1/messages 中转。
 * 自动根据通道 provider 决定直通还是转换。
 */
export async function executeRelayMessages(
  input: ClaudeRequest,
  ctx: RelayBillingContext,
): Promise<RelayMessagesResult> {
  const billingState: { current: RelayTextBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;
  let upstreamCompleted = false;
  try {
    const routed = await withChannelRetry(
      { endpointType: "text", model: input.model, workspaceId: ctx.workspaceId, retryPolicy: "disabled" },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        if (!billingState.current) {
          billingState.current = await beginRelayTextBilling({
            source: "relay-messages",
            model: input.model,
            channel,
            context: ctx,
            requestPayload: input,
            maxOutputTokens: input.max_tokens,
          });
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }
        return channel.provider === "anthropic"
          ? executeAnthropicDirect(input, channel, ctx, billingState.current)
          : executeViaOpenAI(input, channel, ctx, billingState.current);
      },
    );
    if (!routed.result.stream) {
      upstreamCompleted = true;
      if (!billingState.current) throw new BillingError("计费预扣会话未创建", 500);
      await settleRelayTextBilling(billingState.current, routed.channel, routed.result.usage);
    }
    return routed.result;
  } catch (error: any) {
    if (billingState.current && !billingState.current.finalized && !upstreamCompleted) {
      if (!billingState.current.dispatchStarted) {
        await releaseRelayBillingSession(
          billingState.current,
          "Messages 调用上游前失败，释放预扣",
          "not_dispatched",
        );
      } else if (error instanceof RelayMessagesError && !error.upstreamMayHaveAccepted) {
        await releaseRelayBillingSession(
          billingState.current,
          "Messages 上游明确拒绝且未产生成本，释放预扣",
          "definitive_not_billable",
        );
      } else if (activeChannel) {
        try {
          await markRelayBillingPending(billingState.current, activeChannel, {
            units: 0,
            costMicros: 0,
            reason: "messages_upstream_outcome_unknown",
          });
        } catch (billingError: any) {
          console.error("[relayMessages] 保存待核账状态失败", billingError?.message || billingError);
        }
      }
    }
    throw error;
  }
}

// ============ Anthropic 通道直通 ============
async function executeAnthropicDirect(
  input: ClaudeRequest,
  channel: RelayChannel,
  ctx: RelayBillingContext,
  billingSession: RelayTextBillingSession,
): Promise<RelayMessagesResult> {
  const apiKey = resolveChannelApiKey(channel);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!apiKey) throw new RelayMessagesError("供应商通道未配置 apiKey", 500);
  if (!baseUrl) throw new RelayMessagesError("供应商通道未配置 baseUrl", 500);

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    "Idempotency-Key": billingSession.requestId,
    "X-Request-Id": billingSession.requestId,
  };

  if (input.stream) {
    // 流式直通：转发 Anthropic SSE，结束后从 message_delta 提取 usage 计费
    const upstreamAbort = new AbortController();
    let response: Response;
    await markRelayBillingDispatchStarted(billingSession, channel);
    try {
      response = await fetch(joinProviderApiPath(baseUrl, "v1/messages"), {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal: AbortSignal.any([upstreamAbort.signal, AbortSignal.timeout(channel.timeoutMs || 120000)]),
      });
    } catch (error) {
      throw uncertainMessagesUpstreamError(error, "Anthropic 流式请求结果未知");
    }
    if (!response.ok) {
      const errBody = (await response.text()).slice(0, 2000);
      throw new RelayMessagesError(errBody, response.status, true, upstreamMayHaveAcceptedStatus(response.status));
    }
    if (!response.body) {
      throw new RelayMessagesError("上游未返回响应流", 502, true, true);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheTokens = 0;
    let cacheWriteTokens = 0;
    let sawTerminalEvent = false;
    let sawInputUsage = false;
    let sawOutputUsage = false;
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let clientCancelled = false;
    let pendingPromise: Promise<void> | null = null;
    const encoder = new TextEncoder();
    const responseBody = response.body;
    const markPendingOnce = (reason: string): Promise<void> => {
      if (billingSession.finalized) return Promise.resolve();
      if (!pendingPromise) {
        pendingPromise = markRelayBillingPending(billingSession, channel, {
          units: inputTokens + outputTokens + cacheWriteTokens,
          costMicros: 0,
          reason,
          metadata: { inputTokens, outputTokens, cacheTokens, cacheWriteTokens, provider: "anthropic" },
        });
      }
      return pendingPromise;
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = responseBody.getReader();
        upstreamReader = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // 透传 SSE 事件，同时解析 usage
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const evt = JSON.parse(line.slice(6));
                  if (evt.type === "message_start" && evt.message?.usage) {
                    const usage = evt.message.usage;
                    const baseInputTokens = readUsageInteger(usage.input_tokens, true);
                    const observedCacheTokens = readUsageInteger(usage.cache_read_input_tokens, false);
                    const observedCacheWriteTokens = readUsageInteger(usage.cache_creation_input_tokens, false);
                    if (baseInputTokens != null && observedCacheTokens != null && observedCacheWriteTokens != null) {
                      cacheTokens = observedCacheTokens;
                      cacheWriteTokens = observedCacheWriteTokens;
                      inputTokens = baseInputTokens + cacheTokens;
                      sawInputUsage = true;
                    }
                  } else if (evt.type === "message_delta" && evt.usage) {
                    const observedOutputTokens = readUsageInteger(evt.usage.output_tokens, true);
                    if (observedOutputTokens != null) {
                      outputTokens = observedOutputTokens;
                      sawOutputUsage = true;
                    }
                  } else if (evt.type === "message_stop") {
                    sawTerminalEvent = true;
                  }
                } catch { /* 忽略解析失败的事件 */ }
              }
              controller.enqueue(encoder.encode(line + "\n"));
            }
          }
          if (buffer) controller.enqueue(encoder.encode(buffer));
          if (clientCancelled) return;
          if (!sawTerminalEvent || !sawInputUsage || !sawOutputUsage) {
            await markPendingOnce(!sawTerminalEvent
              ? "messages_anthropic_stream_terminal_event_missing"
              : "messages_anthropic_stream_usage_incomplete");
            throw new BillingError("Anthropic 响应流终态或 Usage 不完整，预扣已保留待核账", 502);
          }
          await settleRelayTextBilling(billingSession, channel, {
            inputTokens,
            outputTokens,
            cacheTokens,
            cacheWriteTokens,
            authoritative: true,
          });
        } catch (error: any) {
          if (!billingSession.finalized) {
            try {
              await markPendingOnce(clientCancelled
                ? "messages_stream_client_cancelled"
                : "messages_stream_ended_without_settlement");
            } catch (billingError: any) {
              console.error("[relayMessages] 流式账务状态保存失败", billingError?.message || billingError);
            }
          }
          if (!clientCancelled) {
            const payload = openAIErrorToClaude(502, error?.message || "stream error");
            try { controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`)); } catch {}
          }
        } finally {
          upstreamReader = null;
          try { controller.close(); } catch {}
        }
      },
      async cancel(reason) {
        clientCancelled = true;
        upstreamAbort.abort(reason);
        try { await upstreamReader?.cancel(reason); } catch {}
        if (!billingSession.finalized) {
          try {
            await markPendingOnce("messages_stream_client_cancelled");
          } catch (billingError: any) {
            console.error("[relayMessages] Anthropic 流式取消状态保存失败", billingError?.message || billingError);
          }
        }
      },
    });
    return { stream };
  }

  // 非流式直通
  let res: Response;
  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    res = await fetch(joinProviderApiPath(baseUrl, "v1/messages"), {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(channel.timeoutMs || 120000),
    });
  } catch (error) {
    throw uncertainMessagesUpstreamError(error, "Anthropic 请求结果未知");
  }
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 2000);
    throw new RelayMessagesError(errBody, res.status, true, upstreamMayHaveAcceptedStatus(res.status));
  }
  let claudeResp: any;
  try {
    claudeResp = await res.json();
  } catch (error) {
    throw uncertainMessagesUpstreamError(error, "Anthropic 已响应但响应体无法解析");
  }
  const baseInputTokens = readUsageInteger(claudeResp?.usage?.input_tokens, true);
  const outputTokens = readUsageInteger(claudeResp?.usage?.output_tokens, true);
  const cacheTokens = readUsageInteger(claudeResp?.usage?.cache_read_input_tokens, false);
  const cacheWriteTokens = readUsageInteger(claudeResp?.usage?.cache_creation_input_tokens, false);
  if (baseInputTokens == null || outputTokens == null || cacheTokens == null || cacheWriteTokens == null) {
    throw new RelayMessagesError("Anthropic 已响应但 Usage 不完整或无效", 502, true, true);
  }
  const inputTokens = baseInputTokens + cacheTokens;
  return {
    response: claudeResp,
    usage: { inputTokens, outputTokens, cacheTokens, cacheWriteTokens, authoritative: true },
  };
}

// ============ OpenAI 兼容通道（转换路径） ============
async function executeViaOpenAI(
  input: ClaudeRequest,
  channel: RelayChannel,
  ctx: RelayBillingContext,
  billingSession: RelayTextBillingSession,
): Promise<RelayMessagesResult> {
  const apiKey = resolveChannelApiKey(channel);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!apiKey) throw new RelayMessagesError("供应商通道未配置 apiKey", 500);
  if (!baseUrl) throw new RelayMessagesError("供应商通道未配置 baseUrl", 500);

  // Claude 请求 → OpenAI 请求
  const openaiReq = claudeRequestToOpenAI(input);
  const upstreamModel = resolveUpstreamModel(channel, input.model);

  if (input.stream) {
    return executeViaOpenAIStream(openaiReq, upstreamModel, input.model, channel, baseUrl, apiKey, ctx, billingSession);
  }
  return executeViaOpenAINonStream(openaiReq, upstreamModel, input.model, channel, baseUrl, apiKey, ctx, billingSession);
}

async function executeViaOpenAIStream(
  openaiReq: any,
  upstreamModel: string,
  clientModel: string,
  channel: RelayChannel,
  baseUrl: string,
  apiKey: string,
  _ctx: RelayBillingContext,
  billingSession: RelayTextBillingSession,
): Promise<RelayMessagesResult> {
  const converter = createClaudeStreamConverter(clientModel);
  const encoder = new TextEncoder();
  const upstreamAbort = new AbortController();
  let response: Response;
  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    response = await fetch(joinProviderApiPath(baseUrl, "v1/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": billingSession.requestId,
        "X-Request-Id": billingSession.requestId,
      },
      body: JSON.stringify({
        ...openaiReq,
        model: upstreamModel,
        stream: true,
        stream_options: { ...(openaiReq.stream_options || {}), include_usage: true },
      }),
      signal: AbortSignal.any([upstreamAbort.signal, AbortSignal.timeout(channel.timeoutMs || 120000)]),
    });
  } catch (error) {
    throw uncertainMessagesUpstreamError(error, "OpenAI 兼容流式请求结果未知");
  }
  if (!response.ok) {
    throw new RelayMessagesError(
      (await response.text()).slice(0, 2000),
      response.status,
      true,
      upstreamMayHaveAcceptedStatus(response.status),
    );
  }
  if (!response.body) throw new RelayMessagesError("上游未返回响应流", 502, true, true);
  const responseBody = response.body;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  let cacheWriteTokens = 0;
  let sawTerminalEvent = false;
  let sawAuthoritativeUsage = false;
  let clientCancelled = false;
  let pendingPromise: Promise<void> | null = null;

  const markPendingOnce = (reason: string): Promise<void> => {
    if (billingSession.finalized) return Promise.resolve();
    if (!pendingPromise) {
      pendingPromise = markRelayBillingPending(billingSession, channel, {
        units: inputTokens + outputTokens + cacheWriteTokens,
        costMicros: 0,
        reason,
        metadata: { inputTokens, outputTokens, cacheTokens, cacheWriteTokens, sawAuthoritativeUsage },
      });
    }
    return pendingPromise;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const reader = responseBody.getReader();
        upstreamReader = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              sawTerminalEvent = true;
              continue;
            }
            try {
              const chunk = JSON.parse(data);
              if (chunk.usage) {
                const observedInputTokens = readUsageInteger(chunk.usage.prompt_tokens, true);
                const observedOutputTokens = readUsageInteger(chunk.usage.completion_tokens, true);
                const observedCacheTokens = readUsageInteger(chunk.usage.prompt_tokens_details?.cached_tokens, false);
                const observedCacheWriteTokens = readUsageInteger(
                  chunk.usage.prompt_tokens_details?.cache_write_tokens,
                  false,
                );
                if (
                  observedInputTokens != null &&
                  observedOutputTokens != null &&
                  observedCacheTokens != null &&
                  observedCacheWriteTokens != null
                ) {
                  inputTokens = observedInputTokens;
                  outputTokens = observedOutputTokens;
                  cacheTokens = observedCacheTokens;
                  cacheWriteTokens = observedCacheWriteTokens;
                  sawAuthoritativeUsage = true;
                }
              }
              const events = converter.convertChunk(chunk);
              for (const evt of events) {
                controller.enqueue(encoder.encode(evt));
              }
            } catch { /* 忽略解析失败 */ }
          }
        }
        if (clientCancelled) return;
        if (!sawTerminalEvent || !sawAuthoritativeUsage) {
          await markPendingOnce(!sawTerminalEvent
            ? "messages_openai_stream_terminal_event_missing"
            : "messages_openai_stream_usage_incomplete");
          throw new BillingError("OpenAI 兼容响应流终态或 Usage 不完整，预扣已保留待核账", 502);
        }
        await settleRelayTextBilling(billingSession, channel, {
          inputTokens,
          outputTokens,
          cacheTokens,
          cacheWriteTokens,
          authoritative: true,
        });
      } catch (error: any) {
        if (!billingSession.finalized) {
          try {
            await markPendingOnce(clientCancelled
              ? "messages_stream_client_cancelled"
              : "messages_openai_stream_ended_without_settlement");
          } catch (billingError: any) {
            console.error("[relayMessages] OpenAI 流式账务状态保存失败", billingError?.message || billingError);
          }
        }
        if (!clientCancelled) {
          const claudeErr = openAIErrorToClaude(502, error?.message || "stream error");
          try { controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(claudeErr)}\n\n`)); } catch {}
        }
      } finally {
        upstreamReader = null;
        try { controller.close(); } catch {}
      }
    },
      async cancel(reason) {
        clientCancelled = true;
        upstreamAbort.abort(reason);
        try { await upstreamReader?.cancel(reason); } catch {}
        if (!billingSession.finalized) {
          try {
            await markPendingOnce("messages_stream_client_cancelled");
          } catch (billingError: any) {
            console.error("[relayMessages] OpenAI 流式取消状态保存失败", billingError?.message || billingError);
          }
        }
      },
  });

  return { stream };
}

async function executeViaOpenAINonStream(
  openaiReq: any,
  upstreamModel: string,
  clientModel: string,
  channel: RelayChannel,
  baseUrl: string,
  apiKey: string,
  _ctx: RelayBillingContext,
  billingSession: RelayTextBillingSession,
): Promise<RelayMessagesResult> {
  let openaiResp: any;
  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    const res = await axios.post(
      joinProviderApiPath(baseUrl, "v1/chat/completions"),
      { ...openaiReq, model: upstreamModel, stream: false },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": billingSession.requestId,
          "X-Request-Id": billingSession.requestId,
        },
        timeout: channel.timeoutMs || 120000,
      },
    );
    openaiResp = res.data;
  } catch (err: any) {
    throw uncertainMessagesUpstreamError(err, "供应商调用失败");
  }

  const inputTokens = readUsageInteger(openaiResp?.usage?.prompt_tokens, true);
  const outputTokens = readUsageInteger(openaiResp?.usage?.completion_tokens, true);
  const cacheTokens = readUsageInteger(openaiResp?.usage?.prompt_tokens_details?.cached_tokens, false);
  const cacheWriteTokens = readUsageInteger(openaiResp?.usage?.prompt_tokens_details?.cache_write_tokens, false);
  if (inputTokens == null || outputTokens == null || cacheTokens == null || cacheWriteTokens == null) {
    throw new RelayMessagesError("OpenAI 兼容上游已响应但 Usage 不完整或无效", 502, true, true);
  }
  let claudeResp: any;
  try {
    claudeResp = openAIResponseToClaude(openaiResp, clientModel);
  } catch (error) {
    throw uncertainMessagesUpstreamError(error, "供应商已响应但协议转换失败");
  }
  return {
    response: claudeResp,
    usage: { inputTokens, outputTokens, cacheTokens, cacheWriteTokens, authoritative: true },
  };
}

// ============ 通用：预检 + 扣费 ============
function resolveUpstreamModel(channel: RelayChannel, requestedModel: string): string {
  const mapping = channel.config?.modelMapping as Record<string, string> | undefined;
  if (mapping && mapping[requestedModel]) return mapping[requestedModel];
  return requestedModel;
}
