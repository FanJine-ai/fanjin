import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { Knex } from "knex";

import {
  runPortraitLiveSmoke,
  type PortraitLiveSmokeCommand,
  type PortraitLiveSmokeDependencies,
  type PortraitLiveSmokeReceipt,
} from "../../scripts/smoke-portrait-assets-live";
import type {
  Seedance25CertificationOperatorReceipt,
} from "@/lib/seedance25ProductionConfig";
import type {
  VideoGenerationRelayBillingAudit,
} from "@/lib/videoGenerationRelayBillingAudit";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  assertDistinctReleaseFullMaintenancePrivateNodeProofs,
  assertReleaseFullMaintenancePrivateTransportConfig,
  createReleaseFullMaintenancePrivateTransport,
  ReleaseFullMaintenancePrivateTransportError,
  type ReleaseFullMaintenancePrivateNodeProof,
  type ReleaseFullMaintenancePrivateNodeTunnel,
  type ReleaseFullMaintenancePrivateTransport,
  type ReleaseFullMaintenancePrivateTransportConfig,
} from "@/lib/releaseFullMaintenancePrivateTransport";
import {
  assertReleaseFullMaintenancePrivateValidationIntent,
  type ReleaseFullMaintenancePrivateValidationIntent,
  type ReleaseFullMaintenancePrivateValidationIntentPrincipal,
} from "@/lib/releaseFullMaintenancePrivateValidationIntent";
import {
  assertRelayWorkerExecutionAttestation,
  type RelayWorkerExecutionAttestation,
} from "@/lib/relayWorkerExecutionAttestation";
import type {
  ReleaseFullMaintenancePrivateValidationBudgetFinalEvidence,
  ReleaseFullMaintenancePrivateValidationBudgetHandle,
} from "@/lib/releaseFullMaintenancePrivateValidationBudget";

export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_FORMAT =
  "fanjin-release-full-maintenance-private-validation-binding/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_FORMAT =
  "fanjin-release-full-maintenance-private-validation-authority/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EXECUTION_FORMAT =
  "fanjin-release-full-maintenance-private-validation-execution/v2" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CANDIDATE_FORMAT =
  "fanjin-release-full-maintenance-private-validation-candidate/v2" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_FORMAT =
  "fanjin-release-full-maintenance-private-validation-receipt/v2" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_API_INVENTORY_FORMAT =
  "fanjin-release-full-maintenance-private-api-inventory-binding/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLAN_FORMAT =
  "fanjin-release-full-maintenance-private-validation-plan/v2" as const;
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_ATTEMPT_FORMAT =
  "fanjin-release-full-maintenance-private-validation-attempt/v1" as const;
export const RELEASE_FULL_MAINTENANCE_PROTECTED_SESSION_MAX_REMAINING_TTL_MS =
  60 * 60 * 1_000;

const RAW_SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const MAX_RECEIPT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const PRIVATE_API_PORT = "10588";
export const RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRODUCTION_CONFIG_FORMAT =
  "fanjin-release-full-maintenance-private-validation-production-config/v3" as const;

export interface ReleaseFullMaintenancePrivateValidationBinding {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_FORMAT;
  trafficMode: "full-maintenance";
  deploymentId: string;
  contractSha256: string;
  validationAuthority: ReleaseFullMaintenancePrivateValidationAuthority;
  target: {
    releaseId: string;
    artifactId: string;
    artifactSha256: string;
    sourceCommit: string;
    schemaVersion: 48;
    imageDigest: string;
  };
  homogeneousFleetEvidenceSha256: string;
  homogeneousFleetEvidence: HomogeneousFleetProof;
  privateApiInventorySha256: string;
  apiNodeIds: string[];
  workerNodeIds: string[];
  originalWeights: Record<string, number>;
  requestedAt: number;
  bindingSha256: string;
}

export type ReleaseFullMaintenancePrivateValidationBindingInput = Omit<
  ReleaseFullMaintenancePrivateValidationBinding,
  "format" | "trafficMode" | "bindingSha256"
>;

export interface ReleaseFullMaintenancePrivateValidationChecks {
  seedance: {
    receiptSha256: string;
    taskSha256: string;
    providerSha256: string;
    billingSha256: string;
  };
  portrait: {
    admissionSha256: string;
    providerSha256: string;
    generationSha256: string;
    billingSha256: string;
  };
  billing: {
    usageSha256: string;
    ledgerSha256: string;
    exactOnceSha256: string;
  };
}

/**
 * Proof that a production adapter actually started the private validation.
 * `executorEvidenceSha256` is the digest of the adapter's structured trigger
 * transcript; it is never a PASS marker.
 */
export interface ReleaseFullMaintenancePrivateValidationExecution {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EXECUTION_FORMAT;
  trafficMode: "full-maintenance";
  deploymentId: string;
  bindingSha256: string;
  executionId: string;
  startedAt: number;
  privateApiInventorySha256: string;
  validationPlanSha256: string;
  rootMfaConfirmationSha256: string;
  nodeProofsSha256: string;
  executorEvidenceSha256: string;
}

/**
 * An adapter-collected candidate. The library verifies and commits it into the
 * smaller durable receipt. Production adapters must derive every digest from a
 * separate structured upstream/readback record.
 */
export interface ReleaseFullMaintenancePrivateValidationCandidate {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CANDIDATE_FORMAT;
  trafficMode: "full-maintenance";
  deploymentId: string;
  contractSha256: string;
  bindingSha256: string;
  targetArtifactSha256: string;
  executionId: string;
  privateApiInventorySha256: string;
  validationPlanSha256: string;
  rootMfaConfirmationSha256: string;
  nodeProofsSha256: string;
  executorEvidenceSha256: string;
  collectorEvidenceSha256: string;
  structuredEvidence: ReleaseFullMaintenancePrivateValidationStructuredEvidence;
  checks: ReleaseFullMaintenancePrivateValidationChecks;
  observedAt: number;
  verdict: "PASS";
}

export interface ReleaseFullMaintenancePrivateValidationReceipt {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_FORMAT;
  trafficMode: "full-maintenance";
  deploymentId: string;
  contractSha256: string;
  bindingSha256: string;
  targetArtifactSha256: string;
  executionId: string;
  privateApiInventorySha256: string;
  validationPlanSha256: string;
  rootMfaConfirmationSha256: string;
  nodeProofsSha256: string;
  executorEvidenceSha256: string;
  collectorEvidenceSha256: string;
  structuredEvidence: ReleaseFullMaintenancePrivateValidationStructuredEvidence;
  checks: ReleaseFullMaintenancePrivateValidationChecks;
  observedAt: number;
  verdict: "PASS";
  receiptSha256: string;
}

export interface PersistedReleaseFullMaintenancePrivateValidationReceipt {
  receipt: ReleaseFullMaintenancePrivateValidationReceipt;
  filePath: string;
  contentSha256: string;
}

export type ReleaseFullMaintenancePrivateValidationEvidenceManifest = Readonly<{
  format: "fanjin-release-full-maintenance-private-validation-evidence-manifest/v1";
  ownerUid: number;
  files: Readonly<{
    receipt: Readonly<{ basename: string; contentSha256: string; byteLength: number }>;
    executor: Readonly<{ basename: string; contentSha256: string; byteLength: number }>;
    collector: Readonly<{ basename: string; contentSha256: string; byteLength: number }>;
  }>;
  businessEvidenceSha256: string;
  manifestSha256: string;
}>;

export type RootVerifiedPersistedReleaseFullMaintenancePrivateValidationReceipt =
  PersistedReleaseFullMaintenancePrivateValidationReceipt & Readonly<{
    evidenceManifest: ReleaseFullMaintenancePrivateValidationEvidenceManifest;
  }>;

export interface PersistedReleaseFullMaintenancePrivateValidationBinding {
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  filePath: string;
  contentSha256: string;
}

export interface ReleaseFullMaintenancePrivateValidationExecutionContext {
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  deadlineAt: number;
  signal: AbortSignal;
}

export interface ReleaseFullMaintenancePrivateValidationExecutor {
  execute(
    context: ReleaseFullMaintenancePrivateValidationExecutionContext,
  ): Promise<ReleaseFullMaintenancePrivateValidationExecution>;
}

export interface ReleaseFullMaintenancePrivateValidationCollector {
  collect(context: ReleaseFullMaintenancePrivateValidationExecutionContext & {
    execution: ReleaseFullMaintenancePrivateValidationExecution;
  }): Promise<ReleaseFullMaintenancePrivateValidationCandidate>;
}

export interface ReleaseFullMaintenancePrivateValidationOptions {
  executor: ReleaseFullMaintenancePrivateValidationExecutor;
  collector: ReleaseFullMaintenancePrivateValidationCollector;
  receiptDirectory: string;
  timeoutMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

type ProtectedSession = Readonly<{
  token: string;
  issuedAt: number;
  expiresAt: number;
  purpose: "full-maintenance-private-validation";
}>;

export type ReleaseFullMaintenancePrivateApiOrigin = Readonly<{
  nodeId: string;
  origin: string;
}>;

export type ReleaseFullMaintenancePrivateApiInventoryCommitment = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_API_INVENTORY_FORMAT;
  nodeIdToOrigin: Readonly<Record<string, string>>;
}>;

export type ReleaseFullMaintenanceHomogeneousFleetProof = Readonly<{
  format: "fanjin-release-maintenance-homogeneous-fleet/v2";
  deploymentId: string;
  prestageEvidenceSha256: string;
  inventorySha256: string;
  target: Readonly<{
    releaseId: string;
    artifactSha256: string;
    sourceCommit: string;
    schemaVersion: 48;
    deploymentMode: "container-image";
    imageDigest: string;
  }>;
  loadBalancerWeightEvidenceSha256: string;
  loadBalancer: readonly Readonly<{ nodeId: string; weight: 0 }>[];
  api: readonly Readonly<{ nodeId: string; activationBindingSha256: string }>[];
  workers: readonly Readonly<{
    nodeId: string;
    activationBindingSha256: string;
    heartbeatAt: number;
  }>[];
  targetEvidenceSha256ByKey: Readonly<Record<string, string>>;
  observedAt: number;
  evidenceSha256: string;
}>;

type HomogeneousFleetProof = ReleaseFullMaintenanceHomogeneousFleetProof;

export interface ReleaseFullMaintenancePrivateValidationProductionConfig {
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRODUCTION_CONFIG_FORMAT;
  receiptDirectory: string;
  privateApiNodes: Array<Readonly<{ nodeId: string; baseUrl: string }>>;
  transport: ReleaseFullMaintenancePrivateTransportConfig;
  sessions: Readonly<{
    user: ProtectedSession;
    admin: ProtectedSession;
  }>;
  principals: Readonly<{
    user: ReleaseFullMaintenancePrivateValidationPrincipal;
    admin: ReleaseFullMaintenancePrivateValidationPrincipal;
  }>;
  validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
  rootMfa: ReleaseFullMaintenancePrivateValidationRootMfaConfirmation;
  budget: Readonly<{
    currency: "GU";
    maximumGuMicros: number;
    maximumProviderTasks: 2;
    expiresAt: number;
  }>;
  portrait: Readonly<{
    workspaceId: string;
    projectId: number;
    assetVersionId: number;
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
    pollTimeoutMs: number;
    pollIntervalMs: number;
  }>;
  seedance: Readonly<{
    productionEnvFile: string;
    probeId: string;
    workspaceId: string;
    projectId: number;
    adminUserId: number;
    createdAt: string;
    expiresAt: string;
    priceSourceUrl: string;
    priceSourceContentSha256: string;
    priceCheckedAt: string;
    upstreamCurrency: "CNY";
    upstreamUnitPriceMicros: number;
    billingCurrency: "GU";
    billingDimension: "token";
    validUntil: string;
    pollIntervalMs: number;
    timeoutMs: number;
  }>;
  timeoutMs: number;
}

export type ReleaseFullMaintenancePrivateValidationPrincipal =
  ReleaseFullMaintenancePrivateValidationIntentPrincipal;

export type ReleaseFullMaintenancePrivateValidationRootMfaConfirmation = Readonly<{
  proofRecordIdSha256: string;
  scope: "admin.deployment";
  method: "totp" | "recovery";
  authorizationRevision: number;
  consumedAt: number;
  expiresAt: number;
  confirmationSha256: string;
}>;

export type ReleaseFullMaintenancePrivateValidationAuthority = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_FORMAT;
  deploymentId: string;
  contractSha256: string;
  validationPlanIntentSha256: string;
  proofRecordIdSha256: string;
  scope: "admin.deployment";
  method: "totp" | "recovery";
  authorizationRevision: number;
  consumedAt: number;
  expiresAt: number;
  rootMfaConfirmationSha256: string;
}>;

export type ReleaseFullMaintenancePrivateValidationPlan = Readonly<{
  format: typeof RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLAN_FORMAT;
  trafficMode: "full-maintenance";
  deploymentId: string;
  contractSha256: string;
  bindingSha256: string;
  validationPlanIntentSha256: string;
  rootMfaConfirmationSha256: string;
  privateApiInventorySha256: string;
  principals: Readonly<{
    user: ReleaseFullMaintenancePrivateValidationPrincipal;
    admin: ReleaseFullMaintenancePrivateValidationPrincipal;
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
  seedanceProbeId: string;
  maximumGuMicros: number;
  maximumProviderTasks: 2;
  expiresAt: number;
  validationPlanSha256: string;
}>;

export type ReleaseFullMaintenancePrivateValidationStructuredEvidence = Readonly<{
  validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
  validationPlan: ReleaseFullMaintenancePrivateValidationPlan;
  nodeProofs: readonly ReleaseFullMaintenancePrivateNodeProof[];
  budgetFinalEvidence: ReleaseFullMaintenancePrivateValidationBudgetFinalEvidence;
}>;

export interface ReleaseFullMaintenancePrivateValidationProductionAdapter {
  executor: ReleaseFullMaintenancePrivateValidationExecutor;
  collector: ReleaseFullMaintenancePrivateValidationCollector;
  receiptDirectory: string;
  timeoutMs: number;
  destroy(): Promise<void>;
}

export class ReleaseFullMaintenancePrivateValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReleaseFullMaintenancePrivateValidationError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseFullMaintenancePrivateValidationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SHAPE_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SHAPE_INVALID", `${label} has unexpected fields`);
}

function exactText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", `${label} is invalid`);
  return value;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !RAW_SHA256.test(value)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID", `${label} is not an exact SHA-256 digest`);
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIME_INVALID", `${label} is invalid`);
  }
  return Number(value);
}

function exactPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SHAPE_INVALID", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

export function canonicalReleaseFullMaintenancePrivateValidationJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SHAPE_INVALID", "unsupported canonical value");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalReleaseFullMaintenancePrivateValidationJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalReleaseFullMaintenancePrivateValidationJson(record[key])}`)
    .join(",")}}`;
}

export function releaseFullMaintenancePrivateValidationSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalReleaseFullMaintenancePrivateValidationJson(value), "utf8")
    .digest("hex");
}

function rawSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createReleaseFullMaintenancePrivateValidationAuthority(input: {
  deploymentId: string;
  contractSha256: string;
  validationPlanIntentSha256: string;
  authorization: Readonly<{
    proofRecordId: string;
    scope: "admin.deployment";
    method: "totp" | "recovery";
    authorizationRevision: number;
    consumedAt: number;
    expiresAt: number;
  }>;
}): ReleaseFullMaintenancePrivateValidationAuthority {
  const commitment = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_FORMAT,
    deploymentId: exactText(input.deploymentId, "validationAuthority.deploymentId"),
    contractSha256: exactSha256(input.contractSha256, "validationAuthority.contractSha256"),
    validationPlanIntentSha256: exactSha256(
      input.validationPlanIntentSha256,
      "validationAuthority.validationPlanIntentSha256",
    ),
    proofRecordIdSha256: rawSha256(exactText(
      input.authorization.proofRecordId,
      "validationAuthority.authorization.proofRecordId",
    )),
    scope: input.authorization.scope,
    method: input.authorization.method,
    authorizationRevision: input.authorization.authorizationRevision,
    consumedAt: input.authorization.consumedAt,
    expiresAt: input.authorization.expiresAt,
  };
  return assertReleaseFullMaintenancePrivateValidationAuthority({
    ...commitment,
    rootMfaConfirmationSha256: releaseFullMaintenancePrivateValidationSha256(commitment),
  }, {
    deploymentId: commitment.deploymentId,
    contractSha256: commitment.contractSha256,
    validationPlanIntentSha256: commitment.validationPlanIntentSha256,
  });
}

export function assertReleaseFullMaintenancePrivateValidationAuthority(
  value: unknown,
  expected: Readonly<{
    deploymentId: string;
    contractSha256: string;
    validationPlanIntentSha256?: string;
  }>,
): ReleaseFullMaintenancePrivateValidationAuthority {
  assertExactKeys(value, [
    "authorizationRevision",
    "consumedAt",
    "contractSha256",
    "deploymentId",
    "expiresAt",
    "format",
    "method",
    "proofRecordIdSha256",
    "rootMfaConfirmationSha256",
    "scope",
    "validationPlanIntentSha256",
  ], "validationAuthority");
  const authority = value as unknown as ReleaseFullMaintenancePrivateValidationAuthority;
  const consumedAt = exactTimestamp(authority.consumedAt, "validationAuthority.consumedAt");
  const expiresAt = exactTimestamp(authority.expiresAt, "validationAuthority.expiresAt");
  if (
    authority.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_FORMAT
    || exactText(authority.deploymentId, "validationAuthority.deploymentId") !== expected.deploymentId
    || exactSha256(authority.contractSha256, "validationAuthority.contractSha256") !== expected.contractSha256
    || (expected.validationPlanIntentSha256 !== undefined
      && authority.validationPlanIntentSha256 !== expected.validationPlanIntentSha256)
    || authority.scope !== "admin.deployment"
    || !["totp", "recovery"].includes(authority.method)
    || !Number.isSafeInteger(authority.authorizationRevision)
    || authority.authorizationRevision < 1
    || consumedAt >= expiresAt
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_INVALID", "validation authority does not match the immutable reservation");
  exactSha256(authority.validationPlanIntentSha256, "validationAuthority.validationPlanIntentSha256");
  exactSha256(authority.proofRecordIdSha256, "validationAuthority.proofRecordIdSha256");
  const { rootMfaConfirmationSha256, ...commitment } = authority;
  if (
    exactSha256(rootMfaConfirmationSha256, "validationAuthority.rootMfaConfirmationSha256")
    !== releaseFullMaintenancePrivateValidationSha256(commitment)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_INVALID", "validation authority digest is invalid");
  return Object.freeze(authority);
}

export function createReleaseFullMaintenancePrivateValidationPlan(input: {
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
}): ReleaseFullMaintenancePrivateValidationPlan {
  const commitment = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLAN_FORMAT,
    trafficMode: "full-maintenance" as const,
    deploymentId: input.binding.deploymentId,
    contractSha256: input.binding.contractSha256,
    bindingSha256: input.binding.bindingSha256,
    validationPlanIntentSha256: input.config.validationPlanIntent.validationPlanIntentSha256,
    rootMfaConfirmationSha256: input.config.rootMfa.confirmationSha256,
    privateApiInventorySha256: input.binding.privateApiInventorySha256,
    principals: input.config.principals,
    workspaceId: input.config.portrait.workspaceId,
    projectId: input.config.portrait.projectId,
    assetVersionId: input.config.portrait.assetVersionId,
    portrait: {
      scriptId: input.config.portrait.scriptId,
      trackId: input.config.portrait.trackId,
      model: input.config.portrait.model,
      modelRouteId: input.config.portrait.modelRouteId,
      expectedProviderAssetUriSha256: input.config.portrait.expectedProviderAssetUriSha256,
      expectedProviderSourceSha256: input.config.portrait.expectedProviderSourceSha256,
      expectedProviderChannelIdSha256: input.config.portrait.expectedProviderChannelIdSha256,
      aspectRatio: input.config.portrait.aspectRatio,
      durationSeconds: input.config.portrait.durationSeconds,
      outputResolution: input.config.portrait.outputResolution,
    },
    seedanceProbeId: input.config.validationPlanIntent.seedanceProbeId,
    maximumGuMicros: input.config.budget.maximumGuMicros,
    maximumProviderTasks: input.config.budget.maximumProviderTasks,
    expiresAt: input.config.budget.expiresAt,
  };
  return Object.freeze({
    ...commitment,
    validationPlanSha256: releaseFullMaintenancePrivateValidationSha256(commitment),
  });
}

function privateApiInventoryCommitment(
  entries: readonly ReleaseFullMaintenancePrivateApiOrigin[],
): ReleaseFullMaintenancePrivateApiInventoryCommitment {
  if (!Array.isArray(entries) || entries.length < 1) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID",
      "private API inventory is empty",
    );
  }
  const normalized = entries.map((entry, index) => {
    assertExactKeys(entry, ["nodeId", "origin"], `privateApiInventory[${index}]`);
    return {
      nodeId: exactText(entry.nodeId, `privateApiInventory[${index}].nodeId`),
      origin: exactPrivateApiOrigin(
        entry.origin,
        `privateApiInventory[${index}].origin`,
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID",
      ),
    };
  }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (
    new Set(normalized.map(({ nodeId }) => nodeId)).size !== normalized.length
    || new Set(normalized.map(({ origin }) => origin)).size !== normalized.length
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID",
    "private API node-to-origin mapping is not one-to-one",
  );
  return Object.freeze({
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_API_INVENTORY_FORMAT,
    nodeIdToOrigin: Object.freeze(Object.fromEntries(
      normalized.map(({ nodeId, origin }) => [nodeId, origin] as const),
    )),
  });
}

export function releaseFullMaintenancePrivateApiInventorySha256(
  entries: readonly ReleaseFullMaintenancePrivateApiOrigin[],
): string {
  return releaseFullMaintenancePrivateValidationSha256(
    privateApiInventoryCommitment(entries),
  );
}

function sortedUniqueNodeIds(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length < 1) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", `${label} is empty`);
  }
  const normalized = values.map((value, index) => exactText(value, `${label}[${index}]`));
  const sorted = [...normalized].sort();
  if (
    new Set(sorted).size !== sorted.length
    || normalized.some((value, index) => value !== sorted[index])
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", `${label} must be sorted and unique`);
  return sorted;
}

function canonicalWeights(
  weights: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(Object.entries(weights).sort(([left], [right]) => left.localeCompare(right)));
}

export function createReleaseFullMaintenancePrivateValidationBinding(
  input: ReleaseFullMaintenancePrivateValidationBindingInput,
): ReleaseFullMaintenancePrivateValidationBinding {
  if (!isRecord(input)) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", "binding input is invalid");
  const target = input.target;
  const apiNodeIds = [...input.apiNodeIds].sort();
  const workerNodeIds = [...input.workerNodeIds].sort();
  const commitment = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_FORMAT,
    trafficMode: "full-maintenance" as const,
    deploymentId: input.deploymentId,
    contractSha256: input.contractSha256,
    validationAuthority: input.validationAuthority,
    target: {
      releaseId: target.releaseId,
      artifactId: target.artifactId,
      artifactSha256: target.artifactSha256,
      sourceCommit: target.sourceCommit,
      schemaVersion: target.schemaVersion,
      imageDigest: target.imageDigest,
    },
    homogeneousFleetEvidenceSha256: input.homogeneousFleetEvidenceSha256,
    homogeneousFleetEvidence: input.homogeneousFleetEvidence,
    privateApiInventorySha256: input.privateApiInventorySha256,
    apiNodeIds,
    workerNodeIds,
    originalWeights: canonicalWeights(input.originalWeights),
    requestedAt: input.requestedAt,
  };
  const binding = {
    ...commitment,
    bindingSha256: releaseFullMaintenancePrivateValidationSha256(commitment),
  };
  return assertReleaseFullMaintenancePrivateValidationBinding(binding);
}

export function assertReleaseFullMaintenancePrivateValidationBinding(
  value: unknown,
  options: { now?: number } = {},
): ReleaseFullMaintenancePrivateValidationBinding {
  assertExactKeys(value, [
    "format",
    "trafficMode",
    "deploymentId",
    "contractSha256",
    "validationAuthority",
    "target",
    "homogeneousFleetEvidenceSha256",
    "homogeneousFleetEvidence",
    "privateApiInventorySha256",
    "apiNodeIds",
    "workerNodeIds",
    "originalWeights",
    "requestedAt",
    "bindingSha256",
  ], "binding");
  const binding = value as unknown as ReleaseFullMaintenancePrivateValidationBinding;
  if (
    binding.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_FORMAT
    || binding.trafficMode !== "full-maintenance"
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", "binding mode or format is invalid");
  exactText(binding.deploymentId, "binding.deploymentId");
  exactSha256(binding.contractSha256, "binding.contractSha256");
  assertReleaseFullMaintenancePrivateValidationAuthority(
    binding.validationAuthority,
    { deploymentId: binding.deploymentId, contractSha256: binding.contractSha256 },
  );
  exactSha256(binding.homogeneousFleetEvidenceSha256, "binding.homogeneousFleetEvidenceSha256");
  exactSha256(binding.privateApiInventorySha256, "binding.privateApiInventorySha256");
  assertHomogeneousFleetProof({ value: binding.homogeneousFleetEvidence, binding });
  assertExactKeys(binding.target, [
    "releaseId",
    "artifactId",
    "artifactSha256",
    "sourceCommit",
    "schemaVersion",
    "imageDigest",
  ], "binding.target");
  exactText(binding.target.releaseId, "binding.target.releaseId");
  exactText(binding.target.artifactId, "binding.target.artifactId");
  exactSha256(binding.target.artifactSha256, "binding.target.artifactSha256");
  if (!SOURCE_COMMIT.test(binding.target.sourceCommit)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", "binding.target.sourceCommit is invalid");
  }
  if (binding.target.schemaVersion !== 48 || !IMAGE_DIGEST.test(binding.target.imageDigest)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", "binding target schema or image is invalid");
  }
  const apiNodeIds = sortedUniqueNodeIds(binding.apiNodeIds, "binding.apiNodeIds");
  const workerNodeIds = sortedUniqueNodeIds(binding.workerNodeIds, "binding.workerNodeIds");
  if (apiNodeIds.some((nodeId) => workerNodeIds.includes(nodeId))) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", "API and Worker inventories overlap");
  }
  if (!isRecord(binding.originalWeights)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", "binding.originalWeights is invalid");
  }
  const weightNodeIds = Object.keys(binding.originalWeights).sort();
  if (
    weightNodeIds.length !== apiNodeIds.length
    || weightNodeIds.some((nodeId, index) => nodeId !== apiNodeIds[index])
    || weightNodeIds.some((nodeId) => (
      !Number.isSafeInteger(binding.originalWeights[nodeId])
      || binding.originalWeights[nodeId] < 1
      || binding.originalWeights[nodeId] > 100
    ))
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", "original weights do not exactly bind the API inventory");
  const requestedAt = exactTimestamp(binding.requestedAt, "binding.requestedAt");
  if (options.now !== undefined && requestedAt > options.now) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIME_INVALID", "binding is from the future");
  }
  const { bindingSha256, ...commitment } = binding;
  if (
    exactSha256(bindingSha256, "binding.bindingSha256")
    !== releaseFullMaintenancePrivateValidationSha256(commitment)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_INVALID", "binding digest differs from its exact commitment");
  return binding;
}

export function persistReleaseFullMaintenancePrivateValidationBinding(input: {
  directory: string;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): PersistedReleaseFullMaintenancePrivateValidationBinding {
  const binding = assertReleaseFullMaintenancePrivateValidationBinding(input.binding, { now: input.now });
  const directory = protectedReceiptDirectory(input.directory);
  const bytes = Buffer.from(`${canonicalReleaseFullMaintenancePrivateValidationJson(binding)}\n`, "utf8");
  if (bytes.length > MAX_RECEIPT_BYTES) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "binding exceeds the protected size limit");
  }
  const filePath = path.join(directory, `${binding.bindingSha256}.json`);
  const fromExisting = (): PersistedReleaseFullMaintenancePrivateValidationBinding => {
    const existing = readProtectedReceipt(filePath);
    if (!existing.equals(bytes)) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BINDING_CONFLICT", "binding identity already exists with different bytes");
    }
    return { binding, filePath, contentSha256: rawSha256(existing) };
  };
  try {
    statSync(filePath);
    return fromExisting();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "required no-follow filesystem flags are unavailable");
  }
  const temporaryPath = path.join(
    directory,
    `.${binding.bindingSha256}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written < 1) {
        fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_FAILED", "binding write made no progress");
      }
      offset += written;
    }
    fsyncSync(descriptor);
    const temporary = fstatSync(descriptor);
    assertOwner(temporary.uid, "temporary binding");
    if (
      !temporary.isFile()
      || temporary.nlink !== 1
      || (temporary.mode & 0o777) !== 0o600
      || temporary.size !== bytes.length
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_FAILED", "temporary binding is unsafe");
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      unlinkSync(temporaryPath);
      return fromExisting();
    }
    unlinkSync(temporaryPath);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return fromExisting();
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* best-effort owner-only temp cleanup */ }
    throw error;
  }
}

