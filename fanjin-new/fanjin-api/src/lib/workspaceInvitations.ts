import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import {
  AuthError,
  getAuthProfile,
  hashAuthToken,
  hashPassword,
  type RequestAuthInfo,
} from "@/lib/auth";
import { assertWorkspaceMemberLimit } from "@/lib/workspaceLimits";
import { assertMembershipFeature } from "@/lib/membership";
import { getEffectiveWorkspacePermissions, hasExactPermission } from "@/middleware/permissions";
import { writeAuditLog, normalizeActorRole, type AuditContext, type AuditActor } from "@/lib/audit";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import { insertAndReturnId } from "@/lib/dbDialect";
import {
  DEFAULT_PASSWORD_POLICY,
  getAccountSecurityPolicy,
  validatePasswordAgainstPolicy,
} from "@/lib/accountSecurity";
import {
  assertWorkspaceMemberMutation,
  assertWorkspaceRoleAssignment,
  requireLiveWorkspaceAuthority,
  revokeWorkspaceMemberAccess,
} from "@/lib/workspaceAccess";

const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const invitableWorkspaceRoles = new Set([
  "workspace_admin",
  "creator",
]);

export class WorkspaceInvitationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WorkspaceInvitationError";
    this.status = status;
  }
}

function invitationTtlMs(): number {
  const value = Number(process.env.FANJIN_INVITATION_TTL_MS || 0);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INVITATION_TTL_MS;
}

function publicBaseUrl(fallbackOrigin?: string | null): string {
  const configured = process.env.FANJIN_APP_PUBLIC_URL || process.env.FANJIN_PUBLIC_BASE_URL || process.env.ossURL || fallbackOrigin || "";
  return String(configured).replace(/\/+$/, "");
}

function invitationUrl(token: string, fallbackOrigin?: string | null): string {
  const baseUrl = publicBaseUrl(fallbackOrigin);
  return baseUrl ? `${baseUrl}/index.html#/auth/register?invite=${encodeURIComponent(token)}` : `#/auth/register?invite=${encodeURIComponent(token)}`;
}

function localNameFromEmail(email: string): string {
  return email.split("@")[0]?.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || `member-${crypto.randomBytes(3).toString("hex")}`;
}

async function uniqueUserName(
  baseName: string,
  client: Knex | Knex.Transaction = db,
): Promise<string> {
  const base = baseName.trim() || `member-${crypto.randomBytes(3).toString("hex")}`;
  let candidate = base;
  let index = 1;
  while (await client("o_user").where({ name: candidate }).first()) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
}

function invitationStatus(row: any, referenceNow = Date.now()): string {
  if (row.status !== "pending") return row.status || "pending";
  return Number(row.expiresAt || 0) <= referenceNow ? "expired" : "pending";
}

export function formatWorkspaceInvitation(
  row: any,
  referenceNow = Date.now(),
): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName ?? null,
    email: row.email,
    role: row.role,
    inviterUserId: row.inviterUserId ?? null,
    status: invitationStatus(row, referenceNow),
    expiresAt: Number(row.expiresAt || 0),
    acceptedAt: row.acceptedAt == null ? null : Number(row.acceptedAt),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

