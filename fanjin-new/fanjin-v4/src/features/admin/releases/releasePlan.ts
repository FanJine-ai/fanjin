import type {
  ReleaseArtifactManifest,
  ReleaseArtifactRecord,
  ReleaseArtifactSidecar,
} from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createDefaultManifest(releaseId: string): ReleaseArtifactManifest {
  return {
    manifestVersion: 1,
    format: "fanjin-release/v1",
    releaseId,
    sourceCommit: "",
    schemaVersion: 1,
    workerProtocolVersion: 1,
    schemaMode: "schema-neutral",
    web: { assetStrategy: "shared-union-v1" },
  };
}

export function defaultManifestText(releaseId = "") {
  return JSON.stringify(createDefaultManifest(releaseId), null, 2);
}

export function parseManifestText(value: string, expectedReleaseId?: string): ReleaseArtifactManifest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new Error("Manifest 不是有效的 JSON。请检查逗号和引号。");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Manifest 必须是 JSON 对象。");
  }
  const manifest = candidate as Record<string, unknown>;
  if (manifest.manifestVersion !== 1) throw new Error("Manifest manifestVersion 必须为 1。");
  if (manifest.format !== "fanjin-release/v1") throw new Error("Manifest format 必须为 fanjin-release/v1。");
  const releaseId = String(manifest.releaseId || "").trim();
  if (!releaseId) throw new Error("Manifest 缺少 releaseId。");
  if (expectedReleaseId && releaseId !== expectedReleaseId) throw new Error("Manifest releaseId 与当前版本不一致。");
  const sourceCommit = String(manifest.sourceCommit || "").trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceCommit)) {
    throw new Error("Manifest sourceCommit 必须是 40 或 64 位小写 Git 摘要。");
  }
  const schemaVersion = manifest.schemaVersion;
  if (typeof schemaVersion !== "number"
    || !Number.isSafeInteger(schemaVersion)
    || schemaVersion < 1
    || schemaVersion > 2_147_483_647) {
    throw new Error("Manifest schemaVersion 必须是 1-2147483647 的 JSON 正整数。");
  }
  const workerProtocolVersion = manifest.workerProtocolVersion;
  if (typeof workerProtocolVersion !== "number"
    || !Number.isSafeInteger(workerProtocolVersion)
    || workerProtocolVersion < 1
    || workerProtocolVersion > 2_147_483_647) {
    throw new Error("Manifest workerProtocolVersion 必须是 1-2147483647 的 JSON 正整数。");
  }
  if (manifest.schemaMode !== "schema-neutral") {
    throw new Error("首版无感发布仅支持 schema-neutral 制品。");
  }
  const web = manifest.web && typeof manifest.web === "object" && !Array.isArray(manifest.web)
    ? manifest.web as Record<string, unknown>
    : null;
  if (web?.assetStrategy !== "shared-union-v1") {
    throw new Error("Manifest web.assetStrategy 必须为 shared-union-v1。");
  }
  return {
    ...manifest,
    manifestVersion: 1,
    format: "fanjin-release/v1",
    releaseId,
    sourceCommit,
    schemaVersion,
    workerProtocolVersion,
    schemaMode: "schema-neutral",
    web: { assetStrategy: "shared-union-v1" },
  } as ReleaseArtifactManifest;
}

export function isUuid(value: string) {
  return UUID_PATTERN.test(value.trim());
}

export function parseArtifactSidecarText(
  value: string,
  expectedReleaseId: string,
  archiveByteSize?: number,
): ReleaseArtifactSidecar {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new Error("制品 sidecar 不是有效的 JSON。");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("制品 sidecar 必须是 JSON 对象。");
  }
  const sidecar = candidate as Record<string, unknown>;
  if (sidecar.format !== "fanjin-release-artifact/v1") {
    throw new Error("sidecar format 必须为 fanjin-release-artifact/v1。");
  }
  const artifactSha256 = String(sidecar.artifactSha256 || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(artifactSha256)) throw new Error("sidecar 缺少有效的 artifactSha256。");
  const artifactBytes = Number(sidecar.artifactBytes);
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes <= 0) {
    throw new Error("sidecar artifactBytes 必须是正整数。");
  }
  if (archiveByteSize !== undefined && artifactBytes !== archiveByteSize) {
    throw new Error("sidecar 记录的大小与所选制品文件不一致。");
  }
  const manifest = parseManifestText(JSON.stringify(sidecar.manifest), expectedReleaseId);
  return {
    format: "fanjin-release-artifact/v1",
    artifactSha256,
    artifactBytes,
    manifest,
  };
}

export function createIdempotencyKey(prefix: string) {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

export function releaseArtifactDisplayIdentity(
  artifact: Pick<ReleaseArtifactRecord, "id" | "fileName">,
): { name: string; id: string } {
  return {
    name: artifact.fileName?.trim() || "发布制品",
    id: artifact.id,
  };
}
