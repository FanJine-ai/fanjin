// Vendored pure wire contract from fanjin-release-control/src/domain/subjectCentralPreparationReceipt.ts.
// No controller runtime, private key or deployment operations are included.
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import { canonicalJson } from "./canonicalJson";
import { ReleaseControlError, invariant } from "./errors";
import type {
  SubjectEd25519Signer,
  SubjectEd25519TrustKey,
} from "./subjectRuntimeConfig";

export const SUBJECT_CENTRAL_PREPARATION_RECEIPT_SCHEMA =
  "fanjin-subject-central-preparation-receipt/v1" as const;
export const SUBJECT_CENTRAL_PREPARATION_ATTESTATION_SCHEMA =
  "fanjin-subject-central-preparation-attestation/v1" as const;
export const SUBJECT_NATIVE_PRESTART_RECEIPT_SCHEMA =
  "fanjin-production-prestart-receipt/v1" as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RAW_SHA256 = /^[a-f0-9]{64}$/u;
// The native production-prestart/v1 claim accepts the Git SHA-1 source identity.
const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const ROLES = Object.freeze(["api", "worker"] as const);

export type SubjectCentralPreparationEnvironment = "test" | "production";
export type SubjectCentralPreparationRole = typeof ROLES[number];

export interface SubjectCentralPreparationRoleArtifactClaim {
  readonly role: SubjectCentralPreparationRole;
  readonly artifactSha256: string;
}

export interface SubjectCentralPreparationSchemaCompatibility {
  readonly minimumSchemaVersion: number;
  readonly maximumSchemaVersion: number;
  readonly catalogDigest: string;
}

export interface SubjectNativePrestartClaim {
  readonly schema: typeof SUBJECT_NATIVE_PRESTART_RECEIPT_SCHEMA;
  readonly platformVersion: string;
  readonly releaseId: string;
  readonly sourceCommit: string;
  readonly schemaVersion: number;
  readonly role: SubjectCentralPreparationRole;
  readonly artifactSha256: string;
  readonly phase: "database-prepared" | "ready";
  readonly observedArtifacts: Readonly<Partial<Record<SubjectCentralPreparationRole, string>>>;
  readonly readinessScore: number | null;
  readonly releaseReady: boolean;
  readonly p0Blockers: number | null;
  readonly receiptDigest: string;
  readonly claimMac: string;
}

export interface SubjectCentralPreparationCapabilityReceiptDigest {
  readonly role: SubjectCentralPreparationRole;
  readonly receiptSha: string;
}

export interface SubjectCentralPreparationReadiness {
  readonly score: 100;
  readonly releaseReady: true;
  readonly p0Blockers: 0;
}

export interface SubjectCentralPreparationAttestation {
  readonly schema: typeof SUBJECT_CENTRAL_PREPARATION_ATTESTATION_SCHEMA;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signature: string;
}

export interface SubjectCentralPreparationReceiptContent {
  readonly schema: typeof SUBJECT_CENTRAL_PREPARATION_RECEIPT_SCHEMA;
  readonly environment: SubjectCentralPreparationEnvironment;
  readonly targetId: string;
  readonly configSha: string;
  readonly configRevision: number;
  readonly candidateDigest: string;
  readonly sourceCommit: string;
  readonly platformVersion: string;
  readonly roleArtifactClaims: readonly SubjectCentralPreparationRoleArtifactClaim[];
  readonly schemaCompatibility: SubjectCentralPreparationSchemaCompatibility;
  readonly databaseIdentityDigest: string;
  readonly nativePrestartClaims: readonly SubjectNativePrestartClaim[];
  readonly readiness: SubjectCentralPreparationReadiness;
  readonly capabilityReceiptDigests: readonly SubjectCentralPreparationCapabilityReceiptDigest[];
  readonly issuedAt: string;
}

export interface SubjectCentralPreparationReceipt extends SubjectCentralPreparationReceiptContent {
  readonly receiptSha: string;
  readonly attestation: SubjectCentralPreparationAttestation;
}

