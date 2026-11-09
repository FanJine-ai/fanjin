import type { Knex } from "knex";

import {
  Service,
  VolcengineOpenApiError,
  resolveVolcengineAlbRegionalHost,
  type VolcengineOpenApiFetch,
} from "@/release-controller/volcengineOpenApi";
import {
  resolveCompositePublicSmokeConfig,
  runCompositePublicSmoke,
} from "@/release-controller/compositePublicSmoke";
import type {
  BackendHealth,
  DrainResult,
  LoadBalancer,
  LoadBalancerBackend,
  PublicSmokeResult,
  ReleaseActionContext,
  ReleaseArtifact,
} from "@/release-controller/types";
import { redactReleaseErrorMessage } from "@/release-controller/errors";

const ALB_API_VERSION = "2020-04-01";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 360_000;
const DEFAULT_API_TIMEOUT_MS = 10_000;
const MAX_API_TIMEOUT_MS = 120_000;
const MAX_ALB_TARGETS = 32;
const MIN_ALB_TARGETS = 2;
const DEFAULT_MIN_HEALTHY_BACKENDS = 1;

export type AlbTargetInput = {
  nodeId: string;
  serverId: string;
  port?: number;
  originalWeight?: number;
};

export type VolcengineAlbAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  region?: string;
  loadBalancerId?: string;
  listenerId?: string;
  serverGroupId?: string;
  targets?: readonly AlbTargetInput[];
  accessKeyId?: string;
  secretAccessKey?: string;
  minHealthyBackends?: number;
  pollIntervalMs?: number;
  operationTimeoutMs?: number;
  apiTimeoutMs?: number;
  apiHost?: string;
  fetch?: VolcengineOpenApiFetch;
  signal?: AbortSignal;
  now?: () => Date;
};

export type ResolvedAlbConfig = {
  region: string;
  loadBalancerId: string;
  listenerId: string;
  serverGroupId: string;
  targets: readonly Readonly<AlbTargetInput>[];
  minHealthyBackends: number;
  pollIntervalMs: number;
  operationTimeoutMs: number;
  apiTimeoutMs: number;
  apiHost?: string;
};

export class VolcengineAlbAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(redactReleaseErrorMessage(message));
    this.name = "VolcengineAlbAdapterError";
    this.code = code;
  }
}

/**
 * 0.1.4 ALB 适配器（设计文档 §11/§16.1）：
 * - 实现与 CLB 相同的 LoadBalancer 契约，上层发布状态机零改动。
 * - 使用 ALB 专用 API 面：DescribeServerGroupAttributes（清单+权重）、
 *   DescribeListenerHealth（健康）、ModifyServerGroupBackendServers（权重）。
 * - 保留 CLB 全部安全不变量：最小健康后端守卫、全零恢复守卫、
 *   权重 0-100、拓扑漂移 fail-closed。
 */
