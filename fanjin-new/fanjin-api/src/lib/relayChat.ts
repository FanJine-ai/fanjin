import { fetchRelayTextResponse } from "./relayTextTransport";
import { db } from "@/utils/db";
import { isNativeResponsesChannel } from "./responsesTransport";
import { defaultGptOutputBudget, supportsGptContentEstimate } from "./relayTextEstimate";
import { chatToNativeResponses, nativeResponseToChat, nativeResponsesStreamToChat } from "./nativeResponsesChat";
// LLM 中转：OpenAI 兼容的 chat/completions 同步流式调用。
// 与视频中转不同，LLM 是同步流式返回，不走 relay 异步任务表，
// 而是直接调用供应商并流式回传，结束后按真实 token 扣费。
//
// 计费链路与创作台、视频中转共用同一套 o_pricing_rule + billApiTask。
// 复用 selectChannel 选通道（按 endpointType=text + model 匹配 o_model_route / o_provider_channel）。
import type { RelayChannel } from "@/lib/relay";
import { joinProviderApiPath, withChannelRetry } from "@/lib/channelRouter";
import { BillingError } from "@/lib/billing";
import {
  beginRelayTextBilling,
  markRelayBillingDispatchStarted,
  markRelayBillingPending,
  releaseRelayBillingSession,
  settleRelayTextBilling,
  type RelayTextBillingSession,
} from "@/lib/relayBillingSession";
import {
  resolveChannelBaseUrl,
  withChannelApiKeyForDispatch,
} from "@/lib/relayChannelCredential";

export function canNormalizeMissingTextFinish(input: {
  sawDone: boolean;
  hasUsage: boolean;
  sawTextDelta: boolean;
  sawToolCallDelta: boolean;
}): boolean {
  return input.sawDone
    && input.hasUsage
    && input.sawTextDelta
    && !input.sawToolCallDelta;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | any[];
}

export interface RelayChatRequest {
  [key: string]: unknown;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  stream?: boolean;
  stream_options?: Record<string, unknown>;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  parallel_tool_calls?: boolean;
  // OpenAI 兼容扩展
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
}

// 从通道 config 解析出实际要调用的上游模型名
function resolveUpstreamModel(channel: RelayChannel, requestedModel: string): string {
  const config = channel.config || {};
  // 支持模型名映射：config.modelMapping = { "gpt-4o": "gpt-4o-2024-08-06" }
  const mapping = config.modelMapping as Record<string, string> | undefined;
  if (mapping && mapping[requestedModel]) return mapping[requestedModel];
  return requestedModel;
}

const OPENAI_REQUEST_PROFILE_OMIT_FIELDS = new Set(["temperature", "top_p"]);
const OPENAI_REQUEST_PROFILE_KEYS = new Set(["omit", "maxOutputTokensField", "thinkingType"]);
const OPENAI_OUTPUT_TOKEN_FIELDS = new Set(["max_tokens", "max_completion_tokens"]);

