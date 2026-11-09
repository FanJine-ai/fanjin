import type { Knex } from "knex";
import { db } from "@/utils/db";
import { getWorkspaceBillingSummary } from "@/lib/billing";
import { workspaceMembershipPolicy, workspaceSeatUsage } from "./membershipPolicy";

type LimitKey = "memberLimit" | "keyLimit" | "apiQuota";

export class WorkspaceLimitError extends Error {
  status = 402;
  code = "workspace_limit_exceeded";
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceLimitError";
    this.details = details;
  }
}

function readPositiveLimit(value: unknown): number | null {
  const limit = Number(value || 0);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

async function getPlanLimit(
  workspaceId: string,
  key: LimitKey,
  client?: Knex | Knex.Transaction | null,
): Promise<number | null> {
  if (key === "memberLimit") {
    const policy = await workspaceMembershipPolicy(client || db, workspaceId);
    if (policy.authorizationEnabled) return policy.limits.seats;
  }
  // v5 Batch A2: pass client (trx) through to avoid SQLite pool self-deadlock
  const summary = await getWorkspaceBillingSummary(workspaceId, client || undefined);
  return readPositiveLimit((summary.plan?.quotas as Record<string, unknown> | undefined)?.[key]);
}

// v5 Batch A5: 调用方传入 now（父表锁后捕获的参考时间），保证 N 计数与 TTL 用同一时间源。
// A4: 传入 trx 时锁 o_workspace 行（FOR UPDATE），防止 phantom。
// A5: now 必须在父表锁之后捕获 — 防止 TOCTOU（邀请在等锁期间过期导致 N 偏差）。
export async function assertWorkspaceMemberLimit(
  workspaceId: string,
  increment = 1,
  trx?: Knex.Transaction | null,
  now?: number,
): Promise<void> {
  // v5 Batch A4: Lock workspace row FIRST, before any queries.
  // A5: now 由调用方在父表锁后传入，保证计数用同一参考时间。
  if (trx) {
    await trx("o_workspace").where({ id: workspaceId }).forUpdate().first();
  }

  const limit = await getPlanLimit(workspaceId, "memberLimit", trx);
  if (!limit) return;  // Lock already acquired — safe to return

  const queryBuilder = trx || db;
  // A5: 使用调用方传入的 now（父表锁后捕获），不再独立调 Date.now()。
  const referenceNow = now ?? Date.now();

  const { activeMembers, pendingInvitations, current } = await workspaceSeatUsage(queryBuilder, workspaceId, referenceNow);
  if (current + increment > limit) {
    throw new WorkspaceLimitError("当前套餐成员数已达上限，请升级方案或停用不再使用的成员。", {
      workspaceId,
      limit,
      current,
      activeMembers,
      pendingInvitations,
      requested: increment,
    });
  }
}

export async function assertWorkspaceApiKeyLimit(
  workspaceId: string,
  increment = 1,
  trx?: Knex.Transaction | null,
): Promise<void> {
  if (trx) {
    await trx("o_workspace").where({ id: workspaceId }).forUpdate().first();
  }
  const client = trx || db;
  const limit = await getPlanLimit(workspaceId, "keyLimit", trx);
  if (!limit) return;

  const row = await client("o_api_key")
    .where({ workspaceId, scope: "workspace", disabled: 0 })
    .where((builder) => {
      builder.whereNull("revokedAt").orWhere("revokedAt", 0);
    })
    .count({ total: "*" })
    .first();
  const current = Number(row?.total || 0);
  if (current + increment > limit) {
    throw new WorkspaceLimitError("当前套餐 API Key 数量已达上限，请升级方案或吊销不再使用的密钥。", {
      workspaceId,
      limit,
      current,
      requested: increment,
    });
  }
}
