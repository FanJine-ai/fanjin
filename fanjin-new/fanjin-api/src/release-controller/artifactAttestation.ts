import crypto from "node:crypto";
import { constants, createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { list as listTar, type ReadEntry } from "tar";

import {
  parseReleaseArtifactManifest,
  type ReleaseArtifactAttestationRecord,
  type ReleaseContainerDeploymentV1,
} from "@/lib/releaseArtifactManifest";
import {
  defaultReleaseSchemaCompatibility,
  type ReleaseSchemaCompatibilityV1,
} from "@/lib/releaseSchemaCompatibility";
import {
  ReleaseArtifactAttestationError,
  verifyReleaseArtifactAttestation,
  type VerifiedReleaseArtifactAttestation,
} from "@/lib/releaseArtifactAttestation";

const MANIFEST_ARCHIVE_PATH = "release/release-manifest.json";
// Full production dependency inventories are larger than 4 MiB. Keep this in
// sync with the stored-artifact verifier and release record parser.
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_MEMBERS = 100_000;
const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024 * 1024;

export class ReleaseControllerArtifactAttestationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReleaseControllerArtifactAttestationError";
    this.code = code;
  }
}

export interface CachedReleaseArtifactEvidence {
  artifactId: string;
  artifactSha256: string;
  /** SHA-256 of the exact verified release/release-manifest.json archive bytes. */
  signedManifestFileSha256: string;
  releaseId: string;
  schemaVersion: number;
  workerProtocolVersion: number;
  runtimeCapabilities: readonly string[];
  deployment?: ReleaseContainerDeploymentV1;
  attestation: VerifiedReleaseArtifactAttestation;
}

export interface CachedLegacyBridgeArtifactEvidence
  extends CachedReleaseArtifactEvidence {
  signedSchemaCompatibility: ReleaseSchemaCompatibilityV1;
}

export interface CachedMigrationArtifactProvenance {
  artifactSha256: string;
  sourceCommit: string;
  schemaVersion: number;
  schemaCompatibility: ReleaseSchemaCompatibilityV1;
  runtimeEntrypointSha256: string;
  attestation: VerifiedReleaseArtifactAttestation;
}

function fail(code: string, message: string): never {
  throw new ReleaseControllerArtifactAttestationError(code, message);
}

async function digestCachedArtifact(
  archivePath: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; byteSize: number }> {
  let metadata;
  try {
    metadata = await lstat(archivePath);
  } catch {
    fail("RELEASE_CONTROLLER_ARTIFACT_CACHE_MISSING", "控制器制品缓存文件不存在");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    fail("RELEASE_CONTROLLER_ARTIFACT_CACHE_UNSAFE", "控制器制品缓存文件权限或类型无效");
  }
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  try {
    for await (const chunk of createReadStream(archivePath, { signal })) {
      byteSize += chunk.byteLength;
      hash.update(chunk);
    }
  } catch {
    if (signal?.aborted) {
      fail("RELEASE_CONTROLLER_ARTIFACT_VERIFY_ABORTED", "控制器制品校验已中止");
    }
    fail("RELEASE_CONTROLLER_ARTIFACT_CACHE_UNREADABLE", "控制器无法读取制品缓存");
  }
  return { sha256: hash.digest("hex"), byteSize };
}

interface InspectedArchive {
  manifest: Buffer;
  files: Map<string, { size: number; sha256: string }>;
}

/** macOS AppleDouble / Finder metadata that legitimate `tar` archives may contain. */
function isIgnoredArchiveMember(value: string): boolean {
  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = withoutTrailingSlash.split("/").filter(Boolean);
  const base = segments[segments.length - 1] || "";
  return base === ".DS_Store"
    || base.startsWith("._")
    || segments[0] === "__MACOSX"
    || withoutTrailingSlash.startsWith("__MACOSX/");
}

function safeArchivePath(value: string): string {
  let normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\")
    || normalized.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments[0] !== "release") {
    fail("RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_PATH_UNSAFE", "控制器制品包含不安全路径");
  }
  return normalized;
}

