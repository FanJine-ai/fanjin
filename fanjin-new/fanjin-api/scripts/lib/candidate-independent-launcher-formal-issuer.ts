import crypto, {
  createPublicKey,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import path from "node:path";

import {
  FORMAL_CANDIDATE_FULL_MATRIX_DRIVER_MANIFEST_PATH,
  FORMAL_CANDIDATE_LAUNCHER_MANIFEST_PATH,
  type FormalCandidatePinnedFileIdentity,
} from "../../src/formal-candidate-launcher";
import type {
  CandidateRuntimeArtifactExecutionBinding,
} from "../../src/lib/candidateRuntimeAttestation";
import {
  CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM,
  candidateIndependentLauncherExpectationFromObservation,
  candidateIndependentLauncherCanonicalJson,
  candidateIndependentLauncherValueDigest,
  parseCandidateIndependentLauncherCredentialProjection,
  verifyCandidateIndependentLauncherAttestation,
  type CandidateIndependentLauncherAttestationEnvelope,
  type CandidateIndependentLauncherAttestationExpectation,
  type CandidateIndependentLauncherAttestationObservation,
  type CandidateIndependentLauncherLinuxCredentialProjection,
  type CandidateIndependentLauncherTrustStore,
  type CandidateIndependentLauncherTrustedKey,
  type CandidateIndependentLauncherVerifiedAttestation,
} from "./candidate-independent-launcher-attestation";

/**
 * The v1 launcher attestation is deliberately an observation and can never be
 * formal-ready.  This separately signed v2 layer is the privilege boundary: a
 * trusted, root-owned node-agent must bind that observation to independently
 * observed extraction, kernel process, and artifact-entrypoint identities.
 */
export const CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ISSUER_FORMAT =
  "fanjin-candidate-independent-launcher-formal-issuer/v2" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ENVELOPE_FORMAT =
  "fanjin-candidate-independent-launcher-formal-envelope/v2" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_TRUST_STORE_FORMAT =
  "fanjin-candidate-independent-launcher-formal-trust-store/v2" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_SIGNATURE_DOMAIN =
  "fanjin/candidate/independent-launcher-formal-issuer/v2" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_MAX_LIFETIME_MS = 60_000;
export const CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_MAX_ENVELOPE_BYTES =
  1024 * 1024;
export const CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_RUNTIME_ENTRYPOINT_MANIFEST_PATH =
  "app/build/formal-candidate-runtime-entrypoint.js" as const;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SHA256_BINDING = /^sha256:[a-f0-9]{64}$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_MANIFEST_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._/@+-]+)*$/u;
const DOMAIN_PREFIX = Buffer.from(
  `${CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_SIGNATURE_DOMAIN}\0`,
  "utf8",
);
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 150_000;
const authorities = new WeakSet<object>();
const verifiedAttestations = new WeakSet<object>();
const replayGuards = new WeakSet<object>();

export class CandidateIndependentLauncherFormalIssuerError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CandidateIndependentLauncherFormalIssuerError";
  }
}

function fail(code: string): never {
  throw new CandidateIndependentLauncherFormalIssuerError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!isRecord(value)) return fail(code);
  const keys = Reflect.ownKeys(value);
  const strings = keys.filter((key): key is string => typeof key === "string");
  const wanted = [...expected].sort();
  if (
    strings.length !== keys.length
    || strings.length !== wanted.length
    || [...strings].sort().some((key, index) => key !== wanted[index])
  ) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function cloneJson(value: unknown, depth = 0, state = { nodes: 0 }): unknown {
  state.nodes += 1;
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    return fail("CANDIDATE_FORMAL_ISSUER_JSON_LIMIT_EXCEEDED");
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      return fail("CANDIDATE_FORMAL_ISSUER_JSON_INVALID");
    }
    return value.map((entry) => cloneJson(entry, depth + 1, state));
  }
  if (!isRecord(value)) return fail("CANDIDATE_FORMAL_ISSUER_JSON_INVALID");
  const result: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail("CANDIDATE_FORMAL_ISSUER_JSON_INVALID");
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return fail("CANDIDATE_FORMAL_ISSUER_JSON_INVALID");
    }
    result[key] = cloneJson(descriptor.value, depth + 1, state);
  }
  return result;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
  }
  return value;
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return `sha256:${sha256(candidateIndependentLauncherCanonicalJson(value))}`;
}

function stringMatching(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail(code);
  return value;
}

function canonicalBase64Url(
  value: unknown,
  pattern: RegExp,
  byteLength: number,
  code: string,
): string {
  const encoded = stringMatching(value, pattern, code);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    return fail(code);
  }
  if (
    decoded.byteLength !== byteLength
    || decoded.toString("base64url") !== encoded
  ) return fail(code);
  return encoded;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail(code);
  return Number(value);
}

function nonnegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail(code);
  return Number(value);
}

function exactIso(value: unknown, code: string): string {
  if (typeof value !== "string") return fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return fail(code);
  }
  return value;
}

function absoluteNormalized(value: unknown, code: string): string {
  if (
    typeof value !== "string"
    || !path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.includes("\0")
  ) return fail(code);
  return value;
}

function importTrustedPublicKey(value: CandidateIndependentLauncherTrustedKey): {
  key: KeyObject;
  normalized: CandidateIndependentLauncherTrustedKey;
} {
  const item = exactRecord(value, [
    "algorithm",
    "keyId",
    "publicKeyFingerprintSha256",
    "publicKeySpkiBase64Url",
  ], "CANDIDATE_FORMAL_ISSUER_TRUST_KEY_INVALID");
  const keyId = stringMatching(item.keyId, KEY_ID,
    "CANDIDATE_FORMAL_ISSUER_TRUST_KEY_INVALID");
  if (
    keyId.startsWith("dev-local-only-")
    || item.algorithm !== CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM
  ) return fail("CANDIDATE_FORMAL_ISSUER_TRUST_KEY_INVALID");
  let der: Buffer;
  let key: KeyObject;
  try {
    der = Buffer.from(String(item.publicKeySpkiBase64Url), "base64url");
    if (der.byteLength !== 44 || der.toString("base64url") !== item.publicKeySpkiBase64Url) {
      return fail("CANDIDATE_FORMAL_ISSUER_TRUST_KEY_INVALID");
    }
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return fail("CANDIDATE_FORMAL_ISSUER_TRUST_KEY_INVALID");
  }
  const normalizedDer = Buffer.from(key.export({ format: "der", type: "spki" }));
  const fingerprint = sha256(normalizedDer);
  if (
    key.asymmetricKeyType !== "ed25519"
    || normalizedDer.byteLength !== der.byteLength
    || !timingSafeEqual(normalizedDer, der)
    || item.publicKeyFingerprintSha256 !== fingerprint
  ) return fail("CANDIDATE_FORMAL_ISSUER_TRUST_KEY_INVALID");
  return {
    key,
    normalized: freeze({
      keyId,
      algorithm: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM,
      publicKeySpkiBase64Url: der.toString("base64url"),
      publicKeyFingerprintSha256: fingerprint,
    }),
  };
}

