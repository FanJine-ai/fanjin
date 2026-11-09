import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import {
  type AgentTaskV3,
  type AgentTaskResult,
  type AgentTaskResultStatus,
} from "@/agent-runtime/delegationContracts";
import { parseA4DelegatedRunPolicySnapshot } from "@/agent-runtime/delegatedRunPolicy";
import {
  getAgentDelegationPersistenceContractForPolicyVersion,
  type AgentDelegationPersistenceContract,
} from "@/agent-runtime/tools/packages/delegation";
import {
  foldStoryVideoTransitionOutcomes,
  planStoryVideoTransitionTasks,
  type StoryVideoTransitionTask,
} from "@/agent-runtime/executionSpec";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { appendAgentEvent, type AppendAgentEventInput } from "@/agent-runtime/eventStore";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import type { AgentRunProcessInput, AgentRunProcessResult } from "@/agent-runtime/runProcessor";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import type { AgentStep } from "@/agent-runtime/types";
import type {
  AgentModelApprovalPreparation,
  AgentToolGatewayExecuteResult,
} from "@/agent-runtime/tools/gateway";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import type {
  AgentApprovalImpactSummary,
  AgentApprovalQuote,
  AgentApprovalService,
} from "@/agent-runtime/approvalService";
import type { DelegationGrantService } from "@/agent-runtime/delegationGrantService";
import type {
  DelegatedAgentTerminalCommitter,
  DelegatedAgentTerminalCommitInput,
} from "@/agent-runtime/delegatedAgentRunProcessor";
import { ChildOnlyDelegatedAgentTerminalCommitter } from "@/agent-runtime/delegatedAgentRunProcessor";
import type { AgentRuntimeClaimedRun } from "@/agent-runtime/worker";
import type { ToolId } from "@/agent-runtime/toolIds";

const UNIT_STEP_PREFIX = "agent-executor-unit";
const UNIT_RECONCILIATION_REF = "executor_unit_checkpoint_reconciliation";
const UNIT_RECONCILED_REF = "executor_unit_checkpoint_reconciled";
const UNIT_RECONCILIATION_PROTOCOL = "executor-unit-checkpoint-reconciliation/v1";
const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1_000;

const CANCELLED_ERROR = Object.freeze({
  code: "run_cancelled",
  message: "生成执行 Run 已取消",
});

const GENERIC_FAILURE = Object.freeze({
  code: "executor_pipeline_failed",
  message: "生成执行管线失败",
});

/** storyVideo 失败语义（P5 5.2）：单段失败 → 管线失败，不自动重试扣费。 */
const TRANSITION_RETRY_POLICY = "explicit-task-retry-only";
const TERMINAL_RELAY_TASK_STATUSES = ["succeeded", "mocked", "failed", "cancelled"] as const;

interface RawRun {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  rootRunId: string;
  parentRunId: string | null;
  delegationId: string | null;
  kind: string;
  triggerMessageId: string;
  responseMessageId: string | null;
  agentRole: string;
  status: string;
  waitType: string | null;
  waitRef: string | null;
  policySnapshot: unknown;
  checkpointStepSeq: number | string | null;
  sideEffectsCommitted: number | string | boolean | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | string | null;
  attempt: number | string | null;
  version: number | string | null;
  error: unknown;
  completedAt: number | string | null;
}

interface RawThread {
  id: string;
  messageSeq: number | string | null;
  eventSeq: number | string | null;
  version: number | string | null;
}

interface RawDelegation {
  id: string;
  actorUserId: number | string;
  workspaceId: string;
  projectId: number | string;
  parentRunId: string;
  parentStepId: string;
  boundRunId: string | null;
  granteeRole: string;
  taskVersion: number | string | null;
  taskJson: unknown;
  taskHash: string | null;
  taskStatus: string | null;
  resultJson: unknown;
  resultHash: string | null;
  resultMessageId: string | null;
  startedAt: number | string | null;
  completedAt: number | string | null;
  safeError: unknown;
  updatedAt: number | string;
}

interface RawStep {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  runId: string;
  parentStepId: string | null;
  seq: number | string;
  agentRole: string;
  kind: string;
  status: string;
  toolName: string | null;
  argumentsDigest: string | null;
  inputRefs: unknown;
  outputRefs: unknown;
  idempotencyKey: string | null;
  resolvedModel: string | null;
  provider: null;
  usage: unknown;
  costMicros: number | string | null;
  errorCategory: string | null;
  safeError: unknown;
  createdAt: number | string;
  updatedAt: number | string;
  startedAt: number | string | null;
  completedAt: number | string | null;
}

/** 段单元持久化进度（unit Step outputRefs 首项）。 */
interface ExecutorUnitProgress {
  type: "executor_unit_result";
  unit: "transition" | "merge";
  index: number;
  status: "submitted" | "succeeded" | "failed" | "denied" | "expired";
  relayTaskId?: string;
  assetVersionId?: number;
  errorCode?: string;
  errorMessage?: string;
}

interface ExecutorUnitCheckpointReconciliation {
  type: typeof UNIT_RECONCILIATION_REF;
  protocol: typeof UNIT_RECONCILIATION_PROTOCOL;
  unit: "transition" | "merge";
  index: number;
  gatewayStepId: string;
  gatewayIdempotencyKey: string;
  toolName: "generation.video.submit" | "video.merge";
  argumentsDigest: string;
  authorizationDigest: string;
  gatewayOutputDigest: string;
  authoritativeProgressDigest: string;
  observedProgressDigest: string;
}

interface ExecutorGatewayCheckpointProof {
  gatewayStepId: string;
  gatewayIdempotencyKey: string;
  toolName: "generation.video.submit" | "video.merge";
  argumentsDigest: string;
  authorizationDigest: string;
  gatewayOutputDigest: string;
}

type UnitTerminalCommitResult =
  | "committed"
  | "already_committed"
  | "reconciliation_required"
  | "conflict"
  | "lease_lost";

interface PreparedExecutorLoop {
  kind: "ready";
  run: RawRun;
  delegation: RawDelegation;
  task: AgentTaskV3;
  contract: AgentDelegationPersistenceContract;
  taskHash: string;
  responseMessageId: string;
}

type PrepareResult =
  | PreparedExecutorLoop
  | { kind: "lease_lost"; responseMessageId: string | null }
  | { kind: "terminal"; result: AgentRunProcessResult };

export interface ExecutorAgentToolGateway {
  prepareExecutorApprovalInTransaction(
    trx: Knex.Transaction,
    input: { runId: string; stepId: string; toolName: string; arguments: unknown },
  ): Promise<AgentModelApprovalPreparation>;
  execute(input: {
    runId: string;
    toolName: string;
    arguments: unknown;
    approvalId?: string | null;
    idempotencyKey: string;
    claimFence: { workerId: string; attempt: number };
  }): Promise<AgentToolGatewayExecuteResult>;
  replaySucceeded(input: {
    runId: string;
    toolName: string;
    arguments: unknown;
    approvalId?: string | null;
    idempotencyKey: string;
    claimFence: { workerId: string; attempt: number };
    expectedStepId: string;
    expectedOutputDigest: string;
  }): Promise<AgentToolGatewayExecuteResult>;
}

export interface ExecutorAgentApprovalService {
  requestInTransaction(
    trx: Knex.Transaction,
    input: {
      workspaceId: string;
      projectId: number;
      runId: string;
      stepId: string;
      requestedBy: number;
      toolId: ToolId;
      toolVersion: string;
      riskClass: "R2" | "R3";
      arguments: unknown;
      resourceVersions: Readonly<Record<string, string>>;
      quote: AgentApprovalQuote | null;
      impactSummary: AgentApprovalImpactSummary | null;
      policyVersion: string;
      expiresAt: number;
    },
  ): Promise<{ id: string }>;
  get(input: { workspaceId: string; projectId: number; approvalId: string }): Promise<{
    id: string;
    status: string;
    runId: string;
  }>;
}

export interface ExecutorDelegationGrantService {
  verifyRunGrantInTransaction(
    trx: Knex.Transaction,
    input: {
      grantId: string;
      runId: string;
      actorUserId: number;
      workspaceId: string;
      projectId: number;
      agentRole: "executor";
    },
    now?: number,
  ): Promise<{
    grant: { allowedTools: readonly string[] };
    task: unknown;
    taskHash: string;
  }>;
}

export interface ExecutorAgentRunProcessorHooks {
  afterUnitStepPrepared?(input: { runId: string; unit: "transition" | "merge"; index: number; stepId: string }): Promise<void>;
  afterApprovalRequested?(input: { runId: string; unit: "transition" | "merge"; index: number; approvalId: string }): Promise<void>;
  afterUnitExecuted?(input: { runId: string; unit: "transition" | "merge"; index: number; stepId: string }): Promise<void>;
  /** Test/observability boundary after pending relay facts were read and before parking the Run. */
  beforeExternalWaitCommit?(input: { runId: string }): Promise<void>;
  afterTerminalResultCommitted?(input: {
    runId: string;
    taskStatus: AgentTaskResultStatus;
    resultMessageId: string;
  }): Promise<void>;
}