export interface SubjectCentralPreparationReceiptExpectation {
  readonly environment: SubjectCentralPreparationEnvironment;
  readonly targetId: string;
  readonly configSha: string;
  readonly configRevision: number;
  readonly candidateDigest: string;
  readonly sourceCommit: string;
  readonly platformVersion: string;
  readonly roleArtifactClaims: readonly SubjectCentralPreparationRoleArtifactClaim[];
  readonly schemaCompatibility: SubjectCentralPreparationSchemaCompatibility;
  readonly databaseIdentityDigest: string;
  readonly capabilityReceiptDigests: readonly SubjectCentralPreparationCapabilityReceiptDigest[];
}

type JsonRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new ReleaseControlError(
    "SUBJECT_CENTRAL_PREPARATION_RECEIPT_INVALID",
    message,
    409,
  );
}

function asRecord(value: unknown, message: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(message);
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, expected: readonly string[], message: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(message);
  }
}

function requireString(value: unknown, message: string, maximumLength = 8_192): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) invalid(message);
  return value;
}

function requireDigest(value: unknown, message: string): string {
  const digest = requireString(value, message, 71);
  if (!SHA256.test(digest)) invalid(message);
  return digest;
}

function requireRawDigest(value: unknown, message: string): string {
  const digest = requireString(value, message, 64);
  if (!RAW_SHA256.test(digest)) invalid(message);
  return digest;
}

function requireNonnegativeInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(message);
  return value as number;
}

function requirePositiveInteger(value: unknown, message: string): number {
  const integer = requireNonnegativeInteger(value, message);
  if (integer < 1) invalid(message);
  return integer;
}

function requireIssuedAt(value: unknown): string {
  const issuedAt = requireString(value, "Central preparation issuedAt is invalid", 64);
  const parsed = new Date(issuedAt);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== issuedAt) {
    invalid("Central preparation issuedAt must be a canonical ISO timestamp");
  }
  return issuedAt;
}

function requireTargetId(value: unknown): string {
  const targetId = requireString(value, "Central preparation target ID is invalid", 256);
  if (
    !TARGET.test(targetId)
    || targetId.includes("//")
    || targetId.includes("@{")
    || targetId.split("/").some((segment) => segment === "." || segment === "..")
  ) invalid("Central preparation target ID is invalid");
  return targetId;
}

function requireVersion(value: unknown, message: string): string {
  const version = requireString(value, message, 128);
  if (!VERSION.test(version)) invalid(message);
  return version;
}

function normalizeRoleArtifactClaim(
  value: unknown,
  expectedRole: SubjectCentralPreparationRole,
): SubjectCentralPreparationRoleArtifactClaim {
  const record = asRecord(value, "Central preparation role artifact claim must be an object");
  exactKeys(record, ["role", "artifactSha256"], "Central preparation role artifact claim fields are invalid");
  if (record.role !== expectedRole) invalid("Central preparation role artifact claims must be ordered api, worker");
  return Object.freeze({
    role: expectedRole,
    artifactSha256: requireDigest(record.artifactSha256, "Central preparation role artifact digest is invalid"),
  });
}

function normalizeRoleArtifactClaims(value: unknown): readonly SubjectCentralPreparationRoleArtifactClaim[] {
  if (!Array.isArray(value) || value.length !== ROLES.length) {
    invalid("Central preparation role artifact claims must contain api and worker exactly once");
  }
  return Object.freeze(ROLES.map((role, index) => normalizeRoleArtifactClaim(value[index], role)));
}

