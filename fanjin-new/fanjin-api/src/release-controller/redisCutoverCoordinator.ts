import type { Knex } from "knex";
import {
  inspectDistributedRateLimitConfiguration,
  type DistributedRateLimitMode,
} from "@/lib/distributedRateLimit";
import {
  RedisRateLimitCutoverError,
  readRedisRateLimitCutoverState,
  scheduleRedisRateLimitCutover,
  type RedisRateLimitCutoverState,
} from "@/lib/redisRateLimitCutover";
import type { RedisCacheRuntime } from "@/lib/redisCache";
import { redisRuntimeFingerprint } from "@/lib/redisRuntimeFingerprint";

/** Minimum immutable lead once the complete target fleet and public route are proven. */
export const REDIS_CUTOVER_FINAL_SCHEDULE_LEAD_MS = 5 * 60_000;

export type RedisCutoverCoordinatorErrorCode =
  | "REDIS_CUTOVER_INVALID_INPUT"
  | "REDIS_CUTOVER_TIME_UNAVAILABLE"
  | "REDIS_CUTOVER_CONTRACT_INVALID"
  | "REDIS_CUTOVER_CENTRAL_STATE_INVALID"
  | "REDIS_CUTOVER_STATE_MISMATCH"
  | "REDIS_CUTOVER_LEAD_TOO_SHORT"
  | "REDIS_CUTOVER_DATABASE_UNAVAILABLE";

export class RedisCutoverCoordinatorError extends Error {
  readonly code: RedisCutoverCoordinatorErrorCode;

  constructor(code: RedisCutoverCoordinatorErrorCode, message: string) {
    super(message);
    this.name = "RedisCutoverCoordinatorError";
    this.code = code;
  }
}

export interface ExpectedRedisCutoverContract {
  contractFingerprint: string;
  cutoverAtMs: number;
  windowsMs: number[];
  ttlGraceMs: number;
  mode: DistributedRateLimitMode;
  redisActive: boolean;
}

export interface RedisCutoverCoordinatorInspection {
  centralState: RedisRateLimitCutoverState;
  redisTimeMs: number;
  expected: ExpectedRedisCutoverContract;
  cutoverLeadMs: number;
}

export interface RedisCutoverScheduleRequest {
  /** Controller-calculated remaining rollout duration plus safety margin. */
  minimumLeadMs: number;
}

/** Minimal dependency surface intended for injection into the release core. */
export interface RedisCutoverCoordinator {
  inspect(): Promise<RedisCutoverCoordinatorInspection>;
  schedule(request: RedisCutoverScheduleRequest): Promise<RedisCutoverCoordinatorInspection>;
}

export interface DatabaseRedisCutoverCoordinatorOptions {
  database: Knex;
  redis: RedisCacheRuntime;
  environment?: NodeJS.ProcessEnv;
}

function coordinatorError(
  code: RedisCutoverCoordinatorErrorCode,
  message: string,
): RedisCutoverCoordinatorError {
  return new RedisCutoverCoordinatorError(code, message);
}

function assertMinimumLead(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw coordinatorError(
      "REDIS_CUTOVER_INVALID_INPUT",
      "Redis cutover minimum lead must be a positive safe integer",
    );
  }
}

function mapLatchError(error: unknown): RedisCutoverCoordinatorError {
  if (!(error instanceof RedisRateLimitCutoverError)) {
    return coordinatorError(
      "REDIS_CUTOVER_DATABASE_UNAVAILABLE",
      "Redis cutover central state is unavailable",
    );
  }
  switch (error.code) {
    case "redis_rate_limit_cutover_invalid_state":
      return coordinatorError(
        "REDIS_CUTOVER_CENTRAL_STATE_INVALID",
        "Redis cutover central state is invalid",
      );
    case "redis_rate_limit_cutover_conflict":
      return coordinatorError(
        "REDIS_CUTOVER_STATE_MISMATCH",
        "Redis cutover central state does not match the deployment contract",
      );
    case "redis_rate_limit_cutover_unavailable":
      return coordinatorError(
        "REDIS_CUTOVER_DATABASE_UNAVAILABLE",
        "Redis cutover central state is unavailable",
      );
    case "redis_rate_limit_cutover_time_unavailable":
      return coordinatorError(
        "REDIS_CUTOVER_TIME_UNAVAILABLE",
        "Redis server time is unavailable while scheduling cutover",
      );
    case "redis_rate_limit_cutover_lead_too_short":
      return coordinatorError(
        "REDIS_CUTOVER_LEAD_TOO_SHORT",
        "Redis cutover no longer has the required lead time",
      );
    default:
      // These transitions are not expected from schedule(), and therefore
      // indicate that another writer changed the central contract or state.
      return coordinatorError(
        "REDIS_CUTOVER_STATE_MISMATCH",
        "Redis cutover central state cannot accept this deployment contract",
      );
  }
}

function assertCentralStateMatches(
  state: RedisRateLimitCutoverState,
  expected: ExpectedRedisCutoverContract,
): void {
  if (state.state === "unarmed") return;
  if (
    state.contractFingerprint !== expected.contractFingerprint
    || state.cutoverAtMs !== expected.cutoverAtMs
  ) {
    throw coordinatorError(
      "REDIS_CUTOVER_STATE_MISMATCH",
      "Redis cutover central state does not match the deployment contract",
    );
  }
}

