import crypto from "node:crypto";
import type { Knex } from "knex";
import { isPostgresClient } from "@/lib/dbDialect";
import { readProviderChannelCredentialCiphertext } from "@/lib/providerChannelCredentials";
import {
  assertSeedance25CertificationProbePermit,
  assertSeedance25PricingRuleReadback,
  buildSeedance25LaunchRouteConfig,
  buildSeedance25TokenPricingRuleConfig,
  SEEDANCE_25_MODEL_ID,
  SEEDANCE_25_CERTIFICATION_PROBE_MAX_VALIDITY_MS,
  SEEDANCE_25_CERTIFICATION_PROBE_PROMPT,
  SEEDANCE_25_CERTIFICATION_PROBE_PROMPT_DIGEST,
  seedance25CertificationProbeScopedRequestId,
  SEEDANCE_25_CERTIFICATION_PROBE_VERSION,
  SEEDANCE_25_PRICING_REVISION,
  SEEDANCE_25_PRICING_CONTRACT,
  SEEDANCE_25_TOKEN_PRICES,
  SEEDANCE_25_UPSTREAM_TOKEN_PRICES,
  type Seedance25CertificationProbePermit,
  verifiedSeedance25Capability,
} from "@/lib/seedance25Adapter";
import {
  evaluateModelRouteCertification,
  MODEL_ROUTE_BASE_OPERATION,
  MODEL_ROUTE_CERTIFICATION_MAX_VALIDITY_MS,
} from "@/lib/modelRouteCertification";
import {
  executeModelRouteCertificationBatch,
  MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
  type ModelRouteCertificationBatchReceipt,
} from "@/lib/modelRouteCertificationBatch";
import { acquireModelRouteCertificationAdvisoryFence } from "@/lib/modelRouteCertificationMutationFence";
import {
  MODEL_ROUTE_CERTIFICATION_BATCH_TABLE,
  MODEL_ROUTE_CERTIFICATION_TABLE,
} from "@/lib/migrations/modelRouteCertification";
import {
  canonicalVideoGenerationRequest,
  evaluateSeedance25RouteGate,
  VIDEO_GENERATION_REQUEST_VERSION,
  videoGenerationRequestDigest,
} from "@/lib/videoGenerationContract";

export const SEEDANCE_25_PRODUCTION_ROUTE_ID = "fanjin-seedance-2-5-production-route";
export const SEEDANCE_25_PRODUCTION_PRICING_RULE_ID = "fanjin-seedance-2-5-token-pricing";
export const SEEDANCE_25_PRODUCTION_STAGING_VERSION =
  "fanjin-seedance-2.5-production-staging/v1" as const;
export const SEEDANCE_25_PRODUCTION_OPERATOR = "seedance25-production-operator" as const;
export const SEEDANCE_25_CERTIFICATION_ARM_SNAPSHOT_VERSION =
  "seedance-2.5-certification-arm-snapshot/v1" as const;
export const SEEDANCE_25_CERTIFICATION_PRICING_BINDING_VERSION =
  "seedance-2.5-certification-pricing-binding/v1" as const;
export const SEEDANCE_25_CERTIFICATION_ACTIVATION_GATE =
  "model_route_certification" as const;

export {
  SEEDANCE_25_CERTIFICATION_PROBE_MAX_VALIDITY_MS,
  SEEDANCE_25_CERTIFICATION_PROBE_PROMPT,
  SEEDANCE_25_CERTIFICATION_PROBE_PROMPT_DIGEST,
  SEEDANCE_25_CERTIFICATION_PROBE_VERSION,
} from "@/lib/seedance25Adapter";
export type { Seedance25CertificationProbePermit } from "@/lib/seedance25Adapter";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const ALLOWED_CHANNEL_BASE_PATHS = new Set(["", "/", "/api/v3", "/api/v3/"]);
const PLATFORM_ADMIN_ROLES = new Set(["root", "admin", "super_admin"]);
const OFFICIAL_VOLCANO_PRICE_HOSTS = new Set(["volcengine.com", "www.volcengine.com"]);

type DatabaseRow = Record<string, any>;

export interface Seedance25ProductionStagingInput {
  channelId: string;
  accountModelCatalogEvidenceSha256: string;
  providerAccountFingerprint: string;
  accountModelCatalogVerifiedAt: string;
  reservationUpperBoundTokens: number;
  changeId: string;
  routeName?: string;
  pricingName?: string;
  now?: number;
}

export interface Seedance25FirstCertificationBlocker {
  status: "blocked";
  code: "seedance25_first_certification_requires_isolated_probe_boundary";
  reason: string;
  invariants: string[];
}

export interface Seedance25ProductionStagingInspection {
  version: typeof SEEDANCE_25_PRODUCTION_STAGING_VERSION;
  valid: boolean;
  reason: string | null;
  state: "staged";
  routeId: string | null;
  pricingRuleId: string | null;
  channelId: string | null;
  routeConfigSha256: string | null;
  pricingRuleConfigSha256: string | null;
  accountModelCatalogEvidenceSha256: string | null;
  reservationUpperBoundTokens: number | null;
  productionTrafficEnabled: false;
  firstCertification: Seedance25FirstCertificationBlocker;
}

export interface Seedance25ProductionStagingReceipt extends Seedance25ProductionStagingInspection {
  mode: "validate" | "apply";
  changeId: string;
  routeAction: "create" | "update";
  pricingAction: "create" | "update";
  completedAt: number;
}

export interface Seedance25CertificationProbeArmInput {
  probeId: string;
  workspaceId: string;
  projectId: string | number;
  adminUserId: string | number;
  createdAt: string;
  expiresAt: string;
  replacesExpiredProbeId?: string;
  recoveryTaskId?: string;
  recoveryAcknowledgement?: string;
  now?: number;
}

export interface Seedance25CertificationProbeArmReceipt {
  version: "seedance-2.5-certification-arm/v1";
  mode: "validate" | "apply";
  action: "arm" | "resume" | "rearm";
  valid: true;
  permit: Seedance25CertificationProbePermit;
  activationGate: typeof SEEDANCE_25_CERTIFICATION_ACTIVATION_GATE;
  routeConfigSha256: string;
  pricingRuleConfigSha256: string;
  certificationSnapshotSha256: string;
  routeAndPricingEnabled: boolean;
  productionTrafficEnabled: false;
  completedAt: number;
}

export interface Seedance25CertificationEvidenceInput {
  probeId: string;
  taskId: string;
  adminUserId: string | number;
  priceSourceUrl: string;
  priceSourceContentSha256: string;
  priceCheckedAt: string;
  upstreamCurrency: string;
  upstreamUnitPriceMicros: number;
  billingCurrency: string;
  billingDimension: string;
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  validUntil: string;
  now?: number;
}

export interface Seedance25CertificationReceipt {
  version: "seedance-2.5-certification/v1";
  probeId: string;
  taskId: string;
  usageEvidenceId: string;
  completionTokens: number;
  chargedCostMicros: number;
  artifactSha256: string;
  certification: ModelRouteCertificationBatchReceipt;
  routeCertificationValid: true;
  completedAt: number;
}

export interface Seedance25CertificationProbeTask {
  id: string;
  workspaceId: string | null;
  projectId: number | null;
  requestId: string | null;
  endpointType: string;
  provider: string | null;
  channelId: string | null;
  model: string | null;
  status: string;
  requestPayload: Record<string, unknown>;
  providerPayload: Record<string, unknown>;
  providerTaskId: string | null;
  resultPayload: Record<string, unknown>;
  errorMessage: string | null;
  createTime: number;
  updateTime: number;
  submittedAt: number | null;
  completedAt: number | null;
}

export interface Seedance25CertificationProbeRuntime {
  create(probeId: string): Promise<Seedance25CertificationProbeTask>;
  get(taskId: string): Promise<Seedance25CertificationProbeTask | null>;
  refresh(
    task: Seedance25CertificationProbeTask,
    options?: { providerReadOnly?: boolean },
  ): Promise<Seedance25CertificationProbeTask>;
  cancel?(taskId: string): Promise<{
    task: Seedance25CertificationProbeTask | null;
    deleted: boolean;
    cancelled: boolean;
  }>;
  sleep?(milliseconds: number): Promise<void>;
  now?(): number;
}

export interface Seedance25CertificationOperatorInput {
  database: Knex;
  arm: Seedance25CertificationProbeArmInput;
  certification: Omit<Seedance25CertificationEvidenceInput, "taskId">;
  runtime: Seedance25CertificationProbeRuntime;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface Seedance25CertificationOperatorPlanReceipt {
  version: "seedance-2.5-certification-operator-plan/v1";
  mode: "validate";
  valid: true;
  arm: Seedance25CertificationProbeArmReceipt;
  priceSourceUrl: string;
  priceSourceContentSha256: string;
  priceCheckedAt: number;
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  validUntil: number;
  recoveryCancellationTaskId: string | null;
  productionTrafficEnabled: false;
  completedAt: number;
}

export interface Seedance25CertificationOperatorReceipt {
  version: "seedance-2.5-certification-operator/v1";
  probeId: string;
  state: "certified" | "pending" | "failed" | "pending_reconcile";
  arm: Seedance25CertificationProbeArmReceipt;
  task: {
    id: string;
    status: string;
    providerTaskId: string | null;
    completedAt: number | null;
  };
  certification: Seedance25CertificationReceipt | null;
  reason: string | null;
  completedAt: number;
}

export class Seedance25ProductionConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "Seedance25ProductionConfigError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new Seedance25ProductionConfigError(code, message);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
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

function stringArray(value: unknown): string[] {
  const candidate = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value);
        } catch {
          return [];
        }
      })()
    : value;
  if (!Array.isArray(candidate)) return [];
  return candidate.map(text).filter(Boolean);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(record(left)) === stableJson(record(right));
}

function normalizeInput(input: Seedance25ProductionStagingInput): Required<Seedance25ProductionStagingInput> {
  const now = input.now ?? Date.now();
  const normalized = {
    channelId: text(input.channelId),
    accountModelCatalogEvidenceSha256: text(input.accountModelCatalogEvidenceSha256).toLowerCase(),
    providerAccountFingerprint: text(input.providerAccountFingerprint).toLowerCase(),
    accountModelCatalogVerifiedAt: text(input.accountModelCatalogVerifiedAt),
    reservationUpperBoundTokens: Number(input.reservationUpperBoundTokens),
    changeId: text(input.changeId),
    routeName: text(input.routeName) || "Seedance 2.5 Staged Production",
    pricingName: text(input.pricingName) || "Seedance 2.5 官方刊例价（按分辨率及视频输入计费）",
    now,
  };
  if (!SAFE_ID.test(normalized.channelId)) fail("seedance25_channel_id_invalid", "Seedance 2.5 channelId 格式无效");
  if (!SAFE_ID.test(normalized.changeId)) fail("seedance25_change_id_invalid", "Seedance 2.5 changeId 格式无效");
  if (!SHA256.test(normalized.accountModelCatalogEvidenceSha256)) {
    fail("seedance25_account_catalog_sha256_invalid", "账号模型目录证据必须是小写 SHA-256");
  }
  if (!SHA256.test(normalized.providerAccountFingerprint)) {
    fail("seedance25_account_fingerprint_invalid", "供应商账号指纹必须是小写 SHA-256");
  }
  const verifiedAt = Date.parse(normalized.accountModelCatalogVerifiedAt);
  if (!Number.isFinite(verifiedAt) || verifiedAt <= 0 || verifiedAt > now) {
    fail("seedance25_account_catalog_verified_at_invalid", "账号模型目录 verifiedAt 无效或位于未来");
  }
  if (
    !Number.isSafeInteger(normalized.reservationUpperBoundTokens)
    || normalized.reservationUpperBoundTokens <= 0
  ) {
    fail("seedance25_reservation_upper_bound_invalid", "必须显式提供正整数 reservationUpperBoundTokens");
  }
  if (normalized.routeName.length > 200 || normalized.pricingName.length > 200) {
    fail("seedance25_staging_name_invalid", "Seedance 2.5 路由或价格规则名称过长");
  }
  return normalized;
}

