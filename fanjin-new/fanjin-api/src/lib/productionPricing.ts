import { isValueVideoFulfillmentPrice } from "@/lib/videoFulfillment/pricingPurpose";
import { normalizeVideoResolution } from "@/lib/videoResolutions";
import { resolveVideoInputPricing } from "@/lib/videoInputPricing";
import { parseCacheWriteAccountingContract } from "@/lib/cacheStorageAccountingContract";

export const RELAY_PRICING_UNITS = {
  text: ["token"],
  embedding: ["token"],
  multimodal_embedding: ["token"],
  image_generation: ["image"],
  video_generation: ["task", "video", "token"],
  tts: ["task"],
  transcription: ["second"],
  rerank: ["document"],
} as const;

export const CREATION_PRICING_UNITS = {
  text: "token",
  image_generation: "image",
  tts: "task",
} as const;

// Internal fulfillment prices share o_pricing_rule with public relay prices,
// but they are not valid model-route endpoint types.  Keep them out of
// RELAY_PRICING_UNITS so a persisted model route can never claim one of these
// endpoints, while still validating their enabled pricing rows.
const INTERNAL_PRICING_UNITS = {
  video_enhance: ["second"],
} as const;

export type RelayPricingEndpointType = keyof typeof RELAY_PRICING_UNITS;
export type CreationPricingEndpointType = keyof typeof CREATION_PRICING_UNITS;

export interface PricingRouteRow {
  id?: unknown;
  name?: unknown;
  scope?: unknown;
  workspaceId?: unknown;
  endpointType?: unknown;
  provider?: unknown;
  model?: unknown;
  channelId?: unknown;
  disabled?: unknown;
}

export interface PricingChannelRow {
  id?: unknown;
  endpointType?: unknown;
  provider?: unknown;
  disabled?: unknown;
}

export interface ProductionPricingRuleRow {
  id?: unknown;
  scope?: unknown;
  workspaceId?: unknown;
  endpointType?: unknown;
  provider?: unknown;
  model?: unknown;
  unit?: unknown;
  unitPriceMicros?: unknown;
  currency?: unknown;
  ruleConfig?: unknown;
  disabled?: unknown;
}

export type ProductionPricingRuleIntegrityReason =
  | "invalid_scope"
  | "platform_workspace_id_present"
  | "workspace_id_missing"
  | "workspace_not_active"
  | "unsupported_endpoint"
  | "invalid_unit"
  | "invalid_video_token_provider"
  | "invalid_reservation_upper_bound"
  | "invalid_video_input_pricing"
  | "invalid_cache_write_accounting"
  | "duplicate_selector";

export interface ProductionPricingRuleIntegrityIssue {
  ruleId: string;
  reason: ProductionPricingRuleIntegrityReason;
}

export type RelayPricingCoverageReason =
  | "unsupported_endpoint"
  | "missing_channel"
  | "disabled_channel"
  | "channel_endpoint_mismatch"
  | "provider_mismatch"
  | "missing_provider"
  | "missing_pricing";

