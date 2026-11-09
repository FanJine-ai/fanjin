import fs from "node:fs";
import path from "node:path";

export class ProductionStartupError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: string, stage: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProductionStartupError";
    this.code = code;
    this.stage = stage;
    this.details = Object.freeze({ ...details });
  }
}

export function startupFailure(code: string, stage: string, message: string): never {
  throw new ProductionStartupError(code, stage, message);
}

function snapshotEqual(before: fs.Stats, after: fs.Stats): boolean {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"]
    .every((key) => before[key as keyof fs.Stats] === after[key as keyof fs.Stats]);
}

/** Reads an already-mounted receipt. Never creates, repairs or chmods a file. */
export function readStartupJson(
  file: string,
  trustedRoot: string,
  ownerUid = 0,
  maximumBytes = 256 * 1024,
): unknown {
  const stage = "startup-receipts";
  if (!path.isAbsolute(file) || path.normalize(file) !== file
    || !path.isAbsolute(trustedRoot) || path.normalize(trustedRoot) !== trustedRoot
    || !file.startsWith(`${trustedRoot}${path.sep}`)) {
    return startupFailure("RUNTIME_RECEIPT_PATH_INVALID", stage, "Receipt is outside its fixed mount");
  }
  let current = trustedRoot;
  try {
    if (fs.realpathSync(trustedRoot) !== trustedRoot) {
      return startupFailure("RUNTIME_RECEIPT_PATH_UNSAFE", stage, "Receipt mount has a symbolic ancestor");
    }
  } catch (error) {
    if (error instanceof ProductionStartupError) throw error;
    return startupFailure("RUNTIME_RECEIPT_MISSING", stage, "Required receipt mount is unavailable");
  }
  const components = path.relative(trustedRoot, path.dirname(file)).split(path.sep).filter(Boolean);
  for (const component of ["", ...components]) {
    if (component) current = path.join(current, component);
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(current); } catch {
      return startupFailure("RUNTIME_RECEIPT_MISSING", stage, "Required receipt directory is unavailable");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== ownerUid
      || (metadata.mode & 0o022) !== 0) {
      return startupFailure("RUNTIME_RECEIPT_PATH_UNSAFE", stage, "Receipt directory is not owner controlled");
    }
  }
  let descriptor: number;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch {
    let details: Record<string, unknown> = { file, runtimeUid: process.geteuid?.() ?? null };
    try {
      const stat = fs.lstatSync(file);
      details = { ...details, fileUid: stat.uid, fileMode: `0${(stat.mode & 0o7777).toString(8)}` };
    } catch { /* file is missing; never echo raw filesystem errors */ }
    throw new ProductionStartupError("RUNTIME_FILE_UNREADABLE", stage, "Required runtime file cannot be read", details);
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.uid !== ownerUid || before.nlink !== 1
      || (before.mode & 0o333) !== 0 || before.size < 2 || before.size > maximumBytes) {
      return startupFailure("RUNTIME_RECEIPT_FILE_UNSAFE", stage, "Receipt must be a bounded read-only regular file");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!snapshotEqual(before, after) || bytes.byteLength !== before.size) {
      return startupFailure("RUNTIME_RECEIPT_CHANGED", stage, "Receipt changed during verification");
    }
    try { return JSON.parse(bytes.toString("utf8")); } catch {
      return startupFailure("RUNTIME_RECEIPT_JSON_INVALID", stage, "Receipt JSON is invalid");
    }
  } finally { fs.closeSync(descriptor); }
}