async function inspectArchive(archivePath: string, signal?: AbortSignal): Promise<InspectedArchive> {
  if (signal?.aborted) {
    fail("RELEASE_CONTROLLER_ARTIFACT_VERIFY_ABORTED", "控制器制品校验已中止");
  }
  const seen = new Set<string>();
  const files = new Map<string, { size: number; sha256: string }>();
  const manifestChunks: Buffer[] = [];
  const entryTasks: Promise<void>[] = [];
  let manifestBytes = 0;
  let expandedBytes = 0;
  let members = 0;
  let failure: ReleaseControllerArtifactAttestationError | null = null;

  const rejectEntry = (code: string, message: string): void => {
    if (!failure) failure = new ReleaseControllerArtifactAttestationError(code, message);
  };
  const onEntry = (entry: ReadEntry): void => {
    if (failure) {
      entry.resume();
      return;
    }
    if (isIgnoredArchiveMember(entry.path)) {
      entry.resume();
      return;
    }
    let archivePath: string;
    try {
      archivePath = safeArchivePath(entry.path);
    } catch (error) {
      failure = error as ReleaseControllerArtifactAttestationError;
      entry.resume();
      return;
    }
    members += 1;
    if (members > MAX_ARCHIVE_MEMBERS || seen.has(archivePath)) {
      rejectEntry(
        members > MAX_ARCHIVE_MEMBERS
          ? "RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_TOO_MANY_MEMBERS"
          : "RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_DUPLICATE_PATH",
        "控制器制品成员数量或路径重复校验失败",
      );
      entry.resume();
      return;
    }
    seen.add(archivePath);
    if (entry.type === "Directory") {
      if (entry.size !== 0) {
        rejectEntry("RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_ENTRY_INVALID", "控制器制品目录成员大小无效");
      }
      entry.resume();
      return;
    }
    if (entry.type !== "File" || !Number.isSafeInteger(entry.size) || entry.size < 0
      || entry.size > MAX_SINGLE_FILE_BYTES) {
      rejectEntry("RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_ENTRY_UNSAFE", "控制器制品包含不支持的成员类型或大小");
      entry.resume();
      return;
    }
    expandedBytes += entry.size;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      rejectEntry("RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_EXPANDED_TOO_LARGE", "控制器制品展开大小超过上限");
      entry.resume();
      return;
    }

    entryTasks.push(new Promise<void>((resolve) => {
      const hash = crypto.createHash("sha256");
      let received = 0;
      entry.on("data", (chunk: Buffer) => {
        if (signal?.aborted) {
          rejectEntry("RELEASE_CONTROLLER_ARTIFACT_VERIFY_ABORTED", "控制器制品校验已中止");
        }
        received += chunk.byteLength;
        if (received > entry.size) {
          rejectEntry("RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_ENTRY_SIZE_MISMATCH", "控制器制品成员长度无效");
          return;
        }
        if (archivePath === MANIFEST_ARCHIVE_PATH) {
          manifestBytes += chunk.byteLength;
          if (manifestBytes > MAX_MANIFEST_BYTES) {
            rejectEntry("RELEASE_CONTROLLER_ARTIFACT_MANIFEST_TOO_LARGE", "控制器制品清单超过大小上限");
            return;
          }
          manifestChunks.push(Buffer.from(chunk));
        } else {
          hash.update(chunk);
        }
      });
      entry.once("error", () => {
        rejectEntry("RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_UNREADABLE", "控制器无法读取制品成员");
        resolve();
      });
      entry.once("end", () => {
        if (received !== entry.size) {
          rejectEntry("RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_ENTRY_SIZE_MISMATCH", "控制器制品成员长度无效");
        } else if (archivePath !== MANIFEST_ARCHIVE_PATH) {
          files.set(archivePath.slice("release/".length), {
            size: received,
            sha256: hash.digest("hex"),
          });
        }
        resolve();
      });
      entry.resume();
    }));
  };

  try {
    await listTar({
      file: archivePath,
      strict: true,
      noResume: true,
      maxDepth: 128,
      maxMetaEntrySize: MAX_MANIFEST_BYTES,
      maxDecompressionRatio: 1_000,
      onReadEntry: onEntry,
    });
    await Promise.all(entryTasks);
  } catch {
    if (failure) throw failure;
    fail("RELEASE_CONTROLLER_ARTIFACT_ARCHIVE_INVALID", "控制器制品 tar 格式无效");
  }
  if (failure) throw failure;
  if (!seen.has(MANIFEST_ARCHIVE_PATH) || manifestBytes === 0) {
    fail("RELEASE_CONTROLLER_ARTIFACT_MANIFEST_MISSING", "控制器制品缺少有效清单");
  }
  return {
    manifest: Buffer.concat(manifestChunks, manifestBytes),
    files,
  };
}