export type CandidateIndependentLauncherFormalTrustStore = Readonly<{
  format: typeof CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_TRUST_STORE_FORMAT;
  issuerClass: "root-owned-independent-node-agent";
  keys: readonly CandidateIndependentLauncherTrustedKey[];
}>;

export type CandidateIndependentLauncherFormalPinnedEntrypoints = Readonly<{
  launcher: FormalCandidatePinnedFileIdentity;
  application: FormalCandidatePinnedFileIdentity;
  runtimeEntrypoint: FormalCandidatePinnedFileIdentity;
  fullMatrixDriver: FormalCandidatePinnedFileIdentity;
}>;

export type CandidateIndependentLauncherFormalExtraction = Readonly<{
  artifactSha256: string;
  releaseRootUid: 0;
  runtimeUid: number;
  runtimeGid: number;
  releaseRootDev: string;
  releaseRootIno: string;
  releaseRootPathBinding: string;
  fullTreeDigest: string;
  signedManifestKeyId: string;
  signedManifestPayloadSha256: string;
  signedManifestFileSha256: string;
  entrypoints: CandidateIndependentLauncherFormalPinnedEntrypoints;
}>;

export type CandidateIndependentLauncherFormalKernelLaunch = Readonly<{
  launcherPid: number;
  launcherPpid: number;
  launcherPgid: number;
  launcherUid: number;
  launcherGid: number;
  launcherCredentials: CandidateIndependentLauncherLinuxCredentialProjection;
  launcherStartIdentityBinding: string;
  launcherExecutable: string;
  launcherArgvBinding: string;
  launcherEnvironmentBinding: string;
  applicationPid: number;
  applicationPpid: number;
  applicationPgid: number;
  applicationUid: number;
  applicationGid: number;
  applicationCredentials: CandidateIndependentLauncherLinuxCredentialProjection;
  applicationStartIdentityBinding: string;
  applicationExecutable: string;
  applicationArgvBinding: string;
  applicationEnvironmentBinding: string;
  fixedLaunchBinding: string;
}>;

export type CandidateIndependentLauncherFormalStatement = Readonly<{
  format: typeof CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ISSUER_FORMAT;
  issuerClass: "root-owned-independent-node-agent";
  issuerIntegrationStatus: "formal-independent-node-agent-integrated";
  formalReady: true;
  baseAttestationDigest: string;
  baseAttestation: CandidateIndependentLauncherAttestationEnvelope;
  issuerExecution: Readonly<{
    platform: "linux";
    nodeAgentPid: number;
    nodeAgentUid: 0;
    runtimeUid: number;
    runtimeGid: number;
    keyId: string;
    publicKeyFingerprintSha256: string;
  }>;
  extraction: CandidateIndependentLauncherFormalExtraction;
  kernelLaunch: CandidateIndependentLauncherFormalKernelLaunch;
  artifactExecutionBinding: CandidateRuntimeArtifactExecutionBinding;
  capturedAt: string;
  expiresAt: string;
  nonce: string;
}>;

export type CandidateIndependentLauncherFormalEnvelope = Readonly<{
  format: typeof CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ENVELOPE_FORMAT;
  algorithm: typeof CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM;
  domain: typeof CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_SIGNATURE_DOMAIN;
  keyId: string;
  publicKeyFingerprintSha256: string;
  statementSha256: string;
  statement: CandidateIndependentLauncherFormalStatement;
  signatureBase64Url: string;
}>;

/** Stable long-form alias used by exact-authorization package wiring. */
export type CandidateIndependentLauncherFormalAttestationEnvelope =
  CandidateIndependentLauncherFormalEnvelope;

export type CandidateIndependentLauncherFormalExpectation = Readonly<{
  base: CandidateIndependentLauncherAttestationExpectation;
  issuer: Readonly<{
    nodeAgentPid: number;
    nodeAgentUid: 0;
    runtimeUid: number;
    runtimeGid: number;
    keyId: string;
    publicKeyFingerprintSha256: string;
  }>;
  extraction: CandidateIndependentLauncherFormalExtraction;
  kernelLaunch: CandidateIndependentLauncherFormalKernelLaunch;
  artifactExecutionBinding: CandidateRuntimeArtifactExecutionBinding;
}>;

export type CandidateIndependentLauncherFormalVerifiedAttestation = Readonly<{
  envelope: CandidateIndependentLauncherFormalEnvelope;
  statement: CandidateIndependentLauncherFormalStatement;
  base: CandidateIndependentLauncherVerifiedAttestation;
  signatureValid: true;
  expectationBound: true;
  issuerIntegrated: true;
  independentLauncherAttestationVerified: true;
  replayConsumed: false;
  formalReady: true;
  keyId: string;
  publicKeyFingerprintSha256: string;
  v1AttestationDigest: string;
  crossBinding: Readonly<{
    issuer: CandidateIndependentLauncherFormalExpectation["issuer"];
    extraction: CandidateIndependentLauncherFormalExtraction;
    kernelLaunch: CandidateIndependentLauncherFormalKernelLaunch;
    artifactExecutionBinding: CandidateRuntimeArtifactExecutionBinding;
  }>;
  attestationDigest: string;
}>;

export type CandidateIndependentLauncherFormalSignerAuthority = Readonly<{
  keyId: string;
  publicKeyFingerprintSha256: string;
  trustedKey: CandidateIndependentLauncherTrustedKey;
  nodeAgentPid: number;
  runtimeUid: number;
  runtimeGid: number;
  dispose: () => void;
}>;

type InternalAuthority = CandidateIndependentLauncherFormalSignerAuthority & {
  signPayload: (payload: Buffer) => Buffer;
};

export type CandidateIndependentLauncherFormalReplayGuard = Readonly<{
  consume: (verified: CandidateIndependentLauncherFormalVerifiedAttestation) => Readonly<{
    replayConsumed: true;
    keyId: string;
    nonce: string;
    runNonce: string;
    expiresAt: string;
  }>;
}>;

