import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FORMAT =
  "fanjin-release-full-maintenance-private-validation-intent/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_INTENT_BYTES = 64 * 1024;

export type ReleaseFullMaintenancePrivateValidationIntentPrincipal = Readonly<{
  userId: number;
  platformRole: "root" | "admin" | "super_admin" | null;
  workspaceId: string;
  workspaceRole: "owner" | "admin" | "developer" | "billing" | "viewer";
}>;

export type ReleaseFullMaintenancePrivateValidationIntentInput = Readonly<{
  target: Readonly<{
    releaseId: string;
    artifactId: string;
    artifactSha256: string;
    sourceCommit: string;
    schemaVersion: 48;
    imageDigest: string;
  }>;
  privateApiInventorySha256: string;
  principals: Readonly<{
    user: ReleaseFullMaintenancePrivateValidationIntentPrincipal;
    admin: ReleaseFullMaintenancePrivateValidationIntentPrincipal;
  }>;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  portrait: Readonly<{
    scriptId: number;
    trackId: number;
    model: string;
    modelRouteId: string;
    expectedProviderAssetUriSha256: string;
    expectedProviderSourceSha256: string;
    expectedProviderChannelIdSha256: string;
    aspectRatio: "16:9";
    durationSeconds: 4;
    outputResolution: "720p";
  }>;
  budget: Readonly<{
    currency: "GU";
    maximumGuMicros: number;
    maximumProviderTasks: 2;
  }>;
  expiresAt: number;
}>;

export type ReleaseFullMaintenancePrivateValidationIntent = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FORMAT;
  trafficMode: "full-maintenance";
  target: ReleaseFullMaintenancePrivateValidationIntentInput["target"];
  privateApiInventorySha256: string;
  principals: ReleaseFullMaintenancePrivateValidationIntentInput["principals"];
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  portrait: ReleaseFullMaintenancePrivateValidationIntentInput["portrait"];
  seedanceProbeId: string;
  budget: ReleaseFullMaintenancePrivateValidationIntentInput["budget"];
  expiresAt: number;
  validationPlanIntentSha256: string;
}>;

export type ReleaseFullMaintenancePrivateValidationIntentExpectation = Readonly<{
  target?: ReleaseFullMaintenancePrivateValidationIntentInput["target"];
  privateApiInventorySha256?: string;
  now?: number;
}>;

export class ReleaseFullMaintenancePrivateValidationIntentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateValidationIntentError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenancePrivateValidationIntentError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", `${label} has unexpected fields`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", "unsupported canonical value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", `${label} must be a SHA-256 digest`);
  }
  return value;
}

function exactText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", `${label} is invalid`);
  return value;
}

function exactPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", `${label} must be a positive integer`);
  }
  return Number(value);
}

