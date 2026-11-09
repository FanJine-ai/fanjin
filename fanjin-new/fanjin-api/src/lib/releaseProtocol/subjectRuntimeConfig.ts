// Vendored pure wire contract from fanjin-release-control/src/domain/subjectRuntimeConfig.ts.
// No controller runtime, credentials, network or deployment operations are included.
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import { canonicalJson } from "./canonicalJson";
import { ReleaseControlError, invariant } from "./errors";
import {
  SUBJECT_RELEASE_UNIT_IDS,
  type SubjectReleaseUnitId,
} from "./subjectReleaseUnits";

export const SUBJECT_RUNTIME_CONFIG_SCHEMA = "fanjin-subject-runtime-config/v1" as const;
export const SUBJECT_RUNTIME_VALUES_SCHEMA = "fanjin-subject-runtime-values/v1" as const;
export const SUBJECT_RUNTIME_ATTESTATION_SCHEMA = "fanjin-subject-runtime-attestation/v1" as const;
export const SUBJECT_STORAGE_CAPABILITY_RECEIPT_SCHEMA =
  "fanjin-subject-storage-capability-receipt/v1" as const;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_VARIABLE_PATTERN =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|DATABASE_URL|REDIS_URL|PASSWORD|SECRET|TOKEN|CREDENTIALS?|DSN)(?:$|_)/;

export interface SubjectEd25519Signer {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

export interface SubjectEd25519TrustKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface SubjectRuntimeVariable {
  readonly name: string;
  readonly value: string;
}

export interface SubjectRuntimeSecretRef {
  readonly name: string;
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly secretSha256: string;
}

export interface SubjectRuntimeValues {
  readonly schema: typeof SUBJECT_RUNTIME_VALUES_SCHEMA;
  readonly variables: readonly SubjectRuntimeVariable[];
  readonly secrets: readonly SubjectRuntimeSecretRef[];
}

export interface SubjectRuntimeRoleClaim {
  readonly role: SubjectReleaseUnitId;
  readonly artifactSha256: string;
}

export interface SubjectRuntimeStorage {
  readonly provider: "tos-s3";
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string;
  readonly keyPrefix: string;
  readonly forcePathStyle: boolean;
}

export interface SubjectRuntimeConfigInput {
  readonly revision: number;
  readonly issuedAt: string;
  readonly compatibleArtifactSha256: readonly string[];
  readonly roleClaims: readonly SubjectRuntimeRoleClaim[];
  readonly runtime: SubjectRuntimeValues;
  readonly storage: SubjectRuntimeStorage;
}

export interface SubjectRuntimeAttestation {
  readonly schema: typeof SUBJECT_RUNTIME_ATTESTATION_SCHEMA;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signature: string;
}

export interface SubjectRuntimeConfig extends SubjectRuntimeConfigInput {
  readonly schema: typeof SUBJECT_RUNTIME_CONFIG_SCHEMA;
  readonly configSha: string;
  readonly attestation: SubjectRuntimeAttestation;
}

export interface SubjectStorageCanaryEvidence {
  readonly objectKeySha256: string;
  readonly payloadSha256: string;
  readonly observedGenerations: number;
  readonly deletedGenerations: number;
  readonly remainingGenerations: number;
}

export interface SubjectStorageCapabilityReceiptInput {
  readonly config: SubjectRuntimeConfig;
  readonly role: SubjectReleaseUnitId;
  readonly artifactSha256: string;
  readonly issuedAt: string;
  readonly canary: SubjectStorageCanaryEvidence;
}

export interface SubjectStorageCapabilityReceipt {
  readonly schema: typeof SUBJECT_STORAGE_CAPABILITY_RECEIPT_SCHEMA;
  readonly receiptSha: string;
  readonly configSha: string;
  readonly configRevisionPrepared: number;
  readonly artifactSha256: string;
  readonly role: SubjectReleaseUnitId;
  readonly storage: SubjectRuntimeStorage;
  readonly issuedAt: string;
  readonly canary: SubjectStorageCanaryEvidence;
  readonly attestation: SubjectRuntimeAttestation;
}

type JsonRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new ReleaseControlError("SUBJECT_RUNTIME_CONFIG_INVALID", message, 400);
}

