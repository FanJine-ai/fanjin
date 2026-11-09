import crypto from "node:crypto";
import type { Knex } from "knex";

import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import {
  RELEASE_ARTIFACT_TABLE,
  RELEASE_DEPLOYMENT_EVENT_TABLE,
  RELEASE_DEPLOYMENT_TABLE,
  RELEASE_DEPLOYMENT_TARGET_TABLE,
} from "@/lib/migrations/releaseDeploymentOrchestration";
import {
  RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
} from "@/lib/migrations/releaseArtifactGeneration";
import type {
  ObjectStorageGenerationSnapshot,
} from "@/lib/objectStorage";
import type {
  ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import {
  DATABASE_MIGRATIONS,
  inspectDatabaseMigrations,
} from "@/lib/databaseMigrations";
import {
  RELEASE_ARTIFACT_GENERATION_MIGRATION_CHECKSUM,
  RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY,
} from "@/lib/migrationCompatibilityCatalog";
import {
  acquireReleaseMutationLock,
  assertReleaseArtifactSchemaCurrent,
  type ReleaseArtifactManifestTarget,
  type ReleaseArtifactRecord,
  type ReleaseDeploymentPlan,
} from "@/lib/releaseDeployments";
import {
  defaultReleaseSchemaCompatibility,
  sameReleaseSchemaMigrationEdge,
} from "@/lib/releaseSchemaCompatibility";
import {
  consumeStepUpProof,
  StepUpError,
} from "@/lib/stepUpAuth";
import {
  releaseBaselineConfirmation,
  releaseBaselineInventoryDigest,
  type ReleaseBaselineInventoryDescriptor,
} from "@/lib/releaseBaselineInventory";
import type { ReleaseReconciliationEvidence } from "@/lib/releaseDeploymentReconciliation";
import type {
  CachedLegacyBridgeArtifactEvidence,
  CachedReleaseArtifactEvidence,
} from "@/release-controller/artifactAttestation";
import type {
  ReleaseArtifact,
  ReleaseCheckpoint,
  ReleaseNodeCheckpoint,
  ReleaseWorkerCheckpoint,
} from "@/release-controller/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CHANNELS = new Set(["stable", "beta", "internal"]);
const BOOTSTRAP_MODE = "verified-baseline-v1" as const;
const LEGACY_PROVENANCE_UPGRADE_MODE =
  "legacy-baseline-provenance-upgrade-v1" as const;
const DEFAULT_CONFIRMATION_INTERVAL_MS = 2_000;
const MAX_CONFIRMATION_INTERVAL_MS = 60_000;
const PROVENANCE_IDEMPOTENCY_PREFIX = "baseline-provenance:";

type BootstrapDb = Knex | Knex.Transaction;
type RawRow = Record<string, any>;

export {
  releaseBaselineConfirmation,
  releaseBaselineInventoryDigest,
  type ReleaseBaselineInventoryDescriptor,
} from "@/lib/releaseBaselineInventory";

export interface ReleaseBaselineBootstrapInput {
  releaseId: string;
  artifactId: string;
  releaseRevision: number;
  artifactRevision: number;
  channel: "stable" | "beta" | "internal";
  environment: string;
  scope: string;
  operatorUserId: number;
  idempotencyKey: string;
  inventoryDigest: string;
  confirmation: string;
}

export interface ReleaseBaselineBootstrapVerificationInput {
  operationId: string;
  artifact: ReleaseArtifactRecord;
  plan: ReleaseDeploymentPlan;
  signal: AbortSignal;
}

export interface ReleaseBaselineWorkerNodeIdentity {
  nodeId: string;
  releaseId: string;
  artifactSha256: string;
  schemaMode: string | null;
  schemaVersion: number | null;
}

export interface ReleaseBaselineFleetEvidence extends ReleaseReconciliationEvidence {
  /** Dedicated Worker SSH status, in addition to fresh DB heartbeats. */
  workerNodeIdentities: ReleaseBaselineWorkerNodeIdentity[];
}

export interface ReleaseBaselineBootstrapDependencies {
  database: Knex;
  targets: readonly ReleaseArtifactManifestTarget[];
  inventoryDescriptor: ReleaseBaselineInventoryDescriptor;
  loadArtifact(artifactId: string): Promise<ReleaseArtifactRecord>;
  verifyArtifact(
    artifact: ReleaseArtifactRecord,
    signal: AbortSignal,
  ): Promise<CachedReleaseArtifactEvidence>;
  verifyFleet(
    input: ReleaseBaselineBootstrapVerificationInput,
  ): Promise<ReleaseBaselineFleetEvidence>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  confirmationIntervalMs?: number;
  signal?: AbortSignal;
  /** Test-only crash seam. Production callers must leave this undefined. */
  afterReservation?: (deploymentId: string) => Promise<void>;
}

export interface ReleaseBaselineBootstrapResult {
  deploymentId: string;
  releaseId: string;
  artifactId: string;
  inventoryDigest: string;
  evidenceDigest: string;
  status: "succeeded";
}

/**
 * One-time bridge for a production baseline created before exact object
 * generations were persisted. It never weakens the normal deployment gates:
 * the existing live artifact is independently re-proven, then its immutable
 * provider generation is attached with a single CAS transaction.
 */
export interface ReleaseBaselineProvenanceUpgradeDependencies {
  database: Knex;
  targets: readonly ReleaseArtifactManifestTarget[];
  inventoryDescriptor: ReleaseBaselineInventoryDescriptor;
  storageConfiguration: ObjectStorageConfiguration;
  loadArtifact(artifactId: string): Promise<ReleaseArtifactRecord>;
  inspectGeneration(
    storageKey: string,
    options: { versionId?: string | null; signal: AbortSignal },
  ): Promise<ObjectStorageGenerationSnapshot>;
  stepUpAuthorization: {
    proof: string;
    sessionId: string;
  };
  verifyArtifact(
    artifact: ReleaseArtifactRecord,
    signal: AbortSignal,
  ): Promise<CachedLegacyBridgeArtifactEvidence>;
  verifyFleet(
    input: ReleaseBaselineBootstrapVerificationInput,
  ): Promise<ReleaseBaselineFleetEvidence>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  confirmationIntervalMs?: number;
  signal?: AbortSignal;
}

export interface ReleaseBaselineProvenanceUpgradeResult {
  releaseId: string;
  artifactId: string;
  artifactRevision: number;
  reservationId: string;
  status: "upgraded";
  idempotent: boolean;
}

export class ReleaseBaselineBootstrapError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 409,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReleaseBaselineBootstrapError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(
  code: string,
  message: string,
  status = 409,
  details?: Record<string, unknown>,
): never {
  throw new ReleaseBaselineBootstrapError(code, message, status, details);
}

function table(client: BootstrapDb, name: string): Knex.QueryBuilder {
  return (client as any)(name);
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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("RELEASE_BASELINE_INPUT_INVALID", `${label} 必须是正整数`, 400);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    fail("RELEASE_BASELINE_INPUT_INVALID", `${label} 必须是 UUID`, 400);
  }
  return normalized;
}

function safeKey(value: unknown, label: string, minimumLength = 1): string {
  const normalized = String(value || "").trim();
  if (normalized.length < minimumLength || !SAFE_KEY_PATTERN.test(normalized)) {
    fail("RELEASE_BASELINE_INPUT_INVALID", `${label} 格式无效`, 400);
  }
  return normalized;
}

function normalizeInput(input: ReleaseBaselineBootstrapInput): ReleaseBaselineBootstrapInput {
  const channel = String(input.channel || "").trim();
  if (!CHANNELS.has(channel)) {
    fail("RELEASE_BASELINE_INPUT_INVALID", "channel 格式无效", 400);
  }
  const inventoryDigest = String(input.inventoryDigest || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(inventoryDigest)) {
    fail("RELEASE_BASELINE_INPUT_INVALID", "inventoryDigest 必须是 SHA-256", 400);
  }
  return {
    releaseId: uuid(input.releaseId, "releaseId"),
    artifactId: uuid(input.artifactId, "artifactId"),
    releaseRevision: positiveInteger(input.releaseRevision, "releaseRevision"),
    artifactRevision: positiveInteger(input.artifactRevision, "artifactRevision"),
    channel: channel as ReleaseBaselineBootstrapInput["channel"],
    environment: safeKey(input.environment, "environment"),
    scope: safeKey(input.scope, "scope"),
    operatorUserId: positiveInteger(input.operatorUserId, "operatorUserId"),
    idempotencyKey: safeKey(input.idempotencyKey, "idempotencyKey", 8),
    inventoryDigest,
    confirmation: String(input.confirmation || "").trim(),
  };
}

function assertTargetInventory(
  targets: readonly ReleaseArtifactManifestTarget[],
): ReleaseArtifactManifestTarget[] {
  const cloned = targets.map((target) => ({ ...target }));
  const api = cloned.filter((target) => target.role === "api");
  const workers = cloned.filter((target) => target.role === "worker");
  if (api.length < 2 || (workers.length !== 0 && workers.length < 2)) {
    fail(
      "RELEASE_BASELINE_TOPOLOGY_UNSAFE",
      "可信清单至少需要两个 API；独立 Worker 启用时也至少需要两个 Worker",
      503,
    );
  }
  const nodeIds = cloned.map((target) => target.key);
  const serverIds = cloned.map((target) => target.serverId).filter((value): value is string => Boolean(value));
  if (new Set(nodeIds).size !== nodeIds.length || new Set(serverIds).size !== serverIds.length) {
    fail("RELEASE_BASELINE_TOPOLOGY_UNSAFE", "API/Worker 清单包含重复 nodeId 或 serverId", 503);
  }
  if (cloned.some((target) => !SAFE_KEY_PATTERN.test(target.key)
    || !target.serverId
    || !SAFE_KEY_PATTERN.test(target.serverId)
    || !Number.isSafeInteger(target.wave)
    || target.wave < 1)) {
    fail("RELEASE_BASELINE_TOPOLOGY_UNSAFE", "API/Worker 清单身份无效", 503);
  }
  return cloned;
}

function buildPlan(
  input: ReleaseBaselineBootstrapInput,
  artifact: ReleaseArtifactRecord,
  targets: readonly ReleaseArtifactManifestTarget[],
): ReleaseDeploymentPlan {
  const ordered = [...targets]
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === "worker" ? -1 : 1;
      return left.wave - right.wave || left.key.localeCompare(right.key);
    })
    .map((target, ordinal) => ({ ...target, ordinal }));
  const apiCount = ordered.filter((target) => target.role === "api").length;
  const workerCount = ordered.filter((target) => target.role === "worker").length;
  const waves = ordered.map((target, wave) => ({ wave: wave + 1, targetKeys: [target.key] }));
  return {
    planVersion: 1,
    artifactSchemaVersion: artifact.manifest.schemaVersion,
    artifactWorkerProtocolVersion: artifact.manifest.workerProtocolVersion,
    strategy: "rolling",
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    environment: input.environment,
    scope: input.scope,
    maxUnavailable: 1,
    minHealthyTargets: Math.max(1, apiCount - 1),
    minHealthyWorkers: workerCount === 0 ? 0 : Math.max(1, workerCount - 1),
    drainTimeoutMs: 310_000,
    readinessTimeoutMs: 120_000,
    rollbackOnFailure: true,
    targets: ordered,
    waves,
  };
}

function artifactIdentity(artifact: ReleaseArtifactRecord): Record<string, unknown> {
  return {
    id: artifact.id,
    releaseId: artifact.releaseId,
    revision: artifact.revision,
    status: artifact.status,
    storageKey: artifact.storageKey,
    uploadReservationId: artifact.uploadReservationId,
    storageProvider: artifact.storageProvider,
    storageBucket: artifact.storageBucket,
    storageRegion: artifact.storageRegion,
    storageEndpoint: artifact.storageEndpoint,
    storageKeyPrefix: artifact.storageKeyPrefix,
    storageForcePathStyle: artifact.storageForcePathStyle,
    storageVersionId: artifact.storageVersionId,
    storageEtag: artifact.storageEtag,
    storageRequestId: artifact.storageRequestId,
    storageCapturedAt: artifact.storageCapturedAt,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    sourceCommit: artifact.sourceCommit,
    format: artifact.format,
    manifest: artifact.manifest,
  };
}

