import crypto from "node:crypto";
import { releaseWorkspaceStorage, releaseWorkspaceStoredGeneration } from "./workspaceResources";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import isPathInside from "is-path-inside";
import type { Knex } from "knex";
import {
  CONDITIONAL_DELETION_PROVIDER_CONTRACT,
  type ConditionalDeletionCapabilityProofV1,
  type ConditionalDeletionContextV1,
  type ConditionalDeletionDispatchEvidenceV1,
  type ConditionalDeletionProviderOperationV1,
  type ConditionalDeletionProviderV1,
  type ConditionalDeletionResultV1,
} from "@/lib/deletionOutbox";
import {
  objectWriteProviderIdentity,
  parseObjectWriteReceiptEvidence,
  parseObjectWriteReferenceEvidence,
  type ObjectWriteIntentRecord,
  type ObjectWriteReferenceEvidence,
} from "@/lib/objectWriteIntent";
import { OBJECT_WRITE_INTENT_TABLE } from "@/lib/migrations/objectWriteIntent";
import {
  createRemoteObjectStorageAdapter,
  normalizeObjectKey,
  ObjectStorageUpstreamError,
  type ObjectStorageAdapter,
  type ObjectStorageGenerationSnapshot,
  type ObjectStorageGenerationSnapshotPageOptions,
} from "@/lib/objectStorage";
import {
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import getPath from "@/utils/getPath";

const STORAGE_DELETION_TOKEN_VERSION = "object-storage-delete-target.v2" as const;
const STORAGE_DELETION_TOKEN_PREFIX = "osdt2.";
const LOCAL_STORAGE_DELETION_TOKEN_VERSION =
  "local-object-storage-delete-target.v1" as const;
const LOCAL_STORAGE_DELETION_TOKEN_PREFIX = "losdt1.";
const LOCAL_STORAGE_QUARANTINE_ROOT =
  ".fanjin-local-delete-quarantine" as const;
const LOCAL_STORAGE_QUARANTINE_MARKER = "captured" as const;
const MAX_LOCAL_QUARANTINE_ATTEMPTS = 32;

type StorageDeletionTokenV2 = {
  version: typeof STORAGE_DELETION_TOKEN_VERSION;
  targetBinding: string;
  exists: boolean;
  deleteMarker: boolean;
  etag: string | null;
  versionId: string | null;
};

type LocalStorageDeletionTokenV1 = {
  version: typeof LOCAL_STORAGE_DELETION_TOKEN_VERSION;
  providerFingerprint: string;
  rootFingerprint: string;
  bucket: string;
  objectKey: string;
  intentId: string;
  receiptHash: string;
  referenceHash: string;
  size: number;
  sha256: string;
  device: string;
  inode: string;
  mtimeNs: string;
  ctimeNs: string;
};

export interface CapturedStorageDeletionTarget {
  bucket: string;
  objectKey: string;
  deleteType: "file";
  exists?: boolean;
  deleteMarker?: boolean;
  targetGeneration: string;
  conditionalToken: string;
}

export interface ObjectStorageDeletionRuntime {
  configuration?: ObjectStorageConfiguration;
  storage?: ObjectStorageAdapter;
  database?: Knex;
  localRootDir?: string;
  signal?: AbortSignal;
}

export interface CapturedStoragePrefixDeletionTargetPage {
  providerId: string;
  providerFingerprint: string;
  bucket: string;
  objectPrefix: string;
  targets: CapturedStorageDeletionTarget[];
  truncated: boolean;
  keyMarker: string | null;
  versionIdMarker: string | null;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function inputInvalid(code: string): never {
  throw new ObjectStorageUpstreamError(code, 400);
}

function preconditionFailed(): never {
  throw new ObjectStorageUpstreamError(
    "OBJECT_STORAGE_GENERATION_PRECONDITION_FAILED",
    412,
  );
}

function localDeletionRuntimeAllowed(): void {
  if (!["dev", "test"].includes(String(process.env.NODE_ENV || ""))) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LOCAL_CONDITIONAL_DELETE_FORBIDDEN",
      503,
    );
  }
}

function defaultDeletionDatabase(): Knex {
  const databaseModule = require("@/utils/db") as typeof import("@/utils/db");
  return databaseModule.db as unknown as Knex;
}

function localRootDir(runtime: ObjectStorageDeletionRuntime): string {
  return path.resolve(runtime.localRootDir || getPath("oss"));
}

function realLocalRoot(runtime: ObjectStorageDeletionRuntime): string {
  localDeletionRuntimeAllowed();
  const configuredRoot = localRootDir(runtime);
  try {
    const realRoot = fsSync.realpathSync(configuredRoot);
    const stat = fsSync.statSync(realRoot);
    if (!stat.isDirectory()) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_LOCAL_ROOT_INVALID",
        503,
      );
    }
    return realRoot;
  } catch (error) {
    if (error instanceof ObjectStorageUpstreamError) throw error;
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LOCAL_ROOT_INVALID",
      503,
    );
  }
}

function localRootFingerprint(realRoot: string): string {
  return sha256(JSON.stringify([
    "local-object-storage-root.v1",
    realRoot,
  ]));
}

function localBucket(rootFingerprint: string): string {
  return `local-${rootFingerprint.slice(0, 48)}`;
}

function localProviderId(
  configuration: ObjectStorageConfiguration,
  rootFingerprint: string,
): string {
  return `local-object-storage-delete:${sha256(JSON.stringify([
    objectWriteProviderIdentity(configuration).providerFingerprint,
    rootFingerprint,
  ]))}`;
}

function localRuntime(
  runtime: ObjectStorageDeletionRuntime,
): {
  configuration: ObjectStorageConfiguration & { provider: "local" };
  database: Knex;
  realRoot: string;
  rootFingerprint: string;
  bucket: string;
  providerId: string;
} {
  const configuration =
    runtime.configuration ?? resolveObjectStorageConfiguration();
  if (configuration.provider !== "local") {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LOCAL_PROVIDER_REQUIRED",
      503,
    );
  }
  const realRoot = realLocalRoot(runtime);
  const rootFingerprint = localRootFingerprint(realRoot);
  return {
    configuration: configuration as ObjectStorageConfiguration & {
      provider: "local";
    },
    database: runtime.database ?? defaultDeletionDatabase(),
    realRoot,
    rootFingerprint,
    bucket: localBucket(rootFingerprint),
    providerId: localProviderId(configuration, rootFingerprint),
  };
}

