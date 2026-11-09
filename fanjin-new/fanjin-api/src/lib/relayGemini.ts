// Gemini 协议中转（/v1beta/models/*）。
// 支持 Gemini 客户端直通，以及 OpenAI 请求/响应与 Gemini 协议互转。
import type { RelayChannel } from "@/lib/relay";
import { withChannelRetry } from "@/lib/channelRouter";
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
  openAIRequestToGemini,
  geminiResponseToOpenAI,
  createOpenAIStreamFromGemini,
  type GeminiRequest,
} from "@/lib/protocolConverter";

type GeminiUsageBuckets = Omit<RelayTextUsage, "authoritative">;
type AuthoritativeRelayTextUsage = GeminiUsageBuckets & { authoritative: true };

interface GeminiUsageEvidence {
  promptTokens: number;
  toolUsePromptTokens: number;
  candidateTokens: number;
  thoughtTokens: number;
  cacheTokens: number;
  totalTokens: number;
  sawPromptTokens: boolean;
  sawCandidateTokens: boolean;
  sawUsageMetadata: boolean;
  sawTotalTokens: boolean;
  lastUsageChunkIndex: number;
  lastUsageHadPromptTokens: boolean;
  lastUsageHadCandidateTokens: boolean;
}

interface RelayGeminiResult {
  stream?: ReadableStream<Uint8Array>;
  response?: any;
  usage?: AuthoritativeRelayTextUsage;
}

type GeminiResponseMode =
  | { type: "gemini" }
  | { type: "openai"; clientModel: string };

export class RelayGeminiError extends Error {
  statusCode: number;
  upstreamMayHaveAccepted: boolean;

  constructor(message: string, statusCode: number, upstreamMayHaveAccepted = false) {
    super(message);
    this.name = "RelayGeminiError";
    this.statusCode = statusCode;
    this.upstreamMayHaveAccepted = upstreamMayHaveAccepted;
  }
}

function isDefinitivePreGenerationRejection(status: number): boolean {
  return [400, 401, 403, 404, 413, 415, 422, 429].includes(status);
}

function upstreamMayHaveAcceptedStatus(status: number): boolean {
  return !isDefinitivePreGenerationRejection(status);
}

function uncertainGeminiUpstreamError(error: unknown, fallback: string): RelayGeminiError {
  const value = error as any;
  const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status);
  const message = value?.response?.data?.error?.message || value?.message || fallback;
  return new RelayGeminiError(
    String(message),
    Number.isFinite(status) ? status : 502,
    upstreamMayHaveAcceptedStatus(status),
  );
}

/** Gemini 客户端直通：请求和响应均保持 Gemini 协议。 */
export async function executeGeminiDirect(
  model: string,
  geminiReq: GeminiRequest,
  stream: boolean,
  ctx: RelayBillingContext,
): Promise<RelayGeminiResult> {
  return executeGeminiRequest(model, geminiReq, geminiReq, stream, ctx, { type: "gemini" });
}

/** OpenAI 客户端调用 Gemini 通道：请求/响应自动转换。 */
export async function executeViaGemini(
  openaiReq: any,
  clientModel: string,
  stream: boolean,
  ctx: RelayBillingContext,
): Promise<RelayGeminiResult> {
  const geminiReq = openAIRequestToGemini(openaiReq);
  return executeGeminiRequest(clientModel, openaiReq, geminiReq, stream, ctx, {
    type: "openai",
    clientModel,
  });
}

