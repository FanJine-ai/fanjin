// permissions.ts — migrated from fanjin-web, Vue-specific imports replaced.
// AuthUser / WorkspaceItem types mapped to React project's User / Workspace types.
import type { User, Workspace } from "../api/types";

type PermissionSource = User | Workspace | null | undefined;

export interface PermissionSubject {
  user?: User | null;
  workspace?: Workspace | null;
  isAdmin?: boolean;
}

const PLATFORM_ADMIN_ROLES = new Set(["root", "admin", "super_admin"]);
const FINANCE_ROLES = new Set(["root", "admin", "super_admin", "finance_viewer", "finance_operator", "finance_manager"]);
const FINANCE_WRITE_ROLES = new Set(["root", "admin", "super_admin", "finance_operator", "finance_manager"]);
const FINANCE_APPROVE_ROLES = new Set(["root", "admin", "super_admin", "finance_manager"]);
function normalizeToken(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizeToken).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map(normalizeToken)
      .filter(Boolean);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([permission]) => normalizeToken(permission))
      .filter(Boolean);
  }
  return [];
}

function collectPermissions(source: PermissionSource) {
  const data = source as Record<string, unknown> | null | undefined;
  if (!data) return [];
  return [
    ...normalizeList(data.permissions),
    ...normalizeList(data.permission),
    ...normalizeList(data.scopes),
    ...normalizeList(data.scope),
    ...normalizeList(data.abilities),
  ];
}

export function collectRoles(subject: PermissionSubject) {
  return new Set(
    [
      normalizeToken(subject.user?.role),
      normalizeToken(subject.workspace?.role),
      ...normalizeList(subject.user?.roles),
      ...normalizeList((subject.workspace as Record<string, unknown> | null | undefined)?.roles),
      ...normalizeList((subject.workspace as Record<string, unknown> | null | undefined)?.memberRole),
    ].filter(Boolean),
  );
}

function collectUserRoles(subject: PermissionSubject) {
  return new Set([normalizeToken(subject.user?.role), ...normalizeList(subject.user?.roles)].filter(Boolean));
}

export function collectPermissionSet(subject: PermissionSubject) {
  return new Set([...collectPermissions(subject.user), ...collectPermissions(subject.workspace)]);
}

function hasRole(roles: Set<string>, allowedRoles: Set<string>) {
  return [...roles].some((role) => allowedRoles.has(role));
}

function permissionMatches(actual: string, expected: string) {
  return actual === expected;
}

export function hasAnyPermission(subject: PermissionSubject, expectedPermissions: string[]) {
  const permissions = collectPermissionSet(subject);
  return expectedPermissions.some((expected) => {
    const normalizedExpected = normalizeToken(expected);
    return [...permissions].some((actual) => permissionMatches(actual, normalizedExpected));
  });
}

// 普通工作区能力只读取服务端返回的精确权限，不按角色或旧权限别名兜底。
function workspaceCapability(subject: PermissionSubject, permission: string) {
  if (isPlatformAdmin(subject)) return true;
  return collectPermissions(subject.workspace).includes(permission);
}

export function isPlatformAdmin(subject: PermissionSubject) {
  return Boolean(subject.isAdmin) || hasRole(collectUserRoles(subject), PLATFORM_ADMIN_ROLES);
}

export function isWorkspaceManager(subject: PermissionSubject) {
  return workspaceCapability(subject, "workspace:write");
}

export function canManageWorkspaceMembers(subject: PermissionSubject) {
  return workspaceCapability(subject, "member:write");
}

export function canReadWorkspaceMembers(subject: PermissionSubject) {
  return workspaceCapability(subject, "member:read");
}

export function canReadDeveloperApiKeys(subject: PermissionSubject) {
  return workspaceCapability(subject, "api_key:read");
}

export function canManageDeveloperApiKeys(subject: PermissionSubject) {
  return workspaceCapability(subject, "api_key:write");
}

export function canAccessDeveloperRequest(subject: PermissionSubject) {
  return workspaceCapability(subject, "api_key:read");
}