export class VolcengineAlbAdapter implements LoadBalancer {
  private readonly config: ResolvedAlbConfig;
  private readonly service: Service;
  private readonly signal?: AbortSignal;
  private readonly fetchFn: typeof fetch;
  private readonly publicSmokeEnv: NodeJS.ProcessEnv;
  private readonly describeServerGroupAttributes: (
    request: Record<string, unknown>,
    options?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<AlbServerGroupAttributesResponse>;
  private readonly describeListenerHealth: (
    request: Record<string, unknown>,
    options?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<AlbListenerHealthResponse>;
  private readonly modifyServerGroupBackendServers: (
    request: Record<string, unknown>,
    options?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<{ ResponseMetadata?: { RequestId?: string; Error?: unknown } }>;
  private weightMutationTail: Promise<unknown> = Promise.resolve();

  constructor(options: VolcengineAlbAdapterOptions) {
    this.config = resolveAlbConfig(options);
    const env = options.env ?? process.env;
    const accessKeyId = nonEmpty(options.accessKeyId ?? env.FANJIN_RELEASE_VOLC_ACCESS_KEY_ID ?? env.VOLC_ACCESSKEY) ?? "";
    const secretAccessKey = nonEmpty(options.secretAccessKey ?? env.FANJIN_RELEASE_VOLC_SECRET_ACCESS_KEY ?? env.VOLC_SECRETKEY) ?? "";
    if (!accessKeyId || !secretAccessKey) {
      throw new VolcengineAlbAdapterError(
        "ALB_CONFIG_MISSING",
        "missing required ALB OpenAPI credentials",
      );
    }
    const sessionToken = nonEmpty(env.FANJIN_RELEASE_VOLC_SESSION_TOKEN ?? env.VOLC_SESSION_TOKEN ?? env.VOLC_SESSIONTOKEN);
    this.service = new Service({
      accessKeyId,
      secretKey: secretAccessKey,
      sessionToken: sessionToken ?? undefined,
      region: this.config.region,
      host: resolveVolcengineAlbRegionalHost(this.config.region, this.config.apiHost),
      protocol: "https:",
      serviceName: "alb",
      defaultVersion: ALB_API_VERSION,
      fetch: options.fetch,
      now: options.now,
    });
    this.fetchFn = (options.fetch ?? fetch) as typeof fetch;
    this.signal = options.signal;
    this.publicSmokeEnv = env;
    this.describeServerGroupAttributes = this.service.createAPI<
      Record<string, unknown>,
      AlbServerGroupAttributesResponse
    >("DescribeServerGroupAttributes");
    this.describeListenerHealth = this.service.createAPI<
      Record<string, unknown>,
      AlbListenerHealthResponse
    >("DescribeListenerHealth");
    this.modifyServerGroupBackendServers = this.service.createAPI<
      Record<string, unknown>,
      { ResponseMetadata?: { RequestId?: string; Error?: unknown } }
    >("ModifyServerGroupBackendServers");
  }

  private requireTarget(nodeId: string): Readonly<AlbTargetInput> {
    const target = this.config.targets.find((candidate) => candidate.nodeId === nodeId);
    if (!target) {
      throw new VolcengineAlbAdapterError("ALB_TARGET_UNKNOWN", `unknown ALB backend target ${nodeId}`);
    }
    return target;
  }

  /**
   * 读取后端清单与权重；与 CLB 一样做拓扑断言：
   * serverGroupId 必须匹配、监听器必须关联该服务器组、
   * 云端后端集合必须与配置 targets 完全一致（serverId+port），漂移即 fail-closed。
   */
  private async describeServers(): Promise<Map<string, AlbServer>> {
    const response = await this.describeServerGroupAttributes(
      { ServerGroupId: this.config.serverGroupId },
      { timeout: this.config.apiTimeoutMs, signal: this.signal },
    ).catch((error: unknown) => {
      throw translateAlbApiError(error);
    });
    const group = response?.ResponseMetadata?.Error ? undefined : response?.Result;
    if (!group || String(group.ServerGroupId || "") !== this.config.serverGroupId) {
      throw new VolcengineAlbAdapterError(
        "ALB_TOPOLOGY_MISMATCH",
        "DescribeServerGroupAttributes returned an unexpected server group",
      );
    }
    const listeners = Array.isArray(group.Listeners) ? group.Listeners.map(String) : [];
    if (!listeners.includes(this.config.listenerId)) {
      throw new VolcengineAlbAdapterError(
        "ALB_TOPOLOGY_MISMATCH",
        "configured listener is not attached to the configured server group",
      );
    }
    const servers = new Map<string, AlbServer>();
    for (const server of group.Servers || []) {
      const key = albServerKey(String(server.ServerId), Number(server.Port || 0));
      if (servers.has(key) || !Number.isInteger(server.Weight) || Number(server.Weight) < 0 || Number(server.Weight) > 100) {
        throw new VolcengineAlbAdapterError("ALB_TOPOLOGY_MISMATCH", "ALB backend identity or weight is invalid");
      }
      servers.set(key, server);
    }
    for (const target of this.config.targets) {
      const expectedKey = albServerKey(target.serverId, target.port ?? 0);
      const found = servers.get(expectedKey);
      if (!found) {
        throw new VolcengineAlbAdapterError(
          "ALB_TOPOLOGY_MISMATCH",
          `configured backend ${target.nodeId} is missing from the ALB server group`,
        );
      }
    }
    if ((group.Servers || []).length !== this.config.targets.length) {
      throw new VolcengineAlbAdapterError(
        "ALB_TOPOLOGY_MISMATCH",
        "ALB server group contains backends outside the trusted target inventory",
      );
    }
    return servers;
  }

  private async describeHealth(): Promise<Map<string, BackendHealth>> {
    const response = await this.describeListenerHealth(
      { "ListenerIds.1": this.config.listenerId },
      { timeout: this.config.apiTimeoutMs, signal: this.signal },
    ).catch((error: unknown) => {
      throw translateAlbApiError(error);
    });
    const health = new Map<string, BackendHealth>();
    const listeners = response?.ResponseMetadata?.Error ? [] : response?.Result?.Listeners ?? [];
    if (listeners.length !== 1 || listeners[0]?.ListenerId !== this.config.listenerId || listeners[0]?.Status !== "Active") {
      throw new VolcengineAlbAdapterError("ALB_TOPOLOGY_MISMATCH", "ALB health response names another or inactive listener");
    }
    for (const entry of listeners[0].Results ?? []) {
      if (entry.ServerGroupId !== this.config.serverGroupId) continue;
      const key = albServerKey(String(entry.ServerId), Number(entry.Port || 0));
      if (health.has(key) || !this.config.targets.some(target => this.targetKey(target) === key)) {
        throw new VolcengineAlbAdapterError("ALB_TOPOLOGY_MISMATCH", "ALB health contains duplicate or unknown backends");
      }
      health.set(key, normalizeAlbHealth(String(entry.Status ?? "")));
    }
    return health;
  }

  private targetKey(target: Readonly<AlbTargetInput>): string {
    return albServerKey(target.serverId, target.port ?? 0);
  }

  async listBackends(_context: ReleaseActionContext): Promise<readonly LoadBalancerBackend[]> {
    const [servers, health] = await Promise.all([this.describeServers(), this.describeHealth()]);
    return this.config.targets.map((target) => {
      const server = servers.get(this.targetKey(target))!;
      return {
        nodeId: target.nodeId,
        weight: Number(server.Weight || 0),
        health: health.get(this.targetKey(target)) ?? "unknown",
      };
    });
  }

  async getBackend(nodeId: string, context: ReleaseActionContext): Promise<LoadBalancerBackend> {
    this.requireTarget(nodeId);
    const backends = await this.listBackends(context);
    return backends.find((backend) => backend.nodeId === nodeId)!;
  }

  async setWeight(nodeId: string, weight: number, context: ReleaseActionContext): Promise<void> {
    return this.withWeightMutationLock(() => this.setWeightLocked(nodeId, weight, context));
  }

  private async setWeightLocked(
    nodeId: string,
    weight: number,
    _context: ReleaseActionContext,
  ): Promise<void> {
    const target = this.requireTarget(nodeId);
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      throw new VolcengineAlbAdapterError("ALB_WEIGHT_INVALID", "ALB backend weight must be 0 through 100");
    }
    const [servers, health] = await Promise.all([this.describeServers(), this.describeHealth()]);
    const key = this.targetKey(target);
    const server = servers.get(key)!;
    if (Number(server.Weight || 0) === weight) return;

    if (weight > 0 && this.config.targets.every((candidate) => (
      Number(servers.get(this.targetKey(candidate))?.Weight || 0) === 0
    ))) {
      throw new VolcengineAlbAdapterError(
        "ALB_ALL_ZERO_RECOVERY_FORBIDDEN",
        "ordinary backend weights cannot open traffic from an all-zero fleet",
      );
    }

    if (weight === 0) {
      const healthyOthers = this.config.targets.filter((candidate) => {
        if (candidate.nodeId === nodeId) return false;
        const candidateServer = servers.get(this.targetKey(candidate));
        return candidateServer
          && Number(candidateServer.Weight || 0) > 0
          && (health.get(this.targetKey(candidate)) ?? "unknown") === "up";
      }).length;
      if (healthyOthers < this.config.minHealthyBackends) {
        throw new VolcengineAlbAdapterError(
          "ALB_MIN_HEALTHY_GUARD",
          `refusing to drain ${nodeId}: only ${healthyOthers} other healthy weighted backends are available`,
        );
      }
    }

    const mutation = await this.modifyServerGroupBackendServers(
      {
        ServerGroupId: this.config.serverGroupId,
        "Servers.1.ServerId": target.serverId,
        "Servers.1.Port": target.port,
        "Servers.1.Weight": weight,
      },
      { timeout: this.config.apiTimeoutMs, signal: this.signal },
    ).catch((error: unknown) => {
      throw translateAlbApiError(error);
    });
    if (mutation.ResponseMetadata?.Error) {
      throw new VolcengineAlbAdapterError("ALB_API_FAILED", "ALB rejected the backend weight change");
    }

    // 权重变更收敛：轮询直到云端观察到新权重。
    await this.poll(
      `ALB weight change for ${nodeId} to ${weight}`,
      async () => {
        const serversAfter = await this.describeServers();
        return Number(serversAfter.get(key)?.Weight || 0) === weight;
      },
    );
  }

  async waitForDrain(nodeId: string, _context: ReleaseActionContext): Promise<DrainResult> {
    const target = this.requireTarget(nodeId);
    const key = this.targetKey(target);
    let observedWeight: number | null = null;
    await this.poll(
      `ALB weight-zero propagation for ${nodeId}`,
      async () => {
        const servers = await this.describeServers();
        observedWeight = Number(servers.get(key)?.Weight || 0);
        return observedWeight === 0;
      },
    );
    return { drained: true, activeConnections: 0 };
  }

  async publicSmoke(artifact: ReleaseArtifact, _context: ReleaseActionContext): Promise<PublicSmokeResult> {
    // 惰性解析：入口启动期的 assertCompositePublicSmokeConfiguration 已做
    // fail-fast；此处按发布时点重新读取（支持密码文件原子轮换）。
    const config = resolveCompositePublicSmokeConfig({}, this.publicSmokeEnv);
    return await runCompositePublicSmoke({
      config,
      artifact,
      fetchFn: this.fetchFn,
      leaseSignal: this.signal,
    });
  }

  private async poll(description: string, predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + this.config.operationTimeoutMs;
    let delay = this.config.pollIntervalMs;
    while (true) {
      if (this.signal?.aborted) {
        throw new VolcengineAlbAdapterError("ALB_LEASE_LOST", `${description} aborted: lease lost`);
      }
      if (await predicate()) return;
      if (Date.now() >= deadline) {
        throw new VolcengineAlbAdapterError("ALB_OPERATION_TIMEOUT", `${description} did not converge in time`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }

  /**
   * 进程内串行化所有权重变更，防止云端观察到交错 mutation（与 CLB 一致）。
   */
  private withWeightMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.weightMutationTail.then(operation, operation);
    this.weightMutationTail = next.catch(() => undefined);
    return next;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AlbServer = {
  ServerId?: string;
  Port?: number;
  Weight?: number;
  Description?: string;
};

type AlbServerGroupAttributesResponse = {
  ResponseMetadata?: { Error?: unknown };
  Result?: {
    ServerGroupId?: string;
    Listeners?: readonly unknown[];
    Servers?: readonly AlbServer[];
  };
};

type AlbListenerHealthResponse = {
  ResponseMetadata?: { Error?: unknown };
  Result?: {
    Listeners?: ReadonlyArray<{ ListenerId?: string; Status?: string;
      Results?: ReadonlyArray<{ ServerId?: string; ServerGroupId?: string; Port?: number; Status?: string }> }>;
  };
};

function albServerKey(serverId: string, port: number): string {
  return `${serverId}:${port}`;
}

function normalizeAlbHealth(raw: string): BackendHealth {
  const value = raw.trim().toLowerCase();
  if (value === "healthy" || value === "up" || value === "normal") return "up";
  if (value === "unhealthy" || value === "down" || value === "abnormal") return "down";
  return "unknown";
}

function nonEmpty(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : undefined;
}

function translateAlbApiError(error: unknown): Error {
  if (error instanceof VolcengineOpenApiError) {
    return new VolcengineAlbAdapterError(
      `ALB_API_${error.code}`,
      `ALB OpenAPI request failed: ${error.message}`,
    );
  }
  if (error instanceof VolcengineAlbAdapterError) return error;
  return new VolcengineAlbAdapterError(
    "ALB_API_UNKNOWN",
    `ALB OpenAPI request failed: ${(error as Error)?.message || "unknown error"}`,
  );
}

export function resolveAlbConfig(options: VolcengineAlbAdapterOptions): ResolvedAlbConfig {
  const env = options.env ?? process.env;
  const region = nonEmpty(options.region) ?? nonEmpty(env.FANJIN_RELEASE_LB_REGION) ?? nonEmpty(env.FANJIN_RELEASE_CLB_REGION);
  const loadBalancerId = nonEmpty(options.loadBalancerId)
    ?? nonEmpty(env.FANJIN_RELEASE_LB_ID)
    ?? nonEmpty(env.FANJIN_RELEASE_CLB_LOAD_BALANCER_ID);
  const listenerId = nonEmpty(options.listenerId)
    ?? nonEmpty(env.FANJIN_RELEASE_LB_LISTENER_ID)
    ?? nonEmpty(env.FANJIN_RELEASE_CLB_LISTENER_ID);
  const serverGroupId = nonEmpty(options.serverGroupId)
    ?? nonEmpty(env.FANJIN_RELEASE_LB_SERVER_GROUP_ID)
    ?? nonEmpty(env.FANJIN_RELEASE_CLB_SERVER_GROUP_ID);
  const targets = options.targets
    ?? parseAlbTargets(
      nonEmpty(env.FANJIN_RELEASE_LB_TARGETS) ?? nonEmpty(env.FANJIN_RELEASE_CLB_TARGETS),
    );

  const missing = [
    !region && "region",
    !loadBalancerId && "loadBalancerId",
    !listenerId && "listenerId",
    !serverGroupId && "serverGroupId",
    !targets && "targets",
  ].filter(Boolean);
  if (missing.length) {
    throw new VolcengineAlbAdapterError(
      "ALB_CONFIG_MISSING",
      `missing required ALB configuration: ${missing.join(", ")}`,
    );
  }

  const normalizedTargets = targets!.map((target) => ({
    nodeId: String(target.nodeId || "").trim(),
    serverId: String(target.serverId || "").trim(),
    port: target.port,
    originalWeight: target.originalWeight,
  })).filter((target) => target.nodeId && target.serverId);
  if (normalizedTargets.length < MIN_ALB_TARGETS) {
    throw new VolcengineAlbAdapterError(
      "ALB_CONFIG_INVALID",
      "at least two ALB targets are required for zero-downtime rolling release",
    );
  }
  if (normalizedTargets.length > MAX_ALB_TARGETS) {
    throw new VolcengineAlbAdapterError(
      "ALB_CONFIG_INVALID",
      `at most ${MAX_ALB_TARGETS} ALB targets are supported`,
    );
  }
  if (new Set(normalizedTargets.map((target) => target.nodeId)).size !== normalizedTargets.length) {
    throw new VolcengineAlbAdapterError("ALB_CONFIG_INVALID", "ALB target nodeId values must be unique");
  }
  if (new Set(normalizedTargets.map((target) => target.serverId)).size !== normalizedTargets.length) {
    throw new VolcengineAlbAdapterError("ALB_CONFIG_INVALID", "ALB target serverId values must be unique");
  }
  const targetsWithDefaultPort = normalizedTargets.map((target) => ({
    ...target,
    port: target.port ?? 10589,
  }));

  const minHealthyBackends = options.minHealthyBackends ?? DEFAULT_MIN_HEALTHY_BACKENDS;
  if (!Number.isSafeInteger(minHealthyBackends) || minHealthyBackends < 0) {
    throw new VolcengineAlbAdapterError("ALB_CONFIG_INVALID", "minHealthyBackends must be a non-negative integer");
  }
  if (minHealthyBackends >= targetsWithDefaultPort.length) {
    throw new VolcengineAlbAdapterError(
      "ALB_CONFIG_INVALID",
      "minHealthyBackends must be smaller than the target count",
    );
  }

  return Object.freeze({
    region: region!,
    loadBalancerId: loadBalancerId!,
    listenerId: listenerId!,
    serverGroupId: serverGroupId!,
    targets: Object.freeze(targetsWithDefaultPort),
    minHealthyBackends,
    pollIntervalMs: positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    operationTimeoutMs: positiveInteger(options.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS),
    apiTimeoutMs: boundedInteger(options.apiTimeoutMs, DEFAULT_API_TIMEOUT_MS, MAX_API_TIMEOUT_MS),
    apiHost: nonEmpty(options.apiHost ?? env.FANJIN_RELEASE_ALB_API_HOST),
  });
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const parsed = positiveInteger(value, fallback);
  return Math.min(parsed, max);
}

export function parseAlbTargets(raw: string | undefined): AlbTargetInput[] | undefined {
  const text = String(raw || "").trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VolcengineAlbAdapterError("ALB_CONFIG_INVALID", "ALB targets must be a JSON array");
  }
  if (!Array.isArray(parsed)) {
    throw new VolcengineAlbAdapterError("ALB_CONFIG_INVALID", "ALB targets must be a JSON array");
  }
  return parsed as AlbTargetInput[];
}
