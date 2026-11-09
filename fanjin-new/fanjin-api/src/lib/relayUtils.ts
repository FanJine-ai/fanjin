// 中转端点共享工具：从请求中解析工作区 ID
import type { Request } from "express";

export function resolveRelayWorkspaceId(req: Request): string | null {
  const apiKey = (req as any).apiKey;
  const auth = (req as any).auth;
  if (apiKey?.scope === "workspace") return apiKey.workspaceId ?? null;
  if (apiKey?.scope === "platform") return apiKey.workspaceId ?? null;
  return auth?.workspaceId ?? null;
}

/**
 * Return a trusted login principal for idempotency scoping. API-key calls are
 * already isolated by key id, so they deliberately do not inherit a possibly
 * unrelated browser session identity.
 */
export function resolveRelayPrincipalId(req: Request): string | null {
  if ((req as any).apiKey?.id) return null;
  const id = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return id == null || String(id).trim() === "" ? null : String(id);
}
