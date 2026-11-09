import { internalModelId } from "@/lib/minimaxH3PublicIdentity";
// 渠道路由：加权随机、候选列表、失败重试、Fallback 降级链。
// 各 relay 模块（relayChat/relayMessages/relayResponses/relayImage）通过
// withChannelRetry 统一获得重试和 fallback 能力。
import { db } from "@/utils/db";
import {
  resolveProviderChannelProbeUrl,
} from "@/lib/providerChannelHealth";
import { runProviderChannelHealthCheck } from "@/lib/providerChannelHealthStore";
import type { RelayChannel, RelayEndpointType } from "@/lib/sharedTypes";
import { selectPreferredModelRouteScope } from "@/lib/modelRouteScope";
import { modelRouteGroupConfig, routeTrafficWeight } from "@/lib/modelRouteGroups";
import { v4 as uuid } from "uuid";

export { selectPreferredModelRouteScope } from "@/lib/modelRouteScope";

const routeOrderMetadata = Symbol("fanjin.routeOrder");
type RoutedRelayChannel = RelayChannel & {
  [routeOrderMetadata]?: { priority: number; fallbackOrder: number; trafficWeight: number };
};

function attachRouteOrder(channel: RelayChannel, route?: Record<string, any>): RelayChannel {
  if (route) {
    const traffic = routeTrafficWeight(route, channel as Record<string, any>);
    const routeConfig = modelRouteGroupConfig(route);
    const poolRef = routeConfig.poolRef && typeof routeConfig.poolRef === "object"
      && !Array.isArray(routeConfig.poolRef)
      ? routeConfig.poolRef as Record<string, unknown>
      : {};
    const publicModel = String(route.model || "").trim();
    const upstreamModel = String(poolRef.upstreamModel || routeConfig.upstreamModel || "").trim();
    if (publicModel && upstreamModel) {
      const existingConfig = channel.config && typeof channel.config === "object"
        ? channel.config as Record<string, unknown>
        : {};
      const existingMapping = existingConfig.modelMapping && typeof existingConfig.modelMapping === "object"
        ? existingConfig.modelMapping as Record<string, string>
        : {};
      // Managed routes carry an explicit upstream model in their pool
      // reference. Only that explicit value may override the supplier
      // channel's legacy modelMapping; falling back to the public route model
      // would silently erase existing channel mappings.
      channel.config = {
        ...existingConfig,
        modelMapping: { ...existingMapping, [publicModel]: upstreamModel },
      };
    }
    (channel as RoutedRelayChannel)[routeOrderMetadata] = {
      priority: Number(route.priority || 0),
      fallbackOrder: Number(route.fallbackOrder || 0),
      trafficWeight: traffic.weight,
    };
  }
  return channel;
}

function sameRouteOrder(left: RelayChannel, right: RelayChannel): boolean {
  const leftOrder = (left as RoutedRelayChannel)[routeOrderMetadata];
  const rightOrder = (right as RoutedRelayChannel)[routeOrderMetadata];
  if (!leftOrder || !rightOrder) return !leftOrder && !rightOrder;
  return leftOrder.priority === rightOrder.priority
    && leftOrder.fallbackOrder === rightOrder.fallbackOrder;
}

function sortByRouteOrder(channels: RelayChannel[]): RelayChannel[] {
  return channels.sort((left, right) => {
    const leftOrder = (left as RoutedRelayChannel)[routeOrderMetadata];
    const rightOrder = (right as RoutedRelayChannel)[routeOrderMetadata];
    if (!leftOrder || !rightOrder) return 0;
    return leftOrder.priority - rightOrder.priority
      || leftOrder.fallbackOrder - rightOrder.fallbackOrder;
  });
}

