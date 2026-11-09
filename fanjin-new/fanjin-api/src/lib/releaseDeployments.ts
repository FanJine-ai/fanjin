import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import {
  RELEASE_ARTIFACT_TABLE,
  RELEASE_DEPLOYMENT_EVENT_TABLE,
  RELEASE_DEPLOYMENT_TABLE,
  RELEASE_DEPLOYMENT_TARGET_TABLE,
} from "@/lib/migrations/releaseDeploymentOrchestration";
import {
  RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
} from "@/lib/migrations/releaseArtifactGeneration";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import {
  createRemoteObjectStorageAdapter,
  type ObjectStorageAdapter,
  type ObjectStorageGenerationSnapshot,
} from "@/lib/objectStorage";
import {
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import {
  ReleaseArtifactVerificationError,
  verifyStoredReleaseArtifact,
} from "@/lib/releaseArtifactVerifier";
import {
  RELEASE_ARTIFACT_FORMAT,
  RELEASE_ARTIFACT_MANIFEST_VERSION,
} from "@/lib/releaseArtifactManifestContract";
import {
  parseReleaseArtifactManifest,
  type ReleaseArtifactManifestTarget,
  type ReleaseArtifactManifestV1,
} from "@/lib/releaseArtifactManifest";
import { ReleaseDeploymentError } from "@/lib/releaseDeploymentError";
import {
  inspectDatabaseMigrations,
  type DatabaseMigrationStatus,
} from "@/lib/databaseMigrations";
import {
  defaultReleaseSchemaCompatibility,
  isApprovedAdditiveSchemaWindow,
  parseReleaseSchemaCompatibility,
  resolveReleaseSchemaCompatibilityBridge,
  ReleaseSchemaCompatibilityError,
  type ReleaseSchemaCompatibilityBridgeV1,
  type ReleaseSchemaCompatibilityV1,
} from "@/lib/releaseSchemaCompatibility";
import {
  ReleaseTargetInventoryError,
  resolveTrustedApiTargetInventory,
  resolveTrustedWorkerTargetInventory,
} from "@/lib/releaseTargetInventory";
import { isPostgresClient } from "@/lib/dbDialect";
import type { ReleaseCheckpoint } from "@/release-controller/types";
import { db } from "@/utils/db";

export const releaseArtifactStatuses = ["registered", "ready", "rejected"] as const;
export const releaseDeploymentStatuses = [
  "queued",
  "running",
  "cancelling",
  "rolling_back",
  "succeeded",
  "failed",
  "cancelled",
  "rolled_back",
  "degraded_manual",
] as const;
export const releaseDeploymentTargetStatuses = [
  "pending",
  "draining",
  "deploying",
  "verifying",
  "rolling_back",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "rolled_back",
] as const;
export const releaseDeploymentTargetRoles = ["api", "worker"] as const;
export const releaseDeploymentEventLevels = ["info", "warning", "error"] as const;
export const releaseDeploymentEventActors = ["operator", "orchestrator", "target"] as const;
export {
  RELEASE_ARTIFACT_FORMAT,
  RELEASE_ARTIFACT_MANIFEST_VERSION,
} from "@/lib/releaseArtifactManifestContract";
export {
  parseReleaseArtifactManifest,
  type ReleaseArtifactManifestTarget,
  type ReleaseArtifactManifestV1,
} from "@/lib/releaseArtifactManifest";
export { ReleaseDeploymentError } from "@/lib/releaseDeploymentError";
export const RELEASE_DEPLOYMENT_MAX_UNAVAILABLE = 1 as const;
export const POSTGRES_RELEASE_MUTATION_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))";
const RELEASE_MUTATION_LOCK_NAMESPACE = "fanjin-release-deployment";
const RELEASE_MUTATION_LOCK_SCOPE = "production-fleet";

/**
 * Serialize release-start and exceptional provenance mutations across the
 * physical production fleet. The activeScope unique constraint remains the
 * durable ownership fence; this transaction lock closes the read/check/write
 * race for a command that must prove there is no active deployment.
 */
export async function acquireReleaseMutationLock(
  client: Knex | Knex.Transaction,
): Promise<void> {
  if (!isPostgresClient(client)) return;
  await client.raw(POSTGRES_RELEASE_MUTATION_LOCK_SQL, [
    RELEASE_MUTATION_LOCK_NAMESPACE,
    RELEASE_MUTATION_LOCK_SCOPE,
  ]);
}

export type ReleaseArtifactStatus = (typeof releaseArtifactStatuses)[number];
export type ReleaseDeploymentStatus = (typeof releaseDeploymentStatuses)[number];
export type ReleaseDeploymentTargetStatus = (typeof releaseDeploymentTargetStatuses)[number];
export type ReleaseDeploymentTargetRole = (typeof releaseDeploymentTargetRoles)[number];
export type ReleaseDeploymentEventLevel = (typeof releaseDeploymentEventLevels)[number];
export type ReleaseDeploymentEventActor = (typeof releaseDeploymentEventActors)[number];

export interface ReleaseArtifactRecord {
  id: string;
  releaseId: string;
  idempotencyKey: string;
  requestHash: string;
  storageKey: string;
  uploadReservationId?: string | null;
  storageProvider?: "s3" | "tos" | null;
  storageBucket?: string | null;
  storageRegion?: string | null;
  storageEndpoint?: string | null;
  storageKeyPrefix?: string | null;
  storageForcePathStyle?: boolean | null;
  storageVersionId?: string | null;
  storageEtag?: string | null;
  storageRequestId?: string | null;
  storageCapturedAt?: number | null;
  fileName: string | null;
  mediaType: string | null;
  format: string | null;
  byteSize: number | null;
  sha256: string;
  sourceCommit: string | null;
  manifest: ReleaseArtifactManifestV1;
  status: ReleaseArtifactStatus;
  rejectionReason: string | null;
  createdByUserId: number | null;
  verifiedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseDeploymentPlanTarget extends ReleaseArtifactManifestTarget {
  ordinal: number;
}

export interface ReleaseDeploymentPlan {
  planVersion: 1;
  /**
   * The digest is added only when a confirmed preview becomes a durable
   * deployment. It deliberately is not part of the plan bytes it commits to.
   */
  previewDigest?: string;
  /** Original release revision used by idempotent replay validation. */
  previewReleaseRevision?: number;
  artifactSchemaVersion: number;
  /** Optional only for checkpoints created before schema compatibility v1. */
  artifactSchemaMode?: "schema-neutral";
  artifactSchemaCompatibility?: ReleaseSchemaCompatibilityV1;
  artifactWorkerProtocolVersion: number;
  schemaCompatibility?: ReleaseSchemaCompatibilityBridgeV1 | null;
  strategy: "rolling";
  releaseId: string;
  artifactId: string;
  environment: string;
  scope: string;
  maxUnavailable: typeof RELEASE_DEPLOYMENT_MAX_UNAVAILABLE;
  minHealthyTargets: number;
  minHealthyWorkers: number;
  drainTimeoutMs: number;
  readinessTimeoutMs: number;
  rollbackOnFailure: boolean;
  targets: ReleaseDeploymentPlanTarget[];
  waves: Array<{ wave: number; targetKeys: string[] }>;
}

export interface ReleaseDeploymentRecord {
  id: string;
  releaseId: string;
  artifactId: string;
  previousReleaseId: string | null;
  previousArtifactId: string | null;
  environment: string;
  /** Durable deployment scope. Unlike activeScope, this remains available after completion. */
  scope: string;
  strategy: "rolling";
  status: ReleaseDeploymentStatus;
  activeScope: string | null;
  idempotencyKey: string;
  requestHash: string;
  plan: ReleaseDeploymentPlan;
  phase: string;
  checkpoint: ReleaseCheckpoint;
  targetCount: number;
  completedTargetCount: number;
  succeededTargetCount: number;
  failedTargetCount: number;
  maxUnavailable: number;
  minHealthyTargets: number;
  drainTimeoutMs: number;
  readinessTimeoutMs: number;
  rollbackOnFailure: boolean;
  requestedByUserId: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  cancelRequestedAt: number | null;
  cancelRequestedByUserId: number | null;
  cancelReason: string | null;
  manualInterventionRequired: boolean;
  fencingToken: number;
  errorCode: string | null;
  safeError: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseDeploymentTargetRecord {
  id: string;
  deploymentId: string;
  targetKey: string;
  targetLabel: string;
  role: ReleaseDeploymentTargetRole;
  ordinal: number;
  metadata: Record<string, unknown>;
  status: ReleaseDeploymentTargetStatus;
  attempt: number;
  previousReleaseId: string | null;
  previousArtifactId: string | null;
  observedArtifactId: string | null;
  observedVersion: string | null;
  drainStartedAt: number | null;
  deployStartedAt: number | null;
  verifiedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  safeError: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseDeploymentEventRecord {
  id: string;
  deploymentId: string;
  targetId: string | null;
  sequence: number;
  eventType: string;
  phase: string;
  level: ReleaseDeploymentEventLevel;
  actor: ReleaseDeploymentEventActor;
  actorUserId: number | null;
  requestId: string | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ReleaseDeploymentDetail extends ReleaseDeploymentRecord {
  targets: ReleaseDeploymentTargetRecord[];
}

type ReleaseDb = Knex | Knex.Transaction;
type RawRow = Record<string, any>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_PREVIEW_COMMITMENT_VERSION = 1 as const;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The longest platform SSE request is 300 seconds. The persisted plan must
// describe the same conservative drain window used by the CLB adapter.
const DEFAULT_DRAIN_TIMEOUT_MS = 310_000;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

function table(client: ReleaseDb, name: string): Knex.QueryBuilder {
  return (client as any)(name);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReleaseDeploymentError(`${label} 必须是正整数`, 400, "RELEASE_DEPLOYMENT_INPUT_INVALID");
  }
  return parsed;
}

function boundedTimeout(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const parsed = positiveInteger(value, label);
  if (parsed > MAX_TIMEOUT_MS) {
    throw new ReleaseDeploymentError(
      `${label} 不能超过 ${MAX_TIMEOUT_MS}ms`,
      400,
      "RELEASE_DEPLOYMENT_INPUT_INVALID",
    );
  }
  return parsed;
}

function nonEmptyText(value: unknown, label: string, maximum: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new ReleaseDeploymentError(`${label} 格式无效`, 400, "RELEASE_DEPLOYMENT_INPUT_INVALID");
  }
  return normalized;
}

function safeKey(value: unknown, label: string): string {
  const normalized = nonEmptyText(value, label, 128);
  if (!SAFE_KEY_PATTERN.test(normalized)) {
    throw new ReleaseDeploymentError(`${label} 格式无效`, 400, "RELEASE_DEPLOYMENT_INPUT_INVALID");
  }
  return normalized;
}

function normalizeSha256(value: unknown, label = "sha256"): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new ReleaseDeploymentError(`${label} 必须是 64 位十六进制 SHA-256`, 400, "RELEASE_SHA256_INVALID");
  }
  return normalized;
}

function normalizeUserId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReleaseDeploymentError("operatorUserId 格式无效", 400, "RELEASE_DEPLOYMENT_INPUT_INVALID");
  }
  return parsed;
}

function normalizeOptionalText(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return nonEmptyText(value, "可选字段", maximum);
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === "23505"
    || candidate?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || /unique constraint|unique failed|duplicate key/i.test(String(candidate?.message || ""));
}

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function requestHashFor(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizePreviewDigest(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new ReleaseDeploymentError(
      "previewDigest 必须是有效的 SHA-256 摘要",
      400,
      "RELEASE_DEPLOYMENT_PREVIEW_DIGEST_INVALID",
    );
  }
  return normalized;
}

function previewDigestsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length
    && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function deploymentRequestHash(previewDigest: string): string {
  return requestHashFor({
    commitmentVersion: RELEASE_PREVIEW_COMMITMENT_VERSION,
    previewDigest,
  });
}