function exactPrincipal(
  value: unknown,
  label: string,
  requirePlatformAdmin: boolean,
): ReleaseFullMaintenancePrivateValidationIntentPrincipal {
  exactKeys(value, ["platformRole", "userId", "workspaceId", "workspaceRole"], label);
  const principal = value as unknown as ReleaseFullMaintenancePrivateValidationIntentPrincipal;
  exactPositiveInteger(principal.userId, `${label}.userId`);
  exactText(principal.workspaceId, `${label}.workspaceId`);
  if (
    !["owner", "admin", "developer", "billing", "viewer"].includes(principal.workspaceRole)
    || (!requirePlatformAdmin
      && !["owner", "admin", "developer"].includes(principal.workspaceRole))
    || (requirePlatformAdmin
      ? !["root", "admin", "super_admin"].includes(String(principal.platformRole))
      : principal.platformRole !== null)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", `${label} role commitment is invalid`);
  return principal;
}

export function deriveReleaseFullMaintenancePrivateValidationSeedanceProbeId(
  commitmentWithoutProbe: Omit<
    ReleaseFullMaintenancePrivateValidationIntent,
    "seedanceProbeId" | "validationPlanIntentSha256"
  >,
): string {
  const value = digest({
    purpose: "seedance-provider-certification",
    validationPlanIntent: commitmentWithoutProbe,
  });
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function commitmentFromInput(input: ReleaseFullMaintenancePrivateValidationIntentInput): Omit<
  ReleaseFullMaintenancePrivateValidationIntent,
  "seedanceProbeId" | "validationPlanIntentSha256"
> {
  return {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FORMAT,
    trafficMode: "full-maintenance",
    target: input.target,
    privateApiInventorySha256: input.privateApiInventorySha256,
    principals: input.principals,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    assetVersionId: input.assetVersionId,
    portrait: input.portrait,
    budget: input.budget,
    expiresAt: input.expiresAt,
  };
}

export function createReleaseFullMaintenancePrivateValidationIntent(
  input: ReleaseFullMaintenancePrivateValidationIntentInput,
): ReleaseFullMaintenancePrivateValidationIntent {
  const withoutProbe = commitmentFromInput(input);
  const commitment = {
    ...withoutProbe,
    seedanceProbeId: deriveReleaseFullMaintenancePrivateValidationSeedanceProbeId(withoutProbe),
  };
  return assertReleaseFullMaintenancePrivateValidationIntent({
    ...commitment,
    validationPlanIntentSha256: digest(commitment),
  });
}

export function assertReleaseFullMaintenancePrivateValidationIntent(
  value: unknown,
  expected: ReleaseFullMaintenancePrivateValidationIntentExpectation = {},
): ReleaseFullMaintenancePrivateValidationIntent {
  exactKeys(value, [
    "assetVersionId",
    "budget",
    "expiresAt",
    "format",
    "portrait",
    "principals",
    "privateApiInventorySha256",
    "projectId",
    "seedanceProbeId",
    "target",
    "trafficMode",
    "validationPlanIntentSha256",
    "workspaceId",
  ], "validationPlanIntent");
  const intent = value as unknown as ReleaseFullMaintenancePrivateValidationIntent;
  exactKeys(intent.target, [
    "artifactId", "artifactSha256", "imageDigest", "releaseId", "schemaVersion", "sourceCommit",
  ], "validationPlanIntent.target");
  exactText(intent.target.releaseId, "validationPlanIntent.target.releaseId");
  exactText(intent.target.artifactId, "validationPlanIntent.target.artifactId");
  exactSha256(intent.target.artifactSha256, "validationPlanIntent.target.artifactSha256");
  if (!SOURCE_COMMIT.test(intent.target.sourceCommit) || intent.target.schemaVersion !== 48 || !IMAGE_DIGEST.test(intent.target.imageDigest)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", "validationPlanIntent target identity is invalid");
  }
  exactSha256(intent.privateApiInventorySha256, "validationPlanIntent.privateApiInventorySha256");
  exactKeys(intent.principals, ["admin", "user"], "validationPlanIntent.principals");
  const user = exactPrincipal(intent.principals.user, "validationPlanIntent.principals.user", false);
  const admin = exactPrincipal(intent.principals.admin, "validationPlanIntent.principals.admin", true);
  exactText(intent.workspaceId, "validationPlanIntent.workspaceId");
  if (
    user.userId === admin.userId
    || user.workspaceId !== admin.workspaceId
    || user.workspaceId !== intent.workspaceId
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", "validationPlanIntent principals are not distinct in one exact workspace");
  exactPositiveInteger(intent.projectId, "validationPlanIntent.projectId");
  exactPositiveInteger(intent.assetVersionId, "validationPlanIntent.assetVersionId");
  exactKeys(intent.portrait, [
    "aspectRatio",
    "durationSeconds",
    "expectedProviderAssetUriSha256",
    "expectedProviderChannelIdSha256",
    "expectedProviderSourceSha256",
    "model",
    "modelRouteId",
    "outputResolution",
    "scriptId",
    "trackId",
  ], "validationPlanIntent.portrait");
  exactPositiveInteger(intent.portrait.scriptId, "validationPlanIntent.portrait.scriptId");
  exactPositiveInteger(intent.portrait.trackId, "validationPlanIntent.portrait.trackId");
  exactText(intent.portrait.model, "validationPlanIntent.portrait.model");
  exactText(intent.portrait.modelRouteId, "validationPlanIntent.portrait.modelRouteId");
  exactSha256(intent.portrait.expectedProviderAssetUriSha256, "validationPlanIntent.portrait.expectedProviderAssetUriSha256");
  exactSha256(intent.portrait.expectedProviderSourceSha256, "validationPlanIntent.portrait.expectedProviderSourceSha256");
  exactSha256(intent.portrait.expectedProviderChannelIdSha256, "validationPlanIntent.portrait.expectedProviderChannelIdSha256");
  if (
    intent.portrait.aspectRatio !== "16:9"
    || intent.portrait.durationSeconds !== 4
    || intent.portrait.outputResolution !== "720p"
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", "validationPlanIntent portrait probe is not exact");
  exactKeys(intent.budget, ["currency", "maximumGuMicros", "maximumProviderTasks"], "validationPlanIntent.budget");
  if (
    intent.budget.currency !== "GU"
    || !Number.isSafeInteger(intent.budget.maximumGuMicros)
    || intent.budget.maximumGuMicros < 1
    || intent.budget.maximumProviderTasks !== 2
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", "validationPlanIntent budget is invalid");
  const expiresAt = exactPositiveInteger(intent.expiresAt, "validationPlanIntent.expiresAt");
  if (expected.now !== undefined && expiresAt <= exactPositiveInteger(expected.now, "expected.now")) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_EXPIRED", "validationPlanIntent has expired");
  }
  const { seedanceProbeId, validationPlanIntentSha256, ...withoutProbe } = intent;
  if (
    !SAFE_ID.test(seedanceProbeId)
    || seedanceProbeId
      !== deriveReleaseFullMaintenancePrivateValidationSeedanceProbeId(withoutProbe)
  ) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", "validationPlanIntent Seedance probe is not deterministically derived");
  }
  const commitment = { ...withoutProbe, seedanceProbeId };
  if (exactSha256(validationPlanIntentSha256, "validationPlanIntent.validationPlanIntentSha256") !== digest(commitment)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID", "validationPlanIntent digest is invalid");
  }
  if (expected.target !== undefined && canonicalJson(intent.target) !== canonicalJson(expected.target)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_MISMATCH", "validationPlanIntent target differs from the maintenance contract");
  }
  if (
    expected.privateApiInventorySha256 !== undefined
    && intent.privateApiInventorySha256 !== expected.privateApiInventorySha256
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_MISMATCH", "validationPlanIntent private inventory differs from the maintenance contract");
  return Object.freeze(intent);
}

export function loadReleaseFullMaintenancePrivateValidationIntentFile(input: {
  filePath: string;
  contentSha256: string;
  expectedUid?: number;
  expected?: ReleaseFullMaintenancePrivateValidationIntentExpectation;
}): ReleaseFullMaintenancePrivateValidationIntent {
  if (
    !path.isAbsolute(input.filePath)
    || path.normalize(input.filePath) !== input.filePath
    || input.filePath === path.parse(input.filePath).root
    || /[\0\r\n]/u.test(input.filePath)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FILE_INVALID", "validationPlanIntent path is invalid");
  let descriptor = -1;
  try {
    const resolved = realpathSync(input.filePath);
    if (resolved !== input.filePath) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FILE_INVALID", "validationPlanIntent file must not traverse symlinks");
    descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    const expectedUid = input.expectedUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    const mode = stat.mode & 0o777;
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || ![0o400, 0o600].includes(mode)
      || (expectedUid !== undefined && stat.uid !== expectedUid)
      || stat.size < 2
      || stat.size > MAX_INTENT_BYTES
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FILE_INVALID", "validationPlanIntent file ownership or mode is unsafe");
    const bytes = readFileSync(descriptor);
    if (digestBytes(bytes) !== exactSha256(input.contentSha256, "validationPlanIntent contentSha256")) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FILE_INVALID", "validationPlanIntent content pin differs");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FILE_INVALID", "validationPlanIntent file is not JSON");
    }
    return assertReleaseFullMaintenancePrivateValidationIntent(parsed, input.expected);
  } catch (error) {
    if (error instanceof ReleaseFullMaintenancePrivateValidationIntentError) throw error;
    throw new ReleaseFullMaintenancePrivateValidationIntentError(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTENT_FILE_INVALID",
      "validationPlanIntent file cannot be read safely",
    );
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
