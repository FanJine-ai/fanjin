import { v4 as uuid } from "uuid";
import { isDeepStrictEqual } from "node:util";
import type { Knex } from "knex";
import { FANJIN_VALUE_VIDEO_RESOLUTION_PAIRS, fanjinValueVideoOfferDefinition, fanjinValueVideoResolutionPair } from "@/lib/fanjinValueVideoOffers";
import { mediaKitRuntimeConfig, mediaServiceTable } from "@/lib/mediaServices";
import {
  lockRelayConfigTablesForMutation,
  normalizeAndValidateModelRoute,
  normalizeModelRouteDisplayName,
  RelayConfigValidationError,
  serializeRelayConfigMutation,
} from "@/lib/relayConfigValidation";
import {
  lockPricingRuleTableForMutation,
  serializePricingRuleMutation,
  validatePricingExpressionConfig,
} from "@/lib/pricingRuleValidation";
import { relayPricingUnits, readVideoTokenReservationUpperBound } from "@/lib/productionPricing";
import {
  pricingCertificationRuleConfig,
  validatePricingAudienceContract,
} from "@/lib/pricingAudience";
import { validatePricingGroupReferences } from "@/lib/pricingGroups";
import {
  isPublicVideoResolution,
  normalizeVideoResolution,
  recipeResolutionsValid,
} from "@/lib/videoResolutions";
import {
  VIDEO_FULFILLMENT_RECIPE_TABLE,
  VIDEO_PUBLIC_OFFER_TABLE,
} from "@/lib/migrations/videoFulfillmentRecipe";
import { upsertVideoPublicOffer } from "@/lib/videoFulfillment/recipes";
import {
  buildModelRouteGroupKey,
  capabilityFingerprint,
  listModelRouteGroups,
  logicalPriceMirrorRuleConfig,
  logicalPriceRuleConfig,
  managedRouteConfig,
  modelRouteGroupConfig,
  modelRouteGroupKeyForRoute,
  parseJsonRecord,
  parseProviderModelNames,
  priorityFromTier,
  type ModelRouteGroup,
  type ModelRouteGroupScope,
  type ModelRouteGroupTier,
} from "@/lib/modelRouteGroups";

type Database = Knex | Knex.Transaction;
type DataRow = Record<string, any>;

export interface ModelRouteGroupTargetDraft {
  id?: string | null;
  channelId: string;
  upstreamModel: string;
  tier: ModelRouteGroupTier;
  trafficWeight: number;
  routeRecipe?: Record<string, unknown>;
}

export interface LogicalModelPriceDraft {
  unit: string;
  unitPriceMicros: number;
  currency?: string;
  ruleConfig?: Record<string, unknown>;
}

export interface ModelRouteGroupDraft {
  existingGroupKey?: string | null;
  scope: ModelRouteGroupScope;
  workspaceId?: string | null;
  endpointType: string;
  publicModel: string;
  displayName?: string | null;
  disabled: boolean;
  targets: ModelRouteGroupTargetDraft[];
  pricing?: LogicalModelPriceDraft | null;
}

export interface ModelRouteGroupPreflight {
  valid: boolean;
  groupKey: string;
  issues: Array<{ path: Array<string | number>; message: string; code: string }>;
  warnings: string[];
  normalizedTargets: Array<ModelRouteGroupTargetDraft & {
    provider: string;
    channelName: string;
    capabilityFingerprint: string;
    capabilityContract: Record<string, unknown>;
    normalizedTrafficPercent: number;
  }>;
}

export class ModelRouteGroupMutationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly issues: ModelRouteGroupPreflight["issues"];

  constructor(input: {
    message: string;
    code: string;
    statusCode?: number;
    issues?: ModelRouteGroupPreflight["issues"];
  }) {
    super(input.message);
    this.name = "ModelRouteGroupMutationError";
    this.code = input.code;
    this.statusCode = input.statusCode ?? 400;
    this.issues = input.issues ?? [];
  }
}

function clean(value: unknown): string {
  return String(value || "").trim();
}

function normalizedWorkspaceId(draft: ModelRouteGroupDraft): string | null {
  return draft.scope === "workspace" ? clean(draft.workspaceId) || null : null;
}

function scopeMatchesChannel(draft: ModelRouteGroupDraft, channel: DataRow): boolean {
  const channelScope = clean(channel.scope) === "workspace" ? "workspace" : "platform";
  if (draft.scope === "platform") return channelScope === "platform" && !clean(channel.workspaceId);
  return channelScope === "platform"
    || (channelScope === "workspace" && clean(channel.workspaceId) === clean(draft.workspaceId));
}

function capabilityContractForPoolModel(channel: DataRow, upstreamModel: string): Record<string, unknown> {
  const config = parseJsonRecord(channel.configJson);
  const perModel = parseJsonRecord(config.modelCapabilities);
  const selected = perModel[upstreamModel];
  if (selected && typeof selected === "object" && !Array.isArray(selected)) {
    return selected as Record<string, unknown>;
  }
  return parseJsonRecord(config.capabilities);
}

