import type { Knex } from "knex";
import { redisCache, type RedisCacheRuntime } from "@/lib/redisCache";
import {
  RedisRateLimitCutoverError,
  activateRedisRateLimitCutover,
  readRedisRateLimitCutoverState,
  type RedisRateLimitCutoverState,
} from "@/lib/redisRateLimitCutover";
import { db } from "@/utils/db";

const DEFAULT_TTL_GRACE_MS = 5_000;
const REQUIRED_API_KEY_WINDOW_MS = 60_000;
const MAX_REDIS_COUNTER_TTL_MS = 7 * 24 * 60 * 60_000;
const SCHEDULED_CUTOVER_CACHE_TTL_MS = 250;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const REDIS_RATE_LIMIT_RUNTIME_CAPABILITY = "redis-rate-limit-v1";
export const MODEL_RATE_LIMIT_ENABLED_KEY = "platform.gateway.modelRateLimitEnabled";
export const MODEL_RATE_LIMIT_DURATION_KEY = "platform.gateway.modelRateLimitDurationMinutes";
export const DISTRIBUTED_RATE_LIMIT_SETTING_KEYS = [
  MODEL_RATE_LIMIT_ENABLED_KEY,
  MODEL_RATE_LIMIT_DURATION_KEY,
] as const;

export type RateLimitBackend = "redis" | "postgres" | "sqlite" | "disabled";

export interface FixedWindowConsumption {
  backend: RateLimitBackend;
  count: number;
  limit: number;
  windowStart: number;
  windowEnd: number;
  exceeded: boolean;
}

export class DistributedRateLimitUnavailableError extends Error {
  readonly code = "rate_limit_unavailable";
  readonly status = 503;

  constructor(message = "分布式限流服务暂不可用") {
    super(message);
    this.name = "DistributedRateLimitUnavailableError";
  }
}

export type DistributedRateLimitMode = "database" | "redis_pending" | "redis" | "invalid";

export interface DistributedRateLimitConfigurationInspection {
  mode: DistributedRateLimitMode;
  valid: boolean;
  redisEnabled: boolean;
  redisActive: boolean;
  cutoverAtMs: number | null;
  ttlGraceMs: number;
  windowsMs: number[];
  invalidVariables: string[];
}

export interface DistributedRateLimitWindowSettingsInspection {
  valid: boolean;
  modelEnabled: boolean;
  modelDurationMs: number | null;
  invalidSettings: string[];
}

export type DistributedRateLimitCutoverRuntimeErrorCode =
  | RedisRateLimitCutoverError["code"]
  | "redis_rate_limit_cutover_configuration_mismatch"
  | "redis_rate_limit_cutover_contract_mismatch"
  | "redis_rate_limit_cutover_state_missing"
  | "redis_rate_limit_cutover_time_unavailable";

/**
 * Safe operational view of the durable cutover latch. The persisted/runtime
 * fingerprints are deliberately reduced to an equality result: neither raw
 * configuration material nor the full persisted digest is reflected here.
 */
export interface DistributedRateLimitCutoverRuntimeInspection {
  valid: boolean;
  state: RedisRateLimitCutoverState["state"] | null;
  active: boolean;
  contractMatched: boolean | null;
  cutoverAtMs: number | null;
  scheduledAtRedisMs: number | null;
  activatedAtRedisMs: number | null;
  redisServerTimeMs: number | null;
  errorCode: DistributedRateLimitCutoverRuntimeErrorCode | null;
}

interface CachedCutoverState {
  state: Exclude<RedisRateLimitCutoverState, { state: "unarmed" }>;
  expiresAtProcessMs: number;
}

// A scheduled state is immutable except for its one-way transition to active,
// so a very short read cache is safe as long as every request still checks
// Redis TIME. Active is memoized for the lifetime of the process: even if an
// operator later disables/removes the environment variables, this process can
// only use Redis or fail closed; it can never resume PostgreSQL counters.
let cutoverStateCache = new WeakMap<object, CachedCutoverState>();

