import { reserveWorkspaceStorage, commitWorkspaceStorage, releaseWorkspaceStorage } from "./workspaceResources";
import { objectWriteProviderIdentity } from "./objectWriteIntent";
import { MembershipError } from "./membershipCatalog";
import { execFile } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Knex } from "knex";
import sharp from "sharp";

import { registerAccountOwnedAssetIfAvailable } from "@/lib/accountWorkspaceAssetLibrary";
import { sanitizeChildProcessEnvironment } from "@/lib/childProcessEnvironment";
import { insertAndReturnId } from "@/lib/dbDialect";
import { createPortraitAdmissionForUpload } from "@/lib/portraitAdmissionStore";
import {
  REFERENCE_MULTIPART_UPLOAD_TABLE,
} from "@/lib/migrations/referenceMultipartUpload";
import {
  createRemoteObjectStorageAdapter,
  type ObjectStorageAdapter,
  type ObjectStorageConditionalDeleteReceipt,
  type ObjectStorageGenerationSnapshot,
  type ObjectStorageMultipartCompletion,
  type ObjectStorageMultipartInitiation,
  type ObjectStorageMultipartPart,
  type ObjectStorageMultipartPartListing,
  type ObjectStorageMultipartPartTarget,
  type ObjectStorageMultipartPartTargetOptions,
} from "@/lib/objectStorage";
import {
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import { openSecret, sealSecret } from "@/lib/secretEnvelope";
import { db } from "@/utils/db";

export const REFERENCE_MULTIPART_PROTOCOL_VERSION =
  "reference-multipart-upload/v1" as const;
export const REFERENCE_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
export const REFERENCE_MULTIPART_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const REFERENCE_MULTIPART_PART_URL_TTL_SECONDS = 10 * 60;
export const MAX_REFERENCE_MULTIPART_BYTES = 2 * 1024 * 1024 * 1024;
export const REFERENCE_MULTIPART_MAX_PARTS = 10_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const execFileAsync = promisify(execFile);

export type ReferenceMultipartMediaType = "image" | "video" | "audio" | "document";
type SessionStatus =
  | "active"
  | "completing"
  | "verifying"
  | "completed"
  | "aborting"
  | "aborted"
  | "failed";

const MIME_DEFINITIONS: Record<string, {
  mediaType: ReferenceMultipartMediaType;
  extension: string;
}> = {
  "application/pdf": { mediaType: "document", extension: "pdf" },
  "text/plain": { mediaType: "document", extension: "txt" },
  "text/markdown": { mediaType: "document", extension: "md" },
  "text/x-markdown": { mediaType: "document", extension: "md" },
  "image/jpeg": { mediaType: "image", extension: "jpg" },
  "image/jpg": { mediaType: "image", extension: "jpg" },
  "image/png": { mediaType: "image", extension: "png" },
  "image/gif": { mediaType: "image", extension: "gif" },
  "image/webp": { mediaType: "image", extension: "webp" },
  "video/mp4": { mediaType: "video", extension: "mp4" },
  "video/webm": { mediaType: "video", extension: "webm" },
  "video/quicktime": { mediaType: "video", extension: "mov" },
  "audio/mpeg": { mediaType: "audio", extension: "mp3" },
  "audio/mp3": { mediaType: "audio", extension: "mp3" },
  "audio/wav": { mediaType: "audio", extension: "wav" },
  "audio/mp4": { mediaType: "audio", extension: "m4a" },
};

export interface ReferenceMultipartStorage {
  initiateMultipartUpload(
    key: string,
    options: { contentType: string },
  ): Promise<ObjectStorageMultipartInitiation>;
  createMultipartPartUploadUrl(
    key: string,
    options: ObjectStorageMultipartPartTargetOptions,
  ): Promise<ObjectStorageMultipartPartTarget>;
  listMultipartParts(
    key: string,
    options: { uploadId: string },
  ): Promise<ObjectStorageMultipartPartListing>;
  completeMultipartUpload(
    key: string,
    options: { uploadId: string; parts: ObjectStorageMultipartPart[] },
  ): Promise<ObjectStorageMultipartCompletion>;
  abortMultipartUpload(
    key: string,
    options: { uploadId: string },
  ): Promise<{ requestId: string }>;
  inspectGeneration(
    key: string,
    options?: { versionId?: string | null; signal?: AbortSignal },
  ): Promise<ObjectStorageGenerationSnapshot>;
  get(
    key: string,
    options?: { versionId?: string | null; signal?: AbortSignal },
  ): Promise<Buffer>;
  getUrl(key: string, options?: { versionId?: string | null }): Promise<string>;
  deleteGenerationIfMatch(
    key: string,
    condition: {
      etag: string | null;
      versionId?: string | null;
      deleteMarker?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ObjectStorageConditionalDeleteReceipt>;
}

export interface ReferenceMultipartUploadDependencies {
  database?: Knex;
  resolveConfiguration?: () => ObjectStorageConfiguration;
  createStorage?: (
    configuration: ObjectStorageConfiguration,
  ) => ReferenceMultipartStorage;
  now?: () => number;
  createId?: () => string;
  randomGrant?: () => string;
  probeMedia?: (
    buffer: Buffer,
    input: {
      mediaType: ReferenceMultipartMediaType;
      mimeType: string;
      fileName: string;
    },
  ) => Promise<Record<string, unknown>>;
}

interface SessionRecord {
  id: string;
  workspaceId: string;
  projectId: number;
  actorUserId: number;
  idempotencyKey: string;
  requestHash: string;
  resumeGrantHash: string;
  uploadIdCiphertext: string;
  storageProvider: "s3" | "tos";
  storageBucket: string;
  storageRegion: string;
  storageEndpoint: string;
  storageKeyPrefix: string;
  storageForcePathStyle: boolean;
  storageKey: string;
  fileName: string;
  mediaType: ReferenceMultipartMediaType;
  declaredMimeType: string;
  declaredByteSize: number;
  declaredSha256: string;
  partSize: number;
  partCount: number;
  providerInitiateRequestId: string;
  status: SessionStatus;
  expiresAt: number;
  completionEtag: string | null;
  completionVersionId: string | null;
  completionRequestId: string | null;
  abortRequestId: string | null;
  assetId: number | null;
  assetVersionId: number | null;
  actualSha256: string | null;
  detectedMimeType: string | null;
  probeJson: string | null;
  errorCode: string | null;
  completedAt: number | null;
  abortedAt: number | null;
  failedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReferenceMultipartAuthorization {
  sessionId: string;
  resumeGrant: string;
  workspaceId: string;
  projectId: number;
  actorUserId: number;
}

export interface ReferenceMultipartStatusResult {
  protocolVersion: typeof REFERENCE_MULTIPART_PROTOCOL_VERSION;
  sessionId: string;
  workspaceId: string;
  projectId: number;
  fileName: string;
  mediaType: ReferenceMultipartMediaType;
  mimeType: string;
  byteSize: number;
  sha256: string;
  partSize: number;
  partCount: number;
  expiresAt: number;
  status: SessionStatus;
  uploadedParts: Array<{ partNumber: number; byteSize: number; etag: string }>;
  uploadedByteSize: number;
  asset: {
    assetId: number;
    assetVersionId: number;
    filePath: string;
    previewUrl: string;
    type: ReferenceMultipartMediaType;
    mimeType: string;
    size: number;
    name: string;
  } | null;
}

export class ReferenceMultipartUploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ReferenceMultipartUploadError";
    this.status = status;
    this.code = code;
  }
}

function failure(message: string, status: number, code: string) {
  return new ReferenceMultipartUploadError(message, status, code);
}

function now(dependencies: ReferenceMultipartUploadDependencies): number {
  const value = (dependencies.now || Date.now)();
  if (!Number.isSafeInteger(value) || value < 1) {
    throw failure("参考素材上传服务暂不可用", 503, "REFERENCE_UPLOAD_UNAVAILABLE");
  }
  return value;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  return SHA256_PATTERN.test(left)
    && SHA256_PATTERN.test(right)
    && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function text(value: unknown, field: string, maximum = 512): string {
  const normalized = String(value ?? "").trim();
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw failure(`${field} 无效`, 400, "REFERENCE_UPLOAD_METADATA_INVALID");
  }
  return normalized;
}

function safeSha256(value: unknown): string {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(digest)) {
    throw failure("文件 SHA-256 无效", 400, "REFERENCE_UPLOAD_SHA256_INVALID");
  }
  return digest;
}

function safeIdempotencyKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!IDEMPOTENCY_PATTERN.test(key)) {
    throw failure("上传幂等键无效", 400, "REFERENCE_UPLOAD_IDEMPOTENCY_KEY_INVALID");
  }
  return key;
}

