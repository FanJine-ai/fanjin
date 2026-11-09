import {
  RELEASE_CONTAINER_DEPLOYMENT_FORMAT,
  RELEASE_CONTAINER_DEPLOYMENT_MODE,
  RELEASE_ARTIFACT_FORMAT,
  RELEASE_ARTIFACT_MANIFEST_VERSION,
} from "@/lib/releaseArtifactManifestContract";
import { ReleaseDeploymentError } from "@/lib/releaseDeploymentError";
import {
  parseReleaseSchemaCompatibility,
  ReleaseSchemaCompatibilityError,
  type ReleaseSchemaCompatibilityV1,
} from "@/lib/releaseSchemaCompatibility";

const RELEASE_RUNTIME_CAPABILITY_PATTERN =
  /^(?=.{1,64}$)[a-z][a-z0-9-]*(?:[._][a-z0-9][a-z0-9-]*)*$/;
const MAX_RELEASE_RUNTIME_CAPABILITIES = 64;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const OCI_SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OCI_REPOSITORY_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._\/-][a-z0-9]+)*$/;
const CONTAINER_SIGNATURE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ReleaseContainerDeploymentV1 {
  format: typeof RELEASE_CONTAINER_DEPLOYMENT_FORMAT;
  mode: typeof RELEASE_CONTAINER_DEPLOYMENT_MODE;
  image: string;
  imageDigest: string;
  platform: {
    os: "linux";
    architecture: "amd64";
  };
  signature: {
    type: "cosign";
    keyId: string;
  };
}

export interface ReleaseArtifactManifestTarget {
  key: string;
  label: string;
  role: "api" | "worker";
  serverId?: string;
  zone?: string;
  wave: number;
}

export interface ReleaseArtifactManifestV1 extends Record<string, unknown> {
  manifestVersion: typeof RELEASE_ARTIFACT_MANIFEST_VERSION;
  format: typeof RELEASE_ARTIFACT_FORMAT;
  releaseId: string;
  sourceCommit: string;
  schemaVersion: number;
  schemaMode: "schema-neutral";
  schemaCompatibility?: ReleaseSchemaCompatibilityV1;
  /** Queue/task payload compatibility generation shared by API and Worker. */
  workerProtocolVersion: number;
  /** Signed runtime features implemented by this immutable artifact. */
  runtimeCapabilities: readonly string[];
  web: { assetStrategy: "shared-union-v1" };
  /** Absent on historical archive/systemd artifacts. */
  deployment?: ReleaseContainerDeploymentV1;
}

/**
 * The attestation verifier needs only immutable artifact identity. Keeping
 * this structural type here prevents its offline migration path from importing
 * the database-backed release repository even as a convenience dependency.
 */
export interface ReleaseArtifactAttestationRecord {
  id: string;
  releaseId: string;
  byteSize: number | null;
  sha256: string;
  sourceCommit: string | null;
  format: string | null;
  manifest: ReleaseArtifactManifestV1;
  status: "registered" | "ready" | "rejected";
}

function nonEmptyText(value: unknown, label: string, maximum: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new ReleaseDeploymentError(
      `${label} 格式无效`,
      400,
      "RELEASE_DEPLOYMENT_INPUT_INVALID",
    );
  }
  return normalized;
}

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseDeploymentError(
      `${label} 必须是 JSON object`,
      400,
      "RELEASE_MANIFEST_DEPLOYMENT_INVALID",
    );
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new ReleaseDeploymentError(
      `${label} 包含未知键或缺失必需键`,
      400,
      "RELEASE_MANIFEST_DEPLOYMENT_UNKNOWN_FIELD",
    );
  }
  return object;
}

/**
 * Parse the optional, signed container deployment identity. This deliberately
 * accepts no extension fields: a future format must use a new format value and
 * parser instead of silently changing production execution semantics.
 */
