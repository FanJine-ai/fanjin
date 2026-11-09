import type { Knex } from "knex";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_IMAGEX_REVIEW_JOB_TABLE,
  PORTRAIT_MANUAL_REVIEW_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
  PORTRAIT_PROVIDER_GROUP_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";
import { inspectPortraitVideoSamplerConfiguration } from "@/lib/portraitVideoSampler";
import {
  inspectPortraitImageXReviewReadinessConfiguration,
} from "@/lib/portraitRuntimeReadiness";

export const ADMIN_PORTRAIT_ASSETS_REQUIRED_SCHEMA = 47 as const;
export const ADMIN_PORTRAIT_ASSETS_UNAVAILABLE_CODE =
  "PORTRAIT_ASSETS_FEATURE_UNAVAILABLE" as const;

export const adminPortraitSubjectKinds = [
  "pending",
  "ordinary",
  "real_person",
  "virtual_person",
  "trusted_output",
  "ambiguous",
  "multiple_faces",
] as const;

export const adminPortraitFaceScanStates = [
  "queued",
  "scanning",
  "no_face",
  "single_face",
  "multiple_faces",
  "uncertain",
  "failed",
] as const;

export const adminPortraitModerationStates = [
  "pending",
  "checking",
  "allowed",
  "denied",
  "failed",
] as const;

export const adminPortraitComplianceStates = [
  "pending",
  "not_required",
  "allowed",
  "denied",
  "expired",
  "revoked",
] as const;

export const adminPortraitProviderSyncStates = [
  "not_needed",
  "queued",
  "authorizing",
  "creating_group",
  "processing",
  "active",
  "failed",
  "stale",
] as const;

export const adminPortraitManualReviewStates = [
  "not_required",
  "pending",
  "in_review",
  "completed",
  "superseded",
] as const;

export const adminPortraitImageXReviewStates = [
  "prepared",
  "submitting",
  "submission_unknown",
  "polling",
  "allowed",
  "denied",
  "review_required",
  "failed",
] as const;

export type AdminPortraitAssetsFilters = Readonly<{
  keyword?: string;
  workspaceId?: string;
  projectId?: number;
  subjectKind?: (typeof adminPortraitSubjectKinds)[number];
  faceScanState?: (typeof adminPortraitFaceScanStates)[number];
  moderationState?: (typeof adminPortraitModerationStates)[number];
  complianceState?: (typeof adminPortraitComplianceStates)[number];
  providerSyncState?: (typeof adminPortraitProviderSyncStates)[number];
  manualReviewState?: (typeof adminPortraitManualReviewStates)[number];
  imageXReviewState?: (typeof adminPortraitImageXReviewStates)[number];
  providerChannelId?: string;
  pageNum?: number;
  pageSize?: number;
}>;

export type AdminPortraitConfigurationStatus = Readonly<{
  configured: boolean;
  valid: boolean;
  ready: boolean;
  reason: string | null;
  worker?: Readonly<{
    source: "local" | "durable_heartbeat";
    running: boolean;
    heartbeatFresh: boolean;
    heartbeatAt: number | null;
    heartbeatAgeMs: number | null;
    lastSuccessAt: number | null;
    safeReason: string | null;
  }>;
}>;

export type AdminPortraitAssetListItem = Readonly<{
  id: string;
  workspace: Readonly<{ id: string; name: string }>;
  project: Readonly<{ id: number; name: string }>;
  asset: Readonly<{
    id: number;
    versionId: number;
    name: string;
    mediaType: "image" | "video";
  }>;
  subjectKind: string;
  faceScan: Readonly<{ state: string; faceCount: number | null }>;
  declaration: Readonly<{
    classification: "real_person" | "virtual_person" | null;
    termsVersion: string | null;
    acceptedAt: number | null;
    actorRef: string | null;
  }>;
  manualReview: Readonly<{
    state: string;
    decision: string | null;
    reviewId: string | null;
  }>;
  imageXReview: Readonly<{
    state: (typeof adminPortraitImageXReviewStates)[number];
    terminal: boolean;
    attempts: number;
    ageMs: number;
    lastActivityAt: number;
    safeError: Readonly<{ code: string; message: string }> | null;
  }> | null;
  moderationState: string;
  complianceState: string;
  providerSyncState: string;
  provider: Readonly<{
    channelId: string | null;
    channelName: string | null;
    name: string | null;
    groupType: string | null;
    groupState: string | null;
    assetState: string | null;
  }>;
  error: Readonly<{ code: string; message: string }> | null;
  updatedAt: number;
}>;

