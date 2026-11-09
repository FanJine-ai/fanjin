import { portraitRegistrationFailureMessage } from "@/lib/portraitRegistrationFailure";
import { hasUpstreamRealPersonRejection, isDeclaredPortrait } from "@/lib/portraitUpstreamRejection";
import { portraitScopeEvidenceId, withPortraitReviewScope } from "@/lib/portraitReviewScope";
import { resolveProjectAssetVersion } from "@/lib/projectAssetVersion";
import { isAutomaticPortrait } from "@/lib/portraitAutomaticRegistration";
import { isUnconfirmedVideoNoFace } from "@/lib/portraitVideoFaceEvidence";
import { hasPortraitSubmissionRestriction, isPortraitProviderRefusal } from "@/lib/portraitSubmissionPolicy";
import { AUTODL_H3_LEGACY_WORKFLOW, AUTODL_H3_WORKFLOW } from "@/lib/autodlH3Manifest";
import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import {
  VIDEO_GENERATION_POLICY_VERSION,
  type VideoGenerationRequest,
  type VideoInputPolicyDecision,
} from "@/lib/videoGenerationContract";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_IDENTITY_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
  PORTRAIT_PROVIDER_GROUP_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";
import { ensurePortraitAdmissionForAsset } from "@/lib/portraitAdmissionStore";
import { PORTRAIT_MANUAL_REVIEW_POLICY_VERSION } from "@/lib/portraitManualReview";
import { ensurePortraitProviderBindingQueued, portraitProviderAccountFingerprint, PortraitProviderRuntimeError } from "@/lib/portraitProviderRuntime";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import { readProviderChannelPortraitCredentialMetadata } from "@/lib/providerChannelCredentials";

export const VIDEO_ASSET_POLICY_DECISION_VERSION =
  "video-asset-policy-decision/v1" as const;
export const VIDEO_ASSET_POLICY_EVIDENCE_VERSION =
  "video-asset-policy-evidence/v1" as const;
export const VIDEO_ASSET_POLICY_AUDIT_ACTION = "video.asset.policy.decision";
export const VIDEO_ASSET_POLICY_ENFORCEMENT_SETTING =
  "platform.videoGeneration.policyEnforcementEnabled";
export const VIDEO_ASSET_POLICY_VERSION_SETTING =
  "platform.videoGeneration.policyVersion";
export const VIDEO_OUTPUT_POLICY_SETTING =
  "platform.videoGeneration.outputPolicy";
export const DEFAULT_VIDEO_ASSET_POLICY_VERSION = "video-generation-policy.v1";

const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._/-]{2,127}$/u;
const OPAQUE_ID_PATTERN = /^[^\u0000-\u001f\u007f\s]{1,256}$/u;
const MIN_SIGNING_KEY_BYTES = 32;
const MAX_REASON_LENGTH = 500;

export type VideoOutputPolicy = {
  aigcLabel: "required" | "provider" | "disabled";
  watermark: "required" | "provider" | "disabled";
  retainPolicyEvidenceDays: number;
};

export const DEFAULT_VIDEO_OUTPUT_POLICY: Readonly<VideoOutputPolicy> = Object.freeze({
  aigcLabel: "required",
  watermark: "provider",
  retainPolicyEvidenceDays: 365,
});

export type VideoAssetPolicyConfiguration = {
  enforcementEnabled: boolean;
  policyVersion: string;
  outputPolicy: VideoOutputPolicy;
  signingAvailable: boolean;
};

export type VideoAssetPolicySettingDefinition = {
  key: string;
  label: string;
  description: string;
  type: "boolean" | "string" | "json";
  defaultValue: boolean | string | VideoOutputPolicy;
};

/**
 * These settings deliberately live in a dedicated model/policy control plane.
 * They are not appended to the frozen generic FJ Admin settings partition.
 */
export const VIDEO_ASSET_POLICY_SETTING_DEFINITIONS:
readonly VideoAssetPolicySettingDefinition[] = Object.freeze([
  Object.freeze({
    key: VIDEO_ASSET_POLICY_ENFORCEMENT_SETTING,
    label: "视频素材合规门禁",
    description: "开启后，所有视频参考素材必须具备当前策略版本的签名授权与审核决定。",
    type: "boolean",
    defaultValue: false,
  }),
  Object.freeze({
    key: VIDEO_ASSET_POLICY_VERSION_SETTING,
    label: "视频素材策略版本",
    description: "策略版本变更后，旧版本授权决定自动失效并需要重新审核。",
    type: "string",
    defaultValue: DEFAULT_VIDEO_ASSET_POLICY_VERSION,
  }),
  Object.freeze({
    key: VIDEO_OUTPUT_POLICY_SETTING,
    label: "视频输出标识与证据保留",
    description: "控制 AIGC 标识、水印要求和合规证据保留天数。",
    type: "json",
    defaultValue: DEFAULT_VIDEO_OUTPUT_POLICY,
  }),
]);

