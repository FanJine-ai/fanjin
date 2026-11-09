import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_VERSION,
  CANDIDATE_RUNTIME_ATTESTATION_FILE,
  bindFormalCandidateRuntimeSurfaceProof,
  installFormalArtifactCandidateRuntimeAuthority,
  type CandidateRuntimeArtifactExecutionBinding,
  type CandidateRuntimeAuthority,
} from "./candidateRuntimeAttestation";
import {
  candidateExactAuthorizationCanonicalJson,
  candidateExactAuthorizationSessionBinding,
  parseFormalCandidatePrelaunchSessionIdentity,
  type CandidateExactAuthorizationRuntimeSession,
} from "./candidateExactAuthorizationCanonical";
import {
  parseFormalCandidateExactAuthorizationTrustBundle,
  type FormalCandidateExactAuthorizationTrustBundle,
} from "./candidateExactAuthorizationTrust";
import {
  disposeFormalCandidateCredentialRuntime,
  initializeFormalCandidateCredentialRuntime,
} from "./formalCandidateCredentialRuntime";
import {
  formalCandidateRuntimeArtifactIdentityDigest,
} from "./formalCandidateRuntimeIdentity";

export const FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FORMAT =
  "fanjin-formal-candidate-runtime-bootstrap/v1" as const;
export const FORMAL_CANDIDATE_RUNTIME_READINESS_FORMAT =
  "fanjin-formal-candidate-runtime-readiness/v1" as const;
export const FORMAL_CANDIDATE_RUNTIME_ENTRYPOINT_MANIFEST_PATH =
  "app/build/formal-candidate-runtime-entrypoint.js" as const;
export const FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD = 4 as const;
export const FORMAL_CANDIDATE_RUNTIME_READINESS_FD = 5 as const;
export const FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_ENV =
  "FANJIN_FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD" as const;
export const FORMAL_CANDIDATE_RUNTIME_READINESS_FD_ENV =
  "FANJIN_FORMAL_CANDIDATE_RUNTIME_READINESS_FD" as const;

const MAX_BOOTSTRAP_BYTES = 128 * 1024;
const BOOTSTRAP_FILE_MODE = 0o400;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_BINDING_PATTERN = /^sha256:[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUNTIME_CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_RUNTIME_CAPABILITIES = 64;
const SAFE_MANIFEST_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\/@+-]+(?:\/[A-Za-z0-9._\/@+-]+)*$/;
const ENVIRONMENT_BINDING_DOMAIN =
  "fanjin-formal-candidate-runtime-bootstrap/v1/environment";
const BOOTSTRAP_BINDING_DOMAIN =
  "fanjin-formal-candidate-runtime-bootstrap/v1/bootstrap";
const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  "BABEL_ENV",
  "BABEL_REGISTER_CACHE_PATH",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "TSX_TSCONFIG_PATH",
  "TS_NODE_PROJECT",
  "TS_NODE_TRANSPILE_ONLY",
]);
const FORBIDDEN_ENVIRONMENT_PREFIXES = Object.freeze([
  "DYLD_",
  "LD_",
  "OPENSSL_",
]);

export class FormalCandidateRuntimeBootstrapError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "FormalCandidateRuntimeBootstrapError";
    this.code = code;
  }
}

export type FormalCandidateRuntimeBootstrap = Readonly<{
  format: typeof FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FORMAT;
  startNonce: string;
  environmentBinding: string;
  apiBaseUrl: string;
  checkpointDirectory: string;
  attestationDirectory: string;
  databaseFile: string;
  sessionBinding: string;
  checkpointBinding: string;
  expectedUserId: number;
  expectedWorkspaceId: string;
  expectedToken: string;
  exactAuthorizationSession: CandidateExactAuthorizationRuntimeSession;
  exactAuthorizationTrustBundle: FormalCandidateExactAuthorizationTrustBundle;
  releaseAttestationKeyId: string;
  releaseManifestPayloadSha256: string;
  runtimeCapabilities: readonly string[];
  expectedArtifactExecutionBinding: CandidateRuntimeArtifactExecutionBinding;
}>;

