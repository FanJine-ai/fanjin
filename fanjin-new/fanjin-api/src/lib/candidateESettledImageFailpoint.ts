import { guStringFromMicros } from "./billingUnits";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Knex } from "knex";

import type { RelayUnitBillingCheckpoint } from "@/lib/relayBillingSession";
import { ceilGuChargeMicros } from "@/lib/billingUnits";
import {
  candidateExactAuthorizationDigest,
  type CandidateExactAuthorizationRuntimeSession,
} from "@/lib/candidateExactAuthorizationCanonical";
import type {
  CandidateExactAuthorizationTrustEnvironment,
} from "@/lib/candidateExactAuthorizationTrust";
import {
  CandidateExactAuthorizationQuoteReadError,
  candidateExactAuthorizationOperationRequests,
  resolveCandidateExactAuthorizationCanonicalOperation,
  type CandidateExactAuthorizationOperationRequest,
} from "@/lib/candidateExactAuthorizationQuoteReadModel";
import {
  RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV,
} from "@/lib/releaseArtifactAttestation";
import { candidateExactAuthorizationCanonicalJson } from "../../scripts/lib/candidate-exact-authorization-package";
import {
  CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV,
  CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV,
  CandidateExactAuthorizationV2Error,
  assertCandidateExactAuthorizationGuardPayload,
  consumeCandidateExactAuthorizationPackage,
  readCandidateExactAuthorizationRuntimePackageSnapshot,
  type CandidateExactAuthorizationConsumption,
} from "../../scripts/lib/candidate-exact-authorization-v2";
import {
  CANDIDATE_INDEPENDENT_LAUNCHER_MAX_LIFETIME_MS,
} from "../../scripts/lib/candidate-independent-launcher-attestation";
import type { ReleaseCandidateSessionIdentity } from "../../scripts/lib/release-candidate-session-identity";

export const CANDIDATE_E_SETTLED_IMAGE_FAILPOINT_HEADER =
  "x-fanjin-candidate-e-settled-failpoint";
export const CANDIDATE_E_SETTLED_IMAGE_FAILPOINT_VALUE =
  "settled-before-materialization-v1";
export const CANDIDATE_E_SETTLED_IMAGE_ARMING_HEADER =
  "x-fanjin-candidate-e-arming-file";
export const CANDIDATE_E_SETTLED_IMAGE_ACK_HEADER =
  "x-fanjin-candidate-e-ack-proof";
export const CANDIDATE_E_SETTLED_IMAGE_QUOTE_HEADER =
  "x-fanjin-candidate-e-live-quote";
export const CANDIDATE_E_SETTLED_IMAGE_QUOTE_VALUE =
  "read-only-exact-route-price-v1";
export const CANDIDATE_E_SETTLED_IMAGE_ACK_ENV =
  "FANJIN_CANDIDATE_E_SETTLED_IMAGE_ACK";
export const CANDIDATE_E_SETTLED_IMAGE_ACK_VALUE =
  "I_ACCEPT_EXACTLY_ONE_PAID_IMAGE_CALL_THEN_SETTLED_CHECKPOINT_FAILURE";
export const CANDIDATE_E_SETTLED_IMAGE_ARMING_VERSION =
  "fanjin-candidate-e-settled-image-arming/v1" as const;
export const CANDIDATE_E_SETTLED_IMAGE_QUOTE_VERSION =
  "fanjin-candidate-e-live-image-quote/v1" as const;
export const CANDIDATE_E_SETTLED_IMAGE_QUOTE_LIFETIME_MS =
  CANDIDATE_INDEPENDENT_LAUNCHER_MAX_LIFETIME_MS;
export const CANDIDATE_E_SETTLED_IMAGE_ABSORBED_AUTHORIZATION_VERSION =
  "fanjin-candidate-e-absorbed-full-matrix-authorization/v1" as const;
export const CANDIDATE_E_SETTLED_IMAGE_GUARD_SUFFIX = ".started";
export const CANDIDATE_E_SETTLED_IMAGE_RECEIPT_SUFFIX = ".settled";
export const CANDIDATE_E_FULL_MATRIX_PAID_GUARD_SUFFIX =
  ".paid-full-matrix.started";

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_QUOTE_LIFETIME_MS = 5 * 60_000;
const CANDIDATE_E_OPERATION_CONSUMPTION_EXPIRES_AT =
  Date.UTC(9999, 11, 31, 23, 59, 59);
const CANDIDATE_EXACT_AUTHORIZATION_GUARD_FORMAT =
  "fanjin-candidate-exact-authorization-paid-guard/v2";
const CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FORMAT =
  "fanjin-candidate-exact-authorization-activation-package/v2";
const CANDIDATE_E_FULL_MATRIX_DRIVER_SCRIPT =
  "scripts/verify-workbench-full-matrix-real-candidate.ts";
const FULL_MATRIX_PAID_GUARD_VERSION =
  "fanjin-workbench-full-matrix-paid-guard/v3";
const FULL_MATRIX_PLAN_VERSION = "fanjin-workbench-full-matrix-plan/v4";
const FULL_MATRIX_MANIFEST_VERSION =
  "fanjin-workbench-full-matrix-evidence/v5";
const FULL_MATRIX_PAID_ACK_VALUE =
  "I_ACCEPT_EXACTLY_41_REAL_UPSTREAM_REQUESTS_FULL_MATRIX_NO_AUTOMATIC_RETRY";
const AUTHORIZATION_PACKAGE_PATH_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/package-path/v2";
const AUTHORIZATION_GUARD_FILE_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/guard-file/v2";

export type CandidateEAbsorbedFullMatrixAuthorization = {
  version: typeof CANDIDATE_E_SETTLED_IMAGE_ABSORBED_AUTHORIZATION_VERSION;
  candidateKey: "full-matrix/mixed";
  authorizationPackageFile: string;
  authorizationPackageFileDigest: string;
  authorizationPackageIdentityBinding: string | null;
  packageDigest: string;
  entryDigest: string;
  operationKey: string;
  operationDigest: string;
  operationModel: string;
  operationProvider: string;
  operationRouteAlias: string;
  operationMaximumGuMicros: number;
  directoryEntryDigest: string;
  routeEntryDigest: string;
  pricingEntryDigest: string;
  parameterDigest: string;
  pricingComponentsDigest: string;
  operationRatio: string;
  operationQuality: string;
  operationCount: 1;
  guardConsumptionProofDigest: string;
  authorizationSessionBinding: string;
  driverSessionBinding: string;
  fullMatrixGuardFile: string;
  guardFilePathBinding: string;
  fullMatrixGuardDigest: string;
  guardInodeBinding: string;
  guardDigest: string;
};

export type CandidateESettledImageQuote = {
  version: typeof CANDIDATE_E_SETTLED_IMAGE_QUOTE_VERSION;
  endpointType: "image_generation";
  workspaceId: string;
  model: string;
  provider: string;
  channelId: string;
  routeId: string;
  routeAlias: string;
  routeUpdatedAt: number;
  pricingRuleId: string;
  pricingRuleUpdatedAt: number;
  unit: "image";
  unitPriceMicros: number;
  multiplier: number;
  minimumMicros: number;
  requestUnits: 1;
  ratio: string;
  quality: string;
  maximumCostMicros: number;
  currency: "GU";
  routeDigest: string;
  issuedAt: number;
  expiresAt: number;
};

export type CandidateESettledImageArmingManifest = {
  version: typeof CANDIDATE_E_SETTLED_IMAGE_ARMING_VERSION;
  operationBinding: string;
  candidateBinding: string;
  sessionBinding: string;
  freezeReceiptDigest: string;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  idempotencyKeySha256: string;
  requestHash: string;
  model: string;
  count: 1;
  maxGuMicros: number;
  absorbedAuthorization: CandidateEAbsorbedFullMatrixAuthorization;
  quote: CandidateESettledImageQuote;
  quoteDigest: string;
  acknowledgementNonce: string;
  createdAt: number;
};

export type CandidateESettledImageAuthorization = {
  armingFile: string;
  guardFile: string;
  receiptFile: string;
  manifest: CandidateESettledImageArmingManifest;
  manifestDigest: string;
  fullMatrixGuardFile: string;
  exactAuthorization: CandidateExactAuthorizationConsumption;
  exactAuthorizationContext: {
    session: {
      apiBaseUrl: string;
      workspaceId: string;
      projectId: number;
      userId: number;
      createdAt: string;
      candidateIdentity: ReleaseCandidateSessionIdentity;
    };
    trustEnvironment: Record<string, string | undefined>;
  };
};

export type CandidateESettledImageCommandIdentity = {
  id: string;
  workspaceId: string;
  actorUserId: number;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
};

export type CandidateEOperationClaim = {
  id: string;
  workspaceId: string;
  actorUserId: number;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  resourceId: string;
  lineageDigest: string;
  ownerDigest: string;
  processingResponseBody: string;
};

export class CandidateESettledImageFailpointError extends Error {
  readonly status = 403;
  constructor(readonly code: string) {
    super(code);
    this.name = "CandidateESettledImageFailpointError";
  }
}

export class CandidateESettledImageInjectedFailure extends Error {
  readonly status = 500;
  readonly code = "candidate_e_settled_before_materialization_injected";
  constructor() {
    super("Candidate E settled checkpoint failpoint injected");
    this.name = "CandidateESettledImageInjectedFailure";
  }
}

function fail(code: string): never {
  throw new CandidateESettledImageFailpointError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function candidateEStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(candidateEStableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${candidateEStableJson(value[key])}`
    )).join(",")}}`;
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value)
  ) return JSON.stringify(value);
  throw new Error("CANDIDATE_E_CANONICAL_VALUE_INVALID");
}