function asRecord(value: unknown, message = "Runtime config must be an object"): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(message);
  return value as JsonRecord;
}

function assertExactKeys(record: JsonRecord, keys: readonly string[], message: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(message);
  }
}

function requireString(value: unknown, message: string, maxLength = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) invalid(message);
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid(message);
  return value;
}

function requireSha256(value: unknown, message: string): string {
  const digest = requireString(value, message, 71);
  if (!SHA256_PATTERN.test(digest)) invalid(message);
  return digest;
}

function requirePositiveInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(message);
  return value as number;
}

function requireCount(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(message);
  return value as number;
}

function requireIssuedAt(value: unknown): string {
  const issuedAt = requireString(value, "issuedAt must be a canonical ISO timestamp", 64);
  const parsed = new Date(issuedAt);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== issuedAt) {
    invalid("issuedAt must be a canonical ISO timestamp");
  }
  return issuedAt;
}

function normalizeRuntimeVariable(value: unknown): SubjectRuntimeVariable {
  const record = asRecord(value, "Runtime variable must be an object");
  assertExactKeys(record, ["name", "value"], "Runtime variable fields are invalid");
  const name = requireString(record.name, "Runtime variable name is invalid", 128);
  if (!ENV_NAME_PATTERN.test(name)) invalid("Runtime variable name is invalid");
  if (SECRET_VARIABLE_PATTERN.test(name)) {
    throw new ReleaseControlError(
      "SUBJECT_RUNTIME_CONFIG_SECRET_PLAINTEXT_FORBIDDEN",
      "Secret-bearing runtime values must use a versioned secret reference",
      400,
    );
  }
  const variableValue = requireString(record.value, "Runtime variable value is invalid");
  if (/\r|\n/u.test(variableValue)) invalid("Runtime variable value is invalid");
  return Object.freeze({ name, value: variableValue });
}

function normalizeRuntimeSecret(value: unknown): SubjectRuntimeSecretRef {
  const record = asRecord(value, "Runtime secret reference must be an object");
  assertExactKeys(
    record,
    ["name", "secretRef", "secretVersion", "secretSha256"],
    "Runtime secret reference fields are invalid",
  );
  const name = requireString(record.name, "Runtime secret name is invalid", 128);
  if (!ENV_NAME_PATTERN.test(name)) invalid("Runtime secret name is invalid");
  const secretRef = requireString(record.secretRef, "Runtime secret reference is invalid", 512);
  if (!/^secret:\/\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/u.test(secretRef)) {
    invalid("Runtime secret reference is invalid");
  }
  const secretVersion = requireString(record.secretVersion, "Runtime secret version is invalid", 128);
  if (!SAFE_TOKEN_PATTERN.test(secretVersion)) invalid("Runtime secret version is invalid");
  const secretSha256 = requireSha256(record.secretSha256, "Runtime secret digest is invalid");
  return Object.freeze({ name, secretRef, secretVersion, secretSha256 });
}

function normalizeRuntime(value: unknown): SubjectRuntimeValues {
  const record = asRecord(value, "Runtime values must be an object");
  assertExactKeys(record, ["schema", "variables", "secrets"], "Runtime values fields are invalid");
  if (record.schema !== SUBJECT_RUNTIME_VALUES_SCHEMA) invalid("Runtime values schema is invalid");
  if (!Array.isArray(record.variables) || !Array.isArray(record.secrets)) {
    invalid("Runtime variables and secrets must be arrays");
  }
  if (record.variables.length > 256 || record.secrets.length > 256) {
    invalid("Runtime values exceed the bounded entry count");
  }
  const variables = record.variables.map(normalizeRuntimeVariable).sort((a, b) => a.name.localeCompare(b.name));
  const secrets = record.secrets.map(normalizeRuntimeSecret).sort((a, b) => a.name.localeCompare(b.name));
  const names = [...variables.map((entry) => entry.name), ...secrets.map((entry) => entry.name)];
  if (new Set(names).size !== names.length) invalid("Runtime value names must be unique");
  return Object.freeze({
    schema: SUBJECT_RUNTIME_VALUES_SCHEMA,
    variables: Object.freeze(variables),
    secrets: Object.freeze(secrets),
  });
}

