import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  Service,
  VolcengineOpenApiError,
  resolveVolcengineClbRegionalHost,
} from "./volcengineOpenApi";
import type { MaintenanceCanaryPlanReceipt } from "./types";
import type {
  VolcengineMaintenanceCanaryTrafficGateObservation,
  VolcengineMaintenanceCanaryTrafficGateQuery,
  VolcengineClbTarget,
} from "./volcengineClb";
import {
  createTrustedVolcengineMaintenanceHttpsServiceRuntime,
  type ReleaseMaintenanceProductionMetricsCollector,
  type TrustedMaintenanceControlRequestHandlerOptions,
  type TrustedReleaseMaintenanceProductionObserverServiceOptions,
  type TrustedVolcengineMaintenanceGateProvider,
  type TrustedVolcengineMaintenanceGateServiceOptions,
} from "./trustedVolcengineMaintenanceGateService";

const CLB_API_VERSION = "2020-04-01";
const DEFAULT_API_TIMEOUT_MS = 10_000;
const DEFAULT_READBACK_TIMEOUT_MS = 60_000;
const DEFAULT_READBACK_POLL_MS = 1_000;
const SAFE_CLOUD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const RULE_PROVIDER_CONFIG_FORMAT = "fanjin-trusted-volcengine-maintenance-rule-provider/v1" as const;
const RULE_PROVIDER_CONFIG_FILE_ENV = "FANJIN_MAINTENANCE_GATE_RULE_CONFIG_FILE";
const MAX_RULE_PROVIDER_CONFIG_BYTES = 512 * 1024;

type JsonObject = Record<string, unknown>;
type OpenApiService = Pick<Service, "createAPI">;

export interface TrustedVolcengineRuleGroupServer {
  serverId: string;
  port: number;
  weight: number;
  role: "maintenance" | "canary";
  nodeId?: string;
}

export interface TrustedVolcengineMaintenanceRuleProviderOptions {
  topology: Omit<
    VolcengineMaintenanceCanaryTrafficGateQuery,
    "operationId" | "artifactSha256" | "planDigestSha256"
  >;
  ruleId: string;
  expectedLoadBalancerId: string;
  expectedRuleDomain: string;
  expectedRuleUrl: string;
  productionServers: readonly Readonly<{
    nodeId: string;
    serverId: string;
    port: number;
  }>[];
  maintenanceServers: readonly Readonly<TrustedVolcengineRuleGroupServer>[];
  canaryServers: readonly Readonly<TrustedVolcengineRuleGroupServer>[];
  service: OpenApiService;
  apiRequestTimeoutMs?: number;
  readbackTimeoutMs?: number;
  readbackPollIntervalMs?: number;
  signal?: AbortSignal;
  clock?: {
    now(): number;
    sleep(milliseconds: number): Promise<void>;
  };
}

export interface TrustedVolcengineMaintenanceRuleProviderConfig {
  format: typeof RULE_PROVIDER_CONFIG_FORMAT;
  topology: TrustedVolcengineMaintenanceRuleProviderOptions["topology"];
  ruleId: string;
  expectedLoadBalancerId: string;
  expectedRuleDomain: string;
  expectedRuleUrl: string;
  productionServers: TrustedVolcengineMaintenanceRuleProviderOptions["productionServers"];
  maintenanceServers: TrustedVolcengineMaintenanceRuleProviderOptions["maintenanceServers"];
  canaryServers: TrustedVolcengineMaintenanceRuleProviderOptions["canaryServers"];
  configSha256: string;
}

export class TrustedVolcengineMaintenanceRuleProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TrustedVolcengineMaintenanceRuleProviderError";
  }
}

function fail(code: string, message: string): never {
  throw new TrustedVolcengineMaintenanceRuleProviderError(code, message);
}

