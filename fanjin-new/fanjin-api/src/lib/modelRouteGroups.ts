import crypto from "node:crypto";
import type { Knex } from "knex";

export const MODEL_ROUTE_GROUP_CONFIG_VERSION = 2 as const;
export const LOGICAL_MODEL_PRICE_KIND = "logical-model-price" as const;
export const LOGICAL_MODEL_PRICE_MIRROR_KIND = "logical-model-price-mirror" as const;

export type ModelRouteGroupScope = "platform" | "workspace";
export type ModelRouteGroupTier = "P0" | "P1" | "P2";
export type ModelPublicationStatus =
  | "draft"
  | "needs_attention"
  | "ready"
  | "published"
  | "degraded"
  | "unavailable";

type Database = Knex | Knex.Transaction;
type DataRow = Record<string, any>;

export interface ModelPoolRef {
  channelId: string;
  upstreamModel: string;
}

export interface ModelPoolItem {
  poolId: string;
  scope: ModelRouteGroupScope;
  workspaceId: string | null;
  endpointType: string;
  channelId: string;
  channelName: string;
  provider: string;
  upstreamModel: string;
  health: "healthy" | "degraded" | "unhealthy" | "unknown";
  disabled: boolean;
  routedGroupKeys: string[];
  capabilityFingerprint: string;
}

export interface ModelRouteGroupTarget {
  id: string;
  name: string;
  provider: string;
  channelId: string;
  channelName: string;
  upstreamModel: string;
  tier: ModelRouteGroupTier;
  priority: number;
  trafficWeight: number;
  effectiveWeightSource: "route" | "channel" | "default";
  normalizedTrafficPercent: number;
  disabled: boolean;
  health: ModelPoolItem["health"];
  capabilityFingerprint: string;
  routeConfig: Record<string, unknown>;
}

export interface LogicalModelPrice {
  id: string;
  name: string;
  unit: string;
  unitPriceMicros: number;
  currency: string;
  ruleConfig: Record<string, unknown>;
  disabled: boolean;
  updateTime: number;
}

export interface ModelRouteGroup {
  groupKey: string;
  scope: ModelRouteGroupScope;
  workspaceId: string | null;
  endpointType: string;
  publicModel: string;
  displayName: string;
  disabled: boolean;
  targets: ModelRouteGroupTarget[];
  pricing: LogicalModelPrice | null;
  publication: {
    status: ModelPublicationStatus;
    blockingReasons: string[];
    warnings: string[];
  };
  createTime: number;
  updateTime: number;
}

export interface LogicalModelPricingView {
  groupKey: string;
  scope: ModelRouteGroupScope;
  workspaceId: string | null;
  endpointType: string;
  publicModel: string;
  displayName: string;
  targetCount: number;
  pricing: Pick<NonNullable<ModelRouteGroup["pricing"]>, "unit" | "unitPriceMicros" | "currency"> | null;
  publication: Pick<ModelRouteGroup["publication"], "status">;
}

export function toLogicalModelPricingView(group: ModelRouteGroup): LogicalModelPricingView {
  return {
    groupKey: group.groupKey,
    scope: group.scope,
    workspaceId: group.workspaceId,
    endpointType: group.endpointType,
    publicModel: group.publicModel,
    displayName: group.publicModel,
    targetCount: group.targets.length,
    pricing: group.pricing ? {
      unit: group.pricing.unit,
      unitPriceMicros: group.pricing.unitPriceMicros,
      currency: group.pricing.currency,
    } : null,
    publication: { status: group.publication.status },
  };
}

export interface ModelRouteGroupListInput {
  scope?: ModelRouteGroupScope;
  workspaceId?: string | null;
  endpointType?: string;
  includeDisabled?: boolean;
}

export interface LogicalModelPriceAdmission {
  valid: boolean;
  reason: string;
  canonicalPrice: DataRow | null;
}

export function parseJsonRecord(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

export function parseProviderModelNames(raw: unknown): string[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== "*"))];
}

function clean(value: unknown): string {
  return String(value || "").trim();
}

