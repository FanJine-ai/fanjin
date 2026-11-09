import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, realpath, rm, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  createRemoteObjectStorageAdapter,
  normalizeObjectKey,
} from "@/lib/objectStorage";
import { resolveObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import {
  ReleaseArtifactAttestationError,
  verifyReleaseArtifactAttestation,
  type VerifiedReleaseArtifactAttestation,
} from "@/lib/releaseArtifactAttestation";
import getPath from "@/utils/getPath";

const MANIFEST_ARCHIVE_PATH = "release/release-manifest.json";
// Full production dependency inventories are larger than 4 MiB. This matches
// the manifest bound used when release records are persisted.
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
// Keep this aligned with the current single-request artifact upload ceiling.
// The value is resolved per verification so tests can safely lower (never
// raise) the limit without allocating multi-gigabyte fixtures.
const MAX_RELEASE_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const MANIFEST_VERIFY_TIMEOUT_MS = 60_000;
const TEMP_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
const SIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;
export const RELEASE_ARTIFACT_TEMP_PREFIX = "fanjin-release-artifact-";

export class ReleaseArtifactVerificationError extends Error {
  readonly code: string;

  constructor(message: string, code = "RELEASE_ARTIFACT_VERIFICATION_FAILED") {
    super(message);
    this.name = "ReleaseArtifactVerificationError";
    this.code = code;
  }
}

export interface VerifiedStoredReleaseArtifact {
  byteSize: number;
  sha256: string;
  manifest: Record<string, unknown>;
  attestation: VerifiedReleaseArtifactAttestation;
}

function configuredMaximumArtifactBytes(): number {
  const configured = Number(process.env.FANJIN_RELEASE_ARTIFACT_VERIFY_MAX_BYTES || "");
  if (Number.isSafeInteger(configured) && configured > 0) {
    return Math.min(configured, MAX_RELEASE_ARTIFACT_BYTES);
  }
  return MAX_RELEASE_ARTIFACT_BYTES;
}

function configuredTimeout(name: string, fallback: number, minimum: number, maximum: number): number {
  const configured = Number(process.env[name] || "");
  return Number.isSafeInteger(configured) && configured >= minimum && configured <= maximum
    ? configured
    : fallback;
}

async function assertTemporaryDiskCapacity(directory: string, artifactBytes: number): Promise<void> {
  try {
    const capacity = await statfs(directory, { bigint: true });
    const available = capacity.bavail * capacity.bsize;
    const required = BigInt(artifactBytes) + BigInt(TEMP_SPACE_RESERVE_BYTES);
    if (available < required) {
      throw new ReleaseArtifactVerificationError(
        "服务端临时磁盘空间不足，无法安全校验制品",
        "RELEASE_ARTIFACT_TEMP_SPACE_INSUFFICIENT",
      );
    }
  } catch (error) {
    if (error instanceof ReleaseArtifactVerificationError) throw error;
    throw new ReleaseArtifactVerificationError(
      "无法确认服务端临时磁盘容量",
      "RELEASE_ARTIFACT_TEMP_SPACE_UNAVAILABLE",
    );
  }
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function createLocalObjectStream(storageKey: string, signal: AbortSignal): Promise<Readable> {
  const normalizedKey = normalizeObjectKey(storageKey);
  const objectRoot = await realpath(getPath("oss"));
  const candidate = getPath(["oss", ...normalizedKey.split("/")]);
  const resolvedObject = await realpath(candidate);
  if (!isPathWithin(resolvedObject, objectRoot)) {
    throw new Error("RELEASE_ARTIFACT_LOCAL_PATH_INVALID");
  }
  return fs.createReadStream(resolvedObject, { signal });
}

interface StoredReleaseArtifactIdentity {
  storageKey: string;
  storageProvider?: "s3" | "tos" | null;
  storageBucket?: string | null;
  storageRegion?: string | null;
  storageEndpoint?: string | null;
  storageKeyPrefix?: string | null;
  storageForcePathStyle?: boolean | null;
  storageVersionId?: string | null;
  storageEtag?: string | null;
}

async function createRemoteObjectStream(
  identity: StoredReleaseArtifactIdentity,
  signal: AbortSignal,
): Promise<Readable> {
  const configuration = resolveObjectStorageConfiguration();
  const versionId = String(identity.storageVersionId || "").trim();
  const etag = String(identity.storageEtag || "").trim();
  if (
    !versionId
    || versionId === "null"
    || !etag
    || identity.storageProvider !== configuration.provider
    || identity.storageBucket !== configuration.bucket
    || identity.storageRegion !== configuration.region
    || identity.storageEndpoint !== configuration.endpoint
    || identity.storageKeyPrefix !== configuration.keyPrefix
    || identity.storageForcePathStyle !== configuration.forcePathStyle
  ) {
    throw new Error("RELEASE_ARTIFACT_EXACT_GENERATION_MISSING");
  }
  const storage = createRemoteObjectStorageAdapter({
    ...configuration,
    // Verification must never depend on a public CDN URL. Always issue a
    // short-lived, credential-free GET URL for the exact private object.
    urlMode: "signed",
    signedUrlTtlSeconds: Math.min(
      configuration.signedUrlTtlSeconds,
      SIGNED_DOWNLOAD_TTL_SECONDS,
    ),
  });
  const signedUrl = new URL(await storage.getUrl(
    normalizeObjectKey(identity.storageKey),
    { versionId },
  ));
  if (signedUrl.protocol !== "https:" || signedUrl.username || signedUrl.password) {
    throw new Error("RELEASE_ARTIFACT_SIGNED_URL_INVALID");
  }

  const response = await fetch(signedUrl, {
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("RELEASE_ARTIFACT_REMOTE_OBJECT_UNAVAILABLE");
  }
  const observedVersionId = String(
    response.headers.get("x-amz-version-id")
      || response.headers.get("x-tos-version-id")
      || "",
  ).trim();
  const observedEtag = String(response.headers.get("etag") || "").trim();
  if (observedVersionId !== versionId || observedEtag !== etag) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("RELEASE_ARTIFACT_GENERATION_EVIDENCE_MISMATCH");
  }
  return Readable.fromWeb(response.body as unknown as NodeReadableStream, { signal });
}

async function createStoredObjectStream(
  identity: StoredReleaseArtifactIdentity,
  signal: AbortSignal,
): Promise<Readable> {
  // Once an artifact carries remote provider provenance, that provenance is
  // authoritative. A later configuration drift to `local` must not make the
  // verifier silently read a same-named filesystem object and bypass the
  // registered version/ETag binding.
  if (
    identity.storageProvider === "s3"
    || identity.storageProvider === "tos"
  ) {
    return createRemoteObjectStream(identity, signal);
  }
  const configuration = resolveObjectStorageConfiguration();
  return configuration.provider === "local"
    ? createLocalObjectStream(identity.storageKey, signal)
    : createRemoteObjectStream(identity, signal);
}

async function streamObjectToFile(input: StoredReleaseArtifactIdentity & {
  destination: string;
  maximumByteSize: number;
}): Promise<{ byteSize: number; sha256: string }> {
  const controller = new AbortController();
  let timeoutReason: "total" | "idle" | null = null;
  const downloadTimeoutMs = configuredTimeout(
    "FANJIN_RELEASE_ARTIFACT_VERIFY_TIMEOUT_MS",
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
    1_000,
    60 * 60_000,
  );
  const idleTimeoutMs = configuredTimeout(
    "FANJIN_RELEASE_ARTIFACT_VERIFY_IDLE_TIMEOUT_MS",
    DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS,
    1_000,
    10 * 60_000,
  );
  const totalTimeout = setTimeout(() => {
    timeoutReason = "total";
    controller.abort();
  }, downloadTimeoutMs);
  totalTimeout.unref?.();
  let idleTimeout: NodeJS.Timeout | null = null;
  const armIdleTimeout = () => {
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      timeoutReason = "idle";
      controller.abort();
    }, idleTimeoutMs);
    idleTimeout.unref?.();
  };
  armIdleTimeout();

  let byteSize = 0;
  const hash = crypto.createHash("sha256");
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      armIdleTimeout();
      const nextByteSize = byteSize + chunk.byteLength;
      if (nextByteSize > input.maximumByteSize) {
        callback(new ReleaseArtifactVerificationError(
          "制品超过服务端校验体积上限",
          "RELEASE_ARTIFACT_TOO_LARGE",
        ));
        return;
      }
      byteSize = nextByteSize;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    const source = await createStoredObjectStream(input, controller.signal);
    const destination = fs.createWriteStream(input.destination, {
      flags: "wx",
      mode: 0o600,
      signal: controller.signal,
    });
    await pipeline(source, meter, destination, { signal: controller.signal });
    return { byteSize, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof ReleaseArtifactVerificationError) throw error;
    if (timeoutReason) {
      throw new ReleaseArtifactVerificationError(
        timeoutReason === "idle" ? "服务端校验制品长时间无进展" : "服务端校验制品超过总时限",
        "RELEASE_ARTIFACT_VERIFICATION_TIMEOUT",
      );
    }
    throw new ReleaseArtifactVerificationError(
      "无法读取服务端制品对象",
      "RELEASE_ARTIFACT_OBJECT_UNAVAILABLE",
    );
  } finally {
    clearTimeout(totalTimeout);
    if (idleTimeout) clearTimeout(idleTimeout);
  }
}

