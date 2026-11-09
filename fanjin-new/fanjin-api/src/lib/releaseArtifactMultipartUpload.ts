import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Knex } from "knex";

import {
  createRemoteObjectStorageAdapter,
  type ObjectStorageAdapter,
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
import {
  RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE,
} from "@/lib/migrations/releaseArtifactMultipartUpload";
import {
  RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
} from "@/lib/migrations/releaseArtifactGeneration";
import {
  type ReleaseArtifactUploadReservationRecord,
  reserveReleaseArtifactUpload,
  type ReleaseArtifactUploadDependencies,
  ReleaseArtifactUploadError,
} from "@/lib/releaseArtifactUpload";
import { openSecret, sealSecret } from "@/lib/secretEnvelope";
import { db } from "@/utils/db";

export const RELEASE_ARTIFACT_MULTIPART_PROTOCOL_VERSION =
  "release-artifact-multipart/v1" as const;
export const RELEASE_ARTIFACT_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
export const RELEASE_ARTIFACT_MULTIPART_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const RELEASE_ARTIFACT_MULTIPART_PART_URL_TTL_SECONDS = 10 * 60;
export const RELEASE_ARTIFACT_MULTIPART_MAX_PARTS = 10_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ReleaseArtifactMultipartStorage {
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
}

export interface ReleaseArtifactMultipartUploadDependencies
  extends Omit<ReleaseArtifactUploadDependencies, "createStorage"> {
  createStorage?: (
    configuration: ObjectStorageConfiguration,
  ) => ReleaseArtifactMultipartStorage;
  randomGrant?: () => string;
}

type SessionStatus =
  | "active"
  | "completing"
  | "aborting"
  | "completed"
  | "aborted"
  | "expired";

interface MultipartSessionRecord {
  id: string;
  reservationId: string;
  releaseId: string;
  operatorUserId: number;
  operatorSessionHash: string;
  resumeGrantHash: string;
  uploadIdCiphertext: string;
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
  completedAt: number | null;
  abortedAt: number | null;
  expiredAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseArtifactMultipartAuthorization {
  sessionId: string;
  resumeGrant: string;
  operatorUserId: number;
  operatorSessionId: string;
}

export interface ReleaseArtifactMultipartStatusResult {
  protocolVersion: typeof RELEASE_ARTIFACT_MULTIPART_PROTOCOL_VERSION;
  sessionId: string;
  reservationId: string;
  releaseId: string;
  partSize: number;
  partCount: number;
  byteSize: number;
  sha256: string;
  expiresAt: number;
  status: SessionStatus;
  uploadedParts: Array<{ partNumber: number; byteSize: number }>;
  uploadedByteSize: number;
}

export class ReleaseArtifactMultipartUploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ReleaseArtifactMultipartUploadError";
    this.status = status;
    this.code = code;
  }
}

function failure(
  message: string,
  status: number,
  code: string,
): ReleaseArtifactMultipartUploadError {
  return new ReleaseArtifactMultipartUploadError(message, status, code);
}

