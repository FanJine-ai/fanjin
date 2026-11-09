import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { db } from "@/utils/db";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const TRUSTED_GENERATED_IMAGE_COMMAND_RETENTION_MS =
  31 * 24 * 60 * 60 * 1_000;
const TRUSTED_PROJECT_IMAGE_SCOPE = "workbench:create:images";
const TRUSTED_PROJECT_IMAGE_RESOURCE = "workbench_generation_command";

export class DurableCommandIdempotencyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DurableCommandIdempotencyError";
  }
}

type DisabledReservation = { kind: "disabled" };
type CreatedReservation = { kind: "reserved"; id: string };
type ReplayedReservation<T> = {
  kind: "replay";
  responseStatus: number;
  responseBody: T;
};
type ResumeReservation = {
  kind: "resume";
  id: string;
  checkpoint: unknown;
};

export type DurableCommandReservation<T> =
  | DisabledReservation
  | CreatedReservation
  | ReplayedReservation<T>
  | ResumeReservation;

export type DurableCommandCheckpointMutation<TResponse, TCheckpoint> =
  | ReplayedReservation<TResponse>
  | {
      kind: "resume";
      id: string;
      checkpoint: TCheckpoint;
    };

export type DurableCommandReadStatus =
  | { kind: "not_found" }
  | {
      kind: "found";
      state: "reserved" | "checkpointed" | "completed";
      responseStatus: number | null;
      terminal: boolean;
      checkpointed: boolean;
      updatedAt: number;
    };

export type DurableCommandStoredResourceBinding = {
  resourceType: string;
  resourceId: string;
};

function isUniqueConstraintError(error: any): boolean {
  return (
    error?.code === "23505"
    || error?.code === "SQLITE_CONSTRAINT"
    || error?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || String(error?.message || "").toLowerCase().includes("unique constraint")
  );
}

function parseResponseBody<T>(value: unknown): T {
  if (typeof value !== "string" || !value.trim()) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_record_invalid",
      "幂等记录缺少可重放响应",
    );
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_record_invalid",
      "幂等记录响应格式无效",
    );
  }
}

function isPendingReconcileTerminal(row: Record<string, unknown>): boolean {
  if (
    String(row.status || "") !== "completed"
    || String(row.resourceType || "") !== "workbench_generation_command"
    || Number(row.responseStatus || 0) !== 409
  ) {
    return false;
  }
  try {
    const response = JSON.parse(String(row.responseBody || "")) as {
      code?: unknown;
    };
    return response?.code === "image_task_pending_reconcile";
  } catch {
    return false;
  }
}

async function readExisting<T>(input: {
  database: Knex | Knex.Transaction;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  now: number;
  reservationStaleAfterMs?: number;
}): Promise<ReplayedReservation<T> | ResumeReservation | null> {
  const row = await input.database("o_agent_idempotency")
    .where({
      scopeKey: input.scopeKey,
      idempotencyKey: input.idempotencyKey,
    })
    .first();
  if (!row) return null;
  // A checkpoint may already sit beyond an irreversible provider boundary.
  // Expiring it would make the same client key look new and can repeat the
  // external side effect. A completed pending-reconcile response is also a
  // permanent billing proof: platform-absorb reconciliation binds to this
  // exact 409/no-delivery terminal record. Keep both shapes until an explicit
  // reconciliation/archive policy exists; ordinary reservations and completed
  // replay records continue to use the normal TTL.
  if (
    Number(row.expiresAt || 0) <= input.now
    && String(row.status) !== "checkpointed"
    && !isPendingReconcileTerminal(row)
  ) {
    await input.database("o_agent_idempotency")
      .where({
        id: row.id,
        scopeKey: input.scopeKey,
        idempotencyKey: input.idempotencyKey,
        expiresAt: row.expiresAt,
      })
      .del();
    return null;
  }
  if (String(row.requestHash) !== input.requestHash) {
    throw new DurableCommandIdempotencyError(
      409,
      "idempotency_conflict",
      "同一 Idempotency-Key 已被不同请求使用",
    );
  }
  if (String(row.status) === "checkpointed") {
    return {
      kind: "resume",
      id: String(row.id),
      checkpoint: parseResponseBody<unknown>(row.responseBody),
    };
  }
  if (String(row.status) !== "completed") {
    const staleAfterMs = Number(input.reservationStaleAfterMs || 0);
    if (
      String(row.status) === "reserved"
      && Number.isSafeInteger(staleAfterMs)
      && staleAfterMs > 0
      && Number(row.updatedAt || row.createdAt || 0) <= input.now - staleAfterMs
    ) {
      const removed = await input.database("o_agent_idempotency")
        .where({
          id: row.id,
          scopeKey: input.scopeKey,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          status: "reserved",
          updatedAt: row.updatedAt,
        })
        .del();
      if (Number(removed) === 1) return null;
    }
    throw new DurableCommandIdempotencyError(
      409,
      "idempotency_in_progress",
      "相同生成请求正在处理或等待核对，请刷新任务状态后再操作",
    );
  }
  return {
    kind: "replay",
    responseStatus: Number(row.responseStatus || 200),
    responseBody: parseResponseBody<T>(row.responseBody),
  };
}