async function executeGeminiRequest(
  model: string,
  billingPayload: unknown,
  geminiReq: GeminiRequest,
  stream: boolean,
  ctx: RelayBillingContext,
  responseMode: GeminiResponseMode,
): Promise<RelayGeminiResult> {
  const billingState: { current: RelayTextBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;

  try {
    const routed = await withChannelRetry(
      {
        endpointType: "text",
        provider: "gemini",
        model,
        workspaceId: ctx.workspaceId,
        retryPolicy: "disabled",
      },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        if (channel.provider !== "gemini") {
          throw new RelayGeminiError("所选通道不是 Gemini 通道", 500);
        }
        if (!billingState.current) {
          billingState.current = await beginRelayTextBilling({
            source: responseMode.type === "gemini" ? "relay-gemini-direct" : "relay-gemini-openai",
            model,
            channel,
            context: ctx,
            requestPayload: billingPayload,
            maxOutputTokens: geminiReq.generationConfig?.maxOutputTokens,
          });
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }

        return performGeminiRequest(
          model,
          geminiReq,
          stream,
          channel,
          billingState.current,
          responseMode,
        );
      },
    );

    if (!routed.result.stream) {
      if (!billingState.current) throw new BillingError("Gemini 计费预扣会话未创建", 500);
      await settleRelayTextBilling(billingState.current, routed.channel, routed.result.usage);
    }
    return routed.result;
  } catch (error: any) {
    const session = billingState.current;
    if (session && !session.finalized) {
      if (!session.dispatchStarted) {
        await releaseRelayBillingSession(session, "Gemini 调用上游前失败，释放预扣", "not_dispatched");
      } else if (error instanceof RelayGeminiError && !error.upstreamMayHaveAccepted) {
        await releaseRelayBillingSession(
          session,
          "Gemini 上游明确拒绝且未产生成本，释放预扣",
          "definitive_not_billable",
        );
      } else if (activeChannel) {
        await markRelayBillingPending(session, activeChannel, {
          units: 0,
          costMicros: 0,
          reason: "gemini_upstream_outcome_unknown",
          metadata: {
            upstreamStatus: Number(error?.statusCode ?? error?.status ?? error?.response?.status) || null,
          },
        });
      }
    }
    throw error;
  }
}

async function performGeminiRequest(
  model: string,
  geminiReq: GeminiRequest,
  stream: boolean,
  channel: RelayChannel,
  billingSession: RelayTextBillingSession,
  responseMode: GeminiResponseMode,
): Promise<RelayGeminiResult> {
  const { apiKey, baseUrl } = getChannelCreds(channel);
  const upstreamModel = resolveUpstreamModel(channel, model);
  const action = stream ? "streamGenerateContent" : "generateContent";
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(upstreamModel)}:${action}?key=${encodeURIComponent(apiKey)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": billingSession.requestId,
    "X-Request-Id": billingSession.requestId,
  };
  const timeoutMs = positiveTimeout(channel.timeoutMs, 120_000);

  let response: Response;
  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(geminiReq),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw uncertainGeminiUpstreamError(error, "Gemini 请求结果未知");
  }

  if (!response.ok) {
    const errorBody = await readErrorBody(response);
    throw new RelayGeminiError(
      errorBody || `Gemini 上游返回 HTTP ${response.status}`,
      response.status,
      upstreamMayHaveAcceptedStatus(response.status),
    );
  }

  if (stream) {
    if (!response.body) throw new RelayGeminiError("Gemini 上游未返回响应流", 502, true);
    return {
      stream: createBilledGeminiStream(response.body, channel, billingSession, responseMode),
    };
  }

  let geminiResponse: any;
  try {
    geminiResponse = await response.json();
  } catch (error) {
    throw new RelayGeminiError(
      `Gemini 已接受请求但响应体无法解析：${(error as any)?.message || "invalid JSON"}`,
      502,
      true,
    );
  }
  if (!isRecord(geminiResponse)) {
    throw new RelayGeminiError("Gemini 已接受请求但返回了无效响应体", 502, true);
  }

  const usage = readAuthoritativeGeminiUsage(geminiResponse.usageMetadata, true);
  if (responseMode.type === "gemini") {
    return { response: geminiResponse, usage };
  }

  let openAIResponse: any;
  try {
    openAIResponse = geminiResponseToOpenAI(geminiResponse, responseMode.clientModel);
  } catch (error) {
    throw new RelayGeminiError(
      `Gemini 已接受请求但响应协议转换失败：${(error as any)?.message || "conversion failed"}`,
      502,
      true,
    );
  }
  if (usage) applyOpenAIUsage(openAIResponse, usage);
  return { response: openAIResponse, usage };
}

