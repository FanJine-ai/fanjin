import type { Knex } from "knex";
import { db } from "@/utils/db";
import {
  getEffectiveWorkspacePermissions,
  hasExactPermission,
  roleHasDefaultPermission,
} from "@/middleware/permissions";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";

const PLATFORM_AUTHORITY_ROLES = new Set(["root", "admin", "super_admin"]);

export class WorkspaceAuthorityError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 403) {
    super(message);
    this.name = "WorkspaceAuthorityError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Re-check mutable workspace authority inside the mutation transaction.
 *
 * Lock order is deliberately all known users (ascending id) -> workspace ->
 * member. Callers must pass every already-known target user id before locking
 * workspace children so a request that passed HTTP middleware cannot commit
 * after its user, workspace, membership, role, or permission was revoked.
 */
export async function requireLiveWorkspaceAuthority(input: {
  database: Knex.Transaction;
  actorUserId: number;
  additionalUserIds?: number[];
  additionalMemberUserIds?: number[];
  lockAllWorkspaceMembers?: boolean;
  authenticatedWorkspaceId?: string | null;
  workspaceId: string;
  permission: string;
}): Promise<{
  actor: any;
  workspace: any;
  member: any | null;
  role: string;
  lockedUsers: any[];
  lockedMembers: any[];
}> {
  const actorUserId = Number(input.actorUserId || 0);
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw new WorkspaceAuthorityError(
      "未登录或登录状态已失效",
      "WORKSPACE_ACTOR_REQUIRED",
      401,
    );
  }

  const lockUserIds = Array.from(new Set([
    actorUserId,
    ...(input.additionalUserIds || [])
      .map((userId) => Number(userId || 0))
      .filter((userId) => Number.isSafeInteger(userId) && userId > 0),
  ])).sort((left, right) => left - right);
  const lockedUsers = await input.database("o_user")
    .whereIn("id", lockUserIds)
    .orderBy("id", "asc")
    .forUpdate()
    .select("*");
  const actor = lockedUsers.find((row: any) => Number(row.id) === actorUserId);
  if (!actor || actor.status !== "active") {
    throw new WorkspaceAuthorityError(
      "账号不可用",
      "ACCOUNT_UNAVAILABLE",
      403,
    );
  }

  const workspace = await input.database("o_workspace")
    .where({ id: input.workspaceId })
    .forUpdate()
    .first();
  if (!workspace || workspace.status !== "active") {
    throw new WorkspaceAuthorityError(
      "工作区不存在或已停用",
      "WORKSPACE_INACTIVE",
      403,
    );
  }

  const platformRole = String(actor.role || "").trim().toLowerCase();
  if (PLATFORM_AUTHORITY_ROLES.has(platformRole)) {
    const platformMemberUserIds = Array.from(new Set(
      (input.additionalMemberUserIds || [])
        .map((userId) => Number(userId || 0))
        .filter((userId) => Number.isSafeInteger(userId) && userId > 0),
    )).sort((left, right) => left - right);
    const lockedMembers = input.lockAllWorkspaceMembers || platformMemberUserIds.length
      ? await (() => {
          const query = input.database("o_workspace_member")
            .where({ workspaceId: input.workspaceId });
          if (!input.lockAllWorkspaceMembers) {
            query.whereIn("userId", platformMemberUserIds);
          }
          return query
          .orderBy("userId", "asc")
          .forUpdate()
          .select("*");
        })()
      : [];
    return {
      actor,
      workspace,
      member: null,
      role: platformRole,
      lockedUsers,
      lockedMembers,
    };
  }

  const authenticatedWorkspaceId = String(
    input.authenticatedWorkspaceId || "",
  ).trim();
  if (!authenticatedWorkspaceId || authenticatedWorkspaceId !== input.workspaceId) {
    throw new WorkspaceAuthorityError(
      "请求工作区与当前会话工作区不一致",
      authenticatedWorkspaceId
        ? "WORKSPACE_CONTEXT_MISMATCH"
        : "WORKSPACE_CONTEXT_REQUIRED",
      403,
    );
  }

  const memberUserIds = Array.from(new Set([
    actorUserId,
    ...(input.additionalMemberUserIds || [])
      .map((userId) => Number(userId || 0))
      .filter((userId) => Number.isSafeInteger(userId) && userId > 0),
  ])).sort((left, right) => left - right);
  const memberQuery = input.database("o_workspace_member")
    .where({ workspaceId: input.workspaceId });
  if (!input.lockAllWorkspaceMembers) {
    memberQuery.whereIn("userId", memberUserIds);
  }
  const lockedMembers = await memberQuery
    .orderBy("userId", "asc")
    .forUpdate()
    .select("*");
  const member = lockedMembers.find(
    (row: any) => Number(row.userId) === actorUserId,
  );
  const role = member?.status === "active"
    ? getConsistentWorkspaceRole({
      userId: member.userId,
      memberRole: member.role,
      ownerUserId: workspace.ownerUserId,
    })
    : null;
  if (!role) {
    throw new WorkspaceAuthorityError(
      "工作区权限已失效",
      "WORKSPACE_AUTHORITY_REVOKED",
      403,
    );
  }