export type FormalCandidateRuntimeReadiness = Readonly<{
  format: typeof FORMAL_CANDIDATE_RUNTIME_READINESS_FORMAT;
  pid: number;
  startNonce: string;
  apiStartNonce: string;
  apiBaseUrl: string;
  authorityBinding: string;
  artifactExecutionBinding: CandidateRuntimeArtifactExecutionBinding;
  sessionBinding: string;
  checkpointBinding: string;
  bootstrapBinding: string;
}>;

export type FormalCandidateRuntimeController = Readonly<{
  readiness: FormalCandidateRuntimeReadiness;
  authority: CandidateRuntimeAuthority;
  stop: () => Promise<void>;
}>;

export function waitForFormalCandidateRuntimeShutdownSignal(
  controller: Pick<FormalCandidateRuntimeController, "stop">,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let stopPromise: Promise<void> | null = null;
    const detach = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    };
    const stop = () => {
      if (stopPromise) return;
      // Install the idempotency barrier before invoking asynchronous cleanup.
      // Both listeners intentionally remain active until that cleanup settles,
      // so repeated service-manager signals cannot restore default termination.
      stopPromise = Promise.resolve().then(() => controller.stop());
      void stopPromise.then(
        () => {
          detach();
          resolve(0);
        },
        (error) => {
          detach();
          reject(error);
        },
      );
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

type FormalCandidateApplication = Readonly<{
  start: () => Promise<number>;
  stop: () => Promise<void>;
}>;

function fail(code: string): never {
  throw new FormalCandidateRuntimeBootstrapError(code);
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

function parseRuntimeCapabilities(value: unknown): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > MAX_RUNTIME_CAPABILITIES
    || value.some((entry) => (
      typeof entry !== "string" || !RUNTIME_CAPABILITY_PATTERN.test(entry)
    ))
    || new Set(value).size !== value.length
  ) return fail("FORMAL_CANDIDATE_RUNTIME_CAPABILITIES_INVALID");
  const sorted = [...value].sort((left, right) => left.localeCompare(right, "en"));
  if (sorted.some((entry, index) => entry !== value[index])) {
    return fail("FORMAL_CANDIDATE_RUNTIME_CAPABILITIES_INVALID");
  }
  return Object.freeze(sorted);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalEnvironment(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    // macOS injects this locale/console metadata during posix_spawn even when
    // the parent supplied an exact env vector.  It has no loader semantics;
    // Linux formal runs keep every environment entry in the binding.
    .filter(([key]) => !(
      process.platform === "darwin" && key === "__CF_USER_TEXT_ENCODING"
    ))
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  return Object.freeze(Object.fromEntries(entries));
}

export function formalCandidateRuntimeEnvironmentBinding(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): string {
  return `sha256:${sha256([
    ENVIRONMENT_BINDING_DOMAIN,
    candidateExactAuthorizationCanonicalJson(canonicalEnvironment(environment)),
  ].join("\0"))}`;
}

/** Pure fixed child environment shared by the launcher and prelaunch planner. */
export function buildFormalCandidateRuntimeChildEnvironment(input: Readonly<{
  releaseRoot: string;
  manifestPayloadSha256: string;
  bootstrap: FormalCandidateRuntimeBootstrap;
  sourceEnvironment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
}>): NodeJS.ProcessEnv {
  if (
    !path.isAbsolute(input.releaseRoot)
    || path.normalize(input.releaseRoot) !== input.releaseRoot
    || !SHA256_PATTERN.test(input.manifestPayloadSha256)
  ) return fail("FORMAL_CANDIDATE_RUNTIME_ENVIRONMENT_INVALID");
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "TZ", "TMPDIR"] as const) {
    const value = input.sourceEnvironment[key];
    if (typeof value === "string" && value.length > 0) inherited[key] = value;
  }
  return {
    ...inherited,
    NODE_ENV: "prod",
    FANJIN_APP_ROOT: path.join(input.releaseRoot, "app"),
    FANJIN_FORMAL_CANDIDATE_RUNTIME: "1",
    FANJIN_DISABLE_AUTO_START: "1",
    FANJIN_DISABLE_LOCAL_ENV: "1",
    FANJIN_LOAD_LOCAL_ENV_IN_TESTS: "0",
    FANJIN_DISABLE_LOCAL_KEYCHAIN_SECRETS: "1",
    FANJIN_BIND_HOST: "127.0.0.1",
    FANJIN_APP_PORT: new URL(input.bootstrap.apiBaseUrl).port,
    FANJIN_DATA_DIR: input.bootstrap.checkpointDirectory,
    FANJIN_DATABASE_CLIENT: "sqlite",
    FANJIN_RECOVERY_ONLY_MODE: "0",
    FANJIN_CANDIDATE_RUNTIME_LOG_PROJECTION: "redacted-v1",
    FANJIN_FORMAL_CANDIDATE_MANIFEST_PAYLOAD_SHA256:
      input.manifestPayloadSha256,
    [FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_ENV]:
      String(FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD),
    [FORMAL_CANDIDATE_RUNTIME_READINESS_FD_ENV]:
      String(FORMAL_CANDIDATE_RUNTIME_READINESS_FD),
  };
}

