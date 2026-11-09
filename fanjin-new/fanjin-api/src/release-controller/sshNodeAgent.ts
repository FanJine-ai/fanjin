import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import {
  RELEASE_FULL_MAINTENANCE_SSH_LOCAL_CHILD_TIMEOUT_MAX_MS,
} from "@/lib/releaseFullMaintenanceSshMutationUncertainty";
import { redactReleaseErrorMessage, ReleaseInvariantError } from "./errors";
import {
  exactReleaseSchemaCompatibility,
  releaseSchemaCompatibilityProofSha256,
  releaseSchemaCompatibilityError,
} from "./schemaCompatibility";
import {
  expectedPreviousSchemaVersion,
  type ReleaseSchemaCompatibilityBridgeV1,
} from "@/lib/releaseSchemaCompatibility";
import type {
  DirectReadinessResult,
  MaintenanceNodeActivationBinding,
  MaintenanceNodeActivationResult,
  MaintenanceNodeAgent,
  MaintenanceNodeContainResult,
  MaintenanceNodeObservation,
  MaintenanceNodeQuiesceResult,
  MaintenanceNodeReceiptSummary,
  MaintenanceNodeState,
  NodeAgent,
  NodeDrainStatus,
  NodeCurrentReleaseIdentity,
  NodePreflightResult,
  NodePreflightPolicy,
  ReleaseActionContext,
  ReleaseArtifact,
  RedisRateLimitCutoverAttestation,
  RedisRateLimitCutoverMarker,
  RedisRateLimitScheduleGuard,
  RedisScheduleGuardObservation,
  ReleaseSchemaMode,
  ReleaseDeploymentMode,
  StageResult,
  WorkerNodeAgent,
  WorkerRedisCutoverObservation,
  WorkerActivationResult,
} from "./types";

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUNTIME_CAPABILITY_PATTERN =
  /^(?=.{1,64}$)[a-z][a-z0-9-]*(?:[._][a-z0-9][a-z0-9-]*)*$/;
const REDIS_RATE_LIMIT_CAPABILITY = "redis-rate-limit-v1";
const REDIS_CUTOVER_MARKER_FORMAT = "fanjin-redis-rate-limit-cutover/v1" as const;
const REDIS_SCHEDULE_GUARD_FORMAT = "fanjin-redis-rate-limit-schedule-guard/v1" as const;
const MAINTENANCE_ACTIVATION_FORMAT = "fanjin-node-maintenance-activation/v1" as const;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const MAX_INVENTORY_NODES = 64;
const MAX_AGENT_RELEASES = 10_000;
const MAX_STAGE_BYTES = 16 * 1024 * 1024 * 1024;

export const DEFAULT_SSH_NODE_INVENTORY_ENV = "FANJIN_RELEASE_SSH_TARGETS";

export interface SshNodeInventoryEntry {
  nodeId: string;
  /** OpenSSH destination, restricted to [user@]DNS/IP. SSH config aliases are not accepted. */
  target: string;
  port: number;
}

export type ArtifactLocalPathResolver = (
  artifact: Readonly<ReleaseArtifact>,
  context: Readonly<ReleaseActionContext>,
) => string | Promise<string>;

export type ReleaseIdResolver = (
  artifact: Readonly<ReleaseArtifact>,
  context: Readonly<ReleaseActionContext>,
) => string | Promise<string>;

export interface ExpectedCurrentRelease {
  releaseId: string;
  artifactSha256: string;
  schemaCompatibility?: ReleaseSchemaCompatibilityBridgeV1 | null;
}

/**
 * Optional durable resolver used after a controller restart. Without this,
 * activation is allowed only when this adapter observed the node in preflight,
 * or when the target release is already current (an idempotent retry).
 */
export type ExpectedCurrentReleaseResolver = (
  nodeId: string,
  artifact: Readonly<ReleaseArtifact>,
  context: Readonly<ReleaseActionContext>,
) => ExpectedCurrentRelease | null | Promise<ExpectedCurrentRelease | null>;

export interface SshNodeAgentTimeouts {
  statusMs: number;
  stageMs: number;
  activateMs: number;
  rollbackMs: number;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SshNodeAgentOptions {
  /** Trusted server-side inventory. Browser/deployment inputs must never populate this value. */
  inventory: string | readonly SshNodeInventoryEntry[];
  artifactLocalPathResolver: ArtifactLocalPathResolver;
  releaseIdResolver?: ReleaseIdResolver;
  expectedCurrentReleaseResolver?: ExpectedCurrentReleaseResolver;
  sshBinary?: string;
  identityFile?: string;
  knownHostsFile?: string;
  connectTimeoutSeconds?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  timeouts?: Partial<SshNodeAgentTimeouts>;
  signal?: AbortSignal;
  signalResolver?: (context: Readonly<ReleaseActionContext>) => AbortSignal | undefined;
  /** Test seam. Production callers should not override the process launcher. */
  spawnProcess?: SpawnProcess;
}

interface AgentEnvelope extends Record<string, unknown> {
  ok: boolean;
  agentSchemaVersion: 1;
  action?: string | null;
}

interface ReleaseDescriptor {
  releaseId: string;
  artifactSha256: string;
  sourceCommit?: string;
  schemaMode?: string;
  schemaVersion?: number;
  schemaCompatibilityProofSha256?: string;
  deploymentMode?: ReleaseDeploymentMode;
  imageDigest?: string | null;
}

interface StatusSnapshot {
  ok: boolean;
  current: ReleaseDescriptor | null;
  previousReleaseId: string | null;
  releasesById: ReadonlyMap<string, ReleaseDescriptor>;
  redisRuntimeFingerprint: string | null;
  agentSurfaceFingerprint: string | null;
  runtimeCapabilities: readonly string[] | null;
  redisRateLimitCutover: RedisRateLimitCutoverAttestation | null;
  redisRateLimitCutoverMarker: RedisRateLimitCutoverMarker | null;
  readiness: {
    ready: boolean;
    matchesArtifact: boolean;
    artifactSha256: string | null;
    sourceCommit: string | null;
    schemaVersion: number | null;
    deploymentMode: ReleaseDeploymentMode;
    imageDigest: string | null;
    agentSurfaceFingerprint: string | null;
    releaseIdentityMatchesManifest: boolean;
    redisRuntimeFingerprint: string | null;
    runtimeCapabilities: readonly string[] | null;
    redisRateLimitCutover: RedisRateLimitCutoverAttestation | null;
    redisRateLimitCutoverMarker: RedisRateLimitCutoverMarker | null;
  } | null;
  errorCode?: string;
}

interface CommandResult {
  exitCode: number | null;
  envelope: AgentEnvelope;
}

interface PreflightIdentity extends ExpectedCurrentRelease {
  operationId: string;
}

const DEFAULT_TIMEOUTS: SshNodeAgentTimeouts = {
  // Container status independently re-verifies cosign, RepoDigest and the
  // live container. The fixed Node Agent can legitimately spend four minutes
  // across those bounded operations, so keep an audited transport margin.
  statusMs: 10 * 60_000,
  // Full production artifacts contain tens of thousands of dependency files.
  // The node agent safely extracts, hashes, compares and hardens every member;
  // a 15-minute ceiling is too short on a single-vCPU production node. A
  // container stage also performs a separately bounded image pull after the
  // archive stream/extraction, so the controller ceiling must cover both.
  stageMs: 4 * 60 * 60_000,
  // The Node Agent permits a 30-minute Compose wait plus fixed cosign/image/
  // container inspections. Forty-five minutes is the reviewed outer bound.
  activateMs: 45 * 60_000,
  rollbackMs: 45 * 60_000,
};

const PRODUCTION_TIMEOUT_BOUNDS: Readonly<
  Record<keyof SshNodeAgentTimeouts, readonly [number, number]>
> = {
  statusMs: [5 * 60_000, 60 * 60_000],
  stageMs: [2 * 60 * 60_000, 6 * 60 * 60_000],
  activateMs: [40 * 60_000, RELEASE_FULL_MAINTENANCE_SSH_LOCAL_CHILD_TIMEOUT_MAX_MS],
  rollbackMs: [40 * 60_000, RELEASE_FULL_MAINTENANCE_SSH_LOCAL_CHILD_TIMEOUT_MAX_MS],
};

const PRODUCTION_TIMEOUT_ENV: Readonly<Record<keyof SshNodeAgentTimeouts, string>> = {
  statusMs: "FANJIN_RELEASE_SSH_STATUS_TIMEOUT_MS",
  stageMs: "FANJIN_RELEASE_SSH_STAGE_TIMEOUT_MS",
  activateMs: "FANJIN_RELEASE_SSH_ACTIVATE_TIMEOUT_MS",
  rollbackMs: "FANJIN_RELEASE_SSH_ROLLBACK_TIMEOUT_MS",
};

/**
 * Production entrypoints require explicit audited SSH outer deadlines. This
 * prevents a Controller transport timer from expiring while the fixed Node
 * Agent is still inside one of its own valid, bounded container operations.
 */
export function loadProductionSshNodeAgentTimeouts(
  environment: NodeJS.ProcessEnv,
): SshNodeAgentTimeouts {
  const result = {} as SshNodeAgentTimeouts;
  for (const key of Object.keys(PRODUCTION_TIMEOUT_ENV) as Array<keyof SshNodeAgentTimeouts>) {
    const name = PRODUCTION_TIMEOUT_ENV[key];
    const raw = String(environment[name] || "").trim();
    const [minimum, maximum] = PRODUCTION_TIMEOUT_BOUNDS[key];
    if (!/^[1-9][0-9]*$/.test(raw)) {
      fail("SSH_CONFIGURATION_INVALID", `${name} 必须是显式的十进制毫秒值`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      fail("SSH_CONFIGURATION_INVALID", `${name} 超出受审计的生产范围`);
    }
    result[key] = value;
  }
  return result;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeCode(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && ERROR_CODE_PATTERN.test(value) ? value : fallback;
  return raw.replace(/[.-]/g, "_").toUpperCase().slice(0, 64);
}

function nullableSafeTimestamp(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 不是安全的 Redis 时间戳`);
  }
  return Number(value);
}

function parseRuntimeCapabilities(value: unknown, field: string): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 64) {
    fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 不是受限数组`);
  }
  const capabilities = value.map((entry) => {
    if (typeof entry !== "string" || !RUNTIME_CAPABILITY_PATTERN.test(entry)) {
      fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 包含无效 capability`);
    }
    return entry;
  }).sort();
  if (new Set(capabilities).size !== capabilities.length) {
    fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 包含重复 capability`);
  }
  return capabilities;
}

function parseRedisRateLimitCutover(
  value: unknown,
  field: string,
): RedisRateLimitCutoverAttestation | null {
  if (value === undefined || value === null) return null;
  const cutover = objectValue(value);
  if (!cutover
    || typeof cutover.valid !== "boolean"
    || typeof cutover.active !== "boolean"
    || ![null, "unarmed", "scheduled", "active"].includes(cutover.state as never)
    || (cutover.contractMatched !== null && typeof cutover.contractMatched !== "boolean")
    || (cutover.errorCode !== null
      && (typeof cutover.errorCode !== "string" || !ERROR_CODE_PATTERN.test(cutover.errorCode)))) {
    fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 结构无效`);
  }
  const parsed: RedisRateLimitCutoverAttestation = {
    valid: cutover.valid,
    state: cutover.state as RedisRateLimitCutoverAttestation["state"],
    active: cutover.active,
    contractMatched: cutover.contractMatched as boolean | null,
    cutoverAtMs: nullableSafeTimestamp(cutover.cutoverAtMs, `${field}.cutoverAtMs`),
    scheduledAtRedisMs: nullableSafeTimestamp(
      cutover.scheduledAtRedisMs,
      `${field}.scheduledAtRedisMs`,
    ),
    activatedAtRedisMs: nullableSafeTimestamp(
      cutover.activatedAtRedisMs,
      `${field}.activatedAtRedisMs`,
    ),
    redisServerTimeMs: nullableSafeTimestamp(
      cutover.redisServerTimeMs,
      `${field}.redisServerTimeMs`,
    ),
    errorCode: cutover.errorCode as string | null,
  };
  if (!parsed.valid) {
    if (parsed.errorCode === null) {
      fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 无效态自相矛盾`);
    }
    if (parsed.state === null) {
      if (parsed.active) {
        fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 无效态自相矛盾`);
      }
    } else if (parsed.state === "unarmed") {
      if (parsed.active
        || parsed.cutoverAtMs !== null
        || parsed.scheduledAtRedisMs !== null
        || parsed.activatedAtRedisMs !== null) {
        fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 无效 unarmed 状态自相矛盾`);
      }
    } else if (parsed.state === "scheduled") {
      if (parsed.active
        || parsed.cutoverAtMs === null
        || parsed.scheduledAtRedisMs === null
        || parsed.scheduledAtRedisMs >= parsed.cutoverAtMs
        || parsed.activatedAtRedisMs !== null) {
        fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 无效 scheduled 状态自相矛盾`);
      }
    } else if (!parsed.active
      || parsed.cutoverAtMs === null
      || parsed.scheduledAtRedisMs === null
      || parsed.activatedAtRedisMs === null
      || parsed.scheduledAtRedisMs >= parsed.cutoverAtMs
      || parsed.activatedAtRedisMs < parsed.cutoverAtMs) {
      fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 无效 active 状态自相矛盾`);
    }
  } else if (parsed.state === "unarmed") {
    if (parsed.active
      || parsed.cutoverAtMs !== null
      || parsed.scheduledAtRedisMs !== null
      || parsed.activatedAtRedisMs !== null
      || parsed.errorCode !== null) {
      fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} unarmed 状态自相矛盾`);
    }
  } else if (parsed.state === "scheduled") {
    if (parsed.active
      || parsed.cutoverAtMs === null
      || parsed.scheduledAtRedisMs === null
      || parsed.scheduledAtRedisMs >= parsed.cutoverAtMs
      || parsed.activatedAtRedisMs !== null
      || parsed.contractMatched === null
      || parsed.errorCode !== null) {
      fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} scheduled 状态自相矛盾`);
    }
  } else if (parsed.state === "active") {
    if (!parsed.active
      || parsed.cutoverAtMs === null
      || parsed.scheduledAtRedisMs === null
      || parsed.activatedAtRedisMs === null
      || parsed.scheduledAtRedisMs >= parsed.cutoverAtMs
      || parsed.activatedAtRedisMs < parsed.cutoverAtMs
      || parsed.contractMatched === null
      || parsed.errorCode !== null) {
      fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} active 状态自相矛盾`);
    }
  } else {
    fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} valid 状态缺失`);
  }
  return parsed;
}

