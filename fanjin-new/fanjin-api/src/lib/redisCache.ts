import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import IORedis from "ioredis";

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 1_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_VALUE_BYTES = 1024 * 1024;
const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_RETRY_BACKOFF_MS = 60_000;
const MAX_RETRY_BACKOFF_EXPONENT = 10;
const MAX_REDIS_TLS_CA_BYTES = 256 * 1024;
const TEST_PRIVATE_VPC_REDIS_HOSTS = new Set([
  "redis-cnlf5igwg3wbw2kkz.redis.ivolces.com",
]);

export type RedisConfigurationStatus = "disabled" | "configured" | "invalid";

export interface RedisConfigurationInspection {
  status: RedisConfigurationStatus;
  enabled: boolean;
  required: boolean;
  protocol: "redis:" | "rediss:" | null;
  authConfigured: boolean;
  prefix: string;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  retryDelayMs: number;
  maxValueBytes: number;
  missingVariables: string[];
  invalidVariables: string[];
}

interface ResolvedRedisConfiguration extends RedisConfigurationInspection {
  url: string | null;
  tls: RedisTlsClientOptions | null;
  tlsCaMaterialPresent: boolean;
}

export interface RedisTlsClientOptions {
  ca: string;
  servername: string;
  minVersion: "TLSv1.2";
  rejectUnauthorized: true;
}

export interface RedisClientAdapter {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  time(): Promise<unknown>;
  info(section: string): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(script: string, keys: string[], arguments_: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
  destroy(): void;
  on(event: string, listener: (...args: any[]) => void): this;
}

export type RedisClientFactory = (options: {
  url: string;
  disableOfflineQueue: boolean;
  tls?: RedisTlsClientOptions;
  socket: {
    connectTimeout: number;
    reconnectStrategy: false;
  };
}) => RedisClientAdapter;

export interface RedisCacheReadResult<T> {
  available: boolean;
  hit: boolean;
  value: T | null;
}

export interface RedisRuntimeProbe {
  configured: boolean;
  required: boolean;
  ready: boolean;
  latencyMs: number | null;
  status: RedisConfigurationStatus | "ready" | "unavailable";
}

export interface RedisRuntimeSnapshot {
  configured: boolean;
  required: boolean;
  ready: boolean;
  status: RedisConfigurationStatus | "ready" | "unavailable";
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

export interface RedisEndpointIdentity {
  protocol: "redis:" | "rediss:";
  hostname: string;
  port: number;
  database: number;
  authMode: "none" | "acl";
  authPrincipalHash: string | null;
}

export interface RedisRuntimeIdentity extends RedisConfigurationInspection {
  endpoint: RedisEndpointIdentity | null;
  transportPolicy: {
    allowInsecurePrivateVpc: string;
    insecurePrivateVpcHost: string | null;
    insecurePrivateVpcMode: boolean;
  };
  tls: {
    caSha256: string;
    serverName: string;
    minVersion: "TLSv1.2";
    rejectUnauthorized: true;
  } | null;
}

export const RELEASE_TEST_ALLOW_INSECURE_LOOPBACK_REDIS_ENV =
  "FANJIN_RELEASE_TEST_ALLOW_INSECURE_LOOPBACK_REDIS";
export const ALLOW_INSECURE_PRIVATE_VPC_REDIS_ENV =
  "FANJIN_REDIS_ALLOW_INSECURE_PRIVATE_VPC";
export const INSECURE_PRIVATE_VPC_REDIS_HOST_ENV =
  "FANJIN_REDIS_INSECURE_PRIVATE_VPC_HOST";
export const REDIS_TLS_CA_FILE_ENV = "FANJIN_REDIS_TLS_CA_FILE";
export const REDIS_TLS_CA_SHA256_ENV = "FANJIN_REDIS_TLS_CA_SHA256";

export type RedisEndpointScope = "none" | "local" | "remote";

export type RedisProductionTopologyIssue =
  | "redis_not_configured"
  | "redis_not_required"
  | "redis_endpoint_invalid"
  | "redis_local_endpoint"
  | "redis_tls_missing"
  | "redis_tls_ca_missing"
  | "redis_tls_ca_invalid"
  | "redis_auth_missing"
  | "insecure_private_vpc_mode_invalid"
  | "insecure_private_vpc_host_missing"
  | "insecure_private_vpc_host_invalid"
  | "insecure_private_vpc_host_mismatch"
  | "insecure_private_vpc_host_not_private"
  | "release_test_exemption_invalid";

/**
 * A deliberately credential-free view of the Redis deployment topology.
 * It is safe to use in readiness diagnostics: no URL, hostname, username,
 * password, or principal hash is returned.
 */
export interface RedisProductionTopologyInspection {
  production: boolean;
  valid: boolean;
  configured: boolean;
  required: boolean;
  endpointScope: RedisEndpointScope;
  tlsConfigured: boolean;
  authConfigured: boolean;
  insecurePrivateVpcMode: boolean;
  testOnlyExemption: boolean;
  issues: RedisProductionTopologyIssue[];
}

export class RedisUnavailableError extends Error {
  readonly code = "redis_unavailable";