function assertChannel(channel: DatabaseRow | undefined, expectedId: string): DatabaseRow {
  if (!channel || text(channel.id) !== expectedId) {
    fail("seedance25_channel_missing", "Seedance 2.5 指定供应商通道不存在");
  }
  if (
    text(channel.scope) !== "platform"
    || channel.workspaceId !== null
    || text(channel.provider) !== "volcano"
    || text(channel.endpointType) !== "video_generation"
    || Number(channel.disabled || 0) !== 0
  ) {
    fail(
      "seedance25_channel_contract_invalid",
      "Seedance 2.5 必须绑定启用的平台级 Volcano video_generation 通道",
    );
  }
  if (!stringArray(channel.modelNames).includes(SEEDANCE_25_MODEL_ID)) {
    fail("seedance25_channel_model_missing", "供应商通道模型目录未包含精确 Seedance 2.5 model");
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(text(channel.baseUrl));
  } catch {
    fail("seedance25_channel_base_url_invalid", "Seedance 2.5 供应商通道 baseUrl 无效");
  }
  if (
    baseUrl.protocol !== "https:"
    || baseUrl.username
    || baseUrl.password
    || baseUrl.hostname !== "ark.cn-beijing.volces.com"
    || !ALLOWED_CHANNEL_BASE_PATHS.has(baseUrl.pathname)
  ) {
    fail("seedance25_channel_base_url_invalid", "Seedance 2.5 必须使用无凭据的官方 Ark HTTPS 地址");
  }
  const config = record(channel.configJson);
  if (!text(channel.credentialRef) && !readProviderChannelCredentialCiphertext(config)) {
    fail("seedance25_channel_credential_unconfigured", "Seedance 2.5 通道缺少凭据引用或密文槽");
  }
  return channel;
}

function firstCertificationBlocker(): Seedance25FirstCertificationBlocker {
  return {
    status: "blocked",
    code: "seedance25_first_certification_requires_isolated_probe_boundary",
    reason:
      "正常 Relay 在上游调用和 GU 预扣前要求既有 route certification，而 certification 又要求真实 succeeded 任务与 charged usage；当前没有可安全证明 operator-only、真实上游与真实结算的首探针边界。",
    invariants: [
      "不得临时启用 staged route 或绕过 model-route certification guard",
      "不得插入或改写伪 succeeded relay task / charged usage",
      "首探针必须绑定 operator 身份、精确 channel/model、真实 usage.completion_tokens 与明确 GU 赞助账户",
      "探针成功、ledger 结算和 immutable certification batch 必须可审计且幂等",
    ],
  };
}

function buildPricingRuleConfig(reservationUpperBoundTokens: number): Record<string, unknown> {
  return {
    ...buildSeedance25TokenPricingRuleConfig({ reservationUpperBoundTokens }),
    managedBy: SEEDANCE_25_PRODUCTION_OPERATOR,
    rolloutState: "staged",
    pricingRevision: SEEDANCE_25_PRICING_REVISION,
    productionEntitlementVerified: false,
    realPaidSmokePassed: false,
  };
}

function buildRouteConfig(input: {
  accountModelCatalogEvidenceSha256: string;
  providerAccountFingerprint: string;
  accountModelCatalogVerifiedAt: string;
  reservationUpperBoundTokens: number;
  pricingRuleId: string;
  pricingRuleConfigSha256: string;
  changeId: string;
}): Record<string, unknown> {
  // Build once with the enabled flag solely to exercise the exact evidence and
  // reservation validation. The persisted staged contract is then replaced by
  // the same verified capability with its feature flag explicitly disabled.
  const validated = buildSeedance25LaunchRouteConfig({
    featureFlagEnabled: true,
    accountModelCatalogEvidenceSha256: input.accountModelCatalogEvidenceSha256,
    providerAccountFingerprint: input.providerAccountFingerprint,
    accountModelCatalogVerifiedAt: input.accountModelCatalogVerifiedAt,
    reservationUpperBoundTokens: input.reservationUpperBoundTokens,
  });
  return {
    ...validated,
    seeded: false,
    managedBy: SEEDANCE_25_PRODUCTION_OPERATOR,
    rolloutState: "staged",
    productionEntitlementVerified: false,
    realPaidSmokePassed: false,
    staging: {
      version: SEEDANCE_25_PRODUCTION_STAGING_VERSION,
      changeId: input.changeId,
      pricingRuleId: input.pricingRuleId,
      pricingRevision: SEEDANCE_25_PRICING_REVISION,
      pricingRuleConfigSha256: input.pricingRuleConfigSha256,
    },
    videoGenerationContract: verifiedSeedance25Capability(false),
  };
}

async function lockTables(transaction: Knex.Transaction): Promise<void> {
  if (!isPostgresClient(transaction)) return;
  await transaction.raw(
    'LOCK TABLE "o_provider_channel", "o_model_route", "o_pricing_rule" IN SHARE ROW EXCLUSIVE MODE',
  );
}

async function stagingRows(database: Knex | Knex.Transaction): Promise<{
  routes: DatabaseRow[];
  pricingRules: DatabaseRow[];
}> {
  const [routes, pricingRules] = await Promise.all([
    database("o_model_route")
      .where({
        scope: "platform",
        endpointType: "video_generation",
        model: SEEDANCE_25_MODEL_ID,
        provider: "volcano",
      })
      .whereNull("workspaceId")
      .orderBy("createTime", "asc"),
    database("o_pricing_rule")
      .where({
        scope: "platform",
        endpointType: "video_generation",
        model: SEEDANCE_25_MODEL_ID,
        provider: "volcano",
      })
      .whereNull("workspaceId")
      .orderBy("createTime", "asc"),
  ]);
  return { routes, pricingRules };
}

function assertAdoptableExistingRows(input: {
  routes: DatabaseRow[];
  pricingRules: DatabaseRow[];
}): void {
  if (input.routes.length > 1) {
    fail("seedance25_route_ambiguous", "存在多个 Seedance 2.5 平台路由，拒绝自动选择或覆盖");
  }
  if (input.pricingRules.length > 1) {
    fail("seedance25_pricing_ambiguous", "存在多个 Seedance 2.5 平台价格规则，拒绝自动选择或覆盖");
  }
  const route = input.routes[0];
  if (route) {
    const manager = text(record(route.routeConfig).managedBy);
    if (
      Number(route.disabled || 0) !== 1
      || !["production-bootstrap", SEEDANCE_25_PRODUCTION_OPERATOR].includes(manager)
    ) {
      fail("seedance25_route_not_staged", "已有 Seedance 2.5 路由不是可接管的停用 staging 路由");
    }
  }
  const pricing = input.pricingRules[0];
  if (pricing) {
    const manager = text(record(pricing.ruleConfig).managedBy);
    if (
      Number(pricing.disabled || 0) !== 1
      || text(pricing.id) !== SEEDANCE_25_PRODUCTION_PRICING_RULE_ID
      || manager !== SEEDANCE_25_PRODUCTION_OPERATOR
    ) {
      fail("seedance25_pricing_not_staged", "已有 Seedance 2.5 价格规则不是 operator 管理的停用 staging 规则");
    }
  }
}

function invalidInspection(reason: string): Seedance25ProductionStagingInspection {
  return {
    version: SEEDANCE_25_PRODUCTION_STAGING_VERSION,
    valid: false,
    reason,
    state: "staged",
    routeId: null,
    pricingRuleId: null,
    channelId: null,
    routeConfigSha256: null,
    pricingRuleConfigSha256: null,
    accountModelCatalogEvidenceSha256: null,
    reservationUpperBoundTokens: null,
    productionTrafficEnabled: false,
    firstCertification: firstCertificationBlocker(),
  };
}

export async function inspectSeedance25ProductionStaging(
  database: Knex | Knex.Transaction,
): Promise<Seedance25ProductionStagingInspection> {
  const { routes, pricingRules } = await stagingRows(database);
  if (routes.length !== 1 || pricingRules.length !== 1) {
    return invalidInspection("Seedance 2.5 staged route/pricing 必须各且仅各一条");
  }
  const route = routes[0];
  const pricing = pricingRules[0];
  const routeConfig = record(route.routeConfig);
  const pricingConfig = record(pricing.ruleConfig);
  const staging = record(routeConfig.staging);
  const channel = await database("o_provider_channel").where({ id: text(route.channelId) }).first();
  try {
    assertChannel(channel, text(route.channelId));
  } catch (error) {
    return invalidInspection(error instanceof Error ? error.message : "Seedance 2.5 channel readback 无效");
  }
  const gate = evaluateSeedance25RouteGate(routeConfig);
  const reservation = Number(pricingConfig.reservationUpperBoundTokens);
  const tiers = record(pricingConfig.videoInputPricing);
  const withoutVideo = record(tiers.withoutVideoInput);
  const withVideo = record(tiers.withVideoInput);
  const pricingConfigSha256 = sha256(pricingConfig);
  const valid = Boolean(
    Number(route.disabled || 0) === 1
    && Number(pricing.disabled || 0) === 1
    && text(route.channelId) === text(channel.id)
    && text(route.model) === SEEDANCE_25_MODEL_ID
    && text(pricing.id) === SEEDANCE_25_PRODUCTION_PRICING_RULE_ID
    && text(pricing.unit) === "token"
    && Number(pricing.unitPriceMicros) === SEEDANCE_25_TOKEN_PRICES.withoutVideoInput
    && text(pricing.currency).toUpperCase() === "GU"
    && text(routeConfig.managedBy) === SEEDANCE_25_PRODUCTION_OPERATOR
    && text(pricingConfig.managedBy) === SEEDANCE_25_PRODUCTION_OPERATOR
    && text(routeConfig.rolloutState) === "staged"
    && text(pricingConfig.rolloutState) === "staged"
    && routeConfig.productionEntitlementVerified === false
    && routeConfig.realPaidSmokePassed === false
    && pricingConfig.productionEntitlementVerified === false
    && pricingConfig.realPaidSmokePassed === false
    && staging.version === SEEDANCE_25_PRODUCTION_STAGING_VERSION
    && text(staging.pricingRuleId) === text(pricing.id)
    && text(staging.pricingRevision) === SEEDANCE_25_PRICING_REVISION
    && text(staging.pricingRuleConfigSha256) === pricingConfigSha256
    && text(pricingConfig.pricingRevision) === SEEDANCE_25_PRICING_REVISION
    && text(pricingConfig.pricingContract) === SEEDANCE_25_PRICING_CONTRACT
    && text(pricingConfig.authoritativeUsagePath) === "usage.completion_tokens"
    && Number.isSafeInteger(reservation)
    && reservation > 0
    && Number(withoutVideo.unitPriceMicros) === SEEDANCE_25_TOKEN_PRICES.withoutVideoInput
    && Number(withoutVideo.reservationUpperBoundTokens) === reservation
    && Number(withVideo.unitPriceMicros) === SEEDANCE_25_TOKEN_PRICES.withVideoInput
    && Number(withVideo.reservationUpperBoundTokens) === reservation
    && gate.recognized
    && !gate.dispatchable
    && SHA256.test(text(gate.accountModelCatalogEvidenceSha256))
  );
  return {
    version: SEEDANCE_25_PRODUCTION_STAGING_VERSION,
    valid,
    reason: valid ? null : "Seedance 2.5 staged route/pricing/channel 精确回读不一致",
    state: "staged",
    routeId: text(route.id) || null,
    pricingRuleId: text(pricing.id) || null,
    channelId: text(channel.id) || null,
    routeConfigSha256: sha256(routeConfig),
    pricingRuleConfigSha256: pricingConfigSha256,
    accountModelCatalogEvidenceSha256: text(gate.accountModelCatalogEvidenceSha256) || null,
    reservationUpperBoundTokens: Number.isSafeInteger(reservation) ? reservation : null,
    productionTrafficEnabled: false,
    firstCertification: firstCertificationBlocker(),
  };
}

interface StagingPlan {
  input: Required<Seedance25ProductionStagingInput>;
  routeId: string;
  pricingRuleId: string;
  routeAction: "create" | "update";
  pricingAction: "create" | "update";
  routeConfig: Record<string, unknown>;
  pricingRuleConfig: Record<string, unknown>;
}

