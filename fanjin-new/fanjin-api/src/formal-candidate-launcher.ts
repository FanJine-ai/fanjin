import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  verifyReleaseArtifactAttestation,
} from "./lib/releaseArtifactAttestation";
import {
  FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD,
} from "./lib/formalCandidateCredentialCapability";
import {
  FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD,
  FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_ENV,
  FORMAL_CANDIDATE_RUNTIME_ENTRYPOINT_MANIFEST_PATH,
  FORMAL_CANDIDATE_RUNTIME_READINESS_FD,
  FORMAL_CANDIDATE_RUNTIME_READINESS_FD_ENV,
  FORMAL_CANDIDATE_RUNTIME_READINESS_FORMAT,
  FormalCandidateRuntimeBootstrapError,
  buildFormalCandidateRuntimeChildEnvironment,
  formalCandidateRuntimeEnvironmentBinding,
  parseFormalCandidateRuntimeBootstrap,
  renderFormalCandidateRuntimeBootstrap,
  type FormalCandidateRuntimeBootstrap,
  type FormalCandidateRuntimeReadiness,
} from "./lib/formalCandidateRuntimeBootstrap";

export { FORMAL_CANDIDATE_RUNTIME_READINESS_FORMAT } from "./lib/formalCandidateRuntimeBootstrap";

export const FORMAL_CANDIDATE_LAUNCHER_FORMAT =
  "fanjin-formal-candidate-launcher/v1" as const;
export const FORMAL_CANDIDATE_LAUNCH_PROOF_FORMAT =
  "fanjin-formal-candidate-launch-proof/v1" as const;
export const FORMAL_CANDIDATE_FULL_TREE_FORMAT =
  "fanjin-formal-candidate-full-tree/v1" as const;
export const FORMAL_CANDIDATE_NODE_RUNTIME_IDENTITY_FORMAT =
  "fanjin-node-runtime-identity/v1" as const;
export const FORMAL_CANDIDATE_LAUNCHER_MANIFEST_PATH =
  "app/build/formal-candidate-launcher.js" as const;
export const PRODUCTION_APPLICATION_MANIFEST_PATH =
  "app/build/app.js" as const;
export const FORMAL_CANDIDATE_APPLICATION_MANIFEST_PATH =
  FORMAL_CANDIDATE_RUNTIME_ENTRYPOINT_MANIFEST_PATH;
export const FORMAL_CANDIDATE_FULL_MATRIX_DRIVER_FORMAT =
  "fanjin-formal-candidate-full-matrix-driver/v1" as const;
export const FORMAL_CANDIDATE_FULL_MATRIX_DRIVER_MANIFEST_PATH =
  "app/build/formal-candidate-full-matrix-driver.js" as const;
export const FORMAL_CANDIDATE_BOUNDED_SOURCE_PREPARER_MANIFEST_PATH =
  "app/build/prepare-formal-candidate-bounded-source.js" as const;

const PROOF_SIGNATURE_DOMAIN =
  "fanjin-formal-candidate-launch-proof/v1/signature";
const RUNTIME_BOOTSTRAP_BINDING_DOMAIN =
  "fanjin-formal-candidate-runtime-bootstrap/v1/bootstrap";
const FORMAL_CANDIDATE_BOOTSTRAP_PATH_BINDING_ENV =
  "FANJIN_FORMAL_CANDIDATE_BOOTSTRAP_PATH_BINDING";
const ROOT_PATH_BINDING_DOMAIN =
  "fanjin-formal-candidate-launcher/v1/release-root";
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_PROOF_AGE_MS = 30_000;
const MAX_TREE_ENTRIES = 100_000;
const MAX_RUNTIME_BOOTSTRAP_BYTES = 128 * 1024;
const MAX_RUNTIME_PUBLIC_FAILURE_BYTES = 64 * 1024;
export const FORMAL_CANDIDATE_LAUNCHER_READINESS_TIMEOUT_MS = 60_000;
export const FORMAL_CANDIDATE_LAUNCHER_TERMINATION_GRACE_MS = 3_000;
const CHILD_STABLE_WINDOW_MS = 250;
const INJECTION_ENVIRONMENT_PREFIXES = Object.freeze([
  "DYLD_",
  "LD_",
  "NODE_",
  "OPENSSL_",
]);
const INJECTION_ENVIRONMENT_KEYS = new Set([
  "BABEL_ENV",
  "BABEL_REGISTER_CACHE_PATH",
  "ELECTRON_RUN_AS_NODE",
  "TSX_TSCONFIG_PATH",
  "TS_NODE_PROJECT",
  "TS_NODE_TRANSPILE_ONLY",
]);
const CHILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
] as const);

export class FormalCandidateLauncherError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "FormalCandidateLauncherError";
    this.code = code;
  }
}

export type FormalCandidatePinnedFileIdentity = Readonly<{
  manifestPath: string;
  dev: string;
  ino: string;
  byteSize: number;
  sha256: string;
  uid: number;
  gid: number;
  mode: number;
}>;

export type FormalCandidateTargetPlatform = Readonly<{
  os: string;
  arch: string;
  libc: string;
}>;

export type FormalCandidateNodeRuntimeIdentity = Readonly<{
  format: typeof FORMAL_CANDIDATE_NODE_RUNTIME_IDENTITY_FORMAT;
  executableRealpath: string;
  byteSize: number;
  sha256: string;
  version: string;
  nodeAbi: string;
  execArgv: readonly string[];
}>;

export type FormalCandidateAppReadiness = FormalCandidateRuntimeReadiness;

export type FormalCandidateBootstrapFdIdentity = Readonly<{
  dev: string;
  ino: string;
  byteSize: number;
  sha256: string;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
}>;

export type VerifiedFormalCandidateReleaseRoot = Readonly<{
  format: typeof FORMAL_CANDIDATE_LAUNCHER_FORMAT;
  releaseId: string;
  sourceCommit: string;
  releaseRoot: string;
  releaseRootDev: string;
  releaseRootIno: string;
  releaseRootUid: number;
  releaseRootPathBinding: string;
  fullTreeDigest: string;
  filesystemEvidenceClass:
    | "current-uid-readonly-transcript"
    | "root-owned-runtime-uid-separated-transcript";
  formalFilesystemOwnershipVerified: false;
  manifestFileSha256: string;
  manifestPayloadSha256: string;
  releaseAttestationKeyId: string;
  runtimeCapabilities: readonly string[];
  targetPlatform: FormalCandidateTargetPlatform;
  nodeRuntime: FormalCandidateNodeRuntimeIdentity;
  launcher: FormalCandidatePinnedFileIdentity;
  application: FormalCandidatePinnedFileIdentity;
  fullMatrixDriver: FormalCandidatePinnedFileIdentity;
  boundedSourcePreparer?: FormalCandidatePinnedFileIdentity;
}>;

export type FormalCandidateLaunchProof = Readonly<{
  format: typeof FORMAL_CANDIDATE_LAUNCH_PROOF_FORMAT;
  challenge: string;
  createdAt: string;
  releaseId: string;
  releaseRootPathBinding: string;
  fullTreeDigest: string;
  manifestFileSha256: string;
  manifestPayloadSha256: string;
  releaseAttestationKeyId: string;
  targetPlatform: FormalCandidateTargetPlatform;
  nodeRuntime: FormalCandidateNodeRuntimeIdentity;
  launcher: FormalCandidatePinnedFileIdentity;
  application: FormalCandidatePinnedFileIdentity;
  launcherPid: number;
  runtimeUid: number;
  runtimeGid: number;
  formalBootstrapOwnershipVerified: boolean;
  bootstrapPathBinding: string;
  bootstrapFdIdentity: FormalCandidateBootstrapFdIdentity;
  launcherStartNonce: string;
  childPid: number;
  childReadiness: FormalCandidateAppReadiness;
  childStableWindowMs: typeof CHILD_STABLE_WINDOW_MS;
  fixedCommand: Readonly<{
    executable: string;
    args: readonly [string];
    cwd: string;
  }>;
  proofProvenance: "ephemeral-self-signature-non-authorizing";
  publicKeySpkiBase64Url: string;
  signatureBase64Url: string;
}>;