function mapArtifact(row: RawRow): ReleaseArtifactRecord {
  return {
    id: String(row.id),
    releaseId: String(row.releaseId),
    idempotencyKey: String(row.idempotencyKey),
    requestHash: String(row.requestHash),
    storageKey: String(row.storageKey),
    uploadReservationId: textOrNull(row.uploadReservationId),
    storageProvider: textOrNull(row.storageProvider) as "s3" | "tos" | null,
    storageBucket: textOrNull(row.storageBucket),
    storageRegion: textOrNull(row.storageRegion),
    storageEndpoint: textOrNull(row.storageEndpoint),
    storageKeyPrefix: textOrNull(row.storageKeyPrefix),
    storageForcePathStyle: row.storageForcePathStyle == null
      ? null
      : Boolean(row.storageForcePathStyle),
    storageVersionId: textOrNull(row.storageVersionId),
    storageEtag: textOrNull(row.storageEtag),
    storageRequestId: textOrNull(row.storageRequestId),
    storageCapturedAt: numberOrNull(row.storageCapturedAt),
    fileName: textOrNull(row.fileName),
    mediaType: textOrNull(row.mediaType),
    format: textOrNull(row.format),
    byteSize: numberOrNull(row.byteSize),
    sha256: String(row.sha256).toLowerCase(),
    sourceCommit: textOrNull(row.sourceCommit),
    manifest: parseReleaseArtifactManifest(parseObject(row.manifestJson)),
    status: String(row.status) as ReleaseArtifactStatus,
    rejectionReason: textOrNull(row.rejectionReason),
    createdByUserId: numberOrNull(row.createdByUserId),
    verifiedAt: numberOrNull(row.verifiedAt),
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function hasExactArtifactGeneration(
  artifact: ReleaseArtifactRecord,
): artifact is ReleaseArtifactRecord & {
  uploadReservationId: string;
  storageProvider: "s3" | "tos";
  storageBucket: string;
  storageRegion: string;
  storageEndpoint: string;
  storageKeyPrefix: string;
  storageForcePathStyle: boolean;
  storageVersionId: string;
  storageEtag: string;
  storageRequestId: string;
  storageCapturedAt: number;
  byteSize: number;
} {
  return Boolean(
    artifact.uploadReservationId
    && (artifact.storageProvider === "s3" || artifact.storageProvider === "tos")
    && artifact.storageBucket
    && artifact.storageRegion
    && artifact.storageEndpoint
    && artifact.storageKeyPrefix != null
    && artifact.storageForcePathStyle != null
    && artifact.storageVersionId
    && artifact.storageVersionId !== "null"
    && artifact.storageEtag
    && artifact.storageRequestId
    && artifact.storageCapturedAt != null
    && Number.isSafeInteger(artifact.storageCapturedAt)
    && artifact.storageCapturedAt > 0
    && artifact.byteSize != null
    && Number.isSafeInteger(artifact.byteSize)
    && artifact.byteSize > 0
  );
}

function mapDeployment(row: RawRow): ReleaseDeploymentRecord {
  const parsedPlan = parseObject(row.planJson);
  const plan = {
    ...parsedPlan,
    schemaCompatibility: parsedPlan.schemaCompatibility ?? null,
  } as unknown as ReleaseDeploymentPlan;
  const parsedCheckpoint = parseObject(row.checkpointJson);
  const checkpoint = {
    ...parsedCheckpoint,
    schemaCompatibility: parsedCheckpoint.schemaCompatibility ?? null,
  } as unknown as ReleaseCheckpoint;
  return {
    id: String(row.id),
    releaseId: String(row.releaseId),
    artifactId: String(row.artifactId),
    previousReleaseId: textOrNull(row.previousReleaseId),
    previousArtifactId: textOrNull(row.previousArtifactId),
    environment: String(row.environment),
    scope: String(plan.scope || row.activeScope || row.environment),
    strategy: "rolling",
    status: String(row.status) as ReleaseDeploymentStatus,
    activeScope: textOrNull(row.activeScope),
    idempotencyKey: String(row.idempotencyKey),
    requestHash: String(row.requestHash),
    plan,
    phase: String(row.phase || "queued"),
    checkpoint,
    targetCount: Number(row.targetCount),
    completedTargetCount: Number(row.completedTargetCount || 0),
    succeededTargetCount: Number(row.succeededTargetCount || 0),
    failedTargetCount: Number(row.failedTargetCount || 0),
    maxUnavailable: Number(row.maxUnavailable),
    minHealthyTargets: Number(row.minHealthyTargets),
    drainTimeoutMs: Number(row.drainTimeoutMs),
    readinessTimeoutMs: Number(row.readinessTimeoutMs),
    rollbackOnFailure: Boolean(Number(row.rollbackOnFailure)),
    requestedByUserId: numberOrNull(row.requestedByUserId),
    leaseOwner: textOrNull(row.leaseOwner),
    leaseExpiresAt: numberOrNull(row.leaseExpiresAt),
    startedAt: numberOrNull(row.startedAt),
    completedAt: numberOrNull(row.completedAt),
    cancelRequestedAt: numberOrNull(row.cancelRequestedAt),
    cancelRequestedByUserId: numberOrNull(row.cancelRequestedByUserId),
    cancelReason: textOrNull(row.cancelReason),
    manualInterventionRequired: Boolean(Number(row.manualInterventionRequired || 0)),
    fencingToken: Number(row.fencingToken || 1),
    errorCode: textOrNull(row.errorCode),
    safeError: textOrNull(row.safeError),
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function mapTarget(row: RawRow): ReleaseDeploymentTargetRecord {
  return {
    id: String(row.id),
    deploymentId: String(row.deploymentId),
    targetKey: String(row.targetKey),
    targetLabel: String(row.targetLabel),
    role: String(row.role) as ReleaseDeploymentTargetRole,
    ordinal: Number(row.ordinal),
    metadata: parseObject(row.targetMetadataJson),
    status: String(row.status) as ReleaseDeploymentTargetStatus,
    attempt: Number(row.attempt || 0),
    previousReleaseId: textOrNull(row.previousReleaseId),
    previousArtifactId: textOrNull(row.previousArtifactId),
    observedArtifactId: textOrNull(row.observedArtifactId),
    observedVersion: textOrNull(row.observedVersion),
    drainStartedAt: numberOrNull(row.drainStartedAt),
    deployStartedAt: numberOrNull(row.deployStartedAt),
    verifiedAt: numberOrNull(row.verifiedAt),
    completedAt: numberOrNull(row.completedAt),
    errorCode: textOrNull(row.errorCode),
    safeError: textOrNull(row.safeError),
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function mapEvent(row: RawRow): ReleaseDeploymentEventRecord {
  return {
    id: String(row.id),
    deploymentId: String(row.deploymentId),
    targetId: textOrNull(row.targetId),
    sequence: Number(row.sequence),
    eventType: String(row.eventType),
    phase: String(row.phase),
    level: String(row.level) as ReleaseDeploymentEventLevel,
    actor: String(row.actor) as ReleaseDeploymentEventActor,
    actorUserId: numberOrNull(row.actorUserId),
    requestId: textOrNull(row.requestId),
    message: String(row.message),
    payload: parseObject(row.payloadJson),
    createdAt: Number(row.createdAt),
  };
}

/** Bind a package to the actual, fully applied database migration history. */
async function inspectReleaseArtifactSchemaCurrent(
  artifact: Pick<ReleaseArtifactRecord, "manifest">,
  client: Knex = db as unknown as Knex,
): Promise<DatabaseMigrationStatus> {
  let status: Awaited<ReturnType<typeof inspectDatabaseMigrations>>;
  try {
    status = await inspectDatabaseMigrations(client);
  } catch {
    throw new ReleaseDeploymentError(
      "无法核验数据库迁移历史，已拒绝发布",
      503,
      "RELEASE_DATABASE_SCHEMA_UNVERIFIABLE",
    );
  }
  const appliedVersion = status.applied.at(-1)?.version ?? 0;
  const compatibility = artifact.manifest.schemaCompatibility
    ?? defaultReleaseSchemaCompatibility(artifact.manifest.schemaVersion);
  const pendingExpand = !status.current
    && status.pending.length === 1
    && compatibility.binarySchemaVersion === appliedVersion
    && compatibility.supportedDatabaseVersions.includes(appliedVersion)
    && compatibility.supportedDatabaseVersions.includes(status.latestVersion)
    && compatibility.migration !== null
    && compatibility.migration.fromVersion === appliedVersion
    && compatibility.migration.toVersion === status.latestVersion
    && compatibility.migration.migrationName === status.pending[0].name
    && compatibility.migration.migrationChecksum === status.pending[0].checksum
    && isApprovedAdditiveSchemaWindow(compatibility.migration);
  if (!status.tableExists
    || (!status.current && !pendingExpand)
    || (status.current && appliedVersion !== status.latestVersion)) {
    throw new ReleaseDeploymentError(
      "数据库迁移未完整应用，已拒绝发布",
      503,
      "RELEASE_DATABASE_MIGRATIONS_NOT_CURRENT",
      { appliedVersion, latestVersion: status.latestVersion },
    );
  }
  if (artifact.manifest.schemaVersion !== appliedVersion) {
    throw new ReleaseDeploymentError(
      "发布制品 schemaVersion 与数据库实际迁移版本不一致",
      409,
      "RELEASE_ARTIFACT_SCHEMA_VERSION_MISMATCH",
      { artifactSchemaVersion: artifact.manifest.schemaVersion, appliedVersion },
    );
  }
  return status;
}

export async function assertReleaseArtifactSchemaCurrent(
  artifact: Pick<ReleaseArtifactRecord, "manifest">,
  client: Knex = db as unknown as Knex,
): Promise<void> {
  await inspectReleaseArtifactSchemaCurrent(artifact, client);
}

function validateStorageKey(releaseId: string, value: unknown): string {
  const storageKey = nonEmptyText(value, "storageKey", 1024);
  const prefix = `release-artifacts/${releaseId}/`;
  if (!storageKey.startsWith(prefix) || storageKey.length === prefix.length || storageKey.includes("\\")) {
    throw new ReleaseDeploymentError(
      `storageKey 必须位于 ${prefix} 下`,
      400,
      "RELEASE_ARTIFACT_STORAGE_KEY_INVALID",
    );
  }
  const segments = storageKey.split("/");
  if (segments.some((segment) => {
    if (!segment || segment === "." || segment === "..") return true;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    } catch {
      return true;
    }
  })) {
    throw new ReleaseDeploymentError("storageKey 包含不安全路径片段", 400, "RELEASE_ARTIFACT_STORAGE_KEY_INVALID");
  }
  return storageKey;
}

export function resolveTrustedReleaseTargets(
  env: Record<string, string | undefined> = process.env,
): ReleaseArtifactManifestTarget[] {
  try {
    return resolveTrustedApiTargetInventory(env);
  } catch (error) {
    if (error instanceof ReleaseTargetInventoryError) {
      throw new ReleaseDeploymentError(error.message, error.status, error.code);
    }
    throw error;
  }
}

export function resolveTrustedWorkerTargets(
  env: Record<string, string | undefined> = process.env,
): ReleaseArtifactManifestTarget[] {
  try {
    return resolveTrustedWorkerTargetInventory(env);
  } catch (error) {
    if (error instanceof ReleaseTargetInventoryError) {
      throw new ReleaseDeploymentError(error.message, error.status, error.code);
    }
    throw error;
  }
}

function orderedPlanTargets(
  trustedTargets: readonly ReleaseArtifactManifestTarget[],
  requestedTargetKeys?: readonly string[] | null,
): ReleaseDeploymentPlanTarget[] {
  let selected = [...trustedTargets];
  if (requestedTargetKeys !== undefined && requestedTargetKeys !== null) {
    if (!Array.isArray(requestedTargetKeys) || requestedTargetKeys.length < 1) {
      throw new ReleaseDeploymentError("targetKeys 不能为空", 400, "RELEASE_DEPLOYMENT_TARGETS_EMPTY");
    }
    const keys = requestedTargetKeys.map((key) => safeKey(key, "targetKey"));
    if (new Set(keys).size !== keys.length) {
      throw new ReleaseDeploymentError("targetKeys 不能重复", 400, "RELEASE_DEPLOYMENT_TARGETS_DUPLICATE");
    }
    const requested = new Set(keys);
    const unknown = keys.filter((key) => !trustedTargets.some((target) => target.key === key));
    if (unknown.length) {
      throw new ReleaseDeploymentError(
        `服务器发布清单中不存在目标：${unknown.join(", ")}`,
        400,
        "RELEASE_DEPLOYMENT_TARGET_UNKNOWN",
      );
    }
    if (keys.length !== trustedTargets.length) {
      throw new ReleaseDeploymentError(
        "无感发布不能跳过受信 API 节点",
        400,
        "RELEASE_DEPLOYMENT_TARGET_SUBSET_UNSAFE",
      );
    }
    selected = trustedTargets.filter((target) => requested.has(target.key));
  }
  return [...selected]
    .sort((left, right) => left.wave - right.wave || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((target, ordinal) => ({ ...target, ordinal }));
}

function buildPlan(input: {
  releaseId: string;
  artifactId: string;
  manifest: ReleaseArtifactManifestV1;
  environment: string;
  scope: string;
  schemaCompatibility: ReleaseSchemaCompatibilityBridgeV1 | null;
  targetKeys?: readonly string[] | null;
  drainTimeoutMs?: number;
  readinessTimeoutMs?: number;
  rollbackOnFailure?: boolean;
}): ReleaseDeploymentPlan {
  // Deployment inventory is server-owned. Artifact metadata never chooses
  // infrastructure targets and browser input cannot introduce arbitrary hosts.
  const apiTargets = resolveTrustedReleaseTargets();
  const workerTargets = resolveTrustedWorkerTargets();
  if (workerTargets.length === 1) {
    throw new ReleaseDeploymentError(
      "无感发布的独立 Worker inventory 必须为空或至少包含两台",
      503,
      "RELEASE_DEDICATED_WORKERS_INSUFFICIENT",
    );
  }
  const duplicateRoleKey = workerTargets.find((worker) => apiTargets.some((api) => api.key === worker.key));
  const duplicateRoleServer = workerTargets.find((worker) => (
    worker.serverId && apiTargets.some((api) => api.serverId === worker.serverId)
  ));
  if (duplicateRoleKey) {
    throw new ReleaseDeploymentError(
      "API 与 Worker 发布清单不能复用同一 nodeId",
      503,
      "RELEASE_TARGET_ROLE_CONFLICT",
    );
  }
  if (duplicateRoleServer) {
    throw new ReleaseDeploymentError(
      "独立 Worker 与 API 不能部署在同一物理服务器",
      503,
      "RELEASE_TARGET_PHYSICAL_HOST_CONFLICT",
      { serverId: duplicateRoleServer.serverId },
    );
  }
  const targets = orderedPlanTargets([...workerTargets, ...apiTargets], input.targetKeys);
  const selectedApiCount = targets.filter((target) => target.role === "api").length;
  const selectedWorkerCount = targets.filter((target) => target.role === "worker").length;
  const waveMap = new Map<number, string[]>();
  for (const target of targets) {
    const keys = waveMap.get(target.wave) || [];
    keys.push(target.key);
    waveMap.set(target.wave, keys);
  }
  return {
    planVersion: 1,
    artifactSchemaVersion: input.manifest.schemaVersion,
    artifactSchemaMode: input.manifest.schemaMode,
    artifactSchemaCompatibility: input.manifest.schemaCompatibility
      ?? defaultReleaseSchemaCompatibility(input.manifest.schemaVersion),
    artifactWorkerProtocolVersion: input.manifest.workerProtocolVersion,
    ...(input.schemaCompatibility
      ? { schemaCompatibility: input.schemaCompatibility }
      : {}),
    strategy: "rolling",
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    environment: input.environment,
    scope: input.scope,
    maxUnavailable: RELEASE_DEPLOYMENT_MAX_UNAVAILABLE,
    minHealthyTargets: Math.max(1, selectedApiCount - RELEASE_DEPLOYMENT_MAX_UNAVAILABLE),
    minHealthyWorkers: selectedWorkerCount === 0
      ? 0
      : Math.max(1, selectedWorkerCount - RELEASE_DEPLOYMENT_MAX_UNAVAILABLE),
    drainTimeoutMs: boundedTimeout(
      input.drainTimeoutMs,
      "drainTimeoutMs",
      DEFAULT_DRAIN_TIMEOUT_MS,
    ),
    readinessTimeoutMs: boundedTimeout(
      input.readinessTimeoutMs,
      "readinessTimeoutMs",
      DEFAULT_READINESS_TIMEOUT_MS,
    ),
    rollbackOnFailure: input.rollbackOnFailure !== false,
    targets,
    waves: [...waveMap.entries()].map(([wave, targetKeys]) => ({ wave, targetKeys })),
  };
}

async function readArtifact(client: ReleaseDb, id: string): Promise<ReleaseArtifactRecord | null> {
  const row = await table(client, RELEASE_ARTIFACT_TABLE).where({ id }).first();
  return row ? mapArtifact(row as RawRow) : null;
}

interface PreviousSuccessfulArtifactProvenance {
  release: RawRow;
  deployment: RawRow;
  artifact: ReleaseArtifactRecord;
  schemaCompatibility: ReleaseSchemaCompatibilityBridgeV1 | null;
}

interface ReleaseArtifactGenerationCommitment {
  uploadReservationId: string;
  storageProvider: "s3" | "tos";
  storageBucket: string;
  storageRegion: string;
  storageEndpoint: string;
  storageKeyPrefix: string;
  storageForcePathStyle: boolean;
  storageKey: string;
  storageVersionId: string;
  storageEtag: string;
  storageRequestId: string;
  storageCapturedAt: number;
  byteSize: number;
}

function artifactGenerationCommitment(
  artifact: ReleaseArtifactRecord,
): ReleaseArtifactGenerationCommitment {
  if (!hasExactArtifactGeneration(artifact)) {
    throw new ReleaseDeploymentError(
      "发布制品缺少精确对象存储 generation 证据",
      503,
      "RELEASE_ARTIFACT_GENERATION_EVIDENCE_MISSING",
    );
  }
  return {
    uploadReservationId: artifact.uploadReservationId,
    storageProvider: artifact.storageProvider,
    storageBucket: artifact.storageBucket,
    storageRegion: artifact.storageRegion,
    storageEndpoint: artifact.storageEndpoint,
    storageKeyPrefix: artifact.storageKeyPrefix,
    storageForcePathStyle: artifact.storageForcePathStyle,
    storageKey: artifact.storageKey,
    storageVersionId: artifact.storageVersionId,
    storageEtag: artifact.storageEtag,
    storageRequestId: artifact.storageRequestId,
    storageCapturedAt: artifact.storageCapturedAt,
    byteSize: artifact.byteSize,
  };
}

function releaseMigrationCommitment(status: DatabaseMigrationStatus) {
  return {
    tableExists: status.tableExists,
    current: status.current,
    databaseVersion: status.databaseVersion,
    knownLatestVersion: status.knownLatestVersion,
    latestVersion: status.latestVersion,
    runtimeCompatible: status.runtimeCompatible,
    applied: status.applied.map(({ version, name, checksum }) => ({
      version,
      name,
      checksum,
    })),
    pending: status.pending.map(({ version, name, checksum }) => ({
      version,
      name,
      checksum,
    })),
  };
}

function releaseDeploymentPreviewCommitment(input: {
  release: RawRow;
  artifact: ReleaseArtifactRecord;
  previous: PreviousSuccessfulArtifactProvenance;
  migrationStatus: DatabaseMigrationStatus;
  plan: ReleaseDeploymentPlan;
}) {
  const previousArtifact = input.previous.artifact;
  const canonicalPlan = { ...input.plan };
  delete canonicalPlan.previewDigest;
  delete canonicalPlan.previewReleaseRevision;
  return {
    commitmentVersion: RELEASE_PREVIEW_COMMITMENT_VERSION,
    release: {
      id: String(input.release.id),
      revision: Number(input.release.revision),
      channel: String(input.release.channel),
      version: String(input.release.version),
      status: String(input.release.status),
    },
    targetArtifact: {
      id: input.artifact.id,
      releaseId: input.artifact.releaseId,
      revision: input.artifact.revision,
      sha256: input.artifact.sha256,
      manifest: input.artifact.manifest,
      generation: artifactGenerationCommitment(input.artifact),
    },
    previous: {
      release: {
        id: String(input.previous.release.id),
        revision: Number(input.previous.release.revision),
        channel: String(input.previous.release.channel),
        status: String(input.previous.release.status),
      },
      deployment: {
        id: String(input.previous.deployment.id),
        revision: Number(input.previous.deployment.revision),
        status: String(input.previous.deployment.status),
        artifactId: String(input.previous.deployment.artifactId),
      },
      artifact: {
        id: previousArtifact.id,
        releaseId: previousArtifact.releaseId,
        revision: previousArtifact.revision,
        sha256: previousArtifact.sha256,
        manifest: previousArtifact.manifest,
        generation: artifactGenerationCommitment(previousArtifact),
      },
    },
    migration: releaseMigrationCommitment(input.migrationStatus),
    schemaBridge: input.previous.schemaCompatibility,
    plan: canonicalPlan,
  };
}

function computeReleaseDeploymentPreviewDigest(input: {
  release: RawRow;
  artifact: ReleaseArtifactRecord;
  previous: PreviousSuccessfulArtifactProvenance;
  migrationStatus: DatabaseMigrationStatus;
  plan: ReleaseDeploymentPlan;
}): string {
  return requestHashFor(releaseDeploymentPreviewCommitment(input));
}

/**
 * Resolve the immutable package that completed the immediately preceding
 * published rollout. A normal rolling release shares the live task queue with
 * the previous API/Worker generation, so it may only bridge two artifacts
 * that declare the same queue payload protocol. Bootstrapping an empty fleet
 * or changing that protocol requires a separate, explicit workflow.
 */
async function requirePreviousSuccessfulArtifact(
  client: ReleaseDb,
  input: {
    releaseId: string;
    channel: string;
    targetArtifact: ReleaseArtifactRecord;
    lockRows?: boolean;
  },
): Promise<PreviousSuccessfulArtifactProvenance> {
  if (input.targetArtifact.manifest.releaseId !== input.releaseId) {
    throw new ReleaseDeploymentError(
      "目标制品的 manifest.releaseId 与发布记录不一致",
      409,
      "RELEASE_ARTIFACT_RELEASE_MISMATCH",
    );
  }
  let previousReleaseQuery = table(client, PLATFORM_RELEASE_TABLE)
    .where({ status: "published", channel: input.channel })
    .whereNot({ id: input.releaseId })
    .orderBy("publishedAt", "desc")
    .orderBy("updatedAt", "desc")
    .orderBy("createdAt", "desc")
    .first();
  if (input.lockRows) previousReleaseQuery = previousReleaseQuery.forUpdate();
  const previousRelease = await previousReleaseQuery;
  if (!previousRelease) {
    throw new ReleaseDeploymentError(
      "当前发布通道没有可证明的上一正式版本；普通滚动发布不能用于首次集群引导",
      409,
      "RELEASE_PREVIOUS_BASELINE_REQUIRED",
      { channel: input.channel },
    );
  }

  // A release can have multiple candidate artifacts. Only a succeeded
  // deployment proves which immutable package was actually serving traffic.
  let previousDeploymentQuery = table(client, RELEASE_DEPLOYMENT_TABLE)
    .where({ releaseId: previousRelease.id, status: "succeeded" })
    .orderBy("completedAt", "desc")
    .orderBy("createdAt", "desc")
    .first();
  if (input.lockRows) previousDeploymentQuery = previousDeploymentQuery.forUpdate();
  const previousDeployment = await previousDeploymentQuery;
  if (!previousDeployment) {
    throw new ReleaseDeploymentError(
      "上一正式版本缺少成功发布记录，无法证明当前线上制品",
      409,
      "RELEASE_PREVIOUS_ARTIFACT_PROVENANCE_MISSING",
      { previousReleaseId: String(previousRelease.id) },
    );
  }

  let previousArtifactQuery = table(client, RELEASE_ARTIFACT_TABLE)
    .where({
      id: previousDeployment.artifactId,
      releaseId: previousRelease.id,
      status: "ready",
    })
    .first();
  if (input.lockRows) previousArtifactQuery = previousArtifactQuery.forUpdate();
  const previousArtifactRow = await previousArtifactQuery;
  if (!previousArtifactRow) {
    throw new ReleaseDeploymentError(
      "上一正式版本的成功发布制品记录不完整",
      409,
      "RELEASE_PREVIOUS_ARTIFACT_PROVENANCE_MISSING",
      {
        previousReleaseId: String(previousRelease.id),
        previousDeploymentId: String(previousDeployment.id),
      },
    );
  }

  let previousArtifact: ReleaseArtifactRecord;
  try {
    previousArtifact = mapArtifact(previousArtifactRow as RawRow);
    if (
      previousArtifact.manifest.releaseId !== String(previousRelease.id)
      || !hasExactArtifactGeneration(previousArtifact)
    ) {
      throw new ReleaseDeploymentError(
        "上一正式版本制品缺少精确对象存储 generation 证据",
        409,
        "RELEASE_PREVIOUS_ARTIFACT_PROVENANCE_MISSING",
      );
    }
  } catch (error) {
    if (!(error instanceof ReleaseDeploymentError)) throw error;
    throw new ReleaseDeploymentError(
      "上一正式版本制品缺少可验证的 Worker 协议信息",
      409,
      "RELEASE_PREVIOUS_ARTIFACT_PROVENANCE_MISSING",
      {
        previousReleaseId: String(previousRelease.id),
        previousDeploymentId: String(previousDeployment.id),
        previousArtifactId: String(previousArtifactRow.id),
      },
    );
  }

  const previousProtocolVersion = previousArtifact.manifest.workerProtocolVersion;
  const targetProtocolVersion = input.targetArtifact.manifest.workerProtocolVersion;
  if (previousProtocolVersion !== targetProtocolVersion) {
    throw new ReleaseDeploymentError(
      "目标制品与上一正式制品的 Worker 协议版本不同，不能执行普通滚动发布",
      409,
      "RELEASE_WORKER_PROTOCOL_VERSION_MISMATCH",
      {
        previousReleaseId: String(previousRelease.id),
        previousArtifactId: previousArtifact.id,
        previousWorkerProtocolVersion: previousProtocolVersion,
        targetArtifactId: input.targetArtifact.id,
        targetWorkerProtocolVersion: targetProtocolVersion,
      },
    );
  }
  let schemaCompatibility: ReleaseSchemaCompatibilityBridgeV1 | null;
  try {
    schemaCompatibility = resolveReleaseSchemaCompatibilityBridge({
      previous: {
        releaseId: previousArtifact.manifest.releaseId,
        sourceCommit: previousArtifact.manifest.sourceCommit,
        artifactSha256: previousArtifact.sha256,
        schemaVersion: previousArtifact.manifest.schemaVersion,
        schemaCompatibility: previousArtifact.manifest.schemaCompatibility
          ?? defaultReleaseSchemaCompatibility(previousArtifact.manifest.schemaVersion),
      },
      target: {
        releaseId: input.targetArtifact.manifest.releaseId,
        sourceCommit: input.targetArtifact.manifest.sourceCommit,
        artifactSha256: input.targetArtifact.sha256,
        schemaVersion: input.targetArtifact.manifest.schemaVersion,
        schemaCompatibility: input.targetArtifact.manifest.schemaCompatibility
          ?? defaultReleaseSchemaCompatibility(input.targetArtifact.manifest.schemaVersion),
      },
      databaseVersion: input.targetArtifact.manifest.schemaVersion,
    });
  } catch (error) {
    if (error instanceof ReleaseSchemaCompatibilityError) {
      throw new ReleaseDeploymentError(error.message, 409, error.code, {
        previousArtifactId: previousArtifact.id,
        targetArtifactId: input.targetArtifact.id,
      });
    }
    throw error;
  }

  return {
    release: previousRelease as RawRow,
    deployment: previousDeployment as RawRow,
    artifact: previousArtifact,
    schemaCompatibility,
  };
}

async function readDeploymentDetail(client: ReleaseDb, id: string): Promise<ReleaseDeploymentDetail | null> {
  const row = await table(client, RELEASE_DEPLOYMENT_TABLE).where({ id }).first();
  if (!row) return null;
  const targets = await table(client, RELEASE_DEPLOYMENT_TARGET_TABLE)
    .where({ deploymentId: id })
    .orderBy("ordinal", "asc");
  return { ...mapDeployment(row as RawRow), targets: (targets as RawRow[]).map(mapTarget) };
}

async function nextEventSequence(client: ReleaseDb, deploymentId: string): Promise<number> {
  const row = await table(client, RELEASE_DEPLOYMENT_EVENT_TABLE)
    .where({ deploymentId })
    .max({ sequence: "sequence" })
    .first();
  return Number(row?.sequence || 0) + 1;
}

async function appendEvent(client: ReleaseDb, input: {
  deploymentId: string;
  targetId?: string | null;
  eventType: string;
  phase: string;
  level?: ReleaseDeploymentEventLevel;
  actor?: ReleaseDeploymentEventActor;
  actorUserId?: number | null;
  requestId?: string | null;
  message: string;
  payload?: Record<string, unknown>;
  now: number;
}): Promise<void> {
  await table(client, RELEASE_DEPLOYMENT_EVENT_TABLE).insert({
    id: uuid(),
    deploymentId: input.deploymentId,
    targetId: input.targetId ?? null,
    sequence: await nextEventSequence(client, input.deploymentId),
    eventType: input.eventType,
    phase: input.phase,
    level: input.level ?? "info",
    actor: input.actor ?? "orchestrator",
    actorUserId: input.actorUserId ?? null,
    requestId: input.requestId ?? null,
    message: input.message,
    payloadJson: JSON.stringify(input.payload ?? {}),
    createdAt: input.now,
  });
}

function initialControllerCheckpoint(input: {
  deploymentId: string;
  releaseVersion: string;
  artifact: ReleaseArtifactRecord;
  previousArtifact: ReleaseArtifactRecord;
  plan: ReleaseDeploymentPlan;
  now: number;
}): ReleaseCheckpoint {
  const workerOrder = input.plan.targets
    .filter((target) => target.role === "worker")
    .map((target) => target.key);
  return {
    operationId: input.deploymentId,
    status: "running",
    phase: "preflight",
    artifact: {
      id: input.artifact.id,
      releaseId: input.artifact.manifest.releaseId,
      version: input.releaseVersion,
      sha256: input.artifact.sha256,
      sourceCommit: input.artifact.manifest.sourceCommit,
      schemaVersion: input.artifact.manifest.schemaVersion,
      schemaMode: input.artifact.manifest.schemaMode,
      schemaCompatibility: input.artifact.manifest.schemaCompatibility
        ?? defaultReleaseSchemaCompatibility(
          input.artifact.manifest.schemaVersion,
        ),
      workerProtocolVersion: input.artifact.manifest.workerProtocolVersion,
      runtimeCapabilities: [...input.artifact.manifest.runtimeCapabilities],
      ...(input.artifact.manifest.deployment
        ? { deployment: input.artifact.manifest.deployment }
        : {}),
      deploymentMode: input.artifact.manifest.deployment
        ? "container-image"
        : "archive-systemd",
      imageDigest: input.artifact.manifest.deployment?.imageDigest ?? null,
    },
    previousArtifact: {
      id: input.previousArtifact.id,
      releaseId: input.previousArtifact.manifest.releaseId,
      version: input.previousArtifact.manifest.releaseId,
      sha256: input.previousArtifact.sha256,
      sourceCommit: input.previousArtifact.manifest.sourceCommit,
      schemaVersion: input.previousArtifact.manifest.schemaVersion,
      schemaMode: input.previousArtifact.manifest.schemaMode,
      schemaCompatibility: input.previousArtifact.manifest.schemaCompatibility
        ?? defaultReleaseSchemaCompatibility(
          input.previousArtifact.manifest.schemaVersion,
        ),
      workerProtocolVersion:
        input.previousArtifact.manifest.workerProtocolVersion,
      runtimeCapabilities: [
        ...input.previousArtifact.manifest.runtimeCapabilities,
      ],
      ...(input.previousArtifact.manifest.deployment
        ? { deployment: input.previousArtifact.manifest.deployment }
        : {}),
      deploymentMode: input.previousArtifact.manifest.deployment
        ? "container-image"
        : "archive-systemd",
      imageDigest: input.previousArtifact.manifest.deployment?.imageDigest ?? null,
    },
    schemaMode: input.artifact.manifest.schemaMode,
    schemaCompatibility: input.plan.schemaCompatibility ?? null,
    // The controller resolves the current CLB backend snapshot during
    // preflight. Persisting manifest targets here as already-resolved nodes
    // would lose their original weights and make recovery unsafe.
    nodeOrder: [],
    nodes: {},
    redisRuntimeFingerprint: "",
    redisCutoverScheduleAttempted: false,
    redisCutoverScheduled: false,
    redisCutoverState: "unarmed",
    redisCutoverAtMs: null,
    workerOrder,
    workers: Object.fromEntries(workerOrder.map((nodeId) => [nodeId, {
      nodeId,
      previousArtifactSha256: "",
      preflightComplete: false,
      staged: false,
      capacityConfirmed: false,
      drainRequested: false,
      drained: false,
      activationAttempted: false,
      activated: false,
      artifactReady: false,
      bridgeAuthorized: false,
      bridgeFinalized: false,
      resumed: false,
      serving: false,
      completed: false,
      isolated: false,
      rolledBack: false,
      rollbackVerified: false,
    }])),
    preflightComplete: false,
    stageComplete: false,
    workerPreflightComplete: workerOrder.length === 0,
    workerStageComplete: workerOrder.length === 0,
    workerRollingComplete: workerOrder.length === 0,
    schemaMigrationRunId: null,
    schemaMigrationAttempted: false,
    schemaMigrationComplete: true,
    publicSmokeComplete: false,
    currentNodeId: null,
    error: null,
    manualInterventionRequired: false,
    events: [{
      sequence: 1,
      operationId: input.deploymentId,
      type: "operation.started",
      phase: "preflight",
      nodeId: null,
      at: input.now,
    }],
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function replayArtifact(row: RawRow, requestHash: string): { artifact: ReleaseArtifactRecord; idempotent: true } {
  if (String(row.requestHash).toLowerCase() !== requestHash) {
    throw new ReleaseDeploymentError(
      "idempotencyKey 已绑定不同的制品登记请求",
      409,
      "RELEASE_ARTIFACT_IDEMPOTENCY_CONFLICT",
      { artifactId: String(row.id) },
    );
  }
  return { artifact: mapArtifact(row), idempotent: true };
}

async function replayDeployment(
  client: ReleaseDb,
  row: RawRow,
  previewDigest: string,
  expected: {
    releaseId: string;
    artifactId: string;
    releaseRevision: number;
  },
): Promise<{ deployment: ReleaseDeploymentDetail; idempotent: true }> {
  const persistedPlan = parseObject(row.planJson);
  const persistedDigest = typeof persistedPlan.previewDigest === "string"
    && SHA256_PATTERN.test(persistedPlan.previewDigest)
    ? persistedPlan.previewDigest
    : null;
  const persistedReleaseRevision = Number(persistedPlan.previewReleaseRevision);
  if (
    !persistedDigest
    || !Number.isSafeInteger(persistedReleaseRevision)
    || persistedReleaseRevision <= 0
  ) {
    throw new ReleaseDeploymentError(
      "幂等发布记录缺少预览承诺，必须重新发起发布",
      409,
      "RELEASE_DEPLOYMENT_PREVIEW_COMMITMENT_MISSING",
      { deploymentId: String(row.id) },
    );
  }
  if (
    String(row.releaseId) !== expected.releaseId
    || String(row.artifactId) !== expected.artifactId
    || persistedReleaseRevision !== expected.releaseRevision
  ) {
    throw new ReleaseDeploymentError(
      "idempotencyKey 已绑定不同的发布身份",
      409,
      "RELEASE_DEPLOYMENT_IDEMPOTENCY_CONFLICT",
      { deploymentId: String(row.id) },
    );
  }
  if (!previewDigestsEqual(persistedDigest, previewDigest)) {
    throw new ReleaseDeploymentError(
      "idempotencyKey 已绑定不同的发布预览承诺",
      409,
      "RELEASE_DEPLOYMENT_IDEMPOTENCY_CONFLICT",
      { deploymentId: String(row.id) },
    );
  }
  if (String(row.requestHash).toLowerCase() !== deploymentRequestHash(persistedDigest)) {
    throw new ReleaseDeploymentError(
      "幂等发布记录的预览承诺证据损坏",
      500,
      "RELEASE_DEPLOYMENT_COMMITMENT_EVIDENCE_INVALID",
      { deploymentId: String(row.id) },
    );
  }
  const deployment = await readDeploymentDetail(client, String(row.id));
  if (!deployment) {
    throw new ReleaseDeploymentError(
      "幂等发布记录损坏",
      500,
      "RELEASE_DEPLOYMENT_REPLAY_MISSING",
    );
  }
  return { deployment, idempotent: true };
}

export interface RegisterReleaseArtifactInput {
  releaseId: string;
  reservationId: string;
  idempotencyKey: string;
  sha256: string;
  manifest: unknown;
  format?: string | null;
  sourceCommit?: string | null;
  operatorUserId: number;
}

type ReleaseArtifactFinalizeStorage =
  Pick<ObjectStorageAdapter, "inspectGeneration">;

export interface RegisterReleaseArtifactDependencies {
  resolveConfiguration?: () => ObjectStorageConfiguration;
  createStorage?: (
    configuration: ObjectStorageConfiguration,
  ) => ReleaseArtifactFinalizeStorage;
  now?: () => number;
}

interface UploadReservationRow {
  id: string;
  releaseId: string;
  operatorUserId: number;
  requestHash: string;
  storageKey: string;
  fileName: string;
  declaredByteSize: number;
  contentType: string;
  storageProvider: string;
  storageBucket: string;
  storageRegion: string;
  storageEndpoint: string;
  storageKeyPrefix: string;
  storageForcePathStyle: boolean;
  status: string;
  expiresAt: number;
  finalizedArtifactId: string | null;
  revision: number;
}

function mapUploadReservation(row: RawRow): UploadReservationRow {
  return {
    id: String(row.id),
    releaseId: String(row.releaseId),
    operatorUserId: Number(row.operatorUserId),
    requestHash: String(row.requestHash),
    storageKey: String(row.storageKey),
    fileName: String(row.fileName),
    declaredByteSize: Number(row.declaredByteSize),
    contentType: String(row.contentType).trim().toLowerCase(),
    storageProvider: String(row.storageProvider),
    storageBucket: String(row.storageBucket),
    storageRegion: String(row.storageRegion),
    storageEndpoint: String(row.storageEndpoint),
    storageKeyPrefix: String(row.storageKeyPrefix || ""),
    storageForcePathStyle: Boolean(row.storageForcePathStyle),
    status: String(row.status),
    expiresAt: Number(row.expiresAt),
    finalizedArtifactId: textOrNull(row.finalizedArtifactId),
    revision: Number(row.revision),
  };
}

function assertReservationStorageIdentity(
  reservation: UploadReservationRow,
  configuration: ObjectStorageConfiguration,
): void {
  if (
    (configuration.provider !== "s3" && configuration.provider !== "tos")
    || reservation.storageProvider !== configuration.provider
    || reservation.storageBucket !== configuration.bucket
    || reservation.storageRegion !== configuration.region
    || reservation.storageEndpoint !== configuration.endpoint
    || reservation.storageKeyPrefix !== configuration.keyPrefix
    || reservation.storageForcePathStyle !== configuration.forcePathStyle
  ) {
    throw new ReleaseDeploymentError(
      "上传预约绑定的对象存储身份已变化",
      409,
      "RELEASE_ARTIFACT_STORAGE_IDENTITY_CHANGED",
    );
  }
}

function sameReservationFinalizationIdentity(
  left: UploadReservationRow,
  right: UploadReservationRow,
): boolean {
  return left.id === right.id
    && left.releaseId === right.releaseId
    && left.operatorUserId === right.operatorUserId
    && left.requestHash === right.requestHash
    && left.storageKey === right.storageKey
    && left.fileName === right.fileName
    && left.declaredByteSize === right.declaredByteSize
    && left.contentType === right.contentType
    && left.storageProvider === right.storageProvider
    && left.storageBucket === right.storageBucket
    && left.storageRegion === right.storageRegion
    && left.storageEndpoint === right.storageEndpoint
    && left.storageKeyPrefix === right.storageKeyPrefix
    && left.storageForcePathStyle === right.storageForcePathStyle
    && left.expiresAt === right.expiresAt
    && left.revision === right.revision;
}

function assertExactUploadedGeneration(
  reservation: UploadReservationRow,
  snapshot: ObjectStorageGenerationSnapshot,
): asserts snapshot is ObjectStorageGenerationSnapshot & {
  etag: string;
  versionId: string;
  size: number;
  contentType: string;
} {
  if (
    !snapshot.exists
    || snapshot.deleteMarker
    || snapshot.provider !== reservation.storageProvider
    || snapshot.bucket !== reservation.storageBucket
    || snapshot.key !== reservation.storageKey
  ) {
    throw new ReleaseDeploymentError(
      "上传预约对应的远端制品不存在",
      422,
      "RELEASE_ARTIFACT_UPLOAD_OBJECT_INVALID",
    );
  }
  if (!snapshot.versionId || snapshot.versionId === "null") {
    throw new ReleaseDeploymentError(
      "对象存储未返回可重复读取的版本标识",
      503,
      "RELEASE_ARTIFACT_STORAGE_VERSION_REQUIRED",
    );
  }
  if (!snapshot.etag || !snapshot.requestId) {
    throw new ReleaseDeploymentError(
      "对象存储未返回完整上传凭据",
      503,
      "RELEASE_ARTIFACT_STORAGE_RECEIPT_INCOMPLETE",
    );
  }
  if (snapshot.size !== reservation.declaredByteSize) {
    throw new ReleaseDeploymentError(
      "远端制品大小与上传预约不一致",
      422,
      "RELEASE_ARTIFACT_UPLOAD_SIZE_MISMATCH",
    );
  }
  if (
    String(snapshot.contentType || "").trim().toLowerCase()
    !== reservation.contentType
  ) {
    throw new ReleaseDeploymentError(
      "远端制品 Content-Type 与上传预约不一致",
      422,
      "RELEASE_ARTIFACT_UPLOAD_CONTENT_TYPE_MISMATCH",
    );
  }
}

function replayFinalizedReservation(
  artifact: RawRow | undefined,
  requestHash: string,
): { artifact: ReleaseArtifactRecord; idempotent: true } {
  if (!artifact) {
    throw new ReleaseDeploymentError(
      "已完成的上传预约缺少制品记录",
      500,
      "RELEASE_ARTIFACT_FINALIZATION_EVIDENCE_MISSING",
    );
  }
  return replayArtifact(artifact, requestHash);
}

export async function registerReleaseArtifact(
  input: RegisterReleaseArtifactInput,
  dependencies: RegisterReleaseArtifactDependencies = {},
): Promise<{ artifact: ReleaseArtifactRecord; idempotent: boolean }> {
  const releaseId = nonEmptyText(input.releaseId, "releaseId", 128);
  const reservationId = nonEmptyText(
    input.reservationId,
    "reservationId",
    128,
  );
  const idempotencyKey = nonEmptyText(input.idempotencyKey, "idempotencyKey", 200);
  const sha256 = normalizeSha256(input.sha256);
  const manifest = parseReleaseArtifactManifest(input.manifest, releaseId);
  const operatorUserId = normalizeUserId(input.operatorUserId);
  if (!operatorUserId) {
    throw new ReleaseDeploymentError(
      "发布制品登记必须绑定有效操作人",
      403,
      "RELEASE_ARTIFACT_OPERATOR_REQUIRED",
    );
  }
  const before = await db(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
    .where({ id: reservationId })
    .first();
  if (!before) {
    throw new ReleaseDeploymentError(
      "上传预约不存在",
      404,
      "RELEASE_ARTIFACT_UPLOAD_RESERVATION_NOT_FOUND",
    );
  }
  const reservation = mapUploadReservation(before as RawRow);
  if (
    reservation.releaseId !== releaseId
    || reservation.operatorUserId !== operatorUserId
  ) {
    throw new ReleaseDeploymentError(
      "上传预约与当前版本或操作人不匹配",
      403,
      "RELEASE_ARTIFACT_UPLOAD_RESERVATION_MISMATCH",
    );
  }
  const storageKey = validateStorageKey(releaseId, reservation.storageKey);
  const fileName = reservation.fileName;
  const mediaType = reservation.contentType;
  const format = normalizeOptionalText(input.format, 64) ?? manifest.format;
  const sourceCommit = normalizeOptionalText(input.sourceCommit, 128) ?? manifest.sourceCommit;
  const byteSize = positiveInteger(
    reservation.declaredByteSize,
    "declaredByteSize",
  );
  const requestHash = requestHashFor({
    releaseId,
    reservationId,
    sha256,
    manifest,
    fileName,
    mediaType,
    format,
    byteSize,
    sourceCommit,
  });

  if (reservation.status === "finalized") {
    const finalized = reservation.finalizedArtifactId
      ? await db(RELEASE_ARTIFACT_TABLE)
        .where({ id: reservation.finalizedArtifactId })
        .first()
      : undefined;
    return replayFinalizedReservation(finalized as RawRow | undefined, requestHash);
  }
  const now = dependencies.now || Date.now;
  const checkedAt = now();
  if (reservation.status !== "pending" || reservation.expiresAt <= checkedAt) {
    throw new ReleaseDeploymentError(
      "上传预约已过期或不可用",
      410,
      "RELEASE_ARTIFACT_UPLOAD_RESERVATION_EXPIRED",
    );
  }

  let configuration: ObjectStorageConfiguration;
  let snapshot: ObjectStorageGenerationSnapshot;
  try {
    configuration = (dependencies.resolveConfiguration
      || resolveObjectStorageConfiguration)();
    assertReservationStorageIdentity(reservation, configuration);
    const storage = (dependencies.createStorage
      || createRemoteObjectStorageAdapter)(configuration);
    snapshot = await storage.inspectGeneration(storageKey);
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) throw error;
    throw new ReleaseDeploymentError(
      "无法核验上传预约对应的远端制品",
      503,
      "RELEASE_ARTIFACT_UPLOAD_FINALIZE_UNAVAILABLE",
    );
  }
  assertExactUploadedGeneration(reservation, snapshot);
  const finalizedAt = now();
  if (reservation.expiresAt <= finalizedAt) {
    throw new ReleaseDeploymentError(
      "上传预约已过期",
      410,
      "RELEASE_ARTIFACT_UPLOAD_RESERVATION_EXPIRED",
    );
  }

  try {
    return await (db as unknown as Knex).transaction(async (trx) => {
      const existing = await trx(RELEASE_ARTIFACT_TABLE).where({ idempotencyKey }).first();
      if (existing) return replayArtifact(existing, requestHash);

      const lockedReservationRow = await trx(
        RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
      ).where({ id: reservationId }).forUpdate().first();
      if (!lockedReservationRow) {
        throw new ReleaseDeploymentError(
          "上传预约不存在",
          404,
          "RELEASE_ARTIFACT_UPLOAD_RESERVATION_NOT_FOUND",
        );
      }
      const lockedReservation = mapUploadReservation(
        lockedReservationRow as RawRow,
      );
      if (
        lockedReservation.releaseId !== releaseId
        || lockedReservation.operatorUserId !== operatorUserId
      ) {
        throw new ReleaseDeploymentError(
          "上传预约与当前版本或操作人不匹配",
          403,
          "RELEASE_ARTIFACT_UPLOAD_RESERVATION_MISMATCH",
        );
      }
      if (lockedReservation.status === "finalized") {
        const finalized = lockedReservation.finalizedArtifactId
          ? await trx(RELEASE_ARTIFACT_TABLE)
            .where({ id: lockedReservation.finalizedArtifactId })
            .first()
          : undefined;
        return replayFinalizedReservation(
          finalized as RawRow | undefined,
          requestHash,
        );
      }
      if (
        lockedReservation.status !== "pending"
        || !sameReservationFinalizationIdentity(
          lockedReservation,
          reservation,
        )
        || lockedReservation.expiresAt <= finalizedAt
      ) {
        throw new ReleaseDeploymentError(
          "上传预约已过期或已由其他请求完成",
          409,
          "RELEASE_ARTIFACT_UPLOAD_FINALIZE_CONFLICT",
        );
      }
      const release = await trx(PLATFORM_RELEASE_TABLE).where({ id: releaseId }).forUpdate().first();
      if (!release) {
        throw new ReleaseDeploymentError("版本记录不存在", 404, "PLATFORM_RELEASE_NOT_FOUND");
      }
      if (String(release.status) !== "draft") {
        throw new ReleaseDeploymentError(
          "只有草稿版本可以登记发布制品",
          409,
          "RELEASE_ARTIFACT_RELEASE_NOT_DRAFT",
          { releaseStatus: String(release.status) },
        );
      }

      const id = uuid();
      await trx(RELEASE_ARTIFACT_TABLE).insert({
        id,
        releaseId,
        idempotencyKey,
        requestHash,
        storageKey,
        uploadReservationId: reservationId,
        storageProvider: configuration.provider,
        storageBucket: configuration.bucket,
        storageRegion: configuration.region,
        storageEndpoint: configuration.endpoint,
        storageKeyPrefix: configuration.keyPrefix,
        storageForcePathStyle: configuration.forcePathStyle,
        storageVersionId: snapshot.versionId,
        storageEtag: snapshot.etag,
        storageRequestId: snapshot.requestId,
        storageCapturedAt: finalizedAt,
        fileName,
        mediaType,
        format,
        byteSize,
        sha256,
        sourceCommit,
        manifestJson: JSON.stringify(manifest),
        status: "registered",
        rejectionReason: null,
        createdByUserId: operatorUserId,
        verifiedAt: null,
        revision: 1,
        createdAt: finalizedAt,
        updatedAt: finalizedAt,
      });
      const finalized = await trx(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
        .where({
          id: reservationId,
          status: "pending",
          revision: reservation.revision,
        })
        .andWhere("expiresAt", ">", finalizedAt)
        .update({
          status: "finalized",
          finalizedArtifactId: id,
          finalizedAt,
          revision: reservation.revision + 1,
          updatedAt: finalizedAt,
        });
      if (Number(finalized || 0) !== 1) {
        throw new ReleaseDeploymentError(
          "上传预约已由其他请求完成",
          409,
          "RELEASE_ARTIFACT_UPLOAD_FINALIZE_CONFLICT",
        );
      }
      const artifact = await readArtifact(trx, id);
      if (!artifact) {
        throw new ReleaseDeploymentError("制品登记后无法读取", 500, "RELEASE_ARTIFACT_CREATE_MISSING");
      }
      return { artifact, idempotent: false };
    });
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) throw error;
    if (!isUniqueViolation(error)) throw error;

    const existingByKey = await db(RELEASE_ARTIFACT_TABLE).where({ idempotencyKey }).first();
    if (existingByKey) return replayArtifact(existingByKey, requestHash);
    const finalizedReservation = await db(
      RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
    ).where({ id: reservationId }).first();
    if (finalizedReservation?.finalizedArtifactId) {
      const artifact = await db(RELEASE_ARTIFACT_TABLE)
        .where({ id: finalizedReservation.finalizedArtifactId })
        .first();
      return replayFinalizedReservation(
        artifact as RawRow | undefined,
        requestHash,
      );
    }
    const duplicate = await db(RELEASE_ARTIFACT_TABLE)
      .where({ releaseId, sha256 })
      .orWhere({ uploadReservationId: reservationId })
      .first();
    throw new ReleaseDeploymentError(
      "相同制品摘要或存储位置已经登记",
      409,
      "RELEASE_ARTIFACT_ALREADY_REGISTERED",
      duplicate ? { artifactId: String(duplicate.id) } : undefined,
    );
  }
}

export interface MarkReleaseArtifactReadyInput {
  artifactId: string;
  revision: number;
}

export async function markReleaseArtifactReady(
  input: MarkReleaseArtifactReadyInput,
  dependencies: { verify?: typeof verifyStoredReleaseArtifact } = {},
): Promise<ReleaseArtifactRecord> {
  const artifactId = nonEmptyText(input.artifactId, "artifactId", 128);
  const revision = positiveInteger(input.revision, "revision");
  const before = await db(RELEASE_ARTIFACT_TABLE).where({ id: artifactId }).first();
  if (!before) throw new ReleaseDeploymentError("发布制品不存在", 404, "RELEASE_ARTIFACT_NOT_FOUND");
  if (Number(before.revision) !== revision) {
    throw new ReleaseDeploymentError(
      "发布制品已被其他请求更新",
      409,
      "RELEASE_ARTIFACT_REVISION_CONFLICT",
      { expectedRevision: revision, currentRevision: Number(before.revision) },
    );
  }
  if (String(before.status) !== "registered") {
    throw new ReleaseDeploymentError(
      "只有 registered 制品可以执行服务端校验",
      409,
      "RELEASE_ARTIFACT_STATUS_CONFLICT",
      { artifactStatus: String(before.status) },
    );
  }
  const artifact = mapArtifact(before as RawRow);
  if (!hasExactArtifactGeneration(artifact)) {
    throw new ReleaseDeploymentError(
      "发布制品缺少精确对象存储 generation 证据",
      503,
      "RELEASE_ARTIFACT_GENERATION_EVIDENCE_MISSING",
    );
  }
  let verified: Awaited<ReturnType<typeof verifyStoredReleaseArtifact>>;
  try {
    verified = await (dependencies.verify ?? verifyStoredReleaseArtifact)({
      storageKey: artifact.storageKey,
      storageProvider: artifact.storageProvider,
      storageBucket: artifact.storageBucket,
      storageRegion: artifact.storageRegion,
      storageEndpoint: artifact.storageEndpoint,
      storageKeyPrefix: artifact.storageKeyPrefix,
      storageForcePathStyle: artifact.storageForcePathStyle,
      storageVersionId: artifact.storageVersionId,
      storageEtag: artifact.storageEtag,
      expectedSha256: artifact.sha256,
      expectedByteSize: artifact.byteSize,
    });
  } catch (error) {
    if (error instanceof ReleaseArtifactVerificationError) {
      const unavailable = error.code === "RELEASE_ARTIFACT_OBJECT_UNAVAILABLE"
        || error.code === "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_MISSING"
        || error.code === "RELEASE_ARTIFACT_ATTESTATION_TRUST_STORE_INVALID";
      throw new ReleaseDeploymentError(error.message, unavailable ? 503 : 422, error.code);
    }
    throw error;
  }
  const verifiedManifest = parseReleaseArtifactManifest(verified.manifest, artifact.releaseId);
  if (canonicalJson(verifiedManifest) !== canonicalJson(artifact.manifest)) {
    throw new ReleaseDeploymentError(
      "包内 release-manifest.json 与登记清单不一致",
      422,
      "RELEASE_ARTIFACT_MANIFEST_MISMATCH",
    );
  }
  const now = Date.now();
  const updated = await db(RELEASE_ARTIFACT_TABLE)
    .where({ id: artifactId, status: "registered", revision })
    .update({
      status: "ready",
      byteSize: verified.byteSize,
      sourceCommit: verifiedManifest.sourceCommit,
      format: verifiedManifest.format,
      verifiedAt: now,
      updatedAt: now,
      revision: revision + 1,
    });
  if (Number(updated || 0) !== 1) {
    const current = await db(RELEASE_ARTIFACT_TABLE).where({ id: artifactId }).first();
    if (!current) throw new ReleaseDeploymentError("发布制品不存在", 404, "RELEASE_ARTIFACT_NOT_FOUND");
    if (Number(current.revision) !== revision) {
      throw new ReleaseDeploymentError(
        "发布制品已被其他请求更新",
        409,
        "RELEASE_ARTIFACT_REVISION_CONFLICT",
        { expectedRevision: revision, currentRevision: Number(current.revision) },
      );
    }
    throw new ReleaseDeploymentError(
      "只有 registered 制品可以标记为 ready",
      409,
      "RELEASE_ARTIFACT_STATUS_CONFLICT",
      { artifactStatus: String(current.status) },
    );
  }
  const readyArtifact = await readArtifact(db, artifactId);
  if (!readyArtifact) throw new ReleaseDeploymentError("发布制品更新后无法读取", 500, "RELEASE_ARTIFACT_UPDATE_MISSING");
  return readyArtifact;
}

export interface PreviewReleaseDeploymentInput {
  releaseId: string;
  artifactId: string;
  releaseRevision: number;
  environment?: string;
  targetKeys?: readonly string[] | null;
  drainTimeoutMs?: number;
  readinessTimeoutMs?: number;
  rollbackOnFailure?: boolean;
}

export interface ReleaseDeploymentPreview {
  releaseId: string;
  releaseVersion: string;
  releaseRevision: number;
  releaseStatus: string;
  artifactId: string;
  artifactStatus: ReleaseArtifactStatus;
  artifactRevision: number;
  previewDigest: string;
  plan: ReleaseDeploymentPlan;
}

/**
 * Narrow binding accepted from the independent 0.1.2 control plane.  The
 * caller supplies immutable identities only; database ids, the inventory and
 * the preview commitment are always resolved again from the product release
 * ledger on this side of the trust boundary.
 */
export interface IndependentReleaseControlPlan {
  environment: "staging" | "production";
  releaseVersion: string;
  artifactDigest: string;
  baselineDigest: string | null;
  mode: "rolling" | "fast-downtime";
  targetIds: readonly string[];
  schemaChange: "none" | "compatible" | "reversible";
  maxUnavailable: number;
  healthTimeoutSeconds: number;
  rollbackOnFailure: boolean;
}

export interface IndependentReleaseControlBinding {
  releaseId: string;
  artifactId: string;
  releaseRevision: number;
  previewDigest: string;
  environment: string;
  targetKeys: readonly string[];
  readinessTimeoutMs: number;
  rollbackOnFailure: boolean;
}

function sameSortedStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Translate the public control-plane plan to the mature rolling controller's
 * server-owned commitment.  This is deliberately verification-only: it does
 * not register artifacts, publish releases, mutate inventory or start work.
 */
export async function resolveIndependentReleaseControlPlan(
  input: IndependentReleaseControlPlan,
): Promise<IndependentReleaseControlBinding> {
  if (input.mode !== "rolling") {
    throw new ReleaseDeploymentError(
      "独立发布器的停服快发执行协议尚未启用",
      409,
      "RELEASE_CONTROL_FAST_DOWNTIME_DISABLED",
    );
  }
  if (input.maxUnavailable !== RELEASE_DEPLOYMENT_MAX_UNAVAILABLE) {
    throw new ReleaseDeploymentError(
      "滚动发布 maxUnavailable 必须为 1",
      409,
      "RELEASE_CONTROL_MAX_UNAVAILABLE_MISMATCH",
    );
  }
  const releaseVersion = nonEmptyText(input.releaseVersion, "releaseVersion", 64);
  const releases = await db(PLATFORM_RELEASE_TABLE)
    .where({ version: releaseVersion, status: "draft" })
    .orderBy("createdAt", "desc")
    .limit(2);
  if (releases.length !== 1) {
    throw new ReleaseDeploymentError(
      releases.length === 0 ? "没有匹配的草稿发布版本" : "草稿发布版本不唯一",
      409,
      releases.length === 0
        ? "RELEASE_CONTROL_DRAFT_RELEASE_NOT_FOUND"
        : "RELEASE_CONTROL_DRAFT_RELEASE_AMBIGUOUS",
      { releaseVersion },
    );
  }
  const release = releases[0] as RawRow;
  const releaseId = String(release.id);
  const artifactRows = await db(RELEASE_ARTIFACT_TABLE)
    .where({ releaseId, status: "ready" })
    .orderBy("verifiedAt", "desc");
  const matchingArtifacts = artifactRows
    .map((row) => mapArtifact(row as RawRow))
    .filter((artifact) => artifact.manifest.deployment?.imageDigest === input.artifactDigest);
  if (matchingArtifacts.length !== 1) {
    throw new ReleaseDeploymentError(
      matchingArtifacts.length === 0 ? "没有匹配镜像摘要的就绪制品" : "镜像摘要匹配多个就绪制品",
      409,
      matchingArtifacts.length === 0
        ? "RELEASE_CONTROL_READY_ARTIFACT_NOT_FOUND"
        : "RELEASE_CONTROL_READY_ARTIFACT_AMBIGUOUS",
      { releaseId, artifactDigest: input.artifactDigest },
    );
  }
  const artifact = matchingArtifacts[0];
  const previous = await requirePreviousSuccessfulArtifact(db, {
    releaseId,
    channel: String(release.channel),
    targetArtifact: artifact,
  });
  const previousDigest = previous.artifact.manifest.deployment?.imageDigest ?? null;
  if (!input.baselineDigest || input.baselineDigest !== previousDigest) {
    throw new ReleaseDeploymentError(
      "独立发布器的回滚基线与当前正式制品不一致",
      409,
      "RELEASE_CONTROL_BASELINE_DIGEST_MISMATCH",
      { expectedBaselineDigest: previousDigest },
    );
  }
  const schemaChanged = artifact.manifest.schemaVersion !== previous.artifact.manifest.schemaVersion;
  if ((input.schemaChange === "none") !== !schemaChanged) {
    throw new ReleaseDeploymentError(
      "发布计划的 schemaChange 与签名制品不一致",
      409,
      "RELEASE_CONTROL_SCHEMA_CHANGE_MISMATCH",
    );
  }
  const readinessTimeoutMs = positiveInteger(
    input.healthTimeoutSeconds,
    "healthTimeoutSeconds",
  ) * 1_000;
  const preview = await previewReleaseDeployment({
    releaseId,
    artifactId: artifact.id,
    releaseRevision: Number(release.revision),
    environment: input.environment,
    readinessTimeoutMs,
    rollbackOnFailure: input.rollbackOnFailure,
  });
  const targetKeys = preview.plan.targets.map((target) => target.key);
  if (!sameSortedStrings(targetKeys, input.targetIds)) {
    throw new ReleaseDeploymentError(
      "独立发布器目标集合与受信生产清单不一致",
      409,
      "RELEASE_CONTROL_TARGET_INVENTORY_MISMATCH",
      { expectedTargetIds: targetKeys },
    );
  }
  return Object.freeze({
    releaseId,
    artifactId: artifact.id,
    releaseRevision: Number(release.revision),
    previewDigest: preview.previewDigest,
    environment: input.environment,
    targetKeys: Object.freeze([...targetKeys]),
    readinessTimeoutMs,
    rollbackOnFailure: input.rollbackOnFailure,
  });
}

export async function previewReleaseDeployment(
  input: PreviewReleaseDeploymentInput,
): Promise<ReleaseDeploymentPreview> {
  const releaseId = nonEmptyText(input.releaseId, "releaseId", 128);
  const artifactId = nonEmptyText(input.artifactId, "artifactId", 128);
  const releaseRevision = positiveInteger(input.releaseRevision, "releaseRevision");
  const environment = safeKey(input.environment ?? "production", "environment");
  // This value is also the database uniqueness/fencing domain. It must be
  // server-owned: accepting it from the browser would allow two administrators
  // to choose different strings and concurrently mutate the same CLB fleet.
  const scope = safeKey(process.env.FANJIN_RELEASE_DEPLOYMENT_SCOPE ?? environment, "FANJIN_RELEASE_DEPLOYMENT_SCOPE");
  const [release, artifactRow] = await Promise.all([
    db(PLATFORM_RELEASE_TABLE).where({ id: releaseId }).first(),
    db(RELEASE_ARTIFACT_TABLE).where({ id: artifactId }).first(),
  ]);
  if (!release) throw new ReleaseDeploymentError("版本记录不存在", 404, "PLATFORM_RELEASE_NOT_FOUND");
  if (!artifactRow) throw new ReleaseDeploymentError("发布制品不存在", 404, "RELEASE_ARTIFACT_NOT_FOUND");
  const artifact = mapArtifact(artifactRow);
  if (artifact.releaseId !== releaseId) {
    throw new ReleaseDeploymentError("发布制品不属于当前版本", 409, "RELEASE_ARTIFACT_RELEASE_MISMATCH");
  }
  if (String(release.status) !== "draft") {
    throw new ReleaseDeploymentError(
      "只有草稿版本可以预览发布计划",
      409,
      "RELEASE_DEPLOYMENT_RELEASE_NOT_DRAFT",
      { releaseStatus: String(release.status) },
    );
  }
  if (Number(release.revision) !== releaseRevision) {
    throw new ReleaseDeploymentError(
      "版本草稿已被其他管理员更新",
      409,
      "RELEASE_DEPLOYMENT_RELEASE_REVISION_CONFLICT",
      { expectedRevision: releaseRevision, currentRevision: Number(release.revision) },
    );
  }
  if (artifact.status !== "ready") {
    throw new ReleaseDeploymentError(
      "发布制品尚未完成校验",
      409,
      "RELEASE_ARTIFACT_NOT_READY",
      { artifactStatus: artifact.status },
    );
  }
  if (!hasExactArtifactGeneration(artifact)) {
    throw new ReleaseDeploymentError(
      "发布制品缺少精确对象存储 generation 证据",
      503,
      "RELEASE_ARTIFACT_GENERATION_EVIDENCE_MISSING",
    );
  }
  const migrationStatus = await inspectReleaseArtifactSchemaCurrent(artifact);
  const previous = await requirePreviousSuccessfulArtifact(db, {
    releaseId,
    channel: String(release.channel),
    targetArtifact: artifact,
  });
  const plan = buildPlan({
    releaseId,
    artifactId,
    manifest: artifact.manifest,
    environment,
    scope,
    schemaCompatibility: previous.schemaCompatibility,
    targetKeys: input.targetKeys,
    drainTimeoutMs: input.drainTimeoutMs,
    readinessTimeoutMs: input.readinessTimeoutMs,
    rollbackOnFailure: input.rollbackOnFailure,
  });
  const previewDigest = computeReleaseDeploymentPreviewDigest({
    release: release as RawRow,
    artifact,
    previous,
    migrationStatus,
    plan,
  });
  return {
    releaseId,
    releaseVersion: String(release.version),
    releaseRevision: Number(release.revision),
    releaseStatus: String(release.status),
    artifactId,
    artifactStatus: artifact.status,
    artifactRevision: artifact.revision,
    previewDigest,
    plan,
  };
}

export interface StartReleaseDeploymentInput {
  releaseId: string;
  artifactId: string;
  releaseRevision: number;
  idempotencyKey: string;
  previewDigest: string;
  environment?: string;
  targetKeys?: readonly string[] | null;
  drainTimeoutMs?: number;
  readinessTimeoutMs?: number;
  rollbackOnFailure?: boolean;
  operatorUserId?: number | null;
  requestId?: string | null;
}

export async function startReleaseDeployment(
  input: StartReleaseDeploymentInput,
): Promise<{ deployment: ReleaseDeploymentDetail; idempotent: boolean }> {
  const releaseId = nonEmptyText(input.releaseId, "releaseId", 128);
  const artifactId = nonEmptyText(input.artifactId, "artifactId", 128);
  const releaseRevision = positiveInteger(input.releaseRevision, "releaseRevision");
  const idempotencyKey = nonEmptyText(input.idempotencyKey, "idempotencyKey", 200);
  const previewDigest = normalizePreviewDigest(input.previewDigest);
  const environment = safeKey(input.environment ?? "production", "environment");
  // See previewReleaseDeployment: one physical fleet has one fixed scope.
  const scope = safeKey(process.env.FANJIN_RELEASE_DEPLOYMENT_SCOPE ?? environment, "FANJIN_RELEASE_DEPLOYMENT_SCOPE");
  const operatorUserId = normalizeUserId(input.operatorUserId);
  const requestId = normalizeOptionalText(input.requestId, 200);
  const computedRequestHash = deploymentRequestHash(previewDigest);

  try {
    return await (db as unknown as Knex).transaction(async (trx) => {
      await acquireReleaseMutationLock(trx);
      // Always acquire locks in release -> artifact order. The same order is
      // used by every start request, avoiding a cross-release deadlock while
      // ensuring a concurrent ready/cancel transition cannot invalidate the
      // plan between validation and persistence.
      const release = await trx(PLATFORM_RELEASE_TABLE).where({ id: releaseId }).forUpdate().first();
      if (!release) throw new ReleaseDeploymentError("版本记录不存在", 404, "PLATFORM_RELEASE_NOT_FOUND");
      const artifactRow = await trx(RELEASE_ARTIFACT_TABLE).where({ id: artifactId }).forUpdate().first();
      if (!artifactRow) throw new ReleaseDeploymentError("发布制品不存在", 404, "RELEASE_ARTIFACT_NOT_FOUND");
      const artifact = mapArtifact(artifactRow);
      if (artifact.releaseId !== releaseId) {
        throw new ReleaseDeploymentError("发布制品不属于当前版本", 409, "RELEASE_ARTIFACT_RELEASE_MISMATCH");
      }

      // A replay must be recognized before draft/status validation: the first
      // successful request has already moved the release to `deploying`.
      const existing = await trx(RELEASE_DEPLOYMENT_TABLE)
        .where({ idempotencyKey })
        .forUpdate()
        .first();
      if (existing) {
        // Replays compare the caller's digest with the original durable
        // commitment. They must not rebuild a historical plan from today's
        // topology or migration state.
        return replayDeployment(trx, existing, previewDigest, {
          releaseId,
          artifactId,
          releaseRevision,
        });
      }

      if (String(release.status) !== "draft") {
        throw new ReleaseDeploymentError(
          "只有草稿版本可以开始发布",
          409,
          "RELEASE_DEPLOYMENT_RELEASE_NOT_DRAFT",
          { releaseStatus: String(release.status) },
        );
      }
      if (Number(release.revision) !== releaseRevision) {
        throw new ReleaseDeploymentError(
          "版本草稿已被其他管理员更新",
          409,
          "RELEASE_DEPLOYMENT_RELEASE_REVISION_CONFLICT",
          { expectedRevision: releaseRevision, currentRevision: Number(release.revision) },
        );
      }
      if (artifact.status !== "ready") {
        throw new ReleaseDeploymentError(
          "发布制品尚未完成校验",
          409,
          "RELEASE_ARTIFACT_NOT_READY",
          { artifactStatus: artifact.status },
        );
      }
      if (!hasExactArtifactGeneration(artifact)) {
        throw new ReleaseDeploymentError(
          "发布制品缺少精确对象存储 generation 证据",
          503,
          "RELEASE_ARTIFACT_GENERATION_EVIDENCE_MISSING",
        );
      }
      const migrationStatus = await inspectReleaseArtifactSchemaCurrent(
        artifact,
        trx as unknown as Knex,
      );
      const previous = await requirePreviousSuccessfulArtifact(trx, {
        releaseId,
        channel: String(release.channel),
        targetArtifact: artifact,
        lockRows: true,
      });
      const previousRelease = previous.release;
      const previousArtifact = previous.artifact;
      const canonicalPlan = buildPlan({
        releaseId,
        artifactId,
        manifest: artifact.manifest,
        environment,
        scope,
        schemaCompatibility: previous.schemaCompatibility,
        // Re-resolve the complete server-owned fleet. A node added or removed
        // after preview must produce a digest mismatch (409), not a client
        // subset-validation error before the commitment comparison.
        targetKeys: undefined,
        drainTimeoutMs: input.drainTimeoutMs,
        readinessTimeoutMs: input.readinessTimeoutMs,
        rollbackOnFailure: input.rollbackOnFailure,
      });
      const currentPreviewDigest = computeReleaseDeploymentPreviewDigest({
        release: release as RawRow,
        artifact,
        previous,
        migrationStatus,
        plan: canonicalPlan,
      });
      if (!previewDigestsEqual(currentPreviewDigest, previewDigest)) {
        throw new ReleaseDeploymentError(
          "发布计划或生产基线已变化，请重新预览并确认",
          409,
          "RELEASE_DEPLOYMENT_PREVIEW_STALE",
        );
      }

      // Persist the exact operator-confirmed commitment with the plan. This is
      // the replay authority even if topology changes after the first start.
      const plan: ReleaseDeploymentPlan = {
        ...canonicalPlan,
        previewDigest,
        previewReleaseRevision: releaseRevision,
      };

      const now = Date.now();
      const deploymentId = uuid();
      const checkpoint = initialControllerCheckpoint({
        deploymentId,
        releaseVersion: String(release.version),
        artifact,
        previousArtifact,
        plan,
        now,
      });

      const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
        .where({ id: releaseId, status: "draft", revision: releaseRevision })
        .update({
          status: "deploying",
          updatedByUserId: operatorUserId,
          updatedAt: now,
          revision: releaseRevision + 1,
        });
      if (Number(releaseUpdated || 0) !== 1) {
        throw new ReleaseDeploymentError(
          "版本状态已变化，请刷新后重试",
          409,
          "RELEASE_DEPLOYMENT_RELEASE_WRITE_CONFLICT",
        );
      }

      await trx(RELEASE_DEPLOYMENT_TABLE).insert({
        id: deploymentId,
        releaseId,
        artifactId,
        previousReleaseId: previousRelease?.id ?? null,
        previousArtifactId: previousArtifact?.id ?? null,
        environment,
        strategy: "rolling",
        status: "queued",
        phase: "queued",
        activeScope: scope,
        idempotencyKey,
        requestHash: computedRequestHash,
        planJson: JSON.stringify(plan),
        checkpointJson: JSON.stringify(checkpoint),
        manualInterventionRequired: 0,
        fencingToken: 1,
        targetCount: plan.targets.length,
        completedTargetCount: 0,
        succeededTargetCount: 0,
        failedTargetCount: 0,
        maxUnavailable: RELEASE_DEPLOYMENT_MAX_UNAVAILABLE,
        minHealthyTargets: plan.minHealthyTargets,
        drainTimeoutMs: plan.drainTimeoutMs,
        readinessTimeoutMs: plan.readinessTimeoutMs,
        rollbackOnFailure: plan.rollbackOnFailure ? 1 : 0,
        requestedByUserId: operatorUserId,
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: null,
        completedAt: null,
        cancelRequestedAt: null,
        cancelRequestedByUserId: null,
        cancelReason: null,
        errorCode: null,
        safeError: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });

      await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).insert(plan.targets.map((target) => ({
        id: uuid(),
        deploymentId,
        targetKey: target.key,
        targetLabel: target.label,
        role: target.role,
        ordinal: target.ordinal,
        targetMetadataJson: JSON.stringify({
          wave: target.wave,
          zone: target.zone ?? null,
          serverId: target.serverId ?? null,
        }),
        status: "pending",
        attempt: 0,
        previousReleaseId: previousRelease?.id ?? null,
        previousArtifactId: previousArtifact?.id ?? null,
        observedArtifactId: null,
        observedVersion: null,
        drainStartedAt: null,
        deployStartedAt: null,
        verifiedAt: null,
        completedAt: null,
        errorCode: null,
        safeError: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })));

      await appendEvent(trx, {
        deploymentId,
        eventType: "deployment.created",
        phase: "queued",
        actor: "operator",
        actorUserId: operatorUserId,
        requestId,
        message: "滚动发布已进入队列",
        payload: {
          releaseId,
          artifactId,
          previewDigest,
          environment,
          scope,
          targetKeys: plan.targets.map((target) => target.key),
          maxUnavailable: RELEASE_DEPLOYMENT_MAX_UNAVAILABLE,
        },
        now,
      });
      const deployment = await readDeploymentDetail(trx, deploymentId);
      if (!deployment) {
        throw new ReleaseDeploymentError("发布任务创建后无法读取", 500, "RELEASE_DEPLOYMENT_CREATE_MISSING");
      }
      return { deployment, idempotent: false };
    });
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) throw error;
    if (!isUniqueViolation(error)) throw error;

    const existing = await db(RELEASE_DEPLOYMENT_TABLE).where({ idempotencyKey }).first();
    if (existing) {
      return replayDeployment(db, existing, previewDigest, {
        releaseId,
        artifactId,
        releaseRevision,
      });
    }
    const active = await db(RELEASE_DEPLOYMENT_TABLE).where({ activeScope: scope }).first();
    if (active) {
      throw new ReleaseDeploymentError(
        `发布范围 ${scope} 已有进行中的任务`,
        409,
        "RELEASE_DEPLOYMENT_ACTIVE_SCOPE_CONFLICT",
        { deploymentId: String(active.id), status: String(active.status) },
      );
    }
    throw new ReleaseDeploymentError(
      "发布任务与现有记录冲突",
      409,
      "RELEASE_DEPLOYMENT_UNIQUE_CONFLICT",
    );
  }
}

export async function getReleaseDeployment(id: string): Promise<ReleaseDeploymentDetail> {
  const deploymentId = nonEmptyText(id, "deploymentId", 128);
  const deployment = await readDeploymentDetail(db, deploymentId);
  if (!deployment) {
    throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
  }
  return deployment;
}

/** Durable replay lookup used by the independent execution bridge after a
 * crash between creating the mature deployment and persisting its mapping. */
export async function findReleaseDeploymentByIdempotencyKey(
  value: string,
): Promise<ReleaseDeploymentDetail | null> {
  const idempotencyKey = nonEmptyText(value, "idempotencyKey", 200);
  const row = await db(RELEASE_DEPLOYMENT_TABLE).where({ idempotencyKey }).first();
  return row ? readDeploymentDetail(db, String(row.id)) : null;
}

/**
 * Controller-only artifact lookup. The record contains the opaque storage key
 * and integrity metadata, but never an object-storage credential or signed
 * URL. Adapters mint short-lived access only at the side-effect boundary.
 */
export async function getReleaseArtifact(id: string): Promise<ReleaseArtifactRecord> {
  const artifactId = nonEmptyText(id, "artifactId", 128);
  const artifact = await readArtifact(db, artifactId);
  if (!artifact) {
    throw new ReleaseDeploymentError("发布制品不存在", 404, "RELEASE_ARTIFACT_NOT_FOUND");
  }
  return artifact;
}

export interface ListReleaseDeploymentsInput {
  releaseId?: string | null;
  scope?: string | null;
  status?: ReleaseDeploymentStatus | null;
  pageNum?: number;
  pageSize?: number;
}

export interface ReleaseDeploymentListResult {
  items: ReleaseDeploymentRecord[];
  total: number;
  pageNum: number;
  pageSize: number;
}

export async function listReleaseDeployments(
  input: ListReleaseDeploymentsInput = {},
): Promise<ReleaseDeploymentListResult> {
  const releaseId = input.releaseId == null
    ? null
    : nonEmptyText(input.releaseId, "releaseId", 128);
  const scope = input.scope == null ? null : safeKey(input.scope, "scope");
  const status = input.status == null ? null : String(input.status) as ReleaseDeploymentStatus;
  if (status && !releaseDeploymentStatuses.includes(status)) {
    throw new ReleaseDeploymentError("发布状态格式无效", 400, "RELEASE_DEPLOYMENT_STATUS_INVALID");
  }
  const pageNum = input.pageNum == null ? 1 : positiveInteger(input.pageNum, "pageNum");
  const pageSize = input.pageSize == null ? 20 : positiveInteger(input.pageSize, "pageSize");
  if (pageSize > 100) {
    throw new ReleaseDeploymentError("pageSize 不能超过 100", 400, "RELEASE_DEPLOYMENT_PAGE_SIZE_INVALID");
  }

  const query = db(RELEASE_DEPLOYMENT_TABLE);
  if (releaseId) query.where({ releaseId });
  if (status) query.where({ status });
  if (scope) {
    // activeScope is cleared atomically on terminal transitions, while the
    // immutable plan retains the historical scope. The LIKE predicate is
    // portable across our SQLite and PostgreSQL deployments; safeKey rejects
    // SQL LIKE wildcard characters.
    query.andWhere(function scopedDeployment() {
      this.where("activeScope", scope)
        .orWhere("planJson", "like", `%\"scope\":${JSON.stringify(scope)}%`);
    });
  }

  const totalRow = await query.clone().clearSelect().clearOrder().count({ total: "*" }).first();
  const total = Number((totalRow as RawRow | undefined)?.total || 0);
  const rows = await query.clone()
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);
  return {
    items: (rows as RawRow[]).map(mapDeployment),
    total,
    pageNum,
    pageSize,
  };
}

export interface ListReleaseDeploymentEventsInput {
  deploymentId: string;
  afterSeq?: number;
  limit?: number;
}

export interface ReleaseDeploymentEventListResult {
  items: ReleaseDeploymentEventRecord[];
  nextSeq?: number;
}

export async function listReleaseDeploymentEvents(
  input: ListReleaseDeploymentEventsInput,
): Promise<ReleaseDeploymentEventListResult> {
  const deploymentId = nonEmptyText(input.deploymentId, "deploymentId", 128);
  const afterSeq = input.afterSeq == null ? 0 : Number(input.afterSeq);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new ReleaseDeploymentError("afterSeq 必须是非负整数", 400, "RELEASE_DEPLOYMENT_EVENT_CURSOR_INVALID");
  }
  const limit = input.limit == null ? 100 : positiveInteger(input.limit, "limit");
  if (limit > 200) {
    throw new ReleaseDeploymentError("limit 不能超过 200", 400, "RELEASE_DEPLOYMENT_EVENT_LIMIT_INVALID");
  }
  const exists = await db(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).select("id").first();
  if (!exists) {
    throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
  }
  const rows = await db(RELEASE_DEPLOYMENT_EVENT_TABLE)
    .where({ deploymentId })
    .andWhere("sequence", ">", afterSeq)
    .orderBy("sequence", "asc")
    .limit(limit);
  const items = (rows as RawRow[]).map(mapEvent);
  return {
    items,
    ...(items.length ? { nextSeq: items[items.length - 1].sequence } : {}),
  };
}

export interface ClaimNextReleaseDeploymentInput {
  workerId: string;
  leaseMs?: number;
  takeoverGraceMs?: number;
}

export interface ReleaseDeploymentClaim {
  deployment: ReleaseDeploymentDetail;
  checkpoint: ReleaseCheckpoint;
  revision: number;
  fencingToken: number;
  leaseExpiresAt: number;
}

function deploymentLeaseMs(value: unknown): number {
  if (value === undefined || value === null) return 60_000;
  const parsed = positiveInteger(value, "leaseMs");
  if (parsed < 5_000 || parsed > 60 * 60_000) {
    throw new ReleaseDeploymentError(
      "leaseMs 必须在 5000-3600000 之间",
      400,
      "RELEASE_DEPLOYMENT_LEASE_INVALID",
    );
  }
  return parsed;
}

function deploymentTakeoverGraceMs(value: unknown): number {
  if (value === undefined || value === null) return 20 * 60_000;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 60 * 60_000) {
    throw new ReleaseDeploymentError(
      "takeoverGraceMs 必须在 0-3600000 之间",
      400,
      "RELEASE_DEPLOYMENT_TAKEOVER_GRACE_INVALID",
    );
  }
  return parsed;
}

/**
 * Claim one queued deployment and issue a new fence.
 *
 * Expired active deployments are never automatically taken over: database
 * fencing cannot revoke an in-flight CLB/SSH request. They are first moved to
 * degraded_manual while retaining activeScope, then require the root-only
 * reconciliation workflow to prove the entire fleet before unlocking.
 */
export async function claimNextReleaseDeployment(
  input: ClaimNextReleaseDeploymentInput,
): Promise<ReleaseDeploymentClaim | null> {
  const workerId = safeKey(input.workerId, "workerId");
  const leaseMs = deploymentLeaseMs(input.leaseMs);
  const takeoverGraceMs = deploymentTakeoverGraceMs(input.takeoverGraceMs);
  const quarantined = await (await import("@/lib/releaseDeploymentReconciliation"))
    .quarantineOneExpiredReleaseDeployment({ takeoverGraceMs });
  if (quarantined) return null;
  const now = Date.now();
  const candidate = await db(RELEASE_DEPLOYMENT_TABLE)
    .where({ status: "queued" })
    .whereNotNull("activeScope")
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .first();
  if (!candidate) return null;
  const candidateArtifactRow = await db(RELEASE_ARTIFACT_TABLE)
    .where({ id: candidate.artifactId, status: "ready" })
    .first();
  if (!candidateArtifactRow) {
    throw new ReleaseDeploymentError(
      "发布控制器认领前无法读取已校验制品",
      409,
      "RELEASE_ARTIFACT_NOT_READY",
    );
  }
  await assertReleaseArtifactSchemaCurrent(mapArtifact(candidateArtifactRow));

  return (db as unknown as Knex).transaction(async (trx) => {
    const row = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: candidate.id }).forUpdate().first();
    if (!row) return null;
    const current = mapDeployment(row as RawRow);
    if (current.activeScope == null || current.status !== "queued") {
      return null;
    }
    const revision = current.revision + 1;
    const fencingToken = current.fencingToken + 1;
    const leaseExpiresAt = now + leaseMs;
    const checkpoint: ReleaseCheckpoint = {
      ...current.checkpoint,
      revision,
      updatedAt: now,
    };
    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: current.id, revision: current.revision, fencingToken: current.fencingToken })
      .update({
        status: "running",
        phase: current.checkpoint.phase,
        leaseOwner: workerId,
        leaseExpiresAt,
        startedAt: current.startedAt ?? now,
        fencingToken,
        checkpointJson: JSON.stringify(checkpoint),
        revision,
        updatedAt: now,
      });
    if (Number(updated || 0) !== 1) return null;
    await appendEvent(trx, {
      deploymentId: current.id,
      eventType: "deployment.claimed",
      phase: current.checkpoint.phase,
      actor: "orchestrator",
      message: "发布控制器已取得任务租约",
      payload: { workerId, fencingToken, leaseExpiresAt },
      now,
    });
    const deployment = await readDeploymentDetail(trx, current.id);
    if (!deployment) {
      throw new ReleaseDeploymentError("发布任务认领后无法读取", 500, "RELEASE_DEPLOYMENT_CLAIM_MISSING");
    }
    return { deployment, checkpoint: deployment.checkpoint, revision, fencingToken, leaseExpiresAt };
  });
}

