import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { Knex } from "knex";

import { resolveContainedExistingLocalPath } from "@/lib/containedLocalFile";
import { PORTRAIT_ADMISSION_TABLE } from "@/lib/migrations/portraitAssetAdmission";
import {
  createRemoteObjectStorageAdapter,
  normalizeObjectKey,
  type ObjectStorageAdapter,
  type ObjectStorageGenerationSnapshot,
} from "@/lib/objectStorage";
import {
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import {
  createPortraitAdmissionForUpload,
  resolveDurablePortraitSourceSha256,
} from "@/lib/portraitAdmissionStore";
import { logger } from "@/lib/logger";
import getPath from "@/utils/getPath";

export const PORTRAIT_SOURCE_OBJECT_IDENTITY_VERSION =
  "portrait-source-object-identity/v1" as const;

const DEFAULT_BATCH_LIMIT = 2;
const DEFAULT_MAXIMUM_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_LEASE_MS = 20 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 60 * 60_000;
const MAX_BATCH_LIMIT = 100;
const MAXIMUM_BYTES_CAP = 20 * 1024 * 1024 * 1024;
const DELIVERABLE_HISTORICAL_VERSION_STATES = Object.freeze([
  "已完成",
  "生成成功",
  "success",
  "succeeded",
  "completed",
]);

type RecoveryState = "pending" | "hashing" | "retry" | "ready" | "terminal";
type Row = Record<string, any>;

export type PortraitSourceObjectIdentity = Readonly<{
  version: typeof PORTRAIT_SOURCE_OBJECT_IDENTITY_VERSION;
  provider: "local" | "s3" | "tos" | "committed_write_intent";
  bucket: string | null;
  key: string;
  versionId: string | null;
  etag: string | null;
  byteSize: number;
  lastModified: string | null;
  contentType: string | null;
}>;

export type PortraitSourceHashResult = Readonly<{
  sha256: string;
  byteSize: number;
  identity: PortraitSourceObjectIdentity;
}>;

export interface PortraitSourceHashReader {
  hash(input: {
    storageKey: string;
    maximumBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<PortraitSourceHashResult>;
}

export type PortraitSourceRecoveryRuntime = {
  database?: Knex;
  reader?: PortraitSourceHashReader;
  configuration?: ObjectStorageConfiguration;
  fetchImpl?: typeof fetch;
  storage?: Pick<ObjectStorageAdapter, "inspectGeneration" | "getSignedUrl">;
  now?: () => number;
  workerId?: string;
  maximumBytes?: number;
  timeoutMs?: number;
  leaseMs?: number;
  maximumAttempts?: number;
  retryBaseMs?: number;
  retryMaximumMs?: number;
  signal?: AbortSignal;
};

export type PortraitSourceRecoveryReport = Readonly<{
  materialized: number;
  claimed: number;
  recovered: number;
  retried: number;
  terminal: number;
}>;

export type PortraitSourceRecoveryInspection = Readonly<{
  ready: boolean;
  missingAdmissions: number;
  states: Record<RecoveryState, number>;
  operatorFailures: Array<{
    admissionId: string;
    assetVersionId: number;
    code: string;
    reason: string;
  }>;
}>;

export type PortraitSourceRecoveryWorkerInspection = Readonly<{
  running: boolean;
  inFlight: boolean;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  safeReason: "portrait_source_recovery_worker_tick_failed" | null;
}>;

class PortraitSourceRecoveryError extends Error {
  readonly code: string;
  readonly permanent: boolean;
  readonly operatorMessage: string;

  constructor(code: string, permanent: boolean, operatorMessage: string) {
    super(code);
    this.name = "PortraitSourceRecoveryError";
    this.code = code;
    this.permanent = permanent;
    this.operatorMessage = operatorMessage;
  }
}

function failure(
  code: string,
  permanent: boolean,
  operatorMessage: string,
): PortraitSourceRecoveryError {
  return new PortraitSourceRecoveryError(code, permanent, operatorMessage);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  const parsed = value === undefined || value === null || value === ""
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw failure(code, true, "人像历史素材恢复参数无效");
  }
  return parsed;
}

function mediaType(value: unknown): "image" | "video" | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "image") return "image";
  if (normalized === "video" || normalized === "clip") return "video";
  return null;
}

function normalizedHeader(value: string | null): string | null {
  const parsed = String(value || "").trim();
  return parsed && parsed.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(parsed)
    ? parsed
    : null;
}

function normalizedVersionHeader(value: string | null): string | null {
  const parsed = normalizedHeader(value);
  return parsed && !["null", "undefined"].includes(parsed.toLowerCase())
    ? parsed
    : null;
}

function normalizedContentType(value: unknown): string | null {
  const parsed = normalizedHeader(value == null ? null : String(value));
  return parsed ? parsed.toLowerCase() : null;
}

