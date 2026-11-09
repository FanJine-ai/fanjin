// 创作台统一计费封装。
// 与 API 中转共用同一套 o_pricing_rule / o_usage_record / o_billing_ledger，
// 仅 endpointType 不同（text / image_generation / tts）。
//
// 计费优先走 ruleConfig.pricingExpr 表达式，旧字段仅作回退。
import crypto from "node:crypto";
import { applyGuChargeRounding, guChargeRoundingVersion } from "./billingUnits";
import {
  BillingError,
  billApiTask,
  insufficientBalanceBillingError,
  markApiTaskReservationDispatched,
  markApiTaskReservationPendingReconcile,
  releaseApiTaskReservation,
  resolvePricingRule,
  readWorkspaceAvailableMicros,
  settleApiTaskReservation,
  type PricingRule,
} from "@/lib/billing";
import { getBillingContext } from "@/lib/billingContext";
import { computeUnifiedPricingCost, mergeTokenParams } from "@/lib/billingExpr/unified";
import { resolveTimePricing, type TimePricingSnapshot } from "@/lib/timePricing";

export type CreationEndpointType = "text" | "image_generation" | "tts";

export interface CreationChargeInput {
  endpointType: CreationEndpointType;
  model: string;
  units: number;
  unit: string;
  description?: string;
  // 文本计费的 token 分解（仅 endpointType=text 时使用）
  tokenBreakdown?: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number; // 缓存命中的输入 token
  };
}

export interface CreationBillingSession {
  workspaceId: string;
  requestId: string;
  billingKey: string;
  endpointType: CreationEndpointType;
  model: string;
  unit: string;
  estimatedUnits: number;
  reservedCostMicros: number;
  reservationId: string | null;
  usageRecordId: string | null;
  provider: string | null;
  pricingRule: PricingRule | null;
  priceSnapshot: CreationPricingSnapshot | null;
  description: string;
  metadata: Record<string, unknown>;
  dispatched: boolean;
  finalized: boolean;
}

export interface CreationPricingSnapshot {
  guChargeRounding?: string;
  pricingRuleId: string;
  provider: string | null;
  unit: string;
  currency: string;
  unitPriceMicros: number;
  ruleConfig: Record<string, unknown>;
  evaluatedAt: number;
  timePricing: TimePricingSnapshot;
}

export class InsufficientBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

function bareModel(modelName: string): string {
  const idx = modelName.indexOf(":");
  return idx >= 0 ? modelName.slice(idx + 1) : modelName;
}

function nextCreationIdentity(input: CreationChargeInput): { requestId: string; billingKey: string } {
  const ctx = getBillingContext();
  if (!ctx?.workspaceId) throw new BillingError("创作计费缺少工作区上下文", 500);
  ctx.creationOperationSequence = Number(ctx.creationOperationSequence || 0) + 1;
  const requestRoot = String(ctx.requestId || "").trim() || crypto.randomUUID();
  const requestId = `${requestRoot}:creation:${ctx.creationOperationSequence}`;
  const digest = crypto
    .createHash("sha256")
    .update(`${ctx.workspaceId}:${requestId}:${input.endpointType}:${bareModel(input.model)}`)
    .digest("hex");
  return { requestId, billingKey: `creation:${digest}` };
}

function cloneRuleConfig(ruleConfig: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(ruleConfig || {})) as Record<string, unknown>;
}

function freezeCreationPricing(
  rule: PricingRule,
  evaluatedAt = Date.now(),
): CreationPricingSnapshot {
  const ruleConfig = cloneRuleConfig(rule.ruleConfig);
  return {
    pricingRuleId: rule.id,
    ...(rule.currency === "GU" ? { guChargeRounding: guChargeRoundingVersion } : {}),
    provider: rule.provider,
    unit: rule.unit,
    currency: rule.currency,
    unitPriceMicros: rule.unitPriceMicros,
    ruleConfig,
    evaluatedAt,
    timePricing: resolveTimePricing(ruleConfig, evaluatedAt),
  };
}

