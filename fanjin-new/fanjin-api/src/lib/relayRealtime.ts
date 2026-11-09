// Realtime API 中转（/v1/realtime）
import crypto from "node:crypto";
import type { RelayChannel } from "@/lib/relay";
import {
  acquireChannelConcurrencyLease,
  releaseChannelConcurrencyLease,
  selectChannelCandidates,
  type ChannelConcurrencyLease,
} from "@/lib/channelRouter";
import { completeApiKeyRequestQuota, reserveApiKeyRequestQuota } from "@/middleware/apiKeyAuth";
import { resolveChannelApiKey, resolveChannelBaseUrl } from "@/lib/relayChannelCredential";
import {
  beginRelayTextBilling,
  markRelayBillingDispatchStarted,
  markRelayBillingPending,
  releaseRelayBillingSession,
  settleRelayTextBilling,
  type RelayTextBillingSession,
} from "@/lib/relayBillingSession";
import {
  assertRealtimeRequestAllowed,
  RealtimeRelaySafetyError,
  type RealtimeRelayConfiguration,
} from "@/lib/realtimeRelaySafety";
import { getEffectiveWorkspacePermissions } from "@/middleware/permissions";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import {
  hasRelayApiKeyPermission,
  parseStoredRelayApiKeyPermissions,
} from "@/lib/relayApiKeyPermissions";
import { db } from "@/utils/db";
import type { WebSocket } from "ws";

interface ActiveRealtimeSession {
  closeForShutdown(): Promise<void>;
}

interface RealtimeSocketLike {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: any, options?: any): unknown;
  close(code?: number, reason?: string): unknown;
  terminate(): unknown;
}

export type RealtimeUpstreamFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => RealtimeSocketLike;

export interface RealtimeConnectionContext {
  workspaceId: string;
  apiKeyId: string | null;
  sessionId?: string | null;
  userId?: number | null;
  principalId?: string | null;
  requestId?: string | null;
  origin?: string | null;
}

export interface RealtimeConnectionOptions {
  upstreamFactory?: RealtimeUpstreamFactory;
  authorityValidator?: RelayRealtimeAuthorityValidator;
}

export type RelayRealtimeAuthorityValidator = (
  context: RealtimeConnectionContext,
) => Promise<boolean>;

type FinalizeReason =
  | "normal_upstream_close"
  | "client_disconnected"
  | "client_error"
  | "upstream_error"
  | "connect_timeout"
  | "idle_timeout"
  | "session_timeout"
  | "authority_revoked"
  | "server_shutdown";

const activeRealtimeSessions = new Set<ActiveRealtimeSession>();
let acceptingRealtimeConnections = true;

export function startRelayRealtimeConnections(): void {
  acceptingRealtimeConnections = true;
}

export async function stopRelayRealtimeConnections(): Promise<void> {
  acceptingRealtimeConnections = false;
  await Promise.allSettled([...activeRealtimeSessions].map((session) => session.closeForShutdown()));
}

export class RelayRealtimeError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "RelayRealtimeError";
    this.statusCode = statusCode;
  }
}

function closeClient(clientWs: WebSocket, code: number, reason: string): void {
  if ((clientWs as any).readyState === 1) clientWs.close(code, reason);
}

function upstreamWebSocketUrl(baseUrl: string, model: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "wss:") return null;
    url.protocol = "wss:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/realtime`;
    url.search = "";
    url.searchParams.set("model", model);
    return url.toString();
  } catch {
    return null;
  }
}

async function liveWorkspacePrincipal(input: {
  userId: number;
  workspaceId: string;
  permission: string;
}): Promise<boolean> {
  const workspace = await db("o_workspace")
    .where({ id: input.workspaceId, status: "active" })
    .select("id", "ownerUserId")
    .first();
  if (!workspace) return false;
  const member = await db("o_workspace_member")
    .where({
      workspaceId: input.workspaceId,
      userId: input.userId,
      status: "active",
    })
    .first();
  if (!member) return false;
  const role = getConsistentWorkspaceRole({
    userId: member.userId,
    memberRole: member.role,
    ownerUserId: workspace.ownerUserId,
  });
  if (!role) return false;
  return getEffectiveWorkspacePermissions({
      role,
      permissions: member.permissions,
      permissionsConfigured:
        member.permissions !== null && member.permissions !== undefined,
    }).includes(input.permission);
}