/**
 * Cooperatively return an active deployment to the queue at a durable action
 * boundary. This is intentionally unavailable after cancellation or lease
 * expiry: ambiguous/forced stops must keep using root reconciliation.
 */
export async function handoffReleaseDeployment(input: {
  id: string;
  workerId: string;
  expectedRevision: number;
  fencingToken: number;
}): Promise<ReleaseDeploymentDetail> {
  const id = nonEmptyText(input.id, "deploymentId", 128);
  const workerId = safeKey(input.workerId, "workerId");
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
  const identity = await db(RELEASE_DEPLOYMENT_TABLE)
    .where({ id })
    .select("id", "releaseId")
    .first();
  if (!identity) {
    throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
  }

  return (db as unknown as Knex).transaction(async (trx) => {
    await trx(PLATFORM_RELEASE_TABLE)
      .where({ id: String(identity.releaseId) })
      .forUpdate()
      .first();
    const row = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id }).forUpdate().first();
    if (!row) {
      throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
    }
    if (String(row.phase || "").startsWith("maintenance-")) {
      throw new ReleaseDeploymentError(
        "离线维护任务只能由专用维护执行器推进",
        409,
        "RELEASE_MAINTENANCE_EXECUTOR_REQUIRED",
      );
    }
    const current = mapDeployment(row as RawRow);
    const now = Date.now();
    if (current.status !== "running"
      || current.activeScope == null
      || current.cancelRequestedAt !== null
      || current.leaseOwner !== workerId
      || current.leaseExpiresAt == null
      || current.leaseExpiresAt <= now
      || current.revision !== expectedRevision
      || current.fencingToken !== fencingToken) {
      throw new ReleaseDeploymentError(
        "发布控制器无法在当前状态安全交接任务",
        409,
        "RELEASE_DEPLOYMENT_HANDOFF_CONFLICT",
      );
    }

    const revision = expectedRevision + 1;
    const checkpoint: ReleaseCheckpoint = {
      ...current.checkpoint,
      revision,
      updatedAt: now,
    };
    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({
        id,
        status: "running",
        revision: expectedRevision,
        fencingToken,
        leaseOwner: workerId,
      })
      .andWhere("leaseExpiresAt", ">", now)
      .whereNull("cancelRequestedAt")
      .whereNotNull("activeScope")
      .update({
        status: "queued",
        phase: checkpoint.phase,
        checkpointJson: JSON.stringify(checkpoint),
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: fencingToken + 1,
        updatedAt: now,
        revision,
      });
    if (Number(updated || 0) !== 1) {
      throw new ReleaseDeploymentError(
        "发布控制器交接 CAS 失败",
        409,
        "RELEASE_DEPLOYMENT_HANDOFF_CONFLICT",
      );
    }
    await appendEvent(trx, {
      deploymentId: id,
      eventType: "deployment.handed_off",
      phase: checkpoint.phase,
      actor: "orchestrator",
      message: "发布控制器已在安全边界交接任务",
      payload: {
        previousWorkerId: workerId,
        previousFencingToken: fencingToken,
        checkpointRevision: revision,
      },
      now,
    });
    const deployment = await readDeploymentDetail(trx, id);
    if (!deployment) {
      throw new ReleaseDeploymentError(
        "发布任务交接后无法读取",
        500,
        "RELEASE_DEPLOYMENT_HANDOFF_MISSING",
      );
    }
    return deployment;
  });
}