function mapUploadError(error: unknown): never {
  if (error instanceof ReleaseArtifactMultipartUploadError) throw error;
  if (error instanceof ReleaseArtifactUploadError) {
    throw failure(error.message, error.status, error.code);
  }
  throw failure(
    "远端发布制品存储暂不可用",
    503,
    "RELEASE_ARTIFACT_MULTIPART_STORAGE_UNAVAILABLE",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameHash(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function safeSessionToken(value: unknown, code: string): string {
  const token = String(value ?? "");
  if (
    token.length < 8
    || token.length > 512
    || token !== token.trim()
    || /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw failure("上传会话授权无效", 403, code);
  }
  return token;
}

function safeSha256(value: unknown): string {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(digest)) {
    throw failure(
      "制品 SHA-256 无效",
      400,
      "RELEASE_ARTIFACT_MULTIPART_SHA256_INVALID",
    );
  }
  return digest;
}

function safeNow(dependencies: ReleaseArtifactMultipartUploadDependencies): number {
  const now = (dependencies.now || Date.now)();
  if (!Number.isSafeInteger(now) || now < 1) {
    throw failure(
      "发布制品上传服务暂不可用",
      503,
      "RELEASE_ARTIFACT_MULTIPART_UNAVAILABLE",
    );
  }
  return now;
}

function mapSession(row: Record<string, unknown>): MultipartSessionRecord {
  const nullableText = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  const nullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    id: String(row.id),
    reservationId: String(row.reservationId),
    releaseId: String(row.releaseId),
    operatorUserId: Number(row.operatorUserId),
    operatorSessionHash: String(row.operatorSessionHash),
    resumeGrantHash: String(row.resumeGrantHash),
    uploadIdCiphertext: String(row.uploadIdCiphertext),
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
    completedAt: nullableNumber(row.completedAt),
    abortedAt: nullableNumber(row.abortedAt),
    expiredAt: nullableNumber(row.expiredAt),
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function grant(dependencies: ReleaseArtifactMultipartUploadDependencies): string {
  const value = dependencies.randomGrant?.() ?? randomBytes(32).toString("base64url");
  return safeSessionToken(value, "RELEASE_ARTIFACT_MULTIPART_GRANT_UNAVAILABLE");
}

function uploadIdPurpose(sessionId: string): string {
  return `release-artifact-multipart:${sessionId}:upload-id`;
}

function openUploadId(session: MultipartSessionRecord): string {
  try {
    return safeSessionToken(
      openSecret(session.uploadIdCiphertext, uploadIdPurpose(session.id)),
      "RELEASE_ARTIFACT_MULTIPART_UPLOAD_ID_INVALID",
    );
  } catch {
    throw failure(
      "发布制品上传会话无法恢复",
      503,
      "RELEASE_ARTIFACT_MULTIPART_SESSION_UNRECOVERABLE",
    );
  }
}

function storageAdapter(
  configuration: ObjectStorageConfiguration,
  dependencies: ReleaseArtifactMultipartUploadDependencies,
): ReleaseArtifactMultipartStorage {
  const storage = dependencies.createStorage?.(configuration)
    ?? createRemoteObjectStorageAdapter(configuration);
  for (const method of [
    "initiateMultipartUpload",
    "createMultipartPartUploadUrl",
    "listMultipartParts",
    "completeMultipartUpload",
    "abortMultipartUpload",
    "inspectGeneration",
  ] as const) {
    if (typeof (storage as Partial<ObjectStorageAdapter>)[method] !== "function") {
      throw failure(
        "远端存储不支持断点续传",
        503,
        "RELEASE_ARTIFACT_MULTIPART_STORAGE_UNSUPPORTED",
      );
    }
  }
  return storage as ReleaseArtifactMultipartStorage;
}

function storageMatches(
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

function expectedPartSize(
  reservation: ReleaseArtifactUploadReservationRecord,
  session: MultipartSessionRecord,
  partNumber: number,
): number {
  if (
    !Number.isSafeInteger(partNumber)
    || partNumber < 1
    || partNumber > session.partCount
  ) {
    throw failure(
      "分片编号无效",
      400,
      "RELEASE_ARTIFACT_MULTIPART_PART_NUMBER_INVALID",
    );
  }
  return partNumber === session.partCount
    ? reservation.declaredByteSize - session.partSize * (session.partCount - 1)
    : session.partSize;
}

function verifiedParts(
  listing: ObjectStorageMultipartPartListing,
  reservation: ReleaseArtifactUploadReservationRecord,
  session: MultipartSessionRecord,
): ObjectStorageMultipartPart[] {
  if (!Array.isArray(listing.parts) || listing.parts.length > session.partCount) {
    throw failure(
      "远端分片记录无效",
      502,
      "RELEASE_ARTIFACT_MULTIPART_PROVIDER_PARTS_INVALID",
    );
  }
  let previous = 0;
  for (const part of listing.parts) {
    if (
      part.partNumber <= previous
      || part.size !== expectedPartSize(reservation, session, part.partNumber)
      || !String(part.etag || "")
    ) {
      throw failure(
        "远端分片记录无效",
        502,
        "RELEASE_ARTIFACT_MULTIPART_PROVIDER_PARTS_INVALID",
      );
    }
    previous = part.partNumber;
  }
  return listing.parts;
}

async function reservationForSession(
  session: MultipartSessionRecord,
  database: Knex,
): Promise<ReleaseArtifactUploadReservationRecord> {
  const row = await database("o_release_artifact_upload_reservation")
    .where({ id: session.reservationId, releaseId: session.releaseId })
    .first();
  if (!row) {
    throw failure(
      "上传预约不存在",
      404,
      "RELEASE_ARTIFACT_MULTIPART_RESERVATION_NOT_FOUND",
    );
  }
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

async function authorizedSession(
  input: ReleaseArtifactMultipartAuthorization,
  dependencies: ReleaseArtifactMultipartUploadDependencies,
): Promise<{ session: MultipartSessionRecord; database: Knex; now: number }> {
  if (!UUID_PATTERN.test(String(input.sessionId || ""))) {
    throw failure(
      "上传会话不存在",
      404,
      "RELEASE_ARTIFACT_MULTIPART_SESSION_NOT_FOUND",
    );
  }
  const userId = Number(input.operatorUserId);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw failure(
      "上传会话授权无效",
      403,
      "RELEASE_ARTIFACT_MULTIPART_AUTHORIZATION_INVALID",
    );
  }
  const sessionToken = safeSessionToken(
    input.operatorSessionId,
    "RELEASE_ARTIFACT_MULTIPART_AUTHORIZATION_INVALID",
  );
  const resumeGrant = safeSessionToken(
    input.resumeGrant,
    "RELEASE_ARTIFACT_MULTIPART_AUTHORIZATION_INVALID",
  );
  const database = dependencies.database || (db as unknown as Knex);
  const row = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
    .where({ id: input.sessionId })
    .first();
  if (!row) {
    throw failure(
      "上传会话不存在",
      404,
      "RELEASE_ARTIFACT_MULTIPART_SESSION_NOT_FOUND",
    );
  }
  const session = mapSession(row as Record<string, unknown>);
  if (
    session.operatorUserId !== userId
    || !sameHash(session.operatorSessionHash, sha256(sessionToken))
    || !sameHash(session.resumeGrantHash, sha256(resumeGrant))
  ) {
    throw failure(
      "上传会话授权无效",
      403,
      "RELEASE_ARTIFACT_MULTIPART_AUTHORIZATION_INVALID",
    );
  }
  const now = safeNow(dependencies);
  if (session.status === "expired" || (
    session.status !== "completed"
    && session.status !== "aborted"
    && session.expiresAt <= now
  )) {
    throw failure(
      "上传会话已过期",
      410,
      "RELEASE_ARTIFACT_MULTIPART_SESSION_EXPIRED",
    );
  }
  return { session, database, now };
}

/**
 * Verify the narrow grant minted by the MFA-backed init operation. The Admin
 * step-up middleware calls this before treating a follow-up request as a
 * delegated continuation of the original deployment authorization.
 */
export async function authorizeReleaseArtifactMultipartDelegation(
  input: ReleaseArtifactMultipartAuthorization,
  dependencies: ReleaseArtifactMultipartUploadDependencies = {},
): Promise<{ sessionId: string; status: SessionStatus; expiresAt: number }> {
  try {
    const { session } = await authorizedSession(input, dependencies);
    return {
      sessionId: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
    };
  } catch (error) {
    mapUploadError(error);
  }
}

async function sessionContext(
  session: MultipartSessionRecord,
  database: Knex,
  dependencies: ReleaseArtifactMultipartUploadDependencies,
): Promise<{
  reservation: ReleaseArtifactUploadReservationRecord;
  storage: ReleaseArtifactMultipartStorage;
  uploadId: string;
}> {
  const reservation = await reservationForSession(session, database);
  let configuration: ObjectStorageConfiguration;
  try {
    configuration = dependencies.resolveConfiguration?.()
      ?? resolveObjectStorageConfiguration();
  } catch {
    mapUploadError(new Error("configuration unavailable"));
  }
  if (!storageMatches(reservation, configuration!)) {
    throw failure(
      "上传预约绑定的对象存储身份已变化",
      409,
      "RELEASE_ARTIFACT_MULTIPART_STORAGE_IDENTITY_CHANGED",
    );
  }
  return {
    reservation,
    storage: storageAdapter(configuration!, dependencies),
    uploadId: openUploadId(session),
  };
}

function statusResult(
  session: MultipartSessionRecord,
  reservation: ReleaseArtifactUploadReservationRecord,
  parts: ObjectStorageMultipartPart[],
): ReleaseArtifactMultipartStatusResult {
  return {
    protocolVersion: RELEASE_ARTIFACT_MULTIPART_PROTOCOL_VERSION,
    sessionId: session.id,
    reservationId: session.reservationId,
    releaseId: session.releaseId,
    partSize: session.partSize,
    partCount: session.partCount,
    byteSize: reservation.declaredByteSize,
    sha256: session.declaredSha256,
    expiresAt: session.expiresAt,
    status: session.status,
    uploadedParts: parts.map((part) => ({
      partNumber: part.partNumber,
      byteSize: part.size,
    })),
    uploadedByteSize: parts.reduce((total, part) => total + part.size, 0),
  };
}

export async function initReleaseArtifactMultipartUpload(
  input: {
    releaseId: string;
    fileName: string;
    byteSize: number;
    contentType: string;
    sha256: string;
    idempotencyKey: string;
    operatorUserId: number;
    operatorSessionId: string;
  },
  dependencies: ReleaseArtifactMultipartUploadDependencies = {},
): Promise<ReleaseArtifactMultipartStatusResult & {
  resumeGrant: string;
  idempotent: boolean;
}> {
  const declaredSha256 = safeSha256(input.sha256);
  const operatorSessionId = safeSessionToken(
    input.operatorSessionId,
    "RELEASE_ARTIFACT_MULTIPART_AUTHORIZATION_INVALID",
  );
  try {
    const reserved = await reserveReleaseArtifactUpload(
      input,
      {
        database: dependencies.database,
        resolveConfiguration: dependencies.resolveConfiguration,
        createId: dependencies.createId,
        now: dependencies.now,
      },
      {
        ttlSeconds: RELEASE_ARTIFACT_MULTIPART_SESSION_TTL_SECONDS,
        requestIdentity: {
          mode: RELEASE_ARTIFACT_MULTIPART_PROTOCOL_VERSION,
          sha256: declaredSha256,
        },
      },
    );
    const database = dependencies.database || (db as unknown as Knex);
    const resumeGrant = grant(dependencies);
    const partCount = Math.ceil(
      reserved.reservation.declaredByteSize
        / RELEASE_ARTIFACT_MULTIPART_PART_SIZE,
    );
    if (partCount < 1 || partCount > RELEASE_ARTIFACT_MULTIPART_MAX_PARTS) {
      throw failure(
        "制品分片数量超过上限",
        400,
        "RELEASE_ARTIFACT_MULTIPART_PART_COUNT_INVALID",
      );
    }
    const pendingInitiation: {
      value: {
        storage: ReleaseArtifactMultipartStorage;
        uploadId: string;
      } | null;
    } = { value: null };
    let outcome: {
      session: MultipartSessionRecord;
      idempotent: boolean;
    };
    try {
      outcome = await database.transaction(async (trx) => {
        const lockedReservation = await trx(
          RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
        )
          .where({ id: reserved.reservation.id })
          .forUpdate()
          .first();
        if (!lockedReservation) {
          throw failure(
            "上传预约不存在",
            404,
            "RELEASE_ARTIFACT_MULTIPART_RESERVATION_NOT_FOUND",
          );
        }
        const lockedNow = safeNow(dependencies);
        const existingRow = await trx(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
          .where({ reservationId: reserved.reservation.id })
          .first();
        if (existingRow) {
          const existing = mapSession(existingRow as Record<string, unknown>);
          if (
            existing.declaredSha256 !== declaredSha256
            || (existing.status !== "active" && existing.status !== "completed")
            || (existing.status === "active" && existing.expiresAt <= lockedNow)
          ) {
            throw failure(
              "上传会话不可恢复",
              existing.status === "active" && existing.expiresAt <= lockedNow ? 410 : 409,
              existing.status === "active" && existing.expiresAt <= lockedNow
                ? "RELEASE_ARTIFACT_MULTIPART_SESSION_EXPIRED"
                : "RELEASE_ARTIFACT_MULTIPART_SESSION_NOT_ACTIVE",
            );
          }
          const rotatedGrant = await trx(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
            .where({
              id: existing.id,
              status: existing.status,
              revision: existing.revision,
            })
            .modify((query) => {
              if (existing.status === "active") {
                query.andWhere("expiresAt", ">", lockedNow);
              }
            })
            .update({
              operatorSessionHash: sha256(operatorSessionId),
              resumeGrantHash: sha256(resumeGrant),
              revision: existing.revision + 1,
              updatedAt: lockedNow,
            });
          if (rotatedGrant !== 1) {
            throw failure(
              "上传会话正在变更，请重新恢复",
              409,
              "RELEASE_ARTIFACT_MULTIPART_STATE_CONFLICT",
            );
          }
          return {
            session: {
              ...existing,
              operatorSessionHash: sha256(operatorSessionId),
              resumeGrantHash: sha256(resumeGrant),
              revision: existing.revision + 1,
              updatedAt: lockedNow,
            },
            idempotent: true,
          };
        }

        if (reserved.reservation.expiresAt <= lockedNow) {
          throw failure(
            "上传会话已过期",
            410,
            "RELEASE_ARTIFACT_MULTIPART_SESSION_EXPIRED",
          );
        }

        const storage = storageAdapter(reserved.configuration, dependencies);
        const initiated = await storage.initiateMultipartUpload(
          reserved.reservation.storageKey,
          { contentType: reserved.reservation.contentType },
        );
        pendingInitiation.value = { storage, uploadId: initiated.uploadId };
        const sessionId = (dependencies.createId || randomUUID)();
        if (!UUID_PATTERN.test(sessionId)) {
          throw failure(
            "发布制品上传服务暂不可用",
            503,
            "RELEASE_ARTIFACT_MULTIPART_UNAVAILABLE",
          );
        }
        const row: MultipartSessionRecord = {
          id: sessionId,
          reservationId: reserved.reservation.id,
          releaseId: reserved.reservation.releaseId,
          operatorUserId: reserved.reservation.operatorUserId,
          operatorSessionHash: sha256(operatorSessionId),
          resumeGrantHash: sha256(resumeGrant),
          uploadIdCiphertext: sealSecret(
            initiated.uploadId,
            uploadIdPurpose(sessionId),
          ),
          declaredSha256,
          partSize: RELEASE_ARTIFACT_MULTIPART_PART_SIZE,
          partCount,
          providerInitiateRequestId: initiated.requestId,
          status: "active",
          expiresAt: reserved.reservation.expiresAt,
          completionEtag: null,
          completionVersionId: null,
          completionRequestId: null,
          abortRequestId: null,
          completedAt: null,
          abortedAt: null,
          expiredAt: null,
          revision: 1,
          createdAt: lockedNow,
          updatedAt: lockedNow,
        };
        await trx(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE).insert(row);
        return { session: row, idempotent: false };
      });
      pendingInitiation.value = null;
    } catch (error) {
      const initiatedToAbort = pendingInitiation.value;
      if (initiatedToAbort) {
        await initiatedToAbort.storage.abortMultipartUpload(
          reserved.reservation.storageKey,
          { uploadId: initiatedToAbort.uploadId },
        ).catch(() => undefined);
      }
      throw error;
    }

    if (outcome.idempotent) {
      if (outcome.session.status === "completed") {
        const completedAt = outcome.session.completedAt;
        const completionEtag = outcome.session.completionEtag;
        if (
          !completionEtag
          || typeof completedAt !== "number"
          || !Number.isSafeInteger(completedAt)
          || completedAt < 1
        ) {
          throw failure(
            "上传会话完成状态无效",
            409,
            "RELEASE_ARTIFACT_MULTIPART_COMPLETION_STATE_CONFLICT",
          );
        }
        const completedParts = Array.from(
          { length: outcome.session.partCount },
          (_, index): ObjectStorageMultipartPart => ({
            partNumber: index + 1,
            size: expectedPartSize(
              reserved.reservation,
              outcome.session,
              index + 1,
            ),
            etag: completionEtag,
            lastModified: new Date(completedAt).toISOString(),
          }),
        );
        return {
          ...statusResult(outcome.session, reserved.reservation, completedParts),
          resumeGrant,
          idempotent: true,
        };
      }
      const context = await sessionContext(
        outcome.session,
        database,
        dependencies,
      );
      const listing = await context.storage.listMultipartParts(
        reserved.reservation.storageKey,
        { uploadId: context.uploadId },
      );
      const parts = verifiedParts(
        listing,
        reserved.reservation,
        outcome.session,
      );
      return {
        ...statusResult(outcome.session, reserved.reservation, parts),
        resumeGrant,
        idempotent: true,
      };
    }
    return {
      ...statusResult(outcome.session, reserved.reservation, []),
      resumeGrant,
      idempotent: false,
    };
  } catch (error) {
    mapUploadError(error);
  }
}

export async function getReleaseArtifactMultipartUploadStatus(
  input: ReleaseArtifactMultipartAuthorization,
  dependencies: ReleaseArtifactMultipartUploadDependencies = {},
): Promise<ReleaseArtifactMultipartStatusResult> {
  try {
    const { session, database } = await authorizedSession(input, dependencies);
    const context = await sessionContext(session, database, dependencies);
    if (session.status === "completed" || session.status === "aborted") {
      return statusResult(session, context.reservation, []);
    }
    const listing = await context.storage.listMultipartParts(
      context.reservation.storageKey,
      { uploadId: context.uploadId },
    );
    return statusResult(
      session,
      context.reservation,
      verifiedParts(listing, context.reservation, session),
    );
  } catch (error) {
    mapUploadError(error);
  }
}

export async function createReleaseArtifactMultipartPartTarget(
  input: ReleaseArtifactMultipartAuthorization & { partNumber: number },
  dependencies: ReleaseArtifactMultipartUploadDependencies = {},
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
  try {
    const { session, database, now } = await authorizedSession(input, dependencies);
    if (session.status !== "active") {
      throw failure(
        "上传会话不允许继续上传",
        409,
        "RELEASE_ARTIFACT_MULTIPART_SESSION_NOT_ACTIVE",
      );
    }
    const context = await sessionContext(session, database, dependencies);
    const byteSize = expectedPartSize(
      context.reservation,
      session,
      Number(input.partNumber),
    );
    const target = await context.storage.createMultipartPartUploadUrl(
      context.reservation.storageKey,
      {
        uploadId: context.uploadId,
        partNumber: Number(input.partNumber),
        contentLength: byteSize,
        expiresInSeconds: RELEASE_ARTIFACT_MULTIPART_PART_URL_TTL_SECONDS,
      },
    );
    const url = new URL(target.url);
    if (
      target.method !== "PUT"
      || url.protocol !== "https:"
      || url.username
      || url.password
      || !Number.isSafeInteger(target.expiresAt)
      || target.expiresAt <= now
      || Object.keys(target.requiredHeaders || {}).length > 0
    ) {
      throw new Error("invalid multipart part target");
    }
    return {
      sessionId: session.id,
      partNumber: Number(input.partNumber),
      byteOffset: (Number(input.partNumber) - 1) * session.partSize,
      byteSize,
      url: target.url,
      method: "PUT",
      expiresAt: Math.min(target.expiresAt, session.expiresAt),
      requiredHeaders: {},
    };
  } catch (error) {
    mapUploadError(error);
  }
}

async function reconcileCompletedGeneration(
  reservation: ReleaseArtifactUploadReservationRecord,
  storage: ReleaseArtifactMultipartStorage,
): Promise<ObjectStorageMultipartCompletion | null> {
  try {
    const snapshot = await storage.inspectGeneration(reservation.storageKey);
    if (
      !snapshot.exists
      || snapshot.deleteMarker
      || snapshot.size !== reservation.declaredByteSize
      || (
        snapshot.contentType
        && snapshot.contentType.toLowerCase() !== reservation.contentType
      )
      || !snapshot.etag
    ) {
      return null;
    }
    return {
      etag: snapshot.etag,
      versionId: snapshot.versionId,
      requestId: snapshot.requestId,
    };
  } catch {
    return null;
  }
}

function sameCompletionGeneration(
  left: Pick<ObjectStorageMultipartCompletion, "etag" | "versionId">,
  right: Pick<ObjectStorageMultipartCompletion, "etag" | "versionId">,
): boolean {
  return left.etag === right.etag
    && (left.versionId ?? null) === (right.versionId ?? null);
}

function sessionMatchesCompletionGeneration(
  session: MultipartSessionRecord,
  completion: ObjectStorageMultipartCompletion,
): boolean {
  return session.status === "completed"
    && session.completionEtag === completion.etag
    && (session.completionVersionId ?? null) === (completion.versionId ?? null);
}

function completedSessionRecord(
  session: MultipartSessionRecord,
  completion: ObjectStorageMultipartCompletion,
  completedAt: number,
): MultipartSessionRecord {
  return {
    ...session,
    status: "completed",
    completionEtag: completion.etag,
    completionVersionId: completion.versionId,
    completionRequestId: completion.requestId,
    completedAt,
    expiredAt: null,
    revision: session.revision + 1,
    updatedAt: completedAt,
  };
}

async function persistCompletedSession(
  database: Knex,
  session: MultipartSessionRecord,
  completion: ObjectStorageMultipartCompletion,
  completedAt: number,
): Promise<MultipartSessionRecord | null> {
  const changed = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
    .where({
      id: session.id,
      status: session.status,
      revision: session.revision,
    })
    .update({
      status: "completed",
      completionEtag: completion.etag,
      completionVersionId: completion.versionId,
      completionRequestId: completion.requestId,
      completedAt,
      expiredAt: null,
      revision: session.revision + 1,
      updatedAt: completedAt,
    });
  return changed === 1
    ? completedSessionRecord(session, completion, completedAt)
    : null;
}

async function readMultipartSession(
  database: Knex,
  sessionId: string,
): Promise<MultipartSessionRecord | null> {
  const row = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
    .where({ id: sessionId })
    .first();
  return row ? mapSession(row as Record<string, unknown>) : null;
}

async function settleCompletionTransitionConflict(input: {
  database: Knex;
  sessionId: string;
  reservation: ReleaseArtifactUploadReservationRecord;
  storage: ReleaseArtifactMultipartStorage;
  expected: ObjectStorageMultipartCompletion;
  completedAt: number;
}): Promise<MultipartSessionRecord> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readMultipartSession(input.database, input.sessionId);
    if (!current) {
      throw failure(
        "上传会话完成状态冲突",
        409,
        "RELEASE_ARTIFACT_MULTIPART_COMPLETION_STATE_CONFLICT",
      );
    }
    if (sessionMatchesCompletionGeneration(current, input.expected)) {
      return current;
    }
    if (current.status !== "completing" && current.status !== "expired") {
      throw failure(
        "上传会话完成状态冲突",
        409,
        "RELEASE_ARTIFACT_MULTIPART_COMPLETION_STATE_CONFLICT",
      );
    }
    const reconciled = await reconcileCompletedGeneration(
      input.reservation,
      input.storage,
    );
    if (!reconciled || !sameCompletionGeneration(reconciled, input.expected)) {
      throw failure(
        "上传会话完成状态尚未确认",
        409,
        "RELEASE_ARTIFACT_MULTIPART_COMPLETION_STATE_CONFLICT",
      );
    }
    const persisted = await persistCompletedSession(
      input.database,
      current,
      reconciled,
      input.completedAt,
    );
    if (persisted) return persisted;
  }
  throw failure(
    "上传会话完成状态冲突",
    409,
    "RELEASE_ARTIFACT_MULTIPART_COMPLETION_STATE_CONFLICT",
  );
}

export async function completeReleaseArtifactMultipartUpload(
  input: ReleaseArtifactMultipartAuthorization,
  dependencies: ReleaseArtifactMultipartUploadDependencies = {},
): Promise<ReleaseArtifactMultipartStatusResult & { idempotent: boolean }> {
  try {
    const { session, database, now } = await authorizedSession(input, dependencies);
    const context = await sessionContext(session, database, dependencies);
    if (session.status === "completed") {
      return {
        ...statusResult(session, context.reservation, []),
        idempotent: true,
      };
    }
    if (session.status !== "active" && session.status !== "completing") {
      throw failure(
        "上传会话不能完成",
        409,
        "RELEASE_ARTIFACT_MULTIPART_SESSION_NOT_ACTIVE",
      );
    }
    if (session.status === "completing") {
      const reconciled = await reconcileCompletedGeneration(
        context.reservation,
        context.storage,
      );
      if (!reconciled) {
        throw failure(
          "上传会话正在完成，请稍后重试",
          409,
          "RELEASE_ARTIFACT_MULTIPART_COMPLETION_IN_PROGRESS",
        );
      }
      const completedSession = await persistCompletedSession(
        database,
        session,
        reconciled,
        now,
      ) ?? await settleCompletionTransitionConflict({
        database,
        sessionId: session.id,
        reservation: context.reservation,
        storage: context.storage,
        expected: reconciled,
        completedAt: now,
      });
      return {
        ...statusResult(completedSession, context.reservation, []),
        idempotent: true,
      };
    }

    const listing = await context.storage.listMultipartParts(
      context.reservation.storageKey,
      { uploadId: context.uploadId },
    );
    const parts = verifiedParts(listing, context.reservation, session);
    if (
      parts.length !== session.partCount
      || parts.some((part, index) => part.partNumber !== index + 1)
    ) {
      throw failure(
        "制品分片尚未全部上传",
        409,
        "RELEASE_ARTIFACT_MULTIPART_PARTS_INCOMPLETE",
      );
    }
    const claimed = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
      .where({ id: session.id, status: "active", revision: session.revision })
      .update({
        status: "completing",
        revision: session.revision + 1,
        updatedAt: now,
      });
    if (claimed !== 1) {
      throw failure(
        "上传会话正在完成，请稍后重试",
        409,
        "RELEASE_ARTIFACT_MULTIPART_COMPLETION_IN_PROGRESS",
      );
    }
    let completed: ObjectStorageMultipartCompletion;
    try {
      completed = await context.storage.completeMultipartUpload(
        context.reservation.storageKey,
        { uploadId: context.uploadId, parts },
      );
    } catch (error) {
      const reconciled = await reconcileCompletedGeneration(
        context.reservation,
        context.storage,
      );
      if (!reconciled) {
        const restored = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
          .where({
            id: session.id,
            status: "completing",
            revision: session.revision + 1,
          })
          .update({
            status: "active",
            revision: session.revision + 2,
            updatedAt: safeNow(dependencies),
          });
        if (restored !== 1) {
          throw failure(
            "上传会话完成状态冲突",
            409,
            "RELEASE_ARTIFACT_MULTIPART_COMPLETION_STATE_CONFLICT",
          );
        }
        throw error;
      }
      completed = reconciled;
    }
    const completedAt = safeNow(dependencies);
    const completingSession: MultipartSessionRecord = {
      ...session,
      status: "completing",
      revision: session.revision + 1,
      updatedAt: now,
    };
    const durableCompleted = await persistCompletedSession(
      database,
      completingSession,
      completed,
      completedAt,
    ) ?? await settleCompletionTransitionConflict({
      database,
      sessionId: session.id,
      reservation: context.reservation,
      storage: context.storage,
      expected: completed,
      completedAt,
    });
    return {
      ...statusResult(durableCompleted, context.reservation, parts),
      idempotent: false,
    };
  } catch (error) {
    mapUploadError(error);
  }
}

export async function abortReleaseArtifactMultipartUpload(
  input: ReleaseArtifactMultipartAuthorization,
  dependencies: ReleaseArtifactMultipartUploadDependencies = {},
): Promise<ReleaseArtifactMultipartStatusResult & { idempotent: boolean }> {
  try {
    const { session, database, now } = await authorizedSession(input, dependencies);
    const context = await sessionContext(session, database, dependencies);
    if (session.status === "aborted") {
      return {
        ...statusResult(session, context.reservation, []),
        idempotent: true,
      };
    }
    if (session.status === "completed") {
      throw failure(
        "已完成的上传会话不能中止",
        409,
        "RELEASE_ARTIFACT_MULTIPART_ALREADY_COMPLETED",
      );
    }
    if (session.status !== "active" && session.status !== "aborting") {
      throw failure(
        "上传会话不能中止",
        409,
        "RELEASE_ARTIFACT_MULTIPART_SESSION_NOT_ACTIVE",
      );
    }
    const claimed = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
      .where({
        id: session.id,
        status: session.status,
        revision: session.revision,
      })
      .update({
        status: "aborting",
        revision: session.revision + 1,
        updatedAt: now,
      });
    if (claimed !== 1) {
      throw failure(
        "上传会话正在变更，请稍后重试",
        409,
        "RELEASE_ARTIFACT_MULTIPART_STATE_CONFLICT",
      );
    }
    const claimedSession: MultipartSessionRecord = {
      ...session,
      status: "aborting",
      revision: session.revision + 1,
      updatedAt: now,
    };
    const aborted = await context.storage.abortMultipartUpload(
      context.reservation.storageKey,
      { uploadId: context.uploadId },
    );
    const abortedAt = safeNow(dependencies);
    const terminal = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
      .where({
        id: session.id,
        status: "aborting",
        revision: claimedSession.revision,
      })
      .update({
        status: "aborted",
        abortRequestId: aborted.requestId,
        abortedAt,
        revision: claimedSession.revision + 1,
        updatedAt: abortedAt,
      });
    if (terminal !== 1) {
      const current = await readMultipartSession(database, session.id);
      if (current?.status === "aborted") {
        return {
          ...statusResult(current, context.reservation, []),
          idempotent: true,
        };
      }
      throw failure(
        "上传会话中止状态冲突",
        409,
        "RELEASE_ARTIFACT_MULTIPART_STATE_CONFLICT",
      );
    }
    const durableAborted: MultipartSessionRecord = {
      ...claimedSession,
      status: "aborted",
      abortRequestId: aborted.requestId,
      abortedAt,
      revision: claimedSession.revision + 1,
      updatedAt: abortedAt,
    };
    return {
      ...statusResult(durableAborted, context.reservation, []),
      idempotent: false,
    };
  } catch (error) {
    mapUploadError(error);
  }
}

export async function cleanupExpiredReleaseArtifactMultipartUploads(
  input: { limit?: number; now?: number } = {},
  dependencies: ReleaseArtifactMultipartUploadDependencies = {},
): Promise<{
  examined: number;
  expired: number;
  completed: number;
  failed: number;
}> {
  const now = input.now ?? safeNow(dependencies);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw failure(
      "清理批次大小无效",
      400,
      "RELEASE_ARTIFACT_MULTIPART_CLEANUP_LIMIT_INVALID",
    );
  }
  const database = dependencies.database || (db as unknown as Knex);
  const rows = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
    .whereIn("status", ["active", "completing", "aborting"])
    .andWhere("expiresAt", "<=", now)
    .orderBy("expiresAt", "asc")
    .limit(limit);
  let expired = 0;
  let completed = 0;
  let failed = 0;
  for (const raw of rows) {
    const session = mapSession(raw as Record<string, unknown>);
    try {
      const context = await sessionContext(session, database, dependencies);
      const cleanupStatus = session.status === "completing"
        ? "completing"
        : "aborting";
      const claimed = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
        .where({
          id: session.id,
          status: session.status,
          revision: session.revision,
        })
        .update({
          status: cleanupStatus,
          revision: session.revision + 1,
          updatedAt: now,
        });
      if (claimed !== 1) {
        failed += 1;
        continue;
      }
      const claimedSession: MultipartSessionRecord = {
        ...session,
        status: cleanupStatus,
        revision: session.revision + 1,
        updatedAt: now,
      };

      if (cleanupStatus === "completing") {
        const reconciled = await reconcileCompletedGeneration(
          context.reservation,
          context.storage,
        );
        if (reconciled) {
          const persisted = await persistCompletedSession(
            database,
            claimedSession,
            reconciled,
            now,
          ) ?? await settleCompletionTransitionConflict({
            database,
            sessionId: session.id,
            reservation: context.reservation,
            storage: context.storage,
            expected: reconciled,
            completedAt: now,
          });
          if (!sessionMatchesCompletionGeneration(persisted, reconciled)) {
            throw failure(
              "上传会话完成状态冲突",
              409,
              "RELEASE_ARTIFACT_MULTIPART_COMPLETION_STATE_CONFLICT",
            );
          }
          completed += 1;
          continue;
        }
      }

      let aborted: { requestId: string };
      try {
        aborted = await context.storage.abortMultipartUpload(
          context.reservation.storageKey,
          { uploadId: context.uploadId },
        );
      } catch (abortError) {
        if (cleanupStatus === "completing") {
          const reconciled = await reconcileCompletedGeneration(
            context.reservation,
            context.storage,
          );
          if (reconciled) {
            const persisted = await persistCompletedSession(
              database,
              claimedSession,
              reconciled,
              now,
            ) ?? await settleCompletionTransitionConflict({
              database,
              sessionId: session.id,
              reservation: context.reservation,
              storage: context.storage,
              expected: reconciled,
              completedAt: now,
            });
            if (sessionMatchesCompletionGeneration(persisted, reconciled)) {
              completed += 1;
              continue;
            }
          }
        }
        throw abortError;
      }
      const changed = await database(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)
        .where({
          id: session.id,
          status: cleanupStatus,
          revision: claimedSession.revision,
        })
        .update({
          status: "expired",
          abortRequestId: aborted.requestId,
          expiredAt: now,
          revision: claimedSession.revision + 1,
          updatedAt: now,
        });
      expired += changed === 1 ? 1 : 0;
      failed += changed === 1 ? 0 : 1;
    } catch {
      failed += 1;
    }
  }
  return { examined: rows.length, expired, completed, failed };
}