export interface ExecutorAgentRunProcessorOptions {
  database: Knex;
  gateway: ExecutorAgentToolGateway;
  approvalService: ExecutorAgentApprovalService;
  delegationGrantService: ExecutorDelegationGrantService;
  terminalCommitter?: DelegatedAgentTerminalCommitter;
  clock?: () => number;
  messageIdFactory?: () => string;
  stepIdFactory?: () => string;
  hooks?: ExecutorAgentRunProcessorHooks;
  eventAppender?: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
}

class ExecutorProcessorSafeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExecutorProcessorSafeError";
  }
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArray(value: unknown): Array<Record<string, unknown>> {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
}

function hasCurrentLiveLease(run: RawRun, workerId: string, attempt: number, now: number): boolean {
  return run.leaseOwner === workerId
    && Number(run.attempt || 0) === attempt
    && Number(run.leaseExpiresAt || 0) > now;
}

function hasLiveLease(run: RawRun, workerId: string, attempt: number, now: number): boolean {
  return run.status === "running" && hasCurrentLiveLease(run, workerId, attempt, now);
}

function asAgentStep(row: RawStep): AgentStep {
  return mapAgentStep(row);
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof ExecutorProcessorSafeError) return { code: error.code, message: error.message };
  if (error instanceof AgentToolGatewayError) return { code: error.code, message: error.message };
  return { code: GENERIC_FAILURE.code, message: GENERIC_FAILURE.message };
}

function isRecoverableDetachedGatewayOutcome(error: unknown): boolean {
  return error instanceof AgentToolGatewayError
    && (
      error.code === "idempotency_in_progress"
      || error.code === "WORKSPACE_GENERATION_QUEUED"
      || error.code === "tool_terminal_uncertain"
      || error.code === "tool_domain_commit_receipt_uncertain"
    );
}

function sameUnitProgress(
  left: ExecutorUnitProgress,
  right: ExecutorUnitProgress,
): boolean {
  return hashIdempotencyRequest(left) === hashIdempotencyRequest(right);
}

function isSubmittedToTerminalFold(
  stored: ExecutorUnitProgress,
  next: ExecutorUnitProgress,
): boolean {
  return stored.type === "executor_unit_result"
    && next.type === "executor_unit_result"
    && stored.unit === next.unit
    && stored.index === next.index
    && stored.status === "submitted"
    && (next.status === "succeeded" || next.status === "failed")
    && typeof stored.relayTaskId === "string"
    && stored.relayTaskId.length > 0
    && next.relayTaskId === stored.relayTaskId
    && (next.status !== "succeeded" || next.assetVersionId !== undefined);
}

function unitStepIdempotencyKey(runId: string, unit: "transition" | "merge", index: number): string {
  return `${UNIT_STEP_PREFIX}:${runId}:${unit}:${index}`;
}

function gatewayUnitIdempotencyKey(unit: "transition" | "merge", index: number): string {
  return `executor-unit:${unit}:${index}`;
}

function storedGatewayUnitIdempotencyKey(
  runId: string,
  unit: "transition" | "merge",
  index: number,
): string {
  return `agent-tool:${runId}:${gatewayUnitIdempotencyKey(unit, index)}`;
}

function unitApprovalId(step: Pick<RawStep, "inputRefs">): string | null {
  const ref = parseArray(step.inputRefs).find((item) => item?.type === "executor_approval");
  return typeof ref?.value === "string" && ref.value ? ref.value : null;
}

function unitProgress(step: Pick<RawStep, "outputRefs" | "status">): ExecutorUnitProgress | null {
  const ref = parseArray(step.outputRefs).find((item) => item?.type === "executor_unit_result");
  if (!ref) return null;
  const unit = ref.unit;
  const status = ref.status;
  if ((unit !== "transition" && unit !== "merge")
    || !["submitted", "succeeded", "failed", "denied", "expired"].includes(String(status))) {
    return null;
  }
  return {
    type: "executor_unit_result",
    unit,
    index: Number(ref.index),
    status: status as ExecutorUnitProgress["status"],
    ...(typeof ref.relayTaskId === "string" && ref.relayTaskId ? { relayTaskId: ref.relayTaskId } : {}),
    ...(Number.isSafeInteger(Number(ref.assetVersionId)) && Number(ref.assetVersionId) > 0
      ? { assetVersionId: Number(ref.assetVersionId) }
      : {}),
    ...(typeof ref.errorCode === "string" && ref.errorCode ? { errorCode: ref.errorCode } : {}),
    ...(typeof ref.errorMessage === "string" && ref.errorMessage ? { errorMessage: ref.errorMessage } : {}),
  };
}

function readUnitReconciliation(
  step: Pick<RawStep, "inputRefs">,
): { kind: "none" } | { kind: "invalid" } | {
  kind: "valid";
  value: ExecutorUnitCheckpointReconciliation;
} {
  const matches = parseArray(step.inputRefs).filter((item) => (
    item?.type === UNIT_RECONCILIATION_REF
  ));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length !== 1) return { kind: "invalid" };
  const ref = matches[0]!;
  const expectedKeys = [
    "argumentsDigest",
    "authorizationDigest",
    "authoritativeProgressDigest",
    "gatewayIdempotencyKey",
    "gatewayOutputDigest",
    "gatewayStepId",
    "index",
    "observedProgressDigest",
    "protocol",
    "toolName",
    "type",
    "unit",
  ].sort().join(",");
  if (
    Object.keys(ref).sort().join(",") !== expectedKeys
    || ref.protocol !== UNIT_RECONCILIATION_PROTOCOL
    || (ref.unit !== "transition" && ref.unit !== "merge")
    || !Number.isSafeInteger(ref.index)
    || Number(ref.index) < 0
    || (ref.toolName !== "generation.video.submit" && ref.toolName !== "video.merge")
    || ![ref.gatewayStepId, ref.gatewayIdempotencyKey, ref.argumentsDigest,
      ref.authorizationDigest, ref.gatewayOutputDigest,
      ref.authoritativeProgressDigest, ref.observedProgressDigest]
      .every((value) => typeof value === "string" && value.length > 0)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    value: ref as unknown as ExecutorUnitCheckpointReconciliation,
  };
}

function withApprovalId(inputRefs: unknown, approvalId: string): Array<Record<string, unknown>> {
  const next = parseArray(inputRefs).filter((ref) => ref?.type !== "executor_approval");
  next.push({ type: "executor_approval", value: approvalId });
  return next;
}

/**
 * 确定性 Executor Run 处理器（HANDOFF Executor V3 实施顺序第 4 条）：
 * 不走模型 Tool Loop，按持久化 executionSpec（storyVideo 管线契约）逐步
 * 执行 R2 工具。每个单元（过渡段/成片拼接）= 检查点 Step → 独立审批 →
 * waiting_approval 暂停 → decide 恢复 → gateway.execute；全部段提交后
 * waiting_external，由任务终态通知 re-queue；fold 后按需 merge 单元 →
 * 终态经注入的 DelegatedAgentTerminalCommitter（生产为
 * DelegationCompletionService）提交。
 */
export class ExecutorAgentRunProcessor {
  private readonly database: Knex;
  private readonly gateway: ExecutorAgentToolGateway;
  private readonly approvalService: ExecutorAgentApprovalService;
  private readonly delegationGrantService: ExecutorDelegationGrantService;
  private readonly terminalCommitter: DelegatedAgentTerminalCommitter;
  private readonly clock: () => number;
  private readonly messageIdFactory: () => string;
  private readonly stepIdFactory: () => string;
  private readonly hooks: ExecutorAgentRunProcessorHooks;
  private readonly eventAppender: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;

  constructor(options: ExecutorAgentRunProcessorOptions) {
    this.database = options.database;
    this.gateway = options.gateway;
    this.approvalService = options.approvalService;
    this.delegationGrantService = options.delegationGrantService;
    this.clock = options.clock ?? Date.now;
    this.messageIdFactory = options.messageIdFactory ?? randomUUID;
    this.stepIdFactory = options.stepIdFactory ?? randomUUID;
    this.hooks = options.hooks ?? {};
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
    this.terminalCommitter = options.terminalCommitter ?? new ChildOnlyDelegatedAgentTerminalCommitter({
      database: this.database,
      clock: this.clock,
      eventAppender: this.eventAppender,
    });
  }

