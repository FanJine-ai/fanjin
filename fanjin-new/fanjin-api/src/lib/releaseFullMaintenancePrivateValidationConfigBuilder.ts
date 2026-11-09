import { createHash } from "node:crypto";

import {
  assertReleaseFullMaintenancePrivateValidationBinding,
  assertReleaseFullMaintenancePrivateValidationProductionConfig,
  canonicalReleaseFullMaintenancePrivateValidationJson,
  RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRODUCTION_CONFIG_FORMAT,
  type ReleaseFullMaintenancePrivateValidationBinding,
  type ReleaseFullMaintenancePrivateValidationProductionConfig,
} from "@/lib/releaseFullMaintenancePrivateValidation";
import {
  assertReleaseFullMaintenancePrivateValidationIntent,
  type ReleaseFullMaintenancePrivateValidationIntent,
} from "@/lib/releaseFullMaintenancePrivateValidationIntent";
import type {
  ReleaseFullMaintenancePrivateTransportConfig,
} from "@/lib/releaseFullMaintenancePrivateTransport";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_ENVELOPE_FORMAT =
  "fanjin-release-full-maintenance-private-validation-jit-envelope/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_RESULT_FORMAT =
  "fanjin-release-full-maintenance-private-validation-jit-result/v1" as const;

const MAX_OUTPUT_BYTES = 128 * 1024;

export type ReleaseFullMaintenancePrivateValidationJitEnvelope = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_ENVELOPE_FORMAT;
  bindingSha256: string;
  validationPlanIntentSha256: string;
  issuedAt: number;
  expiresAt: number;
  receiptDirectory: string;
  privateApiNodes: readonly Readonly<{ nodeId: string; baseUrl: string }>[];
  transport: ReleaseFullMaintenancePrivateTransportConfig;
  sessions: ReleaseFullMaintenancePrivateValidationProductionConfig["sessions"];
  portraitRuntime: Readonly<{
    pollTimeoutMs: number;
    pollIntervalMs: number;
  }>;
  seedanceRuntime: Readonly<{
    createdAt: string;
    expiresAt: string;
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

export type InMemoryReleaseFullMaintenancePrivateValidationJitConfig = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_RESULT_FORMAT;
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  canonicalBytes: Buffer;
  contentSha256: string;
}>;

export class ReleaseFullMaintenancePrivateValidationConfigBuilderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateValidationConfigBuilderError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenancePrivateValidationConfigBuilderError(code, message);
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_INPUT_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_INPUT_INVALID", `${label} has unexpected fields`);
  }
}

function rawSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertEnvelopeShape(value: unknown): ReleaseFullMaintenancePrivateValidationJitEnvelope {
  exactKeys(value, [
    "bindingSha256",
    "expiresAt",
    "format",
    "issuedAt",
    "portraitRuntime",
    "privateApiNodes",
    "receiptDirectory",
    "seedanceRuntime",
    "sessions",
    "timeoutMs",
    "transport",
    "validationPlanIntentSha256",
  ], "jitEnvelope");
  const envelope = value as unknown as ReleaseFullMaintenancePrivateValidationJitEnvelope;
  if (envelope.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_ENVELOPE_FORMAT) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_INPUT_INVALID", "JIT envelope format is invalid");
  }
  exactKeys(envelope.portraitRuntime, ["pollIntervalMs", "pollTimeoutMs"], "jitEnvelope.portraitRuntime");
  exactKeys(envelope.seedanceRuntime, [
    "createdAt",
    "expiresAt",
    "pollIntervalMs",
    "priceCheckedAt",
    "priceSourceContentSha256",
    "priceSourceUrl",
    "timeoutMs",
    "upstreamUnitPriceMicros",
    "validUntil",
  ], "jitEnvelope.seedanceRuntime");
  return envelope;
}

