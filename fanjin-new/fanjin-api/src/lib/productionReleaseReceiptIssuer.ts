import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  type KeyObject,
  sign,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILD_RECEIPT_FORMAT = "fanjin-release-build-receipt/v1";
export const BUILD_RECEIPT_ATTESTATION_FORMAT =
  "fanjin-release-build-receipt-attestation/v1";
export const NODE_RUNTIME_RECEIPT_FORMAT = "fanjin-node-runtime-receipt/v1";
export const NODE_RUNTIME_RECEIPT_ATTESTATION_FORMAT =
  "fanjin-node-runtime-receipt-attestation/v1";
export const NODE_RUNTIME_IDENTITY_FORMAT = "fanjin-node-runtime-identity/v1";
export const ATTESTATION_CANONICALIZATION = "fanjin-json-c14n/v1";
export const ATTESTATION_ALGORITHM = "Ed25519";
export const RELEASE_AUTHORITY_CLASS = "release-authority-self-attestation";
export const TARGET_RUNTIME_AUTHORITY_CLASS =
  "release-authority-self-attestation-on-target-runtime";
export const PRIVATE_KEY_FILE_ENV =
  "FANJIN_RELEASE_ATTESTATION_PRIVATE_KEY_FILE";

const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const TRUSTED_GIT_ENV = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  TZ: "UTC",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_CANONICAL_JSON_NODES_AND_KEYS = 1_000_000;

export type ProductionReleaseReceiptIssuerErrorCode =
  | "RECEIPT_ARGUMENT_INVALID"
  | "RECEIPT_PRIVATE_KEY_PATH_INVALID"
  | "RECEIPT_PRIVATE_KEY_OPEN_FAILED"
  | "RECEIPT_PRIVATE_KEY_METADATA_INVALID"
  | "RECEIPT_PRIVATE_KEY_CHANGED_DURING_READ"
  | "RECEIPT_PRIVATE_KEY_INVALID"
  | "RECEIPT_PRIVATE_KEY_ALGORITHM_INVALID"
  | "RECEIPT_OUTPUT_PATH_INVALID"
  | "RECEIPT_OUTPUT_PARENT_INVALID"
  | "RECEIPT_OUTPUT_EXISTS"
  | "RECEIPT_OUTPUT_WRITE_FAILED"
  | "RECEIPT_GIT_EXECUTABLE_UNTRUSTED"
  | "RECEIPT_GIT_WORKTREE_INVALID"
  | "RECEIPT_GIT_COMMAND_FAILED"
  | "RECEIPT_SOURCE_COMMIT_INVALID"
  | "RECEIPT_SOURCE_DIRTY"
  | "RECEIPT_SOURCE_CHANGED_DURING_ISSUANCE"
  | "RECEIPT_BUILD_INPUT_INVALID"
  | "RECEIPT_ARTIFACT_TREE_INVALID"
  | "RECEIPT_ARTIFACT_CHANGED_DURING_READ"
  | "RECEIPT_TARGET_PLATFORM_INVALID"
  | "RECEIPT_TARGET_GLIBC_INVALID"
  | "RECEIPT_SIGNER_PRELOAD_FORBIDDEN"
  | "RECEIPT_TARGET_RUNTIME_VERSION_MISMATCH"
  | "RECEIPT_TARGET_RUNTIME_ABI_MISMATCH"
  | "RECEIPT_TARGET_GLIBC_VERSION_MISMATCH"
  | "RECEIPT_TARGET_RUNTIME_EXECUTABLE_UNTRUSTED"
  | "RECEIPT_TARGET_RUNTIME_CHANGED_DURING_READ"
  | "RECEIPT_SIGNATURE_FAILED";

export class ProductionReleaseReceiptIssuerError extends Error {
  readonly code: ProductionReleaseReceiptIssuerErrorCode;

