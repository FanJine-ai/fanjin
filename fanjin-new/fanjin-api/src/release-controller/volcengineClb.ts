import { createHash } from "node:crypto";

import {
  Service,
  VolcengineOpenApiError,
  resolveVolcengineClbRegionalHost,
} from "./volcengineOpenApi";

import {
  assertCompositePublicSmokeConfiguration,
  resolveCompositePublicSmokeConfig,
  runCompositePublicSmoke,
  type CompositePublicSmokeConfig,
  type CompositePublicSmokeOptionOverrides,
  type PublicSmokeFetch,
  type RawSmokeSocketConnector,
} from "./compositePublicSmoke";
import { redactReleaseErrorMessage } from "./errors";
import type {
  BackendHealth,
  DrainResult,
  FullMaintenanceBackendHealthReceipt,
  FullMaintenanceBackendWeightReceipt,
  FullMaintenanceListenerBarrierPhase,
  FullMaintenanceListenerBarrierReceipt,
  FullMaintenanceMutationUncertaintyReceipt,
  LoadBalancer,
  LoadBalancerBackend,
  MaintenanceCanaryPlanReceipt,
  MaintenanceCanaryTrafficReceipt,
  MaintenanceLoadBalancer,
  PublicSmokeResult,
  ReleaseActionContext,
  ReleaseArtifact,
} from "./types";

const CLB_API_VERSION = "2020-04-01";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_APPLICATION_DRAIN_TIMEOUT_MS = 310_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 360_000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 10_000;
const MAX_OPERATION_TIMEOUT_MS = 360_000;
const MAX_API_REQUEST_TIMEOUT_MS = 120_000;
const MAX_POLL_INTERVAL_MS = MAX_OPERATION_TIMEOUT_MS;
const MAX_CLB_TARGETS = 32;
const MAX_HEALTH_PAGES = 100;
const HEALTH_PAGE_SIZE = 100;
const MAX_MAINTENANCE_CANARY_PERCENT = 10;
const DEFAULT_MAINTENANCE_CANARY_AUTO_CONTAIN_MS = 10 * 60_000;
const MIN_MAINTENANCE_CANARY_AUTO_CONTAIN_MS = 2 * 60_000;
const MAX_MAINTENANCE_CANARY_AUTO_CONTAIN_MS = 60 * 60_000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const FULL_MAINTENANCE_HTTP_LISTENER_ID = "lsn-13g0rjw349pts3n6nu4vgf2gu";
export const FULL_MAINTENANCE_HTTPS_LISTENER_ID = "lsn-13f8a4c686akg3n6nu4pqeznv";
const FULL_MAINTENANCE_LISTENER_STABLE_READS = 2 as const;
const FULL_MAINTENANCE_BACKEND_HEALTH_STABLE_READS = 2 as const;
const FULL_MAINTENANCE_BACKEND_WEIGHT_STABLE_READS = 2 as const;
const FULL_MAINTENANCE_REQUEST_RETRY_BUDGET_MS = 0 as const;

type JsonRecord = Record<string, unknown>;
type OpenApiService = Pick<Service, "createAPI">;
type Clock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

export interface VolcengineClbTarget {
  /** Stable controller/node-agent id, for example api-a. */
  nodeId: string;
  /** CLB backend id returned as Servers[].ServerId. */
  serverId: string;
  /** Exact fixed backend port. Required by the full-maintenance path. */
  port?: number;
  /** Root-authorized baseline weight. Required by the full-maintenance path. */
  originalWeight?: number;
}

export interface VolcengineMaintenanceCanaryTrafficGateObservation {
  operationId: string | null;
  artifactSha256: string | null;
  planDigestSha256: string | null;
  state: "open" | "contained";
  trafficWeightPercent: number;
  maintenanceTrafficWeightPercent: number;
  autoContainAfterMs: number;
  productionBackendsAllZero: boolean;
  productionListenerId: string;
  productionServerGroupId: string;
  canaryListenerId: string;
  trafficGateId: string;
  maintenanceServerGroupId: string;
  canaryServerGroupId: string;
  apiNodeIds: readonly string[];
  productionTargets: readonly VolcengineClbTarget[];
  canaryTargets: readonly VolcengineClbTarget[];
  providerRevision: string;
}

export interface VolcengineMaintenanceCanaryTrafficGateQuery {
  operationId: string;
  artifactSha256: string;
  planDigestSha256?: string;
  productionListenerId: string;
  productionServerGroupId: string;
  canaryListenerId: string;
  trafficGateId: string;
  maintenanceServerGroupId: string;
  canaryServerGroupId: string;
  apiNodeIds: readonly string[];
  productionTargets: readonly VolcengineClbTarget[];
  canaryTargets: readonly VolcengineClbTarget[];
  productionBackendWeight: 0;
  maintenanceTrafficWeightPercent: number;
  trafficWeightPercent: number;
  autoContainAfterMs: number;
}

/**
 * Provider-side conditional traffic gate. `open` must atomically compare the
 * exact production inventory at weight zero and the contained gate revision
 * before changing the dedicated listener rule. The operation id and plan
 * digest must remain inspectable after process restart. This boundary is
 * intentionally separate from classic CLB backend weights, which are only
 * relative within one server group.
 */
export interface VolcengineMaintenanceCanaryTrafficGate {
  inspect(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation>;
  open(
    plan: Readonly<MaintenanceCanaryPlanReceipt>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation>;
  contain(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string }>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation>;
}

export interface VolcengineClbAdapterOptions extends CompositePublicSmokeOptionOverrides {
  env?: NodeJS.ProcessEnv;
  region?: string;
  loadBalancerId?: string;
  listenerId?: string;
  serverGroupId?: string;
  targets?: readonly VolcengineClbTarget[];
  maintenanceCanaryListenerId?: string;
  maintenanceCanaryTrafficGateId?: string;
  maintenanceGateServerGroupId?: string;
  maintenanceCanaryServerGroupId?: string;
  maintenanceCanaryTargets?: readonly VolcengineClbTarget[];
  maintenanceCanaryTrafficPercent?: number;
  maintenanceCanaryAutoContainMs?: number;
  /** Provider implementation for the pre-provisioned listener/rule gate. */
  maintenanceCanaryGate?: VolcengineMaintenanceCanaryTrafficGate;
  minHealthyBackends?: number;
  pollIntervalMs?: number;
  operationTimeoutMs?: number;
  apiRequestTimeoutMs?: number;
  /** @deprecated Application connection counters, not a fixed CLB delay, gate activation. */
  drainGraceMs?: number;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  host?: string;
  /** Test seam. Production code should let the adapter construct Service. */
  service?: OpenApiService;
  clock?: Clock;
  fetch?: PublicSmokeFetch;
  signal?: AbortSignal;
  /** Recovery-only construction: containment APIs remain available, smoke is forbidden. */
  containmentOnly?: boolean;
}

interface ResolvedConfig {
  region: string;
  loadBalancerId: string;
  listenerId: string;
  serverGroupId: string;
  targets: readonly VolcengineClbTarget[];
  minHealthyBackends: number;
  pollIntervalMs: number;
  operationTimeoutMs: number;
  apiRequestTimeoutMs: number;
  applicationDrainTimeoutMs: number;
  publicSmoke?: CompositePublicSmokeConfig;
  maintenanceCanary?: Readonly<{
    listenerId: string;
    trafficGateId: string;
    maintenanceServerGroupId: string;
    canaryServerGroupId: string;
    targets: readonly VolcengineClbTarget[];
    trafficWeightPercent: number;
    autoContainAfterMs: number;
  }>;
}

interface ClbServer {
  serverId: string;
  port: number;
  weight: number;
  description: string;
}

interface ClbState {
  servers: ReadonlyMap<string, ClbServer>;
  health: ReadonlyMap<string, BackendHealth>;
}

interface DescribeHealthOptions {
  listenerId?: string;
  allowMissingWeightedTargets?: boolean;
  rejectUnknownStatus?: boolean;
}

type FullMaintenanceHealthyBackend = Readonly<{
  nodeId: string;
  weight: number;
  health: "up";
}>;

type FullMaintenanceListenerHealthSnapshot = Readonly<{
  protocol: "HTTP" | "HTTPS";
  listenerId: string;
  backends: readonly FullMaintenanceHealthyBackend[];
}>;

type FullMaintenanceListenerObservation = Readonly<{
  protocol: "HTTP" | "HTTPS";
  listenerId: string;
  serverGroupId: string;
  port: 80 | 443;
  enabled: boolean;
  status: "Active" | "Disabled";
}>;

class ApiRequestTimeoutError extends Error {}

export class VolcengineClbAdapterError extends Error {
  readonly code: string;
  /** Exact side-effect fact for the all-fleet maintenance drain boundary. */
  readonly productionMutationMayHaveOccurred?: boolean;
  /** Exact side-effect fact for the fixed production listener barrier. */
  readonly listenerMutationMayHaveOccurred?: boolean;

  constructor(
    code: string,
    message: unknown,
    productionMutationMayHaveOccurred?: boolean,
    listenerMutationMayHaveOccurred?: boolean,
  ) {
    super(redactReleaseErrorMessage(message));
    this.name = "VolcengineClbAdapterError";
    this.code = code;
    this.productionMutationMayHaveOccurred = productionMutationMayHaveOccurred;
    this.listenerMutationMayHaveOccurred = listenerMutationMayHaveOccurred;
  }
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parsePositiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new VolcengineClbAdapterError("CLB_CONFIG_INVALID", `${name} must be a positive integer`);
  }
  return parsed;
}

function parseTargets(
  raw: string | undefined,
  variableName = "FANJIN_RELEASE_CLB_TARGETS",
): readonly VolcengineClbTarget[] | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VolcengineClbAdapterError(
      "CLB_CONFIG_INVALID",
      `${variableName} must be valid JSON`,
    );
  }

  if (Array.isArray(parsed)) {
    return parsed.map((entry) => {
      if (!isRecord(entry)) {
        throw new VolcengineClbAdapterError(
          "CLB_CONFIG_INVALID",
          `${variableName} entries must be objects`,
        );
      }
      return {
        nodeId: String(entry.nodeId ?? ""),
        serverId: String(entry.serverId ?? ""),
        ...(Object.prototype.hasOwnProperty.call(entry, "port")
          ? { port: Number(entry.port) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(entry, "originalWeight")
          ? { originalWeight: Number(entry.originalWeight) }
          : {}),
      };
    });
  }

  if (isRecord(parsed)) {
    return Object.entries(parsed).map(([nodeId, serverId]) => ({ nodeId, serverId: String(serverId ?? "") }));
  }

  throw new VolcengineClbAdapterError(
    "CLB_CONFIG_INVALID",
    `${variableName} must be a JSON array or object map`,
  );
}

function parseMaintenanceCanaryPercent(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > MAX_MAINTENANCE_CANARY_PERCENT
  ) {
    throw new VolcengineClbAdapterError(
      "CLB_MAINTENANCE_CANARY_CONFIG_INVALID",
      `maintenance canary traffic percent must be an integer from 1 through ${MAX_MAINTENANCE_CANARY_PERCENT}`,
    );
  }
  return parsed;
}

function validateCloudId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value)) {
    throw new VolcengineClbAdapterError("CLB_CONFIG_INVALID", `${name} has an invalid format`);
  }
  return value;
}

function validateRegion(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) {
    throw new VolcengineClbAdapterError("CLB_CONFIG_INVALID", "CLB region has an invalid format");
  }
  return value;
}

function resolveClbApiHost(region: string, configuredHost?: string): string {
  try {
    return resolveVolcengineClbRegionalHost(region, configuredHost);
  } catch (error) {
    if (!(error instanceof VolcengineOpenApiError)) throw error;
    throw new VolcengineClbAdapterError(
      "CLB_CONFIG_INVALID",
      "CLB API host must match the exact regional endpoint",
    );
  }
}

function validateOptionalTargetPort(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new VolcengineClbAdapterError("CLB_CONFIG_INVALID", `${name} has an invalid port`);
  }
  return port;
}

