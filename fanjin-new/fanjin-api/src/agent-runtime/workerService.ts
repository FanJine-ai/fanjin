import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Knex } from "knex";
import {
  AgentApprovalService,
  type AgentApprovalBudgetSweepResult,
  type AgentApprovalExpirySweepResult,
} from "@/agent-runtime/approvalService";
import { settleAgentChatBillingOnTerminalRun } from "@/agent-runtime/agentChatBilling";
import {
  AgentBillingReconciler,
  recordAgentBillingReconciliationFailure,
} from "@/agent-runtime/agentBillingReconciliation";
import { DelegatedAgentModel } from "@/agent-runtime/delegatedAgentModel";
import { DelegatedAgentRunProcessor } from "@/agent-runtime/delegatedAgentRunProcessor";
import { ExecutorAgentRunProcessor } from "@/agent-runtime/executorAgentRunProcessor";
import { DelegationCompletionService } from "@/agent-runtime/delegationCompletionService";
import {
  getAgentRuntimeDelegationSigningSecret,
  getAgentRuntimeModelAlias,
  getAgentRuntimeWorkerMaxAttempts,
  isAgentBillingReconcileEnabled,
  inspectAgentSurfaceReadiness,
  isAgentRuntimeDelegationEnabled,
  isAgentRuntimeModelEnabled,
  isAgentRuntimeWorkerEnabled,
  requireAgentRuntimeDelegationSigningSecret,
} from "@/agent-runtime/featureFlags";
import { DelegationGrantService } from "@/agent-runtime/delegationGrantService";
import { AgentDelegationCoordinator } from "@/agent-runtime/delegationCoordinator";
import { KnexRunLeaseRepository } from "@/agent-runtime/knexRunLeaseRepository";
import { MainAgentModelExecutor } from "@/agent-runtime/mainAgentExecutor";
import { MainAgentToolLoopModel } from "@/agent-runtime/mainAgentToolLoopModel";
import { A4ReviewReportService } from "@/agent-runtime/reviewReportService";
import {
  AgentRunProcessor,
  type AgentRunProcessInput,
  type AgentRunProcessResult,
} from "@/agent-runtime/runProcessor";
import { AgentRunProcessorRouter } from "@/agent-runtime/runProcessorRouter";
import { AgentToolLoopProcessor } from "@/agent-runtime/toolLoopProcessor";
import { AgentToolGateway } from "@/agent-runtime/tools/gateway";
import {
  AGENT_RUNTIME_WORKER_DEFAULTS,
  AgentRuntimeWorker,
  type AgentRuntimeClaimedRun,
  type AgentRuntimeWorkerTickResult,
  type HeartbeatRunsResult,
} from "@/agent-runtime/worker";
import {
  createAgentRuntimeWorkerReadinessReporter,
  type AgentRuntimeWorkerReadinessReporter,
} from "@/agent-runtime/workerReadiness";
import { db } from "@/utils/db";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REAL_MODEL_BATCH_SIZE = 1;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_APPROVAL_EXPIRY_SWEEP_LIMIT = 50;
const DEFAULT_BILLING_RECONCILE_INTERVAL_MS = 15 * 60_000;
const DEFAULT_WATCHDOG_TIMEOUT_MS = 90_000;
const DEFAULT_EXECUTOR_EXTERNAL_WAIT_SWEEP_INTERVAL_MS = 60_000;
export const AGENT_TOOL_LOOP_LIMIT_DEFAULTS = Object.freeze({
  maxTurns: 8,
  maxToolCalls: 16,
});
const DEFAULT_EXECUTOR_EXTERNAL_WAIT_STALE_AFTER_MS = 10 * 60_000;

export interface AgentRuntimeWorkerProcessIdentity {
  hostname: string;
  pid: number;
  incarnationId: string;
}

const AGENT_RUNTIME_WORKER_PROCESS_IDENTITY: Readonly<AgentRuntimeWorkerProcessIdentity> = Object.freeze({
  hostname: hostname(),
  pid: process.pid,
  incarnationId: randomUUID(),
});

/**
 * FANJIN_AGENT_WORKER_ID is a stable, operator-facing logical name. Lease
 * ownership must additionally identify this exact process incarnation: during
 * a rolling restart the old process can otherwise heartbeat a lease reclaimed
 * by the new process under the same logical name.
 */