export async function beginDurableCommand<T>(input: {
  database?: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  scope: string;
  idempotencyKey?: string | null;
  request: unknown;
  now?: number;
  reservationStaleAfterMs?: number;
  initialCheckpoint?: unknown;
  resourceType?: string | null;
  resourceId?: string | number | null;
}): Promise<DurableCommandReservation<T>> {
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!idempotencyKey) return { kind: "disabled" };
  if (idempotencyKey.length > 200) {
    throw new DurableCommandIdempotencyError(
      400,
      "idempotency_key_invalid",
      "Idempotency-Key 不能超过 200 字符",
    );
  }
  if (!input.workspaceId || !Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_scope_invalid",
      "生成命令缺少有效的工作区或操作账号",
    );
  }

  const scopeKey = `${input.scope}:${input.workspaceId}:${input.actorUserId}`;
  const requestHash = hashIdempotencyRequest(input.request);
  const resourceType = String(input.resourceType || "").trim();
  const resourceId = String(input.resourceId ?? "").trim();
  if (
    (resourceType && resourceType.length > 80)
    || (resourceId && resourceId.length > 200)
    || Boolean(resourceType) !== Boolean(resourceId)
  ) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_resource_invalid",
      "生成命令缺少有效的资源绑定",
    );
  }
  const now = input.now ?? Date.now();
  const database = input.database || db;
  const existing = await readExisting<T>({
    database,
    scopeKey,
    idempotencyKey,
    requestHash,
    now,
    reservationStaleAfterMs: input.reservationStaleAfterMs,
  });
  if (existing) return existing;

  const id = randomUUID();
  const hasInitialCheckpoint = input.initialCheckpoint !== undefined;
  const initialCheckpointBody = hasInitialCheckpoint
    ? JSON.stringify(input.initialCheckpoint)
    : null;
  if (hasInitialCheckpoint && typeof initialCheckpointBody !== "string") {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_checkpoint_invalid",
      "生成命令的初始恢复检查点无效",
    );
  }
  try {
    await database("o_agent_idempotency").insert({
      id,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      scopeKey,
      idempotencyKey,
      requestHash,
      status: hasInitialCheckpoint ? "checkpointed" : "reserved",
      responseStatus: null,
      responseBody: initialCheckpointBody,
      resourceType: resourceType || "workbench_generation_command",
      resourceId: resourceId || null,
      expiresAt: now + IDEMPOTENCY_TTL_MS,
      createdAt: now,
      updatedAt: now,
    });
    if (hasInitialCheckpoint) {
      return {
        kind: "resume",
        id,
        checkpoint: input.initialCheckpoint,
      };
    }
    return { kind: "reserved", id };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await readExisting<T>({
      database,
      scopeKey,
      idempotencyKey,
      requestHash,
      now,
      reservationStaleAfterMs: input.reservationStaleAfterMs,
    });
    if (concurrent) return concurrent;
    throw error;
  }
}

/**
 * Reads a durable command without deleting expired rows, resuming checkpoints,
 * replaying a response, or triggering any domain mutation.
 */
