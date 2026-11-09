import { internalModelId } from "@/lib/minimaxH3PublicIdentity";
import type { Knex } from "knex";
import {
  resolveProviderSpecificPricingRuleWithAudience,
  type PricingRule,
} from "@/lib/providerSpecificPricingReadModel";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  isPreviewProviderDispatchDisabled,
  providerCredentialFallbackEnvNames,
  resolveChannelApiKey,
  resolveChannelBaseUrl,
} from "@/lib/relayChannelCredential";
import {
  hasSealedProviderChannelCredential,
  readProviderChannelCredentialCiphertext,
} from "@/lib/providerChannelCredentials";
import {
  readVideoTokenReservationUpperBound,
  relayPricingUnits,
} from "@/lib/productionPricing";
import {
  isPublicVideoResolution,
  normalizeVideoResolution as normalizeVideoResolutionAlias,
  videoResolutionHeight,
} from "@/lib/videoResolutions";
import { isMiniMaxH3Model } from "@/lib/minimaxH3Manifest";
import { jwsReferenceImageInputSlots } from "@/lib/jwsImageCatalog";
import { autoDLH3SupportsResolution, isAutoDLH3Model } from "@/lib/autodlH3Manifest";
import { autoDLH3OutputPrice } from "@/lib/autodlH3Pricing";
import {
  isHighPublicVideoResolution,
  isNativeHighResolutionReady,
  resolveReadyVideoFulfillmentPlan,
} from "@/lib/videoFulfillment/availability";
import { isFanjinValueVideoModel } from "@/lib/fanjinValueVideoOffers";
import { isFormalCandidateCredentialRuntimeDeclared } from "@/lib/formalCandidateCredentialRuntime";
import {
  evaluateModelRouteCertification,
  isLocalDevelopmentUncertifiedModelRouteAllowed,
  modelRouteImageQualities,
  modelRouteVideoResolutions,
  selectModelRouteDefaultImageQuality,
  selectModelRouteDefaultVideoResolution,
  type ModelRouteCertificationReadiness,
} from "@/lib/modelRouteCertification";
import { isAsyncVideoRelayProvider } from "@/lib/videoRelayProviderAdapter";
import type { PublicVideoDeliveryProof } from "@/lib/videoFulfillment/deliveryProof";
import {
  evaluateSeedance25RouteGate,
  type VideoOperation,
  type VideoReferenceMediaType,
  type VideoReferenceRole,
} from "@/lib/videoGenerationContract";
import {
  assertBytePlusSeedance25PricingRuleReadback,
  assertSeedance25PricingRuleReadback,
  BYTEPLUS_SEEDANCE_25_MODEL_ID,
  SEEDANCE_25_MODEL_ID,
  type Seedance25AnyPricingReadbackBinding,
} from "@/lib/seedance25Adapter";
import { projectWorkbenchVideoCapability } from "@/lib/workbenchVideoCapability";
import { videoOperationForLegacyMode } from "@/lib/videoGenerationSurfaceContract";
import {
  explainLogicalModelPriceAdmission,
  isManagedModelRoute,
} from "@/lib/modelRouteGroups";
import { resolveWorkspacePricingGroup } from "@/lib/pricingAudience";
import { findVolcengineModel } from "@/lib/volcengineModelManifest";

// REVAMP-PLAN 风险 #7 正解:本模块全部为纯读查询,调用方若已在事务内
// (如 Agent Gateway 的 tool execute),必须通过可选 database 参数注入该事务
// 连接;缺省回退全局 db 单例,保持既有调用方行为不变。SQLite 默认
// pool max=1,事务内改走全局连接会排队死锁。
export type WorkbenchModelCatalogDatabase = Knex | Knex.Transaction;

async function applicationDatabase(): Promise<WorkbenchModelCatalogDatabase> {
  return (await import("@/utils/db")).db;
}

export type WorkbenchModelEndpointType = "image_generation" | "video_generation";
export type WorkbenchCapabilityStatus =
  | "verified"
  | "configured"
  | "legacy"
  | "unverified"
  | "unavailable";

export interface WorkbenchDurationCapability {
  /** -1 on the provider wire; fixed ranges stay positive. */
  auto?: boolean;
  min: number;
  max: number;
  step: number;
  default: number;
  allowed?: number[];
}

export type WorkbenchVideoGenerationDirectory = {
  version: "workbench-video-generation/v1";
  contractFamily: string | null;
  dispatchable: boolean;
  operations: Array<{
    operation: VideoOperation;
    enabled: boolean;
    modes: string[];
    aspectRatios?: string[];
    duration: WorkbenchDurationCapability;
    nativeResolutions: string[];
    fulfillmentResolutions: string[];
  }>;
  inputSlots: Array<{
    id: string;
    label: string;
    mediaTypes: VideoReferenceMediaType[];
    roles: VideoReferenceRole[];
    operations: VideoOperation[];
    modes: string[];
    min: number;
    max: number;
    allowDuplicateAsset: boolean;
    supportsTrim: boolean;
  }>;
  totalInputLimit: number;
  mediaTypeLimits: Record<VideoReferenceMediaType, number>;
  supportsGenerateAudio: boolean;
  supportsPreserveSourceAudio: boolean;
  supportsMask: boolean;
  supportsTimeRange: boolean;
  supportsSourceTaskContinuation: boolean;
  draft?: { enabled: boolean; resolution: "480p"; finalResolution: "1080p"; ttlSeconds: number };
  outputFormats?: Array<"mp4" | "mov">;
  defaultOutputFormat?: "mp4" | "mov";
  formalPricingReadback?: Seedance25AnyPricingReadbackBinding;
  resolutionDeliveries: Array<{
    resolution: string;
    delivery: "native" | "quality_enhancement";
  }>;
};

export interface WorkbenchModelCapability {
  id: string;
  model: string;
  aliases?: string[];
  label: string;
  description?: string;
  endpointType: WorkbenchModelEndpointType;
  capabilityStatus: WorkbenchCapabilityStatus;
  canSubmit: boolean;
  unavailableReason?: string;
  /** Effective internal route identity; never substituted with a provider model id. */
  routeId?: string;
  /** 后台路由映射名(o_model_route.name);channel-only 条目为空。 */
  routeName?: string;
  /** 用户可见映射名(o_model_route.displayName);空时调用方回退 routeName/model。 */
  displayName?: string;
  /** 超分组合映射名(routeConfig.enhanceDisplayName),不单独建列。 */
  enhanceDisplayName?: string;
  qualities?: string[];
  defaultQuality?: string;
  /** 0.0.8 Quick Create exposes exactly one real image per request. */
  maxOutputs?: number;
  resolutions?: string[];
  defaultResolution?: string;
  aspectRatios: string[];
  defaultAspectRatio?: string;
  duration?: WorkbenchDurationCapability;
  supportsGenerateAudio?: boolean;
  modes?: string[];
  inputSlots?: Array<Record<string, unknown>>;
  resolutionDeliveries?: WorkbenchVideoGenerationDirectory["resolutionDeliveries"];
  videoGeneration?: WorkbenchVideoGenerationDirectory;
  source: {
    kind: "route" | "channel";
  };
}

export interface WorkbenchModelCatalog {
  catalogVersion: string;
  models: WorkbenchModelCapability[];
  imageModels: WorkbenchModelCapability[];
  videoModels: WorkbenchModelCapability[];
}

export type WorkbenchModelRouteReadinessCheckStatus = "pass" | "fail" | "not_checked";

export interface WorkbenchModelRouteReadinessCheck {
  status: WorkbenchModelRouteReadinessCheckStatus;
  reason?: string;
}

export interface WorkbenchModelRouteReadiness {
  readinessVersion: "workbench-model-route-readiness/v1";
  routeId: string | null;
  evaluatedWorkspaceId: string;
  effectiveRouteId: string | null;
  selectedForCatalog: boolean;
  productionReady: boolean;
  /** Mirrors the projected user catalog admission result for this exact route. */
  canSubmit: boolean;
  capabilityStatus: WorkbenchCapabilityStatus;
  resolvedChannelId: string | null;
  resolvedProvider: string | null;
  selectionReason?: string;
  checks: {
    route: WorkbenchModelRouteReadinessCheck;
    channel: WorkbenchModelRouteReadinessCheck;
    health: WorkbenchModelRouteReadinessCheck;
    credential: WorkbenchModelRouteReadinessCheck;
    adapter: WorkbenchModelRouteReadinessCheck;
    pricing: WorkbenchModelRouteReadinessCheck;
    certification: WorkbenchModelRouteReadinessCheck;
    capability: WorkbenchModelRouteReadinessCheck;
    catalog: WorkbenchModelRouteReadinessCheck;
  };
  /** Verified 2K/4K final-asset facts; never contains provider/channel/task IDs or URLs. */
  deliveryProofs: PublicVideoDeliveryProof[];
  reasons: string[];
}

type DatabaseRow = Record<string, any>;