export function candidateESha256(value: string | Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactAuthorizationDigest(value: unknown): string {
  return candidateESha256(candidateExactAuthorizationCanonicalJson(value));
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeCandidateIdentity(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail("candidate_e_session_identity_invalid");
  const requiredStringKeys = [
    "format",
    "evidenceClass",
    "freezeReceiptDigest",
    "freezeSha256",
    "releaseUuid",
    "artifactUuid",
    "artifactSha256",
    "artifactSignedManifestSha256",
    "sourceDigest",
    "configExpectedSha256",
    "schemaExpectedSha256",
    "attestationKeyId",
  ] as const;
  if (
    requiredStringKeys.some((key) => !String(value[key] || "").trim())
    || !HEX_SHA256.test(String(value.freezeReceiptDigest || ""))
    || !HEX_SHA256.test(String(value.freezeSha256 || ""))
    || !HEX_SHA256.test(String(value.artifactSha256 || ""))
    || !HEX_SHA256.test(String(value.artifactSignedManifestSha256 || ""))
    || !HEX_SHA256.test(String(value.configExpectedSha256 || ""))
    || !HEX_SHA256.test(String(value.schemaExpectedSha256 || ""))
    || typeof value.formalB0Eligible !== "boolean"
    || typeof value.runtimeArtifactBindingVerified !== "boolean"
  ) fail("candidate_e_session_identity_invalid");
  return value;
}

export function candidateEIdentityBinding(identity: Record<string, unknown>): string {
  return candidateESha256(candidateEStableJson(identity));
}

export function candidateESessionBinding(session: {
  workspaceId: string;
  userId: number;
  projectId: number;
  createdAt: string;
  candidateIdentity: Record<string, unknown>;
}): string {
  return candidateESha256(candidateEStableJson({
    workspaceId: session.workspaceId,
    userId: session.userId,
    projectId: session.projectId,
    createdAt: session.createdAt,
    candidateBinding: candidateEIdentityBinding(session.candidateIdentity),
  }));
}

export function candidateEQuoteDigest(quote: CandidateESettledImageQuote): string {
  return candidateESha256(candidateEStableJson(quote));
}

export function candidateEAbsorbedAuthorizationDigest(
  authorization: CandidateEAbsorbedFullMatrixAuthorization,
): string {
  return candidateESha256(candidateEStableJson(authorization));
}

export function candidateEAcknowledgementProof(
  manifestDigest: string,
  nonce: string,
  acknowledgement = CANDIDATE_E_SETTLED_IMAGE_ACK_VALUE,
): string {
  return candidateESha256(`${acknowledgement}:${manifestDigest}:${nonce}`);
}

function assertLoopbackUrl(raw: unknown): void {
  let parsed: URL;
  try {
    parsed = new URL(String(raw || ""));
  } catch {
    return fail("candidate_e_session_endpoint_invalid");
  }
  if (
    parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.username
    || parsed.password
  ) fail("candidate_e_session_endpoint_invalid");
}

function readProtectedFile(
  file: string,
  code: string,
  maximumBytes = MAX_FILE_BYTES,
): { bytes: Buffer; stat: fs.Stats; canonicalPath: string } {
  let descriptor: number | undefined;
  try {
    if (!path.isAbsolute(file) || path.normalize(file) !== file) fail(code);
    const before = fs.lstatSync(file);
    const canonicalPath = fs.realpathSync(file);
    if (
      canonicalPath !== file
      || before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || before.size < 2
      || before.size > maximumBytes
      || (before.mode & 0o777) !== 0o600
      || typeof process.getuid === "function" && before.uid !== process.getuid()
    ) fail(code);
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY
        | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) fail(code);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || bytes.byteLength !== opened.size
    ) fail(code);
    return { bytes, stat: after, canonicalPath };
  } catch (error) {
    if (error instanceof CandidateESettledImageFailpointError) throw error;
    return fail(code);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readProtectedBytes(
  file: string,
  code: string,
  maximumBytes = MAX_FILE_BYTES,
): Buffer {
  return readProtectedFile(file, code, maximumBytes).bytes;
}

function candidateERuntimePackageBinding(
  binding: CandidateEAbsorbedFullMatrixAuthorization,
): Readonly<{
  ownerUid: number;
  ownerGid: number;
  expectedIdentityBinding: string;
}> | undefined {
  if (binding.authorizationPackageIdentityBinding === null) return undefined;
  return Object.freeze({
    ownerUid: typeof process.getuid === "function" ? process.getuid() : 0,
    ownerGid: typeof process.getgid === "function" ? process.getgid() : 0,
    expectedIdentityBinding: binding.authorizationPackageIdentityBinding,
  });
}

function readCandidateEAuthorizationPackage(
  binding: CandidateEAbsorbedFullMatrixAuthorization,
): { bytes: Buffer; canonicalPath: string } {
  const runtimePackage = candidateERuntimePackageBinding(binding);
  if (!runtimePackage) {
    const readback = readProtectedFile(
      binding.authorizationPackageFile,
      "candidate_e_authorization_package_invalid",
      MAX_AUTHORIZATION_PACKAGE_BYTES,
    );
    return { bytes: readback.bytes, canonicalPath: readback.canonicalPath };
  }
  try {
    const readback = readCandidateExactAuthorizationRuntimePackageSnapshot({
      filePath: binding.authorizationPackageFile,
      ...runtimePackage,
    });
    return {
      bytes: readback.bytes,
      canonicalPath: readback.identity.canonicalPath,
    };
  } catch (error) {
    if (error instanceof CandidateESettledImageFailpointError) throw error;
    return fail("candidate_e_authorization_package_invalid");
  }
}

function parseJsonBytes(bytes: Buffer, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) fail(code);
    return parsed;
  } catch (error) {
    if (error instanceof CandidateESettledImageFailpointError) throw error;
    return fail(code);
  }
}

function readProtectedJson(
  file: string,
  code: string,
  maximumBytes = MAX_FILE_BYTES,
): Record<string, unknown> {
  return parseJsonBytes(readProtectedBytes(file, code, maximumBytes), code);
}

function exactAuthorizationSessionBinding(session: {
  workspaceId: string;
  userId: number;
  projectId: number;
  createdAt: string;
  candidateIdentity: Record<string, unknown>;
}): string {
  return candidateESha256([
    "fanjin-candidate-exact-authorization/session/v2",
    session.workspaceId,
    String(session.projectId),
    String(session.userId),
    session.createdAt,
    candidateEStableJson(session.candidateIdentity),
  ].join("\0"));
}

function exactAuthorizationWorkspaceBinding(workspaceId: string): string {
  return candidateESha256([
    "fanjin-candidate-exact-authorization/workspace/v2",
    workspaceId,
  ].join("\0"));
}

function fullMatrixSessionBinding(session: {
  workspaceId: string;
  userId: number;
  projectId: number;
  createdAt: string;
  candidateIdentity: Record<string, unknown>;
}): string {
  const identity = session.candidateIdentity;
  return candidateESha256([
    FULL_MATRIX_MANIFEST_VERSION,
    session.workspaceId,
    session.projectId,
    session.userId,
    session.createdAt,
    identity.format,
    identity.evidenceClass,
    String(identity.formalB0Eligible),
    String(identity.runtimeArtifactBindingVerified),
    identity.freezeReceiptDigest,
    identity.freezeSha256,
    identity.releaseUuid,
    identity.artifactUuid,
    identity.artifactSha256,
    identity.artifactSignedManifestSha256,
    identity.sourceDigest,
    identity.configExpectedSha256,
    identity.schemaExpectedSha256,
    identity.attestationKeyId,
  ].join(":"));
}

function validateAbsorbedAuthorizationShape(
  value: unknown,
): CandidateEAbsorbedFullMatrixAuthorization {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "candidateKey", "authorizationPackageFile",
    "authorizationPackageFileDigest", "authorizationPackageIdentityBinding",
    "packageDigest", "entryDigest",
    "operationKey", "operationDigest", "operationModel", "operationProvider",
    "operationRouteAlias", "operationMaximumGuMicros",
    "directoryEntryDigest", "routeEntryDigest", "pricingEntryDigest",
    "parameterDigest", "pricingComponentsDigest", "operationRatio",
    "operationQuality", "operationCount", "guardConsumptionProofDigest",
    "authorizationSessionBinding", "driverSessionBinding",
    "fullMatrixGuardFile", "guardFilePathBinding", "fullMatrixGuardDigest",
    "guardInodeBinding", "guardDigest",
  ])) fail("candidate_e_absorbed_authorization_invalid");
  if (
    value.version !== CANDIDATE_E_SETTLED_IMAGE_ABSORBED_AUTHORIZATION_VERSION
    || value.candidateKey !== "full-matrix/mixed"
    || !path.isAbsolute(String(value.authorizationPackageFile || ""))
    || path.normalize(String(value.authorizationPackageFile || ""))
      !== value.authorizationPackageFile
    || !SHA256.test(String(value.authorizationPackageFileDigest || ""))
    || (
      value.authorizationPackageIdentityBinding !== null
      && !SHA256.test(String(value.authorizationPackageIdentityBinding || ""))
    )
    || !SHA256.test(String(value.packageDigest || ""))
    || !SHA256.test(String(value.entryDigest || ""))
    || !ID.test(String(value.operationKey || ""))
    || !String(value.operationKey).startsWith("image/")
    || !SHA256.test(String(value.operationDigest || ""))
    || !ID.test(String(value.operationModel || ""))
    || !ID.test(String(value.operationProvider || ""))
    || !ID.test(String(value.operationRouteAlias || ""))
    || !positiveInteger(value.operationMaximumGuMicros)
    || !SHA256.test(String(value.directoryEntryDigest || ""))
    || !SHA256.test(String(value.routeEntryDigest || ""))
    || !SHA256.test(String(value.pricingEntryDigest || ""))
    || !SHA256.test(String(value.parameterDigest || ""))
    || !SHA256.test(String(value.pricingComponentsDigest || ""))
    || !/^\d{1,3}:\d{1,3}$/.test(String(value.operationRatio || ""))
    || !String(value.operationQuality || "").trim()
    || value.operationCount !== 1
    || !SHA256.test(String(value.guardConsumptionProofDigest || ""))
    || !SHA256.test(String(value.authorizationSessionBinding || ""))
    || !SHA256.test(String(value.driverSessionBinding || ""))
    || !path.isAbsolute(String(value.fullMatrixGuardFile || ""))
    || path.normalize(String(value.fullMatrixGuardFile || ""))
      !== value.fullMatrixGuardFile
    || !SHA256.test(String(value.guardFilePathBinding || ""))
    || !SHA256.test(String(value.fullMatrixGuardDigest || ""))
    || !SHA256.test(String(value.guardInodeBinding || ""))
    || !SHA256.test(String(value.guardDigest || ""))
  ) fail("candidate_e_absorbed_authorization_invalid");
  return value as unknown as CandidateEAbsorbedFullMatrixAuthorization;
}

/**
 * Pure authorization validator shared by the route, verifier and full-matrix
 * integration. Callers must perform protected-file readback themselves and
 * pass the exact bytes plus their parsed JSON values.
 */