function cutoverCacheKey(database: Knex): object {
  return database as unknown as object;
}

function rememberCutoverState(
  database: Knex,
  state: Exclude<RedisRateLimitCutoverState, { state: "unarmed" }>,
): void {
  cutoverStateCache.set(cutoverCacheKey(database), {
    state,
    expiresAtProcessMs: state.state === "active"
      ? Number.POSITIVE_INFINITY
      : Date.now() + SCHEDULED_CUTOVER_CACHE_TTL_MS,
  });
}

async function durableCutoverState(database: Knex): Promise<RedisRateLimitCutoverState> {
  const key = cutoverCacheKey(database);
  const cached = cutoverStateCache.get(key);
  if (
    cached
    && (cached.state.state === "active" || Date.now() < cached.expiresAtProcessMs)
  ) {
    return cached.state;
  }
  const state = await readRedisRateLimitCutoverState(database);
  // Do not cache absence. During the capability-first rollout, the controller
  // may arm the latch between any two requests; caching unarmed could otherwise
  // leave a node on PostgreSQL past a newly scheduled cutover boundary.
  if (state.state !== "unarmed") rememberCutoverState(database, state);
  else cutoverStateCache.delete(key);
  return state;
}

function cutoverErrorCode(error: unknown): DistributedRateLimitCutoverRuntimeErrorCode {
  return error instanceof RedisRateLimitCutoverError
    ? error.code
    : "redis_rate_limit_cutover_unavailable";
}

function failedCutoverInspection(
  state: RedisRateLimitCutoverState | null,
  redisServerTimeMs: number | null,
  errorCode: DistributedRateLimitCutoverRuntimeErrorCode,
  contractMatched: boolean | null = null,
): DistributedRateLimitCutoverRuntimeInspection {
  return {
    valid: false,
    state: state?.state ?? null,
    active: state?.state === "active",
    contractMatched,
    cutoverAtMs: state?.cutoverAtMs ?? null,
    scheduledAtRedisMs: state?.scheduledAtRedisMs ?? null,
    activatedAtRedisMs: state?.activatedAtRedisMs ?? null,
    redisServerTimeMs,
    errorCode,
  };
}