async function planInsideTransaction(
  transaction: Knex | Knex.Transaction,
  rawInput: Seedance25ProductionStagingInput,
): Promise<StagingPlan> {
  const input = normalizeInput(rawInput);
  const channel = await transaction("o_provider_channel").where({ id: input.channelId }).first();
  assertChannel(channel, input.channelId);
  const rows = await stagingRows(transaction);
  assertAdoptableExistingRows(rows);
  const routeId = text(rows.routes[0]?.id) || SEEDANCE_25_PRODUCTION_ROUTE_ID;
  const pricingRuleId = text(rows.pricingRules[0]?.id) || SEEDANCE_25_PRODUCTION_PRICING_RULE_ID;
  if (pricingRuleId !== SEEDANCE_25_PRODUCTION_PRICING_RULE_ID) {
    fail("seedance25_pricing_id_invalid", "Seedance 2.5 staged pricing rule ID 不符合固定身份");
  }
  const pricingRuleConfig = buildPricingRuleConfig(input.reservationUpperBoundTokens);
  const routeConfig = buildRouteConfig({
    accountModelCatalogEvidenceSha256: input.accountModelCatalogEvidenceSha256,
    providerAccountFingerprint: input.providerAccountFingerprint,
    accountModelCatalogVerifiedAt: input.accountModelCatalogVerifiedAt,
    reservationUpperBoundTokens: input.reservationUpperBoundTokens,
    pricingRuleId,
    pricingRuleConfigSha256: sha256(pricingRuleConfig),
    changeId: input.changeId,
  });
  return {
    input,
    routeId,
    pricingRuleId,
    routeAction: rows.routes.length ? "update" : "create",
    pricingAction: rows.pricingRules.length ? "update" : "create",
    routeConfig,
    pricingRuleConfig,
  };
}

let mutationTail: Promise<void> = Promise.resolve();

async function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release = () => {};
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function validateSeedance25ProductionStaging(
  database: Knex,
  input: Seedance25ProductionStagingInput,
): Promise<Seedance25ProductionStagingReceipt> {
  const plan = await database.transaction(async (transaction) => planInsideTransaction(transaction, input));
  return {
    version: SEEDANCE_25_PRODUCTION_STAGING_VERSION,
    valid: true,
    reason: null,
    state: "staged",
    mode: "validate",
    changeId: plan.input.changeId,
    routeId: plan.routeId,
    pricingRuleId: plan.pricingRuleId,
    channelId: plan.input.channelId,
    routeAction: plan.routeAction,
    pricingAction: plan.pricingAction,
    routeConfigSha256: sha256(plan.routeConfig),
    pricingRuleConfigSha256: sha256(plan.pricingRuleConfig),
    accountModelCatalogEvidenceSha256: plan.input.accountModelCatalogEvidenceSha256,
    reservationUpperBoundTokens: plan.input.reservationUpperBoundTokens,
    productionTrafficEnabled: false,
    firstCertification: firstCertificationBlocker(),
    completedAt: plan.input.now,
  };
}

export async function applySeedance25ProductionStaging(
  database: Knex,
  input: Seedance25ProductionStagingInput,
): Promise<Seedance25ProductionStagingReceipt> {
  return serializeMutation(async () => database.transaction(async (transaction) => {
    await acquireModelRouteCertificationAdvisoryFence(transaction);
    await lockTables(transaction);
    const plan = await planInsideTransaction(transaction, input);
    const timestamp = plan.input.now;
    const routeRow = {
      name: plan.input.routeName,
      displayName: "Seedance 2.5",
      scope: "platform",
      workspaceId: null,
      endpointType: "video_generation",
      model: SEEDANCE_25_MODEL_ID,
      provider: "volcano",
      channelId: plan.input.channelId,
      priority: 10,
      fallbackOrder: 0,
      routeConfig: JSON.stringify(plan.routeConfig),
      disabled: 1,
      updateTime: timestamp,
    };
    const pricingRow = {
      name: plan.input.pricingName,
      scope: "platform",
      workspaceId: null,
      endpointType: "video_generation",
      provider: "volcano",
      model: SEEDANCE_25_MODEL_ID,
      unit: "token",
      unitPriceMicros: SEEDANCE_25_TOKEN_PRICES.withoutVideoInput,
      currency: "GU",
      ruleConfig: JSON.stringify(plan.pricingRuleConfig),
      disabled: 1,
      updateTime: timestamp,
    };
    if (plan.routeAction === "create") {
      await transaction("o_model_route").insert({
        id: plan.routeId,
        ...routeRow,
        createTime: timestamp,
      });
    } else {
      await transaction("o_model_route").where({ id: plan.routeId }).update(routeRow);
    }
    if (plan.pricingAction === "create") {
      await transaction("o_pricing_rule").insert({
        id: plan.pricingRuleId,
        ...pricingRow,
        createTime: timestamp,
      });
    } else {
      await transaction("o_pricing_rule").where({ id: plan.pricingRuleId }).update(pricingRow);
    }

    const [persistedRoute, persistedPricing] = await Promise.all([
      transaction("o_model_route").where({ id: plan.routeId }).first(),
      transaction("o_pricing_rule").where({ id: plan.pricingRuleId }).first(),
    ]);
    if (
      !persistedRoute
      || !persistedPricing
      || Number(persistedRoute.disabled || 0) !== 1
      || Number(persistedPricing.disabled || 0) !== 1
      || text(persistedRoute.channelId) !== plan.input.channelId
      || text(persistedRoute.model) !== SEEDANCE_25_MODEL_ID
      || text(persistedPricing.model) !== SEEDANCE_25_MODEL_ID
      || !sameJson(persistedRoute.routeConfig, plan.routeConfig)
      || !sameJson(persistedPricing.ruleConfig, plan.pricingRuleConfig)
    ) {
      fail("seedance25_staging_readback_mismatch", "Seedance 2.5 事务内 route/pricing 精确回读不一致");
    }
    const inspection = await inspectSeedance25ProductionStaging(transaction);
    if (!inspection.valid) {
      fail("seedance25_staging_inspection_failed", inspection.reason || "Seedance 2.5 staged 配置回读失败");
    }
    return {
      ...inspection,
      mode: "apply",
      changeId: plan.input.changeId,
      routeAction: plan.routeAction,
      pricingAction: plan.pricingAction,
      completedAt: timestamp,
    };
  }));
}

interface NormalizedCertificationArmInput {
  probeId: string;
  workspaceId: string;
  projectId: string;
  adminUserId: string;
  createdAt: string;
  createdAtMs: number;
  expiresAt: string;
  expiresAtMs: number;
  replacesExpiredProbeId: string;
  recoveryTaskId: string;
  recoveryAcknowledgement: string;
  now: number;
}

interface Seedance25CertificationArmPlan {
  input: NormalizedCertificationArmInput;
  permit: Seedance25CertificationProbePermit;
  action: "arm" | "resume" | "rearm";
  route: DatabaseRow;
  pricing: DatabaseRow;
  currentRouteUpdateTime: number;
  currentPricingUpdateTime: number;
  recoveryCancellationTaskId: string | null;
  expectedRouteConfig: Record<string, unknown>;
  expectedPricingConfig: Record<string, unknown>;
  certificationSnapshotSha256: string;
}

interface NormalizedCertificationEvidenceInput {
  probeId: string;
  taskId: string;
  adminUserId: number;
  priceSourceUrl: string;
  priceSourceContentSha256: string;
  priceCheckedAt: number;
  upstreamCurrency: "CNY";
  upstreamUnitPriceMicros: typeof SEEDANCE_25_UPSTREAM_TOKEN_PRICES.withoutVideoInput;
  billingCurrency: "GU";
  billingDimension: "token";
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  validUntil: number;
  now: number;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalUtcRfc3339(value: unknown, label: string): { text: string; milliseconds: number } {
  const candidate = text(value);
  const milliseconds = Date.parse(candidate);
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds <= 0
    || new Date(milliseconds).toISOString() !== candidate
  ) {
    fail("seedance25_probe_time_invalid", `${label} 必须是 canonical UTC RFC3339 时间`);
  }
  return { text: candidate, milliseconds };
}

function positiveDecimal(value: unknown, label: string): string {
  const candidate = text(value);
  const numeric = Number(candidate);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || String(numeric) !== candidate) {
    fail("seedance25_probe_identity_invalid", `${label} 必须是安全的正十进制字符串`);
  }
  return candidate;
}

function assertFixedPromptDigest(): void {
  const digest = crypto
    .createHash("sha256")
    .update(SEEDANCE_25_CERTIFICATION_PROBE_PROMPT, "utf8")
    .digest("hex");
  if (`sha256:${digest}` !== SEEDANCE_25_CERTIFICATION_PROBE_PROMPT_DIGEST) {
    fail("seedance25_probe_prompt_digest_invalid", "Seedance 2.5 首认证固定 prompt 摘要不一致");
  }
}

function normalizeCertificationArmInput(
  input: Seedance25CertificationProbeArmInput,
): NormalizedCertificationArmInput {
  assertFixedPromptDigest();
  const now = Number(input.now ?? Date.now());
  if (!Number.isSafeInteger(now) || now <= 0) {
    fail("seedance25_probe_now_invalid", "Seedance 2.5 probe 当前时间无效");
  }
  const probeId = text(input.probeId);
  const workspaceId = text(input.workspaceId);
  const projectId = positiveDecimal(input.projectId, "projectId");
  const adminUserId = positiveDecimal(input.adminUserId, "adminUserId");
  const createdAt = canonicalUtcRfc3339(input.createdAt, "createdAt");
  const expiresAt = canonicalUtcRfc3339(input.expiresAt, "expiresAt");
  const replacesExpiredProbeId = text(input.replacesExpiredProbeId);
  const recoveryTaskId = text(input.recoveryTaskId);
  const recoveryAcknowledgement = text(input.recoveryAcknowledgement);
  const recoveryFields = [
    replacesExpiredProbeId,
    recoveryTaskId,
    recoveryAcknowledgement,
  ].filter(Boolean).length;
  if (recoveryFields !== 0 && recoveryFields !== 3) {
    fail(
      "seedance25_probe_recovery_declaration_invalid",
      "expired probe recovery 必须同时声明旧 probeId、exact taskId/none 与独立 acknowledgement",
    );
  }
  if (createdAt.milliseconds > now) {
    fail("seedance25_probe_created_at_future", "probe createdAt 不能位于未来");
  }
  if (
    expiresAt.milliseconds <= createdAt.milliseconds
    || expiresAt.milliseconds - createdAt.milliseconds > SEEDANCE_25_CERTIFICATION_PROBE_MAX_VALIDITY_MS
  ) {
    fail("seedance25_probe_expiry_invalid", "probe expiresAt 必须晚于 createdAt 且不超过 30 分钟");
  }
  return {
    probeId,
    workspaceId,
    projectId,
    adminUserId,
    createdAt: createdAt.text,
    createdAtMs: createdAt.milliseconds,
    expiresAt: expiresAt.text,
    expiresAtMs: expiresAt.milliseconds,
    replacesExpiredProbeId,
    recoveryTaskId,
    recoveryAcknowledgement,
    now,
  };
}

function certificationPermit(input: {
  normalized: NormalizedCertificationArmInput;
  routeId: string;
  pricingRuleId: string;
  channelId: string;
}): Seedance25CertificationProbePermit {
  return assertSeedance25CertificationProbePermit({
    version: SEEDANCE_25_CERTIFICATION_PROBE_VERSION,
    probeId: input.normalized.probeId,
    routeId: input.routeId,
    workspaceId: input.normalized.workspaceId,
    projectId: input.normalized.projectId,
    adminUserId: input.normalized.adminUserId,
    promptDigest: SEEDANCE_25_CERTIFICATION_PROBE_PROMPT_DIGEST,
    createdAt: input.normalized.createdAt,
    expiresAt: input.normalized.expiresAt,
    pricingRuleId: input.pricingRuleId,
    channelId: input.channelId,
  }, Math.min(input.normalized.now, input.normalized.expiresAtMs - 1));
}