function assertArchiveMatchesSignedFiles(
  manifest: Record<string, unknown>,
  actualFiles: Map<string, { size: number; sha256: string }>,
): void {
  const signedFiles = manifest.files as Array<Record<string, unknown>>;
  if (!Array.isArray(signedFiles) || signedFiles.length !== actualFiles.size) {
    fail("RELEASE_CONTROLLER_ARTIFACT_FILE_SET_MISMATCH", "控制器制品文件集合与签名清单不一致");
  }
  for (const entry of signedFiles) {
    const actual = actualFiles.get(String(entry.path));
    if (!actual || actual.size !== entry.size || actual.sha256 !== entry.sha256) {
      fail("RELEASE_CONTROLLER_ARTIFACT_FILE_HASH_MISMATCH", "控制器制品文件与签名摘要不一致");
    }
  }
}

function assertSignedIdentity(
  artifact: ReleaseArtifactAttestationRecord,
  manifest: Record<string, unknown>,
): {
  releaseId: string;
  schemaVersion: number;
  workerProtocolVersion: number;
  runtimeCapabilities: readonly string[];
  deployment?: ReleaseContainerDeploymentV1;
} {
  let signed;
  try {
    signed = parseReleaseArtifactManifest(manifest, artifact.releaseId);
  } catch {
    fail(
      "RELEASE_CONTROLLER_ARTIFACT_SIGNED_IDENTITY_INVALID",
      "控制器制品签名身份格式无效",
    );
  }
  const recorded = artifact.manifest;
  if (artifact.status !== "ready"
    || signed.releaseId !== recorded.releaseId
    || signed.sourceCommit !== recorded.sourceCommit
    || signed.schemaVersion !== recorded.schemaVersion
    || signed.workerProtocolVersion !== recorded.workerProtocolVersion
    || JSON.stringify(signed.schemaCompatibility
      ?? defaultReleaseSchemaCompatibility(signed.schemaVersion))
      !== JSON.stringify(recorded.schemaCompatibility
        ?? defaultReleaseSchemaCompatibility(recorded.schemaVersion))
    || JSON.stringify(signed.runtimeCapabilities)
      !== JSON.stringify(recorded.runtimeCapabilities ?? [])
    || JSON.stringify(signed.deployment ?? null)
      !== JSON.stringify(recorded.deployment ?? null)
    || signed.schemaMode !== recorded.schemaMode
    || signed.format !== recorded.format
    || signed.web.assetStrategy !== recorded.web.assetStrategy
    || artifact.sourceCommit !== signed.sourceCommit
    || artifact.format !== signed.format) {
    fail(
      "RELEASE_CONTROLLER_ARTIFACT_SIGNED_IDENTITY_MISMATCH",
      "控制器制品签名身份与数据库记录不一致",
    );
  }
  return {
    releaseId: signed.releaseId,
    schemaVersion: signed.schemaVersion,
    workerProtocolVersion: signed.workerProtocolVersion,
    runtimeCapabilities: signed.runtimeCapabilities,
    ...(signed.deployment ? { deployment: signed.deployment } : {}),
  };
}