async function resolveDistributedRateLimitCutover(input: {
  database: Knex;
  redis: RedisCacheRuntime;
  environment: NodeJS.ProcessEnv;
  runtimeFingerprint: string | (() => Promise<string>);
  redisServerTimeMs?: number | null;
  deferActiveRedisTime?: boolean;
  allowActivation?: boolean;
}): Promise<{
  inspection: DistributedRateLimitCutoverRuntimeInspection;
  state: RedisRateLimitCutoverState | null;
}> {
  let state: RedisRateLimitCutoverState;
  try {
    state = await durableCutoverState(input.database);
  } catch (error) {
    return {
      inspection: failedCutoverInspection(null, input.redisServerTimeMs ?? null, cutoverErrorCode(error)),
      state: null,
    };
  }

  if (state.state === "unarmed") {
    const configuration = inspectDistributedRateLimitConfiguration({
      environment: input.environment,
      now: 0,
      redis: input.redis,
    });
    if (configuration.redisEnabled) {
      if (!configuration.valid || configuration.cutoverAtMs === null) {
        return {
          state,
          inspection: failedCutoverInspection(
            state,
            input.redisServerTimeMs ?? null,
            "redis_rate_limit_cutover_configuration_mismatch",
            false,
          ),
        };
      }
      let redisServerTimeMs: number | null;
      try {
        redisServerTimeMs = input.redisServerTimeMs === undefined
          ? await input.redis.monotonicServerTimeMs(0)
          : input.redisServerTimeMs;
      } catch {
        redisServerTimeMs = null;
      }
      if (redisServerTimeMs === null
        || !Number.isSafeInteger(redisServerTimeMs)
        || redisServerTimeMs < 0) {
        return {
          state,
          inspection: failedCutoverInspection(
            state,
            null,
            "redis_rate_limit_cutover_time_unavailable",
            true,
          ),
        };
      }
      // An absent row is only a valid pre-arm representation before the
      // configured boundary. If an active/scheduled row is deleted, every new
      // process must fail closed instead of silently reopening PostgreSQL.
      if (redisServerTimeMs >= configuration.cutoverAtMs) {
        return {
          state,
          inspection: failedCutoverInspection(
            state,
            redisServerTimeMs,
            "redis_rate_limit_cutover_state_missing",
            false,
          ),
        };
      }
      return {
        state,
        inspection: {
          valid: true,
          state: "unarmed",
          active: false,
          contractMatched: null,
          cutoverAtMs: null,
          scheduledAtRedisMs: null,
          activatedAtRedisMs: null,
          redisServerTimeMs,
          errorCode: null,
        },
      };
    }
    return {
      state,
      inspection: {
        valid: true,
        state: "unarmed",
        active: false,
        contractMatched: null,
        cutoverAtMs: null,
        scheduledAtRedisMs: null,
        activatedAtRedisMs: null,
        redisServerTimeMs: input.redisServerTimeMs ?? null,
        errorCode: null,
      },
    };
  }

  const configuration = inspectDistributedRateLimitConfiguration({
    environment: input.environment,
    now: 0,
    redis: input.redis,
  });
  if (
    !configuration.valid
    || !configuration.redisEnabled
    || configuration.cutoverAtMs !== state.cutoverAtMs
  ) {
    return {
      state,
      inspection: failedCutoverInspection(
        state,
        input.redisServerTimeMs ?? null,
        "redis_rate_limit_cutover_configuration_mismatch",
        false,
      ),
    };
  }
  let runtimeFingerprint: string;
  try {
    runtimeFingerprint = typeof input.runtimeFingerprint === "string"
      ? input.runtimeFingerprint
      : await input.runtimeFingerprint();
  } catch {
    return {
      state,
      inspection: failedCutoverInspection(
        state,
        input.redisServerTimeMs ?? null,
        "redis_rate_limit_cutover_contract_mismatch",
        false,
      ),
    };
  }
  if (!SHA256_PATTERN.test(runtimeFingerprint)) {
    return {
      state,
      inspection: failedCutoverInspection(
        state,
        input.redisServerTimeMs ?? null,
        "redis_rate_limit_cutover_contract_mismatch",
        false,
      ),
    };
  }
  const contractMatched = state.contractFingerprint === runtimeFingerprint;
  if (!contractMatched) {
    return {
      state,
      inspection: failedCutoverInspection(
        state,
        input.redisServerTimeMs ?? null,
        "redis_rate_limit_cutover_contract_mismatch",
        false,
      ),
    };
  }

  // Once the durable latch is already active, the counter Lua script is the
  // only authority allowed to read Redis TIME: it compares that timestamp with
  // both activatedAtRedisMs and the shared monotonic clock floor in the same
  // atomic operation that writes the counter. Readiness still requests an
  // explicit time sample, while the hot request path defers it to the script.
  const redisServerTimeDeferred = state.state === "active"
    && input.deferActiveRedisTime === true
    && input.redisServerTimeMs === undefined;
  const stateMinimumTimeMs = state.state === "active"
    ? state.activatedAtRedisMs
    : state.scheduledAtRedisMs;
  const redisServerTimeMs = redisServerTimeDeferred
    ? null
    : input.redisServerTimeMs === undefined
      ? await input.redis.monotonicServerTimeMs(stateMinimumTimeMs)
      : input.redisServerTimeMs;
  if (!redisServerTimeDeferred && (
    redisServerTimeMs === null
    || !Number.isSafeInteger(redisServerTimeMs)
    || redisServerTimeMs < 0
    // Redis TIME is wall-clock based. If it regresses behind the immutable
    // activation observation, using Redis could reopen a PostgreSQL window in
    // a second store. Stay active but fail closed until time catches up.
    || redisServerTimeMs < stateMinimumTimeMs
  )) {
    return {
      state,
      inspection: failedCutoverInspection(
        state,
        null,
        "redis_rate_limit_cutover_time_unavailable",
        true,
      ),
    };
  }

  if (state.state === "scheduled") {
    // A scheduled request can never defer TIME; keep this explicit so both the
    // runtime invariant and TypeScript's narrowing remain local to activation.
    if (redisServerTimeMs === null) {
      return {
        state,
        inspection: failedCutoverInspection(
          state,
          null,
          "redis_rate_limit_cutover_time_unavailable",
          true,
        ),
      };
    }
    if (
      redisServerTimeMs >= state.cutoverAtMs
      && input.allowActivation !== false
    ) {
      try {
        state = await activateRedisRateLimitCutover({
          database: input.database,
          contractFingerprint: runtimeFingerprint,
          cutoverAtMs: state.cutoverAtMs,
          redisNowMs: redisServerTimeMs,
        });
        rememberCutoverState(input.database, state);
      } catch (error) {
        return {
          state,
          inspection: failedCutoverInspection(
            state,
            redisServerTimeMs,
            cutoverErrorCode(error),
            true,
          ),
        };
      }
    }
  }

  return {
    state,
    inspection: {
      valid: true,
      state: state.state,
      active: state.state === "active",
      contractMatched: true,
      cutoverAtMs: state.cutoverAtMs,
      scheduledAtRedisMs: state.scheduledAtRedisMs,
      activatedAtRedisMs: state.activatedAtRedisMs,
      redisServerTimeMs,
      errorCode: null,
    },
  };
}