function assertPersistedCertificationProbePermit(
  value: unknown,
): Seedance25CertificationProbePermit {
  const candidate = record(value);
  const createdAt = canonicalUtcRfc3339(candidate.createdAt, "persisted permit createdAt");
  try {
    return assertSeedance25CertificationProbePermit(value, createdAt.milliseconds);
  } catch (error) {
    fail(
      "seedance25_probe_permit_invalid",
      error instanceof Error ? error.message : "persisted certificationProbe permit 无效",
    );
  }
}

function relaySubmissionState(task: DatabaseRow): string {
  return text(record(record(task.providerPayload).submission).state);
}

function taskRequiresReconciliationRecord(task: DatabaseRow): boolean {
  const providerPayload = record(task.providerPayload);
  const submissionState = text(record(providerPayload.submission).state);
  const billingFinalizationState = text(record(providerPayload.billingFinalization).state);
  return submissionState === "pending_reconcile"
    || submissionState === "pending_reconcile_persist_failed"
    || billingFinalizationState === "retry_required";
}

function taskHasDispatchEvidence(task: DatabaseRow): boolean {
  const submissionState = relaySubmissionState(task);
  return Boolean(
    text(task.providerTaskId)
    || Number(task.submittedAt) > 0
    || [
      "dispatch_started",
      "accepted",
      "pending_reconcile",
      "pending_reconcile_persist_failed",
      "captured",
    ].includes(submissionState),
  );
}

function withoutCertificationSnapshot(value: unknown): Record<string, unknown> {
  const normalized = { ...record(value) };
  delete normalized.certificationArmSnapshot;
  return normalized;
}

function certificationSnapshotProjection(input: {
  route: DatabaseRow;
  pricing: DatabaseRow;
  routeConfig: Record<string, unknown>;
  pricingConfig: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    route: {
      id: text(input.route.id),
      name: text(input.route.name),
      displayName: text(input.route.displayName) || null,
      scope: text(input.route.scope),
      workspaceId: text(input.route.workspaceId) || null,
      endpointType: text(input.route.endpointType),
      model: text(input.route.model),
      provider: text(input.route.provider),
      channelId: text(input.route.channelId),
      priority: Number(input.route.priority),
      fallbackOrder: Number(input.route.fallbackOrder),
      routeConfig: withoutCertificationSnapshot(input.routeConfig),
      disabled: Number(input.route.disabled || 0),
      updateTime: Number(input.route.updateTime),
    },
    pricing: {
      id: text(input.pricing.id),
      name: text(input.pricing.name),
      scope: text(input.pricing.scope),
      workspaceId: text(input.pricing.workspaceId) || null,
      endpointType: text(input.pricing.endpointType),
      provider: text(input.pricing.provider),
      model: text(input.pricing.model),
      unit: text(input.pricing.unit),
      unitPriceMicros: Number(input.pricing.unitPriceMicros),
      currency: text(input.pricing.currency).toUpperCase(),
      ruleConfig: withoutCertificationSnapshot(input.pricingConfig),
      disabled: Number(input.pricing.disabled || 0),
      updateTime: Number(input.pricing.updateTime),
    },
  };
}

function buildArmedRows(input: {
  route: DatabaseRow;
  pricing: DatabaseRow;
  permit: Seedance25CertificationProbePermit;
  timestamp: number;
}): {
  route: DatabaseRow;
  pricing: DatabaseRow;
  routeConfig: Record<string, unknown>;
  pricingConfig: Record<string, unknown>;
  snapshotSha256: string;
} {
  const stagedRouteConfig = withoutCertificationSnapshot(input.route.routeConfig);
  const stagedPricingConfig = withoutCertificationSnapshot(input.pricing.ruleConfig);
  const accountEvidence = record(stagedRouteConfig.accountModelCatalogEvidence);
  const reservationUpperBoundTokens = Number(stagedPricingConfig.reservationUpperBoundTokens);
  const pricingConfigWithoutSnapshot: Record<string, unknown> = {
    ...stagedPricingConfig,
    rolloutState: "certification_armed",
    productionEntitlementVerified: true,
    realPaidSmokePassed: false,
    activationGate: SEEDANCE_25_CERTIFICATION_ACTIVATION_GATE,
    certificationProbeBinding: {
      version: SEEDANCE_25_CERTIFICATION_PRICING_BINDING_VERSION,
      probeId: input.permit.probeId,
      routeId: input.permit.routeId,
      pricingRuleId: input.permit.pricingRuleId,
      channelId: input.permit.channelId,
      createdAt: input.permit.createdAt,
      expiresAt: input.permit.expiresAt,
    },
  };
  const formalRoute = buildSeedance25LaunchRouteConfig({
    featureFlagEnabled: true,
    accountModelCatalogEvidenceSha256: text(accountEvidence.sha256).toLowerCase(),
    providerAccountFingerprint: text(accountEvidence.providerAccountFingerprint).toLowerCase(),
    accountModelCatalogVerifiedAt: text(accountEvidence.verifiedAt),
    reservationUpperBoundTokens,
  });
  const staged = record(stagedRouteConfig.staging);
  const routeConfigWithoutSnapshot: Record<string, unknown> = {
    ...stagedRouteConfig,
    ...formalRoute,
    seeded: false,
    managedBy: SEEDANCE_25_PRODUCTION_OPERATOR,
    rolloutState: "certification_armed",
    productionEntitlementVerified: true,
    realPaidSmokePassed: false,
    activationGate: SEEDANCE_25_CERTIFICATION_ACTIVATION_GATE,
    staging: {
      ...staged,
      pricingRuleConfigSha256: sha256(pricingConfigWithoutSnapshot),
      pricingRuleConfigHashScope: "without-certification-arm-snapshot/v1",
    },
    certificationProbe: input.permit,
  };
  const routeBase = {
    ...input.route,
    routeConfig: routeConfigWithoutSnapshot,
    disabled: 0,
    updateTime: input.timestamp,
  };
  const pricingBase = {
    ...input.pricing,
    ruleConfig: pricingConfigWithoutSnapshot,
    disabled: 0,
    updateTime: input.timestamp,
  };
  const snapshotSha256 = sha256(certificationSnapshotProjection({
    route: routeBase,
    pricing: pricingBase,
    routeConfig: routeConfigWithoutSnapshot,
    pricingConfig: pricingConfigWithoutSnapshot,
  }));
  const binding = {
    version: SEEDANCE_25_CERTIFICATION_ARM_SNAPSHOT_VERSION,
    probeId: input.permit.probeId,
    sha256: snapshotSha256,
  };
  const routeConfig = { ...routeConfigWithoutSnapshot, certificationArmSnapshot: binding };
  const pricingConfig = { ...pricingConfigWithoutSnapshot, certificationArmSnapshot: binding };
  return {
    route: { ...routeBase, routeConfig },
    pricing: { ...pricingBase, ruleConfig: pricingConfig },
    routeConfig,
    pricingConfig,
    snapshotSha256,
  };
}

async function requireCertificationArmSchema(database: Knex | Knex.Transaction): Promise<void> {
  const required = [
    "o_provider_channel",
    "o_model_route",
    "o_pricing_rule",
    "o_user",
    "o_project",
    "o_workspace",
    "o_relay_task",
    "o_usage_record",
    "o_billing_ledger",
    "o_billing_reconcile_job",
    MODEL_ROUTE_CERTIFICATION_TABLE,
    MODEL_ROUTE_CERTIFICATION_BATCH_TABLE,
  ];
  for (const tableName of required) {
    if (!(await database.schema.hasTable(tableName))) {
      fail("seedance25_probe_schema_missing", `首认证缺少必需数据表 ${tableName}`);
    }
  }
}

function updateLocked(query: Knex.QueryBuilder, database: Knex | Knex.Transaction): Knex.QueryBuilder {
  return isPostgresClient(database) ? query.forUpdate() : query;
}

async function lockedExactRouteAndPricing(transaction: Knex.Transaction): Promise<{
  routes: DatabaseRow[];
  pricingRules: DatabaseRow[];
}> {
  const routeQuery = transaction("o_model_route")
    .where({
      scope: "platform",
      endpointType: "video_generation",
      model: SEEDANCE_25_MODEL_ID,
      provider: "volcano",
    })
    .whereNull("workspaceId")
    .orderBy("createTime", "asc");
  const pricingQuery = transaction("o_pricing_rule")
    .where({
      scope: "platform",
      endpointType: "video_generation",
      model: SEEDANCE_25_MODEL_ID,
      provider: "volcano",
    })
    .whereNull("workspaceId")
    .orderBy("createTime", "asc");
  const routes = await updateLocked(routeQuery, transaction);
  const pricingRules = await updateLocked(pricingQuery, transaction);
  return { routes, pricingRules };
}

function assertExactPricingReadback(pricing: DatabaseRow): void {
  try {
    assertSeedance25PricingRuleReadback({
      provider: pricing.provider,
      model: pricing.model,
      unit: pricing.unit,
      currency: pricing.currency,
      baseUnitPriceMicros: pricing.unitPriceMicros,
      ruleConfig: pricing.ruleConfig,
    });
  } catch (error) {
    fail(
      "seedance25_probe_pricing_readback_invalid",
      error instanceof Error ? error.message : "Seedance 2.5 700/420 GU/百万 Token 定价回读无效",
    );
  }
}

function assertArmedSnapshot(input: {
  route: DatabaseRow;
  pricing: DatabaseRow;
  permit: Seedance25CertificationProbePermit;
}): string {
  const routeConfig = record(input.route.routeConfig);
  const pricingConfig = record(input.pricing.ruleConfig);
  const routeSnapshot = record(routeConfig.certificationArmSnapshot);
  const pricingSnapshot = record(pricingConfig.certificationArmSnapshot);
  const pricingBinding = record(pricingConfig.certificationProbeBinding);
  const staging = record(routeConfig.staging);
  const gate = evaluateSeedance25RouteGate(routeConfig);
  if (
    Number(input.route.disabled || 0) !== 0
    || Number(input.pricing.disabled || 0) !== 0
    || text(input.route.id) !== input.permit.routeId
    || text(input.route.channelId) !== input.permit.channelId
    || text(input.pricing.id) !== input.permit.pricingRuleId
    || text(input.route.model) !== SEEDANCE_25_MODEL_ID
    || text(input.pricing.model) !== SEEDANCE_25_MODEL_ID
    || text(routeConfig.managedBy) !== SEEDANCE_25_PRODUCTION_OPERATOR
    || text(pricingConfig.managedBy) !== SEEDANCE_25_PRODUCTION_OPERATOR
    || text(routeConfig.rolloutState) !== "certification_armed"
    || text(pricingConfig.rolloutState) !== "certification_armed"
    || routeConfig.productionEntitlementVerified !== true
    || pricingConfig.productionEntitlementVerified !== true
    || routeConfig.realPaidSmokePassed !== false
    || pricingConfig.realPaidSmokePassed !== false
    || routeConfig.activationGate !== SEEDANCE_25_CERTIFICATION_ACTIVATION_GATE
    || pricingConfig.activationGate !== SEEDANCE_25_CERTIFICATION_ACTIVATION_GATE
    || !gate.recognized
    || !gate.dispatchable
    || !sameJson(routeConfig.certificationProbe, input.permit)
  ) {
    fail("seedance25_probe_armed_snapshot_invalid", "Seedance 2.5 armed route/pricing 基础快照无效");
  }
  if (
    !exactObjectKeys(routeSnapshot, ["version", "probeId", "sha256"])
    || !exactObjectKeys(pricingSnapshot, ["version", "probeId", "sha256"])
    || routeSnapshot.version !== SEEDANCE_25_CERTIFICATION_ARM_SNAPSHOT_VERSION
    || pricingSnapshot.version !== SEEDANCE_25_CERTIFICATION_ARM_SNAPSHOT_VERSION
    || routeSnapshot.probeId !== input.permit.probeId
    || pricingSnapshot.probeId !== input.permit.probeId
    || !SHA256.test(text(routeSnapshot.sha256))
    || !sameJson(routeSnapshot, pricingSnapshot)
  ) {
    fail("seedance25_probe_snapshot_binding_invalid", "route/pricing 首认证快照绑定无效");
  }
  if (
    !exactObjectKeys(pricingBinding, [
      "version",
      "probeId",
      "routeId",
      "pricingRuleId",
      "channelId",
      "createdAt",
      "expiresAt",
    ])
    || pricingBinding.version !== SEEDANCE_25_CERTIFICATION_PRICING_BINDING_VERSION
    || pricingBinding.probeId !== input.permit.probeId
    || pricingBinding.routeId !== input.permit.routeId
    || pricingBinding.pricingRuleId !== input.permit.pricingRuleId
    || pricingBinding.channelId !== input.permit.channelId
    || pricingBinding.createdAt !== input.permit.createdAt
    || pricingBinding.expiresAt !== input.permit.expiresAt
  ) {
    fail("seedance25_probe_pricing_binding_invalid", "pricing 首认证 permit 绑定无效");
  }
  const pricingWithoutSnapshot = withoutCertificationSnapshot(pricingConfig);
  if (
    staging.pricingRuleConfigHashScope !== "without-certification-arm-snapshot/v1"
    || staging.pricingRuleConfigSha256 !== sha256(pricingWithoutSnapshot)
  ) {
    fail("seedance25_probe_pricing_hash_invalid", "route 对 pricing 首认证快照的摘要绑定无效");
  }
  const snapshotSha256 = sha256(certificationSnapshotProjection({
    route: input.route,
    pricing: input.pricing,
    routeConfig,
    pricingConfig,
  }));
  if (snapshotSha256 !== routeSnapshot.sha256) {
    fail("seedance25_probe_snapshot_drift", "Seedance 2.5 route/pricing armed 快照已漂移");
  }
  assertExactPricingReadback(input.pricing);
  return snapshotSha256;
}