function safeMime(value: unknown): string {
  const mime = String(value ?? "").trim().toLowerCase().split(";", 1)[0];
  if (!MIME_DEFINITIONS[mime]) {
    throw failure("不支持的参考素材 MIME", 415, "REFERENCE_UPLOAD_MIME_UNSUPPORTED");
  }
  return mime;
}

function safeIdentity(input: {
  workspaceId: unknown;
  projectId: unknown;
  actorUserId: unknown;
}) {
  const workspaceId = text(input.workspaceId, "workspaceId", 255);
  const projectId = Number(input.projectId);
  const actorUserId = Number(input.actorUserId);
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw failure("项目无效", 404, "REFERENCE_UPLOAD_PROJECT_NOT_FOUND");
  }
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw failure("未登录", 401, "REFERENCE_UPLOAD_UNAUTHENTICATED");
  }
  return { workspaceId, projectId, actorUserId };
}

function safeResumeGrant(value: unknown): string {
  const grant = String(value ?? "");
  if (
    grant.length < 32
    || grant.length > 256
    || grant !== grant.trim()
    || /[\u0000-\u001f\u007f]/u.test(grant)
  ) {
    throw failure("上传恢复授权无效", 403, "REFERENCE_UPLOAD_AUTHORIZATION_INVALID");
  }
  return grant;
}