function sessionMetadata(
  input: CreationChargeInput,
  priceSnapshot: CreationPricingSnapshot | null,
): Record<string, unknown> {
  const ctx = getBillingContext();
  return {
    source: "creation",
    projectId: ctx?.projectId ?? null,
    ...(input.tokenBreakdown ? { tokenBreakdown: input.tokenBreakdown } : {}),
    ...(priceSnapshot
      ? {
          pricingRuleId: priceSnapshot.pricingRuleId,
          priceSnapshot,
          ...(priceSnapshot.timePricing.configured
            ? { timePricing: priceSnapshot.timePricing }
            : {}),
        }
      : {}),
  };
}

/**
 * 统一计费：有表达式走表达式，无表达式走旧逻辑。
 * 同时支持文本 token 分价和非文本按量计费。
 */
function calculateCreationCostMicros(
  rule: Pick<CreationPricingSnapshot, "unitPriceMicros" | "ruleConfig">,
  units: number,
  breakdown?: { inputTokens: number; outputTokens: number; cacheTokens: number },
  pricingContext?: Pick<CreationPricingSnapshot, "evaluatedAt" | "timePricing">,
): number {
  const evaluatedAt = pricingContext?.evaluatedAt ?? Date.now();
  const timePricing = pricingContext?.timePricing
    ?? resolveTimePricing(rule.ruleConfig, evaluatedAt);
  const pricingExpr = typeof rule.ruleConfig.pricingExpr === "string" && rule.ruleConfig.pricingExpr.trim();
  if (pricingExpr) {
    // 表达式模式
    const tokenParams = breakdown
      ? mergeTokenParams({ p: breakdown.inputTokens, c: breakdown.outputTokens, cr: breakdown.cacheTokens })
      : undefined;
    const result = computeUnifiedPricingCost({
      rule,
      tokenParams,
      units,
      groupRatio: timePricing.multiplier,
      evaluationContext: { evaluatedAt: timePricing.evaluatedAt },
    });
    return result.costMicros;
  }
  // @deprecated 旧逻辑回退
  const baseMultiplier = Number(rule.ruleConfig.multiplier ?? 1) || 1;
  const multiplier = baseMultiplier * timePricing.multiplier;
  if (breakdown) {
    const base = rule.unitPriceMicros;
    const config = rule.ruleConfig || {};
    const inputPrice = Number(config.inputPriceMicros ?? base);
    const outputPrice = Number(config.outputPriceMicros ?? base);
    const cachePrice = Number(config.cachePriceMicros ?? config.inputPriceMicros ?? base);
    const nonCacheInput = Math.max(0, breakdown.inputTokens - breakdown.cacheTokens);
    const cost = (
      nonCacheInput * inputPrice
      + breakdown.cacheTokens * cachePrice
      + breakdown.outputTokens * outputPrice
    ) * multiplier;
    const minimumMicros = Number(rule.ruleConfig.minimumMicros || 0);
    return Math.max(Math.round(cost), Number.isFinite(minimumMicros) ? minimumMicros : 0);
  }
  const baseCost = rule.unitPriceMicros * Math.max(0, Math.round(units)) * multiplier;
  const minimumMicros = Number(rule.ruleConfig.minimumMicros || 0);
  return Math.max(Math.round(baseCost), Number.isFinite(minimumMicros) ? minimumMicros : 0);
}

function calculateCreationSnapshotCost(
  snapshot: CreationPricingSnapshot,
  units: number,
  breakdown?: { inputTokens: number; outputTokens: number; cacheTokens: number },
): number {
  return applyGuChargeRounding(calculateCreationCostMicros(snapshot, units, breakdown, snapshot), { guChargeRounding: snapshot.guChargeRounding });
}

/**
 * 调用前预估费用并检查余额是否足够。
 * - 文本：按预估输入/输出 token 分价计算（缓存预估为 0）
 * - 图像/TTS：数量已知，精确计算
 * 余额不足时抛 InsufficientBalanceError。
 */