// ============ 候选通道查询 ============
// 返回按优先级 + 健康状态 + fallback 顺序排好的候选列表，
// 供 withChannelRetry 逐个尝试。
export async function selectChannelCandidates(input: {
  endpointType: RelayEndpointType;
  model: string;
  provider?: string | null;
  workspaceId: string;
  /** Read-only catalog/preflight callers may inspect configured routes even while capacity is full. */
  ignoreCapacity?: boolean;
  /** Catalog callers may ignore cached probe health; runtime dispatch must leave this false. */
  ignoreHealth?: boolean;
}): Promise<RelayChannel[]> {
  input = { ...input, model: internalModelId(input.model) };
  const routeQuery = db("o_model_route")
    .where({ endpointType: input.endpointType })
    .orderBy("priority", "asc")
    .orderBy("fallbackOrder", "asc")
    .orderBy("createTime", "asc")
    .orderBy("id", "asc");

  if (input.model) routeQuery.andWhere("model", input.model);
  applyScopeFilter(routeQuery, input.workspaceId);

  const preferredScopeRoutes = selectPreferredModelRouteScope(await routeQuery, input.workspaceId);
  const routes = preferredScopeRoutes.filter((route) => {
    if (isDisabled(route?.disabled)) return false;
    return !input.provider || String(route?.provider || "").trim() === input.provider;
  });

  // The preferred scope is a policy boundary. A workspace route group must
  // shadow platform routes even when every workspace route is disabled or the
  // caller asks for another provider. Neither case may widen into generic
  // channel/modelNames routing.
  if (preferredScopeRoutes.length > 0 && routes.length === 0) return [];

  const channels: RelayChannel[] = [];
  const seen = new Set<string>();
  const unboundRoutes = routes.filter((route: any) =>
    !String(route?.channelId || "").trim() && Boolean(String(route?.provider || "").trim()),
  );

  // 1. 按 fallbackOrder 顺序，每个路由绑定的通道作为一个候选
  for (const route of routes) {
    if (!route.channelId || seen.has(route.channelId)) continue;
    const boundQuery = db("o_provider_channel")
      .where({ id: route.channelId, endpointType: input.endpointType, disabled: 0 });
    applyScopeFilter(boundQuery, input.workspaceId);
    const expectedProvider = String(route.provider || input.provider || "").trim();
    if (expectedProvider) boundQuery.andWhere("provider", expectedProvider);
    const ch = await boundQuery.first();
    if (!ch || !routeBindingMatchesChannel(route, ch, input)) continue;
    if (ch && (input.ignoreCapacity === true || (await channelHasCapacity(ch)))) {
      seen.add(route.channelId);
      channels.push(attachRouteOrder(parseRelayChannel(ch), route));
    }
  }

  // A channelId is an explicit policy binding, not a hint. Generic channels
  // may only be considered when no route matched or an unbound fallback route
  // explicitly authorizes them. This prevents an orphaned, disabled or
  // cross-tenant binding from silently widening into generic model routing.
  if (routes.length > 0 && unboundRoutes.length === 0) return sortByRouteOrder(channels);

  // 2. 补充通用通道（未绑定到路由的）。每条 provider route 必须
  // 独立查询，否则第一家 provider 没有可用 channel 时会吞掉后续显式
  // fallback provider。没有任何 route 时才使用 channel.modelNames 发现。
  const appendGenericCandidates = async (route?: Record<string, any>): Promise<void> => {
    const channelQuery = db("o_provider_channel").where({ endpointType: input.endpointType, disabled: 0 });
    const providerFilter = route?.provider || input.provider;
    if (providerFilter) channelQuery.andWhere("provider", providerFilter);
    applyScopeFilter(channelQuery, input.workspaceId);

    const candidates = await channelQuery
      .orderByRaw(
        "CASE WHEN ?? = 'ok' THEN 0 WHEN ?? IS NULL THEN 1 WHEN ?? = 'degraded' THEN 2 ELSE 3 END",
        ["healthStatus", "healthStatus", "healthStatus"],
      )
      .orderBy("priority", "asc");

    for (const ch of candidates) {
      if (seen.has(ch.id)) continue;
      if (!channelSupportsRequestedModel(ch, input.model, route ? [route] : [])) continue;
      if (input.ignoreHealth !== true && ch.healthStatus === "failed") {
        const failedCooldownMs = Number(process.env.FANJIN_CHANNEL_FAILED_COOLDOWN_MS) || 60_000;
        if (Date.now() - Number(ch.lastHealthCheckAt || 0) < failedCooldownMs) continue;
      }
      if (input.ignoreCapacity !== true && !(await channelHasCapacity(ch))) continue;
      seen.add(ch.id);
      channels.push(attachRouteOrder(parseRelayChannel(ch), route));
    }
  };

  if (unboundRoutes.length > 0) {
    for (const route of unboundRoutes) await appendGenericCandidates(route);
  } else {
    await appendGenericCandidates();
  }

  return sortByRouteOrder(channels);
}