export type AdminPortraitAssetsListResult = Readonly<{
  feature: Readonly<{
    available: boolean;
    code: typeof ADMIN_PORTRAIT_ASSETS_UNAVAILABLE_CODE | null;
    message: string | null;
    requiredSchema: typeof ADMIN_PORTRAIT_ASSETS_REQUIRED_SCHEMA;
  }>;
  configuration: Readonly<{
    detector: AdminPortraitConfigurationStatus;
    moderation: AdminPortraitConfigurationStatus;
  }>;
  metrics: Readonly<{
    total: number;
    admitted: number;
    awaitingAuthorization: number;
    syncing: number;
    active: number;
    failed: number;
    awaitingManualReview: number;
  }>;
  items: readonly AdminPortraitAssetListItem[];
  pagination: Readonly<{
    pageNum: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }>;
}>;

type Environment = Record<string, string | undefined>;
type Database = Knex | Knex.Transaction;
type Query = Knex.QueryBuilder<any, any>;

const REQUIRED_TABLES = [
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_PROVIDER_GROUP_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
  PORTRAIT_MANUAL_REVIEW_TABLE,
  PORTRAIT_IMAGEX_REVIEW_JOB_TABLE,
] as const;

async function configuration(
  database: Database,
  environment: Environment,
) {
  const imageXReview = await inspectPortraitImageXReviewReadinessConfiguration({
    database: database as Knex,
    environment,
  });
  const sampler = inspectPortraitVideoSamplerConfiguration(environment);
  const detector = sampler.valid
    ? {
        configured: imageXReview.configured,
        valid: imageXReview.valid,
      }
    : sampler;
  const publicStatus = (
    value: Readonly<{ configured: boolean; valid: boolean }>,
  ): AdminPortraitConfigurationStatus => ({
    configured: value.configured,
    valid: value.valid,
    ready: value.configured && value.valid,
    // Do not forward dependency exception text or credential-specific hints.
    // Admin only needs a stable readiness verdict at this boundary.
    reason: value.configured && value.valid
      ? null
      : value.configured
        ? "configuration_invalid"
        : "not_configured",
  });
  const publicImageXReason = new Set([
    "imagex_review_channel_unavailable",
    "imagex_review_worker_tick_failed",
    "imagex_review_worker_not_running",
    "imagex_review_worker_not_observed",
    "imagex_review_worker_heartbeat_stale",
    "imagex_review_worker_heartbeat_future",
    "imagex_review_worker_release_mismatch",
    "imagex_review_worker_release_unverifiable",
    "imagex_review_worker_unhealthy",
    "imagex_review_worker_inspection_failed",
  ]).has(String(imageXReview.reason || ""))
    ? String(imageXReview.reason)
    : imageXReview.configured && imageXReview.valid
      ? null
      : imageXReview.configured
        ? "configuration_invalid"
        : "not_configured";
  return {
    detector: publicStatus(detector),
    // The existing Admin card is named "内容审核". Its readiness must reflect
    // the isolated ImageX credential/service lane, not merely the legacy
    // FANJIN_REFERENCE_MODERATION_URL environment endpoint.
    moderation: {
      configured: imageXReview.configured,
      valid: imageXReview.valid,
      ready: imageXReview.configured && imageXReview.valid,
      reason: publicImageXReason,
      worker: {
        source: imageXReview.worker.source,
        running: imageXReview.worker.running,
        heartbeatFresh: imageXReview.worker.heartbeatFresh,
        heartbeatAt: imageXReview.worker.heartbeatAt,
        heartbeatAgeMs: imageXReview.worker.heartbeatAgeMs,
        lastSuccessAt: imageXReview.worker.lastSuccessAt,
        safeReason: imageXReview.worker.safeReason,
      },
    },
  };
}

