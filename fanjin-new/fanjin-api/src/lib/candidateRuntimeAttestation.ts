import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { NextFunction, Request, Response } from "express";
import {
  CANDIDATE_SIGNED_READ_CONTRACT_REVISION,
  CANDIDATE_SIGNED_READ_CONTRACT_REVISION_HEADER,
  resolveCandidateSignedReadContract,
  validateCandidateSignedReadResponse,
  type CandidateSignedReadProjection,
} from "./candidateSignedReadContract";
import {
  candidateExactAuthorizationSessionBinding,
  parseFormalCandidatePrelaunchSessionIdentity,
  parseCandidateExactAuthorizationSessionIdentity,
  type CandidateExactAuthorizationRuntimeSession,
} from "./candidateExactAuthorizationCanonical";
import {
  CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV,
  CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV,
  candidateExactAuthorizationTrustEnvironment,
  parseFormalCandidateExactAuthorizationTrustBundle,
  type CandidateExactAuthorizationTrustEnvironment,
  type FormalCandidateExactAuthorizationTrustBundle,
} from "./candidateExactAuthorizationTrust";
import {
  RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV,
} from "./releaseArtifactAttestation";

export const CANDIDATE_RUNTIME_ATTESTATION_VERSION =
  "fanjin-candidate-runtime-attestation/v1";
export const CANDIDATE_RUNTIME_CHALLENGE_VERSION =
  "fanjin-candidate-runtime-challenge/v1";
export const CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_VERSION =
  "fanjin-candidate-runtime-artifact-execution-binding/v1";
export const CANDIDATE_RUNTIME_ATTESTATION_FILE =
  "candidate-runtime-attestation.json";
export const CANDIDATE_RUNTIME_ATTESTATION_PATH =
  "/api/internal/candidate-runtime-attestation";
export const CANDIDATE_RUNTIME_READ_CHALLENGE_HEADER =
  "x-fanjin-candidate-read-challenge";
export const CANDIDATE_RUNTIME_READ_AUTHORITY_HEADER =
  "x-fanjin-candidate-read-authority";
export const CANDIDATE_RUNTIME_READ_BODY_SHA256_HEADER =
  "x-fanjin-candidate-read-body-sha256";
export const CANDIDATE_RUNTIME_READ_SIGNATURE_HEADER =
  "x-fanjin-candidate-read-signature";

export type FormalCandidateRuntimeSurfaceContext = Readonly<{
  session: CandidateExactAuthorizationRuntimeSession;
  exactAuthorizationTrustEnvironment:
    CandidateExactAuthorizationTrustEnvironment;
}>;

const AUTHORITY_BINDING_DOMAIN =
  "fanjin-candidate-runtime-attestation/v1/authority-binding";
const DATABASE_PATH_BINDING_DOMAIN =
  "fanjin-candidate-runtime-attestation/v1/database-path-binding";
const CHALLENGE_SIGNATURE_DOMAIN =
  "fanjin-candidate-runtime-attestation/v1/challenge-signature";
const READ_RESPONSE_SIGNATURE_DOMAIN =
  "fanjin-candidate-runtime-attestation/v1/read-response-signature";
const EXACT_AUTHORIZATION_BUSINESS_PROJECTION_DOMAIN =
  "fanjin-candidate-runtime-attestation/v1/exact-authorization-business-projection";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_FORMAL_ENTRYPOINT_BYTES = 64 * 1024 * 1024;
const MAX_CONSUMED_CHALLENGES = 512;
const BINDING_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CHECKPOINT_BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_MANIFEST_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._/@+-]+)*$/;
const FORMAL_RUNTIME_BOOTSTRAP_FD_ENV =
  "FANJIN_FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD";
const FORMAL_RUNTIME_READINESS_FD_ENV =
  "FANJIN_FORMAL_CANDIDATE_RUNTIME_READINESS_FD";
const FORMAL_RUNTIME_EPHEMERAL_ENVIRONMENT_KEYS = new Set([
  FORMAL_RUNTIME_BOOTSTRAP_FD_ENV,
  FORMAL_RUNTIME_READINESS_FD_ENV,
]);
const EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES = Object.freeze([
  "o_request_log",
  "o_worker_heartbeat",
] as const);
const EXACT_AUTHORIZATION_IGNORED_INTERNAL_ROW_TABLES = new Set([
  "sqlite_stat1",
  "sqlite_stat2",
  "sqlite_stat3",
  "sqlite_stat4",
]);

/**
 * A business projection is synchronously recomputed before every exact-candidate
 * challenge. Keep its resource envelope fixed and non-configurable so a large or
 * adversarial SQLite file cannot turn the signing authority into an unbounded
 * scanner. Operational heartbeat/request-log rows are intentionally outside the
 * row limits because their contents are outside this projection; the database
 * byte and elapsed-time limits still bound them.
 */
export const CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_PROJECTION_LIMITS =
  Object.freeze({
    maximumDatabaseBytes: 64 * 1024 * 1024,
    maximumTableCount: 256,
    maximumRowsPerProjectedTable: 100_000,
    maximumTotalProjectedRows: 250_000,
    maximumProjectionMaterialBytes: 32 * 1024 * 1024,
    maximumElapsedMilliseconds: 5_000,
  });

export type CandidateRuntimeMode =
  | "candidate"
  | "recovery"
  | "readonly-evidence";

export type CandidateRuntimePolicy = Readonly<{
  processRole: "all" | "api" | "worker";
  recoveryOnly: boolean;
  workerDisabled: boolean;
  submissionWorkersDisabled: boolean;
  relayWorkerMode: "disabled" | "recovery-get-only" | "submit-capable";
  storyboardWorkerMode:
    | "disabled"
    | "recovery-persist-only"
    | "submit-capable";
  agentWorkerDisabled: boolean;
}>;

export type CandidateRuntimeDatabaseIdentity = Readonly<{
  contentProjection: CandidateRuntimeDatabaseContentProjection;
  dev: number;
  ino: number;
  sizeAtStart: number;
  contentSha256: string;
  pathBinding: string;
}>;

/**
 * Identity of the release entrypoint that the runtime authority is actually
 * serving.  It is part of the descriptor's authorityBinding and therefore of
 * every runtime challenge signature.  Generic/source launchers intentionally
 * emit null: only a launcher that can establish executed-byte provenance may
 * install a non-null binding.
 */
export type CandidateRuntimeArtifactExecutionBinding = Readonly<{
  version: typeof CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_VERSION;
  artifactSignedManifestSha256: string;
  manifestPath: string;
  sha256: string;
  byteSize: number;
}>;

export const CANDIDATE_RUNTIME_FULL_FILE_CONTENT_PROJECTION =
  "full-file-v1" as const;
export const CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_BUSINESS_CONTENT_PROJECTION =
  "candidate-exact-authorization-business-v1" as const;

export type CandidateRuntimeDatabaseContentProjection =
  | typeof CANDIDATE_RUNTIME_FULL_FILE_CONTENT_PROJECTION
  | typeof CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_BUSINESS_CONTENT_PROJECTION;

export const CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_KEYS = Object.freeze([
  "FANJIN_AGENT_AUTO_APPROVE_ENABLED",
  "FANJIN_AGENT_BILLING_RECONCILE_ENABLED",
  "FANJIN_AGENT_GENERATION_SUBMIT_ENABLED",
  "FANJIN_AGENT_MODEL_ENABLED",
  "FANJIN_AGENT_RUNTIME_ENABLED",
  "FANJIN_AGENT_TOOLS_ENABLED",
  "FANJIN_AGENT_WORKER_ENABLED",
  "FANJIN_BIND_HOST",
  "FANJIN_DATABASE_CLIENT",
  "FANJIN_DATA_DIR",
  "FANJIN_DISABLE_AUTO_START",
  "FANJIN_DISABLE_BACKUP_SCHEDULER",
  "FANJIN_DISABLE_BILLING_RECONCILER",
  "FANJIN_DISABLE_DATA_RETENTION_WORKER",
  "FANJIN_DISABLE_DELETION_WORKER",
  "FANJIN_DISABLE_GIFT_GRANT_EXPIRY_WORKER",
  "FANJIN_DISABLE_LOCAL_ENV",
  "FANJIN_DISABLE_LOCAL_KEYCHAIN_SECRETS",
  "FANJIN_DISABLE_NOVEL_EVENT_EXTRACTION",
  "FANJIN_DISABLE_RELAY_CALLBACK_WORKER",
  "FANJIN_DISABLE_RELAY_WORKER",
  "FANJIN_DISABLE_STORYBOARD_IMAGE_GENERATION",
  "FANJIN_EXPECT_EXTERNAL_WORKER",
  "FANJIN_LOAD_LOCAL_ENV_IN_TESTS",
  "FANJIN_OBJECT_STORAGE_PROVIDER",
  "FANJIN_PROCESS_ROLE",
  "FANJIN_PYROSCOPE_SERVER_ADDRESS",
  "FANJIN_READONLY_EVIDENCE_MODE",
  "FANJIN_READINESS_REQUIRE_WORKER",
  "FANJIN_REALTIME_ENABLED",
  "FANJIN_RECOVERY_ONLY_MODE",
  "FANJIN_REDIS_BUSINESS_CACHE_ENABLED",
  "FANJIN_REDIS_ENABLED",
  "FANJIN_REDIS_RATE_LIMIT_ENABLED",
  "FANJIN_REDIS_REQUIRED",
  "FANJIN_CANDIDATE_RUNTIME_LOG_PROJECTION",
  "FANJIN_SQLITE_JOURNAL_MODE",
  "FANJIN_SQLITE_POOL_MAX",
  "FANJIN_SQLITE_READONLY",
  "FANJIN_TEST_ALLOW_LOCAL_CALLBACK_URLS",
  "FANJIN_TEST_ALLOW_PRIVATE_MEDIA_URLS",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "OTEL_SDK_DISABLED",
  "PATH",
  "TMPDIR",
  "TZ",
  "__CF_USER_TEXT_ENCODING",
] as const);

type CandidateRuntimeReadonlyEnvironmentKey =
  typeof CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_KEYS[number];

export type CandidateRuntimeReadonlyEnvironmentProfile = Readonly<{
  canonicalDataDir: string;
  variables: Readonly<Record<CandidateRuntimeReadonlyEnvironmentKey, string>>;
}>;

export type CandidateRuntimeAttestationDescriptor = Readonly<{
  version: typeof CANDIDATE_RUNTIME_ATTESTATION_VERSION;
  createdAt: string;
  apiBaseUrl: string;
  apiPid: number;
  apiProcessStartedAt: string;
  apiStartNonce: string;
  sessionBinding: string;
  checkpointBinding: string;
  artifactExecutionBinding: CandidateRuntimeArtifactExecutionBinding | null;
  databaseIdentity: CandidateRuntimeDatabaseIdentity;
  runtimeMode: CandidateRuntimeMode;
  runtimePolicy: CandidateRuntimePolicy;
  readonlyEnvironmentProfile: CandidateRuntimeReadonlyEnvironmentProfile | null;
  nodeTransportFenceInstalled: boolean;
  osOutboundNetworkDenied: boolean;
  publicKeySpkiBase64Url: string;
  authorityBinding: string;
}>;

export type CandidateRuntimeChallengeResponse = Readonly<{
  version: typeof CANDIDATE_RUNTIME_CHALLENGE_VERSION;
  challenge: string;
  authorityBinding: string;
  apiBaseUrl: string;
  apiPid: number;
  apiStartNonce: string;
  signatureBase64Url: string;
}>;

export type CandidateRuntimeReadResponseProof = Readonly<{
  version: typeof CANDIDATE_RUNTIME_CHALLENGE_VERSION;
  contractRevision: typeof CANDIDATE_SIGNED_READ_CONTRACT_REVISION;
  contractId: string;
  challenge: string;
  authorityBinding: string;
  apiPid: number;
  apiStartNonce: string;
  method: string;
  requestTargetSha256: string;
  requestQuerySha256: string;
  requestBodySha256: string;
  status: number;
  contentType: string;
  bodySha256: string;
  bodyBytes: number;
  signatureBase64Url: string;
}>;

export type CandidateRuntimeAuthorityDependencies = Readonly<{
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  generateKeyPair?: () => {
    publicKey: crypto.KeyObject;
    privateKey: crypto.KeyObject;
  };
  pid?: number;
  processUptimeSeconds?: number;
}>;

export type CandidateRuntimeAuthority = Readonly<{
  descriptor: CandidateRuntimeAttestationDescriptor;
  attestationFile: string;
  answerChallenge: (challenge: string) => CandidateRuntimeChallengeResponse;
  assertCurrentDatabaseIdentity: () => void;
  dispose: () => void;
}>;

export class CandidateRuntimeAttestationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CandidateRuntimeAttestationError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new CandidateRuntimeAttestationError(code);
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_CANONICAL_VALUE_INVALID");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => (
      `${JSON.stringify(key)}:${canonicalJson(item)}`
    )).join(",")}}`;
  }
  return fail("CANDIDATE_RUNTIME_ATTESTATION_CANONICAL_VALUE_INVALID");
}

type CandidateRuntimeProjectionStatement = Readonly<{
  all: (...parameters: unknown[]) => unknown[];
  get: (...parameters: unknown[]) => unknown;
  iterate: (...parameters: unknown[]) => IterableIterator<unknown>;
}>;

type CandidateRuntimeProjectionDatabase = Readonly<{
  close: () => void;
  defaultSafeIntegers: (enabled?: boolean) => void;
  exec: (source: string) => void;
  pragma: (
    source: string,
    options?: Readonly<{ simple?: boolean }>,
  ) => unknown;
  prepare: (source: string) => CandidateRuntimeProjectionStatement;
  serialize: () => Buffer;
}>;

type CandidateRuntimeProjectionDatabaseConstructor = new (
  filename: string | Buffer,
  options: Readonly<{ readonly: boolean; fileMustExist?: boolean }>,
) => CandidateRuntimeProjectionDatabase;

type CandidateRuntimeProjectionSource =
  | Readonly<{
    kind: "descriptor-snapshot";
    descriptor: number;
    databaseFile: string;
    afterFilesPinnedForTest?: () => void;
  }>
  | Readonly<{ kind: "test-path"; databaseFile: string }>;

type CandidateRuntimeProjectionPinnedFile = Readonly<{
  descriptor: number;
  file: string;
  stat: fs.BigIntStats;
}>;

type CandidateRuntimeExactAuthorizationProjectionLimits = Readonly<{
  maximumDatabaseBytes: number;
  maximumTableCount: number;
  maximumRowsPerProjectedTable: number;
  maximumTotalProjectedRows: number;
  maximumProjectionMaterialBytes: number;
  maximumElapsedMilliseconds: number;
}>;

type CandidateRuntimeProjectionBudget = {
  startedAt: number;
  lastObservedAt: number;
  materialBytes: number;
  limits: CandidateRuntimeExactAuthorizationProjectionLimits;
  monotonicNow: () => number;
};

function assertProjectionElapsedBudget(
  budget: CandidateRuntimeProjectionBudget,
): void {
  const observedAt = budget.monotonicNow();
  if (
    !Number.isFinite(observedAt)
    || observedAt < budget.startedAt
    || observedAt < budget.lastObservedAt
    || observedAt - budget.startedAt
      > budget.limits.maximumElapsedMilliseconds
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_TIME_LIMIT_EXCEEDED");
  }
  budget.lastObservedAt = observedAt;
}

function projectionFileStatStable(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.uid === right.uid;
}

function assertPinnedProjectionFileCurrent(
  pinned: CandidateRuntimeProjectionPinnedFile,
): void {
  const descriptorStat = fs.fstatSync(pinned.descriptor, { bigint: true });
  const pathStat = fs.lstatSync(pinned.file, { bigint: true });
  if (
    !projectionFileStatStable(pinned.stat, descriptorStat)
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
  ) {
    fail(
      "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_SOURCE_CHANGED",
    );
  }
}

function validatePinnedProjectionFile(input: {
  descriptor: number;
  file: string;
  allowEmpty: boolean;
}): CandidateRuntimeProjectionPinnedFile {
  const stat = fs.fstatSync(input.descriptor, { bigint: true });
  const pathStat = fs.lstatSync(input.file, { bigint: true });
  if (
    !stat.isFile()
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || stat.dev !== pathStat.dev
    || stat.ino !== pathStat.ino
    || stat.size < (input.allowEmpty ? 0n : 1n)
    || stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    || Number(stat.mode & 0o022n) !== 0
    || (typeof process.getuid === "function"
      && stat.uid !== BigInt(process.getuid()))
  ) {
    return fail(
      "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_DESCRIPTOR_INVALID",
    );
  }
  return Object.freeze({
    descriptor: input.descriptor,
    file: input.file,
    stat,
  });
}

function openOptionalProjectionWal(
  databaseFile: string,
): CandidateRuntimeProjectionPinnedFile | null {
  const walFile = `${databaseFile}-wal`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      walFile,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    return fail(
      "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_DESCRIPTOR_UNAVAILABLE",
    );
  }
  try {
    return validatePinnedProjectionFile({
      descriptor,
      file: walFile,
      allowEmpty: true,
    });
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the fail-closed source validation error.
    }
    if (error instanceof CandidateRuntimeAttestationError) throw error;
    return fail(
      "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_SOURCE_CHANGED",
    );
  }
}

function assertProjectionWalStillAbsent(databaseFile: string): void {
  try {
    fs.lstatSync(`${databaseFile}-wal`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    return fail(
      "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_SOURCE_CHANGED",
    );
  }
  fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_SOURCE_CHANGED");
}

function copyPinnedProjectionFile(
  pinned: CandidateRuntimeProjectionPinnedFile,
  destination: string,
): void {
  const size = Number(pinned.stat.size);
  const output = fs.openSync(
    destination,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      | noFollowFlag(),
    PRIVATE_FILE_MODE,
  );
  try {
    fs.fchmodSync(output, PRIVATE_FILE_MODE);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
    let position = 0;
    while (position < size) {
      const requested = Math.min(buffer.byteLength, size - position);
      const bytesRead = fs.readSync(
        pinned.descriptor,
        buffer,
        0,
        requested,
        position,
      );
      if (bytesRead <= 0) {
        fail(
          "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_SOURCE_CHANGED",
        );
      }
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          output,
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
      }
      position += bytesRead;
    }
    fs.fsyncSync(output);
    if (fs.fstatSync(output).size !== size) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_SOURCE_CHANGED");
    }
  } finally {
    fs.closeSync(output);
  }
}

function materializeDescriptorBoundProjectionSnapshot(input: {
  source: Extract<CandidateRuntimeProjectionSource, {
    kind: "descriptor-snapshot";
  }>;
  BetterSqlite3: CandidateRuntimeProjectionDatabaseConstructor;
  budget: CandidateRuntimeProjectionBudget;
}): Buffer {
  if (
    !Number.isSafeInteger(input.source.descriptor)
    || input.source.descriptor < 0
  ) {
    return fail(
      "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_DESCRIPTOR_INVALID",
    );
  }
  const main = validatePinnedProjectionFile({
    descriptor: input.source.descriptor,
    file: input.source.databaseFile,
    allowEmpty: false,
  });
  const wal = openOptionalProjectionWal(input.source.databaseFile);
  let temporaryDirectory: string | null = null;
  let snapshotDatabase: CandidateRuntimeProjectionDatabase | null = null;
  let snapshotTransactionOpen = false;
  try {
    const aggregateBytes = main.stat.size + (wal?.stat.size ?? 0n);
    if (
      aggregateBytes > BigInt(
        input.budget.limits.maximumDatabaseBytes,
      )
    ) {
      return fail(
        "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_FILE_LIMIT_EXCEEDED",
      );
    }
    temporaryDirectory = fs.mkdtempSync(path.join(
      os.tmpdir(),
      "fanjin-candidate-projection-",
    ));
    fs.chmodSync(temporaryDirectory, PRIVATE_DIRECTORY_MODE);
    temporaryDirectory = fs.realpathSync(temporaryDirectory);
    const snapshotFile = path.join(temporaryDirectory, "snapshot.sqlite");
    input.source.afterFilesPinnedForTest?.();
    assertProjectionElapsedBudget(input.budget);
    copyPinnedProjectionFile(main, snapshotFile);
    if (wal) {
      copyPinnedProjectionFile(wal, `${snapshotFile}-wal`);
    }
    assertPinnedProjectionFileCurrent(main);
    if (wal) {
      assertPinnedProjectionFileCurrent(wal);
    } else {
      assertProjectionWalStillAbsent(input.source.databaseFile);
    }
    assertProjectionElapsedBudget(input.budget);

    snapshotDatabase = new input.BetterSqlite3(snapshotFile, {
      readonly: true,
      fileMustExist: true,
    });
    snapshotDatabase.defaultSafeIntegers(true);
    snapshotDatabase.pragma("query_only = ON");
    snapshotDatabase.exec("BEGIN");
    snapshotTransactionOpen = true;
    snapshotDatabase.prepare(
      "SELECT COUNT(*) AS schemaObjectCount FROM sqlite_schema",
    ).get();
    assertProjectionElapsedBudget(input.budget);
    const serialized = Buffer.from(snapshotDatabase.serialize());
    if (
      serialized.byteLength < 100
      || serialized.subarray(0, 16).toString("binary")
        !== "SQLite format 3\0"
      || ![1, 2].includes(serialized[18])
      || ![1, 2].includes(serialized[19])
      || serialized.byteLength
        > input.budget.limits.maximumDatabaseBytes
    ) {
      serialized.fill(0);
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
    }
    serialized[18] = 1;
    serialized[19] = 1;
    snapshotDatabase.exec("COMMIT");
    snapshotTransactionOpen = false;
    assertPinnedProjectionFileCurrent(main);
    if (wal) {
      assertPinnedProjectionFileCurrent(wal);
    } else {
      assertProjectionWalStillAbsent(input.source.databaseFile);
    }
    assertProjectionElapsedBudget(input.budget);
    return serialized;
  } finally {
    if (snapshotTransactionOpen) {
      try {
        snapshotDatabase?.exec("ROLLBACK");
      } catch {
        // Preserve the original snapshot failure.
      }
    }
    try {
      snapshotDatabase?.close();
    } finally {
      try {
        if (wal) fs.closeSync(wal.descriptor);
      } finally {
        if (temporaryDirectory) {
          fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        }
      }
    }
  }
}

function addProjectionMaterialBytes(
  budget: CandidateRuntimeProjectionBudget,
  bytes: number,
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
  }
  const next = budget.materialBytes + bytes;
  if (
    !Number.isSafeInteger(next)
    || next > budget.limits.maximumProjectionMaterialBytes
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_MATERIAL_LIMIT_EXCEEDED");
  }
  budget.materialBytes = next;
}

/** Counts the canonical source material inspected by the projection. Blobs are
 * charged at their raw byte length even though only their digest is retained. */
function chargeProjectionMaterial(
  value: unknown,
  budget: CandidateRuntimeProjectionBudget,
): void {
  if (value === null) {
    addProjectionMaterialBytes(budget, 4);
    return;
  }
  if (typeof value === "string") {
    addProjectionMaterialBytes(budget, Buffer.byteLength(JSON.stringify(value)));
    return;
  }
  if (typeof value === "boolean") {
    addProjectionMaterialBytes(budget, value ? 4 : 5);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
    }
    addProjectionMaterialBytes(budget, Buffer.byteLength(String(value)));
    return;
  }
  if (typeof value === "bigint") {
    addProjectionMaterialBytes(budget, Buffer.byteLength(value.toString()));
    return;
  }
  if (Buffer.isBuffer(value)) {
    addProjectionMaterialBytes(budget, value.byteLength);
    return;
  }
  if (Array.isArray(value)) {
    addProjectionMaterialBytes(budget, 2 + Math.max(0, value.length - 1));
    for (const item of value) chargeProjectionMaterial(item, budget);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    addProjectionMaterialBytes(budget, 2 + Math.max(0, entries.length - 1));
    for (const [key, item] of entries) {
      addProjectionMaterialBytes(
        budget,
        Buffer.byteLength(JSON.stringify(key)) + 1,
      );
      chargeProjectionMaterial(item, budget);
    }
    return;
  }
  fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
}

function projectionRowCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
  }
  const raw = (value as Record<string, unknown>).rowCount;
  if (typeof raw === "bigint") {
    if (raw < 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) {
      return fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_TABLE_ROWS_LIMIT_EXCEEDED");
    }
    return Number(raw);
  }
  if (!Number.isSafeInteger(raw) || Number(raw) < 0) {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
  }
  return Number(raw);
}

function projectionCanonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
    }
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    return Object.freeze({ type: "real", ieee754: bytes.toString("hex") });
  }
  if (typeof value === "bigint") {
    return Object.freeze({ type: "integer", value: value.toString() });
  }
  if (Buffer.isBuffer(value)) {
    return Object.freeze({
      type: "blob",
      bytes: value.byteLength,
      sha256: sha256(value),
    });
  }
  if (Array.isArray(value)) return value.map(projectionCanonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, projectionCanonicalValue(item)]),
    );
  }
  return fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
}

function quotedSqliteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function pragmaRows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
  }
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
    }
    return row as Record<string, unknown>;
  });
}

/**
 * Hashes the exact candidate business state while allowing only the two
 * operational row sets that are expected to change during a zero-paid quote
 * capture. Their schemas remain in the projection, so a DDL change still
 * invalidates the authority. No raw row value leaves this process.
 */
function candidateExactAuthorizationBusinessContentSha256(
  source: CandidateRuntimeProjectionSource,
  options: Readonly<{
    limits?: CandidateRuntimeExactAuthorizationProjectionLimits;
    monotonicNow?: () => number;
  }> = {},
): string {
  const limits = options.limits
    ?? CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_PROJECTION_LIMITS;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt)) {
    return fail(
      "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_TIME_LIMIT_EXCEEDED",
    );
  }
  const budget: CandidateRuntimeProjectionBudget = {
    startedAt,
    lastObservedAt: startedAt,
    materialBytes: 0,
    limits,
    monotonicNow,
  };
  const BetterSqlite3 = require(
    "better-sqlite3"
  ) as CandidateRuntimeProjectionDatabaseConstructor;
  let database: CandidateRuntimeProjectionDatabase | null = null;
  let transactionOpen = false;
  let serializedSnapshot: Buffer | null = null;
  try {
    let databaseInput: string | Buffer;
    let fileMustExist = false;
    if (source.kind === "descriptor-snapshot") {
      serializedSnapshot = materializeDescriptorBoundProjectionSnapshot({
        source,
        BetterSqlite3,
        budget,
      });
      databaseInput = serializedSnapshot;
    } else {
      const mainStat = fs.lstatSync(source.databaseFile);
      let aggregateBytes = mainStat.size;
      try {
        const walStat = fs.lstatSync(`${source.databaseFile}-wal`);
        if (walStat.isSymbolicLink() || !walStat.isFile()) {
          fail(
            "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_DESCRIPTOR_INVALID",
          );
        }
        aggregateBytes += walStat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          throw error;
        }
      }
      if (
        mainStat.isSymbolicLink()
        || !mainStat.isFile()
        || !Number.isSafeInteger(aggregateBytes)
        || aggregateBytes < 1
        || aggregateBytes > limits.maximumDatabaseBytes
      ) {
        fail(
          "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_FILE_LIMIT_EXCEEDED",
        );
      }
      databaseInput = source.databaseFile;
      fileMustExist = true;
    }
    assertProjectionElapsedBudget(budget);

    database = new BetterSqlite3(databaseInput, {
      readonly: true,
      ...(fileMustExist ? { fileMustExist: true } : {}),
    });
    database.defaultSafeIntegers(true);
    database.pragma("query_only = ON");
    database.exec("BEGIN");
    transactionOpen = true;
    assertProjectionElapsedBudget(budget);

    assertProjectionElapsedBudget(budget);
    const schemaRows = database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema "
        + "ORDER BY type, name",
    ).all() as Record<string, unknown>[];
    assertProjectionElapsedBudget(budget);
    const tableNames = schemaRows
      .filter((row) => String(row.type || "") === "table")
      .map((row) => String(row.name || ""))
      .filter((name) => (
        name
        && !EXACT_AUTHORIZATION_IGNORED_INTERNAL_ROW_TABLES.has(name)
      ))
      .sort((left, right) => left.localeCompare(right, "en"));
    if (tableNames.length > limits.maximumTableCount) {
      fail(
        "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_TABLE_LIMIT_EXCEEDED",
      );
    }
    if (
      tableNames.length <= EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES.length
      || EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES.some(
        (name) => !tableNames.includes(name),
      )
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_SCHEMA_INVALID");
    }
    chargeProjectionMaterial(schemaRows, budget);
    assertProjectionElapsedBudget(budget);

    const projectedRowCounts = new Map<string, number>();
    let totalProjectedRows = 0;
    for (const tableName of tableNames) {
      if (
        EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES.includes(
          tableName as typeof EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES[number],
        )
      ) continue;
      assertProjectionElapsedBudget(budget);
      const rowCount = projectionRowCount(database.prepare(
        `SELECT COUNT(*) AS rowCount FROM ${quotedSqliteIdentifier(tableName)}`,
      ).get());
      assertProjectionElapsedBudget(budget);
      if (rowCount > limits.maximumRowsPerProjectedTable) {
        fail(
          "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_TABLE_ROWS_LIMIT_EXCEEDED",
        );
      }
      totalProjectedRows += rowCount;
      if (
        !Number.isSafeInteger(totalProjectedRows)
        || totalProjectedRows > limits.maximumTotalProjectedRows
      ) {
        fail(
          "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_TOTAL_ROWS_LIMIT_EXCEEDED",
        );
      }
      projectedRowCounts.set(tableName, rowCount);
    }

    assertProjectionElapsedBudget(budget);
    const quickCheck = pragmaRows(database.pragma("quick_check"));
    assertProjectionElapsedBudget(budget);
    let foreignKeyViolation = false;
    for (const _row of database.prepare("PRAGMA foreign_key_check").iterate()) {
      foreignKeyViolation = true;
      break;
    }
    assertProjectionElapsedBudget(budget);
    if (
      quickCheck.length !== 1
      || String(Object.values(quickCheck[0])[0] || "") !== "ok"
      || foreignKeyViolation
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INTEGRITY_INVALID");
    }

    const tableShapes: Record<string, unknown> = {};
    const businessRows: Record<string, unknown> = {};
    for (const tableName of tableNames) {
      assertProjectionElapsedBudget(budget);
      const tableShape = {
        tableXinfo: database.prepare(
          `PRAGMA table_xinfo(${quotedSqliteIdentifier(tableName)})`,
        ).all(),
        foreignKeyList: database.prepare(
          `PRAGMA foreign_key_list(${quotedSqliteIdentifier(tableName)})`,
        ).all(),
      };
      assertProjectionElapsedBudget(budget);
      chargeProjectionMaterial(tableShape, budget);
      tableShapes[tableName] = tableShape;
      if (
        EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES.includes(
          tableName as typeof EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES[number],
        )
      ) continue;
      const rowDigests: string[] = [];
      const rows = database.prepare(
        `SELECT * FROM ${quotedSqliteIdentifier(tableName)}`,
      ).iterate();
      for (const row of rows) {
        assertProjectionElapsedBudget(budget);
        chargeProjectionMaterial(row, budget);
        rowDigests.push(sha256(canonicalJson(projectionCanonicalValue(row))));
        assertProjectionElapsedBudget(budget);
      }
      if (rowDigests.length !== projectedRowCounts.get(tableName)) {
        fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
      }
      assertProjectionElapsedBudget(budget);
      rowDigests.sort((left, right) => left.localeCompare(right, "en"));
      assertProjectionElapsedBudget(budget);
      businessRows[tableName] = Object.freeze({
        rowCount: rowDigests.length,
        rowDigest: sha256(rowDigests.join("\n")),
      });
    }

    const indexShapes: Record<string, unknown> = {};
    for (const row of schemaRows.filter((item) => (
      String(item.type || "") === "index"
        && String(item.name || "")
    ))) {
      assertProjectionElapsedBudget(budget);
      const name = String(row.name);
      const indexShape = database.prepare(
        `PRAGMA index_xinfo(${quotedSqliteIdentifier(name)})`,
      ).all();
      assertProjectionElapsedBudget(budget);
      chargeProjectionMaterial(indexShape, budget);
      indexShapes[name] = indexShape;
    }
    const pragmas = {
      applicationId: database.pragma("application_id", { simple: true }),
      encoding: database.pragma("encoding", { simple: true }),
      schemaVersion: database.pragma("schema_version", { simple: true }),
      userVersion: database.pragma("user_version", { simple: true }),
    };
    assertProjectionElapsedBudget(budget);
    chargeProjectionMaterial(pragmas, budget);
    assertProjectionElapsedBudget(budget);
    const projection = projectionCanonicalValue({
      version:
        CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_BUSINESS_CONTENT_PROJECTION,
      operationalRowTables: [...EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES],
      schemaRows,
      tableShapes,
      indexShapes,
      pragmas,
      businessRows,
    });
    assertProjectionElapsedBudget(budget);
    const canonicalProjection = canonicalJson(projection);
    assertProjectionElapsedBudget(budget);
    if (
      Buffer.byteLength(canonicalProjection)
        > limits.maximumProjectionMaterialBytes
    ) {
      fail(
        "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_MATERIAL_LIMIT_EXCEEDED",
      );
    }
    assertProjectionElapsedBudget(budget);
    const result = `sha256:${sha256([
      EXACT_AUTHORIZATION_BUSINESS_PROJECTION_DOMAIN,
      canonicalProjection,
    ].join("\0"))}`;
    assertProjectionElapsedBudget(budget);
    database.exec("COMMIT");
    transactionOpen = false;
    assertProjectionElapsedBudget(budget);
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        database?.exec("ROLLBACK");
      } catch {
        // Preserve the original fail-closed projection error.
      }
    }
    if (error instanceof CandidateRuntimeAttestationError) throw error;
    return fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_UNAVAILABLE");
  } finally {
    try {
      database?.close();
    } catch {
      // The projection has already completed or failed closed.
    } finally {
      serializedSnapshot?.fill(0);
    }
  }
}

/** Test-only entrypoint for exercising each fail-closed budget without creating
 * production-sized fixtures. Production authority installation never accepts
 * limit or clock overrides. */
export function candidateExactAuthorizationBusinessContentSha256ForTest(input: {
  databaseFile: string;
  databaseDescriptor?: number;
  afterFilesPinnedForTest?: () => void;
  limits?: Partial<CandidateRuntimeExactAuthorizationProjectionLimits>;
  monotonicNow?: () => number;
}): string {
  if (process.env.NODE_ENV !== "test") {
    return fail(
      "CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_TEST_ONLY",
    );
  }
  const limits = Object.freeze({
    ...CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_PROJECTION_LIMITS,
    ...(input.limits ?? {}),
  });
  if (
    typeof input.databaseFile !== "string"
    || !input.databaseFile
    || (input.databaseDescriptor !== undefined
      && (!Number.isSafeInteger(input.databaseDescriptor)
        || input.databaseDescriptor < 0))
    ||
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
  }
  return candidateExactAuthorizationBusinessContentSha256(
    input.databaseDescriptor === undefined
      ? { kind: "test-path", databaseFile: input.databaseFile }
      : {
        kind: "descriptor-snapshot",
        descriptor: input.databaseDescriptor,
        databaseFile: input.databaseFile,
        afterFilesPinnedForTest: input.afterFilesPinnedForTest,
      },
    { limits, monotonicNow: input.monotonicNow },
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n")
    === [...keys].sort().join("\n");
}

function parseExactIsoTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_TIME_INVALID");
  }
  return value;
}

function parseProcessRole(environment: NodeJS.ProcessEnv): CandidateRuntimePolicy["processRole"] {
  const raw = String(
    environment.FANJIN_PROCESS_ROLE
      || environment.FANJIN_SERVICE_ROLE
      || "all",
  ).trim().toLowerCase();
  if (raw === "all") return "all";
  if (["api", "server", "web"].includes(raw)) return "api";
  if (["worker", "relay-worker", "relay_worker"].includes(raw)) {
    return "worker";
  }
  return fail("CANDIDATE_RUNTIME_ATTESTATION_PROCESS_ROLE_INVALID");
}

function enabled(environment: NodeJS.ProcessEnv, name: string): boolean {
  return String(environment[name] || "").trim() === "1";
}

function disabled(environment: NodeJS.ProcessEnv, name: string): boolean {
  return String(environment[name] || "").trim() === "1";
}

export function inspectCandidateRuntimePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): CandidateRuntimePolicy {
  const processRole = parseProcessRole(environment);
  const recoveryOnly = enabled(environment, "FANJIN_RECOVERY_ONLY_MODE");
  const workerDisabled = processRole === "api";
  const relayDisabled = workerDisabled
    || disabled(environment, "FANJIN_DISABLE_RELAY_WORKER");
  const storyboardDisabled = workerDisabled
    || disabled(environment, "FANJIN_DISABLE_STORYBOARD_IMAGE_GENERATION");
  const agentWorkerDisabled = workerDisabled
    || !enabled(environment, "FANJIN_AGENT_WORKER_ENABLED");
  const agentSubmissionDisabled = !enabled(
    environment,
    "FANJIN_AGENT_GENERATION_SUBMIT_ENABLED",
  );
  const relayCallbackDisabled = disabled(
    environment,
    "FANJIN_DISABLE_RELAY_CALLBACK_WORKER",
  );
  const billingReconcilerDisabled = disabled(
    environment,
    "FANJIN_DISABLE_BILLING_RECONCILER",
  );
  const submissionWorkersDisabled = recoveryOnly
    && agentWorkerDisabled
    && agentSubmissionDisabled
    && relayCallbackDisabled
    && billingReconcilerDisabled;
  return Object.freeze({
    processRole,
    recoveryOnly,
    workerDisabled,
    submissionWorkersDisabled,
    relayWorkerMode: relayDisabled
      ? "disabled"
      : recoveryOnly
        ? "recovery-get-only"
        : "submit-capable",
    storyboardWorkerMode: storyboardDisabled
      ? "disabled"
      : recoveryOnly
        ? "recovery-persist-only"
        : "submit-capable",
    agentWorkerDisabled,
  });
}

function assertRuntimeModePolicy(
  runtimeMode: CandidateRuntimeMode,
  policy: CandidateRuntimePolicy,
): void {
  if (runtimeMode === "candidate" && policy.recoveryOnly) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_MODE_POLICY_MISMATCH");
  }
  if (
    runtimeMode === "recovery"
    && (!policy.recoveryOnly || !policy.submissionWorkersDisabled)
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_MODE_POLICY_MISMATCH");
  }
  if (
    runtimeMode === "readonly-evidence"
    && (
      !policy.recoveryOnly
      || !policy.workerDisabled
      || !policy.submissionWorkersDisabled
      || policy.relayWorkerMode !== "disabled"
      || policy.storyboardWorkerMode !== "disabled"
      || !policy.agentWorkerDisabled
    )
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_POLICY_REQUIRED");
  }
}

function assertOwnedPrivateDirectory(
  directory: string,
  allowedModes: readonly number[] = [PRIVATE_DIRECTORY_MODE],
): string {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DIRECTORY_PATH_INVALID");
  }
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(directory);
  } catch {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_DIRECTORY_UNAVAILABLE");
  }
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DIRECTORY_INVALID");
  }
  if (!allowedModes.includes(lstat.mode & 0o777)) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DIRECTORY_MODE_INVALID");
  }
  if (typeof process.getuid === "function" && lstat.uid !== process.getuid()) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DIRECTORY_OWNER_MISMATCH");
  }
  const canonical = fs.realpathSync(directory);
  if (canonical !== directory) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DIRECTORY_PATH_INVALID");
  }
  return canonical;
}

export const CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_EXACT_VALUES = Object.freeze({
  FANJIN_AGENT_AUTO_APPROVE_ENABLED: "0",
  FANJIN_AGENT_BILLING_RECONCILE_ENABLED: "0",
  FANJIN_AGENT_GENERATION_SUBMIT_ENABLED: "0",
  FANJIN_AGENT_MODEL_ENABLED: "0",
  FANJIN_AGENT_RUNTIME_ENABLED: "0",
  FANJIN_AGENT_TOOLS_ENABLED: "0",
  FANJIN_AGENT_WORKER_ENABLED: "0",
  FANJIN_BIND_HOST: "127.0.0.1",
  FANJIN_DATABASE_CLIENT: "sqlite",
  FANJIN_DISABLE_AUTO_START: "1",
  FANJIN_DISABLE_BACKUP_SCHEDULER: "1",
  FANJIN_DISABLE_BILLING_RECONCILER: "1",
  FANJIN_DISABLE_DATA_RETENTION_WORKER: "1",
  FANJIN_DISABLE_DELETION_WORKER: "1",
  FANJIN_DISABLE_GIFT_GRANT_EXPIRY_WORKER: "1",
  FANJIN_DISABLE_LOCAL_ENV: "1",
  FANJIN_DISABLE_LOCAL_KEYCHAIN_SECRETS: "1",
  FANJIN_DISABLE_NOVEL_EVENT_EXTRACTION: "1",
  FANJIN_DISABLE_RELAY_CALLBACK_WORKER: "1",
  FANJIN_DISABLE_RELAY_WORKER: "1",
  FANJIN_DISABLE_STORYBOARD_IMAGE_GENERATION: "1",
  FANJIN_EXPECT_EXTERNAL_WORKER: "0",
  FANJIN_LOAD_LOCAL_ENV_IN_TESTS: "0",
  FANJIN_OBJECT_STORAGE_PROVIDER: "local",
  FANJIN_PROCESS_ROLE: "api",
  FANJIN_PYROSCOPE_SERVER_ADDRESS: "",
  FANJIN_READONLY_EVIDENCE_MODE: "1",
  FANJIN_READINESS_REQUIRE_WORKER: "0",
  FANJIN_REALTIME_ENABLED: "0",
  FANJIN_RECOVERY_ONLY_MODE: "1",
  FANJIN_REDIS_BUSINESS_CACHE_ENABLED: "0",
  FANJIN_REDIS_ENABLED: "0",
  FANJIN_REDIS_RATE_LIMIT_ENABLED: "0",
  FANJIN_REDIS_REQUIRED: "0",
  FANJIN_CANDIDATE_RUNTIME_LOG_PROJECTION: "redacted-v1",
  FANJIN_SQLITE_JOURNAL_MODE: "DELETE",
  FANJIN_SQLITE_POOL_MAX: "1",
  FANJIN_SQLITE_READONLY: "1",
  FANJIN_TEST_ALLOW_LOCAL_CALLBACK_URLS: "0",
  FANJIN_TEST_ALLOW_PRIVATE_MEDIA_URLS: "0",
  LANG: "C",
  LC_ALL: "C",
  NODE_ENV: "prod",
  OTEL_SDK_DISABLED: "true",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TZ: "UTC",
} as const);

const MACOS_CF_USER_TEXT_ENCODING = String(
  process.env.__CF_USER_TEXT_ENCODING || "",
);

export function buildCandidateRuntimeReadonlyProcessEnvironment(
  dataDir: string,
): NodeJS.ProcessEnv {
  const canonicalDataDir = assertOwnedPrivateDirectory(
    dataDir,
    [PRIVATE_DIRECTORY_MODE, 0o500],
  );
  const temporaryDirectory = fs.realpathSync(os.tmpdir());
  return {
    ...CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_EXACT_VALUES,
    FANJIN_DATA_DIR: canonicalDataDir,
    TMPDIR: temporaryDirectory,
    __CF_USER_TEXT_ENCODING: MACOS_CF_USER_TEXT_ENCODING,
  };
}

export function inspectCandidateRuntimeReadonlyEnvironmentProfile(
  environment: NodeJS.ProcessEnv = process.env,
  expectedDataDir?: string,
): CandidateRuntimeReadonlyEnvironmentProfile {
  if (!exactKeys(
    environment as Record<string, unknown>,
    CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_KEYS,
  )) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  }
  const rawDataDir = String(environment.FANJIN_DATA_DIR || "");
  let canonicalDataDir = "";
  try {
    if (!path.isAbsolute(rawDataDir) || path.normalize(rawDataDir) !== rawDataDir) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
    }
    canonicalDataDir = fs.realpathSync(rawDataDir);
    if (
      canonicalDataDir !== rawDataDir
      || (
        expectedDataDir !== undefined
        && fs.realpathSync(expectedDataDir) !== canonicalDataDir
      )
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
    }
  } catch (error) {
    if (error instanceof CandidateRuntimeAttestationError) throw error;
    return fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  }
  for (const [key, expected] of Object.entries(
    CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_EXACT_VALUES,
  )) {
    if (environment[key] !== expected) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
    }
  }
  const temporaryDirectory = String(environment.TMPDIR || "");
  try {
    if (
      !path.isAbsolute(temporaryDirectory)
      || path.normalize(temporaryDirectory) !== temporaryDirectory
      || fs.realpathSync(temporaryDirectory) !== temporaryDirectory
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
    }
  } catch (error) {
    if (error instanceof CandidateRuntimeAttestationError) throw error;
    return fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  }
  if (
    process.platform === "darwin"
    && !/^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/.test(
      String(environment.__CF_USER_TEXT_ENCODING || ""),
    )
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  }
  const variables = Object.freeze(Object.fromEntries(
    CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_KEYS.map((key) => [
      key,
      key === "FANJIN_DATA_DIR" ? canonicalDataDir : String(environment[key] || ""),
    ]),
  )) as Readonly<Record<CandidateRuntimeReadonlyEnvironmentKey, string>>;
  return Object.freeze({ canonicalDataDir, variables });
}

function parseCandidateRuntimeReadonlyEnvironmentProfile(
  value: unknown,
): CandidateRuntimeReadonlyEnvironmentProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  }
  const profile = value as Record<string, unknown>;
  const variables = profile.variables;
  if (
    !exactKeys(profile, ["canonicalDataDir", "variables"])
    || typeof profile.canonicalDataDir !== "string"
    || !path.isAbsolute(profile.canonicalDataDir)
    || path.normalize(profile.canonicalDataDir) !== profile.canonicalDataDir
    || !variables
    || typeof variables !== "object"
    || Array.isArray(variables)
    || !exactKeys(
      variables as Record<string, unknown>,
      CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_KEYS,
    )
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  }
  const rawVariables = variables as Record<string, unknown>;
  for (const [key, expected] of Object.entries(
    CANDIDATE_RUNTIME_READONLY_ENVIRONMENT_EXACT_VALUES,
  )) {
    if (rawVariables[key] !== expected) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
    }
  }
  if (rawVariables.FANJIN_DATA_DIR !== profile.canonicalDataDir) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  }
  if (
    typeof rawVariables.TMPDIR !== "string"
    || !path.isAbsolute(rawVariables.TMPDIR)
    || path.normalize(rawVariables.TMPDIR) !== rawVariables.TMPDIR
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  }
  return Object.freeze({
    canonicalDataDir: profile.canonicalDataDir,
    variables: Object.freeze({ ...rawVariables }) as Readonly<
      Record<CandidateRuntimeReadonlyEnvironmentKey, string>
    >,
  });
}

function openOwnedPrivateDatabase(
  databaseFile: string,
  checkpointDirectory: string,
  allowedModes: readonly number[] = [PRIVATE_FILE_MODE],
): { descriptor: number; stat: fs.Stats; canonical: string } {
  if (
    !path.isAbsolute(databaseFile)
    || path.normalize(databaseFile) !== databaseFile
    || path.dirname(databaseFile) !== checkpointDirectory
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PATH_INVALID");
  }
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      databaseFile,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const stat = fs.fstatSync(descriptor);
    const lstat = fs.lstatSync(databaseFile);
    if (
      !stat.isFile()
      || lstat.isSymbolicLink()
      || !lstat.isFile()
      || stat.dev !== lstat.dev
      || stat.ino !== lstat.ino
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_IDENTITY_INVALID");
    }
    if (!allowedModes.includes(stat.mode & 0o777)) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_MODE_INVALID");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_OWNER_MISMATCH");
    }
    if (
      !Number.isSafeInteger(stat.dev)
      || stat.dev < 0
      || !Number.isSafeInteger(stat.ino)
      || stat.ino <= 0
      || !Number.isSafeInteger(stat.size)
      || stat.size < 1
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_STAT_INVALID");
    }
    const canonical = fs.realpathSync(databaseFile);
    if (canonical !== databaseFile) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PATH_INVALID");
    }
    return { descriptor, stat, canonical };
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (error instanceof CandidateRuntimeAttestationError) throw error;
    return fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_UNAVAILABLE");
  }
}

function closeDescriptor(descriptor: number): void {
  try {
    fs.closeSync(descriptor);
  } catch {
    // The security-sensitive operation already finished.
  }
}

function parseApiBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_API_URL_INVALID");
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/api"
    || parsed.search
    || parsed.hash
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_API_URL_INVALID");
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_API_URL_INVALID");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function candidateRuntimeDatabasePathBinding(input: {
  canonicalDatabaseFile: string;
  dev: number;
  ino: number;
  sessionBinding: string;
  checkpointBinding: string;
  apiStartNonce: string;
}): string {
  if (
    !path.isAbsolute(input.canonicalDatabaseFile)
    || path.normalize(input.canonicalDatabaseFile) !== input.canonicalDatabaseFile
    || !Number.isSafeInteger(input.dev)
    || input.dev < 0
    || !Number.isSafeInteger(input.ino)
    || input.ino <= 0
    || !BINDING_PATTERN.test(input.sessionBinding)
    || !CHECKPOINT_BINDING_PATTERN.test(input.checkpointBinding)
    || !NONCE_PATTERN.test(input.apiStartNonce)
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PATH_BINDING_INPUT_INVALID");
  }
  return `sha256:${sha256([
    DATABASE_PATH_BINDING_DOMAIN,
    input.canonicalDatabaseFile,
    String(input.dev),
    String(input.ino),
    input.sessionBinding,
    input.checkpointBinding,
    input.apiStartNonce,
  ].join("\0"))}`;
}

const POLICY_KEYS = Object.freeze([
  "agentWorkerDisabled",
  "processRole",
  "recoveryOnly",
  "relayWorkerMode",
  "storyboardWorkerMode",
  "submissionWorkersDisabled",
  "workerDisabled",
] as const);
const DATABASE_IDENTITY_KEYS = Object.freeze([
  "contentProjection",
  "contentSha256",
  "dev",
  "ino",
  "pathBinding",
  "sizeAtStart",
] as const);
const DESCRIPTOR_KEYS = Object.freeze([
  "apiBaseUrl",
  "apiPid",
  "apiProcessStartedAt",
  "apiStartNonce",
  "artifactExecutionBinding",
  "authorityBinding",
  "checkpointBinding",
  "createdAt",
  "databaseIdentity",
  "nodeTransportFenceInstalled",
  "osOutboundNetworkDenied",
  "publicKeySpkiBase64Url",
  "readonlyEnvironmentProfile",
  "runtimeMode",
  "runtimePolicy",
  "sessionBinding",
  "version",
] as const);
const CHALLENGE_RESPONSE_KEYS = Object.freeze([
  "apiBaseUrl",
  "apiPid",
  "apiStartNonce",
  "authorityBinding",
  "challenge",
  "signatureBase64Url",
  "version",
] as const);
const READ_RESPONSE_PROOF_KEYS = Object.freeze([
  "apiPid",
  "apiStartNonce",
  "authorityBinding",
  "bodyBytes",
  "bodySha256",
  "challenge",
  "contractId",
  "contractRevision",
  "contentType",
  "method",
  "requestBodySha256",
  "requestQuerySha256",
  "requestTargetSha256",
  "signatureBase64Url",
  "status",
  "version",
] as const);

function authorityFields(
  value: Omit<CandidateRuntimeAttestationDescriptor, "authorityBinding">,
): Omit<CandidateRuntimeAttestationDescriptor, "authorityBinding"> {
  return {
    version: value.version,
    createdAt: value.createdAt,
    apiBaseUrl: value.apiBaseUrl,
    apiPid: value.apiPid,
    apiProcessStartedAt: value.apiProcessStartedAt,
    apiStartNonce: value.apiStartNonce,
    sessionBinding: value.sessionBinding,
    checkpointBinding: value.checkpointBinding,
    artifactExecutionBinding: value.artifactExecutionBinding,
    databaseIdentity: value.databaseIdentity,
    runtimeMode: value.runtimeMode,
    runtimePolicy: value.runtimePolicy,
    readonlyEnvironmentProfile: value.readonlyEnvironmentProfile,
    nodeTransportFenceInstalled: value.nodeTransportFenceInstalled,
    osOutboundNetworkDenied: value.osOutboundNetworkDenied,
    publicKeySpkiBase64Url: value.publicKeySpkiBase64Url,
  };
}

function parseRuntimeArtifactExecutionBinding(
  value: unknown,
): CandidateRuntimeArtifactExecutionBinding | null {
  if (value === null) return null;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, [
      "artifactSignedManifestSha256",
      "byteSize",
      "manifestPath",
      "sha256",
      "version",
    ])
  ) {
    fail("CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_INVALID");
  }
  const binding = value as Record<string, unknown>;
  if (
    binding.version !== CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_VERSION
    || !SHA256_HEX_PATTERN.test(String(
      binding.artifactSignedManifestSha256 || "",
    ))
    || !SAFE_MANIFEST_PATH_PATTERN.test(String(binding.manifestPath || ""))
    || !SHA256_HEX_PATTERN.test(String(binding.sha256 || ""))
    || !Number.isSafeInteger(binding.byteSize)
    || Number(binding.byteSize) < 1
  ) {
    fail("CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_INVALID");
  }
  return Object.freeze({
    version: CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_VERSION,
    artifactSignedManifestSha256: String(
      binding.artifactSignedManifestSha256,
    ),
    manifestPath: String(binding.manifestPath),
    sha256: String(binding.sha256),
    byteSize: Number(binding.byteSize),
  });
}

function authorityBinding(
  value: Omit<CandidateRuntimeAttestationDescriptor, "authorityBinding">,
): string {
  return `sha256:${sha256([
    AUTHORITY_BINDING_DOMAIN,
    canonicalJson(authorityFields(value)),
  ].join("\0"))}`;
}

function parseRuntimePolicy(value: unknown): CandidateRuntimePolicy {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, POLICY_KEYS)
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_POLICY_INVALID");
  }
  const policy = value as Record<string, unknown>;
  if (
    !["all", "api", "worker"].includes(String(policy.processRole))
    || typeof policy.recoveryOnly !== "boolean"
    || typeof policy.workerDisabled !== "boolean"
    || typeof policy.submissionWorkersDisabled !== "boolean"
    || !["disabled", "recovery-get-only", "submit-capable"].includes(
      String(policy.relayWorkerMode),
    )
    || ![
      "disabled",
      "recovery-persist-only",
      "submit-capable",
    ].includes(String(policy.storyboardWorkerMode))
    || typeof policy.agentWorkerDisabled !== "boolean"
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_POLICY_INVALID");
  }
  return Object.freeze({
    processRole: policy.processRole as CandidateRuntimePolicy["processRole"],
    recoveryOnly: policy.recoveryOnly,
    workerDisabled: policy.workerDisabled,
    submissionWorkersDisabled: policy.submissionWorkersDisabled,
    relayWorkerMode:
      policy.relayWorkerMode as CandidateRuntimePolicy["relayWorkerMode"],
    storyboardWorkerMode:
      policy.storyboardWorkerMode as CandidateRuntimePolicy["storyboardWorkerMode"],
    agentWorkerDisabled: policy.agentWorkerDisabled,
  });
}

export function assertCandidateRuntimeAttestationDescriptor(
  value: unknown,
): CandidateRuntimeAttestationDescriptor {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, DESCRIPTOR_KEYS)
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DESCRIPTOR_INVALID");
  }
  const descriptor = value as Record<string, unknown>;
  const database = descriptor.databaseIdentity;
  if (
    descriptor.version !== CANDIDATE_RUNTIME_ATTESTATION_VERSION
    || !BINDING_PATTERN.test(String(descriptor.sessionBinding || ""))
    || !CHECKPOINT_BINDING_PATTERN.test(
      String(descriptor.checkpointBinding || ""),
    )
    || !NONCE_PATTERN.test(String(descriptor.apiStartNonce || ""))
    || !Number.isSafeInteger(descriptor.apiPid)
    || Number(descriptor.apiPid) <= 0
    || !["candidate", "recovery", "readonly-evidence"].includes(
      String(descriptor.runtimeMode || ""),
    )
    || typeof descriptor.publicKeySpkiBase64Url !== "string"
    || !BASE64URL_PATTERN.test(descriptor.publicKeySpkiBase64Url)
    || descriptor.publicKeySpkiBase64Url.length < 40
    || descriptor.publicKeySpkiBase64Url.length > 256
    || !BINDING_PATTERN.test(String(descriptor.authorityBinding || ""))
    || typeof descriptor.nodeTransportFenceInstalled !== "boolean"
    || typeof descriptor.osOutboundNetworkDenied !== "boolean"
    || !database
    || typeof database !== "object"
    || Array.isArray(database)
    || !exactKeys(database as Record<string, unknown>, DATABASE_IDENTITY_KEYS)
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DESCRIPTOR_INVALID");
  }
  const databaseIdentity = database as Record<string, unknown>;
  const contentProjection = String(databaseIdentity.contentProjection || "");
  if (
    !(
      contentProjection === CANDIDATE_RUNTIME_FULL_FILE_CONTENT_PROJECTION
      || contentProjection
        === CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_BUSINESS_CONTENT_PROJECTION
    )
    || !Number.isSafeInteger(databaseIdentity.dev)
    || Number(databaseIdentity.dev) < 0
    || !Number.isSafeInteger(databaseIdentity.ino)
    || Number(databaseIdentity.ino) <= 0
    || !Number.isSafeInteger(databaseIdentity.sizeAtStart)
    || Number(databaseIdentity.sizeAtStart) < 1
    || !BINDING_PATTERN.test(String(databaseIdentity.contentSha256 || ""))
    || !BINDING_PATTERN.test(String(databaseIdentity.pathBinding || ""))
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_IDENTITY_INVALID");
  }
  const runtimePolicy = parseRuntimePolicy(descriptor.runtimePolicy);
  const artifactExecutionBinding = parseRuntimeArtifactExecutionBinding(
    descriptor.artifactExecutionBinding,
  );
  const runtimeMode = descriptor.runtimeMode as CandidateRuntimeMode;
  if (
    contentProjection
      === CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_BUSINESS_CONTENT_PROJECTION
    && runtimeMode !== "candidate"
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_PROJECTION_INVALID");
  }
  assertRuntimeModePolicy(runtimeMode, runtimePolicy);
  const readonlyEnvironmentProfile = runtimeMode === "readonly-evidence"
    ? parseCandidateRuntimeReadonlyEnvironmentProfile(
      descriptor.readonlyEnvironmentProfile,
    )
    : descriptor.readonlyEnvironmentProfile === null
      ? null
      : fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_INVALID");
  if (
    (descriptor.nodeTransportFenceInstalled || descriptor.osOutboundNetworkDenied)
    && runtimeMode !== "readonly-evidence"
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_EGRESS_POLICY_INVALID");
  }
  const parsed: Omit<CandidateRuntimeAttestationDescriptor, "authorityBinding"> = {
    version: CANDIDATE_RUNTIME_ATTESTATION_VERSION,
    createdAt: parseExactIsoTimestamp(descriptor.createdAt),
    apiBaseUrl: parseApiBaseUrl(String(descriptor.apiBaseUrl || "")),
    apiPid: Number(descriptor.apiPid),
    apiProcessStartedAt: parseExactIsoTimestamp(
      descriptor.apiProcessStartedAt,
    ),
    apiStartNonce: String(descriptor.apiStartNonce),
    sessionBinding: String(descriptor.sessionBinding),
    checkpointBinding: String(descriptor.checkpointBinding),
    artifactExecutionBinding,
    databaseIdentity: Object.freeze({
      contentProjection:
        contentProjection as CandidateRuntimeDatabaseContentProjection,
      dev: Number(databaseIdentity.dev),
      ino: Number(databaseIdentity.ino),
      sizeAtStart: Number(databaseIdentity.sizeAtStart),
      contentSha256: String(databaseIdentity.contentSha256),
      pathBinding: String(databaseIdentity.pathBinding),
    }),
    runtimeMode,
    runtimePolicy,
    readonlyEnvironmentProfile,
    nodeTransportFenceInstalled: descriptor.nodeTransportFenceInstalled,
    osOutboundNetworkDenied: descriptor.osOutboundNetworkDenied,
    publicKeySpkiBase64Url: descriptor.publicKeySpkiBase64Url,
  };
  const expectedBinding = authorityBinding(parsed);
  if (descriptor.authorityBinding !== expectedBinding) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_AUTHORITY_BINDING_INVALID");
  }
  return Object.freeze({
    ...parsed,
    authorityBinding: expectedBinding,
  });
}

function challengeFields(
  descriptor: CandidateRuntimeAttestationDescriptor,
  challenge: string,
): Omit<CandidateRuntimeChallengeResponse, "signatureBase64Url"> {
  return {
    version: CANDIDATE_RUNTIME_CHALLENGE_VERSION,
    challenge,
    authorityBinding: descriptor.authorityBinding,
    apiBaseUrl: descriptor.apiBaseUrl,
    apiPid: descriptor.apiPid,
    apiStartNonce: descriptor.apiStartNonce,
  };
}

function challengePayload(
  fields: Omit<CandidateRuntimeChallengeResponse, "signatureBase64Url">,
): Buffer {
  return Buffer.from([
    CHALLENGE_SIGNATURE_DOMAIN,
    canonicalJson(fields),
  ].join("\0"), "utf8");
}

function parseChallenge(value: unknown): string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_CHALLENGE_INVALID");
  }
  return value;
}

function assertCurrentDatabaseIdentity(input: {
  databaseFile: string;
  checkpointDirectory: string;
  descriptor: CandidateRuntimeAttestationDescriptor;
}): void {
  const opened = openOwnedPrivateDatabase(
    input.databaseFile,
    input.checkpointDirectory,
    input.descriptor.runtimeMode === "readonly-evidence"
      ? [PRIVATE_FILE_MODE, 0o400]
      : [PRIVATE_FILE_MODE],
  );
  try {
    const pathBinding = candidateRuntimeDatabasePathBinding({
      canonicalDatabaseFile: opened.canonical,
      dev: opened.stat.dev,
      ino: opened.stat.ino,
      sessionBinding: input.descriptor.sessionBinding,
      checkpointBinding: input.descriptor.checkpointBinding,
      apiStartNonce: input.descriptor.apiStartNonce,
    });
    const identity = input.descriptor.databaseIdentity;
    const contentMatches = identity.contentProjection
      === CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_BUSINESS_CONTENT_PROJECTION
      ? candidateExactAuthorizationBusinessContentSha256({
        kind: "descriptor-snapshot",
        descriptor: opened.descriptor,
        databaseFile: input.databaseFile,
      })
        === identity.contentSha256
      : (
          opened.stat.size === identity.sizeAtStart
          && `sha256:${sha256(fs.readFileSync(opened.descriptor))}`
            === identity.contentSha256
        );
    const currentPath = fs.lstatSync(input.databaseFile);
    if (
      opened.stat.dev !== identity.dev
      || opened.stat.ino !== identity.ino
      || currentPath.isSymbolicLink()
      || !currentPath.isFile()
      || currentPath.dev !== opened.stat.dev
      || currentPath.ino !== opened.stat.ino
      || !contentMatches
      || pathBinding !== identity.pathBinding
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_DATABASE_IDENTITY_CHANGED");
    }
  } finally {
    closeDescriptor(opened.descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY
      | (typeof fs.constants.O_DIRECTORY === "number"
        ? fs.constants.O_DIRECTORY
        : 0)
      | noFollowFlag(),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAtomicPrivateDescriptor(
  attestationDirectory: string,
  descriptor: CandidateRuntimeAttestationDescriptor,
  exclusiveDestination = false,
): string {
  const destination = path.join(
    attestationDirectory,
    CANDIDATE_RUNTIME_ATTESTATION_FILE,
  );
  if (exclusiveDestination) {
    let exclusiveDescriptor: number | null = null;
    try {
      exclusiveDescriptor = fs.openSync(
        destination,
        fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_WRONLY
          | noFollowFlag(),
        PRIVATE_FILE_MODE,
      );
      fs.writeFileSync(
        exclusiveDescriptor,
        `${canonicalJson(descriptor)}\n`,
        "utf8",
      );
      fs.fsyncSync(exclusiveDescriptor);
      fs.fchmodSync(exclusiveDescriptor, PRIVATE_FILE_MODE);
      fs.closeSync(exclusiveDescriptor);
      exclusiveDescriptor = null;
      fsyncDirectory(attestationDirectory);
      return destination;
    } catch (error) {
      if (error instanceof CandidateRuntimeAttestationError) throw error;
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        return fail("CANDIDATE_RUNTIME_ATTESTATION_FILE_ALREADY_EXISTS");
      }
      return fail("CANDIDATE_RUNTIME_ATTESTATION_FILE_WRITE_FAILED");
    } finally {
      if (exclusiveDescriptor !== null) closeDescriptor(exclusiveDescriptor);
    }
  }
  const temporary = path.join(
    attestationDirectory,
    `.candidate-runtime-attestation-${crypto.randomBytes(16).toString("hex")}.tmp`,
  );
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY
        | noFollowFlag(),
      PRIVATE_FILE_MODE,
    );
    fs.writeFileSync(
      fileDescriptor,
      `${canonicalJson(descriptor)}\n`,
      "utf8",
    );
    fs.fsyncSync(fileDescriptor);
    fs.fchmodSync(fileDescriptor, PRIVATE_FILE_MODE);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    fs.renameSync(temporary, destination);
    fsyncDirectory(attestationDirectory);
    const stat = fs.lstatSync(destination);
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || (stat.mode & 0o777) !== PRIVATE_FILE_MODE
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_FILE_SECURITY_INVALID");
    }
    return destination;
  } catch (error) {
    if (error instanceof CandidateRuntimeAttestationError) throw error;
    return fail("CANDIDATE_RUNTIME_ATTESTATION_FILE_WRITE_FAILED");
  } finally {
    if (fileDescriptor !== null) closeDescriptor(fileDescriptor);
    fs.rmSync(temporary, { force: true });
  }
}

type InstalledAuthority = {
  active: boolean;
  installationProfile: "generic" | "formal-readonly" | "formal-artifact";
  publicAuthority: CandidateRuntimeAuthority | null;
  descriptor: CandidateRuntimeAttestationDescriptor;
  privateKey: crypto.KeyObject;
  expectedUserId: number;
  expectedWorkspaceId: string;
  expectedTokenSha256: Buffer;
  databaseFile: string;
  checkpointDirectory: string;
  consumedChallenges: Set<string>;
  consumedReadChallenges: Set<string>;
  environment: NodeJS.ProcessEnv;
  runtimeSafetyProbe: (() => void) | null;
  exactAuthorizationSession: CandidateExactAuthorizationRuntimeSession | null;
  formalSurfaceProof: {
    bootstrapBinding: string;
    environmentBinding: string;
    releaseManifestPayloadSha256: string;
    persistentEnvironment: string;
    exactAuthorizationTrustBundle:
      FormalCandidateExactAuthorizationTrustBundle;
    exactAuthorizationTrustEnvironment:
      CandidateExactAuthorizationTrustEnvironment;
  } | null;
};

function formalRuntimePersistentEnvironment(
  environment: NodeJS.ProcessEnv,
): string {
  return canonicalJson(Object.fromEntries(
    Object.entries(environment)
      .filter((entry): entry is [string, string] => (
        typeof entry[1] === "string"
        && !FORMAL_RUNTIME_EPHEMERAL_ENVIRONMENT_KEYS.has(entry[0])
      ))
      .sort(([left], [right]) => left.localeCompare(right, "en")),
  ));
}

function assertFormalRuntimeSurfaceEnvironmentCurrent(
  authority: InstalledAuthority,
): void {
  const proof = authority.formalSurfaceProof;
  const environment = authority.environment;
  const artifact = authority.descriptor.artifactExecutionBinding;
  const session = authority.exactAuthorizationSession;
  if (
    !proof
    || authority.installationProfile !== "formal-artifact"
    || environment !== process.env
    || environment.NODE_ENV !== "prod"
    || environment.FANJIN_FORMAL_CANDIDATE_RUNTIME !== "1"
    || environment.FANJIN_DISABLE_AUTO_START !== "1"
    || environment.FANJIN_DISABLE_LOCAL_ENV !== "1"
    || environment.FANJIN_LOAD_LOCAL_ENV_IN_TESTS !== "0"
    || environment.FANJIN_DISABLE_LOCAL_KEYCHAIN_SECRETS !== "1"
    || environment.FANJIN_BIND_HOST !== "127.0.0.1"
    || environment.FANJIN_APP_PORT
      !== new URL(authority.descriptor.apiBaseUrl).port
    || environment.FANJIN_DATA_DIR !== authority.checkpointDirectory
    || environment.FANJIN_DATABASE_CLIENT !== "sqlite"
    || environment.FANJIN_RECOVERY_ONLY_MODE !== "0"
    || environment.FANJIN_CANDIDATE_RUNTIME_LOG_PROJECTION !== "redacted-v1"
    || environment[RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV] !== undefined
    || environment[CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV]
      !== undefined
    || environment[CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV]
      !== undefined
    || `sha256:${String(
      environment.FANJIN_FORMAL_CANDIDATE_MANIFEST_PAYLOAD_SHA256 || "",
    )}` !== proof.releaseManifestPayloadSha256
    || formalRuntimePersistentEnvironment(environment)
      !== proof.persistentEnvironment
    || !BINDING_PATTERN.test(proof.environmentBinding)
    || !BINDING_PATTERN.test(proof.bootstrapBinding)
    || !artifact
    || !session
    || parseFormalCandidateExactAuthorizationTrustBundle(
      proof.exactAuthorizationTrustBundle,
      session.candidateIdentity.attestationKeyId,
    ).binding !== proof.exactAuthorizationTrustBundle.binding
    || canonicalJson(candidateExactAuthorizationTrustEnvironment(
      proof.exactAuthorizationTrustBundle,
    )) !== canonicalJson(proof.exactAuthorizationTrustEnvironment)
    || artifact.artifactSignedManifestSha256
      !== session.candidateIdentity.artifactSignedManifestSha256
  ) {
    fail("CANDIDATE_RUNTIME_FORMAL_SURFACE_PROOF_CHANGED");
  }
}

let installedAuthority: InstalledAuthority | null = null;
let readonlyEvidenceProcessFenceLatched = false;

/** Runtime-only guard for legacy "read" routes whose ordinary implementation
 * may opportunistically poll a provider and materialize state. */
export function isCandidateRuntimeReadonlyEvidenceAuthorityActive(): boolean {
  return Boolean(
    installedAuthority?.active
    && installedAuthority.descriptor.runtimeMode === "readonly-evidence",
  );
}

/** Process-start fence used before the in-memory signing authority is
 * installed. Formal child env is sanitized and fixed by the parent runner, so
 * provider polling and opportunistic sync routes are closed before listen(). */
export function isCandidateRuntimeReadonlyEvidenceMode(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const declared = readonlyEvidenceProcessFenceLatched
    || installedAuthority?.descriptor.runtimeMode === "readonly-evidence"
    || environment.FANJIN_READONLY_EVIDENCE_MODE === "1";
  if (!declared) return false;
  readonlyEvidenceProcessFenceLatched = true;
  try {
    inspectCandidateRuntimeReadonlyEnvironmentProfile(environment);
  } catch {
    // A downgraded formal environment must keep the dangerous-route fence
    // closed. The signing authority separately becomes permanently unusable.
  }
  return true;
}

type CandidateRuntimeAuthorityInternalInput = {
  checkpointDirectory: string;
  attestationDirectory?: string;
  exclusiveAttestationFile?: boolean;
  nodeTransportFenceInstalled?: boolean;
  osOutboundNetworkDenied?: boolean;
  runtimeSafetyProbe?: () => void;
  databaseFile: string;
  apiBaseUrl: string;
  sessionBinding: string;
  checkpointBinding: string;
  expectedUserId: number;
  expectedWorkspaceId: string;
  expectedToken: string;
  runtimeMode: CandidateRuntimeMode;
  exactAuthorizationSession?: CandidateExactAuthorizationRuntimeSession;
  artifactExecutionBinding?: CandidateRuntimeArtifactExecutionBinding;
  environment?: NodeJS.ProcessEnv;
  dependencies?: CandidateRuntimeAuthorityDependencies;
};

type CandidateRuntimeAuthorityGenericInput = Omit<
  CandidateRuntimeAuthorityInternalInput,
  | "nodeTransportFenceInstalled"
  | "osOutboundNetworkDenied"
  | "runtimeSafetyProbe"
  | "artifactExecutionBinding"
>;

const CURRENT_PROCESS_READONLY_INSTALLATION_PROFILE = Symbol(
  "CURRENT_PROCESS_READONLY_INSTALLATION_PROFILE",
);
const CURRENT_PROCESS_FORMAL_ARTIFACT_INSTALLATION_PROFILE = Symbol(
  "CURRENT_PROCESS_FORMAL_ARTIFACT_INSTALLATION_PROFILE",
);

export type FormalArtifactCandidateRuntimeAuthorityInput = Readonly<{
  checkpointDirectory: string;
  attestationDirectory: string;
  databaseFile: string;
  apiBaseUrl: string;
  sessionBinding: string;
  checkpointBinding: string;
  expectedUserId: number;
  expectedWorkspaceId: string;
  expectedToken: string;
  exactAuthorizationSession: CandidateExactAuthorizationRuntimeSession;
  expectedArtifactExecutionBinding: CandidateRuntimeArtifactExecutionBinding;
}>;

function sameFormalEntrypointStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink;
}

function trustedFormalReadonlyOwner(metadata: fs.BigIntStats): boolean {
  if (typeof process.getuid !== "function") return true;
  return metadata.uid === 0n || metadata.uid === BigInt(process.getuid());
}

/**
 * Establishes the artifact identity from the file Node actually executed.
 * The caller may supply an expectation from a signed manifest, but cannot
 * substitute another path or detached byte digest: argv[1], the canonical
 * pathname, the opened descriptor and the final pathname must all remain the
 * same read-only, single-link file while it is hashed.
 */
function observeCurrentProcessFormalArtifactExecutionBinding(
  expectedValue: CandidateRuntimeArtifactExecutionBinding,
): CandidateRuntimeArtifactExecutionBinding {
  const expected = parseRuntimeArtifactExecutionBinding(expectedValue);
  if (!expected) {
    return fail("CANDIDATE_RUNTIME_FORMAL_ARTIFACT_BINDING_REQUIRED");
  }
  if (process.argv.length !== 2 || process.execArgv.length !== 0) {
    return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_COMMAND_INVALID");
  }
  const argument = String(process.argv[1] || "");
  if (!path.isAbsolute(argument) || path.normalize(argument) !== argument) {
    return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_PATH_INVALID");
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(argument);
  } catch {
    return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_UNAVAILABLE");
  }
  if (canonical !== argument) {
    return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_PATH_INVALID");
  }
  const manifestSuffix = expected.manifestPath.split("/").join(path.sep);
  if (
    canonical.length <= manifestSuffix.length
    || !canonical.endsWith(`${path.sep}${manifestSuffix}`)
  ) {
    return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_MANIFEST_PATH_MISMATCH");
  }
  const releaseRoot = canonical.slice(
    0,
    canonical.length - manifestSuffix.length - 1,
  );
  if (!path.isAbsolute(releaseRoot) || fs.realpathSync(releaseRoot) !== releaseRoot) {
    return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_ROOT_INVALID");
  }
  const relativeSegments = expected.manifestPath.split("/");
  let directory = releaseRoot;
  for (const segment of ["", ...relativeSegments.slice(0, -1)]) {
    if (segment) directory = path.join(directory, segment);
    const metadata = fs.lstatSync(directory, { bigint: true });
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || (metadata.mode & 0o222n) !== 0n
      || fs.realpathSync(directory) !== directory
      || !trustedFormalReadonlyOwner(metadata)
    ) {
      return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_ROOT_INVALID");
    }
  }
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(canonical, { bigint: true });
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1n
      || before.size < 1n
      || before.size > BigInt(MAX_FORMAL_ENTRYPOINT_BYTES)
      || (before.mode & 0o222n) !== 0n
      || !trustedFormalReadonlyOwner(before)
    ) {
      return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_FILE_INVALID");
    }
    descriptor = fs.openSync(
      canonical,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFormalEntrypointStat(before, opened)) {
      return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_CHANGED");
    }
    const bytes = fs.readFileSync(descriptor);
    const afterDescriptor = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(canonical, { bigint: true });
    if (
      !sameFormalEntrypointStat(opened, afterDescriptor)
      || !sameFormalEntrypointStat(opened, afterPath)
      || bytes.byteLength !== Number(opened.size)
      || expected.byteSize !== bytes.byteLength
      || expected.sha256 !== sha256(bytes)
    ) {
      return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_CHANGED");
    }
    return Object.freeze({ ...expected });
  } catch (error) {
    if (error instanceof CandidateRuntimeAttestationError) throw error;
    return fail("CANDIDATE_RUNTIME_FORMAL_ENTRYPOINT_UNAVAILABLE");
  } finally {
    if (descriptor !== null) closeDescriptor(descriptor);
  }
}

export function installCandidateRuntimeAuthority(
  input: CandidateRuntimeAuthorityGenericInput,
): CandidateRuntimeAuthority {
  if (
    Object.prototype.hasOwnProperty.call(input, "artifactExecutionBinding")
    || Object.prototype.hasOwnProperty.call(
      input,
      "expectedArtifactExecutionBinding",
    )
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_GENERIC_ARTIFACT_BINDING_FORBIDDEN");
  }
  if (input.runtimeMode === "readonly-evidence") {
    fail("CANDIDATE_RUNTIME_ATTESTATION_GENERIC_READONLY_FORBIDDEN");
  }
  return installCandidateRuntimeAuthorityInternal(input, "generic");
}

/**
 * Formal candidate installer.  Unlike the generic/source harness installer,
 * this profile always binds the authority to the immutable bytes in argv[1].
 * Clock, RNG, key generation, PID and environment are intentionally not
 * injectable.
 */
export function installFormalArtifactCandidateRuntimeAuthority(
  input: FormalArtifactCandidateRuntimeAuthorityInput,
): CandidateRuntimeAuthority {
  if (!exactKeys(input as unknown as Record<string, unknown>, [
    "apiBaseUrl",
    "attestationDirectory",
    "checkpointBinding",
    "checkpointDirectory",
    "databaseFile",
    "exactAuthorizationSession",
    "expectedArtifactExecutionBinding",
    "expectedToken",
    "expectedUserId",
    "expectedWorkspaceId",
    "sessionBinding",
  ])) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_FORMAL_ARTIFACT_INPUT_INVALID");
  }
  const sessionValue = input.exactAuthorizationSession;
  if (!exactKeys(sessionValue as unknown as Record<string, unknown>, [
    "candidateIdentity",
    "createdAt",
    "projectId",
    "userId",
    "workspaceId",
  ])) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_FORMAL_ARTIFACT_SESSION_INVALID");
  }
  const exactAuthorizationSession = Object.freeze({
    workspaceId: String(sessionValue.workspaceId || ""),
    projectId: Number(sessionValue.projectId),
    userId: Number(sessionValue.userId),
    createdAt: String(sessionValue.createdAt || ""),
    candidateIdentity: parseFormalCandidatePrelaunchSessionIdentity(
      sessionValue.candidateIdentity,
    ),
  });
  if (
    exactAuthorizationSession.userId !== input.expectedUserId
    || exactAuthorizationSession.workspaceId !== input.expectedWorkspaceId
    || candidateExactAuthorizationSessionBinding(exactAuthorizationSession)
      !== input.sessionBinding
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_FORMAL_ARTIFACT_SESSION_INVALID");
  }
  const artifactExecutionBinding =
    observeCurrentProcessFormalArtifactExecutionBinding(
      input.expectedArtifactExecutionBinding,
    );
  return installCandidateRuntimeAuthorityInternal({
    checkpointDirectory: input.checkpointDirectory,
    attestationDirectory: input.attestationDirectory,
    exclusiveAttestationFile: true,
    databaseFile: input.databaseFile,
    apiBaseUrl: input.apiBaseUrl,
    sessionBinding: input.sessionBinding,
    checkpointBinding: input.checkpointBinding,
    expectedUserId: input.expectedUserId,
    expectedWorkspaceId: input.expectedWorkspaceId,
    expectedToken: input.expectedToken,
    runtimeMode: "candidate",
    exactAuthorizationSession,
    artifactExecutionBinding,
    environment: process.env,
  }, CURRENT_PROCESS_FORMAL_ARTIFACT_INSTALLATION_PROFILE);
}

/** Only formal current-process entrypoint. The caller cannot provide a mode,
 * environment, PID/clock/RNG/key, safety callback, or downgrade either OS or
 * Node transport isolation claims. */
export function installCurrentProcessReadonlyCandidateRuntimeAuthority(input: {
  checkpointDirectory: string;
  attestationDirectory: string;
  databaseFile: string;
  apiBaseUrl: string;
  sessionBinding: string;
  checkpointBinding: string;
  expectedUserId: number;
  expectedWorkspaceId: string;
  expectedToken: string;
}): CandidateRuntimeAuthority {
  if (!exactKeys(input as unknown as Record<string, unknown>, [
    "apiBaseUrl",
    "attestationDirectory",
    "checkpointBinding",
    "checkpointDirectory",
    "databaseFile",
    "expectedToken",
    "expectedUserId",
    "expectedWorkspaceId",
    "sessionBinding",
  ])) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_FORMAL_INSTALL_INPUT_INVALID");
  }
  const safety = require("./candidateReadonlyLoopbackEgressFence") as {
    assertCandidateReadonlyFormalEgressSafetyCurrent: () => void;
  };
  return installCandidateRuntimeAuthorityInternal({
    ...input,
    exclusiveAttestationFile: true,
    nodeTransportFenceInstalled: true,
    osOutboundNetworkDenied: true,
    runtimeSafetyProbe:
      safety.assertCandidateReadonlyFormalEgressSafetyCurrent,
    runtimeMode: "readonly-evidence",
  }, CURRENT_PROCESS_READONLY_INSTALLATION_PROFILE);
}

function installCandidateRuntimeAuthorityInternal(
  input: CandidateRuntimeAuthorityInternalInput,
  installationProfile:
    | "generic"
    | typeof CURRENT_PROCESS_READONLY_INSTALLATION_PROFILE
    | typeof CURRENT_PROCESS_FORMAL_ARTIFACT_INSTALLATION_PROFILE,
): CandidateRuntimeAuthority {
  if (
    (input.runtimeMode === "readonly-evidence")
      !== (installationProfile === CURRENT_PROCESS_READONLY_INSTALLATION_PROFILE)
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_INSTALLATION_PROFILE_INVALID");
  }
  if (
    installationProfile === CURRENT_PROCESS_FORMAL_ARTIFACT_INSTALLATION_PROFILE
    && (
      input.runtimeMode !== "candidate"
      || input.exactAuthorizationSession === undefined
      || input.artifactExecutionBinding === undefined
      || input.dependencies !== undefined
      || input.environment !== process.env
      || input.exclusiveAttestationFile !== true
      || input.attestationDirectory === undefined
    )
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_FORMAL_ARTIFACT_PROFILE_INVALID");
  }
  if (
    installationProfile !== CURRENT_PROCESS_FORMAL_ARTIFACT_INSTALLATION_PROFILE
    && input.artifactExecutionBinding !== undefined
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_ARTIFACT_BINDING_PROFILE_INVALID");
  }
  let exactAuthorizationSession: CandidateExactAuthorizationRuntimeSession | null = null;
  if (input.exactAuthorizationSession !== undefined) {
    const candidateIdentity = installationProfile
        === CURRENT_PROCESS_FORMAL_ARTIFACT_INSTALLATION_PROFILE
      ? parseFormalCandidatePrelaunchSessionIdentity(
        input.exactAuthorizationSession.candidateIdentity,
      )
      : parseCandidateExactAuthorizationSessionIdentity(
        input.exactAuthorizationSession.candidateIdentity,
      );
    exactAuthorizationSession = Object.freeze({
      workspaceId: String(input.exactAuthorizationSession.workspaceId || ""),
      projectId: Number(input.exactAuthorizationSession.projectId),
      userId: Number(input.exactAuthorizationSession.userId),
      createdAt: String(input.exactAuthorizationSession.createdAt || ""),
      candidateIdentity,
    });
    if (
      input.runtimeMode !== "candidate"
      || exactAuthorizationSession.workspaceId !== input.expectedWorkspaceId
      || exactAuthorizationSession.userId !== input.expectedUserId
      || candidateExactAuthorizationSessionBinding(exactAuthorizationSession)
        !== input.sessionBinding
    ) {
      fail("CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_SESSION_INVALID");
    }
  }
  if (installedAuthority) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_ALREADY_INSTALLED");
  }
  if (
    !BINDING_PATTERN.test(input.sessionBinding)
    || !CHECKPOINT_BINDING_PATTERN.test(input.checkpointBinding)
    || !Number.isSafeInteger(input.expectedUserId)
    || input.expectedUserId <= 0
    || !input.expectedWorkspaceId
    || input.expectedWorkspaceId !== input.expectedWorkspaceId.trim()
    || input.expectedWorkspaceId.length > 200
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_TARGET_BINDING_INVALID");
  }
  const expectedToken = String(input.expectedToken || "")
    .replace(/^Bearer\s+/i, "").trim();
  if (expectedToken.length < 16 || expectedToken.length > 16 * 1024) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_TARGET_TOKEN_INVALID");
  }
  const checkpointDirectory = assertOwnedPrivateDirectory(
    input.checkpointDirectory,
    installationProfile === CURRENT_PROCESS_READONLY_INSTALLATION_PROFILE
      ? [PRIVATE_DIRECTORY_MODE, 0o500]
      : [PRIVATE_DIRECTORY_MODE],
  );
  const attestationDirectory = input.attestationDirectory === undefined
    ? checkpointDirectory
    : assertOwnedPrivateDirectory(input.attestationDirectory);
  const exclusiveAttestationFile = input.exclusiveAttestationFile === true;
  if (exclusiveAttestationFile && input.attestationDirectory === undefined) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_DIRECTORY_REQUIRED");
  }
  const nodeTransportFenceInstalled = input.nodeTransportFenceInstalled === true;
  const osOutboundNetworkDenied = input.osOutboundNetworkDenied === true;
  const runtimeSafetyClaimed = nodeTransportFenceInstalled
    || osOutboundNetworkDenied;
  if (
    runtimeSafetyClaimed !== (typeof input.runtimeSafetyProbe === "function")
    || nodeTransportFenceInstalled !== osOutboundNetworkDenied
    || (runtimeSafetyClaimed && input.runtimeMode !== "readonly-evidence")
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_EGRESS_POLICY_INVALID");
  }
  const dependencies = input.dependencies ?? {};
  const now = dependencies.now ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? crypto.randomBytes;
  const pid = dependencies.pid ?? process.pid;
  const uptimeSeconds = dependencies.processUptimeSeconds ?? process.uptime();
  const environment = input.environment ?? process.env;
  const policy = inspectCandidateRuntimePolicy(environment);
  assertRuntimeModePolicy(input.runtimeMode, policy);
  const readonlyEnvironmentProfile = input.runtimeMode === "readonly-evidence"
    ? inspectCandidateRuntimeReadonlyEnvironmentProfile(
      environment,
      checkpointDirectory,
    )
    : null;
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isFinite(uptimeSeconds)
    || uptimeSeconds < 0
  ) {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_PROCESS_IDENTITY_INVALID");
  }
  const createdAtDate = now();
  const createdAt = parseExactIsoTimestamp(createdAtDate.toISOString());
  const apiProcessStartedAt = new Date(
    createdAtDate.getTime() - Math.floor(uptimeSeconds * 1_000),
  ).toISOString();
  const apiStartNonce = randomBytes(32).toString("base64url");
  if (!NONCE_PATTERN.test(apiStartNonce)) {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_NONCE_INVALID");
  }
  const apiBaseUrl = parseApiBaseUrl(input.apiBaseUrl);
  const generateKeyPair = dependencies.generateKeyPair
    ?? (() => crypto.generateKeyPairSync("ed25519"));
  const keyPair = generateKeyPair();
  if (
    keyPair.publicKey.asymmetricKeyType !== "ed25519"
    || keyPair.privateKey.asymmetricKeyType !== "ed25519"
  ) {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_KEY_INVALID");
  }
  const publicKeySpkiBase64Url = (
    keyPair.publicKey.export({ format: "der", type: "spki" }) as Buffer
  ).toString("base64url");
  const opened = openOwnedPrivateDatabase(
    input.databaseFile,
    checkpointDirectory,
    installationProfile === CURRENT_PROCESS_READONLY_INSTALLATION_PROFILE
      ? [0o400]
      : [PRIVATE_FILE_MODE],
  );
  const contentProjection: CandidateRuntimeDatabaseContentProjection =
    exactAuthorizationSession
      ? CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_BUSINESS_CONTENT_PROJECTION
      : CANDIDATE_RUNTIME_FULL_FILE_CONTENT_PROJECTION;
  let databaseIdentity: CandidateRuntimeDatabaseIdentity;
  try {
    databaseIdentity = Object.freeze({
      contentProjection,
      dev: opened.stat.dev,
      ino: opened.stat.ino,
      sizeAtStart: opened.stat.size,
      contentSha256: contentProjection
        === CANDIDATE_RUNTIME_EXACT_AUTHORIZATION_BUSINESS_CONTENT_PROJECTION
        ? candidateExactAuthorizationBusinessContentSha256({
          kind: "descriptor-snapshot",
          descriptor: opened.descriptor,
          databaseFile: input.databaseFile,
        })
        : `sha256:${sha256(fs.readFileSync(opened.descriptor))}`,
      pathBinding: candidateRuntimeDatabasePathBinding({
        canonicalDatabaseFile: opened.canonical,
        dev: opened.stat.dev,
        ino: opened.stat.ino,
        sessionBinding: input.sessionBinding,
        checkpointBinding: input.checkpointBinding,
        apiStartNonce,
      }),
    });
  } finally {
    closeDescriptor(opened.descriptor);
  }
  const unsigned: Omit<
    CandidateRuntimeAttestationDescriptor,
    "authorityBinding"
  > = {
    version: CANDIDATE_RUNTIME_ATTESTATION_VERSION,
    createdAt,
    apiBaseUrl,
    apiPid: pid,
    apiProcessStartedAt: parseExactIsoTimestamp(apiProcessStartedAt),
    apiStartNonce,
    sessionBinding: input.sessionBinding,
    checkpointBinding: input.checkpointBinding,
    artifactExecutionBinding: input.artifactExecutionBinding ?? null,
    databaseIdentity,
    runtimeMode: input.runtimeMode,
    runtimePolicy: policy,
    readonlyEnvironmentProfile,
    nodeTransportFenceInstalled,
    osOutboundNetworkDenied,
    publicKeySpkiBase64Url,
  };
  const descriptor = assertCandidateRuntimeAttestationDescriptor({
    ...unsigned,
    authorityBinding: authorityBinding(unsigned),
  });
  assertCurrentDatabaseIdentity({
    databaseFile: input.databaseFile,
    checkpointDirectory,
    descriptor,
  });
  const attestationFile = writeAtomicPrivateDescriptor(
    attestationDirectory,
    descriptor,
    exclusiveAttestationFile,
  );
  const authority: InstalledAuthority = {
    active: true,
    installationProfile:
      installationProfile === CURRENT_PROCESS_FORMAL_ARTIFACT_INSTALLATION_PROFILE
        ? "formal-artifact"
        : installationProfile === CURRENT_PROCESS_READONLY_INSTALLATION_PROFILE
          ? "formal-readonly"
          : "generic",
    publicAuthority: null,
    descriptor,
    privateKey: keyPair.privateKey,
    expectedUserId: input.expectedUserId,
    expectedWorkspaceId: input.expectedWorkspaceId,
    expectedTokenSha256: crypto.createHash("sha256")
      .update(expectedToken, "utf8").digest(),
    databaseFile: input.databaseFile,
    checkpointDirectory,
    consumedChallenges: new Set(),
    consumedReadChallenges: new Set(),
    environment,
    runtimeSafetyProbe: input.runtimeSafetyProbe ?? null,
    exactAuthorizationSession,
    formalSurfaceProof: null,
  };
  installedAuthority = authority;

  const dispose = (): void => {
    if (installedAuthority === authority) installedAuthority = null;
    authority.active = false;
    authority.formalSurfaceProof = null;
    authority.consumedChallenges.clear();
    authority.consumedReadChallenges.clear();
  };
  const publicAuthority = Object.freeze({
    descriptor,
    attestationFile,
    answerChallenge: (challenge: string) =>
      answerInstalledAuthorityChallenge(authority, challenge),
    assertCurrentDatabaseIdentity: () => {
      assertInstalledAuthorityCurrent(authority);
      assertCurrentDatabaseIdentity({
        databaseFile: authority.databaseFile,
        checkpointDirectory: authority.checkpointDirectory,
        descriptor: authority.descriptor,
      });
    },
    dispose,
  });
  authority.publicAuthority = publicAuthority;
  return publicAuthority;
}

function assertInstalledAuthorityCurrent(authority: InstalledAuthority): void {
  if (!authority.active || installedAuthority !== authority) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_AUTHORITY_DISPOSED");
  }
  try {
    const currentPolicy = inspectCandidateRuntimePolicy(authority.environment);
    assertRuntimeModePolicy(authority.descriptor.runtimeMode, currentPolicy);
    if (
      canonicalJson(currentPolicy)
        !== canonicalJson(authority.descriptor.runtimePolicy)
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_RUNTIME_POLICY_CHANGED");
    }
    if (authority.formalSurfaceProof) {
      assertFormalRuntimeSurfaceEnvironmentCurrent(authority);
    }
    if (authority.descriptor.runtimeMode === "readonly-evidence") {
      const currentProfile = inspectCandidateRuntimeReadonlyEnvironmentProfile(
        authority.environment,
        authority.checkpointDirectory,
      );
      if (
        canonicalJson(currentProfile)
          !== canonicalJson(authority.descriptor.readonlyEnvironmentProfile)
      ) {
        fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_ENVIRONMENT_CHANGED");
      }
    }
    if (
      authority.descriptor.nodeTransportFenceInstalled
      || authority.descriptor.osOutboundNetworkDenied
    ) {
      authority.runtimeSafetyProbe?.();
    }
  } catch (error) {
    authority.active = false;
    if (installedAuthority === authority) installedAuthority = null;
    throw error;
  }
}

function answerInstalledAuthorityChallenge(
  authority: InstalledAuthority,
  rawChallenge: string,
): CandidateRuntimeChallengeResponse {
  assertInstalledAuthorityCurrent(authority);
  const challenge = parseChallenge(rawChallenge);
  if (
    authority.consumedChallenges.has(challenge)
    || authority.consumedChallenges.size >= MAX_CONSUMED_CHALLENGES
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_CHALLENGE_REPLAYED");
  }
  assertCurrentDatabaseIdentity({
    databaseFile: authority.databaseFile,
    checkpointDirectory: authority.checkpointDirectory,
    descriptor: authority.descriptor,
  });
  authority.consumedChallenges.add(challenge);
  const fields = challengeFields(authority.descriptor, challenge);
  const signatureBase64Url = crypto.sign(
    null,
    challengePayload(fields),
    authority.privateKey,
  ).toString("base64url");
  return Object.freeze({ ...fields, signatureBase64Url });
}

export function assertCandidateRuntimeChallengeResponse(input: {
  descriptor: CandidateRuntimeAttestationDescriptor;
  challenge: string;
  response: unknown;
}): CandidateRuntimeChallengeResponse {
  const descriptor = assertCandidateRuntimeAttestationDescriptor(
    input.descriptor,
  );
  const challenge = parseChallenge(input.challenge);
  if (
    !input.response
    || typeof input.response !== "object"
    || Array.isArray(input.response)
    || !exactKeys(
      input.response as Record<string, unknown>,
      CHALLENGE_RESPONSE_KEYS,
    )
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_CHALLENGE_RESPONSE_INVALID");
  }
  const response = input.response as Record<string, unknown>;
  const fields = challengeFields(descriptor, challenge);
  if (
    response.version !== fields.version
    || response.challenge !== fields.challenge
    || response.authorityBinding !== fields.authorityBinding
    || response.apiBaseUrl !== fields.apiBaseUrl
    || response.apiPid !== fields.apiPid
    || response.apiStartNonce !== fields.apiStartNonce
    || typeof response.signatureBase64Url !== "string"
    || !BASE64URL_PATTERN.test(response.signatureBase64Url)
    || response.signatureBase64Url.length < 80
    || response.signatureBase64Url.length > 128
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_CHALLENGE_RESPONSE_INVALID");
  }
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(descriptor.publicKeySpkiBase64Url, "base64url"),
      format: "der",
      type: "spki",
    });
  } catch {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_PUBLIC_KEY_INVALID");
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || !crypto.verify(
      null,
      challengePayload(fields),
      publicKey,
      Buffer.from(response.signatureBase64Url, "base64url"),
    )
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_CHALLENGE_SIGNATURE_INVALID");
  }
  return Object.freeze(response as unknown as CandidateRuntimeChallengeResponse);
}

export function readCandidateRuntimeAttestationDescriptor(
  attestationFile: string,
): CandidateRuntimeAttestationDescriptor {
  if (!path.isAbsolute(attestationFile)) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_FILE_PATH_INVALID");
  }
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      attestationFile,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== PRIVATE_FILE_MODE
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || stat.size < 2
      || stat.size > MAX_ATTESTATION_BYTES
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_FILE_SECURITY_INVALID");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch {
      return fail("CANDIDATE_RUNTIME_ATTESTATION_FILE_JSON_INVALID");
    }
    return assertCandidateRuntimeAttestationDescriptor(parsed);
  } catch (error) {
    if (error instanceof CandidateRuntimeAttestationError) throw error;
    return fail("CANDIDATE_RUNTIME_ATTESTATION_FILE_UNAVAILABLE");
  } finally {
    if (descriptor !== null) closeDescriptor(descriptor);
  }
}

export async function probeCandidateRuntimeAuthority(input: {
  descriptor: CandidateRuntimeAttestationDescriptor;
  token: string;
  fetchImpl?: typeof fetch;
  challenge?: string;
}): Promise<CandidateRuntimeChallengeResponse> {
  const descriptor = assertCandidateRuntimeAttestationDescriptor(
    input.descriptor,
  );
  const token = String(input.token || "").trim();
  if (!token.startsWith("Bearer ") || token.length < 16) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_PROBE_TOKEN_INVALID");
  }
  const challenge = parseChallenge(
    input.challenge ?? crypto.randomBytes(32).toString("base64url"),
  );
  const endpoint = new URL(CANDIDATE_RUNTIME_ATTESTATION_PATH, `${descriptor.apiBaseUrl}/../`);
  const expectedEndpoint = `${descriptor.apiBaseUrl}/internal/candidate-runtime-attestation`;
  if (endpoint.toString() !== expectedEndpoint) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_PROBE_ENDPOINT_INVALID");
  }
  endpoint.searchParams.set("challenge", challenge);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/json",
      authorization: token,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    await response.arrayBuffer().catch(() => undefined);
    fail("CANDIDATE_RUNTIME_ATTESTATION_PROBE_FAILED");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_ATTESTATION_BYTES) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_PROBE_RESPONSE_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_PROBE_RESPONSE_INVALID");
  }
  return assertCandidateRuntimeChallengeResponse({
    descriptor,
    challenge,
    response: parsed,
  });
}

function normalizeRequestMethod(value: unknown): string {
  const method = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3,12}$/.test(method)) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READ_METHOD_INVALID");
  }
  return method;
}

function normalizeRequestTarget(value: unknown): string {
  const target = String(value || "");
  if (
    !target.startsWith("/")
    || target.length > 4_096
    || target.includes("\0")
    || /[\r\n]/.test(target)
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READ_TARGET_INVALID");
  }
  return target;
}

function normalizeContentType(value: unknown): string {
  const contentType = String(value || "").trim().toLowerCase();
  if (
    contentType.length > 200
    || /[\r\n\0]/.test(contentType)
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READ_CONTENT_TYPE_INVALID");
  }
  return contentType;
}

function readResponseFields(input: {
  descriptor: CandidateRuntimeAttestationDescriptor;
  challenge: string;
  method: string;
  requestTarget: string;
  requestBody?: unknown;
  status: number;
  contentType: string;
  body: Buffer;
  projection?: CandidateSignedReadProjection;
}): Omit<CandidateRuntimeReadResponseProof, "signatureBase64Url"> {
  if (
    !Number.isSafeInteger(input.status)
    || input.status < 100
    || input.status > 599
    || input.body.byteLength > 64 * 1024 * 1024
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READ_RESPONSE_INVALID");
  }
  const method = normalizeRequestMethod(input.method);
  const requestTarget = normalizeRequestTarget(input.requestTarget);
  const contentType = normalizeContentType(input.contentType);
  const projection = input.projection ?? resolveCandidateSignedReadContract({
    method,
    requestTarget,
    requestBody: input.requestBody,
  });
  if (
    projection.method !== method
    || projection.normalizedTarget
      !== resolveCandidateSignedReadContract({
        method,
        requestTarget,
        ...(method === "POST"
          ? { requestBody: projection.requestBody }
          : {}),
      }).normalizedTarget
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READ_CONTRACT_CHANGED");
  }
  validateCandidateSignedReadResponse({
    projection,
    status: input.status,
    contentType,
    body: input.body,
  });
  return {
    version: CANDIDATE_RUNTIME_CHALLENGE_VERSION,
    contractRevision: projection.revision,
    contractId: projection.contractId,
    challenge: parseChallenge(input.challenge),
    authorityBinding: input.descriptor.authorityBinding,
    apiPid: input.descriptor.apiPid,
    apiStartNonce: input.descriptor.apiStartNonce,
    method: projection.method,
    requestTargetSha256: `sha256:${sha256(projection.normalizedPath)}`,
    requestQuerySha256: `sha256:${sha256(projection.normalizedQuery)}`,
    requestBodySha256: `sha256:${sha256(
      projection.method === "GET" || projection.method === "HEAD"
        ? Buffer.alloc(0)
        : canonicalJson(projection.requestBody),
    )}`,
    status: input.status,
    contentType,
    bodySha256: `sha256:${sha256(input.body)}`,
    bodyBytes: input.body.byteLength,
  };
}

function readResponsePayload(
  fields: Omit<CandidateRuntimeReadResponseProof, "signatureBase64Url">,
): Buffer {
  return Buffer.from([
    READ_RESPONSE_SIGNATURE_DOMAIN,
    canonicalJson(fields),
  ].join("\0"), "utf8");
}

function signCandidateRuntimeReadResponse(input: {
  authority: InstalledAuthority;
  challenge: string;
  method: string;
  requestTarget: string;
  requestBody?: unknown;
  status: number;
  contentType: string;
  body: Buffer;
  projection: CandidateSignedReadProjection;
}): CandidateRuntimeReadResponseProof {
  assertInstalledAuthorityCurrent(input.authority);
  assertCurrentDatabaseIdentity({
    databaseFile: input.authority.databaseFile,
    checkpointDirectory: input.authority.checkpointDirectory,
    descriptor: input.authority.descriptor,
  });
  const fields = readResponseFields({
    descriptor: input.authority.descriptor,
    challenge: input.challenge,
    method: input.method,
    requestTarget: input.requestTarget,
    requestBody: input.requestBody,
    status: input.status,
    contentType: input.contentType,
    body: input.body,
    projection: input.projection,
  });
  return Object.freeze({
    ...fields,
    signatureBase64Url: crypto.sign(
      null,
      readResponsePayload(fields),
      input.authority.privateKey,
    ).toString("base64url"),
  });
}

function responseHeader(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string {
  if (headers instanceof Headers) return String(headers.get(name) || "");
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    return Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return "";
}

export function assertCandidateRuntimeReadResponseProof(input: {
  descriptor: CandidateRuntimeAttestationDescriptor;
  challenge: string;
  method: string;
  requestTarget: string;
  requestBody?: unknown;
  status: number;
  contentType: string;
  body: Buffer | Uint8Array | string;
  headers: Headers | Record<string, string | string[] | undefined>;
}): CandidateRuntimeReadResponseProof {
  const descriptor = assertCandidateRuntimeAttestationDescriptor(
    input.descriptor,
  );
  assertRuntimeModePolicy("readonly-evidence", descriptor.runtimePolicy);
  const body = typeof input.body === "string"
    ? Buffer.from(input.body, "utf8")
    : Buffer.from(input.body);
  const fields = readResponseFields({
    descriptor,
    challenge: input.challenge,
    method: input.method,
    requestTarget: input.requestTarget,
    requestBody: input.requestBody,
    status: input.status,
    contentType: input.contentType,
    body,
  });
  const authorityBindingHeader = responseHeader(
    input.headers,
    CANDIDATE_RUNTIME_READ_AUTHORITY_HEADER,
  );
  const bodySha256Header = responseHeader(
    input.headers,
    CANDIDATE_RUNTIME_READ_BODY_SHA256_HEADER,
  );
  const signatureBase64Url = responseHeader(
    input.headers,
    CANDIDATE_RUNTIME_READ_SIGNATURE_HEADER,
  );
  if (
    authorityBindingHeader !== fields.authorityBinding
    || bodySha256Header !== fields.bodySha256
    || !BASE64URL_PATTERN.test(signatureBase64Url)
    || signatureBase64Url.length < 80
    || signatureBase64Url.length > 128
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READ_RESPONSE_HEADERS_INVALID");
  }
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(descriptor.publicKeySpkiBase64Url, "base64url"),
      format: "der",
      type: "spki",
    });
  } catch {
    return fail("CANDIDATE_RUNTIME_ATTESTATION_PUBLIC_KEY_INVALID");
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || !crypto.verify(
      null,
      readResponsePayload(fields),
      publicKey,
      Buffer.from(signatureBase64Url, "base64url"),
    )
  ) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READ_RESPONSE_SIGNATURE_INVALID");
  }
  const proof: CandidateRuntimeReadResponseProof = {
    ...fields,
    signatureBase64Url,
  };
  if (!exactKeys(proof as unknown as Record<string, unknown>, READ_RESPONSE_PROOF_KEYS)) {
    fail("CANDIDATE_RUNTIME_ATTESTATION_READ_RESPONSE_INVALID");
  }
  return Object.freeze(proof);
}

function endBodyBytes(chunk: unknown, encoding: unknown): Buffer | null {
  if (chunk === undefined || chunk === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") {
    const normalizedEncoding = typeof encoding === "string"
      ? encoding as BufferEncoding
      : "utf8";
    return Buffer.from(chunk, normalizedEncoding);
  }
  return null;
}

/**
 * Adds a detached signature to an exact read response. The middleware is
 * dormant unless the runner supplies a fresh challenge and a fully
 * worker-disabled `readonly-evidence` authority is installed. It never signs
 * streaming responses or any response after headers have already left the
 * process.
 */
export function candidateRuntimeReadResponseAttestationMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const rawChallenge = request.headers[CANDIDATE_RUNTIME_READ_CHALLENGE_HEADER];
  if (rawChallenge === undefined) {
    next();
    return;
  }
  const authority = installedAuthority;
  if (!authority || !requestAuthorityMatchesSession(request, authority)) {
    response.status(404).send({ code: "NOT_FOUND" });
    return;
  }
  try {
    assertRuntimeModePolicy("readonly-evidence", authority.descriptor.runtimePolicy);
    if (authority.descriptor.runtimeMode !== "readonly-evidence") {
      fail("CANDIDATE_RUNTIME_ATTESTATION_READONLY_POLICY_REQUIRED");
    }
    const challenge = parseChallenge(
      Array.isArray(rawChallenge) ? rawChallenge[0] : rawChallenge,
    );
    const contractRevision = request.headers[
      CANDIDATE_SIGNED_READ_CONTRACT_REVISION_HEADER
    ];
    if (
      (Array.isArray(contractRevision)
        ? contractRevision[0]
        : contractRevision) !== CANDIDATE_SIGNED_READ_CONTRACT_REVISION
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_READ_CONTRACT_REVISION_INVALID");
    }
    const method = normalizeRequestMethod(request.method);
    const requestTarget = normalizeRequestTarget(
      request.originalUrl || request.url,
    );
    const projection = resolveCandidateSignedReadContract({
      method,
      requestTarget,
      ...(method === "POST" ? { requestBody: request.body } : {}),
    });
    if (
      authority.consumedReadChallenges.has(challenge)
      || authority.consumedReadChallenges.size >= MAX_CONSUMED_CHALLENGES
    ) {
      fail("CANDIDATE_RUNTIME_ATTESTATION_READ_CHALLENGE_REPLAYED");
    }
    authority.consumedReadChallenges.add(challenge);
    let wroteBody = false;
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    response.write = ((...args: unknown[]) => {
      wroteBody = true;
      return (originalWrite as (...values: unknown[]) => boolean)(...args);
    }) as typeof response.write;
    response.end = ((
      chunk?: unknown,
      encoding?: unknown,
      callback?: unknown,
    ) => {
      if (typeof chunk === "function") {
        callback = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }
      if (wroteBody || response.headersSent) {
        return (originalEnd as (...values: unknown[]) => Response)(
          chunk,
          encoding,
          callback,
        );
      }
      const body = endBodyBytes(chunk, encoding);
      if (body === null) {
        response.statusCode = 500;
        return (originalEnd as (...values: unknown[]) => Response)(
          JSON.stringify({
            code: "CANDIDATE_RUNTIME_ATTESTATION_READ_BODY_INVALID",
          }),
          "utf8",
          callback,
        );
      }
      try {
        const proof = signCandidateRuntimeReadResponse({
          authority,
          challenge,
          method,
          requestTarget,
          requestBody: request.body,
          status: response.statusCode,
          contentType: String(response.getHeader("content-type") || ""),
          body,
          projection,
        });
        response.setHeader(
          CANDIDATE_RUNTIME_READ_AUTHORITY_HEADER,
          proof.authorityBinding,
        );
        response.setHeader(
          CANDIDATE_RUNTIME_READ_BODY_SHA256_HEADER,
          proof.bodySha256,
        );
        response.setHeader(
          CANDIDATE_RUNTIME_READ_SIGNATURE_HEADER,
          proof.signatureBase64Url,
        );
      } catch (error) {
        response.statusCode = 500;
        response.removeHeader("content-length");
        response.removeHeader("content-encoding");
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.removeHeader(CANDIDATE_RUNTIME_READ_AUTHORITY_HEADER);
        response.removeHeader(CANDIDATE_RUNTIME_READ_BODY_SHA256_HEADER);
        response.removeHeader(CANDIDATE_RUNTIME_READ_SIGNATURE_HEADER);
        const code = error instanceof CandidateRuntimeAttestationError
          ? error.code
          : "CANDIDATE_RUNTIME_ATTESTATION_READ_SIGN_FAILED";
        return (originalEnd as (...values: unknown[]) => Response)(
          JSON.stringify({ code }),
          "utf8",
          callback,
        );
      }
      return (originalEnd as (...values: unknown[]) => Response)(
        chunk,
        encoding,
        callback,
      );
    }) as typeof response.end;
    next();
  } catch (error) {
    const code = error instanceof CandidateRuntimeAttestationError
      ? error.code
      : "CANDIDATE_RUNTIME_ATTESTATION_READ_UNAVAILABLE";
    response.status(409).send({ code });
  }
}

function requestAuthorityMatchesSession(
  request: Request,
  authority: InstalledAuthority,
): boolean {
  const auth = (request as Request & {
    auth?: {
      user?: { id?: unknown };
      workspaceId?: unknown;
      token?: unknown;
    };
  }).auth;
  const token = String(auth?.token || "").replace(/^Bearer\s+/i, "").trim();
  const actualTokenSha256 = crypto.createHash("sha256")
    .update(token, "utf8").digest();
  return Number(auth?.user?.id) === authority.expectedUserId
    && String(auth?.workspaceId || "") === authority.expectedWorkspaceId
    && token.length >= 16
    && crypto.timingSafeEqual(
      actualTokenSha256,
      authority.expectedTokenSha256,
  );
}

/**
 * One-shot bridge from the root-owned FD4 bootstrap into the in-process
 * authority.  Merely installing an artifact-bound authority is insufficient:
 * the formal Linux bootstrap must also prove ownership of the fixed relay and
 * bind the exact child environment before any candidate-only HTTP surface can
 * become visible.
 */
export function bindFormalCandidateRuntimeSurfaceProof(input: Readonly<{
  authority: CandidateRuntimeAuthority;
  formalBootstrapOwnershipVerified: true;
  bootstrapBinding: string;
  environmentBinding: string;
  releaseManifestPayloadSha256: string;
  exactAuthorizationTrustBundle:
    FormalCandidateExactAuthorizationTrustBundle;
}>): void {
  const authority = installedAuthority;
  if (
    !authority
    || !authority.active
    || authority.installationProfile !== "formal-artifact"
    || authority.formalSurfaceProof
    || input.authority !== authority.publicAuthority
    || input.formalBootstrapOwnershipVerified !== true
    || !BINDING_PATTERN.test(input.bootstrapBinding)
    || !BINDING_PATTERN.test(input.environmentBinding)
    || !BINDING_PATTERN.test(input.releaseManifestPayloadSha256)
    || authority.descriptor.runtimeMode !== "candidate"
    || authority.descriptor.artifactExecutionBinding === null
    || !authority.exactAuthorizationSession
    || authority.environment !== process.env
  ) {
    fail("CANDIDATE_RUNTIME_FORMAL_SURFACE_PROOF_INVALID");
  }
  assertInstalledAuthorityCurrent(authority);
  const exactAuthorizationTrustBundle =
    parseFormalCandidateExactAuthorizationTrustBundle(
      input.exactAuthorizationTrustBundle,
      authority.exactAuthorizationSession.candidateIdentity.attestationKeyId,
    );
  const proof = {
    bootstrapBinding: input.bootstrapBinding,
    environmentBinding: input.environmentBinding,
    releaseManifestPayloadSha256: input.releaseManifestPayloadSha256,
    persistentEnvironment: formalRuntimePersistentEnvironment(
      authority.environment,
    ),
    exactAuthorizationTrustBundle,
    exactAuthorizationTrustEnvironment:
      candidateExactAuthorizationTrustEnvironment(
        exactAuthorizationTrustBundle,
      ),
  };
  authority.formalSurfaceProof = proof;
  try {
    assertFormalRuntimeSurfaceEnvironmentCurrent(authority);
  } catch (error) {
    authority.formalSurfaceProof = null;
    throw error;
  }
}

/**
 * Returns a session only after the formal FD4/bootstrap proof has been bound
 * to the exact immutable artifact authority.  This is the single gate used by
 * production candidate-only capture, quote and failpoint routes.
 */
export function formalCandidateRuntimeSessionForRequest(
  request: Request,
): CandidateExactAuthorizationRuntimeSession | null {
  return formalCandidateRuntimeSurfaceForRequest(request)?.session ?? null;
}

export function formalCandidateRuntimeSurfaceForRequest(
  request: Request,
): FormalCandidateRuntimeSurfaceContext | null {
  const authority = installedAuthority;
  if (
    !authority
    || authority.installationProfile !== "formal-artifact"
    || !authority.formalSurfaceProof
    || authority.descriptor.runtimeMode !== "candidate"
    || authority.descriptor.artifactExecutionBinding === null
    || !authority.exactAuthorizationSession
    || !requestAuthorityMatchesSession(request, authority)
  ) return null;
  try {
    assertInstalledAuthorityCurrent(authority);
    return Object.freeze({
      session: authority.exactAuthorizationSession,
      exactAuthorizationTrustEnvironment:
        authority.formalSurfaceProof.exactAuthorizationTrustEnvironment,
    });
  } catch {
    return null;
  }
}

/**
 * Returns the exact, process-bound authorization session only for the request
 * that owns the installed candidate authority.  Ordinary production and
 * readonly-evidence processes intentionally resolve to null, which keeps the
 * internal quote-capture surface fail-closed and invisible by default.
 */
export function candidateExactAuthorizationRuntimeSessionForRequest(
  request: Request,
): CandidateExactAuthorizationRuntimeSession | null {
  const authority = installedAuthority;
  if (
    !authority
    || authority.descriptor.runtimeMode !== "candidate"
    || !authority.exactAuthorizationSession
    || !requestAuthorityMatchesSession(request, authority)
  ) return null;
  try {
    assertInstalledAuthorityCurrent(authority);
    return authority.exactAuthorizationSession;
  } catch {
    return null;
  }
}

export function candidateRuntimeAttestationHandler(
  request: Request,
  response: Response,
  _next?: NextFunction,
): void {
  const authority = installedAuthority;
  if (!authority || !requestAuthorityMatchesSession(request, authority)) {
    response.status(404).send({ code: "NOT_FOUND" });
    return;
  }
  try {
    const challenge = parseChallenge(request.query.challenge);
    const proof = answerInstalledAuthorityChallenge(authority, challenge);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.status(200).send(proof);
  } catch (error) {
    const code = error instanceof CandidateRuntimeAttestationError
      ? error.code
      : "CANDIDATE_RUNTIME_ATTESTATION_UNAVAILABLE";
    const status = code.endsWith("CHALLENGE_INVALID") ? 400 : 409;
    response.status(status).send({ code });
  }
}

export function candidateRuntimeAttestationSelfCheckReport() {
  return {
    version: CANDIDATE_RUNTIME_ATTESTATION_VERSION,
    endpoint: CANDIDATE_RUNTIME_ATTESTATION_PATH,
    installedByDefault: false,
    endpointVisibleWithoutInstalledAuthority: false,
    sessionAuthorized: true,
    checkpointBinding: true,
    sessionBinding: true,
    databaseIdentity: {
      ordinaryRuntime:
        "owned-0600-opened-dev-ino-size-full-file-sha256-path-binding",
      exactAuthorizationCandidate:
        "owned-0600-opened-dev-ino-business-projection-sha256-path-binding",
      allowedOperationalRowTables:
        [...EXACT_AUTHORIZATION_OPERATIONAL_ROW_TABLES],
      operationalTableSchemaMutable: false,
    },
    apiProcessIdentity: "pid-start-time-256-bit-start-nonce",
    challengeProof: "single-use-ed25519-process-memory-private-key",
    readResponseProof:
      "single-use-ed25519-method-target-filter-status-content-type-body",
    privateKeyPersisted: false,
    readonlyEvidenceRequires: {
      recoveryOnly: true,
      workerDisabled: true,
      submissionWorkersDisabled: true,
    },
  };
}