type OpenAIOutputTokenField = "max_tokens" | "max_completion_tokens";
type OpenAICompatibleRequestProfile = {
  omit: Array<"temperature" | "top_p">;
  maxOutputTokensField?: OpenAIOutputTokenField;
  thinkingType?: "enabled" | "disabled" | "auto";
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidOpenAIRequestProfile(reason: string): never {
  throw new RelayChatError(`供应商通道 request profile 配置无效：${reason}`, 500, false);
}

function parseOpenAICompatibleRequestProfiles(
  rawProfiles: unknown,
): Map<string, OpenAICompatibleRequestProfile> {
  if (rawProfiles === undefined) return new Map();
  if (!isPlainRecord(rawProfiles)) invalidOpenAIRequestProfile("modelRequestProfiles 必须是对象");

  const profiles = new Map<string, OpenAICompatibleRequestProfile>();
  for (const [model, rawProfile] of Object.entries(rawProfiles)) {
    if (!model || model !== model.trim()) invalidOpenAIRequestProfile("模型名必须是非空且无首尾空格的字符串");
    if (!isPlainRecord(rawProfile)) invalidOpenAIRequestProfile(`${model} 必须是对象`);
    const unknownKeys = Object.keys(rawProfile).filter((key) => !OPENAI_REQUEST_PROFILE_KEYS.has(key));
    if (unknownKeys.length) invalidOpenAIRequestProfile(`${model} 包含未知字段`);

    const rawOmit = rawProfile.omit;
    if (rawOmit !== undefined && !Array.isArray(rawOmit)) {
      invalidOpenAIRequestProfile(`${model}.omit 必须是数组`);
    }
    const omit = (rawOmit || []).map((field) => String(field));
    if (
      omit.some((field) => !OPENAI_REQUEST_PROFILE_OMIT_FIELDS.has(field))
      || new Set(omit).size !== omit.length
    ) {
      invalidOpenAIRequestProfile(`${model}.omit 包含无效或重复字段`);
    }

    const rawMaxOutputTokensField = rawProfile.maxOutputTokensField;
    if (
      rawMaxOutputTokensField !== undefined
      && (
        typeof rawMaxOutputTokensField !== "string"
        || !OPENAI_OUTPUT_TOKEN_FIELDS.has(rawMaxOutputTokensField)
      )
    ) {
      invalidOpenAIRequestProfile(`${model}.maxOutputTokensField 无效`);
    }
    const thinkingType = rawProfile.thinkingType;
    if (thinkingType !== undefined && !["enabled", "disabled", "auto"].includes(String(thinkingType))) {
      invalidOpenAIRequestProfile(`${model}.thinkingType 无效`);
    }
    profiles.set(model, {
      omit: omit as OpenAICompatibleRequestProfile["omit"],
      ...(thinkingType ? { thinkingType: thinkingType as OpenAICompatibleRequestProfile["thinkingType"] } : {}),
      ...(rawMaxOutputTokensField
        ? { maxOutputTokensField: rawMaxOutputTokensField as OpenAIOutputTokenField }
        : {}),
    });
  }
  return profiles;
}

/**
 * Apply an explicitly configured per-model compatibility profile immediately
 * before the OpenAI-compatible provider boundary. An absent profile is a
 * strict passthrough so existing models retain their current request surface.
 */
export function applyOpenAICompatibleRequestProfile(
  input: RelayChatRequest,
  channelConfig: Record<string, unknown>,
  upstreamModel: string,
): RelayChatRequest {
  const profiles = parseOpenAICompatibleRequestProfiles(channelConfig.modelRequestProfiles);
  // Profiles describe the provider-facing contract. Public aliases must not
  // activate a transform unless their final mapped upstream model has an
  // explicit profile of its own.
  const profile = profiles.get(upstreamModel);
  if (!profile) return input;

  const transformed: RelayChatRequest = { ...input };
  if (profile.thinkingType && transformed.thinking === undefined) {
    transformed.thinking = { type: profile.thinkingType };
  }
  for (const field of profile.omit) {
    delete (transformed as Record<string, unknown>)[field];
  }
  if (profile.maxOutputTokensField) {
    const targetField = profile.maxOutputTokensField;
    const alternateField = targetField === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    const explicitTargetValue = transformed[targetField];
    const alternateValue = transformed[alternateField];
    if (
      explicitTargetValue !== undefined
      && alternateValue !== undefined
      && explicitTargetValue !== alternateValue
    ) {
      throw new RelayChatError(
        "max_tokens 与 max_completion_tokens 不能同时指定不同值",
        400,
        false,
      );
    }
    const targetValue = explicitTargetValue ?? alternateValue;
    if (targetValue !== undefined) transformed[targetField] = targetValue;
    delete transformed[alternateField];
  }
  return transformed;
}

export interface RelayChatResult {
  // 流式模式：返回 ReadableStream（SSE 格式）
  stream?: ReadableStream<Uint8Array>;
  // 非流式模式：返回完整响应
  response?: any;
  // 用于计费的 token 用量（流式在结束后填充）
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    authoritative: true;
  };
}

import { extractionSupportsThinkingControl, relayChatPurposeTimeout } from "./relayChatPurpose";

export interface RelayChatContext {
  workspaceId: string;
  apiKeyId: string | null;
  principalId?: string | null;
  channelId?: string | null;
  requestId?: string | null;
  idempotencyKey?: string | null;
  reservationCostMicros?: number | null;
  allowSettlementOverage?: boolean;
  // Server-owned purpose, never read from the public relay request body.
  purpose?: "script_asset_extraction";
  onBillingSettled?(billing: { costMicros: number; usage: Record<string, unknown> }): Promise<void>;
}

export function applyRelayChatPurpose(
  input: RelayChatRequest,
  upstreamModel: string,
  purpose: RelayChatContext["purpose"],
): RelayChatRequest {
  // Asset extraction needs a bounded JSON answer. Optional automatic thinking
  // can spend the proxy's entire response window before the first content
  // token, even with stream=true. Match the final provider model, not aliases.
  // Ark's chat contract: https://docs.volcengine.com/docs/ark/chat-api?lang=zh
  if (
    purpose === "script_asset_extraction"
    && extractionSupportsThinkingControl(upstreamModel)
    && input.thinking === undefined
  ) {
    return { ...input, thinking: { type: "disabled" } };
  }
  return input;
}

type RelayChatBillingSession = RelayTextBillingSession;

