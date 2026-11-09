import type { Knex } from "knex";
import { findMediaService, mediaServiceTable } from "@/lib/mediaServices";
import { v4 as uuid } from "uuid";
import { isValueVideoFulfillmentPrice } from "./pricingPurpose";
import {
  canEnhanceBetween,
  isPublicVideoResolution,
  normalizeVideoResolution,
  PUBLIC_VIDEO_RESOLUTIONS,
  recipeResolutionsValid,
  type PublicVideoResolution,
} from "@/lib/videoResolutions";
import {
  VIDEO_FULFILLMENT_RECIPE_TABLE,
  VIDEO_PUBLIC_OFFER_TABLE,
} from "@/lib/migrations/videoFulfillmentRecipe";
import { listVideoPublicOffers, upsertVideoPublicOffer } from "@/lib/videoFulfillment/recipes";
import { normalizeModelRouteDisplayName } from "@/lib/relayConfigValidation";
import { isFanjinValueVideoModel, fanjinValueVideoResolutionPair, fanjinValueVideoOfferDefinition } from "@/lib/fanjinValueVideoOffers";

/**
 * M2 管理界面服务层:视频能力兑现的 admin 查询与校验。
 * 运行时的配方选择仍在 recipes.ts(Worker D),这里只服务 admin CRUD/展示。
 */

export const VIDEO_ENHANCE_ENDPOINT_TYPE = "video_enhance";
export const VIDEO_GENERATION_ENDPOINT_TYPE = "video_generation";
export const VIDEO_UPSCALE_ENDPOINT_TYPE = "video_upscale";

export class AdminFulfillmentError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AdminFulfillmentError";
    this.code = code;
    this.status = status;
  }
}

export interface AdminChannelOption {
  id: string;
  name: string;
  provider: string;
  endpointType: string;
  modelNames: string[];
  disabled: boolean;
  healthStatus: string | null;
}

export interface AdminOffer {
  publicModel: string;
  displayName: string;
  visibleResolutions: PublicVideoResolution[];
  enabled: boolean;
  /** false 表示仅有模型路由、尚未在兑现页配置 offer */
  offerConfigured: boolean;
  modelRoutes: Array<{
    id: string;
    name: string;
    provider: string | null;
    channelId: string | null;
    displayName: string | null;
    disabled: boolean;
  }>;
  /** 每档 enabled 配方数 / 配方总数(状态灯数据源) */
  recipeCounts: Record<string, { enabled: number; total: number }>;
}

export interface AdminRecipe {
  id: string;
  publicModel: string;
  targetResolution: string;
  name: string;
  generateChannelId: string;
  generateResolution: string;
  upstreamModel: string | null;
  enhanceEnabled: boolean;
  enhanceChannelId: string | null;
  weight: number;
  priority: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** join 得到的通道展示信息;通道被删/停用时不为空但带状态标记 */
  generateChannel: { id: string; name: string; endpointType: string; disabled: boolean } | null;
  enhanceChannel: { id: string; name: string; endpointType: string; disabled: boolean } | null;
  warnings: string[];
}

export interface RecipePayloadInput {
  publicModel: string;
  targetResolution: string;
  name?: string;
  generateChannelId: string;
  generateResolution: string;
  upstreamModel?: string | null;
  enhanceEnabled: boolean;
  enhanceChannelId?: string | null;
  weight: number;
  priority: number;
  enabled: boolean;
}

export interface ValidatedRecipePayload {
  publicModel: string;
  targetResolution: PublicVideoResolution;
  name: string;
  generateChannelId: string;
  generateResolution: string;
  upstreamModel: string | null;
  enhanceEnabled: boolean;
  enhanceChannelId: string | null;
  weight: number;
  priority: number;
  enabled: boolean;
}

function parseModelNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
      } catch {
        // fall through to line split
      }
    }
    return trimmed.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function emptyRecipeCounts(): Record<string, { enabled: number; total: number }> {
  return Object.fromEntries(PUBLIC_VIDEO_RESOLUTIONS.map((res) => [res, { enabled: 0, total: 0 }]));
}