function publicationTargetForRoute(
  draft: ModelRouteGroupDraft,
  routeRecipe: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  if (draft.endpointType === "video_generation") {
    const targetResolution = normalizeVideoResolution(
      parseJsonRecord(routeRecipe).targetResolution,
    );
    if (targetResolution && isPublicVideoResolution(targetResolution)) {
      capabilities.resolutions = fanjinValueVideoOfferDefinition(draft.publicModel) ? FANJIN_VALUE_VIDEO_RESOLUTION_PAIRS.map(pair => pair.targetResolution) : [targetResolution];
      capabilities.defaultResolution = targetResolution;
    }
  }
  return {
    schemaVersion: 1,
    endpointType: clean(draft.endpointType),
    publicModel: clean(draft.publicModel),
    displayName: clean(draft.displayName) || clean(draft.publicModel),
    capabilities,
  };
}

async function normalizeVideoRouteRecipe(
  database: Database,
  draft: ModelRouteGroupDraft,
  target: ModelRouteGroupTargetDraft,
  index: number,
  issues: ModelRouteGroupPreflight["issues"],
): Promise<Record<string, unknown> | undefined> {
  if (draft.endpointType === "video_generation" && fanjinValueVideoOfferDefinition(draft.publicModel) && target.routeRecipe === undefined) {
    issues.push({ path: ["targets", index, "routeRecipe"], message: "繁境特价版必须通过视频超分路由发布", code: "value_video_pair_required" });
  }
  if (draft.endpointType !== "video_generation" || target.routeRecipe === undefined) {
    return target.routeRecipe;
  }
  if (draft.scope !== "platform") {
    issues.push({
      path: ["targets", index, "routeRecipe"],
      message: "视频兑现配方当前只支持平台级发布目标",
      code: "video_fulfillment_platform_only",
    });
    return parseJsonRecord(target.routeRecipe);
  }
  const recipe = parseJsonRecord(target.routeRecipe);
  const mode = clean(recipe.mode).toLowerCase();
  const sourceResolution = normalizeVideoResolution(recipe.sourceResolution);
  const targetResolution = normalizeVideoResolution(recipe.targetResolution);
  if (mode !== "native" && mode !== "upscale") {
    issues.push({
      path: ["targets", index, "routeRecipe", "mode"],
      message: "视频路径必须声明原生输出或超分输出",
      code: "video_recipe_mode_invalid",
    });
  }
  if (!sourceResolution || !targetResolution || !isPublicVideoResolution(targetResolution)) {
    issues.push({
      path: ["targets", index, "routeRecipe"],
      message: "视频路径必须提供有效的源分辨率和目标公开分辨率",
      code: "video_recipe_resolution_invalid",
    });
  } else if (!recipeResolutionsValid({
    targetResolution,
    generateResolution: sourceResolution,
    enhanceEnabled: mode === "upscale",
  })) {
    issues.push({
      path: ["targets", index, "routeRecipe"],
      message: mode === "upscale"
        ? "超分路径的源分辨率必须低于目标分辨率"
        : "原生路径的源分辨率必须等于目标分辨率",
      code: "video_recipe_resolution_invalid",
    });
  }
  const valueDefinition = fanjinValueVideoOfferDefinition(draft.publicModel);
  if (valueDefinition) {
    const pair = fanjinValueVideoResolutionPair(targetResolution);
    if (!pair || sourceResolution !== pair.generationResolution || mode !== "upscale" || target.upstreamModel !== valueDefinition.upstreamModel) {
      issues.push({ path: ["targets", index, "routeRecipe"], code: "value_video_pair_required",
        message: "繁境特价版只支持 480p＋大模型版超分→720p 和 720p＋大模型版超分→1080p，且必须绑定对应上游模型" });
    }
  }
  if (recipe.qualityGate !== true) {
    issues.push({
      path: ["targets", index, "routeRecipe", "qualityGate"],
      message: "视频路径必须经过质量校验节点",
      code: "video_recipe_quality_gate_required",
    });
  }

  let enhanceChannelId: string | null = null;
  if (mode === "upscale") {
    const requestedId = clean(recipe.enhanceChannelId);
    const recipeSchemaVersion = Number(recipe.schemaVersion || 1);
    const candidates = await database(await mediaServiceTable(database))
      .where({ endpointType: "video_upscale", disabled: 0 })
      .orderBy("priority", "asc")
      .orderBy("createTime", "asc");
    const selected = requestedId
      ? candidates.find((candidate) => clean(candidate.id) === requestedId && scopeMatchesChannel(draft, candidate))
      : recipeSchemaVersion >= 2
        ? undefined
        : candidates.find((candidate) => scopeMatchesChannel(draft, candidate));
    if (!selected || (selected.kind === "mediakit" && !mediaKitRuntimeConfig(selected, targetResolution || ""))) {
      issues.push({
        path: ["targets", index, "routeRecipe", "enhanceChannelId"],
        message: requestedId
          ? "当前路由绑定的超分媒体服务不存在、已停用或作用域不匹配"
          : "超分路径必须显式选择在媒体服务页配置的超分服务",
        code: "video_upscale_channel_required",
      });
    } else {
      enhanceChannelId = clean(selected.id);
    }
  }

  return {
    ...recipe,
    schemaVersion: Number(recipe.schemaVersion || 1) >= 2 ? 2 : 1,
    mode,
    ...(sourceResolution ? { sourceResolution } : {}),
    ...(targetResolution ? { targetResolution } : {}),
    qualityGate: recipe.qualityGate === true,
    enhanceChannelId,
  };
}