function createBilledGeminiStream(
  responseBody: ReadableStream<Uint8Array>,
  channel: RelayChannel,
  billingSession: RelayTextBillingSession,
  responseMode: GeminiResponseMode,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const usage = new GeminiUsageAccumulator();
  const openAIConverter = responseMode.type === "openai"
    ? createOpenAIStreamFromGemini(responseMode.clientModel)
    : null;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let clientCancelled = false;
  let pendingFinalization: Promise<void> | null = null;

  const evidenceMetadata = () => ({
    ...usage.evidence(),
    responseMode: responseMode.type,
  });
  const markPendingOnce = (reason: string): Promise<void> => {
    if (billingSession.finalized || billingSession.finalizationState !== "active") {
      return Promise.resolve();
    }
    if (!pendingFinalization) {
      const current = usage.current();
      pendingFinalization = markRelayBillingPending(billingSession, channel, {
        units: current.inputTokens + current.outputTokens,
        costMicros: 0,
        reason,
        metadata: evidenceMetadata(),
      });
    }
    return pendingFinalization;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const deferredOpenAITerminalEvents: string[] = [];
      let streamChunkIndex = 0;
      const parser = new GeminiJsonArrayParser((chunk) => {
        streamChunkIndex += 1;
        usage.observe(chunk?.usageMetadata, streamChunkIndex);
        if (responseMode.type === "gemini") {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
          return;
        }

        const normalizedChunk = withNormalizedGeminiUsage(chunk, usage.current());
        const events = openAIConverter!.convertChunk(normalizedChunk);
        const includesTerminal = events.some((event) => event.trim() === "data: [DONE]");
        for (const event of events) {
          if (includesTerminal) deferredOpenAITerminalEvents.push(event);
          else controller.enqueue(encoder.encode(event));
        }
      });

      const reader = responseBody.getReader();
      upstreamReader = reader;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.feed(decoder.decode());
        parser.finish();
        if (clientCancelled) {
          await markPendingOnce("gemini_stream_client_cancelled");
          return;
        }

        const authoritativeUsage = usage.authoritativeUsage(parser.closed, streamChunkIndex);
        await settleRelayTextBilling(billingSession, channel, authoritativeUsage);
        for (const event of deferredOpenAITerminalEvents) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      } catch (error: any) {
        const pending = !billingSession.finalized && billingSession.finalizationState === "active"
          ? markPendingOnce(
              clientCancelled ? "gemini_stream_client_cancelled" : "gemini_stream_ended_without_settlement",
            )
          : Promise.resolve();
        const upstreamCancellation = reader.cancel(error).catch(() => undefined);
        await pending;
        void upstreamCancellation;
        try { controller.error(error); } catch {}
      } finally {
        upstreamReader = null;
        try { reader.releaseLock(); } catch {}
      }
    },
    async cancel(reason) {
      clientCancelled = true;
      const pending = markPendingOnce("gemini_stream_client_cancelled");
      const upstreamCancellation = upstreamReader?.cancel(reason).catch(() => undefined);
      await pending;
      void upstreamCancellation;
    },
  });
}

class GeminiUsageAccumulator {
  private state: GeminiUsageEvidence = emptyUsageEvidence();
  private readonly observedFields = new Set<string>();

  observe(metadata: unknown, chunkIndex = 1): void {
    if (metadata === undefined || metadata === null) return;
    if (!isRecord(metadata)) {
      throw new RelayGeminiError("Gemini 流返回了无效 usageMetadata", 502, true);
    }
    this.state.sawUsageMetadata = true;
    this.state.lastUsageChunkIndex = chunkIndex;
    this.state.lastUsageHadPromptTokens = "promptTokenCount" in metadata;
    this.state.lastUsageHadCandidateTokens = "candidatesTokenCount" in metadata;
    this.readField(metadata, "promptTokenCount", "promptTokens", "sawPromptTokens", false);
    this.readField(metadata, "toolUsePromptTokenCount", "toolUsePromptTokens", undefined, true);
    this.readField(metadata, "candidatesTokenCount", "candidateTokens", "sawCandidateTokens", false);
    this.readField(metadata, "thoughtsTokenCount", "thoughtTokens", undefined, true);
    this.readField(metadata, "cachedContentTokenCount", "cacheTokens", undefined, true);
    this.readField(metadata, "totalTokenCount", "totalTokens", "sawTotalTokens", true);
    assertSafeUsageSums(this.state);
  }

  current(): GeminiUsageBuckets {
    return usageFromEvidence(this.state);
  }

