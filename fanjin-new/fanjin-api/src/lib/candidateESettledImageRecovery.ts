import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  readCandidateExactAuthorizationRuntimePackageSnapshot,
} from "../../scripts/lib/candidate-exact-authorization-v2";

export const CANDIDATE_E_IMAGE_RECOVERY_AUTHORIZATION_HEADER =
  "x-fanjin-candidate-e-image-recovery-authorization";
export const CANDIDATE_E_IMAGE_RECOVERY_PROOF_HEADER =
  "x-fanjin-candidate-e-image-recovery-proof";
export const CANDIDATE_E_IMAGE_RECOVERY_GUARD_VERSION =
  "fanjin-candidate-e-image-recovery-authorization/v1" as const;
export const CANDIDATE_E_IMAGE_RECOVERY_PURPOSE =
  "candidate-e-settled-image-single-materialization" as const;
export const CANDIDATE_E_IMAGE_RECOVERY_PATH =
  "/api/workbench/create/images" as const;
export const CANDIDATE_E_IMAGE_RECOVERY_CONSUMED_SUFFIX =
  ".request-consumed" as const;
export const CANDIDATE_E_IMAGE_RECOVERY_RESULT_SUFFIX =
  ".request-result" as const;
export const CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_SUFFIX =
  ".operation-lock" as const;

const CANDIDATE_E_ARMING_VERSION =
  "fanjin-candidate-e-settled-image-arming/v1";
const CANDIDATE_E_DISPATCH_GUARD_VERSION =
  "fanjin-candidate-e-settled-image-guard/v1";
const CANDIDATE_E_SETTLED_RECEIPT_VERSION =
  "fanjin-candidate-e-settled-image-receipt/v1";
const CHECKPOINT_MATERIALIZE_HEADER =
  "x-fanjin-checkpoint-materialize-only";
const CHECKPOINT_MATERIALIZE_VALUE = "settled-provider-checkpoint-v1";
const FULL_MATRIX_PAID_GUARD_SUFFIX = ".paid-full-matrix.started";
const RECOVERY_GUARD_BASENAME =
  /^browser-session\.json\.image-checkpoint-materialize(?:\.\d{1,2}\.[a-f0-9]{16})?\.started$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const HMAC_SHA256 = /^hmac-sha256:[a-f0-9]{64}$/u;
const MAX_PROTECTED_JSON_BYTES = 8 * 1024 * 1024;
const CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_VERSION =
  "fanjin-candidate-e-image-recovery-operation-lock/v1" as const;
const CANDIDATE_E_IMAGE_RECOVERY_RESULT_VERSION =
  "fanjin-candidate-e-image-recovery-result/v3" as const;
const CANDIDATE_E_IMAGE_RECOVERY_CONSUMPTION_VERSION =
  "fanjin-candidate-e-image-recovery-consumption/v3" as const;
const RECOVERY_PROCESS_NONCE = crypto.randomBytes(32).toString("hex");

export class CandidateESettledImageRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CandidateESettledImageRecoveryError";
  }
}

type ProtectedFileBinding = Readonly<{
  path: string;
  digest: string;
  device: number;
  inode: number;
  size: number;
}>;

export type CandidateESettledImageRecoveryEvidence = Readonly<{
  arming: ProtectedFileBinding;
  dispatchGuard: ProtectedFileBinding;
  settledReceipt: ProtectedFileBinding;
  signedPaidGuard: ProtectedFileBinding;
  signedAuthorizationPackage: ProtectedFileBinding;
  manifestDigest: string;
  operationBinding: string;
  sessionBinding: string;
  quoteDigest: string;
}>;

export type CandidateESettledImageRecoveryGuard = Readonly<{
  version: typeof CANDIDATE_E_IMAGE_RECOVERY_GUARD_VERSION;
  purpose: typeof CANDIDATE_E_IMAGE_RECOVERY_PURPOSE;
  method: "POST";
  requestPath: typeof CANDIDATE_E_IMAGE_RECOVERY_PATH;
  authorizationFile: string;
  sessionFile: string;
  sessionBinding: string;
  manifestBinding: string;
  coverageKey: string;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  model: string;
  ratio: string;
  quality: string;
  count: 1;
  idempotencyHash: string;
  requestHashDigest: string;
  requestBodyDigest: string;
  sourceEvidence: CandidateESettledImageRecoveryEvidence;
  providerGenerationCallsAllowed: 0;
  paidGenerationSubmissionsAllowed: 0;
  materializedAssetsAllowed: 1;
  nonce: string;
  createdAt: string;
  authorizationDigest: string;
  authorizationSignature: string;
}>;

export type CandidateERecoveryTicket = Readonly<{
  guardFile: string;
  guardDigest: string;
  guard: CandidateESettledImageRecoveryGuard;
  consumptionKey: string;
  reconciled: boolean;
  bind: (request: object) => void;
  complete: (statusCode: number) => void;
  abort: () => void;
}>;

export type CandidateERecoveryMaterializationProof = Readonly<{
  durableCommandId: string;
  assetFingerprint: string;
}>;

type CandidateERecoveryOperationLock = Readonly<{
  version: typeof CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_VERSION;
  purpose: typeof CANDIDATE_E_IMAGE_RECOVERY_PURPOSE;
  consumptionKey: string;
  operationBinding: string;
  sessionBinding: string;
  manifestDigest: string;
  requestBodyDigest: string;
  ownerPid: number;
  ownerProcessNonce: string;
  createdAt: string;
}>;

type CandidateERecoveryHeldOperationLock = Readonly<{
  file: string;
  binding: ProtectedFileBinding;
  value: CandidateERecoveryOperationLock;
}>;

type CandidateERecoveryTicketState = {
  stage: "pending" | "active" | "committed" | "released";
  guardBinding: ProtectedFileBinding;
  guard: CandidateESettledImageRecoveryGuard;
  consumptionKey: string;
  consumedFile: string;
  resultFile: string;
  operationLockFile: string;
  operationLock: CandidateERecoveryHeldOperationLock | null;
  reconciled: boolean;
  request: object | null;
  transport: "open" | "finished" | "aborted";
};

const candidateERecoveryRequestTickets = new WeakMap<
  object,
  CandidateERecoveryTicket
>();
const candidateERecoveryTicketStates = new WeakMap<
  CandidateERecoveryTicket,
  CandidateERecoveryTicketState
>();
const activeCandidateERecoveryConsumptions = new Map<
  string,
  CandidateERecoveryTicket
>();

function fail(code: string): never {
  throw new CandidateESettledImageRecoveryError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function candidateERecoveryStableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(candidateERecoveryStableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${candidateERecoveryStableJson(value[key])}`
    )).join(",")}}`;
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value)
  ) {
    return JSON.stringify(value);
  }
  return fail("CANDIDATE_E_IMAGE_RECOVERY_CANONICAL_VALUE_INVALID");
}