function priceIssues(draft: ModelRouteGroupDraft, providers: string[]): ModelRouteGroupPreflight["issues"] {
  const issues: ModelRouteGroupPreflight["issues"] = [];
  const pricing = draft.pricing;
  if (!pricing) {
    if (!draft.disabled) issues.push({
      path: ["pricing"],
      message: "启用路由组前必须设置首次售价",
      code: "logical_price_required",
    });
    return issues;
  }
  const units = relayPricingUnits(draft.endpointType);
  if (!units || !units.includes(pricing.unit)) {
    issues.push({
      path: ["pricing", "unit"],
      message: `计费单位 ${pricing.unit || "(空)"} 不适用于 ${draft.endpointType}`,
      code: "logical_price_unit_invalid",
    });
  }
  if (!Number.isSafeInteger(pricing.unitPriceMicros) || pricing.unitPriceMicros < 0) {
    issues.push({
      path: ["pricing", "unitPriceMicros"],
      message: "售价必须是非负整数微 GU",
      code: "logical_price_amount_invalid",
    });
  } else if (!draft.disabled && pricing.unitPriceMicros <= 0) {
    issues.push({
      path: ["pricing", "unitPriceMicros"],
      message: "启用路由组的售价必须大于 0",
      code: "logical_price_amount_required",
    });
  }
  if (clean(pricing.currency || "GU") !== "GU") {
    issues.push({
      path: ["pricing", "currency"],
      message: "用户售价币种必须为 GU",
      code: "logical_price_currency_invalid",
    });
  }
  for (const issue of validatePricingExpressionConfig(pricing.ruleConfig)) {
    issues.push({
      path: ["pricing", ...issue.path],
      message: issue.message,
      code: "pricing_expression_invalid",
    });
  }
  for (const issue of validatePricingAudienceContract(pricing.ruleConfig)) {
    issues.push({
      path: ["pricing", "ruleConfig", ...issue.path],
      message: issue.message,
      code: "pricing_audience_invalid",
    });
  }
  if (draft.endpointType === "video_generation" && pricing.unit === "token") {
    if (providers.some((provider) => provider !== "volcano")) {
      issues.push({
        path: ["targets"],
        message: "视频 token 定价只支持 Volcano 路由目标",
        code: "video_token_provider_invalid",
      });
    }
    if (readVideoTokenReservationUpperBound(pricing.ruleConfig) == null) {
      issues.push({
        path: ["pricing", "ruleConfig", "reservationUpperBoundTokens"],
        message: "视频 token 定价必须配置 reservationUpperBoundTokens",
        code: "video_token_reservation_missing",
      });
    }
  }
  return issues;
}

function normalizePercentages<T extends { tier: ModelRouteGroupTier; trafficWeight: number }>(
  targets: T[],
): number[] {
  return targets.map((target) => {
    const peers = targets.filter((candidate) => candidate.tier === target.tier);
    const total = peers.reduce((sum, candidate) => sum + candidate.trafficWeight, 0);
    return total > 0 ? Math.round((target.trafficWeight / total) * 10_000) / 100 : 0;
  });
}