// Invitation acceptance already owns the target workspace/member locks. Mint
// the replacement session here instead of calling the generic session helper,
// which locks every workspace membership and would invert this transaction's
// deliberately narrow authority lock order.
async function createInvitationWorkspaceSession(
  trx: Knex.Transaction,
  input: {
    userId: number;
    workspaceId: string;
    authInfo: RequestAuthInfo;
  },
): Promise<Record<string, unknown>> {
  const user = await trx<any>("o_user")
    .where({ id: input.userId })
    .forUpdate()
    .first();
  if (!user || user.status !== "active") {
    throw new AuthError("账号不可用", 403, { code: "ACCOUNT_UNAVAILABLE" });
  }
  const workspace = await trx<any>("o_workspace")
    .where({ id: input.workspaceId, status: "active" })
    .first();
  const member = await trx<any>("o_workspace_member")
    .where({
      workspaceId: input.workspaceId,
      userId: input.userId,
      status: "active",
    })
    .first();
  if (!workspace || !member) {
    throw new AuthError("工作区权限已失效", 403, {
      code: "WORKSPACE_AUTHORITY_REVOKED",
    });
  }

  const tokenSetting = await trx<any>("o_setting")
    .where({ key: "tokenKey" })
    .select("value")
    .first();
  const tokenKey = String(tokenSetting?.value || "");
  if (!tokenKey) {
    throw new AuthError("会话服务暂不可用", 503, {
      code: "SESSION_CONFIGURATION_UNAVAILABLE",
    });
  }
  const security = await getAccountSecurityPolicy(trx, input.userId);
  const sessionTtlMs = security.sessionPolicy.absoluteHours * 60 * 60 * 1000;
  const sessionId = uuid();
  const rawToken = (jwt.sign as any)({
    id: input.userId,
    name: user.name,
    role: user.role ?? "member",
    workspaceId: input.workspaceId,
    sid: sessionId,
  }, tokenKey, {
    expiresIn: Math.max(60, Math.floor(sessionTtlMs / 1000)),
  });
  const timestamp = Date.now();
  await trx<any>("o_user_session").insert({
    id: sessionId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    tokenHash: hashAuthToken(rawToken),
    userAgent: input.authInfo.userAgent ?? null,
    ip: input.authInfo.ip ?? null,
    expiresAt: timestamp + sessionTtlMs,
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  });
  await trx<any>("o_user").where({ id: input.userId }).update({
    currentWorkspaceId: input.workspaceId,
    defaultWorkspaceId: user.defaultWorkspaceId || input.workspaceId,
    lastLoginAt: timestamp,
    updatedAt: Math.max(timestamp, Number(user.updatedAt || 0) + 1),
  });
  return {
    token: `Bearer ${rawToken}`,
    rawToken,
    sessionId,
    ...(await getAuthProfile(trx, input.userId)),
  };
}

async function loadInvitationByToken(
  rawToken: string,
  referenceNow = Date.now(),
): Promise<any> {
  const token = String(rawToken || "").trim();
  if (!token) throw new WorkspaceInvitationError("邀请链接无效", 400);
  const row = await db("o_workspace_invitation")
    .leftJoin("o_workspace", "o_workspace.id", "o_workspace_invitation.workspaceId")
    .where("o_workspace_invitation.tokenHash", hashAuthToken(token))
    .select("o_workspace_invitation.*", "o_workspace.name as workspaceName", "o_workspace.status as workspaceStatus")
    .first();
  if (!row) throw new WorkspaceInvitationError("邀请链接无效或已撤销", 404);
  // v6 Batch A6: snapshot-based effective status — absolutely read-only.
  // No UPDATE on expired; persistent expiry is an explicit transaction command only.
  if (row.status !== "pending") throw new WorkspaceInvitationError("邀请链接已失效", 410);
  if (Number(row.expiresAt || 0) <= referenceNow) throw new WorkspaceInvitationError("邀请链接已过期", 410);
  if (row.workspaceStatus !== "active") {
    throw new WorkspaceInvitationError("工作区不存在或已停用", 403);
  }
  return row;
}

export async function previewWorkspaceInvitation(rawToken: string): Promise<Record<string, unknown>> {
  const referenceNow = Date.now();
  const row = await loadInvitationByToken(rawToken, referenceNow);
  return formatWorkspaceInvitation(row, referenceNow);
}