/** Inspect (and, at the boundary, atomically activate) the durable latch. */
export async function inspectDistributedRateLimitCutoverRuntime(input: {
  database: Knex;
  redis?: RedisCacheRuntime;
  environment?: NodeJS.ProcessEnv;
  runtimeFingerprint: string;
  redisServerTimeMs?: number | null;
  allowActivation?: boolean;
}): Promise<DistributedRateLimitCutoverRuntimeInspection> {
  const resolved = await resolveDistributedRateLimitCutover({
    database: input.database,
    redis: input.redis || redisCache,
    environment: input.environment || process.env,
    runtimeFingerprint: input.runtimeFingerprint,
    redisServerTimeMs: input.redisServerTimeMs,
    allowActivation: input.allowActivation,
  });
  return resolved.inspection;
}

/** Test-only reset; production code treats active memoization as irreversible. */
export function resetDistributedRateLimitCutoverMemoForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Redis rate-limit cutover memo can only be reset in tests");
  }
  cutoverStateCache = new WeakMap<object, CachedCutoverState>();
}

function strictBoolean(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new TypeError("expected boolean");
}

function strictPositiveInteger(raw: unknown, fallback: number, maximum: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new TypeError("expected positive integer");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError("integer outside supported range");
  }
  return value;
}