const settingDefinitionMap = new Map(
  VIDEO_ASSET_POLICY_SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

type StoredVideoAssetPolicyDecision = Omit<VideoInputPolicyDecision, "reason"> & {
  recordVersion: typeof VIDEO_ASSET_POLICY_DECISION_VERSION;
  decisionId: string;
  decidedAt: number;
  decidedBy: number | null;
  reason: string | null;
  signature: string;
};

type VerifiedStoredDecision = StoredVideoAssetPolicyDecision & {
  decisionDigest: string;
};

export type VideoAssetPolicyVerdict =
  | "allowed"
  | "denied"
  | "missing"
  | "expired"
  | "tampered"
  | "policy_version_mismatch"
  | "portrait_pending"
  | "portrait_check_failed"
  | "portrait_provider_pending"
  | "portrait_consent_invalid"
  | "portrait_rejected"
  | "signing_unavailable"
  | "storage_unavailable";

export type ResolvedVideoAssetPolicyDecision = VideoInputPolicyDecision & {
  verdict: VideoAssetPolicyVerdict;
  decisionId: string | null;
  decidedAt: number | null;
  decisionDigest: string | null;
};

export type TrustedVideoAssetPolicyEvidence = {
  version: typeof VIDEO_ASSET_POLICY_EVIDENCE_VERSION;
  workspaceId: string;
  projectId: string;
  assetVersionIds: readonly string[];
  enforcementEnabled: boolean;
  policyVersion: string;
  outputPolicy: VideoOutputPolicy;
  evidenceDigest: string;
  decisions: ReadonlyArray<{
    decisionId: string;
    decisionDigest: string;
    decidedAt: number | null;
    assetVersionId: string;
    authorizationEvidenceId: string;
    moderationEvidenceId: string;
    policyVersion: string;
    consentExpiresAt: string | null;
  }>;
};

export type VideoAssetPolicyResolution = {
  configuration: VideoAssetPolicyConfiguration;
  decisions: ResolvedVideoAssetPolicyDecision[];
  /** Present only when enforcement is disabled or every requested asset is allowed. */
  trustedEvidence: TrustedVideoAssetPolicyEvidence | null;
};

export type PortraitProviderReferenceBinding = Readonly<{
  admissionId: string;
  assetVersionId: string;
  bindingId: string;
  channelId: string;
  providerAssetId: string;
  providerAssetUri: string;
}>;

export type PortraitProviderReferenceResolution = Readonly<{
  schemaAvailable: boolean;
  bindings: readonly PortraitProviderReferenceBinding[];
}>;

export type PortraitProviderBoundPayload = Readonly<{
  allowedProviderAssetUris: ReadonlySet<string>;
  requestPayload: Record<string, unknown>;
}>;

export class VideoAssetPolicyError extends Error {
  code: string;
  status: number;
  statusCode: number;
  retryable: boolean;

  constructor(code: string, message: string, status = 422, retryable = false) {
    super(message);
    this.name = "VideoAssetPolicyError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.retryable = retryable;
  }
}

function fail(code: string, message: string, status = 422, retryable = false): never {
  throw new VideoAssetPolicyError(code, message, status, retryable);
}

function token(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value === value.trim()
    && OPAQUE_ID_PATTERN.test(value);
}

function validReason(value: unknown): value is string | null {
  return value === null
    || (typeof value === "string"
      && value === value.trim()
      && value.length > 0
      && value.length <= MAX_REASON_LENGTH
      && !/[\u0000-\u001f\u007f]/u.test(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function resolvedSigningKey(explicit?: string): string {
  const key = token(explicit) || token(process.env.FANJIN_ASSET_POLICY_SIGNING_KEY);
  return Buffer.byteLength(key, "utf8") >= MIN_SIGNING_KEY_BYTES ? key : "";
}

function signDecision(
  decision: Omit<StoredVideoAssetPolicyDecision, "signature">,
  key: string,
): string {
  return crypto.createHmac("sha256", key).update(stableJson(decision)).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!SIGNATURE_PATTERN.test(left) || !SIGNATURE_PATTERN.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseMetadata(value: unknown): Record<string, unknown> {
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

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function strictBoolean(raw: unknown, fallbackWhenMissing: boolean): boolean {
  if (raw === undefined) return fallbackWhenMissing;
  if (raw === true || raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === false || raw === "false" || raw === 0 || raw === "0") return false;
  fail("video_policy_setting_invalid", "视频素材合规门禁开关配置无效", 503);
}

function parsePolicyVersion(raw: unknown): string {
  if (raw === undefined) return DEFAULT_VIDEO_ASSET_POLICY_VERSION;
  const value = token(raw);
  if (!VERSION_PATTERN.test(value)) {
    fail("video_policy_setting_invalid", "视频素材策略版本配置无效", 503);
  }
  return value;
}

function parseOutputPolicy(raw: unknown, errorStatus = 503): VideoOutputPolicy {
  if (raw === undefined) return { ...DEFAULT_VIDEO_OUTPUT_POLICY };
  let value = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) {
      fail("video_output_policy_invalid", "视频输出策略不能为空", errorStatus);
    }
    try {
      value = JSON.parse(raw);
    } catch {
      fail("video_output_policy_invalid", "视频输出策略必须是合法 JSON", errorStatus);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("video_output_policy_invalid", "视频输出策略必须是 JSON 对象", errorStatus);
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["aigcLabel", "watermark", "retainPolicyEvidenceDays"])) {
    fail("video_output_policy_invalid", "视频输出策略字段不完整或包含未知字段", errorStatus);
  }
  const aigcLabel = token(record.aigcLabel);
  const watermark = token(record.watermark);
  const retainPolicyEvidenceDays = Number(record.retainPolicyEvidenceDays);
  if (
    !["required", "provider", "disabled"].includes(aigcLabel)
    || !["required", "provider", "disabled"].includes(watermark)
    || !Number.isSafeInteger(retainPolicyEvidenceDays)
    || retainPolicyEvidenceDays < 30
    || retainPolicyEvidenceDays > 3650
  ) {
    fail("video_output_policy_invalid", "视频输出标识、水印或证据保留策略无效", errorStatus);
  }
  return {
    aigcLabel: aigcLabel as VideoOutputPolicy["aigcLabel"],
    watermark: watermark as VideoOutputPolicy["watermark"],
    retainPolicyEvidenceDays,
  };
}

function productionEnvironment(nodeEnv = process.env.NODE_ENV): boolean {
  return ["prod", "production"].includes(token(nodeEnv).toLowerCase());
}

async function settingRows(
  database: Knex | Knex.Transaction,
): Promise<Map<string, unknown>> {
  if (!(await database.schema.hasTable("o_setting"))) return new Map();
  const rows = await database("o_setting")
    .whereIn("key", VIDEO_ASSET_POLICY_SETTING_DEFINITIONS.map((item) => item.key))
    .select("key", "value");
  return new Map(rows.map((row) => [String(row.key), row.value]));
}

function configurationFromRows(input: {
  rows: Map<string, unknown>;
  signingKey?: string;
  nodeEnv?: string;
}): VideoAssetPolicyConfiguration {
  const enforcementEnabled = strictBoolean(
    input.rows.get(VIDEO_ASSET_POLICY_ENFORCEMENT_SETTING),
    false,
  );
  const key = resolvedSigningKey(input.signingKey);
  if (enforcementEnabled && productionEnvironment(input.nodeEnv) && !key) {
    fail("video_policy_signing_unavailable", "视频素材策略签名能力尚未配置", 503);
  }
  return {
    enforcementEnabled,
    policyVersion: parsePolicyVersion(input.rows.get(VIDEO_ASSET_POLICY_VERSION_SETTING)),
    outputPolicy: parseOutputPolicy(input.rows.get(VIDEO_OUTPUT_POLICY_SETTING)),
    signingAvailable: Boolean(key),
  };
}

export async function readVideoAssetPolicyConfiguration(input: {
  database?: Knex | Knex.Transaction;
  signingKey?: string;
  nodeEnv?: string;
} = {}): Promise<VideoAssetPolicyConfiguration> {
  const database = input.database ?? db;
  return configurationFromRows({
    rows: await settingRows(database),
    signingKey: input.signingKey,
    nodeEnv: input.nodeEnv,
  });
}

function normalizeSettingPatch(input: Record<string, unknown>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [key, rawValue] of Object.entries(input || {})) {
    const definition = settingDefinitionMap.get(key);
    if (!definition) {
      fail("video_policy_setting_unknown", `未知视频素材策略设置：${key}`, 422);
    }
    if (definition.type === "boolean") {
      if (typeof rawValue !== "boolean") {
        fail("video_policy_setting_type_invalid", `${definition.label} 必须是布尔值`, 422);
      }
      normalized.set(key, rawValue ? "true" : "false");
      continue;
    }
    if (definition.type === "string") {
      const value = token(rawValue);
      if (!VERSION_PATTERN.test(value)) {
        fail("video_policy_setting_invalid", `${definition.label} 格式无效`, 422);
      }
      normalized.set(key, value);
      continue;
    }
    normalized.set(key, stableJson(parseOutputPolicy(rawValue, 422)));
  }
  return normalized;
}

/** Dedicated write path; generic FJ Admin settings deliberately reject these keys. */
export async function updateVideoAssetPolicySettings(input: {
  settings: Record<string, unknown>;
  database?: Knex | Knex.Transaction;
  signingKey?: string;
  nodeEnv?: string;
}): Promise<VideoAssetPolicyConfiguration> {
  const normalized = normalizeSettingPatch(input.settings);
  const persist = async (
    writer: Knex | Knex.Transaction,
  ): Promise<VideoAssetPolicyConfiguration> => {
    const existing = await settingRows(writer);
    const finalRows = new Map(existing);
    for (const [key, value] of normalized) finalRows.set(key, value);
    const configuration = configurationFromRows({
      rows: finalRows,
      signingKey: input.signingKey,
      nodeEnv: input.nodeEnv,
    });
    if (!(await writer.schema.hasTable("o_setting"))) {
      fail("video_policy_storage_unavailable", "视频素材策略设置存储不可用", 503);
    }
    for (const [key, value] of normalized) {
      const existingRow = await writer("o_setting").where({ key }).select("key").first();
      if (existingRow) await writer("o_setting").where({ key }).update({ value });
      else await writer("o_setting").insert({ key, value });
    }
    return configuration;
  };
  const database = input.database ?? db;
  if (typeof (database as Knex.Transaction).commit === "function") {
    return persist(database);
  }
  return (database as Knex).transaction((transaction) => persist(transaction));
}

function normalizeConsentExpiry(raw: unknown, decidedAt: number): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = token(raw);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= decidedAt) {
    fail("video_policy_consent_invalid", "素材授权有效期无效");
  }
  return new Date(timestamp).toISOString();
}

export async function recordVideoAssetPolicyDecision(input: {
  database?: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: string;
  assetVersionId: string;
  allowed: boolean;
  authorizationEvidenceId: string | null;
  moderationEvidenceId: string | null;
  policyVersion: string;
  consentExpiresAt?: string | null;
  reason?: string | null;
  actorUserId?: number | null;
  actorRole?: string | null;
  signingKey?: string;
  now?: Date;
}): Promise<VideoInputPolicyDecision> {
  const database = input.database ?? db;
  const key = resolvedSigningKey(input.signingKey);
  if (!key) fail("video_policy_signing_unavailable", "素材策略签名能力尚未配置", 503);
  if (!(await database.schema.hasTable("o_audit_log"))) {
    fail("video_policy_storage_unavailable", "素材策略审计存储不可用", 503);
  }
  const configuration = await readVideoAssetPolicyConfiguration({
    database,
    signingKey: key,
  });
  const workspaceId = token(input.workspaceId);
  const projectId = token(input.projectId);
  const assetVersionId = token(input.assetVersionId);
  const policyVersion = token(input.policyVersion);
  const authorizationEvidenceId = input.authorizationEvidenceId === null
    ? null
    : token(input.authorizationEvidenceId);
  const moderationEvidenceId = input.moderationEvidenceId === null
    ? null
    : token(input.moderationEvidenceId);
  const decidedAt = (input.now ?? new Date()).getTime();
  const decidedBy = input.actorUserId == null ? null : Number(input.actorUserId);
  const reason = input.reason == null ? null : token(input.reason);
  if (
    !validOpaqueId(workspaceId)
    || !validOpaqueId(projectId)
    || !validOpaqueId(assetVersionId)
    || !VERSION_PATTERN.test(policyVersion)
    || policyVersion !== configuration.policyVersion
    || !Number.isSafeInteger(decidedAt)
    || decidedAt <= 0
    || (decidedBy !== null && (!Number.isSafeInteger(decidedBy) || decidedBy <= 0))
    || (reason !== null && !validReason(reason))
    || (authorizationEvidenceId !== null && !validOpaqueId(authorizationEvidenceId))
    || (moderationEvidenceId !== null && !validOpaqueId(moderationEvidenceId))
  ) fail("video_policy_decision_invalid", "素材策略决策缺少有效身份或版本");
  if (typeof input.allowed !== "boolean") {
    fail("video_policy_decision_invalid", "素材策略决策必须明确允许或拒绝");
  }
  if (input.allowed && (!authorizationEvidenceId || !moderationEvidenceId)) {
    fail("video_policy_evidence_missing", "允许使用素材必须同时具备授权和审核凭证");
  }
  const consentExpiresAt = normalizeConsentExpiry(input.consentExpiresAt, decidedAt);
  const decisionWithoutSignature = {
    recordVersion: VIDEO_ASSET_POLICY_DECISION_VERSION,
    version: VIDEO_GENERATION_POLICY_VERSION,
    decisionId: uuid(),
    assetVersionId,
    workspaceId,
    projectId,
    allowed: input.allowed,
    authorizationEvidenceId,
    moderationEvidenceId,
    policyVersion,
    ...(consentExpiresAt ? { consentExpiresAt } : {}),
    reason,
    decidedAt,
    decidedBy,
  } satisfies Omit<StoredVideoAssetPolicyDecision, "signature">;
  const stored: StoredVideoAssetPolicyDecision = {
    ...decisionWithoutSignature,
    signature: signDecision(decisionWithoutSignature, key),
  };
  await database("o_audit_log").insert({
    id: stored.decisionId,
    workspaceId,
    actorUserId: decidedBy,
    actorRole: token(input.actorRole) || null,
    action: VIDEO_ASSET_POLICY_AUDIT_ACTION,
    resourceType: "asset_version",
    resourceId: assetVersionId,
    ip: null,
    userAgent: null,
    metadata: JSON.stringify(stored),
    createdAt: decidedAt,
  });
  return {
    version: stored.version,
    assetVersionId,
    workspaceId,
    projectId,
    allowed: stored.allowed,
    authorizationEvidenceId,
    moderationEvidenceId,
    policyVersion,
    ...(consentExpiresAt ? { consentExpiresAt } : {}),
    ...(reason ? { reason } : {}),
  };
}

function deniedDecision(input: {
  workspaceId: string;
  projectId: string;
  assetVersionId: string;
  policyVersion: string;
  verdict: Exclude<VideoAssetPolicyVerdict, "allowed">;
  message: string;
  decision?: VerifiedStoredDecision;
}): ResolvedVideoAssetPolicyDecision {
  return {
    version: VIDEO_GENERATION_POLICY_VERSION,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    assetVersionId: input.assetVersionId,
    allowed: false,
    authorizationEvidenceId: null,
    moderationEvidenceId: null,
    policyVersion: input.policyVersion,
    reason: input.message,
    verdict: input.verdict,
    decisionId: input.decision?.decisionId ?? null,
    decidedAt: input.decision?.decidedAt ?? null,
    decisionDigest: input.decision?.decisionDigest ?? null,
  };
}

function parseStoredDecision(input: {
  metadata: unknown;
  rowId: unknown;
  rowResourceId: unknown;
  rowCreatedAt: unknown;
  workspaceId: string;
  projectId: string;
  signingKey: string;
}): VerifiedStoredDecision | null {
  const metadata = parseMetadata(input.metadata);
  const hasConsentExpiry = Object.prototype.hasOwnProperty.call(metadata, "consentExpiresAt");
  const expectedKeys = [
    "recordVersion",
    "version",
    "decisionId",
    "assetVersionId",
    "workspaceId",
    "projectId",
    "allowed",
    "authorizationEvidenceId",
    "moderationEvidenceId",
    "policyVersion",
    ...(hasConsentExpiry ? ["consentExpiresAt"] : []),
    "reason",
    "decidedAt",
    "decidedBy",
    "signature",
  ];
  const decidedAt = Number(metadata.decidedAt);
  const rowCreatedAt = Number(input.rowCreatedAt);
  const decidedBy = metadata.decidedBy === null ? null : Number(metadata.decidedBy);
  const consentExpiresAt = hasConsentExpiry ? token(metadata.consentExpiresAt) : null;
  const authorizationEvidenceId = metadata.authorizationEvidenceId;
  const moderationEvidenceId = metadata.moderationEvidenceId;
  if (
    !exactKeys(metadata, expectedKeys)
    || metadata.recordVersion !== VIDEO_ASSET_POLICY_DECISION_VERSION
    || metadata.version !== VIDEO_GENERATION_POLICY_VERSION
    || !validOpaqueId(metadata.decisionId)
    || metadata.decisionId !== token(input.rowId)
    || !validOpaqueId(metadata.assetVersionId)
    || metadata.assetVersionId !== token(input.rowResourceId)
    || !validOpaqueId(metadata.workspaceId)
    || metadata.workspaceId !== input.workspaceId
    || !validOpaqueId(metadata.projectId)
    || metadata.projectId !== input.projectId
    || typeof metadata.allowed !== "boolean"
    || (authorizationEvidenceId !== null && !validOpaqueId(authorizationEvidenceId))
    || (moderationEvidenceId !== null && !validOpaqueId(moderationEvidenceId))
    || (metadata.allowed && (authorizationEvidenceId === null || moderationEvidenceId === null))
    || !VERSION_PATTERN.test(token(metadata.policyVersion))
    || !validReason(metadata.reason)
    || !Number.isSafeInteger(decidedAt)
    || decidedAt <= 0
    || decidedAt !== rowCreatedAt
    || (decidedBy !== null && (!Number.isSafeInteger(decidedBy) || decidedBy <= 0))
    || (hasConsentExpiry && (
      !consentExpiresAt
      || !Number.isFinite(Date.parse(consentExpiresAt))
      || new Date(Date.parse(consentExpiresAt)).toISOString() !== consentExpiresAt
    ))
    || !SIGNATURE_PATTERN.test(token(metadata.signature))
  ) return null;
  const unsigned = { ...metadata } as Record<string, unknown>;
  delete unsigned.signature;
  if (!constantTimeEqual(
    token(metadata.signature),
    signDecision(
      unsigned as Omit<StoredVideoAssetPolicyDecision, "signature">,
      input.signingKey,
    ),
  )) return null;
  const stored = metadata as unknown as StoredVideoAssetPolicyDecision;
  return { ...stored, decisionDigest: sha256(stored) };
}

function buildTrustedEvidence(input: {
  workspaceId: string;
  projectId: string;
  assetVersionIds: string[];
  configuration: VideoAssetPolicyConfiguration;
  decisions: ResolvedVideoAssetPolicyDecision[];
}): TrustedVideoAssetPolicyEvidence | null {
  const allowed = input.decisions.filter((decision) => decision.verdict === "allowed");
  // A schema-47 admission decision is authoritative even while the legacy
  // feature flag remains disabled for schema-46 rolling compatibility. Never
  // turn a concrete portrait denial into apparently trusted empty evidence.
  if (allowed.length !== input.decisions.length) {
    return null;
  }
  const decisions = allowed.map((decision) => Object.freeze({
    decisionId: decision.decisionId!,
    decisionDigest: decision.decisionDigest!,
    decidedAt: decision.decidedAt,
    assetVersionId: decision.assetVersionId,
    authorizationEvidenceId: decision.authorizationEvidenceId!,
    moderationEvidenceId: decision.moderationEvidenceId!,
    policyVersion: decision.policyVersion,
    consentExpiresAt: decision.consentExpiresAt || null,
  }));
  const outputPolicy = Object.freeze({ ...input.configuration.outputPolicy });
  const assetVersionIds = Object.freeze([...input.assetVersionIds]);
  const core = {
    version: VIDEO_ASSET_POLICY_EVIDENCE_VERSION,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    assetVersionIds,
    enforcementEnabled: input.configuration.enforcementEnabled,
    policyVersion: input.configuration.policyVersion,
    outputPolicy,
    decisions: Object.freeze(decisions),
  };
  return Object.freeze({
    ...core,
    evidenceDigest: sha256(core),
  }) as TrustedVideoAssetPolicyEvidence;
}

type PortraitPolicyRow = {
  admissionId: unknown;
  admissionAssetId: unknown;
  admissionAssetVersionId: unknown;
  admissionWorkspaceId: unknown;
  admissionProjectId: unknown;
  complianceState: unknown;
  consentExpiresAt: unknown;
  consentIdentityId: unknown;
  consentStatus: unknown;
  consentType: unknown;
  currentConsentId: unknown;
  currentManualReviewId: unknown;
  currentProviderAssetBindingId: unknown;
  declarationState: unknown;
  detectorEvidenceHash: unknown;
  faceCount: unknown;
  faceScanCoverage: unknown;
  faceScanState: unknown;
  groupBindingId: unknown;
  groupChannelId: unknown;
  groupIdentityId: unknown;
  groupProvider: unknown;
  groupState: unknown;
  groupType: unknown;
  identityActiveConsentId: unknown;
  identityId: unknown;
  identityKind: unknown;
  identityState: unknown;
  manualReviewDecision: unknown;
  manualReviewEvidenceHash: unknown;
  manualReviewPolicyVersion: unknown;
  manualReviewedAt: unknown;
  manualReviewedByUserId: unknown;
  manualReviewState: unknown;
  mediaType: unknown;
  moderationEvidenceHash: unknown;
  moderationState: unknown;
  moderationReasonCode: unknown;
  preferredProviderChannelId: unknown;
  providerAssetAdmissionId: unknown;
  providerAssetChannelId: unknown;
  providerAssetGroupBindingId: unknown;
  providerAssetId: unknown;
  providerAssetSourceSha256: unknown;
  providerAssetState: unknown;
  providerAssetUri: unknown;
  providerSyncState: unknown;
  revision: unknown;
  safeErrorCode: unknown;
  sourceSha256: unknown;
  subjectKind: unknown;
  updatedAt: unknown;
  sourceProjectId: unknown;
  versionAssetId: unknown;
  versionId: unknown;
};

function portraitManagedMediaType(value: unknown): "image" | "video" | "other" {
  const normalized = token(value).toLowerCase();
  if (["role", "scene", "tool", "image"].includes(normalized)) return "image";
  if (["clip", "video"].includes(normalized)) return "video";
  return "other";
}

async function portraitAdmissionSchemaAvailable(
  database: Knex | Knex.Transaction,
): Promise<boolean> {
  return database.schema.hasTable(PORTRAIT_ADMISSION_TABLE);
}

async function loadPortraitPolicyRows(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: string;
  assetVersionIds: string[];
}): Promise<Map<string, PortraitPolicyRow>> {
  if (!input.assetVersionIds.length) return new Map();
  const authorized = (await Promise.all(input.assetVersionIds.map((id) => resolveProjectAssetVersion({
    database: input.database, workspaceId: input.workspaceId, projectId: Number(input.projectId), assetVersionId: Number(id),
  })))).filter((row): row is NonNullable<typeof row> => row !== null);
  if (!authorized.length) return new Map();
  const rows = await input.database("o_image as version")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .leftJoin(`${PORTRAIT_ADMISSION_TABLE} as admission`, function joinAdmission() {
      this.on("admission.assetVersionId", "=", "version.id")
        .andOn("admission.assetId", "=", "asset.id")
        .andOn("admission.projectId", "=", "project.id")
        .andOn("admission.workspaceId", "=", "project.workspaceId");
    })
    .leftJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "admission.identityId")
    .leftJoin(`${PORTRAIT_CONSENT_TABLE} as consent`, "consent.id", "admission.currentConsentId")
    .leftJoin(`${PORTRAIT_PROVIDER_ASSET_TABLE} as providerAsset`, "providerAsset.id", "admission.currentProviderAssetBindingId")
    .leftJoin(`${PORTRAIT_PROVIDER_GROUP_TABLE} as providerGroup`, "providerGroup.id", "providerAsset.groupBindingId")
    .where({
      "project.workspaceId": input.workspaceId,
      "project.deletionState": "active",
      "asset.deletionState": "active",
      "version.deletionState": "active",
    })
    .whereRaw(
      `CAST(?? AS TEXT) IN (${authorized.map(() => "?").join(", ")})`,
      ["version.id", ...authorized.map((row) => String(row.id))],
    )
    .select({
      versionId: "version.id",
      sourceProjectId: "project.id",
      versionAssetId: "version.assetsId",
      mediaType: "version.type",
      admissionId: "admission.id",
      admissionWorkspaceId: "admission.workspaceId",
      admissionProjectId: "admission.projectId",
      admissionAssetId: "admission.assetId",
      admissionAssetVersionId: "admission.assetVersionId",
      faceScanState: "admission.faceScanState",
      subjectKind: "admission.subjectKind",
      declarationState: "admission.declarationState",
      detectorEvidenceHash: "admission.detectorEvidenceHash",
      faceCount: "admission.faceCount",
      faceScanCoverage: "admission.faceScanCoverage",
      moderationState: "admission.moderationState",
      moderationReasonCode: "admission.moderationReasonCode",
      moderationEvidenceHash: "admission.moderationEvidenceHash",
      complianceState: "admission.complianceState",
      providerSyncState: "admission.providerSyncState",
      identityId: "admission.identityId",
      currentConsentId: "admission.currentConsentId",
      currentManualReviewId: "admission.currentManualReviewId",
      currentProviderAssetBindingId: "admission.currentProviderAssetBindingId",
      manualReviewDecision: "admission.manualReviewDecision",
      manualReviewEvidenceHash: "admission.manualReviewEvidenceHash",
      manualReviewPolicyVersion: "admission.manualReviewPolicyVersion",
      manualReviewedAt: "admission.manualReviewedAt",
      manualReviewedByUserId: "admission.manualReviewedByUserId",
      manualReviewState: "admission.manualReviewState",
      preferredProviderChannelId: "admission.preferredProviderChannelId",
      safeErrorCode: "admission.safeErrorCode",
      sourceSha256: "admission.sourceSha256",
      revision: "admission.revision",
      updatedAt: "admission.updatedAt",
      identityKind: "identity.kind",
      identityState: "identity.state",
      identityActiveConsentId: "identity.activeConsentId",
      consentIdentityId: "consent.identityId",
      consentType: "consent.consentType",
      consentStatus: "consent.status",
      consentExpiresAt: "consent.expiresAt",
      providerAssetAdmissionId: "providerAsset.admissionId",
      providerAssetGroupBindingId: "providerAsset.groupBindingId",
      providerAssetChannelId: "providerAsset.channelId",
      providerAssetId: "providerAsset.providerAssetId",
      providerAssetUri: "providerAsset.providerAssetUri",
      providerAssetState: "providerAsset.state",
      providerAssetSourceSha256: "providerAsset.sourceSha256",
      groupBindingId: "providerGroup.id",
      groupChannelId: "providerGroup.channelId",
      groupIdentityId: "providerGroup.identityId",
      groupProvider: "providerGroup.provider",
      groupType: "providerGroup.groupType",
      groupState: "providerGroup.state",
    }) as PortraitPolicyRow[];
  return new Map(rows.map((row) => [String(row.versionId), row]));
}

