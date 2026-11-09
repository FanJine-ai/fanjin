import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import {
  createRemoteObjectStorageAdapter,
  type ObjectStorageAdapter,
} from "@/lib/objectStorage";
import {
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import {
  RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
} from "@/lib/migrations/releaseArtifactGeneration";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import { db } from "@/utils/db";

export const RELEASE_ARTIFACT_UPLOAD_TTL_SECONDS = 15 * 60;
// PutObject is a single-request upload. Keep the API below the common S3/TOS
// 5 GiB limit; larger release packages must use a separately designed,
// resumable multipart flow instead of silently weakening this endpoint.
export const MAX_RELEASE_ARTIFACT_BYTE_SIZE = 5 * 1024 * 1024 * 1024;

const RELEASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARCHIVE_EXTENSION_PATTERN = /(\.tar\.gz|\.tgz)$/i;

export class ReleaseArtifactUploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ReleaseArtifactUploadError";
    this.status = status;
    this.code = code;
  }
}

function inputError(message: string, code: string): ReleaseArtifactUploadError {
  return new ReleaseArtifactUploadError(message, 400, code);
}

/**
 * Convert a display filename into one safe object-key segment. The caller's
 * path is never preserved and the random UUID, not this name, provides object
 * key unpredictability.
 */
export function safeReleaseArtifactFileName(fileName: string): string {
  const normalized = String(fileName || "").normalize("NFKC").trim();
  if (!normalized || normalized.length > 200 || /[\\/\0-\x1f\x7f]/.test(normalized)) {
    throw inputError("制品文件名无效", "RELEASE_ARTIFACT_FILE_NAME_INVALID");
  }
  const extension = normalized.match(ARCHIVE_EXTENSION_PATTERN)?.[1]?.toLowerCase();
  if (!extension) {
    throw inputError(
      "发布制品只支持 .tar.gz 或 .tgz 文件",
      "RELEASE_ARTIFACT_FILE_TYPE_UNSUPPORTED",
    );
  }

  const sourceStem = normalized.slice(0, -extension.length);
  const safeStem = sourceStem
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 120)
    .replace(/[-._]+$/g, "") || "fanjin-release";
  return `${safeStem}${extension}`;
}

export function createReleaseArtifactStorageKey(
  releaseId: string,
  fileName: string,
  createId: () => string = randomUUID,
): string {
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw inputError("releaseId 必须是有效 UUID", "RELEASE_ARTIFACT_RELEASE_ID_INVALID");
  }
  const objectId = createId();
  if (!RELEASE_ID_PATTERN.test(objectId)) {
    throw new ReleaseArtifactUploadError(
      "发布制品上传服务暂不可用",
      503,
      "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
    );
  }
  return `release-artifacts/${releaseId}/${objectId}-${safeReleaseArtifactFileName(fileName)}`;
}

type UploadStorage = Pick<ObjectStorageAdapter, "createUploadUrl">;
type UploadReservationDatabase = Knex;

export interface ReleaseArtifactUploadDependencies {
  resolveConfiguration?: () => ObjectStorageConfiguration;
  createStorage?: (configuration: ObjectStorageConfiguration) => UploadStorage;
  createId?: () => string;
  database?: UploadReservationDatabase;
  now?: () => number;
}

export interface ReleaseArtifactUploadTarget {
  reservationId: string;
  url: string;
  method: "PUT";
  expiresAt: number;
  requiredHeaders: {
    "Content-Type": string;
  };
  idempotent: boolean;
}

export interface ReleaseArtifactUploadReservationRecord {
  id: string;
  releaseId: string;
  operatorUserId: number;
  idempotencyKey: string;
  requestHash: string;
  storageKey: string;
  fileName: string;
  declaredByteSize: number;
  contentType: string;
  storageProvider: "s3" | "tos";
  storageBucket: string;
  storageRegion: string;
  storageEndpoint: string;
  storageKeyPrefix: string;
  storageForcePathStyle: boolean;
  status: "pending" | "finalized";
  expiresAt: number;
  finalizedArtifactId: string | null;
  finalizedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function positiveInteger(value: unknown, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw inputError("制品大小无效", code);
  }
  return parsed;
}