  evidence(): GeminiUsageEvidence {
    return { ...this.state };
  }

  authoritativeUsage(
    terminalComplete: boolean,
    terminalChunkIndex = 1,
  ): AuthoritativeRelayTextUsage | undefined {
    if (
      !terminalComplete
      || !this.state.sawPromptTokens
      || !this.state.sawCandidateTokens
      || this.state.lastUsageChunkIndex !== terminalChunkIndex
      || !this.state.lastUsageHadPromptTokens
      || !this.state.lastUsageHadCandidateTokens
    ) {
      return undefined;
    }
    const normalized = usageFromEvidence(this.state);
    // Gemini defines totalTokenCount as prompt + thoughts + response candidates;
    // toolUsePromptTokenCount is a separately billed input bucket and is not
    // included in that provider consistency field.
    const providerTotal = this.state.promptTokens + this.state.candidateTokens + this.state.thoughtTokens;
    if (this.state.sawTotalTokens && this.state.totalTokens !== providerTotal) {
      throw new RelayGeminiError("Gemini totalTokenCount 与分项 Token 总数不一致", 502, true);
    }
    return { ...normalized, authoritative: true };
  }

  private readField(
    metadata: Record<string, unknown>,
    upstreamField: string,
    stateField: "promptTokens" | "toolUsePromptTokens" | "candidateTokens" | "thoughtTokens" | "cacheTokens" | "totalTokens",
    seenField?: "sawPromptTokens" | "sawCandidateTokens" | "sawTotalTokens",
    allowNull = false,
  ): void {
    if (!(upstreamField in metadata)) return;
    if (allowNull && metadata[upstreamField] == null) return;
    const count = readTokenCount(metadata[upstreamField], upstreamField);
    if (this.observedFields.has(upstreamField) && count < this.state[stateField]) {
      throw new RelayGeminiError(`Gemini ${upstreamField} 在流式响应中发生倒退`, 502, true);
    }
    this.state[stateField] = count;
    this.observedFields.add(upstreamField);
    if (seenField) this.state[seenField] = true;
  }
}

class GeminiJsonArrayParser {
  private state: "array-start" | "value-or-end" | "value" | "separator-or-end" | "done" = "array-start";
  private currentObject = "";
  private depth = 0;
  private inString = false;
  private escaped = false;
  closed = false;

  constructor(private readonly onValue: (value: any) => void) {}

  feed(text: string): void {
    for (const character of text) {
      if (this.depth > 0) {
        this.consumeObjectCharacter(character);
        continue;
      }
      if (/\s/.test(character)) continue;

      if (this.state === "array-start") {
        if (character !== "[") throw new RelayGeminiError("Gemini 流不是合法的 JSON 数组", 502, true);
        this.state = "value-or-end";
        continue;
      }
      if (this.state === "value-or-end") {
        if (character === "]") {
          this.closeArray();
          continue;
        }
        if (character !== "{") throw new RelayGeminiError("Gemini 流包含无效数组元素", 502, true);
        this.startObject();
        continue;
      }
      if (this.state === "value") {
        if (character !== "{") throw new RelayGeminiError("Gemini 流逗号后缺少响应对象", 502, true);
        this.startObject();
        continue;
      }
      if (this.state === "separator-or-end") {
        if (character === ",") {
          this.state = "value";
          continue;
        }
        if (character === "]") {
          this.closeArray();
          continue;
        }
        throw new RelayGeminiError("Gemini 流响应对象之间缺少分隔符", 502, true);
      }
      throw new RelayGeminiError("Gemini 流在数组结束后仍有额外数据", 502, true);
    }
  }

  finish(): void {
    if (!this.closed || this.depth !== 0 || this.state !== "done") {
      throw new RelayGeminiError("Gemini 响应流未完整结束", 502, true);
    }
  }

  private startObject(): void {
    this.currentObject = "{";
    this.depth = 1;
    this.inString = false;
    this.escaped = false;
  }