function portraitFailureDecision(input: {
  workspaceId: string;
  projectId: string;
  assetVersionId: string;
  policyVersion: string;
  verdict: "portrait_pending" | "portrait_check_failed" | "portrait_provider_pending" | "portrait_consent_invalid" | "portrait_rejected";
  message: string;
}): ResolvedVideoAssetPolicyDecision {
  return deniedDecision(input);
}

function validSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/u.test(token(value).toLowerCase());
}

function validProviderAssetUri(providerAssetId: string, providerAssetUri: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(providerAssetId)
    && providerAssetUri === `asset://${providerAssetId}`;
}

function imagePortraitChannelFingerprint(channel: Record<string, unknown>): string | null {
  if (token(channel.endpointType) !== "image_generation") return null;
  fail(
    "portrait_image_reference_protocol_unsupported",
    "当前图片生成协议不支持受信人像 asset:// 引用",
    409,
    false,
  );
}

function videoPortraitChannelFingerprint(channel: Record<string, unknown>): string | null {
  const config = parseProviderChannelConfig(channel.configJson);
  const providerAccountId = token(config.providerAccountId ?? config.volcengineAccountId ?? config.accountId);
  const projectName = token(config.assetsProjectName ?? config.projectName);
  const metadata = readProviderChannelPortraitCredentialMetadata(config);
  if (!providerAccountId || !projectName || !metadata.enabled || !metadata.binding || metadata.generation < 1) {
    return null;
  }
  return portraitProviderAccountFingerprint({ channelId: token(channel.id), providerAccountId, projectName }, metadata.binding);
}