async function extractManifest(archivePath: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("tar", ["-xOzf", archivePath, MANIFEST_ARCHIVE_PATH], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let byteSize = 0;
    let failure: ReleaseArtifactVerificationError | null = null;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const failAndKill = (error: ReleaseArtifactVerificationError) => {
      if (!failure) failure = error;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      failAndKill(new ReleaseArtifactVerificationError(
        "服务端校验制品清单超时",
        "RELEASE_ARTIFACT_VERIFICATION_TIMEOUT",
      ));
    }, MANIFEST_VERIFY_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      byteSize += chunk.byteLength;
      if (byteSize > MAX_MANIFEST_BYTES) {
        failAndKill(new ReleaseArtifactVerificationError(
          "制品清单超过允许大小",
          "RELEASE_ARTIFACT_MANIFEST_TOO_LARGE",
        ));
        return;
      }
      chunks.push(chunk);
    });
    // Drain diagnostics so tar cannot block on a full stderr pipe. Do not
    // retain or expose archive-controlled error output.
    child.stderr.resume();
    child.once("error", () => {
      finish(() => reject(new ReleaseArtifactVerificationError(
        "无法读取制品清单",
        "RELEASE_ARTIFACT_MANIFEST_MISSING",
      )));
    });
    child.once("close", (status) => {
      finish(() => {
        if (failure) {
          reject(failure);
          return;
        }
        if (status !== 0 || byteSize === 0) {
          reject(new ReleaseArtifactVerificationError(
            "制品缺少有效的 release-manifest.json",
            "RELEASE_ARTIFACT_MANIFEST_MISSING",
          ));
          return;
        }
        resolve(Buffer.concat(chunks, byteSize));
      });
    });
  });
}