export function canAccessDeveloperModelMap(subject: PermissionSubject) {
  return workspaceCapability(subject, "api_key:read");
}

export function canReadProjects(subject: PermissionSubject) {
  return workspaceCapability(subject, "project:read");
}

export function canWriteProjects(subject: PermissionSubject) {
  return workspaceCapability(subject, "project:write");
}

export function canDeleteProjects(subject: PermissionSubject) {
  return workspaceCapability(subject, "project:delete");
}

export function canRunProduction(subject: PermissionSubject) {
  return workspaceCapability(subject, "generation:create");
}

export function canViewBilling(subject: PermissionSubject) {
  return workspaceCapability(subject, "billing:read");
}

export function canCreateBillingRequest(subject: PermissionSubject) {
  return workspaceCapability(subject, "billing:request:create");
}

export function canAccessFinance(subject: PermissionSubject) {
  return FINANCE_ROLES.has(normalizeToken(subject.user?.role));
}

export function canManageFinance(subject: PermissionSubject) {
  return FINANCE_WRITE_ROLES.has(normalizeToken(subject.user?.role));
}

export function canApproveFinance(subject: PermissionSubject) {
  return FINANCE_APPROVE_ROLES.has(normalizeToken(subject.user?.role));
}

export function canAccessWorkbenchPath(subject: PermissionSubject, path: string) {
  if (
    path.startsWith("/workbench/create") ||
    path.startsWith("/workbench/canvas") ||
    path.startsWith("/workbench/library") ||
    path.startsWith("/workbench/task") ||
    path.startsWith("/workbench/project") ||
    path.startsWith("/workbench/assets")
  ) {
    return canReadProjects(subject);
  }
  if (
    path.startsWith("/workbench/production") ||
    path.startsWith("/workbench/script") ||
    path.startsWith("/workbench/corner-scape") ||
    path.startsWith("/workbench/novel")
  ) {
    return canWriteProjects(subject) && canRunProduction(subject);
  }
  return path === "/workbench" ? canReadProjects(subject) : false;
}

export function firstAllowedWorkbenchPath(subject: PermissionSubject) {
  if (canReadProjects(subject)) return "/workbench/create";
  return "";
}

export function getDefaultLanding(subject: PermissionSubject) {
  const workbenchPath = firstAllowedWorkbenchPath(subject);
  if (workbenchPath) return workbenchPath;
  const developerPath = firstAllowedDeveloperPath(subject);
  if (developerPath) return developerPath;
  if (canViewBilling(subject)) return "/workspace/billing";
  if (canAccessFinance(subject)) return "/fjadmin/finance";
  if (isWorkspaceManager(subject)) return "/workspace/select";
  return "/settings/profile/basic";
}

export function canAccessDeveloperPath(subject: PermissionSubject, path: string) {
  if (path.startsWith("/developer/overview")) return canManageDeveloperApiKeys(subject) || canAccessDeveloperRequest(subject) || canAccessDeveloperModelMap(subject);
  if (path.startsWith("/developer/api/keys")) return canReadDeveloperApiKeys(subject);
  if (path.startsWith("/developer/api/docs")) return canManageDeveloperApiKeys(subject) || canAccessDeveloperRequest(subject) || canAccessDeveloperModelMap(subject);
  if (path.startsWith("/developer/api/request")) return canAccessDeveloperRequest(subject);
  if (path.startsWith("/developer/api/tasks")) return canAccessDeveloperRequest(subject);
  if (path.startsWith("/developer/api/logs")) return canAccessDeveloperRequest(subject);
  if (path.startsWith("/developer/api/models")) return canAccessDeveloperModelMap(subject);
  if (path === "/developer/api" || path.startsWith("/developer/api/")) {
    return canManageDeveloperApiKeys(subject) || canAccessDeveloperRequest(subject) || canAccessDeveloperModelMap(subject);
  }
  return false;
}

export function firstAllowedDeveloperPath(subject: PermissionSubject) {
  if (canManageDeveloperApiKeys(subject) || canAccessDeveloperRequest(subject) || canAccessDeveloperModelMap(subject)) return "/developer/overview";
  return "";
}