function hasExactArtifactGeneration(artifact: ReleaseArtifactRecord): boolean {
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

function hasNoArtifactGeneration(artifact: ReleaseArtifactRecord): boolean {
  return artifact.uploadReservationId == null
    && artifact.storageProvider == null
    && artifact.storageBucket == null
    && artifact.storageRegion == null
    && artifact.storageEndpoint == null
    && artifact.storageKeyPrefix == null
    && artifact.storageForcePathStyle == null
    && artifact.storageVersionId == null
    && artifact.storageEtag == null
    && artifact.storageRequestId == null
    && artifact.storageCapturedAt == null;
}

function provenanceIdempotencyKey(idempotencyKey: string): string {
  return `${PROVENANCE_IDEMPOTENCY_PREFIX}${idempotencyKey}`;
}

function assertRemoteProvenanceConfiguration(
  configuration: ObjectStorageConfiguration,
): asserts configuration is ObjectStorageConfiguration & {
  provider: "s3" | "tos";
  bucket: string;
  region: string;
  endpoint: string;
} {
  if (
    (configuration.provider !== "s3" && configuration.provider !== "tos")
    || !configuration.bucket
    || !configuration.region
    || !configuration.endpoint
    || configuration.urlMode !== "signed"
  ) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_STORAGE_UNSAFE",
      "旧基线来源升级要求私有远端 signed 对象存储",
      503,
    );
  }
}

function assertLegacyArtifactStorageKey(
  artifact: ReleaseArtifactRecord,
): void {
  const prefix = `release-artifacts/${artifact.releaseId}/`;
  if (
    !artifact.storageKey.startsWith(prefix)
    || artifact.storageKey.length === prefix.length
    || artifact.storageKey.includes("\\")
    || artifact.storageKey.split("/").some((segment) => {
      if (!segment || segment === "." || segment === "..") return true;
      try {
        const decoded = decodeURIComponent(segment);
        return decoded === "."
          || decoded === ".."
          || decoded.includes("/")
          || decoded.includes("\\");
      } catch {
        return true;
      }
    })
  ) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_STORAGE_KEY_INVALID",
      "旧基线 storageKey 不在受信发布前缀内",
    );
  }
}

function assertLegacyArtifactForProvenanceUpgrade(
  artifact: ReleaseArtifactRecord,
  normalized: ReleaseBaselineBootstrapInput,
): void {
  if (
    artifact.id !== normalized.artifactId
    || artifact.releaseId !== normalized.releaseId
    || artifact.status !== "ready"
    || artifact.revision !== normalized.artifactRevision
    || artifact.manifest.releaseId !== normalized.releaseId
    || artifact.manifest.schemaMode !== "schema-neutral"
    || artifact.byteSize == null
    || !Number.isSafeInteger(artifact.byteSize)
    || artifact.byteSize < 1
    || artifact.verifiedAt == null
    || !Number.isSafeInteger(artifact.verifiedAt)
    || artifact.verifiedAt < 1
  ) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_ARTIFACT_INVALID",
      "来源升级目标必须是指定 revision 的 legacy ready 制品",
    );
  }
  if (!hasNoArtifactGeneration(artifact)) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_PARTIAL_EVIDENCE",
      "legacy 制品 generation 字段必须全部为空，部分回填已拒绝",
    );
  }
  assertLegacyArtifactStorageKey(artifact);
}

function nonEmptyGenerationValue(
  value: unknown,
  code: string,
): string {
  const normalized = String(value || "").trim();
  if (
    !normalized
    || normalized.length > 512
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(code, "对象存储未返回完整且稳定的 generation 证据", 503);
  }
  return normalized;
}

function artifactWithGeneration(input: {
  artifact: ReleaseArtifactRecord;
  reservationId: string;
  configuration: ObjectStorageConfiguration & {
    provider: "s3" | "tos";
    bucket: string;
    region: string;
    endpoint: string;
  };
  snapshot: ObjectStorageGenerationSnapshot;
  capturedAt: number;
}): { artifact: ReleaseArtifactRecord; contentType: string } {
  const { artifact, configuration, snapshot } = input;
  const versionId = nonEmptyGenerationValue(
    snapshot.versionId,
    "RELEASE_BASELINE_PROVENANCE_VERSION_REQUIRED",
  );
  if (versionId === "null") {
    fail(
      "RELEASE_BASELINE_PROVENANCE_VERSION_REQUIRED",
      "对象存储未启用可重复读取的版本 generation",
      503,
    );
  }
  const etag = nonEmptyGenerationValue(
    snapshot.etag,
    "RELEASE_BASELINE_PROVENANCE_RECEIPT_INCOMPLETE",
  );
  const requestId = nonEmptyGenerationValue(
    snapshot.requestId,
    "RELEASE_BASELINE_PROVENANCE_RECEIPT_INCOMPLETE",
  );
  const contentType = String(snapshot.contentType || "").trim().toLowerCase();
  if (
    !snapshot.exists
    || snapshot.deleteMarker
    || snapshot.provider !== configuration.provider
    || snapshot.bucket !== configuration.bucket
    || snapshot.key !== artifact.storageKey
    || snapshot.size !== artifact.byteSize
    || !contentType
    || contentType.length > 160
    || /[\u0000-\u001f\u007f]/u.test(contentType)
    || (artifact.mediaType != null
      && artifact.mediaType.trim().toLowerCase() !== contentType)
  ) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_GENERATION_MISMATCH",
      "权威对象 generation 与 legacy 制品登记信息不一致",
      422,
    );
  }
  return {
    artifact: {
      ...artifact,
      uploadReservationId: input.reservationId,
      storageProvider: configuration.provider,
      storageBucket: configuration.bucket,
      storageRegion: configuration.region,
      storageEndpoint: configuration.endpoint,
      storageKeyPrefix: configuration.keyPrefix,
      storageForcePathStyle: configuration.forcePathStyle,
      storageVersionId: versionId,
      storageEtag: etag,
      storageRequestId: requestId,
      storageCapturedAt: input.capturedAt,
    },
    contentType,
  };
}

function assertSameGeneration(
  candidate: ReleaseArtifactRecord,
  snapshot: ObjectStorageGenerationSnapshot,
  configuration: ObjectStorageConfiguration,
  contentType: string,
): void {
  if (
    snapshot.exists !== true
    || snapshot.deleteMarker
    || snapshot.provider !== candidate.storageProvider
    || snapshot.provider !== configuration.provider
    || snapshot.bucket !== candidate.storageBucket
    || snapshot.bucket !== configuration.bucket
    || snapshot.key !== candidate.storageKey
    || snapshot.versionId !== candidate.storageVersionId
    || snapshot.etag !== candidate.storageEtag
    || snapshot.size !== candidate.byteSize
    || String(snapshot.contentType || "").trim().toLowerCase() !== contentType
    || !String(snapshot.requestId || "").trim()
  ) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_GENERATION_DRIFT",
      "双快照核验后 exact generation 证据发生变化",
      409,
    );
  }
}

function parseJsonObject(value: unknown, code: string, message: string): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      fail(code, message);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(code, message);
  }
  return parsed as Record<string, unknown>;
}

function assertArtifactRowIdentity(
  row: RawRow | undefined,
  artifact: ReleaseArtifactRecord,
  expectedRevision: number,
): void {
  const manifest = row
    ? parseJsonObject(
      row.manifestJson,
      "RELEASE_BASELINE_ARTIFACT_IDENTITY_CHANGED",
      "ready 制品 manifest 身份发生变化",
    )
    : null;
  if (!row
    || String(row.id) !== artifact.id
    || String(row.releaseId) !== artifact.releaseId
    || String(row.status) !== "ready"
    || Number(row.revision) !== expectedRevision
    || String(row.storageKey) !== artifact.storageKey
    || (row.uploadReservationId === null
      ? null
      : String(row.uploadReservationId)) !== artifact.uploadReservationId
    || (row.storageProvider === null
      ? null
      : String(row.storageProvider)) !== artifact.storageProvider
    || (row.storageBucket === null
      ? null
      : String(row.storageBucket)) !== artifact.storageBucket
    || (row.storageRegion === null
      ? null
      : String(row.storageRegion)) !== artifact.storageRegion
    || (row.storageEndpoint === null
      ? null
      : String(row.storageEndpoint)) !== artifact.storageEndpoint
    || (row.storageKeyPrefix === null
      ? null
      : String(row.storageKeyPrefix)) !== artifact.storageKeyPrefix
    || (row.storageForcePathStyle === null
      ? null
      : Boolean(row.storageForcePathStyle)) !== artifact.storageForcePathStyle
    || (row.storageVersionId === null
      ? null
      : String(row.storageVersionId)) !== artifact.storageVersionId
    || (row.storageEtag === null
      ? null
      : String(row.storageEtag)) !== artifact.storageEtag
    || (row.storageRequestId === null
      ? null
      : String(row.storageRequestId)) !== artifact.storageRequestId
    || (row.storageCapturedAt === null
      ? null
      : Number(row.storageCapturedAt)) !== artifact.storageCapturedAt
    || String(row.sha256).toLowerCase() !== artifact.sha256
    || (row.byteSize === null ? null : Number(row.byteSize)) !== artifact.byteSize
    || (row.sourceCommit === null ? null : String(row.sourceCommit)) !== artifact.sourceCommit
    || (row.format === null ? null : String(row.format)) !== artifact.format
    || canonicalJson(manifest) !== canonicalJson(artifact.manifest)) {
    fail("RELEASE_BASELINE_ARTIFACT_IDENTITY_CHANGED", "ready 制品身份在核验后发生变化");
  }
}

function storedPlan(
  normalized: ReleaseBaselineBootstrapInput,
  plan: ReleaseDeploymentPlan,
): ReleaseDeploymentPlan & Record<string, unknown> {
  return {
    ...plan,
    bootstrapMode: BOOTSTRAP_MODE,
    inventoryDigest: normalized.inventoryDigest,
    bootstrapReleaseRevision: normalized.releaseRevision,
    bootstrapArtifactRevision: normalized.artifactRevision,
  };
}

function expectedTargetMetadata(
  target: ReleaseDeploymentPlan["targets"][number],
  inventoryDigest: string,
): Record<string, unknown> {
  return {
    baselineBootstrap: true,
    inventoryDigest,
    wave: target.wave,
    zone: target.zone ?? null,
    serverId: target.serverId ?? null,
  };
}

function assertDeploymentReservationIdentity(
  deployment: RawRow,
  normalized: ReleaseBaselineBootstrapInput,
  plan: ReleaseDeploymentPlan,
  expectedRequestHash: string,
): void {
  const persistedPlan = parseJsonObject(
    deployment.planJson,
    "RELEASE_BASELINE_RESERVATION_IDENTITY_CHANGED",
    "baseline reservation 的计划身份无效",
  );
  if (String(deployment.requestHash) !== expectedRequestHash
    || String(deployment.releaseId) !== normalized.releaseId
    || String(deployment.artifactId) !== normalized.artifactId
    || String(deployment.idempotencyKey) !== normalized.idempotencyKey
    || deployment.previousReleaseId !== null
    || deployment.previousArtifactId !== null
    || String(deployment.environment) !== normalized.environment
    || String(deployment.strategy) !== "rolling"
    || String(deployment.status) !== "running"
    || String(deployment.phase) !== "baseline-verification"
    || String(deployment.activeScope) !== normalized.scope
    || Number(deployment.revision) !== 1
    || Number(deployment.fencingToken) !== 1
    || deployment.leaseOwner !== null
    || deployment.leaseExpiresAt !== null
    || Number(deployment.requestedByUserId) !== normalized.operatorUserId
    || Number(deployment.targetCount) !== plan.targets.length
    || Number(deployment.completedTargetCount) !== 0
    || Number(deployment.succeededTargetCount) !== 0
    || Number(deployment.failedTargetCount) !== 0
    || Number(deployment.maxUnavailable) !== 1
    || Number(deployment.minHealthyTargets) !== plan.minHealthyTargets
    || Number(deployment.drainTimeoutMs) !== plan.drainTimeoutMs
    || Number(deployment.readinessTimeoutMs) !== plan.readinessTimeoutMs
    || Number(deployment.rollbackOnFailure) !== 1
    || canonicalJson(persistedPlan) !== canonicalJson(storedPlan(normalized, plan))) {
    fail(
      "RELEASE_BASELINE_RESERVATION_IDENTITY_CHANGED",
      "baseline reservation 身份发生变化；已保留生产锁等待人工审计",
    );
  }
}