export async function preflightModelRouteGroup(
  database: Database,
  draft: ModelRouteGroupDraft,
): Promise<ModelRouteGroupPreflight> {
  const issues: ModelRouteGroupPreflight["issues"] = [];
  const warnings: string[] = [];
  const workspaceId = normalizedWorkspaceId(draft);
  const publicModel = clean(draft.publicModel);
  const endpointType = clean(draft.endpointType);
  const groupKey = buildModelRouteGroupKey({
    scope: draft.scope,
    workspaceId,
    endpointType,
    publicModel,
  });
  if (clean(draft.existingGroupKey) && clean(draft.existingGroupKey) !== groupKey) {
    issues.push({
      path: ["publicModel"],
      message: "现有逻辑模型的范围、能力和公开模型标识不可原地修改；请新建路由组后再停用旧组",
      code: "group_identity_immutable",
    });
  }
  if (draft.scope === "workspace" && !workspaceId) {
    issues.push({ path: ["workspaceId"], message: "工作区路由必须提供 workspaceId", code: "workspace_required" });
  }
  if (!publicModel) {
    issues.push({ path: ["publicModel"], message: "公开模型标识不能为空", code: "public_model_required" });
  }
  if (!endpointType) {
    issues.push({ path: ["endpointType"], message: "能力类型不能为空", code: "endpoint_required" });
  }
  if (!draft.targets.length) {
    issues.push({ path: ["targets"], message: "至少选择一个模型池目标", code: "target_required" });
  }
  if (draft.targets.length > 20) {
    issues.push({ path: ["targets"], message: "一个逻辑模型最多配置 20 个目标", code: "target_limit" });
  }

  const targetIds = new Set<string>();
  const bindingKeys = new Set<string>();
  const normalizedTargets: ModelRouteGroupPreflight["normalizedTargets"] = [];
  for (let index = 0; index < draft.targets.length; index += 1) {
    const target = draft.targets[index];
    const channelId = clean(target.channelId);
    const upstreamModel = clean(target.upstreamModel);
    if (target.id) {
      const id = clean(target.id);
      if (targetIds.has(id)) issues.push({
        path: ["targets", index, "id"], message: "同一路由目标被重复提交", code: "target_id_duplicate",
      });
      targetIds.add(id);
    }
    if (!channelId || !upstreamModel) {
      issues.push({
        path: ["targets", index], message: "模型池目标必须包含 channelId 和 upstreamModel", code: "pool_ref_invalid",
      });
      continue;
    }
    const bindingKey = `${channelId}|${upstreamModel}`;
    if (bindingKeys.has(bindingKey)) {
      issues.push({
        path: ["targets", index], message: "同一渠道的同一上游模型不能重复加入路由组", code: "pool_ref_duplicate",
      });
      continue;
    }
    bindingKeys.add(bindingKey);
    if (!Number.isSafeInteger(target.trafficWeight) || target.trafficWeight < 1 || target.trafficWeight > 1000) {
      issues.push({
        path: ["targets", index, "trafficWeight"], message: "路由权重必须是 1–1000 的整数", code: "traffic_weight_invalid",
      });
    }
    if (!(["P0", "P1", "P2"] as const).includes(target.tier)) {
      issues.push({
        path: ["targets", index, "tier"], message: "路由层级必须是 P0、P1 或 P2", code: "tier_invalid",
      });
    }
    const channel = await database("o_provider_channel").where({ id: channelId }).first();
    if (!channel) {
      issues.push({ path: ["targets", index, "channelId"], message: "模型池渠道不存在", code: "channel_missing" });
      continue;
    }
    if (Number(channel.disabled) === 1) {
      issues.push({ path: ["targets", index, "channelId"], message: "模型池渠道已停用", code: "channel_disabled" });
    }
    if (clean(channel.endpointType) !== endpointType) {
      issues.push({ path: ["targets", index, "channelId"], message: "渠道能力与路由组不一致", code: "channel_endpoint_mismatch" });
    }
    if (!scopeMatchesChannel(draft, channel)) {
      issues.push({ path: ["targets", index, "channelId"], message: "渠道范围与路由组不相容", code: "channel_scope_mismatch" });
    }
    if (!parseProviderModelNames(channel.modelNames).includes(upstreamModel)) {
      issues.push({
        path: ["targets", index, "upstreamModel"],
        message: "上游模型已不在该渠道的模型池中，请刷新后重试",
        code: "pool_model_drifted",
      });
    }
    try {
      await normalizeAndValidateModelRoute(database, {
        scope: draft.scope,
        workspaceId,
        endpointType,
        provider: channel.provider,
        channelId,
        disabled: draft.disabled ? 1 : 0,
      });
    } catch (caught) {
      if (caught instanceof RelayConfigValidationError) {
        issues.push({
          path: ["targets", index, "channelId"],
          message: caught.message,
          code: "route_integrity_invalid",
        });
      } else {
        throw caught;
      }
    }
    const normalizedRouteRecipe = await normalizeVideoRouteRecipe(database, draft, target, index, issues);
    normalizedTargets.push({
      ...target,
      channelId,
      upstreamModel,
      ...(normalizedRouteRecipe ? { routeRecipe: normalizedRouteRecipe } : {}),
      provider: clean(channel.provider),
      channelName: clean(channel.name) || "未命名渠道",
      capabilityFingerprint: capabilityFingerprint({
        endpointType,
        upstreamModel,
        channelConfig: channel.configJson,
      }),
      capabilityContract: capabilityContractForPoolModel(channel, upstreamModel),
      normalizedTrafficPercent: 0,
    });
  }
  const fingerprints = new Set(normalizedTargets.map((target) => target.capabilityFingerprint));
  if (fingerprints.size > 1) {
    issues.push({
      path: ["targets"],
      message: "所选模型的能力合同不一致，不能合并为同一逻辑模型",
      code: "capability_mismatch",
    });
  }
  if (endpointType === "video_generation") {
    const targetResolutions = new Set(normalizedTargets
      .map((target) => normalizeVideoResolution(
        parseJsonRecord(target.routeRecipe).targetResolution,
      ))
      .filter(Boolean));
    if (targetResolutions.size > 1) {
      issues.push({
        path: ["targets"],
        message: "同一发布目标的所有路径必须输出相同的目标分辨率",
        code: "video_publish_target_resolution_mismatch",
      });
    }
  }
  const percentages = normalizePercentages(normalizedTargets);
  normalizedTargets.forEach((target, index) => {
    target.normalizedTrafficPercent = percentages[index];
  });
  if (!normalizedTargets.some((target) => target.tier === "P0")) {
    issues.push({ path: ["targets"], message: "至少需要一个 P0 主用目标", code: "primary_target_required" });
  }
  issues.push(...priceIssues(draft, normalizedTargets.map((target) => target.provider)));
  for (const reference of await validatePricingGroupReferences(database, draft.pricing?.ruleConfig)) {
    issues.push({
      path: ["pricing", "ruleConfig", "audiencePricing", "groups", reference.group],
      message: reference.message,
      code: "pricing_group_reference_invalid",
    });
  }

  const existingRoutes = await database("o_model_route").select("*");
  const collisions = existingRoutes.filter((route) => (
    modelRouteGroupKeyForRoute(route) === groupKey
    && modelRouteGroupKeyForRoute(route) !== clean(draft.existingGroupKey)
  ));
  if (collisions.length) {
    issues.push({
      path: ["publicModel"],
      message: "相同范围和能力下已经存在该公开模型",
      code: "group_key_conflict",
    });
  }
  if (normalizedTargets.some((target) => target.tier !== "P0") && draft.targets.length === 1) {
    warnings.push("唯一目标不是 P0，运行时将没有主用层");
  }
  return { valid: issues.length === 0, groupKey, issues, warnings, normalizedTargets };
}