function fail(code: string): never {
  throw new FormalCandidateLauncherError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_CANONICAL_VALUE_INVALID");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return fail("FORMAL_CANDIDATE_LAUNCHER_CANONICAL_VALUE_INVALID");
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
}

type BigIntStats = fs.BigIntStats;

function statNumber(value: bigint, code: string): number {
  const resolved = Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < 0) return fail(code);
  return resolved;
}

function trustedReadonlyOwner(metadata: BigIntStats): boolean {
  if (typeof process.getuid !== "function") return true;
  return metadata.uid === 0n || metadata.uid === BigInt(process.getuid());
}

function assertReadonlyDirectory(directory: string, code: string): BigIntStats {
  let metadata: BigIntStats;
  try {
    metadata = fs.lstatSync(directory, { bigint: true });
  } catch {
    return fail(code);
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (metadata.mode & 0o222n) !== 0n
    || fs.realpathSync(directory) !== directory
    || !trustedReadonlyOwner(metadata)
  ) {
    return fail(code);
  }
  return metadata;
}

function readPinnedReadonlyFile(input: Readonly<{
  releaseRoot: string;
  manifestPath: string;
  maximumBytes?: number;
}>): { bytes: Buffer; identity: FormalCandidatePinnedFileIdentity } {
  const target = path.join(input.releaseRoot, ...input.manifestPath.split("/"));
  if (
    path.relative(input.releaseRoot, target).startsWith(`..${path.sep}`)
    || path.isAbsolute(path.relative(input.releaseRoot, target))
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_PATH_ESCAPE");
  }
  let before: BigIntStats;
  let descriptor: number | null = null;
  try {
    before = fs.lstatSync(target, { bigint: true });
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1n
      || (before.mode & 0o222n) !== 0n
      || fs.realpathSync(target) !== target
      || !trustedReadonlyOwner(before)
      || (input.maximumBytes !== undefined
        && before.size > BigInt(input.maximumBytes))
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_FILE_SECURITY_INVALID");
    }
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeNs !== before.mtimeNs
      || opened.ctimeNs !== before.ctimeNs
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_FILE_CHANGED");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(target, { bigint: true });
    if (
      BigInt(bytes.byteLength) !== opened.size
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== opened.dev
      || pathAfter.ino !== opened.ino
      || pathAfter.size !== opened.size
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_FILE_CHANGED");
    }
    return {
      bytes,
      identity: Object.freeze({
        manifestPath: input.manifestPath,
        dev: opened.dev.toString(10),
        ino: opened.ino.toString(10),
        byteSize: statNumber(opened.size, "FORMAL_CANDIDATE_LAUNCHER_FILE_TOO_LARGE"),
        sha256: sha256(bytes),
        uid: statNumber(opened.uid, "FORMAL_CANDIDATE_LAUNCHER_FILE_SECURITY_INVALID"),
        gid: statNumber(opened.gid, "FORMAL_CANDIDATE_LAUNCHER_FILE_SECURITY_INVALID"),
        mode: statNumber(opened.mode & 0o7777n, "FORMAL_CANDIDATE_LAUNCHER_FILE_SECURITY_INVALID"),
      }),
    };
  } catch (error) {
    if (error instanceof FormalCandidateLauncherError) throw error;
    return fail("FORMAL_CANDIDATE_LAUNCHER_FILE_UNAVAILABLE");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function assertManifestFileMatches(
  entry: Record<string, unknown>,
  identity: FormalCandidatePinnedFileIdentity,
): void {
  if (
    entry.path !== identity.manifestPath
    || entry.size !== identity.byteSize
    || entry.sha256 !== identity.sha256
  ) {
    fail("FORMAL_CANDIDATE_LAUNCHER_SIGNED_FILE_MISMATCH");
  }
}

function pinnedIdentityMatches(
  value: unknown,
  expected: FormalCandidatePinnedFileIdentity,
): boolean {
  if (!isRecord(value) || !exactKeys(value, [
    "byteSize",
    "dev",
    "gid",
    "ino",
    "manifestPath",
    "mode",
    "sha256",
    "uid",
  ])) return false;
  return value.manifestPath === expected.manifestPath
    && value.dev === expected.dev
    && value.ino === expected.ino
    && value.byteSize === expected.byteSize
    && value.sha256 === expected.sha256
    && value.uid === expected.uid
    && value.gid === expected.gid
    && value.mode === expected.mode;
}

function parseTargetPlatform(value: unknown): FormalCandidateTargetPlatform {
  if (
    !isRecord(value)
    || !exactKeys(value, ["arch", "libc", "os"])
    || typeof value.os !== "string"
    || !/^[a-z0-9._-]{1,32}$/.test(value.os)
    || typeof value.arch !== "string"
    || !/^[a-z0-9._-]{1,32}$/.test(value.arch)
    || typeof value.libc !== "string"
    || !/^[a-z0-9._-]{1,32}$/.test(value.libc)
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_TARGET_PLATFORM_INVALID");
  }
  let runtimeLibc = "none";
  if (process.platform === "linux") {
    const report = process.report?.getReport() as unknown;
    const header = isRecord(report) && isRecord(report.header)
      ? report.header
      : null;
    runtimeLibc = typeof header?.glibcVersionRuntime === "string"
      && header.glibcVersionRuntime.length > 0
      ? "glibc"
      : "musl";
  }
  if (
    value.os !== process.platform
    || value.arch !== process.arch
    || value.libc !== runtimeLibc
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_TARGET_PLATFORM_MISMATCH");
  }
  return Object.freeze({ os: value.os, arch: value.arch, libc: value.libc });
}

function targetPlatformMatches(
  value: unknown,
  expected: FormalCandidateTargetPlatform,
): boolean {
  return isRecord(value)
    && exactKeys(value, ["arch", "libc", "os"])
    && value.os === expected.os
    && value.arch === expected.arch
    && value.libc === expected.libc;
}

function readCurrentNodeRuntimeIdentity(
  expectedExecArgv: readonly string[] = [],
): FormalCandidateNodeRuntimeIdentity {
  const executableRealpath = fs.realpathSync(process.execPath);
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(executableRealpath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_NODE_RUNTIME_INVALID");
    }
    descriptor = fs.openSync(
      executableRealpath,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeNs !== before.mtimeNs
      || opened.ctimeNs !== before.ctimeNs
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_NODE_RUNTIME_CHANGED");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(executableRealpath, { bigint: true });
    if (
      BigInt(bytes.byteLength) !== opened.size
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
      || pathAfter.dev !== opened.dev
      || pathAfter.ino !== opened.ino
      || pathAfter.size !== opened.size
      || pathAfter.mtimeNs !== opened.mtimeNs
      || pathAfter.ctimeNs !== opened.ctimeNs
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_NODE_RUNTIME_CHANGED");
    }
    return Object.freeze({
      format: FORMAL_CANDIDATE_NODE_RUNTIME_IDENTITY_FORMAT,
      executableRealpath,
      byteSize: statNumber(opened.size, "FORMAL_CANDIDATE_LAUNCHER_NODE_RUNTIME_INVALID"),
      sha256: sha256(bytes),
      version: process.version,
      nodeAbi: process.versions.modules,
      execArgv: Object.freeze([...expectedExecArgv]),
    });
  } catch (error) {
    if (error instanceof FormalCandidateLauncherError) throw error;
    return fail("FORMAL_CANDIDATE_LAUNCHER_NODE_RUNTIME_INVALID");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function nodeRuntimeIdentityMatches(
  value: unknown,
  expected: FormalCandidateNodeRuntimeIdentity,
): boolean {
  return isRecord(value)
    && exactKeys(value, [
      "byteSize",
      "execArgv",
      "executableRealpath",
      "format",
      "nodeAbi",
      "sha256",
      "version",
    ])
    && value.format === expected.format
    && value.executableRealpath === expected.executableRealpath
    && value.byteSize === expected.byteSize
    && value.sha256 === expected.sha256
    && value.version === expected.version
    && value.nodeAbi === expected.nodeAbi
    && Array.isArray(value.execArgv)
    && value.execArgv.length === expected.execArgv.length
    && value.execArgv.every((item, index) => item === expected.execArgv[index]);
}

type FullTreeVerification = Readonly<{
  digest: string;
  files: ReadonlyMap<string, FormalCandidatePinnedFileIdentity>;
}>;

function verifyExactSignedFullTree(input: Readonly<{
  releaseRoot: string;
  rootMetadata: BigIntStats;
  manifest: Record<string, unknown>;
}>): FullTreeVerification {
  if (!Array.isArray(input.manifest.files) || input.manifest.files.length < 1) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_MANIFEST_FILE_INVALID");
  }
  const expectedFiles = new Map<string, Record<string, unknown>>();
  const expectedDirectories = new Set<string>([""]);
  for (const value of input.manifest.files) {
    if (
      !isRecord(value)
      || !exactKeys(value, ["path", "sha256", "size"])
      || typeof value.path !== "string"
      || value.path === "release-manifest.json"
      || typeof value.size !== "number"
      || !Number.isSafeInteger(value.size)
      || value.size < 0
      || typeof value.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(value.sha256)
      || expectedFiles.has(value.path)
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_MANIFEST_FILE_INVALID");
    }
    expectedFiles.set(value.path, value);
    const segments = value.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  if (expectedFiles.size + expectedDirectories.size + 1 > MAX_TREE_ENTRIES) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_TREE_TOO_LARGE");
  }

  const observedDirectories: Array<Record<string, unknown>> = [];
  const observedFiles = new Map<string, FormalCandidatePinnedFileIdentity>();
  const pending = [""];
  let entryCount = 0;
  while (pending.length > 0) {
    const manifestDirectory = pending.pop()!;
    if (!expectedDirectories.has(manifestDirectory)) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_UNSIGNED_TREE_ENTRY");
    }
    const absoluteDirectory = manifestDirectory
      ? path.join(input.releaseRoot, ...manifestDirectory.split("/"))
      : input.releaseRoot;
    const metadata = assertReadonlyDirectory(
      absoluteDirectory,
      "FORMAL_CANDIDATE_LAUNCHER_TREE_DIRECTORY_SECURITY_INVALID",
    );
    if (metadata.dev !== input.rootMetadata.dev) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_CROSS_DEVICE_TREE_FORBIDDEN");
    }
    observedDirectories.push({
      manifestPath: manifestDirectory,
      dev: metadata.dev.toString(10),
      ino: metadata.ino.toString(10),
      uid: statNumber(metadata.uid, "FORMAL_CANDIDATE_LAUNCHER_TREE_DIRECTORY_SECURITY_INVALID"),
      gid: statNumber(metadata.gid, "FORMAL_CANDIDATE_LAUNCHER_TREE_DIRECTORY_SECURITY_INVALID"),
      mode: statNumber(metadata.mode & 0o7777n, "FORMAL_CANDIDATE_LAUNCHER_TREE_DIRECTORY_SECURITY_INVALID"),
    });
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_TREE_ENTRIES) {
        return fail("FORMAL_CANDIDATE_LAUNCHER_TREE_TOO_LARGE");
      }
      if (entry.name.includes("/") || entry.name === "." || entry.name === "..") {
        return fail("FORMAL_CANDIDATE_LAUNCHER_UNSIGNED_TREE_ENTRY");
      }
      const manifestPath = manifestDirectory
        ? `${manifestDirectory}/${entry.name}`
        : entry.name;
      const target = path.join(absoluteDirectory, entry.name);
      const lstat = fs.lstatSync(target, { bigint: true });
      if (lstat.isSymbolicLink()) {
        return fail("FORMAL_CANDIDATE_LAUNCHER_TREE_SYMLINK_FORBIDDEN");
      }
      if (lstat.isDirectory()) {
        if (!expectedDirectories.has(manifestPath)) {
          return fail("FORMAL_CANDIDATE_LAUNCHER_UNSIGNED_TREE_ENTRY");
        }
        pending.push(manifestPath);
        continue;
      }
      if (!lstat.isFile()) {
        return fail("FORMAL_CANDIDATE_LAUNCHER_TREE_ENTRY_UNSUPPORTED");
      }
      if (manifestPath === "release-manifest.json") continue;
      const expected = expectedFiles.get(manifestPath);
      if (!expected) {
        return fail("FORMAL_CANDIDATE_LAUNCHER_UNSIGNED_TREE_ENTRY");
      }
      const observed = readPinnedReadonlyFile({
        releaseRoot: input.releaseRoot,
        manifestPath,
      }).identity;
      assertManifestFileMatches(expected, observed);
      if (observed.dev !== input.rootMetadata.dev.toString(10)) {
        return fail("FORMAL_CANDIDATE_LAUNCHER_CROSS_DEVICE_TREE_FORBIDDEN");
      }
      observedFiles.set(manifestPath, observed);
    }
    const directoryAfter = fs.lstatSync(absoluteDirectory, { bigint: true });
    if (
      directoryAfter.isSymbolicLink()
      || !directoryAfter.isDirectory()
      || directoryAfter.dev !== metadata.dev
      || directoryAfter.ino !== metadata.ino
      || directoryAfter.mode !== metadata.mode
      || directoryAfter.uid !== metadata.uid
      || directoryAfter.gid !== metadata.gid
      || directoryAfter.mtimeNs !== metadata.mtimeNs
      || directoryAfter.ctimeNs !== metadata.ctimeNs
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_TREE_DIRECTORY_CHANGED");
    }
  }
  if (
    observedFiles.size !== expectedFiles.size
    || [...expectedFiles.keys()].some((manifestPath) => !observedFiles.has(manifestPath))
    || observedDirectories.length !== expectedDirectories.size
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_SIGNED_TREE_INCOMPLETE");
  }
  const canonicalFiles = [...observedFiles.values()]
    .sort((left, right) => left.manifestPath.localeCompare(right.manifestPath, "en"));
  observedDirectories.sort((left, right) => String(left.manifestPath)
    .localeCompare(String(right.manifestPath), "en"));
  return Object.freeze({
    digest: `sha256:${sha256(canonicalJson({
      format: FORMAL_CANDIDATE_FULL_TREE_FORMAT,
      directories: observedDirectories,
      files: canonicalFiles,
    }))}`,
    files: observedFiles,
  });
}

