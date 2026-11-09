import crypto from "node:crypto";
import type { Request } from "express";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { writeAuditLog } from "@/lib/audit";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_MANUAL_REVIEW_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";

export const PORTRAIT_MANUAL_REVIEW_POLICY_VERSION =
  "portrait-full-video-face-review/2026-08-07" as const;
export const PORTRAIT_MANUAL_REVIEW_LEASE_MS = 15 * 60_000;

export type PortraitManualReviewDecision =
  | "no_face"
  | "single_face"
  | "multiple_faces"
  | "uncertain";

export class PortraitManualReviewError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PortraitManualReviewError";
    this.status = status;
    this.code = code;
  }
}

type Database = Knex | Knex.Transaction;
type Row = Record<string, any>;

function fail(status: number, code: string, message: string): never {
  throw new PortraitManualReviewError(status, code, message);
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

function hash64(value: unknown, label: string): string {
  const parsed = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(parsed)) fail(409, "portrait_review_binding_invalid", `${label} 缺失或无效`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(400, "portrait_review_request_invalid", `${label} 无效`);
  return parsed;
}

function safeId(value: unknown, label: string, maximum = 256): string {
  const parsed = String(value ?? "").trim();
  if (!parsed || parsed.length > maximum || /[\u0000-\u001f\u007f\s]/u.test(parsed)) {
    fail(400, "portrait_review_request_invalid", `${label} 无效`);
  }
  return parsed;
}

export function portraitManualReviewActor(req: Request): { userId: number; role: string } {
  const auth = (req as any).auth || {};
  const user = auth.user || (req as any).user || {};
  const userId = Number(user.id || 0);
  const role = String(user.role || "").trim().toLowerCase();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !["root", "admin", "super_admin"].includes(role)) {
    fail(403, "portrait_review_admin_required", "需要平台管理员权限");
  }
  return { userId, role };
}

/**
 * Bind a claim to the authenticated login session without persisting the JWT,
 * Authorization value, session id, cookie, or step-up proof. The prefix keeps
 * session ids and raw Authorization tokens in separate hash domains.
 */
export function portraitManualReviewSessionHash(req: Request): string {
  const sessionId = String((req as any).auth?.session?.id || "").trim();
  if (sessionId) return portraitManualReviewSessionHashFromId(sessionId);
  const authorization = String(req.header("authorization") || "").trim();
  if (authorization) return sha256(`portrait-review-session/v1:authorization:${authorization}`);
  fail(401, "portrait_review_session_required", "需要可验证的登录会话");
}

/**
 * Derive the claimant binding from a server-verified session id. Preview
 * grants use this same function so the cookie-authenticated Range lane cannot
 * drift from the ordinary Authorization-backed claim lane.
 */
export function portraitManualReviewSessionHashFromId(sessionId: unknown): string {
  const normalized = String(sessionId ?? "").trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f\s]/u.test(normalized)) {
    fail(401, "portrait_review_session_required", "需要可验证的登录会话");
  }
  return sha256(`portrait-review-session/v1:session:${normalized}`);
}

export function portraitManualReviewIdempotencyKey(input: {
  admissionId: string;
  assetVersionId: number;
  sourceSha256: string;
  sampleEvidenceHash: string;
}): string {
  return `portrait-review-${sha256({
    admissionId: input.admissionId,
    assetVersionId: input.assetVersionId,
    policyVersion: PORTRAIT_MANUAL_REVIEW_POLICY_VERSION,
    sampleEvidenceHash: input.sampleEvidenceHash,
    sourceSha256: input.sourceSha256,
  })}`;
}