const CATALOG_VERSION = "workbench-model-catalog/v1";
const ENDPOINT_TYPES: WorkbenchModelEndpointType[] = ["image_generation", "video_generation"];
const KNOWN_CAPABILITY_STATUSES = new Set<WorkbenchCapabilityStatus>([
  "verified",
  "configured",
  "legacy",
  "unverified",
  "unavailable",
]);
const SUBMITTABLE_STATUSES = new Set<WorkbenchCapabilityStatus>(["verified"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function strings(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const normalized = value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
    if (normalized.length) return Array.from(new Set(normalized));
  }
  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function finite(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeStatus(value: unknown): WorkbenchCapabilityStatus {
  const normalized = String(value ?? "").trim().toLowerCase();
  return KNOWN_CAPABILITY_STATUSES.has(normalized as WorkbenchCapabilityStatus)
    ? normalized as WorkbenchCapabilityStatus
    : "unverified";
}

const VIDEO_RESOLUTION_TOKENS = new Set(["480p", "720p", "768p", "960p", "1080p", "2k", "4k"]);

function normalizeVideoResolution(value: unknown): string {
  // 新契约(v31):2K 独立档(高度 1440),4K 规范存储 "4k";统一委托
  // lib/videoResolutions 的别名归一,非标准档位丢弃。
  const normalized = normalizeVideoResolutionAlias(value);
  return normalized && VIDEO_RESOLUTION_TOKENS.has(normalized) ? normalized : "";
}

const MINIMAX_H3_RESOLUTIONS: Record<string, ReadonlySet<string>> = {
  "MiniMax-H3": new Set(["768p", "2k"]),
  "MiniMax-H3-Max": new Set(["480p", "768p"]),
};

function isSelectableVideoResolutionForModel(model: unknown, resolution: string): boolean {
  if (isAutoDLH3Model(model)) return autoDLH3SupportsResolution(model, resolution);
  if (isMiniMaxH3Model(model)) return MINIMAX_H3_RESOLUTIONS[model].has(resolution);
  return isPublicVideoResolution(resolution);
}

/** Exact route identity decides whether provider-native 480p/768p is shown. */
function normalizeSelectableVideoResolutions(model: unknown, ...values: unknown[]): string[] {
  return strings(...values)
    .map(normalizeVideoResolution)
    .filter((value, index, list) => (
      Boolean(value)
      && isSelectableVideoResolutionForModel(model, value)
      && list.indexOf(value) === index
    ));
}

type RelayNativeVideoResolutionContract = {
  nativeResolutions: string[];
  maxNativeResolution: string | null;
};

/**
 * Mirrors parseVideoRouteConfig in Relay. Keep both the normalized native list
 * and maxNativeResolution: the list is authoritative for native eligibility,
 * while Relay still includes max when selecting a lower fallback source. This
 * stays model-independent because even a provider-invalid native tier changes
 * Relay's resolution plan and therefore fallback equivalence.
 */
function relayNativeVideoResolutionContract(
  route: DatabaseRow,
): RelayNativeVideoResolutionContract {
  const config = parseObject(route.routeConfig);
  const declared = Array.isArray(config.nativeResolutions)
    ? config.nativeResolutions
    : Array.isArray(config.resolutions)
      ? config.resolutions.filter((resolution) => {
          const normalized = normalizeVideoResolution(resolution);
          return Boolean(normalized && videoResolutionHeight(normalized) <= 1080);
        })
      : [];
  const nativeResolutions = declared
    .map(normalizeVideoResolution)
    .filter((resolution, index, values) => (
      Boolean(resolution)
      && VIDEO_RESOLUTION_TOKENS.has(resolution)
      && values.indexOf(resolution) === index
    ))
    .sort((left, right) => videoResolutionHeight(left) - videoResolutionHeight(right));
  // Relay normalizes scalar values through String(value), so numeric legacy
  // values such as 768 must remain part of the effective route contract.
  const maxNative = normalizeVideoResolution(config.maxNativeResolution);
  return {
    nativeResolutions,
    maxNativeResolution: maxNative && VIDEO_RESOLUTION_TOKENS.has(maxNative)
      ? maxNative
      : null,
  };
}

function relayDeclaredNativeVideoResolutions(route: DatabaseRow): Set<string> {
  const contract = relayNativeVideoResolutionContract(route);
  // Native eligibility follows Relay's isNativeResolution: a non-empty list
  // is authoritative and maxNativeResolution is ignored for this decision.
  if (contract.nativeResolutions.length > 0) {
    return new Set(contract.nativeResolutions.filter((resolution) => (
      isSelectableVideoResolutionForModel(route.model, resolution)
    )));
  }
  const resolutions: string[] = [];
  if (contract.maxNativeResolution) {
    const maxNative = contract.maxNativeResolution;
    const maximumHeight = videoResolutionHeight(maxNative);
    for (const resolution of VIDEO_RESOLUTION_TOKENS) {
      if (
        isSelectableVideoResolutionForModel(route.model, resolution)
        && videoResolutionHeight(resolution) <= maximumHeight
      ) {
        resolutions.push(resolution);
      }
    }
  }
  return new Set(resolutions);
}

/**
 * Certification inventory is intentionally broader than the public dispatch
 * surface. Only advertise tiers the Relay can actually accept for this exact
 * route/channel binding. Generic Volcano routes never expose internal 480p or
 * 768p generation tiers. MiniMax H3 additionally requires its exact provider
 * and an explicit provider-native route declaration.
 */
function dispatchableVideoResolutions(
  route: DatabaseRow,
  channel: DatabaseRow | null,
  inventory: readonly string[],
): string[] {
  const normalized = inventory
    .map(normalizeVideoResolution)
    .filter((resolution, index, values) => (
      Boolean(resolution) && values.indexOf(resolution) === index
  ));
  if (isAutoDLH3Model(route.model)) {
    if (route.provider !== "autodl" || channel?.provider !== "autodl") return [];
    const declaredNative = relayDeclaredNativeVideoResolutions(route);
    return normalized.filter(resolution => autoDLH3SupportsResolution(route.model, resolution) && declaredNative.has(resolution));
  }
  if (isMiniMaxH3Model(route.model)) {
    const routeProvider = String(route.provider || "").trim();
    const channelProvider = String(channel?.provider || "").trim();
    if (routeProvider !== "minimax" || channelProvider !== "minimax") return [];
    const declaredNative = relayDeclaredNativeVideoResolutions(route);
    return normalized.filter((resolution) => (
      MINIMAX_H3_RESOLUTIONS[route.model].has(resolution)
      && declaredNative.has(resolution)
    ));
  }
  return normalized.filter(isPublicVideoResolution);
}

async function filterUnavailableHighVideoResolutions(input: {
  database: WorkbenchModelCatalogDatabase;
  workspaceId: string;
  route: DatabaseRow;
  generationChannel: DatabaseRow | null;
  capability: WorkbenchModelCapability;
}): Promise<WorkbenchModelCapability> {
  if (input.capability.endpointType !== "video_generation") return input.capability;
  const resolutions = input.capability.resolutions || [];
  const managedValueOffer = isFanjinValueVideoModel(input.capability.model);
  if (!managedValueOffer && !resolutions.some(isHighPublicVideoResolution)) {
    return {
      ...input.capability,
      resolutionDeliveries: resolutions.map((resolution) => ({ resolution, delivery: "native" })),
    };
  }

  const explicitNative = relayDeclaredNativeVideoResolutions(input.route);
  const readyResolutions: string[] = [];
  const resolutionDeliveries: WorkbenchVideoGenerationDirectory["resolutionDeliveries"] = [];
  for (const resolution of resolutions) {
    if (!managedValueOffer && !isHighPublicVideoResolution(resolution)) {
      readyResolutions.push(resolution);
      resolutionDeliveries.push({ resolution, delivery: "native" });
      continue;
    }
    const nativeReady = !managedValueOffer && explicitNative.has(resolution)
      && await isNativeHighResolutionReady(input.database, {
        workspaceId: input.workspaceId,
        publicModel: input.capability.model,
        resolution,
        generationChannel: input.generationChannel,
      });
    const recipeReady = nativeReady
      ? false
      : Boolean(await resolveReadyVideoFulfillmentPlan(input.database, {
          workspaceId: input.workspaceId,
          publicModel: input.capability.model,
          resolution,
        }));
    if (nativeReady || recipeReady) {
      readyResolutions.push(resolution);
      resolutionDeliveries.push({
        resolution,
        delivery: nativeReady ? "native" : "quality_enhancement",
      });
    }
  }

  if (readyResolutions.length === resolutions.length) {
    return { ...input.capability, resolutionDeliveries };
  }
  const defaultResolution = input.capability.defaultResolution
    && readyResolutions.includes(input.capability.defaultResolution)
    ? input.capability.defaultResolution
    : readyResolutions[0];
  if (readyResolutions.length) {
    return {
      ...input.capability,
      resolutions: readyResolutions,
      defaultResolution,
      resolutionDeliveries,
    };
  }
  return {
    ...input.capability,
    capabilityStatus: "unavailable",
    canSubmit: false,
    unavailableReason: managedValueOffer
      ? "当前模型服务暂不可用，请稍后重试"
      : "当前清晰度暂不可用，请选择其他清晰度或稍后重试",
    resolutions: [],
    defaultResolution: undefined,
    resolutionDeliveries: [],
  };
}

function isDisabled(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function isWorkspaceRow(row: DatabaseRow, workspaceId: string): boolean {
  return String(row.scope || "") === "workspace" && String(row.workspaceId || "") === workspaceId;
}

function compareScopedRows(left: DatabaseRow, right: DatabaseRow, workspaceId: string): number {
  const scopeDelta = Number(isWorkspaceRow(right, workspaceId)) - Number(isWorkspaceRow(left, workspaceId));
  if (scopeDelta) return scopeDelta;
  const priorityDelta = Number(left.priority || 0) - Number(right.priority || 0);
  if (priorityDelta) return priorityDelta;
  const fallbackDelta = Number(left.fallbackOrder || 0) - Number(right.fallbackOrder || 0);
  if (fallbackDelta) return fallbackDelta;
  const createTimeDelta = Number(left.createTime || 0) - Number(right.createTime || 0);
  if (createTimeDelta) return createTimeDelta;
  return String(left.id || "").localeCompare(String(right.id || ""));
}

function parseModelNames(raw: unknown): string[] {
  const parsed = typeof raw === "string"
    ? (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return [];
        }
      })()
    : raw;
  return strings(parsed).filter((model) => model !== "*");
}

export type WorkbenchModelCredentialReadMode =
  | "runtime"
  | "sealed-metadata-only";

function effectiveCredentialReadMode(
  requested?: WorkbenchModelCredentialReadMode,
): WorkbenchModelCredentialReadMode {
  if (requested) return requested;
  // The formal candidate deliberately cannot decrypt provider credentials
  // during availability reads.  It may only prove that a sealed credential or
  // credential reference exists; the exact dispatch still consumes the
  // root-owned FD6 capability and fails closed if that capability is missing.
  return isFormalCandidateCredentialRuntimeDeclared()
    ? "sealed-metadata-only"
    : "runtime";
}

function channelHealthUnavailableReason(channel: DatabaseRow): string {
  if (String(channel.healthStatus || "").toLowerCase() === "failed") {
    return "模型绑定的供应商通道健康检查失败";
  }
  return "";
}

function channelConnectionUnavailableReason(channel: DatabaseRow): string {
  const config = parseProviderChannelConfig(channel.configJson);
  if (!resolveChannelBaseUrl({ baseUrl: channel.baseUrl ?? null, config })) {
    return "模型绑定的供应商通道缺少可用 Base URL";
  }
  return "";
}

function channelCredentialUnavailableReason(
  channel: DatabaseRow,
  credentialReadMode: WorkbenchModelCredentialReadMode,
): string {
  if (isPreviewProviderDispatchDisabled()) {
    return "Preview 验证环境禁止真实供应商调用";
  }
  const config = parseProviderChannelConfig(channel.configJson);
  const runtimeChannel = {
    id: channel.id ?? null,
    provider: channel.provider ?? null,
    endpointType: channel.endpointType ?? null,
    credentialCiphertext: channel.credentialCiphertext ?? null,
    credentialRef: channel.credentialRef ?? null,
    baseUrl: channel.baseUrl ?? null,
    config,
  };
  const fallbackEnvNames = providerCredentialFallbackEnvNames(
    channel.provider,
    channel.endpointType,
  );
  if (credentialReadMode === "sealed-metadata-only") {
    const sealed = String(channel.credentialCiphertext || "").trim()
      || readProviderChannelCredentialCiphertext(channel.configJson);
    const credentialRef = String(channel.credentialRef || config.credentialRef || "").trim();
    if (!hasSealedProviderChannelCredential(sealed) && !credentialRef) {
      return "模型绑定的供应商通道凭据未配置";
    }
  } else if (!resolveChannelApiKey(runtimeChannel, fallbackEnvNames)) {
    return "模型绑定的供应商通道凭据未配置";
  }
  return "";
}

function channelUnavailableReason(
  channel: DatabaseRow,
  credentialReadMode: WorkbenchModelCredentialReadMode,
): string {
  // `disabled` is the administrator-owned service switch. `healthStatus` is
  // only a transient routing observation and must never remove a configured
  // model from the user catalog; otherwise a failed probe closes the catalog,
  // no real request can reach the cooldown/recovery path, and the service is
  // stuck unavailable until an administrator intervenes.
  return (isDisabled(channel.disabled) ? "模型绑定的供应商通道已禁用" : "")
    || channelConnectionUnavailableReason(channel)
    || channelCredentialUnavailableReason(channel, credentialReadMode);
}

function providerAdapterUnavailableReason(
  endpointType: string,
  provider: string,
): string {
  if (endpointType === "video_generation" && !isAsyncVideoRelayProvider(provider)) {
    return "视频生成运行时不支持当前供应商通道";
  }
  return "";
}

function pricingRuleUnavailableReason(
  rule: PricingRule | null,
  endpointType: string,
  provider: string,
  model: string,
): string {
  if (!rule) return "当前供应商与模型缺少专属 GU 定价";
  if (rule.provider !== provider || rule.endpointType !== endpointType) {
    return "模型定价与当前供应商或能力类型不匹配";
  }
  if (rule.currency !== "GU") return "模型定价币种必须为 GU";
  const allowedUnits = relayPricingUnits(endpointType);
  if (!allowedUnits?.includes(rule.unit)) {
    return allowedUnits?.length
      ? `模型定价单位无效，${endpointType} 仅支持 ${allowedUnits.join("、")}`
      : `能力类型 ${endpointType} 没有可执行的计费单位`;
  }
  if (!Number.isSafeInteger(rule.unitPriceMicros) || rule.unitPriceMicros <= 0) {
    return "模型 GU 定价单价必须为正安全整数";
  }
  const multiplier = Number(rule.ruleConfig?.multiplier ?? 1);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return "模型定价 multiplier 必须为正数";
  const minimumMicros = Number(rule.ruleConfig?.minimumMicros ?? 0);
  if (!Number.isSafeInteger(minimumMicros) || minimumMicros < 0) {
    return "模型定价 minimumMicros 必须为非负安全整数";
  }
  if (
    endpointType === "video_generation"
    && rule.unit === "token"
    && (provider !== "volcano" || readVideoTokenReservationUpperBound(rule.ruleConfig) == null)
  ) {
    return provider !== "volcano"
      ? "视频 token 定价目前仅支持 volcano 供应商"
      : "视频 token 定价缺少可预估的 reservationUpperBoundTokens";
  }
  if (endpointType === "video_generation" && model === SEEDANCE_25_MODEL_ID) {
    try {
      assertSeedance25PricingRuleReadback({
        provider: rule.provider,
        model: rule.model,
        unit: rule.unit,
        currency: rule.currency,
        baseUnitPriceMicros: rule.unitPriceMicros,
        ruleConfig: rule.ruleConfig,
      });
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Seedance 2.5 定价读回未通过正式双档合同";
    }
  }
  if (endpointType === "video_generation" && provider === "autodl") {
    if (!isAutoDLH3Model(model) || rule.unit !== "video") return "AutoDL H3 缺少专属输出秒定价";
    try { autoDLH3OutputPrice(rule.ruleConfig?.autodlH3Pricing, { model, resolution: "768p", duration: 5 }); }
    catch { return "AutoDL H3 每秒价格配置无效"; }
  }
  return "";
}

async function resolveProviderPricingAdmission(input: {
  database: WorkbenchModelCatalogDatabase;
  workspaceId: string;
  pricingGroup?: string;
  endpointType: string;
  provider: string;
  model: string;
}): Promise<{
  rule: PricingRule | null;
  baseRule: PricingRule | null;
  reason: string;
  hiddenByAudience: boolean;
}> {
  if (!input.provider) {
    return { rule: null, baseRule: null, reason: "模型供应商通道缺少明确 provider", hiddenByAudience: false };
  }
  const resolution = await resolveProviderSpecificPricingRuleWithAudience({
    endpointType: input.endpointType,
    provider: input.provider,
    model: input.model,
    workspaceId: input.workspaceId,
    pricingGroup: input.pricingGroup,
  }, input.database);
  const hiddenByAudience = Boolean(resolution.decision && !resolution.decision.visible);
  return {
    rule: resolution.rule,
    baseRule: resolution.baseRule,
    reason: hiddenByAudience
      ? "当前用户分组无权使用该模型"
      : pricingRuleUnavailableReason(resolution.baseRule, input.endpointType, input.provider, input.model),
    hiddenByAudience,
  };
}

function stripUncertifiedHighTiers(
  capability: WorkbenchModelCapability,
  certification: ModelRouteCertificationReadiness,
  route: DatabaseRow,
): WorkbenchModelCapability {
  const validOperations = new Set(
    certification.operations
      .filter((operation) => operation.valid)
      .map((operation) => operation.operationKey),
  );
  if (capability.endpointType === "image_generation") {
    const qualities = (capability.qualities || []).filter((quality) => (
      validOperations.has(`quality:${quality.toUpperCase()}`)
    ));
    const defaultQuality = selectModelRouteDefaultImageQuality(route, qualities) ?? undefined;
    const hasCertifiedQuality = qualities.length > 0 && Boolean(defaultQuality);
    const canSubmit = SUBMITTABLE_STATUSES.has(capability.capabilityStatus) && hasCertifiedQuality;
    return {
      ...capability,
      capabilityStatus: hasCertifiedQuality ? capability.capabilityStatus : "unavailable",
      canSubmit,
      unavailableReason: canSubmit
        ? undefined
        : hasCertifiedQuality
          ? capability.unavailableReason
          : qualities.length > 1
            ? "模型没有可唯一确定的默认图片清晰度"
            : "模型没有通过认证的图片清晰度",
      qualities,
      defaultQuality,
    };
  }
  const resolutions = (capability.resolutions || []).filter((resolution) => {
    const normalized = normalizeVideoResolution(resolution);
    if (!["2k", "4k"].includes(normalized)) return true;
    const operation = certification.operations.find((candidate) => (
      candidate.operationKey === `resolution:${normalized}`
    ));
    return Boolean(operation?.valid && operation.deliveryProof);
  });
  const resolutionDeliveries = (capability.resolutionDeliveries || [])
    .filter((item) => resolutions.includes(item.resolution))
    .map((item) => {
      const normalized = normalizeVideoResolution(item.resolution);
      if (!["2k", "4k"].includes(normalized)) return item;
      const deliveryProof = certification.operations.find((operation) => (
        operation.operationKey === `resolution:${normalized}`
        && operation.valid
      ))?.deliveryProof;
      return deliveryProof
        ? { resolution: item.resolution, delivery: deliveryProof.delivery }
        : item;
    });
  const defaultResolution = selectModelRouteDefaultVideoResolution(route, resolutions) ?? undefined;
  const hasCertifiedResolution = resolutions.length > 0 && Boolean(defaultResolution);
  const canSubmit = SUBMITTABLE_STATUSES.has(capability.capabilityStatus) && hasCertifiedResolution;
  return {
    ...capability,
    capabilityStatus: hasCertifiedResolution ? capability.capabilityStatus : "unavailable",
    canSubmit,
    unavailableReason: canSubmit
      ? undefined
      : hasCertifiedResolution
        ? capability.unavailableReason
        : resolutions.length > 1
          ? "模型没有可唯一确定的默认视频清晰度"
          : "模型没有通过认证的视频清晰度",
    resolutions,
    defaultResolution,
    resolutionDeliveries,
  };
}

function channelCandidatesForRoute(
  route: DatabaseRow,
  channels: DatabaseRow[],
  workspaceId: string,
): { candidates: DatabaseRow[]; reason?: string } {
  const boundChannelId = String(route.channelId || "").trim();
  const expectedProvider = String(route.provider || "").trim();
  const candidates = channels.filter((channel) => {
    if (String(channel.endpointType || "") !== String(route.endpointType || "")) return false;
    if (expectedProvider && String(channel.provider || "") !== expectedProvider) return false;
    if (boundChannelId && String(channel.id || "") !== boundChannelId) return false;
    if (String(route.scope || "") === "platform") {
      return String(channel.scope || "") === "platform" && channel.workspaceId == null;
    }
    return String(channel.scope || "") === "platform"
      ? channel.workspaceId == null
      : isWorkspaceRow(channel, workspaceId);
  });

  if (boundChannelId && !candidates.length) {
    return { candidates: [], reason: "模型路由绑定的供应商通道不存在或越权" };
  }
  if (!boundChannelId && !expectedProvider) {
    return { candidates: [], reason: "模型路由未绑定供应商通道或 provider" };
  }

  return {
    candidates: [...candidates].sort((left, right) => compareScopedRows(left, right, workspaceId)),
    ...(!candidates.length ? { reason: "没有匹配的供应商通道" } : {}),
  };
}

function visibleChannelForRoute(
  route: DatabaseRow,
  channels: DatabaseRow[],
  workspaceId: string,
  credentialReadMode: WorkbenchModelCredentialReadMode,
): { channel: DatabaseRow | null; reason?: string } {
  if (isDisabled(route.disabled)) return { channel: null, reason: "模型路由已禁用" };

  const selection = channelCandidatesForRoute(route, channels, workspaceId);
  if (!selection.candidates.length) return { channel: null, reason: selection.reason };

  const channelStates = selection.candidates.map((channel) => ({
    channel,
    reason: channelUnavailableReason(channel, credentialReadMode),
  }));
  const active = channelStates.find((state) => !state.reason)?.channel;
  if (active) return { channel: active };

  return {
    channel: null,
    reason: channelStates.find((state) => state.reason)?.reason || "没有可用的供应商通道",
  };
}

function durationCapability(config: Record<string, unknown>, capabilities: Record<string, unknown>, supportsAuto = false): WorkbenchDurationCapability | null {
  const parameters = record(capabilities.parameters);
  const source = {
    ...record(parameters.duration),
    ...record(capabilities.duration),
    ...record(config.duration),
  };
  const allowed = Array.isArray(source.allowed)
    ? Array.from(new Set(source.allowed.map(Number).filter((value) => Number.isFinite(value) && value > 0))).sort((a, b) => a - b)
    : [];
  const min = finite(source.min) ?? (allowed.length ? allowed[0] : null);
  const max = finite(source.max) ?? (allowed.length ? allowed[allowed.length - 1] : null);
  const step = finite(source.step) ?? (allowed.length ? 1 : null);
  const defaultValue = finite(source.default) ?? finite(source.defaultValue) ?? (allowed.length ? allowed[0] : min);
  const autoDefault = supportsAuto && source.auto === true && defaultValue === -1;
  if (min === null || max === null || step === null || defaultValue === null) return null;
  if (min <= 0 || max < min || step <= 0 || (!autoDefault && (defaultValue < min || defaultValue > max))) return null;
  if (allowed.length && ((!autoDefault && !allowed.includes(defaultValue)) || allowed.some((value) => value < min || value > max))) return null;
  if (!allowed.length && !autoDefault) {
    const steps = (defaultValue - min) / step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return null;
  }
  return {
    min,
    max,
    step,
    default: defaultValue,
    ...(allowed.length ? { allowed } : {}),
  };
}

function inputSlots(config: Record<string, unknown>, capabilities: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = Array.isArray(config.inputSlots)
    ? config.inputSlots
    : Array.isArray(capabilities.inputSlots)
      ? capabilities.inputSlots
      : [];
  return raw.filter((slot): slot is Record<string, unknown> => Boolean(slot && typeof slot === "object" && !Array.isArray(slot)));
}

function buildRouteCapability(
  route: DatabaseRow,
  channel: DatabaseRow | null,
  unavailableReason?: string,
  pricingRule?: PricingRule | null,
): WorkbenchModelCapability {
  const config = parseObject(route.routeConfig);
  const seedance25Gate = evaluateSeedance25RouteGate(config, String(route.model || ""));
  const capabilities = record(config.capabilities);
  const parameters = record(capabilities.parameters);
  const status = normalizeStatus(firstString(config.capabilityStatus, capabilities.status, config.status));
  const id = String(route.model || "").trim();
  const officialModel = findVolcengineModel(id, route.endpointType);
  const presentationLabel = [
    "doubao-seedance-2-0-fast-260128",
    "doubao-seedance-2-0-mini-260615",
  ].includes(id)
    ? officialModel?.label
    : undefined;
  const common = {
    id,
    model: id,
    routeId: String(route.id || "").trim() || undefined,
    aliases: strings(config.aliases, config.modelAliases, capabilities.aliases).filter((alias) => alias !== id),
    label: firstString(presentationLabel, config.label, route.displayName, route.name, id),
    routeName: firstString(route.name) || undefined,
    displayName: firstString(route.displayName) || undefined,
    enhanceDisplayName: firstString(config.enhanceDisplayName) || undefined,
    description: firstString(config.description, capabilities.description) || undefined,
    endpointType: route.endpointType as WorkbenchModelEndpointType,
    aspectRatios: strings(
      config.aspectRatios,
      capabilities.aspectRatios,
      record(parameters.aspectRatio).values,
      record(parameters.aspectRatio).options,
      record(parameters.ratio).values,
      record(parameters.ratio).options,
    ),
    source: {
      kind: "route" as const,
    },
  };

  if (route.endpointType === "image_generation") {
    const configuredSlots = inputSlots(config, capabilities);
    const officialImageModel = officialModel?.endpointType === "image_generation"
      ? officialModel
      : null;
    let slots = configuredSlots.length > 0
      ? configuredSlots
      : officialImageModel?.supportsReferenceImages
        ? [{
            id: "reference_images",
            label: "参考图片",
            roles: ["subject", "style", "storyboard", "first_frame", "last_frame", "source_video"],
            accepts: ["image"],
            min: 0,
            max: officialImageModel.maxReferenceImages,
          }]
        : [];
    // The manifest is audited inventory, while the current relay and request
    // contracts only implement the concrete 1K/2K/4K wire presets. Keep 1.5K
    // and 3K hidden until schema, mapping, pricing and paid proof support them.
    const qualities = modelRouteImageQualities(route);
    if (!slots.length && channel?.provider === "openai"
      && parseObject(channel.configJson).imageTransport === "jws-async-v1"
      && config.supportsReferenceImages !== false && capabilities.supportsReferenceImages !== false
      && pricingRule?.provider === "openai" && pricingRule.model === id
      && pricingRule.endpointType === "image_generation") {
      // Legacy JWS routes shipped with empty slots while the async adapter
      // already implements input sessions. The certified price snapshot holds
      // the exact selected model + edit SKUs; route inventory may be stale
      // after a line switch (e.g. GPT official -> free).
      const upstreamModel = firstString(record(config.poolRef).upstreamModel, config.upstreamModel);
      if (upstreamModel && record(config.poolRef).channelId === channel.id) {
        slots = jwsReferenceImageInputSlots(pricingRule.ruleConfig?.upstreamCatalog,
          upstreamModel, qualities, common.aspectRatios);
      }
    }
    const defaultRatioCandidate = firstString(
      config.defaultAspectRatio,
      capabilities.defaultAspectRatio,
      record(parameters.aspectRatio).default,
      record(parameters.aspectRatio).defaultValue,
      record(parameters.ratio).default,
      record(parameters.ratio).defaultValue,
    );
    const defaultQuality = selectModelRouteDefaultImageQuality(route, qualities) ?? undefined;
    const defaultAspectRatio = common.aspectRatios.includes(defaultRatioCandidate)
      ? defaultRatioCandidate
      : common.aspectRatios[0];
    const structurallyComplete = qualities.length > 0
      && common.aspectRatios.length > 0
      && Boolean(defaultAspectRatio);
    const complete = structurallyComplete && Boolean(defaultQuality);
    const canSubmit = Boolean(channel && SUBMITTABLE_STATUSES.has(status) && complete);
    const reason = unavailableReason
      || (!SUBMITTABLE_STATUSES.has(status) ? "模型能力状态未经验证" : "")
      || (!structurallyComplete ? "图片模型 capability 不完整" : "")
      || (!defaultQuality ? "模型没有可唯一确定的默认图片清晰度" : "");
    return {
      ...common,
      capabilityStatus: channel && structurallyComplete ? status : "unavailable",
      canSubmit,
      ...(reason ? { unavailableReason: reason } : {}),
      qualities,
      defaultQuality,
      maxOutputs: 1,
      defaultAspectRatio,
      inputSlots: slots,
    };
  }

  const inventoryResolutions = modelRouteVideoResolutions(route);
  const resolutions = dispatchableVideoResolutions(route, channel, inventoryResolutions);
  const defaultRatioCandidate = firstString(
    config.defaultAspectRatio,
    capabilities.defaultAspectRatio,
    record(parameters.aspectRatio).default,
    record(parameters.aspectRatio).defaultValue,
    record(parameters.ratio).default,
    record(parameters.ratio).defaultValue,
  );
  const configuredDefaultText = firstString(
    config.defaultResolution,
    capabilities.defaultResolution,
    record(parameters.resolution).default,
    record(parameters.resolution).defaultValue,
  );
  const configuredDefault = normalizeVideoResolution(configuredDefaultText);
  const configuredDefaultNotDispatchable = Boolean(
    configuredDefaultText
    && configuredDefault
    && inventoryResolutions.includes(configuredDefault)
    && !resolutions.includes(configuredDefault),
  );
  const defaultResolution = configuredDefaultNotDispatchable
    ? undefined
    : selectModelRouteDefaultVideoResolution(route, resolutions) ?? undefined;
  const defaultAspectRatio = common.aspectRatios.includes(defaultRatioCandidate)
    ? defaultRatioCandidate
    : common.aspectRatios[0];
  const bytePlusAuto = id === BYTEPLUS_SEEDANCE_25_MODEL_ID && seedance25Gate.dispatchable;
  const duration = durationCapability(config, capabilities, bytePlusAuto || (officialModel?.endpointType === "video_generation" && officialModel.supportsAutoDuration === true));
  if (duration && bytePlusAuto) duration.auto = true;
  // Only exact native models are eligible. Fulfillment SKUs have a separate
  // per-second settlement contract and must not inherit this capability.
  if (duration && officialModel?.endpointType === "video_generation") {
    duration.auto = officialModel.supportsAutoDuration === true
      && duration.min <= officialModel.durations[0]
      && duration.max >= officialModel.durations[officialModel.durations.length - 1]
      && (!duration.allowed?.length || officialModel.durations.every((value) => duration.allowed!.includes(value)));
  }
  const supportsGenerateAudio = firstBoolean(
    config.supportsGenerateAudio,
    capabilities.supportsGenerateAudio,
    record(parameters.generateAudio).supported,
    record(parameters.audio).supported,
  );
  const modes = strings(config.modes, capabilities.modes);
  const slots = inputSlots(config, capabilities);
  const structurallyComplete = resolutions.length > 0
    && common.aspectRatios.length > 0
    && Boolean(defaultAspectRatio && duration)
    && typeof supportsGenerateAudio === "boolean"
    && modes.length > 0;
  const complete = structurallyComplete && Boolean(defaultResolution);
  // A route that identifies itself as Seedance 2.5 cannot inherit the legacy
  // video path's permissive mapping. Until its formal provider contract,
  // adapter mapping, pricing revision, compliance policy and explicit feature
  // flag compile as one verified contract, the user catalog remains closed.
  const canSubmit = Boolean(
    channel
    && SUBMITTABLE_STATUSES.has(status)
    && complete
    && seedance25Gate.dispatchable,
  );
  const reason = unavailableReason
    || (!seedance25Gate.dispatchable ? seedance25Gate.reason || "Seedance 2.5 正式合同门禁未通过" : "")
    || (!SUBMITTABLE_STATUSES.has(status) ? "模型能力状态未经验证" : "")
    || (configuredDefaultNotDispatchable ? "默认视频清晰度不可作为用户可派发档位" : "")
    || (!structurallyComplete ? "视频模型 capability 不完整" : "")
    || (!defaultResolution ? "模型没有可唯一确定的默认视频清晰度" : "");
  return {
    ...common,
    capabilityStatus: channel
      && structurallyComplete
      && seedance25Gate.dispatchable
      && !configuredDefaultNotDispatchable
      ? status
      : "unavailable",
    canSubmit,
    ...(reason ? { unavailableReason: reason } : {}),
    resolutions,
    defaultResolution,
    defaultAspectRatio,
    ...(duration ? { duration } : {}),
    ...(supportsGenerateAudio !== undefined ? { supportsGenerateAudio } : {}),
    modes,
    inputSlots: slots,
  };
}

function disabledVideoGenerationDirectory(
  contractFamily: string | null,
): WorkbenchVideoGenerationDirectory {
  return {
    version: "workbench-video-generation/v1",
    contractFamily,
    dispatchable: false,
    operations: [],
    inputSlots: [],
    totalInputLimit: 0,
    mediaTypeLimits: { image: 0, video: 0, audio: 0 },
    supportsGenerateAudio: false,
    supportsPreserveSourceAudio: false,
    supportsMask: false,
    supportsTimeRange: false,
    supportsSourceTaskContinuation: false,
    resolutionDeliveries: [],
  };
}

function attachVideoGenerationDirectory(
  capability: WorkbenchModelCapability,
  route: DatabaseRow,
  pricingRule: PricingRule | null,
): WorkbenchModelCapability {
  if (capability.endpointType !== "video_generation") return capability;
  if (capability.duration?.auto) {
    capability = {
      ...capability,
      duration: { ...capability.duration, auto: pricingRule?.provider === "volcano" && pricingRule.unit === "token" },
    };
  }
  const gate = evaluateSeedance25RouteGate(parseObject(route.routeConfig), String(route.model || ""));
  if (gate.recognized) {
    if (!gate.dispatchable || !capability.canSubmit || !gate.capability) {
      return {
        ...capability,
        videoGeneration: disabledVideoGenerationDirectory(
          gate.capability?.contractFamily || "seedance-2.5",
        ),
      };
    }
    let formalPricingReadback: Seedance25AnyPricingReadbackBinding;
    try {
      formalPricingReadback = (capability.id === BYTEPLUS_SEEDANCE_25_MODEL_ID
        ? assertBytePlusSeedance25PricingRuleReadback
        : assertSeedance25PricingRuleReadback)({
        provider: pricingRule?.provider,
        model: pricingRule?.model,
        unit: pricingRule?.unit,
        currency: pricingRule?.currency,
        baseUnitPriceMicros: pricingRule?.unitPriceMicros,
        ruleConfig: pricingRule?.ruleConfig,
      });
    } catch (error) {
      return {
        ...capability,
        canSubmit: false,
        capabilityStatus: "unavailable",
        unavailableReason: error instanceof Error
          ? error.message
          : "Seedance 2.5 定价读回未通过正式双档合同",
        videoGeneration: disabledVideoGenerationDirectory(
          gate.capability.contractFamily,
        ),
      };
    }
    const compatibilityModes = Array.from(new Set((capability.modes || [])
      .filter((mode) => !["video_extension", "video_edit"].includes(mode) && videoOperationForLegacyMode(mode) === "generate")));
    const compatibilitySlotModes = new Map((capability.inputSlots || [])
      .map((slot) => [
        typeof slot.id === "string" ? slot.id : "",
        Array.isArray(slot.modes)
          ? slot.modes.filter((mode): mode is string => typeof mode === "string")
          : [],
      ] as const)
      .filter(([id]) => Boolean(id)));
    const operations = gate.capability.operations
      .filter((operation) => operation.enabled)
      .map((operation) => ({
        operation: operation.operation,
        enabled: true,
        // Canvas and Quick Create still select the canonical generate operation
        // through legacy mode labels. Keep that projection until every client
        // has migrated to the operation-first contract.
        modes: operation.operation === "generate" ? compatibilityModes : operation.operation === "extend" ? ["video_extension"] : ["video_edit"],
        aspectRatios: operation.operation !== "generate" ? ["adaptive"] : [...capability.aspectRatios],
        duration: {
          ...operation.durationSeconds,
          auto: capability.id === BYTEPLUS_SEEDANCE_25_MODEL_ID || operation.operation === "edit" || operation.operation === "generate" && capability.duration?.auto === true,
          default: operation.operation === "edit" || capability.id === BYTEPLUS_SEEDANCE_25_MODEL_ID
            ? -1 : operation.durationSeconds.allowed?.[0] ?? operation.durationSeconds.min,
        },
        nativeResolutions: [...operation.nativeResolutions],
        fulfillmentResolutions: [...operation.fulfillmentResolutions],
      }));
    return {
      ...capability,
      videoGeneration: {
        version: "workbench-video-generation/v1",
        contractFamily: gate.capability.contractFamily,
        dispatchable: true,
        operations,
        inputSlots: gate.capability.inputSlots.map((slot) => ({
          id: slot.id,
          label: slot.label,
          mediaTypes: [slot.mediaType],
          roles: [...slot.roles],
          operations: [...slot.operations],
          modes: [...new Set([
            ...(compatibilitySlotModes.get(slot.id) || []).filter((mode) => !["video_extension", "video_edit"].includes(mode)),
            ...(slot.operations.includes("extend") && operations.some((operation) => operation.operation === "extend") ? ["video_extension"] : []),
            ...(slot.operations.includes("edit") && operations.some((operation) => operation.operation === "edit") ? ["video_edit"] : []),
          ])],
          min: slot.min,
          max: slot.max,
          allowDuplicateAsset: slot.allowDuplicateAsset,
          supportsTrim: slot.supportsTrim,
        })),
        totalInputLimit: gate.capability.totalInputLimit,
        mediaTypeLimits: { ...gate.capability.mediaTypeLimits },
        supportsGenerateAudio: gate.capability.supportsGenerateAudio,
        supportsPreserveSourceAudio: gate.capability.supportsPreserveSourceAudio,
        supportsMask: gate.capability.supportsMask,
        supportsTimeRange: gate.capability.supportsTimeRange,
        supportsSourceTaskContinuation: gate.capability.supportsSourceTaskContinuation,
        formalPricingReadback,
        ...(capability.id === SEEDANCE_25_MODEL_ID || capability.id === BYTEPLUS_SEEDANCE_25_MODEL_ID && parseObject(route.routeConfig).draftEnabled === true
          ? { draft: { enabled: true, resolution: "480p" as const, finalResolution: "1080p" as const, ttlSeconds: 604800 } }
          : {}),
        ...(capability.id === BYTEPLUS_SEEDANCE_25_MODEL_ID
          ? { outputFormats: ["mp4", "mov"] as Array<"mp4" | "mov">, defaultOutputFormat: "mp4" as const }
          : {}),
        resolutionDeliveries: operations.flatMap((operation) => [
          ...operation.nativeResolutions.map((resolution) => ({
            resolution,
            delivery: "native" as const,
          })),
          ...operation.fulfillmentResolutions.map((resolution) => ({
            resolution,
            delivery: "quality_enhancement" as const,
          })),
        ]).filter((item, index, items) => (
          items.findIndex((candidate) => candidate.resolution === item.resolution) === index
        )),
      },
    };
  }

  const projected = projectWorkbenchVideoCapability(capability);
  const noReferenceOnly = (capability.modes || []).length > 0
    && (capability.modes || []).every((mode) => (
      ["standard", "text_to_video"].includes(mode.trim().toLowerCase())
    ))
    && (capability.inputSlots || []).length === 0;
  if (
    !projected
    && noReferenceOnly
    && capability.duration
    && typeof capability.supportsGenerateAudio === "boolean"
  ) {
    const resolutionDeliveries = (capability.resolutionDeliveries || [])
      .filter((item) => capability.resolutions?.includes(item.resolution));
    return {
      ...capability,
      videoGeneration: {
        version: "workbench-video-generation/v1",
        contractFamily: null,
        dispatchable: capability.canSubmit,
        operations: [{
          operation: "generate",
          enabled: capability.canSubmit,
          modes: [...(capability.modes || [])],
          duration: capability.duration,
          nativeResolutions: resolutionDeliveries
            .filter((item) => item.delivery === "native")
            .map((item) => item.resolution),
          fulfillmentResolutions: resolutionDeliveries
            .filter((item) => item.delivery === "quality_enhancement")
            .map((item) => item.resolution),
        }],
        inputSlots: [],
        totalInputLimit: 0,
        mediaTypeLimits: { image: 0, video: 0, audio: 0 },
        supportsGenerateAudio: capability.supportsGenerateAudio,
        supportsPreserveSourceAudio: false,
        supportsMask: false,
        supportsTimeRange: false,
        supportsSourceTaskContinuation: false,
        resolutionDeliveries,
      },
    };
  }
  if (!projected || !capability.duration || typeof capability.supportsGenerateAudio !== "boolean") {
    return {
      ...capability,
      canSubmit: false,
      unavailableReason: capability.unavailableReason || "视频模型输入槽声明不完整",
      videoGeneration: disabledVideoGenerationDirectory(null),
    };
  }
  const resolutionDeliveries = (capability.resolutionDeliveries || [])
    .filter((item) => capability.resolutions?.includes(item.resolution));
  const operations = Array.from(new Set(projected.modes
    .map(videoOperationForLegacyMode)
    .filter((operation): operation is VideoOperation => operation !== null)))
    .map((operation) => ({
      operation,
      enabled: capability.canSubmit,
      modes: projected.modes.filter((mode) => videoOperationForLegacyMode(mode) === operation),
      duration: capability.duration!,
      nativeResolutions: resolutionDeliveries
        .filter((item) => item.delivery === "native")
        .map((item) => item.resolution),
      fulfillmentResolutions: resolutionDeliveries
        .filter((item) => item.delivery === "quality_enhancement")
        .map((item) => item.resolution),
    }));
  return {
    ...capability,
    videoGeneration: {
      version: "workbench-video-generation/v1",
      contractFamily: null,
      dispatchable: capability.canSubmit,
      operations,
      inputSlots: projected.inputSlots.map((slot) => ({
        id: slot.id,
        label: slot.label,
        mediaTypes: slot.mediaTypes,
        roles: slot.roles,
        operations: Array.from(new Set(slot.modes
          .map(videoOperationForLegacyMode)
          .filter((operation): operation is VideoOperation => operation !== null))),
        modes: [...slot.modes],
        min: slot.min,
        max: slot.max,
        allowDuplicateAsset: slot.allowDuplicateAsset,
        // The legacy provider mapper has no verified trim field. Keep this
        // closed even if an old route config claimed otherwise.
        supportsTrim: false,
      })),
      totalInputLimit: projected.totalInputLimit,
      mediaTypeLimits: projected.mediaTypeLimits,
      supportsGenerateAudio: capability.supportsGenerateAudio,
      supportsPreserveSourceAudio: false,
      supportsMask: false,
      supportsTimeRange: false,
      supportsSourceTaskContinuation: false,
      resolutionDeliveries,
    },
  };
}

/**
 * Shared durable capability parser for operator admission checks. It uses a
 * non-null channel placeholder so transient credentials/health can be proven
 * separately, while preserving the exact route/pricing capability semantics
 * used by the public workbench catalog.
 */
export function buildWorkbenchRouteCapabilityContractForOperator(
  route: Record<string, unknown>,
  pricingRule: Record<string, unknown> | null,
): WorkbenchModelCapability {
  const normalizedRoute = { ...route } as DatabaseRow;
  return attachVideoGenerationDirectory(
    buildRouteCapability(normalizedRoute, {} as DatabaseRow),
    normalizedRoute,
    pricingRule as PricingRule | null,
  );
}

function buildChannelOnlyCapability(channel: DatabaseRow, model: string): WorkbenchModelCapability {
  const endpointType = channel.endpointType as WorkbenchModelEndpointType;
  return {
    id: model,
    model,
    label: model,
    endpointType,
    capabilityStatus: "unverified",
    canSubmit: false,
    unavailableReason: "供应商通道已声明该模型，但尚未配置精确 capability 路由",
    aspectRatios: [],
    ...(endpointType === "image_generation"
      ? {
          qualities: [] as string[],
          maxOutputs: 1,
          inputSlots: [] as Array<Record<string, unknown>>,
        }
      : {
          resolutions: [] as string[],
          modes: [] as string[],
          inputSlots: [] as Array<Record<string, unknown>>,
          resolutionDeliveries: [] as WorkbenchVideoGenerationDirectory["resolutionDeliveries"],
          videoGeneration: disabledVideoGenerationDirectory(null),
        }),
    source: {
      kind: "channel",
    },
  };
}

function stableCapabilityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableCapabilityValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableCapabilityValue(child)]),
  );
}

