// Responses 协议中转（/v1/responses，Codex 用的协议）。
// 根据上游通道类型自动选择路径：
//   - Codex 通道（ChatGPT 后端）：直通到 /backend-api/codex/responses
//   - 显式原生 OpenAI / Volcano 通道：直接调用 /v1/responses
//   - 旧 OpenAI 兼容通道：Responses 请求 → OpenAI Chat 请求，响应转回 Responses 格式
//
// 计费与其它中转共用同一套 o_pricing_rule + billApiTask（endpointType=text）。
import axios from "axios";
import { fetchRelayTextResponse } from "./relayTextTransport";
import { defaultGptOutputBudget, supportsGptContentEstimate } from "./relayTextEstimate";
import { isNativeResponsesChannel, responsesTransportConfigError } from "@/lib/responsesTransport";
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
import { resolveChannelApiKey, resolveChannelBaseUrl, withChannelApiKeyForDispatch } from "@/lib/relayChannelCredential";
import {
  assertOwnedNativeResponseReference,
  persistNativeResponseBinding,
} from "@/lib/responsesResourceBinding";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { assertOwnedVolcanoFilesInResponsesInput } from "@/lib/volcanoFileProxy";
import {
  responsesRequestToOpenAI,
  openAIResponseToResponses,
  createResponsesStreamConverter,
  type ResponsesRequest,
} from "@/lib/protocolConverter";

export class RelayResponsesError extends Error {
  statusCode: number;
  upstreamMayHaveAccepted: boolean;
  code: string;
  constructor(message: string, statusCode: number, upstreamMayHaveAccepted = true, code = "api_error") {
    super(safeResponsesErrorText(message));
    this.name = "RelayResponsesError";
    this.statusCode = statusCode;
    this.upstreamMayHaveAccepted = upstreamMayHaveAccepted;
    this.code = code;
  }
}

function safeResponsesErrorText(value: unknown): string {
  return redactSensitiveText(value)
    .replace(/https?:\/\/[^\s'"<>]+/gi, "[REDACTED_URL]")
    .slice(0, 2_000) || "Responses request failed";
}

function sanitizeResponsesErrorValue(value: unknown): unknown {
  if (typeof value === "string") return safeResponsesErrorText(value);
  if (Array.isArray(value)) return value.map(sanitizeResponsesErrorValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, sanitizeResponsesErrorValue(nested)]),
    );
  }
  return value;
}

function sanitizeNativeResponsesEvent(event: any): any {
  if (!event || typeof event !== "object") return event;
  if (event.type === "error") {
    return Object.fromEntries(
      Object.entries(event).map(([key, value]) => [
        key,
        key === "type" ? value : sanitizeResponsesErrorValue(value),
      ]),
    );
  }
  if (event.type === "response.failed" && event.response && typeof event.response === "object") {
    return {
      ...event,
      response: {
        ...event.response,
        error: sanitizeResponsesErrorValue(event.response.error),
      },
    };
  }
  return event;
}

function sanitizeNativeResponsesPayload(payload: any): any {
  if (!payload || typeof payload !== "object" || payload.status !== "failed") return payload;
  return { ...payload, error: sanitizeResponsesErrorValue(payload.error) };
}

async function persistNativeResponseBindingBestEffort(
  input: Parameters<typeof persistNativeResponseBinding>[0],
): Promise<void> {
  try {
    await persistNativeResponseBinding(input);
  } catch (error: any) {
    // The upstream response and authoritative usage already exist. Binding is
    // an access-control index for later retrieval and must never turn a paid,
    // successful creation into a retryable client failure or corrupt SSE billing.
    console.error("[relayResponses] Native Response 绑定保存失败", safeResponsesErrorText(error?.message || error));
  }
}