function safeLocalObjectPath(realRoot: string, key: string): string {
  const normalizedKey = normalizeObjectKey(key);
  if (
    normalizedKey === LOCAL_STORAGE_QUARANTINE_ROOT
    || normalizedKey.startsWith(`${LOCAL_STORAGE_QUARANTINE_ROOT}/`)
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LOCAL_PATH_INVALID",
      400,
    );
  }
  const candidate = path.resolve(
    realRoot,
    ...normalizedKey.split("/"),
  );
  if (!isPathInside(candidate, realRoot)) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LOCAL_PATH_INVALID",
      400,
    );
  }
  return candidate;
}

type LocalFileGeneration = Pick<
  LocalStorageDeletionTokenV1,
  "size" | "sha256" | "device" | "inode" | "mtimeNs" | "ctimeNs"
>;

function sameLocalGeneration(
  left: LocalFileGeneration,
  right: LocalFileGeneration,
): boolean {
  return left.size === right.size
    && left.sha256 === right.sha256
    && left.device === right.device
    && left.inode === right.inode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameQuarantinedLocalGeneration(
  left: LocalFileGeneration,
  right: LocalFileGeneration,
): boolean {
  // Moving the same inode to quarantine can advance ctime. The remaining
  // identity, content and mtime fields prove that the entry moved was the
  // generation opened immediately before rename.
  return left.size === right.size
    && left.sha256 === right.sha256
    && left.device === right.device
    && left.inode === right.inode
    && left.mtimeNs === right.mtimeNs;
}

async function inspectLocalFileGeneration(
  realRoot: string,
  key: string,
  signal?: AbortSignal,
): Promise<LocalFileGeneration | null> {
  const objectPath = safeLocalObjectPath(realRoot, key);
  return await inspectLocalAbsoluteFileGeneration(realRoot, objectPath, signal);
}

async function inspectLocalAbsoluteFileGeneration(
  realRoot: string,
  objectPath: string,
  signal?: AbortSignal,
): Promise<LocalFileGeneration | null> {
  signal?.throwIfAborted();
  const resolvedPath = path.resolve(objectPath);
  if (
    resolvedPath !== objectPath
    || !isPathInside(resolvedPath, realRoot)
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LOCAL_PATH_INVALID",
      400,
    );
  }
  let parentRealPath: string;
  try {
    parentRealPath = await fs.realpath(path.dirname(resolvedPath));
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    parentRealPath !== realRoot
    && !isPathInside(parentRealPath, realRoot)
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LOCAL_PATH_INVALID",
      400,
    );
  }
  let handle;
  try {
    handle = await fs.open(
      resolvedPath,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
    );
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP" || error?.code === "EPERM") {
      // Windows reports EPERM rather than ELOOP for O_NOFOLLOW when the
      // target is a symlink. Confirm the entry type before mapping the error
      // so genuine permission failures are not hidden.
      try {
        if ((await fs.lstat(resolvedPath)).isSymbolicLink()) {
          throw new ObjectStorageUpstreamError(
            "OBJECT_STORAGE_LOCAL_SYMLINK_FORBIDDEN",
            409,
          );
        }
      } catch (lstatError: any) {
        if (lstatError instanceof ObjectStorageUpstreamError) throw lstatError;
        if (lstatError?.code === "ENOENT") return null;
        throw error;
      }
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_LOCAL_FILE_INVALID",
        409,
      );
    }
    const resolvedObjectPath = await fs.realpath(resolvedPath);
    if (!isPathInside(resolvedObjectPath, realRoot)) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_LOCAL_PATH_INVALID",
        400,
      );
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_LOCAL_FILE_INVALID",
        409,
      );
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < size) {
      signal?.throwIfAborted();
      const length = Math.min(buffer.byteLength, size - position);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        length,
        position,
      );
      if (bytesRead <= 0) preconditionFailed();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    const unchanged =
      before.dev === after.dev
      && before.ino === after.ino
      && before.size === after.size
      && before.mtimeNs === after.mtimeNs
      && before.ctimeNs === after.ctimeNs;
    if (!unchanged) preconditionFailed();
    return {
      size,
      sha256: hash.digest("hex"),
      device: String(after.dev),
      inode: String(after.ino),
      mtimeNs: String(after.mtimeNs),
      ctimeNs: String(after.ctimeNs),
    };
  } finally {
    await handle.close();
  }
}

async function restoreQuarantinedLocalEntry(
  quarantinePath: string,
  objectPath: string,
): Promise<boolean> {
  try {
    const entry = await fs.lstat(quarantinePath);
    if (entry.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(quarantinePath), objectPath);
    } else if (entry.isFile()) {
      await fs.link(quarantinePath, objectPath);
    } else {
      return false;
    }
    await fs.unlink(quarantinePath);
    return true;
  } catch (error: any) {
    // Never overwrite a concurrently-created replacement. If recovery cannot
    // safely restore the moved entry, leave it in the private
    // quarantine for manual recovery and fail closed.
    if (error?.code === "EEXIST") {
      let quarantineStat;
      let objectStat;
      try {
        [quarantineStat, objectStat] = await Promise.all([
          fs.lstat(quarantinePath, { bigint: true }),
          fs.lstat(objectPath, { bigint: true }),
        ]);
      } catch (statError: any) {
        if (statError?.code === "ENOENT") return false;
        throw statError;
      }
      if (
        quarantineStat.isFile()
        && objectStat.isFile()
        && quarantineStat.dev === objectStat.dev
        && quarantineStat.ino === objectStat.ino
      ) {
        try {
          await fs.unlink(quarantinePath);
        } catch (unlinkError: any) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
        return true;
      }
      return false;
    }
    throw error;
  }
}

type LocalQuarantinePaths = {
  rootDir: string;
  operationDir: string;
  markerPath: string;
  markerEvidence: string;
};

type LocalQuarantineAttempt = {
  directory: string;
  targetPath: string;
  generation: LocalFileGeneration;
};

function localQuarantinePaths(
  realRoot: string,
  providerId: string,
  context: ConditionalDeletionContextV1,
  token: LocalStorageDeletionTokenV1,
): LocalQuarantinePaths {
  const markerEvidence = sha256(JSON.stringify([
    "local-object-storage-delete-quarantine.v1",
    providerId,
    context.idempotencyKey,
    context.targetFingerprint,
    context.targetGeneration,
    serializeLocalToken(token),
  ]));
  const rootDir = path.join(realRoot, LOCAL_STORAGE_QUARANTINE_ROOT);
  const operationDir = path.join(rootDir, markerEvidence);
  return {
    rootDir,
    operationDir,
    markerPath: path.join(operationDir, LOCAL_STORAGE_QUARANTINE_MARKER),
    markerEvidence,
  };
}

function localQuarantineInvalid(): never {
  throw new ObjectStorageUpstreamError(
    "OBJECT_STORAGE_LOCAL_QUARANTINE_INVALID",
    409,
  );
}

