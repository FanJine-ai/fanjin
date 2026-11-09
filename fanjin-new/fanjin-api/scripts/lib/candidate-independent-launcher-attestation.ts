import {
  createHash,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import path from "node:path";

import {
  assertCandidateRuntimeAttestationDescriptor,
  assertCandidateRuntimeChallengeResponse,
  type CandidateRuntimeAttestationDescriptor,
  type CandidateRuntimeChallengeResponse,
} from "../../src/lib/candidateRuntimeAttestation";
import type {
  FormalCandidateNodeRuntimeIdentity,
} from "../../src/formal-candidate-launcher";

/**
 * Cryptographic contract for an attestation issued by a launcher/node-agent
 * that is independent from the candidate process.  This module deliberately
 * does not implement that privileged issuer or make a release formal-ready.
 */
export const CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_FORMAT =
  "fanjin-candidate-independent-launcher-attestation/v1" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_ENVELOPE_FORMAT =
  "fanjin-candidate-independent-launcher-attestation-envelope/v1" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_STORE_FORMAT =
  "fanjin-candidate-independent-launcher-trust-store/v1" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_DOMAIN =
  "fanjin/candidate/independent-launcher-attestation/v1" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM =
  "Ed25519" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_CANONICALIZATION =
  "RFC8785-subset-sorted-json-v1" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_ISSUER_INTEGRATION_STATUS =
  "external-node-agent-integration-required" as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_FORMAL_READY = false as const;
export const CANDIDATE_INDEPENDENT_LAUNCHER_MAX_LIFETIME_MS = 60_000;
export const CANDIDATE_INDEPENDENT_LAUNCHER_MAX_ENVELOPE_BYTES =
  512 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SHA256_BINDING = /^sha256:[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE_DIGEST = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const PROCESS_NAMESPACE = /^pid:\[[1-9][0-9]*\]$/u;
const START_TOKEN = /^[A-Za-z0-9._:+/=-]{1,256}$/u;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BOOT_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const SIGNATURE_PREFIX = Buffer.from(
  `${CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_DOMAIN}\0`,
  "utf8",
);
const issuedSignerAuthorities = new WeakSet<object>();
const issuedReplayGuards = new WeakSet<object>();
const issuedVerifiedAttestations = new WeakSet<object>();

export class CandidateIndependentLauncherAttestationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CandidateIndependentLauncherAttestationError";
  }
}

function fail(code: string): never {
  throw new CandidateIndependentLauncherAttestationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!isRecord(value)) return fail(code);
  let keys: readonly (string | symbol)[];
  let descriptors: PropertyDescriptorMap;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail(code);
  }
  const strings = keys.filter((key): key is string => typeof key === "string");
  const wanted = [...expectedKeys].sort();
  if (
    strings.length !== keys.length
    || strings.length !== wanted.length
    || [...strings].sort().some((key, index) => key !== wanted[index])
  ) return fail(code);
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail(
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANONICAL_VALUE_INVALID",
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return fail("CANDIDATE_INDEPENDENT_LAUNCHER_CANONICAL_VALUE_INVALID");
}

export function candidateIndependentLauncherCanonicalJson(value: unknown): string {
  return canonicalJson(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
  }
  return value;
}

function cloneJsonData(
  value: unknown,
  state = { nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_JSON_LIMIT_EXCEEDED");
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key === "symbol")
      || keys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(String(key)))
      || Object.keys(value).length !== value.length
    ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_JSON_INVALID");
    return value.map((item) => cloneJsonData(item, state, depth + 1));
  }
  if (!isRecord(value)) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_JSON_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_JSON_INVALID");
  }
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return fail("CANDIDATE_INDEPENDENT_LAUNCHER_JSON_INVALID");
    }
    result[key] = cloneJsonData(descriptor.value, state, depth + 1);
  }
  return result;
}

function requiredString(value: unknown, code: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_096
    || value.includes("\0")
  ) return fail(code);
  return value;
}

function exactIso(value: unknown, code: string): string {
  const text = requiredString(value, code);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    return fail(code);
  }
  return text;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail(code);
  return Number(value);
}

function nonnegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail(code);
  return Number(value);
}

function patternString(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail(code);
  return value;
}

function canonicalBase64Url(
  value: unknown,
  pattern: RegExp,
  byteLength: number,
  code: string,
): string {
  const encoded = patternString(value, pattern, code);
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

function normalizedAbsolutePath(value: unknown, code: string): string {
  const resolved = requiredString(value, code);
  if (
    !path.posix.isAbsolute(resolved)
    || path.posix.normalize(resolved) !== resolved
  ) return fail(code);
  return resolved;
}

export type CandidateIndependentLauncherCandidateIdentity = Readonly<{
  releaseUuid: string;
  artifactUuid: string;
  artifactSha256: string;
  artifactSignedManifestSha256: string;
  sourceDigest: string;
  schemaExpectedSha256: string;
  configExpectedSha256: string;
  releaseAttestationKeyId: string;
}>;

export type CandidateIndependentLauncherSignedManifest = Readonly<{
  attestationKeyId: string;
  payloadSha256: string;
  signedManifestSha256: string;
}>;

export type CandidateIndependentLauncherReleaseRoot = Readonly<{
  releaseId: string;
  dev: string;
  ino: string;
  fullTreeDigest: string;
  pathBinding: string;
}>;

export type CandidateIndependentLauncherProcessStartIdentity = Readonly<{
  source: "linux-proc-start-ticks" | "darwin-kernel-start-time";
  bootIdentity: string;
  pidNamespace: string | null;
  startToken: string;
  startEpochMs: number;
  binding: string;
}>;

export type CandidateIndependentLauncherCredentialIdQuad = Readonly<{
  real: number;
  effective: number;
  saved: number;
  filesystem: number;
}>;

export type CandidateIndependentLauncherLinuxCredentialProjection = Readonly<{
  evidenceClass: "linux-proc-status-complete";
  platform: "linux";
  uid: CandidateIndependentLauncherCredentialIdQuad;
  gid: CandidateIndependentLauncherCredentialIdQuad;
  supplementaryGroups: readonly number[];
  noNewPrivileges: boolean;
  effectiveCapabilitiesHex: string;
}>;

export type CandidateIndependentLauncherDarwinCredentialProjection = Readonly<{
  evidenceClass: "darwin-ps-uid-gid-limited";
  platform: "darwin";
  uid: number;
  gid: number;
}>;

export type CandidateIndependentLauncherCredentialProjection = Readonly<
  CandidateIndependentLauncherLinuxCredentialProjection
  | CandidateIndependentLauncherDarwinCredentialProjection
>;

export type CandidateIndependentLauncherRuntimeIdentity = Readonly<{
  runtimeUid: number;
  runtimeGid: number;
}>;

export type CandidateIndependentLauncherObservedProcess = Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  executable: string;
  commandBinding: string;
  argvBinding: string;
  environmentBinding: string;
  credentials: CandidateIndependentLauncherCredentialProjection;
  startIdentity: CandidateIndependentLauncherProcessStartIdentity;
}>;