function assertResponsesChatFallbackSupported(input: ResponsesRequest): void {
  if (input.previous_response_id !== undefined && input.previous_response_id !== null) {
    throw new RelayResponsesError(
      "当前非 Codex 通道不支持 previous_response_id；请求未发送到上游",
      422,
      false,
      "unsupported_responses_field",
    );
  }
  if (input.conversation !== undefined && input.conversation !== null) {
    throw new RelayResponsesError(
      "当前非 Codex 通道不支持 conversation；请求未发送到上游",
      422,
      false,
      "unsupported_responses_field",
    );
  }
  if (!Array.isArray(input.input)) return;
  for (const item of input.input as any[]) {
    if (!item || !["message", "function_call", "function_call_output"].includes(String(item.type || ""))) {
      throw new RelayResponsesError(
        `当前非 Codex 通道不支持 Responses input 类型：${String(item?.type || "unknown")}`,
        422,
        false,
        "unsupported_responses_input",
      );
    }
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    const unsupportedBlock = item.content.find((block: any) =>
      !block || !["input_text", "output_text"].includes(String(block.type || "")),
    );
    if (unsupportedBlock) {
      throw new RelayResponsesError(
        `当前非 Codex 通道不支持 Responses content 类型：${String(unsupportedBlock?.type || "unknown")}`,
        422,
        false,
        "unsupported_responses_input",
      );
    }
  }
}

function assertVolcanoResponsesRequestSupported(input: ResponsesRequest): void {
  if (input.conversation !== undefined && input.conversation !== null) {
    throw new RelayResponsesError(
      "Volcano Responses 的 conversation 尚无租户绑定支持；请求未发送到上游",
      422,
      false,
      "unsupported_responses_conversation",
    );
  }
  if (!Array.isArray(input.tools)) return;
  const unsupportedTool = input.tools.find((tool: any) => String(tool?.type || "") !== "function");
  if (unsupportedTool) {
    throw new RelayResponsesError(
      `Volcano Responses 工具 ${String(unsupportedTool?.type || "unknown")} 尚无可结算价格；请求未发送到上游`,
      422,
      false,
      "unsupported_responses_tool_billing",
    );
  }
}

/** Native transport preserves protocol fields; shared-key resources and separately
 * priced hosted tools need an explicit ownership/billing contract before dispatch. */
export function assertOpenAINativeRequestSupported(input: ResponsesRequest): void {
  const reject = (message: string, code: string): never => { throw new RelayResponsesError(message, 422, false, code); };
  if (input.conversation != null) reject("conversation 尚无租户绑定支持；请使用 previous_response_id", "unsupported_responses_conversation");
  if (input.background === true) reject("background 模式尚无异步结算支持", "unsupported_responses_background");
  if (input.prompt != null) reject("共享上游的 prompt ID 尚无租户绑定支持", "unsupported_responses_resource");
  if (input.service_tier != null && input.service_tier !== "default") reject("当前定价仅支持 default service_tier", "unsupported_responses_service_tier");
  if (Array.isArray(input.tools) && input.tools.some((tool: any) => tool?.type !== "function" && tool?.type !== "custom")) {
    reject("上游托管工具尚无独立结算价格；可使用 function/custom 工具", "unsupported_responses_tool_billing");
  }
  const pending: unknown[] = Array.isArray(input.input) ? [...input.input] : [];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) { pending.push(...item); continue; }
    const value = item as Record<string, unknown>;
    if (value.type === "item_reference" || value.file_id != null) {
      reject("上游文件与 item_reference 尚无租户绑定支持；请提交内联内容或文件 URL", "unsupported_responses_resource");
    }
    pending.push(...Object.values(value));
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

function readNativeResponsesUsage(usage: any, providerLabel: string): RelayTextUsage {
  const inputTokens = readUsageInteger(usage?.input_tokens, true);
  const outputTokens = readUsageInteger(usage?.output_tokens, true);
  const cacheTokens = readUsageInteger(usage?.input_tokens_details?.cached_tokens, false);
  const cacheWriteTokens = readUsageInteger(usage?.input_tokens_details?.cache_write_tokens, false);
  if (inputTokens == null || outputTokens == null || cacheTokens == null || cacheWriteTokens == null) {
    throw new RelayResponsesError(`${providerLabel} 已响应但 Usage 不完整或无效`, 502, true);
  }
  return { inputTokens, outputTokens, cacheTokens, cacheWriteTokens, authoritative: true };
}

