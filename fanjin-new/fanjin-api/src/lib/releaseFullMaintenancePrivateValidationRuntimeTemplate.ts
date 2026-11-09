import { createHash } from "node:crypto";
import fs, { constants } from "node:fs";
import path from "node:path";

import { canonicalReleaseFullMaintenancePrivateValidationJson } from
  "@/lib/releaseFullMaintenancePrivateValidation";
import {
  assertReleaseFullMaintenancePrivateTransportConfig,
  type ReleaseFullMaintenancePrivateTransportConfig,
} from "@/lib/releaseFullMaintenancePrivateTransport";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_FORMAT =
  "fanjin-release-full-maintenance-private-validation-runtime-template/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TEMPLATE_BYTES = 128 * 1024;

export type ReleaseFullMaintenancePrivateValidationRuntimeTemplate = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_FORMAT;
  receiptDirectory: string;
  privateApiNodes: readonly Readonly<{ nodeId: string; baseUrl: string }>[];
  transport: ReleaseFullMaintenancePrivateTransportConfig;
  portraitRuntime: Readonly<{
    pollTimeoutMs: number;
    pollIntervalMs: number;
  }>;
  seedanceRuntime: Readonly<{
    priceSourceUrl: string;
    priceSourceContentSha256: string;
    priceCheckedAt: string;
    upstreamUnitPriceMicros: number;
    validUntil: string;
    pollIntervalMs: number;
    timeoutMs: number;
  }>;
  timeoutMs: number;
}>;

export class ReleaseFullMaintenancePrivateValidationRuntimeTemplateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateValidationRuntimeTemplateError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenancePrivateValidationRuntimeTemplateError(code, message);
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", `${label} has unexpected fields`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", `${label} is outside its fixed bounds`);
  }
  return Number(value);
}

function exactRfc3339(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", `${label} is invalid`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", `${label} is not canonical RFC3339`);
  }
  return value;
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || value === path.parse(value).root
    || /[\0\r\n]/u.test(value)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", `${label} path is invalid`);
  return value;
}

function assertRootBoundary(input: {
  platform?: NodeJS.Platform;
  effectiveUid?: number;
}): number {
  if (
    (input.platform !== undefined || input.effectiveUid !== undefined)
    && process.env.NODE_ENV !== "test"
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_ROOT_REQUIRED",
    "production runtime template loading does not accept injected platform or uid boundaries",
  );
  if ((input.platform ?? process.platform) !== "linux") {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_ROOT_REQUIRED",
      "production runtime template loading requires Linux",
    );
  }
  const uid = input.effectiveUid ?? process.geteuid?.();
  if (!Number.isSafeInteger(uid) || Number(uid) < 0 || (input.effectiveUid === undefined && uid !== 0)) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_ROOT_REQUIRED",
      "production runtime template loading requires root",
    );
  }
  return Number(uid);
}

function assertDirectory(directory: string, expectedUid: number): void {
  let resolved: string;
  try {
    resolved = fs.realpathSync(directory);
  } catch {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_STORAGE_UNSAFE",
      "protected runtime template directory is unavailable",
    );
  }
  const metadata = fs.lstatSync(directory);
  if (
    resolved !== directory
    || metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.uid !== expectedUid
    || (metadata.mode & 0o777) !== 0o700
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_STORAGE_UNSAFE",
    "protected runtime template directory must be canonical owner-only 0700",
  );
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink;
}