async function selectExistingGroupRoutes(database: Database, existingGroupKey: string): Promise<DataRow[]> {
  if (!existingGroupKey) return [];
  const routes = await database("o_model_route").select("*");
  return routes.filter((route) => modelRouteGroupKeyForRoute(route) === existingGroupKey);
}

async function upsertPriceRow(
  trx: Knex.Transaction,
  selector: {
    scope: ModelRouteGroupScope;
    workspaceId: string | null;
    endpointType: string;
    provider: string | null;
    model: string;
    unit: string;
  },
  values: {
    name: string;
    unitPriceMicros: number;
    currency: string;
    ruleConfig: Record<string, unknown>;
    disabled: number;
    now: number;
  },
): Promise<string> {
  let query = trx("o_pricing_rule").where({
    scope: selector.scope,
    endpointType: selector.endpointType,
    model: selector.model,
    unit: selector.unit,
  });
  query = selector.workspaceId ? query.andWhere("workspaceId", selector.workspaceId) : query.whereNull("workspaceId");
  query = selector.provider ? query.andWhere("provider", selector.provider) : query.whereNull("provider");
  const matches = await query.select("*");
  if (matches.length > 1) {
    throw new ModelRouteGroupMutationError({
      statusCode: 409,
      code: "logical_price_selector_conflict",
      message: "现有价格规则存在重复选择器，请先处理冲突",
    });
  }
  if (matches.length === 1) {
    const id = clean(matches[0].id);
    const certificationRelevantPriceChanged = (
      Number(matches[0].unitPriceMicros) !== values.unitPriceMicros
      || clean(matches[0].currency).toUpperCase() !== clean(values.currency).toUpperCase()
      || Number(matches[0].disabled || 0) !== values.disabled
      || !isDeepStrictEqual(
        pricingCertificationRuleConfig(matches[0].ruleConfig),
        pricingCertificationRuleConfig(values.ruleConfig),
      )
    );
    await trx("o_pricing_rule").where({ id }).update({
      name: values.name,
      unitPriceMicros: values.unitPriceMicros,
      currency: values.currency,
      ruleConfig: JSON.stringify(values.ruleConfig),
      disabled: values.disabled,
      updateTime: certificationRelevantPriceChanged
        ? values.now
        : Number(matches[0].updateTime || values.now),
    });
    return id;
  }
  const id = uuid();
  await trx("o_pricing_rule").insert({
    id,
    name: values.name,
    scope: selector.scope,
    workspaceId: selector.workspaceId,
    endpointType: selector.endpointType,
    provider: selector.provider,
    model: selector.model,
    unit: selector.unit,
    unitPriceMicros: values.unitPriceMicros,
    currency: values.currency,
    ruleConfig: JSON.stringify(values.ruleConfig),
    disabled: values.disabled,
    createTime: values.now,
    updateTime: values.now,
  });
  return id;
}

async function persistLogicalPrice(
  trx: Knex.Transaction,
  input: {
    groupKey: string;
    draft: ModelRouteGroupDraft;
    providers: string[];
    now: number;
  },
): Promise<void> {
  const pricing = input.draft.pricing;
  if (!pricing) return;
  const workspaceId = normalizedWorkspaceId(input.draft);
  const disabled = input.draft.disabled || pricing.unitPriceMicros <= 0 ? 1 : 0;
  const baseRuleConfig = parseJsonRecord(pricing.ruleConfig);
  const previousGroupPrices = await trx("o_pricing_rule").where({
    scope: input.draft.scope,
    endpointType: input.draft.endpointType,
    model: input.draft.publicModel,
  });
  for (const row of previousGroupPrices) {
    const config = parseJsonRecord(row.ruleConfig);
    const belongsToGroup = clean(config.groupKey) === input.groupKey
      || clean(config.parentGroupKey) === input.groupKey;
    if (!belongsToGroup || clean(row.unit) === pricing.unit) continue;
    await trx("o_pricing_rule").where({ id: row.id }).update({ disabled: 1, updateTime: input.now });
  }
  await upsertPriceRow(trx, {
    scope: input.draft.scope,
    workspaceId,
    endpointType: input.draft.endpointType,
    provider: null,
    model: input.draft.publicModel,
    unit: pricing.unit,
  }, {
    name: `${input.draft.displayName || input.draft.publicModel} 统一售价`,
    unitPriceMicros: pricing.unitPriceMicros,
    currency: pricing.currency || "GU",
    ruleConfig: logicalPriceRuleConfig(input.groupKey, { ...baseRuleConfig, logicalCatalogOnly: true }),
    disabled,
    now: input.now,
  });

  for (const provider of [...new Set(input.providers)].sort()) {
    await upsertPriceRow(trx, {
      scope: input.draft.scope,
      workspaceId,
      endpointType: input.draft.endpointType,
      provider,
      model: input.draft.publicModel,
      unit: pricing.unit,
    }, {
      name: `${input.draft.displayName || input.draft.publicModel} 运行时售价 · ${provider}`,
      unitPriceMicros: pricing.unitPriceMicros,
      currency: pricing.currency || "GU",
      ruleConfig: logicalPriceMirrorRuleConfig(input.groupKey, baseRuleConfig),
      disabled,
      now: input.now,
    });
  }

  const providerSet = new Set(input.providers);
  const possibleStaleMirrors = await trx("o_pricing_rule").where({
    scope: input.draft.scope,
    endpointType: input.draft.endpointType,
    model: input.draft.publicModel,
  }).whereNotNull("provider");
  for (const row of possibleStaleMirrors) {
    const config = parseJsonRecord(row.ruleConfig);
    if (config.kind !== "logical-model-price-mirror" || clean(config.parentGroupKey) !== input.groupKey) continue;
    if (providerSet.has(clean(row.provider))) continue;
    await trx("o_pricing_rule").where({ id: row.id }).update({ disabled: 1, updateTime: input.now });
  }
}