  constructor(code: ProductionReleaseReceiptIssuerErrorCode, message: string) {
    super(message);
    this.name = "ProductionReleaseReceiptIssuerError";
    this.code = code;
  }
}

interface CanonicalState {
  seen: Set<object>;
  nodesAndKeys: number;
}

interface FileIdentity {
  path: string;
  byteSize: number;
  sha256: string;
}

interface TreeIdentity {
  path: string;
  fileCount: number;
  sha256: string;
}

interface BuildArtifactsIdentity {
  apiBuild: TreeIdentity;
  runtimeNodeModules: TreeIdentity;
  webBuild: TreeIdentity;
  packageJson: FileIdentity;
  pm2Config: FileIdentity;
  optionalFiles: FileIdentity[];
}

interface ReceiptAttestation {
  format: string;
  canonicalization: typeof ATTESTATION_CANONICALIZATION;
  algorithm: typeof ATTESTATION_ALGORITHM;
  keyId: string;
  signature: string;
}

export interface BuildReceipt {
  format: typeof BUILD_RECEIPT_FORMAT;
  sourceCommit: string;
  sourceStatus: "clean";
  artifacts: BuildArtifactsIdentity;
  attestation: ReceiptAttestation;
}

export interface TargetNodeRuntimeReceipt {
  format: typeof NODE_RUNTIME_RECEIPT_FORMAT;
  targetPlatform: {
    os: "linux";
    arch: "x64";
    libc: "glibc";
  };
  nodeRuntime: {
    format: typeof NODE_RUNTIME_IDENTITY_FORMAT;
    executableRealpath: string;
    byteSize: number;
    sha256: string;
    version: string;
    nodeAbi: string;
    execArgv: [];
  };
  attestation: ReceiptAttestation;
}

export interface IssueBuildReceiptOptions {
  apiDir: string;
  webDir: string;
  runtimeNodeModulesDir: string;
  output: string;
  keyId: string;
  privateKeyFile: string;
  expectedSourceCommit?: string;
}

export interface IssueTargetNodeRuntimeReceiptOptions {
  output: string;
  keyId: string;
  privateKeyFile: string;
  expectedNodeVersion: string;
  expectedNodeAbi: string;
  expectedGlibcVersion: string;
}

function fail(
  code: ProductionReleaseReceiptIssuerErrorCode,
  message: string,
): never {
  throw new ProductionReleaseReceiptIssuerError(code, message);
}

function sameMetadata(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function canonicalizeJsonValue(
  value: unknown,
  state: CanonicalState = { seen: new Set<object>(), nodesAndKeys: 0 },
  depth = 0,
): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    fail("RECEIPT_SIGNATURE_FAILED", "Receipt exceeds canonicalization depth limit");
  }
  state.nodesAndKeys += 1;
  if (state.nodesAndKeys > MAX_CANONICAL_JSON_NODES_AND_KEYS) {
    fail("RECEIPT_SIGNATURE_FAILED", "Receipt exceeds canonicalization complexity limit");
  }
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("RECEIPT_SIGNATURE_FAILED", "Receipt contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") {
    fail("RECEIPT_SIGNATURE_FAILED", "Receipt contains a non-JSON value");
  }
  if (state.seen.has(value)) {
    fail("RECEIPT_SIGNATURE_FAILED", "Receipt contains a circular reference");
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalizeJsonValue(
        entry,
        state,
        depth + 1,
      )).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    state.nodesAndKeys += keys.length;
    if (state.nodesAndKeys > MAX_CANONICAL_JSON_NODES_AND_KEYS) {
      fail("RECEIPT_SIGNATURE_FAILED", "Receipt exceeds canonicalization complexity limit");
    }
    return `{${keys.map((key) => {
      if (record[key] === undefined) {
        fail("RECEIPT_SIGNATURE_FAILED", "Receipt contains an undefined value");
      }
      return `${JSON.stringify(key)}:${canonicalizeJsonValue(
        record[key],
        state,
        depth + 1,
      )}`;
    }).join(",")}}`;
  } finally {
    state.seen.delete(value);
  }
}

