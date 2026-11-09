import { canDeclareUpstreamRejectedPortrait, hasUpstreamRealPersonRejection } from "@/lib/portraitUpstreamRejection";
import { portraitScopeCompliance } from "@/lib/portraitReviewScope";
import { isUnconfirmedVideoNoFace } from "@/lib/portraitVideoFaceEvidence";
import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_IDENTITY_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
  PORTRAIT_PROVIDER_GROUP_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";
import {
  PORTRAIT_DECLARATION_VERSION,
  type PortraitAdmissionDto,
  type PortraitDeclarationChoice,
  portraitDeclarationEvidenceHash,
  readPortraitAdmission,
} from "@/lib/portraitAdmissionStore";
import { resolveTrustedRelayProviderVideoUrl } from "@/lib/generationReferenceResolver";
import {
  TRUSTED_GENERATED_OUTPUT_MAX_AGE_MS,
  verifyCommittedMediaObjectWriteIntent,
  verifyTrustedGeneratedImageOutput,
} from "@/lib/trustedGeneratedImageOutput";
import {
  resolveVolcanoProviderAccountSnapshot,
  resolveVolcanoProviderChannelAccount,
} from "@/lib/volcanoProviderAccount";

import { PortraitAdmissionWorkflowError } from "@/lib/portraitAdmissionError";
export { PortraitAdmissionWorkflowError } from "@/lib/portraitAdmissionError";
export { retryPortraitAdmissionChecks } from "@/lib/portraitAdmissionRetry";

export type TrustedPortraitOutputEvidence = Readonly<{
  sourceChannelId: string;
  sourceEndpointType: "image_generation" | "video_generation";
  sourceProviderAccountBinding: string;
  sourceSha256: string;
  completedAt: number;
  evidenceHash: string;
  evidenceId: string;
  model: string;
  sourceTaskId: string;
}>;

export type VerifyTrustedPortraitOutput = (input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  sourceTaskId: string | null;
  sourceSha256: string | null;
  now: number;
}) => Promise<TrustedPortraitOutputEvidence>;

function fail(status: number, code: string, message: string): never {
  throw new PortraitAdmissionWorkflowError(status, code, message);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(row[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(
    typeof value === "string" ? value : stableJson(value),
  ).digest("hex");
}

function parseObject(value: unknown): Record<string, unknown> {
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

function cleanLabel(value: unknown, fallback: string): string {
  const label = String(value ?? "").trim() || fallback;
  if ([...label].length > 120 || /[\u0000-\u001f\u007f]/u.test(label)) {
    fail(400, "portrait_label_invalid", "人像名称无效");
  }
  return label;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(400, "portrait_request_invalid", `${name} 无效`);
  }
  return parsed;
}

function safeId(value: unknown, name: string, maximum = 256): string {
  const parsed = String(value ?? "").trim();
  if (!parsed || parsed.length > maximum || /[\u0000-\u001f\u007f\s]/u.test(parsed)) {
    fail(400, "portrait_request_invalid", `${name} 无效`);
  }
  return parsed;
}

function mappingForChoice(choice: PortraitDeclarationChoice): {
  consentType: string | null;
  identityKind: "real_person" | "virtual_person" | null;
  subjectKind: string;
} {
  switch (choice) {
    case "real_person_with_rights":
      return { consentType: "real_person_rights", identityKind: "real_person", subjectKind: "real_person" };
    case "fully_virtual_person":
      return { consentType: "virtual_person_rights", identityKind: "virtual_person", subjectKind: "virtual_person" };
    case "trusted_volcano_output":
      return { consentType: "trusted_output_attestation", identityKind: "virtual_person", subjectKind: "trusted_output" };
    case "ordinary_no_person":
      return { consentType: null, identityKind: null, subjectKind: "ordinary" };
    case "uncertain":
      return { consentType: null, identityKind: null, subjectKind: "ambiguous" };
  }
}

function currentChoice(row: Record<string, unknown>): PortraitDeclarationChoice | null {
  switch (String(row.subjectKind || "")) {
    case "ordinary": return "ordinary_no_person";
    case "real_person": return "real_person_with_rights";
    case "virtual_person": return "fully_virtual_person";
    case "trusted_output": return "trusted_volcano_output";
    case "ambiguous": return "uncertain";
    default: return null;
  }
}

async function lockedAdmission(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
}): Promise<Record<string, any>> {
  const row = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetVersionId: input.assetVersionId,
    })
    .forUpdate()
    .first();
  if (!row) fail(404, "portrait_admission_not_found", "素材人像准入记录不存在");
  return row;
}