export const validateLiveRealtimeAuthority: RelayRealtimeAuthorityValidator = async (
  context,
) => {
  const workspaceId = String(context.workspaceId || "").trim();
  if (!workspaceId) return false;
  const timestamp = Date.now();

  if (context.apiKeyId) {
    const key = await db("o_api_key")
      .where({ id: context.apiKeyId, disabled: 0 })
      .where((builder) => {
        builder.whereNull("revokedAt").orWhere("revokedAt", 0);
      })
      .first();
    const permissions = parseStoredRelayApiKeyPermissions(key?.permissions);
    if (
      !key
      || (Number(key.expiresAt || 0) > 0 && Number(key.expiresAt) <= timestamp)
      || !permissions
      || !hasRelayApiKeyPermission(permissions, "relay:text")
    ) {
      return false;
    }
    const owner = await db("o_user")
      .where({ id: Number(key.ownerUserId || 0), status: "active" })
      .select(
        "id",
        "role",
        "defaultWorkspaceId",
        "currentWorkspaceId",
      )
      .first();
    if (!owner) return false;
    if (key.scope === "workspace") {
      if (String(key.workspaceId || "") !== workspaceId) return false;
      return await liveWorkspacePrincipal({
        userId: Number(owner.id),
        workspaceId,
        permission: "api_key:write",
      });
    }
    if (key.scope !== "platform") return false;
    if (
      !["root", "admin", "super_admin"].includes(
        String(owner.role || "").toLowerCase(),
      )
      || String(
        owner.defaultWorkspaceId || owner.currentWorkspaceId || "",
      ).trim() !== workspaceId
    ) {
      return false;
    }
    return await liveWorkspacePrincipal({
      userId: Number(owner.id),
      workspaceId,
      permission: "generation:create",
    });
  }

  const userId = Number(context.userId || context.principalId || 0);
  const sessionId = String(context.sessionId || "").trim();
  if (!Number.isSafeInteger(userId) || userId < 1 || !sessionId) return false;
  const session = await db("o_user_session")
    .where({
      id: sessionId,
      userId,
      workspaceId,
    })
    .where((builder) => {
      builder.whereNull("revokedAt").orWhere("revokedAt", 0);
    })
    .first();
  if (
    !session
    || (Number(session.expiresAt || 0) > 0 && Number(session.expiresAt) <= timestamp)
  ) {
    return false;
  }
  const user = await db("o_user")
    .where({ id: userId, status: "active" })
    .select("id")
    .first();
  if (!user) return false;
  return await liveWorkspacePrincipal({
    userId,
    workspaceId,
    permission: "generation:create",
  });
};

async function defaultUpstreamFactory(): Promise<RealtimeUpstreamFactory> {
  const { default: UpstreamWebSocket } = await import("ws");
  return (url, options) => new UpstreamWebSocket(url, options) as unknown as RealtimeSocketLike;
}

/**
 * 双向 WebSocket 代理。拨号前完成价格快照预扣；只有正常上游终止且收到
 * 权威 usage 才结算。任何断开、超时、错误或 usage 缺失都保留预扣待核账。
 */