export function candidateERecoverySha256(value: string | Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function recoverySignature(token: string, authorizationDigest: string): string {
  return `hmac-sha256:${crypto
    .createHmac("sha256", token)
    .update(`${CANDIDATE_E_IMAGE_RECOVERY_GUARD_VERSION}\0${authorizationDigest}`)
    .digest("hex")}`;
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length
    && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function readProtectedFile(
  file: string,
  maximumBytes = MAX_PROTECTED_JSON_BYTES,
): { binding: ProtectedFileBinding; bytes: Buffer } {
  if (
    typeof file !== "string"
    || !path.isAbsolute(file)
    || path.normalize(file) !== file
    || file.includes("\0")
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_PROTECTED_PATH_INVALID");
  }
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(file);
    const canonical = fs.realpathSync(file);
    if (
      canonical !== file
      || before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size < 2
      || before.size > maximumBytes
      || (
        typeof process.getuid === "function"
        && before.uid !== process.getuid()
      )
    ) {
      return fail("CANDIDATE_E_IMAGE_RECOVERY_PROTECTED_FILE_INVALID");
    }
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY
        | (typeof fs.constants.O_NOFOLLOW === "number"
          ? fs.constants.O_NOFOLLOW
          : 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== 0o600
    ) {
      return fail("CANDIDATE_E_IMAGE_RECOVERY_PROTECTED_FILE_CHANGED");
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
      return fail("CANDIDATE_E_IMAGE_RECOVERY_PROTECTED_FILE_CHANGED");
    }
    return {
      binding: Object.freeze({
        path: file,
        digest: candidateERecoverySha256(bytes),
        device: after.dev,
        inode: after.ino,
        size: after.size,
      }),
      bytes,
    };
  } catch (error) {
    if (error instanceof CandidateESettledImageRecoveryError) throw error;
    return fail("CANDIDATE_E_IMAGE_RECOVERY_PROTECTED_FILE_INVALID");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function readBoundAuthorizationPackage(
  file: string,
  identityBinding: unknown,
): { binding: ProtectedFileBinding; bytes: Buffer } {
  if (identityBinding === null) {
    return readProtectedFile(file, MAX_PROTECTED_JSON_BYTES);
  }
  if (!SHA256.test(String(identityBinding || ""))) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_SIGNED_BINDING_INVALID");
  }
  try {
    const readback = readCandidateExactAuthorizationRuntimePackageSnapshot({
      filePath: file,
      ownerUid: typeof process.getuid === "function" ? process.getuid() : 0,
      ownerGid: typeof process.getgid === "function" ? process.getgid() : 0,
      expectedIdentityBinding: String(identityBinding),
    });
    const device = Number(readback.identity.dev);
    const inode = Number(readback.identity.ino);
    if (
      !Number.isSafeInteger(device)
      || device < 0
      || !Number.isSafeInteger(inode)
      || inode < 0
    ) {
      return fail("CANDIDATE_E_IMAGE_RECOVERY_SIGNED_BINDING_INVALID");
    }
    return {
      binding: Object.freeze({
        path: readback.identity.canonicalPath,
        digest: readback.identity.fileDigest,
        device,
        inode,
        size: readback.identity.size,
      }),
      bytes: readback.bytes,
    };
  } catch (error) {
    if (error instanceof CandidateESettledImageRecoveryError) throw error;
    return fail("CANDIDATE_E_IMAGE_RECOVERY_SIGNED_BINDING_INVALID");
  }
}

function parseProtectedJson(
  file: string,
  maximumBytes = MAX_PROTECTED_JSON_BYTES,
): { binding: ProtectedFileBinding; value: Record<string, unknown> } {
  const protectedFile = readProtectedFile(file, maximumBytes);
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(protectedFile.bytes),
    );
    if (!isRecord(value)) {
      return fail("CANDIDATE_E_IMAGE_RECOVERY_PROTECTED_JSON_INVALID");
    }
    return { binding: protectedFile.binding, value };
  } catch (error) {
    if (error instanceof CandidateESettledImageRecoveryError) throw error;
    return fail("CANDIDATE_E_IMAGE_RECOVERY_PROTECTED_JSON_INVALID");
  }
}

function bindingMatches(
  actual: ProtectedFileBinding,
  expected: unknown,
): boolean {
  if (!isRecord(expected) || !exactKeys(expected, [
    "path", "digest", "device", "inode", "size",
  ])) return false;
  return expected.path === actual.path
    && expected.digest === actual.digest
    && expected.device === actual.device
    && expected.inode === actual.inode
    && expected.size === actual.size;
}

function protectedBindingShape(value: unknown): value is ProtectedFileBinding {
  return isRecord(value)
    && exactKeys(value, ["path", "digest", "device", "inode", "size"])
    && typeof value.path === "string"
    && path.isAbsolute(value.path)
    && path.normalize(value.path) === value.path
    && !value.path.includes("\0")
    && SHA256.test(String(value.digest || ""))
    && typeof value.device === "number"
    && Number.isSafeInteger(value.device)
    && value.device >= 0
    && typeof value.inode === "number"
    && Number.isSafeInteger(value.inode)
    && value.inode > 0
    && typeof value.size === "number"
    && Number.isSafeInteger(value.size)
    && value.size >= 2;
}