function evidenceDigests(checks: ReleaseFullMaintenancePrivateValidationChecks): string[] {
  return [
    checks.seedance.receiptSha256,
    checks.seedance.taskSha256,
    checks.seedance.providerSha256,
    checks.seedance.billingSha256,
    checks.portrait.admissionSha256,
    checks.portrait.providerSha256,
    checks.portrait.generationSha256,
    checks.portrait.billingSha256,
    checks.billing.usageSha256,
    checks.billing.ledgerSha256,
    checks.billing.exactOnceSha256,
  ];
}

const TRIVIAL_EVIDENCE_DIGESTS = new Set([
  "",
  "PASS",
  "pass",
  "OK",
  "ok",
  "true",
  "false",
  "null",
  "{}",
  "[]",
].map((value) => rawSha256(value)));

function exactNonTrivialEvidenceSha256(value: unknown, label: string): string {
  const digest = exactSha256(value, label);
  if (TRIVIAL_EVIDENCE_DIGESTS.has(digest)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID", `${label} is trivial`);
  }
  return digest;
}

function assertChecks(
  value: unknown,
  extraDigests: readonly string[] = [],
): ReleaseFullMaintenancePrivateValidationChecks {
  assertExactKeys(value, ["seedance", "portrait", "billing"], "checks");
  const checks = value as unknown as ReleaseFullMaintenancePrivateValidationChecks;
  assertExactKeys(checks.seedance, [
    "receiptSha256",
    "taskSha256",
    "providerSha256",
    "billingSha256",
  ], "checks.seedance");
  assertExactKeys(checks.portrait, [
    "admissionSha256",
    "providerSha256",
    "generationSha256",
    "billingSha256",
  ], "checks.portrait");
  assertExactKeys(checks.billing, ["usageSha256", "ledgerSha256", "exactOnceSha256"], "checks.billing");
  const digests = evidenceDigests(checks).map((digest, index) => (
    exactNonTrivialEvidenceSha256(digest, `checks[${index}]`)
  ));
  if (
    new Set([...digests, ...extraDigests]).size !== digests.length + extraDigests.length
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID", "validation evidence is trivial or reused across distinct checks");
  return checks;
}

function assertExecution(input: {
  execution: unknown;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): ReleaseFullMaintenancePrivateValidationExecution {
  assertExactKeys(input.execution, [
    "format",
    "trafficMode",
    "deploymentId",
    "bindingSha256",
    "executionId",
    "startedAt",
    "privateApiInventorySha256",
    "validationPlanSha256",
    "rootMfaConfirmationSha256",
    "nodeProofsSha256",
    "executorEvidenceSha256",
  ], "execution");
  const execution = input.execution as unknown as ReleaseFullMaintenancePrivateValidationExecution;
  if (
    execution.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EXECUTION_FORMAT
    || execution.trafficMode !== "full-maintenance"
    || execution.deploymentId !== input.binding.deploymentId
    || execution.bindingSha256 !== input.binding.bindingSha256
    || execution.privateApiInventorySha256 !== input.binding.privateApiInventorySha256
    || !SAFE_EXECUTION_ID.test(execution.executionId)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EXECUTION_INVALID", "executor result is not exactly bound");
  const startedAt = exactTimestamp(execution.startedAt, "execution.startedAt");
  if (startedAt < input.binding.requestedAt || startedAt > input.now) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIME_INVALID", "execution timestamp is outside the binding window");
  }
  const privateApiInventoryDigest = exactNonTrivialEvidenceSha256(
    execution.privateApiInventorySha256,
    "execution.privateApiInventorySha256",
  );
  const validationPlanDigest = exactNonTrivialEvidenceSha256(
    execution.validationPlanSha256,
    "execution.validationPlanSha256",
  );
  const rootMfaDigest = exactNonTrivialEvidenceSha256(
    execution.rootMfaConfirmationSha256,
    "execution.rootMfaConfirmationSha256",
  );
  const nodeProofsDigest = exactNonTrivialEvidenceSha256(
    execution.nodeProofsSha256,
    "execution.nodeProofsSha256",
  );
  const executorDigest = exactNonTrivialEvidenceSha256(
    execution.executorEvidenceSha256,
    "execution.executorEvidenceSha256",
  );
  if (new Set([
    privateApiInventoryDigest,
    validationPlanDigest,
    rootMfaDigest,
    nodeProofsDigest,
    executorDigest,
  ]).size !== 5) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID", "executor and private API inventory evidence are reused");
  }
  return execution;
}

function assertReleaseFullMaintenancePrivateValidationBudgetFinalEvidence(input: {
  value: unknown;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  plan: ReleaseFullMaintenancePrivateValidationPlan;
}): ReleaseFullMaintenancePrivateValidationBudgetFinalEvidence {
  assertExactKeys(input.value, [
    "format",
    "budgetId",
    "deploymentId",
    "releaseBindingSha256",
    "validationPlanSha256",
    "workspaceId",
    "projectId",
    "maximumProviderTasks",
    "maximumGuMicros",
    "providerTaskCount",
    "totalReservedGuMicros",
    "totalActualGuMicros",
    "checkpointSha256",
    "slots",
    "evidenceSha256",
  ], "structuredEvidence.budgetFinalEvidence");
  const evidence = input.value as unknown as ReleaseFullMaintenancePrivateValidationBudgetFinalEvidence;
  const { evidenceSha256, ...commitment } = evidence;
  if (
    evidence.format !== "fanjin-release-full-maintenance-private-validation-budget-final/v1"
    || !exactText(evidence.budgetId, "structuredEvidence.budgetFinalEvidence.budgetId")
    || evidence.deploymentId !== input.binding.deploymentId
    || evidence.releaseBindingSha256 !== input.binding.bindingSha256
    || evidence.validationPlanSha256 !== input.plan.validationPlanSha256
    || evidence.workspaceId !== input.plan.workspaceId
    || evidence.projectId !== input.plan.projectId
    || evidence.maximumProviderTasks !== 2
    || evidence.maximumProviderTasks !== input.plan.maximumProviderTasks
    || evidence.maximumGuMicros !== input.plan.maximumGuMicros
    || evidence.providerTaskCount !== 2
    || !Number.isSafeInteger(evidence.totalReservedGuMicros)
    || evidence.totalReservedGuMicros < 1
    || evidence.totalReservedGuMicros > evidence.maximumGuMicros
    || !Number.isSafeInteger(evidence.totalActualGuMicros)
    || evidence.totalActualGuMicros < 0
    || evidence.totalActualGuMicros > evidence.totalReservedGuMicros
    || !RAW_SHA256.test(String(evidence.checkpointSha256 || ""))
    || !RAW_SHA256.test(String(evidenceSha256 || ""))
    || evidenceSha256 !== releaseFullMaintenancePrivateValidationSha256(commitment)
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_INVALID",
    "durable validation budget final evidence differs from its binding or committed ceiling",
  );
  if (!Array.isArray(evidence.slots) || evidence.slots.length !== 2) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_INVALID", "durable validation budget must contain exactly two slots");
  }
  const expectedSlots = ["seedance", "portrait"] as const;
  const taskIds = new Set<string>();
  const requestIds = new Set<string>();
  const providerTaskIds = new Set<string>();
  const reservationIds = new Set<string>();
  const usageRecordIds = new Set<string>();
  const reconcileJobIds = new Set<string>();
  const terminalLedgerIds = new Set<string>();
  let totalReservedGuMicros = 0;
  let totalActualGuMicros = 0;
  evidence.slots.forEach((slot, index) => {
    assertExactKeys(slot as unknown, [
      "slot",
      "taskId",
      "requestId",
      "providerTaskIdSha256",
      "reservationId",
      "usageRecordId",
      "reservedGuMicros",
      "actualGuMicros",
      "terminalLedgerIds",
      "reconcileJobId",
      "evidenceSha256",
    ], `structuredEvidence.budgetFinalEvidence.slots[${index}]`);
    const values = [
      exactText(slot.taskId, `budget slot ${index} taskId`),
      exactText(slot.requestId, `budget slot ${index} requestId`),
      exactText(slot.reservationId, `budget slot ${index} reservationId`),
      exactText(slot.usageRecordId, `budget slot ${index} usageRecordId`),
      exactText(slot.reconcileJobId, `budget slot ${index} reconcileJobId`),
    ];
    if (
      slot.slot !== expectedSlots[index]
      || !RAW_SHA256.test(String(slot.providerTaskIdSha256 || ""))
      || !RAW_SHA256.test(String(slot.evidenceSha256 || ""))
      || !Number.isSafeInteger(slot.reservedGuMicros)
      || slot.reservedGuMicros < 1
      || !Number.isSafeInteger(slot.actualGuMicros)
      || slot.actualGuMicros < 0
      || slot.actualGuMicros > slot.reservedGuMicros
      || !Array.isArray(slot.terminalLedgerIds)
      || slot.terminalLedgerIds.length < 1
      || slot.terminalLedgerIds.length > 2
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_INVALID", "durable validation budget slot is invalid");
    const [taskId, requestId, reservationId, usageRecordId, reconcileJobId] = values;
    if (
      taskIds.has(taskId)
      || requestIds.has(requestId)
      || providerTaskIds.has(slot.providerTaskIdSha256)
      || reservationIds.has(reservationId)
      || usageRecordIds.has(usageRecordId)
      || reconcileJobIds.has(reconcileJobId)
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_INVALID", "durable validation budget reused a provider or billing identity");
    taskIds.add(taskId);
    requestIds.add(requestId);
    providerTaskIds.add(slot.providerTaskIdSha256);
    reservationIds.add(reservationId);
    usageRecordIds.add(usageRecordId);
    reconcileJobIds.add(reconcileJobId);
    for (const ledgerIdValue of slot.terminalLedgerIds) {
      const ledgerId = exactText(ledgerIdValue, `budget slot ${index} terminalLedgerId`);
      if (terminalLedgerIds.has(ledgerId)) {
        fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_INVALID", "durable validation budget reused a terminal ledger identity");
      }
      terminalLedgerIds.add(ledgerId);
    }
    totalReservedGuMicros += slot.reservedGuMicros;
    totalActualGuMicros += slot.actualGuMicros;
  });
  if (
    totalReservedGuMicros !== evidence.totalReservedGuMicros
    || totalActualGuMicros !== evidence.totalActualGuMicros
    || new Set([
      evidence.evidenceSha256,
      evidence.checkpointSha256,
      ...evidence.slots.map((slot) => slot.evidenceSha256),
      ...evidence.slots.map((slot) => slot.providerTaskIdSha256),
    ]).size !== 6
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_INVALID", "durable validation budget totals or evidence purposes are inconsistent");
  return evidence;
}

function assertStructuredEvidence(input: {
  value: unknown;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  validationPlanSha256: string;
  rootMfaConfirmationSha256: string;
  nodeProofsSha256: string;
  now: number;
}): ReleaseFullMaintenancePrivateValidationStructuredEvidence {
  assertExactKeys(input.value, ["validationPlanIntent", "validationPlan", "nodeProofs", "budgetFinalEvidence"], "structuredEvidence");
  const evidence = input.value as unknown as ReleaseFullMaintenancePrivateValidationStructuredEvidence;
  const intent = assertReleaseFullMaintenancePrivateValidationIntent(
    evidence.validationPlanIntent,
    {
      target: input.binding.target,
      privateApiInventorySha256: input.binding.privateApiInventorySha256,
      now: input.now,
    },
  );
  if (
    intent.validationPlanIntentSha256
    !== input.binding.validationAuthority.validationPlanIntentSha256
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_INVALID", "structured validation intent differs from the immutable reservation authority");
  const plan = evidence.validationPlan;
  assertExactKeys(plan, [
    "format",
    "trafficMode",
    "deploymentId",
    "contractSha256",
    "bindingSha256",
    "validationPlanIntentSha256",
    "rootMfaConfirmationSha256",
    "privateApiInventorySha256",
    "principals",
    "workspaceId",
    "projectId",
    "assetVersionId",
    "portrait",
    "seedanceProbeId",
    "maximumGuMicros",
    "maximumProviderTasks",
    "expiresAt",
    "validationPlanSha256",
  ], "structuredEvidence.validationPlan");
  assertExactKeys(plan.principals, ["user", "admin"], "structuredEvidence.validationPlan.principals");
  const user = exactValidationPrincipal({
    value: plan.principals.user,
    label: "structuredEvidence.validationPlan.principals.user",
    requirePlatformAdmin: false,
  });
  const admin = exactValidationPrincipal({
    value: plan.principals.admin,
    label: "structuredEvidence.validationPlan.principals.admin",
    requirePlatformAdmin: true,
  });
  assertExactKeys(plan.portrait, [
    "model",
    "modelRouteId",
    "expectedProviderAssetUriSha256",
    "expectedProviderSourceSha256",
    "expectedProviderChannelIdSha256",
    "aspectRatio",
    "durationSeconds",
    "outputResolution",
    "scriptId",
    "trackId",
  ], "structuredEvidence.validationPlan.portrait");
  exactPositiveInteger(plan.portrait.scriptId, "structuredEvidence.validationPlan.portrait.scriptId");
  exactPositiveInteger(plan.portrait.trackId, "structuredEvidence.validationPlan.portrait.trackId");
  exactText(plan.portrait.model, "structuredEvidence.validationPlan.portrait.model");
  exactText(plan.portrait.modelRouteId, "structuredEvidence.validationPlan.portrait.modelRouteId");
  exactSha256(plan.portrait.expectedProviderAssetUriSha256, "structuredEvidence.validationPlan.portrait.expectedProviderAssetUriSha256");
  exactSha256(plan.portrait.expectedProviderSourceSha256, "structuredEvidence.validationPlan.portrait.expectedProviderSourceSha256");
  exactSha256(plan.portrait.expectedProviderChannelIdSha256, "structuredEvidence.validationPlan.portrait.expectedProviderChannelIdSha256");
  const { validationPlanSha256, ...planCommitment } = plan;
  if (
    plan.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLAN_FORMAT
    || plan.trafficMode !== "full-maintenance"
    || plan.deploymentId !== input.binding.deploymentId
    || plan.contractSha256 !== input.binding.contractSha256
    || plan.bindingSha256 !== input.binding.bindingSha256
    || plan.validationPlanIntentSha256 !== intent.validationPlanIntentSha256
    || plan.rootMfaConfirmationSha256 !== input.rootMfaConfirmationSha256
    || plan.rootMfaConfirmationSha256 !== input.binding.validationAuthority.rootMfaConfirmationSha256
    || plan.privateApiInventorySha256 !== input.binding.privateApiInventorySha256
    || canonicalReleaseFullMaintenancePrivateValidationJson(plan.principals)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(intent.principals)
    || plan.workspaceId !== intent.workspaceId
    || plan.workspaceId !== user.workspaceId
    || plan.workspaceId !== admin.workspaceId
    || user.userId === admin.userId
    || plan.projectId !== intent.projectId
    || plan.assetVersionId !== intent.assetVersionId
    || canonicalReleaseFullMaintenancePrivateValidationJson(plan.portrait)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(intent.portrait)
    || plan.seedanceProbeId !== intent.seedanceProbeId
    || plan.maximumGuMicros !== intent.budget.maximumGuMicros
    || plan.maximumProviderTasks !== intent.budget.maximumProviderTasks
    || exactTimestamp(plan.expiresAt, "structuredEvidence.validationPlan.expiresAt") < input.now
    || plan.expiresAt !== intent.expiresAt
    || plan.portrait.aspectRatio !== "16:9"
    || plan.portrait.durationSeconds !== 4
    || plan.portrait.outputResolution !== "720p"
    || validationPlanSha256 !== input.validationPlanSha256
    || validationPlanSha256 !== releaseFullMaintenancePrivateValidationSha256(planCommitment)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PLAN_INVALID", "structured validation plan differs from the receipt, binding, roles, budget, or expiry");
  if (!Array.isArray(evidence.nodeProofs) || evidence.nodeProofs.length !== input.binding.apiNodeIds.length) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "structured node proof inventory is incomplete");
  }
  const activationByNode = new Map(
    input.binding.homogeneousFleetEvidence.api.map((entry) => [entry.nodeId, entry.activationBindingSha256] as const),
  );
  evidence.nodeProofs.forEach((proof, index) => {
    assertExactKeys(proof, [
      "format",
      "deploymentId",
      "nodeId",
      "hostnameSha256",
      "sshHostKeySha256",
      "activationBindingSha256",
      "releaseId",
      "artifactSha256",
      "sourceCommit",
      "schemaVersion",
      "imageDigest",
      "runtimeIdentityKind",
      "runtimeIdentitySha256",
    ], `structuredEvidence.nodeProofs[${index}]`);
    if (
      proof.deploymentId !== input.binding.deploymentId
      || proof.nodeId !== input.binding.apiNodeIds[index]
      || proof.activationBindingSha256 !== activationByNode.get(proof.nodeId)
      || proof.releaseId !== input.binding.target.releaseId
      || proof.artifactSha256 !== input.binding.target.artifactSha256
      || proof.sourceCommit !== input.binding.target.sourceCommit
      || proof.schemaVersion !== 48
      || proof.imageDigest !== input.binding.target.imageDigest
      || proof.runtimeIdentityKind !== "node-agent-current+readiness+ssh-host-key"
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "structured node proof differs from the activated target");
    exactSha256(proof.hostnameSha256, `structuredEvidence.nodeProofs[${index}].hostnameSha256`);
    exactSha256(proof.sshHostKeySha256, `structuredEvidence.nodeProofs[${index}].sshHostKeySha256`);
    exactSha256(proof.runtimeIdentitySha256, `structuredEvidence.nodeProofs[${index}].runtimeIdentitySha256`);
  });
  assertDistinctReleaseFullMaintenancePrivateNodeProofs(evidence.nodeProofs);
  if (releaseFullMaintenancePrivateValidationSha256(evidence.nodeProofs) !== input.nodeProofsSha256) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "structured node proof digest differs from the receipt");
  }
  assertReleaseFullMaintenancePrivateValidationBudgetFinalEvidence({
    value: evidence.budgetFinalEvidence,
    binding: input.binding,
    plan,
  });
  return evidence;
}

function receiptFromCandidate(input: {
  candidate: unknown;
  execution: ReleaseFullMaintenancePrivateValidationExecution;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): ReleaseFullMaintenancePrivateValidationReceipt {
  assertExactKeys(input.candidate, [
    "format",
    "trafficMode",
    "deploymentId",
    "contractSha256",
    "bindingSha256",
    "targetArtifactSha256",
    "executionId",
    "privateApiInventorySha256",
    "validationPlanSha256",
    "rootMfaConfirmationSha256",
    "nodeProofsSha256",
    "executorEvidenceSha256",
    "collectorEvidenceSha256",
    "structuredEvidence",
    "checks",
    "observedAt",
    "verdict",
  ], "candidate");
  const candidate = input.candidate as unknown as ReleaseFullMaintenancePrivateValidationCandidate;
  if (
    candidate.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CANDIDATE_FORMAT
    || candidate.trafficMode !== "full-maintenance"
    || candidate.deploymentId !== input.binding.deploymentId
    || candidate.contractSha256 !== input.binding.contractSha256
    || candidate.bindingSha256 !== input.binding.bindingSha256
    || candidate.targetArtifactSha256 !== input.binding.target.artifactSha256
    || candidate.executionId !== input.execution.executionId
    || candidate.privateApiInventorySha256 !== input.execution.privateApiInventorySha256
    || candidate.privateApiInventorySha256 !== input.binding.privateApiInventorySha256
    || candidate.validationPlanSha256 !== input.execution.validationPlanSha256
    || candidate.rootMfaConfirmationSha256 !== input.execution.rootMfaConfirmationSha256
    || candidate.nodeProofsSha256 !== input.execution.nodeProofsSha256
    || candidate.executorEvidenceSha256 !== input.execution.executorEvidenceSha256
    || candidate.verdict !== "PASS"
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CANDIDATE_INVALID", "collector result is not exactly bound or did not PASS");
  const privateApiInventoryDigest = exactNonTrivialEvidenceSha256(
    candidate.privateApiInventorySha256,
    "candidate.privateApiInventorySha256",
  );
  const executorDigest = exactNonTrivialEvidenceSha256(
    candidate.executorEvidenceSha256,
    "candidate.executorEvidenceSha256",
  );
  const validationPlanDigest = exactNonTrivialEvidenceSha256(
    candidate.validationPlanSha256,
    "candidate.validationPlanSha256",
  );
  const rootMfaDigest = exactNonTrivialEvidenceSha256(
    candidate.rootMfaConfirmationSha256,
    "candidate.rootMfaConfirmationSha256",
  );
  const nodeProofsDigest = exactNonTrivialEvidenceSha256(
    candidate.nodeProofsSha256,
    "candidate.nodeProofsSha256",
  );
  const collectorDigest = exactNonTrivialEvidenceSha256(
    candidate.collectorEvidenceSha256,
    "candidate.collectorEvidenceSha256",
  );
  const structuredEvidence = assertStructuredEvidence({
    value: candidate.structuredEvidence,
    binding: input.binding,
    validationPlanSha256: candidate.validationPlanSha256,
    rootMfaConfirmationSha256: candidate.rootMfaConfirmationSha256,
    nodeProofsSha256: candidate.nodeProofsSha256,
    now: input.now,
  });
  const checks = assertChecks(candidate.checks, [
    privateApiInventoryDigest,
    validationPlanDigest,
    rootMfaDigest,
    nodeProofsDigest,
    executorDigest,
    collectorDigest,
  ]);
  const observedAt = exactTimestamp(candidate.observedAt, "candidate.observedAt");
  if (observedAt < input.execution.startedAt || observedAt > input.now) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIME_INVALID", "candidate timestamp is outside the execution window");
  }
  const commitment = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_FORMAT,
    trafficMode: "full-maintenance" as const,
    deploymentId: candidate.deploymentId,
    contractSha256: candidate.contractSha256,
    bindingSha256: candidate.bindingSha256,
    targetArtifactSha256: candidate.targetArtifactSha256,
    executionId: candidate.executionId,
    privateApiInventorySha256: candidate.privateApiInventorySha256,
    validationPlanSha256: candidate.validationPlanSha256,
    rootMfaConfirmationSha256: candidate.rootMfaConfirmationSha256,
    nodeProofsSha256: candidate.nodeProofsSha256,
    executorEvidenceSha256: candidate.executorEvidenceSha256,
    collectorEvidenceSha256: candidate.collectorEvidenceSha256,
    structuredEvidence,
    checks,
    observedAt,
    verdict: "PASS" as const,
  };
  return {
    ...commitment,
    receiptSha256: releaseFullMaintenancePrivateValidationSha256(commitment),
  };
}

export function assertReleaseFullMaintenancePrivateValidationReceipt(input: {
  receipt: unknown;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): ReleaseFullMaintenancePrivateValidationReceipt {
  assertReleaseFullMaintenancePrivateValidationBinding(input.binding, { now: input.now });
  assertExactKeys(input.receipt, [
    "format",
    "trafficMode",
    "deploymentId",
    "contractSha256",
    "bindingSha256",
    "targetArtifactSha256",
    "executionId",
    "privateApiInventorySha256",
    "validationPlanSha256",
    "rootMfaConfirmationSha256",
    "nodeProofsSha256",
    "executorEvidenceSha256",
    "collectorEvidenceSha256",
    "structuredEvidence",
    "checks",
    "observedAt",
    "verdict",
    "receiptSha256",
  ], "receipt");
  const receipt = input.receipt as unknown as ReleaseFullMaintenancePrivateValidationReceipt;
  if (
    receipt.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_FORMAT
    || receipt.trafficMode !== "full-maintenance"
    || receipt.deploymentId !== input.binding.deploymentId
    || receipt.contractSha256 !== input.binding.contractSha256
    || receipt.bindingSha256 !== input.binding.bindingSha256
    || receipt.targetArtifactSha256 !== input.binding.target.artifactSha256
    || receipt.privateApiInventorySha256 !== input.binding.privateApiInventorySha256
    || !SAFE_EXECUTION_ID.test(receipt.executionId)
    || receipt.verdict !== "PASS"
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_INVALID", "receipt is not exactly bound or did not PASS");
  const privateApiInventoryDigest = exactNonTrivialEvidenceSha256(
    receipt.privateApiInventorySha256,
    "receipt.privateApiInventorySha256",
  );
  const executorDigest = exactNonTrivialEvidenceSha256(
    receipt.executorEvidenceSha256,
    "receipt.executorEvidenceSha256",
  );
  const validationPlanDigest = exactNonTrivialEvidenceSha256(
    receipt.validationPlanSha256,
    "receipt.validationPlanSha256",
  );
  const rootMfaDigest = exactNonTrivialEvidenceSha256(
    receipt.rootMfaConfirmationSha256,
    "receipt.rootMfaConfirmationSha256",
  );
  const nodeProofsDigest = exactNonTrivialEvidenceSha256(
    receipt.nodeProofsSha256,
    "receipt.nodeProofsSha256",
  );
  const collectorDigest = exactNonTrivialEvidenceSha256(
    receipt.collectorEvidenceSha256,
    "receipt.collectorEvidenceSha256",
  );
  assertStructuredEvidence({
    value: receipt.structuredEvidence,
    binding: input.binding,
    validationPlanSha256: receipt.validationPlanSha256,
    rootMfaConfirmationSha256: receipt.rootMfaConfirmationSha256,
    nodeProofsSha256: receipt.nodeProofsSha256,
    now: input.now,
  });
  assertChecks(receipt.checks, [
    privateApiInventoryDigest,
    validationPlanDigest,
    rootMfaDigest,
    nodeProofsDigest,
    executorDigest,
    collectorDigest,
  ]);
  const observedAt = exactTimestamp(receipt.observedAt, "receipt.observedAt");
  if (observedAt < input.binding.requestedAt || observedAt > input.now) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIME_INVALID", "receipt timestamp is outside the binding window");
  }
  const { receiptSha256, ...commitment } = receipt;
  if (
    exactSha256(receiptSha256, "receipt.receiptSha256")
    !== releaseFullMaintenancePrivateValidationSha256(commitment)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_INVALID", "receipt digest differs from its exact commitment");
  return receipt;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwner(uid: number, label: string, expectedUid?: number): void {
  const expected = expectedUid ?? currentUid();
  if (expected !== undefined && uid !== expected) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", `${label} is not owned by the current executor`);
  }
}

function protectedReceiptDirectory(directory: string, expectedUid?: number): string {
  if (
    typeof directory !== "string"
    || !path.isAbsolute(directory)
    || path.normalize(directory) !== directory
    || directory === path.parse(directory).root
    || /[\0\r\n]/u.test(directory)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "receipt directory path is unsafe");
  let actual: string;
  try {
    actual = realpathSync(directory);
  } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "receipt directory does not exist");
  }
  if (actual !== directory) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "receipt directory is not canonical");
  }
  const metadata = lstatSync(directory);
  assertOwner(metadata.uid, "receipt directory", expectedUid);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "receipt directory is not owner-only");
  }
  return directory;
}

