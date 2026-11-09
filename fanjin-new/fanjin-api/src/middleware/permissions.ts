import { NextFunction, Request, Response } from "express";
import type { Knex } from "knex";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";

async function getDatabase() {
  return (await import("@/utils/db")).db;
}

const platformRoles = new Set(["root", "admin", "super_admin"]);
const releasePublisherRoles = new Set(["root"]);
const financeRoles = new Set(["finance_viewer", "finance_operator", "finance_manager"]);
const workspaceManageRoles = new Set(["owner", "workspace_admin"]);
const workspaceRoleNames = new Set([
  "owner",
  "workspace_admin",
  "creator",
]);

const legacyPlatformPermissions = [
  "platform:admin",
  "admin:read",
  "admin:write",
  "workspace:read",
  "workspace:write",
  "member:read",
  "member:write",
  "api_key:read",
  "api_key:write",
  "billing:read",
  "billing:write",
  "finance:read",
  "finance:write",
  "finance:approve",
  "project:read",
  "project:write",
  "project:delete",
  "generation:create",
  "audit:read",
] as const;

/**
 * Exact ACTIVE platform leaves from the v0.0.7 C1 final decision contract.
 * Wildcards, RESERVED leaves, and future catalog additions are deliberately
 * absent: adding a leaf requires a new reviewed contract decision.
 */
export const FJADMIN_ACTIVE_PLATFORM_PERMISSIONS = Object.freeze([
  "fjadmin:agents:overview:read",
  "fjadmin:agents:prompts:read",
  "fjadmin:finance:accounts:read",
  "fjadmin:finance:adjustments:create",
  "fjadmin:finance:gift_grants:read",
  "fjadmin:finance:gift_grants:revoke",
  "fjadmin:finance:income:read",
  "fjadmin:finance:ledger:read",
  "fjadmin:finance:overview:read",
  "fjadmin:finance:plans:read",
  "fjadmin:finance:plans:write",
  "fjadmin:finance:pricing:read",
  "fjadmin:finance:pricing:write",
  "fjadmin:finance:reconciliation:execute",
  "fjadmin:finance:reconciliation:read",
  "fjadmin:finance:reconciliation:resolve",
  "fjadmin:finance:redemption:read",
  "fjadmin:finance:redemption:write",
  "fjadmin:finance:service_requests:approve",
  "fjadmin:identity:service_requests:read",
  "fjadmin:identity:service_requests:review",
  "fjadmin:identity:users:commercial",
  "fjadmin:identity:users:read",
  "fjadmin:identity:users:role",
  "fjadmin:identity:users:status",
  "fjadmin:identity:users:write",
  "fjadmin:models:catalog:read",
  "fjadmin:models:routes:read",
  "fjadmin:models:routes:write",
  "fjadmin:models:video_delivery:publish",
  "fjadmin:models:video_delivery:read",
  "fjadmin:models:video_delivery:write",
  "fjadmin:operations:backups:create",
  "fjadmin:operations:backups:delete",
  "fjadmin:operations:backups:read",
  "fjadmin:operations:observability:read",
  "fjadmin:operations:overview:read",
  "fjadmin:operations:releases:deploy",
  "fjadmin:operations:releases:read",
  "fjadmin:operations:releases:reconcile",
  "fjadmin:operations:releases:write",
  "fjadmin:operations:request_logs:export",
  "fjadmin:operations:request_logs:purge",
  "fjadmin:operations:request_logs:read",
  "fjadmin:operations:tasks:cancel",
  "fjadmin:operations:tasks:read",
  "fjadmin:operations:tasks:refresh",
  "fjadmin:overview:dashboard:read",
  "fjadmin:providers:channels:execute",
  "fjadmin:providers:channels:read",
  "fjadmin:providers:channels:secrets",
  "fjadmin:providers:channels:write",
  "fjadmin:providers:portrait_assets:liveness",
  "fjadmin:providers:portrait_assets:read",
  "fjadmin:providers:portrait_assets:write",
  "fjadmin:security:audit_logs:read",
  "fjadmin:settings:general:read",
  "fjadmin:settings:general:write",
  // 0.1.4 多租户入口控制面（设计文档 §13 权限模型）
  "fjadmin:tenants:read",
  "fjadmin:tenants:write",
  "fjadmin:tenant_domains:read",
  "fjadmin:tenant_domains:write",
  "fjadmin:tenant_certificates:read",
  "fjadmin:tenant_certificates:import",
  "fjadmin:tenant_ingress:publish",
  "fjadmin:tenant_ingress:reconcile",
  "fjadmin:tenant_audit:read",
  "fjadmin:tenant_reconciliation:read",
  "fjadmin:tenant_reconciliation:close",
] as const);