/**
 * Database-backed adapter that binds the process environment, Redis server
 * time and the durable o_setting latch into one fail-closed release contract.
 */
export class DatabaseRedisCutoverCoordinator implements RedisCutoverCoordinator {
  private readonly database: Knex;
  private readonly redis: RedisCacheRuntime;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: DatabaseRedisCutoverCoordinatorOptions) {
    this.database = options.database;
    this.redis = options.redis;
    this.environment = options.environment || process.env;
  }

  async inspect(): Promise<RedisCutoverCoordinatorInspection> {
    const redisTimeMs = await this.readRedisTime();
    const expected = this.expectedContract(redisTimeMs);
    let centralState: RedisRateLimitCutoverState;
    try {
      centralState = await readRedisRateLimitCutoverState(this.database);
    } catch (error) {
      throw mapLatchError(error);
    }
    assertCentralStateMatches(centralState, expected);
    return this.buildInspection(centralState, expected, redisTimeMs);
  }

  async schedule(
    request: RedisCutoverScheduleRequest,
  ): Promise<RedisCutoverCoordinatorInspection> {
    assertMinimumLead(request?.minimumLeadMs);
    const inspection = await this.inspect();

    // Existing matching state is an idempotent success. In particular, an
    // active latch remains valid after its lead has naturally become negative.
    if (inspection.centralState.state !== "unarmed") return inspection;
    if (inspection.cutoverLeadMs < request.minimumLeadMs) {
      throw coordinatorError(
        "REDIS_CUTOVER_LEAD_TOO_SHORT",
        "Redis cutover does not leave enough time for the remaining rollout",
      );
    }

    let centralState: RedisRateLimitCutoverState;
    try {
      centralState = await scheduleRedisRateLimitCutover({
        database: this.database,
        contractFingerprint: inspection.expected.contractFingerprint,
        cutoverAtMs: inspection.expected.cutoverAtMs,
        // Resolve Redis TIME only after the database latch has been read under
        // its serialization lock. A slow PostgreSQL acquisition/read cannot
        // carry a stale pre-boundary timestamp into the committed schedule.
        redisNowMs: () => this.readRedisTime(),
        minimumLeadMs: request.minimumLeadMs,
      });
    } catch (error) {
      throw mapLatchError(error);
    }
    assertCentralStateMatches(centralState, inspection.expected);
    const redisTimeMs = await this.readRedisTime();
    return this.buildInspection(centralState, inspection.expected, redisTimeMs);
  }

  private async readRedisTime(): Promise<number> {
    let redisTimeMs: number | null = null;
    try {
      redisTimeMs = await this.redis.serverTimeMs();
    } catch {
      // RedisCacheRuntime normally reduces command failures to null. Retain a
      // hard boundary in case an injected implementation throws instead.
    }
    if (!Number.isSafeInteger(redisTimeMs) || redisTimeMs === null || redisTimeMs < 0) {
      throw coordinatorError(
        "REDIS_CUTOVER_TIME_UNAVAILABLE",
        "Redis server time is unavailable",
      );
    }
    return redisTimeMs;
  }

  private expectedContract(redisTimeMs: number): ExpectedRedisCutoverContract {
    let configuration: ReturnType<typeof inspectDistributedRateLimitConfiguration>;
    let contractFingerprint: string;
    try {
      configuration = inspectDistributedRateLimitConfiguration({
        environment: this.environment,
        now: redisTimeMs,
        redis: this.redis,
      });
      contractFingerprint = redisRuntimeFingerprint({
        environment: this.environment,
        redis: this.redis,
      });
    } catch {
      throw coordinatorError(
        "REDIS_CUTOVER_CONTRACT_INVALID",
        "Redis cutover deployment contract is invalid",
      );
    }

    if (
      !configuration.valid
      || !configuration.redisEnabled
      || configuration.cutoverAtMs === null
      || configuration.windowsMs.length === 0
      || configuration.windowsMs.some((windowMs) => configuration.cutoverAtMs! % windowMs !== 0)
      || !/^[a-f0-9]{64}$/.test(contractFingerprint)
    ) {
      throw coordinatorError(
        "REDIS_CUTOVER_CONTRACT_INVALID",
        "Redis cutover deployment contract is invalid",
      );
    }

    return {
      contractFingerprint,
      cutoverAtMs: configuration.cutoverAtMs,
      windowsMs: [...configuration.windowsMs].sort((left, right) => left - right),
      ttlGraceMs: configuration.ttlGraceMs,
      mode: configuration.mode,
      redisActive: configuration.redisActive,
    };
  }

  private buildInspection(
    centralState: RedisRateLimitCutoverState,
    expected: ExpectedRedisCutoverContract,
    redisTimeMs: number,
  ): RedisCutoverCoordinatorInspection {
    return {
      centralState,
      redisTimeMs,
      expected: {
        ...expected,
        windowsMs: [...expected.windowsMs],
      },
      cutoverLeadMs: expected.cutoverAtMs - redisTimeMs,
    };
  }
}

export function createRedisCutoverCoordinator(
  options: DatabaseRedisCutoverCoordinatorOptions,
): RedisCutoverCoordinator {
  return new DatabaseRedisCutoverCoordinator(options);
}