async function assertReservationTargetIdentity(input: {
  client: BootstrapDb;
  deploymentId: string;
  plan: ReleaseDeploymentPlan;
  inventoryDigest: string;
}): Promise<RawRow[]> {
  const rows = await table(input.client, RELEASE_DEPLOYMENT_TARGET_TABLE)
    .where({ deploymentId: input.deploymentId })
    .orderBy("ordinal", "asc")
    .forUpdate();
  if (rows.length !== input.plan.targets.length
    || rows.some((row: RawRow, index: number) => {
      const target = input.plan.targets[index];
      let metadata: Record<string, unknown>;
      try {
        metadata = parseJsonObject(
          row.targetMetadataJson,
          "RELEASE_BASELINE_TARGET_IDENTITY_CHANGED",
          "baseline 目标清单身份无效",
        );
      } catch {
        return true;
      }
      return String(row.targetKey) !== target.key
        || String(row.targetLabel) !== target.label
        || String(row.role) !== target.role
        || Number(row.ordinal) !== target.ordinal
        || String(row.status) !== "pending"
        || Number(row.attempt) !== 0
        || Number(row.revision) !== 1
        || row.previousReleaseId !== null
        || row.previousArtifactId !== null
        || row.observedArtifactId !== null
        || row.observedVersion !== null
        || row.drainStartedAt !== null
        || row.deployStartedAt !== null
        || row.verifiedAt !== null
        || row.completedAt !== null
        || row.errorCode !== null
        || row.safeError !== null
        || canonicalJson(metadata) !== canonicalJson(expectedTargetMetadata(target, input.inventoryDigest));
    })) {
    fail(
      "RELEASE_BASELINE_TARGET_IDENTITY_CHANGED",
      "baseline 目标清单身份发生变化；已保留生产锁等待人工审计",
    );
  }
  return rows as RawRow[];
}

function requestHash(
  input: ReleaseBaselineBootstrapInput,
  artifact: ReleaseArtifactRecord,
  plan: ReleaseDeploymentPlan,
): string {
  return sha256(canonicalJson({
    bootstrapMode: BOOTSTRAP_MODE,
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    releaseRevision: input.releaseRevision,
    artifactRevision: input.artifactRevision,
    channel: input.channel,
    environment: input.environment,
    scope: input.scope,
    operatorUserId: input.operatorUserId,
    inventoryDigest: input.inventoryDigest,
    artifactIdentity: artifactIdentity(artifact),
    targets: plan.targets,
  }));
}

function releaseArtifact(artifact: ReleaseArtifactRecord, releaseVersion: string): ReleaseArtifact {
  return {
    id: artifact.id,
    version: releaseVersion,
    sha256: artifact.sha256,
    schemaVersion: artifact.manifest.schemaVersion,
    workerProtocolVersion: artifact.manifest.workerProtocolVersion,
    runtimeCapabilities: [...artifact.manifest.runtimeCapabilities],
  };
}

function initialCheckpoint(input: {
  operationId: string;
  artifact: ReleaseArtifact;
  plan: ReleaseDeploymentPlan;
  now: number;
}): ReleaseCheckpoint {
  const apiIds = input.plan.targets.filter((target) => target.role === "api").map((target) => target.key);
  const workerIds = input.plan.targets.filter((target) => target.role === "worker").map((target) => target.key);
  return {
    operationId: input.operationId,
    status: "running",
    phase: "preflight",
    artifact: input.artifact,
    schemaMode: "schema-neutral",
    nodeOrder: apiIds,
    nodes: {},
    workerOrder: workerIds,
    workers: {},
    preflightComplete: false,
    stageComplete: false,
    workerPreflightComplete: workerIds.length === 0,
    workerStageComplete: workerIds.length === 0,
    workerRollingComplete: workerIds.length === 0,
    publicSmokeComplete: false,
    currentNodeId: null,
    error: null,
    manualInterventionRequired: false,
    events: [{
      sequence: 1,
      operationId: input.operationId,
      type: "operation.started",
      phase: "preflight",
      nodeId: null,
      at: input.now,
      observations: { baselineBootstrap: true },
    }],
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function normalizedEvidence(evidence: ReleaseBaselineFleetEvidence): Record<string, unknown> {
  return {
    evidenceVersion: evidence.evidenceVersion,
    artifactId: evidence.artifactId,
    artifactSha256: evidence.artifactSha256,
    schemaVersion: evidence.schemaVersion,
    apiNodes: [...evidence.apiNodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    workers: [...evidence.workers].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    workerNodeIdentities: [...evidence.workerNodeIdentities]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    publicSmoke: evidence.publicSmoke,
  };
}

function evidenceDigest(evidence: ReleaseBaselineFleetEvidence): string {
  return sha256(canonicalJson(normalizedEvidence(evidence)));
}

function assertEvidence(
  evidence: ReleaseBaselineFleetEvidence,
  artifact: ReleaseArtifactRecord,
  plan: ReleaseDeploymentPlan,
): void {
  const expectedApi = plan.targets.filter((target) => target.role === "api").map((target) => target.key).sort();
  const expectedWorkers = plan.targets.filter((target) => target.role === "worker").map((target) => target.key).sort();
  const actualApi = evidence.apiNodes.map((node) => node.nodeId).sort();
  const actualWorkers = evidence.workers.map((worker) => worker.nodeId).sort();
  const actualWorkerNodes = evidence.workerNodeIdentities.map((worker) => worker.nodeId).sort();
  if (evidence.evidenceVersion !== 1
    || evidence.artifactId !== artifact.id
    || evidence.artifactSha256 !== artifact.sha256
    || evidence.schemaVersion !== artifact.manifest.schemaVersion
    || canonicalJson(actualApi) !== canonicalJson(expectedApi)
    || canonicalJson(actualWorkers) !== canonicalJson(expectedWorkers)
    || canonicalJson(actualWorkerNodes) !== canonicalJson(expectedWorkers)
    || evidence.apiNodes.some((node) => node.artifactSha256 !== artifact.sha256
      || node.health !== "up"
      || !Number.isSafeInteger(node.weight)
      || node.weight <= 0)
    || evidence.workers.some((worker) => worker.artifactSha256 !== artifact.sha256
      || worker.schemaVersion !== artifact.manifest.schemaVersion
      || worker.healthy !== true
      || worker.acceptingWork !== true)
    || evidence.workerNodeIdentities.some((worker) => worker.releaseId !== artifact.manifest.releaseId
      || worker.artifactSha256 !== artifact.sha256
      || worker.schemaMode !== "schema-neutral"
      || worker.schemaVersion !== artifact.manifest.schemaVersion)
    || evidence.publicSmoke.ok !== true
    || evidence.publicSmoke.artifactSha256 !== artifact.sha256) {
    fail("RELEASE_BASELINE_FLEET_EVIDENCE_INVALID", "全量集群核验结果不完整或制品身份不一致");
  }
}

function safeError(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown };
  const rawCode = typeof candidate?.code === "string" ? candidate.code : "RELEASE_BASELINE_VERIFICATION_FAILED";
  const code = rawCode.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)
    || "RELEASE_BASELINE_VERIFICATION_FAILED";
  return { code, message: "基线核验失败；未建立可信发布来源链" };
}

async function appendEvent(trx: Knex.Transaction, input: {
  deploymentId: string;
  sequence: number;
  eventType: string;
  phase: string;
  level: "info" | "warning" | "error";
  actor: "operator" | "orchestrator";
  actorUserId: number;
  message: string;
  payload: Record<string, unknown>;
  now: number;
}): Promise<void> {
  await trx(RELEASE_DEPLOYMENT_EVENT_TABLE).insert({
    id: crypto.randomUUID(),
    deploymentId: input.deploymentId,
    targetId: null,
    sequence: input.sequence,
    eventType: input.eventType,
    phase: input.phase,
    level: input.level,
    actor: input.actor,
    actorUserId: input.actorUserId,
    requestId: null,
    message: input.message,
    payloadJson: JSON.stringify(input.payload),
    createdAt: input.now,
  });
}

async function appendAudit(trx: Knex.Transaction, input: {
  action: string;
  resourceId: string;
  actorUserId: number;
  metadata: Record<string, unknown>;
  now: number;
}): Promise<void> {
  await trx("o_audit_log").insert({
    id: crypto.randomUUID(),
    workspaceId: null,
    actorUserId: input.actorUserId,
    actorRole: "root",
    action: input.action,
    resourceType: "release_deployment",
    resourceId: input.resourceId,
    ip: null,
    userAgent: "release-baseline-bootstrap-cli",
    metadata: JSON.stringify(input.metadata),
    createdAt: input.now,
  });
}

async function assertRootWithMfa(
  client: BootstrapDb,
  operatorUserId: number,
): Promise<void> {
  const user = await table(client, "o_user").where({ id: operatorUserId }).first();
  const security = await table(client, "o_account_security").where({ userId: operatorUserId }).first();
  if (!user
    || String(user.role || "").toLowerCase() !== "root"
    || String(user.status || "active").toLowerCase() !== "active"
    || Number(security?.mfaEnabled || 0) !== 1) {
    fail(
      "RELEASE_BASELINE_ROOT_MFA_REQUIRED",
      "基线建立必须归因到已启用 MFA 的 active root 账号",
      403,
    );
  }
}

async function trustedBaselineExists(
  client: BootstrapDb,
  channel: string,
): Promise<boolean> {
  const row = await table(client, RELEASE_DEPLOYMENT_TABLE)
    .join(PLATFORM_RELEASE_TABLE, `${PLATFORM_RELEASE_TABLE}.id`, `${RELEASE_DEPLOYMENT_TABLE}.releaseId`)
    .join(RELEASE_ARTIFACT_TABLE, `${RELEASE_ARTIFACT_TABLE}.id`, `${RELEASE_DEPLOYMENT_TABLE}.artifactId`)
    .where(`${PLATFORM_RELEASE_TABLE}.channel`, channel)
    .andWhere(`${PLATFORM_RELEASE_TABLE}.status`, "published")
    .andWhere(`${RELEASE_DEPLOYMENT_TABLE}.status`, "succeeded")
    .andWhere(`${RELEASE_ARTIFACT_TABLE}.status`, "ready")
    .select(`${RELEASE_DEPLOYMENT_TABLE}.id`)
    .first();
  return Boolean(row);
}

interface PublishedBaselineIdentity {
  release: RawRow;
  deployment: RawRow;
}

async function currentPublishedBaseline(
  client: BootstrapDb,
  normalized: ReleaseBaselineBootstrapInput,
  options: { lock?: boolean } = {},
): Promise<PublishedBaselineIdentity> {
  let releaseQuery = table(client, PLATFORM_RELEASE_TABLE)
    .where({ status: "published", channel: normalized.channel })
    .orderBy("publishedAt", "desc")
    .orderBy("updatedAt", "desc")
    .orderBy("createdAt", "desc");
  if (options.lock) releaseQuery = releaseQuery.forUpdate();
  const release = await releaseQuery.first();
  if (!release
    || String(release.id) !== normalized.releaseId
    || String(release.status) !== "published"
    || String(release.channel) !== normalized.channel
    || Number(release.revision) !== normalized.releaseRevision
    || !Number.isSafeInteger(Number(release.publishedAt))
    || Number(release.publishedAt) < 1) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_NOT_CURRENT",
      "来源升级仅允许当前 channel 最新的指定 published release revision",
    );
  }

  let deploymentQuery = table(client, RELEASE_DEPLOYMENT_TABLE)
    .where({ releaseId: normalized.releaseId, status: "succeeded" })
    .orderBy("completedAt", "desc")
    .orderBy("createdAt", "desc");
  if (options.lock) deploymentQuery = deploymentQuery.forUpdate();
  const deployment = await deploymentQuery.first();
  const persistedPlan = deployment
    ? parseJsonObject(
      deployment.planJson,
      "RELEASE_BASELINE_PROVENANCE_DEPLOYMENT_INVALID",
      "当前 published release 的成功 deployment 计划无效",
    )
    : null;
  if (!deployment
    || String(deployment.releaseId) !== normalized.releaseId
    || String(deployment.artifactId) !== normalized.artifactId
    || String(deployment.status) !== "succeeded"
    || deployment.activeScope !== null
    || String(deployment.environment) !== normalized.environment
    || !Number.isSafeInteger(Number(deployment.completedAt))
    || Number(deployment.completedAt) < 1
    || !Number.isSafeInteger(Number(deployment.revision))
    || Number(deployment.revision) < 1
    || String(persistedPlan?.releaseId || "") !== normalized.releaseId
    || String(persistedPlan?.artifactId || "") !== normalized.artifactId
    || String(persistedPlan?.environment || "") !== normalized.environment
    || String(persistedPlan?.scope || "") !== normalized.scope) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_DEPLOYMENT_INVALID",
      "当前 published release 缺少与指定制品一致的 succeeded deployment",
    );
  }
  return { release, deployment };
}