/**
 * 执行 LLM 中转调用。
 * 调用成功后按输入/输出/缓存分价扣费（与创作台同一套定价规则）。
 * 支持 Reasoning Effort 后缀解析和 Thinking-to-content。
 */
export async function executeRelayChat(
  input: RelayChatRequest,
  ctx: RelayChatContext,
): Promise<RelayChatResult> {
  // Reasoning Effort 后缀解析：o3-mini-high → { model: "o3-mini", reasoningEffort: "high" }
  const { parseReasoningEffort, thinkingToContent } = await import("@/lib/protocolConverter");
  const parsed = parseReasoningEffort(input.model);
  const effectiveInput: RelayChatRequest = { ...input, model: parsed.model };
  if (parsed.reasoningEffort) {
    (effectiveInput as any).reasoning_effort = parsed.reasoningEffort;
  }
  validateMaxOutputTokens(effectiveInput.max_tokens, "max_tokens");
  validateMaxOutputTokens(effectiveInput.max_completion_tokens, "max_completion_tokens");
  if (effectiveInput.max_tokens != null && effectiveInput.max_completion_tokens != null
    && effectiveInput.max_tokens !== effectiveInput.max_completion_tokens) {
    throw new RelayChatError("max_tokens 与 max_completion_tokens 不能同时指定不同值", 400, false);
  }

  const billingState: { current: RelayChatBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;
  let upstreamCompleted = false;

  try {
    const routed = await withChannelRetry(
      { endpointType: "text", model: parsed.model, workspaceId: ctx.workspaceId, retryPolicy: "disabled" },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        const upstreamModel = channel.provider === "anthropic"
          ? effectiveInput.model
          : resolveUpstreamModel(channel, effectiveInput.model);
        const boundedInput = channel.provider === "openai" && supportsGptContentEstimate(upstreamModel)
          && effectiveInput.max_tokens == null && effectiveInput.max_completion_tokens == null
          ? { ...effectiveInput, max_completion_tokens: defaultGptOutputBudget() }
          : effectiveInput;
        // Validate and normalize the provider request before billing
        // reservation or dispatch. A malformed operator profile therefore
        // cannot create a freeze or touch the upstream.
        const providerInput = channel.provider === "anthropic"
          ? effectiveInput
          : applyOpenAICompatibleRequestProfile(
              applyRelayChatPurpose({ ...boundedInput, model: upstreamModel }, upstreamModel, ctx.purpose),
              channel.config || {},
              upstreamModel,
            );
        let nativeInput;
        if (channel.provider === "openai" && isNativeResponsesChannel(channel)) {
          try {
            nativeInput = chatToNativeResponses({...providerInput,model:effectiveInput.model});
            const { assertOpenAINativeRequestSupported } = await import("./relayResponses");
            assertOpenAINativeRequestSupported(nativeInput);
          }
          catch (error:any) { throw new RelayChatError(error.message,422,false); }
        }
        if (!billingState.current) {
          billingState.current = await beginRelayChatBilling(
            { ...providerInput, model: effectiveInput.model }, channel, ctx, upstreamModel,
          );
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }
        const billingSession = billingState.current;

        // Anthropic 上游：OpenAI 请求 → Claude 请求，Claude 响应 → OpenAI 响应
        if (channel.provider === "anthropic") {
          return executeViaAnthropic({
            ...effectiveInput,
            max_tokens: effectiveInput.max_tokens ?? effectiveInput.max_completion_tokens ?? 4_096,
          }, channel, ctx, billingSession);
        }
        if (nativeInput) {
          const { executeViaNativeResponses, RelayResponsesError } = await import("./relayResponses");
          try {
            const result = await executeViaNativeResponses(nativeInput,channel,ctx,billingSession);
            if (result.pendingReconcile) throw new RelayChatError("原生 Responses 用量需要核账",502,true);
            if (result.stream) return {stream:nativeResponsesStreamToChat(result.stream,effectiveInput.model,async()=>{
              if (ctx.onBillingSettled) {
                const row=await db("o_usage_record").where({id:billingSession.usageRecordId,workspaceId:billingSession.workspaceId}).first("status","costMicros");
                if(row?.status!=="charged")throw new BillingError("原生 Responses 未完成结算",502);
                await ctx.onBillingSettled({costMicros:Number(row.costMicros),usage:{usageRecordId:billingSession.usageRecordId,billingStatus:row.status}});
              }
            })};
            const usage=result.usage;
            if(result.response?.status === "failed") {
              await settleRelayChatBilling(billingSession,channel,usage ? {...usage,cacheTokens:usage.cacheTokens||0,cacheWriteTokens:usage.cacheWriteTokens||0,totalTokens:usage.inputTokens+usage.outputTokens+(usage.cacheWriteTokens||0),authoritative:true} : undefined,ctx);
              throw new RelayChatError("模型未能完成本次请求",502,true);
            }
            return {response:nativeResponseToChat(result.response,effectiveInput.model),usage:usage?{...usage,cacheTokens:usage.cacheTokens||0,cacheWriteTokens:usage.cacheWriteTokens||0,totalTokens:usage.inputTokens+usage.outputTokens+(usage.cacheWriteTokens||0),authoritative:true as const}:undefined};
          } catch(error) {
            if(error instanceof RelayResponsesError) throw new RelayChatError(error.message,error.statusCode,error.upstreamMayHaveAccepted);
            throw error;
          }
        }
        // OpenAI 兼容上游：协议直通。不能经由纯文本 generateText
        // 重建响应，否则 tool calls、structured output 和 finish_reason 会丢失。
        return executeViaOpenAICompatible(
          providerInput,
          effectiveInput.model,
          channel,
          ctx,
          billingSession,
        );
      },
    );

    if (!routed.result.stream) {
      upstreamCompleted = true;
      if (!billingState.current) throw new BillingError("计费预扣会话未创建", 500);
      await settleRelayChatBilling(billingState.current, routed.channel, routed.result.usage, ctx);
    }
    return routed.result;
  } catch (err: any) {
    if (billingState.current && !billingState.current.finalized && !upstreamCompleted) {
      if (!billingState.current.dispatchStarted) {
        await releaseRelayChatBilling(billingState.current, "Chat 调用上游前失败，释放预扣", "not_dispatched");
      } else if (err instanceof RelayChatError && !err.upstreamMayHaveAccepted) {
        await releaseRelayChatBilling(
          billingState.current,
          "Chat 上游明确拒绝且未产生成本，释放预扣",
          "definitive_not_billable",
        );
      } else if (activeChannel) {
        try {
          await markRelayBillingPending(billingState.current, activeChannel, {
            units: 0,
            costMicros: 0,
            reason: "chat_upstream_outcome_unknown",
            // Keep bounded diagnostics with the reservation: channel health
            // is overwritten by later requests and HTTP logs may be lost when
            // the caller disconnects. Never persist the provider error body.
            metadata: err instanceof RelayChatError && err.upstreamFailure
              ? { upstreamFailure: err.upstreamFailure }
              : undefined,
          });
        } catch (billingError: any) {
          console.error("[relayChat] 保存待核账状态失败", billingError?.message || billingError);
        }
      }
    }
    if (err instanceof BillingError || err instanceof RelayChatError) throw err;
    const status = Number(err?.statusCode ?? err?.status ?? err?.response?.status);
    if (Number.isFinite(status)) throw new RelayChatError(err?.message || "relay chat failed", status);
    throw err;
  }
}