function normalizeSchemaCompatibility(value: unknown): SubjectCentralPreparationSchemaCompatibility {
  const record = asRecord(value, "Central preparation schema compatibility must be an object");
  exactKeys(
    record,
    ["minimumSchemaVersion", "maximumSchemaVersion", "catalogDigest"],
    "Central preparation schema compatibility fields are invalid",
  );
  const minimumSchemaVersion = requireNonnegativeInteger(
    record.minimumSchemaVersion,
    "Central preparation minimum schema version is invalid",
  );
  const maximumSchemaVersion = requireNonnegativeInteger(
    record.maximumSchemaVersion,
    "Central preparation maximum schema version is invalid",
  );
  if (minimumSchemaVersion > maximumSchemaVersion) {
    invalid("Central preparation schema compatibility range is invalid");
  }
  return Object.freeze({
    minimumSchemaVersion,
    maximumSchemaVersion,
    catalogDigest: requireDigest(record.catalogDigest, "Central preparation catalog digest is invalid"),
  });
}

function normalizeObservedArtifacts(
  value: unknown,
  role: SubjectCentralPreparationRole,
): Readonly<Partial<Record<SubjectCentralPreparationRole, string>>> {
  const record = asRecord(value, "Native prestart observed artifacts must be an object");
  const actual = Object.keys(record).sort();
  const allowed = role === "api"
    ? ["api", "worker"]
    : actual.includes("api") ? ["api", "worker"] : ["worker"];
  exactKeys(record, allowed, "Native prestart observed artifact fields are invalid");
  const normalized: Partial<Record<SubjectCentralPreparationRole, string>> = {};
  for (const key of allowed) {
    normalized[key as SubjectCentralPreparationRole] = requireRawDigest(
      record[key],
      "Native prestart observed artifact digest is invalid",
    );
  }
  return Object.freeze(normalized);
}

export function validateSubjectNativePrestartClaim(
  value: unknown,
  expectedRole?: SubjectCentralPreparationRole,
): SubjectNativePrestartClaim {
  const record = asRecord(value, "Native prestart claim must be an object");
  exactKeys(record, [
    "schema",
    "platformVersion",
    "releaseId",
    "sourceCommit",
    "schemaVersion",
    "role",
    "artifactSha256",
    "phase",
    "observedArtifacts",
    "readinessScore",
    "releaseReady",
    "p0Blockers",
    "receiptDigest",
    "claimMac",
  ], "Native prestart claim fields are invalid");
  if (record.schema !== SUBJECT_NATIVE_PRESTART_RECEIPT_SCHEMA || !ROLES.includes(record.role as SubjectCentralPreparationRole)) {
    invalid("Native prestart claim schema or role is invalid");
  }
  const role = record.role as SubjectCentralPreparationRole;
  if (expectedRole !== undefined && role !== expectedRole) {
    invalid("Native prestart claims must be ordered api, worker");
  }
  const platformVersion = requireVersion(record.platformVersion, "Native prestart platform version is invalid");
  const releaseId = requireVersion(record.releaseId, "Native prestart release ID is invalid");
  if (releaseId !== platformVersion) invalid("Native prestart release identity is inconsistent");
  const sourceCommit = requireString(record.sourceCommit, "Native prestart source commit is invalid", 64);
  if (!COMMIT.test(sourceCommit)) invalid("Native prestart source commit is invalid");
  const schemaVersion = requirePositiveInteger(record.schemaVersion, "Native prestart schema version is invalid");
  const artifactSha256 = requireRawDigest(record.artifactSha256, "Native prestart artifact digest is invalid");
  const observedArtifacts = normalizeObservedArtifacts(record.observedArtifacts, role);
  if (observedArtifacts[role] !== artifactSha256) {
    invalid("Native prestart claim does not observe its own role artifact");
  }

  if (role === "api") {
    if (
      record.phase !== "ready"
      || record.readinessScore !== 100
      || record.releaseReady !== true
      || record.p0Blockers !== 0
    ) invalid("API native prestart claim is not release-ready at 100/100 with zero P0 blockers");
  } else if (!(
    (record.phase === "database-prepared" && record.readinessScore === null
      && record.releaseReady === false && record.p0Blockers === null)
    || (record.phase === "ready" && record.readinessScore === 100
      && record.releaseReady === true && record.p0Blockers === 0)
  )) {
    invalid("Worker native prestart claim must be authentic database-prepared or previously completed ready evidence");
  }

  return Object.freeze({
    schema: SUBJECT_NATIVE_PRESTART_RECEIPT_SCHEMA,
    platformVersion,
    releaseId,
    sourceCommit,
    schemaVersion,
    role,
    artifactSha256,
    phase: record.phase as "database-prepared" | "ready",
    observedArtifacts,
    readinessScore: record.readinessScore as number | null,
    releaseReady: record.releaseReady as boolean,
    p0Blockers: record.p0Blockers as number | null,
    receiptDigest: requireRawDigest(record.receiptDigest, "Native prestart receipt digest is invalid"),
    claimMac: requireRawDigest(record.claimMac, "Native prestart claim MAC is invalid"),
  });
}