async function assertNoActiveDeployment(client: BootstrapDb): Promise<void> {
  const active = await table(client, RELEASE_DEPLOYMENT_TABLE)
    .whereNotNull("activeScope")
    .select("id", "status")
    .first();
  if (active) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_DEPLOYMENT_ACTIVE",
      "存在进行中的生产发布任务，拒绝修改当前基线来源",
      409,
      { deploymentId: String(active.id), status: String(active.status) },
    );
  }
}

interface LegacySchemaBridgeProvenance {
  mode: "archive-signed-manifest-adoption";
  migration: {
    fromVersion: number;
    toVersion: number;
    migrationName: string;
    migrationChecksum: string;
    mode: "expand";
    rollbackMode: "binary-compatible";
  };
}

async function assertLegacyArtifactSupportsCurrentDatabase(
  artifact: ReleaseArtifactRecord,
  database: Knex,
): Promise<LegacySchemaBridgeProvenance> {
  let migrationStatus: Awaited<ReturnType<typeof inspectDatabaseMigrations>>;
  try {
    const identity = RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY;
    migrationStatus = await inspectDatabaseMigrations(
      database,
      DATABASE_MIGRATIONS.slice(0, identity.version),
    );
  } catch {
    fail(
      "RELEASE_BASELINE_PROVENANCE_SCHEMA_UNVERIFIABLE",
      "无法核验数据库 migration 历史，拒绝 legacy 来源升级",
      503,
    );
  }
  const identity = RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY;
  const appliedGeneration = migrationStatus.applied.find(
    (entry) => entry.version === identity.version,
  );
  const compatibility = artifact.manifest.schemaCompatibility;
  const expectedMigration = {
    fromVersion: identity.version - 1,
    toVersion: identity.version,
    migrationName: identity.name,
    migrationChecksum: RELEASE_ARTIFACT_GENERATION_MIGRATION_CHECKSUM,
    mode: "expand" as const,
    rollbackMode: "binary-compatible" as const,
  };
  const signedCompatibility = Boolean(
    compatibility
    && compatibility.binarySchemaVersion === identity.version - 1
    && canonicalJson(compatibility.supportedDatabaseVersions)
      === canonicalJson([identity.version - 1, identity.version])
    && compatibility.migration
    && sameReleaseSchemaMigrationEdge(
      compatibility.migration,
      expectedMigration,
    ),
  );
  const genuineLegacyCompatibility = !compatibility
    || (
      compatibility.binarySchemaVersion === identity.version - 1
      && canonicalJson(compatibility.supportedDatabaseVersions)
        === canonicalJson([identity.version - 1])
      && compatibility.migration === null
    );
  if (!migrationStatus.current
    || migrationStatus.databaseVersion !== identity.version
    || migrationStatus.knownLatestVersion !== identity.version
    || !appliedGeneration
    || appliedGeneration.name !== identity.name
    || appliedGeneration.checksum !== RELEASE_ARTIFACT_GENERATION_MIGRATION_CHECKSUM
    || artifact.manifest.schemaVersion !== identity.version - 1
    || (!signedCompatibility && !genuineLegacyCompatibility)) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_SCHEMA_UNSUPPORTED",
      "legacy binary 未在签名 manifest 中声明支持当前 v36 migration identity",
      409,
      {
        databaseVersion: migrationStatus.databaseVersion,
        requiredMigrationName: identity.name,
        requiredMigrationChecksum: RELEASE_ARTIFACT_GENERATION_MIGRATION_CHECKSUM,
      },
    );
  }
  return {
    // The production verifier always proves this edge from the signed archive.
    // Keeping the operation mode independent of the legacy DB mirror makes a
    // completed manifest adoption safely replayable.
    mode: "archive-signed-manifest-adoption",
    migration: expectedMigration,
  };
}

async function assertNoUnsafeDeploymentHistory(
  client: BootstrapDb,
  releaseId: string,
  idempotencyKey: string,
): Promise<void> {
  const previous = await table(client, RELEASE_DEPLOYMENT_TABLE)
    .where({ releaseId })
    .andWhere((builder: Knex.QueryBuilder) => {
      builder.whereNotNull("previousReleaseId").orWhereNotNull("previousArtifactId");
    })
    .first();
  if (previous) {
    fail("RELEASE_BASELINE_PREVIOUS_IDENTITY_FORBIDDEN", "baseline deployment 的 previous 身份必须为空");
  }
  const conflicting = await table(client, RELEASE_DEPLOYMENT_TABLE)
    .where({ releaseId })
    .whereNot({ idempotencyKey })
    .whereIn("status", ["queued", "running", "cancelling", "rolling_back", "succeeded", "degraded_manual"])
    .first();
  if (conflicting) {
    fail("RELEASE_BASELINE_RELEASE_HISTORY_CONFLICT", "目标版本已有不能用于 baseline 的发布任务");
  }
}

interface Reservation {
  deploymentId: string;
  deploymentRevision: number;
  releaseVersion: string;
  releaseRevisionAfterReserve: number;
  plan: ReleaseDeploymentPlan;
  requestHash: string;
}

async function reserveBootstrap(input: {
  normalized: ReleaseBaselineBootstrapInput;
  artifact: ReleaseArtifactRecord;
  plan: ReleaseDeploymentPlan;
  requestHash: string;
  database: Knex;
  now: number;
}): Promise<Reservation> {
  const { normalized, artifact, plan } = input;
  return input.database.transaction(async (trx) => {
    await acquireReleaseMutationLock(trx);
    const release = await trx(PLATFORM_RELEASE_TABLE).where({ id: normalized.releaseId }).forUpdate().first();
    if (!release) fail("PLATFORM_RELEASE_NOT_FOUND", "版本记录不存在", 404);
    await assertRootWithMfa(trx, normalized.operatorUserId);

    const existing = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ idempotencyKey: normalized.idempotencyKey })
      .forUpdate()
      .first();
    if (existing) {
      if (String(existing.requestHash) !== input.requestHash
        || String(existing.releaseId) !== normalized.releaseId
        || String(existing.artifactId) !== normalized.artifactId
        || existing.previousReleaseId !== null
        || existing.previousArtifactId !== null) {
        fail("RELEASE_BASELINE_IDEMPOTENCY_CONFLICT", "idempotencyKey 已绑定不同或不安全的基线请求");
      }
      if (String(existing.status) !== "running"
        || String(release.status) !== "deploying"
        || String(release.channel) !== normalized.channel
        || Number(release.revision) !== normalized.releaseRevision + 1) {
        fail("RELEASE_BASELINE_RESERVATION_NOT_RESUMABLE", "已有基线请求不处于可安全恢复状态");
      }
      const artifactRow = await trx(RELEASE_ARTIFACT_TABLE)
        .where({ id: normalized.artifactId, releaseId: normalized.releaseId })
        .forUpdate()
        .first();
      assertArtifactRowIdentity(artifactRow, artifact, normalized.artifactRevision);
      assertDeploymentReservationIdentity(existing, normalized, plan, input.requestHash);
      await assertReservationTargetIdentity({
        client: trx,
        deploymentId: String(existing.id),
        plan,
        inventoryDigest: normalized.inventoryDigest,
      });
      return {
        deploymentId: String(existing.id),
        deploymentRevision: Number(existing.revision),
        releaseVersion: String(release.version),
        releaseRevisionAfterReserve: Number(release.revision),
        plan,
        requestHash: input.requestHash,
      };
    }

    if (String(release.status) !== "draft" || Number(release.revision) !== normalized.releaseRevision) {
      fail("RELEASE_BASELINE_RELEASE_NOT_DRAFT", "目标版本必须是指定 revision 的 draft");
    }
    if (String(release.channel) !== normalized.channel) {
      fail("RELEASE_BASELINE_CHANNEL_MISMATCH", "目标版本 channel 与命令参数不一致");
    }
    if (await trustedBaselineExists(trx, normalized.channel)) {
      fail("RELEASE_BASELINE_ALREADY_ESTABLISHED", "该 channel 已有可信 succeeded baseline");
    }
    await assertNoUnsafeDeploymentHistory(trx, normalized.releaseId, normalized.idempotencyKey);

    const artifactRow = await trx(RELEASE_ARTIFACT_TABLE)
      .where({ id: normalized.artifactId, releaseId: normalized.releaseId })
      .forUpdate()
      .first();
    assertArtifactRowIdentity(artifactRow, artifact, normalized.artifactRevision);

    const deploymentId = crypto.randomUUID();
    const checkpoint = initialCheckpoint({
      operationId: deploymentId,
      artifact: releaseArtifact(artifact, String(release.version)),
      plan,
      now: input.now,
    });
    const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
      .where({ id: normalized.releaseId, status: "draft", revision: normalized.releaseRevision })
      .update({
        status: "deploying",
        updatedByUserId: normalized.operatorUserId,
        updatedAt: input.now,
        revision: normalized.releaseRevision + 1,
      });
    if (Number(releaseUpdated) !== 1) {
      fail("RELEASE_BASELINE_RELEASE_WRITE_CONFLICT", "版本状态在建立基线锁时发生变化");
    }

    await trx(RELEASE_DEPLOYMENT_TABLE).insert({
      id: deploymentId,
      releaseId: normalized.releaseId,
      artifactId: normalized.artifactId,
      previousReleaseId: null,
      previousArtifactId: null,
      environment: normalized.environment,
      strategy: "rolling",
      status: "running",
      phase: "baseline-verification",
      activeScope: normalized.scope,
      idempotencyKey: normalized.idempotencyKey,
      requestHash: input.requestHash,
      planJson: JSON.stringify(storedPlan(normalized, plan)),
      checkpointJson: JSON.stringify(checkpoint),
      manualInterventionRequired: 0,
      fencingToken: 1,
      targetCount: plan.targets.length,
      completedTargetCount: 0,
      succeededTargetCount: 0,
      failedTargetCount: 0,
      maxUnavailable: 1,
      minHealthyTargets: plan.minHealthyTargets,
      drainTimeoutMs: plan.drainTimeoutMs,
      readinessTimeoutMs: plan.readinessTimeoutMs,
      rollbackOnFailure: 1,
      requestedByUserId: normalized.operatorUserId,
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: input.now,
      completedAt: null,
      cancelRequestedAt: null,
      cancelRequestedByUserId: null,
      cancelReason: null,
      errorCode: null,
      safeError: null,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).insert(plan.targets.map((target) => ({
      id: crypto.randomUUID(),
      deploymentId,
      targetKey: target.key,
      targetLabel: target.label,
      role: target.role,
      ordinal: target.ordinal,
      targetMetadataJson: JSON.stringify(expectedTargetMetadata(target, normalized.inventoryDigest)),
      status: "pending",
      attempt: 0,
      previousReleaseId: null,
      previousArtifactId: null,
      observedArtifactId: null,
      observedVersion: null,
      drainStartedAt: null,
      deployStartedAt: null,
      verifiedAt: null,
      completedAt: null,
      errorCode: null,
      safeError: null,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
    })));
    await appendEvent(trx, {
      deploymentId,
      sequence: 1,
      eventType: "baseline.bootstrap.started",
      phase: "baseline-verification",
      level: "warning",
      actor: "operator",
      actorUserId: normalized.operatorUserId,
      message: "一次性生产基线核验已锁定发布范围",
      payload: {
        bootstrapMode: BOOTSTRAP_MODE,
        artifactId: normalized.artifactId,
        inventoryDigest: normalized.inventoryDigest,
      },
      now: input.now,
    });
    await appendAudit(trx, {
      action: "admin.release_baseline.bootstrap_started",
      resourceId: deploymentId,
      actorUserId: normalized.operatorUserId,
      metadata: {
        releaseId: normalized.releaseId,
        artifactId: normalized.artifactId,
        scope: normalized.scope,
        inventoryDigest: normalized.inventoryDigest,
      },
      now: input.now,
    });
    return {
      deploymentId,
      deploymentRevision: 1,
      releaseVersion: String(release.version),
      releaseRevisionAfterReserve: normalized.releaseRevision + 1,
      plan,
      requestHash: input.requestHash,
    };
  });
}