export function buildReleaseFullMaintenancePrivateValidationProductionConfig(input: {
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
  protectedEnvelope: ReleaseFullMaintenancePrivateValidationJitEnvelope;
  now: number;
}): ReleaseFullMaintenancePrivateValidationProductionConfig {
  const binding = assertReleaseFullMaintenancePrivateValidationBinding(input.binding, { now: input.now });
  const validationPlanIntent = assertReleaseFullMaintenancePrivateValidationIntent(
    input.validationPlanIntent,
    {
      target: binding.target,
      privateApiInventorySha256: binding.privateApiInventorySha256,
      now: input.now,
    },
  );
  if (
    validationPlanIntent.validationPlanIntentSha256
    !== binding.validationAuthority.validationPlanIntentSha256
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_AUTHORITY_MISMATCH", "frozen intent is not the Root-MFA-authorized binding intent");
  const envelope = assertEnvelopeShape(input.protectedEnvelope);
  const expectedEnvelopeExpiresAt = Math.min(
    envelope.sessions.user.expiresAt,
    envelope.sessions.admin.expiresAt,
    validationPlanIntent.expiresAt,
    binding.validationAuthority.expiresAt,
  );
  if (
    envelope.bindingSha256 !== binding.bindingSha256
    || envelope.validationPlanIntentSha256 !== validationPlanIntent.validationPlanIntentSha256
    || !Number.isSafeInteger(envelope.issuedAt)
    || envelope.issuedAt !== Math.max(envelope.sessions.user.issuedAt, envelope.sessions.admin.issuedAt)
    || envelope.issuedAt < binding.requestedAt
    || envelope.issuedAt > input.now
    || !Number.isSafeInteger(envelope.expiresAt)
    || envelope.expiresAt !== expectedEnvelopeExpiresAt
    || envelope.expiresAt <= input.now + envelope.timeoutMs
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_AUTHORITY_MISMATCH", "JIT envelope is stale or differs from the dynamic binding and frozen intent");
  const authority = binding.validationAuthority;
  const config: ReleaseFullMaintenancePrivateValidationProductionConfig = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRODUCTION_CONFIG_FORMAT,
    receiptDirectory: envelope.receiptDirectory,
    privateApiNodes: envelope.privateApiNodes.map((node) => ({ ...node })),
    transport: envelope.transport,
    sessions: envelope.sessions,
    principals: validationPlanIntent.principals,
    validationPlanIntent,
    rootMfa: {
      proofRecordIdSha256: authority.proofRecordIdSha256,
      scope: authority.scope,
      method: authority.method,
      authorizationRevision: authority.authorizationRevision,
      consumedAt: authority.consumedAt,
      expiresAt: authority.expiresAt,
      confirmationSha256: authority.rootMfaConfirmationSha256,
    },
    budget: {
      currency: validationPlanIntent.budget.currency,
      maximumGuMicros: validationPlanIntent.budget.maximumGuMicros,
      maximumProviderTasks: validationPlanIntent.budget.maximumProviderTasks,
      expiresAt: validationPlanIntent.expiresAt,
    },
    portrait: {
      workspaceId: validationPlanIntent.workspaceId,
      projectId: validationPlanIntent.projectId,
      assetVersionId: validationPlanIntent.assetVersionId,
      ...validationPlanIntent.portrait,
      pollTimeoutMs: envelope.portraitRuntime.pollTimeoutMs,
      pollIntervalMs: envelope.portraitRuntime.pollIntervalMs,
    },
    seedance: {
      productionEnvFile: "/opt/fanjin/shared/env/fanjin.env",
      probeId: validationPlanIntent.seedanceProbeId,
      workspaceId: validationPlanIntent.workspaceId,
      projectId: validationPlanIntent.projectId,
      adminUserId: validationPlanIntent.principals.admin.userId,
      ...envelope.seedanceRuntime,
      upstreamCurrency: "CNY",
      billingCurrency: "GU",
      billingDimension: "token",
    },
    timeoutMs: envelope.timeoutMs,
  };
  return assertReleaseFullMaintenancePrivateValidationProductionConfig({
    value: config,
    binding,
    now: input.now,
  });
}

export function serializeReleaseFullMaintenancePrivateValidationProductionConfig(input: {
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
  protectedEnvelope: ReleaseFullMaintenancePrivateValidationJitEnvelope;
  now: number;
}): InMemoryReleaseFullMaintenancePrivateValidationJitConfig {
  const config = buildReleaseFullMaintenancePrivateValidationProductionConfig(input);
  const canonicalBytes = Buffer.from(
    `${canonicalReleaseFullMaintenancePrivateValidationJson(config)}\n`,
    "utf8",
  );
  if (canonicalBytes.length < 2 || canonicalBytes.length > MAX_OUTPUT_BYTES) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_INPUT_INVALID", "canonical in-memory config is outside protected bounds");
  }
  return Object.freeze({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_JIT_RESULT_FORMAT,
    config,
    canonicalBytes,
    contentSha256: rawSha256(canonicalBytes),
  });
}
