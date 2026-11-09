import { internalModelId } from "@/lib/minimaxH3PublicIdentity";
import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  calculatePricingCost,
  resolveProviderSpecificPricingRule,
  type PricingRule,
} from "@/lib/billing";
import { estimateRelayTextReservationExposure } from "@/lib/relayBillingSession";
import { readVideoTokenReservationUpperBound } from "@/lib/productionPricing";
import {
  resolveTimePricing,
  type TimePricingSnapshot,
} from "@/lib/timePricing";
import { calculateMaximumVideoInputCost } from "@/lib/videoInputPricing";
import {
  buildWorkbenchModelCatalog,
  type WorkbenchModelCatalogDatabase,
} from "@/lib/workbenchModelCatalog";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import { db } from "@/utils/db";

export const QUICK_SIX_STAGE_GU_BUDGET_VERSION =
  "quick-six-stage-gu-budget/v1";

type BudgetDatabase = WorkbenchModelCatalogDatabase;
type RouteRow = Record<string, unknown>;
type ChannelRow = Record<string, unknown>;
type RoutingBindingFact = {
  routeId: string;
  routeScope: string;
  routePriority: number;
  routeFallbackOrder: number;
  routeDisabled: boolean;
  routeCreateTime: string;
  routeUpdateTime: string;
  routeVersion: string;
  channelId: string;
  channelScope: string;
  channelPriority: number;
  channelFallbackOrder: number;
  channelDisabled: boolean;
  channelCreateTime: string;
  channelUpdateTime: string;
  channelVersion: string;
};
type AuthorizedProvider = {
  provider: string;
  routingBindings: RoutingBindingFact[];
};

export class QuickSixStageGuBudgetError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "QuickSixStageGuBudgetError";
    this.code = code;
    this.status = status;
  }
}

export type QuickSixStageGuBudgetInput = {
  workspaceId: string;
  textModel: string;
  imageModel: string;
  imageQuality: string;
  videoModel: string;
  videoDuration: number;
  textRequestPayload: Record<string, unknown>;
  textMaxOutputTokens: number;
};

export type QuickSixStageGuBudgetExposure = {
  version: typeof QUICK_SIX_STAGE_GU_BUDGET_VERSION;
  textMaximumCostMicros: number;
  imageUnitMaximumCostMicros: number;
  imageMaximumCostMicros: number;
  videoMaximumCostMicros: number;
  totalMaximumCostMicros: number;
  textInputTokenUpperBound: number;
  textOutputTokenUpperBound: number;
  imageCalls: 2;
  videoCalls: 1;
  pricingDigest: string;
};