function routeCapabilitySignature(route: DatabaseRow): string {
  // Use the route's persisted provider identity instead of a provider-less
  // placeholder. This keeps H3's exact provider/native dispatch surface in
  // the fallback signature without coupling it to transient health/secrets.
  const routeProvider = String(route.provider || "").trim();
  const capability = buildRouteCapability(route, {
    provider: routeProvider,
  } as DatabaseRow);
  const seedance25Gate = evaluateSeedance25RouteGate(parseObject(route.routeConfig), String(route.model || ""));
  return JSON.stringify(stableCapabilityValue({
    endpointType: capability.endpointType,
    routeProvider,
    capabilityStatus: capability.capabilityStatus,
    canSubmit: capability.canSubmit,
    qualities: capability.qualities,
    defaultQuality: capability.defaultQuality,
    maxOutputs: capability.maxOutputs,
    resolutions: capability.resolutions,
    defaultResolution: capability.defaultResolution,
    aspectRatios: capability.aspectRatios,
    defaultAspectRatio: capability.defaultAspectRatio,
    duration: capability.duration,
    supportsGenerateAudio: capability.supportsGenerateAudio,
    modes: capability.modes,
    inputSlots: capability.inputSlots,
    seedance25Contract: {
      recognized: seedance25Gate.recognized,
      dispatchable: seedance25Gate.dispatchable,
      capabilityDigest: seedance25Gate.capabilityDigest ?? null,
    },
    // Public resolution labels alone are not proof of equivalent dispatch.
    // Include the exact Relay-native surface so H3 low tiers and all high-tier
    // fallbacks must remain capability-identical.
    relayNativeResolutionContract: relayNativeVideoResolutionContract(route),
  }));
}

