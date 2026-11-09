import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT,
  RELEASE_CANDIDATE_FREEZE_FORMAT,
  RELEASE_CANDIDATE_FREEZE_RESULT_FORMAT,
  RELEASE_CANDIDATE_FREEZE_VERSION,
  RELEASE_CANDIDATE_SCHEMA_EXPECTATION_FORMAT,
  canonicalReleaseCandidateFreezeJson,
  renderReleaseCandidateFreezeResult,
  type ReleaseCandidateFreezeReadyResult,
} from "./release-candidate-freeze";

export const RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT =
  "fanjin-release-candidate-session-identity/v1" as const;
export const FORMAL_RELEASE_CANDIDATE_PRELAUNCH_EVIDENCE_CLASS =
  "formal-production-prelaunch-trust-bound" as const;
export const BOUNDED_SOURCE_CORRELATION_EVIDENCE_CLASS =
  "bounded-source-config-schema-correlation" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_DIGEST_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_FREEZE_RECEIPT_BYTES = 64 * 1024;

export class ReleaseCandidateSessionIdentityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ReleaseCandidateSessionIdentityError";
    this.code = code;
  }
}

export type DevReleaseCandidateSessionIdentity = {
  format: typeof RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT;
  evidenceClass: "dev-local-only-contract-fixture";
  formalB0Eligible: false;
  runtimeArtifactBindingVerified: false;
  freezeReceiptDigest: string;
  freezeSha256: string;
  releaseUuid: string;
  artifactUuid: string;
  artifactSha256: string;
  artifactSignedManifestSha256: string;
  sourceDigest: string;
  configExpectedSha256: string;
  schemaExpectedSha256: string;
  attestationKeyId: string;
};

/** Artifact-agnostic identity emitted by the zero-paid bounded source step. */
export type BoundedSourceCorrelationIdentity = {
  format: typeof RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT;
  evidenceClass: typeof BOUNDED_SOURCE_CORRELATION_EVIDENCE_CLASS;
  formalB0Eligible: false;
  runtimeArtifactBindingVerified: false;
  freezeReceiptDigest: string;
  sourceDigest: string;
  configExpectedSha256: string;
  schemaExpectedSha256: string;
};

/**
 * A root-materialized, production-key candidate correlation identity.
 *
 * This is deliberately *not* a runtime proof: the signed release tree has not
 * been executed yet, so neither formal B0 eligibility nor runtime artifact
 * binding is claimed here.  Those claims are issued only after the independent
 * launcher re-verifies and executes the read-only release root.
 */
export type FormalReleaseCandidatePrelaunchSessionIdentity = {
  format: typeof RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT;
  evidenceClass: typeof FORMAL_RELEASE_CANDIDATE_PRELAUNCH_EVIDENCE_CLASS;
  formalB0Eligible: false;
  runtimeArtifactBindingVerified: false;
  freezeReceiptDigest: string;
  freezeSha256: string;
  releaseUuid: string;
  artifactUuid: string;
  artifactSha256: string;
  artifactSignedManifestSha256: string;
  sourceDigest: string;
  configExpectedSha256: string;
  schemaExpectedSha256: string;
  attestationKeyId: string;
};

export type ReleaseCandidateSessionIdentity =
  | DevReleaseCandidateSessionIdentity
  | FormalReleaseCandidatePrelaunchSessionIdentity;