function createGrant(dependencies: ReferenceMultipartUploadDependencies): string {
  return safeResumeGrant(
    dependencies.randomGrant?.() ?? randomBytes(32).toString("base64url"),
  );
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  const nullableText = (value: unknown) => value == null ? null : String(value);
  const nullableNumber = (value: unknown) => value == null ? null : Number(value);
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    actorUserId: Number(row.actorUserId),
    idempotencyKey: String(row.idempotencyKey),
    requestHash: String(row.requestHash),
    resumeGrantHash: String(row.resumeGrantHash),
    uploadIdCiphertext: String(row.uploadIdCiphertext),
    storageProvider: String(row.storageProvider) as "s3" | "tos",
    storageBucket: String(row.storageBucket),
    storageRegion: String(row.storageRegion),
    storageEndpoint: String(row.storageEndpoint),
    storageKeyPrefix: String(row.storageKeyPrefix || ""),
    storageForcePathStyle: Boolean(row.storageForcePathStyle),
    storageKey: String(row.storageKey),
    fileName: String(row.fileName),
    mediaType: String(row.mediaType) as ReferenceMultipartMediaType,
    declaredMimeType: String(row.declaredMimeType),
    declaredByteSize: Number(row.declaredByteSize),
    declaredSha256: String(row.declaredSha256),
    partSize: Number(row.partSize),
    partCount: Number(row.partCount),
    providerInitiateRequestId: String(row.providerInitiateRequestId),
    status: String(row.status) as SessionStatus,
    expiresAt: Number(row.expiresAt),
    completionEtag: nullableText(row.completionEtag),
    completionVersionId: nullableText(row.completionVersionId),
    completionRequestId: nullableText(row.completionRequestId),
    abortRequestId: nullableText(row.abortRequestId),
    assetId: nullableNumber(row.assetId),
    assetVersionId: nullableNumber(row.assetVersionId),
    actualSha256: nullableText(row.actualSha256),
    detectedMimeType: nullableText(row.detectedMimeType),
    probeJson: nullableText(row.probeJson),
    errorCode: nullableText(row.errorCode),
    completedAt: nullableNumber(row.completedAt),
    abortedAt: nullableNumber(row.abortedAt),
    failedAt: nullableNumber(row.failedAt),
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function remoteConfiguration(
  dependencies: ReferenceMultipartUploadDependencies,
): ObjectStorageConfiguration & {
  provider: "s3" | "tos";
  bucket: string;
  region: string;
  endpoint: string;
} {
  let value: ObjectStorageConfiguration;
  try {
    value = dependencies.resolveConfiguration?.()
      ?? resolveObjectStorageConfiguration();
  } catch {
    throw failure(
      "远端参考素材存储未配置",
      503,
      "REFERENCE_UPLOAD_STORAGE_UNAVAILABLE",
    );
  }
  if (
    !["s3", "tos"].includes(value.provider)
    || !value.bucket
    || !value.region
    || !value.endpoint
  ) {
    throw failure(
      "断点续传需要 S3 或 TOS 对象存储",
      503,
      "REFERENCE_UPLOAD_STORAGE_UNSUPPORTED",
    );
  }
  return value as typeof value & {
    provider: "s3" | "tos";
    bucket: string;
    region: string;
    endpoint: string;
  };
}

function storageAdapter(
  configuration: ObjectStorageConfiguration,
  dependencies: ReferenceMultipartUploadDependencies,
): ReferenceMultipartStorage {
  const storage = dependencies.createStorage?.(configuration)
    ?? createRemoteObjectStorageAdapter(configuration);
  for (const method of [
    "initiateMultipartUpload",
    "createMultipartPartUploadUrl",
    "listMultipartParts",
    "completeMultipartUpload",
    "abortMultipartUpload",
    "inspectGeneration",
    "get",
    "getUrl",
    "deleteGenerationIfMatch",
  ] as const) {
    if (typeof (storage as Partial<ObjectStorageAdapter>)[method] !== "function") {
      throw failure(
        "远端存储不支持安全断点续传",
        503,
        "REFERENCE_UPLOAD_STORAGE_UNSUPPORTED",
      );
    }
  }
  return storage as ReferenceMultipartStorage;
}

function uploadIdPurpose(sessionId: string): string {
  return `reference-multipart:${sessionId}:upload-id`;
}

function openUploadId(session: SessionRecord): string {
  try {
    return text(
      openSecret(session.uploadIdCiphertext, uploadIdPurpose(session.id)),
      "uploadId",
      512,
    );
  } catch {
    throw failure(
      "上传会话无法恢复",
      503,
      "REFERENCE_UPLOAD_SESSION_UNRECOVERABLE",
    );
  }
}

function configurationMatches(
  session: SessionRecord,
  configuration: ObjectStorageConfiguration,
): boolean {
  return session.storageProvider === configuration.provider
    && session.storageBucket === configuration.bucket
    && session.storageRegion === configuration.region
    && session.storageEndpoint === configuration.endpoint
    && session.storageKeyPrefix === configuration.keyPrefix
    && session.storageForcePathStyle === configuration.forcePathStyle;
}

function expectedPartSize(session: SessionRecord, partNumber: number): number {
  if (
    !Number.isSafeInteger(partNumber)
    || partNumber < 1
    || partNumber > session.partCount
  ) {
    throw failure("分片编号无效", 400, "REFERENCE_UPLOAD_PART_NUMBER_INVALID");
  }
  return partNumber === session.partCount
    ? session.declaredByteSize - session.partSize * (session.partCount - 1)
    : session.partSize;
}

function validEtag(value: unknown): value is string {
  const etag = String(value ?? "");
  return Boolean(etag)
    && etag.length <= 512
    && etag === etag.trim()
    && !/[\u0000-\u001f\u007f]/u.test(etag);
}

function verifiedParts(
  listing: ObjectStorageMultipartPartListing,
  session: SessionRecord,
): ObjectStorageMultipartPart[] {
  if (!Array.isArray(listing.parts) || listing.parts.length > session.partCount) {
    throw failure(
      "对象存储返回的分片清单无效",
      502,
      "REFERENCE_UPLOAD_PROVIDER_PARTS_INVALID",
    );
  }
  let previous = 0;
  const seen = new Set<number>();
  for (const part of listing.parts) {
    if (
      !Number.isSafeInteger(part.partNumber)
      || part.partNumber <= previous
      || seen.has(part.partNumber)
      || part.size !== expectedPartSize(session, part.partNumber)
      || !validEtag(part.etag)
      || !String(part.lastModified || "").trim()
      || Number.isNaN(Date.parse(part.lastModified))
    ) {
      throw failure(
        "对象存储返回的分片清单无效",
        502,
        "REFERENCE_UPLOAD_PROVIDER_PARTS_INVALID",
      );
    }
    previous = part.partNumber;
    seen.add(part.partNumber);
  }
  return listing.parts;
}

function requestDigest(input: {
  workspaceId: string;
  projectId: number;
  actorUserId: number;
  idempotencyKey: string;
  fileName: string;
  mediaType: ReferenceMultipartMediaType;
  mimeType: string;
  byteSize: number;
  sha256: string;
}): string {
  return sha256Text(JSON.stringify({
    protocolVersion: REFERENCE_MULTIPART_PROTOCOL_VERSION,
    ...input,
  }));
}

async function assertProjectScope(
  database: Knex,
  identity: { workspaceId: string; projectId: number },
): Promise<void> {
  const project = await database("o_project")
    .where({ id: identity.projectId, workspaceId: identity.workspaceId })
    .select("id")
    .first();
  if (!project) {
    throw failure("项目不存在", 404, "REFERENCE_UPLOAD_PROJECT_NOT_FOUND");
  }
}

async function authorizedSession(
  input: ReferenceMultipartAuthorization,
  dependencies: ReferenceMultipartUploadDependencies,
): Promise<{ session: SessionRecord; database: Knex; now: number }> {
  const identity = safeIdentity(input);
  const sessionId = String(input.sessionId || "").trim();
  if (!UUID_PATTERN.test(sessionId)) {
    throw failure("上传会话不存在", 404, "REFERENCE_UPLOAD_SESSION_NOT_FOUND");
  }
  const grant = safeResumeGrant(input.resumeGrant);
  const database = dependencies.database || (db as unknown as Knex);
  const row = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
    .where({
      id: sessionId,
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      actorUserId: identity.actorUserId,
    })
    .first();
  if (!row) {
    throw failure("上传会话不存在", 404, "REFERENCE_UPLOAD_SESSION_NOT_FOUND");
  }
  const session = mapSession(row as Record<string, unknown>);
  if (!sameHash(session.resumeGrantHash, sha256Text(grant))) {
    throw failure("上传恢复授权无效", 403, "REFERENCE_UPLOAD_AUTHORIZATION_INVALID");
  }
  const currentTime = now(dependencies);
  if (
    !["completed", "aborted", "failed"].includes(session.status)
    && session.expiresAt <= currentTime
  ) {
    throw failure("上传会话已过期", 410, "REFERENCE_UPLOAD_SESSION_EXPIRED");
  }
  return { session, database, now: currentTime };
}

async function sessionContext(
  session: SessionRecord,
  dependencies: ReferenceMultipartUploadDependencies,
) {
  const configuration = remoteConfiguration(dependencies);
  if (!configurationMatches(session, configuration)) {
    throw failure(
      "上传会话绑定的对象存储身份已变化",
      409,
      "REFERENCE_UPLOAD_STORAGE_IDENTITY_CHANGED",
    );
  }
  return {
    storage: storageAdapter(configuration, dependencies),
    uploadId: openUploadId(session),
  };
}

function hasPrefix(data: Buffer, bytes: number[]): boolean {
  return bytes.every((value, index) => data[index] === value);
}

function hasAscii(data: Buffer, offset: number, value: string): boolean {
  return data.length >= offset + value.length
    && data.subarray(offset, offset + value.length).toString("ascii") === value;
}

export function referenceMagicMatchesMime(mime: string, data: Buffer): boolean {
  switch (mime) {
    case "application/pdf": return hasAscii(data, 0, "%PDF-");
    case "text/plain":
    case "text/markdown":
    case "text/x-markdown":
      if (data.includes(0)) return false;
      try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; } catch { return false; }
    case "application/pdf": return hasAscii(data, 0, "%PDF-");
    case "text/plain":
    case "text/markdown":
    case "text/x-markdown":
      if (data.includes(0)) return false;
      try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; } catch { return false; }
    case "image/jpeg":
    case "image/jpg":
      return hasPrefix(data, [0xff, 0xd8, 0xff]);
    case "image/png":
      return hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return hasAscii(data, 0, "GIF87a") || hasAscii(data, 0, "GIF89a");
    case "image/webp":
      return hasAscii(data, 0, "RIFF") && hasAscii(data, 8, "WEBP");
    case "video/mp4":
    case "video/quicktime":
    case "audio/mp4":
      return hasAscii(data, 4, "ftyp");
    case "video/webm":
      return hasPrefix(data, [0x1a, 0x45, 0xdf, 0xa3]);
    case "audio/mpeg":
    case "audio/mp3":
      return hasAscii(data, 0, "ID3")
        || (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
    case "audio/wav":
      return hasAscii(data, 0, "RIFF") && hasAscii(data, 8, "WAVE");
    default:
      return false;
  }
}