function completedCheckpoint(input: {
  reservation: Reservation;
  artifact: ReleaseArtifactRecord;
  firstEvidence: ReleaseBaselineFleetEvidence;
  secondEvidence: ReleaseBaselineFleetEvidence;
  attestationEvidence: CachedReleaseArtifactEvidence;
  inventoryDigest: string;
  now: number;
}): ReleaseCheckpoint & Record<string, unknown> {
  const artifact = releaseArtifact(input.artifact, input.reservation.releaseVersion);
  const apiEvidence = new Map(input.secondEvidence.apiNodes.map((node) => [node.nodeId, node]));
  const workerEvidence = new Map(input.secondEvidence.workers.map((worker) => [worker.nodeId, worker]));
  const nodes: Record<string, ReleaseNodeCheckpoint> = {};
  const workers: Record<string, ReleaseWorkerCheckpoint> = {};
  for (const target of input.reservation.plan.targets) {
    if (target.role === "api") {
      const evidence = apiEvidence.get(target.key)!;
      nodes[target.key] = {
        nodeId: target.key,
        originalWeight: evidence.weight,
        previousArtifactSha256: input.artifact.sha256,
        preflightComplete: true,
        staged: true,
        othersHealthyConfirmed: true,
        weightZeroAttempted: false,
        weightZero: false,
        drainStarted: false,
        drained: false,
        activationAttempted: false,
        activated: true,
        directReady: true,
        weightRestored: true,
        clbUpConfirmationCount: 2,
        baked: true,
        completed: true,
        isolated: false,
        rolledBack: false,
        rollbackVerified: false,
      };
    } else {
      const evidence = workerEvidence.get(target.key)!;
      workers[target.key] = {
        nodeId: target.key,
        previousArtifactSha256: input.artifact.sha256,
        preflightComplete: true,
        staged: true,
        capacityConfirmed: true,
        drainRequested: false,
        drained: false,
        activationAttempted: false,
        activated: true,
        artifactReady: true,
        resumed: true,
        serving: evidence.acceptingWork,
        completed: true,
        isolated: false,
        rolledBack: false,
        rollbackVerified: false,
      };
    }
  }
  return {
    operationId: input.reservation.deploymentId,
    status: "succeeded",
    phase: "success",
    artifact,
    schemaMode: "schema-neutral",
    nodeOrder: input.reservation.plan.targets.filter((target) => target.role === "api").map((target) => target.key),
    nodes,
    workerOrder: input.reservation.plan.targets.filter((target) => target.role === "worker").map((target) => target.key),
    workers,
    preflightComplete: true,
    stageComplete: true,
    workerPreflightComplete: true,
    workerStageComplete: true,
    workerRollingComplete: true,
    publicSmokeComplete: true,
    currentNodeId: null,
    error: null,
    manualInterventionRequired: false,
    events: [{
      sequence: 1,
      operationId: input.reservation.deploymentId,
      type: "operation.started",
      phase: "preflight",
      nodeId: null,
      at: input.now,
      observations: { baselineBootstrap: true },
    }, {
      sequence: 2,
      operationId: input.reservation.deploymentId,
      type: "operation.succeeded",
      phase: "success",
      nodeId: null,
      at: input.now,
      observations: { baselineBootstrap: true },
    }],
    revision: input.reservation.deploymentRevision + 1,
    createdAt: input.now,
    updatedAt: input.now,
    baselineBootstrap: {
      mode: BOOTSTRAP_MODE,
      inventoryDigest: input.inventoryDigest,
      firstEvidence: normalizedEvidence(input.firstEvidence),
      secondEvidence: normalizedEvidence(input.secondEvidence),
      attestation: {
        keyId: input.attestationEvidence.attestation.keyId,
        payloadSha256: input.attestationEvidence.attestation.payloadSha256,
      },
    },
  };
}

async function finalizeFailure(input: {
  database: Knex;
  normalized: ReleaseBaselineBootstrapInput;
  artifact: ReleaseArtifactRecord;
  reservation: Reservation;
  error: unknown;
  now: number;
}): Promise<void> {
  const failure = safeError(input.error);
  await input.database.transaction(async (trx) => {
    const release = await trx(PLATFORM_RELEASE_TABLE).where({ id: input.normalized.releaseId }).forUpdate().first();
    const deployment = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: input.reservation.deploymentId })
      .forUpdate()
      .first();
    if (!deployment || String(deployment.requestHash) !== input.reservation.requestHash) {
      fail("RELEASE_BASELINE_RESERVATION_LOST", "基线失败收尾时发布锁已丢失");
    }
    if (String(deployment.status) !== "running") return;
    if (!release
      || String(release.status) !== "deploying"
      || Number(release.revision) !== input.reservation.releaseRevisionAfterReserve
      || String(release.channel) !== input.normalized.channel) {
      fail(
        "RELEASE_BASELINE_RELEASE_WRITE_CONFLICT",
        "基线失败收尾时版本身份发生变化；已保留生产锁等待人工审计",
      );
    }
    if (Number(deployment.revision) !== input.reservation.deploymentRevision) {
      fail("RELEASE_BASELINE_RESERVATION_LOST", "基线失败收尾时 reservation revision 发生变化");
    }
    assertDeploymentReservationIdentity(
      deployment,
      input.normalized,
      input.reservation.plan,
      input.reservation.requestHash,
    );
    const artifactRow = await trx(RELEASE_ARTIFACT_TABLE)
      .where({ id: input.normalized.artifactId, releaseId: input.normalized.releaseId })
      .forUpdate()
      .first();
    assertArtifactRowIdentity(artifactRow, input.artifact, input.normalized.artifactRevision);
    await assertReservationTargetIdentity({
      client: trx,
      deploymentId: input.reservation.deploymentId,
      plan: input.reservation.plan,
      inventoryDigest: input.normalized.inventoryDigest,
    });
    const updatedTargets = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
      .where({ deploymentId: input.reservation.deploymentId, status: "pending" })
      .update({
        status: "failed",
        completedAt: input.now,
        errorCode: failure.code,
        safeError: failure.message,
        updatedAt: input.now,
        revision: trx.raw('"revision" + 1'),
      });
    if (Number(updatedTargets) !== input.reservation.plan.targets.length) {
      fail("RELEASE_BASELINE_TARGET_WRITE_CONFLICT", "基线失败目标状态无法原子收敛");
    }
    const updatedDeployment = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({
        id: input.reservation.deploymentId,
        revision: Number(deployment.revision),
        status: "running",
      })
      .update({
        status: "failed",
        phase: "failed",
        activeScope: null,
        completedTargetCount: input.reservation.plan.targets.length,
        succeededTargetCount: 0,
        failedTargetCount: input.reservation.plan.targets.length,
        completedAt: input.now,
        errorCode: failure.code,
        safeError: failure.message,
        updatedAt: input.now,
        revision: Number(deployment.revision) + 1,
      });
    if (Number(updatedDeployment) !== 1) {
      fail("RELEASE_BASELINE_DEPLOYMENT_WRITE_CONFLICT", "基线失败台账无法原子写入");
    }
    const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
      .where({
        id: input.normalized.releaseId,
        status: "deploying",
        revision: input.reservation.releaseRevisionAfterReserve,
      })
      .update({
        status: "draft",
        updatedByUserId: input.normalized.operatorUserId,
        updatedAt: input.now,
        revision: input.reservation.releaseRevisionAfterReserve + 1,
      });
    if (Number(releaseUpdated) !== 1) {
      fail("RELEASE_BASELINE_RELEASE_WRITE_CONFLICT", "基线失败时版本状态无法原子恢复");
    }
    await appendEvent(trx, {
      deploymentId: input.reservation.deploymentId,
      sequence: 2,
      eventType: "baseline.bootstrap.failed",
      phase: "failed",
      level: "error",
      actor: "orchestrator",
      actorUserId: input.normalized.operatorUserId,
      message: failure.message,
      payload: { errorCode: failure.code, inventoryDigest: input.normalized.inventoryDigest },
      now: input.now,
    });
    await appendAudit(trx, {
      action: "admin.release_baseline.bootstrap_failed",
      resourceId: input.reservation.deploymentId,
      actorUserId: input.normalized.operatorUserId,
      metadata: {
        releaseId: input.normalized.releaseId,
        artifactId: input.normalized.artifactId,
        errorCode: failure.code,
        inventoryDigest: input.normalized.inventoryDigest,
      },
      now: input.now,
    });
  });
}

async function finalizeSuccess(input: {
  database: Knex;
  normalized: ReleaseBaselineBootstrapInput;
  artifact: ReleaseArtifactRecord;
  reservation: Reservation;
  checkpoint: ReleaseCheckpoint & Record<string, unknown>;
  firstEvidence: ReleaseBaselineFleetEvidence;
  secondEvidence: ReleaseBaselineFleetEvidence;
  now: number;
}): Promise<ReleaseBaselineBootstrapResult> {
  const finalEvidenceDigest = evidenceDigest(input.secondEvidence);
  return input.database.transaction(async (trx) => {
    // Publishing the first trusted baseline and releasing activeScope must be
    // one fleet-serialized mutation. This lock must precede every row lock to
    // match normal release start/finalization ordering.
    await acquireReleaseMutationLock(trx);
    const release = await trx(PLATFORM_RELEASE_TABLE).where({ id: input.normalized.releaseId }).forUpdate().first();
    const deployment = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: input.reservation.deploymentId })
      .forUpdate()
      .first();
    if (!release
      || String(release.status) !== "deploying"
      || Number(release.revision) !== input.reservation.releaseRevisionAfterReserve
      || String(release.channel) !== input.normalized.channel) {
      fail("RELEASE_BASELINE_RELEASE_WRITE_CONFLICT", "最终写入前版本状态发生变化");
    }
    if (!deployment
      || String(deployment.status) !== "running"
      || Number(deployment.revision) !== input.reservation.deploymentRevision
      || String(deployment.requestHash) !== input.reservation.requestHash) {
      fail("RELEASE_BASELINE_RESERVATION_LOST", "最终写入前基线发布锁发生变化");
    }
    assertDeploymentReservationIdentity(
      deployment,
      input.normalized,
      input.reservation.plan,
      input.reservation.requestHash,
    );
    if (await trustedBaselineExists(trx, input.normalized.channel)) {
      fail("RELEASE_BASELINE_ALREADY_ESTABLISHED", "最终写入前该 channel 已出现可信 baseline");
    }
    const artifactRow = await trx(RELEASE_ARTIFACT_TABLE)
      .where({
        id: input.artifact.id,
        releaseId: input.normalized.releaseId,
        status: "ready",
        revision: input.normalized.artifactRevision,
      })
      .forUpdate()
      .first();
    assertArtifactRowIdentity(artifactRow, input.artifact, input.normalized.artifactRevision);
    await assertReservationTargetIdentity({
      client: trx,
      deploymentId: input.reservation.deploymentId,
      plan: input.reservation.plan,
      inventoryDigest: input.normalized.inventoryDigest,
    });

    const releaseVersion = String(release.version);
    await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
      .where({ deploymentId: input.reservation.deploymentId, status: "pending" })
      .update({
        status: "succeeded",
        observedArtifactId: input.artifact.id,
        observedVersion: releaseVersion,
        verifiedAt: input.now,
        completedAt: input.now,
        errorCode: null,
        safeError: null,
        updatedAt: input.now,
        revision: trx.raw('"revision" + 1'),
      });
    const updatedTargets = await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
      .where({ deploymentId: input.reservation.deploymentId, status: "succeeded" })
      .count({ count: "*" })
      .first();
    if (Number(updatedTargets?.count || 0) !== input.reservation.plan.targets.length) {
      fail("RELEASE_BASELINE_TARGET_WRITE_CONFLICT", "基线目标状态无法原子收敛");
    }

    const deploymentUpdated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({
        id: input.reservation.deploymentId,
        status: "running",
        revision: input.reservation.deploymentRevision,
        activeScope: input.normalized.scope,
      })
      .whereNull("previousReleaseId")
      .whereNull("previousArtifactId")
      .update({
        status: "succeeded",
        phase: "success",
        checkpointJson: JSON.stringify(input.checkpoint),
        activeScope: null,
        completedTargetCount: input.reservation.plan.targets.length,
        succeededTargetCount: input.reservation.plan.targets.length,
        failedTargetCount: 0,
        completedAt: input.now,
        errorCode: null,
        safeError: null,
        updatedAt: input.now,
        revision: input.reservation.deploymentRevision + 1,
      });
    if (Number(deploymentUpdated) !== 1) {
      fail("RELEASE_BASELINE_DEPLOYMENT_WRITE_CONFLICT", "基线 succeeded 台账无法原子写入");
    }
    const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
      .where({
        id: input.normalized.releaseId,
        status: "deploying",
        revision: input.reservation.releaseRevisionAfterReserve,
      })
      .update({
        status: "published",
        publishedAt: input.now,
        publishedByUserId: input.normalized.operatorUserId,
        updatedByUserId: input.normalized.operatorUserId,
        updatedAt: input.now,
        revision: input.reservation.releaseRevisionAfterReserve + 1,
      });
    if (Number(releaseUpdated) !== 1) {
      fail("RELEASE_BASELINE_RELEASE_WRITE_CONFLICT", "基线版本无法原子标记为 published");
    }
    await appendEvent(trx, {
      deploymentId: input.reservation.deploymentId,
      sequence: 2,
      eventType: "baseline.bootstrap.succeeded",
      phase: "success",
      level: "info",
      actor: "orchestrator",
      actorUserId: input.normalized.operatorUserId,
      message: "生产基线已通过双快照核验并建立可信来源链",
      payload: {
        artifactId: input.artifact.id,
        artifactSha256: input.artifact.sha256,
        inventoryDigest: input.normalized.inventoryDigest,
        firstEvidenceDigest: evidenceDigest(input.firstEvidence),
        secondEvidenceDigest: finalEvidenceDigest,
      },
      now: input.now,
    });
    await appendAudit(trx, {
      action: "admin.release_baseline.bootstrap_succeeded",
      resourceId: input.reservation.deploymentId,
      actorUserId: input.normalized.operatorUserId,
      metadata: {
        releaseId: input.normalized.releaseId,
        artifactId: input.artifact.id,
        artifactSha256: input.artifact.sha256,
        scope: input.normalized.scope,
        inventoryDigest: input.normalized.inventoryDigest,
        evidenceDigest: finalEvidenceDigest,
        verificationPasses: 2,
      },
      now: input.now,
    });
    return {
      deploymentId: input.reservation.deploymentId,
      releaseId: input.normalized.releaseId,
      artifactId: input.artifact.id,
      inventoryDigest: input.normalized.inventoryDigest,
      evidenceDigest: finalEvidenceDigest,
      status: "succeeded",
    };
  });
}

