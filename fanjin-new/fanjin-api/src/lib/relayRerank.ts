// Rerank 中转（/v1/rerank），兼容 Cohere / Jina 请求与响应格式。
import axios from "axios";
import type { RelayChannel } from "@/lib/relay";
import { joinProviderApiPath, withChannelRetry } from "@/lib/channelRouter";
import {
  BillingError,
  calculatePricingCost,
  resolveProviderSpecificPricingRule,
  type PricingRule,
} from "@/lib/billing";
import {
  beginRelayBillingSession,
  markRelayBillingDispatchStarted,
  markRelayBillingPending,
  releaseRelayBillingSession,
  settleRelayUnitBilling,
  type RelayBillingContext,
  type RelayBillingSession,
} from "@/lib/relayBillingSession";
import { resolveChannelApiKey, resolveChannelBaseUrl } from "@/lib/relayChannelCredential";
import { resolveTimePricing } from "@/lib/timePricing";

const RERANK_ENDPOINT_TYPE = "rerank" as const;
const RERANK_BILLING_UNIT = "document";

export class RelayRerankError extends Error {
  statusCode: number;
  upstreamMayHaveAccepted: boolean;

  constructor(message: string, statusCode: number, upstreamMayHaveAccepted = true) {
    super(message);
    this.name = "RelayRerankError";
    this.statusCode = statusCode;
    this.upstreamMayHaveAccepted = upstreamMayHaveAccepted;
  }
}

export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
  [key: string]: unknown;
}

export interface RerankResultItem {
  index: number;
  relevance_score: number;
  document?: unknown;
  [key: string]: unknown;
}

export interface RerankResponse {
  results: RerankResultItem[];
  [key: string]: unknown;
}

function isDefinitivePreRerankRejection(status: number): boolean {
  return [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(status);
}

function uncertainRerankUpstreamError(error: unknown, fallback: string): RelayRerankError {
  const value = error as any;
  const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status);
  const upstreamBody = value?.response?.data;
  const message = upstreamBody?.error?.message
    || upstreamBody?.message
    || (typeof upstreamBody === "string" ? upstreamBody : null)
    || value?.message
    || fallback;
  return new RelayRerankError(
    String(message),
    Number.isFinite(status) ? status : 502,
    !isDefinitivePreRerankRejection(status),
  );
}

export async function executeRelayRerank(
  input: RerankRequest,
  ctx: RelayBillingContext,
): Promise<RerankResponse> {
  const normalizedInput = normalizeRerankRequest(input);
  const documentCount = normalizedInput.documents.length;
  const expectedResultCount = normalizedInput.top_n!;
  const billingState: { current: RelayBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;

  try {
    const routed = await withChannelRetry(
      {
        endpointType: RERANK_ENDPOINT_TYPE,
        model: normalizedInput.model,
        workspaceId: ctx.workspaceId,
        retryPolicy: "disabled",
      },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        if (!billingState.current) {
          billingState.current = await beginProviderSpecificRerankBilling(
            normalizedInput,
            documentCount,
            channel,
            ctx,
          );
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }
        return executeRerankCall(
          normalizedInput,
          expectedResultCount,
          channel,
          billingState.current,
        );
      },
    );

    if (!billingState.current) throw new BillingError("Rerank 计费预扣会话未创建", 500);
    await settleRelayUnitBilling(billingState.current, routed.channel, {
      units: documentCount,
      unit: RERANK_BILLING_UNIT,
      metadata: {
        requestedDocumentCount: documentCount,
        returnedResultCount: routed.result.results.length,
        topN: expectedResultCount,
      },
    });
    return routed.result;
  } catch (error: any) {
    const session = billingState.current;
    if (session && !session.finalized) {
      if (!session.dispatchStarted) {
        await releaseRelayBillingSession(session, "Rerank 调用上游前失败，释放预扣", "not_dispatched");
      } else if (error instanceof RelayRerankError && !error.upstreamMayHaveAccepted) {
        await releaseRelayBillingSession(
          session,
          "Rerank 上游明确拒绝且未产生成本，释放预扣",
          "definitive_not_billable",
        );
      } else if (activeChannel) {
        await markRelayBillingPending(session, activeChannel, {
          units: documentCount,
          unit: RERANK_BILLING_UNIT,
          costMicros: 0,
          reason: "rerank_upstream_outcome_unknown",
          metadata: {
            requestedDocumentCount: documentCount,
            topN: expectedResultCount,
            upstreamStatus: finiteStatus(error),
          },
        });
      }
    }
    throw error;
  }
}