/**
 * 0.1.4 新增 fjadmin 叶子（供测试与 catalog 校验引用）。
 */
export const FJADMIN_014_PLATFORM_PERMISSIONS = Object.freeze([
  "fjadmin:tenants:read",
  "fjadmin:tenants:write",
  "fjadmin:tenant_domains:read",
  "fjadmin:tenant_domains:write",
  "fjadmin:tenant_certificates:read",
  "fjadmin:tenant_certificates:import",
  "fjadmin:tenant_ingress:publish",
  "fjadmin:tenant_ingress:reconcile",
  "fjadmin:tenant_audit:read",
  "fjadmin:tenant_reconciliation:read",
  "fjadmin:tenant_reconciliation:close",
] as const);

const financeManagerPlatformPermissions = [
  "fjadmin:finance:accounts:read",
  "fjadmin:finance:adjustments:create",
  "fjadmin:finance:gift_grants:read",
  "fjadmin:finance:gift_grants:revoke",
  "fjadmin:finance:income:read",
  "fjadmin:finance:ledger:read",
  "fjadmin:finance:overview:read",
  "fjadmin:finance:plans:read",
  "fjadmin:finance:plans:write",
  "fjadmin:finance:pricing:read",
  "fjadmin:finance:pricing:write",
  "fjadmin:finance:reconciliation:execute",
  "fjadmin:finance:reconciliation:read",
  "fjadmin:finance:reconciliation:resolve",
  "fjadmin:finance:redemption:read",
  "fjadmin:finance:redemption:write",
  "fjadmin:finance:service_requests:approve",
  "fjadmin:identity:service_requests:read",
  "fjadmin:identity:service_requests:review",
] as const;

const rolePermissions: Readonly<Record<string, readonly string[]>> = {
  root: [...legacyPlatformPermissions, ...FJADMIN_ACTIVE_PLATFORM_PERMISSIONS],
  super_admin: [...legacyPlatformPermissions, ...FJADMIN_ACTIVE_PLATFORM_PERMISSIONS],
  admin: [...legacyPlatformPermissions, ...FJADMIN_ACTIVE_PLATFORM_PERMISSIONS],
  finance_viewer: [
    "finance:read",
    "billing:read",
    "fjadmin:finance:overview:read",
  ],
  finance_operator: [
    "finance:read",
    "finance:write",
    "billing:read",
    "billing:write",
    "fjadmin:finance:overview:read",
  ],
  finance_manager: [
    "finance:read",
    "finance:write",
    "finance:approve",
    "billing:read",
    "billing:write",
    ...financeManagerPlatformPermissions,
  ],
  owner: ["workspace:read", "workspace:write", "member:read", "member:write", "api_key:read", "api_key:write", "billing:read", "billing:request:create", "project:read", "project:write", "project:delete", "generation:create", "audit:read"],
  workspace_admin: ["workspace:read", "member:read", "member:write", "api_key:read", "api_key:write", "billing:read", "billing:request:create", "project:read", "project:write", "project:delete", "generation:create", "audit:read"],
  creator: ["workspace:read", "member:read", "api_key:read", "billing:read", "project:read", "project:write", "generation:create"],
};
const permissionImplications: Record<string, string[]> = {
  "workspace:write": ["workspace:read"],
  "member:write": ["member:read"],
  "api_key:write": ["api_key:read"],
  "billing:write": ["billing:read"],
  "finance:write": ["finance:read"],
  "finance:approve": ["finance:read"],
  "project:write": ["project:read"],
};
const knownPermissionLeaves = new Set<string>([
  ...Object.values(rolePermissions).flat(),
  "billing:request:create",
]);
const fjadminActivePermissionLeaves = new Set<string>(
  FJADMIN_ACTIVE_PLATFORM_PERMISSIONS,
);
const agentRuntimePermissionLeaves = new Set<string>([
  "project:read",
  "project:write",
  "generation:create",
]);

export interface WorkspacePermissionSubject {
  role?: string | null;
  permissions?: unknown;
  permissionsConfigured?: boolean;
}

export function parseWorkspaceMemberPermissions(raw: unknown): string[] {
  let value = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  ));
}

export function closePermissionImplications(permissions: string[]): string[] {
  const closed = new Set(
    permissions.filter((permission) => (
      knownPermissionLeaves.has(permission)
      && !permission.includes("*")
    )),
  );
  const pending = [...closed];
  while (pending.length) {
    const permission = pending.shift()!;
    for (const implied of permissionImplications[permission] || []) {
      if (closed.has(implied)) continue;
      closed.add(implied);
      pending.push(implied);
    }
  }
  return [...closed];
}