export async function readDurableCommandStatus(input: {
  database?: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  scope: string;
  idempotencyKey: string;
  resourceType: string;
  resourceId: string | number;
  authorizeLinkedResource?: (input: {
    database: Knex | Knex.Transaction;
    authority: DurableCommandStoredResourceBinding;
    stored: DurableCommandStoredResourceBinding;
  }) => Promise<boolean>;
}): Promise<DurableCommandReadStatus> {
  const workspaceId = String(input.workspaceId || "").trim();
  const scope = String(input.scope || "").trim();
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  const resourceType = String(input.resourceType || "").trim();
  const resourceId = String(input.resourceId ?? "").trim();
  if (
    !workspaceId
    || !Number.isSafeInteger(input.actorUserId)
    || input.actorUserId <= 0
    || !scope
    || !idempotencyKey
    || idempotencyKey.length > 200
    || !resourceType
    || !resourceId
  ) {
    throw new DurableCommandIdempotencyError(
      400,
      "idempotency_status_request_invalid",
      "命令状态查询缺少有效的作用域、幂等键或资源绑定",
    );
  }
  const database = input.database || db;
  const scopeKey = `${scope}:${workspaceId}:${input.actorUserId}`;
  const located = await database("o_agent_idempotency")
    .where({
      workspaceId,
      actorUserId: input.actorUserId,
      scopeKey,
      idempotencyKey,
    })
    .select("id", "requestHash", "resourceType", "resourceId")
    .first();
  if (!located) return { kind: "not_found" };
  const stored = {
    resourceType: String(located.resourceType || "").trim(),
    resourceId: String(located.resourceId ?? "").trim(),
  };
  const authority = { resourceType, resourceId };
  const exactAuthority = (
    stored.resourceType === authority.resourceType
    && stored.resourceId === authority.resourceId
  );
  const linkedAuthority = !exactAuthority && input.authorizeLinkedResource
    ? await input.authorizeLinkedResource({ database, authority, stored })
    : false;
  if (!exactAuthority && !linkedAuthority) return { kind: "not_found" };

  const requestHash = String(located.requestHash || "").trim();
  if (!/^[a-f0-9]{64}$/.test(requestHash)) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_record_invalid",
      "命令状态记录缺少有效的请求绑定",
    );
  }
  // Re-read through the complete immutable command identity and the exact
  // stored resource snapshot. The first lookup only locates the opaque
  // request hash; no status is returned until actor/workspace/scope/key/hash
  // and the project-authority proof all agree.
  const row = await database("o_agent_idempotency")
    .where({
      id: String(located.id || ""),
      workspaceId,
      actorUserId: input.actorUserId,
      scopeKey,
      idempotencyKey,
      requestHash,
      resourceType: stored.resourceType,
      resourceId: stored.resourceId,
    })
    .select("status", "responseStatus", "updatedAt")
    .first();
  if (!row) return { kind: "not_found" };
  const state = String(row.status || "");
  if (!["reserved", "checkpointed", "completed"].includes(state)) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_record_invalid",
      "命令状态记录无效",
    );
  }
  return {
    kind: "found",
    state: state as "reserved" | "checkpointed" | "completed",
    responseStatus: row.responseStatus == null
      ? null
      : Number(row.responseStatus),
    terminal: state === "completed",
    checkpointed: state === "checkpointed",
    updatedAt: Number(row.updatedAt || 0),
  };
}

/**
 * Releases a reservation that failed before its first durable checkpoint.
 * Once a checkpoint exists, callers must resume or complete it instead of
 * deleting the recovery evidence.
 */
export async function abandonDurableCommand<T>(
  reservation: DurableCommandReservation<T>,
  options: { database?: Knex | Knex.Transaction } = {},
): Promise<void> {
  if (reservation.kind !== "reserved") return;
  const database = options.database || db;
  await database("o_agent_idempotency")
    .where({ id: reservation.id, status: "reserved" })
    .del();
}

