import { createHash } from "node:crypto";

import {
  assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
  releaseFullMaintenancePrivateValidationBudgetSha256,
  type ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
} from "@/lib/releaseFullMaintenancePrivateValidationBudget";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HEADER =
  "x-fanjin-private-validation-budget" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_CLAIM_FORMAT =
  "fanjin-release-full-maintenance-private-validation-portrait-claim/v1" as const;

const MAX_HEADER_LENGTH = 8 * 1024;
const MAX_CANONICAL_BYTES = 6 * 1024;
const RAW_SHA256 = /^[a-f0-9]{64}$/u;

export class ReleaseFullMaintenancePrivateValidationBudgetTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 409 = 409,
  ) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateValidationBudgetTransportError";
  }
}

function fail(
  code: string,
  message: string,
  status: 400 | 403 | 409 = 409,
): never {
  throw new ReleaseFullMaintenancePrivateValidationBudgetTransportError(code, message, status);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
    fail("private_validation_budget_transport_invalid", `${label} is invalid`, 400);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("private_validation_budget_transport_invalid", `${label} is invalid`, 400);
  }
  return Number(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("private_validation_budget_transport_invalid", "portrait request contains a non-safe number", 400);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value !== "object" || value === null) {
    fail("private_validation_budget_transport_invalid", "portrait request is not canonical JSON", 400);
  }
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("private_validation_budget_transport_invalid", "portrait request has an unsafe prototype", 400);
  }
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isLoopbackAddress(value: unknown): boolean {
  const address = String(value || "").trim().toLowerCase();
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

export function createReleaseFullMaintenancePrivateValidationPortraitBudgetClaim(input: {
  releaseBindingSha256: string;
  workspaceId: string;
  projectId: number;
  actorUserId: number;
  idempotencyKey: string;
  body: unknown;
}): Readonly<{ claimKey: string; claimRequestSha256: string }> {
  const releaseBindingSha256 = boundedString(input.releaseBindingSha256, "releaseBindingSha256", 64);
  if (!RAW_SHA256.test(releaseBindingSha256)) {
    fail("private_validation_budget_transport_invalid", "releaseBindingSha256 is invalid", 400);
  }
  const workspaceId = boundedString(input.workspaceId, "workspaceId", 200);
  const projectId = positiveSafeInteger(input.projectId, "projectId");
  const actorUserId = positiveSafeInteger(input.actorUserId, "actorUserId");
  const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey", 200);
  const canonicalBody = canonicalJson(input.body);
  if (Buffer.byteLength(canonicalBody, "utf8") > MAX_CANONICAL_BYTES) {
    fail("private_validation_budget_transport_invalid", "portrait request exceeds the private budget bound", 400);
  }
  return Object.freeze({
    claimKey: `workbench:${idempotencyKey}`,
    claimRequestSha256: releaseFullMaintenancePrivateValidationBudgetSha256({
      format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_CLAIM_FORMAT,
      releaseBindingSha256,
      workspaceId,
      projectId,
      actorUserId,
      idempotencyKey,
      body: JSON.parse(canonicalBody) as unknown,
    }),
  });
}

export function serializeReleaseFullMaintenancePrivateValidationBudgetSlotBinding(
  value: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
): string {
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(value);
  const canonical = canonicalJson(binding);
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.length < 2 || bytes.length > MAX_CANONICAL_BYTES) {
    fail("private_validation_budget_transport_invalid", "budget binding exceeds the private transport bound", 400);
  }
  return bytes.toString("base64url");
}

function parseHeader(
  value: string,
): ReleaseFullMaintenancePrivateValidationBudgetSlotBinding {
  if (
    value.length < 2
    || value.length > MAX_HEADER_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) fail("private_validation_budget_transport_invalid", "private budget header encoding is invalid", 400);
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length < 2
    || bytes.length > MAX_CANONICAL_BYTES
    || bytes.toString("base64url") !== value
  ) fail("private_validation_budget_transport_invalid", "private budget header encoding is non-canonical", 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("private_validation_budget_transport_invalid", "private budget header is not JSON", 400);
  }
  if (Buffer.from(canonicalJson(parsed), "utf8").compare(bytes) !== 0) {
    fail("private_validation_budget_transport_invalid", "private budget header JSON is non-canonical", 400);
  }
  try {
    return assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(parsed);
  } catch {
    fail("private_validation_budget_transport_invalid", "private budget binding is invalid", 400);
  }
}

/**
 * Resolves the optional server-only portrait budget capability. Supplying the
 * header is fail-closed: it is accepted only over the local SSH-forwarded
 * socket and only when every authenticated request fact matches the durable
 * slot claim. The Relay layer performs the authoritative DB re-read.
 */
export function resolveReleaseFullMaintenancePrivateValidationPortraitBudgetBinding(input: {
  header: string | readonly string[] | undefined;
  remoteAddress: string | undefined;
  workspaceId: string;
  projectId: number;
  actorUserId: number;
  idempotencyKey: string;
  body: unknown;
}): ReleaseFullMaintenancePrivateValidationBudgetSlotBinding | null {
  if (input.header === undefined) return null;
  if (Array.isArray(input.header) || typeof input.header !== "string") {
    fail("private_validation_budget_transport_invalid", "private budget header must occur exactly once", 400);
  }
  if (!isLoopbackAddress(input.remoteAddress)) {
    fail("private_validation_budget_transport_not_loopback", "private budget header is restricted to loopback", 403);
  }
  const binding = parseHeader(input.header);
  const workspaceId = boundedString(input.workspaceId, "workspaceId", 200);
  const projectId = positiveSafeInteger(input.projectId, "projectId");
  const actorUserId = positiveSafeInteger(input.actorUserId, "actorUserId");
  const claim = createReleaseFullMaintenancePrivateValidationPortraitBudgetClaim({
    releaseBindingSha256: binding.releaseBindingSha256,
    workspaceId,
    projectId,
    actorUserId,
    idempotencyKey: input.idempotencyKey,
    body: input.body,
  });
  if (
    binding.slot !== "portrait"
    || binding.workspaceId !== workspaceId
    || binding.projectId !== projectId
    || binding.actorUserId !== actorUserId
    || binding.claimKeySha256 !== sha256Text(claim.claimKey)
    || binding.claimRequestSha256 !== claim.claimRequestSha256
  ) fail(
    "private_validation_budget_transport_mismatch",
    "private budget binding differs from the authenticated Workbench request",
    409,
  );
  return binding;
}