/**
 * Read-only pre-dispatch guard shared by the server-internal Relay probe seam.
 * It deliberately performs no lookup or mutation: callers must pass the exact
 * locked route/pricing rows that were resolved for the immutable permit.
 */
export function assertSeedance25ArmedSnapshotForRuntime(
  route: Record<string, any>,
  pricing: Record<string, any>,
  permit: Seedance25CertificationProbePermit,
  now = Date.now(),
): string {
  const validatedPermit = assertSeedance25CertificationProbePermit(permit, now);
  return assertArmedSnapshot({ route, pricing, permit: validatedPermit });
}

async function lockedIdentityRows(input: {
  transaction: Knex.Transaction;
  route: DatabaseRow;
  normalized: NormalizedCertificationArmInput;
}): Promise<{
  channel: DatabaseRow;
  actor: DatabaseRow;
  project: DatabaseRow;
  workspace: DatabaseRow;
}> {
  const channelQuery = input.transaction("o_provider_channel")
    .where({ id: text(input.route.channelId) });
  const actorQuery = input.transaction("o_user")
    .where({ id: Number(input.normalized.adminUserId) });
  const projectQuery = input.transaction("o_project")
    .where({ id: Number(input.normalized.projectId) });
  const workspaceQuery = input.transaction("o_workspace")
    .where({ id: input.normalized.workspaceId });
  const channel = await updateLocked(channelQuery, input.transaction).first();
  const actor = await updateLocked(actorQuery, input.transaction).first();
  const project = await updateLocked(projectQuery, input.transaction).first();
  const workspace = await updateLocked(workspaceQuery, input.transaction).first();
  assertChannel(channel, text(input.route.channelId));
  if (
    !actor
    || text(actor.status).toLowerCase() !== "active"
    || !PLATFORM_ADMIN_ROLES.has(text(actor.role).toLowerCase())
  ) {
    fail("seedance25_probe_admin_invalid", "首认证只允许 active root/admin/super_admin");
  }
  if (!workspace || text(workspace.status).toLowerCase() !== "active") {
    fail("seedance25_probe_workspace_inactive", "首认证 workspace 不存在或未启用");
  }
  if (
    !project
    || text(project.workspaceId) !== input.normalized.workspaceId
    || text(project.deletionState).toLowerCase() !== "active"
  ) {
    fail("seedance25_probe_project_inactive", "首认证 project 不存在、不属于 workspace 或非 active");
  }
  return { channel, actor, project, workspace };
}

async function assertProbeReplacementSafe(input: {
  transaction: Knex.Transaction;
  normalized: NormalizedCertificationArmInput;
  persistedPermit: Seedance25CertificationProbePermit;
  allowPredispatchCancellationPending: boolean;
}): Promise<{ cancellationTaskId: string | null }> {
  const expectedAck = `replace-expired:${input.persistedPermit.probeId}:${input.normalized.recoveryTaskId}:${input.normalized.probeId}`;
  if (
    input.normalized.replacesExpiredProbeId !== input.persistedPermit.probeId
    || input.normalized.recoveryAcknowledgement !== expectedAck
  ) {
    fail(
      "seedance25_probe_recovery_ack_invalid",
      "probe replacement 需要同时确认旧 probe、exact taskId/none 与新 probe",
    );
  }
  const allCandidateTasks = await input.transaction("o_relay_task")
    .where({
      workspaceId: input.persistedPermit.workspaceId,
      projectId: Number(input.persistedPermit.projectId),
      endpointType: "video_generation",
      model: SEEDANCE_25_MODEL_ID,
      provider: "volcano",
      channelId: input.persistedPermit.channelId,
    })
    .orderBy("createTime", "asc");
  const tasks = allCandidateTasks.filter((task) => sameJson(
    record(record(task.resultPayload).internal).seedance25CertificationProbe,
    input.persistedPermit,
  ));
  if (tasks.length > 1) {
    fail("seedance25_probe_recovery_task_ambiguous", "旧 probe 关联了多个 task，禁止自动恢复");
  }
  if (tasks.length === 0) {
    if (input.normalized.recoveryTaskId !== "none") {
      fail("seedance25_probe_recovery_task_mismatch", "旧 probe 从未创建 task，recoveryTaskId 必须为 none");
    }
    if (Date.parse(input.persistedPermit.expiresAt) > input.normalized.now) {
      fail("seedance25_probe_already_armed", "active probe 尚未创建 task，必须继续使用同一 permit");
    }
    return { cancellationTaskId: null };
  }
  const task = tasks[0];
  if (text(task.id) !== input.normalized.recoveryTaskId) {
    fail("seedance25_probe_recovery_task_mismatch", "recoveryTaskId 与旧 probe 的 exact task 不一致");
  }
  if (text(task.status) === "succeeded") {
    fail(
      "seedance25_probe_recovery_success_must_certify",
      "旧 probe 已 succeeded；必须复用该 task/usage 重试 certification，禁止重投",
    );
  }
  if (taskRequiresReconciliationRecord(task)) {
    fail("seedance25_probe_recovery_pending_reconcile", "旧 probe 仍处于 pending reconcile，禁止 reset/rearm");
  }
  const dispatchEvidence = taskHasDispatchEvidence(task);
  if (
    !dispatchEvidence
    && ["queued", "running"].includes(text(task.status))
  ) {
    if (Date.parse(input.persistedPermit.expiresAt) > input.normalized.now) {
      fail("seedance25_probe_already_armed", "active probe 的 pre-dispatch task 必须继续运行，禁止提前 replacement");
    }
    if (input.allowPredispatchCancellationPending) {
      return { cancellationTaskId: text(task.id) };
    }
    fail(
      "seedance25_probe_recovery_cancel_required",
      "expired pre-dispatch task 必须先由 Relay 账务域安全取消并释放 freeze，再执行 rearm",
    );
  }
  const completedAt = Number(task.completedAt);
  const leaseExpiresAt = task.leaseExpiresAt == null
    ? null
    : Number(task.leaseExpiresAt);
  if (
    task.leaseOwner != null
    || (
      leaseExpiresAt != null
      && (
        !Number.isSafeInteger(leaseExpiresAt)
        || !Number.isSafeInteger(completedAt)
        || leaseExpiresAt > completedAt
      )
    )
  ) {
    fail(
      "seedance25_probe_recovery_lease_open",
      "旧 probe 终态 task 仍持有 Relay mutation lease，禁止 rearm",
    );
  }
  // These are terminal-domain observations only. Read them serially so one
  // PostgreSQL connection never runs parallel statements with different
  // statement snapshots; the create session fence prevents an older probe
  // from being inserted between this read and the re-arm commit.
  const usageRows = await input.transaction("o_usage_record")
    .where({ taskId: text(task.id) });
  const ledgerRows = await input.transaction("o_billing_ledger")
    .where({ relatedTaskId: text(task.id) });
  const reconcileRows = await input.transaction("o_billing_reconcile_job").where({
    workspaceId: input.persistedPermit.workspaceId,
    requestId: text(task.requestId),
  });
  const existingCertification = await input.transaction(MODEL_ROUTE_CERTIFICATION_TABLE)
    .where({ routeId: input.persistedPermit.routeId, operationKey: MODEL_ROUTE_BASE_OPERATION })
    .whereNull("revokedAt")
    .first();
  if (existingCertification) {
    fail("seedance25_probe_recovery_certification_exists", "旧 route 已有 active certification，禁止首探针 rearm");
  }
  const freezes = ledgerRows.filter((row) => text(row.type) === "freeze");
  const billingClosed = freezes.every((row) => Number(row.remainingMicros) === 0)
    && usageRows.every((row) => ["released", "charged", "free"].includes(text(row.status)))
    && reconcileRows.every((row) => text(row.status) === "resolved");
  if (!billingClosed) {
    fail("seedance25_probe_recovery_billing_open", "旧 probe 仍有 open freeze、未终态 usage 或未解决 reconcile");
  }
  if (dispatchEvidence) {
    if (
      !["failed", "cancelled"].includes(text(task.status))
      || freezes.length !== 1
      || usageRows.length !== 1
      || reconcileRows.length === 0
    ) {
      fail(
        "seedance25_probe_recovery_dispatch_unresolved",
        "旧 probe 已有 dispatch evidence；仅终态失败且账务/watchdog 全闭合后可显式 rearm",
      );
    }
    return { cancellationTaskId: null };
  }
  if (!["failed", "cancelled"].includes(text(task.status))) {
    fail("seedance25_probe_recovery_task_state_invalid", "旧 pre-dispatch task 状态不可安全回收");
  }
  return { cancellationTaskId: null };
}