export async function bootstrapReleaseBaseline(
  rawInput: ReleaseBaselineBootstrapInput,
  dependencies: ReleaseBaselineBootstrapDependencies,
): Promise<ReleaseBaselineBootstrapResult> {
  const normalized = normalizeInput(rawInput);
  const actualInventoryDigest = releaseBaselineInventoryDigest(dependencies.inventoryDescriptor);
  if (normalized.inventoryDigest !== actualInventoryDigest) {
    fail(
      "RELEASE_BASELINE_INVENTORY_DIGEST_MISMATCH",
      "显式确认的 inventory digest 与当前受信配置不一致",
      409,
      { actualInventoryDigest },
    );
  }
  const expectedConfirmation = releaseBaselineConfirmation(normalized);
  if (normalized.confirmation !== expectedConfirmation) {
    fail(
      "RELEASE_BASELINE_CONFIRMATION_MISMATCH",
      "confirmation 与 release/artifact/inventory 身份不一致",
      400,
    );
  }
  const targets = assertTargetInventory(dependencies.targets);
  const interval = dependencies.confirmationIntervalMs ?? DEFAULT_CONFIRMATION_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 0 || interval > MAX_CONFIRMATION_INTERVAL_MS) {
    fail("RELEASE_BASELINE_CONFIGURATION_INVALID", "双快照确认间隔配置无效", 500);
  }
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? (async (milliseconds: number) => {
    if (milliseconds > 0) await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
  const signal = dependencies.signal ?? new AbortController().signal;
  if (signal.aborted) fail("RELEASE_BASELINE_ABORTED", "基线核验已中止", 503);

  const artifact = await dependencies.loadArtifact(normalized.artifactId);
  if (artifact.id !== normalized.artifactId
    || artifact.releaseId !== normalized.releaseId
    || artifact.status !== "ready"
    || artifact.revision !== normalized.artifactRevision
    || artifact.manifest.releaseId !== normalized.releaseId
    || artifact.manifest.schemaMode !== "schema-neutral"
    || !hasExactArtifactGeneration(artifact)) {
    fail("RELEASE_BASELINE_ARTIFACT_NOT_READY", "目标必须是当前 draft 对应的指定 ready 制品");
  }
  await assertReleaseArtifactSchemaCurrent(artifact, dependencies.database);
  await assertRootWithMfa(dependencies.database, normalized.operatorUserId);
  const plan = buildPlan(normalized, artifact, targets);
  const computedRequestHash = requestHash(normalized, artifact, plan);

  // Independent cache hashing + Ed25519 verification happens before any
  // bootstrap reservation or fleet adapter is created.
  const attestationEvidence = await dependencies.verifyArtifact(artifact, signal);
  if (attestationEvidence.artifactId !== artifact.id
    || attestationEvidence.artifactSha256 !== artifact.sha256
    || attestationEvidence.releaseId !== artifact.releaseId
    || attestationEvidence.schemaVersion !== artifact.manifest.schemaVersion
    || attestationEvidence.workerProtocolVersion !== artifact.manifest.workerProtocolVersion
    || canonicalJson(attestationEvidence.runtimeCapabilities)
      !== canonicalJson(artifact.manifest.runtimeCapabilities)) {
    fail("RELEASE_BASELINE_ARTIFACT_ATTESTATION_MISMATCH", "独立验签结果与 ready 制品身份不一致");
  }

  const reservation = await reserveBootstrap({
    normalized,
    artifact,
    plan,
    requestHash: computedRequestHash,
    database: dependencies.database,
    now: now(),
  });
  // Deliberately outside the verification failure handler: tests use this to
  // model a hard process death. The durable running reservation remains and
  // the exact same idempotency request can safely resume it.
  await dependencies.afterReservation?.(reservation.deploymentId);

  try {
    const firstEvidence = await dependencies.verifyFleet({
      operationId: reservation.deploymentId,
      artifact,
      plan,
      signal,
    });
    assertEvidence(firstEvidence, artifact, plan);
    if (interval > 0) await sleep(interval);
    if (signal.aborted) fail("RELEASE_BASELINE_ABORTED", "基线核验已中止", 503);
    const secondEvidence = await dependencies.verifyFleet({
      operationId: reservation.deploymentId,
      artifact,
      plan,
      signal,
    });
    assertEvidence(secondEvidence, artifact, plan);
    if (evidenceDigest(firstEvidence) !== evidenceDigest(secondEvidence)) {
      fail("RELEASE_BASELINE_FLEET_DRIFT", "两次全量读取之间 API/Worker/CLB 身份发生变化");
    }
    const completedAt = now();
    const checkpoint = completedCheckpoint({
      reservation,
      artifact,
      firstEvidence,
      secondEvidence,
      attestationEvidence,
      inventoryDigest: normalized.inventoryDigest,
      now: completedAt,
    });
    return await finalizeSuccess({
      database: dependencies.database,
      normalized,
      artifact,
      reservation,
      checkpoint,
      firstEvidence,
      secondEvidence,
      now: completedAt,
    });
  } catch (error) {
    try {
      await finalizeFailure({
        database: dependencies.database,
        normalized,
        artifact,
        reservation,
        error,
        now: now(),
      });
    } catch (finalizeError) {
      throw new ReleaseBaselineBootstrapError(
        "RELEASE_BASELINE_FAILURE_FINALIZATION_FAILED",
        "基线核验失败且无法安全释放发布锁，必须人工审计",
        500,
        { originalErrorCode: safeError(error).code, finalizeErrorCode: safeError(finalizeError).code },
      );
    }
    throw error;
  }
}

function assertArtifactAttestation(
  evidence: CachedLegacyBridgeArtifactEvidence,
  artifact: ReleaseArtifactRecord,
  schemaBridge: LegacySchemaBridgeProvenance,
): void {
  const signedCompatibility = evidence.signedSchemaCompatibility;
  if (evidence.artifactId !== artifact.id
    || evidence.artifactSha256 !== artifact.sha256
    || evidence.releaseId !== artifact.releaseId
    || evidence.schemaVersion !== artifact.manifest.schemaVersion
    || evidence.workerProtocolVersion !== artifact.manifest.workerProtocolVersion
    || canonicalJson(evidence.runtimeCapabilities)
      !== canonicalJson(artifact.manifest.runtimeCapabilities)
    || signedCompatibility.binarySchemaVersion
      !== schemaBridge.migration.fromVersion
    || canonicalJson(signedCompatibility.supportedDatabaseVersions)
      !== canonicalJson([
        schemaBridge.migration.fromVersion,
        schemaBridge.migration.toVersion,
      ])
    || !signedCompatibility.migration
    || !sameReleaseSchemaMigrationEdge(
      signedCompatibility.migration,
      schemaBridge.migration,
    )) {
    fail(
      "RELEASE_BASELINE_ARTIFACT_ATTESTATION_MISMATCH",
      "独立验签结果与 ready 制品身份不一致",
    );
  }
}

function persistedGenerationArtifact(input: {
  row: RawRow | undefined;
  legacyArtifact: ReleaseArtifactRecord;
  normalized: ReleaseBaselineBootstrapInput;
}): ReleaseArtifactRecord {
  const { row, legacyArtifact, normalized } = input;
  if (!row) {
    fail("RELEASE_BASELINE_ARTIFACT_IDENTITY_CHANGED", "来源升级制品记录不存在");
  }
  const artifact: ReleaseArtifactRecord = {
    ...legacyArtifact,
    uploadReservationId: row.uploadReservationId == null
      ? null
      : String(row.uploadReservationId),
    storageProvider: row.storageProvider == null
      ? null
      : String(row.storageProvider) as "s3" | "tos",
    storageBucket: row.storageBucket == null ? null : String(row.storageBucket),
    storageRegion: row.storageRegion == null ? null : String(row.storageRegion),
    storageEndpoint: row.storageEndpoint == null ? null : String(row.storageEndpoint),
    storageKeyPrefix: row.storageKeyPrefix == null ? null : String(row.storageKeyPrefix),
    storageForcePathStyle: row.storageForcePathStyle == null
      ? null
      : Boolean(row.storageForcePathStyle),
    storageVersionId: row.storageVersionId == null ? null : String(row.storageVersionId),
    storageEtag: row.storageEtag == null ? null : String(row.storageEtag),
    storageRequestId: row.storageRequestId == null ? null : String(row.storageRequestId),
    storageCapturedAt: row.storageCapturedAt == null
      ? null
      : Number(row.storageCapturedAt),
    revision: Number(row.revision),
    updatedAt: Number(row.updatedAt),
  };
  if (artifact.revision !== normalized.artifactRevision + 1
    || !hasExactArtifactGeneration(artifact)) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_PARTIAL_EVIDENCE",
      "来源升级结果不是完整且唯一的 exact generation",
    );
  }
  assertArtifactRowIdentity(row, artifact, artifact.revision);
  return artifact;
}

function provenanceRequestHash(input: {
  normalized: ReleaseBaselineBootstrapInput;
  artifact: ReleaseArtifactRecord;
  plan: ReleaseDeploymentPlan;
  baseline: PublishedBaselineIdentity;
  contentType: string;
  schemaBridge: LegacySchemaBridgeProvenance;
}): string {
  const { normalized, artifact, plan, baseline } = input;
  return sha256(canonicalJson({
    mode: LEGACY_PROVENANCE_UPGRADE_MODE,
    channel: normalized.channel,
    environment: normalized.environment,
    scope: normalized.scope,
    releaseId: normalized.releaseId,
    releaseRevision: normalized.releaseRevision,
    deployment: {
      id: String(baseline.deployment.id),
      revision: Number(baseline.deployment.revision),
      requestHash: String(baseline.deployment.requestHash),
      completedAt: Number(baseline.deployment.completedAt),
    },
    artifactId: normalized.artifactId,
    artifactRevisionBeforeUpgrade: normalized.artifactRevision,
    artifactRevisionAfterUpgrade: normalized.artifactRevision + 1,
    operatorUserId: normalized.operatorUserId,
    inventoryDigest: normalized.inventoryDigest,
    schemaBridge: input.schemaBridge,
    artifactIdentity: {
      ...artifactIdentity(artifact),
      // The final DB revision is a CAS result, not part of the signed legacy
      // identity supplied by the operator.
      revision: normalized.artifactRevision,
    },
    contentType: input.contentType,
    targets: plan.targets,
  }));
}

