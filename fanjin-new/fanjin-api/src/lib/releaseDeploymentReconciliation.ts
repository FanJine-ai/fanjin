import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import {
  RELEASE_DEPLOYMENT_EVENT_TABLE,
  RELEASE_DEPLOYMENT_TABLE,
  RELEASE_DEPLOYMENT_TARGET_TABLE,
} from "@/lib/migrations/releaseDeploymentOrchestration";
import { RELEASE_DEPLOYMENT_RECONCILIATION_TABLE } from "@/lib/migrations/releaseDeploymentReconciliation";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import {
  acquireReleaseMutationLock,
  ReleaseDeploymentError,
  type ReleaseDeploymentPlan,
} from "@/lib/releaseDeployments";
import type { ReleaseCheckpoint } from "@/release-controller/types";
import { db } from "@/utils/db";

export const releaseReconciliationIntents = ["previous", "target"] as const;
export const releaseReconciliationStatuses = ["queued", "running", "succeeded", "failed"] as const;

export type ReleaseReconciliationIntent = (typeof releaseReconciliationIntents)[number];
export type ReleaseReconciliationStatus = (typeof releaseReconciliationStatuses)[number];

export interface ReleaseReconciliationApiEvidence {
  nodeId: string;
  artifactSha256: string;
  weight: number;
  health: "up";
}

export interface ReleaseReconciliationWorkerEvidence {
  nodeId: string;
  artifactSha256: string;
  schemaVersion: number;
  healthy: true;
  acceptingWork: true;
}

export interface ReleaseReconciliationEvidence {
  evidenceVersion: 1;
  artifactId: string;
  artifactSha256: string;
  schemaVersion: number;
  apiNodes: ReleaseReconciliationApiEvidence[];
  workers: ReleaseReconciliationWorkerEvidence[];
  publicSmoke: { ok: true; artifactSha256: string };
  verifiedAt: number;
}

export interface ReleaseDeploymentReconciliationRecord {
  id: string;
  deploymentId: string;
  intent: ReleaseReconciliationIntent;
  status: ReleaseReconciliationStatus;
  reason: string;
  idempotencyKey: string;
  requestedDeploymentRevision: number;
  requestedByUserId: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
  evidence: Record<string, unknown>;
  errorCode: string | null;
  safeError: string | null;
  startedAt: number | null;
  completedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseDeploymentReconciliationClaim {
  reconciliation: ReleaseDeploymentReconciliationRecord;
  deployment: {
    id: string;
    releaseId: string;
    artifactId: string;
    previousReleaseId: string | null;
    previousArtifactId: string | null;
    activeScope: string;
    plan: ReleaseDeploymentPlan;
    /** Present on database-backed claims; optional only for isolated adapters/tests. */
    checkpoint?: ReleaseCheckpoint;
  };
  leaseExpiresAt: number;
}

type RawRow = Record<string, any>;
type ReconcileDb = Knex | Knex.Transaction;

const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z0-9_.-]{1,80}$/;

function table(client: ReconcileDb, name: string): Knex.QueryBuilder {
  return (client as any)(name);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapReconciliation(row: RawRow): ReleaseDeploymentReconciliationRecord {
  return {
    id: String(row.id),
    deploymentId: String(row.deploymentId),
    intent: String(row.intent) as ReleaseReconciliationIntent,
    status: String(row.status) as ReleaseReconciliationStatus,
    reason: String(row.reason),
    idempotencyKey: String(row.idempotencyKey),
    requestedDeploymentRevision: Number(row.requestedDeploymentRevision),
    requestedByUserId: Number(row.requestedByUserId),
    leaseOwner: row.leaseOwner == null ? null : String(row.leaseOwner),
    leaseExpiresAt: row.leaseExpiresAt == null ? null : Number(row.leaseExpiresAt),
    fencingToken: Number(row.fencingToken),
    evidence: parseObject(row.evidenceJson),
    errorCode: row.errorCode == null ? null : String(row.errorCode),
    safeError: row.safeError == null ? null : String(row.safeError),
    startedAt: row.startedAt == null ? null : Number(row.startedAt),
    completedAt: row.completedAt == null ? null : Number(row.completedAt),
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function parsePlan(row: RawRow): ReleaseDeploymentPlan {
  const parsed = parseObject(row.planJson);
  if (!Array.isArray(parsed.targets) || typeof parsed.scope !== "string") {
    throw new ReleaseDeploymentError(
      "发布任务计划不可用于人工收敛",
      409,
      "RELEASE_RECONCILE_PLAN_INVALID",
    );
  }
  return parsed as unknown as ReleaseDeploymentPlan;
}

function normalizeKey(value: unknown, label: string): string {
  const normalized = String(value || "").trim();
  if (!SAFE_KEY_PATTERN.test(normalized)) {
    throw new ReleaseDeploymentError(`${label} 格式无效`, 400, "RELEASE_RECONCILE_KEY_INVALID");
  }
  return normalized;
}

function requestHash(input: {
  deploymentId: string;
  revision: number;
  intent: ReleaseReconciliationIntent;
  reason: string;
}): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    deploymentId: input.deploymentId,
    revision: input.revision,
    intent: input.intent,
    reason: input.reason,
  })).digest("hex");
}

