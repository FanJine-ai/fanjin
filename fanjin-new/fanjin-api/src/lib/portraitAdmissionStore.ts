import { portraitRegistrationFailureMessage } from "@/lib/portraitRegistrationFailure";
import { canDeclareUpstreamRejectedPortrait, hasUpstreamRealPersonRejection, isDeclaredPortrait, UPSTREAM_REAL_PERSON_REJECTION } from "@/lib/portraitUpstreamRejection";
import { PORTRAIT_REVIEW_SCOPE_VERSION, withPortraitReviewScope } from "@/lib/portraitReviewScope";
import { resolveProjectAssetVersion } from "@/lib/projectAssetVersion";
import { isAutomaticPortrait } from "@/lib/portraitAutomaticRegistration";
import { isUnconfirmedVideoNoFace } from "@/lib/portraitVideoFaceEvidence";
import { hasPortraitSubmissionRestriction, isPortraitProviderRefusal, PORTRAIT_PROVIDER_REFUSAL_MESSAGE } from "@/lib/portraitSubmissionPolicy";
import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_IDENTITY_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";
import { OBJECT_WRITE_INTENT_TABLE } from "@/lib/migrations/objectWriteIntent";
import { canRecoverPortraitFace, readPortraitEvidence } from "@/lib/portraitFailure";

export const PORTRAIT_ADMISSION_DTO_VERSION =
  "portrait-admission/v2" as const;
export const PORTRAIT_DECLARATION_VERSION =
  "portrait-declaration/2026-08-17-user-classification-v2" as const;

export const PORTRAIT_DECLARATION_TEXT =
  "我确认已如实选择素材中的人像类型，并已取得上传、处理和生成所需的合法权利。因虚假分类、无权使用或生成内容造成的侵权及其他责任由提交者承担；平台仍可依据法律法规、平台规则及上游要求限制或停止处理。" as const;

export type PortraitDeclarationChoice =
  | "ordinary_no_person"
  | "real_person_with_rights"
  | "fully_virtual_person"
  | "trusted_volcano_output"
  | "uncertain";

export type PortraitUserClassification =
  | "real_person_with_rights"
  | "fully_virtual_person";

export type PortraitAdmissionDto = {
  version: typeof PORTRAIT_ADMISSION_DTO_VERSION;
  id: string;
  workspaceId: string;
  projectId: number;
  assetId: number;
  assetVersionId: number;
  mediaType: "image" | "video";
  faceScan: {
    state: string;
    coverage: "none" | "full_image" | "sampled_video" | "full_video_manual";
    faceCount: number | null;
    detector: string | null;
    detectorVersion: string | null;
    confidence: number | null;
    retryAllowed?: boolean;
  };
  faceSignal: {
    result: "present" | "absent" | "inconclusive";
  };
  classificationRequired: boolean;
  userClassification: PortraitUserClassification | null;
  disclaimer: {
    termsVersion: typeof PORTRAIT_DECLARATION_VERSION;
    text: typeof PORTRAIT_DECLARATION_TEXT;
    accepted: boolean;
    acceptedAt: number | null;
  };
  manualReview: {
    state: "not_required" | "pending" | "in_review" | "completed" | "superseded";
    decision: "no_face" | "single_face" | "multiple_faces" | "uncertain" | null;
  };
  subjectKind: string;
  declarationState: string;
  moderation: {
    state: string;
    policyVersion: string | null;
    reasonCode: string | null;
    updatedAt: number | null;
  };
  complianceState: string;
  providerSyncState: string;
  identity: null | {
    id: string;
    kind: string;
    label: string;
    state: string;
  };
  consent: null | {
    id: string;
    type: string;
    status: string;
    grantedAt: number;
    expiresAt: number | null;
    termsVersion: string;
  };
  blocking: boolean;
  nextAction:
    | "wait_for_scan"
    | "wait_for_admin_review"
    | "confirm_source"
    | "authorize_real_person"
    | "wait_for_moderation"
    | "wait_for_provider"
    | "retry"
    | "replace_or_split_media"
    | "ready";
  error: null | { code: string; message: string };
  revision: number;
  createdAt: number;
  updatedAt: number;
};