export async function completeDurableCommand<T>(
  reservation: DurableCommandReservation<T>,
  responseBody: T,
  responseStatus = 200,
  options: {
    database?: Knex | Knex.Transaction;
    completedRetentionMs?: number;
    now?: number;
  } = {},
): Promise<void> {
  if (reservation.kind !== "reserved" && reservation.kind !== "resume") return;
  const database = options.database || db;
  const serializedResponseBody = JSON.stringify(responseBody);
  const completedAt = options.now ?? Date.now();
  if (!Number.isSafeInteger(completedAt) || completedAt <= 0) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_completion_time_invalid",
      "生成命令完成时间无效",
    );
  }
  const completedRetentionMs = options.completedRetentionMs ?? IDEMPOTENCY_TTL_MS;
  if (
    !Number.isSafeInteger(completedRetentionMs)
    || ![IDEMPOTENCY_TTL_MS, TRUSTED_GENERATED_IMAGE_COMMAND_RETENTION_MS]
      .includes(completedRetentionMs)
  ) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_completion_retention_invalid",
      "生成命令完成态保留策略无效",
    );
  }

  let trustedProjectImageAuthority: Record<string, unknown> | null = null;
  if (completedRetentionMs > IDEMPOTENCY_TTL_MS) {
    const response = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
      ? responseBody as Record<string, unknown>
      : null;
    const assets = response && Array.isArray(response.assets) ? response.assets : [];
    const projectBoundAssets = assets.length > 0 && assets.every((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const asset = value as Record<string, unknown>;
      return Number.isSafeInteger(Number(asset.assetId))
        && Number(asset.assetId) > 0
        && Number.isSafeInteger(Number(asset.assetVersionId))
        && Number(asset.assetVersionId) > 0
        && String(asset.assetType || "") === "image";
    });
    const authority = await database("o_agent_idempotency")
      .where({ id: reservation.id })
      .whereIn("status", ["reserved", "checkpointed"])
      .select(
        "workspaceId",
        "actorUserId",
        "scopeKey",
        "resourceType",
        "resourceId",
      )
      .first();
    const expectedScope = authority
      ? `${TRUSTED_PROJECT_IMAGE_SCOPE}:${String(authority.workspaceId || "")}:${Number(authority.actorUserId)}`
      : "";
    if (
      responseStatus !== 200
      || !response
      || !projectBoundAssets
      || Number(response.count) !== assets.length
      || !authority
      || String(authority.scopeKey || "") !== expectedScope
      || String(authority.resourceType || "") !== TRUSTED_PROJECT_IMAGE_RESOURCE
      || authority.resourceId !== null
    ) {
      throw new DurableCommandIdempotencyError(
        500,
        "idempotency_completion_retention_invalid",
        "只有同步项目图片成功响应可以延长完成态证据保留期",
      );
    }
    trustedProjectImageAuthority = authority;
  }

  let completion = database("o_agent_idempotency")
    .where({ id: reservation.id })
    .whereIn("status", ["reserved", "checkpointed"]);
  if (trustedProjectImageAuthority) {
    completion = completion
      .where({
        workspaceId: trustedProjectImageAuthority.workspaceId,
        actorUserId: trustedProjectImageAuthority.actorUserId,
        scopeKey: trustedProjectImageAuthority.scopeKey,
        resourceType: TRUSTED_PROJECT_IMAGE_RESOURCE,
      })
      .whereNull("resourceId");
  }
  const updated = await completion.update({
      status: "completed",
      responseStatus,
      responseBody: serializedResponseBody,
      // A command may legitimately remain checkpointed longer than the
      // normal replay TTL. Start the terminal replay window at completion so
      // an immediately retried client cannot re-run the completed side effect.
      expiresAt: completedAt + completedRetentionMs,
      updatedAt: completedAt,
    });
  if (Number(updated) === 1) return;
  const current = await database("o_agent_idempotency")
    .where({ id: reservation.id })
    .select("status", "responseStatus", "responseBody")
    .first();
  if (
    String(current?.status || "") === "completed"
    && Number(current?.responseStatus || 200) === responseStatus
    && String(current?.responseBody || "") === serializedResponseBody
  ) {
    return;
  }
  throw new DurableCommandIdempotencyError(
    409,
    "idempotency_completion_conflict",
    "生成命令的幂等状态已变化，请刷新任务状态",
  );
}