export async function estimateAndCheckBalance(
  endpointType: CreationEndpointType,
  model: string,
  estimatedUnits: number,
  breakdown?: { inputTokens: number; outputTokens: number; cacheTokens: number },
): Promise<void> {
  const ctx = getBillingContext();
  if (!ctx || ctx.skipBilling || !ctx.workspaceId) return;
  if (estimatedUnits <= 0) return;

  const bare = bareModel(model);
  const rule = await resolvePricingRule({ endpointType, model: bare, workspaceId: ctx.workspaceId });
  if (!rule) return;

  const priceSnapshot = freezeCreationPricing(rule);
  const costMicros = calculateCreationSnapshotCost(priceSnapshot, estimatedUnits, breakdown);
  if (costMicros <= 0) return;

  const availableMicros = await readWorkspaceAvailableMicros(ctx.workspaceId);
  if (availableMicros == null) return;

  if (availableMicros < costMicros) {
    const error = insufficientBalanceBillingError(costMicros, availableMicros);
    throw new InsufficientBalanceError(error.message);
  }
}

/**
 * Reserve the maximum expected creation charge before any provider side effect.
 * The returned session must be marked dispatched immediately before the
 * provider call, then settled or failed by the caller.
 */
export async function beginCreationBillingSession(
  input: CreationChargeInput,
): Promise<CreationBillingSession | null> {
  const ctx = getBillingContext();
  if (!ctx || ctx.skipBilling || !ctx.workspaceId) return null;
  if (!input.model || input.units <= 0) return null;

  const model = bareModel(input.model);
  const pricingRule = await resolvePricingRule({
    endpointType: input.endpointType,
    model,
    workspaceId: ctx.workspaceId,
  });
  const priceSnapshot = pricingRule ? freezeCreationPricing(pricingRule) : null;
  const reservedCostMicros = priceSnapshot
    ? calculateCreationSnapshotCost(priceSnapshot, input.units, input.tokenBreakdown)
    : 0;
  const identity = nextCreationIdentity(input);
  const metadata = sessionMetadata(input, priceSnapshot);
  const description = input.description ?? `creation ${input.endpointType}`;

  if (reservedCostMicros > 0) {
    const availableMicros = await readWorkspaceAvailableMicros(ctx.workspaceId);
    if (availableMicros != null && availableMicros < reservedCostMicros) {
      const error = insufficientBalanceBillingError(reservedCostMicros, availableMicros);
      throw new InsufficientBalanceError(error.message);
    }
  }

  const reservation = reservedCostMicros > 0
    ? await billApiTask({
        endpointType: input.endpointType,
        model,
        workspaceId: ctx.workspaceId,
        units: input.units,
        unit: input.unit || pricingRule?.unit || "task",
        costMicros: reservedCostMicros,
        currency: priceSnapshot?.currency,
        chargeMode: "reserve",
        requestId: identity.requestId,
        idempotencyKey: `${identity.billingKey}:reserve`,
        description: `${description} reserve`,
        operatorUserId: ctx.userId ?? null,
        metadata: {
          ...metadata,
          billingKey: identity.billingKey,
          reservedCostMicros,
          reservedUnits: input.units,
        },
      })
    : null;
  if (reservation?.idempotent) throw new BillingError("相同创作计费请求已在处理或已经完成", 409);
  if (reservedCostMicros > 0 && !reservation?.ledger) throw new BillingError("创作调用预扣未生成冻结流水", 500);

  return {
    workspaceId: ctx.workspaceId,
    requestId: identity.requestId,
    billingKey: identity.billingKey,
    endpointType: input.endpointType,
    model,
    unit: input.unit || pricingRule?.unit || "task",
    estimatedUnits: input.units,
    reservedCostMicros,
    reservationId: reservation?.ledger?.id ?? null,
    usageRecordId: reservation?.usage.id ?? null,
    provider: pricingRule?.provider ?? null,
    pricingRule,
    priceSnapshot,
    description,
    metadata,
    dispatched: false,
    finalized: false,
  };
}

