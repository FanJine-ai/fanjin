import { assertRequestVideoTokenEstimate, resolveVideoTokenReservation } from "@/lib/videoTokenReservation";
import { resolveVideoReferenceDurations } from "@/lib/videoReferenceDuration";
import type { VideoGenerationRequest } from "@/lib/videoGenerationContract";

type VideoReferencePricingContext = { projectId: number; request: VideoGenerationRequest };
import { ceilGuChargeMicros } from "@/lib/billingUnits";
import type { Knex } from "knex";
import { additionalImageReferenceCost } from "@/lib/imageReferencePricing";
import type { AgentApprovalQuote } from "@/agent-runtime/approvalService";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import { guFromMicros, yuanFromGuMicros } from "@/lib/billing";
import { AGENT_GENERATION_QUOTE_TABLE } from "@/lib/migrations/agentGenerationQuote";
import type { RelayVideoBillingAuthorizationFacts } from "@/lib/relay";
import {
  calculateResolvedVideoInputCost,
  resolveVideoInputPricing,
  type ResolvedVideoInputPricing,
  type VideoInputPricingTier,
} from "@/lib/videoInputPricing";
import {
  parseFanjinValueVideoPricingSnapshot,
  resolveFanjinValueVideoPricingSnapshot,
} from "@/lib/fanjinValueVideoPricing";
import { isFanjinValueVideoModel } from "@/lib/fanjinValueVideoOffers";
import { applyPricingAudienceForWorkspace } from "@/lib/pricingAudience";
import { resolveTimePricing, type TimePricingSnapshot } from "@/lib/timePricing";

export const AGENT_GENERATION_QUOTE_TTL_MS = 5 * 60 * 1_000;
export const WORKBENCH_GENERATION_BUDGET_VERSION =
  "workbench-generation-budget/v1" as const;

export type AgentGenerationType = "image" | "video";

export interface GenerationQuoteRequest {
  generationType: AgentGenerationType;
  model: string;
  units: number;
  provider?: string | null;
  /** Exact video reference-price tier; ignored only for image quotes. */
  videoInputPricingTier?: VideoInputPricingTier;
  /** Required for managed 480p→720p value offers; exact integer seconds. */
  durationSeconds?: number | null;
  resolution?: string | null;
}

export interface GenerationQuoteBinding {
  generationType: AgentGenerationType;
  provider: string;
  model: string;
  units: number;
}

export interface AgentGenerationQuoteDto extends GenerationQuoteBinding {
  quoteId: string;
  unit: "image" | "task" | "video" | "token";
  currency: "GU";
  estimatedCostMicros: number;
  maximumCostMicros: number;
  estimatedCostGu: number;
  maximumCostGu: number;
  estimatedCostYuanEquivalent: number;
  maximumCostYuanEquivalent: number;
  display: string;
  expiresAt: number;
}

export interface VerifiedAgentGenerationQuote {
  quote: AgentGenerationQuoteDto;
  approvalQuote: Required<AgentApprovalQuote>;
  videoBillingAuthorization?: RelayVideoBillingAuthorizationFacts | null;
  bindingDigest: string;
  pricingDigest: string;
}

/**
 * Read-only pricing exposure used by production acceptance operators.
 *
 * This intentionally has no quote id and is never persisted.  It resolves the
 * same route, audience pricing and managed-value composite pricing as an Agent
 * quote, but cannot authorize or submit a generation request.  The provider is
 * included only in the binding digest, so operator evidence does not disclose
 * private routing topology.
 */
export interface WorkbenchGenerationBudgetExposure {
  version: typeof WORKBENCH_GENERATION_BUDGET_VERSION;
  generationType: AgentGenerationType;
  model: string;
  units: number;
  videoInputPricingTier: VideoInputPricingTier;
  durationSeconds: number | null;
  currency: "GU";
  maximumCostMicros: number;
  pricingDigest: string;
  bindingDigest: string;
}

/**
 * Input for the approval-anchored quote entries (REVAMP-PLAN 1.1-6 / 1.2-4).
 * R2 submit tools mint their quote while the Run is paused for approval, i.e.
 * before the approved tool Step exists, so the quote binds to the succeeded
 * model-turn checkpoint (`modelStepId`) the approval paused on.
 */
export interface AgentGenerationQuoteApprovalAnchorInput {
  database: Knex.Transaction;
  workspaceId: string;
  projectId: number;
  runId: string;
  /** Succeeded model-turn checkpoint the approval paused on (never a tool Step). */
  modelStepId: string;
  actorUserId: number;
  request: GenerationQuoteRequest;
  now: number;
  ttlMs?: number;
}

interface RawGenerationQuoteRow {
  id: string;
  workspaceId: string;
  projectId: number | string;
  runId: string;
  stepId: string;
  actorUserId: number | string;
  generationType: string;
  endpointType: string;
  provider: string;
  model: string;
  units: number | string;
  unit: string;
  currency: string;
  estimatedCostMicros: number | string;
  maximumCostMicros: number | string;
  pricingRuleId: string;
  pricingRuleUpdatedAt: number | string;
  requestDigest: string;
  bindingDigest: string;
  pricingDigest: string;
  pricingSnapshot: unknown;
  expiresAt: number | string;
  createdAt: number | string;
}

interface PricingFacts {
  rule: PricingRule;
  unit: "image" | "task" | "video" | "token";
  estimatedCostMicros: number;
  maximumCostMicros: number;
  pricingDigest: string;
  pricingSnapshot: Record<string, unknown>;
}

interface PricingRule {
  id: string;
  scope: string;
  workspaceId: string | null;
  endpointType: string;
  provider: string | null;
  model: string | null;
  unit: string;
  unitPriceMicros: number;
  currency: string;
  ruleConfig: Record<string, unknown> | null;
  updateTime: number;
}

type QuoteDatabase = Knex | Knex.Transaction;

function fail(code: string, message: string, status = 409): never {
  throw new AgentToolGatewayError(code, message, { status });
}

function corrupt(): never {
  fail("generation_quote_record_corrupt", "持久化报价记录无效", 500);
}

function cleanIdentifier(value: unknown, field: string, maxLength = 200): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail("generation_quote_arguments_invalid", `${field} 无效`, 400);
  }
  return normalized;
}

function safePositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail("generation_quote_arguments_invalid", `${field} 必须是正安全整数`, 400);
  }
  return parsed;
}