export async function renewReleaseDeploymentLease(input: {
  id: string;
  workerId: string;
  expectedRevision: number;
  fencingToken: number;
  leaseMs?: number;
}): Promise<ReleaseDeploymentClaim> {
  const id = nonEmptyText(input.id, "deploymentId", 128);
  const workerId = safeKey(input.workerId, "workerId");
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
  const now = Date.now();
  const leaseExpiresAt = now + deploymentLeaseMs(input.leaseMs);
  const updated = await db(RELEASE_DEPLOYMENT_TABLE)
    .where({ id, leaseOwner: workerId, revision: expectedRevision, fencingToken })
    .whereIn("status", ["running", "cancelling", "rolling_back"])
    .whereNot("phase", "like", "maintenance-%")
    .whereNotNull("activeScope")
    .andWhere("leaseExpiresAt", ">", now)
    // Heartbeats deliberately do not advance the deployment/checkpoint CAS.
    // Otherwise a successful renewal would make the controller's next
    // checkpoint save stale even though no release state changed.
    .update({ leaseExpiresAt, updatedAt: now });
  if (Number(updated || 0) !== 1) {
    throw new ReleaseDeploymentError(
      "发布控制器租约续期 CAS 失败",
      409,
      "RELEASE_DEPLOYMENT_LEASE_CONFLICT",
    );
  }
  const deployment = await getReleaseDeployment(id);
  return {
    deployment,
    checkpoint: deployment.checkpoint,
    revision: expectedRevision,
    fencingToken,
    leaseExpiresAt,
  };
}

