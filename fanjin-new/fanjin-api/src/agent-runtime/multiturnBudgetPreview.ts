import crypto from "node:crypto";
import type { Knex } from "knex";

import { AgentRuntimeConfigService } from "@/agent-runtime/agentRuntimeConfigService";
import { resolveAgentChatRunModel } from "@/agent-runtime/agentChatBilling";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { getAgentRuntimeModelAlias } from "@/agent-runtime/featureFlags";
import {
  MAIN_AGENT_DEFAULT_MAX_PROMPT_BYTES,
  MAIN_AGENT_DEFAULT_MAX_TOOL_SCHEMA_BYTES,
  MAIN_AGENT_HARD_MAX_OUTPUT_TOKENS,
} from "@/agent-runtime/mainAgentToolLoopModel";
import { resolveAgentToolLoopLimits } from "@/agent-runtime/workerService";
import {
  calculatePricingCost,
  guFromMicros,
  readWorkspaceAvailableMicros,
  resolveProviderSpecificPricingRule,
  type PricingRule,
} from "@/lib/billing";
import { estimateRelayTextReservationExposure } from "@/lib/relayBillingSession";
import {
  buildWorkbenchModelCatalog,
  type WorkbenchModelCatalogDatabase,
} from "@/lib/workbenchModelCatalog";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import { db } from "@/utils/db";

export const AGENT_MULTITURN_BUDGET_PREVIEW_VERSION =
  "agent-multiturn-budget-preview/v1";
export const AGENT_MULTITURN_BUDGET_RUNS = 2;
export const AGENT_MULTITURN_BUDGET_IMAGE_CALLS = 1;
export const AGENT_MULTITURN_BUDGET_MAX_TURNS_PER_RUN = 3;

// The real worker uses the two default MainAgentToolLoopModel byte ceilings.
// Include an additional fixed envelope for the request wrapper and scalar
// fields, then let estimateRelayTextReservationExposure apply its own reserve
// floor. One UTF-8 byte is treated as one token, intentionally conservative.
export const AGENT_MULTITURN_TEXT_REQUEST_BYTES_UPPER_BOUND =
  MAIN_AGENT_DEFAULT_MAX_PROMPT_BYTES
  + MAIN_AGENT_DEFAULT_MAX_TOOL_SCHEMA_BYTES
  + (64 * 1024);

type BudgetDatabase = WorkbenchModelCatalogDatabase;
type Row = Record<string, unknown>;
type StableRoutingIdentity = {
  id: string;
  scope: string;
  workspaceId: string;
  provider: string;
  model: string;
  endpointType: string;
  priority: string;
  fallbackOrder: string;
  disabled: string;
  createTime: string;
  updateTime: string;
  version: string;
  revision: string;
};
type RoutingFact = {
  provider: string;
  route: StableRoutingIdentity;
  channel: StableRoutingIdentity;
};

export type AgentMultiturnBudgetPreview = {
  version: typeof AGENT_MULTITURN_BUDGET_PREVIEW_VERSION;
  currency: "GU";
  chatModelId: string;
  textModel: string;
  runCount: 2;
  maxTurnsPerRun: number;
  chatCalls: number;
  imageCalls: 1;
  agentChatRunUnitCostMicros: number;
  agentChatMaximumCostMicros: number;
  textTurnMaximumCostMicros: number;
  textMaximumCostMicros: number;
  imageMaximumCostMicros: number;
  totalMaximumCostMicros: number;
  textInputTokenUpperBound: number;
  textOutputTokenUpperBound: number;
  availableMicros: number;
  availableGu: number;
  pricingDigest: string;
};

function fail(code: string, message: string, status = 409): never {
  throw new AgentRuntimeError(status, code, message);
}