function validateMaxOutputTokens(value: number | undefined, field: string): void {
  if (value === undefined) return;
  const configuredLimit = Number(process.env.FANJIN_RELAY_MAX_OUTPUT_TOKENS);
  const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 131_072;
  if (!Number.isSafeInteger(value) || value <= 0 || value > limit) {
    throw new RelayChatError(`${field} 必须是 1-${limit} 的整数`, 400, false);
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

async function beginRelayChatBilling(
  input: RelayChatRequest,
  channel: RelayChannel,
  ctx: RelayChatContext,
  estimateModel?: string,
): Promise<RelayChatBillingSession> {
  return await beginRelayTextBilling({
    source: "relay-chat",
    model: input.model,
    channel,
    context: ctx,
    requestPayload: input,
    maxOutputTokens: input.max_completion_tokens ?? input.max_tokens,
    estimateModel,
  });
}

async function markRelayChatPending(
  session: RelayChatBillingSession,
  channel: RelayChannel,
  usage: { promptTokens: number; completionTokens: number; cachedTokens?: number; cacheWriteTokens?: number },
  actualCostMicros: number,
  reason: string,
): Promise<void> {
  await markRelayBillingPending(session, channel, {
    units: usage.promptTokens + usage.completionTokens + (usage.cacheWriteTokens || 0),
    costMicros: actualCostMicros,
    reason,
    metadata: {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cacheTokens: usage.cachedTokens || 0,
      cacheWriteTokens: usage.cacheWriteTokens || 0,
    },
  });
}

async function settleRelayChatBilling(
  session: RelayChatBillingSession,
  channel: RelayChannel,
  usage: RelayChatResult["usage"] | undefined,
  ctx: RelayChatContext,
): Promise<void> {
  await settleRelayTextBilling(session, channel, usage ? {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheTokens: usage.cacheTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    authoritative: usage.authoritative,
  } : null);
  if (ctx.onBillingSettled) {
    const row = await db("o_usage_record").where({ id: session.usageRecordId, workspaceId: session.workspaceId }).first("status", "costMicros");
    if (row?.status === "charged") await ctx.onBillingSettled({ costMicros: Number(row.costMicros), usage: { ...(usage || {}), usageRecordId: session.usageRecordId, billingStatus: row.status } });
  }
}

async function releaseRelayChatBilling(
  session: RelayChatBillingSession,
  reason: string,
  releaseProof: "not_dispatched" | "definitive_not_billable",
): Promise<void> {
  await releaseRelayBillingSession(session, reason, releaseProof);
}

function resolveOpenAICompatibleRequest(
  channel: RelayChannel,
  model: string,
  apiKey: string,
): {
  url: string;
  headers: Record<string, string>;
} {
  if (!apiKey) throw new RelayChatError("供应商通道未配置 apiKey", 500, false);

  const config = channel.config || {};
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (channel.provider === "azure") {
    const resourceName = String(config.resourceName || "").trim();
    const configuredBaseUrl = resolveChannelBaseUrl(channel);
    const baseUrl = configuredBaseUrl || (resourceName ? `https://${resourceName}.openai.azure.com` : "");
    if (!baseUrl) throw new RelayChatError("Azure 通道未配置 baseUrl 或 resourceName", 500, false);
    const apiVersion = String(config.apiVersion || "2024-10-21").trim();
    const azureRoot = /\/openai$/i.test(baseUrl) ? baseUrl : joinProviderApiPath(baseUrl, "openai");
    requestHeaders["api-key"] = apiKey;
    return {
      url: `${azureRoot}/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      headers: requestHeaders,
    };
  }

  const baseUrl = resolveChannelBaseUrl(channel);
  if (!baseUrl) throw new RelayChatError("供应商通道未配置 baseUrl", 500, false);
  requestHeaders.Authorization = `Bearer ${apiKey}`;
  return { url: joinProviderApiPath(baseUrl, "v1/chat/completions"), headers: requestHeaders };
}

function readOpenAIChatUsage(payload: any): RelayChatResult["usage"] | null {
  const usage = payload?.usage;
  const inputTokens = readUsageInteger(usage?.prompt_tokens, true);
  const outputTokens = readUsageInteger(usage?.completion_tokens, true);
  const cacheTokens = readUsageInteger(usage?.prompt_tokens_details?.cached_tokens, false);
  const cacheWriteTokens = readUsageInteger(usage?.prompt_tokens_details?.cache_write_tokens, false);
  if (inputTokens == null || outputTokens == null || cacheTokens == null || cacheWriteTokens == null) return null;
  return {
    inputTokens,
    outputTokens,
    cacheTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    authoritative: true,
  };
}

function nextSseEvent(buffer: string): { event: string; rest: string } | null {
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

function readSseData(event: string): string | null {
  const dataLines = event
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

async function executeViaOpenAICompatible(
  input: RelayChatRequest,
  clientModel: string,
  channel: RelayChannel,
  ctx: RelayChatContext,
  session: RelayChatBillingSession,
): Promise<RelayChatResult> {
  const requestBody: RelayChatRequest = input.stream
    ? {
        ...input,
        stream: true,
        stream_options: { ...(input.stream_options || {}), include_usage: true },
      }
    : { ...input, stream: false };

  await markRelayBillingDispatchStarted(session, channel);
  const dispatchStartedAt = Date.now();
  const timeoutMs = relayChatPurposeTimeout(channel.timeoutMs, ctx.purpose);
  const upstreamAbort = new AbortController();
  const signal = AbortSignal.any([
    upstreamAbort.signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  let response: Response;
  try {
    const dispatched = withChannelApiKeyForDispatch(
      channel,
      {
        channelId: channel.id,
        provider: channel.provider,
        endpointType: "text",
        model: clientModel,
      },
      (apiKey) => {
        const request = resolveOpenAICompatibleRequest(
          channel,
          input.model,
          apiKey,
        );
        return {
          promise: fetchRelayTextResponse(request.url, {
            method: "POST",
            headers: {
              ...request.headers,
              "Idempotency-Key": session.requestId,
              "X-Request-Id": session.requestId,
            },
            body: JSON.stringify(requestBody),
            signal,
          }, timeoutMs),
        };
      },
    );
    response = await dispatched.promise;
  } catch (error: any) {
    if (error instanceof RelayChatError) throw error;
    throw new RelayChatError(error?.message || "OpenAI 兼容请求结果未知", 502, true, {
      kind: signal.aborted && signal.reason?.name === "TimeoutError" ? "timeout" : "transport",
      elapsedMs: Math.max(0, Date.now() - dispatchStartedAt),
      stream: Boolean(input.stream),
    });
  }
  if (!response.ok) {
    // A broken error body must not erase an already received HTTP status.
    const errorBody = await response.text().then((body) => body.slice(0, 2_000), () => "");
    throw new RelayChatError(errorBody || `OpenAI 兼容上游返回 ${response.status}`, response.status, upstreamMayHaveAcceptedStatus(response.status), {
      kind: "http",
      httpStatus: response.status,
      elapsedMs: Math.max(0, Date.now() - dispatchStartedAt),
      stream: Boolean(input.stream),
    });
  }

  if (!input.stream) {
    let upstreamResponse: any;
    try {
      upstreamResponse = await response.json();
    } catch (error: any) {
      throw new RelayChatError(error?.message || "OpenAI 兼容上游已响应但响应体无法解析", 502, true);
    }
    const usage = readOpenAIChatUsage(upstreamResponse);
    if (!usage) throw new RelayChatError("OpenAI 兼容上游已响应但 Usage 不完整或无效", 502, true);
    return { response: upstreamResponse, usage };
  }

  if (!response.body) throw new RelayChatError("OpenAI 兼容上游未返回响应流", 502, true);
  const responseBody = response.body;
  const encoder = new TextEncoder();
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let usage: RelayChatResult["usage"] | null = null;
  let sawFinishReason = false;
  let sawTextDelta = false;
  let sawToolCallDelta = false;
  let sawDone = false;
  let clientCancelled = false;
  let pendingPromise: Promise<void> | null = null;

  const markPendingOnce = (reason: string): Promise<void> => {
    if (session.finalized) return Promise.resolve();
    if (!pendingPromise) {
      pendingPromise = markRelayChatPending(
        session,
        channel,
        {
          promptTokens: usage?.inputTokens || 0,
          completionTokens: usage?.outputTokens || 0,
          cachedTokens: usage?.cacheTokens || 0,
          cacheWriteTokens: usage?.cacheWriteTokens || 0,
        },
        0,
        reason,
      );
    }
    return pendingPromise;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = responseBody.getReader();
      upstreamReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      const forwardEvent = (event: string) => {
        const data = readSseData(event);
        if (data === "[DONE]") {
          sawDone = true;
          return;
        }
        if (data) {
          try {
            const chunk = JSON.parse(data);
            if (Array.isArray(chunk?.choices) && chunk.choices.some((choice: any) => choice?.finish_reason != null)) {
              sawFinishReason = true;
            }
            if (Array.isArray(chunk?.choices)) {
              for (const choice of chunk.choices) {
                const delta = choice?.delta;
                if (typeof delta?.content === "string" && delta.content.length > 0) sawTextDelta = true;
                if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) sawToolCallDelta = true;
              }
            }
            const observedUsage = readOpenAIChatUsage(chunk);
            if (observedUsage) usage = observedUsage;
          } catch {
            // Non-JSON vendor events are still valid passthrough data.
          }
        }
        controller.enqueue(encoder.encode(event));
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const next = nextSseEvent(buffer);
            if (!next) break;
            buffer = next.rest;
            forwardEvent(next.event);
          }
        }
        buffer += decoder.decode();
        if (buffer) forwardEvent(buffer);

        // A few OpenAI-compatible providers omit finish_reason on otherwise
        // complete text streams. Tool-call streams remain fail-closed because
        // missing termination can mean incomplete JSON arguments.
        const normalizeMissingTextFinish = canNormalizeMissingTextFinish({
          sawDone,
          hasUsage: Boolean(usage),
          sawTextDelta,
          sawToolCallDelta,
        });
        if (!sawDone || (!sawFinishReason && !normalizeMissingTextFinish) || !usage) {
          await markPendingOnce(
            !sawDone
              ? "openai_chat_stream_terminal_event_missing"
              : !sawFinishReason
                ? "openai_chat_stream_finish_reason_missing"
                : "openai_chat_stream_usage_incomplete",
          );
          throw new BillingError("OpenAI 兼容响应流终态、finish_reason 或 Usage 不完整，预扣已保留待核账", 502);
        }
        await settleRelayChatBilling(session, channel, usage, ctx);
        if (!sawFinishReason) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error: any) {
        if (!session.finalized) {
          try {
            await markPendingOnce(clientCancelled ? "openai_chat_stream_client_cancelled" : "openai_chat_stream_ended_without_settlement");
          } catch (billingStateError: any) {
            console.error("[relayChat] OpenAI 流式账务状态保存失败", {
              model: input.model,
              channelId: channel.id,
              workspaceId: ctx.workspaceId,
              error: billingStateError?.message || "unknown billing state error",
            });
          }
        }
        if (!clientCancelled) {
          const errorChunk = { error: { message: error?.message || "stream error", type: "server_error" } };
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`)); } catch {}
        }
      } finally {
        upstreamReader = null;
        controller.close();
      }
    },
    async cancel(reason) {
      clientCancelled = true;
      upstreamAbort.abort(reason);
      try { await upstreamReader?.cancel(reason); } catch {}
      if (!session.finalized) {
        try {
          await markPendingOnce("openai_chat_stream_client_cancelled");
        } catch (billingError: any) {
          console.error("[relayChat] OpenAI 流式取消状态保存失败", billingError?.message || billingError);
        }
      }
    },
  });

  return { stream };
}