export async function markCreationBillingDispatched(session: CreationBillingSession | null): Promise<void> {
  if (!session || session.finalized || !session.reservationId) return;
  if (session.dispatched) throw new BillingError("创作计费会话已标记上游派发", 409);
  await markApiTaskReservationDispatched({
    workspaceId: session.workspaceId,
    reservationId: session.reservationId,
    provider: session.provider,
    requestId: session.requestId,
  });
  session.dispatched = true;
}

async function persistCreationPendingReconcile(
  session: CreationBillingSession,
  input: CreationChargeInput,
  reason: string,
  settlementEvidenceComplete: boolean,
): Promise<void> {
  if (!session.reservationId) return;
  const actualCostMicros = session.priceSnapshot
    ? calculateCreationSnapshotCost(session.priceSnapshot, input.units, input.tokenBreakdown)
    : session.reservedCostMicros;
  await markApiTaskReservationPendingReconcile({
    workspaceId: session.workspaceId,
    reservationId: session.reservationId,
    units: input.units,
    unit: input.unit || session.unit,
    actualCostMicros,
    provider: session.provider,
    reason,
    metadata: {
      ...session.metadata,
      tokenBreakdown: input.tokenBreakdown ?? null,
      billingKey: session.billingKey,
      settlementUnit: input.unit || session.unit,
      settlementEvidenceComplete,
      creationRequestId: session.requestId,
    },
  });
  session.finalized = true;
}

/** Settle actual usage after a successful provider call without making the client retry it. */
export async function settleCreationBillingSession(
  session: CreationBillingSession | null,
  input: CreationChargeInput,
): Promise<"skipped" | "settled" | "pending_reconcile"> {
  if (!session || session.finalized) return "skipped";
  if (!session.reservationId) {
    try {
      const actualCostMicros = session.priceSnapshot
        ? calculateCreationSnapshotCost(session.priceSnapshot, input.units, input.tokenBreakdown)
        : 0;
      await billApiTask({
        endpointType: session.endpointType,
        model: session.model,
        workspaceId: session.workspaceId,
        units: input.units,
        unit: input.unit || session.unit,
        costMicros: actualCostMicros,
        currency: session.priceSnapshot?.currency,
        chargeMode: session.priceSnapshot ? "charge" : "none",
        requestId: session.requestId,
        idempotencyKey: `${session.billingKey}:direct`,
        description: session.description,
        metadata: {
          ...session.metadata,
          tokenBreakdown: input.tokenBreakdown ?? null,
          creationRequestId: session.requestId,
        },
      });
    } catch (error: any) {
      // No monetary reservation exists on an explicit-free/unpriced path. A
      // failed audit record must not make the client repeat the provider call.
      console.error("[creation-billing] free usage record failed", input.endpointType, input.model, error?.message || error);
    }
    session.finalized = true;
    return "settled";
  }
  let reconciliationReason = "settlement_failed";
  try {
    const actualCostMicros = session.priceSnapshot
      ? calculateCreationSnapshotCost(session.priceSnapshot, input.units, input.tokenBreakdown)
      : 0;
    if (actualCostMicros > session.reservedCostMicros) {
      reconciliationReason = "actual_cost_exceeds_reservation";
      await persistCreationPendingReconcile(session, input, reconciliationReason, true);
      return "pending_reconcile";
    }
    await settleApiTaskReservation({
      workspaceId: session.workspaceId,
      reservationId: session.reservationId,
      actualCostMicros,
      units: input.units,
      unit: input.unit || session.unit,
      provider: session.provider,
      requestId: session.requestId,
      idempotencyKey: session.billingKey,
      description: session.description,
      metadata: {
        ...session.metadata,
        tokenBreakdown: input.tokenBreakdown ?? null,
        creationRequestId: session.requestId,
      },
    });
    session.finalized = true;
    return "settled";
  } catch (error: any) {
    try {
      await persistCreationPendingReconcile(session, input, reconciliationReason, true);
    } catch (pendingError: any) {
      // The atomic dispatch watchdog remains durable even if this second write
      // fails. Do not throw after provider success: a client retry could invoke
      // the paid provider operation twice.
      console.error(
        "[creation-billing] CRITICAL settlement and pending persistence failed",
        input.endpointType,
        input.model,
        error?.message || error,
        pendingError?.message || pendingError,
      );
    } finally {
      // The provider has already completed. Even if both settlement writes
      // fail, the dispatch watchdog is the sole durable recovery path; this
      // in-memory session must never attempt the upstream operation again.
      session.finalized = true;
    }
    return "pending_reconcile";
  }
}

