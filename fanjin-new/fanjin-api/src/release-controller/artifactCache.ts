import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  statfs,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";

import type { ObjectStorageAdapter } from "@/lib/objectStorage";
import type { ObjectStorageConfiguration } from "@/lib/objectStorageConfig";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CACHE_ENTRIES = 2;
const CACHE_FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 0;

export interface CachedReleaseArtifact {
  storageKey: string;
  storageProvider?: "s3" | "tos";
  storageBucket?: string;
  storageRegion?: string;
  storageEndpoint?: string;
  storageKeyPrefix?: string;
  storageForcePathStyle?: boolean;
  storageVersionId?: string;
  storageEtag?: string;
  sha256: string;
  byteSize: number;
}

export interface ReleaseArtifactDownload {
  body: AsyncIterable<Uint8Array>;
  contentLength: number | null;
}

export interface ReleaseArtifactDownloadSource {
  open(
    storageKey: string,
    generation?: {
      versionId?: string;
      etag?: string;
      provider?: "s3" | "tos";
      bucket?: string;
      region?: string;
      endpoint?: string;
      keyPrefix?: string;
      forcePathStyle?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<ReleaseArtifactDownload>;
}

export class ReleaseArtifactCacheError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReleaseArtifactCacheError";
    this.code = code;
  }
}

function safeSha256(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new ReleaseArtifactCacheError("RELEASE_ARTIFACT_SHA256_INVALID", "制品 SHA-256 格式无效");
  }
  return normalized;
}

function safeExpectedSize(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ReleaseArtifactCacheError(
      "RELEASE_ARTIFACT_SIZE_INVALID",
      "制品大小为空或超过发布控制器限制",
    );
  }
  return value;
}

function safeTimeout(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 60 * 60_000) {
    throw new ReleaseArtifactCacheError("RELEASE_CACHE_CONFIG_INVALID", `${label} 配置无效`);
  }
  return resolved;
}

function safePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new ReleaseArtifactCacheError("RELEASE_CACHE_CONFIG_INVALID", `${label} 配置无效`);
  }
  return resolved;
}

async function waitForDownloadStep<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  if (signal.aborted) {
    throw new ReleaseArtifactCacheError("RELEASE_ARTIFACT_DOWNLOAD_ABORTED", "制品下载已停止");
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      callback();
    };
    const aborted = () => finish(() => reject(
      new ReleaseArtifactCacheError("RELEASE_ARTIFACT_DOWNLOAD_ABORTED", "制品下载已停止"),
    ));
    const timer = setTimeout(() => finish(() => {
      onTimeout();
      reject(new ReleaseArtifactCacheError("RELEASE_ARTIFACT_DOWNLOAD_TIMEOUT", "制品下载超时或长时间无进展"));
    }), timeoutMs);
    timer.unref?.();
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || path.parse(directory).root === directory) {
    throw new ReleaseArtifactCacheError("RELEASE_CACHE_PATH_INVALID", "制品缓存目录必须是安全的绝对路径");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ReleaseArtifactCacheError("RELEASE_CACHE_PATH_INVALID", "制品缓存目录不是普通目录");
  }
  await chmod(directory, 0o700);
}

async function digestFile(filePath: string): Promise<{ sha256: string; byteSize: number }> {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ReleaseArtifactCacheError("RELEASE_CACHE_FILE_INVALID", "制品缓存项不是普通文件");
  }
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    byteSize += bytes.byteLength;
    digest.update(bytes);
  }
  return { sha256: digest.digest("hex"), byteSize };
}

async function fsyncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, fsConstants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

/**
 * Streams one immutable private object into a controller-owned cache.
 * No object URL, credential, or response body is persisted in a checkpoint.
 */