function normalizeNativePrestartClaims(value: unknown): readonly SubjectNativePrestartClaim[] {
  if (!Array.isArray(value) || value.length !== ROLES.length) {
    invalid("Central preparation must contain api and worker native prestart claims exactly once");
  }
  return Object.freeze(ROLES.map((role, index) => validateSubjectNativePrestartClaim(value[index], role)));
}

function normalizeCapabilityReceiptDigest(
  value: unknown,
  expectedRole: SubjectCentralPreparationRole,
): SubjectCentralPreparationCapabilityReceiptDigest {
  const record = asRecord(value, "Capability receipt digest must be an object");
  exactKeys(record, ["role", "receiptSha"], "Capability receipt digest fields are invalid");
  if (record.role !== expectedRole) invalid("Capability receipt digests must be ordered api, worker");
  return Object.freeze({
    role: expectedRole,
    receiptSha: requireDigest(record.receiptSha, "Capability receipt digest is invalid"),
  });
}

function normalizeCapabilityReceiptDigests(
  value: unknown,
): readonly SubjectCentralPreparationCapabilityReceiptDigest[] {
  if (!Array.isArray(value) || value.length !== ROLES.length) {
    invalid("Central preparation must contain api and worker capability receipt digests exactly once");
  }
  return Object.freeze(ROLES.map((role, index) => normalizeCapabilityReceiptDigest(value[index], role)));
}

function normalizeReadiness(value: unknown): SubjectCentralPreparationReadiness {
  const record = asRecord(value, "Central preparation readiness must be an object");
  exactKeys(record, ["score", "releaseReady", "p0Blockers"], "Central preparation readiness fields are invalid");
  if (record.score !== 100 || record.releaseReady !== true || record.p0Blockers !== 0) {
    invalid("Central preparation readiness must prove 100/100 and zero P0 blockers");
  }
  return Object.freeze({ score: 100, releaseReady: true, p0Blockers: 0 });
}