export async function enqueuePortraitManualReview(input: {
  database: Database;
  admission: Row;
  sampleEvidenceHash: string;
  now: number;
}): Promise<Row> {
  const admissionId = safeId(input.admission.id, "admissionId");
  const workspaceId = safeId(input.admission.workspaceId, "workspaceId");
  const projectId = positiveInteger(input.admission.projectId, "projectId");
  const assetVersionId = positiveInteger(input.admission.assetVersionId, "assetVersionId");
  const sourceSha256 = hash64(input.admission.sourceSha256, "sourceSha256");
  const sampleEvidenceHash = hash64(input.sampleEvidenceHash, "sampleEvidenceHash");
  const admissionRevisionAtCreate = positiveInteger(input.admission.revision, "admissionRevision");
  const idempotencyKey = portraitManualReviewIdempotencyKey({
    admissionId,
    assetVersionId,
    sourceSha256,
    sampleEvidenceHash,
  });
  await input.database(PORTRAIT_MANUAL_REVIEW_TABLE).insert({
    id: uuid(),
    admissionId,
    workspaceId,
    projectId,
    assetVersionId,
    sourceSha256,
    sampleEvidenceHash,
    admissionRevisionAtCreate,
    idempotencyKey,
    state: "pending",
    claimOwnerUserId: null,
    claimSessionHash: null,
    claimLeaseExpiresAt: null,
    decision: null,
    policyVersion: null,
    attestationHash: null,
    reviewedAt: null,
    releasedAt: null,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflict("idempotencyKey").ignore();
  const review = await input.database(PORTRAIT_MANUAL_REVIEW_TABLE)
    .where({ idempotencyKey })
    .first();
  if (!review || !["pending", "claimed"].includes(String(review.state))) {
    fail(409, "portrait_review_enqueue_conflict", "人工复核代次已失效，请重新预检");
  }
  return review;
}

function assertBinding(admission: Row, review: Row): void {
  if (
    String(review.admissionId) !== String(admission.id)
    || String(review.workspaceId) !== String(admission.workspaceId)
    || Number(review.projectId) !== Number(admission.projectId)
    || Number(review.assetVersionId) !== Number(admission.assetVersionId)
    || String(review.sourceSha256) !== String(admission.sourceSha256)
    || String(admission.currentManualReviewId || "") !== String(review.id)
    || String(admission.mediaType) !== "video"
  ) fail(409, "portrait_review_binding_invalid", "复核记录与当前素材版本不一致");
}

async function lockedPair(input: {
  database: Knex.Transaction;
  admissionId: string;
  reviewId: string;
}): Promise<{ admission: Row; review: Row }> {
  // The global order is admission -> review. Every mutation uses this order.
  const admission = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({ id: input.admissionId })
    .forUpdate()
    .first();
  if (!admission) fail(404, "portrait_review_not_found", "素材复核不存在");
  const review = await input.database(PORTRAIT_MANUAL_REVIEW_TABLE)
    .where({ id: input.reviewId })
    .forUpdate()
    .first();
  if (!review) fail(404, "portrait_review_not_found", "素材复核不存在");
  assertBinding(admission, review);
  return { admission, review };
}

function assertExpected(input: {
  admission: Row;
  review: Row;
  expectedAdmissionRevision: number;
  expectedReviewRevision: number;
}): void {
  if (
    Number(input.admission.revision) !== input.expectedAdmissionRevision
    || Number(input.review.revision) !== input.expectedReviewRevision
  ) fail(409, "portrait_review_revision_conflict", "复核状态已更新，请刷新后重试");
}

function publicReview(
  admission: Row,
  review: Row,
  actor?: Readonly<{ userId: number; sessionHash: string; now: number }>,
): Record<string, unknown> {
  const claimedByCurrentAdmin = actor != null
    && String(review.state) === "claimed"
    && Number(review.claimOwnerUserId || 0) === actor.userId
    && String(review.claimSessionHash || "") === hash64(actor.sessionHash, "sessionHash")
    && Number(review.claimLeaseExpiresAt || 0) > actor.now;
  return {
    admission: {
      id: String(admission.id),
      revision: Number(admission.revision),
      workspaceId: String(admission.workspaceId),
      projectId: Number(admission.projectId),
      assetId: Number(admission.assetId),
      assetVersionId: Number(admission.assetVersionId),
      mediaType: "video",
      faceScanState: String(admission.faceScanState),
      faceScanCoverage: String(admission.faceScanCoverage || "none"),
      manualReviewState: String(admission.manualReviewState || "pending"),
      manualReviewDecision: admission.manualReviewDecision == null
        ? null
        : String(admission.manualReviewDecision),
      moderationState: String(admission.moderationState || "pending"),
      declarationState: String(admission.declarationState || "pending"),
      complianceState: String(admission.complianceState || "pending"),
      providerSyncState: String(admission.providerSyncState || "not_needed"),
    },
    review: {
      id: String(review.id),
      revision: Number(review.revision),
      state: String(review.state),
      claimedByCurrentAdmin,
      claimLeaseExpiresAt: review.claimLeaseExpiresAt == null
        ? null
        : Number(review.claimLeaseExpiresAt),
      decision: review.decision == null ? null : String(review.decision),
      createdAt: Number(review.createdAt),
      updatedAt: Number(review.updatedAt),
    },
  };
}

export async function readPortraitManualReview(input: {
  database: Database;
  admissionId: string;
  actorUserId: number;
  sessionHash: string;
  now?: number;
}): Promise<Record<string, unknown>> {
  const admission = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({ id: safeId(input.admissionId, "admissionId") })
    .first();
  if (!admission || !admission.currentManualReviewId) {
    fail(404, "portrait_review_not_found", "素材复核不存在");
  }
  const review = await input.database(PORTRAIT_MANUAL_REVIEW_TABLE)
    .where({ id: admission.currentManualReviewId })
    .first();
  if (!review) fail(404, "portrait_review_not_found", "素材复核不存在");
  assertBinding(admission, review);
  return publicReview(admission, review, {
    userId: input.actorUserId,
    sessionHash: input.sessionHash,
    now: input.now ?? Date.now(),
  });
}

export async function claimPortraitManualReview(input: {
  database: Knex;
  auditRequest: Request;
  admissionId: string;
  reviewId: string;
  actorUserId: number;
  sessionHash: string;
  expectedAdmissionRevision: number;
  expectedReviewRevision: number;
  now?: number;
}): Promise<Record<string, unknown>> {
  const now = input.now ?? Date.now();
  return input.database.transaction(async (trx) => {
    const pair = await lockedPair({
      database: trx,
      admissionId: safeId(input.admissionId, "admissionId"),
      reviewId: safeId(input.reviewId, "reviewId"),
    });
    assertExpected({ ...pair, ...input });
    const claimIsLive = String(pair.review.state) === "claimed"
      && Number(pair.review.claimLeaseExpiresAt || 0) > now;
    const sameClaim = claimIsLive
      && Number(pair.review.claimOwnerUserId) === input.actorUserId
      && String(pair.review.claimSessionHash) === hash64(input.sessionHash, "sessionHash");
    if (claimIsLive && !sameClaim) fail(409, "portrait_review_already_claimed", "该复核已由其他管理员领取");
    if (!["pending", "claimed"].includes(String(pair.review.state))) {
      fail(409, "portrait_review_state_invalid", "该复核当前不可领取");
    }
    const leaseExpiresAt = now + PORTRAIT_MANUAL_REVIEW_LEASE_MS;
    await trx(PORTRAIT_MANUAL_REVIEW_TABLE).where({ id: pair.review.id }).update({
      state: "claimed",
      claimOwnerUserId: input.actorUserId,
      claimSessionHash: hash64(input.sessionHash, "sessionHash"),
      claimLeaseExpiresAt: leaseExpiresAt,
      revision: Number(pair.review.revision) + 1,
      updatedAt: now,
    });
    await trx(PORTRAIT_ADMISSION_TABLE).where({ id: pair.admission.id }).update({
      manualReviewState: "in_review",
      revision: Number(pair.admission.revision) + 1,
      updatedAt: now,
    });
    await writeAuditLog(input.auditRequest, {
      workspaceId: String(pair.admission.workspaceId),
      action: "admin.portrait_manual_review.claim",
      resourceType: "portrait_manual_review",
      resourceId: pair.review.id,
      required: true,
      metadata: {
        admissionId: String(pair.admission.id),
        assetVersionId: Number(pair.admission.assetVersionId),
        fromReviewRevision: Number(pair.review.revision),
        leaseExpiresAt,
      },
    }, trx);
    return publicReview(
      { ...pair.admission, manualReviewState: "in_review", revision: Number(pair.admission.revision) + 1 },
      {
        ...pair.review,
        state: "claimed",
        claimOwnerUserId: input.actorUserId,
        claimSessionHash: hash64(input.sessionHash, "sessionHash"),
        claimLeaseExpiresAt: leaseExpiresAt,
        revision: Number(pair.review.revision) + 1,
        updatedAt: now,
      },
      { userId: input.actorUserId, sessionHash: input.sessionHash, now },
    );
  });
}

function assertLiveOwner(input: {
  review: Row;
  actorUserId: number;
  sessionHash: string;
  now: number;
}): void {
  if (
    String(input.review.state) !== "claimed"
    || Number(input.review.claimOwnerUserId || 0) !== input.actorUserId
    || String(input.review.claimSessionHash || "") !== hash64(input.sessionHash, "sessionHash")
    || Number(input.review.claimLeaseExpiresAt || 0) <= input.now
  ) fail(409, "portrait_review_claim_required", "请先用当前管理员会话领取复核，或领取已过期");
}

export async function releasePortraitManualReview(input: {
  database: Knex;
  auditRequest: Request;
  admissionId: string;
  reviewId: string;
  actorUserId: number;
  sessionHash: string;
  expectedAdmissionRevision: number;
  expectedReviewRevision: number;
  now?: number;
}): Promise<Record<string, unknown>> {
  const now = input.now ?? Date.now();
  return input.database.transaction(async (trx) => {
    const pair = await lockedPair({ database: trx, admissionId: input.admissionId, reviewId: input.reviewId });
    assertExpected({ ...pair, ...input });
    assertLiveOwner({ review: pair.review, ...input, now });
    await trx(PORTRAIT_MANUAL_REVIEW_TABLE).where({ id: pair.review.id }).update({
      state: "pending",
      claimOwnerUserId: null,
      claimSessionHash: null,
      claimLeaseExpiresAt: null,
      revision: Number(pair.review.revision) + 1,
      updatedAt: now,
    });
    await trx(PORTRAIT_ADMISSION_TABLE).where({ id: pair.admission.id }).update({
      manualReviewState: "pending",
      revision: Number(pair.admission.revision) + 1,
      updatedAt: now,
    });
    await writeAuditLog(input.auditRequest, {
      workspaceId: String(pair.admission.workspaceId),
      action: "admin.portrait_manual_review.release",
      resourceType: "portrait_manual_review",
      resourceId: pair.review.id,
      required: true,
      metadata: {
        admissionId: String(pair.admission.id),
        assetVersionId: Number(pair.admission.assetVersionId),
        fromReviewRevision: Number(pair.review.revision),
      },
    }, trx);
    return publicReview(
      { ...pair.admission, manualReviewState: "pending", revision: Number(pair.admission.revision) + 1 },
      {
        ...pair.review,
        state: "pending",
        claimOwnerUserId: null,
        claimLeaseExpiresAt: null,
        revision: Number(pair.review.revision) + 1,
        updatedAt: now,
      },
    );
  });
}

function decisionProjection(decision: PortraitManualReviewDecision, moderationState: string): Row {
  switch (decision) {
    case "no_face":
      return {
        faceScanState: "no_face",
        faceCount: 0,
        subjectKind: "ordinary",
        declarationState: "not_required",
        complianceState: moderationState === "allowed"
          ? "not_required"
          : moderationState === "denied" ? "denied" : "pending",
        providerSyncState: "not_needed",
        safeErrorCode: null,
        safeErrorMessage: null,
      };
    case "single_face":
      return {
        faceScanState: "single_face",
        faceCount: 1,
        subjectKind: "pending",
        declarationState: "pending",
        complianceState: moderationState === "denied" ? "denied" : "pending",
        providerSyncState: "not_needed",
        safeErrorCode: null,
        safeErrorMessage: null,
      };
    case "multiple_faces":
      return {
        faceScanState: "multiple_faces",
        faceCount: 2,
        subjectKind: "multiple_faces",
        declarationState: "not_required",
        complianceState: "denied",
        providerSyncState: "not_needed",
        safeErrorCode: "PORTRAIT_MULTIPLE_FACES_UNSUPPORTED",
        safeErrorMessage: "人工全片复核发现多人脸，请拆分或更换素材",
      };
    case "uncertain":
      return {
        faceScanState: "uncertain",
        faceCount: null,
        subjectKind: "ambiguous",
        declarationState: "pending",
        complianceState: "denied",
        providerSyncState: "not_needed",
        safeErrorCode: "PORTRAIT_SOURCE_UNCERTAIN",
        safeErrorMessage: "人工全片复核仍无法确认人脸数量，请更换素材",
      };
  }
}

export async function decidePortraitManualReview(input: {
  database: Knex;
  auditRequest: Request;
  admissionId: string;
  reviewId: string;
  actorUserId: number;
  sessionHash: string;
  expectedAdmissionRevision: number;
  expectedReviewRevision: number;
  decision: PortraitManualReviewDecision;
  fullVideoViewed: true;
  faceCountOnlyConfirmed: true;
  reason?: string | null;
  now?: number;
}): Promise<Record<string, unknown>> {
  const now = input.now ?? Date.now();
  const reason = String(input.reason || "").trim();
  if (reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    fail(400, "portrait_review_request_invalid", "复核备注无效");
  }
  if (input.fullVideoViewed !== true || input.faceCountOnlyConfirmed !== true) {
    fail(422, "portrait_review_attestation_required", "必须完整播放视频并确认本次只判断人脸数量");
  }
  if (!["no_face", "single_face", "multiple_faces", "uncertain"].includes(input.decision)) {
    fail(400, "portrait_review_request_invalid", "复核结论无效");
  }
  return input.database.transaction(async (trx) => {
    const pair = await lockedPair({ database: trx, admissionId: input.admissionId, reviewId: input.reviewId });
    assertExpected({ ...pair, ...input });
    assertLiveOwner({ review: pair.review, ...input, now });
    const attestationHash = sha256({
      admissionId: pair.admission.id,
      admissionRevision: Number(pair.admission.revision),
      assetVersionId: Number(pair.admission.assetVersionId),
      decision: input.decision,
      fullVideoViewed: true,
      faceCountOnlyConfirmed: true,
      policyVersion: PORTRAIT_MANUAL_REVIEW_POLICY_VERSION,
      reasonHash: reason ? sha256(reason) : null,
      reviewerUserId: input.actorUserId,
      reviewId: pair.review.id,
      reviewRevision: Number(pair.review.revision),
      sampleEvidenceHash: pair.review.sampleEvidenceHash,
      sourceSha256: pair.review.sourceSha256,
      reviewedAt: now,
    });
    await trx(PORTRAIT_MANUAL_REVIEW_TABLE).where({ id: pair.review.id }).update({
      state: "completed",
      claimOwnerUserId: null,
      claimSessionHash: null,
      claimLeaseExpiresAt: null,
      decision: input.decision,
      policyVersion: PORTRAIT_MANUAL_REVIEW_POLICY_VERSION,
      attestationHash,
      reviewedAt: now,
      revision: Number(pair.review.revision) + 1,
      updatedAt: now,
    });
    const projection = decisionProjection(input.decision, String(pair.admission.moderationState || "pending"));
    await trx(PORTRAIT_ADMISSION_TABLE).where({ id: pair.admission.id }).update({
      ...projection,
      faceScanCoverage: "full_video_manual",
      manualReviewState: "completed",
      manualReviewDecision: input.decision,
      manualReviewEvidenceHash: attestationHash,
      manualReviewPolicyVersion: PORTRAIT_MANUAL_REVIEW_POLICY_VERSION,
      manualReviewedByUserId: input.actorUserId,
      manualReviewedAt: now,
      revision: Number(pair.admission.revision) + 1,
      updatedAt: now,
    });
    await writeAuditLog(input.auditRequest, {
      workspaceId: String(pair.admission.workspaceId),
      action: "admin.portrait_manual_review.decide",
      resourceType: "portrait_manual_review",
      resourceId: pair.review.id,
      required: true,
      metadata: {
        admissionId: String(pair.admission.id),
        assetVersionId: Number(pair.admission.assetVersionId),
        decision: input.decision,
        faceCountOnly: true,
        policyVersion: PORTRAIT_MANUAL_REVIEW_POLICY_VERSION,
        attestationHash,
      },
    }, trx);
    return publicReview(
      {
        ...pair.admission,
        ...projection,
        faceScanCoverage: "full_video_manual",
        manualReviewState: "completed",
        manualReviewDecision: input.decision,
        revision: Number(pair.admission.revision) + 1,
      },
      {
        ...pair.review,
        state: "completed",
        decision: input.decision,
        claimOwnerUserId: null,
        claimLeaseExpiresAt: null,
        revision: Number(pair.review.revision) + 1,
        updatedAt: now,
      },
    );
  });
}

export async function resolvePortraitManualReviewPreview(input: {
  database: Database;
  reviewId: string;
  actorUserId: number;
  sessionHash: string;
  now?: number;
}): Promise<{ filePath: string; contentType: string }> {
  const now = input.now ?? Date.now();
  const row = await input.database(`${PORTRAIT_MANUAL_REVIEW_TABLE} as review`)
    .innerJoin(`${PORTRAIT_ADMISSION_TABLE} as admission`, "admission.id", "review.admissionId")
    .innerJoin("o_image as version", "version.id", "review.assetVersionId")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .where({ "review.id": safeId(input.reviewId, "reviewId") })
    .select(
      "review.*",
      "admission.currentManualReviewId",
      "admission.workspaceId as admissionWorkspaceId",
      "admission.projectId as admissionProjectId",
      "admission.assetVersionId as admissionAssetVersionId",
      "admission.sourceSha256 as admissionSourceSha256",
      "version.filePath",
      "version.type as versionType",
      "asset.projectId as assetProjectId",
      "project.workspaceId as projectWorkspaceId",
    )
    .first();
  if (!row) fail(404, "portrait_review_not_found", "素材复核不存在");
  if (
    String(row.currentManualReviewId || "") !== String(row.id)
    || String(row.admissionWorkspaceId) !== String(row.workspaceId)
    || String(row.projectWorkspaceId) !== String(row.workspaceId)
    || Number(row.admissionProjectId) !== Number(row.projectId)
    || Number(row.assetProjectId) !== Number(row.projectId)
    || Number(row.admissionAssetVersionId) !== Number(row.assetVersionId)
    || String(row.admissionSourceSha256) !== String(row.sourceSha256)
    || String(row.versionType) !== "video"
  ) fail(409, "portrait_review_binding_invalid", "复核视频与当前素材版本不一致");
  assertLiveOwner({ review: row, ...input, now });
  const filePath = String(row.filePath || "").trim();
  if (!filePath || /[\u0000-\u001f\u007f]/u.test(filePath)) {
    fail(409, "portrait_review_preview_unavailable", "复核视频暂不可播放");
  }
  return { filePath, contentType: "video/mp4" };
}
