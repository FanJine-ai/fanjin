import type { Request } from "express";
import type { Knex } from "knex";
import { getEffectiveWorkspacePermissions } from "@/middleware/permissions";
import {
  requireLiveWorkspaceAuthority,
  type WorkspaceAuthorityError,
} from "@/lib/workspaceAccess";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import { db } from "@/utils/db";

const PLATFORM_API_KEY_ROLES = new Set(["root", "admin", "super_admin"]);

export type ApiKeyMutationScope =
  | { scope: "platform"; workspaceId: null }
  | { scope: "workspace"; workspaceId: string };

export class ApiKeyAuthorityError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiKeyAuthorityError";
  }
}

export function requestActorUserId(req: Request): number {
  const userId = Number(
    (req as any).auth?.user?.id
    || (req as any).user?.id
    || 0,
  );
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new ApiKeyAuthorityError(
      "未登录或登录状态已失效",
      401,
      "API_KEY_ACTOR_REQUIRED",
    );
  }
  return userId;
}

function isLivePlatformUser(user: any): boolean {
  return Boolean(
    user
    && user.status === "active"
    && PLATFORM_API_KEY_ROLES.has(String(user.role || "").toLowerCase()),
  );
}

export async function lockLivePlatformApiKeyUsers(input: {
  trx: Knex.Transaction;
  actorUserId: number;
  ownerUserId?: number | null;
  requireOwnerAuthority?: boolean;
}): Promise<{ actor: any; owner: any | null; lockedUsers: any[] }> {
  const ids = Array.from(new Set([
    input.actorUserId,
    Number(input.ownerUserId || 0),
  ].filter((userId) => Number.isSafeInteger(userId) && userId > 0)))
    .sort((left, right) => left - right);
  const lockedUsers = await input.trx("o_user")
    .whereIn("id", ids)
    .orderBy("id", "asc")
    .forUpdate()
    .select("*");
  const actor = lockedUsers.find(
    (user: any) => Number(user.id) === input.actorUserId,
  );
  if (!isLivePlatformUser(actor)) {
    throw new ApiKeyAuthorityError(
      "平台 API Key 操作权限已失效",
      403,
      "PLATFORM_API_KEY_ACTOR_REVOKED",
    );
  }
  const ownerUserId = Number(input.ownerUserId || 0);
  const owner = ownerUserId > 0
    ? lockedUsers.find((user: any) => Number(user.id) === ownerUserId) || null
    : null;
  if (input.requireOwnerAuthority && !isLivePlatformUser(owner)) {
    throw new ApiKeyAuthorityError(
      "平台 API Key 所属账号权限已失效",
      403,
      "PLATFORM_API_KEY_OWNER_INVALID",
    );
  }
  return { actor, owner, lockedUsers };
}

export async function lockLivePlatformApiKeyFundingAuthority(input: {
  trx: Knex.Transaction;
  owner: any;
}): Promise<{ workspace: any; member: any; role: string }> {
  const workspaceId = String(
    input.owner?.defaultWorkspaceId
    || input.owner?.currentWorkspaceId
    || "",
  ).trim();
  if (!workspaceId) {
    throw new ApiKeyAuthorityError(
      "平台 API Key 缺少有效资金工作区",
      403,
      "PLATFORM_API_KEY_FUNDING_WORKSPACE_REQUIRED",
    );
  }
  const workspace = await input.trx("o_workspace")
    .where({ id: workspaceId })
    .forUpdate()
    .first();
  if (!workspace || workspace.status !== "active") {
    throw new ApiKeyAuthorityError(
      "平台 API Key 资金工作区不可用",
      403,
      "PLATFORM_API_KEY_FUNDING_WORKSPACE_REVOKED",
    );
  }
  const member = await input.trx("o_workspace_member")
    .where({
      workspaceId,
      userId: Number(input.owner.id),
    })
    .forUpdate()
    .first();
  const role = member?.status === "active"
    ? getConsistentWorkspaceRole({
        userId: member.userId,
        memberRole: member.role,
        ownerUserId: workspace.ownerUserId,
      })
    : null;
  const permissions = role
    ? getEffectiveWorkspacePermissions({
        role,
        permissions: member.permissions,
        permissionsConfigured:
          member.permissions !== null && member.permissions !== undefined,
      })
    : [];
  if (!member || !role || !permissions.includes("generation:create")) {
    throw new ApiKeyAuthorityError(
      "平台 API Key 资金工作区权限已失效",
      403,
      "PLATFORM_API_KEY_FUNDING_AUTHORITY_REVOKED",
    );
  }
  return { workspace, member, role };
}