function normalizeContent(value: unknown): SubjectCentralPreparationReceiptContent {
  const record = asRecord(value, "Central preparation receipt content must be an object");
  exactKeys(record, [
    "schema",
    "environment",
    "targetId",
    "configSha",
    "configRevision",
    "candidateDigest",
    "sourceCommit",
    "platformVersion",
    "roleArtifactClaims",
    "schemaCompatibility",
    "databaseIdentityDigest",
    "nativePrestartClaims",
    "readiness",
    "capabilityReceiptDigests",
    "issuedAt",
  ], "Central preparation receipt content fields are invalid");
  if (record.schema !== SUBJECT_CENTRAL_PREPARATION_RECEIPT_SCHEMA) {
    invalid("Central preparation receipt schema is invalid");
  }
  if (record.environment !== "test" && record.environment !== "production") {
    invalid("Central preparation environment is invalid");
  }
  const sourceCommit = requireString(record.sourceCommit, "Central preparation source commit is invalid", 64);
  if (!COMMIT.test(sourceCommit)) invalid("Central preparation source commit is invalid");
  const platformVersion = requireVersion(record.platformVersion, "Central preparation platform version is invalid");
  const roleArtifactClaims = normalizeRoleArtifactClaims(record.roleArtifactClaims);
  const schemaCompatibility = normalizeSchemaCompatibility(record.schemaCompatibility);
  const nativePrestartClaims = normalizeNativePrestartClaims(record.nativePrestartClaims);

  for (const claim of nativePrestartClaims) {
    const artifact = roleArtifactClaims.find((entry) => entry.role === claim.role)!;
    if (
      claim.platformVersion !== platformVersion
      || claim.sourceCommit !== sourceCommit
      || claim.schemaVersion < schemaCompatibility.minimumSchemaVersion
      || claim.schemaVersion > schemaCompatibility.maximumSchemaVersion
      || claim.schemaVersion !== nativePrestartClaims[0]!.schemaVersion
      || `sha256:${claim.artifactSha256}` !== artifact.artifactSha256
    ) invalid("Native prestart claim does not match the central preparation identity");
    for (const [role, observedDigest] of Object.entries(claim.observedArtifacts)) {
      const observedArtifact = roleArtifactClaims.find((entry) => entry.role === role);
      if (!observedArtifact || observedArtifact.artifactSha256 !== `sha256:${observedDigest}`) {
        invalid("Native prestart observed artifacts do not match the signed role claims");
      }
    }
  }

  return Object.freeze({
    schema: SUBJECT_CENTRAL_PREPARATION_RECEIPT_SCHEMA,
    environment: record.environment,
    targetId: requireTargetId(record.targetId),
    configSha: requireDigest(record.configSha, "Central preparation config digest is invalid"),
    configRevision: requirePositiveInteger(record.configRevision, "Central preparation config revision is invalid"),
    candidateDigest: requireDigest(record.candidateDigest, "Central preparation candidate digest is invalid"),
    sourceCommit,
    platformVersion,
    roleArtifactClaims,
    schemaCompatibility,
    databaseIdentityDigest: requireDigest(
      record.databaseIdentityDigest,
      "Central preparation database identity digest is invalid",
    ),
    nativePrestartClaims,
    readiness: normalizeReadiness(record.readiness),
    capabilityReceiptDigests: normalizeCapabilityReceiptDigests(record.capabilityReceiptDigests),
    issuedAt: requireIssuedAt(record.issuedAt),
  });
}

function contentFromReceipt(receipt: SubjectCentralPreparationReceipt): SubjectCentralPreparationReceiptContent {
  const { receiptSha: _receiptSha, attestation: _attestation, ...content } = receipt;
  return content;
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function subjectCentralPreparationReceiptSha(
  value: SubjectCentralPreparationReceiptContent | SubjectCentralPreparationReceipt,
): string {
  const record = asRecord(value, "Central preparation receipt must be an object");
  const content = Object.hasOwn(record, "receiptSha")
    ? contentFromReceipt(normalizeReceipt(value))
    : normalizeContent(value);
  return digestCanonical(content);
}

function normalizeAttestation(value: unknown): SubjectCentralPreparationAttestation {
  const record = asRecord(value, "Central preparation attestation must be an object");
  exactKeys(record, ["schema", "algorithm", "keyId", "signature"], "Central preparation attestation fields are invalid");
  if (record.schema !== SUBJECT_CENTRAL_PREPARATION_ATTESTATION_SCHEMA || record.algorithm !== "Ed25519") {
    invalid("Central preparation attestation is invalid");
  }
  const signature = requireString(record.signature, "Central preparation signature is invalid", 128);
  const bytes = Buffer.from(signature, "base64");
  if (bytes.byteLength !== 64 || bytes.toString("base64") !== signature) {
    invalid("Central preparation signature is invalid");
  }
  return Object.freeze({
    schema: SUBJECT_CENTRAL_PREPARATION_ATTESTATION_SCHEMA,
    algorithm: "Ed25519",
    keyId: requireDigest(record.keyId, "Central preparation attestation key ID is invalid"),
    signature,
  });
}

function normalizeReceipt(value: unknown): SubjectCentralPreparationReceipt {
  const record = asRecord(value, "Central preparation receipt must be an object");
  exactKeys(record, [
    "schema",
    "receiptSha",
    "environment",
    "targetId",
    "configSha",
    "configRevision",
    "candidateDigest",
    "sourceCommit",
    "platformVersion",
    "roleArtifactClaims",
    "schemaCompatibility",
    "databaseIdentityDigest",
    "nativePrestartClaims",
    "readiness",
    "capabilityReceiptDigests",
    "issuedAt",
    "attestation",
  ], "Central preparation receipt fields are invalid");
  const content = normalizeContent(Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "receiptSha" && key !== "attestation"),
  ));
  return Object.freeze({
    ...content,
    receiptSha: requireDigest(record.receiptSha, "Central preparation receipt digest is invalid"),
    attestation: normalizeAttestation(record.attestation),
  });
}

