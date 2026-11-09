import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { MODEL_ROUTE_CERTIFICATION_TABLE } from "@/lib/migrations/modelRouteCertification";
import { selectPreferredModelRouteScope } from "@/lib/modelRouteScope";
import { acquireModelRouteCertificationAdvisoryFence } from "@/lib/modelRouteCertificationMutationFence";
import { getKnexClientName } from "@/lib/dbDialect";
import { normalizeVideoResolution } from "@/lib/videoResolutions";
import { volcengineImageQualityForSize } from "@/lib/volcengineImageSize";
import { findVolcengineModel } from "@/lib/volcengineModelManifest";
import {
  evaluateVideoDeliveryProof,
  type PublicVideoDeliveryProof,
} from "@/lib/videoFulfillment/deliveryProof";
import {
  FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID,
  fanjinValueVideoOfferDefinition,
} from "@/lib/fanjinValueVideoOffers";
import {
  parseFanjinValueVideoPricingContract,
} from "@/lib/fanjinValueVideoPricing";
import {
  applyPricingAudienceForWorkspace,
  pricingCertificationRuleConfig,
  PRICING_AUDIENCE_EFFECTIVE_KEY,
} from "@/lib/pricingAudience";

export type ModelRouteCertificationDatabase = Knex | Knex.Transaction;

export const MODEL_ROUTE_BASE_OPERATION = "route" as const;
export const MODEL_ROUTE_CERTIFICATION_MAX_VALIDITY_MS = 180 * 24 * 60 * 60 * 1_000;

export type ModelRouteCertificationStatus =
  | "valid"
  | "missing"
  | "revoked"
  | "expired"
  | "route_changed"
  | "pricing_changed"
  | "evidence_invalid"
  | "invalid";