function scopeFilter(builder: any, workspaceId: string) {
  builder
    .where((platform: any) => platform.where({ scope: "platform" }).whereNull("workspaceId"))
    .orWhere({ scope: "workspace", workspaceId });
}

/**
 * Groups routes by endpointType:model and picks the effective route the same
 * way the catalog does: workspace-scoped routes shadow platform routes, then
 * the first enabled route wins (ordering by priority/fallback/createTime).
 */
function selectVisibleModelRoutes(
  routes: DatabaseRow[],
  workspaceId: string,
): Map<string, { route: DatabaseRow; enabledRoutes: DatabaseRow[] }> {
  const routeGroups = new Map<string, DatabaseRow[]>();
  for (const route of routes) {
    const model = String(route.model || "").trim();
    if (!model) continue;
    const key = `${route.endpointType}:${model}`;
    const group = routeGroups.get(key) || [];
    group.push(route);
    routeGroups.set(key, group);
  }

  const selectedRoutes = new Map<string, { route: DatabaseRow; enabledRoutes: DatabaseRow[] }>();
  for (const [key, group] of routeGroups) {
    const workspaceRoutes = group.filter((route) => isWorkspaceRow(route, workspaceId));
    const visibleRoutes = workspaceRoutes.length
      ? workspaceRoutes
      : group.filter((route) => String(route.scope || "") === "platform" && route.workspaceId == null);
    const enabledRoutes = visibleRoutes.filter((route) => !isDisabled(route.disabled));
    const selected = enabledRoutes[0] || visibleRoutes[0];
    if (selected) selectedRoutes.set(key, { route: selected, enabledRoutes });
  }
  return selectedRoutes;
}