function routeScope(row: DataRow): ModelRouteGroupScope {
  return clean(row.scope) === "workspace" ? "workspace" : "platform";
}

function routeWorkspaceId(row: DataRow): string | null {
  return routeScope(row) === "workspace" ? clean(row.workspaceId) || null : null;
}

export function buildModelRouteGroupKey(input: {
  scope: unknown;
  workspaceId?: unknown;
  endpointType: unknown;
  publicModel: unknown;
}): string {
  const scope = clean(input.scope) === "workspace" ? "workspace" : "platform";
  const workspaceId = scope === "workspace" ? clean(input.workspaceId) : "";
  return [scope, workspaceId, clean(input.endpointType), clean(input.publicModel)].join("|");
}

export function buildModelPoolId(input: {
  scope: unknown;
  workspaceId?: unknown;
  endpointType: unknown;
  channelId: unknown;
  upstreamModel: unknown;
}): string {
  const scope = clean(input.scope) === "workspace" ? "workspace" : "platform";
  const workspaceId = scope === "workspace" ? clean(input.workspaceId) : "";
  return [
    scope,
    workspaceId,
    clean(input.endpointType),
    clean(input.channelId),
    encodeURIComponent(clean(input.upstreamModel)),
  ].join("|");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

export function capabilityFingerprint(input: {
  endpointType: unknown;
  upstreamModel: unknown;
  channelConfig?: unknown;
}): string {
  const config = parseJsonRecord(input.channelConfig);
  const modelCapabilities = parseJsonRecord(config.modelCapabilities);
  const upstreamModel = clean(input.upstreamModel);
  const capability = modelCapabilities[upstreamModel]
    ?? config.capabilities
    ?? { endpointType: clean(input.endpointType) };
  const digest = crypto.createHash("sha256").update(JSON.stringify(stableValue({
    endpointType: clean(input.endpointType),
    capability,
  })), "utf8").digest("hex");
  return `${clean(input.endpointType)}:${digest.slice(0, 24)}`;
}

export function tierFromPriority(priority: unknown): ModelRouteGroupTier {
  const value = Number(priority);
  if (!Number.isFinite(value) || value < 100) return "P0";
  if (value < 200) return "P1";
  return "P2";
}

export function priorityFromTier(tier: ModelRouteGroupTier): 0 | 100 | 200 {
  if (tier === "P1") return 100;
  if (tier === "P2") return 200;
  return 0;
}

export function modelRouteGroupConfig(route: DataRow): Record<string, any> {
  return parseJsonRecord(route.routeConfig);
}

export function isManagedModelRoute(route: DataRow): boolean {
  const config = modelRouteGroupConfig(route);
  return clean(config.managedBy) === "model-route-group"
    && Number(config.schemaVersion) === MODEL_ROUTE_GROUP_CONFIG_VERSION;
}

export function isLogicalModelManagedPricingRule(rule: DataRow): boolean {
  const kind = clean(parseJsonRecord(rule.ruleConfig).kind);
  return kind === LOGICAL_MODEL_PRICE_KIND || kind === LOGICAL_MODEL_PRICE_MIRROR_KIND;
}

/**
 * Managed logical models have one provider-neutral catalog price and one
 * runtime mirror per provider. User-facing catalogs must require both sides
 * to agree; otherwise one surface could advertise a price that billing does
 * not charge (or vice versa). Legacy routes keep their existing admission.
 */
export async function explainLogicalModelPriceAdmission(
  database: Database,
  route: DataRow,
  providerPrice: DataRow | null | undefined,
): Promise<LogicalModelPriceAdmission> {
  if (!isManagedModelRoute(route)) {
    return { valid: true, reason: "", canonicalPrice: null };
  }
  const groupKey = modelRouteGroupKeyForRoute(route);
  const mirrorConfig = parseJsonRecord(providerPrice?.ruleConfig);
  if (!providerPrice
    || isDisabled(providerPrice.disabled)
    || clean(mirrorConfig.kind) !== LOGICAL_MODEL_PRICE_MIRROR_KIND
    || clean(mirrorConfig.parentGroupKey) !== groupKey) {
    return {
      valid: false,
      reason: "逻辑模型缺少与路由组绑定的运行时价格镜像",
      canonicalPrice: null,
    };
  }

  let query = database("o_pricing_rule").where({
    scope: routeScope(route),
    endpointType: clean(route.endpointType),
    model: clean(route.model),
    unit: clean(providerPrice.unit),
    disabled: 0,
  }).whereNull("provider");
  query = routeScope(route) === "workspace"
    ? query.andWhere("workspaceId", routeWorkspaceId(route))
    : query.whereNull("workspaceId");
  const canonicalRows = (await query.select("*"))
    .filter((row: DataRow) => {
      const config = parseJsonRecord(row.ruleConfig);
      return clean(config.kind) === LOGICAL_MODEL_PRICE_KIND
        && clean(config.groupKey) === groupKey;
    });
  if (canonicalRows.length !== 1) {
    return {
      valid: false,
      reason: canonicalRows.length
        ? "逻辑模型存在重复的统一售价，请先处理价格冲突"
        : "逻辑模型尚未设置统一售价",
      canonicalPrice: null,
    };
  }
  const canonicalPrice = canonicalRows[0];
  const samePrice = clean(canonicalPrice.currency) === clean(providerPrice.currency)
    && clean(canonicalPrice.unit) === clean(providerPrice.unit)
    && Number(canonicalPrice.unitPriceMicros) === Number(providerPrice.unitPriceMicros);
  if (!samePrice) {
    return {
      valid: false,
      reason: "逻辑模型统一售价与运行时价格镜像不一致",
      canonicalPrice,
    };
  }
  return { valid: true, reason: "", canonicalPrice };
}

export function modelRouteGroupKeyForRoute(route: DataRow): string {
  const config = modelRouteGroupConfig(route);
  return clean(config.groupKey) || buildModelRouteGroupKey({
    scope: route.scope,
    workspaceId: route.workspaceId,
    endpointType: route.endpointType,
    publicModel: route.model,
  });
}

export function modelRoutePoolRef(route: DataRow): ModelPoolRef | null {
  const config = modelRouteGroupConfig(route);
  const value = parseJsonRecord(config.poolRef);
  const channelId = clean(value.channelId || route.channelId);
  const upstreamModel = clean(value.upstreamModel || config.upstreamModel || route.model);
  return channelId && upstreamModel ? { channelId, upstreamModel } : null;
}

export function routeTrafficWeight(route: DataRow, channel?: DataRow | null): {
  weight: number;
  source: "route" | "channel" | "default";
} {
  const routeWeight = Number(modelRouteGroupConfig(route).trafficWeight);
  if (Number.isSafeInteger(routeWeight) && routeWeight >= 1 && routeWeight <= 1000) {
    return { weight: routeWeight, source: "route" };
  }
  const channelWeight = Number(channel?.weight);
  if (Number.isSafeInteger(channelWeight) && channelWeight >= 1) {
    return { weight: Math.min(1000, channelWeight), source: "channel" };
  }
  return { weight: 1, source: "default" };
}

function channelHealth(row: DataRow | null | undefined): ModelPoolItem["health"] {
  if (!row) return "unhealthy";
  const status = clean(row.healthStatus).toLowerCase();
  if (status === "failed" || status === "unhealthy") return "unhealthy";
  if (status === "degraded") return "degraded";
  if (status === "ok" || status === "healthy") return "healthy";
  return "unknown";
}

function isDisabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function rowMatchesListInput(row: DataRow, input: ModelRouteGroupListInput): boolean {
  if (input.scope && routeScope(row) !== input.scope) return false;
  if (input.scope === "workspace" && clean(row.workspaceId) !== clean(input.workspaceId)) return false;
  if (input.endpointType && clean(row.endpointType) !== clean(input.endpointType)) return false;
  if (!input.includeDisabled && isDisabled(row.disabled)) return false;
  return true;
}

export async function listModelPoolItems(
  database: Database,
  input: ModelRouteGroupListInput = {},
): Promise<ModelPoolItem[]> {
  const [channels, routes] = await Promise.all([
    database("o_provider_channel").select(
      "id", "name", "scope", "workspaceId", "provider", "endpointType", "configJson",
      "modelNames", "healthStatus", "disabled",
    ),
    database("o_model_route").select(
      "id", "scope", "workspaceId", "endpointType", "model", "channelId", "routeConfig", "disabled",
    ),
  ]);
  const routedGroups = new Map<string, Set<string>>();
  for (const route of routes) {
    const ref = modelRoutePoolRef(route);
    if (!ref) continue;
    const key = `${ref.channelId}|${ref.upstreamModel}`;
    const groups = routedGroups.get(key) ?? new Set<string>();
    groups.add(modelRouteGroupKeyForRoute(route));
    routedGroups.set(key, groups);
  }

  const items: ModelPoolItem[] = [];
  for (const channel of channels) {
    if (channel.endpointType === "video_upscale") continue;
    if (!rowMatchesListInput(channel, { ...input, includeDisabled: true })) continue;
    if (!input.includeDisabled && isDisabled(channel.disabled)) continue;
    for (const upstreamModel of parseProviderModelNames(channel.modelNames)) {
      const key = `${clean(channel.id)}|${upstreamModel}`;
      items.push({
        poolId: buildModelPoolId({
          scope: channel.scope,
          workspaceId: channel.workspaceId,
          endpointType: channel.endpointType,
          channelId: channel.id,
          upstreamModel,
        }),
        scope: routeScope(channel),
        workspaceId: routeWorkspaceId(channel),
        endpointType: clean(channel.endpointType),
        channelId: clean(channel.id),
        channelName: clean(channel.name) || "未命名渠道",
        provider: clean(channel.provider),
        upstreamModel,
        health: channelHealth(channel),
        disabled: isDisabled(channel.disabled),
        routedGroupKeys: [...(routedGroups.get(key) ?? [])].sort(),
        capabilityFingerprint: capabilityFingerprint({
          endpointType: channel.endpointType,
          upstreamModel,
          channelConfig: channel.configJson,
        }),
      });
    }
  }
  return items.sort((left, right) => (
    left.endpointType.localeCompare(right.endpointType)
    || left.upstreamModel.localeCompare(right.upstreamModel)
    || left.channelName.localeCompare(right.channelName)
    || left.channelId.localeCompare(right.channelId)
  ));
}

function logicalPriceForGroup(
  groupKey: string,
  group: { scope: ModelRouteGroupScope; workspaceId: string | null; endpointType: string; publicModel: string },
  pricingRows: DataRow[],
  allowProviderFallback = false,
): { price: LogicalModelPrice | null; warnings: string[] } {
  const tagged = pricingRows.filter((row) => {
    const config = parseJsonRecord(row.ruleConfig);
    return config.kind === LOGICAL_MODEL_PRICE_KIND && clean(config.groupKey) === groupKey;
  });
  const compatible = pricingRows.filter((row) => (
    routeScope(row) === group.scope
    && routeWorkspaceId(row) === group.workspaceId
    && clean(row.endpointType) === group.endpointType
    && clean(row.model) === group.publicModel
    && !clean(row.provider)
    && parseJsonRecord(row.ruleConfig).kind !== LOGICAL_MODEL_PRICE_MIRROR_KIND
  ));
  const providerCompatible = allowProviderFallback ? pricingRows.filter((row) => (
    routeScope(row) === group.scope
    && routeWorkspaceId(row) === group.workspaceId
    && clean(row.endpointType) === group.endpointType
    && clean(row.model) === group.publicModel
    && Boolean(clean(row.provider))
    && parseJsonRecord(row.ruleConfig).kind !== LOGICAL_MODEL_PRICE_MIRROR_KIND
  )) : [];
  const fallbackSignatures = new Set(providerCompatible
    .filter((row) => !isDisabled(row.disabled) && Number(row.unitPriceMicros) > 0)
    .map((row) => [clean(row.unit), Number(row.unitPriceMicros), clean(row.currency) || "GU"].join("|")));
  if (!tagged.length && !compatible.length && fallbackSignatures.size > 1) {
    return { price: null, warnings: ["旧供应商定价不一致，请在模型路由中设置统一售价"] };
  }
  const candidates = tagged.length ? tagged : compatible.length ? compatible : providerCompatible;
  if (!candidates.length) return { price: null, warnings: [] };
  const enabled = candidates.filter((row) => !isDisabled(row.disabled));
  const selected = (enabled.length ? enabled : candidates)
    .sort((left, right) => Number(right.updateTime || 0) - Number(left.updateTime || 0))[0];
  const warnings = tagged.length || compatible.length
    ? candidates.length > 1 ? ["逻辑模型存在多条售价规则，请处理重复定价"] : []
    : ["正在兼容旧供应商售价；下次保存会升级为统一发布目标售价"];
  return {
    price: {
      id: clean(selected.id),
      name: clean(selected.name),
      unit: clean(selected.unit),
      unitPriceMicros: Number(selected.unitPriceMicros || 0),
      currency: clean(selected.currency) || "GU",
      ruleConfig: parseJsonRecord(selected.ruleConfig),
      disabled: isDisabled(selected.disabled),
      updateTime: Number(selected.updateTime || 0),
    },
    warnings,
  };
}

function normalizeTargetPercentages(targets: ModelRouteGroupTarget[]): void {
  const byTier = new Map<ModelRouteGroupTier, ModelRouteGroupTarget[]>();
  for (const target of targets) {
    const values = byTier.get(target.tier) ?? [];
    values.push(target);
    byTier.set(target.tier, values);
  }
  for (const values of byTier.values()) {
    const total = values.reduce((sum, target) => sum + target.trafficWeight, 0);
    for (const target of values) {
      target.normalizedTrafficPercent = total > 0
        ? Math.round((target.trafficWeight / total) * 10_000) / 100
        : 0;
    }
  }
}

function publicationForGroup(input: {
  routes: DataRow[];
  targets: ModelRouteGroupTarget[];
  price: LogicalModelPrice | null;
  warnings: string[];
  priceIntegrityReasons?: string[];
}): ModelRouteGroup["publication"] {
  const blockingReasons: string[] = [...(input.priceIntegrityReasons || [])];
  const warnings = [...input.warnings];
  const disabledStates = new Set(input.routes.map((route) => isDisabled(route.disabled)));
  const fingerprints = new Set(input.targets.map((target) => target.capabilityFingerprint).filter(Boolean));
  if (disabledStates.size > 1) blockingReasons.push("同一逻辑模型的目标启停状态不一致");
  if (fingerprints.size > 1) blockingReasons.push("同一逻辑模型包含能力不等价的上游目标");
  if (!input.price) blockingReasons.push("尚未设置逻辑模型售价");
  else if (input.price.disabled || input.price.unitPriceMicros <= 0) blockingReasons.push("逻辑模型售价未启用或不大于 0");
  const enabledTargets = input.targets.filter((target) => !target.disabled);
  if (!enabledTargets.length) blockingReasons.push("没有启用的路由目标");
  const available = enabledTargets.filter((target) => target.health !== "unhealthy");
  const degraded = enabledTargets.some((target) => target.health === "degraded" || target.health === "unhealthy");
  const groupDisabled = input.routes.every((route) => isDisabled(route.disabled));

  let status: ModelPublicationStatus;
  if (blockingReasons.some((reason) => reason.includes("不一致") || reason.includes("不等价"))) {
    status = "needs_attention";
  } else if (!input.price) {
    status = "draft";
  } else if (groupDisabled) {
    status = blockingReasons.length ? "draft" : "ready";
  } else if (!available.length) {
    status = "unavailable";
  } else if (blockingReasons.length) {
    status = "draft";
  } else {
    status = degraded ? "degraded" : "published";
  }
  return { status, blockingReasons, warnings };
}

function logicalPriceMirrorIntegrityReasons(input: {
  managed: boolean;
  groupKey: string;
  targets: ModelRouteGroupTarget[];
  price: LogicalModelPrice | null;
  pricingRows: DataRow[];
}): string[] {
  if (!input.managed || !input.price) return [];
  const reasons: string[] = [];
  const providers = [...new Set(input.targets.filter((target) => !target.disabled).map((target) => target.provider).filter(Boolean))];
  for (const provider of providers) {
    const mirrors = input.pricingRows.filter((row) => {
      const config = parseJsonRecord(row.ruleConfig);
      return !isDisabled(row.disabled)
        && clean(row.provider) === provider
        && clean(config.kind) === LOGICAL_MODEL_PRICE_MIRROR_KIND
        && clean(config.parentGroupKey) === input.groupKey;
    });
    if (mirrors.length !== 1) {
      reasons.push(mirrors.length
        ? `${provider} 存在重复的运行时价格镜像`
        : `${provider} 缺少运行时价格镜像`);
      continue;
    }
    const mirror = mirrors[0];
    if (clean(mirror.unit) !== input.price.unit
      || clean(mirror.currency) !== input.price.currency
      || Number(mirror.unitPriceMicros) !== input.price.unitPriceMicros) {
      reasons.push(`${provider} 的运行时价格镜像与统一售价不一致`);
    }
  }
  return reasons;
}

export async function listModelRouteGroups(
  database: Database,
  input: ModelRouteGroupListInput = {},
): Promise<ModelRouteGroup[]> {
  const [allRoutes, channels, pricingRows] = await Promise.all([
    database("o_model_route").select("*"),
    database("o_provider_channel").select(
      "id", "name", "scope", "workspaceId", "provider", "endpointType", "configJson",
      "modelNames", "weight", "healthStatus", "disabled",
    ),
    database("o_pricing_rule").select("*"),
  ]);
  const routes = allRoutes.filter((row) => (
    rowMatchesListInput(row, input)
    && !modelRouteGroupConfig(row).removedFromGroupAt
  ));
  const channelById = new Map(channels.map((channel) => [clean(channel.id), channel]));
  const groups = new Map<string, DataRow[]>();
  for (const route of routes) {
    const key = modelRouteGroupKeyForRoute(route);
    const values = groups.get(key) ?? [];
    values.push(route);
    groups.set(key, values);
  }

  return [...groups.entries()].map(([groupKey, values]): ModelRouteGroup => {
    const first = values[0];
    const scope = routeScope(first);
    const workspaceId = routeWorkspaceId(first);
    const endpointType = clean(first.endpointType);
    const publicModel = clean(first.model);
    const displayNames = [...new Set(values.map((row) => clean(row.displayName)).filter(Boolean))];
    const targets = values.map((route): ModelRouteGroupTarget => {
      const channel = channelById.get(clean(route.channelId));
      const config = modelRouteGroupConfig(route);
      const ref = modelRoutePoolRef(route);
      const configuredTier = clean(config.tier);
      const tier = configuredTier === "P0" || configuredTier === "P1" || configuredTier === "P2"
        ? configuredTier
        : tierFromPriority(route.priority);
      const weight = routeTrafficWeight(route, channel);
      const upstreamModel = ref?.upstreamModel || publicModel;
      return {
        id: clean(route.id),
        name: clean(route.name),
        provider: clean(route.provider || channel?.provider),
        channelId: clean(route.channelId),
        channelName: clean(channel?.name) || "未绑定渠道",
        upstreamModel,
        tier,
        priority: priorityFromTier(tier),
        trafficWeight: weight.weight,
        effectiveWeightSource: weight.source,
        normalizedTrafficPercent: 0,
        disabled: isDisabled(route.disabled) || isDisabled(channel?.disabled),
        health: channelHealth(channel),
        capabilityFingerprint: clean(config.capabilityFingerprint) || capabilityFingerprint({
          endpointType,
          upstreamModel,
          channelConfig: channel?.configJson,
        }),
        routeConfig: config,
      };
    }).sort((left, right) => (
      left.priority - right.priority
      || left.channelName.localeCompare(right.channelName)
      || left.id.localeCompare(right.id)
    ));
    normalizeTargetPercentages(targets);
    const managed = values.some(isManagedModelRoute);
    const priceResult = logicalPriceForGroup(groupKey, {
      scope,
      workspaceId,
      endpointType,
      publicModel,
    }, pricingRows, !managed);
    const warnings = [...priceResult.warnings];
    if (displayNames.length > 1) warnings.push("同一逻辑模型存在不同展示名称");
    if (targets.some((target) => target.effectiveWeightSource !== "route")) {
      warnings.push("部分目标仍使用兼容权重，保存后可升级为路由级权重");
    }
    const priceIntegrityReasons = logicalPriceMirrorIntegrityReasons({
      managed,
      groupKey,
      targets,
      price: priceResult.price,
      pricingRows,
    });
    const publication = publicationForGroup({
      routes: values,
      targets,
      price: priceResult.price,
      warnings,
      priceIntegrityReasons,
    });
    return {
      groupKey,
      scope,
      workspaceId,
      endpointType,
      publicModel,
      displayName: displayNames[0] || clean(first.name) || publicModel,
      disabled: values.every((route) => isDisabled(route.disabled)),
      targets,
      pricing: priceResult.price,
      publication,
      createTime: Math.min(...values.map((row) => Number(row.createTime || 0))),
      updateTime: Math.max(
        ...values.map((row) => Number(row.updateTime || 0)),
        Number(priceResult.price?.updateTime || 0),
      ),
    };
  }).sort((left, right) => (
    left.endpointType.localeCompare(right.endpointType)
    || left.publicModel.localeCompare(right.publicModel)
    || left.groupKey.localeCompare(right.groupKey)
  ));
}

export function logicalPriceRuleConfig(groupKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    schemaVersion: MODEL_ROUTE_GROUP_CONFIG_VERSION,
    kind: LOGICAL_MODEL_PRICE_KIND,
    groupKey,
  };
}