async function assertPrivateLocalQuarantineDirectory(
  realRoot: string,
  directory: string,
): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error: any) {
    if (error?.code === "ENOENT") localQuarantineInvalid();
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    localQuarantineInvalid();
  }
  const realDirectory = await fs.realpath(directory);
  if (
    realDirectory !== path.resolve(directory)
    || !isPathInside(realDirectory, realRoot)
    || (
      process.platform !== "win32"
      && (stat.mode & 0o077) !== 0
    )
  ) {
    localQuarantineInvalid();
  }
}

async function ensurePrivateLocalQuarantineDirectory(
  realRoot: string,
  directory: string,
): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertPrivateLocalQuarantineDirectory(realRoot, directory);
}

async function readLocalQuarantineMarker(
  realRoot: string,
  paths: LocalQuarantinePaths,
): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(
      paths.markerPath,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
    );
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "ELOOP" || error?.code === "EPERM") {
      localQuarantineInvalid();
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.size !== 0
      || (
        process.platform !== "win32"
        && (stat.mode & 0o077) !== 0
      )
    ) {
      localQuarantineInvalid();
    }
    const resolvedMarker = await fs.realpath(paths.markerPath);
    if (!isPathInside(resolvedMarker, realRoot)) localQuarantineInvalid();
    return true;
  } finally {
    await handle.close();
  }
}

