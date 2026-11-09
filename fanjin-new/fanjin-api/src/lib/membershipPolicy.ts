import type { Knex } from "knex";
import { FREE_WORKSPACE_LIMITS, MEMBERSHIP_FEATURES, MEMBERSHIP_PLANS, MembershipError, parseMembershipQuote, type MembershipFeature } from "./membershipCatalog";
import { MEMBERSHIP_TABLES as T } from "./migrations/membershipEntitlements";

type Client = Knex | Knex.Transaction;

/** Runtime capabilities are independent of immutable financial order snapshots. */
export async function workspaceMembershipPolicy(client: Client, workspaceId: string, at = Date.now()) {
  const enabled = await client.schema.hasTable(T.control)
    ? await client(T.control).where({ tenantId: "FANJIN" }).first() : null;
  const authorizationEnabled = enabled?.authorizationEnabled === true || enabled?.authorizationEnabled === 1;
  const row = await client.schema.hasTable(T.subscription)
    ? await client(T.subscription).where({ workspaceId, tenantId: "FANJIN", status: "active" })
      .where("startsAt", "<=", at).where("endsAt", ">", at).orderBy("startsAt", "desc").first() : null;
  const quote = row ? parseMembershipQuote(typeof row.quote === "string" ? JSON.parse(row.quote) : row.quote) : null;
  const plan = quote ? MEMBERSHIP_PLANS.find(p => p.id === quote.planId) : null;
  return { authorizationEnabled, paid: !!plan, planId: plan?.id ?? null, expiresAt: row ? Number(row.endsAt) : null,
    features: plan ? Object.keys(MEMBERSHIP_FEATURES) as MembershipFeature[] : [],
    limits: plan?.limits ?? FREE_WORKSPACE_LIMITS };
}

/** Owner and each human count once; pending invitations reserve seats, keys do not. */
export async function workspaceSeatUsage(client: Client, workspaceId: string, at = Date.now()) {
  const workspace = await client("o_workspace").where({ id: workspaceId }).first();
  if (!workspace) throw new MembershipError("工作区不存在", "MEMBERSHIP_WORKSPACE_MISSING", 404);
  const active = await client("o_workspace_member").where({ workspaceId, status: "active" }).select("userId");
  const userIds = new Set(active.map(row => Number(row.userId)));
  userIds.add(Number(workspace.ownerUserId));
  const users = await client("o_user").whereIn("id", [...userIds]).select("email");
  const emails = new Set(users.map(row => String(row.email || "").trim().toLowerCase()).filter(Boolean));
  const pending = await client("o_workspace_invitation").where({ workspaceId, status: "pending" }).where("expiresAt", ">", at).select("email");
  const pendingEmails = new Set(pending.map(row => String(row.email || "").trim().toLowerCase()).filter(email => email && !emails.has(email)));
  return { activeMembers: userIds.size, pendingInvitations: pendingEmails.size, current: userIds.size + pendingEmails.size };
}

export async function assertMembershipSharedWrite(client: Client, workspaceId: string) {
  const policy = await workspaceMembershipPolicy(client, workspaceId);
  if (!policy.authorizationEnabled) return;
  const usage = await workspaceSeatUsage(client, workspaceId);
  if (usage.activeMembers > policy.limits.seats) throw new MembershipError(
    `工作区有 ${usage.activeMembers} 位成员，当前可用 ${policy.limits.seats} 个席位。请管理员先调整成员；已有内容仍可查看和下载。`,
    "MEMBERSHIP_SEATS_OVER_LIMIT", 409);
}