function fail(code: string): never {
  throw new ReleaseCandidateSessionIdentityError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function protectedReceiptBytes(filePath: string): Buffer {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_PATH_INVALID");
  }
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath);
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.size < 2
      || before.size > MAX_FREEZE_RECEIPT_BYTES
      || (before.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_FILE_UNSAFE");
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_FILE_CHANGED");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || bytes.byteLength !== opened.size
    ) {
      fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_FILE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof ReleaseCandidateSessionIdentityError) throw error;
    return fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_READ_FAILED");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function normalizeReadyFreeze(value: unknown): ReleaseCandidateFreezeReadyResult {
  if (!isRecord(value) || !exactKeys(value, [
    "format",
    "freeze",
    "freezeSha256",
    "status",
  ])) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_INVALID");
  }
  if (
    value.format !== RELEASE_CANDIDATE_FREEZE_RESULT_FORMAT
    || value.status !== "ready"
    || !SHA256_PATTERN.test(String(value.freezeSha256 ?? ""))
    || !isRecord(value.freeze)
  ) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_NOT_READY");
  }
  const freeze = value.freeze;
  if (!exactKeys(freeze, [
    "artifactSha256",
    "artifactSignedManifestSha256",
    "artifactSize",
    "artifactUuid",
    "attestationKeyId",
    "candidateVersion",
    "configExpectationFormat",
    "configExpectedSha256",
    "format",
    "releaseUuid",
    "schemaExpectationFormat",
    "schemaExpectedSha256",
    "sourceDigest",
  ])) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_INVALID");
  }
  if (
    freeze.format !== RELEASE_CANDIDATE_FREEZE_FORMAT
    || freeze.candidateVersion !== RELEASE_CANDIDATE_FREEZE_VERSION
    || freeze.configExpectationFormat !== RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT
    || freeze.schemaExpectationFormat !== RELEASE_CANDIDATE_SCHEMA_EXPECTATION_FORMAT
    || !UUID_PATTERN.test(String(freeze.releaseUuid ?? ""))
    || !UUID_PATTERN.test(String(freeze.artifactUuid ?? ""))
    || !SHA256_PATTERN.test(String(freeze.artifactSha256 ?? ""))
    || !SHA256_PATTERN.test(String(freeze.artifactSignedManifestSha256 ?? ""))
    || !SHA256_PATTERN.test(String(freeze.configExpectedSha256 ?? ""))
    || !SHA256_PATTERN.test(String(freeze.schemaExpectedSha256 ?? ""))
    || !SOURCE_DIGEST_PATTERN.test(String(freeze.sourceDigest ?? ""))
    || !KEY_ID_PATTERN.test(String(freeze.attestationKeyId ?? ""))
    || !Number.isSafeInteger(freeze.artifactSize)
    || Number(freeze.artifactSize) < 1
    || sha256(canonicalReleaseCandidateFreezeJson(freeze)) !== value.freezeSha256
  ) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_INVALID");
  }
  return value as unknown as ReleaseCandidateFreezeReadyResult;
}

export function releaseCandidateSessionIdentityFromFreezeReceipt(
  filePath: string,
  options: { formalOnly?: boolean } = {},
): ReleaseCandidateSessionIdentity {
  const bytes = protectedReceiptBytes(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_INVALID");
  }
  const ready = normalizeReadyFreeze(parsed);
  if (renderReleaseCandidateFreezeResult(ready) !== bytes.toString("utf8")) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_NON_CANONICAL");
  }
  const localOnly = ready.freeze.attestationKeyId.startsWith("dev-local-only-");
  // A canonical, internally self-consistent freeze receipt is not itself
  // signed. Its keyId is only a claim and therefore cannot establish formal
  // trust. A future formal path must pass a separately verified trust proof
  // that binds the exact receipt digest; no such proof is accepted here.
  if (options.formalOnly) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_FORMAL_TRUST_PROOF_REQUIRED");
  }
  if (!localOnly) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_SIGNER_UNTRUSTED");
  }
  return {
    format: RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT,
    evidenceClass: "dev-local-only-contract-fixture",
    formalB0Eligible: false,
    // This helper binds a receipt to a source-run session. It never claims the
    // launcher executed the read-only unpacked artifact itself.
    runtimeArtifactBindingVerified: false,
    freezeReceiptDigest: sha256(bytes),
    freezeSha256: ready.freezeSha256,
    releaseUuid: ready.freeze.releaseUuid,
    artifactUuid: ready.freeze.artifactUuid,
    artifactSha256: ready.freeze.artifactSha256,
    artifactSignedManifestSha256: ready.freeze.artifactSignedManifestSha256,
    sourceDigest: ready.freeze.sourceDigest,
    configExpectedSha256: ready.freeze.configExpectedSha256,
    schemaExpectedSha256: ready.freeze.schemaExpectedSha256,
    attestationKeyId: ready.freeze.attestationKeyId,
  };
}

/**
 * Projects any canonical ready receipt into an explicitly untrusted,
 * artifact-agnostic source correlation. Production trust and artifact binding
 * are re-established independently by the materializer.
 */
