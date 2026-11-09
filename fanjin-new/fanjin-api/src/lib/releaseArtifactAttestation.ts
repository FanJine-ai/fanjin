import crypto, { type KeyObject } from "node:crypto";

export const RELEASE_ARTIFACT_ATTESTATION_FORMAT = "fanjin-release-attestation/v1" as const;
export const RELEASE_ARTIFACT_ATTESTATION_CANONICALIZATION = "fanjin-json-c14n/v1" as const;
export const RELEASE_ARTIFACT_ATTESTATION_ALGORITHM = "Ed25519" as const;
export const RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV =
  "FANJIN_RELEASE_ATTESTATION_TRUSTED_PUBLIC_KEYS_JSON" as const;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const MAX_TRUSTED_KEYS = 32;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 64;
// A production-pruned dependency tree can legitimately contain tens of
// thousands of files. Keep this aligned with the CI packager while retaining
// a hard bound against pathological manifests.
const MAX_CANONICAL_JSON_NODES_AND_KEYS = 1_000_000;

export class ReleaseArtifactAttestationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ReleaseArtifactAttestationError";
    this.code = code;
  }
}

export interface ReleaseArtifactAttestationV1 {
  format: typeof RELEASE_ARTIFACT_ATTESTATION_FORMAT;
  canonicalization: typeof RELEASE_ARTIFACT_ATTESTATION_CANONICALIZATION;
  algorithm: typeof RELEASE_ARTIFACT_ATTESTATION_ALGORITHM;
  keyId: string;
  signature: string;
}

export interface VerifiedReleaseArtifactAttestation {
  keyId: string;
  payloadSha256: string;
}

function invalidManifest(message: string): never {
  throw new ReleaseArtifactAttestationError(
    message,
    "RELEASE_ARTIFACT_ATTESTATION_MANIFEST_INVALID",
  );
}

interface CanonicalizationState {
  seen: Set<object>;
  nodesAndKeys: number;
}

function accountCanonicalNodes(state: CanonicalizationState, count = 1): void {
  state.nodesAndKeys += count;
  if (state.nodesAndKeys > MAX_CANONICAL_JSON_NODES_AND_KEYS) {
    invalidManifest("制品清单结构超过安全复杂度上限");
  }
}