function parseChannelModelNames(raw: unknown): string[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

/**
 * A bound route explicitly authorizes its channel. An unbound exact-model
 * route authorizes channels for the selected provider. Without either, a
 * generic fallback must advertise the requested public model (or `*`). This
 * prevents an unknown model from bypassing the model-route layer merely
 * because a channel shares the same endpoint type.
 */
export function channelSupportsRequestedModel(
  channel: Record<string, any>,
  requestedModel: unknown,
  routes: Array<Record<string, any>> = [],
): boolean {
  const model = String(requestedModel || "").trim();
  if (!model) return false;

  const explicitlyRouted = routes.some((route) => {
    if (isDisabled(route?.disabled)) return false;
    const routeModel = String(route?.model || "").trim();
    if (routeModel && routeModel !== model) return false;
    const routeEndpoint = String(route?.endpointType || "").trim();
    const channelEndpoint = String(channel?.endpointType || "").trim();
    if (routeEndpoint && routeEndpoint !== channelEndpoint) return false;
    const channelId = String(route?.channelId || "").trim();
    if (channelId) {
      return channelId === String(channel?.id || "") && routeBindingMatchesChannel(route, channel, {
        endpointType: channelEndpoint as RelayEndpointType,
        provider: String(route?.provider || "").trim() || null,
        workspaceId: String(route?.workspaceId || "").trim(),
      });
    }
    const provider = String(route?.provider || "").trim();
    return Boolean(provider)
      && provider === String(channel?.provider || "")
      && routeScopeMatchesChannel(route, channel);
  });
  // The presence of channelId makes the route set closed: an invalid or
  // different binding cannot fall through to modelNames-based authorization.
  if (routes.length > 0) return explicitlyRouted;

  const modelNames = parseChannelModelNames(channel?.modelNames);
  return modelNames.includes("*") || modelNames.includes(model);
}

// ============ 加权随机选择 ============
// 从候选列表中按 weight 加权随机选一个（weight 越大越可能被选）。
// 如果只有一个候选，直接返回。
export function weightedRandomSelect(channels: RelayChannel[]): RelayChannel | null {
  if (!channels.length) return null;
  if (channels.length === 1) return channels[0];

  const effectiveWeight = (channel: RelayChannel): number => {
    const routeWeight = (channel as RoutedRelayChannel)[routeOrderMetadata]?.trafficWeight;
    return Math.max(1, Number(routeWeight ?? (channel as any).weight) || 1);
  };
  const totalWeight = channels.reduce((sum, ch) => sum + effectiveWeight(ch), 0);
  let random = Math.random() * totalWeight;
  for (const ch of channels) {
    const w = effectiveWeight(ch);
    random -= w;
    if (random <= 0) return ch;
  }
  return channels[channels.length - 1];
}

/**
 * Produce a weighted order without replacement. A retry can therefore move
 * to every other target in the same priority tier without selecting the same
 * upstream twice. Supplying a random source keeps distribution tests stable.
 */
export function weightedRandomOrder(
  channels: RelayChannel[],
  random: () => number = Math.random,
): RelayChannel[] {
  const remaining = [...channels];
  const ordered: RelayChannel[] = [];
  while (remaining.length) {
    const weights = remaining.map((channel) => {
      const routeWeight = (channel as RoutedRelayChannel)[routeOrderMetadata]?.trafficWeight;
      return Math.max(1, Number(routeWeight ?? (channel as any).weight) || 1);
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = Math.min(Math.max(random(), 0), 0.9999999999999999) * total;
    let selectedIndex = remaining.length - 1;
    for (let index = 0; index < remaining.length; index += 1) {
      cursor -= weights[index];
      if (cursor <= 0) {
        selectedIndex = index;
        break;
      }
    }
    ordered.push(remaining.splice(selectedIndex, 1)[0]);
  }
  return ordered;
}

function weightedAttemptOrder(candidates: RelayChannel[]): RelayChannel[] {
  const ordered: RelayChannel[] = [];
  let index = 0;
  while (index < candidates.length) {
    const tier = candidates.slice(index).filter((channel) => sameRouteOrder(channel, candidates[index]));
    ordered.push(...weightedRandomOrder(tier));
    index += tier.length;
  }
  return ordered;
}

export type ChannelAttemptErrorCategory = "billing" | "client" | "retryable";

export function classifyChannelAttemptError(error: unknown): {
  category: ChannelAttemptErrorCategory;
  shouldFallback: boolean;
  status: number | null;
} {
  const value = error as any;
  const statusCandidates = [value?.statusCode, value?.status, value?.response?.status];
  const statusValue = statusCandidates.find(
    (candidate) => candidate !== undefined && candidate !== null && candidate !== "" && Number.isFinite(Number(candidate)),
  );
  const status = statusValue === undefined ? null : Number(statusValue);
  const isBillingError = value?.name === "BillingError" || value?.isBillingError === true || value?.constructor?.name === "BillingError";
  if (isBillingError) return { category: "billing", shouldFallback: false, status };
  if (status !== null && status >= 400 && status < 500 && status !== 429) {
    return { category: "client", shouldFallback: false, status };
  }
  return { category: "retryable", shouldFallback: true, status };
}

export function resolveRelayMaxRetries(rawValue: unknown, fallback = 2): number {
  const normalizedFallback = Number.isFinite(fallback) && fallback >= 0 ? Math.floor(fallback) : 2;
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") return normalizedFallback;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : normalizedFallback;
}

// ============ withChannelRetry：失败重试 + Fallback ============
// 尝试第一个通道，失败后自动切下一个候选通道重试。
// maxRetries 控制最大重试次数（不含首次）。
export async function withChannelRetry<T>(
  input: {
    endpointType: RelayEndpointType;
    model: string;
    provider?: string | null;
    workspaceId: string;
    /**
     * Synchronous generation endpoints may not be replay-safe even when an
     * Idempotency-Key header is sent because many compatible upstreams ignore
     * it. Use "disabled" to make the caller's zero-retry policy immune to a
     * process-wide FANJIN_RELAY_MAX_RETRIES override.
     */
    retryPolicy?: "configured" | "disabled";
  },
  maxRetries: number,
  fn: (channel: RelayChannel) => Promise<T>,
): Promise<{ result: T; channel: RelayChannel }> {
  const candidates = await selectChannelCandidates(input);
  if (!candidates.length) {
    throw new ChannelRouteError("未找到可用的供应商通道（请确认已配置通道且模型路由匹配）", 503);
  }

  // Weight only balances channels inside the highest-priority route group.
  // Lower priority/fallback routes remain ordered failover targets and must
  // never win the initial random selection.
  const attemptChannels = weightedAttemptOrder(candidates);
  const effectiveMaxRetries = input.retryPolicy === "disabled"
    ? 0
    : resolveRelayMaxRetries(process.env.FANJIN_RELAY_MAX_RETRIES, maxRetries);
  const maxProviderAttempts = Math.min(effectiveMaxRetries + 1, candidates.length);
  let providerAttempts = 0;
  let lastError: any;

  for (const channel of attemptChannels) {
    if (providerAttempts >= maxProviderAttempts) break;
    const lease = await acquireChannelConcurrencyLease(channel);
    if (!lease) {
      lastError = new ChannelCapacityError("供应商通道并发已满，请稍后重试");
      continue;
    }
    providerAttempts += 1;
    let result: any;
    try {
      result = await fn(channel);
      // 成功：如果通道之前有错误记录，清除
      // 健康状态是旁路观测，写入失败不能把已经成功的供应商调用
      // 重新归类为可重试错误，否则会产生第二次上游成本。
      try {
        await markChannelHealthy(channel.id);
      } catch (healthError: any) {
        console.warn("[channel-router] mark healthy failed", channel.id, healthError?.message || "unknown error");
      }
      return { result, channel };
    } catch (err: any) {
      lastError = err;
      // 账务错误和确定性的 4xx 客户端错误不属于渠道故障：立即返回，
      // 不污染通道健康状态，也不能 fallback 后重复调用上游。
      const decision = classifyChannelAttemptError(err);
      if (!decision.shouldFallback) throw err;
      // 记录通道失败
      await markChannelFailed(channel.id, err?.message || "unknown error");
      // 继续尝试下一个通道
    } finally {
      // 如果返回的是 ReadableStream，延迟释放 lease 到流结束
      if (result && typeof (result as any).stream === "object" && (result as any).stream instanceof ReadableStream) {
        const originalStream = (result as any).stream as ReadableStream<Uint8Array>;
        let released = false;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        let releaseTimer: ReturnType<typeof setTimeout> | null = null;
        const releaseOnce = async () => {
          if (released) return;
          released = true;
          if (releaseTimer) {
            clearTimeout(releaseTimer);
            releaseTimer = null;
          }
          try { await releaseChannelConcurrencyLease(lease); } catch {}
        };
        // 包装原流：消费完成或出错时释放 lease
        (result as any).stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            reader = originalStream.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
            } catch (err) {
              try { await reader.cancel(err); } catch {}
              try { controller.error(err); } catch {}
            } finally {
              try { reader.releaseLock(); } catch {}
              reader = null;
              await releaseOnce();
            }
          },
          async cancel(reason) {
            try {
              if (reader) await reader.cancel(reason);
              else await originalStream.cancel(reason);
            } catch {}
            await releaseOnce();
          },
        });
        // 兜底超时：流式超时后强制释放
        releaseTimer = setTimeout(releaseOnce, (Number(process.env.FANJIN_STREAMING_TIMEOUT) || 300) * 1000);
      } else {
        await releaseChannelConcurrencyLease(lease);
      }
    }
  }

  throw lastError || new ChannelRouteError("所有候选通道均失败", 502);
}