export function boundedSourceCorrelationIdentityFromFreezeReceipt(
  filePath: string,
): BoundedSourceCorrelationIdentity {
  const bytes = protectedReceiptBytes(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_INVALID");
  }
  const ready = normalizeReadyFreeze(parsed);
  if (renderReleaseCandidateFreezeResult(ready) !== bytes.toString("utf8")) {
    fail("RELEASE_CANDIDATE_FREEZE_RECEIPT_NON_CANONICAL");
  }
  return Object.freeze({
    format: RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT,
    evidenceClass: BOUNDED_SOURCE_CORRELATION_EVIDENCE_CLASS,
    formalB0Eligible: false,
    runtimeArtifactBindingVerified: false,
    freezeReceiptDigest: sha256(bytes),
    sourceDigest: ready.freeze.sourceDigest,
    configExpectedSha256: ready.freeze.configExpectedSha256,
    schemaExpectedSha256: ready.freeze.schemaExpectedSha256,
  });
}

/**
 * Projects a freshly verified production freeze into a prelaunch session
 * identity.  The caller must supply the digest of the exact canonical freeze
 * receipt it compared with `verifiedFreeze`; this helper validates shape and
 * refuses development keys, but does not treat the unsigned receipt as a
 * trust proof.  The production materializer supplies a fresh
 * `createReleaseCandidateFreeze(...)` result after verifying artifact-ready,
 * sidecar, config expectation and the trusted key store.
 */
export function formalReleaseCandidateSessionIdentityFromVerifiedFreeze(
  verifiedFreeze: ReleaseCandidateFreezeReadyResult,
  freezeReceiptDigest: string,
): FormalReleaseCandidatePrelaunchSessionIdentity {
  const ready = normalizeReadyFreeze(verifiedFreeze);
  if (
    !SHA256_PATTERN.test(freezeReceiptDigest)
    || ready.freeze.attestationKeyId.startsWith("dev-local-only-")
  ) {
    fail("RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAL_TRUST_INVALID");
  }
  return Object.freeze({
    format: RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT,
    evidenceClass: FORMAL_RELEASE_CANDIDATE_PRELAUNCH_EVIDENCE_CLASS,
    formalB0Eligible: false,
    runtimeArtifactBindingVerified: false,
    freezeReceiptDigest,
    freezeSha256: ready.freezeSha256,
    releaseUuid: ready.freeze.releaseUuid,
    artifactUuid: ready.freeze.artifactUuid,
    artifactSha256: ready.freeze.artifactSha256,
    artifactSignedManifestSha256: ready.freeze.artifactSignedManifestSha256,
    sourceDigest: ready.freeze.sourceDigest,
    configExpectedSha256: ready.freeze.configExpectedSha256,
    schemaExpectedSha256: ready.freeze.schemaExpectedSha256,
    attestationKeyId: ready.freeze.attestationKeyId,
  });
}

export function parseReleaseCandidateSessionIdentity(
  value: unknown,
): DevReleaseCandidateSessionIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "artifactSha256",
    "artifactSignedManifestSha256",
    "artifactUuid",
    "attestationKeyId",
    "configExpectedSha256",
    "evidenceClass",
    "format",
    "formalB0Eligible",
    "freezeReceiptDigest",
    "freezeSha256",
    "releaseUuid",
    "runtimeArtifactBindingVerified",
    "schemaExpectedSha256",
    "sourceDigest",
  ])) {
    fail("RELEASE_CANDIDATE_SESSION_IDENTITY_INVALID");
  }
  const attestationKeyId = String(value.attestationKeyId ?? "");
  if (
    value.format !== RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT
    || value.evidenceClass !== "dev-local-only-contract-fixture"
    || value.formalB0Eligible !== false
    || value.runtimeArtifactBindingVerified !== false
    || !attestationKeyId.startsWith("dev-local-only-")
    || !SHA256_PATTERN.test(String(value.freezeReceiptDigest ?? ""))
    || !SHA256_PATTERN.test(String(value.freezeSha256 ?? ""))
    || !UUID_PATTERN.test(String(value.releaseUuid ?? ""))
    || !UUID_PATTERN.test(String(value.artifactUuid ?? ""))
    || !SHA256_PATTERN.test(String(value.artifactSha256 ?? ""))
    || !SHA256_PATTERN.test(String(value.artifactSignedManifestSha256 ?? ""))
    || !SOURCE_DIGEST_PATTERN.test(String(value.sourceDigest ?? ""))
    || !SHA256_PATTERN.test(String(value.configExpectedSha256 ?? ""))
    || !SHA256_PATTERN.test(String(value.schemaExpectedSha256 ?? ""))
    || !KEY_ID_PATTERN.test(attestationKeyId)
  ) {
    fail("RELEASE_CANDIDATE_SESSION_IDENTITY_INVALID");
  }
  return value as DevReleaseCandidateSessionIdentity;
}