function canonicalizeJsonValue(
  value: unknown,
  state: CanonicalizationState,
  depth: number,
): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) invalidManifest("制品清单嵌套超过安全深度上限");
  accountCanonicalNodes(state);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) invalidManifest("制品清单包含非有限数字");
      return JSON.stringify(value);
    case "object": {
      if (state.seen.has(value)) invalidManifest("制品清单包含循环引用");
      state.seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((entry) => canonicalizeJsonValue(entry, state, depth + 1)).join(",")}]`;
        }
        const object = value as Record<string, unknown>;
        const keys = Object.keys(object).sort();
        accountCanonicalNodes(state, keys.length);
        return `{${keys
          .map((key) => {
            if (object[key] === undefined) invalidManifest("制品清单包含 undefined 字段");
            return `${JSON.stringify(key)}:${canonicalizeJsonValue(object[key], state, depth + 1)}`;
          })
          .join(",")}}`;
      } finally {
        state.seen.delete(value);
      }
    }
    default:
      return invalidManifest("制品清单包含不支持的 JSON 值");
  }
}

function assertSignedFileInventory(manifest: Record<string, unknown>): void {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    invalidManifest("制品清单必须包含逐文件 SHA-256 清单");
  }
  const seenPaths = new Set<string>();
  for (const [index, value] of manifest.files.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalidManifest(`制品清单 files[${index}] 格式无效`);
    }
    const entry = value as Record<string, unknown>;
    const filePath = typeof entry.path === "string" ? entry.path : "";
    const segments = filePath.split("/");
    if (!filePath || filePath.startsWith("/") || filePath.includes("\\") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")) {
      invalidManifest(`制品清单 files[${index}].path 格式无效`);
    }
    if (seenPaths.has(filePath)) invalidManifest(`制品清单包含重复文件路径: ${filePath}`);
    seenPaths.add(filePath);
    if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      invalidManifest(`制品清单 files[${index}].size 格式无效`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      invalidManifest(`制品清单 files[${index}].sha256 格式无效`);
    }
  }
}

/**
 * Canonical payload signed by CI. Only the top-level attestation envelope is
 * excluded; every other manifest field, including the complete ordered file
 * inventory and each file digest, is authenticated.
 */
export function canonicalizeReleaseArtifactManifest(manifest: unknown): Buffer {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    invalidManifest("制品清单必须是 JSON object");
  }
  const object = manifest as Record<string, unknown>;
  assertSignedFileInventory(object);
  const payload = Object.fromEntries(
    Object.entries(object).filter(([key]) => key !== "attestation"),
  );
  return Buffer.from(canonicalizeJsonValue(payload, {
    seen: new Set(),
    nodesAndKeys: 0,
  }, 0), "utf8");
}

function parseAttestation(manifest: Record<string, unknown>): ReleaseArtifactAttestationV1 {
  const value = manifest.attestation;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseArtifactAttestationError(
      "制品缺少 CI 签名证明",
      "RELEASE_ARTIFACT_ATTESTATION_MISSING",
    );
  }
  const object = value as Record<string, unknown>;
  const expectedKeys = ["algorithm", "canonicalization", "format", "keyId", "signature"];
  if (Object.keys(object).sort().join("\0") !== expectedKeys.join("\0") ||
    object.format !== RELEASE_ARTIFACT_ATTESTATION_FORMAT ||
    object.canonicalization !== RELEASE_ARTIFACT_ATTESTATION_CANONICALIZATION ||
    object.algorithm !== RELEASE_ARTIFACT_ATTESTATION_ALGORITHM ||
    typeof object.keyId !== "string" || !KEY_ID_PATTERN.test(object.keyId) ||
    typeof object.signature !== "string" ||
    !BASE64_ED25519_SIGNATURE_PATTERN.test(object.signature)) {
    throw new ReleaseArtifactAttestationError(
      "制品 CI 签名证明格式无效",
      "RELEASE_ARTIFACT_ATTESTATION_INVALID",
    );
  }
  const signature = Buffer.from(object.signature, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== object.signature) {
    throw new ReleaseArtifactAttestationError(
      "制品 CI 签名编码无效",
      "RELEASE_ARTIFACT_ATTESTATION_INVALID",
    );
  }
  return object as unknown as ReleaseArtifactAttestationV1;
}

function parseReleaseArtifactTrustedPublicKeysInternal(
  parsed: unknown,
): Readonly<{
  values: Readonly<Record<string, string>>;
  keys: Map<string, KeyObject>;
}> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReleaseArtifactAttestationError(
      "发布制品受信公钥配置格式无效",
      "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_INVALID",
    );
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_TRUSTED_KEYS) {
    throw new ReleaseArtifactAttestationError(
      "发布制品受信公钥数量无效",
      "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_INVALID",
    );
  }
  const trusted = new Map<string, KeyObject>();
  const values: Record<string, string> = {};
  for (const [keyId, value] of entries) {
    if (!KEY_ID_PATTERN.test(keyId) || typeof value !== "string" || !value.trim() ||
      Buffer.byteLength(value, "utf8") > MAX_PUBLIC_KEY_BYTES || /PRIVATE KEY/.test(value)) {
      throw new ReleaseArtifactAttestationError(
        "发布制品受信公钥配置包含无效条目",
        "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_INVALID",
      );
    }
    let key: KeyObject;
    try {
      key = crypto.createPublicKey(value);
    } catch {
      throw new ReleaseArtifactAttestationError(
        "发布制品受信公钥无法解析",
        "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_INVALID",
      );
    }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new ReleaseArtifactAttestationError(
        "发布制品受信公钥必须是 Ed25519 公钥",
        "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_INVALID",
      );
    }
    trusted.set(keyId, key);
    values[keyId] = value;
  }
  return Object.freeze({
    values: Object.freeze(values),
    keys: trusted,
  });
}

/** Strict public parser used by the root-owned formal runtime trust relay. */
export function parseReleaseArtifactTrustedPublicKeys(
  value: unknown,
): Readonly<Record<string, string>> {
  return parseReleaseArtifactTrustedPublicKeysInternal(value).values;
}

function resolveTrustedReleaseArtifactKeys(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Map<string, KeyObject> {
  const raw = String(environment[RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV] || "").trim();
  if (!raw) {
    throw new ReleaseArtifactAttestationError(
      "服务器未配置发布制品受信公钥，已拒绝校验",
      "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_MISSING",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReleaseArtifactAttestationError(
      "发布制品受信公钥配置不是有效 JSON",
      "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_INVALID",
    );
  }
  return parseReleaseArtifactTrustedPublicKeysInternal(parsed).keys;
}

/** Offline verification only: no key discovery URL or network fallback exists. */
export function verifyReleaseArtifactAttestation(
  manifest: unknown,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): VerifiedReleaseArtifactAttestation {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    invalidManifest("制品清单必须是 JSON object");
  }
  const object = manifest as Record<string, unknown>;
  const attestation = parseAttestation(object);
  const trusted = resolveTrustedReleaseArtifactKeys(environment);
  const publicKey = trusted.get(attestation.keyId);
  if (!publicKey) {
    throw new ReleaseArtifactAttestationError(
      "制品使用了未受信任的 CI 签名密钥",
      "RELEASE_ARTIFACT_ATTESTATION_KEY_UNTRUSTED",
    );
  }
  const payload = canonicalizeReleaseArtifactManifest(object);
  const signature = Buffer.from(attestation.signature, "base64");
  if (!crypto.verify(null, payload, publicKey, signature)) {
    throw new ReleaseArtifactAttestationError(
      "制品 CI 签名校验失败",
      "RELEASE_ARTIFACT_ATTESTATION_SIGNATURE_INVALID",
    );
  }
  return {
    keyId: attestation.keyId,
    payloadSha256: crypto.createHash("sha256").update(payload).digest("hex"),
  };
}