async function appendDeploymentEvent(
  trx: Knex.Transaction,
  input: {
    deploymentId: string;
    eventType: string;
    phase: string;
    level?: "info" | "warning" | "error";
    actor: "operator" | "orchestrator";
    actorUserId?: number | null;
    requestId?: string | null;
    message: string;
    payload: Record<string, unknown>;
    now: number;
  },
): Promise<void> {
  const sequenceRow = await trx(RELEASE_DEPLOYMENT_EVENT_TABLE)
    .where({ deploymentId: input.deploymentId })
    .max({ sequence: "sequence" })
    .first();
  const sequence = Number((sequenceRow as RawRow | undefined)?.sequence || 0) + 1;
  await trx(RELEASE_DEPLOYMENT_EVENT_TABLE).insert({
    id: uuid(),
    deploymentId: input.deploymentId,
    targetId: null,
    sequence,
    eventType: input.eventType,
    phase: input.phase,
    level: input.level ?? "info",
    actor: input.actor,
    actorUserId: input.actorUserId ?? null,
    requestId: input.requestId ?? null,
    message: input.message,
    payloadJson: JSON.stringify(input.payload),
    createdAt: input.now,
  });
}

export async function requestReleaseDeploymentReconciliation(input: {
  id: string;
  revision: number;
  intent: ReleaseReconciliationIntent;
  reason: string;
  idempotencyKey: string;
  operatorUserId: number;
  requestId?: string | null;
}): Promise<{ reconciliation: ReleaseDeploymentReconciliationRecord; deploymentRevision: number; idempotent: boolean }> {
  const deploymentId = String(input.id || "").trim();
  const expectedRevision = Number(input.revision);
  const reason = String(input.reason || "").trim();
  const idempotencyKey = normalizeKey(input.idempotencyKey, "idempotencyKey");
  const operatorUserId = Number(input.operatorUserId);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(deploymentId)) {
    throw new ReleaseDeploymentError("发布任务 ID 格式无效", 400, "RELEASE_RECONCILE_ID_INVALID");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ReleaseDeploymentError("revision 必须为正整数", 400, "RELEASE_RECONCILE_REVISION_INVALID");
  }
  if (!releaseReconciliationIntents.includes(input.intent)) {
    throw new ReleaseDeploymentError("人工收敛 intent 无效", 400, "RELEASE_RECONCILE_INTENT_INVALID");
  }
  if (reason.length < 3 || reason.length > 500) {
    throw new ReleaseDeploymentError("reason 长度必须为 3-500", 400, "RELEASE_RECONCILE_REASON_INVALID");
  }
  if (!Number.isSafeInteger(operatorUserId) || operatorUserId < 1) {
    throw new ReleaseDeploymentError("操作人身份无效", 403, "RELEASE_RECONCILE_OPERATOR_INVALID");
  }
  const computedHash = requestHash({ deploymentId, revision: expectedRevision, intent: input.intent, reason });

  const initial = await db(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).select("releaseId").first();
  if (!initial) throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");

  try {
    return await (db as unknown as Knex).transaction(async (trx) => {
      // Match the normal release path's lock order: platform release first,
      // deployment second. This keeps reconcile/start/checkpoint transactions
      // from forming a release/deployment deadlock.
      await trx(PLATFORM_RELEASE_TABLE).where({ id: initial.releaseId }).forUpdate().first();
      const deployment = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).forUpdate().first();
      if (!deployment) throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");

      const replay = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)
        .where({ idempotencyKey })
        .first();
      if (replay) {
        if (String(replay.requestHash) !== computedHash) {
          throw new ReleaseDeploymentError(
            "idempotencyKey 已用于不同的人工收敛请求",
            409,
            "RELEASE_RECONCILE_IDEMPOTENCY_CONFLICT",
          );
        }
        return {
          reconciliation: mapReconciliation(replay),
          deploymentRevision: Number(deployment.revision),
          idempotent: true,
        };
      }
      if (String(deployment.status) !== "degraded_manual"
        || !deployment.activeScope
        || Number(deployment.manualInterventionRequired) !== 1
        || deployment.leaseOwner !== null
        || deployment.leaseExpiresAt !== null) {
        throw new ReleaseDeploymentError(
          "只有已停止控制器租约且保持生产锁的 degraded_manual 任务可人工收敛",
          409,
          "RELEASE_RECONCILE_STATE_INVALID",
        );
      }
      if (Number(deployment.revision) !== expectedRevision) {
        throw new ReleaseDeploymentError(
          "发布任务已变化，请刷新后重试",
          409,
          "RELEASE_RECONCILE_REVISION_CONFLICT",
          { expectedRevision, currentRevision: Number(deployment.revision) },
        );
      }
      if (input.intent === "previous" && (!deployment.previousArtifactId || !deployment.previousReleaseId)) {
        throw new ReleaseDeploymentError(
          "此任务没有可证明的上一正式版本制品",
          409,
          "RELEASE_RECONCILE_PREVIOUS_UNAVAILABLE",
        );
      }

      const now = Date.now();
      const reconciliationId = uuid();
      await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).insert({
        id: reconciliationId,
        deploymentId,
        activeDeploymentId: deploymentId,
        intent: input.intent,
        status: "queued",
        reason,
        idempotencyKey,
        requestHash: computedHash,
        requestedDeploymentRevision: expectedRevision,
        requestedByUserId: operatorUserId,
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 1,
        evidenceJson: "{}",
        errorCode: null,
        safeError: null,
        startedAt: null,
        completedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
        .where({ id: deploymentId, revision: expectedRevision, status: "degraded_manual" })
        .whereNotNull("activeScope")
        .update({
          phase: "manual-reconcile-queued",
          updatedAt: now,
          revision: expectedRevision + 1,
        });
      if (Number(updated || 0) !== 1) {
        throw new ReleaseDeploymentError(
          "发布任务已变化，请刷新后重试",
          409,
          "RELEASE_RECONCILE_REVISION_CONFLICT",
        );
      }
      await appendDeploymentEvent(trx, {
        deploymentId,
        eventType: "deployment.reconcile_requested",
        phase: "manual-reconcile-queued",
        actor: "operator",
        actorUserId: operatorUserId,
        requestId: input.requestId,
        message: "Root 已请求控制器重新核验并收敛生产集群",
        payload: { reconciliationId, intent: input.intent, reason, requestedRevision: expectedRevision },
        now,
      });
      const row = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: reconciliationId }).first();
      return { reconciliation: mapReconciliation(row), deploymentRevision: expectedRevision + 1, idempotent: false };
    });
  } catch (error: any) {
    if (error instanceof ReleaseDeploymentError) throw error;
    const conflict = await db(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ idempotencyKey }).first();
    if (conflict) {
      if (String(conflict.requestHash) !== computedHash) {
        throw new ReleaseDeploymentError(
          "idempotencyKey 已用于不同的人工收敛请求",
          409,
          "RELEASE_RECONCILE_IDEMPOTENCY_CONFLICT",
        );
      }
      const deployment = await db(RELEASE_DEPLOYMENT_TABLE).where({ id: deploymentId }).first();
      return {
        reconciliation: mapReconciliation(conflict),
        deploymentRevision: Number(deployment?.revision || expectedRevision),
        idempotent: true,
      };
    }
    if (String(error?.code || "").includes("UNIQUE") || String(error?.message || "").toLowerCase().includes("unique")) {
      throw new ReleaseDeploymentError(
        "此发布任务已有待处理的人工收敛请求",
        409,
        "RELEASE_RECONCILE_ACTIVE_CONFLICT",
      );
    }
    throw error;
  }
}