  private consumeObjectCharacter(character: string): void {
    this.currentObject += character;
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
      } else if (character === "\\") {
        this.escaped = true;
      } else if (character === "\"") {
        this.inString = false;
      }
      return;
    }
    if (character === "\"") {
      this.inString = true;
      return;
    }
    if (character === "{" || character === "[") this.depth += 1;
    if (character === "}" || character === "]") this.depth -= 1;
    if (this.depth < 0) throw new RelayGeminiError("Gemini 流 JSON 结构无效", 502, true);
    if (this.depth !== 0) return;

    let parsed: any;
    try {
      parsed = JSON.parse(this.currentObject);
    } catch (error) {
      throw new RelayGeminiError(
        `Gemini 流包含无法解析的 JSON：${(error as any)?.message || "invalid JSON"}`,
        502,
        true,
      );
    }
    this.currentObject = "";
    this.state = "separator-or-end";
    this.onValue(parsed);
  }

  private closeArray(): void {
    this.closed = true;
    this.state = "done";
  }
}

function readAuthoritativeGeminiUsage(
  metadata: unknown,
  terminalComplete: boolean,
): AuthoritativeRelayTextUsage | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  if (!isRecord(metadata)) throw new RelayGeminiError("Gemini 返回了无效 usageMetadata", 502, true);

  const accumulator = new GeminiUsageAccumulator();
  accumulator.observe(metadata);
  return accumulator.authoritativeUsage(terminalComplete);
}

function emptyUsageEvidence(): GeminiUsageEvidence {
  return {
    promptTokens: 0,
    toolUsePromptTokens: 0,
    candidateTokens: 0,
    thoughtTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    sawPromptTokens: false,
    sawCandidateTokens: false,
    sawUsageMetadata: false,
    sawTotalTokens: false,
    lastUsageChunkIndex: 0,
    lastUsageHadPromptTokens: false,
    lastUsageHadCandidateTokens: false,
  };
}

function usageFromEvidence(evidence: GeminiUsageEvidence): GeminiUsageBuckets {
  const inputTokens = evidence.promptTokens + evidence.toolUsePromptTokens;
  const outputTokens = evidence.candidateTokens + evidence.thoughtTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
    throw new RelayGeminiError("Gemini Usage Token 总数超出安全整数范围", 502, true);
  }
  if (evidence.cacheTokens > inputTokens) {
    throw new RelayGeminiError("Gemini 缓存 Token 大于输入 Token", 502, true);
  }
  return {
    inputTokens,
    outputTokens,
    cacheTokens: evidence.cacheTokens,
    cacheWriteTokens: 0,
  };
}

function assertSafeUsageSums(evidence: GeminiUsageEvidence): void {
  usageFromEvidence(evidence);
}

function readTokenCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RelayGeminiError(`Gemini ${field} 不是非负安全整数`, 502, true);
  }
  return value;
}

function withNormalizedGeminiUsage(chunk: any, usage: GeminiUsageBuckets): any {
  if (!isRecord(chunk) || !isRecord(chunk.usageMetadata)) return chunk;
  return {
    ...chunk,
    usageMetadata: {
      ...chunk.usageMetadata,
      promptTokenCount: usage.inputTokens,
      candidatesTokenCount: usage.outputTokens,
      totalTokenCount: usage.inputTokens + usage.outputTokens,
    },
  };
}

function applyOpenAIUsage(response: any, usage: AuthoritativeRelayTextUsage): void {
  if (!isRecord(response)) return;
  response.usage = {
    ...(isRecord(response.usage) ? response.usage : {}),
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: {
      ...(isRecord(response.usage?.prompt_tokens_details) ? response.usage.prompt_tokens_details : {}),
      cached_tokens: usage.cacheTokens || 0,
    },
  };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2_000);
  } catch {
    return "";
  }
}

function getChannelCreds(channel: RelayChannel): { apiKey: string; baseUrl: string } {
  const apiKey = resolveChannelApiKey(channel);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!apiKey) throw new RelayGeminiError("供应商通道未配置 apiKey", 500);
  if (!baseUrl) throw new RelayGeminiError("供应商通道未配置 baseUrl", 500);
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
}

function resolveUpstreamModel(channel: RelayChannel, requestedModel: string): string {
  const mapping = channel.config?.modelMapping as Record<string, string> | undefined;
  if (mapping && mapping[requestedModel]) return mapping[requestedModel];
  return requestedModel;
}

function positiveTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