export interface RelayPricingCoverageIssue {
  routeId: string;
  endpointType: string;
  model: string;
  provider: string | null;
  expectedUnits: string[];
  reason: RelayPricingCoverageReason;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function isDisabled(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function isPositiveSafeInteger(value: unknown): boolean {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0;
}

function parseRuleConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Token-priced video tasks are asynchronous, while the provider reports the
 * authoritative completion token count only on the terminal task response.
 * Dispatch therefore requires an administrator-configured hard reservation
 * ceiling; the runtime must never guess it from duration or resolution.
 */
export function readVideoTokenReservationUpperBound(ruleConfig: unknown): number | null {
  const config = parseRuleConfig(ruleConfig);
  const value = config.reservationUpperBoundTokens;
  const fallback = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
  if (config.videoInputPricing === undefined) return fallback;
  const contract = parseRuleConfig(config.videoInputPricing);
  const tierReservation = (value: unknown): number | null => {
    const tier = parseRuleConfig(value);
    const candidate = tier.reservationUpperBoundTokens;
    if (candidate === undefined) return fallback;
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0
      ? candidate
      : null;
  };
  const withVideo = tierReservation(contract.withVideoInput);
  const withoutVideo = tierReservation(contract.withoutVideoInput);
  return withVideo != null && withoutVideo != null
    ? Math.max(withVideo, withoutVideo)
    : null;
}

function activePlatformRule(rule: ProductionPricingRuleRow): boolean {
  return !isDisabled(rule.disabled) && stringValue(rule.scope) === "platform" && !stringValue(rule.workspaceId);
}

function ruleCoversRouteScope(rule: ProductionPricingRuleRow, route: PricingRouteRow): boolean {
  if (isDisabled(rule.disabled)) return false;
  const ruleScope = stringValue(rule.scope);
  if (ruleScope === "platform") return !stringValue(rule.workspaceId);
  return (
    ruleScope === "workspace" &&
    stringValue(route.scope) === "workspace" &&
    Boolean(stringValue(route.workspaceId)) &&
    stringValue(rule.workspaceId) === stringValue(route.workspaceId)
  );
}

export function relayPricingUnits(endpointType: unknown): readonly string[] | null {
  const normalized = stringValue(endpointType) as RelayPricingEndpointType;
  return RELAY_PRICING_UNITS[normalized] ?? null;
}

/**
 * Keep the legacy video-specific release gate aligned with the authoritative
 * relay billing contract. Certified Volcano token rules are valid only when
 * they also persist a safe upper bound for the asynchronous reservation.
 */
export function isProductionVideoPricingRule(rule: ProductionPricingRuleRow): boolean {
  const unit = stringValue(rule.unit);
  return activePlatformRule(rule)
    && stringValue(rule.endpointType) === "video_generation"
    && stringValue(rule.provider) === "volcano"
    && stringValue(rule.currency).toUpperCase() === "GU"
    && isPositiveSafeInteger(rule.unitPriceMicros)
    && (
      unit === "task"
      || unit === "video"
      || (unit === "token" && readVideoTokenReservationUpperBound(rule.ruleConfig) !== null)
    );
}

/**
 * Inspect persisted enabled rules without mutating them. Readiness output is
 * deliberately limited to rule ids and structural reason codes so provider,
 * model, workspace, and price selectors are not exposed in deployment logs.
 */
export function findProductionPricingRuleIntegrityIssues(
  rules: readonly ProductionPricingRuleRow[],
  activeWorkspaceIds: readonly unknown[],
): ProductionPricingRuleIntegrityIssue[] {
  const activeWorkspaces = new Set(activeWorkspaceIds.map(stringValue).filter(Boolean));
  // A logical catalog price is the user-facing source of truth. Provider-
  // specific runtime mirrors remain the only dispatch/billing selectors, so
  // the catalog row must not be evaluated as if it were an upstream rule.
  const enabledRules = rules.filter((rule) => {
    if (isDisabled(rule.disabled)) return false;
    const config = parseRuleConfig(rule.ruleConfig);
    return !(config.kind === "logical-model-price" && config.logicalCatalogOnly === true);
  });
  const issues: ProductionPricingRuleIntegrityIssue[] = [];
  const selectorGroups = new Map<string, Array<{ ruleId: string }>>();

  for (const rule of enabledRules) {
    const ruleId = stringValue(rule.id) || "(unknown-rule)";
    const scope = stringValue(rule.scope);
    const workspaceId = stringValue(rule.workspaceId);
    const endpointType = stringValue(rule.endpointType);
    const unit = stringValue(rule.unit);

    if (scope !== "platform" && scope !== "workspace") {
      issues.push({ ruleId, reason: "invalid_scope" });
    } else if (scope === "platform" && workspaceId) {
      issues.push({ ruleId, reason: "platform_workspace_id_present" });
    } else if (scope === "workspace" && !workspaceId) {
      issues.push({ ruleId, reason: "workspace_id_missing" });
    } else if (scope === "workspace" && !activeWorkspaces.has(workspaceId)) {
      issues.push({ ruleId, reason: "workspace_not_active" });
    }

    const allowedUnits = relayPricingUnits(endpointType)
      ?? INTERNAL_PRICING_UNITS[endpointType as keyof typeof INTERNAL_PRICING_UNITS]
      ?? null;
    if (!allowedUnits) {
      issues.push({ ruleId, reason: "unsupported_endpoint" });
    } else if (!allowedUnits.includes(unit)) {
      issues.push({ ruleId, reason: "invalid_unit" });
    } else if (endpointType === "video_generation" && unit === "token") {
      if (stringValue(rule.provider) !== "volcano") {
        issues.push({ ruleId, reason: "invalid_video_token_provider" });
      }
      if (readVideoTokenReservationUpperBound(rule.ruleConfig) == null) {
        issues.push({ ruleId, reason: "invalid_reservation_upper_bound" });
      }
    }
    if (endpointType === "video_generation") {
      const config = parseRuleConfig(rule.ruleConfig);
      if (config.videoInputPricing !== undefined) {
        try {
          // The resolver validates both tiers before selecting either one, so
          // a malformed dormant tier blocks production at startup as well.
          resolveVideoInputPricing({
            ruleConfig: config,
            requestPayload: {},
            baseUnitPriceMicros: rule.unitPriceMicros,
          });
        } catch {
          issues.push({ ruleId, reason: "invalid_video_input_pricing" });
        }
      }
    }
    if (endpointType === "text") {
      const config = parseRuleConfig(rule.ruleConfig);
      if (config.cacheWriteAccounting !== undefined) {
        try {
          parseCacheWriteAccountingContract(config);
        } catch {
          issues.push({ ruleId, reason: "invalid_cache_write_accounting" });
        }
      }
    }

    const enhancementConfig = endpointType === "video_enhance" ? parseRuleConfig(rule.ruleConfig) : null;
    const selectorKey = JSON.stringify([
      scope,
      scope === "workspace" ? workspaceId : "",
      endpointType,
      stringValue(rule.provider),
      stringValue(rule.model),
      unit,
      ...(enhancementConfig ? [
        isValueVideoFulfillmentPrice(rule) ? "value_video_fulfillment" : "user_enhance",
        normalizeVideoResolution(enhancementConfig.sourceResolution),
        normalizeVideoResolution(enhancementConfig.targetResolution),
      ] : []),
    ]);
    const group = selectorGroups.get(selectorKey) ?? [];
    group.push({ ruleId });
    selectorGroups.set(selectorKey, group);
  }

  for (const group of selectorGroups.values()) {
    if (group.length < 2) continue;
    for (const rule of group) issues.push({ ruleId: rule.ruleId, reason: "duplicate_selector" });
  }

  return issues;
}

/**
 * Check the contract that relay billing enforces before dispatching upstream:
 * the selected route/channel must resolve to a concrete provider, and that
 * provider must have a positive GU rule for the exact endpoint and billing
 * unit. A provider-specific model-null fallback remains valid because the
 * runtime resolver deliberately supports it.
 */
export function findRelayPricingCoverageIssues(
  routes: readonly PricingRouteRow[],
  channels: readonly PricingChannelRow[],
  rules: readonly ProductionPricingRuleRow[],
): RelayPricingCoverageIssue[] {
  const channelById = new Map(
    channels.map((channel) => [stringValue(channel.id), channel] as const).filter(([id]) => Boolean(id)),
  );
  const issues: RelayPricingCoverageIssue[] = [];

  for (const route of routes) {
    if (isDisabled(route.disabled)) continue;
    const routeId = stringValue(route.id) || stringValue(route.name) || "(unknown-route)";
    const endpointType = stringValue(route.endpointType);
    const model = stringValue(route.model);
    const expectedUnits = relayPricingUnits(endpointType);
    const routeProvider = stringValue(route.provider);
    const channelId = stringValue(route.channelId);
    const channel = channelId ? channelById.get(channelId) : undefined;
    const channelProvider = stringValue(channel?.provider);
    const base = {
      routeId,
      endpointType,
      model,
      provider: routeProvider || channelProvider || null,
      expectedUnits: expectedUnits ? [...expectedUnits] : [],
    };

    if (!expectedUnits) {
      issues.push({ ...base, reason: "unsupported_endpoint" });
      continue;
    }
    if (channelId && !channel) {
      issues.push({ ...base, reason: "missing_channel" });
      continue;
    }
    if (channel && isDisabled(channel.disabled)) {
      issues.push({ ...base, reason: "disabled_channel" });
      continue;
    }
    if (channel && stringValue(channel.endpointType) !== endpointType) {
      issues.push({ ...base, reason: "channel_endpoint_mismatch" });
      continue;
    }
    if (routeProvider && channelProvider && routeProvider !== channelProvider) {
      issues.push({ ...base, reason: "provider_mismatch" });
      continue;
    }

    const provider = routeProvider || channelProvider;
    if (!provider) {
      issues.push({ ...base, reason: "missing_provider" });
      continue;
    }

    const covered = rules.some((rule) => {
      const ruleModel = stringValue(rule.model);
      return (
        ruleCoversRouteScope(rule, route) &&
        stringValue(rule.endpointType) === endpointType &&
        stringValue(rule.provider) === provider &&
        (!ruleModel || ruleModel === model) &&
        (expectedUnits as readonly string[]).includes(stringValue(rule.unit)) &&
        !(
          endpointType === "video_generation" &&
          stringValue(rule.unit) === "token" &&
          (
            stringValue(rule.provider) !== "volcano" ||
            readVideoTokenReservationUpperBound(rule.ruleConfig) == null
          )
        ) &&
        stringValue(rule.currency).toUpperCase() === "GU" &&
        isPositiveSafeInteger(rule.unitPriceMicros)
      );
    });
    if (!covered) issues.push({ ...base, provider, reason: "missing_pricing" });
  }

  return issues;
}

/**
 * Creation billing currently resolves without a provider. It therefore needs
 * provider-neutral, model-neutral platform fallbacks and must not count relay
 * provider rules as coverage.
 */
export function findMissingCreationPricing(
  rules: readonly ProductionPricingRuleRow[],
): CreationPricingEndpointType[] {
  return (Object.keys(CREATION_PRICING_UNITS) as CreationPricingEndpointType[]).filter((endpointType) => {
    const expectedUnit = CREATION_PRICING_UNITS[endpointType];
    return !rules.some(
      (rule) =>
        activePlatformRule(rule) &&
        stringValue(rule.endpointType) === endpointType &&
        !stringValue(rule.provider) &&
        !stringValue(rule.model) &&
        stringValue(rule.unit) === expectedUnit &&
        stringValue(rule.currency).toUpperCase() === "GU" &&
        isPositiveSafeInteger(rule.unitPriceMicros),
    );
  });
}