export interface ModelRouteCertificationRecord {
  id: string;
  routeId: string;
  pricingRuleId: string;
  operationKey: string;
  batchId: string;
  releaseId: string | null;
  sourceCommit: string | null;
  priceSourceUrl: string;
  priceSourceDigest: string;
  priceCheckedAt: number;
  upstreamCurrency: string;
  upstreamUnitPriceMicros: number;
  billingCurrency: string;
  billingDimension: string;
  taskEvidenceId: string;
  usageEvidenceId: string;
  routeSnapshotHash: string;
  pricingSnapshotHash: string;
  certifiedByUserId: number;
  certifiedAt: number;
  validUntil: number;
  revokedByUserId: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ModelRouteCertificationOperationStatus {
  operationKey: string;
  required: true;
  status: ModelRouteCertificationStatus;
  valid: boolean;
  reason: string | null;
  certification: ModelRouteCertificationRecord | null;
  /** Present only for certified 2K/4K video operations. Contains no supplier identity. */
  deliveryProof?: PublicVideoDeliveryProof | null;
}

export interface ModelRouteCertificationReadiness {
  certificationVersion: "model-route-certification/v1";
  tableReady: boolean;
  routeId: string;
  pricingRuleId: string | null;
  valid: boolean;
  hiddenFromUserCatalog: boolean;
  reason: string | null;
  requiredOperations: string[];
  operations: ModelRouteCertificationOperationStatus[];
}

export interface ModelRouteCertificationStableProjection {
  certificationVersion: "model-route-certification/v1";
  tableReady: boolean;
  routeId: string;
  pricingRuleId: string | null;
  valid: boolean;
  operations: Array<{
    operationKey: string;
    status: ModelRouteCertificationStatus;
    certificationId: string | null;
    batchId: string | null;
    releaseId: string | null;
    sourceCommit: string | null;
    priceSourceDigest: string | null;
    priceCheckedAt: number | null;
    upstreamCurrency: string | null;
    upstreamUnitPriceMicros: number | null;
    billingCurrency: string | null;
    billingDimension: string | null;
    taskEvidenceId: string | null;
    usageEvidenceId: string | null;
    routeSnapshotHash: string | null;
    pricingSnapshotHash: string | null;
    certifiedByUserId: number | null;
    certifiedAt: number | null;
    validUntil: number | null;
    revokedAt: number | null;
  }>;
}

/** Stable, secret-free release fingerprint projection. */
export function modelRouteCertificationStableProjection(
  readiness: ModelRouteCertificationReadiness,
): ModelRouteCertificationStableProjection {
  return {
    certificationVersion: readiness.certificationVersion,
    tableReady: readiness.tableReady,
    routeId: readiness.routeId,
    pricingRuleId: readiness.pricingRuleId,
    valid: readiness.valid,
    operations: readiness.operations.map((operation) => ({
      operationKey: operation.operationKey,
      status: operation.status,
      certificationId: operation.certification?.id ?? null,
      batchId: operation.certification?.batchId ?? null,
      releaseId: operation.certification?.releaseId ?? null,
      sourceCommit: operation.certification?.sourceCommit ?? null,
      priceSourceDigest: operation.certification?.priceSourceDigest ?? null,
      priceCheckedAt: operation.certification?.priceCheckedAt ?? null,
      upstreamCurrency: operation.certification?.upstreamCurrency ?? null,
      upstreamUnitPriceMicros: operation.certification?.upstreamUnitPriceMicros ?? null,
      billingCurrency: operation.certification?.billingCurrency ?? null,
      billingDimension: operation.certification?.billingDimension ?? null,
      taskEvidenceId: operation.certification?.taskEvidenceId ?? null,
      usageEvidenceId: operation.certification?.usageEvidenceId ?? null,
      routeSnapshotHash: operation.certification?.routeSnapshotHash ?? null,
      pricingSnapshotHash: operation.certification?.pricingSnapshotHash ?? null,
      certifiedByUserId: operation.certification?.certifiedByUserId ?? null,
      certifiedAt: operation.certification?.certifiedAt ?? null,
      validUntil: operation.certification?.validUntil ?? null,
      revokedAt: operation.certification?.revokedAt ?? null,
    })),
  };
}

export interface CertifyModelRouteInput {
  routeId: string;
  pricingRuleId: string;
  operationKey: string;
  batchId?: string;
  releaseId?: string | null;
  sourceCommit?: string | null;
  priceSourceUrl: string;
  priceSourceDigest: string;
  priceCheckedAt: number;
  upstreamCurrency: string;
  upstreamUnitPriceMicros: number;
  billingCurrency: string;
  billingDimension: string;
  taskEvidenceId: string;
  usageEvidenceId: string;
  validUntil: number;
  certifiedByUserId: number;
  now?: number;
}

export class ModelRouteCertificationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = "model_route_certification_invalid") {
    super(message);
    this.name = "ModelRouteCertificationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

type DatabaseRow = Record<string, any>;

function finiteInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
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

/**
 * Local development can test a first task before production certification.
 * PostgreSQL must be a loopback database explicitly named for local development.
 * No production certification evidence is created by this path.
 */
export function isLocalDevelopmentUncertifiedModelRouteAllowed(input: {
  database: ModelRouteCertificationDatabase;
  route: Record<string, unknown>;
  environment?: Record<string, string | undefined>;
}): boolean {
  const environment = input.environment ?? process.env;
  if (!["dev", "development"].includes(String(environment.NODE_ENV || "").trim().toLowerCase())) return false;
  if (String(environment.FANJIN_DEV_ALLOW_UNCERTIFIED_MODEL_ROUTES || "").trim() !== "1") return false;
  if (!["127.0.0.1", "::1"].includes(String(environment.FANJIN_BIND_HOST || "").trim())) return false;
  const clientName = getKnexClientName(input.database);
  if (["pg", "postgres", "postgresql"].includes(clientName)) {
    const connection = input.database.client.config.connection;
    let host: string;
    let database: string;
    if (typeof connection === "string") {
      try {
        const url = new URL(connection);
        host = url.hostname;
        database = url.pathname.slice(1);
      } catch { return false; }
    } else if (connection && typeof connection === "object") {
      host = String(connection.host || "");
      database = String(connection.database || "");
    } else return false;
    if (!["127.0.0.1", "::1", "[::1]"].includes(host) || !database.startsWith("fanjin_local_")) return false;
  } else if (!["sqlite", "sqlite3", "better-sqlite3"].includes(clientName)) return false;
  return record(input.route.routeConfig).localDevelopmentOnly === true;
}

function codeUnitCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => codeUnitCompare(left, right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

export function modelRouteCertificationRouteSnapshotHash(route: DatabaseRow): string {
  return digest({
    id: text(route.id),
    scope: text(route.scope),
    workspaceId: text(route.workspaceId) || null,
    endpointType: text(route.endpointType),
    model: text(route.model),
    provider: text(route.provider) || null,
    channelId: text(route.channelId) || null,
    priority: finiteInteger(route.priority),
    fallbackOrder: finiteInteger(route.fallbackOrder),
    routeConfig: record(route.routeConfig),
    disabled: Number(route.disabled || 0),
    updateTime: finiteInteger(route.updateTime),
  });
}

export function modelRouteCertificationPricingSnapshotHash(rule: DatabaseRow): string {
  return digest({
    id: text(rule.id),
    scope: text(rule.scope),
    workspaceId: text(rule.workspaceId) || null,
    endpointType: text(rule.endpointType),
    provider: text(rule.provider) || null,
    model: text(rule.model) || null,
    unit: text(rule.unit),
    unitPriceMicros: finiteInteger(rule.unitPriceMicros),
    currency: text(rule.currency).toUpperCase(),
    ruleConfig: pricingCertificationRuleConfig(rule.ruleConfig),
    disabled: Number(rule.disabled || 0),
    updateTime: finiteInteger(rule.updateTime),
  });
}

function runtimePricingSnapshotHash(rule: DatabaseRow): string {
  return digest({
    id: text(rule.id),
    scope: text(rule.scope),
    workspaceId: text(rule.workspaceId) || null,
    endpointType: text(rule.endpointType),
    provider: text(rule.provider) || null,
    model: text(rule.model) || null,
    unit: text(rule.unit),
    unitPriceMicros: finiteInteger(rule.unitPriceMicros),
    currency: text(rule.currency).toUpperCase(),
    ruleConfig: record(rule.ruleConfig),
    disabled: Number(rule.disabled || 0),
    updateTime: finiteInteger(rule.updateTime),
  });
}

export interface FanjinValueVideoGenerationCostEvidence {
  version: "fanjin-value-video-generation-cost-evidence/v1";
  publicModel: string;
  upstreamModel: string;
  routeId: string;
  routeSnapshotHash: string;
  routeUpdatedAt: number;
  pricingRuleId: string;
  pricingSnapshotHash: string;
  pricingUpdatedAt: number;
  unitPriceMicros: number;
  reservationUpperBoundTokens: number;
  videoInputPricing: Record<string, unknown>;
  videoInputPricingSource:
    | "source-rule-explicit"
    | "source-rule-legacy-single-price-equivalent";
  certificationId: string;
  batchId: string;
  priceSourceDigest: string;
  priceCheckedAt: number;
  upstreamCurrency: string;
  upstreamUnitPriceMicros: number;
  billingCurrency: string;
  billingDimension: string;
  taskEvidenceId: string;
  usageEvidenceId: string;
  certifiedAt: number;
  validUntil: number;
  taskCompletedAt: number;
  usageUnits: number;
  usageCostMicros: number;
  routeConfig: Record<string, unknown>;
}

/**
 * Canonical cost evidence shared by the operator that creates a managed
 * 480p -> 720p offer and the admission path that keeps it visible.  The
 * digest deliberately binds the source route, source price, current source
 * certification, successful provider task and charged usage row.
 */
export function fanjinValueVideoGenerationCostEvidence(input: {
  publicModel: string;
  upstreamModel: string;
  route: DatabaseRow;
  pricingRule: DatabaseRow;
  certification: ModelRouteCertificationRecord;
  task: DatabaseRow;
  usage: DatabaseRow;
}): {
  evidence: FanjinValueVideoGenerationCostEvidence;
  sha256: string;
} {
  const config = record(input.pricingRule.ruleConfig);
  const configuredVideoInputPricing = record(config.videoInputPricing);
  const reservationUpperBoundTokens = finiteInteger(config.reservationUpperBoundTokens);
  const unitPriceMicros = finiteInteger(input.pricingRule.unitPriceMicros);
  const routeUpdatedAt = finiteInteger(input.route.updateTime);
  const pricingUpdatedAt = finiteInteger(input.pricingRule.updateTime);
  const taskCompletedAt = finiteInteger(input.task.completedAt);
  const usageUnits = finiteInteger(input.usage.units);
  const usageCostMicros = finiteInteger(input.usage.costMicros);
  if (
    reservationUpperBoundTokens === null
    || reservationUpperBoundTokens <= 0
    || unitPriceMicros === null
    || unitPriceMicros <= 0
    || routeUpdatedAt === null
    || pricingUpdatedAt === null
    || taskCompletedAt === null
    || taskCompletedAt <= 0
    || usageUnits === null
    || usageUnits <= 0
    || usageCostMicros === null
    || usageCostMicros <= 0
  ) {
    throw new ModelRouteCertificationError(
      "繁境特价版原生生成成本证据缺少有效的价格、任务或 usage 数值",
    );
  }
  const videoInputPricingSource = Object.keys(configuredVideoInputPricing).length > 0
    ? "source-rule-explicit" as const
    : "source-rule-legacy-single-price-equivalent" as const;
  const videoInputPricing = Object.keys(configuredVideoInputPricing).length > 0
    ? configuredVideoInputPricing
    : {
        withVideoInput: {
          unitPriceMicros,
          multiplier: Number(config.multiplier ?? 1),
          minimumMicros: Number(config.minimumMicros ?? 0),
          reservationUpperBoundTokens,
        },
        withoutVideoInput: {
          unitPriceMicros,
          multiplier: Number(config.multiplier ?? 1),
          minimumMicros: Number(config.minimumMicros ?? 0),
          reservationUpperBoundTokens,
        },
      };
  const evidence: FanjinValueVideoGenerationCostEvidence = {
    version: "fanjin-value-video-generation-cost-evidence/v1",
    publicModel: text(input.publicModel),
    upstreamModel: text(input.upstreamModel),
    routeId: text(input.route.id),
    routeSnapshotHash: modelRouteCertificationRouteSnapshotHash(input.route),
    routeUpdatedAt,
    pricingRuleId: text(input.pricingRule.id),
    pricingSnapshotHash: modelRouteCertificationPricingSnapshotHash(input.pricingRule),
    pricingUpdatedAt,
    unitPriceMicros,
    reservationUpperBoundTokens,
    videoInputPricing,
    videoInputPricingSource,
    certificationId: input.certification.id,
    batchId: input.certification.batchId,
    priceSourceDigest: input.certification.priceSourceDigest,
    priceCheckedAt: input.certification.priceCheckedAt,
    upstreamCurrency: input.certification.upstreamCurrency,
    upstreamUnitPriceMicros: input.certification.upstreamUnitPriceMicros,
    billingCurrency: input.certification.billingCurrency,
    billingDimension: input.certification.billingDimension,
    taskEvidenceId: text(input.task.id),
    usageEvidenceId: text(input.usage.id),
    certifiedAt: input.certification.certifiedAt,
    validUntil: input.certification.validUntil,
    taskCompletedAt,
    usageUnits,
    usageCostMicros,
    routeConfig: record(input.route.routeConfig),
  };
  return { evidence, sha256: digest(evidence) };
}

function routeConfigArrayCandidates(
  route: DatabaseRow,
  keys: string[],
  parameterNames: string[],
): unknown[] {
  const config = record(route.routeConfig);
  const capabilities = record(config.capabilities);
  const parameters = record(capabilities.parameters);
  return [
    ...keys.map((key) => config[key]),
    ...keys.map((key) => capabilities[key]),
    ...parameterNames.flatMap((parameterName) => {
      const parameter = record(parameters[parameterName]);
      return [parameter.values, parameter.options];
    }),
  ];
}

function valuesFromRouteConfig(
  route: DatabaseRow,
  keys: string[],
  parameterNames: string[],
): string[] {
  for (const candidate of routeConfigArrayCandidates(route, keys, parameterNames)) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const values: string[] = [];
    for (const item of candidate) {
      const normalized = text(item);
      if (normalized && !values.includes(normalized)) values.push(normalized);
    }
    return values;
  }
  return [];
}

function hasDeclaredRouteArrayValues(
  route: DatabaseRow,
  keys: string[],
  parameterNames: string[],
): boolean {
  return routeConfigArrayCandidates(route, keys, parameterNames)
    .some((candidate) => Array.isArray(candidate) && candidate.length > 0);
}

function routeParameter(route: DatabaseRow, parameterName: string): Record<string, unknown> {
  const config = record(route.routeConfig);
  const capabilities = record(config.capabilities);
  return record(record(capabilities.parameters)[parameterName]);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return "";
}

const CERTIFIABLE_IMAGE_QUALITIES = new Set(["1K", "2K", "4K"]);
const KNOWN_VIDEO_RESOLUTIONS = new Set([
  "480p",
  "720p",
  "768p",
  "960p",
  "1080p",
  "2k",
  "4k",
]);

function configuredImageDefaultTextForRoute(route: DatabaseRow): string {
  const config = record(route.routeConfig);
  const capabilities = record(config.capabilities);
  const qualityParameter = routeParameter(route, "quality");
  const resolutionParameter = routeParameter(route, "resolution");
  return firstText(
    config.defaultQuality,
    config.defaultResolution,
    capabilities.defaultQuality,
    capabilities.defaultResolution,
    qualityParameter.default,
    qualityParameter.defaultValue,
    resolutionParameter.default,
    resolutionParameter.defaultValue,
  );
}

function configuredImageDefaultForRoute(route: DatabaseRow): string | null {
  const candidate = configuredImageDefaultTextForRoute(route).toUpperCase();
  return CERTIFIABLE_IMAGE_QUALITIES.has(candidate) ? candidate : null;
}

function configuredVideoDefaultTextForRoute(route: DatabaseRow): string {
  const config = record(route.routeConfig);
  const capabilities = record(config.capabilities);
  const resolutionParameter = routeParameter(route, "resolution");
  return firstText(
    config.defaultResolution,
    config.resolutionDefault,
    capabilities.defaultResolution,
    resolutionParameter.default,
    resolutionParameter.defaultValue,
  );
}

function configuredVideoDefaultForRoute(route: DatabaseRow): string | null {
  const candidate = normalizeVideoResolution(configuredVideoDefaultTextForRoute(route));
  return candidate && KNOWN_VIDEO_RESOLUTIONS.has(candidate) ? candidate : null;
}

/** Route-level certification and every publicly supported image tier need exact evidence. */
export function requiredModelRouteCertificationOperations(route: DatabaseRow): string[] {
  const operations: string[] = [MODEL_ROUTE_BASE_OPERATION];
  if (text(route.endpointType) === "image_generation") {
    for (const quality of modelRouteImageQualities(route)) {
      const operationKey = `quality:${quality}`;
      if (!operations.includes(operationKey)) operations.push(operationKey);
    }
  } else if (text(route.endpointType) === "video_generation") {
    const resolutions = modelRouteVideoResolutions(route);
    for (const resolution of ["2k", "4k"]) {
      if (resolutions.includes(resolution)) operations.push(`resolution:${resolution}`);
    }
  }
  return operations;
}

export function modelRouteImageQualities(route: DatabaseRow): string[] {
  const configuredDefault = configuredImageDefaultForRoute(route);
  const hasDeclaredArrays = hasDeclaredRouteArrayValues(
    route,
    ["qualities", "resolutions"],
    ["quality", "resolution"],
  );
  const configured = valuesFromRouteConfig(
    route,
    ["qualities", "resolutions"],
    ["quality", "resolution"],
  )
    .map((value) => value.toUpperCase())
    .filter((value, index, values) => (
      CERTIFIABLE_IMAGE_QUALITIES.has(value) && values.indexOf(value) === index
    ));
  if (hasDeclaredArrays) return configured;
  const official = findVolcengineModel(text(route.model), "image_generation");
  const officialQualities = official?.endpointType === "image_generation"
    ? official.qualities
      .map((value) => value.toUpperCase())
      .filter((value, index, values) => (
        CERTIFIABLE_IMAGE_QUALITIES.has(value) && values.indexOf(value) === index
      ))
    : [];
  if (officialQualities.length > 0) return officialQualities;
  return configuredDefault ? [configuredDefault] : [];
}

function defaultImageQualityForRoute(
  route: DatabaseRow,
  validOperationKeys?: ReadonlySet<string>,
): string | null {
  const supported = modelRouteImageQualities(route);
  const available = validOperationKeys
    ? supported.filter((quality) => validOperationKeys.has(`quality:${quality}`))
    : supported;
  return selectModelRouteDefaultImageQuality(route, available);
}

export function selectModelRouteDefaultImageQuality(
  route: DatabaseRow,
  candidateQualities: readonly string[],
): string | null {
  const supported = modelRouteImageQualities(route);
  const available = candidateQualities
    .map((quality) => text(quality).toUpperCase())
    .filter((quality, index, values) => (
      CERTIFIABLE_IMAGE_QUALITIES.has(quality)
      && supported.includes(quality)
      && values.indexOf(quality) === index
    ));
  if (available.length === 0) return null;
  const configuredDefaultText = configuredImageDefaultTextForRoute(route);
  const configuredDefault = configuredImageDefaultForRoute(route);
  if (configuredDefaultText && (!configuredDefault || !supported.includes(configuredDefault))) {
    return null;
  }
  if (configuredDefault && available.includes(configuredDefault)) return configuredDefault;
  const official = findVolcengineModel(text(route.model), "image_generation");
  const officialDefault = official?.endpointType === "image_generation"
    ? official.defaultQuality.toUpperCase()
    : null;
  if (officialDefault && available.includes(officialDefault)) return officialDefault;
  return available.length === 1 ? available[0] : null;
}

export function modelRouteVideoResolutions(route: DatabaseRow): string[] {
  const configuredDefault = configuredVideoDefaultForRoute(route);
  const hasDeclaredArrays = hasDeclaredRouteArrayValues(
    route,
    ["resolutions", "nativeResolutions"],
    ["resolution"],
  );
  const configured = valuesFromRouteConfig(
    route,
    ["resolutions", "nativeResolutions"],
    ["resolution"],
  )
    .map(normalizeVideoResolution)
    .filter((value, index, values): value is string => Boolean(
      value && KNOWN_VIDEO_RESOLUTIONS.has(value) && values.indexOf(value) === index,
    ));
  if (hasDeclaredArrays) return configured;
  const official = findVolcengineModel(text(route.model), "video_generation");
  const officialResolutions = official?.endpointType === "video_generation"
    ? official.resolutions
      .map(normalizeVideoResolution)
      .filter((value, index, values): value is string => Boolean(
        value && KNOWN_VIDEO_RESOLUTIONS.has(value) && values.indexOf(value) === index,
      ))
    : [];
  if (officialResolutions.length > 0) return officialResolutions;
  return configuredDefault ? [configuredDefault] : [];
}

function defaultVideoResolutionForRoute(
  route: DatabaseRow,
  validOperationKeys?: ReadonlySet<string>,
): string | null {
  const supported = modelRouteVideoResolutions(route);
  const available = validOperationKeys
    ? supported.filter((resolution) => (
      !["2k", "4k"].includes(resolution)
      || validOperationKeys.has(`resolution:${resolution}`)
    ))
    : supported;
  return selectModelRouteDefaultVideoResolution(route, available);
}

export function selectModelRouteDefaultVideoResolution(
  route: DatabaseRow,
  candidateResolutions: readonly string[],
): string | null {
  const supported = modelRouteVideoResolutions(route);
  const available = candidateResolutions
    .map(normalizeVideoResolution)
    .filter((resolution, index, values): resolution is string => Boolean(
      resolution
      && KNOWN_VIDEO_RESOLUTIONS.has(resolution)
      && supported.includes(resolution)
      && values.indexOf(resolution) === index,
    ));
  if (available.length === 0) return null;
  const configuredDefaultText = configuredVideoDefaultTextForRoute(route);
  const configuredDefault = configuredVideoDefaultForRoute(route);
  if (configuredDefaultText && (!configuredDefault || !supported.includes(configuredDefault))) {
    return null;
  }
  if (configuredDefault && available.includes(configuredDefault)) return configuredDefault;
  const official = findVolcengineModel(text(route.model), "video_generation");
  const officialDefault = official?.endpointType === "video_generation"
    ? normalizeVideoResolution(official.defaultResolution)
    : null;
  if (officialDefault && available.includes(officialDefault)) return officialDefault;
  return available.length === 1 ? available[0] : null;
}

export function modelRouteOperationForRequest(
  endpointType: unknown,
  requestPayload: unknown,
  route?: DatabaseRow | null,
  validOperationKeys?: ReadonlySet<string>,
): string {
  const payload = record(requestPayload);
  const nested = record(payload.parameters);
  // Durable quick-create image tasks wrap the exact provider request under
  // `generation`; certification evidence must classify that immutable request
  // rather than the transport envelope.
  const generation = record(payload.generation);
  const sources = [payload, nested, generation];
  const routeHasTierOperations = Boolean(
    route
    && requiredModelRouteCertificationOperations(route)
      .some((operationKey) => operationKey !== MODEL_ROUTE_BASE_OPERATION),
  );
  if (text(endpointType) === "image_generation") {
    const requestedValues = sources
      .flatMap((source) => [
        source.quality,
        source.resolution,
        source.targetResolution,
        source.size,
      ])
      .map(text)
      .filter(Boolean);
    if (requestedValues.length === 0) {
      if (!route) return MODEL_ROUTE_BASE_OPERATION;
      const defaultQuality = defaultImageQualityForRoute(route, validOperationKeys);
      if (!defaultQuality) {
        return modelRouteImageQualities(route).length > 0
          ? "quality:unclassified"
          : MODEL_ROUTE_BASE_OPERATION;
      }
      return routeHasTierOperations
        ? `quality:${defaultQuality}`
        : ["2K", "4K"].includes(defaultQuality)
          ? `quality:${defaultQuality}`
          : MODEL_ROUTE_BASE_OPERATION;
    }
    const qualities = requestedValues.map((requested) => {
      const directQuality = requested.toUpperCase();
      return CERTIFIABLE_IMAGE_QUALITIES.has(directQuality)
        ? directQuality
        : volcengineImageQualityForSize(requested) || "";
    });
    const uniqueQualities = [...new Set(qualities.filter((quality) => (
      CERTIFIABLE_IMAGE_QUALITIES.has(quality)
    )))];
    if (
      uniqueQualities.length > 1
    ) {
      return "quality:unclassified";
    }
    const quality = uniqueQualities[0] || null;
    if (quality === "2K" || quality === "4K") return `quality:${quality}`;
    if (!route || routeHasTierOperations) {
      return quality === "1K" && qualities.every(Boolean)
        ? "quality:1K"
        : "quality:unclassified";
    }
    // Base-only provider routes retain their own low-tier vocabulary (for
    // example OpenAI `quality: high` plus `size: 1024x1024`). Known 2K/4K
    // selectors were handled above and can never fall through to base.
    return MODEL_ROUTE_BASE_OPERATION;
  }
  if (text(endpointType) === "video_generation") {
    // `quality` and image `size` are independent provider controls. They must
    // not conflict with, or substitute for, the video's wire resolution.
    const requestedValues = sources
      .flatMap((source) => [source.resolution, source.targetResolution])
      .map(text)
      .filter(Boolean);
    if (requestedValues.length === 0) {
      if (!route) return MODEL_ROUTE_BASE_OPERATION;
      const defaultResolution = defaultVideoResolutionForRoute(route, validOperationKeys);
      if (!defaultResolution) {
        return modelRouteVideoResolutions(route).length > 0
          ? "resolution:unclassified"
          : MODEL_ROUTE_BASE_OPERATION;
      }
      return ["2k", "4k"].includes(defaultResolution)
        ? `resolution:${defaultResolution}`
        : MODEL_ROUTE_BASE_OPERATION;
    }
    const resolutions = requestedValues.map(normalizeVideoResolution);
    const uniqueResolutions = [...new Set(resolutions.filter((resolution): resolution is string => (
      Boolean(resolution && KNOWN_VIDEO_RESOLUTIONS.has(resolution))
    )))];
    if (
      resolutions.some((resolution) => !resolution || !KNOWN_VIDEO_RESOLUTIONS.has(resolution))
      || uniqueResolutions.length > 1
    ) {
      return "resolution:unclassified";
    }
    const resolution = uniqueResolutions[0] || null;
    return resolution === "2k" || resolution === "4k"
      ? `resolution:${resolution}`
      : MODEL_ROUTE_BASE_OPERATION;
  }
  return MODEL_ROUTE_BASE_OPERATION;
}

export function formatModelRouteCertificationRecord(
  row: DatabaseRow,
): ModelRouteCertificationRecord {
  return {
    id: text(row.id),
    routeId: text(row.routeId),
    pricingRuleId: text(row.pricingRuleId),
    operationKey: text(row.operationKey),
    batchId: text(row.batchId),
    releaseId: text(row.releaseId) || null,
    sourceCommit: text(row.sourceCommit).toLowerCase() || null,
    priceSourceUrl: text(row.priceSourceUrl),
    priceSourceDigest: text(row.priceSourceDigest).toLowerCase(),
    priceCheckedAt: Number(row.priceCheckedAt || 0),
    upstreamCurrency: text(row.upstreamCurrency).toUpperCase(),
    upstreamUnitPriceMicros: Number(row.upstreamUnitPriceMicros || 0),
    billingCurrency: text(row.billingCurrency).toUpperCase(),
    billingDimension: text(row.billingDimension),
    taskEvidenceId: text(row.taskEvidenceId),
    usageEvidenceId: text(row.usageEvidenceId),
    routeSnapshotHash: text(row.routeSnapshotHash).toLowerCase(),
    pricingSnapshotHash: text(row.pricingSnapshotHash).toLowerCase(),
    certifiedByUserId: Number(row.certifiedByUserId || 0),
    certifiedAt: Number(row.certifiedAt || 0),
    validUntil: Number(row.validUntil || 0),
    revokedByUserId: row.revokedByUserId == null ? null : Number(row.revokedByUserId),
    revokedAt: row.revokedAt == null ? null : Number(row.revokedAt),
    revokeReason: text(row.revokeReason) || null,
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

function validPriceSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const sensitive = /token|secret|password|credential|signature|api[-_]?key|access[-_]?key/i;
    return [...url.searchParams.keys()].every((key) => !sensitive.test(key));
  } catch {
    return false;
  }
}

function certificationStaticReason(input: {
  certification: ModelRouteCertificationRecord;
  route: DatabaseRow;
  pricingRule: DatabaseRow;
  now: number;
}): { status: ModelRouteCertificationStatus; reason: string } | null {
  const { certification, route, pricingRule, now } = input;
  if (certification.revokedAt !== null) {
    return { status: "revoked", reason: "该价格与路由认证已撤销" };
  }
  if (certification.validUntil <= now) {
    return { status: "expired", reason: "该价格与路由认证已过期" };
  }
  if (certification.certifiedAt > now || certification.priceCheckedAt > certification.certifiedAt) {
    return { status: "invalid", reason: "认证时间或刊例价核对时间无效" };
  }
  if (
    certification.validUntil <= certification.certifiedAt
    || certification.validUntil - certification.priceCheckedAt > MODEL_ROUTE_CERTIFICATION_MAX_VALIDITY_MS
  ) {
    return { status: "invalid", reason: "认证有效期超出刊例价核对窗口" };
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(certification.batchId)
    || (
      certification.releaseId !== null
      && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(certification.releaseId)
    )
    || (
      certification.sourceCommit !== null
      && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(certification.sourceCommit)
    )
  ) {
    return { status: "invalid", reason: "认证批次、发布或源码身份无效" };
  }
  if (
    !validPriceSourceUrl(certification.priceSourceUrl)
    || !/^[a-f0-9]{64}$/.test(certification.priceSourceDigest)
  ) {
    return { status: "invalid", reason: "上游刊例价来源或内容摘要无效" };
  }
  if (
    !/^[A-Z]{3}$/.test(certification.upstreamCurrency)
    || !Number.isSafeInteger(certification.upstreamUnitPriceMicros)
    || certification.upstreamUnitPriceMicros <= 0
  ) {
    return { status: "invalid", reason: "上游刊例价币种或单价无效" };
  }
  if (certification.routeSnapshotHash !== modelRouteCertificationRouteSnapshotHash(route)) {
    return { status: "route_changed", reason: "模型路由配置在认证后已变更，需要重新认证" };
  }
  if (
    certification.pricingRuleId !== text(pricingRule.id)
    || certification.pricingSnapshotHash !== modelRouteCertificationPricingSnapshotHash(pricingRule)
    || certification.billingCurrency !== text(pricingRule.currency).toUpperCase()
    || certification.billingDimension !== text(pricingRule.unit)
  ) {
    return { status: "pricing_changed", reason: "模型定价规则在认证后已变更，需要重新认证" };
  }
  if (!Number.isSafeInteger(certification.certifiedByUserId) || certification.certifiedByUserId <= 0) {
    return { status: "invalid", reason: "认证人身份无效" };
  }
  return null;
}

function operationEvidenceMatches(
  operationKey: string,
  endpointType: string,
  requestPayload: unknown,
): boolean {
  if (operationKey === MODEL_ROUTE_BASE_OPERATION) return true;
  return modelRouteOperationForRequest(endpointType, requestPayload) === operationKey;
}

async function fanjinValueVideoCertificationEvidenceEvaluation(input: {
  database: ModelRouteCertificationDatabase;
  certification: ModelRouteCertificationRecord;
  route: DatabaseRow;
  pricingRule: DatabaseRow;
  task: DatabaseRow;
  usage: DatabaseRow | null | undefined;
}): Promise<{ reason: string; deliveryProof: null } | null> {
  const definition = fanjinValueVideoOfferDefinition(input.route.model);
  if (!definition) return null;
  if (
    input.certification.operationKey !== MODEL_ROUTE_BASE_OPERATION
    || text(input.route.endpointType) !== "video_generation"
    || text(input.route.provider) !== "volcano"
    || (text(input.route.channelId) !== FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID && text(input.route.channelId) !== text(input.task.channelId))
    || Number(input.route.disabled || 0) !== 0
    || text(input.task.endpointType) !== "video_generation"
    || text(input.task.model) !== definition.upstreamModel
    || text(input.task.provider) !== "volcano"
    || !text(input.task.channelId)
  ) {
    return { reason: "繁境特价版认证未绑定精确的逻辑路由与原生生成任务", deliveryProof: null };
  }
  if (
    !input.usage
    || text(input.usage.taskId) !== text(input.task.id)
    || text(input.usage.status) !== "charged"
    || text(input.usage.endpointType) !== "video_generation"
    || text(input.usage.model) !== definition.upstreamModel
    || text(input.usage.provider) !== "volcano"
    || text(input.usage.channelId) !== text(input.task.channelId)
    || text(input.usage.currency).toUpperCase() !== input.certification.billingCurrency
    || text(input.usage.unit) !== input.certification.billingDimension
    || !Number.isSafeInteger(Number(input.usage.units))
    || Number(input.usage.units) <= 0
    || !Number.isSafeInteger(Number(input.usage.costMicros))
    || Number(input.usage.costMicros) <= 0
  ) {
    return { reason: "繁境特价版原生生成 usage 未完成 charged 结算或身份不匹配", deliveryProof: null };
  }

  let contract;
  try {
    contract = parseFanjinValueVideoPricingContract({
      publicModel: definition.publicModel,
      ruleConfig: input.pricingRule.ruleConfig,
    });
  } catch {
    return { reason: "繁境特价版组合定价证据无效", deliveryProof: null };
  }
  if (
    !contract
    || contract.publicModel !== definition.publicModel
    || contract.upstreamModel !== definition.upstreamModel
  ) {
    return { reason: "繁境特价版组合定价未绑定当前商品与上游模型", deliveryProof: null };
  }

  const sourceRows = await input.database(MODEL_ROUTE_CERTIFICATION_TABLE)
    .where({
      taskEvidenceId: input.certification.taskEvidenceId,
      usageEvidenceId: input.certification.usageEvidenceId,
      operationKey: MODEL_ROUTE_BASE_OPERATION,
    })
    .whereNot({ routeId: input.certification.routeId })
    .whereNull("revokedAt")
    .orderBy("certifiedAt", "desc")
    .orderBy("id", "desc");
  const matches: Array<{
    certification: ModelRouteCertificationRecord;
    route: DatabaseRow;
    pricingRule: DatabaseRow;
  }> = [];
  for (const row of sourceRows) {
    const sourceCertification = formatModelRouteCertificationRecord(row);
    const [sourceRoute, sourcePricingRule] = await Promise.all([
      input.database("o_model_route").where({ id: sourceCertification.routeId }).first(),
      input.database("o_pricing_rule").where({ id: sourceCertification.pricingRuleId }).first(),
    ]);
    if (
      !sourceRoute
      || !sourcePricingRule
      || text(sourceRoute.model) !== definition.upstreamModel
      || text(sourceRoute.endpointType) !== "video_generation"
      || text(sourceRoute.provider) !== "volcano"
      || text(sourceRoute.channelId) !== text(input.task.channelId)
      || text(sourcePricingRule.model) !== definition.upstreamModel
      || text(sourcePricingRule.endpointType) !== "video_generation"
      || text(sourcePricingRule.provider) !== "volcano"
      || text(sourcePricingRule.unit) !== "token"
      || text(sourcePricingRule.currency).toUpperCase() !== "GU"
    ) {
      continue;
    }
    const staticFailure = certificationStaticReason({
      certification: sourceCertification,
      route: sourceRoute,
      pricingRule: sourcePricingRule,
      now: input.certification.certifiedAt,
    });
    if (staticFailure) continue;
    const sourceEvidence = await certificationEvidenceEvaluation({
      database: input.database,
      certification: sourceCertification,
      route: sourceRoute,
      pricingRule: sourcePricingRule,
    });
    if (sourceEvidence.reason) continue;
    matches.push({ certification: sourceCertification, route: sourceRoute, pricingRule: sourcePricingRule });
  }
  if (matches.length !== 1) {
    return {
      reason: matches.length === 0
        ? "繁境特价版缺少唯一有效的原生生成认证证据"
        : "繁境特价版原生生成认证证据不唯一",
      deliveryProof: null,
    };
  }
  const source = matches[0];
  if (
    input.certification.priceSourceUrl !== source.certification.priceSourceUrl
    || input.certification.priceSourceDigest !== source.certification.priceSourceDigest
    || input.certification.priceCheckedAt !== source.certification.priceCheckedAt
    || input.certification.upstreamCurrency !== source.certification.upstreamCurrency
    || input.certification.upstreamUnitPriceMicros !== source.certification.upstreamUnitPriceMicros
    || input.certification.billingCurrency !== source.certification.billingCurrency
    || input.certification.billingDimension !== source.certification.billingDimension
    || input.certification.validUntil > source.certification.validUntil
  ) {
    return { reason: "繁境特价版认证与原生生成刊例价或有效期不一致", deliveryProof: null };
  }
  let generationEvidenceSha256 = "";
  try {
    generationEvidenceSha256 = fanjinValueVideoGenerationCostEvidence({
      publicModel: definition.publicModel,
      upstreamModel: definition.upstreamModel,
      route: source.route,
      pricingRule: source.pricingRule,
      certification: source.certification,
      task: input.task,
      usage: input.usage,
    }).sha256;
  } catch {
    return { reason: "繁境特价版原生生成成本证据无法重建", deliveryProof: null };
  }
  if (generationEvidenceSha256 !== contract.generationCostEvidenceSha256) {
    return { reason: "繁境特价版原生生成成本证据摘要已漂移", deliveryProof: null };
  }
  return { reason: "", deliveryProof: null };
}

async function certificationEvidenceEvaluation(input: {
  database: ModelRouteCertificationDatabase;
  certification: ModelRouteCertificationRecord;
  route: DatabaseRow;
  pricingRule: DatabaseRow;
}): Promise<{ reason: string; deliveryProof: PublicVideoDeliveryProof | null }> {
  const [task, usage] = await Promise.all([
    input.database("o_relay_task")
      .where({ id: input.certification.taskEvidenceId })
      .first(),
    input.database("o_usage_record")
      .where({ id: input.certification.usageEvidenceId })
      .first(),
  ]);
  if (!task || text(task.status) !== "succeeded" || !text(task.providerTaskId) || !Number(task.completedAt)) {
    return { reason: "真实任务证据不是已完成的上游成功任务", deliveryProof: null };
  }
  const valueVideoEvidence = await fanjinValueVideoCertificationEvidenceEvaluation({
    ...input,
    task,
    usage,
  });
  if (valueVideoEvidence) return valueVideoEvidence;
  const endpointType = text(input.route.endpointType);
  const model = text(input.route.model);
  const provider = text(input.pricingRule.provider);
  const channelId = text(input.route.channelId);
  if (
    text(task.endpointType) !== endpointType
    || text(task.model) !== model
    || text(task.provider) !== provider
    || (channelId && text(task.channelId) !== channelId)
  ) {
    return { reason: "真实任务证据与当前路由、模型或供应商不匹配", deliveryProof: null };
  }
  const requestPayload = record(task.requestPayload);
  if (!operationEvidenceMatches(
    input.certification.operationKey,
    endpointType,
    requestPayload,
  )) {
    return { reason: "真实任务证据未覆盖当前 2K/4K 操作", deliveryProof: null };
  }
  if (
    !usage
    || text(usage.taskId) !== text(task.id)
    || text(usage.status) !== "charged"
    || text(usage.endpointType) !== endpointType
    || text(usage.model) !== model
    || text(usage.provider) !== provider
    || (channelId && text(usage.channelId) !== channelId)
    || text(usage.currency).toUpperCase() !== input.certification.billingCurrency
    || text(usage.unit) !== input.certification.billingDimension
    || !Number.isSafeInteger(Number(usage.units))
    || Number(usage.units) <= 0
    || !Number.isSafeInteger(Number(usage.costMicros))
    || Number(usage.costMicros) <= 0
  ) {
    return { reason: "结算/usage 证据未完成 charged 结算或与认证计费维度不匹配", deliveryProof: null };
  }
  const requiredWorkspace = text(input.pricingRule.scope) === "workspace"
    ? text(input.pricingRule.workspaceId)
    : text(input.route.scope) === "workspace"
      ? text(input.route.workspaceId)
      : "";
  if (
    requiredWorkspace
    && (
      text(task.workspaceId) !== requiredWorkspace
      || text(usage.workspaceId) !== requiredWorkspace
    )
  ) {
    return { reason: "真实任务与 usage 证据不属于价格规则的工作区", deliveryProof: null };
  }
  if (
    endpointType === "video_generation"
    && ["resolution:2k", "resolution:4k"].includes(input.certification.operationKey)
  ) {
    const delivery = await evaluateVideoDeliveryProof({
      database: input.database,
      route: input.route,
      task,
      usage,
      operationKey: input.certification.operationKey,
    });
    return delivery.ok
      ? { reason: "", deliveryProof: delivery.proof }
      : { reason: delivery.reason, deliveryProof: null };
  }
  return { reason: "", deliveryProof: null };
}

function missingOperationReason(operationKey: string, pricingRule: DatabaseRow | null): string {
  if (!pricingRule) return "当前路由缺少可认证的 provider-specific GU 定价规则";
  if (operationKey === MODEL_ROUTE_BASE_OPERATION) {
    return "模型路由尚未完成上游刊例价、真实任务与结算 usage 认证";
  }
  return `${operationKey.replace("quality:", "").replace("resolution:", "").toUpperCase()} 操作尚未完成独立真实任务与结算认证`;
}

export async function evaluateModelRouteCertification(input: {
  database: ModelRouteCertificationDatabase;
  route: DatabaseRow;
  pricingRule: DatabaseRow | null;
  now?: number;
}): Promise<ModelRouteCertificationReadiness> {
  const routeId = text(input.route.id);
  const pricingRuleId = text(input.pricingRule?.id) || null;
  const requiredOperations = requiredModelRouteCertificationOperations(input.route);
  const tableReady = await input.database.schema.hasTable(MODEL_ROUTE_CERTIFICATION_TABLE);
  if (!tableReady) {
    const operations = requiredOperations.map((operationKey) => ({
      operationKey,
      required: true as const,
      status: "missing" as const,
      valid: false,
      reason: "模型路由认证表尚未迁移，已按 fail-closed 隐藏",
      certification: null,
    }));
    return {
      certificationVersion: "model-route-certification/v1",
      tableReady: false,
      routeId,
      pricingRuleId,
      valid: false,
      hiddenFromUserCatalog: true,
      reason: operations[0]?.reason || "模型路由认证表尚未迁移",
      requiredOperations,
      operations,
    };
  }

  const rows = routeId
    ? await input.database(MODEL_ROUTE_CERTIFICATION_TABLE)
        .where({ routeId })
        .orderBy("certifiedAt", "desc")
        .orderBy("id", "desc")
    : [];
  const latestByOperation = new Map<string, ModelRouteCertificationRecord>();
  for (const row of rows) {
    const certification = formatModelRouteCertificationRecord(row);
    if (!latestByOperation.has(certification.operationKey)) {
      latestByOperation.set(certification.operationKey, certification);
    }
  }
  const now = input.now ?? Date.now();
  const operations: ModelRouteCertificationOperationStatus[] = [];
  for (const operationKey of requiredOperations) {
    const certification = latestByOperation.get(operationKey) || null;
    if (!certification || !input.pricingRule || certification.pricingRuleId !== pricingRuleId) {
      operations.push({
        operationKey,
        required: true,
        status: "missing",
        valid: false,
        reason: missingOperationReason(operationKey, input.pricingRule),
        certification,
      });
      continue;
    }
    const staticFailure = certificationStaticReason({
      certification,
      route: input.route,
      pricingRule: input.pricingRule,
      now,
    });
    if (staticFailure) {
      operations.push({
        operationKey,
        required: true,
        status: staticFailure.status,
        valid: false,
        reason: staticFailure.reason,
        certification,
      });
      continue;
    }
    const evidence = await certificationEvidenceEvaluation({
      database: input.database,
      certification,
      route: input.route,
      pricingRule: input.pricingRule,
    });
    operations.push({
      operationKey,
      required: true,
      status: evidence.reason ? "evidence_invalid" : "valid",
      valid: !evidence.reason,
      reason: evidence.reason || null,
      certification,
      deliveryProof: evidence.deliveryProof,
    });
  }
  const base = operations.find((operation) => operation.operationKey === MODEL_ROUTE_BASE_OPERATION);
  return {
    certificationVersion: "model-route-certification/v1",
    tableReady: true,
    routeId,
    pricingRuleId,
    valid: Boolean(base?.valid),
    hiddenFromUserCatalog: !base?.valid,
    reason: base?.reason || null,
    requiredOperations,
    operations,
  };
}

function assertSafeEvidenceId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new ModelRouteCertificationError(`${label} 格式无效`);
  }
}