function leaseMs(value: unknown): number {
  const parsed = value == null ? 60_000 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 5_000 || parsed > 60 * 60_000) {
    throw new ReleaseDeploymentError("reconcile leaseMs 无效", 400, "RELEASE_RECONCILE_LEASE_INVALID");
  }
  return parsed;
}

/**
 * A CLB/SSH side effect cannot be fenced by a database token after it has left
 * the Controller process. Consequently an expired active deployment is never
 * taken over automatically. It is atomically quarantined while retaining its
 * activeScope lock; only a root-authored reconciliation request can later
 * release that lock after fresh, full-fleet verification.
 */
export async function quarantineOneExpiredReleaseDeployment(input: {
  takeoverGraceMs?: number;
  now?: number;
} = {}): Promise<boolean> {
  const grace = input.takeoverGraceMs == null ? 20 * 60_000 : Number(input.takeoverGraceMs);
  if (!Number.isSafeInteger(grace) || grace < 0 || grace > 60 * 60_000) {
    throw new ReleaseDeploymentError(
      "takeoverGraceMs 必须在 0-3600000 之间",
      400,
      "RELEASE_DEPLOYMENT_TAKEOVER_GRACE_INVALID",
    );
  }
  const now = input.now ?? Date.now();
  const cutoff = now - grace;
  const candidate = await db(RELEASE_DEPLOYMENT_TABLE)
    .whereIn("status", ["running", "cancelling", "rolling_back"])
    // A schema-maintenance reservation intentionally has no ordinary
    // controller lease.  It is acquired later by the dedicated offline
    // activator after the fleet is quiescent, so treating its null lease as a
    // lost rolling-controller lease would destroy the pre-authorization.
    .whereNot({ phase: "maintenance-preauthorized" })
    .whereNotNull("activeScope")
    .andWhere((lease) => {
      lease
        .where((dated) => dated.whereNotNull("leaseExpiresAt").andWhere("leaseExpiresAt", "<=", cutoff))
        .orWhere((undated) => undated.whereNull("leaseExpiresAt").andWhere("updatedAt", "<=", cutoff));
    })
    .orderBy("updatedAt", "asc")
    .first();
  if (!candidate) return false;

  return (db as unknown as Knex).transaction(async (trx) => {
    await trx(PLATFORM_RELEASE_TABLE).where({ id: candidate.releaseId }).forUpdate().first();
    const deployment = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: candidate.id }).forUpdate().first();
    if (!deployment
      || !["running", "cancelling", "rolling_back"].includes(String(deployment.status))
      || String(deployment.phase) === "maintenance-preauthorized"
      || !deployment.activeScope
      || Number(deployment.leaseExpiresAt ?? deployment.updatedAt) > cutoff) return false;
    const updated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: deployment.id, revision: deployment.revision, fencingToken: deployment.fencingToken })
      .whereNotNull("activeScope")
      .update({
        status: "degraded_manual",
        phase: "lease-lost-manual",
        manualInterventionRequired: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        fencingToken: Number(deployment.fencingToken) + 1,
        errorCode: "RELEASE_DEPLOYMENT_LEASE_EXPIRED_UNFENCED",
        safeError: "发布控制器租约过期；因 CLB/SSH 外部副作用无法数据库 fencing，已锁定生产范围等待 Root 核验",
        updatedAt: now,
        revision: Number(deployment.revision) + 1,
      });
    if (Number(updated || 0) !== 1) return false;
    await trx(RELEASE_DEPLOYMENT_TARGET_TABLE)
      .where({ deploymentId: deployment.id })
      .whereIn("status", ["pending", "draining", "deploying", "verifying", "rolling_back"])
      .update({
        status: "failed",
        completedAt: now,
        errorCode: "RELEASE_DEPLOYMENT_LEASE_EXPIRED_UNFENCED",
        safeError: "控制器租约过期，节点真实版本需重新核验",
        updatedAt: now,
        revision: trx.raw('"revision" + 1'),
      });
    await appendDeploymentEvent(trx, {
      deploymentId: String(deployment.id),
      eventType: "deployment.lease_expired_manual",
      phase: "lease-lost-manual",
      level: "error",
      actor: "orchestrator",
      message: "控制器租约过期且外部副作用不可 fencing，禁止自动接管并保留生产锁",
      payload: {
        previousLeaseOwner: deployment.leaseOwner == null ? null : String(deployment.leaseOwner),
        previousFencingToken: Number(deployment.fencingToken),
        takeoverGraceMs: grace,
      },
      now,
    });
    return true;
  });
}