/** Preserve an unknown provider outcome, or safely release before dispatch. */
export async function failCreationBillingSession(
  session: CreationBillingSession | null,
  input: CreationChargeInput,
  error: unknown,
): Promise<void> {
  if (!session || session.finalized || !session.reservationId) return;
  if (session.dispatched) {
    try {
      await persistCreationPendingReconcile(session, input, "creation_provider_outcome_unknown", false);
    } catch (pendingError: any) {
      console.error(
        "[creation-billing] CRITICAL provider failure reconciliation persistence failed",
        input.endpointType,
        input.model,
        pendingError?.message || pendingError,
      );
    }
    return;
  }

  try {
    await releaseApiTaskReservation({
      workspaceId: session.workspaceId,
      reservationId: session.reservationId,
      requestId: session.requestId,
      idempotencyKey: session.billingKey,
      provider: session.provider,
      description: `${session.description} failed before dispatch`,
      releaseProof: "not_dispatched",
      metadata: {
        ...session.metadata,
        creationRequestId: session.requestId,
        failureName: error instanceof Error ? error.name : "UnknownError",
      },
    });
    session.finalized = true;
  } catch (releaseError: any) {
    try {
      await persistCreationPendingReconcile(session, input, "creation_pre_dispatch_release_failed", false);
    } catch (pendingError: any) {
      console.error(
        "[creation-billing] CRITICAL pre-dispatch release persistence failed",
        releaseError?.message || releaseError,
        pendingError?.message || pendingError,
      );
    }
  }
}

export async function chargeCreationCall(input: CreationChargeInput): Promise<void> {
  const ctx = getBillingContext();
  if (!ctx || ctx.skipBilling || !ctx.workspaceId) return;
  if (!input.model || input.units <= 0) return;

  const model = bareModel(input.model);
  const rule = await resolvePricingRule({
    endpointType: input.endpointType,
    model,
    workspaceId: ctx.workspaceId,
  });

  // 有定价规则时，统一算出 costMicros 传给 billApiTask
  const priceSnapshot = rule ? freezeCreationPricing(rule) : null;
  const overrideCostMicros = priceSnapshot
    ? calculateCreationSnapshotCost(priceSnapshot, input.units, input.tokenBreakdown)
    : null;

  if (!rule) {
    await billApiTask({
      endpointType: input.endpointType,
      model,
      workspaceId: ctx.workspaceId,
      units: input.units,
      unit: input.unit,
      costMicros: 0,
      chargeMode: "none",
      description: input.description ?? `creation ${input.endpointType}`,
      operatorUserId: ctx.userId ?? null,
      metadata: { source: "creation", projectId: ctx.projectId ?? null },
    });
    return;
  }

  await billApiTask({
    endpointType: input.endpointType,
    model,
    workspaceId: ctx.workspaceId,
    units: input.units,
    unit: input.unit || rule.unit,
    // 文本分价时用算好的 costMicros 覆盖；否则让 billApiTask 按 unitPriceMicros×units 算
    costMicros: overrideCostMicros,
    currency: priceSnapshot?.currency,
    chargeMode: "charge",
    description: input.description ?? `creation ${input.endpointType}`,
    operatorUserId: ctx.userId ?? null,
    metadata: sessionMetadata(input, priceSnapshot),
  });
}