export function parseBoundedSourceCorrelationIdentity(
  value: unknown,
): BoundedSourceCorrelationIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "configExpectedSha256",
    "evidenceClass",
    "formalB0Eligible",
    "format",
    "freezeReceiptDigest",
    "runtimeArtifactBindingVerified",
    "schemaExpectedSha256",
    "sourceDigest",
  ])) {
    fail("RELEASE_CANDIDATE_BOUNDED_SOURCE_IDENTITY_INVALID");
  }
  if (
    value.format !== RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT
    || value.evidenceClass !== BOUNDED_SOURCE_CORRELATION_EVIDENCE_CLASS
    || value.formalB0Eligible !== false
    || value.runtimeArtifactBindingVerified !== false
    || !SHA256_PATTERN.test(String(value.freezeReceiptDigest ?? ""))
    || !SOURCE_DIGEST_PATTERN.test(String(value.sourceDigest ?? ""))
    || !SHA256_PATTERN.test(String(value.configExpectedSha256 ?? ""))
    || !SHA256_PATTERN.test(String(value.schemaExpectedSha256 ?? ""))
  ) fail("RELEASE_CANDIDATE_BOUNDED_SOURCE_IDENTITY_INVALID");
  return value as BoundedSourceCorrelationIdentity;
}

/** Formal-only structural validator. It does not accept development fixtures. */
export function parseFormalReleaseCandidateSessionIdentity(
  value: unknown,
): FormalReleaseCandidatePrelaunchSessionIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "artifactSha256",
    "artifactSignedManifestSha256",
    "artifactUuid",
    "attestationKeyId",
    "configExpectedSha256",
    "evidenceClass",
    "format",
    "formalB0Eligible",
    "freezeReceiptDigest",
    "freezeSha256",
    "releaseUuid",
    "runtimeArtifactBindingVerified",
    "schemaExpectedSha256",
    "sourceDigest",
  ])) {
    fail("RELEASE_CANDIDATE_FORMAL_SESSION_IDENTITY_INVALID");
  }
  const attestationKeyId = String(value.attestationKeyId ?? "");
  if (
    value.format !== RELEASE_CANDIDATE_SESSION_IDENTITY_FORMAT
    || value.evidenceClass !== FORMAL_RELEASE_CANDIDATE_PRELAUNCH_EVIDENCE_CLASS
    || value.formalB0Eligible !== false
    || value.runtimeArtifactBindingVerified !== false
    || attestationKeyId.startsWith("dev-local-only-")
    || !SHA256_PATTERN.test(String(value.freezeReceiptDigest ?? ""))
    || !SHA256_PATTERN.test(String(value.freezeSha256 ?? ""))
    || !UUID_PATTERN.test(String(value.releaseUuid ?? ""))
    || !UUID_PATTERN.test(String(value.artifactUuid ?? ""))
    || !SHA256_PATTERN.test(String(value.artifactSha256 ?? ""))
    || !SHA256_PATTERN.test(String(value.artifactSignedManifestSha256 ?? ""))
    || !SOURCE_DIGEST_PATTERN.test(String(value.sourceDigest ?? ""))
    || !SHA256_PATTERN.test(String(value.configExpectedSha256 ?? ""))
    || !SHA256_PATTERN.test(String(value.schemaExpectedSha256 ?? ""))
    || !KEY_ID_PATTERN.test(attestationKeyId)
  ) {
    fail("RELEASE_CANDIDATE_FORMAL_SESSION_IDENTITY_INVALID");
  }
  return value as FormalReleaseCandidatePrelaunchSessionIdentity;
}

/**
 * Correlation-only parser used by code that hashes a session identity but does
 * not promote it to formal evidence.  Trust-sensitive callers must choose one
 * of the two class-specific parsers above.
 */
export function parseReleaseCandidateSessionCorrelationIdentity(
  value: unknown,
): ReleaseCandidateSessionIdentity {
  if (
    isRecord(value)
    && value.evidenceClass === FORMAL_RELEASE_CANDIDATE_PRELAUNCH_EVIDENCE_CLASS
  ) return parseFormalReleaseCandidateSessionIdentity(value);
  return parseReleaseCandidateSessionIdentity(value);
}