async function writeLocalQuarantineMarker(
  realRoot: string,
  paths: LocalQuarantinePaths,
): Promise<void> {
  let handle;
  try {
    handle = await fs.open(paths.markerPath, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      if (!(await readLocalQuarantineMarker(realRoot, paths))) {
        localQuarantineInvalid();
      }
      return;
    }
    throw error;
  }
  try {
    // The operation directory name is already the SHA-256 binding for the
    // provider, idempotency key, fingerprint and exact target generation.
    // Creating this empty file with O_EXCL is therefore the atomic commit
    // point; there is no partially-written marker state after a crash.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectLocalQuarantine(
  realRoot: string,
  paths: LocalQuarantinePaths,
  token: LocalStorageDeletionTokenV1,
  signal?: AbortSignal,
): Promise<{
  marker: boolean;
  attempts: LocalQuarantineAttempt[];
}> {
  signal?.throwIfAborted();
  let rootStat;
  try {
    rootStat = await fs.lstat(paths.rootDir);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { marker: false, attempts: [] };
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    localQuarantineInvalid();
  }
  await assertPrivateLocalQuarantineDirectory(realRoot, paths.rootDir);
  try {
    await fs.lstat(paths.operationDir);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { marker: false, attempts: [] };
    throw error;
  }
  await assertPrivateLocalQuarantineDirectory(realRoot, paths.operationDir);
  const entries = await fs.readdir(paths.operationDir, { withFileTypes: true });
  if (entries.length > MAX_LOCAL_QUARANTINE_ATTEMPTS + 1) {
    localQuarantineInvalid();
  }
  const attempts: LocalQuarantineAttempt[] = [];
  for (const entry of entries) {
    if (entry.name === LOCAL_STORAGE_QUARANTINE_MARKER) continue;
    if (!entry.name.startsWith("attempt-") || !entry.isDirectory()) {
      localQuarantineInvalid();
    }
    const directory = path.join(paths.operationDir, entry.name);
    await assertPrivateLocalQuarantineDirectory(realRoot, directory);
    const attemptEntries = await fs.readdir(directory, {
      withFileTypes: true,
    });
    if (!attemptEntries.length) {
      await fs.rmdir(directory).catch(() => undefined);
      continue;
    }
    if (
      attemptEntries.length !== 1
      || attemptEntries[0].name !== "target"
      || !attemptEntries[0].isFile()
    ) {
      localQuarantineInvalid();
    }
    const targetPath = path.join(directory, "target");
    const generation = await inspectLocalAbsoluteFileGeneration(
      realRoot,
      targetPath,
      signal,
    );
    if (!generation) continue;
    attempts.push({ directory, targetPath, generation });
  }
  return {
    marker: await readLocalQuarantineMarker(realRoot, paths),
    attempts,
  };
}

async function ensureLocalQuarantinePaths(
  realRoot: string,
  paths: LocalQuarantinePaths,
): Promise<void> {
  await ensurePrivateLocalQuarantineDirectory(realRoot, paths.rootDir);
  await ensurePrivateLocalQuarantineDirectory(realRoot, paths.operationDir);
}

async function cleanupLocalQuarantineAttempt(
  attemptDirectory: string,
): Promise<void> {
  await fs.rmdir(attemptDirectory).catch(() => undefined);
}

async function deleteExactLocalGeneration(
  realRoot: string,
  providerId: string,
  context: ConditionalDeletionContextV1,
  token: LocalStorageDeletionTokenV1,
  signal?: AbortSignal,
): Promise<"deleted" | "target_already_absent"> {
  const objectPath = safeLocalObjectPath(realRoot, token.objectKey);
  const paths = localQuarantinePaths(realRoot, providerId, context, token);
  let deletedInThisCall = false;
  for (let pass = 0; pass < 8; pass += 1) {
    signal?.throwIfAborted();
    const quarantine = await inspectLocalQuarantine(
      realRoot,
      paths,
      token,
      signal,
    );
    const exactAttempts = quarantine.attempts.filter((attempt) =>
      sameQuarantinedLocalGeneration(attempt.generation, token));
    const unverifiedAttempts = quarantine.attempts.filter((attempt) =>
      !sameQuarantinedLocalGeneration(attempt.generation, token));
    let restoredUnverifiedAttempt = false;
    for (const pending of unverifiedAttempts) {
      const restored = await restoreQuarantinedLocalEntry(
        pending.targetPath,
        objectPath,
      );
      if (!restored) preconditionFailed();
      await cleanupLocalQuarantineAttempt(pending.directory);
      restoredUnverifiedAttempt = true;
    }
    if (
      restoredUnverifiedAttempt
      && !quarantine.marker
      && !exactAttempts.length
    ) {
      // The moved entry was not the captured generation and there is no
      // durable proof that another attempt deleted it. Restore the entry but
      // refuse to claim success for the requested generation.
      preconditionFailed();
    }
    if (exactAttempts.length) {
      await writeLocalQuarantineMarker(realRoot, paths);
      for (const pending of exactAttempts) {
        signal?.throwIfAborted();
        try {
          await fs.unlink(pending.targetPath);
        } catch (error: any) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        deletedInThisCall = true;
        await cleanupLocalQuarantineAttempt(pending.directory);
      }
      continue;
    }
    if (restoredUnverifiedAttempt) continue;

    const immediatelyBefore = await inspectLocalAbsoluteFileGeneration(
      realRoot,
      objectPath,
      signal,
    );
    if (quarantine.marker) {
      if (!immediatelyBefore || !sameLocalGeneration(immediatelyBefore, token)) {
        return deletedInThisCall ? "deleted" : "target_already_absent";
      }
    } else {
      if (!immediatelyBefore) return "target_already_absent";
      if (!sameLocalGeneration(immediatelyBefore, token)) preconditionFailed();
    }

    await ensureLocalQuarantinePaths(realRoot, paths);
    const attemptDirectory = await fs.mkdtemp(path.join(
      paths.operationDir,
      "attempt-",
    ));
    await fs.chmod(attemptDirectory, 0o700);
    await assertPrivateLocalQuarantineDirectory(realRoot, attemptDirectory);
    const quarantinePath = path.join(attemptDirectory, "target");
    try {
      await fs.rename(objectPath, quarantinePath);
    } catch (error: any) {
      await cleanupLocalQuarantineAttempt(attemptDirectory);
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    let quarantined: LocalFileGeneration | null;
    try {
      quarantined = await inspectLocalAbsoluteFileGeneration(
        realRoot,
        quarantinePath,
        signal,
      );
    } catch (error: any) {
      if (
        error instanceof ObjectStorageUpstreamError
        && error.code === "OBJECT_STORAGE_LOCAL_SYMLINK_FORBIDDEN"
      ) {
        await restoreQuarantinedLocalEntry(quarantinePath, objectPath);
        await cleanupLocalQuarantineAttempt(attemptDirectory);
      }
      throw error;
    }
    if (!quarantined || !sameQuarantinedLocalGeneration(quarantined, token)) {
      await restoreQuarantinedLocalEntry(quarantinePath, objectPath);
      await cleanupLocalQuarantineAttempt(attemptDirectory);
      preconditionFailed();
    }

    await writeLocalQuarantineMarker(realRoot, paths);
    signal?.throwIfAborted();
    try {
      await fs.unlink(quarantinePath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    deletedInThisCall = true;
    await cleanupLocalQuarantineAttempt(attemptDirectory);
  }
  throw new ObjectStorageUpstreamError(
    "OBJECT_STORAGE_LOCAL_DELETE_CONTENTION",
    503,
  );
}

function localTokenJson(token: LocalStorageDeletionTokenV1): string {
  return JSON.stringify({
    version: token.version,
    providerFingerprint: token.providerFingerprint,
    rootFingerprint: token.rootFingerprint,
    bucket: token.bucket,
    objectKey: token.objectKey,
    intentId: token.intentId,
    receiptHash: token.receiptHash,
    referenceHash: token.referenceHash,
    size: token.size,
    sha256: token.sha256,
    device: token.device,
    inode: token.inode,
    mtimeNs: token.mtimeNs,
    ctimeNs: token.ctimeNs,
  });
}

function serializeLocalToken(token: LocalStorageDeletionTokenV1): string {
  return `${LOCAL_STORAGE_DELETION_TOKEN_PREFIX}${Buffer.from(
    localTokenJson(token),
    "utf8",
  ).toString("base64url")}`;
}

function parseLocalToken(value: string): LocalStorageDeletionTokenV1 {
  if (
    typeof value !== "string"
    || !value.startsWith(LOCAL_STORAGE_DELETION_TOKEN_PREFIX)
    || value.length > 2_048
  ) {
    inputInvalid("OBJECT_STORAGE_LOCAL_DELETION_TOKEN_INVALID");
  }
  let token: LocalStorageDeletionTokenV1;
  try {
    token = JSON.parse(
      Buffer.from(
        value.slice(LOCAL_STORAGE_DELETION_TOKEN_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as LocalStorageDeletionTokenV1;
  } catch {
    inputInvalid("OBJECT_STORAGE_LOCAL_DELETION_TOKEN_INVALID");
  }
  const hashes = [
    token.providerFingerprint,
    token.rootFingerprint,
    token.receiptHash,
    token.referenceHash,
    token.sha256,
  ];
  if (
    token.version !== LOCAL_STORAGE_DELETION_TOKEN_VERSION
    || hashes.some((hash) =>
      typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))
    || typeof token.bucket !== "string"
    || token.bucket !== localBucket(token.rootFingerprint)
    || typeof token.objectKey !== "string"
    || normalizeObjectKey(token.objectKey) !== token.objectKey
    || typeof token.intentId !== "string"
    || !token.intentId
    || !Number.isSafeInteger(token.size)
    || token.size < 0
    || !["device", "inode", "mtimeNs", "ctimeNs"].every((field) =>
      typeof token[field as keyof LocalStorageDeletionTokenV1] === "string"
      && /^[0-9]+$/u.test(
        String(token[field as keyof LocalStorageDeletionTokenV1]),
      ))
    || serializeLocalToken(token) !== value
  ) {
    inputInvalid("OBJECT_STORAGE_LOCAL_DELETION_TOKEN_INVALID");
  }
  return token;
}

function remoteRuntime(
  runtime: ObjectStorageDeletionRuntime = {},
): {
  configuration: ObjectStorageConfiguration & {
    provider: "s3" | "tos";
    bucket: string;
    endpoint: string;
  };
  storage: ObjectStorageAdapter;
} {
  const configuration = runtime.configuration ?? resolveObjectStorageConfiguration();
  if (
    configuration.provider === "local"
    || !configuration.bucket
    || !configuration.endpoint
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_CONDITIONAL_DELETE_PROVIDER_REQUIRED",
      503,
    );
  }
  return {
    configuration: configuration as ObjectStorageConfiguration & {
      provider: "s3" | "tos";
      bucket: string;
      endpoint: string;
    },
    storage: runtime.storage ?? createRemoteObjectStorageAdapter(configuration),
  };
}

function localIntentRecord(row: Record<string, unknown>): ObjectWriteIntentRecord {
  return {
    ...row,
    projectId: Number(row.projectId),
    expectedSize: Number(row.expectedSize),
    forcePathStyle:
      row.forcePathStyle === true || Number(row.forcePathStyle) === 1,
  } as unknown as ObjectWriteIntentRecord;
}

async function localReferenceExists(
  database: Knex,
  reference: ObjectWriteReferenceEvidence,
): Promise<boolean> {
  if (reference.table === "o_image") {
    return Boolean(await database("o_image as image")
      .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
      .innerJoin("o_project as project", "project.id", "asset.projectId")
      .where({
        "image.id": reference.rowId,
        "image.storageKey": reference.storageKey,
        "asset.projectId": reference.projectId,
        "project.workspaceId": reference.workspaceId,
      })
      .first("image.id"));
  }
  if (reference.table === "o_media_asset") {
    return Boolean(await database("o_media_asset")
      .where({
        id: reference.rowId,
        workspaceId: reference.workspaceId,
        projectId: reference.projectId,
        storageKey: reference.storageKey,
      })
      .first("id"));
  }
  if (reference.table === "o_tasks") {
    const row = await database("o_tasks")
      .where({
        id: reference.rowId,
        projectId: reference.projectId,
      })
      .first("relatedObjects");
    if (!row) return false;
    try {
      const relatedObjects = JSON.parse(String(row.relatedObjects || ""));
      return (
        relatedObjects
        && typeof relatedObjects === "object"
        && !Array.isArray(relatedObjects)
        && normalizeObjectKey(
          String(relatedObjects.outputStorageKey || ""),
        ) === reference.storageKey
      );
    } catch {
      return false;
    }
  }
  return false;
}

async function validatedLocalIntent(
  input: {
    database: Knex;
    configuration: ObjectStorageConfiguration & { provider: "local" };
    objectKey: string;
    intentId?: string;
    receiptHash?: string;
    referenceHash?: string;
  },
): Promise<{
  record: ObjectWriteIntentRecord;
  reference: ObjectWriteReferenceEvidence;
}> {
  let query = input.database(OBJECT_WRITE_INTENT_TABLE)
    .where({
      provider: "local",
      status: "committed",
      objectKey: input.objectKey,
    });
  if (input.intentId) query = query.andWhere({ id: input.intentId });
  const rows = await query
    .orderBy("committedAt", "desc")
    .limit(input.intentId ? 1 : 10);
  const expectedProviderFingerprint =
    objectWriteProviderIdentity(input.configuration).providerFingerprint;
  const matches: Array<{
    record: ObjectWriteIntentRecord;
    reference: ObjectWriteReferenceEvidence;
  }> = [];
  for (const raw of rows) {
    const record = localIntentRecord(raw);
    if (
      record.providerFingerprint !== expectedProviderFingerprint
      || !record.writeReceiptHash
      || !record.referenceHash
      || (
        input.receiptHash
        && record.writeReceiptHash !== input.receiptHash
      )
      || (
        input.referenceHash
        && record.referenceHash !== input.referenceHash
      )
    ) continue;
    const receipt = parseObjectWriteReceiptEvidence(record);
    const reference = parseObjectWriteReferenceEvidence(record);
    if (
      receipt?.mode !== "local"
      || receipt.objectKey !== input.objectKey
      || reference?.storageKey !== input.objectKey
      || reference.workspaceId !== record.workspaceId
      || reference.projectId !== record.projectId
      || !(await localReferenceExists(input.database, reference))
    ) continue;
    matches.push({ record, reference });
  }
  if (matches.length !== 1) {
    throw new ObjectStorageUpstreamError(
      matches.length
        ? "OBJECT_STORAGE_LOCAL_INTENT_AMBIGUOUS"
        : "OBJECT_STORAGE_LOCAL_COMMITTED_INTENT_REQUIRED",
      409,
    );
  }
  return matches[0];
}

async function captureLocalStorageKeyDeletionTargets(
  key: string,
  runtime: ObjectStorageDeletionRuntime,
): Promise<CapturedStorageDeletionTarget[]> {
  const resolved = localRuntime(runtime);
  const objectKey = normalizeObjectKey(key);
  const { record } = await validatedLocalIntent({
    database: resolved.database,
    configuration: resolved.configuration,
    objectKey,
  });
  const generation = await inspectLocalFileGeneration(
    resolved.realRoot,
    objectKey,
    runtime.signal,
  );
  if (!generation) return [];
  if (
    generation.size !== record.expectedSize
    || generation.sha256 !== record.expectedSha256
  ) {
    preconditionFailed();
  }
  const token: LocalStorageDeletionTokenV1 = {
    version: LOCAL_STORAGE_DELETION_TOKEN_VERSION,
    providerFingerprint: record.providerFingerprint,
    rootFingerprint: resolved.rootFingerprint,
    bucket: resolved.bucket,
    objectKey,
    intentId: record.id,
    receiptHash: record.writeReceiptHash!,
    referenceHash: record.referenceHash!,
    ...generation,
  };
  const conditionalToken = serializeLocalToken(token);
  return [{
    bucket: resolved.bucket,
    objectKey,
    deleteType: "file",
    exists: true,
    deleteMarker: false,
    targetGeneration: sha256(conditionalToken),
    conditionalToken,
  }];
}

function providerId(configuration: ObjectStorageConfiguration): string {
  return `object-storage-delete:${sha256(JSON.stringify({
    provider: configuration.provider,
    bucket: configuration.bucket,
    region: configuration.region,
    endpoint: configuration.endpoint,
    keyPrefix: configuration.keyPrefix,
    forcePathStyle: configuration.forcePathStyle,
  }))}`;
}

function targetBinding(
  configuration: ObjectStorageConfiguration,
  key: string,
): string {
  return sha256(JSON.stringify([
    providerId(configuration),
    normalizeObjectKey(key),
  ]));
}

function tokenForSnapshot(
  snapshot: ObjectStorageGenerationSnapshot,
  configuration: ObjectStorageConfiguration,
): StorageDeletionTokenV2 {
  const binding = targetBinding(configuration, snapshot.key);
  if (snapshot.versionId === "null") {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_NULL_VERSION_UNSAFE",
      503,
    );
  }
  if (!snapshot.exists) {
    if (snapshot.deleteMarker || snapshot.etag !== null) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_EVIDENCE_INVALID",
        502,
      );
    }
    return {
      version: STORAGE_DELETION_TOKEN_VERSION,
      targetBinding: binding,
      exists: false,
      deleteMarker: false,
      etag: null,
      versionId: snapshot.versionId,
    };
  }
  if (snapshot.deleteMarker) {
    if (snapshot.etag !== null || !snapshot.versionId) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_EVIDENCE_INVALID",
        502,
      );
    }
    return {
      version: STORAGE_DELETION_TOKEN_VERSION,
      targetBinding: binding,
      exists: true,
      deleteMarker: true,
      etag: null,
      versionId: snapshot.versionId,
    };
  }
  if (!snapshot.etag) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_GENERATION_EVIDENCE_INVALID",
      502,
    );
  }
  return {
    version: STORAGE_DELETION_TOKEN_VERSION,
    targetBinding: binding,
    exists: true,
    deleteMarker: false,
    etag: snapshot.etag,
    versionId: snapshot.versionId,
  };
}