function remoteIdentity(snapshot: ObjectStorageGenerationSnapshot): PortraitSourceObjectIdentity {
  if (
    !snapshot.exists
    || snapshot.deleteMarker
    || snapshot.size === null
    || !Number.isSafeInteger(snapshot.size)
    || snapshot.size < 0
  ) {
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_MISSING",
      true,
      "历史素材对应的 Fanjin 对象不存在或已被删除",
    );
  }
  return {
    version: PORTRAIT_SOURCE_OBJECT_IDENTITY_VERSION,
    provider: snapshot.provider,
    bucket: snapshot.bucket,
    key: snapshot.key,
    versionId: snapshot.versionId,
    etag: snapshot.etag,
    byteSize: snapshot.size,
    lastModified: snapshot.lastModified,
    contentType: normalizedContentType(snapshot.contentType),
  };
}

function sameRemoteGeneration(
  left: PortraitSourceObjectIdentity,
  right: PortraitSourceObjectIdentity,
): boolean {
  return left.provider === right.provider
    && left.bucket === right.bucket
    && left.key === right.key
    && left.versionId === right.versionId
    && left.etag === right.etag
    && left.byteSize === right.byteSize
    && left.lastModified === right.lastModified
    && left.contentType === right.contentType;
}

async function hashWebStream(input: {
  response: Response;
  expected: PortraitSourceObjectIdentity;
  maximumBytes: number;
  signal: AbortSignal;
}): Promise<{ sha256: string; byteSize: number }> {
  if (!input.response.ok || input.response.status !== 200 || !input.response.body) {
    if (input.response.status === 404) {
      throw failure(
        "PORTRAIT_SOURCE_OBJECT_MISSING",
        true,
        "历史素材对应的 Fanjin 对象不存在",
      );
    }
    if (input.response.status === 409 || input.response.status === 412) {
      throw failure(
        "PORTRAIT_SOURCE_OBJECT_CHANGED",
        true,
        "历史素材对象在完整性恢复期间发生变化",
      );
    }
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_READ_FAILED",
      false,
      "暂时无法读取 Fanjin 历史素材对象",
    );
  }
  if (input.response.redirected) {
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_REDIRECTED",
      true,
      "Fanjin 历史素材对象下载发生了未授权跳转",
    );
  }
  const contentEncoding = normalizedHeader(input.response.headers.get("content-encoding"));
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_TRANSFORMED",
      true,
      "Fanjin 历史素材对象下载返回了变换后的内容",
    );
  }
  const contentLengthText = input.response.headers.get("content-length");
  if (
    contentLengthText === null
    || !/^(?:0|[1-9]\d*)$/u.test(contentLengthText)
    || Number(contentLengthText) !== input.expected.byteSize
  ) {
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_CHANGED",
      true,
      "Fanjin 历史素材对象大小与固定对象证据不一致",
    );
  }
  const responseEtag = normalizedHeader(input.response.headers.get("etag"));
  const responseLastModified = normalizedHeader(input.response.headers.get("last-modified"));
  const responseContentType = normalizedContentType(input.response.headers.get("content-type"));
  const responseVersionId = normalizedVersionHeader(
    input.response.headers.get("x-amz-version-id")
      || input.response.headers.get("x-tos-version-id"),
  );
  if (
    responseEtag !== input.expected.etag
    || responseLastModified !== input.expected.lastModified
    || responseVersionId !== input.expected.versionId
    || responseContentType !== input.expected.contentType
  ) {
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_CHANGED",
      true,
      "Fanjin 历史素材对象版本与固定对象证据不一致",
    );
  }
  const hash = crypto.createHash("sha256");
  const reader = input.response.body.getReader();
  let total = 0;
  try {
    while (true) {
      input.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > input.maximumBytes || total > input.expected.byteSize) {
        throw failure(
          "PORTRAIT_SOURCE_OBJECT_TOO_LARGE",
          true,
          "历史素材对象超过允许的完整性恢复上限",
        );
      }
      hash.update(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total !== input.expected.byteSize) {
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_CHANGED",
      true,
      "历史素材对象读取长度与固定对象证据不一致",
    );
  }
  return { sha256: hash.digest("hex"), byteSize: total };
}