function derivedPortraitPolicyDecision(input: {
  row: PortraitPolicyRow;
  workspaceId: string;
  projectId: string;
  assetVersionId: string;
  policyVersion: string;
  now: number;
  requirePortraitRegistration?: boolean;
}): ResolvedVideoAssetPolicyDecision | null {
  const row = withPortraitReviewScope(input.row);
  const mediaType = portraitManagedMediaType(row.mediaType);
  const admissionId = token(row.admissionId);
  if (mediaType === "other") {
    // Audio has no portrait review event. Keep its derived proof undated so
    // rereading the same version does not invalidate it at Relay dispatch.
    const decidedAt = null;
    const authorizationEvidenceId = `portrait-not-required:${input.assetVersionId}`;
    const moderationEvidenceId = `portrait-not-required:${input.assetVersionId}`;
    const decisionId = `portrait-non-media:${input.assetVersionId}`;
    const decisionDigest = sha256({
      assetVersionId: input.assetVersionId,
      kind: "non_portrait_media",
      policyVersion: input.policyVersion,
    });
    return {
      version: VIDEO_GENERATION_POLICY_VERSION,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetVersionId: input.assetVersionId,
      allowed: true,
      authorizationEvidenceId,
      moderationEvidenceId,
      policyVersion: input.policyVersion,
      verdict: "allowed",
      decisionId,
      decidedAt,
      decisionDigest,
    };
  }

  // Once schema-47 exists, an image/video without an admission row is not
  // distinguishable from a write produced by an older binary during a rolling
  // deployment. Fail closed until the read/repair path creates and evaluates
  // its admission. Schema-46 compatibility is handled before this function is
  // called, when the table itself is absent.
  if (!admissionId) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_pending",
      message: "参考素材尚未建立人像准入记录，请打开素材完成校验",
    });
  }
  if (
    token(row.admissionWorkspaceId) !== input.workspaceId
    || String(row.admissionProjectId) !== String(row.sourceProjectId)
    || String(row.admissionAssetId) !== String(row.versionAssetId)
    || String(row.admissionAssetVersionId) !== input.assetVersionId
  ) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_rejected",
      message: "参考素材的人像准入范围校验失败",
    });
  }

  if (hasUpstreamRealPersonRejection(row)) {
    return portraitFailureDecision({ ...input, verdict: "portrait_rejected",
      message: "生成平台认为该参考素材可能含真人，请打开人物素材检查确认来源、完成登记或联系管理员复核" });
  }
  if (isPortraitProviderRefusal(row.safeErrorCode)) {
    return portraitFailureDecision({ ...input, verdict: "portrait_rejected",
      message: "生成平台已拒绝此人物素材，请查看素材详情并更换素材或申请复核" });
  }
  if (token(row.complianceState) === "denied" && token(row.moderationState) === "denied" && row.safeErrorCode !== "PORTRAIT_SOURCE_UNCERTAIN") {
    return portraitFailureDecision({ ...input, verdict: "portrait_rejected",
      message: "参考素材的人像授权或准入状态不可用" });
  }
  if (!input.requirePortraitRegistration && !hasPortraitSubmissionRestriction(row, input.now)) {
    // This permits submission of the original authorized media for provider
    // review. It is not a successful face scan or portrait registration.
    // Background scan/sync progress must not invalidate an in-flight quote.
    const decisionId = `portrait-precheck-advisory:${admissionId}`;
    const authorizationEvidenceId = `project-asset:${input.assetVersionId}`;
    const moderationEvidenceId = `provider-review-pending:${admissionId}`;
    return {
      version: VIDEO_GENERATION_POLICY_VERSION,
      workspaceId: input.workspaceId, projectId: input.projectId, assetVersionId: input.assetVersionId,
      allowed: true, verdict: "allowed", policyVersion: input.policyVersion,
      authorizationEvidenceId, moderationEvidenceId, decisionId, decidedAt: null,
      decisionDigest: sha256({ decisionId, workspaceId: input.workspaceId, projectId: input.projectId,
        assetVersionId: input.assetVersionId, policyVersion: input.policyVersion,
        authorizationEvidenceId, moderationEvidenceId }),
      reason: "人像预检仅作提示，原始素材可提交生成，最终审核以生成供应商为准",
    };
  }
  const scan = token(row.faceScanState);
  if (["queued", "scanning"].includes(scan)) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_pending",
      message: "参考素材的人像预检尚未完成，请稍后重试",
    });
  }
  // Source confirmation must not invalidate an existing AIGC multi-face asset.
  // Identity, consent, source hash and active provider binding are checked below.
  const declaredAigc = isDeclaredPortrait(row) && token(row.groupType) === "AIGC";
  if (scan === "multiple_faces" && !isAutomaticPortrait(row) && !declaredAigc && !(mediaType === "video" && isDeclaredPortrait(row))) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_rejected",
      message: "参考素材包含多张人脸，请拆分或更换素材",
    });
  }

  const subjectKind = token(row.subjectKind);
  const updatedAt = Number(row.updatedAt);
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0 || !Number.isSafeInteger(revision) || revision < 1) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_rejected",
      message: "参考素材的人像准入状态无效",
    });
  }

  const faceScanCoverage = token(row.faceScanCoverage);
  const fullImageNoFaceEvidence = mediaType === "image"
    && faceScanCoverage === "full_image";
  const manualReviewedAt = Number(row.manualReviewedAt);
  const manualReviewedByUserId = Number(row.manualReviewedByUserId);
  const fullVideoNoFaceEvidence = mediaType === "video"
    && faceScanCoverage === "full_video_manual"
    && token(row.manualReviewState) === "completed"
    && validOpaqueId(token(row.currentManualReviewId))
    && token(row.manualReviewDecision) === "no_face"
    && validSha256(row.manualReviewEvidenceHash)
    && token(row.manualReviewPolicyVersion) === PORTRAIT_MANUAL_REVIEW_POLICY_VERSION
    && Number.isSafeInteger(manualReviewedByUserId)
    && manualReviewedByUserId > 0
    && Number.isSafeInteger(manualReviewedAt)
    && manualReviewedAt > 0
    && manualReviewedAt <= input.now;
  if (
    scan === "no_face"
    && !isDeclaredPortrait(row)
    && (fullImageNoFaceEvidence || fullVideoNoFaceEvidence)
    && row.faceCount != null
    && Number(row.faceCount) === 0
    && validSha256(row.detectorEvidenceHash)
  ) {
    if (
      ["denied", "revoked", "expired"].includes(token(row.complianceState))
    ) {
      return portraitFailureDecision({
        ...input,
        verdict: "portrait_rejected",
        message: "参考素材的人像授权或准入状态不可用",
      });
    }
    if (
      subjectKind !== "ordinary"
      || token(row.declarationState) !== "not_required"
      || token(row.providerSyncState) !== "not_needed"
    ) {
      return portraitFailureDecision({
        ...input,
        verdict: "portrait_pending",
        message: "普通参考素材的人像预检状态异常，请重试",
      });
    }
    const authorizationEvidenceId = `portrait-not-required:${admissionId}`;
    const moderationEvidenceId = portraitScopeEvidenceId(admissionId, revision);
    const decisionId = `portrait-admission:${admissionId}:r${revision}`;
    const decisionDigest = sha256({
      admissionId,
      authorizationEvidenceId,
      complianceState: token(row.complianceState),
      decisionId,
      detectorEvidenceHash: token(row.detectorEvidenceHash),
      faceScanState: scan,
      faceScanCoverage,
      manualReviewEvidenceHash: fullVideoNoFaceEvidence
        ? token(row.manualReviewEvidenceHash)
        : null,
      manualReviewId: fullVideoNoFaceEvidence
        ? token(row.currentManualReviewId)
        : null,
      manualReviewPolicyVersion: fullVideoNoFaceEvidence
        ? PORTRAIT_MANUAL_REVIEW_POLICY_VERSION
        : null,
      manualReviewedAt: fullVideoNoFaceEvidence ? manualReviewedAt : null,
      manualReviewedByUserId: fullVideoNoFaceEvidence ? manualReviewedByUserId : null,
      mediaType,
      moderationEvidenceId,
      policyVersion: input.policyVersion,
      revision,
      subjectKind,
      updatedAt,
    });
    return {
      version: VIDEO_GENERATION_POLICY_VERSION,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetVersionId: input.assetVersionId,
      allowed: true,
      authorizationEvidenceId,
      moderationEvidenceId,
      policyVersion: input.policyVersion,
      verdict: "allowed",
      decisionId,
      decidedAt: updatedAt,
      decisionDigest,
    };
  }
  if (scan === "no_face" && !isDeclaredPortrait(row) && !isUnconfirmedVideoNoFace(row)) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_rejected",
      message: "参考素材的人像检测证据不完整，请重新检查素材",
    });
  }
  if ((["uncertain", "failed"].includes(scan) || isUnconfirmedVideoNoFace(row)) && !isDeclaredPortrait(row)) {
    if (
      subjectKind !== "ordinary"
      || token(row.declarationState) !== "confirmed"
      || !["not_required", "allowed"].includes(token(row.complianceState))
      || token(row.providerSyncState) !== "not_needed"
    ) {
      return portraitFailureDecision({
        ...input,
        verdict: "portrait_pending",
        message: "素材人像检测未能确认，请先确认真实来源并完成所需登记",
      });
    }
    const authorizationEvidenceId = `portrait-not-required:${admissionId}`;
    const moderationEvidenceId = portraitScopeEvidenceId(admissionId, revision);
    const decisionId = `portrait-admission:${admissionId}:r${revision}`;
    const decisionDigest = sha256({
      admissionId,
      authorizationEvidenceId,
      complianceState: token(row.complianceState),
      decisionId,
      moderationEvidenceId,
      policyVersion: input.policyVersion,
      revision,
      subjectKind,
      updatedAt,
    });
    return {
      version: VIDEO_GENERATION_POLICY_VERSION,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetVersionId: input.assetVersionId,
      allowed: true,
      authorizationEvidenceId,
      moderationEvidenceId,
      policyVersion: input.policyVersion,
      verdict: "allowed",
      decisionId,
      decidedAt: updatedAt,
      decisionDigest,
    };
  }

  const automatic = isAutomaticPortrait(row);
  const supportedScan = ["single_face", "no_face", "uncertain", "failed"].includes(scan)
    || ((mediaType === "video" || declaredAigc) && scan === "multiple_faces");
  if (!automatic && (!isDeclaredPortrait(row) || !supportedScan)) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_rejected",
      message: "检测到人像，请先确认素材中的人物类型",
    });
  }
  if (
    (!automatic && token(row.declarationState) !== "confirmed")
    || token(row.complianceState) !== "allowed"
  ) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_pending",
      message: "参考素材的人像声明或合规状态尚未就绪",
    });
  }

  const identityId = token(row.identityId);
  const consentId = automatic ? `portrait-registration:${admissionId}` : token(row.currentConsentId);
  // New default: real-person materials are processed as virtual portraits
  // (AIGC). Legacy real_person + LivenessFace bindings remain acceptable.
  const legacyReal = subjectKind === "real_person"
    && token(row.identityKind) === "real_person"
    && token(row.consentType) === "real_person_rights"
    && token(row.groupType) === "LivenessFace";
  const expectedIdentityKind = automatic
    ? "detected_person"
    : legacyReal ? "real_person" : "virtual_person";
  const expectedConsentType = legacyReal
    ? "real_person_rights"
    : subjectKind === "trusted_output"
      ? "trusted_output_attestation"
      : "virtual_person_rights";
  const expiresAt = row.consentExpiresAt == null ? null : Number(row.consentExpiresAt);
  if (
    !identityId
    || !consentId
    || token(row.identityKind) !== expectedIdentityKind
    || token(row.identityState) !== "active"
    || (!automatic && (
      token(row.identityActiveConsentId) !== consentId
      || token(row.consentIdentityId) !== identityId
      || token(row.consentType) !== expectedConsentType
      || token(row.consentStatus) !== "active"
      || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= input.now))
    ))
    || (automatic && row.currentConsentId != null)
  ) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_consent_invalid",
      message: "参考素材的人像身份或授权未生效，请重新授权后重试",
    });
  }

  const providerAssetId = token(row.providerAssetId);
  const providerAssetUri = token(row.providerAssetUri);
  const expectedGroupType = legacyReal ? "LivenessFace" : "AIGC";
  if (
    token(row.providerSyncState) !== "active"
    || !token(row.currentProviderAssetBindingId)
    || token(row.providerAssetState) !== "active"
    || token(row.providerAssetAdmissionId) !== admissionId
    || token(row.providerAssetGroupBindingId) !== token(row.groupBindingId)
    || token(row.providerAssetChannelId) !== token(row.groupChannelId)
    || token(row.groupIdentityId) !== identityId
    || token(row.groupProvider) !== "volcano"
    || token(row.groupState) !== "active"
    || token(row.groupType) !== expectedGroupType
    || !validProviderAssetUri(providerAssetId, providerAssetUri)
    || !validSha256(row.sourceSha256)
    || token(row.providerAssetSourceSha256).toLowerCase() !== token(row.sourceSha256).toLowerCase()
  ) {
    return portraitFailureDecision({
      ...input,
      verdict: "portrait_provider_pending",
      message: "参考素材的上游人像资产尚未就绪，请稍后重试",
    });
  }

  const moderationEvidenceId = portraitScopeEvidenceId(admissionId, revision);
  const decisionId = `portrait-admission:${admissionId}:r${revision}`;
  const consentExpiresAt = expiresAt === null ? undefined : new Date(expiresAt).toISOString();
  const decisionDigest = sha256({
    admissionId,
    bindingId: token(row.currentProviderAssetBindingId),
    consentExpiresAt: consentExpiresAt ?? null,
    consentId,
    decisionId,
    identityId,
    moderationEvidenceId,
    policyVersion: input.policyVersion,
    providerAssetId,
    providerAssetUri,
    revision,
    subjectKind,
    updatedAt,
  });
  return {
    version: VIDEO_GENERATION_POLICY_VERSION,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    assetVersionId: input.assetVersionId,
    allowed: true,
    authorizationEvidenceId: consentId,
    moderationEvidenceId,
    policyVersion: input.policyVersion,
    ...(consentExpiresAt ? { consentExpiresAt } : {}),
    verdict: "allowed",
    decisionId,
    decidedAt: updatedAt,
    decisionDigest,
  };
}

