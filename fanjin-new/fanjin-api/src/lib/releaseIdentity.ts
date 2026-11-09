import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { verifyReleaseArtifactAttestation } from "@/lib/releaseArtifactAttestation";

import {
  exactReleaseSchemaCompatibility,
  releaseSchemaCompatibilityError,
  releaseSchemaCompatibilityProofSha256,
} from "@/release-controller/schemaCompatibility";
import type {
  ReleaseSchemaCompatibility,
  ReleaseSchemaMode,
} from "@/release-controller/types";

export interface ReleaseIdentity {
  releaseId: string | null;
  sourceCommit: string | null;
  artifactSha256: string | null;
  /** Schema declared by the immutable artifact manifest. */
  schemaVersion: number | null;
  schemaMode: ReleaseSchemaMode | null;
  schemaCompatibility: ReleaseSchemaCompatibility | null;
  schemaCompatibilityProofSha256: string | null;
}

export interface StrictActivatedReleaseIdentity {
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  schemaVersion: number;
  manifestPath: string;
  metadataPath: string;
  attestationKeyId: string;
  attestationPayloadSha256: string;
}

export interface StrictActivatedReleaseIdentityOptions {
  productionBase?: string;
  trustedOwnerUids?: readonly number[];
}

type EnvironmentLike = Record<string, string | undefined>;

const EMPTY_IDENTITY: ReleaseIdentity = {
  releaseId: null,
  sourceCommit: null,
  artifactSha256: null,
  schemaVersion: null,
  schemaMode: null,
  schemaCompatibility: null,
  schemaCompatibilityProofSha256: null,
};

let cachedIdentity: ReleaseIdentity | null = null;

function safeIdentifier(value: unknown, maximum = 160): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || !/^[A-Za-z0-9._:+-]+$/.test(normalized)) return null;
  return normalized;
}

function safeCommit(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,64}$/.test(normalized) ? normalized : null;
}