export function createPortraitSourceHashReader(input: {
  configuration?: ObjectStorageConfiguration;
  storage?: Pick<ObjectStorageAdapter, "inspectGeneration" | "getSignedUrl">;
  fetchImpl?: typeof fetch;
  localRoot?: string;
} = {}): PortraitSourceHashReader {
  const configuration = input.configuration ?? resolveObjectStorageConfiguration();
  if (configuration.provider === "local") {
    const localRoot = input.localRoot ?? getPath("oss");
    return {
      async hash(request) {
        const storageKey = normalizeObjectKey(request.storageKey);
        request.signal?.throwIfAborted();
        let filePath: string;
        try {
          filePath = resolveContainedExistingLocalPath({
            rootDirectory: localRoot,
            relativePath: storageKey,
            kind: "file",
          });
        } catch {
          throw failure(
            "PORTRAIT_SOURCE_OBJECT_MISSING",
            true,
            "历史素材对应的 Fanjin 本地对象不存在或路径无效",
          );
        }
        const timeout = AbortSignal.timeout(request.timeoutMs);
        const signal = AbortSignal.any([
          timeout,
          ...(request.signal ? [request.signal] : []),
        ]);
        const handle = await fsp.open(
          filePath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          const before = await handle.stat();
          if (!before.isFile()) {
            throw failure(
              "PORTRAIT_SOURCE_OBJECT_INVALID",
              true,
              "历史素材对应的 Fanjin 对象不是普通文件",
            );
          }
          if (before.size > request.maximumBytes) {
            throw failure(
              "PORTRAIT_SOURCE_OBJECT_TOO_LARGE",
              true,
              "历史素材对象超过允许的完整性恢复上限",
            );
          }
          const hash = crypto.createHash("sha256");
          let total = 0;
          const stream = handle.createReadStream({
            autoClose: false,
            highWaterMark: 1024 * 1024,
            signal,
          });
          for await (const raw of stream) {
            signal.throwIfAborted();
            const chunk = raw as Buffer;
            total += chunk.byteLength;
            if (total > request.maximumBytes || total > before.size) {
              throw failure(
                "PORTRAIT_SOURCE_OBJECT_CHANGED",
                true,
                "历史素材对象在完整性恢复期间发生变化",
              );
            }
            hash.update(chunk);
          }
          const after = await handle.stat();
          const current = await fsp.lstat(filePath).catch(() => null);
          if (
            total !== before.size
            || after.dev !== before.dev
            || after.ino !== before.ino
            || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs
            || after.ctimeMs !== before.ctimeMs
            || !current
            || current.isSymbolicLink()
            || current.dev !== before.dev
            || current.ino !== before.ino
          ) {
            throw failure(
              "PORTRAIT_SOURCE_OBJECT_CHANGED",
              true,
              "历史素材对象在完整性恢复期间发生变化",
            );
          }
          return {
            sha256: hash.digest("hex"),
            byteSize: total,
            identity: {
              version: PORTRAIT_SOURCE_OBJECT_IDENTITY_VERSION,
              provider: "local",
              bucket: null,
              key: storageKey,
              versionId: `${before.dev}:${before.ino}`,
              etag: null,
              byteSize: total,
              lastModified: new Date(before.mtimeMs).toISOString(),
              contentType: null,
            },
          };
        } finally {
          await handle.close();
        }
      },
    };
  }

  const storage = input.storage ?? createRemoteObjectStorageAdapter(configuration);
  if (!storage.getSignedUrl) {
    throw failure(
      "PORTRAIT_SOURCE_PRIVATE_READ_UNAVAILABLE",
      true,
      "Fanjin 对象存储未提供私有固定对象读取能力",
    );
  }
  const getSignedUrl = storage.getSignedUrl.bind(storage);
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async hash(request) {
      const storageKey = normalizeObjectKey(request.storageKey);
      request.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(request.timeoutMs);
      const signal = AbortSignal.any([
        timeout,
        ...(request.signal ? [request.signal] : []),
      ]);
      const before = remoteIdentity(await storage.inspectGeneration(storageKey, { signal }));
      if (before.byteSize > request.maximumBytes) {
        throw failure(
          "PORTRAIT_SOURCE_OBJECT_TOO_LARGE",
          true,
          "历史素材对象超过允许的完整性恢复上限",
        );
      }
      const signedUrl = await getSignedUrl(storageKey, {
        versionId: before.versionId,
        expiresInSeconds: 900,
      });
      let response: Response;
      try {
        response = await fetchImpl(signedUrl, {
          method: "GET",
          redirect: "error",
          headers: { "accept-encoding": "identity" },
          signal,
        });
      } catch (error) {
        if (error instanceof PortraitSourceRecoveryError) throw error;
        if (signal.aborted) {
          throw failure(
            "PORTRAIT_SOURCE_OBJECT_READ_TIMEOUT",
            false,
            "读取 Fanjin 历史素材对象超时",
          );
        }
        throw failure(
          "PORTRAIT_SOURCE_OBJECT_READ_FAILED",
          false,
          "暂时无法读取 Fanjin 历史素材对象",
        );
      }
      const content = await hashWebStream({
        response,
        expected: before,
        maximumBytes: request.maximumBytes,
        signal,
      });
      // Re-read the *current* key generation. Reading the old exact version
      // again would miss an overwrite that happened while the historical
      // bytes were being hashed and would bind the Admission SHA to a stale
      // generation while normal consumers resolve the new current object.
      const after = remoteIdentity(await storage.inspectGeneration(storageKey, { signal }));
      if (!sameRemoteGeneration(before, after)) {
        throw failure(
          "PORTRAIT_SOURCE_OBJECT_CHANGED",
          true,
          "历史素材对象在完整性恢复期间发生变化",
        );
      }
      return { ...content, identity: before };
    },
  };
}

