import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV,
} from "@/lib/releaseArtifactAttestation";
import {
  parseReleaseArtifactManifest,
  type ReleaseArtifactAttestationRecord,
  type ReleaseArtifactManifestV1,
} from "@/lib/releaseArtifactManifest";
import {
  verifyCachedReleaseArtifactAttestation,
  type CachedReleaseArtifactEvidence,
} from "@/release-controller/artifactAttestation";

export const RELEASE_CANDIDATE_FREEZE_VERSION = "0.0.9" as const;
export const RELEASE_CANDIDATE_FREEZE_FORMAT =
  "fanjin-release-candidate-freeze/v1" as const;
export const RELEASE_CANDIDATE_FREEZE_RESULT_FORMAT =
  "fanjin-release-candidate-freeze-result/v1" as const;
export const RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT =
  "fanjin-release-config-readback-expectation/v1" as const;
export const RELEASE_CANDIDATE_SCHEMA_EXPECTATION_FORMAT =
  "fanjin-release-schema-expectation/v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_DIGEST_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 200_000;

const SENSITIVE_KEY_PATTERN = /^(?:accesskey|apikey|authorization|cookie|mfasecret|password|privatekey|recoverycode|secret|session|token)$/i;
const PRIVATE_MATERIAL_PATTERN = /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]+/i;

export type ReleaseCandidateFreezeMissingInput =
  | "artifactArchive"
  | "artifactReadyReceipt"
  | "artifactSidecar"
  | "configExpectation"
  | "releaseUuid"
  | "trustedPublicKeys";

export type ReleaseCandidateFreezeBlocker =
  | "ARTIFACT_ARCHIVE_IDENTITY_MISMATCH"
  | "ARTIFACT_ARCHIVE_UNAVAILABLE"
  | "ARTIFACT_ARCHIVE_UNSAFE"
  | "ARTIFACT_ATTESTATION_INVALID"
  | "ARTIFACT_IDENTITY_MISMATCH"
  | "ARTIFACT_READY_RECEIPT_INVALID"
  | "ARTIFACT_READY_RECEIPT_NOT_READY"
  | "ARTIFACT_READY_RECEIPT_UNAVAILABLE"
  | "ARTIFACT_SIDECAR_INVALID"
  | "ARTIFACT_SIDECAR_UNAVAILABLE"
  | "CONFIG_EXPECTATION_INVALID"
  | "CONFIG_EXPECTATION_SENSITIVE"
  | "CONFIG_EXPECTATION_UNAVAILABLE"
  | "INVALID_ARGUMENTS"
  | "OUTPUT_UNAVAILABLE"
  | "RELEASE_UUID_INVALID"
  | "TRUSTED_PUBLIC_KEYS_INVALID"
  | "TRUSTED_PUBLIC_KEYS_UNAVAILABLE";

export class ReleaseCandidateFreezeError extends Error {
  readonly code: ReleaseCandidateFreezeBlocker;

  constructor(code: ReleaseCandidateFreezeBlocker) {
    super(code);
    this.name = "ReleaseCandidateFreezeError";
    this.code = code;
  }
}

export interface ReleaseCandidateFreezeInput {
  artifactArchive?: string;
  artifactReadyReceipt?: string;
  artifactSidecar?: string;
  configExpectation?: string;
  releaseUuid?: string;
  trustedPublicKeys?: string;
}

export interface ReleaseCandidateFreezePendingResult {
  candidateVersion: typeof RELEASE_CANDIDATE_FREEZE_VERSION;
  format: typeof RELEASE_CANDIDATE_FREEZE_RESULT_FORMAT;
  status: "pending";
  missingInputs: ReleaseCandidateFreezeMissingInput[];
  blockers?: ReleaseCandidateFreezeBlocker[];
}

export interface ReleaseCandidateFreezeManifest {
  artifactSha256: string;
  /** SHA-256 of the exact signed release-manifest.json file bytes. */
  artifactSignedManifestSha256: string;
  artifactSize: number;
  artifactUuid: string;
  attestationKeyId: string;
  candidateVersion: typeof RELEASE_CANDIDATE_FREEZE_VERSION;
  configExpectationFormat: typeof RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT;
  configExpectedSha256: string;
  format: typeof RELEASE_CANDIDATE_FREEZE_FORMAT;
  releaseUuid: string;
  schemaExpectationFormat: typeof RELEASE_CANDIDATE_SCHEMA_EXPECTATION_FORMAT;
  schemaExpectedSha256: string;
  sourceDigest: string;
}