function parseApiBaseUrl(value: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return fail("FORMAL_CANDIDATE_RUNTIME_API_URL_INVALID");
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
    return fail("FORMAL_CANDIDATE_RUNTIME_API_URL_INVALID");
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return fail("FORMAL_CANDIDATE_RUNTIME_API_URL_INVALID");
  }
  return `http://127.0.0.1:${port}/api`;
}

function exactAbsolutePath(value: unknown, code: string): string {
  const resolved = String(value || "");
  if (!path.isAbsolute(resolved) || path.normalize(resolved) !== resolved) {
    return fail(code);
  }
  return resolved;
}

function parseArtifactExecutionBinding(
  value: unknown,
): CandidateRuntimeArtifactExecutionBinding {
  if (!isRecord(value) || !exactKeys(value, [
    "artifactSignedManifestSha256",
    "byteSize",
    "manifestPath",
    "sha256",
    "version",
  ])) {
    return fail("FORMAL_CANDIDATE_RUNTIME_ARTIFACT_BINDING_INVALID");
  }
  if (
    value.version !== CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_VERSION
    || !SHA256_PATTERN.test(String(value.artifactSignedManifestSha256 || ""))
    || value.manifestPath !== FORMAL_CANDIDATE_RUNTIME_ENTRYPOINT_MANIFEST_PATH
    || !SAFE_MANIFEST_PATH_PATTERN.test(String(value.manifestPath || ""))
    || !SHA256_PATTERN.test(String(value.sha256 || ""))
    || !Number.isSafeInteger(value.byteSize)
    || Number(value.byteSize) < 1
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_ARTIFACT_BINDING_INVALID");
  }
  return Object.freeze({
    version: CANDIDATE_RUNTIME_ARTIFACT_EXECUTION_BINDING_VERSION,
    artifactSignedManifestSha256: String(value.artifactSignedManifestSha256),
    manifestPath: FORMAL_CANDIDATE_RUNTIME_ENTRYPOINT_MANIFEST_PATH,
    sha256: String(value.sha256),
    byteSize: Number(value.byteSize),
  });
}

