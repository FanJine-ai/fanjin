import type { Knex } from "knex";
import { parseA4DelegatedRunPolicySnapshot } from "@/agent-runtime/delegatedRunPolicy";
import { getAgentDelegationPersistenceContractForPolicyVersion } from "@/agent-runtime/tools/packages/delegation";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { appendAgentEvent } from "@/agent-runtime/eventStore";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import type {
  AgentRuntimeClaimedRun,
  AgentRuntimeWorkerRepository,
  ClaimRunsInput,
  HeartbeatRunsInput,
  HeartbeatRunsResult,
  RecoverExpiredRunsInput,
  RecoverExpiredRunsResult,
} from "@/agent-runtime/worker";

export type AgentRuntimeLeaseDatabase = Knex | Knex.Transaction;

interface RunLeaseRow {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  rootRunId: string | null;
  parentRunId?: string | null;
  delegationId?: string | null;
  kind?: string | null;
  responseMessageId: string | null;
  sideEffectsCommitted: number | string | boolean | null;
  status: string;
  attempt: number | string | null;
  maxAttempts: number | string | null;
  recoveryCount: number | string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | string | null;
  heartbeatAt: number | string | null;
  version: number | string | null;
  createdAt: number | string | null;
  startedAt: number | string | null;
  agentRole?: string | null;
  policySnapshot?: string | Record<string, unknown> | null;
}

interface ThreadRecoveryRow {
  id: string;
  activeRootRunId: string | null;
  eventSeq: number | string | null;
  version: number | string | null;
}

interface ModelStepRecoveryRow {
  id: string;
  runId: string;
  status: string;
  kind: string;
  inputRefs?: unknown;
  [key: string]: unknown;
}

const MAX_ATTEMPTS_ERROR = {
  code: "max_attempts_exceeded",
  message: "Agent 运行在租约恢复时达到最大尝试次数",
} as const;

const SIDE_EFFECT_RECONCILIATION_ERROR = {
  code: "side_effect_reconciliation_required",
  message: "执行连接已中断，请查询原任务结果；费用记录可在账单中查看，不会重复提交",
} as const;

const CANCELLED_MESSAGE_ERROR = {
  code: "run_cancelled",
  message: "Agent 运行已取消",
} as const;

const MODEL_STEP_UNCERTAIN_ERROR = {
  code: "model_outcome_uncertain",
  message: "模型请求已发出，但暂未确认结果；费用记录可在账单中查看，不会重复提交",
} as const;