export interface CancelReleaseDeploymentInput {
  id: string;
  revision: number;
  reason: string;
  operatorUserId?: number | null;
  requestId?: string | null;
}

function throwDeploymentRevisionConflict(expectedRevision: number, currentRevision: number): never {
  throw new ReleaseDeploymentError(
    "发布任务已被其他请求更新",
    409,
    "RELEASE_DEPLOYMENT_REVISION_CONFLICT",
    { expectedRevision, currentRevision },
  );
}

export async function cancelReleaseDeployment(
  input: CancelReleaseDeploymentInput,
): Promise<ReleaseDeploymentDetail> {
  const deploymentId = nonEmptyText(input.id, "deploymentId", 128);
  const expectedRevision = positiveInteger(input.revision, "revision");
  const reason = nonEmptyText(input.reason, "reason", 500);
  const operatorUserId = normalizeUserId(input.operatorUserId);
  const requestId = normalizeOptionalText(input.requestId, 200);

  // Resolve the release id before entering the transaction so every workflow
  // that needs both rows can lock release -> deployment in the same order.
  const identity = await db(RELEASE_DEPLOYMENT_TABLE)
    .where({ id: deploymentId })
    .select("id", "releaseId")
    .first();
  if (!identity) {
    throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
  }

  return (db as unknown as Knex).transaction(async (trx) => {
    const release = await trx(PLATFORM_RELEASE_TABLE)
      .where({ id: String(identity.releaseId) })
      .forUpdate()
      .first();
    const row = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: deploymentId })
      .forUpdate()
      .first();
    if (!row) {
      throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
    }
    if (!release || String(row.releaseId) !== String(identity.releaseId)) {
      throw new ReleaseDeploymentError("发布任务关联版本不存在", 409, "RELEASE_DEPLOYMENT_RELEASE_MISSING");
    }
    const current = mapDeployment(row as RawRow);

    if (current.status === "cancelling") {
      // A client may retry either with the post-transition revision returned
      // by the first call or with the original revision when the response was
      // lost. Neither replay creates a second event.
      if (expectedRevision === current.revision || expectedRevision + 1 === current.revision) {
        const replay = await readDeploymentDetail(trx, deploymentId);
        if (!replay) {
          throw new ReleaseDeploymentError("发布任务取消状态无法读取", 500, "RELEASE_DEPLOYMENT_UPDATE_MISSING");
        }
        return replay;
      }
      throwDeploymentRevisionConflict(expectedRevision, current.revision);
    }
    if (current.revision !== expectedRevision) {
      throwDeploymentRevisionConflict(expectedRevision, current.revision);
    }
    if (current.status === "rolling_back") {
      throw new ReleaseDeploymentError(
        "发布任务正在回滚，不能取消",
        409,
        "RELEASE_DEPLOYMENT_CANCEL_ROLLBACK_CONFLICT",
      );
    }
    if (!["queued", "running"].includes(current.status)) {
      throw new ReleaseDeploymentError(
        "当前发布状态不能取消",
        409,
        "RELEASE_DEPLOYMENT_CANCEL_STATUS_CONFLICT",
        { deploymentStatus: current.status },
      );
    }

    const now = Date.now();
    if (current.status === "running") {
      const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
        .where({ id: deploymentId, revision: expectedRevision, status: "running" })
        .update({
          status: "cancelling",
          phase: "cancelling",
          cancelRequestedAt: now,
          cancelRequestedByUserId: operatorUserId,
          cancelReason: reason,
          updatedAt: now,
          revision: expectedRevision + 1,
        });
      if (Number(updated || 0) !== 1) {
        throw new ReleaseDeploymentError(
          "发布任务取消写入冲突",
          409,
          "RELEASE_DEPLOYMENT_CANCEL_WRITE_CONFLICT",
        );
      }
      await appendEvent(trx, {
        deploymentId,
        eventType: "deployment.cancel_requested",
        phase: "cancelling",
        actor: "operator",
        actorUserId: operatorUserId,
        requestId,
        message: "管理员请求停止滚动发布",
        payload: { reason },
        now,
      });
    } else {
      const checkpoint: ReleaseCheckpoint = {
        ...current.checkpoint,
        status: "failed",
        phase: "failed",
        currentNodeId: null,
        error: {
          code: "RELEASE_CANCELLED",
          message: "发布在执行前由管理员取消",
          phase: "failed",
          nodeId: null,
          at: now,
        },
        revision: Math.max(1, Number(current.checkpoint.revision || 0) + 1),
        updatedAt: now,
      };
      const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
        .where({ id: deploymentId, revision: expectedRevision, status: "queued" })
        .update({
          status: "cancelled",
          phase: "cancelled",
          activeScope: null,
          checkpointJson: JSON.stringify(checkpoint),
          completedTargetCount: current.targetCount,
          cancelRequestedAt: now,
          cancelRequestedByUserId: operatorUserId,
          cancelReason: reason,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
          revision: expectedRevision + 1,
        });
      if (Number(updated || 0) !== 1) {
        throw new ReleaseDeploymentError(
          "发布任务取消写入冲突",
          409,
          "RELEASE_DEPLOYMENT_CANCEL_WRITE_CONFLICT",
        );
      }
      await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
        .where({ deploymentId, status: "pending" })
        .update({ status: "cancelled", completedAt: now, updatedAt: now, revision: trx.raw('"revision" + 1') });

      const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
        .where({ id: current.releaseId, status: "deploying", revision: Number(release.revision) })
        .update({
          status: "draft",
          updatedByUserId: operatorUserId,
          updatedAt: now,
          revision: Number(release.revision) + 1,
        });
      if (Number(releaseUpdated || 0) !== 1) {
        throw new ReleaseDeploymentError(
          "版本状态已变化，无法安全取消发布",
          409,
          "RELEASE_DEPLOYMENT_RELEASE_WRITE_CONFLICT",
        );
      }
      await appendEvent(trx, {
        deploymentId,
        eventType: "deployment.cancelled",
        phase: "cancelled",
        actor: "operator",
        actorUserId: operatorUserId,
        requestId,
        message: "滚动发布已在执行前取消",
        payload: { reason },
        now,
      });
    }

    const deployment = await readDeploymentDetail(trx, deploymentId);
    if (!deployment) {
      throw new ReleaseDeploymentError("发布任务取消后无法读取", 500, "RELEASE_DEPLOYMENT_UPDATE_MISSING");
    }
    return deployment;
  });
}