export class ReleaseArtifactCache {
  private readonly directory: string;
  private readonly source: ReleaseArtifactDownloadSource;
  private readonly maximumBytes: number;
  private readonly maximumCacheBytes: number;
  private readonly maximumCacheEntries: number;
  private readonly downloadTimeoutMs: number;
  private readonly downloadIdleTimeoutMs: number;
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(options: {
    directory: string;
    source: ReleaseArtifactDownloadSource;
    maximumBytes?: number;
    maximumCacheBytes?: number;
    maximumCacheEntries?: number;
    downloadTimeoutMs?: number;
    downloadIdleTimeoutMs?: number;
  }) {
    if (!path.isAbsolute(options.directory)) {
      throw new ReleaseArtifactCacheError(
        "RELEASE_CACHE_PATH_INVALID",
        "制品缓存目录必须是绝对路径",
      );
    }
    this.directory = path.resolve(options.directory);
    this.source = options.source;
    this.maximumBytes = safeExpectedSize(
      options.maximumBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.maximumCacheBytes = safeExpectedSize(
      options.maximumCacheBytes ?? this.maximumBytes * DEFAULT_MAX_CACHE_ENTRIES,
      Number.MAX_SAFE_INTEGER,
    );
    if (this.maximumCacheBytes < this.maximumBytes) {
      throw new ReleaseArtifactCacheError(
        "RELEASE_CACHE_CONFIG_INVALID",
        "maximumCacheBytes 不能小于单个制品上限",
      );
    }
    this.maximumCacheEntries = safePositiveInteger(
      options.maximumCacheEntries,
      DEFAULT_MAX_CACHE_ENTRIES,
      "maximumCacheEntries",
    );
    this.downloadTimeoutMs = safeTimeout(options.downloadTimeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS, "downloadTimeoutMs");
    this.downloadIdleTimeoutMs = safeTimeout(
      options.downloadIdleTimeoutMs,
      DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS,
      "downloadIdleTimeoutMs",
    );
  }

  async ensure(artifact: CachedReleaseArtifact, signal?: AbortSignal): Promise<string> {
    const sha256 = safeSha256(artifact.sha256);
    const byteSize = safeExpectedSize(artifact.byteSize, this.maximumBytes);
    const key = `${sha256}:${byteSize}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.download({ ...artifact, sha256, byteSize }, signal)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async download(artifact: CachedReleaseArtifact, signal?: AbortSignal): Promise<string> {
    await assertPrivateDirectory(this.directory);
    const destination = path.join(this.directory, `${artifact.sha256}.tar.gz`);

    try {
      const cached = await digestFile(destination);
      if (cached.sha256 === artifact.sha256 && cached.byteSize === artifact.byteSize) {
        await chmod(destination, 0o600);
        const now = new Date();
        await utimes(destination, now, now);
        return destination;
      }
      throw new ReleaseArtifactCacheError(
        "RELEASE_CACHE_COLLISION",
        "本机制品缓存与登记摘要不一致，拒绝覆盖",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }

    await this.prepareCapacity(destination, artifact.byteSize);

    const temporary = path.join(
      this.directory,
      `.${artifact.sha256}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: Awaited<ReturnType<typeof open>> | null = null;
    const downloadAbort = new AbortController();
    const abortFromCaller = () => downloadAbort.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) downloadAbort.abort();
    const deadline = Date.now() + this.downloadTimeoutMs;
    const remainingTimeout = () => Math.min(
      this.downloadIdleTimeoutMs,
      Math.max(1, deadline - Date.now()),
    );
    let iterator: AsyncIterator<Uint8Array> | null = null;
    try {
      descriptor = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
      let download: ReleaseArtifactDownload;
      try {
        download = await waitForDownloadStep(
          this.source.open(
            artifact.storageKey,
            {
              versionId: artifact.storageVersionId,
              etag: artifact.storageEtag,
              provider: artifact.storageProvider,
              bucket: artifact.storageBucket,
              region: artifact.storageRegion,
              endpoint: artifact.storageEndpoint,
              keyPrefix: artifact.storageKeyPrefix,
              forcePathStyle: artifact.storageForcePathStyle,
            },
            downloadAbort.signal,
          ),
          downloadAbort.signal,
          remainingTimeout(),
          () => downloadAbort.abort(),
        );
      } catch (error) {
        if (error instanceof ReleaseArtifactCacheError) throw error;
        throw new ReleaseArtifactCacheError(
          "RELEASE_ARTIFACT_OBJECT_UNAVAILABLE",
          "无法从私有对象存储读取发布制品",
        );
      }
      if (download.contentLength !== null && download.contentLength !== artifact.byteSize) {
        throw new ReleaseArtifactCacheError(
          "RELEASE_ARTIFACT_SIZE_MISMATCH",
          "对象存储制品大小与登记信息不一致",
        );
      }

      const digest = createHash("sha256");
      let received = 0;
      iterator = download.body[Symbol.asyncIterator]();
      while (true) {
        if (Date.now() >= deadline) {
          downloadAbort.abort();
          throw new ReleaseArtifactCacheError("RELEASE_ARTIFACT_DOWNLOAD_TIMEOUT", "制品下载超过总时限");
        }
        const next = await waitForDownloadStep(
          iterator.next(),
          downloadAbort.signal,
          remainingTimeout(),
          () => downloadAbort.abort(),
        );
        if (next.done) break;
        const rawChunk = next.value;
        const chunk = Buffer.from(rawChunk);
        received += chunk.byteLength;
        if (received > artifact.byteSize || received > this.maximumBytes) {
          throw new ReleaseArtifactCacheError(
            "RELEASE_ARTIFACT_SIZE_MISMATCH",
            "对象存储制品超过登记大小或控制器限制",
          );
        }
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await descriptor.write(chunk, offset, chunk.byteLength - offset);
          if (written.bytesWritten < 1) {
            throw new ReleaseArtifactCacheError(
              "RELEASE_CACHE_WRITE_FAILED",
              "写入本机制品缓存失败",
            );
          }
          offset += written.bytesWritten;
        }
      }
      if (received !== artifact.byteSize) {
        throw new ReleaseArtifactCacheError(
          "RELEASE_ARTIFACT_SIZE_MISMATCH",
          "对象存储制品长度与登记信息不一致",
        );
      }
      if (digest.digest("hex") !== artifact.sha256) {
        throw new ReleaseArtifactCacheError(
          "RELEASE_ARTIFACT_SHA256_MISMATCH",
          "对象存储制品 SHA-256 校验失败",
        );
      }
      await descriptor.sync();
      await descriptor.close();
      descriptor = null;

      // The service is single-instance; refusing an unexpected collision is
      // safer than overwriting a cache entry another process may have placed.
      try {
        await lstat(destination);
        throw new ReleaseArtifactCacheError("RELEASE_CACHE_COLLISION", "制品缓存目标已存在");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      await rename(temporary, destination);
      await chmod(destination, 0o600);
      await fsyncDirectory(this.directory);
      return destination;
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      downloadAbort.abort();
      if (iterator?.return) await Promise.resolve(iterator.return()).catch(() => undefined);
      if (descriptor) await descriptor.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async prepareCapacity(destination: string, incomingBytes: number): Promise<void> {
    const protectedPaths = new Set<string>([destination]);
    let reservedIncomingBytes = 0;
    let reservedIncomingEntries = 0;
    for (const key of this.inFlight.keys()) {
      const [sha256, rawSize] = key.split(":", 2);
      if (SHA256_PATTERN.test(sha256)) {
        const reservedPath = path.join(this.directory, `${sha256}.tar.gz`);
        protectedPaths.add(reservedPath);
        if (reservedPath !== destination) {
          const size = Number(rawSize);
          if (Number.isSafeInteger(size) && size > 0) {
            reservedIncomingBytes += size;
            reservedIncomingEntries += 1;
          }
        }
      }
    }

    const cacheEntries: Array<{ path: string; size: number; modifiedAt: number }> = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}\.tar\.gz$/.test(entry.name)) continue;
      const candidate = path.join(this.directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new ReleaseArtifactCacheError(
          "RELEASE_CACHE_FILE_INVALID",
          "制品缓存项不是普通文件",
        );
      }
      cacheEntries.push({ path: candidate, size: metadata.size, modifiedAt: metadata.mtimeMs });
    }