function normalizeRequest(input: GenerationQuoteRequest): Required<GenerationQuoteRequest> {
  const generationType = String(input.generationType || "") as AgentGenerationType;
  if (generationType !== "image" && generationType !== "video") {
    fail("generation_quote_arguments_invalid", "generationType 必须是 image 或 video", 400);
  }
  const units = safePositiveInteger(input.units, "units");
  if ((generationType === "image" && units > 10) || (generationType === "video" && units !== 1)) {
    fail(
      "generation_quote_arguments_invalid",
      generationType === "image" ? "图片报价 units 必须在 1 到 10 之间" : "视频报价一次只能包含 1 个任务",
      400,
    );
  }
  const provider = input.provider == null || input.provider === ""
    ? null
    : cleanIdentifier(input.provider, "provider", 100);
  const videoInputPricingTier = input.videoInputPricingTier ?? "without_video_input";
  if (videoInputPricingTier !== "with_video_input" && videoInputPricingTier !== "without_video_input") {
    fail("generation_quote_arguments_invalid", "videoInputPricingTier 无效", 400);
  }
  if (generationType === "image" && videoInputPricingTier !== "without_video_input") {
    fail("generation_quote_arguments_invalid", "图片报价不能使用视频输入价格档", 400);
  }
  const durationSeconds = input.durationSeconds == null
    ? null
    : input.durationSeconds === -1 && generationType === "video"
      ? -1
      : safePositiveInteger(input.durationSeconds, "durationSeconds");
  if (durationSeconds !== null && durationSeconds > 60) {
    fail("generation_quote_arguments_invalid", "durationSeconds 必须在 1 到 60 之间", 400);
  }
  if (generationType === "image" && durationSeconds !== null) {
    fail("generation_quote_arguments_invalid", "图片报价不能绑定视频时长", 400);
  }
  if (generationType === "video" && isFanjinValueVideoModel(input.model) && durationSeconds === null) {
    fail("generation_quote_arguments_invalid", "繁境特价版视频报价必须绑定明确时长", 400);
  }
  return {
    generationType,
    model: cleanIdentifier(input.model, "model"),
    units,
    provider,
    videoInputPricingTier,
    durationSeconds,
    resolution: input.resolution == null ? null : cleanIdentifier(input.resolution, "resolution", 20),
  };
}

function endpointType(generationType: AgentGenerationType): "image_generation" | "video_generation" {
  return generationType === "image" ? "image_generation" : "video_generation";
}

function validUnit(
  generationType: AgentGenerationType,
  unit: string,
): unit is "image" | "task" | "video" | "token" {
  return generationType === "image"
    ? unit === "image"
    : unit === "task" || unit === "video" || unit === "token";
}

function scoped<T extends Knex.QueryBuilder>(query: T, workspaceId: string): T {
  return query.where((builder: Knex.QueryBuilder) => {
    builder.where("scope", "platform").orWhere({ scope: "workspace", workspaceId });
  }) as T;
}

function scopeOrdered<T extends Knex.QueryBuilder>(query: T, workspaceId: string): T {
  return query
    .orderByRaw(
      "CASE WHEN ?? = 'workspace' AND ?? = ? THEN 0 ELSE 1 END",
      ["scope", "workspaceId", workspaceId],
    ) as T;
}

function providerFromChannel(channel: Record<string, unknown>): string | null {
  const provider = String(channel.provider || "").trim();
  return provider || null;
}