export function agentRuntimeWorkerLeaseOwner(
  env: NodeJS.ProcessEnv,
  identity: Readonly<AgentRuntimeWorkerProcessIdentity> = AGENT_RUNTIME_WORKER_PROCESS_IDENTITY,
): string {
  const logicalWorkerId = String(env.FANJIN_AGENT_WORKER_ID || "").trim() || identity.hostname.trim();
  const incarnationId = identity.incarnationId.trim();
  if (!logicalWorkerId) throw new TypeError("Agent Worker logicalWorkerId 不能为空");
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
    throw new TypeError("Agent Worker process pid 必须是正整数");
  }
  if (!incarnationId) throw new TypeError("Agent Worker process incarnationId 不能为空");
  return `${logicalWorkerId}:${identity.pid}:${incarnationId}`;
}

export interface AgentRuntimeWorkerServiceLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface AgentRuntimeWorkerServiceWorker<TRun extends AgentRuntimeClaimedRun = AgentRuntimeClaimedRun> {
  readonly config: {
    workerId: string;
    heartbeatIntervalMs: number;
  };
  tick(): Promise<AgentRuntimeWorkerTickResult<TRun>>;
  heartbeat(runIds: readonly string[]): Promise<HeartbeatRunsResult>;
}

export interface AgentRuntimeRunProcessorLike {
  process(input: AgentRunProcessInput): Promise<AgentRunProcessResult>;
}

export interface AgentRuntimeApprovalExpirySweeperLike {
  sweepExpiredWaitingApprovals(input: { limit: number }): Promise<AgentApprovalExpirySweepResult>;
  /** 预算自主审批安全网:过期 approved 预留的同事务过期+回滚(可选,测试替身可省略)。 */
  sweepExpiredAutoApprovedReservations?(input: { limit: number }): Promise<AgentApprovalBudgetSweepResult>;
}

/**
 * executor waiting_external 兜底恢复(P1 修复)。可选注入：仅当 executor
 * 处理器存在时接线；漏通知/竞态导致的外部等待卡死由它兜底 requeue。
 */
export interface AgentRuntimeExecutorExternalWaitSweeperLike {
  sweepStaleWaitingExternal(input: {
    limit: number;
    staleAfterMs: number;
    now?: number;
  }): Promise<{ requeued: number }>;
}

/**
 * R2/R3 审批-扣费周期对账(REVAMP-PLAN 2.4)。实现只读扫描并输出报告,不做
 * 任何自动修复;由 createConfiguredAgentRuntimeWorkerService 在灰度开启时
 * 注入 AgentBillingReconciler。
 */
export interface AgentRuntimeBillingReconcilerLike {
  reconcile(input: { now?: number }): Promise<unknown>;
}

export interface AgentRuntimeWorkerServiceOptions<TRun extends AgentRuntimeClaimedRun = AgentRuntimeClaimedRun> {
  worker: AgentRuntimeWorkerServiceWorker<TRun>;
  processor: AgentRuntimeRunProcessorLike;
  approvalExpirySweeper?: AgentRuntimeApprovalExpirySweeperLike;
  approvalExpirySweepLimit?: number;
  /** executor 外部等待兜底恢复(可选;见 AgentRuntimeExecutorExternalWaitSweeperLike)。 */
  executorExternalWaitSweeper?: AgentRuntimeExecutorExternalWaitSweeperLike;
  executorExternalWaitSweepLimit?: number;
  executorExternalWaitStaleAfterMs?: number;
  /** Low-frequency maintenance cadence; independent from the queue poll rate. */
  executorExternalWaitSweepIntervalMs?: number;
  /**
   * R2/R3 审批-扣费对账(可选)。服务按 agentBillingReconcileIntervalMs 节
   * 流,每个 tick 至多触发一次。普通灰度环境异常只告警；完整 Agent
   * surface 会失败关闭 readiness，且不会继续认领 Run。
   */
  agentBillingReconciler?: AgentRuntimeBillingReconcilerLike | null;
  /** Required surfaces must not admit Agent work after an unreadable billing scan. */
  agentBillingReconciliationRequired?: boolean;
  agentBillingReconcileIntervalMs?: number;
  pollIntervalMs?: number;
  logger?: AgentRuntimeWorkerServiceLogger;
  /**
   * Optional best-effort hook invoked once per Run that reached a failed or
   * cancelled terminal state during a tick (recovery or processing). Used by
   * the wired service to auto-refund per-Run chat-model charges; kept optional
   * so unit tests and non-billing compositions stay unchanged.
   */
  terminalRunRefundSettler?: ((runId: string) => Promise<void>) | null;
  /**
   * Agent-specific service heartbeat. An aggregate background-worker
   * heartbeat must never open Agent admission by itself.
   */
  readinessReporter?: AgentRuntimeWorkerReadinessReporter | null;
  /**
   * Detects a queue poll or in-flight lease heartbeat that has made no
   * progress. Production supplies a process-exit hook so the service manager
   * can replace a stuck Worker without taking the public API out of service.
   */
  watchdogTimeoutMs?: number | null;
  onWatchdogTimeout?: (() => void | Promise<void>) | null;
}