// ============ Anthropic 上游（OpenAI 客户端 → Claude 转换） ============
async function executeViaAnthropic(
  input: RelayChatRequest,
  channel: RelayChannel,
  ctx: RelayChatContext,
  session: RelayChatBillingSession,
): Promise<RelayChatResult> {
  const { openAIRequestToClaude, claudeResponseToOpenAI, createOpenAIStreamFromClaude } = await import("@/lib/protocolConverter");
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!baseUrl) throw new RelayChatError("供应商通道未配置 baseUrl", 500, false);

  const claudeReq = openAIRequestToClaude(input as any);
  const messagesUrl = joinProviderApiPath(baseUrl, "v1/messages");
  const dispatch = (stream: boolean): Promise<Response> => {
    const started = withChannelApiKeyForDispatch(
      channel,
      {
        channelId: channel.id,
        provider: channel.provider,
        endpointType: "text",
        model: input.model,
      },
      (apiKey) => {
        if (!apiKey) {
          throw new RelayChatError("供应商通道未配置 apiKey", 500, false);
        }
        return {
          promise: fetch(messagesUrl, {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
              "Idempotency-Key": session.requestId,
              "X-Request-Id": session.requestId,
            },
            body: JSON.stringify({ ...claudeReq, stream }),
            signal: AbortSignal.timeout(relayChatPurposeTimeout(channel.timeoutMs, ctx.purpose)),
          }),
        };
      },
    );
    return started.promise;
  };

  if (input.stream) {
    const converter = createOpenAIStreamFromClaude(input.model);
    const encoder = new TextEncoder();
    let response: Response;
    await markRelayBillingDispatchStarted(session, channel);
    try {
      response = await dispatch(true);
    } catch (error: any) {
      if (error instanceof RelayChatError) throw error;
      throw new RelayChatError(error?.message || "Anthropic 流式请求结果未知", 502, true);
    }
    if (!response.ok) {
      const errBody = (await response.text()).slice(0, 2000);
      throw new RelayChatError(errBody, response.status, upstreamMayHaveAcceptedStatus(response.status));
    }
    if (!response.body) {
      throw new RelayChatError("上游未返回响应流", 502);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheTokens = 0;
    let cacheWriteTokens = 0;
    let sawInputUsage = false;
    let sawOutputUsage = false;
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const responseBody = response.body;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = responseBody.getReader();
        upstreamReader = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        let finishSeen = false;
        let eventType = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (eventType === "message_stop") finishSeen = true;
                  const startUsage = data?.message?.usage || {};
                  if (startUsage.input_tokens != null) {
                    const observedInputTokens = readUsageInteger(startUsage.input_tokens, true);
                    const observedCacheTokens = readUsageInteger(startUsage.cache_read_input_tokens, false);
                    const observedCacheWriteTokens = readUsageInteger(startUsage.cache_creation_input_tokens, false);
                    if (observedInputTokens != null && observedCacheTokens != null && observedCacheWriteTokens != null) {
                      inputTokens = observedInputTokens;
                      cacheTokens = observedCacheTokens;
                      cacheWriteTokens = observedCacheWriteTokens;
                      sawInputUsage = true;
                    }
                  }
                  if (data?.usage?.output_tokens != null) {
                    const observedOutputTokens = readUsageInteger(data.usage.output_tokens, true);
                    if (observedOutputTokens != null) {
                      outputTokens = observedOutputTokens;
                      sawOutputUsage = true;
                    }
                  }
                  const events = converter.convertEvent(eventType, data);
                  for (const evt of events) {
                    if (evt.includes("data: [DONE]")) continue;
                    controller.enqueue(encoder.encode(evt));
                  }
                } catch { /* 忽略 */ }
              }
            }
          }
          const normalizedInputTokens = inputTokens + cacheTokens;
          if (!finishSeen || !sawInputUsage || !sawOutputUsage) {
            await markRelayChatPending(
              session,
              channel,
              { promptTokens: normalizedInputTokens, completionTokens: outputTokens, cachedTokens: cacheTokens, cacheWriteTokens },
              0,
              !finishSeen ? "anthropic_stream_terminal_event_missing" : "anthropic_stream_usage_incomplete",
            );
            throw new BillingError("Anthropic 响应流终态或 Usage 不完整，预扣已保留待核账", 502);
          }
          await settleRelayChatBilling(session, channel, {
            inputTokens: normalizedInputTokens,
            outputTokens,
            cacheTokens,
            cacheWriteTokens,
            totalTokens: normalizedInputTokens + outputTokens,
            authoritative: true,
          }, ctx);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err: any) {
          if (!session.finalized) {
            try {
              const normalizedInputTokens = inputTokens + cacheTokens;
              await markRelayChatPending(
                session,
                channel,
                { promptTokens: normalizedInputTokens, completionTokens: outputTokens, cachedTokens: cacheTokens, cacheWriteTokens },
                0,
                finishSeen ? "anthropic_stream_settlement_failed" : "anthropic_stream_ended_without_usage",
              );
            } catch (billingStateError: any) {
              console.error("[relayChat] Anthropic 流式账务状态保存失败", {
                model: input.model,
                channelId: channel.id,
                workspaceId: ctx.workspaceId,
                error: billingStateError?.message || "unknown billing state error",
              });
            }
          }
          const errorChunk = { error: { message: err?.message || "stream error", type: "server_error" } };
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`)); } catch {}
        } finally {
          upstreamReader = null;
          controller.close();
        }
      },
      async cancel(reason) {
        try { await upstreamReader?.cancel(reason); } catch {}
        if (!session.finalized) {
          try {
            const normalizedInputTokens = inputTokens + cacheTokens;
            await markRelayChatPending(
              session,
              channel,
              { promptTokens: normalizedInputTokens, completionTokens: outputTokens, cachedTokens: cacheTokens, cacheWriteTokens },
              0,
              "anthropic_stream_client_cancelled",
            );
          } catch (billingError: any) {
            console.error("[relayChat] Anthropic 流式取消状态保存失败", billingError?.message || billingError);
          }
        }
      },
    });
    return { stream };
  }

  // 非流式
  let res: Response;
  await markRelayBillingDispatchStarted(session, channel);
  try {
    res = await dispatch(false);
  } catch (error: any) {
    if (error instanceof RelayChatError) throw error;
    throw new RelayChatError(error?.message || "Anthropic 请求结果未知", 502, true);
  }
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 2000);
    throw new RelayChatError(errBody, res.status, upstreamMayHaveAcceptedStatus(res.status));
  }
  let claudeResp: any;
  try {
    claudeResp = await res.json();
  } catch (error: any) {
    throw new RelayChatError(error?.message || "Anthropic 已响应但响应体无法解析", 502, true);
  }
  const nonCachedInputTokens = readUsageInteger(claudeResp?.usage?.input_tokens, true);
  const cacheTokens = readUsageInteger(claudeResp?.usage?.cache_read_input_tokens, false);
  const cacheWriteTokens = readUsageInteger(claudeResp?.usage?.cache_creation_input_tokens, false);
  const outputTokens = readUsageInteger(claudeResp?.usage?.output_tokens, true);
  if (nonCachedInputTokens == null || cacheTokens == null || cacheWriteTokens == null || outputTokens == null) {
    throw new RelayChatError("Anthropic 已响应但 Usage 不完整或无效", 502, true);
  }
  const inputTokens = nonCachedInputTokens + cacheTokens;
  let openaiResp: any;
  try {
    openaiResp = claudeResponseToOpenAI(claudeResp, input.model);
  } catch (error: any) {
    throw new RelayChatError(error?.message || "Anthropic 已响应但协议转换失败", 502, true);
  }
  openaiResp.usage = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: cacheTokens },
  };
  return {
    response: openaiResp,
    usage: {
      inputTokens,
      outputTokens,
      cacheTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens,
      authoritative: true,
    },
  };
}

type RelayChatUpstreamFailure = {
  kind: "http" | "timeout" | "transport";
  httpStatus?: number;
  elapsedMs: number;
  stream: boolean;
};

export class RelayChatError extends Error {
  statusCode: number;
  upstreamMayHaveAccepted: boolean;
  readonly upstreamFailure?: RelayChatUpstreamFailure;
  constructor(message: string, statusCode: number, upstreamMayHaveAccepted = true, upstreamFailure?: RelayChatUpstreamFailure) {
    super(message);
    this.name = "RelayChatError";
    this.statusCode = statusCode;
    this.upstreamMayHaveAccepted = upstreamMayHaveAccepted;
    this.upstreamFailure = upstreamFailure;
  }
}