/**
 * `null`/missing permissions inherit the role defaults. Delegated custom
 * grants are not a v0.0.7 capability, so any configured value (including a
 * syntactically valid array) fails closed to no workspace permissions.
 * Platform roles remain governed by their global platform permissions.
 */
export function getEffectiveWorkspacePermissions(subject: WorkspacePermissionSubject): string[] {
  const role = String(subject.role || "").trim().toLowerCase();
  if (!workspaceRoleNames.has(role)) return [];
  const configured = subject.permissionsConfigured
    ?? (subject.permissions !== null && subject.permissions !== undefined);
  if (!configured) return closePermissionImplications([...getRolePermissions(role)]);
  return [];
}

export interface LiveWorkspacePermissionResolution {
  authority: "platform" | "workspace" | "none";
  role: string | null;
  permissions: readonly string[];
}

function withSharedLock<TRecord extends object>(
  query: Knex.QueryBuilder<TRecord, unknown>,
): Knex.QueryBuilder<TRecord, unknown> {
  return query.forShare();
}

/**
 * Resolve the mutable user/workspace authority used by every Agent side
 * effect. The lock order is user -> workspace -> member and the returned
 * permissions are always exact catalog leaves.
 *
 * Platform roles are server-owned and do not depend on a workspace member
 * row. Workspace users must have an active workspace plus an active member
 * row whose mirrored owner role agrees with `o_workspace.ownerUserId`.
 */
export async function resolveLiveWorkspacePermissions(input: {
  database: Knex | Knex.Transaction;
  actorUserId: number;
  workspaceId: string;
}): Promise<LiveWorkspacePermissionResolution> {
  const actorUserId = Number(input.actorUserId || 0);
  const workspaceId = String(input.workspaceId || "").trim();
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1 || !workspaceId) {
    return { authority: "none", role: null, permissions: [] };
  }

  const user = await withSharedLock(
    input.database("o_user")
      .where({ id: actorUserId, status: "active" })
      .select("id", "role"),
  ).first();
  if (!user) {
    return { authority: "none", role: null, permissions: [] };
  }

  const platformRole = String((user as any).role || "").trim().toLowerCase();
  if (platformRoles.has(platformRole)) {
    return {
      authority: "platform",
      role: platformRole,
      permissions: getRolePermissions(platformRole),
    };
  }

  const workspace = await withSharedLock(
    input.database("o_workspace")
      .where({ id: workspaceId, status: "active" })
      .select("id", "ownerUserId"),
  ).first();
  if (!workspace) {
    return { authority: "none", role: null, permissions: [] };
  }

  const member = await withSharedLock(
    input.database("o_workspace_member")
      .where({
        workspaceId,
        userId: actorUserId,
        status: "active",
      })
      .select("*"),
  ).first();
  if (!member) {
    return { authority: "none", role: null, permissions: [] };
  }

  const role = getConsistentWorkspaceRole({
    userId: (member as any).userId,
    memberRole: (member as any).role,
    ownerUserId: (workspace as any).ownerUserId,
  });
  if (!role) {
    return { authority: "none", role: null, permissions: [] };
  }

  return {
    authority: "workspace",
    role,
    permissions: getEffectiveWorkspacePermissions({
      role,
      permissions: (member as any).permissions,
      permissionsConfigured:
        (member as any).permissions !== null
        && (member as any).permissions !== undefined,
    }),
  };
}

function getAuthUser(req: Request): any {
  return (req as any).auth?.user || (req as any).user || {};
}

export function isPlatformAdmin(req: Request): boolean {
  const user = getAuthUser(req);
  return platformRoles.has(String(user.role || "").toLowerCase());
}

export function getRolePermissions(role?: string | null): string[] {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return closePermissionImplications([...(rolePermissions[normalizedRole] || [])]);
}

export function roleHasDefaultPermission(role: string | null | undefined, permission: string): boolean {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return hasExactPermission(rolePermissions[normalizedRole] || [], permission);
}

/** 返回已登记的工作区角色，调用方再按所有者和实时授权过滤。 */
export function getRegisteredWorkspaceRoles(): string[] {
  return ["owner", "workspace_admin", "creator"];
}

export function isKnownPermissionLeaf(permission: unknown): permission is string {
  return typeof permission === "string"
    && permission === permission.trim()
    && !permission.includes("*")
    && knownPermissionLeaves.has(permission);
}