function fulfillmentRecipeIdForRoute(route: DataRow | null | undefined): string {
  const recipe = parseJsonRecord(modelRouteGroupConfig(route || {}).routeRecipe);
  return clean(recipe.fulfillmentRecipeId);
}

async function persistVideoFulfillmentRecipe(
  trx: Knex.Transaction,
  input: {
    draft: ModelRouteGroupDraft;
    target: ModelRouteGroupPreflight["normalizedTargets"][number];
    existing: DataRow | null;
    now: number;
    singlePair?: boolean;
  },
): Promise<Record<string, unknown> | undefined> {
  const recipe = input.target.routeRecipe ? parseJsonRecord(input.target.routeRecipe) : undefined;
  if (input.draft.endpointType !== "video_generation" || !recipe) return input.target.routeRecipe;
  if (!(await trx.schema.hasTable(VIDEO_FULFILLMENT_RECIPE_TABLE))) {
    throw new ModelRouteGroupMutationError({
      message: "视频兑现配方表尚未初始化，不能发布视频路径",
      code: "video_fulfillment_schema_missing",
      statusCode: 500,
    });
  }
  const sourceResolution = normalizeVideoResolution(recipe.sourceResolution);
  const targetResolution = normalizeVideoResolution(recipe.targetResolution);
  if (!sourceResolution || !targetResolution || !isPublicVideoResolution(targetResolution)) return recipe;
  const enhanceEnabled = clean(recipe.mode) === "upscale";
  // A value-video model owns exactly two internal recipes, not two public models.
  const valueDefinition = fanjinValueVideoOfferDefinition(input.draft.publicModel);
  if (valueDefinition && !input.singlePair) {
    const previousRecipe = parseJsonRecord(modelRouteGroupConfig(input.existing || {}).routeRecipe);
    const previousIds = parseJsonRecord(previousRecipe.fulfillmentRecipeIds);
    const ids: Record<string, string> = {};
    for (const pair of FANJIN_VALUE_VIDEO_RESOLUTION_PAIRS) {
      const oldId = clean(previousIds[pair.targetResolution])
        || (normalizeVideoResolution(previousRecipe.targetResolution) === pair.targetResolution ? fulfillmentRecipeIdForRoute(input.existing) : "");
      const nested = await persistVideoFulfillmentRecipe(trx, { ...input,
        existing: oldId ? { routeConfig: JSON.stringify({ routeRecipe: { fulfillmentRecipeId: oldId } }) } : null,
        target: { ...input.target, routeRecipe: { ...recipe,
          sourceResolution: pair.generationResolution, targetResolution: pair.targetResolution } },
        singlePair: true,
      });
      ids[pair.targetResolution] = clean(nested?.fulfillmentRecipeId);
    }
    return { ...recipe, supportedResolutions: ["720p", "1080p"], fulfillmentRecipeIds: ids, fulfillmentRecipeId: ids[targetResolution] };
  }
  const previousId = fulfillmentRecipeIdForRoute(input.existing);
  const previous = previousId
    ? await trx(VIDEO_FULFILLMENT_RECIPE_TABLE).where({ id: previousId }).first()
    : null;
  const id = previous && clean(previous.publicModel) === clean(input.draft.publicModel) ? previousId : uuid();
  const row = {
    publicModel: clean(input.draft.publicModel),
    targetResolution,
    name: `${clean(input.draft.displayName) || clean(input.draft.publicModel)} · ${targetResolution} · ${input.target.channelName}`,
    generateChannelId: input.target.channelId,
    generateResolution: sourceResolution,
    upstreamModel: input.target.upstreamModel,
    enhanceEnabled: enhanceEnabled ? 1 : 0,
    enhanceChannelId: enhanceEnabled ? clean(recipe.enhanceChannelId) || null : null,
    weight: input.target.trafficWeight,
    priority: priorityFromTier(input.target.tier),
    enabled: input.draft.disabled ? 0 : 1,
    updatedAt: input.now,
  };
  if (previous && id === previousId) {
    await trx(VIDEO_FULFILLMENT_RECIPE_TABLE).where({ id }).update(row);
  } else {
    await trx(VIDEO_FULFILLMENT_RECIPE_TABLE).insert({ id, ...row, createdAt: input.now });
  }
  return { ...recipe, fulfillmentRecipeId: id };
}