export function assertLiveWorkspaceApiKeyOwner(
  authority: Awaited<ReturnType<typeof requireLiveWorkspaceAuthority>>,
  ownerUserId: number,
): void {
  const owner = authority.lockedUsers.find(
    (user: any) => Number(user.id) === ownerUserId,
  );
  const member = authority.lockedMembers.find(
    (row: any) => Number(row.userId) === ownerUserId,
  );
  const role = member?.status === "active"
    ? getConsistentWorkspaceRole({
        userId: member.userId,
        memberRole: member.role,
        ownerUserId: authority.workspace.ownerUserId,
      })
    : null;
  const permissions = role
    ? getEffectiveWorkspacePermissions({
        role,
        permissions: member.permissions,
        permissionsConfigured:
          member.permissions !== null && member.permissions !== undefined,
      })
    : [];
  if (
    !owner
    || owner.status !== "active"
    || !member
    || !role
    || !permissions.includes("api_key:write")
  ) {
    throw new ApiKeyAuthorityError(
      "API Key 所属成员无权管理工作区密钥",
      403,
      "WORKSPACE_API_KEY_OWNER_UNAUTHORIZED",
    );
  }
}

export async function readApiKeyMutationSnapshot(input: {
  id: string;
  scope: ApiKeyMutationScope["scope"];
  workspaceId: string | null;
}): Promise<any | null> {
  return await db("o_api_key")
    .where({
      id: input.id,
      scope: input.scope,
      workspaceId: input.workspaceId,
    })
    .select("id", "scope", "workspaceId", "ownerUserId")
    .first() || null;
}

/**
 * Lock order for key mutations is:
 * all known users (ascending) -> workspace -> relevant members -> API key.
 *
 * The unlocked snapshot only discovers the immutable owner/scope tuple. The
 * tuple is rechecked after the key row lock, so a concurrent identity change
 * fails closed instead of changing the lock set under the transaction.
 */
export async function lockApiKeyMutationAuthority(input: {
  trx: Knex.Transaction;
  req: Request;
  snapshot: any;
  scope: ApiKeyMutationScope;
  requireOwnerAuthority: boolean;
}): Promise<{
  actor: any;
  owner: any | null;
  row: any;
}> {
  const actorUserId = requestActorUserId(input.req);
  const ownerUserId = Number(input.snapshot?.ownerUserId || 0);
  let actor: any;
  let owner: any | null = null;

  if (input.scope.scope === "workspace") {
    const authority = await requireLiveWorkspaceAuthority({
      database: input.trx,
      actorUserId,
      additionalUserIds: ownerUserId > 0 ? [ownerUserId] : [],
      additionalMemberUserIds: ownerUserId > 0 ? [ownerUserId] : [],
      authenticatedWorkspaceId: String(
        (input.req as any).auth?.workspaceId || "",
      ),
      workspaceId: input.scope.workspaceId,
      permission: "api_key:write",
    });
    actor = authority.actor;
    owner = authority.lockedUsers.find(
      (user: any) => Number(user.id) === ownerUserId,
    ) || null;
    if (input.requireOwnerAuthority) {
      assertLiveWorkspaceApiKeyOwner(authority, ownerUserId);
    }
  } else {
    const live = await lockLivePlatformApiKeyUsers({
      trx: input.trx,
      actorUserId,
      ownerUserId,
      requireOwnerAuthority: input.requireOwnerAuthority,
    });
    actor = live.actor;
    owner = live.owner;
    if (input.requireOwnerAuthority) {
      await lockLivePlatformApiKeyFundingAuthority({
        trx: input.trx,
        owner,
      });
    }
  }

  const row = await input.trx("o_api_key")
    .where({
      id: input.snapshot.id,
      scope: input.scope.scope,
      workspaceId: input.scope.workspaceId,
    })
    .forUpdate()
    .first();
  if (!row) {
    throw new ApiKeyAuthorityError(
      "API Key 不存在",
      404,
      "API_KEY_NOT_FOUND",
    );
  }
  if (
    String(row.scope || "") !== String(input.snapshot.scope || "")
    || String(row.workspaceId || "") !== String(input.snapshot.workspaceId || "")
    || Number(row.ownerUserId || 0) !== ownerUserId
  ) {
    throw new ApiKeyAuthorityError(
      "API Key 身份已变化，请重试",
      409,
      "API_KEY_IDENTITY_CHANGED",
    );
  }
  return { actor, owner, row };
}

export function isWorkspaceAuthorityError(
  err: unknown,
): err is WorkspaceAuthorityError {
  return Boolean(
    err
    && typeof err === "object"
    && (err as any).name === "WorkspaceAuthorityError"
    && typeof (err as any).status === "number"
    && typeof (err as any).code === "string",
  );
}