export function inspectDistributedRateLimitConfiguration(options: {
  environment?: NodeJS.ProcessEnv;
  now?: number;
  redis?: RedisCacheRuntime;
} = {}): DistributedRateLimitConfigurationInspection {
  const environment = options.environment || process.env;
  const now = options.now ?? Date.now();
  const redis = options.redis || redisCache;
  const invalidVariables: string[] = [];
  let redisEnabled = false;
  let cutoverAtMs: number | null = null;
  let ttlGraceMs = DEFAULT_TTL_GRACE_MS;
  let windowsMs: number[] = [];

  try {
    redisEnabled = strictBoolean(environment.FANJIN_REDIS_RATE_LIMIT_ENABLED, false);
  } catch {
    invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_ENABLED");
  }
  const rawCutover = String(environment.FANJIN_REDIS_RATE_LIMIT_CUTOVER_AT_MS || "").trim();
  if (rawCutover) {
    try {
      cutoverAtMs = strictPositiveInteger(rawCutover, 0, Number.MAX_SAFE_INTEGER);
    } catch {
      invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_CUTOVER_AT_MS");
    }
  }
  try {
    ttlGraceMs = strictPositiveInteger(
      environment.FANJIN_REDIS_RATE_LIMIT_TTL_GRACE_MS,
      DEFAULT_TTL_GRACE_MS,
      60_000,
    );
  } catch {
    invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_TTL_GRACE_MS");
  }
  const rawWindows = String(environment.FANJIN_REDIS_RATE_LIMIT_WINDOWS_MS || "").trim();
  if (redisEnabled) {
    if (!rawWindows || !/^\d+(?:,\d+)*$/.test(rawWindows)) {
      invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_WINDOWS_MS");
    } else {
      try {
        windowsMs = [...new Set(rawWindows.split(",").map((raw) => (
          strictPositiveInteger(raw, 0, MAX_REDIS_COUNTER_TTL_MS)
        )))];
      } catch {
        invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_WINDOWS_MS");
        windowsMs = [];
      }
    }
  }
  if (!Number.isSafeInteger(now) || now < 0) invalidVariables.push("now");
  if (redisEnabled && cutoverAtMs === null) {
    invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_CUTOVER_AT_MS");
  }
  if (redisEnabled && cutoverAtMs !== null && cutoverAtMs % 60_000 !== 0) {
    invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_CUTOVER_AT_MS");
  }
  if (redisEnabled && !windowsMs.includes(REQUIRED_API_KEY_WINDOW_MS)) {
    invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_WINDOWS_MS");
  }
  if (redisEnabled && windowsMs.some((durationMs) => (
    durationMs + ttlGraceMs > MAX_REDIS_COUNTER_TTL_MS
  ))) {
    invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_WINDOWS_MS");
  }
  if (redisEnabled && cutoverAtMs !== null && windowsMs.some((durationMs) => (
    cutoverAtMs! % durationMs !== 0
  ))) {
    invalidVariables.push("FANJIN_REDIS_RATE_LIMIT_CUTOVER_AT_MS");
  }
  // Once Redis is the live counter, falling back to PostgreSQL would split a
  // single limit window into two independent sources. Require fail-closed
  // semantics before allowing the cutover flag to become valid.
  if (redisEnabled && (!redis.isConfigured() || !redis.isRequired())) {
    invalidVariables.push("FANJIN_REDIS_REQUIRED");
  }

  const uniqueInvalidVariables = [...new Set(invalidVariables)];
  if (uniqueInvalidVariables.length) {
    return {
      mode: "invalid",
      valid: false,
      redisEnabled,
      redisActive: false,
      cutoverAtMs,
      ttlGraceMs,
      windowsMs,
      invalidVariables: uniqueInvalidVariables,
    };
  }
  const redisActive = redisEnabled && cutoverAtMs !== null && now >= cutoverAtMs;
  return {
    mode: redisActive ? "redis" : redisEnabled ? "redis_pending" : "database",
    valid: true,
    redisEnabled,
    redisActive,
    cutoverAtMs,
    ttlGraceMs,
    windowsMs,
    invalidVariables: [],
  };
}

/**
 * Validate hot-reloadable platform settings against the deployment's explicit
 * window allowlist. This is pure so /ready and production-readiness tooling can
 * apply the same policy without importing the relay middleware.
 */