function materializableHistoricalQuery(database: Knex) {
  return database("o_image as version")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .leftJoin(
      `${PORTRAIT_ADMISSION_TABLE} as admission`,
      "admission.assetVersionId",
      "version.id",
    )
    .whereNull("admission.id")
    .where("version.deletionState", "active")
    .where("asset.deletionState", "active")
    .where("project.deletionState", "active")
    // Generation placeholders and failed versions are not usable project
    // media and therefore must not manufacture release-blocking Admissions.
    // A legacy selected version with a null state is included only when it
    // still carries storage evidence; completed rows with missing storageKey
    // remain included so the recovery records an explicit terminal reason.
    .where((builder) => builder
      .whereIn("version.state", DELIVERABLE_HISTORICAL_VERSION_STATES)
      .orWhere((legacySelected) => legacySelected
        .whereNull("version.state")
        .whereRaw('"asset"."imageId" = "version"."id"')
        .where((stored) => stored
          .whereNotNull("version.storageKey")
          .orWhereNotNull("version.filePath"))))
    .where((builder) => builder
      .whereIn("version.type", ["image", "video", "clip"])
      .orWhere((fallback) => fallback
        .whereNull("version.type")
        .whereIn("asset.type", ["image", "video", "clip"])))
    .whereNotNull("project.workspaceId");
}

async function materializeHistoricalAdmissions(input: {
  database: Knex;
  limit: number;
  now: number;
}): Promise<number> {
  const rows = await materializableHistoricalQuery(input.database)
    .select({
      workspaceId: "project.workspaceId",
      projectId: "project.id",
      assetId: "asset.id",
      assetVersionId: "version.id",
      versionType: "version.type",
      assetType: "asset.type",
    })
    .orderBy("version.id", "asc")
    .limit(input.limit) as Row[];
  let materialized = 0;
  for (const row of rows) {
    const resolvedType = mediaType(row.versionType) ?? mediaType(row.assetType);
    if (!resolvedType) continue;
    try {
      const admissionId = await createPortraitAdmissionForUpload({
        database: input.database,
        workspaceId: String(row.workspaceId),
        projectId: Number(row.projectId),
        assetId: Number(row.assetId),
        assetVersionId: Number(row.assetVersionId),
        mediaType: resolvedType,
        sourceSha256: null,
        now: input.now,
      });
      if (admissionId) materialized += 1;
    } catch (error) {
      const raced = await input.database(PORTRAIT_ADMISSION_TABLE)
        .where({ assetVersionId: row.assetVersionId })
        .first();
      if (!raced) throw error;
    }
  }
  return materialized;
}

function boundAssetQuery(database: Knex | Knex.Transaction, admissionId: string) {
  return database(`${PORTRAIT_ADMISSION_TABLE} as admission`)
    .innerJoin("o_image as version", "version.id", "admission.assetVersionId")
    .innerJoin("o_assets as asset", "asset.id", "admission.assetId")
    .innerJoin("o_project as project", "project.id", "admission.projectId")
    .where("admission.id", admissionId)
    .whereRaw('"version"."assetsId" = "asset"."id"')
    .whereRaw('"asset"."projectId" = "project"."id"')
    .whereRaw('"project"."workspaceId" = "admission"."workspaceId"')
    .whereRaw('"version"."id" = "admission"."assetVersionId"')
    .select(
      "admission.*",
      "version.storageKey as boundStorageKey",
      "version.filePath as boundFilePath",
      "version.type as boundVersionType",
      "version.deletionState as versionDeletionState",
      "asset.type as boundAssetType",
      "asset.deletionState as assetDeletionState",
      "project.deletionState as projectDeletionState",
    );
}

function cleanStorageKey(row: Row): string {
  const storageKey = String(row.boundStorageKey || "").trim();
  if (!storageKey) {
    throw failure(
      "PORTRAIT_SOURCE_STORAGE_KEY_MISSING",
      true,
      "历史素材缺少 Fanjin 对象存储键，需要重新上传或由运维修复",
    );
  }
  try {
    return normalizeObjectKey(storageKey);
  } catch {
    throw failure(
      "PORTRAIT_SOURCE_STORAGE_KEY_INVALID",
      true,
      "历史素材的 Fanjin 对象存储键无效，需要运维修复",
    );
  }
}

function assertBoundAsset(row: Row): { storageKey: string; mediaType: "image" | "video" } {
  if (
    String(row.versionDeletionState) !== "active"
    || String(row.assetDeletionState) !== "active"
    || String(row.projectDeletionState) !== "active"
  ) {
    throw failure(
      "PORTRAIT_SOURCE_ASSET_DELETED",
      true,
      "历史素材或所属项目已删除，不能恢复人像准入证据",
    );
  }
  const resolvedType = mediaType(row.boundVersionType) ?? mediaType(row.boundAssetType);
  if (!resolvedType || resolvedType !== mediaType(row.mediaType)) {
    throw failure(
      "PORTRAIT_SOURCE_BINDING_CHANGED",
      true,
      "历史素材的媒体类型或项目绑定已变化，需要运维核对",
    );
  }
  return { storageKey: cleanStorageKey(row), mediaType: resolvedType };
}

function recoveryError(error: unknown): PortraitSourceRecoveryError {
  if (error instanceof PortraitSourceRecoveryError) return error;
  return failure(
    "PORTRAIT_SOURCE_RECOVERY_FAILED",
    false,
    "历史素材完整性恢复暂时失败",
  );
}