export function parseFormalCandidateRuntimeBootstrap(
  value: unknown,
): FormalCandidateRuntimeBootstrap {
  if (!isRecord(value) || !exactKeys(value, [
    "apiBaseUrl",
    "attestationDirectory",
    "checkpointBinding",
    "checkpointDirectory",
    "databaseFile",
    "environmentBinding",
    "exactAuthorizationSession",
    "exactAuthorizationTrustBundle",
    "expectedArtifactExecutionBinding",
    "expectedToken",
    "expectedUserId",
    "expectedWorkspaceId",
    "format",
    "releaseAttestationKeyId",
    "releaseManifestPayloadSha256",
    "runtimeCapabilities",
    "sessionBinding",
    "startNonce",
  ])) {
    return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_INVALID");
  }
  if (
    value.format !== FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FORMAT
    || !NONCE_PATTERN.test(String(value.startNonce || ""))
    || !SHA256_BINDING_PATTERN.test(String(value.environmentBinding || ""))
    || !SHA256_BINDING_PATTERN.test(String(value.sessionBinding || ""))
    || !NONCE_PATTERN.test(String(value.checkpointBinding || ""))
    || !Number.isSafeInteger(value.expectedUserId)
    || Number(value.expectedUserId) <= 0
    || typeof value.expectedWorkspaceId !== "string"
    || !value.expectedWorkspaceId
    || value.expectedWorkspaceId !== value.expectedWorkspaceId.trim()
    || typeof value.expectedToken !== "string"
    || value.expectedToken.length < 16
    || value.expectedToken.length > 16 * 1024
    || typeof value.releaseAttestationKeyId !== "string"
    || !KEY_ID_PATTERN.test(value.releaseAttestationKeyId)
    || value.releaseAttestationKeyId.startsWith("dev-local-only-")
    || typeof value.releaseManifestPayloadSha256 !== "string"
    || !SHA256_BINDING_PATTERN.test(value.releaseManifestPayloadSha256)
    || !isRecord(value.exactAuthorizationSession)
    || !exactKeys(value.exactAuthorizationSession, [
      "candidateIdentity",
      "createdAt",
      "projectId",
      "userId",
      "workspaceId",
    ])
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_INVALID");
  }
  const sessionValue = value.exactAuthorizationSession;
  const session = Object.freeze({
    workspaceId: String(sessionValue.workspaceId || ""),
    projectId: Number(sessionValue.projectId),
    userId: Number(sessionValue.userId),
    createdAt: String(sessionValue.createdAt || ""),
    candidateIdentity: parseFormalCandidatePrelaunchSessionIdentity(
      sessionValue.candidateIdentity,
    ),
  });
  let derivedSessionBinding: string;
  try {
    derivedSessionBinding = candidateExactAuthorizationSessionBinding(session);
  } catch {
    return fail("FORMAL_CANDIDATE_RUNTIME_SESSION_INVALID");
  }
  if (
    derivedSessionBinding !== value.sessionBinding
    || session.userId !== value.expectedUserId
    || session.workspaceId !== value.expectedWorkspaceId
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_SESSION_INVALID");
  }
  const expectedArtifactExecutionBinding = parseArtifactExecutionBinding(
    value.expectedArtifactExecutionBinding,
  );
  const runtimeCapabilities = parseRuntimeCapabilities(value.runtimeCapabilities);
  if (
    expectedArtifactExecutionBinding.artifactSignedManifestSha256
      !== session.candidateIdentity.artifactSignedManifestSha256
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_ARTIFACT_BINDING_INVALID");
  }
  let exactAuthorizationTrustBundle: FormalCandidateExactAuthorizationTrustBundle;
  try {
    exactAuthorizationTrustBundle =
      parseFormalCandidateExactAuthorizationTrustBundle(
        value.exactAuthorizationTrustBundle,
        value.releaseAttestationKeyId,
      );
  } catch {
    return fail("FORMAL_CANDIDATE_RUNTIME_TRUST_BUNDLE_INVALID");
  }
  const checkpointDirectory = exactAbsolutePath(
    value.checkpointDirectory,
    "FORMAL_CANDIDATE_RUNTIME_CHECKPOINT_PATH_INVALID",
  );
  const attestationDirectory = exactAbsolutePath(
    value.attestationDirectory,
    "FORMAL_CANDIDATE_RUNTIME_ATTESTATION_PATH_INVALID",
  );
  const databaseFile = exactAbsolutePath(
    value.databaseFile,
    "FORMAL_CANDIDATE_RUNTIME_DATABASE_PATH_INVALID",
  );
  if (databaseFile !== path.join(checkpointDirectory, "db2.sqlite")) {
    return fail("FORMAL_CANDIDATE_RUNTIME_DATABASE_PATH_INVALID");
  }
  return Object.freeze({
    format: FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FORMAT,
    startNonce: String(value.startNonce),
    environmentBinding: String(value.environmentBinding),
    apiBaseUrl: parseApiBaseUrl(value.apiBaseUrl),
    checkpointDirectory,
    attestationDirectory,
    databaseFile,
    sessionBinding: derivedSessionBinding,
    checkpointBinding: String(value.checkpointBinding),
    expectedUserId: Number(value.expectedUserId),
    expectedWorkspaceId: String(value.expectedWorkspaceId),
    expectedToken: value.expectedToken,
    exactAuthorizationSession: session,
    exactAuthorizationTrustBundle,
    releaseAttestationKeyId: value.releaseAttestationKeyId,
    releaseManifestPayloadSha256: value.releaseManifestPayloadSha256,
    runtimeCapabilities,
    expectedArtifactExecutionBinding,
  });
}