export class ChannelRouteError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ChannelRouteError";
    this.statusCode = statusCode;
  }
}

export class ChannelCapacityError extends ChannelRouteError {
  constructor(message = "供应商通道并发已满，请稍后重试") {
    super(message, 429);
    this.name = "ChannelCapacityError";
  }
}

export interface ChannelConcurrencyLease {
  channelId: string;
  slotId: string | null;
  limited: boolean;
}

export async function acquireChannelConcurrencyLease(channel: RelayChannel): Promise<ChannelConcurrencyLease | null> {
  const limit = readConcurrencyLimit(channel);
  if (limit <= 0) return { channelId: channel.id, slotId: null, limited: false };

  const now = Date.now();
  await cleanupExpiredChannelSlots(channel.id, now);
  const leaseExpiresAt = now + channelSlotLeaseMs(channel);
  for (let slotIndex = 0; slotIndex < limit; slotIndex += 1) {
    const slotId = uuid();
    try {
      await db("o_provider_channel_slot").insert({
        id: slotId,
        channelId: channel.id,
        slotIndex,
        leaseExpiresAt,
        createTime: now,
        updateTime: now,
      });
      return { channelId: channel.id, slotId, limited: true };
    } catch (err) {
      // 该 slot 被另一个请求抢到，继续尝试下一个 slot。
      if (!isUniqueConflict(err)) throw err;
    }
  }
  return null;
}

