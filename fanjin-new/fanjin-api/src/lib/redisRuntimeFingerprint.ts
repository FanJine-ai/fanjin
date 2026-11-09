import crypto from "node:crypto";
import { inspectRedisBusinessCacheConfiguration } from "@/lib/cacheAside";
import { inspectDistributedRateLimitConfiguration } from "@/lib/distributedRateLimit";
import { RedisCacheRuntime, redisCache } from "@/lib/redisCache";

const REDIS_RUNTIME_FINGERPRINT_SCHEMA = "fanjin-redis-runtime/v2";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Redis 指纹包含不可序列化值");
  return serialized;
}

/**
 * Hash only canonical, behavior-affecting Redis identity. Credentials and the
 * raw URL never leave RedisCacheRuntime; the ACL username is already reduced
 * to a SHA-256 identity and password rotation does not change the data source.
 */
export function redisRuntimeFingerprint(options: {
  environment?: NodeJS.ProcessEnv;
  redis?: RedisCacheRuntime;
} = {}): string {
  const environment = options.environment || process.env;
  // A caller supplying an explicit environment is asking for the identity of
  // that complete runtime configuration. Do not accidentally combine those
  // variables with the process-global Redis client, which was constructed
  // from process.env during module initialization.
  const redis = options.redis || (
    options.environment ? new RedisCacheRuntime({ environment }) : redisCache
  );
  const identity = redis.runtimeIdentity();
  const rateLimit = inspectDistributedRateLimitConfiguration({
    environment,
    now: 0,
    redis,
  });
  const businessCache = inspectRedisBusinessCacheConfiguration(environment);
  const material = {
    schema: REDIS_RUNTIME_FINGERPRINT_SCHEMA,
    redis: {
      status: identity.status,
      enabled: identity.enabled,
      required: identity.required,
      endpoint: identity.endpoint,
      transportPolicy: identity.transportPolicy,
      ...(identity.tls ? { tls: identity.tls } : {}),
      prefix: identity.prefix,
      connectTimeoutMs: identity.connectTimeoutMs,
      commandTimeoutMs: identity.commandTimeoutMs,
      retryDelayMs: identity.retryDelayMs,
      maxValueBytes: identity.maxValueBytes,
      missingVariables: [...identity.missingVariables].sort(),
      invalidVariables: [...identity.invalidVariables].sort(),
    },
    rateLimit: {
      valid: rateLimit.valid,
      enabled: rateLimit.redisEnabled,
      cutoverAtMs: rateLimit.cutoverAtMs,
      windowsMs: [...rateLimit.windowsMs].sort((left, right) => left - right),
      ttlGraceMs: rateLimit.ttlGraceMs,
      invalidVariables: [...rateLimit.invalidVariables].sort(),
    },
    businessCache: {
      status: businessCache.status,
      enabled: businessCache.enabled,
      invalidVariables: [...businessCache.invalidVariables].sort(),
    },
  };
  return crypto.createHash("sha256").update(canonicalJson(material), "utf8").digest("hex");
}