export function renderFormalCandidateRuntimeBootstrap(
  value: FormalCandidateRuntimeBootstrap,
): string {
  return `${candidateExactAuthorizationCanonicalJson(
    parseFormalCandidateRuntimeBootstrap(value),
  )}\n`;
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
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

type BootstrapOwnershipProfile = "formal-linux-root" | "local-contract-test";

function assertBootstrapDescriptor(
  descriptor: number,
  profile: BootstrapOwnershipProfile,
): fs.BigIntStats {
  const fileStat = fs.fstatSync(descriptor, { bigint: true });
  const currentUid = typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : 0n;
  const expectedUid = profile === "formal-linux-root" ? 0n : currentUid;
  if (
    !fileStat.isFile()
    || fileStat.nlink !== 1n
    || (fileStat.mode & 0o777n) !== BigInt(BOOTSTRAP_FILE_MODE)
    || fileStat.size < 2n
    || fileStat.size > BigInt(MAX_BOOTSTRAP_BYTES)
    || fileStat.uid !== expectedUid
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FILE_UNSAFE");
  }
  return fileStat;
}

function readBootstrapDescriptorAtPositionZero(
  descriptor: number,
  byteSize: number,
): Buffer {
  const bytes = Buffer.allocUnsafe(byteSize);
  let offset = 0;
  while (offset < byteSize) {
    const count = fs.readSync(
      descriptor,
      bytes,
      offset,
      byteSize - offset,
      offset,
    );
    if (count <= 0) {
      return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_CHANGED");
    }
    offset += count;
  }
  return bytes;
}

function assertFixedEnvironment(
  bootstrap: FormalCandidateRuntimeBootstrap,
  environment: NodeJS.ProcessEnv,
): void {
  for (const [key, value] of Object.entries(environment)) {
    if (
      String(value || "").trim()
      && (
        FORBIDDEN_ENVIRONMENT_KEYS.has(key)
        || FORBIDDEN_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
      )
    ) {
      return fail("FORMAL_CANDIDATE_RUNTIME_ENVIRONMENT_INJECTION_FORBIDDEN");
    }
  }
  const port = new URL(bootstrap.apiBaseUrl).port;
  const exact: Readonly<Record<string, string>> = {
    NODE_ENV: "prod",
    FANJIN_FORMAL_CANDIDATE_RUNTIME: "1",
    FANJIN_DISABLE_AUTO_START: "1",
    FANJIN_DISABLE_LOCAL_ENV: "1",
    FANJIN_LOAD_LOCAL_ENV_IN_TESTS: "0",
    FANJIN_DISABLE_LOCAL_KEYCHAIN_SECRETS: "1",
    FANJIN_BIND_HOST: "127.0.0.1",
    FANJIN_APP_PORT: port,
    FANJIN_DATA_DIR: bootstrap.checkpointDirectory,
    FANJIN_DATABASE_CLIENT: "sqlite",
    FANJIN_RECOVERY_ONLY_MODE: "0",
    FANJIN_CANDIDATE_RUNTIME_LOG_PROJECTION: "redacted-v1",
    FANJIN_FORMAL_CANDIDATE_MANIFEST_PAYLOAD_SHA256:
      bootstrap.releaseManifestPayloadSha256.replace(/^sha256:/u, ""),
    [FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_ENV]:
      String(FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD),
    [FORMAL_CANDIDATE_RUNTIME_READINESS_FD_ENV]:
      String(FORMAL_CANDIDATE_RUNTIME_READINESS_FD),
  };
  if (
    Object.entries(exact).some(([key, value]) => environment[key] !== value)
    || String(environment.FANJIN_FORMAL_CANDIDATE_LAUNCHED || "")
    || String(environment.FANJIN_FORMAL_CANDIDATE_READINESS_FD || "")
    || String(environment.FANJIN_FORMAL_CANDIDATE_READINESS_NONCE || "")
    || formalCandidateRuntimeEnvironmentBinding(environment)
      !== bootstrap.environmentBinding
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_ENVIRONMENT_INVALID");
  }
}

function readFormalCandidateRuntimeBootstrapFromFixedFdWithOwnership(
  ownershipProfile: BootstrapOwnershipProfile,
): FormalCandidateRuntimeBootstrap {
  const environment = process.env;
  if (
    environment[FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_ENV]
      !== String(FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD)
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_INVALID");
  }
  try {
    const before = assertBootstrapDescriptor(
      FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD,
      ownershipProfile,
    );
    const bytes = readBootstrapDescriptorAtPositionZero(
      FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD,
      Number(before.size),
    );
    const afterDescriptor = fs.fstatSync(
      FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD,
      { bigint: true },
    );
    if (
      !sameFile(before, afterDescriptor)
      || bytes.byteLength !== Number(before.size)
    ) {
      return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_CHANGED");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_JSON_INVALID");
    }
    const bootstrap = parseFormalCandidateRuntimeBootstrap(parsed);
    if (renderFormalCandidateRuntimeBootstrap(bootstrap) !== bytes.toString("utf8")) {
      return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_NON_CANONICAL");
    }
    assertFixedEnvironment(bootstrap, environment);
    return bootstrap;
  } catch (error) {
    if (error instanceof FormalCandidateRuntimeBootstrapError) throw error;
    return fail("FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_READ_FAILED");
  } finally {
    try { fs.closeSync(FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD); } catch { /* closed */ }
    delete environment[FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_ENV];
  }
}

