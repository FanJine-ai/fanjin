import crypto from "node:crypto";
import type { VideoReferenceMediaType } from "@/lib/videoGenerationContract";

/** Storage-agnostic state machine for project-controlled reference uploads. */
export const CONTROLLED_REFERENCE_UPLOAD_VERSION =
  "controlled-reference-upload/v1" as const;

export type ControlledReferenceUploadStatus =
  | "initiated"
  | "uploading"
  | "verifying"
  | "completed"
  | "failed"
  | "aborted";

export type ControlledReferenceUploadPart = {
  partNumber: number;
  byteSize: number;
  etag: string;
};

export type ControlledReferenceUploadSession = {
  version: typeof CONTROLLED_REFERENCE_UPLOAD_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  mediaType: VideoReferenceMediaType;
  fileName: string;
  declaredMimeType: string;
  expectedByteSize: number;
  expectedSha256: string;
  storageKey: string;
  uploadLeaseId: string;
  chunkByteSize: number;
  status: ControlledReferenceUploadStatus;
  attempt: number;
  maxAttempts: number;
  parts: ControlledReferenceUploadPart[];
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  errorCode: string | null;
  abortReason: string | null;
  assetVersionId: string | null;
};

export type ControlledReferenceUploadVerification = {
  actualByteSize: number;
  actualSha256: string;
  detectedMimeType: string;
  magicMatchesMime: boolean;
  malwareScan: "clean" | "infected" | "unavailable";
  mediaProbe: "pass" | "fail" | "not_applicable";
  authorizationEvidenceId: string;
  moderationEvidenceId: string;
};

export class ControlledReferenceUploadError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ControlledReferenceUploadError";
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const MIME_BY_MEDIA: Record<VideoReferenceMediaType, readonly RegExp[]> = {
  image: [/^image\/(?:jpeg|png|gif|webp)$/u],
  video: [/^video\/(?:mp4|webm|quicktime)$/u],
  audio: [/^audio\/(?:mpeg|mp3|wav|mp4)$/u],
};

function required(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new ControlledReferenceUploadError("upload_metadata_invalid", `${field} 不能为空`);
  return normalized;
}

function timestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new ControlledReferenceUploadError("upload_time_invalid", "上传时间无效");
  }
  return value.toISOString();
}

function assertMutable(session: ControlledReferenceUploadSession): void {
  if (["completed", "aborted"].includes(session.status)) {
    throw new ControlledReferenceUploadError("upload_terminal", "上传会话已进入终态");
  }
}

function assertNotExpired(session: ControlledReferenceUploadSession, now: Date): void {
  if (now.getTime() >= Date.parse(session.expiresAt)) {
    throw new ControlledReferenceUploadError("upload_expired", "上传会话已过期");
  }
}

function normalizeMime(value: string): string {
  return value.trim().toLowerCase().split(";", 1)[0];
}

function acceptsMime(mediaType: VideoReferenceMediaType, mimeType: string): boolean {
  return MIME_BY_MEDIA[mediaType].some((pattern) => pattern.test(normalizeMime(mimeType)));
}

