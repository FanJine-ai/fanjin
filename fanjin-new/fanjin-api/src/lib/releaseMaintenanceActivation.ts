import crypto from "node:crypto";
import path from "node:path";

import type { Knex } from "knex";

import {
  DATABASE_MIGRATIONS,
  inspectDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationStatus,
} from "@/lib/databaseMigrations";
import {
  RELEASE_ARTIFACT_TABLE,
  RELEASE_DEPLOYMENT_EVENT_TABLE,
  RELEASE_DEPLOYMENT_TABLE,
  RELEASE_DEPLOYMENT_TARGET_TABLE,
} from "@/lib/migrations/releaseDeploymentOrchestration";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import { isPostgresClient } from "@/lib/dbDialect";
import {
  parseReleaseArtifactManifest,
  type ReleaseArtifactAttestationRecord,
  type ReleaseArtifactManifestV1,
} from "@/lib/releaseArtifactManifest";
import { ReleaseDeploymentError } from "@/lib/releaseDeploymentError";
import {
  assertReleaseFullMaintenancePrivateValidationIntent,
  type ReleaseFullMaintenancePrivateValidationIntent,
} from "@/lib/releaseFullMaintenancePrivateValidationIntent";
import type { TrustedReleaseTarget } from "@/lib/releaseTargetInventory";
import type { CachedReleaseArtifactEvidence } from "@/release-controller/artifactAttestation";

export const RELEASE_MAINTENANCE_ACTIVATION_FORMAT =
  "fanjin-release-maintenance-activation/v1" as const;
export const RELEASE_MAINTENANCE_PRESTAGE_FORMAT =
  "fanjin-release-maintenance-prestage/v1" as const;
export const RELEASE_CONTROLLER_STOPPED_FORMAT =
  "fanjin-release-controller-stopped/v1" as const;
export const RELEASE_MAINTENANCE_ACTIVATION_PHASE =
  "maintenance-preauthorized" as const;
export const RELEASE_MAINTENANCE_TRAFFIC_MODE = "full-maintenance" as const;
export const RELEASE_FULL_MAINTENANCE_TRAFFIC_BARRIER_FORMAT =
  "fanjin-release-full-maintenance-traffic-barrier/v1" as const;
export const RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID =
  "lsn-13g0rjw349pts3n6nu4vgf2gu" as const;
export const RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID =
  "lsn-13f8a4c686akg3n6nu4pqeznv" as const;
export const RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION = 40 as const;
export const RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION = 48 as const;
// This emergency activation contract is permanently bound to the reviewed
// schema 40 -> 48 migration edge. Later additive migrations belong to their
// own release path and must not silently change this contract's digests.
export const RELEASE_MAINTENANCE_DATABASE_MIGRATIONS: readonly DatabaseMigration[] =
  Object.freeze(DATABASE_MIGRATIONS.slice(
    0,
    RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION,
  ));
export const RELEASE_MAINTENANCE_ACTIVATION_TTL_MS = 5 * 60_000;
export const RELEASE_MAINTENANCE_TOPOLOGY_MAX_AGE_MS = 5 * 60_000;
export const RELEASE_MAINTENANCE_TOPOLOGY_BINDING_FORMAT =
  "fanjin-release-maintenance-topology-binding/v1" as const;
export const RELEASE_MAINTENANCE_TOPOLOGY_RECEIPT_SCHEMA =
  "fanjin.release-0.1.1-production-topology-discovery-receipt/v1" as const;
export const RELEASE_MAINTENANCE_TOPOLOGY_INVENTORY_FORMAT =
  "fanjin.release-0.1.1-public-node-inventory/v1" as const;
export const RELEASE_MAINTENANCE_TOPOLOGY_REGION = "cn-beijing" as const;
export const RELEASE_MAINTENANCE_TOPOLOGY_PROJECT = "default" as const;
export const RELEASE_MAINTENANCE_TOPOLOGY_CLB_HOST =
  "clb.cn-beijing.volcengineapi.com" as const;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_RE = /^[a-f0-9]{40}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/u;
const SAFE_NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/u;
const POSTGRES_ROLE_RE = /^[a-z_][a-z0-9_$]{0,62}$/u;
const CONTROLLER_EVIDENCE_MAX_AGE_MS = 10 * 60_000;
const PRESTAGE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60_000;
const TOPOLOGY_FUTURE_TOLERANCE_MS = 30_000;
const RELEASE_MUTATION_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))";
const RELEASE_CONTROLLER_UNIT_FILE_STATES = new Set([
  "enabled", "enabled-runtime", "disabled", "static", "indirect",
  "linked", "linked-runtime", "alias", "generated", "transient",
  "masked", "masked-runtime",
]);

type ReleaseDb = Knex | Knex.Transaction;
type RawRow = Record<string, unknown>;

export interface ConsumedMaintenanceStepUpProof {
  proofRecordId: string;
  scope: "admin.deployment";
  method: "password" | "totp" | "recovery";
  actorRole: string;
  authorizationRevision: number;
  expiresAt: number;
  consumedAt: number;
}

export class ReleaseMaintenanceActivationError extends ReleaseDeploymentError {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, 409, code, details);
    this.name = "ReleaseMaintenanceActivationError";
  }
}

function fail(message: string, code: string, details?: Record<string, unknown>): never {
  throw new ReleaseMaintenanceActivationError(message, code, details);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Keep this module safe for the offline maintenance entrypoint: importing the
// normal release repository would initialize the application DB runtime (and
// can start schema-readiness work) before this explicit schema-40 gate runs.
async function acquireMaintenanceMutationLock(trx: Knex.Transaction): Promise<void> {
  if (!isPostgresClient(trx)) return;
  await trx.raw(RELEASE_MUTATION_LOCK_SQL, [
    "fanjin-release-deployment",
    "production-fleet",
  ]);
}

function objectDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function tokenMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Side-effect-free narrow consumer for the existing admin.deployment proof.
 * It mirrors the normal step-up consumer but intentionally avoids importing
 * the application auth/mailer graph, which would initialize a schema-current
 * application database client before the schema-40 maintenance gate.
 */
export async function consumeMaintenanceDeploymentStepUpProof(
  trx: Knex.Transaction,
  input: { proof: string; userId: number; sessionId: string; now?: number },
): Promise<ConsumedMaintenanceStepUpProof> {
  if (!(trx as Knex.Transaction).isTransaction) {
    fail("维护授权必须在预留事务内消费", "RELEASE_MAINTENANCE_AUTH_TRANSACTION_REQUIRED");
  }
  const proof = String(input.proof || "").trim();
  const sessionId = String(input.sessionId || "").trim();
  if (!proof || !sessionId) {
    fail("维护激活缺少 step-up proof", "RELEASE_MAINTENANCE_ROOT_MFA_REQUIRED");
  }
  const user = await trx("o_user")
    .where({ id: input.userId, status: "active" })
    .forUpdate()
    .first();
  const session = await trx("o_user_session")
    .where({ id: sessionId, userId: input.userId })
    .whereNull("revokedAt")
    .forUpdate()
    .first();
  const security = await trx("o_account_security")
    .where({ userId: input.userId })
    .forUpdate()
    .first();
  if (!user || !session || !security || String(user.role) !== "root") {
    fail("Root 会话或 MFA 配置不可用", "RELEASE_MAINTENANCE_ROOT_MFA_REQUIRED");
  }
  const family = await trx("o_auth_token")
    .where({ userId: input.userId, type: "step_up_proof" })
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .forUpdate()
    .select("*");
  const proofHash = sha256(proof);
  const row = (family as RawRow[]).find((candidate) => (
    String(candidate.tokenHash) === proofHash && candidate.usedAt == null
  ));
  if (!row) fail("step-up proof 无效或已使用", "RELEASE_MAINTENANCE_STEP_UP_INVALID");
  const now = input.now ?? Date.now();
  const invalidateUnusedFamily = async () => {
    await trx("o_auth_token")
      .where({ userId: input.userId, type: "step_up_proof" })
      .whereNull("usedAt")
      .update({ usedAt: now });
  };
  if (Number(row.expiresAt || 0) <= now) {
    await invalidateUnusedFamily();
    fail("step-up proof 已过期", "RELEASE_MAINTENANCE_STEP_UP_EXPIRED");
  }
  const metadata = tokenMetadata(row.metadata);
  const method = String(metadata.method || "password");
  const currentMfaGeneration = `${security.mfaEnabled ? "enabled" : "disabled"}:${Number(security.updatedAt || 0)}`;
  const credentialsMatch = (
    String(metadata.scope || "") === "admin.deployment"
    && String(metadata.sessionId || "") === sessionId
    && String(row.workspaceId || "") === String(session.workspaceId || "")
    && String(metadata.passwordVersion || "") === sha256(String(user.password || ""))
    && Number(metadata.authGeneration) === Number(user.updatedAt || 0)
    && String(metadata.mfaGeneration || "") === currentMfaGeneration
    && Boolean(security.mfaEnabled)
    && (method === "totp" || method === "recovery")
  );
  if (!credentialsMatch) {
    await invalidateUnusedFamily();
    fail("Root MFA 凭据状态已变化或 scope 不匹配", "RELEASE_MAINTENANCE_ROOT_MFA_REQUIRED");
  }
  const authorizationRevision = Number(user.authorizationRevision ?? 1);
  if (!Number.isSafeInteger(authorizationRevision) || authorizationRevision < 1) {
    await invalidateUnusedFamily();
    fail("Root 授权版本无效", "RELEASE_MAINTENANCE_ROOT_MFA_REQUIRED");
  }
  const consumed = await trx("o_auth_token")
    .where({ id: row.id, userId: input.userId, type: "step_up_proof" })
    .whereNull("usedAt")
    .update({ usedAt: now });
  if (Number(consumed) !== 1) {
    fail("step-up proof 已被并发消费", "RELEASE_MAINTENANCE_STEP_UP_INVALID");
  }
  const batchId = String(metadata.batchId || "");
  const siblingIds = batchId
    ? (family as RawRow[]).filter((candidate) => (
      candidate.usedAt == null
      && String(candidate.id) !== String(row.id)
      && String(tokenMetadata(candidate.metadata).batchId || "") === batchId
    )).map((candidate) => String(candidate.id))
    : [];
  await trx("o_auth_token")
    .where({ userId: input.userId, type: "step_up_proof" })
    .whereNot({ id: row.id })
    .modify((query) => {
      if (siblingIds.length) query.whereNotIn("id", siblingIds);
    })
    .whereNull("usedAt")
    .update({ usedAt: now });
  return {
    proofRecordId: String(row.id),
    scope: "admin.deployment",
    method: method as "totp" | "recovery",
    actorRole: "root",
    authorizationRevision,
    expiresAt: Number(row.expiresAt),
    consumedAt: now,
  };
}

function exactText(value: unknown, label: string, maximum = 255): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    fail(`${label} 格式无效`, "RELEASE_MAINTENANCE_INPUT_INVALID", { field: label });
  }
  return text;
}

function exactId(value: unknown, label: string): string {
  const text = exactText(value, label, 128);
  if (!SAFE_ID_RE.test(text)) {
    fail(`${label} 格式无效`, "RELEASE_MAINTENANCE_INPUT_INVALID", { field: label });
  }
  return text;
}

function exactCloudTopologyId(value: unknown, label: string): string {
  const text = exactText(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(text)) {
    fail(`${label} 格式无效`, "RELEASE_MAINTENANCE_INPUT_INVALID", { field: label });
  }
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${label} 格式无效`, "RELEASE_MAINTENANCE_INPUT_INVALID", { field: label });
  }
  return parsed;
}

function exactSha256(value: unknown, label: string): string {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!SHA256_RE.test(digest)) {
    fail(`${label} 格式无效`, "RELEASE_MAINTENANCE_INPUT_INVALID", { field: label });
  }
  return digest;
}

function exactSourceCommit(value: unknown, label: string): string {
  const sourceCommit = String(value ?? "").trim().toLowerCase();
  if (!SOURCE_COMMIT_RE.test(sourceCommit)) {
    fail(`${label} 格式无效`, "RELEASE_MAINTENANCE_INPUT_INVALID", { field: label });
  }
  return sourceCommit;
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail(`${label} 不是有效 JSON`, "RELEASE_MAINTENANCE_LEDGER_INVALID");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label} 不是 JSON object`, "RELEASE_MAINTENANCE_LEDGER_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function exactRoles(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) {
    fail(`${label} 无效`, "RELEASE_MAINTENANCE_DATABASE_ROLES_INVALID");
  }
  const roles = values.map((value) => String(value || "").trim()).sort();
  if (
    roles.some((role) => !POSTGRES_ROLE_RE.test(role))
    || new Set(roles).size !== roles.length
  ) {
    fail(`${label} 无效`, "RELEASE_MAINTENANCE_DATABASE_ROLES_INVALID");
  }
  return roles;
}