function parsePricingConfig(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseChannelModels(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value || "[]");
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function channelSupportsModel(
  channel: Record<string, unknown>,
  model: string,
  routes: Array<Record<string, unknown>> = [],
): boolean {
  const explicitlyRouted = routes.some((route) => {
    const channelId = String(route.channelId || "").trim();
    if (channelId) return channelId === String(channel.id || "");
    const provider = String(route.provider || "").trim();
    return !provider || provider === String(channel.provider || "");
  });
  if (explicitlyRouted) return true;
  const models = parseChannelModels(channel.modelNames);
  return models.includes("*") || models.includes(model);
}

function formatPricingRule(row: Record<string, unknown>): PricingRule {
  return {
    id: String(row.id || ""),
    scope: String(row.scope || ""),
    workspaceId: row.workspaceId == null ? null : String(row.workspaceId),
    endpointType: String(row.endpointType || ""),
    provider: row.provider == null ? null : String(row.provider),
    model: row.model == null ? null : String(row.model),
    unit: String(row.unit || ""),
    unitPriceMicros: Number(row.unitPriceMicros),
    currency: String(row.currency || ""),
    ruleConfig: parsePricingConfig(row.ruleConfig),
    updateTime: Number(row.updateTime || 0),
  };
}

/** Transaction-only equivalent of the relay provider-specific resolver. */
async function resolveProviderPricingRule(input: {
  database: QuoteDatabase;
  workspaceId: string;
  endpointType: string;
  provider: string;
  model: string;
}): Promise<PricingRule | null> {
  const rows = await input.database("o_pricing_rule")
    .where({ endpointType: input.endpointType, provider: input.provider, disabled: 0 })
    .where((builder: Knex.QueryBuilder) => builder.whereNull("model").orWhere("model", input.model))
    .where((builder: Knex.QueryBuilder) => (
      builder.where("scope", "platform").orWhere({ scope: "workspace", workspaceId: input.workspaceId })
    ));
  const rules = rows.map((row: Record<string, unknown>) => formatPricingRule(row));
  const score = (rule: PricingRule) => (
    (rule.scope === "workspace" && rule.workspaceId === input.workspaceId ? 100 : 0)
    + (rule.model === input.model ? 10 : rule.model === null ? 1 : 0)
  );
  rules.sort((left, right) => score(right) - score(left) || right.updateTime - left.updateTime);
  const selected = rules[0] ?? null;
  // Preserve the existing invalid-rule failure below instead of normalizing a
  // corrupt ruleConfig into an empty object merely to evaluate its audience.
  if (!selected || !selected.ruleConfig) return selected;
  return (await applyPricingAudienceForWorkspace(
    input.database,
    input.workspaceId,
    selected as PricingRule & { ruleConfig: Record<string, unknown> },
  )).rule;
}

function requestPayloadForVideoPricingTier(
  tier: VideoInputPricingTier,
  durationSeconds: number | null,
  resolution: string | null = null,
): Record<string, unknown> {
  const payload = tier === "with_video_input"
    ? { content: [{ type: "video_url", video_url: { url: "pricing://video-input" } }] }
    : { content: [{ type: "text", text: "pricing" }] };
  return { ...payload, ...(durationSeconds == null ? {} : { duration: durationSeconds }), ...(resolution ? { resolution } : {}) };
}

async function candidateChannels(input: {
  database: QuoteDatabase;
  workspaceId: string;
  endpointType: string;
  provider?: string | null;
}): Promise<Array<Record<string, unknown>>> {
  let query = input.database("o_provider_channel")
    .where({ endpointType: input.endpointType, disabled: 0 })
    .select("id", "scope", "workspaceId", "endpointType", "provider", "modelNames", "priority", "weight");
  if (input.provider) query = query.andWhere("provider", input.provider);
  query = scoped(query, input.workspaceId);
  query = scopeOrdered(query, input.workspaceId);
  return query.orderBy("priority", "asc").orderBy("id", "asc");
}

/**
 * Resolves only persisted route/channel metadata. It never acquires a channel
 * lease, reads credentials or calls an upstream provider.
 */
async function resolveQuotedProvider(input: {
  database: QuoteDatabase;
  workspaceId: string;
  endpointType: string;
  model: string;
  preferredProvider?: string | null;
}): Promise<string> {
  let routeQuery = input.database("o_model_route")
    .where({ endpointType: input.endpointType, model: input.model, disabled: 0 })
    .select("id", "scope", "workspaceId", "endpointType", "model", "provider", "channelId", "priority", "fallbackOrder");
  routeQuery = scoped(routeQuery, input.workspaceId);
  routeQuery = scopeOrdered(routeQuery, input.workspaceId);
  const routes = await routeQuery.orderBy("priority", "asc").orderBy("fallbackOrder", "asc").orderBy("id", "asc");

  for (const route of routes) {
    const routeProvider = String(route.provider || "").trim() || null;
    const channelId = String(route.channelId || "").trim() || null;
    if (routeProvider && input.preferredProvider && routeProvider !== input.preferredProvider) continue;

    if (channelId) {
      let boundQuery = input.database("o_provider_channel")
        .where({ id: channelId, endpointType: input.endpointType, disabled: 0 })
        .select("id", "scope", "workspaceId", "endpointType", "provider", "modelNames", "priority", "weight");
      boundQuery = scoped(boundQuery, input.workspaceId);
      const channel = await boundQuery.first();
      const provider = channel ? providerFromChannel(channel) : null;
      if (!provider || (input.preferredProvider && provider !== input.preferredProvider)) continue;
      if (routeProvider && provider !== routeProvider) continue;
      if (channelSupportsModel(channel, input.model, [route])) return provider;
      continue;
    }

    const channels = await candidateChannels({
      database: input.database,
      workspaceId: input.workspaceId,
      endpointType: input.endpointType,
      provider: routeProvider || input.preferredProvider,
    });
    for (const channel of channels) {
      const provider = providerFromChannel(channel);
      if (!provider || (input.preferredProvider && provider !== input.preferredProvider)) continue;
      if (channelSupportsModel(channel, input.model, [route])) return provider;
    }
  }

  const genericChannels = await candidateChannels({
    database: input.database,
    workspaceId: input.workspaceId,
    endpointType: input.endpointType,
    provider: input.preferredProvider,
  });
  for (const channel of genericChannels) {
    const provider = providerFromChannel(channel);
    if (!provider) continue;
    if (channelSupportsModel(channel, input.model)) return provider;
  }

  fail("generation_quote_route_unavailable", "未配置与该模型匹配的图片/视频供应商路由", 409);
}

function pricingSnapshot(input: {
  rule: PricingRule;
  endpointType: string;
  provider: string;
  model: string;
  units: number;
  pricingUnits: number;
  unit: "image" | "task" | "video" | "token";
  costMicros: number;
  baseMultiplier: number;
  timePricing: TimePricingSnapshot;
  selectedVideoPricing?: ResolvedVideoInputPricing | null;
  valueVideoPricingSnapshot?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const selected = input.selectedVideoPricing ?? null;
  return {
    pricingRuleId: input.rule.id,
    pricingRuleUpdatedAt: input.rule.updateTime,
    endpointType: input.endpointType,
    provider: input.provider,
    requestedModel: input.model,
    pricedModel: input.rule.model,
    units: input.units,
    ...(input.unit === "token" ? { pricingUnits: input.pricingUnits } : {}),
    unit: input.unit,
    ...(selected
      ? {
          pricingRuleBaseUnitPriceMicros: input.rule.unitPriceMicros,
          unitPriceMicros: selected.unitPriceMicros,
          multiplier: selected.multiplier,
          baseMultiplier: input.baseMultiplier,
          minimumMicros: selected.minimumMicros,
          videoInputPricingTier: selected.tier,
          videoInputPricingConfigured: selected.configured,
        }
      : {
          unitPriceMicros: input.rule.unitPriceMicros,
          multiplier: input.baseMultiplier * input.timePricing.multiplier,
          baseMultiplier: input.baseMultiplier,
          minimumMicros: Number(input.rule.ruleConfig?.minimumMicros ?? 0),
        }),
    ...(input.unit === "image" && input.rule.ruleConfig?.referenceImagePricing ? { referenceImagePricing: input.rule.ruleConfig.referenceImagePricing } : {}),
    timePricing: input.timePricing,
    ...(input.unit === "token"
      ? { reservationUpperBoundTokens: input.pricingUnits }
      : {}),
    ...(input.valueVideoPricingSnapshot
      ? { fanjinValueVideoPricing: input.valueVideoPricingSnapshot }
      : {}),
    costMicros: input.costMicros,
    currency: input.rule.currency,
  };
}

function pricingSnapshotDigest(snapshot: Record<string, unknown>): string {
  const timePricing = snapshot.timePricing;
  if (!timePricing || typeof timePricing !== "object" || Array.isArray(timePricing)) {
    return hashIdempotencyRequest(snapshot);
  }
  const stableTimePricing = { ...timePricing as Record<string, unknown> };
  delete stableTimePricing.evaluatedAt;
  return hashIdempotencyRequest({
    ...snapshot,
    timePricing: stableTimePricing,
  });
}

async function resolvePricingFacts(input: {
  database: QuoteDatabase;
  workspaceId: string;
  generationType: AgentGenerationType;
  provider: string;
  model: string;
  units: number;
  videoInputPricingTier: VideoInputPricingTier;
  durationSeconds: number | null;
  resolution?: string | null;
  evaluatedAt: number;
  videoReferenceContext?: VideoReferencePricingContext;
}): Promise<PricingFacts> {
  const targetEndpoint = endpointType(input.generationType);
  const rule = await resolveProviderPricingRule({
    database: input.database,
    workspaceId: input.workspaceId,
    endpointType: targetEndpoint,
    provider: input.provider,
    model: input.model,
  });
  if (!rule) {
    fail("generation_quote_pricing_missing", "未配置当前供应商与模型的专属 GU 定价，已拒绝报价", 402);
  }
  if (rule.provider !== input.provider || rule.endpointType !== targetEndpoint) {
    fail("generation_quote_pricing_invalid", "定价规则与供应商或任务类型不匹配", 409);
  }
  if (rule.model && rule.model !== input.model) {
    fail("generation_quote_pricing_invalid", "定价规则与请求模型不匹配", 409);
  }
  if (rule.currency !== "GU") {
    fail("generation_quote_pricing_invalid", "图片/视频报价只允许使用 GU", 409);
  }
  if (!validUnit(input.generationType, rule.unit)) {
    fail(
      "generation_quote_pricing_invalid",
      input.generationType === "image"
        ? "图片定价单位必须为 image"
        : "视频定价单位必须为 task、video 或 token",
      409,
    );
  }
  if (rule.unit === "token" && input.provider !== "volcano") {
    fail(
      "generation_quote_pricing_invalid",
      "视频 token 计费目前仅支持返回权威 usage.completion_tokens 的火山引擎通道",
      409,
    );
  }
  if (!Number.isSafeInteger(rule.unitPriceMicros) || rule.unitPriceMicros <= 0) {
    fail("generation_quote_pricing_invalid", "定价单价必须是正安全整数", 409);
  }
  if (!rule.ruleConfig) {
    fail("generation_quote_pricing_invalid", "定价 ruleConfig 必须是有效 JSON 对象", 409);
  }
  if (input.generationType === "video" && input.durationSeconds === -1
    && (input.provider !== "volcano" || rule.unit !== "token")) {
    fail("generation_quote_arguments_invalid", "当前模型计费方式不支持自动时长，请选择固定时长", 422);
  }
  let selectedVideoPricing: ResolvedVideoInputPricing | null = null;
  if (input.generationType === "video") {
    try {
      selectedVideoPricing = resolveVideoInputPricing({
        ruleConfig: rule.ruleConfig,
        requestPayload: requestPayloadForVideoPricingTier(
          input.videoInputPricingTier,
          input.durationSeconds,
          input.resolution ?? null,
        ),
        baseUnitPriceMicros: rule.unitPriceMicros,
      });
    } catch (caught) {
      fail(
        "generation_quote_pricing_invalid",
        `视频输入分档定价配置无效: ${caught instanceof Error ? caught.message : "unknown"}`,
        409,
      );
    }
  }
  const baseMultiplier = selectedVideoPricing?.multiplier
    ?? Number(rule.ruleConfig?.multiplier ?? 1);
  const timePricing = resolveTimePricing(rule.ruleConfig, input.evaluatedAt);
  const multiplier = baseMultiplier * timePricing.multiplier;
  const minimumMicros = selectedVideoPricing?.minimumMicros
    ?? Number(rule.ruleConfig?.minimumMicros ?? 0);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    fail("generation_quote_pricing_invalid", "定价 multiplier 必须是正数", 409);
  }
  if (!Number.isSafeInteger(minimumMicros) || minimumMicros < 0) {
    fail("generation_quote_pricing_invalid", "定价 minimumMicros 必须是非负安全整数", 409);
  }
  const referenceDurations = rule.unit === "token" && input.videoReferenceContext
    ? await resolveVideoReferenceDurations({ database: input.database, workspaceId: input.workspaceId,
      ...input.videoReferenceContext }) : undefined;
  const tokenReservationPayload = requestPayloadForVideoPricingTier(input.videoInputPricingTier, input.durationSeconds, input.resolution ?? null);
  if (input.videoReferenceContext?.request.operation === "edit") tokenReservationPayload.omni_reference_task_type = "edit";
  if (referenceDurations && input.videoInputPricingTier === "with_video_input") {
    tokenReservationPayload.content = Array.from({ length: referenceDurations.count }, () => ({ type: "video_url" }));
  }
  const tokenReservation = rule.unit === "token" && selectedVideoPricing?.reservationUpperBoundTokens != null
    ? resolveVideoTokenReservation({
      model: input.model, ruleConfig: rule.ruleConfig,
      requestPayload: tokenReservationPayload,
      configuredUpperBoundTokens: selectedVideoPricing.reservationUpperBoundTokens,
      referenceDurations,
    }) : null;
  if (input.videoReferenceContext) assertRequestVideoTokenEstimate(tokenReservation);
  const pricingUnits = rule.unit === "token"
    ? tokenReservation?.reservationTokens ?? null
    : input.units;
  if (pricingUnits == null) {
    fail(
      "generation_quote_pricing_invalid",
      "视频 token 计费必须配置正整数 ruleConfig.reservationUpperBoundTokens，禁止猜测预扣 token 数",
      409,
    );
  }
  const effectiveVideoPricing = selectedVideoPricing
    ? { ...selectedVideoPricing, multiplier }
    : null;
  const generationReservationCostMicros = effectiveVideoPricing
    ? calculateResolvedVideoInputCost(effectiveVideoPricing, pricingUnits)
    : Math.max(Math.round((rule.unitPriceMicros * pricingUnits + (input.generationType === "image" ? additionalImageReferenceCost(rule.ruleConfig || {}) : 0)) * multiplier), minimumMicros);
  let valueVideoPricingSnapshot: Record<string, unknown> | null = null;
  try {
    valueVideoPricingSnapshot = await resolveFanjinValueVideoPricingSnapshot({
      database: input.database,
      workspaceId: input.workspaceId,
      publicModel: input.model,
      ruleConfig: rule.ruleConfig,
      requestPayload: requestPayloadForVideoPricingTier(
        input.videoInputPricingTier,
        input.durationSeconds,
        input.resolution ?? null,
      ),
      generationReservationCostMicros,
    });
  } catch (caught) {
    fail(
      "generation_quote_pricing_invalid",
      `繁境特价版组合定价配置无效: ${caught instanceof Error ? caught.message : "unknown"}`,
      409,
    );
  }
  if (valueVideoPricingSnapshot && rule.unit !== "token") {
    fail(
      "generation_quote_pricing_invalid",
      "繁境特价版生成成本必须使用火山终态 token 计费",
      409,
    );
  }
  const estimatedCostMicros = ceilGuChargeMicros(Number(
    valueVideoPricingSnapshot?.reservationCostMicros ?? generationReservationCostMicros,
  ));
  if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros <= 0) {
    fail("generation_quote_pricing_invalid", "报价金额必须是正安全整数", 409);
  }
  const snapshot = pricingSnapshot({
    rule,
    endpointType: targetEndpoint,
    provider: input.provider,
    model: input.model,
    units: input.units,
    pricingUnits,
    unit: rule.unit,
    costMicros: estimatedCostMicros,
    baseMultiplier,
    timePricing,
    selectedVideoPricing: effectiveVideoPricing,
    valueVideoPricingSnapshot,
  });
  if (tokenReservation) snapshot.tokenReservation = tokenReservation;
  if (input.generationType === "video" && input.resolution) snapshot.videoResolution = input.resolution;
  if (input.generationType === "video" && input.durationSeconds != null) snapshot.videoDurationSeconds = input.durationSeconds;
  return {
    rule,
    unit: rule.unit,
    estimatedCostMicros,
    maximumCostMicros: estimatedCostMicros,
    pricingDigest: pricingSnapshotDigest(snapshot),
    pricingSnapshot: snapshot,
  };
}