function hasPositiveNumericValue(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length && visited < 10_000) {
    visited += 1;
    const current = pending.pop();
    if (typeof current === "number" && Number.isFinite(current) && current > 0) return true;
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) pending.push(...current);
    else pending.push(...Object.values(current as Record<string, unknown>));
  }
  return false;
}

function hasUnpricedNativeToolUsage(usage: any): boolean {
  return hasPositiveNumericValue(usage?.tool_usage)
    || hasPositiveNumericValue(usage?.tool_usage_details);
}

function nativeToolUsageMetadata(usage: any): Record<string, unknown> {
  return {
    toolUsage: usage?.tool_usage ?? null,
    toolUsageDetails: usage?.tool_usage_details ?? null,
  };
}

function uncertainResponsesUpstreamError(error: unknown, fallback: string): RelayResponsesError {
  if (error instanceof RelayResponsesError) return error;
  const value = error as any;
  const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status);
  const message = value?.response?.data?.error?.message || value?.message || fallback;
  return new RelayResponsesError(
    String(message),
    Number.isFinite(status) ? status : 502,
    upstreamMayHaveAcceptedStatus(status),
  );
}

export interface RelayResponsesResult {
  stream?: ReadableStream<Uint8Array>;
  response?: any;
  usage?: RelayTextUsage;
  pendingReconcile?: {
    reason: string;
    metadata?: Record<string, unknown>;
  };
}

export async function executeRelayResponses(
  input: ResponsesRequest,
  ctx: RelayBillingContext,
): Promise<RelayResponsesResult> {
  const billingState: { current: RelayTextBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;
  let upstreamCompleted = false;
  try {
    const routed = await withChannelRetry(
      { endpointType: "text", model: input.model, workspaceId: ctx.workspaceId, retryPolicy: "disabled" },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        const upstreamModel = (channel.config?.modelMapping as Record<string, string> | undefined)?.[input.model] ?? input.model;
        const providerInput = channel.provider === "openai" && supportsGptContentEstimate(upstreamModel)
          && input.max_output_tokens == null
          ? { ...input, max_output_tokens: defaultGptOutputBudget() }
          : input;
        const transportError = responsesTransportConfigError(channel.provider, channel.endpointType, channel.config || {});
        if (transportError) throw new RelayResponsesError(transportError, 500, false, "invalid_responses_transport");
        if (channel.provider === "openai" && isNativeResponsesChannel(channel)) assertOpenAINativeRequestSupported(input);
        if (channel.provider !== "codex" && !isNativeResponsesChannel(channel)) {
          assertResponsesChatFallbackSupported(input);
        }
        if (channel.provider === "volcano") {
          assertVolcanoResponsesRequestSupported(input);
          await assertOwnedVolcanoFilesInResponsesInput(input.input, ctx, channel);
        }
        if (isNativeResponsesChannel(channel)) {
          if (input.previous_response_id !== undefined && input.previous_response_id !== null) {
            await assertOwnedNativeResponseReference({
              responseId: input.previous_response_id,
              owner: ctx,
              channel,
            });
          }
        }
        if (!billingState.current) {
          billingState.current = await beginRelayTextBilling({
            source: "relay-responses",
            model: input.model,
            channel,
            context: ctx,
            requestPayload: providerInput,
            maxOutputTokens: providerInput.max_output_tokens,
            estimateModel: upstreamModel,
          });
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }
        if (channel.provider === "codex") {
          return executeCodexDirect(input, channel, ctx, billingState.current);
        }
        if (isNativeResponsesChannel(channel)) {
          return executeViaNativeResponses(providerInput, channel, ctx, billingState.current);
        }
        return executeViaOpenAI(providerInput, channel, ctx, billingState.current);
      },
    );
    if (!routed.result.stream) {
      upstreamCompleted = true;
      if (!billingState.current) throw new BillingError("计费预扣会话未创建", 500);
      if (routed.result.pendingReconcile) {
        const usage = routed.result.usage;
        await markRelayBillingPending(billingState.current, routed.channel, {
          units: Number(usage?.inputTokens || 0)
            + Number(usage?.outputTokens || 0)
            + Number(usage?.cacheWriteTokens || 0),
          costMicros: 0,
          reason: routed.result.pendingReconcile.reason,
          metadata: {
            inputTokens: Number(usage?.inputTokens || 0),
            outputTokens: Number(usage?.outputTokens || 0),
            cacheTokens: Number(usage?.cacheTokens || 0),
            cacheWriteTokens: Number(usage?.cacheWriteTokens || 0),
            ...(routed.result.pendingReconcile.metadata || {}),
          },
        });
      } else {
        await settleRelayTextBilling(billingState.current, routed.channel, routed.result.usage);
      }
      if (
        isNativeResponsesChannel(routed.channel)
        && routed.result.response?.id
        && (ctx.apiKeyId || ctx.principalId)
      ) {
        await persistNativeResponseBindingBestEffort({
          response: routed.result.response,
          owner: ctx,
          channel: routed.channel,
          model: input.model,
          upstreamModel: resolveUpstreamModel(routed.channel, input.model),
        });
      }
    }
    return routed.result;
  } catch (error: any) {
    if (billingState.current && !billingState.current.finalized && !upstreamCompleted) {
      if (!billingState.current.dispatchStarted) {
        await releaseRelayBillingSession(
          billingState.current,
          "Responses 调用上游前失败，释放预扣",
          "not_dispatched",
        );
      } else if (error instanceof RelayResponsesError && !error.upstreamMayHaveAccepted) {
        await releaseRelayBillingSession(
          billingState.current,
          "Responses 上游明确拒绝且未产生成本，释放预扣",
          "definitive_not_billable",
        );
      } else if (activeChannel) {
        try {
          await markRelayBillingPending(billingState.current, activeChannel, {
            units: 0,
            costMicros: 0,
            reason: "responses_upstream_outcome_unknown",
          });
        } catch (billingError: any) {
          console.error("[relayResponses] 保存待核账状态失败", billingError?.message || billingError);
        }
      }
    }
    throw error;
  }
}