async function defaultProbeMedia(
  buffer: Buffer,
  input: {
    mediaType: ReferenceMultipartMediaType;
    mimeType: string;
    fileName: string;
  },
): Promise<Record<string, unknown>> {
  if (input.mediaType === "document") return { kind: "document", mimeType: input.mimeType, sizeBytes: buffer.byteLength };
  if (input.mediaType === "image") {
    const metadata = await sharp(buffer, { failOn: "error" }).metadata();
    if (
      !Number.isSafeInteger(metadata.width)
      || Number(metadata.width) < 1
      || !Number.isSafeInteger(metadata.height)
      || Number(metadata.height) < 1
      || !metadata.format
    ) {
      throw failure("图片媒体探测失败", 415, "REFERENCE_UPLOAD_MEDIA_PROBE_FAILED");
    }
    return {
      kind: "image",
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
  }

  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "fanjin-reference-probe-"),
  );
  const filePath = path.join(directory, `upload.${MIME_DEFINITIONS[input.mimeType].extension}`);
  try {
    await fs.promises.writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
    const ffprobePath = String(process.env.FANJIN_FFPROBE_PATH || "ffprobe").trim() || "ffprobe";
    const timeout = Number(process.env.FANJIN_FFPROBE_TIMEOUT_MS || 15_000);
    const result = await execFileAsync(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height,duration:format=duration,size",
      "-of",
      "json",
      filePath,
    ], {
      env: sanitizeChildProcessEnvironment(),
      timeout: Number.isSafeInteger(timeout) && timeout >= 1_000 ? timeout : 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const expectedStream = streams.find((value) => value
      && typeof value === "object"
      && String((value as Record<string, unknown>).codec_type || "") === input.mediaType);
    if (!expectedStream) {
      throw failure("媒体轨道类型与声明不匹配", 415, "REFERENCE_UPLOAD_MEDIA_PROBE_FAILED");
    }
    const stream = expectedStream as Record<string, unknown>;
    const format = parsed.format && typeof parsed.format === "object"
      ? parsed.format as Record<string, unknown>
      : {};
    const durationSeconds = Number(stream.duration ?? format.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw failure("媒体时长无效", 415, "REFERENCE_UPLOAD_MEDIA_PROBE_FAILED");
    }
    const probe: Record<string, unknown> = {
      kind: input.mediaType,
      codec: text(stream.codec_name, "codec", 128),
      durationMs: Math.round(durationSeconds * 1_000),
    };
    if (input.mediaType === "video") {
      const width = Number(stream.width);
      const height = Number(stream.height);
      if (
        !Number.isSafeInteger(width)
        || width < 1
        || !Number.isSafeInteger(height)
        || height < 1
      ) {
        throw failure("视频尺寸无效", 415, "REFERENCE_UPLOAD_MEDIA_PROBE_FAILED");
      }
      probe.width = width;
      probe.height = height;
    }
    return probe;
  } catch (error) {
    if (error instanceof ReferenceMultipartUploadError) throw error;
    throw failure("媒体探测失败", 415, "REFERENCE_UPLOAD_MEDIA_PROBE_FAILED");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function statusResult(
  session: SessionRecord,
  _storage: ReferenceMultipartStorage,
  parts: ObjectStorageMultipartPart[],
): Promise<ReferenceMultipartStatusResult> {
  const asset = session.status === "completed"
    && session.assetId
    && session.assetVersionId
    ? {
        assetId: session.assetId,
        assetVersionId: session.assetVersionId,
        filePath: `/${session.storageKey}`,
        // Keep the preview address stable across page reloads and restored
        // creation sessions. Provider-signed object URLs are intentionally
        // short-lived and may also be blocked by browser CORS policy; the
        // authenticated delivery route enforces workspace/project access and
        // supports byte ranges for video/audio previews.
        previewUrl: `/api/assets/getReferenceFile?id=${session.assetId}&disposition=inline`,
        type: session.mediaType,
        mimeType: session.detectedMimeType || session.declaredMimeType,
        size: session.declaredByteSize,
        name: session.fileName,
      }
    : null;
  return {
    protocolVersion: REFERENCE_MULTIPART_PROTOCOL_VERSION,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    fileName: session.fileName,
    mediaType: session.mediaType,
    mimeType: session.declaredMimeType,
    byteSize: session.declaredByteSize,
    sha256: session.declaredSha256,
    partSize: session.partSize,
    partCount: session.partCount,
    expiresAt: session.expiresAt,
    status: session.status,
    uploadedParts: parts.map((part) => ({
      partNumber: part.partNumber,
      byteSize: part.size,
      etag: part.etag,
    })),
    uploadedByteSize: parts.reduce((total, part) => total + part.size, 0),
    asset,
  };
}

export async function initReferenceMultipartUpload(
  input: {
    workspaceId: string;
    projectId: number;
    actorUserId: number;
    idempotencyKey: string;
    fileName: string;
    mediaType: ReferenceMultipartMediaType;
    mimeType: string;
    byteSize: number;
    sha256: string;
  },
  dependencies: ReferenceMultipartUploadDependencies = {},
): Promise<ReferenceMultipartStatusResult & {
  resumeGrant: string;
  idempotent: boolean;
}> {
  const identity = safeIdentity(input);
  const idempotencyKey = safeIdempotencyKey(input.idempotencyKey);
  const fileName = text(input.fileName, "文件名", 255);
  if (input.mediaType === "document" && input.byteSize > 20 * 1024 * 1024) {
    throw failure("文档最大 20MB", 413, "REFERENCE_UPLOAD_SIZE_INVALID");
  }
  const mimeType = safeMime(input.mimeType);
  const definition = MIME_DEFINITIONS[mimeType];
  if (definition.mediaType !== input.mediaType) {
    throw failure("文件类型与 MIME 不匹配", 400, "REFERENCE_UPLOAD_MEDIA_TYPE_MISMATCH");
  }
  const byteSize = Number(input.byteSize);
  if (
    !Number.isSafeInteger(byteSize)
    || byteSize < 1
    || byteSize > MAX_REFERENCE_MULTIPART_BYTES
  ) {
    throw failure("文件大小无效", byteSize > MAX_REFERENCE_MULTIPART_BYTES ? 413 : 400, "REFERENCE_UPLOAD_SIZE_INVALID");
  }
  const declaredSha256 = safeSha256(input.sha256);
  const normalized = {
    ...identity,
    idempotencyKey,
    fileName,
    mediaType: input.mediaType,
    mimeType,
    byteSize,
    sha256: declaredSha256,
  };
  const digest = requestDigest(normalized);
  const database = dependencies.database || (db as unknown as Knex);
  await assertProjectScope(database, identity);
  const configuration = remoteConfiguration(dependencies);
  const storage = storageAdapter(configuration, dependencies);
  const resumeGrant = createGrant(dependencies);
  const currentTime = now(dependencies);

  const existingRow = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
    .where({
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      actorUserId: identity.actorUserId,
      idempotencyKey,
    })
    .first();
  if (existingRow) {
    const existing = mapSession(existingRow as Record<string, unknown>);
    if (existing.requestHash !== digest) {
      throw failure("上传幂等键已绑定其他文件", 409, "REFERENCE_UPLOAD_REPLAY_CONFLICT");
    }
    if (existing.expiresAt <= currentTime && !["completed", "aborted", "failed"].includes(existing.status)) {
      throw failure("上传会话已过期", 410, "REFERENCE_UPLOAD_SESSION_EXPIRED");
    }
    if (!["active", "completing", "verifying", "completed"].includes(existing.status)) {
      throw failure("上传会话不可恢复", 409, "REFERENCE_UPLOAD_SESSION_NOT_RESUMABLE");
    }
    const changed = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
      .where({ id: existing.id, revision: existing.revision })
      .update({
        resumeGrantHash: sha256Text(resumeGrant),
        revision: existing.revision + 1,
        updatedAt: currentTime,
      });
    if (changed !== 1) {
      throw failure("上传会话正在变化", 409, "REFERENCE_UPLOAD_STATE_CONFLICT");
    }
    const rotated = {
      ...existing,
      resumeGrantHash: sha256Text(resumeGrant),
      revision: existing.revision + 1,
      updatedAt: currentTime,
    };
    const context = await sessionContext(rotated, dependencies);
    const parts = rotated.status === "active"
      ? verifiedParts(await context.storage.listMultipartParts(
          rotated.storageKey,
          { uploadId: context.uploadId },
        ), rotated)
      : [];
    return {
      ...await statusResult(rotated, context.storage, parts),
      resumeGrant,
      idempotent: true,
    };
  }

  const sessionId = (dependencies.createId || randomUUID)();
  if (!UUID_PATTERN.test(sessionId)) {
    throw failure("参考素材上传服务暂不可用", 503, "REFERENCE_UPLOAD_UNAVAILABLE");
  }
  const partCount = Math.ceil(byteSize / REFERENCE_MULTIPART_PART_SIZE);
  if (partCount < 1 || partCount > REFERENCE_MULTIPART_MAX_PARTS) {
    throw failure("文件分片数量超过上限", 413, "REFERENCE_UPLOAD_PART_COUNT_INVALID");
  }
  const storageKey = [
    "workspaces",
    encodeURIComponent(identity.workspaceId),
    "projects",
    String(identity.projectId),
    "references",
    sessionId,
    `source.${definition.extension}`,
  ].join("/");
  let initiated: ObjectStorageMultipartInitiation | null = null;
  try {
    await database.transaction(trx => reserveWorkspaceStorage(trx, { id: `multipart:${sessionId}`, workspaceId: identity.workspaceId,
      objectKey: storageKey, providerFingerprint: objectWriteProviderIdentity(configuration).providerFingerprint, bytes: byteSize }));
    initiated = await storage.initiateMultipartUpload(storageKey, {
      contentType: mimeType,
    });
    const expiresAt = currentTime + REFERENCE_MULTIPART_SESSION_TTL_SECONDS * 1_000;
    const row: SessionRecord = {
      id: sessionId,
      ...identity,
      idempotencyKey,
      requestHash: digest,
      resumeGrantHash: sha256Text(resumeGrant),
      uploadIdCiphertext: sealSecret(initiated.uploadId, uploadIdPurpose(sessionId)),
      storageProvider: configuration.provider,
      storageBucket: configuration.bucket,
      storageRegion: configuration.region,
      storageEndpoint: configuration.endpoint,
      storageKeyPrefix: configuration.keyPrefix,
      storageForcePathStyle: configuration.forcePathStyle,
      storageKey,
      fileName,
      mediaType: input.mediaType,
      declaredMimeType: mimeType,
      declaredByteSize: byteSize,
      declaredSha256,
      partSize: REFERENCE_MULTIPART_PART_SIZE,
      partCount,
      providerInitiateRequestId: initiated.requestId,
      status: "active",
      expiresAt,
      completionEtag: null,
      completionVersionId: null,
      completionRequestId: null,
      abortRequestId: null,
      assetId: null,
      assetVersionId: null,
      actualSha256: null,
      detectedMimeType: null,
      probeJson: null,
      errorCode: null,
      completedAt: null,
      abortedAt: null,
      failedAt: null,
      revision: 1,
      createdAt: currentTime,
      updatedAt: currentTime,
    };
    await database(REFERENCE_MULTIPART_UPLOAD_TABLE).insert(row);
    return {
      ...await statusResult(row, storage, []),
      resumeGrant,
      idempotent: false,
    };
  } catch (error) {
    if (initiated) {
      await storage.abortMultipartUpload(storageKey, {
        uploadId: initiated.uploadId,
      }).then(async receipt => {
        await database(REFERENCE_MULTIPART_UPLOAD_TABLE).where({ id: sessionId }).update({ status: "failed", errorCode: "REFERENCE_UPLOAD_INIT_FAILED", updatedAt: now(dependencies) });
        await releaseWorkspaceStorage(database, `multipart:${sessionId}`, { reason: "init_aborted", requestId: receipt.requestId });
      }).catch(() => undefined);
    }
    if (!initiated) await releaseWorkspaceStorage(database, `multipart:${sessionId}`, { reason: "no_part_urls_issued" });
    if (error instanceof MembershipError) throw failure(error.message, error.status, error.code);
    if (error instanceof ReferenceMultipartUploadError) throw error;
    throw failure("参考素材上传会话创建失败", 503, "REFERENCE_UPLOAD_INIT_FAILED");
  }
}

export async function getReferenceMultipartUploadStatus(
  input: ReferenceMultipartAuthorization,
  dependencies: ReferenceMultipartUploadDependencies = {},
): Promise<ReferenceMultipartStatusResult> {
  const { session } = await authorizedSession(input, dependencies);
  const context = await sessionContext(session, dependencies);
  const parts = session.status === "active"
    ? verifiedParts(await context.storage.listMultipartParts(
        session.storageKey,
        { uploadId: context.uploadId },
      ), session)
    : [];
  return statusResult(session, context.storage, parts);
}

export async function createReferenceMultipartPartTarget(
  input: ReferenceMultipartAuthorization & { partNumber: number },
  dependencies: ReferenceMultipartUploadDependencies = {},
): Promise<{
  sessionId: string;
  partNumber: number;
  byteOffset: number;
  byteSize: number;
  url: string;
  method: "PUT";
  expiresAt: number;
  requiredHeaders: Record<string, never>;
}> {
  const { session, now: currentTime } = await authorizedSession(input, dependencies);
  if (session.status !== "active") {
    throw failure("上传会话不能接收分片", 409, "REFERENCE_UPLOAD_SESSION_NOT_ACTIVE");
  }
  const context = await sessionContext(session, dependencies);
  const partNumber = Number(input.partNumber);
  const byteSize = expectedPartSize(session, partNumber);
  const target = await context.storage.createMultipartPartUploadUrl(
    session.storageKey,
    {
      uploadId: context.uploadId,
      partNumber,
      contentLength: byteSize,
      expiresInSeconds: REFERENCE_MULTIPART_PART_URL_TTL_SECONDS,
    },
  );
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw failure("对象存储返回无效上传地址", 502, "REFERENCE_UPLOAD_PART_TARGET_INVALID");
  }
  if (
    target.method !== "PUT"
    || url.protocol !== "https:"
    || url.username
    || url.password
    || !Number.isSafeInteger(target.expiresAt)
    || target.expiresAt <= currentTime
    || Object.keys(target.requiredHeaders || {}).length > 0
  ) {
    throw failure("对象存储返回无效上传地址", 502, "REFERENCE_UPLOAD_PART_TARGET_INVALID");
  }
  return {
    sessionId: session.id,
    partNumber,
    byteOffset: (partNumber - 1) * session.partSize,
    byteSize,
    url: target.url,
    method: "PUT",
    expiresAt: Math.min(target.expiresAt, session.expiresAt),
    requiredHeaders: {},
  };
}

async function markFailed(
  database: Knex,
  session: SessionRecord,
  errorCode: string,
  failedAt: number,
): Promise<boolean> {
  const changed = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
    .where({ id: session.id, revision: session.revision })
    .whereIn("status", ["completing", "verifying"])
    .update({
      status: "failed",
      errorCode,
      failedAt,
      revision: session.revision + 1,
      updatedAt: failedAt,
    });
  return changed === 1;
}

async function compensateCompletedObject(
  storage: ReferenceMultipartStorage,
  session: SessionRecord,
  completion: ObjectStorageMultipartCompletion,
  resourceDatabase: Knex,
): Promise<void> {
  await storage.deleteGenerationIfMatch(session.storageKey, {
    etag: completion.etag,
    versionId: completion.versionId,
    deleteMarker: false,
  });
  await releaseWorkspaceStorage(resourceDatabase, `multipart:${session.id}`, { reason: "invalid_upload_deleted", versionId: completion.versionId });
}

async function compensateSnapshotIfBound(
  resourceDatabase: Knex,
  storage: ReferenceMultipartStorage,
  session: SessionRecord,
  snapshot: ObjectStorageGenerationSnapshot,
): Promise<void> {
  if (
    snapshot.provider !== session.storageProvider
    || snapshot.bucket !== session.storageBucket
    || snapshot.key !== session.storageKey
    || !snapshot.exists
    || snapshot.deleteMarker
    || !validEtag(snapshot.etag)
  ) return;
  await storage.deleteGenerationIfMatch(session.storageKey, {
    etag: snapshot.etag,
    versionId: snapshot.versionId,
    deleteMarker: false,
  });
  await releaseWorkspaceStorage(resourceDatabase, `multipart:${session.id}`, { reason: "invalid_snapshot_deleted", versionId: snapshot.versionId });
}

function completionFromSnapshot(
  session: SessionRecord,
  snapshot: ObjectStorageGenerationSnapshot,
): ObjectStorageMultipartCompletion | null {
  if (
    snapshot.provider !== session.storageProvider
    || snapshot.bucket !== session.storageBucket
    || snapshot.key !== session.storageKey
    || !snapshot.exists
    || snapshot.deleteMarker
    || snapshot.size !== session.declaredByteSize
    || snapshot.contentType?.toLowerCase() !== session.declaredMimeType
    || !validEtag(snapshot.etag)
    || !validEvidenceText(snapshot.requestId)
  ) return null;
  return normalizedCompletion({
    etag: snapshot.etag,
    versionId: snapshot.versionId,
    requestId: snapshot.requestId,
  });
}

function validEvidenceText(value: unknown, maximum = 512): value is string {
  const normalized = String(value ?? "");
  return Boolean(normalized)
    && normalized.length <= maximum
    && normalized === normalized.trim()
    && !/[\u0000-\u001f\u007f]/u.test(normalized);
}

function normalizedCompletion(
  value: ObjectStorageMultipartCompletion,
): ObjectStorageMultipartCompletion | null {
  const versionId = value.versionId == null ? null : String(value.versionId);
  if (
    !validEtag(value.etag)
    || !validEvidenceText(value.requestId)
    || (versionId !== null && !validEvidenceText(versionId, 4_096))
  ) return null;
  return {
    etag: value.etag,
    versionId,
    requestId: value.requestId,
  };
}

function completionFromSession(
  session: SessionRecord,
): ObjectStorageMultipartCompletion | null {
  if (
    !validEtag(session.completionEtag)
    || !validEvidenceText(session.completionRequestId)
    || (
      session.completionVersionId !== null
      && !validEvidenceText(session.completionVersionId, 4_096)
    )
  ) return null;
  return {
    etag: session.completionEtag,
    versionId: session.completionVersionId,
    requestId: session.completionRequestId,
  };
}

function sessionHasCompletion(
  session: SessionRecord,
  completion: ObjectStorageMultipartCompletion,
): boolean {
  return session.status === "completed"
    && session.completionEtag === completion.etag
    && (session.completionVersionId ?? null) === (completion.versionId ?? null)
    && Boolean(session.assetId)
    && Boolean(session.assetVersionId);
}

function completeParts(
  listing: ObjectStorageMultipartPartListing,
  session: SessionRecord,
): ObjectStorageMultipartPart[] {
  const parts = verifiedParts(listing, session);
  if (
    parts.length !== session.partCount
    || parts.some((part, index) => part.partNumber !== index + 1)
  ) {
    throw failure("上传分片存在缺口", 409, "REFERENCE_UPLOAD_PARTS_INCOMPLETE");
  }
  return parts;
}

async function reloadSession(
  database: Knex,
  expected: SessionRecord,
): Promise<SessionRecord> {
  const row = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
    .where({
      id: expected.id,
      workspaceId: expected.workspaceId,
      projectId: expected.projectId,
      actorUserId: expected.actorUserId,
    })
    .first();
  if (!row) {
    throw failure("上传会话不存在", 404, "REFERENCE_UPLOAD_SESSION_NOT_FOUND");
  }
  const current = mapSession(row as Record<string, unknown>);
  await assertProjectScope(database, current);
  return current;
}

async function persistVerifying(
  database: Knex,
  session: SessionRecord,
  completion: ObjectStorageMultipartCompletion,
  updatedAt: number,
): Promise<SessionRecord | null> {
  const changed = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
    .where({ id: session.id, status: "completing", revision: session.revision })
    .update({
      status: "verifying",
      completionEtag: completion.etag,
      completionVersionId: completion.versionId,
      completionRequestId: completion.requestId,
      revision: session.revision + 1,
      updatedAt,
    });
  return changed === 1
    ? {
        ...session,
        status: "verifying",
        completionEtag: completion.etag,
        completionVersionId: completion.versionId,
        completionRequestId: completion.requestId,
        revision: session.revision + 1,
        updatedAt,
      }
    : null;
}

async function inspectForRecovery(
  storage: ReferenceMultipartStorage,
  session: SessionRecord,
): Promise<ObjectStorageGenerationSnapshot> {
  try {
    return await storage.inspectGeneration(session.storageKey);
  } catch {
    // A failed HEAD is not absence evidence. Keep the durable completing state
    // so a later authenticated retry can reconcile without duplicating data.
    throw failure(
      "对象存储完成状态暂时无法确认",
      503,
      "REFERENCE_UPLOAD_COMPLETION_RECOVERY_PENDING",
    );
  }
}

export async function completeReferenceMultipartUpload(
  input: ReferenceMultipartAuthorization,
  dependencies: ReferenceMultipartUploadDependencies = {},
): Promise<ReferenceMultipartStatusResult & { idempotent: boolean }> {
  const authorized = await authorizedSession(input, dependencies);
  let { session } = authorized;
  const { database } = authorized;
  const context = await sessionContext(session, dependencies);
  const initiallyActive = session.status === "active";
  let parts: ObjectStorageMultipartPart[] = [];
  let completion: ObjectStorageMultipartCompletion | null = null;

  // A durable state machine makes every post-authentication completion retry
  // safe across process/browser restarts. In particular, never interpret a
  // failed provider HEAD as proof that the completed object is absent.
  for (let transition = 0; transition < 8; transition += 1) {
    if (session.status === "completed") {
      return {
        ...await statusResult(session, context.storage, []),
        idempotent: true,
      };
    }

    if (session.status === "verifying") {
      completion = completionFromSession(session);
      if (!completion) {
        await markFailed(
          database,
          session,
          "REFERENCE_UPLOAD_COMPLETION_EVIDENCE_INVALID",
          now(dependencies),
        );
        throw failure(
          "上传完成证据无效",
          500,
          "REFERENCE_UPLOAD_COMPLETION_EVIDENCE_INVALID",
        );
      }
      break;
    }

    if (session.status === "completing") {
      const snapshot = await inspectForRecovery(context.storage, session);
      const reconciled = completionFromSnapshot(session, snapshot);
      if (reconciled) {
        const verifying = await persistVerifying(
          database,
          session,
          reconciled,
          now(dependencies),
        );
        if (verifying) {
          session = verifying;
          completion = reconciled;
          break;
        }
        session = await reloadSession(database, session);
        continue;
      }

      if (snapshot.exists || snapshot.deleteMarker) {
        const failed = await markFailed(
          database,
          session,
          "REFERENCE_UPLOAD_COMPLETION_EVIDENCE_INVALID",
          now(dependencies),
        );
        if (failed) {
          await compensateSnapshotIfBound(database, context.storage, session, snapshot)
            .catch(() => undefined);
        }
        throw failure(
          "对象存储中的完成证据与上传会话不一致",
          422,
          "REFERENCE_UPLOAD_COMPLETION_EVIDENCE_INVALID",
        );
      }

      // The process may have stopped after the active->completing claim but
      // before calling CompleteMultipartUpload. Provider ListParts is the only
      // evidence that permits moving this session back to active.
      let recoveryParts: ObjectStorageMultipartPart[];
      try {
        recoveryParts = completeParts(
          await context.storage.listMultipartParts(
            session.storageKey,
            { uploadId: context.uploadId },
          ),
          session,
        );
      } catch (error) {
        if (error instanceof ReferenceMultipartUploadError) throw error;
        throw failure(
          "对象存储完成状态暂时无法恢复",
          503,
          "REFERENCE_UPLOAD_COMPLETION_RECOVERY_PENDING",
        );
      }
      const resetAt = now(dependencies);
      const reset = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
        .where({ id: session.id, status: "completing", revision: session.revision })
        .andWhere("expiresAt", ">", resetAt)
        .update({
          status: "active",
          revision: session.revision + 1,
          updatedAt: resetAt,
        });
      if (reset !== 1) {
        session = await reloadSession(database, session);
        continue;
      }
      parts = recoveryParts;
      session = {
        ...session,
        status: "active",
        revision: session.revision + 1,
        updatedAt: resetAt,
      };
      continue;
    }

    if (session.status !== "active") {
      throw failure("上传会话不能完成", 409, "REFERENCE_UPLOAD_SESSION_NOT_ACTIVE");
    }

    if (parts.length === 0) {
      parts = completeParts(
        await context.storage.listMultipartParts(
          session.storageKey,
          { uploadId: context.uploadId },
        ),
        session,
      );
    }
    const claimedAt = now(dependencies);
    const claimed = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
      .where({ id: session.id, status: "active", revision: session.revision })
      .andWhere("expiresAt", ">", claimedAt)
      .update({
        status: "completing",
        revision: session.revision + 1,
        updatedAt: claimedAt,
      });
    if (claimed !== 1) {
      session = await reloadSession(database, session);
      continue;
    }
    session = {
      ...session,
      status: "completing",
      revision: session.revision + 1,
      updatedAt: claimedAt,
    };

    try {
      const providerCompletion = await context.storage.completeMultipartUpload(
        session.storageKey,
        { uploadId: context.uploadId, parts },
      );
      completion = normalizedCompletion(providerCompletion);
      if (!completion) {
        throw failure(
          "对象存储返回的完成证据无效",
          502,
          "REFERENCE_UPLOAD_COMPLETION_EVIDENCE_INVALID",
        );
      }
    } catch {
      const snapshot = await inspectForRecovery(context.storage, session);
      completion = completionFromSnapshot(session, snapshot);
      if (!completion) {
        if (snapshot.exists || snapshot.deleteMarker) {
          const failed = await markFailed(
            database,
            session,
            "REFERENCE_UPLOAD_COMPLETION_EVIDENCE_INVALID",
            now(dependencies),
          );
          if (failed) {
            await compensateSnapshotIfBound(database, context.storage, session, snapshot)
              .catch(() => undefined);
          }
          throw failure(
            "对象存储中的完成证据与上传会话不一致",
            422,
            "REFERENCE_UPLOAD_COMPLETION_EVIDENCE_INVALID",
          );
        }
        const resetAt = now(dependencies);
        const reset = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
          .where({ id: session.id, status: "completing", revision: session.revision })
          .update({
            status: "active",
            revision: session.revision + 1,
            updatedAt: resetAt,
          });
        if (reset !== 1) {
          session = await reloadSession(database, session);
          parts = [];
          continue;
        }
        throw failure("对象存储完成分片失败", 503, "REFERENCE_UPLOAD_COMPLETE_FAILED");
      }
    }

    const verifying = await persistVerifying(
      database,
      session,
      completion,
      now(dependencies),
    );
    if (verifying) {
      session = verifying;
      break;
    }
    session = await reloadSession(database, session);
    completion = null;
  }

  if (session.status !== "verifying" || !completion) {
    throw failure("上传会话完成状态冲突", 409, "REFERENCE_UPLOAD_STATE_CONFLICT");
  }

  let body: Buffer;
  let probe: Record<string, unknown>;
  let actualSha256: string;
  try {
    const snapshot = await context.storage.inspectGeneration(session.storageKey, {
      versionId: completion.versionId,
    });
    if (completionFromSnapshot(session, snapshot)?.etag !== completion.etag
      || (snapshot.versionId ?? null) !== (completion.versionId ?? null)) {
      throw failure("对象完整性证据不一致", 422, "REFERENCE_UPLOAD_HEAD_MISMATCH");
    }
    body = await context.storage.get(session.storageKey, {
      versionId: completion.versionId,
    });
    const afterRead = await context.storage.inspectGeneration(session.storageKey, {
      versionId: completion.versionId,
    });
    if (completionFromSnapshot(session, afterRead)?.etag !== completion.etag
      || (afterRead.versionId ?? null) !== (completion.versionId ?? null)) {
      throw failure("对象在完整性校验期间发生变化", 422, "REFERENCE_UPLOAD_HEAD_MISMATCH");
    }
    actualSha256 = sha256Buffer(body);
    if (
      body.byteLength !== session.declaredByteSize
      || !sameHash(actualSha256, session.declaredSha256)
    ) {
      throw failure("文件完整性校验失败", 422, "REFERENCE_UPLOAD_DIGEST_MISMATCH");
    }
    if (!referenceMagicMatchesMime(session.declaredMimeType, body)) {
      throw failure("文件内容与 MIME 不匹配", 415, "REFERENCE_UPLOAD_MAGIC_MISMATCH");
    }
    probe = await (dependencies.probeMedia || defaultProbeMedia)(body, {
      mediaType: session.mediaType,
      mimeType: session.declaredMimeType,
      fileName: session.fileName,
    });
    if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
      throw failure("媒体探测失败", 415, "REFERENCE_UPLOAD_MEDIA_PROBE_FAILED");
    }
  } catch (error) {
    const uploadError = error instanceof ReferenceMultipartUploadError
      ? error
      : failure("上传文件校验失败", 422, "REFERENCE_UPLOAD_VERIFICATION_FAILED");
    const failed = await markFailed(
      database,
      session,
      uploadError.code,
      now(dependencies),
    );
    if (failed) {
      await compensateCompletedObject(context.storage, session, completion, database)
        .catch(() => undefined);
      throw uploadError;
    }
    const latest = await reloadSession(database, session);
    if (sessionHasCompletion(latest, completion)) {
      return {
        ...await statusResult(latest, context.storage, []),
        idempotent: true,
      };
    }
    throw uploadError;
  }

  try {
    const completedAt = now(dependencies);
    const completed = await database.transaction(async (trx) => {
      const lockedRow = await trx(REFERENCE_MULTIPART_UPLOAD_TABLE)
        .where({ id: session.id })
        .forUpdate()
        .first();
      if (!lockedRow) {
        throw failure("上传会话不存在", 404, "REFERENCE_UPLOAD_SESSION_NOT_FOUND");
      }
      const locked = mapSession(lockedRow as Record<string, unknown>);
      if (locked.status !== "verifying" || locked.revision !== session.revision) {
        throw failure("上传会话完成状态冲突", 409, "REFERENCE_UPLOAD_STATE_CONFLICT");
      }
      await assertProjectScope(trx, locked);
      const assetId = await insertAndReturnId(trx, "o_assets", {
        type: locked.mediaType,
        projectId: locked.projectId,
        name: locked.fileName,
        startTime: completedAt,
      });
      const assetVersionId = await insertAndReturnId(trx, "o_image", {
        filePath: `/${locked.storageKey}`,
        storageKey: locked.storageKey,
        type: locked.mediaType,
        assetsId: assetId,
        state: "已完成",
      });
      const assetChanged = await trx("o_assets")
        .where({ id: assetId, projectId: locked.projectId })
        .update({ imageId: assetVersionId });
      if (assetChanged !== 1) {
        throw failure("参考素材写入失败", 500, "REFERENCE_UPLOAD_ASSET_COMMIT_FAILED");
      }
      await registerAccountOwnedAssetIfAvailable({
        transaction: trx,
        assetId,
        projectId: locked.projectId,
        workspaceId: locked.workspaceId,
        actorUserId: locked.actorUserId,
        assetVersionId: `image:${assetVersionId}`,
        idempotencyKey: `reference-multipart:${locked.id}:ownership`,
        now: completedAt,
      });
      if (locked.mediaType !== "document") await createPortraitAdmissionForUpload({
        database: trx,
        workspaceId: locked.workspaceId,
        projectId: locked.projectId,
        assetId,
        assetVersionId,
        mediaType: locked.mediaType,
        sourceSha256: actualSha256,
        now: completedAt,
      });
      const sessionChanged = await trx(REFERENCE_MULTIPART_UPLOAD_TABLE)
        .where({ id: locked.id, status: "verifying", revision: locked.revision })
        .update({
          status: "completed",
          assetId,
          assetVersionId,
          actualSha256,
          detectedMimeType: locked.declaredMimeType,
          probeJson: JSON.stringify(probe),
          completedAt,
          errorCode: null,
          revision: locked.revision + 1,
          updatedAt: completedAt,
        });
      if (sessionChanged !== 1) {
        throw failure("上传会话完成状态冲突", 409, "REFERENCE_UPLOAD_STATE_CONFLICT");
      }
      await commitWorkspaceStorage(trx, `multipart:${locked.id}`, body.byteLength, { ...completion, actualSha256 });
      return { assetId, assetVersionId, completedAt };
    });
    const finalized: SessionRecord = {
      ...session,
      status: "completed",
      assetId: completed.assetId,
      assetVersionId: completed.assetVersionId,
      actualSha256,
      detectedMimeType: session.declaredMimeType,
      probeJson: JSON.stringify(probe),
      completedAt: completed.completedAt,
      revision: session.revision + 1,
      updatedAt: completed.completedAt,
    };
    return {
      ...await statusResult(finalized, context.storage, parts),
      idempotent: !initiallyActive,
    };
  } catch (error) {
    const latest = await reloadSession(database, session).catch(() => null);
    if (latest && sessionHasCompletion(latest, completion)) {
      return {
        ...await statusResult(latest, context.storage, []),
        idempotent: true,
      };
    }
    if (!latest) {
      throw failure(
        "参考素材写入状态暂时无法确认",
        503,
        "REFERENCE_UPLOAD_ASSET_COMMIT_RECOVERY_PENDING",
      );
    }
    const failed = await markFailed(
      database,
      latest,
      "REFERENCE_UPLOAD_ASSET_COMMIT_FAILED",
      now(dependencies),
    );
    if (failed) {
      await compensateCompletedObject(context.storage, latest, completion, database)
        .catch(() => undefined);
    }
    if (error instanceof ReferenceMultipartUploadError) throw error;
    throw failure("参考素材写入失败", 500, "REFERENCE_UPLOAD_ASSET_COMMIT_FAILED");
  }
}