function bindingDigest(binding: GenerationQuoteBinding): string {
  return hashIdempotencyRequest({
    generationType: binding.generationType,
    provider: binding.provider,
    model: binding.model,
    units: binding.units,
  });
}

function quoteIdForStep(stepId: string): string {
  return `quote_${hashIdempotencyRequest({ stepId }).slice(0, 40)}`;
}

/**
 * The persisted `stepId` column doubles as a generalized binding-anchor key,
 * so no schema change is required. Tool-step quotes (generation.quote) keep
 * the raw stepId; approval-phase quotes use a namespaced
 * `approval:<modelStepId>` key. Runtime step ids are UUIDs, which can never
 * carry this prefix, and the quoteId derivation below hashes a different
 * input shape per anchor family, so the two namespaces cannot collide.
 */
export const AGENT_GENERATION_QUOTE_APPROVAL_ANCHOR_PREFIX = "approval:";

export function agentGenerationQuoteApprovalAnchorKey(modelStepId: string): string {
  return `${AGENT_GENERATION_QUOTE_APPROVAL_ANCHOR_PREFIX}${cleanIdentifier(modelStepId, "modelStepId")}`;
}

function parseApprovalAnchorKey(stepId: string): string | null {
  if (!stepId.startsWith(AGENT_GENERATION_QUOTE_APPROVAL_ANCHOR_PREFIX)) return null;
  const modelStepId = stepId.slice(AGENT_GENERATION_QUOTE_APPROVAL_ANCHOR_PREFIX.length);
  if (!modelStepId || modelStepId.length > 200) return null;
  // Same control-character rule as cleanIdentifier, kept escape-free.
  for (let index = 0; index < modelStepId.length; index += 1) {
    const code = modelStepId.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return modelStepId;
}

function quoteIdForApprovalAnchor(input: { runId: string; modelStepId: string }): string {
  return `quote_${hashIdempotencyRequest({
    approvalAnchor: { runId: input.runId, modelStepId: input.modelStepId },
  }).slice(0, 40)}`;
}

function persistedPricingSnapshot(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      corrupt();
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) corrupt();
  return parsed as Record<string, unknown>;
}