export function parseReleaseContainerDeployment(
  value: unknown,
): ReleaseContainerDeploymentV1 {
  const deployment = exactObject(
    value,
    "manifest.deployment",
    ["format", "mode", "image", "imageDigest", "platform", "signature"],
  );
  const platform = exactObject(
    deployment.platform,
    "manifest.deployment.platform",
    ["os", "architecture"],
  );
  const signature = exactObject(
    deployment.signature,
    "manifest.deployment.signature",
    ["type", "keyId"],
  );
  const image = typeof deployment.image === "string" ? deployment.image : "";
  const imageDigest = typeof deployment.imageDigest === "string"
    ? deployment.imageDigest
    : "";
  const digestSeparator = image.lastIndexOf("@sha256:");
  const repository = digestSeparator > 0 ? image.slice(0, digestSeparator) : "";
  if (
    deployment.format !== RELEASE_CONTAINER_DEPLOYMENT_FORMAT
    || deployment.mode !== RELEASE_CONTAINER_DEPLOYMENT_MODE
    || image.length > 512
    || !OCI_SHA256_DIGEST_PATTERN.test(imageDigest)
    || !OCI_REPOSITORY_PATTERN.test(repository)
    || image !== `${repository}@${imageDigest}`
    || platform.os !== "linux"
    || platform.architecture !== "amd64"
    || signature.type !== "cosign"
    || typeof signature.keyId !== "string"
    || !CONTAINER_SIGNATURE_KEY_ID_PATTERN.test(signature.keyId)
  ) {
    throw new ReleaseDeploymentError(
      "manifest.deployment 必须是 linux/amd64、cosign 签名且仅由 sha256 digest 定位的镜像",
      400,
      "RELEASE_MANIFEST_DEPLOYMENT_INVALID",
    );
  }
  return {
    format: RELEASE_CONTAINER_DEPLOYMENT_FORMAT,
    mode: RELEASE_CONTAINER_DEPLOYMENT_MODE,
    image,
    imageDigest,
    platform: { os: "linux", architecture: "amd64" },
    signature: { type: "cosign", keyId: signature.keyId },
  };
}