export function assertCandidateEAbsorbedFullMatrixAuthorization(input: {
  binding: CandidateEAbsorbedFullMatrixAuthorization;
  exactAuthorization: CandidateExactAuthorizationConsumption;
  quote: CandidateESettledImageQuote;
  session: {
    workspaceId: string;
    userId: number;
    projectId: number;
    createdAt: string;
    candidateIdentity: Record<string, unknown>;
  };
  fullMatrixGuardBytes: Buffer | string;
  fullMatrixGuard: unknown;
  fullMatrixGuardCanonicalPath: string;
  fullMatrixGuardStat: { dev: number; ino: number; size: number };
  authorizationPackageBytes: Buffer | string;
  authorizationPackage: unknown;
  authorizationPackageCanonicalPath: string;
  now?: number;
}): void {
  const binding = validateAbsorbedAuthorizationShape(input.binding);
  const quote = input.quote;
  const now = input.now ?? Date.now();
  if (!isRecord(input.fullMatrixGuard) || !exactKeys(input.fullMatrixGuard, [
    "format", "createdAt", "driver", "authorization", "liveReadback",
    "guardDigest",
  ])) fail("candidate_e_full_matrix_guard_invalid");
  const guard = input.fullMatrixGuard;
  const driver = isRecord(guard.driver) ? guard.driver : null;
  const authorization = isRecord(guard.authorization)
    ? guard.authorization
    : null;
  const liveReadback = isRecord(guard.liveReadback)
    ? guard.liveReadback
    : null;
  const captureReadback = liveReadback && isRecord(liveReadback.captureReadback)
    ? liveReadback.captureReadback
    : null;
  const runtimeChallengeResponse = liveReadback
    && isRecord(liveReadback.runtimeChallengeResponse)
      ? liveReadback.runtimeChallengeResponse
      : null;
  if (
    guard.format !== CANDIDATE_EXACT_AUTHORIZATION_GUARD_FORMAT
    || !driver
    || !authorization
    || !liveReadback
    || !captureReadback
    || !runtimeChallengeResponse
    || !exactKeys(driver, [
      "version", "sessionBinding", "manifestBinding",
      "acknowledgementDigest", "planVersion", "planDigest", "plannedCalls",
      "expectedCostLimitMicros", "spendStopMicros",
    ])
    || !exactKeys(authorization, [
      "packageFilePathBinding", "packageFileDigest", "packageDigest",
      "candidateKey", "driverScript", "entryDigest",
      "formalCandidateIdentityDigest",
      "sessionBinding", "workspaceBinding", "walletBinding", "expiresAt",
    ])
    || !exactKeys(liveReadback, [
      "availableMicros", "availableScopeDigest", "billingReadbackDigest",
      "captureReadback", "challengeNonce", "checkedAt", "format",
      "operationsReadbackDigest", "proofDigest", "reservedMicros",
      "runtimeChallenge", "runtimeChallengeResponse",
      "runtimeChallengeResponseDigest", "walletBinding",
    ])
    || !exactKeys(captureReadback, [
      "billingReadback", "readbackDigest", "receipt",
    ])
  ) fail("candidate_e_full_matrix_guard_invalid");
  const { guardDigest: _guardDigest, ...guardBody } = guard;
  const createdAt = Date.parse(String(guard.createdAt || ""));
  const checkedAt = Date.parse(String(liveReadback.checkedAt || ""));
  const expiresAt = Date.parse(String(authorization.expiresAt || ""));
  const canonicalPackagePath = input.authorizationPackageCanonicalPath;
  const canonicalGuardPath = input.fullMatrixGuardCanonicalPath;
  const { proofDigest: _liveProofDigest, ...liveReadbackBody } = liveReadback;
  const expectedGuardPathBinding = candidateESha256([
    AUTHORIZATION_GUARD_FILE_BINDING_DOMAIN,
    canonicalGuardPath,
  ].join("\0"));
  const expectedGuardInodeBinding = candidateESha256([
    AUTHORIZATION_GUARD_FILE_BINDING_DOMAIN,
    String(input.fullMatrixGuardStat.dev),
    String(input.fullMatrixGuardStat.ino),
    String(input.fullMatrixGuardStat.size),
  ].join("\0"));
  const absorbedProofBody = {
    candidateKey: "full-matrix/mixed",
    packageDigest: binding.packageDigest,
    entryDigest: binding.entryDigest,
    operationKey: binding.operationKey,
    operationDigest: binding.operationDigest,
    guardFile: binding.fullMatrixGuardFile,
    guardFilePathBinding: binding.guardFilePathBinding,
    guardFileDigest: binding.fullMatrixGuardDigest,
    guardInodeBinding: binding.guardInodeBinding,
    guardDigest: binding.guardDigest,
    sessionBinding: binding.authorizationSessionBinding,
  };
  if (
    !path.isAbsolute(canonicalPackagePath)
    || path.normalize(canonicalPackagePath) !== canonicalPackagePath
    || canonicalPackagePath !== binding.authorizationPackageFile
    || !path.isAbsolute(canonicalGuardPath)
    || path.normalize(canonicalGuardPath) !== canonicalGuardPath
    || canonicalGuardPath !== binding.fullMatrixGuardFile
    || candidateESha256(input.fullMatrixGuardBytes)
      !== binding.fullMatrixGuardDigest
    || binding.guardFilePathBinding !== expectedGuardPathBinding
    || binding.guardInodeBinding !== expectedGuardInodeBinding
    || binding.guardDigest !== guard.guardDigest
    || binding.guardConsumptionProofDigest
      !== exactAuthorizationDigest(absorbedProofBody)
    || !SHA256.test(String(guard.guardDigest || ""))
    || guard.guardDigest !== exactAuthorizationDigest(guardBody)
    || driver.version !== FULL_MATRIX_PAID_GUARD_VERSION
    || driver.planVersion !== FULL_MATRIX_PLAN_VERSION
    || driver.plannedCalls !== 41
    || driver.acknowledgementDigest
      !== candidateESha256(FULL_MATRIX_PAID_ACK_VALUE)
    || !SHA256.test(String(driver.manifestBinding || ""))
    || !SHA256.test(String(driver.planDigest || ""))
    || !positiveInteger(driver.expectedCostLimitMicros)
    || !positiveInteger(driver.spendStopMicros)
    || !Number.isFinite(createdAt)
    || createdAt > now
    || !Number.isFinite(expiresAt)
    || createdAt >= expiresAt
    || expiresAt <= now
    || !Number.isFinite(checkedAt)
    || checkedAt > createdAt
    || liveReadback.format
      !== "fanjin-candidate-exact-authorization-live-readback/v2"
    || !/^[A-Za-z0-9_-]{43}$/.test(String(liveReadback.challengeNonce || ""))
    || !/^[A-Za-z0-9_-]{43}$/.test(String(liveReadback.runtimeChallenge || ""))
    || !SHA256.test(String(captureReadback.readbackDigest || ""))
    || !SHA256.test(String(liveReadback.runtimeChallengeResponseDigest || ""))
    || !SHA256.test(String(liveReadback.billingReadbackDigest || ""))
    || !SHA256.test(String(liveReadback.operationsReadbackDigest || ""))
    || liveReadback.walletBinding !== authorization.walletBinding
    || !SHA256.test(String(liveReadback.availableScopeDigest || ""))
    || !Number.isSafeInteger(liveReadback.availableMicros)
    || Number(liveReadback.availableMicros) < 0
    || liveReadback.reservedMicros !== 0
    || !SHA256.test(String(liveReadback.proofDigest || ""))
    || liveReadback.proofDigest
      !== exactAuthorizationDigest(liveReadbackBody)
    || driver.sessionBinding !== binding.driverSessionBinding
    || binding.driverSessionBinding !== fullMatrixSessionBinding(input.session)
    || authorization.candidateKey !== "full-matrix/mixed"
    || authorization.driverScript !== CANDIDATE_E_FULL_MATRIX_DRIVER_SCRIPT
    || authorization.packageFileDigest
      !== binding.authorizationPackageFileDigest
    || binding.authorizationPackageIdentityBinding
      !== input.exactAuthorization.runtimePackageIdentityBinding
    || authorization.packageDigest !== binding.packageDigest
    || authorization.entryDigest !== binding.entryDigest
    || authorization.sessionBinding !== binding.authorizationSessionBinding
    || binding.authorizationSessionBinding
      !== exactAuthorizationSessionBinding(input.session)
    || authorization.workspaceBinding
      !== exactAuthorizationWorkspaceBinding(input.session.workspaceId)
    || authorization.packageFilePathBinding !== candidateESha256([
      AUTHORIZATION_PACKAGE_PATH_BINDING_DOMAIN,
      canonicalPackagePath,
    ].join("\0"))
  ) fail("candidate_e_full_matrix_guard_binding_mismatch");

  try {
    assertCandidateExactAuthorizationGuardPayload({
      value: guard,
      authorization: input.exactAuthorization,
      expectedDriver: driver,
      now,
    });
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationV2Error) {
      fail("candidate_e_full_matrix_guard_binding_mismatch");
    }
    throw error;
  }

  if (
    candidateESha256(input.authorizationPackageBytes)
      !== binding.authorizationPackageFileDigest
    || !isRecord(input.authorizationPackage)
  ) fail("candidate_e_authorization_package_invalid");
  const activation = input.authorizationPackage;
  const { packageDigest: _packageDigest, ...packageBody } = activation;
  if (
    activation.format !== CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FORMAT
    || activation.executionAuthorized !== true
    || activation.authorizationState !== "trusted-exact-execution-authorized"
    || activation.packageDigest !== binding.packageDigest
    || activation.packageDigest
      !== exactAuthorizationDigest(packageBody)
    || activation.sessionBinding !== binding.authorizationSessionBinding
    || activation.workspaceBinding !== authorization.workspaceBinding
    || Date.parse(String(activation.expiresAt || "")) !== expiresAt
    || `${candidateExactAuthorizationCanonicalJson(activation)}\n`
      !== Buffer.from(input.authorizationPackageBytes).toString("utf8")
    || !Array.isArray(activation.entries)
  ) fail("candidate_e_authorization_package_binding_mismatch");
  const entries = activation.entries.filter((entry) => (
    isRecord(entry) && entry.candidateKey === "full-matrix/mixed"
  ));
  if (entries.length !== 1) fail("candidate_e_authorization_entry_invalid");
  const entry = entries[0] as Record<string, unknown>;
  const { entryDigest: _entryDigest, ...entryBody } = entry;
  if (
    entry.entryDigest !== binding.entryDigest
    || entry.entryDigest !== exactAuthorizationDigest(entryBody)
    || entry.driverScript !== CANDIDATE_E_FULL_MATRIX_DRIVER_SCRIPT
    || !Array.isArray(entry.operations)
  ) fail("candidate_e_authorization_entry_invalid");
  const operations = entry.operations.filter((operation) => (
    isRecord(operation) && operation.operationKey === binding.operationKey
  ));
  if (operations.length !== 1) fail("candidate_e_absorbed_operation_invalid");
  const operation = operations[0] as Record<string, unknown>;
  const expectedPrefix = `image/${quote.model}/`;
  const parameters = isRecord(operation.parameters)
    ? operation.parameters
    : null;
  const pricingComponents = Array.isArray(operation.pricingComponents)
    ? operation.pricingComponents
    : null;
  if (
    operation.endpointType !== "image_generation"
    || operation.chargedCallCeiling !== 1
    || operation.model !== binding.operationModel
    || operation.provider !== binding.operationProvider
    || operation.routeAlias !== binding.operationRouteAlias
    || operation.maximumGuMicros !== binding.operationMaximumGuMicros
    || operation.directoryEntryDigest !== binding.directoryEntryDigest
    || operation.routeEntryDigest !== binding.routeEntryDigest
    || operation.pricingEntryDigest !== binding.pricingEntryDigest
    || operation.parameterDigest !== binding.parameterDigest
    || !pricingComponents
    || exactAuthorizationDigest(pricingComponents)
      !== binding.pricingComponentsDigest
    || !parameters
    || parameters.kind !== "image"
    || parameters.ratio !== binding.operationRatio
    || parameters.quality !== binding.operationQuality
    || parameters.count !== binding.operationCount
    || binding.operationKey.slice(0, expectedPrefix.length) !== expectedPrefix
    || !/^(?:16:9|1:1|4:3|3:4|9:16|3:2|2:3|21:9)$/
      .test(binding.operationKey.slice(expectedPrefix.length))
    || exactAuthorizationDigest(operation)
      !== binding.operationDigest
    || binding.operationModel !== quote.model
    || binding.operationProvider !== quote.provider
    || binding.operationRouteAlias !== quote.routeAlias
    || binding.operationMaximumGuMicros !== quote.maximumCostMicros
    || binding.operationRatio !== quote.ratio
    || binding.operationQuality !== quote.quality
    || binding.operationCount !== quote.requestUnits
    || pricingComponents.reduce((sum, component) => (
      isRecord(component) && positiveInteger(component.maximumCostMicros)
        ? sum + Number(component.maximumCostMicros)
        : Number.NaN
    ), 0) !== quote.maximumCostMicros
  ) fail("candidate_e_absorbed_operation_invalid");
}