async function beginProviderSpecificRerankBilling(
  input: RerankRequest,
  documentCount: number,
  channel: RelayChannel,
  context: RelayBillingContext,
): Promise<RelayBillingSession> {
  const pricingRule = await resolveProviderSpecificRerankRule({
    provider: channel.provider,
    model: input.model,
    workspaceId: context.workspaceId,
  });
  if (!pricingRule) {
    throw new BillingError("未配置该供应商和模型的 Rerank 定价规则，已拒绝调用上游", 402);
  }
  if (pricingRule.unit !== RERANK_BILLING_UNIT) {
    throw new BillingError(
      `Rerank 定价单位必须为 ${RERANK_BILLING_UNIT}，当前为 ${pricingRule.unit || "unknown"}`,
      402,
    );
  }
  const evaluatedAt = Date.now();
  const timePricing = resolveTimePricing(pricingRule.ruleConfig, evaluatedAt);
  const baseMultiplier = Number(pricingRule.ruleConfig?.multiplier ?? 1);
  const costMicros = calculatePricingCost(
    pricingRule,
    documentCount,
    undefined,
    undefined,
    evaluatedAt,
  );
  return beginRelayBillingSession({
    source: "relay-rerank",
    endpointType: RERANK_ENDPOINT_TYPE,
    model: input.model,
    channel,
    context,
    requestPayload: input,
    pricingRule,
    reservedUnits: documentCount,
    unit: RERANK_BILLING_UNIT,
    reservedCostMicros: costMicros,
    priceSnapshot: {
      unit: pricingRule.unit,
      unitPriceMicros: pricingRule.unitPriceMicros,
      multiplier: baseMultiplier * timePricing.multiplier,
      baseMultiplier,
      minimumMicros: Number(pricingRule.ruleConfig?.minimumMicros ?? 0),
      timePricing,
    },
    metadata: {
      requestedDocumentCount: documentCount,
      topN: input.top_n,
      providerSpecificPricing: true,
    },
  });
}

async function executeRerankCall(
  input: RerankRequest,
  expectedResultCount: number,
  channel: RelayChannel,
  billingSession: RelayBillingSession,
): Promise<RerankResponse> {
  const apiKey = resolveChannelApiKey(channel);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!apiKey) throw new RelayRerankError("供应商通道未配置 apiKey", 500, false);
  if (!baseUrl) throw new RelayRerankError("供应商通道未配置 baseUrl", 500, false);

  const upstreamModel = resolveUpstreamModel(channel, input.model);
  const requestBody = { ...input, model: upstreamModel };
  const url = resolveRerankUrl(channel, baseUrl);
  let providerResponse: unknown;

  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    const response = await axios.post(url, requestBody, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": billingSession.requestId,
        "X-Request-Id": billingSession.requestId,
      },
      timeout: positiveTimeout(channel.timeoutMs, 60_000),
    });
    providerResponse = response.data;
  } catch (error) {
    throw uncertainRerankUpstreamError(error, "Rerank 供应商调用失败");
  }

  return validateRerankResponse(providerResponse, input, expectedResultCount);
}

