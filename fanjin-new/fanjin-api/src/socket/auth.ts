import u from "@/utils";
import { resolveSessionFromAuthorization } from "@/lib/auth";

export interface SocketAuthContext {
  user: {
    id: number;
    name?: string | null;
    role?: string | null;
    status?: string | null;
    workspaceId?: string | null;
  };
  session: any;
  workspaceId?: string | null;
  token: string;
}

export type SocketAuthResult =
  | { ok: true; auth: SocketAuthContext }
  | { ok: false; message: string };

export async function authenticateSocketToken(rawToken: unknown): Promise<SocketAuthResult> {
  try {
    const resolved = await resolveSessionFromAuthorization(u.db as any, rawToken);
    if (!resolved) return { ok: false, message: "未提供 token" };
    const token = String(resolved.rawToken || "");
    const decoded = resolved.payload as any;
    const session = resolved.session as any;
    const user = resolved.user as any;
    const workspaceId = resolved.workspaceId ? String(resolved.workspaceId) : null;

    return {
      ok: true,
      auth: {
        user: {
          ...decoded,
          id: Number(user.id),
          name: user.name,
          role: user.role ?? decoded.role,
          status: user.status,
          workspaceId,
        },
        session,
        workspaceId,
        token,
      },
    };
  } catch {
    return { ok: false, message: "无效的 token" };
  }
}