function assertRecoveryResult(input: {
  result: PortraitSourceHashResult;
  storageKey: string;
  maximumBytes: number;
}): void {
  let identityKey: string;
  try {
    identityKey = normalizeObjectKey(input.result.identity.key);
  } catch {
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_IDENTITY_INVALID",
      true,
      "历史素材对象完整性证据无效，需要运维核对",
    );
  }
  if (
    !/^[a-f0-9]{64}$/u.test(input.result.sha256)
    || !Number.isSafeInteger(input.result.byteSize)
    || input.result.byteSize < 0
    || input.result.byteSize > input.maximumBytes
    || input.result.identity.version !== PORTRAIT_SOURCE_OBJECT_IDENTITY_VERSION
    || !["local", "s3", "tos"].includes(input.result.identity.provider)
    || identityKey !== input.storageKey
    || input.result.identity.byteSize !== input.result.byteSize
  ) {
    throw failure(
      "PORTRAIT_SOURCE_OBJECT_IDENTITY_INVALID",
      true,
      "历史素材对象完整性证据无效，需要运维核对",
    );
  }
}

function sameBoundAsset(before: Row, after: Row): boolean {
  return String(before.workspaceId) === String(after.workspaceId)
    && Number(before.projectId) === Number(after.projectId)
    && Number(before.assetId) === Number(after.assetId)
    && Number(before.assetVersionId) === Number(after.assetVersionId)
    && String(before.mediaType) === String(after.mediaType)
    && String(before.boundStorageKey || "") === String(after.boundStorageKey || "")
    && String(before.boundFilePath || "") === String(after.boundFilePath || "")
    && String(before.boundVersionType || "") === String(after.boundVersionType || "")
    && String(before.boundAssetType || "") === String(after.boundAssetType || "")
    && String(after.versionDeletionState) === "active"
    && String(after.assetDeletionState) === "active"
    && String(after.projectDeletionState) === "active";
}

async function finalizeRecovery(input: {
  database: Knex;
  before: Row;
  claimRevision: number;
  workerId: string;
  result: PortraitSourceHashResult;
  now: number;
}): Promise<boolean> {
  return input.database.transaction(async (transaction) => {
    const current = await boundAssetQuery(transaction, String(input.before.id))
      .where({
        "admission.revision": input.claimRevision,
        "admission.sourceRecoveryState": "hashing",
        "admission.sourceRecoveryLeaseOwner": input.workerId,
      })
      .forUpdate()
      .first();
    if (!current || !sameBoundAsset(input.before, current)) {
      // The authoritative version/asset/project row may have been removed
      // after hashing. Persist the terminal reason on the still-live
      // Admission using the same lease/revision CAS instead of leaving a
      // restart loop stuck in `hashing`.
      await transaction(PORTRAIT_ADMISSION_TABLE)
        .where({
          id: input.before.id,
          revision: input.claimRevision,
          sourceRecoveryState: "hashing",
          sourceRecoveryLeaseOwner: input.workerId,
        })
        .whereNull("sourceSha256")
        .update({
          sourceRecoveryState: "terminal",
          sourceRecoveryLeaseOwner: null,
          sourceRecoveryLeaseExpiresAt: null,
          sourceRecoveryFailureCode: "PORTRAIT_SOURCE_BINDING_CHANGED",
          sourceRecoveryFailureMessage: "历史素材绑定在完整性恢复期间发生变化，需要运维核对",
          safeErrorCode: "PORTRAIT_SOURCE_BINDING_CHANGED",
          safeErrorMessage: "历史素材完整性证据失效，请联系管理员",
          revision: input.claimRevision + 1,
          updatedAt: input.now,
        });
      return false;
    }
    const changed = await transaction(PORTRAIT_ADMISSION_TABLE)
      .where({
        id: input.before.id,
        revision: input.claimRevision,
        sourceRecoveryState: "hashing",
        sourceRecoveryLeaseOwner: input.workerId,
      })
      .whereNull("sourceSha256")
      .update({
        sourceSha256: input.result.sha256,
        sourceRecoveryState: "ready",
        sourceRecoveryNextAttemptAt: input.now,
        sourceRecoveryLeaseOwner: null,
        sourceRecoveryLeaseExpiresAt: null,
        sourceRecoveryObjectIdentityJson: stableJson(input.result.identity),
        sourceRecoveryFailureCode: null,
        sourceRecoveryFailureMessage: null,
        safeErrorCode: null,
        safeErrorMessage: null,
        revision: input.claimRevision + 1,
        updatedAt: input.now,
      });
    return Number(changed) === 1;
  });
}

function retryDelay(input: {
  attempts: number;
  baseMs: number;
  maximumMs: number;
}): number {
  const exponent = Math.min(20, Math.max(0, input.attempts - 1));
  return Math.min(input.maximumMs, input.baseMs * 2 ** exponent);
}