function declaredPortraitCompliance(row: Record<string, any>, subjectKind: string): string {
  const restriction = portraitScopeCompliance(row);
  if (["denied", "revoked", "expired"].includes(restriction)) return restriction;
  return subjectKind === "ordinary" ? "not_required" : "allowed";
}

async function lockTrustedPortraitChannelPair(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  sourceChannelId: string;
  sourceEndpointType: "image_generation" | "video_generation";
  sourceProviderAccountBinding: string;
  targetChannelId: string;
}): Promise<
  | Readonly<{ kind: "ready"; targetChannelId: string }>
  | Readonly<{ kind: "target_unavailable" }>
  | Readonly<{ kind: "account_mismatch" }>
> {
  const channelIds = [...new Set([input.sourceChannelId, input.targetChannelId])].sort();
  const rows = await input.database("o_provider_channel")
    .whereIn("id", channelIds)
    .where({ provider: "volcano", disabled: 0 })
    .where((builder) => builder
      .where((workspace) => workspace
        .where({ scope: "workspace", workspaceId: input.workspaceId }))
      .orWhere((platform) => platform
        .where("scope", "platform")
        .whereNull("workspaceId")))
    .orderBy("id", "asc")
    .forUpdate()
    .select("id", "endpointType", "configJson");
  const source = rows.find((row) => String(row.id || "") === input.sourceChannelId);
  const target = rows.find((row) => String(row.id || "") === input.targetChannelId);
  const sourceAccount = resolveVolcanoProviderAccountSnapshot(source?.configJson);
  const targetAccount = resolveVolcanoProviderAccountSnapshot(target?.configJson);
  if (
    !target
    || String(target.endpointType || "") !== "video_generation"
    || !targetAccount
  ) return { kind: "target_unavailable" };
  if (
    !source
    || String(source.endpointType || "") !== input.sourceEndpointType
    || !sourceAccount
    || sourceAccount.binding !== input.sourceProviderAccountBinding
    || targetAccount.binding !== input.sourceProviderAccountBinding
  ) return { kind: "account_mismatch" };
  return Object.freeze({ kind: "ready", targetChannelId: String(target.id) });
}