function readProtectedReceipt(filePath: string, expectedUid?: number): Buffer {
  protectedReceiptDirectory(path.dirname(filePath), expectedUid);
  const metadata = lstatSync(filePath);
  assertOwner(metadata.uid, "receipt", expectedUid);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size < 1
    || metadata.size > MAX_RECEIPT_BYTES
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "receipt file is unsafe");
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "O_NOFOLLOW is unavailable");
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    assertOwner(before.uid, "opened receipt", expectedUid);
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.ino !== metadata.ino
      || before.dev !== metadata.dev
      || before.size !== metadata.size
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "receipt changed while opening");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const finalPath = lstatSync(filePath);
    if (
      bytes.length !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.dev !== finalPath.dev
      || after.ino !== finalPath.ino
      || after.size !== finalPath.size
      || after.mtimeMs !== finalPath.mtimeMs
      || after.ctimeMs !== finalPath.ctimeMs
      || finalPath.nlink !== 1
      || (finalPath.mode & 0o777) !== 0o600
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "receipt changed during stable read");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function persistReleaseFullMaintenancePrivateValidationAttempt(input: {
  directory: string;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  plan: ReleaseFullMaintenancePrivateValidationPlan;
  startedAt: number;
  deadlineAt: number;
}): string {
  const directory = protectedReceiptDirectory(input.directory);
  const commitment = {
    format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_ATTEMPT_FORMAT,
    trafficMode: "full-maintenance" as const,
    status: "validation-attempted" as const,
    deploymentId: input.binding.deploymentId,
    contractSha256: input.binding.contractSha256,
    bindingSha256: input.binding.bindingSha256,
    validationPlanSha256: input.plan.validationPlanSha256,
    validationPlan: input.plan,
    validationAuthority: input.binding.validationAuthority,
    rootMfaConfirmationSha256: input.plan.rootMfaConfirmationSha256,
    startedAt: input.startedAt,
    deadlineAt: input.deadlineAt,
  };
  const attempt = {
    ...commitment,
    attemptSha256: releaseFullMaintenancePrivateValidationSha256(commitment),
  };
  const bytes = Buffer.from(`${canonicalReleaseFullMaintenancePrivateValidationJson(attempt)}\n`, "utf8");
  const filePath = path.join(directory, `attempt-${attempt.attemptSha256}.json`);
  if (bytes.length > MAX_RECEIPT_BYTES || typeof constants.O_NOFOLLOW !== "number") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "attempt evidence cannot be persisted safely");
  }
  try {
    const existing = readProtectedReceipt(filePath);
    if (!existing.equals(bytes)) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_CONFLICT", "attempt evidence identity conflicts");
    }
    return filePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const descriptor = openSync(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written < 1) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_FAILED", "attempt write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const persisted = readProtectedReceipt(filePath);
  if (!persisted.equals(bytes)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_FAILED", "attempt evidence readback differs");
  }
  return filePath;
}

function persistProtectedCanonicalEvidence(input: {
  directory: string;
  basename: string;
  value: unknown;
}): string {
  const directory = protectedReceiptDirectory(input.directory);
  if (!/^[a-z][a-z0-9-]{1,63}-[a-f0-9]{64}\.json$/u.test(input.basename)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "evidence basename is invalid");
  }
  const bytes = Buffer.from(`${canonicalReleaseFullMaintenancePrivateValidationJson(input.value)}\n`, "utf8");
  if (bytes.length < 2 || bytes.length > MAX_RECEIPT_BYTES || typeof constants.O_NOFOLLOW !== "number") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "structured evidence is outside protected bounds");
  }
  const filePath = path.join(directory, input.basename);
  try {
    const existing = readProtectedReceipt(filePath);
    if (!existing.equals(bytes)) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_CONFLICT", "structured evidence identity conflicts");
    }
    return filePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const descriptor = openSync(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written < 1) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_FAILED", "evidence write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (!readProtectedReceipt(filePath).equals(bytes)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_FAILED", "structured evidence readback differs");
  }
  return filePath;
}

export function persistReleaseFullMaintenancePrivateValidationReceipt(input: {
  directory: string;
  receipt: ReleaseFullMaintenancePrivateValidationReceipt;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): PersistedReleaseFullMaintenancePrivateValidationReceipt {
  const receipt = assertReleaseFullMaintenancePrivateValidationReceipt({
    receipt: input.receipt,
    binding: input.binding,
    now: input.now,
  });
  const directory = protectedReceiptDirectory(input.directory);
  const bytes = Buffer.from(`${canonicalReleaseFullMaintenancePrivateValidationJson(receipt)}\n`, "utf8");
  if (bytes.length > MAX_RECEIPT_BYTES) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "receipt exceeds the protected size limit");
  }
  const filePath = path.join(directory, `${receipt.receiptSha256}.json`);
  const fromExisting = (): PersistedReleaseFullMaintenancePrivateValidationReceipt => {
    const existing = readProtectedReceipt(filePath);
    if (!existing.equals(bytes)) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_CONFLICT", "receipt identity already exists with different bytes");
    }
    return { receipt, filePath, contentSha256: rawSha256(existing) };
  };
  try {
    statSync(filePath);
    return fromExisting();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(
    directory,
    `.${receipt.receiptSha256}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "O_NOFOLLOW is unavailable");
    }
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written < 1) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_FAILED", "receipt write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    const temporary = fstatSync(descriptor);
    assertOwner(temporary.uid, "temporary receipt");
    if (
      !temporary.isFile()
      || temporary.nlink !== 1
      || (temporary.mode & 0o777) !== 0o600
      || temporary.size !== bytes.length
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_FAILED", "temporary receipt is unsafe");
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      unlinkSync(temporaryPath);
      return fromExisting();
    }
    unlinkSync(temporaryPath);
    if (typeof constants.O_DIRECTORY !== "number") {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "O_DIRECTORY is unavailable");
    }
    const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return fromExisting();
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* best-effort private temporary cleanup */ }
    throw error;
  }
}

export function assertPersistedReleaseFullMaintenancePrivateValidationReceipt(input: {
  persisted: PersistedReleaseFullMaintenancePrivateValidationReceipt;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): PersistedReleaseFullMaintenancePrivateValidationReceipt {
  const receipt = assertReleaseFullMaintenancePrivateValidationReceipt({
    receipt: input.persisted?.receipt,
    binding: input.binding,
    now: input.now,
  });
  const filePath = String(input.persisted?.filePath || "");
  if (
    !path.isAbsolute(filePath)
    || path.normalize(filePath) !== filePath
    || filePath === path.parse(filePath).root
    || path.basename(filePath) !== `${receipt.receiptSha256}.json`
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "persisted receipt path is unsafe or unbound");
  const expectedBytes = Buffer.from(`${canonicalReleaseFullMaintenancePrivateValidationJson(receipt)}\n`, "utf8");
  if (
    !RAW_SHA256.test(String(input.persisted?.contentSha256 || ""))
    || input.persisted.contentSha256 !== rawSha256(expectedBytes)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_INVALID", "persisted receipt content digest differs");
  return { receipt, filePath, contentSha256: input.persisted.contentSha256 };
}

function readCanonicalPrivateValidationEvidenceSidecar(input: {
  filePath: string;
  ownerUid: number;
  label: string;
}): Readonly<{ value: Record<string, unknown>; bytes: Buffer; contentSha256: string }> {
  let bytes: Buffer;
  try {
    bytes = readProtectedReceipt(input.filePath, input.ownerUid);
  } catch (error) {
    if (error instanceof ReleaseFullMaintenancePrivateValidationError) throw error;
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
      `${input.label} evidence sidecar is missing or unreadable`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
      `${input.label} evidence sidecar is invalid JSON`,
    );
  }
  if (
    !isRecord(value)
    || !bytes.equals(Buffer.from(
      `${canonicalReleaseFullMaintenancePrivateValidationJson(value)}\n`,
      "utf8",
    ))
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
    `${input.label} evidence sidecar is not exact canonical JSON`,
  );
  return Object.freeze({ value, bytes, contentSha256: rawSha256(bytes) });
}

function assertRootExecutorEvidenceSidecar(input: {
  value: Record<string, unknown>;
  receipt: ReleaseFullMaintenancePrivateValidationReceipt;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
}): Readonly<{ healthEvidence: Record<string, unknown>; businessEvidenceSha256: string }> {
  assertExactKeys(input.value, [
    "format",
    "deploymentId",
    "bindingSha256",
    "contractSha256",
    "validationPlanSha256",
    "validationPlan",
    "rootMfaConfirmationSha256",
    "nodeProofsSha256",
    "nodeProofs",
    "healthEvidence",
    "principalEvidence",
    "portraitReceipts",
    "portraitGeneration",
    "seedanceReceipt",
    "seedanceFreshEvidence",
    "budgetFinalEvidence",
    "executorEvidenceSha256",
  ], "executorEvidenceSidecar");
  const { executorEvidenceSha256, ...commitment } = input.value;
  const healthEvidence = jsonRecord(input.value.healthEvidence);
  const portraitGeneration = jsonRecord(input.value.portraitGeneration);
  const workerDispatchEvidence = jsonRecord(portraitGeneration.workerDispatchEvidence);
  const principalEvidence = Array.isArray(input.value.principalEvidence)
    ? input.value.principalEvidence
    : [];
  const expectedPrincipals = input.receipt.structuredEvidence.validationPlan.principals;
  const expectedPrincipalKeys = new Set(
    input.binding.apiNodeIds.flatMap((nodeId) => [`${nodeId}:user`, `${nodeId}:admin`]),
  );
  const observedPrincipalKeys = new Set<string>();
  for (const evidence of principalEvidence) {
    if (!isRecord(evidence)) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID", "executor principal evidence is invalid");
    }
    assertExactKeys(evidence, [
      "nodeId", "kind", "userId", "platformRole", "workspaceId", "workspaceRole", "identitySha256",
    ], "executorEvidenceSidecar.principalEvidence");
    const kind = evidence.kind === "user" || evidence.kind === "admin" ? evidence.kind : null;
    const expected = kind ? expectedPrincipals[kind] : null;
    const key = `${String(evidence.nodeId || "")}:${String(kind || "")}`;
    if (
      !expected
      || !expectedPrincipalKeys.has(key)
      || observedPrincipalKeys.has(key)
      || Number(evidence.userId) !== expected.userId
      || evidence.platformRole !== expected.platformRole
      || evidence.workspaceId !== expected.workspaceId
      || evidence.workspaceRole !== expected.workspaceRole
      || !RAW_SHA256.test(String(evidence.identitySha256 || ""))
    ) fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
      "executor principal evidence differs from the exact validation identities",
    );
    observedPrincipalKeys.add(key);
  }
  const portraitReceipts = Array.isArray(input.value.portraitReceipts)
    ? input.value.portraitReceipts
    : [];
  if (
    input.value.format !== "fanjin-release-full-maintenance-private-validation-executor-evidence/v1"
    || input.value.deploymentId !== input.receipt.deploymentId
    || input.value.bindingSha256 !== input.receipt.bindingSha256
    || input.value.contractSha256 !== input.receipt.contractSha256
    || input.value.validationPlanSha256 !== input.receipt.validationPlanSha256
    || canonicalReleaseFullMaintenancePrivateValidationJson(input.value.validationPlan)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(input.receipt.structuredEvidence.validationPlan)
    || input.value.rootMfaConfirmationSha256 !== input.receipt.rootMfaConfirmationSha256
    || input.value.nodeProofsSha256 !== input.receipt.nodeProofsSha256
    || canonicalReleaseFullMaintenancePrivateValidationJson(input.value.nodeProofs)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(input.receipt.structuredEvidence.nodeProofs)
    || executorEvidenceSha256 !== input.receipt.executorEvidenceSha256
    || executorEvidenceSha256 !== releaseFullMaintenancePrivateValidationSha256(commitment)
    || healthEvidence.privateApiInventorySha256 !== input.receipt.privateApiInventorySha256
    || healthEvidence.homogeneousFleetEvidenceSha256 !== input.binding.homogeneousFleetEvidenceSha256
    || healthEvidence.imageDigest !== input.binding.target.imageDigest
    || observedPrincipalKeys.size !== expectedPrincipalKeys.size
    || portraitReceipts.length !== input.binding.apiNodeIds.length
    || releaseFullMaintenancePrivateValidationSha256(input.value.portraitGeneration)
      !== input.receipt.checks.portrait.generationSha256
    || workerDispatchEvidence.scope !== "provider-post-dispatch-only"
    || releaseFullMaintenancePrivateValidationSha256(input.value.seedanceReceipt)
      !== input.receipt.checks.seedance.receiptSha256
    || !isRecord(input.value.seedanceFreshEvidence)
    || canonicalReleaseFullMaintenancePrivateValidationJson(input.value.budgetFinalEvidence)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(
        input.receipt.structuredEvidence.budgetFinalEvidence,
      )
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
    "executor evidence sidecar differs from its receipt, target, identities, or exact business evidence",
  );
  return Object.freeze({
    healthEvidence,
    businessEvidenceSha256: releaseFullMaintenancePrivateValidationSha256({
      validationPlan: input.value.validationPlan,
      nodeProofs: input.value.nodeProofs,
      healthEvidence,
      principalEvidence,
      portraitGeneration: input.value.portraitGeneration,
      seedanceReceipt: input.value.seedanceReceipt,
      seedanceFreshEvidence: input.value.seedanceFreshEvidence,
      budgetFinalEvidence: input.value.budgetFinalEvidence,
    }),
  });
}

function assertRootCollectorEvidenceSidecar(input: {
  value: Record<string, unknown>;
  receipt: ReleaseFullMaintenancePrivateValidationReceipt;
  executorHealthEvidence: Record<string, unknown>;
}): string {
  assertExactKeys(input.value, [
    "format",
    "deploymentId",
    "contractSha256",
    "bindingSha256",
    "executionId",
    "validationPlanSha256",
    "nodeProofsSha256",
    "healthEvidence",
    "checks",
    "budgetFinalEvidence",
    "observedAt",
    "collectorEvidenceSha256",
  ], "collectorEvidenceSidecar");
  const { collectorEvidenceSha256, ...commitment } = input.value;
  if (
    input.value.format !== "fanjin-release-full-maintenance-private-validation-collector-evidence/v1"
    || input.value.deploymentId !== input.receipt.deploymentId
    || input.value.contractSha256 !== input.receipt.contractSha256
    || input.value.bindingSha256 !== input.receipt.bindingSha256
    || input.value.executionId !== input.receipt.executionId
    || input.value.validationPlanSha256 !== input.receipt.validationPlanSha256
    || input.value.nodeProofsSha256 !== input.receipt.nodeProofsSha256
    || canonicalReleaseFullMaintenancePrivateValidationJson(input.value.healthEvidence)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(input.executorHealthEvidence)
    || canonicalReleaseFullMaintenancePrivateValidationJson(input.value.checks)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(input.receipt.checks)
    || canonicalReleaseFullMaintenancePrivateValidationJson(input.value.budgetFinalEvidence)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(
        input.receipt.structuredEvidence.budgetFinalEvidence,
      )
    || Number(input.value.observedAt) !== input.receipt.observedAt
    || collectorEvidenceSha256 !== input.receipt.collectorEvidenceSha256
    || collectorEvidenceSha256 !== releaseFullMaintenancePrivateValidationSha256(commitment)
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
    "collector evidence sidecar differs from its receipt or executor business evidence",
  );
  return releaseFullMaintenancePrivateValidationSha256({
    executionId: input.value.executionId,
    healthEvidence: input.value.healthEvidence,
    checks: input.value.checks,
    budgetFinalEvidence: input.value.budgetFinalEvidence,
    observedAt: input.value.observedAt,
  });
}

export function assertReleaseFullMaintenancePrivateValidationEvidenceManifest(input: {
  manifest: unknown;
  persisted: PersistedReleaseFullMaintenancePrivateValidationReceipt;
}): ReleaseFullMaintenancePrivateValidationEvidenceManifest {
  assertExactKeys(input.manifest, [
    "format",
    "ownerUid",
    "files",
    "businessEvidenceSha256",
    "manifestSha256",
  ], "evidenceManifest");
  const manifest = input.manifest;
  assertExactKeys(manifest.files, ["receipt", "executor", "collector"], "evidenceManifest.files");
  const files = manifest.files;
  const expectedBasenames = {
    receipt: path.basename(input.persisted.filePath),
    executor: `executor-${input.persisted.receipt.executorEvidenceSha256}.json`,
    collector: `collector-${input.persisted.receipt.collectorEvidenceSha256}.json`,
  } as const;
  const normalizedFiles = Object.fromEntries(
    (["receipt", "executor", "collector"] as const).map((label) => {
      const value = files[label];
      assertExactKeys(value, ["basename", "contentSha256", "byteLength"], `evidenceManifest.files.${label}`);
      if (
        value.basename !== expectedBasenames[label]
        || path.basename(String(value.basename || "")) !== value.basename
      ) fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
        `${label} manifest basename differs from the accepted receipt`,
      );
      return [label, Object.freeze({
        basename: value.basename,
        contentSha256: exactSha256(
          value.contentSha256,
          `evidenceManifest.files.${label}.contentSha256`,
        ),
        byteLength: exactPositiveInteger(
          value.byteLength,
          `evidenceManifest.files.${label}.byteLength`,
        ),
      })] as const;
    }),
  ) as ReleaseFullMaintenancePrivateValidationEvidenceManifest["files"];
  if (
    !Number.isSafeInteger(manifest.ownerUid)
    || Number(manifest.ownerUid) < 0
    || manifest.format !== "fanjin-release-full-maintenance-private-validation-evidence-manifest/v1"
    || normalizedFiles.receipt.contentSha256 !== input.persisted.contentSha256
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
    "evidence manifest owner, format or receipt pin is invalid",
  );
  const commitment = {
    format: "fanjin-release-full-maintenance-private-validation-evidence-manifest/v1" as const,
    ownerUid: Number(manifest.ownerUid),
    files: normalizedFiles,
    businessEvidenceSha256: exactSha256(
      manifest.businessEvidenceSha256,
      "evidenceManifest.businessEvidenceSha256",
    ),
  };
  const manifestSha256 = exactSha256(
    manifest.manifestSha256,
    "evidenceManifest.manifestSha256",
  );
  if (manifestSha256 !== releaseFullMaintenancePrivateValidationSha256(commitment)) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EVIDENCE_INVALID",
      "evidence manifest digest differs from its exact three-file commitment",
    );
  }
  return Object.freeze({ ...commitment, manifestSha256 });
}

/**
 * Root-parent acceptance boundary. It intentionally ignores any child-supplied
 * manifest and reopens all three owner-only files to pin original bytes,
 * semantic commitments and the exact business evidence before traffic restore.
 */
export function assertRootVerifiedPersistedReleaseFullMaintenancePrivateValidationReceipt(input: {
  persisted: PersistedReleaseFullMaintenancePrivateValidationReceipt;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): RootVerifiedPersistedReleaseFullMaintenancePrivateValidationReceipt {
  const persisted = assertPersistedReleaseFullMaintenancePrivateValidationReceipt(input);
  let receiptMetadata: ReturnType<typeof lstatSync>;
  try {
    receiptMetadata = lstatSync(persisted.filePath);
  } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "root parent cannot reopen the receipt");
  }
  const ownerUid = receiptMetadata.uid;
  const receiptBytes = readProtectedReceipt(persisted.filePath, ownerUid);
  const expectedReceiptBytes = Buffer.from(
    `${canonicalReleaseFullMaintenancePrivateValidationJson(persisted.receipt)}\n`,
    "utf8",
  );
  if (
    !receiptBytes.equals(expectedReceiptBytes)
    || rawSha256(receiptBytes) !== persisted.contentSha256
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_INVALID",
    "root parent receipt stable read differs from the child result",
  );
  const directory = path.dirname(persisted.filePath);
  const executorBasename = `executor-${persisted.receipt.executorEvidenceSha256}.json`;
  const collectorBasename = `collector-${persisted.receipt.collectorEvidenceSha256}.json`;
  const executor = readCanonicalPrivateValidationEvidenceSidecar({
    filePath: path.join(directory, executorBasename),
    ownerUid,
    label: "executor",
  });
  const collector = readCanonicalPrivateValidationEvidenceSidecar({
    filePath: path.join(directory, collectorBasename),
    ownerUid,
    label: "collector",
  });
  const executorBusiness = assertRootExecutorEvidenceSidecar({
    value: executor.value,
    receipt: persisted.receipt,
    binding: input.binding,
  });
  const collectorBusinessSha256 = assertRootCollectorEvidenceSidecar({
    value: collector.value,
    receipt: persisted.receipt,
    executorHealthEvidence: executorBusiness.healthEvidence,
  });
  const manifestCommitment = {
    format: "fanjin-release-full-maintenance-private-validation-evidence-manifest/v1" as const,
    ownerUid,
    files: {
      receipt: {
        basename: path.basename(persisted.filePath),
        contentSha256: rawSha256(receiptBytes),
        byteLength: receiptBytes.length,
      },
      executor: {
        basename: executorBasename,
        contentSha256: executor.contentSha256,
        byteLength: executor.bytes.length,
      },
      collector: {
        basename: collectorBasename,
        contentSha256: collector.contentSha256,
        byteLength: collector.bytes.length,
      },
    },
    businessEvidenceSha256: releaseFullMaintenancePrivateValidationSha256({
      receiptSha256: persisted.receipt.receiptSha256,
      executorBusinessSha256: executorBusiness.businessEvidenceSha256,
      collectorBusinessSha256: collectorBusinessSha256,
    }),
  };
  const evidenceManifest = Object.freeze({
    ...manifestCommitment,
    manifestSha256: releaseFullMaintenancePrivateValidationSha256(manifestCommitment),
  });
  return Object.freeze({
    ...persisted,
    evidenceManifest: assertReleaseFullMaintenancePrivateValidationEvidenceManifest({
      manifest: evidenceManifest,
      persisted,
    }),
  });
}

export function loadPersistedReleaseFullMaintenancePrivateValidationReceipt(input: {
  filePath: string;
  contentSha256: string;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
  platform?: NodeJS.Platform;
  effectiveUid?: number;
}): PersistedReleaseFullMaintenancePrivateValidationReceipt {
  if ((input.platform ?? process.platform) !== "linux") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "persisted receipt readback requires Linux");
  }
  if (
    !path.isAbsolute(input.filePath)
    || path.normalize(input.filePath) !== input.filePath
    || input.filePath === path.parse(input.filePath).root
    || !RAW_SHA256.test(input.contentSha256)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "persisted receipt pin is invalid");
  assertReleaseFullMaintenancePrivateValidationBinding(input.binding, { now: input.now });
  const expectedUid = input.effectiveUid
    ?? (typeof process.geteuid === "function" ? process.geteuid() : currentUid());
  const bytes = readProtectedReceipt(input.filePath, expectedUid);
  if (rawSha256(bytes) !== input.contentSha256) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_INVALID", "persisted receipt differs from its content pin");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_INVALID", "persisted receipt JSON is invalid");
  }
  const receipt = assertReleaseFullMaintenancePrivateValidationReceipt({
    receipt: parsed,
    binding: input.binding,
    now: input.now,
  });
  const canonicalBytes = Buffer.from(`${canonicalReleaseFullMaintenancePrivateValidationJson(receipt)}\n`, "utf8");
  if (
    !bytes.equals(canonicalBytes)
    || path.basename(input.filePath) !== `${receipt.receiptSha256}.json`
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_RECEIPT_INVALID", "persisted receipt path or canonical bytes differ");
  return assertPersistedReleaseFullMaintenancePrivateValidationReceipt({
    persisted: {
      receipt,
      filePath: input.filePath,
      contentSha256: input.contentSha256,
    },
    binding: input.binding,
    now: input.now,
  });
}

function exactPrivateApiOrigin(
  value: unknown,
  label: string,
  code: string,
): string {
  if (typeof value !== "string") {
    fail(code, `${label} is missing`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(code, `${label} is invalid`);
  }
  const octets = url.hostname.split(".").map(Number);
  if (
    url.protocol !== "http:"
    || url.port !== PRIVATE_API_PORT
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || octets.length !== 4
    || octets[0] !== 10
    || octets[1] !== 0
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    || url.hostname !== octets.join(".")
    || value !== `http://${url.hostname}:${PRIVATE_API_PORT}`
  ) fail(code, `${label} must be an exact http://10.0.0.0/16:10588 IP origin`);
  return value;
}