function uploadContentType(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized !== "application/gzip") {
    throw inputError(
      "发布制品 Content-Type 必须为 application/gzip",
      "RELEASE_ARTIFACT_CONTENT_TYPE_INVALID",
    );
  }
  return normalized;
}

function idempotencyKey(value: unknown): string {
  const normalized = String(value || "").trim();
  if (
    normalized.length < 8
    || normalized.length > 128
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw inputError(
      "idempotencyKey 格式无效",
      "RELEASE_ARTIFACT_UPLOAD_IDEMPOTENCY_KEY_INVALID",
    );
  }
  return normalized;
}

function operatorUserId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ReleaseArtifactUploadError(
      "发布制品上传必须绑定有效操作人",
      403,
      "RELEASE_ARTIFACT_UPLOAD_OPERATOR_REQUIRED",
    );
  }
  return parsed;
}

function mapReservation(
  row: Record<string, unknown>,
): ReleaseArtifactUploadReservationRecord {
  return {
    id: String(row.id),
    releaseId: String(row.releaseId),
    operatorUserId: Number(row.operatorUserId),
    idempotencyKey: String(row.idempotencyKey),
    requestHash: String(row.requestHash),
    storageKey: String(row.storageKey),
    fileName: String(row.fileName),
    declaredByteSize: Number(row.declaredByteSize),
    contentType: String(row.contentType),
    storageProvider: String(row.storageProvider) as "s3" | "tos",
    storageBucket: String(row.storageBucket),
    storageRegion: String(row.storageRegion),
    storageEndpoint: String(row.storageEndpoint),
    storageKeyPrefix: String(row.storageKeyPrefix || ""),
    storageForcePathStyle: Boolean(row.storageForcePathStyle),
    status: String(row.status) as "pending" | "finalized",
    expiresAt: Number(row.expiresAt),
    finalizedArtifactId: row.finalizedArtifactId == null
      ? null
      : String(row.finalizedArtifactId),
    finalizedAt: row.finalizedAt == null ? null : Number(row.finalizedAt),
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function assertReplay(
  reservation: ReleaseArtifactUploadReservationRecord,
  expectedHash: string,
  now: number,
): void {
  if (reservation.requestHash !== expectedHash) {
    throw new ReleaseArtifactUploadError(
      "idempotencyKey 已绑定不同的上传预约",
      409,
      "RELEASE_ARTIFACT_UPLOAD_IDEMPOTENCY_CONFLICT",
    );
  }
  if (reservation.status !== "pending") {
    throw new ReleaseArtifactUploadError(
      "上传预约已经完成登记",
      409,
      "RELEASE_ARTIFACT_UPLOAD_ALREADY_FINALIZED",
    );
  }
  if (reservation.expiresAt <= now) {
    throw new ReleaseArtifactUploadError(
      "上传预约已经过期",
      410,
      "RELEASE_ARTIFACT_UPLOAD_RESERVATION_EXPIRED",
    );
  }
}

function remoteConfiguration(): ObjectStorageConfiguration {
  const configuration = resolveObjectStorageConfiguration();
  if (
    (configuration.provider !== "s3" && configuration.provider !== "tos")
    || !configuration.corsOrigins.length
  ) {
    throw new Error("REMOTE_OBJECT_STORAGE_REQUIRED");
  }
  return configuration;
}

function sameStorageIdentity(
  reservation: ReleaseArtifactUploadReservationRecord,
  configuration: ObjectStorageConfiguration,
): boolean {
  return reservation.storageProvider === configuration.provider
    && reservation.storageBucket === configuration.bucket
    && reservation.storageRegion === configuration.region
    && reservation.storageEndpoint === configuration.endpoint
    && reservation.storageKeyPrefix === configuration.keyPrefix
    && reservation.storageForcePathStyle === configuration.forcePathStyle;
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === "23505"
    || candidate?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || /unique constraint|unique failed|duplicate key/i.test(
      String(candidate?.message || ""),
  );
}

export interface ReleaseArtifactReservationOptions {
  ttlSeconds?: number;
  /** Extra immutable request fields, for example multipart mode and digest. */
  requestIdentity?: Record<string, unknown>;
}

export interface ReservedReleaseArtifactUpload {
  reservation: ReleaseArtifactUploadReservationRecord;
  configuration: ObjectStorageConfiguration;
  idempotent: boolean;
}

/**
 * Shared durable reservation boundary for both single PUT and multipart
 * release uploads. It owns input validation, draft-release locking, storage
 * identity binding and idempotency; callers only add their transport.
 */
export async function reserveReleaseArtifactUpload(
  input: {
    releaseId: string;
    fileName: string;
    byteSize: number;
    contentType: string;
    idempotencyKey: string;
    operatorUserId: number;
  },
  dependencies: ReleaseArtifactUploadDependencies = {},
  options: ReleaseArtifactReservationOptions = {},
): Promise<ReservedReleaseArtifactUpload> {
  const safeFileName = safeReleaseArtifactFileName(input.fileName);
  if (!RELEASE_ID_PATTERN.test(input.releaseId)) {
    throw inputError(
      "releaseId 必须是有效 UUID",
      "RELEASE_ARTIFACT_RELEASE_ID_INVALID",
    );
  }
  const declaredByteSize = positiveInteger(
    input.byteSize,
    "RELEASE_ARTIFACT_BYTE_SIZE_INVALID",
  );
  if (declaredByteSize > MAX_RELEASE_ARTIFACT_BYTE_SIZE) {
    throw inputError(
      "发布制品超过上传大小上限",
      "RELEASE_ARTIFACT_BYTE_SIZE_INVALID",
    );
  }
  const contentType = uploadContentType(input.contentType);
  const normalizedIdempotencyKey = idempotencyKey(input.idempotencyKey);
  const normalizedOperatorUserId = operatorUserId(input.operatorUserId);
  const ttlSeconds = options.ttlSeconds ?? RELEASE_ARTIFACT_UPLOAD_TTL_SECONDS;
  if (
    !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < RELEASE_ARTIFACT_UPLOAD_TTL_SECONDS
    || ttlSeconds > 7 * 24 * 60 * 60
  ) {
    throw inputError(
      "发布制品上传会话有效期无效",
      "RELEASE_ARTIFACT_UPLOAD_TTL_INVALID",
    );
  }
  const now = (dependencies.now || Date.now)();
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new ReleaseArtifactUploadError(
      "发布制品上传服务暂不可用",
      503,
      "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
    );
  }
  let configuration: ObjectStorageConfiguration;
  try {
    configuration = dependencies.resolveConfiguration
      ? dependencies.resolveConfiguration()
      : remoteConfiguration();
    if (
      (configuration.provider !== "s3" && configuration.provider !== "tos")
      || !configuration.corsOrigins.length
    ) {
      throw new Error("REMOTE_OBJECT_STORAGE_REQUIRED");
    }
  } catch {
    throw new ReleaseArtifactUploadError(
      "远端发布制品存储未配置或暂不可用",
      503,
      "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
    );
  }
  const hash = requestHash({
    releaseId: input.releaseId,
    fileName: safeFileName,
    declaredByteSize,
    contentType,
    ...options.requestIdentity,
  });
  const database = dependencies.database || (db as unknown as Knex);
  let reservation: ReleaseArtifactUploadReservationRecord;
  let idempotent = false;
  const identity = {
    operatorUserId: normalizedOperatorUserId,
    idempotencyKey: normalizedIdempotencyKey,
  };
  const existing = await database(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
    .where(identity)
    .first();
  if (existing) {
    reservation = mapReservation(existing as Record<string, unknown>);
    assertReplay(reservation, hash, now);
    idempotent = true;
  } else {
    const storageKey = createReleaseArtifactStorageKey(
      input.releaseId,
      safeFileName,
      dependencies.createId,
    );
    try {
      reservation = await database.transaction(async (trx) => {
        const replay = await trx(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
          .where(identity)
          .first();
        if (replay) {
          const mapped = mapReservation(replay as Record<string, unknown>);
          assertReplay(mapped, hash, now);
          idempotent = true;
          return mapped;
        }
        const release = await trx(PLATFORM_RELEASE_TABLE)
          .where({ id: input.releaseId })
          .forUpdate()
          .first();
        if (!release) {
          throw new ReleaseArtifactUploadError(
            "版本记录不存在",
            404,
            "PLATFORM_RELEASE_NOT_FOUND",
          );
        }
        if (String(release.status) !== "draft") {
          throw new ReleaseArtifactUploadError(
            "只有草稿版本可以预约制品上传",
            409,
            "RELEASE_ARTIFACT_UPLOAD_RELEASE_NOT_DRAFT",
          );
        }
        const row = {
          id: (dependencies.createId || randomUUID)(),
          releaseId: input.releaseId,
          operatorUserId: normalizedOperatorUserId,
          idempotencyKey: normalizedIdempotencyKey,
          requestHash: hash,
          storageKey,
          fileName: safeFileName,
          declaredByteSize,
          contentType,
          storageProvider: configuration.provider,
          storageBucket: configuration.bucket,
          storageRegion: configuration.region,
          storageEndpoint: configuration.endpoint,
          storageKeyPrefix: configuration.keyPrefix,
          storageForcePathStyle: configuration.forcePathStyle,
          status: "pending",
          expiresAt: now + ttlSeconds * 1_000,
          finalizedArtifactId: null,
          finalizedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        if (!RELEASE_ID_PATTERN.test(row.id)) {
          throw new ReleaseArtifactUploadError(
            "发布制品上传服务暂不可用",
            503,
            "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
          );
        }
        await trx(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE).insert(row);
        return mapReservation(row);
      });
    } catch (error) {
      if (error instanceof ReleaseArtifactUploadError) throw error;
      if (!isUniqueViolation(error)) throw error;
      const replay = await database(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
        .where(identity)
        .first();
      if (!replay) {
        throw new ReleaseArtifactUploadError(
          "发布制品上传服务暂不可用",
          503,
          "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
        );
      }
      reservation = mapReservation(replay as Record<string, unknown>);
      assertReplay(reservation, hash, now);
      idempotent = true;
    }
  }
  if (!sameStorageIdentity(reservation, configuration)) {
    throw new ReleaseArtifactUploadError(
      "上传预约绑定的对象存储身份已变化",
      409,
      "RELEASE_ARTIFACT_UPLOAD_STORAGE_IDENTITY_CHANGED",
    );
  }
  const currentRelease = await database(PLATFORM_RELEASE_TABLE)
    .where({ id: input.releaseId })
    .first();
  if (!currentRelease) {
    throw new ReleaseArtifactUploadError(
      "版本记录不存在",
      404,
      "PLATFORM_RELEASE_NOT_FOUND",
    );
  }
  if (String(currentRelease.status) !== "draft") {
    throw new ReleaseArtifactUploadError(
      "只有草稿版本可以预约制品上传",
      409,
      "RELEASE_ARTIFACT_UPLOAD_RELEASE_NOT_DRAFT",
    );
  }
  return { reservation, configuration, idempotent };
}

/**
 * Issue a private remote-object-storage upload target. This function never
 * falls back to the local filesystem and translates configuration/provider
 * failures into a stable error that cannot expose credentials or signed URLs.
 *
 * The TOS/S3 bucket must allow browser PUT requests from the configured web
 * origin. The API CORS policy alone cannot authorize this direct upload.
 */
export async function createReleaseArtifactUploadTarget(
  input: {
    releaseId: string;
    fileName: string;
    byteSize: number;
    contentType: string;
    idempotencyKey: string;
    operatorUserId: number;
  },
  dependencies: ReleaseArtifactUploadDependencies = {},
): Promise<ReleaseArtifactUploadTarget> {
  const safeFileName = safeReleaseArtifactFileName(input.fileName);
  if (!RELEASE_ID_PATTERN.test(input.releaseId)) {
    throw inputError(
      "releaseId 必须是有效 UUID",
      "RELEASE_ARTIFACT_RELEASE_ID_INVALID",
    );
  }
  const declaredByteSize = positiveInteger(
    input.byteSize,
    "RELEASE_ARTIFACT_BYTE_SIZE_INVALID",
  );
  if (declaredByteSize > MAX_RELEASE_ARTIFACT_BYTE_SIZE) {
    throw inputError(
      "发布制品超过单次上传大小上限",
      "RELEASE_ARTIFACT_BYTE_SIZE_INVALID",
    );
  }
  const contentType = uploadContentType(input.contentType);
  const normalizedIdempotencyKey = idempotencyKey(input.idempotencyKey);
  const normalizedOperatorUserId = operatorUserId(input.operatorUserId);
  const now = (dependencies.now || Date.now)();
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new ReleaseArtifactUploadError(
      "发布制品上传服务暂不可用",
      503,
      "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
    );
  }
  let configuration: ObjectStorageConfiguration;
  try {
    configuration = dependencies.resolveConfiguration
      ? dependencies.resolveConfiguration()
      : remoteConfiguration();
    if (
      (configuration.provider !== "s3" && configuration.provider !== "tos")
      || !configuration.corsOrigins.length
    ) {
      throw new Error("REMOTE_OBJECT_STORAGE_REQUIRED");
    }
  } catch {
    throw new ReleaseArtifactUploadError(
      "远端发布制品存储未配置或暂不可用",
      503,
      "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
    );
  }
  const hash = requestHash({
    releaseId: input.releaseId,
    fileName: safeFileName,
    declaredByteSize,
    contentType,
  });
  const database = dependencies.database || (db as unknown as Knex);
  let reservation: ReleaseArtifactUploadReservationRecord;
  let idempotent = false;
  const existing = await database(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
    .where({
      operatorUserId: normalizedOperatorUserId,
      idempotencyKey: normalizedIdempotencyKey,
    })
    .first();
  if (existing) {
    reservation = mapReservation(existing as Record<string, unknown>);
    assertReplay(reservation, hash, now);
    idempotent = true;
  } else {
    const storageKey = createReleaseArtifactStorageKey(
      input.releaseId,
      safeFileName,
      dependencies.createId,
    );
    try {
      reservation = await database.transaction(async (trx) => {
        const replay = await trx(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
          .where({
            operatorUserId: normalizedOperatorUserId,
            idempotencyKey: normalizedIdempotencyKey,
          })
          .first();
        if (replay) {
          const mapped = mapReservation(replay as Record<string, unknown>);
          assertReplay(mapped, hash, now);
          idempotent = true;
          return mapped;
        }
        const release = await trx(PLATFORM_RELEASE_TABLE)
          .where({ id: input.releaseId })
          .forUpdate()
          .first();
        if (!release) {
          throw new ReleaseArtifactUploadError(
            "版本记录不存在",
            404,
            "PLATFORM_RELEASE_NOT_FOUND",
          );
        }
        if (String(release.status) !== "draft") {
          throw new ReleaseArtifactUploadError(
            "只有草稿版本可以预约制品上传",
            409,
            "RELEASE_ARTIFACT_UPLOAD_RELEASE_NOT_DRAFT",
          );
        }
        const row = {
          id: (dependencies.createId || randomUUID)(),
          releaseId: input.releaseId,
          operatorUserId: normalizedOperatorUserId,
          idempotencyKey: normalizedIdempotencyKey,
          requestHash: hash,
          storageKey,
          fileName: safeFileName,
          declaredByteSize,
          contentType,
          storageProvider: configuration.provider,
          storageBucket: configuration.bucket,
          storageRegion: configuration.region,
          storageEndpoint: configuration.endpoint,
          storageKeyPrefix: configuration.keyPrefix,
          storageForcePathStyle: configuration.forcePathStyle,
          status: "pending",
          expiresAt: now + RELEASE_ARTIFACT_UPLOAD_TTL_SECONDS * 1_000,
          finalizedArtifactId: null,
          finalizedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        if (!RELEASE_ID_PATTERN.test(row.id)) {
          throw new ReleaseArtifactUploadError(
            "发布制品上传服务暂不可用",
            503,
            "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
          );
        }
        await trx(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE).insert(row);
        return mapReservation(row);
      });
    } catch (error) {
      if (error instanceof ReleaseArtifactUploadError) throw error;
      if (!isUniqueViolation(error)) throw error;
      const replay = await database(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
        .where({
          operatorUserId: normalizedOperatorUserId,
          idempotencyKey: normalizedIdempotencyKey,
        })
        .first();
      if (!replay) {
        throw new ReleaseArtifactUploadError(
          "发布制品上传服务暂不可用",
          503,
          "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
        );
      }
      reservation = mapReservation(replay as Record<string, unknown>);
      assertReplay(reservation, hash, now);
      idempotent = true;
    }
  }
  if (!sameStorageIdentity(reservation, configuration)) {
    throw new ReleaseArtifactUploadError(
      "上传预约绑定的对象存储身份已变化",
      409,
      "RELEASE_ARTIFACT_UPLOAD_STORAGE_IDENTITY_CHANGED",
    );
  }
  const currentRelease = await database(PLATFORM_RELEASE_TABLE)
    .where({ id: input.releaseId })
    .first();
  if (!currentRelease) {
    throw new ReleaseArtifactUploadError(
      "版本记录不存在",
      404,
      "PLATFORM_RELEASE_NOT_FOUND",
    );
  }
  if (String(currentRelease.status) !== "draft") {
    throw new ReleaseArtifactUploadError(
      "只有草稿版本可以预约制品上传",
      409,
      "RELEASE_ARTIFACT_UPLOAD_RELEASE_NOT_DRAFT",
    );
  }

  try {
    const storage = (dependencies.createStorage || createRemoteObjectStorageAdapter)(configuration);
    const signed = await storage.createUploadUrl(reservation.storageKey, {
      expiresInSeconds: RELEASE_ARTIFACT_UPLOAD_TTL_SECONDS,
      contentLength: reservation.declaredByteSize,
      contentType: reservation.contentType,
    });
    const url = new URL(signed.url);
    if (signed.method !== "PUT" || url.protocol !== "https:" || url.username || url.password ||
      !Number.isSafeInteger(signed.expiresAt) || signed.expiresAt <= Date.now()) {
      throw new Error("INVALID_SIGNED_UPLOAD_TARGET");
    }
    return {
      reservationId: reservation.id,
      url: signed.url,
      method: "PUT",
      expiresAt: Math.min(signed.expiresAt, reservation.expiresAt),
      requiredHeaders: {
        "Content-Type": reservation.contentType,
      },
      idempotent,
    };
  } catch (error) {
    if (error instanceof ReleaseArtifactUploadError) throw error;
    throw new ReleaseArtifactUploadError(
      "远端发布制品存储未配置或暂不可用",
      503,
      "RELEASE_ARTIFACT_UPLOAD_URL_UNAVAILABLE",
    );
  }
}