/** Formal executable path: the root launcher owns the directory and file;
 * runtimeGid receives traverse/read only and cannot chmod, replace or relink
 * either object. */
export function readFormalCandidateRuntimeBootstrapFromFixedFd():
FormalCandidateRuntimeBootstrap {
  if (process.platform !== "linux") {
    return fail("FORMAL_CANDIDATE_RUNTIME_PLATFORM_INVALID");
  }
  return readFormalCandidateRuntimeBootstrapFromFixedFdWithOwnership(
    "formal-linux-root",
  );
}

/** Non-authorizing local parser seam used on macOS/CI where tests cannot chown
 * fixtures to root.  The signed CLI never calls or references this function. */
export function readFormalCandidateRuntimeBootstrapFromFixedFdForCurrentUidContractTest():
FormalCandidateRuntimeBootstrap {
  return readFormalCandidateRuntimeBootstrapFromFixedFdWithOwnership(
    "local-contract-test",
  );
}

function bootstrapBinding(bootstrap: FormalCandidateRuntimeBootstrap): string {
  return `sha256:${sha256([
    BOOTSTRAP_BINDING_DOMAIN,
    candidateExactAuthorizationCanonicalJson({
      ...bootstrap,
      expectedToken: `sha256:${sha256(bootstrap.expectedToken)}`,
    }),
  ].join("\0"))}`;
}