/**
 * Reconciliation itself is verification-only, but an expired verifier must
 * still never be taken over silently. Fail the request, clear only its
 * per-request uniqueness slot, and retain the degraded deployment's
 * activeScope. A root must deliberately submit a new idempotent request.
 */
export async function failOneExpiredReleaseDeploymentReconciliation(now = Date.now()): Promise<boolean> {
  const candidate = await db(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)
    .where({ status: "running" })
    .whereNotNull("activeDeploymentId")
    .andWhere("leaseExpiresAt", "<=", now)
    .orderBy("leaseExpiresAt", "asc")
    .first();
  if (!candidate) return false;
  return (db as unknown as Knex).transaction(async (trx) => {
    const deployment = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: candidate.deploymentId }).forUpdate().first();
    const request = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: candidate.id }).forUpdate().first();
    if (!deployment || !request
      || String(request.status) !== "running"
      || Number(request.leaseExpiresAt || 0) > now) return false;
    const message = "人工收敛控制器租约过期；生产锁继续保留，需 Root 重新发起核验";
    await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)
      .where({ id: request.id, revision: request.revision, fencingToken: request.fencingToken, status: "running" })
      .update({
        status: "failed",
        activeDeploymentId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: "RELEASE_RECONCILE_LEASE_EXPIRED",
        safeError: message,
        completedAt: now,
        updatedAt: now,
        revision: Number(request.revision) + 1,
      });
    await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: deployment.id, revision: deployment.revision, status: "degraded_manual" })
      .whereNotNull("activeScope")
      .update({
        phase: "manual-reconcile-failed",
        manualInterventionRequired: 1,
        fencingToken: Number(deployment.fencingToken) + 1,
        errorCode: "RELEASE_RECONCILE_LEASE_EXPIRED",
        safeError: message,
        updatedAt: now,
        revision: Number(deployment.revision) + 1,
      });
    await appendDeploymentEvent(trx, {
      deploymentId: String(deployment.id),
      eventType: "deployment.reconcile_lease_expired",
      phase: "manual-reconcile-failed",
      level: "error",
      actor: "orchestrator",
      message: "人工收敛租约过期，禁止自动接管并继续保留生产锁",
      payload: { reconciliationId: String(request.id), fencingToken: Number(request.fencingToken) },
      now,
    });
    return true;
  });
}