function assertCertificationInput(input: CertifyModelRouteInput, now: number): void {
  assertSafeEvidenceId(text(input.batchId), "batchId");
  if (
    input.releaseId
    && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.releaseId)
  ) {
    throw new ModelRouteCertificationError("releaseId 格式无效");
  }
  if (
    input.sourceCommit
    && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.sourceCommit)
  ) {
    throw new ModelRouteCertificationError("sourceCommit 必须是 40 或 64 位小写十六进制摘要");
  }
  if (!validPriceSourceUrl(input.priceSourceUrl)) {
    throw new ModelRouteCertificationError("上游刊例价来源必须是不含凭据的 HTTPS URL");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.priceSourceDigest)) {
    throw new ModelRouteCertificationError("上游刊例价内容摘要必须是 SHA-256");
  }
  if (!/^[A-Z]{3}$/.test(input.upstreamCurrency)) {
    throw new ModelRouteCertificationError("上游刊例价币种必须是三位大写代码");
  }
  if (!Number.isSafeInteger(input.upstreamUnitPriceMicros) || input.upstreamUnitPriceMicros <= 0) {
    throw new ModelRouteCertificationError("上游刊例价必须是正整数 micros");
  }
  if (
    !Number.isSafeInteger(input.priceCheckedAt)
    || input.priceCheckedAt <= 0
    || input.priceCheckedAt > now
  ) {
    throw new ModelRouteCertificationError("刊例价抓取/核对时间无效");
  }
  if (
    !Number.isSafeInteger(input.validUntil)
    || input.validUntil <= now
    || input.validUntil - input.priceCheckedAt > MODEL_ROUTE_CERTIFICATION_MAX_VALIDITY_MS
  ) {
    throw new ModelRouteCertificationError("认证有效期必须在刊例价核对后 180 天内且晚于当前时间");
  }
  assertSafeEvidenceId(input.routeId, "routeId");
  assertSafeEvidenceId(input.pricingRuleId, "pricingRuleId");
  assertSafeEvidenceId(input.taskEvidenceId, "taskEvidenceId");
  assertSafeEvidenceId(input.usageEvidenceId, "usageEvidenceId");
  if (!Number.isSafeInteger(input.certifiedByUserId) || input.certifiedByUserId <= 0) {
    throw new ModelRouteCertificationError("认证人身份无效", 403);
  }
}