async function planCertificationArmInsideTransaction(
  transaction: Knex.Transaction,
  rawInput: Seedance25CertificationProbeArmInput,
  options: { allowPredispatchCancellationPending?: boolean } = {},
): Promise<Seedance25CertificationArmPlan> {
  const normalized = normalizeCertificationArmInput(rawInput);
  // The advisory namespace is the first database lock. Schema introspection
  // is deliberately after it so no control-plane path can invert this order.
  await acquireModelRouteCertificationAdvisoryFence(transaction);
  await requireCertificationArmSchema(transaction);
  await lockTables(transaction);
  const rows = await lockedExactRouteAndPricing(transaction);
  if (rows.routes.length !== 1 || rows.pricingRules.length !== 1) {
    fail("seedance25_probe_exact_rows_invalid", "首认证要求唯一 exact Seedance 2.5 route/pricing");
  }
  const route = rows.routes[0];
  const pricing = rows.pricingRules[0];
  if (text(pricing.id) !== SEEDANCE_25_PRODUCTION_PRICING_RULE_ID) {
    fail("seedance25_probe_pricing_identity_invalid", "首认证 pricingRuleId 不符合固定身份");
  }
  await lockedIdentityRows({ transaction, route, normalized });
  const permit = certificationPermit({
    normalized,
    routeId: text(route.id),
    pricingRuleId: text(pricing.id),
    channelId: text(route.channelId),
  });
  const routeConfig = record(route.routeConfig);
  if (Object.prototype.hasOwnProperty.call(routeConfig, "certificationProbe")) {
    const persistedPermit = assertPersistedCertificationProbePermit(
      routeConfig.certificationProbe,
    );
    const certificationSnapshotSha256 = assertArmedSnapshot({
      route,
      pricing,
      permit: persistedPermit,
    });
    if (sameJson(persistedPermit, permit)) {
      return {
        input: normalized,
        permit: persistedPermit,
        action: "resume",
        route,
        pricing,
        currentRouteUpdateTime: Number(route.updateTime),
        currentPricingUpdateTime: Number(pricing.updateTime),
        recoveryCancellationTaskId: null,
        expectedRouteConfig: record(route.routeConfig),
        expectedPricingConfig: record(pricing.ruleConfig),
        certificationSnapshotSha256,
      };
    }
    if (
      Date.parse(persistedPermit.expiresAt) > normalized.now
      && !normalized.replacesExpiredProbeId
    ) {
      fail("seedance25_probe_already_armed", "route 已由尚未过期的不同 certificationProbe 不可变绑定");
    }
    if (normalized.expiresAtMs <= normalized.now) {
      fail("seedance25_probe_rearm_expired", "replacement probe 本身已过期，禁止 rearm");
    }
    const existingCertification = await transaction(MODEL_ROUTE_CERTIFICATION_TABLE)
      .where({ routeId: text(route.id), operationKey: MODEL_ROUTE_BASE_OPERATION })
      .whereNull("revokedAt")
      .first();
    if (existingCertification) {
      fail("seedance25_probe_recovery_certification_exists", "route 已有 active certification，禁止 rearm");
    }
    const recovery = await assertProbeReplacementSafe({
      transaction,
      normalized,
      persistedPermit,
      allowPredispatchCancellationPending: options.allowPredispatchCancellationPending === true,
    });
    const rearmed = buildArmedRows({
      route,
      pricing,
      permit,
      timestamp: normalized.now,
    });
    return {
      input: normalized,
      permit,
      action: "rearm",
      route: rearmed.route,
      pricing: rearmed.pricing,
      currentRouteUpdateTime: Number(route.updateTime),
      currentPricingUpdateTime: Number(pricing.updateTime),
      recoveryCancellationTaskId: recovery.cancellationTaskId,
      expectedRouteConfig: rearmed.routeConfig,
      expectedPricingConfig: rearmed.pricingConfig,
      certificationSnapshotSha256: rearmed.snapshotSha256,
    };
  }
  const inspection = await inspectSeedance25ProductionStaging(transaction);
  if (normalized.expiresAtMs <= normalized.now) {
    fail("seedance25_probe_arm_expired", "新 probe permit 已过期，禁止 arm");
  }
  if (!inspection.valid || Number(route.disabled || 0) !== 1 || Number(pricing.disabled || 0) !== 1) {
    fail("seedance25_probe_staging_invalid", inspection.reason || "首认证必须从 exact disabled staging 开始");
  }
  assertExactPricingReadback(pricing);
  const existingCertification = await transaction(MODEL_ROUTE_CERTIFICATION_TABLE)
    .where({ routeId: text(route.id) })
    .first();
  if (existingCertification) {
    fail("seedance25_probe_certification_preexists", "首次认证 arm 前已存在 route certification，拒绝覆盖");
  }
  const armed = buildArmedRows({
    route,
    pricing,
    permit,
    timestamp: normalized.now,
  });
  return {
    input: normalized,
    permit,
    action: "arm",
    route: armed.route,
    pricing: armed.pricing,
    currentRouteUpdateTime: Number(route.updateTime),
    currentPricingUpdateTime: Number(pricing.updateTime),
    recoveryCancellationTaskId: null,
    expectedRouteConfig: armed.routeConfig,
    expectedPricingConfig: armed.pricingConfig,
    certificationSnapshotSha256: armed.snapshotSha256,
  };
}

function certificationArmReceipt(
  plan: Seedance25CertificationArmPlan,
  mode: "validate" | "apply",
): Seedance25CertificationProbeArmReceipt {
  return {
    version: "seedance-2.5-certification-arm/v1",
    mode,
    action: plan.action,
    valid: true,
    permit: plan.permit,
    activationGate: SEEDANCE_25_CERTIFICATION_ACTIVATION_GATE,
    routeConfigSha256: sha256(plan.expectedRouteConfig),
    pricingRuleConfigSha256: sha256(plan.expectedPricingConfig),
    certificationSnapshotSha256: plan.certificationSnapshotSha256,
    routeAndPricingEnabled: mode === "apply" || plan.action !== "arm",
    productionTrafficEnabled: false,
    completedAt: plan.input.now,
  };
}

export async function validateSeedance25CertificationProbeArm(
  database: Knex,
  input: Seedance25CertificationProbeArmInput,
): Promise<Seedance25CertificationProbeArmReceipt> {
  const plan = await database.transaction(async (transaction) => (
    planCertificationArmInsideTransaction(transaction, input)
  ));
  return certificationArmReceipt(plan, "validate");
}

export async function armSeedance25CertificationProbe(
  database: Knex,
  input: Seedance25CertificationProbeArmInput,
): Promise<Seedance25CertificationProbeArmReceipt> {
  return serializeMutation(async () => database.transaction(async (transaction) => {
    const plan = await planCertificationArmInsideTransaction(transaction, input);
    if (plan.action === "resume") return certificationArmReceipt(plan, "apply");
    const expectedDisabled = plan.action === "arm" ? 1 : 0;
    const routeAffected = await transaction("o_model_route")
      .where({
        id: plan.permit.routeId,
        disabled: expectedDisabled,
        updateTime: plan.currentRouteUpdateTime,
      })
      .update({
        routeConfig: JSON.stringify(plan.expectedRouteConfig),
        disabled: 0,
        updateTime: plan.input.now,
      });
    const pricingAffected = await transaction("o_pricing_rule")
      .where({
        id: plan.permit.pricingRuleId,
        disabled: expectedDisabled,
        updateTime: plan.currentPricingUpdateTime,
      })
      .update({
        ruleConfig: JSON.stringify(plan.expectedPricingConfig),
        disabled: 0,
        updateTime: plan.input.now,
      });
    if (Number(routeAffected) !== 1 || Number(pricingAffected) !== 1) {
      fail("seedance25_probe_arm_conflict", "route/pricing arm CAS 失败，事务已回滚");
    }
    const [route, pricing] = await Promise.all([
      transaction("o_model_route").where({ id: plan.permit.routeId }).first(),
      transaction("o_pricing_rule").where({ id: plan.permit.pricingRuleId }).first(),
    ]);
    if (
      !route
      || !pricing
      || !sameJson(route.routeConfig, plan.expectedRouteConfig)
      || !sameJson(pricing.ruleConfig, plan.expectedPricingConfig)
    ) {
      fail("seedance25_probe_arm_readback_mismatch", "route/pricing arm 事务内精确回读不一致");
    }
    const certificationSnapshotSha256 = assertArmedSnapshot({ route, pricing, permit: plan.permit });
    if (certificationSnapshotSha256 !== plan.certificationSnapshotSha256) {
      fail("seedance25_probe_arm_snapshot_mismatch", "route/pricing arm snapshot 摘要不一致");
    }
    return certificationArmReceipt(plan, "apply");
  }));
}

function normalizeCertificationEvidenceInput(
  input: Seedance25CertificationEvidenceInput,
): NormalizedCertificationEvidenceInput {
  const now = Number(input.now ?? Date.now());
  if (!Number.isSafeInteger(now) || now <= 0) {
    fail("seedance25_certification_now_invalid", "Seedance 2.5 certification 当前时间无效");
  }
  const probeId = text(input.probeId);
  const taskId = text(input.taskId);
  if (!SAFE_ID.test(probeId) || !SAFE_ID.test(taskId)) {
    fail("seedance25_certification_identity_invalid", "probeId 或 taskId 格式无效");
  }
  const adminUserId = Number(positiveDecimal(input.adminUserId, "adminUserId"));
  let priceSource: URL;
  try {
    priceSource = new URL(text(input.priceSourceUrl));
  } catch {
    fail("seedance25_certification_price_source_invalid", "刊例价来源 URL 无效");
  }
  if (
    priceSource.protocol !== "https:"
    || priceSource.username
    || priceSource.password
    || !OFFICIAL_VOLCANO_PRICE_HOSTS.has(priceSource.hostname.toLowerCase())
    || !priceSource.pathname.startsWith("/docs/")
  ) {
    fail(
      "seedance25_certification_price_source_invalid",
      "刊例价来源必须是 volcengine.com 官方 /docs/ HTTPS 页面且不得含凭据",
    );
  }
  const priceSourceContentSha256 = text(input.priceSourceContentSha256).toLowerCase();
  if (!SHA256.test(priceSourceContentSha256)) {
    fail("seedance25_certification_price_digest_invalid", "刊例价页面内容摘要必须是小写 SHA-256");
  }
  const priceCheckedAt = canonicalUtcRfc3339(input.priceCheckedAt, "priceCheckedAt");
  const validUntil = canonicalUtcRfc3339(input.validUntil, "validUntil");
  if (priceCheckedAt.milliseconds > now) {
    fail("seedance25_certification_price_time_invalid", "priceCheckedAt 不能位于未来");
  }
  if (
    validUntil.milliseconds <= now
    || validUntil.milliseconds - priceCheckedAt.milliseconds
      > MODEL_ROUTE_CERTIFICATION_MAX_VALIDITY_MS
  ) {
    fail("seedance25_certification_validity_invalid", "认证有效期必须晚于当前时间且不超过刊例价核对后 180 天");
  }
  const upstreamCurrency = text(input.upstreamCurrency).toUpperCase();
  const upstreamUnitPriceMicros = Number(input.upstreamUnitPriceMicros);
  const billingCurrency = text(input.billingCurrency).toUpperCase();
  const billingDimension = text(input.billingDimension);
  if (
    upstreamCurrency !== "CNY"
    || upstreamUnitPriceMicros !== SEEDANCE_25_UPSTREAM_TOKEN_PRICES.withoutVideoInput
    || billingCurrency !== "GU"
    || billingDimension !== "token"
  ) {
    fail(
      "seedance25_certification_commercial_contract_invalid",
      "首次认证只接受 CNY 官方刊例、对应 GU 售价与 token 结算维度",
    );
  }
  const releaseId = text(input.releaseId);
  const sourceCommit = text(input.sourceCommit).toLowerCase();
  const artifactSha256 = text(input.artifactSha256).toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(releaseId)) {
    fail("seedance25_certification_release_id_invalid", "releaseId 格式无效");
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceCommit)) {
    fail("seedance25_certification_source_commit_invalid", "sourceCommit 必须是 40 或 64 位小写十六进制摘要");
  }
  if (!SHA256.test(artifactSha256)) {
    fail("seedance25_certification_artifact_sha256_invalid", "artifactSha256 必须是 64 位小写 SHA-256");
  }
  return {
    probeId,
    taskId,
    adminUserId,
    priceSourceUrl: priceSource.toString(),
    priceSourceContentSha256,
    priceCheckedAt: priceCheckedAt.milliseconds,
    upstreamCurrency: "CNY",
    upstreamUnitPriceMicros: SEEDANCE_25_UPSTREAM_TOKEN_PRICES.withoutVideoInput,
    billingCurrency: "GU",
    billingDimension: "token",
    releaseId,
    sourceCommit,
    artifactSha256,
    validUntil: validUntil.milliseconds,
    now,
  };
}

async function requireCertificationEvidenceSchema(
  database: Knex | Knex.Transaction,
): Promise<void> {
  const required = [
    "o_provider_channel",
    "o_model_route",
    "o_pricing_rule",
    "o_user",
    "o_project",
    "o_workspace",
    "o_relay_task",
    "o_usage_record",
    "o_billing_ledger",
    "o_billing_reconcile_job",
    "o_audit_log",
    MODEL_ROUTE_CERTIFICATION_TABLE,
    MODEL_ROUTE_CERTIFICATION_BATCH_TABLE,
  ];
  for (const tableName of required) {
    if (!(await database.schema.hasTable(tableName))) {
      fail("seedance25_certification_schema_missing", `首认证结算闭环缺少必需数据表 ${tableName}`);
    }
  }
}