export function parseReleaseArtifactManifest(
  value: unknown,
  expectedReleaseId?: string,
): ReleaseArtifactManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseDeploymentError(
      "manifest 必须是 JSON object",
      400,
      "RELEASE_MANIFEST_INVALID",
    );
  }
  const object = value as Record<string, unknown>;
  if (object.manifestVersion !== RELEASE_ARTIFACT_MANIFEST_VERSION) {
    throw new ReleaseDeploymentError(
      "manifest.manifestVersion 必须为 1",
      400,
      "RELEASE_MANIFEST_VERSION_UNSUPPORTED",
    );
  }
  if (object.format !== RELEASE_ARTIFACT_FORMAT) {
    throw new ReleaseDeploymentError(
      `manifest.format 必须为 ${RELEASE_ARTIFACT_FORMAT}`,
      400,
      "RELEASE_MANIFEST_FORMAT_UNSUPPORTED",
    );
  }
  if (object.schemaMode !== "schema-neutral") {
    throw new ReleaseDeploymentError(
      "v0.0.7 已退役 migration-mode；manifest.schemaMode 必须为 schema-neutral",
      400,
      "RELEASE_MIGRATION_MODE_RETIRED_V007",
    );
  }
  const releaseId = nonEmptyText(object.releaseId, "manifest.releaseId", 128);
  if (expectedReleaseId && releaseId !== expectedReleaseId) {
    throw new ReleaseDeploymentError(
      "manifest.releaseId 与版本不匹配",
      409,
      "RELEASE_MANIFEST_RELEASE_MISMATCH",
    );
  }
  const sourceCommit = String(object.sourceCommit || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceCommit)) {
    throw new ReleaseDeploymentError(
      "manifest.sourceCommit 必须是 40 或 64 位小写 Git 摘要",
      400,
      "RELEASE_MANIFEST_SOURCE_COMMIT_INVALID",
    );
  }
  if (typeof object.schemaVersion !== "number") {
    throw new ReleaseDeploymentError(
      "manifest.schemaVersion 必须是 JSON integer，禁止字符串或隐式转换",
      400,
      "RELEASE_MANIFEST_SCHEMA_VERSION_INVALID",
    );
  }
  const schemaVersion = object.schemaVersion;
  if (
    !Number.isSafeInteger(schemaVersion)
    || schemaVersion < 1
    || schemaVersion > 2_147_483_647
  ) {
    throw new ReleaseDeploymentError(
      "manifest.schemaVersion 必须是非负数据库兼容代际",
      400,
      "RELEASE_MANIFEST_SCHEMA_VERSION_INVALID",
    );
  }
  let schemaCompatibility: ReleaseSchemaCompatibilityV1;
  try {
    schemaCompatibility = parseReleaseSchemaCompatibility(
      object.schemaCompatibility,
      schemaVersion,
    );
  } catch (error) {
    if (error instanceof ReleaseSchemaCompatibilityError) {
      throw new ReleaseDeploymentError(error.message, 400, error.code);
    }
    throw error;
  }
  if (
    typeof object.workerProtocolVersion !== "number"
    || !Number.isSafeInteger(object.workerProtocolVersion)
    || object.workerProtocolVersion < 1
    || object.workerProtocolVersion > 2_147_483_647
  ) {
    throw new ReleaseDeploymentError(
      "manifest.workerProtocolVersion 必须是正整数兼容代际",
      400,
      "RELEASE_MANIFEST_WORKER_PROTOCOL_VERSION_INVALID",
    );
  }
  const workerProtocolVersion = object.workerProtocolVersion;
  // Manifests produced before runtime capability attestation existed are
  // normalized to an empty set. They remain readable as rollback baselines,
  // but cannot satisfy a capability-gated cutover.
  const rawRuntimeCapabilities = Object.prototype.hasOwnProperty.call(
    object,
    "runtimeCapabilities",
  )
    ? object.runtimeCapabilities
    : [];
  if (
    !Array.isArray(rawRuntimeCapabilities)
    || rawRuntimeCapabilities.length > MAX_RELEASE_RUNTIME_CAPABILITIES
  ) {
    throw new ReleaseDeploymentError(
      "manifest.runtimeCapabilities 必须是有界数组",
      400,
      "RELEASE_MANIFEST_RUNTIME_CAPABILITIES_INVALID",
    );
  }
  const runtimeCapabilities: string[] = [];
  for (const capability of rawRuntimeCapabilities) {
    if (
      typeof capability !== "string"
      || !RELEASE_RUNTIME_CAPABILITY_PATTERN.test(capability)
    ) {
      throw new ReleaseDeploymentError(
        "manifest.runtimeCapabilities 包含无效能力名称",
        400,
        "RELEASE_MANIFEST_RUNTIME_CAPABILITIES_INVALID",
      );
    }
    runtimeCapabilities.push(capability);
  }
  if (new Set(runtimeCapabilities).size !== runtimeCapabilities.length) {
    throw new ReleaseDeploymentError(
      "manifest.runtimeCapabilities 不能包含重复项",
      400,
      "RELEASE_MANIFEST_RUNTIME_CAPABILITIES_INVALID",
    );
  }
  runtimeCapabilities.sort();
  const web = object.web && typeof object.web === "object" && !Array.isArray(object.web)
    ? object.web as Record<string, unknown>
    : {};
  if (web.assetStrategy !== "shared-union-v1") {
    throw new ReleaseDeploymentError(
      "manifest.web.assetStrategy 必须为 shared-union-v1",
      400,
      "RELEASE_MANIFEST_WEB_STRATEGY_INVALID",
    );
  }
  const deployment = Object.prototype.hasOwnProperty.call(object, "deployment")
    ? parseReleaseContainerDeployment(object.deployment)
    : undefined;

  let cloned: Record<string, unknown>;
  try {
    const serialized = JSON.stringify({
      manifestVersion: 1,
      format: RELEASE_ARTIFACT_FORMAT,
      releaseId,
      sourceCommit,
      schemaVersion,
      schemaMode: "schema-neutral",
      ...(Object.prototype.hasOwnProperty.call(object, "schemaCompatibility")
        ? { schemaCompatibility }
        : {}),
      workerProtocolVersion,
      runtimeCapabilities,
      web: { assetStrategy: "shared-union-v1" },
      ...(deployment ? { deployment } : {}),
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) {
      throw new ReleaseDeploymentError(
        "manifest 体积过大",
        400,
        "RELEASE_MANIFEST_TOO_LARGE",
      );
    }
    cloned = JSON.parse(serialized) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) throw error;
    throw new ReleaseDeploymentError(
      "manifest 不是可序列化 JSON",
      400,
      "RELEASE_MANIFEST_INVALID",
    );
  }
  return cloned as ReleaseArtifactManifestV1;
}