export async function resolveVideoAssetPolicyDecisions(input: {
  database?: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: string;
  assetVersionIds: string[];
  signingKey?: string;
  nodeEnv?: string;
  now?: Date;
  /** Registration inspection may require readiness; generation uses advisory checks by default. */
  requirePortraitRegistration?: boolean;
}): Promise<VideoAssetPolicyResolution> {
  const database = input.database ?? db;
  const workspaceId = token(input.workspaceId);
  const projectId = token(input.projectId);
  const assetVersionIds = Array.from(new Set(input.assetVersionIds.map(token)));
  if (
    !validOpaqueId(workspaceId)
    || !validOpaqueId(projectId)
    || assetVersionIds.some((id) => !validOpaqueId(id))
  ) fail("video_policy_scope_invalid", "素材策略解析缺少工作区、项目或素材版本");
  const configuration = await readVideoAssetPolicyConfiguration({
    database,
    signingKey: input.signingKey,
    nodeEnv: input.nodeEnv,
  });
  if (assetVersionIds.length === 0) {
    const decisions: ResolvedVideoAssetPolicyDecision[] = [];
    return {
      configuration,
      decisions,
      trustedEvidence: buildTrustedEvidence({
        workspaceId,
        projectId,
        assetVersionIds,
        configuration,
        decisions,
      }),
    };
  }

  const admissionSchema = await portraitAdmissionSchemaAvailable(database);
  let portraitRows = admissionSchema
    ? await loadPortraitPolicyRows({ database, workspaceId, projectId, assetVersionIds })
    : new Map<string, PortraitPolicyRow>();
  if (admissionSchema) {
    let repairedMissingAdmission = false;
    for (const row of portraitRows.values()) {
      if (
        portraitManagedMediaType(row.mediaType) === "other"
        || token(row.admissionId)
      ) continue;
      const admissionId = await ensurePortraitAdmissionForAsset({
        database,
        workspaceId,
        projectId: Number(projectId),
        assetVersionId: Number(row.versionId),
      });
      repairedMissingAdmission = repairedMissingAdmission || Boolean(admissionId);
    }
    if (repairedMissingAdmission) {
      // Reload the queued admission so generation can return an advisory
      // decision without waiting for the user to open asset details.
      portraitRows = await loadPortraitPolicyRows({
        database,
        workspaceId,
        projectId,
        assetVersionIds,
      });
    }
  }
  const key = resolvedSigningKey(input.signingKey);
  const auditStorageAvailable = await database.schema.hasTable("o_audit_log");
  const rows = auditStorageAvailable
    ? await database("o_audit_log")
        .where({
          workspaceId,
          action: VIDEO_ASSET_POLICY_AUDIT_ACTION,
          resourceType: "asset_version",
        })
        .whereIn("resourceId", assetVersionIds)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .select("id", "resourceId", "metadata", "createdAt")
    : [];
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const assetVersionId = token(row.resourceId);
    if (assetVersionIds.includes(assetVersionId) && !latest.has(assetVersionId)) {
      latest.set(assetVersionId, row);
    }
  }
  const now = (input.now ?? new Date()).getTime();
  const decisions = assetVersionIds.flatMap((assetVersionId): ResolvedVideoAssetPolicyDecision[] => {
    const derived = admissionSchema
      ? portraitRows.has(assetVersionId)
        ? derivedPortraitPolicyDecision({
          row: portraitRows.get(assetVersionId)!,
          workspaceId,
          projectId,
          assetVersionId,
          policyVersion: configuration.policyVersion,
          now,
          requirePortraitRegistration: input.requirePortraitRegistration,
        })
        : portraitFailureDecision({
          workspaceId,
          projectId,
          assetVersionId,
          policyVersion: configuration.policyVersion,
          verdict: "portrait_rejected",
          message: "参考素材不存在或不属于当前项目",
        })
      : null;
    const row = latest.get(assetVersionId);
    let stored: VerifiedStoredDecision | null = null;
    if (row) {
      if (!key) return [deniedDecision({
        workspaceId,
        projectId,
        assetVersionId,
        policyVersion: configuration.policyVersion,
        verdict: "signing_unavailable",
        message: "素材策略签名能力不可用",
      })];
      stored = parseStoredDecision({
        metadata: row.metadata,
        rowId: row.id,
        rowResourceId: row.resourceId,
        rowCreatedAt: row.createdAt,
        workspaceId,
        projectId,
        signingKey: key,
      });
      // A malformed newest record must not shadow an earlier administrator
      // rejection. Never scan past it and never let admission state bypass it.
      if (!stored) return [deniedDecision({
        workspaceId,
        projectId,
        assetVersionId,
        policyVersion: configuration.policyVersion,
        verdict: "tampered",
        message: "素材授权与审核决策校验失败",
      })];
      // A current, signed administrator rejection is an absolute deny. It
      // remains effective even while the legacy feature flag is disabled or a
      // newer admission happens to be otherwise ready.
      if (!stored.allowed) return [deniedDecision({
        workspaceId,
        projectId,
        assetVersionId,
        policyVersion: configuration.policyVersion,
        verdict: "denied",
        message: "素材未通过授权与审核",
        decision: stored,
      })];
    }

    // Schema-47 admission is authoritative for advisory checks and enforced
    // rights/provider restrictions; legacy signed allows cannot override it.
    if (derived) return [derived];

    // Only a schema-46 binary/database (the admission table is absent) may use
    // the legacy feature-flag path. With schema-47 present, image/video rows
    // without an admission have already produced a fail-closed decision above.
    if (!configuration.enforcementEnabled) return [];
    if (!auditStorageAvailable) return [deniedDecision({
      workspaceId,
      projectId,
      assetVersionId,
      policyVersion: configuration.policyVersion,
      verdict: "storage_unavailable",
      message: "素材策略审计存储不可用",
    })];
    if (!key) return [deniedDecision({
      workspaceId,
      projectId,
      assetVersionId,
      policyVersion: configuration.policyVersion,
      verdict: "signing_unavailable",
      message: "素材策略签名能力不可用",
    })];
    if (!stored) return [deniedDecision({
      workspaceId,
      projectId,
      assetVersionId,
      policyVersion: configuration.policyVersion,
      verdict: "missing",
      message: "素材尚无有效授权与审核决策",
    })];
    if (stored.policyVersion !== configuration.policyVersion) return [deniedDecision({
      workspaceId,
      projectId,
      assetVersionId,
      policyVersion: configuration.policyVersion,
      verdict: "policy_version_mismatch",
      message: "素材授权与审核决策策略版本已失效",
      decision: stored,
    })];
    const expired = stored.consentExpiresAt
      ? Date.parse(stored.consentExpiresAt) <= now
      : false;
    if (expired) return [deniedDecision({
      workspaceId,
      projectId,
      assetVersionId,
      policyVersion: configuration.policyVersion,
      verdict: "expired",
      message: "素材授权已失效",
      decision: stored,
    })];
    return [{
      version: stored.version,
      assetVersionId,
      workspaceId,
      projectId,
      allowed: true,
      authorizationEvidenceId: stored.authorizationEvidenceId,
      moderationEvidenceId: stored.moderationEvidenceId,
      policyVersion: stored.policyVersion,
      ...(stored.consentExpiresAt ? { consentExpiresAt: stored.consentExpiresAt } : {}),
      verdict: "allowed",
      decisionId: stored.decisionId,
      decidedAt: stored.decidedAt,
      decisionDigest: stored.decisionDigest,
    }];
  });
  return {
    configuration,
    decisions,
    trustedEvidence: buildTrustedEvidence({
      workspaceId,
      projectId,
      assetVersionIds,
      configuration,
      decisions,
    }),
  };
}