export function buildFormalCandidateRuntimeReadiness(input: Readonly<{
  bootstrap: FormalCandidateRuntimeBootstrap;
  authority: CandidateRuntimeAuthority;
}>): FormalCandidateRuntimeReadiness {
  const descriptor = input.authority.descriptor;
  if (
    descriptor.apiPid !== process.pid
    || descriptor.apiBaseUrl !== input.bootstrap.apiBaseUrl
    || descriptor.sessionBinding !== input.bootstrap.sessionBinding
    || descriptor.checkpointBinding !== input.bootstrap.checkpointBinding
    || descriptor.artifactExecutionBinding === null
    || candidateExactAuthorizationCanonicalJson(descriptor.artifactExecutionBinding)
      !== candidateExactAuthorizationCanonicalJson(
        input.bootstrap.expectedArtifactExecutionBinding,
      )
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_AUTHORITY_BINDING_MISMATCH");
  }
  return Object.freeze({
    format: FORMAL_CANDIDATE_RUNTIME_READINESS_FORMAT,
    pid: process.pid,
    startNonce: input.bootstrap.startNonce,
    apiStartNonce: descriptor.apiStartNonce,
    apiBaseUrl: descriptor.apiBaseUrl,
    authorityBinding: descriptor.authorityBinding,
    artifactExecutionBinding: descriptor.artifactExecutionBinding,
    sessionBinding: descriptor.sessionBinding,
    checkpointBinding: descriptor.checkpointBinding,
    bootstrapBinding: bootstrapBinding(input.bootstrap),
  });
}

export function emitFormalCandidateRuntimeReadiness(
  readiness: FormalCandidateRuntimeReadiness,
): void {
  if (
    process.env[FORMAL_CANDIDATE_RUNTIME_READINESS_FD_ENV]
      !== String(FORMAL_CANDIDATE_RUNTIME_READINESS_FD)
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_READINESS_FD_INVALID");
  }
  try {
    fs.writeSync(
      FORMAL_CANDIDATE_RUNTIME_READINESS_FD,
      `${candidateExactAuthorizationCanonicalJson(readiness)}\n`,
      null,
      "utf8",
    );
  } catch {
    return fail("FORMAL_CANDIDATE_RUNTIME_READINESS_WRITE_FAILED");
  } finally {
    try { fs.closeSync(FORMAL_CANDIDATE_RUNTIME_READINESS_FD); } catch { /* closed */ }
    delete process.env[FORMAL_CANDIDATE_RUNTIME_READINESS_FD_ENV];
  }
}

function trustedRuntimeOwner(uid: bigint): boolean {
  if (typeof process.getuid !== "function") return true;
  return uid === BigInt(process.getuid());
}

function removeOwnedAttestationFile(
  file: string,
  expected: fs.BigIntStats,
): void {
  try {
    const current = fs.lstatSync(file, { bigint: true });
    if (
      path.basename(file) !== CANDIDATE_RUNTIME_ATTESTATION_FILE
      || current.isSymbolicLink()
      || !current.isFile()
      || current.nlink !== 1n
      || (current.mode & 0o777n) !== 0o600n
      || !sameFile(current, expected)
      || !trustedRuntimeOwner(current.uid)
    ) {
      return fail("FORMAL_CANDIDATE_RUNTIME_ATTESTATION_CLEANUP_REFUSED");
    }
    fs.unlinkSync(file);
  } catch (error) {
    if (error instanceof FormalCandidateRuntimeBootstrapError) throw error;
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    return fail("FORMAL_CANDIDATE_RUNTIME_ATTESTATION_CLEANUP_FAILED");
  }
}