export async function claimNextReleaseDeploymentReconciliation(input: {
  workerId: string;
  leaseMs?: number;
}): Promise<ReleaseDeploymentReconciliationClaim | null> {
  const workerId = normalizeKey(input.workerId, "workerId");
  const duration = leaseMs(input.leaseMs);
  const now = Date.now();
  const candidate = await db(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)
    .where({ status: "queued" })
    .whereNotNull("activeDeploymentId")
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .first();
  if (!candidate) return null;

  return (db as unknown as Knex).transaction(async (trx) => {
    const deployment = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: candidate.deploymentId })
      .forUpdate()
      .first();
    const request = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)
      .where({ id: candidate.id })
      .forUpdate()
      .first();
    if (!deployment || !request || String(request.status) !== "queued") return null;
    if (String(deployment.status) !== "degraded_manual"
      || !deployment.activeScope
      || Number(deployment.manualInterventionRequired) !== 1
      || deployment.leaseOwner !== null
      || deployment.leaseExpiresAt !== null) {
      throw new ReleaseDeploymentError(
        "人工收敛认领时发布任务安全锁状态无效",
        409,
        "RELEASE_RECONCILE_CLAIM_STATE_INVALID",
      );
    }
    const expiresAt = now + duration;
    const nextRevision = Number(request.revision) + 1;
    const nextFence = Number(request.fencingToken) + 1;
    const claimed = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)
      .where({ id: request.id, revision: request.revision, fencingToken: request.fencingToken, status: "queued" })
      .update({
        status: "running",
        leaseOwner: workerId,
        leaseExpiresAt: expiresAt,
        fencingToken: nextFence,
        startedAt: request.startedAt ?? now,
        updatedAt: now,
        revision: nextRevision,
      });
    if (Number(claimed || 0) !== 1) return null;
    await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: deployment.id, revision: deployment.revision }).update({
      phase: "manual-reconcile-verifying",
      fencingToken: Number(deployment.fencingToken) + 1,
      updatedAt: now,
      revision: Number(deployment.revision) + 1,
    });
    await appendDeploymentEvent(trx, {
      deploymentId: String(deployment.id),
      eventType: "deployment.reconcile_claimed",
      phase: "manual-reconcile-verifying",
      actor: "orchestrator",
      message: "发布控制器已认领人工收敛核验",
      payload: { reconciliationId: String(request.id), workerId, fencingToken: nextFence },
      now,
    });
    const row = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: request.id }).first();
    return {
      reconciliation: mapReconciliation(row),
      deployment: {
        id: String(deployment.id),
        releaseId: String(deployment.releaseId),
        artifactId: String(deployment.artifactId),
        previousReleaseId: deployment.previousReleaseId == null ? null : String(deployment.previousReleaseId),
        previousArtifactId: deployment.previousArtifactId == null ? null : String(deployment.previousArtifactId),
        activeScope: String(deployment.activeScope),
        plan: parsePlan(deployment),
        checkpoint: parseObject(
          deployment.checkpointJson,
        ) as unknown as ReleaseCheckpoint,
      },
      leaseExpiresAt: expiresAt,
    };
  });
}