export function logicalPriceMirrorRuleConfig(
  groupKey: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    schemaVersion: MODEL_ROUTE_GROUP_CONFIG_VERSION,
    kind: LOGICAL_MODEL_PRICE_MIRROR_KIND,
    parentGroupKey: groupKey,
  };
}

export function managedRouteConfig(input: {
  groupKey: string;
  poolRef: ModelPoolRef;
  tier: ModelRouteGroupTier;
  trafficWeight: number;
  capabilityFingerprint: string;
  capabilityContract?: Record<string, unknown>;
  publicationTarget?: Record<string, unknown>;
  routeRecipe?: Record<string, unknown>;
  existing?: unknown;
}): Record<string, unknown> {
  const existing = parseJsonRecord(input.existing);
  const capabilityContract = parseJsonRecord(input.capabilityContract);
  const existingCapabilities = parseJsonRecord(existing.capabilities);
  const publicationTarget = parseJsonRecord(input.publicationTarget);
  const publishedCapabilities = parseJsonRecord(publicationTarget.capabilities);
  return {
    ...existing,
    ...capabilityContract,
    ...publishedCapabilities,
    schemaVersion: MODEL_ROUTE_GROUP_CONFIG_VERSION,
    managedBy: "model-route-group",
    groupKey: input.groupKey,
    poolRef: input.poolRef,
    tier: input.tier,
    trafficWeight: input.trafficWeight,
    capabilityFingerprint: input.capabilityFingerprint,
    capabilityStatus: Object.keys(capabilityContract).length ? "verified" : clean(existing.capabilityStatus) || "unverified",
    capabilities: { ...existingCapabilities, ...capabilityContract, ...publishedCapabilities },
    ...(Object.keys(publicationTarget).length ? { publicationTarget } : {}),
    ...(input.routeRecipe ? { routeRecipe: parseJsonRecord(input.routeRecipe) } : {}),
  };
}
