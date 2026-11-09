import { jwsOfficialImagePolicy, jwsOfficialImageCost } from "./jwsOfficialImagePricing";
import crypto from "node:crypto";
import { applyGuChargeRounding, ceilGuChargeMicros, guChargeRoundingVersion } from "./billingUnits";
import { textCacheWriteBillingMode } from "./textCacheWriteBilling";
import { additionalImageReferenceCost, imageReferenceCount } from "./imageReferencePricing";
import type { Knex } from "knex";
import {
  BillingError,
  billApiTask,
  calculatePricingCost,
  markApiTaskReservationDispatched,
  markApiTaskReservationPendingReconcile,
  releaseApiTaskReservation,
  resolveProviderSpecificPricingRule,
  settleApiTaskReservation,
  type ApiTaskDispatchBoundary,
  type ApiTaskReservationSettlementInput,
  type PricingRule,
} from "@/lib/billing";
import {
  CacheStorageBillingContractError,
  createCacheStorageAccrualInTransaction,
  readCacheWriteAccountingContract,
  type CacheWriteAccountingContract,
} from "@/lib/cacheStorageBilling";
import {
  calculateOpenAITextTokenPricing,
  type OpenAITextTokenUsage,
  type TextTokenPricing,
} from "@/lib/relayTextPricing";
import type { RelayChannel, RelayEndpointType } from "@/lib/sharedTypes";
import { computeUnifiedPricingCost, mergeTokenParams, type TokenParams } from "@/lib/billingExpr/unified";
import {jwsImagePricePolicy,jwsImageAmountMicros,jwsImageRetailAmountMicros,type JwsImageQuote,type JwsImageCharge} from "./jwsImagePricing";
import {
  assertCertifiedModelRouteForBilling,
  ModelRouteCertificationError,
} from "@/lib/modelRouteCertification";
import { resolveTimePricing, type TimePricingSnapshot } from "@/lib/timePricing";
import { defaultGptOutputBudget, estimateGptInput, supportsGptContentEstimate, type RelayInputEstimate } from "./relayTextEstimate";
import {
  assertQuickCreatePricingAuthorization,
  type QuickCreatePricingAuthorization,
} from "@/lib/quickCreatePricingConfirmation";
import {
  assertSeedream45CertificationProbeForBilling,
  type Seedream45CertificationProbeTaskBinding,
} from "@/lib/seedream45CertificationProbe";

export interface RelayBillingContext {
  workspaceId: string;
  apiKeyId: string | null;
  /** Internal durable Relay task identity; never accepted from public bodies. */
  taskId?: string | null;
  principalId?: string | null;
  requestId?: string | null;
  idempotencyKey?: string | null;
  /**
   * Optional fixed authorization amount. Agent LLM turns use a predictable
   * 100 GU authorization while final settlement still follows authoritative
   * token usage. Ordinary relay requests keep the conservative estimate.
   */
  reservationCostMicros?: number | null;
  /** Allow authoritative token settlement above the initial authorization. */
  allowSettlementOverage?: boolean;
  /**
   * 可选的连接注入(REVAMP-PLAN 风险 #7):仅用于定价规则等纯读查询
   * (resolveProviderSpecificPricingRule),调用方在 Gateway 事务内时传入
   * 该事务连接。
   *
   * 架构上不可注入、保持全局连接的部分(勿改):billApiTask /
   * settleApiTaskReservation / releaseApiTaskReservation /
   * markApiTaskReservationDispatched / markApiTaskReservationPendingReconcile
   * 各自在 billing.ts 内部开启独立的原子计费事务。GU 预扣必须独立于
   * Gateway 事务提交——Gateway 事务回滚时预扣必须留存待核账,否则上游
   * 已计费而冻结流水消失,造成资损。SQLite 部署(pool max=1)在 Gateway
   * 事务内执行真实计费需 FANJIN_SQLITE_POOL_MAX≥2(风险清单建议 ≥4)。
   */
  database?: Knex | Knex.Transaction | null;
  /** Server-only Quick Create ceiling. Public provider payloads never carry it. */
  quickCreatePricingAuthorization?: QuickCreatePricingAuthorization | null;
  /** Require the ceiling above before a GU reservation is created. */
  requireQuickCreatePricingConfirmation?: boolean;
  /**
   * Exact server-internal first-certification permit for Seedream 4.5. This
   * bypasses only the missing per-quality certificate after re-validating the
   * immutable route/channel/pricing/task set. It is never accepted over HTTP.
   */
  seedream45CertificationProbe?: Seedream45CertificationProbeTaskBinding | null;
}

export interface RelayBillingSession {
  workspaceId: string;
  apiKeyId: string | null;
  requestId: string;
  billingKey: string;
  requestHash: string;
  reservationId: string;
  usageRecordId: string;
  endpointType: RelayEndpointType;
  model: string;
  source: string;
  provider: string;
  channelId: string;
  pricingRuleId: string;
  reservedCostMicros: number;
  reservedUnits: number;
  unit: string;
  priceSnapshot: Record<string, unknown>;
  allowSettlementOverage: boolean;
  dispatchStarted: boolean;
  finalizationState: "active" | "settling" | "releasing" | "pending" | "finalized";
  finalized: boolean;
}

export interface RelayUnitBillingCheckpoint {
  version: "relay-unit-billing.v1";
  workspaceId: string;
  apiKeyId: string | null;
  requestId: string;
  billingKey: string;
  requestHash: string;
  reservationId: string;
  usageRecordId: string;
  endpointType: RelayEndpointType;
  model: string;
  source: string;
  provider: string;
  channelId: string;
  pricingRuleId: string;
  reservedCostMicros: number;
  reservedUnits: number;
  unit: string;
  priceSnapshot: Record<string, unknown>;
}

export interface RelayTextBillingSession extends RelayBillingSession {
  pricing: TextTokenPricing;
}