function serializeToken(token: StorageDeletionTokenV2): string {
  return `${STORAGE_DELETION_TOKEN_PREFIX}${Buffer.from(
    JSON.stringify(token),
    "utf8",
  ).toString("base64url")}`;
}

function parseToken(value: string): StorageDeletionTokenV2 {
  if (
    typeof value !== "string"
    || !value.startsWith(STORAGE_DELETION_TOKEN_PREFIX)
    || value.length > 2_048
  ) {
    inputInvalid("OBJECT_STORAGE_DELETION_TOKEN_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(STORAGE_DELETION_TOKEN_PREFIX.length), "base64url")
        .toString("utf8"),
    );
  } catch {
    inputInvalid("OBJECT_STORAGE_DELETION_TOKEN_INVALID");
  }
  const token = parsed as Partial<StorageDeletionTokenV2>;
  if (
    !token
    || token.version !== STORAGE_DELETION_TOKEN_VERSION
    || typeof token.targetBinding !== "string"
    || !/^[a-f0-9]{64}$/u.test(token.targetBinding)
    || typeof token.exists !== "boolean"
    || typeof token.deleteMarker !== "boolean"
    || (token.etag !== null && typeof token.etag !== "string")
    || (token.versionId !== null && typeof token.versionId !== "string")
    || token.versionId === "null"
    || (!token.exists && (token.deleteMarker || token.etag !== null))
    || (token.exists && token.deleteMarker && (token.etag !== null || !token.versionId))
    || (token.exists && !token.deleteMarker && !token.etag)
  ) {
    inputInvalid("OBJECT_STORAGE_DELETION_TOKEN_INVALID");
  }
  const normalized: StorageDeletionTokenV2 = {
    version: STORAGE_DELETION_TOKEN_VERSION,
    targetBinding: token.targetBinding,
    exists: token.exists,
    deleteMarker: token.deleteMarker,
    etag: token.etag ?? null,
    versionId: token.versionId ?? null,
  };
  if (serializeToken(normalized) !== value) {
    inputInvalid("OBJECT_STORAGE_DELETION_TOKEN_NON_CANONICAL");
  }
  return normalized;
}