    let totalBytes = cacheEntries.reduce((sum, entry) => sum + entry.size, 0);
    let totalEntries = cacheEntries.length;
    for (const entry of cacheEntries
      .filter((candidate) => !protectedPaths.has(candidate.path))
      .sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path))) {
      if (
        totalEntries + reservedIncomingEntries < this.maximumCacheEntries
        && totalBytes + reservedIncomingBytes + incomingBytes <= this.maximumCacheBytes
      ) break;
      await unlink(entry.path);
      totalBytes -= entry.size;
      totalEntries -= 1;
    }

    if (
      totalEntries + reservedIncomingEntries >= this.maximumCacheEntries
      || totalBytes + reservedIncomingBytes + incomingBytes > this.maximumCacheBytes
    ) {
      throw new ReleaseArtifactCacheError(
        "RELEASE_CACHE_CAPACITY_EXCEEDED",
        "控制器制品缓存已达到安全容量上限",
      );
    }

    try {
      const capacity = await statfs(this.directory, { bigint: true });
      const available = capacity.bavail * capacity.bsize;
      const required = BigInt(incomingBytes + reservedIncomingBytes)
        + BigInt(CACHE_FREE_SPACE_RESERVE_BYTES);
      if (available < required) {
        throw new ReleaseArtifactCacheError(
          "RELEASE_CACHE_DISK_SPACE_INSUFFICIENT",
          "控制器磁盘空间不足，无法缓存发布制品",
        );
      }
    } catch (error) {
      if (error instanceof ReleaseArtifactCacheError) throw error;
      throw new ReleaseArtifactCacheError(
        "RELEASE_CACHE_DISK_SPACE_UNAVAILABLE",
        "无法确认控制器制品缓存磁盘容量",
      );
    }
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Production source: short-lived URL exists only on the stack for this GET. */
export class SignedObjectStorageDownloadSource implements ReleaseArtifactDownloadSource {
  private readonly storage: Pick<ObjectStorageAdapter, "getUrl">;
  private readonly fetchImplementation: typeof fetch;
  private readonly storageIdentity: {
    provider: "s3" | "tos";
    bucket: string;
    region: string;
    endpoint: string;
    keyPrefix: string;
    forcePathStyle: boolean;
  };