function safeSha256(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function safeSchemaVersion(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function schemaContractFrom(
  value: Record<string, unknown>,
  schemaVersion: number | null,
): {
  schemaMode: ReleaseSchemaMode | null;
  schemaCompatibility: ReleaseSchemaCompatibility | null;
  schemaCompatibilityProofSha256: string | null;
} {
  const schemaMode = value.schemaMode;
  if (
    schemaVersion === null
    || (schemaMode !== "schema-neutral" && schemaMode !== "migration")
  ) {
    return {
      schemaMode: null,
      schemaCompatibility: null,
      schemaCompatibilityProofSha256: null,
    };
  }
  const compatibility = value.schemaCompatibility;
  if (releaseSchemaCompatibilityError(schemaMode, schemaVersion, compatibility)) {
    return {
      schemaMode,
      schemaCompatibility: null,
      schemaCompatibilityProofSha256: null,
    };
  }
  const normalized = compatibility as ReleaseSchemaCompatibility;
  return {
    schemaMode,
    schemaCompatibility: normalized,
    schemaCompatibilityProofSha256:
      releaseSchemaCompatibilityProofSha256(normalized),
  };
}

function identityFrom(value: Record<string, unknown>): ReleaseIdentity {
  const schemaVersion = safeSchemaVersion(value.schemaVersion);
  return {
    releaseId: safeIdentifier(value.releaseId ?? value.version),
    sourceCommit: safeCommit(value.sourceCommit ?? value.gitCommit ?? value.commit),
    artifactSha256: safeSha256(value.artifactSha256 ?? value.artifactDigest ?? value.sha256),
    schemaVersion,
    ...schemaContractFrom(value, schemaVersion),
  };
}

function configuredManifestPath(env: EnvironmentLike): string | null {
  const configured = String(env.FANJIN_RELEASE_MANIFEST_FILE || "").trim();
  if (configured) return path.resolve(configured);
  const appRoot = String(env.FANJIN_APP_ROOT || "").trim();
  // Derive the manifest from this process's immutable release root. Reading
  // /opt/fanjin/current here is unsafe because activation moves that symlink
  // before the old PM2 process has necessarily stopped serving requests.
  return appRoot ? path.resolve(appRoot, "..", "release-manifest.json") : null;
}

function releaseMetadataArtifactSha256(
  env: EnvironmentLike,
  manifest: ReleaseIdentity,
): string | null {
  const configured = String(env.FANJIN_RELEASE_META_FILE || "").trim();
  if (!configured || !manifest.releaseId || manifest.schemaVersion === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(configured), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const metadata = parsed as Record<string, unknown>;
    if (metadata.format !== "fanjin-release-meta/v1") return null;
    const identity = identityFrom(metadata);
    if (
      !identity.artifactSha256
      || identity.releaseId !== manifest.releaseId
      || identity.sourceCommit !== manifest.sourceCommit
      || identity.schemaVersion !== manifest.schemaVersion
      || identity.schemaMode !== manifest.schemaMode
      || identity.schemaCompatibilityProofSha256
        !== manifest.schemaCompatibilityProofSha256
    ) {
      return null;
    }
    return identity.artifactSha256;
  } catch {
    return null;
  }
}

function readManifest(env: EnvironmentLike): ReleaseIdentity {
  const manifestPath = configuredManifestPath(env);
  if (!manifestPath) return EMPTY_IDENTITY;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_IDENTITY;
    const identity = identityFrom(parsed as Record<string, unknown>);
    if (identity.artifactSha256) return identity;
    return {
      ...identity,
      artifactSha256: releaseMetadataArtifactSha256(env, identity),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") console.warn("[release-identity] manifest unavailable or invalid");
    return EMPTY_IDENTITY;
  }
}

function environmentIdentity(env: EnvironmentLike): ReleaseIdentity {
  const identity = identityFrom({
    releaseId: env.FANJIN_RELEASE_ID,
    sourceCommit: env.FANJIN_SOURCE_COMMIT,
    artifactSha256: env.FANJIN_ARTIFACT_SHA256,
    schemaVersion: env.FANJIN_RELEASE_SCHEMA_VERSION,
  });
  if (identity.schemaVersion === null) return identity;
  const compatibility = exactReleaseSchemaCompatibility(identity.schemaVersion);
  return {
    ...identity,
    schemaMode: "schema-neutral",
    schemaCompatibility: compatibility,
    schemaCompatibilityProofSha256:
      releaseSchemaCompatibilityProofSha256(compatibility),
  };
}

function prefer(primary: ReleaseIdentity, fallback: ReleaseIdentity): ReleaseIdentity {
  // A release manifest is the immutable, staged source of schema semantics.
  // Never fill an invalid/missing manifest compatibility contract from mutable
  // environment variables; that would let a Worker forge bridge admission.
  if (primary.releaseId || primary.artifactSha256 || primary.schemaVersion !== null) {
    return primary;
  }
  return {
    releaseId: primary.releaseId ?? fallback.releaseId,
    sourceCommit: primary.sourceCommit ?? fallback.sourceCommit,
    artifactSha256: primary.artifactSha256 ?? fallback.artifactSha256,
    schemaVersion: primary.schemaVersion ?? fallback.schemaVersion,
    schemaMode: primary.schemaMode ?? fallback.schemaMode,
    schemaCompatibility:
      primary.schemaCompatibility ?? fallback.schemaCompatibility,
    schemaCompatibilityProofSha256:
      primary.schemaCompatibilityProofSha256
      ?? fallback.schemaCompatibilityProofSha256,
  };
}

/** Immutable identity of the release behind the atomic `current` symlink. */
export function getReleaseIdentity(env: EnvironmentLike = process.env): ReleaseIdentity {
  if (env === process.env && cachedIdentity) return cachedIdentity;
  const identity = prefer(readManifest(env), environmentIdentity(env));
  if (env === process.env) cachedIdentity = identity;
  return identity;
}

/** Test-only cache reset; production callers should treat identity as immutable. */
export function resetReleaseIdentityCache(): void {
  cachedIdentity = null;
}

const STRICT_RELEASE_FILE_MAX_BYTES = 16 * 1024 * 1024;

function strictReleaseFailure(message: string): never {
  throw new Error(`strict activated release identity: ${message}`);
}

function assertTrustedReleaseDirectoryChain(
  productionBase: string,
  filePath: string,
  trustedOwnerUids: ReadonlySet<number>,
): void {
  const baseMetadata = fs.lstatSync(productionBase);
  if (
    baseMetadata.isSymbolicLink()
    || !baseMetadata.isDirectory()
    || !trustedOwnerUids.has(baseMetadata.uid)
    || (baseMetadata.mode & 0o022) !== 0
  ) {
    strictReleaseFailure("production base is not an owner-controlled real directory");
  }
  const relative = path.relative(productionBase, path.dirname(filePath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    strictReleaseFailure("identity file is outside the production base");
  }
  let current = productionBase;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      strictReleaseFailure(`untrusted directory component: ${current}`);
    }
    if (!trustedOwnerUids.has(metadata.uid) || (metadata.mode & 0o022) !== 0) {
      strictReleaseFailure(`directory is not owner-controlled: ${current}`);
    }
  }
}

function readStrictReleaseJson(
  configuredPath: string,
  label: string,
  productionBase: string,
  trustedOwnerUids: ReadonlySet<number>,
): { path: string; value: Record<string, unknown>; sha256: string } {
  if (!configuredPath || !path.isAbsolute(configuredPath)) {
    strictReleaseFailure(`${label} path must be absolute`);
  }
  const resolved = path.normalize(configuredPath);
  assertTrustedReleaseDirectoryChain(productionBase, resolved, trustedOwnerUids);
  let descriptor: number;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return strictReleaseFailure(`${label} must be an available non-symlink file`);
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile()
      || before.size < 2
      || before.size > STRICT_RELEASE_FILE_MAX_BYTES
      || !trustedOwnerUids.has(before.uid)
      || (before.mode & 0o333) !== 0
    ) {
      strictReleaseFailure(`${label} must be a bounded owner-controlled read-only regular file`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size
    ) {
      strictReleaseFailure(`${label} changed while being read`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      return strictReleaseFailure(`${label} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      strictReleaseFailure(`${label} must contain a JSON object`);
    }
    return {
      path: resolved,
      value: parsed as Record<string, unknown>,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameReleaseField(
  manifest: Record<string, unknown>,
  metadata: Record<string, unknown>,
  field: string,
): boolean {
  return JSON.stringify(manifest[field] ?? null) === JSON.stringify(metadata[field] ?? null);
}

function verifyModularRuntimeProof(input: {
  environment: EnvironmentLike;
  productionBase: string;
  trustedOwnerUids: ReadonlySet<number>;
  manifestFile: ReturnType<typeof readStrictReleaseJson>;
  metadataFile: ReturnType<typeof readStrictReleaseJson>;
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  schemaVersion: number;
}): { keyId: string; payloadSha256: string } {
  const configured = String(input.environment.FANJIN_MODULAR_RUNTIME_PROOF_FILE || "").trim();
  const expectedPath = path.join(input.productionBase, "release", "modular-runtime-proof.json");
  if (path.normalize(configured) !== expectedPath) {
    strictReleaseFailure("unsigned container manifest lacks the fixed modular runtime proof mount");
  }
  const proofFile = readStrictReleaseJson(expectedPath, "modular runtime proof",
    input.productionBase, input.trustedOwnerUids);
  const proof = proofFile.value;
  const expectedKeys = [
    "schema", "unitId", "targetId", "unitVersion", "artifactDigest", "contractVersion",
    "sourceCommit", "schemaVersion", "locator", "signatureRef", "sbomRef", "provenanceRef",
    "publicKeySha256", "verifiedEvidence", "verifiedAt", "stagedIdentity", "stagedAt",
    "manifestSha256", "metadataSha256",
  ].sort();
  const deployment = input.manifestFile.value.deployment && typeof input.manifestFile.value.deployment === "object"
    && !Array.isArray(input.manifestFile.value.deployment)
    ? input.manifestFile.value.deployment as Record<string, unknown>
    : null;
  const platform = deployment?.platform && typeof deployment.platform === "object" && !Array.isArray(deployment.platform)
    ? deployment.platform as Record<string, unknown> : null;
  const signature = deployment?.signature && typeof deployment.signature === "object" && !Array.isArray(deployment.signature)
    ? deployment.signature as Record<string, unknown> : null;
  const publicKeySha256 = String(proof.publicKeySha256 ?? "");
  const locator = String(proof.locator ?? "");
  if (Object.keys(proof).sort().join("\0") !== expectedKeys.join("\0")
    || proof.schema !== "fanjin-modular-runtime-proof/v1"
    || !["api", "worker"].includes(String(proof.unitId ?? ""))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(String(proof.targetId ?? ""))
    || proof.unitVersion !== input.releaseId
    || proof.artifactDigest !== `sha256:${input.artifactSha256}`
    || typeof proof.contractVersion !== "string" || !proof.contractVersion || String(proof.contractVersion).length > 160
    || proof.sourceCommit !== input.sourceCommit
    || proof.schemaVersion !== input.schemaVersion
    || !/^[a-f0-9]{64}$/u.test(publicKeySha256)
    || !Array.isArray(proof.verifiedEvidence)
    || JSON.stringify(proof.verifiedEvidence) !== JSON.stringify(["image-signature", "spdxjson", "slsaprovenance"])
    || typeof proof.verifiedAt !== "string" || !Number.isFinite(Date.parse(proof.verifiedAt))
    || typeof proof.stagedAt !== "string" || !Number.isFinite(Date.parse(proof.stagedAt))
    || typeof proof.stagedIdentity !== "string" || !String(proof.stagedIdentity).startsWith("target:")
    || proof.manifestSha256 !== input.manifestFile.sha256
    || proof.metadataSha256 !== input.metadataFile.sha256
    || input.metadataFile.value.unitId !== proof.unitId
    || input.metadataFile.value.contractVersion !== proof.contractVersion
    || deployment?.format !== "fanjin-container-deployment/v1"
    || deployment.mode !== "container-image"
    || deployment.image !== locator
    || deployment.imageDigest !== `sha256:${input.artifactSha256}`
    || platform?.os !== "linux" || platform.architecture !== "amd64"
    || signature?.type !== "cosign" || signature.keyId !== `sha256:${publicKeySha256}`
    || proof.signatureRef !== `cosign://${locator}`
    || proof.sbomRef !== `cosign://${locator}?type=spdxjson`
    || proof.provenanceRef !== `cosign://${locator}?type=slsaprovenance`) {
    strictReleaseFailure("modular runtime proof is not exactly bound to the verified OCI runtime");
  }
  return { keyId: `cosign:${publicKeySha256}`, payloadSha256: proofFile.sha256 };
}

/**
 * Strict one-shot operator identity. Unlike getReleaseIdentity(), this never
 * falls back to mutable release environment values: it requires the active
 * read-only manifest, verifies its CI signature offline, and cross-binds the
 * root-owned deployment metadata that carries the archive digest.
 */
export function getStrictActivatedReleaseIdentity(
  environment: EnvironmentLike = process.env,
  options: StrictActivatedReleaseIdentityOptions = {},
): StrictActivatedReleaseIdentity {
  const productionBase = path.resolve(options.productionBase || "/opt/fanjin");
  const trustedOwnerUids = new Set(options.trustedOwnerUids || [0]);
  const configuredManifest = String(environment.FANJIN_RELEASE_MANIFEST_FILE || "").trim();
  const configuredMetadata = String(environment.FANJIN_RELEASE_META_FILE || "").trim();
  const containerManifest = path.join(productionBase, "release", "release-manifest.json");
  const containerMetadata = path.join(productionBase, "release", "release-meta.json");
  const containerMode = path.normalize(configuredManifest) === containerManifest;

  let expectedManifest: string;
  if (containerMode) {
    expectedManifest = containerManifest;
    if (path.normalize(configuredMetadata) !== containerMetadata) {
      strictReleaseFailure("container release metadata path is not the fixed read-only mount");
    }
  } else {
    const currentPointer = path.join(productionBase, "current");
    const pointer = fs.lstatSync(currentPointer);
    if (!pointer.isSymbolicLink()) strictReleaseFailure("current release pointer is not a symlink");
    const currentReleaseRoot = fs.realpathSync(currentPointer);
    const releasesRoot = fs.realpathSync(path.join(productionBase, "releases"));
    if (path.dirname(currentReleaseRoot) !== releasesRoot) {
      strictReleaseFailure("current release pointer escapes the releases directory");
    }
    expectedManifest = path.join(currentReleaseRoot, "release-manifest.json");
    if (path.normalize(configuredManifest) !== expectedManifest) {
      strictReleaseFailure("manifest path does not identify the currently activated release");
    }
  }

  const manifestFile = readStrictReleaseJson(
    expectedManifest,
    "release manifest",
    productionBase,
    trustedOwnerUids,
  );
  const manifest = manifestFile.value;
  if (manifest.format !== "fanjin-release/v1" || manifest.manifestVersion !== 1) {
    strictReleaseFailure("release manifest format is invalid");
  }
  const ciAttestation = manifest.attestation == null
    ? null
    : verifyReleaseArtifactAttestation(manifest, environment);
  const releaseId = safeIdentifier(manifest.releaseId, 64);
  const sourceCommit = String(manifest.sourceCommit || "").trim().toLowerCase();
  const schemaVersion = safeSchemaVersion(manifest.schemaVersion);
  if (!releaseId || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceCommit) || schemaVersion === null) {
    strictReleaseFailure("signed manifest release identity is incomplete");
  }
  if (!containerMode) {
    const expectedMetadata = path.join(
      productionBase,
      "shared",
      "release-meta",
      `${releaseId}.json`,
    );
    if (path.normalize(configuredMetadata) !== expectedMetadata) {
      strictReleaseFailure("metadata path does not identify the activated release metadata");
    }
    if (path.basename(path.dirname(expectedManifest)) !== releaseId) {
      strictReleaseFailure("activated release directory and signed releaseId differ");
    }
  }
  const metadataFile = readStrictReleaseJson(
    configuredMetadata,
    "release metadata",
    productionBase,
    trustedOwnerUids,
  );
  const metadata = metadataFile.value;
  const artifactSha256 = safeSha256(metadata.artifactSha256);
  const deployment = manifest.deployment && typeof manifest.deployment === "object"
    && !Array.isArray(manifest.deployment)
    ? manifest.deployment as Record<string, unknown>
    : null;
  const expectedDeploymentMode = deployment ? "container-image" : "archive-systemd";
  const expectedImageDigest = deployment?.imageDigest ?? null;
  if (
    metadata.format !== "fanjin-release-meta/v1"
    || !artifactSha256
    || metadata.releaseId !== releaseId
    || metadata.sourceCommit !== sourceCommit
    || ![
      "manifestVersion",
      "schemaVersion",
      "schemaMode",
      "schemaCompatibility",
      "runtimeCapabilities",
    ].every((field) => sameReleaseField(manifest, metadata, field))
    || metadata.deploymentMode !== expectedDeploymentMode
    || (metadata.imageDigest ?? null) !== expectedImageDigest
  ) {
    strictReleaseFailure("release metadata is not exactly cross-bound to the signed manifest");
  }
  const attestation = ciAttestation ?? verifyModularRuntimeProof({
    environment,
    productionBase,
    trustedOwnerUids,
    manifestFile,
    metadataFile,
    releaseId,
    sourceCommit,
    artifactSha256,
    schemaVersion,
  });
  return {
    releaseId,
    sourceCommit,
    artifactSha256,
    schemaVersion,
    manifestPath: manifestFile.path,
    metadataPath: metadataFile.path,
    attestationKeyId: attestation.keyId,
    attestationPayloadSha256: attestation.payloadSha256,
  };
}