function validateTemplate(input: {
  value: unknown;
  expectedUid: number;
  now: number;
}): ReleaseFullMaintenancePrivateValidationRuntimeTemplate {
  exactKeys(input.value, [
    "format",
    "portraitRuntime",
    "privateApiNodes",
    "receiptDirectory",
    "seedanceRuntime",
    "timeoutMs",
    "transport",
  ], "runtimeTemplate");
  const value = input.value as Record<string, unknown>;
  if (value.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_FORMAT) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "runtime template format is invalid");
  }
  const receiptDirectory = canonicalAbsolutePath(value.receiptDirectory, "receipt directory");
  assertDirectory(receiptDirectory, input.expectedUid);
  if (!Array.isArray(value.privateApiNodes) || value.privateApiNodes.length < 1 || value.privateApiNodes.length > 32) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "private API inventory is invalid");
  }
  const privateApiNodes = value.privateApiNodes.map((entry, index) => {
    exactKeys(entry, ["baseUrl", "nodeId"], `privateApiNodes[${index}]`);
    const nodeId = String(entry.nodeId || "");
    const baseUrl = String(entry.baseUrl || "");
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "private API origin is invalid");
    }
    const octets = parsed.hostname.split(".").map(Number);
    if (
      !SAFE_NODE_ID.test(nodeId)
      || parsed.protocol !== "http:"
      || parsed.port !== "10588"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || octets.length !== 4
      || octets[0] !== 10
      || octets[1] !== 0
      || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
      || parsed.hostname !== octets.join(".")
      || baseUrl !== `http://${parsed.hostname}:10588`
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "private API origin is outside the exact RFC1918 listener policy");
    return Object.freeze({ nodeId, baseUrl });
  });
  if (
    new Set(privateApiNodes.map(({ nodeId }) => nodeId)).size !== privateApiNodes.length
    || new Set(privateApiNodes.map(({ baseUrl }) => baseUrl)).size !== privateApiNodes.length
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "private API inventory contains duplicates");
  exactKeys(value.portraitRuntime, ["pollIntervalMs", "pollTimeoutMs"], "portraitRuntime");
  const portraitRuntime = value.portraitRuntime as Record<string, unknown>;
  exactKeys(value.seedanceRuntime, [
    "pollIntervalMs",
    "priceCheckedAt",
    "priceSourceContentSha256",
    "priceSourceUrl",
    "timeoutMs",
    "upstreamUnitPriceMicros",
    "validUntil",
  ], "seedanceRuntime");
  const seedanceRuntime = value.seedanceRuntime as Record<string, unknown>;
  const timeoutMs = safeInteger(value.timeoutMs, 60_000, 30 * 60_000, "timeoutMs");
  const portraitPollTimeoutMs = safeInteger(
    portraitRuntime.pollTimeoutMs,
    60_000,
    timeoutMs,
    "portraitRuntime.pollTimeoutMs",
  );
  const portraitPollIntervalMs = safeInteger(
    portraitRuntime.pollIntervalMs,
    1_000,
    60_000,
    "portraitRuntime.pollIntervalMs",
  );
  let priceSourceUrl: URL;
  try {
    priceSourceUrl = new URL(String(seedanceRuntime.priceSourceUrl || ""));
  } catch {
    return fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "price source URL is invalid");
  }
  if (
    priceSourceUrl.protocol !== "https:"
    || priceSourceUrl.hostname !== "www.volcengine.com"
    || priceSourceUrl.username
    || priceSourceUrl.password
    || priceSourceUrl.search
    || priceSourceUrl.hash
    || !priceSourceUrl.pathname.startsWith("/docs/")
    || !SHA256.test(String(seedanceRuntime.priceSourceContentSha256 || ""))
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "price source commitment is invalid");
  const priceCheckedAt = exactRfc3339(seedanceRuntime.priceCheckedAt, "seedanceRuntime.priceCheckedAt");
  const validUntil = exactRfc3339(seedanceRuntime.validUntil, "seedanceRuntime.validUntil");
  if (Date.parse(priceCheckedAt) > input.now || Date.parse(validUntil) <= input.now + timeoutMs) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "price source commitment is stale");
  }
  const transport = assertReleaseFullMaintenancePrivateTransportConfig({
    value: value.transport,
    expectedUid: input.expectedUid,
  });
  return Object.freeze({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_FORMAT,
    receiptDirectory,
    privateApiNodes: Object.freeze(privateApiNodes),
    transport,
    portraitRuntime: Object.freeze({
      pollTimeoutMs: portraitPollTimeoutMs,
      pollIntervalMs: portraitPollIntervalMs,
    }),
    seedanceRuntime: Object.freeze({
      priceSourceUrl: priceSourceUrl.toString(),
      priceSourceContentSha256: String(seedanceRuntime.priceSourceContentSha256),
      priceCheckedAt,
      upstreamUnitPriceMicros: safeInteger(
        seedanceRuntime.upstreamUnitPriceMicros,
        1,
        Number.MAX_SAFE_INTEGER,
        "seedanceRuntime.upstreamUnitPriceMicros",
      ),
      validUntil,
      pollIntervalMs: safeInteger(seedanceRuntime.pollIntervalMs, 250, 60_000, "seedanceRuntime.pollIntervalMs"),
      timeoutMs: safeInteger(seedanceRuntime.timeoutMs, 1_000, timeoutMs, "seedanceRuntime.timeoutMs"),
    }),
    timeoutMs,
  });
}

export function loadReleaseFullMaintenancePrivateValidationRuntimeTemplate(input: {
  filePath: string;
  contentSha256: string;
  now?: number;
  platform?: NodeJS.Platform;
  effectiveUid?: number;
}): ReleaseFullMaintenancePrivateValidationRuntimeTemplate {
  const expectedUid = assertRootBoundary(input);
  const filePath = canonicalAbsolutePath(input.filePath, "runtime template");
  if (!SHA256.test(input.contentSha256)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_STORAGE_UNSAFE", "runtime template digest is invalid");
  }
  assertDirectory(path.dirname(filePath), expectedUid);
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_STORAGE_UNSAFE", "O_NOFOLLOW is unavailable");
  }
  let descriptor = -1;
  try {
    if (fs.realpathSync(filePath) !== filePath || fs.lstatSync(filePath).isSymbolicLink()) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_STORAGE_UNSAFE", "runtime template traverses a symlink");
    }
    descriptor = fs.openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile()
      || before.uid !== expectedUid
      || (before.mode & 0o777) !== 0o600
      || before.nlink !== 1
      || before.size < 2
      || before.size > MAX_TEMPLATE_BYTES
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_STORAGE_UNSAFE", "runtime template is not owner-only single-link data");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!sameIdentity(before, after) || bytes.length !== before.size || sha256(bytes) !== input.contentSha256) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_STORAGE_UNSAFE", "runtime template changed or differs from its pin");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      return fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "runtime template is not JSON");
    }
    const canonical = Buffer.from(
      `${canonicalReleaseFullMaintenancePrivateValidationJson(parsed)}\n`,
      "utf8",
    );
    if (!bytes.equals(canonical)) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_INVALID", "runtime template is not canonical JSON plus newline");
    }
    return validateTemplate({ value: parsed, expectedUid, now: input.now ?? Date.now() });
  } catch (error) {
    if (error instanceof ReleaseFullMaintenancePrivateValidationRuntimeTemplateError) throw error;
    return fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RUNTIME_TEMPLATE_STORAGE_UNSAFE", "runtime template cannot be read safely");
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}