function assertConsumedCandidateExactAuthorization(input: {
  consumed: CandidateExactAuthorizationConsumption;
  binding: CandidateEAbsorbedFullMatrixAuthorization;
  quote: CandidateESettledImageQuote;
  workspaceId: string;
}): void {
  const { consumed, binding, quote } = input;
  const operations = consumed.operations.filter(
    (operation) => operation.operationKey === binding.operationKey,
  );
  const operation = operations.length === 1 ? operations[0] : null;
  const parameters = operation?.parameters;
  if (
    consumed.packageFile !== binding.authorizationPackageFile
    || consumed.packageFileDigest !== binding.authorizationPackageFileDigest
    || consumed.runtimePackageIdentityBinding
      !== binding.authorizationPackageIdentityBinding
    || consumed.packageDigest !== binding.packageDigest
    || consumed.candidateKey !== "full-matrix/mixed"
    || consumed.driverScript !== CANDIDATE_E_FULL_MATRIX_DRIVER_SCRIPT
    || consumed.entryDigest !== binding.entryDigest
    || consumed.sessionBinding !== binding.authorizationSessionBinding
    || consumed.workspaceBinding
      !== exactAuthorizationWorkspaceBinding(input.workspaceId)
    || consumed.batchDAbsorbedOperationKey !== binding.operationKey
    || !operation
    || operation.endpointType !== "image_generation"
    || operation.operationDigest !== binding.operationDigest
    || operation.model !== binding.operationModel
    || operation.provider !== binding.operationProvider
    || operation.routeAlias !== binding.operationRouteAlias
    || operation.maximumGuMicros !== binding.operationMaximumGuMicros
    || operation.directoryEntryDigest !== binding.directoryEntryDigest
    || operation.routeEntryDigest !== binding.routeEntryDigest
    || operation.pricingEntryDigest !== binding.pricingEntryDigest
    || operation.parameterDigest !== binding.parameterDigest
    || operation.pricingComponentsDigest !== binding.pricingComponentsDigest
    || parameters?.kind !== "image"
    || parameters.ratio !== binding.operationRatio
    || parameters.quality !== binding.operationQuality
    || parameters.count !== binding.operationCount
    || operation.model !== quote.model
    || operation.provider !== quote.provider
    || operation.routeAlias !== quote.routeAlias
    || operation.maximumGuMicros !== quote.maximumCostMicros
    || parameters.ratio !== quote.ratio
    || parameters.quality !== quote.quality
    || parameters.count !== quote.requestUnits
  ) fail("candidate_e_exact_authorization_binding_mismatch");
}

function validateQuote(value: unknown, now: number): CandidateESettledImageQuote {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "endpointType", "workspaceId", "model", "provider", "channelId",
    "routeId", "routeAlias", "routeUpdatedAt", "pricingRuleId",
    "pricingRuleUpdatedAt", "unit",
    "unitPriceMicros", "multiplier", "minimumMicros", "requestUnits",
    "ratio", "quality", "maximumCostMicros", "currency", "routeDigest",
    "issuedAt", "expiresAt",
  ])) fail("candidate_e_quote_invalid");
  if (
    value.version !== CANDIDATE_E_SETTLED_IMAGE_QUOTE_VERSION
    || value.endpointType !== "image_generation"
    || value.unit !== "image"
    || value.currency !== "GU"
    || value.requestUnits !== 1
    || ![value.workspaceId, value.model, value.provider, value.channelId,
      value.routeId, value.routeAlias, value.pricingRuleId]
      .every((entry) => ID.test(String(entry || "")))
    || !/^\d{1,3}:\d{1,3}$/.test(String(value.ratio || ""))
    || !String(value.quality || "").trim()
    || !positiveInteger(value.routeUpdatedAt)
    || !positiveInteger(value.pricingRuleUpdatedAt)
    || !positiveInteger(value.unitPriceMicros)
    || !nonNegativeNumber(value.multiplier)
    || Number(value.multiplier) <= 0
    || !Number.isSafeInteger(value.minimumMicros)
    || Number(value.minimumMicros) < 0
    || !positiveInteger(value.maximumCostMicros)
    || !SHA256.test(String(value.routeDigest || ""))
    || !positiveInteger(value.issuedAt)
    || !positiveInteger(value.expiresAt)
    || Number(value.expiresAt) <= Number(value.issuedAt)
    || Number(value.expiresAt) - Number(value.issuedAt) > MAX_QUOTE_LIFETIME_MS
    || now < Number(value.issuedAt) - 30_000
    || now >= Number(value.expiresAt)
  ) fail(now >= Number(value.expiresAt || 0) ? "candidate_e_quote_expired" : "candidate_e_quote_invalid");
  const expectedMaximum = ceilGuChargeMicros(Math.max(
    Math.round(Number(value.unitPriceMicros) * Number(value.multiplier)),
    Number(value.minimumMicros),
  ));
  if (Number(value.maximumCostMicros) !== expectedMaximum) {
    fail("candidate_e_quote_cost_invalid");
  }
  return value as unknown as CandidateESettledImageQuote;
}

function validateManifest(
  value: Record<string, unknown>,
  now: number,
): CandidateESettledImageArmingManifest {
  if (!exactKeys(value, [
    "version", "operationBinding", "candidateBinding", "sessionBinding",
    "freezeReceiptDigest", "workspaceId", "actorUserId", "projectId",
    "idempotencyKeySha256", "requestHash", "model", "count", "maxGuMicros",
    "absorbedAuthorization", "quote", "quoteDigest", "acknowledgementNonce",
    "createdAt",
  ])) fail("candidate_e_arming_invalid");
  const quote = validateQuote(value.quote, now);
  const absorbedAuthorization = validateAbsorbedAuthorizationShape(
    value.absorbedAuthorization,
  );
  if (
    value.version !== CANDIDATE_E_SETTLED_IMAGE_ARMING_VERSION
    || !SHA256.test(String(value.operationBinding || ""))
    || !SHA256.test(String(value.candidateBinding || ""))
    || !SHA256.test(String(value.sessionBinding || ""))
    || !HEX_SHA256.test(String(value.freezeReceiptDigest || ""))
    || !ID.test(String(value.workspaceId || ""))
    || !positiveInteger(value.actorUserId)
    || !positiveInteger(value.projectId)
    || !SHA256.test(String(value.idempotencyKeySha256 || ""))
    || !HEX_SHA256.test(String(value.requestHash || ""))
    || !ID.test(String(value.model || ""))
    || value.count !== 1
    || !String(absorbedAuthorization.operationKey)
      .startsWith(`image/${String(value.model || "")}/`)
    || !positiveInteger(value.maxGuMicros)
    || Number(value.maxGuMicros) < quote.maximumCostMicros
    || candidateEQuoteDigest(quote) !== value.quoteDigest
    || value.operationBinding !== candidateESha256(candidateEStableJson({
      sessionBinding: value.sessionBinding,
      idempotencyKeySha256: value.idempotencyKeySha256,
      requestHash: value.requestHash,
      model: value.model,
      quoteDigest: value.quoteDigest,
      absorbedAuthorizationDigest:
        candidateEAbsorbedAuthorizationDigest(absorbedAuthorization),
    }))
    || !/^[a-f0-9]{64}$/.test(String(value.acknowledgementNonce || ""))
    || !positiveInteger(value.createdAt)
    || Number(value.createdAt) > now + 30_000
    || Number(value.createdAt) < quote.issuedAt - 30_000
    || Number(value.createdAt) >= quote.expiresAt
  ) fail("candidate_e_arming_invalid");
  return value as unknown as CandidateESettledImageArmingManifest;
}

function readSiblingSession(armingFile: string): {
  apiBaseUrl: string;
  workspaceId: string;
  userId: number;
  projectId: number;
  createdAt: string;
  candidateIdentity: Record<string, unknown>;
} {
  const parent = path.dirname(armingFile);
  const parentStat = fs.lstatSync(parent);
  if (
    parentStat.isSymbolicLink()
    || !parentStat.isDirectory()
    || (parentStat.mode & 0o777) !== 0o700
    || typeof process.getuid === "function" && parentStat.uid !== process.getuid()
  ) fail("candidate_e_arming_directory_invalid");
  const raw = readProtectedJson(
    path.join(parent, "browser-session.json"),
    "candidate_e_session_file_invalid",
  );
  assertLoopbackUrl(raw.baseUrl);
  assertLoopbackUrl(raw.apiBaseUrl);
  const candidateIdentity = safeCandidateIdentity(raw.candidateIdentity);
  if (
    !ID.test(String(raw.workspaceId || ""))
    || !positiveInteger(raw.userId)
    || !positiveInteger(raw.projectId)
    || !String(raw.createdAt || "").trim()
  ) fail("candidate_e_session_file_invalid");
  return {
    apiBaseUrl: String(raw.apiBaseUrl),
    workspaceId: String(raw.workspaceId),
    userId: Number(raw.userId),
    projectId: Number(raw.projectId),
    createdAt: String(raw.createdAt),
    candidateIdentity,
  };
}