async function disableVideoFulfillmentRecipeForRoute(
  trx: Knex.Transaction,
  route: DataRow,
  now: number,
): Promise<void> {
  const config = parseJsonRecord(modelRouteGroupConfig(route).routeRecipe);
  const ids = [...new Set([fulfillmentRecipeIdForRoute(route), ...Object.values(parseJsonRecord(config.fulfillmentRecipeIds)).map(clean)].filter(Boolean))];
  if (!ids.length || !(await trx.schema.hasTable(VIDEO_FULFILLMENT_RECIPE_TABLE))) return;
  await trx(VIDEO_FULFILLMENT_RECIPE_TABLE).whereIn("id", ids).update({ enabled: 0, updatedAt: now });
}

function parseResolutionList(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => normalizeVideoResolution(item))
    .filter((item): item is string => Boolean(item && isPublicVideoResolution(item)));
}

async function syncVideoPublicOffer(
  trx: Knex.Transaction,
  input: {
    draft: ModelRouteGroupDraft;
    targets: ModelRouteGroupPreflight["normalizedTargets"];
    existingRoutes: DataRow[];
  },
): Promise<void> {
  if (input.draft.endpointType !== "video_generation") return;
  const nextManaged = input.targets
    .map((target) => normalizeVideoResolution(parseJsonRecord(target.routeRecipe).targetResolution))
    .filter((item): item is string => Boolean(item && isPublicVideoResolution(item)));
  if (!nextManaged.length) return;
  if (!(await trx.schema.hasTable(VIDEO_PUBLIC_OFFER_TABLE))) {
    throw new ModelRouteGroupMutationError({
      message: "视频公开目标表尚未初始化，不能发布视频路径",
      code: "video_fulfillment_schema_missing",
      statusCode: 500,
    });
  }
  const previousManaged = new Set(input.existingRoutes
    .map((route) => normalizeVideoResolution(parseJsonRecord(modelRouteGroupConfig(route).routeRecipe).targetResolution))
    .filter((item): item is string => Boolean(item && isPublicVideoResolution(item))));
  const existingOffer = await trx(VIDEO_PUBLIC_OFFER_TABLE).where({ publicModel: input.draft.publicModel }).first();
  const preserved = parseResolutionList(existingOffer?.visibleResolutions)
    .filter((resolution) => !previousManaged.has(resolution));
  const visibleResolutions = fanjinValueVideoOfferDefinition(input.draft.publicModel) ? ["720p", "1080p"] : [...new Set([...preserved, ...nextManaged])];
  await upsertVideoPublicOffer(trx as Knex, {
    publicModel: input.draft.publicModel,
    displayName: clean(input.draft.displayName) || input.draft.publicModel,
    visibleResolutions,
    enabled: !input.draft.disabled,
  });
}