async function persistFailure(input: {
  database: Knex;
  admissionId: string;
  claimRevision: number;
  workerId: string;
  attempts: number;
  maximumAttempts: number;
  error: PortraitSourceRecoveryError;
  now: number;
  retryBaseMs: number;
  retryMaximumMs: number;
}): Promise<"retry" | "terminal" | null> {
  const terminal = input.error.permanent || input.attempts >= input.maximumAttempts;
  const state = terminal ? "terminal" : "retry";
  const changed = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({
      id: input.admissionId,
      revision: input.claimRevision,
      sourceRecoveryState: "hashing",
      sourceRecoveryLeaseOwner: input.workerId,
    })
    .whereNull("sourceSha256")
    .update({
      sourceRecoveryState: state,
      sourceRecoveryNextAttemptAt: terminal
        ? input.now
        : input.now + retryDelay({
            attempts: input.attempts,
            baseMs: input.retryBaseMs,
            maximumMs: input.retryMaximumMs,
          }),
      sourceRecoveryLeaseOwner: null,
      sourceRecoveryLeaseExpiresAt: null,
      sourceRecoveryFailureCode: input.error.code,
      sourceRecoveryFailureMessage: input.error.operatorMessage,
      safeErrorCode: input.error.code,
      safeErrorMessage: terminal
        ? "历史素材完整性证据无法恢复，请联系管理员"
        : "历史素材完整性证据正在恢复，请稍后重试",
      revision: input.claimRevision + 1,
      updatedAt: input.now,
    });
  return Number(changed) === 1 ? state : null;
}