function exactPrivateApiBaseUrl(value: unknown): string {
  return exactPrivateApiOrigin(
    value,
    "private API URL",
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID",
  );
}

function assertHomogeneousFleetProof(input: {
  value: unknown;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
}): HomogeneousFleetProof {
  assertExactKeys(input.value, [
    "format",
    "deploymentId",
    "prestageEvidenceSha256",
    "inventorySha256",
    "target",
    "loadBalancerWeightEvidenceSha256",
    "loadBalancer",
    "api",
    "workers",
    "targetEvidenceSha256ByKey",
    "observedAt",
    "evidenceSha256",
  ], "homogeneousFleetEvidence");
  const proof = input.value as unknown as HomogeneousFleetProof;
  assertExactKeys(proof.target, [
    "releaseId",
    "artifactSha256",
    "sourceCommit",
    "schemaVersion",
    "deploymentMode",
    "imageDigest",
  ], "homogeneousFleetEvidence.target");
  if (
    proof.format !== "fanjin-release-maintenance-homogeneous-fleet/v2"
    || proof.deploymentId !== input.binding.deploymentId
    || proof.target.releaseId !== input.binding.target.releaseId
    || proof.target.artifactSha256 !== input.binding.target.artifactSha256
    || proof.target.sourceCommit !== input.binding.target.sourceCommit
    || proof.target.schemaVersion !== 48
    || proof.target.deploymentMode !== "container-image"
    || proof.target.imageDigest !== input.binding.target.imageDigest
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "homogeneous fleet target differs from the binding");
  exactSha256(proof.prestageEvidenceSha256, "homogeneousFleetEvidence.prestageEvidenceSha256");
  exactSha256(proof.inventorySha256, "homogeneousFleetEvidence.inventorySha256");
  exactSha256(
    proof.loadBalancerWeightEvidenceSha256,
    "homogeneousFleetEvidence.loadBalancerWeightEvidenceSha256",
  );
  const observedAt = exactTimestamp(proof.observedAt, "homogeneousFleetEvidence.observedAt");
  if (observedAt > input.binding.requestedAt) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "homogeneous fleet proof postdates the binding");
  }
  if (!Array.isArray(proof.loadBalancer) || !Array.isArray(proof.api) || !Array.isArray(proof.workers)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "homogeneous fleet inventories are invalid");
  }
  const loadBalancer = proof.loadBalancer.map((row, index) => {
    assertExactKeys(row, ["nodeId", "weight"], `homogeneousFleetEvidence.loadBalancer[${index}]`);
    if (row.weight !== 0) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "homogeneous load balancer is not all-zero");
    }
    return exactText(row.nodeId, `homogeneousFleetEvidence.loadBalancer[${index}].nodeId`);
  });
  const api = proof.api.map((row, index) => {
    assertExactKeys(row, ["nodeId", "activationBindingSha256"], `homogeneousFleetEvidence.api[${index}]`);
    exactSha256(row.activationBindingSha256, `homogeneousFleetEvidence.api[${index}].activationBindingSha256`);
    return exactText(row.nodeId, `homogeneousFleetEvidence.api[${index}].nodeId`);
  });
  const workers = proof.workers.map((row, index) => {
    assertExactKeys(row, ["nodeId", "activationBindingSha256", "heartbeatAt"], `homogeneousFleetEvidence.workers[${index}]`);
    exactSha256(row.activationBindingSha256, `homogeneousFleetEvidence.workers[${index}].activationBindingSha256`);
    exactTimestamp(row.heartbeatAt, `homogeneousFleetEvidence.workers[${index}].heartbeatAt`);
    return exactText(row.nodeId, `homogeneousFleetEvidence.workers[${index}].nodeId`);
  });
  const expectedApi = input.binding.apiNodeIds;
  const expectedWorkers = input.binding.workerNodeIds;
  const same = (left: readonly string[], right: readonly string[]) => (
    left.length === right.length && left.every((entry, index) => entry === right[index])
  );
  if (
    !same(loadBalancer, expectedApi)
    || !same(api, expectedApi)
    || !same(workers, expectedWorkers)
    || !isRecord(proof.targetEvidenceSha256ByKey)
    || !same(Object.keys(proof.targetEvidenceSha256ByKey).sort(), [...expectedApi, ...expectedWorkers].sort())
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "homogeneous fleet inventory differs from the binding");
  const shared = {
    format: "fanjin-release-maintenance-homogeneous-target/v2" as const,
    deploymentId: proof.deploymentId,
    prestageEvidenceSha256: proof.prestageEvidenceSha256,
    inventorySha256: proof.inventorySha256,
    target: proof.target,
    loadBalancerWeightEvidenceSha256: proof.loadBalancerWeightEvidenceSha256,
    loadBalancer: proof.loadBalancer,
    observedAt: proof.observedAt,
  };
  const rebuiltByKey = Object.fromEntries([
    ...proof.api.map((entry) => [entry.nodeId, releaseFullMaintenancePrivateValidationSha256({
      ...shared,
      role: "api",
      ...entry,
    })] as const),
    ...proof.workers.map((entry) => [entry.nodeId, releaseFullMaintenancePrivateValidationSha256({
      ...shared,
      role: "worker",
      ...entry,
    })] as const),
  ].sort(([left], [right]) => left.localeCompare(right)));
  if (
    canonicalReleaseFullMaintenancePrivateValidationJson(rebuiltByKey)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(proof.targetEvidenceSha256ByKey)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "homogeneous per-node evidence digests differ");
  const { evidenceSha256, ...commitment } = proof;
  if (
    exactSha256(evidenceSha256, "homogeneousFleetEvidence.evidenceSha256")
      !== input.binding.homogeneousFleetEvidenceSha256
    || evidenceSha256 !== releaseFullMaintenancePrivateValidationSha256(commitment)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "homogeneous fleet digest differs from the exact proof");
  return proof;
}

function exactCanonicalRfc3339(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", `${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", `${label} is not canonical UTC RFC3339`);
  }
  return value;
}

function exactProtectedSession(input: {
  value: unknown;
  label: string;
  now: number;
  deadlineAt: number;
  bindingRequestedAt: number;
}): ProtectedSession {
  assertExactKeys(input.value, ["token", "issuedAt", "expiresAt", "purpose"], input.label);
  const session = input.value as unknown as ProtectedSession;
  const issuedAt = exactTimestamp(session.issuedAt, `${input.label}.issuedAt`);
  const expiresAt = exactTimestamp(session.expiresAt, `${input.label}.expiresAt`);
  if (
    typeof session.token !== "string"
    || session.token.length < 32
    || session.token.length > 16 * 1024
    || /[\0\r\n]/u.test(session.token)
    || session.purpose !== "full-maintenance-private-validation"
    || issuedAt < input.bindingRequestedAt
    || issuedAt > input.now
    || expiresAt <= input.deadlineAt
    || expiresAt > input.now + RELEASE_FULL_MAINTENANCE_PROTECTED_SESSION_MAX_REMAINING_TTL_MS
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID",
    `${input.label} is invalid, expires before the deadline, or exceeds the maximum remaining TTL`,
  );
  return session;
}