function signedPayload(
  content: SubjectCentralPreparationReceiptContent,
  receiptSha: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...content, receiptSha });
}

function validateSigner(signer: SubjectEd25519Signer): void {
  invariant(
    signer?.algorithm === "Ed25519" && SHA256.test(signer.keyId) && typeof signer.sign === "function",
    "SUBJECT_CENTRAL_PREPARATION_SIGNER_INVALID",
    "Central preparation signer is invalid",
    500,
  );
}

/**
 * Low-level signing primitive. Callers must use the producer module so the
 * candidate signatures, native claim MACs, config and cleanup receipts are
 * verified before this function receives content.
 */
export async function signSubjectCentralPreparationReceipt(
  input: SubjectCentralPreparationReceiptContent,
  signer: SubjectEd25519Signer,
): Promise<SubjectCentralPreparationReceipt> {
  validateSigner(signer);
  const content = normalizeContent(input);
  const receiptSha = digestCanonical(content);
  let signature: Uint8Array;
  try {
    signature = await signer.sign(Buffer.from(canonicalJson(signedPayload(content, receiptSha)), "utf8"));
  } catch {
    throw new ReleaseControlError(
      "SUBJECT_CENTRAL_PREPARATION_SIGNING_FAILED",
      "Central preparation receipt signing failed",
      500,
    );
  }
  invariant(
    signature.byteLength === 64,
    "SUBJECT_CENTRAL_PREPARATION_SIGNER_INVALID",
    "Central preparation signer returned an invalid signature",
    500,
  );
  return Object.freeze({
    ...content,
    receiptSha,
    attestation: Object.freeze({
      schema: SUBJECT_CENTRAL_PREPARATION_ATTESTATION_SCHEMA,
      algorithm: "Ed25519",
      keyId: signer.keyId,
      signature: Buffer.from(signature).toString("base64"),
    }),
  });
}

function verifyAttestation(
  receipt: SubjectCentralPreparationReceipt,
  trustedPublicKeys: readonly SubjectEd25519TrustKey[],
): void {
  if (!Array.isArray(trustedPublicKeys) || trustedPublicKeys.length < 1 || trustedPublicKeys.length > 16) {
    throw new ReleaseControlError(
      "SUBJECT_CENTRAL_PREPARATION_TRUST_INVALID",
      "Central preparation trust set is invalid",
      500,
    );
  }
  const matches = trustedPublicKeys.filter((entry) => entry.keyId === receipt.attestation.keyId);
  if (matches.length !== 1) {
    throw new ReleaseControlError(
      "SUBJECT_CENTRAL_PREPARATION_TRUST_INVALID",
      "Central preparation receipt is not signed by the trusted capability authority",
      403,
    );
  }
  try {
    const trust = matches[0]!;
    if (!SHA256.test(trust.keyId) || typeof trust.publicKeyPem !== "string") throw new Error("invalid trust entry");
    const key = createPublicKey(trust.publicKeyPem);
    const spki = key.export({ type: "spki", format: "der" });
    const keyId = `sha256:${createHash("sha256").update(spki).digest("hex")}`;
    if (key.asymmetricKeyType !== "ed25519" || keyId !== trust.keyId) throw new Error("invalid trust identity");
    const content = contentFromReceipt(receipt);
    const valid = verifySignature(
      null,
      Buffer.from(canonicalJson(signedPayload(content, receipt.receiptSha)), "utf8"),
      key,
      Buffer.from(receipt.attestation.signature, "base64"),
    );
    if (!valid) throw new Error("invalid signature");
  } catch {
    throw new ReleaseControlError(
      "SUBJECT_CENTRAL_PREPARATION_TRUST_INVALID",
      "Central preparation receipt is not signed by the trusted capability authority",
      403,
    );
  }
}