export function inspectDistributedRateLimitWindowSettings(input: {
  configuration: DistributedRateLimitConfigurationInspection;
  modelEnabled: unknown;
  modelDurationMinutes: unknown;
}): DistributedRateLimitWindowSettingsInspection {
  const invalidSettings: string[] = [];
  let modelEnabled = false;
  let modelDurationMinutes = 1;
  try {
    modelEnabled = strictBoolean(input.modelEnabled, false);
  } catch {
    invalidSettings.push(MODEL_RATE_LIMIT_ENABLED_KEY);
  }
  try {
    modelDurationMinutes = strictPositiveInteger(
      input.modelDurationMinutes,
      1,
      Number.MAX_SAFE_INTEGER,
    );
  } catch {
    invalidSettings.push(MODEL_RATE_LIMIT_DURATION_KEY);
  }
  const modelDurationMs = modelDurationMinutes * 60_000;
  if (modelEnabled && !Number.isSafeInteger(modelDurationMs)) {
    invalidSettings.push(MODEL_RATE_LIMIT_DURATION_KEY);
  }
  if (
    input.configuration.redisEnabled
    && modelEnabled
    && !input.configuration.windowsMs.includes(modelDurationMs)
  ) {
    invalidSettings.push(MODEL_RATE_LIMIT_DURATION_KEY);
  }
  return {
    valid: invalidSettings.length === 0,
    modelEnabled,
    modelDurationMs: modelEnabled && Number.isSafeInteger(modelDurationMs) ? modelDurationMs : null,
    invalidSettings: [...new Set(invalidSettings)],
  };
}

function databaseBackend(database: Knex): "postgres" | "sqlite" {
  const client = String((database as any)?.client?.config?.client || "").toLowerCase();
  return client.includes("pg") || client.includes("postgres") ? "postgres" : "sqlite";
}

async function consumeDatabaseWindow(input: {
  database: Knex;
  bucket: string;
  windowStart: number;
  now: number;
}): Promise<number> {
  const [updated] = await input.database("o_api_key_rate_limit")
    .insert({
      apiKeyId: input.bucket,
      windowStart: input.windowStart,
      count: 1,
      createTime: input.now,
      updateTime: input.now,
    })
    .onConflict(["apiKeyId", "windowStart"])
    .merge({
      count: input.database.raw("?? + 1", ["o_api_key_rate_limit.count"]),
      updateTime: input.now,
    })
    .returning("count");
  const count = updated?.count != null
    ? Number(updated.count)
    : Number((await input.database("o_api_key_rate_limit")
      .where({ apiKeyId: input.bucket, windowStart: input.windowStart })
      .first())?.count || 0);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new DistributedRateLimitUnavailableError("持久化限流计数响应无效");
  }
  return count;
}

/**
 * Consume one fixed-window token across every API node.
 *
 * PostgreSQL/SQLite remains the only counter until every 0.0.4 API node has
 * the same future cutover timestamp. At that timestamp every node changes to
 * Redis together. Redis then fails closed; it never falls back to a second
 * live counter store inside the same window.
 */