export interface RelayTextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  cacheWriteTokens?: number;
  authoritative: true;
}

function stableJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.keys(current as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((output, key) => {
          output[key] = normalize((current as Record<string, unknown>)[key]);
          return output;
        }, {});
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BillingError(`${field} 必须是非负安全整数`, 400);
  }
  return value;
}

function claimFinalization(
  session: RelayBillingSession,
  state: "settling" | "releasing" | "pending",
): void {
  if (session.finalized || session.finalizationState === "finalized") {
    throw new BillingError("计费会话已结束，不能重复变更终态", 409);
  }
  if (session.finalizationState !== "active") {
    throw new BillingError(`计费会话正在${session.finalizationState}，不能并发变更终态`, 409);
  }
  session.finalizationState = state;
}

function finishFinalization(session: RelayBillingSession): void {
  session.finalizationState = "finalized";
  session.finalized = true;
}

function rollbackFinalization(
  session: RelayBillingSession,
  state: "settling" | "releasing" | "pending",
): void {
  if (!session.finalized && session.finalizationState === state) session.finalizationState = "active";
}

function textPricingFromRule(rule: PricingRule, timeMultiplier = 1): TextTokenPricing {
  if (rule.unit !== "token") {
    throw new BillingError(`文本模型定价单位必须为 token，当前为 ${rule.unit || "unknown"}`, 402);
  }
  const config = rule.ruleConfig || {};
  return {
    inputPriceMicros: Number(config.inputPriceMicros ?? rule.unitPriceMicros),
    outputPriceMicros: Number(config.outputPriceMicros ?? rule.unitPriceMicros),
    cacheReadPriceMicros: Number(
      config.cacheReadPriceMicros ?? config.cachePriceMicros ?? config.inputPriceMicros ?? rule.unitPriceMicros,
    ),
    cacheWritePriceMicros: Number(
      config.cacheWritePriceMicros ?? config.cacheCreatePriceMicros ?? config.inputPriceMicros ?? rule.unitPriceMicros,
    ),
    multiplier: Number(config.multiplier ?? 1) * timeMultiplier,
    minimumMicros: Number(config.minimumMicros ?? 0),
  };
}

function safeTextPricing(usage: OpenAITextTokenUsage, pricing: TextTokenPricing) {
  try {
    return calculateOpenAITextTokenPricing(usage, pricing);
  } catch (error: any) {
    throw new BillingError(`文本定价配置或 Usage 无效：${error?.message || "unknown pricing error"}`, 500);
  }
}

function requestIdentity(input: {
  source: string;
  requestPayload: unknown;
  context: RelayBillingContext;
}) {
  const requestId = String(input.context.requestId || "").trim() || crypto.randomUUID();
  const clientIdempotencyKey = String(input.context.idempotencyKey || "").trim() || requestId;
  const principalScope = input.context.apiKeyId
    ? `api-key:${input.context.apiKeyId}`
    : String(input.context.principalId || "").trim()
      ? `principal:${String(input.context.principalId).trim()}`
      : "anonymous-session";
  const requestHash = crypto.createHash("sha256").update(stableJson(input.requestPayload)).digest("hex");
  const billingKeyHash = crypto
    .createHash("sha256")
    .update(`${input.context.workspaceId}:${principalScope}:${clientIdempotencyKey}`)
    .digest("hex");
  return {
    requestId,
    requestHash,
    billingKey: `relay-${input.source}:${billingKeyHash}`,
  };
}