function assertBaselineUnchanged(
  before: PublishedBaselineIdentity,
  after: PublishedBaselineIdentity,
): void {
  if (String(after.release.id) !== String(before.release.id)
    || Number(after.release.revision) !== Number(before.release.revision)
    || Number(after.release.publishedAt) !== Number(before.release.publishedAt)
    || String(after.deployment.id) !== String(before.deployment.id)
    || Number(after.deployment.revision) !== Number(before.deployment.revision)
    || String(after.deployment.requestHash) !== String(before.deployment.requestHash)
    || Number(after.deployment.completedAt) !== Number(before.deployment.completedAt)
    || String(after.deployment.artifactId) !== String(before.deployment.artifactId)) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_BASELINE_DRIFT",
      "核验期间当前 published baseline 身份发生变化",
    );
  }
}

function assertProvenanceReservation(input: {
  reservation: RawRow | undefined;
  artifact: ReleaseArtifactRecord;
  normalized: ReleaseBaselineBootstrapInput;
  baseline: PublishedBaselineIdentity;
  plan: ReleaseDeploymentPlan;
  schemaBridge: LegacySchemaBridgeProvenance;
}): { requestHash: string; contentType: string } {
  const { reservation, artifact, normalized, baseline, plan } = input;
  const contentType = String(reservation?.contentType || "").trim().toLowerCase();
  const expectedRequestHash = provenanceRequestHash({
    normalized,
    artifact,
    plan,
    baseline,
    contentType,
    schemaBridge: input.schemaBridge,
  });
  if (!reservation
    || String(reservation.id) !== artifact.uploadReservationId
    || String(reservation.releaseId) !== normalized.releaseId
    || Number(reservation.operatorUserId) !== normalized.operatorUserId
    || String(reservation.idempotencyKey) !== provenanceIdempotencyKey(normalized.idempotencyKey)
    || String(reservation.requestHash) !== expectedRequestHash
    || String(reservation.storageKey) !== artifact.storageKey
    || String(reservation.fileName) !== artifact.fileName
    || Number(reservation.declaredByteSize) !== artifact.byteSize
    || contentType !== String(artifact.mediaType || "").trim().toLowerCase()
    || String(reservation.storageProvider) !== artifact.storageProvider
    || String(reservation.storageBucket) !== artifact.storageBucket
    || String(reservation.storageRegion) !== artifact.storageRegion
    || String(reservation.storageEndpoint) !== artifact.storageEndpoint
    || String(reservation.storageKeyPrefix) !== artifact.storageKeyPrefix
    || Boolean(reservation.storageForcePathStyle) !== artifact.storageForcePathStyle
    || String(reservation.status) !== "finalized"
    || String(reservation.finalizedArtifactId) !== artifact.id
    || !Number.isSafeInteger(Number(reservation.finalizedAt))
    || Number(reservation.finalizedAt) < 1
    || Number(reservation.revision) !== 2
    || Number(reservation.expiresAt) <= Number(reservation.createdAt)) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_REPLAY_INVALID",
      "已存在的来源升级 reservation 与最终制品身份不一致",
    );
  }
  return { requestHash: expectedRequestHash, contentType };
}

async function replayProvenanceUpgrade(input: {
  client: BootstrapDb;
  normalized: ReleaseBaselineBootstrapInput;
  artifact: ReleaseArtifactRecord;
  baseline: PublishedBaselineIdentity;
  plan: ReleaseDeploymentPlan;
  schemaBridge: LegacySchemaBridgeProvenance;
}): Promise<ReleaseBaselineProvenanceUpgradeResult> {
  const reservation = await table(
    input.client,
    RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
  )
    .where({ id: input.artifact.uploadReservationId })
    .first();
  const { requestHash } = assertProvenanceReservation({
    reservation,
    artifact: input.artifact,
    normalized: input.normalized,
    baseline: input.baseline,
    plan: input.plan,
    schemaBridge: input.schemaBridge,
  });
  const events = await table(input.client, RELEASE_DEPLOYMENT_EVENT_TABLE)
    .where({
      deploymentId: String(input.baseline.deployment.id),
      eventType: "baseline.provenance_upgraded",
    });
  const audits = await table(input.client, "o_audit_log")
    .where({
      action: "admin.release_baseline.provenance_upgraded",
      resourceId: String(input.baseline.deployment.id),
    });
  const eventPayload = events.length === 1
    ? parseJsonObject(
      events[0].payloadJson,
      "RELEASE_BASELINE_PROVENANCE_REPLAY_INVALID",
      "来源升级 event 证据无效",
    )
    : null;
  const auditMetadata = audits.length === 1
    ? parseJsonObject(
      audits[0].metadata,
      "RELEASE_BASELINE_PROVENANCE_REPLAY_INVALID",
      "来源升级 audit 证据无效",
    )
    : null;
  const compatibilityBefore = eventPayload?.manifestCompatibilityBefore;
  const compatibilityAfter = input.artifact.manifest.schemaCompatibility ?? null;
  const defaultCompatibility = defaultReleaseSchemaCompatibility(
    input.artifact.manifest.schemaVersion,
  );
  const validCompatibilityBefore = compatibilityBefore === null
    || canonicalJson(compatibilityBefore) === canonicalJson(defaultCompatibility)
    || canonicalJson(compatibilityBefore) === canonicalJson(compatibilityAfter);
  if (events.length !== 1
    || audits.length !== 1
    || String(eventPayload?.requestHash || "") !== requestHash
    || String(eventPayload?.reservationId || "") !== input.artifact.uploadReservationId
    || String(auditMetadata?.requestHash || "") !== requestHash
    || String(auditMetadata?.reservationId || "") !== input.artifact.uploadReservationId
    || canonicalJson(eventPayload?.schemaBridge)
      !== canonicalJson(input.schemaBridge)
    || canonicalJson(auditMetadata?.schemaBridge)
      !== canonicalJson(input.schemaBridge)
    || canonicalJson(eventPayload?.targets)
      !== canonicalJson(input.plan.targets)
    || canonicalJson(auditMetadata?.targets)
      !== canonicalJson(input.plan.targets)
    || !validCompatibilityBefore
    || canonicalJson(auditMetadata?.manifestCompatibilityBefore)
      !== canonicalJson(compatibilityBefore)
    || canonicalJson(eventPayload?.manifestCompatibilityAfter)
      !== canonicalJson(compatibilityAfter)
    || canonicalJson(auditMetadata?.manifestCompatibilityAfter)
      !== canonicalJson(compatibilityAfter)) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_REPLAY_INVALID",
      "来源升级的原子 event/audit 证据缺失或冲突",
    );
  }
  return {
    releaseId: input.normalized.releaseId,
    artifactId: input.artifact.id,
    artifactRevision: input.artifact.revision,
    reservationId: input.artifact.uploadReservationId!,
    status: "upgraded",
    idempotent: true,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate?.code === "23505"
    || candidate?.code === "SQLITE_CONSTRAINT"
    || candidate?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || candidate?.errno === 19;
}