// ============ Codex 通道直通（ChatGPT 后端） ============
async function executeCodexDirect(
  input: ResponsesRequest,
  channel: RelayChannel,
  ctx: RelayBillingContext,
  billingSession: RelayTextBillingSession,
): Promise<RelayResponsesResult> {
  // Codex 通道的 apiKey 是含 access_token + account_id 的 JSON
  const oauth = parseCodexOAuthKey(resolveChannelApiKey(channel));
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!baseUrl) throw new RelayResponsesError("供应商通道未配置 baseUrl", 500);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${oauth.accessToken}`,
    "chatgpt-account-id": oauth.accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "Content-Type": "application/json",
    "Idempotency-Key": billingSession.requestId,
    "X-Request-Id": billingSession.requestId,
  };

  // Codex 后端要求 store=false，强制注入 instructions
  const body = { ...input, store: false };

  if (input.stream) {
    const upstreamAbort = new AbortController();
    let response: Response;
    await markRelayBillingDispatchStarted(billingSession, channel);
    try {
      response = await fetch(`${baseUrl}/backend-api/codex/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([upstreamAbort.signal, AbortSignal.timeout(channel.timeoutMs || 120000)]),
      });
    } catch (error) {
      throw uncertainResponsesUpstreamError(error, "Codex 流式请求结果未知");
    }
    if (!response.ok) {
      const errBody = await response.text();
      throw new RelayResponsesError(errBody, response.status, upstreamMayHaveAcceptedStatus(response.status));
    }
    if (!response.body) throw new RelayResponsesError("上游未返回响应流", 502, true);
    // 流式直通，解析 usage 计费
    return {
      stream: pipeStreamWithUsageTracking(response, channel, billingSession, upstreamAbort, {
        providerLabel: "Codex",
        reasonPrefix: "codex",
      }),
    };
  }

  let res: Response;
  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    res = await fetch(`${baseUrl}/backend-api/codex/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(channel.timeoutMs || 120000),
    });
  } catch (error) {
    throw uncertainResponsesUpstreamError(error, "Codex 请求结果未知");
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new RelayResponsesError(errBody, res.status, upstreamMayHaveAcceptedStatus(res.status));
  }
  let resp: any;
  try {
    resp = await res.json();
  } catch (error) {
    throw uncertainResponsesUpstreamError(error, "Codex 已响应但响应体无法解析");
  }
  return {
    response: resp,
    usage: readNativeResponsesUsage(resp?.usage, "Codex"),
  };
}

function parseCodexOAuthKey(key: string): { accessToken: string; accountId: string } {
  try {
    const parsed = JSON.parse(key);
    return {
      accessToken: parsed.access_token || "",
      accountId: parsed.account_id || "",
    };
  } catch {
    // 不是 JSON，当作普通 token
    return { accessToken: key, accountId: "" };
  }
}

// ============ OpenAI / Volcano 原生 Responses ============
export async function executeViaNativeResponses(
  input: ResponsesRequest,
  channel: RelayChannel,
  ctx: RelayBillingContext,
  billingSession: RelayTextBillingSession,
): Promise<RelayResponsesResult> {
  const providerLabel = channel.provider === "volcano" ? "Volcano" : "OpenAI";
  const reasonPrefix = channel.provider === "volcano" ? "volcano" : "openai_native";
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!baseUrl) throw new RelayResponsesError("供应商通道未配置 baseUrl", 500, false);

  const upstreamModel = resolveUpstreamModel(channel, input.model);
  const url = joinProviderApiPath(baseUrl, "v1/responses");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": billingSession.requestId,
    "X-Request-Id": billingSession.requestId,
  };
  const body = { ...input, model: upstreamModel, ...(channel.provider === "openai" ? { service_tier: "default" } : {}) };

  const dispatch = (payload: unknown, signal: AbortSignal) => withChannelApiKeyForDispatch(
    channel,
    {channelId:channel.id,provider:channel.provider,endpointType:"text",model:input.model},
    apiKey => {
      if(!apiKey) throw new RelayResponsesError("供应商通道未配置 apiKey",500,false);
      return {response:fetchRelayTextResponse(url,{method:"POST",headers:{...headers,Authorization:`Bearer ${apiKey}`},body:JSON.stringify(payload),signal},channel.timeoutMs || 120000)};
    },
    channel.provider === "volcano" ? ["VOLCANO_ARK_API_KEY"] : [],
  ).response;

  if (input.stream) {
    const upstreamAbort = new AbortController();
    let response: Response;
    await markRelayBillingDispatchStarted(billingSession, channel);
    try {
      response = await dispatch({...body,stream:true},AbortSignal.any([upstreamAbort.signal,AbortSignal.timeout(channel.timeoutMs || 120000)]));
    } catch (error) {
      throw uncertainResponsesUpstreamError(error, `${providerLabel} Responses 流式请求结果未知`);
    }
    if (!response.ok) {
      throw new RelayResponsesError(
        (await response.text()).slice(0, 2_000),
        response.status,
        upstreamMayHaveAcceptedStatus(response.status),
      );
    }
    if (!response.body) throw new RelayResponsesError("上游未返回响应流", 502, true);
    return {
      stream: pipeStreamWithUsageTracking(response, channel, billingSession, upstreamAbort, {
        providerLabel,
        reasonPrefix,
        reconcileNativeToolUsage: true,
        onTerminal: (terminalResponse) => {
          if (!terminalResponse?.id || (!ctx.apiKeyId && !ctx.principalId)) return Promise.resolve();
          return persistNativeResponseBindingBestEffort({
            response: terminalResponse,
            owner: ctx,
            channel,
            model: input.model,
            upstreamModel,
          });
        },
      }),
    };
  }

  let response: Response;
  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    response = await dispatch({...body,stream:false},AbortSignal.timeout(channel.timeoutMs || 120000));
  } catch (error) {
    throw uncertainResponsesUpstreamError(error, `${providerLabel} Responses 请求结果未知`);
  }
  if (!response.ok) {
    throw new RelayResponsesError(
      (await response.text()).slice(0, 2_000),
      response.status,
      upstreamMayHaveAcceptedStatus(response.status),
    );
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    throw uncertainResponsesUpstreamError(error, `${providerLabel} Responses 已响应但响应体无法解析`);
  }
  if (payload?.status === "failed" && !payload?.usage) {
    return {
      response: sanitizeNativeResponsesPayload(payload),
      pendingReconcile: { reason: `responses_${reasonPrefix}_failed_without_usage` },
    };
  }
  const usage = readNativeResponsesUsage(payload?.usage, providerLabel);
  return {
    response: sanitizeNativeResponsesPayload(payload),
    usage,
    ...(hasUnpricedNativeToolUsage(payload?.usage)
      ? {
          pendingReconcile: {
            reason: `responses_${reasonPrefix}_tool_usage_unpriced`,
            metadata: nativeToolUsageMetadata(payload?.usage),
          },
        }
      : {}),
  };
}

// ============ OpenAI 兼容通道（转换路径） ============
async function executeViaOpenAI(
  input: ResponsesRequest,
  channel: RelayChannel,
  ctx: RelayBillingContext,
  billingSession: RelayTextBillingSession,
): Promise<RelayResponsesResult> {
  const apiKey = resolveChannelApiKey(channel);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!apiKey) throw new RelayResponsesError("供应商通道未配置 apiKey", 500);
  if (!baseUrl) throw new RelayResponsesError("供应商通道未配置 baseUrl", 500);

  const openaiReq = responsesRequestToOpenAI(input);
  const upstreamModel = resolveUpstreamModel(channel, input.model);
  if (channel.provider === "openai" && supportsGptContentEstimate(upstreamModel) && openaiReq.max_tokens != null) {
    (openaiReq as any).max_completion_tokens = openaiReq.max_tokens;
    delete openaiReq.max_tokens;
  }

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
): Promise<RelayResponsesResult> {
  const converter = createResponsesStreamConverter(clientModel);
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
    throw uncertainResponsesUpstreamError(error, "OpenAI 兼容流式请求结果未知");
  }
  if (!response.ok) {
    throw new RelayResponsesError(
      (await response.text()).slice(0, 2000),
      response.status,
      upstreamMayHaveAcceptedStatus(response.status),
    );
  }
  if (!response.body) throw new RelayResponsesError("上游未返回响应流", 502, true);
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
            ? "responses_openai_stream_terminal_event_missing"
            : "responses_openai_stream_usage_incomplete");
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
              ? "responses_stream_client_cancelled"
              : "responses_openai_stream_ended_without_settlement");
          } catch (billingError: any) {
            console.error("[relayResponses] OpenAI 流式账务状态保存失败", billingError?.message || billingError);
          }
        }
        if (!clientCancelled) {
          try {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: { message: error?.message || "stream error" } })}\n\n`));
          } catch {}
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
          await markPendingOnce("responses_stream_client_cancelled");
        } catch (billingError: any) {
          console.error("[relayResponses] OpenAI 流式取消状态保存失败", billingError?.message || billingError);
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
): Promise<RelayResponsesResult> {
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
    throw uncertainResponsesUpstreamError(err, "供应商调用失败");
  }

  const inputTokens = readUsageInteger(openaiResp?.usage?.prompt_tokens, true);
  const outputTokens = readUsageInteger(openaiResp?.usage?.completion_tokens, true);
  const cacheTokens = readUsageInteger(openaiResp?.usage?.prompt_tokens_details?.cached_tokens, false);
  const cacheWriteTokens = readUsageInteger(openaiResp?.usage?.prompt_tokens_details?.cache_write_tokens, false);
  if (inputTokens == null || outputTokens == null || cacheTokens == null || cacheWriteTokens == null) {
    throw new RelayResponsesError("OpenAI 兼容上游已响应但 Usage 不完整或无效", 502, true);
  }
  let responsesResp: any;
  try {
    responsesResp = openAIResponseToResponses(openaiResp, clientModel);
  } catch (error) {
    throw uncertainResponsesUpstreamError(error, "供应商已响应但协议转换失败");
  }
  return {
    response: responsesResp,
    usage: { inputTokens, outputTokens, cacheTokens, cacheWriteTokens, authoritative: true },
  };
}