export async function beginRelayBillingSession(input: {
  source: string;
  endpointType: RelayEndpointType;
  model: string;
  channel: RelayChannel;
  context: RelayBillingContext;
  requestPayload: unknown;
  pricingRule: PricingRule;
  reservedUnits: number;
  unit: string;
  reservedCostMicros: number;
  priceSnapshot?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  allowSettlementOverage?: boolean;
}): Promise<RelayBillingSession> {
  const reservedUnits = nonNegativeSafeInteger(input.reservedUnits, "reservedUnits");
  const reservedCostMicros = ceilGuChargeMicros(nonNegativeSafeInteger(input.reservedCostMicros, "reservedCostMicros"));
  if (input.pricingRule.endpointType !== input.endpointType) {
    throw new BillingError("定价规则的接口类型与中转请求不匹配", 402);
  }
  if (input.pricingRule.provider !== input.channel.provider) {
    throw new BillingError("定价规则未绑定当前上游供应商，已拒绝调用", 402);
  }
  if (input.pricingRule.model && input.pricingRule.model !== input.model) {
    throw new BillingError("定价规则的模型与中转请求不匹配", 402);
  }
  if (input.pricingRule.unit !== input.unit) {
    throw new BillingError(`定价单位不匹配：规则为 ${input.pricingRule.unit}，请求为 ${input.unit}`, 402);
  }
  if (
    input.pricingRule.scope === "workspace" &&
    input.pricingRule.workspaceId !== input.context.workspaceId
  ) {
    throw new BillingError("工作区定价规则不属于当前请求工作区", 402);
  }
  if (reservedCostMicros <= 0) {
    throw new BillingError("零价格模型必须先配置显式免费策略，当前已拒绝调用上游", 402);
  }
  if (input.allowSettlementOverage === true && input.unit !== "token") {
    throw new BillingError("仅权威 Token Usage 结算允许超过固定授权额", 400);
  }

  try {
    const certificationDatabase = input.context.database
      ?? (await import("@/utils/db")).db;
    if (input.context.seedream45CertificationProbe) {
      await assertSeedream45CertificationProbeForBilling({
        database: certificationDatabase,
        binding: input.context.seedream45CertificationProbe,
        taskId: input.context.taskId,
        workspaceId: input.context.workspaceId,
        principalId: input.context.principalId,
        requestPayload: input.requestPayload,
        channel: input.channel,
        pricingRule: input.pricingRule,
        reservedCostMicros,
      });
    } else {
      await assertCertifiedModelRouteForBilling({
        database: certificationDatabase,
        workspaceId: input.context.workspaceId,
        endpointType: input.endpointType,
        model: input.model,
        provider: input.channel.provider,
        channelId: input.channel.id,
        requestPayload: input.requestPayload,
        pricingRule: input.pricingRule,
      });
    }
  } catch (caught) {
    if (caught instanceof ModelRouteCertificationError) {
      const failure: any = new BillingError(caught.message, caught.statusCode);
      failure.code = caught.code;
      throw failure;
    }
    throw caught;
  }

  const identity = requestIdentity({
    source: input.source,
    requestPayload: input.requestPayload,
    context: input.context,
  });
  const priceSnapshot = { ...(input.priceSnapshot || {
    unit: input.pricingRule.unit,
    unitPriceMicros: input.pricingRule.unitPriceMicros,
    multiplier: Number(input.pricingRule.ruleConfig?.multiplier ?? 1),
    minimumMicros: Number(input.pricingRule.ruleConfig?.minimumMicros ?? 0),
  }), guChargeRounding: guChargeRoundingVersion };
  const reservation = await billApiTask({
    taskId: input.context.taskId ?? null,
    endpointType: input.endpointType,
    provider: input.channel.provider,
    model: input.model,
    workspaceId: input.context.workspaceId,
    units: reservedUnits,
    unit: input.unit,
    costMicros: reservedCostMicros,
    currency: input.pricingRule.currency,
    chargeMode: "reserve",
    apiKeyId: input.context.apiKeyId,
    channelId: input.channel.id,
    requestId: identity.requestId,
    idempotencyKey: `${identity.billingKey}:reserve`,
    description: `${input.source} reserve: ${input.model}`,
    metadata: {
      source: input.source,
      requestHash: identity.requestHash,
      pricingRuleId: input.pricingRule.id,
      priceSnapshot,
      reservedCostMicros,
      reservedUnits,
      ...(input.metadata || {}),
      ...(input.allowSettlementOverage === true
        ? {
            settlementPolicy: {
              version: 1,
              mode: "authoritative_token_usage",
              allowOverage: true,
              unit: "token",
            },
          }
        : {}),
    },
  });
  if (!reservation.ledger) throw new BillingError("中转调用预扣未生成冻结流水", 500);
  if (reservation.idempotent) {
    const existingRequestHash = String(reservation.ledger.metadata?.requestHash || "");
    if (existingRequestHash && existingRequestHash !== identity.requestHash) {
      throw new BillingError("同一 Idempotency-Key 不能用于不同请求", 409);
    }
    throw new BillingError("相同 Idempotency-Key 的请求已在处理或已经完成", 409);
  }

  return {
    workspaceId: input.context.workspaceId,
    apiKeyId: input.context.apiKeyId,
    requestId: identity.requestId,
    billingKey: identity.billingKey,
    requestHash: identity.requestHash,
    reservationId: reservation.ledger.id,
    usageRecordId: reservation.usage.id,
    endpointType: input.endpointType,
    model: input.model,
    source: input.source,
    provider: input.channel.provider,
    channelId: input.channel.id,
    pricingRuleId: input.pricingRule.id,
    reservedCostMicros,
    reservedUnits,
    unit: input.unit,
    priceSnapshot,
    allowSettlementOverage: input.allowSettlementOverage === true,
    dispatchStarted: false,
    finalizationState: "active",
    finalized: false,
  };
}

export async function settleRelayBillingSession(
  session: RelayBillingSession,
  channel: RelayChannel,
  actual: {
    units: number;
    unit?: string;
    costMicros: number;
    metadata?: Record<string, unknown>;
    trustedBeforeCommit?: ApiTaskReservationSettlementInput["trustedBeforeCommit"];
  },
): Promise<void> {
  const units = nonNegativeSafeInteger(actual.units, "units");
  const calculatedCostMicros = nonNegativeSafeInteger(actual.costMicros, "costMicros");
  const costMicros = applyGuChargeRounding(calculatedCostMicros, session.priceSnapshot);
  if (costMicros > session.reservedCostMicros && !session.allowSettlementOverage) {
    await markRelayBillingPending(session, channel, {
      units,
      costMicros,
      reason: "actual_cost_exceeds_reservation",
      metadata: actual.metadata,
    });
    throw new BillingError("实际用量超过预扣额度，预扣已保留待核账", 500);
  }

  claimFinalization(session, "settling");
  try {
    await settleApiTaskReservation({
      workspaceId: session.workspaceId,
      reservationId: session.reservationId,
      actualCostMicros: calculatedCostMicros,
      units,
      unit: actual.unit || session.unit,
      provider: channel.provider,
      channelId: channel.id,
      requestId: session.requestId,
      idempotencyKey: session.billingKey,
      description: `${session.source}: ${session.model}`,
      metadata: {
        source: session.source,
        requestHash: session.requestHash,
        pricingRuleId: session.pricingRuleId,
        priceSnapshot: session.priceSnapshot,
        reservedCostMicros: session.reservedCostMicros,
        settlementOverageMicros: Math.max(0, costMicros - session.reservedCostMicros),
        ...(actual.metadata || {}),
      },
      allowOverage: session.allowSettlementOverage,
      trustedBeforeCommit: actual.trustedBeforeCommit,
    });
    finishFinalization(session);
  } catch (error) {
    rollbackFinalization(session, "settling");
    try {
      await markRelayBillingPending(session, channel, {
        units,
        costMicros,
        reason: "settlement_failed",
        metadata: {
          ...(actual.metadata || {}),
          settlementEvidenceComplete: true,
          settlementUnit: actual.unit || session.unit,
        },
      });
    } catch {
      // Keep the reservation frozen; a reconciler must decide the final state.
    }
    throw error;
  }
}