function parseRedisRateLimitCutoverMarker(
  value: unknown,
  field: string,
): RedisRateLimitCutoverMarker | null {
  if (value === undefined || value === null) return null;
  const marker = objectValue(value);
  const allowed = new Set(["format", "cutoverAtMs", "redisRuntimeFingerprint"]);
  if (!marker
    || Object.keys(marker).some((key) => !allowed.has(key))
    || marker.format !== REDIS_CUTOVER_MARKER_FORMAT) {
    fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 格式无效`);
  }
  const cutoverAtMs = nullableSafeTimestamp(marker.cutoverAtMs, `${field}.cutoverAtMs`);
  if (cutoverAtMs === null || cutoverAtMs < 1) {
    fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field}.cutoverAtMs 无效`);
  }
  return {
    format: REDIS_CUTOVER_MARKER_FORMAT,
    cutoverAtMs,
    redisRuntimeFingerprint: validateSha256(
      marker.redisRuntimeFingerprint,
      `${field}.redisRuntimeFingerprint`,
    ),
  };
}

function validateRedisCutoverExpectation(value: unknown): RedisRateLimitCutoverMarker {
  const marker = objectValue(value);
  const allowed = new Set(["format", "cutoverAtMs", "redisRuntimeFingerprint"]);
  if (!marker
    || Object.keys(marker).some((key) => !allowed.has(key))
    || marker.format !== REDIS_CUTOVER_MARKER_FORMAT
    || !Number.isSafeInteger(marker.cutoverAtMs)
    || Number(marker.cutoverAtMs) < 1) {
    fail("REDIS_CUTOVER_MARKER_INVALID", "Redis cutover marker 期望值无效");
  }
  return {
    format: REDIS_CUTOVER_MARKER_FORMAT,
    cutoverAtMs: Number(marker.cutoverAtMs),
    redisRuntimeFingerprint: validateSha256(
      marker.redisRuntimeFingerprint,
      "expected.redisRuntimeFingerprint",
    ),
  };
}

function validateRedisScheduleGuardExpectation(value: unknown): RedisRateLimitScheduleGuard {
  const guard = objectValue(value);
  const allowed = new Set(["format", "cutoverAtMs", "redisRuntimeFingerprint"]);
  if (!guard
    || Object.keys(guard).some((key) => !allowed.has(key))
    || guard.format !== REDIS_SCHEDULE_GUARD_FORMAT
    || !Number.isSafeInteger(guard.cutoverAtMs)
    || Number(guard.cutoverAtMs) < 1) {
    fail("REDIS_SCHEDULE_GUARD_INVALID", "Redis schedule guard 期望值无效");
  }
  return {
    format: REDIS_SCHEDULE_GUARD_FORMAT,
    cutoverAtMs: Number(guard.cutoverAtMs),
    redisRuntimeFingerprint: validateSha256(
      guard.redisRuntimeFingerprint,
      "expected.redisRuntimeFingerprint",
    ),
  };
}