function exactValidationPrincipal(input: {
  value: unknown;
  label: string;
  requirePlatformAdmin: boolean;
}): ReleaseFullMaintenancePrivateValidationPrincipal {
  assertExactKeys(
    input.value,
    ["userId", "platformRole", "workspaceId", "workspaceRole"],
    input.label,
  );
  const principal = input.value as unknown as ReleaseFullMaintenancePrivateValidationPrincipal;
  if (
    !Number.isSafeInteger(principal.userId)
    || principal.userId < 1
    || !["owner", "admin", "developer", "billing", "viewer"].includes(principal.workspaceRole)
    || (!input.requirePlatformAdmin
      && !["owner", "admin", "developer"].includes(principal.workspaceRole))
    || (input.requirePlatformAdmin
      ? !["root", "admin", "super_admin"].includes(String(principal.platformRole))
      : principal.platformRole !== null)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", `${input.label} is not an exact role commitment`);
  exactText(principal.workspaceId, `${input.label}.workspaceId`);
  return principal;
}

export function assertReleaseFullMaintenancePrivateValidationProductionConfig(input: {
  value: unknown;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): ReleaseFullMaintenancePrivateValidationProductionConfig {
  assertReleaseFullMaintenancePrivateValidationBinding(input.binding, { now: input.now });
  assertExactKeys(input.value, [
    "format",
    "receiptDirectory",
    "privateApiNodes",
    "transport",
    "sessions",
    "principals",
    "validationPlanIntent",
    "rootMfa",
    "budget",
    "portrait",
    "seedance",
    "timeoutMs",
  ], "productionConfig");
  const config = input.value as unknown as ReleaseFullMaintenancePrivateValidationProductionConfig;
  if (config.format !== RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRODUCTION_CONFIG_FORMAT) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "production config format is invalid");
  }
  const timeoutMs = exactTimeout(config.timeoutMs);
  const deadlineAt = input.now + timeoutMs;
  protectedReceiptDirectory(config.receiptDirectory);
  try {
    assertReleaseFullMaintenancePrivateTransportConfig({
      value: config.transport,
      expectedUid: currentUid(),
    });
  } catch (error) {
    if (error instanceof ReleaseFullMaintenancePrivateTransportError) {
      fail(error.code, error.message);
    }
    throw error;
  }
  if (!Array.isArray(config.privateApiNodes) || config.privateApiNodes.length !== input.binding.apiNodeIds.length) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "private API inventory is incomplete");
  }
  const privateNodeIds = config.privateApiNodes.map((entry, index) => {
    assertExactKeys(entry, ["nodeId", "baseUrl"], `productionConfig.privateApiNodes[${index}]`);
    exactPrivateApiBaseUrl(entry.baseUrl);
    return exactText(entry.nodeId, `productionConfig.privateApiNodes[${index}].nodeId`);
  });
  if (
    privateNodeIds.some((nodeId, index) => nodeId !== input.binding.apiNodeIds[index])
    || new Set(config.privateApiNodes.map(({ baseUrl }) => baseUrl)).size !== config.privateApiNodes.length
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "private API origins do not exactly map the API inventory");
  const privateApiInventorySha256 = releaseFullMaintenancePrivateApiInventorySha256(
    config.privateApiNodes.map(({ nodeId, baseUrl }) => ({ nodeId, origin: baseUrl })),
  );
  if (privateApiInventorySha256 !== input.binding.privateApiInventorySha256) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID",
      "private API node-to-origin mapping differs from the dynamic binding",
    );
  }
  assertExactKeys(config.sessions, ["user", "admin"], "productionConfig.sessions");
  exactProtectedSession({
    value: config.sessions.user,
    label: "productionConfig.sessions.user",
    now: input.now,
    deadlineAt,
    bindingRequestedAt: input.binding.requestedAt,
  });
  exactProtectedSession({
    value: config.sessions.admin,
    label: "productionConfig.sessions.admin",
    now: input.now,
    deadlineAt,
    bindingRequestedAt: input.binding.requestedAt,
  });
  if (config.sessions.user.token === config.sessions.admin.token) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "user and admin sessions must be distinct");
  }
  assertExactKeys(config.principals, ["user", "admin"], "productionConfig.principals");
  const userPrincipal = exactValidationPrincipal({
    value: config.principals.user,
    label: "productionConfig.principals.user",
    requirePlatformAdmin: false,
  });
  const adminPrincipal = exactValidationPrincipal({
    value: config.principals.admin,
    label: "productionConfig.principals.admin",
    requirePlatformAdmin: true,
  });
  if (
    userPrincipal.userId === adminPrincipal.userId
    || userPrincipal.workspaceId !== adminPrincipal.workspaceId
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "validation user/admin identities are not distinct in one workspace");
  let validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
  try {
    validationPlanIntent = assertReleaseFullMaintenancePrivateValidationIntent(
      config.validationPlanIntent,
      {
        target: input.binding.target,
        privateApiInventorySha256: input.binding.privateApiInventorySha256,
        now: input.now,
      },
    );
  } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_INVALID", "validation intent is missing, expired, or differs from the immutable reservation");
  }
  if (
    validationPlanIntent.validationPlanIntentSha256
      !== input.binding.validationAuthority.validationPlanIntentSha256
    || canonicalReleaseFullMaintenancePrivateValidationJson(validationPlanIntent.principals)
      !== canonicalReleaseFullMaintenancePrivateValidationJson(config.principals)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_INVALID", "validation config is not authorized by the immutable reservation intent");
  assertExactKeys(config.rootMfa, [
    "proofRecordIdSha256",
    "scope",
    "method",
    "authorizationRevision",
    "consumedAt",
    "expiresAt",
    "confirmationSha256",
  ], "productionConfig.rootMfa");
  exactSha256(config.rootMfa.proofRecordIdSha256, "productionConfig.rootMfa.proofRecordIdSha256");
  const mfaConsumedAt = exactTimestamp(config.rootMfa.consumedAt, "productionConfig.rootMfa.consumedAt");
  const mfaExpiresAt = exactTimestamp(config.rootMfa.expiresAt, "productionConfig.rootMfa.expiresAt");
  if (
    config.rootMfa.scope !== "admin.deployment"
    || !["totp", "recovery"].includes(config.rootMfa.method)
    || !Number.isSafeInteger(config.rootMfa.authorizationRevision)
    || config.rootMfa.authorizationRevision < 1
    || mfaConsumedAt > input.binding.requestedAt
    || mfaConsumedAt > input.now
    || mfaExpiresAt <= deadlineAt
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "root MFA confirmation is stale, unscoped, or expires before validation");
  if (
    canonicalReleaseFullMaintenancePrivateValidationJson({
      proofRecordIdSha256: input.binding.validationAuthority.proofRecordIdSha256,
      scope: input.binding.validationAuthority.scope,
      method: input.binding.validationAuthority.method,
      authorizationRevision: input.binding.validationAuthority.authorizationRevision,
      consumedAt: input.binding.validationAuthority.consumedAt,
      expiresAt: input.binding.validationAuthority.expiresAt,
      confirmationSha256: input.binding.validationAuthority.rootMfaConfirmationSha256,
    }) !== canonicalReleaseFullMaintenancePrivateValidationJson(config.rootMfa)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_INVALID", "root MFA config is not the reservation-consumed admin.deployment authorization");
  assertExactKeys(config.budget, [
    "currency",
    "maximumGuMicros",
    "maximumProviderTasks",
    "expiresAt",
  ], "productionConfig.budget");
  if (
    config.budget.currency !== "GU"
    || !Number.isSafeInteger(config.budget.maximumGuMicros)
    || config.budget.maximumGuMicros < 1
    || config.budget.maximumProviderTasks !== 2
    || exactTimestamp(config.budget.expiresAt, "productionConfig.budget.expiresAt") <= deadlineAt
    || config.budget.expiresAt > config.rootMfa.expiresAt
    || config.budget.expiresAt > config.sessions.user.expiresAt
    || config.budget.expiresAt > config.sessions.admin.expiresAt
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "validation budget is invalid or expires before validation");
  assertExactKeys(config.portrait, [
    "workspaceId",
    "projectId",
    "assetVersionId",
    "scriptId",
    "trackId",
    "model",
    "modelRouteId",
    "expectedProviderAssetUriSha256",
    "expectedProviderSourceSha256",
    "expectedProviderChannelIdSha256",
    "aspectRatio",
    "durationSeconds",
    "outputResolution",
    "pollTimeoutMs",
    "pollIntervalMs",
  ], "productionConfig.portrait");
  exactText(config.portrait.workspaceId, "productionConfig.portrait.workspaceId");
  exactText(config.portrait.model, "productionConfig.portrait.model");
  exactText(config.portrait.modelRouteId, "productionConfig.portrait.modelRouteId");
  exactSha256(config.portrait.expectedProviderAssetUriSha256, "productionConfig.portrait.expectedProviderAssetUriSha256");
  exactSha256(config.portrait.expectedProviderSourceSha256, "productionConfig.portrait.expectedProviderSourceSha256");
  exactSha256(config.portrait.expectedProviderChannelIdSha256, "productionConfig.portrait.expectedProviderChannelIdSha256");
  if (
    !Number.isSafeInteger(config.portrait.projectId) || config.portrait.projectId < 1
    || !Number.isSafeInteger(config.portrait.assetVersionId) || config.portrait.assetVersionId < 1
    || !Number.isSafeInteger(config.portrait.scriptId) || config.portrait.scriptId < 1
    || !Number.isSafeInteger(config.portrait.trackId) || config.portrait.trackId < 1
    || !Number.isSafeInteger(config.portrait.pollTimeoutMs)
    || config.portrait.pollTimeoutMs < 60_000
    || config.portrait.pollTimeoutMs > timeoutMs
    || !Number.isSafeInteger(config.portrait.pollIntervalMs)
    || config.portrait.pollIntervalMs < 1_000
    || config.portrait.pollIntervalMs > 60_000
    || config.portrait.aspectRatio !== "16:9"
    || config.portrait.durationSeconds !== 4
    || config.portrait.outputResolution !== "720p"
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "portrait validation timing or identity is invalid");
  if (
    userPrincipal.workspaceId !== config.portrait.workspaceId
    || adminPrincipal.workspaceId !== config.portrait.workspaceId
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "principal workspace differs from portrait scope");
  assertExactKeys(config.seedance, [
    "productionEnvFile",
    "probeId",
    "workspaceId",
    "projectId",
    "adminUserId",
    "createdAt",
    "expiresAt",
    "priceSourceUrl",
    "priceSourceContentSha256",
    "priceCheckedAt",
    "upstreamCurrency",
    "upstreamUnitPriceMicros",
    "billingCurrency",
    "billingDimension",
    "validUntil",
    "pollIntervalMs",
    "timeoutMs",
  ], "productionConfig.seedance");
  if (config.seedance.productionEnvFile !== "/opt/fanjin/shared/env/fanjin.env") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "Seedance must use the fixed production environment file");
  }
  exactText(config.seedance.probeId, "productionConfig.seedance.probeId");
  exactText(config.seedance.workspaceId, "productionConfig.seedance.workspaceId");
  exactText(config.seedance.priceSourceUrl, "productionConfig.seedance.priceSourceUrl");
  exactSha256(config.seedance.priceSourceContentSha256, "productionConfig.seedance.priceSourceContentSha256");
  exactCanonicalRfc3339(config.seedance.createdAt, "productionConfig.seedance.createdAt");
  exactCanonicalRfc3339(config.seedance.expiresAt, "productionConfig.seedance.expiresAt");
  exactCanonicalRfc3339(config.seedance.priceCheckedAt, "productionConfig.seedance.priceCheckedAt");
  exactCanonicalRfc3339(config.seedance.validUntil, "productionConfig.seedance.validUntil");
  const seedanceCreatedAt = Date.parse(config.seedance.createdAt);
  const seedanceExpiresAt = Date.parse(config.seedance.expiresAt);
  if (
    !Number.isSafeInteger(config.seedance.projectId) || config.seedance.projectId < 1
    || !Number.isSafeInteger(config.seedance.adminUserId) || config.seedance.adminUserId < 1
    || config.seedance.upstreamCurrency !== "CNY"
    || config.seedance.billingCurrency !== "GU"
    || config.seedance.billingDimension !== "token"
    || !Number.isSafeInteger(config.seedance.upstreamUnitPriceMicros)
    || config.seedance.upstreamUnitPriceMicros < 1
    || !Number.isSafeInteger(config.seedance.pollIntervalMs)
    || config.seedance.pollIntervalMs < 250
    || config.seedance.pollIntervalMs > 60_000
    || !Number.isSafeInteger(config.seedance.timeoutMs)
    || config.seedance.timeoutMs < config.seedance.pollIntervalMs
    || config.seedance.timeoutMs > timeoutMs
    || config.seedance.probeId !== validationPlanIntent.seedanceProbeId
    || seedanceCreatedAt < input.binding.requestedAt
    || seedanceCreatedAt > input.now
    || seedanceExpiresAt <= deadlineAt
    || config.seedance.workspaceId !== config.portrait.workspaceId
    || config.seedance.projectId !== config.portrait.projectId
    || config.seedance.adminUserId !== adminPrincipal.userId
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "Seedance validation parameters are invalid");
  if (
    validationPlanIntent.workspaceId !== config.portrait.workspaceId
    || validationPlanIntent.projectId !== config.portrait.projectId
    || validationPlanIntent.assetVersionId !== config.portrait.assetVersionId
    || canonicalReleaseFullMaintenancePrivateValidationJson(validationPlanIntent.portrait)
      !== canonicalReleaseFullMaintenancePrivateValidationJson({
        scriptId: config.portrait.scriptId,
        trackId: config.portrait.trackId,
        model: config.portrait.model,
        modelRouteId: config.portrait.modelRouteId,
        expectedProviderAssetUriSha256: config.portrait.expectedProviderAssetUriSha256,
        expectedProviderSourceSha256: config.portrait.expectedProviderSourceSha256,
        expectedProviderChannelIdSha256: config.portrait.expectedProviderChannelIdSha256,
        aspectRatio: config.portrait.aspectRatio,
        durationSeconds: config.portrait.durationSeconds,
        outputResolution: config.portrait.outputResolution,
      })
    || validationPlanIntent.budget.currency !== config.budget.currency
    || validationPlanIntent.budget.maximumGuMicros !== config.budget.maximumGuMicros
    || validationPlanIntent.budget.maximumProviderTasks !== config.budget.maximumProviderTasks
    || validationPlanIntent.expiresAt !== config.budget.expiresAt
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_AUTHORITY_INVALID", "runtime probe, asset, provider, or budget differs from the Root-MFA-authorized intent");
  return config;
}

function readProtectedCanonicalJsonFile(input: {
  filePath: string;
  contentSha256: string;
  platform?: NodeJS.Platform;
  effectiveUid?: number;
}): unknown {
  if ((input.platform ?? process.platform) !== "linux") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "production private validation requires Linux");
  }
  if (
    !path.isAbsolute(input.filePath)
    || path.normalize(input.filePath) !== input.filePath
    || input.filePath === path.parse(input.filePath).root
    || !RAW_SHA256.test(input.contentSha256)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "protected input pin is invalid");
  const parent = path.dirname(input.filePath);
  if (realpathSync(parent) !== parent) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "protected input directory is not canonical");
  }
  const parentMetadata = lstatSync(parent);
  const expectedUid = input.effectiveUid
    ?? (typeof process.geteuid === "function" ? process.geteuid() : currentUid());
  if (
    parentMetadata.isSymbolicLink()
    || !parentMetadata.isDirectory()
    || (parentMetadata.mode & 0o777) !== 0o700
    || (expectedUid !== undefined && parentMetadata.uid !== expectedUid)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "protected input directory is not owner-only 0700");
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "O_NOFOLLOW is unavailable");
  }
  const descriptor = openSync(input.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size < 2
      || before.size > MAX_RECEIPT_BYTES
      || (expectedUid !== undefined && before.uid !== expectedUid)
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "protected input is not owner-only 0600");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.length !== before.size
      || rawSha256(bytes) !== input.contentSha256
    ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STORAGE_UNSAFE", "protected input changed or differs from its pin");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "protected input JSON is invalid");
    }
    if (!bytes.equals(Buffer.from(`${canonicalReleaseFullMaintenancePrivateValidationJson(parsed)}\n`, "utf8"))) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID", "protected input is not exact canonical JSON plus newline");
    }
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}

export function loadReleaseFullMaintenancePrivateValidationBindingFile(input: {
  filePath: string;
  contentSha256: string;
  now: number;
  platform?: NodeJS.Platform;
  effectiveUid?: number;
}): ReleaseFullMaintenancePrivateValidationBinding {
  return assertReleaseFullMaintenancePrivateValidationBinding(
    readProtectedCanonicalJsonFile(input),
    { now: input.now },
  );
}

/**
 * Consume a bounded, digest-pinned canonical config from a managed pipe. Raw
 * session tokens remain process-local and are never materialized as a normal
 * filesystem path by the validator.
 */
export function loadReleaseFullMaintenancePrivateValidationProductionConfigBytes(input: {
  canonicalBytes: Buffer;
  contentSha256: string;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now: number;
}): ReleaseFullMaintenancePrivateValidationProductionConfig {
  if (
    !Buffer.isBuffer(input.canonicalBytes)
    || input.canonicalBytes.length < 2
    || input.canonicalBytes.length > MAX_RECEIPT_BYTES
    || !RAW_SHA256.test(input.contentSha256)
    || rawSha256(input.canonicalBytes) !== input.contentSha256
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID",
    "managed config bytes are empty, oversized, or differ from their content pin",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.canonicalBytes.toString("utf8"));
  } catch {
    return fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID",
      "managed config bytes are not valid JSON",
    );
  }
  const canonical = Buffer.from(
    `${canonicalReleaseFullMaintenancePrivateValidationJson(parsed)}\n`,
    "utf8",
  );
  if (!input.canonicalBytes.equals(canonical)) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CONFIG_INVALID",
      "managed config bytes are not exact canonical JSON plus newline",
    );
  }
  return assertReleaseFullMaintenancePrivateValidationProductionConfig({
    value: parsed,
    binding: input.binding,
    now: input.now,
  });
}

function exactTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIMEOUT_INVALID", "validation timeout is invalid");
  }
  return value;
}

export function createReleaseFullMaintenancePrivateValidation(
  options: ReleaseFullMaintenancePrivateValidationOptions,
): (
  binding: ReleaseFullMaintenancePrivateValidationBinding,
) => Promise<PersistedReleaseFullMaintenancePrivateValidationReceipt> {
  if (!options?.executor || typeof options.executor.execute !== "function") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_ADAPTER_UNAVAILABLE", "real private validation executor is unavailable");
  }
  if (!options?.collector || typeof options.collector.collect !== "function") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_ADAPTER_UNAVAILABLE", "real private validation collector is unavailable");
  }
  const timeoutMs = exactTimeout(options.timeoutMs);
  const now = options.now ?? Date.now;
  return async (untrustedBinding) => {
    if (options.signal?.aborted) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTERRUPTED",
        "private validation was interrupted before it started",
      );
    }
    const startedNow = now();
    const binding = assertReleaseFullMaintenancePrivateValidationBinding(untrustedBinding, { now: startedNow });
    const deadlineAt = startedNow + timeoutMs;
    if (!Number.isSafeInteger(deadlineAt)) {
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIMEOUT_INVALID", "validation deadline overflows");
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let rejectInterrupted: ((reason: unknown) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    const interrupt = () => {
      controller.abort(options.signal?.reason);
      rejectInterrupted?.(new ReleaseFullMaintenancePrivateValidationError(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_INTERRUPTED",
        "private validation was interrupted and cleanup is required",
      ));
    };
    options.signal?.addEventListener("abort", interrupt, { once: true });
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ReleaseFullMaintenancePrivateValidationError(
          "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIMED_OUT",
          "real private validation exceeded its exact deadline",
        ));
      }, timeoutMs);
      timer.unref?.();
    });
    const workflow = async (): Promise<PersistedReleaseFullMaintenancePrivateValidationReceipt> => {
      const context: ReleaseFullMaintenancePrivateValidationExecutionContext = {
        binding,
        deadlineAt,
        signal: controller.signal,
      };
      const execution = assertExecution({
        execution: await options.executor.execute(context),
        binding,
        now: now(),
      });
      const candidate = await options.collector.collect({ ...context, execution });
      const completedNow = now();
      if (completedNow > deadlineAt || controller.signal.aborted) {
        fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIMED_OUT", "real private validation exceeded its exact deadline");
      }
      const receipt = receiptFromCandidate({ candidate, execution, binding, now: completedNow });
      return persistReleaseFullMaintenancePrivateValidationReceipt({
        directory: options.receiptDirectory,
        receipt,
        binding,
        now: completedNow,
      });
    };
    try {
      return await Promise.race([workflow(), timedOut, interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", interrupt);
    }
  };
}

type ProductionExecutionState = {
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  plan: ReleaseFullMaintenancePrivateValidationPlan;
  tunnels: readonly ReleaseFullMaintenancePrivateNodeTunnel[];
  nodeProofs: readonly ReleaseFullMaintenancePrivateNodeProof[];
  principalEvidence: readonly Readonly<Record<string, unknown>>[];
  healthEvidence: ReleaseFullMaintenancePrivateApiHealthEvidence;
  portraitReceipts: PortraitLiveSmokeReceipt[];
  portraitGeneration: ReleaseFullMaintenancePrivatePortraitGenerationEvidence;
  seedanceReceipt: Seedance25CertificationOperatorReceipt;
  seedanceFreshEvidence: Readonly<Record<string, unknown>>;
  budgetHandle: ReleaseFullMaintenancePrivateValidationBudgetHandle;
  budgetFinalEvidence: ReleaseFullMaintenancePrivateValidationBudgetFinalEvidence;
  database: Knex;
};

type ReleaseFullMaintenancePrivatePortraitGenerationEvidence = Readonly<{
  taskId: string;
  requestId: string;
  videoId: number;
  scriptId: number;
  trackId: number;
  apiNodeId: string;
  apiNodeProofSha256: string;
  idempotencyKeySha256: string;
  workbenchCommandSha256: string;
  resourceGraphSha256: string;
  canonicalRequestSha256: string;
  providerAssetBindingSha256: string;
  workerExecutionSha256: string;
  workerHeartbeatSha256: string;
  workerDispatchEvidence: Readonly<{
    scope: "provider-post-dispatch-only";
    workerExecution: RelayWorkerExecutionAttestation;
    currentHeartbeat: Readonly<Record<string, unknown>>;
    observedAt: number;
  }>;
  taskSha256: string;
  providerSha256: string;
  deliverySha256: string;
}>;

type ReleaseFullMaintenancePrivateApiHealthEvidence = Readonly<{
  format: "fanjin-release-full-maintenance-private-api-inventory/v2";
  homogeneousFleetEvidenceSha256: string;
  imageDigest: string;
  privateApiInventory: ReleaseFullMaintenancePrivateApiInventoryCommitment;
  privateApiInventorySha256: string;
  observations: readonly Readonly<{
    nodeId: string;
    originSha256: string;
    loopbackOriginSha256: string;
    nodeProof: ReleaseFullMaintenancePrivateNodeProof;
    health: Readonly<Record<string, unknown>>;
    ready: Readonly<Record<string, unknown>>;
    nodeTargetEvidenceSha256: string;
  }>[];
}>;

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIMED_OUT", "private validation was aborted");
  }
}

async function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(new ReleaseFullMaintenancePrivateValidationError(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TIMED_OUT",
        "private validation sleep was aborted",
      ));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    timer.unref?.();
  });
}

async function boundedPrivateJson(input: {
  baseUrl: string;
  pathname: "/api/health" | "/api/ready";
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  assertNotAborted(input.signal);
  assertReleaseFullMaintenancePrivateCredentialedOrigin(input.baseUrl);
  const url = new URL(input.pathname, input.baseUrl);
  if (url.origin !== input.baseUrl || url.protocol !== "http:") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_ORIGIN_INVALID", "private request escaped its pinned origin");
  }
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: input.signal,
  });
  if (response.status !== 200) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_READINESS_FAILED", "private health/readiness did not return 200");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > MAX_RECEIPT_BYTES) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_READINESS_FAILED", "private health/readiness response is unbounded");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_READINESS_FAILED", "private health/readiness response is invalid JSON");
  }
  if (!isRecord(parsed)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_READINESS_FAILED", "private health/readiness response is not an object");
  }
  return parsed;
}

export function assertReleaseFullMaintenancePrivateCredentialedOrigin(value: unknown): string {
  if (typeof value !== "string") {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_ORIGIN_INVALID", "credentialed origin is missing");
  }
  let url: URL;
  try { url = new URL(value); } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_ORIGIN_INVALID", "credentialed origin is invalid");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !Number.isInteger(port)
    || port < 1_024
    || port > 65_535
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || value !== `http://127.0.0.1:${port}`
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_ORIGIN_INVALID",
    "business HTTP and bearer credentials are restricted to a proven local SSH tunnel",
  );
  return value;
}

async function privateSessionRequest(input: {
  loopbackOrigin: string;
  pathname: "/api/auth/me" | "/api/auth/logout";
  method: "GET" | "POST";
  token: string;
  expectedStatus: 200 | 401;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  assertNotAborted(input.signal);
  const origin = assertReleaseFullMaintenancePrivateCredentialedOrigin(input.loopbackOrigin);
  const url = new URL(input.pathname, origin);
  if (url.origin !== origin) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_ORIGIN_INVALID", "session request escaped its proven tunnel");
  }
  const response = await fetch(url, {
    method: input.method,
    headers: {
      accept: "application/json",
      authorization: input.token,
      "cache-control": "no-store",
    },
    redirect: "error",
    signal: input.signal,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    response.status !== input.expectedStatus
    || bytes.length < 2
    || bytes.length > MAX_RECEIPT_BYTES
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID", "session endpoint status or response bounds differ");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID", "session endpoint returned invalid JSON");
  }
  if (!isRecord(parsed)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID", "session endpoint response is not an object");
  }
  return parsed;
}

type PrivatePortraitWorkbenchRequest = Readonly<{
  projectId: number;
  scriptId: number;
  model: string;
  resolution: "720p";
  audio: false;
  trackData: readonly Readonly<{
    trackId: number;
    prompt: string;
    duration: 4;
    operation: "generate";
    references: readonly Readonly<{
      assetVersionId: string;
      role: "subject";
      mediaType: "image";
      order: 0;
    }>[];
  }>[];
}>;

function createPrivatePortraitWorkbenchRequest(input: {
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
}): PrivatePortraitWorkbenchRequest {
  return Object.freeze({
    projectId: input.config.portrait.projectId,
    scriptId: input.config.portrait.scriptId,
    model: input.config.portrait.model,
    resolution: input.config.portrait.outputResolution,
    audio: false,
    trackData: Object.freeze([Object.freeze({
      trackId: input.config.portrait.trackId,
      prompt: `Fanjin deployment ${input.binding.deploymentId} portrait delivery validation`,
      duration: input.config.portrait.durationSeconds,
      operation: "generate" as const,
      references: Object.freeze([Object.freeze({
        assetVersionId: String(input.config.portrait.assetVersionId),
        role: "subject" as const,
        mediaType: "image" as const,
        order: 0 as const,
      })]),
    })]),
  });
}

export async function requestReleaseFullMaintenancePrivateWorkbenchJson(input: {
  loopbackOrigin: string;
  pathname: "/api/workbench/create/videos" | "/api/workbench/create/videos/batch/status";
  token: string;
  body: PrivatePortraitWorkbenchRequest | Readonly<{ projectId: number; idempotencyKey: string }>;
  idempotencyKey?: string;
  privateValidationBudgetHeader?: string;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  assertNotAborted(input.signal);
  const origin = assertReleaseFullMaintenancePrivateCredentialedOrigin(input.loopbackOrigin);
  const url = new URL(input.pathname, origin);
  if (
    url.origin !== origin
    || url.pathname !== input.pathname
    || url.search !== ""
    || url.hash !== ""
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_ORIGIN_INVALID",
    "Workbench request escaped its proven API-node tunnel",
  );
  if ((input.pathname === "/api/workbench/create/videos") !== Boolean(input.idempotencyKey)) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
      "the formal Workbench mutation must carry one exact idempotency key",
    );
  }
  if (input.privateValidationBudgetHeader && input.pathname !== "/api/workbench/create/videos") {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
      "the private validation budget capability is restricted to the Workbench mutation",
    );
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: input.token,
      "cache-control": "no-store",
      "content-type": "application/json",
      ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
      ...(input.privateValidationBudgetHeader
        ? { "x-fanjin-private-validation-budget": input.privateValidationBudgetHeader }
        : {}),
    },
    body: JSON.stringify(input.body),
    redirect: "error",
    signal: input.signal,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200 || bytes.length < 2 || bytes.length > MAX_RECEIPT_BYTES) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
      "formal Workbench portrait request did not return a bounded HTTP 200 response",
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
      "formal Workbench portrait response is invalid JSON",
    );
  }
  if (
    !isRecord(parsed)
    || parsed.code !== 200
    || (
      input.pathname === "/api/workbench/create/videos"
        ? !Array.isArray(parsed.data)
        : !isRecord(parsed.data)
    )
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
      "formal Workbench portrait response has an invalid success envelope",
    );
  }
  return parsed;
}