async function unavailableResult(input: {
  database: Database;
  environment: Environment;
  pageNum: number;
  pageSize: number;
}): Promise<AdminPortraitAssetsListResult> {
  return {
    feature: {
      available: false,
      code: ADMIN_PORTRAIT_ASSETS_UNAVAILABLE_CODE,
      message: "人像资产观测需要数据库 schema 48，当前运行环境尚未提供该能力。",
      requiredSchema: ADMIN_PORTRAIT_ASSETS_REQUIRED_SCHEMA,
    },
    configuration: await configuration(input.database, input.environment),
    metrics: {
      total: 0,
      admitted: 0,
      awaitingAuthorization: 0,
      syncing: 0,
      active: 0,
      failed: 0,
      awaitingManualReview: 0,
    },
    items: [],
    pagination: {
      pageNum: input.pageNum,
      pageSize: input.pageSize,
      total: 0,
      totalPages: 0,
    },
  };
}

function cleanText(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function nullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function safeInteger(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function safeCount(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeErrorCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  if (!code) return null;
  return /^[A-Z0-9_.:-]{1,128}$/u.test(code)
    ? code
    : "PORTRAIT_OPERATION_FAILED";
}

/**
 * Error columns are designated safe by the worker, but this boundary still
 * rejects links and credential-shaped content. Admin list responses must
 * never become a side channel for provider H5 links, tokens, or secrets.
 */
export function sanitizePortraitAdminError(value: unknown): string | null {
  const message = String(value ?? "").trim();
  if (!message) return null;
  if (
    /\b[a-z][a-z0-9+.-]*:\/\//iu.test(message)
    || /\b(?:h5|access[_ -]?key|api[_ -]?key|secret|token|authorization|credential)\b\s*[:=]/iu.test(message)
    || /\b(?:(?:provider|upstream)[_ -]?(?:raw[_ -]?)?|raw[_ -]?)(?:response|payload)\b\s*[:=]?/iu.test(message)
    || /\bresponse[_ -]?body\b\s*[:=]?/iu.test(message)
    || /^[{[]/u.test(message)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu.test(message)
  ) {
    return "上游处理失败，敏感详情已隐藏";
  }
  return message.slice(0, 320);
}

async function portraitTablesAvailable(database: Database): Promise<boolean> {
  const available = await Promise.all(
    REQUIRED_TABLES.map((table) => database.schema.hasTable(table)),
  );
  return available.every(Boolean);
}

function isMissingPortraitTableError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = String(candidate?.code ?? "").toUpperCase();
  const message = String(candidate?.message ?? "").toLowerCase();
  if (code === "42P01") return REQUIRED_TABLES.some((table) => message.includes(table));
  return (
    message.includes("no such table")
    || message.includes("does not exist")
    || message.includes("undefined table")
  ) && REQUIRED_TABLES.some((table) => message.includes(table));
}

function baseQuery(database: Database): Query {
  return database(`${PORTRAIT_ADMISSION_TABLE} as admission`)
    .leftJoin(`${PORTRAIT_CONSENT_TABLE} as consent`, "consent.id", "admission.currentConsentId")
    .leftJoin("o_workspace as workspace", "workspace.id", "admission.workspaceId")
    .leftJoin("o_project as project", "project.id", "admission.projectId")
    .leftJoin("o_assets as asset", "asset.id", "admission.assetId")
    .leftJoin(
      `${PORTRAIT_PROVIDER_ASSET_TABLE} as providerAsset`,
      "providerAsset.id",
      "admission.currentProviderAssetBindingId",
    )
    .leftJoin(
      `${PORTRAIT_PROVIDER_GROUP_TABLE} as providerGroup`,
      "providerGroup.id",
      "providerAsset.groupBindingId",
    )
    .leftJoin(
      "o_provider_channel as boundChannel",
      "boundChannel.id",
      "providerAsset.channelId",
    )
    .leftJoin(
      "o_provider_channel as preferredChannel",
      "preferredChannel.id",
      "admission.preferredProviderChannelId",
    )
    .leftJoin(
      `${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE} as imageXReviewJob`,
      "imageXReviewJob.id",
      "admission.currentImageXReviewJobId",
    );
}

function applyFilters(query: Query, filters: AdminPortraitAssetsFilters): Query {
  const keyword = String(filters.keyword || "").trim().toLowerCase();
  if (keyword) {
    query.andWhere(function keywordFilter() {
      this.whereRaw("LOWER(COALESCE(??, '')) LIKE ?", ["workspace.name", `%${keyword}%`])
        .orWhereRaw("LOWER(COALESCE(??, '')) LIKE ?", ["project.name", `%${keyword}%`])
        .orWhereRaw("LOWER(COALESCE(??, '')) LIKE ?", ["asset.name", `%${keyword}%`])
        .orWhereRaw("LOWER(COALESCE(??, '')) LIKE ?", ["admission.id", `%${keyword}%`]);
    });
  }
  if (filters.workspaceId) query.andWhere("admission.workspaceId", filters.workspaceId);
  if (filters.projectId) query.andWhere("admission.projectId", filters.projectId);
  if (filters.subjectKind) query.andWhere("admission.subjectKind", filters.subjectKind);
  if (filters.faceScanState) query.andWhere("admission.faceScanState", filters.faceScanState);
  if (filters.moderationState) query.andWhere("admission.moderationState", filters.moderationState);
  if (filters.complianceState) query.andWhere("admission.complianceState", filters.complianceState);
  if (filters.providerSyncState) query.andWhere("admission.providerSyncState", filters.providerSyncState);
  if (filters.manualReviewState) query.andWhere("admission.manualReviewState", filters.manualReviewState);
  if (filters.imageXReviewState) query.andWhere("imageXReviewJob.state", filters.imageXReviewState);
  if (filters.providerChannelId) {
    query.andWhere(function providerChannelFilter() {
      this.where("providerAsset.channelId", filters.providerChannelId)
        .orWhere("admission.preferredProviderChannelId", filters.providerChannelId);
    });
  }
  return query;
}

function metricExpressions(database: Database): Knex.Raw[] {
  return [
    database.raw("COUNT(DISTINCT ??) AS ??", ["admission.id", "total"]),
    database.raw(
      "COUNT(DISTINCT CASE WHEN ?? IN (?, ?) THEN ?? END) AS ??",
      ["admission.complianceState", "allowed", "not_required", "admission.id", "admitted"],
    ),
    database.raw(
      "COUNT(DISTINCT CASE WHEN ?? = ? THEN ?? END) AS ??",
      ["admission.providerSyncState", "authorizing", "admission.id", "awaitingAuthorization"],
    ),
    database.raw(
      "COUNT(DISTINCT CASE WHEN ?? IN (?, ?, ?) THEN ?? END) AS ??",
      [
        "admission.providerSyncState",
        "queued",
        "creating_group",
        "processing",
        "admission.id",
        "syncing",
      ],
    ),
    database.raw(
      "COUNT(DISTINCT CASE WHEN ?? = ? THEN ?? END) AS ??",
      ["admission.providerSyncState", "active", "admission.id", "active"],
    ),
    database.raw(
      "COUNT(DISTINCT CASE WHEN ?? IN (?, ?) THEN ?? END) AS ??",
      ["admission.manualReviewState", "pending", "in_review", "admission.id", "awaitingManualReview"],
    ),
    database.raw(
      `COUNT(DISTINCT CASE WHEN (
        ?? IN (?, ?, ?)
        OR ?? IN (?, ?)
        OR ?? IN (?, ?)
        OR ?? IN (?, ?, ?)
        OR ?? IN (?, ?, ?)
      ) THEN ?? END) AS ??`,
      [
        "admission.complianceState", "denied", "expired", "revoked",
        "admission.moderationState", "denied", "failed",
        "admission.providerSyncState", "failed", "stale",
        "providerGroup.state", "failed", "stale", "revoked",
        "providerAsset.state", "failed", "stale", "revoked",
        "admission.id", "failed",
      ],
    ),
  ];
}

const terminalImageXReviewStates = new Set<string>([
  "submission_unknown",
  "allowed",
  "denied",
  "review_required",
  "failed",
]);

function imageXReviewSafeMessage(state: string, code: string): string {
  if (state === "submission_unknown") {
    return "提交结果未知，已停止自动重试，请人工核查。";
  }
  if (state === "review_required") {
    return "上游要求人工核查；敏感详情已隐藏。";
  }
  if (state === "denied") return "ImageX 审核未通过；敏感详情已隐藏。";
  return code ? "ImageX 处理未成功；敏感详情已隐藏。" : "";
}

function mapItem(row: Record<string, unknown>, now: number): AdminPortraitAssetListItem {
  const admissionErrorCode = safeErrorCode(row.admissionErrorCode);
  const providerAssetErrorCode = safeErrorCode(row.providerAssetErrorCode);
  const providerGroupErrorCode = safeErrorCode(row.providerGroupErrorCode);
  const errorCode = admissionErrorCode || providerAssetErrorCode || providerGroupErrorCode;
  const errorMessage = sanitizePortraitAdminError(
    admissionErrorCode
      ? row.admissionErrorMessage
      : providerAssetErrorCode
        ? row.providerAssetErrorMessage
        : row.providerGroupErrorMessage,
  );
  const channelId = nullableText(row.boundChannelId) || nullableText(row.preferredChannelId);
  const channelName = nullableText(row.boundChannelName) || nullableText(row.preferredChannelName);
  const providerName = nullableText(row.boundProvider) || nullableText(row.preferredProvider);
  const mediaType = row.mediaType === "video" ? "video" : "image";
  const imageXReviewState = nullableText(row.imageXReviewState);
  const imageXReviewRevision = Math.max(0, safeInteger(row.imageXReviewRevision));
  const imageXReviewCreatedAt = Math.max(0, safeInteger(row.imageXReviewCreatedAt));
  const imageXReviewUpdatedAt = Math.max(0, safeInteger(row.imageXReviewUpdatedAt));
  const imageXReviewErrorCode = safeErrorCode(row.imageXReviewSafeReasonCode);
  return {
    id: cleanText(row.id, "unknown"),
    workspace: {
      id: cleanText(row.workspaceId, "unknown"),
      name: cleanText(row.workspaceName, "未命名工作区"),
    },
    project: {
      id: safeInteger(row.projectId),
      name: cleanText(row.projectName, "未命名项目"),
    },
    asset: {
      id: safeInteger(row.assetId),
      versionId: safeInteger(row.assetVersionId),
      name: cleanText(row.assetName, "未命名素材"),
      mediaType,
    },
    subjectKind: cleanText(row.subjectKind, "pending"),
    faceScan: {
      state: cleanText(row.faceScanState, "queued"),
      faceCount: row.faceCount == null ? null : Math.max(0, safeInteger(row.faceCount)),
    },
    declaration: {
      classification: row.subjectKind === "real_person"
        ? "real_person"
        : row.subjectKind === "virtual_person" || row.subjectKind === "trusted_output"
          ? "virtual_person"
          : null,
      termsVersion: nullableText(row.consentTermsVersion),
      acceptedAt: row.consentGrantedAt == null ? null : Math.max(0, safeInteger(row.consentGrantedAt)),
      actorRef: row.consentActorUserId == null
        ? null
        : `user-***${String(row.consentActorUserId).slice(-4)}`,
    },
    manualReview: {
      state: cleanText(row.manualReviewState, "not_required"),
      decision: nullableText(row.manualReviewDecision),
      reviewId: nullableText(row.currentManualReviewId),
    },
    imageXReview: imageXReviewState && adminPortraitImageXReviewStates.includes(
      imageXReviewState as (typeof adminPortraitImageXReviewStates)[number],
    ) ? {
        state: imageXReviewState as (typeof adminPortraitImageXReviewStates)[number],
        terminal: terminalImageXReviewStates.has(imageXReviewState),
        // Job revision advances once on claim and once on release/terminal.
        // ceil(revision / 2) is therefore the secret-free number of durable
        // worker attempts (submission plus polls), not a provider request log.
        attempts: Math.ceil(imageXReviewRevision / 2),
        ageMs: imageXReviewCreatedAt > 0 ? Math.max(0, now - imageXReviewCreatedAt) : 0,
        lastActivityAt: imageXReviewUpdatedAt,
        safeError: imageXReviewErrorCode ? {
          code: imageXReviewErrorCode,
          message: imageXReviewSafeMessage(imageXReviewState, imageXReviewErrorCode),
        } : null,
      } : null,
    moderationState: cleanText(row.moderationState, "pending"),
    complianceState: cleanText(row.complianceState, "pending"),
    providerSyncState: cleanText(row.providerSyncState, "not_needed"),
    provider: {
      channelId,
      channelName,
      name: providerName,
      groupType: nullableText(row.groupType),
      groupState: nullableText(row.groupState),
      assetState: nullableText(row.providerAssetState),
    },
    error: errorCode || errorMessage
      ? {
          code: errorCode || "PORTRAIT_OPERATION_FAILED",
          message: errorMessage || "人像资产处理失败，请查看安全日志",
        }
      : null,
    updatedAt: Math.max(0, safeInteger(row.updatedAt)),
  };
}

export async function listAdminPortraitAssets(input: {
  database: Database;
  filters?: AdminPortraitAssetsFilters;
  environment?: Environment;
}): Promise<AdminPortraitAssetsListResult> {
  const filters = input.filters ?? {};
  const environment = input.environment ?? process.env;
  const pageNum = Math.max(1, safeInteger(filters.pageNum, 1));
  const pageSize = Math.min(100, Math.max(1, safeInteger(filters.pageSize, 20)));
  const now = Date.now();

  if (!(await portraitTablesAvailable(input.database))) {
    return unavailableResult({
      database: input.database,
      environment,
      pageNum,
      pageSize,
    });
  }

  try {
    const filtered = applyFilters(baseQuery(input.database), filters);
    const [metricRow, rows, configurationStatus] = await Promise.all([
      filtered.clone().clearSelect().clearOrder().select(metricExpressions(input.database)).first(),
      filtered.clone()
        .select([
          "admission.id as id",
          "admission.workspaceId as workspaceId",
          "workspace.name as workspaceName",
          "admission.projectId as projectId",
          "project.name as projectName",
          "admission.assetId as assetId",
          "admission.assetVersionId as assetVersionId",
          "asset.name as assetName",
          "admission.mediaType as mediaType",
          "admission.subjectKind as subjectKind",
          "admission.faceScanState as faceScanState",
          "admission.faceCount as faceCount",
          "consent.termsVersion as consentTermsVersion",
          "consent.grantedAt as consentGrantedAt",
          "consent.actorUserId as consentActorUserId",
          "admission.manualReviewState as manualReviewState",
          "admission.manualReviewDecision as manualReviewDecision",
          "admission.currentManualReviewId as currentManualReviewId",
          "imageXReviewJob.state as imageXReviewState",
          "imageXReviewJob.revision as imageXReviewRevision",
          "imageXReviewJob.safeReasonCode as imageXReviewSafeReasonCode",
          "imageXReviewJob.createdAt as imageXReviewCreatedAt",
          "imageXReviewJob.updatedAt as imageXReviewUpdatedAt",
          "admission.moderationState as moderationState",
          "admission.complianceState as complianceState",
          "admission.providerSyncState as providerSyncState",
          "admission.safeErrorCode as admissionErrorCode",
          "admission.safeErrorMessage as admissionErrorMessage",
          "admission.updatedAt as updatedAt",
          "boundChannel.id as boundChannelId",
          "boundChannel.name as boundChannelName",
          "boundChannel.provider as boundProvider",
          "preferredChannel.id as preferredChannelId",
          "preferredChannel.name as preferredChannelName",
          "preferredChannel.provider as preferredProvider",
          "providerGroup.groupType as groupType",
          "providerGroup.state as groupState",
          "providerGroup.safeErrorCode as providerGroupErrorCode",
          "providerGroup.safeErrorMessage as providerGroupErrorMessage",
          "providerAsset.state as providerAssetState",
          "providerAsset.safeErrorCode as providerAssetErrorCode",
          "providerAsset.safeErrorMessage as providerAssetErrorMessage",
        ])
        .orderBy("admission.updatedAt", "desc")
        .orderBy("admission.id", "desc")
        .limit(pageSize)
        .offset((pageNum - 1) * pageSize),
      configuration(input.database, environment),
    ]);

    const metrics = {
      total: safeCount(metricRow?.total),
      admitted: safeCount(metricRow?.admitted),
      awaitingAuthorization: safeCount(metricRow?.awaitingAuthorization),
      syncing: safeCount(metricRow?.syncing),
      active: safeCount(metricRow?.active),
      failed: safeCount(metricRow?.failed),
      awaitingManualReview: safeCount(metricRow?.awaitingManualReview),
    };
    return {
      feature: {
        available: true,
        code: null,
        message: null,
        requiredSchema: ADMIN_PORTRAIT_ASSETS_REQUIRED_SCHEMA,
      },
      configuration: configurationStatus,
      metrics,
      items: rows.map((row: Record<string, unknown>) => mapItem(row, now)),
      pagination: {
        pageNum,
        pageSize,
        total: metrics.total,
        totalPages: metrics.total === 0 ? 0 : Math.ceil(metrics.total / pageSize),
      },
    };
  } catch (error) {
    if (isMissingPortraitTableError(error)) {
      return unavailableResult({
        database: input.database,
        environment,
        pageNum,
        pageSize,
      });
    }
    throw error;
  }
}