function assertAbsolutePath(value: string, label: string): string {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value
    || /[\0\r\n]/.test(value)) {
    fail("RECEIPT_ARGUMENT_INVALID", `${label} must be a normalized absolute path`);
  }
  return value;
}

function isInside(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

function assertKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    fail("RECEIPT_ARGUMENT_INVALID", "Attestation key ID contains forbidden characters");
  }
}

export function assertUninstrumentedSignerProcess(): void {
  const forbiddenEnvironment = ["NODE_OPTIONS", "LD_PRELOAD", "LD_AUDIT"];
  const injected = forbiddenEnvironment.find((name) => (
    String(process.env[name] || "").trim() !== ""
  ));
  if (process.execArgv.length !== 0 || injected) {
    fail(
      "RECEIPT_SIGNER_PRELOAD_FORBIDDEN",
      "Receipt issuance forbids execArgv and pre-execution loader environment",
    );
  }
}

function loadPrivateKey(privateKeyFile: string): KeyObject {
  if (!privateKeyFile || !path.isAbsolute(privateKeyFile)
    || path.resolve(privateKeyFile) !== privateKeyFile
    || /[\0\r\n]/.test(privateKeyFile)) {
    fail(
      "RECEIPT_PRIVATE_KEY_PATH_INVALID",
      `${PRIVATE_KEY_FILE_ENV} must name a normalized absolute secret file`,
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      privateKeyFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    fail("RECEIPT_PRIVATE_KEY_OPEN_FAILED", "Release attestation private key is unavailable");
  }
  let keyBytes: Buffer | undefined;
  let privateKey: KeyObject;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size <= 0n
      || before.size > BigInt(MAX_PRIVATE_KEY_BYTES)
      || (Number(before.mode) & 0o777) !== 0o600) {
      fail(
        "RECEIPT_PRIVATE_KEY_METADATA_INVALID",
        "Release attestation private key must be a bounded 0600 regular file",
      );
    }
    keyBytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(before, after) || BigInt(keyBytes.length) !== before.size) {
      fail(
        "RECEIPT_PRIVATE_KEY_CHANGED_DURING_READ",
        "Release attestation private key changed while being read",
      );
    }
    try {
      privateKey = createPrivateKey(keyBytes);
    } catch {
      fail("RECEIPT_PRIVATE_KEY_INVALID", "Release attestation private key is invalid");
    }
  } finally {
    keyBytes?.fill(0);
    fs.closeSync(descriptor);
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    fail(
      "RECEIPT_PRIVATE_KEY_ALGORITHM_INVALID",
      "Release attestation private key must be Ed25519",
    );
  }
  return privateKey;
}

function signedReceipt<T extends Record<string, unknown>>(
  unsigned: T,
  attestationFormat: string,
  keyId: string,
  privateKey: KeyObject,
): T & { attestation: ReceiptAttestation } {
  let signature: string;
  try {
    signature = sign(
      null,
      Buffer.from(canonicalizeJsonValue(unsigned), "utf8"),
      privateKey,
    ).toString("base64");
  } catch {
    fail("RECEIPT_SIGNATURE_FAILED", "Failed to sign production release receipt");
  }
  return {
    ...unsigned,
    attestation: {
      format: attestationFormat,
      canonicalization: ATTESTATION_CANONICALIZATION,
      algorithm: ATTESTATION_ALGORITHM,
      keyId,
      signature,
    },
  };
}