/** 校验生成/超分通道存在、类型正确,并给出停用(非阻断)提示。 */
async function requireChannel(
  knex: Knex,
  channelId: string,
  expectedEndpointType: string,
  code: string,
  label: string,
): Promise<{ id: string; name: string; endpointType: string; disabled: number }> {
  const row = expectedEndpointType === VIDEO_UPSCALE_ENDPOINT_TYPE
    ? await findMediaService(knex, channelId, "mediakit")
    : await knex("o_provider_channel").where({ id: channelId }).first();
  if (!row) {
    throw new AdminFulfillmentError(code, `${label}不存在:${channelId}`);
  }
  if (String(row.endpointType) !== expectedEndpointType) {
    throw new AdminFulfillmentError(
      code,
      `${label}类型须为 ${expectedEndpointType},当前为 ${String(row.endpointType)}`,
    );
  }
  return { id: String(row.id), name: String(row.name || row.id), endpointType: String(row.endpointType), disabled: Number(row.disabled || 0) };
}

/** 创建/更新共用:规范化并校验配方载荷,返回可直接落库的值与警告。 */
export async function validateRecipePayload(
  knex: Knex,
  input: RecipePayloadInput,
): Promise<{ payload: ValidatedRecipePayload; warnings: string[] }> {
  const warnings: string[] = [];
  const publicModel = String(input.publicModel || "").trim();
  if (!publicModel) throw new AdminFulfillmentError("PUBLIC_MODEL_REQUIRED", "缺少 publicModel");

  const targetResolution = normalizeVideoResolution(input.targetResolution);
  if (!targetResolution || !isPublicVideoResolution(targetResolution)) {
    throw new AdminFulfillmentError("TARGET_RESOLUTION_INVALID", "targetResolution 须为公开档 720p/1080p/2k/4k");
  }
  const generateResolution = normalizeVideoResolution(input.generateResolution);
  if (isFanjinValueVideoModel(publicModel)) {
    const pair = fanjinValueVideoResolutionPair(targetResolution);
    const definition = fanjinValueVideoOfferDefinition(publicModel)!;
    if (!pair || pair.generationResolution !== generateResolution || !input.enhanceEnabled || input.upstreamModel !== definition.upstreamModel) {
      throw new AdminFulfillmentError("VALUE_VIDEO_RECIPE_INVALID", "繁境特价版仅支持 480p＋大模型超分→720p、720p＋大模型超分→1080p，并须绑定对应上游模型");
    }
  }
  if (
    !recipeResolutionsValid({
      targetResolution,
      generateResolution,
      enhanceEnabled: Boolean(input.enhanceEnabled),
    })
  ) {
    throw new AdminFulfillmentError(
      "RECIPE_RESOLUTION_INVALID",
      "配方分辨率不合法:不开超分时 generateResolution 须等于目标档;开超分时须低于目标档(内部档 480p/720p/1080p/2k/4k)",
    );
  }

  const generateChannelId = String(input.generateChannelId || "").trim();
  if (!generateChannelId) throw new AdminFulfillmentError("GENERATE_CHANNEL_REQUIRED", "缺少生成通道");
  const generateChannel = await requireChannel(knex, generateChannelId, VIDEO_GENERATION_ENDPOINT_TYPE, "GENERATE_CHANNEL_INVALID", "生成通道");
  if (generateChannel.disabled) warnings.push(`生成通道「${generateChannel.name}」当前已停用`);

  const enhanceEnabled = Boolean(input.enhanceEnabled);
  if (enhanceEnabled && targetResolution === "4k" && input.enabled !== false) {
    throw new AdminFulfillmentError("ENHANCE_TARGET_UNSUPPORTED", "大模型版超分暂不支持 4K；4K 仅可使用原生生成配方");
  }
  let enhanceChannelId: string | null = null;
  if (enhanceEnabled) {
    enhanceChannelId = String(input.enhanceChannelId || "").trim();
    if (!enhanceChannelId) {
      throw new AdminFulfillmentError("ENHANCE_CHANNEL_REQUIRED", "开启超分时必须选择超分通道");
    }
    const enhanceChannel = await requireChannel(knex, enhanceChannelId, VIDEO_UPSCALE_ENDPOINT_TYPE, "ENHANCE_CHANNEL_INVALID", "超分通道");
    if (enhanceChannel.disabled) warnings.push(`超分通道「${enhanceChannel.name}」当前已停用`);
  }

  const weight = Number(input.weight);
  const priority = Number(input.priority);
  if (!Number.isInteger(weight) || weight < 0) {
    throw new AdminFulfillmentError("WEIGHT_INVALID", "weight 须为非负整数");
  }
  if (!Number.isInteger(priority)) {
    throw new AdminFulfillmentError("PRIORITY_INVALID", "priority 须为整数");
  }

  return {
    payload: {
      publicModel,
      targetResolution,
      name: String(input.name || "").trim(),
      generateChannelId,
      generateResolution: String(generateResolution),
      upstreamModel: input.upstreamModel ? String(input.upstreamModel).trim() : null,
      enhanceEnabled,
      enhanceChannelId,
      weight,
      priority,
      enabled: input.enabled !== false,
    },
    warnings,
  };
}