function parseRedisScheduleGuard(value: unknown, field: string): RedisRateLimitScheduleGuard {
  const guard = objectValue(value);
  if (!guard) fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${field} 格式无效`);
  return validateRedisScheduleGuardExpectation(guard);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(code: string, message: string): never {
  throw new SshNodeAgentError(code, message);
}

function assertSafeConfigPath(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    fail("SSH_CONFIG_PATH_INVALID", `${label} 必须是无控制字符的绝对路径`);
  }
  return value;
}

function assertBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("SSH_CONFIGURATION_INVALID", `${label} 配置无效`);
  }
  return value;
}

function validHost(host: string): boolean {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(unwrapped)) return host === unwrapped || isIP(unwrapped) === 6;
  if (host.length > 253 || host.endsWith(".")) return false;
  const labels = host.split(".");
  return labels.length > 0 && labels.every((label) => DNS_LABEL_PATTERN.test(label));
}

function validateTarget(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 320 || /[\0\s]/.test(value)) {
    fail("SSH_INVENTORY_INVALID", "SSH target 格式无效");
  }
  const separator = value.lastIndexOf("@");
  if (separator !== value.indexOf("@")) {
    fail("SSH_INVENTORY_INVALID", "SSH target 只能包含一个 @");
  }
  const user = separator >= 0 ? value.slice(0, separator) : null;
  const host = separator >= 0 ? value.slice(separator + 1) : value;
  if ((user !== null && !SSH_USER_PATTERN.test(user)) || !validHost(host)) {
    fail("SSH_INVENTORY_INVALID", "SSH target 必须是受限的 [user@]DNS/IP");
  }
  return value;
}

function validateInventoryEntry(value: unknown, index: number): SshNodeInventoryEntry {
  const entry = objectValue(value);
  if (!entry) fail("SSH_INVENTORY_INVALID", `SSH 节点清单第 ${index + 1} 项无效`);
  const allowed = new Set(["nodeId", "target", "port"]);
  if (Object.keys(entry).some((key) => !allowed.has(key))) {
    fail("SSH_INVENTORY_INVALID", `SSH 节点清单第 ${index + 1} 项包含未知字段`);
  }
  if (typeof entry.nodeId !== "string" || !NODE_ID_PATTERN.test(entry.nodeId)) {
    fail("SSH_INVENTORY_INVALID", `SSH 节点清单第 ${index + 1} 项 nodeId 无效`);
  }
  return {
    nodeId: entry.nodeId,
    target: validateTarget(entry.target),
    port: assertBoundedInteger(entry.port ?? 22, "SSH port", 1, 65_535),
  };
}

/** Parse a trusted server-side JSON inventory. Arbitrary SSH options are never accepted. */
export function parseSshNodeInventory(value: string | readonly SshNodeInventoryEntry[]): SshNodeInventoryEntry[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) fail("SSH_INVENTORY_MISSING", "SSH 节点清单尚未配置");
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      fail("SSH_INVENTORY_INVALID", "SSH 节点清单不是有效 JSON");
    }
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_INVENTORY_NODES) {
    fail("SSH_INVENTORY_INVALID", "SSH 节点清单数量无效");
  }
  const entries = parsed.map(validateInventoryEntry);
  const nodeIds = new Set<string>();
  const destinations = new Set<string>();
  for (const entry of entries) {
    const destination = `${entry.target}\0${entry.port}`;
    if (nodeIds.has(entry.nodeId) || destinations.has(destination)) {
      fail("SSH_INVENTORY_DUPLICATE", "SSH 节点清单包含重复节点或目标");
    }
    nodeIds.add(entry.nodeId);
    destinations.add(destination);
  }
  return entries;
}

export function loadSshNodeInventoryFromEnv(
  env: Record<string, string | undefined> = process.env,
  variableName = DEFAULT_SSH_NODE_INVENTORY_ENV,
): SshNodeInventoryEntry[] {
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(variableName)) {
    fail("SSH_INVENTORY_ENV_INVALID", "SSH 节点清单环境变量名无效");
  }
  return parseSshNodeInventory(String(env[variableName] || ""));
}

function validateSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("RELEASE_SHA256_INVALID", `${label} 必须是小写 SHA-256`);
  }
  return value;
}

function validateReleaseId(value: unknown, label = "releaseId"): string {
  if (typeof value !== "string" || !RELEASE_ID_PATTERN.test(value)) {
    fail("RELEASE_ID_INVALID", `${label} 格式无效`);
  }
  return value;
}

function validateContext(context: Readonly<ReleaseActionContext>, artifactSha256?: string): void {
  if (
    !context
    || typeof context.operationId !== "string"
    || !OPERATION_ID_PATTERN.test(context.operationId)
  ) {
    fail("RELEASE_CONTEXT_INVALID", "发布操作上下文无效");
  }
  if (typeof context.actionId !== "string" || !context.actionId.trim()) {
    fail("RELEASE_CONTEXT_INVALID", "发布动作上下文无效");
  }
  const contextSha = validateSha256(context.artifactSha256, "context.artifactSha256");
  if (artifactSha256 !== undefined && contextSha !== artifactSha256) {
    fail("RELEASE_CONTEXT_SHA_MISMATCH", "发布上下文与制品 SHA-256 不一致");
  }
}

function exactObjectKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    fail("SSH_AGENT_RESPONSE_INVALID", `${label} 字段集合无效`);
  }
}

function validateMaintenanceBinding(
  value: Readonly<MaintenanceNodeActivationBinding>,
  context: Readonly<ReleaseActionContext>,
): MaintenanceNodeActivationBinding {
  const input = objectValue(value);
  if (!input) fail("MAINTENANCE_NODE_BINDING_INVALID", "维护节点激活绑定不是对象");
  const expectedKeys = [
    "expectedCurrentArtifactSha256",
    "expectedCurrentReleaseId",
    "nodeId",
    "role",
    "targetArtifactSha256",
    "targetDeploymentMode",
    "targetImageDigest",
    "targetReleaseId",
    "targetSchemaVersion",
    "targetSourceCommit",
  ];
  const actualKeys = Object.keys(input).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail("MAINTENANCE_NODE_BINDING_INVALID", "维护节点激活绑定字段集合无效");
  }
  if (typeof input.nodeId !== "string" || !NODE_ID_PATTERN.test(input.nodeId)) {
    fail("SSH_NODE_ID_INVALID", "维护节点 ID 格式无效");
  }
  if (input.role !== "api" && input.role !== "worker") {
    fail("MAINTENANCE_NODE_BINDING_INVALID", "维护节点角色无效");
  }
  const expectedCurrentReleaseId = validateReleaseId(
    input.expectedCurrentReleaseId,
    "maintenance.expectedCurrentReleaseId",
  );
  const targetReleaseId = validateReleaseId(
    input.targetReleaseId,
    "maintenance.targetReleaseId",
  );
  if (expectedCurrentReleaseId === targetReleaseId) {
    fail("MAINTENANCE_NODE_BINDING_INVALID", "维护目标版本必须与当前版本不同");
  }
  const expectedCurrentArtifactSha256 = validateSha256(
    input.expectedCurrentArtifactSha256,
    "maintenance.expectedCurrentArtifactSha256",
  );
  const targetArtifactSha256 = validateSha256(
    input.targetArtifactSha256,
    "maintenance.targetArtifactSha256",
  );
  if (typeof input.targetSourceCommit !== "string"
    || !SOURCE_COMMIT_PATTERN.test(input.targetSourceCommit)) {
    fail("MAINTENANCE_NODE_BINDING_INVALID", "维护目标 sourceCommit 无效");
  }
  if (!Number.isSafeInteger(input.targetSchemaVersion)
    || Number(input.targetSchemaVersion) < 0) {
    fail("MAINTENANCE_NODE_BINDING_INVALID", "维护目标 schemaVersion 无效");
  }
  const targetImageDigest = input.targetImageDigest;
  if ((input.targetDeploymentMode !== "archive-systemd"
      && input.targetDeploymentMode !== "container-image")
    || (input.targetDeploymentMode === "archive-systemd" && targetImageDigest !== null)
    || (input.targetDeploymentMode === "container-image"
      && (typeof targetImageDigest !== "string"
        || !/^sha256:[0-9a-f]{64}$/.test(targetImageDigest)))) {
    fail("MAINTENANCE_NODE_BINDING_INVALID", "维护目标 deployment identity 无效");
  }
  const contextObject = objectValue(context);
  if (!contextObject) fail("RELEASE_CONTEXT_INVALID", "维护发布上下文无效");
  const contextKeys = Object.keys(contextObject).sort();
  const expectedContextKeys = ["actionId", "artifactSha256", "operationId"];
  if (contextKeys.length !== expectedContextKeys.length
    || contextKeys.some((key, index) => key !== expectedContextKeys[index])) {
    fail("RELEASE_CONTEXT_INVALID", "维护发布上下文字段集合无效");
  }
  validateContext(context, targetArtifactSha256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(context.actionId)) {
    fail("RELEASE_CONTEXT_INVALID", "维护发布 actionId 无效");
  }
  return {
    nodeId: input.nodeId,
    role: input.role,
    expectedCurrentReleaseId,
    expectedCurrentArtifactSha256,
    targetReleaseId,
    targetArtifactSha256,
    targetSourceCommit: input.targetSourceCommit,
    targetSchemaVersion: Number(input.targetSchemaVersion),
    targetDeploymentMode: input.targetDeploymentMode,
    targetImageDigest: targetImageDigest as string | null,
  };
}

function maintenanceRequestIdentity(binding: Readonly<MaintenanceNodeActivationBinding>): string {
  return JSON.stringify([
    binding.nodeId,
    binding.role,
    binding.expectedCurrentReleaseId,
    binding.expectedCurrentArtifactSha256,
    binding.targetReleaseId,
    binding.targetArtifactSha256,
    binding.targetSourceCommit,
    binding.targetSchemaVersion,
    binding.targetDeploymentMode,
    binding.targetImageDigest,
  ]);
}

function parseMaintenanceSummary<State extends MaintenanceNodeState>(
  value: unknown,
  binding: Readonly<MaintenanceNodeActivationBinding>,
  operationId: string,
  expectedState: State,
): MaintenanceNodeReceiptSummary & { state: State } {
  const summary = objectValue(value);
  if (!summary) fail("SSH_AGENT_RESPONSE_INVALID", "节点端维护 receipt summary 不是对象");
  exactObjectKeys(summary, [
    "bindingSha256",
    "expectedCurrentArtifactSha256",
    "expectedCurrentReleaseId",
    "format",
    "nodeId",
    "operationId",
    "role",
    "state",
    "targetArtifactSha256",
    "targetDeploymentMode",
    "targetImageDigest",
    "targetReleaseId",
    "targetSchemaVersion",
  ], "节点端维护 receipt summary");
  if (summary.format !== MAINTENANCE_ACTIVATION_FORMAT
    || summary.operationId !== operationId
    || summary.nodeId !== binding.nodeId
    || summary.role !== binding.role
    || summary.state !== expectedState
    || summary.expectedCurrentReleaseId !== binding.expectedCurrentReleaseId
    || summary.expectedCurrentArtifactSha256 !== binding.expectedCurrentArtifactSha256
    || summary.targetReleaseId !== binding.targetReleaseId
    || summary.targetArtifactSha256 !== binding.targetArtifactSha256
    || summary.targetSchemaVersion !== binding.targetSchemaVersion
    || summary.targetDeploymentMode !== binding.targetDeploymentMode
    || summary.targetImageDigest !== binding.targetImageDigest) {
    fail("MAINTENANCE_NODE_BINDING_MISMATCH", "节点端维护 receipt summary 与请求绑定不一致");
  }
  const bindingSha256 = validateSha256(
    summary.bindingSha256,
    "maintenance.bindingSha256",
  );
  return {
    format: MAINTENANCE_ACTIVATION_FORMAT,
    operationId,
    nodeId: binding.nodeId,
    role: binding.role,
    state: expectedState,
    expectedCurrentReleaseId: binding.expectedCurrentReleaseId,
    expectedCurrentArtifactSha256: binding.expectedCurrentArtifactSha256,
    targetReleaseId: binding.targetReleaseId,
    targetArtifactSha256: binding.targetArtifactSha256,
    targetSchemaVersion: binding.targetSchemaVersion,
    targetDeploymentMode: binding.targetDeploymentMode,
    targetImageDigest: binding.targetImageDigest,
    bindingSha256,
  };
}

function parseMaintenanceObservation(
  response: Record<string, unknown>,
  binding: Readonly<MaintenanceNodeActivationBinding>,
  operationId: string,
): MaintenanceNodeObservation {
  exactObjectKeys(response, [
    "action",
    "agentSchemaVersion",
    "current",
    "maintenance",
    "ok",
    "processStopped",
  ], "节点端 maintenance-status envelope");
  if (response.action !== "maintenance-status" || typeof response.processStopped !== "boolean") {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端 maintenance-status 响应无效");
  }
  const current = descriptor(response.current, "maintenance-status.current");
  const isPrevious = current.releaseId === binding.expectedCurrentReleaseId
    && current.artifactSha256 === binding.expectedCurrentArtifactSha256;
  const isTarget = current.releaseId === binding.targetReleaseId
    && current.artifactSha256 === binding.targetArtifactSha256
    && current.sourceCommit === binding.targetSourceCommit
    && current.schemaVersion === binding.targetSchemaVersion
    && current.deploymentMode === binding.targetDeploymentMode
    && current.imageDigest === binding.targetImageDigest;
  if (!isPrevious && !isTarget) {
    fail(
      "MAINTENANCE_NODE_CURRENT_IDENTITY_INVALID",
      "节点端维护 current 身份既不是精确 previous 也不是精确 target",
    );
  }
  const summary = objectValue(response.maintenance);
  const state = summary?.state;
  let maintenance: MaintenanceNodeReceiptSummary | null = null;
  if (response.maintenance === null) {
    if (!isPrevious) {
      fail(
        "MAINTENANCE_NODE_STATE_IDENTITY_CONFLICT",
        "无维护 authority 时 current 必须是精确 previous",
      );
    }
  } else {
    if (
      state !== "quiescing"
      && state !== "quiesced"
      && state !== "activation-attempted"
      && state !== "consumed"
    ) {
      fail("MAINTENANCE_NODE_STATE_INVALID", "节点端维护状态不受信");
    }
    maintenance = parseMaintenanceSummary(
      response.maintenance,
      binding,
      operationId,
      state,
    );
  }
  if (
    (maintenance !== null
      && (state === "quiescing" || state === "quiesced")
      && !isPrevious)
    || (state === "consumed" && !isTarget)
  ) {
    fail(
      "MAINTENANCE_NODE_STATE_IDENTITY_CONFLICT",
      "节点端维护状态与 current 身份冲突",
    );
  }
  return {
    processStopped: response.processStopped,
    maintenance,
    current: {
      nodeId: binding.nodeId,
      releaseId: current.releaseId,
      artifactSha256: current.artifactSha256,
      schemaMode:
        current.schemaMode === "schema-neutral" || current.schemaMode === "migration"
          ? current.schemaMode
          : null,
      schemaVersion: current.schemaVersion ?? null,
      deploymentMode: current.deploymentMode ?? "archive-systemd",
      imageDigest: current.imageDigest ?? null,
    },
  };
}

function parseMaintenanceReadiness(
  value: unknown,
  binding: Readonly<MaintenanceNodeActivationBinding>,
  operationId: string,
): MaintenanceNodeActivationResult["readiness"] {
  const readiness = objectValue(value);
  if (!readiness
    || readiness.ready !== true
    || readiness.matchesArtifact !== true
    || readiness.artifactSha256 !== binding.targetArtifactSha256) {
    fail("MAINTENANCE_TARGET_READINESS_MISMATCH", "维护激活未证明目标制品 ready");
  }
  if (readiness.releaseId !== undefined && readiness.releaseId !== binding.targetReleaseId) {
    fail("MAINTENANCE_TARGET_READINESS_MISMATCH", "维护激活 readiness releaseId 漂移");
  }
  for (const field of ["schemaVersion", "targetSchemaVersion", "observedDatabaseSchemaVersion"] as const) {
    if (readiness[field] !== undefined && readiness[field] !== binding.targetSchemaVersion) {
      fail("MAINTENANCE_TARGET_READINESS_MISMATCH", `维护激活 readiness ${field} 漂移`);
    }
  }
  if (readiness.sourceCommit !== undefined
    && readiness.sourceCommit !== binding.targetSourceCommit) {
    fail("MAINTENANCE_TARGET_READINESS_MISMATCH", "维护激活 readiness sourceCommit 漂移");
  }
  if (binding.role === "api") {
    if (readiness.sourceCommit !== binding.targetSourceCommit
      || readiness.schemaVersion !== binding.targetSchemaVersion) {
      fail("MAINTENANCE_TARGET_READINESS_MISMATCH", "API 维护激活 readiness 身份不完整");
    }
    return {
      ready: true,
      role: "api",
      releaseId: binding.targetReleaseId,
      artifactSha256: binding.targetArtifactSha256,
      sourceCommit: binding.targetSourceCommit,
      schemaVersion: binding.targetSchemaVersion,
      deploymentMode: binding.targetDeploymentMode,
      imageDigest: binding.targetImageDigest,
    };
  }
  if (readiness.releaseId !== binding.targetReleaseId
    || readiness.nodeId !== binding.nodeId
    || readiness.targetSchemaVersion !== binding.targetSchemaVersion
    || readiness.observedDatabaseSchemaVersion !== binding.targetSchemaVersion
    || readiness.schemaRuntimeMode !== "isolated"
    || readiness.state !== "drained"
    || readiness.acceptingWork !== false
    || readiness.activeTaskCount !== 0
    || readiness.drainOperationId !== operationId
    || readiness.fresh !== true
    || readiness.isolated !== true) {
    fail("MAINTENANCE_TARGET_READINESS_MISMATCH", "Worker 维护激活 readiness 未保持精确隔离态");
  }
  return {
    ready: true,
    role: "worker",
    isolated: true,
    acceptingWork: false,
    activeTaskCount: 0,
    drainOperationId: operationId,
    releaseId: binding.targetReleaseId,
    artifactSha256: binding.targetArtifactSha256,
    sourceCommit: binding.targetSourceCommit,
    schemaVersion: binding.targetSchemaVersion,
    deploymentMode: binding.targetDeploymentMode,
    imageDigest: binding.targetImageDigest,
  };
}

function drainCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("SSH_AGENT_RESPONSE_INVALID", `节点端 ${label} 计数无效`);
  }
  return Number(value);
}

function parseDrainStatus(
  envelope: AgentEnvelope,
  operationId: string,
  expectedDraining?: boolean,
): NodeDrainStatus {
  const envelopeKeys = Object.keys(envelope).sort();
  const expectedEnvelopeKeys = ["action", "agentSchemaVersion", "drain", "ok"];
  if (envelopeKeys.length !== expectedEnvelopeKeys.length
    || envelopeKeys.some((key, index) => key !== expectedEnvelopeKeys[index])) {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端排空响应 envelope 结构无效");
  }
  const drain = objectValue(envelope.drain);
  const drainKeys = drain ? Object.keys(drain).sort() : [];
  const expectedDrainKeys = [
    "authoritative",
    "draining",
    "httpInflight",
    "operationId",
    "realtimeWsConnections",
    "socketIoConnections",
    "sseConnections",
    "total",
  ];
  if (!drain
    || drainKeys.length !== expectedDrainKeys.length
    || drainKeys.some((key, index) => key !== expectedDrainKeys[index])) {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端排空响应 drain 结构无效");
  }
  if (drain.authoritative !== false || drain.operationId !== operationId) {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端排空响应身份无效");
  }
  if (typeof drain.draining !== "boolean") {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端排空状态无效");
  }
  if (expectedDraining !== undefined && drain.draining !== expectedDraining) {
    fail("SSH_AGENT_DRAIN_TRANSITION_FAILED", "节点端排空状态转换未生效");
  }
  const httpInflight = drainCount(drain.httpInflight, "httpInflight");
  const sseConnections = drainCount(drain.sseConnections, "sseConnections");
  const socketIoConnections = drainCount(drain.socketIoConnections, "socketIoConnections");
  const realtimeWsConnections = drainCount(drain.realtimeWsConnections, "realtimeWsConnections");
  const totalConnections = drainCount(drain.total, "total");
  if (
    totalConnections
    !== httpInflight + sseConnections + socketIoConnections + realtimeWsConnections
  ) {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端排空连接总数不一致");
  }
  return {
    draining: drain.draining,
    httpInflight,
    sseConnections,
    socketIoConnections,
    realtimeWsConnections,
    totalConnections,
  };
}

function descriptor(value: unknown, label: string): ReleaseDescriptor {
  const item = objectValue(value);
  if (!item) fail("SSH_AGENT_RESPONSE_INVALID", `${label} 不是对象`);
  if (item.valid !== undefined && item.valid !== true) {
    fail("SSH_AGENT_RELEASE_INVALID", `${label} 未通过节点端校验`);
  }
  const result: ReleaseDescriptor = {
    releaseId: validateReleaseId(item.releaseId, `${label}.releaseId`),
    artifactSha256: validateSha256(item.artifactSha256, `${label}.artifactSha256`),
  };
  const deploymentMode = item.deploymentMode === undefined
    ? "archive-systemd"
    : item.deploymentMode;
  const imageDigest: string | null = item.imageDigest === undefined || item.imageDigest === null
    ? null
    : typeof item.imageDigest === "string"
      ? item.imageDigest
      : fail("SSH_AGENT_RESPONSE_INVALID", `${label}.imageDigest 无效`);
  if (
    (deploymentMode !== "archive-systemd" && deploymentMode !== "container-image")
    || (deploymentMode === "archive-systemd" && imageDigest !== null)
    || (deploymentMode === "container-image"
      && (typeof imageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)))
  ) {
    fail("SSH_AGENT_RESPONSE_INVALID", `${label}.deployment identity 无效`);
  }
  result.deploymentMode = deploymentMode;
  result.imageDigest = imageDigest;
  if (item.sourceCommit !== undefined) {
    if (typeof item.sourceCommit !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.sourceCommit)) {
      fail("SSH_AGENT_RESPONSE_INVALID", `${label}.sourceCommit 无效`);
    }
    result.sourceCommit = item.sourceCommit;
  }
  if (item.schemaMode !== undefined) {
    if (item.schemaMode !== "schema-neutral" && item.schemaMode !== "migration") {
      fail("SSH_AGENT_RESPONSE_INVALID", `${label}.schemaMode 无效`);
    }
    result.schemaMode = item.schemaMode;
  }
  if (item.schemaVersion !== undefined) {
    if (!Number.isSafeInteger(item.schemaVersion) || Number(item.schemaVersion) < 0) {
      fail("SSH_AGENT_RESPONSE_INVALID", `${label}.schemaVersion 无效`);
    }
    result.schemaVersion = Number(item.schemaVersion);
  }
  if (item.schemaCompatibilityProofSha256 !== undefined) {
    if (
      typeof item.schemaCompatibilityProofSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(item.schemaCompatibilityProofSha256)
    ) {
      fail(
        "SSH_AGENT_RESPONSE_INVALID",
        `${label}.schemaCompatibilityProofSha256 无效`,
      );
    }
    result.schemaCompatibilityProofSha256 =
      item.schemaCompatibilityProofSha256;
  }
  return result;
}

function sameDescriptor(left: ReleaseDescriptor, right: ReleaseDescriptor): boolean {
  return left.releaseId === right.releaseId
    && left.artifactSha256 === right.artifactSha256
    && left.sourceCommit === right.sourceCommit
    && left.schemaVersion === right.schemaVersion
    && left.schemaMode === right.schemaMode
    && (left.deploymentMode ?? "archive-systemd")
      === (right.deploymentMode ?? "archive-systemd")
    && (left.imageDigest ?? null) === (right.imageDigest ?? null)
    && left.schemaCompatibilityProofSha256 === right.schemaCompatibilityProofSha256;
}

function artifactDeploymentIdentity(artifact: ReleaseArtifact): {
  deploymentMode: ReleaseDeploymentMode;
  imageDigest: string | null;
} {
  const deployment = artifact.deployment;
  const deploymentMode = deployment ? "container-image" : "archive-systemd";
  const imageDigest = deployment?.imageDigest ?? null;
  if (
    (artifact.deploymentMode !== undefined && artifact.deploymentMode !== deploymentMode)
    || (artifact.imageDigest !== undefined && artifact.imageDigest !== imageDigest)
    || (deployment && (
      deployment.format !== "fanjin-container-deployment/v1"
      || deployment.mode !== "container-image"
      || !/^sha256:[0-9a-f]{64}$/.test(deployment.imageDigest)
      || !deployment.image.endsWith(`@${deployment.imageDigest}`)
      || deployment.platform.os !== "linux"
      || deployment.platform.architecture !== "amd64"
      || deployment.signature.type !== "cosign"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deployment.signature.keyId)
    ))
  ) {
    fail("RELEASE_ARTIFACT_DEPLOYMENT_INVALID", "发布制品容器部署身份无效");
  }
  return { deploymentMode, imageDigest };
}

function parseAgentEnvelope(raw: Buffer): AgentEnvelope {
  const text = raw.toString("utf8").trim();
  if (!text || text.includes("\n") || text.includes("\r") || text.includes("\uFFFD")) {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端必须返回单行 UTF-8 JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端返回的 JSON 无效");
  }
  const envelope = objectValue(parsed);
  if (!envelope || typeof envelope.ok !== "boolean" || envelope.agentSchemaVersion !== 1) {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端响应协议版本或结果字段无效");
  }
  if (envelope.action !== undefined && envelope.action !== null && typeof envelope.action !== "string") {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端响应 action 无效");
  }
  return envelope as AgentEnvelope;
}

function parseStatus(envelope: AgentEnvelope, expectedNodeId: string): StatusSnapshot {
  if (envelope.action !== "status") {
    fail("SSH_AGENT_ACTION_MISMATCH", "节点端 status 响应动作不匹配");
  }
  if (typeof envelope.nodeId !== "string" || !NODE_ID_PATTERN.test(envelope.nodeId)) {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端 status 缺少受信 nodeId");
  }
  if (envelope.nodeId !== expectedNodeId) {
    fail("SSH_NODE_IDENTITY_MISMATCH", `SSH 目标返回的 nodeId 与受信清单不一致`);
  }
  const releasesValue = envelope.releases;
  if (!Array.isArray(releasesValue) || releasesValue.length > MAX_AGENT_RELEASES) {
    fail("SSH_AGENT_RESPONSE_INVALID", "节点端 releases 清单无效");
  }
  const releasesById = new Map<string, ReleaseDescriptor>();
  for (const [index, value] of releasesValue.entries()) {
    const item = objectValue(value);
    if (!item) fail("SSH_AGENT_RESPONSE_INVALID", `releases[${index}] 无效`);
    const releaseId = validateReleaseId(item.releaseId, `releases[${index}].releaseId`);
    if (releasesById.has(releaseId)) {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 releases 清单包含重复 releaseId");
    }
    if (item.valid === true) releasesById.set(releaseId, descriptor(item, `releases[${index}]`));
    else if (item.valid !== false) fail("SSH_AGENT_RESPONSE_INVALID", `releases[${index}].valid 无效`);
  }

  let current: ReleaseDescriptor | null = null;
  if (envelope.current !== null && envelope.current !== undefined) {
    current = descriptor(envelope.current, "current");
    const listed = releasesById.get(current.releaseId);
    if (!listed || !sameDescriptor(current, listed)) {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 current 与 releases 清单不一致");
    }
  }

  let previousReleaseId: string | null = null;
  if (envelope.previous !== null && envelope.previous !== undefined) {
    previousReleaseId = validateReleaseId(envelope.previous, "previous");
  }

  let readiness: StatusSnapshot["readiness"] = null;
  if (envelope.readiness !== null && envelope.readiness !== undefined) {
    const value = objectValue(envelope.readiness);
    if (!value || typeof value.ready !== "boolean" || typeof value.matchesArtifact !== "boolean") {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 readiness 响应无效");
    }
    const artifactSha256 = value.artifactSha256 === null || value.artifactSha256 === undefined
      ? null
      : validateSha256(value.artifactSha256, "readiness.artifactSha256");
    const sourceCommit = value.sourceCommit === null || value.sourceCommit === undefined
      ? null
      : typeof value.sourceCommit === "string"
        && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.sourceCommit)
        ? value.sourceCommit
        : fail("SSH_AGENT_RESPONSE_INVALID", "readiness.sourceCommit 无效");
    const schemaVersion = value.schemaVersion === null || value.schemaVersion === undefined
      ? null
      : Number.isSafeInteger(value.schemaVersion) && Number(value.schemaVersion) >= 0
        ? Number(value.schemaVersion)
        : fail("SSH_AGENT_RESPONSE_INVALID", "readiness.schemaVersion 无效");
    const deploymentMode = value.deploymentMode === undefined
      ? "archive-systemd"
      : value.deploymentMode;
    const imageDigest: string | null = value.imageDigest === undefined || value.imageDigest === null
      ? null
      : typeof value.imageDigest === "string"
        ? value.imageDigest
        : fail("SSH_AGENT_RESPONSE_INVALID", "readiness.imageDigest 无效");
    if (
      (deploymentMode !== "archive-systemd" && deploymentMode !== "container-image")
      || (deploymentMode === "archive-systemd" && imageDigest !== null)
      || (deploymentMode === "container-image"
        && (typeof imageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)))
    ) {
      fail("SSH_AGENT_RESPONSE_INVALID", "readiness deployment identity 无效");
    }
    const agentSurfaceFingerprint = value.agentSurfaceFingerprint === null
      || value.agentSurfaceFingerprint === undefined
      ? null
      : validateSha256(value.agentSurfaceFingerprint, "readiness.agentSurfaceFingerprint");
    if (typeof value.releaseIdentityMatchesManifest !== "boolean") {
      fail("SSH_AGENT_RESPONSE_INVALID", "readiness.releaseIdentityMatchesManifest 无效");
    }
    const redisRuntimeFingerprint = value.redisRuntimeFingerprint === undefined
      || value.redisRuntimeFingerprint === null
      ? null
      : validateSha256(value.redisRuntimeFingerprint, "readiness.redisRuntimeFingerprint");
    if (value.runtimeCapabilitiesPresent !== undefined
      && typeof value.runtimeCapabilitiesPresent !== "boolean") {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 readiness.runtimeCapabilitiesPresent 无效");
    }
    if (value.redisRateLimitCutoverPresent !== undefined
      && typeof value.redisRateLimitCutoverPresent !== "boolean") {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 readiness.redisRateLimitCutoverPresent 无效");
    }
    const runtimeCapabilities = value.runtimeCapabilitiesPresent === false
      ? null
      : parseRuntimeCapabilities(value.runtimeCapabilities, "readiness.runtimeCapabilities");
    const redisRateLimitCutover = value.redisRateLimitCutoverPresent === false
      ? null
      : parseRedisRateLimitCutover(
        value.redisRateLimitCutover,
        "readiness.redisRateLimitCutover",
      );
    const redisRateLimitCutoverMarker = parseRedisRateLimitCutoverMarker(
      value.redisRateLimitCutoverMarker,
      "readiness.redisRateLimitCutoverMarker",
    );
    readiness = {
      ready: value.ready,
      matchesArtifact: value.matchesArtifact,
      artifactSha256,
      sourceCommit,
      schemaVersion,
      deploymentMode,
      imageDigest,
      agentSurfaceFingerprint,
      releaseIdentityMatchesManifest: value.releaseIdentityMatchesManifest,
      redisRuntimeFingerprint,
      runtimeCapabilities,
      redisRateLimitCutover,
      redisRateLimitCutoverMarker,
    };
  }

  const agentRedisRuntimeFingerprint = envelope.redisRuntimeFingerprint === undefined
    || envelope.redisRuntimeFingerprint === null
    ? null
    : validateSha256(envelope.redisRuntimeFingerprint, "redisRuntimeFingerprint");
  const agentSurfaceFingerprint = envelope.agentSurfaceFingerprint === undefined
    || envelope.agentSurfaceFingerprint === null
    ? null
    : validateSha256(envelope.agentSurfaceFingerprint, "agentSurfaceFingerprint");
  if (
    agentSurfaceFingerprint
    && readiness?.agentSurfaceFingerprint
    && agentSurfaceFingerprint !== readiness.agentSurfaceFingerprint
  ) {
    fail(
      "AGENT_SURFACE_FINGERPRINT_ATTESTATION_MISMATCH",
      "节点端共享环境与应用 Agent 配置指纹不一致",
    );
  }
  if (
    agentRedisRuntimeFingerprint
    && readiness?.redisRuntimeFingerprint
    && agentRedisRuntimeFingerprint !== readiness.redisRuntimeFingerprint
  ) {
    fail(
      "REDIS_RUNTIME_FINGERPRINT_ATTESTATION_MISMATCH",
      "节点端共享环境指纹与应用 readiness 指纹不一致",
    );
  }
  const runtimeCapabilities = parseRuntimeCapabilities(
    envelope.runtimeCapabilities,
    "runtimeCapabilities",
  );
  const redisRateLimitCutover = parseRedisRateLimitCutover(
    envelope.redisRateLimitCutover,
    "redisRateLimitCutover",
  );
  const redisRateLimitCutoverMarker = parseRedisRateLimitCutoverMarker(
    envelope.redisRateLimitCutoverMarker,
    "redisRateLimitCutoverMarker",
  );
  if (readiness?.runtimeCapabilities
    && runtimeCapabilities
    && !sameJson(readiness.runtimeCapabilities, runtimeCapabilities)) {
    fail(
      "RUNTIME_CAPABILITY_ATTESTATION_MISMATCH",
      "节点端应用 capability 与制品 capability 不一致",
    );
  }
  if (readiness?.redisRateLimitCutover
    && redisRateLimitCutover
    && !sameJson(readiness.redisRateLimitCutover, redisRateLimitCutover)) {
    fail("REDIS_CUTOVER_ATTESTATION_MISMATCH", "节点端 Redis cutover 状态透传不一致");
  }
  if (readiness?.redisRateLimitCutoverMarker
    && redisRateLimitCutoverMarker
    && !sameJson(readiness.redisRateLimitCutoverMarker, redisRateLimitCutoverMarker)) {
    fail("REDIS_CUTOVER_MARKER_ATTESTATION_MISMATCH", "节点端 Redis cutover marker 透传不一致");
  }
  if (current && readiness && (
    readiness.deploymentMode !== (current.deploymentMode ?? "archive-systemd")
    || readiness.imageDigest !== (current.imageDigest ?? null)
  )) {
    fail(
      "NODE_DEPLOYMENT_IDENTITY_ATTESTATION_MISMATCH",
      "节点应用 readiness 与发布指针的部署身份不一致",
    );
  }

  const error = objectValue(envelope.error);
  return {
    ok: envelope.ok,
    current,
    previousReleaseId,
    releasesById,
    redisRuntimeFingerprint: agentRedisRuntimeFingerprint
      || readiness?.redisRuntimeFingerprint
      || null,
    agentSurfaceFingerprint: agentSurfaceFingerprint
      || readiness?.agentSurfaceFingerprint
      || null,
    runtimeCapabilities: runtimeCapabilities || readiness?.runtimeCapabilities || null,
    redisRateLimitCutover: redisRateLimitCutover || readiness?.redisRateLimitCutover || null,
    redisRateLimitCutoverMarker: redisRateLimitCutoverMarker
      || readiness?.redisRateLimitCutoverMarker
      || null,
    readiness,
    ...(error ? { errorCode: safeCode(error.code, "NODE_STATUS_FAILED") } : {}),
  };
}

function errorFromEnvelope(envelope: AgentEnvelope, nodeId: string): never {
  const remote = objectValue(envelope.error);
  const code = safeCode(remote?.code, "SSH_AGENT_REJECTED");
  const detail = remote?.message === undefined
    ? "节点端拒绝了发布动作"
    : redactReleaseErrorMessage(remote.message);
  fail(code, `节点 ${nodeId} 发布动作失败：${detail}`);
}

function minimalSshEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SSH_AUTH_SOCK"] as const;
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined && !/[\0\r\n]/.test(value)) result[key] = value;
  }
  return result;
}

export class SshNodeAgentError extends ReleaseInvariantError {
  constructor(code: string, message: string) {
    super(safeCode(code, "SSH_NODE_AGENT_FAILED"), redactReleaseErrorMessage(message));
    this.name = "SshNodeAgentError";
  }
}

export class SshNodeAgent implements NodeAgent, MaintenanceNodeAgent {
  private readonly nodes: ReadonlyMap<string, SshNodeInventoryEntry>;
  private readonly artifactLocalPathResolver: ArtifactLocalPathResolver;
  private readonly releaseIdResolver: ReleaseIdResolver;
  private readonly expectedCurrentReleaseResolver?: ExpectedCurrentReleaseResolver;
  private readonly sshBinary: string;
  private readonly identityFile?: string;
  private readonly knownHostsFile?: string;
  private readonly connectTimeoutSeconds: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly timeouts: SshNodeAgentTimeouts;
  private readonly signal?: AbortSignal;
  private readonly signalResolver?: SshNodeAgentOptions["signalResolver"];
  private readonly spawnProcess: SpawnProcess;
  private readonly preflightIdentities = new Map<string, PreflightIdentity>();
  private readonly readinessExpectedSha = new Map<string, string>();
  private readonly releaseIdsByNodeSha = new Map<string, Map<string, string>>();
  private readonly maintenanceRequests = new Map<string, string>();
  private readonly maintenanceReceiptBindings = new Map<string, string>();

  constructor(options: SshNodeAgentOptions) {
    if (!options || typeof options.artifactLocalPathResolver !== "function") {
      fail("SSH_CONFIGURATION_INVALID", "必须配置受信的本地制品路径解析器");
    }
    const inventory = parseSshNodeInventory(options.inventory);
    this.nodes = new Map(inventory.map((entry) => [entry.nodeId, entry]));
    this.artifactLocalPathResolver = options.artifactLocalPathResolver;
    this.releaseIdResolver = options.releaseIdResolver || ((artifact) => artifact.version);
    this.expectedCurrentReleaseResolver = options.expectedCurrentReleaseResolver;
    this.sshBinary = options.sshBinary || "ssh";
    if (!this.sshBinary || /[\0\r\n]/.test(this.sshBinary)) {
      fail("SSH_CONFIGURATION_INVALID", "sshBinary 配置无效");
    }
    this.identityFile = assertSafeConfigPath(options.identityFile, "identityFile");
    this.knownHostsFile = assertSafeConfigPath(options.knownHostsFile, "knownHostsFile");
    this.connectTimeoutSeconds = assertBoundedInteger(
      options.connectTimeoutSeconds ?? 10,
      "connectTimeoutSeconds",
      1,
      120,
    );
    this.maxStdoutBytes = assertBoundedInteger(
      options.maxStdoutBytes ?? 512 * 1024,
      "maxStdoutBytes",
      1024,
      16 * 1024 * 1024,
    );
    this.maxStderrBytes = assertBoundedInteger(
      options.maxStderrBytes ?? 128 * 1024,
      "maxStderrBytes",
      1024,
      16 * 1024 * 1024,
    );
    this.timeouts = {
      statusMs: assertBoundedInteger(options.timeouts?.statusMs ?? DEFAULT_TIMEOUTS.statusMs, "statusMs", 100, 60 * 60_000),
      stageMs: assertBoundedInteger(options.timeouts?.stageMs ?? DEFAULT_TIMEOUTS.stageMs, "stageMs", 100, 6 * 60 * 60_000),
      activateMs: assertBoundedInteger(options.timeouts?.activateMs ?? DEFAULT_TIMEOUTS.activateMs, "activateMs", 100, 2 * 60 * 60_000),
      rollbackMs: assertBoundedInteger(options.timeouts?.rollbackMs ?? DEFAULT_TIMEOUTS.rollbackMs, "rollbackMs", 100, 2 * 60 * 60_000),
    };
    this.signal = options.signal;
    this.signalResolver = options.signalResolver;
    this.spawnProcess = options.spawnProcess || ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  }

  async preflight(
    nodeId: string,
    artifact: ReleaseArtifact,
    schemaMode: ReleaseSchemaMode,
    context: ReleaseActionContext,
    policy: Readonly<NodePreflightPolicy> = {},
  ): Promise<NodePreflightResult> {
    const artifactSha256 = this.validateArtifact(artifact, context);
    const deploymentIdentity = artifactDeploymentIdentity(artifact);
    if (typeof policy.allowTargetCurrent !== "undefined"
      && typeof policy.allowTargetCurrent !== "boolean") {
      fail("RELEASE_PREFLIGHT_POLICY_INVALID", "节点预检当前版本策略无效");
    }
    if (artifact.schemaMode && artifact.schemaMode !== schemaMode) {
      return {
        ok: false,
        currentArtifactSha256: "",
        code: "ARTIFACT_SCHEMA_MODE_MISMATCH",
      };
    }
    const schemaCompatibility = artifact.schemaCompatibility
      ?? (schemaMode === "schema-neutral"
        ? exactReleaseSchemaCompatibility(artifact.schemaVersion)
        : null);
    if (
      releaseSchemaCompatibilityError(
        schemaMode,
        artifact.schemaVersion,
        schemaCompatibility,
      )
    ) {
      return {
        ok: false,
        currentArtifactSha256: "",
        code: "ARTIFACT_SCHEMA_COMPATIBILITY_INVALID",
      };
    }
    const status = await this.status(nodeId, context);
    if (!status.current) {
      return { ok: false, currentArtifactSha256: "", code: "NODE_CURRENT_RELEASE_MISSING" };
    }
    this.rememberStatus(nodeId, status);
    if (
      !status.ok
      || !status.readiness?.ready
      || !status.readiness.matchesArtifact
      || status.readiness.artifactSha256 !== status.current.artifactSha256
    ) {
      return {
        ok: false,
        currentArtifactSha256: status.current.artifactSha256,
        code: status.errorCode || "NODE_CURRENT_RELEASE_NOT_READY",
      };
    }
    if (status.current.schemaMode
      && status.current.schemaMode !== "schema-neutral") {
      return {
        ok: false,
        currentArtifactSha256: status.current.artifactSha256,
        code: "NODE_CURRENT_SCHEMA_MODE_UNSAFE",
      };
    }
    let expectedCurrent: ExpectedCurrentRelease | null = null;
    if (this.expectedCurrentReleaseResolver) {
      expectedCurrent = await this.expectedCurrentReleaseResolver(nodeId, artifact, context);
      if (expectedCurrent) {
        expectedCurrent = {
          releaseId: validateReleaseId(expectedCurrent.releaseId, "expectedCurrent.releaseId"),
          artifactSha256: validateSha256(
            expectedCurrent.artifactSha256,
            "expectedCurrent.artifactSha256",
          ),
          schemaCompatibility: expectedCurrent.schemaCompatibility ?? null,
        };
      }
    }
    const targetReleaseId = policy.allowTargetCurrent
      ? await this.resolveReleaseId(artifact, context)
      : null;
    const currentIsExpectedPrevious = expectedCurrent !== null
      && status.current.releaseId === expectedCurrent.releaseId
      && status.current.artifactSha256 === expectedCurrent.artifactSha256;
    const currentIsExactTarget = policy.allowTargetCurrent === true
      && status.current.releaseId === targetReleaseId
      && status.current.artifactSha256 === artifactSha256
      && (status.current.deploymentMode ?? "archive-systemd")
        === deploymentIdentity.deploymentMode
      && (status.current.imageDigest ?? null) === deploymentIdentity.imageDigest;
    if (expectedCurrent && !currentIsExpectedPrevious && !currentIsExactTarget) {
      return {
        ok: false,
        currentArtifactSha256: status.current.artifactSha256,
        code: "NODE_CURRENT_RELEASE_CONFLICT",
      };
    }
    if (!expectedCurrent && policy.allowTargetCurrent && !currentIsExactTarget) {
      return {
        ok: false,
        currentArtifactSha256: status.current.artifactSha256,
        code: "NODE_CURRENT_RELEASE_CONFLICT",
      };
    }
    let expectedSchemaVersion: number;
    try {
      expectedSchemaVersion = currentIsExactTarget
        ? artifact.schemaVersion
        : expectedPreviousSchemaVersion({
          targetSchemaVersion: artifact.schemaVersion,
          targetArtifactSha256: artifact.sha256,
          bridge: expectedCurrent?.schemaCompatibility,
        });
    } catch {
      return {
        ok: false,
        currentArtifactSha256: status.current.artifactSha256,
        code: "NODE_SCHEMA_COMPATIBILITY_INVALID",
      };
    }
    if (!currentIsExactTarget && expectedCurrent?.schemaCompatibility && (
      expectedCurrent.schemaCompatibility.previous.releaseId !== expectedCurrent.releaseId
      || expectedCurrent.schemaCompatibility.previous.artifactSha256
        !== expectedCurrent.artifactSha256
    )) {
      return {
        ok: false,
        currentArtifactSha256: status.current.artifactSha256,
        code: "NODE_SCHEMA_COMPATIBILITY_IDENTITY_MISMATCH",
      };
    }
    if (status.current.schemaVersion !== expectedSchemaVersion) {
      return {
        ok: false,
        currentArtifactSha256: status.current.artifactSha256,
        code: "NODE_SCHEMA_VERSION_MISMATCH",
      };
    }
    this.preflightIdentities.set(nodeId, {
      operationId: context.operationId,
      releaseId: status.current.releaseId,
      artifactSha256: status.current.artifactSha256,
    });
    this.readinessExpectedSha.set(nodeId, artifactSha256);
    return {
      ok: true,
      currentArtifactSha256: status.current.artifactSha256,
      ...(status.redisRuntimeFingerprint
        ? { redisRuntimeFingerprint: status.redisRuntimeFingerprint }
        : {}),
      ...(status.runtimeCapabilities
        ? { runtimeCapabilities: status.runtimeCapabilities }
        : {}),
      ...(status.redisRateLimitCutover !== null
        ? { redisRateLimitCutover: status.redisRateLimitCutover }
        : {}),
      ...(status.redisRateLimitCutoverMarker !== null
        ? { redisRateLimitCutoverMarker: status.redisRateLimitCutoverMarker }
        : {}),
    };
  }

  async stage(
    nodeId: string,
    artifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<StageResult> {
    const artifactSha256 = this.validateArtifact(artifact, context);
    const deploymentIdentity = artifactDeploymentIdentity(artifact);
    const releaseId = await this.resolveReleaseId(artifact, context);
    const localPath = await this.resolveArtifactPath(artifact, context);
    const stats = await lstat(localPath).catch(() => null);
    if (!stats || !stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_STAGE_BYTES) {
      fail("RELEASE_ARTIFACT_FILE_INVALID", "本地发布制品必须是受限大小的普通文件");
    }
    const response = await this.invoke(
      nodeId,
      `stage ${releaseId} ${artifactSha256} ${stats.size}`,
      "stage",
      this.timeouts.stageMs,
      context,
      localPath,
    );
    const staged = descriptor(response.release, "stage.release");
    if (
      staged.releaseId !== releaseId
      || staged.artifactSha256 !== artifactSha256
      || staged.schemaVersion !== artifact.schemaVersion
      || (staged.deploymentMode ?? "archive-systemd")
        !== deploymentIdentity.deploymentMode
      || (staged.imageDigest ?? null) !== deploymentIdentity.imageDigest
    ) {
      fail("STAGED_ARTIFACT_SHA_MISMATCH", `节点 ${nodeId} 返回的暂存制品身份不匹配`);
    }
    this.rememberRelease(nodeId, staged);
    return {
      artifactSha256: staged.artifactSha256,
      ...deploymentIdentity,
    };
  }

  async beginDrain(
    nodeId: string,
    expectedCurrentArtifactSha256: string,
    context: ReleaseActionContext,
  ): Promise<NodeDrainStatus> {
    validateContext(context);
    const expectedSha = validateSha256(
      expectedCurrentArtifactSha256,
      "expectedCurrentArtifactSha256",
    );
    const response = await this.invoke(
      nodeId,
      `begin-drain ${context.operationId} ${expectedSha}`,
      "begin-drain",
      this.timeouts.statusMs,
      context,
    );
    return parseDrainStatus(response, context.operationId, true);
  }

  async drainStatus(
    nodeId: string,
    expectedCurrentArtifactSha256: string,
    context: ReleaseActionContext,
  ): Promise<NodeDrainStatus> {
    validateContext(context);
    const expectedSha = validateSha256(
      expectedCurrentArtifactSha256,
      "expectedCurrentArtifactSha256",
    );
    const response = await this.invoke(
      nodeId,
      `drain-status ${context.operationId} ${expectedSha}`,
      "drain-status",
      this.timeouts.statusMs,
      context,
    );
    return parseDrainStatus(response, context.operationId);
  }

  async cancelDrain(
    nodeId: string,
    expectedCurrentArtifactSha256: string,
    context: ReleaseActionContext,
  ): Promise<NodeDrainStatus> {
    validateContext(context);
    const expectedSha = validateSha256(
      expectedCurrentArtifactSha256,
      "expectedCurrentArtifactSha256",
    );
    const response = await this.invoke(
      nodeId,
      `cancel-drain ${context.operationId} ${expectedSha}`,
      "cancel-drain",
      this.timeouts.statusMs,
      context,
    );
    return parseDrainStatus(response, context.operationId, false);
  }

  async activate(
    nodeId: string,
    artifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<void> {
    const artifactSha256 = this.validateArtifact(artifact, context);
    const deploymentIdentity = artifactDeploymentIdentity(artifact);
    const releaseId = await this.resolveReleaseId(artifact, context);
    const status = await this.status(nodeId, context);
    if (!status.current) fail("NODE_CURRENT_RELEASE_MISSING", `节点 ${nodeId} 缺少当前版本指针`);
    this.rememberStatus(nodeId, status);

    let expected: ExpectedCurrentRelease | null = null;
    if (status.current.releaseId === releaseId
      && status.current.artifactSha256 === artifactSha256
      && (status.current.deploymentMode ?? "archive-systemd")
        === deploymentIdentity.deploymentMode
      && (status.current.imageDigest ?? null) === deploymentIdentity.imageDigest) {
      // Controller may have crashed after the atomic switch. Repeating activate
      // is safe only when the exact target identity is already current.
      expected = status.current;
    } else {
      const cached = this.preflightIdentities.get(nodeId);
      if (cached?.operationId === context.operationId) expected = cached;
      else if (this.expectedCurrentReleaseResolver) {
        expected = await this.expectedCurrentReleaseResolver(nodeId, artifact, context);
        if (expected) {
          expected = {
            releaseId: validateReleaseId(expected.releaseId, "expectedCurrent.releaseId"),
            artifactSha256: validateSha256(expected.artifactSha256, "expectedCurrent.artifactSha256"),
          };
        }
      }
      if (!expected) {
        fail("NODE_PREFLIGHT_IDENTITY_MISSING", `节点 ${nodeId} 缺少可验证的预检版本身份`);
      }
      if (
        status.current.releaseId !== expected.releaseId
        || status.current.artifactSha256 !== expected.artifactSha256
      ) {
        fail("NODE_CURRENT_RELEASE_CONFLICT", `节点 ${nodeId} 当前版本已偏离预检快照`);
      }
    }

    const response = await this.invoke(
      nodeId,
      `activate ${releaseId} ${artifactSha256} ${expected.releaseId}`,
      "activate",
      this.timeouts.activateMs,
      context,
    );
    const current = descriptor(response.current, "activate.current");
    if (
      current.releaseId !== releaseId
      || current.artifactSha256 !== artifactSha256
      || current.schemaVersion !== artifact.schemaVersion
      || (current.deploymentMode ?? "archive-systemd")
        !== deploymentIdentity.deploymentMode
      || (current.imageDigest ?? null) !== deploymentIdentity.imageDigest
    ) {
      fail("ACTIVE_ARTIFACT_SHA_MISMATCH", `节点 ${nodeId} 激活响应与目标制品不一致`);
    }
    this.rememberRelease(nodeId, current);
    this.readinessExpectedSha.set(nodeId, artifactSha256);
  }

  async observeMaintenance(
    rawBinding: Readonly<MaintenanceNodeActivationBinding>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceNodeObservation> {
    const binding = validateMaintenanceBinding(rawBinding, context);
    const cacheKey = this.rememberMaintenanceRequest(binding, context.operationId);
    const response = await this.invoke(
      binding.nodeId,
      `maintenance-status ${context.operationId} ${binding.expectedCurrentReleaseId} ${binding.expectedCurrentArtifactSha256} ${binding.targetReleaseId} ${binding.targetArtifactSha256}`,
      "maintenance-status",
      this.timeouts.statusMs,
      context,
    );
    const observation = parseMaintenanceObservation(response, binding, context.operationId);
    if (observation.maintenance !== null) {
      this.rememberMaintenanceReceiptBinding(
        cacheKey,
        observation.maintenance.bindingSha256,
      );
    }
    return observation;
  }

  async maintenanceContain(
    rawBinding: Readonly<MaintenanceNodeActivationBinding>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceNodeContainResult> {
    const binding = validateMaintenanceBinding(rawBinding, context);
    const cacheKey = this.rememberMaintenanceRequest(binding, context.operationId);
    const response = await this.invoke(
      binding.nodeId,
      `maintenance-contain ${context.operationId} ${binding.expectedCurrentReleaseId} ${binding.expectedCurrentArtifactSha256} ${binding.targetReleaseId} ${binding.targetArtifactSha256}`,
      "maintenance-contain",
      this.timeouts.activateMs,
      context,
    );
    exactObjectKeys(response, [
      "action",
      "agentSchemaVersion",
      "current",
      "idempotent",
      "maintenance",
      "ok",
      "processStopped",
    ], "节点端 maintenance-contain envelope");
    if (
      response.action !== "maintenance-contain"
      || typeof response.idempotent !== "boolean"
      || response.processStopped !== true
      || response.maintenance === null
    ) {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 maintenance-contain 响应无效");
    }
    const observation = parseMaintenanceObservation({
      action: "maintenance-status",
      agentSchemaVersion: response.agentSchemaVersion,
      current: response.current,
      maintenance: response.maintenance,
      ok: response.ok,
      processStopped: response.processStopped,
    }, binding, context.operationId);
    if (observation.maintenance === null) {
      fail("MAINTENANCE_NODE_STATE_INVALID", "maintenance-contain 缺少受信 authority");
    }
    this.rememberMaintenanceReceiptBinding(
      cacheKey,
      observation.maintenance.bindingSha256,
    );
    return {
      idempotent: response.idempotent,
      processStopped: true,
      maintenance: observation.maintenance,
      current: observation.current,
    };
  }

  async maintenanceQuiesce(
    rawBinding: Readonly<MaintenanceNodeActivationBinding>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceNodeQuiesceResult> {
    const binding = validateMaintenanceBinding(rawBinding, context);
    const cacheKey = this.rememberMaintenanceRequest(binding, context.operationId);
    const response = await this.invoke(
      binding.nodeId,
      `maintenance-quiesce ${context.operationId} ${binding.expectedCurrentReleaseId} ${binding.expectedCurrentArtifactSha256} ${binding.targetReleaseId} ${binding.targetArtifactSha256}`,
      "maintenance-quiesce",
      this.timeouts.activateMs,
      context,
    );
    exactObjectKeys(response, [
      "action",
      "agentSchemaVersion",
      "idempotent",
      "maintenance",
      "ok",
      "processStopped",
    ], "节点端 maintenance-quiesce envelope");
    if (response.action !== "maintenance-quiesce"
      || typeof response.idempotent !== "boolean"
      || response.processStopped !== true) {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 maintenance-quiesce 响应无效");
    }
    const maintenanceState = objectValue(response.maintenance)?.state;
    if (maintenanceState !== "quiesced" && maintenanceState !== "activation-attempted") {
      fail("MAINTENANCE_NODE_STATE_INVALID", "maintenance-quiesce 未证明受信停止状态");
    }
    const maintenance = parseMaintenanceSummary(
      response.maintenance,
      binding,
      context.operationId,
      maintenanceState,
    );
    this.rememberMaintenanceReceiptBinding(cacheKey, maintenance.bindingSha256);
    return {
      idempotent: response.idempotent,
      processStopped: true,
      maintenance,
    };
  }

  async activateMaintenance(
    rawBinding: Readonly<MaintenanceNodeActivationBinding>,
    context: ReleaseActionContext,
  ): Promise<MaintenanceNodeActivationResult> {
    const binding = validateMaintenanceBinding(rawBinding, context);
    const cacheKey = this.rememberMaintenanceRequest(binding, context.operationId);
    const response = await this.invoke(
      binding.nodeId,
      `activate-maintenance ${context.operationId} ${binding.expectedCurrentReleaseId} ${binding.expectedCurrentArtifactSha256} ${binding.targetReleaseId} ${binding.targetArtifactSha256}`,
      "activate-maintenance",
      this.timeouts.activateMs,
      context,
    );
    exactObjectKeys(response, [
      "action",
      "agentSchemaVersion",
      "idempotent",
      "maintenance",
      "ok",
      "readiness",
      "recovered",
      "runtime",
    ], "节点端 activate-maintenance envelope");
    if (response.action !== "activate-maintenance"
      || typeof response.idempotent !== "boolean"
      || typeof response.recovered !== "boolean"
      || !objectValue(response.runtime)) {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 activate-maintenance 响应无效");
    }
    const maintenance = parseMaintenanceSummary(
      response.maintenance,
      binding,
      context.operationId,
      "consumed",
    );
    this.rememberMaintenanceReceiptBinding(cacheKey, maintenance.bindingSha256);
    const readiness = parseMaintenanceReadiness(
      response.readiness,
      binding,
      context.operationId,
    );
    return {
      idempotent: response.idempotent,
      recovered: response.recovered,
      maintenance,
      readiness,
    };
  }

  /** Worker-only activation: remote CAS/switch/reload, DB heartbeat proves ready. */
  async stageWorker(
    nodeId: string,
    artifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<StageResult> {
    // Dedicated Workers do not have an HTTP preflight step. Validate the
    // fixed SSH destination's nodeId immediately before the first side effect
    // so swapped inventory entries cannot stage or activate the wrong host.
    await this.workerStatus(nodeId, context);
    return this.stage(nodeId, artifact, context);
  }

  async activateWorker(
    nodeId: string,
    artifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<WorkerActivationResult> {
    const artifactSha256 = this.validateArtifact(artifact, context);
    const deploymentIdentity = artifactDeploymentIdentity(artifact);
    const releaseId = await this.resolveReleaseId(artifact, context);
    const status = await this.workerStatus(nodeId, context);
    const expected = await this.expectedCurrentReleaseResolver?.(nodeId, artifact, context);
    if (!expected) {
      fail("WORKER_EXPECTED_CURRENT_MISSING", `Worker ${nodeId} 缺少旧版本 CAS 身份`);
    }
    const expectedReleaseId = validateReleaseId(expected.releaseId, "expectedCurrent.releaseId");
    const expectedSha = validateSha256(expected.artifactSha256, "expectedCurrent.artifactSha256");
    this.rememberRelease(nodeId, { releaseId: expectedReleaseId, artifactSha256: expectedSha });
    const currentMatchesExpected = status.current!.releaseId === expectedReleaseId
      && status.current!.artifactSha256 === expectedSha;
    const recoveringTarget = status.current!.releaseId === releaseId
      && status.current!.artifactSha256 === artifactSha256
      && (status.current!.deploymentMode ?? "archive-systemd")
        === deploymentIdentity.deploymentMode
      && (status.current!.imageDigest ?? null) === deploymentIdentity.imageDigest
      && status.previousReleaseId === expectedReleaseId;
    if (!currentMatchesExpected && !recoveringTarget) {
      fail("WORKER_CURRENT_RELEASE_CONFLICT", `Worker ${nodeId} 当前版本已偏离持久化预检快照`);
    }
    const response = await this.invoke(
      nodeId,
      `activate-worker ${releaseId} ${artifactSha256} ${expectedReleaseId}`,
      "activate-worker",
      this.timeouts.activateMs,
      context,
    );
    const current = descriptor(response.current, "activate-worker.current");
    const artifactSchemaMode = artifact.schemaMode ?? "schema-neutral";
    const compatibility = artifact.schemaCompatibility
      ?? (artifactSchemaMode === "schema-neutral"
        ? exactReleaseSchemaCompatibility(artifact.schemaVersion)
        : null);
    const expectedProof = compatibility
      ? releaseSchemaCompatibilityProofSha256(compatibility)
      : null;
    if (current.releaseId !== releaseId
      || current.artifactSha256 !== artifactSha256
      || current.schemaVersion !== artifact.schemaVersion
      || current.schemaMode !== artifactSchemaMode
      || (current.deploymentMode ?? "archive-systemd")
        !== deploymentIdentity.deploymentMode
      || (current.imageDigest ?? null) !== deploymentIdentity.imageDigest
      || !expectedProof
      || current.schemaCompatibilityProofSha256 !== expectedProof) {
      fail("WORKER_ACTIVE_ARTIFACT_SHA_MISMATCH", `Worker ${nodeId} 激活响应与目标制品不一致`);
    }
    this.rememberRelease(nodeId, current);
    const verifiedStatus = await this.workerStatus(nodeId, context);
    if (
      verifiedStatus.current?.artifactSha256 !== artifactSha256
      || verifiedStatus.current.schemaVersion !== artifact.schemaVersion
      || (verifiedStatus.current.deploymentMode ?? "archive-systemd")
        !== deploymentIdentity.deploymentMode
      || (verifiedStatus.current.imageDigest ?? null) !== deploymentIdentity.imageDigest
    ) {
      fail("WORKER_ACTIVE_ARTIFACT_SHA_MISMATCH", `Worker ${nodeId} 激活后节点身份漂移`);
    }
    return {
      artifactSha256,
      ...deploymentIdentity,
      ...(verifiedStatus.current.sourceCommit
        ? { sourceCommit: verifiedStatus.current.sourceCommit }
        : {}),
      targetSchemaVersion: artifact.schemaVersion,
      schemaMode: artifactSchemaMode,
      schemaCompatibilityProofSha256: expectedProof,
      ...(verifiedStatus.agentSurfaceFingerprint
        ? { agentSurfaceFingerprint: verifiedStatus.agentSurfaceFingerprint }
        : {}),
    };
  }

  async workerConfigurationIdentity(
    nodeId: string,
    context: ReleaseActionContext,
  ) {
    const status = await this.workerStatus(nodeId, context);
    return {
      artifactSha256: status.current!.artifactSha256,
      deploymentMode: status.current!.deploymentMode ?? "archive-systemd",
      imageDigest: status.current!.imageDigest ?? null,
      ...(status.current!.sourceCommit ? { sourceCommit: status.current!.sourceCommit } : {}),
      ...(status.current!.schemaVersion !== undefined
        ? { schemaVersion: status.current!.schemaVersion }
        : {}),
      ...(status.agentSurfaceFingerprint
        ? { agentSurfaceFingerprint: status.agentSurfaceFingerprint }
        : {}),
    };
  }
  async observeRedisCutover(
    nodeId: string,
    expected: RedisRateLimitCutoverMarker,
    context: ReleaseActionContext,
  ): Promise<WorkerRedisCutoverObservation> {
    validateContext(context);
    const markerExpected = validateRedisCutoverExpectation(expected);
    const response = await this.invoke(
      nodeId,
      `observe-redis-rate-limit-cutover ${markerExpected.cutoverAtMs} ${markerExpected.redisRuntimeFingerprint} ${nodeId}`,
      "observe-redis-rate-limit-cutover",
      this.timeouts.statusMs,
      context,
    );
    if (typeof response.nodeId !== "string" || !NODE_ID_PATTERN.test(response.nodeId)) {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 Redis cutover marker 响应缺少受信 nodeId");
    }
    if (response.nodeId !== nodeId) {
      fail("SSH_NODE_IDENTITY_MISMATCH", "SSH 目标返回的 nodeId 与受信清单不一致");
    }
    if (response.idempotent !== undefined && typeof response.idempotent !== "boolean") {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 Redis cutover marker 幂等状态无效");
    }
    const currentArtifactSha256 = validateSha256(
      response.currentArtifactSha256,
      "observe-redis-rate-limit-cutover.currentArtifactSha256",
    );
    const runtimeCapabilities = parseRuntimeCapabilities(
      response.runtimeCapabilities,
      "observe-redis-rate-limit-cutover.runtimeCapabilities",
    );
    if (!runtimeCapabilities || !runtimeCapabilities.includes(REDIS_RATE_LIMIT_CAPABILITY)) {
      fail(
        "SSH_AGENT_RESPONSE_INVALID",
        "节点端当前 Worker 制品未证明 Redis 限流 capability",
      );
    }
    const redisRuntimeFingerprint = validateSha256(
      response.redisRuntimeFingerprint,
      "observe-redis-rate-limit-cutover.redisRuntimeFingerprint",
    );
    if (redisRuntimeFingerprint !== markerExpected.redisRuntimeFingerprint) {
      fail(
        "REDIS_RUNTIME_FINGERPRINT_ATTESTATION_MISMATCH",
        "节点端 Redis runtime fingerprint 与请求不一致",
      );
    }
    const marker = parseRedisRateLimitCutoverMarker(
      response.marker,
      "observe-redis-rate-limit-cutover.marker",
    );
    if (!marker) {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 Redis cutover marker 响应缺少 marker");
    }
    if (marker.cutoverAtMs !== markerExpected.cutoverAtMs
      || marker.redisRuntimeFingerprint !== markerExpected.redisRuntimeFingerprint) {
      fail("REDIS_CUTOVER_MARKER_ATTESTATION_MISMATCH", "节点端 Redis cutover marker 与请求不一致");
    }
    return {
      nodeId,
      currentArtifactSha256,
      runtimeCapabilities,
      redisRuntimeFingerprint,
      marker,
    };
  }

  async armRedisCutoverSchedule(
    nodeId: string,
    expected: RedisRateLimitScheduleGuard,
    context: ReleaseActionContext,
  ): Promise<RedisScheduleGuardObservation> {
    validateContext(context);
    if (!NODE_ID_PATTERN.test(nodeId)) {
      fail("SSH_NODE_ID_INVALID", "Redis schedule guard 节点 ID 无效");
    }
    const guardExpected = validateRedisScheduleGuardExpectation(expected);
    const response = await this.invoke(
      nodeId,
      `arm-redis-rate-limit-schedule ${guardExpected.cutoverAtMs} ${guardExpected.redisRuntimeFingerprint} ${nodeId}`,
      "arm-redis-rate-limit-schedule",
      this.timeouts.statusMs,
      context,
    );
    if (response.nodeId !== nodeId) {
      fail("SSH_NODE_IDENTITY_MISMATCH", "SSH 目标返回的 nodeId 与受信清单不一致");
    }
    if (response.idempotent !== undefined && typeof response.idempotent !== "boolean") {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端 Redis schedule guard 幂等状态无效");
    }
    const currentArtifactSha256 = validateSha256(
      response.currentArtifactSha256,
      "arm-redis-rate-limit-schedule.currentArtifactSha256",
    );
    const runtimeCapabilities = parseRuntimeCapabilities(
      response.runtimeCapabilities,
      "arm-redis-rate-limit-schedule.runtimeCapabilities",
    );
    if (!runtimeCapabilities || !runtimeCapabilities.includes(REDIS_RATE_LIMIT_CAPABILITY)) {
      fail("SSH_AGENT_RESPONSE_INVALID", "节点端当前制品未证明 Redis 限流 capability");
    }
    const redisRuntimeFingerprint = validateSha256(
      response.redisRuntimeFingerprint,
      "arm-redis-rate-limit-schedule.redisRuntimeFingerprint",
    );
    if (redisRuntimeFingerprint !== guardExpected.redisRuntimeFingerprint) {
      fail(
        "REDIS_RUNTIME_FINGERPRINT_ATTESTATION_MISMATCH",
        "节点端 Redis runtime fingerprint 与 schedule guard 不一致",
      );
    }
    const guard = parseRedisScheduleGuard(
      response.guard,
      "arm-redis-rate-limit-schedule.guard",
    );
    if (guard.cutoverAtMs !== guardExpected.cutoverAtMs
      || guard.redisRuntimeFingerprint !== guardExpected.redisRuntimeFingerprint) {
      fail("REDIS_SCHEDULE_GUARD_ATTESTATION_MISMATCH", "节点端 Redis schedule guard 与请求不一致");
    }
    return {
      nodeId,
      currentArtifactSha256,
      runtimeCapabilities,
      redisRuntimeFingerprint,
      guard,
    };
  }

  async rollbackWorker(
    nodeId: string,
    previousArtifactSha256: string,
    targetArtifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<void> {
    this.validateArtifact(targetArtifact, context);
    const previousSha = validateSha256(previousArtifactSha256, "previousArtifactSha256");
    const status = await this.workerStatus(nodeId, context);
    if (status.current!.artifactSha256 === previousSha) {
      // The controller may have persisted activationAttempted immediately
      // before the SSH command was interrupted. If the exact old artifact is
      // still current, DB heartbeat verification is sufficient and issuing a
      // rollback CAS against the target release would fail unnecessarily.
      return;
    }
    const releases = this.releaseIdsByNodeSha.get(nodeId);
    let previousReleaseId = releases?.get(previousSha);
    if (!previousReleaseId && this.expectedCurrentReleaseResolver) {
      const previous = await this.expectedCurrentReleaseResolver(nodeId, targetArtifact, context);
      if (previous?.artifactSha256 === previousSha) {
        previousReleaseId = validateReleaseId(previous.releaseId, "previous.releaseId");
        this.rememberRelease(nodeId, { releaseId: previousReleaseId, artifactSha256: previousSha });
      }
    }
    const currentReleaseId = await this.resolveReleaseId(targetArtifact, context);
    if (!previousReleaseId) {
      fail("WORKER_ROLLBACK_IDENTITY_MISSING", `Worker ${nodeId} 缺少精确回切版本映射`);
    }
    const response = await this.invoke(
      nodeId,
      `rollback-worker ${previousReleaseId} ${currentReleaseId}`,
      "rollback-worker",
      this.timeouts.rollbackMs,
      context,
    );
    const current = descriptor(response.current, "rollback-worker.current");
    if (current.releaseId !== previousReleaseId || current.artifactSha256 !== previousSha) {
      fail("WORKER_ROLLBACK_ARTIFACT_IDENTITY_MISMATCH", `Worker ${nodeId} 回切响应不是预期旧制品`);
    }
    this.rememberRelease(nodeId, current);
  }

  asWorkerNodeAgent(): WorkerNodeAgent {
    return {
      stage: this.stageWorker.bind(this),
      activate: this.activateWorker.bind(this),
      configurationIdentity: this.workerConfigurationIdentity.bind(this),
      armRedisCutoverSchedule: this.armRedisCutoverSchedule.bind(this),
      observeRedisCutover: this.observeRedisCutover.bind(this),
      rollback: (nodeId, previousArtifactSha256, targetArtifact, context) => (
        this.rollbackWorker(nodeId, previousArtifactSha256, targetArtifact, context)
      ),
    };
  }

  private async workerStatus(
    nodeId: string,
    context: ReleaseActionContext,
  ): Promise<StatusSnapshot> {
    const status = await this.status(nodeId, context);
    if (!status.current) {
      fail("WORKER_CURRENT_RELEASE_MISSING", `Worker ${nodeId} 缺少当前版本指针`);
    }
    this.rememberStatus(nodeId, status);
    return status;
  }

  async directReadiness(
    nodeId: string,
    context: ReleaseActionContext,
  ): Promise<DirectReadinessResult> {
    validateContext(context);
    const status = await this.status(nodeId, context);
    if (!status.current) {
      return { ready: false, artifactSha256: "", code: "NODE_CURRENT_RELEASE_MISSING" };
    }
    this.rememberStatus(nodeId, status);
    const expectedSha = context.actionId.startsWith("rollback:")
      ? this.readinessExpectedSha.get(nodeId)
        || this.preflightIdentities.get(nodeId)?.artifactSha256
        || context.artifactSha256
      : context.artifactSha256;
    const ready = Boolean(
      status.ok
      && status.readiness?.ready
      && status.readiness.matchesArtifact
      && status.readiness.releaseIdentityMatchesManifest
      && status.readiness.artifactSha256 === status.current.artifactSha256
      && status.readiness.sourceCommit === status.current.sourceCommit
      && status.readiness.schemaVersion === status.current.schemaVersion
      && status.current.artifactSha256 === expectedSha
    );
    return {
      ready,
      artifactSha256: status.current.artifactSha256,
      deploymentMode: status.current.deploymentMode ?? "archive-systemd",
      imageDigest: status.current.imageDigest ?? null,
      ...(status.current.sourceCommit ? { sourceCommit: status.current.sourceCommit } : {}),
      ...(status.current.schemaVersion !== undefined
        ? { schemaVersion: status.current.schemaVersion }
        : {}),
      ...(status.agentSurfaceFingerprint
        ? { agentSurfaceFingerprint: status.agentSurfaceFingerprint }
        : {}),
      ...(!ready ? { code: status.errorCode || "NODE_DIRECT_NOT_READY" } : {}),
    };
  }

  /**
   * Read the exact current release without requiring an HTTP readiness
   * endpoint. Dedicated Workers use this together with their fresh database
   * heartbeat; no stage/activate/drain command is issued.
   */
  async currentIdentity(
    nodeId: string,
    context: ReleaseActionContext,
  ): Promise<NodeCurrentReleaseIdentity> {
    validateContext(context);
    const status = await this.status(nodeId, context);
    if (!status.current) {
      fail("NODE_CURRENT_RELEASE_MISSING", `节点 ${nodeId} 缺少当前版本指针`);
    }
    this.rememberStatus(nodeId, status);
    return {
      nodeId,
      releaseId: status.current.releaseId,
      artifactSha256: status.current.artifactSha256,
      schemaMode:
        status.current.schemaMode === "schema-neutral"
        || status.current.schemaMode === "migration"
          ? status.current.schemaMode
          : null,
      schemaVersion: status.current.schemaVersion ?? null,
      deploymentMode: status.current.deploymentMode ?? "archive-systemd",
      imageDigest: status.current.imageDigest ?? null,
    };
  }

  async rollback(
    nodeId: string,
    previousArtifactSha256: string,
    context: ReleaseActionContext,
  ): Promise<void> {
    validateContext(context);
    const previousSha = validateSha256(previousArtifactSha256, "previousArtifactSha256");
    const status = await this.status(nodeId, context);
    if (!status.current) fail("NODE_CURRENT_RELEASE_MISSING", `节点 ${nodeId} 缺少当前版本指针`);
    this.rememberStatus(nodeId, status);
    // A controller can restart after the node completed the atomic rollback
    // but before its checkpoint was persisted. Exact current SHA makes that
    // retry an idempotent success; do not roll forward through `previous`.
    if (status.current.artifactSha256 === previousSha) {
      const rememberedId = this.releaseIdsByNodeSha.get(nodeId)?.get(previousSha);
      if (rememberedId && rememberedId !== status.current.releaseId) {
        fail("ROLLBACK_ARTIFACT_IDENTITY_MISMATCH", `节点 ${nodeId} 旧制品映射发生冲突`);
      }
      this.readinessExpectedSha.set(nodeId, previousSha);
      return;
    }
    if (!status.previousReleaseId) {
      fail("NODE_PREVIOUS_RELEASE_MISSING", `节点 ${nodeId} 没有可回切的 previous 指针`);
    }
    const previous = status.releasesById.get(status.previousReleaseId);
    if (!previous || previous.artifactSha256 !== previousSha) {
      fail("ROLLBACK_ARTIFACT_IDENTITY_MISMATCH", `节点 ${nodeId} previous 指针与旧制品 SHA-256 不一致`);
    }
    const rememberedId = this.releaseIdsByNodeSha.get(nodeId)?.get(previousSha);
    if (rememberedId && rememberedId !== previous.releaseId) {
      fail("ROLLBACK_ARTIFACT_IDENTITY_MISMATCH", `节点 ${nodeId} 旧制品映射发生冲突`);
    }
    const response = await this.invoke(
      nodeId,
      `rollback ${status.current.releaseId}`,
      "rollback",
      this.timeouts.rollbackMs,
      context,
    );
    const current = descriptor(response.current, "rollback.current");
    if (current.releaseId !== previous.releaseId || current.artifactSha256 !== previousSha) {
      fail("ROLLBACK_ARTIFACT_IDENTITY_MISMATCH", `节点 ${nodeId} 回切响应不是预期旧制品`);
    }
    this.rememberRelease(nodeId, current);
    this.readinessExpectedSha.set(nodeId, previousSha);
  }

  private validateArtifact(artifact: ReleaseArtifact, context: ReleaseActionContext): string {
    if (!artifact || typeof artifact.id !== "string" || !artifact.id.trim()) {
      fail("RELEASE_ARTIFACT_INVALID", "发布制品记录无效");
    }
    if (typeof artifact.version !== "string" || !artifact.version.trim()) {
      fail("RELEASE_ARTIFACT_INVALID", "发布制品版本无效");
    }
    if (!Number.isSafeInteger(artifact.schemaVersion) || artifact.schemaVersion < 0) {
      fail("RELEASE_ARTIFACT_INVALID", "发布制品 schemaVersion 无效");
    }
    if (!Number.isSafeInteger(artifact.workerProtocolVersion)
      || artifact.workerProtocolVersion < 1
      || artifact.workerProtocolVersion > 2_147_483_647) {
      fail("RELEASE_ARTIFACT_INVALID", "发布制品 workerProtocolVersion 无效");
    }
    const sha = validateSha256(artifact.sha256, "artifact.sha256");
    artifactDeploymentIdentity(artifact);
    validateContext(context, sha);
    return sha;
  }

  private node(nodeId: string): SshNodeInventoryEntry {
    if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
      fail("SSH_NODE_ID_INVALID", "SSH nodeId 格式无效");
    }
    const node = this.nodes.get(nodeId);
    if (!node) fail("SSH_NODE_NOT_IN_INVENTORY", `节点 ${nodeId} 不在受信 SSH 清单中`);
    return node;
  }

  private async resolveReleaseId(
    artifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<string> {
    let value: unknown;
    try {
      value = await this.releaseIdResolver(artifact, context);
    } catch {
      fail("RELEASE_ID_RESOLUTION_FAILED", "无法解析发布制品 releaseId");
    }
    // The database artifact id is deliberately not used as the node releaseId.
    // The default comes from the immutable artifact version/manifest convention.
    return validateReleaseId(value, "artifact releaseId");
  }

  private async resolveArtifactPath(
    artifact: ReleaseArtifact,
    context: ReleaseActionContext,
  ): Promise<string> {
    let value: unknown;
    try {
      value = await this.artifactLocalPathResolver(artifact, context);
    } catch {
      fail("RELEASE_ARTIFACT_PATH_RESOLUTION_FAILED", "无法解析本地发布制品路径");
    }
    if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
      fail("RELEASE_ARTIFACT_PATH_INVALID", "本地发布制品路径必须是绝对路径");
    }
    return value;
  }

  private rememberRelease(nodeId: string, release: ReleaseDescriptor): void {
    let bySha = this.releaseIdsByNodeSha.get(nodeId);
    if (!bySha) {
      bySha = new Map<string, string>();
      this.releaseIdsByNodeSha.set(nodeId, bySha);
    }
    const existing = bySha.get(release.artifactSha256);
    if (existing && existing !== release.releaseId) {
      fail("NODE_RELEASE_IDENTITY_CONFLICT", `节点 ${nodeId} 同一制品 SHA-256 映射到多个 releaseId`);
    }
    bySha.set(release.artifactSha256, release.releaseId);
  }

  private rememberStatus(nodeId: string, status: StatusSnapshot): void {
    for (const release of status.releasesById.values()) this.rememberRelease(nodeId, release);
    if (status.current) this.rememberRelease(nodeId, status.current);
  }

  private rememberMaintenanceRequest(
    binding: Readonly<MaintenanceNodeActivationBinding>,
    operationId: string,
  ): string {
    const cacheKey = `${operationId}\0${binding.nodeId}`;
    const identity = maintenanceRequestIdentity(binding);
    const existing = this.maintenanceRequests.get(cacheKey);
    if (existing !== undefined && existing !== identity) {
      fail("MAINTENANCE_NODE_BINDING_DRIFT", "维护节点请求与本操作已绑定身份发生漂移");
    }
    this.maintenanceRequests.set(cacheKey, identity);
    return cacheKey;
  }

  private rememberMaintenanceReceiptBinding(cacheKey: string, bindingSha256: string): void {
    const existing = this.maintenanceReceiptBindings.get(cacheKey);
    if (existing !== undefined && existing !== bindingSha256) {
      fail("MAINTENANCE_NODE_BINDING_DRIFT", "维护节点 receipt binding 在重试间发生漂移");
    }
    this.maintenanceReceiptBindings.set(cacheKey, bindingSha256);
  }

  private async status(nodeId: string, context: ReleaseActionContext): Promise<StatusSnapshot> {
    validateContext(context);
    const response = await this.invoke(
      nodeId,
      `status ${nodeId}`,
      "status",
      this.timeouts.statusMs,
      context,
      undefined,
      true,
    );
    return parseStatus(response, nodeId);
  }

  private sshArgs(node: SshNodeInventoryEntry, remoteCommand: string): string[] {
    const args = [
      "-T",
      "-p", String(node.port),
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "NumberOfPasswordPrompts=0",
      "-o", `ConnectTimeout=${this.connectTimeoutSeconds}`,
      "-o", "LogLevel=ERROR",
    ];
    if (this.knownHostsFile) args.push("-o", `UserKnownHostsFile=${this.knownHostsFile}`);
    if (this.identityFile) args.push("-i", this.identityFile, "-o", "IdentitiesOnly=yes");
    args.push("--", node.target, remoteCommand);
    return args;
  }

  private async invoke(
    nodeId: string,
    remoteCommand: string,
    expectedAction: string,
    timeoutMs: number,
    context: ReleaseActionContext,
    inputPath?: string,
    allowAgentFailure = false,
  ): Promise<AgentEnvelope> {
    const node = this.node(nodeId);
    const signal = this.signalResolver?.(context) || this.signal;
    if (signal?.aborted) fail("SSH_COMMAND_ABORTED", `节点 ${nodeId} SSH 操作已取消`);
    const result = await this.runProcess(node, remoteCommand, timeoutMs, inputPath, signal);
    const envelope = result.envelope;
    if (envelope.action !== expectedAction && !(envelope.ok === false && envelope.action == null)) {
      fail("SSH_AGENT_ACTION_MISMATCH", `节点 ${nodeId} 返回的动作类型不匹配`);
    }
    if (!envelope.ok) {
      if (allowAgentFailure) return envelope;
      errorFromEnvelope(envelope, nodeId);
    }
    if (result.exitCode !== 0) {
      fail("SSH_COMMAND_EXIT_NONZERO", `节点 ${nodeId} SSH 操作异常退出`);
    }
    return envelope;
  }

  private runProcess(
    node: SshNodeInventoryEntry,
    remoteCommand: string,
    timeoutMs: number,
    inputPath: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(this.sshBinary, this.sshArgs(node, remoteCommand), {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: minimalSshEnvironment(),
        });
      } catch {
        reject(new SshNodeAgentError("SSH_COMMAND_SPAWN_FAILED", `节点 ${node.nodeId} SSH 进程无法启动`));
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalError: SshNodeAgentError | null = null;
      let settled = false;
      const input = inputPath ? createReadStream(inputPath) : null;

      const stop = (error: SshNodeAgentError) => {
        if (!terminalError) terminalError = error;
        if (!child.killed) child.kill("SIGTERM");
        const force = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 250);
        force.unref?.();
      };

      const timer = setTimeout(() => {
        stop(new SshNodeAgentError("SSH_COMMAND_TIMEOUT", `节点 ${node.nodeId} SSH 操作超时`));
      }, timeoutMs);
      timer.unref?.();

      const onAbort = () => {
        stop(new SshNodeAgentError("SSH_COMMAND_ABORTED", `节点 ${node.nodeId} SSH 操作已取消`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > this.maxStdoutBytes) {
          stop(new SshNodeAgentError("SSH_STDOUT_LIMIT_EXCEEDED", `节点 ${node.nodeId} SSH stdout 超出上限`));
          return;
        }
        stdoutChunks.push(buffer);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > this.maxStderrBytes) {
          stop(new SshNodeAgentError("SSH_STDERR_LIMIT_EXCEEDED", `节点 ${node.nodeId} SSH stderr 超出上限`));
          return;
        }
        // Retain only to keep a strict byte count and drain the descriptor. It
        // is intentionally never surfaced, logged, or persisted.
        stderrChunks.push(buffer);
      });
      child.on("error", () => {
        stop(new SshNodeAgentError("SSH_COMMAND_SPAWN_FAILED", `节点 ${node.nodeId} SSH 进程无法执行`));
      });
      child.stdin?.on("error", () => {
        // EPIPE is expected when the fixed remote command rejects a stream.
        // The structured stdout/exit status remains the source of truth.
      });
      input?.on("error", () => {
        stop(new SshNodeAgentError("RELEASE_ARTIFACT_READ_FAILED", "无法读取本地发布制品"));
      });

      if (input && child.stdin) input.pipe(child.stdin);
      else child.stdin?.end();

      child.on("close", (exitCode) => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        input?.destroy();
        if (terminalError) {
          reject(terminalError);
          return;
        }
        let envelope: AgentEnvelope;
        try {
          envelope = parseAgentEnvelope(Buffer.concat(stdoutChunks, stdoutBytes));
        } catch (error) {
          reject(error);
          return;
        }
        resolve({ exitCode, envelope });
      });
    });
  }
}