  constructor(message = "Redis 暂不可用") {
    super(message);
    this.name = "RedisUnavailableError";
  }
}

function strictBoolean(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = environment[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

function strictInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be an integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range`);
  }
  return value;
}

function defaultPrefix(environment: NodeJS.ProcessEnv): string {
  const rawStage = String(environment.NODE_ENV || "dev").trim().toLowerCase() || "dev";
  // The release node agent uses "prod" as the canonical production stage.
  // Normalize Node's equally common "production" spelling so an omitted
  // explicit prefix cannot split application and agent Redis identities.
  const stage = rawStage === "production" ? "prod" : rawStage;
  return `fanjin:${stage}:v1`;
}

function canonicalRedisHostname(hostname: string): string | null {
  const normalized = hostname.toLowerCase();
  if (/^\[[0-9a-f:.]+\]$/.test(normalized)) return normalized;
  // Keep DNS/IPv4 spelling stable across the Node and Python release agents;
  // non-ASCII or percent-encoded hostnames are rejected instead of producing
  // runtime-specific URL-normalization results.
  return /^[a-z0-9._-]+$/.test(normalized) ? normalized : null;
}

function parseRedisEndpointIdentity(url: string): RedisEndpointIdentity | null {
  try {
    // ioredis chooses TLS from a case-sensitive rediss:// prefix. WHATWG URL
    // normalizes mixed-case schemes, so accepting REDISS:// here would let the
    // topology gate claim TLS while the client opens a plaintext connection.
    if (!/^(?:redis|rediss):\/\//.test(url)) return null;
    const parsed = new URL(url);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") return null;
    const hostname = canonicalRedisHostname(parsed.hostname);
    if (!hostname || parsed.search || parsed.hash) return null;
    const databaseText = parsed.pathname === "" || parsed.pathname === "/"
      ? "0"
      : /^\/\d+$/.test(parsed.pathname)
        ? parsed.pathname.slice(1)
        : null;
    if (databaseText === null) return null;
    const database = Number(databaseText);
    const port = Number(parsed.port || 6379);
    if (
      !Number.isSafeInteger(database)
      || database < 0
      || !Number.isSafeInteger(port)
      || port < 1
      || port > 65_535
    ) return null;
    const username = decodeURIComponent(parsed.username || "");
    const passwordConfigured = Boolean(parsed.password);
    if (username && !passwordConfigured) return null;
    const authPrincipal = passwordConfigured ? username || "default" : "";
    return {
      protocol: parsed.protocol,
      hostname,
      port,
      database,
      authMode: passwordConfigured ? "acl" : "none",
      authPrincipalHash: authPrincipal
        ? crypto.createHash("sha256").update(authPrincipal).digest("hex")
        : null,
    };
  } catch {
    return null;
  }
}

function isProductionEnvironment(environment: NodeJS.ProcessEnv): boolean {
  const nodeEnv = String(environment.NODE_ENV || "").trim().toLowerCase();
  return nodeEnv === "prod" || nodeEnv === "production";
}

function resolveRedisTlsConfiguration(options: {
  environment: NodeJS.ProcessEnv;
  enabled: boolean;
  endpoint: RedisEndpointIdentity | null;
  missingVariables: string[];
  invalidVariables: string[];
}): { tls: RedisTlsClientOptions | null; materialPresent: boolean } {
  const caFile = String(options.environment[REDIS_TLS_CA_FILE_ENV] || "").trim();
  const expectedSha256 = String(options.environment[REDIS_TLS_CA_SHA256_ENV] || "").trim();
  const materialPresent = Boolean(caFile || expectedSha256);
  if (!options.enabled || options.endpoint?.protocol !== "rediss:") {
    // Operators may safely pre-stage the CA contract before the maintenance
    // switch. Plain redis:// keeps its v2 fingerprint byte-for-byte stable.
    return { tls: null, materialPresent };
  }
  if (!caFile) options.missingVariables.push(REDIS_TLS_CA_FILE_ENV);
  if (!expectedSha256) options.missingVariables.push(REDIS_TLS_CA_SHA256_ENV);
  if (!caFile || !expectedSha256) return { tls: null, materialPresent };
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || !path.isAbsolute(caFile)) {
    options.invalidVariables.push(
      !/^[a-f0-9]{64}$/.test(expectedSha256)
        ? REDIS_TLS_CA_SHA256_ENV
        : REDIS_TLS_CA_FILE_ENV,
    );
    return { tls: null, materialPresent };
  }

  let descriptor = -1;
  try {
    const resolvedPath = path.resolve(caFile);
    if (fs.realpathSync(caFile) !== resolvedPath) throw new Error("unsafe path");
    const before = fs.lstatSync(caFile);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || before.size < 1
      || before.size > MAX_REDIS_TLS_CA_BYTES
      || (before.mode & 0o022) !== 0
    ) throw new Error("unsafe metadata");
    descriptor = fs.openSync(
      caFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || !opened.isFile()
    ) throw new Error("changed while opening");
    const ca = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error("changed while reading");
    }
    if (/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(ca)) {
      throw new Error("private material is forbidden");
    }
    const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
    const certificates = ca.match(certificatePattern);
    if (!certificates?.length || ca.replace(certificatePattern, "").trim()) {
      throw new Error("invalid certificate bundle");
    }
    for (const certificate of certificates) new crypto.X509Certificate(certificate);
    const actualSha256 = crypto.createHash("sha256").update(Buffer.from(ca, "utf8")).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error("digest mismatch");
    return {
      tls: {
        ca,
        servername: options.endpoint.hostname.replace(/^\[|\]$/g, ""),
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      },
      materialPresent,
    };
  } catch {
    options.invalidVariables.push(REDIS_TLS_CA_FILE_ENV);
    return { tls: null, materialPresent };
  } finally {
    if (descriptor >= 0) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The configuration is already fail-closed; never expose host paths.
      }
    }
  }
}

function parseLegacyIpv4Component(component: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(component)) return Number.parseInt(component.slice(2), 16);
  if (/^0[0-7]+$/.test(component) && component.length > 1) return Number.parseInt(component, 8);
  if (/^\d+$/.test(component)) return Number.parseInt(component, 10);
  return null;
}

/**
 * Redis URLs use a non-special WHATWG scheme, so Node does not normalize all
 * legacy IPv4 spellings (for example 2130706433 or 0177.0.0.1). Recognize the
 * common loopback/unspecified forms explicitly instead of allowing a local
 * endpoint to masquerade as a fleet-wide shared service.
 */
function isLocalRedisHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!normalized) return true;
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "localhost.localdomain"
    || normalized === "host.docker.internal"
    || normalized === "gateway.docker.internal"
    || normalized === "kubernetes.docker.internal"
    || normalized === "host.containers.internal"
  ) return true;

  if (normalized === "::" || normalized === "::1") return true;
  // WHATWG canonicalizes IPv4-mapped IPv6 into a hexadecimal suffix.
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(normalized)) return true;

  const parts = normalized.split(".");
  if (parts.length >= 1 && parts.length <= 4) {
    const numericParts = parts.map(parseLegacyIpv4Component);
    if (numericParts.every((part): part is number => part !== null && part >= 0)) {
      if (parts.length === 1) {
        const value = numericParts[0];
        if (value === 0 || (value <= 0xffff_ffff && Math.floor(value / 0x100_0000) === 127)) {
          return true;
        }
      } else if (numericParts[0] === 0 || numericParts[0] === 127) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The temporary plaintext exception is restricted to private address space or
 * Volcengine's documented VPC-only Redis endpoint form. A caller must still
 * bind the exact canonical hostname separately; this classification alone is
 * never enough to enable the exception.
 */
function isPrivateVpcRedisHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (TEST_PRIVATE_VPC_REDIS_HOSTS.has(normalized)) return true;

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    if (ipv4.slice(1).some((component) => String(Number(component)) !== component)) return false;
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return false;
    }
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }

  if (!normalized.startsWith("[") || !normalized.endsWith("]")) return false;
  const ipv6 = normalized.slice(1, -1);
  if (isIP(ipv6) !== 6) return false;
  const firstHextet = Number.parseInt(ipv6.split(":", 1)[0] || "0", 16);
  return (firstHextet & 0xfe00) === 0xfc00;
}

function inspectResolvedRedisProductionTopology(
  configuration: ResolvedRedisConfiguration,
  environment: NodeJS.ProcessEnv,
): RedisProductionTopologyInspection {
  const production = isProductionEnvironment(environment);
  const endpoint = configuration.url ? parseRedisEndpointIdentity(configuration.url) : null;
  const endpointScope: RedisEndpointScope = !endpoint
    ? "none"
    : isLocalRedisHostname(endpoint.hostname)
      ? "local"
      : "remote";
  const tlsConfigured = endpoint?.protocol === "rediss:";
  const authConfigured = endpoint?.authMode === "acl";
  const rawPrivateVpcMode = String(
    environment[ALLOW_INSECURE_PRIVATE_VPC_REDIS_ENV] || "",
  ).trim();
  const privateVpcModeRequested = rawPrivateVpcMode === "1";
  const rawPrivateVpcHost = String(
    environment[INSECURE_PRIVATE_VPC_REDIS_HOST_ENV] || "",
  ).trim();
  const canonicalPrivateVpcHost = rawPrivateVpcHost
    ? canonicalRedisHostname(rawPrivateVpcHost)
    : null;
  const privateVpcHostCanonical = canonicalPrivateVpcHost !== null
    && canonicalPrivateVpcHost === rawPrivateVpcHost;
  const privateVpcHostMatched = Boolean(
    endpoint
    && privateVpcHostCanonical
    && canonicalPrivateVpcHost === endpoint.hostname,
  );
  const privateVpcHostAllowed = Boolean(
    privateVpcHostCanonical
    && canonicalPrivateVpcHost
    && isPrivateVpcRedisHostname(canonicalPrivateVpcHost),
  );
  const privateVpcContextValid = production
    && endpointScope === "remote"
    && !tlsConfigured
    && authConfigured
    && endpoint?.port === 6379
    && privateVpcHostMatched
    && privateVpcHostAllowed;
  const insecurePrivateVpcMode = privateVpcModeRequested && privateVpcContextValid;
  const rawExemption = String(environment[RELEASE_TEST_ALLOW_INSECURE_LOOPBACK_REDIS_ENV] || "").trim();
  const exemptionRequested = rawExemption === "1";
  const exemptionContextValid = production
    && exemptionRequested
    && endpointScope === "local"
    && String(environment.FANJIN_RELEASE_ID || "").trim() === "release-regression"
    && configuration.prefix.startsWith("fanjin:release-regression:");
  const testOnlyExemption = exemptionContextValid;
  const issues: RedisProductionTopologyIssue[] = [];

  if (rawPrivateVpcMode && rawPrivateVpcMode !== "0" && rawPrivateVpcMode !== "1") {
    issues.push("insecure_private_vpc_mode_invalid");
  }
  if (privateVpcModeRequested) {
    if (!rawPrivateVpcHost) {
      issues.push("insecure_private_vpc_host_missing");
    } else if (!privateVpcHostCanonical) {
      issues.push("insecure_private_vpc_host_invalid");
    } else {
      if (!privateVpcHostAllowed) issues.push("insecure_private_vpc_host_not_private");
      if (endpoint && !privateVpcHostMatched) issues.push("insecure_private_vpc_host_mismatch");
    }
    if (!privateVpcContextValid) issues.push("insecure_private_vpc_mode_invalid");
  }
  if (rawExemption && rawExemption !== "1") issues.push("release_test_exemption_invalid");
  if (exemptionRequested && !exemptionContextValid) issues.push("release_test_exemption_invalid");

  if (production) {
    if (configuration.status !== "configured") issues.push("redis_not_configured");
    if (!configuration.required) issues.push("redis_not_required");
    if (configuration.enabled && !endpoint) issues.push("redis_endpoint_invalid");
    if (endpointScope === "local" && !testOnlyExemption) issues.push("redis_local_endpoint");
    if (endpoint && !tlsConfigured && !testOnlyExemption && !insecurePrivateVpcMode) {
      issues.push("redis_tls_missing");
    }
    if (endpoint && tlsConfigured && !configuration.tls) {
      issues.push(
        configuration.tlsCaMaterialPresent
          ? "redis_tls_ca_invalid"
          : "redis_tls_ca_missing",
      );
    }
    if (endpoint && !authConfigured && !testOnlyExemption) issues.push("redis_auth_missing");
  }

  return {
    production,
    valid: issues.length === 0,
    configured: configuration.status === "configured",
    required: configuration.required,
    endpointScope,
    tlsConfigured,
    authConfigured,
    insecurePrivateVpcMode,
    testOnlyExemption,
    issues: [...new Set(issues)],
  };
}

function resolveRedisConfiguration(environment: NodeJS.ProcessEnv): ResolvedRedisConfiguration {
  const primaryUrl = String(environment.FANJIN_REDIS_URL || "").trim();
  const fallbackUrl = String(environment.REDIS_URL || "").trim();
  const url = primaryUrl || fallbackUrl || null;
  const missingVariables: string[] = [];
  const invalidVariables: string[] = [];
  let enabled = Boolean(url);
  let required = false;
  let connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
  let commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
  let retryDelayMs = DEFAULT_RETRY_DELAY_MS;
  let maxValueBytes = DEFAULT_MAX_VALUE_BYTES;

  try {
    enabled = strictBoolean(environment, "FANJIN_REDIS_ENABLED", Boolean(url));
  } catch {
    invalidVariables.push("FANJIN_REDIS_ENABLED");
  }
  try {
    required = strictBoolean(environment, "FANJIN_REDIS_REQUIRED", false);
  } catch {
    invalidVariables.push("FANJIN_REDIS_REQUIRED");
  }
  try {
    connectTimeoutMs = strictInteger(
      environment,
      "FANJIN_REDIS_CONNECT_TIMEOUT_MS",
      DEFAULT_CONNECT_TIMEOUT_MS,
      100,
      30_000,
    );
  } catch {
    invalidVariables.push("FANJIN_REDIS_CONNECT_TIMEOUT_MS");
  }
  try {
    commandTimeoutMs = strictInteger(
      environment,
      "FANJIN_REDIS_COMMAND_TIMEOUT_MS",
      DEFAULT_COMMAND_TIMEOUT_MS,
      50,
      30_000,
    );
  } catch {
    invalidVariables.push("FANJIN_REDIS_COMMAND_TIMEOUT_MS");
  }
  try {
    retryDelayMs = strictInteger(
      environment,
      "FANJIN_REDIS_RETRY_DELAY_MS",
      DEFAULT_RETRY_DELAY_MS,
      100,
      60_000,
    );
  } catch {
    invalidVariables.push("FANJIN_REDIS_RETRY_DELAY_MS");
  }
  try {
    maxValueBytes = strictInteger(
      environment,
      "FANJIN_REDIS_MAX_VALUE_BYTES",
      DEFAULT_MAX_VALUE_BYTES,
      1_024,
      16 * 1024 * 1024,
    );
  } catch {
    invalidVariables.push("FANJIN_REDIS_MAX_VALUE_BYTES");
  }

  const configuredPrefix = String(environment.FANJIN_REDIS_KEY_PREFIX || "").trim();
  const prefix = configuredPrefix || defaultPrefix(environment);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(prefix)) {
    invalidVariables.push("FANJIN_REDIS_KEY_PREFIX");
  }
  if (enabled && isProductionEnvironment(environment) && !configuredPrefix) {
    // The Python root Agent and Node runtime must hash one explicit namespace;
    // production never relies on language-specific NODE_ENV defaults.
    missingVariables.push("FANJIN_REDIS_KEY_PREFIX");
  }

  let protocol: "redis:" | "rediss:" | null = null;
  let authConfigured = false;
  let endpoint: RedisEndpointIdentity | null = null;
  if (enabled && !url) missingVariables.push("FANJIN_REDIS_URL|REDIS_URL");
  if (url) {
    try {
      const parsed = new URL(url);
      endpoint = parseRedisEndpointIdentity(url);
      if (!endpoint) {
        invalidVariables.push("FANJIN_REDIS_URL|REDIS_URL");
      } else {
        protocol = parsed.protocol as "redis:" | "rediss:";
        authConfigured = Boolean(parsed.username || parsed.password);
      }
    } catch {
      invalidVariables.push("FANJIN_REDIS_URL|REDIS_URL");
    }
  }
  if (required && !enabled) invalidVariables.push("FANJIN_REDIS_REQUIRED");

  const resolvedTls = resolveRedisTlsConfiguration({
    environment,
    enabled,
    endpoint,
    missingVariables,
    invalidVariables,
  });

  const status: RedisConfigurationStatus = invalidVariables.length || missingVariables.length
    ? "invalid"
    : enabled
      ? "configured"
      : "disabled";
  return {
    status,
    enabled,
    required,
    url,
    tls: resolvedTls.tls,
    tlsCaMaterialPresent: resolvedTls.materialPresent,
    protocol,
    authConfigured,
    prefix,
    connectTimeoutMs,
    commandTimeoutMs,
    retryDelayMs,
    maxValueBytes,
    missingVariables,
    invalidVariables: [...new Set(invalidVariables)],
  };
}

export function inspectRedisConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RedisConfigurationInspection {
  const {
    url: _url,
    tls: _tls,
    tlsCaMaterialPresent: _tlsCaMaterialPresent,
    ...safe
  } = resolveRedisConfiguration(environment);
  return safe;
}

export function inspectRedisProductionTopology(
  environment: NodeJS.ProcessEnv = process.env,
): RedisProductionTopologyInspection {
  return inspectResolvedRedisProductionTopology(resolveRedisConfiguration(environment), environment);
}

class IoredisClientAdapter implements RedisClientAdapter {
  private readonly client: IORedis;

  constructor(options: Parameters<RedisClientFactory>[0]) {
    this.client = new IORedis(options.url, {
      lazyConnect: true,
      enableOfflineQueue: !options.disableOfflineQueue,
      connectTimeout: options.socket.connectTimeout,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      ...(options.tls ? { tls: options.tls } : {}),
    });
  }

  get isOpen(): boolean {
    return this.client.status !== "wait" && this.client.status !== "end";
  }

  get isReady(): boolean {
    return this.client.status === "ready";
  }

  connect(): Promise<unknown> {
    return this.client.connect();
  }

  ping(): Promise<string> {
    return this.client.ping();
  }

  time(): Promise<unknown> {
    return this.client.time();
  }

  info(section: string): Promise<string> {
    return this.client.info(section);
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  set(key: string, value: string, ttlMs: number): Promise<unknown> {
    return this.client.set(key, value, "PX", ttlMs);
  }

  del(key: string): Promise<number> {
    return this.client.del(key);
  }

  eval(script: string, keys: string[], arguments_: string[]): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...arguments_);
  }

  quit(): Promise<unknown> {
    return this.client.quit();
  }

  destroy(): void {
    this.client.disconnect(false);
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.client.on(event, listener);
    return this;
  }
}

function defaultClientFactory(options: Parameters<RedisClientFactory>[0]): RedisClientAdapter {
  return new IoredisClientAdapter(options);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RedisUnavailableError("Redis 命令超时")), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function validateTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CACHE_TTL_MS) {
    throw new TypeError("Redis TTL 超出安全范围");
  }
  return ttlMs;
}

function validateNamespace(namespace: string): string {
  const value = String(namespace || "").trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new TypeError("Redis namespace 无效");
  return value;
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const FIXED_WINDOW_SCRIPT = `
local time = redis.call("TIME")
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local duration = tonumber(ARGV[1])
local grace = tonumber(ARGV[2])
local minimum = tonumber(ARGV[3])
local floorRaw = redis.call("GET", KEYS[2])
local floor = floorRaw and tonumber(floorRaw) or nil
if floorRaw and (not floor or floor < 0) then
  return {"clock_floor_invalid"}
end
local requiredMinimum = minimum
if floor and floor > requiredMinimum then
  requiredMinimum = floor
end
if now < requiredMinimum then
  return {"clock_regression", string.format("%.0f", now), string.format("%.0f", requiredMinimum)}
end
if not floor or now > floor then
  redis.call("SET", KEYS[2], string.format("%.0f", now))
end
local windowStart = math.floor(now / duration) * duration
local key = KEYS[1] .. ":" .. string.format("%.0f", windowStart)
local ttl = (windowStart + duration - now) + grace
redis.call("SET", key, "0", "PX", ttl, "NX")
local count = redis.call("INCR", key)
return {"ok", count, string.format("%.0f", windowStart), string.format("%.0f", now)}
`;

const MONOTONIC_TIME_SCRIPT = `
local time = redis.call("TIME")
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local minimum = tonumber(ARGV[1])
local floorRaw = redis.call("GET", KEYS[1])
local floor = floorRaw and tonumber(floorRaw) or nil
if floorRaw and (not floor or floor < 0) then
  return {"clock_floor_invalid"}
end
local requiredMinimum = minimum
if floor and floor > requiredMinimum then
  requiredMinimum = floor
end
if now < requiredMinimum then
  return {"clock_regression", string.format("%.0f", now), string.format("%.0f", requiredMinimum)}
end
if not floor or now > floor then
  redis.call("SET", KEYS[1], string.format("%.0f", now))
end
return {"ok", string.format("%.0f", now)}
`;

const READ_ONLY_PROBE_SCRIPT = `return redis.call("GET", KEYS[1])`;
const PROBE_TTL_MS = 5_000;

function parseRedisTime(reply: unknown): number {
  const values = Array.isArray(reply) ? reply : [];
  const secondsText = String(values[0] ?? "");
  const microsecondsText = String(values[1] ?? "");
  if (!/^\d+$/.test(secondsText) || !/^\d+$/.test(microsecondsText)) {
    throw new RedisUnavailableError("Redis TIME 响应无效");
  }
  const seconds = Number(secondsText);
  const microseconds = Number(microsecondsText);
  if (
    !Number.isSafeInteger(seconds)
    || seconds < 0
    || !Number.isSafeInteger(microseconds)
    || microseconds < 0
    || microseconds > 999_999
  ) {
    throw new RedisUnavailableError("Redis TIME 响应无效");
  }
  const timestamp = seconds * 1_000 + Math.floor(microseconds / 1_000);
  if (!Number.isSafeInteger(timestamp)) throw new RedisUnavailableError("Redis TIME 超出安全范围");
  return timestamp;
}

function parseMaxmemoryPolicy(reply: unknown): string | null {
  if (typeof reply !== "string") return null;
  const match = reply.match(/(?:^|\r?\n)maxmemory_policy:([^\r\n]+)(?:\r?\n|$)/i);
  return match?.[1]?.trim().toLowerCase() || null;
}

export class RedisCacheRuntime {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly clientFactory: RedisClientFactory;
  private readonly now: () => number;
  private readonly random: () => number;
  private configuration: ResolvedRedisConfiguration;
  private client: RedisClientAdapter | null = null;
  private connecting: Promise<boolean> | null = null;
  private nextRetryAt = 0;
  private consecutiveFailures = 0;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;

  constructor(options: {
    environment?: NodeJS.ProcessEnv;
    clientFactory?: RedisClientFactory;
    now?: () => number;
    random?: () => number;
  } = {}) {
    this.environment = options.environment || process.env;
    this.clientFactory = options.clientFactory || defaultClientFactory;
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.configuration = resolveRedisConfiguration(this.environment);
  }

  inspection(): RedisConfigurationInspection {
    const {
      url: _url,
      tls: _tls,
      tlsCaMaterialPresent: _tlsCaMaterialPresent,
      ...safe
    } = this.configuration;
    return { ...safe, missingVariables: [...safe.missingVariables], invalidVariables: [...safe.invalidVariables] };
  }

  runtimeIdentity(): RedisRuntimeIdentity {
    const topology = this.productionTopologyInspection();
    const rawPrivateVpcMode = String(
      this.environment[ALLOW_INSECURE_PRIVATE_VPC_REDIS_ENV] || "",
    ).trim();
    const rawPrivateVpcHost = String(
      this.environment[INSECURE_PRIVATE_VPC_REDIS_HOST_ENV] || "",
    ).trim();
    return {
      ...this.inspection(),
      endpoint: this.configuration.url
        ? parseRedisEndpointIdentity(this.configuration.url)
        : null,
      transportPolicy: {
        allowInsecurePrivateVpc: rawPrivateVpcMode || "0",
        insecurePrivateVpcHost: rawPrivateVpcHost || null,
        insecurePrivateVpcMode: topology.insecurePrivateVpcMode,
      },
      tls: this.configuration.tls
        ? {
            caSha256: crypto
              .createHash("sha256")
              .update(Buffer.from(this.configuration.tls.ca, "utf8"))
              .digest("hex"),
            serverName: this.configuration.tls.servername,
            minVersion: this.configuration.tls.minVersion,
            rejectUnauthorized: this.configuration.tls.rejectUnauthorized,
          }
        : null,
    };
  }

  productionTopologyInspection(): RedisProductionTopologyInspection {
    return inspectResolvedRedisProductionTopology(this.configuration, this.environment);
  }

  isConfigured(): boolean {
    return this.configuration.status === "configured";
  }

  isRequired(): boolean {
    return this.configuration.required;
  }

  snapshot(): RedisRuntimeSnapshot {
    const ready = Boolean(this.client?.isReady);
    return {
      configured: this.isConfigured(),
      required: this.isRequired(),
      ready,
      status: this.configuration.status === "configured"
        ? ready ? "ready" : "unavailable"
        : this.configuration.status,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }

  async start(): Promise<boolean> {
    const topology = this.productionTopologyInspection();
    // In production, if any Redis configuration was attempted but the topology
    // is invalid, fail hard. Only allow startup when Redis is completely absent.
    if (topology.production && !topology.valid && topology.configured) {
      throw new RedisUnavailableError("生产 Redis 拓扑配置无效");
    }
    if (this.configuration.status === "invalid") {
      throw new RedisUnavailableError("Redis 配置无效");
    }
    // Connectivity failures keep the process alive so health/diagnostics stay
    // available, while /ready keeps the node out of traffic until probe()
    // succeeds. Invalid static configuration still fails startup above.
    return await this.ensureReady();
  }

  async probe(): Promise<RedisRuntimeProbe> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        required: this.isRequired(),
        ready: !this.isRequired() && this.configuration.status === "disabled",
        latencyMs: null,
        status: this.configuration.status,
      };
    }
    const startedAt = this.now();
    const client = await this.readyClient();
    if (!client) {
      return {
        configured: true,
        required: this.isRequired(),
        ready: false,
        latencyMs: null,
        status: "unavailable",
      };
    }
    try {
      const pong = await this.command(client.ping());
      if (String(pong).toUpperCase() !== "PONG") throw new RedisUnavailableError("Redis PING 响应无效");
      parseRedisTime(await this.command(client.time()));
      if (this.isRequired()) {
        const policy = parseMaxmemoryPolicy(await this.command(client.info("memory")));
        if (policy !== "noeviction") {
          throw new RedisUnavailableError("Redis 必须使用 noeviction 内存策略");
        }
      }

      // PING alone can succeed for a user that lacks the commands required by
      // cache-aside and the distributed counter. Exercise the minimal ACL
      // surface with an opaque, short-lived key before declaring readiness.
      const probeNonce = crypto.randomUUID();
      const probeKey = `${this.configuration.prefix}:probe:${digest(probeNonce)}`;
      const probeValue = digest(`value:${probeNonce}`);
      const setReply = await this.command(client.set(probeKey, probeValue, PROBE_TTL_MS));
      if (String(setReply).toUpperCase() !== "OK") throw new RedisUnavailableError("Redis SET 响应无效");
      const getReply = await this.command(client.get(probeKey));
      if (getReply !== probeValue) throw new RedisUnavailableError("Redis GET 响应无效");
      const evalReply = await this.command(client.eval(READ_ONLY_PROBE_SCRIPT, [probeKey], []));
      if (evalReply !== probeValue) throw new RedisUnavailableError("Redis EVAL 响应无效");
      const deleteReply = await this.command(client.del(probeKey));
      if (deleteReply !== 1) throw new RedisUnavailableError("Redis DEL 响应无效");

      // Exercise the exact counter script. SET ... PX ... NX occurs before INCR,
      // so even a later ACL/runtime error can leave only a short-lived zero key,
      // never an immortal partial counter. The shared clock floor is deliberately
      // persistent and is also used by live counters to detect Redis TIME rollback.
      const counterProbeKey = `${this.configuration.prefix}:counter:v2:probe:${PROBE_TTL_MS}:${digest(probeNonce)}`;
      const counterReply = this.parseFixedWindowReply(await this.command(client.eval(
        FIXED_WINDOW_SCRIPT,
        [counterProbeKey, this.counterClockFloorKey()],
        // Without grace a probe issued at the last millisecond of a window can
        // expire before the following DEL round trip and create false-negative
        // readiness. Keep at least one full probe TTL for cleanup to observe it.
        [String(PROBE_TTL_MS), String(PROBE_TTL_MS), "0"],
      )));
      const counterDeleteReply = await this.command(client.del(
        `${counterProbeKey}:${counterReply.windowStart}`,
      ));
      if (counterDeleteReply !== 1) throw new RedisUnavailableError("Redis counter DEL 响应无效");
      this.markSuccess();
      return {
        configured: true,
        required: this.isRequired(),
        ready: true,
        latencyMs: this.now() - startedAt,
        status: "ready",
      };
    } catch {
      // A protocol-invalid successful response does not pass through
      // command()'s rejection path, so explicitly discard that connection too.
      if (this.client === client) {
        client.destroy();
        this.client = null;
      }
      this.markFailure();
      return {
        configured: true,
        required: this.isRequired(),
        ready: false,
        latencyMs: this.now() - startedAt,
        status: "unavailable",
      };
    }
  }

  async getJson<T>(
    namespace: string,
    key: string,
    validator?: (value: unknown) => value is T,
  ): Promise<RedisCacheReadResult<T>> {
    const client = await this.readyClient();
    if (!client) return { available: false, hit: false, value: null };
    const cacheKey = this.cacheKey(namespace, key);
    let raw: string | null;
    try {
      raw = await this.command(client.get(cacheKey));
      this.markSuccess();
    } catch {
      this.markFailure();
      return { available: false, hit: false, value: null };
    }
    if (raw === null) return { available: true, hit: false, value: null };

    // Parsing is intentionally outside the Redis command failure boundary.
    // One malformed/old cache entry is not evidence that the shared Redis
    // service is unavailable. Delete only that entry and let the caller refill
    // it through the authoritative PostgreSQL path.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.discardInvalidValue(client, cacheKey);
      return { available: true, hit: false, value: null };
    }
    if (validator && !validator(parsed)) {
      await this.discardInvalidValue(client, cacheKey);
      return { available: true, hit: false, value: null };
    }
    return { available: true, hit: true, value: parsed as T };
  }

  async setJson(namespace: string, key: string, value: unknown, ttlMs: number): Promise<boolean> {
    const client = await this.readyClient();
    if (!client) return false;
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > this.configuration.maxValueBytes) {
      throw new TypeError("Redis 缓存值超过大小限制");
    }
    try {
      await this.command(client.set(this.cacheKey(namespace, key), serialized, validateTtl(ttlMs)));
      this.markSuccess();
      return true;
    } catch {
      this.markFailure();
      return false;
    }
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const client = await this.readyClient();
    if (!client) return false;
    try {
      await this.command(client.del(this.cacheKey(namespace, key)));
      this.markSuccess();
      return true;
    } catch {
      this.markFailure();
      return false;
    }
  }

  /** Atomic expiring connection leases shared by every API node. Reads never renew them. */
  async connectionPresence(namespace: string, key: string, connectionId: string | null, action: "read" | "heartbeat" | "disconnect", ttlMs: number): Promise<{ count: number; remainingMs: number } | null> {
    validateTtl(ttlMs);
    const client = await this.readyClient();
    if (!client) return null;
    try {
      const result = await this.command(client.eval(`
        local time = redis.call('TIME')
        local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
        if ARGV[1] == 'heartbeat' then
          if not redis.call('ZSCORE', KEYS[1], ARGV[2]) and redis.call('ZCARD', KEYS[1]) >= 32 then return {-1, 0} end
          redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[2])
          redis.call('PEXPIRE', KEYS[1], ARGV[3])
        elseif ARGV[1] == 'disconnect' then
          redis.call('ZREM', KEYS[1], ARGV[2])
        end
        local last = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
        return {redis.call('ZCARD', KEYS[1]), last[2] and math.max(0, tonumber(last[2]) - now) or 0}
      `, [this.cacheKey(namespace, key)], [action, connectionId || "", String(ttlMs)]));
      if (!Array.isArray(result) || result.length !== 2 || result.some(value => !Number.isSafeInteger(Number(value)))) return null;
      const [count, remainingMs] = result.map(Number);
      if (count < 0 || count > 32 || remainingMs < 0 || remainingMs > ttlMs) return null;
      this.markSuccess();
      return { count, remainingMs };
    } catch { this.markFailure(); return null; }
  }

  async incrementFixedWindow(input: {
    namespace: string;
    bucket: string;
    durationMs: number;
    ttlGraceMs: number;
    minimumTimeMs?: number;
  }): Promise<{ count: number; windowStart: number; serverTimeMs: number } | null> {
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 1) {
      throw new TypeError("Redis 计数窗口无效");
    }
    if (!Number.isSafeInteger(input.ttlGraceMs) || input.ttlGraceMs < 0) {
      throw new TypeError("Redis 计数 TTL 宽限无效");
    }
    validateTtl(input.durationMs + input.ttlGraceMs);
    const minimumTimeMs = input.minimumTimeMs ?? 0;
    if (!Number.isSafeInteger(minimumTimeMs) || minimumTimeMs < 0) {
      throw new TypeError("Redis 计数最小时钟无效");
    }
    const client = await this.readyClient();
    if (!client) return null;
    const key = `${this.configuration.prefix}:counter:v2:${validateNamespace(input.namespace)}:${input.durationMs}:${digest(input.bucket)}`;
    try {
      const result = this.parseFixedWindowReply(await this.command(client.eval(
        FIXED_WINDOW_SCRIPT,
        [key, this.counterClockFloorKey()],
        [String(input.durationMs), String(input.ttlGraceMs), String(minimumTimeMs)],
      )));
      this.markSuccess();
      return result;
    } catch {
      this.markFailure();
      return null;
    }
  }

  /** Return Redis server time for a synchronized database-to-Redis cutover. */
  async serverTimeMs(): Promise<number | null> {
    const client = await this.readyClient();
    if (!client) return null;
    try {
      const timestamp = parseRedisTime(await this.command(client.time()));
      this.markSuccess();
      return timestamp;
    } catch {
      this.markFailure();
      return null;
    }
  }

  /**
   * Observe Redis TIME while atomically enforcing the shared high-water mark.
   * Scheduled database-backed rate-limit requests use this so a Redis clock
   * rollback cannot reopen a previously elapsed PostgreSQL window.
   */
  async monotonicServerTimeMs(minimumTimeMs = 0): Promise<number | null> {
    if (!Number.isSafeInteger(minimumTimeMs) || minimumTimeMs < 0) {
      throw new TypeError("Redis 最小时钟无效");
    }
    const client = await this.readyClient();
    if (!client) return null;
    try {
      const reply = await this.command(client.eval(
        MONOTONIC_TIME_SCRIPT,
        [this.counterClockFloorKey()],
        [String(minimumTimeMs)],
      ));
      const values = Array.isArray(reply) ? reply : [];
      if (values[0] !== "ok") {
        throw new RedisUnavailableError(
          values[0] === "clock_regression"
            ? "Redis TIME 发生回拨"
            : "Redis TIME 响应无效",
        );
      }
      const timestamp = Number(values[1]);
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new RedisUnavailableError("Redis TIME 响应无效");
      }
      this.markSuccess();
      return timestamp;
    } catch {
      this.markFailure();
      return null;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    this.nextRetryAt = 0;
    if (!client) return;
    try {
      if (client.isOpen) await withTimeout(client.quit(), this.configuration.commandTimeoutMs);
      else client.destroy();
    } catch {
      client.destroy();
    }
  }

  private cacheKey(namespace: string, key: string): string {
    return `${this.configuration.prefix}:cache:${validateNamespace(namespace)}:${digest(String(key))}`;
  }

  private counterClockFloorKey(): string {
    return `${this.configuration.prefix}:counter:v2:clock-floor`;
  }

  private parseFixedWindowReply(reply: unknown): {
    count: number;
    windowStart: number;
    serverTimeMs: number;
  } {
    const values = Array.isArray(reply) ? reply : [];
    if (values[0] !== "ok") {
      throw new RedisUnavailableError(
        values[0] === "clock_regression"
          ? "Redis TIME 发生回拨"
          : "Redis 计数响应无效",
      );
    }
    const count = Number(values[1]);
    const windowStart = Number(values[2]);
    const serverTimeMs = Number(values[3]);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RedisUnavailableError("Redis 计数响应无效");
    }
    if (!Number.isSafeInteger(windowStart) || windowStart < 0) {
      throw new RedisUnavailableError("Redis 窗口响应无效");
    }
    if (!Number.isSafeInteger(serverTimeMs) || serverTimeMs < 0) {
      throw new RedisUnavailableError("Redis TIME 响应无效");
    }
    return { count, windowStart, serverTimeMs };
  }

  private async readyClient(): Promise<RedisClientAdapter | null> {
    return await this.ensureReady() ? this.client : null;
  }

  private async ensureReady(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    if (this.client?.isReady) return true;
    if (this.connecting) return await this.connecting;
    if (this.now() < this.nextRetryAt) return false;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<boolean> {
    const url = this.configuration.url;
    if (!url) return false;
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    let client: RedisClientAdapter | null = null;
    try {
      client = this.clientFactory({
        url,
        disableOfflineQueue: true,
        ...(this.configuration.tls ? { tls: this.configuration.tls } : {}),
        socket: {
          connectTimeout: this.configuration.connectTimeoutMs,
          reconnectStrategy: false,
        },
      });
      client.on("error", () => {
        // Detailed client errors can contain the private endpoint, so runtime
        // observability exposes only sanitized state.
        this.lastFailureAt = this.now();
      });
      this.client = client;
      await withTimeout(client.connect(), this.configuration.connectTimeoutMs + 250);
      if (!client.isReady) throw new RedisUnavailableError("Redis 连接未就绪");
      return true;
    } catch {
      client?.destroy();
      if (this.client === client) this.client = null;
      this.markFailure();
      return false;
    }
  }

  private async command<T>(promise: Promise<T>): Promise<T> {
    try {
      return await withTimeout(promise, this.configuration.commandTimeoutMs);
    } catch (error) {
      const client = this.client;
      if (client) client.destroy();
      this.client = null;
      throw error;
    }
  }

  private async discardInvalidValue(client: RedisClientAdapter, cacheKey: string): Promise<void> {
    try {
      await this.command(client.del(cacheKey));
      this.markSuccess();
    } catch {
      // The successful GET still proves that Redis was available for this
      // read. Cleanup failure is recorded for reconnection/backoff, but a
      // corrupt cache payload remains a cache miss rather than an outage.
      this.markFailure();
    }
  }

  private markSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = this.now();
    this.nextRetryAt = 0;
  }

  private markFailure(scheduleRetry = true): void {
    this.consecutiveFailures += 1;
    const failedAt = this.now();
    this.lastFailureAt = failedAt;
    if (!scheduleRetry) return;

    const exponent = Math.min(this.consecutiveFailures - 1, MAX_RETRY_BACKOFF_EXPONENT);
    const exponentialDelay = Math.min(
      MAX_RETRY_BACKOFF_MS,
      this.configuration.retryDelayMs * (2 ** exponent),
    );
    // Equal jitter retains exponential growth while avoiding a synchronized
    // reconnect stampede when every API node observes the same outage.
    const randomSample = this.random();
    const random = Number.isFinite(randomSample)
      ? Math.min(1, Math.max(0, randomSample))
      : 0.5;
    const jitteredDelay = Math.max(1, Math.round(exponentialDelay * (0.5 + random * 0.5)));
    this.nextRetryAt = failedAt + jitteredDelay;
  }
}

export const redisCache = new RedisCacheRuntime();