function readSession(file: string): {
  token: string;
  workspaceId: string;
  userId: number;
  projectId: number;
} {
  const { value } = parseProtectedJson(file, 256 * 1024);
  const token = String(value.token || "").trim();
  const workspaceId = String(value.workspaceId || "").trim();
  const userId = Number(value.userId);
  const projectId = Number(value.projectId);
  if (
    token.length < 16
    || token.length > 16 * 1024
    || !workspaceId
    || !Number.isSafeInteger(userId)
    || userId <= 0
    || !Number.isSafeInteger(projectId)
    || projectId <= 0
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_SESSION_INVALID");
  }
  return { token, workspaceId, userId, projectId };
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

/**
 * Reads the irreversible Candidate E sidecars and cross-binds them to the
 * exact signed full-matrix operation. No provider or database call occurs.
 */
export function bindCandidateESettledImageRecoveryEvidence(input: {
  sessionFile: string;
  armingFile: string;
  candidateESessionBinding: string;
  driverSessionBinding: string;
  coverageKey: string;
  idempotencyHash: string;
  requestHash: string;
  model: string;
  ratio: string;
  quality: string;
  count: 1;
}): CandidateESettledImageRecoveryEvidence {
  const parent = path.dirname(input.sessionFile);
  if (
    path.dirname(input.armingFile) !== parent
    || !/^candidate-e-[a-f0-9]{22}-[a-f0-9]{64}\.json$/u.test(
      path.basename(input.armingFile),
    )
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_ARMING_PATH_INVALID");
  }
  const arming = parseProtectedJson(input.armingFile, 64 * 1024);
  const absorbed = isRecord(arming.value.absorbedAuthorization)
    ? arming.value.absorbedAuthorization
    : null;
  const quote = isRecord(arming.value.quote) ? arming.value.quote : null;
  if (
    !absorbed
    || !quote
    || arming.value.version !== CANDIDATE_E_ARMING_VERSION
    || arming.value.sessionBinding !== input.candidateESessionBinding
    || arming.value.idempotencyKeySha256 !== input.idempotencyHash
    || arming.value.requestHash !== input.requestHash
    || arming.value.model !== input.model
    || arming.value.count !== input.count
    || absorbed.candidateKey !== "full-matrix/mixed"
    || absorbed.operationKey !== input.coverageKey
    || absorbed.operationModel !== input.model
    || absorbed.operationRatio !== input.ratio
    || absorbed.operationQuality !== input.quality
    || absorbed.operationCount !== input.count
    || quote.model !== input.model
    || quote.ratio !== input.ratio
    || quote.quality !== input.quality
    || quote.requestUnits !== input.count
    || !SHA256.test(String(arming.value.operationBinding || ""))
    || !SHA256.test(String(arming.value.quoteDigest || ""))
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_ARMING_BINDING_INVALID");
  }
  const packageDigest = String(absorbed.packageDigest || "");
  const expectedArmingFile = path.join(
    parent,
    `candidate-e-${candidateERecoverySha256(input.coverageKey).slice(7, 29)}-${
      packageDigest.slice(7)
    }.json`,
  );
  if (!SHA256.test(packageDigest) || input.armingFile !== expectedArmingFile) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_ARMING_PATH_INVALID");
  }
  const manifestDigest = candidateERecoverySha256(
    candidateERecoveryStableJson(arming.value),
  );
  const dispatchGuardFile = `${input.armingFile}.started`;
  const settledReceiptFile = `${input.armingFile}.settled`;
  const dispatchGuard = parseProtectedJson(dispatchGuardFile, 64 * 1024);
  const settledReceipt = parseProtectedJson(settledReceiptFile, 64 * 1024);
  if (
    !exactKeys(dispatchGuard.value, [
      "version", "manifestDigest", "operationBinding", "sessionBinding",
      "idempotencyKeySha256", "quoteDigest", "maximumUpstreamCalls",
      "maximumChargedCalls", "createdAt",
    ])
    || dispatchGuard.value.version !== CANDIDATE_E_DISPATCH_GUARD_VERSION
    || dispatchGuard.value.manifestDigest !== manifestDigest
    || dispatchGuard.value.operationBinding !== arming.value.operationBinding
    || dispatchGuard.value.sessionBinding !== input.candidateESessionBinding
    || dispatchGuard.value.idempotencyKeySha256 !== input.idempotencyHash
    || dispatchGuard.value.quoteDigest !== arming.value.quoteDigest
    || dispatchGuard.value.maximumUpstreamCalls !== 1
    || dispatchGuard.value.maximumChargedCalls !== 1
    || !positiveInteger(dispatchGuard.value.createdAt)
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_DISPATCH_GUARD_INVALID");
  }
  if (
    !exactKeys(settledReceipt.value, [
      "version", "manifestDigest", "operationBinding", "sessionBinding",
      "idempotencyKeySha256", "quoteDigest", "reservationDigest",
      "usageDigest", "requestDigest", "settlementState",
      "providerResultCount", "upstreamCalls", "chargedCalls",
      "materializedAssets", "createdAt",
    ])
    || settledReceipt.value.version !== CANDIDATE_E_SETTLED_RECEIPT_VERSION
    || settledReceipt.value.manifestDigest !== manifestDigest
    || settledReceipt.value.operationBinding !== arming.value.operationBinding
    || settledReceipt.value.sessionBinding !== input.candidateESessionBinding
    || settledReceipt.value.idempotencyKeySha256 !== input.idempotencyHash
    || settledReceipt.value.quoteDigest !== arming.value.quoteDigest
    || !SHA256.test(String(settledReceipt.value.reservationDigest || ""))
    || !SHA256.test(String(settledReceipt.value.usageDigest || ""))
    || !SHA256.test(String(settledReceipt.value.requestDigest || ""))
    || settledReceipt.value.settlementState !== "settled"
    || settledReceipt.value.providerResultCount !== 1
    || settledReceipt.value.upstreamCalls !== 1
    || settledReceipt.value.chargedCalls !== 1
    || settledReceipt.value.materializedAssets !== 0
    || !positiveInteger(settledReceipt.value.createdAt)
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_SETTLED_RECEIPT_INVALID");
  }

  const paidGuardFile = String(absorbed.fullMatrixGuardFile || "");
  const authorizationPackageFile = String(
    absorbed.authorizationPackageFile || "",
  );
  if (
    paidGuardFile !== `${input.sessionFile}${FULL_MATRIX_PAID_GUARD_SUFFIX}`
    || !path.isAbsolute(authorizationPackageFile)
    || path.normalize(authorizationPackageFile) !== authorizationPackageFile
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_SIGNED_PATH_INVALID");
  }
  const paidGuard = readProtectedFile(paidGuardFile, 64 * 1024);
  const authorizationPackage = readBoundAuthorizationPackage(
    authorizationPackageFile,
    absorbed.authorizationPackageIdentityBinding,
  );
  if (
    paidGuard.binding.digest !== absorbed.fullMatrixGuardDigest
    || authorizationPackage.binding.digest
      !== absorbed.authorizationPackageFileDigest
    || absorbed.driverSessionBinding !== input.driverSessionBinding
    || !SHA256.test(String(absorbed.guardDigest || ""))
    || !SHA256.test(String(absorbed.guardConsumptionProofDigest || ""))
    || !SHA256.test(String(absorbed.packageDigest || ""))
    || !SHA256.test(String(absorbed.entryDigest || ""))
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_SIGNED_BINDING_INVALID");
  }
  return Object.freeze({
    arming: arming.binding,
    dispatchGuard: dispatchGuard.binding,
    settledReceipt: settledReceipt.binding,
    signedPaidGuard: paidGuard.binding,
    signedAuthorizationPackage: authorizationPackage.binding,
    manifestDigest,
    operationBinding: String(arming.value.operationBinding),
    sessionBinding: input.candidateESessionBinding,
    quoteDigest: String(arming.value.quoteDigest),
  });
}