export type CandidateIndependentLauncherFixedCommand = Readonly<{
  executable: string;
  cwd: string;
  argvBinding: string;
  environmentBinding: string;
}>;

export type CandidateIndependentLauncherFixedLaunch = Readonly<{
  launcher: CandidateIndependentLauncherFixedCommand;
  application: CandidateIndependentLauncherFixedCommand;
  binding: string;
}>;

export type CandidateIndependentLauncherRuntimeProof = Readonly<{
  descriptor: CandidateRuntimeAttestationDescriptor;
  descriptorDigest: string;
  authorityBinding: string;
  challenge: string;
  challengeResponse: CandidateRuntimeChallengeResponse;
  challengeResponseDigest: string;
}>;

export type CandidateIndependentLauncherSessionBinding = Readonly<{
  sessionBinding: string;
  checkpointBinding: string;
  runNonce: string;
}>;

export type CandidateIndependentLauncherAttestationStatement = Readonly<{
  format: typeof CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_FORMAT;
  issuerClass: "independent-launcher-node-agent";
  issuerIntegrationStatus:
    typeof CANDIDATE_INDEPENDENT_LAUNCHER_ISSUER_INTEGRATION_STATUS;
  formalReady: false;
  candidate: CandidateIndependentLauncherCandidateIdentity;
  signedManifest: CandidateIndependentLauncherSignedManifest;
  releaseRoot: CandidateIndependentLauncherReleaseRoot;
  nodeRuntime: FormalCandidateNodeRuntimeIdentity;
  runtimeIdentity: CandidateIndependentLauncherRuntimeIdentity;
  processes: Readonly<{
    launcher: CandidateIndependentLauncherObservedProcess;
    application: CandidateIndependentLauncherObservedProcess;
  }>;
  fixedLaunch: CandidateIndependentLauncherFixedLaunch;
  runtime: CandidateIndependentLauncherRuntimeProof;
  session: CandidateIndependentLauncherSessionBinding;
  capturedAt: string;
  expiresAt: string;
  nonce: string;
}>;

export type CandidateIndependentLauncherAttestationObservation = Omit<
  CandidateIndependentLauncherAttestationStatement,
  "format" | "issuerClass" | "issuerIntegrationStatus" | "formalReady"
>;

export type CandidateIndependentLauncherAttestationEnvelope = Readonly<{
  format: typeof CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_ENVELOPE_FORMAT;
  algorithm: typeof CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM;
  canonicalization: typeof CANDIDATE_INDEPENDENT_LAUNCHER_CANONICALIZATION;
  domain: typeof CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_DOMAIN;
  keyId: string;
  publicKeyFingerprintSha256: string;
  statementSha256: string;
  statement: CandidateIndependentLauncherAttestationStatement;
  signatureBase64Url: string;
}>;

export type CandidateIndependentLauncherTrustedKey = Readonly<{
  keyId: string;
  algorithm: typeof CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM;
  publicKeySpkiBase64Url: string;
  publicKeyFingerprintSha256: string;
}>;

export type CandidateIndependentLauncherTrustStore = Readonly<{
  format: typeof CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_STORE_FORMAT;
  issuerClass: "independent-launcher-node-agent";
  keys: readonly CandidateIndependentLauncherTrustedKey[];
}>;

export type CandidateIndependentLauncherAttestationExpectation = Readonly<{
  candidate: CandidateIndependentLauncherCandidateIdentity;
  signedManifest: CandidateIndependentLauncherSignedManifest;
  releaseRoot: CandidateIndependentLauncherReleaseRoot;
  nodeRuntime: FormalCandidateNodeRuntimeIdentity;
  runtimeIdentity: CandidateIndependentLauncherRuntimeIdentity;
  processes: Readonly<{
    launcher: Readonly<{
      pid: number;
      pgid: number;
      startIdentityBinding: string;
      credentials: CandidateIndependentLauncherCredentialProjection;
    }>;
    application: Readonly<{
      pid: number;
      pgid: number;
      startIdentityBinding: string;
      credentials: CandidateIndependentLauncherCredentialProjection;
    }>;
  }>;
  fixedLaunchBinding: string;
  runtime: Readonly<{
    descriptorDigest: string;
    authorityBinding: string;
    challenge: string;
    challengeResponseDigest: string;
  }>;
  session: CandidateIndependentLauncherSessionBinding;
}>;

export type CandidateIndependentLauncherVerifiedAttestation = Readonly<{
  envelope: CandidateIndependentLauncherAttestationEnvelope;
  statement: CandidateIndependentLauncherAttestationStatement;
  keyId: string;
  publicKeyFingerprintSha256: string;
  signatureValid: true;
  expectationBound: true;
  issuerIntegrated: false;
  replayConsumed: false;
  formalReady: false;
  attestationDigest: string;
}>;

export type CandidateIndependentLauncherSignerAuthority = Readonly<{
  keyId: string;
  publicKeyFingerprintSha256: string;
  trustedKey: CandidateIndependentLauncherTrustedKey;
  dispose: () => void;
}>;

export type CandidateIndependentLauncherReplayGuard = Readonly<{
  consume: (
    verified: CandidateIndependentLauncherVerifiedAttestation,
  ) => Readonly<{
    replayConsumed: true;
    keyId: string;
    nonce: string;
    runNonce: string;
    expiresAt: string;
  }>;
}>;

type InternalSignerAuthority = CandidateIndependentLauncherSignerAuthority & {
  signStatement: (statement: CandidateIndependentLauncherAttestationStatement) => Buffer;
};