async function finalizeProvenanceUpgrade(input: {
  database: Knex;
  normalized: ReleaseBaselineBootstrapInput;
  legacyArtifact: ReleaseArtifactRecord;
  finalArtifact: ReleaseArtifactRecord;
  baseline: PublishedBaselineIdentity;
  plan: ReleaseDeploymentPlan;
  contentType: string;
  firstEvidence: ReleaseBaselineFleetEvidence;
  secondEvidence: ReleaseBaselineFleetEvidence;
  attestationEvidence: CachedLegacyBridgeArtifactEvidence;
  schemaBridge: LegacySchemaBridgeProvenance;
  now: number;
}): Promise<ReleaseBaselineProvenanceUpgradeResult> {
  const requestHash = provenanceRequestHash({
    normalized: input.normalized,
    artifact: input.finalArtifact,
    plan: input.plan,
    baseline: input.baseline,
    contentType: input.contentType,
    schemaBridge: input.schemaBridge,
  });
  try {
    return await input.database.transaction(async (trx) => {
      await acquireReleaseMutationLock(trx);
      const baseline = await currentPublishedBaseline(
        trx,
        input.normalized,
        { lock: true },
      );
      assertBaselineUnchanged(input.baseline, baseline);
      await assertRootWithMfa(trx, input.normalized.operatorUserId);
      await assertNoActiveDeployment(trx);

      const artifactRow = await trx(RELEASE_ARTIFACT_TABLE)
        .where({
          id: input.normalized.artifactId,
          releaseId: input.normalized.releaseId,
          status: "ready",
        })
        .forUpdate()
        .first();
      if (!artifactRow) {
        fail("RELEASE_BASELINE_ARTIFACT_IDENTITY_CHANGED", "来源升级制品记录不存在");
      }
      const generationFieldCount = [
        "uploadReservationId",
        "storageProvider",
        "storageBucket",
        "storageRegion",
        "storageEndpoint",
        "storageKeyPrefix",
        "storageForcePathStyle",
        "storageVersionId",
        "storageEtag",
        "storageRequestId",
        "storageCapturedAt",
      ].filter((field) => artifactRow[field] != null).length;
      if (generationFieldCount === 11) {
        const persistedArtifact = persistedGenerationArtifact({
          row: artifactRow,
          legacyArtifact: input.legacyArtifact,
          normalized: input.normalized,
        });
        return replayProvenanceUpgrade({
          client: trx,
          normalized: input.normalized,
          artifact: persistedArtifact,
          baseline,
          plan: buildPlan(input.normalized, persistedArtifact, input.plan.targets),
          schemaBridge: input.schemaBridge,
        });
      }
      if (generationFieldCount !== 0) {
        fail(
          "RELEASE_BASELINE_PROVENANCE_PARTIAL_EVIDENCE",
          "legacy 制品 generation 字段必须全部为空，部分回填已拒绝",
        );
      }
      assertArtifactRowIdentity(
        artifactRow,
        input.legacyArtifact,
        input.normalized.artifactRevision,
      );

      const namespacedIdempotencyKey = provenanceIdempotencyKey(
        input.normalized.idempotencyKey,
      );
      const [idempotencyConflict, storageKeyConflict] = await Promise.all([
        trx(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
          .where({
            operatorUserId: input.normalized.operatorUserId,
            idempotencyKey: namespacedIdempotencyKey,
          })
          .forUpdate()
          .first(),
        trx(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
          .where({ storageKey: input.finalArtifact.storageKey })
          .forUpdate()
          .first(),
      ]);
      if (idempotencyConflict || storageKeyConflict) {
        fail(
          "RELEASE_BASELINE_PROVENANCE_STORAGE_KEY_RESERVED",
          "legacy storageKey 或 idempotencyKey 已被 reservation 占用，需人工审计",
        );
      }

      await trx(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE).insert({
        id: input.finalArtifact.uploadReservationId,
        releaseId: input.normalized.releaseId,
        operatorUserId: input.normalized.operatorUserId,
        idempotencyKey: namespacedIdempotencyKey,
        requestHash,
        storageKey: input.finalArtifact.storageKey,
        fileName: input.finalArtifact.fileName,
        declaredByteSize: input.finalArtifact.byteSize,
        contentType: input.contentType,
        storageProvider: input.finalArtifact.storageProvider,
        storageBucket: input.finalArtifact.storageBucket,
        storageRegion: input.finalArtifact.storageRegion,
        storageEndpoint: input.finalArtifact.storageEndpoint,
        storageKeyPrefix: input.finalArtifact.storageKeyPrefix,
        storageForcePathStyle: input.finalArtifact.storageForcePathStyle,
        status: "finalized",
        expiresAt: input.now + 900_000,
        finalizedArtifactId: input.finalArtifact.id,
        finalizedAt: input.now,
        revision: 2,
        createdAt: input.now,
        updatedAt: input.now,
      });

      let artifactUpdate = trx(RELEASE_ARTIFACT_TABLE)
        .where({
          id: input.normalized.artifactId,
          releaseId: input.normalized.releaseId,
          status: "ready",
          revision: input.normalized.artifactRevision,
        });
      for (const field of [
        "uploadReservationId",
        "storageProvider",
        "storageBucket",
        "storageRegion",
        "storageEndpoint",
        "storageKeyPrefix",
        "storageForcePathStyle",
        "storageVersionId",
        "storageEtag",
        "storageRequestId",
        "storageCapturedAt",
      ]) {
        artifactUpdate = artifactUpdate.whereNull(field);
      }
      const updated = await artifactUpdate.update({
        uploadReservationId: input.finalArtifact.uploadReservationId,
        storageProvider: input.finalArtifact.storageProvider,
        storageBucket: input.finalArtifact.storageBucket,
        storageRegion: input.finalArtifact.storageRegion,
        storageEndpoint: input.finalArtifact.storageEndpoint,
        storageKeyPrefix: input.finalArtifact.storageKeyPrefix,
        storageForcePathStyle: input.finalArtifact.storageForcePathStyle,
        storageVersionId: input.finalArtifact.storageVersionId,
        storageEtag: input.finalArtifact.storageEtag,
        storageRequestId: input.finalArtifact.storageRequestId,
        storageCapturedAt: input.finalArtifact.storageCapturedAt,
        manifestJson: JSON.stringify(input.finalArtifact.manifest),
        updatedAt: input.now,
        revision: input.normalized.artifactRevision + 1,
      });
      if (Number(updated) !== 1) {
        fail(
          "RELEASE_BASELINE_PROVENANCE_WRITE_CONFLICT",
          "exact generation 来源写入发生 CAS 冲突",
        );
      }

      const sequenceRow = await trx(RELEASE_DEPLOYMENT_EVENT_TABLE)
        .where({ deploymentId: String(baseline.deployment.id) })
        .max({ sequence: "sequence" })
        .first();
      const finalEvidenceDigest = evidenceDigest(input.secondEvidence);
      await appendEvent(trx, {
        deploymentId: String(baseline.deployment.id),
        sequence: Number(sequenceRow?.sequence || 0) + 1,
        eventType: "baseline.provenance_upgraded",
        phase: "success",
        level: "warning",
        actor: "operator",
        actorUserId: input.normalized.operatorUserId,
        message: "旧生产基线已通过 exact-generation 双快照核验并补齐来源链",
        payload: {
          mode: LEGACY_PROVENANCE_UPGRADE_MODE,
          releaseId: input.normalized.releaseId,
          artifactId: input.finalArtifact.id,
          reservationId: input.finalArtifact.uploadReservationId,
          requestHash,
          inventoryDigest: input.normalized.inventoryDigest,
          firstEvidenceDigest: evidenceDigest(input.firstEvidence),
          secondEvidenceDigest: finalEvidenceDigest,
          attestationKeyId: input.attestationEvidence.attestation.keyId,
          attestationPayloadSha256: input.attestationEvidence.attestation.payloadSha256,
          schemaBridge: input.schemaBridge,
          targets: input.plan.targets,
          manifestCompatibilityBefore:
            input.legacyArtifact.manifest.schemaCompatibility ?? null,
          manifestCompatibilityAfter:
            input.finalArtifact.manifest.schemaCompatibility ?? null,
        },
        now: input.now,
      });
      await appendAudit(trx, {
        action: "admin.release_baseline.provenance_upgraded",
        resourceId: String(baseline.deployment.id),
        actorUserId: input.normalized.operatorUserId,
        metadata: {
          mode: LEGACY_PROVENANCE_UPGRADE_MODE,
          releaseId: input.normalized.releaseId,
          artifactId: input.finalArtifact.id,
          reservationId: input.finalArtifact.uploadReservationId,
          requestHash,
          artifactRevisionBefore: input.normalized.artifactRevision,
          artifactRevisionAfter: input.normalized.artifactRevision + 1,
          storageProvider: input.finalArtifact.storageProvider,
          storageVersionId: input.finalArtifact.storageVersionId,
          storageEtag: input.finalArtifact.storageEtag,
          storageRequestId: input.finalArtifact.storageRequestId,
          storageCapturedAt: input.finalArtifact.storageCapturedAt,
          inventoryDigest: input.normalized.inventoryDigest,
          evidenceDigest: finalEvidenceDigest,
          verificationPasses: 2,
          schemaBridge: input.schemaBridge,
          targets: input.plan.targets,
          manifestCompatibilityBefore:
            input.legacyArtifact.manifest.schemaCompatibility ?? null,
          manifestCompatibilityAfter:
            input.finalArtifact.manifest.schemaCompatibility ?? null,
        },
        now: input.now,
      });
      return {
        releaseId: input.normalized.releaseId,
        artifactId: input.finalArtifact.id,
        artifactRevision: input.normalized.artifactRevision + 1,
        reservationId: input.finalArtifact.uploadReservationId!,
        status: "upgraded",
        idempotent: false,
      };
    });
  } catch (error) {
    if (error instanceof ReleaseBaselineBootstrapError) throw error;
    if (isUniqueConstraintError(error)) {
      fail(
        "RELEASE_BASELINE_PROVENANCE_STORAGE_KEY_RESERVED",
        "legacy storageKey 或 idempotencyKey 已被并发 reservation 占用，需人工审计",
      );
    }
    throw error;
  }
}

export async function upgradeReleaseBaselineArtifactProvenance(
  rawInput: ReleaseBaselineBootstrapInput,
  dependencies: ReleaseBaselineProvenanceUpgradeDependencies,
): Promise<ReleaseBaselineProvenanceUpgradeResult> {
  const normalized = normalizeInput(rawInput);
  const actualInventoryDigest = releaseBaselineInventoryDigest(
    dependencies.inventoryDescriptor,
  );
  if (normalized.inventoryDigest !== actualInventoryDigest) {
    fail(
      "RELEASE_BASELINE_INVENTORY_DIGEST_MISMATCH",
      "显式确认的 inventory digest 与当前受信配置不一致",
      409,
      { actualInventoryDigest },
    );
  }
  if (normalized.confirmation !== releaseBaselineConfirmation(normalized)) {
    fail(
      "RELEASE_BASELINE_CONFIRMATION_MISMATCH",
      "confirmation 与 release/artifact/inventory 身份不一致",
      400,
    );
  }
  assertRemoteProvenanceConfiguration(dependencies.storageConfiguration);
  const targets = assertTargetInventory(dependencies.targets);
  const interval = dependencies.confirmationIntervalMs
    ?? DEFAULT_CONFIRMATION_INTERVAL_MS;
  if (!Number.isSafeInteger(interval)
    || interval < 0
    || interval > MAX_CONFIRMATION_INTERVAL_MS) {
    fail(
      "RELEASE_BASELINE_CONFIGURATION_INVALID",
      "双快照确认间隔配置无效",
      500,
    );
  }
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? (async (milliseconds: number) => {
    if (milliseconds > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    }
  });
  const signal = dependencies.signal ?? new AbortController().signal;
  if (signal.aborted) {
    fail("RELEASE_BASELINE_ABORTED", "基线核验已中止", 503);
  }

  try {
    await consumeStepUpProof(dependencies.database, {
      proof: dependencies.stepUpAuthorization.proof,
      userId: normalized.operatorUserId,
      sessionId: dependencies.stepUpAuthorization.sessionId,
      scope: "admin.deployment",
    });
  } catch (error) {
    if (error instanceof StepUpError) {
      throw new ReleaseBaselineBootstrapError(
        error.code,
        error.message,
        error.status,
      );
    }
    throw error;
  }
  await assertRootWithMfa(dependencies.database, normalized.operatorUserId);

  const artifact = await dependencies.loadArtifact(normalized.artifactId);
  const schemaBridge = await assertLegacyArtifactSupportsCurrentDatabase(
    artifact,
    dependencies.database,
  );
  const baseline = await currentPublishedBaseline(
    dependencies.database,
    normalized,
  );

  if (hasExactArtifactGeneration(artifact)) {
    return dependencies.database.transaction(async (trx) => {
      await acquireReleaseMutationLock(trx);
      await assertRootWithMfa(trx, normalized.operatorUserId);
      const lockedBaseline = await currentPublishedBaseline(
        trx,
        normalized,
        { lock: true },
      );
      const artifactRow = await trx(RELEASE_ARTIFACT_TABLE)
        .where({
          id: normalized.artifactId,
          releaseId: normalized.releaseId,
          status: "ready",
        })
        .forUpdate()
        .first();
      const persistedArtifact = persistedGenerationArtifact({
        row: artifactRow,
        legacyArtifact: {
          ...artifact,
          uploadReservationId: null,
          storageProvider: null,
          storageBucket: null,
          storageRegion: null,
          storageEndpoint: null,
          storageKeyPrefix: null,
          storageForcePathStyle: null,
          storageVersionId: null,
          storageEtag: null,
          storageRequestId: null,
          storageCapturedAt: null,
          revision: normalized.artifactRevision,
        },
        normalized,
      });
      const plan = buildPlan(normalized, persistedArtifact, targets);
      return replayProvenanceUpgrade({
        client: trx,
        normalized,
        artifact: persistedArtifact,
        baseline: lockedBaseline,
        plan,
        schemaBridge,
      });
    });
  }

  assertLegacyArtifactForProvenanceUpgrade(artifact, normalized);
  await assertNoActiveDeployment(dependencies.database);
  const existingStorageReservation = await dependencies.database(
    RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
  )
    .where({ storageKey: artifact.storageKey })
    .first();
  if (existingStorageReservation) {
    fail(
      "RELEASE_BASELINE_PROVENANCE_STORAGE_KEY_RESERVED",
      "legacy storageKey 已被 reservation 占用，需人工审计",
    );
  }

  const reservationId = crypto.randomUUID();
  const firstGeneration = await dependencies.inspectGeneration(
    artifact.storageKey,
    { versionId: null, signal },
  );
  const candidate = artifactWithGeneration({
    artifact,
    reservationId,
    configuration: dependencies.storageConfiguration,
    snapshot: firstGeneration,
    capturedAt: now(),
  });
  const plan = buildPlan(normalized, candidate.artifact, targets);
  const attestationEvidence = await dependencies.verifyArtifact(
    candidate.artifact,
    signal,
  );
  assertArtifactAttestation(
    attestationEvidence,
    candidate.artifact,
    schemaBridge,
  );

  const operationId = crypto.randomUUID();
  const firstEvidence = await dependencies.verifyFleet({
    operationId,
    artifact: candidate.artifact,
    plan,
    signal,
  });
  assertEvidence(firstEvidence, candidate.artifact, plan);
  if (interval > 0) await sleep(interval);
  if (signal.aborted) {
    fail("RELEASE_BASELINE_ABORTED", "基线核验已中止", 503);
  }
  const secondEvidence = await dependencies.verifyFleet({
    operationId,
    artifact: candidate.artifact,
    plan,
    signal,
  });
  assertEvidence(secondEvidence, candidate.artifact, plan);
  if (evidenceDigest(firstEvidence) !== evidenceDigest(secondEvidence)) {
    fail(
      "RELEASE_BASELINE_FLEET_DRIFT",
      "两次全量读取之间 API/Worker/CLB 身份发生变化",
    );
  }

  const finalGeneration = await dependencies.inspectGeneration(
    artifact.storageKey,
    { versionId: candidate.artifact.storageVersionId, signal },
  );
  assertSameGeneration(
    candidate.artifact,
    finalGeneration,
    dependencies.storageConfiguration,
    candidate.contentType,
  );
  const finalArtifact: ReleaseArtifactRecord = {
    ...candidate.artifact,
    manifest: {
      ...candidate.artifact.manifest,
      schemaCompatibility: attestationEvidence.signedSchemaCompatibility,
    },
    storageRequestId: nonEmptyGenerationValue(
      finalGeneration.requestId,
      "RELEASE_BASELINE_PROVENANCE_RECEIPT_INCOMPLETE",
    ),
    storageCapturedAt: now(),
  };
  return finalizeProvenanceUpgrade({
    database: dependencies.database,
    normalized,
    legacyArtifact: artifact,
    finalArtifact,
    baseline,
    plan,
    contentType: candidate.contentType,
    firstEvidence,
    secondEvidence,
    attestationEvidence,
    schemaBridge,
    now: now(),
  });
}