export async function saveModelRouteGroup(
  database: Knex,
  draft: ModelRouteGroupDraft,
): Promise<ModelRouteGroup> {
  const preliminary = await preflightModelRouteGroup(database, draft);
  if (!preliminary.valid) {
    throw new ModelRouteGroupMutationError({
      message: "模型路由组预检未通过",
      code: "model_route_group_preflight_failed",
      issues: preliminary.issues,
    });
  }

  const now = Date.now();
  const workspaceId = normalizedWorkspaceId(draft);
  await serializeRelayConfigMutation(async () => serializePricingRuleMutation(async () => {
    await database.transaction(async (trx) => {
      await lockRelayConfigTablesForMutation(trx);
      await lockPricingRuleTableForMutation(trx);
      const lockedPreflight = await preflightModelRouteGroup(trx, draft);
      if (!lockedPreflight.valid) {
        throw new ModelRouteGroupMutationError({
          message: "保存前模型池或路由配置已发生变化",
          code: "model_route_group_changed",
          statusCode: 409,
          issues: lockedPreflight.issues,
        });
      }
      const existingRoutes = await selectExistingGroupRoutes(trx, clean(draft.existingGroupKey));
      const existingById = new Map(existingRoutes.map((route) => [clean(route.id), route]));
      const retainedIds = new Set<string>();

      for (let index = 0; index < lockedPreflight.normalizedTargets.length; index += 1) {
        const target = lockedPreflight.normalizedTargets[index];
        const existing = target.id ? existingById.get(clean(target.id)) : null;
        if (target.id && !existing) {
          throw new ModelRouteGroupMutationError({
            message: "路由目标不属于当前逻辑模型或已被删除",
            code: "route_target_stale",
            statusCode: 409,
            issues: [{ path: ["targets", index, "id"], message: "请刷新后重试", code: "route_target_stale" }],
          });
        }
        const integrity = await normalizeAndValidateModelRoute(trx, {
          scope: draft.scope,
          workspaceId,
          endpointType: draft.endpointType,
          provider: target.provider,
          channelId: target.channelId,
          disabled: draft.disabled ? 1 : 0,
        });
        const persistedRouteRecipe = await persistVideoFulfillmentRecipe(trx, {
          draft,
          target,
          existing: existing || null,
          now,
        });
        const id = clean(existing?.id) || uuid();
        const row = {
          name: `${draft.publicModel} · ${target.channelName}`,
          displayName: normalizeModelRouteDisplayName(draft.displayName),
          ...integrity,
          model: draft.publicModel,
          priority: priorityFromTier(target.tier),
          fallbackOrder: 0,
          routeConfig: JSON.stringify(managedRouteConfig({
            groupKey: lockedPreflight.groupKey,
            poolRef: { channelId: target.channelId, upstreamModel: target.upstreamModel },
            tier: target.tier,
            trafficWeight: target.trafficWeight,
            capabilityFingerprint: target.capabilityFingerprint,
            capabilityContract: target.capabilityContract,
            publicationTarget: publicationTargetForRoute(draft, persistedRouteRecipe),
            routeRecipe: persistedRouteRecipe,
            existing: existing?.routeConfig,
          })),
          disabled: draft.disabled ? 1 : 0,
          updateTime: now,
        };
        if (existing) await trx("o_model_route").where({ id }).update(row);
        else await trx("o_model_route").insert({ id, ...row, createTime: now });
        retainedIds.add(id);
      }

      for (const route of existingRoutes) {
        if (retainedIds.has(clean(route.id))) continue;
        await disableVideoFulfillmentRecipeForRoute(trx, route, now);
        await trx("o_model_route").where({ id: route.id }).update({
          disabled: 1,
          routeConfig: JSON.stringify({
            ...modelRouteGroupConfig(route),
            removedFromGroupAt: now,
          }),
          updateTime: now,
        });
      }

      await persistLogicalPrice(trx, {
        groupKey: lockedPreflight.groupKey,
        draft,
        providers: lockedPreflight.normalizedTargets.map((target) => target.provider),
        now,
      });

      await syncVideoPublicOffer(trx, {
        draft,
        targets: lockedPreflight.normalizedTargets,
        existingRoutes,
      });

      if (draft.displayName !== undefined) {
        const { mirrorRouteDisplayNameToOffer } = await import("@/lib/videoFulfillment/adminService");
        await mirrorRouteDisplayNameToOffer(trx, {
          model: draft.publicModel,
          displayName: normalizeModelRouteDisplayName(draft.displayName),
          endpointType: draft.endpointType,
        });
      }
    });
  }));

  const groups = await listModelRouteGroups(database, { includeDisabled: true });
  const saved = groups.find((group) => group.groupKey === preliminary.groupKey);
  if (!saved) throw new ModelRouteGroupMutationError({
    message: "模型路由组已保存，但读取结果失败",
    code: "model_route_group_readback_failed",
    statusCode: 500,
  });
  return saved;
}

export async function updateLogicalModelPrice(
  database: Knex,
  input: { groupKey: string; pricing: LogicalModelPriceDraft },
): Promise<ModelRouteGroup> {
  const groups = await listModelRouteGroups(database, { includeDisabled: true });
  const group = groups.find((candidate) => candidate.groupKey === clean(input.groupKey));
  if (!group) throw new ModelRouteGroupMutationError({
    message: "逻辑模型路由组不存在",
    code: "model_route_group_missing",
    statusCode: 404,
  });
  const draft: ModelRouteGroupDraft = {
    existingGroupKey: group.groupKey,
    scope: group.scope,
    workspaceId: group.workspaceId,
    endpointType: group.endpointType,
    publicModel: group.publicModel,
    displayName: group.displayName,
    disabled: group.disabled,
    targets: group.targets
      .filter((target) => !parseJsonRecord(target.routeConfig).removedFromGroupAt)
      .map((target) => ({
        id: target.id,
        channelId: target.channelId,
        upstreamModel: target.upstreamModel,
        tier: target.tier,
        trafficWeight: target.trafficWeight,
        routeRecipe: parseJsonRecord(target.routeConfig).routeRecipe as Record<string, unknown> | undefined,
      })),
    pricing: input.pricing,
  };
  const preliminary = await preflightModelRouteGroup(database, draft);
  if (!preliminary.valid) {
    throw new ModelRouteGroupMutationError({
      message: "模型售价更新预检未通过",
      code: "model_route_group_preflight_failed",
      issues: preliminary.issues,
    });
  }
  await serializeRelayConfigMutation(async () => serializePricingRuleMutation(async () => {
    await database.transaction(async (trx) => {
      await lockRelayConfigTablesForMutation(trx);
      await lockPricingRuleTableForMutation(trx);
      const locked = await preflightModelRouteGroup(trx, draft);
      if (!locked.valid) {
        throw new ModelRouteGroupMutationError({
          message: "保存前模型池、路由或售价配置已发生变化",
          code: "model_route_group_changed",
          statusCode: 409,
          issues: locked.issues,
        });
      }
      await persistLogicalPrice(trx, {
        groupKey: locked.groupKey,
        draft,
        providers: locked.normalizedTargets.map((target) => target.provider),
        now: Date.now(),
      });
    });
  }));
  const updated = (await listModelRouteGroups(database, { includeDisabled: true }))
    .find((candidate) => candidate.groupKey === group.groupKey);
  if (!updated) throw new ModelRouteGroupMutationError({
    message: "售价已更新，但逻辑模型读回失败",
    code: "model_route_group_readback_missing",
    statusCode: 500,
  });
  return updated;
}