async function startFormalCandidateRuntimeBootstrapWithReader(
  loadFixedApplication: () => Promise<FormalCandidateApplication>,
  readBootstrap: () => FormalCandidateRuntimeBootstrap,
  initializeCredentialRuntime: boolean,
  bindFormalSurfaces: boolean,
): Promise<FormalCandidateRuntimeController> {
  const bootstrap = readBootstrap();
  let authority: CandidateRuntimeAuthority | null = null;
  let application: FormalCandidateApplication | null = null;
  let startAttempted = false;
  let attestationIdentity: fs.BigIntStats | null = null;
  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      let failure: unknown = null;
      if (startAttempted && application) {
        try { await application.stop(); } catch (error) { failure = error; }
      }
      authority?.dispose();
      if (initializeCredentialRuntime) {
        try { disposeFormalCandidateCredentialRuntime(); } catch (error) {
          failure ??= error;
        }
      }
      if (authority && attestationIdentity) {
        try {
          removeOwnedAttestationFile(authority.attestationFile, attestationIdentity);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    })();
    return stopPromise;
  };
  try {
    authority = installFormalArtifactCandidateRuntimeAuthority({
      checkpointDirectory: bootstrap.checkpointDirectory,
      attestationDirectory: bootstrap.attestationDirectory,
      databaseFile: bootstrap.databaseFile,
      apiBaseUrl: bootstrap.apiBaseUrl,
      sessionBinding: bootstrap.sessionBinding,
      checkpointBinding: bootstrap.checkpointBinding,
      expectedUserId: bootstrap.expectedUserId,
      expectedWorkspaceId: bootstrap.expectedWorkspaceId,
      expectedToken: bootstrap.expectedToken,
      exactAuthorizationSession: bootstrap.exactAuthorizationSession,
      expectedArtifactExecutionBinding:
        bootstrap.expectedArtifactExecutionBinding,
    });
    if (bindFormalSurfaces) {
      bindFormalCandidateRuntimeSurfaceProof({
        authority,
        formalBootstrapOwnershipVerified: true,
        bootstrapBinding: bootstrapBinding(bootstrap),
        environmentBinding: bootstrap.environmentBinding,
        releaseManifestPayloadSha256:
          bootstrap.releaseManifestPayloadSha256,
        exactAuthorizationTrustBundle:
          bootstrap.exactAuthorizationTrustBundle,
      });
    }
    if (initializeCredentialRuntime) {
      const runtimeUid = typeof process.getuid === "function"
        ? process.getuid()
        : 0;
      const runtimeGid = typeof process.getgid === "function"
        ? process.getgid()
        : 0;
      initializeFormalCandidateCredentialRuntime({
        sessionBinding: bootstrap.sessionBinding,
        candidateBinding: formalCandidateRuntimeArtifactIdentityDigest({
          candidateIdentity: bootstrap.exactAuthorizationSession.candidateIdentity,
          releaseAttestationKeyId: bootstrap.releaseAttestationKeyId,
          releaseManifestPayloadSha256:
            bootstrap.releaseManifestPayloadSha256,
          runtimeArtifact: bootstrap.expectedArtifactExecutionBinding,
          runtimeDescriptor: authority.descriptor,
        }),
        runtimeUid,
        runtimeGid,
        runtimeCapabilities: bootstrap.runtimeCapabilities,
      });
    }
    attestationIdentity = fs.lstatSync(authority.attestationFile, { bigint: true });
    application = await loadFixedApplication();
    startAttempted = true;
    const port = await application.start();
    if (String(port) !== new URL(bootstrap.apiBaseUrl).port) {
      return fail("FORMAL_CANDIDATE_RUNTIME_LISTENER_PORT_MISMATCH");
    }
    const readiness = buildFormalCandidateRuntimeReadiness({
      bootstrap,
      authority,
    });
    emitFormalCandidateRuntimeReadiness(readiness);
    return Object.freeze({ readiness, authority, stop });
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new FormalCandidateRuntimeBootstrapError(
        "FORMAL_CANDIDATE_RUNTIME_STARTUP_CLEANUP_FAILED",
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw error;
  }
}

export function startFormalCandidateRuntimeBootstrap(
  loadFixedApplication: () => Promise<FormalCandidateApplication>,
): Promise<FormalCandidateRuntimeController> {
  return startFormalCandidateRuntimeBootstrapWithReader(
    loadFixedApplication,
    readFormalCandidateRuntimeBootstrapFromFixedFd,
    true,
    true,
  );
}

/** Non-authorizing lifecycle seam for local tests.  It retains the real
 * immutable argv[1] authority installer and FD5 emitter; only FD4 ownership is
 * current-uid instead of root-owned. */
export function startFormalCandidateRuntimeBootstrapForCurrentUidContractTest(
  loadFixedApplication: () => Promise<FormalCandidateApplication>,
): Promise<FormalCandidateRuntimeController> {
  return startFormalCandidateRuntimeBootstrapWithReader(
    loadFixedApplication,
    readFormalCandidateRuntimeBootstrapFromFixedFdForCurrentUidContractTest,
    false,
    false,
  );
}