export function verifyFormalCandidateReleaseRoot(input: Readonly<{
  releaseRoot: string;
  launcherFile?: string;
  boundedSourcePreparerFile?: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}>): VerifiedFormalCandidateReleaseRoot {
  if (!path.isAbsolute(input.releaseRoot) || path.normalize(input.releaseRoot) !== input.releaseRoot) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_RELEASE_ROOT_INVALID");
  }
  const releaseRoot = fs.realpathSync(input.releaseRoot);
  if (releaseRoot !== input.releaseRoot) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_RELEASE_ROOT_INVALID");
  }
  const rootMetadata = assertReadonlyDirectory(
    releaseRoot,
    "FORMAL_CANDIDATE_LAUNCHER_RELEASE_ROOT_NOT_READONLY",
  );
  const expectedLauncherFile = path.join(
    releaseRoot,
    ...FORMAL_CANDIDATE_LAUNCHER_MANIFEST_PATH.split("/"),
  );
  if (
    input.launcherFile !== undefined
    && (
      !path.isAbsolute(input.launcherFile)
      || path.normalize(input.launcherFile) !== input.launcherFile
      || fs.realpathSync(input.launcherFile) !== expectedLauncherFile
    )
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_COMPILED_ENTRY_REQUIRED");
  }
  const expectedBoundedSourcePreparerFile = path.join(
    releaseRoot,
    ...FORMAL_CANDIDATE_BOUNDED_SOURCE_PREPARER_MANIFEST_PATH.split("/"),
  );
  if (input.boundedSourcePreparerFile !== undefined) {
    try {
      if (
        !path.isAbsolute(input.boundedSourcePreparerFile)
        || path.normalize(input.boundedSourcePreparerFile)
          !== input.boundedSourcePreparerFile
        || fs.realpathSync(input.boundedSourcePreparerFile)
          !== expectedBoundedSourcePreparerFile
      ) {
        return fail("FORMAL_CANDIDATE_LAUNCHER_COMPILED_ENTRY_REQUIRED");
      }
    } catch (error) {
      if (error instanceof FormalCandidateLauncherError) throw error;
      return fail("FORMAL_CANDIDATE_LAUNCHER_COMPILED_ENTRY_REQUIRED");
    }
  }
  const manifestFile = readPinnedReadonlyFile({
    releaseRoot,
    manifestPath: "release-manifest.json",
    maximumBytes: MAX_MANIFEST_BYTES,
  });
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      manifestFile.bytes,
    ));
  } catch {
    return fail("FORMAL_CANDIDATE_LAUNCHER_MANIFEST_INVALID");
  }
  if (!isRecord(manifest)) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_MANIFEST_INVALID");
  }
  const verifiedAttestation = verifyReleaseArtifactAttestation(
    manifest,
    input.environment ?? process.env,
  );
  const runtimeCapabilities = (() => {
    const manifestCapabilities = manifest.runtimeCapabilities;
    if (
      !Array.isArray(manifestCapabilities)
      || manifestCapabilities.length > 64
      || manifestCapabilities.some((entry) => (
        typeof entry !== "string"
        || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(entry)
      ))
      || new Set(manifestCapabilities).size
        !== manifestCapabilities.length
    ) return fail("FORMAL_CANDIDATE_LAUNCHER_MANIFEST_CAPABILITIES_INVALID");
    const sorted = [...manifestCapabilities].sort((left, right) => (
      String(left).localeCompare(String(right), "en")
    )) as string[];
    if (sorted.some((entry, index) => entry !== manifestCapabilities[index])) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_MANIFEST_CAPABILITIES_INVALID");
    }
    return Object.freeze(sorted);
  })();
  const runtime = isRecord(manifest.runtime) ? manifest.runtime : null;
  const contract = runtime && isRecord(runtime.formalCandidateLauncher)
    ? runtime.formalCandidateLauncher
    : null;
  if (
    manifest.format !== "fanjin-release/v1"
    || manifest.manifestVersion !== 1
    || typeof manifest.releaseId !== "string"
    || !RELEASE_ID_PATTERN.test(manifest.releaseId)
    || typeof manifest.sourceCommit !== "string"
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.sourceCommit)
    || runtime?.entrypoint !== PRODUCTION_APPLICATION_MANIFEST_PATH
    || !runtime.targetPlatform
    || !runtime.nodeRuntime
    || !contract
    || !exactKeys(contract, [
      "applicationEntrypoint",
      "format",
      "fullMatrixDriver",
      "launcherEntrypoint",
      "proofFormat",
    ])
    || contract.format !== FORMAL_CANDIDATE_LAUNCHER_FORMAT
    || contract.launcherEntrypoint
      !== FORMAL_CANDIDATE_LAUNCHER_MANIFEST_PATH
    || contract.applicationEntrypoint
      !== FORMAL_CANDIDATE_APPLICATION_MANIFEST_PATH
    || contract.proofFormat !== FORMAL_CANDIDATE_LAUNCH_PROOF_FORMAT
    || !isRecord(contract.fullMatrixDriver)
    || !exactKeys(contract.fullMatrixDriver, [
      "byteSize", "format", "manifestPath", "sha256",
    ])
    || contract.fullMatrixDriver.format
      !== FORMAL_CANDIDATE_FULL_MATRIX_DRIVER_FORMAT
    || contract.fullMatrixDriver.manifestPath
      !== FORMAL_CANDIDATE_FULL_MATRIX_DRIVER_MANIFEST_PATH
    || typeof contract.fullMatrixDriver.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(contract.fullMatrixDriver.sha256)
    || !Number.isSafeInteger(contract.fullMatrixDriver.byteSize)
    || Number(contract.fullMatrixDriver.byteSize) <= 0
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_MANIFEST_CONTRACT_INVALID");
  }
  const targetPlatform = parseTargetPlatform(runtime.targetPlatform);
  const nodeRuntime = readCurrentNodeRuntimeIdentity();
  if (!nodeRuntimeIdentityMatches(runtime.nodeRuntime, nodeRuntime)) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_NODE_RUNTIME_MISMATCH");
  }
  const fullTree = verifyExactSignedFullTree({
    releaseRoot,
    rootMetadata,
    manifest,
  });
  const manifestFileAfter = readPinnedReadonlyFile({
    releaseRoot,
    manifestPath: "release-manifest.json",
    maximumBytes: MAX_MANIFEST_BYTES,
  });
  if (!pinnedIdentityMatches(manifestFileAfter.identity, manifestFile.identity)) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_MANIFEST_CHANGED");
  }
  const launcher = fullTree.files.get(FORMAL_CANDIDATE_LAUNCHER_MANIFEST_PATH);
  const application = fullTree.files.get(FORMAL_CANDIDATE_APPLICATION_MANIFEST_PATH);
  const fullMatrixDriver = fullTree.files.get(
    FORMAL_CANDIDATE_FULL_MATRIX_DRIVER_MANIFEST_PATH,
  );
  const boundedSourcePreparer = input.boundedSourcePreparerFile === undefined
    ? undefined
    : fullTree.files.get(
      FORMAL_CANDIDATE_BOUNDED_SOURCE_PREPARER_MANIFEST_PATH,
    );
  if (
    !launcher
    || !application
    || !fullMatrixDriver
    || fullMatrixDriver.sha256 !== contract.fullMatrixDriver.sha256
    || fullMatrixDriver.byteSize !== contract.fullMatrixDriver.byteSize
    || (input.boundedSourcePreparerFile !== undefined
      && !boundedSourcePreparer)
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_SIGNED_TREE_INCOMPLETE");
  }
  const rootUid = statNumber(
    rootMetadata.uid,
    "FORMAL_CANDIDATE_LAUNCHER_RELEASE_ROOT_NOT_READONLY",
  );
  const runtimeUid = typeof process.getuid === "function" ? process.getuid() : rootUid;
  const filesystemEvidenceClass = rootUid === 0 && runtimeUid !== 0
    ? "root-owned-runtime-uid-separated-transcript"
    : "current-uid-readonly-transcript";
  return Object.freeze({
    format: FORMAL_CANDIDATE_LAUNCHER_FORMAT,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    releaseRoot,
    releaseRootDev: rootMetadata.dev.toString(10),
    releaseRootIno: rootMetadata.ino.toString(10),
    releaseRootUid: rootUid,
    releaseRootPathBinding: `sha256:${sha256([
      ROOT_PATH_BINDING_DOMAIN,
      releaseRoot,
      String(rootMetadata.dev),
      String(rootMetadata.ino),
      fullTree.digest,
    ].join("\0"))}`,
    fullTreeDigest: fullTree.digest,
    filesystemEvidenceClass,
    formalFilesystemOwnershipVerified: false,
    manifestFileSha256: manifestFile.identity.sha256,
    manifestPayloadSha256: verifiedAttestation.payloadSha256,
    releaseAttestationKeyId: verifiedAttestation.keyId,
    runtimeCapabilities,
    targetPlatform,
    nodeRuntime,
    launcher,
    application,
    fullMatrixDriver,
    ...(boundedSourcePreparer ? { boundedSourcePreparer } : {}),
  });
}