export async function buildWorkbenchModelCatalog(
  workspaceIdInput: string,
  database?: WorkbenchModelCatalogDatabase,
  options: Readonly<{
    credentialReadMode?: WorkbenchModelCredentialReadMode;
  }> = {},
): Promise<WorkbenchModelCatalog> {
  const workspaceId = String(workspaceIdInput || "default");
  const client = database ?? await applicationDatabase();
  const credentialReadMode = effectiveCredentialReadMode(options.credentialReadMode);
  const [routeRows, channelRows] = await Promise.all([
    client("o_model_route")
      .whereIn("endpointType", ENDPOINT_TYPES)
      .andWhere((builder: any) => scopeFilter(builder, workspaceId)),
    client("o_provider_channel")
      .whereIn("endpointType", ENDPOINT_TYPES)
      .andWhere((builder: any) => scopeFilter(builder, workspaceId)),
  ]);
  const routes = [...routeRows].sort((left, right) => compareScopedRows(left, right, workspaceId));
  const channels = [...channelRows].sort((left, right) => compareScopedRows(left, right, workspaceId));
  const pricingGroup = await resolveWorkspacePricingGroup(client, workspaceId);

  const selectedRoutes = selectVisibleModelRoutes(
    routes.filter((route) => ENDPOINT_TYPES.includes(route.endpointType)),
    workspaceId,
  );

  const entries = new Map<string, WorkbenchModelCapability>();
  const certificationHiddenKeys = new Set<string>();
  for (const [key, { route, enabledRoutes }] of selectedRoutes) {
    const availability = visibleChannelForRoute(
      route,
      channels,
      workspaceId,
      credentialReadMode,
    );
    const adapterReason = availability.channel
      ? providerAdapterUnavailableReason(
          String(route.endpointType || ""),
          String(availability.channel.provider || ""),
        )
      : "";
    const resolvedProvider = firstString(availability.channel?.provider, route.provider);
    const pricingAdmission = resolvedProvider
      ? await resolveProviderPricingAdmission({
          database: client,
          workspaceId,
          pricingGroup,
          endpointType: String(route.endpointType || ""),
          provider: resolvedProvider,
          model: String(route.model || ""),
        })
      : { rule: null, baseRule: null, reason: "模型供应商通道缺少明确 provider", hiddenByAudience: false };
    if (pricingAdmission.hiddenByAudience) continue;
    const logicalPricingAdmission = pricingAdmission.baseRule
      ? await explainLogicalModelPriceAdmission(client, route, pricingAdmission.baseRule)
      : { valid: true, reason: "", canonicalPrice: null };
    const pricingReason = availability.channel && !adapterReason
      ? pricingAdmission.reason || logicalPricingAdmission.reason
      : "";
    const certification = await evaluateModelRouteCertification({
      database: client,
      route,
      pricingRule: pricingAdmission.baseRule,
    });
    const localDevelopmentBypass = isLocalDevelopmentUncertifiedModelRouteAllowed({
      database: client,
      route,
    });
    const retainUnavailableUncertifiedModel = [
      "doubao-seedance-2-0-260128",
    ].includes(String(route.model || "").trim());
    if (
      certification.hiddenFromUserCatalog
      && !localDevelopmentBypass
      && !retainUnavailableUncertifiedModel
    ) {
      certificationHiddenKeys.add(key);
      continue;
    }
    const resolvedCapability = await filterUnavailableHighVideoResolutions({
      database: client,
      workspaceId,
      route,
      generationChannel: availability.channel,
      capability: buildRouteCapability(route, availability.channel, availability.reason,
        enabledRoutes.length === 1 ? pricingAdmission.baseRule : null),
    });
    const certifiedCapability = localDevelopmentBypass
      ? resolvedCapability
      : stripUncertifiedHighTiers(resolvedCapability, certification, route);
    const certificationReason = retainUnavailableUncertifiedModel
      && certification.hiddenFromUserCatalog
      && !localDevelopmentBypass
      ? certification.reason || "模型路由尚未完成真实任务与结算认证"
      : "";
    const admissionReason = adapterReason || pricingReason || certificationReason;
    const capability = admissionReason
      ? {
          ...certifiedCapability,
          capabilityStatus: "unavailable" as const,
          canSubmit: false,
          unavailableReason: admissionReason,
        }
      : certifiedCapability;
    const fallbackSignatures = new Set(enabledRoutes.map(routeCapabilitySignature));
    if (fallbackSignatures.size > 1) {
      entries.set(key, attachVideoGenerationDirectory({
        ...capability,
        capabilityStatus: "unavailable",
        canSubmit: false,
        unavailableReason: "同一模型的 fallback 路由 capability 不一致",
      }, route, pricingAdmission.baseRule));
      continue;
    }
    entries.set(key, attachVideoGenerationDirectory(capability, route, pricingAdmission.baseRule));
  }

  // Supplier-advertised models are inventory, not user products. They remain
  // available in the FJAdmin model pool and enter the workbench only after an
  // explicit logical route (with capability, price and certification) exists.

  const models = Array.from(entries.values());
  return {
    catalogVersion: CATALOG_VERSION,
    models,
    imageModels: models.filter((model) => model.endpointType === "image_generation"),
    videoModels: models.filter((model) => model.endpointType === "video_generation"),
  };
}