function capturedTarget(
  snapshot: ObjectStorageGenerationSnapshot,
  configuration: ObjectStorageConfiguration,
): CapturedStorageDeletionTarget {
  if (snapshot.provider === "tos" && snapshot.exists && !snapshot.versionId) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_TOS_VERSION_ID_REQUIRED",
      503,
    );
  }
  const conditionalToken = serializeToken(tokenForSnapshot(
    snapshot,
    configuration,
  ));
  return {
    bucket: snapshot.bucket,
    objectKey: normalizeObjectKey(snapshot.key),
    deleteType: "file",
    exists: snapshot.exists,
    deleteMarker: snapshot.deleteMarker,
    targetGeneration: sha256(conditionalToken),
    conditionalToken,
  };
}

function assertContext(
  context: ConditionalDeletionContextV1,
  configuration: ObjectStorageConfiguration & { bucket: string },
): StorageDeletionTokenV2 {
  if (
    context.contractVersion !== CONDITIONAL_DELETION_PROVIDER_CONTRACT
    || context.deleteType !== "file"
    || context.bucket !== configuration.bucket
    || normalizeObjectKey(context.objectKey) !== context.objectKey
  ) {
    inputInvalid("OBJECT_STORAGE_DELETION_CONTEXT_INVALID");
  }
  const token = parseToken(context.conditionalToken);
  if (
    token.targetBinding !== targetBinding(
      configuration,
      context.objectKey,
    )
    || context.targetGeneration !== sha256(context.conditionalToken)
  ) {
    inputInvalid("OBJECT_STORAGE_DELETION_GENERATION_INVALID");
  }
  return token;
}

function snapshotMatchesToken(
  snapshot: ObjectStorageGenerationSnapshot,
  token: StorageDeletionTokenV2,
): boolean {
  if (!token.exists) return !snapshot.exists;
  if (!snapshot.exists) return true;
  return snapshot.deleteMarker === token.deleteMarker
    && snapshot.etag === token.etag
    && snapshot.versionId === token.versionId;
}

function result(
  context: ConditionalDeletionContextV1,
  outcome: "deleted" | "target_already_absent",
  requestId: string,
): ConditionalDeletionResultV1 {
  return outcome === "deleted"
    ? {
        outcome,
        code: "TARGET_DELETED",
        targetFingerprint: context.targetFingerprint,
        idempotencyKey: context.idempotencyKey,
        providerRequestId: requestId,
      }
    : {
        outcome,
        code: "TARGET_ALREADY_ABSENT",
        targetFingerprint: context.targetFingerprint,
        idempotencyKey: context.idempotencyKey,
        providerRequestId: requestId,
      };
}

export async function captureStorageDeletionTarget(
  key: string,
  runtime: ObjectStorageDeletionRuntime = {},
): Promise<CapturedStorageDeletionTarget> {
  const { configuration, storage } = remoteRuntime(runtime);
  const normalizedKey = normalizeObjectKey(key);
  runtime.signal?.throwIfAborted();
  const snapshot = await storage.inspectGeneration(normalizedKey, {
    signal: runtime.signal,
  });
  runtime.signal?.throwIfAborted();
  if (
    snapshot.provider !== configuration.provider
    || snapshot.bucket !== configuration.bucket
    || snapshot.key !== normalizedKey
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_GENERATION_PROVIDER_MISMATCH",
      502,
    );
  }
  return capturedTarget(snapshot, configuration);
}

/**
 * Capture every immutable generation for one exact logical key. A single HEAD
 * only proves the latest generation and would leave historical versions or a
 * delete marker behind in a versioned bucket.
 */
export async function captureStorageKeyDeletionTargets(
  key: string,
  runtime: ObjectStorageDeletionRuntime = {},
): Promise<CapturedStorageDeletionTarget[]> {
  const configured =
    runtime.configuration ?? resolveObjectStorageConfiguration();
  if (configured.provider === "local") {
    return await captureLocalStorageKeyDeletionTargets(key, {
      ...runtime,
      configuration: configured,
    });
  }
  const { configuration, storage } = remoteRuntime(runtime);
  const normalizedKey = normalizeObjectKey(key);
  runtime.signal?.throwIfAborted();
  const snapshots = await storage.listGenerationSnapshots(
    normalizedKey,
    {
      maximumObjects: 10_000,
      exactKey: true,
      signal: runtime.signal,
    },
  );
  runtime.signal?.throwIfAborted();
  if (!snapshots.length) {
    const latest = await storage.inspectGeneration(normalizedKey, {
      signal: runtime.signal,
    });
    runtime.signal?.throwIfAborted();
    if (
      latest.provider !== configuration.provider
      || latest.bucket !== configuration.bucket
      || latest.key !== normalizedKey
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_PROVIDER_MISMATCH",
        502,
      );
    }
    if (latest.exists) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_VERSION_LIST_INCOMPLETE",
        502,
      );
    }
    return [];
  }
  const targets = snapshots.map((snapshot) => {
    if (
      snapshot.provider !== configuration.provider
      || snapshot.bucket !== configuration.bucket
      || snapshot.key !== normalizedKey
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_PROVIDER_MISMATCH",
        502,
      );
    }
    return capturedTarget(snapshot, configuration);
  });
  return [...new Map(targets.map((target) => [
    `${target.bucket}\0${target.objectKey}\0${target.targetGeneration}`,
    target,
  ])).values()].sort((left, right) =>
    left.targetGeneration.localeCompare(right.targetGeneration),
  );
}