function exactPrincipalFromMe(input: {
  response: Record<string, unknown>;
  expected: ReleaseFullMaintenancePrivateValidationPrincipal;
  nodeId: string;
  kind: "user" | "admin";
}): Readonly<Record<string, unknown>> {
  const data = isRecord(input.response.data) ? input.response.data : null;
  const identity = data && isRecord(data.identity) ? data.identity : null;
  if (
    input.response.code !== 200
    || !identity
    || Number(identity.userId) !== input.expected.userId
    || identity.platformRole !== input.expected.platformRole
    || identity.workspaceId !== input.expected.workspaceId
    || identity.workspaceRole !== input.expected.workspaceRole
    || identity.userStatus !== "active"
    || identity.workspaceStatus !== "active"
    || identity.membershipStatus !== "active"
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_IDENTITY_MISMATCH", "validation session does not match its exact principal and workspace role");
  return Object.freeze({
    nodeId: input.nodeId,
    kind: input.kind,
    userId: input.expected.userId,
    platformRole: input.expected.platformRole,
    workspaceId: input.expected.workspaceId,
    workspaceRole: input.expected.workspaceRole,
    identitySha256: releaseFullMaintenancePrivateValidationSha256(identity),
  });
}

async function verifyPrivateValidationPrincipals(input: {
  tunnels: readonly ReleaseFullMaintenancePrivateNodeTunnel[];
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  signal: AbortSignal;
}): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const evidence: Readonly<Record<string, unknown>>[] = [];
  for (const tunnel of input.tunnels) {
    for (const kind of ["user", "admin"] as const) {
      const response = await privateSessionRequest({
        loopbackOrigin: tunnel.loopbackOrigin,
        pathname: "/api/auth/me",
        method: "GET",
        token: input.config.sessions[kind].token,
        expectedStatus: 200,
        signal: input.signal,
      });
      evidence.push(exactPrincipalFromMe({
        response,
        expected: input.config.principals[kind],
        nodeId: tunnel.nodeId,
        kind,
      }));
    }
  }
  return Object.freeze(evidence);
}

export async function revokeReleaseFullMaintenancePrivateValidationSessions(input: {
  tunnel: ReleaseFullMaintenancePrivateNodeTunnel;
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref?.();
  const failures: unknown[] = [];
  try {
    for (const kind of ["user", "admin"] as const) {
      const token = input.config.sessions[kind].token;
      try {
        const logout = await privateSessionRequest({
          loopbackOrigin: input.tunnel.loopbackOrigin,
          pathname: "/api/auth/logout",
          method: "POST",
          token,
          expectedStatus: 200,
          signal: controller.signal,
        });
        if (logout.code !== 200) throw new Error("logout response code differs");
        await privateSessionRequest({
          loopbackOrigin: input.tunnel.loopbackOrigin,
          pathname: "/api/auth/me",
          method: "GET",
          token,
          expectedStatus: 401,
          signal: controller.signal,
        });
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (failures.length) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_REVOCATION_FAILED", "dedicated validation session logout or 401 readback failed");
  }
}

function exactHttpRelease(input: {
  response: Record<string, unknown>;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  ready: boolean;
}): Readonly<Record<string, unknown>> {
  const release = input.response.release;
  if (!isRecord(release)) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_IDENTITY_MISMATCH", "private response has no release identity");
  }
  const projection = {
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    artifactSha256: release.artifactSha256,
    schemaVersion: release.schemaVersion,
  };
  if (
    input.response.ok !== true
    || (input.ready && input.response.status !== "ready")
    || projection.releaseId !== input.binding.target.releaseId
    || projection.sourceCommit !== input.binding.target.sourceCommit
    || projection.artifactSha256 !== input.binding.target.artifactSha256
    || projection.schemaVersion !== 48
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_IDENTITY_MISMATCH", "private response differs from the exact target");
  return projection;
}

async function provePrivateApiInventory(input: {
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  tunnels: readonly ReleaseFullMaintenancePrivateNodeTunnel[];
  signal: AbortSignal;
}): Promise<ReleaseFullMaintenancePrivateApiHealthEvidence> {
  const privateApiInventory = privateApiInventoryCommitment(
    input.config.privateApiNodes.map(({ nodeId, baseUrl }) => ({ nodeId, origin: baseUrl })),
  );
  const privateApiInventorySha256 = releaseFullMaintenancePrivateValidationSha256(
    privateApiInventory,
  );
  if (privateApiInventorySha256 !== input.binding.privateApiInventorySha256) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_IDENTITY_MISMATCH",
      "private API health inventory differs from the dynamic binding",
    );
  }
  const observations = [];
  for (const node of input.config.privateApiNodes) {
    const tunnel = input.tunnels.find((entry) => entry.nodeId === node.nodeId);
    if (!tunnel) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID", "private tunnel inventory is incomplete");
    const health = await boundedPrivateJson({ baseUrl: tunnel.loopbackOrigin, pathname: "/api/health", signal: input.signal });
    const ready = await boundedPrivateJson({ baseUrl: tunnel.loopbackOrigin, pathname: "/api/ready", signal: input.signal });
    observations.push({
      nodeId: node.nodeId,
      originSha256: rawSha256(node.baseUrl),
      loopbackOriginSha256: rawSha256(tunnel.loopbackOrigin),
      nodeProof: tunnel.proof,
      health: exactHttpRelease({ response: health, binding: input.binding, ready: false }),
      ready: exactHttpRelease({ response: ready, binding: input.binding, ready: true }),
      nodeTargetEvidenceSha256: input.binding.homogeneousFleetEvidence.targetEvidenceSha256ByKey[node.nodeId],
    });
  }
  return {
    format: "fanjin-release-full-maintenance-private-api-inventory/v2",
    homogeneousFleetEvidenceSha256: input.binding.homogeneousFleetEvidenceSha256,
    imageDigest: input.binding.target.imageDigest,
    privateApiInventory,
    privateApiInventorySha256,
    observations,
  };
}

function portraitCommand(input: {
  baseUrl: string;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  phase: "execute" | "verify";
}): Extract<PortraitLiveSmokeCommand, { kind: "run" }> {
  assertReleaseFullMaintenancePrivateCredentialedOrigin(input.baseUrl);
  const command = {
    kind: "run" as const,
    paid: true as const,
    production: true as const,
    baseUrl: input.baseUrl,
    expectedReleaseId: input.binding.target.releaseId,
    expectedSourceCommit: input.binding.target.sourceCommit,
    expectedArtifactSha256: input.binding.target.artifactSha256,
    expectedSchemaVersion: 48,
    workspaceId: input.config.portrait.workspaceId,
    projectId: input.config.portrait.projectId,
    assetVersionId: input.config.portrait.assetVersionId,
    model: input.config.portrait.model,
    subject: "aigc" as const,
    phase: input.phase,
    identityLabel: null,
    receiptFile: path.join(input.config.receiptDirectory, ".portrait-library-owned-no-direct-write"),
    h5HandoffFile: null,
    pollTimeoutMs: input.config.portrait.pollTimeoutMs,
    pollIntervalMs: input.config.portrait.pollIntervalMs,
    userSessionKeychainService: "protected-full-maintenance-config",
    userSessionKeychainAccount: "user",
    adminSessionKeychainService: "protected-full-maintenance-config",
    adminSessionKeychainAccount: "admin",
  };
  // The exported parser pins the standalone operator to the public origin.
  // This wrapper supplies the same runtime command shape only through a
  // node-proven local SSH tunnel. No bearer is ever emitted to an RFC1918 URL.
  return command as unknown as Extract<PortraitLiveSmokeCommand, { kind: "run" }>;
}

function portraitDependencies(input: {
  baseUrl: string;
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  signal: AbortSignal;
}): PortraitLiveSmokeDependencies {
  return Object.freeze({
    fetch: async (resource: string | URL | Request, init?: RequestInit) => {
      assertNotAborted(input.signal);
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (
        url.origin !== input.baseUrl
        || assertReleaseFullMaintenancePrivateCredentialedOrigin(input.baseUrl) !== input.baseUrl
      ) {
        fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PRIVATE_ORIGIN_INVALID", "portrait request escaped its pinned private node");
      }
      return fetch(resource, { ...init, redirect: "error", signal: input.signal });
    },
    now: Date.now,
    sleep: (milliseconds: number) => sleepWithAbort(milliseconds, input.signal),
    readKeychainSecret: (service: string, account: string) => {
      if (service !== "protected-full-maintenance-config") {
        fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID", "portrait requested an unknown protected session");
      }
      if (account === "user") return input.config.sessions.user.token;
      if (account === "admin") return input.config.sessions.admin.token;
      fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SESSION_INVALID", "portrait requested an unknown protected session");
    },
  });
}

function assertPortraitReceipt(receipt: PortraitLiveSmokeReceipt): void {
  if (
    receipt.status !== "passed"
    || receipt.failureCode !== null
    || receipt.workflow !== "AIGC"
    || receipt.authorization.status !== "not_applicable"
    || receipt.authorization.handoffStatus !== "not_applicable"
    || receipt.release.status !== "matched"
    || receipt.release.schemaVersion !== 48
    || receipt.admission.subjectKind !== "aigc"
    || receipt.admission.complianceState !== "allowed"
    || receipt.admission.providerSyncState !== "active"
    || receipt.admission.identityState !== "active"
    || receipt.admission.status !== "ready"
    || receipt.provider.status !== "active"
    || receipt.provider.groupType !== "AIGC"
    || receipt.provider.groupState !== "active"
    || receipt.provider.assetState !== "active"
    || receipt.provider.providerBinding !== "active_business_binding"
    || !RAW_SHA256.test(String(receipt.provider.bindingSnapshotSha256 || ""))
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_FAILED", "AIGC portrait execute/verify did not produce active provider evidence");
}

async function runPrivatePortraitValidation(input: {
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  tunnels: readonly ReleaseFullMaintenancePrivateNodeTunnel[];
  signal: AbortSignal;
}): Promise<PortraitLiveSmokeReceipt[]> {
  const receipts: PortraitLiveSmokeReceipt[] = [];
  for (const node of input.tunnels) {
    const verify = await runPortraitLiveSmoke(
      portraitCommand({ baseUrl: node.loopbackOrigin, binding: input.binding, config: input.config, phase: "verify" }),
      portraitDependencies({ baseUrl: node.loopbackOrigin, config: input.config, signal: input.signal }),
    );
    assertPortraitReceipt(verify);
    receipts.push(verify);
  }
  return receipts;
}

async function openProductionDatabase(
  config: ReleaseFullMaintenancePrivateValidationProductionConfig,
): Promise<Knex> {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("FANJIN_RELEASE_CONTROLLER_")
      || key.startsWith("FANJIN_MIGRATION_")
    ) delete process.env[key];
  }
  process.env.FANJIN_ENV_FILE = config.seedance.productionEnvFile;
  const runtime = await import("../../scripts/lib/seedance25-production-cli-runtime");
  runtime.loadSeedance25ProductionOperatorEnvironment({ apply: true });
  await import("@/env");
  const { createDatabaseClient } = await import("@/lib/createDatabaseClient");
  const database = createDatabaseClient({ logConfiguration: false });
  runtime.assertSeedance25ProductionApplyDatabase(database);
  return database;
}

function collectExactString(value: unknown, expected: string): number {
  if (value === expected) return 1;
  if (Array.isArray(value)) return value.reduce<number>((total, entry) => total + collectExactString(entry, expected), 0);
  if (!isRecord(value)) return 0;
  return Object.values(value).reduce<number>((total, entry) => total + collectExactString(entry, expected), 0);
}

function assertExactPortraitProviderWireReference(input: {
  providerPayload: Record<string, unknown>;
  providerAssetUri: string;
}): void {
  const request = jsonRecord(input.providerPayload.request);
  const content = Array.isArray(request.content) ? request.content : [];
  const mediaItems = content.filter((item) => (
    isRecord(item)
    && item.type !== "text"
  ));
  const media = mediaItems.length === 1 && isRecord(mediaItems[0])
    ? mediaItems[0]
    : null;
  const imageUrl = media ? jsonRecord(media.image_url) : {};
  if (
    !media
    || media.type !== "image_url"
    || media.role !== "reference_image"
    || Object.keys(imageUrl).length !== 1
    || imageUrl.url !== input.providerAssetUri
    || collectExactString(input.providerPayload, input.providerAssetUri) !== 1
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
    "portrait provider request does not carry exactly one asset URI at request.content[].image_url.url",
  );
}

export function assertReleaseFullMaintenancePrivatePortraitWorkerExecutionEvidence(input: {
  task: Record<string, unknown>;
  heartbeat: Record<string, unknown> | undefined;
  expectedWorkerExecution?: unknown;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  expectedTaskId: string;
  expectedRequestId: string;
  observedAt: number;
}): Readonly<{
  workerExecution: RelayWorkerExecutionAttestation;
  workerExecutionSha256: string;
  workerHeartbeatSha256: string;
}> {
  const providerPayload = jsonRecord(input.task.providerPayload);
  const submission = jsonRecord(providerPayload.submission);
  let workerExecution: RelayWorkerExecutionAttestation;
  try {
    workerExecution = assertRelayWorkerExecutionAttestation(submission.workerExecution);
  } catch {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_WORKER_EXECUTION_REQUIRED",
      "portrait provider dispatch lacks a durable dedicated-Worker execution attestation",
    );
  }
  if (input.expectedWorkerExecution !== undefined) {
    let sealed: RelayWorkerExecutionAttestation;
    try {
      sealed = assertRelayWorkerExecutionAttestation(input.expectedWorkerExecution);
    } catch {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_WORKER_EXECUTION_REQUIRED",
        "sealed portrait Worker execution evidence is invalid",
      );
    }
    if (sealed.attestationSha256 !== workerExecution.attestationSha256) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_WORKER_EXECUTION_REQUIRED",
        "terminal portrait task differs from the Worker execution evidence sealed during polling",
      );
    }
  }
  const heartbeat = input.heartbeat;
  const workerFleet = input.binding.homogeneousFleetEvidence.workers.find(
    (entry) => entry.nodeId === workerExecution.nodeId,
  );
  const heartbeatAt = Number(heartbeat?.heartbeatAt);
  const heartbeatUpdatedAt = Number(heartbeat?.updatedAt);
  const heartbeatStartedAt = Number(heartbeat?.startedAt);
  const heartbeatCreatedAt = Number(heartbeat?.createdAt);
  const submittedAt = Number(input.task.submittedAt);
  if (
    !heartbeat
    || workerExecution.processRole !== "worker"
    || workerExecution.taskId !== input.expectedTaskId
    || workerExecution.requestIdSha256 !== rawSha256(input.expectedRequestId)
    || workerExecution.releaseId !== input.binding.target.releaseId
    || workerExecution.sourceCommit !== input.binding.target.sourceCommit
    || workerExecution.artifactSha256 !== input.binding.target.artifactSha256
    || workerExecution.schemaVersion !== 48
    || workerExecution.imageDigest !== input.binding.target.imageDigest
    || workerExecution.dispatchStartedAt !== submittedAt
    || !input.binding.workerNodeIds.includes(workerExecution.nodeId)
    || !workerFleet
    || !RAW_SHA256.test(String(
      input.binding.homogeneousFleetEvidence.targetEvidenceSha256ByKey[workerExecution.nodeId] || "",
    ))
    || heartbeat.id !== workerExecution.incarnationId
    || heartbeat.incarnationId !== workerExecution.incarnationId
    || heartbeat.role !== "background"
    || heartbeat.hostname !== workerExecution.hostname
    || Number(heartbeat.processId) !== workerExecution.processId
    || heartbeat.nodeId !== workerExecution.nodeId
    || heartbeat.releaseId !== workerExecution.releaseId
    || heartbeat.artifactSha256 !== workerExecution.artifactSha256
    || Number(heartbeat.schemaVersion) !== workerExecution.schemaVersion
    || Number(heartbeat.acceptingWork) !== 1
    || heartbeatStartedAt !== workerExecution.heartbeatStartedAt
    || !Number.isSafeInteger(heartbeatCreatedAt)
    || heartbeatCreatedAt > heartbeatStartedAt
    || !Number.isSafeInteger(heartbeatAt)
    || heartbeatAt < workerExecution.heartbeatAt
    || heartbeatAt > input.observedAt + 5_000
    || heartbeatAt < input.observedAt - 45_000
    || !Number.isSafeInteger(heartbeatUpdatedAt)
    || heartbeatUpdatedAt < workerExecution.heartbeatUpdatedAt
    || heartbeatUpdatedAt < heartbeatAt
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_WORKER_EXECUTION_REQUIRED",
    "portrait task cannot be joined to one live target-fleet Worker incarnation",
  );
  const dispatchHeartbeatProof = {
    id: heartbeat.id,
    role: heartbeat.role,
    hostname: heartbeat.hostname,
    processId: Number(heartbeat.processId),
    nodeId: heartbeat.nodeId,
    incarnationId: heartbeat.incarnationId,
    releaseId: heartbeat.releaseId,
    artifactSha256: heartbeat.artifactSha256,
    schemaVersion: Number(heartbeat.schemaVersion),
    acceptingWork: Number(heartbeat.acceptingWork),
    startedAt: workerExecution.heartbeatStartedAt,
    heartbeatAt: workerExecution.heartbeatAt,
    createdAt: heartbeatCreatedAt,
    updatedAt: workerExecution.heartbeatUpdatedAt,
  };
  if (
    releaseFullMaintenancePrivateValidationSha256(dispatchHeartbeatProof)
      !== workerExecution.heartbeatProofSha256
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_WORKER_EXECUTION_REQUIRED",
    "portrait Worker heartbeat snapshot digest does not match the dispatch transaction",
  );
  return Object.freeze({
    workerExecution,
    workerExecutionSha256: workerExecution.attestationSha256,
    workerHeartbeatSha256: releaseFullMaintenancePrivateValidationSha256({
      dispatchHeartbeatProof,
      currentHeartbeat: primitiveProjection(heartbeat),
      fleetWorker: workerFleet,
      targetEvidenceSha256:
        input.binding.homogeneousFleetEvidence.targetEvidenceSha256ByKey[workerExecution.nodeId],
    }),
  });
}

export function assertReleaseFullMaintenancePrivatePortraitGenerationEvidence(input: {
  admission: Record<string, unknown> | undefined;
  task: Record<string, unknown> | undefined;
  workbenchStatus: Record<string, unknown> | undefined;
  delivery: Record<string, unknown> | undefined;
  video: Record<string, unknown> | undefined;
  resourceGraph: Record<string, unknown> | undefined;
  durableCommand: Record<string, unknown> | undefined;
  heartbeat: Record<string, unknown> | undefined;
  workerExecutionSnapshot: RelayWorkerExecutionAttestation | undefined;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  expected: Readonly<{
    workspaceId: string;
    projectId: number;
    assetVersionId: number;
    scriptId: number;
    trackId: number;
    videoId: number;
    taskId: string;
    requestId: string;
    idempotencyKey: string;
    requestHash: string;
    actorUserId: number;
    apiNodeId: string;
    apiNodeProofSha256: string;
    providerAssetUriSha256: string;
    providerSourceSha256: string;
    providerChannelIdSha256: string;
    model: string;
    modelRouteId: string;
    aspectRatio: "16:9";
    durationSeconds: 4;
    outputResolution: "720p";
    bindingRequestedAt: number;
    observedAt: number;
    workerHeartbeatObservedAt: number;
  }>;
}): ReleaseFullMaintenancePrivatePortraitGenerationEvidence {
  const admission = input.admission;
  const task = input.task;
  const workbenchStatus = input.workbenchStatus;
  const delivery = input.delivery;
  const video = input.video;
  const durableCommand = input.durableCommand;
  const resourceGraph = input.resourceGraph;
  if (
    !admission
    || !task
    || !workbenchStatus
    || !delivery
    || !video
    || !durableCommand
    || !resourceGraph
    || !input.workerExecutionSnapshot
  ) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
      "an Active portrait admission without a fresh provider video task and delivery cannot PASS",
    );
  }
  const providerAssetUri = String(admission.providerAssetUri || "");
  const providerSourceSha256 = String(admission.providerSourceSha256 || "");
  const providerChannelId = String(admission.providerChannelId || "");
  if (
    admission.workspaceId !== input.expected.workspaceId
    || Number(admission.projectId) !== input.expected.projectId
    || Number(admission.assetVersionId) !== input.expected.assetVersionId
    || admission.subjectKind !== "aigc"
    || admission.complianceState !== "allowed"
    || admission.providerSyncState !== "active"
    || admission.providerAssetState !== "active"
    || admission.providerGroupType !== "AIGC"
    || admission.providerGroupState !== "active"
    || !providerAssetUri.startsWith("asset://")
    || rawSha256(providerAssetUri) !== input.expected.providerAssetUriSha256
    || providerSourceSha256 !== input.expected.providerSourceSha256
    || rawSha256(providerChannelId) !== input.expected.providerChannelIdSha256
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_FAILED", "portrait provider asset binding differs from its preauthorized commitment");
  const fresh = assertReleaseFullMaintenancePrivateFreshTaskEvidence({
    task,
    expected: {
      workspaceId: input.expected.workspaceId,
      projectId: input.expected.projectId,
      requestId: input.expected.requestId,
      bindingRequestedAt: input.expected.bindingRequestedAt,
      observedAt: input.expected.observedAt,
    },
  });
  const providerPayload = jsonRecord(task.providerPayload);
  const resultPayload = jsonRecord(task.resultPayload);
  const canonicalBinding = jsonRecord(jsonRecord(resultPayload.internal).canonicalVideoGeneration);
  const canonicalRequest = jsonRecord(canonicalBinding.request);
  const inputs = Array.isArray(canonicalRequest.inputs) ? canonicalRequest.inputs : [];
  const firstInput = inputs.length === 1 && isRecord(inputs[0]) ? inputs[0] : null;
  const content = jsonRecord(delivery.content);
  const videoUrl = String(content.video_url || "").trim();
  const providerTaskId = String(task.providerTaskId || "").trim();
  const taskId = String(task.id || "").trim();
  const taskRequestId = String(task.requestId || "").trim();
  const batchItems = Array.isArray(workbenchStatus.items) ? workbenchStatus.items : [];
  const batchItem = batchItems.length === 1 && isRecord(batchItems[0]) ? batchItems[0] : null;
  const batchCounts = jsonRecord(workbenchStatus.counts);
  assertExactPortraitProviderWireReference({
    providerPayload,
    providerAssetUri,
  });
  if (
    taskId !== input.expected.taskId
    || taskRequestId !== input.expected.requestId
    || task.model !== input.expected.model
    || canonicalRequest.version !== "provider-neutral-video-request/v1"
    || canonicalRequest.operation !== "generate"
    || canonicalRequest.modelRouteId !== input.expected.modelRouteId
    || canonicalRequest.aspectRatio !== input.expected.aspectRatio
    || canonicalRequest.durationSeconds !== input.expected.durationSeconds
    || canonicalRequest.outputResolution !== input.expected.outputResolution
    || canonicalRequest.generateAudio !== false
    || canonicalRequest.preserveSourceAudio !== false
    || firstInput?.assetVersionId !== String(input.expected.assetVersionId)
    || firstInput?.mediaType !== "image"
    || firstInput?.role !== "subject"
    || Number(firstInput?.order) !== 0
    || !providerTaskId
    || workbenchStatus.version !== "quick-create-video-batch.v1"
    || Number(workbenchStatus.projectId) !== input.expected.projectId
    || Number(workbenchStatus.total) !== 1
    || workbenchStatus.terminal !== true
    || workbenchStatus.partialFailure !== false
    || Number(batchCounts.succeeded) !== 1
    || !batchItem
    || Number(batchItem.videoId) !== input.expected.videoId
    || Number(batchItem.trackId) !== input.expected.trackId
    || batchItem.relayTaskId !== input.expected.taskId
    || batchItem.state !== "succeeded"
    || batchItem.errorCode != null
    || batchItem.errorReason != null
    || delivery.id !== input.expected.taskId
    || delivery.status !== "succeeded"
    || delivery.billing_state !== "settled"
    || delivery.met_requested_quality !== true
    || delivery.error != null
    || !videoUrl
    || !Array.isArray(delivery.output)
    || delivery.output.length < 1
    || collectExactString(delivery.output, videoUrl) !== 1
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
    "portrait task does not reference the exact assetVersion/provider URI or lacks controlled delivered video",
  );
  if (
    Number(video.id) !== input.expected.videoId
    || Number(video.projectId) !== input.expected.projectId
    || Number(video.scriptId) !== input.expected.scriptId
    || Number(video.videoTrackId) !== input.expected.trackId
    || video.relayTaskId !== input.expected.taskId
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
    "delivered Workbench video is not exactly bound to the submitted track and Relay task",
  );
  const expectedScope = `workbench:create:videos:${input.expected.workspaceId}:${input.expected.actorUserId}`;
  const commandCreatedAt = Number(durableCommand.createdAt);
  const commandUpdatedAt = Number(durableCommand.updatedAt);
  const commandExpiresAt = Number(durableCommand.expiresAt);
  let commandResponse: unknown;
  try { commandResponse = JSON.parse(String(durableCommand.responseBody || "")); } catch {
    commandResponse = null;
  }
  const responseItem = Array.isArray(commandResponse) && commandResponse.length === 1 && isRecord(commandResponse[0])
    ? commandResponse[0]
    : null;
  if (
    durableCommand.workspaceId !== input.expected.workspaceId
    || Number(durableCommand.actorUserId) !== input.expected.actorUserId
    || durableCommand.scopeKey !== expectedScope
    || durableCommand.idempotencyKey !== input.expected.idempotencyKey
    || durableCommand.requestHash !== input.expected.requestHash
    || durableCommand.status !== "completed"
    || Number(durableCommand.responseStatus) !== 200
    || durableCommand.resourceType !== "project"
    || durableCommand.resourceId !== String(input.expected.projectId)
    || !Number.isSafeInteger(commandCreatedAt)
    || commandCreatedAt < input.expected.bindingRequestedAt
    || commandCreatedAt > input.expected.observedAt
    || !Number.isSafeInteger(commandUpdatedAt)
    || commandUpdatedAt < commandCreatedAt
    || commandUpdatedAt > input.expected.observedAt
    || !Number.isSafeInteger(commandExpiresAt)
    || commandExpiresAt <= input.expected.observedAt
    || !responseItem
    || Number(responseItem.videoId) !== input.expected.videoId
    || Number(responseItem.trackId) !== input.expected.trackId
    || responseItem.relayTaskId !== input.expected.taskId
    || responseItem.errorCode != null
    || responseItem.errorReason != null
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
    "durable Workbench command does not exactly bind this user request to the delivered video and Relay task",
  );
  const project = jsonRecord(resourceGraph.project);
  const script = jsonRecord(resourceGraph.script);
  const track = jsonRecord(resourceGraph.track);
  if (
    Number(project.id) !== input.expected.projectId
    || project.workspaceId !== input.expected.workspaceId
    || project.videoRatio !== input.expected.aspectRatio
    || Number(script.id) !== input.expected.scriptId
    || Number(script.projectId) !== input.expected.projectId
    || Number(track.id) !== input.expected.trackId
    || Number(track.projectId) !== input.expected.projectId
    || Number(track.scriptId) !== input.expected.scriptId
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
    "the preauthorized Workbench project/script/track graph or project aspect ratio differs",
  );
  if (
    !Number.isSafeInteger(input.expected.workerHeartbeatObservedAt)
    || input.expected.workerHeartbeatObservedAt < input.expected.bindingRequestedAt
    || input.expected.workerHeartbeatObservedAt > input.expected.observedAt
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_WORKER_EXECUTION_REQUIRED",
    "sealed Worker heartbeat observation is outside the validation window",
  );
  const worker = assertReleaseFullMaintenancePrivatePortraitWorkerExecutionEvidence({
    task,
    heartbeat: input.heartbeat,
    expectedWorkerExecution: input.workerExecutionSnapshot,
    binding: input.binding,
    expectedTaskId: input.expected.taskId,
    expectedRequestId: input.expected.requestId,
    observedAt: input.expected.workerHeartbeatObservedAt,
  });
  return Object.freeze({
    taskId,
    requestId: taskRequestId,
    videoId: input.expected.videoId,
    scriptId: input.expected.scriptId,
    trackId: input.expected.trackId,
    apiNodeId: input.expected.apiNodeId,
    apiNodeProofSha256: input.expected.apiNodeProofSha256,
    idempotencyKeySha256: rawSha256(input.expected.idempotencyKey),
    workbenchCommandSha256: releaseFullMaintenancePrivateValidationSha256({
      actorUserId: input.expected.actorUserId,
      scopeKey: expectedScope,
      idempotencyKeySha256: rawSha256(input.expected.idempotencyKey),
      requestHash: input.expected.requestHash,
      durableCommand: primitiveProjection(durableCommand),
      responseItem: primitiveProjection(responseItem),
      workbenchStatusSha256: releaseFullMaintenancePrivateValidationSha256(workbenchStatus),
    }),
    resourceGraphSha256: releaseFullMaintenancePrivateValidationSha256({
      project: primitiveProjection(project),
      script: primitiveProjection(script),
      track: primitiveProjection(track),
      video: primitiveProjection(video),
    }),
    canonicalRequestSha256: releaseFullMaintenancePrivateValidationSha256(canonicalRequest),
    providerAssetBindingSha256: releaseFullMaintenancePrivateValidationSha256({
      assetVersionId: input.expected.assetVersionId,
      providerAssetUriSha256: input.expected.providerAssetUriSha256,
      providerSourceSha256: input.expected.providerSourceSha256,
      providerChannelIdSha256: input.expected.providerChannelIdSha256,
    }),
    taskSha256: releaseFullMaintenancePrivateValidationSha256(fresh),
    providerSha256: releaseFullMaintenancePrivateValidationSha256({
      providerTaskId,
      providerPayloadSha256: releaseFullMaintenancePrivateValidationSha256(providerPayload),
    }),
    workerExecutionSha256: worker.workerExecutionSha256,
    workerHeartbeatSha256: worker.workerHeartbeatSha256,
    workerDispatchEvidence: Object.freeze({
      scope: "provider-post-dispatch-only" as const,
      workerExecution: worker.workerExecution,
      currentHeartbeat: Object.freeze(primitiveProjection(input.heartbeat)),
      observedAt: input.expected.workerHeartbeatObservedAt,
    }),
    deliverySha256: releaseFullMaintenancePrivateValidationSha256({
      ...primitiveProjection(delivery),
      urlSha256: rawSha256(videoUrl),
      outputSha256: releaseFullMaintenancePrivateValidationSha256(delivery.output),
      deliverySha256: releaseFullMaintenancePrivateValidationSha256(delivery.delivery),
    }),
  });
}

