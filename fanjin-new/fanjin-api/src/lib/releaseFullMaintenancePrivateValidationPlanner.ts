import { createHash } from "node:crypto";
import fs, { constants } from "node:fs";
import path from "node:path";

import {
  assertReleaseFullMaintenancePrivateValidationIntent,
  createReleaseFullMaintenancePrivateValidationIntent,
  type ReleaseFullMaintenancePrivateValidationIntent,
  type ReleaseFullMaintenancePrivateValidationIntentInput,
} from "@/lib/releaseFullMaintenancePrivateValidationIntent";
import { canonicalReleaseFullMaintenancePrivateValidationJson } from
  "@/lib/releaseFullMaintenancePrivateValidation";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INTENT_INPUT_FORMAT =
  "fanjin-release-full-maintenance-private-validation-planner-intent-input/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INTENT_RESULT_FORMAT =
  "fanjin-release-full-maintenance-private-validation-planner-intent-result/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;

export type ReleaseFullMaintenancePrivateValidationPlannerIntentInput = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INTENT_INPUT_FORMAT;
  intent: ReleaseFullMaintenancePrivateValidationIntentInput;
}>;

export type PersistedReleaseFullMaintenancePrivateValidationIntentPlan = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INTENT_RESULT_FORMAT;
  intent: ReleaseFullMaintenancePrivateValidationIntent;
  filePath: string;
  contentSha256: string;
}>;

export class ReleaseFullMaintenancePrivateValidationPlannerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateValidationPlannerError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenancePrivateValidationPlannerError(code, message);
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INPUT_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INPUT_INVALID", `${label} has unexpected fields`);
  }
}

function rawSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || value === path.parse(value).root
    || /[\0\r\n]/u.test(value)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE", `${label} path is invalid`);
  return value;
}

function expectedOwner(effectiveUid: number | undefined): number {
  const value = effectiveUid ?? process.geteuid?.();
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE", "effective uid is unavailable");
  }
  return Number(value);
}

function assertLinuxRootBoundary(input: {
  platform?: NodeJS.Platform;
  effectiveUid?: number;
}): number {
  if (
    (input.platform !== undefined || input.effectiveUid !== undefined)
    && process.env.NODE_ENV !== "test"
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_ROOT_REQUIRED",
      "formal planner does not accept injected platform or uid boundaries",
    );
  }
  if ((input.platform ?? process.platform) !== "linux") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_LINUX_REQUIRED", "formal planner requires Linux");
  }
  const uid = expectedOwner(input.effectiveUid);
  if (uid !== 0 && input.effectiveUid === undefined) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_ROOT_REQUIRED", "formal planner requires root");
  }
  return uid;
}

function stableIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink;
}

function protectedDirectory(input: {
  directory: string;
  expectedUid: number;
}): string {
  const directory = exactAbsolutePath(input.directory, "protected directory");
  let resolved: string;
  try {
    resolved = fs.realpathSync(directory);
  } catch {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE",
      "protected directory is unavailable",
    );
  }
  const metadata = fs.lstatSync(directory);
  if (
    resolved !== directory
    || metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.uid !== input.expectedUid
    || (metadata.mode & 0o777) !== 0o700
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE",
    "protected directory is not canonical owner-only 0700",
  );
  return directory;
}