function assertLegacyBridgeSignedIdentity(
  artifact: ReleaseArtifactAttestationRecord,
  manifest: Record<string, unknown>,
  expectedSchemaCompatibility: ReleaseSchemaCompatibilityV1,
): {
  releaseId: string;
  schemaVersion: number;
  workerProtocolVersion: number;
  runtimeCapabilities: readonly string[];
  signedSchemaCompatibility: ReleaseSchemaCompatibilityV1;
  deployment?: ReleaseContainerDeploymentV1;
} {
  let signed;
  try {
    signed = parseReleaseArtifactManifest(manifest, artifact.releaseId);
  } catch {
    fail(
      "RELEASE_CONTROLLER_ARTIFACT_SIGNED_IDENTITY_INVALID",
      "控制器制品签名身份格式无效",
    );
  }
  const recorded = artifact.manifest;
  const recordedCompatibility = recorded.schemaCompatibility
    ?? defaultReleaseSchemaCompatibility(recorded.schemaVersion);
  const defaultCompatibility = defaultReleaseSchemaCompatibility(
    recorded.schemaVersion,
  );
  if (artifact.status !== "ready"
    || signed.releaseId !== recorded.releaseId
    || signed.sourceCommit !== recorded.sourceCommit
    || signed.schemaVersion !== recorded.schemaVersion
    || signed.workerProtocolVersion !== recorded.workerProtocolVersion
    || JSON.stringify(signed.schemaCompatibility)
      !== JSON.stringify(expectedSchemaCompatibility)
    || (
      JSON.stringify(recordedCompatibility)
        !== JSON.stringify(defaultCompatibility)
      && JSON.stringify(recordedCompatibility)
        !== JSON.stringify(expectedSchemaCompatibility)
    )
    || JSON.stringify(signed.runtimeCapabilities)
      !== JSON.stringify(recorded.runtimeCapabilities ?? [])
    || JSON.stringify(signed.deployment ?? null)
      !== JSON.stringify(recorded.deployment ?? null)
    || signed.schemaMode !== recorded.schemaMode
    || signed.format !== recorded.format
    || signed.web.assetStrategy !== recorded.web.assetStrategy
    || artifact.sourceCommit !== signed.sourceCommit
    || artifact.format !== signed.format) {
    fail(
      "RELEASE_CONTROLLER_LEGACY_BRIDGE_IDENTITY_MISMATCH",
      "legacy bridge 签名身份与数据库记录或预期 migration 不一致",
    );
  }
  return {
    releaseId: signed.releaseId,
    schemaVersion: signed.schemaVersion,
    workerProtocolVersion: signed.workerProtocolVersion,
    runtimeCapabilities: signed.runtimeCapabilities,
    signedSchemaCompatibility: signed.schemaCompatibility!,
    ...(signed.deployment ? { deployment: signed.deployment } : {}),
  };
}