async function resolvedRouteProvider(
  database: ModelRouteCertificationDatabase,
  route: DatabaseRow,
): Promise<string> {
  const routeProvider = text(route.provider);
  if (routeProvider) return routeProvider;
  const channelId = text(route.channelId);
  if (!channelId) return "";
  const channel = await database("o_provider_channel").where({ id: channelId }).first();
  return text(channel?.provider);
}

function pricingRuleCoversRoute(rule: DatabaseRow, route: DatabaseRow, provider: string): boolean {
  const ruleScope = text(rule.scope);
  const routeScope = text(route.scope);
  const scopeMatches = ruleScope === "platform"
    ? !text(rule.workspaceId)
    : ruleScope === "workspace"
      && Boolean(text(rule.workspaceId))
      && (
        routeScope === "platform"
        || (routeScope === "workspace" && text(route.workspaceId) === text(rule.workspaceId))
      );
  return (
    Number(rule.disabled || 0) === 0
    && scopeMatches
    && text(rule.endpointType) === text(route.endpointType)
    && text(rule.provider) === provider
    && (!text(rule.model) || text(rule.model) === text(route.model))
    && text(rule.currency).toUpperCase() === "GU"
    && Number.isSafeInteger(Number(rule.unitPriceMicros))
    && Number(rule.unitPriceMicros) > 0
  );
}