async function runPrivatePortraitGeneration(input: {
  database: Knex;
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  budgetHandle: ReleaseFullMaintenancePrivateValidationBudgetHandle;
  tunnel: ReleaseFullMaintenancePrivateNodeTunnel;
  signal: AbortSignal;
}): Promise<ReleaseFullMaintenancePrivatePortraitGenerationEvidence> {
  assertNotAborted(input.signal);
  if (
    input.tunnel.nodeId !== input.binding.apiNodeIds[0]
    || input.tunnel.proof.nodeId !== input.tunnel.nodeId
    || input.tunnel.proof.deploymentId !== input.binding.deploymentId
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_NODE_PROOF_INVALID",
    "portrait Workbench request is not bound to the selected proven API node",
  );
  const workbenchRequest = createPrivatePortraitWorkbenchRequest(input);
  const idempotencyKey = `full-maintenance-portrait:${input.binding.bindingSha256}`;
  const [budget, budgetTransport] = await Promise.all([
    import("@/lib/releaseFullMaintenancePrivateValidationBudget"),
    import("@/lib/releaseFullMaintenancePrivateValidationBudgetTransport"),
  ]);
  const portraitClaim = budgetTransport.createReleaseFullMaintenancePrivateValidationPortraitBudgetClaim({
    releaseBindingSha256: input.binding.bindingSha256,
    workspaceId: input.config.portrait.workspaceId,
    projectId: input.config.portrait.projectId,
    actorUserId: input.config.principals.user.userId,
    idempotencyKey,
    body: workbenchRequest,
  });
  const portraitBudgetBinding = await budget.claimReleaseFullMaintenancePrivateValidationBudgetSlot({
    database: input.database,
    handle: input.budgetHandle,
    slot: "portrait",
    actorUserId: input.config.principals.user.userId,
    claimKey: portraitClaim.claimKey,
    claimRequestSha256: portraitClaim.claimRequestSha256,
    now: Date.now(),
  });
  const created = await requestReleaseFullMaintenancePrivateWorkbenchJson({
    loopbackOrigin: input.tunnel.loopbackOrigin,
    pathname: "/api/workbench/create/videos",
    token: input.config.sessions.user.token,
    body: workbenchRequest,
    idempotencyKey,
    privateValidationBudgetHeader:
      budgetTransport.serializeReleaseFullMaintenancePrivateValidationBudgetSlotBinding(
        portraitBudgetBinding,
      ),
    signal: input.signal,
  });
  const createdItems = created.data as unknown[];
  const createdItem = createdItems.length === 1 && isRecord(createdItems[0]) ? createdItems[0] : null;
  const videoId = Number(createdItem?.videoId);
  const taskId = String(createdItem?.relayTaskId || "").trim();
  if (
    !createdItem
    || !Number.isSafeInteger(videoId)
    || videoId < 1
    || Number(createdItem.trackId) !== input.config.portrait.trackId
    || !taskId
    || createdItem.errorCode != null
    || createdItem.errorReason != null
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
    "formal Workbench submission did not create one exactly bound video and Relay task",
  );
  const rawRequestId = [
    "quick-create",
    input.config.portrait.projectId,
    input.config.portrait.scriptId,
    input.config.portrait.trackId,
    videoId,
  ].join(":");
  const requestId = `${rawRequestId}:scope:${rawSha256(
    `video_generation:principal:workspace-service:${input.config.portrait.workspaceId}`,
  )}`;
  const deadlineAt = Date.now() + input.config.portrait.pollTimeoutMs;
  let workbenchStatus: Record<string, unknown> | undefined;
  let workerExecutionSnapshot: RelayWorkerExecutionAttestation | undefined;
  let workerHeartbeatSnapshot: Record<string, unknown> | undefined;
  let workerHeartbeatObservedAt = 0;
  const sealWorkerDispatchEvidence = async (): Promise<void> => {
    if (workerExecutionSnapshot) return;
    const row = await input.database("o_relay_task").where({ id: taskId }).first() as Record<string, unknown> | undefined;
    const rawExecution = jsonRecord(jsonRecord(jsonRecord(row?.providerPayload).submission).workerExecution);
    if (!Object.keys(rawExecution).length || !row) return;
    let execution: RelayWorkerExecutionAttestation;
    try {
      execution = assertRelayWorkerExecutionAttestation(rawExecution);
    } catch {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_WORKER_EXECUTION_REQUIRED",
        "portrait provider dispatch exposed an invalid Worker execution attestation",
      );
    }
    const heartbeat = await input.database("o_worker_heartbeat")
      .where({ id: execution.incarnationId })
      .first() as Record<string, unknown> | undefined;
    const capturedAt = Date.now();
    assertReleaseFullMaintenancePrivatePortraitWorkerExecutionEvidence({
      task: row,
      heartbeat,
      expectedWorkerExecution: execution,
      binding: input.binding,
      expectedTaskId: taskId,
      expectedRequestId: requestId,
      observedAt: capturedAt,
    });
    workerExecutionSnapshot = Object.freeze({ ...execution });
    workerHeartbeatSnapshot = heartbeat ? Object.freeze({ ...heartbeat }) : undefined;
    workerHeartbeatObservedAt = capturedAt;
  };
  while (Date.now() <= deadlineAt) {
    assertNotAborted(input.signal);
    const statusResponse = await requestReleaseFullMaintenancePrivateWorkbenchJson({
      loopbackOrigin: input.tunnel.loopbackOrigin,
      pathname: "/api/workbench/create/videos/batch/status",
      token: input.config.sessions.user.token,
      body: { projectId: input.config.portrait.projectId, idempotencyKey },
      signal: input.signal,
    });
    const batch = isRecord(statusResponse.data) ? statusResponse.data : undefined;
    const items = Array.isArray(batch?.items) ? batch.items : [];
    const exactItem = items.find((item) => (
      isRecord(item)
      && Number(item.videoId) === videoId
      && Number(item.trackId) === input.config.portrait.trackId
      && item.relayTaskId === taskId
    ));
    const state = isRecord(exactItem) ? String(exactItem.state || "") : "";
    await sealWorkerDispatchEvidence();
    if (["failed", "cancelled", "pending_reconcile"].includes(state)) {
      fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
        "formal Workbench portrait batch reached a non-success terminal state",
      );
    }
    if (state === "succeeded" && batch?.terminal === true) {
      workbenchStatus = batch;
      break;
    }
    await sleepWithAbort(input.config.portrait.pollIntervalMs, input.signal);
  }
  if (!workbenchStatus) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
      "formal Workbench portrait batch did not reach succeeded before its deadline",
    );
  }
  if (!workerExecutionSnapshot || !workerHeartbeatSnapshot || workerHeartbeatObservedAt < 1) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_WORKER_EXECUTION_REQUIRED",
      "provider dispatch completed without a Worker execution and heartbeat snapshot sealed during polling",
    );
  }
  // Every direct database read below is post-hoc. The mutation and all status
  // polling above used the ordinary user-authorized Workbench HTTP surface.
  const [admission, taskRow, video, durableCommand, project, script, track] = await Promise.all([
    input.database("o_portrait_admission as admission")
      .innerJoin("o_portrait_provider_asset as providerAsset", "providerAsset.id", "admission.currentProviderAssetBindingId")
      .innerJoin("o_portrait_provider_group as providerGroup", "providerGroup.id", "providerAsset.groupBindingId")
      .where({
        "admission.workspaceId": input.config.portrait.workspaceId,
        "admission.projectId": input.config.portrait.projectId,
        "admission.assetVersionId": input.config.portrait.assetVersionId,
      })
      .select({
        workspaceId: "admission.workspaceId",
        projectId: "admission.projectId",
        assetVersionId: "admission.assetVersionId",
        subjectKind: "admission.subjectKind",
        complianceState: "admission.complianceState",
        providerSyncState: "admission.providerSyncState",
        providerAssetState: "providerAsset.state",
        providerAssetUri: "providerAsset.providerAssetUri",
        providerSourceSha256: "providerAsset.sourceSha256",
        providerChannelId: "providerAsset.channelId",
        providerGroupType: "providerGroup.groupType",
        providerGroupState: "providerGroup.state",
      })
      .first(),
    input.database("o_relay_task").where({ id: taskId }).first(),
    input.database("o_video").where({ id: videoId }).first(),
    input.database("o_agent_idempotency").where({
      workspaceId: input.config.portrait.workspaceId,
      actorUserId: input.config.principals.user.userId,
      scopeKey: `workbench:create:videos:${input.config.portrait.workspaceId}:${input.config.principals.user.userId}`,
      idempotencyKey,
    }).first(),
    input.database("o_project").where({ id: input.config.portrait.projectId }).first(),
    input.database("o_script").where({ id: input.config.portrait.scriptId }).first(),
    input.database("o_videoTrack").where({ id: input.config.portrait.trackId }).first(),
  ]) as Array<Record<string, unknown> | undefined>;
  const relay = await import("@/lib/relay");
  const task = await relay.getRelayTask(taskId);
  if (!task) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED", "Workbench Relay task disappeared before delivery projection");
  }
  const delivery = await relay.formatPublicRelayTask(task);
  const observedAt = Date.now();
  const resolvedModel = String(taskRow?.model || "").trim();
  if (!resolvedModel) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_PORTRAIT_GENERATION_REQUIRED",
      "Workbench Relay task lacks the capability id resolved by the formal route",
    );
  }
  return assertReleaseFullMaintenancePrivatePortraitGenerationEvidence({
    admission: admission as Record<string, unknown> | undefined,
    task: taskRow,
    workbenchStatus,
    delivery,
    video,
    resourceGraph: { project, script, track },
    durableCommand,
    heartbeat: workerHeartbeatSnapshot,
    workerExecutionSnapshot,
    binding: input.binding,
    expected: {
      workspaceId: input.config.portrait.workspaceId,
      projectId: input.config.portrait.projectId,
      assetVersionId: input.config.portrait.assetVersionId,
      scriptId: input.config.portrait.scriptId,
      trackId: input.config.portrait.trackId,
      videoId,
      taskId,
      requestId,
      idempotencyKey,
      requestHash: hashIdempotencyRequest({ ...workbenchRequest, model: resolvedModel }),
      actorUserId: input.config.principals.user.userId,
      apiNodeId: input.tunnel.nodeId,
      apiNodeProofSha256: releaseFullMaintenancePrivateValidationSha256(input.tunnel.proof),
      providerAssetUriSha256: input.config.portrait.expectedProviderAssetUriSha256,
      providerSourceSha256: input.config.portrait.expectedProviderSourceSha256,
      providerChannelIdSha256: input.config.portrait.expectedProviderChannelIdSha256,
      model: resolvedModel,
      modelRouteId: input.config.portrait.modelRouteId,
      aspectRatio: input.config.portrait.aspectRatio,
      durationSeconds: input.config.portrait.durationSeconds,
      outputResolution: input.config.portrait.outputResolution,
      bindingRequestedAt: input.binding.requestedAt,
      observedAt,
      workerHeartbeatObservedAt,
    },
  });
}

function assertStandalonePrivateValidationProcess(): void {
  const entrypoint = path.basename(String(process.argv[1] || ""));
  if (
    entrypoint !== "run-release-full-maintenance-private-validation.js"
    && entrypoint !== "run-release-full-maintenance-private-validation.ts"
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STANDALONE_REQUIRED",
    "production validation must run in its dedicated application-principal process",
  );
  if (String(process.env.NODE_OPTIONS || "").trim()) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STANDALONE_REQUIRED", "NODE_OPTIONS is forbidden");
  }
  const forbidden = new Set([
    "-r", "--require", "--import", "--loader", "--experimental-loader",
    "-e", "--eval", "-p", "--print",
  ]);
  if (process.execArgv.some((argument) => (
    forbidden.has(argument)
    || [...forbidden].some((flag) => flag.startsWith("--") && argument.startsWith(`${flag}=`))
  ))) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_STANDALONE_REQUIRED", "Node pre-execution hooks are forbidden");
}