function resolveConfig(options: VolcengineClbAdapterOptions): ResolvedConfig {
  const env = options.env ?? process.env;
  const region = nonEmpty(options.region) ?? nonEmpty(env.FANJIN_RELEASE_CLB_REGION);
  const loadBalancerId = nonEmpty(options.loadBalancerId)
    ?? nonEmpty(env.FANJIN_RELEASE_CLB_LOAD_BALANCER_ID);
  const listenerId = nonEmpty(options.listenerId) ?? nonEmpty(env.FANJIN_RELEASE_CLB_LISTENER_ID);
  const serverGroupId = nonEmpty(options.serverGroupId) ?? nonEmpty(env.FANJIN_RELEASE_CLB_SERVER_GROUP_ID);
  const targets = options.targets ?? parseTargets(nonEmpty(env.FANJIN_RELEASE_CLB_TARGETS));
  const maintenanceCanaryListenerId = nonEmpty(options.maintenanceCanaryListenerId)
    ?? nonEmpty(env.FANJIN_RELEASE_MAINTENANCE_CANARY_LISTENER_ID);
  const maintenanceCanaryTrafficGateId = nonEmpty(options.maintenanceCanaryTrafficGateId)
    ?? nonEmpty(env.FANJIN_RELEASE_MAINTENANCE_CANARY_TRAFFIC_GATE_ID);
  const maintenanceGateServerGroupId = nonEmpty(options.maintenanceGateServerGroupId)
    ?? nonEmpty(env.FANJIN_RELEASE_MAINTENANCE_GATE_SERVER_GROUP_ID);
  const maintenanceCanaryServerGroupId = nonEmpty(options.maintenanceCanaryServerGroupId)
    ?? nonEmpty(env.FANJIN_RELEASE_MAINTENANCE_CANARY_SERVER_GROUP_ID);
  const maintenanceCanaryTargets = options.maintenanceCanaryTargets
    ?? parseTargets(
      nonEmpty(env.FANJIN_RELEASE_MAINTENANCE_CANARY_TARGETS),
      "FANJIN_RELEASE_MAINTENANCE_CANARY_TARGETS",
    );
  const maintenanceCanaryTrafficPercent = parseMaintenanceCanaryPercent(
    options.maintenanceCanaryTrafficPercent
      ?? nonEmpty(env.FANJIN_RELEASE_MAINTENANCE_CANARY_TRAFFIC_PERCENT),
  );
  const maintenanceCanaryAutoContainMs = parsePositiveInteger(
    options.maintenanceCanaryAutoContainMs
      ?? nonEmpty(env.FANJIN_RELEASE_MAINTENANCE_CANARY_AUTO_CONTAIN_MS),
    "maintenanceCanaryAutoContainMs",
    DEFAULT_MAINTENANCE_CANARY_AUTO_CONTAIN_MS,
  );
  if (
    maintenanceCanaryAutoContainMs < MIN_MAINTENANCE_CANARY_AUTO_CONTAIN_MS
    || maintenanceCanaryAutoContainMs > MAX_MAINTENANCE_CANARY_AUTO_CONTAIN_MS
  ) {
    throw new VolcengineClbAdapterError(
      "CLB_MAINTENANCE_CANARY_CONFIG_INVALID",
      "maintenance canary auto-containment must be from two through sixty minutes",
    );
  }

  const missing = [
    !region && "region",
    !loadBalancerId && "loadBalancerId",
    !listenerId && "listenerId",
    !serverGroupId && "serverGroupId",
    !targets && "targets",
  ].filter(Boolean);
  if (missing.length) {
    throw new VolcengineClbAdapterError(
      "CLB_CONFIG_MISSING",
      `missing required CLB configuration: ${missing.join(", ")}`,
    );
  }

  const normalizedTargets = targets!.map((target) => ({
    nodeId: validateCloudId(nonEmpty(target.nodeId) ?? "", "target nodeId"),
    serverId: validateCloudId(nonEmpty(target.serverId) ?? "", "target serverId"),
    port: validateOptionalTargetPort(target.port, "target"),
    originalWeight: target.originalWeight,
  }));
  if (normalizedTargets.length < 2) {
    throw new VolcengineClbAdapterError(
      "CLB_CONFIG_INVALID",
      "at least two CLB targets are required for zero-downtime rolling release",
    );
  }
  if (normalizedTargets.length > MAX_CLB_TARGETS) {
    throw new VolcengineClbAdapterError(
      "CLB_CONFIG_INVALID",
      `at most ${MAX_CLB_TARGETS} CLB targets are supported`,
    );
  }
  if (new Set(normalizedTargets.map((target) => target.nodeId)).size !== normalizedTargets.length) {
    throw new VolcengineClbAdapterError("CLB_CONFIG_INVALID", "CLB target nodeId values must be unique");
  }
  if (new Set(normalizedTargets.map((target) => target.serverId)).size !== normalizedTargets.length) {
    throw new VolcengineClbAdapterError("CLB_CONFIG_INVALID", "CLB target serverId values must be unique");
  }

  const rawMaintenanceCanary = [
    maintenanceCanaryListenerId,
    maintenanceCanaryTrafficGateId,
    maintenanceGateServerGroupId,
    maintenanceCanaryServerGroupId,
    maintenanceCanaryTargets,
    maintenanceCanaryTrafficPercent,
  ];
  const hasAnyMaintenanceCanaryConfig = rawMaintenanceCanary.some((value) => value !== undefined);
  if (hasAnyMaintenanceCanaryConfig && rawMaintenanceCanary.some((value) => value === undefined)) {
    throw new VolcengineClbAdapterError(
      "CLB_MAINTENANCE_CANARY_CONFIG_MISSING",
      "dedicated maintenance canary listener, gate, groups, targets and percent must be configured together",
    );
  }

  let maintenanceCanary: ResolvedConfig["maintenanceCanary"];
  if (hasAnyMaintenanceCanaryConfig) {
    const normalizedCanaryTargets = maintenanceCanaryTargets!.map((target) => ({
      nodeId: validateCloudId(nonEmpty(target.nodeId) ?? "", "maintenance canary target nodeId"),
      serverId: validateCloudId(nonEmpty(target.serverId) ?? "", "maintenance canary target serverId"),
      port: validateOptionalTargetPort(target.port, "maintenance canary target"),
    }));
    const productionNodeIds = normalizedTargets.map(({ nodeId }) => nodeId).sort();
    const canaryNodeIds = normalizedCanaryTargets.map(({ nodeId }) => nodeId).sort();
    if (
      normalizedCanaryTargets.length !== normalizedTargets.length
      || new Set(canaryNodeIds).size !== normalizedCanaryTargets.length
      || new Set(normalizedCanaryTargets.map(({ serverId }) => serverId)).size !== normalizedCanaryTargets.length
      || productionNodeIds.some((nodeId, index) => nodeId !== canaryNodeIds[index])
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_CONFIG_INVALID",
        "maintenance canary targets must exactly map the trusted production node inventory",
      );
    }
    const validatedCanaryListenerId = validateCloudId(
      maintenanceCanaryListenerId!,
      "maintenance canary listenerId",
    );
    const validatedMaintenanceGroupId = validateCloudId(
      maintenanceGateServerGroupId!,
      "maintenance gate serverGroupId",
    );
    const validatedCanaryGroupId = validateCloudId(
      maintenanceCanaryServerGroupId!,
      "maintenance canary serverGroupId",
    );
    if (
      validatedCanaryListenerId === listenerId
      || validatedMaintenanceGroupId === serverGroupId
      || validatedCanaryGroupId === serverGroupId
      || validatedCanaryGroupId === validatedMaintenanceGroupId
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_CONFIG_INVALID",
        "maintenance canary listener and server groups must be dedicated resources",
      );
    }
    maintenanceCanary = Object.freeze({
      listenerId: validatedCanaryListenerId,
      trafficGateId: validateCloudId(
        maintenanceCanaryTrafficGateId!,
        "maintenance canary trafficGateId",
      ),
      maintenanceServerGroupId: validatedMaintenanceGroupId,
      canaryServerGroupId: validatedCanaryGroupId,
      targets: Object.freeze(normalizedCanaryTargets),
      trafficWeightPercent: maintenanceCanaryTrafficPercent!,
      autoContainAfterMs: maintenanceCanaryAutoContainMs,
    });
  }

  const minHealthyBackends = parsePositiveInteger(
    options.minHealthyBackends ?? nonEmpty(env.FANJIN_RELEASE_CLB_MIN_HEALTHY),
    "minHealthyBackends",
    1,
  );
  if (minHealthyBackends >= normalizedTargets.length) {
    throw new VolcengineClbAdapterError(
      "CLB_CONFIG_INVALID",
      "minHealthyBackends must be smaller than the number of CLB targets",
    );
  }

  const pollIntervalMs = parsePositiveInteger(
    options.pollIntervalMs ?? nonEmpty(env.FANJIN_RELEASE_CLB_POLL_INTERVAL_MS),
    "pollIntervalMs",
    DEFAULT_POLL_INTERVAL_MS,
  );
  const operationTimeoutMs = parsePositiveInteger(
    options.operationTimeoutMs ?? nonEmpty(env.FANJIN_RELEASE_CLB_TIMEOUT_MS),
    "operationTimeoutMs",
    DEFAULT_OPERATION_TIMEOUT_MS,
  );
  const applicationDrainTimeoutMs = parsePositiveInteger(
    options.drainGraceMs ?? nonEmpty(env.FANJIN_RELEASE_DRAIN_TIMEOUT_MS),
    "applicationDrainTimeoutMs",
    DEFAULT_APPLICATION_DRAIN_TIMEOUT_MS,
  );
  const apiRequestTimeoutMs = parsePositiveInteger(
    options.apiRequestTimeoutMs ?? nonEmpty(env.FANJIN_RELEASE_CLB_API_TIMEOUT_MS),
    "apiRequestTimeoutMs",
    DEFAULT_API_REQUEST_TIMEOUT_MS,
  );
  if (
    pollIntervalMs > operationTimeoutMs ||
    apiRequestTimeoutMs > operationTimeoutMs
    || pollIntervalMs > MAX_POLL_INTERVAL_MS
    || operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS
    || apiRequestTimeoutMs > MAX_API_REQUEST_TIMEOUT_MS
  ) {
    throw new VolcengineClbAdapterError(
      "CLB_CONFIG_INVALID",
      "CLB polling and request timeout must fit inside operationTimeoutMs",
    );
  }
  if (!Number.isSafeInteger(
    apiRequestTimeoutMs
    + FULL_MAINTENANCE_REQUEST_RETRY_BUDGET_MS
    + operationTimeoutMs
    + pollIntervalMs,
  )) {
    throw new VolcengineClbAdapterError(
      "CLB_CONFIG_INVALID",
      "CLB mutation uncertainty bound exceeds the safe integer range",
    );
  }

  return Object.freeze({
    region: validateRegion(region!),
    loadBalancerId: validateCloudId(loadBalancerId!, "loadBalancerId"),
    listenerId: validateCloudId(listenerId!, "listenerId"),
    serverGroupId: validateCloudId(serverGroupId!, "serverGroupId"),
    targets: Object.freeze(normalizedTargets),
    minHealthyBackends,
    pollIntervalMs,
    operationTimeoutMs,
    apiRequestTimeoutMs,
    applicationDrainTimeoutMs,
    publicSmoke: options.containmentOnly
      ? undefined
      : resolveCompositePublicSmokeConfig(options, env),
    maintenanceCanary,
  });
}

function safeProviderCode(value: unknown): string {
  const code = typeof value === "string" ? value : "UNKNOWN";
  return code.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "UNKNOWN";
}

function unwrapOpenApiResponse(action: string, response: unknown): JsonRecord {
  if (!isRecord(response)) {
    throw new VolcengineClbAdapterError("CLB_API_INVALID_RESPONSE", `${action} returned an invalid response`);
  }

  const metadata = isRecord(response.ResponseMetadata) ? response.ResponseMetadata : undefined;
  const providerError = metadata && isRecord(metadata.Error) ? metadata.Error : undefined;
  if (providerError) {
    const code = safeProviderCode(providerError.Code);
    const message = typeof providerError.Message === "string" ? providerError.Message : "request rejected";
    throw new VolcengineClbAdapterError("CLB_API_REJECTED", `${action} failed (${code}): ${message}`);
  }

  return isRecord(response.Result) ? response.Result : response;
}