let certificationMutationTail: Promise<void> = Promise.resolve();

async function serializeCertificationMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = certificationMutationTail;
  let release = () => {};
  certificationMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function certifyModelRoute(
  database: ModelRouteCertificationDatabase,
  input: CertifyModelRouteInput,
): Promise<ModelRouteCertificationRecord> {
  const now = input.now ?? Date.now();
  const normalized: CertifyModelRouteInput = {
    ...input,
    routeId: text(input.routeId),
    pricingRuleId: text(input.pricingRuleId),
    operationKey: text(input.operationKey),
    batchId: text(input.batchId) || `manual:${uuid()}`,
    releaseId: text(input.releaseId) || null,
    sourceCommit: text(input.sourceCommit).toLowerCase() || null,
    priceSourceUrl: text(input.priceSourceUrl),
    priceSourceDigest: text(input.priceSourceDigest).toLowerCase(),
    upstreamCurrency: text(input.upstreamCurrency).toUpperCase(),
    billingCurrency: text(input.billingCurrency).toUpperCase(),
    billingDimension: text(input.billingDimension),
    taskEvidenceId: text(input.taskEvidenceId),
    usageEvidenceId: text(input.usageEvidenceId),
    now,
  };
  assertCertificationInput(normalized, now);
  if (!(await database.schema.hasTable(MODEL_ROUTE_CERTIFICATION_TABLE))) {
    throw new ModelRouteCertificationError("模型路由认证表尚未迁移", 503, "model_route_certification_unavailable");
  }

  return serializeCertificationMutation(async () => database.transaction(async (transaction) => {
    await acquireModelRouteCertificationAdvisoryFence(transaction);
    const [route, pricingRule, actor] = await Promise.all([
      transaction("o_model_route").where({ id: normalized.routeId }).first(),
      transaction("o_pricing_rule").where({ id: normalized.pricingRuleId }).first(),
      transaction("o_user").where({ id: normalized.certifiedByUserId }).first(),
    ]);
    if (!route) throw new ModelRouteCertificationError("模型路由不存在", 404);
    if (!pricingRule) throw new ModelRouteCertificationError("模型定价规则不存在", 404);
    if (!actor || text(actor.status).toLowerCase() !== "active") {
      throw new ModelRouteCertificationError("认证人账号不可用", 403);
    }
    const provider = await resolvedRouteProvider(transaction, route);
    if (!provider || !pricingRuleCoversRoute(pricingRule, route, provider)) {
      throw new ModelRouteCertificationError("定价规则与路由范围、provider、模型或 GU 计费契约不匹配");
    }
    if (
      normalized.billingCurrency !== text(pricingRule.currency).toUpperCase()
      || normalized.billingDimension !== text(pricingRule.unit)
    ) {
      throw new ModelRouteCertificationError("认证币种或计费维度与当前定价规则不一致");
    }
    const requiredOperations = requiredModelRouteCertificationOperations(route);
    if (!requiredOperations.includes(normalized.operationKey)) {
      throw new ModelRouteCertificationError("认证 operation 不属于当前路由声明的 route/2K/4K 能力");
    }

    const priorMaximum = await transaction(MODEL_ROUTE_CERTIFICATION_TABLE)
      .where({ routeId: normalized.routeId, operationKey: normalized.operationKey })
      .max({ maximumCertifiedAt: "certifiedAt" })
      .first();
    const certifiedAt = Math.max(
      now,
      Number(priorMaximum?.maximumCertifiedAt || 0) + 1,
    );
    if (normalized.validUntil <= certifiedAt) {
      throw new ModelRouteCertificationError("认证有效期必须晚于已有历史证据的最新认证时间");
    }

    const candidate: ModelRouteCertificationRecord = {
      id: uuid(),
      routeId: normalized.routeId,
      pricingRuleId: normalized.pricingRuleId,
      operationKey: normalized.operationKey,
      batchId: normalized.batchId || "",
      releaseId: normalized.releaseId || null,
      sourceCommit: normalized.sourceCommit || null,
      priceSourceUrl: normalized.priceSourceUrl,
      priceSourceDigest: normalized.priceSourceDigest,
      priceCheckedAt: normalized.priceCheckedAt,
      upstreamCurrency: normalized.upstreamCurrency,
      upstreamUnitPriceMicros: normalized.upstreamUnitPriceMicros,
      billingCurrency: normalized.billingCurrency,
      billingDimension: normalized.billingDimension,
      taskEvidenceId: normalized.taskEvidenceId,
      usageEvidenceId: normalized.usageEvidenceId,
      routeSnapshotHash: modelRouteCertificationRouteSnapshotHash(route),
      pricingSnapshotHash: modelRouteCertificationPricingSnapshotHash(pricingRule),
      certifiedByUserId: normalized.certifiedByUserId,
      certifiedAt,
      validUntil: normalized.validUntil,
      revokedByUserId: null,
      revokedAt: null,
      revokeReason: null,
      createdAt: certifiedAt,
      updatedAt: certifiedAt,
    };

    const existingBatchRow = await transaction(MODEL_ROUTE_CERTIFICATION_TABLE)
      .where({
        batchId: candidate.batchId,
        routeId: candidate.routeId,
        operationKey: candidate.operationKey,
      })
      .first();
    if (existingBatchRow) {
      const existing = formatModelRouteCertificationRecord(existingBatchRow);
      const replayFields: Array<keyof ModelRouteCertificationRecord> = [
        "pricingRuleId",
        "releaseId",
        "sourceCommit",
        "priceSourceUrl",
        "priceSourceDigest",
        "priceCheckedAt",
        "upstreamCurrency",
        "upstreamUnitPriceMicros",
        "billingCurrency",
        "billingDimension",
        "taskEvidenceId",
        "usageEvidenceId",
        "routeSnapshotHash",
        "pricingSnapshotHash",
        "certifiedByUserId",
        "validUntil",
      ];
      const exactReplay = replayFields.every((field) => existing[field] === candidate[field]);
      const replayFailure = exactReplay
        ? certificationStaticReason({ certification: existing, route, pricingRule, now })
        : { status: "invalid" as const, reason: "批次身份已绑定不同的认证内容" };
      if (!replayFailure) {
        const replayEvidence = await certificationEvidenceEvaluation({
          database: transaction,
          certification: existing,
          route,
          pricingRule,
        });
        if (!replayEvidence.reason) return existing;
      }
      throw new ModelRouteCertificationError(
        replayFailure?.reason || "批次证据已失效，不能重放应用",
        409,
        "model_route_certification_batch_conflict",
      );
    }
    const evidence = await certificationEvidenceEvaluation({
      database: transaction,
      certification: candidate,
      route,
      pricingRule,
    });
    if (evidence.reason) throw new ModelRouteCertificationError(evidence.reason);

    await transaction(MODEL_ROUTE_CERTIFICATION_TABLE)
      .where({ routeId: normalized.routeId, operationKey: normalized.operationKey })
      .whereNull("revokedAt")
      .update({
        revokedByUserId: normalized.certifiedByUserId,
        revokedAt: certifiedAt,
        revokeReason: "superseded",
        updatedAt: certifiedAt,
      });
    await transaction(MODEL_ROUTE_CERTIFICATION_TABLE).insert(candidate);
    return candidate;
  }));
}