export async function checkpointDurableCommand<TResponse, TCheckpoint>(
  reservation: DurableCommandReservation<TResponse>,
  checkpoint: TCheckpoint,
  options: { database?: typeof db } = {},
): Promise<DurableCommandReservation<TResponse>> {
  if (reservation.kind === "disabled") return reservation;
  if (reservation.kind === "resume") return reservation;
  if (reservation.kind === "replay") {
    throw new DurableCommandIdempotencyError(
      409,
      "idempotency_checkpoint_conflict",
      "已完成的生成命令不能写入恢复检查点",
    );
  }
  const database = options.database || db;
  const updated = await database("o_agent_idempotency")
    .where({ id: reservation.id, status: "reserved" })
    .update({
      status: "checkpointed",
      responseStatus: null,
      responseBody: JSON.stringify(checkpoint),
      updatedAt: Date.now(),
    });
  if (Number(updated) !== 1) {
    throw new DurableCommandIdempotencyError(
      409,
      "idempotency_checkpoint_conflict",
      "生成命令的恢复检查点状态已变化，请刷新任务状态",
    );
  }
  return {
    kind: "resume",
    id: reservation.id,
    checkpoint,
  };
}

/**
 * Locks a checkpointed command, applies a caller-supplied database mutation,
 * and persists the next checkpoint in the same transaction. If another
 * request completed the command first, its exact response is returned.
 */
export async function mutateDurableCommandCheckpoint<TResponse, TCheckpoint>(
  reservation: DurableCommandReservation<TResponse>,
  mutate: (
    checkpoint: TCheckpoint,
    transaction: Knex.Transaction,
  ) => Promise<TCheckpoint> | TCheckpoint,
  options: { database?: Knex | Knex.Transaction } = {},
): Promise<DurableCommandCheckpointMutation<TResponse, TCheckpoint>> {
  if (reservation.kind === "replay") return reservation;
  if (reservation.kind === "disabled" || reservation.kind === "reserved") {
    throw new DurableCommandIdempotencyError(
      409,
      "idempotency_checkpoint_conflict",
      "生成命令尚未建立可恢复检查点",
    );
  }
  const database = options.database || db;
  return await database.transaction(async (transaction) => {
    const row = await transaction("o_agent_idempotency")
      .where({ id: reservation.id })
      .forUpdate()
      .select(
        "id",
        "status",
        "responseStatus",
        "responseBody",
        "expiresAt",
      )
      .first();
    if (!row) {
      throw new DurableCommandIdempotencyError(
        409,
        "idempotency_checkpoint_conflict",
        "生成命令的恢复检查点不存在",
      );
    }
    if (String(row.status) === "completed") {
      return {
        kind: "replay",
        responseStatus: Number(row.responseStatus || 200),
        responseBody: parseResponseBody<TResponse>(row.responseBody),
      };
    }
    if (String(row.status) !== "checkpointed") {
      throw new DurableCommandIdempotencyError(
        409,
        "idempotency_checkpoint_conflict",
        "生成命令的恢复检查点状态已变化，请刷新任务状态",
      );
    }

    const current = parseResponseBody<TCheckpoint>(row.responseBody);
    const next = await mutate(current, transaction);
    const serializedCheckpoint = JSON.stringify(next);
    if (typeof serializedCheckpoint !== "string") {
      throw new DurableCommandIdempotencyError(
        500,
        "idempotency_checkpoint_invalid",
        "生成命令的恢复检查点无效",
      );
    }
    const updated = await transaction("o_agent_idempotency")
      .where({ id: reservation.id, status: "checkpointed" })
      .update({
        responseStatus: null,
        responseBody: serializedCheckpoint,
        updatedAt: Date.now(),
      });
    if (Number(updated) !== 1) {
      throw new DurableCommandIdempotencyError(
        409,
        "idempotency_checkpoint_conflict",
        "生成命令的恢复检查点状态已变化，请刷新任务状态",
      );
    }
    return {
      kind: "resume",
      id: reservation.id,
      checkpoint: next,
    };
  });
}