function validatePersistedRow(row: RawGenerationQuoteRow): {
  quote: AgentGenerationQuoteDto;
  pricingSnapshot: Record<string, unknown>;
} {
  const generationType = String(row.generationType) as AgentGenerationType;
  const unit = String(row.unit);
  const units = Number(row.units);
  const estimatedCostMicros = Number(row.estimatedCostMicros);
  const maximumCostMicros = Number(row.maximumCostMicros);
  const expiresAt = Number(row.expiresAt);
  const createdAt = Number(row.createdAt);
  const actorUserId = Number(row.actorUserId);
  const pricingRuleUpdatedAt = Number(row.pricingRuleUpdatedAt);
  const provider = String(row.provider || "");
  const model = String(row.model || "");
  const pricingRuleId = String(row.pricingRuleId || "");
  const rowBindingDigest = String(row.bindingDigest || "");
  const rowPricingDigest = String(row.pricingDigest || "");
  const requestDigest = String(row.requestDigest || "");
  const stepId = String(row.stepId || "");
  const snapshot = persistedPricingSnapshot(row.pricingSnapshot);
  const approvalModelStepId = parseApprovalAnchorKey(stepId);
  if (stepId.startsWith(AGENT_GENERATION_QUOTE_APPROVAL_ANCHOR_PREFIX) && !approvalModelStepId) corrupt();
  const persistedQuoteId = approvalModelStepId
    ? quoteIdForApprovalAnchor({ runId: String(row.runId), modelStepId: approvalModelStepId })
    : quoteIdForStep(stepId);
  if (
    (generationType !== "image" && generationType !== "video")
    || !validUnit(generationType, unit)
    || String(row.endpointType) !== endpointType(generationType)
    || !provider
    || !model
    || !pricingRuleId
    || !stepId
    || String(row.id) !== persistedQuoteId
    || !Number.isSafeInteger(actorUserId)
    || actorUserId <= 0
    || row.currency !== "GU"
    || !Number.isSafeInteger(units)
    || units <= 0
    || (generationType === "image" && units > 10)
    || (generationType === "video" && units !== 1)
    || !Number.isSafeInteger(estimatedCostMicros)
    || estimatedCostMicros <= 0
    || !Number.isSafeInteger(maximumCostMicros)
    || maximumCostMicros < estimatedCostMicros
    || !Number.isSafeInteger(expiresAt)
    || !Number.isSafeInteger(createdAt)
    || expiresAt <= createdAt
    || !Number.isSafeInteger(pricingRuleUpdatedAt)
    || pricingRuleUpdatedAt < 0
    || !/^[a-f0-9]{64}$/.test(requestDigest)
    || !/^[a-f0-9]{64}$/.test(rowBindingDigest)
    || !/^[a-f0-9]{64}$/.test(rowPricingDigest)
  ) {
    corrupt();
  }
  const storedBinding: GenerationQuoteBinding = { generationType, provider, model, units };
  if (bindingDigest(storedBinding) !== rowBindingDigest) corrupt();
  const pricingUnits = Number(snapshot.pricingUnits);
  const reservationUpperBoundTokens = snapshot.reservationUpperBoundTokens == null
    ? null
    : Number(snapshot.reservationUpperBoundTokens);
  const tokenPricingSnapshotValid = unit !== "token" || (
    generationType === "video"
    && provider === "volcano"
    && Number.isSafeInteger(pricingUnits)
    && pricingUnits > 0
    && reservationUpperBoundTokens !== null
    && Number.isSafeInteger(reservationUpperBoundTokens)
    && reservationUpperBoundTokens > 0
    && pricingUnits === reservationUpperBoundTokens
  );
  const persistedTimePricing = snapshot.timePricing;
  const timePricingSnapshotValid = persistedTimePricing == null || (
    typeof persistedTimePricing === "object"
    && !Array.isArray(persistedTimePricing)
    && Number((persistedTimePricing as Record<string, unknown>).evaluatedAt) === createdAt
    && Number.isSafeInteger(Number((persistedTimePricing as Record<string, unknown>).multiplierBps))
    && Number((persistedTimePricing as Record<string, unknown>).multiplierBps) > 0
    && Number((persistedTimePricing as Record<string, unknown>).multiplier)
      === Number((persistedTimePricing as Record<string, unknown>).multiplierBps) / 10_000
    && Number.isFinite(Number(snapshot.baseMultiplier))
    && Number(snapshot.baseMultiplier) > 0
    && Number(snapshot.multiplier)
      === Number(snapshot.baseMultiplier) * Number((persistedTimePricing as Record<string, unknown>).multiplier)
  );
  const valuePricingSnapshot = snapshot.fanjinValueVideoPricing;
  let valuePricingSnapshotValid = valuePricingSnapshot == null;
  if (isFanjinValueVideoModel(model) && valuePricingSnapshot != null) {
    try {
      const parsed = parseFanjinValueVideoPricingSnapshot(valuePricingSnapshot);
      valuePricingSnapshotValid = parsed.publicModel === model
        && parsed.reservationCostMicros === estimatedCostMicros;
    } catch {
      valuePricingSnapshotValid = false;
    }
  }
  if (
    String(snapshot.pricingRuleId || "") !== pricingRuleId
    || Number(snapshot.pricingRuleUpdatedAt) !== pricingRuleUpdatedAt
    || String(snapshot.endpointType || "") !== endpointType(generationType)
    || String(snapshot.provider || "") !== provider
    || String(snapshot.requestedModel || "") !== model
    || Number(snapshot.units) !== units
    || !tokenPricingSnapshotValid
    || !timePricingSnapshotValid
    || !valuePricingSnapshotValid
    || String(snapshot.unit || "") !== unit
    || Number(snapshot.costMicros) !== estimatedCostMicros
    || maximumCostMicros !== estimatedCostMicros
    || String(snapshot.currency || "") !== "GU"
    || pricingSnapshotDigest(snapshot) !== rowPricingDigest
  ) {
    corrupt();
  }
  return { quote: {
    quoteId: String(row.id),
    generationType,
    provider,
    model,
    units,
    unit,
    currency: "GU",
    estimatedCostMicros,
    maximumCostMicros,
    estimatedCostGu: guFromMicros(estimatedCostMicros),
    maximumCostGu: guFromMicros(maximumCostMicros),
    estimatedCostYuanEquivalent: yuanFromGuMicros(estimatedCostMicros),
    maximumCostYuanEquivalent: yuanFromGuMicros(maximumCostMicros),
    display: `${guFromMicros(estimatedCostMicros)} GU（约 ¥${yuanFromGuMicros(estimatedCostMicros).toFixed(2)}）`,
    expiresAt,
  }, pricingSnapshot: snapshot };
}