export async function revokeModelRouteCertification(
  database: Knex,
  input: {
    routeId: string;
    operationKey: string;
    revokedByUserId: number;
    reason: string;
    now?: number;
  },
): Promise<ModelRouteCertificationRecord> {
  const routeId = text(input.routeId);
  const operationKey = text(input.operationKey);
  const reason = text(input.reason);
  const now = input.now ?? Date.now();
  assertSafeEvidenceId(routeId, "routeId");
  if (!operationKey || !reason || reason.length > 500) {
    throw new ModelRouteCertificationError("撤销 operation 或原因无效");
  }
  if (!Number.isSafeInteger(input.revokedByUserId) || input.revokedByUserId <= 0) {
    throw new ModelRouteCertificationError("撤销人身份无效", 403);
  }
  if (!(await database.schema.hasTable(MODEL_ROUTE_CERTIFICATION_TABLE))) {
    throw new ModelRouteCertificationError("模型路由认证表尚未迁移", 503, "model_route_certification_unavailable");
  }

  return serializeCertificationMutation(async () => database.transaction(async (transaction) => {
    await acquireModelRouteCertificationAdvisoryFence(transaction);
    const row = await transaction(MODEL_ROUTE_CERTIFICATION_TABLE)
      .where({ routeId, operationKey })
      .orderBy("certifiedAt", "desc")
      .orderBy("id", "desc")
      .first();
    if (!row) throw new ModelRouteCertificationError("路由 operation 认证不存在", 404);
    if (row.revokedAt == null) {
      await transaction(MODEL_ROUTE_CERTIFICATION_TABLE).where({ id: row.id }).update({
        revokedByUserId: input.revokedByUserId,
        revokedAt: now,
        revokeReason: reason,
        updatedAt: now,
      });
    }
    const persisted = await transaction(MODEL_ROUTE_CERTIFICATION_TABLE)
      .where({ id: row.id })
      .first();
    return formatModelRouteCertificationRecord(persisted);
  }));
}