export async function releaseRelayBillingSession(
  session: RelayBillingSession,
  reason: string,
  releaseProof: "not_dispatched" | "definitive_not_billable" = "not_dispatched",
): Promise<void> {
  claimFinalization(session, "releasing");
  try {
    await releaseApiTaskReservation({
      workspaceId: session.workspaceId,
      reservationId: session.reservationId,
      requestId: session.requestId,
      idempotencyKey: session.billingKey,
      provider: session.provider,
      channelId: session.channelId,
      description: reason,
      metadata: {
        source: session.source,
        requestHash: session.requestHash,
        pricingRuleId: session.pricingRuleId,
      },
      releaseProof,
    });
    finishFinalization(session);
  } catch (error) {
    rollbackFinalization(session, "releasing");
    throw error;
  }
}

export async function markRelayBillingDispatchStarted(
  session: RelayBillingSession,
  channel: RelayChannel,
  options: {
    trustedBeforeCommit?: (
      transaction: Knex.Transaction,
      boundary: ApiTaskDispatchBoundary,
    ) => Promise<void>;
  } = {},
): Promise<ApiTaskDispatchBoundary> {
  if (session.finalized || session.finalizationState !== "active") {
    throw new BillingError("计费会话已进入终态处理，禁止再次发起上游请求", 409);
  }
  const boundary = await markApiTaskReservationDispatched({
    workspaceId: session.workspaceId,
    reservationId: session.reservationId,
    provider: channel.provider,
    channelId: channel.id,
    requestId: session.requestId,
    trustedBeforeCommit: options.trustedBeforeCommit,
  });
  session.dispatchStarted = true;
  return boundary;
}

export function createRelayUnitBillingCheckpoint(
  session: RelayBillingSession,
): RelayUnitBillingCheckpoint {
  return {
    version: "relay-unit-billing.v1",
    workspaceId: session.workspaceId,
    apiKeyId: session.apiKeyId,
    requestId: session.requestId,
    billingKey: session.billingKey,
    requestHash: session.requestHash,
    reservationId: session.reservationId,
    usageRecordId: session.usageRecordId,
    endpointType: session.endpointType,
    model: session.model,
    source: session.source,
    provider: session.provider,
    channelId: session.channelId,
    pricingRuleId: session.pricingRuleId,
    reservedCostMicros: session.reservedCostMicros,
    reservedUnits: session.reservedUnits,
    unit: session.unit,
    priceSnapshot: session.priceSnapshot,
  };
}