export interface SaveReleaseDeploymentCheckpointInput {
  id: string;
  workerId: string;
  expectedRevision: number;
  fencingToken: number;
  checkpoint: ReleaseCheckpoint;
  operatorUserId?: number | null;
  requestId?: string | null;
}

/**
 * Durable ReleaseStore write boundary used by the rolling controller.
 *
 * The deployment revision and fencing token are checked in the same write.
 * A controller that lost its lease can therefore never overwrite a newer
 * owner's checkpoint, even if it completes an old network request late.
 */
export async function saveReleaseDeploymentCheckpoint(
  input: SaveReleaseDeploymentCheckpointInput,
): Promise<ReleaseCheckpoint> {
  const deploymentId = nonEmptyText(input.id, "deploymentId", 128);
  const workerId = safeKey(input.workerId, "workerId");
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
  const operatorUserId = normalizeUserId(input.operatorUserId);
  const requestId = normalizeOptionalText(input.requestId, 200);
  const checkpoint = input.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object" || checkpoint.operationId !== deploymentId) {
    throw new ReleaseDeploymentError(
      "checkpoint 与发布任务不匹配",
      400,
      "RELEASE_DEPLOYMENT_CHECKPOINT_INVALID",
    );
  }
  if (!["running", "succeeded", "failed"].includes(String(checkpoint.status))) {
    throw new ReleaseDeploymentError("checkpoint.status 无效", 400, "RELEASE_DEPLOYMENT_CHECKPOINT_INVALID");
  }
  if (checkpoint.status === "succeeded" && checkpoint.publicSmokeComplete !== true) {
    throw new ReleaseDeploymentError(
      "公网冒烟验证完成前不能标记发布成功",
      409,
      "RELEASE_DEPLOYMENT_PUBLIC_SMOKE_REQUIRED",
    );
  }

  const identity = await db(RELEASE_DEPLOYMENT_TABLE)
    .where({ id: deploymentId })
    .select("id", "releaseId")
    .first();
  if (!identity) {
    throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
  }

  return (db as unknown as Knex).transaction(async (trx) => {
    // A successful terminal checkpoint changes the channel's published
    // baseline while releasing activeScope. Serialize that pair with start's
    // preview revalidation, and acquire the fleet lock before any row lock so
    // the lock order remains global -> release -> deployment everywhere.
    if (checkpoint.status === "succeeded") {
      await acquireReleaseMutationLock(trx);
    }
    const release = await trx(PLATFORM_RELEASE_TABLE)
      .where({ id: String(identity.releaseId) })
      .forUpdate()
      .first();
    const row = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: deploymentId })
      .forUpdate()
      .first();
    if (!row) throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
    if (String(row.phase || "").startsWith("maintenance-")) {
      throw new ReleaseDeploymentError(
        "离线维护任务只能由专用维护执行器推进",
        409,
        "RELEASE_MAINTENANCE_EXECUTOR_REQUIRED",
      );
    }
    if (!release || String(row.releaseId) !== String(identity.releaseId)) {
      throw new ReleaseDeploymentError("发布任务关联版本不存在", 409, "RELEASE_DEPLOYMENT_RELEASE_MISSING");
    }
    const current = mapDeployment(row as RawRow);
    if (current.revision !== expectedRevision) {
      throwDeploymentRevisionConflict(expectedRevision, current.revision);
    }
    if (current.fencingToken !== fencingToken) {
      throw new ReleaseDeploymentError(
        "发布控制器租约已失效",
        409,
        "RELEASE_DEPLOYMENT_FENCING_CONFLICT",
        { expectedFencingToken: fencingToken, currentFencingToken: current.fencingToken },
      );
    }
    if (current.leaseOwner !== workerId || current.leaseExpiresAt == null || current.leaseExpiresAt <= Date.now()) {
      throw new ReleaseDeploymentError(
        "发布控制器租约不存在或已经过期",
        409,
        "RELEASE_DEPLOYMENT_LEASE_CONFLICT",
      );
    }
    if (!["queued", "running", "cancelling", "rolling_back"].includes(current.status)) {
      throw new ReleaseDeploymentError(
        "终态发布任务不能再写入 checkpoint",
        409,
        "RELEASE_DEPLOYMENT_CHECKPOINT_STATUS_CONFLICT",
        { deploymentStatus: current.status },
      );
    }
    const artifactRow = await trx(RELEASE_ARTIFACT_TABLE)
      .where({ id: current.artifactId })
      .select("sha256", "manifestJson")
      .first();
    const previousArtifactRow = current.previousArtifactId
      ? await trx(RELEASE_ARTIFACT_TABLE)
        .where({ id: current.previousArtifactId })
        .select("id", "sha256", "manifestJson")
        .first()
      : null;
    const expectedManifest = artifactRow
      ? parseReleaseArtifactManifest(parseObject(artifactRow.manifestJson))
      : null;
    const expectedPreviousManifest = previousArtifactRow
      ? parseReleaseArtifactManifest(
        parseObject(previousArtifactRow.manifestJson),
      )
      : null;
    const checkpointArtifactSchemaMode =
      checkpoint.artifact.schemaMode ?? checkpoint.schemaMode;
    const checkpointArtifactSchemaCompatibility =
      checkpoint.artifact.schemaCompatibility
      ?? defaultReleaseSchemaCompatibility(checkpoint.artifact.schemaVersion);
    const expectedArtifactSchemaCompatibility =
      expectedManifest?.schemaCompatibility
      ?? (
        expectedManifest
          ? defaultReleaseSchemaCompatibility(expectedManifest.schemaVersion)
          : null
      );
    const checkpointPreviousSchemaCompatibility =
      checkpoint.previousArtifact?.schemaCompatibility
      ?? (
        checkpoint.previousArtifact
          ? defaultReleaseSchemaCompatibility(
            checkpoint.previousArtifact.schemaVersion,
          )
          : null
      );
    const expectedPreviousSchemaCompatibility =
      expectedPreviousManifest?.schemaCompatibility
      ?? (
        expectedPreviousManifest
          ? defaultReleaseSchemaCompatibility(
            expectedPreviousManifest.schemaVersion,
          )
          : null
      );
    if (
      checkpoint.artifact?.id !== current.artifactId
      || !expectedManifest
      || checkpoint.artifact.releaseId !== expectedManifest.releaseId
      || checkpoint.artifact.sha256 !== String(artifactRow?.sha256 || "")
      || checkpoint.artifact.sourceCommit !== expectedManifest.sourceCommit
      || checkpoint.artifact.schemaVersion !== expectedManifest.schemaVersion
      || checkpoint.artifact.workerProtocolVersion
        !== expectedManifest.workerProtocolVersion
      || JSON.stringify(checkpoint.artifact.runtimeCapabilities ?? [])
        !== JSON.stringify(expectedManifest.runtimeCapabilities)
      || checkpoint.schemaMode !== expectedManifest.schemaMode
      || checkpointArtifactSchemaMode !== expectedManifest.schemaMode
      || JSON.stringify(checkpointArtifactSchemaCompatibility)
        !== JSON.stringify(expectedArtifactSchemaCompatibility)
      || JSON.stringify(checkpoint.schemaCompatibility ?? null)
        !== JSON.stringify(current.plan.schemaCompatibility ?? null)
      || checkpoint.previousArtifact?.id !== current.previousArtifactId
      || checkpoint.previousArtifact?.sha256
        !== String(previousArtifactRow?.sha256 || "")
      || !expectedPreviousManifest
      || checkpoint.previousArtifact.releaseId
        !== expectedPreviousManifest.releaseId
      || checkpoint.previousArtifact.sourceCommit
        !== expectedPreviousManifest.sourceCommit
      || checkpoint.previousArtifact.schemaVersion
        !== expectedPreviousManifest.schemaVersion
      || checkpoint.previousArtifact.schemaMode
        !== expectedPreviousManifest.schemaMode
      || JSON.stringify(checkpointPreviousSchemaCompatibility)
        !== JSON.stringify(expectedPreviousSchemaCompatibility)
      || checkpoint.previousArtifact.workerProtocolVersion
        !== expectedPreviousManifest.workerProtocolVersion
      || JSON.stringify(checkpoint.previousArtifact.runtimeCapabilities ?? [])
        !== JSON.stringify(expectedPreviousManifest.runtimeCapabilities)
      || JSON.stringify(checkpoint.artifact.deployment ?? null)
        !== JSON.stringify(expectedManifest.deployment ?? null)
      || (checkpoint.artifact.deploymentMode ?? "archive-systemd")
        !== (expectedManifest.deployment ? "container-image" : "archive-systemd")
      || (checkpoint.artifact.imageDigest ?? null)
        !== (expectedManifest.deployment?.imageDigest ?? null)
      || JSON.stringify(checkpoint.previousArtifact.deployment ?? null)
        !== JSON.stringify(expectedPreviousManifest.deployment ?? null)
      || (checkpoint.previousArtifact.deploymentMode ?? "archive-systemd")
        !== (expectedPreviousManifest.deployment ? "container-image" : "archive-systemd")
      || (checkpoint.previousArtifact.imageDigest ?? null)
        !== (expectedPreviousManifest.deployment?.imageDigest ?? null)
    ) {
      throw new ReleaseDeploymentError(
        "checkpoint 不可变发布参数与任务不匹配",
        409,
        "RELEASE_DEPLOYMENT_CHECKPOINT_MISMATCH",
      );
    }
    if (checkpoint.status === "succeeded") {
      const plannedKeys = current.plan.targets
        .filter((target) => target.role === "api")
        .map((target) => target.key)
        .sort();
      const plannedWorkerKeys = current.plan.targets
        .filter((target) => target.role === "worker")
        .map((target) => target.key)
        .sort();
      const checkpointKeys = [...checkpoint.nodeOrder].sort();
      const allNodesComplete = checkpoint.nodeOrder.length >= 2
        && plannedKeys.length === checkpointKeys.length
        && plannedKeys.every((key, index) => key === checkpointKeys[index])
        && checkpoint.nodeOrder.every((nodeId) => {
          const node = checkpoint.nodes[nodeId];
          return node?.nodeId === nodeId
            && node.preflightComplete
            && node.staged
            && node.directReady
            && node.weightRestored
            && node.baked
            && node.completed
            && !node.isolated;
        });
      const checkpointWorkerKeys = [...(checkpoint.workerOrder || [])].sort();
      const allWorkersComplete = plannedWorkerKeys.length === checkpointWorkerKeys.length
        && plannedWorkerKeys.every((key, index) => key === checkpointWorkerKeys[index])
        && checkpointWorkerKeys.every((nodeId) => {
          const worker = checkpoint.workers?.[nodeId];
          return worker?.nodeId === nodeId
            && worker.preflightComplete
            && worker.staged
            && worker.artifactReady
            && worker.resumed
            && worker.serving
            && worker.completed
            && !worker.isolated;
        });
      const redisCutoverRequired = checkpoint.artifact.runtimeCapabilities
        ?.includes("redis-rate-limit-v1") === true;
      const redisCutoverComplete = !redisCutoverRequired || (
        checkpoint.redisCutoverScheduled === true
        && (checkpoint.redisCutoverState === "scheduled" || checkpoint.redisCutoverState === "active")
        && Number.isSafeInteger(checkpoint.redisCutoverAtMs)
        && (checkpoint.redisCutoverAtMs ?? 0) > 0
        && typeof checkpoint.redisRuntimeFingerprint === "string"
        && /^[a-f0-9]{64}$/.test(checkpoint.redisRuntimeFingerprint)
      );
      if (!checkpoint.preflightComplete
        || !checkpoint.stageComplete
        || checkpoint.workerPreflightComplete !== true
        || checkpoint.workerStageComplete !== true
        || checkpoint.workerRollingComplete !== true
        || !checkpoint.publicSmokeComplete
        || checkpoint.currentNodeId !== null
        || checkpoint.error !== null
        || checkpoint.manualInterventionRequired
        || !redisCutoverComplete
        || !allNodesComplete
        || !allWorkersComplete) {
        throw new ReleaseDeploymentError(
          "所有节点完成回挂、观察和公网冒烟验证前不能正式发布",
          409,
          "RELEASE_DEPLOYMENT_SUCCESS_INCOMPLETE",
        );
      }
    }

    const now = Date.now();
    const savedCheckpoint: ReleaseCheckpoint = {
      ...checkpoint,
      revision: expectedRevision + 1,
      createdAt: Number(current.checkpoint.createdAt || checkpoint.createdAt || now),
      updatedAt: now,
    };
    // Reject cyclic/non-JSON data at the persistence boundary.
    let checkpointJson: string;
    try {
      checkpointJson = JSON.stringify(savedCheckpoint);
    } catch {
      throw new ReleaseDeploymentError("checkpoint 不是可序列化 JSON", 400, "RELEASE_DEPLOYMENT_CHECKPOINT_INVALID");
    }

    const cancelledByController = savedCheckpoint.status === "failed"
      && savedCheckpoint.error?.code === "RELEASE_CANCELLED";
    let nextStatus: ReleaseDeploymentStatus;
    // `manualInterventionRequired` may be raised and persisted while the
    // controller is still containing a rollback failure. Keep its lease and
    // production lock alive until it writes the final failed checkpoint;
    // terminalizing here would revoke the lease in the middle of fail() and
    // prevent the authoritative error/event checkpoint from being saved.
    if (savedCheckpoint.manualInterventionRequired && savedCheckpoint.status === "failed") {
      nextStatus = "degraded_manual";
    }
    else if (cancelledByController) nextStatus = "cancelled";
    else if (savedCheckpoint.status === "succeeded") nextStatus = "succeeded";
    else if (savedCheckpoint.status === "failed") nextStatus = "failed";
    else if (current.status === "cancelling") nextStatus = "cancelling";
    else if (savedCheckpoint.phase === "rollback") nextStatus = "rolling_back";
    else nextStatus = "running";
    const terminal = ["succeeded", "failed", "cancelled", "degraded_manual"].includes(nextStatus);
    // A degraded/manual incident is terminal for the worker lease but must
    // keep the production-scope uniqueness lock. Releasing activeScope while
    // a bad node is isolated would allow another rollout to start on a mixed
    // or capacity-reduced fleet.
    const retainScopeLock = nextStatus === "degraded_manual";
    const nextPhase = nextStatus === "cancelled"
      ? "cancelled"
      : current.status === "cancelling" && !terminal
      ? "cancelling"
      : savedCheckpoint.phase;

    const targets = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
      .where({ deploymentId })
      .orderBy("ordinal", "asc");
    const targetByKey = new Map((targets as RawRow[]).map((target) => [String(target.targetKey), target]));
    if (nextStatus === "succeeded") {
      await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).where({ deploymentId }).update({
        status: "succeeded",
        observedArtifactId: current.artifactId,
        observedVersion: savedCheckpoint.artifact.version,
        verifiedAt: now,
        completedAt: now,
        errorCode: null,
        safeError: null,
        updatedAt: now,
        revision: trx.raw('"revision" + 1'),
      });
    } else if (nextStatus === "cancelled") {
      for (const target of targets as RawRow[]) {
        const targetKey = String(target.targetKey);
        const node = savedCheckpoint.nodes?.[targetKey];
        const worker = savedCheckpoint.workers?.[targetKey];
        // A touched node is only reported rolled_back after the controller
        // proved the previous artifact directly and returned it to service.
        // Untouched/staged-only nodes are simply cancelled.
        const rolledBack = String(target.role) === "worker"
          ? worker?.rollbackVerified && worker.resumed && worker.serving && !worker.isolated
          : node?.rollbackVerified && node.weightRestored && !node.weightZero && !node.isolated;
        const targetStatus: ReleaseDeploymentTargetStatus = rolledBack
          ? "rolled_back"
          : "cancelled";
        await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).where({ id: String(target.id) }).update({
          status: targetStatus,
          observedArtifactId: null,
          observedVersion: null,
          verifiedAt: targetStatus === "rolled_back" ? now : target.verifiedAt,
          completedAt: now,
          errorCode: "RELEASE_CANCELLED",
          safeError: savedCheckpoint.error?.message ?? "滚动发布已取消",
          updatedAt: now,
          revision: Number(target.revision) + 1,
        });
      }
    } else if (nextStatus === "failed" || nextStatus === "degraded_manual") {
      await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
        .where({ deploymentId })
        .whereIn("status", ["pending", "draining", "deploying", "verifying", "rolling_back"])
        .update({
          status: "failed",
          completedAt: now,
          errorCode: savedCheckpoint.error?.code ?? "RELEASE_FAILED",
          safeError: savedCheckpoint.error?.message ?? "滚动发布未成功完成",
          updatedAt: now,
          revision: trx.raw('"revision" + 1'),
        });
    } else {
      for (const [targetKey, node] of Object.entries(savedCheckpoint.nodes || {})) {
        const target = targetByKey.get(targetKey);
        if (!target) continue;
        let targetStatus: ReleaseDeploymentTargetStatus = String(target.status) as ReleaseDeploymentTargetStatus;
        const rollbackServing = node.rollbackVerified
          && node.weightRestored
          && !node.weightZero
          && !node.isolated;
        const rollbackTouched = node.weightZeroAttempted
          || node.drainStarted
          || node.activationAttempted
          || node.activated
          || node.completed
          || node.rolledBack;
        if (rollbackServing) targetStatus = "rolled_back";
        else if (savedCheckpoint.phase === "rollback" && rollbackTouched) targetStatus = "rolling_back";
        else if (node.completed) targetStatus = "succeeded";
        else if (node.directReady || node.activated) targetStatus = "verifying";
        else if (node.weightZeroAttempted || node.drained) targetStatus = "deploying";
        else if (node.othersHealthyConfirmed) targetStatus = "draining";
        await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).where({ id: String(target.id) }).update({
          status: targetStatus,
          observedArtifactId: targetStatus === "succeeded" ? current.artifactId : target.observedArtifactId,
          observedVersion: targetStatus === "succeeded" ? savedCheckpoint.artifact.version : target.observedVersion,
          verifiedAt: targetStatus === "succeeded" ? now : target.verifiedAt,
          completedAt: ["succeeded", "rolled_back"].includes(targetStatus) ? now : null,
          updatedAt: now,
          revision: Number(target.revision) + 1,
        });
      }
      for (const [targetKey, worker] of Object.entries(savedCheckpoint.workers || {})) {
        const target = targetByKey.get(targetKey);
        if (!target) continue;
        let targetStatus: ReleaseDeploymentTargetStatus = String(target.status) as ReleaseDeploymentTargetStatus;
        const rollbackServing = worker.rollbackVerified
          && worker.resumed
          && worker.serving
          && !worker.isolated;
        const rollbackTouched = worker.drainRequested
          || worker.activationAttempted
          || worker.activated
          || worker.completed
          || worker.rolledBack;
        if (rollbackServing) targetStatus = "rolled_back";
        else if (savedCheckpoint.phase === "rollback" && rollbackTouched) targetStatus = "rolling_back";
        else if (worker.completed) targetStatus = "succeeded";
        else if (worker.artifactReady || worker.resumed) targetStatus = "verifying";
        else if (worker.activationAttempted || worker.activated) targetStatus = "deploying";
        else if (worker.capacityConfirmed || worker.drainRequested || worker.drained) targetStatus = "draining";
        await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).where({ id: String(target.id) }).update({
          status: targetStatus,
          observedArtifactId: targetStatus === "succeeded" ? current.artifactId : target.observedArtifactId,
          observedVersion: targetStatus === "succeeded" ? savedCheckpoint.artifact.version : target.observedVersion,
          verifiedAt: targetStatus === "succeeded" ? now : target.verifiedAt,
          completedAt: ["succeeded", "rolled_back"].includes(targetStatus) ? now : null,
          updatedAt: now,
          revision: Number(target.revision) + 1,
        });
      }
    }

    const progressRows = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).where({ deploymentId });
    const progress = (progressRows as RawRow[]).map((target) => String(target.status));
    const completedTargetCount = progress.filter((status) =>
      ["succeeded", "failed", "skipped", "cancelled", "rolled_back"].includes(status)).length;
    const succeededTargetCount = progress.filter((status) => status === "succeeded").length;
    const failedTargetCount = progress.filter((status) => status === "failed").length;

    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: deploymentId, revision: expectedRevision, fencingToken, leaseOwner: workerId })
      .andWhere("leaseExpiresAt", ">", now)
      .update({
        status: nextStatus,
        phase: nextPhase,
        checkpointJson,
        manualInterventionRequired: savedCheckpoint.manualInterventionRequired ? 1 : 0,
        activeScope: terminal && !retainScopeLock ? null : current.activeScope,
        completedTargetCount,
        succeededTargetCount,
        failedTargetCount,
        startedAt: current.startedAt ?? now,
        completedAt: terminal ? now : null,
        leaseOwner: terminal ? null : current.leaseOwner,
        leaseExpiresAt: terminal ? null : current.leaseExpiresAt,
        errorCode: savedCheckpoint.error?.code ?? null,
        safeError: savedCheckpoint.error?.message ?? null,
        updatedAt: now,
        revision: expectedRevision + 1,
      });
    if (Number(updated || 0) !== 1) {
      throw new ReleaseDeploymentError(
        "checkpoint 写入时 CAS 或 fencing token 已变化",
        409,
        "RELEASE_DEPLOYMENT_CHECKPOINT_WRITE_CONFLICT",
      );
    }

    const attributionUserId = operatorUserId ?? current.requestedByUserId;
    if (nextStatus === "succeeded") {
      const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
        .where({ id: current.releaseId, status: "deploying", revision: Number(release.revision) })
        .update({
          status: "published",
          publishedAt: now,
          publishedByUserId: attributionUserId,
          updatedByUserId: attributionUserId,
          updatedAt: now,
          revision: Number(release.revision) + 1,
        });
      if (Number(releaseUpdated || 0) !== 1) {
        throw new ReleaseDeploymentError("版本无法安全标记为已发布", 409, "RELEASE_DEPLOYMENT_RELEASE_WRITE_CONFLICT");
      }
    } else if (nextStatus === "failed" || nextStatus === "cancelled") {
      const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
        .where({ id: current.releaseId, status: "deploying", revision: Number(release.revision) })
        .update({
          status: "draft",
          updatedByUserId: attributionUserId,
          updatedAt: now,
          revision: Number(release.revision) + 1,
        });
      if (Number(releaseUpdated || 0) !== 1) {
        throw new ReleaseDeploymentError("版本无法安全恢复为草稿", 409, "RELEASE_DEPLOYMENT_RELEASE_WRITE_CONFLICT");
      }
    }

    const oldEvents = Array.isArray(current.checkpoint.events) ? current.checkpoint.events : [];
    const oldControllerSequence = oldEvents.reduce((maximum, event) => Math.max(maximum, Number(event.sequence || 0)), 0);
    const newEvents = (Array.isArray(savedCheckpoint.events) ? savedCheckpoint.events : [])
      .filter((event) => Number(event.sequence) > oldControllerSequence)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
    if (newEvents.length) {
      for (const event of newEvents) {
        const target = event.nodeId ? targetByKey.get(event.nodeId) : null;
        await appendEvent(trx, {
          deploymentId,
          targetId: target ? String(target.id) : null,
          eventType: event.type,
          phase: event.phase,
          actor: "orchestrator",
          actorUserId: operatorUserId,
          requestId,
          message: `发布控制器：${event.type}`,
          payload: {
            controllerSequence: event.sequence,
            nodeId: event.nodeId,
            ...(event.observations ? { observations: event.observations } : {}),
          },
          now: Number(event.at || now),
        });
      }
    } else {
      await appendEvent(trx, {
        deploymentId,
        eventType: "deployment.checkpoint_saved",
        phase: nextPhase,
        actor: "orchestrator",
        actorUserId: operatorUserId,
        requestId,
        message: "发布控制器断点已保存",
        payload: { checkpointRevision: savedCheckpoint.revision, status: nextStatus },
        now,
      });
    }
    if (nextStatus === "cancelled") {
      await appendEvent(trx, {
        deploymentId,
        eventType: "deployment.cancelled",
        phase: "cancelled",
        actor: "orchestrator",
        actorUserId: operatorUserId,
        requestId,
        message: "滚动发布已安全停止并完成必要回切",
        payload: {
          reason: current.cancelReason,
          rolledBackTargets: progress.filter((status) => status === "rolled_back").length,
          cancelledTargets: progress.filter((status) => status === "cancelled").length,
        },
        now,
      });
    }
    return savedCheckpoint;
  });
}