function validateRerankResponse(
  value: unknown,
  input: RerankRequest,
  expectedResultCount: number,
): RerankResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new RelayRerankError("Rerank 上游返回 2xx，但缺少 results 数组", 502, true);
  }
  if (value.results.length !== expectedResultCount) {
    throw new RelayRerankError(
      `Rerank 上游结果数量不完整（预期 ${expectedResultCount}，实际 ${value.results.length}）`,
      502,
      true,
    );
  }

  const seenIndexes = new Set<number>();
  const results: RerankResultItem[] = value.results.map((item: unknown, position: number) => {
    if (!isRecord(item)) {
      throw new RelayRerankError(`Rerank 上游第 ${position + 1} 个结果不是对象`, 502, true);
    }
    if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= input.documents.length) {
      throw new RelayRerankError(`Rerank 上游第 ${position + 1} 个结果 index 无效`, 502, true);
    }
    if (seenIndexes.has(item.index)) {
      throw new RelayRerankError("Rerank 上游返回了重复文档 index", 502, true);
    }
    if (typeof item.relevance_score !== "number" || !Number.isFinite(item.relevance_score)) {
      throw new RelayRerankError(`Rerank 上游第 ${position + 1} 个结果 relevance_score 无效`, 502, true);
    }
    if (input.return_documents === true && !validReturnedDocument(item.document)) {
      throw new RelayRerankError(`Rerank 上游第 ${position + 1} 个结果缺少有效 document`, 502, true);
    }
    seenIndexes.add(item.index);
    return item as RerankResultItem;
  });

  return { ...value, results } as RerankResponse;
}

function normalizeRerankRequest(input: RerankRequest): RerankRequest {
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  const query = typeof input?.query === "string" ? input.query.trim() : "";
  if (!model) throw new RelayRerankError("model is required", 400, false);
  if (!query) throw new RelayRerankError("query is required", 400, false);
  if (!Array.isArray(input?.documents) || input.documents.length === 0) {
    throw new RelayRerankError("documents is required and must be non-empty", 400, false);
  }
  const maxDocuments = configuredMaxDocuments();
  if (input.documents.length > maxDocuments) {
    throw new RelayRerankError(`documents 最多允许 ${maxDocuments} 项`, 400, false);
  }
  if (!input.documents.every((document) => typeof document === "string" && document.trim().length > 0)) {
    throw new RelayRerankError("documents 每一项都必须是非空字符串", 400, false);
  }

  const topN = input.top_n == null ? input.documents.length : Number(input.top_n);
  if (!Number.isSafeInteger(topN) || topN < 1 || topN > input.documents.length) {
    throw new RelayRerankError(`top_n 必须是 1-${input.documents.length} 的整数`, 400, false);
  }
  if (input.return_documents != null && typeof input.return_documents !== "boolean") {
    throw new RelayRerankError("return_documents 必须是布尔值", 400, false);
  }

  return {
    ...input,
    model,
    query,
    documents: [...input.documents],
    top_n: topN,
  };
}

async function resolveProviderSpecificRerankRule(input: {
  provider: string;
  model: string;
  workspaceId: string;
}): Promise<PricingRule | null> {
  return resolveProviderSpecificPricingRule({
    endpointType: RERANK_ENDPOINT_TYPE,
    provider: input.provider,
    model: input.model,
    workspaceId: input.workspaceId,
  });
}

function resolveRerankUrl(channel: RelayChannel, baseUrl: string): string {
  const configuredPath = typeof channel.config?.rerankPath === "string"
    ? channel.config.rerankPath.trim()
    : "";
  return joinProviderApiPath(baseUrl, configuredPath || "v1/rerank");
}

function resolveUpstreamModel(channel: RelayChannel, requestedModel: string): string {
  const mapping = channel.config?.modelMapping as Record<string, string> | undefined;
  if (mapping && mapping[requestedModel]) return mapping[requestedModel];
  return requestedModel;
}

function validReturnedDocument(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return isRecord(value) && typeof value.text === "string" && value.text.trim().length > 0;
}

function configuredMaxDocuments(): number {
  const configured = Number(process.env.FANJIN_RERANK_MAX_DOCUMENTS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 1_000;
}

function positiveTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteStatus(error: any): number | null {
  const status = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
  return Number.isFinite(status) ? status : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