function fail(code: string, message: string, status = 409): never {
  throw new QuickSixStageGuBudgetError(code, message, status);
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

function isWorkspaceRow(row: RouteRow | ChannelRow, workspaceId: string) {
  return (
    stringValue(row.scope) === "workspace"
    && stringValue(row.workspaceId) === workspaceId
  );
}

function compareRows(
  left: RouteRow | ChannelRow,
  right: RouteRow | ChannelRow,
  workspaceId: string,
): number {
  const scopeDelta =
    Number(isWorkspaceRow(right, workspaceId))
    - Number(isWorkspaceRow(left, workspaceId));
  if (scopeDelta) return scopeDelta;
  const priorityDelta =
    Number(left.priority || 0) - Number(right.priority || 0);
  if (priorityDelta) return priorityDelta;
  const fallbackDelta =
    Number(left.fallbackOrder || 0) - Number(right.fallbackOrder || 0);
  if (fallbackDelta) return fallbackDelta;
  const createDelta =
    Number(left.createTime || 0) - Number(right.createTime || 0);
  if (createDelta) return createDelta;
  return stringValue(left.id).localeCompare(stringValue(right.id));
}

function scopeMatchesChannel(
  route: RouteRow,
  channel: ChannelRow,
  workspaceId: string,
): boolean {
  if (stringValue(route.scope) === "platform") {
    return (
      stringValue(channel.scope) === "platform"
      && !stringValue(channel.workspaceId)
    );
  }
  return (
    (
      stringValue(channel.scope) === "platform"
      && !stringValue(channel.workspaceId)
    )
    || isWorkspaceRow(channel, workspaceId)
  );
}

function preferredRouteScope(
  routes: RouteRow[],
  workspaceId: string,
): RouteRow[] {
  const workspaceRoutes = routes.filter(
    (route) => isWorkspaceRow(route, workspaceId),
  );
  if (workspaceRoutes.length) return workspaceRoutes;
  return routes.filter(
    (route) =>
      stringValue(route.scope) === "platform"
      && !stringValue(route.workspaceId),
  );
}

function integerFact(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function versionFact(row: RouteRow | ChannelRow): string {
  return stringValue(row.version ?? row.revision);
}

function routingBindingFact(
  route: RouteRow,
  channel: ChannelRow,
): RoutingBindingFact {
  return {
    routeId: stringValue(route.id),
    routeScope: stringValue(route.scope),
    routePriority: integerFact(route.priority),
    routeFallbackOrder: integerFact(route.fallbackOrder),
    routeDisabled: isDisabled(route.disabled),
    routeCreateTime: stringValue(route.createTime),
    routeUpdateTime: stringValue(route.updateTime),
    routeVersion: versionFact(route),
    channelId: stringValue(channel.id),
    channelScope: stringValue(channel.scope),
    channelPriority: integerFact(channel.priority),
    channelFallbackOrder: integerFact(channel.fallbackOrder),
    channelDisabled: isDisabled(channel.disabled),
    channelCreateTime: stringValue(channel.createTime),
    channelUpdateTime: stringValue(channel.updateTime),
    channelVersion: versionFact(channel),
  };
}

async function authorizedProviders(input: {
  database: BudgetDatabase;
  workspaceId: string;
  endpointType: string;
  model: string;
}): Promise<AuthorizedProvider[]> {
  const [routeRows, channelRows] = await Promise.all([
    input.database("o_model_route")
      .where({ endpointType: input.endpointType, model: input.model })
      .where((builder: Knex.QueryBuilder) => {
        builder
          .where((platform: Knex.QueryBuilder) =>
            platform.where({ scope: "platform" }).whereNull("workspaceId"),
          )
          .orWhere({ scope: "workspace", workspaceId: input.workspaceId });
      }),
    input.database("o_provider_channel")
      .where({ endpointType: input.endpointType })
      .where((builder: Knex.QueryBuilder) => {
        builder
          .where((platform: Knex.QueryBuilder) =>
            platform.where({ scope: "platform" }).whereNull("workspaceId"),
          )
          .orWhere({ scope: "workspace", workspaceId: input.workspaceId });
      }),
  ]);
  const preferred = preferredRouteScope(
    [...routeRows].sort((left, right) =>
      compareRows(left, right, input.workspaceId),
    ),
    input.workspaceId,
  );
  if (!preferred.length) {
    fail(
      "QUICK_SIX_STAGE_GU_ROUTE_MISSING",
      "当前模型没有可验证的服务端路由",
    );
  }
  const enabled = preferred.filter((route) => !isDisabled(route.disabled));
  if (!enabled.length) {
    fail(
      "QUICK_SIX_STAGE_GU_ROUTE_DISABLED",
      "当前工作区的模型路由已显式禁用",
    );
  }
  const channels = [...channelRows].sort((left, right) =>
    compareRows(left, right, input.workspaceId),
  );
  const providers = new Map<string, RoutingBindingFact[]>();
  for (const route of enabled) {
    const channelId = stringValue(route.channelId);
    const routeProvider = stringValue(route.provider);
    for (const channel of channels) {
      if (isDisabled(channel.disabled)) continue;
      if (!scopeMatchesChannel(route, channel, input.workspaceId)) continue;
      if (channelId && stringValue(channel.id) !== channelId) continue;
      const provider = stringValue(channel.provider);
      if (!provider || (routeProvider && provider !== routeProvider)) continue;
      if (!channelId && !routeProvider) continue;
      const bindings = providers.get(provider) || [];
      bindings.push(routingBindingFact(route, channel));
      providers.set(provider, bindings);
    }
  }
  if (!providers.size) {
    fail(
      "QUICK_SIX_STAGE_GU_CHANNEL_MISSING",
      "当前模型没有可验证的服务端供应商通道",
    );
  }
  return [...providers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, routingBindings]) => ({
      provider,
      routingBindings: routingBindings.sort((left, right) => (
        left.routeId.localeCompare(right.routeId)
        || left.channelId.localeCompare(right.channelId)
      )),
    }));
}