function timestamp(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${label} 无效`, "RELEASE_MAINTENANCE_EVIDENCE_INVALID");
  }
  return parsed;
}

export interface ReleaseMaintenanceArtifact extends ReleaseArtifactAttestationRecord {
  revision: number;
  storageKey: string;
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
}

export interface ReleaseMaintenancePrestageTargetEvidence {
  targetKey: string;
  serverId: string;
  role: "api" | "worker";
  artifactSha256: string;
  signedManifestFileSha256: string;
  verifiedAt: number;
}

export interface ReleaseMaintenancePrestageEvidence {
  format: typeof RELEASE_MAINTENANCE_PRESTAGE_FORMAT;
  releaseId: string;
  artifactId: string;
  artifactSha256: string;
  signedManifestFileSha256: string;
  inventorySha256: string;
  targets: ReleaseMaintenancePrestageTargetEvidence[];
  createdAt: number;
  evidenceSha256: string;
}

export interface ReleaseControllerStoppedEvidence {
  format: typeof RELEASE_CONTROLLER_STOPPED_FORMAT;
  serviceName: "fanjin-release-controller.service";
  loadState: "loaded";
  activeState: "inactive";
  subState: "dead";
  fragmentPath: "/etc/systemd/system/fanjin-release-controller.service";
  unitFileState: string;
  unitFileSha256: string;
  hostIdentitySha256: string;
  observedAt: number;
  evidenceSha256: string;
}

export interface ReleaseMaintenanceArtifactIdentity {
  releaseId: string;
  artifactId: string;
  artifactRevision: number;
  artifactSha256: string;
  signedManifestFileSha256: string;
  sourceCommit: string;
  schemaVersion: number;
  workerProtocolVersion: number;
  runtimeCapabilities: readonly string[];
  deployment?: ReleaseArtifactManifestV1["deployment"];
  attestation: {
    keyId: string;
    payloadSha256: string;
  };
  generation: {
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
  };
}

export interface ReleaseMaintenanceReservationCheckpoint {
  format: typeof RELEASE_MAINTENANCE_ACTIVATION_FORMAT;
  trafficMode: typeof RELEASE_MAINTENANCE_TRAFFIC_MODE;
  operationId: string;
  phase: typeof RELEASE_MAINTENANCE_ACTIVATION_PHASE;
  status: "running";
  contractSha256: string;
  requestSha256: string;
  nonceSha256: string;
  writerQuiescenceProofSha256: null;
  backupCheckpointEvidenceSha256: null;
  maintenanceBackfillReceiptSha256: null;
  revision: 1;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseFullMaintenanceTrafficBarrierBinding {
  format: typeof RELEASE_FULL_MAINTENANCE_TRAFFIC_BARRIER_FORMAT;
  provider: "volcengine-clb";
  loadBalancerId: string;
  serverGroupId: string;
  backends: readonly {
    nodeId: string;
    serverId: string;
    port: number;
    originalWeight: number;
  }[];
  listeners: readonly [
    {
      protocol: "HTTP";
      listenerId: typeof RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID;
      port: 80;
      baselineEnabled: "on";
      baselineStatus: "Active";
    },
    {
      protocol: "HTTPS";
      listenerId: typeof RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID;
      port: 443;
      baselineEnabled: "on";
      baselineStatus: "Active";
    },
  ];
  bindingSha256: string;
}

export interface ReleaseMaintenanceTopologyDiscoveryInput {
  receiptSha256: string;
  inventorySha256: string;
  receipt: unknown;
  inventory: unknown;
}

export interface ReleaseMaintenanceTopologyBinding {
  format: typeof RELEASE_MAINTENANCE_TOPOLOGY_BINDING_FORMAT;
  region: typeof RELEASE_MAINTENANCE_TOPOLOGY_REGION;
  projectName: typeof RELEASE_MAINTENANCE_TOPOLOGY_PROJECT;
  listenerIds: {
    http: typeof RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID;
    https: typeof RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID;
  };
  receiptSha256: string;
  inventorySha256: string;
  receiptDigest: string;
  capturedAt: string;
  businessSha256: string;
}

export interface ReleaseMaintenanceActivationContract {
  format: typeof RELEASE_MAINTENANCE_ACTIVATION_FORMAT;
  /** Absent only on a legacy v1 canary execution recovered from durable state. */
  trafficMode?: typeof RELEASE_MAINTENANCE_TRAFFIC_MODE;
  deploymentId: string;
  requestSha256: string;
  nonceSha256: string;
  environment: "production";
  scope: string;
  previous: ReleaseMaintenanceArtifactIdentity & {
    releaseRevision: number;
    releaseVersion: string;
    channel: "stable" | "beta" | "internal";
    deploymentId: string;
    deploymentRevision: number;
  };
  target: ReleaseMaintenanceArtifactIdentity & {
    releaseRevision: number;
    releaseVersion: string;
    channel: "stable" | "beta" | "internal";
  };
  inventory: {
    sha256: string;
    targets: TrustedReleaseTarget[];
  };
  privateApiInventorySha256: string;
  privateValidation: {
    validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
    validationPlanIntentSha256: string;
  };
  publicTrafficBarrier: ReleaseFullMaintenanceTrafficBarrierBinding;
  topology: ReleaseMaintenanceTopologyBinding;
  prestageEvidenceSha256: string;
  prestage: ReleaseMaintenancePrestageEvidence;
  controllerStoppedEvidenceSha256: string;
  controllerStopped: ReleaseControllerStoppedEvidence;
  databaseRoles: {
    allowedDatabaseRoles: string[];
    applicationDatabaseRoles: string[];
    sha256: string;
  };
  migration: {
    runId: string;
    fromVersion: typeof RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION;
    toVersion: typeof RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION;
    registrySha256: string;
    appliedPrefixSha256: string;
    pendingSuffixSha256: string;
  };
  authorization: {
    proofRecordId: string;
    scope: "admin.deployment";
    method: "totp" | "recovery";
    authorizationRevision: number;
    expiresAt: number;
    consumedAt: number;
  };
  activationExpiresAt: number;
  createdAt: number;
  contractSha256: string;
}

export interface ReleaseMaintenanceActivationInput {
  releaseId: string;
  artifactId: string;
  releaseRevision: number;
  artifactRevision: number;
  channel: "stable" | "beta" | "internal";
  environment: "production";
  trafficMode: typeof RELEASE_MAINTENANCE_TRAFFIC_MODE;
  expectedLoadBalancerId: string;
  expectedServerGroupId: string;
  expectedApiBackends: readonly {
    nodeId: string;
    serverId: string;
    port: number;
    originalWeight: number;
  }[];
  expectedPrivateApiInventorySha256: string;
  topology: ReleaseMaintenanceTopologyDiscoveryInput;
  privateValidation: {
    validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
    validationPlanIntentSha256: string;
  };
  scope: string;
  operatorUserId: number;
  idempotencyKey: string;
  nonce: string;
  migrationRunId: string;
  expectedPreviousReleaseId: string;
  expectedPreviousArtifactId: string;
  expectedPreviousArtifactSha256: string;
  expectedPreviousSourceCommit: string;
  expectedTargetArtifactSha256: string;
  expectedTargetSourceCommit: string;
  targets: readonly TrustedReleaseTarget[];
  prestageEvidence: ReleaseMaintenancePrestageEvidence;
  controllerStoppedEvidence: ReleaseControllerStoppedEvidence;
  allowedDatabaseRoles: readonly string[];
  applicationDatabaseRoles: readonly string[];
  confirmation: string;
  stepUpAuthorization: {
    proof: string;
    sessionId: string;
  };
}

export interface ReleaseMaintenanceActivationDependencies {
  database: Knex;
  verifyArtifact: (
    artifact: ReleaseMaintenanceArtifact,
    purpose: "previous" | "target",
  ) => Promise<CachedReleaseArtifactEvidence>;
  inspectControllerStopped: () => (
    ReleaseControllerStoppedEvidence | Promise<ReleaseControllerStoppedEvidence>
  );
  inspectMigrations?: (
    database: Knex | Knex.Transaction,
    definitions: readonly DatabaseMigration[],
  ) => Promise<DatabaseMigrationStatus>;
  consumeAuthorization?: (
    trx: Knex.Transaction,
    input: ReleaseMaintenanceActivationInput,
  ) => Promise<ConsumedMaintenanceStepUpProof>;
  now?: () => number;
  randomUUID?: () => string;
}

export interface ReleaseMaintenanceActivationReservation {
  deploymentId: string;
  releaseId: string;
  artifactId: string;
  status: "running";
  phase: typeof RELEASE_MAINTENANCE_ACTIVATION_PHASE;
  activeScope: string;
  requestSha256: string;
  contractSha256: string;
  nonceSha256: string;
  activationExpiresAt: number;
  replayed: boolean;
}

export interface ReleaseMaintenanceActivationReservationRead {
  deploymentId: string;
  releaseId: string;
  artifactId: string;
  previousReleaseId: string;
  previousArtifactId: string;
  activeScope: string;
  status: "running";
  phase: typeof RELEASE_MAINTENANCE_ACTIVATION_PHASE;
  revision: 1;
  fencingToken: 1;
  contract: ReleaseMaintenanceActivationContract;
  checkpoint: ReleaseMaintenanceReservationCheckpoint;
  targets: Array<TrustedReleaseTarget & {
    id: string;
    ordinal: number;
    status: "pending";
    revision: 1;
  }>;
}

function normalizedTargets(values: readonly TrustedReleaseTarget[]): TrustedReleaseTarget[] {
  if (!Array.isArray(values) || values.length < 2 || values.length > 500) {
    fail("维护目标清单无效", "RELEASE_MAINTENANCE_INVENTORY_INVALID");
  }
  const targets = values.map((raw) => {
    const key = exactId(raw.key, "target.key");
    const serverId = exactId(raw.serverId, "target.serverId");
    const label = exactText(raw.label, "target.label", 160);
    const role = raw.role;
    if (role !== "api" && role !== "worker") {
      fail("维护目标角色无效", "RELEASE_MAINTENANCE_INVENTORY_INVALID");
    }
    const wave = positiveInteger(raw.wave, "target.wave");
    const zone = raw.zone == null ? undefined : exactText(raw.zone, "target.zone", 128);
    return { key, label, role, serverId, wave, ...(zone ? { zone } : {}) };
  }).sort((left, right) => (
    left.role.localeCompare(right.role)
    || left.wave - right.wave
    || left.key.localeCompare(right.key)
  ));
  if (
    new Set(targets.map(({ key }) => key)).size !== targets.length
    || new Set(targets.map(({ serverId }) => serverId)).size !== targets.length
    || targets.filter(({ role }) => role === "api").length < 2
  ) {
    fail("维护目标清单重复或缺少双 API 节点", "RELEASE_MAINTENANCE_INVENTORY_INVALID");
  }
  const workers = targets.filter(({ role }) => role === "worker").length;
  if (workers === 1) {
    fail("独立 Worker 维护清单至少需要两个节点", "RELEASE_MAINTENANCE_INVENTORY_INVALID");
  }
  return targets;
}

export function releaseMaintenanceInventoryDigest(
  targets: readonly TrustedReleaseTarget[],
): string {
  return objectDigest(normalizedTargets(targets));
}

export function releaseMaintenanceDatabaseRolesDigest(input: {
  allowedDatabaseRoles: readonly string[];
  applicationDatabaseRoles: readonly string[];
}): string {
  const allowedDatabaseRoles = exactRoles(input.allowedDatabaseRoles, "allowedDatabaseRoles");
  const applicationDatabaseRoles = exactRoles(
    input.applicationDatabaseRoles,
    "applicationDatabaseRoles",
  );
  if (applicationDatabaseRoles.some((role) => allowedDatabaseRoles.includes(role))) {
    fail(
      "应用数据库角色不能出现在维护白名单中",
      "RELEASE_MAINTENANCE_DATABASE_ROLES_OVERLAP",
    );
  }
  return objectDigest({ allowedDatabaseRoles, applicationDatabaseRoles });
}

function migrationIdentity(
  migration: Pick<DatabaseMigration, "version" | "name" | "checksum">,
): { version: number; name: string; checksum: string } {
  return {
    version: Number(migration.version),
    name: String(migration.name),
    checksum: String(migration.checksum).toLowerCase(),
  };
}

export function releaseMaintenanceMigrationDigests(
  definitions: readonly DatabaseMigration[] = RELEASE_MAINTENANCE_DATABASE_MIGRATIONS,
): {
  registrySha256: string;
  appliedPrefixSha256: string;
  pendingSuffixSha256: string;
} {
  const identities = definitions.map(migrationIdentity);
  if (
    identities.length !== RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION
    || identities.some((migration, index) => (
      migration.version !== index + 1
      || !migration.name
      || !SHA256_RE.test(migration.checksum)
    ))
  ) {
    fail(
      "维护迁移注册表不是精确的 1–48 不可变链",
      "RELEASE_MAINTENANCE_MIGRATION_REGISTRY_INVALID",
    );
  }
  return {
    registrySha256: objectDigest(identities),
    appliedPrefixSha256: objectDigest(
      identities.slice(0, RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION),
    ),
    pendingSuffixSha256: objectDigest(
      identities.slice(RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION),
    ),
  };
}

export function createReleaseMaintenancePrestageEvidence(input: {
  releaseId: string;
  artifactId: string;
  artifactSha256: string;
  signedManifestFileSha256: string;
  targets: readonly TrustedReleaseTarget[];
  observations: readonly ReleaseMaintenancePrestageTargetEvidence[];
  createdAt: number;
}): ReleaseMaintenancePrestageEvidence {
  const targets = normalizedTargets(input.targets);
  const inventorySha256 = releaseMaintenanceInventoryDigest(targets);
  const artifactSha256 = exactSha256(input.artifactSha256, "artifactSha256");
  const signedManifestFileSha256 = exactSha256(
    input.signedManifestFileSha256,
    "signedManifestFileSha256",
  );
  const observations = input.observations.map((observation) => ({
    targetKey: exactId(observation.targetKey, "prestage.targetKey"),
    serverId: exactId(observation.serverId, "prestage.serverId"),
    role: observation.role,
    artifactSha256: exactSha256(observation.artifactSha256, "prestage.artifactSha256"),
    signedManifestFileSha256: exactSha256(
      observation.signedManifestFileSha256,
      "prestage.signedManifestFileSha256",
    ),
    verifiedAt: timestamp(observation.verifiedAt, "prestage.verifiedAt"),
  })).sort((left, right) => left.targetKey.localeCompare(right.targetKey));
  if (observations.length !== targets.length) {
    fail("预置证据未覆盖全部目标", "RELEASE_MAINTENANCE_PRESTAGE_INCOMPLETE");
  }
  for (const target of targets) {
    const observation = observations.find(({ targetKey }) => targetKey === target.key);
    if (
      !observation
      || observation.serverId !== target.serverId
      || observation.role !== target.role
      || observation.artifactSha256 !== artifactSha256
      || observation.signedManifestFileSha256 !== signedManifestFileSha256
    ) {
      fail("预置证据与受信目标或制品不一致", "RELEASE_MAINTENANCE_PRESTAGE_MISMATCH", {
        targetKey: target.key,
      });
    }
  }
  if (new Set(observations.map(({ targetKey }) => targetKey)).size !== observations.length) {
    fail("预置证据存在重复目标", "RELEASE_MAINTENANCE_PRESTAGE_INCOMPLETE");
  }
  const commitment = {
    format: RELEASE_MAINTENANCE_PRESTAGE_FORMAT,
    releaseId: exactId(input.releaseId, "releaseId"),
    artifactId: exactId(input.artifactId, "artifactId"),
    artifactSha256,
    signedManifestFileSha256,
    inventorySha256,
    targets: observations,
    createdAt: timestamp(input.createdAt, "prestage.createdAt"),
  };
  return { ...commitment, evidenceSha256: objectDigest(commitment) };
}

export function assertReleaseMaintenancePrestageEvidence(
  evidence: ReleaseMaintenancePrestageEvidence,
  expected: {
    releaseId: string;
    artifactId: string;
    artifactSha256: string;
    signedManifestFileSha256: string;
    targets: readonly TrustedReleaseTarget[];
    now: number;
  },
): void {
  const rebuilt = createReleaseMaintenancePrestageEvidence({
    releaseId: expected.releaseId,
    artifactId: expected.artifactId,
    artifactSha256: expected.artifactSha256,
    signedManifestFileSha256: expected.signedManifestFileSha256,
    targets: expected.targets,
    observations: evidence.targets,
    createdAt: evidence.createdAt,
  });
  if (
    evidence.format !== RELEASE_MAINTENANCE_PRESTAGE_FORMAT
    || canonicalJson(evidence) !== canonicalJson(rebuilt)
    || evidence.createdAt > expected.now
    || expected.now - evidence.createdAt > PRESTAGE_EVIDENCE_MAX_AGE_MS
    || evidence.targets.some(({ verifiedAt }) => (
      verifiedAt > expected.now
      || expected.now - verifiedAt > PRESTAGE_EVIDENCE_MAX_AGE_MS
    ))
  ) {
    fail("预置证据无效、过期或被修改", "RELEASE_MAINTENANCE_PRESTAGE_INVALID");
  }
}

export function createReleaseControllerStoppedEvidence(input: {
  unitFileState: string;
  unitFileSha256: string;
  hostIdentitySha256: string;
  observedAt: number;
}): ReleaseControllerStoppedEvidence {
  const unitFileState = exactText(input.unitFileState, "controller.unitFileState", 64);
  if (!RELEASE_CONTROLLER_UNIT_FILE_STATES.has(unitFileState)) {
    fail("发布控制器 unit file state 无效", "RELEASE_MAINTENANCE_CONTROLLER_NOT_STOPPED");
  }
  const commitment = {
    format: RELEASE_CONTROLLER_STOPPED_FORMAT,
    serviceName: "fanjin-release-controller.service" as const,
    loadState: "loaded" as const,
    activeState: "inactive" as const,
    subState: "dead" as const,
    fragmentPath: "/etc/systemd/system/fanjin-release-controller.service" as const,
    unitFileState,
    unitFileSha256: exactSha256(input.unitFileSha256, "controller.unitFileSha256"),
    hostIdentitySha256: exactSha256(input.hostIdentitySha256, "hostIdentitySha256"),
    observedAt: timestamp(input.observedAt, "controller.observedAt"),
  };
  return { ...commitment, evidenceSha256: objectDigest(commitment) };
}

export function assertReleaseControllerStoppedEvidence(
  evidence: ReleaseControllerStoppedEvidence,
  now: number,
): void {
  const rebuilt = createReleaseControllerStoppedEvidence({
    unitFileState: evidence.unitFileState,
    unitFileSha256: evidence.unitFileSha256,
    hostIdentitySha256: evidence.hostIdentitySha256,
    observedAt: evidence.observedAt,
  });
  if (
    evidence.format !== RELEASE_CONTROLLER_STOPPED_FORMAT
    || evidence.serviceName !== "fanjin-release-controller.service"
    || evidence.loadState !== "loaded"
    || evidence.activeState !== "inactive"
    || evidence.subState !== "dead"
    || evidence.fragmentPath !== "/etc/systemd/system/fanjin-release-controller.service"
    || canonicalJson(evidence) !== canonicalJson(rebuilt)
    || evidence.observedAt > now
    || now - evidence.observedAt > CONTROLLER_EVIDENCE_MAX_AGE_MS
  ) {
    fail("独立发布控制器停止证据无效或过期", "RELEASE_MAINTENANCE_CONTROLLER_NOT_STOPPED");
  }
}

export function assertSameReleaseControllerIdentity(
  committed: ReleaseControllerStoppedEvidence,
  current: ReleaseControllerStoppedEvidence,
): void {
  const identity = (evidence: ReleaseControllerStoppedEvidence) => ({
    format: evidence.format,
    serviceName: evidence.serviceName,
    loadState: evidence.loadState,
    activeState: evidence.activeState,
    subState: evidence.subState,
    fragmentPath: evidence.fragmentPath,
    unitFileState: evidence.unitFileState,
    unitFileSha256: evidence.unitFileSha256,
    hostIdentitySha256: evidence.hostIdentitySha256,
  });
  if (canonicalJson(identity(committed)) !== canonicalJson(identity(current))) {
    fail(
      "维护授权提交前发布控制器身份或状态发生变化",
      "RELEASE_MAINTENANCE_CONTROLLER_IDENTITY_CHANGED",
    );
  }
}

interface NormalizedInput extends Omit<ReleaseMaintenanceActivationInput,
  | "targets"
  | "topology"
  | "allowedDatabaseRoles"
  | "applicationDatabaseRoles"
  | "stepUpAuthorization"
> {
  targets: TrustedReleaseTarget[];
  allowedDatabaseRoles: string[];
  applicationDatabaseRoles: string[];
  stepUpAuthorization: { proof: string; sessionId: string };
  nonceSha256: string;
  inventorySha256: string;
  databaseRolesSha256: string;
  publicTrafficBarrier: ReleaseFullMaintenanceTrafficBarrierBinding;
  topology: ReleaseMaintenanceTopologyBinding;
  requestSha256: string;
}

export function releaseFullMaintenanceTrafficBarrierBinding(input: {
  loadBalancerId: string;
  serverGroupId: string;
  backends: readonly {
    nodeId: string;
    serverId: string;
    port: number;
    originalWeight: number;
  }[];
}): ReleaseFullMaintenanceTrafficBarrierBinding {
  if (!Array.isArray(input.backends) || input.backends.length < 2 || input.backends.length > 32) {
    fail(
      "full-maintenance backend 绑定数量无效",
      "RELEASE_MAINTENANCE_TRAFFIC_BARRIER_INVALID",
    );
  }
  const backends = input.backends.map((backend) => ({
    nodeId: exactCloudTopologyId(backend?.nodeId, "publicTrafficBarrier.backend.nodeId"),
    serverId: exactCloudTopologyId(backend?.serverId, "publicTrafficBarrier.backend.serverId"),
    port: positiveInteger(backend?.port, "publicTrafficBarrier.backend.port"),
    originalWeight: positiveInteger(
      backend?.originalWeight,
      "publicTrafficBarrier.backend.originalWeight",
    ),
  })).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (
    backends.some(({ port }) => port > 65_535)
    || backends.some(({ originalWeight }) => originalWeight > 100)
    || new Set(backends.map(({ nodeId }) => nodeId)).size !== backends.length
    || new Set(backends.map(({ serverId }) => serverId)).size !== backends.length
  ) {
    fail(
      "full-maintenance backend 绑定无效",
      "RELEASE_MAINTENANCE_TRAFFIC_BARRIER_INVALID",
    );
  }
  const commitment = {
    format: RELEASE_FULL_MAINTENANCE_TRAFFIC_BARRIER_FORMAT,
    provider: "volcengine-clb" as const,
    loadBalancerId: exactId(input.loadBalancerId, "expectedLoadBalancerId"),
    serverGroupId: exactId(input.serverGroupId, "expectedServerGroupId"),
    backends,
    listeners: [
      {
        protocol: "HTTP" as const,
        listenerId: RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID,
        port: 80 as const,
        baselineEnabled: "on" as const,
        baselineStatus: "Active" as const,
      },
      {
        protocol: "HTTPS" as const,
        listenerId: RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID,
        port: 443 as const,
        baselineEnabled: "on" as const,
        baselineStatus: "Active" as const,
      },
    ] as const,
  };
  return { ...commitment, bindingSha256: objectDigest(commitment) };
}

function assertReleaseFullMaintenanceTrafficBarrierBinding(
  value: ReleaseFullMaintenanceTrafficBarrierBinding,
): void {
  const expected = releaseFullMaintenanceTrafficBarrierBinding({
    loadBalancerId: value?.loadBalancerId,
    serverGroupId: value?.serverGroupId,
    backends: value?.backends,
  });
  if (canonicalJson(value) !== canonicalJson(expected)) {
    fail(
      "full-maintenance 公网断流屏障绑定无效",
      "RELEASE_MAINTENANCE_TRAFFIC_BARRIER_INVALID",
    );
  }
}

function topologyFail(message: string, code = "RELEASE_MAINTENANCE_TOPOLOGY_INVALID"): never {
  fail(message, code);
}

function topologyObject(
  value: unknown,
  label: string,
  exactKeys?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return topologyFail(`${label} 不是 JSON object`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    exactKeys
    && canonicalJson(Object.keys(candidate).sort()) !== canonicalJson([...exactKeys].sort())
  ) {
    return topologyFail(`${label} 字段集合无效`);
  }
  return candidate;
}

function topologyArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) return topologyFail(`${label} 不是 JSON array`);
  return value;
}

function topologyRawSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    return topologyFail(`${label} 不是 raw lowercase SHA-256`);
  }
  return value;
}

function topologyReceiptDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    return topologyFail(`${label} 不是带算法前缀的 SHA-256`);
  }
  return value;
}

function topologyCloudId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value)
  ) {
    return topologyFail(`${label} 云资源标识无效`);
  }
  return value;
}

function topologyPublicId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)
  ) {
    return topologyFail(`${label} 公共节点标识无效`);
  }
  return value;
}

function topologyInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return topologyFail(`${label} 整数无效`);
  }
  return Number(value);
}

function topologyCanonicalSha256(value: unknown): string {
  return sha256(`${canonicalJson(value)}\n`);
}

function topologyDomainDigest(domain: string, value: unknown): string {
  return `sha256:${topologyCanonicalSha256({ domain, value })}`;
}

function topologyCanonicalIso(value: unknown, label: string): { value: string; milliseconds: number } {
  if (typeof value !== "string") return topologyFail(`${label} 时间无效`);
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return topologyFail(`${label} 必须是 canonical ISO-8601 UTC 时间`);
  }
  return { value, milliseconds };
}

function normalizeReleaseMaintenanceTopologyBinding(
  value: unknown,
): ReleaseMaintenanceTopologyBinding {
  const candidate = topologyObject(value, "topology binding", [
    "businessSha256",
    "capturedAt",
    "format",
    "inventorySha256",
    "listenerIds",
    "projectName",
    "receiptDigest",
    "receiptSha256",
    "region",
  ]);
  const listenerIds = topologyObject(candidate.listenerIds, "topology binding listenerIds", [
    "http",
    "https",
  ]);
  const capturedAt = topologyCanonicalIso(candidate.capturedAt, "topology binding capturedAt");
  if (
    candidate.format !== RELEASE_MAINTENANCE_TOPOLOGY_BINDING_FORMAT
    || candidate.region !== RELEASE_MAINTENANCE_TOPOLOGY_REGION
    || candidate.projectName !== RELEASE_MAINTENANCE_TOPOLOGY_PROJECT
    || listenerIds.http !== RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID
    || listenerIds.https !== RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID
  ) {
    return topologyFail("topology binding 固定 region/project/listener 身份无效");
  }
  return {
    format: RELEASE_MAINTENANCE_TOPOLOGY_BINDING_FORMAT,
    region: RELEASE_MAINTENANCE_TOPOLOGY_REGION,
    projectName: RELEASE_MAINTENANCE_TOPOLOGY_PROJECT,
    listenerIds: {
      http: RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID,
      https: RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID,
    },
    receiptSha256: topologyRawSha256(candidate.receiptSha256, "topology receiptSha256"),
    inventorySha256: topologyRawSha256(candidate.inventorySha256, "topology inventorySha256"),
    receiptDigest: topologyReceiptDigest(candidate.receiptDigest, "topology receiptDigest"),
    capturedAt: capturedAt.value,
    businessSha256: topologyRawSha256(candidate.businessSha256, "topology businessSha256"),
  };
}

function assertReleaseMaintenanceTopologyFresh(
  binding: ReleaseMaintenanceTopologyBinding,
  now: number,
): void {
  if (!Number.isSafeInteger(now) || now < 1) {
    fail("topology freshness 校验时间无效", "RELEASE_MAINTENANCE_INPUT_INVALID");
  }
  const capturedAt = topologyCanonicalIso(binding.capturedAt, "topology capturedAt").milliseconds;
  if (
    capturedAt > now + TOPOLOGY_FUTURE_TOLERANCE_MS
    || now - capturedAt > RELEASE_MAINTENANCE_TOPOLOGY_MAX_AGE_MS
  ) {
    topologyFail(
      "production topology receipt 已过期或来自未来",
      "RELEASE_MAINTENANCE_TOPOLOGY_STALE",
    );
  }
}

function exactSortedSet(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function releaseMaintenanceTopologyBinding(
  input: ReleaseMaintenanceTopologyDiscoveryInput,
  expected: {
    targets: readonly TrustedReleaseTarget[];
    publicTrafficBarrier: ReleaseFullMaintenanceTrafficBarrierBinding;
    now: number;
  },
): ReleaseMaintenanceTopologyBinding {
  const receiptSha256 = topologyRawSha256(input?.receiptSha256, "topology receipt pin");
  const inventorySha256 = topologyRawSha256(input?.inventorySha256, "topology inventory pin");
  const inventory = topologyObject(input?.inventory, "public node inventory", ["format", "nodes"]);
  const inventoryNodes = topologyArray(inventory.nodes, "public node inventory nodes").map(
    (value, index) => {
      const node = topologyObject(value, `public node inventory nodes[${index}]`, [
        "configPath", "configSha256", "label", "nodeId", "role",
      ]);
      const role = node.role;
      if (role !== "api" && role !== "worker") {
        return topologyFail(`public node inventory nodes[${index}] role 无效`);
      }
      const configPath = String(node.configPath ?? "");
      if (
        !/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(configPath)
        || path.resolve(configPath) !== configPath
      ) {
        return topologyFail(`public node inventory nodes[${index}] configPath 无效`);
      }
      return {
        label: topologyPublicId(node.label, `public node inventory nodes[${index}] label`),
        nodeId: topologyPublicId(node.nodeId, `public node inventory nodes[${index}] nodeId`),
        role,
        configPath,
        configSha256: topologyRawSha256(
          node.configSha256,
          `public node inventory nodes[${index}] configSha256`,
        ),
      };
    },
  );
  if (
    inventory.format !== RELEASE_MAINTENANCE_TOPOLOGY_INVENTORY_FORMAT
    || inventoryNodes.length < 4
    || inventoryNodes.length > 100
    || inventoryNodes.filter(({ role }) => role === "api").length < 2
    || inventoryNodes.filter(({ role }) => role === "worker").length < 2
    || canonicalJson(inventoryNodes.map(({ label }) => label))
      !== canonicalJson(exactSortedSet(inventoryNodes.map(({ label }) => label)))
    || new Set(inventoryNodes.map(({ label }) => label)).size !== inventoryNodes.length
    || new Set(inventoryNodes.map(({ nodeId }) => nodeId)).size !== inventoryNodes.length
    || new Set(inventoryNodes.map(({ configPath }) => configPath)).size !== inventoryNodes.length
  ) {
    return topologyFail("public node inventory 节点集合无效");
  }
  if (topologyCanonicalSha256(inventory) !== inventorySha256) {
    return topologyFail(
      "public node inventory 与独立 SHA pin 不一致",
      "RELEASE_MAINTENANCE_TOPOLOGY_PIN_MISMATCH",
    );
  }

  const receipt = topologyObject(input?.receipt, "production topology receipt", [
    "capturedAt",
    "fixedAsgNames",
    "fixedListenerIds",
    "fixedProjectName",
    "inputBindings",
    "publicNodeInventorySha256",
    "receiptDigest",
    "region",
    "schema",
    "stableRead",
    "status",
    "stsCredentialDeclaration",
    "topology",
  ]);
  if (topologyCanonicalSha256(receipt) !== receiptSha256) {
    return topologyFail(
      "production topology receipt 与独立 SHA pin 不一致",
      "RELEASE_MAINTENANCE_TOPOLOGY_PIN_MISMATCH",
    );
  }
  const fixedAsgNames = topologyObject(receipt.fixedAsgNames, "topology fixedAsgNames", [
    "api", "worker",
  ]);
  const fixedListenerIds = topologyObject(
    receipt.fixedListenerIds,
    "topology fixedListenerIds",
    ["http", "https"],
  );
  const stableRead = topologyObject(receipt.stableRead, "topology stableRead", [
    "businessSha256", "requestIds", "rounds",
  ]);
  const capturedAt = topologyCanonicalIso(receipt.capturedAt, "topology receipt capturedAt");
  const businessSha256 = topologyRawSha256(
    stableRead.businessSha256,
    "topology stableRead businessSha256",
  );
  const receiptDigest = topologyReceiptDigest(receipt.receiptDigest, "topology receiptDigest");
  const { receiptDigest: _receiptDigest, ...receiptBody } = receipt;
  if (
    receipt.schema !== RELEASE_MAINTENANCE_TOPOLOGY_RECEIPT_SCHEMA
    || receipt.status !== "PASS"
    || receipt.region !== RELEASE_MAINTENANCE_TOPOLOGY_REGION
    || receipt.fixedProjectName !== RELEASE_MAINTENANCE_TOPOLOGY_PROJECT
    || fixedAsgNames.api !== "fanjin-prod-api-asg"
    || fixedAsgNames.worker !== "fanjin-prod-worker-asg"
    || fixedListenerIds.http !== RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID
    || fixedListenerIds.https !== RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID
    || stableRead.rounds !== 2
    || !Array.isArray(stableRead.requestIds)
    || receipt.publicNodeInventorySha256 !== inventorySha256
    || receiptDigest !== topologyDomainDigest(RELEASE_MAINTENANCE_TOPOLOGY_RECEIPT_SCHEMA, receiptBody)
  ) {
    return topologyFail("production topology receipt 内部 binding 或固定合同无效");
  }

  const topology = topologyObject(receipt.topology, "topology business payload", [
    "asgs", "clb", "ecsInstances", "nodes", "projectName", "region", "workers",
  ]);
  if (
    topology.region !== RELEASE_MAINTENANCE_TOPOLOGY_REGION
    || topology.projectName !== RELEASE_MAINTENANCE_TOPOLOGY_PROJECT
    || topologyCanonicalSha256(topology) !== businessSha256
  ) {
    return topologyFail("topology business payload region/project/digest 无效");
  }
  const topologyNodes = topologyArray(topology.nodes, "topology nodes").map((value, index) => {
    const node = topologyObject(value, `topology nodes[${index}]`, [
      "configPath", "configSha256", "instanceId", "label", "nodeId", "role",
    ]);
    if (node.role !== "api" && node.role !== "worker") {
      return topologyFail(`topology nodes[${index}] role 无效`);
    }
    return {
      instanceId: topologyCloudId(node.instanceId, `topology nodes[${index}] instanceId`),
      label: topologyPublicId(node.label, `topology nodes[${index}] label`),
      nodeId: topologyPublicId(node.nodeId, `topology nodes[${index}] nodeId`),
      role: node.role,
      configPath: String(node.configPath ?? ""),
      configSha256: topologyRawSha256(node.configSha256, `topology nodes[${index}] configSha256`),
    };
  });
  if (
    canonicalJson(topologyNodes.map(({ label, nodeId, role, configPath, configSha256 }) => ({
      label, nodeId, role, configPath, configSha256,
    }))) !== canonicalJson(inventoryNodes)
    || new Set(topologyNodes.map(({ instanceId }) => instanceId)).size !== topologyNodes.length
  ) {
    return topologyFail("topology nodes 与 public node inventory 不一致");
  }

  const asgs = topologyObject(topology.asgs, "topology asgs", ["api", "worker"]);
  const apiAsg = topologyObject(asgs.api, "topology api ASG");
  const workerAsg = topologyObject(asgs.worker, "topology worker ASG");
  const normalizeAsgInstances = (
    group: Record<string, unknown>,
    role: "api" | "worker",
  ): string[] => {
    if (
      group.projectName !== RELEASE_MAINTENANCE_TOPOLOGY_PROJECT
      || group.name !== `fanjin-prod-${role}-asg`
    ) {
      return topologyFail(`topology ${role} ASG 固定身份无效`);
    }
    const instances = topologyArray(group.instances, `topology ${role} ASG instances`).map(
      (entry, index) => {
        const instance = topologyObject(entry, `topology ${role} ASG instances[${index}]`);
        if (instance.status !== "InService") {
          return topologyFail(`topology ${role} ASG instance 非 InService`);
        }
        return topologyCloudId(
          instance.instanceId,
          `topology ${role} ASG instances[${index}] instanceId`,
        );
      },
    );
    const requiredSuspended = [
      "AlarmNotification", "HealthCheck", "ScaleIn", "ScaleOut", "ScheduledAction",
    ];
    const suspended = topologyArray(
      group.suspendedProcesses,
      `topology ${role} ASG suspendedProcesses`,
    );
    if (
      group.lifecycleState !== "Active"
      || group.desired !== instances.length
      || group.total !== instances.length
      || group.stopped !== 0
      || requiredSuspended.some((name) => !suspended.includes(name))
    ) {
      return topologyFail(`topology ${role} ASG 不是 frozen exact membership`);
    }
    return instances;
  };
  const apiInstanceIds = exactSortedSet(normalizeAsgInstances(apiAsg, "api"));
  const workerInstanceIds = exactSortedSet(normalizeAsgInstances(workerAsg, "worker"));
  if (
    canonicalJson(apiInstanceIds)
      !== canonicalJson(exactSortedSet(topologyNodes
        .filter(({ role }) => role === "api").map(({ instanceId }) => instanceId)))
    || canonicalJson(workerInstanceIds)
      !== canonicalJson(exactSortedSet(topologyNodes
        .filter(({ role }) => role === "worker").map(({ instanceId }) => instanceId)))
    || new Set([...apiInstanceIds, ...workerInstanceIds]).size
      !== apiInstanceIds.length + workerInstanceIds.length
  ) {
    return topologyFail("topology ASG membership 与节点角色不一致");
  }

  const ecsInstanceIds = topologyArray(topology.ecsInstances, "topology ecsInstances").map(
    (value, index) => {
      const instance = topologyObject(value, `topology ecsInstances[${index}]`);
      if (instance.status !== "RUNNING") {
        return topologyFail(`topology ecsInstances[${index}] 非 RUNNING`);
      }
      return topologyCloudId(instance.instanceId, `topology ecsInstances[${index}] instanceId`);
    },
  );
  if (
    canonicalJson(exactSortedSet(ecsInstanceIds))
      !== canonicalJson(exactSortedSet([...apiInstanceIds, ...workerInstanceIds]))
  ) {
    return topologyFail("topology ECS membership 与 ASG 不一致");
  }

  const clb = topologyObject(topology.clb, "topology clb", [
    "health", "listeners", "loadBalancerId", "rules", "serverGroupId", "servers",
  ]);
  const loadBalancerId = topologyCloudId(clb.loadBalancerId, "topology CLB loadBalancerId");
  const serverGroupId = topologyCloudId(clb.serverGroupId, "topology CLB serverGroupId");
  const listeners = topologyArray(clb.listeners, "topology CLB listeners");
  if (listeners.length !== 2) return topologyFail("topology CLB 必须恰好有两个固定 listener");
  const expectedListeners = new Map<string, { protocol: string; port: number }>([
    [RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID, { protocol: "HTTP", port: 80 }],
    [RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID, { protocol: "HTTPS", port: 443 }],
  ]);
  for (const [index, value] of listeners.entries()) {
    const listener = topologyObject(value, `topology CLB listeners[${index}]`);
    const listenerId = topologyCloudId(listener.listenerId, `topology CLB listeners[${index}] id`);
    const expectedListener = expectedListeners.get(listenerId);
    const healthCheck = topologyObject(
      listener.healthCheck,
      `topology CLB listeners[${index}] healthCheck`,
    );
    if (
      !expectedListener
      || listener.protocol !== expectedListener.protocol
      || listener.port !== expectedListener.port
      || listener.enabled !== true
      || listener.status !== "Active"
      || listener.loadBalancerId !== loadBalancerId
      || listener.serverGroupId !== serverGroupId
      || healthCheck.enabled !== true
      || healthCheck.method !== "GET"
      || healthCheck.uri !== "/api/ready"
      || !Array.isArray(healthCheck.httpCodes)
      || !healthCheck.httpCodes.some((code) => /(?:^|_)2xx$/u.test(String(code)))
    ) {
      return topologyFail("topology CLB 固定 listener/health-check 合同无效");
    }
    expectedListeners.delete(listenerId);
  }
  if (expectedListeners.size !== 0) return topologyFail("topology CLB listener 集合不完整");

  const servers = topologyArray(clb.servers, "topology CLB servers").map((value, index) => {
    const server = topologyObject(value, `topology CLB servers[${index}]`, [
      "instanceId", "port", "serverId", "weight",
    ]);
    return {
      serverId: topologyCloudId(server.serverId, `topology CLB servers[${index}] serverId`),
      instanceId: topologyCloudId(
        server.instanceId,
        `topology CLB servers[${index}] instanceId`,
      ),
      port: topologyInteger(server.port, `topology CLB servers[${index}] port`, 1, 65_535),
      weight: topologyInteger(server.weight, `topology CLB servers[${index}] weight`, 1, 100),
    };
  });
  if (
    new Set(servers.map(({ serverId }) => serverId)).size !== servers.length
    || new Set(servers.map(({ instanceId }) => instanceId)).size !== servers.length
    || canonicalJson(exactSortedSet(servers.map(({ instanceId }) => instanceId)))
      !== canonicalJson(apiInstanceIds)
  ) {
    return topologyFail("topology CLB server membership 无效");
  }
  const apiBindings = topologyArray(apiAsg.serverGroupBindings, "topology API ASG bindings");
  const workerBindings = topologyArray(
    workerAsg.serverGroupBindings,
    "topology Worker ASG bindings",
  );
  const apiBinding = apiBindings.length === 1
    ? topologyObject(apiBindings[0], "topology API ASG binding")
    : null;
  if (
    !apiBinding
    || workerBindings.length !== 0
    || apiBinding.loadBalancerId !== loadBalancerId
    || apiBinding.serverGroupId !== serverGroupId
    || servers.some(({ port, weight }) => (
      apiBinding.port !== port || apiBinding.weight !== weight
    ))
  ) {
    return topologyFail("topology API/Worker ASG 与 CLB binding 不一致");
  }

  const workerReceiptNodes = topologyArray(topology.workers, "topology workers").map(
    (value, index) => {
      const worker = topologyObject(value, `topology workers[${index}]`);
      return {
        nodeId: topologyPublicId(worker.nodeId, `topology workers[${index}] nodeId`),
        instanceId: topologyCloudId(worker.instanceId, `topology workers[${index}] instanceId`),
      };
    },
  ).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const expectedWorkerNodes = topologyNodes.filter(({ role }) => role === "worker")
    .map(({ nodeId, instanceId }) => ({ nodeId, instanceId }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (canonicalJson(workerReceiptNodes) !== canonicalJson(expectedWorkerNodes)) {
    return topologyFail("topology Worker receipt 与 dedicated ASG 不一致");
  }

  const targets = normalizedTargets(expected.targets);
  assertReleaseFullMaintenanceTrafficBarrierBinding(expected.publicTrafficBarrier);
  const targetsByKey = new Map(targets.map((target) => [target.key, target]));
  const nodesByKey = new Map(topologyNodes.map((node) => [node.nodeId, node]));
  if (
    targets.length !== topologyNodes.length
    || canonicalJson(exactSortedSet([...targetsByKey.keys()]))
      !== canonicalJson(exactSortedSet([...nodesByKey.keys()]))
    || loadBalancerId !== expected.publicTrafficBarrier.loadBalancerId
    || serverGroupId !== expected.publicTrafficBarrier.serverGroupId
  ) {
    return topologyFail(
      "activation target/LB/group 与 discovery topology 不一致",
      "RELEASE_MAINTENANCE_TOPOLOGY_TARGET_MISMATCH",
    );
  }
  const serverByInstance = new Map(servers.map((server) => [server.instanceId, server]));
  const barrierByNode = new Map(
    expected.publicTrafficBarrier.backends.map((backend) => [backend.nodeId, backend]),
  );
  for (const node of topologyNodes) {
    const target = targetsByKey.get(node.nodeId);
    if (!target || target.role !== node.role) {
      return topologyFail(
        "activation target role 与 discovery node 不一致",
        "RELEASE_MAINTENANCE_TOPOLOGY_TARGET_MISMATCH",
      );
    }
    if (node.role === "worker") {
      if (target.serverId !== node.instanceId) {
        return topologyFail(
          "dedicated Worker target 未绑定 discovery instance",
          "RELEASE_MAINTENANCE_TOPOLOGY_TARGET_MISMATCH",
        );
      }
      continue;
    }
    const server = serverByInstance.get(node.instanceId);
    const backend = barrierByNode.get(node.nodeId);
    if (
      !server
      || !backend
      || target.serverId !== server.serverId
      || backend.serverId !== server.serverId
      || backend.port !== server.port
      || backend.originalWeight !== server.weight
    ) {
      return topologyFail(
        "API target/CLB server/port/weight 未精确绑定 discovery topology",
        "RELEASE_MAINTENANCE_TOPOLOGY_TARGET_MISMATCH",
      );
    }
  }

  const binding = normalizeReleaseMaintenanceTopologyBinding({
    format: RELEASE_MAINTENANCE_TOPOLOGY_BINDING_FORMAT,
    region: RELEASE_MAINTENANCE_TOPOLOGY_REGION,
    projectName: RELEASE_MAINTENANCE_TOPOLOGY_PROJECT,
    listenerIds: {
      http: RELEASE_FULL_MAINTENANCE_HTTP_LISTENER_ID,
      https: RELEASE_FULL_MAINTENANCE_HTTPS_LISTENER_ID,
    },
    receiptSha256,
    inventorySha256,
    receiptDigest,
    capturedAt: capturedAt.value,
    businessSha256,
  });
  assertReleaseMaintenanceTopologyFresh(binding, expected.now);
  return binding;
}

export function assertReleaseMaintenanceTopologyEnvironment(
  bindingValue: ReleaseMaintenanceTopologyBinding,
  environment: Record<string, string | undefined>,
): void {
  const binding = normalizeReleaseMaintenanceTopologyBinding(bindingValue);
  if (
    String(environment.FANJIN_RELEASE_CLB_REGION ?? "").trim() !== binding.region
    || String(environment.FANJIN_RELEASE_CLB_API_HOST ?? "").trim()
      !== RELEASE_MAINTENANCE_TOPOLOGY_CLB_HOST
  ) {
    topologyFail(
      "CLB region/host 与 discovery topology binding 不一致",
      "RELEASE_MAINTENANCE_TOPOLOGY_ENVIRONMENT_MISMATCH",
    );
  }
}

function requestCommitment(input: Omit<NormalizedInput, "requestSha256">): Record<string, unknown> {
  return {
    format: RELEASE_MAINTENANCE_ACTIVATION_FORMAT,
    trafficMode: input.trafficMode,
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    releaseRevision: input.releaseRevision,
    artifactRevision: input.artifactRevision,
    channel: input.channel,
    environment: input.environment,
    scope: input.scope,
    operatorUserId: input.operatorUserId,
    idempotencyKey: input.idempotencyKey,
    nonceSha256: input.nonceSha256,
    migrationRunId: input.migrationRunId,
    expectedPreviousReleaseId: input.expectedPreviousReleaseId,
    expectedPreviousArtifactId: input.expectedPreviousArtifactId,
    expectedPreviousArtifactSha256: input.expectedPreviousArtifactSha256,
    expectedPreviousSourceCommit: input.expectedPreviousSourceCommit,
    expectedTargetArtifactSha256: input.expectedTargetArtifactSha256,
    expectedTargetSourceCommit: input.expectedTargetSourceCommit,
    inventorySha256: input.inventorySha256,
    prestageEvidenceSha256: input.prestageEvidence.evidenceSha256,
    controllerStoppedEvidenceSha256: input.controllerStoppedEvidence.evidenceSha256,
    databaseRolesSha256: input.databaseRolesSha256,
    privateApiInventorySha256: input.expectedPrivateApiInventorySha256,
    privateValidation: input.privateValidation,
    publicTrafficBarrierSha256: input.publicTrafficBarrier.bindingSha256,
    topology: input.topology,
  };
}

function contractRequestCommitment(
  contract: ReleaseMaintenanceActivationContract,
  row: RawRow,
): Record<string, unknown> {
  return {
    format: contract.format,
    trafficMode: contract.trafficMode,
    releaseId: contract.target?.releaseId,
    artifactId: contract.target?.artifactId,
    releaseRevision: contract.target?.releaseRevision,
    artifactRevision: contract.target?.artifactRevision,
    channel: contract.target?.channel,
    environment: contract.environment,
    scope: contract.scope,
    operatorUserId: Number(row.requestedByUserId),
    idempotencyKey: String(row.idempotencyKey ?? ""),
    nonceSha256: contract.nonceSha256,
    migrationRunId: contract.migration?.runId,
    expectedPreviousReleaseId: contract.previous?.releaseId,
    expectedPreviousArtifactId: contract.previous?.artifactId,
    expectedPreviousArtifactSha256: contract.previous?.artifactSha256,
    expectedPreviousSourceCommit: contract.previous?.sourceCommit,
    expectedTargetArtifactSha256: contract.target?.artifactSha256,
    expectedTargetSourceCommit: contract.target?.sourceCommit,
    inventorySha256: contract.inventory?.sha256,
    prestageEvidenceSha256: contract.prestageEvidenceSha256,
    controllerStoppedEvidenceSha256: contract.controllerStoppedEvidenceSha256,
    databaseRolesSha256: contract.databaseRoles?.sha256,
    privateApiInventorySha256: contract.privateApiInventorySha256,
    privateValidation: contract.privateValidation,
    publicTrafficBarrierSha256: contract.publicTrafficBarrier?.bindingSha256,
    topology: contract.topology,
  };
}

export function releaseMaintenanceActivationConfirmation(input: {
  trafficMode: typeof RELEASE_MAINTENANCE_TRAFFIC_MODE;
  releaseId: string;
  artifactId: string;
  expectedPreviousArtifactId: string;
  expectedTargetArtifactSha256: string;
  inventorySha256: string;
  expectedLoadBalancerId: string;
  expectedServerGroupId: string;
  expectedApiBackends: readonly {
    nodeId: string;
    serverId: string;
    port: number;
    originalWeight: number;
  }[];
  expectedPrivateApiInventorySha256: string;
  validationPlanIntentSha256: string;
  nonceSha256: string;
  topology: ReleaseMaintenanceTopologyBinding;
}): string {
  const publicTrafficBarrier = releaseFullMaintenanceTrafficBarrierBinding({
    loadBalancerId: input.expectedLoadBalancerId,
    serverGroupId: input.expectedServerGroupId,
    backends: input.expectedApiBackends,
  });
  const digest = objectDigest({
    format: RELEASE_MAINTENANCE_ACTIVATION_FORMAT,
    trafficMode: input.trafficMode === RELEASE_MAINTENANCE_TRAFFIC_MODE
      ? input.trafficMode
      : fail("维护流量模式无效", "RELEASE_MAINTENANCE_TRAFFIC_MODE_INVALID"),
    releaseId: exactId(input.releaseId, "releaseId"),
    artifactId: exactId(input.artifactId, "artifactId"),
    expectedPreviousArtifactId: exactId(
      input.expectedPreviousArtifactId,
      "expectedPreviousArtifactId",
    ),
    expectedTargetArtifactSha256: exactSha256(
      input.expectedTargetArtifactSha256,
      "expectedTargetArtifactSha256",
    ),
    inventorySha256: exactSha256(input.inventorySha256, "inventorySha256"),
    privateApiInventorySha256: exactSha256(
      input.expectedPrivateApiInventorySha256,
      "expectedPrivateApiInventorySha256",
    ),
    validationPlanIntentSha256: exactSha256(
      input.validationPlanIntentSha256,
      "validationPlanIntentSha256",
    ),
    publicTrafficBarrierSha256: publicTrafficBarrier.bindingSha256,
    nonceSha256: exactSha256(input.nonceSha256, "nonceSha256"),
    topology: normalizeReleaseMaintenanceTopologyBinding(input.topology),
  });
  return `AUTHORIZE_SCHEMA_40_TO_48_${digest.slice(0, 24).toUpperCase()}`;
}

function normalizeInput(input: ReleaseMaintenanceActivationInput, now: number): NormalizedInput {
  if (input.environment !== "production") {
    fail("维护激活仅允许 production", "RELEASE_MAINTENANCE_ENVIRONMENT_INVALID");
  }
  if (input.trafficMode !== RELEASE_MAINTENANCE_TRAFFIC_MODE) {
    fail("维护激活仅允许 full-maintenance 流量模式", "RELEASE_MAINTENANCE_TRAFFIC_MODE_INVALID");
  }
  const scope = exactText(input.scope, "scope", 128);
  if (!scope.startsWith("production:")) {
    fail("维护激活 scope 必须属于 production", "RELEASE_MAINTENANCE_SCOPE_INVALID");
  }
  const nonce = exactText(input.nonce, "nonce", 128);
  if (!SAFE_NONCE_RE.test(nonce)) {
    fail("维护 nonce 格式无效", "RELEASE_MAINTENANCE_NONCE_INVALID");
  }
  const targets = normalizedTargets(input.targets);
  const allowedDatabaseRoles = exactRoles(input.allowedDatabaseRoles, "allowedDatabaseRoles");
  const applicationDatabaseRoles = exactRoles(
    input.applicationDatabaseRoles,
    "applicationDatabaseRoles",
  );
  const databaseRolesSha256 = releaseMaintenanceDatabaseRolesDigest({
    allowedDatabaseRoles,
    applicationDatabaseRoles,
  });
  const publicTrafficBarrier = releaseFullMaintenanceTrafficBarrierBinding({
    loadBalancerId: input.expectedLoadBalancerId,
    serverGroupId: input.expectedServerGroupId,
    backends: input.expectedApiBackends,
  });
  const apiTargetKeys = targets
    .filter(({ role }) => role === "api")
    .map(({ key }) => key)
    .sort();
  if (
    canonicalJson(publicTrafficBarrier.backends.map(({ nodeId }) => nodeId))
      !== canonicalJson(apiTargetKeys)
  ) {
    fail(
      "full-maintenance backend 绑定与 API inventory 不一致",
      "RELEASE_MAINTENANCE_TRAFFIC_BARRIER_INVALID",
    );
  }
  const topology = releaseMaintenanceTopologyBinding(input.topology, {
    targets,
    publicTrafficBarrier,
    now,
  });
  const expectedPrivateApiInventorySha256 = exactSha256(
    input.expectedPrivateApiInventorySha256,
    "expectedPrivateApiInventorySha256",
  );
  const validationPlanIntent = assertReleaseFullMaintenancePrivateValidationIntent(
    input.privateValidation?.validationPlanIntent,
    { privateApiInventorySha256: expectedPrivateApiInventorySha256 },
  );
  if (
    input.privateValidation?.validationPlanIntentSha256
      !== validationPlanIntent.validationPlanIntentSha256
    || validationPlanIntent.target.releaseId !== input.releaseId
    || validationPlanIntent.target.artifactId !== input.artifactId
    || validationPlanIntent.target.artifactSha256 !== input.expectedTargetArtifactSha256
    || validationPlanIntent.target.sourceCommit !== input.expectedTargetSourceCommit
  ) {
    fail(
      "私网验真计划与维护目标或摘要不一致",
      "RELEASE_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID",
    );
  }
  const privateValidation = {
    validationPlanIntent,
    validationPlanIntentSha256: validationPlanIntent.validationPlanIntentSha256,
  };
  const normalized = {
    ...input,
    releaseId: exactId(input.releaseId, "releaseId"),
    artifactId: exactId(input.artifactId, "artifactId"),
    releaseRevision: positiveInteger(input.releaseRevision, "releaseRevision"),
    artifactRevision: positiveInteger(input.artifactRevision, "artifactRevision"),
    trafficMode: RELEASE_MAINTENANCE_TRAFFIC_MODE,
    expectedLoadBalancerId: exactId(
      input.expectedLoadBalancerId,
      "expectedLoadBalancerId",
    ),
    expectedServerGroupId: publicTrafficBarrier.serverGroupId,
    expectedApiBackends: publicTrafficBarrier.backends,
    expectedPrivateApiInventorySha256,
    privateValidation,
    scope,
    operatorUserId: positiveInteger(input.operatorUserId, "operatorUserId"),
    idempotencyKey: exactId(input.idempotencyKey, "idempotencyKey"),
    nonce,
    nonceSha256: sha256(nonce),
    migrationRunId: exactId(input.migrationRunId, "migrationRunId"),
    expectedPreviousReleaseId: exactId(
      input.expectedPreviousReleaseId,
      "expectedPreviousReleaseId",
    ),
    expectedPreviousArtifactId: exactId(
      input.expectedPreviousArtifactId,
      "expectedPreviousArtifactId",
    ),
    expectedPreviousArtifactSha256: exactSha256(
      input.expectedPreviousArtifactSha256,
      "expectedPreviousArtifactSha256",
    ),
    expectedPreviousSourceCommit: exactSourceCommit(
      input.expectedPreviousSourceCommit,
      "expectedPreviousSourceCommit",
    ),
    expectedTargetArtifactSha256: exactSha256(
      input.expectedTargetArtifactSha256,
      "expectedTargetArtifactSha256",
    ),
    expectedTargetSourceCommit: exactSourceCommit(
      input.expectedTargetSourceCommit,
      "expectedTargetSourceCommit",
    ),
    targets,
    inventorySha256: releaseMaintenanceInventoryDigest(targets),
    allowedDatabaseRoles,
    applicationDatabaseRoles,
    databaseRolesSha256,
    publicTrafficBarrier,
    topology,
    confirmation: exactText(input.confirmation, "confirmation", 128),
    stepUpAuthorization: {
      proof: exactText(input.stepUpAuthorization?.proof, "stepUpAuthorization.proof", 2048),
      sessionId: exactId(input.stepUpAuthorization?.sessionId, "stepUpAuthorization.sessionId"),
    },
  } satisfies Omit<NormalizedInput, "requestSha256">;
  const expectedConfirmation = releaseMaintenanceActivationConfirmation({
    ...normalized,
    validationPlanIntentSha256: privateValidation.validationPlanIntentSha256,
    topology,
  });
  if (normalized.confirmation !== expectedConfirmation) {
    fail("维护激活确认串不匹配", "RELEASE_MAINTENANCE_CONFIRMATION_MISMATCH", {
      expectedConfirmation,
    });
  }
  return {
    ...normalized,
    requestSha256: objectDigest(requestCommitment(normalized)),
  };
}

function hasExactGeneration(row: RawRow): boolean {
  return Boolean(
    (row.storageProvider === "s3" || row.storageProvider === "tos")
    && String(row.storageBucket || "")
    && String(row.storageRegion || "")
    && String(row.storageEndpoint || "")
    && row.storageKeyPrefix != null
    && row.storageForcePathStyle != null
    && String(row.storageKey || "")
    && String(row.uploadReservationId || "")
    && String(row.storageVersionId || "")
    && String(row.storageVersionId) !== "null"
    && String(row.storageEtag || "")
    && String(row.storageRequestId || "")
    && Number.isSafeInteger(Number(row.storageCapturedAt))
    && Number(row.storageCapturedAt) > 0
    && Number.isSafeInteger(Number(row.byteSize))
    && Number(row.byteSize) > 0
  );
}

function mapArtifact(row: RawRow): ReleaseMaintenanceArtifact {
  if (!hasExactGeneration(row)) {
    fail("制品缺少精确对象存储 generation", "RELEASE_MAINTENANCE_ARTIFACT_GENERATION_MISSING");
  }
  const manifest = parseReleaseArtifactManifest(
    parseObject(row.manifestJson, "artifact.manifestJson"),
    String(row.releaseId),
  );
  const artifact: ReleaseMaintenanceArtifact = {
    id: String(row.id),
    releaseId: String(row.releaseId),
    byteSize: Number(row.byteSize),
    sha256: exactSha256(row.sha256, "artifact.sha256"),
    sourceCommit: row.sourceCommit == null ? null : String(row.sourceCommit).toLowerCase(),
    format: row.format == null ? null : String(row.format),
    manifest,
    status: String(row.status) as ReleaseMaintenanceArtifact["status"],
    revision: Number(row.revision),
    storageKey: String(row.storageKey),
    uploadReservationId: String(row.uploadReservationId),
    storageProvider: row.storageProvider as "s3" | "tos",
    storageBucket: String(row.storageBucket),
    storageRegion: String(row.storageRegion),
    storageEndpoint: String(row.storageEndpoint),
    storageKeyPrefix: String(row.storageKeyPrefix),
    storageForcePathStyle: Boolean(row.storageForcePathStyle),
    storageVersionId: String(row.storageVersionId),
    storageEtag: String(row.storageEtag),
    storageRequestId: String(row.storageRequestId),
    storageCapturedAt: Number(row.storageCapturedAt),
  };
  if (
    artifact.status !== "ready"
    || artifact.format !== artifact.manifest.format
    || artifact.sourceCommit !== artifact.manifest.sourceCommit
  ) {
    fail("制品 ready 身份与 manifest 不一致", "RELEASE_MAINTENANCE_ARTIFACT_IDENTITY_INVALID");
  }
  return artifact;
}

/**
 * Narrow schema-40-safe artifact reader for the offline prestage command.
 * It deliberately avoids importing the ordinary release repository/runtime,
 * whose startup readiness expects the target schema generation.
 */
export async function readReleaseMaintenanceArtifact(
  client: Knex | Knex.Transaction,
  input: { releaseId: string; artifactId: string; lock?: boolean },
): Promise<ReleaseMaintenanceArtifact> {
  const releaseId = exactId(input.releaseId, "releaseId");
  const artifactId = exactId(input.artifactId, "artifactId");
  let query = (client as any)(RELEASE_ARTIFACT_TABLE).where({
    id: artifactId,
    releaseId,
    status: "ready",
  });
  if (input.lock) query = query.forUpdate();
  const row = await query.first();
  if (!row) {
    fail("维护目标 ready 制品不存在", "RELEASE_MAINTENANCE_ARTIFACT_MISSING");
  }
  return mapArtifact(row as RawRow);
}

function artifactIdentity(
  artifact: ReleaseMaintenanceArtifact,
  evidence: CachedReleaseArtifactEvidence,
): ReleaseMaintenanceArtifactIdentity {
  if (
    evidence.artifactId !== artifact.id
    || evidence.releaseId !== artifact.releaseId
    || evidence.artifactSha256 !== artifact.sha256
    || evidence.schemaVersion !== artifact.manifest.schemaVersion
    || evidence.workerProtocolVersion !== artifact.manifest.workerProtocolVersion
    || canonicalJson(evidence.runtimeCapabilities) !== canonicalJson(artifact.manifest.runtimeCapabilities)
    || !SHA256_RE.test(evidence.signedManifestFileSha256)
  ) {
    fail("离线签名制品校验结果与数据库身份不一致", "RELEASE_MAINTENANCE_ARTIFACT_ATTESTATION_MISMATCH", {
      artifactId: artifact.id,
    });
  }
  if (
    artifact.manifest.deployment
    && canonicalJson(evidence.deployment) !== canonicalJson(artifact.manifest.deployment)
  ) {
    fail("签名容器部署身份不一致", "RELEASE_MAINTENANCE_ARTIFACT_ATTESTATION_MISMATCH", {
      artifactId: artifact.id,
    });
  }
  return {
    releaseId: artifact.releaseId,
    artifactId: artifact.id,
    artifactRevision: artifact.revision,
    artifactSha256: artifact.sha256,
    signedManifestFileSha256: evidence.signedManifestFileSha256,
    sourceCommit: artifact.manifest.sourceCommit,
    schemaVersion: artifact.manifest.schemaVersion,
    workerProtocolVersion: artifact.manifest.workerProtocolVersion,
    runtimeCapabilities: [...artifact.manifest.runtimeCapabilities],
    ...(artifact.manifest.deployment ? { deployment: artifact.manifest.deployment } : {}),
    attestation: {
      keyId: exactId(evidence.attestation.keyId, "artifact.attestation.keyId"),
      payloadSha256: exactSha256(
        evidence.attestation.payloadSha256,
        "artifact.attestation.payloadSha256",
      ),
    },
    generation: {
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
      byteSize: Number(artifact.byteSize),
    },
  };
}

function exactMigrationStatus(
  status: DatabaseMigrationStatus,
  definitions: readonly DatabaseMigration[],
): ReturnType<typeof releaseMaintenanceMigrationDigests> {
  const digests = releaseMaintenanceMigrationDigests(definitions);
  const expectedApplied = definitions
    .slice(0, RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION)
    .map(migrationIdentity);
  const expectedPending = definitions
    .slice(RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION)
    .map(migrationIdentity);
  const applied = status.applied.map(migrationIdentity);
  const pending = status.pending.map(migrationIdentity);
  if (
    status.tableExists !== true
    || status.current !== false
    || status.databaseVersion !== RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION
    || status.latestVersion !== RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION
    || status.knownLatestVersion !== RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION
    || canonicalJson(applied) !== canonicalJson(expectedApplied)
    || canonicalJson(pending) !== canonicalJson(expectedPending)
  ) {
    fail(
      "数据库不是精确 schema 40，或待执行迁移不是精确 41–48",
      "RELEASE_MAINTENANCE_SCHEMA_BASELINE_MISMATCH",
    );
  }
  return digests;
}

function assertArtifactExpectation(
  artifact: ReleaseMaintenanceArtifact,
  input: NormalizedInput,
  purpose: "previous" | "target",
): void {
  const target = purpose === "target";
  const expected = target ? {
    id: input.artifactId,
    releaseId: input.releaseId,
    revision: input.artifactRevision,
    sha256: input.expectedTargetArtifactSha256,
    sourceCommit: input.expectedTargetSourceCommit,
    schemaVersion: RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION,
  } : {
    id: input.expectedPreviousArtifactId,
    releaseId: input.expectedPreviousReleaseId,
    revision: artifact.revision,
    sha256: input.expectedPreviousArtifactSha256,
    sourceCommit: input.expectedPreviousSourceCommit,
    schemaVersion: RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION,
  };
  if (
    artifact.id !== expected.id
    || artifact.releaseId !== expected.releaseId
    || artifact.revision !== expected.revision
    || artifact.sha256 !== expected.sha256
    || artifact.manifest.sourceCommit !== expected.sourceCommit
    || artifact.manifest.schemaVersion !== expected.schemaVersion
  ) {
    fail("制品与维护激活的精确身份不一致", "RELEASE_MAINTENANCE_ARTIFACT_EXPECTATION_MISMATCH", {
      purpose,
      artifactId: artifact.id,
    });
  }
  if (target && !artifact.manifest.deployment) {
    fail("schema 48 目标制品缺少签名容器部署身份", "RELEASE_MAINTENANCE_TARGET_CONTAINER_REQUIRED");
  }
}

async function loadTargetArtifact(
  client: ReleaseDb,
  input: NormalizedInput,
  lock = false,
): Promise<ReleaseMaintenanceArtifact> {
  let query = (client as any)(RELEASE_ARTIFACT_TABLE)
    .where({ id: input.artifactId, releaseId: input.releaseId, status: "ready" });
  if (lock) query = query.forUpdate();
  const row = await query.first();
  if (!row) fail("目标制品不存在或未 ready", "RELEASE_MAINTENANCE_TARGET_ARTIFACT_NOT_READY");
  const artifact = mapArtifact(row as RawRow);
  assertArtifactExpectation(artifact, input, "target");
  return artifact;
}

interface PreviousContext {
  release: RawRow;
  deployment: RawRow;
  artifact: ReleaseMaintenanceArtifact;
}

async function loadPreviousContext(
  client: ReleaseDb,
  input: NormalizedInput,
  lock = false,
): Promise<PreviousContext> {
  let releaseQuery = (client as any)(PLATFORM_RELEASE_TABLE)
    .where({ id: input.expectedPreviousReleaseId, channel: input.channel, status: "published" });
  if (lock) releaseQuery = releaseQuery.forUpdate();
  const release = await releaseQuery.first();
  if (!release) {
    fail("指定的上一正式版本不存在", "RELEASE_MAINTENANCE_PREVIOUS_RELEASE_MISSING");
  }
  const latestPublished = await (client as any)(PLATFORM_RELEASE_TABLE)
    .where({ channel: input.channel, status: "published" })
    .whereNot({ id: input.releaseId })
    .orderBy("publishedAt", "desc")
    .orderBy("updatedAt", "desc")
    .orderBy("createdAt", "desc")
    .first();
  if (!latestPublished || String(latestPublished.id) !== input.expectedPreviousReleaseId) {
    fail("指定版本不是当前通道最新正式基线", "RELEASE_MAINTENANCE_PREVIOUS_RELEASE_NOT_LATEST");
  }
  let deploymentQuery = (client as any)(RELEASE_DEPLOYMENT_TABLE)
    .where({
      releaseId: input.expectedPreviousReleaseId,
      artifactId: input.expectedPreviousArtifactId,
      status: "succeeded",
    })
    .orderBy("completedAt", "desc")
    .orderBy("createdAt", "desc");
  if (lock) deploymentQuery = deploymentQuery.forUpdate();
  const deployment = await deploymentQuery.first();
  if (!deployment) {
    fail("上一正式版本缺少成功发布制品", "RELEASE_MAINTENANCE_PREVIOUS_PROVENANCE_MISSING");
  }
  let artifactQuery = (client as any)(RELEASE_ARTIFACT_TABLE)
    .where({
      id: input.expectedPreviousArtifactId,
      releaseId: input.expectedPreviousReleaseId,
      status: "ready",
    });
  if (lock) artifactQuery = artifactQuery.forUpdate();
  const artifactRow = await artifactQuery.first();
  if (!artifactRow) {
    fail("上一正式版本的 ready 制品不存在", "RELEASE_MAINTENANCE_PREVIOUS_PROVENANCE_MISSING");
  }
  const artifact = mapArtifact(artifactRow as RawRow);
  assertArtifactExpectation(artifact, input, "previous");
  return { release: release as RawRow, deployment: deployment as RawRow, artifact };
}

function parseContract(row: RawRow): ReleaseMaintenanceActivationContract {
  const plan = parseObject(row.planJson, "deployment.planJson");
  const contract = parseObject(plan.maintenanceActivation, "deployment.maintenanceActivation");
  if (contract.format !== RELEASE_MAINTENANCE_ACTIVATION_FORMAT) {
    fail("维护激活台账格式无效", "RELEASE_MAINTENANCE_LEDGER_INVALID");
  }
  const { contractSha256, ...commitment } = contract;
  if (
    !SHA256_RE.test(String(contractSha256 || ""))
    || contractSha256 !== objectDigest(commitment)
  ) {
    fail("维护激活台账摘要无效", "RELEASE_MAINTENANCE_LEDGER_INVALID");
  }
  return contract as unknown as ReleaseMaintenanceActivationContract;
}

function assertContractShape(
  contract: ReleaseMaintenanceActivationContract,
  row: RawRow,
  validationNow: number,
): void {
  const previous = contract.previous;
  const target = contract.target;
  const migrationDigests = releaseMaintenanceMigrationDigests();
  let inventory: TrustedReleaseTarget[];
  let allowedDatabaseRoles: string[];
  let applicationDatabaseRoles: string[];
  let validationPlanIntent: ReleaseFullMaintenancePrivateValidationIntent;
  let topologyBinding: ReleaseMaintenanceTopologyBinding;
  try {
    inventory = normalizedTargets(contract.inventory?.targets || []);
    allowedDatabaseRoles = exactRoles(
      contract.databaseRoles?.allowedDatabaseRoles || [],
      "contract.allowedDatabaseRoles",
    );
    applicationDatabaseRoles = exactRoles(
      contract.databaseRoles?.applicationDatabaseRoles || [],
      "contract.applicationDatabaseRoles",
    );
    validationPlanIntent = assertReleaseFullMaintenancePrivateValidationIntent(
      contract.privateValidation?.validationPlanIntent,
      {
        target: {
          releaseId: target.releaseId,
          artifactId: target.artifactId,
          artifactSha256: target.artifactSha256,
          sourceCommit: target.sourceCommit,
          schemaVersion: RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION,
          imageDigest: target.deployment?.imageDigest ?? "",
        },
        privateApiInventorySha256: contract.privateApiInventorySha256,
        now: validationNow,
      },
    );
    topologyBinding = normalizeReleaseMaintenanceTopologyBinding(contract.topology);
  } catch {
    return fail("维护激活契约清单或数据库角色无效", "RELEASE_MAINTENANCE_LEDGER_INVALID");
  }
  const rolesSha256 = releaseMaintenanceDatabaseRolesDigest({
    allowedDatabaseRoles,
    applicationDatabaseRoles,
  });
  const artifactIdentityValid = (
    identity: ReleaseMaintenanceArtifactIdentity,
    schemaVersion: 40 | 48,
  ) => Boolean(
    identity
    && SAFE_ID_RE.test(String(identity.releaseId || ""))
    && SAFE_ID_RE.test(String(identity.artifactId || ""))
    && Number.isSafeInteger(identity.artifactRevision)
    && identity.artifactRevision >= 1
    && SHA256_RE.test(String(identity.artifactSha256 || ""))
    && SHA256_RE.test(String(identity.signedManifestFileSha256 || ""))
    && SOURCE_COMMIT_RE.test(String(identity.sourceCommit || ""))
    && identity.schemaVersion === schemaVersion
    && Number.isSafeInteger(identity.workerProtocolVersion)
    && identity.workerProtocolVersion >= 1
    && Array.isArray(identity.runtimeCapabilities)
    && identity.runtimeCapabilities.length <= 64
    && identity.runtimeCapabilities.every((capability) => (
      /^(?=.{1,64}$)[a-z][a-z0-9-]*(?:[._][a-z0-9][a-z0-9-]*)*$/u
        .test(String(capability))
    ))
    && identity.attestation
    && SAFE_ID_RE.test(String(identity.attestation.keyId || ""))
    && SHA256_RE.test(String(identity.attestation.payloadSha256 || ""))
    && identity.generation
    && (identity.generation.storageProvider === "s3"
      || identity.generation.storageProvider === "tos")
    && String(identity.generation.storageBucket || "")
    && String(identity.generation.storageRegion || "")
    && String(identity.generation.storageEndpoint || "")
    && identity.generation.storageKeyPrefix != null
    && String(identity.generation.storageKey || "")
    && String(identity.generation.storageVersionId || "")
    && String(identity.generation.storageEtag || "")
    && String(identity.generation.storageRequestId || "")
    && Number.isSafeInteger(identity.generation.storageCapturedAt)
    && identity.generation.storageCapturedAt > 0
    && Number.isSafeInteger(identity.generation.byteSize)
    && identity.generation.byteSize > 0
  );
  if (
    contract.format !== RELEASE_MAINTENANCE_ACTIVATION_FORMAT
    || contract.trafficMode !== RELEASE_MAINTENANCE_TRAFFIC_MODE
    || contract.deploymentId !== String(row.id)
    || contract.requestSha256 !== String(row.requestHash)
    || !SHA256_RE.test(contract.requestSha256)
    || !Number.isSafeInteger(Number(row.requestedByUserId))
    || Number(row.requestedByUserId) < 1
    || !SAFE_ID_RE.test(String(row.idempotencyKey || ""))
    || contract.requestSha256 !== objectDigest(contractRequestCommitment(contract, row))
    || !SHA256_RE.test(contract.nonceSha256)
    || contract.environment !== "production"
    || contract.scope !== String(row.activeScope)
    || !artifactIdentityValid(previous, RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION)
    || !artifactIdentityValid(target, RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION)
    || !target.deployment
    || target.deployment.mode !== "container-image"
    || previous.releaseId !== String(row.previousReleaseId)
    || previous.artifactId !== String(row.previousArtifactId)
    || target.releaseId !== String(row.releaseId)
    || target.artifactId !== String(row.artifactId)
    || !Number.isSafeInteger(previous.releaseRevision)
    || previous.releaseRevision < 1
    || !String(previous.releaseVersion || "")
    || !["stable", "beta", "internal"].includes(previous.channel)
    || !SAFE_ID_RE.test(String(previous.deploymentId || ""))
    || !Number.isSafeInteger(previous.deploymentRevision)
    || previous.deploymentRevision < 1
    || !Number.isSafeInteger(target.releaseRevision)
    || target.releaseRevision < 1
    || !String(target.releaseVersion || "")
    || target.channel !== previous.channel
    || contract.inventory.sha256 !== releaseMaintenanceInventoryDigest(inventory)
    || !SHA256_RE.test(contract.privateApiInventorySha256)
    || contract.privateValidation.validationPlanIntentSha256
      !== validationPlanIntent.validationPlanIntentSha256
    || canonicalJson(contract.publicTrafficBarrier)
      !== canonicalJson(releaseFullMaintenanceTrafficBarrierBinding({
        loadBalancerId: contract.publicTrafficBarrier?.loadBalancerId,
        serverGroupId: contract.publicTrafficBarrier?.serverGroupId,
        backends: contract.publicTrafficBarrier?.backends,
      }))
    || canonicalJson(contract.publicTrafficBarrier.backends.map(({ nodeId }) => nodeId))
      !== canonicalJson(inventory
        .filter(({ role }) => role === "api")
        .map(({ key }) => key)
        .sort())
    || canonicalJson(contract.topology) !== canonicalJson(topologyBinding)
    || contract.databaseRoles.sha256 !== rolesSha256
    || !SHA256_RE.test(contract.prestageEvidenceSha256)
    || !SHA256_RE.test(contract.controllerStoppedEvidenceSha256)
    || contract.prestage?.evidenceSha256 !== contract.prestageEvidenceSha256
    || contract.controllerStopped?.evidenceSha256 !== contract.controllerStoppedEvidenceSha256
    || contract.migration?.fromVersion !== RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION
    || contract.migration?.toVersion !== RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION
    || !SAFE_ID_RE.test(String(contract.migration?.runId || ""))
    || contract.migration?.registrySha256 !== migrationDigests.registrySha256
    || contract.migration?.appliedPrefixSha256 !== migrationDigests.appliedPrefixSha256
    || contract.migration?.pendingSuffixSha256 !== migrationDigests.pendingSuffixSha256
    || contract.authorization?.scope !== "admin.deployment"
    || (contract.authorization?.method !== "totp" && contract.authorization?.method !== "recovery")
    || !SAFE_ID_RE.test(String(contract.authorization?.proofRecordId || ""))
    || !Number.isSafeInteger(contract.authorization?.authorizationRevision)
    || contract.authorization.authorizationRevision < 1
    || !Number.isSafeInteger(contract.authorization.expiresAt)
    || !Number.isSafeInteger(contract.authorization.consumedAt)
    || !Number.isSafeInteger(contract.activationExpiresAt)
    || !Number.isSafeInteger(contract.createdAt)
    || contract.createdAt < 1
    || contract.authorization.consumedAt > contract.createdAt
    || contract.authorization.expiresAt <= contract.createdAt
    || contract.activationExpiresAt <= contract.createdAt
    || contract.activationExpiresAt > contract.authorization.expiresAt
    || contract.activationExpiresAt > contract.createdAt + RELEASE_MAINTENANCE_ACTIVATION_TTL_MS
    || Date.parse(topologyBinding.capturedAt) > contract.createdAt + TOPOLOGY_FUTURE_TOLERANCE_MS
    || contract.createdAt - Date.parse(topologyBinding.capturedAt)
      > RELEASE_MAINTENANCE_TOPOLOGY_MAX_AGE_MS
  ) {
    fail("维护激活契约字段不完整或不一致", "RELEASE_MAINTENANCE_LEDGER_INVALID");
  }
  if (!Number.isSafeInteger(validationNow) || validationNow < 1) {
    fail("维护激活校验时间无效", "RELEASE_MAINTENANCE_INPUT_INVALID");
  }
  if (contract.activationExpiresAt <= validationNow) {
    fail("维护激活预授权已过期", "RELEASE_MAINTENANCE_ACTIVATION_EXPIRED");
  }
  assertReleaseMaintenancePrestageEvidence(contract.prestage, {
    releaseId: target.releaseId,
    artifactId: target.artifactId,
    artifactSha256: target.artifactSha256,
    signedManifestFileSha256: target.signedManifestFileSha256,
    targets: inventory,
    now: validationNow,
  });
  assertReleaseControllerStoppedEvidence(contract.controllerStopped, validationNow);
}

export function assertReleaseMaintenanceReservationCheckpoint(
  value: unknown,
  expected: {
    deploymentId: string;
    contractSha256: string;
    requestSha256: string;
    nonceSha256: string;
  },
): ReleaseMaintenanceReservationCheckpoint {
  const checkpoint = parseObject(value, "deployment.checkpointJson");
  const exactKeys = [
    "backupCheckpointEvidenceSha256",
    "contractSha256",
    "createdAt",
    "format",
    "maintenanceBackfillReceiptSha256",
    "nonceSha256",
    "operationId",
    "phase",
    "requestSha256",
    "revision",
    "status",
    "trafficMode",
    "updatedAt",
    "writerQuiescenceProofSha256",
  ];
  if (
    canonicalJson(Object.keys(checkpoint).sort()) !== canonicalJson(exactKeys)
    || checkpoint.format !== RELEASE_MAINTENANCE_ACTIVATION_FORMAT
    || checkpoint.trafficMode !== RELEASE_MAINTENANCE_TRAFFIC_MODE
    || checkpoint.operationId !== expected.deploymentId
    || checkpoint.phase !== RELEASE_MAINTENANCE_ACTIVATION_PHASE
    || checkpoint.status !== "running"
    || checkpoint.contractSha256 !== expected.contractSha256
    || checkpoint.requestSha256 !== expected.requestSha256
    || checkpoint.nonceSha256 !== expected.nonceSha256
    || checkpoint.writerQuiescenceProofSha256 !== null
    || checkpoint.backupCheckpointEvidenceSha256 !== null
    || checkpoint.maintenanceBackfillReceiptSha256 !== null
    || checkpoint.revision !== 1
    || !Number.isSafeInteger(checkpoint.createdAt)
    || Number(checkpoint.createdAt) < 1
    || checkpoint.updatedAt !== checkpoint.createdAt
  ) {
    fail("维护预授权 checkpoint 无效", "RELEASE_MAINTENANCE_CHECKPOINT_INVALID");
  }
  return checkpoint as unknown as ReleaseMaintenanceReservationCheckpoint;
}

function assertContractArtifactMatchesRow(
  identity: ReleaseMaintenanceArtifactIdentity,
  artifact: ReleaseMaintenanceArtifact,
): void {
  const expected = {
    releaseId: artifact.releaseId,
    artifactId: artifact.id,
    artifactRevision: artifact.revision,
    artifactSha256: artifact.sha256,
    sourceCommit: artifact.manifest.sourceCommit,
    schemaVersion: artifact.manifest.schemaVersion,
    workerProtocolVersion: artifact.manifest.workerProtocolVersion,
    runtimeCapabilities: artifact.manifest.runtimeCapabilities,
    ...(artifact.manifest.deployment ? { deployment: artifact.manifest.deployment } : {}),
    attestation: identity.attestation,
    generation: {
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
      byteSize: Number(artifact.byteSize),
    },
  };
  const committed = {
    releaseId: identity.releaseId,
    artifactId: identity.artifactId,
    artifactRevision: identity.artifactRevision,
    artifactSha256: identity.artifactSha256,
    sourceCommit: identity.sourceCommit,
    schemaVersion: identity.schemaVersion,
    workerProtocolVersion: identity.workerProtocolVersion,
    runtimeCapabilities: identity.runtimeCapabilities,
    ...(identity.deployment ? { deployment: identity.deployment } : {}),
    attestation: identity.attestation,
    generation: identity.generation,
  };
  if (canonicalJson(committed) !== canonicalJson(expected)) {
    fail("维护契约制品身份与数据库 generation 不一致", "RELEASE_MAINTENANCE_PROVENANCE_CHANGED", {
      artifactId: artifact.id,
    });
  }
}

/**
 * Strict Phase-2 handoff reader. The raw nonce is required but never returned.
 * Callers that will immediately CAS/acquire the reservation should pass their
 * transaction and `lock: true` so the exact row/target set stays fenced.
 */
export async function readReleaseMaintenanceActivationReservation(
  client: Knex | Knex.Transaction,
  input: { deploymentId: string; nonce: string; lock?: boolean; now?: number },
): Promise<ReleaseMaintenanceActivationReservationRead> {
  const deploymentId = exactId(input.deploymentId, "deploymentId");
  const nonce = exactText(input.nonce, "nonce", 128);
  const validationNow = input.now ?? Date.now();
  if (!SAFE_NONCE_RE.test(nonce)) {
    fail("维护 nonce 格式无效", "RELEASE_MAINTENANCE_NONCE_INVALID");
  }
  let deploymentQuery = (client as any)(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId });
  if (input.lock) deploymentQuery = deploymentQuery.forUpdate();
  const row = await deploymentQuery.first();
  if (!row) fail("维护预授权不存在", "RELEASE_MAINTENANCE_RESERVATION_NOT_FOUND");
  if (
    String(row.status) !== "running"
    || String(row.phase) !== RELEASE_MAINTENANCE_ACTIVATION_PHASE
    || !row.activeScope
    || row.leaseOwner != null
    || row.leaseExpiresAt != null
    || Number(row.revision) !== 1
    || Number(row.fencingToken) !== 1
    || Number(row.rollbackOnFailure) !== 0
    || Number(row.manualInterventionRequired) !== 0
  ) {
    fail("维护预授权状态已变化或已被取得", "RELEASE_MAINTENANCE_RESERVATION_STATE_INVALID");
  }
  const plan = parseObject(row.planJson, "deployment.planJson");
  if (
    plan.planVersion !== 1
    || plan.mode !== "maintenance-schema-upgrade-v1"
    || plan.trafficMode !== RELEASE_MAINTENANCE_TRAFFIC_MODE
    || plan.strategy !== RELEASE_MAINTENANCE_TRAFFIC_MODE
    || plan.rollbackOnFailure !== false
  ) {
    fail("维护预授权 plan envelope 无效", "RELEASE_MAINTENANCE_LEDGER_INVALID");
  }
  const contract = parseContract(row as RawRow);
  assertContractShape(contract, row as RawRow, validationNow);
  if (contract.nonceSha256 !== sha256(nonce)) {
    fail("维护 nonce 与预授权不匹配", "RELEASE_MAINTENANCE_NONCE_MISMATCH");
  }
  const checkpoint = assertReleaseMaintenanceReservationCheckpoint(row.checkpointJson, {
    deploymentId,
    contractSha256: contract.contractSha256,
    requestSha256: contract.requestSha256,
    nonceSha256: contract.nonceSha256,
  });
  let releaseRowsQuery = (client as any)(PLATFORM_RELEASE_TABLE)
    .whereIn("id", [contract.previous.releaseId, contract.target.releaseId]);
  if (input.lock) releaseRowsQuery = releaseRowsQuery.forUpdate();
  const releaseRows = await releaseRowsQuery;
  const previousRelease = (releaseRows as RawRow[])
    .find(({ id }) => String(id) === contract.previous.releaseId);
  const targetRelease = (releaseRows as RawRow[])
    .find(({ id }) => String(id) === contract.target.releaseId);
  if (
    !previousRelease
    || String(previousRelease.status) !== "published"
    || Number(previousRelease.revision) !== contract.previous.releaseRevision
    || String(previousRelease.version) !== contract.previous.releaseVersion
    || String(previousRelease.channel) !== contract.previous.channel
    || !targetRelease
    || String(targetRelease.status) !== "deploying"
    || Number(targetRelease.revision) !== contract.target.releaseRevision + 1
    || String(targetRelease.version) !== contract.target.releaseVersion
    || String(targetRelease.channel) !== contract.target.channel
  ) {
    fail("维护预授权关联版本状态已变化", "RELEASE_MAINTENANCE_PROVENANCE_CHANGED");
  }
  let previousDeploymentQuery = (client as any)(RELEASE_DEPLOYMENT_TABLE)
    .where({
      id: contract.previous.deploymentId,
      releaseId: contract.previous.releaseId,
      artifactId: contract.previous.artifactId,
      status: "succeeded",
      revision: contract.previous.deploymentRevision,
    });
  if (input.lock) previousDeploymentQuery = previousDeploymentQuery.forUpdate();
  const previousDeployment = await previousDeploymentQuery.first();
  if (!previousDeployment) {
    fail("上一正式制品成功发布记录已变化", "RELEASE_MAINTENANCE_PROVENANCE_CHANGED");
  }
  let artifactRowsQuery = (client as any)(RELEASE_ARTIFACT_TABLE)
    .whereIn("id", [contract.previous.artifactId, contract.target.artifactId]);
  if (input.lock) artifactRowsQuery = artifactRowsQuery.forUpdate();
  const artifactRows = await artifactRowsQuery;
  const previousArtifactRow = (artifactRows as RawRow[])
    .find(({ id }) => String(id) === contract.previous.artifactId);
  const targetArtifactRow = (artifactRows as RawRow[])
    .find(({ id }) => String(id) === contract.target.artifactId);
  if (!previousArtifactRow || !targetArtifactRow) {
    fail("维护预授权关联制品不存在", "RELEASE_MAINTENANCE_PROVENANCE_CHANGED");
  }
  assertContractArtifactMatchesRow(contract.previous, mapArtifact(previousArtifactRow));
  assertContractArtifactMatchesRow(contract.target, mapArtifact(targetArtifactRow));

  let targetRowsQuery = (client as any)(RELEASE_DEPLOYMENT_TARGET_TABLE)
    .where({ deploymentId })
    .orderBy("ordinal", "asc");
  if (input.lock) targetRowsQuery = targetRowsQuery.forUpdate();
  const targetRows = await targetRowsQuery;
  if ((targetRows as RawRow[]).length !== contract.inventory.targets.length) {
    fail("维护预授权目标行不完整", "RELEASE_MAINTENANCE_TARGET_LEDGER_INVALID");
  }
  const targets = (targetRows as RawRow[]).map((targetRow, ordinal) => {
    const committed = contract.inventory.targets[ordinal];
    const targetId = String(targetRow.id || "");
    const metadata = parseObject(targetRow.targetMetadataJson, "target.targetMetadataJson");
    if (
      !SAFE_ID_RE.test(targetId)
      || Number(targetRow.ordinal) !== ordinal
      || String(targetRow.targetKey) !== committed.key
      || String(targetRow.targetLabel) !== committed.label
      || String(targetRow.role) !== committed.role
      || String(targetRow.status) !== "pending"
      || Number(targetRow.revision) !== 1
      || Number(targetRow.attempt) !== 0
      || String(targetRow.previousReleaseId) !== contract.previous.releaseId
      || String(targetRow.previousArtifactId) !== contract.previous.artifactId
      || metadata.serverId !== committed.serverId
      || metadata.wave !== committed.wave
      || (metadata.zone ?? undefined) !== (committed.zone ?? undefined)
      || metadata.prestageEvidenceSha256 !== contract.prestageEvidenceSha256
    ) {
      fail("维护预授权目标行与契约不一致", "RELEASE_MAINTENANCE_TARGET_LEDGER_INVALID", {
        targetKey: committed.key,
      });
    }
    return {
      ...committed,
      id: targetId,
      ordinal,
      status: "pending" as const,
      revision: 1 as const,
    };
  });
  return {
    deploymentId,
    releaseId: contract.target.releaseId,
    artifactId: contract.target.artifactId,
    previousReleaseId: contract.previous.releaseId,
    previousArtifactId: contract.previous.artifactId,
    activeScope: contract.scope,
    status: "running",
    phase: RELEASE_MAINTENANCE_ACTIVATION_PHASE,
    revision: 1,
    fencingToken: 1,
    contract,
    checkpoint,
    targets,
  };
}

function replayResult(
  row: RawRow,
  input: NormalizedInput,
): ReleaseMaintenanceActivationReservation {
  if (
    String(row.releaseId) !== input.releaseId
    || String(row.artifactId) !== input.artifactId
    || Number(row.requestedByUserId) !== input.operatorUserId
    || String(row.requestHash) !== input.requestSha256
    || String(row.status) !== "running"
    || String(row.phase) !== RELEASE_MAINTENANCE_ACTIVATION_PHASE
    || String(row.activeScope) !== input.scope
    || row.leaseOwner != null
    || row.leaseExpiresAt != null
  ) {
    fail("幂等键已用于不同维护激活请求", "RELEASE_MAINTENANCE_IDEMPOTENCY_CONFLICT");
  }
  const contract = parseContract(row);
  if (
    contract.requestSha256 !== input.requestSha256
    || contract.nonceSha256 !== input.nonceSha256
    || canonicalJson(contract.topology) !== canonicalJson(input.topology)
    || contract.prestageEvidenceSha256 !== input.prestageEvidence.evidenceSha256
    || contract.controllerStoppedEvidenceSha256 !== input.controllerStoppedEvidence.evidenceSha256
  ) {
    fail("维护激活幂等台账不匹配", "RELEASE_MAINTENANCE_IDEMPOTENCY_CONFLICT");
  }
  return {
    deploymentId: String(row.id),
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    status: "running",
    phase: RELEASE_MAINTENANCE_ACTIVATION_PHASE,
    activeScope: input.scope,
    requestSha256: input.requestSha256,
    contractSha256: contract.contractSha256,
    nonceSha256: input.nonceSha256,
    activationExpiresAt: contract.activationExpiresAt,
    replayed: true,
  };
}

async function earlyReplay(
  database: Knex,
  input: NormalizedInput,
): Promise<ReleaseMaintenanceActivationReservation | null> {
  const candidate = await database(RELEASE_DEPLOYMENT_TABLE)
    .where({ idempotencyKey: input.idempotencyKey })
    .first();
  if (!candidate) return null;
  return await database.transaction(async (trx) => {
    await acquireMaintenanceMutationLock(trx);
    const row = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ idempotencyKey: input.idempotencyKey })
      .forUpdate()
      .first();
    return row ? replayResult(row as RawRow, input) : null;
  });
}

function assertVerifiedEvidence(
  evidence: CachedReleaseArtifactEvidence,
  artifact: ReleaseMaintenanceArtifact,
): ReleaseMaintenanceArtifactIdentity {
  return artifactIdentity(artifact, evidence);
}

async function assertNonceUnused(
  trx: Knex.Transaction,
  nonceSha256: string,
): Promise<void> {
  const rows = await trx(RELEASE_DEPLOYMENT_TABLE)
    .where("planJson", "like", `%${RELEASE_MAINTENANCE_ACTIVATION_FORMAT}%`)
    .select("id", "planJson");
  for (const row of rows as RawRow[]) {
    const contract = parseContract(row);
    if (contract.nonceSha256 === nonceSha256) {
      fail("维护 nonce 已使用", "RELEASE_MAINTENANCE_NONCE_REPLAY", {
        deploymentId: String(row.id),
      });
    }
  }
}

function contractWithDigest(
  value: Omit<ReleaseMaintenanceActivationContract, "contractSha256">,
): ReleaseMaintenanceActivationContract {
  return { ...value, contractSha256: objectDigest(value) };
}

function exactAuthorization(consumed: ConsumedMaintenanceStepUpProof): ReleaseMaintenanceActivationContract["authorization"] {
  if (
    consumed.scope !== "admin.deployment"
    || consumed.actorRole !== "root"
    || (consumed.method !== "totp" && consumed.method !== "recovery")
  ) {
    fail("维护激活必须由 Root 使用 MFA 完成一次性授权", "RELEASE_MAINTENANCE_ROOT_MFA_REQUIRED");
  }
  return {
    proofRecordId: exactId(consumed.proofRecordId, "proofRecordId"),
    scope: "admin.deployment",
    method: consumed.method,
    authorizationRevision: positiveInteger(
      consumed.authorizationRevision,
      "authorizationRevision",
    ),
    expiresAt: timestamp(consumed.expiresAt, "authorization.expiresAt"),
    consumedAt: timestamp(consumed.consumedAt, "authorization.consumedAt"),
  };
}

/**
 * Reserve the one-time schema 40 -> 48 maintenance activation.
 *
 * This function deliberately does not stop API/Worker processes, migrate the
 * database, or start the target runtime.  It commits the immutable authority
 * and identities that the dedicated offline activator must acquire later.
 */
export async function reserveReleaseMaintenanceActivation(
  rawInput: ReleaseMaintenanceActivationInput,
  dependencies: ReleaseMaintenanceActivationDependencies,
): Promise<ReleaseMaintenanceActivationReservation> {
  const now = dependencies.now?.() ?? Date.now();
  const input = normalizeInput(rawInput, now);
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const definitions = RELEASE_MAINTENANCE_DATABASE_MIGRATIONS;
  releaseMaintenanceMigrationDigests(definitions);

  const replay = await earlyReplay(dependencies.database, input);
  if (replay) return replay;

  assertReleaseControllerStoppedEvidence(input.controllerStoppedEvidence, now);

  const targetRelease = await dependencies.database(PLATFORM_RELEASE_TABLE)
    .where({ id: input.releaseId, channel: input.channel })
    .first();
  if (!targetRelease || !["draft", "deploying"].includes(String(targetRelease.status))) {
    fail("目标版本不存在或状态不允许维护激活", "RELEASE_MAINTENANCE_RELEASE_STATE_INVALID");
  }
  const targetArtifact = await loadTargetArtifact(dependencies.database, input);
  const previous = await loadPreviousContext(dependencies.database, input);
  const [targetAttestation, previousAttestation] = await Promise.all([
    dependencies.verifyArtifact(targetArtifact, "target"),
    dependencies.verifyArtifact(previous.artifact, "previous"),
  ]);
  const targetIdentity = assertVerifiedEvidence(targetAttestation, targetArtifact);
  const previousIdentity = assertVerifiedEvidence(previousAttestation, previous.artifact);
  if (!targetIdentity.deployment || targetIdentity.deployment.mode !== "container-image") {
    fail(
      "目标制品缺少不可变容器镜像身份",
      "RELEASE_MAINTENANCE_PRIVATE_VALIDATION_INTENT_INVALID",
    );
  }
  const targetDeployment = targetIdentity.deployment;
  assertReleaseFullMaintenancePrivateValidationIntent(
    input.privateValidation.validationPlanIntent,
    {
      target: {
        releaseId: input.releaseId,
        artifactId: input.artifactId,
        artifactSha256: targetIdentity.artifactSha256,
        sourceCommit: targetIdentity.sourceCommit,
        schemaVersion: RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION,
        imageDigest: targetDeployment.imageDigest,
      },
      privateApiInventorySha256: input.expectedPrivateApiInventorySha256,
      now,
    },
  );
  assertReleaseMaintenancePrestageEvidence(input.prestageEvidence, {
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    artifactSha256: targetIdentity.artifactSha256,
    signedManifestFileSha256: targetIdentity.signedManifestFileSha256,
    targets: input.targets,
    now,
  });

  const inspectMigrations = dependencies.inspectMigrations
    ?? ((client, migrationDefinitions) => inspectDatabaseMigrations(
      client as Knex,
      migrationDefinitions,
    ));
  const consumeAuthorization = dependencies.consumeAuthorization;

  return await dependencies.database.transaction(async (trx) => {
    await acquireMaintenanceMutationLock(trx);
    const existing = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ idempotencyKey: input.idempotencyKey })
      .forUpdate()
      .first();
    if (existing) return replayResult(existing as RawRow, input);

    const lockedRelease = await trx(PLATFORM_RELEASE_TABLE)
      .where({ id: input.releaseId })
      .forUpdate()
      .first();
    if (
      !lockedRelease
      || String(lockedRelease.channel) !== input.channel
      || String(lockedRelease.status) !== "draft"
      || Number(lockedRelease.revision) !== input.releaseRevision
    ) {
      fail("目标版本状态或 revision 已变化", "RELEASE_MAINTENANCE_RELEASE_REVISION_CONFLICT");
    }
    const lockedTargetArtifact = await loadTargetArtifact(trx, input, true);
    const lockedPrevious = await loadPreviousContext(trx, input, true);
    if (
      canonicalJson(lockedTargetArtifact) !== canonicalJson(targetArtifact)
      || canonicalJson(lockedPrevious.artifact) !== canonicalJson(previous.artifact)
      || String(lockedPrevious.deployment.id) !== String(previous.deployment.id)
      || Number(lockedPrevious.deployment.revision) !== Number(previous.deployment.revision)
      || Number(lockedPrevious.release.revision) !== Number(previous.release.revision)
    ) {
      fail("制品或上一正式版本在校验后发生变化", "RELEASE_MAINTENANCE_PROVENANCE_CHANGED");
    }
    const active = await trx(RELEASE_DEPLOYMENT_TABLE).whereNotNull("activeScope").first();
    if (active) {
      fail("生产范围已有活动发布或待人工收敛任务", "RELEASE_MAINTENANCE_SCOPE_BUSY", {
        deploymentId: String(active.id),
      });
    }
    await assertNonceUnused(trx, input.nonceSha256);
    const migrationStatus = await inspectMigrations(trx, definitions);
    const migrationDigests = exactMigrationStatus(migrationStatus, definitions);

    // Artifact verification and MFA consumption can take time.  Re-observe the
    // trusted systemd unit while the global release mutation lock is held so a
    // stale/pre-fabricated inactive/dead snapshot cannot authorize the commit.
    const currentControllerStoppedEvidence = await dependencies.inspectControllerStopped();
    // Sample the validation/ledger clock only after the external systemd +
    // unit-file observation. The observation legitimately timestamps itself
    // near completion and must never appear to come from the future.
    const commitNow = dependencies.now?.() ?? Date.now();
    assertReleaseMaintenanceTopologyFresh(input.topology, commitNow);
    assertReleaseControllerStoppedEvidence(input.controllerStoppedEvidence, commitNow);
    assertReleaseControllerStoppedEvidence(currentControllerStoppedEvidence, commitNow);
    assertSameReleaseControllerIdentity(
      input.controllerStoppedEvidence,
      currentControllerStoppedEvidence,
    );

    const deploymentId = randomUUID();
    const consumed = consumeAuthorization
      ? await consumeAuthorization(trx, rawInput)
      : await consumeMaintenanceDeploymentStepUpProof(trx, {
        proof: rawInput.stepUpAuthorization.proof,
        userId: rawInput.operatorUserId,
        sessionId: rawInput.stepUpAuthorization.sessionId,
        now: commitNow,
      });
    const authorization = exactAuthorization(consumed);
    if (
      authorization.consumedAt > commitNow
      || authorization.expiresAt <= commitNow
    ) {
      fail(
        "Root MFA 一次性授权已过期或时间无效",
        "RELEASE_MAINTENANCE_ROOT_MFA_REQUIRED",
      );
    }
    const activationExpiresAt = Math.min(
      authorization.expiresAt,
      commitNow + RELEASE_MAINTENANCE_ACTIVATION_TTL_MS,
    );
    const validationPlanIntent = assertReleaseFullMaintenancePrivateValidationIntent(
      input.privateValidation.validationPlanIntent,
      {
        target: {
          releaseId: input.releaseId,
          artifactId: input.artifactId,
          artifactSha256: targetIdentity.artifactSha256,
          sourceCommit: targetIdentity.sourceCommit,
          schemaVersion: RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION,
          imageDigest: targetDeployment.imageDigest,
        },
        privateApiInventorySha256: input.expectedPrivateApiInventorySha256,
        now: commitNow,
      },
    );
    const contract = contractWithDigest({
      format: RELEASE_MAINTENANCE_ACTIVATION_FORMAT,
      trafficMode: RELEASE_MAINTENANCE_TRAFFIC_MODE,
      deploymentId,
      requestSha256: input.requestSha256,
      nonceSha256: input.nonceSha256,
      environment: "production",
      scope: input.scope,
      previous: {
        ...previousIdentity,
        releaseRevision: Number(lockedPrevious.release.revision),
        releaseVersion: String(lockedPrevious.release.version),
        channel: input.channel,
        deploymentId: String(lockedPrevious.deployment.id),
        deploymentRevision: Number(lockedPrevious.deployment.revision),
      },
      target: {
        ...targetIdentity,
        releaseRevision: Number(lockedRelease.revision),
        releaseVersion: String(lockedRelease.version),
        channel: input.channel,
      },
      inventory: { sha256: input.inventorySha256, targets: input.targets },
      privateApiInventorySha256: input.expectedPrivateApiInventorySha256,
      privateValidation: {
        validationPlanIntent,
        validationPlanIntentSha256: validationPlanIntent.validationPlanIntentSha256,
      },
      publicTrafficBarrier: input.publicTrafficBarrier,
      topology: input.topology,
      prestageEvidenceSha256: input.prestageEvidence.evidenceSha256,
      prestage: input.prestageEvidence,
      controllerStoppedEvidenceSha256: input.controllerStoppedEvidence.evidenceSha256,
      controllerStopped: input.controllerStoppedEvidence,
      databaseRoles: {
        allowedDatabaseRoles: input.allowedDatabaseRoles,
        applicationDatabaseRoles: input.applicationDatabaseRoles,
        sha256: input.databaseRolesSha256,
      },
      migration: {
        runId: input.migrationRunId,
        fromVersion: RELEASE_MAINTENANCE_SOURCE_SCHEMA_VERSION,
        toVersion: RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION,
        ...migrationDigests,
      },
      authorization,
      activationExpiresAt,
      createdAt: commitNow,
    });
    const plan = {
      planVersion: 1,
      mode: "maintenance-schema-upgrade-v1",
      trafficMode: RELEASE_MAINTENANCE_TRAFFIC_MODE,
      maintenanceActivation: contract,
      artifactSchemaVersion: RELEASE_MAINTENANCE_TARGET_SCHEMA_VERSION,
      artifactSchemaMode: "schema-neutral",
      artifactWorkerProtocolVersion: targetArtifact.manifest.workerProtocolVersion,
      strategy: RELEASE_MAINTENANCE_TRAFFIC_MODE,
      releaseId: input.releaseId,
      artifactId: input.artifactId,
      environment: "production",
      scope: input.scope,
      maxUnavailable: 1,
      minHealthyTargets: Math.max(
        1,
        input.targets.filter(({ role }) => role === "api").length - 1,
      ),
      minHealthyWorkers: Math.max(
        0,
        input.targets.filter(({ role }) => role === "worker").length - 1,
      ),
      drainTimeoutMs: 310_000,
      readinessTimeoutMs: 120_000,
      rollbackOnFailure: false,
      targets: input.targets.map((target, ordinal) => ({ ...target, ordinal })),
      waves: input.targets.map((target, wave) => ({ wave, targetKeys: [target.key] })),
    };
    const checkpoint = {
      format: RELEASE_MAINTENANCE_ACTIVATION_FORMAT,
      trafficMode: RELEASE_MAINTENANCE_TRAFFIC_MODE,
      operationId: deploymentId,
      phase: RELEASE_MAINTENANCE_ACTIVATION_PHASE,
      status: "running",
      contractSha256: contract.contractSha256,
      requestSha256: input.requestSha256,
      nonceSha256: input.nonceSha256,
      writerQuiescenceProofSha256: null,
      backupCheckpointEvidenceSha256: null,
      maintenanceBackfillReceiptSha256: null,
      revision: 1,
      createdAt: commitNow,
      updatedAt: commitNow,
    };

    const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
      .where({
        id: input.releaseId,
        status: "draft",
        revision: input.releaseRevision,
      })
      .update({
        status: "deploying",
        updatedByUserId: input.operatorUserId,
        updatedAt: commitNow,
        revision: input.releaseRevision + 1,
      });
    if (Number(releaseUpdated) !== 1) {
      fail("目标版本 revision CAS 失败", "RELEASE_MAINTENANCE_RELEASE_REVISION_CONFLICT");
    }

    const apiCount = input.targets.filter(({ role }) => role === "api").length;
    await trx(RELEASE_DEPLOYMENT_TABLE).insert({
      id: deploymentId,
      releaseId: input.releaseId,
      artifactId: input.artifactId,
      previousReleaseId: input.expectedPreviousReleaseId,
      previousArtifactId: input.expectedPreviousArtifactId,
      environment: "production",
      strategy: "rolling",
      status: "running",
      phase: RELEASE_MAINTENANCE_ACTIVATION_PHASE,
      activeScope: input.scope,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestSha256,
      planJson: JSON.stringify(plan),
      checkpointJson: JSON.stringify(checkpoint),
      manualInterventionRequired: 0,
      fencingToken: 1,
      targetCount: input.targets.length,
      completedTargetCount: 0,
      succeededTargetCount: 0,
      failedTargetCount: 0,
      maxUnavailable: 1,
      minHealthyTargets: Math.max(1, apiCount - 1),
      drainTimeoutMs: 310_000,
      readinessTimeoutMs: 120_000,
      rollbackOnFailure: 0,
      requestedByUserId: input.operatorUserId,
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: commitNow,
      completedAt: null,
      revision: 1,
      createdAt: commitNow,
      updatedAt: commitNow,
    });
    await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).insert(input.targets.map((target, ordinal) => ({
      id: randomUUID(),
      deploymentId,
      targetKey: target.key,
      targetLabel: target.label,
      role: target.role,
      ordinal,
      targetMetadataJson: JSON.stringify({
        serverId: target.serverId,
        wave: target.wave,
        ...(target.zone ? { zone: target.zone } : {}),
        prestageEvidenceSha256: input.prestageEvidence.evidenceSha256,
      }),
      status: "pending",
      attempt: 0,
      previousReleaseId: input.expectedPreviousReleaseId,
      previousArtifactId: input.expectedPreviousArtifactId,
      observedArtifactId: null,
      completedAt: null,
      revision: 1,
      createdAt: commitNow,
      updatedAt: commitNow,
    })));
    await trx(RELEASE_DEPLOYMENT_EVENT_TABLE).insert({
      id: randomUUID(),
      deploymentId,
      targetId: null,
      sequence: 1,
      eventType: "maintenance.activation_pre_authorized",
      phase: RELEASE_MAINTENANCE_ACTIVATION_PHASE,
      level: "warning",
      actor: "operator",
      actorUserId: input.operatorUserId,
      requestId: null,
      message: "Root MFA 已预授权 schema 40→48 离线维护激活；等待专用激活器取得维护租约",
      payloadJson: JSON.stringify({
        contractSha256: contract.contractSha256,
        requestSha256: input.requestSha256,
        nonceSha256: input.nonceSha256,
        proofRecordId: authorization.proofRecordId,
        inventorySha256: input.inventorySha256,
        topologyReceiptSha256: input.topology.receiptSha256,
        topologyInventorySha256: input.topology.inventorySha256,
        topologyReceiptDigest: input.topology.receiptDigest,
        topologyBusinessSha256: input.topology.businessSha256,
        migrationRegistrySha256: migrationDigests.registrySha256,
      }),
      createdAt: commitNow,
    });
    await trx("o_audit_log").insert({
      id: randomUUID(),
      workspaceId: null,
      actorUserId: input.operatorUserId,
      actorRole: "root",
      action: "admin.release_maintenance.pre_authorized",
      resourceType: "release_deployment",
      resourceId: deploymentId,
      ip: null,
      userAgent: null,
      metadata: JSON.stringify({
        releaseId: input.releaseId,
        artifactId: input.artifactId,
        previousReleaseId: input.expectedPreviousReleaseId,
        previousArtifactId: input.expectedPreviousArtifactId,
        contractSha256: contract.contractSha256,
        requestSha256: input.requestSha256,
        nonceSha256: input.nonceSha256,
        inventorySha256: input.inventorySha256,
        topologyReceiptSha256: input.topology.receiptSha256,
        topologyInventorySha256: input.topology.inventorySha256,
        topologyReceiptDigest: input.topology.receiptDigest,
        topologyBusinessSha256: input.topology.businessSha256,
        databaseRolesSha256: input.databaseRolesSha256,
        migrationRegistrySha256: migrationDigests.registrySha256,
        proofRecordId: authorization.proofRecordId,
        authorizationRevision: authorization.authorizationRevision,
        stepUpScope: "admin.deployment",
        actorKind: "user",
      }),
      createdAt: commitNow,
    });
    return {
      deploymentId,
      releaseId: input.releaseId,
      artifactId: input.artifactId,
      status: "running",
      phase: RELEASE_MAINTENANCE_ACTIVATION_PHASE,
      activeScope: input.scope,
      requestSha256: input.requestSha256,
      contractSha256: contract.contractSha256,
      nonceSha256: input.nonceSha256,
      activationExpiresAt,
      replayed: false,
    };
  });
}