export async function listModelRouteCertificationHistory(
  database: ModelRouteCertificationDatabase,
  routeId: string,
): Promise<ModelRouteCertificationRecord[]> {
  if (!(await database.schema.hasTable(MODEL_ROUTE_CERTIFICATION_TABLE))) return [];
  const rows = await database(MODEL_ROUTE_CERTIFICATION_TABLE)
    .where({ routeId: text(routeId) })
    .orderBy("certifiedAt", "desc")
    .orderBy("id", "desc");
  return rows.map(formatModelRouteCertificationRecord);
}

/**
 * Billing/dispatch guard. Every billable upstream call must be backed by an
 * effective route and valid base/exact high-tier certification.
 */
export async function assertCertifiedModelRouteForBilling(input: {
  database: ModelRouteCertificationDatabase;
  workspaceId?: string | null;
  endpointType: string;
  model: string;
  provider: string;
  channelId?: string | null;
  requestPayload: unknown;
  pricingRule: DatabaseRow;
  now?: number;
}): Promise<void> {
  const routeRows = await input.database("o_model_route")
    .where({ endpointType: input.endpointType, model: input.model })
    .orderBy("priority", "asc")
    .orderBy("fallbackOrder", "asc")
    .orderBy("createTime", "asc")
    .orderBy("id", "asc");
  const routes = selectPreferredModelRouteScope(routeRows, input.workspaceId)
    .filter((route) => (
      Number(route.disabled || 0) === 0
      && (!text(route.provider) || text(route.provider) === input.provider)
      && (!text(route.channelId) || text(route.channelId) === text(input.channelId))
    ));
  const route = routes[0];
  if (!route) {
    throw new ModelRouteCertificationError(
      "当前模型没有生效的 route-backed 路由，禁止计费与上游调用",
      402,
      "model_route_required",
    );
  }
  const pricingRuleId = text(input.pricingRule.id);
  const persistedPricingRule = pricingRuleId
    ? await input.database("o_pricing_rule").where({ id: pricingRuleId }).first()
    : null;
  const submittedPricingConfig = record(input.pricingRule.ruleConfig);
  const audienceEffective = submittedPricingConfig[PRICING_AUDIENCE_EFFECTIVE_KEY] !== undefined;
  const expectedAudiencePricingRule = persistedPricingRule && audienceEffective
    ? (await applyPricingAudienceForWorkspace(
        input.database,
        input.workspaceId,
        {
          ...persistedPricingRule,
          unitPriceMicros: Number(persistedPricingRule.unitPriceMicros),
          ruleConfig: record(persistedPricingRule.ruleConfig),
        },
      )).rule
    : null;
  const runtimePriceMatches = audienceEffective
    ? Boolean(
        expectedAudiencePricingRule
        && runtimePricingSnapshotHash(expectedAudiencePricingRule)
          === runtimePricingSnapshotHash(input.pricingRule),
      )
    : Number(persistedPricingRule?.unitPriceMicros) === Number(input.pricingRule.unitPriceMicros);
  if (
    !persistedPricingRule
    || text(persistedPricingRule.endpointType) !== input.endpointType
    || text(persistedPricingRule.provider) !== input.provider
    || (text(persistedPricingRule.model) && text(persistedPricingRule.model) !== input.model)
    || text(persistedPricingRule.currency).toUpperCase()
      !== text(input.pricingRule.currency).toUpperCase()
    || text(persistedPricingRule.unit) !== text(input.pricingRule.unit)
    || !runtimePriceMatches
    || Number(persistedPricingRule.updateTime) !== Number(input.pricingRule.updateTime)
  ) {
    throw new ModelRouteCertificationError(
      "计费价格快照与当前持久化定价规则不一致，必须重新定价并认证",
      402,
      "model_route_pricing_snapshot_stale",
    );
  }
  if (isLocalDevelopmentUncertifiedModelRouteAllowed({
    database: input.database,
    route,
  })) {
    return;
  }
  const readiness = await evaluateModelRouteCertification({
    database: input.database,
    route,
    pricingRule: persistedPricingRule,
    now: input.now,
  });
  const operationKey = modelRouteOperationForRequest(
    input.endpointType,
    input.requestPayload,
    route,
    new Set(
      readiness.operations
        .filter((candidate) => candidate.valid)
        .map((candidate) => candidate.operationKey),
    ),
  );
  const base = readiness.operations.find((operation) => (
    operation.operationKey === MODEL_ROUTE_BASE_OPERATION
  ));
  const operation = readiness.operations.find((candidate) => (
    candidate.operationKey === operationKey
  ));
  if (operationKey !== MODEL_ROUTE_BASE_OPERATION && !operation) {
    throw new ModelRouteCertificationError(
      "当前请求的清晰度无法唯一匹配已认证档位，禁止计费与上游调用",
      402,
      "model_route_certification_required",
    );
  }
  const failure = !base?.valid
    ? base
    : operationKey !== MODEL_ROUTE_BASE_OPERATION && !operation?.valid
      ? operation
      : null;
  if (failure) {
    throw new ModelRouteCertificationError(
      failure.reason || "当前路由的价格与真实任务认证未通过",
      402,
      "model_route_certification_required",
    );
  }
}