function validateCommonRule(
  rule: PricingRule | null,
  input: {
    endpointType: string;
    provider: string;
    model: string;
    allowedUnits: readonly string[];
  },
): asserts rule is PricingRule {
  if (!rule) {
    fail(
      "QUICK_SIX_STAGE_GU_PRICING_MISSING",
      "当前供应商与模型缺少服务端 GU 定价",
      402,
    );
  }
  if (
    rule.endpointType !== input.endpointType
    || rule.provider !== input.provider
    || (rule.model != null && rule.model !== input.model)
    || rule.currency !== "GU"
    || !input.allowedUnits.includes(rule.unit)
    || !Number.isSafeInteger(rule.unitPriceMicros)
    || rule.unitPriceMicros <= 0
  ) {
    fail(
      "QUICK_SIX_STAGE_GU_PRICING_INVALID",
      "服务端 GU 定价与模型路由不匹配",
      409,
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
      "QUICK_SIX_STAGE_GU_PRICING_INVALID",
      "服务端 GU 定价倍率或最低收费无效",
      409,
    );
  }
}

async function providerRules(input: {
  database: BudgetDatabase;
  workspaceId: string;
  endpointType: string;
  model: string;
  allowedUnits: readonly string[];
}): Promise<Array<{
  provider: string;
  rule: PricingRule;
  routingBindings: RoutingBindingFact[];
}>> {
  const providers = await authorizedProviders(input);
  return await Promise.all(providers.map(async ({
    provider,
    routingBindings,
  }) => {
    const rule = await resolveProviderSpecificPricingRule({
      workspaceId: input.workspaceId,
      endpointType: input.endpointType,
      provider,
      model: input.model,
    }, input.database);
    validateCommonRule(rule, {
      endpointType: input.endpointType,
      provider,
      model: input.model,
      allowedUnits: input.allowedUnits,
    });
    return { provider, rule, routingBindings };
  }));
}

function durationSupported(
  capability: {
    duration?: {
      min: number;
      max: number;
      step: number;
      allowed?: number[];
    };
  },
  duration: number,
): boolean {
  const contract = capability.duration;
  if (!contract || !Number.isFinite(duration) || duration <= 0) return false;
  if (contract.allowed?.length) return contract.allowed.includes(duration);
  if (
    duration < contract.min
    || duration > contract.max
    || contract.step <= 0
  ) {
    return false;
  }
  const steps = (duration - contract.min) / contract.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function safeMaximum(values: number[], code: string): number {
  if (
    !values.length
    || values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    fail(code, "服务端无法计算正安全整数的最大 GU 暴露", 409);
  }
  return Math.max(...values);
}

function safeSum(values: number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum) || sum <= 0) {
    fail(
      "QUICK_SIX_STAGE_GU_EXPOSURE_INVALID",
      "服务端最大 GU 暴露超出安全整数范围",
      409,
    );
  }
  return sum;
}

function videoMaximumCost(
  rule: PricingRule,
  units: number,
  timePricingMultiplier: number,
): number {
  try {
    return calculateMaximumVideoInputCost({
      ruleConfig: rule.ruleConfig,
      baseUnitPriceMicros: rule.unitPriceMicros,
      units,
      timePricingMultiplier,
    });
  } catch {
    fail(
      "QUICK_SIX_STAGE_GU_VIDEO_EXPOSURE_INVALID",
      "视频输入分档定价无法形成安全的最大 GU 暴露",
      409,
    );
  }
}

