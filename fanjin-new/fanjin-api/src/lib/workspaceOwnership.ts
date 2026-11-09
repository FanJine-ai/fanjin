import {
  workspaceRoles,
  type WorkspaceRole,
} from "@/lib/sharedTypes";

const validWorkspaceRoles = new Set<string>(workspaceRoles);

/**
 * `o_workspace.ownerUserId` is the sole owner fact. The mirrored member role
 * must agree in both directions; drift fails closed instead of granting a
 * phantom owner or silently demoting the authoritative owner.
 */
export function getConsistentWorkspaceRole(input: {
  userId: unknown;
  memberRole: unknown;
  ownerUserId: unknown;
}): WorkspaceRole | null {
  const userId = Number(input.userId || 0);
  const ownerUserId = Number(input.ownerUserId || 0);
  const role = String(input.memberRole || "").trim().toLowerCase();
  if (!Number.isSafeInteger(userId) || userId < 1) return null;
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) return null;
  if (!validWorkspaceRoles.has(role)) return null;

  const isAuthoritativeOwner = userId === ownerUserId;
  if ((role === "owner") !== isAuthoritativeOwner) return null;
  return role as WorkspaceRole;
}

export function hasConsistentWorkspaceOwnership(input: {
  userId: unknown;
  memberRole: unknown;
  ownerUserId: unknown;
}): boolean {
  return getConsistentWorkspaceRole(input) !== null;
}
