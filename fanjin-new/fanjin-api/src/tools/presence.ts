import type { Knex } from "knex";
import { redisCache } from "@/lib/redisCache";
import { ToolError } from "./contracts";

export const MCP_PRESENCE_TTL_MS = 45_000;
export type McpPresence = { count: number; remainingMs: number };
export type McpPresenceAction = "read" | "heartbeat" | "disconnect";
export type McpPresenceIdentity = { workspaceId: string; userId: number; keyId: string };

export function createMcpPresenceStore({ redis = redisCache, environment = process.env, now = Date.now } = {}) {
  const local = new Map<string, Map<string, number>>();
  return async (identity: McpPresenceIdentity, connectionId: string | null, action: McpPresenceAction): Promise<McpPresence> => {
    const scope = JSON.stringify([identity.workspaceId, identity.userId, identity.keyId]);
    if (redis.inspection().status !== "disabled" || !["test", "dev", "development"].includes(environment.NODE_ENV || "")) {
      const result = await redis.connectionPresence("mcp-presence", scope, connectionId, action, MCP_PRESENCE_TTL_MS);
      if (!result) throw new ToolError("MCP_STATUS_UNAVAILABLE", "暂时无法确认本地 MCP 状态", 503);
      return result;
    }
    // Single-process local development only. Never infer production presence from process memory.
    const timestamp = now();
    for (const [key, sessions] of local) {
      for (const [id, expiry] of sessions) if (expiry <= timestamp) sessions.delete(id);
      if (!sessions.size) local.delete(key);
    }
    const sessions = local.get(scope) || new Map<string, number>();
    if (action === "heartbeat" && connectionId) {
      if (!sessions.has(connectionId) && sessions.size >= 32) throw new ToolError("MCP_CONNECTION_LIMIT", "本地 MCP 连接数已达上限", 429);
      sessions.set(connectionId, timestamp + MCP_PRESENCE_TTL_MS);
      local.set(scope, sessions);
    } else if (action === "disconnect" && connectionId) sessions.delete(connectionId);
    return { count: sessions.size, remainingMs: Math.max(0, ...[...sessions.values()].map(expiry => expiry - timestamp)) };
  };
}

export const mcpPresence = createMcpPresenceStore();
export type McpPresenceStore = ReturnType<typeof createMcpPresenceStore>;

export async function readMcpStatus(database: Knex, userId: number, workspaceId: string, store: McpPresenceStore = mcpPresence, now = Date.now()) {
  const keys = await database("o_api_key").where({ ownerUserId: userId, workspaceId, scope: "workspace", disabled: 0 })
    .select("id", "permissions", "revokedAt", "expiresAt");
  const valid = keys.filter(key => {
    if (Number(key.revokedAt || 0) !== 0) return false;
    const expiry = Number(key.expiresAt || 0);
    if (!Number.isFinite(expiry) || expiry < 0 || (expiry > 0 && expiry <= now)) return false;
    try {
      const permissions = typeof key.permissions === "string" ? JSON.parse(key.permissions) : key.permissions;
      return Array.isArray(permissions) && permissions.some(value => ["*", "mcp:*", "mcp:connect"].includes(value));
    } catch { return false; }
  });
  const live = await Promise.all(valid.map(key => store({ workspaceId, userId, keyId: String(key.id) }, null, "read")));
  const connectionCount = live.reduce((count, entry) => count + entry.count, 0);
  return { connected: connectionCount > 0, connectionCount, validForMs: Math.max(0, ...live.map(entry => entry.remainingMs)), heartbeatIntervalMs: 15_000 };
}