export function buildCandidateESettledImageRecoveryGuard(input: {
  authorizationFile: string;
  sessionFile: string;
  sessionToken: string;
  sessionBinding: string;
  manifestBinding: string;
  coverageKey: string;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  model: string;
  ratio: string;
  quality: string;
  count: 1;
  idempotencyHash: string;
  requestHashDigest: string;
  requestBody: unknown;
  sourceEvidence: CandidateESettledImageRecoveryEvidence;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): CandidateESettledImageRecoveryGuard {
  if (
    !path.isAbsolute(input.authorizationFile)
    || path.normalize(input.authorizationFile) !== input.authorizationFile
    || path.dirname(input.authorizationFile) !== path.dirname(input.sessionFile)
    || !RECOVERY_GUARD_BASENAME.test(path.basename(input.authorizationFile))
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_AUTHORIZATION_PATH_INVALID");
  const body = {
    version: CANDIDATE_E_IMAGE_RECOVERY_GUARD_VERSION,
    purpose: CANDIDATE_E_IMAGE_RECOVERY_PURPOSE,
    method: "POST" as const,
    requestPath: CANDIDATE_E_IMAGE_RECOVERY_PATH,
    authorizationFile: input.authorizationFile,
    sessionFile: input.sessionFile,
    sessionBinding: input.sessionBinding,
    manifestBinding: input.manifestBinding,
    coverageKey: input.coverageKey,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    model: input.model,
    ratio: input.ratio,
    quality: input.quality,
    count: input.count,
    idempotencyHash: input.idempotencyHash,
    requestHashDigest: input.requestHashDigest,
    requestBodyDigest: candidateERecoverySha256(
      candidateERecoveryStableJson(input.requestBody),
    ),
    sourceEvidence: input.sourceEvidence,
    providerGenerationCallsAllowed: 0 as const,
    paidGenerationSubmissionsAllowed: 0 as const,
    materializedAssetsAllowed: 1 as const,
    nonce: (input.randomBytes || crypto.randomBytes)(32).toString("hex"),
    createdAt: new Date((input.now || Date.now)()).toISOString(),
  };
  const authorizationDigest = candidateERecoverySha256(
    candidateERecoveryStableJson(body),
  );
  return Object.freeze({
    ...body,
    authorizationDigest,
    authorizationSignature: recoverySignature(
      input.sessionToken,
      authorizationDigest,
    ),
  });
}

function parseRecoveryGuard(value: Record<string, unknown>): CandidateESettledImageRecoveryGuard {
  if (!exactKeys(value, [
    "version", "purpose", "method", "requestPath", "authorizationFile",
    "sessionFile",
    "sessionBinding", "manifestBinding", "coverageKey", "workspaceId",
    "actorUserId", "projectId", "model", "ratio", "quality", "count",
    "idempotencyHash", "requestHashDigest", "requestBodyDigest",
    "sourceEvidence", "providerGenerationCallsAllowed",
    "paidGenerationSubmissionsAllowed", "materializedAssetsAllowed",
    "nonce", "createdAt", "authorizationDigest", "authorizationSignature",
  ])) return fail("CANDIDATE_E_IMAGE_RECOVERY_GUARD_SHAPE_INVALID");
  const source = value.sourceEvidence;
  if (
    !isRecord(source)
    || !exactKeys(source, [
      "arming", "dispatchGuard", "settledReceipt", "signedPaidGuard",
      "signedAuthorizationPackage", "manifestDigest", "operationBinding",
      "sessionBinding", "quoteDigest",
    ])
    || value.version !== CANDIDATE_E_IMAGE_RECOVERY_GUARD_VERSION
    || value.purpose !== CANDIDATE_E_IMAGE_RECOVERY_PURPOSE
    || value.method !== "POST"
    || value.requestPath !== CANDIDATE_E_IMAGE_RECOVERY_PATH
    || typeof value.authorizationFile !== "string"
    || !path.isAbsolute(value.authorizationFile)
    || path.normalize(value.authorizationFile) !== value.authorizationFile
    || !RECOVERY_GUARD_BASENAME.test(path.basename(value.authorizationFile))
    || value.providerGenerationCallsAllowed !== 0
    || value.paidGenerationSubmissionsAllowed !== 0
    || value.materializedAssetsAllowed !== 1
    || value.count !== 1
    || !positiveInteger(value.actorUserId)
    || !positiveInteger(value.projectId)
    || !SHA256.test(String(value.sessionBinding || ""))
    || !SHA256.test(String(value.manifestBinding || ""))
    || !SHA256.test(String(value.idempotencyHash || ""))
    || !SHA256.test(String(value.requestHashDigest || ""))
    || !SHA256.test(String(value.requestBodyDigest || ""))
    || !SHA256.test(String(value.authorizationDigest || ""))
    || !HMAC_SHA256.test(String(value.authorizationSignature || ""))
    || !/^[a-f0-9]{64}$/u.test(String(value.nonce || ""))
    || !Number.isFinite(Date.parse(String(value.createdAt || "")))
    || !protectedBindingShape(source.arming)
    || !protectedBindingShape(source.dispatchGuard)
    || !protectedBindingShape(source.settledReceipt)
    || !protectedBindingShape(source.signedPaidGuard)
    || !protectedBindingShape(source.signedAuthorizationPackage)
    || !SHA256.test(String(source.manifestDigest || ""))
    || !SHA256.test(String(source.operationBinding || ""))
    || !SHA256.test(String(source.sessionBinding || ""))
    || !SHA256.test(String(source.quoteDigest || ""))
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_GUARD_INVALID");
  return value as unknown as CandidateESettledImageRecoveryGuard;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY
      | (typeof fs.constants.O_DIRECTORY === "number"
        ? fs.constants.O_DIRECTORY
        : 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeExclusiveProtected(
  file: string,
  value: unknown,
): "created" | "exists" {
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY
        | (typeof fs.constants.O_NOFOLLOW === "number"
          ? fs.constants.O_NOFOLLOW
          : 0),
      0o600,
    );
    created = true;
    fs.writeFileSync(
      descriptor,
      `${candidateERecoveryStableJson(value)}\n`,
      "utf8",
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(path.dirname(file));
    return "created";
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Continue into the fail-closed cleanup below.
      }
      descriptor = null;
    }
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST" && !created) {
      return "exists";
    }
    if (created) {
      try {
        fs.unlinkSync(file);
        fsyncDirectory(path.dirname(file));
      } catch {
        // A partial protected file is intentionally left fail-closed.
      }
    }
    return fail("CANDIDATE_E_IMAGE_RECOVERY_STATE_WRITE_FAILED");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function revalidateSourceEvidence(
  source: CandidateESettledImageRecoveryEvidence,
): void {
  for (const key of [
    "arming", "dispatchGuard", "settledReceipt", "signedPaidGuard",
    "signedAuthorizationPackage",
  ] as const) {
    const expected = source[key];
    const actual = readProtectedFile(
      expected.path,
      key === "signedAuthorizationPackage"
        ? MAX_PROTECTED_JSON_BYTES
        : 64 * 1024,
    ).binding;
    if (!bindingMatches(actual, expected)) {
      return fail("CANDIDATE_E_IMAGE_RECOVERY_SOURCE_CHANGED");
    }
  }
  if (
    source.dispatchGuard.path !== `${source.arming.path}.started`
    || source.settledReceipt.path !== `${source.arming.path}.settled`
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_SOURCE_PATH_INVALID");
}

export function candidateESettledImageRecoveryStateFiles(
  guard: CandidateESettledImageRecoveryGuard,
): Readonly<{
  consumptionKey: string;
  consumedFile: string;
  resultFile: string;
  operationLockFile: string;
}> {
  const consumptionKey = candidateERecoverySha256(
    candidateERecoveryStableJson({
      version: "fanjin-candidate-e-image-recovery-consumption-key/v2",
      operationBinding: guard.sourceEvidence.operationBinding,
    }),
  );
  const basename = `.candidate-e-image-recovery-${consumptionKey.slice(7)}`;
  const directory = path.dirname(guard.authorizationFile);
  return Object.freeze({
    consumptionKey,
    consumedFile: path.join(
      directory,
      `${basename}${CANDIDATE_E_IMAGE_RECOVERY_CONSUMED_SUFFIX}`,
    ),
    resultFile: path.join(
      directory,
      `${basename}${CANDIDATE_E_IMAGE_RECOVERY_RESULT_SUFFIX}`,
    ),
    operationLockFile: path.join(
      directory,
      `${basename}${CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_SUFFIX}`,
    ),
  });
}

function optionalProtectedJson(
  file: string,
): { binding: ProtectedFileBinding; value: Record<string, unknown> } | null {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return fail("CANDIDATE_E_IMAGE_RECOVERY_STATE_INVALID");
  }
  return parseProtectedJson(file, 64 * 1024);
}

function operationLockRecord(
  state: CandidateERecoveryTicketState,
): CandidateERecoveryOperationLock {
  return Object.freeze({
    version: CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_VERSION,
    purpose: CANDIDATE_E_IMAGE_RECOVERY_PURPOSE,
    consumptionKey: state.consumptionKey,
    operationBinding: state.guard.sourceEvidence.operationBinding,
    sessionBinding: state.guard.sourceEvidence.sessionBinding,
    manifestDigest: state.guard.sourceEvidence.manifestDigest,
    requestBodyDigest: state.guard.requestBodyDigest,
    ownerPid: process.pid,
    ownerProcessNonce: RECOVERY_PROCESS_NONCE,
    createdAt: new Date().toISOString(),
  });
}

function parseOperationLock(
  value: Record<string, unknown>,
): CandidateERecoveryOperationLock {
  if (
    !exactKeys(value, [
      "version", "purpose", "consumptionKey", "operationBinding",
      "sessionBinding", "manifestDigest", "requestBodyDigest", "ownerPid",
      "ownerProcessNonce", "createdAt",
    ])
    || value.version !== CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_VERSION
    || value.purpose !== CANDIDATE_E_IMAGE_RECOVERY_PURPOSE
    || !SHA256.test(String(value.consumptionKey || ""))
    || !SHA256.test(String(value.operationBinding || ""))
    || !SHA256.test(String(value.sessionBinding || ""))
    || !SHA256.test(String(value.manifestDigest || ""))
    || !SHA256.test(String(value.requestBodyDigest || ""))
    || !Number.isSafeInteger(value.ownerPid)
    || Number(value.ownerPid) <= 0
    || !/^[a-f0-9]{64}$/u.test(String(value.ownerProcessNonce || ""))
    || !Number.isFinite(Date.parse(String(value.createdAt || "")))
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_INVALID");
  return value as unknown as CandidateERecoveryOperationLock;
}

function operationLockMatchesState(
  value: CandidateERecoveryOperationLock,
  state: CandidateERecoveryTicketState,
): boolean {
  return value.consumptionKey === state.consumptionKey
    && value.operationBinding === state.guard.sourceEvidence.operationBinding
    && value.sessionBinding === state.guard.sourceEvidence.sessionBinding
    && value.manifestDigest === state.guard.sourceEvidence.manifestDigest
    && value.requestBodyDigest === state.guard.requestBodyDigest;
}

function operationLockOwnerAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but is owned by another identity. Every
    // other result is ambiguous, so recovery remains fail-closed.
    if (code === "EPERM") return true;
    return fail("CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_LIVENESS_UNKNOWN");
  }
}

function readOperationLock(
  file: string,
): CandidateERecoveryHeldOperationLock {
  const parsed = parseProtectedJson(file, 64 * 1024);
  return Object.freeze({
    file,
    binding: parsed.binding,
    value: parseOperationLock(parsed.value),
  });
}

function unlinkDeadOperationLock(
  held: CandidateERecoveryHeldOperationLock,
  state: CandidateERecoveryTicketState,
): void {
  if (
    !operationLockMatchesState(held.value, state)
    || operationLockOwnerAlive(held.value.ownerPid)
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_IN_PROGRESS");
  const current = readOperationLock(held.file);
  if (
    !bindingMatches(current.binding, held.binding)
    || candidateERecoveryStableJson(current.value)
      !== candidateERecoveryStableJson(held.value)
    || operationLockOwnerAlive(current.value.ownerPid)
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_IN_PROGRESS");
  try {
    // The owner is observed dead twice around an inode-checked read. A live or
    // uninspectable owner is never reclaimed; ambiguity is deliberately fatal.
    fs.unlinkSync(held.file);
    fsyncDirectory(path.dirname(held.file));
  } catch {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_RECLAIM_FAILED");
  }
}

function acquireOperationLock(state: CandidateERecoveryTicketState): void {
  const value = operationLockRecord(state);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const disposition = writeExclusiveProtected(state.operationLockFile, value);
    if (disposition === "created") {
      const held = readOperationLock(state.operationLockFile);
      if (
        !operationLockMatchesState(held.value, state)
        || held.value.ownerPid !== process.pid
        || held.value.ownerProcessNonce !== RECOVERY_PROCESS_NONCE
        || candidateERecoveryStableJson(held.value)
          !== candidateERecoveryStableJson(value)
      ) return fail("CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_INVALID");
      state.operationLock = held;
      return;
    }
    const existing = readOperationLock(state.operationLockFile);
    if (!operationLockMatchesState(existing.value, state)) {
      return fail("CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_INVALID");
    }
    if (operationLockOwnerAlive(existing.value.ownerPid) || attempt > 0) {
      return fail("CANDIDATE_E_IMAGE_RECOVERY_IN_PROGRESS");
    }
    unlinkDeadOperationLock(existing, state);
  }
  return fail("CANDIDATE_E_IMAGE_RECOVERY_IN_PROGRESS");
}

function releaseOperationLock(state: CandidateERecoveryTicketState): void {
  const held = state.operationLock;
  if (!held) return;
  const current = readOperationLock(held.file);
  if (
    !bindingMatches(current.binding, held.binding)
    || current.value.ownerPid !== process.pid
    || current.value.ownerProcessNonce !== RECOVERY_PROCESS_NONCE
    || candidateERecoveryStableJson(current.value)
      !== candidateERecoveryStableJson(held.value)
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_CHANGED");
  try {
    fs.unlinkSync(held.file);
    fsyncDirectory(path.dirname(held.file));
    state.operationLock = null;
  } catch {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_OPERATION_LOCK_RELEASE_FAILED");
  }
}

function successfulResultMatches(
  value: Record<string, unknown>,
  guard: CandidateESettledImageRecoveryGuard,
  consumptionKey: string,
): boolean {
  return exactKeys(value, [
    "version", "purpose", "consumptionKey", "operationBinding",
    "sessionBinding", "manifestDigest", "requestBodyDigest",
    "idempotencyHash", "durableCommandId", "assetFingerprint",
    "state", "statusCode", "materializedAssets",
    "providerGenerationCalls", "paidGenerationSubmissions", "completedAt",
  ])
    && value.version === CANDIDATE_E_IMAGE_RECOVERY_RESULT_VERSION
    && value.purpose === CANDIDATE_E_IMAGE_RECOVERY_PURPOSE
    && value.consumptionKey === consumptionKey
    && value.operationBinding === guard.sourceEvidence.operationBinding
    && value.sessionBinding === guard.sourceEvidence.sessionBinding
    && value.manifestDigest === guard.sourceEvidence.manifestDigest
    && value.requestBodyDigest === guard.requestBodyDigest
    && value.idempotencyHash === guard.idempotencyHash
    && typeof value.durableCommandId === "string"
    && value.durableCommandId.length > 0
    && value.durableCommandId.length <= 200
    && SHA256.test(String(value.assetFingerprint || ""))
    && value.state === "finished"
    && value.statusCode === 200
    && value.materializedAssets === 1
    && value.providerGenerationCalls === 0
    && value.paidGenerationSubmissions === 0
    && Number.isFinite(Date.parse(String(value.completedAt || "")));
}

function successfulConsumptionMatches(
  value: Record<string, unknown>,
  guard: CandidateESettledImageRecoveryGuard,
  consumptionKey: string,
): boolean {
  return exactKeys(value, [
    "version", "purpose", "consumptionKey", "operationBinding",
    "sessionBinding", "manifestDigest", "requestBodyDigest",
    "idempotencyHash", "durableCommandId", "assetFingerprint",
    "providerGenerationCallsAllowed", "paidGenerationSubmissionsAllowed",
    "materializedAssets", "consumedAt",
  ])
    && value.version === CANDIDATE_E_IMAGE_RECOVERY_CONSUMPTION_VERSION
    && value.purpose === CANDIDATE_E_IMAGE_RECOVERY_PURPOSE
    && value.consumptionKey === consumptionKey
    && value.operationBinding === guard.sourceEvidence.operationBinding
    && value.sessionBinding === guard.sourceEvidence.sessionBinding
    && value.manifestDigest === guard.sourceEvidence.manifestDigest
    && value.requestBodyDigest === guard.requestBodyDigest
    && value.idempotencyHash === guard.idempotencyHash
    && typeof value.durableCommandId === "string"
    && value.durableCommandId.length > 0
    && value.durableCommandId.length <= 200
    && SHA256.test(String(value.assetFingerprint || ""))
    && value.providerGenerationCallsAllowed === 0
    && value.paidGenerationSubmissionsAllowed === 0
    && value.materializedAssets === 1
    && Number.isFinite(Date.parse(String(value.consumedAt || "")));
}

function successfulConsumptionRecord(
  guard: CandidateESettledImageRecoveryGuard,
  consumptionKey: string,
  consumedAt: string,
  proof: CandidateERecoveryMaterializationProof,
): Record<string, unknown> {
  return {
    version: CANDIDATE_E_IMAGE_RECOVERY_CONSUMPTION_VERSION,
    purpose: CANDIDATE_E_IMAGE_RECOVERY_PURPOSE,
    consumptionKey,
    operationBinding: guard.sourceEvidence.operationBinding,
    sessionBinding: guard.sourceEvidence.sessionBinding,
    manifestDigest: guard.sourceEvidence.manifestDigest,
    requestBodyDigest: guard.requestBodyDigest,
    idempotencyHash: guard.idempotencyHash,
    durableCommandId: proof.durableCommandId,
    assetFingerprint: proof.assetFingerprint,
    providerGenerationCallsAllowed: 0,
    paidGenerationSubmissionsAllowed: 0,
    materializedAssets: 1,
    consumedAt,
  };
}

function successfulResultAndConsumptionMatch(
  result: Record<string, unknown>,
  consumption: Record<string, unknown>,
): boolean {
  return result.durableCommandId === consumption.durableCommandId
    && result.assetFingerprint === consumption.assetFingerprint
    && result.completedAt === consumption.consumedAt;
}

function reconcileSuccessfulResult(
  guard: CandidateESettledImageRecoveryGuard,
): boolean {
  const stateFiles = candidateESettledImageRecoveryStateFiles(guard);
  const result = optionalProtectedJson(stateFiles.resultFile);
  const consumed = optionalProtectedJson(stateFiles.consumedFile);
  if (!result) {
    if (consumed) {
      return fail("CANDIDATE_E_IMAGE_RECOVERY_CONSUMPTION_AMBIGUOUS");
    }
    return false;
  }
  if (!successfulResultMatches(
    result.value,
    guard,
    stateFiles.consumptionKey,
  )) return fail("CANDIDATE_E_IMAGE_RECOVERY_RESULT_INVALID");
  if (!consumed) {
    const disposition = writeExclusiveProtected(
      stateFiles.consumedFile,
      successfulConsumptionRecord(
        guard,
        stateFiles.consumptionKey,
        String(result.value.completedAt),
        {
          durableCommandId: String(result.value.durableCommandId),
          assetFingerprint: String(result.value.assetFingerprint),
        },
      ),
    );
    if (disposition === "exists") {
      const raced = optionalProtectedJson(stateFiles.consumedFile);
      if (
        !raced
        || !successfulConsumptionMatches(
          raced.value,
          guard,
          stateFiles.consumptionKey,
        )
        || !successfulResultAndConsumptionMatch(result.value, raced.value)
      ) return fail("CANDIDATE_E_IMAGE_RECOVERY_RESULT_INVALID");
    }
  } else if (!successfulConsumptionMatches(
    consumed.value,
    guard,
    stateFiles.consumptionKey,
  ) || !successfulResultAndConsumptionMatch(
    result.value,
    consumed.value,
  )) return fail("CANDIDATE_E_IMAGE_RECOVERY_RESULT_INVALID");
  return true;
}

function revalidateGuard(
  state: CandidateERecoveryTicketState,
): void {
  const current = readProtectedFile(state.guard.authorizationFile, 256 * 1024)
    .binding;
  if (!bindingMatches(current, state.guardBinding)) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_GUARD_CHANGED");
  }
  revalidateSourceEvidence(state.guard.sourceEvidence);
}

function stateForRequest(request: object): {
  ticket: CandidateERecoveryTicket;
  state: CandidateERecoveryTicketState;
} {
  const ticket = candidateERecoveryRequestTickets.get(request);
  const state = ticket ? candidateERecoveryTicketStates.get(ticket) : null;
  if (!ticket || !state || state.request !== request) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_CAPABILITY_REQUIRED");
  }
  return { ticket, state };
}

function releaseTicket(
  ticket: CandidateERecoveryTicket,
  state: CandidateERecoveryTicketState,
): void {
  releaseOperationLock(state);
  if (
    activeCandidateERecoveryConsumptions.get(state.consumptionKey) === ticket
  ) {
    activeCandidateERecoveryConsumptions.delete(state.consumptionKey);
  }
  if (state.stage !== "committed") state.stage = "released";
}

/**
 * Verifies one recovery-only POST without consuming it. The returned ticket can
 * only become a route capability after bind() attaches it to the exact Request
 * object. Permanent consumption is deferred until the already-settled provider
 * checkpoint has been materialized and committed successfully.
 */
export function authorizeCandidateESettledImageRecoveryRequest(input: {
  method: unknown;
  target: unknown;
  body: unknown;
  headers: Record<string, unknown>;
}): CandidateERecoveryTicket | null {
  const authorizationFile = String(
    input.headers[CANDIDATE_E_IMAGE_RECOVERY_AUTHORIZATION_HEADER] || "",
  ).trim();
  const proof = String(
    input.headers[CANDIDATE_E_IMAGE_RECOVERY_PROOF_HEADER] || "",
  ).trim();
  if (!authorizationFile && !proof) return null;
  if (
    String(input.method || "").toUpperCase() !== "POST"
    || String(input.target || "") !== CANDIDATE_E_IMAGE_RECOVERY_PATH
    || input.headers[CHECKPOINT_MATERIALIZE_HEADER]
      !== CHECKPOINT_MATERIALIZE_VALUE
    || !authorizationFile
    || !proof
    || !path.isAbsolute(authorizationFile)
    || path.normalize(authorizationFile) !== authorizationFile
    || !RECOVERY_GUARD_BASENAME.test(path.basename(authorizationFile))
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_REQUEST_INVALID");

  const protectedGuard = parseProtectedJson(authorizationFile, 256 * 1024);
  const guard = parseRecoveryGuard(protectedGuard.value);
  const authorizationDirectory = path.dirname(authorizationFile);
  let directory: fs.Stats;
  try {
    directory = fs.lstatSync(authorizationDirectory);
    if (
      fs.realpathSync(authorizationDirectory) !== authorizationDirectory
      || directory.isSymbolicLink()
      || !directory.isDirectory()
      || (directory.mode & 0o777) !== 0o700
      || (
        typeof process.getuid === "function"
        && directory.uid !== process.getuid()
      )
    ) return fail("CANDIDATE_E_IMAGE_RECOVERY_DIRECTORY_INVALID");
  } catch (error) {
    if (error instanceof CandidateESettledImageRecoveryError) throw error;
    return fail("CANDIDATE_E_IMAGE_RECOVERY_DIRECTORY_INVALID");
  }
  const sessionFile = path.join(
    authorizationDirectory,
    "browser-session.json",
  );
  if (
    guard.authorizationFile !== authorizationFile
    || guard.sessionFile !== sessionFile
    || path.dirname(guard.sourceEvidence.arming.path) !== path.dirname(sessionFile)
    || guard.sourceEvidence.signedPaidGuard.path
      !== `${sessionFile}${FULL_MATRIX_PAID_GUARD_SUFFIX}`
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_SCOPE_INVALID");
  const session = readSession(sessionFile);
  const requestBody = isRecord(input.body) ? input.body : null;
  const { authorizationDigest: _digest, authorizationSignature: _signature, ...body } = guard;
  const expectedDigest = candidateERecoverySha256(
    candidateERecoveryStableJson(body),
  );
  const expectedSignature = recoverySignature(session.token, expectedDigest);
  if (
    guard.authorizationDigest !== expectedDigest
    || !timingSafeEqual(guard.authorizationSignature, expectedSignature)
    || !timingSafeEqual(proof, expectedSignature)
    || guard.workspaceId !== session.workspaceId
    || guard.actorUserId !== session.userId
    || guard.projectId !== session.projectId
    || !requestBody
    || !exactKeys(requestBody, [
      "projectId", "model", "prompt", "ratio", "quality", "count",
      "references",
    ])
    || requestBody.projectId !== guard.projectId
    || requestBody.model !== guard.model
    || requestBody.ratio !== guard.ratio
    || requestBody.quality !== guard.quality
    || requestBody.count !== 1
    || !Array.isArray(requestBody.references)
    || requestBody.references.length !== 0
    || typeof requestBody.prompt !== "string"
    || !requestBody.prompt.trim()
    || guard.requestBodyDigest !== candidateERecoverySha256(
      candidateERecoveryStableJson(input.body),
    )
    || candidateERecoverySha256(String(input.headers["idempotency-key"] || ""))
      !== guard.idempotencyHash
    || String(input.headers["x-request-id"] || "")
      !== String(input.headers["idempotency-key"] || "")
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_PROOF_INVALID");
  revalidateSourceEvidence(guard.sourceEvidence);
  const stateFiles = candidateESettledImageRecoveryStateFiles(guard);
  const reconciled = reconcileSuccessfulResult(guard);
  let ticket!: CandidateERecoveryTicket;
  ticket = Object.freeze({
    guardFile: authorizationFile,
    guardDigest: protectedGuard.binding.digest,
    guard,
    consumptionKey: stateFiles.consumptionKey,
    reconciled,
    bind: (request) => {
      if (!request || typeof request !== "object") {
        return fail("CANDIDATE_E_IMAGE_RECOVERY_REQUEST_BINDING_INVALID");
      }
      const state = candidateERecoveryTicketStates.get(ticket);
      if (!state || state.stage !== "pending") {
        return fail("CANDIDATE_E_IMAGE_RECOVERY_CAPABILITY_INVALID");
      }
      const existing = candidateERecoveryRequestTickets.get(request);
      if (existing && existing !== ticket) {
        return fail("CANDIDATE_E_IMAGE_RECOVERY_REQUEST_ALREADY_BOUND");
      }
      if (state.request && state.request !== request) {
        return fail("CANDIDATE_E_IMAGE_RECOVERY_TICKET_ALREADY_BOUND");
      }
      state.request = request;
      candidateERecoveryRequestTickets.set(request, ticket);
    },
    complete: (_statusCode) => {
      const state = candidateERecoveryTicketStates.get(ticket);
      if (!state || state.stage === "committed" || state.stage === "released") {
        return;
      }
      state.transport = "finished";
      // HTTP status alone is never authority to burn the recovery operation.
      // Only the route's explicit post-commit call writes permanent state.
      releaseTicket(ticket, state);
    },
    abort: () => {
      const state = candidateERecoveryTicketStates.get(ticket);
      if (!state || state.stage === "committed" || state.stage === "released") {
        return;
      }
      state.transport = "aborted";
      // A socket can close while the async route is still committing its DB
      // transaction. Never release an active operation from the transport
      // callback; the route's execution-finalizer owns that transition.
      if (state.stage === "pending") releaseTicket(ticket, state);
    },
  });
  candidateERecoveryTicketStates.set(ticket, {
    stage: "pending",
    guardBinding: protectedGuard.binding,
    guard,
    consumptionKey: stateFiles.consumptionKey,
    consumedFile: stateFiles.consumedFile,
    resultFile: stateFiles.resultFile,
    operationLockFile: stateFiles.operationLockFile,
    operationLock: null,
    reconciled,
    request: null,
    transport: "open",
  });
  return ticket;
}

export function candidateESettledImageRecoveryCapabilityBound(
  request: object,
): boolean {
  const ticket = candidateERecoveryRequestTickets.get(request);
  const state = ticket ? candidateERecoveryTicketStates.get(ticket) : null;
  return Boolean(
    ticket
    && state
    && state.request === request
    && (state.stage === "pending" || state.stage === "active"),
  );
}

export function activateCandidateESettledImageRecoveryCapability(
  request: object,
): void {
  const { ticket, state } = stateForRequest(request);
  if (state.reconciled) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_ALREADY_SUCCEEDED");
  }
  if (state.stage !== "pending") {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_CAPABILITY_INVALID");
  }
  revalidateGuard(state);
  if (reconcileSuccessfulResult(state.guard)) {
    state.reconciled = true;
    return fail("CANDIDATE_E_IMAGE_RECOVERY_ALREADY_SUCCEEDED");
  }
  const active = activeCandidateERecoveryConsumptions.get(
    state.consumptionKey,
  );
  if (active && active !== ticket) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_IN_PROGRESS");
  }
  activeCandidateERecoveryConsumptions.set(state.consumptionKey, ticket);
  try {
    acquireOperationLock(state);
    state.stage = "active";
  } catch (error) {
    if (
      activeCandidateERecoveryConsumptions.get(state.consumptionKey) === ticket
    ) activeCandidateERecoveryConsumptions.delete(state.consumptionKey);
    throw error;
  }
}

export function finalizeCandidateESettledImageRecoveryExecution(
  request: object,
): void {
  const ticket = candidateERecoveryRequestTickets.get(request);
  const state = ticket ? candidateERecoveryTicketStates.get(ticket) : null;
  if (!ticket || !state || state.request !== request) return;
  if (state.stage === "active") releaseTicket(ticket, state);
}

export function commitCandidateESettledImageRecoveryCapability(
  request: object,
  input: Readonly<{
    materializedAssets: 1;
    proof: CandidateERecoveryMaterializationProof;
  }>,
): void {
  const { ticket, state } = stateForRequest(request);
  if (
    state.stage !== "active"
    || input.materializedAssets !== 1
    || typeof input.proof?.durableCommandId !== "string"
    || !input.proof.durableCommandId.trim()
    || input.proof.durableCommandId.length > 200
    || !SHA256.test(String(input.proof?.assetFingerprint || ""))
  ) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_COMMIT_INVALID");
  }
  revalidateGuard(state);
  if (reconcileSuccessfulResult(state.guard)) {
    state.stage = "committed";
    releaseTicket(ticket, state);
    return;
  }
  let completedAt = new Date().toISOString();
  let committedProof = input.proof;
  const result = {
    version: CANDIDATE_E_IMAGE_RECOVERY_RESULT_VERSION,
    purpose: CANDIDATE_E_IMAGE_RECOVERY_PURPOSE,
    consumptionKey: state.consumptionKey,
    operationBinding: state.guard.sourceEvidence.operationBinding,
    sessionBinding: state.guard.sourceEvidence.sessionBinding,
    manifestDigest: state.guard.sourceEvidence.manifestDigest,
    requestBodyDigest: state.guard.requestBodyDigest,
    idempotencyHash: state.guard.idempotencyHash,
    durableCommandId: input.proof.durableCommandId,
    assetFingerprint: input.proof.assetFingerprint,
    state: "finished",
    statusCode: 200,
    materializedAssets: 1,
    providerGenerationCalls: 0,
    paidGenerationSubmissions: 0,
    completedAt,
  };
  const resultDisposition = writeExclusiveProtected(state.resultFile, result);
  if (resultDisposition === "exists") {
    const raced = optionalProtectedJson(state.resultFile);
    if (
      !raced
      || !successfulResultMatches(
        raced.value,
        state.guard,
        state.consumptionKey,
      )
      || raced.value.durableCommandId !== input.proof.durableCommandId
      || raced.value.assetFingerprint !== input.proof.assetFingerprint
    ) return fail("CANDIDATE_E_IMAGE_RECOVERY_RESULT_INVALID");
    completedAt = String(raced.value.completedAt);
    committedProof = Object.freeze({
      durableCommandId: String(raced.value.durableCommandId),
      assetFingerprint: String(raced.value.assetFingerprint),
    });
  }
  const consumptionDisposition = writeExclusiveProtected(
    state.consumedFile,
    successfulConsumptionRecord(
      state.guard,
      state.consumptionKey,
      completedAt,
      committedProof,
    ),
  );
  if (consumptionDisposition === "exists") {
    const raced = optionalProtectedJson(state.consumedFile);
    if (
      !raced
      || !successfulConsumptionMatches(
        raced.value,
        state.guard,
        state.consumptionKey,
      )
      || raced.value.durableCommandId !== committedProof.durableCommandId
      || raced.value.assetFingerprint !== committedProof.assetFingerprint
      || raced.value.consumedAt !== completedAt
    ) return fail("CANDIDATE_E_IMAGE_RECOVERY_RESULT_INVALID");
  }
  state.stage = "committed";
  releaseTicket(ticket, state);
}

export function reconcileCandidateESettledImageRecoveryResult(
  guardFile: string,
  expectedGuard: CandidateESettledImageRecoveryGuard,
): boolean {
  if (guardFile !== expectedGuard.authorizationFile) {
    return fail("CANDIDATE_E_IMAGE_RECOVERY_AUTHORIZATION_PATH_INVALID");
  }
  const protectedGuard = parseProtectedJson(guardFile, 256 * 1024);
  const actualGuard = parseRecoveryGuard(protectedGuard.value);
  if (
    candidateERecoveryStableJson(actualGuard)
      !== candidateERecoveryStableJson(expectedGuard)
  ) return fail("CANDIDATE_E_IMAGE_RECOVERY_GUARD_CHANGED");
  revalidateSourceEvidence(actualGuard.sourceEvidence);
  return reconcileSuccessfulResult(actualGuard);
}

export function assertCandidateESettledImageRecoveryResult(
  guardFile: string,
  expectedGuard: CandidateESettledImageRecoveryGuard,
): void {
  if (!reconcileCandidateESettledImageRecoveryResult(
    guardFile,
    expectedGuard,
  )) return fail("CANDIDATE_E_IMAGE_RECOVERY_RESULT_INVALID");
}