export function createControlledReferenceUploadSession(input: {
  id: string;
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  mediaType: VideoReferenceMediaType;
  fileName: string;
  declaredMimeType: string;
  expectedByteSize: number;
  expectedSha256: string;
  storageKey: string;
  uploadLeaseId: string;
  chunkByteSize: number;
  maxAttempts?: number;
  authorizationAllowed: boolean;
  now?: Date;
  expiresAt: Date;
}): ControlledReferenceUploadSession {
  const now = input.now ?? new Date();
  const expectedSha256 = required(input.expectedSha256, "expectedSha256").toLowerCase();
  const mediaType = input.mediaType;
  const declaredMimeType = normalizeMime(required(input.declaredMimeType, "declaredMimeType"));
  const maxAttempts = input.maxAttempts ?? 3;
  if (!input.authorizationAllowed) {
    throw new ControlledReferenceUploadError("upload_authorization_denied", "当前主体无权上传到该项目");
  }
  if (!MIME_BY_MEDIA[mediaType] || !acceptsMime(mediaType, declaredMimeType)) {
    throw new ControlledReferenceUploadError("upload_mime_unsupported", "文件 MIME 与参考素材类型不匹配");
  }
  if (!Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize <= 0) {
    throw new ControlledReferenceUploadError("upload_size_invalid", "文件大小无效");
  }
  if (!Number.isSafeInteger(input.chunkByteSize) || input.chunkByteSize <= 0) {
    throw new ControlledReferenceUploadError("upload_chunk_size_invalid", "分片大小无效");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new ControlledReferenceUploadError("upload_retry_policy_invalid", "上传重试策略无效");
  }
  if (!SHA256.test(expectedSha256)) {
    throw new ControlledReferenceUploadError("upload_digest_invalid", "文件 SHA-256 无效");
  }
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new ControlledReferenceUploadError("upload_expiry_invalid", "上传过期时间无效");
  }
  const workspaceId = required(input.workspaceId, "workspaceId");
  const projectId = required(input.projectId, "projectId");
  const storageKey = required(input.storageKey, "storageKey");
  const expectedPrefix = `workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/references/`;
  if (!storageKey.startsWith(expectedPrefix) || storageKey.includes("..")) {
    throw new ControlledReferenceUploadError("upload_storage_scope_invalid", "上传对象键不属于当前工作区和项目");
  }
  return {
    version: CONTROLLED_REFERENCE_UPLOAD_VERSION,
    id: required(input.id, "id"),
    workspaceId,
    projectId,
    actorUserId: required(input.actorUserId, "actorUserId"),
    mediaType,
    fileName: required(input.fileName, "fileName"),
    declaredMimeType,
    expectedByteSize: input.expectedByteSize,
    expectedSha256,
    storageKey,
    uploadLeaseId: required(input.uploadLeaseId, "uploadLeaseId"),
    chunkByteSize: input.chunkByteSize,
    status: "initiated",
    attempt: 1,
    maxAttempts,
    parts: [],
    createdAt: timestamp(now),
    expiresAt: timestamp(input.expiresAt),
    updatedAt: timestamp(now),
    errorCode: null,
    abortReason: null,
    assetVersionId: null,
  };
}

export function recordControlledReferenceUploadPart(
  session: ControlledReferenceUploadSession,
  input: ControlledReferenceUploadPart & { uploadLeaseId: string; now?: Date },
): ControlledReferenceUploadSession {
  const now = input.now ?? new Date();
  assertMutable(session);
  assertNotExpired(session, now);
  if (!["initiated", "uploading"].includes(session.status)) {
    throw new ControlledReferenceUploadError("upload_state_conflict", "当前上传状态不能接收分片");
  }
  if (input.uploadLeaseId !== session.uploadLeaseId) {
    throw new ControlledReferenceUploadError("upload_lease_mismatch", "上传租约已变更");
  }
  if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > 10_000) {
    throw new ControlledReferenceUploadError("upload_part_number_invalid", "分片编号无效");
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > session.chunkByteSize) {
    throw new ControlledReferenceUploadError("upload_part_size_invalid", "分片大小无效");
  }
  const etag = required(input.etag, "etag");
  const existing = session.parts.find((part) => part.partNumber === input.partNumber);
  if (existing) {
    if (existing.byteSize === input.byteSize && existing.etag === etag) return session;
    throw new ControlledReferenceUploadError("upload_part_replay_conflict", "同一分片编号的内容已变更");
  }
  const parts = [...session.parts, { partNumber: input.partNumber, byteSize: input.byteSize, etag }]
    .sort((left, right) => left.partNumber - right.partNumber);
  if (parts.reduce((sum, part) => sum + part.byteSize, 0) > session.expectedByteSize) {
    throw new ControlledReferenceUploadError("upload_size_exceeded", "已上传分片超过声明的文件大小");
  }
  return {
    ...session,
    status: "uploading",
    parts,
    updatedAt: timestamp(now),
    errorCode: null,
  };
}

export function requestControlledReferenceUploadVerification(
  session: ControlledReferenceUploadSession,
  input: { uploadLeaseId: string; now?: Date },
): ControlledReferenceUploadSession {
  const now = input.now ?? new Date();
  assertMutable(session);
  assertNotExpired(session, now);
  if (!["initiated", "uploading"].includes(session.status)) {
    throw new ControlledReferenceUploadError("upload_state_conflict", "当前上传状态不能完成");
  }
  if (input.uploadLeaseId !== session.uploadLeaseId) {
    throw new ControlledReferenceUploadError("upload_lease_mismatch", "上传租约已变更");
  }
  if (!session.parts.length || session.parts.reduce((sum, part) => sum + part.byteSize, 0) !== session.expectedByteSize) {
    throw new ControlledReferenceUploadError("upload_incomplete", "上传分片尚未覆盖完整文件");
  }
  if (session.parts.some((part, index) => part.partNumber !== index + 1)) {
    throw new ControlledReferenceUploadError("upload_part_gap", "上传分片存在缺口");
  }
  return { ...session, status: "verifying", updatedAt: timestamp(now), errorCode: null };
}

