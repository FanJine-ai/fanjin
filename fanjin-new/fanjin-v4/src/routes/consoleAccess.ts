export type GuardMeta = {
  public?: boolean;
  guestOnly?: boolean;
  requiresAuth?: boolean;
  requiresAdmin?: boolean;
  requiresFinance?: boolean;
  requiresFinanceManager?: boolean;
  requiresProject?: boolean;
  requiresWorkspaceManager?: boolean;
  requiresWorkspaceMembers?: boolean;
  requiresBillingAccess?: boolean;
  requiresDeveloperAccess?: boolean;
};

export const ADMIN_ROLES = ["root", "admin", "super_admin"] as const;
export const FINANCE_ROLES = ["root", "admin", "super_admin", "finance_viewer", "finance_operator", "finance_manager"] as const;
export const FINANCE_MANAGER_ROLES = ["root", "admin", "super_admin", "finance_manager"] as const;
export const WORKSPACE_MANAGER_ROLES = ["root", "admin", "super_admin", "owner", "workspace_admin"] as const;
export const WORKSPACE_BILLING_ROLES = [
  "root",
  "admin",
  "super_admin",
  "owner",
  "workspace_admin",
  "finance_viewer",
  "finance_operator",
  "finance_manager",
  "billing",
] as const;
export const DEVELOPER_ROLES = ["root", "admin", "super_admin", "owner", "workspace_admin", "developer"] as const;

export type ConsoleAccessKey = "always" | "admin" | "finance" | "financeManager" | "workspaceManager" | "workspaceMembers" | "billing" | "developer";

export type ConsoleAccess = Record<ConsoleAccessKey, boolean>;

export function roleValue(value: unknown) {
  return String(value || "");
}

export function hasAnyRole(role: string, allowed: readonly string[]) {
  return allowed.includes(role);
}

function permissionMatches(actual: string, expected: string) {
  return actual === expected;
}

export function hasConsolePermission(permissionsInput: unknown, expected: string) {
  if (!Array.isArray(permissionsInput)) return false;
  return permissionsInput
    .map((permission) => String(permission || "").trim().toLowerCase())
    .filter(Boolean)
    .some((permission) => permissionMatches(permission, expected.toLowerCase()));
}

export function getConsoleAccess(userRoleInput: unknown, workspaceRoleInput: unknown, permissionsInput?: unknown): ConsoleAccess {
  const userRole = roleValue(userRoleInput);
  const isAdmin = hasAnyRole(userRole, ADMIN_ROLES);
  const allowed = (permission: string) => isAdmin || hasConsolePermission(permissionsInput, permission);
  return {
    always: true,
    admin: isAdmin,
    // Platform finance APIs are authorized by the user's global role. Workspace
    // permission envelopes must not hide a finance role or grant platform access.
    finance: hasAnyRole(userRole, FINANCE_ROLES),
    financeManager: hasAnyRole(userRole, FINANCE_MANAGER_ROLES),
    workspaceManager: allowed("workspace:write"),
    workspaceMembers: allowed("member:read"),
    billing: allowed("billing:read"),
    developer: allowed("api_key:read"),
  };
}