type AdmissionRow = Record<string, any>;

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function cleanToken(value: unknown, label: string, maximum = 256): string {
  const parsed = String(value ?? "").trim();
  if (!parsed || parsed.length > maximum || /[\u0000-\u001f\u007f]/u.test(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function optionalHash(value: unknown): string | null {
  const parsed = String(value ?? "").trim().toLowerCase();
  if (!parsed) return null;
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error("sourceSha256 is invalid");
  return parsed;
}

function validHash(value: unknown): boolean {
  return /^[a-f0-9]{64}$/u.test(String(value ?? "").trim().toLowerCase());
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hashToken(value: unknown): string | null {
  const parsed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(parsed) ? parsed : null;
}

/**
 * Recover the immutable byte digest only from Fanjin's committed object-write
 * evidence. A media metadata hash alone is not authority: the storage key,
 * media row and terminal write intent must all describe the same asset.
 */
export async function resolveDurablePortraitSourceSha256(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetId: number;
  assetVersionId: number;
  storageKey: string | null;
}): Promise<string | null> {
  const storageKey = String(input.storageKey || "").trim();
  if (!storageKey) return null;
  if (!(await input.database.schema.hasTable("o_media_asset"))
    || !(await input.database.schema.hasTable(OBJECT_WRITE_INTENT_TABLE))) {
    return null;
  }
  const mediaRows = await input.database("o_media_asset")
    .where({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      storageKey,
    })
    .select("id", "metadata")
    .limit(3);
  const media = mediaRows.filter((row: Record<string, unknown>) => {
    const metadata = jsonRecord(row.metadata);
    return metadata
      && Number(metadata.assetId) === input.assetId
      && Number(metadata.assetVersionId) === input.assetVersionId;
  });
  if (media.length !== 1) return null;
  const intentRows = await input.database(OBJECT_WRITE_INTENT_TABLE)
    .where({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      objectKey: storageKey,
      status: "committed",
    })
    .select("expectedSha256", "referenceJson")
    .limit(3);
  const exact = intentRows.filter((row: Record<string, unknown>) => {
    const reference = jsonRecord(row.referenceJson);
    return reference
      && reference.table === "o_media_asset"
      && String(reference.rowId || "") === String(media[0].id)
      && String(reference.workspaceId || "") === input.workspaceId
      && Number(reference.projectId) === input.projectId
      && String(reference.storageKey || "") === storageKey
      && hashToken(row.expectedSha256);
  });
  if (exact.length !== 1) return null;
  const expectedSha256 = hashToken(exact[0].expectedSha256);
  if (!expectedSha256) return null;
  const metadata = jsonRecord(media[0].metadata) || {};
  const mediaProbe = jsonRecord(metadata.mediaProbe) || {};
  const declaredHash = hashToken(metadata.contentSha256)
    ?? hashToken(mediaProbe.contentSha256);
  return declaredHash && declaredHash !== expectedSha256
    ? null
    : expectedSha256;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function portraitDeclarationEvidenceHash(input: {
  admissionId: string;
  assetVersionId: number;
  actorUserId: number;
  choice: PortraitDeclarationChoice;
  termsVersion?: string;
  sourceSha256?: string | null;
  trustedOutput?: Record<string, unknown> | null;
}): string {
  const canonical = stableJson({
    admissionId: input.admissionId,
    actorUserId: input.actorUserId,
    assetVersionId: input.assetVersionId,
    choice: input.choice,
    sourceSha256: input.sourceSha256 ?? null,
    termsVersion: input.termsVersion || PORTRAIT_DECLARATION_VERSION,
    trustedOutput: input.trustedOutput ?? null,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export async function createPortraitAdmissionForUpload(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetId: number;
  assetVersionId: number;
  mediaType: string;
  sourceSha256?: string | null;
  now?: number;
}): Promise<string | null> {
  const rawMediaType = String(input.mediaType || "").trim().toLowerCase();
  const mediaType = rawMediaType === "clip" ? "video" : rawMediaType;
  if (mediaType !== "image" && mediaType !== "video") return null;
  const workspaceId = cleanToken(input.workspaceId, "workspaceId");
  const projectId = positiveInteger(input.projectId, "projectId");
  const assetId = positiveInteger(input.assetId, "assetId");
  const assetVersionId = positiveInteger(input.assetVersionId, "assetVersionId");
  const sourceSha256 = optionalHash(input.sourceSha256);
  const timestamp = input.now ?? Date.now();
  const id = uuid();
  const sourceRecoveryReady = sourceSha256 !== null;
  await input.database(PORTRAIT_ADMISSION_TABLE).insert({
    id,
    workspaceId,
    projectId,
    assetId,
    assetVersionId,
    mediaType,
    sourceSha256,
    sourceRecoveryState: sourceRecoveryReady ? "ready" : "pending",
    sourceRecoveryAttempts: 0,
    sourceRecoveryNextAttemptAt: timestamp,
    sourceRecoveryLeaseOwner: null,
    sourceRecoveryLeaseExpiresAt: null,
    sourceRecoveryObjectIdentityJson: sourceRecoveryReady
      ? stableJson({
          authority: "fanjin_committed_upload_evidence",
          sha256: sourceSha256,
          version: "portrait-source-object-identity/v1",
        })
      : null,
    sourceRecoveryFailureCode: null,
    sourceRecoveryFailureMessage: null,
    faceScanState: "queued",
    faceScanCoverage: "none",
    faceCount: null,
    detectorName: null,
    detectorVersion: null,
    detectorConfidence: null,
    detectorEvidenceHash: null,
    detectorEvidenceJson: "{}",
    manualReviewState: "not_required",
    currentManualReviewId: null,
    manualReviewDecision: null,
    manualReviewEvidenceHash: null,
    manualReviewPolicyVersion: null,
    manualReviewedByUserId: null,
    manualReviewedAt: null,
    subjectKind: "pending",
    declarationState: "pending",
    declarationVersion: null,
    declaredByUserId: null,
    declaredAt: null,
    identityId: null,
    currentConsentId: null,
    moderationState: "pending",
    moderationEvidenceHash: null,
    moderationPolicyVersion: null,
    moderationReasonCode: null,
    moderationUpdatedAt: null,
    complianceState: "pending",
    providerSyncState: "not_needed",
    currentProviderAssetBindingId: null,
    preferredProviderChannelId: null,
    safeErrorCode: null,
    safeErrorMessage: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return id;
}

export async function ensurePortraitAdmissionForAsset(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  actorUserId?: number;
  sourceSha256?: string | null;
  now?: number;
}): Promise<string | null> {
  const asset = await resolveProjectAssetVersion(input);
  if (!asset) return null;
  const sourceProjectId = asset.sourceProjectId;
  const existing = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({ workspaceId: input.workspaceId, projectId: sourceProjectId, assetVersionId: input.assetVersionId })
    .select("id").first();
  if (existing?.id) return String(existing.id);
  const sourceSha256 = optionalHash(input.sourceSha256)
    ?? await resolveDurablePortraitSourceSha256({
      database: input.database,
      workspaceId: input.workspaceId,
      projectId: sourceProjectId,
      assetId: Number(asset.assetId),
      assetVersionId: input.assetVersionId,
      storageKey: asset.storageKey == null ? null : String(asset.storageKey),
    });
  try {
    return await createPortraitAdmissionForUpload({
      database: input.database,
      workspaceId: input.workspaceId,
      projectId: sourceProjectId,
      assetId: Number(asset.assetId),
      assetVersionId: input.assetVersionId,
      mediaType: String(asset.type || ""),
      sourceSha256,
      now: input.now,
    });
  } catch (error) {
    const raced = await input.database(PORTRAIT_ADMISSION_TABLE)
      .where({ workspaceId: input.workspaceId, projectId: sourceProjectId, assetVersionId: input.assetVersionId })
      .select("id")
      .first();
    if (raced?.id) return String(raced.id);
    throw error;
  }
}

/**
 * After an upstream identity / single-person rejection, reopen the one-shot
 * classification on video references that had been default-passed.
 */
export async function markPortraitUpstreamIdentityRejected(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  assetVersionIds: readonly number[];
  reason?: "identity" | "real_person";
  /** For repair jobs, do not overwrite an attestation submitted after refusal. */
  rejectedAt?: number;
  now?: number;
}): Promise<number> {
  const ids = [...new Set(input.assetVersionIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return 0;
  const now = input.now ?? Date.now();
  const realPerson = input.reason === "real_person";
  const code = realPerson ? UPSTREAM_REAL_PERSON_REJECTION : "PORTRAIT_UPSTREAM_IDENTITY_REJECTED";
  return input.database(PORTRAIT_ADMISSION_TABLE)
    .where({ workspaceId: input.workspaceId })
    .whereIn("mediaType", realPerson ? ["image", "video"] : ["video"])
    .whereIn("assetVersionId", ids)
    .modify(query => { if (input.rejectedAt != null) query.where(q => q.whereNull("declaredAt").orWhere("declaredAt", "<=", input.rejectedAt!)); })
    .modify(query => { if (!realPerson) query.whereNot("declarationState", "confirmed"); })
    .whereNotIn("complianceState", ["denied", "revoked", "expired"])
    .where(query => query.whereNull("safeErrorCode").orWhereNot("safeErrorCode", code))
    .update({
      safeErrorCode: code,
      safeErrorMessage: realPerson
        ? "火山认为该参考素材可能含真人。若为不对应现实人物的 AI 虚构角色，请确认来源声明后提交虚拟人像库审核；真人素材需授权。声明不保证通过，审核通过后才可重新生成。"
        : "上游人物一致性未通过，请确认素材类型后重试",
      revision: input.database.raw('"revision" + 1'),
      updatedAt: now,
    });
}

export function derivePortraitAdmissionNextAction(
  row: AdmissionRow,
  now = Date.now(),
): PortraitAdmissionDto["nextAction"] {
  row = withPortraitReviewScope(row);
  if (hasUpstreamRealPersonRejection(row)) return canDeclareUpstreamRejectedPortrait(row)
    ? "confirm_source" : "replace_or_split_media";
  if (isPortraitProviderRefusal(row.safeErrorCode)) return "replace_or_split_media";
  if (row.providerSyncState === "failed" && portraitRegistrationFailureMessage(row.safeErrorCode)) return "replace_or_split_media";
  if (row.faceScanState === "queued" || row.faceScanState === "scanning") return "wait_for_scan";
  if (isAutomaticPortrait(row)) {
    if (["denied", "revoked", "expired"].includes(String(row.complianceState))) return "replace_or_split_media";
    // Multi-face boards (6-grid storyboards) are composition references, not
    // identity portraits. A moderation *service* failure must not strand them.
    if (row.mediaType === "image" && row.faceScanState === "multiple_faces") {
      return "ready";
    }
    if (["failed", "stale"].includes(String(row.providerSyncState))) return "retry";
    return row.providerSyncState === "active" && row.providerAssetState === "active"
      && String(row.providerAssetUri || "").startsWith("asset://") ? "ready" : "wait_for_provider";
  }
  if (
    row.mediaType === "image"
    && (row.faceScanState === "multiple_faces" || Number(row.faceCount || 0) >= 2)
    && !isDeclaredPortrait(row)
  ) {
    // Multi-face boards (storyboards / 6-grid) are composition references, not
    // identity portraits. Let them through after portrait-specific restrictions are checked.
    if (
      ["denied", "revoked", "expired"].includes(String(row.complianceState))
    ) return "replace_or_split_media";
    if (["failed", "stale"].includes(String(row.providerSyncState))) {
      return "retry";
    }
    return "ready";
  }
  // A positive full-image no-face result completes the portrait-specific
  // admission. Ordinary content safety remains enforced by the generation
  // provider, without duplicating its content review here. Do not
  // make a missing/unavailable portrait moderation service strand non-person
  // material in this workflow.
  if (
    row.faceScanState === "no_face"
    && !isDeclaredPortrait(row)
    && row.mediaType === "image"
    && row.faceScanCoverage === "full_image"
    && row.faceCount != null
    && Number(row.faceCount) === 0
    && validHash(row.detectorEvidenceHash)
  ) {
    if (
      ["denied", "revoked", "expired"].includes(String(row.complianceState))
    ) {
      return "replace_or_split_media";
    }
    if (
      row.subjectKind === "ordinary"
      && row.declarationState === "not_required"
      && row.providerSyncState === "not_needed"
    ) return "ready";
    return "retry";
  }
  // Removing the content audit must not turn incomplete face evidence into
  // an affirmative no-person result.
  if (row.faceScanState === "no_face" && !isDeclaredPortrait(row) && !isUnconfirmedVideoNoFace(row)) return "retry";
  // An inconclusive video scan is not evidence that registration is unnecessary.
  if (row.faceScanState === "failed" || row.faceScanState === "uncertain" || isUnconfirmedVideoNoFace(row)) {
    // Legacy rows were marked ordinary/not_required after an inconclusive
    // scan. That must not auto-pass: the detector never saw zero faces.
    if (row.declarationState !== "confirmed") {
      return "confirm_source";
    }
    if (
      row.complianceState === "denied"
      || row.complianceState === "revoked"
      || row.complianceState === "expired"
    ) return "replace_or_split_media";
    if (row.subjectKind === "ordinary") {
      return "ready";
    }
    // Confirmed virtual/real/trusted: continue to identity + provider checks.
  }
  if (
    row.subjectKind === "ambiguous"
    || row.complianceState === "denied"
    || row.complianceState === "revoked"
    || row.complianceState === "expired"
  ) return "replace_or_split_media";
  if (row.safeErrorCode && ["failed", "stale"].includes(String(row.providerSyncState))) return "retry";
  if (row.declarationState !== "confirmed" && row.declarationState !== "not_required") {
    return "confirm_source";
  }
  if (row.complianceState === "pending") return "retry";
  if (["real_person", "virtual_person", "trusted_output"].includes(String(row.subjectKind))) {
    if (String(row.consentStatus || "") !== "active") return "replace_or_split_media";
    if (row.expiresAt != null && Number(row.expiresAt) <= now) return "replace_or_split_media";
    if (String(row.identityState || "") !== "active") {
      if (row.subjectKind === "real_person" && ["pending", "authorizing"].includes(String(row.identityState))) return "authorize_real_person";
      return "retry";
    }
    if (
      row.providerSyncState !== "active"
      || row.providerAssetState !== "active"
      || !String(row.providerAssetUri || "").startsWith("asset://")
    ) return "wait_for_provider";
  }
  return row.complianceState === "allowed" || row.complianceState === "not_required"
    ? "ready"
    : "retry";
}

export async function readPortraitAdmission(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  actorUserId?: number;
}): Promise<PortraitAdmissionDto | null> {
  const asset = await resolveProjectAssetVersion(input);
  if (!asset) return null;
  const storedRow = await input.database(`${PORTRAIT_ADMISSION_TABLE} as admission`)
    .leftJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "admission.identityId")
    .leftJoin(`${PORTRAIT_CONSENT_TABLE} as consent`, "consent.id", "admission.currentConsentId")
    .leftJoin(`${PORTRAIT_PROVIDER_ASSET_TABLE} as providerAsset`, "providerAsset.id", "admission.currentProviderAssetBindingId")
    .where({
      "admission.workspaceId": input.workspaceId,
      "admission.projectId": asset.sourceProjectId,
      "admission.assetVersionId": input.assetVersionId,
    })
    .select(
      "admission.*",
      "identity.kind as identityKind",
      "identity.label as identityLabel",
      "identity.state as identityState",
      "consent.consentType",
      "consent.status as consentStatus",
      "consent.grantedAt",
      "consent.expiresAt",
      "consent.termsVersion",
      "providerAsset.state as providerAssetState",
      "providerAsset.providerAssetUri",
    )
    .first() as AdmissionRow | undefined;
  if (!storedRow) return null;
  const row = withPortraitReviewScope(storedRow);
  const action = derivePortraitAdmissionNextAction(row);
  const detectorDiagnostic = row.faceScanState === "failed" ? readPortraitEvidence(row)?.diagnostic : null;
  const detectorError = detectorDiagnostic?.code === "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE"
    && detectorDiagnostic.dispatchState === "not_dispatched"
    ? { code: "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE", message: "视频人像检测的存储校验未就绪，请联系管理员；尚未发送人像检测请求，不代表素材审核未通过。" }
    : null;
  return {
    version: PORTRAIT_ADMISSION_DTO_VERSION,
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    assetId: Number(row.assetId),
    assetVersionId: Number(row.assetVersionId),
    mediaType: row.mediaType,
    faceScan: {
      state: String(row.faceScanState),
      coverage: ["full_image", "sampled_video", "full_video_manual"].includes(String(row.faceScanCoverage))
        ? row.faceScanCoverage
        : "none",
      faceCount: row.faceCount == null ? null : Number(row.faceCount),
      detector: row.detectorName == null ? null : String(row.detectorName),
      detectorVersion: row.detectorVersion == null ? null : String(row.detectorVersion),
      confidence: row.detectorConfidence == null ? null : Number(row.detectorConfidence),
      retryAllowed: canRecoverPortraitFace(row),
    },
    faceSignal: {
      result: (["single_face", "multiple_faces"].includes(String(row.faceScanState))
        || Number(row.faceCount || 0) >= 1)
        ? "present"
        : row.faceScanState === "no_face" && !isUnconfirmedVideoNoFace(row) ? "absent" : "inconclusive",
    },
    classificationRequired: action === "confirm_source",
    userClassification: row.subjectKind === "real_person"
      ? "real_person_with_rights"
      : row.subjectKind === "virtual_person" || row.subjectKind === "trusted_output"
        ? "fully_virtual_person"
        : null,
    disclaimer: {
      termsVersion: PORTRAIT_DECLARATION_VERSION,
      text: PORTRAIT_DECLARATION_TEXT,
      accepted: String(row.consentStatus || "") === "active",
      acceptedAt: row.grantedAt == null ? null : Number(row.grantedAt),
    },
    manualReview: {
      state: ["pending", "in_review", "completed", "superseded"].includes(String(row.manualReviewState))
        ? row.manualReviewState
        : "not_required",
      decision: ["no_face", "single_face", "multiple_faces", "uncertain"].includes(String(row.manualReviewDecision))
        ? row.manualReviewDecision
        : null,
    },
    subjectKind: String(row.subjectKind),
    declarationState: String(row.declarationState),
    moderation: {
      state: "not_required",
      policyVersion: PORTRAIT_REVIEW_SCOPE_VERSION,
      reasonCode: "delegated_to_generation_provider",
      updatedAt: null,
    },
    complianceState: String(row.complianceState),
    providerSyncState: String(row.providerSyncState),
    identity: row.identityId ? {
      id: String(row.identityId),
      kind: String(row.identityKind || ""),
      label: String(row.identityLabel || ""),
      state: String(row.identityState || ""),
    } : null,
    consent: row.currentConsentId ? {
      id: String(row.currentConsentId),
      type: String(row.consentType || ""),
      status: String(row.consentStatus || ""),
      grantedAt: Number(row.grantedAt || 0),
      expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
      termsVersion: String(row.termsVersion || ""),
    } : null,
    blocking: hasPortraitSubmissionRestriction(row),
    nextAction: action,
    error: action === "ready" ? null : row.safeErrorCode ? {
      code: String(row.safeErrorCode),
      message: isPortraitProviderRefusal(row.safeErrorCode)
        ? PORTRAIT_PROVIDER_REFUSAL_MESSAGE
        : portraitRegistrationFailureMessage(row.safeErrorCode) ?? String(row.safeErrorMessage || "素材人像校验未完成，请重试"),
    } : detectorError,
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}