export async function captureStoragePrefixDeletionTargets(
  prefix: string,
  runtime: ObjectStorageDeletionRuntime = {},
): Promise<CapturedStorageDeletionTarget[]> {
  const { configuration, storage } = remoteRuntime(runtime);
  const normalizedPrefix = normalizeObjectKey(prefix.replace(/\/+$/u, ""));
  runtime.signal?.throwIfAborted();
  const snapshots = await storage.listGenerationSnapshots(
    normalizedPrefix,
    { maximumObjects: 10_000, signal: runtime.signal },
  );
  runtime.signal?.throwIfAborted();
  const targets = snapshots.map((snapshot) => {
    if (
      snapshot.provider !== configuration.provider
      || snapshot.bucket !== configuration.bucket
      || !snapshot.key.startsWith(`${normalizedPrefix}/`)
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_PROVIDER_MISMATCH",
        502,
      );
    }
    return capturedTarget(snapshot, configuration);
  });
  return [...new Map(targets.map((target) => [
    `${target.bucket}\0${target.objectKey}\0${target.targetGeneration}`,
    target,
  ])).values()].sort((left, right) =>
    left.objectKey.localeCompare(right.objectKey)
    || left.targetGeneration.localeCompare(right.targetGeneration),
  );
}

/**
 * Capture exactly one provider version-list page for a project prefix.
 *
 * The returned provider cursor is opaque and is never consumed internally.
 * A deletion coordinator can therefore commit the page's immutable targets,
 * its manifest-chain evidence, the outbox rows and this cursor in one database
 * transaction before requesting another page.
 */
export async function captureStoragePrefixDeletionTargetPage(
  prefix: string,
  options: Pick<
    ObjectStorageGenerationSnapshotPageOptions,
    | "maximumObjects"
    | "keyMarker"
    | "versionIdMarker"
    | "timeoutMs"
  > = {},
  runtime: ObjectStorageDeletionRuntime = {},
): Promise<CapturedStoragePrefixDeletionTargetPage> {
  const { configuration, storage } = remoteRuntime(runtime);
  if (!storage.listGenerationSnapshotPage) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_VERSION_LIST_PAGE_CAPABILITY_REQUIRED",
      503,
    );
  }
  const normalizedPrefix = normalizeObjectKey(prefix.replace(/\/+$/u, ""));
  runtime.signal?.throwIfAborted();
  const page = await storage.listGenerationSnapshotPage(normalizedPrefix, {
    ...options,
    signal: runtime.signal,
  });
  runtime.signal?.throwIfAborted();
  const targets = page.snapshots.map((snapshot) => {
    if (
      snapshot.provider !== configuration.provider
      || snapshot.bucket !== configuration.bucket
      || !snapshot.key.startsWith(`${normalizedPrefix}/`)
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_PROVIDER_MISMATCH",
        502,
      );
    }
    return capturedTarget(snapshot, configuration);
  });
  const identities = new Set(
    targets.map((target) =>
      `${target.bucket}\0${target.objectKey}\0${target.targetGeneration}`),
  );
  if (identities.size !== targets.length) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LIST_DUPLICATE_VERSION",
      502,
    );
  }
  const id = providerId(configuration);
  return {
    providerId: id,
    providerFingerprint: sha256(id),
    bucket: configuration.bucket,
    objectPrefix: `${normalizedPrefix}/`,
    targets,
    truncated: page.truncated,
    keyMarker: page.keyMarker,
    versionIdMarker: page.versionIdMarker,
  };
}

function createLocalObjectStorageConditionalDeletionProvider(
  runtime: ObjectStorageDeletionRuntime,
): ConditionalDeletionProviderV1 {
  const resolved = localRuntime(runtime);

  async function validateContext(
    context: ConditionalDeletionContextV1,
    operation: ConditionalDeletionProviderOperationV1,
  ): Promise<LocalStorageDeletionTokenV1> {
    operation.signal.throwIfAborted();
    const token = parseLocalToken(context.conditionalToken);
    const currentProviderFingerprint =
      objectWriteProviderIdentity(resolved.configuration).providerFingerprint;
    if (
      context.contractVersion !== CONDITIONAL_DELETION_PROVIDER_CONTRACT
      || context.deleteType !== "file"
      || context.bucket !== resolved.bucket
      || context.objectKey !== token.objectKey
      || context.targetGeneration !== sha256(context.conditionalToken)
      || token.providerFingerprint !== currentProviderFingerprint
      || token.rootFingerprint !== resolved.rootFingerprint
      || token.bucket !== resolved.bucket
    ) {
      inputInvalid("OBJECT_STORAGE_LOCAL_DELETION_CONTEXT_INVALID");
    }
    const { record } = await validatedLocalIntent({
      database: resolved.database,
      configuration: resolved.configuration,
      objectKey: token.objectKey,
      intentId: token.intentId,
      receiptHash: token.receiptHash,
      referenceHash: token.referenceHash,
    });
    if (
      record.expectedSize !== token.size
      || record.expectedSha256 !== token.sha256
    ) {
      inputInvalid("OBJECT_STORAGE_LOCAL_DELETION_CONTEXT_INVALID");
    }
    operation.signal.throwIfAborted();
    return token;
  }

  async function execute(
    context: ConditionalDeletionContextV1,
    operation: ConditionalDeletionProviderOperationV1,
  ): Promise<ConditionalDeletionResultV1> {
    const token = await validateContext(context, operation);
    const requestId = `local-${sha256(JSON.stringify([
      resolved.providerId,
      context.idempotencyKey,
      context.targetFingerprint,
    ])).slice(0, 48)}`;
    const outcome = await deleteExactLocalGeneration(
      resolved.realRoot,
      resolved.providerId,
      context,
      token,
      operation.signal,
    );
    await releaseWorkspaceStorage(runtime.database ?? defaultDeletionDatabase(), `intent:${token.intentId}`, { outcome, requestId });
    return result(context, outcome, requestId);
  }

  const provider: ConditionalDeletionProviderV1 = {
    contractVersion: CONDITIONAL_DELETION_PROVIDER_CONTRACT,
    providerId: resolved.providerId,
    conditionalDelete: true,
    idempotentByIdempotencyKey: true,
    contextualAlreadyAbsent: true,
    async prepareConditionalDelete(context, operation) {
      await validateContext(context, operation);
      return Object.freeze({
        contractVersion: CONDITIONAL_DELETION_PROVIDER_CONTRACT,
        providerId: resolved.providerId,
        targetFingerprint: context.targetFingerprint,
        conditionalDelete: true,
        idempotentByIdempotencyKey: true,
        contextualAlreadyAbsent: true,
      } satisfies ConditionalDeletionCapabilityProofV1);
    },
    async deleteConditional(context, proof, operation) {
      if (
        proof.contractVersion !== CONDITIONAL_DELETION_PROVIDER_CONTRACT
        || proof.providerId !== resolved.providerId
        || proof.targetFingerprint !== context.targetFingerprint
      ) {
        inputInvalid("OBJECT_STORAGE_LOCAL_DELETION_PROOF_INVALID");
      }
      return await execute(context, operation);
    },
    async reconcileConditionalDelete(context, evidence, operation) {
      if (
        evidence.contractVersion !== CONDITIONAL_DELETION_PROVIDER_CONTRACT
        || evidence.providerId !== resolved.providerId
        || evidence.idempotencyKey !== context.idempotencyKey
        || evidence.targetFingerprint !== context.targetFingerprint
      ) {
        inputInvalid("OBJECT_STORAGE_LOCAL_DELETION_EVIDENCE_INVALID");
      }
      return await execute(context, operation);
    },
  };
  return Object.freeze(provider);
}

