import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { normalizeObjectKey } from "@/lib/objectStorage";

export const CONTAINED_LOCAL_FILE_REJECTED =
  "CONTAINED_LOCAL_FILE_REJECTED";

export class ContainedLocalFileError extends Error {
  readonly code = CONTAINED_LOCAL_FILE_REJECTED;

  constructor() {
    super(CONTAINED_LOCAL_FILE_REJECTED);
    this.name = "ContainedLocalFileError";
  }
}

export interface ContainedLocalFilePlan {
  readonly rootDirectory: string;
  readonly relativePath: string;
  readonly finalPath: string;
  readonly temporaryPath: string;
}

export interface CommittedContainedLocalFile {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

function reject(): never {
  throw new ContainedLocalFileError();
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
}

function assertDirectoryRoot(rawRoot: string): {
  rootDirectory: string;
  realRootDirectory: string;
} {
  const rootDirectory = path.resolve(rawRoot);
  let stat: fs.Stats;
  let realRootDirectory: string;
  try {
    stat = fs.lstatSync(rootDirectory);
    realRootDirectory = fs.realpathSync(rootDirectory);
  } catch {
    return reject();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return reject();
  return { rootDirectory, realRootDirectory };
}

function normalizedSegments(relativePath: string): {
  normalizedPath: string;
  segments: string[];
} {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeObjectKey(relativePath);
  } catch {
    return reject();
  }
  const segments = normalizedPath.split("/");
  if (
    segments.length === 0
    || segments.some((segment) =>
      !segment
      || segment === "."
      || segment === ".."
      || /[\u0000-\u001f\u007f]/u.test(segment))
  ) {
    return reject();
  }
  return { normalizedPath, segments };
}

function lstatOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return reject();
  }
}

function assertRealPathContained(
  realRootDirectory: string,
  candidate: string,
): void {
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return reject();
  }
  if (!isInsideOrEqual(realRootDirectory, realCandidate)) return reject();
}

