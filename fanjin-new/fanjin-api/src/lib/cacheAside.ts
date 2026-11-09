import crypto from "node:crypto";
import {
  redisCache,
  type RedisCacheReadResult,
} from "@/lib/redisCache";

type CacheKeyPart = string | number | boolean;

export interface CacheAsideStore {
  getJson<T>(
    namespace: string,
    key: string,
    validator?: (value: unknown) => value is T,
  ): Promise<RedisCacheReadResult<T>>;
  setJson(namespace: string, key: string, value: unknown, ttlMs: number): Promise<boolean>;
}

export interface CacheAsideOptions<T> {
  namespace: string;
  schemaVersion: string;
  keyParts: Readonly<Record<string, CacheKeyPart>>;
  ttlMs: number;
  jitterRatio?: number;
  validator: (value: unknown) => value is T;
  load: () => Promise<T>;
  store?: CacheAsideStore;
  random?: () => number;
}

const DEFAULT_JITTER_RATIO = 0.2;
const singleflight = new Map<string, Promise<unknown>>();

export const REDIS_BUSINESS_CACHE_ENABLED_ENV = "FANJIN_REDIS_BUSINESS_CACHE_ENABLED";

export interface RedisBusinessCacheConfigurationInspection {
  status: "enabled" | "disabled" | "invalid";
  enabled: boolean;
  invalidVariables: string[];
}

export function inspectRedisBusinessCacheConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RedisBusinessCacheConfigurationInspection {
  const raw = String(environment[REDIS_BUSINESS_CACHE_ENABLED_ENV] || "").trim().toLowerCase();
  if (!raw || ["0", "false", "no", "off"].includes(raw)) {
    return { status: "disabled", enabled: false, invalidVariables: [] };
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return { status: "enabled", enabled: true, invalidVariables: [] };
  }
  return {
    status: "invalid",
    enabled: false,
    invalidVariables: [REDIS_BUSINESS_CACHE_ENABLED_ENV],
  };
}

export class CacheAsideSourceValidationError extends Error {
  readonly code = "cache_aside_source_validation_failed";

  constructor() {
    super("权威数据未通过缓存 DTO 校验");
    this.name = "CacheAsideSourceValidationError";
  }
}

function assertToken(value: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(normalized)) {
    throw new TypeError(`${label} 无效`);
  }
  return normalized;
}

function safeValidate<T>(validator: (value: unknown) => value is T, value: unknown): value is T {
  try {
    return validator(value);
  } catch {
    return false;
  }
}

/**
 * Builds a bounded, opaque cache key from explicit visibility dimensions.
 * Sorted tuples avoid property-order differences; JSON tuples avoid delimiter
 * collisions such as { workspace: "a:b", type: "c" } vs the inverse.
 */
export function buildCacheIsolationKey(input: {
  schemaVersion: string;
  keyParts: Readonly<Record<string, CacheKeyPart>>;
}): string {
  const schemaVersion = assertToken(input.schemaVersion, "缓存 schemaVersion");
  const entries = Object.entries(input.keyParts)
    .map(([name, value]) => {
      const normalizedName = assertToken(name, "缓存键维度");
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError(`缓存键维度 ${normalizedName} 无效`);
      }
      return [normalizedName, typeof value, String(value)] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) throw new TypeError("缓存键至少需要一个隔离维度");

  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([schemaVersion, entries]), "utf8")
    .digest("hex");
  return `${schemaVersion}:${digest}`;
}

export function jitterCacheTtl(
  ttlMs: number,
  jitterRatio = DEFAULT_JITTER_RATIO,
  random: () => number = Math.random,
): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("缓存 TTL 无效");
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 0.5) {
    throw new TypeError("缓存 TTL jitterRatio 无效");
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new TypeError("缓存 TTL 随机数无效");
  }
  const multiplier = 1 + ((sample * 2) - 1) * jitterRatio;
  return Math.max(1, Math.round(ttlMs * multiplier));
}

/**
 * Read-only cache-aside helper. Redis is never authoritative: every miss,
 * malformed value, validator rejection, or cache error loads the source of
 * truth. A per-process singleflight prevents a cold key from stampeding the
 * database; Redis failures are deliberately swallowed after source success.
 */
export async function cacheAside<T>(options: CacheAsideOptions<T>): Promise<T> {
  const namespace = assertToken(options.namespace, "缓存 namespace");
  const cacheKey = buildCacheIsolationKey(options);
  const store = options.store ?? redisCache;
  const validator = (value: unknown): value is T => safeValidate(options.validator, value);

  try {
    const cached = await store.getJson<T>(namespace, cacheKey, validator);
    // Revalidate here instead of trusting a custom store implementation.
    if (cached.hit && validator(cached.value)) return cached.value;
  } catch {
    // Redis/cache adapters are optional acceleration only.
  }

  const flightKey = `${namespace}:${cacheKey}`;
  const active = singleflight.get(flightKey);
  if (active) return await active as T;

  const flight = (async () => {
    const fresh = await options.load();
    // PostgreSQL remains authoritative, while the DTO contract remains the
    // response boundary. Never cache or return an unexpectedly unsafe shape.
    if (!validator(fresh)) throw new CacheAsideSourceValidationError();
    try {
      await store.setJson(
        namespace,
        cacheKey,
        fresh,
        jitterCacheTtl(options.ttlMs, options.jitterRatio, options.random),
      );
    } catch {
      // Successful source reads must not fail because cache population failed.
    }
    return fresh;
  })();

  singleflight.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (singleflight.get(flightKey) === flight) singleflight.delete(flightKey);
  }
}