export async function verifyTrustedPortraitOutputFromRelay(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  sourceTaskId: string | null;
  sourceSha256: string | null;
  now: number;
}): Promise<TrustedPortraitOutputEvidence> {
  const sourceSha256 = String(input.sourceSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) {
    fail(422, "portrait_trusted_output_invalid", "平台原始产物缺少不可变内容摘要");
  }
  const version = await input.database("o_image as version")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .where({
      "version.id": input.assetVersionId,
      "asset.projectId": input.projectId,
      "project.workspaceId": input.workspaceId,
      "version.deletionState": "active",
      "asset.deletionState": "active",
      "project.deletionState": "active",
    })
    .select(
      "version.filePath",
      "version.storageKey",
      "version.type",
      "asset.id as assetId",
    )
    .first();
  if (!version) {
    fail(422, "portrait_trusted_output_invalid", "平台原始产物不存在或已失效");
  }
  if (String(version.type) === "image") {
    const verified = await verifyTrustedGeneratedImageOutput({
      ...input,
      sourceSha256,
    });
    if (verified.kind === "expired") {
      fail(422, "portrait_trusted_output_expired", "平台原始产物可信期已超过 30 天");
    }
    if (verified.kind !== "trusted") {
      fail(422, "portrait_trusted_output_invalid", "该图片缺少完整的平台生成、存储或计费凭据");
    }
    return Object.freeze({
      ...verified.evidence,
      sourceEndpointType: "image_generation",
    });
  }
  if (!["video", "clip"].includes(String(version.type))) {
    fail(422, "portrait_trusted_output_invalid", "该素材类型不支持平台原始产物核验");
  }
  const providerUrl = await resolveTrustedRelayProviderVideoUrl({
    database: input.database,
    workspaceId: input.workspaceId,
    projectId: String(input.projectId),
    assetId: String(version.assetId),
    assetVersionId: String(input.assetVersionId),
    filePath: String(version.filePath || ""),
    storageKey: String(version.storageKey || ""),
  });
  if (!providerUrl) {
    fail(422, "portrait_trusted_output_invalid", "该素材不是可验证的未编辑平台原始产物");
  }
  const query = input.database("o_media_asset as media")
    .innerJoin("o_relay_task as task", "task.id", "media.taskId")
    .where({
      "media.workspaceId": input.workspaceId,
      "media.projectId": input.projectId,
      "media.source": "relay_final",
      "media.assetType": "video",
      "media.deletionState": "active",
      "media.storageKey": String(version.storageKey || ""),
      "task.workspaceId": input.workspaceId,
      "task.projectId": input.projectId,
      "task.endpointType": "video_generation",
      "task.status": "succeeded",
      "task.provider": "volcano",
    });
  if (input.sourceTaskId) query.andWhere("task.id", input.sourceTaskId);
  const rows = await query
    .select(
      "task.id as taskId",
      "task.channelId",
      "task.model",
      "task.completedAt",
      "media.id as mediaAssetId",
      "media.url as mediaUrl",
      "media.storageKey as mediaStorageKey",
      "media.createTime",
      "media.metadata",
    );
  const exact = rows.filter((row: any) => {
    const metadata = parseObject(row.metadata);
    return String(metadata.assetId || "") === String(version.assetId)
      && String(metadata.assetVersionId || "") === String(input.assetVersionId);
  });
  if (exact.length !== 1) {
    fail(422, "portrait_trusted_output_invalid", "平台原始产物凭据不唯一或已失效");
  }
  const row = exact[0];
  const completedAt = Number(row.completedAt || row.createTime || 0);
  if (
    !Number.isSafeInteger(completedAt)
    || completedAt <= 0
    || completedAt > input.now
    || input.now - completedAt > TRUSTED_GENERATED_OUTPUT_MAX_AGE_MS
  ) {
    fail(422, "portrait_trusted_output_expired", "平台原始产物可信期已超过 30 天");
  }
  const sourceChannelId = safeId(row.channelId, "原始产物通道");
  const model = safeId(row.model, "原始产物模型");
  const metadata = parseObject(row.metadata);
  const mediaProbe = parseObject(metadata.mediaProbe);
  if (
    String(mediaProbe.contentSha256 || "").toLowerCase() !== sourceSha256
    || String(row.mediaStorageKey || "") !== String(version.storageKey || "")
  ) {
    fail(422, "portrait_trusted_output_invalid", "平台视频内容摘要与原始产物凭据不一致");
  }
  const objectIntent = await verifyCommittedMediaObjectWriteIntent({
    database: input.database,
    purpose: "relay_final",
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    mediaAssetId: String(row.mediaAssetId || ""),
    storageKey: String(row.mediaStorageKey || ""),
    publicUrl: String(row.mediaUrl || ""),
    contentSha256: sourceSha256,
    referenceVersion: "object-write-reference.v2",
  });
  if (!objectIntent || objectIntent.committedAt > completedAt) {
    fail(422, "portrait_trusted_output_invalid", "平台视频缺少已提交的原始对象写入凭据");
  }
  const sourceChannel = await resolveVolcanoProviderChannelAccount({
    database: input.database,
    workspaceId: input.workspaceId,
    channelId: sourceChannelId,
    endpointType: "video_generation",
  });
  if (!sourceChannel) {
    fail(422, "portrait_trusted_output_invalid", "平台视频来源通道缺少可核验的火山账号绑定");
  }
  const evidenceCore = {
    version: "portrait-trusted-output-evidence/v2",
    assetVersionId: input.assetVersionId,
    objectWriteIntentId: objectIntent.intentId,
    sourceChannelId,
    sourceEndpointType: "video_generation",
    sourceProviderAccountBinding: sourceChannel.binding,
    completedAt,
    model,
    sourceSha256,
    sourceTaskId: String(row.taskId),
  };
  const evidenceHash = sha256(evidenceCore);
  return {
    sourceChannelId,
    sourceEndpointType: "video_generation",
    sourceProviderAccountBinding: sourceChannel.binding,
    sourceSha256,
    completedAt,
    evidenceHash,
    evidenceId: `trusted-output-${evidenceHash.slice(0, 32)}`,
    model,
    sourceTaskId: String(row.taskId),
  };
}