/** 唯一性不强制:同 model+档+同通道组合的已存在配方只产出警告。 */
export async function findSimilarRecipeWarnings(
  knex: Knex,
  candidate: ValidatedRecipePayload,
  excludeId?: string,
): Promise<string[]> {
  if (!(await knex.schema.hasTable(VIDEO_FULFILLMENT_RECIPE_TABLE))) return [];
  const query = knex(VIDEO_FULFILLMENT_RECIPE_TABLE).where({
    publicModel: candidate.publicModel,
    targetResolution: candidate.targetResolution,
  });
  if (excludeId) query.whereNot({ id: excludeId });
  const rows = await query;
  const warnings: string[] = [];
  const samePipeline = rows.filter((row: any) => {
    const rowEnhance = Boolean(Number(row.enhanceEnabled || 0));
    return (
      String(row.generateChannelId) === candidate.generateChannelId
      && String(normalizeVideoResolution(row.generateResolution) || row.generateResolution) === candidate.generateResolution
      && rowEnhance === candidate.enhanceEnabled
      && (rowEnhance ? String(row.enhanceChannelId || "") === String(candidate.enhanceChannelId || "") : true)
    );
  });
  if (samePipeline.length > 0) {
    warnings.push(`已存在 ${samePipeline.length} 条相同生成/超分通道组合的配方(允许保存,轮询时按权重共存)`);
  }
  return warnings;
}