  async process(input: AgentRunProcessInput): Promise<AgentRunProcessResult> {
    const workerId = input.workerId.trim();
    if (!workerId || input.claimedRun.leaseOwner !== workerId) {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: null };
    }
    const prepared = await this.ensurePrepared(input, workerId);
    if (prepared.kind === "lease_lost") {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: prepared.responseMessageId };
    }
    if (prepared.kind === "terminal") return prepared.result;

    const cancelled = await this.inspectCancellation(prepared, input, workerId);
    if (cancelled) return cancelled;

    try {
      return await this.runPipeline(prepared, input, workerId);
    } catch (error) {
      if (isRecoverableDetachedGatewayOutcome(error)) {
        return {
          status: "lease_lost",
          runId: prepared.run.id,
          responseMessageId: prepared.responseMessageId,
        };
      }
      if (error instanceof ExecutorProcessorSafeError || error instanceof AgentToolGatewayError) {
        await input.beforeFinalize?.();
        return this.commitTerminal(prepared, input, workerId, {
          status: "failed",
          safeError: safeError(error),
          summary: "生成执行管线在服务端确定性单元失败",
          issues: [safeError(error).message],
        });
      }
      throw error;
    }
  }

  // ── 准备阶段：验证 executor Run/Grant/Task/Policy 并确保内部响应 ────────

  private async ensurePrepared(
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<PrepareResult> {
    return this.database.transaction(async (trx): Promise<PrepareResult> => {
      const run = await trx<RawRun>("o_agent_run").where({ id: input.claimedRun.id }).forUpdate().first();
      const now = this.clock();
      if (!run) return { kind: "lease_lost", responseMessageId: null };

      // 幂等重放：Run 已终态且 delegation 结果完整时直接返回。
      if (["succeeded", "failed", "cancelled"].includes(run.status) && run.responseMessageId && run.delegationId) {
        const delegation = await trx<RawDelegation>("o_agent_delegation")
          .where({ id: run.delegationId, boundRunId: run.id })
          .first();
        const taskStatus = delegation?.taskStatus;
        if (taskStatus && ["succeeded", "failed", "cancelled"].includes(String(taskStatus))
          && delegation?.resultMessageId === run.responseMessageId
          && typeof delegation.resultHash === "string") {
          return {
            kind: "terminal",
            result: {
              status: taskStatus as AgentRunProcessResult["status"] & AgentTaskResultStatus,
              runId: run.id,
              responseMessageId: run.responseMessageId,
            },
          };
        }
        return { kind: "lease_lost", responseMessageId: run.responseMessageId };
      }

      if (!hasCurrentLiveLease(run, workerId, input.claimedRun.attempt, now)
        || !["running", "cancelling"].includes(run.status)
        || run.kind !== "delegated"
        || run.agentRole !== "executor"
        || !run.parentRunId
        || !run.delegationId
        || run.rootRunId === run.id) {
        return { kind: "lease_lost", responseMessageId: run.responseMessageId };
      }

      const delegation = await trx<RawDelegation>("o_agent_delegation")
        .where({
          id: run.delegationId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          parentRunId: run.parentRunId,
          boundRunId: run.id,
          granteeRole: "executor",
        })
        .first();
      if (!delegation || !["queued", "running"].includes(String(delegation.taskStatus))) {
        throw new ExecutorProcessorSafeError("executor_task_checkpoint_invalid", "执行任务检查点不存在或状态无效");
      }

      const policy = parseA4DelegatedRunPolicySnapshot(run.policySnapshot, {
        expectedRole: "executor",
        expectedDelegationId: run.delegationId,
        expectedParentRunId: run.parentRunId,
        expectedParentStepId: delegation.parentStepId,
        expectedTaskHash: delegation.taskHash ?? undefined,
      });
      if (policy.delegatedTask.version !== 3 || policy.modelEnabled !== false) {
        throw new ExecutorProcessorSafeError("executor_run_policy_invalid", "执行 Run 的固定策略不是 V3 executor 策略");
      }
      const contract = getAgentDelegationPersistenceContractForPolicyVersion(policy.delegatedTask.version);
      if (!contract || contract.taskVersion !== 3) {
        throw new ExecutorProcessorSafeError("executor_run_policy_invalid", "执行 Run 的持久化契约无效");
      }
      if (Number(delegation.taskVersion) !== contract.taskVersion) {
        throw new ExecutorProcessorSafeError("executor_task_checkpoint_invalid", "执行任务持久化版本无效");
      }

      // 只读 Grant 验证（签名、绑定、active、actor、父 Run 状态）。
      const verified = await this.delegationGrantService.verifyRunGrantInTransaction(trx, {
        grantId: run.delegationId,
        runId: run.id,
        actorUserId: Number(delegation.actorUserId),
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        agentRole: "executor",
      }, now);
      const task = contract.normalizeTask(parseJson(delegation.taskJson), {
        expectedProjectId: Number(run.projectId),
      }) as AgentTaskV3;
      const taskHash = hashIdempotencyRequest(task);
      if (task.role !== "executor"
        || task.taskType !== "executor.story_video"
        || typeof delegation.taskHash !== "string"
        || taskHash !== delegation.taskHash
        || taskHash !== verified.taskHash
        || delegation.resultJson != null
        || delegation.resultHash != null
        || delegation.resultMessageId != null) {
        throw new ExecutorProcessorSafeError("executor_task_checkpoint_invalid", "执行任务检查点绑定无效");
      }

      const trigger = await trx("o_agent_message")
        .where({
          id: run.triggerMessageId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          role: "user",
          visibility: "internal",
          status: "completed",
        })
        .select("id", "createdBy")
        .first();
      if (!trigger || Number(trigger.createdBy) !== Number(delegation.actorUserId)) {
        throw new ExecutorProcessorSafeError("executor_trigger_invalid", "执行 Agent 内部触发消息无效");
      }
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Executor Run ${run.id} 对应 Thread 不存在`);

      let responseMessageId = run.responseMessageId;
      if (responseMessageId) {
        const response = await trx("o_agent_message")
          .where({
            id: responseMessageId,
            runId: run.id,
            visibility: "internal",
            status: "pending",
          })
          .select("id")
          .first();
        if (!response || delegation.taskStatus !== "running" || delegation.startedAt == null) {
          throw new ExecutorProcessorSafeError("executor_response_invalid", "执行 Agent 内部响应检查点无效");
        }
      } else {
        responseMessageId = this.messageIdFactory();
        const runVersion = Number(run.version || 0);
        const runUpdated = await trx("o_agent_run")
          .where({
            id: run.id,
            workspaceId: run.workspaceId,
            status: run.status,
            leaseOwner: workerId,
            attempt: input.claimedRun.attempt,
            version: runVersion,
          })
          .andWhere("leaseExpiresAt", ">", now)
          .whereNull("responseMessageId")
          .update({ responseMessageId, version: runVersion + 1, updatedAt: now });
        if (affectedRows(runUpdated) !== 1) return { kind: "lease_lost", responseMessageId: null };

        if (run.status === "running" && delegation.taskStatus === "queued") {
          const taskUpdated = await trx("o_agent_delegation")
            .where({ id: delegation.id, taskHash: delegation.taskHash, taskStatus: "queued" })
            .whereNull("startedAt")
            .update({ taskStatus: "running", startedAt: now, updatedAt: now });
          if (affectedRows(taskUpdated) !== 1) {
            throw new ExecutorProcessorSafeError("executor_task_start_conflict", "执行任务启动检查点冲突");
          }
        }

        const messageSeq = Number(thread.messageSeq || 0) + 1;
        const firstEventSeq = Number(thread.eventSeq || 0) + 1;
        const threadVersion = Number(thread.version || 0);
        const threadUpdated = await trx("o_agent_thread")
          .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
          .update({
            messageSeq,
            eventSeq: firstEventSeq + 1,
            version: threadVersion + 1,
            updatedAt: now,
          });
        if (affectedRows(threadUpdated) !== 1) throw new Error(`Executor Run ${run.id} 创建响应时 Thread 版本冲突`);
        await trx("o_agent_message").insert({
          id: responseMessageId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          replyToId: trigger.id,
          clientMessageId: null,
          seq: messageSeq,
          role: "assistant",
          agentRole: "executor",
          visibility: "internal",
          status: "pending",
          content: JSON.stringify([]),
          referenceRefs: JSON.stringify([]),
          createdBy: null,
          error: null,
          metadata: JSON.stringify({ source: "agent-runtime-executor", taskHash: delegation.taskHash }),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
        await this.eventAppender(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          seq: firstEventSeq,
          type: "internal.message.created",
          payload: { messageId: responseMessageId, seq: messageSeq, role: "assistant", status: "pending", visibility: "internal" },
          createdAt: now,
        });
        await this.eventAppender(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          seq: firstEventSeq + 1,
          type: "internal.run.started",
          payload: { runId: run.id, status: run.status, agentRole: "executor", attempt: input.claimedRun.attempt, visibility: "internal" },
          createdAt: now,
        });
        run.responseMessageId = responseMessageId;
      }
      return {
        kind: "ready",
        run,
        delegation,
        task,
        contract,
        taskHash,
        responseMessageId,
      };
    });
  }

  private async inspectCancellation(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult | null> {
    const run = await this.database<RawRun>("o_agent_run").where({ id: prepared.run.id }).first();
    const now = this.clock();
    if (!run || run.responseMessageId !== prepared.responseMessageId
      || !hasCurrentLiveLease(run, workerId, input.claimedRun.attempt, now)) {
      return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
    }
    if (run.status === "running") return null;
    if (run.status !== "cancelling") {
      return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
    }
    await input.beforeFinalize?.();
    return this.commitTerminal(prepared, input, workerId, {
      status: "cancelled",
      safeError: CANCELLED_ERROR,
      summary: CANCELLED_ERROR.message,
      issues: [],
    });
  }

  // ── 管线执行 ────────────────────────────────────────────────────────────

  private async runPipeline(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult> {
    const transitions = planStoryVideoTransitionTasks(prepared.task.executionSpec);

    // 阶段 1：逐段 submit（每段独立审批暂停/恢复）。
    for (const transition of transitions) {
      const outcome = await this.runUnit(prepared, input, workerId, {
        unit: "transition",
        index: transition.index,
        toolName: "generation.video.submit",
        arguments: this.transitionSubmitArguments(prepared, transition),
      });
      if (outcome) return outcome;
    }

    // 阶段 2：全部段已提交 → 等待外部终态。
    const resolved = await this.resolveTransitionOutcomes(
      prepared,
      input,
      workerId,
      transitions,
    );
    if (resolved.kind === "pending") {
      await this.hooks.beforeExternalWaitCommit?.({ runId: prepared.run.id });
      return this.pauseForExternal(prepared, input, workerId);
    }
    if (resolved.kind === "failed") {
      await input.beforeFinalize?.();
      return this.commitTerminal(prepared, input, workerId, {
        status: "failed",
        safeError: {
          code: "executor_transition_failed",
          message: `过渡段 ${resolved.failedIndexes.map((index) => index + 1).join("、")} 生成失败；已成功段保留为已计费事实，失败段只能显式重试`,
        },
        summary: "storyVideo 过渡段存在失败，管线按显式重试策略终止",
        issues: [`失败段：${resolved.failedIndexes.join(", ")}`, `重试策略：${TRANSITION_RETRY_POLICY}`],
      });
    }

    // 阶段 3：全段成功 → 按需 merge 单元。
    if (prepared.task.executionSpec.mergeTransitions) {
      const mergeOutcome = await this.runUnit(prepared, input, workerId, {
        unit: "merge",
        index: 0,
        toolName: "video.merge",
        arguments: { assetVersionIds: resolved.assetVersionIds },
      });
      if (mergeOutcome) return mergeOutcome;
    }

    await input.beforeFinalize?.();
    return this.commitTerminal(prepared, input, workerId, {
      status: "succeeded",
      safeError: null,
      summary: "storyVideo 管线完成：全部过渡段已生成成片",
      issues: [],
    });
  }

  private transitionSubmitArguments(
    prepared: PreparedExecutorLoop,
    transition: StoryVideoTransitionTask,
  ): Record<string, unknown> {
    const video = prepared.task.executionSpec.video;
    return {
      prompt: transition.prompt,
      model: transition.video.model,
      ratio: transition.video.ratio,
      resolution: transition.video.resolution,
      durationSeconds: transition.video.durationSeconds,
      generateAudio: transition.video.generateAudio,
      firstFrameAssetVersionId: transition.firstFrameAssetVersionId,
      lastFrameAssetVersionId: transition.lastFrameAssetVersionId,
    };
  }

  /**
   * 执行一个确定性单元。返回非 null 表示本次 process 调用到此为止
   * （审批暂停 / 外部等待 / 终态）；返回 null 表示单元完成、继续下一单元。
   */
  private async runUnit(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
    unit: {
      unit: "transition" | "merge";
      index: number;
      toolName: "generation.video.submit" | "video.merge";
      arguments: Record<string, unknown>;
    },
  ): Promise<AgentRunProcessResult | null> {
    let step = await this.findUnitStep(prepared.run.id, unit.unit, unit.index);
    if (!step) {
      step = await this.createUnitStep(prepared, input, workerId, unit);
      if (!step) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      await this.hooks.afterUnitStepPrepared?.({
        runId: prepared.run.id,
        unit: unit.unit,
        index: unit.index,
        stepId: step.id,
      });
    }

    const pendingReconciliation = readUnitReconciliation(step);
    if (pendingReconciliation.kind !== "none") {
      if (pendingReconciliation.kind === "invalid") {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      const reconciled = await this.reconcileUnitCheckpoint(
        prepared,
        input,
        workerId,
        step,
        unit,
        pendingReconciliation.value,
      );
      if (!reconciled) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      step = reconciled;
    }

    const progress = unitProgress(step);
    if (progress && (progress.status === "succeeded" || progress.status === "submitted")) {
      return null;
    }
    if (progress && (progress.status === "failed" || progress.status === "denied" || progress.status === "expired")) {
      await input.beforeFinalize?.();
      return this.commitTerminal(prepared, input, workerId, {
        status: "failed",
        safeError: {
          code: progress.status === "denied"
            ? "executor_approval_denied"
            : progress.errorCode ?? "executor_unit_failed",
          message: progress.status === "denied"
            ? `单元 ${unit.unit}#${unit.index} 的审批被拒绝`
            : `单元 ${unit.unit}#${unit.index} 执行失败`,
        },
        summary: `storyVideo 管线在 ${unit.unit}#${unit.index} 终止`,
        issues: [progress.errorMessage ?? `单元状态：${progress.status}`],
      });
    }

    const approvalId = unitApprovalId(step);
    if (!approvalId) {
      return this.pauseForUnitApproval(prepared, input, workerId, step, unit);
    }

    const approval = await this.approvalService.get({
      workspaceId: prepared.run.workspaceId,
      projectId: Number(prepared.run.projectId),
      approvalId,
    });
    if (approval.status === "pending") {
      // 防御：审批仍未决而 Run 已被认领（不应发生——decide/TTL 才 requeue）。
      // 重新进入审批等待而不是执行，保证单次消费语义。
      return this.reenterApprovalWait(prepared, input, workerId, approvalId);
    }
    if (approval.status === "denied" || approval.status === "expired") {
      const updated = await this.markUnitTerminal(prepared, input, workerId, step, {
        type: "executor_unit_result",
        unit: unit.unit,
        index: unit.index,
        status: approval.status === "denied" ? "denied" : "expired",
        errorMessage: approval.status === "denied" ? "审批被拒绝" : "审批已过期",
      });
      if (updated !== "committed" && updated !== "already_committed") {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      await input.beforeFinalize?.();
      return this.commitTerminal(prepared, input, workerId, {
        status: "failed",
        safeError: {
          code: approval.status === "denied" ? "executor_approval_denied" : "executor_approval_expired",
          message: approval.status === "denied"
            ? `单元 ${unit.unit}#${unit.index} 的审批被拒绝`
            : `单元 ${unit.unit}#${unit.index} 的审批已过期`,
        },
        summary: `storyVideo 管线在 ${unit.unit}#${unit.index} 因审批终止`,
        issues: [`审批状态：${approval.status}`],
      });
    }
    if (approval.status !== "approved") {
      throw new ExecutorProcessorSafeError("executor_approval_invalid", "单元审批状态无效");
    }

    // 审批已批准：执行工具（gateway 内部原子消费审批与 Grant）。
    const gatewayIdempotencyKey = gatewayUnitIdempotencyKey(unit.unit, unit.index);
    let gatewayResult: AgentToolGatewayExecuteResult;
    try {
      gatewayResult = await this.gateway.execute({
        runId: prepared.run.id,
        toolName: unit.toolName,
        arguments: unit.arguments,
        approvalId,
        idempotencyKey: gatewayIdempotencyKey,
        claimFence: { workerId, attempt: input.claimedRun.attempt },
      });
    } catch (error) {
      const cancelled = await this.inspectCancellation(prepared, input, workerId);
      if (cancelled) return cancelled;
      if (isRecoverableDetachedGatewayOutcome(error)) {
        // Keep both the Executor unit checkpoint and delegated Run non-terminal.
        // The active owner can still finish, or a later Run attempt can take
        // over the detached Step after this lease expires.
        return {
          status: "lease_lost",
          runId: prepared.run.id,
          responseMessageId: prepared.responseMessageId,
        };
      }
      await input.beforeFinalize?.();
      return this.commitTerminal(prepared, input, workerId, {
        status: "failed",
        safeError: safeError(error),
        summary: `storyVideo 管线在 ${unit.unit}#${unit.index} 工具执行失败`,
        issues: [safeError(error).message],
      });
    }

    const gatewayProgress = this.gatewayProgress(unit, gatewayResult.output);
    const committed = await this.markUnitTerminal(
      prepared,
      input,
      workerId,
      step,
      gatewayProgress,
      {
        gatewayStepId: gatewayResult.stepId,
        gatewayIdempotencyKey: storedGatewayUnitIdempotencyKey(
          prepared.run.id,
          unit.unit,
          unit.index,
        ),
        toolName: unit.toolName,
        argumentsDigest: hashIdempotencyRequest(unit.arguments),
        authorizationDigest: hashIdempotencyRequest({ approvalId }),
        gatewayOutputDigest: hashIdempotencyRequest(gatewayResult.output),
      },
    );
    if (committed !== "committed" && committed !== "already_committed") {
      // A competing checkpoint or a lost claim is not proof that the already
      // executed tool failed. Leave the Run non-terminal for authoritative
      // replay/recovery instead of manufacturing a failed storyVideo result.
      return {
        status: "lease_lost",
        runId: prepared.run.id,
        responseMessageId: prepared.responseMessageId,
      };
    }
    await this.hooks.afterUnitExecuted?.({
      runId: prepared.run.id,
      unit: unit.unit,
      index: unit.index,
      stepId: step.id,
    });
    if (gatewayProgress.status === "failed") {
      await input.beforeFinalize?.();
      return this.commitTerminal(prepared, input, workerId, {
        status: "failed",
        safeError: {
          code: gatewayProgress.errorCode
            ?? (unit.unit === "merge" ? "executor_merge_failed" : "executor_transition_failed"),
          message: gatewayProgress.errorMessage
            ?? (unit.unit === "merge" ? "视频拼接失败" : "视频生成提交失败"),
        },
        summary: unit.unit === "merge"
          ? "storyVideo 拼接单元返回失败，管线终止"
          : "storyVideo 过渡段提交返回失败，管线终止",
        issues: [gatewayProgress.errorMessage ?? "生成单元未产生可用任务或成片"],
      });
    }
    return null;
  }

  private gatewayProgress(
    unit: { unit: "transition" | "merge"; index: number },
    output: unknown,
  ): ExecutorUnitProgress {
    const relayTaskId = this.readRelayTaskId(output);
    const assetVersionId = this.readAssetVersionId(output);
    const record = output && typeof output === "object" && !Array.isArray(output)
      ? output as Record<string, unknown>
      : null;
    const status = typeof record?.status === "string" ? record.status : null;
    const safeCode = typeof record?.code === "string" && record.code
      ? record.code
      : null;
    const safeMessage = typeof record?.message === "string" && record.message
      ? record.message
      : null;
    if (unit.unit === "merge") {
      if (status === "failed") {
        return {
          type: "executor_unit_result",
          unit: "merge",
          index: unit.index,
          status: "failed",
          ...(safeCode ? { errorCode: safeCode } : {}),
          errorMessage: [safeCode, safeMessage].filter(Boolean).join(": ")
            || "旧版 Gateway 记录的拼接结果为失败",
        };
      }
      if (status !== "succeeded" || assetVersionId == null) {
        return {
          type: "executor_unit_result",
          unit: "merge",
          index: unit.index,
          status: "failed",
          errorMessage: "Gateway 拼接成功结果缺少有效 assetVersionId",
        };
      }
      return {
        type: "executor_unit_result",
        unit: "merge",
        index: unit.index,
        status: "succeeded",
        assetVersionId,
      };
    }
    if (status === "failed" || status === "unavailable") {
      return {
        type: "executor_unit_result",
        unit: "transition",
        index: unit.index,
        status: "failed",
        ...(safeCode ? { errorCode: safeCode } : {}),
        errorMessage: [safeCode, safeMessage].filter(Boolean).join(": ")
          || `视频生成提交返回 ${status}`,
      };
    }
    if (status === "succeeded" && assetVersionId != null) {
      return {
        type: "executor_unit_result",
        unit: "transition",
        index: unit.index,
        status: "succeeded",
        assetVersionId,
      };
    }
    const asynchronousStatuses = new Set([
      "succeeded",
      "submitted",
      "queued",
      "pending",
      "processing",
      "running",
    ]);
    if (status && asynchronousStatuses.has(status) && relayTaskId) {
      return {
        type: "executor_unit_result",
        unit: "transition",
        index: unit.index,
        status: "submitted",
        relayTaskId,
      };
    }
    return {
      type: "executor_unit_result",
      unit: "transition",
      index: unit.index,
      status: "failed",
      errorCode: "generation_submit_result_invalid",
      errorMessage: status && asynchronousStatuses.has(status)
        ? `视频生成 ${status} 结果缺少 relayTaskId`
        : "视频生成提交结果状态无效",
    };
  }

  private async reconcileUnitCheckpoint(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
    step: RawStep,
    unit: {
      unit: "transition" | "merge";
      index: number;
      toolName: "generation.video.submit" | "video.merge";
      arguments: Record<string, unknown>;
    },
    reconciliation: ExecutorUnitCheckpointReconciliation,
  ): Promise<RawStep | null> {
    const approvalId = unitApprovalId(step);
    if (!approvalId
      || reconciliation.unit !== unit.unit
      || reconciliation.index !== unit.index
      || reconciliation.toolName !== unit.toolName
      || reconciliation.gatewayIdempotencyKey !== storedGatewayUnitIdempotencyKey(
        prepared.run.id,
        unit.unit,
        unit.index,
      )
      || reconciliation.argumentsDigest !== hashIdempotencyRequest(unit.arguments)
      || reconciliation.authorizationDigest !== hashIdempotencyRequest({ approvalId })) {
      return null;
    }
    let replay: AgentToolGatewayExecuteResult;
    try {
      replay = await this.gateway.replaySucceeded({
        runId: prepared.run.id,
        toolName: unit.toolName,
        arguments: unit.arguments,
        approvalId,
        idempotencyKey: gatewayUnitIdempotencyKey(unit.unit, unit.index),
        claimFence: { workerId, attempt: input.claimedRun.attempt },
        expectedStepId: reconciliation.gatewayStepId,
        expectedOutputDigest: reconciliation.gatewayOutputDigest,
      });
    } catch {
      // Keep the marker and Run non-terminal. Reconciliation must never fall
      // through to execute() or turn an uncertain committed side effect into a
      // business failure.
      return null;
    }
    const authoritativeProgress = this.gatewayProgress(unit, replay.output);
    if (!replay.replayed
      || replay.stepId !== reconciliation.gatewayStepId
      || hashIdempotencyRequest(replay.output) !== reconciliation.gatewayOutputDigest
      || hashIdempotencyRequest(authoritativeProgress)
        !== reconciliation.authoritativeProgressDigest) {
      return null;
    }

    return this.database.transaction(async (trx): Promise<RawStep | null> => {
      const now = this.clock();
      const leaseCas = await trx("o_agent_run")
        .where({
          id: prepared.run.id,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({ updatedAt: trx.ref("updatedAt") });
      if (affectedRows(leaseCas) !== 1) return null;
      const stored = await trx<RawStep>("o_agent_step")
        .where({ id: step.id, runId: prepared.run.id })
        .forUpdate()
        .first();
      if (!stored) return null;
      const currentMarker = readUnitReconciliation(stored);
      const observed = unitProgress(stored);
      if (currentMarker.kind !== "valid"
        || hashIdempotencyRequest(currentMarker.value)
          !== hashIdempotencyRequest(reconciliation)
        || !observed
        || hashIdempotencyRequest(observed) !== reconciliation.observedProgressDigest) {
        return null;
      }
      const previousInputRefs = typeof stored.inputRefs === "string"
        ? stored.inputRefs
        : JSON.stringify(parseArray(stored.inputRefs));
      const previousOutputRefs = typeof stored.outputRefs === "string"
        ? stored.outputRefs
        : JSON.stringify(parseArray(stored.outputRefs));
      const nextInputRefs = [
        ...parseArray(stored.inputRefs).filter((ref) => (
          ref?.type !== UNIT_RECONCILIATION_REF
          && ref?.type !== UNIT_RECONCILED_REF
        )),
        {
          type: UNIT_RECONCILED_REF,
          protocol: UNIT_RECONCILIATION_PROTOCOL,
          gatewayStepId: reconciliation.gatewayStepId,
          gatewayIdempotencyKey: reconciliation.gatewayIdempotencyKey,
          toolName: reconciliation.toolName,
          argumentsDigest: reconciliation.argumentsDigest,
          authorizationDigest: reconciliation.authorizationDigest,
          gatewayOutputDigest: reconciliation.gatewayOutputDigest,
          replacedProgressDigest: reconciliation.observedProgressDigest,
          authoritativeProgressDigest: reconciliation.authoritativeProgressDigest,
        },
      ];
      const terminalStatus = authoritativeProgress.status === "failed"
        ? "failed"
        : "succeeded";
      const updated = await trx("o_agent_step")
        .where({
          id: stored.id,
          runId: prepared.run.id,
          inputRefs: previousInputRefs,
          outputRefs: previousOutputRefs,
        })
        .update({
          status: terminalStatus,
          inputRefs: JSON.stringify(nextInputRefs),
          outputRefs: JSON.stringify([authoritativeProgress]),
          errorCategory: terminalStatus === "failed" ? "executor_unit_failed" : null,
          safeError: null,
          completedAt: stored.completedAt ?? now,
          updatedAt: now,
        });
      if (affectedRows(updated) !== 1) return null;
      return {
        ...stored,
        status: terminalStatus,
        inputRefs: nextInputRefs,
        outputRefs: [authoritativeProgress],
        errorCategory: terminalStatus === "failed" ? "executor_unit_failed" : null,
        safeError: null,
        completedAt: stored.completedAt ?? now,
        updatedAt: now,
      };
    });
  }

  private readRelayTaskId(output: unknown): string | null {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const task = (output as Record<string, unknown>).task;
    if (!task || typeof task !== "object" || Array.isArray(task)) return null;
    const taskId = (task as Record<string, unknown>).taskId;
    return typeof taskId === "string" && taskId ? taskId : null;
  }

  private readAssetVersionId(output: unknown): number | null {
    if (!output || typeof output !== "object" || Array.isArray(output)) return null;
    const value = (output as Record<string, unknown>).assetVersionId;
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
  }

  // ── 单元 Step 管理 ─────────────────────────────────────────────────────

  private async findUnitStep(
    runId: string,
    unit: "transition" | "merge",
    index: number,
  ): Promise<RawStep | null> {
    return await this.database<RawStep>("o_agent_step")
      .where({ runId, kind: "tool", idempotencyKey: unitStepIdempotencyKey(runId, unit, index) })
      .first() ?? null;
  }

  private async createUnitStep(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
    unit: {
      unit: "transition" | "merge";
      index: number;
      toolName: "generation.video.submit" | "video.merge";
      arguments: Record<string, unknown>;
    },
  ): Promise<RawStep | null> {
    return this.database.transaction(async (trx): Promise<RawStep | null> => {
      const run = await trx<RawRun>("o_agent_run").where({ id: prepared.run.id }).forUpdate().first();
      const now = this.clock();
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return null;
      const existing = await trx<RawStep>("o_agent_step")
        .where({ runId: run.id, kind: "tool", idempotencyKey: unitStepIdempotencyKey(run.id, unit.unit, unit.index) })
        .first();
      if (existing) return existing;
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Executor Run ${run.id} 创建单元 Step 时 Thread 不存在`);
      const maxStep = await trx("o_agent_step").where({ runId: run.id }).max({ seq: "seq" }).first();
      const seq = Math.max(Number(run.checkpointStepSeq || 0), Number(maxStep?.seq || 0)) + 1;
      const step: RawStep = {
        id: this.stepIdFactory(),
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        parentStepId: null,
        seq,
        agentRole: "executor",
        kind: "tool",
        status: "running",
        toolName: unit.toolName,
        argumentsDigest: hashIdempotencyRequest(unit.arguments),
        inputRefs: [{ type: "executor_unit", value: `${unit.unit}:${unit.index}` }],
        outputRefs: [],
        idempotencyKey: unitStepIdempotencyKey(run.id, unit.unit, unit.index),
        resolvedModel: null,
        provider: null,
        usage: {},
        costMicros: 0,
        errorCategory: null,
        safeError: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: null,
      };
      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({ sideEffectsCommitted: 1, checkpointStepSeq: seq, version: runVersion + 1, updatedAt: now });
      if (affectedRows(runUpdated) !== 1) return null;
      const threadVersion = Number(thread.version || 0);
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Executor Run ${run.id} 单元 Step Thread 版本冲突`);
      await trx("o_agent_step").insert({
        ...step,
        inputRefs: JSON.stringify(step.inputRefs),
        outputRefs: JSON.stringify([]),
        usage: JSON.stringify({}),
      });
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: step.id,
        seq: eventSeq,
        type: "internal.step.started",
        payload: { step: toAgentStepDto(asAgentStep(step)), visibility: "internal" },
        createdAt: now,
      });
      return step;
    });
  }

  private async markUnitTerminal(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
    step: RawStep,
    progress: ExecutorUnitProgress,
    gatewayProof?: ExecutorGatewayCheckpointProof,
  ): Promise<UnitTerminalCommitResult> {
    return this.database.transaction(async (trx): Promise<UnitTerminalCommitResult> => {
      const now = this.clock();
      // A write-CAS is required even on SQLite, where SELECT FOR UPDATE is a
      // no-op. This both serializes same-Run checkpoint writers and proves the
      // exact Worker/attempt lease immediately before any Step mutation.
      const claimed = await trx("o_agent_run")
        .where({
          id: prepared.run.id,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({ updatedAt: trx.ref("updatedAt") });
      if (affectedRows(claimed) !== 1) return "lease_lost";
      const run = await trx<RawRun>("o_agent_run")
        .where({ id: prepared.run.id })
        .forUpdate()
        .first();
      const stored = await trx<RawStep>("o_agent_step")
        .where({ id: step.id, runId: prepared.run.id })
        .forUpdate()
        .first();
      if (!run || !stored) return "conflict";
      const terminalStatus = progress.status === "succeeded" || progress.status === "submitted"
        ? "succeeded"
        : "failed";
      const persistReconciliation = async (
        observed: ExecutorUnitProgress,
      ): Promise<UnitTerminalCommitResult> => {
        if (!gatewayProof) return "conflict";
        const marker: ExecutorUnitCheckpointReconciliation = {
          type: UNIT_RECONCILIATION_REF,
          protocol: UNIT_RECONCILIATION_PROTOCOL,
          unit: progress.unit,
          index: progress.index,
          gatewayStepId: gatewayProof.gatewayStepId,
          gatewayIdempotencyKey: gatewayProof.gatewayIdempotencyKey,
          toolName: gatewayProof.toolName,
          argumentsDigest: gatewayProof.argumentsDigest,
          authorizationDigest: gatewayProof.authorizationDigest,
          gatewayOutputDigest: gatewayProof.gatewayOutputDigest,
          authoritativeProgressDigest: hashIdempotencyRequest(progress),
          observedProgressDigest: hashIdempotencyRequest(observed),
        };
        const existingMarker = readUnitReconciliation(stored);
        if (existingMarker.kind === "valid") {
          return hashIdempotencyRequest(existingMarker.value)
            === hashIdempotencyRequest(marker)
            ? "reconciliation_required"
            : "conflict";
        }
        if (existingMarker.kind === "invalid") return "conflict";
        const previousInputRefs = typeof stored.inputRefs === "string"
          ? stored.inputRefs
          : JSON.stringify(parseArray(stored.inputRefs));
        const previousOutputRefs = typeof stored.outputRefs === "string"
          ? stored.outputRefs
          : JSON.stringify(parseArray(stored.outputRefs));
        const updated = await trx("o_agent_step")
          .where({
            id: stored.id,
            runId: run.id,
            status: stored.status,
            inputRefs: previousInputRefs,
            outputRefs: previousOutputRefs,
          })
          .update({
            inputRefs: JSON.stringify([
              ...parseArray(stored.inputRefs),
              marker,
            ]),
            updatedAt: now,
          });
        return affectedRows(updated) === 1
          ? "reconciliation_required"
          : "conflict";
      };
      if (stored.status === "succeeded") {
        const existing = unitProgress(stored);
        if (!existing) return "conflict";
        if (sameUnitProgress(existing, progress)) return "already_committed";
        // Only the externally-proven relay fold may move a submitted unit to
        // succeeded. No other succeeded payload may overwrite the checkpoint.
        if (!isSubmittedToTerminalFold(existing, progress)) {
          return persistReconciliation(existing);
        }
        const updated = await trx("o_agent_step")
          .where({ id: stored.id, runId: run.id, status: "succeeded", kind: "tool" })
          .update({
            outputRefs: JSON.stringify([progress]),
            updatedAt: now,
          });
        return affectedRows(updated) === 1 ? "committed" : "conflict";
      }
      if (stored.status !== "running") {
        const existing = unitProgress(stored);
        return existing ? persistReconciliation(existing) : "conflict";
      }
      const updated = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "running", kind: "tool" })
        .update({
          status: terminalStatus,
          outputRefs: JSON.stringify([progress]),
          errorCategory: terminalStatus === "failed" ? "executor_unit_failed" : null,
          updatedAt: now,
          completedAt: now,
        });
      if (affectedRows(updated) !== 1) return "conflict";
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Executor Run ${run.id} 单元终态时 Thread 不存在`);
      const threadVersion = Number(thread.version || 0);
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Executor Run ${run.id} 单元终态 Thread 版本冲突`);
      const terminal = asAgentStep({
        ...stored,
        status: terminalStatus,
        outputRefs: [progress],
        errorCategory: terminalStatus === "failed" ? "executor_unit_failed" : null,
        updatedAt: now,
        completedAt: now,
      });
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: stored.id,
        seq: eventSeq,
        type: terminalStatus === "succeeded" ? "internal.step.completed" : "internal.step.failed",
        payload: { step: toAgentStepDto(terminal), visibility: "internal" },
        createdAt: now,
      });
      return "committed";
    });
  }

  // ── 审批暂停 / 恢复 ────────────────────────────────────────────────────

  private async pauseForUnitApproval(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
    step: RawStep,
    unit: {
      unit: "transition" | "merge";
      index: number;
      toolName: "generation.video.submit" | "video.merge";
      arguments: Record<string, unknown>;
    },
  ): Promise<AgentRunProcessResult> {
    return this.database.transaction(async (trx): Promise<AgentRunProcessResult> => {
      const run = await trx<RawRun>("o_agent_run").where({ id: prepared.run.id }).forUpdate().first();
      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: prepared.run.id }).first();
      const now = this.clock();
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      if (stored.status !== "running" || unitApprovalId(stored) != null) {
        throw new ExecutorProcessorSafeError("executor_unit_checkpoint_invalid", "单元检查点状态无效");
      }

      const preparedAction = await this.gateway.prepareExecutorApprovalInTransaction(trx, {
        runId: run.id,
        stepId: stored.id,
        toolName: unit.toolName,
        arguments: unit.arguments,
      });
      let expiresAt = now + DEFAULT_APPROVAL_TTL_MS;
      const quote = preparedAction.quote as { expiresAt?: unknown } | null;
      if (quote && typeof quote.expiresAt === "number") {
        expiresAt = Math.min(expiresAt, quote.expiresAt);
      }
      if (expiresAt <= now) {
        throw new ExecutorProcessorSafeError("executor_approval_evidence_expired", "服务端审批证据已过期");
      }
      const approval = await this.approvalService.requestInTransaction(trx, {
        workspaceId: preparedAction.workspaceId,
        projectId: preparedAction.projectId,
        runId: preparedAction.runId,
        stepId: preparedAction.stepId,
        requestedBy: preparedAction.requestedBy,
        toolId: preparedAction.toolId as ToolId,
        toolVersion: preparedAction.toolVersion,
        riskClass: preparedAction.riskClass,
        arguments: preparedAction.arguments,
        resourceVersions: preparedAction.resourceVersions,
        quote: preparedAction.quote,
        impactSummary: preparedAction.impactSummary,
        policyVersion: preparedAction.policyVersion,
        expiresAt,
      });

      const checkpointed = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "running", kind: "tool" })
        .update({
          inputRefs: JSON.stringify(withApprovalId(stored.inputRefs, approval.id)),
          updatedAt: now,
        });
      if (affectedRows(checkpointed) !== 1) {
        throw new ExecutorProcessorSafeError("executor_unit_checkpoint_invalid", "单元审批检查点写入冲突");
      }

      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          workspaceId: run.workspaceId,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: "waiting_approval",
          waitType: "approval",
          waitRef: approval.id,
          wakeAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          version: runVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(runUpdated) !== 1) {
        throw new ExecutorProcessorSafeError("executor_approval_pause_lease_lost", "进入审批等待前执行租约已变化");
      }

      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Executor Run ${run.id} 进入审批等待时 Thread 不存在`);
      const threadVersion = Number(thread.version || 0);
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Executor Run ${run.id} 审批等待 Thread 版本冲突`);
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: stored.id,
        seq: eventSeq,
        type: "internal.run.waiting_approval",
        payload: { runId: run.id, approvalId: approval.id, agentRole: "executor", visibility: "internal" },
        createdAt: now,
      });
      await this.hooks.afterApprovalRequested?.({
        runId: run.id,
        unit: unit.unit,
        index: unit.index,
        approvalId: approval.id,
      });
      return {
        status: "waiting_approval",
        runId: run.id,
        responseMessageId: prepared.responseMessageId,
      };
    });
  }

  private async reenterApprovalWait(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
    approvalId: string,
  ): Promise<AgentRunProcessResult> {
    return this.database.transaction(async (trx): Promise<AgentRunProcessResult> => {
      const run = await trx<RawRun>("o_agent_run").where({ id: prepared.run.id }).forUpdate().first();
      const now = this.clock();
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: "waiting_approval",
          waitType: "approval",
          waitRef: approvalId,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          version: runVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(runUpdated) !== 1) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      return {
        status: "waiting_approval",
        runId: run.id,
        responseMessageId: prepared.responseMessageId,
      };
    });
  }

  // ── 外部任务等待与终态折叠 ──────────────────────────────────────────────

  private async pauseForExternal(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult> {
    const paused = await this.database.transaction(async (trx): Promise<AgentRunProcessResult> => {
      const run = await trx<RawRun>("o_agent_run").where({ id: prepared.run.id }).forUpdate().first();
      const now = this.clock();
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: "waiting_external",
          waitType: "external",
          waitRef: `executor-transitions:${prepared.run.id}`,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          version: runVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(runUpdated) !== 1) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }
      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Executor Run ${run.id} 进入外部等待时 Thread 不存在`);
      const threadVersion = Number(thread.version || 0);
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Executor Run ${run.id} 外部等待 Thread 版本冲突`);
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        seq: eventSeq,
        type: "internal.run.waiting_external",
        payload: { runId: run.id, agentRole: "executor", visibility: "internal" },
        createdAt: now,
      });
      return {
        status: "waiting_external",
        runId: run.id,
        responseMessageId: prepared.responseMessageId,
      };
    });
    if (paused.status !== "waiting_external") return paused;

    // Close the notifier-before-pause race: a relay callback may observe the
    // Run as `running`, persist its terminal notice, and therefore be unable to
    // requeue it just before the transaction above parks it. Re-read durable
    // relay facts after the wait commit and CAS the exact executor wait back to
    // queued when such a terminal fact already exists.
    const terminalRunIds = await this.findRunsWithTerminalTransitionTasks([prepared.run.id]);
    if (!terminalRunIds.has(prepared.run.id)) return paused;
    const queued = await this.requeueExecutorTransitionWait(prepared.run.id, this.clock());
    return queued
      ? { status: "queued", runId: prepared.run.id, responseMessageId: prepared.responseMessageId }
      : paused;
  }

  private async findRunsWithTerminalTransitionTasks(runIds: readonly string[]): Promise<Set<string>> {
    const uniqueRunIds = [...new Set(runIds.map((id) => String(id).trim()).filter(Boolean))];
    if (uniqueRunIds.length === 0) return new Set();
    const steps = await this.database<Pick<RawStep, "runId" | "outputRefs">>("o_agent_step")
      .whereIn("runId", uniqueRunIds)
      .andWhere({ kind: "tool", toolName: "generation.video.submit" })
      .select("runId", "outputRefs");
    const taskToRuns = new Map<string, Set<string>>();
    for (const step of steps) {
      const progress = unitProgress({ outputRefs: step.outputRefs, status: "succeeded" });
      // A succeeded progress was already folded. Only submitted checkpoints
      // need a missing terminal wake-up.
      if (!progress || progress.status !== "submitted" || !progress.relayTaskId) continue;
      const relayTaskId = String(progress.relayTaskId);
      const owners = taskToRuns.get(relayTaskId) ?? new Set<string>();
      owners.add(String(step.runId));
      taskToRuns.set(relayTaskId, owners);
    }
    const relayTaskIds = [...taskToRuns.keys()];
    if (relayTaskIds.length === 0) return new Set();
    const terminalTasks = await this.database("o_relay_task")
      .whereIn("id", relayTaskIds)
      .whereIn("status", [...TERMINAL_RELAY_TASK_STATUSES])
      .select<{ id: unknown }[]>("id");
    const terminalRunIds = new Set<string>();
    for (const task of terminalTasks) {
      for (const runId of taskToRuns.get(String(task.id)) ?? []) terminalRunIds.add(runId);
    }
    return terminalRunIds;
  }

  private async requeueExecutorTransitionWait(runId: string, now: number): Promise<boolean> {
    const expectedWaitRef = `executor-transitions:${runId}`;
    return this.database.transaction(async (trx): Promise<boolean> => {
      const run = await trx<RawRun>("o_agent_run").where({ id: runId }).forUpdate().first();
      if (!run) return false;
      // A concurrent notifier may already have won the same transition.
      if (run.status === "queued") return true;
      if (run.status !== "waiting_external"
        || run.waitType !== "external"
        || run.waitRef !== expectedWaitRef) return false;
      const runVersion = Number(run.version || 0);
      const updated = await trx("o_agent_run")
        .where({
          id: run.id,
          status: "waiting_external",
          waitType: "external",
          waitRef: expectedWaitRef,
          agentRole: "executor",
          version: runVersion,
        })
        .update({
          status: "queued",
          waitType: null,
          waitRef: null,
          wakeAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          version: runVersion + 1,
          updatedAt: now,
        });
      return affectedRows(updated) === 1;
    });
  }

  /**
   * 解析各过渡段的 relay 终态。只读 o_relay_task 与 o_media_asset：
   * relay 任务由 provider worker 异步推进，executor 只消费终态事实。
   */
  private async resolveTransitionOutcomes(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
    transitions: readonly StoryVideoTransitionTask[],
  ): Promise<
    | { kind: "pending" }
    | { kind: "failed"; failedIndexes: number[] }
    | { kind: "succeeded"; assetVersionIds: number[] }
  > {
    const outcomes: Array<{ index: number; status: "succeeded" | "failed" | "pending" }> = [];
    const assetVersionIds: number[] = [];
    for (const transition of transitions) {
      const step = await this.findUnitStep(prepared.run.id, "transition", transition.index);
      const progress = step ? unitProgress(step) : null;
      if (!progress || (progress.status !== "submitted" && progress.status !== "succeeded")) {
        outcomes.push({ index: transition.index, status: "failed" });
        continue;
      }
      if (progress.status === "succeeded" && progress.assetVersionId != null) {
        outcomes.push({ index: transition.index, status: "succeeded" });
        assetVersionIds.push(progress.assetVersionId);
        continue;
      }
      const relayTaskId = progress.relayTaskId ?? null;
      if (!relayTaskId) {
        outcomes.push({ index: transition.index, status: "pending" });
        continue;
      }
      const taskRow = await this.database("o_relay_task")
        .where({ id: relayTaskId })
        .select("status")
        .first<{ status?: unknown }>();
      const status = String(taskRow?.status || "");
      if (status === "succeeded" || status === "mocked") {
        const assetVersionId = progress.assetVersionId
          ?? await this.resolveRelayAssetVersionId(prepared, relayTaskId);
        if (assetVersionId == null) {
          outcomes.push({ index: transition.index, status: "pending" });
          continue;
        }
        const updated = step
          ? await this.markUnitTerminal(prepared, input, workerId, step, {
            type: "executor_unit_result",
            unit: "transition",
            index: transition.index,
            status: "succeeded",
            relayTaskId,
            assetVersionId,
          })
          : "conflict";
        if (step && updated !== "committed" && updated !== "already_committed") {
          outcomes.push({ index: transition.index, status: "pending" });
          continue;
        }
        outcomes.push({ index: transition.index, status: "succeeded" });
        assetVersionIds.push(assetVersionId);
        continue;
      }
      if (status === "failed" || status === "cancelled") {
        if (step) {
          const updated = await this.markUnitTerminal(prepared, input, workerId, step, {
            type: "executor_unit_result",
            unit: "transition",
            index: transition.index,
            status: "failed",
            relayTaskId,
            errorMessage: `relay 任务终态：${status}`,
          });
          if (updated !== "committed" && updated !== "already_committed") {
            outcomes.push({ index: transition.index, status: "pending" });
            continue;
          }
        }
        outcomes.push({ index: transition.index, status: "failed" });
        continue;
      }
      outcomes.push({ index: transition.index, status: "pending" });
    }

    const folded = foldStoryVideoTransitionOutcomes(outcomes);
    if (folded.status === "pending") return { kind: "pending" };
    if (folded.status === "failed") {
      return { kind: "failed", failedIndexes: folded.failedIndexes };
    }
    return { kind: "succeeded", assetVersionIds };
  }

  private async resolveRelayAssetVersionId(
    prepared: PreparedExecutorLoop,
    relayTaskId: string,
  ): Promise<number | null> {
    const assetRow = await this.database("o_media_asset")
      .where({ taskId: relayTaskId, source: "relay_final" })
      .select("assetVersionId")
      .first<{ assetVersionId?: unknown }>();
    const value = Number(assetRow?.assetVersionId);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  // ── 终态提交（复用 Delegated 终态提交合同） ─────────────────────────────

  private async commitTerminal(
    prepared: PreparedExecutorLoop,
    input: AgentRunProcessInput,
    workerId: string,
    terminal: {
      status: "succeeded" | "failed" | "cancelled";
      safeError: { code: string; message: string } | null;
      summary: string;
      issues: string[];
    },
  ): Promise<AgentRunProcessResult> {
    const usage = {
      modelProfile: "executor@v3",
      inputTokens: 0,
      outputTokens: 0,
      costMicros: null,
    };
    let result: AgentTaskResult;
    if (terminal.status === "succeeded") {
      result = prepared.contract.normalizeResult({
        version: prepared.contract.resultVersion,
        status: "succeeded",
        artifactRefs: [{ type: "message", id: prepared.responseMessageId, version: null }],
        summary: terminal.summary,
        assumptions: [],
        issues: [],
        suggestedNextActions: ["在项目资产库查看各段过渡视频与成片；需要重试失败段时显式发起 generation.task.retry"],
        usage,
      }, { expectedRole: "executor" });
    } else if (terminal.status === "cancelled") {
      result = prepared.contract.normalizeResult({
        version: prepared.contract.resultVersion,
        status: "cancelled",
        artifactRefs: [],
        summary: terminal.summary,
        assumptions: [],
        issues: [],
        suggestedNextActions: [],
        usage,
      }, { expectedRole: "executor" });
    } else {
      const error = terminal.safeError ?? GENERIC_FAILURE;
      result = prepared.contract.normalizeResult({
        version: prepared.contract.resultVersion,
        status: "failed",
        artifactRefs: [],
        summary: terminal.summary,
        assumptions: [],
        issues: terminal.issues.length > 0 ? terminal.issues : [error.message],
        suggestedNextActions: [`${TRANSITION_RETRY_POLICY}：需要时显式发起重试，不自动扣费重跑`],
        usage,
      }, { expectedRole: "executor" });
    }
    const resultHash = hashIdempotencyRequest(result);
    const messageContent = result.status === "succeeded"
      ? [{ type: "text", text: terminal.summary }]
      : [];
    const committed = await this.terminalCommitter.commit({
      claimedRun: input.claimedRun,
      workerId,
      run: {
        id: prepared.run.id,
        workspaceId: prepared.run.workspaceId,
        projectId: Number(prepared.run.projectId),
        threadId: prepared.run.threadId,
        rootRunId: prepared.run.rootRunId,
        parentRunId: prepared.run.parentRunId ?? "",
        delegationId: prepared.run.delegationId ?? "",
        agentRole: "executor",
      },
      responseMessageId: prepared.responseMessageId,
      task: prepared.task,
      taskHash: prepared.taskHash,
      result,
      resultHash,
      resultStepId: this.stepIdFactory(),
      messageContent,
      reviewReport: null,
      safeError: terminal.status === "failed" || terminal.status === "cancelled"
        ? terminal.safeError ?? (terminal.status === "cancelled" ? CANCELLED_ERROR : GENERIC_FAILURE)
        : null,
      knownModelResultStepId: null,
    } satisfies DelegatedAgentTerminalCommitInput);
    if (committed.status !== "lease_lost") {
      await this.hooks.afterTerminalResultCommitted?.({
        runId: prepared.run.id,
        taskStatus: result.status,
        resultMessageId: prepared.responseMessageId,
      });
    }
    return committed;
  }

  /**
   * waiting_external 兜底恢复(P1 修复)：executor Run 进入外部等待后，唯一
   * 设计唤醒路径是 relay 任务终态通知的 CAS requeue。取消终态遗漏通知、
   * 通知与 pauseForExternal 之间的竞态、通知自身失败都会让 Run 永久停在
   * waiting_external。本清扫只唤醒已存在未折叠 relay 终态事实的精确
   * executor-transitions wait；正常长耗时 pending 任务不会被周期性唤醒。
   */
  async sweepStaleWaitingExternal(input: {
    limit: number;
    staleAfterMs: number;
    now?: number;
  }): Promise<{ requeued: number }> {
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit || 20)));
    const staleAfterMs = Math.max(1, Math.floor(input.staleAfterMs));
    const now = input.now ?? this.clock();
    const cutoff = now - staleAfterMs;
    const rows = await this.database<RawRun>("o_agent_run")
      .where({
        status: "waiting_external",
        waitType: "external",
        agentRole: "executor",
      })
      .andWhere("updatedAt", "<", cutoff)
      // Filter the exact protocol in SQL before applying LIMIT. Otherwise
      // older waits owned by another protocol can permanently starve valid
      // executor transition rows behind the maintenance batch boundary.
      .andWhereRaw('?? = (? || ??)', ["waitRef", "executor-transitions:", "id"])
      .orderBy("updatedAt", "asc")
      .limit(limit)
      .select("id", "waitRef", "version");
    const terminalRunIds = await this.findRunsWithTerminalTransitionTasks(
      rows.map((row) => String(row.id)),
    );
    let requeued = 0;
    for (const row of rows) {
      if (!terminalRunIds.has(String(row.id))) continue;
      const runVersion = Number(row.version || 0);
      const expectedWaitRef = `executor-transitions:${row.id}`;
      const updated = await this.database("o_agent_run")
        .where({
          id: row.id,
          status: "waiting_external",
          waitType: "external",
          waitRef: expectedWaitRef,
          agentRole: "executor",
          version: runVersion,
        })
        .update({
          status: "queued",
          waitType: null,
          waitRef: null,
          wakeAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          version: runVersion + 1,
          updatedAt: now,
        });
      if (affectedRows(updated) === 1) requeued += 1;
    }
    return { requeued };
  }
}