export async function createWorkspaceInvitation(input: {
  workspaceId: string;
  email: string;
  role: string;
  inviterUserId?: number | null;
  authenticatedWorkspaceId?: string | null;
  origin?: string | null;
  // v5 Batch A: auditContext 必传（不再 optional）— mutation 与 required audit 必须同事务
  auditContext: AuditContext;
}): Promise<Record<string, unknown>> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new WorkspaceInvitationError("邀请邮箱不能为空");
  const role = String(input.role || "").trim().toLowerCase();
  if (!invitableWorkspaceRoles.has(role)) {
    throw new WorkspaceInvitationError("邀请角色无效", 400);
  }

  const rawToken = crypto.randomBytes(32).toString("base64url");

  let insertedId = "";
  let workspaceName = "";
  await db.transaction(async (trx) => {
    const actorUserId = Number(
      input.inviterUserId
      ?? input.auditContext.actor?.actorUserId
      ?? 0,
    );
    // Global authority lock order: user -> workspace -> member. This replaces
    // the old workspace-first route so session/member revocation cannot race
    // an invitation commit or deadlock against session creation.
    const { workspace, role: actorRole } = await requireLiveWorkspaceAuthority({
      database: trx,
      actorUserId,
      authenticatedWorkspaceId:
        input.authenticatedWorkspaceId
        ?? input.auditContext.workspaceId
        ?? null,
      workspaceId: input.workspaceId,
      permission: "member:write",
    });
    assertWorkspaceRoleAssignment({ actorUserId, ownerUserId: workspace.ownerUserId, actorRole, role });
    workspaceName = String(workspace.name || "");
    await assertMembershipFeature(input.workspaceId, "shared", trx);

    // v5 Batch A5: 在父表锁之后捕获唯一参考时间 now。
    // A5 修复 TOCTOU: 若在等锁期间邀请过期，用锁前 now 会把已过期邀请误计为 pending(N=1)，
    // 而实际 live pending=0，net=0 绕过配额。锁后捕获 now 保证 N 计数与 TTL 用同一时间源。
    const now = Date.now();
    const expiresAt = now + invitationTtlMs();

    // Accept/create share the workspace parent lock. This in-transaction
    // recheck makes an accept that committed first authoritative and prevents
    // recreating a pending invitation for an already-active member.
    const existingUser = await trx("o_user").where({ email }).first();
    if (existingUser) {
      if (Number(workspace.ownerUserId || 0) === Number(existingUser.id)) {
        throw new WorkspaceInvitationError("工作区 owner 无需邀请且不能由邀请变更", 409);
      }
      const existingMember = await trx("o_workspace_member")
        .where({
          workspaceId: input.workspaceId,
          userId: Number(existingUser.id),
        })
        .first();
      assertWorkspaceRoleAssignment({ actorUserId, ownerUserId: workspace.ownerUserId, actorRole, targetUserId: Number(existingUser.id), targetRole: existingMember?.role, role });
      if (existingMember?.status === "active") {
        throw new WorkspaceInvitationError("该邮箱已经是当前工作区成员", 409);
      }
    }

    // V2 seats deduplicate invitee identities: replacing any number of live
    // invitations for this email has zero net seat growth.
    // A4: removed aggregate COUNT(*) FOR UPDATE — PostgreSQL rejects it.
    // Parent o_workspace lock already serializes; plain count is safe.
    // Expired invitations (expiresAt <= now) are excluded from N.
    const existingPending = await trx("o_workspace_invitation")
      .where({ workspaceId: input.workspaceId, email, status: "pending" })
      .where("expiresAt", ">", now)
      .count({ total: "*" })
      .first();
    const existingCount = Number(existingPending?.total || 0);
    const netIncrement = existingCount > 0 ? 0 : 1;
    // A5: 传入 now，保证 assertWorkspaceMemberLimit 内部计数用同一参考时间。
    await assertWorkspaceMemberLimit(input.workspaceId, netIncrement, trx, now);

    await trx("o_workspace_invitation")
      .where({ workspaceId: input.workspaceId, email, status: "pending" })
      .update({ status: "superseded", updatedAt: now });
    insertedId = uuid();
    await trx("o_workspace_invitation").insert({
      id: insertedId,
      workspaceId: input.workspaceId,
      email,
      role,
      tokenHash: hashAuthToken(rawToken),
      inviterUserId: actorUserId,
      status: "pending",
      expiresAt,
      acceptedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // v5 Batch A: auditContext 必传，不再 if guard。审计与 mutation 同事务，required=true。
    const auditActor: AuditActor = {
      actorUserId: input.auditContext.actor?.actorUserId ?? null,
      actorRole: input.auditContext.actor?.actorRole !== undefined
        ? input.auditContext.actor?.actorRole
        : normalizeActorRole(null),
      actorKind: input.auditContext.actor?.actorKind,
    };
    await writeAuditLog(input.auditContext, {
      workspaceId: input.workspaceId,
      action: "workspace.invitation.create",
      resourceType: "workspace_invitation",
      resourceId: insertedId,
      required: true,
      actor: auditActor,
      metadata: { email, role },
    }, trx);
  });

  const row = await db("o_workspace_invitation")
    .where({ id: insertedId })
    .first();
  return {
    ...formatWorkspaceInvitation({ ...row, workspaceName }),
    inviteUrl: invitationUrl(rawToken, input.origin),
    note: "邀请链接只在本次响应返回，请通过安全渠道交给成员。",
  };
}

// v6 Batch A6: explicit expiry command — workspace parent lock first, then guarded update.
// All persistent expiry MUST go through this path, never through loadInvitationByToken.
export async function expireStaleInvitation(input: {
  workspaceId: string;
  invitationId: string;
  auditContext: AuditContext;
}): Promise<{ expired: boolean; updatedAt: number }> {
  let referenceNow = 0;
  let expired = false;
  let updatedAt = 0;
  await db.transaction(async (trx) => {
    // Lock order: workspace(父) → invitation(子)
    const workspace = await trx("o_workspace")
      .where({ id: input.workspaceId })
      .forUpdate()
      .first();
    if (!workspace || workspace.status !== "active") {
      throw new WorkspaceInvitationError("工作区不存在或已停用", 404);
    }
    referenceNow = Date.now();

    const row = await trx("o_workspace_invitation")
      .where({ id: input.invitationId, workspaceId: input.workspaceId })
      .forUpdate()
      .first();
    if (!row) throw new WorkspaceInvitationError("邀请不存在", 404);
    updatedAt = Number(row.updatedAt || referenceNow);
    if (row.status !== "pending") return; // already terminal
    if (Number(row.expiresAt || 0) > referenceNow) return; // not yet expired

    // Guarded update: only expire if still pending AND past expiry
    const updated = await trx("o_workspace_invitation")
      .where({
        id: input.invitationId,
        workspaceId: input.workspaceId,
        status: "pending",
      })
      .where("expiresAt", "<=", referenceNow)
      .update({ status: "expired", updatedAt: referenceNow });
    if (updated === 0) return;
    expired = true;
    updatedAt = referenceNow;

    const auditActor: AuditActor = {
      actorUserId: input.auditContext.actor?.actorUserId ?? null,
      actorRole: input.auditContext.actor?.actorRole !== undefined
        ? input.auditContext.actor?.actorRole
        : normalizeActorRole(null),
      actorKind: input.auditContext.actor?.actorKind,
    };
    await writeAuditLog(input.auditContext, {
      workspaceId: input.workspaceId,
      action: "workspace.invitation.expire",
      resourceType: "workspace_invitation",
      resourceId: input.invitationId,
      required: true,
      actor: auditActor,
    }, trx);
  });
  return { expired, updatedAt };
}

export async function revokeWorkspaceInvitation(input: {
  workspaceId: string;
  invitationId: string;
  actorUserId?: number | null;
  authenticatedWorkspaceId?: string | null;
  // v5 Batch A: auditContext 必传
  auditContext: AuditContext;
}): Promise<Record<string, unknown>> {
  let referenceNow = 0;
  await db.transaction(async (trx) => {
    await requireLiveWorkspaceAuthority({
      database: trx,
      actorUserId: Number(
        input.actorUserId
        ?? input.auditContext.actor?.actorUserId
        ?? 0,
      ),
      authenticatedWorkspaceId:
        input.authenticatedWorkspaceId
        ?? input.auditContext.workspaceId
        ?? null,
      workspaceId: input.workspaceId,
      permission: "member:write",
    });

    // Capture the reference time after the authority and workspace locks.
    referenceNow = Date.now();

    // F3: SELECT FOR UPDATE 锁行（子锁，在父锁之后），防止 accept/revoke 竞态
    const row = await trx("o_workspace_invitation")
      .where({ id: input.invitationId, workspaceId: input.workspaceId })
      .forUpdate()
      .first();
    if (!row) throw new WorkspaceInvitationError("邀请不存在或已失效", 404);
    if (row.status !== "pending") {
      throw new WorkspaceInvitationError(
        row.status === "accepted" ? "邀请已被接受，无法撤销" : "邀请已失效，无法撤销",
        row.status === "accepted" ? 410 : 410,
      );
    }
    if (Number(row.expiresAt || 0) <= referenceNow) {
      throw new WorkspaceInvitationError("邀请链接已过期，无法撤销", 410);
    }
    await trx("o_workspace_invitation")
      .where({
        id: input.invitationId,
        workspaceId: input.workspaceId,
        status: "pending",
      })
      .update({ status: "revoked", updatedAt: referenceNow });

    // v5 Batch A: auditContext 必传，不再 if guard。
    const auditActor: AuditActor = {
      actorUserId: input.auditContext.actor?.actorUserId ?? null,
      actorRole: input.auditContext.actor?.actorRole !== undefined
        ? input.auditContext.actor?.actorRole
        : normalizeActorRole(null),
      actorKind: input.auditContext.actor?.actorKind,
    };
    await writeAuditLog(input.auditContext, {
      workspaceId: input.workspaceId,
      action: "workspace.invitation.revoke",
      resourceType: "workspace_invitation",
      resourceId: input.invitationId,
      required: true,
      actor: auditActor,
    }, trx);
  });
  return { id: input.invitationId, workspaceId: input.workspaceId, status: "revoked", updatedAt: referenceNow };
}

export async function listWorkspaceInvitations(workspaceId: string): Promise<Record<string, unknown>[]> {
  const rows = await db("o_workspace_invitation")
    .leftJoin("o_workspace", "o_workspace.id", "o_workspace_invitation.workspaceId")
    .where("o_workspace_invitation.workspaceId", workspaceId)
    .select("o_workspace_invitation.*", "o_workspace.name as workspaceName")
    .orderBy("o_workspace_invitation.createdAt", "desc");
  return rows.map(formatWorkspaceInvitation);
}

export async function acceptWorkspaceInvitation(
  input: {
    token: string;
    password?: string | null;
    displayName?: string | null;
    authenticatedUserId?: number | null;
    authenticatedSession?: {
      id: string;
      userId: number;
      tokenHash: string;
      authGeneration: number;
    } | null;
    // v5 Batch A: auditContext 必传
    auditContext: AuditContext;
  },
  authInfo: RequestAuthInfo = {},
): Promise<Record<string, unknown>> {
  const invitation = await loadInvitationByToken(input.token);
  const preflightEmail = String(invitation.email || "").trim().toLowerCase();
  const candidateExistingUser = await db("o_user")
    .where({ email: preflightEmail })
    .select("id")
    .first();
  const candidateExistingUserId = Number(candidateExistingUser?.id || 0);
  const authenticatedUserId = Number(input.authenticatedUserId || 0);
  const authenticatedSession = input.authenticatedSession || null;
  if (
    authenticatedSession
    && Number(authenticatedSession.userId || 0) !== authenticatedUserId
  ) {
    throw new AuthError("会话身份不一致", 401, { code: "SESSION_REVOKED" });
  }
  const userIdsToLock = Array.from(new Set([
    candidateExistingUserId,
    authenticatedUserId,
    Number(invitation.inviterUserId || 0),
  ].filter((value) => Number.isSafeInteger(value) && value > 0)))
    .sort((left, right) => left - right);
  let userId = 0;
  let result: Record<string, unknown> | null = null;

  await db.transaction(async (trx) => {
    // Global lock order: every known user (ascending id) -> exact authenticated
    // session -> workspace -> invitation -> member. In particular, an existing
    // invitee is locked before the workspace so concurrent login/session
    // creation cannot form a user<->workspace deadlock with acceptance.
    if (userIdsToLock.length) {
      await trx("o_user")
        .whereIn("id", userIdsToLock)
        .orderBy("id", "asc")
        .forUpdate()
        .select("*");
    }

    let lockedAuthenticatedSession: any | null = null;
    if (authenticatedUserId) {
      const authenticatedUser = await trx("o_user")
        .where({ id: authenticatedUserId })
        .first();
      const sessionId = String(authenticatedSession?.id || "").trim();
      const sessionTokenHash = String(authenticatedSession?.tokenHash || "").trim();
      const authGeneration = Number(authenticatedSession?.authGeneration);
      if (
        !authenticatedSession
        || !authenticatedUser
        || authenticatedUser.status !== "active"
        || !sessionId
        || !sessionTokenHash
        || !Number.isFinite(authGeneration)
        || Number(authenticatedUser.updatedAt || 0) !== authGeneration
      ) {
        throw new AuthError("会话已失效，请重新登录", 401, {
          code: "SESSION_REVOKED",
        });
      }
      lockedAuthenticatedSession = await trx("o_user_session")
        .where({
          id: sessionId,
          userId: authenticatedUserId,
          tokenHash: sessionTokenHash,
        })
        .whereNull("revokedAt")
        .forUpdate()
        .first();
      if (
        !lockedAuthenticatedSession
        || (
          lockedAuthenticatedSession.expiresAt != null
          && Number(lockedAuthenticatedSession.expiresAt) <= Date.now()
        )
      ) {
        throw new AuthError("会话已失效，请重新登录", 401, {
          code: "SESSION_REVOKED",
        });
      }
    }
    const ws = await trx("o_workspace").where({ id: invitation.workspaceId }).forUpdate().first();
    // v6 Batch A6: verify workspace still exists and is active after acquiring parent lock.
    // create/accept/revoke all require a live workspace.
    if (!ws || ws.status !== "active") throw new WorkspaceInvitationError("工作区不存在或已停用", 404);

    // A5: 在父表锁后捕获参考时间，防止 TOCTOU（邀请在等锁期间过期）。
    const now = Date.now();

    // F3: SELECT FOR UPDATE 锁定邀请行（子锁，在父锁之后），替代 accepting 中间状态。
    // 行锁持续到事务结束，阻止 accept/accept、accept/revoke 并发。
    // 不再使用 accepting 中间状态——事务回滚后不会留下卡住的中间态。
    const locked = await trx("o_workspace_invitation")
      .where({ id: invitation.id })
      .forUpdate()
      .first();
    if (!locked) throw new WorkspaceInvitationError("邀请链接无效或已撤销", 404);
    if (
      String(locked.workspaceId) !== String(invitation.workspaceId) ||
      String(locked.tokenHash) !== String(invitation.tokenHash) ||
      String(locked.email || "").trim().toLowerCase() !== preflightEmail
    ) {
      throw new WorkspaceInvitationError("邀请链接状态不一致", 409);
    }
    if (locked.status !== "pending") {
      throw new WorkspaceInvitationError(
        locked.status === "accepted" ? "该邀请已被接受" :
        locked.status === "revoked" ? "邀请链接已撤销" :
        "邀请链接已失效",
        410,
      );
    }
    if (Number(locked.expiresAt || 0) <= now) {
      throw new WorkspaceInvitationError("邀请链接已过期", 410);
    }
    if (!invitableWorkspaceRoles.has(String(locked.role || "").toLowerCase())) {
      throw new WorkspaceInvitationError("邀请角色无效或已不受支持", 409);
    }

    const inviterUser = userIdsToLock.includes(Number(locked.inviterUserId))
      ? await trx("o_user").where({ id: Number(locked.inviterUserId) }).first()
      : null;
    if (!inviterUser || inviterUser.status !== "active") {
      throw new WorkspaceInvitationError("邀请者账号已不可用", 403);
    }

    // D: increment=0 — 邀请已在 pendingInvitations 中计数，accept 转为 active 后净变化为 0
    // A5: 传入 now，保证 assertWorkspaceMemberLimit 内部计数用同一参考时间。
    await assertWorkspaceMemberLimit(invitation.workspaceId, 0, trx, now);

    const lockedEmail = String(locked.email || "").trim().toLowerCase();
    const displayName = (input.displayName || lockedEmail).trim();
    const existingUser = await trx("o_user").where({ email: lockedEmail }).first();
    if (existingUser) {
      userId = Number(existingUser.id);
      if (userId !== candidateExistingUserId || !userIdsToLock.includes(userId)) {
        throw new WorkspaceInvitationError("邀请账号状态已变化，请重试", 409);
      }
      if (Number(input.authenticatedUserId || 0) !== userId) {
        throw new WorkspaceInvitationError("该邮箱已有账号，请先登录该账号后接受邀请", 403);
      }
      if (existingUser.status && existingUser.status !== "active") {
        throw new WorkspaceInvitationError("该账号已停用，无法接受邀请", 403);
      }
      await trx("o_user").where({ id: userId }).update({
        displayName: existingUser.displayName || displayName || existingUser.name,
        currentWorkspaceId: invitation.workspaceId,
        updatedAt: now,
      });
    } else {
      const passwordError = validatePasswordAgainstPolicy(
        String(input.password || ""),
        DEFAULT_PASSWORD_POLICY,
      );
      if (passwordError) throw new AuthError(passwordError);
      const reservedUserName = await uniqueUserName(
        localNameFromEmail(lockedEmail),
        trx,
      );
      userId = await insertAndReturnId(trx, "o_user", {
        name: reservedUserName,
        email: lockedEmail,
        displayName,
        password: await hashPassword(String(input.password)),
        passwordChangedAt: now,
        role: "member",
        status: "active",
        currentWorkspaceId: invitation.workspaceId,
        defaultWorkspaceId: invitation.workspaceId,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      });
      if (!userId) throw new AuthError("用户创建失败", 500);
    }

    const member = await trx("o_workspace_member")
      .where({ workspaceId: invitation.workspaceId, userId })
      .forUpdate()
      .first();
    if (
      member?.role === "owner"
      || Number(ws.ownerUserId || 0) === userId
    ) {
      throw new WorkspaceInvitationError("邀请不能变更工作区 owner", 403);
    }
    // 接受邀请也是角色写入；在工作区父锁内重新检查邀请者和目标当前角色。
    const inviterMember = await trx("o_workspace_member")
      .where({ workspaceId: invitation.workspaceId, userId: Number(locked.inviterUserId) })
      .forUpdate()
      .first();
    const inviterPlatformRole = String(inviterUser.role || "").toLowerCase();
    const isPlatformInviter = ["root", "admin", "super_admin"].includes(inviterPlatformRole);
    let inviterRole = inviterPlatformRole;
    if (!isPlatformInviter) {
      if (inviterMember?.status !== "active") {
        throw new WorkspaceInvitationError("邀请者工作区权限已失效", 403);
      }
      inviterRole = getConsistentWorkspaceRole({
        userId: inviterMember.userId,
        memberRole: inviterMember.role,
        ownerUserId: ws.ownerUserId,
      }) || "";
      if (!inviterRole) {
        throw new WorkspaceInvitationError("邀请者工作区权限已失效", 403);
      }
      const inviterPermissions = getEffectiveWorkspacePermissions({ ...inviterMember, role: inviterRole });
      if (!hasExactPermission(inviterPermissions, "member:write")) {
        throw new WorkspaceInvitationError("邀请者已无成员管理权限", 403);
      }
    }
    assertWorkspaceRoleAssignment({
      actorUserId: Number(locked.inviterUserId), ownerUserId: Number(ws.ownerUserId),
      actorRole: inviterRole, targetUserId: userId, targetRole: member?.role, role: locked.role,
    });
    if (member) {
      assertWorkspaceMemberMutation({
        actorUserId: Number(locked.inviterUserId),
        ownerUserId: ws.ownerUserId,
        actorRole: inviterRole,
        targetUserId: userId,
        targetRole: member.role,
        changesAuthority: true,
      });
    }
    const revoked = member
      ? await revokeWorkspaceMemberAccess({
          workspaceId: invitation.workspaceId,
          userId,
          database: trx,
        })
      : null;
    if (member) {
      await trx("o_workspace_member").where({ id: member.id }).update({
        role: locked.role,
        status: "active",
        permissions: null,
        updatedAt: now,
      });
    } else {
      await trx("o_workspace_member").insert({
        id: uuid(),
        workspaceId: invitation.workspaceId,
        userId,
        role: locked.role,
        status: "active",
        permissions: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 原子标记为 accepted（行锁保证无并发）
    await trx("o_workspace_invitation")
      .where({ id: invitation.id })
      .update({
        status: "accepted",
        acceptedAt: now,
        updatedAt: now,
      });

    // v5 Batch A: auditContext 必传，不再 if guard。
    // audit 失败会回滚整个事务（包括 member 创建 + invitation accepted）。
    const auditActor: AuditActor = {
      actorUserId: input.auditContext.actor?.actorUserId ?? null,
      actorRole: input.auditContext.actor?.actorRole !== undefined
        ? input.auditContext.actor?.actorRole
        : normalizeActorRole(null),
      actorKind: input.auditContext.actor?.actorKind,
    };
    await writeAuditLog(input.auditContext, {
      workspaceId: invitation.workspaceId,
      action: "workspace.invitation.accept",
      resourceType: "workspace_member",
      resourceId: String(userId),
      required: true,
      actor: auditActor,
      metadata: {
        joiningUserId: userId,
        invitationId: invitation.id,
        revoked,
      },
    }, trx);

    result = await createInvitationWorkspaceSession(trx, {
      userId,
      workspaceId: invitation.workspaceId,
      authInfo,
    });
  });

  if (!result) throw new AuthError("加入工作区失败", 500);
  return result;
}