export async function markRelayBillingPending(
  session: RelayBillingSession,
  channel: RelayChannel,
  input: {
    units: number;
    unit?: string;
    costMicros: number;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (session.finalized || session.finalizationState === "finalized") return;
  claimFinalization(session, "pending");
  try {
    await markApiTaskReservationPendingReconcile({
      workspaceId: session.workspaceId,
      reservationId: session.reservationId,
      units: nonNegativeSafeInteger(input.units, "units"),
      unit: input.unit || session.unit,
      actualCostMicros: nonNegativeSafeInteger(input.costMicros, "costMicros"),
      provider: channel.provider,
      channelId: channel.id,
      reason: input.reason,
      metadata: {
        billingKey: session.billingKey,
        requestHash: session.requestHash,
        pricingRuleId: session.pricingRuleId,
        priceSnapshot: session.priceSnapshot,
        ...(input.metadata || {}),
      },
    });
    finishFinalization(session);
  } catch (error) {
    rollbackFinalization(session, "pending");
    throw error;
  }
}

export function estimateRelayTextUsage(input: {
  requestPayload: unknown;
  maxOutputTokens?: number | null;
  model?: string;
}): OpenAITextTokenUsage & { inputEstimate?: RelayInputEstimate } {
  const payload = input.requestPayload as Record<string, unknown> | null;
  const model = input.model ?? (typeof payload?.model === "string" ? payload.model : "");
  const completionTokens = input.maxOutputTokens ?? (supportsGptContentEstimate(model) ? defaultGptOutputBudget() : 4_096);
  const inputEstimate = estimateGptInput(input.requestPayload, model);
  if (inputEstimate) {
    const choices = Number(payload?.n ?? 1);
    if (!Number.isSafeInteger(choices) || choices < 1) throw new BillingError("n 必须是正整数", 400);
    return {
      promptTokens: nonNegativeSafeInteger(inputEstimate.promptTokens, "estimatedInputTokens"),
      completionTokens: nonNegativeSafeInteger(completionTokens * choices, "estimatedOutputTokens"),
      cachedTokens: 0,
      cacheWriteTokens: 0,
      inputEstimate,
    };
  }
  const serializedBytes = Buffer.byteLength(stableJson(input.requestPayload), "utf8");
  const configuredFloor = Number(process.env.FANJIN_RELAY_MIN_INPUT_RESERVE_TOKENS);
  const reserveFloor = Number.isSafeInteger(configuredFloor) && configuredFloor >= 0 ? configuredFloor : 8_192;
  const promptTokens = Math.max(reserveFloor, serializedBytes + 256);
  return {
    promptTokens: nonNegativeSafeInteger(promptTokens, "estimatedInputTokens"),
    completionTokens: nonNegativeSafeInteger(completionTokens, "estimatedOutputTokens"),
    cachedTokens: 0,
    cacheWriteTokens: 0,
  };
}

export function estimateRelayTextCost(
  rule: PricingRule,
  usage: OpenAITextTokenUsage,
  evaluatedAt = Date.now(),
): number {
  const timePricing = resolveTimePricing(rule.ruleConfig, evaluatedAt);
  const pricing = textPricingFromRule(rule, timePricing.multiplier);
  const estimatedTokens = usage.promptTokens + usage.completionTokens;
  const pricingExpr = typeof rule.ruleConfig.pricingExpr === "string"
    && rule.ruleConfig.pricingExpr.trim();
  if (pricingExpr) {
    return computeUnifiedPricingCost({
      rule,
      tokenParams: mergeTokenParams({
        p: usage.promptTokens,
        c: usage.completionTokens,
        cr: 0,
        cc: 0,
      }),
      units: estimatedTokens,
      groupRatio: timePricing.multiplier,
      evaluationContext: { evaluatedAt: timePricing.evaluatedAt },
    }).costMicros;
  }
  const reservePricing: TextTokenPricing = {
    ...pricing,
    inputPriceMicros: Math.max(
      pricing.inputPriceMicros,
      pricing.cacheReadPriceMicros,
      pricing.cacheWritePriceMicros ?? 0,
    ),
  };
  return ceilGuChargeMicros(safeTextPricing(usage, reservePricing).costMicros);
}

/**
 * Pure, read-only equivalent of the reservation calculation used immediately
 * before a relay text provider dispatch. Candidate gates and quote surfaces
 * must reuse this function instead of reproducing token-price arithmetic from
 * UI metadata.
 */
export function estimateRelayTextReservationExposure(input: {
  rule: PricingRule;
  requestPayload: unknown;
  maxOutputTokens?: number | null;
  evaluatedAt?: number;
  estimateModel?: string;
  estimateProvider?: string;
}): {
  promptTokens: number;
  completionTokens: number;
  reservedUnits: number;
  reservedCostMicros: number;
  inputEstimate?: RelayInputEstimate;
} {
  const timePricing = resolveTimePricing(input.rule.ruleConfig, input.evaluatedAt ?? Date.now());
  const pricing = textPricingFromRule(input.rule, timePricing.multiplier);
  const estimatedUsage = estimateRelayTextUsage({
    requestPayload: input.requestPayload,
    maxOutputTokens: input.maxOutputTokens,
    model: (input.estimateProvider ?? input.rule.provider) === "openai" ? input.estimateModel ?? input.rule.model ?? "" : "",
  });
  const reservedUnits =
    estimatedUsage.promptTokens + estimatedUsage.completionTokens;
  const pricingExpr = typeof input.rule.ruleConfig.pricingExpr === "string"
    && input.rule.ruleConfig.pricingExpr.trim();

  let reservedCostMicros: number;
  if (pricingExpr) {
    const reserveParams = mergeTokenParams({
      p: estimatedUsage.promptTokens,
      c: estimatedUsage.completionTokens,
      cr: 0,
      cc: 0,
      len: estimatedUsage.promptTokens,
    });
    reservedCostMicros = computeUnifiedPricingCost({
      rule: input.rule,
      tokenParams: reserveParams,
      units: reservedUnits,
      groupRatio: timePricing.multiplier,
      evaluationContext: { evaluatedAt: timePricing.evaluatedAt },
    }).costMicros;
    if(input.rule.ruleConfig.cacheWriteBillingMode === "token_only") {
      // Reserve the more expensive cache-creation bucket as well. Actual
      // settlement uses the provider's immutable, disjoint usage buckets.
      const cacheWriteExposure = computeUnifiedPricingCost({
        rule: input.rule,
        tokenParams: mergeTokenParams({p:0,c:estimatedUsage.completionTokens,cr:0,cc:estimatedUsage.promptTokens,len:estimatedUsage.promptTokens}),
        units: reservedUnits,
        groupRatio: timePricing.multiplier,
        evaluationContext: {evaluatedAt:timePricing.evaluatedAt},
      }).costMicros;
      reservedCostMicros = Math.max(reservedCostMicros,cacheWriteExposure);
    }
  } else {
    const reservePricing: TextTokenPricing = {
      ...pricing,
      inputPriceMicros: Math.max(
        pricing.inputPriceMicros,
        pricing.cacheReadPriceMicros,
        pricing.cacheWritePriceMicros ?? 0,
      ),
    };
    reservedCostMicros = safeTextPricing(
      estimatedUsage,
      reservePricing,
    ).costMicros;
  }
  return {
    promptTokens: estimatedUsage.promptTokens,
    completionTokens: estimatedUsage.completionTokens,
    reservedUnits,
    reservedCostMicros: ceilGuChargeMicros(nonNegativeSafeInteger(
      reservedCostMicros,
      "reservedCostMicros",
    )),
    ...(estimatedUsage.inputEstimate ? { inputEstimate: estimatedUsage.inputEstimate } : {}),
  };
}

export async function beginRelayTextBilling(input: {
  source: string;
  model: string;
  channel: RelayChannel;
  context: RelayBillingContext;
  requestPayload: unknown;
  maxOutputTokens?: number | null;
  estimateModel?: string;
}): Promise<RelayTextBillingSession> {
  // 纯读:可用注入连接;预扣写(billApiTask)仍在 beginRelayBillingSession 内
  // 走全局独立事务,见 RelayBillingContext.database 注释。
  const rule = await resolveProviderSpecificPricingRule({
    endpointType: "text",
    provider: input.channel.provider,
    model: input.model,
    workspaceId: input.context.workspaceId,
  }, input.context.database ?? undefined);
  if (!rule) throw new BillingError("未配置该文本模型的定价规则，已拒绝调用上游", 402);

  const evaluatedAt = Date.now();
  const timePricing = resolveTimePricing(rule.ruleConfig, evaluatedAt);
  const pricing = textPricingFromRule(rule, timePricing.multiplier);
  const cacheWriteBillingMode = textCacheWriteBillingMode(rule.ruleConfig, input.channel.provider);
  const cacheWriteAccounting = readCacheWriteAccountingContract(rule.ruleConfig);
  const exposure = estimateRelayTextReservationExposure({
    rule,
    requestPayload: input.requestPayload,
    maxOutputTokens: input.maxOutputTokens,
    evaluatedAt,
    estimateModel: input.estimateModel,
    estimateProvider: input.channel.provider,
  });
  const pricingExpr = typeof rule.ruleConfig.pricingExpr === "string" && rule.ruleConfig.pricingExpr.trim();
  const reservationOverride = input.context.reservationCostMicros;
  const reservedCostMicros = reservationOverride == null
    ? exposure.reservedCostMicros
    : nonNegativeSafeInteger(reservationOverride, "reservationCostMicros");
  const allowSettlementOverage = input.context.allowSettlementOverage === true
    && reservationOverride != null;

  const baseSession = await beginRelayBillingSession({
    source: input.source,
    endpointType: "text",
    model: input.model,
    channel: input.channel,
    context: input.context,
    requestPayload: input.requestPayload,
    pricingRule: rule,
    reservedUnits: exposure.reservedUnits,
    unit: "token",
    reservedCostMicros,
    allowSettlementOverage,
    priceSnapshot: {
      unit: rule.unit,
      unitPriceMicros: rule.unitPriceMicros,
      pricingExpr: pricingExpr || null,
      // @deprecated 旧字段保留，供无 pricingExpr 时回退
      inputPriceMicros: pricing.inputPriceMicros,
      outputPriceMicros: pricing.outputPriceMicros,
      cacheReadPriceMicros: pricing.cacheReadPriceMicros,
      cacheWritePriceMicros: pricing.cacheWritePriceMicros ?? 0,
      ...(cacheWriteBillingMode !== "storage" ? { cacheWriteBillingMode } : {}),
      cacheWriteAccounting,
      multiplier: pricing.multiplier ?? 1,
      baseMultiplier: Number(rule.ruleConfig.multiplier ?? 1),
      minimumMicros: pricing.minimumMicros ?? 0,
      timePricing,
    },
    metadata: {
      estimatedInputTokens: exposure.promptTokens,
      estimatedOutputTokens: exposure.completionTokens,
      estimatedCostMicros: exposure.reservedCostMicros,
      fixedAuthorization: reservationOverride != null,
      inputEstimate: exposure.inputEstimate ?? { method: "legacy-byte-fallback" },
    },
  });
  return { ...baseSession, pricing };
}

export async function settleRelayTextBilling(
  session: RelayTextBillingSession,
  channel: RelayChannel,
  usage?: RelayTextUsage | null,
): Promise<void> {
  const normalizedUsage: OpenAITextTokenUsage = {
    promptTokens: Number(usage?.inputTokens || 0),
    completionTokens: Number(usage?.outputTokens || 0),
    cachedTokens: Number(usage?.cacheTokens || 0),
    cacheWriteTokens: Number(usage?.cacheWriteTokens || 0),
  };
  const totalTokens = normalizedUsage.promptTokens + normalizedUsage.completionTokens + (normalizedUsage.cacheWriteTokens || 0);

  const settleMeta = {
    inputTokens: normalizedUsage.promptTokens,
    outputTokens: normalizedUsage.completionTokens,
    cacheTokens: normalizedUsage.cachedTokens || 0,
    cacheWriteTokens: normalizedUsage.cacheWriteTokens || 0,
  };

  if (!usage || usage.authoritative !== true || totalTokens <= 0) {
    await markRelayBillingPending(session, channel, {
      units: totalTokens,
      costMicros: 0,
      reason: "upstream_usage_missing",
      metadata: settleMeta,
    });
    throw new BillingError("上游未返回可结算的 Token Usage，预扣已保留待核账", 502);
  }

  const pricingExpr = typeof session.priceSnapshot.pricingExpr === "string"
    && (session.priceSnapshot.pricingExpr as string).trim();

  let cacheWriteAccounting: CacheWriteAccountingContract | null = null;
  if ((normalizedUsage.cacheWriteTokens || 0) > 0) {
    try {
      const mode = textCacheWriteBillingMode(session.priceSnapshot, channel.provider);
      if (mode === "none") throw new CacheStorageBillingContractError("该模型未配置缓存写入价格");
      cacheWriteAccounting = mode === "storage"
        ? readCacheWriteAccountingContract(session.priceSnapshot)
        : null;
      if (!cacheWriteAccounting && mode !== "token_only") {
        throw new CacheStorageBillingContractError(
          "上游返回 cache write tokens，但已认证定价快照未包含 cacheWriteAccounting",
        );
      }
    } catch (error) {
      try {
        await markRelayBillingPending(session, channel, {
          units: totalTokens,
          costMicros: 0,
          reason: "cache_storage_rule_invalid",
          metadata: settleMeta,
        });
      } catch { /* 保留原始合同错误 */ }
      throw error;
    }
  }

  let costMicros: number;
  try {
    if (pricingExpr) {
      // ── 表达式模式：用上游真实 token 结算 ──
      const tokenParams = mergeTokenParams({
        p: normalizedUsage.promptTokens,
        len: normalizedUsage.promptTokens + (normalizedUsage.cacheWriteTokens || 0),
        c: normalizedUsage.completionTokens,
        cr: normalizedUsage.cachedTokens || 0,
        cc: normalizedUsage.cacheWriteTokens || 0,
      });
      const result = computeUnifiedPricingCost({
        rule: {
          unitPriceMicros: Number(session.priceSnapshot.unitPriceMicros || 0),
          ruleConfig: {
            pricingExpr,
            multiplier: session.priceSnapshot.multiplier,
            minimumMicros: session.priceSnapshot.minimumMicros,
          },
        },
        tokenParams,
        units: totalTokens,
        groupRatio: Number((session.priceSnapshot.timePricing as TimePricingSnapshot | undefined)?.multiplier ?? 1),
        evaluationContext: {
          evaluatedAt: Number((session.priceSnapshot.timePricing as TimePricingSnapshot | undefined)?.evaluatedAt || 0) || undefined,
        },
      });
      costMicros = result.costMicros;
    } else {
      // @deprecated 旧模式：按 bucket 分价
      const actual = safeTextPricing(normalizedUsage, session.pricing);
      costMicros = actual.costMicros;
    }
  } catch (error) {
    try {
      await markRelayBillingPending(session, channel, {
        units: totalTokens,
        costMicros: 0,
        reason: "usage_or_price_snapshot_invalid",
        metadata: settleMeta,
      });
    } catch { /* 保留原始错误 */ }
    throw error;
  }

  const accrualStartedAt = Date.now();
  await settleRelayBillingSession(session, channel, {
    units: totalTokens,
    unit: "token",
    costMicros,
    metadata: settleMeta,
    trustedBeforeCommit: cacheWriteAccounting
      ? async (transaction, settlement) => {
          await createCacheStorageAccrualInTransaction({
            transaction,
            sourceUsageRecordId: settlement.usage.id,
            sourceReservationId: settlement.reservation.id,
            workspaceId: session.workspaceId,
            apiKeyId: session.apiKeyId,
            requestId: session.requestId,
            provider: channel.provider,
            channelId: channel.id,
            model: session.model,
            pricingRuleId: session.pricingRuleId,
            cacheWriteTokens: normalizedUsage.cacheWriteTokens || 0,
            contract: cacheWriteAccounting,
            startedAt: accrualStartedAt,
          });
        }
      : undefined,
  });
}

export async function beginRelayUnitBilling(input: {
  source: string;
  endpointType: RelayEndpointType;
  model: string;
  channel: RelayChannel;
  context: RelayBillingContext;
  requestPayload: unknown;
  units: number;
  unit: string;
  metadata?: Record<string, unknown>;
  /**
   * 报价阶段钉定的上游供应商。传入后若实际通道 provider 不一致则立即拒绝，
   * 防止 withChannelRetry 在并发满时漂移到定价更高的供应商（E08-AG-03）。
   */
  expectedProvider?: string;
  /** Server-observed JWS quote, never accepted from a public request. */
  upstreamQuote?: JwsImageQuote;
}): Promise<RelayBillingSession> {
  // 纯读:可用注入连接;预扣写(billApiTask)仍在 beginRelayBillingSession 内
  // 走全局独立事务,见 RelayBillingContext.database 注释。
  if (input.expectedProvider && input.channel.provider !== input.expectedProvider) {
    throw new BillingError(
      `上游供应商与报价阶段不一致：报价为 ${input.expectedProvider}，实际通道为 ${input.channel.provider}`,
      409,
    );
  }
  const rule = await resolveProviderSpecificPricingRule({
    endpointType: input.endpointType,
    provider: input.channel.provider,
    model: input.model,
    workspaceId: input.context.workspaceId,
  }, input.context.database ?? undefined);
  if (!rule) throw new BillingError("未配置该模型的定价规则，已拒绝调用上游", 402);
  if (rule.unit !== input.unit) {
    throw new BillingError(`定价单位不匹配：规则为 ${rule.unit}，请求为 ${input.unit}`, 402);
  }
  const evaluatedAt = Date.now();
  const timePricing = resolveTimePricing(rule.ruleConfig, evaluatedAt);
  const baseMultiplier = Number(rule.ruleConfig?.multiplier ?? 1);
  const references = input.unit === "image" ? imageReferenceCount(input.requestPayload) : undefined;
  const jwsPolicy=jwsImagePricePolicy(rule.ruleConfig);
  if(jwsPolicy && (input.channel.provider!=="openai" || input.channel.config?.imageTransport!=="jws-async-v1" || input.unit!=="image" || !input.upstreamQuote))throw new BillingError("图片上游计费需要经过验证的即时报价",409);
  const officialPolicy = jwsOfficialImagePolicy(rule.ruleConfig);
  if (officialPolicy && (input.channel.provider !== "openai" || input.channel.config?.imageTransport !== "jws-async-v1" || input.unit !== "image" || !input.upstreamQuote || input.upstreamQuote.pricingMode !== "fixed" || input.upstreamQuote.model !== `image:${officialPolicy.model}`)) throw new BillingError("官方价图片规则需要已核验的按张报价", 409);
  if(input.upstreamQuote && !jwsPolicy && !officialPolicy)throw new BillingError("图片价格策略尚未配置",409);
  const officialCost = officialPolicy ? jwsOfficialImageCost(officialPolicy, {size: (input.requestPayload as Record<string, unknown> | undefined)?.size, count: input.units, referenceCount: references || 0}) : null;
  const costMicros = jwsPolicy && input.upstreamQuote
    ? jwsImageRetailAmountMicros(input.upstreamQuote.amount,input.upstreamQuote.currency,jwsPolicy)
    : officialCost?.costMicros ?? calculatePricingCost(rule, input.units, undefined, undefined, evaluatedAt, references);
  if (input.context.requireQuickCreatePricingConfirmation) {
    assertQuickCreatePricingAuthorization(
      ceilGuChargeMicros(costMicros),
      input.context.quickCreatePricingAuthorization,
      evaluatedAt,
    );
  }
  const pricingExpr = typeof rule.ruleConfig?.pricingExpr === "string"
    ? rule.ruleConfig.pricingExpr.trim()
    : "";
  return await beginRelayBillingSession({
    ...input,
    pricingRule: rule,
    reservedUnits: input.units,
    reservedCostMicros: costMicros,
    priceSnapshot: {
      unit: rule.unit,
      unitPriceMicros: rule.unitPriceMicros,
      pricingExpr: pricingExpr || null,
      ...(jwsPolicy?{jwsUpstreamPricing:jwsPolicy,upstreamQuote:input.upstreamQuote}:{}),
      ...(officialPolicy ? {jwsOfficialPricing: officialPolicy, upstreamQuote: input.upstreamQuote, officialImageSize: (input.requestPayload as Record<string, unknown> | undefined)?.size || "auto"} : {}),
      ...(input.unit === "image" ? {
        referenceImagePricing: rule.ruleConfig.referenceImagePricing,
        referenceImageCount: references,
        imageQuantityPricing: rule.ruleConfig.pricingSource === "volcengine-official-list-price",
      } : {}),
      multiplier: baseMultiplier * timePricing.multiplier,
      baseMultiplier,
      minimumMicros: Number(rule.ruleConfig?.minimumMicros ?? 0),
      timePricing,
    },
  });
}

export async function settleRelayUnitBilling(
  session: RelayBillingSession,
  channel: RelayChannel,
  input: {
    units: number;
    unit?: string;
    tokenParams?: Partial<TokenParams>;
    metadata?: Record<string, unknown>;
    upstreamCharge?: JwsImageCharge;
  },
): Promise<void> {
  const units = nonNegativeSafeInteger(input.units, "units");
  const unit = input.unit || session.unit;
  if (unit !== session.unit) {
    throw new BillingError(`结算单位与预扣单位不匹配：${unit} != ${session.unit}`, 409);
  }

  let costMicros: number;
  const jwsPolicy=jwsImagePricePolicy(session.priceSnapshot);
  if(jwsPolicy) {
    const charge=input.upstreamCharge;
    const quote=session.priceSnapshot.upstreamQuote as JwsImageQuote;
    if(!charge || channel.provider!=="openai" || channel.config?.imageTransport!=="jws-async-v1" || charge.billingStatus!=="charged" || !/^image:[0-9a-f-]+$/i.test(charge.taskId) || (quote.pricingMode==="usage" && charge.settlementStatus!=="settled"))throw new BillingError("图片上游最终账单未确认",502);
    await settleRelayBillingSession(session,channel,{units,unit,costMicros:jwsImageRetailAmountMicros(charge.amount,charge.currency,jwsPolicy),metadata:{...input.metadata,upstreamCharge:charge,upstreamCostMicros:jwsImageAmountMicros(charge.amount,charge.currency,jwsPolicy),imageMarkupBps:jwsPolicy.version==="jws-upstream-cost-plus.v1"?jwsPolicy.markupBps:0}});
    return;
  }
  const officialPolicy = jwsOfficialImagePolicy(session.priceSnapshot);
  if (officialPolicy) {
    const charge = input.upstreamCharge;
    const quote = session.priceSnapshot.upstreamQuote as JwsImageQuote;
    if (!charge || unit !== "image" || channel.provider !== "openai" || channel.config?.imageTransport !== "jws-async-v1" || quote?.pricingMode !== "fixed" || charge.billingStatus !== "charged" || !/^image:[0-9a-f-]+$/i.test(charge.taskId) || !Number.isFinite(charge.amount) || charge.amount < 0 || charge.currency !== "USD") throw new BillingError("图片上游最终账单未确认", 502);
    const cost = jwsOfficialImageCost(officialPolicy, {size: session.priceSnapshot.officialImageSize, count: units, referenceCount: Number(session.priceSnapshot.referenceImageCount || 0)});
    await settleRelayBillingSession(session, channel, {units, unit, costMicros: cost.costMicros, metadata: {...input.metadata, upstreamCharge: charge, officialPriceFactor: officialPolicy.factor}});
    return;
  }
  if(input.upstreamCharge)throw new BillingError("图片最终账单与价格快照不匹配",409);

  // 表达式模式：有 tokenParams 且快照中有 pricingExpr 时走表达式
  const pricingExpr = typeof session.priceSnapshot.pricingExpr === "string"
    && (session.priceSnapshot.pricingExpr as string).trim();
  // Official image prices are per delivered image, not per upstream image token.
  const officialImageQuantity = unit === "image" && session.priceSnapshot.imageQuantityPricing === true;
  if (pricingExpr && input.tokenParams && !officialImageQuantity) {
    const result = computeUnifiedPricingCost({
      rule: {
        unitPriceMicros: Number(session.priceSnapshot.unitPriceMicros || 0),
        ruleConfig: {
          pricingExpr,
          multiplier: session.priceSnapshot.multiplier,
          minimumMicros: session.priceSnapshot.minimumMicros,
        },
      },
      tokenParams: input.tokenParams,
      units,
      groupRatio: Number((session.priceSnapshot.timePricing as TimePricingSnapshot | undefined)?.multiplier ?? 1),
      evaluationContext: {
        evaluatedAt: Number((session.priceSnapshot.timePricing as TimePricingSnapshot | undefined)?.evaluatedAt || 0) || undefined,
      },
    });
    costMicros = nonNegativeSafeInteger(result.costMicros, "costMicros");
  } else {
    // 旧模式
    const unitPriceMicros = nonNegativeSafeInteger(Number(session.priceSnapshot.unitPriceMicros), "unitPriceMicros");
    const multiplier = Number(session.priceSnapshot.multiplier ?? 1);
    const minimumMicros = nonNegativeSafeInteger(Number(session.priceSnapshot.minimumMicros ?? 0), "minimumMicros");
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new BillingError("价格快照 multiplier 必须为正数", 500);
    }
    const referenceCost = unit === "image" && units > 0 ? additionalImageReferenceCost(session.priceSnapshot, Number(session.priceSnapshot.referenceImageCount || 0)) : 0;
    const adjustedCost = Math.round((unitPriceMicros * units + referenceCost) * multiplier);
    costMicros = nonNegativeSafeInteger(Math.max(adjustedCost, minimumMicros), "costMicros");
  }

  await settleRelayBillingSession(session, channel, {
    units,
    unit,
    costMicros,
    metadata: input.metadata,
  });
}