function stringValue(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function isDisabled(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function stableRoutingIdentity(row: Row): StableRoutingIdentity {
  return {
    id: stringValue(row.id),
    scope: stringValue(row.scope),
    workspaceId: stringValue(row.workspaceId),
    provider: stringValue(row.provider),
    model: stringValue(row.model),
    endpointType: stringValue(row.endpointType),
    priority: stringValue(row.priority),
    fallbackOrder: stringValue(row.fallbackOrder),
    disabled: stringValue(row.disabled),
    createTime: stringValue(row.createTime),
    updateTime: stringValue(row.updateTime),
    version: stringValue(row.version),
    revision: stringValue(row.revision),
  };
}

function isWorkspaceRow(row: Row, workspaceId: string): boolean {
  return stringValue(row.scope) === "workspace"
    && stringValue(row.workspaceId) === workspaceId;
}

function compareRows(left: Row, right: Row, workspaceId: string): number {
  const scopeDelta =
    Number(isWorkspaceRow(right, workspaceId))
    - Number(isWorkspaceRow(left, workspaceId));
  if (scopeDelta) return scopeDelta;
  const priorityDelta = Number(left.priority || 0) - Number(right.priority || 0);
  if (priorityDelta) return priorityDelta;
  const fallbackDelta =
    Number(left.fallbackOrder || 0) - Number(right.fallbackOrder || 0);
  if (fallbackDelta) return fallbackDelta;
  const createDelta = Number(left.createTime || 0) - Number(right.createTime || 0);
  if (createDelta) return createDelta;
  return stringValue(left.id).localeCompare(stringValue(right.id));
}

function preferredRouteScope(routes: Row[], workspaceId: string): Row[] {
  const workspaceRoutes = routes.filter((route) =>
    isWorkspaceRow(route, workspaceId));
  if (workspaceRoutes.length) return workspaceRoutes;
  return routes.filter((route) =>
    stringValue(route.scope) === "platform"
    && !stringValue(route.workspaceId));
}

function scopeMatchesChannel(
  route: Row,
  channel: Row,
  workspaceId: string,
): boolean {
  if (stringValue(route.scope) === "platform") {
    return stringValue(channel.scope) === "platform"
      && !stringValue(channel.workspaceId);
  }
  return (
    (
      stringValue(channel.scope) === "platform"
      && !stringValue(channel.workspaceId)
    )
    || isWorkspaceRow(channel, workspaceId)
  );
}

async function authorizedProviders(input: {
  database: BudgetDatabase;
  workspaceId: string;
  endpointType: "text" | "image_generation";
  model: string;
}): Promise<{
  providers: string[];
  routingFacts: RoutingFact[];
}> {
  const [routeRows, channelRows] = await Promise.all([
    input.database("o_model_route")
      .where({ endpointType: input.endpointType, model: input.model })
      .where((builder: Knex.QueryBuilder) => {
        builder
          .where((platform: Knex.QueryBuilder) =>
            platform.where({ scope: "platform" }).whereNull("workspaceId"))
          .orWhere({ scope: "workspace", workspaceId: input.workspaceId });
      }),
    input.database("o_provider_channel")
      .where({ endpointType: input.endpointType, disabled: 0 })
      .where((builder: Knex.QueryBuilder) => {
        builder
          .where((platform: Knex.QueryBuilder) =>
            platform.where({ scope: "platform" }).whereNull("workspaceId"))
          .orWhere({ scope: "workspace", workspaceId: input.workspaceId });
      }),
  ]);
  const preferred = preferredRouteScope(
    [...routeRows].sort((left, right) =>
      compareRows(left, right, input.workspaceId)),
    input.workspaceId,
  );
  if (!preferred.length) {
    fail(
      "agent_multiturn_budget_route_missing",
      "候选模型缺少当前工作区可验证的服务端路由",
    );
  }
  const enabled = preferred.filter((route) => !isDisabled(route.disabled));
  if (!enabled.length) {
    fail(
      "agent_multiturn_budget_route_disabled",
      "候选模型在当前工作区已显式停用",
    );
  }
  const channels = [...channelRows].sort((left, right) =>
    compareRows(left, right, input.workspaceId));
  const providers = new Set<string>();
  const routingFacts = new Map<string, RoutingFact>();
  for (const route of enabled) {
    const channelId = stringValue(route.channelId);
    const routeProvider = stringValue(route.provider);
    for (const channel of channels) {
      if (!scopeMatchesChannel(route, channel, input.workspaceId)) continue;
      if (channelId && stringValue(channel.id) !== channelId) continue;
      const provider = stringValue(channel.provider);
      if (!provider || (routeProvider && provider !== routeProvider)) continue;
      if (!channelId && !routeProvider) continue;
      providers.add(provider);
      const routeIdentity = stableRoutingIdentity(route);
      const channelIdentity = stableRoutingIdentity(channel);
      const fact = {
        provider,
        route: routeIdentity,
        channel: channelIdentity,
      };
      if (
        !routeIdentity.id
        || !routeIdentity.scope
        || !routeIdentity.model
        || !routeIdentity.endpointType
        || !routeIdentity.priority
        || !routeIdentity.fallbackOrder
        || !routeIdentity.disabled
        || !routeIdentity.createTime
        || !routeIdentity.updateTime
        || !channelIdentity.id
        || !channelIdentity.scope
        || !channelIdentity.provider
        || !channelIdentity.endpointType
        || !channelIdentity.priority
        || !channelIdentity.disabled
        || !channelIdentity.createTime
        || !channelIdentity.updateTime
      ) {
        fail(
          "agent_multiturn_budget_route_version_invalid",
          "候选路由或供应商通道缺少可验证的版本身份",
        );
      }
      routingFacts.set(
        `${routeIdentity.id}:${channelIdentity.id}:${fact.provider}`,
        fact,
      );
    }
  }
  if (!providers.size) {
    fail(
      "agent_multiturn_budget_channel_missing",
      "候选模型缺少当前工作区可验证的供应商通道",
    );
  }
  return {
    providers: [...providers].sort(),
    routingFacts: [...routingFacts.values()].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

function validateProviderRule(
  rule: PricingRule | null,
  input: {
    endpointType: "text" | "image_generation";
    provider: string;
    model: string;
    unit: "token" | "image";
  },
): asserts rule is PricingRule {
  if (!rule) {
    fail(
      "agent_multiturn_budget_provider_pricing_missing",
      "候选路由存在缺少供应商专属 GU 定价的通道",
      402,
    );
  }
  if (
    rule.endpointType !== input.endpointType
    || rule.provider !== input.provider
    || (rule.model != null && rule.model !== input.model)
    || rule.currency !== "GU"
    || rule.unit !== input.unit
    || !Number.isSafeInteger(rule.unitPriceMicros)
    || rule.unitPriceMicros <= 0
  ) {
    fail(
      "agent_multiturn_budget_provider_pricing_invalid",
      "供应商专属 GU 定价与候选路由不匹配",
    );
  }
  const multiplier = Number(rule.ruleConfig?.multiplier ?? 1);
  const minimumMicros = Number(rule.ruleConfig?.minimumMicros ?? 0);
  if (
    !Number.isFinite(multiplier)
    || multiplier <= 0
    || !Number.isSafeInteger(minimumMicros)
    || minimumMicros < 0
  ) {
    fail(
      "agent_multiturn_budget_provider_pricing_invalid",
      "供应商专属 GU 定价倍率或最低收费无效",
    );
  }
}

async function providerRules(input: {
  database: BudgetDatabase;
  workspaceId: string;
  endpointType: "text" | "image_generation";
  model: string;
  unit: "token" | "image";
}): Promise<{
  rules: Array<{ provider: string; rule: PricingRule }>;
  routingFacts: RoutingFact[];
}> {
  const resolution = await authorizedProviders(input);
  const rules = await Promise.all(resolution.providers.map(async (provider) => {
    const rule = await resolveProviderSpecificPricingRule({
      workspaceId: input.workspaceId,
      endpointType: input.endpointType,
      provider,
      model: input.model,
    }, input.database);
    validateProviderRule(rule, { ...input, provider });
    return { provider, rule };
  }));
  return { rules, routingFacts: resolution.routingFacts };
}

function safeMaximum(values: number[], code: string): number {
  if (
    !values.length
    || values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    fail(code, "服务端无法确定候选最大 GU 暴露");
  }
  return Math.max(...values);
}

function safeProduct(left: number, right: number, code: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    fail(code, "候选 GU 暴露超出安全整数范围");
  }
  return result;
}

function safeSum(values: number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result <= 0) {
    fail(
      "agent_multiturn_budget_exposure_invalid",
      "候选 GU 总暴露超出安全整数范围",
    );
  }
  return result;
}

function imageCapabilityComplete(capability: {
  maxOutputs?: number;
  qualities?: string[];
  aspectRatios?: string[];
  defaultQuality?: string;
  defaultAspectRatio?: string;
}): boolean {
  return Number.isSafeInteger(capability.maxOutputs)
    && Number(capability.maxOutputs) >= 1
    && Array.isArray(capability.qualities)
    && capability.qualities.length > 0
    && Array.isArray(capability.aspectRatios)
    && capability.aspectRatios.length > 0
    && Boolean(stringValue(capability.defaultQuality))
    && Boolean(stringValue(capability.defaultAspectRatio));
}

export async function resolveAgentMultiturnBudgetPreview(
  input: {
    workspaceId: string;
    chatModelId: string;
  },
  database: BudgetDatabase = db,
): Promise<AgentMultiturnBudgetPreview> {
  const workspaceId = stringValue(input.workspaceId);
  const chatModelId = stringValue(input.chatModelId);
  if (!workspaceId || !chatModelId) {
    fail(
      "agent_multiturn_budget_arguments_invalid",
      "候选预算缺少工作区或对话模型",
      400,
    );
  }
  const limits = resolveAgentToolLoopLimits();
  if (
    !Number.isSafeInteger(limits.maxTurns)
    || limits.maxTurns < 1
    || limits.maxTurns > AGENT_MULTITURN_BUDGET_MAX_TURNS_PER_RUN
    || limits.maxToolCalls !== 1
  ) {
    fail(
      "agent_multiturn_budget_runtime_limits_unsafe",
      "Agent 服务端 Turn/Tool 上限不符合候选安全基线",
    );
  }
  const [chatCharge, roleConfig, catalog, textCatalog, availableMicros] =
    await Promise.all([
      resolveAgentChatRunModel({ workspaceId, chatModelId, requireAvailable: true }),
      new AgentRuntimeConfigService(database as unknown as Knex)
        .getRoleConfig("main"),
      buildWorkbenchModelCatalog(workspaceId, database),
      listWorkbenchTextModels(workspaceId, database),
      readWorkspaceAvailableMicros(workspaceId, database),
    ]);
  if (availableMicros == null) {
    fail(
      "agent_multiturn_budget_wallet_unavailable",
      "当前工作区没有可只读验证的 GU 账户",
      402,
    );
  }
  const selectedDefinition = chatCharge.definition;
  const agentChatRule = chatCharge.pricingRule;
  if (
    !agentChatRule
    || agentChatRule.endpointType !== "text"
    || agentChatRule.currency !== "GU"
    || agentChatRule.unit !== "token"
    || chatCharge.available !== true
    || !chatCharge.provider
    || !Number.isSafeInteger(chatCharge.reservationMicros)
    || chatCharge.reservationMicros <= 0
    || !Number.isSafeInteger(chatCharge.estimatedCostMicros)
    || Number(chatCharge.estimatedCostMicros) <= 0
  ) {
    fail(
      "agent_multiturn_budget_token_pricing_invalid",
      "Agent Token 定价或可用路由无效",
      402,
    );
  }
  const textModel = selectedDefinition.isDefault
    ? roleConfig.source === "registry"
      ? getAgentRuntimeModelAlias()
      : roleConfig.resolvedModelAlias
    : selectedDefinition.modelAlias;
  const textOutputTokenUpperBound = selectedDefinition.isDefault
    ? roleConfig.maxOutputTokens
    : selectedDefinition.maxOutputTokens;
  if (
    !textModel
    || !Number.isSafeInteger(textOutputTokenUpperBound)
    || textOutputTokenUpperBound < 1
    || textOutputTokenUpperBound > MAIN_AGENT_HARD_MAX_OUTPUT_TOKENS
    || !textCatalog.some((model) => model.id === textModel)
  ) {
    fail(
      "agent_multiturn_budget_text_capability_missing",
      "候选文本模型缺少可提交能力或输出 Token 上界",
    );
  }
  const textPricing = await providerRules({
    database,
    workspaceId,
    endpointType: "text",
    model: textModel,
    unit: "token",
  });
  const textRules = textPricing.rules;
  const textExposures = textRules.map(({ rule }) =>
    estimateRelayTextReservationExposure({
      rule,
      requestPayload: {
        candidateUpperBound: "x".repeat(
          AGENT_MULTITURN_TEXT_REQUEST_BYTES_UPPER_BOUND,
        ),
      },
      maxOutputTokens: textOutputTokenUpperBound,
    }));
  const textTurnMaximumCostMicros = safeMaximum(
    textExposures.map((exposure) => exposure.reservedCostMicros),
    "agent_multiturn_budget_text_exposure_invalid",
  );
  const maximumTextExposure = textExposures.reduce((current, candidate) =>
    candidate.reservedCostMicros > current.reservedCostMicros
      ? candidate
      : current);
  const imageCapabilities = catalog.imageModels.filter((model) => model.canSubmit);
  if (
    !imageCapabilities.length
    || imageCapabilities.some((capability) => !imageCapabilityComplete(capability))
  ) {
    fail(
      "agent_multiturn_budget_image_capability_missing",
      "候选图片模型缺少完整的一张图可提交能力",
    );
  }
  const imagePricing = await Promise.all(imageCapabilities.map(async (model) => {
    const pricing = await providerRules({
      database,
      workspaceId,
      endpointType: "image_generation",
      model: model.id,
      unit: "image",
    });
    const rules = pricing.rules;
    return {
      model: model.id,
      rules,
      routingFacts: pricing.routingFacts,
      maximumCostMicros: safeMaximum(
        rules.map(({ rule }) => calculatePricingCost(rule, 1)),
        "agent_multiturn_budget_image_exposure_invalid",
      ),
    };
  }));
  const imageMaximumCostMicros = safeMaximum(
    imagePricing.map((entry) => entry.maximumCostMicros),
    "agent_multiturn_budget_image_exposure_invalid",
  );
  const chatCalls = AGENT_MULTITURN_BUDGET_RUNS * limits.maxTurns;
  // The Agent conversation itself has no fixed per-Run fee. All LLM turns are
  // already represented by the provider-specific text token exposure below.
  const agentChatMaximumCostMicros = 0;
  const textMaximumCostMicros = safeProduct(
    textTurnMaximumCostMicros,
    chatCalls,
    "agent_multiturn_budget_text_exposure_invalid",
  );
  const totalMaximumCostMicros = safeSum([
    agentChatMaximumCostMicros,
    textMaximumCostMicros,
    imageMaximumCostMicros,
  ]);
  const digestFacts = {
    version: AGENT_MULTITURN_BUDGET_PREVIEW_VERSION,
    workspaceId,
    chatModelId,
    textModel,
    limits,
    agentChat: {
      pricingRuleId: agentChatRule.id,
      pricingRuleUpdatedAt: agentChatRule.updateTime,
      provider: chatCharge.provider,
      billingMode: "token",
      reservationMicros: chatCharge.reservationMicros,
      estimatedCostMicros: chatCharge.estimatedCostMicros,
    },
    text: textRules.map(({ provider, rule }, index) => ({
      provider,
      pricingRuleId: rule.id,
      pricingRuleUpdatedAt: rule.updateTime,
      turnMaximumCostMicros: textExposures[index].reservedCostMicros,
    })),
    textRouting: textPricing.routingFacts,
    image: imagePricing.map((entry) => ({
      model: entry.model,
      routing: entry.routingFacts,
      providers: entry.rules.map(({ provider, rule }) => ({
        provider,
        pricingRuleId: rule.id,
        pricingRuleUpdatedAt: rule.updateTime,
        costMicros: calculatePricingCost(rule, 1),
      })),
    })),
    textInputTokenUpperBound: maximumTextExposure.promptTokens,
    textOutputTokenUpperBound,
    totalMaximumCostMicros,
  };
  return {
    version: AGENT_MULTITURN_BUDGET_PREVIEW_VERSION,
    currency: "GU",
    chatModelId,
    textModel,
    runCount: AGENT_MULTITURN_BUDGET_RUNS,
    maxTurnsPerRun: limits.maxTurns,
    chatCalls,
    imageCalls: AGENT_MULTITURN_BUDGET_IMAGE_CALLS,
    agentChatRunUnitCostMicros: 0,
    agentChatMaximumCostMicros,
    textTurnMaximumCostMicros,
    textMaximumCostMicros,
    imageMaximumCostMicros,
    totalMaximumCostMicros,
    textInputTokenUpperBound: maximumTextExposure.promptTokens,
    textOutputTokenUpperBound,
    availableMicros,
    availableGu: guFromMicros(availableMicros),
    pricingDigest: crypto.createHash("sha256")
      .update(JSON.stringify(digestFacts))
      .digest("hex"),
  };
}