function currentReleaseLayout(): { releaseRoot: string; launcherFile: string } {
  const launcherFile = fs.realpathSync(__filename);
  if (
    path.basename(launcherFile) !== "formal-candidate-launcher.js"
    || path.basename(path.dirname(launcherFile)) !== "build"
    || path.basename(path.dirname(path.dirname(launcherFile))) !== "app"
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_COMPILED_ENTRY_REQUIRED");
  }
  return {
    launcherFile,
    releaseRoot: path.dirname(path.dirname(path.dirname(launcherFile))),
  };
}

function parseCommand(args: readonly string[]): {
  selfCheck: boolean;
  challenge: string;
} {
  let selfCheck = false;
  let challenge = "";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--self-check" && !selfCheck) {
      selfCheck = true;
      continue;
    }
    if (argument === "--challenge" && !challenge) {
      challenge = String(args[index + 1] || "");
      index += 1;
      continue;
    }
    return fail("FORMAL_CANDIDATE_LAUNCHER_ARGUMENT_INVALID");
  }
  if (!CHALLENGE_PATTERN.test(challenge)) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_CHALLENGE_REQUIRED");
  }
  return { selfCheck, challenge };
}

function assertNoInjectionEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(environment)) {
    if (
      String(value || "").trim()
      && (
        INJECTION_ENVIRONMENT_KEYS.has(key)
        || INJECTION_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
      )
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_ENVIRONMENT_INJECTION_FORBIDDEN");
    }
  }
}