export function createObjectStorageConditionalDeletionProvider(
  runtime: ObjectStorageDeletionRuntime = {},
): ConditionalDeletionProviderV1 {
  const configured =
    runtime.configuration ?? resolveObjectStorageConfiguration();
  if (configured.provider === "local") {
    return createLocalObjectStorageConditionalDeletionProvider({
      ...runtime,
      configuration: configured,
    });
  }
  const { configuration, storage } = remoteRuntime(runtime);
  const id = providerId(configuration);

  async function inspect(
    context: ConditionalDeletionContextV1,
    token: StorageDeletionTokenV2,
    operation: ConditionalDeletionProviderOperationV1,
  ): Promise<ObjectStorageGenerationSnapshot> {
    const snapshot = await storage.inspectGeneration(context.objectKey, {
      versionId: token.versionId,
      signal: operation.signal,
    });
    if (
      snapshot.provider !== configuration.provider
      || snapshot.bucket !== configuration.bucket
      || snapshot.key !== context.objectKey
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_PROVIDER_MISMATCH",
        502,
      );
    }
    return snapshot;
  }

  async function execute(
    context: ConditionalDeletionContextV1,
    operation: ConditionalDeletionProviderOperationV1,
  ): Promise<ConditionalDeletionResultV1> {
    const token = assertContext(context, configuration);
    const before = await inspect(context, token, operation);
    if (!snapshotMatchesToken(before, token)) preconditionFailed();
    if (!token.exists || !before.exists) {
      await releaseWorkspaceStoredGeneration(runtime.database ?? defaultDeletionDatabase(), {
        providerFingerprint: objectWriteProviderIdentity(configuration).providerFingerprint, objectKey: context.objectKey,
        versionId: token.versionId, evidence: { outcome: "target_already_absent", requestId: before.requestId },
      });
      return result(
        context,
        "target_already_absent",
        before.requestId,
      );
    }
    const receipt = await storage.deleteGenerationIfMatch(
      context.objectKey,
      {
        etag: token.etag,
        versionId: token.versionId,
        deleteMarker: token.deleteMarker,
        signal: operation.signal,
      },
    );
    await releaseWorkspaceStoredGeneration(runtime.database ?? defaultDeletionDatabase(), {
      providerFingerprint: objectWriteProviderIdentity(configuration).providerFingerprint, objectKey: context.objectKey,
      versionId: token.versionId, evidence: { outcome: receipt.outcome, requestId: receipt.requestId },
    });
    return result(context, receipt.outcome, receipt.requestId);
  }

  const provider: ConditionalDeletionProviderV1 = {
    contractVersion: CONDITIONAL_DELETION_PROVIDER_CONTRACT,
    providerId: id,
    conditionalDelete: true,
    idempotentByIdempotencyKey: true,
    contextualAlreadyAbsent: true,
    async prepareConditionalDelete(context, operation) {
      const token = assertContext(context, configuration);
      const snapshot = await inspect(context, token, operation);
      if (!snapshotMatchesToken(snapshot, token)) preconditionFailed();
      return Object.freeze({
        contractVersion: CONDITIONAL_DELETION_PROVIDER_CONTRACT,
        providerId: id,
        targetFingerprint: context.targetFingerprint,
        conditionalDelete: true,
        idempotentByIdempotencyKey: true,
        contextualAlreadyAbsent: true,
      } satisfies ConditionalDeletionCapabilityProofV1);
    },
    async deleteConditional(context, proof, operation) {
      if (
        proof.contractVersion !== CONDITIONAL_DELETION_PROVIDER_CONTRACT
        || proof.providerId !== id
        || proof.targetFingerprint !== context.targetFingerprint
      ) {
        inputInvalid("OBJECT_STORAGE_DELETION_PROOF_INVALID");
      }
      return execute(context, operation);
    },
    async reconcileConditionalDelete(context, evidence, operation) {
      const expectedEvidence: Pick<
        ConditionalDeletionDispatchEvidenceV1,
        "contractVersion" | "providerId" | "idempotencyKey" | "targetFingerprint"
      > = {
        contractVersion: CONDITIONAL_DELETION_PROVIDER_CONTRACT,
        providerId: id,
        idempotencyKey: context.idempotencyKey,
        targetFingerprint: context.targetFingerprint,
      };
      if (
        evidence.contractVersion !== expectedEvidence.contractVersion
        || evidence.providerId !== expectedEvidence.providerId
        || evidence.idempotencyKey !== expectedEvidence.idempotencyKey
        || evidence.targetFingerprint !== expectedEvidence.targetFingerprint
      ) {
        inputInvalid("OBJECT_STORAGE_DELETION_EVIDENCE_INVALID");
      }
      return execute(context, operation);
    },
  };
  return Object.freeze(provider);
}