function normalizeRoleClaims(value: unknown): readonly SubjectRuntimeRoleClaim[] {
  if (!Array.isArray(value) || value.length !== SUBJECT_RELEASE_UNIT_IDS.length) {
    invalid("Runtime role claims must cover the complete subject unit set");
  }
  const claims = value.map((entry) => {
    const record = asRecord(entry, "Runtime role claim must be an object");
    assertExactKeys(record, ["role", "artifactSha256"], "Runtime role claim fields are invalid");
    if (!SUBJECT_RELEASE_UNIT_IDS.includes(record.role as SubjectReleaseUnitId)) {
      invalid("Runtime role claim role is invalid");
    }
    return Object.freeze({
      role: record.role as SubjectReleaseUnitId,
      artifactSha256: requireSha256(record.artifactSha256, "Runtime role artifact digest is invalid"),
    });
  });
  const byRole = new Map(claims.map((claim) => [claim.role, claim]));
  if (byRole.size !== SUBJECT_RELEASE_UNIT_IDS.length) {
    invalid("Runtime role claims must contain each subject role exactly once");
  }
  return Object.freeze(SUBJECT_RELEASE_UNIT_IDS.map((role) => byRole.get(role)!));
}

function normalizeArtifactSet(value: unknown, roleClaims: readonly SubjectRuntimeRoleClaim[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SUBJECT_RELEASE_UNIT_IDS.length) {
    invalid("Compatible artifact digests are invalid");
  }
  const artifacts = value.map((entry) => requireSha256(entry, "Compatible artifact digest is invalid"));
  if (new Set(artifacts).size !== artifacts.length) invalid("Compatible artifact digests must be unique");
  artifacts.sort();
  const roleArtifacts = [...new Set(roleClaims.map((claim) => claim.artifactSha256))].sort();
  if (canonicalJson(artifacts) !== canonicalJson(roleArtifacts)) {
    invalid("Compatible artifact digests must equal the role claim artifact set");
  }
  return Object.freeze(artifacts);
}

export function validateSubjectRuntimeStorage(value: unknown): SubjectRuntimeStorage {
  const record = asRecord(value, "Runtime storage must be an object");
  assertExactKeys(
    record,
    ["provider", "bucket", "region", "endpoint", "keyPrefix", "forcePathStyle"],
    "Runtime storage fields are invalid",
  );
  if (record.provider !== "tos-s3") invalid("Runtime storage provider is invalid");
  const bucket = requireString(record.bucket, "Runtime storage bucket is invalid", 63);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) || bucket.includes("..")) {
    invalid("Runtime storage bucket is invalid");
  }
  const region = requireString(record.region, "Runtime storage region is invalid", 64);
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u.test(region)) invalid("Runtime storage region is invalid");
  const endpointInput = requireString(record.endpoint, "Runtime storage endpoint is invalid", 512);
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpointInput);
  } catch {
    invalid("Runtime storage endpoint is invalid");
  }
  if (
    endpointUrl.protocol !== "https:"
    || endpointUrl.username !== ""
    || endpointUrl.password !== ""
    || endpointUrl.search !== ""
    || endpointUrl.hash !== ""
    || (endpointUrl.pathname !== "" && endpointUrl.pathname !== "/")
  ) {
    invalid("Runtime storage endpoint must be an HTTPS origin");
  }
  const keyPrefix = requireString(record.keyPrefix, "Runtime storage key prefix is invalid", 512);
  if (
    keyPrefix.startsWith("/")
    || !keyPrefix.endsWith("/")
    || keyPrefix.includes("//")
    || keyPrefix.split("/").some((segment) => segment === "." || segment === "..")
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/u.test(keyPrefix)
  ) {
    invalid("Runtime storage key prefix is invalid");
  }
  if (typeof record.forcePathStyle !== "boolean") invalid("Runtime storage forcePathStyle is invalid");
  return Object.freeze({
    provider: "tos-s3",
    bucket,
    region,
    endpoint: endpointUrl.origin,
    keyPrefix,
    forcePathStyle: record.forcePathStyle,
  });
}