function fixedChildEnvironment(
  verified: VerifiedFormalCandidateReleaseRoot,
  sourceEnvironment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  bootstrap: FormalCandidateRuntimeBootstrap,
): NodeJS.ProcessEnv {
  assertNoInjectionEnvironment(sourceEnvironment);
  return buildFormalCandidateRuntimeChildEnvironment({
    releaseRoot: verified.releaseRoot,
    manifestPayloadSha256: verified.manifestPayloadSha256,
    bootstrap,
    sourceEnvironment,
  });
}

function sameBootstrapFile(left: BigIntStats, right: BigIntStats): boolean {
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

type FormalCandidateBootstrapRelay = Readonly<{
  bootstrap: FormalCandidateRuntimeBootstrap;
  descriptor: number;
  childEnvironment: NodeJS.ProcessEnv;
  formalOwnershipVerified: boolean;
  pathBinding: string;
  fdIdentity: FormalCandidateBootstrapFdIdentity;
}>;

function openFormalCandidateBootstrapRelay(input: Readonly<{
  verified: VerifiedFormalCandidateReleaseRoot;
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
}>): FormalCandidateBootstrapRelay {
  const environment = input.environment;
  const pathBinding = String(
    environment[FORMAL_CANDIDATE_BOOTSTRAP_PATH_BINDING_ENV] || "",
  );
  if (
    environment[FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD_ENV]
      !== String(FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD)
    || !/^sha256:[a-f0-9]{64}$/.test(pathBinding)
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_CHANNEL_INVALID");
  }
  try {
    const before = fs.fstatSync(FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD, {
      bigint: true,
    });
    const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
    const formalOwnershipVerified = currentUid !== 0
      && before.uid === 0n
      && (before.mode & 0o777n) === 0o400n;
    const localOwnershipVerified = before.uid === BigInt(currentUid)
      && (before.mode & 0o777n) === 0o400n;
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size < 2n
      || before.size > BigInt(MAX_RUNTIME_BOOTSTRAP_BYTES)
      || !trustedReadonlyOwner(before)
      || (!formalOwnershipVerified && !localOwnershipVerified)
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_FILE_UNSAFE");
    }
    const bytes = Buffer.alloc(Number(before.size));
    const bytesRead = fs.readSync(
      FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD,
      bytes,
      0,
      bytes.byteLength,
      0,
    );
    const afterInherited = fs.fstatSync(
      FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD,
      { bigint: true },
    );
    if (
      bytesRead !== bytes.byteLength
      || !sameBootstrapFile(before, afterInherited)
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_FILE_CHANGED");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_INVALID");
    }
    let bootstrap: FormalCandidateRuntimeBootstrap;
    try {
      bootstrap = parseFormalCandidateRuntimeBootstrap(parsed);
    } catch (error) {
      if (
        error instanceof FormalCandidateRuntimeBootstrapError
        && error.code === "FORMAL_CANDIDATE_RUNTIME_ARTIFACT_BINDING_INVALID"
      ) {
        return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_ARTIFACT_MISMATCH");
      }
      return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_INVALID");
    }
    if (
      renderFormalCandidateRuntimeBootstrap(bootstrap) !== bytes.toString("utf8")
      || bootstrap.expectedArtifactExecutionBinding.artifactSignedManifestSha256
        !== input.verified.manifestFileSha256
      || bootstrap.expectedArtifactExecutionBinding.manifestPath
        !== FORMAL_CANDIDATE_APPLICATION_MANIFEST_PATH
      || bootstrap.expectedArtifactExecutionBinding.sha256
        !== input.verified.application.sha256
      || bootstrap.expectedArtifactExecutionBinding.byteSize
        !== input.verified.application.byteSize
      || bootstrap.releaseAttestationKeyId
        !== input.verified.releaseAttestationKeyId
      || bootstrap.releaseManifestPayloadSha256
        !== `sha256:${input.verified.manifestPayloadSha256}`
      || canonicalJson(bootstrap.runtimeCapabilities)
        !== canonicalJson(input.verified.runtimeCapabilities)
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_ARTIFACT_MISMATCH");
    }
    const childEnvironment = fixedChildEnvironment(
      input.verified,
      environment,
      bootstrap,
    );
    if (
      formalCandidateRuntimeEnvironmentBinding(childEnvironment)
        !== bootstrap.environmentBinding
    ) {
      return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_ENVIRONMENT_MISMATCH");
    }
    const result = Object.freeze({
      bootstrap,
      descriptor: FORMAL_CANDIDATE_RUNTIME_BOOTSTRAP_FD,
      childEnvironment,
      formalOwnershipVerified,
      pathBinding,
      fdIdentity: Object.freeze({
        dev: before.dev.toString(10),
        ino: before.ino.toString(10),
        byteSize: Number(before.size),
        sha256: sha256(bytes),
        uid: Number(before.uid),
        gid: Number(before.gid),
        mode: Number(before.mode & 0o777n),
        nlink: Number(before.nlink),
      }),
    });
    return result;
  } catch (error) {
    if (error instanceof FormalCandidateLauncherError) throw error;
    return fail("FORMAL_CANDIDATE_LAUNCHER_BOOTSTRAP_READ_FAILED");
  } finally {
    // The descriptor is intentionally retained and relayed as child FD4.
  }
}

function assertFormalCandidateCredentialRelayDescriptor(): number {
  try {
    const metadata = fs.fstatSync(
      FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD,
      { bigint: true },
    );
    const currentUid = typeof process.getuid === "function"
      ? process.getuid()
      : 0;
    const expectedOwner = process.platform === "linux" ? 0n : BigInt(currentUid);
    if (
      (!metadata.isFIFO() && !metadata.isSocket())
      || metadata.uid !== expectedOwner
      || (metadata.nlink !== 0n && metadata.nlink !== 1n)
    ) return fail("FORMAL_CANDIDATE_LAUNCHER_CREDENTIAL_CHANNEL_INVALID");
    return FORMAL_CANDIDATE_CREDENTIAL_CAPABILITY_FD;
  } catch (error) {
    if (error instanceof FormalCandidateLauncherError) throw error;
    return fail("FORMAL_CANDIDATE_LAUNCHER_CREDENTIAL_CHANNEL_INVALID");
  }
}

function releaseSnapshotBinding(value: VerifiedFormalCandidateReleaseRoot): string {
  return sha256(canonicalJson({
    releaseId: value.releaseId,
    sourceCommit: value.sourceCommit,
    releaseRoot: value.releaseRoot,
    releaseRootDev: value.releaseRootDev,
    releaseRootIno: value.releaseRootIno,
    releaseRootPathBinding: value.releaseRootPathBinding,
    fullTreeDigest: value.fullTreeDigest,
    manifestFileSha256: value.manifestFileSha256,
    manifestPayloadSha256: value.manifestPayloadSha256,
    releaseAttestationKeyId: value.releaseAttestationKeyId,
    runtimeCapabilities: value.runtimeCapabilities,
    targetPlatform: value.targetPlatform,
    nodeRuntime: value.nodeRuntime,
    launcher: value.launcher,
    application: value.application,
    fullMatrixDriver: value.fullMatrixDriver,
  }));
}

export function assertFormalCandidateReleaseSnapshotUnchanged(
  before: VerifiedFormalCandidateReleaseRoot,
  after: VerifiedFormalCandidateReleaseRoot,
): void {
  if (releaseSnapshotBinding(before) !== releaseSnapshotBinding(after)) {
    fail("FORMAL_CANDIDATE_LAUNCHER_RELEASE_CHANGED_BEFORE_SPAWN");
  }
}

function proofPayload(
  value: Omit<FormalCandidateLaunchProof, "signatureBase64Url">,
): Buffer {
  return Buffer.from([
    PROOF_SIGNATURE_DOMAIN,
    canonicalJson(value),
  ].join("\0"), "utf8");
}