function parseServer(raw: unknown): ClbServer | null {
  if (!isRecord(raw)) return null;
  const serverId = nonEmpty(raw.ServerId);
  const port = raw.Port;
  const weight = raw.Weight;
  if (!serverId || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) return null;
  if (!Number.isInteger(weight) || Number(weight) < 0 || Number(weight) > 100) return null;
  return {
    serverId,
    port: Number(port),
    weight: Number(weight),
    description: typeof raw.Description === "string" ? raw.Description : "",
  };
}

function statusToHealth(value: unknown): BackendHealth {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["up", "healthy", "normal", "available"].includes(status)) return "up";
  if (["down", "unhealthy", "abnormal", "unavailable", "unused"].includes(status)) return "down";
  return "unknown";
}

function enabled(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return ["on", "true", "enabled", "enable", "1"].includes(String(value || "").trim().toLowerCase());
}

function strictListenerEnabled(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["on", "true", "enabled", "enable", "1"].includes(normalized)) return true;
  if (["off", "false", "disabled", "disable", "0"].includes(normalized)) return false;
  return undefined;
}

function mergeHealth(previous: BackendHealth | undefined, next: BackendHealth): BackendHealth {
  if (previous === "down" || next === "down") return "down";
  if (previous === "up" || next === "up") return "up";
  return "unknown";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  throw new VolcengineClbAdapterError(
    "CLB_FULL_MAINTENANCE_LISTENER_RECEIPT_INVALID",
    "listener barrier evidence contains a non-canonical value",
  );
}

function exactSha256(value: unknown, name: string): string {
  const normalized = nonEmpty(value);
  if (!normalized || !SHA256_HEX_PATTERN.test(normalized)) {
    throw new VolcengineClbAdapterError(
      "CLB_MAINTENANCE_CANARY_RECEIPT_INVALID",
      `${name} must be a lowercase SHA-256 digest`,
    );
  }
  return normalized;
}