interface ResolvedQuoteFacts {
  request: Required<GenerationQuoteRequest>;
  provider: string;
  pricing: PricingFacts;
  binding: GenerationQuoteBinding;
}

async function resolveQuoteFacts(input: {
  database: QuoteDatabase;
  workspaceId: string;
  request: GenerationQuoteRequest;
  evaluatedAt: number;
  videoReferenceContext?: VideoReferencePricingContext;
}): Promise<ResolvedQuoteFacts> {
  const request = normalizeRequest(input.request);
  const provider = await resolveQuotedProvider({
    database: input.database,
    workspaceId: input.workspaceId,
    endpointType: endpointType(request.generationType),
    model: request.model,
    preferredProvider: request.provider,
  });
  const pricing = await resolvePricingFacts({
    database: input.database,
    workspaceId: input.workspaceId,
    generationType: request.generationType,
    provider,
    model: request.model,
    units: request.units,
    videoInputPricingTier: request.videoInputPricingTier,
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    evaluatedAt: input.evaluatedAt,
    videoReferenceContext: input.videoReferenceContext,
  });
  return {
    request,
    provider,
    pricing,
    binding: {
      generationType: request.generationType,
      provider,
      model: request.model,
      units: request.units,
    },
  };
}

/**
 * Resolve an exact server-local maximum GU exposure without writing a quote,
 * reserving GU or acquiring a provider lease. Scoped video references may be
 * read from controlled storage to measure their duration.
 */
export async function resolveWorkbenchGenerationBudgetExposure(input: {
  database: QuoteDatabase;
  workspaceId: string;
  request: GenerationQuoteRequest;
  videoReferenceContext?: VideoReferencePricingContext;
}): Promise<WorkbenchGenerationBudgetExposure> {
  const facts = await resolveQuoteFacts({
    ...input,
    evaluatedAt: Date.now(),
  });
  return Object.freeze({
    version: WORKBENCH_GENERATION_BUDGET_VERSION,
    generationType: facts.request.generationType,
    model: facts.request.model,
    units: facts.request.units,
    videoInputPricingTier: facts.request.videoInputPricingTier,
    durationSeconds: facts.request.durationSeconds,
    currency: "GU",
    maximumCostMicros: facts.pricing.maximumCostMicros,
    pricingDigest: facts.pricing.pricingDigest,
    bindingDigest: bindingDigest(facts.binding),
  });
}

function quoteExpiry(now: number, ttlMs?: number): number {
  const effectiveTtlMs = ttlMs ?? AGENT_GENERATION_QUOTE_TTL_MS;
  if (!Number.isSafeInteger(effectiveTtlMs) || effectiveTtlMs < 1_000 || effectiveTtlMs > AGENT_GENERATION_QUOTE_TTL_MS) {
    fail("generation_quote_ttl_invalid", "报价 TTL 无效", 500);
  }
  const expiresAt = now + effectiveTtlMs;
  if (!Number.isSafeInteger(expiresAt)) fail("generation_quote_ttl_invalid", "报价过期时间无效", 500);
  return expiresAt;
}

function quoteRowValues(input: {
  quoteId: string;
  anchorKey: string;
  workspaceId: string;
  projectId: number;
  runId: string;
  actorUserId: number;
  facts: ResolvedQuoteFacts;
  expiresAt: number;
  createdAt: number;
}): Record<string, unknown> {
  const { facts } = input;
  return {
    id: input.quoteId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    runId: input.runId,
    stepId: input.anchorKey,
    actorUserId: input.actorUserId,
    generationType: facts.request.generationType,
    endpointType: endpointType(facts.request.generationType),
    provider: facts.provider,
    model: facts.request.model,
    units: facts.request.units,
    unit: facts.pricing.unit,
    currency: "GU",
    estimatedCostMicros: facts.pricing.estimatedCostMicros,
    maximumCostMicros: facts.pricing.maximumCostMicros,
    pricingRuleId: facts.pricing.rule.id,
    pricingRuleUpdatedAt: facts.pricing.rule.updateTime,
    requestDigest: hashIdempotencyRequest(facts.request),
    bindingDigest: bindingDigest(facts.binding),
    pricingDigest: facts.pricing.pricingDigest,
    pricingSnapshot: JSON.stringify(facts.pricing.pricingSnapshot),
    expiresAt: input.expiresAt,
    createdAt: input.createdAt,
  };
}

function quoteDto(input: {
  quoteId: string;
  facts: ResolvedQuoteFacts;
  expiresAt: number;
}): AgentGenerationQuoteDto {
  const estimatedCostMicros = input.facts.pricing.estimatedCostMicros;
  const maximumCostMicros = input.facts.pricing.maximumCostMicros;
  const estimatedCostGu = guFromMicros(estimatedCostMicros);
  return {
    quoteId: input.quoteId,
    ...input.facts.binding,
    unit: input.facts.pricing.unit,
    currency: "GU",
    estimatedCostMicros,
    maximumCostMicros,
    estimatedCostGu,
    maximumCostGu: guFromMicros(maximumCostMicros),
    estimatedCostYuanEquivalent: yuanFromGuMicros(estimatedCostMicros),
    maximumCostYuanEquivalent: yuanFromGuMicros(maximumCostMicros),
    display: `${estimatedCostGu} GU（约 ¥${yuanFromGuMicros(estimatedCostMicros).toFixed(2)}）`,
    expiresAt: input.expiresAt,
  };
}

export async function createAgentGenerationQuote(input: {
  database: Knex.Transaction;
  workspaceId: string;
  projectId: number;
  runId: string;
  stepId: string;
  actorUserId: number;
  request: GenerationQuoteRequest;
  now: number;
  ttlMs?: number;
}): Promise<AgentGenerationQuoteDto> {
  const facts = await resolveQuoteFacts({
    database: input.database,
    workspaceId: input.workspaceId,
    request: input.request,
    evaluatedAt: input.now,
  });
  const expiresAt = quoteExpiry(input.now, input.ttlMs);
  const quoteId = quoteIdForStep(input.stepId);
  await input.database(AGENT_GENERATION_QUOTE_TABLE).insert(quoteRowValues({
    quoteId,
    anchorKey: input.stepId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    runId: input.runId,
    actorUserId: input.actorUserId,
    facts,
    expiresAt,
    createdAt: input.now,
  }));
  return quoteDto({ quoteId, facts, expiresAt });
}