function createLeaseHeartbeat(input: {
  database: Knex;
  admissionId: string;
  claimRevision: number;
  workerId: string;
  leaseMs: number;
  now: () => number;
}) {
  const controller = new AbortController();
  let failureValue: unknown = null;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight || failureValue) return;
    inFlight = input.database(PORTRAIT_ADMISSION_TABLE)
      .where({
        id: input.admissionId,
        revision: input.claimRevision,
        sourceRecoveryState: "hashing",
        sourceRecoveryLeaseOwner: input.workerId,
      })
      .update({ sourceRecoveryLeaseExpiresAt: input.now() + input.leaseMs })
      .then((changed) => {
        if (Number(changed) !== 1) throw new Error("PORTRAIT_SOURCE_RECOVERY_LEASE_LOST");
      })
      .catch((error) => {
        failureValue = error;
        controller.abort(error);
      })
      .finally(() => { inFlight = null; });
  }, Math.max(1_000, Math.floor(input.leaseMs / 3)));
  timer.unref?.();
  return {
    signal: controller.signal,
    get failure(): unknown { return failureValue; },
    async stop(): Promise<void> {
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}

export async function runPortraitSourceRecoveryBatch(
  runtime: PortraitSourceRecoveryRuntime = {},
  options: { limit?: number } = {},
): Promise<PortraitSourceRecoveryReport> {
  const database = runtime.database;
  if (!database) {
    throw new Error("PORTRAIT_SOURCE_RECOVERY_DATABASE_REQUIRED");
  }
  const now = runtime.now ?? Date.now;
  const startedAt = now();
  const limit = boundedInteger(options.limit, DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT, "PORTRAIT_SOURCE_BATCH_LIMIT_INVALID");
  const maximumBytes = boundedInteger(
    runtime.maximumBytes ?? process.env.FANJIN_PORTRAIT_SOURCE_RECOVERY_MAX_BYTES,
    DEFAULT_MAXIMUM_BYTES,
    1,
    MAXIMUM_BYTES_CAP,
    "PORTRAIT_SOURCE_MAXIMUM_BYTES_INVALID",
  );
  const timeoutMs = boundedInteger(
    runtime.timeoutMs ?? process.env.FANJIN_PORTRAIT_SOURCE_RECOVERY_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    2 * 60 * 60_000,
    "PORTRAIT_SOURCE_TIMEOUT_INVALID",
  );
  const leaseMs = boundedInteger(
    runtime.leaseMs ?? process.env.FANJIN_PORTRAIT_SOURCE_RECOVERY_LEASE_MS,
    DEFAULT_LEASE_MS,
    10_000,
    2 * 60 * 60_000,
    "PORTRAIT_SOURCE_LEASE_INVALID",
  );
  const maximumAttempts = boundedInteger(
    runtime.maximumAttempts ?? process.env.FANJIN_PORTRAIT_SOURCE_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    1,
    20,
    "PORTRAIT_SOURCE_ATTEMPTS_INVALID",
  );
  const retryBaseMs = boundedInteger(
    runtime.retryBaseMs,
    DEFAULT_RETRY_BASE_MS,
    1,
    60 * 60_000,
    "PORTRAIT_SOURCE_RETRY_BASE_INVALID",
  );
  const retryMaximumMs = boundedInteger(
    runtime.retryMaximumMs,
    DEFAULT_RETRY_MAX_MS,
    retryBaseMs,
    24 * 60 * 60_000,
    "PORTRAIT_SOURCE_RETRY_MAXIMUM_INVALID",
  );
  const workerId = runtime.workerId
    ?? `portrait-source-recovery:${process.pid}:${crypto.randomUUID()}`;
  const materialized = await materializeHistoricalAdmissions({
    database,
    limit,
    now: startedAt,
  });
  const rows = await database(PORTRAIT_ADMISSION_TABLE)
    .whereNull("sourceSha256")
    .where((builder) => builder
      .where((due) => due
        .whereIn("sourceRecoveryState", ["pending", "retry"])
        .andWhere("sourceRecoveryNextAttemptAt", "<=", startedAt))
      .orWhere((stale) => stale
        .where("sourceRecoveryState", "hashing")
        .andWhere("sourceRecoveryLeaseExpiresAt", "<=", startedAt)))
    .orderBy("sourceRecoveryNextAttemptAt", "asc")
    .orderBy("assetVersionId", "asc")
    .limit(limit)
    .select(
      "id",
      "revision",
      "sourceRecoveryAttempts",
      "sourceRecoveryState",
      "sourceRecoveryNextAttemptAt",
      "sourceRecoveryLeaseExpiresAt",
    ) as Row[];
  const reader = runtime.reader ?? createPortraitSourceHashReader({
    ...(runtime.configuration ? { configuration: runtime.configuration } : {}),
    ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
    ...(runtime.storage ? { storage: runtime.storage } : {}),
  });
  let claimed = 0;
  let recovered = 0;
  let retried = 0;
  let terminal = 0;
  for (const candidate of rows) {
    runtime.signal?.throwIfAborted();
    const revision = Number(candidate.revision);
    const previousAttempts = Number(candidate.sourceRecoveryAttempts || 0);
    if (previousAttempts >= maximumAttempts) {
      const exhaustedAt = now();
      const exhausted = await database(PORTRAIT_ADMISSION_TABLE)
        .where({ id: candidate.id, revision })
        .whereNull("sourceSha256")
        .where((builder) => builder
          .where((due) => due
            .whereIn("sourceRecoveryState", ["pending", "retry"])
            .andWhere("sourceRecoveryNextAttemptAt", "<=", startedAt))
          .orWhere((stale) => stale
            .where("sourceRecoveryState", "hashing")
            .andWhere("sourceRecoveryLeaseExpiresAt", "<=", startedAt)))
        .update({
          sourceRecoveryState: "terminal",
          sourceRecoveryNextAttemptAt: exhaustedAt,
          sourceRecoveryLeaseOwner: null,
          sourceRecoveryLeaseExpiresAt: null,
          sourceRecoveryFailureCode: "PORTRAIT_SOURCE_RECOVERY_ATTEMPTS_EXHAUSTED",
          sourceRecoveryFailureMessage: "历史素材完整性恢复已达到最大尝试次数，需要运维核对",
          safeErrorCode: "PORTRAIT_SOURCE_RECOVERY_ATTEMPTS_EXHAUSTED",
          safeErrorMessage: "历史素材完整性证据无法恢复，请联系管理员",
          revision: revision + 1,
          updatedAt: exhaustedAt,
        });
      if (Number(exhausted) === 1) terminal += 1;
      continue;
    }
    const attempts = previousAttempts + 1;
    const claimedAt = now();
    const changed = await database(PORTRAIT_ADMISSION_TABLE)
      .where({ id: candidate.id, revision })
      .whereNull("sourceSha256")
      .where((builder) => builder
        .where((due) => due
          .whereIn("sourceRecoveryState", ["pending", "retry"])
          .andWhere("sourceRecoveryNextAttemptAt", "<=", startedAt))
        .orWhere((stale) => stale
          .where("sourceRecoveryState", "hashing")
          .andWhere("sourceRecoveryLeaseExpiresAt", "<=", startedAt)))
      .update({
        sourceRecoveryState: "hashing",
        sourceRecoveryAttempts: attempts,
        sourceRecoveryLeaseOwner: workerId,
        sourceRecoveryLeaseExpiresAt: claimedAt + leaseMs,
        sourceRecoveryFailureCode: null,
        sourceRecoveryFailureMessage: null,
        revision: revision + 1,
        updatedAt: claimedAt,
      });
    if (Number(changed) !== 1) continue;
    claimed += 1;
    const claimRevision = revision + 1;
    const heartbeat = createLeaseHeartbeat({
      database,
      admissionId: String(candidate.id),
      claimRevision,
      workerId,
      leaseMs,
      now,
    });
    try {
      const before = await boundAssetQuery(database, String(candidate.id)).first();
      if (!before) {
        throw failure(
          "PORTRAIT_SOURCE_BINDING_CHANGED",
          true,
          "历史素材的工作区、项目或版本绑定无效，需要运维核对",
        );
      }
      const binding = assertBoundAsset(before);
      const durableSha = await resolveDurablePortraitSourceSha256({
        database,
        workspaceId: String(before.workspaceId),
        projectId: Number(before.projectId),
        assetId: Number(before.assetId),
        assetVersionId: Number(before.assetVersionId),
        storageKey: binding.storageKey,
      });
      const result = await reader.hash({
        storageKey: binding.storageKey,
        maximumBytes,
        timeoutMs,
        signal: AbortSignal.any([
          heartbeat.signal,
          ...(runtime.signal ? [runtime.signal] : []),
        ]),
      });
      assertRecoveryResult({ result, storageKey: binding.storageKey, maximumBytes });
      if (durableSha && durableSha !== result.sha256) {
        throw failure(
          "PORTRAIT_SOURCE_COMMITTED_DIGEST_MISMATCH",
          true,
          "历史素材当前对象与已提交写入摘要不一致，需要运维核对",
        );
      }
      await heartbeat.stop();
      if (heartbeat.failure) throw heartbeat.failure;
      if (await finalizeRecovery({
        database,
        before,
        claimRevision,
        workerId,
        result,
        now: now(),
      })) recovered += 1;
      else terminal += 1;
    } catch (rawError) {
      await heartbeat.stop();
      const state = await persistFailure({
        database,
        admissionId: String(candidate.id),
        claimRevision,
        workerId,
        attempts,
        maximumAttempts,
        error: recoveryError(rawError),
        now: now(),
        retryBaseMs,
        retryMaximumMs,
      });
      if (state === "retry") retried += 1;
      if (state === "terminal") terminal += 1;
    }
  }
  return { materialized, claimed, recovered, retried, terminal };
}

async function missingAdmissionCount(database: Knex): Promise<number> {
  const row = await materializableHistoricalQuery(database)
    .count<{ total: string | number }[]>({ total: "*" })
    .first() as { total?: string | number } | undefined;
  return Number(row?.total || 0);
}

export async function inspectPortraitSourceRecovery(
  database: Knex,
): Promise<PortraitSourceRecoveryInspection> {
  const grouped = await database(PORTRAIT_ADMISSION_TABLE)
    .select("sourceRecoveryState")
    .count<{ sourceRecoveryState: RecoveryState; total: string | number }[]>({ total: "*" })
    .groupBy("sourceRecoveryState");
  const states: Record<RecoveryState, number> = {
    pending: 0,
    hashing: 0,
    retry: 0,
    ready: 0,
    terminal: 0,
  };
  for (const row of grouped) {
    if (row.sourceRecoveryState in states) {
      states[row.sourceRecoveryState] = Number(row.total || 0);
    }
  }
  const missingAdmissions = await missingAdmissionCount(database);
  const failures = await database(PORTRAIT_ADMISSION_TABLE)
    .where("sourceRecoveryState", "terminal")
    .orderBy("updatedAt", "asc")
    .limit(50)
    .select(
      "id",
      "assetVersionId",
      "sourceRecoveryFailureCode",
      "sourceRecoveryFailureMessage",
    );
  return {
    ready: missingAdmissions === 0
      && states.pending === 0
      && states.hashing === 0
      && states.retry === 0
      && states.terminal === 0,
    missingAdmissions,
    states,
    operatorFailures: failures.map((row: Row) => ({
      admissionId: String(row.id),
      assetVersionId: Number(row.assetVersionId),
      code: String(row.sourceRecoveryFailureCode || "PORTRAIT_SOURCE_RECOVERY_FAILED"),
      reason: String(row.sourceRecoveryFailureMessage || "历史素材完整性恢复失败"),
    })),
  };
}

let workerTimer: NodeJS.Timeout | null = null;
let workerTick: Promise<unknown> | null = null;
let workerRunning = false;
let workerLastTickAt: number | null = null;
let workerLastSuccessAt: number | null = null;
let workerLastFailureAt: number | null = null;
let workerSafeReason: PortraitSourceRecoveryWorkerInspection["safeReason"] = null;

export function inspectPortraitSourceRecoveryWorker(): PortraitSourceRecoveryWorkerInspection {
  return Object.freeze({
    running: workerRunning,
    inFlight: workerTick !== null,
    lastTickAt: workerLastTickAt,
    lastSuccessAt: workerLastSuccessAt,
    lastFailureAt: workerLastFailureAt,
    safeReason: workerSafeReason,
  });
}

export function startPortraitSourceRecoveryWorker(database: Knex): void {
  if (workerRunning) return;
  workerRunning = true;
  workerSafeReason = null;
  const run = () => {
    if (!workerRunning || workerTick) return;
    workerLastTickAt = Date.now();
    workerTick = runPortraitSourceRecoveryBatch({ database })
      .then(() => {
        workerLastSuccessAt = Date.now();
        workerSafeReason = null;
      })
      .catch((rawError) => {
        workerLastFailureAt = Date.now();
        workerSafeReason = "portrait_source_recovery_worker_tick_failed";
        logger.error({
          code: recoveryError(rawError).code,
          worker: "portrait-source-recovery",
        }, "Portrait source recovery worker tick failed");
      })
      .finally(() => { workerTick = null; });
  };
  run();
  workerTimer = setInterval(run, 10_000);
  workerTimer.unref?.();
}

export async function stopPortraitSourceRecoveryWorker(): Promise<void> {
  workerRunning = false;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerTick;
}