export async function releaseChannelConcurrencyLease(lease?: ChannelConcurrencyLease | null): Promise<void> {
  if (!lease?.limited || !lease.slotId) return;
  try {
    await db("o_provider_channel_slot").where({ id: lease.slotId }).del();
  } catch (err: any) {
    console.warn("[relay] release channel concurrency slot failed", err?.message || err);
  }
}

// ============ 通道健康状态管理 ============
export async function markChannelHealthy(channelId: string): Promise<void> {
  const row = await db("o_provider_channel").where({ id: channelId }).select("healthStatus").first();
  if (row?.healthStatus === "failed" || row?.healthStatus === "degraded") {
    await db("o_provider_channel").where({ id: channelId }).update({
      healthStatus: "ok",
      lastHealthCheckAt: Date.now(),
      lastHealthError: null,
    });
  }
}

export async function markChannelFailed(channelId: string, error: string): Promise<void> {
  const terminalProviderFailure = /(insufficient\s+(?:account\s+)?balance|balance\s+is\s+insufficient|account\s+balance|payment\s+required|余额不足|账户余额|账号余额|欠费|insufficient\s+(?:credit|quota)|quota\s+(?:is\s+)?exhausted)/i.test(error);
  if (terminalProviderFailure) {
    await db("o_provider_channel").where({ id: channelId }).update({
      healthStatus: "failed",
      failedCount: 0,
      lastHealthError: error,
      lastHealthCheckAt: Date.now(),
    });
    return;
  }
  await db("o_provider_channel").where({ id: channelId }).update({
    lastHealthError: error,
    lastHealthCheckAt: Date.now(),
  });
  // 原子自增 failedCount
  const row = await db("o_provider_channel")
    .where({ id: channelId })
    .select("healthStatus", "failedCount")
    .first();
  const failedCount = Number(row?.failedCount || 0) + 1;
  if (failedCount >= 5) {
    // 连续失败达到阈值：标记为 failed 并记录时间，供冷却后自动恢复。
    // 注意不要设置 disabled=1——disabled 是管理员手动开关，不应被瞬时故障触发，
    // 否则通道会永久下线且无法自动恢复。
    await db("o_provider_channel").where({ id: channelId }).update({
      healthStatus: "failed",
      failedCount: 0,
      lastHealthCheckAt: Date.now(),
    });
  } else {
    await db("o_provider_channel")
      .where({ id: channelId })
      .andWhere("failedCount", Number(row?.failedCount || 0))  // CAS 防止并发覆盖
      .update({
        healthStatus: failedCount >= 2 ? "degraded" : "ok",
        failedCount: db.raw("?? + 1", ["failedCount"]),
      });
  }
}