export async function resolveWorkbenchModelCapability(input: {
  workspaceId: string;
  endpointType: WorkbenchModelEndpointType;
  model?: string | null;
  database?: WorkbenchModelCatalogDatabase;
}): Promise<WorkbenchModelCapability | null> {
  const catalog = await buildWorkbenchModelCatalog(input.workspaceId, input.database);
  const models = input.endpointType === "image_generation" ? catalog.imageModels : catalog.videoModels;
  const requestedModel = internalModelId(String(input.model || "").trim());
  if (requestedModel) {
    return models.find((model) => model.id === requestedModel || model.aliases?.includes(requestedModel)) || null;
  }
  return models.find((model) => model.canSubmit) || null;
}

export interface WorkbenchRouteModelSummary {
  /** 模型 id(= o_model_route.model),平台默认模型配置引用它。 */
  id: string;
  model: string;
  endpointType: string;
  /** 生效路由行 id(scope 遮蔽与启用态判定后的选中路由)。 */
  routeId: string;
  /** 后台路由映射名(o_model_route.name)。 */
  name: string;
  /** 用户可见映射名列;为空时调用方回退 name。 */
  displayName: string | null;
  /** 路由最终提交给上游的模型名;仅暴露模型标识,不包含通道或凭据信息。 */
  resolvedModel: string;
  /** 超分组合映射名(routeConfig.enhanceDisplayName)。 */
  enhanceDisplayName: string | null;
  /** 路由声明的 capability 验证状态；只有 verified 才能进入可提交判定。 */
  capabilityStatus: WorkbenchCapabilityStatus;
  /** 生效路由为 verified、存在健康凭据通道且具备 provider-specific 正 GU 定价时才可提交。 */
  canSubmit: boolean;
  unavailableReason?: string;
  /** routeConfig.capabilities 原样透传(文本/音频等通用类型的参数契约)。 */
  capabilities: Record<string, unknown>;
}