async function inspectVerifiedCachedArtifact(input: {
  archivePath: string;
  artifact: ReleaseArtifactAttestationRecord;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<{
  cached: { sha256: string; byteSize: number };
  manifest: Record<string, unknown>;
  signedManifestFileSha256: string;
  attestation: VerifiedReleaseArtifactAttestation;
}> {
  if (!SHA256_PATTERN.test(input.artifact.sha256)
    || input.artifact.byteSize === null
    || !Number.isSafeInteger(input.artifact.byteSize)
    || input.artifact.byteSize < 1) {
    fail("RELEASE_CONTROLLER_ARTIFACT_DB_IDENTITY_INVALID", "数据库制品摘要或大小无效");
  }
  const cached = await digestCachedArtifact(input.archivePath, input.signal);
  if (cached.sha256 !== input.artifact.sha256
    || cached.byteSize !== input.artifact.byteSize) {
    fail(
      "RELEASE_CONTROLLER_ARTIFACT_CACHE_IDENTITY_MISMATCH",
      "控制器缓存与数据库制品身份不一致",
    );
  }
  const inspected = await inspectArchive(input.archivePath, input.signal);
  let manifest: unknown;
  try {
    manifest = JSON.parse(inspected.manifest.toString("utf8"));
  } catch {
    fail("RELEASE_CONTROLLER_ARTIFACT_MANIFEST_INVALID", "控制器制品清单不是有效 JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("RELEASE_CONTROLLER_ARTIFACT_MANIFEST_INVALID", "控制器制品清单格式无效");
  }
  let attestation: VerifiedReleaseArtifactAttestation;
  try {
    attestation = verifyReleaseArtifactAttestation(
      manifest,
      input.environment ?? process.env,
    );
  } catch (error) {
    if (error instanceof ReleaseArtifactAttestationError) {
      fail(error.code, error.message);
    }
    throw error;
  }
  assertArchiveMatchesSignedFiles(
    manifest as Record<string, unknown>,
    inspected.files,
  );
  return {
    cached,
    manifest: manifest as Record<string, unknown>,
    signedManifestFileSha256: crypto.createHash("sha256")
      .update(inspected.manifest)
      .digest("hex"),
    attestation,
  };
}

async function protectedRegularFile(
  filePath: string,
  exactMode: number | null,
): Promise<{ canonicalPath: string; metadata: Stats }> {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    fail("RELEASE_MIGRATION_ARTIFACT_PATH_UNSAFE", "迁移制品路径必须是规范绝对路径");
  }
  let canonicalPath: string;
  let originalMetadata: Stats;
  let canonicalMetadata: Stats;
  try {
    originalMetadata = await lstat(filePath);
    canonicalPath = await realpath(filePath);
    canonicalMetadata = await lstat(canonicalPath);
  } catch {
    fail("RELEASE_MIGRATION_ARTIFACT_PATH_UNSAFE", "迁移制品文件不可读取");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    currentUid === null
    || originalMetadata.isSymbolicLink()
    || canonicalMetadata.isSymbolicLink()
    || !originalMetadata.isFile()
    || !canonicalMetadata.isFile()
    || originalMetadata.nlink !== 1
    || canonicalMetadata.nlink !== 1
    || originalMetadata.dev !== canonicalMetadata.dev
    || originalMetadata.ino !== canonicalMetadata.ino
    || (canonicalMetadata.uid !== 0 && canonicalMetadata.uid !== currentUid)
    || (canonicalMetadata.mode & 0o022) !== 0
    || (exactMode !== null && (canonicalMetadata.mode & 0o777) !== exactMode)
  ) {
    fail("RELEASE_MIGRATION_ARTIFACT_PATH_UNSAFE", "迁移制品文件权限或类型无效");
  }
  return { canonicalPath, metadata: canonicalMetadata };
}

async function snapshotProtectedFile(
  filePath: string,
  destination: string,
  exactMode: number | null,
): Promise<{
  sha256: string;
  byteSize: number;
}> {
  const protectedFile = await protectedRegularFile(filePath, exactMode);
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || !noFollow) {
    fail("RELEASE_MIGRATION_ARTIFACT_PATH_UNSAFE", "运行平台不支持安全文件打开");
  }
  let source;
  let target;
  try {
    source = await open(
      protectedFile.canonicalPath,
      constants.O_RDONLY | noFollow,
    );
    target = await open(destination, "wx", 0o600);
  } catch {
    await source?.close().catch(() => undefined);
    fail("RELEASE_MIGRATION_ARTIFACT_PATH_UNSAFE", "迁移制品无法安全打开");
  }
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  try {
    const opened = await source.stat();
    if (
      !opened.isFile()
      || opened.dev !== protectedFile.metadata.dev
      || opened.ino !== protectedFile.metadata.ino
      || opened.size !== protectedFile.metadata.size
    ) {
      fail("RELEASE_MIGRATION_ARTIFACT_CHANGED", "迁移制品在安全打开前发生变化");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (byteSize < opened.size) {
      const result = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, opened.size - byteSize),
        byteSize,
      );
      if (result.bytesRead < 1) {
        fail("RELEASE_MIGRATION_ARTIFACT_CHANGED", "迁移制品读取长度发生变化");
      }
      const chunk = buffer.subarray(0, result.bytesRead);
      let written = 0;
      while (written < chunk.byteLength) {
        const result = await target.write(
          chunk,
          written,
          chunk.byteLength - written,
          byteSize + written,
        );
        if (result.bytesWritten < 1) {
          fail("RELEASE_MIGRATION_ARTIFACT_CHANGED", "迁移制品快照写入长度发生变化");
        }
        written += result.bytesWritten;
      }
      hash.update(chunk);
      byteSize += result.bytesRead;
    }
    await target.sync();
    const [closedOver, finalOriginal, finalCanonical] = await Promise.all([
      source.stat(),
      lstat(filePath),
      lstat(protectedFile.canonicalPath),
    ]);
    for (const metadata of [closedOver, finalOriginal, finalCanonical]) {
      if (
        !metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.dev !== protectedFile.metadata.dev
        || metadata.ino !== protectedFile.metadata.ino
        || metadata.size !== protectedFile.metadata.size
        || metadata.mtimeMs !== protectedFile.metadata.mtimeMs
      ) {
        fail("RELEASE_MIGRATION_ARTIFACT_CHANGED", "迁移制品在校验期间发生变化");
      }
    }
  } catch {
    throw new ReleaseControllerArtifactAttestationError(
      "RELEASE_MIGRATION_ARTIFACT_CHANGED",
      "迁移制品在校验期间发生变化",
    );
  } finally {
    await Promise.all([
      source.close().catch(() => undefined),
      target.close().catch(() => undefined),
    ]);
  }
  return { sha256: hash.digest("hex"), byteSize };
}