export async function renewReleaseDeploymentReconciliationLease(input: {
  id: string;
  workerId: string;
  revision: number;
  fencingToken: number;
  leaseMs?: number;
}): Promise<{ revision: number; leaseExpiresAt: number }> {
  const now = Date.now();
  const expiresAt = now + leaseMs(input.leaseMs);
  const updated = await db(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)
    .where({
      id: input.id,
      status: "running",
      leaseOwner: input.workerId,
      revision: input.revision,
      fencingToken: input.fencingToken,
    })
    .andWhere("leaseExpiresAt", ">", now)
    .update({ leaseExpiresAt: expiresAt, updatedAt: now });
  if (Number(updated || 0) !== 1) {
    throw new ReleaseDeploymentError(
      "人工收敛控制器租约或 fencing token 已失效",
      409,
      "RELEASE_RECONCILE_LEASE_LOST",
    );
  }
  return { revision: input.revision, leaseExpiresAt: expiresAt };
}

function exactIds(actual: string[], expected: string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertCompleteEvidence(
  deployment: RawRow,
  reconciliation: RawRow,
  evidence: ReleaseReconciliationEvidence,
): { desiredArtifactId: string; desiredReleaseId: string; plan: ReleaseDeploymentPlan } {
  const plan = parsePlan(deployment);
  const targetIntent = String(reconciliation.intent) === "target";
  const desiredArtifactId = targetIntent ? String(deployment.artifactId) : String(deployment.previousArtifactId || "");
  const desiredReleaseId = targetIntent ? String(deployment.releaseId) : String(deployment.previousReleaseId || "");
  if (!desiredArtifactId || !desiredReleaseId || evidence.evidenceVersion !== 1
    || evidence.artifactId !== desiredArtifactId
    || !/^[a-f0-9]{64}$/.test(evidence.artifactSha256)
    || !Number.isSafeInteger(evidence.schemaVersion)
    || evidence.schemaVersion < 1
    || !Number.isSafeInteger(evidence.verifiedAt)
    || evidence.verifiedAt < Number(reconciliation.startedAt || 0)
    || evidence.publicSmoke?.ok !== true
    || evidence.publicSmoke.artifactSha256 !== evidence.artifactSha256) {
    throw new ReleaseDeploymentError(
      "人工收敛证据的制品身份或公网核验不完整",
      409,
      "RELEASE_RECONCILE_EVIDENCE_INVALID",
    );
  }
  const expectedApis = plan.targets.filter((target) => target.role === "api").map((target) => target.key);
  const expectedWorkers = plan.targets.filter((target) => target.role === "worker").map((target) => target.key);
  if (!exactIds(evidence.apiNodes.map((node) => node.nodeId), expectedApis)
    || !evidence.apiNodes.every((node) => node.health === "up"
      && Number(node.weight) > 0
      && node.artifactSha256 === evidence.artifactSha256)
    || !exactIds(evidence.workers.map((node) => node.nodeId), expectedWorkers)
    || !evidence.workers.every((node) => node.healthy === true
      && node.acceptingWork === true
      && node.artifactSha256 === evidence.artifactSha256
      && node.schemaVersion === evidence.schemaVersion)) {
    throw new ReleaseDeploymentError(
      "完整 API/Worker inventory 尚未全部收敛到同一制品",
      409,
      "RELEASE_RECONCILE_INVENTORY_NOT_CONVERGED",
    );
  }
  return { desiredArtifactId, desiredReleaseId, plan };
}

export async function completeReleaseDeploymentReconciliation(input: {
  id: string;
  workerId: string;
  revision: number;
  fencingToken: number;
  evidence: ReleaseReconciliationEvidence;
}): Promise<ReleaseDeploymentReconciliationRecord> {
  const seed = await db(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: input.id }).select("deploymentId").first();
  if (!seed) throw new ReleaseDeploymentError("人工收敛请求不存在", 404, "RELEASE_RECONCILE_NOT_FOUND");
  return (db as unknown as Knex).transaction(async (trx) => {
    // Reconciliation can publish the target baseline and always releases the
    // fleet scope. Take the same fleet lock as release start before touching
    // release/deployment rows so a start cannot commit a stale baseline.
    await acquireReleaseMutationLock(trx);
    const deploymentSeed = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: seed.deploymentId }).select("releaseId").first();
    if (!deploymentSeed) throw new ReleaseDeploymentError("发布任务不存在", 404, "RELEASE_DEPLOYMENT_NOT_FOUND");
    const release = await trx(PLATFORM_RELEASE_TABLE).where({ id: deploymentSeed.releaseId }).forUpdate().first();
    const deployment = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: seed.deploymentId }).forUpdate().first();
    const reconciliation = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: input.id }).forUpdate().first();
    const now = Date.now();
    if (!release || !deployment || !reconciliation
      || String(reconciliation.status) !== "running"
      || String(reconciliation.leaseOwner) !== input.workerId
      || Number(reconciliation.revision) !== input.revision
      || Number(reconciliation.fencingToken) !== input.fencingToken
      || Number(reconciliation.leaseExpiresAt || 0) <= now) {
      throw new ReleaseDeploymentError(
        "人工收敛完成时租约或 fencing token 已失效",
        409,
        "RELEASE_RECONCILE_LEASE_LOST",
      );
    }
    if (String(deployment.status) !== "degraded_manual"
      || !deployment.activeScope
      || Number(deployment.manualInterventionRequired) !== 1) {
      throw new ReleaseDeploymentError(
        "人工收敛完成时生产锁状态已变化",
        409,
        "RELEASE_RECONCILE_STATE_INVALID",
      );
    }
    const { desiredArtifactId } = assertCompleteEvidence(deployment, reconciliation, input.evidence);
    const artifact = await trx("o_release_artifact").where({ id: desiredArtifactId, status: "ready" }).first();
    if (!artifact || String(artifact.sha256) !== input.evidence.artifactSha256) {
      throw new ReleaseDeploymentError(
        "核验证据与已校验制品登记不匹配",
        409,
        "RELEASE_RECONCILE_ARTIFACT_MISMATCH",
      );
    }
    const intent = String(reconciliation.intent) as ReleaseReconciliationIntent;
    if (String(release.status) !== "deploying") {
      throw new ReleaseDeploymentError(
        "目标平台版本状态已变化，拒绝解除生产锁",
        409,
        "RELEASE_RECONCILE_RELEASE_STATE_INVALID",
      );
    }

    const targetStatus = intent === "target" ? "succeeded" : "rolled_back";
    await trx(RELEASE_DEPLOYMENT_TARGET_TABLE).where({ deploymentId: deployment.id }).update({
      status: targetStatus,
      observedArtifactId: desiredArtifactId,
      observedVersion: null,
      verifiedAt: now,
      completedAt: now,
      errorCode: null,
      safeError: null,
      updatedAt: now,
      revision: trx.raw('"revision" + 1'),
    });
    const deploymentStatus = intent === "target" ? "succeeded" : "rolled_back";
    const deploymentUpdated = await trx(RELEASE_DEPLOYMENT_TABLE)
      .where({ id: deployment.id, revision: deployment.revision, status: "degraded_manual" })
      .whereNotNull("activeScope")
      .update({
        status: deploymentStatus,
        phase: intent === "target" ? "reconciled-target" : "reconciled-previous",
        activeScope: null,
        manualInterventionRequired: 0,
        completedTargetCount: Number(deployment.targetCount),
        succeededTargetCount: intent === "target" ? Number(deployment.targetCount) : 0,
        failedTargetCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        errorCode: null,
        safeError: null,
        updatedAt: now,
        revision: Number(deployment.revision) + 1,
      });
    if (Number(deploymentUpdated || 0) !== 1) {
      throw new ReleaseDeploymentError("生产锁 CAS 失败", 409, "RELEASE_RECONCILE_UNLOCK_CONFLICT");
    }
    const releaseUpdated = await trx(PLATFORM_RELEASE_TABLE)
      .where({ id: deployment.releaseId, status: "deploying", revision: release.revision })
      .update(intent === "target" ? {
        status: "published",
        publishedAt: now,
        publishedByUserId: Number(reconciliation.requestedByUserId),
        updatedByUserId: Number(reconciliation.requestedByUserId),
        updatedAt: now,
        revision: Number(release.revision) + 1,
      } : {
        status: "draft",
        updatedByUserId: Number(reconciliation.requestedByUserId),
        updatedAt: now,
        revision: Number(release.revision) + 1,
      });
    if (Number(releaseUpdated || 0) !== 1) {
      throw new ReleaseDeploymentError("平台版本状态 CAS 失败", 409, "RELEASE_RECONCILE_RELEASE_WRITE_CONFLICT");
    }
    const requestUpdated = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)
      .where({
        id: input.id,
        status: "running",
        leaseOwner: input.workerId,
        revision: input.revision,
        fencingToken: input.fencingToken,
      })
      .update({
        status: "succeeded",
        activeDeploymentId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        evidenceJson: JSON.stringify(input.evidence),
        errorCode: null,
        safeError: null,
        completedAt: now,
        updatedAt: now,
        revision: input.revision + 1,
      });
    if (Number(requestUpdated || 0) !== 1) {
      throw new ReleaseDeploymentError("人工收敛结果 CAS 失败", 409, "RELEASE_RECONCILE_WRITE_CONFLICT");
    }
    await appendDeploymentEvent(trx, {
      deploymentId: String(deployment.id),
      eventType: "deployment.reconcile_succeeded",
      phase: intent === "target" ? "reconciled-target" : "reconciled-previous",
      actor: "orchestrator",
      message: "完整集群身份与公网冒烟已通过，生产发布锁已安全释放",
      payload: {
        reconciliationId: input.id,
        intent,
        artifactId: input.evidence.artifactId,
        artifactSha256: input.evidence.artifactSha256,
        apiNodeIds: input.evidence.apiNodes.map((node) => node.nodeId),
        workerNodeIds: input.evidence.workers.map((node) => node.nodeId),
        verifiedAt: input.evidence.verifiedAt,
      },
      now,
    });
    const row = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: input.id }).first();
    return mapReconciliation(row);
  });
}

