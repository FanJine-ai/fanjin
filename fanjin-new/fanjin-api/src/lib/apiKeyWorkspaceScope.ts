import type { Request } from "express";
import { isPlatformAdmin } from "@/middleware/permissions";

export type ApiKeyAccessScope =
  | { ok: true; scope: "platform"; workspaceId: null }
  | { ok: true; scope: "workspace"; workspaceId: string }
  | { ok: false; status: 400 | 403; message: string };

function normalizedWorkspaceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const workspaceId = value.trim();
  return workspaceId || null;
}

/**
 * Resolve the only API Key scope a request may read or mutate.
 *
 * Platform administrators must explicitly name a workspace before a
 * workspace-scoped key is visible. Without one, they operate on platform
 * keys only. Workspace members are always pinned to the workspace carried by
 * their authenticated session, even if they also belong to another workspace.
 */
export function resolveApiKeyAccessScope(req: Request, requestedWorkspaceId: unknown): ApiKeyAccessScope {
  const requested = normalizedWorkspaceId(requestedWorkspaceId);
  if (isPlatformAdmin(req)) {
    return requested
      ? { ok: true, scope: "workspace", workspaceId: requested }
      : { ok: true, scope: "platform", workspaceId: null };
  }

  const current = normalizedWorkspaceId((req as any).auth?.workspaceId);
  if (!current) return { ok: false, status: 403, message: "缺少当前工作区上下文" };
  if (requested && requested !== current) {
    return { ok: false, status: 403, message: "只能管理当前工作区的 API Key" };
  }
  return { ok: true, scope: "workspace", workspaceId: current };
}

/**
 * Workspace API keys are personal developer credentials. Platform admins may
 * operate across owners for support, while every other actor is constrained to
 * keys they created. Returning -1 fails closed if an authenticated user id is
 * unexpectedly absent.
 */
export function apiKeyOwnerFilter(req: Request): { ownerUserId?: number } {
  if (isPlatformAdmin(req)) return {};
  const userId = Number((req as any).auth?.user?.id || 0);
  return { ownerUserId: Number.isSafeInteger(userId) && userId > 0 ? userId : -1 };
}