function ensureContainedParentDirectory(input: {
  rootDirectory: string;
  segments: readonly string[];
  createMissing: boolean;
}): string {
  const { rootDirectory, realRootDirectory } = assertDirectoryRoot(
    input.rootDirectory,
  );
  let cursor = rootDirectory;
  for (const segment of input.segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    let stat = lstatOrNull(cursor);
    if (!stat && input.createMissing) {
      try {
        fs.mkdirSync(cursor, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return reject();
      }
      stat = lstatOrNull(cursor);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return reject();
    assertRealPathContained(realRootDirectory, cursor);
  }
  return cursor;
}

function assertPlanStillContained(plan: ContainedLocalFilePlan): void {
  const { normalizedPath, segments } = normalizedSegments(plan.relativePath);
  const rootDirectory = path.resolve(plan.rootDirectory);
  if (
    normalizedPath !== plan.relativePath
    || rootDirectory !== plan.rootDirectory
    || path.resolve(rootDirectory, ...segments) !== plan.finalPath
    || path.dirname(plan.temporaryPath) !== path.dirname(plan.finalPath)
  ) {
    return reject();
  }
  ensureContainedParentDirectory({
    rootDirectory,
    segments,
    createMissing: false,
  });
}

function assertRegularFile(candidate: string): void {
  const stat = lstatOrNull(candidate);
  if (!stat?.isFile() || stat.isSymbolicLink()) return reject();
}

function syncContainedRegularFile(
  plan: ContainedLocalFilePlan,
  candidate: string,
): fs.Stats {
  assertPlanStillContained(plan);
  const before = fs.lstatSync(candidate);
  if (!before.isFile() || before.isSymbolicLink()) return reject();
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      return reject();
    }
    fs.fsyncSync(descriptor);
    return opened;
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncVerifiedDirectory(
  candidate: string,
  realContainmentRoot: string,
): void {
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return reject();
  assertRealPathContained(realContainmentRoot, candidate);
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY
      | fs.constants.O_NOFOLLOW
      | (fs.constants.O_DIRECTORY || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isDirectory()
      || opened.dev !== stat.dev
      || opened.ino !== stat.ino
    ) {
      return reject();
    }
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32"
        || !["EPERM", "EINVAL", "ENOTSUP"].includes(String(code || ""))
      ) {
        throw error;
      }
      // Windows does not expose directory fsync semantics. The file itself is
      // still fsynced, and all containment checks above remain fail-closed.
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncContainedDirectoryChain(plan: ContainedLocalFilePlan): void {
  assertPlanStillContained(plan);
  const { segments } = normalizedSegments(plan.relativePath);
  const { realRootDirectory } = assertDirectoryRoot(plan.rootDirectory);
  const directories = [plan.rootDirectory];
  let cursor = plan.rootDirectory;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    directories.push(cursor);
  }
  for (const directory of directories.reverse()) {
    syncVerifiedDirectory(directory, realRootDirectory);
  }
}

/**
 * Create a missing trusted storage root and make its directory entry durable.
 * The direct parent must already be a regular directory; recursive creation is
 * intentionally refused so every newly-created entry has an fsync boundary.
 */
export function ensureDurableContainedLocalRoot(rawRoot: string): string {
  const rootDirectory = path.resolve(rawRoot);
  if (lstatOrNull(rootDirectory)) {
    const existing = assertDirectoryRoot(rootDirectory);
    const physicalParentDirectory = path.dirname(existing.realRootDirectory);
    const physicalParent = assertDirectoryRoot(physicalParentDirectory);
    syncVerifiedDirectory(
      existing.realRootDirectory,
      existing.realRootDirectory,
    );
    syncVerifiedDirectory(
      physicalParentDirectory,
      physicalParent.realRootDirectory,
    );
    return rootDirectory;
  }
  const logicalParentDirectory = path.dirname(rootDirectory);
  let physicalParentDirectory: string;
  try {
    physicalParentDirectory = fs.realpathSync(logicalParentDirectory);
  } catch {
    return reject();
  }
  const physicalParent = assertDirectoryRoot(physicalParentDirectory);
  const physicalRootDirectory = path.join(
    physicalParent.realRootDirectory,
    path.basename(rootDirectory),
  );
  try {
    fs.mkdirSync(physicalRootDirectory, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return reject();
  }
  const created = assertDirectoryRoot(rootDirectory);
  if (created.realRootDirectory !== physicalRootDirectory) {
    return reject();
  }
  syncVerifiedDirectory(
    created.realRootDirectory,
    created.realRootDirectory,
  );
  syncVerifiedDirectory(
    physicalParentDirectory,
    physicalParent.realRootDirectory,
  );
  return rootDirectory;
}

/**
 * Prepare a new file path below a trusted root without following an existing
 * symlink in any child component. Missing directories are created one level
 * at a time and revalidated after creation.
 */
export function prepareContainedLocalFile(input: {
  rootDirectory: string;
  relativePath: string;
  temporarySuffix?: string;
}): ContainedLocalFilePlan {
  const { normalizedPath, segments } = normalizedSegments(input.relativePath);
  const { rootDirectory } = assertDirectoryRoot(input.rootDirectory);
  const parentDirectory = ensureContainedParentDirectory({
    rootDirectory,
    segments,
    createMissing: true,
  });
  const finalPath = path.resolve(rootDirectory, ...segments);
  if (!isInsideOrEqual(rootDirectory, finalPath) || finalPath === rootDirectory) {
    return reject();
  }
  if (lstatOrNull(finalPath)) return reject();
  const suffix = input.temporarySuffix
    ?? `.${crypto.randomUUID()}.part`;
  if (
    !suffix
    || suffix.includes("/")
    || suffix.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(suffix)
  ) {
    return reject();
  }
  const temporaryPath = path.join(
    parentDirectory,
    `${path.basename(finalPath)}${suffix}`,
  );
  if (lstatOrNull(temporaryPath)) return reject();
  return Object.freeze({
    rootDirectory,
    relativePath: normalizedPath,
    finalPath,
    temporaryPath,
  });
}

/** Create an exclusive, no-follow stream for a previously prepared temp file. */
export function createContainedLocalWriteStream(
  plan: ContainedLocalFilePlan,
): fs.WriteStream {
  assertPlanStillContained(plan);
  if (lstatOrNull(plan.finalPath) || lstatOrNull(plan.temporaryPath)) {
    return reject();
  }
  const descriptor = fs.openSync(
    plan.temporaryPath,
    fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_WRONLY
      | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    return fs.createWriteStream(plan.temporaryPath, {
      fd: descriptor,
      autoClose: true,
    });
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

/** Atomically publish the temp file without replacing any existing leaf. */
export function commitContainedLocalFile(
  plan: ContainedLocalFilePlan,
): CommittedContainedLocalFile {
  assertPlanStillContained(plan);
  assertRegularFile(plan.temporaryPath);
  if (lstatOrNull(plan.finalPath)) return reject();
  const temporaryStat = syncContainedRegularFile(plan, plan.temporaryPath);
  try {
    fs.linkSync(plan.temporaryPath, plan.finalPath);
  } catch {
    return reject();
  }
  try {
    assertPlanStillContained(plan);
    const finalStat = fs.lstatSync(plan.finalPath);
    if (
      !finalStat.isFile()
      || finalStat.isSymbolicLink()
      || finalStat.dev !== temporaryStat.dev
      || finalStat.ino !== temporaryStat.ino
    ) {
      return reject();
    }
    fs.unlinkSync(plan.temporaryPath);
    syncContainedDirectoryChain(plan);
    return Object.freeze({
      path: plan.finalPath,
      device: finalStat.dev,
      inode: finalStat.ino,
    });
  } catch (error) {
    try {
      const finalStat = fs.lstatSync(plan.finalPath);
      if (
        finalStat.isFile()
        && !finalStat.isSymbolicLink()
        && finalStat.dev === temporaryStat.dev
        && finalStat.ino === temporaryStat.ino
      ) {
        fs.unlinkSync(plan.finalPath);
        try {
          syncContainedDirectoryChain(plan);
        } catch {
          // Preserve the original publication failure.
        }
      }
    } catch {
      // Preserve the original containment failure. Never recurse or follow.
    }
    throw error;
  }
}

/** Best-effort cleanup that refuses to cross a changed/symlinked parent. */
export function cleanupContainedLocalFile(
  plan: ContainedLocalFilePlan,
  committed?: CommittedContainedLocalFile | null,
): void {
  try {
    assertPlanStillContained(plan);
  } catch {
    return;
  }
  const candidates = [plan.temporaryPath];
  if (committed?.path === plan.finalPath) candidates.push(plan.finalPath);
  let removed = false;
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory()) continue;
      if (
        candidate === plan.finalPath
        && committed
        && (
          !stat.isFile()
          || stat.isSymbolicLink()
          || stat.dev !== committed.device
          || stat.ino !== committed.inode
        )
      ) {
        continue;
      }
      fs.unlinkSync(candidate);
      removed = true;
    } catch {
      // Cleanup is deliberately best effort; callers retain the primary error.
    }
  }
  if (removed) {
    try {
      syncContainedDirectoryChain(plan);
    } catch {
      // Cleanup is deliberately best effort; callers retain the primary error.
    }
  }
}

export async function writeNewContainedLocalFile(input: {
  rootDirectory: string;
  relativePath: string;
  data: Buffer;
  signal?: AbortSignal;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const plan = prepareContainedLocalFile(input);
  let handle: fsp.FileHandle | null = null;
  let committed: CommittedContainedLocalFile | null = null;
  try {
    assertPlanStillContained(plan);
    handle = await fsp.open(
      plan.temporaryPath,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(input.data, { signal: input.signal });
    await handle.sync();
    await handle.close();
    handle = null;
    input.signal?.throwIfAborted();
    committed = commitContainedLocalFile(plan);
    return plan.finalPath;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the primary error.
      }
    }
    cleanupContainedLocalFile(plan, committed);
    throw error;
  }
}

export function resolveContainedExistingLocalPath(input: {
  rootDirectory: string;
  relativePath: string;
  kind: "file" | "directory";
}): string {
  const { normalizedPath, segments } = normalizedSegments(input.relativePath);
  const { rootDirectory, realRootDirectory } = assertDirectoryRoot(
    input.rootDirectory,
  );
  let cursor = rootDirectory;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const stat = lstatOrNull(cursor);
    if (!stat || stat.isSymbolicLink()) return reject();
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) return reject();
    if (final) {
      if (input.kind === "file" && !stat.isFile()) return reject();
      if (input.kind === "directory" && !stat.isDirectory()) return reject();
    }
  }
  const resolved = path.resolve(rootDirectory, ...normalizedPath.split("/"));
  assertRealPathContained(realRootDirectory, resolved);
  return resolved;
}