export async function consumeDistributedFixedWindow(input: {
  namespace: string;
  bucket: string;
  limit: number;
  durationMs: number;
  now?: number;
  database?: Knex;
  redis?: RedisCacheRuntime;
  environment?: NodeJS.ProcessEnv;
}): Promise<FixedWindowConsumption> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
    throw new TypeError("限流额度必须是非负整数");
  }
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 1) {
    throw new TypeError("限流窗口必须是正整数毫秒");
  }
  if (input.now !== undefined && (!Number.isSafeInteger(input.now) || input.now < 0)) {
    throw new TypeError("限流时间无效");
  }
  if (input.limit === 0) {
    const disabledNow = input.now ?? Date.now();
    if (!Number.isSafeInteger(disabledNow) || disabledNow < 0) throw new TypeError("限流时间无效");
    const windowStart = Math.floor(disabledNow / input.durationMs) * input.durationMs;
    const windowEnd = windowStart + input.durationMs;
    if (!Number.isSafeInteger(windowEnd)) throw new TypeError("限流窗口超出安全范围");
    return {
      backend: "disabled",
      count: 0,
      limit: 0,
      windowStart,
      windowEnd,
      exceeded: false,
    };
  }

  const redis = input.redis || redisCache;
  const database = input.database || db as unknown as Knex;
  const environment = input.environment || process.env;
  const cutover = await resolveDistributedRateLimitCutover({
    database,
    redis,
    environment,
    // Defer the dynamic import until the durable row is armed. This avoids a
    // module-initialization cycle (the fingerprint module imports this module's
    // pure configuration inspector) and keeps bootstrap/unarmed requests free
    // of unnecessary Redis identity work.
    runtimeFingerprint: async () => {
      const { redisRuntimeFingerprint } = await import("@/lib/redisRuntimeFingerprint");
      return redisRuntimeFingerprint({ environment, redis });
    },
    deferActiveRedisTime: true,
  });
  if (!cutover.inspection.valid || !cutover.state) {
    throw new DistributedRateLimitUnavailableError(
      `分布式限流切换状态不可用: ${cutover.inspection.errorCode || "unknown"}`,
    );
  }

  // An absent latch is an explicit capability-rollout state. Regardless of a
  // future/past environment timestamp, PostgreSQL remains authoritative until
  // the controller durably schedules the immutable contract.
  const cutoverState = cutover.state;
  const armed = cutoverState.state !== "unarmed";
  const active = cutoverState.state === "active";
  const resolvedNow = active
    ? cutoverState.activatedAtRedisMs
    : armed
      ? cutover.inspection.redisServerTimeMs
      : input.now ?? Date.now();
  if (
    typeof resolvedNow !== "number"
    || !Number.isSafeInteger(resolvedNow)
    || resolvedNow < 0
  ) throw new TypeError("限流时间无效");
  const now = resolvedNow;

  if (armed) {
    const configuration = inspectDistributedRateLimitConfiguration({
      environment,
      now,
      redis,
    });
    if (!configuration.valid) {
      throw new DistributedRateLimitUnavailableError(
        `分布式限流配置无效: ${configuration.invalidVariables.join(", ")}`,
      );
    }
    if (!configuration.windowsMs.includes(input.durationMs)) {
      throw new DistributedRateLimitUnavailableError(
        `Redis 限流窗口未声明: ${input.durationMs}`,
      );
    }
    if (cutoverState.state !== "active") {
      const windowStart = Math.floor(now / input.durationMs) * input.durationMs;
      const windowEnd = windowStart + input.durationMs;
      if (!Number.isSafeInteger(windowEnd)) throw new TypeError("限流窗口超出安全范围");
      const count = await consumeDatabaseWindow({
        database,
        bucket: input.bucket,
        windowStart,
        now,
      });
      return {
        backend: databaseBackend(database),
        count,
        limit: input.limit,
        windowStart,
        windowEnd,
        exceeded: count > input.limit,
      };
    }

    const consumption = await redis.incrementFixedWindow({
      namespace: input.namespace,
      bucket: input.bucket,
      durationMs: input.durationMs,
      ttlGraceMs: configuration.ttlGraceMs,
      minimumTimeMs: cutoverState.activatedAtRedisMs,
    });
    if (consumption !== null) {
      const redisWindowEnd = consumption.windowStart + input.durationMs;
      if (!Number.isSafeInteger(redisWindowEnd)) {
        throw new DistributedRateLimitUnavailableError("Redis 限流窗口响应无效");
      }
      return {
        backend: "redis",
        count: consumption.count,
        limit: input.limit,
        windowStart: consumption.windowStart,
        windowEnd: redisWindowEnd,
        exceeded: consumption.count > input.limit,
      };
    }
    throw new DistributedRateLimitUnavailableError();
  }

  const windowStart = Math.floor(now / input.durationMs) * input.durationMs;
  const windowEnd = windowStart + input.durationMs;
  if (!Number.isSafeInteger(windowEnd)) throw new TypeError("限流窗口超出安全范围");
  const count = await consumeDatabaseWindow({
    database,
    bucket: input.bucket,
    windowStart,
    now,
  });
  return {
    backend: databaseBackend(database),
    count,
    limit: input.limit,
    windowStart,
    windowEnd,
    exceeded: count > input.limit,
  };
}