  const permissions = getEffectiveWorkspacePermissions({
    ...member,
    role,
  });
  if (!hasExactPermission(permissions, input.permission)) {
    throw new WorkspaceAuthorityError(
      "工作区权限不足",
      "WORKSPACE_PERMISSION_REVOKED",
      403,
    );
  }

  return {
    actor,
    workspace,
    member,
    role,
    lockedUsers,
    lockedMembers,
  };
}

export async function revokeWorkspaceMemberAccess(input: {
  workspaceId: string;
  userId: number;
  reason?: string;
  database?: Knex | Knex.Transaction;
}): Promise<{ sessionsRevoked: number; apiKeysRevoked: number }> {
  const database = input.database || db;
  const now = Date.now();
  const sessionsRevoked = await database("o_user_session")
    .where({ workspaceId: input.workspaceId, userId: input.userId })
    .whereNull("revokedAt")
    .update({ revokedAt: now, updatedAt: now });

  const apiKeysRevoked = await database("o_api_key")
    .where({ scope: "workspace", workspaceId: input.workspaceId, ownerUserId: input.userId })
    .where((builder) => {
      builder.whereNull("revokedAt").orWhere("revokedAt", 0);
    })
    .update({
      disabled: 1,
      revokedAt: now,
      updateTime: now,
    });

  return {
    sessionsRevoked: Number(sessionsRevoked || 0),
    apiKeysRevoked: Number(apiKeysRevoked || 0),
  };
}

export async function revokeUserAccess(input: {
  userId: number;
  database?: Knex | Knex.Transaction;
}): Promise<{
  sessionsRevoked: number;
  apiKeysRevoked: number;
  authTokensRevoked: number;
}> {
  const database = input.database || db;
  const timestamp = Date.now();
  const sessionsRevoked = await database("o_user_session")
    .where({ userId: input.userId })
    .whereNull("revokedAt")
    .update({ revokedAt: timestamp, updatedAt: timestamp });
  const apiKeysRevoked = await database("o_api_key")
    .where({ ownerUserId: input.userId })
    .where((builder) => {
      builder.whereNull("revokedAt").orWhere("revokedAt", 0);
    })
    .update({
      disabled: 1,
      revokedAt: timestamp,
      updateTime: timestamp,
    });
  const authTokensRevoked = await database("o_auth_token")
    .where({ userId: input.userId })
    .whereNull("usedAt")
    .update({ usedAt: timestamp });
  return {
    sessionsRevoked: Number(sessionsRevoked || 0),
    apiKeysRevoked: Number(apiKeysRevoked || 0),
    authTokensRevoked: Number(authTokensRevoked || 0),
  };
}

/** 角色分配在成员事务内、写入任何字段前执行，防止创建/重新启用绕过更新限制。 */
export function assertWorkspaceRoleAssignment(input: {
  actorUserId: number;
  ownerUserId: number;
  actorRole: string;
  targetUserId?: number;
  targetRole?: string;
  role: string;
}) {
  if (PLATFORM_AUTHORITY_ROLES.has(String(input.actorRole || "").toLowerCase())) return;
  const assignsManagement = roleHasDefaultPermission(input.role, "member:write");
  if (assignsManagement && input.actorUserId !== Number(input.ownerUserId)) {
    throw new WorkspaceAuthorityError("只有所有者可以设定管理员", "WORKSPACE_OWNER_REQUIRED");
  }
  if (input.actorUserId !== Number(input.ownerUserId)
    && roleHasDefaultPermission(input.actorRole, "member:write") && (
    input.targetUserId === input.actorUserId || roleHasDefaultPermission(input.targetRole || "", "member:write")
  )) {
    throw new WorkspaceAuthorityError("管理员不能修改自己或其他管理员的角色", "WORKSPACE_ROLE_CHANGE_FORBIDDEN");
  }
}

export function assertWorkspaceMemberMutation(input: {
  actorUserId: number;
  ownerUserId: number;
  actorRole: string;
  targetUserId: number;
  targetRole: string;
  changesAuthority: boolean;
}) {
  if (PLATFORM_AUTHORITY_ROLES.has(String(input.actorRole || "").toLowerCase())) return;
  if (input.actorUserId === Number(input.ownerUserId)) return;
  if (
    input.changesAuthority
    && (
      input.targetUserId === input.actorUserId
      || roleHasDefaultPermission(input.targetRole, "member:write")
    )
  ) {
    throw new WorkspaceAuthorityError(
      "管理员不能修改自己的管理字段或管理能力成员",
      "WORKSPACE_MEMBER_MANAGEMENT_FORBIDDEN",
    );
  }
}