export async function handleRealtimeConnection(
  clientWs: WebSocket,
  model: string,
  ctx: RealtimeConnectionContext,
  options: RealtimeConnectionOptions = {},
): Promise<void> {
  if (!acceptingRealtimeConnections) {
    closeClient(clientWs, 1012, "REALTIME_SERVER_SHUTTING_DOWN");
    return;
  }

  let safety: RealtimeRelayConfiguration;
  try {
    safety = assertRealtimeRequestAllowed({ model, origin: ctx.origin });
  } catch (error) {
    const safetyError = error instanceof RealtimeRelaySafetyError ? error : null;
    closeClient(clientWs, safetyError?.closeCode || 1013, safetyError?.code || "REALTIME_NOT_AVAILABLE");
    return;
  }

  const authorityValidator = options.authorityValidator
    || validateLiveRealtimeAuthority;
  if (!await authorityValidator(ctx).catch(() => false)) {
    closeClient(clientWs, 1008, "REALTIME_AUTHORITY_REVOKED");
    return;
  }

  const candidates = await selectChannelCandidates({ endpointType: "text", model, workspaceId: ctx.workspaceId });
  if (!candidates.length) {
    closeClient(clientWs, 1008, "REALTIME_CHANNEL_UNAVAILABLE");
    return;
  }

  let channel: RelayChannel | null = null;
  let channelLease: ChannelConcurrencyLease | null = null;
  let apiKey = "";
  let baseUrl = "";
  for (const candidate of candidates) {
    const lease = await acquireChannelConcurrencyLease(candidate);
    if (!lease) continue;
    try {
      assertRealtimeRequestAllowed({ model, origin: ctx.origin, provider: candidate.provider });
      const candidateApiKey = resolveChannelApiKey(candidate);
      const candidateBaseUrl = resolveChannelBaseUrl(candidate);
      if (!candidateApiKey || !candidateBaseUrl || !upstreamWebSocketUrl(candidateBaseUrl, model)) {
        await releaseChannelConcurrencyLease(lease);
        continue;
      }
      channel = candidate;
      channelLease = lease;
      apiKey = candidateApiKey;
      baseUrl = candidateBaseUrl;
      break;
    } catch {
      await releaseChannelConcurrencyLease(lease);
    }
  }
  if (!channel || !channelLease) {
    closeClient(clientWs, 1008, "REALTIME_CHANNEL_NOT_ALLOWED");
    return;
  }

  let reservedApiKeyQuota = 0;
  let quotaCompleted = false;
  let leaseReleased = false;
  const realtimeRequestId = String(
    ctx.requestId || crypto.randomUUID(),
  ).trim();
  const completeQuota = async (succeeded: boolean) => {
    if (quotaCompleted) return;
    quotaCompleted = true;
    await completeApiKeyRequestQuota(
      ctx.apiKeyId,
      reservedApiKeyQuota,
      succeeded,
      realtimeRequestId,
    );
  };
  const releaseLeaseOnce = async () => {
    if (leaseReleased) return;
    leaseReleased = true;
    await releaseChannelConcurrencyLease(channelLease);
  };

  try {
    reservedApiKeyQuota = await reserveApiKeyRequestQuota(
      ctx.apiKeyId,
      1,
      realtimeRequestId,
    );
  } catch {
    await releaseLeaseOnce().catch(() => undefined);
    closeClient(clientWs, 1008, "REALTIME_QUOTA_REJECTED");
    return;
  }

  let billingSession: RelayTextBillingSession;
  try {
    billingSession = await beginRelayTextBilling({
      source: "relay-realtime",
      model,
      channel,
      context: {
        workspaceId: ctx.workspaceId,
        apiKeyId: ctx.apiKeyId,
        principalId: ctx.principalId,
        requestId: realtimeRequestId,
      },
      requestPayload: { protocol: "realtime", model },
      maxOutputTokens: safety.maxOutputTokens,
    });
  } catch {
    await completeQuota(false).catch(() => undefined);
    await releaseLeaseOnce().catch(() => undefined);
    closeClient(clientWs, 1008, "REALTIME_BILLING_RESERVATION_FAILED");
    return;
  }

  if (!acceptingRealtimeConnections) {
    await releaseRelayBillingSession(billingSession, "realtime shutdown before dispatch").catch(() => undefined);
    await completeQuota(false).catch(() => undefined);
    await releaseLeaseOnce().catch(() => undefined);
    closeClient(clientWs, 1012, "REALTIME_SERVER_SHUTTING_DOWN");
    return;
  }

  try {
    await markRelayBillingDispatchStarted(billingSession, channel);
  } catch {
    await releaseRelayBillingSession(billingSession, "realtime dispatch marker failed").catch(() => undefined);
    await completeQuota(false).catch(() => undefined);
    await releaseLeaseOnce().catch(() => undefined);
    closeClient(clientWs, 1011, "REALTIME_DISPATCH_REJECTED");
    return;
  }

  const upstreamModel = resolveUpstreamModel(channel, model);
  const upstreamUrl = upstreamWebSocketUrl(baseUrl, upstreamModel);
  if (!upstreamUrl) {
    await markRelayBillingPending(billingSession, channel, {
      units: 0,
      costMicros: 0,
      reason: "realtime_upstream_url_invalid_after_dispatch",
    }).catch(() => undefined);
    await completeQuota(false).catch(() => undefined);
    await releaseLeaseOnce().catch(() => undefined);
    closeClient(clientWs, 1011, "REALTIME_UPSTREAM_URL_INVALID");
    return;
  }

  let upstreamWs: RealtimeSocketLike;
  try {
    const factory = options.upstreamFactory || await defaultUpstreamFactory();
    upstreamWs = factory(upstreamUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "realtime=v1" },
    });
  } catch {
    await markRelayBillingPending(billingSession, channel, {
      units: 0,
      costMicros: 0,
      reason: "realtime_upstream_constructor_failed",
    }).catch(() => undefined);
    await completeQuota(false).catch(() => undefined);
    await releaseLeaseOnce().catch(() => undefined);
    closeClient(clientWs, 1011, "REALTIME_UPSTREAM_CONNECT_FAILED");
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let usageSeen = false;
  let connected = false;
  let cleanupPromise: Promise<void> | null = null;
  let connectTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let sessionTimer: NodeJS.Timeout | null = null;
  let authorityTimer: NodeJS.Timeout | null = null;
  let session!: ActiveRealtimeSession;

  const clearTimers = () => {
    if (connectTimer) clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (sessionTimer) clearTimeout(sessionTimer);
    if (authorityTimer) clearInterval(authorityTimer);
    connectTimer = idleTimer = sessionTimer = null;
    authorityTimer = null;
  };
  const closeUpstream = () => {
    if (upstreamWs.readyState === 0 || upstreamWs.readyState === 1) upstreamWs.terminate();
  };
  const finalizeSession = (reason: FinalizeReason): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      clearTimers();
      if (!billingSession.finalized) {
        if (reason === "normal_upstream_close" && usageSeen) {
          await settleRelayTextBilling(billingSession, channel, {
            inputTokens,
            outputTokens,
            authoritative: true,
          }).catch((error: unknown) => {
            console.warn("[relay-realtime] settlement failed", error instanceof Error ? error.name : "UnknownError");
          });
        } else {
          await markRelayBillingPending(billingSession, channel, {
            units: inputTokens + outputTokens,
            costMicros: 0,
            reason: `realtime_${reason}`,
            metadata: { inputTokens, outputTokens, usageSeen },
          }).catch((error: unknown) => {
            console.warn("[relay-realtime] pending reconciliation failed", error instanceof Error ? error.name : "UnknownError");
          });
        }
      }
      await completeQuota(connected).catch((error: unknown) => {
        console.warn("[relay-realtime] quota cleanup failed", error instanceof Error ? error.name : "UnknownError");
      });
      await releaseLeaseOnce().catch((error: unknown) => {
        console.warn("[relay-realtime] lease cleanup failed", error instanceof Error ? error.name : "UnknownError");
      });
    })().finally(() => activeRealtimeSessions.delete(session));
    return cleanupPromise;
  };
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      closeUpstream();
      closeClient(clientWs, 1013, "REALTIME_IDLE_TIMEOUT");
      void finalizeSession("idle_timeout");
    }, safety.idleTimeoutMs);
    idleTimer.unref?.();
  };

  session = {
    async closeForShutdown() {
      closeClient(clientWs, 1012, "REALTIME_SERVER_SHUTTING_DOWN");
      closeUpstream();
      await finalizeSession("server_shutdown");
    },
  };
  activeRealtimeSessions.add(session);

  connectTimer = setTimeout(() => {
    closeUpstream();
    closeClient(clientWs, 1013, "REALTIME_CONNECT_TIMEOUT");
    void finalizeSession("connect_timeout");
  }, safety.connectTimeoutMs);
  connectTimer.unref?.();
  sessionTimer = setTimeout(() => {
    closeUpstream();
    closeClient(clientWs, 1000, "REALTIME_SESSION_LIMIT");
    void finalizeSession("session_timeout");
  }, safety.maxSessionMs);
  sessionTimer.unref?.();
  let authorityCheckInFlight = false;
  const revokeRealtimeAuthority = async () => {
    if (cleanupPromise || authorityCheckInFlight) return;
    authorityCheckInFlight = true;
    try {
      if (await authorityValidator(ctx).catch(() => false)) return;
      closeUpstream();
      await finalizeSession("authority_revoked");
      closeClient(clientWs, 1008, "REALTIME_AUTHORITY_REVOKED");
    } finally {
      authorityCheckInFlight = false;
    }
  };
  authorityTimer = setInterval(() => {
    void revokeRealtimeAuthority();
  }, 5_000);
  authorityTimer.unref?.();

  upstreamWs.on("message", (data: Buffer, isBinary: boolean) => {
    resetIdleTimer();
    if (isBinary) {
      if ((clientWs as any).readyState === 1) clientWs.send(data, { binary: true });
      return;
    }
    try {
      const event = JSON.parse(data.toString());
      if (event.type === "response.done" && event.response?.usage) {
        const nextInput = Number(event.response.usage.input_tokens);
        const nextOutput = Number(event.response.usage.output_tokens);
        if (Number.isSafeInteger(nextInput) && nextInput >= 0 && Number.isSafeInteger(nextOutput) && nextOutput >= 0) {
          inputTokens += nextInput;
          outputTokens += nextOutput;
          usageSeen = usageSeen || nextInput + nextOutput > 0;
        }
      }
    } catch {
      // Non-JSON text frames are protocol passthrough, not billing evidence.
    }
    if ((clientWs as any).readyState === 1) clientWs.send(data, { binary: false });
  });
  upstreamWs.on("open", () => {
    connected = true;
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    resetIdleTimer();
  });
  upstreamWs.on("close", () => {
    void finalizeSession("normal_upstream_close").finally(() => closeClient(clientWs, 1000, "REALTIME_COMPLETE"));
  });
  upstreamWs.on("error", () => {
    closeUpstream();
    void finalizeSession("upstream_error").finally(() => closeClient(clientWs, 1011, "REALTIME_UPSTREAM_ERROR"));
  });

  let clientFrameChain = Promise.resolve();
  clientWs.on("message", (data: any, isBinary: boolean) => {
    clientFrameChain = clientFrameChain.then(async () => {
      resetIdleTimer();
      if (!await authorityValidator(ctx).catch(() => false)) {
        closeUpstream();
        await finalizeSession("authority_revoked");
        closeClient(clientWs, 1008, "REALTIME_AUTHORITY_REVOKED");
        return;
      }
      if (connected && upstreamWs.readyState === 1) {
        upstreamWs.send(data, { binary: isBinary });
      }
    }).catch(async () => {
      closeUpstream();
      await finalizeSession("authority_revoked");
      closeClient(clientWs, 1011, "REALTIME_AUTHORITY_CHECK_FAILED");
    });
  });
  clientWs.on("close", () => {
    closeUpstream();
    void finalizeSession("client_disconnected");
  });
  clientWs.on("error", () => {
    closeUpstream();
    void finalizeSession("client_error");
  });
}

function resolveUpstreamModel(channel: RelayChannel, requestedModel: string): string {
  const mapping = channel.config?.modelMapping as Record<string, string> | undefined;
  return mapping?.[requestedModel] || requestedModel;
}