/** 左栏:公开模型 offer + o_model_route 显示名/路由行 + 各档配方计数。 */
export async function listAdminOffers(knex: Knex): Promise<AdminOffer[]> {
  const offers = await listVideoPublicOffers(knex);
  const routes = await knex("o_model_route")
    .select("id", "name", "model", "provider", "channelId", "displayName", "disabled", "priority")
    .where({ endpointType: VIDEO_GENERATION_ENDPOINT_TYPE })
    .orderBy("priority", "asc");

  const countsByModel = new Map<string, Record<string, { enabled: number; total: number }>>();
  if (await knex.schema.hasTable(VIDEO_FULFILLMENT_RECIPE_TABLE)) {
    const grouped = await knex(VIDEO_FULFILLMENT_RECIPE_TABLE)
      .select("publicModel", "targetResolution")
      .count({ total: "*" })
      .sum({ enabled: "enabled" })
      .groupBy("publicModel", "targetResolution");
    for (const row of grouped as any[]) {
      const key = String(row.publicModel);
      if (!countsByModel.has(key)) countsByModel.set(key, emptyRecipeCounts());
      const target = normalizeVideoResolution(row.targetResolution);
      if (target && isPublicVideoResolution(target)) {
        countsByModel.get(key)![target] = {
          enabled: Number(row.enabled || 0),
          total: Number(row.total || 0),
        };
      }
    }
  }

  const routesByModel = new Map<string, typeof routes>();
  for (const route of routes) {
    const model = String(route.model || "").trim();
    if (!model) continue;
    if (!routesByModel.has(model)) routesByModel.set(model, []);
    routesByModel.get(model)!.push(route);
  }

  const seen = new Set<string>();
  const result: AdminOffer[] = [];

  // Runtime truth source for user-facing video model names is o_model_route.displayName
  // (workbench/canvas catalog already reads it). Offer.displayName is a mirror for the
  // fulfillment admin page and is kept in sync on write.
  const toAdminOffer = (
    publicModel: string,
    offer: AdminOffer["visibleResolutions"],
    enabled: boolean,
    offerConfigured: boolean,
    offerDisplayName: string,
  ): AdminOffer => {
    const modelRoutes = (routesByModel.get(publicModel) || []).map((route: any) => ({
      id: String(route.id),
      name: String(route.name || route.id),
      provider: route.provider == null ? null : String(route.provider),
      channelId: route.channelId == null ? null : String(route.channelId),
      displayName: route.displayName == null ? null : String(route.displayName),
      disabled: Boolean(Number(route.disabled || 0)),
    }));
    const routeDisplayName = modelRoutes.map((route) => String(route.displayName || "").trim()).find(Boolean) || "";
    return {
      publicModel,
      displayName: routeDisplayName || String(offerDisplayName || "").trim() || publicModel,
      visibleResolutions: offer,
      enabled,
      offerConfigured,
      modelRoutes,
      recipeCounts: countsByModel.get(publicModel) || emptyRecipeCounts(),
    };
  };

  for (const offer of offers) {
    seen.add(offer.publicModel);
    result.push(toAdminOffer(offer.publicModel, offer.visibleResolutions, offer.enabled, true, offer.displayName));
  }
  // 只有模型路由、还没配置 offer 的公开视频模型也列出来,便于就地补齐配置
  for (const [model] of routesByModel) {
    if (seen.has(model)) continue;
    result.push(toAdminOffer(model, [...PUBLIC_VIDEO_RESOLUTIONS], false, false, ""));
  }

  return result.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** 右栏:单档配方列表,join 生成/超分通道名与状态。 */
export async function listAdminRecipes(
  knex: Knex,
  input: { publicModel: string; targetResolution: string },
): Promise<AdminRecipe[]> {
  if (!(await knex.schema.hasTable(VIDEO_FULFILLMENT_RECIPE_TABLE))) return [];
  const publicModel = String(input.publicModel || "").trim();
  const target = normalizeVideoResolution(input.targetResolution);
  if (!publicModel || !target || !isPublicVideoResolution(target)) return [];
  const rows = await knex(VIDEO_FULFILLMENT_RECIPE_TABLE)
    .where({ publicModel, targetResolution: target })
    .orderBy("priority", "asc")
    .orderBy("weight", "desc")
    .orderBy("createdAt", "asc");

  const channelIds = new Set<string>();
  for (const row of rows) {
    channelIds.add(String(row.generateChannelId));
    if (row.enhanceChannelId) channelIds.add(String(row.enhanceChannelId));
  }
  const channels = channelIds.size
    ? await knex("o_provider_channel").select("id", "name", "endpointType", "disabled").whereIn("id", [...channelIds])
    : [];
  const services = channelIds.size ? await knex(await mediaServiceTable(knex)).where({ endpointType: VIDEO_UPSCALE_ENDPOINT_TYPE }).whereIn("id", [...channelIds]) : [];
  const channelMap = new Map([...channels, ...services].map((row: any) => [String(row.id), row]));

  const channelInfo = (id: string | null): AdminRecipe["generateChannel"] => {
    if (!id) return null;
    const row = channelMap.get(id);
    if (!row) return null;
    return {
      id,
      name: String(row.name || id),
      endpointType: String(row.endpointType || ""),
      disabled: Boolean(Number(row.disabled || 0)),
    };
  };

  return rows.map((row: any) => {
    const enhanceEnabled = Boolean(Number(row.enhanceEnabled || 0));
    const generateChannelId = String(row.generateChannelId);
    const enhanceChannelId = row.enhanceChannelId ? String(row.enhanceChannelId) : null;
    const warnings: string[] = [];
    const generateChannel = channelInfo(generateChannelId);
    const enhanceChannel = channelInfo(enhanceChannelId);
    if (!generateChannel) warnings.push("生成通道不存在或已删除");
    else if (generateChannel.disabled) warnings.push(`生成通道「${generateChannel.name}」已停用`);
    else if (generateChannel.endpointType !== VIDEO_GENERATION_ENDPOINT_TYPE) warnings.push("生成通道类型不是 video_generation");
    if (enhanceEnabled) {
      if (!enhanceChannel) warnings.push("超分通道不存在或已删除");
      else if (enhanceChannel.disabled) warnings.push(`超分通道「${enhanceChannel.name}」已停用`);
      else if (enhanceChannel.endpointType !== VIDEO_UPSCALE_ENDPOINT_TYPE) warnings.push("超分通道类型不是 video_upscale");
    }
    return {
      id: String(row.id),
      publicModel,
      targetResolution: target,
      name: String(row.name || ""),
      generateChannelId,
      generateResolution: String(normalizeVideoResolution(row.generateResolution) || row.generateResolution),
      upstreamModel: row.upstreamModel == null ? null : String(row.upstreamModel),
      enhanceEnabled,
      enhanceChannelId,
      weight: Math.max(0, Number(row.weight || 0)),
      priority: Number(row.priority || 100),
      enabled: Boolean(Number(row.enabled || 0)),
      createdAt: Number(row.createdAt || 0),
      updatedAt: Number(row.updatedAt || 0),
      generateChannel,
      enhanceChannel,
      warnings,
    };
  });
}

/** 通道下拉:generation/upscale 两类通道的轻量列表。 */
export async function listVideoChannels(knex: Knex): Promise<AdminChannelOption[]> {
  const rows = await knex("o_provider_channel")
    .select("id", "name", "provider", "endpointType", "modelNames", "disabled", "healthStatus", "priority")
    .where("endpointType", VIDEO_GENERATION_ENDPOINT_TYPE)
    .orderBy("endpointType", "asc")
    .orderBy("priority", "asc")
    .orderBy("createTime", "asc");
  const services = await knex(await mediaServiceTable(knex)).where({ endpointType: VIDEO_UPSCALE_ENDPOINT_TYPE }).orderBy("priority");
  return [...rows, ...services].map((row: any) => ({
    id: String(row.id),
    name: String(row.name || row.id),
    provider: String(row.provider || ""),
    endpointType: String(row.endpointType || ""),
    modelNames: parseModelNames(row.modelNames),
    disabled: Boolean(Number(row.disabled || 0)),
    healthStatus: row.healthStatus == null ? null : String(row.healthStatus),
  }));
}

export interface EnhancePricingRule {
  id: string;
  name: string;
  sourceResolution: string | null;
  targetResolution: string | null;
  unit: string;
  unitPriceMicros: number;
  currency: string;
  disabled: boolean;
  updateTime: number;
}

function parseRuleConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapEnhanceRule(row: any): EnhancePricingRule {
  const config = parseRuleConfig(row.ruleConfig);
  const source = normalizeVideoResolution(config.sourceResolution);
  const target = normalizeVideoResolution(config.targetResolution);
  return {
    id: String(row.id),
    name: String(row.name || row.id),
    sourceResolution: source && isPublicVideoResolution(source) ? source : null,
    targetResolution: target && isPublicVideoResolution(target) ? target : null,
    unit: String(row.unit || "second"),
    unitPriceMicros: Number(row.unitPriceMicros || 0),
    currency: String(row.currency || "GU"),
    disabled: Boolean(Number(row.disabled || 0)),
    updateTime: Number(row.updateTime || 0),
  };
}

export interface EnhanceMatrixCell {
  sourceResolution: PublicVideoResolution;
  targetResolution: PublicVideoResolution;
  allowed: boolean;
  rule: EnhancePricingRule | null;
}

export interface EnhanceOverview {
  matrix: EnhanceMatrixCell[];
  pricingRules: EnhancePricingRule[];
  upscaleChannels: AdminChannelOption[];
}

/** 子区「创作台画质增强」:公开档两两组合矩阵 + video_enhance 价目 + 超分通道池。 */
export async function listEnhanceOverview(knex: Knex): Promise<EnhanceOverview> {
  const ruleRows = await knex("o_pricing_rule")
    .where({ endpointType: VIDEO_ENHANCE_ENDPOINT_TYPE })
    .orderBy("updateTime", "desc");
  const pricingRules = ruleRows.filter(row => !isValueVideoFulfillmentPrice(row)).map(mapEnhanceRule);

  const matrix: EnhanceMatrixCell[] = [];
  for (const source of PUBLIC_VIDEO_RESOLUTIONS) {
    for (const target of PUBLIC_VIDEO_RESOLUTIONS) {
      if (!canEnhanceBetween(source, target) || target === "4k") continue;
      const rule = pricingRules.find(
        (item) => item.sourceResolution === source && item.targetResolution === target && !item.disabled,
      ) || pricingRules.find(
        (item) => item.sourceResolution === source && item.targetResolution === target,
      ) || null;
      matrix.push({ sourceResolution: source, targetResolution: target, allowed: true, rule });
    }
  }

  const channels = await listVideoChannels(knex);
  return {
    matrix,
    pricingRules,
    upscaleChannels: channels.filter((channel) => channel.endpointType === VIDEO_UPSCALE_ENDPOINT_TYPE),
  };
}

/** video_enhance 价目 upsert:按 (source,target) 匹配已有规则则更新,否则创建。 */
export async function upsertEnhancePricingRule(
  knex: Knex,
  input: {
    sourceResolution: string;
    targetResolution: string;
    unitPriceMicros: number;
    unit?: string;
    disabled?: boolean;
    name?: string;
  },
): Promise<EnhancePricingRule> {
  const source = normalizeVideoResolution(input.sourceResolution);
  const target = normalizeVideoResolution(input.targetResolution);
  if (!source || !isPublicVideoResolution(source)) {
    throw new AdminFulfillmentError("SOURCE_RESOLUTION_INVALID", "源分辨率须为公开档 720p/1080p/2k/4k");
  }
  if (!target || !isPublicVideoResolution(target)) {
    throw new AdminFulfillmentError("TARGET_RESOLUTION_INVALID", "目标分辨率须为公开档 720p/1080p/2k/4k");
  }
  if (!canEnhanceBetween(source, target)) {
    throw new AdminFulfillmentError("ENHANCE_PAIR_INVALID", "目标分辨率必须高于源分辨率");
  }
  if (target === "4k" && !input.disabled) {
    throw new AdminFulfillmentError("ENHANCE_TARGET_UNSUPPORTED", "大模型版超分暂不支持 4K；旧价目仅允许停用");
  }
  const unitPriceMicros = Number(input.unitPriceMicros);
  const disabled = Boolean(input.disabled);
  if (!Number.isInteger(unitPriceMicros) || unitPriceMicros < 0) {
    throw new AdminFulfillmentError("UNIT_PRICE_INVALID", "单价须为非负整数 micros");
  }
  if (!disabled && unitPriceMicros <= 0) {
    throw new AdminFulfillmentError("UNIT_PRICE_INVALID", "启用的价目单价必须大于 0;停用可设为 0");
  }
  const unit = String(input.unit || "second").trim() || "second";
  const name = String(input.name || "").trim() || `画质增强 ${source}→${target}`;
  const now = Date.now();

  const existingRows = await knex("o_pricing_rule").where({ endpointType: VIDEO_ENHANCE_ENDPOINT_TYPE });
  const existing = existingRows.filter(row => !isValueVideoFulfillmentPrice(row)).map(mapEnhanceRule).find(
    (rule) => rule.sourceResolution === source && rule.targetResolution === target,
  );

  const ruleConfig = JSON.stringify({ sourceResolution: source, targetResolution: target });
  if (existing) {
    await knex("o_pricing_rule").where({ id: existing.id }).update({
      name,
      unit,
      unitPriceMicros,
      ruleConfig,
      disabled: disabled ? 1 : 0,
      updateTime: now,
    });
    return mapEnhanceRule(await knex("o_pricing_rule").where({ id: existing.id }).first());
  }

  const id = uuid();
  await knex("o_pricing_rule").insert({
    id,
    name,
    scope: "platform",
    workspaceId: null,
    endpointType: VIDEO_ENHANCE_ENDPOINT_TYPE,
    provider: null,
    model: null,
    unit,
    unitPriceMicros,
    currency: "GU",
    ruleConfig,
    disabled: disabled ? 1 : 0,
    createTime: now,
    updateTime: now,
  });
  return mapEnhanceRule(await knex("o_pricing_rule").where({ id }).first());
}

/**
 * 更新 offer(upsert)。
 * 显示名运行时真相源是 o_model_route.displayName；此处双向镜像：
 * - 写 offer.displayName
 * - 同步到全部 video_generation 模型路由行（画布/目录读取）
 */
export async function updateOfferWithDisplayName(
  knex: Knex,
  input: {
    publicModel: string;
    displayName?: string;
    visibleResolutions?: string[];
    enabled?: boolean;
  },
): Promise<{ offer: Awaited<ReturnType<typeof upsertVideoPublicOffer>>; updatedModelRoutes: number }> {
  const publicModel = String(input.publicModel || "").trim();
  if (!publicModel) throw new AdminFulfillmentError("PUBLIC_MODEL_REQUIRED", "缺少 publicModel");

  const existing = await knex(VIDEO_PUBLIC_OFFER_TABLE).where({ publicModel }).first();
  const routeDisplayName = await knex("o_model_route")
    .where({ endpointType: VIDEO_GENERATION_ENDPOINT_TYPE, model: publicModel })
    .whereNotNull("displayName")
    .where("displayName", "!=", "")
    .orderBy("priority", "asc")
    .first()
    .then((row: any) => String(row?.displayName || "").trim());
  const displayName = String(
    input.displayName ?? existing?.displayName ?? routeDisplayName ?? publicModel,
  ).trim() || publicModel;
  const visibleResolutions = Array.isArray(input.visibleResolutions)
    ? input.visibleResolutions
    : undefined;

  const offer = await upsertVideoPublicOffer(knex, {
    publicModel,
    displayName,
    visibleResolutions: visibleResolutions ?? (existing ? JSON.parse(existing.visibleResolutions || "[]") : [...PUBLIC_VIDEO_RESOLUTIONS]),
    enabled: input.enabled ?? (existing ? Boolean(Number(existing.enabled)) : true),
  });

  const normalizedDisplayName = normalizeModelRouteDisplayName(displayName);
  const updatedModelRoutes = await knex("o_model_route")
    .where({ endpointType: VIDEO_GENERATION_ENDPOINT_TYPE, model: publicModel })
    .update({ displayName: normalizedDisplayName, updateTime: Date.now() });

  return { offer, updatedModelRoutes: Number(updatedModelRoutes || 0) };
}

/** Keep offer mirror in sync when model routes are created/updated from the models admin. */
export async function mirrorRouteDisplayNameToOffer(
  knex: Knex,
  input: { model: string; displayName: string | null | undefined; endpointType?: string | null },
): Promise<void> {
  const endpointType = String(input.endpointType || "").trim();
  if (endpointType && endpointType !== VIDEO_GENERATION_ENDPOINT_TYPE) return;
  const publicModel = String(input.model || "").trim();
  if (!publicModel) return;
  if (!(await knex.schema.hasTable(VIDEO_PUBLIC_OFFER_TABLE))) return;

  const displayName = normalizeModelRouteDisplayName(input.displayName);
  if (!displayName) return;

  const existing = await knex(VIDEO_PUBLIC_OFFER_TABLE).where({ publicModel }).first();
  if (!existing) return;
  await knex(VIDEO_PUBLIC_OFFER_TABLE).where({ id: existing.id }).update({
    displayName,
    updatedAt: Date.now(),
  });
}