function parsePinnedFile(value: unknown): FormalCandidatePinnedFileIdentity {
  const item = exactRecord(value, [
    "byteSize", "dev", "gid", "ino", "manifestPath", "mode", "sha256", "uid",
  ], "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID");
  const manifestPath = stringMatching(item.manifestPath, SAFE_MANIFEST_PATH,
    "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID");
  const uid = nonnegativeInteger(item.uid,
    "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID");
  const gid = nonnegativeInteger(item.gid,
    "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID");
  const mode = nonnegativeInteger(item.mode,
    "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID");
  if (mode > 0o7777 || (mode & 0o222) !== 0 || uid !== 0) {
    return fail("CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_NOT_ROOT_READONLY");
  }
  return freeze({
    manifestPath,
    dev: stringMatching(item.dev, /^(?:0|[1-9][0-9]*)$/u,
      "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID"),
    ino: stringMatching(item.ino, /^[1-9][0-9]*$/u,
      "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID"),
    byteSize: positiveInteger(item.byteSize,
      "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID"),
    sha256: stringMatching(item.sha256, SHA256_HEX,
      "CANDIDATE_FORMAL_ISSUER_PINNED_ENTRYPOINT_INVALID"),
    uid,
    gid,
    mode,
  });
}

function parseEntrypoints(value: unknown): CandidateIndependentLauncherFormalPinnedEntrypoints {
  const item = exactRecord(value, [
    "application", "fullMatrixDriver", "launcher", "runtimeEntrypoint",
  ],
    "CANDIDATE_FORMAL_ISSUER_ENTRYPOINTS_INVALID");
  const launcher = parsePinnedFile(item.launcher);
  const application = parsePinnedFile(item.application);
  const runtimeEntrypoint = parsePinnedFile(item.runtimeEntrypoint);
  const fullMatrixDriver = parsePinnedFile(item.fullMatrixDriver);
  if (
    launcher.manifestPath !== FORMAL_CANDIDATE_LAUNCHER_MANIFEST_PATH
    || application.manifestPath
      !== CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_RUNTIME_ENTRYPOINT_MANIFEST_PATH
    || runtimeEntrypoint.manifestPath !== application.manifestPath
    || runtimeEntrypoint.sha256 !== application.sha256
    || runtimeEntrypoint.byteSize !== application.byteSize
    || runtimeEntrypoint.dev !== application.dev
    || runtimeEntrypoint.ino !== application.ino
    || fullMatrixDriver.manifestPath
      !== FORMAL_CANDIDATE_FULL_MATRIX_DRIVER_MANIFEST_PATH
  ) return fail("CANDIDATE_FORMAL_ISSUER_RUNTIME_ENTRYPOINT_MISMATCH");
  return freeze({ launcher, application, runtimeEntrypoint, fullMatrixDriver });
}