function runTable(database: AgentRuntimeLeaseDatabase): Knex.QueryBuilder {
  return (database as Knex)("o_agent_run");
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function candidateLimit(limit: number): number {
  // 多 worker 可能同时读到相同候选；适度多取候选后再逐行 CAS，减少空批次。
  return Math.min(1_000, Math.max(limit, limit * 4));
}

function parsePolicySnapshot(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseRefs(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function modelDispatchState(value: unknown): "prepared" | "dispatched" | null {
  const state = parseRefs(value).find((ref) => ref?.type === "model_dispatch_state")?.value;
  return state === "prepared" || state === "dispatched" ? state : null;
}

export interface KnexRunLeaseRepositoryOptions {
  /** Restrict claims to explicitly model-enabled root runs for the real text executor. */
  requireModelEnabledMainRun?: boolean;
  /** Admit strictly validated A4 writer/visual/storyboard/reviewer child Runs. Disabled by default. */
  allowA4DelegatedRuns?: boolean;
  /**
   * Owns delegated recovery using the canonical root -> child lock order. It
   * must re-read and validate all rows because the supplied candidate is only
   * an unlocked bounded-scan hint.
   */
  delegatedRecoveryHandler?: DelegatedRecoveryHandler;
}

export interface DelegatedRecoveryCandidate {
  readonly runId: string;
  readonly workspaceId: string;
  readonly projectId: number | string;
  readonly threadId: string;
  readonly rootRunId: string | null;
  readonly parentRunId: string | null;
  readonly delegationId: string | null;
  readonly kind: string | null;
  readonly agentRole: string | null;
  readonly responseMessageId: string | null;
  readonly sideEffectsCommitted: boolean;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly recoveryCount: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly heartbeatAt: number | null;
  readonly version: number;
  readonly createdAt: number | null;
}

export type DelegatedRecoveryOutcome =
  | { readonly status: "requeued" | "failed" | "cancelled" }
  | null;

export interface DelegatedRecoveryHandlerInput {
  /** Untrusted scan hint. The handler must re-read root first, then child. */
  readonly candidate: DelegatedRecoveryCandidate;
  readonly recovery: Readonly<RecoverExpiredRunsInput>;
}

export type DelegatedRecoveryHandler = (
  input: DelegatedRecoveryHandlerInput,
) => Promise<DelegatedRecoveryOutcome>;

function constrainToNonDelegatedRuns(query: Knex.QueryBuilder): void {
  query.andWhere((identity) => {
    identity.whereNull("kind").orWhereNot("kind", "delegated");
  });
}

function constrainToModelRootOrDelegatedRuns(
  query: Knex.QueryBuilder,
  includeDelegated: boolean,
): void {
  query.andWhere((eligible) => {
    eligible.where((root) => {
      root
        .where({ kind: "root", agentRole: "main" })
        .whereRaw("?? = ??", ["rootRunId", "id"])
        .whereNull("parentRunId")
        .whereNull("delegationId")
        .andWhere("policySnapshot", "like", '%"modelEnabled":true%');
    });
    if (includeDelegated) eligible.orWhere("kind", "delegated");
  });
}

function canonicalNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isA4DelegatedClaimCandidate(candidate: RunLeaseRow): boolean {
  if (candidate.kind !== "delegated"
    || (candidate.agentRole !== "writer"
      && candidate.agentRole !== "visual"
      && candidate.agentRole !== "storyboard"
      && candidate.agentRole !== "reviewer"
      && candidate.agentRole !== "executor")
    || !canonicalNonEmptyId(candidate.id)
    || !canonicalNonEmptyId(candidate.parentRunId)
    || !canonicalNonEmptyId(candidate.rootRunId)
    || !canonicalNonEmptyId(candidate.delegationId)
    || candidate.rootRunId !== candidate.parentRunId
    || candidate.id === candidate.parentRunId) {
    return false;
  }
  try {
    const policy = parseA4DelegatedRunPolicySnapshot(candidate.policySnapshot, {
      expectedRole: candidate.agentRole,
      expectedDelegationId: candidate.delegationId,
      expectedParentRunId: candidate.parentRunId,
    });
    const contract = getAgentDelegationPersistenceContractForPolicyVersion(
      policy.delegatedTask.version,
    );
    return Boolean(contract
      && policy.delegatedTask.taskVersion === contract.taskVersion
      && (contract.roles as readonly string[]).includes(candidate.agentRole));
  } catch {
    return false;
  }
}

function isModelEnabledRootClaimCandidate(candidate: RunLeaseRow): boolean {
  if (candidate.kind !== "root"
    || candidate.agentRole !== "main"
    || !canonicalNonEmptyId(candidate.id)
    || candidate.rootRunId !== candidate.id
    || candidate.parentRunId != null
    || candidate.delegationId != null) {
    return false;
  }
  return parsePolicySnapshot(candidate.policySnapshot).modelEnabled === true;
}

function nullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function delegatedRecoveryCandidate(row: RunLeaseRow): DelegatedRecoveryCandidate {
  return Object.freeze({
    runId: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: row.projectId,
    threadId: String(row.threadId),
    rootRunId: row.rootRunId == null ? null : String(row.rootRunId),
    parentRunId: row.parentRunId == null ? null : String(row.parentRunId),
    delegationId: row.delegationId == null ? null : String(row.delegationId),
    kind: row.kind == null ? null : String(row.kind),
    agentRole: row.agentRole == null ? null : String(row.agentRole),
    responseMessageId: row.responseMessageId == null ? null : String(row.responseMessageId),
    sideEffectsCommitted: Boolean(Number(row.sideEffectsCommitted || 0)),
    status: String(row.status),
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.maxAttempts || 0),
    recoveryCount: Number(row.recoveryCount || 0),
    leaseOwner: row.leaseOwner == null ? null : String(row.leaseOwner),
    leaseExpiresAt: nullableNumber(row.leaseExpiresAt),
    heartbeatAt: nullableNumber(row.heartbeatAt),
    version: Number(row.version || 0),
    createdAt: nullableNumber(row.createdAt),
  });
}

function delegatedRecoveryStatus(
  outcome: Exclude<DelegatedRecoveryOutcome, null>,
): "requeued" | "failed" | "cancelled" {
  if (outcome.status === "requeued" || outcome.status === "failed" || outcome.status === "cancelled") {
    return outcome.status;
  }
  throw new TypeError("delegatedRecoveryHandler 返回了无效恢复结果");
}

/**
 * SQLite/Postgres 共用的 Agent Run lease adapter。
 *
 * 候选查询只用于减少扫描；所有状态变化都以 status/version/attempt/recoveryCount/lease
 * 为条件逐行更新，因此两个 worker 即使读到同一候选，也只有一个能 claim。
 */
export class KnexRunLeaseRepository implements AgentRuntimeWorkerRepository<AgentRuntimeClaimedRun> {
  private readonly requireModelEnabledMainRun: boolean;
  private readonly allowA4DelegatedRuns: boolean;
  private readonly delegatedRecoveryHandler: DelegatedRecoveryHandler | null;

  constructor(
    private readonly database: AgentRuntimeLeaseDatabase,
    options: KnexRunLeaseRepositoryOptions = {},
  ) {
    this.requireModelEnabledMainRun = options.requireModelEnabledMainRun === true;
    this.allowA4DelegatedRuns = options.allowA4DelegatedRuns === true;
    if (options.delegatedRecoveryHandler !== undefined
      && typeof options.delegatedRecoveryHandler !== "function") {
      throw new TypeError("delegatedRecoveryHandler 必须是函数");
    }
    this.delegatedRecoveryHandler = options.delegatedRecoveryHandler ?? null;
    if (this.allowA4DelegatedRuns && !this.delegatedRecoveryHandler) {
      throw new TypeError("allowA4DelegatedRuns=true 时必须配置 delegatedRecoveryHandler");
    }
  }

  async claimRuns(input: ClaimRunsInput): Promise<readonly AgentRuntimeClaimedRun[]> {
    const query = runTable(this.database)
      .where({ status: "queued" })
      .andWhere("recoveryCount", "<", input.maxAttempts)
      .whereRaw("?? < ??", ["recoveryCount", "maxAttempts"]);
    if (this.requireModelEnabledMainRun) {
      // The SQL predicate is only a bounded-scan hint. Exact root identity and
      // strict policy parsing below remain the actual admission decision.
      constrainToModelRootOrDelegatedRuns(query, this.allowA4DelegatedRuns);
    } else if (!this.allowA4DelegatedRuns) {
      constrainToNonDelegatedRuns(query);
    }
    const selectColumns = [
      "id",
      "workspaceId",
      "projectId",
      "threadId",
      "rootRunId",
      "parentRunId",
      "delegationId",
      "kind",
      "agentRole",
      "policySnapshot",
      "attempt",
      "maxAttempts",
      "recoveryCount",
      "version",
      "createdAt",
      "startedAt",
    ];
    const candidates = (await query
      .select(...selectColumns)
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(candidateLimit(input.limit))) as RunLeaseRow[];

    const claimed: AgentRuntimeClaimedRun[] = [];
    for (const candidate of candidates) {
      if (claimed.length >= input.limit) break;
      const isDelegated = candidate.kind === "delegated";
      if (isDelegated) {
        if (!this.allowA4DelegatedRuns || !isA4DelegatedClaimCandidate(candidate)) continue;
      } else if (this.requireModelEnabledMainRun) {
        if (!isModelEnabledRootClaimCandidate(candidate)) continue;
      }
      const attempt = Number(candidate.attempt || 0);
      const recoveryCount = Number(candidate.recoveryCount || 0);
      const version = Number(candidate.version || 0);

      const updateQuery = runTable(this.database)
        .where({ id: candidate.id, status: "queued", version })
        .andWhere("attempt", attempt)
        .andWhere("recoveryCount", recoveryCount)
        .andWhere("recoveryCount", "<", input.maxAttempts)
        .whereRaw("?? < ??", ["recoveryCount", "maxAttempts"]);
      if (isDelegated) {
        updateQuery.andWhere({
          kind: "delegated",
          agentRole: candidate.agentRole,
          rootRunId: candidate.rootRunId,
          parentRunId: candidate.parentRunId,
          delegationId: candidate.delegationId,
        });
      } else if (this.requireModelEnabledMainRun) {
        updateQuery
          .andWhere({ kind: "root", agentRole: "main", rootRunId: candidate.id })
          .whereNull("parentRunId")
          .whereNull("delegationId");
      } else {
        // Identity is immutable, but this guard also prevents a stale generic
        // candidate from claiming a row concurrently changed to delegated.
        constrainToNonDelegatedRuns(updateQuery);
      }
      const updated = await updateQuery.update({
        status: "running",
        leaseOwner: input.workerId,
        leaseExpiresAt: input.leaseExpiresAt,
        heartbeatAt: input.now,
        attempt: this.database.raw("?? + 1", ["attempt"]),
        startedAt: this.database.raw("COALESCE(??, ?)", ["startedAt", input.now]),
        version: this.database.raw("?? + 1", ["version"]),
        updatedAt: input.now,
      });

      if (affectedRows(updated) !== 1) continue;
      claimed.push({
        id: String(candidate.id),
        attempt: attempt + 1,
        leaseOwner: input.workerId,
        leaseExpiresAt: input.leaseExpiresAt,
      });
    }
    return claimed;
  }

  async heartbeatRuns(input: HeartbeatRunsInput): Promise<HeartbeatRunsResult> {
    const renewedIds: string[] = [];
    const lostIds: string[] = [];
    const runIds = [...new Set(input.runIds.map((id) => String(id).trim()).filter(Boolean))];

    for (const id of runIds) {
      const updated = await runTable(this.database)
        .where({ id, leaseOwner: input.workerId })
        .whereIn("status", ["running", "cancelling"])
        .andWhere("leaseExpiresAt", ">", input.now)
        .update({
          leaseExpiresAt: input.leaseExpiresAt,
          heartbeatAt: input.now,
          version: this.database.raw("?? + 1", ["version"]),
          updatedAt: input.now,
        });
      if (affectedRows(updated) === 1) renewedIds.push(id);
      else lostIds.push(id);
    }

    return { renewedIds, lostIds };
  }

  async recoverExpiredRuns(input: RecoverExpiredRunsInput): Promise<RecoverExpiredRunsResult> {
    const expiredQuery = runTable(this.database)
      .whereIn("status", ["running", "cancelling"])
      .whereNotNull("leaseExpiresAt")
      .andWhere("leaseExpiresAt", "<=", input.now);
    if (!this.delegatedRecoveryHandler) constrainToNonDelegatedRuns(expiredQuery);
    const expiredCandidates = (await expiredQuery
      .select(
        "id",
        "workspaceId",
        "projectId",
        "threadId",
        "rootRunId",
        "parentRunId",
        "delegationId",
        "kind",
        "agentRole",
        "responseMessageId",
        "sideEffectsCommitted",
        "policySnapshot",
        "status",
        "attempt",
        "maxAttempts",
        "recoveryCount",
        "leaseOwner",
        "leaseExpiresAt",
        "heartbeatAt",
        "version",
        "createdAt",
      )
      .orderBy("leaseExpiresAt", "asc")
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(candidateLimit(input.limit))) as RunLeaseRow[];

    const queuedExhaustedQuery = runTable(this.database)
      .where({ status: "queued" })
      // recoveryCount=0 includes ordinary Approval resumes. Claim attempts are
      // intentionally not part of the expired-lease recovery budget.
      .andWhere("recoveryCount", ">", 0)
      .andWhere((limits) => {
        limits
          .where("recoveryCount", ">=", input.maxAttempts)
          .orWhereRaw("?? >= ??", ["recoveryCount", "maxAttempts"]);
      });
    if (this.requireModelEnabledMainRun) {
      constrainToModelRootOrDelegatedRuns(queuedExhaustedQuery, Boolean(this.delegatedRecoveryHandler));
    } else if (!this.delegatedRecoveryHandler) {
      constrainToNonDelegatedRuns(queuedExhaustedQuery);
    }
    const queuedExhaustedCandidates = (await queuedExhaustedQuery
      .select(
        "id",
        "workspaceId",
        "projectId",
        "threadId",
        "rootRunId",
        "parentRunId",
        "delegationId",
        "kind",
        "responseMessageId",
        "sideEffectsCommitted",
        "agentRole",
        "policySnapshot",
        "status",
        "attempt",
        "maxAttempts",
        "recoveryCount",
        "leaseOwner",
        "leaseExpiresAt",
        "heartbeatAt",
        "version",
        "createdAt",
      )
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(candidateLimit(input.limit))) as RunLeaseRow[];

    // Keep a single bounded outcome budget across expired leases and queued
    // runs made exhausted by a lower live worker limit. Oldest work wins;
    // every mutation below still uses a per-row transactional CAS.
    const candidates = [...expiredCandidates, ...queuedExhaustedCandidates]
      .sort((left, right) => {
        const leftAt = left.status === "queued" ? Number(left.createdAt || 0) : Number(left.leaseExpiresAt || 0);
        const rightAt = right.status === "queued" ? Number(right.createdAt || 0) : Number(right.leaseExpiresAt || 0);
        return leftAt - rightAt || String(left.id).localeCompare(String(right.id));
      })
      .slice(0, candidateLimit(input.limit));

    const requeuedIds: string[] = [];
    const failedIds: string[] = [];
    const cancelledIds: string[] = [];
    const recovery = Object.freeze({ ...input });
    for (const candidate of candidates) {
      if (requeuedIds.length + failedIds.length + cancelledIds.length >= input.limit) break;
      if (candidate.kind === "delegated") {
        // Never acquire the child Run lock here. The handler owns the canonical
        // root -> child lock order and must treat this candidate as untrusted.
        if (!this.delegatedRecoveryHandler) continue;
        const delegatedOutcome = await this.delegatedRecoveryHandler(Object.freeze({
          candidate: delegatedRecoveryCandidate(candidate),
          recovery,
        }));
        if (delegatedOutcome === null) continue;
        const status = delegatedRecoveryStatus(delegatedOutcome);
        if (status === "requeued") requeuedIds.push(String(candidate.id));
        if (status === "failed") failedIds.push(String(candidate.id));
        if (status === "cancelled") cancelledIds.push(String(candidate.id));
        continue;
      }
      const candidateWasQueuedExhausted = candidate.status === "queued";

      const outcome = await this.database.transaction(async (trx) => {
        // The outer candidate is only a bounded scan hint. Model-result commit
        // takes this same Run lock first, so every recovery decision below is
        // based on state observed after any competing commit has finished.
        const run = (await runTable(trx)
          .where({ id: candidate.id, workspaceId: candidate.workspaceId })
          .andWhere((identity) => {
            identity.whereNull("kind").orWhereNot("kind", "delegated");
          })
          .forUpdate()
          .first()) as RunLeaseRow | undefined;
        if (!run) return null;

        const attempt = Number(run.attempt || 0);
        const recoveryCount = Number(run.recoveryCount || 0);
        const rowMaxAttempts = Number(run.maxAttempts || input.maxAttempts);
        const effectiveMaxAttempts = Math.min(input.maxAttempts, rowMaxAttempts);
        const isQueuedExhausted = candidateWasQueuedExhausted && run.status === "queued";
        if (candidateWasQueuedExhausted) {
          if (!isQueuedExhausted || recoveryCount <= 0 || recoveryCount < effectiveMaxAttempts) return null;
          if (this.requireModelEnabledMainRun) {
            if (!isModelEnabledRootClaimCandidate(run)) return null;
          }
        } else if (
          !["running", "cancelling"].includes(run.status)
          || run.leaseExpiresAt == null
          || Number(run.leaseExpiresAt) > input.now
        ) {
          return null;
        }

        const hasCommittedSideEffects = Boolean(Number(run.sideEffectsCommitted || 0));
        const policySnapshot = parsePolicySnapshot(run.policySnapshot);
        const toolLoopEnabled = policySnapshot.toolsEnabled === true;
        let toolLoopCheckpointSafe = false;
        if (!isQueuedExhausted && toolLoopEnabled) {
          const latestModelStep = (await (trx as any)("o_agent_step")
            .where({ runId: run.id, workspaceId: run.workspaceId, kind: "model" })
            .select("id", "status", "inputRefs")
            .orderBy("seq", "desc")
            .forUpdate()
            .first()) as ModelStepRecoveryRow | undefined;
          // A durable succeeded Turn can be replayed from outputRefs, while a
          // prepared Turn has not crossed provider I/O. A dispatched, uncertain,
          // failed or malformed Turn always keeps the A1 reconciliation gate.
          toolLoopCheckpointSafe = latestModelStep?.status === "succeeded"
            || (latestModelStep?.status === "running"
              && modelDispatchState(latestModelStep.inputRefs) === "prepared");
        }
        const requiresReconciliation = !isQueuedExhausted && hasCommittedSideEffects
          && (!toolLoopEnabled || !toolLoopCheckpointSafe);
        const isCancelling = run.status === "cancelling";
        const nextRecoveryCount = isQueuedExhausted || isCancelling ? recoveryCount : recoveryCount + 1;
        const shouldFail = isQueuedExhausted || (!isCancelling
          && (requiresReconciliation || nextRecoveryCount >= effectiveMaxAttempts));
        const failureError = requiresReconciliation ? SIDE_EFFECT_RECONCILIATION_ERROR : MAX_ATTEMPTS_ERROR;
        const nextStatus = isCancelling ? "cancelled" : shouldFail ? "failed" : "queued";
        const version = Number(run.version || 0);

        // Run CAS is the first write. Step/Message/Thread/Event mutations below
        // share this transaction and roll back together on any conflict.
        const updateQuery = runTable(trx)
          .where({
            id: run.id,
            workspaceId: run.workspaceId,
            status: run.status,
            version,
            attempt,
            recoveryCount,
          });
        if (isQueuedExhausted) {
          updateQuery
            .andWhere("recoveryCount", ">", 0)
            .andWhere((limits) => {
              limits
                .where("recoveryCount", ">=", input.maxAttempts)
                .orWhereRaw("?? >= ??", ["recoveryCount", "maxAttempts"]);
            });
        } else {
          updateQuery
            .where({ leaseOwner: run.leaseOwner, leaseExpiresAt: run.leaseExpiresAt })
            .andWhere("leaseExpiresAt", "<=", input.now);
        }
        const updated = await updateQuery.update({
            status: nextStatus,
            recoveryCount: nextRecoveryCount,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            error: shouldFail ? JSON.stringify(failureError) : null,
            completedAt: nextStatus === "queued" ? null : input.now,
            version: trx.raw("?? + 1", ["version"]),
            updatedAt: input.now,
          });
        if (affectedRows(updated) !== 1) return null;

        let terminalModelStep: ReturnType<typeof mapAgentStep> | null = null;
        let stepEventType: "step.failed" | "step.cancelled" | "step.uncertain" | null = null;
        if (nextStatus !== "queued") {
          const modelStep = (await (trx as any)("o_agent_step")
            .where({ runId: run.id, workspaceId: run.workspaceId, kind: "model", status: "running" })
            .orderBy("seq", "desc")
            .first()) as ModelStepRecoveryRow | undefined;
          if (modelStep) {
            const stepStatus = requiresReconciliation ? "uncertain" : isCancelling ? "cancelled" : "failed";
            const stepError = requiresReconciliation
              ? MODEL_STEP_UNCERTAIN_ERROR
              : isCancelling
                ? CANCELLED_MESSAGE_ERROR
                : MAX_ATTEMPTS_ERROR;
            const stepUpdated = await (trx as any)("o_agent_step")
              .where({ id: modelStep.id, runId: run.id, status: "running", kind: "model" })
              .update({
                status: stepStatus,
                errorCategory: stepError.code,
                safeError: JSON.stringify(stepError),
                updatedAt: input.now,
                completedAt: input.now,
              });
            if (affectedRows(stepUpdated) !== 1) {
              throw new Error(`Run ${run.id} 恢复时模型 Step 发生版本冲突`);
            }
            terminalModelStep = mapAgentStep({
              ...modelStep,
              status: stepStatus,
              errorCategory: stepError.code,
              safeError: stepError,
              updatedAt: input.now,
              completedAt: input.now,
            });
            stepEventType = requiresReconciliation
              ? "step.uncertain"
              : isCancelling
                ? "step.cancelled"
                : "step.failed";
          }
        }

        let responseMessageEvent: {
          type: "message.stopped" | "message.error";
          status: "stopped" | "error";
          code: string;
        } | null = null;
        if (run.responseMessageId) {
          const responseMessage = await (trx as any)("o_agent_message")
            .where({
              id: run.responseMessageId,
              runId: run.id,
              threadId: run.threadId,
              workspaceId: run.workspaceId,
            })
            .select("id", "status")
            .first();
          if (responseMessage && ["pending", "streaming"].includes(String(responseMessage.status))) {
            if (isCancelling) {
              const messageUpdated = await (trx as any)("o_agent_message")
                .where({
                  id: run.responseMessageId,
                  runId: run.id,
                  threadId: run.threadId,
                  workspaceId: run.workspaceId,
                  status: responseMessage.status,
                })
                .update({
                  status: "stopped",
                  error: JSON.stringify(CANCELLED_MESSAGE_ERROR),
                  updatedAt: input.now,
                  completedAt: input.now,
                });
              if (affectedRows(messageUpdated) !== 1) {
                throw new Error(`Run ${run.id} 恢复取消时响应消息发生版本冲突`);
              }
              responseMessageEvent = {
                type: "message.stopped",
                status: "stopped",
                code: CANCELLED_MESSAGE_ERROR.code,
              };
            } else if (shouldFail) {
              const messageUpdated = await (trx as any)("o_agent_message")
                .where({
                  id: run.responseMessageId,
                  runId: run.id,
                  threadId: run.threadId,
                  workspaceId: run.workspaceId,
                  status: responseMessage.status,
                })
                .update({
                  status: "error",
                  error: JSON.stringify(failureError),
                  updatedAt: input.now,
                  completedAt: input.now,
                });
              if (affectedRows(messageUpdated) !== 1) {
                throw new Error(`Run ${run.id} 恢复时响应消息发生版本冲突`);
              }
              responseMessageEvent = {
                type: "message.error",
                status: "error",
                code: failureError.code,
              };
            }
          }
        }

        const thread = (await (trx as any)("o_agent_thread")
          .where({ id: run.threadId, workspaceId: run.workspaceId })
          .select("id", "activeRootRunId", "eventSeq", "version")
          .first()) as ThreadRecoveryRow | undefined;
        if (!thread) throw new Error(`Run ${run.id} 对应的 Agent Thread 不存在`);

        const threadVersion = Number(thread.version || 0);
        const firstEventSeq = Number(thread.eventSeq || 0) + 1;
        const stepEventCount = terminalModelStep ? 1 : 0;
        const messageEventSeq = firstEventSeq + stepEventCount;
        const terminalEventSeq = messageEventSeq + (responseMessageEvent ? 1 : 0);
        const threadPatch: Record<string, unknown> = {
          eventSeq: terminalEventSeq,
          version: threadVersion + 1,
          updatedAt: input.now,
        };
        if ((isCancelling || shouldFail) && thread.activeRootRunId === run.id) {
          threadPatch.activeRootRunId = null;
        }
        const threadUpdated = await (trx as any)("o_agent_thread")
          .where({ id: run.threadId, workspaceId: run.workspaceId, version: threadVersion })
          .update(threadPatch);
        if (affectedRows(threadUpdated) !== 1) {
          throw new Error(`Run ${run.id} 恢复时 Agent Thread 发生版本冲突`);
        }

        if (terminalModelStep && stepEventType) {
          await appendAgentEvent(trx, {
            workspaceId: String(run.workspaceId),
            projectId: Number(run.projectId),
            threadId: run.threadId,
            runId: run.id,
            messageId: run.responseMessageId,
            stepId: terminalModelStep.id,
            seq: firstEventSeq,
            type: stepEventType,
            payload: { step: toAgentStepDto(terminalModelStep) },
            createdAt: input.now,
          });
        }

        if (responseMessageEvent && run.responseMessageId) {
          await appendAgentEvent(trx, {
            workspaceId: String(run.workspaceId),
            projectId: Number(run.projectId),
            threadId: run.threadId,
            runId: run.id,
            messageId: run.responseMessageId,
            seq: messageEventSeq,
            type: responseMessageEvent.type,
            payload: {
              messageId: run.responseMessageId,
              status: responseMessageEvent.status,
              code: responseMessageEvent.code,
            },
            createdAt: input.now,
          });
        }

        await appendAgentEvent(trx, {
          workspaceId: String(run.workspaceId),
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: run.responseMessageId,
          seq: terminalEventSeq,
          type: isCancelling ? "run.cancelled" : shouldFail ? "run.failed" : "run.requeued",
          payload: {
            runId: run.id,
            status: nextStatus,
            reason: isQueuedExhausted
              ? "max_attempts_exhausted_before_claim"
              : isCancelling
              ? "cancel_lease_expired"
              : requiresReconciliation
                ? "side_effect_state_uncertain"
                : "lease_expired",
            attempt,
            recoveryCount: nextRecoveryCount,
            maxAttempts: effectiveMaxAttempts,
            ...(shouldFail ? { error: failureError } : {}),
          },
          createdAt: input.now,
        });

        return isCancelling ? "cancelled" : shouldFail ? "failed" : "requeued";
      });

      if (outcome === "failed") failedIds.push(String(candidate.id));
      if (outcome === "requeued") requeuedIds.push(String(candidate.id));
      if (outcome === "cancelled") cancelledIds.push(String(candidate.id));
    }

    return { requeuedIds, failedIds, cancelledIds };
  }
}