function expectationContent(
  expectation: SubjectCentralPreparationReceiptExpectation,
): Omit<SubjectCentralPreparationReceiptContent, "schema" | "nativePrestartClaims" | "readiness" | "issuedAt"> {
  const record = asRecord(expectation, "Central preparation expectation must be an object");
  exactKeys(record, [
    "environment",
    "targetId",
    "configSha",
    "configRevision",
    "candidateDigest",
    "sourceCommit",
    "platformVersion",
    "roleArtifactClaims",
    "schemaCompatibility",
    "databaseIdentityDigest",
    "capabilityReceiptDigests",
  ], "Central preparation expectation fields are invalid");
  if (record.environment !== "test" && record.environment !== "production") {
    invalid("Central preparation expectation environment is invalid");
  }
  const sourceCommit = requireString(record.sourceCommit, "Central preparation expectation source commit is invalid", 64);
  if (!COMMIT.test(sourceCommit)) invalid("Central preparation expectation source commit is invalid");
  return Object.freeze({
    environment: record.environment,
    targetId: requireTargetId(record.targetId),
    configSha: requireDigest(record.configSha, "Central preparation expectation config digest is invalid"),
    configRevision: requirePositiveInteger(record.configRevision, "Central preparation expectation config revision is invalid"),
    candidateDigest: requireDigest(record.candidateDigest, "Central preparation expectation candidate digest is invalid"),
    sourceCommit,
    platformVersion: requireVersion(record.platformVersion, "Central preparation expectation platform version is invalid"),
    roleArtifactClaims: normalizeRoleArtifactClaims(record.roleArtifactClaims),
    schemaCompatibility: normalizeSchemaCompatibility(record.schemaCompatibility),
    databaseIdentityDigest: requireDigest(
      record.databaseIdentityDigest,
      "Central preparation expectation database identity digest is invalid",
    ),
    capabilityReceiptDigests: normalizeCapabilityReceiptDigests(record.capabilityReceiptDigests),
  });
}

/** Pure, read-only startup verifier for the signed central preparation file. */
export function verifySubjectCentralPreparationReceipt(
  value: unknown,
  trustedCapabilityPublicKeys: readonly SubjectEd25519TrustKey[],
  expected: SubjectCentralPreparationReceiptExpectation,
): SubjectCentralPreparationReceipt {
  const receipt = normalizeReceipt(value);
  const content = contentFromReceipt(receipt);
  if (receipt.receiptSha !== digestCanonical(content)) {
    throw new ReleaseControlError(
      "SUBJECT_CENTRAL_PREPARATION_RECEIPT_DIGEST_MISMATCH",
      "Central preparation receipt digest does not match its content",
      409,
    );
  }
  verifyAttestation(receipt, trustedCapabilityPublicKeys);
  const expectedIdentity = expectationContent(expected);
  const {
    schema: _schema,
    nativePrestartClaims: _nativePrestartClaims,
    readiness: _readiness,
    issuedAt: _issuedAt,
    ...actualIdentity
  } = content;
  if (canonicalJson(actualIdentity) !== canonicalJson(expectedIdentity)) {
    throw new ReleaseControlError(
      "SUBJECT_CENTRAL_PREPARATION_BINDING_MISMATCH",
      "Central preparation receipt does not match the current target, config, candidate, database and storage evidence",
      409,
    );
  }
  return receipt;
}