/**
 * Offline provenance gate for the standalone production migrator. It hashes
 * the protected immutable tar, verifies the CI Ed25519 signature and complete
 * file inventory, then binds the process' actual migrate.js bytes to the
 * signed `app/build/migrate.js` member. No source identity is accepted from an
 * environment variable.
 */
export async function verifyCachedMigrationArtifactProvenance(input: {
  archivePath: string;
  runtimeEntrypointPath: string;
  runtimeManifestPath?:
    | "app/build/migrate.js"
    | "app/build/migrate-maintenance-bootstrap.js"
    | "app/build/migrate-maintenance-upgrade.js"
    | "app/build/migrate-0.1.4-maintenance-upgrade.js";
  expectedArtifactSha256: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<CachedMigrationArtifactProvenance> {
  const runtimeManifestPath =
    input.runtimeManifestPath ?? "app/build/migrate.js";
  if (
    runtimeManifestPath !== "app/build/migrate.js"
    && runtimeManifestPath !== "app/build/migrate-maintenance-bootstrap.js"
    && runtimeManifestPath !== "app/build/migrate-maintenance-upgrade.js"
    && runtimeManifestPath !== "app/build/migrate-0.1.4-maintenance-upgrade.js"
  ) {
    fail(
      "RELEASE_MIGRATION_RUNTIME_PATH_INVALID",
      "迁移运行入口不在编译期允许列表中",
    );
  }
  if (!SHA256_PATTERN.test(input.expectedArtifactSha256)) {
    fail("RELEASE_MIGRATION_ARTIFACT_SHA_INVALID", "迁移制品 SHA-256 无效");
  }
  const snapshotDirectory = await mkdtemp(
    path.join(os.tmpdir(), "fanjin-migration-provenance-"),
  );
  const archiveSnapshot = path.join(snapshotDirectory, "artifact.tar.gz");
  const runtimeSnapshot = path.join(snapshotDirectory, "migrate.js");
  try {
    const cached = await snapshotProtectedFile(
      input.archivePath,
      archiveSnapshot,
      0o600,
    );
    if (cached.sha256 !== input.expectedArtifactSha256) {
      fail("RELEASE_MIGRATION_ARTIFACT_SHA_MISMATCH", "迁移制品 SHA-256 不一致");
    }
    const inspected = await inspectArchive(archiveSnapshot);
    let manifest: unknown;
    try {
      manifest = JSON.parse(inspected.manifest.toString("utf8"));
    } catch {
      fail("RELEASE_CONTROLLER_ARTIFACT_MANIFEST_INVALID", "迁移制品清单不是有效 JSON");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      fail("RELEASE_CONTROLLER_ARTIFACT_MANIFEST_INVALID", "迁移制品清单格式无效");
    }
    let attestation: VerifiedReleaseArtifactAttestation;
    try {
      attestation = verifyReleaseArtifactAttestation(
        manifest,
        input.environment ?? process.env,
      );
    } catch (error) {
      if (error instanceof ReleaseArtifactAttestationError) {
        fail(error.code, error.message);
      }
      throw error;
    }
    assertArchiveMatchesSignedFiles(
      manifest as Record<string, unknown>,
      inspected.files,
    );
    let signed;
    try {
      const manifestObject = manifest as Record<string, unknown>;
      signed = parseReleaseArtifactManifest(
        manifestObject,
        String(manifestObject.releaseId || ""),
      );
    } catch {
      fail("RELEASE_MIGRATION_ARTIFACT_IDENTITY_INVALID", "迁移制品签名身份无效");
    }
    const expectedRuntime = inspected.files.get(runtimeManifestPath);
    if (!expectedRuntime) {
      fail("RELEASE_MIGRATION_RUNTIME_NOT_SIGNED", "签名制品未包含迁移运行入口");
    }
    const runtime = await snapshotProtectedFile(
      input.runtimeEntrypointPath,
      runtimeSnapshot,
      null,
    );
    if (
      runtime.byteSize !== expectedRuntime.size
      || runtime.sha256 !== expectedRuntime.sha256
    ) {
      fail("RELEASE_MIGRATION_RUNTIME_MISMATCH", "当前迁移 binary 不属于签名制品");
    }
    return {
      artifactSha256: cached.sha256,
      sourceCommit: signed.sourceCommit,
      schemaVersion: signed.schemaVersion,
      schemaCompatibility: signed.schemaCompatibility
        ?? defaultReleaseSchemaCompatibility(signed.schemaVersion),
      runtimeEntrypointSha256: runtime.sha256,
      attestation,
    };
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
}

/**
 * Controller-owned, offline verification performed for target and rollback
 * artifacts before createExecution. It intentionally re-hashes cache hits and
 * never trusts the database ready flag as proof of CI origin.
 */
export async function verifyCachedReleaseArtifactAttestation(input: {
  archivePath: string;
  artifact: ReleaseArtifactAttestationRecord;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<CachedReleaseArtifactEvidence> {
  const verified = await inspectVerifiedCachedArtifact(input);
  const identity = assertSignedIdentity(
    input.artifact,
    verified.manifest,
  );
  return {
    artifactId: input.artifact.id,
    artifactSha256: verified.cached.sha256,
    signedManifestFileSha256: verified.signedManifestFileSha256,
    ...identity,
    attestation: verified.attestation,
  };
}

/**
 * One-time v35 bridge verifier. Pre-v36 API parsers stripped the then-unknown
 * schemaCompatibility field before persisting manifestJson, while the archive
 * attestation and node-local manifest retained it. This verifier permits only
 * that single DB/archive difference and requires the caller-supplied exact
 * allowlisted edge; every other signed identity field remains byte-for-byte
 * bound to the ready artifact.
 */
export async function verifyCachedLegacyBridgeArtifactAttestation(input: {
  archivePath: string;
  artifact: ReleaseArtifactAttestationRecord;
  expectedSchemaCompatibility: ReleaseSchemaCompatibilityV1;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<CachedLegacyBridgeArtifactEvidence> {
  const verified = await inspectVerifiedCachedArtifact(input);
  const identity = assertLegacyBridgeSignedIdentity(
    input.artifact,
    verified.manifest,
    input.expectedSchemaCompatibility,
  );
  return {
    artifactId: input.artifact.id,
    artifactSha256: verified.cached.sha256,
    signedManifestFileSha256: verified.signedManifestFileSha256,
    ...identity,
    attestation: verified.attestation,
  };
}