function writeExclusiveCanonicalJson(output: string, value: unknown): void {
  assertAbsolutePath(output, "Receipt output");
  const parent = path.dirname(output);
  let parentMetadata: fs.Stats;
  try {
    parentMetadata = fs.lstatSync(parent);
  } catch {
    fail("RECEIPT_OUTPUT_PARENT_INVALID", "Receipt output parent does not exist");
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
    || (parentMetadata.mode & 0o022) !== 0) {
    fail(
      "RECEIPT_OUTPUT_PARENT_INVALID",
      "Receipt output parent must be a real directory not writable by group or others",
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      output,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("RECEIPT_OUTPUT_EXISTS", "Receipt output already exists and cannot be overwritten");
    }
    fail("RECEIPT_OUTPUT_WRITE_FAILED", "Unable to create receipt output");
  }
  try {
    fs.fchmodSync(descriptor, 0o600);
    const bytes = Buffer.from(`${canonicalizeJsonValue(value)}\n`, "utf8");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      }
      fs.fsyncSync(descriptor);
    } finally {
      bytes.fill(0);
    }
  } catch {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the stable write error below.
    }
    try {
      fs.unlinkSync(output);
    } catch {
      // Best effort: a partial 0600 file is unusable and the command fails closed.
    }
    fail("RECEIPT_OUTPUT_WRITE_FAILED", "Failed to persist receipt output atomically");
  }
  fs.closeSync(descriptor);
  let parentDescriptor: number | undefined;
  try {
    parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    fs.fsyncSync(parentDescriptor);
  } catch {
    fail("RECEIPT_OUTPUT_WRITE_FAILED", "Failed to durably persist receipt directory entry");
  } finally {
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}