function stableTimePricingSnapshot(
  snapshot: TimePricingSnapshot,
): Omit<TimePricingSnapshot, "evaluatedAt"> {
  const { evaluatedAt: _evaluatedAt, ...stable } = snapshot;
  return stable;
}

export async function resolveQuickSixStageGuBudgetExposure(
  input: QuickSixStageGuBudgetInput,
  database: BudgetDatabase = db,
): Promise<QuickSixStageGuBudgetExposure> {
  const workspaceId = stringValue(input.workspaceId);
  if (!workspaceId) {
    fail(
      "QUICK_SIX_STAGE_GU_WORKSPACE_REQUIRED",
      "GU 预算计算缺少工作区",
      400,
    );
  }
  // Freeze the entire consent budget to one evaluation context before any
  // asynchronous catalog/routing read can cross a configured time window.
  const pricingEvaluatedAt = Date.now();

  const [textCatalog, catalog] = await Promise.all([
    listWorkbenchTextModels(workspaceId, database),
    buildWorkbenchModelCatalog(workspaceId, database),
  ]);
  if (!textCatalog.some((model) => model.id === input.textModel)) {
    fail(
      "QUICK_SIX_STAGE_GU_TEXT_MODEL_UNAVAILABLE",
      "文本模型不在当前可提交目录中",
      409,
    );
  }
  const imageCapability = catalog.imageModels.find(
    (model) => model.id === input.imageModel && model.canSubmit,
  );
  if (
    !imageCapability
    || !imageCapability.aspectRatios.includes("16:9")
    || !imageCapability.qualities?.includes(input.imageQuality)
  ) {
    fail(
      "QUICK_SIX_STAGE_GU_IMAGE_MODEL_UNAVAILABLE",
      "图片模型不满足 Quick 六阶段的可提交能力",
      409,
    );
  }
  const videoCapability = catalog.videoModels.find(
    (model) => model.id === internalModelId(input.videoModel) && model.canSubmit,
  );
  if (
    !videoCapability
    || !videoCapability.resolutions?.some(
      (resolution) => resolution.toLowerCase() === "720p",
    )
    || !videoCapability.modes?.includes("text_to_video")
    || !durationSupported(videoCapability, input.videoDuration)
  ) {
    fail(
      "QUICK_SIX_STAGE_GU_VIDEO_MODEL_UNAVAILABLE",
      "视频模型不满足最短 720p Quick 六阶段能力",
      409,
    );
  }

  const [textRules, imageRules, videoRules] = await Promise.all([
    providerRules({
      database,
      workspaceId,
      endpointType: "text",
      model: input.textModel,
      allowedUnits: ["token"],
    }),
    providerRules({
      database,
      workspaceId,
      endpointType: "image_generation",
      model: input.imageModel,
      allowedUnits: ["image"],
    }),
    providerRules({
      database,
      workspaceId,
      endpointType: "video_generation",
      model: input.videoModel,
      allowedUnits: ["task", "video", "token"],
    }),
  ]);

  const textExposures = textRules.map(({ rule }) => ({
    timePricing: resolveTimePricing(rule.ruleConfig, pricingEvaluatedAt),
    reservation: estimateRelayTextReservationExposure({
      rule,
      requestPayload: input.textRequestPayload,
      maxOutputTokens: input.textMaxOutputTokens,
      evaluatedAt: pricingEvaluatedAt,
    }),
  }));
  const textMaximumCostMicros = safeMaximum(
    textExposures.map((entry) => entry.reservation.reservedCostMicros),
    "QUICK_SIX_STAGE_GU_TEXT_EXPOSURE_INVALID",
  );
  const maximumText = textExposures.reduce((current, candidate) =>
    candidate.reservation.reservedCostMicros
      > current.reservation.reservedCostMicros
      ? candidate
      : current,
  ).reservation;
  const imageExposures = imageRules.map((entry) => ({
    ...entry,
    timePricing: resolveTimePricing(
      entry.rule.ruleConfig,
      pricingEvaluatedAt,
    ),
    costMicros: calculatePricingCost(
      entry.rule,
      1,
      undefined,
      undefined,
      pricingEvaluatedAt,
    ),
  }));
  const imageUnitMaximumCostMicros = safeMaximum(
    imageExposures.map((entry) => entry.costMicros),
    "QUICK_SIX_STAGE_GU_IMAGE_EXPOSURE_INVALID",
  );
  const imageMaximumCostMicros = safeSum([
    imageUnitMaximumCostMicros,
    imageUnitMaximumCostMicros,
  ]);
  const videoExposures = videoRules.map((entry) => {
    const { provider, rule } = entry;
    const units = rule.unit === "token"
      ? readVideoTokenReservationUpperBound(rule.ruleConfig)
      : 1;
    if (
      units == null
      || (
        rule.unit === "token"
        && provider !== "volcano"
      )
    ) {
      fail(
        "QUICK_SIX_STAGE_GU_VIDEO_UPPER_BOUND_MISSING",
        "视频 token 定价缺少服务端预留上界",
        409,
      );
    }
    const timePricing = resolveTimePricing(
      rule.ruleConfig,
      pricingEvaluatedAt,
    );
    return {
      ...entry,
      reservationUnits: units,
      timePricing,
      costMicros: videoMaximumCost(
        rule,
        units,
        timePricing.multiplier,
      ),
    };
  });
  const videoMaximumCostMicros = safeMaximum(
    videoExposures.map((entry) => entry.costMicros),
    "QUICK_SIX_STAGE_GU_VIDEO_EXPOSURE_INVALID",
  );
  const totalMaximumCostMicros = safeSum([
    textMaximumCostMicros,
    imageMaximumCostMicros,
    videoMaximumCostMicros,
  ]);
  const digestFacts = {
    workspaceId,
    models: {
      text: input.textModel,
      image: input.imageModel,
      video: input.videoModel,
    },
    text: textRules.map(({
      provider,
      rule,
      routingBindings,
    }, index) => ({
      provider,
      routingBindings,
      pricingRuleId: rule.id,
      pricingRuleUpdatedAt: rule.updateTime,
      costMicros: textExposures[index].reservation.reservedCostMicros,
      timePricing: stableTimePricingSnapshot(
        textExposures[index].timePricing,
      ),
    })),
    image: imageExposures.map(({
      provider,
      rule,
      routingBindings,
      costMicros,
      timePricing,
    }) => ({
      provider,
      routingBindings,
      pricingRuleId: rule.id,
      pricingRuleUpdatedAt: rule.updateTime,
      costMicros,
      timePricing: stableTimePricingSnapshot(timePricing),
    })),
    video: videoExposures.map(({
      provider,
      rule,
      routingBindings,
      reservationUnits,
      costMicros,
      timePricing,
    }) => ({
      provider,
      routingBindings,
      pricingRuleId: rule.id,
      pricingRuleUpdatedAt: rule.updateTime,
      unit: rule.unit,
      reservationUpperBoundTokens:
        rule.unit === "token"
          ? reservationUnits
          : null,
      costMicros,
      timePricing: stableTimePricingSnapshot(timePricing),
    })),
    totalMaximumCostMicros,
  };

  return {
    version: QUICK_SIX_STAGE_GU_BUDGET_VERSION,
    textMaximumCostMicros,
    imageUnitMaximumCostMicros,
    imageMaximumCostMicros,
    videoMaximumCostMicros,
    totalMaximumCostMicros,
    textInputTokenUpperBound: maximumText.promptTokens,
    textOutputTokenUpperBound: maximumText.completionTokens,
    imageCalls: 2,
    videoCalls: 1,
    pricingDigest: crypto.createHash("sha256")
      .update(JSON.stringify(digestFacts))
      .digest("hex"),
  };
}
