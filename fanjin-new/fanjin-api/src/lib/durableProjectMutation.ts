import type { Request } from "express";
import type { Knex } from "knex";

import {
  abandonDurableCommand,
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import { isPostgresClient } from "@/lib/dbDialect";
import { db } from "@/utils/db";

export interface DurableProjectMutationResult<T> {
  data: T;
  replayed: boolean;
  responseStatus: number;
}

function projectMutationIdentity(req: Request): {
  workspaceId: string;
  actorUserId: number;
} {
  const project = (req as any).project;
  const workspaceId = String(
    project?.workspaceId || (req as any).auth?.workspaceId || "",
  ).trim();
  const actorUserId = Number((req as any).auth?.user?.id || 0);
  if (
    !workspaceId
    || !Number.isSafeInteger(actorUserId)
    || actorUserId <= 0
  ) {
    const error = new Error("写入请求缺少有效的工作区或操作账号") as Error & {
      status?: number;
    };
    error.status = 401;
    throw error;
  }
  return { workspaceId, actorUserId };
}

/**
 * Executes a project-scoped, database-only mutation with an optional
 * Idempotency-Key. The business rows and replay response are committed in the
 * same transaction, so a lost HTTP response can be replayed without applying
 * the mutation twice.
 */
export async function executeDurableProjectMutation<T>(input: {
  req: Request;
  scope: string;
  request: unknown;
  mutate: (transaction: Knex.Transaction) => Promise<T>;
}): Promise<DurableProjectMutationResult<T>> {
  const identity = projectMutationIdentity(input.req);
  const projectId = Number(
    (input.req as any).project?.id || input.req.body?.projectId || 0,
  );
  const reservation: DurableCommandReservation<T> = await beginDurableCommand<T>({
    ...identity,
    scope: input.scope,
    idempotencyKey: input.req.header("idempotency-key"),
    request: input.request,
    ...(Number.isSafeInteger(projectId) && projectId > 0
      ? { resourceType: "project", resourceId: projectId }
      : {}),
    // The business mutation and completion marker share one transaction. An
    // abandoned pre-transaction reservation can therefore be reclaimed safely.
    reservationStaleAfterMs: 30 * 1_000,
  });
  if (reservation.kind === "replay") {
    return {
      data: reservation.responseBody,
      replayed: true,
      responseStatus: reservation.responseStatus,
    };
  }

  let data: T;
  try {
    data = await db.transaction(async (transaction) => {
      if (Number.isSafeInteger(projectId) && projectId > 0) {
        let projectQuery = transaction("o_project")
          .where({ id: projectId, deletionState: "active" })
          .select("id");
        if (isPostgresClient(transaction)) projectQuery = projectQuery.forUpdate();
        if (!await projectQuery.first()) {
          const unavailable = new Error("项目正在删除或已不可用") as Error & {
            status?: number;
          };
          unavailable.status = 409;
          throw unavailable;
        }
      }
      const value = await input.mutate(transaction);
      await completeDurableCommand(reservation, value, 200, {
        database: transaction as any,
      });
      return value;
    });
  } catch (error) {
    // This helper checkpoints no external side effect: business rows and the
    // completion marker share the transaction above. A rollback therefore
    // makes a pre-transaction reservation safe to release immediately so a
    // corrected retry can reuse the same Idempotency-Key without waiting for
    // the stale-reservation timeout.
    try {
      await abandonDurableCommand(reservation);
    } catch {
      // Do not return the original business conflict while a reservation may
      // still be live: the client must keep the same key and retry recovery,
      // rather than assume that a terminal error was durably recorded.
      throw new DurableCommandIdempotencyError(
        503,
        "project_mutation_recovery_required",
        "写入事务已回滚，但幂等预约状态待恢复，请稍后使用相同 Idempotency-Key 重试",
      );
    }
    throw error;
  }
  return { data, replayed: false, responseStatus: 200 };
}