export async function resetChannelHealth(channelId: string): Promise<void> {
  await db("o_provider_channel").where({ id: channelId }).update({
    healthStatus: "ok",
    failedCount: 0,
    lastHealthError: null,
    lastHealthCheckAt: Date.now(),
  });
}

export function joinProviderApiPath(baseUrl: string, apiPath: string): string {
  const root = String(baseUrl || "").trim().replace(/\/+$/, "");
  const path = String(apiPath || "").trim().replace(/^\/+/, "");
  if (!root || !path) return root || path;

  // AI SDK channels normally store a versioned base URL (for example /v1 or
  // /api/v3). Treat that configured version as authoritative even when the
  // caller expresses the logical OpenAI path with another version prefix.
  // This is required for Volcano Ark channels: their base URL is /api/v3,
  // while our OpenAI-compatible relay handlers use logical /v1 paths.
  const versionPrefixes = ["api/v3", "v1beta", "v1"];
  const rootPrefix = versionPrefixes.find((prefix) => root.toLowerCase().endsWith(`/${prefix}`));
  const pathPrefix = versionPrefixes.find((prefix) => path.toLowerCase().startsWith(`${prefix}/`));
  if (rootPrefix && pathPrefix) {
    return `${root}/${path.slice(pathPrefix.length + 1)}`;
  }
  return `${root}/${path}`;
}

export function resolveChannelTestUrl(input: {
  provider: string;
  baseUrl: string;
  config?: Record<string, unknown>;
}): string {
  return resolveProviderChannelProbeUrl(input) || "";
}

// ============ 通道测试 ============
export async function testChannel(channelId: string): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const result = await runProviderChannelHealthCheck(channelId);
  if (!result) return { ok: false, latencyMs: 0, error: "通道不存在" };
  return {
    ok: result.healthStatus === "ok",
    latencyMs: result.latencyMs ?? 0,
    ...(result.errorMessage ? { error: result.errorMessage } : {}),
  };
}

// ============ 内部工具（从 relay.ts 复制，避免循环依赖） ============
function applyScopeFilter(query: any, workspaceId?: string | null) {
  query.andWhere(function (this: any) {
    this.where(function (this: any) {
      this.where({ scope: "platform" }).whereNull("workspaceId");
    });
    if (workspaceId) this.orWhere({ scope: "workspace", workspaceId });
  });
}

