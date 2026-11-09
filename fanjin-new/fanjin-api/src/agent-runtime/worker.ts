export const AGENT_RUNTIME_WORKER_DEFAULTS = Object.freeze({
  leaseDurationMs: 60_000,
  heartbeatIntervalMs: 15_000,
  batchSize: 10,
  maxAttempts: 3,
});

export interface AgentRuntimeClaimedRun {
  id: string;
  attempt: number;
  leaseOwner: string;
  leaseExpiresAt: number;
}

export interface ClaimRunsInput {
  workerId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  leaseExpiresAt: number;
  maxAttempts: number;
}

export interface HeartbeatRunsInput {
  workerId: string;
  runIds: readonly string[];
  now: number;
  leaseDurationMs: number;
  leaseExpiresAt: number;
}

export interface HeartbeatRunsResult {
  renewedIds: readonly string[];
  lostIds: readonly string[];
}

export interface RecoverExpiredRunsInput {
  now: number;
  limit: number;
  maxAttempts: number;
}

export interface RecoverExpiredRunsResult {
  requeuedIds: readonly string[];
  failedIds: readonly string[];
  cancelledIds: readonly string[];
}

export interface AgentRuntimeWorkerRepository<TRun extends AgentRuntimeClaimedRun = AgentRuntimeClaimedRun> {
  claimRuns(input: ClaimRunsInput): Promise<readonly TRun[]>;
  heartbeatRuns(input: HeartbeatRunsInput): Promise<HeartbeatRunsResult>;
  recoverExpiredRuns(input: RecoverExpiredRunsInput): Promise<RecoverExpiredRunsResult>;
}

export interface AgentRuntimeWorkerOptions<TRun extends AgentRuntimeClaimedRun = AgentRuntimeClaimedRun> {
  workerId: string;
  repository: AgentRuntimeWorkerRepository<TRun>;
  clock?: () => number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}

export interface AgentRuntimeWorkerConfig {
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
}

export interface AgentRuntimeWorkerTickResult<TRun extends AgentRuntimeClaimedRun> {
  recovered: RecoverExpiredRunsResult;
  claimed: readonly TRun[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} 必须是正整数`);
  return value;
}

export class AgentRuntimeWorker<TRun extends AgentRuntimeClaimedRun = AgentRuntimeClaimedRun> {
  readonly config: Readonly<AgentRuntimeWorkerConfig>;
  private readonly repository: AgentRuntimeWorkerRepository<TRun>;
  private readonly clock: () => number;

  constructor(options: AgentRuntimeWorkerOptions<TRun>) {
    const workerId = options.workerId.trim();
    if (!workerId) throw new TypeError("workerId 不能为空");

    const leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? AGENT_RUNTIME_WORKER_DEFAULTS.leaseDurationMs,
      "leaseDurationMs",
    );
    const heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? AGENT_RUNTIME_WORKER_DEFAULTS.heartbeatIntervalMs,
      "heartbeatIntervalMs",
    );
    if (heartbeatIntervalMs >= leaseDurationMs) {
      throw new TypeError("heartbeatIntervalMs 必须小于 leaseDurationMs");
    }

    this.config = Object.freeze({
      workerId,
      leaseDurationMs,
      heartbeatIntervalMs,
      batchSize: positiveInteger(options.batchSize ?? AGENT_RUNTIME_WORKER_DEFAULTS.batchSize, "batchSize"),
      maxAttempts: positiveInteger(options.maxAttempts ?? AGENT_RUNTIME_WORKER_DEFAULTS.maxAttempts, "maxAttempts"),
    });
    this.repository = options.repository;
    this.clock = options.clock ?? Date.now;
  }

  private claimAt(now: number, limit: number): Promise<readonly TRun[]> {
    return this.repository.claimRuns({
      workerId: this.config.workerId,
      now,
      limit,
      leaseDurationMs: this.config.leaseDurationMs,
      leaseExpiresAt: now + this.config.leaseDurationMs,
      maxAttempts: this.config.maxAttempts,
    });
  }

  async claim(limit = this.config.batchSize): Promise<readonly TRun[]> {
    return this.claimAt(this.clock(), positiveInteger(limit, "limit"));
  }

  async heartbeat(runIds: readonly string[]): Promise<HeartbeatRunsResult> {
    const uniqueRunIds = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
    if (!uniqueRunIds.length) return { renewedIds: [], lostIds: [] };
    const now = this.clock();
    return this.repository.heartbeatRuns({
      workerId: this.config.workerId,
      runIds: uniqueRunIds,
      now,
      leaseDurationMs: this.config.leaseDurationMs,
      leaseExpiresAt: now + this.config.leaseDurationMs,
    });
  }

  private recoverAt(now: number, limit: number): Promise<RecoverExpiredRunsResult> {
    return this.repository.recoverExpiredRuns({
      now,
      limit,
      maxAttempts: this.config.maxAttempts,
    });
  }

  async recover(limit = this.config.batchSize): Promise<RecoverExpiredRunsResult> {
    return this.recoverAt(this.clock(), positiveInteger(limit, "limit"));
  }

  async tick(): Promise<AgentRuntimeWorkerTickResult<TRun>> {
    const now = this.clock();
    const recovered = await this.recoverAt(now, this.config.batchSize);
    const claimed = await this.claimAt(now, this.config.batchSize);
    return { recovered, claimed };
  }
}