function readProtectedCanonicalInput(input: {
  filePath: string;
  contentSha256: string;
  expectedUid: number;
}): unknown {
  const filePath = exactAbsolutePath(input.filePath, "planner input");
  if (!SHA256.test(input.contentSha256)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE", "planner input digest is invalid");
  }
  protectedDirectory({ directory: path.dirname(filePath), expectedUid: input.expectedUid });
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE", "O_NOFOLLOW is unavailable");
  }
  let descriptor = -1;
  try {
    if (fs.realpathSync(filePath) !== filePath || fs.lstatSync(filePath).isSymbolicLink()) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE", "planner input traverses a symlink");
    }
    descriptor = fs.openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile()
      || before.uid !== input.expectedUid
      || (before.mode & 0o777) !== 0o600
      || before.nlink !== 1
      || before.size < 2
      || before.size > MAX_INPUT_BYTES
    ) fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE",
      "planner input is not owner-only 0600 single-link data",
    );
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      !stableIdentity(before, after)
      || bytes.length !== before.size
      || rawSha256(bytes) !== input.contentSha256
    ) fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE",
      "planner input changed or differs from its content pin",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      return fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INPUT_INVALID",
        "planner input is not JSON",
      );
    }
    const canonical = Buffer.from(
      `${canonicalReleaseFullMaintenancePrivateValidationJson(parsed)}\n`,
      "utf8",
    );
    if (!bytes.equals(canonical)) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INPUT_INVALID",
        "planner input is not canonical JSON plus newline",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof ReleaseFullMaintenancePrivateValidationPlannerError) throw error;
    return fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE",
      "planner input cannot be read safely",
    );
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function persistCanonicalNoReplace(input: {
  outputDirectory: string;
  basenamePrefix: string;
  value: unknown;
  expectedUid: number;
}): Readonly<{ filePath: string; contentSha256: string }> {
  const directory = protectedDirectory({
    directory: input.outputDirectory,
    expectedUid: input.expectedUid,
  });
  const bytes = Buffer.from(
    `${canonicalReleaseFullMaintenancePrivateValidationJson(input.value)}\n`,
    "utf8",
  );
  if (bytes.length < 2 || bytes.length > MAX_OUTPUT_BYTES) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_OUTPUT_INVALID", "planner output size is invalid");
  }
  const contentSha256 = rawSha256(bytes);
  const filePath = path.join(directory, `${input.basenamePrefix}-${contentSha256}.json`);
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (written < 1) throw new Error("short write");
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_OUTPUT_EXISTS",
        "content-addressed planner output already exists",
      );
    }
    if (error instanceof ReleaseFullMaintenancePrivateValidationPlannerError) throw error;
    return fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE",
      "planner output cannot be persisted safely",
    );
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
  const directoryDescriptor = fs.openSync(directory, constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  const metadata = fs.lstatSync(filePath);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.uid !== input.expectedUid
    || (metadata.mode & 0o777) !== 0o600
    || metadata.nlink !== 1
    || metadata.size !== bytes.length
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_STORAGE_UNSAFE",
    "persisted planner output metadata is unsafe",
  );
  return Object.freeze({ filePath, contentSha256 });
}

export function planReleaseFullMaintenancePrivateValidationIntent(input: {
  inputFile: string;
  inputContentSha256: string;
  outputDirectory: string;
  now?: number;
  platform?: NodeJS.Platform;
  effectiveUid?: number;
}): PersistedReleaseFullMaintenancePrivateValidationIntentPlan {
  const expectedUid = assertLinuxRootBoundary(input);
  const parsed = readProtectedCanonicalInput({
    filePath: input.inputFile,
    contentSha256: input.inputContentSha256,
    expectedUid,
  });
  exactKeys(parsed, ["format", "intent"], "plannerIntentInput");
  if (parsed.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INTENT_INPUT_FORMAT) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INPUT_INVALID", "planner intent input format is invalid");
  }
  let intent: ReleaseFullMaintenancePrivateValidationIntent;
  try {
    intent = assertReleaseFullMaintenancePrivateValidationIntent(
      createReleaseFullMaintenancePrivateValidationIntent(
        parsed.intent as ReleaseFullMaintenancePrivateValidationIntentInput,
      ),
      { now: input.now ?? Date.now() },
    );
  } catch {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INPUT_INVALID",
      "planner intent commitment is invalid or expired",
    );
  }
  const persisted = persistCanonicalNoReplace({
    outputDirectory: input.outputDirectory,
    basenamePrefix: "private-validation-intent",
    value: intent,
    expectedUid,
  });
  return Object.freeze({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLANNER_INTENT_RESULT_FORMAT,
    intent,
    ...persisted,
  });
}