function normalizeInput(value: unknown, envelope: boolean): SubjectRuntimeConfigInput {
  const record = asRecord(value);
  assertExactKeys(
    record,
    envelope
      ? ["schema", "configSha", "revision", "issuedAt", "compatibleArtifactSha256", "roleClaims", "runtime", "storage", "attestation"]
      : ["revision", "issuedAt", "compatibleArtifactSha256", "roleClaims", "runtime", "storage"],
    "Runtime config fields are invalid",
  );
  const roleClaims = normalizeRoleClaims(record.roleClaims);
  return Object.freeze({
    revision: requirePositiveInteger(record.revision, "Runtime config revision is invalid"),
    issuedAt: requireIssuedAt(record.issuedAt),
    compatibleArtifactSha256: normalizeArtifactSet(record.compatibleArtifactSha256, roleClaims),
    roleClaims,
    runtime: normalizeRuntime(record.runtime),
    storage: validateSubjectRuntimeStorage(record.storage),
  });
}

function configContent(input: SubjectRuntimeConfigInput): Readonly<Record<string, unknown>> {
  return {
    schema: "fanjin-subject-runtime-config-content/v1",
    compatibleArtifactSha256: input.compatibleArtifactSha256,
    roleClaims: input.roleClaims,
    runtime: input.runtime,
    storage: input.storage,
  };
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function subjectRuntimeConfigSha(value: SubjectRuntimeConfigInput | SubjectRuntimeConfig): string {
  const record = asRecord(value);
  const normalized = normalizeInput(record, record.schema === SUBJECT_RUNTIME_CONFIG_SCHEMA);
  return digestCanonical(configContent(normalized));
}

function validateSigner(signer: SubjectEd25519Signer): void {
  invariant(
    signer.algorithm === "Ed25519" && SHA256_PATTERN.test(signer.keyId) && typeof signer.sign === "function",
    "SUBJECT_RUNTIME_CONFIG_SIGNER_INVALID",
    "Runtime config signer is invalid",
    500,
  );
}

async function createAttestation(
  payload: Readonly<Record<string, unknown>>,
  signer: SubjectEd25519Signer,
): Promise<SubjectRuntimeAttestation> {
  validateSigner(signer);
  let signature: Uint8Array;
  try {
    signature = await signer.sign(Buffer.from(canonicalJson(payload), "utf8"));
  } catch {
    throw new ReleaseControlError(
      "SUBJECT_RUNTIME_CONFIG_SIGNING_FAILED",
      "Runtime config signing failed",
      500,
    );
  }
  invariant(signature.byteLength === 64, "SUBJECT_RUNTIME_CONFIG_SIGNER_INVALID", "Runtime config signer returned an invalid signature", 500);
  return Object.freeze({
    schema: SUBJECT_RUNTIME_ATTESTATION_SCHEMA,
    algorithm: "Ed25519",
    keyId: signer.keyId,
    signature: Buffer.from(signature).toString("base64"),
  });
}

function normalizeAttestation(value: unknown): SubjectRuntimeAttestation {
  const record = asRecord(value, "Runtime config attestation must be an object");
  assertExactKeys(record, ["schema", "algorithm", "keyId", "signature"], "Runtime config attestation fields are invalid");
  if (record.schema !== SUBJECT_RUNTIME_ATTESTATION_SCHEMA || record.algorithm !== "Ed25519") {
    invalid("Runtime config attestation is invalid");
  }
  const keyId = requireSha256(record.keyId, "Runtime config attestation key ID is invalid");
  const signatureText = requireString(record.signature, "Runtime config signature is invalid", 128);
  const signature = Buffer.from(signatureText, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== signatureText) {
    invalid("Runtime config signature is invalid");
  }
  return Object.freeze({
    schema: SUBJECT_RUNTIME_ATTESTATION_SCHEMA,
    algorithm: "Ed25519",
    keyId,
    signature: signatureText,
  });
}

function verifyAttestation(
  payload: Readonly<Record<string, unknown>>,
  attestation: SubjectRuntimeAttestation,
  trustedPublicKeys: readonly SubjectEd25519TrustKey[],
  invalidCode: string,
  invalidMessage: string,
): void {
  const trust = trustedPublicKeys.find((entry) => entry.keyId === attestation.keyId);
  if (!trust) throw new ReleaseControlError(invalidCode, invalidMessage, 403);
  try {
    if (!SHA256_PATTERN.test(trust.keyId) || typeof trust.publicKeyPem !== "string") throw new Error("invalid trust entry");
    const key = createPublicKey(trust.publicKeyPem);
    const der = key.export({ type: "spki", format: "der" });
    const derivedKeyId = `sha256:${createHash("sha256").update(der).digest("hex")}`;
    if (key.asymmetricKeyType !== "ed25519" || derivedKeyId !== trust.keyId) throw new Error("invalid trust identity");
    const valid = verifySignature(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      key,
      Buffer.from(attestation.signature, "base64"),
    );
    if (!valid) throw new Error("invalid signature");
  } catch {
    throw new ReleaseControlError(invalidCode, invalidMessage, 403);
  }
}

function unsignedConfig(normalized: SubjectRuntimeConfigInput, configSha: string): Omit<SubjectRuntimeConfig, "attestation"> {
  return Object.freeze({
    schema: SUBJECT_RUNTIME_CONFIG_SCHEMA,
    configSha,
    revision: normalized.revision,
    issuedAt: normalized.issuedAt,
    compatibleArtifactSha256: normalized.compatibleArtifactSha256,
    roleClaims: normalized.roleClaims,
    runtime: normalized.runtime,
    storage: normalized.storage,
  });
}

export async function createSubjectRuntimeConfig(
  input: SubjectRuntimeConfigInput,
  signer: SubjectEd25519Signer,
): Promise<SubjectRuntimeConfig> {
  const normalized = normalizeInput(input, false);
  const configSha = digestCanonical(configContent(normalized));
  const unsigned = unsignedConfig(normalized, configSha);
  const attestation = await createAttestation(unsigned, signer);
  return Object.freeze({ ...unsigned, attestation });
}

export function verifySubjectRuntimeConfig(
  value: unknown,
  trustedPublicKeys: readonly SubjectEd25519TrustKey[],
): SubjectRuntimeConfig {
  const record = asRecord(value);
  if (record.schema !== SUBJECT_RUNTIME_CONFIG_SCHEMA) invalid("Runtime config schema is invalid");
  const normalized = normalizeInput(record, true);
  const claimedSha = requireSha256(record.configSha, "Runtime config digest is invalid");
  const expectedSha = digestCanonical(configContent(normalized));
  if (claimedSha !== expectedSha) {
    throw new ReleaseControlError(
      "SUBJECT_RUNTIME_CONFIG_SHA_MISMATCH",
      "Runtime config digest does not match its normalized content",
      409,
    );
  }
  const attestation = normalizeAttestation(record.attestation);
  const unsigned = unsignedConfig(normalized, claimedSha);
  verifyAttestation(
    unsigned,
    attestation,
    trustedPublicKeys,
    "SUBJECT_RUNTIME_CONFIG_TRUST_INVALID",
    "Runtime config is not signed by an external trusted Ed25519 key",
  );
  return Object.freeze({ ...unsigned, attestation });
}

function normalizeCanary(value: unknown): SubjectStorageCanaryEvidence {
  const record = asRecord(value, "Storage canary evidence must be an object");
  assertExactKeys(
    record,
    ["objectKeySha256", "payloadSha256", "observedGenerations", "deletedGenerations", "remainingGenerations"],
    "Storage canary evidence fields are invalid",
  );
  return Object.freeze({
    objectKeySha256: requireSha256(record.objectKeySha256, "Storage canary object key digest is invalid"),
    payloadSha256: requireSha256(record.payloadSha256, "Storage canary payload digest is invalid"),
    observedGenerations: requireCount(record.observedGenerations, "Storage canary observed generation count is invalid"),
    deletedGenerations: requireCount(record.deletedGenerations, "Storage canary deleted generation count is invalid"),
    remainingGenerations: requireCount(record.remainingGenerations, "Storage canary remaining generation count is invalid"),
  });
}

function receiptContent(input: Readonly<{
  configSha: string;
  configRevisionPrepared: number;
  artifactSha256: string;
  role: SubjectReleaseUnitId;
  storage: SubjectRuntimeStorage;
  issuedAt: string;
  canary: SubjectStorageCanaryEvidence;
}>): Readonly<Record<string, unknown>> {
  return {
    schema: SUBJECT_STORAGE_CAPABILITY_RECEIPT_SCHEMA,
    configSha: input.configSha,
    configRevisionPrepared: input.configRevisionPrepared,
    artifactSha256: input.artifactSha256,
    role: input.role,
    storage: input.storage,
    issuedAt: input.issuedAt,
    canary: input.canary,
  };
}

function receiptSignedPayload(
  content: Readonly<Record<string, unknown>>,
  receiptSha: string,
): Readonly<Record<string, unknown>> {
  return { ...content, receiptSha };
}

function assertCapabilityBinding(
  config: Pick<SubjectRuntimeConfig, "configSha" | "roleClaims">,
  role: SubjectReleaseUnitId,
  artifactSha256: string,
): void {
  const claim = config.roleClaims.find((entry) => entry.role === role);
  if (!claim || claim.artifactSha256 !== artifactSha256) {
    throw new ReleaseControlError(
      "CONFIG_RECEIPT_MISMATCH",
      "Runtime config capability does not match the requested role and artifact",
      409,
    );
  }
}

export function subjectStorageCapabilityBindingSha(input: Readonly<{
  configSha: string;
  role: SubjectReleaseUnitId;
  artifactSha256: string;
  storage: SubjectRuntimeStorage;
}>): string {
  if (!SUBJECT_RELEASE_UNIT_IDS.includes(input.role)) invalid("Capability binding role is invalid");
  return digestCanonical({
    schema: "fanjin-subject-storage-capability-binding/v1",
    configSha: requireSha256(input.configSha, "Capability binding config digest is invalid"),
    role: input.role,
    artifactSha256: requireSha256(input.artifactSha256, "Capability binding artifact digest is invalid"),
    storage: validateSubjectRuntimeStorage(input.storage),
  });
}

export async function createSubjectStorageCapabilityReceipt(
  input: SubjectStorageCapabilityReceiptInput,
  signer: SubjectEd25519Signer,
): Promise<SubjectStorageCapabilityReceipt> {
  const configRecord = asRecord(input.config);
  const normalizedConfig = normalizeInput(configRecord, true);
  const expectedConfigSha = digestCanonical(configContent(normalizedConfig));
  if (input.config.configSha !== expectedConfigSha) {
    throw new ReleaseControlError("SUBJECT_RUNTIME_CONFIG_SHA_MISMATCH", "Runtime config digest is invalid", 409);
  }
  if (!SUBJECT_RELEASE_UNIT_IDS.includes(input.role)) invalid("Capability receipt role is invalid");
  const artifactSha256 = requireSha256(input.artifactSha256, "Capability receipt artifact digest is invalid");
  assertCapabilityBinding(input.config, input.role, artifactSha256);
  const canary = normalizeCanary(input.canary);
  if (
    canary.observedGenerations < 1
    || canary.deletedGenerations !== canary.observedGenerations
    || canary.remainingGenerations !== 0
  ) {
    throw new ReleaseControlError(
      "SUBJECT_CONFIG_RECEIPT_INVALID",
      "Storage capability receipt requires proven zero remaining generations",
      409,
    );
  }
  const issuedAt = requireIssuedAt(input.issuedAt);
  const content = receiptContent({
    configSha: input.config.configSha,
    configRevisionPrepared: input.config.revision,
    artifactSha256,
    role: input.role,
    storage: input.config.storage,
    issuedAt,
    canary,
  });
  const receiptSha = digestCanonical(content);
  const attestation = await createAttestation(receiptSignedPayload(content, receiptSha), signer);
  return Object.freeze({
    ...content,
    receiptSha,
    attestation,
  }) as SubjectStorageCapabilityReceipt;
}

function normalizeReceipt(value: unknown): SubjectStorageCapabilityReceipt {
  const record = asRecord(value, "Storage capability receipt must be an object");
  assertExactKeys(
    record,
    ["schema", "receiptSha", "configSha", "configRevisionPrepared", "artifactSha256", "role", "storage", "issuedAt", "canary", "attestation"],
    "Storage capability receipt fields are invalid",
  );
  if (record.schema !== SUBJECT_STORAGE_CAPABILITY_RECEIPT_SCHEMA) invalid("Storage capability receipt schema is invalid");
  if (!SUBJECT_RELEASE_UNIT_IDS.includes(record.role as SubjectReleaseUnitId)) invalid("Storage capability receipt role is invalid");
  return Object.freeze({
    schema: SUBJECT_STORAGE_CAPABILITY_RECEIPT_SCHEMA,
    receiptSha: requireSha256(record.receiptSha, "Storage capability receipt digest is invalid"),
    configSha: requireSha256(record.configSha, "Storage capability config digest is invalid"),
    configRevisionPrepared: requirePositiveInteger(record.configRevisionPrepared, "Storage capability config revision is invalid"),
    artifactSha256: requireSha256(record.artifactSha256, "Storage capability artifact digest is invalid"),
    role: record.role as SubjectReleaseUnitId,
    storage: validateSubjectRuntimeStorage(record.storage),
    issuedAt: requireIssuedAt(record.issuedAt),
    canary: normalizeCanary(record.canary),
    attestation: normalizeAttestation(record.attestation),
  });
}

export function verifySubjectStorageCapabilityReceipt(
  value: unknown,
  configValue: unknown,
  capabilityReceiptTrustedPublicKeys: readonly SubjectEd25519TrustKey[],
  configTrustedPublicKeys: readonly SubjectEd25519TrustKey[] = capabilityReceiptTrustedPublicKeys,
): SubjectStorageCapabilityReceipt {
  const receiptRecord = asRecord(value, "Storage capability receipt must be an object");
  const configRecord = asRecord(configValue);
  if (receiptRecord.configSha !== configRecord.configSha) {
    throw new ReleaseControlError("CONFIG_RECEIPT_MISMATCH", "Capability receipt does not match the runtime config", 409);
  }
  const config = verifySubjectRuntimeConfig(configValue, configTrustedPublicKeys);
  let receipt: SubjectStorageCapabilityReceipt;
  try {
    receipt = normalizeReceipt(receiptRecord);
  } catch (error) {
    if (error instanceof ReleaseControlError && error.code === "CONFIG_RECEIPT_MISMATCH") throw error;
    throw new ReleaseControlError("SUBJECT_CONFIG_RECEIPT_INVALID", "Storage capability receipt is invalid", 409);
  }
  if (
    receipt.configSha !== config.configSha
    || canonicalJson(receipt.storage) !== canonicalJson(config.storage)
  ) {
    throw new ReleaseControlError("CONFIG_RECEIPT_MISMATCH", "Capability receipt does not match the runtime config", 409);
  }
  assertCapabilityBinding(config, receipt.role, receipt.artifactSha256);
  if (
    receipt.canary.observedGenerations < 1
    || receipt.canary.deletedGenerations !== receipt.canary.observedGenerations
    || receipt.canary.remainingGenerations !== 0
  ) {
    throw new ReleaseControlError("SUBJECT_CONFIG_RECEIPT_INVALID", "Storage capability cleanup proof is invalid", 409);
  }
  const content = receiptContent(receipt);
  if (receipt.receiptSha !== digestCanonical(content)) {
    throw new ReleaseControlError("SUBJECT_CONFIG_RECEIPT_INVALID", "Storage capability receipt digest is invalid", 409);
  }
  verifyAttestation(
    receiptSignedPayload(content, receipt.receiptSha),
    receipt.attestation,
    capabilityReceiptTrustedPublicKeys,
    "SUBJECT_CONFIG_RECEIPT_INVALID",
    "Storage capability receipt signature is invalid",
  );
  return receipt;
}