function assertCertificationTaskEvidence(input: {
  task: DatabaseRow;
  pricing: DatabaseRow;
  permit: Seedance25CertificationProbePermit;
  now: number;
}): void {
  assertSeedance25PricingRuleReadback({
    provider: input.pricing.provider,
    model: input.pricing.model,
    unit: input.pricing.unit,
    currency: input.pricing.currency,
    baseUnitPriceMicros: input.pricing.unitPriceMicros,
    ruleConfig: input.pricing.ruleConfig,
  });
  const canonicalRequest = canonicalVideoGenerationRequest({
    version: VIDEO_GENERATION_REQUEST_VERSION,
    operation: "generate",
    modelRouteId: input.permit.routeId,
    prompt: SEEDANCE_25_CERTIFICATION_PROBE_PROMPT,
    aspectRatio: "16:9",
    durationSeconds: 4,
    outputResolution: "720p",
    generateAudio: false,
    preserveSourceAudio: false,
    inputs: [],
  });
  const expectedRequestPayload = {
    model: SEEDANCE_25_MODEL_ID,
    content: [{ type: "text", text: SEEDANCE_25_CERTIFICATION_PROBE_PROMPT }],
    generate_audio: false,
    ratio: "16:9",
    duration: 4,
    resolution: "720p",
    watermark: false,
  };
  const principalId = `seedance25-certification-admin:${input.permit.adminUserId}`;
  const providerPayload = record(input.task.providerPayload);
  const identity = record(providerPayload.identity);
  const submission = record(providerPayload.submission);
  const resultInternal = record(record(input.task.resultPayload).internal);
  const canonicalCheckpoint = record(resultInternal.canonicalVideoGeneration);
  const createdAt = Number(input.task.createTime);
  const taskSubmittedAt = Number(input.task.submittedAt);
  const durableDispatchStartedAt = Number(submission.dispatchStartedAt);
  const submittedAt = taskSubmittedAt > 0 ? taskSubmittedAt : durableDispatchStartedAt;
  const completedAt = Number(input.task.completedAt);
  const billingFinalizedAt = Number(submission.billingFinalizedAt);
  const leaseExpiresAt = input.task.leaseExpiresAt == null
    ? null
    : Number(input.task.leaseExpiresAt);
  const heartbeatAt = input.task.heartbeatAt == null
    ? null
    : Number(input.task.heartbeatAt);
  if (
    text(input.task.status) !== "succeeded"
    || !text(input.task.providerTaskId)
    || text(input.task.workspaceId) !== input.permit.workspaceId
    || text(input.task.projectId) !== input.permit.projectId
    || text(input.task.endpointType) !== "video_generation"
    || text(input.task.provider) !== "volcano"
    || text(input.task.channelId) !== input.permit.channelId
    || text(input.task.model) !== SEEDANCE_25_MODEL_ID
    || input.task.apiKeyId != null
    || text(input.task.requestId) !== seedance25CertificationProbeScopedRequestId({
      probeId: input.permit.probeId,
      adminUserId: input.permit.adminUserId,
    })
    || !sameJson(input.task.requestPayload, expectedRequestPayload)
    || identity.principalId !== principalId
    || identity.subject !== `principal:${principalId}`
    || !sameJson(resultInternal.seedance25CertificationProbe, input.permit)
    || canonicalCheckpoint.digest !== videoGenerationRequestDigest(canonicalRequest)
    || !sameJson(canonicalCheckpoint.request, canonicalRequest)
    || text(submission.state) !== "captured"
    || !Number.isSafeInteger(createdAt)
    || createdAt < Date.parse(input.permit.createdAt)
    || createdAt > Date.parse(input.permit.expiresAt)
    || !Number.isSafeInteger(submittedAt)
    || submittedAt < createdAt
    || submittedAt >= Date.parse(input.permit.expiresAt)
    || (taskSubmittedAt > 0 && durableDispatchStartedAt > 0 && taskSubmittedAt !== durableDispatchStartedAt)
    || !Number.isSafeInteger(completedAt)
    || completedAt < submittedAt
    || completedAt > input.now
    || !Number.isSafeInteger(billingFinalizedAt)
    || billingFinalizedAt < submittedAt
    || billingFinalizedAt > completedAt
    || input.task.leaseOwner != null
    || (
      leaseExpiresAt != null
      && (
        !Number.isSafeInteger(leaseExpiresAt)
        || leaseExpiresAt > completedAt
      )
    )
    || (
      heartbeatAt != null
      && (
        !Number.isSafeInteger(heartbeatAt)
        || heartbeatAt > completedAt
      )
    )
  ) {
    fail(
      "seedance25_certification_task_evidence_invalid",
      "首认证 task 不是 permit 内创建并派发的固定 text-only / 720p / 4 秒真实 succeeded 任务",
    );
  }
}

function assertCertificationBillingEvidence(input: {
  task: DatabaseRow;
  usageRows: DatabaseRow[];
  ledgerRows: DatabaseRow[];
  reconcileRows: DatabaseRow[];
  permit: Seedance25CertificationProbePermit;
}): { usage: DatabaseRow; completionTokens: number; chargedCostMicros: number } {
  if (input.usageRows.length !== 1) {
    fail("seedance25_certification_usage_ambiguous", "首认证 task 必须且只能关联一条 usage");
  }
  const usage = input.usageRows[0];
  const completionTokens = Number(usage.units);
  const chargedCostMicros = Number(usage.costMicros);
  if (
    text(usage.taskId) !== text(input.task.id)
    || text(usage.workspaceId) !== input.permit.workspaceId
    || text(usage.provider) !== "volcano"
    || text(usage.channelId) !== input.permit.channelId
    || text(usage.endpointType) !== "video_generation"
    || text(usage.model) !== SEEDANCE_25_MODEL_ID
    || text(usage.status) !== "charged"
    || text(usage.unit) !== "token"
    || text(usage.currency).toUpperCase() !== "GU"
    || !Number.isSafeInteger(completionTokens)
    || completionTokens <= 0
    || !Number.isSafeInteger(chargedCostMicros)
    || chargedCostMicros !== completionTokens * SEEDANCE_25_TOKEN_PRICES.withoutVideoInput
    || Number(input.task.costMicros) !== chargedCostMicros
  ) {
    fail(
      "seedance25_certification_usage_invalid",
      "首认证 usage 未按真实 usage.completion_tokens 和配置的 GU 售价完成 charged 结算",
    );
  }
  const freezes = input.ledgerRows.filter((row) => text(row.type) === "freeze");
  if (freezes.length !== 1) {
    fail("seedance25_certification_freeze_ambiguous", "首认证 task 必须且只能有一条 GU freeze");
  }
  const freeze = freezes[0];
  const freezeAmount = Number(freeze.amountMicros);
  const freezeMetadata = record(freeze.metadata);
  const priceSnapshot = record(freezeMetadata.priceSnapshot);
  const captures = input.ledgerRows.filter((row) => (
    text(row.type) === "deduct" && text(row.relatedLedgerId) === text(freeze.id)
  ));
  const releases = input.ledgerRows.filter((row) => (
    text(row.type) === "release" && text(row.relatedLedgerId) === text(freeze.id)
  ));
  if (
    text(freeze.workspaceId) !== input.permit.workspaceId
    || text(freeze.relatedTaskId) !== text(input.task.id)
    || text(freeze.relatedUsageId) !== text(usage.id)
    || text(freeze.currency).toUpperCase() !== "GU"
    || !Number.isSafeInteger(freezeAmount)
    || freezeAmount < chargedCostMicros
    || Number(freeze.remainingMicros) !== 0
    || !["captured", "released"].includes(text(freeze.status))
    || text(priceSnapshot.pricingRuleId) !== input.permit.pricingRuleId
    || text(priceSnapshot.unit) !== "token"
    || Number(priceSnapshot.unitPriceMicros) !== SEEDANCE_25_TOKEN_PRICES.withoutVideoInput
    || captures.length !== 1
  ) {
    fail("seedance25_certification_ledger_invalid", "首认证 GU freeze/capture 结算链不完整或定价快照不一致");
  }
  const capture = captures[0];
  const captureMetadata = record(capture.metadata);
  if (
    text(capture.status) !== "succeeded"
    || text(capture.workspaceId) !== input.permit.workspaceId
    || text(capture.relatedTaskId) !== text(input.task.id)
    || text(capture.relatedUsageId) !== text(usage.id)
    || text(capture.currency).toUpperCase() !== "GU"
    || Number(capture.amountMicros) !== chargedCostMicros
    || text(captureMetadata.providerTaskId) !== text(input.task.providerTaskId)
    || text(captureMetadata.authoritativeUsagePath) !== "usage.completion_tokens"
    || Number(captureMetadata.completionTokens) !== completionTokens
    || captureMetadata.settlementEvidenceComplete !== true
    || text(captureMetadata.settlementUnit) !== "token"
  ) {
    fail("seedance25_certification_capture_invalid", "首认证 deduct 缺少可信上游终态 token usage 证据");
  }
  const expectedRelease = freezeAmount - chargedCostMicros;
  if (
    (expectedRelease === 0 && releases.length !== 0)
    || (
      expectedRelease > 0
      && (
        releases.length !== 1
        || text(releases[0].status) !== "succeeded"
        || Number(releases[0].amountMicros) !== expectedRelease
        || text(releases[0].relatedUsageId) !== text(usage.id)
      )
    )
    || input.reconcileRows.length === 0
    || input.reconcileRows.some((row) => text(row.status) !== "resolved")
  ) {
    fail("seedance25_certification_settlement_incomplete", "首认证冻结差额或 billing reconcile 尚未闭合");
  }
  return { usage, completionTokens, chargedCostMicros };
}

export async function certifySeedance25CertificationProbe(
  database: Knex,
  input: Seedance25CertificationEvidenceInput,
): Promise<Seedance25CertificationReceipt> {
  const normalized = normalizeCertificationEvidenceInput(input);
  return serializeMutation(async () => database.transaction(async (transaction) => {
    if (isPostgresClient(transaction)) {
      await transaction.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    }
    // Fence acquisition is the first database lock and establishes the
    // repeatable snapshot. The narrow SRE protects only the non-unique exact
    // route/pricing selectors from generic admin phantom inserts.
    await acquireModelRouteCertificationAdvisoryFence(transaction);
    await requireCertificationEvidenceSchema(transaction);
    await lockTables(transaction);
    const rows = await lockedExactRouteAndPricing(transaction);
    if (rows.routes.length !== 1 || rows.pricingRules.length !== 1) {
      fail("seedance25_certification_exact_rows_invalid", "首认证要求唯一 exact Seedance 2.5 route/pricing");
    }
    const route = rows.routes[0];
    const pricing = rows.pricingRules[0];
    const permit = assertPersistedCertificationProbePermit(
      record(route.routeConfig).certificationProbe,
    );
    if (
      permit.probeId !== normalized.probeId
      || Number(permit.adminUserId) !== normalized.adminUserId
    ) {
      fail("seedance25_certification_permit_scope_mismatch", "certification 输入与不可变 permit 身份不一致");
    }
    assertArmedSnapshot({ route, pricing, permit });
    // A succeeded task with captured submission and a released mutation lease
    // is immutable. Read task/accounting as one REPEATABLE READ snapshot and
    // never lock customer billing rows; a still-open settlement simply fails
    // closed and the operator retries certification after closure.
    const task = await transaction("o_relay_task")
      .where({ id: normalized.taskId })
      .first();
    if (!task) fail("seedance25_certification_task_missing", "首认证 relay task 不存在");
    assertCertificationTaskEvidence({ task, pricing, permit, now: normalized.now });
    const usageRows = await transaction("o_usage_record")
      .where({ taskId: normalized.taskId });
    const ledgerRows = await transaction("o_billing_ledger")
      .where({ relatedTaskId: normalized.taskId });
    const reconcileRows = await transaction("o_billing_reconcile_job").where({
      workspaceId: permit.workspaceId,
      requestId: text(task.requestId),
    });
    const billing = assertCertificationBillingEvidence({
      task,
      usageRows,
      ledgerRows,
      reconcileRows,
      permit,
    });
    const certification = await executeModelRouteCertificationBatch({
      database: transaction as unknown as Knex,
      mode: "apply",
      now: normalized.now,
      batch: {
        format: MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
        batchId: `seedance25-certification:${permit.probeId}`,
        releaseId: normalized.releaseId,
        sourceCommit: normalized.sourceCommit,
        actorUserId: normalized.adminUserId,
        entries: [{
          routeId: permit.routeId,
          pricingRuleId: permit.pricingRuleId,
          operationKey: MODEL_ROUTE_BASE_OPERATION,
          priceSourceUrl: normalized.priceSourceUrl,
          priceSourceDigest: normalized.priceSourceContentSha256,
          priceCheckedAt: normalized.priceCheckedAt,
          upstreamCurrency: normalized.upstreamCurrency,
          upstreamUnitPriceMicros: normalized.upstreamUnitPriceMicros,
          billingCurrency: normalized.billingCurrency,
          billingDimension: normalized.billingDimension,
          taskEvidenceId: text(task.id),
          usageEvidenceId: text(billing.usage.id),
          validUntil: normalized.validUntil,
        }],
      },
    });
    const readiness = await evaluateModelRouteCertification({
      database: transaction,
      route,
      pricingRule: pricing,
      now: normalized.now,
    });
    if (!readiness.valid || readiness.hiddenFromUserCatalog) {
      fail(
        "seedance25_certification_readback_invalid",
        readiness.reason || "Seedance 2.5 certification 精确回读未通过",
      );
    }
    return {
      version: "seedance-2.5-certification/v1",
      probeId: permit.probeId,
      taskId: text(task.id),
      usageEvidenceId: text(billing.usage.id),
      completionTokens: billing.completionTokens,
      chargedCostMicros: billing.chargedCostMicros,
      artifactSha256: normalized.artifactSha256,
      certification,
      routeCertificationValid: true,
      completedAt: normalized.now,
    };
  }));
}