function parseCandidateIdentity(value: unknown): CandidateIndependentLauncherCandidateIdentity {
  const item = exactRecord(value, [
    "artifactSha256",
    "artifactSignedManifestSha256",
    "artifactUuid",
    "configExpectedSha256",
    "releaseAttestationKeyId",
    "releaseUuid",
    "schemaExpectedSha256",
    "sourceDigest",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID");
  return deepFreeze({
    releaseUuid: patternString(item.releaseUuid, UUID,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID"),
    artifactUuid: patternString(item.artifactUuid, UUID,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID"),
    artifactSha256: patternString(item.artifactSha256, SHA256_HEX,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID"),
    artifactSignedManifestSha256: patternString(
      item.artifactSignedManifestSha256,
      SHA256_HEX,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID",
    ),
    sourceDigest: patternString(item.sourceDigest, SOURCE_DIGEST,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID"),
    schemaExpectedSha256: patternString(item.schemaExpectedSha256, SHA256_HEX,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID"),
    configExpectedSha256: patternString(item.configExpectedSha256, SHA256_HEX,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID"),
    releaseAttestationKeyId: patternString(item.releaseAttestationKeyId, KEY_ID,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CANDIDATE_INVALID"),
  });
}

function parseSignedManifest(value: unknown): CandidateIndependentLauncherSignedManifest {
  const item = exactRecord(value, [
    "attestationKeyId",
    "payloadSha256",
    "signedManifestSha256",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_SIGNED_MANIFEST_INVALID");
  return deepFreeze({
    attestationKeyId: patternString(item.attestationKeyId, KEY_ID,
      "CANDIDATE_INDEPENDENT_LAUNCHER_SIGNED_MANIFEST_INVALID"),
    payloadSha256: patternString(item.payloadSha256, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_SIGNED_MANIFEST_INVALID"),
    signedManifestSha256: patternString(item.signedManifestSha256, SHA256_HEX,
      "CANDIDATE_INDEPENDENT_LAUNCHER_SIGNED_MANIFEST_INVALID"),
  });
}

function parseReleaseRoot(value: unknown): CandidateIndependentLauncherReleaseRoot {
  const item = exactRecord(value, [
    "dev",
    "fullTreeDigest",
    "ino",
    "pathBinding",
    "releaseId",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_RELEASE_ROOT_INVALID");
  return deepFreeze({
    releaseId: patternString(item.releaseId, RELEASE_ID,
      "CANDIDATE_INDEPENDENT_LAUNCHER_RELEASE_ROOT_INVALID"),
    dev: patternString(item.dev, DECIMAL,
      "CANDIDATE_INDEPENDENT_LAUNCHER_RELEASE_ROOT_INVALID"),
    ino: patternString(item.ino, POSITIVE_DECIMAL,
      "CANDIDATE_INDEPENDENT_LAUNCHER_RELEASE_ROOT_INVALID"),
    fullTreeDigest: patternString(item.fullTreeDigest, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_RELEASE_ROOT_INVALID"),
    pathBinding: patternString(item.pathBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_RELEASE_ROOT_INVALID"),
  });
}

function parseFormalNodeRuntime(value: unknown): FormalCandidateNodeRuntimeIdentity {
  const item = exactRecord(value, [
    "byteSize",
    "execArgv",
    "executableRealpath",
    "format",
    "nodeAbi",
    "sha256",
    "version",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_NODE_RUNTIME_INVALID");
  if (
    item.format !== "fanjin-node-runtime-identity/v1"
    || !Array.isArray(item.execArgv)
    || item.execArgv.length > 64
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_NODE_RUNTIME_INVALID");
  const execArgv = item.execArgv.map((entry) => requiredString(
    entry,
    "CANDIDATE_INDEPENDENT_LAUNCHER_NODE_RUNTIME_INVALID",
  ));
  return deepFreeze({
    format: "fanjin-node-runtime-identity/v1",
    executableRealpath: normalizedAbsolutePath(item.executableRealpath,
      "CANDIDATE_INDEPENDENT_LAUNCHER_NODE_RUNTIME_INVALID"),
    byteSize: positiveInteger(item.byteSize,
      "CANDIDATE_INDEPENDENT_LAUNCHER_NODE_RUNTIME_INVALID"),
    sha256: patternString(item.sha256, SHA256_HEX,
      "CANDIDATE_INDEPENDENT_LAUNCHER_NODE_RUNTIME_INVALID"),
    version: requiredString(item.version,
      "CANDIDATE_INDEPENDENT_LAUNCHER_NODE_RUNTIME_INVALID"),
    nodeAbi: patternString(item.nodeAbi, POSITIVE_DECIMAL,
      "CANDIDATE_INDEPENDENT_LAUNCHER_NODE_RUNTIME_INVALID"),
    execArgv: Object.freeze(execArgv),
  });
}

function startIdentityBinding(input: Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  executable: string;
  commandBinding: string;
  argvBinding: string;
  environmentBinding: string;
  startIdentity: Omit<CandidateIndependentLauncherProcessStartIdentity, "binding">;
}>): string {
  return digest({
    domain: `${CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_FORMAT}/process-start`,
    ...input,
  });
}

function parseCredentialIdQuad(
  value: unknown,
): CandidateIndependentLauncherCredentialIdQuad {
  const item = exactRecord(value, [
    "effective", "filesystem", "real", "saved",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID");
  return deepFreeze({
    real: nonnegativeInteger(item.real,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID"),
    effective: nonnegativeInteger(item.effective,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID"),
    saved: nonnegativeInteger(item.saved,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID"),
    filesystem: nonnegativeInteger(item.filesystem,
      "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID"),
  });
}

export function parseCandidateIndependentLauncherCredentialProjection(
  value: unknown,
): CandidateIndependentLauncherCredentialProjection {
  if (!isRecord(value)) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID");
  }
  if (value.platform === "linux") {
    const item = exactRecord(value, [
      "effectiveCapabilitiesHex", "evidenceClass", "gid", "noNewPrivileges",
      "platform", "supplementaryGroups", "uid",
    ], "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID");
    if (
      item.evidenceClass !== "linux-proc-status-complete"
      || typeof item.noNewPrivileges !== "boolean"
      || !Array.isArray(item.supplementaryGroups)
      || item.supplementaryGroups.length > 256
    ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID");
    const supplementaryGroups = item.supplementaryGroups.map((group) => (
      nonnegativeInteger(group,
        "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID")
    ));
    if (
      supplementaryGroups.some((group, index) => (
        index > 0 && group <= supplementaryGroups[index - 1]
      ))
    ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID");
    return deepFreeze({
      evidenceClass: "linux-proc-status-complete",
      platform: "linux",
      uid: parseCredentialIdQuad(item.uid),
      gid: parseCredentialIdQuad(item.gid),
      supplementaryGroups,
      noNewPrivileges: item.noNewPrivileges,
      effectiveCapabilitiesHex: patternString(
        item.effectiveCapabilitiesHex,
        /^[0-9a-f]{16}$/u,
        "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID",
      ),
    });
  }
  if (value.platform === "darwin") {
    const item = exactRecord(value, [
      "evidenceClass", "gid", "platform", "uid",
    ], "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID");
    if (item.evidenceClass !== "darwin-ps-uid-gid-limited") {
      return fail("CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID");
    }
    return deepFreeze({
      evidenceClass: "darwin-ps-uid-gid-limited",
      platform: "darwin",
      uid: nonnegativeInteger(item.uid,
        "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID"),
      gid: nonnegativeInteger(item.gid,
        "CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID"),
    });
  }
  return fail("CANDIDATE_INDEPENDENT_LAUNCHER_CREDENTIALS_INVALID");
}

function parseRuntimeIdentity(
  value: unknown,
): CandidateIndependentLauncherRuntimeIdentity {
  const item = exactRecord(value, ["runtimeGid", "runtimeUid"],
    "CANDIDATE_INDEPENDENT_LAUNCHER_RUNTIME_IDENTITY_INVALID");
  return deepFreeze({
    runtimeUid: positiveInteger(item.runtimeUid,
      "CANDIDATE_INDEPENDENT_LAUNCHER_RUNTIME_IDENTITY_INVALID"),
    runtimeGid: positiveInteger(item.runtimeGid,
      "CANDIDATE_INDEPENDENT_LAUNCHER_RUNTIME_IDENTITY_INVALID"),
  });
}

function credentialProjectionMatchesRuntime(
  projection: CandidateIndependentLauncherCredentialProjection,
  runtime: CandidateIndependentLauncherRuntimeIdentity,
): boolean {
  if (projection.platform === "darwin") {
    return projection.uid === runtime.runtimeUid
      && projection.gid === runtime.runtimeGid;
  }
  return Object.values(projection.uid).every((uid) => uid === runtime.runtimeUid)
    && Object.values(projection.gid).every((gid) => gid === runtime.runtimeGid);
}

function parseObservedProcess(value: unknown): CandidateIndependentLauncherObservedProcess {
  const item = exactRecord(value, [
    "argvBinding",
    "commandBinding",
    "credentials",
    "environmentBinding",
    "executable",
    "pgid",
    "pid",
    "ppid",
    "startIdentity",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID");
  const start = exactRecord(item.startIdentity, [
    "binding",
    "bootIdentity",
    "pidNamespace",
    "source",
    "startEpochMs",
    "startToken",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_INVALID");
  const source = start.source;
  if (
    source !== "linux-proc-start-ticks"
    && source !== "darwin-kernel-start-time"
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_INVALID");
  const bootIdentity = requiredString(start.bootIdentity,
    "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_INVALID");
  const pidNamespace = start.pidNamespace === null
    ? null
    : patternString(start.pidNamespace, PROCESS_NAMESPACE,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_INVALID");
  if (
    (source === "linux-proc-start-ticks" && pidNamespace === null)
    || (source === "darwin-kernel-start-time" && pidNamespace !== null)
    || (source === "linux-proc-start-ticks" && !BOOT_UUID.test(bootIdentity))
    || (source === "darwin-kernel-start-time" && !SHA256_BINDING.test(bootIdentity))
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_INVALID");
  const credentials = parseCandidateIndependentLauncherCredentialProjection(
    item.credentials,
  );
  const base = {
    pid: positiveInteger(item.pid,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID"),
    ppid: nonnegativeInteger(item.ppid,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID"),
    pgid: positiveInteger(item.pgid,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID"),
    executable: normalizedAbsolutePath(item.executable,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID"),
    commandBinding: patternString(item.commandBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID"),
    argvBinding: patternString(item.argvBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID"),
    environmentBinding: patternString(item.environmentBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID"),
    credentials,
  };
  const startWithoutBinding = {
    source,
    bootIdentity,
    pidNamespace,
    startToken: patternString(start.startToken, START_TOKEN,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_INVALID"),
    startEpochMs: positiveInteger(start.startEpochMs,
      "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_INVALID"),
  } as const;
  if (
    source === "linux-proc-start-ticks"
    && !POSITIVE_DECIMAL.test(startWithoutBinding.startToken)
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_INVALID");
  const expectedBinding = startIdentityBinding({
    ...base,
    startIdentity: startWithoutBinding,
  });
  if (start.binding !== expectedBinding) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_START_BINDING_INVALID");
  }
  return deepFreeze({
    ...base,
    credentials,
    startIdentity: { ...startWithoutBinding, binding: expectedBinding },
  });
}

function parseFixedCommand(value: unknown): CandidateIndependentLauncherFixedCommand {
  const item = exactRecord(value, [
    "argvBinding",
    "cwd",
    "environmentBinding",
    "executable",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_FIXED_LAUNCH_INVALID");
  return deepFreeze({
    executable: normalizedAbsolutePath(item.executable,
      "CANDIDATE_INDEPENDENT_LAUNCHER_FIXED_LAUNCH_INVALID"),
    cwd: normalizedAbsolutePath(item.cwd,
      "CANDIDATE_INDEPENDENT_LAUNCHER_FIXED_LAUNCH_INVALID"),
    argvBinding: patternString(item.argvBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_FIXED_LAUNCH_INVALID"),
    environmentBinding: patternString(item.environmentBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_FIXED_LAUNCH_INVALID"),
  });
}

function fixedLaunchBinding(input: Readonly<{
  launcher: CandidateIndependentLauncherFixedCommand;
  application: CandidateIndependentLauncherFixedCommand;
}>): string {
  return digest({
    domain: `${CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_FORMAT}/fixed-launch`,
    ...input,
  });
}

function parseFixedLaunch(value: unknown): CandidateIndependentLauncherFixedLaunch {
  const item = exactRecord(value, [
    "application",
    "binding",
    "launcher",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_FIXED_LAUNCH_INVALID");
  const commands = {
    launcher: parseFixedCommand(item.launcher),
    application: parseFixedCommand(item.application),
  };
  const expected = fixedLaunchBinding(commands);
  if (item.binding !== expected) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_FIXED_LAUNCH_BINDING_INVALID");
  }
  return deepFreeze({ ...commands, binding: expected });
}

function parseRuntimeProof(value: unknown): CandidateIndependentLauncherRuntimeProof {
  const item = exactRecord(value, [
    "authorityBinding",
    "challenge",
    "challengeResponse",
    "challengeResponseDigest",
    "descriptor",
    "descriptorDigest",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_RUNTIME_INVALID");
  let descriptor: CandidateRuntimeAttestationDescriptor;
  let response: CandidateRuntimeChallengeResponse;
  const descriptorValue = cloneJsonData(item.descriptor);
  try {
    descriptor = assertCandidateRuntimeAttestationDescriptor(descriptorValue);
    response = assertCandidateRuntimeChallengeResponse({
      descriptor,
      challenge: canonicalBase64Url(item.challenge, BASE64URL_32_BYTES, 32,
        "CANDIDATE_INDEPENDENT_LAUNCHER_RUNTIME_INVALID"),
      response: cloneJsonData(item.challengeResponse),
    });
  } catch {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_RUNTIME_INVALID");
  }
  const descriptorDigest = digest(descriptor);
  const challengeResponseDigest = digest(response);
  if (
    item.descriptorDigest !== descriptorDigest
    || item.authorityBinding !== descriptor.authorityBinding
    || item.challengeResponseDigest !== challengeResponseDigest
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_RUNTIME_BINDING_INVALID");
  return deepFreeze({
    descriptor,
    descriptorDigest,
    authorityBinding: descriptor.authorityBinding,
    challenge: String(item.challenge),
    challengeResponse: response,
    challengeResponseDigest,
  });
}

function parseSession(value: unknown): CandidateIndependentLauncherSessionBinding {
  const item = exactRecord(value, [
    "checkpointBinding",
    "runNonce",
    "sessionBinding",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_SESSION_INVALID");
  return deepFreeze({
    sessionBinding: patternString(item.sessionBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_SESSION_INVALID"),
    checkpointBinding: canonicalBase64Url(
      item.checkpointBinding,
      BASE64URL_32_BYTES,
      32,
      "CANDIDATE_INDEPENDENT_LAUNCHER_SESSION_INVALID"),
    runNonce: canonicalBase64Url(item.runNonce, BASE64URL_32_BYTES, 32,
      "CANDIDATE_INDEPENDENT_LAUNCHER_SESSION_INVALID"),
  });
}

function parseStatement(value: unknown): CandidateIndependentLauncherAttestationStatement {
  const item = exactRecord(value, [
    "candidate",
    "capturedAt",
    "expiresAt",
    "fixedLaunch",
    "formalReady",
    "format",
    "issuerClass",
    "issuerIntegrationStatus",
    "nodeRuntime",
    "nonce",
    "processes",
    "releaseRoot",
    "runtime",
    "runtimeIdentity",
    "session",
    "signedManifest",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_STATEMENT_INVALID");
  if (
    item.format !== CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_FORMAT
    || item.issuerClass !== "independent-launcher-node-agent"
    || item.issuerIntegrationStatus
      !== CANDIDATE_INDEPENDENT_LAUNCHER_ISSUER_INTEGRATION_STATUS
    || item.formalReady !== false
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_STATEMENT_INVALID");
  const processes = exactRecord(item.processes, ["application", "launcher"],
    "CANDIDATE_INDEPENDENT_LAUNCHER_PROCESS_INVALID");
  const candidate = parseCandidateIdentity(item.candidate);
  const signedManifest = parseSignedManifest(item.signedManifest);
  const releaseRoot = parseReleaseRoot(item.releaseRoot);
  const nodeRuntime = parseFormalNodeRuntime(item.nodeRuntime);
  const runtimeIdentity = parseRuntimeIdentity(item.runtimeIdentity);
  const launcher = parseObservedProcess(processes.launcher);
  const application = parseObservedProcess(processes.application);
  const fixedLaunch = parseFixedLaunch(item.fixedLaunch);
  const runtime = parseRuntimeProof(item.runtime);
  const session = parseSession(item.session);
  const capturedAt = exactIso(item.capturedAt,
    "CANDIDATE_INDEPENDENT_LAUNCHER_TIME_INVALID");
  const expiresAt = exactIso(item.expiresAt,
    "CANDIDATE_INDEPENDENT_LAUNCHER_TIME_INVALID");
  const nonce = canonicalBase64Url(item.nonce, BASE64URL_32_BYTES, 32,
    "CANDIDATE_INDEPENDENT_LAUNCHER_NONCE_INVALID");
  const capturedAtMs = Date.parse(capturedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (
    expiresAtMs <= capturedAtMs
    || expiresAtMs - capturedAtMs
      > CANDIDATE_INDEPENDENT_LAUNCHER_MAX_LIFETIME_MS
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_LIFETIME_INVALID");
  if (
    nonce === session.runNonce
    || runtime.challenge === nonce
    || runtime.challenge === session.runNonce
    || candidate.releaseAttestationKeyId !== signedManifest.attestationKeyId
    || candidate.artifactSignedManifestSha256
      !== signedManifest.signedManifestSha256
    || launcher.pid === application.pid
    || launcher.credentials.platform !== application.credentials.platform
    || (launcher.credentials.platform === "linux"
      && launcher.startIdentity.source !== "linux-proc-start-ticks")
    || (launcher.credentials.platform === "darwin"
      && launcher.startIdentity.source !== "darwin-kernel-start-time")
    || candidateIndependentLauncherCanonicalJson(launcher.credentials)
      !== candidateIndependentLauncherCanonicalJson(application.credentials)
    || !credentialProjectionMatchesRuntime(
      launcher.credentials,
      runtimeIdentity,
    )
    || !credentialProjectionMatchesRuntime(
      application.credentials,
      runtimeIdentity,
    )
    || launcher.pgid !== launcher.pid
    || application.ppid !== launcher.pid
    || application.pgid !== launcher.pgid
    || launcher.startIdentity.startEpochMs > application.startIdentity.startEpochMs
    || application.startIdentity.startEpochMs > capturedAtMs
    || launcher.executable !== nodeRuntime.executableRealpath
    || application.executable !== nodeRuntime.executableRealpath
    || fixedLaunch.launcher.executable !== launcher.executable
    || fixedLaunch.application.executable !== application.executable
    || fixedLaunch.launcher.argvBinding !== launcher.argvBinding
    || fixedLaunch.application.argvBinding !== application.argvBinding
    || fixedLaunch.launcher.environmentBinding !== launcher.environmentBinding
    || fixedLaunch.application.environmentBinding !== application.environmentBinding
    || runtime.descriptor.apiPid !== application.pid
    || Math.abs(
      Date.parse(runtime.descriptor.apiProcessStartedAt)
        - application.startIdentity.startEpochMs,
    ) > 2_000
    || Date.parse(runtime.descriptor.apiProcessStartedAt)
      > Date.parse(runtime.descriptor.createdAt)
    || Date.parse(runtime.descriptor.createdAt) > capturedAtMs
    || runtime.descriptor.sessionBinding !== session.sessionBinding
    || runtime.descriptor.checkpointBinding !== session.checkpointBinding
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_CROSS_BINDING_INVALID");
  return deepFreeze({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_FORMAT,
    issuerClass: "independent-launcher-node-agent",
    issuerIntegrationStatus:
      CANDIDATE_INDEPENDENT_LAUNCHER_ISSUER_INTEGRATION_STATUS,
    formalReady: false,
    candidate,
    signedManifest,
    releaseRoot,
    nodeRuntime,
    runtimeIdentity,
    processes: { launcher, application },
    fixedLaunch,
    runtime,
    session,
    capturedAt,
    expiresAt,
    nonce,
  });
}

function statementFromObservation(
  observation: CandidateIndependentLauncherAttestationObservation,
): CandidateIndependentLauncherAttestationStatement {
  const input = exactRecord(observation, [
    "candidate",
    "capturedAt",
    "expiresAt",
    "fixedLaunch",
    "nodeRuntime",
    "nonce",
    "processes",
    "releaseRoot",
    "runtime",
    "runtimeIdentity",
    "session",
    "signedManifest",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_OBSERVATION_INVALID");
  return parseStatement({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_FORMAT,
    issuerClass: "independent-launcher-node-agent",
    issuerIntegrationStatus:
      CANDIDATE_INDEPENDENT_LAUNCHER_ISSUER_INTEGRATION_STATUS,
    formalReady: false,
    ...input,
  });
}

function importEd25519PublicKey(value: unknown, code: string): {
  key: KeyObject;
  spkiBase64Url: string;
  fingerprint: string;
} {
  const encoded = patternString(value, BASE64URL, code);
  let bytes: Buffer;
  let key: KeyObject;
  try {
    bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded || bytes.byteLength !== 44) {
      return fail(code);
    }
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    return fail(code);
  }
  if (key.asymmetricKeyType !== "ed25519") return fail(code);
  const normalized = Buffer.from(key.export({ format: "der", type: "spki" }));
  if (
    normalized.byteLength !== bytes.byteLength
    || !timingSafeEqual(normalized, bytes)
  ) return fail(code);
  return { key, spkiBase64Url: encoded, fingerprint: sha256(bytes) };
}

function signaturePayload(statement: CandidateIndependentLauncherAttestationStatement): Buffer {
  return Buffer.concat([
    SIGNATURE_PREFIX,
    Buffer.from(canonicalJson(statement), "utf8"),
  ]);
}

export function createCandidateIndependentLauncherSignerAuthority(input: Readonly<{
  keyId: string;
  privateKey: KeyObject;
}>): CandidateIndependentLauncherSignerAuthority {
  const keyId = patternString(input.keyId, KEY_ID,
    "CANDIDATE_INDEPENDENT_LAUNCHER_SIGNER_INVALID");
  if (
    keyId.startsWith("dev-local-only-")
    || input.privateKey.type !== "private"
    || input.privateKey.asymmetricKeyType !== "ed25519"
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNER_INVALID");
  let privateKey: KeyObject | undefined = input.privateKey;
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(input.privateKey);
  } catch {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNER_INVALID");
  }
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  if (spki.byteLength !== 44) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNER_INVALID");
  }
  const publicKeyFingerprintSha256 = sha256(spki);
  const trustedKey = deepFreeze({
    keyId,
    algorithm: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM,
    publicKeySpkiBase64Url: spki.toString("base64url"),
    publicKeyFingerprintSha256,
  });
  const authority: InternalSignerAuthority = Object.freeze({
    keyId,
    publicKeyFingerprintSha256,
    trustedKey,
    signStatement(statement): Buffer {
      if (!privateKey) {
        return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNER_DISPOSED");
      }
      let signature: Buffer;
      try {
        signature = sign(null, signaturePayload(statement), privateKey);
      } catch {
        return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNING_FAILED");
      }
      if (signature.byteLength !== 64) {
        return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNING_FAILED");
      }
      return signature;
    },
    dispose(): void {
      privateKey = undefined;
    },
  });
  issuedSignerAuthorities.add(authority);
  return authority;
}

export function issueCandidateIndependentLauncherAttestation(input: Readonly<{
  signer: CandidateIndependentLauncherSignerAuthority;
  observation: CandidateIndependentLauncherAttestationObservation;
}>): CandidateIndependentLauncherAttestationEnvelope {
  if (!issuedSignerAuthorities.has(input.signer)) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNER_INVALID");
  }
  const signer = input.signer as InternalSignerAuthority;
  const statement = statementFromObservation(input.observation);
  const signature = signer.signStatement(statement);
  return deepFreeze({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_ENVELOPE_FORMAT,
    algorithm: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM,
    canonicalization: CANDIDATE_INDEPENDENT_LAUNCHER_CANONICALIZATION,
    domain: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_DOMAIN,
    keyId: signer.keyId,
    publicKeyFingerprintSha256: signer.publicKeyFingerprintSha256,
    statementSha256: sha256(canonicalJson(statement)),
    statement,
    signatureBase64Url: signature.toString("base64url"),
  });
}

function parseEnvelope(value: unknown): CandidateIndependentLauncherAttestationEnvelope {
  const item = exactRecord(value, [
    "algorithm",
    "canonicalization",
    "domain",
    "format",
    "keyId",
    "publicKeyFingerprintSha256",
    "signatureBase64Url",
    "statement",
    "statementSha256",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_ENVELOPE_INVALID");
  if (
    item.format !== CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_ENVELOPE_FORMAT
    || item.algorithm !== CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM
    || item.canonicalization !== CANDIDATE_INDEPENDENT_LAUNCHER_CANONICALIZATION
    || item.domain !== CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_DOMAIN
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_ENVELOPE_INVALID");
  const statement = parseStatement(item.statement);
  const statementSha256 = sha256(canonicalJson(statement));
  if (item.statementSha256 !== statementSha256) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_STATEMENT_DIGEST_INVALID");
  }
  return deepFreeze({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_ENVELOPE_FORMAT,
    algorithm: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM,
    canonicalization: CANDIDATE_INDEPENDENT_LAUNCHER_CANONICALIZATION,
    domain: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_DOMAIN,
    keyId: patternString(item.keyId, KEY_ID,
      "CANDIDATE_INDEPENDENT_LAUNCHER_ENVELOPE_INVALID"),
    publicKeyFingerprintSha256: patternString(
      item.publicKeyFingerprintSha256,
      SHA256_HEX,
      "CANDIDATE_INDEPENDENT_LAUNCHER_ENVELOPE_INVALID",
    ),
    statementSha256,
    statement,
    signatureBase64Url: canonicalBase64Url(
      item.signatureBase64Url,
      BASE64URL_SIGNATURE,
      64,
      "CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_INVALID",
    ),
  });
}

export function renderCandidateIndependentLauncherAttestation(
  envelope: CandidateIndependentLauncherAttestationEnvelope,
): string {
  return `${canonicalJson(parseEnvelope(envelope))}\n`;
}

export function parseCandidateIndependentLauncherAttestation(
  bytes: Buffer | string,
): CandidateIndependentLauncherAttestationEnvelope {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  if (
    !Buffer.isBuffer(buffer)
    || buffer.byteLength < 2
    || buffer.byteLength > CANDIDATE_INDEPENDENT_LAUNCHER_MAX_ENVELOPE_BYTES
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SERIALIZATION_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SERIALIZATION_INVALID");
  }
  const envelope = parseEnvelope(parsed);
  if (`${canonicalJson(envelope)}\n` !== buffer.toString("utf8")) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SERIALIZATION_NON_CANONICAL");
  }
  return envelope;
}

function parseTrustedKey(value: unknown): CandidateIndependentLauncherTrustedKey {
  const item = exactRecord(value, [
    "algorithm",
    "keyId",
    "publicKeyFingerprintSha256",
    "publicKeySpkiBase64Url",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_KEY_INVALID");
  const keyId = patternString(item.keyId, KEY_ID,
    "CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_KEY_INVALID");
  if (
    keyId.startsWith("dev-local-only-")
    || item.algorithm !== CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_KEY_INVALID");
  const imported = importEd25519PublicKey(
    item.publicKeySpkiBase64Url,
    "CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_KEY_INVALID",
  );
  if (item.publicKeyFingerprintSha256 !== imported.fingerprint) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_KEY_INVALID");
  }
  return deepFreeze({
    keyId,
    algorithm: CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_ALGORITHM,
    publicKeySpkiBase64Url: imported.spkiBase64Url,
    publicKeyFingerprintSha256: imported.fingerprint,
  });
}

function parseTrustStore(value: unknown): CandidateIndependentLauncherTrustStore {
  const item = exactRecord(value, ["format", "issuerClass", "keys"],
    "CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_STORE_INVALID");
  if (
    item.format !== CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_STORE_FORMAT
    || item.issuerClass !== "independent-launcher-node-agent"
    || !Array.isArray(item.keys)
    || item.keys.length < 1
    || item.keys.length > 32
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_STORE_INVALID");
  const keys = item.keys.map(parseTrustedKey);
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_STORE_INVALID");
  }
  return deepFreeze({
    format: CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_STORE_FORMAT,
    issuerClass: "independent-launcher-node-agent",
    keys,
  });
}

function processExpectation(value: unknown): {
  pid: number;
  pgid: number;
  startIdentityBinding: string;
  credentials: CandidateIndependentLauncherCredentialProjection;
} {
  const item = exactRecord(value, [
    "credentials", "pgid", "pid", "startIdentityBinding",
  ],
    "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID");
  return {
    pid: positiveInteger(item.pid,
      "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID"),
    pgid: positiveInteger(item.pgid,
      "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID"),
    startIdentityBinding: patternString(item.startIdentityBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID"),
    credentials: parseCandidateIndependentLauncherCredentialProjection(
      item.credentials,
    ),
  };
}

function parseExpectation(
  value: unknown,
): CandidateIndependentLauncherAttestationExpectation {
  const item = exactRecord(value, [
    "candidate",
    "fixedLaunchBinding",
    "nodeRuntime",
    "processes",
    "releaseRoot",
    "runtime",
    "runtimeIdentity",
    "session",
    "signedManifest",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID");
  const processes = exactRecord(item.processes, ["application", "launcher"],
    "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID");
  const runtime = exactRecord(item.runtime, [
    "authorityBinding",
    "challenge",
    "challengeResponseDigest",
    "descriptorDigest",
  ], "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID");
  return deepFreeze({
    candidate: parseCandidateIdentity(item.candidate),
    signedManifest: parseSignedManifest(item.signedManifest),
    releaseRoot: parseReleaseRoot(item.releaseRoot),
    nodeRuntime: parseFormalNodeRuntime(item.nodeRuntime),
    runtimeIdentity: parseRuntimeIdentity(item.runtimeIdentity),
    processes: {
      launcher: processExpectation(processes.launcher),
      application: processExpectation(processes.application),
    },
    fixedLaunchBinding: patternString(item.fixedLaunchBinding, SHA256_BINDING,
      "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID"),
    runtime: {
      descriptorDigest: patternString(runtime.descriptorDigest, SHA256_BINDING,
        "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID"),
      authorityBinding: patternString(runtime.authorityBinding, SHA256_BINDING,
        "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID"),
      challenge: canonicalBase64Url(runtime.challenge, BASE64URL_32_BYTES, 32,
        "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID"),
      challengeResponseDigest: patternString(
        runtime.challengeResponseDigest,
        SHA256_BINDING,
        "CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_INVALID",
      ),
    },
    session: parseSession(item.session),
  });
}

function expectationProjectionFromStatement(
  statement: CandidateIndependentLauncherAttestationStatement,
): CandidateIndependentLauncherAttestationExpectation {
  const parsed = parseStatement(statement);
  return deepFreeze({
    candidate: parsed.candidate,
    signedManifest: parsed.signedManifest,
    releaseRoot: parsed.releaseRoot,
    nodeRuntime: parsed.nodeRuntime,
    runtimeIdentity: parsed.runtimeIdentity,
    processes: {
      launcher: {
        pid: parsed.processes.launcher.pid,
        pgid: parsed.processes.launcher.pgid,
        startIdentityBinding: parsed.processes.launcher.startIdentity.binding,
        credentials: parsed.processes.launcher.credentials,
      },
      application: {
        pid: parsed.processes.application.pid,
        pgid: parsed.processes.application.pgid,
        startIdentityBinding: parsed.processes.application.startIdentity.binding,
        credentials: parsed.processes.application.credentials,
      },
    },
    fixedLaunchBinding: parsed.fixedLaunch.binding,
    runtime: {
      descriptorDigest: parsed.runtime.descriptorDigest,
      authorityBinding: parsed.runtime.authorityBinding,
      challenge: parsed.runtime.challenge,
      challengeResponseDigest: parsed.runtime.challengeResponseDigest,
    },
    session: parsed.session,
  });
}

/**
 * Builds the exact verifier expectation directly from raw independently
 * observed facts. No signed envelope is accepted as input, so callers cannot
 * accidentally derive the expectation from the claim being verified.
 */
export function candidateIndependentLauncherExpectationFromObservation(
  observation: CandidateIndependentLauncherAttestationObservation,
): CandidateIndependentLauncherAttestationExpectation {
  return expectationProjectionFromStatement(
    statementFromObservation(observation),
  );
}

function assertExpectation(
  statement: CandidateIndependentLauncherAttestationStatement,
  expectationValue: unknown,
): void {
  const expectation = parseExpectation(expectationValue);
  const actual = expectationProjectionFromStatement(statement);
  if (canonicalJson(actual) !== canonicalJson(expectation)) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_EXPECTATION_MISMATCH");
  }
}

export function verifyCandidateIndependentLauncherAttestation(input: Readonly<{
  envelope: unknown;
  trustStore: CandidateIndependentLauncherTrustStore;
  expectation: CandidateIndependentLauncherAttestationExpectation;
  now?: number;
}>): CandidateIndependentLauncherVerifiedAttestation {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_TIME_INVALID");
  }
  const envelope = parseEnvelope(input.envelope);
  const trustStore = parseTrustStore(input.trustStore);
  const trusted = trustStore.keys.find((key) => key.keyId === envelope.keyId);
  if (!trusted) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_KEY_UNTRUSTED");
  if (
    trusted.publicKeyFingerprintSha256
      !== envelope.publicKeyFingerprintSha256
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_KEY_MISMATCH");
  const imported = importEd25519PublicKey(
    trusted.publicKeySpkiBase64Url,
    "CANDIDATE_INDEPENDENT_LAUNCHER_TRUST_KEY_INVALID",
  );
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signatureBase64Url, "base64url");
  } catch {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_INVALID");
  }
  if (
    signature.byteLength !== 64
    || !verify(
      null,
      signaturePayload(envelope.statement),
      imported.key,
      signature,
    )
  ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_SIGNATURE_INVALID");
  const capturedAt = Date.parse(envelope.statement.capturedAt);
  const expiresAt = Date.parse(envelope.statement.expiresAt);
  if (now < capturedAt || now >= expiresAt) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_EXPIRED");
  }
  assertExpectation(envelope.statement, input.expectation);
  const verified = deepFreeze({
    envelope,
    statement: envelope.statement,
    keyId: envelope.keyId,
    publicKeyFingerprintSha256: envelope.publicKeyFingerprintSha256,
    signatureValid: true as const,
    expectationBound: true as const,
    issuerIntegrated: false as const,
    replayConsumed: false as const,
    formalReady: false as const,
    attestationDigest: digest(envelope),
  });
  issuedVerifiedAttestations.add(verified);
  return verified;
}

/**
 * Optional one-shot consumption fence. Verification intentionally remains
 * idempotent because compiler/serialization/dispatch boundaries must recheck
 * the same signature. The runner/guard layer must retain this capability for
 * the lifetime of an execution and consume immediately before launch.
 */
export function createCandidateIndependentLauncherReplayGuard(
  options: Readonly<{ now?: () => number }> = {},
): CandidateIndependentLauncherReplayGuard {
  const consumed = new Set<string>();
  const guard: CandidateIndependentLauncherReplayGuard = Object.freeze({
    consume(verified) {
      if (
        !verified
        || !issuedVerifiedAttestations.has(verified)
        || verified.signatureValid !== true
        || verified.expectationBound !== true
        || verified.formalReady !== false
      ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_REPLAY_GUARD_INPUT_INVALID");
      const statement = parseStatement(verified.statement);
      const now = (options.now ?? Date.now)();
      if (
        !Number.isFinite(now)
        || now < Date.parse(statement.capturedAt)
        || now >= Date.parse(statement.expiresAt)
      ) return fail("CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_EXPIRED");
      const identity = [
        verified.keyId,
        statement.candidate.releaseUuid,
        statement.candidate.artifactUuid,
        statement.session.sessionBinding,
        statement.session.checkpointBinding,
        statement.session.runNonce,
      ].join("\0");
      if (consumed.has(identity)) {
        return fail("CANDIDATE_INDEPENDENT_LAUNCHER_ATTESTATION_REPLAYED");
      }
      consumed.add(identity);
      return deepFreeze({
        replayConsumed: true as const,
        keyId: verified.keyId,
        nonce: statement.nonce,
        runNonce: statement.session.runNonce,
        expiresAt: statement.expiresAt,
      });
    },
  });
  issuedReplayGuards.add(guard);
  return guard;
}

export function consumeCandidateIndependentLauncherAttestation(input: Readonly<{
  guard: CandidateIndependentLauncherReplayGuard;
  verified: CandidateIndependentLauncherVerifiedAttestation;
}>): ReturnType<CandidateIndependentLauncherReplayGuard["consume"]> {
  if (!issuedReplayGuards.has(input.guard)) {
    return fail("CANDIDATE_INDEPENDENT_LAUNCHER_REPLAY_GUARD_INVALID");
  }
  return input.guard.consume(input.verified);
}

export function candidateIndependentLauncherProcessStartBinding(
  input: Omit<CandidateIndependentLauncherObservedProcess, "startIdentity"> & {
    startIdentity: Omit<CandidateIndependentLauncherProcessStartIdentity, "binding">;
  },
): string {
  return startIdentityBinding(input);
}

export function candidateIndependentLauncherFixedLaunchBinding(input: Readonly<{
  launcher: CandidateIndependentLauncherFixedCommand;
  application: CandidateIndependentLauncherFixedCommand;
}>): string {
  return fixedLaunchBinding(input);
}

export function candidateIndependentLauncherValueDigest(value: unknown): string {
  return digest(cloneJsonData(value));
}