function throwPortraitPolicyDecision(decision: ResolvedVideoAssetPolicyDecision): never {
  const failures: Partial<Record<VideoAssetPolicyVerdict, {
    code: string;
    message: string;
    retryable: boolean;
    status: number;
  }>> = {
    denied: {
      code: "video_asset_policy_denied",
      message: "参考素材已被管理员拒绝使用",
      retryable: false,
      status: 409,
    },
    portrait_check_failed: {
      code: "portrait_check_failed",
      message: decision.reason || "参考素材检查失败，请检查媒体服务配置后重新检测素材",
      retryable: false,
      status: 409,
    },
    portrait_pending: {
      code: "portrait_admission_pending",
      message: decision.reason || "参考素材的人像校验尚未完成，请稍后重试",
      retryable: true,
      status: 409,
    },
    portrait_provider_pending: {
      code: "portrait_provider_binding_pending",
      message: decision.reason || "参考素材的上游人像资产尚未就绪，请稍后重试",
      retryable: true,
      status: 409,
    },
    portrait_consent_invalid: {
      code: "portrait_consent_inactive",
      message: decision.reason || "参考素材的人像授权未生效，请重新授权后重试",
      retryable: true,
      status: 409,
    },
    portrait_rejected: {
      code: "portrait_admission_denied",
      message: decision.reason || "参考素材未通过人像准入校验",
      retryable: false,
      status: 409,
    },
  };
  const failure = failures[decision.verdict] || {
    code: "video_asset_policy_denied",
    message: decision.reason || "参考素材未通过授权与审核",
    retryable: false,
    status: 409,
  };
  fail(failure.code, failure.message, failure.status, failure.retryable);
}