function createLaunchProof(input: Readonly<{
  verified: VerifiedFormalCandidateReleaseRoot;
  challenge: string;
  childReadiness: FormalCandidateAppReadiness;
  bootstrap: FormalCandidateRuntimeBootstrap;
  formalBootstrapOwnershipVerified: boolean;
  bootstrapPathBinding: string;
  bootstrapFdIdentity: FormalCandidateBootstrapFdIdentity;
  nodeExecutable: string;
  applicationFile: string;
  appRoot: string;
}>): FormalCandidateLaunchProof {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKeySpkiBase64Url = (
    keyPair.publicKey.export({ format: "der", type: "spki" }) as Buffer
  ).toString("base64url");
  const unsigned = {
    format: FORMAL_CANDIDATE_LAUNCH_PROOF_FORMAT,
    challenge: input.challenge,
    createdAt: new Date().toISOString(),
    releaseId: input.verified.releaseId,
    releaseRootPathBinding: input.verified.releaseRootPathBinding,
    fullTreeDigest: input.verified.fullTreeDigest,
    manifestFileSha256: input.verified.manifestFileSha256,
    manifestPayloadSha256: input.verified.manifestPayloadSha256,
    releaseAttestationKeyId: input.verified.releaseAttestationKeyId,
    targetPlatform: input.verified.targetPlatform,
    nodeRuntime: input.verified.nodeRuntime,
    launcher: input.verified.launcher,
    application: input.verified.application,
    launcherPid: process.pid,
    runtimeUid: typeof process.getuid === "function" ? process.getuid() : -1,
    runtimeGid: typeof process.getgid === "function" ? process.getgid() : -1,
    formalBootstrapOwnershipVerified:
      input.formalBootstrapOwnershipVerified,
    bootstrapPathBinding: input.bootstrapPathBinding,
    bootstrapFdIdentity: input.bootstrapFdIdentity,
    launcherStartNonce: input.bootstrap.startNonce,
    childPid: input.childReadiness.pid,
    childReadiness: input.childReadiness,
    childStableWindowMs: CHILD_STABLE_WINDOW_MS,
    fixedCommand: {
      executable: input.nodeExecutable,
      args: [input.applicationFile] as const,
      cwd: input.appRoot,
    },
    proofProvenance: "ephemeral-self-signature-non-authorizing",
    publicKeySpkiBase64Url,
  } as const;
  return Object.freeze({
    ...unsigned,
    signatureBase64Url: crypto.sign(
      null,
      proofPayload(unsigned),
      keyPair.privateKey,
    ).toString("base64url"),
  });
}

export function verifyFormalCandidateLaunchProof(input: Readonly<{
  value: unknown;
  expectedChallenge: string;
  expectedRelease: VerifiedFormalCandidateReleaseRoot;
  consumedProofDigests?: Set<string>;
  now?: number;
}>): FormalCandidateLaunchProof {
  if (!CHALLENGE_PATTERN.test(input.expectedChallenge) || !isRecord(input.value)) {
    return fail("FORMAL_CANDIDATE_LAUNCH_PROOF_INVALID");
  }
  const value = input.value;
  if (!exactKeys(value, [
    "application",
    "bootstrapFdIdentity",
    "bootstrapPathBinding",
    "challenge",
    "childPid",
    "childReadiness",
    "childStableWindowMs",
    "createdAt",
    "fixedCommand",
    "formalBootstrapOwnershipVerified",
    "format",
    "launcher",
    "launcherPid",
    "runtimeGid",
    "runtimeUid",
    "launcherStartNonce",
    "fullTreeDigest",
    "manifestFileSha256",
    "manifestPayloadSha256",
    "nodeRuntime",
    "proofProvenance",
    "publicKeySpkiBase64Url",
    "releaseAttestationKeyId",
    "releaseId",
    "releaseRootPathBinding",
    "signatureBase64Url",
    "targetPlatform",
  ])) {
    return fail("FORMAL_CANDIDATE_LAUNCH_PROOF_INVALID");
  }
  const createdAtMs = typeof value.createdAt === "string"
    ? Date.parse(value.createdAt)
    : Number.NaN;
  const now = input.now ?? Date.now();
  if (
    value.format !== FORMAL_CANDIDATE_LAUNCH_PROOF_FORMAT
    || value.challenge !== input.expectedChallenge
    || value.releaseId !== input.expectedRelease.releaseId
    || value.releaseRootPathBinding
      !== input.expectedRelease.releaseRootPathBinding
    || value.fullTreeDigest !== input.expectedRelease.fullTreeDigest
    || value.manifestFileSha256 !== input.expectedRelease.manifestFileSha256
    || value.manifestPayloadSha256
      !== input.expectedRelease.manifestPayloadSha256
    || value.releaseAttestationKeyId
      !== input.expectedRelease.releaseAttestationKeyId
    || !targetPlatformMatches(value.targetPlatform, input.expectedRelease.targetPlatform)
    || !nodeRuntimeIdentityMatches(
      value.nodeRuntime,
      input.expectedRelease.nodeRuntime,
    )
    || !pinnedIdentityMatches(value.launcher, input.expectedRelease.launcher)
    || !pinnedIdentityMatches(
      value.application,
      input.expectedRelease.application,
    )
    || !Number.isSafeInteger(value.launcherPid)
    || Number(value.launcherPid) <= 1
    || !Number.isSafeInteger(value.runtimeUid)
    || Number(value.runtimeUid) < 0
    || !Number.isSafeInteger(value.runtimeGid)
    || Number(value.runtimeGid) < 0
    || typeof value.formalBootstrapOwnershipVerified !== "boolean"
    || typeof value.bootstrapPathBinding !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.bootstrapPathBinding)
    || !isRecord(value.bootstrapFdIdentity)
    || !exactKeys(value.bootstrapFdIdentity, [
      "byteSize",
      "dev",
      "gid",
      "ino",
      "mode",
      "nlink",
      "sha256",
      "uid",
    ])
    || typeof value.bootstrapFdIdentity.dev !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(value.bootstrapFdIdentity.dev)
    || typeof value.bootstrapFdIdentity.ino !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(value.bootstrapFdIdentity.ino)
    || !Number.isSafeInteger(value.bootstrapFdIdentity.byteSize)
    || Number(value.bootstrapFdIdentity.byteSize) < 2
    || typeof value.bootstrapFdIdentity.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.bootstrapFdIdentity.sha256)
    || !Number.isSafeInteger(value.bootstrapFdIdentity.uid)
    || Number(value.bootstrapFdIdentity.uid) < 0
    || !Number.isSafeInteger(value.bootstrapFdIdentity.gid)
    || Number(value.bootstrapFdIdentity.gid) < 0
    || value.bootstrapFdIdentity.mode !== 0o400
    || value.bootstrapFdIdentity.nlink !== 1
    || !Number.isSafeInteger(value.childPid)
    || Number(value.childPid) <= 1
    || !isRecord(value.childReadiness)
    || !exactKeys(value.childReadiness, [
      "apiBaseUrl",
      "apiStartNonce",
      "artifactExecutionBinding",
      "authorityBinding",
      "bootstrapBinding",
      "checkpointBinding",
      "format",
      "pid",
      "sessionBinding",
      "startNonce",
    ])
    || value.childReadiness.format !== FORMAL_CANDIDATE_RUNTIME_READINESS_FORMAT
    || typeof value.childReadiness.startNonce !== "string"
    || !CHALLENGE_PATTERN.test(value.childReadiness.startNonce)
    || typeof value.childReadiness.apiStartNonce !== "string"
    || !CHALLENGE_PATTERN.test(value.childReadiness.apiStartNonce)
    || typeof value.childReadiness.apiBaseUrl !== "string"
    || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api$/.test(
      value.childReadiness.apiBaseUrl,
    )
    || typeof value.childReadiness.authorityBinding !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.childReadiness.authorityBinding)
    || !isRecord(value.childReadiness.artifactExecutionBinding)
    || canonicalJson(value.childReadiness.artifactExecutionBinding)
      !== canonicalJson({
        version: "fanjin-candidate-runtime-artifact-execution-binding/v1",
        artifactSignedManifestSha256: value.manifestFileSha256,
        manifestPath: input.expectedRelease.application.manifestPath,
        sha256: input.expectedRelease.application.sha256,
        byteSize: input.expectedRelease.application.byteSize,
      })
    || typeof value.childReadiness.sessionBinding !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.childReadiness.sessionBinding)
    || typeof value.childReadiness.checkpointBinding !== "string"
    || !CHALLENGE_PATTERN.test(value.childReadiness.checkpointBinding)
    || typeof value.childReadiness.bootstrapBinding !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.childReadiness.bootstrapBinding)
    || value.childReadiness.pid !== value.childPid
    || value.childStableWindowMs !== CHILD_STABLE_WINDOW_MS
    || typeof value.createdAt !== "string"
    || !Number.isFinite(createdAtMs)
    || new Date(createdAtMs).toISOString() !== value.createdAt
    || !Number.isFinite(now)
    || createdAtMs > now + 1_000
    || now - createdAtMs > MAX_PROOF_AGE_MS
    || typeof value.launcherStartNonce !== "string"
    || !CHALLENGE_PATTERN.test(value.launcherStartNonce)
    || value.launcherStartNonce !== value.childReadiness.startNonce
    || !isRecord(value.fixedCommand)
    || !exactKeys(value.fixedCommand, ["args", "cwd", "executable"])
    || typeof value.fixedCommand.executable !== "string"
    || value.fixedCommand.executable !== fs.realpathSync(process.execPath)
    || !Array.isArray(value.fixedCommand.args)
    || value.fixedCommand.args.length !== 1
    || value.fixedCommand.args[0] !== path.join(
      input.expectedRelease.releaseRoot,
      ...FORMAL_CANDIDATE_APPLICATION_MANIFEST_PATH.split("/"),
    )
    || value.fixedCommand.cwd !== path.join(
      input.expectedRelease.releaseRoot,
      "app",
    )
    || value.proofProvenance
      !== "ephemeral-self-signature-non-authorizing"
    || typeof value.publicKeySpkiBase64Url !== "string"
    || !BASE64URL_PATTERN.test(value.publicKeySpkiBase64Url)
    || typeof value.signatureBase64Url !== "string"
    || !ED25519_SIGNATURE_BASE64URL_PATTERN.test(value.signatureBase64Url)
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCH_PROOF_INVALID");
  }
  const { signatureBase64Url, ...unsigned } = value;
  let publicKey: crypto.KeyObject;
  const publicKeyBytes = Buffer.from(
    value.publicKeySpkiBase64Url,
    "base64url",
  );
  const signatureBytes = Buffer.from(signatureBase64Url, "base64url");
  if (
    publicKeyBytes.toString("base64url") !== value.publicKeySpkiBase64Url
    || signatureBytes.byteLength !== 64
    || signatureBytes.toString("base64url") !== signatureBase64Url
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCH_PROOF_INVALID");
  }
  try {
    publicKey = crypto.createPublicKey({
      key: publicKeyBytes,
      format: "der",
      type: "spki",
    });
  } catch {
    return fail("FORMAL_CANDIDATE_LAUNCH_PROOF_INVALID");
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || !crypto.verify(
      null,
      proofPayload(unsigned as Omit<FormalCandidateLaunchProof, "signatureBase64Url">),
      publicKey,
      signatureBytes,
    )
  ) {
    return fail("FORMAL_CANDIDATE_LAUNCH_PROOF_SIGNATURE_INVALID");
  }
  const proofDigest = sha256(canonicalJson(value));
  if (input.consumedProofDigests?.has(proofDigest)) {
    return fail("FORMAL_CANDIDATE_LAUNCH_PROOF_REPLAYED");
  }
  input.consumedProofDigests?.add(proofDigest);
  return value as unknown as FormalCandidateLaunchProof;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(
      new FormalCandidateLauncherError(
        "FORMAL_CANDIDATE_LAUNCHER_APPLICATION_SPAWN_FAILED",
      ),
    ));
  });
}