function routeScopeMatchesChannel(
  route: Record<string, any>,
  channel: Record<string, any>,
): boolean {
  const routeScope = String(route?.scope || "").trim();
  const channelScope = String(channel?.scope || "").trim();
  const routeWorkspaceId = String(route?.workspaceId || "").trim();
  const channelWorkspaceId = String(channel?.workspaceId || "").trim();
  if (routeScope === "platform") {
    return route?.workspaceId == null && channelScope === "platform" && channel?.workspaceId == null;
  }
  if (routeScope !== "workspace" || !routeWorkspaceId) return false;
  return channelScope === "platform"
    ? !channelWorkspaceId
    : channelScope === "workspace" && routeWorkspaceId === channelWorkspaceId;
}

function routeBindingMatchesChannel(
  route: Record<string, any>,
  channel: Record<string, any>,
  input: { endpointType: RelayEndpointType | string; provider?: string | null; workspaceId?: string | null },
): boolean {
  if (isDisabled(route.disabled) || isDisabled(channel.disabled)) return false;
  if (String(route.channelId || "").trim() !== String(channel.id || "").trim()) return false;
  if (String(route.endpointType || "").trim() !== String(input.endpointType || "").trim()) return false;
  if (String(channel.endpointType || "").trim() !== String(input.endpointType || "").trim()) return false;

  const expectedProvider = String(route.provider || input.provider || "").trim();
  const channelProvider = String(channel.provider || "").trim();
  if (!channelProvider || (expectedProvider && channelProvider !== expectedProvider)) return false;

  const routeWorkspaceId = String(route.workspaceId || "").trim();
  if (String(route.scope || "").trim() === "workspace"
    && (!routeWorkspaceId || routeWorkspaceId !== String(input.workspaceId || "").trim())) {
    return false;
  }
  return routeScopeMatchesChannel(route, channel);
}

function isDisabled(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

async function channelHasCapacity(row: any): Promise<boolean> {
  const limit = readConcurrencyLimit(row);
  if (limit <= 0) return true;
  await cleanupExpiredChannelSlots(row.id);
  const [taskCountRow, slotCountRow] = await Promise.all([
    db("o_relay_task").where({ channelId: row.id }).whereIn("status", ["queued", "running", "enhancing"]).count({ total: "*" }).first(),
    db("o_provider_channel_slot").where({ channelId: row.id }).where("leaseExpiresAt", ">", Date.now()).count({ total: "*" }).first(),
  ]);
  const activeTasks = Number((taskCountRow as any)?.total || 0);
  const activeSlots = Number((slotCountRow as any)?.total || 0);
  return activeTasks + activeSlots < limit;
}

function readConcurrencyLimit(row: any): number {
  const limit = Number(row?.concurrencyLimit || 0);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

function isUniqueConflict(err: unknown): boolean {
  const message = String((err as any)?.message || err || "");
  return /unique|constraint|duplicate/i.test(message);
}

function channelSlotLeaseMs(channel: any): number {
  const configured = Number(process.env.FANJIN_CHANNEL_SLOT_LEASE_MS || 0);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const channelTimeout = Number(channel?.timeoutMs || channel?.config?.timeoutMs || 0);
  const streamTimeout = Number(process.env.FANJIN_STREAMING_TIMEOUT || 0) * 1000;
  const base = Math.max(
    Number.isFinite(channelTimeout) ? channelTimeout : 0,
    Number.isFinite(streamTimeout) ? streamTimeout : 0,
    120_000,
  );
  return base + 60_000;
}

async function cleanupExpiredChannelSlots(channelId: string, now = Date.now()): Promise<void> {
  await db("o_provider_channel_slot").where({ channelId }).where("leaseExpiresAt", "<", now).del();
}

function parseRelayChannel(row: any): RelayChannel {
  const config = typeof row.configJson === "string" ? JSON.parse(row.configJson || "{}") : row.configJson || {};
  return {
    ...row,
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpointType: row.endpointType,
    baseUrl: row.baseUrl || null,
    credentialRef: row.credentialRef || null,
    credentialCiphertext: row.credentialCiphertext || null,
    config,
    timeoutMs: Number(row.timeoutMs) || 60000,
  } as RelayChannel;
}