/**
 * Resolves only channel-scoped, Active provider assets. The general admission
 * decision deliberately runs first so a signed administrator rejection always
 * wins, even if a stale provider binding is still Active.
 */
export async function resolvePortraitProviderReferencesForChannel(input: {
  database?: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: string;
  assetVersionIds: string[];
  providerChannelId: string | null | undefined;
  providerModel?: string | null;
  /** Only new task admission may enqueue preparation, before billing or dispatch. */
  prepareMissingBindings?: boolean;
  now?: Date;
  requirePortraitRegistration?: boolean;
}): Promise<PortraitProviderReferenceResolution> {
  const database = input.database ?? db;
  const workspaceId = token(input.workspaceId);
  const projectId = token(input.projectId);
  const assetVersionIds = Array.from(new Set(input.assetVersionIds.map(token)));
  const providerChannelId = token(input.providerChannelId);
  if (
    !validOpaqueId(workspaceId)
    || !validOpaqueId(projectId)
    || assetVersionIds.some((id) => !validOpaqueId(id))
  ) fail("video_policy_scope_invalid", "人像资产绑定缺少工作区、项目或素材版本", 409);
  if (!(await portraitAdmissionSchemaAvailable(database))) {
    return Object.freeze({ schemaAvailable: false, bindings: Object.freeze([]) });
  }

  const policy = await resolveVideoAssetPolicyDecisions({
    database,
    workspaceId,
    projectId,
    assetVersionIds,
    now: input.now,
    // Registration readiness belongs to the channel-specific queue below.
    // Checking it here would return before missing registrations can be queued.
    requirePortraitRegistration: false,
  });
  let rows = await loadPortraitPolicyRows({
    database,
    workspaceId,
    projectId,
    assetVersionIds,
  });
  const rejected = policy.decisions.find((decision) => decision.verdict !== "allowed");
  if (rejected) {
    const row = rows.get(rejected.assetVersionId);
    // Explain a definite media failure on this route before the generic pending
    // decision. Other policy decisions and other channel failures stay untouched.
    const mediaFailure = rejected.verdict === "portrait_provider_pending"
      && token(row?.providerSyncState) === "failed"
      && token(row?.preferredProviderChannelId) === providerChannelId
      ? portraitRegistrationFailureMessage(row?.safeErrorCode) : null;
    if (mediaFailure) fail("portrait_provider_media_invalid", mediaFailure, 422, false);
    throwPortraitPolicyDecision(rejected);
  }
  if (input.prepareMissingBindings && input.requirePortraitRegistration && providerChannelId && input.providerModel) {
    const { registerPortraitAsset } = await import("@/lib/portraitAssetRegistration");
    const owner = await database("o_project").where({ id: Number(projectId), workspaceId }).first("userId");
    let pendingError: unknown;
    for (const assetVersionId of assetVersionIds) {
      const row = rows.get(assetVersionId);
      if (!row || token(row.mediaType) === "audio"
        || (token(row.subjectKind) === "ordinary" && !isUnconfirmedVideoNoFace(row))) continue;
      try {
        await registerPortraitAsset({ database, workspaceId, projectId: Number(projectId),
          assetVersionId: Number(assetVersionId), actorUserId: Number(owner?.userId),
          model: input.providerModel, channelId: providerChannelId, now: input.now?.getTime() });
      } catch (error) {
        const code = String((error as { code?: string })?.code || "");
        if (["portrait_source_digest_pending", "portrait_source_digest_missing"].includes(code)) {
          pendingError = error;
          continue;
        }
        throw error;
      }
    }
    if (pendingError) throw pendingError;
    rows = await loadPortraitPolicyRows({ database, workspaceId, projectId, assetVersionIds });
  }
  const portraits = assetVersionIds.flatMap((assetVersionId) => {
    const row = rows.get(assetVersionId);
    if (!row || !token(row.admissionId)) return [];
    return (["real_person", "virtual_person", "trusted_output", "detected_person"].includes(token(row.subjectKind))
      || (input.requirePortraitRegistration && token(row.mediaType) !== "audio"
        && (token(row.subjectKind) !== "ordinary" || isUnconfirmedVideoNoFace(row))))
      ? [{ assetVersionId, row }]
      : [];
  });
  if (!portraits.length) {
    return Object.freeze({ schemaAvailable: true, bindings: Object.freeze([]) });
  }
  const requireBinding = input.requirePortraitRegistration === true;
  if (!providerChannelId) {
    if (!requireBinding) return Object.freeze({ schemaAvailable: true, bindings: Object.freeze([]) });
    fail(
      "portrait_provider_binding_pending",
      "当前生成任务尚未选定可用的人像资产通道，请稍后重试",
      409,
      true,
    );
  }

  const channel = await database("o_provider_channel")
    .where({
      id: providerChannelId,
      disabled: 0,
    })
    .whereIn("endpointType", ["video_generation", "image_generation"])
    .where((builder) => builder
      .where((platform) => platform.where("scope", "platform").whereNull("workspaceId"))
      .orWhere({ scope: "workspace", workspaceId }))
    .select("id", "provider", "endpointType", "configJson")
    .first();
  // Portrait identity, rights and asset scope were checked above. AutoDL's
  // documented input is an ordinary media URL; an Ark asset:// registration
  // cannot be sent to another provider. Preserve that URL and reuse the
  // approved platform evidence without starting another Ark registration.
  if (channel?.provider === "autodl" && channel.endpointType === "video_generation") {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(String(channel.configJson || "{}")); } catch { /* invalid configuration stays closed */ }
    // Accept the previous persisted workflow during the coordinated config rollout.
    if (config?.workflow === AUTODL_H3_WORKFLOW || config?.workflow === AUTODL_H3_LEGACY_WORKFLOW) {
      return Object.freeze({ schemaAvailable: true, bindings: Object.freeze([]) });
    }
  }
  if (!channel || channel.provider !== "volcano") {
    if (!requireBinding) return Object.freeze({ schemaAvailable: true, bindings: Object.freeze([]) });
    fail(
      "portrait_provider_channel_unsupported",
      "所选模型通道暂不支持受信人像资产，请更换模型或稍后重试",
      409,
      true,
    );
  }
  // Image adapters must explicitly attest the `asset://` wire contract and
  // remain bound to the same enabled portrait credential/account generation.
  // Existing video-generation behavior remains unchanged.
  if (channel.endpointType === "image_generation" && !requireBinding) {
    return Object.freeze({ schemaAvailable: true, bindings: Object.freeze([]) });
  }
  const bytePlus = input.providerModel === "dreamina-seedance-2-5-260628";
  const requiredChannelFingerprint = bytePlus && channel.endpointType === "video_generation"
    ? videoPortraitChannelFingerprint(channel)
    : imagePortraitChannelFingerprint(channel);
  if (bytePlus && channel.endpointType === "video_generation" && !requiredChannelFingerprint) {
    if (!requireBinding) return Object.freeze({ schemaAvailable: true, bindings: Object.freeze([]) });
    fail("portrait_provider_account_binding_missing", "当前视频通道缺少可校验的人像资产账号绑定", 409, false);
  }

  const exactRows = await database(`${PORTRAIT_PROVIDER_ASSET_TABLE} as providerAsset`)
    .innerJoin(`${PORTRAIT_ADMISSION_TABLE} as admission`, "admission.id", "providerAsset.admissionId")
    .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "admission.identityId")
    .leftJoin(`${PORTRAIT_CONSENT_TABLE} as consent`, "consent.id", "admission.currentConsentId")
    .innerJoin(`${PORTRAIT_PROVIDER_GROUP_TABLE} as providerGroup`, "providerGroup.id", "providerAsset.groupBindingId")
    .where({
      "admission.workspaceId": workspaceId,
      "providerAsset.workspaceId": workspaceId,
      "providerAsset.channelId": providerChannelId,
      "providerGroup.workspaceId": workspaceId,
      "providerGroup.channelId": providerChannelId,
    })
    .whereRaw(
      `CAST(?? AS TEXT) IN (${portraits.map(() => "?").join(", ")})`,
      ["admission.assetVersionId", ...portraits.map(({ assetVersionId }) => assetVersionId)],
    )
    .select({
      admissionId: "admission.id",
      assetVersionId: "admission.assetVersionId",
      subjectKind: "admission.subjectKind",
      complianceState: "admission.complianceState",
      declarationState: "admission.declarationState",
      faceScanState: "admission.faceScanState",
      moderationState: "admission.moderationState",
      moderationReasonCode: "admission.moderationReasonCode",
      safeErrorCode: "admission.safeErrorCode",
      providerSyncState: "admission.providerSyncState",
      admissionSourceSha256: "admission.sourceSha256",
      identityId: "identity.id",
      identityKind: "identity.kind",
      identityState: "identity.state",
      identityActiveConsentId: "identity.activeConsentId",
      consentId: "consent.id",
      consentIdentityId: "consent.identityId",
      consentStatus: "consent.status",
      consentExpiresAt: "consent.expiresAt",
      bindingId: "providerAsset.id",
      bindingAdmissionId: "providerAsset.admissionId",
      bindingGroupId: "providerAsset.groupBindingId",
      bindingChannelId: "providerAsset.channelId",
      bindingState: "providerAsset.state",
      bindingErrorCode: "providerAsset.safeErrorCode",
      groupErrorCode: "providerGroup.safeErrorCode",
      bindingSourceSha256: "providerAsset.sourceSha256",
      providerAssetId: "providerAsset.providerAssetId",
      providerAssetUri: "providerAsset.providerAssetUri",
      groupId: "providerGroup.id",
      groupIdentityId: "providerGroup.identityId",
      groupProvider: "providerGroup.provider",
      groupChannelId: "providerGroup.channelId",
      groupType: "providerGroup.groupType",
      groupState: "providerGroup.state",
      groupProviderAccountFingerprint: "providerGroup.providerAccountFingerprint",
    }) as Array<Record<string, unknown>>;
  const byVersion = new Map<string, Array<Record<string, unknown>>>();
  for (const stored of exactRows) {
    const row = withPortraitReviewScope(stored);
    const key = String(row.assetVersionId);
    byVersion.set(key, [...(byVersion.get(key) || []), row]);
  }

  const now = (input.now ?? new Date()).getTime();
  const bindings: PortraitProviderReferenceBinding[] = [];
  const missing: string[] = [];
  for (const { assetVersionId, row } of portraits) {
    // Reclassification keeps revoked registrations as audit history. Only
    // bindings for the current identity, source and selected provider account
    // can either authorize this request or carry an authoritative restriction.
    const candidates = (byVersion.get(assetVersionId) || []).filter(candidate =>
      token(candidate.admissionId) === token(row.admissionId)
      && token(candidate.groupIdentityId) === token(row.identityId)
      && validSha256(row.sourceSha256)
      && token(candidate.bindingSourceSha256).toLowerCase() === token(row.sourceSha256).toLowerCase()
      && (requiredChannelFingerprint === null
        || token(candidate.groupProviderAccountFingerprint) === requiredChannelFingerprint));
    if (candidates.some(candidate => token(candidate.bindingState) === "revoked"
      || token(candidate.groupState) === "revoked"
      || isPortraitProviderRefusal(candidate.bindingErrorCode)
      || isPortraitProviderRefusal(candidate.groupErrorCode))) {
      fail("portrait_provider_binding_failed", "生成平台已拒绝或撤销此人物素材，请查看素材详情并更换素材或申请复核", 409, false);
    }
    const subjectKind = token(row.subjectKind);
    const automatic = isAutomaticPortrait(row);
    const legacyReal = subjectKind === "real_person";
    const expectedIdentityKind = automatic
      ? "detected_person"
      : legacyReal ? "real_person" : "virtual_person";
    const expectedGroupType = legacyReal ? "LivenessFace" : "AIGC";
    // Also accept virtual/AIGC binding for real_person rows (new default).
    const altIdentityKind = legacyReal ? "virtual_person" : expectedIdentityKind;
    const altGroupType = legacyReal ? "AIGC" : expectedGroupType;
    const valid = candidates.filter((candidate) => {
      const providerAssetId = token(candidate.providerAssetId);
      const expiresAt = candidate.consentExpiresAt == null
        ? null
        : Number(candidate.consentExpiresAt);
      const identityKind = token(candidate.identityKind);
      const groupType = token(candidate.groupType);
      const identityOk = identityKind === expectedIdentityKind || identityKind === altIdentityKind;
      const groupOk = groupType === expectedGroupType || groupType === altGroupType;
      return token(candidate.admissionId) === token(row.admissionId)
        && token(candidate.bindingAdmissionId) === token(row.admissionId)
        && token(candidate.bindingGroupId) === token(candidate.groupId)
        && token(candidate.bindingChannelId) === providerChannelId
        && token(candidate.bindingState) === "active"
        && token(candidate.groupChannelId) === providerChannelId
        && token(candidate.groupIdentityId) === token(candidate.identityId)
        && token(candidate.groupProvider) === "volcano"
        && groupOk
        && token(candidate.groupState) === "active"
        && (
          requiredChannelFingerprint === null
          || token(candidate.groupProviderAccountFingerprint)
            === requiredChannelFingerprint
        )
        && identityOk
        && token(candidate.identityState) === "active"
        && (automatic
          ? !token(candidate.consentId) && !token(candidate.identityActiveConsentId)
          : (token(candidate.identityActiveConsentId) === token(candidate.consentId)
            && token(candidate.consentIdentityId) === token(candidate.identityId)
            && token(candidate.consentStatus) === "active"
            && (expiresAt === null || (Number.isSafeInteger(expiresAt) && expiresAt > now))))
        && token(candidate.complianceState) === "allowed"
        && token(candidate.providerSyncState) === "active"
        && validSha256(candidate.admissionSourceSha256)
        && token(candidate.bindingSourceSha256).toLowerCase()
          === token(candidate.admissionSourceSha256).toLowerCase()
        && validProviderAssetUri(providerAssetId, token(candidate.providerAssetUri));
    });
    if (valid.length !== 1) {
      if (requireBinding) {
        const failed = candidates.find(candidate => token(candidate.bindingState) === "failed"
          && token(candidate.admissionId) === token(row.admissionId)
          && validSha256(candidate.admissionSourceSha256)
          && token(candidate.bindingSourceSha256).toLowerCase() === token(candidate.admissionSourceSha256).toLowerCase()
          && (requiredChannelFingerprint === null
            || token(candidate.groupProviderAccountFingerprint) === requiredChannelFingerprint)
          && portraitRegistrationFailureMessage(candidate.bindingErrorCode));
        const mediaFailure = portraitRegistrationFailureMessage(failed?.bindingErrorCode);
        if (mediaFailure) fail("portrait_provider_media_invalid", mediaFailure, 422, false);
      }
      missing.push(assetVersionId);
      continue;
    }
    const candidate = valid[0];
    bindings.push(Object.freeze({
      admissionId: token(candidate.admissionId),
      assetVersionId,
      bindingId: token(candidate.bindingId),
      channelId: providerChannelId,
      providerAssetId: token(candidate.providerAssetId),
      providerAssetUri: token(candidate.providerAssetUri),
    }));
  }
  if (missing.length && requireBinding) {
    if (input.prepareMissingBindings) {
      // Queue every missing reference together. The runtime rechecks ownership,
      // moderation and consent under its admission lock and preserves unknown
      // provider outcomes. This does not submit a generation or restart ImageX.
      for (const assetVersionId of missing) {
        try {
          await ensurePortraitProviderBindingQueued({
            database,
            workspaceId,
            projectId: Number(projectId),
            assetVersionId: Number(assetVersionId),
            channelId: providerChannelId,
            now,
            retryFailed: false,
          });
        } catch (error) {
          if (error instanceof PortraitProviderRuntimeError) {
            fail(error.code, error.message, error.status, false);
          }
          throw error;
        }
      }
    }
    fail(
      "portrait_provider_binding_pending",
      "参考人物素材正在准备，完成后可继续生成，请稍后重试",
      409,
      true,
    );
  }
  return Object.freeze({
    schemaAvailable: true,
    bindings: Object.freeze(bindings),
  });
}