async function requireApprovalAnchorModelStep(input: {
  database: QuoteDatabase;
  workspaceId: string;
  projectId: number;
  runId: string;
  modelStepId: string;
}): Promise<void> {
  const modelStep = await input.database("o_agent_step")
    .where({
      id: input.modelStepId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      kind: "model",
      status: "succeeded",
    })
    .select("id")
    .first();
  if (!modelStep) {
    fail("generation_quote_anchor_invalid", "报价绑定的模型回合检查点不存在或未完成", 409);
  }
}

async function issueApprovalAnchoredQuote(
  input: AgentGenerationQuoteApprovalAnchorInput,
  mode: "upsert" | "replace",
): Promise<AgentGenerationQuoteDto> {
  const modelStepId = cleanIdentifier(input.modelStepId, "modelStepId");
  const anchorKey = agentGenerationQuoteApprovalAnchorKey(modelStepId);
  const quoteId = quoteIdForApprovalAnchor({ runId: input.runId, modelStepId });
  const facts = await resolveQuoteFacts({
    database: input.database,
    workspaceId: input.workspaceId,
    request: input.request,
    evaluatedAt: input.now,
  });
  const expiresAt = quoteExpiry(input.now, input.ttlMs);
  await requireApprovalAnchorModelStep({
    database: input.database,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    runId: input.runId,
    modelStepId,
  });
  const scope = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    runId: input.runId,
  };
  const existing = await input.database<RawGenerationQuoteRow>(AGENT_GENERATION_QUOTE_TABLE)
    .where({ id: quoteId, ...scope })
    .first();
  if (!existing && mode === "replace") {
    fail("generation_quote_not_found", "报价不存在，无法重发", 404);
  }
  const values = quoteRowValues({
    quoteId,
    anchorKey,
    ...scope,
    actorUserId: input.actorUserId,
    facts,
    expiresAt,
    createdAt: input.now,
  });
  if (existing) {
    // Replacing must never silently resurrect a tampered row.
    validatePersistedRow(existing);
    const mutable: Record<string, unknown> = { ...values };
    delete mutable.id;
    delete mutable.workspaceId;
    delete mutable.projectId;
    delete mutable.runId;
    delete mutable.stepId;
    const updated = await input.database(AGENT_GENERATION_QUOTE_TABLE)
      .where({ id: quoteId, ...scope, stepId: anchorKey })
      .update(mutable);
    if (Number(updated) !== 1) {
      fail("generation_quote_anchor_conflict", "报价绑定更新冲突，请重试", 409);
    }
  } else {
    await input.database(AGENT_GENERATION_QUOTE_TABLE).insert(values);
  }
  return quoteDto({ quoteId, facts, expiresAt });
}

/**
 * R2 approval evidence-phase entry (REVAMP-PLAN 1.1-6): mints the quote while
 * the Run is paused for approval and the approved tool Step does not exist
 * yet, binding the quote to the model-turn checkpoint via an
 * `approval:<modelStepId>` anchor instead of a tool stepId. The entry is
 * idempotent on the anchor: a repeated call (e.g. approval evidence being
 * re-resolved) re-resolves routing/pricing and atomically replaces the
 * persisted facts under the same stable quoteId, which already covers the
 * "resend" half of the lifecycle.
 */
export async function createAgentGenerationQuoteForApproval(
  input: AgentGenerationQuoteApprovalAnchorInput,
): Promise<AgentGenerationQuoteDto> {
  return issueApprovalAnchoredQuote(input, "upsert");
}

/**
 * Post-decision resend/rebind entry (REVAMP-PLAN 1.2-4): re-mints the quote on
 * the same approval anchor with the (possibly revised) request after a
 * decide-with-revision. The quoteId stays stable because it derives from the
 * anchor; binding digest, pricing snapshot and expiry are replaced atomically,
 * so the pre-execution verify re-checks the new binding while stale copies of
 * the old facts can never validate. Fails closed when no quote exists yet.
 */
export async function resendAgentGenerationQuoteForApproval(
  input: AgentGenerationQuoteApprovalAnchorInput,
): Promise<AgentGenerationQuoteDto> {
  return issueApprovalAnchoredQuote(input, "replace");
}

/**
 * Future R2 submit/approval adapters must resolve an opaque quoteId through
 * this method instead of trusting a quote object returned by a client/model.
 * Both anchor families verify here: tool-step quotes cross-check the succeeded
 * generation.quote tool Step, while approval-anchored quotes cross-check the
 * succeeded model-turn checkpoint they were minted on (REVAMP-PLAN 1.1-6).
 * Current executeRelayImage/createRelayTask entry points do not consume this
 * binding or pin the quoted provider, so Agent image/video submit tools must
 * remain disabled until a dedicated adapter re-verifies here immediately
 * before reservation and dispatch.
 */
interface AgentGenerationQuoteVerificationInput {
  database: QuoteDatabase;
  quoteId: string;
  workspaceId: string;
  projectId: number;
  runId: string;
  expected: GenerationQuoteBinding;
  videoInputPricingTier?: VideoInputPricingTier;
  durationSeconds?: number | null;
  resolution?: string | null;
  now: number;
}

interface PersistedVerifiedGenerationQuote {
  row: RawGenerationQuoteRow;
  quote: AgentGenerationQuoteDto;
  pricingSnapshot: Record<string, unknown>;
  expected: Omit<Required<GenerationQuoteRequest>, "provider"> & { provider: string };
}