function parseExtraction(value: unknown): CandidateIndependentLauncherFormalExtraction {
  const item = exactRecord(value, [
    "artifactSha256", "entrypoints", "fullTreeDigest", "releaseRootDev",
    "releaseRootIno", "releaseRootPathBinding", "releaseRootUid", "runtimeGid", "runtimeUid",
    "signedManifestFileSha256", "signedManifestKeyId", "signedManifestPayloadSha256",
  ], "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID");
  if (item.releaseRootUid !== 0) {
    return fail("CANDIDATE_FORMAL_ISSUER_RELEASE_ROOT_NOT_ROOT_OWNED");
  }
  const runtimeUid = positiveInteger(item.runtimeUid,
    "CANDIDATE_FORMAL_ISSUER_RUNTIME_UID_INVALID");
  const runtimeGid = positiveInteger(item.runtimeGid,
    "CANDIDATE_FORMAL_ISSUER_RUNTIME_GID_INVALID");
  return freeze({
    artifactSha256: stringMatching(item.artifactSha256, SHA256_HEX,
      "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID"),
    releaseRootUid: 0,
    runtimeUid,
    runtimeGid,
    releaseRootDev: stringMatching(item.releaseRootDev, /^(?:0|[1-9][0-9]*)$/u,
      "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID"),
    releaseRootIno: stringMatching(item.releaseRootIno, /^[1-9][0-9]*$/u,
      "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID"),
    releaseRootPathBinding: stringMatching(item.releaseRootPathBinding, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID"),
    fullTreeDigest: stringMatching(item.fullTreeDigest, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID"),
    signedManifestKeyId: stringMatching(item.signedManifestKeyId, KEY_ID,
      "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID"),
    signedManifestPayloadSha256: stringMatching(item.signedManifestPayloadSha256, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID"),
    signedManifestFileSha256: stringMatching(item.signedManifestFileSha256, SHA256_HEX,
      "CANDIDATE_FORMAL_ISSUER_EXTRACTION_INVALID"),
    entrypoints: parseEntrypoints(item.entrypoints),
  });
}

function parseKernelLaunch(value: unknown): CandidateIndependentLauncherFormalKernelLaunch {
  const item = exactRecord(value, [
    "applicationArgvBinding", "applicationEnvironmentBinding", "applicationExecutable",
    "applicationCredentials", "applicationGid", "applicationPgid", "applicationPid", "applicationPpid", "applicationStartIdentityBinding",
    "applicationUid", "fixedLaunchBinding", "launcherArgvBinding", "launcherCredentials", "launcherEnvironmentBinding",
    "launcherExecutable", "launcherPgid", "launcherPid", "launcherPpid",
    "launcherGid", "launcherStartIdentityBinding", "launcherUid",
  ], "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const launcherPid = positiveInteger(item.launcherPid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const launcherPgid = positiveInteger(item.launcherPgid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const launcherPpid = positiveInteger(item.launcherPpid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const launcherUid = positiveInteger(item.launcherUid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const launcherGid = positiveInteger(item.launcherGid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const launcherCredentials = parseCandidateIndependentLauncherCredentialProjection(
    item.launcherCredentials,
  );
  const applicationPid = positiveInteger(item.applicationPid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const applicationPpid = positiveInteger(item.applicationPpid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const applicationPgid = positiveInteger(item.applicationPgid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const applicationUid = positiveInteger(item.applicationUid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const applicationGid = positiveInteger(item.applicationGid,
    "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID");
  const applicationCredentials = parseCandidateIndependentLauncherCredentialProjection(
    item.applicationCredentials,
  );
  if (
    launcherPid !== launcherPgid
    || launcherPpid === launcherPid
    || applicationPid === launcherPid
    || applicationPpid !== launcherPid
    || applicationPgid !== launcherPgid
    || launcherCredentials.platform !== "linux"
    || applicationCredentials.platform !== "linux"
  ) return fail("CANDIDATE_FORMAL_ISSUER_KERNEL_PROCESS_RELATIONSHIP_INVALID");
  return freeze({
    launcherPid,
    launcherPpid,
    launcherPgid,
    launcherUid,
    launcherGid,
    launcherCredentials,
    launcherStartIdentityBinding: stringMatching(item.launcherStartIdentityBinding, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
    launcherExecutable: absoluteNormalized(item.launcherExecutable,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
    launcherArgvBinding: stringMatching(item.launcherArgvBinding, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
    launcherEnvironmentBinding: stringMatching(item.launcherEnvironmentBinding, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
    applicationPid,
    applicationPpid,
    applicationPgid,
    applicationUid,
    applicationGid,
    applicationCredentials,
    applicationStartIdentityBinding: stringMatching(item.applicationStartIdentityBinding, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
    applicationExecutable: absoluteNormalized(item.applicationExecutable,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
    applicationArgvBinding: stringMatching(item.applicationArgvBinding, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
    applicationEnvironmentBinding: stringMatching(item.applicationEnvironmentBinding, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
    fixedLaunchBinding: stringMatching(item.fixedLaunchBinding, SHA256_BINDING,
      "CANDIDATE_FORMAL_ISSUER_KERNEL_LAUNCH_INVALID"),
  });
}

function parseArtifactExecutionBinding(value: unknown): CandidateRuntimeArtifactExecutionBinding {
  const item = exactRecord(value, ["artifactSignedManifestSha256", "byteSize", "manifestPath", "sha256", "version"],
    "CANDIDATE_FORMAL_ISSUER_ARTIFACT_EXECUTION_BINDING_INVALID");
  if (item.version !== "fanjin-candidate-runtime-artifact-execution-binding/v1") {
    return fail("CANDIDATE_FORMAL_ISSUER_ARTIFACT_EXECUTION_BINDING_INVALID");
  }
  return freeze({
    version: "fanjin-candidate-runtime-artifact-execution-binding/v1",
    artifactSignedManifestSha256: stringMatching(item.artifactSignedManifestSha256, SHA256_HEX,
      "CANDIDATE_FORMAL_ISSUER_ARTIFACT_EXECUTION_BINDING_INVALID"),
    manifestPath: stringMatching(item.manifestPath, SAFE_MANIFEST_PATH,
      "CANDIDATE_FORMAL_ISSUER_ARTIFACT_EXECUTION_BINDING_INVALID"),
    sha256: stringMatching(item.sha256, SHA256_HEX,
      "CANDIDATE_FORMAL_ISSUER_ARTIFACT_EXECUTION_BINDING_INVALID"),
    byteSize: positiveInteger(item.byteSize,
      "CANDIDATE_FORMAL_ISSUER_ARTIFACT_EXECUTION_BINDING_INVALID"),
  });
}

function formalLinuxCredentialsSafe(
  credentials: CandidateIndependentLauncherLinuxCredentialProjection,
  runtimeUid: number,
  runtimeGid: number,
): boolean {
  return Object.values(credentials.uid).every((value) => value === runtimeUid)
    && Object.values(credentials.gid).every((value) => value === runtimeGid)
    && credentials.noNewPrivileges === true
    && /^0{16}$/u.test(credentials.effectiveCapabilitiesHex)
    && (
      credentials.supplementaryGroups.length === 0
      || (
        credentials.supplementaryGroups.length === 1
        && credentials.supplementaryGroups[0] === runtimeGid
      )
    );
}

function crossBind(input: Readonly<{
  base: CandidateIndependentLauncherVerifiedAttestation;
  issuer: CandidateIndependentLauncherFormalStatement["issuerExecution"];
  extraction: CandidateIndependentLauncherFormalExtraction;
  kernel: CandidateIndependentLauncherFormalKernelLaunch;
  artifact: CandidateRuntimeArtifactExecutionBinding;
}>): void {
  const base = input.base.statement;
  const descriptorArtifact = base.runtime.descriptor.artifactExecutionBinding;
  if (
    input.issuer.nodeAgentUid !== 0
    || input.issuer.keyId === input.base.keyId
    || input.issuer.publicKeyFingerprintSha256
      === input.base.publicKeyFingerprintSha256
    || input.issuer.nodeAgentPid !== input.kernel.launcherPpid
    || input.issuer.nodeAgentPid === input.kernel.launcherPid
    || input.issuer.runtimeUid !== input.extraction.runtimeUid
    || input.issuer.runtimeGid !== input.extraction.runtimeGid
    || base.runtimeIdentity.runtimeUid !== input.extraction.runtimeUid
    || base.runtimeIdentity.runtimeGid !== input.extraction.runtimeGid
    || input.kernel.launcherUid !== input.extraction.runtimeUid
    || input.kernel.launcherGid !== input.extraction.runtimeGid
    || input.kernel.applicationUid !== input.extraction.runtimeUid
    || input.kernel.applicationGid !== input.extraction.runtimeGid
    || input.extraction.runtimeUid === 0
    || input.extraction.runtimeGid === 0
    || base.processes.launcher.credentials.platform !== "linux"
    || base.processes.application.credentials.platform !== "linux"
    || candidateIndependentLauncherCanonicalJson(input.kernel.launcherCredentials)
      !== candidateIndependentLauncherCanonicalJson(
        base.processes.launcher.credentials,
      )
    || candidateIndependentLauncherCanonicalJson(input.kernel.applicationCredentials)
      !== candidateIndependentLauncherCanonicalJson(
        base.processes.application.credentials,
      )
    || candidateIndependentLauncherCanonicalJson(input.kernel.launcherCredentials)
      !== candidateIndependentLauncherCanonicalJson(
        input.kernel.applicationCredentials,
      )
    || !formalLinuxCredentialsSafe(
      input.kernel.launcherCredentials,
      input.extraction.runtimeUid,
      input.extraction.runtimeGid,
    )
    || !formalLinuxCredentialsSafe(
      input.kernel.applicationCredentials,
      input.extraction.runtimeUid,
      input.extraction.runtimeGid,
    )
    || input.extraction.artifactSha256 !== base.candidate.artifactSha256
    || input.extraction.releaseRootDev !== base.releaseRoot.dev
    || input.extraction.releaseRootIno !== base.releaseRoot.ino
    || input.extraction.releaseRootPathBinding !== base.releaseRoot.pathBinding
    || input.extraction.fullTreeDigest !== base.releaseRoot.fullTreeDigest
    || input.extraction.signedManifestKeyId !== base.signedManifest.attestationKeyId
    || input.extraction.signedManifestPayloadSha256 !== base.signedManifest.payloadSha256
    || input.extraction.signedManifestFileSha256 !== base.signedManifest.signedManifestSha256
    || input.kernel.launcherPid !== base.processes.launcher.pid
    || input.kernel.launcherPpid !== base.processes.launcher.ppid
    || input.kernel.launcherPgid !== base.processes.launcher.pgid
    || input.kernel.launcherStartIdentityBinding !== base.processes.launcher.startIdentity.binding
    || input.kernel.launcherExecutable !== base.processes.launcher.executable
    || input.kernel.launcherArgvBinding !== base.processes.launcher.argvBinding
    || input.kernel.launcherEnvironmentBinding !== base.processes.launcher.environmentBinding
    || input.kernel.applicationPid !== base.processes.application.pid
    || input.kernel.applicationPpid !== base.processes.application.ppid
    || input.kernel.applicationPgid !== base.processes.application.pgid
    || input.kernel.applicationStartIdentityBinding !== base.processes.application.startIdentity.binding
    || input.kernel.applicationExecutable !== base.processes.application.executable
    || input.kernel.applicationArgvBinding !== base.processes.application.argvBinding
    || input.kernel.applicationEnvironmentBinding !== base.processes.application.environmentBinding
    || input.kernel.fixedLaunchBinding !== base.fixedLaunch.binding
    || descriptorArtifact === null
    || candidateIndependentLauncherCanonicalJson(descriptorArtifact)
      !== candidateIndependentLauncherCanonicalJson(input.artifact)
    || input.artifact.artifactSignedManifestSha256
      !== base.candidate.artifactSignedManifestSha256
    || input.artifact.manifestPath
      !== input.extraction.entrypoints.runtimeEntrypoint.manifestPath
    || input.artifact.sha256 !== input.extraction.entrypoints.runtimeEntrypoint.sha256
    || input.artifact.byteSize !== input.extraction.entrypoints.runtimeEntrypoint.byteSize
  ) return fail("CANDIDATE_FORMAL_ISSUER_CROSS_BINDING_INVALID");
}

function signaturePayload(statement: CandidateIndependentLauncherFormalStatement): Buffer {
  return Buffer.concat([
    DOMAIN_PREFIX,
    Buffer.from(candidateIndependentLauncherCanonicalJson(statement), "utf8"),
  ]);
}

function parseTrustStore(value: unknown): CandidateIndependentLauncherFormalTrustStore {
  const item = exactRecord(value, ["format", "issuerClass", "keys"],
    "CANDIDATE_FORMAL_ISSUER_TRUST_STORE_INVALID");
  if (
    item.format !== CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_TRUST_STORE_FORMAT
    || item.issuerClass !== "root-owned-independent-node-agent"
    || !Array.isArray(item.keys)
    || item.keys.length < 1
    || item.keys.length > 32
  ) return fail("CANDIDATE_FORMAL_ISSUER_TRUST_STORE_INVALID");
  const keys = item.keys.map((key) => importTrustedPublicKey(
    key as CandidateIndependentLauncherTrustedKey,
  ).normalized);
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    return fail("CANDIDATE_FORMAL_ISSUER_TRUST_STORE_INVALID");
  }
  return freeze({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_TRUST_STORE_FORMAT,
    issuerClass: "root-owned-independent-node-agent",
    keys,
  });
}

function parseIssuerExecution(value: unknown): CandidateIndependentLauncherFormalStatement["issuerExecution"] {
  const item = exactRecord(value, [
    "keyId", "nodeAgentPid", "nodeAgentUid", "platform", "publicKeyFingerprintSha256", "runtimeGid", "runtimeUid",
  ], "CANDIDATE_FORMAL_ISSUER_EXECUTION_INVALID");
  if (item.platform !== "linux" || item.nodeAgentUid !== 0) {
    return fail("CANDIDATE_FORMAL_ISSUER_EXECUTION_INVALID");
  }
  return freeze({
    platform: "linux",
    nodeAgentPid: positiveInteger(item.nodeAgentPid,
      "CANDIDATE_FORMAL_ISSUER_EXECUTION_INVALID"),
    nodeAgentUid: 0,
    runtimeUid: positiveInteger(item.runtimeUid,
      "CANDIDATE_FORMAL_ISSUER_EXECUTION_INVALID"),
    runtimeGid: positiveInteger(item.runtimeGid,
      "CANDIDATE_FORMAL_ISSUER_EXECUTION_INVALID"),
    keyId: stringMatching(item.keyId, KEY_ID,
      "CANDIDATE_FORMAL_ISSUER_EXECUTION_INVALID"),
    publicKeyFingerprintSha256: stringMatching(item.publicKeyFingerprintSha256, SHA256_HEX,
      "CANDIDATE_FORMAL_ISSUER_EXECUTION_INVALID"),
  });
}

function parseStatement(value: unknown): CandidateIndependentLauncherFormalStatement {
  const item = exactRecord(value, [
    "artifactExecutionBinding", "baseAttestation", "baseAttestationDigest", "capturedAt",
    "expiresAt", "extraction", "formalReady", "format", "issuerClass",
    "issuerExecution", "issuerIntegrationStatus", "kernelLaunch", "nonce",
  ], "CANDIDATE_FORMAL_ISSUER_STATEMENT_INVALID");
  if (
    item.format !== CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ISSUER_FORMAT
    || item.issuerClass !== "root-owned-independent-node-agent"
    || item.issuerIntegrationStatus !== "formal-independent-node-agent-integrated"
    || item.formalReady !== true
  ) return fail("CANDIDATE_FORMAL_ISSUER_STATEMENT_INVALID");
  const baseAttestation = cloneJson(item.baseAttestation) as CandidateIndependentLauncherAttestationEnvelope;
  const baseAttestationDigest = candidateIndependentLauncherValueDigest(baseAttestation);
  if (item.baseAttestationDigest !== baseAttestationDigest) {
    return fail("CANDIDATE_FORMAL_ISSUER_BASE_ATTESTATION_DIGEST_INVALID");
  }
  const capturedAt = exactIso(item.capturedAt, "CANDIDATE_FORMAL_ISSUER_TIME_INVALID");
  const expiresAt = exactIso(item.expiresAt, "CANDIDATE_FORMAL_ISSUER_TIME_INVALID");
  if (
    Date.parse(expiresAt) <= Date.parse(capturedAt)
    || Date.parse(expiresAt) - Date.parse(capturedAt)
      > CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_MAX_LIFETIME_MS
  ) return fail("CANDIDATE_FORMAL_ISSUER_TIME_INVALID");
  return freeze({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ISSUER_FORMAT,
    issuerClass: "root-owned-independent-node-agent",
    issuerIntegrationStatus: "formal-independent-node-agent-integrated",
    formalReady: true,
    baseAttestationDigest,
    baseAttestation,
    issuerExecution: parseIssuerExecution(item.issuerExecution),
    extraction: parseExtraction(item.extraction),
    kernelLaunch: parseKernelLaunch(item.kernelLaunch),
    artifactExecutionBinding: parseArtifactExecutionBinding(item.artifactExecutionBinding),
    capturedAt,
    expiresAt,
    nonce: stringMatching(item.nonce, BASE64URL_32,
      "CANDIDATE_FORMAL_ISSUER_NONCE_INVALID"),
  });
}

function parseEnvelope(value: unknown): CandidateIndependentLauncherFormalEnvelope {
  const item = exactRecord(value, [
    "algorithm", "domain", "format", "keyId", "publicKeyFingerprintSha256",
    "signatureBase64Url", "statement", "statementSha256",
  ], "CANDIDATE_FORMAL_ISSUER_ENVELOPE_INVALID");
  if (
    item.format !== CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ENVELOPE_FORMAT
    || item.algorithm !== CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM
    || item.domain !== CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_SIGNATURE_DOMAIN
  ) return fail("CANDIDATE_FORMAL_ISSUER_ENVELOPE_INVALID");
  const statement = parseStatement(item.statement);
  const statementSha256 = sha256(candidateIndependentLauncherCanonicalJson(statement));
  if (item.statementSha256 !== statementSha256) {
    return fail("CANDIDATE_FORMAL_ISSUER_STATEMENT_DIGEST_INVALID");
  }
  return freeze({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ENVELOPE_FORMAT,
    algorithm: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM,
    domain: CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_SIGNATURE_DOMAIN,
    keyId: stringMatching(item.keyId, KEY_ID,
      "CANDIDATE_FORMAL_ISSUER_ENVELOPE_INVALID"),
    publicKeyFingerprintSha256: stringMatching(item.publicKeyFingerprintSha256, SHA256_HEX,
      "CANDIDATE_FORMAL_ISSUER_ENVELOPE_INVALID"),
    statementSha256,
    statement,
    signatureBase64Url: canonicalBase64Url(
      item.signatureBase64Url,
      BASE64URL_SIGNATURE,
      64,
      "CANDIDATE_FORMAL_ISSUER_SIGNATURE_INVALID",
    ),
  });
}

function expectationProjection(
  statement: CandidateIndependentLauncherFormalStatement,
  base: CandidateIndependentLauncherAttestationExpectation,
): CandidateIndependentLauncherFormalExpectation {
  return freeze({
    base,
    issuer: {
      nodeAgentPid: statement.issuerExecution.nodeAgentPid,
      nodeAgentUid: 0,
      runtimeUid: statement.issuerExecution.runtimeUid,
      runtimeGid: statement.issuerExecution.runtimeGid,
      keyId: statement.issuerExecution.keyId,
      publicKeyFingerprintSha256: statement.issuerExecution.publicKeyFingerprintSha256,
    },
    extraction: statement.extraction,
    kernelLaunch: statement.kernelLaunch,
    artifactExecutionBinding: statement.artifactExecutionBinding,
  });
}

/**
 * Derives a verifier expectation from raw observation facts plus independent
 * issuer/extraction/kernel facts. It intentionally rejects signed envelopes as
 * input so the expectation cannot be copied from the claim under verification.
 */
export function candidateIndependentLauncherFormalExpectationFromObservation(
  input: Readonly<{
    observation: CandidateIndependentLauncherAttestationObservation;
    issuer: CandidateIndependentLauncherFormalExpectation["issuer"];
    extraction: CandidateIndependentLauncherFormalExtraction;
    kernelLaunch: CandidateIndependentLauncherFormalKernelLaunch;
  }>,
): CandidateIndependentLauncherFormalExpectation {
  const base = candidateIndependentLauncherExpectationFromObservation(
    input.observation,
  );
  const issuerValue = exactRecord(input.issuer, [
    "keyId", "nodeAgentPid", "nodeAgentUid", "publicKeyFingerprintSha256",
    "runtimeGid", "runtimeUid",
  ], "CANDIDATE_FORMAL_ISSUER_EXPECTATION_INVALID");
  if (issuerValue.nodeAgentUid !== 0) {
    return fail("CANDIDATE_FORMAL_ISSUER_EXPECTATION_INVALID");
  }
  const issuer = freeze({
    nodeAgentPid: positiveInteger(issuerValue.nodeAgentPid,
      "CANDIDATE_FORMAL_ISSUER_EXPECTATION_INVALID"),
    nodeAgentUid: 0 as const,
    runtimeUid: positiveInteger(issuerValue.runtimeUid,
      "CANDIDATE_FORMAL_ISSUER_EXPECTATION_INVALID"),
    runtimeGid: positiveInteger(issuerValue.runtimeGid,
      "CANDIDATE_FORMAL_ISSUER_EXPECTATION_INVALID"),
    keyId: stringMatching(issuerValue.keyId, KEY_ID,
      "CANDIDATE_FORMAL_ISSUER_EXPECTATION_INVALID"),
    publicKeyFingerprintSha256: stringMatching(
      issuerValue.publicKeyFingerprintSha256,
      SHA256_HEX,
      "CANDIDATE_FORMAL_ISSUER_EXPECTATION_INVALID",
    ),
  });
  const extraction = parseExtraction(input.extraction);
  const kernelLaunch = parseKernelLaunch(input.kernelLaunch);
  const artifactExecutionBinding = parseArtifactExecutionBinding(
    input.observation.runtime.descriptor.artifactExecutionBinding,
  );
  if (
    issuer.runtimeUid !== extraction.runtimeUid
    || issuer.runtimeGid !== extraction.runtimeGid
    || base.runtimeIdentity.runtimeUid !== extraction.runtimeUid
    || base.runtimeIdentity.runtimeGid !== extraction.runtimeGid
    || kernelLaunch.launcherUid !== extraction.runtimeUid
    || kernelLaunch.applicationUid !== extraction.runtimeUid
    || kernelLaunch.launcherGid !== extraction.runtimeGid
    || kernelLaunch.applicationGid !== extraction.runtimeGid
    || candidateIndependentLauncherCanonicalJson(kernelLaunch.launcherCredentials)
      !== candidateIndependentLauncherCanonicalJson(
        base.processes.launcher.credentials,
      )
    || candidateIndependentLauncherCanonicalJson(kernelLaunch.applicationCredentials)
      !== candidateIndependentLauncherCanonicalJson(
        base.processes.application.credentials,
      )
    || !formalLinuxCredentialsSafe(
      kernelLaunch.launcherCredentials,
      extraction.runtimeUid,
      extraction.runtimeGid,
    )
    || !formalLinuxCredentialsSafe(
      kernelLaunch.applicationCredentials,
      extraction.runtimeUid,
      extraction.runtimeGid,
    )
  ) return fail("CANDIDATE_FORMAL_ISSUER_EXPECTATION_INVALID");
  return freeze({
    base,
    issuer,
    extraction,
    kernelLaunch,
    artifactExecutionBinding,
  });
}

/**
 * Creates the only production signing capability. It intentionally accepts a
 * non-exporting signer callback, never a private KeyObject. The callback is
 * challenge-verified against the separately configured trusted public key.
 * There is no dependency injection for platform, uid, or pid.
 */
export function createCandidateIndependentLauncherFormalSignerAuthority(input: Readonly<{
  trustedKey: CandidateIndependentLauncherTrustedKey;
  runtimeUid: number;
  runtimeGid: number;
  sign: (payload: Buffer) => Buffer;
}>): CandidateIndependentLauncherFormalSignerAuthority {
  if (
    process.platform !== "linux"
    || typeof process.getuid !== "function"
    || process.getuid() !== 0
    || typeof input.sign !== "function"
  ) return fail("CANDIDATE_FORMAL_ISSUER_INDEPENDENT_ROOT_AGENT_REQUIRED");
  const runtimeUid = positiveInteger(input.runtimeUid,
    "CANDIDATE_FORMAL_ISSUER_RUNTIME_UID_INVALID");
  const runtimeGid = positiveInteger(input.runtimeGid,
    "CANDIDATE_FORMAL_ISSUER_RUNTIME_GID_INVALID");
  const imported = importTrustedPublicKey(input.trustedKey);
  let signer: ((payload: Buffer) => Buffer) | undefined = input.sign;
  const challenge = Buffer.concat([
    Buffer.from(`${CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_SIGNATURE_DOMAIN}/authority-proof\0`, "utf8"),
    crypto.randomBytes(32),
    Buffer.from(String(process.pid), "utf8"),
  ]);
  let proof: Buffer;
  try {
    proof = signer(Buffer.from(challenge));
  } catch {
    return fail("CANDIDATE_FORMAL_ISSUER_SIGNER_PROOF_INVALID");
  }
  if (
    !Buffer.isBuffer(proof)
    || proof.byteLength !== 64
    || !crypto.verify(null, challenge, imported.key, proof)
  ) return fail("CANDIDATE_FORMAL_ISSUER_SIGNER_PROOF_INVALID");
  const authority: InternalAuthority = Object.freeze({
    keyId: imported.normalized.keyId,
    publicKeyFingerprintSha256: imported.normalized.publicKeyFingerprintSha256,
    trustedKey: imported.normalized,
    nodeAgentPid: process.pid,
    runtimeUid,
    runtimeGid,
    signPayload(payload): Buffer {
      if (!signer) return fail("CANDIDATE_FORMAL_ISSUER_SIGNER_DISPOSED");
      let signature: Buffer;
      try {
        signature = signer(Buffer.from(payload));
      } catch {
        return fail("CANDIDATE_FORMAL_ISSUER_SIGNING_FAILED");
      }
      if (
        !Buffer.isBuffer(signature)
        || signature.byteLength !== 64
        || !crypto.verify(null, payload, imported.key, signature)
      ) return fail("CANDIDATE_FORMAL_ISSUER_SIGNING_FAILED");
      return Buffer.from(signature);
    },
    dispose(): void { signer = undefined; },
  });
  authorities.add(authority);
  return authority;
}

export function issueCandidateIndependentLauncherFormalAttestation(input: Readonly<{
  authority: CandidateIndependentLauncherFormalSignerAuthority;
  baseAttestation: CandidateIndependentLauncherAttestationEnvelope;
  baseTrustStore: CandidateIndependentLauncherTrustStore;
  baseExpectation: CandidateIndependentLauncherAttestationExpectation;
  extraction: CandidateIndependentLauncherFormalExtraction;
  kernelLaunch: CandidateIndependentLauncherFormalKernelLaunch;
  nonce: string;
  now?: number;
}>): CandidateIndependentLauncherFormalEnvelope {
  if (!authorities.has(input.authority)) {
    return fail("CANDIDATE_FORMAL_ISSUER_AUTHORITY_INVALID");
  }
  const authority = input.authority as InternalAuthority;
  if (
    process.platform !== "linux"
    || typeof process.getuid !== "function"
    || process.getuid() !== 0
    || process.pid !== authority.nodeAgentPid
  ) return fail("CANDIDATE_FORMAL_ISSUER_INDEPENDENT_ROOT_AGENT_REQUIRED");
  const now = input.now ?? Date.now();
  const base = verifyCandidateIndependentLauncherAttestation({
    envelope: input.baseAttestation,
    trustStore: input.baseTrustStore,
    expectation: input.baseExpectation,
    now,
  });
  const extraction = parseExtraction(input.extraction);
  const kernelLaunch = parseKernelLaunch(input.kernelLaunch);
  const artifactExecutionBinding = parseArtifactExecutionBinding(
    base.statement.runtime.descriptor.artifactExecutionBinding,
  );
  const issuerExecution = freeze({
    platform: "linux" as const,
    nodeAgentPid: authority.nodeAgentPid,
    nodeAgentUid: 0 as const,
    runtimeUid: authority.runtimeUid,
    runtimeGid: authority.runtimeGid,
    keyId: authority.keyId,
    publicKeyFingerprintSha256: authority.publicKeyFingerprintSha256,
  });
  crossBind({ base, issuer: issuerExecution, extraction, kernel: kernelLaunch, artifact: artifactExecutionBinding });
  const statement = parseStatement({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ISSUER_FORMAT,
    issuerClass: "root-owned-independent-node-agent",
    issuerIntegrationStatus: "formal-independent-node-agent-integrated",
    formalReady: true,
    baseAttestationDigest: candidateIndependentLauncherValueDigest(base.envelope),
    baseAttestation: base.envelope,
    issuerExecution,
    extraction,
    kernelLaunch,
    artifactExecutionBinding,
    capturedAt: base.statement.capturedAt,
    expiresAt: base.statement.expiresAt,
    nonce: stringMatching(input.nonce, BASE64URL_32,
      "CANDIDATE_FORMAL_ISSUER_NONCE_INVALID"),
  });
  if (statement.nonce === base.statement.nonce || statement.nonce === base.statement.session.runNonce) {
    return fail("CANDIDATE_FORMAL_ISSUER_NONCE_COLLISION");
  }
  const signature = authority.signPayload(signaturePayload(statement));
  return freeze({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_ENVELOPE_FORMAT,
    algorithm: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM,
    domain: CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_SIGNATURE_DOMAIN,
    keyId: authority.keyId,
    publicKeyFingerprintSha256: authority.publicKeyFingerprintSha256,
    statementSha256: sha256(candidateIndependentLauncherCanonicalJson(statement)),
    statement,
    signatureBase64Url: signature.toString("base64url"),
  });
}

export function verifyCandidateIndependentLauncherFormalAttestation(input: Readonly<{
  envelope: unknown;
  trustStore: CandidateIndependentLauncherFormalTrustStore;
  baseTrustStore: CandidateIndependentLauncherTrustStore;
  expectation: CandidateIndependentLauncherFormalExpectation;
  now?: number;
}>): CandidateIndependentLauncherFormalVerifiedAttestation {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) return fail("CANDIDATE_FORMAL_ISSUER_TIME_INVALID");
  const envelope = parseEnvelope(input.envelope);
  const trustStore = parseTrustStore(input.trustStore);
  const trusted = trustStore.keys.find((key) => key.keyId === envelope.keyId);
  if (!trusted) return fail("CANDIDATE_FORMAL_ISSUER_KEY_UNTRUSTED");
  if (
    trusted.publicKeyFingerprintSha256 !== envelope.publicKeyFingerprintSha256
    || envelope.statement.issuerExecution.keyId !== envelope.keyId
    || envelope.statement.issuerExecution.publicKeyFingerprintSha256
      !== envelope.publicKeyFingerprintSha256
  ) return fail("CANDIDATE_FORMAL_ISSUER_KEY_MISMATCH");
  const imported = importTrustedPublicKey(trusted);
  const signature = Buffer.from(envelope.signatureBase64Url, "base64url");
  if (
    signature.byteLength !== 64
    || !crypto.verify(null, signaturePayload(envelope.statement), imported.key, signature)
  ) return fail("CANDIDATE_FORMAL_ISSUER_SIGNATURE_INVALID");
  if (
    now < Date.parse(envelope.statement.capturedAt)
    || now >= Date.parse(envelope.statement.expiresAt)
  ) return fail("CANDIDATE_FORMAL_ISSUER_ATTESTATION_EXPIRED");
  const base = verifyCandidateIndependentLauncherAttestation({
    envelope: envelope.statement.baseAttestation,
    trustStore: input.baseTrustStore,
    expectation: input.expectation.base,
    now,
  });
  if (
    envelope.statement.capturedAt !== base.statement.capturedAt
    || envelope.statement.expiresAt !== base.statement.expiresAt
    || envelope.statement.nonce === base.statement.nonce
    || envelope.statement.nonce === base.statement.session.runNonce
  ) return fail("CANDIDATE_FORMAL_ISSUER_TIME_OR_NONCE_MISMATCH");
  crossBind({
    base,
    issuer: envelope.statement.issuerExecution,
    extraction: envelope.statement.extraction,
    kernel: envelope.statement.kernelLaunch,
    artifact: envelope.statement.artifactExecutionBinding,
  });
  const actual = expectationProjection(envelope.statement, input.expectation.base);
  if (
    candidateIndependentLauncherCanonicalJson(actual)
      !== candidateIndependentLauncherCanonicalJson(cloneJson(input.expectation))
  ) return fail("CANDIDATE_FORMAL_ISSUER_EXPECTATION_MISMATCH");
  const verified = freeze({
    envelope,
    statement: envelope.statement,
    base,
    signatureValid: true as const,
    expectationBound: true as const,
    issuerIntegrated: true as const,
    independentLauncherAttestationVerified: true as const,
    replayConsumed: false as const,
    formalReady: true as const,
    keyId: envelope.keyId,
    publicKeyFingerprintSha256: envelope.publicKeyFingerprintSha256,
    v1AttestationDigest: base.attestationDigest,
    crossBinding: {
      issuer: actual.issuer,
      extraction: actual.extraction,
      kernelLaunch: actual.kernelLaunch,
      artifactExecutionBinding: actual.artifactExecutionBinding,
    },
    attestationDigest: digest(envelope),
  });
  verifiedAttestations.add(verified);
  return verified;
}

export function renderCandidateIndependentLauncherFormalAttestation(
  envelope: CandidateIndependentLauncherFormalEnvelope,
): string {
  return `${candidateIndependentLauncherCanonicalJson(parseEnvelope(envelope))}\n`;
}

export function parseCandidateIndependentLauncherFormalAttestation(
  bytes: Buffer | string,
): CandidateIndependentLauncherFormalEnvelope {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (
    !Buffer.isBuffer(buffer)
    || buffer.byteLength < 2
    || buffer.byteLength > CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_MAX_ENVELOPE_BYTES
  ) return fail("CANDIDATE_FORMAL_ISSUER_SERIALIZATION_INVALID");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    return fail("CANDIDATE_FORMAL_ISSUER_SERIALIZATION_INVALID");
  }
  const envelope = parseEnvelope(value);
  if (`${candidateIndependentLauncherCanonicalJson(envelope)}\n` !== buffer.toString("utf8")) {
    return fail("CANDIDATE_FORMAL_ISSUER_SERIALIZATION_NON_CANONICAL");
  }
  return envelope;
}

/** Idempotent verification is separate from this one-shot execution fence. */
export function createCandidateIndependentLauncherFormalReplayGuard(
  options: Readonly<{ now?: () => number }> = {},
): CandidateIndependentLauncherFormalReplayGuard {
  const consumed = new Set<string>();
  const guard: CandidateIndependentLauncherFormalReplayGuard = Object.freeze({
    consume(verified) {
      if (!verifiedAttestations.has(verified) || verified.formalReady !== true) {
        return fail("CANDIDATE_FORMAL_ISSUER_REPLAY_GUARD_INPUT_INVALID");
      }
      const now = (options.now ?? Date.now)();
      if (
        !Number.isFinite(now)
        || now < Date.parse(verified.statement.capturedAt)
        || now >= Date.parse(verified.statement.expiresAt)
      ) return fail("CANDIDATE_FORMAL_ISSUER_ATTESTATION_EXPIRED");
      const identity = [
        verified.keyId,
        verified.statement.baseAttestationDigest,
        verified.statement.baseAttestation.statement.session.sessionBinding,
        verified.statement.baseAttestation.statement.session.checkpointBinding,
        verified.statement.baseAttestation.statement.session.runNonce,
        verified.statement.nonce,
      ].join("\0");
      if (consumed.has(identity)) return fail("CANDIDATE_FORMAL_ISSUER_ATTESTATION_REPLAYED");
      consumed.add(identity);
      return freeze({
        replayConsumed: true as const,
        keyId: verified.keyId,
        nonce: verified.statement.nonce,
        runNonce: verified.statement.baseAttestation.statement.session.runNonce,
        expiresAt: verified.statement.expiresAt,
      });
    },
  });
  replayGuards.add(guard);
  return guard;
}

export function consumeCandidateIndependentLauncherFormalAttestation(input: Readonly<{
  guard: CandidateIndependentLauncherFormalReplayGuard;
  verified: CandidateIndependentLauncherFormalVerifiedAttestation;
}>): ReturnType<CandidateIndependentLauncherFormalReplayGuard["consume"]> {
  if (!replayGuards.has(input.guard)) {
    return fail("CANDIDATE_FORMAL_ISSUER_REPLAY_GUARD_INVALID");
  }
  return input.guard.consume(input.verified);
}
