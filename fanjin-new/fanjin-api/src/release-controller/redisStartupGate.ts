import type {
  RedisCacheRuntime,
  RedisProductionTopologyInspection,
  RedisRuntimeProbe,
} from "@/lib/redisCache";

import type {
  RedisCutoverCoordinator,
  RedisCutoverCoordinatorInspection,
} from "./redisCutoverCoordinator";

export type ReleaseControllerRedisStartupErrorCode =
  | "RELEASE_CONTROLLER_REDIS_TOPOLOGY_INVALID"
  | "RELEASE_CONTROLLER_REDIS_PROBE_FAILED"
  | "RELEASE_CONTROLLER_REDIS_TIME_UNAVAILABLE"
  | "RELEASE_CONTROLLER_REDIS_CUTOVER_INVALID"
  | "RELEASE_CONTROLLER_REDIS_LATCH_MISSING";

export class ReleaseControllerRedisStartupError extends Error {
  readonly code: ReleaseControllerRedisStartupErrorCode;

  constructor(code: ReleaseControllerRedisStartupErrorCode) {
    super(code);
    this.name = "ReleaseControllerRedisStartupError";
    this.code = code;
  }
}

export type ReleaseControllerRedisRuntime = Pick<
  RedisCacheRuntime,
  "productionTopologyInspection" | "probe" | "serverTimeMs"
>;

export interface ReleaseControllerRedisStartupInput {
  redis: ReleaseControllerRedisRuntime;
  coordinator: RedisCutoverCoordinator;
}

function startupError(code: ReleaseControllerRedisStartupErrorCode): never {
  throw new ReleaseControllerRedisStartupError(code);
}

function topologyIsSafe(topology: RedisProductionTopologyInspection): boolean {
  const sharedProductionEndpoint = topology.endpointScope === "remote"
    && topology.authConfigured
    && (topology.tlsConfigured || topology.insecurePrivateVpcMode);
  return topology.valid
    && topology.configured
    && topology.required
    && (sharedProductionEndpoint || topology.testOnlyExemption);
}

function probeIsReady(probe: RedisRuntimeProbe): boolean {
  return probe.configured
    && probe.required
    && probe.ready
    && probe.status === "ready";
}

function validRedisTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertCutoverInspection(
  inspection: RedisCutoverCoordinatorInspection,
): RedisCutoverCoordinatorInspection {
  if (
    !validRedisTime(inspection.redisTimeMs)
    || !Number.isSafeInteger(inspection.expected.cutoverAtMs)
    || inspection.expected.cutoverAtMs < 1
    || !/^[a-f0-9]{64}$/.test(inspection.expected.contractFingerprint)
    || inspection.expected.mode === "invalid"
    || inspection.expected.mode === "database"
  ) {
    startupError("RELEASE_CONTROLLER_REDIS_CUTOVER_INVALID");
  }

  if (
    inspection.centralState.state === "unarmed"
    && inspection.redisTimeMs >= inspection.expected.cutoverAtMs
  ) {
    startupError("RELEASE_CONTROLLER_REDIS_LATCH_MISSING");
  }

  return inspection;
}

/**
 * Fail-closed process preflight. This must complete before either Controller
 * runtime starts polling, so an installation cannot claim a deployment and
 * only then discover that its Redis identity or durable cutover latch differs.
 *
 * RedisCacheRuntime.probe() deliberately exercises PING, TIME, noeviction and
 * the exact GET/SET/DEL/EVAL ACL surface used by cache-aside and rate limiting.
 */
export async function assertReleaseControllerRedisStartup(
  input: ReleaseControllerRedisStartupInput,
): Promise<RedisCutoverCoordinatorInspection> {
  let topology: RedisProductionTopologyInspection;
  try {
    topology = input.redis.productionTopologyInspection();
  } catch {
    startupError("RELEASE_CONTROLLER_REDIS_TOPOLOGY_INVALID");
  }
  if (!topologyIsSafe(topology)) {
    startupError("RELEASE_CONTROLLER_REDIS_TOPOLOGY_INVALID");
  }

  let probe: RedisRuntimeProbe;
  try {
    probe = await input.redis.probe();
  } catch {
    startupError("RELEASE_CONTROLLER_REDIS_PROBE_FAILED");
  }
  if (!probeIsReady(probe)) {
    startupError("RELEASE_CONTROLLER_REDIS_PROBE_FAILED");
  }

  let redisTimeMs: number | null;
  try {
    redisTimeMs = await input.redis.serverTimeMs();
  } catch {
    startupError("RELEASE_CONTROLLER_REDIS_TIME_UNAVAILABLE");
  }
  if (!validRedisTime(redisTimeMs)) {
    startupError("RELEASE_CONTROLLER_REDIS_TIME_UNAVAILABLE");
  }

  let inspection: RedisCutoverCoordinatorInspection;
  try {
    inspection = await input.coordinator.inspect();
  } catch {
    startupError("RELEASE_CONTROLLER_REDIS_CUTOVER_INVALID");
  }
  return assertCutoverInspection(inspection);
}