export interface AgentRuntimeWorkerServiceTickResult<TRun extends AgentRuntimeClaimedRun = AgentRuntimeClaimedRun> {
  recovered: AgentRuntimeWorkerTickResult<TRun>["recovered"];
  claimed: readonly TRun[];
  processed: readonly AgentRunProcessResult[];
  processErrorRunIds: readonly string[];
}

const defaultLogger: AgentRuntimeWorkerServiceLogger = {
  info(message, metadata) {
    console.info(message, metadata ?? "");
  },
  warn(message, metadata) {
    console.warn(message, metadata ?? "");
  },
  error(message, metadata) {
    console.error(message, metadata ?? "");
  },
};

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} 必须是正整数`);
  return value;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

/**
 * Timer-driven composition of lease recovery, claim, heartbeat and RunProcessor.
 * Construction is inert; callers must explicitly invoke start().
 */
export class AgentRuntimeWorkerService<TRun extends AgentRuntimeClaimedRun = AgentRuntimeClaimedRun> {
  private readonly worker: AgentRuntimeWorkerServiceWorker<TRun>;
  private readonly processor: AgentRuntimeRunProcessorLike;
  private readonly approvalExpirySweeper: AgentRuntimeApprovalExpirySweeperLike | null;
  private readonly approvalExpirySweepLimit: number;
  private readonly executorExternalWaitSweeper: AgentRuntimeExecutorExternalWaitSweeperLike | null;
  private readonly executorExternalWaitSweepLimit: number;
  private readonly executorExternalWaitStaleAfterMs: number;
  private readonly executorExternalWaitSweepIntervalMs: number;
  private lastExecutorExternalWaitSweepAt: number | null = null;
  private readonly agentBillingReconciler: AgentRuntimeBillingReconcilerLike | null;
  private readonly agentBillingReconciliationRequired: boolean;
  private lastBillingReconcileSucceeded = false;
  private readonly agentBillingReconcileIntervalMs: number;
  private lastBillingReconcileAt = 0;
  private readonly terminalRunRefundSettler: ((runId: string) => Promise<void>) | null;
  private readonly pollIntervalMs: number;
  private readonly logger: AgentRuntimeWorkerServiceLogger;
  private readonly readinessReporter: AgentRuntimeWorkerReadinessReporter | null;
  private readonly watchdogTimeoutMs: number | null;
  private readonly onWatchdogTimeout: (() => void | Promise<void>) | null;
  private started = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressAt = 0;
  private watchdogTriggered = false;
  private activeTick: Promise<AgentRuntimeWorkerServiceTickResult<TRun>> | null = null;

  constructor(options: AgentRuntimeWorkerServiceOptions<TRun>) {
    this.worker = options.worker;
    this.processor = options.processor;
    this.approvalExpirySweeper = options.approvalExpirySweeper ?? null;
    this.approvalExpirySweepLimit = positiveInteger(
      options.approvalExpirySweepLimit ?? DEFAULT_APPROVAL_EXPIRY_SWEEP_LIMIT,
      "approvalExpirySweepLimit",
    );
    this.executorExternalWaitSweeper = options.executorExternalWaitSweeper ?? null;
    this.executorExternalWaitSweepLimit = positiveInteger(
      options.executorExternalWaitSweepLimit ?? DEFAULT_APPROVAL_EXPIRY_SWEEP_LIMIT,
      "executorExternalWaitSweepLimit",
    );
    this.executorExternalWaitStaleAfterMs = positiveInteger(
      options.executorExternalWaitStaleAfterMs ?? DEFAULT_EXECUTOR_EXTERNAL_WAIT_STALE_AFTER_MS,
      "executorExternalWaitStaleAfterMs",
    );
    this.executorExternalWaitSweepIntervalMs = positiveInteger(
      options.executorExternalWaitSweepIntervalMs ?? DEFAULT_EXECUTOR_EXTERNAL_WAIT_SWEEP_INTERVAL_MS,
      "executorExternalWaitSweepIntervalMs",
    );
    this.agentBillingReconciler = options.agentBillingReconciler ?? null;
    this.agentBillingReconciliationRequired = options.agentBillingReconciliationRequired ?? false;
    if (this.agentBillingReconciliationRequired && !this.agentBillingReconciler) {
      throw new TypeError("required Agent billing reconciliation scanner is missing");
    }
    this.agentBillingReconcileIntervalMs = positiveInteger(
      options.agentBillingReconcileIntervalMs ?? DEFAULT_BILLING_RECONCILE_INTERVAL_MS,
      "agentBillingReconcileIntervalMs",
    );
    this.terminalRunRefundSettler = options.terminalRunRefundSettler ?? null;
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.logger = options.logger ?? defaultLogger;
    this.readinessReporter = options.readinessReporter ?? null;
    this.watchdogTimeoutMs = options.watchdogTimeoutMs === null
      ? null
      : positiveInteger(
          options.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_TIMEOUT_MS,
          "watchdogTimeoutMs",
        );
    this.onWatchdogTimeout = options.onWatchdogTimeout ?? null;
  }

  get isRunning(): boolean {
    return this.started;
  }

  start(): boolean {
    if (this.started) return false;
    this.started = true;
    this.lastProgressAt = Date.now();
    this.watchdogTriggered = false;
    this.startWatchdog();
    this.readinessReporter?.start();
    this.logger.info("[agent-worker] started", { workerId: this.worker.config.workerId });
    void this.runLoopTick();
    return true;
  }

  async stop(): Promise<void> {
    if (!this.started && !this.activeTick) return;
    this.started = false;
    this.stopWatchdog();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Withdraw admission immediately; an in-flight claimed Run keeps its own
    // lease heartbeat until its existing safe finalization boundary.
    await this.updateReadiness(false);
    const active = this.activeTick;
    if (active) {
      try {
        await active;
      } catch {
        // runOnce logs a redacted operational error; graceful stop still waits
        // for all claimed processors and their heartbeat timers to unwind.
      }
    }
    await this.stopReadinessReporter();
    this.logger.info("[agent-worker] stopped", { workerId: this.worker.config.workerId });
  }

  async runOnce(): Promise<AgentRuntimeWorkerServiceTickResult<TRun>> {
    if (this.activeTick) return this.activeTick;
    const current = this.executeTick();
    this.activeTick = current;
    try {
      return await current;
    } finally {
      if (this.activeTick === current) this.activeTick = null;
    }
  }

  private async runLoopTick(): Promise<void> {
    if (!this.started) return;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error("[agent-worker] tick failed", {
        workerId: this.worker.config.workerId,
        errorName: errorName(error),
      });
    }
    if (!this.started) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.runLoopTick();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private async executeTick(): Promise<AgentRuntimeWorkerServiceTickResult<TRun>> {
    try {
      await this.approvalExpirySweeper?.sweepExpiredWaitingApprovals({
        limit: this.approvalExpirySweepLimit,
      });
      // 预算自主审批:过期的自动批准预留随每个 tick 过期并回滚(同事务、幂等)。
      await this.approvalExpirySweeper?.sweepExpiredAutoApprovedReservations?.({
        limit: this.approvalExpirySweepLimit,
      });
      await this.runExecutorExternalWaitSweepIfDue();
      await this.runBillingReconciliationIfDue();
      const tick = await this.worker.tick();
      this.recordProgress();
      // Only a successful Agent queue/recovery poll may create readiness
      // evidence. Construction or a generic Worker heartbeat is insufficient.
      if (this.started) await this.updateReadiness(true);
      const outcomes = await Promise.all(tick.claimed.map((claimedRun) => this.processClaimedRun(claimedRun)));
      await this.settleTerminalRunRefunds(tick, outcomes);
      return {
        recovered: tick.recovered,
        claimed: tick.claimed,
        processed: outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : []),
        processErrorRunIds: outcomes.flatMap((outcome) => outcome.error ? [outcome.runId] : []),
      };
    } catch (error) {
      if (this.started) await this.updateReadiness(false);
      throw error;
    }
  }

  /**
   * Recovery maintenance must never run at the one-second queue poll cadence,
   * nor may a failed sweep stop the Worker from claiming otherwise healthy
   * work. Record the attempt before awaiting so an unavailable recovery path
   * is rate-limited too.
   */
  private async runExecutorExternalWaitSweepIfDue(): Promise<void> {
    if (!this.executorExternalWaitSweeper) return;
    const now = Date.now();
    if (this.lastExecutorExternalWaitSweepAt != null
      && now - this.lastExecutorExternalWaitSweepAt < this.executorExternalWaitSweepIntervalMs) {
      return;
    }
    this.lastExecutorExternalWaitSweepAt = now;
    try {
      await this.executorExternalWaitSweeper.sweepStaleWaitingExternal({
        limit: this.executorExternalWaitSweepLimit,
        staleAfterMs: this.executorExternalWaitStaleAfterMs,
        now,
      });
    } catch (error) {
      this.logger.warn("[agent-worker] executor external-wait sweep failed", {
        workerId: this.worker.config.workerId,
        errorName: errorName(error),
      });
    }
  }

  private async updateReadiness(ready: boolean): Promise<void> {
    if (!this.readinessReporter) return;
    try {
      if (ready) await this.readinessReporter.markReady();
      else await this.readinessReporter.markUnready();
    } catch (error) {
      // The proof fails closed when its write is unavailable, but the worker
      // must still finish a Run already claimed by the successful queue poll.
      this.logger.warn("[agent-worker] readiness heartbeat failed", {
        workerId: this.worker.config.workerId,
        ready,
        errorName: errorName(error),
      });
    }
  }

  private recordProgress(): void {
    this.lastProgressAt = Date.now();
  }

  private startWatchdog(): void {
    if (this.watchdogTimeoutMs === null || this.watchdogTimer) return;
    const checkIntervalMs = Math.min(
      10_000,
      Math.max(1, Math.floor(this.watchdogTimeoutMs / 3)),
    );
    this.watchdogTimer = setInterval(() => {
      if (!this.started || this.watchdogTriggered) return;
      const stalledForMs = Date.now() - this.lastProgressAt;
      if (stalledForMs < this.watchdogTimeoutMs!) return;
      this.watchdogTriggered = true;
      this.logger.error("[agent-worker] watchdog detected stalled execution", {
        workerId: this.worker.config.workerId,
        stalledForMs,
        watchdogTimeoutMs: this.watchdogTimeoutMs,
      });
      try {
        void Promise.resolve(this.onWatchdogTimeout?.()).catch((error) => {
          this.logger.error("[agent-worker] watchdog recovery hook failed", {
            workerId: this.worker.config.workerId,
            errorName: errorName(error),
          });
        });
      } catch (error) {
        this.logger.error("[agent-worker] watchdog recovery hook failed", {
          workerId: this.worker.config.workerId,
          errorName: errorName(error),
        });
      }
    }, checkIntervalMs);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async stopReadinessReporter(): Promise<void> {
    if (!this.readinessReporter) return;
    try {
      await this.readinessReporter.stop();
    } catch (error) {
      this.logger.warn("[agent-worker] readiness heartbeat cleanup failed", {
        workerId: this.worker.config.workerId,
        errorName: errorName(error),
      });
    }
  }

  /** R2/R3 对账(2.4):按间隔节流；required 模式失败关闭 Agent admission。 */
  private async runBillingReconciliationIfDue(): Promise<void> {
    if (!this.agentBillingReconciler) return;
    const now = Date.now();
    if (now - this.lastBillingReconcileAt < this.agentBillingReconcileIntervalMs) {
      if (this.agentBillingReconciliationRequired && !this.lastBillingReconcileSucceeded) {
        throw new Error("required Agent billing reconciliation scan is unavailable");
      }
      return;
    }
    this.lastBillingReconcileAt = now;
    try {
      await this.agentBillingReconciler.reconcile({ now });
      this.lastBillingReconcileSucceeded = true;
    } catch (error) {
      this.lastBillingReconcileSucceeded = false;
      recordAgentBillingReconciliationFailure(now);
      this.logger.error("[agent-worker] billing reconciliation failed", {
        workerId: this.worker.config.workerId,
        errorName: errorName(error),
      });
      if (this.agentBillingReconciliationRequired) throw error;
    }
  }

  private async settleTerminalRunRefunds(
    tick: AgentRuntimeWorkerTickResult<TRun>,
    outcomes: readonly { runId: string; result: AgentRunProcessResult | null; error: boolean }[],
  ): Promise<void> {
    if (!this.terminalRunRefundSettler) return;
    const terminalRunIds = new Set<string>();
    for (const runId of tick.recovered.failedIds) terminalRunIds.add(String(runId));
    for (const runId of tick.recovered.cancelledIds) terminalRunIds.add(String(runId));
    for (const outcome of outcomes) {
      if (outcome.result && (outcome.result.status === "failed" || outcome.result.status === "cancelled")) {
        terminalRunIds.add(outcome.result.runId);
      }
    }
    for (const runId of terminalRunIds) {
      try {
        await this.terminalRunRefundSettler(runId);
      } catch (error) {
        this.logger.warn("[agent-worker] terminal run refund settle failed", {
          workerId: this.worker.config.workerId,
          runId,
          errorName: errorName(error),
        });
      }
    }
  }

  private async processClaimedRun(
    claimedRun: TRun,
  ): Promise<{ runId: string; result: AgentRunProcessResult | null; error: boolean }> {
    let heartbeatPending: Promise<void> | null = null;
    let heartbeatStopped = false;
    const heartbeat = () => {
      if (heartbeatStopped || heartbeatPending) return;
      const pulse = (async () => {
        try {
          const result = await this.worker.heartbeat([claimedRun.id]);
          if (result.lostIds.includes(claimedRun.id)) {
            this.logger.warn("[agent-worker] lease lost during execution", {
              workerId: this.worker.config.workerId,
              runId: claimedRun.id,
            });
          } else if (this.started) {
            // A successful Run-lease renewal is real Agent execution
            // progress, so long model/tool calls keep the service proof fresh.
            this.recordProgress();
            await this.updateReadiness(true);
          }
        } catch (error) {
          this.logger.warn("[agent-worker] heartbeat failed", {
            workerId: this.worker.config.workerId,
            runId: claimedRun.id,
            errorName: errorName(error),
          });
        }
      })();
      let tracked: Promise<void>;
      tracked = pulse.finally(() => {
        if (heartbeatPending === tracked) heartbeatPending = null;
      });
      heartbeatPending = tracked;
    };
    const heartbeatTimer = setInterval(() => {
      heartbeat();
    }, this.worker.config.heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    const stopHeartbeat = async () => {
      if (!heartbeatStopped) {
        heartbeatStopped = true;
        clearInterval(heartbeatTimer);
      }
      if (heartbeatPending) await heartbeatPending;
    };

    try {
      const result = await this.processor.process({
        claimedRun,
        workerId: this.worker.config.workerId,
        beforeFinalize: stopHeartbeat,
      });
      return { runId: claimedRun.id, result, error: false };
    } catch (error) {
      this.logger.error("[agent-worker] processor failed", {
        workerId: this.worker.config.workerId,
        runId: claimedRun.id,
        errorName: errorName(error),
      });
      return { runId: claimedRun.id, result: null, error: true };
    } finally {
      await stopHeartbeat();
    }
  }
}

function envPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = String(env[name] || "").trim();
  if (!raw) return fallback;
  return positiveInteger(Number(raw), name);
}

export function resolveAgentToolLoopLimits(
  env: NodeJS.ProcessEnv = process.env,
): {
  maxTurns: number;
  maxToolCalls: number;
} {
  return {
    maxTurns: envPositiveInteger(
      env,
      "FANJIN_AGENT_TOOL_LOOP_MAX_TURNS",
      AGENT_TOOL_LOOP_LIMIT_DEFAULTS.maxTurns,
    ),
    maxToolCalls: envPositiveInteger(
      env,
      "FANJIN_AGENT_TOOL_LOOP_MAX_TOOL_CALLS",
      AGENT_TOOL_LOOP_LIMIT_DEFAULTS.maxToolCalls,
    ),
  };
}

function envTemperature(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = String(env[name] || "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2) throw new TypeError(`${name} 必须介于 0 和 2 之间`);
  return value;
}

export interface CreateConfiguredAgentRuntimeWorkerServiceOptions {
  env?: NodeJS.ProcessEnv;
  database?: Knex;
  logger?: AgentRuntimeWorkerServiceLogger;
  delegationGrantServiceFactory?: (database: Knex, signingSecret: string) => DelegationGrantService;
}

/** Returns null unless API runtime, worker and real model execution are all explicitly enabled. */
export function createConfiguredAgentRuntimeWorkerService(
  options: CreateConfiguredAgentRuntimeWorkerServiceOptions = {},
): AgentRuntimeWorkerService | null {
  const env = options.env ?? process.env;
  if (!isAgentRuntimeWorkerEnabled(env) || !isAgentRuntimeModelEnabled(env)) return null;

  const database = options.database ?? (db as unknown as Knex);
  const delegationSigningSecret = isAgentRuntimeDelegationEnabled(env)
    ? requireAgentRuntimeDelegationSigningSecret(env)
    : getAgentRuntimeDelegationSigningSecret(env);
  const workerId = agentRuntimeWorkerLeaseOwner(env);
  const approvalService = new AgentApprovalService(database);
  const delegationGrantService = delegationSigningSecret
    ? (options.delegationGrantServiceFactory
        ?? ((serviceDatabase, signingSecret) => new DelegationGrantService(serviceDatabase, { signingSecret })))(
        database,
        delegationSigningSecret,
      )
    : undefined;
  const completionService = delegationGrantService
    ? new DelegationCompletionService({
        database,
        reviewReportSink: new A4ReviewReportService(database),
      })
    : undefined;
  const repository = new KnexRunLeaseRepository(database, {
    requireModelEnabledMainRun: true,
    allowA4DelegatedRuns: Boolean(completionService),
    ...(completionService
      ? { delegatedRecoveryHandler: completionService.delegatedRecoveryHandler }
      : {}),
  });
  const worker = new AgentRuntimeWorker({
    workerId,
    repository,
    leaseDurationMs: envPositiveInteger(
      env,
      "FANJIN_AGENT_WORKER_LEASE_MS",
      AGENT_RUNTIME_WORKER_DEFAULTS.leaseDurationMs,
    ),
    heartbeatIntervalMs: envPositiveInteger(
      env,
      "FANJIN_AGENT_WORKER_HEARTBEAT_MS",
      AGENT_RUNTIME_WORKER_DEFAULTS.heartbeatIntervalMs,
    ),
    batchSize: envPositiveInteger(env, "FANJIN_AGENT_WORKER_BATCH_SIZE", DEFAULT_REAL_MODEL_BATCH_SIZE),
    maxAttempts: getAgentRuntimeWorkerMaxAttempts(env),
  });
  const executor = new MainAgentModelExecutor({
    database,
    modelAlias: getAgentRuntimeModelAlias(env),
    maxOutputTokens: envPositiveInteger(env, "FANJIN_AGENT_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
    temperature: envTemperature(env, "FANJIN_AGENT_TEMPERATURE", 0.3),
    historyMessageLimit: envPositiveInteger(env, "FANJIN_AGENT_HISTORY_MESSAGE_LIMIT", 40),
    historyCharacterLimit: envPositiveInteger(env, "FANJIN_AGENT_HISTORY_CHARACTER_LIMIT", 64_000),
  });
  const textProcessor = new AgentRunProcessor({ database, executor });
  const gateway = new AgentToolGateway({ database, approvalService, delegationGrantService });
  const delegationCoordinator = delegationGrantService
    ? new AgentDelegationCoordinator(database, { grantService: delegationGrantService })
    : undefined;
  const toolLoopLimits = resolveAgentToolLoopLimits(env);
  const toolLoopProcessor = new AgentToolLoopProcessor({
    database,
    model: new MainAgentToolLoopModel({ database }),
    gateway,
    approvalService,
    delegationCoordinator,
    maxTurns: toolLoopLimits.maxTurns,
    maxToolCalls: toolLoopLimits.maxToolCalls,
  });
  const delegatedProcessor = completionService
    ? new DelegatedAgentRunProcessor({
        database,
        model: new DelegatedAgentModel({ database }),
        gateway,
        terminalCommitter: completionService,
      })
    : undefined;
  const executorProcessor = completionService && delegationGrantService
    ? new ExecutorAgentRunProcessor({
        database,
        gateway,
        approvalService,
        delegationGrantService,
        terminalCommitter: completionService,
      })
    : undefined;
  const processor = new AgentRunProcessorRouter({
    database,
    textProcessor,
    toolLoopProcessor,
    delegatedProcessor,
    executorProcessor,
  });
  const agentSurface = inspectAgentSurfaceReadiness(env);
  if (agentSurface.required && !isAgentBillingReconcileEnabled(env)) {
    throw new TypeError("FANJIN_AGENT_BILLING_RECONCILE_ENABLED=1 is required for the complete Agent surface");
  }
  const billingReconciler = isAgentBillingReconcileEnabled(env)
    ? new AgentBillingReconciler({
        database,
        logger: options.logger,
        lookbackMs: envPositiveInteger(
          env,
          "FANJIN_AGENT_BILLING_RECONCILE_LOOKBACK_MS",
          24 * 60 * 60_000,
        ),
      })
    : null;
  return new AgentRuntimeWorkerService({
    worker,
    processor,
    approvalExpirySweeper: approvalService,
    executorExternalWaitSweeper: executorProcessor ?? undefined,
    executorExternalWaitStaleAfterMs: envPositiveInteger(
      env,
      "FANJIN_AGENT_EXECUTOR_EXTERNAL_WAIT_STALE_AFTER_MS",
      DEFAULT_EXECUTOR_EXTERNAL_WAIT_STALE_AFTER_MS,
    ),
    executorExternalWaitSweepIntervalMs: envPositiveInteger(
      env,
      "FANJIN_AGENT_EXECUTOR_EXTERNAL_WAIT_SWEEP_INTERVAL_MS",
      DEFAULT_EXECUTOR_EXTERNAL_WAIT_SWEEP_INTERVAL_MS,
    ),
    agentBillingReconciler: billingReconciler,
    agentBillingReconciliationRequired: agentSurface.required,
    agentBillingReconcileIntervalMs: billingReconciler
      ? envPositiveInteger(
          env,
          "FANJIN_AGENT_BILLING_RECONCILE_INTERVAL_MS",
          DEFAULT_BILLING_RECONCILE_INTERVAL_MS,
        )
      : DEFAULT_BILLING_RECONCILE_INTERVAL_MS,
    pollIntervalMs: envPositiveInteger(env, "FANJIN_AGENT_WORKER_POLL_MS", DEFAULT_POLL_INTERVAL_MS),
    logger: options.logger,
    readinessReporter: createAgentRuntimeWorkerReadinessReporter({
      database,
      workerId,
      environment: env,
    }),
    watchdogTimeoutMs: envPositiveInteger(
      env,
      "FANJIN_AGENT_WORKER_WATCHDOG_MS",
      DEFAULT_WATCHDOG_TIMEOUT_MS,
    ),
    onWatchdogTimeout: () => process.exit(1),
    terminalRunRefundSettler: async (runId) => {
      await settleAgentChatBillingOnTerminalRun({ runId });
    },
  });
}

let configuredService: AgentRuntimeWorkerService | null = null;

export function isConfiguredAgentRuntimeWorkerServiceRunning(): boolean {
  return configuredService?.isRunning === true;
}

export function startConfiguredAgentRuntimeWorkerService(
  options: CreateConfiguredAgentRuntimeWorkerServiceOptions = {},
): AgentRuntimeWorkerService | null {
  if (configuredService) return configuredService;
  const service = createConfiguredAgentRuntimeWorkerService(options);
  if (!service) return null;
  configuredService = service;
  service.start();
  return service;
}

export async function stopConfiguredAgentRuntimeWorkerService(): Promise<void> {
  const service = configuredService;
  configuredService = null;
  if (service) await service.stop();
}