function operatorTaskProjection(task: Seedance25CertificationProbeTask): Seedance25CertificationOperatorReceipt["task"] {
  return {
    id: task.id,
    status: task.status,
    providerTaskId: task.providerTaskId,
    completedAt: task.completedAt,
  };
}

function operatorTaskRequiresReconciliation(task: Seedance25CertificationProbeTask): boolean {
  return task.status === "pending_reconcile" || taskRequiresReconciliationRecord(task);
}

function formatCertificationProbeTask(row: DatabaseRow): Seedance25CertificationProbeTask {
  return {
    id: text(row.id),
    workspaceId: text(row.workspaceId) || null,
    projectId: row.projectId == null ? null : Number(row.projectId),
    requestId: text(row.requestId) || null,
    endpointType: text(row.endpointType),
    provider: text(row.provider) || null,
    channelId: text(row.channelId) || null,
    model: text(row.model) || null,
    status: text(row.status),
    requestPayload: record(row.requestPayload),
    providerPayload: record(row.providerPayload),
    providerTaskId: text(row.providerTaskId) || null,
    resultPayload: record(row.resultPayload),
    errorMessage: text(row.errorMessage) || null,
    createTime: Number(row.createTime),
    updateTime: Number(row.updateTime),
    submittedAt: row.submittedAt == null ? null : Number(row.submittedAt),
    completedAt: row.completedAt == null ? null : Number(row.completedAt),
  };
}

async function findExistingCertificationProbeTask(
  database: Knex,
  permit: Seedance25CertificationProbePermit,
): Promise<Seedance25CertificationProbeTask | null> {
  const rows = await database("o_relay_task")
    .where({
      workspaceId: permit.workspaceId,
      projectId: Number(permit.projectId),
      endpointType: "video_generation",
      provider: "volcano",
      channelId: permit.channelId,
      model: SEEDANCE_25_MODEL_ID,
    })
    .orderBy("createTime", "asc");
  const matches = rows.filter((row) => sameJson(
    record(record(row.resultPayload).internal).seedance25CertificationProbe,
    permit,
  ));
  if (matches.length > 1) {
    fail("seedance25_certification_operator_task_ambiguous", "同一 probeId 关联多个 Relay task");
  }
  return matches[0] ? formatCertificationProbeTask(matches[0]) : null;
}

async function operatorTaskHasPendingBilling(
  database: Knex,
  task: Seedance25CertificationProbeTask,
): Promise<boolean> {
  if (!["succeeded", "failed", "cancelled", "pending_reconcile"].includes(task.status)) return false;
  const [usageRows, openFreeze, reconcileRows] = await Promise.all([
    database("o_usage_record").where({ taskId: task.id }),
    database("o_billing_ledger")
      .where({ relatedTaskId: task.id, type: "freeze" })
      .where("remainingMicros", ">", 0)
      .first(),
    task.requestId && task.workspaceId
      ? database("o_billing_reconcile_job").where({
          workspaceId: task.workspaceId,
          requestId: task.requestId,
        })
      : Promise.resolve([]),
  ]);
  return Boolean(
    openFreeze
    || usageRows.some((row) => ["pending", "reserved", "pending_reconcile"].includes(text(row.status)))
    || reconcileRows.some((row) => text(row.status) !== "resolved"),
  );
}

export async function validateSeedance25CertificationOperatorPlan(
  database: Knex,
  input: {
    arm: Seedance25CertificationProbeArmInput;
    certification: Omit<Seedance25CertificationEvidenceInput, "taskId">;
  },
): Promise<Seedance25CertificationOperatorPlanReceipt> {
  const armPlan = await database.transaction(async (transaction) => (
    planCertificationArmInsideTransaction(transaction, input.arm, {
      allowPredispatchCancellationPending: true,
    })
  ));
  const arm = certificationArmReceipt(armPlan, "validate");
  const certification = normalizeCertificationEvidenceInput({
    ...input.certification,
    taskId: `seedance25-certification-plan:${arm.permit.probeId}`,
  });
  if (
    certification.probeId !== arm.permit.probeId
    || certification.adminUserId !== Number(arm.permit.adminUserId)
  ) {
    fail("seedance25_certification_plan_scope_mismatch", "arm 与 certification 声明的 probe/admin 身份不一致");
  }
  return {
    version: "seedance-2.5-certification-operator-plan/v1",
    mode: "validate",
    valid: true,
    arm,
    priceSourceUrl: certification.priceSourceUrl,
    priceSourceContentSha256: certification.priceSourceContentSha256,
    priceCheckedAt: certification.priceCheckedAt,
    releaseId: certification.releaseId,
    sourceCommit: certification.sourceCommit,
    artifactSha256: certification.artifactSha256,
    validUntil: certification.validUntil,
    recoveryCancellationTaskId: armPlan.recoveryCancellationTaskId,
    productionTrafficEnabled: false,
    completedAt: certification.now,
  };
}

export async function runSeedance25CertificationOperator(
  input: Seedance25CertificationOperatorInput,
): Promise<Seedance25CertificationOperatorReceipt> {
  if (
    !Number.isSafeInteger(input.pollIntervalMs)
    || input.pollIntervalMs < 250
    || input.pollIntervalMs > 60_000
    || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < input.pollIntervalMs
    || input.timeoutMs > 30 * 60_000
  ) {
    fail("seedance25_certification_operator_timing_invalid", "pollIntervalMs/timeoutMs 超出安全范围");
  }
  const runtimeNow = () => Number(input.runtime.now?.() ?? Date.now());
  const sleep = input.runtime.sleep || ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const recoveryPlan = await input.database.transaction(async (transaction) => (
    planCertificationArmInsideTransaction(transaction, input.arm, {
      allowPredispatchCancellationPending: true,
    })
  ));
  if (recoveryPlan.recoveryCancellationTaskId) {
    if (!input.runtime.cancel) {
      fail(
        "seedance25_probe_recovery_cancel_runtime_missing",
        "expired pre-dispatch recovery 必须由 Relay 账务域 cancel runtime 执行",
      );
    }
    const cancellation = await input.runtime.cancel(recoveryPlan.recoveryCancellationTaskId);
    if (
      cancellation.deleted
      || !cancellation.cancelled
      || !cancellation.task
      || cancellation.task.id !== recoveryPlan.recoveryCancellationTaskId
      || cancellation.task.status !== "cancelled"
      || taskHasDispatchEvidence(cancellation.task)
    ) {
      fail(
        "seedance25_probe_recovery_cancel_incomplete",
        "Relay 未完成无 dispatch 的安全取消；禁止 rearm 或再次 POST",
      );
    }
  }
  const arm = await armSeedance25CertificationProbe(input.database, input.arm);
  const startedAt = runtimeNow();
  const permitExpiresAt = Date.parse(arm.permit.expiresAt);
  const existingTask = await findExistingCertificationProbeTask(input.database, arm.permit);
  if (!existingTask && startedAt >= permitExpiresAt) {
    fail(
      "seedance25_certification_operator_permit_expired_before_task",
      "probe permit 已过期且从未创建 task；必须使用新 probe 和 controlled recovery acknowledgement rearm",
    );
  }
  let task = existingTask || await input.runtime.create(arm.permit.probeId);
  const taskId = task.id;
  if (!SAFE_ID.test(taskId)) {
    fail("seedance25_certification_operator_task_invalid", "Relay 返回的 probe taskId 无效");
  }
  const deadline = startedAt + input.timeoutMs;
  while (true) {
    const now = runtimeNow();
    if (task.id !== taskId) {
      fail("seedance25_certification_operator_task_changed", "operator 轮询期间禁止切换 probe task");
    }
    const pendingReconciliation = operatorTaskRequiresReconciliation(task)
      || await operatorTaskHasPendingBilling(input.database, task);
    if (pendingReconciliation) {
      const readOnly = await input.runtime.refresh(task, { providerReadOnly: true });
      if (readOnly.id !== taskId) {
        fail("seedance25_certification_operator_task_changed", "只读核账轮询返回了不同 task");
      }
      task = readOnly;
      if (
        operatorTaskRequiresReconciliation(task)
        || await operatorTaskHasPendingBilling(input.database, task)
      ) {
        return {
          version: "seedance-2.5-certification-operator/v1",
          probeId: arm.permit.probeId,
          state: "pending_reconcile",
          arm,
          task: operatorTaskProjection(task),
          certification: null,
          reason: task.errorMessage || "probe task 需要人工核账，已禁止再次 POST",
          completedAt: now,
        };
      }
      continue;
    }
    if (task.status === "succeeded") {
      const certification = await certifySeedance25CertificationProbe(input.database, {
        ...input.certification,
        probeId: arm.permit.probeId,
        taskId,
        now,
      });
      return {
        version: "seedance-2.5-certification-operator/v1",
        probeId: arm.permit.probeId,
        state: "certified",
        arm,
        task: operatorTaskProjection(task),
        certification,
        reason: null,
        completedAt: now,
      };
    }
    if (["failed", "cancelled"].includes(task.status)) {
      return {
        version: "seedance-2.5-certification-operator/v1",
        probeId: arm.permit.probeId,
        state: "failed",
        arm,
        task: operatorTaskProjection(task),
        certification: null,
        reason: task.errorMessage || `probe task ${task.status}`,
        completedAt: now,
      };
    }
    if (now >= deadline) {
      return {
        version: "seedance-2.5-certification-operator/v1",
        probeId: arm.permit.probeId,
        state: "pending",
        arm,
        task: operatorTaskProjection(task),
        certification: null,
        reason: "probe task 在本次 operator 超时内尚未终态；可用同一 probeId 安全续跑",
        completedAt: now,
      };
    }
    if (now >= permitExpiresAt && !taskHasDispatchEvidence(task)) {
      return {
        version: "seedance-2.5-certification-operator/v1",
        probeId: arm.permit.probeId,
        state: "failed",
        arm,
        task: operatorTaskProjection(task),
        certification: null,
        reason: "probe permit 已过期且 task 从未 dispatch；已禁止 POST，请 controlled rearm",
        completedAt: now,
      };
    }
    const persisted = await input.runtime.get(taskId);
    if (!persisted || persisted.id !== taskId) {
      fail("seedance25_certification_operator_task_missing", "operator 轮询时既有 probe task 丢失");
    }
    task = ["queued", "running"].includes(persisted.status)
      ? await input.runtime.refresh(
          persisted,
          now >= permitExpiresAt ? { providerReadOnly: true } : undefined,
        )
      : persisted;
    await sleep(Math.min(input.pollIntervalMs, Math.max(0, deadline - runtimeNow())));
  }
}