/** Replaces only the canonical inputs whose exact Active bindings were read above. */
export function bindPortraitProviderReferencesToPayload(input: {
  canonicalRequest: VideoGenerationRequest | null;
  portraitBindings: readonly PortraitProviderReferenceBinding[];
  requestPayload: Record<string, unknown>;
}): PortraitProviderBoundPayload {
  // A final inherits its inputs at the provider. Revalidate rights separately,
  // but never replace draft_task with image/video references.
  if (input.canonicalRequest?.renderMode === "finalize") {
    return { allowedProviderAssetUris: new Set<string>(), requestPayload: input.requestPayload };
  }
  const allowedProviderAssetUris = new Set(
    input.portraitBindings.map((binding) => binding.providerAssetUri),
  );
  if (!input.portraitBindings.length) {
    return { allowedProviderAssetUris, requestPayload: input.requestPayload };
  }
  if (!input.canonicalRequest) {
    fail(
      "portrait_provider_binding_canonical_request_required",
      "人像资产绑定缺少规范化视频请求",
      409,
    );
  }
  const bindingByVersion = new Map(
    input.portraitBindings.map((binding) => [binding.assetVersionId, binding]),
  );
  const content = Array.isArray(input.requestPayload.content)
    ? input.requestPayload.content
    : [];
  let referenceIndex = 0;
  const boundContent = content.map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return rawItem;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "text") return item;
    const canonicalInput = input.canonicalRequest!.inputs[referenceIndex];
    referenceIndex += 1;
    if (!canonicalInput) {
      fail(
        "portrait_provider_binding_input_mismatch",
        "人像资产绑定与规范化参考素材不一致",
        409,
      );
    }
    const binding = bindingByVersion.get(canonicalInput.assetVersionId);
    if (!binding) return item;
    if (canonicalInput.trim) {
      fail(
        "portrait_reference_trim_requires_derived_asset",
        "这段人物视频需要先另存所选片段，再作为新素材引用",
        422,
      );
    }
    if (item.type === "image_url") {
      return { ...item, image_url: { url: binding.providerAssetUri } };
    }
    if (item.type === "video_url") {
      return { ...item, video_url: { url: binding.providerAssetUri } };
    }
    fail(
      "portrait_provider_binding_media_mismatch",
      "人像资产绑定与参考素材类型不一致",
      409,
    );
  });
  if (referenceIndex !== input.canonicalRequest.inputs.length) {
    fail(
      "portrait_provider_binding_input_mismatch",
      "人像资产绑定与规范化参考素材数量不一致",
      409,
    );
  }
  return {
    allowedProviderAssetUris,
    requestPayload: { ...input.requestPayload, content: boundContent },
  };
}