/**
 * Verify the immutable object itself, not browser assertions. The archive is
 * streamed through a bounded 0600 temporary file, and only the exact manifest
 * member is read by tar; package paths are never extracted onto disk. The node
 * agent performs the deeper file-set verification before activation.
 */
export async function verifyStoredReleaseArtifact(input: {
  storageKey: string;
  storageProvider?: "s3" | "tos" | null;
  storageBucket?: string | null;
  storageRegion?: string | null;
  storageEndpoint?: string | null;
  storageKeyPrefix?: string | null;
  storageForcePathStyle?: boolean | null;
  storageVersionId?: string | null;
  storageEtag?: string | null;
  expectedSha256: string;
  expectedByteSize?: number | null;
}): Promise<VerifiedStoredReleaseArtifact> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), RELEASE_ARTIFACT_TEMP_PREFIX));
  const archivePath = path.join(temporaryDirectory, "artifact.tar.gz");

  try {
    const maximumByteSize = configuredMaximumArtifactBytes();
    if (input.expectedByteSize != null && input.expectedByteSize > maximumByteSize) {
      throw new ReleaseArtifactVerificationError(
        "制品超过服务端校验体积上限",
        "RELEASE_ARTIFACT_TOO_LARGE",
      );
    }
    await assertTemporaryDiskCapacity(
      temporaryDirectory,
      input.expectedByteSize ?? maximumByteSize,
    );
    const downloaded = await streamObjectToFile({
      storageKey: input.storageKey,
      storageProvider: input.storageProvider,
      storageBucket: input.storageBucket,
      storageRegion: input.storageRegion,
      storageEndpoint: input.storageEndpoint,
      storageKeyPrefix: input.storageKeyPrefix,
      storageForcePathStyle: input.storageForcePathStyle,
      storageVersionId: input.storageVersionId,
      storageEtag: input.storageEtag,
      destination: archivePath,
      maximumByteSize,
    });

    if (input.expectedByteSize != null && downloaded.byteSize !== input.expectedByteSize) {
      throw new ReleaseArtifactVerificationError(
        "制品大小与登记信息不一致",
        "RELEASE_ARTIFACT_SIZE_MISMATCH",
      );
    }
    if (downloaded.sha256 !== input.expectedSha256.toLowerCase()) {
      throw new ReleaseArtifactVerificationError(
        "制品 SHA-256 校验失败",
        "RELEASE_ARTIFACT_SHA256_MISMATCH",
      );
    }

    const manifestBuffer = await extractManifest(archivePath);
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestBuffer.toString("utf8"));
    } catch {
      throw new ReleaseArtifactVerificationError(
        "制品清单不是有效 JSON",
        "RELEASE_ARTIFACT_MANIFEST_INVALID",
      );
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new ReleaseArtifactVerificationError(
        "制品清单格式无效",
        "RELEASE_ARTIFACT_MANIFEST_INVALID",
      );
    }
    let attestation: VerifiedReleaseArtifactAttestation;
    try {
      // The trust store is local server configuration. Verification never
      // follows a URL or accepts a public key embedded in the artifact.
      attestation = verifyReleaseArtifactAttestation(manifest);
    } catch (error) {
      if (error instanceof ReleaseArtifactAttestationError) {
        throw new ReleaseArtifactVerificationError(error.message, error.code);
      }
      throw error;
    }
    return {
      byteSize: downloaded.byteSize,
      sha256: downloaded.sha256,
      manifest: manifest as Record<string, unknown>,
      attestation,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