function waitForReadiness(input: Readonly<{
  child: ChildProcess;
  bootstrap: FormalCandidateRuntimeBootstrap;
}>): Promise<FormalCandidateAppReadiness> {
  return new Promise((resolve, reject) => {
    const stream = (
      input.child.stdio as unknown as readonly (
        NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined
      )[]
    )?.[FORMAL_CANDIDATE_RUNTIME_READINESS_FD];
    if (!stream || typeof (stream as NodeJS.ReadableStream).on !== "function") {
      reject(new FormalCandidateLauncherError(
        "FORMAL_CANDIDATE_LAUNCHER_READINESS_CHANNEL_UNAVAILABLE",
      ));
      return;
    }
    const readable = stream as NodeJS.ReadableStream;
    let settled = false;
    let bytes = Buffer.alloc(0);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      readable.removeListener("data", onData);
      readable.removeListener("error", onError);
      readable.removeListener("end", onEnd);
      input.child.removeListener("exit", onExit);
      callback();
    };
    const invalid = () => finish(() => reject(
      new FormalCandidateLauncherError(
        "FORMAL_CANDIDATE_LAUNCHER_READINESS_INVALID",
      ),
    ));
    const onData = (chunk: Buffer | string) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      if (bytes.byteLength > 8 * 1024) return invalid();
      const newline = bytes.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== bytes.byteLength - 1) return invalid();
      let value: unknown;
      try {
        value = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
      } catch {
        return invalid();
      }
      const expectedBootstrapBinding = `sha256:${sha256([
        RUNTIME_BOOTSTRAP_BINDING_DOMAIN,
        canonicalJson({
          ...input.bootstrap,
          expectedToken: `sha256:${sha256(input.bootstrap.expectedToken)}`,
        }),
      ].join("\0"))}`;
      if (
        !isRecord(value)
        || !exactKeys(value, [
          "apiBaseUrl",
          "apiStartNonce",
          "artifactExecutionBinding",
          "authorityBinding",
          "bootstrapBinding",
          "checkpointBinding",
          "format",
          "pid",
          "sessionBinding",
          "startNonce",
        ])
        || value.format !== FORMAL_CANDIDATE_RUNTIME_READINESS_FORMAT
        || value.pid !== input.child.pid
        || value.startNonce !== input.bootstrap.startNonce
        || typeof value.apiStartNonce !== "string"
        || !CHALLENGE_PATTERN.test(value.apiStartNonce)
        || value.apiBaseUrl !== input.bootstrap.apiBaseUrl
        || typeof value.authorityBinding !== "string"
        || !/^sha256:[a-f0-9]{64}$/.test(value.authorityBinding)
        || canonicalJson(value.artifactExecutionBinding)
          !== canonicalJson(input.bootstrap.expectedArtifactExecutionBinding)
        || value.sessionBinding !== input.bootstrap.sessionBinding
        || value.checkpointBinding !== input.bootstrap.checkpointBinding
        || value.bootstrapBinding !== expectedBootstrapBinding
      ) return invalid();
      finish(() => resolve(value as unknown as FormalCandidateAppReadiness));
    };
    const onError = invalid;
    const onEnd = () => {
      if (!settled) invalid();
    };
    const onExit = () => finish(() => reject(
      new FormalCandidateLauncherError(
        "FORMAL_CANDIDATE_LAUNCHER_APPLICATION_EXITED_BEFORE_READINESS",
      ),
    ));
    const timeout = setTimeout(() => finish(() => reject(
      new FormalCandidateLauncherError(
        "FORMAL_CANDIDATE_LAUNCHER_READINESS_TIMEOUT",
      ),
    )), FORMAL_CANDIDATE_LAUNCHER_READINESS_TIMEOUT_MS);
    timeout.unref?.();
    readable.on("data", onData);
    readable.once("error", onError);
    readable.once("end", onEnd);
    input.child.once("exit", onExit);
  });
}

function waitForStableChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      child.removeListener("error", onExit);
      callback();
    };
    const onExit = () => finish(() => reject(
      new FormalCandidateLauncherError(
        "FORMAL_CANDIDATE_LAUNCHER_APPLICATION_UNSTABLE",
      ),
    ));
    const timeout = setTimeout(() => {
      try {
        if (!child.pid) return onExit();
        process.kill(child.pid, 0);
        finish(resolve);
      } catch {
        onExit();
      }
    }, CHILD_STABLE_WINDOW_MS);
    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(
      new FormalCandidateLauncherError(
        "FORMAL_CANDIDATE_LAUNCHER_APPLICATION_FAILED",
      ),
    ));
    child.once("exit", (code, signal) => {
      resolve(signal ? 1 : code ?? 1);
    });
  });
}