export async function abortReferenceMultipartUpload(
  input: ReferenceMultipartAuthorization,
  dependencies: ReferenceMultipartUploadDependencies = {},
): Promise<ReferenceMultipartStatusResult & { idempotent: boolean }> {
  const { session, database, now: currentTime } = await authorizedSession(input, dependencies);
  const context = await sessionContext(session, dependencies);
  if (session.status === "aborted") {
    return {
      ...await statusResult(session, context.storage, []),
      idempotent: true,
    };
  }
  if (session.status === "completed") {
    throw failure("已完成的上传不能取消", 409, "REFERENCE_UPLOAD_ALREADY_COMPLETED");
  }
  if (session.status !== "active") {
    throw failure("上传会话不能取消", 409, "REFERENCE_UPLOAD_SESSION_NOT_ACTIVE");
  }
  const claimed = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
    .where({ id: session.id, status: "active", revision: session.revision })
    .update({
      status: "aborting",
      revision: session.revision + 1,
      updatedAt: currentTime,
    });
  if (claimed !== 1) {
    throw failure("上传会话正在变化", 409, "REFERENCE_UPLOAD_STATE_CONFLICT");
  }
  let receipt: { requestId: string };
  try {
    receipt = await context.storage.abortMultipartUpload(session.storageKey, {
      uploadId: context.uploadId,
    });
  } catch {
    await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
      .where({ id: session.id, status: "aborting", revision: session.revision + 1 })
      .update({
        status: "active",
        revision: session.revision + 2,
        updatedAt: now(dependencies),
      });
    throw failure("取消对象存储上传失败", 503, "REFERENCE_UPLOAD_ABORT_FAILED");
  }
  const abortedAt = now(dependencies);
  const changed = await database(REFERENCE_MULTIPART_UPLOAD_TABLE)
    .where({ id: session.id, status: "aborting", revision: session.revision + 1 })
    .update({
      status: "aborted",
      abortRequestId: receipt.requestId,
      abortedAt,
      revision: session.revision + 2,
      updatedAt: abortedAt,
    });
  if (changed !== 1) {
    throw failure("上传取消状态冲突", 409, "REFERENCE_UPLOAD_STATE_CONFLICT");
  }
  await releaseWorkspaceStorage(database, `multipart:${session.id}`, { reason: "multipart_aborted", requestId: receipt.requestId });
  const aborted: SessionRecord = {
    ...session,
    status: "aborted",
    abortRequestId: receipt.requestId,
    abortedAt,
    revision: session.revision + 2,
    updatedAt: abortedAt,
  };
  return {
    ...await statusResult(aborted, context.storage, []),
    idempotent: false,
  };
}