async function verifyPersistedAgentGenerationQuote(
  input: AgentGenerationQuoteVerificationInput,
): Promise<PersistedVerifiedGenerationQuote> {
  const quoteId = cleanIdentifier(input.quoteId, "quoteId");
  const row = await input.database<RawGenerationQuoteRow>(AGENT_GENERATION_QUOTE_TABLE)
    .where({
      id: quoteId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
    })
    .first();
  if (!row) fail("generation_quote_not_found", "报价不存在", 404);
  const { quote, pricingSnapshot: snapshot } = validatePersistedRow(row);
  const approvalModelStepId = parseApprovalAnchorKey(String(row.stepId || ""));
  if (approvalModelStepId) {
    // Approval-anchored quotes were minted while the Run was paused on this
    // model-turn checkpoint; the approved tool Step is created only after the
    // decision, so legitimacy is anchored to the succeeded model Step instead.
    const modelStep = await input.database("o_agent_step")
      .where({
        id: approvalModelStepId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        runId: input.runId,
        kind: "model",
        status: "succeeded",
      })
      .select("id")
      .first();
    if (!modelStep) corrupt();
  } else {
    const step = await input.database("o_agent_step")
      .where({
        id: row.stepId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        runId: input.runId,
        kind: "tool",
        toolName: "generation.quote",
        status: "succeeded",
      })
      .select("argumentsDigest")
      .first();
    if (!step || String(step.argumentsDigest || "") !== String(row.requestDigest)) corrupt();
  }
  if (quote.expiresAt <= input.now) fail("generation_quote_expired", "报价已过期，请重新报价", 409);
  const expected = normalizeRequest({
    ...input.expected,
    durationSeconds: input.durationSeconds ?? null,
  });
  if (!expected.provider) fail("generation_quote_binding_mismatch", "执行参数必须绑定报价中的 provider", 409);
  const expectedVideoInputPricingTier = input.videoInputPricingTier ?? "without_video_input";
  if (
    expected.generationType === "video"
    && String(snapshot.videoInputPricingTier || "without_video_input") !== expectedVideoInputPricingTier
  ) {
    fail("generation_quote_binding_mismatch", "报价与当前视频输入价格档不一致", 409);
  }
  if (expected.generationType === "video" && String(snapshot.videoResolution || "") !== String(input.resolution || "")) {
    fail("generation_quote_binding_mismatch", "报价与当前视频分辨率不一致，请重新报价", 409);
  }
  const expectedDurationSeconds = input.durationSeconds ?? null;
  const persistedValuePricing = snapshot.fanjinValueVideoPricing;
  const persistedDurationSeconds = persistedValuePricing
    && typeof persistedValuePricing === "object"
    && !Array.isArray(persistedValuePricing)
      ? Number((persistedValuePricing as Record<string, unknown>).durationSeconds)
      : null;
  if (
    expected.generationType === "video"
    && (
      ((snapshot.videoDurationSeconds !== undefined || expectedDurationSeconds === -1)
        && snapshot.videoDurationSeconds !== expectedDurationSeconds)
      || (
        isFanjinValueVideoModel(expected.model)
        && persistedDurationSeconds !== expectedDurationSeconds
      )
    )
  ) {
    fail("generation_quote_binding_mismatch", "报价与当前视频时长不一致", 409);
  }
  const expectedBinding: GenerationQuoteBinding = {
    generationType: expected.generationType,
    provider: expected.provider,
    model: expected.model,
    units: expected.units,
  };
  if (String(row.bindingDigest) !== bindingDigest(expectedBinding)) {
    fail("generation_quote_binding_mismatch", "报价与当前 provider、model、units 或任务类型不一致", 409);
  }
  return {
    row,
    quote,
    pricingSnapshot: snapshot,
    expected: { ...expected, provider: expected.provider },
  };
}

function verifiedQuoteResult(
  input: AgentGenerationQuoteVerificationInput,
  persisted: PersistedVerifiedGenerationQuote,
): VerifiedAgentGenerationQuote {
  const { row, quote, pricingSnapshot: snapshot } = persisted;
  const videoBillingAuthorization: RelayVideoBillingAuthorizationFacts | null = quote.generationType === "video"
    ? {
        version: "agent-video-billing-authorization/v1",
        quoteId: quote.quoteId,
        pricingDigest: String(row.pricingDigest),
        endpointType: "video_generation",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        pricingRuleId: String(snapshot.pricingRuleId),
        pricingRuleUpdatedAt: Number(snapshot.pricingRuleUpdatedAt),
        provider: quote.provider,
        requestedModel: quote.model,
        pricedModel: snapshot.pricedModel == null ? null : String(snapshot.pricedModel),
        requestUnits: 1,
        unit: quote.unit as "task" | "video" | "token",
        pricingRuleBaseUnitPriceMicros: Number(
          snapshot.pricingRuleBaseUnitPriceMicros ?? snapshot.unitPriceMicros,
        ),
        unitPriceMicros: Number(snapshot.unitPriceMicros),
        multiplier: Number(snapshot.multiplier),
        minimumMicros: Number(snapshot.minimumMicros),
        videoInputPricingTier: String(
          snapshot.videoInputPricingTier || "without_video_input",
        ) as VideoInputPricingTier,
        videoInputPricingConfigured: snapshot.videoInputPricingConfigured === true,
        reservationUnits: quote.unit === "token"
          ? Number(snapshot.pricingUnits)
          : quote.units,
        reservationUpperBoundTokens: quote.unit === "token"
          ? Number(snapshot.reservationUpperBoundTokens)
          : null,
        reservationCostMicros: quote.maximumCostMicros,
        maximumCostMicros: quote.maximumCostMicros,
        valueVideoPricingSnapshot:
          snapshot.fanjinValueVideoPricing
          && typeof snapshot.fanjinValueVideoPricing === "object"
          && !Array.isArray(snapshot.fanjinValueVideoPricing)
            ? snapshot.fanjinValueVideoPricing as Record<string, unknown>
            : null,
        currency: "GU",
      }
    : null;
  return {
    quote,
    approvalQuote: {
      quoteId: quote.quoteId,
      currency: "GU",
      estimatedCostMicros: quote.estimatedCostMicros,
      maximumCostMicros: quote.maximumCostMicros,
      expiresAt: quote.expiresAt,
    },
    videoBillingAuthorization,
    bindingDigest: String(row.bindingDigest),
    pricingDigest: String(row.pricingDigest),
  };
}

/**
 * Recovery-only verification: validates the durable quote, anchor, scope,
 * binding and prepared-time TTL but deliberately does not re-read live routing
 * or pricing. Callers may use the result only with Relay's
 * `idempotentReplayOnly` option, which cannot create or dispatch a new task.
 */
export async function verifyAgentGenerationQuoteForIdempotentReplay(
  input: AgentGenerationQuoteVerificationInput,
): Promise<VerifiedAgentGenerationQuote> {
  const persisted = await verifyPersistedAgentGenerationQuote(input);
  return verifiedQuoteResult(input, persisted);
}

export async function verifyAgentGenerationQuoteForExecution(
  input: AgentGenerationQuoteVerificationInput,
): Promise<VerifiedAgentGenerationQuote> {
  const persisted = await verifyPersistedAgentGenerationQuote(input);
  const { row, expected } = persisted;
  let currentProvider: string;
  let currentPricing: PricingFacts;
  try {
    currentProvider = await resolveQuotedProvider({
      database: input.database,
      workspaceId: input.workspaceId,
      endpointType: endpointType(expected.generationType),
      model: expected.model,
      preferredProvider: expected.provider,
    });
    currentPricing = await resolvePricingFacts({
      database: input.database,
      workspaceId: input.workspaceId,
      generationType: expected.generationType,
      provider: expected.provider,
      model: expected.model,
      units: expected.units,
      videoInputPricingTier: input.videoInputPricingTier ?? "without_video_input",
      durationSeconds: input.durationSeconds ?? null,
      resolution: input.resolution ?? null,
      evaluatedAt: input.now,
    });
  } catch (error) {
    if (error instanceof AgentToolGatewayError) {
      fail("generation_quote_stale", "供应商路由或定价已变化，请重新报价", 409);
    }
    throw error;
  }
  if (currentProvider !== expected.provider || currentPricing.pricingDigest !== String(row.pricingDigest)) {
    fail("generation_quote_stale", "供应商路由或定价已变化，请重新报价", 409);
  }
  return verifiedQuoteResult(input, persisted);
}