export interface WorkbenchConfiguredModelSummary {
  /** FJAdmin 对外配置的模型 id:来自路由 model 或通道 modelNames。 */
  id: string;
  model: string;
  endpointType: string;
  routeId: string | null;
  channelId: string;
  name: string;
  displayName: string | null;
  /** 按实际生效通道的 modelMapping 解析出的上游模型名。 */
  resolvedModel: string;
  canSubmit: boolean;
  unavailableReason?: string;
  capabilities: Record<string, unknown>;
  source: "route";
}

function mappedChannelModel(channel: DatabaseRow, model: string): string {
  const config = parseProviderChannelConfig(channel.configJson);
  const mapping = record(config.modelMapping);
  return firstString(mapping[model]) || model;
}

/**
 * Returns the final route-backed model inventory for user-facing workbench
 * consumers. Provider channel modelNames belong to the model pool only and
 * never become user selectable until a complete model route is published.
 */
export async function listWorkbenchConfiguredModels(input: {
  workspaceId: string;
  endpointTypes: string[];
  database?: WorkbenchModelCatalogDatabase;
  credentialReadMode?: WorkbenchModelCredentialReadMode;
}): Promise<WorkbenchConfiguredModelSummary[]> {
  const workspaceId = String(input.workspaceId || "default");
  const endpointTypes = Array.from(new Set(input.endpointTypes.map((type) => String(type || "").trim()).filter(Boolean)));
  if (!endpointTypes.length) return [];
  const database = input.database ?? await applicationDatabase();
  const credentialReadMode = effectiveCredentialReadMode(input.credentialReadMode);
  const [routeRows, channelRows] = await Promise.all([
    database("o_model_route")
      .whereIn("endpointType", endpointTypes)
      .andWhere((builder: any) => scopeFilter(builder, workspaceId)),
    database("o_provider_channel")
      .whereIn("endpointType", endpointTypes)
      .andWhere((builder: any) => scopeFilter(builder, workspaceId)),
  ]);
  const routes = [...routeRows].sort((left, right) => compareScopedRows(left, right, workspaceId));
  const channels = [...channelRows].sort((left, right) => compareScopedRows(left, right, workspaceId));
  const selectedRoutes = selectVisibleModelRoutes(routes, workspaceId);
  const entries = new Map<string, WorkbenchConfiguredModelSummary>();

  // A route group owns its endpoint/model key even when disabled or
  // unavailable. That is the same closed-policy behavior used by the relay:
  // an intentional FJAdmin override must never reopen through modelNames.
  for (const [key, { route }] of selectedRoutes) {
    const model = String(route.model || "").trim();
    if (!model) continue;
    const config = parseObject(route.routeConfig);
    const availability = visibleChannelForRoute(route, channels, workspaceId, credentialReadMode);
    const channel = availability.channel;
    entries.set(key, {
      id: model,
      model,
      endpointType: String(route.endpointType || ""),
      routeId: String(route.id || "") || null,
      channelId: String(channel?.id || ""),
      name: firstString(route.name) || model,
      displayName: firstString(route.displayName) || null,
      resolvedModel: channel ? mappedChannelModel(channel, model) : model,
      canSubmit: Boolean(channel),
      ...(availability.reason ? { unavailableReason: availability.reason } : {}),
      capabilities: record(config.capabilities),
      source: "route",
    });
  }

  return Array.from(entries.values());
}

/**
 * image/video 之外的通用模型目录(text、tts 等):沿用相同的 scope
 * 遮蔽规则，并在输出 canSubmit 前验证管理员通道开关、凭据配置和
 * provider-specific 正 GU 定价。瞬时健康观测只影响路由降级与告警，不关闭模型目录。
 */
export async function listWorkbenchRouteModels(input: {
  workspaceId: string;
  endpointTypes: string[];
  database?: WorkbenchModelCatalogDatabase;
  credentialReadMode?: WorkbenchModelCredentialReadMode;
}): Promise<WorkbenchRouteModelSummary[]> {
  const workspaceId = String(input.workspaceId || "default");
  const endpointTypes = Array.from(new Set(input.endpointTypes.map((type) => String(type || "").trim()).filter(Boolean)));
  if (!endpointTypes.length) return [];
  const database = input.database ?? await applicationDatabase();
  const [routeRows, channelRows] = await Promise.all([
    database("o_model_route")
      .whereIn("endpointType", endpointTypes)
      .andWhere((builder: any) => scopeFilter(builder, workspaceId)),
    database("o_provider_channel")
      .whereIn("endpointType", endpointTypes)
      .andWhere((builder: any) => scopeFilter(builder, workspaceId)),
  ]);
  const routes = [...routeRows].sort((left, right) => compareScopedRows(left, right, workspaceId));
  const channels = [...channelRows].sort((left, right) => compareScopedRows(left, right, workspaceId));
  const selected = selectVisibleModelRoutes(routes, workspaceId);
  const pricingGroup = await resolveWorkspacePricingGroup(database, workspaceId);

  const summaries = await Promise.all(Array.from(selected.values()).map(async ({ route }) => {
    const config = parseObject(route.routeConfig);
    const capabilities = record(config.capabilities);
    const capabilityStatus = normalizeStatus(firstString(
      config.capabilityStatus,
      capabilities.status,
      config.status,
    ));
    const model = String(route.model || "").trim();
    const endpointType = String(route.endpointType || "");
    const availability = visibleChannelForRoute(
      route,
      channels,
      workspaceId,
      effectiveCredentialReadMode(input.credentialReadMode),
    );
    const adapterReason = availability.channel
      ? providerAdapterUnavailableReason(
          endpointType,
          String(availability.channel.provider || ""),
        )
      : "";
    const resolvedProvider = firstString(availability.channel?.provider, route.provider);
    const pricingAdmission = resolvedProvider
      ? await resolveProviderPricingAdmission({
          database,
          workspaceId,
          pricingGroup,
          endpointType,
          provider: resolvedProvider,
          model,
        })
      : { rule: null, baseRule: null, reason: "模型供应商通道缺少明确 provider", hiddenByAudience: false };
    if (pricingAdmission.hiddenByAudience) return null;
    const logicalPricingAdmission = pricingAdmission.baseRule
      ? await explainLogicalModelPriceAdmission(database, route, pricingAdmission.baseRule)
      : { valid: true, reason: "", canonicalPrice: null };
    const certification = await evaluateModelRouteCertification({
      database,
      route,
      pricingRule: pricingAdmission.baseRule,
    });
    const localDevelopmentBypass = isLocalDevelopmentUncertifiedModelRouteAllowed({
      database,
      route,
    });
    if (certification.hiddenFromUserCatalog && !localDevelopmentBypass) return null;
    const pricingReason = availability.channel && !adapterReason
      ? pricingAdmission.reason || logicalPricingAdmission.reason
      : "";
    const capabilityReason = SUBMITTABLE_STATUSES.has(capabilityStatus)
      ? ""
      : "模型能力状态未经验证";
    const unavailableReason = availability.reason
      || adapterReason
      || capabilityReason
      || pricingReason;
    const canSubmit = Boolean(
      !isDisabled(route.disabled)
      && availability.channel
      && SUBMITTABLE_STATUSES.has(capabilityStatus)
      && !unavailableReason,
    );
    const effectiveCapabilityStatus = availability.reason || adapterReason || pricingReason
      ? "unavailable"
      : capabilityStatus;
    return {
      id: model,
      model,
      endpointType,
      routeId: String(route.id || ""),
      name: firstString(route.name) || model,
      displayName: firstString(route.displayName) || null,
      resolvedModel: firstString(config.upstreamModel) || model,
      enhanceDisplayName: firstString(config.enhanceDisplayName) || null,
      capabilityStatus: effectiveCapabilityStatus,
      canSubmit,
      ...(unavailableReason ? { unavailableReason } : {}),
      capabilities,
    };
  }));
  return summaries.filter((summary): summary is WorkbenchRouteModelSummary => summary !== null);
}

function readinessPass(reason?: string): WorkbenchModelRouteReadinessCheck {
  return { status: "pass", ...(reason ? { reason } : {}) };
}

function readinessFail(reason: string): WorkbenchModelRouteReadinessCheck {
  return { status: "fail", reason };
}

function readinessNotChecked(reason: string): WorkbenchModelRouteReadinessCheck {
  return { status: "not_checked", reason };
}

/**
 * Whether durable administrator configuration admits a route into a
 * selectable catalog. Cached health is deliberately excluded: it remains a
 * production-readiness signal and runtime routing input, never a persistent
 * service switch.
 */
export function isWorkbenchModelRouteConfiguredForCatalog(
  readiness: WorkbenchModelRouteReadiness,
): boolean {
  const { health: _health, ...configurationChecks } = readiness.checks;
  return readiness.selectedForCatalog
    && (readiness.canSubmit
      || Object.values(configurationChecks).every((check) => check.status === "pass"));
}

/**
 * Explain whether one persisted or in-memory route would be admitted by the
 * user-facing model catalog. This is deliberately read-only: callers may pass
 * an unsaved draft and receive the projected selection/readiness result
 * without writing route, channel, pricing, health or recipe state.
 */