/**
 * Capability evaluation is exact-only in v0.0.7. Unknown leaves and every
 * wildcard form are rejected even if both the grant and caller contain the
 * same unreviewed string.
 */
export function hasExactPermission(
  permissions: readonly string[],
  required: unknown,
): boolean {
  return isKnownPermissionLeaf(required)
    && permissions.some((permission) => (
      isKnownPermissionLeaf(permission)
      && permission === required
    ));
}

export function isKnownPlatformPermissionLeaf(
  permission: unknown,
): permission is string {
  return isKnownPermissionLeaf(permission)
    && fjadminActivePermissionLeaves.has(permission);
}

export function hasExactPlatformPermission(
  permissions: readonly string[],
  required: unknown,
): boolean {
  return isKnownPlatformPermissionLeaf(required)
    && permissions.some((permission) => (
      isKnownPlatformPermissionLeaf(permission)
      && permission === required
    ));
}

export function isKnownAgentRuntimePermissionLeaf(
  permission: unknown,
): permission is string {
  return isKnownPermissionLeaf(permission)
    && agentRuntimePermissionLeaves.has(permission);
}

/**
 * Agent capability checks use the workspace/legacy capability envelope only.
 * An exact FJ Admin platform leaf can never become an Agent Tool grant.
 */
export function hasExactAgentRuntimePermission(
  permissions: readonly string[],
  required: unknown,
): boolean {
  return isKnownAgentRuntimePermissionLeaf(required)
    && permissions.some((permission) => (
      isKnownAgentRuntimePermissionLeaf(permission)
      && permission === required
    ));
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  const governedPolicy = (req as any).fjadminOperationPolicy;
  if (governedPolicy?.status === "ACTIVE") return next();
  if (isPlatformAdmin(req)) return next();
  return res.status(403).send({ message: "需要平台管理员权限" });
}

/**
 * Sensitive platform operations such as database backup management are
 * intentionally restricted to the root operator. Ordinary platform admins
 * retain read access where the route allows it, but cannot mutate backups.
 */
export function requirePlatformRoot(req: Request, res: Response, next: NextFunction) {
  const user = getAuthUser(req);
  if (String(user.role || "").toLowerCase() === "root") return next();
  return res.status(403).send({
    message: "需要 Root 平台权限",
    code: "PLATFORM_ROOT_REQUIRED",
  });
}

/**
 * Production release operations are intentionally narrower than ordinary
 * platform administration. A regular `admin` may maintain release metadata,
 * but only root-level operators may publish or orchestrate a rollout.
 */
export function requireReleasePublisher(req: Request, res: Response, next: NextFunction) {
  const user = getAuthUser(req);
  if (releasePublisherRoles.has(String(user.role || "").toLowerCase())) return next();
  return res.status(403).send({
    message: "需要 Root 发布权限",
    code: "RELEASE_PUBLISHER_REQUIRED",
  });
}

/**
 * Clearing a degraded production-scope lock is more privileged than starting
 * an ordinary rollout. It is root-only and requires an enrolled MFA factor;
 * the route is additionally protected by the one-time admin.deployment
 * step-up proof in adminStepUpMiddleware.
 */
export async function requireReleaseReconciler(req: Request, res: Response, next: NextFunction) {
  const user = getAuthUser(req);
  if (String(user.role || "").toLowerCase() !== "root") {
    return res.status(403).send({
      message: "人工解除生产发布锁仅允许 Root 操作",
      code: "RELEASE_RECONCILE_ROOT_REQUIRED",
    });
  }
  const userId = Number(user.id || 0);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(403).send({
      message: "Root 操作人身份无效",
      code: "RELEASE_RECONCILE_ROOT_REQUIRED",
    });
  }
  const database = await getDatabase();
  const security = await database("o_account_security")
    .where({ userId, mfaEnabled: 1 })
    .whereNotNull("mfaConfiguredAt")
    .first();
  if (!security) {
    return res.status(403).send({
      message: "人工解除生产发布锁前必须完成 MFA 注册",
      code: "RELEASE_RECONCILE_MFA_ENROLLMENT_REQUIRED",
    });
  }
  return next();
}

export function isFinanceStaff(req: Request): boolean {
  if (isPlatformAdmin(req)) return true;
  const user = getAuthUser(req);
  const role = String(user.role || "").toLowerCase();
  return financeRoles.has(role) || hasExactPermission(getRolePermissions(role), "finance:read");
}