  constructor(options: {
    storage: Pick<ObjectStorageAdapter, "getUrl">;
    configuration: ObjectStorageConfiguration;
    fetch?: typeof fetch;
  }) {
    const configuration = options.configuration;
    if (
      (configuration.provider !== "s3" && configuration.provider !== "tos")
      || !configuration.bucket
      || !configuration.region
      || !configuration.endpoint
    ) {
      throw new ReleaseArtifactCacheError(
        "RELEASE_CACHE_CONFIG_INVALID",
        "发布制品对象存储身份配置无效",
      );
    }
    this.storage = options.storage;
    this.storageIdentity = {
      provider: configuration.provider,
      bucket: configuration.bucket,
      region: configuration.region,
      endpoint: configuration.endpoint,
      keyPrefix: configuration.keyPrefix,
      forcePathStyle: configuration.forcePathStyle,
    };
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async open(
    storageKey: string,
    generation: {
      versionId?: string;
      etag?: string;
      provider?: "s3" | "tos";
      bucket?: string;
      region?: string;
      endpoint?: string;
      keyPrefix?: string;
      forcePathStyle?: boolean;
    } = {},
    signal?: AbortSignal,
  ): Promise<ReleaseArtifactDownload> {
    let signedUrl: string | null = null;
    try {
      if (
        !generation.versionId
        || generation.versionId === "null"
        || !generation.etag
        || generation.provider !== this.storageIdentity.provider
        || generation.bucket !== this.storageIdentity.bucket
        || generation.region !== this.storageIdentity.region
        || generation.endpoint !== this.storageIdentity.endpoint
        || generation.keyPrefix !== this.storageIdentity.keyPrefix
        || generation.forcePathStyle !== this.storageIdentity.forcePathStyle
      ) {
        throw new Error("exact generation evidence missing");
      }
      signedUrl = await this.storage.getUrl(storageKey, {
        versionId: generation.versionId,
      });
      const parsed = new URL(signedUrl);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("invalid private object URL");
      }
      const response = await this.fetchImplementation(parsed, {
        method: "GET",
        redirect: MAX_DOWNLOAD_REDIRECTS === 0 ? "error" : "follow",
        signal,
      });
      if (!response.ok || !response.body) throw new Error("private object request rejected");
      const observedVersionId = String(
        response.headers.get("x-amz-version-id")
          || response.headers.get("x-tos-version-id")
          || "",
      ).trim();
      const observedEtag = String(response.headers.get("etag") || "").trim();
      if (
        observedVersionId !== generation.versionId
        || observedEtag !== generation.etag
      ) {
        await response.body.cancel().catch(() => undefined);
        throw new Error("private object generation evidence mismatch");
      }
      return {
        body: response.body as unknown as AsyncIterable<Uint8Array>,
        contentLength: parseContentLength(response.headers.get("content-length")),
      };
    } catch {
      // Never include the signed URL or upstream error in this exception.
      throw new ReleaseArtifactCacheError(
        "RELEASE_ARTIFACT_OBJECT_UNAVAILABLE",
        "无法从私有对象存储读取发布制品",
      );
    } finally {
      signedUrl = null;
    }
  }
}
