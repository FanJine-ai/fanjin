import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LOCAL_OSS_THUMBNAIL_PATH_REJECTED =
  "LOCAL_OSS_THUMBNAIL_PATH_REJECTED";

export class LocalOssThumbnailPathError extends Error {
  readonly code = LOCAL_OSS_THUMBNAIL_PATH_REJECTED;

  constructor() {
    super(LOCAL_OSS_THUMBNAIL_PATH_REJECTED);
    this.name = "LocalOssThumbnailPathError";
  }
}

export type LocalOssThumbnailPaths = Readonly<{
  originalPath: string;
  thumbnailPath: string;
}>;

export type ContainedStaticReadFile = Readonly<{
  /** The caller owns this descriptor and must close it or transfer it to a stream. */
  fd: number;
  resolvedPath: string;
  size: number;
  mtimeMs: number;
  /** Strong validator derived only from the already-open descriptor identity. */
  etag: string;
}>;

function rejectPath(): never {
  throw new LocalOssThumbnailPathError();
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function decodeRequestPath(rawPath: string): string {
  if (!rawPath || rawPath.length > 4_096 || !rawPath.startsWith("/")) {
    return rejectPath();
  }

  let decoded = rawPath;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!/%[0-9a-f]{2}/i.test(decoded)) break;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return rejectPath();
    }
  }
  // Refuse encodings nested more deeply than the bounded decoder. This also
  // prevents a later framework layer from turning a harmless-looking segment
  // into a separator or `..` after this check.
  if (/%[0-9a-f]{2}/i.test(decoded)) return rejectPath();
  if (
    decoded.startsWith("//")
    || decoded.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(decoded)
  ) {
    return rejectPath();
  }
  return decoded;
}

function assertNoSymlinkComponents(
  root: string,
  segments: readonly string[],
  finalKind: "file-or-missing" | "directory-or-missing" | "any-or-missing",
): void {
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      return rejectPath();
    }
    if (stat.isSymbolicLink()) return rejectPath();
    const isFinal = index === segments.length - 1;
    if (!isFinal && !stat.isDirectory()) return rejectPath();
    if (isFinal) {
      if (finalKind === "file-or-missing" && !stat.isFile()) return rejectPath();
      if (finalKind === "directory-or-missing" && !stat.isDirectory()) return rejectPath();
    }
  }
}

function assertRegularDirectoryRoot(directory: string): string {
  const root = path.resolve(directory);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    return rejectPath();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return rejectPath();
  return root;
}

/** Validate a recovery static read before Express is allowed to follow it. */
export function resolveContainedStaticReadPath(input: {
  rootDirectory: string;
  requestPath: string;
}): string {
  const root = assertRegularDirectoryRoot(input.rootDirectory);
  const decodedPath = decodeRequestPath(String(input.requestPath || ""));
  if (decodedPath === "/") return root;
  const segments = decodedPath.slice(1).split("/");
  if (
    segments.length === 0
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || segment.startsWith(".")
    ))
  ) {
    return rejectPath();
  }
  const resolved = path.resolve(root, ...segments);
  if (!isStrictDescendant(root, resolved)) return rejectPath();
  assertNoSymlinkComponents(root, segments, "any-or-missing");
  return resolved;
}

function isMissingStaticPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sameFilesystemObject(
  left: Pick<fs.Stats, "dev" | "ino"> | Pick<fs.BigIntStats, "dev" | "ino">,
  right: Pick<fs.Stats, "dev" | "ino"> | Pick<fs.BigIntStats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function descriptorStrongEtag(stat: fs.BigIntStats): string {
  const canonicalIdentity = [
    "fanjin-contained-static-read-etag/v1",
    `dev=${stat.dev.toString(10)}`,
    `ino=${stat.ino.toString(10)}`,
    `size=${stat.size.toString(10)}`,
    `mtimeNs=${stat.mtimeNs.toString(10)}`,
    `ctimeNs=${stat.ctimeNs.toString(10)}`,
  ].join("\n");
  const digest = crypto
    .createHash("sha256")
    .update(canonicalIdentity, "utf8")
    .digest("hex");
  return `"${digest}"`;
}

/**
 * Open a contained static file without leaving a validation-to-open gap.
 *
 * `resolveContainedStaticReadPath` rejects existing symlink components first.
 * The post-open realpath and inode checks then prove that the descriptor still
 * names the same regular file below the same OSS root if a component changed
 * between validation and `open(2)`. Serving from the returned descriptor keeps
 * that proof valid even if the pathname changes afterwards.
 */
export function openContainedStaticReadFile(input: {
  rootDirectory: string;
  requestPath: string;
}): ContainedStaticReadFile | null {
  const root = assertRegularDirectoryRoot(input.rootDirectory);
  let rootBefore: fs.Stats;
  try {
    rootBefore = fs.lstatSync(root);
  } catch {
    return rejectPath();
  }

  const resolvedPath = resolveContainedStaticReadPath({
    rootDirectory: root,
    requestPath: input.requestPath,
  });
  if (resolvedPath === root) return null;

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
  const nonBlocking = typeof fs.constants.O_NONBLOCK === "number"
    ? fs.constants.O_NONBLOCK
    : 0;
  let fd: number;
  try {
    fd = fs.openSync(
      resolvedPath,
      fs.constants.O_RDONLY | noFollow | nonBlocking,
    );
  } catch (error) {
    if (isMissingStaticPath(error)) return null;
    return rejectPath();
  }

  try {
    const openedStat = fs.fstatSync(fd, { bigint: true });
    if (!openedStat.isFile()) {
      fs.closeSync(fd);
      return null;
    }
    if (openedStat.size > BigInt(Number.MAX_SAFE_INTEGER)) return rejectPath();

    const rootAfter = fs.lstatSync(root);
    if (
      !rootAfter.isDirectory()
      || rootAfter.isSymbolicLink()
      || !sameFilesystemObject(rootBefore, rootAfter)
    ) {
      return rejectPath();
    }

    const realRoot = fs.realpathSync.native(root);
    const realCandidate = fs.realpathSync.native(resolvedPath);
    if (!isStrictDescendant(realRoot, realCandidate)) return rejectPath();

    // If the pathname was swapped back after `open`, realpath containment by
    // itself is insufficient. It must still name the descriptor's inode.
    const currentPathStat = fs.statSync(resolvedPath, { bigint: true });
    if (
      !currentPathStat.isFile()
      || !sameFilesystemObject(openedStat, currentPathStat)
    ) {
      return rejectPath();
    }

    return Object.freeze({
      fd,
      resolvedPath,
      size: Number(openedStat.size),
      mtimeMs: Number(openedStat.mtimeNs) / 1_000_000,
      etag: descriptorStrongEtag(openedStat),
    });
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Keep the original containment failure.
    }
    if (error instanceof LocalOssThumbnailPathError) throw error;
    if (isMissingStaticPath(error)) return null;
    return rejectPath();
  }
}

/**
 * Resolve a public `/oss` request to an original image and a generated
 * thumbnail without permitting lexical, encoded, backslash, or symlink
 * traversal outside their dedicated roots.
 */
export function resolveLocalOssThumbnailPaths(input: {
  ossDirectory: string;
  requestPath: string;
  sizeKey: string;
}): LocalOssThumbnailPaths {
  const ossRoot = assertRegularDirectoryRoot(input.ossDirectory);

  const decodedPath = decodeRequestPath(String(input.requestPath || ""));
  const segments = decodedPath.slice(1).split("/");
  if (
    segments.length === 0
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments[0].toLowerCase() === "smallimage"
  ) {
    return rejectPath();
  }

  const sizeKey = String(input.sizeKey || "");
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(sizeKey)) return rejectPath();

  const originalPath = path.resolve(ossRoot, ...segments);
  if (!isStrictDescendant(ossRoot, originalPath)) return rejectPath();

  const filename = segments[segments.length - 1];
  const extension = path.extname(filename);
  const basename = path.basename(filename, extension);
  if (!basename) return rejectPath();

  const thumbnailRoot = path.resolve(ossRoot, "smallImage");
  const thumbnailSegments = [
    "smallImage",
    ...segments.slice(0, -1),
    `${basename}_${sizeKey}${extension}`,
  ];
  const thumbnailPath = path.resolve(ossRoot, ...thumbnailSegments);
  if (!isStrictDescendant(thumbnailRoot, thumbnailPath)) return rejectPath();

  // `path.resolve` stops lexical traversal. These component checks stop an
  // existing symlink from redirecting Sharp reads or writes outside the root.
  assertNoSymlinkComponents(ossRoot, segments, "file-or-missing");
  assertNoSymlinkComponents(
    ossRoot,
    thumbnailSegments,
    "file-or-missing",
  );

  if (fs.existsSync(originalPath)) {
    let realOriginal: string;
    let realRoot: string;
    try {
      realOriginal = fs.realpathSync(originalPath);
      realRoot = fs.realpathSync(ossRoot);
    } catch {
      return rejectPath();
    }
    if (!isStrictDescendant(realRoot, realOriginal)) return rejectPath();
  }

  return Object.freeze({ originalPath, thumbnailPath });
}