export function completeControlledReferenceUpload(
  session: ControlledReferenceUploadSession,
  input: ControlledReferenceUploadVerification & { assetVersionId: string; now?: Date },
): ControlledReferenceUploadSession {
  const now = input.now ?? new Date();
  assertNotExpired(session, now);
  if (session.status !== "verifying") {
    throw new ControlledReferenceUploadError("upload_state_conflict", "上传尚未进入服务端校验阶段");
  }
  const actualSha256 = input.actualSha256.toLowerCase();
  const verificationPassed = input.actualByteSize === session.expectedByteSize
    && actualSha256 === session.expectedSha256
    && SHA256.test(actualSha256)
    && acceptsMime(session.mediaType, input.detectedMimeType)
    && normalizeMime(input.detectedMimeType) === session.declaredMimeType
    && input.magicMatchesMime
    && input.malwareScan === "clean"
    && input.mediaProbe === "pass"
    && Boolean(input.authorizationEvidenceId.trim())
    && Boolean(input.moderationEvidenceId.trim());
  if (!verificationPassed) {
    throw new ControlledReferenceUploadError("upload_verification_failed", "上传文件未通过完整性、MIME、安全、媒体或授权校验");
  }
  return {
    ...session,
    status: "completed",
    assetVersionId: required(input.assetVersionId, "assetVersionId"),
    updatedAt: timestamp(now),
    errorCode: null,
  };
}

export function failControlledReferenceUpload(
  session: ControlledReferenceUploadSession,
  input: { code: string; now?: Date },
): ControlledReferenceUploadSession {
  const now = input.now ?? new Date();
  assertMutable(session);
  return {
    ...session,
    status: "failed",
    errorCode: required(input.code, "code"),
    updatedAt: timestamp(now),
  };
}

export function retryControlledReferenceUpload(
  session: ControlledReferenceUploadSession,
  input: { freshUploadLeaseId: string; now?: Date },
): ControlledReferenceUploadSession {
  const now = input.now ?? new Date();
  assertNotExpired(session, now);
  if (session.status !== "failed") {
    throw new ControlledReferenceUploadError("upload_retry_state_invalid", "只能重试失败的上传会话");
  }
  if (session.attempt >= session.maxAttempts) {
    throw new ControlledReferenceUploadError("upload_retry_exhausted", "上传重试次数已耗尽");
  }
  const freshUploadLeaseId = required(input.freshUploadLeaseId, "freshUploadLeaseId");
  if (freshUploadLeaseId === session.uploadLeaseId) {
    throw new ControlledReferenceUploadError("upload_retry_lease_reused", "重试必须使用新的上传租约");
  }
  return {
    ...session,
    uploadLeaseId: freshUploadLeaseId,
    status: "initiated",
    attempt: session.attempt + 1,
    parts: [],
    updatedAt: timestamp(now),
    errorCode: null,
  };
}

export function abortControlledReferenceUpload(
  session: ControlledReferenceUploadSession,
  input: { reason: string; now?: Date },
): ControlledReferenceUploadSession {
  const now = input.now ?? new Date();
  assertMutable(session);
  return {
    ...session,
    status: "aborted",
    abortReason: required(input.reason, "reason"),
    updatedAt: timestamp(now),
  };
}

export function controlledReferenceUploadProgress(session: ControlledReferenceUploadSession): {
  uploadedByteSize: number;
  totalByteSize: number;
  progress: number;
  completedParts: number;
} {
  const uploadedByteSize = session.parts.reduce((sum, part) => sum + part.byteSize, 0);
  return {
    uploadedByteSize,
    totalByteSize: session.expectedByteSize,
    progress: Math.min(1, uploadedByteSize / session.expectedByteSize),
    completedParts: session.parts.length,
  };
}

export function controlledReferenceUploadRequestDigest(session: ControlledReferenceUploadSession): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: session.version,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    actorUserId: session.actorUserId,
    mediaType: session.mediaType,
    fileName: session.fileName,
    declaredMimeType: session.declaredMimeType,
    expectedByteSize: session.expectedByteSize,
    expectedSha256: session.expectedSha256,
    storageKey: session.storageKey,
  })).digest("hex");
}