// ============ 通用：流式透传与 Usage 结算 ============
function resolveUpstreamModel(channel: RelayChannel, requestedModel: string): string {
  const mapping = channel.config?.modelMapping as Record<string, string> | undefined;
  if (mapping && mapping[requestedModel]) return mapping[requestedModel];
  return requestedModel;
}

function pipeStreamWithUsageTracking(
  response: Response,
  channel: RelayChannel,
  billingSession: RelayTextBillingSession,
  upstreamAbort: AbortController,
  options: {
    providerLabel: string;
    reasonPrefix: string;
    reconcileNativeToolUsage?: boolean;
    onTerminal?: (response: any) => Promise<void>;
  },
): ReadableStream<Uint8Array> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  let cacheWriteTokens = 0;
  let sawTerminalEvent = false;
  let sawAuthoritativeUsage = false;
  let sawUpstreamErrorEvent = false;
  let sawUnpricedToolUsage = false;
  let toolUsageMetadata: Record<string, unknown> = {};
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let clientCancelled = false;
  let pendingPromise: Promise<void> | null = null;
  const encoder = new TextEncoder();
  const responseBody = response.body;
  const streamStartedAt = Date.now();
  let terminalPromise: Promise<void> | null = null;

  const markPendingOnce = (reason: string): Promise<void> => {
    if (billingSession.finalized) return Promise.resolve();
    if (!pendingPromise) {
      pendingPromise = markRelayBillingPending(billingSession, channel, {
        units: inputTokens + outputTokens + cacheWriteTokens,
        costMicros: 0,
        reason,
        metadata: {
          inputTokens,
          outputTokens,
          cacheTokens,
          cacheWriteTokens,
          sawAuthoritativeUsage,
          sawTerminalEvent,
          streamElapsedMs: Date.now() - streamStartedAt,
          ...toolUsageMetadata,
        },
      });
    }
    return pendingPromise;
  };

  const settleTerminalOnce = (response?: any): Promise<void> => {
    if (!terminalPromise) {
      // Claim this path before awaiting resource persistence/ledger writes.
      // A disconnect after authoritative terminal usage must await the same
      // settlement, not compete with it by freezing an unknown outcome.
      terminalPromise = (async () => {
        if (response && options.onTerminal) await options.onTerminal(response);
        if (sawUnpricedToolUsage) {
          await markPendingOnce(`responses_${options.reasonPrefix}_tool_usage_unpriced`);
        } else {
          await settleRelayTextBilling(billingSession, channel, {
            inputTokens, outputTokens, cacheTokens, cacheWriteTokens, authoritative: true,
          });
        }
      })();
    }
    return terminalPromise;
  };

  const updateUsage = (usage: any): boolean => {
    if (!usage) return false;
    if (options.reconcileNativeToolUsage && hasUnpricedNativeToolUsage(usage)) {
      sawUnpricedToolUsage = true;
      toolUsageMetadata = nativeToolUsageMetadata(usage);
    }
    const observedInputTokens = readUsageInteger(usage.input_tokens, true);
    const observedOutputTokens = readUsageInteger(usage.output_tokens, true);
    const observedCacheTokens = readUsageInteger(usage.input_tokens_details?.cached_tokens, false);
    const observedCacheWriteTokens = readUsageInteger(usage.input_tokens_details?.cache_write_tokens, false);
    if (
      observedInputTokens == null ||
      observedOutputTokens == null ||
      observedCacheTokens == null ||
      observedCacheWriteTokens == null
    ) return false;
    inputTokens = observedInputTokens;
    outputTokens = observedOutputTokens;
    cacheTokens = observedCacheTokens;
    cacheWriteTokens = observedCacheWriteTokens;
    return true;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!responseBody) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: { message: "上游未返回响应流" } })}\n\n`));
        if (!billingSession.finalized) {
          await markRelayBillingPending(billingSession, channel, {
            units: 0,
            costMicros: 0,
            reason: `responses_${options.reasonPrefix}_stream_body_missing`,
          });
        }
        controller.close();
        return;
      }
      const reader = responseBody.getReader();
      upstreamReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        const forwardFrame = async (frame: string, ending: string): Promise<void> => {
          let forwardedFrame = frame;
          const lines = frame.split(/\r?\n/);
          const data = lines.filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          let evt: any = null;
          try { evt = JSON.parse(data); } catch { /* comments and [DONE] are passed through */ }
          if (evt && typeof evt === "object") {
            const hasUsage = updateUsage(evt.response?.usage || evt.usage);
            const isResponseTerminal = ["response.completed", "response.incomplete", "response.failed"]
              .includes(String(evt.type || ""));
            if (isResponseTerminal || evt.type === "error") {
              sawTerminalEvent = true;
              sawAuthoritativeUsage = hasUsage;
            }
            if (evt.type === "error" || evt.type === "response.failed") sawUpstreamErrorEvent = true;
            if (isResponseTerminal && hasUsage) await settleTerminalOnce(evt.response);
            const sanitized = sanitizeNativeResponsesEvent(evt);
            if (sanitized !== evt) {
              forwardedFrame = [...lines.filter((line) => !line.startsWith("data:")), `data: ${JSON.stringify(sanitized)}`].join("\n");
            }
          }
          if (!clientCancelled) controller.enqueue(encoder.encode(forwardedFrame + ending));
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let delimiter: RegExpExecArray | null;
          while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, delimiter.index);
            buffer = buffer.slice(delimiter.index + delimiter[0].length);
            await forwardFrame(frame, delimiter[0]);
            if (sawTerminalEvent && sawAuthoritativeUsage) break;
          }
          // A Responses terminal event ends the generation. Do not wait for
          // transport EOF (or a proxy timeout) after accounting is complete.
          if (sawTerminalEvent && sawAuthoritativeUsage) {
            buffer = "";
            // Authoritative completion has already been settled and forwarded.
            // Transport cleanup cannot turn that completed result into an error.
            try { await reader.cancel(); } catch {}
            break;
          }
        }
        buffer += decoder.decode();
        if (buffer) await forwardFrame(buffer, "");
        if (clientCancelled) return;
        if (!sawTerminalEvent || !sawAuthoritativeUsage) {
          await markPendingOnce(!sawTerminalEvent
            ? `responses_${options.reasonPrefix}_stream_terminal_event_missing`
            : `responses_${options.reasonPrefix}_stream_usage_incomplete`);
          throw new BillingError(`${options.providerLabel} 响应流终态或 Usage 不完整，预扣已保留待核账`, 502);
        }
        await settleTerminalOnce();
      } catch (error: any) {
        if (!billingSession.finalized) {
          try {
            await markPendingOnce(clientCancelled
              ? "responses_stream_client_cancelled"
              : `responses_${options.reasonPrefix}_stream_ended_without_settlement`);
          } catch (billingError: any) {
            console.error(
              `[relayResponses] ${options.providerLabel} 流式账务状态保存失败`,
              billingError?.message || billingError,
            );
          }
        }
        if (!clientCancelled && !sawUpstreamErrorEvent) {
          try {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
              error: { message: safeResponsesErrorText(error?.message || "stream error") },
            })}\n\n`));
          } catch {}
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
      if (terminalPromise) {
        try { await terminalPromise; } catch { /* preserve a failed settlement for reconciliation below */ }
      }
      if (!billingSession.finalized) {
        try {
          await markPendingOnce("responses_stream_client_cancelled");
        } catch (billingError: any) {
          console.error(
            `[relayResponses] ${options.providerLabel} 流式取消状态保存失败`,
            billingError?.message || billingError,
          );
        }
      }
    },
  });
}