export function authorizeCandidateESettledImageFailpoint(input: {
  capabilityHeader: unknown;
  armingFileHeader: unknown;
  acknowledgementProofHeader: unknown;
  environment?: NodeJS.ProcessEnv;
  formalRuntimeSession?: CandidateExactAuthorizationRuntimeSession;
  formalExactAuthorizationTrustEnvironment?:
    CandidateExactAuthorizationTrustEnvironment;
  now?: number;
  request: {
    workspaceId: string;
    actorUserId: number;
    projectId: number | null;
    idempotencyKey: string;
    requestHash: string;
    model: string;
    count: number;
  };
}): CandidateESettledImageAuthorization | null {
  const capability = String(input.capabilityHeader || "").trim();
  const armingFileRaw = String(input.armingFileHeader || "").trim();
  const acknowledgementProof = String(input.acknowledgementProofHeader || "").trim();
  if (!capability && !armingFileRaw && !acknowledgementProof) return null;
  const environment = input.environment || process.env;
  const formalRuntimeSession = input.formalRuntimeSession ?? null;
  const formalTrustEnvironment =
    input.formalExactAuthorizationTrustEnvironment ?? null;
  const exactFormalTrustEnvironment = formalTrustEnvironment
    && Object.keys(formalTrustEnvironment).sort().join("\0") === [
      CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV,
      CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV,
      RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV,
    ].sort().join("\0")
    && Object.values(formalTrustEnvironment).every(
      (value) => typeof value === "string" && value.length > 1,
    )
    ? formalTrustEnvironment
    : null;
  const testRuntimeAuthorized = environment.NODE_ENV === "test"
    && environment.FANJIN_REAL_CANDIDATE_ALLOW_VOLCANO_FAKE_IP_DNS === "1";
  const formalRuntimeAuthorized = environment.NODE_ENV === "prod"
    && formalRuntimeSession !== null
    && exactFormalTrustEnvironment !== null;
  if (
    capability !== CANDIDATE_E_SETTLED_IMAGE_FAILPOINT_VALUE
    || (!testRuntimeAuthorized && !formalRuntimeAuthorized)
    || !armingFileRaw
    || !acknowledgementProof
  ) fail("candidate_e_failpoint_forbidden");
  if (!path.isAbsolute(armingFileRaw) || path.normalize(armingFileRaw) !== armingFileRaw) {
    fail("candidate_e_arming_path_invalid");
  }
  const armingFile = fs.realpathSync(armingFileRaw);
  if (armingFile !== armingFileRaw) fail("candidate_e_arming_path_invalid");
  const now = input.now ?? Date.now();
  const raw = readProtectedJson(armingFile, "candidate_e_arming_file_invalid");
  const manifest = validateManifest(raw, now);
  if (`${candidateEStableJson(manifest)}\n` !== fs.readFileSync(armingFile, "utf8")) {
    fail("candidate_e_arming_noncanonical");
  }
  const session = readSiblingSession(armingFile);
  const candidateBinding = candidateEIdentityBinding(session.candidateIdentity);
  const sessionBinding = candidateESessionBinding(session);
  if (
    formalRuntimeSession
    && (
      formalRuntimeSession.workspaceId !== session.workspaceId
      || formalRuntimeSession.userId !== session.userId
      || formalRuntimeSession.projectId !== session.projectId
      || formalRuntimeSession.createdAt !== session.createdAt
      || candidateEIdentityBinding(
        formalRuntimeSession.candidateIdentity as unknown as Record<string, unknown>,
      ) !== candidateBinding
    )
  ) fail("candidate_e_formal_runtime_session_mismatch");
  const manifestDigest = candidateESha256(candidateEStableJson(manifest));
  const expectedAcknowledgement = candidateEAcknowledgementProof(
    manifestDigest,
    manifest.acknowledgementNonce,
  );
  if (
    acknowledgementProof !== expectedAcknowledgement
    || manifest.candidateBinding !== candidateBinding
    || manifest.sessionBinding !== sessionBinding
    || manifest.freezeReceiptDigest !== session.candidateIdentity.freezeReceiptDigest
    || manifest.workspaceId !== session.workspaceId
    || manifest.actorUserId !== session.userId
    || manifest.projectId !== session.projectId
    || manifest.workspaceId !== input.request.workspaceId
    || manifest.actorUserId !== input.request.actorUserId
    || manifest.projectId !== input.request.projectId
    || manifest.idempotencyKeySha256 !== candidateESha256(input.request.idempotencyKey)
    || manifest.requestHash !== input.request.requestHash
    || manifest.model !== input.request.model
    || manifest.count !== input.request.count
    || manifest.quote.workspaceId !== input.request.workspaceId
    || manifest.quote.model !== input.request.model
  ) fail("candidate_e_arming_binding_mismatch");
  const exactAuthorizationSession = {
    apiBaseUrl: session.apiBaseUrl,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    userId: session.userId,
    createdAt: session.createdAt,
    candidateIdentity: session.candidateIdentity as unknown as
      ReleaseCandidateSessionIdentity,
  };
  const exactAuthorizationEnvironment = formalRuntimeAuthorized
    ? exactFormalTrustEnvironment
    : environment;
  let exactAuthorization: CandidateExactAuthorizationConsumption;
  try {
    exactAuthorization = consumeCandidateExactAuthorizationPackage({
      packageFile: manifest.absorbedAuthorization.authorizationPackageFile,
      expectedPackageFileDigest:
        manifest.absorbedAuthorization.authorizationPackageFileDigest,
      expectedCandidateKey: "full-matrix/mixed",
      expectedDriverScript: CANDIDATE_E_FULL_MATRIX_DRIVER_SCRIPT,
      session: exactAuthorizationSession,
      environment: exactAuthorizationEnvironment,
      now,
      runtimePackage:
        candidateERuntimePackageBinding(manifest.absorbedAuthorization),
    });
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationV2Error) {
      fail("candidate_e_exact_authorization_required");
    }
    throw error;
  }
  assertConsumedCandidateExactAuthorization({
    consumed: exactAuthorization,
    binding: manifest.absorbedAuthorization,
    quote: manifest.quote,
    workspaceId: session.workspaceId,
  });
  if (manifest.quote.expiresAt > Date.parse(exactAuthorization.expiresAt)) {
    fail("candidate_e_quote_exceeds_exact_authorization");
  }
  const sessionFile = path.join(path.dirname(armingFile), "browser-session.json");
  const fullMatrixGuardFile = `${sessionFile}${CANDIDATE_E_FULL_MATRIX_PAID_GUARD_SUFFIX}`;
  const fullMatrixGuardReadback = readProtectedFile(
    fullMatrixGuardFile,
    "candidate_e_full_matrix_guard_required",
  );
  const fullMatrixGuardBytes = fullMatrixGuardReadback.bytes;
  const fullMatrixGuard = parseJsonBytes(
    fullMatrixGuardBytes,
    "candidate_e_full_matrix_guard_invalid",
  );
  const authorizationPackageReadback = readCandidateEAuthorizationPackage(
    manifest.absorbedAuthorization,
  );
  const authorizationPackageCanonicalPath =
    authorizationPackageReadback.canonicalPath;
  const authorizationPackageBytes = authorizationPackageReadback.bytes;
  const authorizationPackage = parseJsonBytes(
    authorizationPackageBytes,
    "candidate_e_authorization_package_invalid",
  );
  assertCandidateEAbsorbedFullMatrixAuthorization({
    binding: manifest.absorbedAuthorization,
    exactAuthorization,
    quote: manifest.quote,
    session,
    fullMatrixGuardBytes,
    fullMatrixGuard,
    fullMatrixGuardCanonicalPath: fullMatrixGuardReadback.canonicalPath,
    fullMatrixGuardStat: {
      dev: fullMatrixGuardReadback.stat.dev,
      ino: fullMatrixGuardReadback.stat.ino,
      size: fullMatrixGuardReadback.stat.size,
    },
    authorizationPackageBytes,
    authorizationPackage,
    authorizationPackageCanonicalPath,
    now,
  });
  const guardAuthorization = isRecord(fullMatrixGuard.authorization)
    ? fullMatrixGuard.authorization
    : null;
  if (
    !guardAuthorization
    || guardAuthorization.formalCandidateIdentityDigest
      !== exactAuthorization.formalCandidateIdentityDigest
    || authorizationPackage.formalCandidateIdentityDigest
      !== exactAuthorization.formalCandidateIdentityDigest
  ) fail("candidate_e_exact_authorization_binding_mismatch");
  if (
    fs.existsSync(`${armingFile}${CANDIDATE_E_SETTLED_IMAGE_GUARD_SUFFIX}`)
    || fs.existsSync(`${armingFile}${CANDIDATE_E_SETTLED_IMAGE_RECEIPT_SUFFIX}`)
  ) fail("candidate_e_irreversible_guard_exists");
  return {
    armingFile,
    guardFile: `${armingFile}${CANDIDATE_E_SETTLED_IMAGE_GUARD_SUFFIX}`,
    receiptFile: `${armingFile}${CANDIDATE_E_SETTLED_IMAGE_RECEIPT_SUFFIX}`,
    manifest,
    manifestDigest,
    fullMatrixGuardFile,
    exactAuthorization,
    exactAuthorizationContext: {
      session: exactAuthorizationSession,
      trustEnvironment: {
        [RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV]:
          exactAuthorizationEnvironment[RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV],
        [CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV]:
          exactAuthorizationEnvironment[
            CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV
          ],
        [CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV]:
          exactAuthorizationEnvironment[
            CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV
          ],
      },
    },
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function routeDigest(input: {
  routeId: string;
  routeAlias: string;
  routeUpdatedAt: number;
  model: string;
  provider: string;
  channelId: string;
  pricingRuleId: string;
  pricingRuleUpdatedAt: number;
  unitPriceMicros: number;
  multiplier: number;
  minimumMicros: number;
}): string {
  return candidateESha256(candidateEStableJson(input));
}

function fsyncParent(file: string): void {
  const descriptor = fs.openSync(
    path.dirname(file),
    fs.constants.O_RDONLY
      | (typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeExclusiveProtected(file: string, value: unknown, code: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${candidateEStableJson(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fsyncParent(file);
  } catch {
    return fail(code);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function revalidateCandidateEExactAuthorizationAtDispatch(
  authorization: CandidateESettledImageAuthorization,
  now: number,
): CandidateExactAuthorizationConsumption {
  let exact: CandidateExactAuthorizationConsumption;
  try {
    exact = consumeCandidateExactAuthorizationPackage({
      packageFile: authorization.manifest.absorbedAuthorization
        .authorizationPackageFile,
      expectedPackageFileDigest: authorization.manifest.absorbedAuthorization
        .authorizationPackageFileDigest,
      expectedCandidateKey: "full-matrix/mixed",
      expectedDriverScript: CANDIDATE_E_FULL_MATRIX_DRIVER_SCRIPT,
      session: authorization.exactAuthorizationContext.session,
      environment: authorization.exactAuthorizationContext.trustEnvironment,
      now,
      runtimePackage: candidateERuntimePackageBinding(
        authorization.manifest.absorbedAuthorization,
      ),
    });
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationV2Error) {
      fail("candidate_e_exact_authorization_expired_or_invalid");
    }
    throw error;
  }
  assertConsumedCandidateExactAuthorization({
    consumed: exact,
    binding: authorization.manifest.absorbedAuthorization,
    quote: authorization.manifest.quote,
    workspaceId: authorization.manifest.workspaceId,
  });
  if (
    now >= authorization.manifest.quote.expiresAt
    || now >= Date.parse(exact.expiresAt)
    || authorization.manifest.quote.expiresAt > Date.parse(exact.expiresAt)
    || exact.formalCandidateIdentityDigest
      !== authorization.exactAuthorization.formalCandidateIdentityDigest
  ) fail("candidate_e_exact_authorization_expired_or_invalid");
  const guardReadback = readProtectedFile(
    authorization.fullMatrixGuardFile,
    "candidate_e_full_matrix_guard_required",
  );
  const guard = parseJsonBytes(
    guardReadback.bytes,
    "candidate_e_full_matrix_guard_invalid",
  );
  const packageReadback = readCandidateEAuthorizationPackage(
    authorization.manifest.absorbedAuthorization,
  );
  const activation = parseJsonBytes(
    packageReadback.bytes,
    "candidate_e_authorization_package_invalid",
  );
  assertCandidateEAbsorbedFullMatrixAuthorization({
    binding: authorization.manifest.absorbedAuthorization,
    exactAuthorization: exact,
    quote: authorization.manifest.quote,
    session: authorization.exactAuthorizationContext.session,
    fullMatrixGuardBytes: guardReadback.bytes,
    fullMatrixGuard: guard,
    fullMatrixGuardCanonicalPath: guardReadback.canonicalPath,
    fullMatrixGuardStat: {
      dev: guardReadback.stat.dev,
      ino: guardReadback.stat.ino,
      size: guardReadback.stat.size,
    },
    authorizationPackageBytes: packageReadback.bytes,
    authorizationPackage: activation,
    authorizationPackageCanonicalPath: packageReadback.canonicalPath,
    now,
  });
  const guardAuthorization = isRecord(guard.authorization)
    ? guard.authorization
    : null;
  if (
    !guardAuthorization
    || guardAuthorization.formalCandidateIdentityDigest
      !== exact.formalCandidateIdentityDigest
    || activation.formalCandidateIdentityDigest
      !== exact.formalCandidateIdentityDigest
  ) fail("candidate_e_exact_authorization_binding_mismatch");
  return exact;
}

function candidateECanonicalOperationRequest(
  authorization: CandidateESettledImageAuthorization,
): CandidateExactAuthorizationOperationRequest {
  const operationKey = authorization.manifest.absorbedAuthorization.operationKey;
  const request = candidateExactAuthorizationOperationRequests("full-matrix/mixed")
    .find((candidate) => candidate.key === operationKey);
  if (!request) fail("candidate_e_live_operation_request_missing");
  return request;
}

export type CandidateELiveOperationBinding = {
  key: string;
  endpointType: "text" | "image_generation" | "video_generation";
  model: string;
  provider: string;
  routeAlias: string;
  maximumCostMicros: number;
  directoryEntryDigest: string;
  routeEntryDigest: string;
  pricingEntryDigest: string;
  parameterDigest: string;
  pricingComponentsDigest: string;
};

function candidateEPricingComponentsDigest(
  components: readonly Readonly<{
    component: string;
    unit: string;
    maximumUnits: number;
    unitPriceMicros: number;
    maximumCostMicros: number;
  }>[],
): string {
  // The signed review entry adds the human-readable GU amount before hashing
  // pricingComponents. Reproduce that package-compiler projection while using
  // the shared canonical operation as the sole source of pricing values.
  const reviewComponents = components.map((component) => {
    return {
      ...component,
      maximumGu: guStringFromMicros(component.maximumCostMicros),
    };
  });
  return candidateExactAuthorizationDigest(reviewComponents);
}

async function readCandidateELiveCanonicalOperation(
  authorization: CandidateESettledImageAuthorization,
  transaction: Knex.Transaction,
): Promise<CandidateELiveOperationBinding> {
  try {
    const operation = await resolveCandidateExactAuthorizationCanonicalOperation({
      workspaceId: authorization.manifest.workspaceId,
      request: candidateECanonicalOperationRequest(authorization),
      database: transaction,
    });
    return {
      key: operation.key,
      endpointType: operation.endpointType,
      model: operation.model,
      provider: operation.provider,
      routeAlias: operation.routeAlias,
      maximumCostMicros: operation.maximumCostMicros,
      directoryEntryDigest: operation.directoryEntryDigest,
      routeEntryDigest: operation.routeEntryDigest,
      pricingEntryDigest: operation.pricingEntryDigest,
      parameterDigest: operation.parameterDigest,
      pricingComponentsDigest: candidateEPricingComponentsDigest(
        operation.pricingComponents,
      ),
    };
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationQuoteReadError) {
      fail("candidate_e_live_operation_unavailable");
    }
    throw error;
  }
}

function assertCandidateELiveCanonicalOperation(
  authorization: CandidateESettledImageAuthorization,
  exact: CandidateExactAuthorizationConsumption,
  live: CandidateELiveOperationBinding,
): void {
  const operation = exact.operations.find(
    (candidate) => candidate.operationKey
      === authorization.manifest.absorbedAuthorization.operationKey,
  );
  if (
    !operation
    || live.key !== operation.operationKey
    || live.endpointType !== operation.endpointType
    || live.model !== operation.model
    || live.provider !== operation.provider
    || live.routeAlias !== operation.routeAlias
    || live.maximumCostMicros !== operation.maximumGuMicros
    || live.directoryEntryDigest !== operation.directoryEntryDigest
    || live.routeEntryDigest !== operation.routeEntryDigest
    || live.pricingEntryDigest !== operation.pricingEntryDigest
    || live.parameterDigest !== operation.parameterDigest
    || live.pricingComponentsDigest !== operation.pricingComponentsDigest
  ) fail("candidate_e_live_operation_digest_mismatch");
}

function candidateEOperationConsumptionLineage(
  authorization: CandidateESettledImageAuthorization,
  exact: CandidateExactAuthorizationConsumption,
): {
  scopeKey: string;
  idempotencyKey: string;
  lineageDigest: string;
  metadata: Record<string, unknown>;
} {
  const operation = exact.operations.find(
    (candidate) => candidate.operationKey
      === authorization.manifest.absorbedAuthorization.operationKey,
  );
  if (!operation) fail("candidate_e_exact_authorization_binding_mismatch");
  const sessionScopeBinding = candidateESha256(candidateEStableJson({
    version: "fanjin-candidate-e-operation-consumption-session/v1",
    workspaceId: authorization.manifest.workspaceId,
    formalCandidateIdentityDigest: exact.formalCandidateIdentityDigest,
    authorizationSessionBinding: exact.sessionBinding,
  }));
  const lineage = {
    version: "fanjin-candidate-e-operation-consumption-lineage/v1",
    workspaceId: authorization.manifest.workspaceId,
    formalCandidateIdentityDigest: exact.formalCandidateIdentityDigest,
    authorizationSessionBinding: exact.sessionBinding,
    operationKey: operation.operationKey,
    operationDigest: operation.operationDigest,
  };
  const lineageDigest = candidateESha256(candidateEStableJson(lineage));
  return {
    scopeKey: `candidate_e_operation_consumption:${sessionScopeBinding}`,
    idempotencyKey: lineageDigest,
    lineageDigest,
    metadata: {
      ...lineage,
      lineageDigest,
      firstPackageDigest: exact.packageDigest,
      firstEntryDigest: exact.entryDigest,
    },
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "SQLITE_CONSTRAINT"
    || error.code === "SQLITE_CONSTRAINT_UNIQUE"
    || error.code === "23505"
    || error.errno === 19
    || /(?:unique|duplicate)/i.test(String(error.message || ""));
}

function candidateEOperationClaimDescriptor(
  authorization: CandidateESettledImageAuthorization,
  exact: CandidateExactAuthorizationConsumption,
  expectedCommand: CandidateESettledImageCommandIdentity,
): CandidateEOperationClaim {
  const consumption = candidateEOperationConsumptionLineage(authorization, exact);
  if (
    expectedCommand.workspaceId !== authorization.manifest.workspaceId
    || expectedCommand.actorUserId !== authorization.manifest.actorUserId
    || candidateESha256(expectedCommand.idempotencyKey)
      !== authorization.manifest.idempotencyKeySha256
    || expectedCommand.requestHash !== authorization.manifest.requestHash
  ) fail("candidate_e_operation_claim_owner_mismatch");
  const owner = {
    version: "fanjin-candidate-e-operation-claim-owner/v1",
    commandId: expectedCommand.id,
    workspaceId: expectedCommand.workspaceId,
    actorUserId: expectedCommand.actorUserId,
    commandScopeKey: expectedCommand.scopeKey,
    commandIdempotencyKey: expectedCommand.idempotencyKey,
    commandRequestHash: expectedCommand.requestHash,
    authorizationSessionBinding: exact.sessionBinding,
    operationDigest: authorization.manifest.absorbedAuthorization.operationDigest,
  };
  const ownerDigest = candidateESha256(candidateEStableJson(owner));
  const processingResponseBody = candidateEStableJson({
    ...consumption.metadata,
    claimStatus: "processing",
    owner,
    ownerDigest,
  });
  return {
    id: `candidate-e-operation-${consumption.lineageDigest.slice("sha256:".length)}`,
    workspaceId: authorization.manifest.workspaceId,
    actorUserId: authorization.manifest.actorUserId,
    scopeKey: consumption.scopeKey,
    idempotencyKey: consumption.idempotencyKey,
    requestHash: consumption.lineageDigest,
    resourceId: authorization.manifest.absorbedAuthorization.operationDigest,
    lineageDigest: consumption.lineageDigest,
    ownerDigest,
    processingResponseBody,
  };
}

function sameCandidateEOperationClaimRow(
  row: Record<string, unknown>,
  claim: CandidateEOperationClaim,
): boolean {
  if (
    String(row.id || "") !== claim.id
    || String(row.workspaceId || "") !== claim.workspaceId
    || Number(row.actorUserId) !== claim.actorUserId
    || String(row.scopeKey || "") !== claim.scopeKey
    || String(row.idempotencyKey || "") !== claim.idempotencyKey
    || String(row.requestHash || "") !== claim.requestHash
    || String(row.resourceType || "") !== "candidate_e_operation_consumption"
    || String(row.resourceId || "") !== claim.resourceId
    || String(row.responseBody || "") !== claim.processingResponseBody
  ) return false;
  const metadata = parseJson(row.responseBody);
  return metadata.claimStatus === "processing"
    && metadata.lineageDigest === claim.lineageDigest
    && metadata.ownerDigest === claim.ownerDigest;
}

/**
 * Acquire the stable, cross-command Candidate E operation owner before any
 * billing reservation is created. A different owner never takes over an
 * existing processing claim automatically: an unknown dispatch outcome must
 * fail closed and be reconciled explicitly.
 */
export async function acquireCandidateESettledImageOperationClaim(
  authorization: CandidateESettledImageAuthorization,
  expectedCommand: CandidateESettledImageCommandIdentity,
  database: Knex | Knex.Transaction,
): Promise<CandidateEOperationClaim> {
  const exact = revalidateCandidateEExactAuthorizationAtDispatch(
    authorization,
    Date.now(),
  );
  const claim = candidateEOperationClaimDescriptor(
    authorization,
    exact,
    expectedCommand,
  );
  const createdAt = Date.now();
  try {
    await database("o_agent_idempotency").insert({
      id: claim.id,
      workspaceId: claim.workspaceId,
      actorUserId: claim.actorUserId,
      scopeKey: claim.scopeKey,
      idempotencyKey: claim.idempotencyKey,
      requestHash: claim.requestHash,
      status: "processing",
      responseStatus: null,
      responseBody: claim.processingResponseBody,
      resourceType: "candidate_e_operation_consumption",
      resourceId: claim.resourceId,
      expiresAt: CANDIDATE_E_OPERATION_CONSUMPTION_EXPIRES_AT,
      createdAt,
      updatedAt: createdAt,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      fail("candidate_e_operation_consumption_failed");
    }
    const existing = await database("o_agent_idempotency")
      .where({ scopeKey: claim.scopeKey, idempotencyKey: claim.idempotencyKey })
      .first();
    if (
      isRecord(existing)
      && String(existing.status || "") === "processing"
      && sameCandidateEOperationClaimRow(existing, claim)
    ) return claim;
    fail("candidate_e_operation_already_consumed");
  }
  return claim;
}

function candidateEProtectedPathExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== "ENOENT";
  }
}

function candidateEDurableCommandOwnerMatches(
  row: Record<string, unknown>,
  expectedCommand: CandidateESettledImageCommandIdentity,
): boolean {
  const metadata = parseJson(row.metadata);
  const owner = parseJson(metadata.durableCommandIdentity);
  return owner.contractVersion === "workbench-generation-command.v1"
    && owner.commandId === expectedCommand.id
    && owner.workspaceId === expectedCommand.workspaceId
    && Number(owner.actorUserId) === expectedCommand.actorUserId
    && owner.scopeKey === expectedCommand.scopeKey
    && owner.idempotencyKey === expectedCommand.idempotencyKey
    && owner.requestHash === expectedCommand.requestHash;
}

/**
 * Remove a pre-dispatch processing claim only after durable billing evidence
 * proves that every owner reservation was fully released and no dispatch
 * watchdog or irreversible Candidate E file exists. Any ambiguity preserves
 * the claim indefinitely for manual reconciliation; there is no TTL takeover.
 */
export async function releaseCandidateESettledImageOperationClaimIfSafe(
  authorization: CandidateESettledImageAuthorization,
  claim: CandidateEOperationClaim,
  expectedCommand: CandidateESettledImageCommandIdentity,
  database: Knex,
): Promise<boolean> {
  if (
    candidateEProtectedPathExists(authorization.guardFile)
    || candidateEProtectedPathExists(authorization.receiptFile)
  ) return false;
  return await database.transaction(async (transaction) => {
    const existing = await transaction("o_agent_idempotency")
      .where({ id: claim.id, workspaceId: claim.workspaceId })
      .first();
    if (
      !isRecord(existing)
      || String(existing.status || "") !== "processing"
      || !sameCandidateEOperationClaimRow(existing, claim)
    ) return false;

    const workspaceFreezes = await transaction("o_billing_ledger")
      .where({ workspaceId: claim.workspaceId, type: "freeze" })
      .select(
        "id",
        "status",
        "remainingMicros",
        "relatedUsageId",
        "metadata",
      );
    const ownerFreezes = (workspaceFreezes as Array<Record<string, unknown>>)
      .filter((row) => candidateEDurableCommandOwnerMatches(row, expectedCommand));
    const reservationIds = ownerFreezes.map((row) => String(row.id || ""));
    const usageRecordIds = ownerFreezes.map((row) => String(row.relatedUsageId || ""));
    if (ownerFreezes.some((row) => (
      String(row.status || "") !== "released"
      || Number(row.remainingMicros) !== 0
      || !String(row.relatedUsageId || "").trim()
      || ["dispatch_started", "pending_reconcile"].includes(
        String(parseJson(row.metadata).billingLifecycleState || ""),
      )
    ))) return false;

    if (reservationIds.length > 0) {
      const [usages, releases, deductions, watchdogs] = await Promise.all([
        transaction("o_usage_record")
          .whereIn("id", usageRecordIds)
          .select("id", "status", "costMicros"),
        transaction("o_billing_ledger")
          .where({ workspaceId: claim.workspaceId, type: "release" })
          .whereIn("relatedLedgerId", reservationIds)
          .select("relatedLedgerId", "status"),
        transaction("o_billing_ledger")
          .where({ workspaceId: claim.workspaceId, type: "deduct" })
          .whereIn("relatedLedgerId", reservationIds)
          .select("id"),
        transaction("o_billing_reconcile_job")
          .whereIn("reservationId", reservationIds)
          .select("status"),
      ]);
      const usageRows = usages as Array<Record<string, unknown>>;
      const releaseRows = releases as Array<Record<string, unknown>>;
      if (
        usageRows.length !== usageRecordIds.length
        || usageRows.some((row) => (
          String(row.status || "") !== "released"
          || Number(row.costMicros) !== 0
        ))
        || releaseRows.length !== reservationIds.length
        || releaseRows.some((row) => String(row.status || "") !== "succeeded")
        || (deductions as Array<unknown>).length !== 0
        || (watchdogs as Array<Record<string, unknown>>).some(
          (row) => String(row.status || "") !== "resolved",
        )
      ) return false;
    }

    if (
      candidateEProtectedPathExists(authorization.guardFile)
      || candidateEProtectedPathExists(authorization.receiptFile)
    ) return false;
    const deleted = await transaction("o_agent_idempotency")
      .where({
        id: claim.id,
        workspaceId: claim.workspaceId,
        actorUserId: claim.actorUserId,
        scopeKey: claim.scopeKey,
        idempotencyKey: claim.idempotencyKey,
        requestHash: claim.requestHash,
        resourceType: "candidate_e_operation_consumption",
        resourceId: claim.resourceId,
        status: "processing",
        responseBody: claim.processingResponseBody,
      })
      .delete();
    return Number(deleted) === 1;
  });
}

async function completeCandidateEOperationClaim(
  authorization: CandidateESettledImageAuthorization,
  exact: CandidateExactAuthorizationConsumption,
  claim: CandidateEOperationClaim,
  transaction: Knex.Transaction,
  boundary: {
    reservationId: string;
    usageRecordId: string;
    provider: string | null;
    channelId: string | null;
  },
  expectedCommand: CandidateESettledImageCommandIdentity,
  guardCreatedAt: number,
): Promise<void> {
  const expectedClaim = candidateEOperationClaimDescriptor(
    authorization,
    exact,
    expectedCommand,
  );
  if (
    expectedClaim.id !== claim.id
    || expectedClaim.scopeKey !== claim.scopeKey
    || expectedClaim.idempotencyKey !== claim.idempotencyKey
    || expectedClaim.requestHash !== claim.requestHash
    || expectedClaim.resourceId !== claim.resourceId
    || expectedClaim.lineageDigest !== claim.lineageDigest
    || expectedClaim.ownerDigest !== claim.ownerDigest
  ) fail("candidate_e_operation_claim_owner_mismatch");
  const existing = await transaction("o_agent_idempotency")
    .where({ id: claim.id, workspaceId: claim.workspaceId })
    .first();
  if (!isRecord(existing) || String(existing.status || "") !== "processing") {
    fail(String(existing?.status || "") === "completed"
      ? "candidate_e_operation_already_consumed"
      : "candidate_e_operation_claim_missing");
  }
  if (!sameCandidateEOperationClaimRow(existing, claim)) {
    fail("candidate_e_operation_claim_owner_mismatch");
  }
  const completedAt = Date.now();
  const completedResponseBody = candidateEStableJson({
    ...parseJson(claim.processingResponseBody),
    claimStatus: "completed",
    completion: {
      reservationId: boundary.reservationId,
      usageRecordId: boundary.usageRecordId,
      provider: boundary.provider,
      channelId: boundary.channelId,
      guardFile: authorization.guardFile,
      receiptFile: authorization.receiptFile,
      guardCreatedAt,
      manifestDigest: authorization.manifestDigest,
      freezeReceiptDigest: authorization.manifest.freezeReceiptDigest,
      completedAt,
    },
  });
  const affected = await transaction("o_agent_idempotency")
    .where({
      id: claim.id,
      workspaceId: claim.workspaceId,
      actorUserId: claim.actorUserId,
      scopeKey: claim.scopeKey,
      idempotencyKey: claim.idempotencyKey,
      requestHash: claim.requestHash,
      resourceType: "candidate_e_operation_consumption",
      resourceId: claim.resourceId,
      status: "processing",
      responseBody: claim.processingResponseBody,
    })
    .update({
      status: "completed",
      responseStatus: 204,
      responseBody: completedResponseBody,
      updatedAt: completedAt,
    });
  if (Number(affected) !== 1) fail("candidate_e_operation_claim_transition_failed");
}

export async function assertCandidateESettledImageDispatchAndAcquireGuard(
  authorization: CandidateESettledImageAuthorization,
  transaction: Knex.Transaction,
  boundary: {
    workspaceId: string;
    reservationId: string;
    usageRecordId: string;
    provider: string | null;
    channelId: string | null;
  },
  expectedCommand: CandidateESettledImageCommandIdentity,
  operationClaim?: CandidateEOperationClaim,
  dependencies: {
    readLiveOperationBinding?: (
      authorization: CandidateESettledImageAuthorization,
      transaction: Knex.Transaction,
    ) => Promise<CandidateELiveOperationBinding>;
  } = {},
): Promise<void> {
  const quote = authorization.manifest.quote;
  const [reservation, usage, pricingRule, route] = await Promise.all([
    transaction("o_billing_ledger").where({
      id: boundary.reservationId,
      workspaceId: boundary.workspaceId,
      type: "freeze",
    }).first(),
    transaction("o_usage_record").where({
      id: boundary.usageRecordId,
      workspaceId: boundary.workspaceId,
    }).first(),
    transaction("o_pricing_rule").where({ id: quote.pricingRuleId, disabled: 0 }).first(),
    transaction("o_model_route").where({ id: quote.routeId, disabled: 0 }).first(),
  ]);
  const metadata = parseJson(reservation?.metadata);
  const priceSnapshot = parseJson(metadata.priceSnapshot);
  const durableCommandIdentity = parseJson(metadata.durableCommandIdentity);
  const actualRouteDigest = routeDigest({
    routeId: String(route?.id || ""),
    routeAlias: String(route?.name || route?.id || ""),
    routeUpdatedAt: Number(route?.updateTime || route?.updatedAt || 0),
    model: String(route?.model || ""),
    provider: String(route?.provider || ""),
    channelId: String(route?.channelId || ""),
    pricingRuleId: String(pricingRule?.id || ""),
    pricingRuleUpdatedAt: Number(pricingRule?.updateTime || pricingRule?.updatedAt || 0),
    unitPriceMicros: Number(pricingRule?.unitPriceMicros || 0),
    multiplier: Number(parseJson(pricingRule?.ruleConfig).multiplier ?? 1),
    minimumMicros: Number(parseJson(pricingRule?.ruleConfig).minimumMicros ?? 0),
  });
  const dispatchNow = Date.now();
  revalidateCandidateEExactAuthorizationAtDispatch(
    authorization,
    dispatchNow,
  );
  if (
    dispatchNow >= quote.expiresAt
    || boundary.workspaceId !== quote.workspaceId
    || boundary.provider !== quote.provider
    || boundary.channelId !== quote.channelId
    || !reservation
    || !usage
    || !pricingRule
    || !route
    || String(reservation.id || "") !== boundary.reservationId
    || String(usage.id || "") !== boundary.usageRecordId
    || String(reservation.relatedUsageId || "") !== boundary.usageRecordId
    || String(reservation.status || "") !== "frozen"
    || String(reservation.currency || "") !== "GU"
    || !String(reservation.requestId || "").trim()
    || !String(reservation.idempotencyKey || "").endsWith(":reserve")
    || !String(metadata.requestHash || "").trim()
    || String(durableCommandIdentity.contractVersion || "")
      !== "workbench-generation-command.v1"
    || String(durableCommandIdentity.commandId || "") !== expectedCommand.id
    || String(durableCommandIdentity.workspaceId || "") !== expectedCommand.workspaceId
    || Number(durableCommandIdentity.actorUserId) !== expectedCommand.actorUserId
    || String(durableCommandIdentity.scopeKey || "") !== expectedCommand.scopeKey
    || String(durableCommandIdentity.idempotencyKey || "")
      !== expectedCommand.idempotencyKey
    || String(durableCommandIdentity.requestHash || "") !== expectedCommand.requestHash
    || expectedCommand.workspaceId !== authorization.manifest.workspaceId
    || expectedCommand.actorUserId !== authorization.manifest.actorUserId
    || expectedCommand.idempotencyKey !== ""
      && candidateESha256(expectedCommand.idempotencyKey)
        !== authorization.manifest.idempotencyKeySha256
    || expectedCommand.requestHash !== authorization.manifest.requestHash
    || String(usage.endpointType || "") !== "image_generation"
    || String(usage.model || "") !== quote.model
    || String(usage.provider || "") !== quote.provider
    || String(usage.channelId || "") !== quote.channelId
    || Number(usage.units) !== 1
    || String(usage.unit || "") !== "image"
    || String(usage.currency || "") !== "GU"
    || String(usage.status || "") !== "reserved"
    || Number(usage.costMicros) !== quote.maximumCostMicros
    || Number(reservation.amountMicros) !== quote.maximumCostMicros
    || Number(reservation.remainingMicros) !== quote.maximumCostMicros
    || String(metadata.pricingRuleId || "") !== quote.pricingRuleId
    || Number(metadata.reservedCostMicros) !== quote.maximumCostMicros
    || Number(metadata.reservedUnits) !== 1
    || String(priceSnapshot.unit || "") !== "image"
    || Number(priceSnapshot.unitPriceMicros) !== quote.unitPriceMicros
    || Number(priceSnapshot.multiplier) !== quote.multiplier
    || Number(priceSnapshot.minimumMicros) !== quote.minimumMicros
    || Number(pricingRule.updateTime || pricingRule.updatedAt || 0) !== quote.pricingRuleUpdatedAt
    || Number(route.updateTime || route.updatedAt || 0) !== quote.routeUpdatedAt
    || String(route.model || "") !== quote.model
    || String(route.provider || "") !== quote.provider
    || String(route.channelId || "") !== quote.channelId
    || String(route.name || route.id || "") !== quote.routeAlias
    || actualRouteDigest !== quote.routeDigest
    || quote.maximumCostMicros > authorization.manifest.maxGuMicros
  ) fail(dispatchNow >= quote.expiresAt
    ? "candidate_e_quote_expired"
    : "candidate_e_dispatch_quote_mismatch");
  const claim = operationClaim ?? await acquireCandidateESettledImageOperationClaim(
    authorization,
    expectedCommand,
    transaction,
  );
  const liveCanonicalOperation = await (
    dependencies.readLiveOperationBinding
      ?? readCandidateELiveCanonicalOperation
  )(
    authorization,
    transaction,
  );
  // Re-consume at the final commit boundary. The database reads and route/
  // pricing validation above may take long enough to cross either the quote
  // or exact-authorization expiry, so their earlier timestamp is not reused.
  const commitNow = Date.now();
  const commitAuthorization = revalidateCandidateEExactAuthorizationAtDispatch(
    authorization,
    commitNow,
  );
  assertCandidateELiveCanonicalOperation(
    authorization,
    commitAuthorization,
    liveCanonicalOperation,
  );
  await completeCandidateEOperationClaim(
    authorization,
    commitAuthorization,
    claim,
    transaction,
    boundary,
    expectedCommand,
    commitNow,
  );
  writeExclusiveProtected(authorization.guardFile, {
    version: "fanjin-candidate-e-settled-image-guard/v1",
    manifestDigest: authorization.manifestDigest,
    operationBinding: authorization.manifest.operationBinding,
    sessionBinding: authorization.manifest.sessionBinding,
    idempotencyKeySha256: authorization.manifest.idempotencyKeySha256,
    quoteDigest: authorization.manifest.quoteDigest,
    maximumUpstreamCalls: 1,
    maximumChargedCalls: 1,
    createdAt: commitNow,
  }, "candidate_e_irreversible_guard_exists");
}

export function triggerCandidateESettledImageFailpoint(
  authorization: CandidateESettledImageAuthorization,
  checkpoint: {
    settlementState: "pending" | "settled";
    data: Array<unknown>;
    billing: RelayUnitBillingCheckpoint | null;
  } | null,
): never {
  const guard = readProtectedJson(
    authorization.guardFile,
    "candidate_e_dispatch_guard_required",
  );
  if (
    !exactKeys(guard, [
      "version", "manifestDigest", "operationBinding", "sessionBinding",
      "idempotencyKeySha256", "quoteDigest", "maximumUpstreamCalls",
      "maximumChargedCalls", "createdAt",
    ])
    || guard.version !== "fanjin-candidate-e-settled-image-guard/v1"
    || guard.manifestDigest !== authorization.manifestDigest
    || guard.operationBinding !== authorization.manifest.operationBinding
    || guard.sessionBinding !== authorization.manifest.sessionBinding
    || guard.idempotencyKeySha256
      !== authorization.manifest.idempotencyKeySha256
    || guard.quoteDigest !== authorization.manifest.quoteDigest
    || guard.maximumUpstreamCalls !== 1
    || guard.maximumChargedCalls !== 1
    || !positiveInteger(guard.createdAt)
  ) fail("candidate_e_dispatch_guard_invalid");
  const quote = authorization.manifest.quote;
  const billing = checkpoint?.billing;
  if (
    checkpoint?.settlementState !== "settled"
    || checkpoint.data.length !== 1
    || !billing
    || billing.workspaceId !== quote.workspaceId
    || billing.model !== quote.model
    || billing.provider !== quote.provider
    || billing.channelId !== quote.channelId
    || billing.pricingRuleId !== quote.pricingRuleId
    || billing.reservedCostMicros !== quote.maximumCostMicros
    || billing.reservedUnits !== 1
    || billing.unit !== "image"
  ) fail("candidate_e_settled_checkpoint_binding_mismatch");
  writeExclusiveProtected(authorization.receiptFile, {
    version: "fanjin-candidate-e-settled-image-receipt/v1",
    manifestDigest: authorization.manifestDigest,
    operationBinding: authorization.manifest.operationBinding,
    sessionBinding: authorization.manifest.sessionBinding,
    idempotencyKeySha256: authorization.manifest.idempotencyKeySha256,
    quoteDigest: authorization.manifest.quoteDigest,
    reservationDigest: candidateESha256(billing.reservationId),
    usageDigest: candidateESha256(billing.usageRecordId),
    requestDigest: candidateESha256(billing.requestId),
    settlementState: "settled",
    providerResultCount: 1,
    upstreamCalls: 1,
    chargedCalls: 1,
    materializedAssets: 0,
    createdAt: Date.now(),
  }, "candidate_e_settled_receipt_exists");
  throw new CandidateESettledImageInjectedFailure();
}

export function createCandidateEOperationBinding(input: {
  sessionBinding: string;
  idempotencyKey: string;
  requestHash: string;
  model: string;
  quoteDigest: string;
  absorbedAuthorization: CandidateEAbsorbedFullMatrixAuthorization;
}): string {
  return candidateESha256(candidateEStableJson({
    sessionBinding: input.sessionBinding,
    idempotencyKeySha256: candidateESha256(input.idempotencyKey),
    requestHash: input.requestHash,
    model: input.model,
    quoteDigest: input.quoteDigest,
    absorbedAuthorizationDigest:
      candidateEAbsorbedAuthorizationDigest(input.absorbedAuthorization),
  }));
}

export function writeCandidateEArmingManifest(
  file: string,
  manifest: CandidateESettledImageArmingManifest,
): void {
  validateManifest(manifest as unknown as Record<string, unknown>, Date.now());
  writeExclusiveProtected(file, manifest, "candidate_e_arming_create_failed");
}

export function candidateERouteDigest(input: Parameters<typeof routeDigest>[0]): string {
  return routeDigest(input);
}