export async function declarePortraitAdmission(input: {
  database: Knex;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  actorUserId: number;
  choice: PortraitDeclarationChoice;
  termsVersion: string;
  termsAccepted: true;
  rightsConfirmed?: boolean;
  label?: string | null;
  sourceTaskId?: string | null;
  preferredProviderChannelId?: string | null;
  expectedRevision?: number | null;
  now?: number;
  verifyTrustedOutput?: VerifyTrustedPortraitOutput;
}): Promise<PortraitAdmissionDto> {
  const projectId = positiveInteger(input.projectId, "projectId");
  const assetVersionId = positiveInteger(input.assetVersionId, "assetVersionId");
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) fail(500, "portrait_clock_invalid", "服务器时间无效");
  if (input.termsAccepted !== true || input.termsVersion !== PORTRAIT_DECLARATION_VERSION) {
    fail(422, "portrait_terms_required", "请阅读并接受当前版本的人像素材免责声明");
  }

  await input.database.transaction(async (trx) => {
    const row = await lockedAdmission({
      database: trx,
      workspaceId: input.workspaceId,
      projectId,
      assetVersionId,
    });
    if (
      input.expectedRevision != null
      && Number(row.revision) !== Number(input.expectedRevision)
    ) fail(409, "portrait_revision_conflict", "素材状态已更新，请刷新后重试");

    // Automatic AIGC registration has no user attestation yet. Recording the
    // actual source confirmation is metadata completion, not reclassification:
    // retain the identity, channel bindings and all provider restrictions.
    if (row.subjectKind === "detected_person" && row.declarationState === "not_required"
      && input.choice === "fully_virtual_person") {
      if (!input.rightsConfirmed) {
        fail(422, "portrait_rights_attestation_required", "必须确认已获得素材和肖像使用权");
      }
      const identity = row.identityId ? await trx(PORTRAIT_IDENTITY_TABLE)
        .where({ id: row.identityId, workspaceId: input.workspaceId }).forUpdate().first() : null;
      if (!identity || identity.kind !== "detected_person" || identity.state !== "active"
        || identity.activeConsentId || row.currentConsentId) {
        fail(409, "portrait_source_review_conflict", "素材登记状态已更新，请刷新后重试来源确认");
      }
      const groups = await trx(PORTRAIT_PROVIDER_GROUP_TABLE)
        .where({ identityId: identity.id }).forUpdate().select("workspaceId", "groupType");
      if (groups.some(group => group.workspaceId !== input.workspaceId || group.groupType !== "AIGC")) {
        fail(409, "portrait_source_review_conflict", "当前登记不是虚拟素材登记，请核对素材来源");
      }
      const consentId = uuid();
      await trx(PORTRAIT_CONSENT_TABLE).insert({
        id: consentId, workspaceId: input.workspaceId, admissionId: row.id,
        identityId: identity.id, actorUserId, consentType: "virtual_person_rights",
        termsVersion: PORTRAIT_DECLARATION_VERSION,
        evidenceHash: portraitDeclarationEvidenceHash({
          admissionId: String(row.id), actorUserId, assetVersionId,
          choice: input.choice, termsVersion: input.termsVersion,
          sourceSha256: row.sourceSha256 ? String(row.sourceSha256) : null,
          trustedOutput: null,
        }),
        scopeJson: stableJson({ version: "portrait-consent-scope/v1", assetVersionId,
          choice: input.choice, rightsConfirmed: true, termsVersion: input.termsVersion,
          sourceReviewOfAutomaticRegistration: true }),
        status: "active", grantedAt: now, expiresAt: null, revokedAt: null,
        revokeReason: null, createdAt: now,
      });
      await trx(PORTRAIT_IDENTITY_TABLE).where({ id: identity.id }).update({
        kind: "virtual_person", activeConsentId: consentId,
        revision: Number(identity.revision) + 1, updatedAt: now,
      });
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        subjectKind: "virtual_person", declarationState: "confirmed",
        declarationVersion: PORTRAIT_DECLARATION_VERSION, declaredByUserId: actorUserId,
        declaredAt: now, currentConsentId: consentId,
        revision: Number(row.revision) + 1, updatedAt: now,
      });
      return;
    }

    const upstreamReview = canDeclareUpstreamRejectedPortrait(row);
    if (hasUpstreamRealPersonRejection(row) && (!upstreamReview || input.choice !== "fully_virtual_person")) {
      fail(409, "portrait_upstream_review_required", "火山已拒绝该人物参考。不能通过改选无人像或将真人改作虚拟人物放行；请更换素材或联系管理员复核。");
    }
    const scan = String(row.faceScanState || "");
    const directVirtualVideo = row.mediaType === "video" && input.choice === "fully_virtual_person";
    const pendingVideoScan = directVirtualVideo && ["queued", "scanning"].includes(scan);
    if (row.subjectKind === "virtual_person" && row.declarationState === "confirmed"
      && row.currentConsentId && input.choice === "fully_virtual_person") return;
    if (!directVirtualVideo && (scan === "multiple_faces" || Number(row.faceCount || 0) >= 2)) {
      fail(
        422,
        "portrait_multiple_faces_not_supported",
        "素材包含多张人脸，请拆分或更换素材",
      );
    }

    const existingChoice = currentChoice(row);
    const scanInconclusive = (["uncertain", "failed"].includes(scan)
      && Number(row.faceCount || 0) < 1) || isUnconfirmedVideoNoFace(row);
    if (["confirmed", "not_required"].includes(String(row.declarationState))) {
      // Same attestation on an already-confirmed row is idempotent. A legacy
      // ordinary/not_required row after an inconclusive scan still needs the
      // user's explicit "no person" attestation before it may pass.
      if (existingChoice === input.choice
        && !(scanInconclusive
          && input.choice === "ordinary_no_person"
          && String(row.declarationState) === "not_required")) return;
      if (String(row.declarationState) === "not_required" && !scanInconclusive && !upstreamReview && !directVirtualVideo) {
        fail(409, "portrait_declaration_scan_conflict", "未检测到人像的普通素材无需分类");
      }
      // A user may correct a real/virtual classification (including legacy
      // ordinary/not_required rows after an inconclusive scan). Revoke every
      // old provider binding before creating the replacement classification.
      if (row.currentConsentId) {
        await trx(PORTRAIT_CONSENT_TABLE).where({ id: row.currentConsentId }).update({
          status: "revoked",
          revokedAt: now,
          revokeReason: "user_reclassified_portrait",
        });
      }
      if (row.identityId) {
        await trx(PORTRAIT_PROVIDER_ASSET_TABLE)
          .where({ admissionId: row.id })
          .whereNot({ state: "revoked" })
          .update({
            state: "revoked",
            leaseOwner: null,
            leaseExpiresAt: null,
            safeErrorCode: null,
            safeErrorMessage: null,
            updatedAt: now,
          });
        await trx(PORTRAIT_PROVIDER_GROUP_TABLE)
          .where({ identityId: row.identityId })
          .whereNot({ state: "revoked" })
          .update({
            state: "revoked",
            leaseOwner: null,
            leaseExpiresAt: null,
            safeErrorCode: null,
            safeErrorMessage: null,
            updatedAt: now,
          });
        await trx(PORTRAIT_IDENTITY_TABLE).where({ id: row.identityId }).update({
          state: "revoked",
          activeConsentId: null,
          revision: trx.raw('"revision" + 1'),
          updatedAt: now,
        });
      }
    }

    if (["queued", "scanning"].includes(scan) && !pendingVideoScan) {
      fail(409, "portrait_scan_pending", "人像预检尚未完成");
    }
    // An inconclusive scan is only a face-presence signal. The user may attest
    // virtual / real / no-person once; the platform then finishes the rest.
    if (scanInconclusive && input.choice === "uncertain") {
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        subjectKind: "ambiguous",
        declarationState: "pending",
        complianceState: "denied",
        providerSyncState: "not_needed",
        safeErrorCode: "PORTRAIT_SOURCE_UNCERTAIN",
        safeErrorMessage: "素材来源不确定，请更换素材或联系管理员复核",
        revision: Number(row.revision) + 1,
        updatedAt: now,
      });
      return;
    }
    if (scanInconclusive && input.choice === "ordinary_no_person") {
      // User attests the material contains no person (e.g. depth/motion ref).
      // Mark as confirmed so a failed detector cannot re-open classification.
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        subjectKind: "ordinary",
        declarationState: "confirmed",
        declarationVersion: PORTRAIT_DECLARATION_VERSION,
        declaredByUserId: actorUserId,
        declaredAt: now,
        complianceState: declaredPortraitCompliance(row, "ordinary"),
        providerSyncState: "not_needed",
        safeErrorCode: null,
        safeErrorMessage: null,
        revision: Number(row.revision) + 1,
        updatedAt: now,
      });
      return;
    }
    if (scan === "no_face" && !upstreamReview && !scanInconclusive && !directVirtualVideo) {
      if (input.choice !== "ordinary_no_person") {
        fail(409, "portrait_declaration_scan_conflict", "预检未检测到人脸，无需创建人像资产");
      }
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        subjectKind: "ordinary",
        declarationState: "not_required",
        complianceState: declaredPortraitCompliance(row, "ordinary"),
        providerSyncState: "not_needed",
        safeErrorCode: null,
        safeErrorMessage: null,
        revision: Number(row.revision) + 1,
        updatedAt: now,
      });
      return;
    }
    if (!directVirtualVideo && !upstreamReview && !scanInconclusive && scan !== "single_face" && Number(row.faceCount || 0) !== 1) {
      fail(422, "portrait_face_scan_required", "素材缺少有效的人像预检结果");
    }
    if (input.choice === "ordinary_no_person") {
      fail(409, "portrait_declaration_scan_conflict", "ImageX 已检测到人像，请确认是真人像还是虚拟人像");
    }
    if (input.choice === "uncertain") {
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        subjectKind: "ambiguous",
        declarationState: "pending",
        complianceState: "denied",
        providerSyncState: "not_needed",
        safeErrorCode: "PORTRAIT_SOURCE_UNCERTAIN",
        safeErrorMessage: "素材来源不确定，请更换素材或联系管理员复核",
        revision: Number(row.revision) + 1,
        updatedAt: now,
      });
      return;
    }
    if (!input.rightsConfirmed) {
      fail(422, "portrait_rights_attestation_required", "必须确认已获得素材和肖像使用权");
    }

    const mapping = mappingForChoice(input.choice);
    if (!mapping.identityKind || !mapping.consentType) {
      fail(500, "portrait_declaration_mapping_invalid", "素材来源映射无效");
    }
    let trustedEvidence: TrustedPortraitOutputEvidence | null = null;
    if (input.choice === "trusted_volcano_output") {
      const sourceTaskId = input.sourceTaskId
        ? safeId(input.sourceTaskId, "sourceTaskId")
        : null;
      trustedEvidence = await (input.verifyTrustedOutput ?? verifyTrustedPortraitOutputFromRelay)({
        database: trx,
        workspaceId: input.workspaceId,
        projectId,
        assetVersionId,
        sourceTaskId,
        sourceSha256: row.sourceSha256 ? String(row.sourceSha256) : null,
        now,
      });
    }

    const identityId = uuid();
    const consentId = uuid();
    const label = cleanLabel(
      input.label,
      mapping.identityKind === "real_person" ? "已授权真人" : "虚拟人像",
    );
    const preferredProviderChannelId = input.preferredProviderChannelId
      ? safeId(input.preferredProviderChannelId, "供应商通道")
      : null;
    let trustedDeclarationEvidence: Record<string, unknown> | null = null;
    if (trustedEvidence) {
      if (!preferredProviderChannelId) {
        fail(409, "portrait_provider_channel_unavailable", "当前模型没有可用的火山人像资产通道");
      }
      const channelPair = await lockTrustedPortraitChannelPair({
        database: trx,
        workspaceId: input.workspaceId,
        sourceChannelId: trustedEvidence.sourceChannelId,
        sourceEndpointType: trustedEvidence.sourceEndpointType,
        sourceProviderAccountBinding: trustedEvidence.sourceProviderAccountBinding,
        targetChannelId: preferredProviderChannelId,
      });
      if (channelPair.kind === "target_unavailable") {
        fail(409, "portrait_provider_channel_unavailable", "当前模型没有可用的火山人像资产通道");
      }
      if (channelPair.kind === "account_mismatch") {
        fail(422, "portrait_trusted_output_account_mismatch", "原始产物与目标人像通道不属于同一火山账号");
      }
      trustedDeclarationEvidence = {
        ...trustedEvidence,
        targetProviderChannelId: channelPair.targetChannelId,
      };
    } else if (preferredProviderChannelId) {
      const channel = await trx("o_provider_channel")
        .where({
          id: preferredProviderChannelId,
          provider: "volcano",
          endpointType: "video_generation",
          disabled: 0,
        })
        .where((builder) => builder
          .where((platform) => platform.where("scope", "platform").whereNull("workspaceId"))
          .orWhere({ scope: "workspace", workspaceId: input.workspaceId }))
        .first("id");
      if (!channel) {
        fail(409, "portrait_provider_channel_unavailable", "当前模型没有可用的火山人像资产通道");
      }
    }
    const scope = {
      version: "portrait-consent-scope/v1",
      assetVersionId,
      choice: input.choice,
      rightsConfirmed: true,
      termsVersion: input.termsVersion,
      ...(trustedDeclarationEvidence
        ? { trustedOutput: trustedDeclarationEvidence }
        : {}),
    };
    const evidenceHash = portraitDeclarationEvidenceHash({
      admissionId: String(row.id),
      actorUserId,
      assetVersionId,
      choice: input.choice,
      termsVersion: input.termsVersion,
      sourceSha256: row.sourceSha256 ? String(row.sourceSha256) : null,
      trustedOutput: trustedDeclarationEvidence,
    });
    await trx(PORTRAIT_IDENTITY_TABLE).insert({
      id: identityId,
      workspaceId: input.workspaceId,
      ownerUserId: actorUserId,
      kind: mapping.identityKind,
      label,
      state: mapping.identityKind === "real_person" ? "pending" : "active",
      activeConsentId: consentId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await trx(PORTRAIT_CONSENT_TABLE).insert({
      id: consentId,
      workspaceId: input.workspaceId,
      admissionId: row.id,
      identityId,
      actorUserId,
      consentType: mapping.consentType,
      termsVersion: PORTRAIT_DECLARATION_VERSION,
      evidenceHash,
      scopeJson: stableJson(scope),
      status: "active",
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      revokeReason: null,
      createdAt: now,
    });

    const complianceState = declaredPortraitCompliance(row, mapping.subjectKind);
    const providerSyncState = complianceState === "allowed" ? "queued" : "not_needed";
    await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
      // Explicit source attestation supersedes pending face detection, not
      // supplier review. Keep any dispatch evidence and advance the revision
      // so a late detector result cannot overwrite consent or registration.
      ...(pendingVideoScan ? { faceScanState: "uncertain", faceScanCoverage: "none", faceCount: null } : {}),
      subjectKind: mapping.subjectKind,
      declarationState: "confirmed",
      declarationVersion: PORTRAIT_DECLARATION_VERSION,
      declaredByUserId: actorUserId,
      declaredAt: now,
      identityId,
      currentConsentId: consentId,
      currentProviderAssetBindingId: null,
      preferredProviderChannelId,
      complianceState,
      providerSyncState,
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: Number(row.revision) + 1,
      updatedAt: now,
    });
  });

  const result = await readPortraitAdmission({
    database: input.database,
    workspaceId: input.workspaceId,
    projectId,
    assetVersionId,
  });
  if (!result) fail(500, "portrait_admission_missing_after_write", "素材准入记录写入失败");
  return result;
}