export interface ReleaseCandidateFreezeReadyResult {
  format: typeof RELEASE_CANDIDATE_FREEZE_RESULT_FORMAT;
  freeze: ReleaseCandidateFreezeManifest;
  freezeSha256: string;
  status: "ready";
}

export type ReleaseCandidateFreezeResult =
  | ReleaseCandidateFreezePendingResult
  | ReleaseCandidateFreezeReadyResult;

interface ArtifactReadyReceipt {
  id: string;
  releaseId: string;
  byteSize: number;
  sha256: string;
  sourceCommit: string;
  manifest: ReleaseArtifactManifestV1;
  verifiedAt: number;
  revision: number;
}

interface ArtifactSidecar {
  artifactBytes: number;
  artifactSha256: string;
  manifest: ReleaseArtifactManifestV1;
  attestationKeyId: string;
}

interface ConfigExpectation {
  candidateVersion: typeof RELEASE_CANDIDATE_FREEZE_VERSION;
  expectedReadback: Record<string, unknown>;
  format: typeof RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT;
}

export interface ReleaseCandidateFreezeDependencies {
  verifyArtifact?: typeof verifyCachedReleaseArtifactAttestation;
}

function fail(code: ReleaseCandidateFreezeBlocker): never {
  throw new ReleaseCandidateFreezeError(code);
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

function canonicalizeJsonValue(
  value: unknown,
  state: { nodes: number; seen: Set<object> } = { nodes: 0, seen: new Set() },
  depth = 0,
): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error("CANONICAL_JSON_DEPTH");
  }
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES) {
    throw new Error("CANONICAL_JSON_COMPLEXITY");
  }
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_JSON_NUMBER");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") {
    throw new Error("CANONICAL_JSON_VALUE");
  }
  if (state.seen.has(value)) throw new Error("CANONICAL_JSON_CYCLE");
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry) => canonicalizeJsonValue(entry, state, depth + 1))
        .join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => {
      if (object[key] === undefined) throw new Error("CANONICAL_JSON_UNDEFINED");
      return `${JSON.stringify(key)}:${canonicalizeJsonValue(
        object[key],
        state,
        depth + 1,
      )}`;
    }).join(",")}}`;
  } finally {
    state.seen.delete(value);
  }
}

export function canonicalReleaseCandidateFreezeJson(value: unknown): string {
  return canonicalizeJsonValue(value);
}

function canonicalSha256(value: unknown): string {
  return crypto.createHash("sha256")
    .update(canonicalReleaseCandidateFreezeJson(value), "utf8")
    .digest("hex");
}

function assertCanonicalAbsolutePath(filePath: string): void {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new Error("PATH_INVALID");
  }
}

function readProtectedFile(filePath: string, maximumBytes: number): Buffer {
  assertCanonicalAbsolutePath(filePath);
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath);
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.size < 1
      || before.size > maximumBytes
      || (before.mode & 0o022) !== 0
    ) {
      throw new Error("FILE_UNSAFE");
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
      throw new Error("FILE_CHANGED");
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
      throw new Error("FILE_CHANGED");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readJsonFile(
  filePath: string,
  unavailable: ReleaseCandidateFreezeBlocker,
  invalid: ReleaseCandidateFreezeBlocker,
): unknown {
  let bytes: Buffer;
  try {
    bytes = readProtectedFile(filePath, MAX_JSON_BYTES);
  } catch {
    fail(unavailable);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    fail(invalid);
  }
}

function parseManifest(value: unknown): ReleaseArtifactManifestV1 {
  try {
    return parseReleaseArtifactManifest(value);
  } catch {
    fail("ARTIFACT_IDENTITY_MISMATCH");
  }
}

function normalizeReadyReceipt(value: unknown): ArtifactReadyReceipt {
  let candidate = value;
  if (isRecord(candidate) && exactKeys(candidate, ["code", "data", "message"])) {
    if (candidate.code !== 200) fail("ARTIFACT_READY_RECEIPT_INVALID");
    candidate = candidate.data;
  }
  if (!isRecord(candidate)) fail("ARTIFACT_READY_RECEIPT_INVALID");
  const receipt = candidate;
  const id = String(receipt.id ?? "").trim().toLowerCase();
  const releaseId = String(receipt.releaseId ?? "").trim().toLowerCase();
  const sha256 = String(receipt.sha256 ?? "").trim().toLowerCase();
  const sourceCommit = String(receipt.sourceCommit ?? "").trim().toLowerCase();
  const byteSize = receipt.byteSize;
  const verifiedAt = receipt.verifiedAt;
  const revision = receipt.revision;
  if (
    !UUID_PATTERN.test(id)
    || !UUID_PATTERN.test(releaseId)
    || !SHA256_PATTERN.test(sha256)
    || !SOURCE_DIGEST_PATTERN.test(sourceCommit)
    || !Number.isSafeInteger(byteSize)
    || Number(byteSize) < 1
    || !Number.isSafeInteger(revision)
    || Number(revision) < 1
  ) {
    fail("ARTIFACT_READY_RECEIPT_INVALID");
  }
  if (receipt.status !== "ready" || receipt.rejectionReason !== null) {
    fail("ARTIFACT_READY_RECEIPT_NOT_READY");
  }
  if (!Number.isSafeInteger(verifiedAt) || Number(verifiedAt) < 1) {
    fail("ARTIFACT_READY_RECEIPT_INVALID");
  }
  let manifest: ReleaseArtifactManifestV1;
  try {
    manifest = parseReleaseArtifactManifest(receipt.manifest, releaseId);
  } catch {
    fail("ARTIFACT_READY_RECEIPT_INVALID");
  }
  if (manifest.sourceCommit !== sourceCommit) {
    fail("ARTIFACT_READY_RECEIPT_INVALID");
  }
  return {
    id,
    releaseId,
    byteSize: Number(byteSize),
    sha256,
    sourceCommit,
    manifest,
    verifiedAt: Number(verifiedAt),
    revision: Number(revision),
  };
}

function normalizeSidecar(value: unknown): ArtifactSidecar {
  if (!isRecord(value) || value.format !== "fanjin-release-artifact/v1") {
    fail("ARTIFACT_SIDECAR_INVALID");
  }
  const artifactSha256 = String(value.artifactSha256 ?? "").trim().toLowerCase();
  const artifactBytes = value.artifactBytes;
  if (
    !SHA256_PATTERN.test(artifactSha256)
    || !Number.isSafeInteger(artifactBytes)
    || Number(artifactBytes) < 1
    || !isRecord(value.manifest)
  ) {
    fail("ARTIFACT_SIDECAR_INVALID");
  }
  const rawAttestation = value.manifest.attestation;
  if (!isRecord(rawAttestation) || typeof rawAttestation.keyId !== "string") {
    fail("ARTIFACT_SIDECAR_INVALID");
  }
  let manifest: ReleaseArtifactManifestV1;
  try {
    manifest = parseReleaseArtifactManifest(value.manifest);
  } catch {
    fail("ARTIFACT_SIDECAR_INVALID");
  }
  return {
    artifactBytes: Number(artifactBytes),
    artifactSha256,
    manifest,
    attestationKeyId: rawAttestation.keyId,
  };
}

function assertNoSensitiveConfig(value: unknown, seen = new Set<object>()): void {
  if (typeof value === "string") {
    if (PRIVATE_MATERIAL_PATTERN.test(value)) {
      fail("CONFIG_EXPECTATION_SENSITIVE");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail("CONFIG_EXPECTATION_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertNoSensitiveConfig(item, seen);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.replace(/[\s_-]/g, "");
      if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) {
        fail("CONFIG_EXPECTATION_SENSITIVE");
      }
      assertNoSensitiveConfig(child, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function normalizeConfigExpectation(value: unknown): ConfigExpectation {
  if (!isRecord(value) || !exactKeys(value, [
    "candidateVersion",
    "expectedReadback",
    "format",
  ])) {
    fail("CONFIG_EXPECTATION_INVALID");
  }
  if (
    value.format !== RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT
    || value.candidateVersion !== RELEASE_CANDIDATE_FREEZE_VERSION
    || !isRecord(value.expectedReadback)
    || Object.keys(value.expectedReadback).length === 0
  ) {
    fail("CONFIG_EXPECTATION_INVALID");
  }
  assertNoSensitiveConfig(value.expectedReadback);
  try {
    canonicalReleaseCandidateFreezeJson(value);
  } catch {
    fail("CONFIG_EXPECTATION_INVALID");
  }
  return value as unknown as ConfigExpectation;
}

function sameManifest(
  left: ReleaseArtifactManifestV1,
  right: ReleaseArtifactManifestV1,
): boolean {
  return canonicalReleaseCandidateFreezeJson(left)
    === canonicalReleaseCandidateFreezeJson(right);
}

function pendingResult(
  missingInputs: ReleaseCandidateFreezeMissingInput[],
  blockers: ReleaseCandidateFreezeBlocker[] = [],
): ReleaseCandidateFreezePendingResult {
  return {
    candidateVersion: RELEASE_CANDIDATE_FREEZE_VERSION,
    format: RELEASE_CANDIDATE_FREEZE_RESULT_FORMAT,
    status: "pending",
    missingInputs: [...new Set(missingInputs)].sort(),
    ...(blockers.length > 0
      ? { blockers: [...new Set(blockers)].sort() }
      : {}),
  };
}

export function releaseCandidateFreezePendingResult(
  missingInputs: ReleaseCandidateFreezeMissingInput[],
  blockers: ReleaseCandidateFreezeBlocker[] = [],
): ReleaseCandidateFreezePendingResult {
  return pendingResult(missingInputs, blockers);
}

function missingInputs(
  input: ReleaseCandidateFreezeInput,
): ReleaseCandidateFreezeMissingInput[] {
  const missing: ReleaseCandidateFreezeMissingInput[] = [];
  if (!input.artifactArchive) missing.push("artifactArchive");
  if (!input.artifactReadyReceipt) missing.push("artifactReadyReceipt");
  if (!input.artifactSidecar) missing.push("artifactSidecar");
  if (!input.configExpectation) missing.push("configExpectation");
  if (!input.trustedPublicKeys) missing.push("trustedPublicKeys");
  if (!input.releaseUuid && (!input.artifactReadyReceipt || !input.artifactSidecar)) {
    missing.push("releaseUuid");
  }
  return missing;
}

function assertArchiveFile(filePath: string): fs.Stats {
  try {
    assertCanonicalAbsolutePath(filePath);
    const metadata = fs.lstatSync(filePath);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.size < 1
      || (metadata.mode & 0o077) !== 0
    ) {
      fail("ARTIFACT_ARCHIVE_UNSAFE");
    }
    return metadata;
  } catch (error) {
    if (error instanceof ReleaseCandidateFreezeError) throw error;
    fail("ARTIFACT_ARCHIVE_UNAVAILABLE");
  }
}

function trustedPublicKeys(filePath: string): string {
  let bytes: Buffer;
  try {
    bytes = readProtectedFile(filePath, MAX_JSON_BYTES);
  } catch {
    fail("TRUSTED_PUBLIC_KEYS_UNAVAILABLE");
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    value = JSON.parse(text) as unknown;
  } catch {
    fail("TRUSTED_PUBLIC_KEYS_INVALID");
  }
  if (
    !isRecord(value)
    || Object.keys(value).length === 0
    || /PRIVATE KEY/.test(text)
  ) {
    fail("TRUSTED_PUBLIC_KEYS_INVALID");
  }
  return text;
}

function schemaExpectation(manifest: ReleaseArtifactManifestV1): Record<string, unknown> {
  if (!manifest.schemaCompatibility) {
    fail("ARTIFACT_IDENTITY_MISMATCH");
  }
  return {
    format: RELEASE_CANDIDATE_SCHEMA_EXPECTATION_FORMAT,
    schemaVersion: manifest.schemaVersion,
    schemaMode: manifest.schemaMode,
    schemaCompatibility: manifest.schemaCompatibility,
    workerProtocolVersion: manifest.workerProtocolVersion,
    runtimeCapabilities: manifest.runtimeCapabilities,
  };
}

function verifiedEvidenceMatches(
  evidence: CachedReleaseArtifactEvidence,
  receipt: ArtifactReadyReceipt,
): boolean {
  return evidence.artifactId === receipt.id
    && evidence.artifactSha256 === receipt.sha256
    && evidence.releaseId === receipt.releaseId
    && evidence.schemaVersion === receipt.manifest.schemaVersion
    && evidence.workerProtocolVersion === receipt.manifest.workerProtocolVersion
    && canonicalReleaseCandidateFreezeJson(evidence.runtimeCapabilities)
      === canonicalReleaseCandidateFreezeJson(receipt.manifest.runtimeCapabilities);
}

export async function createReleaseCandidateFreeze(
  input: ReleaseCandidateFreezeInput,
  dependencies: ReleaseCandidateFreezeDependencies = {},
): Promise<ReleaseCandidateFreezeResult> {
  const missing = missingInputs(input);
  if (missing.length > 0) return pendingResult(missing);

  const explicitReleaseUuid = String(input.releaseUuid || "").trim().toLowerCase();
  if (explicitReleaseUuid && !UUID_PATTERN.test(explicitReleaseUuid)) {
    fail("RELEASE_UUID_INVALID");
  }

  const sidecar = normalizeSidecar(readJsonFile(
    input.artifactSidecar!,
    "ARTIFACT_SIDECAR_UNAVAILABLE",
    "ARTIFACT_SIDECAR_INVALID",
  ));
  const receipt = normalizeReadyReceipt(readJsonFile(
    input.artifactReadyReceipt!,
    "ARTIFACT_READY_RECEIPT_UNAVAILABLE",
    "ARTIFACT_READY_RECEIPT_INVALID",
  ));
  const config = normalizeConfigExpectation(readJsonFile(
    input.configExpectation!,
    "CONFIG_EXPECTATION_UNAVAILABLE",
    "CONFIG_EXPECTATION_INVALID",
  ));
  const trustStore = trustedPublicKeys(input.trustedPublicKeys!);
  const archiveMetadata = assertArchiveFile(input.artifactArchive!);

  const releaseUuid = explicitReleaseUuid || receipt.releaseId;
  if (
    releaseUuid !== receipt.releaseId
    || releaseUuid !== sidecar.manifest.releaseId
    || sidecar.artifactSha256 !== receipt.sha256
    || sidecar.artifactBytes !== receipt.byteSize
    || sidecar.artifactBytes !== archiveMetadata.size
    || !sameManifest(sidecar.manifest, receipt.manifest)
  ) {
    fail("ARTIFACT_IDENTITY_MISMATCH");
  }

  const artifactRecord: ReleaseArtifactAttestationRecord = {
    id: receipt.id,
    releaseId: receipt.releaseId,
    byteSize: receipt.byteSize,
    sha256: receipt.sha256,
    sourceCommit: receipt.sourceCommit,
    format: receipt.manifest.format,
    manifest: receipt.manifest,
    status: "ready",
  };

  let evidence: CachedReleaseArtifactEvidence;
  try {
    evidence = await (dependencies.verifyArtifact
      || verifyCachedReleaseArtifactAttestation)({
      archivePath: input.artifactArchive!,
      artifact: artifactRecord,
      environment: {
        [RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV]: trustStore,
      },
    });
  } catch {
    fail("ARTIFACT_ATTESTATION_INVALID");
  }
  if (
    !verifiedEvidenceMatches(evidence, receipt)
    || evidence.attestation.keyId !== sidecar.attestationKeyId
    || !SHA256_PATTERN.test(evidence.signedManifestFileSha256)
    || !SHA256_PATTERN.test(evidence.attestation.payloadSha256)
  ) {
    fail("ARTIFACT_ARCHIVE_IDENTITY_MISMATCH");
  }

  const freeze: ReleaseCandidateFreezeManifest = {
    artifactSha256: receipt.sha256,
    artifactSignedManifestSha256: evidence.signedManifestFileSha256,
    artifactSize: receipt.byteSize,
    artifactUuid: receipt.id,
    attestationKeyId: evidence.attestation.keyId,
    candidateVersion: RELEASE_CANDIDATE_FREEZE_VERSION,
    configExpectationFormat: RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT,
    configExpectedSha256: canonicalSha256(config),
    format: RELEASE_CANDIDATE_FREEZE_FORMAT,
    releaseUuid,
    schemaExpectationFormat: RELEASE_CANDIDATE_SCHEMA_EXPECTATION_FORMAT,
    schemaExpectedSha256: canonicalSha256(schemaExpectation(receipt.manifest)),
    sourceDigest: receipt.sourceCommit,
  };
  return {
    format: RELEASE_CANDIDATE_FREEZE_RESULT_FORMAT,
    freeze,
    freezeSha256: canonicalSha256(freeze),
    status: "ready",
  };
}

export function renderReleaseCandidateFreezeResult(
  result: ReleaseCandidateFreezeResult,
): string {
  return `${canonicalReleaseCandidateFreezeJson(result)}\n`;
}