export async function failReleaseDeploymentReconciliation(input: {
  id: string;
  workerId: string;
  revision: number;
  fencingToken: number;
  code: string;
  message: string;
  evidence?: Record<string, unknown>;
}): Promise<ReleaseDeploymentReconciliationRecord> {
  const code = SAFE_ERROR_CODE_PATTERN.test(input.code) ? input.code : "RELEASE_RECONCILE_FAILED";
  const message = String(input.message || "人工收敛核验失败").replace(/[\r\n\t]+/g, " ").slice(0, 500);
  const seed = await db(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: input.id }).select("deploymentId").first();
  if (!seed) throw new ReleaseDeploymentError("人工收敛请求不存在", 404, "RELEASE_RECONCILE_NOT_FOUND");
  return (db as unknown as Knex).transaction(async (trx) => {
    const deployment = await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: seed.deploymentId }).forUpdate().first();
    const request = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: input.id }).forUpdate().first();
    const now = Date.now();
    if (!deployment || !request
      || String(request.status) !== "running"
      || String(request.leaseOwner) !== input.workerId
      || Number(request.revision) !== input.revision
      || Number(request.fencingToken) !== input.fencingToken) {
      throw new ReleaseDeploymentError(
        "人工收敛失败写入时租约或 fencing token 已失效",
        409,
        "RELEASE_RECONCILE_LEASE_LOST",
      );
    }
    await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: input.id }).update({
      status: "failed",
      activeDeploymentId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      evidenceJson: JSON.stringify(input.evidence || {}),
      errorCode: code,
      safeError: message,
      completedAt: now,
      updatedAt: now,
      revision: input.revision + 1,
    });
    // Failure is intentionally not an unlock path. The degraded deployment
    // keeps activeScope and remains the only holder of the production scope.
    await trx(RELEASE_DEPLOYMENT_TABLE).where({ id: deployment.id, revision: deployment.revision }).update({
      status: "degraded_manual",
      phase: "manual-reconcile-failed",
      manualInterventionRequired: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: code,
      safeError: message,
      updatedAt: now,
      revision: Number(deployment.revision) + 1,
    });
    await appendDeploymentEvent(trx, {
      deploymentId: String(deployment.id),
      eventType: "deployment.reconcile_failed",
      phase: "manual-reconcile-failed",
      level: "error",
      actor: "orchestrator",
      message: "集群未通过完整身份核验，生产发布锁继续保留",
      payload: { reconciliationId: input.id, code },
      now,
    });
    const row = await trx(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE).where({ id: input.id }).first();
    return mapReconciliation(row);
  });
}