function resolveRegionalClbHost(region: string, configuredHost?: string): string {
  try {
    return resolveVolcengineClbRegionalHost(region, configuredHost);
  } catch (error) {
    if (!(error instanceof VolcengineOpenApiError)) throw error;
    return fail(
      "MAINTENANCE_RULE_CONFIG_INVALID",
      "CLB API host must match the exact regional endpoint",
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value: unknown, keys: readonly string[], label: string): JsonObject {
  if (!isObject(value) || !sameJson(Object.keys(value).sort(), [...keys].sort())) {
    fail("MAINTENANCE_RULE_CONFIG_INVALID", `${label} fields are invalid`);
  }
  return value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function integer(input: unknown, minimum: number, maximum: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("MAINTENANCE_RULE_CONFIG_INVALID", `${label} is invalid`);
  }
  return value;
}

function cloudId(value: unknown, label: string): string {
  const normalized = text(value);
  if (!SAFE_CLOUD_ID_RE.test(normalized)) {
    fail("MAINTENANCE_RULE_CONFIG_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function exactTiming(value: number | undefined, fallback: number, label: string): number {
  return integer(value ?? fallback, 1, 10 * 60_000, label);
}

function sortedTargets(targets: readonly VolcengineClbTarget[]): VolcengineClbTarget[] {
  return targets.map((target) => ({ ...target })).sort((left, right) => (
    left.nodeId.localeCompare(right.nodeId)
  ));
}

function sortedServers(
  servers: readonly Readonly<TrustedVolcengineRuleGroupServer>[],
): TrustedVolcengineRuleGroupServer[] {
  return servers.map((server) => ({ ...server })).sort((left, right) => (
    left.serverId.localeCompare(right.serverId)
  ));
}

function queryTopology(
  query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery>,
): TrustedVolcengineMaintenanceRuleProviderOptions["topology"] {
  return {
    productionListenerId: query.productionListenerId,
    productionServerGroupId: query.productionServerGroupId,
    canaryListenerId: query.canaryListenerId,
    trafficGateId: query.trafficGateId,
    maintenanceServerGroupId: query.maintenanceServerGroupId,
    canaryServerGroupId: query.canaryServerGroupId,
    apiNodeIds: query.apiNodeIds,
    productionTargets: query.productionTargets,
    canaryTargets: query.canaryTargets,
    productionBackendWeight: query.productionBackendWeight,
    maintenanceTrafficWeightPercent: query.maintenanceTrafficWeightPercent,
    trafficWeightPercent: query.trafficWeightPercent,
    autoContainAfterMs: query.autoContainAfterMs,
  };
}

function unwrap(action: string, response: unknown): JsonObject {
  if (!isObject(response)) fail("MAINTENANCE_RULE_RESPONSE_INVALID", `${action} returned invalid JSON`);
  const metadata = isObject(response.ResponseMetadata) ? response.ResponseMetadata : undefined;
  if (metadata && isObject(metadata.Error)) {
    fail("MAINTENANCE_RULE_PROVIDER_REJECTED", `${action} was rejected by CLB`);
  }
  return isObject(response.Result) ? response.Result : response;
}

interface ObservedRule {
  ruleId: string;
  actionType: "Forward";
  serverGroupId: string;
  domain: string;
  url: string;
  description: string;
}

interface ObservedServer {
  serverId: string;
  port: number;
  weight: number;
  description: string;
}

interface ObservedHealth {
  serverId: string;
  status: "up";
}

interface ProviderSnapshot {
  listener: Readonly<{
    listenerId: string;
    loadBalancerId: string;
    protocol: "HTTP" | "HTTPS";
    scheduler: "wrr";
    defaultServerGroupId: string;
    healthCheckSha256: string;
  }>;
  rule: ObservedRule;
  production: readonly ObservedServer[];
  maintenance: readonly ObservedServer[];
  canary: readonly ObservedServer[];
  health: readonly ObservedHealth[];
  providerRevision: string;
}

const systemClock = {
  now: () => Date.now(),
  sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Real CLB rule provider for the isolated gate service. The rule switches only
 * between a maintenance-only group and a pre-provisioned composite canary
 * group. Production API group membership stays exact and weight zero.
 */
export class TrustedVolcengineMaintenanceRuleProvider
implements TrustedVolcengineMaintenanceGateProvider {
  private readonly options: TrustedVolcengineMaintenanceRuleProviderOptions;
  private readonly describeRulesApi: ReturnType<Service["createAPI"]>;
  private readonly modifyRulesApi: ReturnType<Service["createAPI"]>;
  private readonly describeServerGroupApi: ReturnType<Service["createAPI"]>;
  private readonly describeListenerHealthApi: ReturnType<Service["createAPI"]>;
  private readonly describeListenerAttributesApi: ReturnType<Service["createAPI"]>;
  private readonly apiRequestTimeoutMs: number;
  private readonly readbackTimeoutMs: number;
  private readonly readbackPollIntervalMs: number;
  private readonly clock: NonNullable<TrustedVolcengineMaintenanceRuleProviderOptions["clock"]>;

  constructor(options: TrustedVolcengineMaintenanceRuleProviderOptions) {
    this.options = options;
    this.apiRequestTimeoutMs = exactTiming(
      options.apiRequestTimeoutMs,
      DEFAULT_API_TIMEOUT_MS,
      "apiRequestTimeoutMs",
    );
    this.readbackTimeoutMs = exactTiming(
      options.readbackTimeoutMs,
      DEFAULT_READBACK_TIMEOUT_MS,
      "readbackTimeoutMs",
    );
    this.readbackPollIntervalMs = exactTiming(
      options.readbackPollIntervalMs,
      DEFAULT_READBACK_POLL_MS,
      "readbackPollIntervalMs",
    );
    this.clock = options.clock ?? systemClock;
    this.validateConfig();
    this.describeRulesApi = options.service.createAPI("DescribeRules", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
    this.modifyRulesApi = options.service.createAPI("ModifyRules", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
    this.describeServerGroupApi = options.service.createAPI("DescribeServerGroupAttributes", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
    this.describeListenerHealthApi = options.service.createAPI("DescribeListenerHealth", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
    this.describeListenerAttributesApi = options.service.createAPI("DescribeListenerAttributes", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
  }

  private validateConfig(): void {
    const topology = this.options.topology;
    cloudId(topology.productionListenerId, "productionListenerId");
    cloudId(this.options.expectedLoadBalancerId, "expectedLoadBalancerId");
    cloudId(topology.productionServerGroupId, "productionServerGroupId");
    cloudId(topology.canaryListenerId, "canaryListenerId");
    cloudId(topology.trafficGateId, "trafficGateId");
    cloudId(topology.maintenanceServerGroupId, "maintenanceServerGroupId");
    cloudId(topology.canaryServerGroupId, "canaryServerGroupId");
    if (this.options.ruleId !== topology.trafficGateId) {
      fail("MAINTENANCE_RULE_CONFIG_INVALID", "ruleId must be the exact trafficGateId");
    }
    const groupIds = [
      topology.productionServerGroupId,
      topology.maintenanceServerGroupId,
      topology.canaryServerGroupId,
    ];
    if (
      topology.canaryListenerId === topology.productionListenerId
      || new Set(groupIds).size !== groupIds.length
      || topology.productionBackendWeight !== 0
      || integer(topology.trafficWeightPercent, 1, 10, "trafficWeightPercent")
        + integer(topology.maintenanceTrafficWeightPercent, 90, 99, "maintenanceTrafficWeightPercent") !== 100
      || integer(topology.autoContainAfterMs, 120_000, 3_600_000, "autoContainAfterMs")
        !== topology.autoContainAfterMs
    ) {
      fail("MAINTENANCE_RULE_CONFIG_INVALID", "maintenance gate is not isolated or its percentages/TTL are invalid");
    }
    if (
      this.options.expectedRuleDomain.length > 255
      || this.options.expectedRuleUrl.length > 2_048
      || !this.options.expectedRuleUrl.startsWith("/")
    ) {
      fail("MAINTENANCE_RULE_CONFIG_INVALID", "rule selector is invalid");
    }
    const configuredProduction = this.options.productionServers
      .map(({ nodeId, serverId }) => ({ nodeId, serverId }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    const apiNodeIds = [...topology.apiNodeIds].sort();
    const productionTargetNodeIds = sortedTargets(topology.productionTargets).map(({ nodeId }) => nodeId);
    const canaryTargetNodeIds = sortedTargets(topology.canaryTargets).map(({ nodeId }) => nodeId);
    if (
      apiNodeIds.length < 2
      || new Set(apiNodeIds).size !== apiNodeIds.length
      || !sameJson(apiNodeIds, productionTargetNodeIds)
      || !sameJson(apiNodeIds, canaryTargetNodeIds)
      || new Set(topology.productionTargets.map(({ serverId }) => serverId)).size
        !== topology.productionTargets.length
      || new Set(topology.canaryTargets.map(({ serverId }) => serverId)).size
        !== topology.canaryTargets.length
      || !sameJson(configuredProduction, sortedTargets(topology.productionTargets))
    ) {
      fail("MAINTENANCE_RULE_CONFIG_INVALID", "production server inventory differs from topology");
    }
    for (const server of this.options.productionServers) {
      cloudId(server.nodeId, "production nodeId");
      cloudId(server.serverId, "production serverId");
      integer(server.port, 1, 65_535, "production port");
    }
    const maintenance = sortedServers(this.options.maintenanceServers);
    const canary = sortedServers(this.options.canaryServers);
    if (!maintenance.length || !canary.length) {
      fail("MAINTENANCE_RULE_CONFIG_INVALID", "maintenance and canary groups must not be empty");
    }
    if (
      new Set(maintenance.map(({ serverId }) => serverId)).size !== maintenance.length
      || new Set(canary.map(({ serverId }) => serverId)).size !== canary.length
    ) {
      fail("MAINTENANCE_RULE_CONFIG_INVALID", "gate group backend records must be unique");
    }
    for (const server of [...maintenance, ...canary]) {
      if (server.role !== "maintenance" && server.role !== "canary") {
        fail("MAINTENANCE_RULE_CONFIG_INVALID", "gate server role is invalid");
      }
      cloudId(server.serverId, "gate serverId");
      integer(server.port, 1, 65_535, "gate port");
      integer(server.weight, 1, 100, "gate weight");
      if (server.role === "canary" && !server.nodeId) {
        fail("MAINTENANCE_RULE_CONFIG_INVALID", "canary server must bind a nodeId");
      }
      if (server.role === "maintenance" && server.nodeId) {
        fail("MAINTENANCE_RULE_CONFIG_INVALID", "maintenance server must not bind an API nodeId");
      }
    }
    if (
      maintenance.some(({ role }) => role !== "maintenance")
      || maintenance.reduce((sum, server) => sum + server.weight, 0) !== 100
    ) {
      fail("MAINTENANCE_RULE_CONFIG_INVALID", "maintenance-only group must be 100% maintenance responders");
    }
    const configuredCanaryTargets = canary
      .filter(({ role }) => role === "canary")
      .map(({ nodeId, serverId }) => ({ nodeId: nodeId!, serverId }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    const maintenanceWeight = canary
      .filter(({ role }) => role === "maintenance")
      .reduce((sum, server) => sum + server.weight, 0);
    const canaryWeight = canary
      .filter(({ role }) => role === "canary")
      .reduce((sum, server) => sum + server.weight, 0);
    if (
      !sameJson(configuredCanaryTargets, sortedTargets(topology.canaryTargets))
      || maintenanceWeight !== topology.maintenanceTrafficWeightPercent
      || canaryWeight !== topology.trafficWeightPercent
      || maintenanceWeight + canaryWeight !== 100
    ) {
      fail("MAINTENANCE_RULE_CONFIG_INVALID", "composite canary group weights or inventory are invalid");
    }
  }

  private assertNotAborted(): void {
    if (this.options.signal?.aborted) {
      fail("MAINTENANCE_RULE_ABORTED", "trusted CLB rule operation was aborted");
    }
  }

  private assertQueryTopology(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery>,
  ): void {
    if (!sameJson(queryTopology(query), this.options.topology)) {
      fail("MAINTENANCE_RULE_TOPOLOGY_MISMATCH", "request differs from the pinned maintenance rule topology");
    }
  }

  private async call(
    action: string,
    api: ReturnType<Service["createAPI"]>,
    request: JsonObject,
  ): Promise<JsonObject> {
    this.assertNotAborted();
    try {
      const result = await api(request, {
        Action: action,
        timeout: this.apiRequestTimeoutMs,
        signal: this.options.signal,
      });
      this.assertNotAborted();
      return unwrap(action, result);
    } catch (error) {
      if (error instanceof TrustedVolcengineMaintenanceRuleProviderError) throw error;
      return fail("MAINTENANCE_RULE_PROVIDER_FAILED", `${action} failed`);
    }
  }

  private async readRule(): Promise<ObservedRule> {
    const result = await this.call("DescribeRules", this.describeRulesApi, {
      ListenerId: this.options.topology.canaryListenerId,
    });
    if (!Array.isArray(result.Rules)) {
      fail("MAINTENANCE_RULE_RESPONSE_INVALID", "DescribeRules response has no Rules array");
    }
    const matches = result.Rules.filter((entry) => (
      isObject(entry) && text(entry.RuleId) === this.options.ruleId
    ));
    if (result.Rules.length !== 1 || matches.length !== 1) {
      fail(
        "MAINTENANCE_RULE_TOPOLOGY_MISMATCH",
        "dedicated maintenance listener must contain exactly the pinned rule",
      );
    }
    const raw = matches[0] as JsonObject;
    const actionType = text(raw.ActionType);
    const rule: ObservedRule = {
      ruleId: cloudId(raw.RuleId, "observed RuleId"),
      actionType: "Forward",
      serverGroupId: cloudId(raw.ServerGroupId, "observed ServerGroupId"),
      domain: typeof raw.Domain === "string" ? raw.Domain : "",
      url: typeof raw.Url === "string" ? raw.Url : "",
      description: typeof raw.Description === "string" ? raw.Description : "",
    };
    if (
      actionType !== "Forward"
      || rule.domain !== this.options.expectedRuleDomain
      || rule.url !== this.options.expectedRuleUrl
      || ![
        this.options.topology.maintenanceServerGroupId,
        this.options.topology.canaryServerGroupId,
      ].includes(rule.serverGroupId)
    ) {
      fail("MAINTENANCE_RULE_TOPOLOGY_MISMATCH", "maintenance rule selector/action/group drifted");
    }
    return rule;
  }

  private async readServers(
    groupId: string,
    expected: readonly Readonly<{ serverId: string; port: number; weight: number }>[],
    expectedListenerId: string,
    requireAttached: boolean,
    allowOtherListeners = false,
  ): Promise<ObservedServer[]> {
    const result = await this.call(
      "DescribeServerGroupAttributes",
      this.describeServerGroupApi,
      { ServerGroupId: groupId },
    );
    if (text(result.ServerGroupId) && text(result.ServerGroupId) !== groupId) {
      fail("MAINTENANCE_RULE_TOPOLOGY_MISMATCH", "server group readback returned another group");
    }
    if (text(result.LoadBalancerId) !== this.options.expectedLoadBalancerId) {
      fail("MAINTENANCE_RULE_TOPOLOGY_MISMATCH", "server group belongs to another load balancer");
    }
    if (!Array.isArray(result.Listeners) || result.Listeners.some((entry) => typeof entry !== "string")) {
      fail("MAINTENANCE_RULE_RESPONSE_INVALID", "server group response has no exact listener inventory");
    }
    const listeners = (result.Listeners as string[]).map((entry) => entry.trim());
    if (
      (requireAttached && !listeners.includes(expectedListenerId))
      || (!allowOtherListeners && listeners.some((listenerId) => listenerId !== expectedListenerId))
      || ["on", "true", "1"].includes(String(result.AnyPortEnabled ?? "").trim().toLowerCase())
    ) {
      fail("MAINTENANCE_RULE_TOPOLOGY_MISMATCH", `server group ${groupId} listener/scheduler/port policy drifted`);
    }
    if (!Array.isArray(result.Servers)) {
      fail("MAINTENANCE_RULE_RESPONSE_INVALID", "server group response has no Servers array");
    }
    const observed = result.Servers.map((entry) => {
      if (!isObject(entry)) fail("MAINTENANCE_RULE_RESPONSE_INVALID", "server group entry is invalid");
      return {
        serverId: cloudId(entry.ServerId, "observed ServerId"),
        port: integer(entry.Port, 1, 65_535, "observed port"),
        weight: integer(entry.Weight, 0, 100, "observed weight"),
        description: typeof entry.Description === "string" ? entry.Description : "",
      };
    }).sort((left, right) => left.serverId.localeCompare(right.serverId));
    const normalizedExpected = expected.map(({ serverId, port, weight }) => ({
      serverId,
      port,
      weight,
    })).sort((left, right) => left.serverId.localeCompare(right.serverId));
    if (!sameJson(
      observed.map(({ serverId, port, weight }) => ({ serverId, port, weight })),
      normalizedExpected,
    )) {
      fail("MAINTENANCE_RULE_TOPOLOGY_MISMATCH", `server group ${groupId} membership/weights drifted`);
    }
    return observed;
  }

  private async readListener(): Promise<ProviderSnapshot["listener"]> {
    const result = await this.call(
      "DescribeListenerAttributes",
      this.describeListenerAttributesApi,
      { ListenerId: this.options.topology.canaryListenerId },
    );
    const protocol = text(result.Protocol).toUpperCase();
    const healthCheck = isObject(result.HealthCheck) ? result.HealthCheck : undefined;
    const healthCodes = Array.isArray(healthCheck?.HttpCode)
      ? healthCheck.HttpCode.map(String)
      : String(healthCheck?.HttpCode ?? "").split(",");
    const enabled = ["on", "true", "1"].includes(text(healthCheck?.Enabled).toLowerCase());
    if (
      text(result.ListenerId) !== this.options.topology.canaryListenerId
      || text(result.LoadBalancerId) !== this.options.expectedLoadBalancerId
      || text(result.Status).toLowerCase() !== "active"
      || !["on", "true", "1"].includes(text(result.Enabled).toLowerCase())
      || (protocol !== "HTTP" && protocol !== "HTTPS")
      || text(result.Scheduler).toLowerCase() !== "wrr"
      || text(result.ServerGroupId) !== this.options.topology.maintenanceServerGroupId
      || !healthCheck
      || !enabled
      || text(healthCheck.Method).toUpperCase() !== "GET"
      || text(healthCheck.Uri) !== "/api/ready"
      || !healthCodes.some((value) => /(?:^|_)2xx$/iu.test(value.trim()))
    ) {
      fail(
        "MAINTENANCE_RULE_TOPOLOGY_MISMATCH",
        "dedicated listener identity/default group/WRR/readiness health check drifted",
      );
    }
    return {
      listenerId: this.options.topology.canaryListenerId,
      loadBalancerId: this.options.expectedLoadBalancerId,
      protocol: protocol as "HTTP" | "HTTPS",
      scheduler: "wrr",
      defaultServerGroupId: this.options.topology.maintenanceServerGroupId,
      healthCheckSha256: sha256(healthCheck),
    };
  }

  private async readCurrentHealth(
    groupId: string,
    expected: readonly ObservedServer[],
  ): Promise<ObservedHealth[]> {
    const result = await this.call("DescribeListenerHealth", this.describeListenerHealthApi, {
      ListenerId: this.options.topology.canaryListenerId,
      OnlyUnHealthy: false,
      PageNumber: 1,
      PageSize: 100,
    });
    if (!Array.isArray(result.Results)) {
      fail("MAINTENANCE_RULE_RESPONSE_INVALID", "maintenance listener health response has no Results array");
    }
    if (Number(result.TotalCount ?? result.Results.length) > result.Results.length) {
      fail("MAINTENANCE_RULE_RESPONSE_INVALID", "maintenance listener health exceeds the single exact page");
    }
    const expectedIds = new Set(expected.filter(({ weight }) => weight > 0).map(({ serverId }) => serverId));
    const health = new Map<string, "up" | "down">();
    for (const entry of result.Results) {
      if (!isObject(entry) || text(entry.ServerGroupId) !== groupId) continue;
      const serverId = cloudId(entry.ServerId, "health ServerId");
      if (!expectedIds.has(serverId)) {
        fail("MAINTENANCE_RULE_TOPOLOGY_MISMATCH", "listener health returned an unexpected weighted backend");
      }
      const normalized = text(entry.Status).toLowerCase();
      const current = ["up", "healthy", "normal", "available"].includes(normalized) ? "up" : "down";
      health.set(serverId, health.get(serverId) === "down" ? "down" : current);
    }
    if (
      health.size !== expectedIds.size
      || [...expectedIds].some((serverId) => health.get(serverId) !== "up")
    ) {
      fail("MAINTENANCE_RULE_BACKEND_UNHEALTHY", "every weighted backend in the active gate group must be healthy");
    }
    return [...expectedIds].sort().map((serverId) => ({ serverId, status: "up" }));
  }

  private async snapshot(): Promise<ProviderSnapshot> {
    const [rule, listener] = await Promise.all([this.readRule(), this.readListener()]);
    const [production, maintenance, canary] = await Promise.all([
      this.readServers(
        this.options.topology.productionServerGroupId,
        this.options.productionServers.map(({ serverId, port }) => ({ serverId, port, weight: 0 })),
        this.options.topology.productionListenerId,
        true,
        true,
      ),
      this.readServers(
        this.options.topology.maintenanceServerGroupId,
        this.options.maintenanceServers,
        this.options.topology.canaryListenerId,
        rule.serverGroupId === this.options.topology.maintenanceServerGroupId,
      ),
      this.readServers(
        this.options.topology.canaryServerGroupId,
        this.options.canaryServers,
        this.options.topology.canaryListenerId,
        rule.serverGroupId === this.options.topology.canaryServerGroupId,
      ),
    ]);
    const activeServers = rule.serverGroupId === this.options.topology.maintenanceServerGroupId
      ? maintenance
      : canary;
    const health = await this.readCurrentHealth(rule.serverGroupId, activeServers);
    const revisionInput = {
      format: "fanjin-volcengine-exclusive-maintenance-rule-revision/v1",
      productionListenerId: this.options.topology.productionListenerId,
      canaryListenerId: this.options.topology.canaryListenerId,
      rule,
      production,
      maintenance,
      canary,
      health,
      listener,
    };
    return {
      rule,
      listener,
      production,
      maintenance,
      canary,
      health,
      providerRevision: `clb-rule-sha256:${sha256(revisionInput)}`,
    };
  }

  private observation(
    snapshot: ProviderSnapshot,
    query: VolcengineMaintenanceCanaryTrafficGateQuery,
    bindContained = false,
  ): VolcengineMaintenanceCanaryTrafficGateObservation {
    const open = snapshot.rule.serverGroupId === this.options.topology.canaryServerGroupId;
    return {
      operationId: open || bindContained ? query.operationId : null,
      artifactSha256: open || bindContained ? query.artifactSha256 : null,
      planDigestSha256: open || bindContained ? query.planDigestSha256 ?? null : null,
      state: open ? "open" : "contained",
      trafficWeightPercent: open ? query.trafficWeightPercent : 0,
      maintenanceTrafficWeightPercent: open ? query.maintenanceTrafficWeightPercent : 100,
      autoContainAfterMs: query.autoContainAfterMs,
      productionBackendsAllZero: snapshot.production.every(({ weight }) => weight === 0),
      productionListenerId: query.productionListenerId,
      productionServerGroupId: query.productionServerGroupId,
      canaryListenerId: query.canaryListenerId,
      trafficGateId: query.trafficGateId,
      maintenanceServerGroupId: query.maintenanceServerGroupId,
      canaryServerGroupId: query.canaryServerGroupId,
      apiNodeIds: query.apiNodeIds,
      productionTargets: query.productionTargets,
      canaryTargets: query.canaryTargets,
      providerRevision: snapshot.providerRevision,
    };
  }

  async inspect(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    this.assertQueryTopology(query);
    return this.observation(await this.snapshot(), query);
  }

  private async switchRule(
    expectedProviderRevision: string,
    expectedSourceGroupId: string,
    destinationGroupId: string,
  ): Promise<ProviderSnapshot> {
    const before = await this.snapshot();
    if (before.providerRevision !== expectedProviderRevision) {
      fail("MAINTENANCE_RULE_PROVIDER_CAS_CONFLICT", "CLB rule/group digest changed before mutation");
    }
    if (before.rule.serverGroupId !== expectedSourceGroupId) {
      fail("MAINTENANCE_RULE_PROVIDER_CAS_CONFLICT", "CLB rule is not on the exact expected source group");
    }
    await this.call("ModifyRules", this.modifyRulesApi, {
      ListenerId: this.options.topology.canaryListenerId,
      "Rules.1.RuleId": this.options.ruleId,
      "Rules.1.ActionType": "Forward",
      "Rules.1.ServerGroupId": destinationGroupId,
    });
    const startedAt = this.clock.now();
    while (true) {
      const after = await this.snapshot();
      if (after.rule.serverGroupId === destinationGroupId) {
        if (after.providerRevision === before.providerRevision) {
          fail("MAINTENANCE_RULE_PROVIDER_READBACK_INVALID", "rule destination changed without revision change");
        }
        return after;
      }
      if (this.clock.now() - startedAt >= this.readbackTimeoutMs) {
        fail("MAINTENANCE_RULE_PROVIDER_READBACK_TIMEOUT", "CLB rule did not converge before timeout");
      }
      await this.clock.sleep(this.readbackPollIntervalMs);
    }
  }

  async open(input: Readonly<{
    plan: MaintenanceCanaryPlanReceipt;
    expectedProviderRevision: string;
    autoContainDeadlineAt: number;
  }>): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    const query = {
      operationId: input.plan.operationId,
      artifactSha256: input.plan.artifactSha256,
      planDigestSha256: input.plan.planDigestSha256,
      ...this.options.topology,
    };
    const planTopology = queryTopology({
      operationId: input.plan.operationId,
      artifactSha256: input.plan.artifactSha256,
      planDigestSha256: input.plan.planDigestSha256,
      productionListenerId: input.plan.productionListenerId,
      productionServerGroupId: input.plan.productionServerGroupId,
      canaryListenerId: input.plan.canaryListenerId,
      trafficGateId: input.plan.trafficGateId,
      maintenanceServerGroupId: input.plan.maintenanceServerGroupId,
      canaryServerGroupId: input.plan.canaryServerGroupId,
      apiNodeIds: input.plan.apiNodeIds,
      productionTargets: input.plan.productionTargets,
      canaryTargets: input.plan.canaryTargets,
      productionBackendWeight: input.plan.productionBackendWeight as 0,
      maintenanceTrafficWeightPercent: input.plan.maintenanceTrafficWeightPercent as number,
      trafficWeightPercent: input.plan.trafficWeightPercent,
      autoContainAfterMs: input.plan.autoContainAfterMs,
    });
    if (
      !sameJson(planTopology, this.options.topology)
      || input.plan.expectedContainedProviderRevision !== input.expectedProviderRevision
      || input.autoContainDeadlineAt <= this.clock.now()
    ) {
      fail("MAINTENANCE_RULE_PLAN_MISMATCH", "canary plan differs from the exclusive CLB rule topology");
    }
    const after = await this.switchRule(
      input.expectedProviderRevision,
      this.options.topology.maintenanceServerGroupId,
      this.options.topology.canaryServerGroupId,
    );
    return this.observation(after, query);
  }

  async contain(input: Readonly<{
    query: VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string };
    expectedProviderRevision?: string;
    reason: "requested" | "open-failed" | "ttl-expired" | "restart-recovery";
  }>): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    this.assertQueryTopology(input.query);
    const before = await this.snapshot();
    if (before.rule.serverGroupId === this.options.topology.maintenanceServerGroupId) {
      return this.observation(before, input.query, true);
    }
    if (
      input.expectedProviderRevision
      && input.expectedProviderRevision !== before.providerRevision
    ) {
      // Containment remains safe despite a stale expected revision only when
      // the exact rule is still pointing to the exact canary group.
      if (before.rule.serverGroupId !== this.options.topology.canaryServerGroupId) {
        fail("MAINTENANCE_RULE_PROVIDER_CAS_CONFLICT", "unrelated rule drift blocks containment");
      }
    }
    const after = await this.switchRule(
      before.providerRevision,
      this.options.topology.canaryServerGroupId,
      this.options.topology.maintenanceServerGroupId,
    );
    return this.observation(after, input.query, true);
  }
}

function trustedOwner(uid: number): boolean {
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : uid;
  return uid === 0 || uid === effectiveUid;
}

function readProtectedRuleProviderConfigFile(filePath: string): unknown {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    fail("MAINTENANCE_RULE_CONFIG_FILE_UNSAFE", "rule provider config path must be canonical and absolute");
  }
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    fail("MAINTENANCE_RULE_CONFIG_FILE_UNSAFE", "safe rule provider config access is unsupported");
  }
  const directory = path.dirname(filePath);
  let directoryMetadata;
  try {
    directoryMetadata = lstatSync(directory);
  } catch {
    return fail("MAINTENANCE_RULE_CONFIG_FILE_UNSAFE", "rule provider config directory is unavailable");
  }
  if (
    directoryMetadata.isSymbolicLink()
    || !directoryMetadata.isDirectory()
    || (directoryMetadata.mode & 0o7777) !== 0o700
    || !trustedOwner(directoryMetadata.uid)
    || realpathSync(directory) !== directory
  ) {
    fail("MAINTENANCE_RULE_CONFIG_FILE_UNSAFE", "rule provider config directory must be owned 0700");
  }
  let before;
  try {
    before = lstatSync(filePath);
  } catch {
    return fail("MAINTENANCE_RULE_CONFIG_FILE_UNSAFE", "rule provider config file is unavailable");
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o7777) !== 0o600
    || !trustedOwner(before.uid)
    || before.size < 1
    || before.size > MAX_RULE_PROVIDER_CONFIG_BYTES
  ) {
    fail(
      "MAINTENANCE_RULE_CONFIG_FILE_UNSAFE",
      "rule provider config must be an owned 0600 single-link regular file",
    );
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.uid !== before.uid
      || opened.nlink !== 1
      || (opened.mode & 0o7777) !== 0o600
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
    ) {
      fail("MAINTENANCE_RULE_CONFIG_FILE_UNSAFE", "rule provider config changed during secure open");
    }
    const bytes = readFileSync(descriptor);
    const after = lstatSync(filePath);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.uid !== opened.uid
      || after.nlink !== 1
      || (after.mode & 0o7777) !== 0o600
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
    ) {
      fail("MAINTENANCE_RULE_CONFIG_FILE_UNSAFE", "rule provider config changed during read");
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return fail("MAINTENANCE_RULE_CONFIG_INVALID", "rule provider config is not valid JSON");
    }
  } finally {
    closeSync(descriptor);
  }
}

function providerOptionsFromConfig(
  config: TrustedVolcengineMaintenanceRuleProviderConfig,
): Omit<TrustedVolcengineMaintenanceRuleProviderOptions, "service"> {
  return {
    topology: config.topology,
    ruleId: config.ruleId,
    expectedLoadBalancerId: config.expectedLoadBalancerId,
    expectedRuleDomain: config.expectedRuleDomain,
    expectedRuleUrl: config.expectedRuleUrl,
    productionServers: config.productionServers,
    maintenanceServers: config.maintenanceServers,
    canaryServers: config.canaryServers,
  };
}

export function parseTrustedVolcengineMaintenanceRuleProviderConfig(
  value: unknown,
): TrustedVolcengineMaintenanceRuleProviderConfig {
  const raw = exactObject(value, [
    "format",
    "topology",
    "ruleId",
    "expectedLoadBalancerId",
    "expectedRuleDomain",
    "expectedRuleUrl",
    "productionServers",
    "maintenanceServers",
    "canaryServers",
    "configSha256",
  ], "rule provider config");
  const withoutDigest = structuredClone({
    format: raw.format,
    topology: raw.topology,
    ruleId: raw.ruleId,
    expectedLoadBalancerId: raw.expectedLoadBalancerId,
    expectedRuleDomain: raw.expectedRuleDomain,
    expectedRuleUrl: raw.expectedRuleUrl,
    productionServers: raw.productionServers,
    maintenanceServers: raw.maintenanceServers,
    canaryServers: raw.canaryServers,
  }) as Omit<TrustedVolcengineMaintenanceRuleProviderConfig, "configSha256">;
  const configSha256 = String(raw.configSha256 || "");
  if (
    withoutDigest.format !== RULE_PROVIDER_CONFIG_FORMAT
    || !SHA256_RE.test(configSha256)
    || sha256(withoutDigest) !== configSha256
  ) {
    fail("MAINTENANCE_RULE_CONFIG_INVALID", "rule provider config format or digest is invalid");
  }
  const config = { ...withoutDigest, configSha256 };
  const validationService = {
    createAPI: () => async () => ({}),
  } as unknown as OpenApiService;
  try {
    // The constructor performs the semantic cross-check between the exact
    // topology, all three groups, every backend record and percentage.
    new TrustedVolcengineMaintenanceRuleProvider({
      ...providerOptionsFromConfig(config),
      service: validationService,
    });
  } catch (error) {
    if (error instanceof TrustedVolcengineMaintenanceRuleProviderError) throw error;
    return fail("MAINTENANCE_RULE_CONFIG_INVALID", "rule provider config structure is invalid");
  }
  return deepFreeze(config);
}

export function loadTrustedVolcengineMaintenanceRuleProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrustedVolcengineMaintenanceRuleProviderConfig {
  const filePath = text(env[RULE_PROVIDER_CONFIG_FILE_ENV]);
  if (!filePath) {
    fail("MAINTENANCE_RULE_CONFIG_MISSING", `${RULE_PROVIDER_CONFIG_FILE_ENV} is required`);
  }
  return parseTrustedVolcengineMaintenanceRuleProviderConfig(
    readProtectedRuleProviderConfigFile(filePath),
  );
}

export function createTrustedVolcengineMaintenanceRuleProviderFromEnv(input: {
  env?: NodeJS.ProcessEnv;
  options: Omit<TrustedVolcengineMaintenanceRuleProviderOptions, "service">;
  service?: OpenApiService;
}): TrustedVolcengineMaintenanceRuleProvider {
  const env = input.env ?? process.env;
  const region = text(env.FANJIN_RELEASE_CLB_REGION);
  const configuredHost = text(env.FANJIN_RELEASE_CLB_API_HOST) || undefined;
  if (!region && configuredHost) {
    fail("MAINTENANCE_RULE_CONFIG_INVALID", "CLB region is required when API host is configured");
  }
  const host = region ? resolveRegionalClbHost(region, configuredHost) : undefined;
  let service = input.service;
  if (!service) {
    const accessKeyId = text(env.FANJIN_MAINTENANCE_GATE_VOLC_ACCESS_KEY_ID);
    const secretAccessKey = String(env.FANJIN_MAINTENANCE_GATE_VOLC_SECRET_ACCESS_KEY || "");
    const sessionToken = text(env.FANJIN_MAINTENANCE_GATE_VOLC_SESSION_TOKEN) || undefined;
    if (!accessKeyId || !secretAccessKey || !region) {
      fail("MAINTENANCE_RULE_CREDENTIALS_MISSING", "trusted gate workload credentials/region are missing");
    }
    service = new Service({
      accessKeyId,
      secretKey: secretAccessKey,
      sessionToken,
      region,
      host: host!,
      protocol: "https:",
      serviceName: "clb",
      defaultVersion: CLB_API_VERSION,
    });
  }
  return new TrustedVolcengineMaintenanceRuleProvider({
    ...input.options,
    service,
  });
}

export function createTrustedVolcengineMaintenanceRuleProviderFromProtectedConfigEnv(input: {
  env?: NodeJS.ProcessEnv;
  service?: OpenApiService;
  runtime?: Pick<
    TrustedVolcengineMaintenanceRuleProviderOptions,
    | "apiRequestTimeoutMs"
    | "readbackTimeoutMs"
    | "readbackPollIntervalMs"
    | "signal"
    | "clock"
  >;
} = {}): TrustedVolcengineMaintenanceRuleProvider {
  const env = input.env ?? process.env;
  const config = loadTrustedVolcengineMaintenanceRuleProviderConfig(env);
  return createTrustedVolcengineMaintenanceRuleProviderFromEnv({
    env,
    service: input.service,
    options: {
      ...providerOptionsFromConfig(config),
      ...input.runtime,
    },
  });
}

/**
 * Production service factory. The ordinary release controller never receives
 * the provider credential: only this trusted workload creates the exact-rule
 * provider, durable gate, fixed observer and signed HTTPS handler.
 */
export function createTrustedVolcengineMaintenanceRuleHttpsServiceRuntimeFromEnv(input: {
  env?: NodeJS.ProcessEnv;
  provider: Omit<TrustedVolcengineMaintenanceRuleProviderOptions, "service">;
  /** Test seam only. Production must use the dedicated gate workload identity. */
  service?: OpenApiService;
  gate: Omit<TrustedVolcengineMaintenanceGateServiceOptions, "provider" | "topology">;
  observer: Omit<TrustedReleaseMaintenanceProductionObserverServiceOptions, "collector"> & {
    collector: ReleaseMaintenanceProductionMetricsCollector;
  };
  requestHandler: TrustedMaintenanceControlRequestHandlerOptions;
}): ReturnType<typeof createTrustedVolcengineMaintenanceHttpsServiceRuntime> {
  const provider = createTrustedVolcengineMaintenanceRuleProviderFromEnv({
    env: input.env,
    options: input.provider,
    service: input.service,
  });
  return createTrustedVolcengineMaintenanceHttpsServiceRuntime({
    gate: {
      ...input.gate,
      topology: input.provider.topology,
      provider,
    },
    observer: input.observer,
    requestHandler: input.requestHandler,
  });
}

/**
 * Fail-closed production bootstrap. The caller may bind/listen on HTTPS only
 * after this promise resolves; restart recovery always contains an open or
 * indeterminate dedicated rule and never reopens it.
 */
export async function startTrustedVolcengineMaintenanceRuleHttpsServiceRuntimeFromEnv(
  input: Parameters<typeof createTrustedVolcengineMaintenanceRuleHttpsServiceRuntimeFromEnv>[0],
): Promise<ReturnType<typeof createTrustedVolcengineMaintenanceHttpsServiceRuntime>> {
  const runtime = createTrustedVolcengineMaintenanceRuleHttpsServiceRuntimeFromEnv(input);
  await runtime.gate.recoverBeforeListen();
  return runtime;
}

/** Exact production entry: protected resource config + exclusive workload IAM. */
export async function startTrustedVolcengineMaintenanceRuleHttpsServiceRuntimeFromProtectedConfigEnv(
  input: Omit<
    Parameters<typeof createTrustedVolcengineMaintenanceRuleHttpsServiceRuntimeFromEnv>[0],
    "provider"
  > & {
    providerRuntime?: Pick<
      TrustedVolcengineMaintenanceRuleProviderOptions,
      | "apiRequestTimeoutMs"
      | "readbackTimeoutMs"
      | "readbackPollIntervalMs"
      | "signal"
      | "clock"
    >;
  },
): Promise<ReturnType<typeof createTrustedVolcengineMaintenanceHttpsServiceRuntime>> {
  const env = input.env ?? process.env;
  const config = loadTrustedVolcengineMaintenanceRuleProviderConfig(env);
  return startTrustedVolcengineMaintenanceRuleHttpsServiceRuntimeFromEnv({
    env,
    service: input.service,
    provider: {
      ...providerOptionsFromConfig(config),
      ...input.providerRuntime,
    },
    gate: input.gate,
    observer: input.observer,
    requestHandler: input.requestHandler,
  });
}

export const trustedVolcengineMaintenanceRuleProviderFormat = RULE_PROVIDER_CONFIG_FORMAT;
export const trustedVolcengineMaintenanceRuleProviderConfigFileEnv = RULE_PROVIDER_CONFIG_FILE_ENV;