async function runPrivateSeedanceValidation(input: {
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  signal: AbortSignal;
  database: Knex;
  budgetHandle: ReleaseFullMaintenancePrivateValidationBudgetHandle;
}): Promise<{
  receipt: Seedance25CertificationOperatorReceipt;
  freshEvidence: Readonly<Record<string, unknown>>;
}> {
  assertNotAborted(input.signal);
  // Both modules transitively use the application-global database. Import only
  // after the standalone process has loaded the fixed app environment.
  const [{ runSeedance25CertificationOperator }, relay, budget] = await Promise.all([
    import("@/lib/seedance25ProductionConfig"),
    import("@/lib/relay"),
    import("@/lib/releaseFullMaintenancePrivateValidationBudget"),
  ]);
  const seedanceClaimRequestSha256 = budget.releaseFullMaintenancePrivateValidationBudgetSha256({
    format: "fanjin-release-full-maintenance-private-validation-seedance-claim/v1",
    releaseBindingSha256: input.binding.bindingSha256,
    probeId: input.config.seedance.probeId,
    workspaceId: input.config.seedance.workspaceId,
    projectId: input.config.seedance.projectId,
    adminUserId: input.config.seedance.adminUserId,
    releaseId: input.binding.target.releaseId,
    sourceCommit: input.binding.target.sourceCommit,
    artifactSha256: input.binding.target.artifactSha256,
    priceSourceContentSha256: input.config.seedance.priceSourceContentSha256,
    upstreamUnitPriceMicros: input.config.seedance.upstreamUnitPriceMicros,
  });
  const seedanceBudgetBinding = await budget.claimReleaseFullMaintenancePrivateValidationBudgetSlot({
    database: input.database,
    handle: input.budgetHandle,
    slot: "seedance",
    actorUserId: input.config.seedance.adminUserId,
    claimKey: `seedance:${input.config.seedance.probeId}`,
    claimRequestSha256: seedanceClaimRequestSha256,
    now: Date.now(),
  });
  const receipt = await runSeedance25CertificationOperator({
    database: input.database,
    arm: {
      probeId: input.config.seedance.probeId,
      workspaceId: input.config.seedance.workspaceId,
      projectId: input.config.seedance.projectId,
      adminUserId: input.config.seedance.adminUserId,
      createdAt: input.config.seedance.createdAt,
      expiresAt: input.config.seedance.expiresAt,
    },
    certification: {
      probeId: input.config.seedance.probeId,
      adminUserId: input.config.seedance.adminUserId,
      priceSourceUrl: input.config.seedance.priceSourceUrl,
      priceSourceContentSha256: input.config.seedance.priceSourceContentSha256,
      priceCheckedAt: input.config.seedance.priceCheckedAt,
      upstreamCurrency: input.config.seedance.upstreamCurrency,
      upstreamUnitPriceMicros: input.config.seedance.upstreamUnitPriceMicros,
      billingCurrency: input.config.seedance.billingCurrency,
      billingDimension: input.config.seedance.billingDimension,
      releaseId: input.binding.target.releaseId,
      sourceCommit: input.binding.target.sourceCommit,
      artifactSha256: input.binding.target.artifactSha256,
      validUntil: input.config.seedance.validUntil,
    },
    pollIntervalMs: input.config.seedance.pollIntervalMs,
    timeoutMs: input.config.seedance.timeoutMs,
    runtime: {
      create: (probeId) => relay.createSeedance25CertificationProbeRelayTaskWithBudget(
        probeId,
        seedanceBudgetBinding,
      ),
      get: (taskId) => relay.getRelayTask(taskId),
      refresh: (task, options) => relay.refreshRelayTask(task as never, options) as never,
      cancel: (taskId) => relay.cancelOrDeleteRelayTask(taskId, { internal: true }) as never,
      now: Date.now,
      sleep: (milliseconds) => sleepWithAbort(milliseconds, input.signal),
    },
  });
  assertNotAborted(input.signal);
  const certification = receipt.certification;
  if (
    receipt.state !== "certified"
    || receipt.task.status !== "succeeded"
    || !receipt.task.providerTaskId
    || !certification
    || certification.taskId !== receipt.task.id
    || certification.artifactSha256 !== input.binding.target.artifactSha256
    || certification.routeCertificationValid !== true
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SEEDANCE_FAILED", "Seedance certification did not produce an exact certified provider task");
  const taskRow = await input.database("o_relay_task")
    .where({ id: receipt.task.id })
    .first();
  if (!taskRow) {
    fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_SEEDANCE_FAILED", "Seedance task disappeared before freshness readback");
  }
  const { seedance25CertificationProbeScopedRequestId } = await import("@/lib/seedance25Adapter");
  const freshEvidence = assertReleaseFullMaintenancePrivateFreshTaskEvidence({
    task: taskRow as Record<string, unknown>,
    expected: {
      workspaceId: input.config.seedance.workspaceId,
      projectId: input.config.seedance.projectId,
      requestId: seedance25CertificationProbeScopedRequestId({
        probeId: input.config.seedance.probeId,
        adminUserId: String(input.config.seedance.adminUserId),
      }),
      bindingRequestedAt: input.binding.requestedAt,
      observedAt: Date.now(),
    },
  });
  return { receipt, freshEvidence };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function assertReleaseFullMaintenancePrivateFreshTaskEvidence(input: {
  task: Record<string, unknown>;
  expected: Readonly<{
    workspaceId: string;
    projectId: number;
    requestId: string;
    bindingRequestedAt: number;
    observedAt: number;
  }>;
}): Readonly<Record<string, unknown>> {
  const providerPayload = jsonRecord(input.task.providerPayload);
  const submission = jsonRecord(providerPayload.submission);
  const createdAt = Number(input.task.createTime);
  const taskSubmittedAt = Number(input.task.submittedAt || 0);
  const dispatchStartedAt = Number(submission.dispatchStartedAt || 0);
  const dispatchedAt = taskSubmittedAt > 0 ? taskSubmittedAt : dispatchStartedAt;
  if (
    input.task.status !== "succeeded"
    || !String(input.task.providerTaskId || "").trim()
    || input.task.workspaceId !== input.expected.workspaceId
    || Number(input.task.projectId) !== input.expected.projectId
    || input.task.requestId !== input.expected.requestId
    || input.task.endpointType !== "video_generation"
    || input.task.provider !== "volcano"
    || !Number.isSafeInteger(createdAt)
    || createdAt < input.expected.bindingRequestedAt
    || createdAt > input.expected.observedAt
    || !Number.isSafeInteger(dispatchedAt)
    || dispatchedAt < input.expected.bindingRequestedAt
    || dispatchedAt < createdAt
    || dispatchedAt > input.expected.observedAt
    || (taskSubmittedAt > 0 && dispatchStartedAt > 0 && taskSubmittedAt !== dispatchStartedAt)
  ) fail(
    "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_TASK_NOT_FRESH",
    "provider task is old, unbound, not dispatched after binding, or lacks one exact provider identity",
  );
  return Object.freeze({
    taskId: input.task.id,
    requestId: input.task.requestId,
    providerTaskId: input.task.providerTaskId,
    createdAt,
    dispatchedAt,
    submissionState: submission.state,
    providerPayloadSha256: releaseFullMaintenancePrivateValidationSha256(providerPayload),
  });
}

function primitiveProjection(row: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!row) return {};
  return Object.fromEntries(Object.entries(row)
    .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
    .sort(([left], [right]) => left.localeCompare(right)));
}

async function billingEvidence(input: {
  database: Knex;
  workspaceId: string;
  projectId: number;
  taskId: string;
  expectedUsageRecordId?: string;
}): Promise<{
  audit: VideoGenerationRelayBillingAudit;
  actualGuMicros: number;
  usageSha256: string;
  ledgerSha256: string;
  exactOnceSha256: string;
}> {
  // Keep this import after the standalone CLI has loaded the fixed app env.
  // The billing module transitively imports @/utils/db at module evaluation.
  const {
    readVideoGenerationRelayBillingAudit,
    videoGenerationRelayBillingAuditDigest,
  } = await import("@/lib/videoGenerationRelayBillingAudit");
  const audit = await readVideoGenerationRelayBillingAudit({
    database: input.database,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
  });
  if (
    audit.status !== "settled"
    || !audit.providerAccepted
    || !audit.providerRequestId
    || audit.taskId !== input.taskId
    || (input.expectedUsageRecordId !== undefined
      && audit.usageRecordId !== input.expectedUsageRecordId)
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BILLING_FAILED", "Seedance billing audit is not exact and settled");
  const [usageRows, freezes, terminalRows, reconcileRows] = await Promise.all([
    input.database("o_usage_record").where({
      id: audit.usageRecordId,
      workspaceId: audit.workspaceId,
      taskId: audit.taskId,
      endpointType: "video_generation",
    }),
    input.database("o_billing_ledger").where({
      id: audit.reservationId,
      workspaceId: audit.workspaceId,
      relatedTaskId: audit.taskId,
      type: "freeze",
    }),
    input.database("o_billing_ledger")
      .where({ workspaceId: audit.workspaceId, relatedLedgerId: audit.reservationId })
      .whereIn("type", ["deduct", "release"])
      .orderBy("createdAt", "asc"),
    input.database("o_billing_reconcile_job")
      .where({ workspaceId: audit.workspaceId, reservationId: audit.reservationId }),
  ]);
  if (
    usageRows.length !== 1
    || freezes.length !== 1
    || terminalRows.length !== audit.terminalEvidenceIds.length
    || terminalRows.some((row: Record<string, unknown>) => !audit.terminalEvidenceIds.includes(String(row.id || "")))
  ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BILLING_FAILED", "PG usage/ledger exact-once readback differs from the billing audit");
  const reconcile = assertReleaseFullMaintenancePrivateBillingReconcileRows({
    rows: reconcileRows as Record<string, unknown>[],
    workspaceId: audit.workspaceId,
    reservationId: audit.reservationId,
    usageRecordId: audit.usageRecordId,
  });
  const usage = primitiveProjection(usageRows[0]);
  const ledger = [freezes[0], ...terminalRows].map((row) => primitiveProjection(row));
  return {
    audit,
    actualGuMicros: audit.actualGuMicros,
    usageSha256: releaseFullMaintenancePrivateValidationSha256({ audit: videoGenerationRelayBillingAuditDigest(audit), usage }),
    ledgerSha256: releaseFullMaintenancePrivateValidationSha256({ audit: videoGenerationRelayBillingAuditDigest(audit), ledger }),
    exactOnceSha256: releaseFullMaintenancePrivateValidationSha256({
      audit,
      usageCount: usageRows.length,
      freezeCount: freezes.length,
      terminalCount: terminalRows.length,
      reconcile,
    }),
  };
}

export function assertReleaseFullMaintenancePrivateBillingReconcileRows(input: {
  rows: readonly Record<string, unknown>[];
  workspaceId: string;
  reservationId: string;
  usageRecordId: string;
}): Readonly<{ count: number; rowsSha256: string }> {
  if (!Array.isArray(input.rows) || input.rows.length !== 1) {
    fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BILLING_RECONCILE_INVALID",
      "the provider dispatch watchdog must have exactly one durable resolved row",
    );
  }
  const ids = new Set<string>();
  const projections = input.rows.map((row) => {
    const id = String(row.id || "");
    const createTime = Number(row.createTime);
    const updateTime = Number(row.updateTime);
    const resolvedAt = Number(row.resolvedAt);
    if (
      !id
      || ids.has(id)
      || row.workspaceId !== input.workspaceId
      || row.reservationId !== input.reservationId
      || row.usageRecordId !== input.usageRecordId
      || row.endpointType !== "video_generation"
      || row.reason !== "dispatch_watchdog"
      || row.status !== "resolved"
      || row.decision !== "reservation_settled"
      || row.leaseOwner != null
      || row.leaseExpiresAt != null
      || row.lastError != null
      || !Number.isSafeInteger(createTime)
      || !Number.isSafeInteger(updateTime)
      || !Number.isSafeInteger(resolvedAt)
      || resolvedAt < createTime
      || updateTime < resolvedAt
    ) fail(
      "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BILLING_RECONCILE_INVALID",
      "billing reconcile contains an unresolved, foreign, leased, or non-settled row",
    );
    ids.add(id);
    return primitiveProjection(row);
  });
  return Object.freeze({
    count: projections.length,
    rowsSha256: releaseFullMaintenancePrivateValidationSha256(projections),
  });
}

export async function createReleaseFullMaintenancePrivateValidationProductionAdapter(input: {
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  binding: ReleaseFullMaintenancePrivateValidationBinding;
  now?: () => number;
}): Promise<ReleaseFullMaintenancePrivateValidationProductionAdapter> {
  const now = input.now ?? Date.now;
  const config = assertReleaseFullMaintenancePrivateValidationProductionConfig({
    value: input.config,
    binding: input.binding,
    now: now(),
  });
  const states = new Map<string, ProductionExecutionState>();
  let database: Knex | undefined;
  const transport = createReleaseFullMaintenancePrivateTransport({ config: config.transport });
  let openedTunnels: readonly ReleaseFullMaintenancePrivateNodeTunnel[] = [];
  let sessionsRevoked = false;
  const executor: ReleaseFullMaintenancePrivateValidationExecutor = {
    execute: async ({ binding, deadlineAt, signal }) => {
      if (binding.bindingSha256 !== input.binding.bindingSha256 || states.has(binding.bindingSha256)) {
        fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EXECUTION_INVALID", "production adapter binding is reused or changed");
      }
      const startedAt = now();
      const plan = createReleaseFullMaintenancePrivateValidationPlan({ binding, config });
      persistReleaseFullMaintenancePrivateValidationAttempt({
        directory: config.receiptDirectory,
        binding,
        plan,
        startedAt,
        deadlineAt,
      });
      const activationByNode = new Map(
        binding.homogeneousFleetEvidence.api.map((entry) => [entry.nodeId, entry.activationBindingSha256] as const),
      );
      try {
        openedTunnels = await transport.open({
          nodes: config.privateApiNodes.map((node) => ({
            nodeId: node.nodeId,
            privateHost: new URL(node.baseUrl).hostname,
            activationBindingSha256: String(activationByNode.get(node.nodeId) || ""),
          })),
          target: {
            deploymentId: binding.deploymentId,
            releaseId: binding.target.releaseId,
            artifactSha256: binding.target.artifactSha256,
            sourceCommit: binding.target.sourceCommit,
            schemaVersion: 48,
            imageDigest: binding.target.imageDigest,
          },
          signal,
        });
      } catch (error) {
        if (error instanceof ReleaseFullMaintenancePrivateTransportError) fail(error.code, error.message);
        throw error;
      }
      const nodeProofs = Object.freeze(openedTunnels.map(({ proof }) => proof));
      const nodeProofsSha256 = releaseFullMaintenancePrivateValidationSha256(nodeProofs);
      const healthEvidence = await provePrivateApiInventory({ config, binding, tunnels: openedTunnels, signal });
      const principalEvidence = await verifyPrivateValidationPrincipals({ tunnels: openedTunnels, config, signal });
      const portraitReceipts = await runPrivatePortraitValidation({ config, binding, tunnels: openedTunnels, signal });
      database = await openProductionDatabase(config);
      const budget = await import("@/lib/releaseFullMaintenancePrivateValidationBudget");
      const budgetHandle = await budget.createReleaseFullMaintenancePrivateValidationBudget({
        database,
        deploymentId: binding.deploymentId,
        contractSha256: binding.contractSha256,
        releaseBindingSha256: binding.bindingSha256,
        validationPlanIntentSha256: plan.validationPlanIntentSha256,
        validationPlanSha256: plan.validationPlanSha256,
        workspaceId: plan.workspaceId,
        projectId: plan.projectId,
        ownerAdminUserId: plan.principals.admin.userId,
        slotActors: {
          seedance: plan.principals.admin.userId,
          portrait: plan.principals.user.userId,
        },
        currency: "GU",
        maximumProviderTasks: 2,
        maximumGuMicros: plan.maximumGuMicros,
        authorizedExpiresAt: plan.expiresAt,
        now: now(),
      });
      const seedance = await runPrivateSeedanceValidation({
        config,
        binding,
        signal,
        database,
        budgetHandle,
      });
      const portraitGeneration = await runPrivatePortraitGeneration({
        database,
        config,
        binding,
        budgetHandle,
        tunnel: openedTunnels[0],
        signal,
      });
      const budgetFinalEvidence = await budget.readFinalReleaseFullMaintenancePrivateValidationBudget({
        database,
        handle: budgetHandle,
      });
      assertReleaseFullMaintenancePrivateValidationBudgetFinalEvidence({
        value: budgetFinalEvidence,
        binding,
        plan,
      });
      const executorEvidence = {
        format: "fanjin-release-full-maintenance-private-validation-executor-evidence/v1" as const,
        deploymentId: binding.deploymentId,
        bindingSha256: binding.bindingSha256,
        contractSha256: binding.contractSha256,
        validationPlanSha256: plan.validationPlanSha256,
        validationPlan: plan,
        rootMfaConfirmationSha256: plan.rootMfaConfirmationSha256,
        nodeProofsSha256,
        nodeProofs,
        healthEvidence,
        principalEvidence,
        portraitReceipts,
        portraitGeneration,
        seedanceReceipt: seedance.receipt,
        seedanceFreshEvidence: seedance.freshEvidence,
        budgetFinalEvidence,
      };
      const executorEvidenceSha256 = releaseFullMaintenancePrivateValidationSha256(executorEvidence);
      persistProtectedCanonicalEvidence({
        directory: config.receiptDirectory,
        basename: `executor-${executorEvidenceSha256}.json`,
        value: { ...executorEvidence, executorEvidenceSha256 },
      });
      states.set(binding.bindingSha256, {
        binding,
        plan,
        tunnels: openedTunnels,
        nodeProofs,
        principalEvidence,
        healthEvidence,
        portraitReceipts,
        portraitGeneration,
        seedanceReceipt: seedance.receipt,
        seedanceFreshEvidence: seedance.freshEvidence,
        budgetHandle,
        budgetFinalEvidence,
        database,
      });
      return {
        format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_EXECUTION_FORMAT,
        trafficMode: "full-maintenance",
        deploymentId: binding.deploymentId,
        bindingSha256: binding.bindingSha256,
        executionId: `full-maintenance:${randomBytes(16).toString("hex")}`,
        startedAt,
        privateApiInventorySha256: healthEvidence.privateApiInventorySha256,
        validationPlanSha256: plan.validationPlanSha256,
        rootMfaConfirmationSha256: plan.rootMfaConfirmationSha256,
        nodeProofsSha256,
        executorEvidenceSha256,
      };
    },
  };
  const collector: ReleaseFullMaintenancePrivateValidationCollector = {
    collect: async ({ binding, execution, signal }) => {
      assertNotAborted(signal);
      const state = states.get(binding.bindingSha256);
      if (!state || state.binding.bindingSha256 !== binding.bindingSha256) {
        fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CANDIDATE_INVALID", "production execution state is missing");
      }
      const budget = await import("@/lib/releaseFullMaintenancePrivateValidationBudget");
      const budgetFinalEvidence = await budget.readFinalReleaseFullMaintenancePrivateValidationBudget({
        database: state.database,
        handle: state.budgetHandle,
      });
      assertReleaseFullMaintenancePrivateValidationBudgetFinalEvidence({
        value: budgetFinalEvidence,
        binding,
        plan: state.plan,
      });
      if (
        canonicalReleaseFullMaintenancePrivateValidationJson(budgetFinalEvidence)
        !== canonicalReleaseFullMaintenancePrivateValidationJson(state.budgetFinalEvidence)
      ) fail(
        "RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_INVALID",
        "durable validation budget changed between executor and collector readback",
      );
      const seedanceBilling = await billingEvidence({
        database: state.database,
        workspaceId: config.seedance.workspaceId,
        projectId: config.seedance.projectId,
        taskId: state.seedanceReceipt.task.id,
        expectedUsageRecordId: state.seedanceReceipt.certification?.usageEvidenceId,
      });
      const portraitBilling = await billingEvidence({
        database: state.database,
        workspaceId: config.portrait.workspaceId,
        projectId: config.portrait.projectId,
        taskId: state.portraitGeneration.taskId,
      });
      const seedanceBudget = budgetFinalEvidence.slots[0];
      const portraitBudget = budgetFinalEvidence.slots[1];
      if (
        !seedanceBudget
        || !portraitBudget
        || seedanceBudget.slot !== "seedance"
        || portraitBudget.slot !== "portrait"
        || seedanceBudget.taskId !== state.seedanceReceipt.task.id
        || portraitBudget.taskId !== state.portraitGeneration.taskId
        || seedanceBudget.usageRecordId !== seedanceBilling.audit.usageRecordId
        || portraitBudget.usageRecordId !== portraitBilling.audit.usageRecordId
        || seedanceBudget.reservationId !== seedanceBilling.audit.reservationId
        || portraitBudget.reservationId !== portraitBilling.audit.reservationId
        || seedanceBudget.actualGuMicros !== seedanceBilling.actualGuMicros
        || portraitBudget.actualGuMicros !== portraitBilling.actualGuMicros
        || seedanceBudget.providerTaskIdSha256
          !== rawSha256(String(state.seedanceReceipt.task.providerTaskId || ""))
        || portraitBudget.providerTaskIdSha256
          !== rawSha256(String(portraitBilling.audit.providerRequestId || ""))
        || budgetFinalEvidence.totalActualGuMicros
          !== seedanceBilling.actualGuMicros + portraitBilling.actualGuMicros
        || budgetFinalEvidence.maximumGuMicros !== state.plan.maximumGuMicros
        || state.seedanceReceipt.task.id === state.portraitGeneration.taskId
        || new Set([
          state.seedanceReceipt.task.providerTaskId,
          portraitBilling.audit.providerRequestId,
        ]).size !== state.plan.maximumProviderTasks
        || !state.seedanceReceipt.task.providerTaskId
        || !portraitBilling.audit.providerRequestId
        || state.plan.maximumProviderTasks !== 2
        ||
        seedanceBilling.actualGuMicros + portraitBilling.actualGuMicros
        > state.plan.maximumGuMicros
      ) fail("RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_EXCEEDED", "provider validation task count, identity, or GU amount differs from its committed ceiling");
      const seedanceReceiptSha256 = releaseFullMaintenancePrivateValidationSha256(state.seedanceReceipt);
      const seedanceTaskSha256 = releaseFullMaintenancePrivateValidationSha256({
        task: state.seedanceReceipt.task,
        certificationTaskId: state.seedanceReceipt.certification?.taskId,
        usageEvidenceId: state.seedanceReceipt.certification?.usageEvidenceId,
        auditTaskId: seedanceBilling.audit.taskId,
        requestDigest: seedanceBilling.audit.requestDigest,
        freshEvidence: state.seedanceFreshEvidence,
      });
      const seedanceProviderSha256 = releaseFullMaintenancePrivateValidationSha256({
        operatorProviderTaskId: state.seedanceReceipt.task.providerTaskId,
        auditProviderRequestId: seedanceBilling.audit.providerRequestId,
        providerAccepted: seedanceBilling.audit.providerAccepted,
      });
      const seedanceBillingSha256 = releaseFullMaintenancePrivateValidationSha256({
        certification: state.seedanceReceipt.certification,
        audit: seedanceBilling.audit,
      });
      const portraitAdmissionSha256 = releaseFullMaintenancePrivateValidationSha256(
        state.portraitReceipts.map(({ phase, target, admission, release }) => ({ phase, target, admission, release })),
      );
      const portraitProviderSha256 = releaseFullMaintenancePrivateValidationSha256(
        state.portraitReceipts.map(({ phase, provider, http }) => ({ phase, provider, http })),
      );
      const checks: ReleaseFullMaintenancePrivateValidationChecks = {
        seedance: {
          receiptSha256: seedanceReceiptSha256,
          taskSha256: seedanceTaskSha256,
          providerSha256: seedanceProviderSha256,
          billingSha256: seedanceBillingSha256,
        },
        portrait: {
          admissionSha256: portraitAdmissionSha256,
          providerSha256: portraitProviderSha256,
          generationSha256: releaseFullMaintenancePrivateValidationSha256(state.portraitGeneration),
          billingSha256: releaseFullMaintenancePrivateValidationSha256({
            audit: portraitBilling.audit,
            exactOnceSha256: portraitBilling.exactOnceSha256,
          }),
        },
        billing: {
          usageSha256: releaseFullMaintenancePrivateValidationSha256({
            seedance: seedanceBilling.usageSha256,
            portrait: portraitBilling.usageSha256,
          }),
          ledgerSha256: releaseFullMaintenancePrivateValidationSha256({
            seedance: seedanceBilling.ledgerSha256,
            portrait: portraitBilling.ledgerSha256,
          }),
          exactOnceSha256: releaseFullMaintenancePrivateValidationSha256({
            seedance: seedanceBilling.exactOnceSha256,
            portrait: portraitBilling.exactOnceSha256,
          }),
        },
      };
      const observedAt = now();
      const collectorEvidence = {
        format: "fanjin-release-full-maintenance-private-validation-collector-evidence/v1" as const,
        deploymentId: binding.deploymentId,
        contractSha256: binding.contractSha256,
        bindingSha256: binding.bindingSha256,
        executionId: execution.executionId,
        validationPlanSha256: state.plan.validationPlanSha256,
        nodeProofsSha256: releaseFullMaintenancePrivateValidationSha256(state.nodeProofs),
        healthEvidence: state.healthEvidence,
        checks,
        budgetFinalEvidence,
        observedAt,
      };
      const collectorEvidenceSha256 = releaseFullMaintenancePrivateValidationSha256(collectorEvidence);
      persistProtectedCanonicalEvidence({
        directory: config.receiptDirectory,
        basename: `collector-${collectorEvidenceSha256}.json`,
        value: { ...collectorEvidence, collectorEvidenceSha256 },
      });
      // No PASS candidate may leave the adapter while either dedicated bearer
      // remains usable. Failures before this point are still covered by the
      // adapter's finally cleanup; success proves logout plus a 401 readback.
      await revokeReleaseFullMaintenancePrivateValidationSessions({ tunnel: openedTunnels[0], config });
      sessionsRevoked = true;
      states.delete(binding.bindingSha256);
      return {
        format: RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_CANDIDATE_FORMAT,
        trafficMode: "full-maintenance",
        deploymentId: binding.deploymentId,
        contractSha256: binding.contractSha256,
        bindingSha256: binding.bindingSha256,
        targetArtifactSha256: binding.target.artifactSha256,
        executionId: execution.executionId,
        privateApiInventorySha256: state.healthEvidence.privateApiInventorySha256,
        validationPlanSha256: state.plan.validationPlanSha256,
        rootMfaConfirmationSha256: state.plan.rootMfaConfirmationSha256,
        nodeProofsSha256: releaseFullMaintenancePrivateValidationSha256(state.nodeProofs),
        executorEvidenceSha256: execution.executorEvidenceSha256,
        collectorEvidenceSha256,
        structuredEvidence: {
          validationPlanIntent: config.validationPlanIntent,
          validationPlan: state.plan,
          nodeProofs: state.nodeProofs,
          budgetFinalEvidence,
        },
        checks,
        observedAt,
        verdict: "PASS",
      };
    },
  };
  return {
    executor,
    collector,
    receiptDirectory: config.receiptDirectory,
    timeoutMs: config.timeoutMs,
    destroy: async () => {
      states.clear();
      let cleanupError: unknown;
      try {
        if (!sessionsRevoked && openedTunnels.length) {
          await revokeReleaseFullMaintenancePrivateValidationSessions({ tunnel: openedTunnels[0], config });
          sessionsRevoked = true;
        }
      } catch (error) {
        cleanupError = error;
      } finally {
        await transport.close();
        openedTunnels = [];
        await database?.destroy();
        database = undefined;
      }
      if (cleanupError) throw cleanupError;
    },
  };
}

export function createReleaseFullMaintenancePrivateValidationFromInMemoryConfig(input: {
  config: ReleaseFullMaintenancePrivateValidationProductionConfig;
  now?: () => number;
  signal?: AbortSignal;
}): (
  binding: ReleaseFullMaintenancePrivateValidationBinding,
) => Promise<PersistedReleaseFullMaintenancePrivateValidationReceipt> {
  const now = input.now ?? Date.now;
  return async (binding) => {
    assertStandalonePrivateValidationProcess();
    const config = assertReleaseFullMaintenancePrivateValidationProductionConfig({
      value: input.config,
      binding,
      now: now(),
    });
    const adapter = await createReleaseFullMaintenancePrivateValidationProductionAdapter({ config, binding, now });
    const validate = createReleaseFullMaintenancePrivateValidation({
      executor: adapter.executor,
      collector: adapter.collector,
      receiptDirectory: adapter.receiptDirectory,
      timeoutMs: adapter.timeoutMs,
      now,
      signal: input.signal,
    });
    try {
      return await validate(binding);
    } finally {
      await adapter.destroy();
    }
  };
}