export function requireFinancePermission(permission: "finance:read" | "finance:write" | "finance:approve" = "finance:read") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isPlatformAdmin(req)) return next();
    const user = getAuthUser(req);
    const role = String(user.role || "").toLowerCase();
    if (financeRoles.has(role) && hasExactPermission(getRolePermissions(role), permission)) return next();
    return res.status(403).send({ message: "需要财务中心权限" });
  };
}

export function getRequestedWorkspaceId(req: Request): string | null {
  const value = req.body?.workspaceId || req.query?.workspaceId || req.params?.workspaceId || (req as any).auth?.workspaceId;
  return value ? String(value) : null;
}

function nonPlatformWorkspaceId(req: Request): string | null {
  const authenticated = String((req as any).auth?.workspaceId || "").trim();
  if (!authenticated) return null;
  const requested = [
    req.body?.workspaceId,
    req.query?.workspaceId,
    req.params?.workspaceId,
  ]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim());
  if (requested.some((workspaceId) => workspaceId !== authenticated)) {
    return "";
  }
  return authenticated;
}

function rejectWorkspaceContext(
  res: Response,
  workspaceId: string | null,
): Response | null {
  if (workspaceId === "") {
    return res.status(403).send({
      message: "请求工作区与当前工作区不一致",
      code: "WORKSPACE_CONTEXT_MISMATCH",
    });
  }
  if (workspaceId === null) {
    return res.status(403).send({
      message: "缺少工作区上下文",
      code: "WORKSPACE_CONTEXT_REQUIRED",
    });
  }
  return null;
}

async function activeWorkspaceMember(
  userId: number,
  workspaceId: string,
): Promise<any | null> {
  const database = await getDatabase();
  const member = await database("o_workspace_member as member")
    .innerJoin("o_workspace as workspace", "workspace.id", "member.workspaceId")
    .where({
      "member.workspaceId": workspaceId,
      "member.userId": userId,
      "member.status": "active",
      "workspace.status": "active",
    })
    .select("member.*", "workspace.ownerUserId as workspaceOwnerUserId")
    .first();
  if (!member) return null;
  const role = getConsistentWorkspaceRole({
    userId: member.userId,
    memberRole: member.role,
    ownerUserId: member.workspaceOwnerUserId,
  });
  return role ? { ...member, role } : null;
}

export function requireWorkspaceRole(options: { allowMember?: boolean; requireManage?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isPlatformAdmin(req)) return next();

    const user = getAuthUser(req);
    const userId = Number(user.id || 0);
    const workspaceId = nonPlatformWorkspaceId(req);
    if (!userId) return res.status(403).send({ message: "缺少工作区上下文" });
    const rejection = rejectWorkspaceContext(res, workspaceId);
    if (rejection) return rejection;

    const member = await activeWorkspaceMember(userId, workspaceId!);
    if (!member) return res.status(403).send({ message: "无权访问该工作区" });

    if (options.requireManage && !workspaceManageRoles.has(String(member.role || ""))) {
      return res.status(403).send({ message: "需要工作区管理员权限" });
    }
    if (!options.allowMember && !options.requireManage && !workspaceManageRoles.has(String(member.role || ""))) {
      return res.status(403).send({ message: "需要工作区管理权限" });
    }

    (req as any).workspaceMember = member;
    return next();
  };
}

export function requireWorkspacePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isPlatformAdmin(req)) return next();

    const user = getAuthUser(req);
    const userId = Number(user.id || 0);
    const workspaceId = nonPlatformWorkspaceId(req);
    if (!userId) return res.status(403).send({ message: "缺少工作区上下文" });
    const rejection = rejectWorkspaceContext(res, workspaceId);
    if (rejection) return rejection;

    const member = await activeWorkspaceMember(userId, workspaceId!);
    if (!member) return res.status(403).send({ message: "无权访问该工作区" });

    if (!hasExactPermission(getEffectiveWorkspacePermissions(member), permission)) {
      return res.status(403).send({ message: "权限不足" });
    }

    (req as any).workspaceMember = member;
    return next();
  };
}

export function requireActiveWorkspacePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthUser(req);
    const userId = Number(user.id || 0);
    const workspaceId = nonPlatformWorkspaceId(req);
    if (!userId) return res.status(403).send({ message: "缺少工作区上下文" });
    const rejection = rejectWorkspaceContext(res, workspaceId);
    if (rejection) return rejection;

    const member = await activeWorkspaceMember(userId, workspaceId!);
    if (!member) return res.status(403).send({ message: "无权访问该工作区" });

    if (!hasExactPermission(getEffectiveWorkspacePermissions(member), permission)) {
      return res.status(403).send({ message: "权限不足" });
    }

    (req as any).workspaceMember = member;
    return next();
  };
}