type FormalCandidateRuntimeFailureCapture = Readonly<{
  publicCodeAfterEnd: () => Promise<string | null>;
  releaseToParent: () => void;
}>;

function captureFormalCandidateRuntimeFailure(
  child: ChildProcess,
): FormalCandidateRuntimeFailureCapture {
  if (!child.stderr) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_APPLICATION_STDERR_UNAVAILABLE");
  }
  const stream = child.stderr;
  let buffered = Buffer.alloc(0);
  let overflow = false;
  let released = false;
  let ended = false;
  let resolveEnded!: () => void;
  const endedPromise = new Promise<void>((resolve) => { resolveEnded = resolve; });
  const finish = () => {
    if (ended) return;
    ended = true;
    resolveEnded();
  };
  const onData = (chunk: Buffer | string) => {
    if (released || overflow) return;
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.byteLength > MAX_RUNTIME_PUBLIC_FAILURE_BYTES) {
      overflow = true;
      buffered = Buffer.alloc(0);
    }
  };
  const detach = () => {
    stream.removeListener("data", onData);
    stream.removeListener("end", finish);
    stream.removeListener("close", finish);
    stream.removeListener("error", finish);
  };
  stream.on("data", onData);
  stream.once("end", finish);
  stream.once("close", finish);
  stream.once("error", finish);
  return Object.freeze({
    publicCodeAfterEnd: async () => {
      if (released) return null;
      await endedPromise;
      detach();
      if (overflow) return null;
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(buffered);
      } catch {
        return null;
      }
      return value === "CANDIDATE_RUNTIME_ATTESTATION_FILE_ALREADY_EXISTS\n"
        ? "FORMAL_CANDIDATE_LAUNCHER_RUNTIME_ATTESTATION_ALREADY_EXISTS"
        : null;
    },
    releaseToParent: () => {
      if (released) return;
      released = true;
      stream.pause();
      detach();
      if (!overflow && buffered.byteLength > 0) process.stderr.write(buffered);
      stream.pipe(process.stderr);
      stream.resume();
    },
  });
}

function waitForChildTermination(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      child.removeListener("error", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

async function terminateFailedApplication(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* outer supervisor also owns group */ }
  if (
    await waitForChildTermination(
      child,
      FORMAL_CANDIDATE_LAUNCHER_TERMINATION_GRACE_MS,
    )
  ) return;
  try { child.kill("SIGKILL"); } catch { /* verify below */ }
  if (!(await waitForChildTermination(child, 2_000))) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_APPLICATION_CLEANUP_FAILED");
  }
}

export type FormalCandidateLauncherRuntimeDependencies = Readonly<{
  /** In-memory test barrier only. The executable CLI never accepts a barrier. */
  beforeApplicationSpawn?: (
    verified: VerifiedFormalCandidateReleaseRoot,
  ) => void | Promise<void>;
  /** In-memory test layout only. The executable CLI derives its own path. */
  layout?: Readonly<{ releaseRoot: string; launcherFile: string }>;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}>;

export async function runFormalCandidateLauncher(
  args: readonly string[] = process.argv.slice(2),
  dependencies: FormalCandidateLauncherRuntimeDependencies = {},
): Promise<number> {
  // This is a post-start detection only: it cannot undo a preload that has
  // already executed. The outer supervisor is the enforcement boundary that
  // starts this file with exact argv and a scrubbed environment.
  if (process.execArgv.length !== 0 && dependencies.layout === undefined) {
    return fail("FORMAL_CANDIDATE_LAUNCHER_EXEC_ARGV_FORBIDDEN");
  }
  const command = parseCommand(args);
  const environment = dependencies.environment ?? process.env;
  assertNoInjectionEnvironment(environment);
  const layout = dependencies.layout ?? currentReleaseLayout();
  let verified = verifyFormalCandidateReleaseRoot({
    ...layout,
    environment,
  });
  if (command.selfCheck) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "formal-candidate-artifact-launcher-self-check",
      executionAuthorized: false,
      independentSupervisorBound: false,
      directPreExecutionRiskSolvedOnlyByOuterSupervisor: true,
      compilerHardBlockRetained: true,
      releaseId: verified.releaseId,
      manifestPayloadSha256: verified.manifestPayloadSha256,
      fullTreeDigest: verified.fullTreeDigest,
      targetPlatform: verified.targetPlatform,
      nodeRuntimeSha256: verified.nodeRuntime.sha256,
      filesystemEvidenceClass: verified.filesystemEvidenceClass,
      formalFilesystemOwnershipVerified: false,
      launcherSha256: verified.launcher.sha256,
      applicationSha256: verified.application.sha256,
      childLaunched: false,
    })}\n`);
    return 0;
  }
  const nodeExecutable = fs.realpathSync(process.execPath);
  const appRoot = path.join(verified.releaseRoot, "app");
  const applicationFile = path.join(
    verified.releaseRoot,
    ...FORMAL_CANDIDATE_APPLICATION_MANIFEST_PATH.split("/"),
  );
  await dependencies.beforeApplicationSpawn?.(verified);
  const reverified = verifyFormalCandidateReleaseRoot({
    ...layout,
    environment,
  });
  assertFormalCandidateReleaseSnapshotUnchanged(verified, reverified);
  verified = reverified;
  const relay = openFormalCandidateBootstrapRelay({
    verified,
    environment,
  });
  const credentialRelayDescriptor =
    assertFormalCandidateCredentialRelayDescriptor();
  let child: ChildProcess | null = null;
  let runtimeFailureCapture: FormalCandidateRuntimeFailureCapture | null = null;
  try {
    child = spawn(nodeExecutable, [applicationFile], {
      cwd: appRoot,
      env: relay.childEnvironment,
      shell: false,
      windowsHide: true,
      // FD3 is intentionally closed: the legacy nonce handshake is forbidden.
      // FD4 is the one-shot bootstrap file and FD5 is extended readiness.
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        "ignore",
        relay.descriptor,
        "pipe",
        credentialRelayDescriptor,
      ],
    });
    await waitForSpawn(child);
    runtimeFailureCapture = captureFormalCandidateRuntimeFailure(child);
  } catch (error) {
    if (child) await terminateFailedApplication(child).catch(() => undefined);
    throw error;
  } finally {
    try { fs.closeSync(relay.descriptor); } catch { /* child owns its duplicate */ }
    try { fs.closeSync(credentialRelayDescriptor); } catch { /* child owns duplicate */ }
  }
  if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 1) {
    child.kill("SIGKILL");
    return fail("FORMAL_CANDIDATE_LAUNCHER_APPLICATION_SPAWN_FAILED");
  }
  try {
    const childReadiness = await waitForReadiness({
      child,
      bootstrap: relay.bootstrap,
    });
    await waitForStableChild(child);
    const proof = createLaunchProof({
      verified,
      challenge: command.challenge,
      childReadiness,
      bootstrap: relay.bootstrap,
      formalBootstrapOwnershipVerified: relay.formalOwnershipVerified,
      bootstrapPathBinding: relay.pathBinding,
      bootstrapFdIdentity: relay.fdIdentity,
      nodeExecutable,
      applicationFile,
      appRoot,
    });
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    child.stdout?.pipe(process.stdout);
    runtimeFailureCapture.releaseToParent();
    let forwardedSignal = false;
    const forward = (signal: NodeJS.Signals) => {
      if (forwardedSignal) return;
      forwardedSignal = true;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    // Keep both handlers installed until the application has completed its
    // asynchronous cleanup. Repeated signals are acknowledged idempotently.
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    try {
      return await waitForExit(child);
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  } catch (error) {
    await terminateFailedApplication(child);
    const publicRuntimeCode = await runtimeFailureCapture?.publicCodeAfterEnd();
    if (publicRuntimeCode) {
      throw new FormalCandidateLauncherError(publicRuntimeCode);
    }
    throw error;
  }
}