function stableFileDigest(
  filePath: string,
  changedCode: ProductionReleaseReceiptIssuerErrorCode,
  label: string,
): { metadata: fs.BigIntStats; byteSize: number; sha256: string } {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    fail(changedCode, `${label} must be an available non-symlink regular file`);
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 0n
      || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail(changedCode, `${label} must be a bounded regular file`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      for (;;) {
        const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (length === 0) break;
        hash.update(buffer.subarray(0, length));
      }
    } finally {
      buffer.fill(0);
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(before, after)) {
      fail(changedCode, `${label} changed while it was being hashed`);
    }
    return {
      metadata: after,
      byteSize: Number(after.size),
      sha256: hash.digest("hex"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function inputFileIdentity(
  filePath: string,
  logicalPath: string,
  label: string,
): FileIdentity {
  const resolved = path.resolve(filePath);
  const digest = stableFileDigest(
    resolved,
    "RECEIPT_ARTIFACT_CHANGED_DURING_READ",
    label,
  );
  return {
    path: logicalPath,
    byteSize: digest.byteSize,
    sha256: digest.sha256,
  };
}

function inputTreeIdentity(
  root: string,
  logicalPath: string,
  label: string,
  omitNodeModulesBin = false,
): TreeIdentity {
  let rootMetadata: fs.Stats;
  try {
    rootMetadata = fs.lstatSync(root);
  } catch {
    fail("RECEIPT_ARTIFACT_TREE_INVALID", `${label} does not exist`);
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("RECEIPT_ARTIFACT_TREE_INVALID", `${label} must be a real directory`);
  }
  const records: Array<{ path: string; byteSize: number; sha256: string }> = [];
  function visit(directory: string, relativeDirectory = ""): number {
    const before = fs.lstatSync(directory, { bigint: true });
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      fail("RECEIPT_ARTIFACT_CHANGED_DURING_READ", `${label} changed while being enumerated`);
    }
    let representedEntries = 0;
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      if (omitNodeModulesBin && path.basename(directory) === "node_modules" && entry.name === ".bin") {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(
        relativeDirectory.split(path.sep).join("/"),
        entry.name,
      );
      let metadata: fs.Stats;
      try {
        metadata = fs.lstatSync(absolute);
      } catch {
        fail("RECEIPT_ARTIFACT_CHANGED_DURING_READ", `${label} changed while being enumerated`);
      }
      if (metadata.isSymbolicLink()) {
        fail("RECEIPT_ARTIFACT_TREE_INVALID", `${label} contains a symbolic link`);
      }
      if (metadata.isDirectory()) {
        const childEntries = visit(absolute, relative);
        if (childEntries === 0) {
          fail("RECEIPT_ARTIFACT_TREE_INVALID", `${label} contains an unsigned empty directory`);
        }
        representedEntries += 1;
      } else if (metadata.isFile()) {
        const digest = stableFileDigest(
          absolute,
          "RECEIPT_ARTIFACT_CHANGED_DURING_READ",
          `${label}/${relative}`,
        );
        records.push({
          path: relative,
          byteSize: digest.byteSize,
          sha256: digest.sha256,
        });
        representedEntries += 1;
      } else {
        fail("RECEIPT_ARTIFACT_TREE_INVALID", `${label} contains an unsupported entry`);
      }
    }
    const after = fs.lstatSync(directory, { bigint: true });
    if (!sameMetadata(before, after)) {
      fail("RECEIPT_ARTIFACT_CHANGED_DURING_READ", `${label} changed while being enumerated`);
    }
    return representedEntries;
  }
  if (visit(root) === 0) {
    fail("RECEIPT_ARTIFACT_TREE_INVALID", `${label} must not be empty`);
  }
  return {
    path: logicalPath,
    fileCount: records.length,
    sha256: createHash("sha256")
      .update(Buffer.from(canonicalizeJsonValue(records), "utf8"))
      .digest("hex"),
  };
}

function currentBuildInputIdentity(
  apiDir: string,
  webDir: string,
  runtimeNodeModulesDir: string,
): BuildArtifactsIdentity {
  for (const [value, label] of [
    [apiDir, "API directory"],
    [webDir, "Web build directory"],
    [runtimeNodeModulesDir, "Production Linux node_modules directory"],
  ] as const) {
    assertAbsolutePath(value, label);
  }
  const optionalFiles: FileIdentity[] = [];
  for (const logicalPath of [
    "yarn.lock",
    "package-lock.json",
    "LICENSE",
    "NOTICES.txt",
  ]) {
    const filePath = path.join(apiDir, logicalPath);
    if (fs.existsSync(filePath)) {
      optionalFiles.push(inputFileIdentity(filePath, logicalPath, logicalPath));
    }
  }
  return {
    apiBuild: inputTreeIdentity(
      path.join(apiDir, "build"),
      "build",
      "compiled API build",
    ),
    runtimeNodeModules: inputTreeIdentity(
      runtimeNodeModulesDir,
      "node_modules",
      "production Linux node_modules",
      true,
    ),
    webBuild: inputTreeIdentity(webDir, "web", "web build"),
    packageJson: inputFileIdentity(
      path.join(apiDir, "package.json"),
      "package.json",
      "package.json",
    ),
    pm2Config: inputFileIdentity(
      path.join(apiDir, "deploy", "pm2", "ecosystem.config.cjs"),
      "deploy/pm2/ecosystem.config.cjs",
      "PM2 config",
    ),
    optionalFiles,
  };
}

function assertTrustedExecutable(executable: string, label: string): string {
  let realExecutable: string;
  try {
    realExecutable = fs.realpathSync(executable);
  } catch {
    fail("RECEIPT_GIT_EXECUTABLE_UNTRUSTED", `${label} is unavailable`);
  }
  const metadata = fs.statSync(realExecutable);
  if (!metadata.isFile() || metadata.uid !== 0
    || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0) {
    fail(
      "RECEIPT_GIT_EXECUTABLE_UNTRUSTED",
      `${label} must resolve to a root-owned, non-writable executable`,
    );
  }
  let ancestor = path.dirname(realExecutable);
  for (;;) {
    const ancestorMetadata = fs.lstatSync(ancestor);
    if (!ancestorMetadata.isDirectory() || ancestorMetadata.isSymbolicLink()
      || ancestorMetadata.uid !== 0 || (ancestorMetadata.mode & 0o022) !== 0) {
      fail(
        "RECEIPT_GIT_EXECUTABLE_UNTRUSTED",
        `${label} has an untrusted path ancestor`,
      );
    }
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  return realExecutable;
}

function runTrustedGit(apiDir: string, args: string[], label: string): string {
  const git = assertTrustedExecutable(TRUSTED_GIT_EXECUTABLE, "Trusted Git executable");
  const completed = spawnSync(git, [
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "core.hooksPath=/dev/null",
    "-C", apiDir,
    ...args,
  ], {
    encoding: "utf8",
    env: TRUSTED_GIT_ENV,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (completed.error || completed.status !== 0) {
    fail("RECEIPT_GIT_COMMAND_FAILED", `${label} failed`);
  }
  return completed.stdout.trim();
}

function cleanSourceCommit(apiDir: string): string {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(apiDir);
  } catch {
    fail("RECEIPT_GIT_WORKTREE_INVALID", "API directory is unavailable");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("RECEIPT_GIT_WORKTREE_INVALID", "API directory must be a real Git worktree directory");
  }
  if (runTrustedGit(
    apiDir,
    ["rev-parse", "--is-inside-work-tree"],
    "Git worktree check",
  ) !== "true") {
    fail("RECEIPT_GIT_WORKTREE_INVALID", "API directory must be inside a Git worktree");
  }
  const commit = runTrustedGit(
    apiDir,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "Git HEAD resolution",
  ).toLowerCase();
  if (!SOURCE_COMMIT_PATTERN.test(commit)) {
    fail("RECEIPT_SOURCE_COMMIT_INVALID", "Git HEAD is not a supported commit digest");
  }
  const status = runTrustedGit(
    apiDir,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    "Git source cleanliness check",
  );
  if (status !== "") {
    fail("RECEIPT_SOURCE_DIRTY", "Source worktree must be completely clean");
  }
  return commit;
}

function assertSameBuildIdentity(
  expected: BuildArtifactsIdentity,
  actual: BuildArtifactsIdentity,
): void {
  if (canonicalizeJsonValue(expected) !== canonicalizeJsonValue(actual)) {
    fail(
      "RECEIPT_ARTIFACT_CHANGED_DURING_READ",
      "Build inputs changed while the receipt was being issued",
    );
  }
}

export function issueBuildReceipt(options: IssueBuildReceiptOptions): BuildReceipt {
  assertKeyId(options.keyId);
  const apiDir = assertAbsolutePath(options.apiDir, "API directory");
  const webDir = assertAbsolutePath(options.webDir, "Web build directory");
  const runtimeNodeModulesDir = assertAbsolutePath(
    options.runtimeNodeModulesDir,
    "Production Linux node_modules directory",
  );
  const output = assertAbsolutePath(options.output, "Receipt output");
  let repositoryRoot: string;
  try {
    repositoryRoot = fs.realpathSync(runTrustedGit(
      apiDir,
      ["rev-parse", "--show-toplevel"],
      "Git worktree root resolution",
    ));
  } catch (error) {
    if (error instanceof ProductionReleaseReceiptIssuerError) throw error;
    fail("RECEIPT_GIT_WORKTREE_INVALID", "Git worktree root is unavailable");
  }
  if (isInside(output, repositoryRoot)) {
    fail(
      "RECEIPT_OUTPUT_PATH_INVALID",
      "Build receipt output must be outside the Git worktree",
    );
  }
  if (path.isAbsolute(options.privateKeyFile)
    && isInside(path.resolve(options.privateKeyFile), repositoryRoot)) {
    fail(
      "RECEIPT_PRIVATE_KEY_PATH_INVALID",
      "Release attestation private key must be outside the Git worktree",
    );
  }
  const firstCommit = cleanSourceCommit(apiDir);
  if (options.expectedSourceCommit
    && options.expectedSourceCommit.toLowerCase() !== firstCommit) {
    fail(
      "RECEIPT_SOURCE_COMMIT_INVALID",
      "Expected source commit does not match the clean Git HEAD",
    );
  }
  const firstIdentity = currentBuildInputIdentity(apiDir, webDir, runtimeNodeModulesDir);
  const secondIdentity = currentBuildInputIdentity(apiDir, webDir, runtimeNodeModulesDir);
  assertSameBuildIdentity(firstIdentity, secondIdentity);
  const secondCommit = cleanSourceCommit(apiDir);
  if (secondCommit !== firstCommit) {
    fail(
      "RECEIPT_SOURCE_CHANGED_DURING_ISSUANCE",
      "Git HEAD changed while the build receipt was being issued",
    );
  }
  const privateKey = loadPrivateKey(options.privateKeyFile);
  const unsigned = {
    format: BUILD_RECEIPT_FORMAT,
    sourceCommit: firstCommit,
    sourceStatus: "clean" as const,
    artifacts: secondIdentity,
  };
  const receipt = signedReceipt(
    unsigned,
    BUILD_RECEIPT_ATTESTATION_FORMAT,
    options.keyId,
    privateKey,
  ) as BuildReceipt;
  writeExclusiveCanonicalJson(output, receipt);
  return receipt;
}

function assertLinuxX64Elf(header: Buffer): void {
  const matches = header.length >= 20
    && header[0] === 0x7f
    && header[1] === 0x45
    && header[2] === 0x4c
    && header[3] === 0x46
    && header[4] === 2
    && header[5] === 1
    && header.readUInt16LE(18) === 0x3e;
  if (!matches) {
    fail(
      "RECEIPT_TARGET_RUNTIME_EXECUTABLE_UNTRUSTED",
      "Target Node executable must be a Linux x86-64 ELF binary",
    );
  }
}

function runtimeGlibcVersion(): string {
  const report = process.report?.getReport() as {
    header?: { glibcVersionRuntime?: unknown };
  } | undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  if (typeof glibc !== "string" || glibc.length < 1 || glibc.length > 64
    || /[\0\r\n]/.test(glibc)) {
    fail("RECEIPT_TARGET_GLIBC_INVALID", "Runtime is not positively identified as glibc");
  }
  return glibc;
}

function assertTrustedRuntimeExecutable(executableRealpath: string): void {
  let current = path.dirname(executableRealpath);
  for (;;) {
    const metadata = fs.lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      fail(
        "RECEIPT_TARGET_RUNTIME_EXECUTABLE_UNTRUSTED",
        "Target Node executable has an untrusted path ancestor",
      );
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
}

export function issueTargetNodeRuntimeReceipt(
  options: IssueTargetNodeRuntimeReceiptOptions,
): TargetNodeRuntimeReceipt {
  assertKeyId(options.keyId);
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail(
      "RECEIPT_TARGET_PLATFORM_INVALID",
      "Target runtime receipt issuance requires the real Linux x64 target process",
    );
  }
  if (process.version !== options.expectedNodeVersion) {
    fail(
      "RECEIPT_TARGET_RUNTIME_VERSION_MISMATCH",
      `Target Node version does not match ${options.expectedNodeVersion}`,
    );
  }
  if (process.versions.modules !== options.expectedNodeAbi) {
    fail(
      "RECEIPT_TARGET_RUNTIME_ABI_MISMATCH",
      `Target Node ABI does not match ${options.expectedNodeAbi}`,
    );
  }
  const glibc = runtimeGlibcVersion();
  if (glibc !== options.expectedGlibcVersion) {
    fail(
      "RECEIPT_TARGET_GLIBC_VERSION_MISMATCH",
      `Target glibc version does not match ${options.expectedGlibcVersion}`,
    );
  }
  let executableRealpath: string;
  try {
    executableRealpath = fs.realpathSync(process.execPath);
  } catch {
    fail(
      "RECEIPT_TARGET_RUNTIME_EXECUTABLE_UNTRUSTED",
      "Target Node executable cannot be resolved",
    );
  }
  if (!path.posix.isAbsolute(executableRealpath)
    || path.posix.normalize(executableRealpath) !== executableRealpath
    || /[\0\r\n]/.test(executableRealpath)) {
    fail(
      "RECEIPT_TARGET_RUNTIME_EXECUTABLE_UNTRUSTED",
      "Target Node executable realpath is invalid",
    );
  }
  assertTrustedRuntimeExecutable(executableRealpath);
  const pathBefore = fs.lstatSync(executableRealpath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    fail(
      "RECEIPT_TARGET_RUNTIME_EXECUTABLE_UNTRUSTED",
      "Target Node executable must be a non-symlink regular file",
    );
  }
  const executable = stableFileDigest(
    executableRealpath,
    "RECEIPT_TARGET_RUNTIME_CHANGED_DURING_READ",
    "Target Node executable",
  );
  if (!sameMetadata(pathBefore, executable.metadata)) {
    fail(
      "RECEIPT_TARGET_RUNTIME_CHANGED_DURING_READ",
      "Target Node executable path changed while it was being hashed",
    );
  }
  if (executable.metadata.uid !== 0n
    || (Number(executable.metadata.mode) & 0o022) !== 0
    || (Number(executable.metadata.mode) & 0o111) === 0) {
    fail(
      "RECEIPT_TARGET_RUNTIME_EXECUTABLE_UNTRUSTED",
      "Target Node executable must be root-owned, executable, and non-writable",
    );
  }
  const descriptor = fs.openSync(
    executableRealpath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  const header = Buffer.alloc(20);
  try {
    const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(descriptorBefore, executable.metadata)) {
      fail(
        "RECEIPT_TARGET_RUNTIME_CHANGED_DURING_READ",
        "Target Node executable changed before its ELF header was verified",
      );
    }
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      fail(
        "RECEIPT_TARGET_RUNTIME_EXECUTABLE_UNTRUSTED",
        "Target Node executable is truncated",
      );
    }
    assertLinuxX64Elf(header);
    const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(executableRealpath, { bigint: true });
    if (!sameMetadata(descriptorAfter, executable.metadata)
      || !sameMetadata(pathAfter, executable.metadata)) {
      fail(
        "RECEIPT_TARGET_RUNTIME_CHANGED_DURING_READ",
        "Target Node executable changed while its ELF header was verified",
      );
    }
  } finally {
    header.fill(0);
    fs.closeSync(descriptor);
  }
  if (!SHA256_PATTERN.test(executable.sha256)) {
    fail("RECEIPT_TARGET_RUNTIME_CHANGED_DURING_READ", "Target Node digest is invalid");
  }
  const privateKey = loadPrivateKey(options.privateKeyFile);
  const unsigned = {
    format: NODE_RUNTIME_RECEIPT_FORMAT,
    targetPlatform: { os: "linux" as const, arch: "x64" as const, libc: "glibc" as const },
    nodeRuntime: {
      format: NODE_RUNTIME_IDENTITY_FORMAT,
      executableRealpath,
      byteSize: executable.byteSize,
      sha256: executable.sha256,
      version: process.version,
      nodeAbi: process.versions.modules,
      execArgv: [] as [],
    },
  };
  const receipt = signedReceipt(
    unsigned,
    NODE_RUNTIME_RECEIPT_ATTESTATION_FORMAT,
    options.keyId,
    privateKey,
  ) as TargetNodeRuntimeReceipt;
  writeExclusiveCanonicalJson(options.output, receipt);
  return receipt;
}

export function receiptFileSha256(filePath: string): string {
  return stableFileDigest(
    filePath,
    "RECEIPT_ARTIFACT_CHANGED_DURING_READ",
    "Receipt output",
  ).sha256;
}