function sortedTargets(targets: readonly VolcengineClbTarget[]): readonly VolcengineClbTarget[] {
  return Object.freeze(
    [...targets]
      .map(({ nodeId, serverId }) => Object.freeze({ nodeId, serverId }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  );
}

function sameTargets(
  left: readonly VolcengineClbTarget[],
  right: readonly VolcengineClbTarget[],
): boolean {
  const normalizedLeft = sortedTargets(left);
  const normalizedRight = sortedTargets(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((target, index) => (
      target.nodeId === normalizedRight[index]?.nodeId
      && target.serverId === normalizedRight[index]?.serverId
    ));
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("request aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function withRealTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new ApiRequestTimeoutError()), milliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * LoadBalancer implementation backed by Volcano Engine CLB OpenAPI.
 *
 * The adapter stores only non-secret topology/configuration. Credentials live
 * inside the SDK service instance and are never copied to errors or events.
 */
export class VolcengineClbAdapter implements LoadBalancer, MaintenanceLoadBalancer {
  private readonly config: ResolvedConfig;
  private readonly targetByNodeId: ReadonlyMap<string, VolcengineClbTarget>;
  private readonly describeServerGroupApi: ReturnType<Service["createAPI"]>;
  private readonly modifyServerGroupApi: ReturnType<Service["createAPI"]>;
  private readonly describeListenerHealthApi: ReturnType<Service["createAPI"]>;
  private readonly describeListenerAttributesApi: ReturnType<Service["createAPI"]>;
  private readonly modifyListenerAttributesApi: ReturnType<Service["createAPI"]>;
  private readonly clock: Clock;
  private readonly fetchFn: PublicSmokeFetch;
  private readonly rawSmokeSocketConnector?: RawSmokeSocketConnector;
  private readonly signal?: AbortSignal;
  private readonly maintenanceCanaryGate?: VolcengineMaintenanceCanaryTrafficGate;
  private weightMutationTail: Promise<void> = Promise.resolve();

  constructor(options: VolcengineClbAdapterOptions = {}) {
    this.config = resolveConfig(options);
    this.targetByNodeId = new Map(this.config.targets.map((target) => [target.nodeId, target]));
    this.clock = options.clock ?? systemClock;
    this.fetchFn = options.fetch ?? fetch;
    this.rawSmokeSocketConnector = options.rawSmokeSocketConnector;
    this.signal = options.signal;
    this.maintenanceCanaryGate = options.maintenanceCanaryGate;

    const env = options.env ?? process.env;
    const host = resolveClbApiHost(
      this.config.region,
      nonEmpty(options.host) ?? nonEmpty(env.FANJIN_RELEASE_CLB_API_HOST),
    );
    let service = options.service;
    if (!service) {
      const accessKeyId =
        nonEmpty(options.accessKeyId) ??
        nonEmpty(env.FANJIN_RELEASE_VOLC_ACCESS_KEY_ID) ??
        nonEmpty(env.VOLC_ACCESSKEY);
      const secretAccessKey =
        nonEmpty(options.secretAccessKey) ??
        nonEmpty(env.FANJIN_RELEASE_VOLC_SECRET_ACCESS_KEY) ??
        nonEmpty(env.VOLC_SECRETKEY);
      const sessionToken =
        nonEmpty(options.sessionToken) ??
        nonEmpty(env.FANJIN_RELEASE_VOLC_SESSION_TOKEN) ??
        nonEmpty(env.VOLC_SESSION_TOKEN) ??
        nonEmpty(env.VOLC_SESSIONTOKEN);
      if (!accessKeyId || !secretAccessKey) {
        throw new VolcengineClbAdapterError(
          "CLB_CREDENTIALS_MISSING",
          "Volcano Engine access key id and secret access key are required",
        );
      }

      service = new Service({
        accessKeyId,
        secretKey: secretAccessKey,
        sessionToken,
        region: this.config.region,
        host,
        protocol: "https:",
        serviceName: "clb",
        defaultVersion: CLB_API_VERSION,
      });
    }

    this.describeServerGroupApi = service.createAPI("DescribeServerGroupAttributes", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
    this.modifyServerGroupApi = service.createAPI("ModifyServerGroupAttributes", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
    this.describeListenerHealthApi = service.createAPI("DescribeListenerHealth", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
    this.describeListenerAttributesApi = service.createAPI("DescribeListenerAttributes", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
    this.modifyListenerAttributesApi = service.createAPI("ModifyListenerAttributes", {
      Version: CLB_API_VERSION,
      method: "GET",
    });
  }

  private fullMaintenanceBackendBindings(): readonly Readonly<{
    nodeId: string;
    serverId: string;
    port: number;
    originalWeight: number;
  }>[] {
    const bindings = this.config.targets.map((target) => {
      if (!Number.isSafeInteger(target.port) || target.port! < 1 || target.port! > 65_535) {
        throw new VolcengineClbAdapterError(
          "CLB_FULL_MAINTENANCE_TOPOLOGY_UNBOUND",
          "full-maintenance requires an exact fixed port for every CLB backend",
        );
      }
      if (
        !Number.isSafeInteger(target.originalWeight)
        || target.originalWeight! < 1
        || target.originalWeight! > 100
      ) {
        throw new VolcengineClbAdapterError(
          "CLB_FULL_MAINTENANCE_TOPOLOGY_UNBOUND",
          "full-maintenance requires an exact original weight from 1 through 100 for every CLB backend",
        );
      }
      return Object.freeze({
        nodeId: target.nodeId,
        serverId: target.serverId,
        port: target.port!,
        originalWeight: target.originalWeight!,
      });
    }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    return Object.freeze(bindings);
  }

  fullMaintenanceMutationUncertainty(): FullMaintenanceMutationUncertaintyReceipt {
    const backendBindings = this.fullMaintenanceBackendBindings();
    const targetCount = this.config.targets.length;
    // Worst full-maintenance restore path, including its fail-closed re-zero
    // compensation: baseline/final reads plus every target's sequential
    // describe/mutate/poll path. Poll sleeps are already bounded by the
    // operation convergence deadline; the final predicate may consume one
    // additional request timeout.
    const sequentialApiCallSlots = 5 * targetCount + 2;
    const convergenceWindowSlots = 2 * targetCount + 1;
    const withoutEvidence = Object.freeze({
      format: "fanjin-full-maintenance-mutation-uncertainty/v1" as const,
      loadBalancerId: this.config.loadBalancerId,
      serverGroupId: this.config.serverGroupId,
      backendBindings,
      targetCount,
      apiRequestTimeoutUpperBoundMs: MAX_API_REQUEST_TIMEOUT_MS,
      requestRetryBudgetUpperBoundMs: FULL_MAINTENANCE_REQUEST_RETRY_BUDGET_MS,
      operationConvergenceUpperBoundMs: MAX_OPERATION_TIMEOUT_MS,
      pollIntervalUpperBoundMs: MAX_POLL_INTERVAL_MS,
      sequentialApiCallSlots,
      convergenceWindowSlots,
      settleMs:
        sequentialApiCallSlots * MAX_API_REQUEST_TIMEOUT_MS
        + convergenceWindowSlots
          * (MAX_OPERATION_TIMEOUT_MS + MAX_API_REQUEST_TIMEOUT_MS)
        + FULL_MAINTENANCE_REQUEST_RETRY_BUDGET_MS,
    });
    return Object.freeze({
      ...withoutEvidence,
      evidenceSha256: sha256Hex(canonicalJson(withoutEvidence)),
    });
  }

  async listBackends(_context: ReleaseActionContext): Promise<readonly LoadBalancerBackend[]> {
    const state = await this.readState();
    return this.config.targets.map((target) => {
      const server = state.servers.get(target.serverId)!;
      return {
        nodeId: target.nodeId,
        weight: server.weight,
        health: state.health.get(target.serverId) ?? "unknown",
      };
    });
  }

  async getBackend(nodeId: string, context: ReleaseActionContext): Promise<LoadBalancerBackend> {
    this.requireTarget(nodeId);
    const backends = await this.listBackends(context);
    return backends.find((backend) => backend.nodeId === nodeId)!;
  }

  async setWeight(nodeId: string, weight: number, context: ReleaseActionContext): Promise<void> {
    return this.withWeightMutationLock(() => this.setWeightLocked(nodeId, weight, context, false));
  }

  private async setWeightLocked(
    nodeId: string,
    weight: number,
    _context: ReleaseActionContext,
    allowFullMaintenanceDrain: boolean,
  ): Promise<void> {
    const target = this.requireTarget(nodeId);
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      throw new VolcengineClbAdapterError("CLB_WEIGHT_INVALID", "CLB backend weight must be 0 through 100");
    }

    const state = allowFullMaintenanceDrain
      ? { servers: await this.describeServers(), health: new Map<string, BackendHealth>() }
      : await this.readState();
    const server = state.servers.get(target.serverId)!;
    if (server.weight === weight) return;

    if (
      !allowFullMaintenanceDrain
      && weight > 0
      && this.config.targets.every((candidate) => (
        state.servers.get(candidate.serverId)?.weight === 0
      ))
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_REQUIRED",
        "ordinary backend weights cannot open traffic from an all-zero maintenance fleet",
      );
    }

    if (weight === 0 && !allowFullMaintenanceDrain) {
      const healthyOthers = this.config.targets.filter((candidate) => {
        if (candidate.nodeId === nodeId) return false;
        const candidateServer = state.servers.get(candidate.serverId);
        return candidateServer && candidateServer.weight > 0 && state.health.get(candidate.serverId) === "up";
      }).length;
      if (healthyOthers < this.config.minHealthyBackends) {
        throw new VolcengineClbAdapterError(
          "CLB_MIN_HEALTHY_GUARD",
          `refusing to drain ${nodeId}: only ${healthyOthers} other healthy weighted backends are available`,
        );
      }
    }

    await this.callApi("ModifyServerGroupAttributes", this.modifyServerGroupApi, {
      ServerGroupId: this.config.serverGroupId,
      "Servers.1.ServerId": server.serverId,
      "Servers.1.Weight": weight,
      "Servers.1.Port": server.port,
      "Servers.1.Description": server.description,
    });

    await this.poll(
      `CLB weight ${weight} for ${nodeId}`,
      async () => (await this.describeServers()).get(target.serverId)?.weight === weight,
    );
  }

  private requireMaintenanceCanary(): Readonly<{
    config: NonNullable<ResolvedConfig["maintenanceCanary"]>;
    gate: VolcengineMaintenanceCanaryTrafficGate;
  }> {
    if (!this.config.maintenanceCanary || !this.maintenanceCanaryGate) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_UNAVAILABLE",
        "a dedicated maintenance canary listener and conditional traffic gate are required",
      );
    }
    return { config: this.config.maintenanceCanary, gate: this.maintenanceCanaryGate };
  }

  private maintenanceCanaryQuery(
    context: ReleaseActionContext,
    planDigestSha256?: string,
  ): VolcengineMaintenanceCanaryTrafficGateQuery {
    const { config } = this.requireMaintenanceCanary();
    const apiNodeIds = Object.freeze(this.config.targets.map(({ nodeId }) => nodeId).sort());
    return Object.freeze({
      operationId: nonEmpty(context.operationId) ?? "",
      artifactSha256: exactSha256(context.artifactSha256, "artifactSha256"),
      ...(planDigestSha256 === undefined
        ? {}
        : { planDigestSha256: exactSha256(planDigestSha256, "planDigestSha256") }),
      productionListenerId: this.config.listenerId,
      productionServerGroupId: this.config.serverGroupId,
      canaryListenerId: config.listenerId,
      trafficGateId: config.trafficGateId,
      maintenanceServerGroupId: config.maintenanceServerGroupId,
      canaryServerGroupId: config.canaryServerGroupId,
      apiNodeIds,
      productionTargets: sortedTargets(this.config.targets),
      canaryTargets: sortedTargets(config.targets),
      productionBackendWeight: 0,
      maintenanceTrafficWeightPercent: 100 - config.trafficWeightPercent,
      trafficWeightPercent: config.trafficWeightPercent,
      autoContainAfterMs: config.autoContainAfterMs,
    });
  }

  private buildMaintenanceCanaryPlan(
    authorizationSha256: string,
    context: ReleaseActionContext,
    expectedContainedProviderRevision: string,
  ): MaintenanceCanaryPlanReceipt {
    const query = this.maintenanceCanaryQuery(context);
    if (!query.operationId) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_PLAN_INVALID",
        "maintenance canary operationId must be non-empty",
      );
    }
    const withoutDigest: Omit<MaintenanceCanaryPlanReceipt, "planDigestSha256"> = {
      format: "fanjin-maintenance-canary-plan/v1",
      operationId: query.operationId,
      artifactSha256: query.artifactSha256,
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
      expectedContainedProviderRevision: this.exactProviderRevision(
        expectedContainedProviderRevision,
        "expectedContainedProviderRevision",
      ),
      authorizationSha256: exactSha256(authorizationSha256, "authorizationSha256"),
    };
    return Object.freeze({
      ...withoutDigest,
      planDigestSha256: sha256Hex(JSON.stringify(withoutDigest)),
    });
  }

  private assertMaintenanceCanaryPlan(
    plan: Readonly<MaintenanceCanaryPlanReceipt>,
    context: ReleaseActionContext,
  ): MaintenanceCanaryPlanReceipt {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_PLAN_INVALID",
        "maintenance canary plan receipt is malformed",
      );
    }
    const expected = this.buildMaintenanceCanaryPlan(
      plan.authorizationSha256,
      context,
      plan.expectedContainedProviderRevision,
    );
    if (
      plan.format !== expected.format
      || plan.operationId !== expected.operationId
      || plan.artifactSha256 !== expected.artifactSha256
      || plan.productionListenerId !== expected.productionListenerId
      || plan.productionServerGroupId !== expected.productionServerGroupId
      || plan.canaryListenerId !== expected.canaryListenerId
      || plan.trafficGateId !== expected.trafficGateId
      || plan.maintenanceServerGroupId !== expected.maintenanceServerGroupId
      || plan.canaryServerGroupId !== expected.canaryServerGroupId
      || plan.productionBackendWeight !== 0
      || plan.maintenanceTrafficWeightPercent !== expected.maintenanceTrafficWeightPercent
      || plan.trafficWeightPercent !== expected.trafficWeightPercent
      || plan.autoContainAfterMs !== expected.autoContainAfterMs
      || plan.expectedContainedProviderRevision !== expected.expectedContainedProviderRevision
      || plan.authorizationSha256 !== expected.authorizationSha256
      || plan.planDigestSha256 !== expected.planDigestSha256
      || plan.apiNodeIds.length !== expected.apiNodeIds.length
      || plan.apiNodeIds.some((nodeId, index) => nodeId !== expected.apiNodeIds[index])
      || !sameTargets(plan.productionTargets, expected.productionTargets)
      || !sameTargets(plan.canaryTargets, expected.canaryTargets)
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_PLAN_MISMATCH",
        "maintenance canary plan does not match the exact authorized topology",
      );
    }
    return expected;
  }

  private exactProviderRevision(value: unknown, name: string): string {
    const revision = nonEmpty(value);
    if (
      !revision
      || revision.length > 256
      || /[\u0000-\u001f\u007f]/u.test(revision)
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_RECEIPT_INVALID",
        `${name} is invalid`,
      );
    }
    return revision;
  }

  private assertMaintenanceCanaryObservation(
    observation: VolcengineMaintenanceCanaryTrafficGateObservation,
    query: VolcengineMaintenanceCanaryTrafficGateQuery,
    options: Readonly<{
      expectedState: "open" | "contained";
      requireProductionZero: boolean;
      allowUnboundContained?: boolean;
    }>,
  ): void {
    const unbound = observation.operationId === null
      && observation.artifactSha256 === null
      && observation.planDigestSha256 === null;
    const expectedDigest = query.planDigestSha256;
    const bindingMatches = observation.operationId === query.operationId
      && observation.artifactSha256 === query.artifactSha256
      && (expectedDigest === undefined || observation.planDigestSha256 === expectedDigest);
    const apiNodeIds = [...observation.apiNodeIds].sort();
    if (
      observation.state !== options.expectedState
      || observation.trafficWeightPercent !== (
        options.expectedState === "open" ? query.trafficWeightPercent : 0
      )
      || observation.maintenanceTrafficWeightPercent !== (
        options.expectedState === "open" ? query.maintenanceTrafficWeightPercent : 100
      )
      || observation.autoContainAfterMs !== query.autoContainAfterMs
      || (options.requireProductionZero && observation.productionBackendsAllZero !== true)
      || observation.productionListenerId !== query.productionListenerId
      || observation.productionServerGroupId !== query.productionServerGroupId
      || observation.canaryListenerId !== query.canaryListenerId
      || observation.trafficGateId !== query.trafficGateId
      || observation.maintenanceServerGroupId !== query.maintenanceServerGroupId
      || observation.canaryServerGroupId !== query.canaryServerGroupId
      || apiNodeIds.length !== query.apiNodeIds.length
      || apiNodeIds.some((nodeId, index) => nodeId !== query.apiNodeIds[index])
      || !sameTargets(observation.productionTargets, query.productionTargets)
      || !sameTargets(observation.canaryTargets, query.canaryTargets)
      || !(bindingMatches || (options.allowUnboundContained === true && unbound))
      || !nonEmpty(observation.providerRevision)
      || observation.providerRevision.length > 256
      || /[\u0000-\u001f\u007f]/u.test(observation.providerRevision)
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_CANARY_STATE_MISMATCH",
        "maintenance canary gate observation does not match the exact plan and topology",
      );
    }
  }

  private maintenanceCanaryReceipt(
    observation: VolcengineMaintenanceCanaryTrafficGateObservation,
    query: VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string },
  ): MaintenanceCanaryTrafficReceipt {
    return Object.freeze({
      format: "fanjin-maintenance-canary-traffic/v1",
      operationId: query.operationId,
      artifactSha256: query.artifactSha256,
      planDigestSha256: query.planDigestSha256,
      state: observation.state,
      observedTrafficWeightPercent: observation.trafficWeightPercent,
      observedMaintenanceTrafficWeightPercent: observation.maintenanceTrafficWeightPercent,
      autoContainAfterMs: query.autoContainAfterMs,
      productionBackendsAllZero: true,
      canaryListenerId: query.canaryListenerId,
      trafficGateId: query.trafficGateId,
      maintenanceServerGroupId: query.maintenanceServerGroupId,
      canaryServerGroupId: query.canaryServerGroupId,
      apiNodeIds: query.apiNodeIds,
      providerRevision: observation.providerRevision,
    });
  }

  private async assertProductionAllZero(): Promise<void> {
    const servers = await this.describeServers();
    if (this.config.targets.some(({ serverId }) => servers.get(serverId)?.weight !== 0)) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_DRAIN_LOST",
        "maintenance canary requires every trusted production backend at weight zero",
      );
    }
  }

  async maintenancePlanCanary(
    authorizationSha256: string,
    context: ReleaseActionContext,
  ): Promise<MaintenanceCanaryPlanReceipt> {
    return this.withWeightMutationLock(async () => {
      await this.assertProductionAllZero();
      const query = this.maintenanceCanaryQuery(context);
      const { gate } = this.requireMaintenanceCanary();
      const observation = await gate.inspect(query);
      this.assertMaintenanceCanaryObservation(observation, query, {
        expectedState: "contained",
        requireProductionZero: true,
        allowUnboundContained: true,
      });
      return this.buildMaintenanceCanaryPlan(
        authorizationSha256,
        context,
        observation.providerRevision,
      );
    });
  }

  async maintenanceOpenCanary(
    inputPlan: Readonly<MaintenanceCanaryPlanReceipt>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceCanaryTrafficReceipt> {
    return this.withWeightMutationLock(async () => {
      const plan = this.assertMaintenanceCanaryPlan(inputPlan, context);
      const query = this.maintenanceCanaryQuery(context, plan.planDigestSha256) as
        VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string };
      await this.assertProductionAllZero();
      const { gate } = this.requireMaintenanceCanary();
      const before = await gate.inspect(query);
      this.assertMaintenanceCanaryObservation(before, query, {
        expectedState: "contained",
        requireProductionZero: true,
        allowUnboundContained: true,
      });
      if (before.providerRevision !== plan.expectedContainedProviderRevision) {
        throw new VolcengineClbAdapterError(
          "CLB_MAINTENANCE_CANARY_REVISION_DRIFT",
          "maintenance canary gate changed after the durable plan was recorded",
        );
      }
      const opened = await gate.open(plan);
      this.assertMaintenanceCanaryObservation(opened, query, {
        expectedState: "open",
        requireProductionZero: true,
      });
      await this.assertProductionAllZero();
      return this.maintenanceCanaryReceipt(opened, query);
    });
  }

  async maintenanceObserveCanary(
    planDigestSha256: string,
    context: ReleaseActionContext,
  ): Promise<MaintenanceCanaryTrafficReceipt> {
    return this.withWeightMutationLock(async () => {
      const query = this.maintenanceCanaryQuery(context, planDigestSha256) as
        VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string };
      await this.assertProductionAllZero();
      const { gate } = this.requireMaintenanceCanary();
      const observation = await gate.inspect(query);
      this.assertMaintenanceCanaryObservation(observation, query, {
        expectedState: "open",
        requireProductionZero: true,
      });
      return this.maintenanceCanaryReceipt(observation, query);
    });
  }

  async maintenanceContainCanary(
    planDigestSha256: string,
    context: ReleaseActionContext,
  ): Promise<MaintenanceCanaryTrafficReceipt> {
    return this.withWeightMutationLock(async () => {
      const query = this.maintenanceCanaryQuery(context, planDigestSha256) as
        VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string };
      const { gate } = this.requireMaintenanceCanary();
      const contained = await gate.contain(query);
      this.assertMaintenanceCanaryObservation(contained, query, {
        expectedState: "contained",
        requireProductionZero: true,
      });
      await this.assertProductionAllZero();
      return this.maintenanceCanaryReceipt(contained, query);
    });
  }

  private exactMaintenanceWeights(
    value: Readonly<Record<string, number>>,
  ): Array<{ nodeId: string; weight: number }> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_WEIGHTS_INVALID",
        "maintenance backend weights must be an exact object",
      );
    }
    const configured = this.config.targets.map(({ nodeId }) => nodeId).sort();
    const observed = Object.keys(value).sort();
    if (
      configured.length !== observed.length
      || configured.some((nodeId, index) => nodeId !== observed[index])
      || observed.some((nodeId) => (
        !Number.isSafeInteger(value[nodeId])
        || value[nodeId] < 1
        || value[nodeId] > 100
      ))
      || this.config.targets.some(({ nodeId, originalWeight }) => (
        !Number.isSafeInteger(originalWeight)
        || originalWeight! < 1
        || originalWeight! > 100
        || value[nodeId] !== originalWeight
      ))
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_MAINTENANCE_WEIGHTS_INVALID",
        "maintenance backend weights do not match the trusted full inventory and baseline weights",
      );
    }
    return this.config.targets.map(({ nodeId }) => ({ nodeId, weight: value[nodeId] }));
  }

  private async fullMaintenanceRezeroLocked(
    targets: readonly Readonly<{ nodeId: string; weight: number }>[],
    context: ReleaseActionContext,
  ): Promise<void> {
    let mutationError: unknown;
    for (const target of targets) {
      try {
        const current = (await this.describeServers()).get(
          this.requireTarget(target.nodeId).serverId,
        );
        if (current?.weight !== 0) {
          await this.setWeightLocked(target.nodeId, 0, context, true);
        }
      } catch (error) {
        mutationError ??= error;
      }
    }
    let contained = false;
    try {
      const current = await this.describeServers();
      contained = current.size === targets.length
        && targets.every(({ nodeId }) => (
          current.get(this.requireTarget(nodeId).serverId)?.weight === 0
        ));
    } catch (error) {
      mutationError ??= error;
    }
    if (!contained) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_RECONTAIN_FAILED",
        mutationError ?? "full-maintenance fleet could not be proven all-zero",
        true,
      );
    }
  }

  async fullMaintenanceDrainAll(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<void> {
    const targets = this.exactMaintenanceWeights(expectedWeights);
    return this.withWeightMutationLock(async () => {
      // Both fixed listeners are already disabled at this boundary. Volcano
      // may omit listener-health rows (or retain stale ones) while a listener
      // is stopped, so only the authoritative server-group membership and
      // exact recorded weights are meaningful here.
      const before = await this.describeServers();
      if (
        before.size !== targets.length
        || targets.some(({ nodeId }) => (
          before.get(this.requireTarget(nodeId).serverId)?.weight !== expectedWeights[nodeId]
        ))
      ) {
        throw new VolcengineClbAdapterError(
          "CLB_FULL_MAINTENANCE_BASELINE_CHANGED",
          "full-maintenance drain requires the exact recorded server-group membership and weights",
          false,
        );
      }
      let mutationMayHaveOccurred = false;
      try {
        for (const target of targets) {
          // Mark before the request because a provider response can be lost
          // after the mutation has already reached the control plane.
          mutationMayHaveOccurred = true;
          await this.setWeightLocked(target.nodeId, 0, context, true);
        }
        await this.poll("full-maintenance CLB drain", async () => {
          const current = await this.describeServers();
          return current.size === targets.length
            && targets.every(({ nodeId }) => (
              current.get(this.requireTarget(nodeId).serverId)?.weight === 0
            ));
        });
      } catch (error) {
        try {
          await this.fullMaintenanceRezeroLocked(targets, context);
        } catch (containmentError) {
          throw containmentError;
        }
        throw new VolcengineClbAdapterError(
          error instanceof VolcengineClbAdapterError
            ? error.code
            : "CLB_FULL_MAINTENANCE_DRAIN_FAILED",
          error,
          mutationMayHaveOccurred,
        );
      }
    });
  }

  async fullMaintenanceRestoreAll(
    expectedWeights: Readonly<Record<string, number>>,
    validationReceiptSha256: string,
    context: ReleaseActionContext,
  ): Promise<void> {
    const targets = this.exactMaintenanceWeights(expectedWeights);
    exactSha256(validationReceiptSha256, "fullMaintenanceValidationReceiptSha256");
    return this.withWeightMutationLock(async () => {
      // Listener health is intentionally undefined while both production
      // listeners remain stopped. Restore only from the exact all-zero group;
      // health is proven separately after the listener barrier is reopened.
      // Re-prove the fixed listener pair and its committed production server
      // group before the first backend mutation. This also prevents a stale
      // all-zero group from being restored after either listener was rebound.
      await this.assertStableListenerState(false, "contained", context);
      const before = await this.describeServers();
      if (
        before.size !== targets.length
        || targets.some(({ nodeId }) => (
          before.get(this.requireTarget(nodeId).serverId)?.weight !== 0
        ))
      ) {
        throw new VolcengineClbAdapterError(
          "CLB_FULL_MAINTENANCE_RESTORE_BASELINE_INVALID",
          "full-maintenance restore requires the exact all-zero server group",
          false,
        );
      }
      let mutationMayHaveOccurred = false;
      try {
        for (const target of targets) {
          mutationMayHaveOccurred = true;
          await this.setWeightLocked(target.nodeId, target.weight, context, true);
        }
        await this.poll("full-maintenance CLB restore", async () => {
          const current = await this.describeServers();
          return current.size === targets.length
            && targets.every(({ nodeId }) => (
              current.get(this.requireTarget(nodeId).serverId)?.weight === expectedWeights[nodeId]
            ));
        });
      } catch (error) {
        try {
          await this.fullMaintenanceRezeroLocked(targets, context);
        } catch (containmentError) {
          throw containmentError;
        }
        throw new VolcengineClbAdapterError(
          error instanceof VolcengineClbAdapterError
            ? error.code
            : "CLB_FULL_MAINTENANCE_RESTORE_FAILED",
          error,
          mutationMayHaveOccurred,
        );
      }
    });
  }

  async fullMaintenanceContainAll(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<void> {
    const targets = this.exactMaintenanceWeights(expectedWeights);
    return this.withWeightMutationLock(async () => {
      const current = await this.describeServers();
      if (
        current.size !== targets.length
        || targets.some(({ nodeId, weight }) => {
          const observed = current.get(this.requireTarget(nodeId).serverId)?.weight;
          return observed !== 0 && observed !== weight;
        })
      ) {
        throw new VolcengineClbAdapterError(
          "CLB_FULL_MAINTENANCE_CONTAINMENT_DRIFT",
          "full-maintenance containment found a backend outside zero or its recorded weight",
          true,
        );
      }
      await this.fullMaintenanceRezeroLocked(targets, context);
    });
  }

  private fullMaintenanceBackendWeightReceipt(
    expectedState: "all-zero" | "original",
    backends: readonly Readonly<{ nodeId: string; weight: number }>[],
    context: ReleaseActionContext,
  ): FullMaintenanceBackendWeightReceipt {
    if (!SHA256_HEX_PATTERN.test(context.artifactSha256)) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_BACKEND_WEIGHT_RECEIPT_INVALID",
        "backend weight context must contain a lowercase artifact SHA-256",
      );
    }
    const operationId = nonEmpty(context.operationId);
    if (!operationId) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_BACKEND_WEIGHT_RECEIPT_INVALID",
        "backend weight context must contain an operation id",
      );
    }
    const withoutEvidence = {
      format: "fanjin-full-maintenance-backend-weight/v1" as const,
      operationId,
      artifactSha256: context.artifactSha256,
      loadBalancerId: this.config.loadBalancerId,
      serverGroupId: this.config.serverGroupId,
      backendBindings: this.fullMaintenanceBackendBindings(),
      expectedState,
      backends: Object.freeze(
        [...backends]
          .map(({ nodeId, weight }) => Object.freeze({ nodeId, weight }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      ),
      stableReadCount: FULL_MAINTENANCE_BACKEND_WEIGHT_STABLE_READS,
    };
    return Object.freeze({
      ...withoutEvidence,
      evidenceSha256: sha256Hex(canonicalJson(withoutEvidence)),
    });
  }

  async fullMaintenanceInspectBackendWeights(
    expectedWeights: Readonly<Record<string, number>>,
    expectedState: "all-zero" | "original",
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceBackendWeightReceipt> {
    if (expectedState !== "all-zero" && expectedState !== "original") {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_BACKEND_WEIGHT_STATE_INVALID",
        "backend weight proof expected state is invalid",
      );
    }
    const targets = this.exactMaintenanceWeights(expectedWeights);
    return this.withWeightMutationLock(async () => {
      let consecutive = 0;
      let latest: readonly Readonly<{ nodeId: string; weight: number }>[] | undefined;
      const startedAt = this.clock.now();
      while (consecutive < FULL_MAINTENANCE_BACKEND_WEIGHT_STABLE_READS) {
        const servers = await this.describeServers();
        latest = targets.map(({ nodeId }) => Object.freeze({
          nodeId,
          weight: servers.get(this.requireTarget(nodeId).serverId)?.weight ?? -1,
        }));
        const exact = servers.size === targets.length
          && latest.every(({ nodeId, weight }) => (
            weight === (expectedState === "all-zero" ? 0 : expectedWeights[nodeId])
          ));
        if (!exact) {
          throw new VolcengineClbAdapterError(
            "CLB_FULL_MAINTENANCE_BACKEND_WEIGHT_STATE_INVALID",
            `full-maintenance backend weights are not exact for ${expectedState}`,
          );
        }
        consecutive += 1;
        if (consecutive < FULL_MAINTENANCE_BACKEND_WEIGHT_STABLE_READS) {
          const elapsed = this.clock.now() - startedAt;
          if (elapsed >= this.config.operationTimeoutMs) {
            throw new VolcengineClbAdapterError(
              "CLB_FULL_MAINTENANCE_BACKEND_WEIGHT_TIMEOUT",
              "backend weight proof did not converge before timeout",
            );
          }
          const sleep = this.clock.sleep(
            Math.min(this.config.pollIntervalMs, this.config.operationTimeoutMs - elapsed),
          );
          if (this.signal) await raceWithAbort(sleep, this.signal);
          else await sleep;
        }
      }
      return this.fullMaintenanceBackendWeightReceipt(expectedState, latest!, context);
    });
  }

  private async readFullMaintenanceListener(
    listenerId: string,
    protocol: "HTTP" | "HTTPS",
  ): Promise<FullMaintenanceListenerObservation> {
    const result = await this.callApi(
      "DescribeListenerAttributes",
      this.describeListenerAttributesApi,
      { ListenerId: listenerId },
    );
    if (
      nonEmpty(result.ListenerId) !== listenerId
      || nonEmpty(result.LoadBalancerId) !== this.config.loadBalancerId
      || nonEmpty(result.ServerGroupId) !== this.config.serverGroupId
      || String(result.Protocol ?? "").trim().toUpperCase() !== protocol
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_TOPOLOGY_DRIFT",
        "full-maintenance listener identity, load balancer, server group or protocol drifted",
      );
    }
    const observedEnabled = strictListenerEnabled(result.Enabled);
    if (observedEnabled === undefined) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_RESPONSE_INVALID",
        "full-maintenance listener returned an unknown enabled state",
      );
    }
    const expectedPort = protocol === "HTTP" ? 80 : 443;
    if (Number(result.Port) !== expectedPort || !Number.isSafeInteger(Number(result.Port))) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_TOPOLOGY_DRIFT",
        "full-maintenance listener port drifted",
      );
    }
    const rawStatus = String(result.Status ?? "").trim().toLowerCase();
    if (rawStatus === "pending" || rawStatus === "creating") {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_PENDING",
        "full-maintenance listener control plane is still converging",
      );
    }
    if (rawStatus === "deleting" || (rawStatus !== "active" && rawStatus !== "disabled")) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_RESPONSE_INVALID",
        "full-maintenance listener returned an unsafe status",
      );
    }
    const status = rawStatus === "active" ? "Active" as const : "Disabled" as const;
    if (
      (observedEnabled && status !== "Active")
      || (!observedEnabled && status !== "Disabled")
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_PENDING",
        "full-maintenance listener enabled/status fields have not converged",
      );
    }
    return Object.freeze({
      protocol,
      listenerId,
      serverGroupId: this.config.serverGroupId,
      port: expectedPort,
      enabled: observedEnabled,
      status,
    });
  }

  private async readFullMaintenanceListeners(): Promise<readonly [
    FullMaintenanceListenerObservation,
    FullMaintenanceListenerObservation,
  ]> {
    const http = await this.readFullMaintenanceListener(
      FULL_MAINTENANCE_HTTP_LISTENER_ID,
      "HTTP",
    );
    const https = await this.readFullMaintenanceListener(
      FULL_MAINTENANCE_HTTPS_LISTENER_ID,
      "HTTPS",
    );
    return Object.freeze([http, https]);
  }

  private listenerBarrierReceipt(
    phase: FullMaintenanceListenerBarrierPhase,
    expectedEnabled: boolean,
    listeners: readonly [
      FullMaintenanceListenerObservation,
      FullMaintenanceListenerObservation,
    ],
    context: ReleaseActionContext,
  ): FullMaintenanceListenerBarrierReceipt {
    if (!SHA256_HEX_PATTERN.test(context.artifactSha256)) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_RECEIPT_INVALID",
        "listener barrier context must contain a lowercase artifact SHA-256",
      );
    }
    const operationId = nonEmpty(context.operationId);
    if (!operationId) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_RECEIPT_INVALID",
        "listener barrier context must contain an operation id",
      );
    }
    const withoutEvidence = {
      format: "fanjin-full-maintenance-listener-barrier/v1" as const,
      operationId,
      artifactSha256: context.artifactSha256,
      loadBalancerId: this.config.loadBalancerId,
      serverGroupId: this.config.serverGroupId,
      httpListenerId: FULL_MAINTENANCE_HTTP_LISTENER_ID,
      httpsListenerId: FULL_MAINTENANCE_HTTPS_LISTENER_ID,
      phase,
      observedState: expectedEnabled ? "all-on" as const : "all-off" as const,
      listeners: Object.freeze([
        Object.freeze({ ...listeners[0] }),
        Object.freeze({ ...listeners[1] }),
      ]) as FullMaintenanceListenerBarrierReceipt["listeners"],
      stableReadCount: FULL_MAINTENANCE_LISTENER_STABLE_READS,
    };
    return Object.freeze({
      ...withoutEvidence,
      evidenceSha256: sha256Hex(canonicalJson(withoutEvidence)),
    });
  }

  private listenerBarrierFatal(error: unknown): boolean {
    return error instanceof VolcengineClbAdapterError && [
      "CLB_FULL_MAINTENANCE_LISTENER_TOPOLOGY_DRIFT",
      "CLB_FULL_MAINTENANCE_LISTENER_RESPONSE_INVALID",
      "CLB_FULL_MAINTENANCE_LISTENER_RECEIPT_INVALID",
      "CLB_OPERATION_ABORTED",
    ].includes(error.code);
  }

  private async listenerBarrierSleep(startedAt: number, description: string): Promise<void> {
    const elapsed = this.clock.now() - startedAt;
    if (elapsed >= this.config.operationTimeoutMs) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_LISTENER_TIMEOUT",
        `${description} did not converge before timeout`,
      );
    }
    const sleep = this.clock.sleep(
      Math.min(this.config.pollIntervalMs, this.config.operationTimeoutMs - elapsed),
    );
    if (this.signal) await raceWithAbort(sleep, this.signal);
    else await sleep;
  }

  private async assertStableListenerState(
    expectedEnabled: boolean,
    phase: FullMaintenanceListenerBarrierPhase,
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt> {
    const startedAt = this.clock.now();
    let latest: readonly [
      FullMaintenanceListenerObservation,
      FullMaintenanceListenerObservation,
    ] | undefined;
    let consecutive = 0;
    while (consecutive < FULL_MAINTENANCE_LISTENER_STABLE_READS) {
      try {
        latest = await this.readFullMaintenanceListeners();
        if (latest.some((listener) => listener.enabled !== expectedEnabled)) {
          throw new VolcengineClbAdapterError(
            "CLB_FULL_MAINTENANCE_LISTENER_STATE_INVALID",
            `full-maintenance listener ${phase} state is not exact`,
          );
        }
        consecutive += 1;
      } catch (error) {
        if (
          !(error instanceof VolcengineClbAdapterError)
          || error.code !== "CLB_FULL_MAINTENANCE_LISTENER_PENDING"
        ) throw error;
        consecutive = 0;
      }
      if (consecutive < FULL_MAINTENANCE_LISTENER_STABLE_READS) {
        await this.listenerBarrierSleep(startedAt, `full-maintenance listener ${phase} proof`);
      }
    }
    return this.listenerBarrierReceipt(phase, expectedEnabled, latest!, context);
  }

  private async proveStableListenerState(
    expectedEnabled: boolean,
    phase: FullMaintenanceListenerBarrierPhase,
    context: ReleaseActionContext,
    startedAt = this.clock.now(),
  ): Promise<FullMaintenanceListenerBarrierReceipt> {
    let consecutive = 0;
    let latest: readonly [
      FullMaintenanceListenerObservation,
      FullMaintenanceListenerObservation,
    ] | undefined;
    while (true) {
      try {
        latest = await this.readFullMaintenanceListeners();
        consecutive = latest.every((listener) => listener.enabled === expectedEnabled)
          ? consecutive + 1
          : 0;
        if (consecutive >= FULL_MAINTENANCE_LISTENER_STABLE_READS) {
          return this.listenerBarrierReceipt(phase, expectedEnabled, latest, context);
        }
      } catch (error) {
        if (this.listenerBarrierFatal(error)) throw error;
        consecutive = 0;
      }
      await this.listenerBarrierSleep(startedAt, `full-maintenance listener ${phase} proof`);
    }
  }

  private async setFullMaintenanceListener(
    listenerId: string,
    value: "on" | "off",
  ): Promise<void> {
    await this.callApi(
      "ModifyListenerAttributes",
      this.modifyListenerAttributesApi,
      { ListenerId: listenerId, Enabled: value },
    );
  }

  private async containFullMaintenanceListenersLocked(
    context: ReleaseActionContext,
    phase: "disabled" | "contained" = "contained",
  ): Promise<FullMaintenanceListenerBarrierReceipt> {
    const startedAt = this.clock.now();
    let consecutive = 0;
    let lastError: unknown;
    while (true) {
      try {
        const observed = await this.readFullMaintenanceListeners();
        if (observed.every((listener) => !listener.enabled)) {
          consecutive += 1;
          if (consecutive >= FULL_MAINTENANCE_LISTENER_STABLE_READS) {
            return this.listenerBarrierReceipt(phase, false, observed, context);
          }
        } else {
          consecutive = 0;
          for (const listener of observed) {
            if (!listener.enabled) continue;
            try {
              await this.setFullMaintenanceListener(listener.listenerId, "off");
            } catch (error) {
              lastError ??= error;
            }
          }
        }
      } catch (error) {
        if (this.listenerBarrierFatal(error)) throw error;
        consecutive = 0;
        lastError ??= error;
      }
      try {
        await this.listenerBarrierSleep(startedAt, "full-maintenance listener containment");
      } catch (error) {
        throw new VolcengineClbAdapterError(
          "CLB_FULL_MAINTENANCE_LISTENER_CONTAINMENT_FAILED",
          lastError ?? error,
          undefined,
          true,
        );
      }
    }
  }

  async fullMaintenanceInspectListenerBaseline(
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt> {
    return this.withWeightMutationLock(() => this.assertStableListenerState(
      true,
      "baseline",
      context,
    ));
  }

  async fullMaintenanceDisableListeners(
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt> {
    return this.withWeightMutationLock(async () => {
      let mutationMayHaveOccurred = false;
      try {
        const observed = await this.readFullMaintenanceListeners();
        for (const listener of observed) {
          if (!listener.enabled) continue;
          mutationMayHaveOccurred = true;
          await this.setFullMaintenanceListener(listener.listenerId, "off");
        }
        return await this.proveStableListenerState(false, "disabled", context);
      } catch (error) {
        try {
          await this.containFullMaintenanceListenersLocked(context);
        } catch (containmentError) {
          throw containmentError;
        }
        throw new VolcengineClbAdapterError(
          error instanceof VolcengineClbAdapterError
            ? error.code
            : "CLB_FULL_MAINTENANCE_LISTENER_DISABLE_FAILED",
          error,
          undefined,
          mutationMayHaveOccurred,
        );
      }
    });
  }

  async fullMaintenanceEnableListeners(
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt> {
    return this.withWeightMutationLock(async () => {
      let mutationMayHaveOccurred = false;
      try {
        await this.assertStableListenerState(false, "contained", context);
        for (const listenerId of [
          FULL_MAINTENANCE_HTTP_LISTENER_ID,
          FULL_MAINTENANCE_HTTPS_LISTENER_ID,
        ]) {
          mutationMayHaveOccurred = true;
          await this.setFullMaintenanceListener(listenerId, "on");
        }
        return await this.proveStableListenerState(true, "enabled", context);
      } catch (error) {
        try {
          await this.containFullMaintenanceListenersLocked(context);
        } catch (containmentError) {
          throw containmentError;
        }
        throw new VolcengineClbAdapterError(
          error instanceof VolcengineClbAdapterError
            ? error.code
            : "CLB_FULL_MAINTENANCE_LISTENER_ENABLE_FAILED",
          error,
          undefined,
          mutationMayHaveOccurred,
        );
      }
    });
  }

  private fullMaintenanceHealthyBackends(
    targets: readonly Readonly<{ nodeId: string; weight: number }>[],
    health: ReadonlyMap<string, BackendHealth>,
  ): readonly FullMaintenanceHealthyBackend[] | null {
    if (targets.some(({ nodeId }) => (
      health.get(this.requireTarget(nodeId).serverId) !== "up"
    ))) return null;
    return Object.freeze(
      [...targets]
        .map(({ nodeId, weight }) => Object.freeze({ nodeId, weight, health: "up" as const }))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    );
  }

  private fullMaintenanceBackendHealthReceipt(
    snapshots: readonly [
      FullMaintenanceListenerHealthSnapshot,
      FullMaintenanceListenerHealthSnapshot,
    ],
    context: ReleaseActionContext,
  ): FullMaintenanceBackendHealthReceipt {
    if (!SHA256_HEX_PATTERN.test(context.artifactSha256)) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_RECEIPT_INVALID",
        "backend health context must contain a lowercase artifact SHA-256",
      );
    }
    const operationId = nonEmpty(context.operationId);
    if (!operationId) {
      throw new VolcengineClbAdapterError(
        "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_RECEIPT_INVALID",
        "backend health context must contain an operation id",
      );
    }
    const listenerHealthSnapshots = Object.freeze([
      Object.freeze({
        protocol: "HTTP" as const,
        listenerId: FULL_MAINTENANCE_HTTP_LISTENER_ID,
        backends: Object.freeze([...snapshots[0].backends]),
      }),
      Object.freeze({
        protocol: "HTTPS" as const,
        listenerId: FULL_MAINTENANCE_HTTPS_LISTENER_ID,
        backends: Object.freeze([...snapshots[1].backends]),
      }),
    ]) as FullMaintenanceBackendHealthReceipt["listenerHealthSnapshots"];
    const withoutEvidence = {
      format: "fanjin-full-maintenance-backend-health/v1" as const,
      operationId,
      artifactSha256: context.artifactSha256,
      loadBalancerId: this.config.loadBalancerId,
      serverGroupId: this.config.serverGroupId,
      httpListenerId: FULL_MAINTENANCE_HTTP_LISTENER_ID,
      httpsListenerId: FULL_MAINTENANCE_HTTPS_LISTENER_ID,
      backends: Object.freeze([...listenerHealthSnapshots[0].backends]),
      listenerHealthSnapshots,
      stableReadCount: FULL_MAINTENANCE_BACKEND_HEALTH_STABLE_READS,
    };
    return Object.freeze({
      ...withoutEvidence,
      evidenceSha256: sha256Hex(canonicalJson(withoutEvidence)),
    });
  }

  async fullMaintenanceVerifyEnabledBackendHealth(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceBackendHealthReceipt> {
    const targets = this.exactMaintenanceWeights(expectedWeights);
    return this.withWeightMutationLock(async () => {
      // Establish the all-on/Active barrier before accepting any health row.
      await this.assertStableListenerState(true, "enabled", context);
      const startedAt = this.clock.now();
      let consecutive = 0;
      let latest: readonly [
        FullMaintenanceListenerHealthSnapshot,
        FullMaintenanceListenerHealthSnapshot,
      ] | undefined;

      while (true) {
        const listeners = await this.readFullMaintenanceListeners();
        if (listeners.some((listener) => !listener.enabled || listener.status !== "Active")) {
          throw new VolcengineClbAdapterError(
            "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_LISTENER_INVALID",
            "backend health cannot be proven unless both fixed listeners are on and Active",
          );
        }

        const servers = await this.describeServers();
        if (
          servers.size !== targets.length
          || targets.some(({ nodeId, weight }) => (
            servers.get(this.requireTarget(nodeId).serverId)?.weight !== weight
          ))
        ) {
          throw new VolcengineClbAdapterError(
            "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_WEIGHT_DRIFT",
            "enabled backend health proof found server-group membership or weight drift",
          );
        }

        const httpHealth = await this.describeHealth(servers, {
          listenerId: FULL_MAINTENANCE_HTTP_LISTENER_ID,
          allowMissingWeightedTargets: true,
          rejectUnknownStatus: true,
        });
        const httpsHealth = await this.describeHealth(servers, {
          listenerId: FULL_MAINTENANCE_HTTPS_LISTENER_ID,
          allowMissingWeightedTargets: true,
          rejectUnknownStatus: true,
        });
        const httpBackends = this.fullMaintenanceHealthyBackends(targets, httpHealth);
        const httpsBackends = this.fullMaintenanceHealthyBackends(targets, httpsHealth);
        if (httpBackends && httpsBackends) {
          latest = Object.freeze([
            Object.freeze({
              protocol: "HTTP" as const,
              listenerId: FULL_MAINTENANCE_HTTP_LISTENER_ID,
              backends: httpBackends,
            }),
            Object.freeze({
              protocol: "HTTPS" as const,
              listenerId: FULL_MAINTENANCE_HTTPS_LISTENER_ID,
              backends: httpsBackends,
            }),
          ]);
          consecutive += 1;
          if (consecutive >= FULL_MAINTENANCE_BACKEND_HEALTH_STABLE_READS) {
            return this.fullMaintenanceBackendHealthReceipt(latest, context);
          }
        } else {
          // Empty, partial, or known-down health is a normal propagation delay
          // immediately after re-enabling a listener. Unknown statuses and
          // malformed/foreign rows have already failed closed above.
          consecutive = 0;
        }

        const elapsed = this.clock.now() - startedAt;
        if (elapsed >= this.config.operationTimeoutMs) {
          throw new VolcengineClbAdapterError(
            "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_TIMEOUT",
            "enabled backend health did not converge before timeout",
          );
        }
        const sleep = this.clock.sleep(
          Math.min(this.config.pollIntervalMs, this.config.operationTimeoutMs - elapsed),
        );
        if (this.signal) await raceWithAbort(sleep, this.signal);
        else await sleep;
      }
    });
  }

  async fullMaintenanceContainListeners(
    context: ReleaseActionContext,
  ): Promise<FullMaintenanceListenerBarrierReceipt> {
    return this.withWeightMutationLock(() => this.containFullMaintenanceListenersLocked(context));
  }

  async maintenanceDrainAll(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<void> {
    const targets = this.exactMaintenanceWeights(expectedWeights);
    let productionMutationMayHaveOccurred = false;
    try {
      await this.withWeightMutationLock(async () => {
        const query = this.maintenanceCanaryQuery(context);
        const { gate } = this.requireMaintenanceCanary();
        const canary = await gate.inspect(query);
        this.assertMaintenanceCanaryObservation(canary, query, {
          expectedState: "contained",
          requireProductionZero: false,
          allowUnboundContained: true,
        });
        const before = await this.listBackends(context);
        if (before.some((backend) => (
          backend.health !== "up"
          || backend.weight !== expectedWeights[backend.nodeId]
        ))) {
          throw new VolcengineClbAdapterError(
            "CLB_MAINTENANCE_BASELINE_CHANGED",
            "maintenance drain baseline no longer matches the recorded healthy fleet",
          );
        }
        for (const target of targets) {
          // Mark before the request: a lost response may still mean the cloud
          // accepted the mutation.
          productionMutationMayHaveOccurred = true;
          await this.setWeightLocked(target.nodeId, 0, context, true);
        }
        await this.poll("maintenance CLB full drain", async () => {
          const current = await this.listBackends(context);
          return current.length === targets.length
            && current.every(({ weight }) => weight === 0);
        });
      });
    } catch (error) {
      const code = error instanceof VolcengineClbAdapterError
        ? error.code
        : "CLB_MAINTENANCE_DRAIN_FAILED";
      const message = error instanceof VolcengineClbAdapterError
        ? error.message
        : "maintenance CLB full drain failed";
      throw new VolcengineClbAdapterError(
        code,
        message,
        productionMutationMayHaveOccurred
          || (error instanceof VolcengineClbAdapterError
            && error.productionMutationMayHaveOccurred === true),
      );
    }
  }

  async maintenanceRestoreAll(
    expectedWeights: Readonly<Record<string, number>>,
    canaryPlanDigestSha256: string,
    context: ReleaseActionContext,
  ): Promise<void> {
    const targets = this.exactMaintenanceWeights(expectedWeights);
    await this.withWeightMutationLock(async () => {
      const query = this.maintenanceCanaryQuery(context, canaryPlanDigestSha256) as
        VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string };
      const { gate } = this.requireMaintenanceCanary();
      // Re-containing is deliberately idempotent and stronger than trusting a
      // process-local observation made before a crash or lease handoff.
      const contained = await gate.contain(query);
      this.assertMaintenanceCanaryObservation(contained, query, {
        expectedState: "contained",
        requireProductionZero: true,
      });
      await this.assertProductionAllZero();
      for (const target of targets) {
        await this.setWeightLocked(target.nodeId, target.weight, context, true);
      }
      await this.poll("maintenance CLB full restore", async () => {
        const current = await this.listBackends(context);
        return current.length === targets.length
          && current.every((backend) => (
            backend.weight === expectedWeights[backend.nodeId]
            && backend.health === "up"
          ));
      });
    });
  }

  async maintenanceContainAll(
    expectedWeights: Readonly<Record<string, number>>,
    context: ReleaseActionContext,
  ): Promise<void> {
    const targets = this.exactMaintenanceWeights(expectedWeights);
    await this.withWeightMutationLock(async () => {
      let canaryContainmentError: unknown;
      try {
        const query = this.maintenanceCanaryQuery(context);
        const { gate } = this.requireMaintenanceCanary();
        const canary = await gate.inspect(query);
        if (canary.state === "open") {
          this.assertMaintenanceCanaryObservation(canary, query, {
            expectedState: "open",
            requireProductionZero: false,
          });
          const currentDigest = exactSha256(canary.planDigestSha256, "planDigestSha256");
          const boundQuery = this.maintenanceCanaryQuery(context, currentDigest) as
            VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string };
          const contained = await gate.contain(boundQuery);
          this.assertMaintenanceCanaryObservation(contained, boundQuery, {
            expectedState: "contained",
            requireProductionZero: false,
          });
        } else {
          this.assertMaintenanceCanaryObservation(canary, query, {
            expectedState: "contained",
            requireProductionZero: false,
            allowUnboundContained: true,
          });
        }
      } catch (error) {
        // A gate control-plane outage must not prevent best-effort containment
        // of the independently controlled production server group.
        canaryContainmentError = error;
      }
      // Containment must remain available when health reporting is itself
      // degraded. Exact server-group membership and recorded weights are the
      // only preconditions for removing traffic again.
      const beforeServers = await this.describeServers();
      const before = this.config.targets.map((target) => ({
        nodeId: target.nodeId,
        weight: beforeServers.get(target.serverId)!.weight,
      }));
      if (
        before.length !== targets.length
        || before.some(({ nodeId, weight }) => (
          weight !== 0 && weight !== expectedWeights[nodeId]
        ))
      ) {
        throw new VolcengineClbAdapterError(
          "CLB_MAINTENANCE_CONTAINMENT_DRIFT",
          "maintenance containment found a backend outside zero or its recorded weight",
        );
      }
      for (const target of targets) {
        const current = before.find(({ nodeId }) => nodeId === target.nodeId);
        if (current?.weight !== 0) {
          await this.setWeightLocked(target.nodeId, 0, context, true);
        }
      }
      await this.poll("maintenance CLB fail-closed containment", async () => {
        const current = await this.describeServers();
        return current.size === targets.length
          && targets.every(({ nodeId }) => (
            current.get(this.requireTarget(nodeId).serverId)?.weight === 0
          ));
      });
      if (canaryContainmentError) {
        throw new VolcengineClbAdapterError(
          "CLB_MAINTENANCE_CANARY_CONTAINMENT_FAILED",
          "production backends were contained but the dedicated canary gate could not be proven closed",
        );
      }
    });
  }

  async waitForDrain(nodeId: string, _context: ReleaseActionContext): Promise<DrainResult> {
    const target = this.requireTarget(nodeId);
    await this.assertListenerDrainConfiguration();
    await this.poll(`CLB drain for ${nodeId}`, async () => {
      const server = (await this.describeServers()).get(target.serverId)!;
      return server.weight === 0;
    });
    // This method proves only that weight zero propagated. CLB does not expose
    // per-backend active connections; the application drain counters are the
    // separate, authoritative activation gate.
    return { drained: true };
  }

  async publicSmoke(
    artifact: ReleaseArtifact,
    _context: ReleaseActionContext,
  ): Promise<PublicSmokeResult> {
    if (!this.config.publicSmoke) {
      throw new VolcengineClbAdapterError(
        "CLB_PUBLIC_SMOKE_UNAVAILABLE",
        "containment-only CLB adapter cannot perform public smoke",
      );
    }
    return runCompositePublicSmoke({
      config: this.config.publicSmoke,
      artifact,
      fetchFn: this.fetchFn,
      rawSocketConnector: this.rawSmokeSocketConnector,
      leaseSignal: this.signal,
    });
  }

  private requireTarget(nodeId: string): VolcengineClbTarget {
    const target = this.targetByNodeId.get(nodeId);
    if (!target) {
      throw new VolcengineClbAdapterError("CLB_TARGET_UNKNOWN", `unknown CLB target nodeId: ${nodeId}`);
    }
    return target;
  }

  private async withWeightMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.weightMutationTail;
    let release!: () => void;
    this.weightMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readState(): Promise<ClbState> {
    const [, servers] = await Promise.all([
      this.assertListenerDrainConfiguration(),
      this.describeServers(),
    ]);
    const health = await this.describeHealth(servers);
    return { servers, health };
  }

  private async assertListenerDrainConfiguration(): Promise<void> {
    const result = await this.callApi("DescribeListenerAttributes", this.describeListenerAttributesApi, {
      ListenerId: this.config.listenerId,
    });
    const listenerId = nonEmpty(result.ListenerId);
    if (listenerId && listenerId !== this.config.listenerId) {
      throw new VolcengineClbAdapterError("CLB_LISTENER_UNSAFE", "listener identity mismatch");
    }
    if (nonEmpty(result.LoadBalancerId) !== this.config.loadBalancerId) {
      throw new VolcengineClbAdapterError("CLB_LISTENER_UNSAFE", "listener load balancer identity mismatch");
    }
    const protocol = String(result.Protocol || "").trim().toUpperCase();
    const healthCheck = isRecord(result.HealthCheck) ? result.HealthCheck : null;
    const healthCodes = Array.isArray(healthCheck?.HttpCode)
      ? healthCheck!.HttpCode.map(String)
      : String(healthCheck?.HttpCode || "").split(",");
    const has2xx = healthCodes.some((value) => /(?:^|_)2xx$/i.test(value.trim()));
    if (
      (protocol !== "HTTP" && protocol !== "HTTPS")
      || !healthCheck
      || !enabled(healthCheck.Enabled)
      || String(healthCheck.Method || "").trim().toUpperCase() !== "GET"
      || String(healthCheck.Uri || "").trim() !== "/api/ready"
      || !has2xx
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_HEALTH_CHECK_UNSAFE",
        "CLB listener must use an enabled GET /api/ready HTTP(S) 2xx health check",
      );
    }
    const connectionDrainState = String(result.ConnectionDrainEnabled ?? "")
      .trim()
      .toLowerCase();
    const connectionDrainEnabled = enabled(result.ConnectionDrainEnabled);
    const connectionDrainDisabled = result.ConnectionDrainEnabled === false
      || result.ConnectionDrainEnabled === 0
      || ["off", "false", "disabled", "disable", "0"].includes(connectionDrainState);
    if (!connectionDrainEnabled && !connectionDrainDisabled) {
      throw new VolcengineClbAdapterError(
        "CLB_CONNECTION_DRAIN_UNSAFE",
        "CLB listener returned an unknown connection draining state",
      );
    }
    if (connectionDrainEnabled) {
      const connectionDrainTimeoutSeconds = Number(result.ConnectionDrainTimeout);
      if (
        !Number.isFinite(connectionDrainTimeoutSeconds)
        || connectionDrainTimeoutSeconds * 1_000 < this.config.applicationDrainTimeoutMs
      ) {
        throw new VolcengineClbAdapterError(
          "CLB_CONNECTION_DRAIN_UNSAFE",
          "enabled CLB connection draining must cover the application drain timeout",
        );
      }
    }
    // Classic Volcengine CLB exposes graceful connection termination only for
    // TCP/UDP listeners. HTTP/HTTPS listeners report the field as `off`, so
    // their safe activation gate is: weight-zero propagation followed by two
    // authoritative zero samples from the application's HTTP/SSE/WS counters.
    // rollNode() enforces that ordering before activate() can be called.
  }

  private async describeServers(): Promise<ReadonlyMap<string, ClbServer>> {
    const result = await this.callApi("DescribeServerGroupAttributes", this.describeServerGroupApi, {
      ServerGroupId: this.config.serverGroupId,
    });

    const returnedGroupId = nonEmpty(result.ServerGroupId);
    if (returnedGroupId && returnedGroupId !== this.config.serverGroupId) {
      throw new VolcengineClbAdapterError(
        "CLB_TOPOLOGY_MISMATCH",
        "DescribeServerGroupAttributes returned a different server group",
      );
    }
    if (Array.isArray(result.Listeners)) {
      const listeners = result.Listeners.filter((value): value is string => typeof value === "string");
      if (!listeners.includes(this.config.listenerId)) {
        throw new VolcengineClbAdapterError(
          "CLB_TOPOLOGY_MISMATCH",
          "configured listener is not attached to the configured server group",
        );
      }
    }
    const anyPortEnabled =
      typeof result.AnyPortEnabled === "string"
        ? result.AnyPortEnabled.trim().toLowerCase()
        : result.AnyPortEnabled;
    if (anyPortEnabled === "on" || anyPortEnabled === "true" || anyPortEnabled === true) {
      throw new VolcengineClbAdapterError(
        "CLB_ANY_PORT_UNSUPPORTED",
        "rolling release requires a fixed-port CLB server group so port and description can be preserved",
      );
    }
    if (!Array.isArray(result.Servers)) {
      throw new VolcengineClbAdapterError(
        "CLB_API_INVALID_RESPONSE",
        "DescribeServerGroupAttributes response is missing Servers",
      );
    }

    const servers = new Map<string, ClbServer>();
    for (const raw of result.Servers) {
      const server = parseServer(raw);
      if (!server) {
        throw new VolcengineClbAdapterError(
          "CLB_API_INVALID_RESPONSE",
          "DescribeServerGroupAttributes returned a malformed server",
        );
      }
      if (servers.has(server.serverId)) {
        throw new VolcengineClbAdapterError(
          "CLB_TOPOLOGY_MISMATCH",
          "DescribeServerGroupAttributes returned a duplicate server",
        );
      }
      servers.set(server.serverId, server);
    }
    const configuredServerIds = new Set(this.config.targets.map((target) => target.serverId));
    if (
      servers.size !== configuredServerIds.size ||
      [...servers.keys()].some((serverId) => !configuredServerIds.has(serverId))
    ) {
      throw new VolcengineClbAdapterError(
        "CLB_TOPOLOGY_MISMATCH",
        "configured CLB targets do not exactly match the server group",
      );
    }
    for (const target of this.config.targets) {
      const observed = servers.get(target.serverId);
      if (!observed) {
        throw new VolcengineClbAdapterError(
          "CLB_TOPOLOGY_MISMATCH",
          `configured CLB backend ${target.nodeId} was not found in the server group`,
        );
      }
      if (target.port !== undefined && observed.port !== target.port) {
        throw new VolcengineClbAdapterError(
          "CLB_TOPOLOGY_MISMATCH",
          `configured CLB backend ${target.nodeId} port drifted`,
        );
      }
    }
    return servers;
  }

  private async describeHealth(
    servers: ReadonlyMap<string, ClbServer>,
    options: Readonly<DescribeHealthOptions> = {},
  ): Promise<ReadonlyMap<string, BackendHealth>> {
    const targetServerIds = new Set(this.config.targets.map((target) => target.serverId));
    const health = new Map<string, BackendHealth>();
    const observedTargetIds = new Set<string>();
    let pageNumber = 1;
    let seen = 0;

    for (; pageNumber <= MAX_HEALTH_PAGES; pageNumber += 1) {
      const result = await this.callApi("DescribeListenerHealth", this.describeListenerHealthApi, {
        ListenerId: options.listenerId ?? this.config.listenerId,
        OnlyUnHealthy: false,
        PageNumber: pageNumber,
        PageSize: HEALTH_PAGE_SIZE,
      });
      if (!Array.isArray(result.Results)) {
        throw new VolcengineClbAdapterError(
          "CLB_API_INVALID_RESPONSE",
          "DescribeListenerHealth response is missing Results",
        );
      }

      for (const raw of result.Results) {
        if (!isRecord(raw)) {
          if (options.rejectUnknownStatus) {
            throw new VolcengineClbAdapterError(
              "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_INVALID",
              "listener health returned a malformed result",
            );
          }
          continue;
        }
        const serverId = nonEmpty(raw.ServerId);
        if (!serverId) {
          if (options.rejectUnknownStatus) {
            throw new VolcengineClbAdapterError(
              "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_INVALID",
              "listener health returned a result without a server id",
            );
          }
          continue;
        }
        const groupId = nonEmpty(raw.ServerGroupId);
        if (options.rejectUnknownStatus && groupId !== this.config.serverGroupId) {
          throw new VolcengineClbAdapterError(
            "CLB_TOPOLOGY_MISMATCH",
            "listener health proof returned a target without the exact server group",
          );
        }
        if (targetServerIds.has(serverId) && groupId && groupId !== this.config.serverGroupId) {
          throw new VolcengineClbAdapterError(
            "CLB_TOPOLOGY_MISMATCH",
            "listener health returned a target from a different server group",
          );
        }
        if (groupId && groupId !== this.config.serverGroupId) continue;
        if (!targetServerIds.has(serverId)) {
          throw new VolcengineClbAdapterError(
            "CLB_TOPOLOGY_MISMATCH",
            "listener health returned an unexpected target for the configured server group",
          );
        }
        if (options.rejectUnknownStatus && observedTargetIds.has(serverId)) {
          throw new VolcengineClbAdapterError(
            "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_INVALID",
            "listener health proof returned a duplicate backend",
          );
        }
        observedTargetIds.add(serverId);
        const observedHealth = statusToHealth(raw.Status);
        if (options.rejectUnknownStatus && observedHealth === "unknown") {
          throw new VolcengineClbAdapterError(
            "CLB_FULL_MAINTENANCE_BACKEND_HEALTH_INVALID",
            "listener health returned an unknown backend status",
          );
        }
        health.set(serverId, mergeHealth(health.get(serverId), observedHealth));
      }

      seen += result.Results.length;
      const totalCount = typeof result.TotalCount === "number" ? result.TotalCount : undefined;
      if (result.Results.length === 0 || result.Results.length < HEALTH_PAGE_SIZE) break;
      if (totalCount !== undefined && seen >= totalCount) break;
    }

    if (pageNumber > MAX_HEALTH_PAGES) {
      throw new VolcengineClbAdapterError(
        "CLB_HEALTH_PAGINATION_LIMIT",
        "DescribeListenerHealth exceeded the pagination safety limit",
      );
    }
    const missingWeightedTarget = [...targetServerIds].find((serverId) => {
      if (observedTargetIds.has(serverId)) return false;
      return (servers.get(serverId)?.weight ?? 0) > 0;
    });
    if (missingWeightedTarget && !options.allowMissingWeightedTargets) {
      throw new VolcengineClbAdapterError(
        "CLB_TOPOLOGY_MISMATCH",
        "a weighted CLB target is missing from listener health results",
      );
    }
    for (const target of this.config.targets) health.set(target.serverId, health.get(target.serverId) ?? "unknown");
    return health;
  }

  private async callApi(
    action: string,
    api: ReturnType<Service["createAPI"]>,
    request: JsonRecord,
  ): Promise<JsonRecord> {
    try {
      this.assertNotAborted();
      const response = api(request, {
        Action: action,
        timeout: this.config.apiRequestTimeoutMs,
      });
      const bounded = withRealTimeout(response, this.config.apiRequestTimeoutMs);
      const resolved = this.signal ? await raceWithAbort(bounded, this.signal) : await bounded;
      this.assertNotAborted();
      return unwrapOpenApiResponse(action, resolved);
    } catch (error) {
      if (error instanceof VolcengineClbAdapterError) throw error;
      if (error instanceof ApiRequestTimeoutError) {
        throw new VolcengineClbAdapterError("CLB_API_TIMEOUT", `${action} exceeded its request timeout`);
      }
      throw new VolcengineClbAdapterError("CLB_API_FAILED", `${action} failed: ${redactReleaseErrorMessage(error)}`);
    }
  }

  private async poll(description: string, predicate: () => Promise<boolean>): Promise<void> {
    const startedAt = this.clock.now();
    while (true) {
      this.assertNotAborted();
      if (await predicate()) return;
      const elapsed = this.clock.now() - startedAt;
      if (elapsed >= this.config.operationTimeoutMs) {
        throw new VolcengineClbAdapterError("CLB_POLL_TIMEOUT", `${description} did not converge before timeout`);
      }
      const sleep = this.clock.sleep(
        Math.min(this.config.pollIntervalMs, this.config.operationTimeoutMs - elapsed),
      );
      if (this.signal) await raceWithAbort(sleep, this.signal);
      else await sleep;
    }
  }

  private assertNotAborted(): void {
    if (this.signal?.aborted) {
      throw new VolcengineClbAdapterError("CLB_OPERATION_ABORTED", "CLB operation aborted after release lease loss");
    }
  }
}

export function createVolcengineClbAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Omit<VolcengineClbAdapterOptions, "env"> = {},
): VolcengineClbAdapter {
  return new VolcengineClbAdapter({ ...overrides, env });
}

export { assertCompositePublicSmokeConfiguration };