export async function explainWorkbenchModelRouteReadiness(input: {
  route: Record<string, unknown>;
  workspaceId?: string | null;
  database?: WorkbenchModelCatalogDatabase;
  credentialReadMode?: WorkbenchModelCredentialReadMode;
}): Promise<WorkbenchModelRouteReadiness> {
  const database = input.database ?? await applicationDatabase();
  const route = { ...input.route } as DatabaseRow;
  const routeId = firstString(route.id) || null;
  const routeWorkspaceId = String(route.scope || "") === "workspace"
    ? firstString(route.workspaceId)
    : "";
  const evaluatedWorkspaceId = routeWorkspaceId
    || firstString(input.workspaceId)
    || "default";
  const endpointType = firstString(route.endpointType);
  const model = firstString(route.model);
  const credentialReadMode = effectiveCredentialReadMode(input.credentialReadMode);

  const [channelRows, matchingRouteRows, existingRoute] = await Promise.all([
    endpointType
      ? database("o_provider_channel")
          .where({ endpointType })
          .andWhere((builder: any) => scopeFilter(builder, evaluatedWorkspaceId))
      : Promise.resolve([]),
    endpointType && model
      ? database("o_model_route")
          .where({ endpointType, model })
          .andWhere((builder: any) => scopeFilter(builder, evaluatedWorkspaceId))
      : Promise.resolve([]),
    routeId
      ? database("o_model_route").where({ id: routeId }).first()
      : Promise.resolve(null),
  ]);
  const channels = [...channelRows].sort((left, right) => (
    compareScopedRows(left, right, evaluatedWorkspaceId)
  ));
  const candidateSelection = channelCandidatesForRoute(route, channels, evaluatedWorkspaceId);
  const candidateStates = candidateSelection.candidates.map((channel) => {
    const channelReason = (isDisabled(channel.disabled) ? "模型绑定的供应商通道已禁用" : "")
      || channelConnectionUnavailableReason(channel);
    const healthReason = channelHealthUnavailableReason(channel);
    const credentialReason = channelCredentialUnavailableReason(channel, credentialReadMode);
    return {
      channel,
      channelReason,
      healthReason,
      credentialReason,
      ready: !channelReason && !healthReason && !credentialReason,
    };
  });
  const selectedChannelState = candidateStates.find((state) => state.ready)
    || candidateStates[0]
    || null;
  const selectedChannel = selectedChannelState?.channel || null;
  const resolvedProvider = firstString(selectedChannel?.provider, route.provider) || null;

  const routeCheck = isDisabled(route.disabled)
    ? readinessFail("模型路由已停用")
    : readinessPass();
  const channelCheck = selectedChannelState
    ? selectedChannelState.channelReason
      ? readinessFail(selectedChannelState.channelReason)
      : readinessPass()
    : readinessFail(candidateSelection.reason || "没有匹配的供应商通道");
  const healthCheck = selectedChannelState
    ? selectedChannelState.healthReason
      ? readinessFail(selectedChannelState.healthReason)
      : readinessPass()
    : readinessNotChecked("未解析到可检查的供应商通道");
  const credentialCheck = selectedChannelState
    ? selectedChannelState.credentialReason
      ? readinessFail(selectedChannelState.credentialReason)
      : readinessPass()
    : readinessNotChecked("未解析到可检查的供应商通道");
  const adapterReason = resolvedProvider
    ? providerAdapterUnavailableReason(endpointType, resolvedProvider)
    : "";
  const adapterCheck = !resolvedProvider
    ? readinessNotChecked("未解析到 provider")
    : adapterReason
      ? readinessFail(adapterReason)
      : readinessPass();
  const pricingAdmission = resolvedProvider && endpointType && model
    ? await resolveProviderPricingAdmission({
        database,
        workspaceId: evaluatedWorkspaceId,
        endpointType,
        provider: resolvedProvider,
        model,
      })
    : { rule: null, baseRule: null, reason: "", hiddenByAudience: false };
  const logicalPricingAdmission = pricingAdmission.baseRule
    ? await explainLogicalModelPriceAdmission(database, route, pricingAdmission.baseRule)
    : { valid: true, reason: "", canonicalPrice: null };
  const pricingReason = pricingAdmission.reason || logicalPricingAdmission.reason;
  const pricingCheck = !resolvedProvider || !endpointType || !model
    ? readinessNotChecked("缺少 provider、能力类型或模型 ID，无法校验定价")
    : pricingReason
      ? readinessFail(pricingReason)
      : readinessPass();
  const certification = await evaluateModelRouteCertification({
    database,
    route: { ...(existingRoute || {}), ...route },
    pricingRule: pricingAdmission.baseRule,
  });
  const localDevelopmentBypass = Boolean(
    routeId
    && existingRoute
    && isLocalDevelopmentUncertifiedModelRouteAllowed({
      database,
      route: { ...existingRoute, ...route },
    }),
  );
  const certificationCheck = !routeId
    ? readinessFail("路由尚未保存，无法绑定真实任务与结算认证")
    : localDevelopmentBypass
      ? readinessNotChecked("本地开发显式旁路；尚未通过生产模型路由认证")
    : certification.valid
      ? readinessPass("上游刊例价、真实成功任务与 charged usage 认证有效")
      : readinessFail(certification.reason || "模型路由认证未通过");
  const deliveryProofs = certification.operations
    .filter((operation) => operation.valid && operation.deliveryProof)
    .map((operation) => operation.deliveryProof!);

  let capabilityStatus = normalizeStatus(firstString(
    parseObject(route.routeConfig).capabilityStatus,
    record(parseObject(route.routeConfig).capabilities).status,
    parseObject(route.routeConfig).status,
  ));
  let capabilityReason = "";
  if (ENDPOINT_TYPES.includes(endpointType as WorkbenchModelEndpointType)) {
    const capability = await filterUnavailableHighVideoResolutions({
      database,
      workspaceId: evaluatedWorkspaceId,
      route,
      generationChannel: selectedChannelState?.ready ? selectedChannel : null,
      // A non-null placeholder isolates the route's own capability contract
      // from transient channel state; channel checks are reported separately.
      capability: buildRouteCapability(route, {} as DatabaseRow),
    });
    capabilityStatus = capability.capabilityStatus;
    if (!capability.canSubmit) capabilityReason = capability.unavailableReason || "模型 capability 不完整";
  } else if (!SUBMITTABLE_STATUSES.has(capabilityStatus)) {
    capabilityReason = "模型能力状态未经验证";
  }
  const capabilityCheck = capabilityReason
    ? readinessFail(capabilityReason)
    : readinessPass();

  const previewId = routeId || `__model-route-preflight-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectedRoute: DatabaseRow = {
    ...(existingRoute || {}),
    ...route,
    id: previewId,
    createTime: finite(route.createTime) ?? finite(existingRoute?.createTime) ?? Date.now(),
  };
  const projectedRoutes = [...matchingRouteRows]
    .filter((row) => !routeId || String(row.id || "") !== routeId)
    .concat(projectedRoute)
    .sort((left, right) => compareScopedRows(left, right, evaluatedWorkspaceId));
  const selected = selectVisibleModelRoutes(projectedRoutes, evaluatedWorkspaceId)
    .get(`${endpointType}:${model}`);
  const selectedForCatalog = String(selected?.route?.id || "") === previewId;
  const effectiveRouteId = selectedForCatalog && !routeId
    ? null
    : firstString(selected?.route?.id) || null;
  const fallbackMismatch = Boolean(
    ENDPOINT_TYPES.includes(endpointType as WorkbenchModelEndpointType)
    && selected
    && new Set(selected.enabledRoutes.map(routeCapabilitySignature)).size > 1,
  );
  const catalogCheck = fallbackMismatch
    ? readinessFail("同一模型的 fallback 路由 capability 不一致")
    : readinessPass();

  const checks = {
    route: routeCheck,
    channel: channelCheck,
    health: healthCheck,
    credential: credentialCheck,
    adapter: adapterCheck,
    pricing: pricingCheck,
    certification: certificationCheck,
    capability: capabilityCheck,
    catalog: catalogCheck,
  };
  const requiredChecks = Object.values(checks);
  const productionReady = requiredChecks.every((check) => check.status === "pass");
  const localCatalogReady = localDevelopmentBypass && Object.entries(checks).every(([name, check]) => (
    name === "health" || name === "certification" || check.status === "pass"
  ));
  const canSubmit = Boolean(selectedForCatalog && (productionReady || localCatalogReady));
  const reasons = Array.from(new Set(
    requiredChecks
      .filter((check) => check.status === "fail")
      .map((check) => check.reason || "")
      .filter(Boolean),
  ));
  const selectionReason = isDisabled(route.disabled)
    ? "路由处于停用状态，不进入用户模型目录"
    : !selectedForCatalog && effectiveRouteId
      ? `当前工作区优先命中路由 ${effectiveRouteId}（范围遮蔽或优先级更高）`
      : !selectedForCatalog
        ? "该路由不会成为当前工作区的目录生效路由"
        : undefined;

  return {
    readinessVersion: "workbench-model-route-readiness/v1",
    routeId,
    evaluatedWorkspaceId,
    effectiveRouteId,
    selectedForCatalog,
    productionReady,
    canSubmit,
    capabilityStatus,
    resolvedChannelId: firstString(selectedChannel?.id) || null,
    resolvedProvider,
    ...(selectionReason ? { selectionReason } : {}),
    checks,
    deliveryProofs,
    reasons,
  };
}

export interface ManagedLogicalModelPublicationReadiness {
  managed: boolean;
  ready: boolean;
  degraded: boolean;
  reasons: string[];
  routeIds: string[];
}

/**
 * Unified user-surface admission for V2 logical model groups. Every enabled
 * physical target must pass durable routing, credential, pricing, capability
 * and certification checks; transient health may degrade the group as long
 * as at least one target remains healthy. Legacy 0.1.1 routes are deliberately
 * left to their existing catalog contracts.
 */
export async function explainManagedLogicalModelPublication(input: {
  workspaceId: string;
  endpointType: string;
  model: string;
  database?: WorkbenchModelCatalogDatabase;
}): Promise<ManagedLogicalModelPublicationReadiness> {
  const database = input.database ?? await applicationDatabase();
  const workspaceId = String(input.workspaceId || "default");
  const rows = await database("o_model_route")
    .where({ endpointType: input.endpointType, model: internalModelId(input.model) })
    .andWhere((builder: any) => scopeFilter(builder, workspaceId));
  const sortedRows = [...rows].sort((left, right) => compareScopedRows(left, right, workspaceId));
  const workspaceRows = sortedRows.filter((route) => isWorkspaceRow(route, workspaceId));
  const preferred = workspaceRows.length
    ? workspaceRows
    : sortedRows.filter((route) => String(route.scope || "") === "platform" && route.workspaceId == null);
  const enabled = preferred.filter((route) => !isDisabled(route.disabled));
  const managed = enabled.filter(isManagedModelRoute);
  if (!managed.length) {
    return { managed: false, ready: true, degraded: false, reasons: [], routeIds: [] };
  }
  if (managed.length !== enabled.length) {
    return {
      managed: true,
      ready: false,
      degraded: false,
      reasons: ["同一逻辑模型混用了 V2 托管路由和旧物理路由"],
      routeIds: enabled.map((route) => String(route.id || "")).filter(Boolean),
    };
  }
  const readiness = await Promise.all(managed.map((route) => (
    explainWorkbenchModelRouteReadiness({ route, workspaceId, database })
  )));
  const durableFailures = readiness.flatMap((result) => (
    Object.entries(result.checks)
      .filter(([key, check]) => key !== "health" && check.status !== "pass")
      .map(([, check]) => check.reason || "逻辑模型发布门禁未通过")
  ));
  const healthyTargets = readiness.filter((result) => result.checks.health.status === "pass").length;
  const healthReasons = readiness
    .filter((result) => result.checks.health.status === "fail")
    .map((result) => result.checks.health.reason || "上游目标健康检查失败");
  const reasons = Array.from(new Set([
    ...durableFailures,
    ...(healthyTargets ? [] : healthReasons.length ? healthReasons : ["没有健康的上游目标"]),
  ]));
  return {
    managed: true,
    ready: durableFailures.length === 0 && healthyTargets > 0,
    degraded: durableFailures.length === 0 && healthyTargets > 0 && healthyTargets < readiness.length,
    reasons,
    routeIds: managed.map((route) => String(route.id || "")).filter(Boolean),
  };
}
