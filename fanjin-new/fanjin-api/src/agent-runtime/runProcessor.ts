import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { appendAgentEvent } from "@/agent-runtime/eventStore";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { agentMessageContextUsageFromSnapshot } from "@/agent-runtime/messageContextSnapshot";
import { AgentMessageStreamSnapshotWriter } from "@/agent-runtime/messageStreamSnapshot";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import { publishAgentMessageDelta } from "@/agent-runtime/streamBus";
import type { AgentContentPart, AgentStep } from "@/agent-runtime/types";
import type { AgentRuntimeClaimedRun } from "@/agent-runtime/worker";

export interface AgentRunExecutionContext {
  id: string;
  workspaceId: string;
  projectId: number;
  threadId: string;
  rootRunId: string;
  agentRole: string;
  attempt: number;
  policySnapshot: Record<string, unknown>;
}

export interface AgentRunTriggerMessage {
  id: string;
  threadId: string;
  content: AgentContentPart[];
  referenceRefs: string[];
}

export interface AgentRunExecutorInput {
  run: AgentRunExecutionContext;
  triggerMessage: AgentRunTriggerMessage;
  responseMessageId: string;
  stepId: string;
  workerId: string;
  /**
   * Must be awaited immediately before the first external model dispatch.
   * The Processor owns the lease CAS and durable side-effect checkpoint.
   */
  checkpointExternalDispatch(): Promise<void>;
  /** Ordered text deltas emitted only when the executor negotiated a stream. */
  onAssistantDelta?(delta: string): void;
}

export interface AgentRunExecutorOutput {
  content: AgentContentPart[];
}

/** A1 executor contract only. Implementations are injected; this module imports no model or tool runtime. */
export interface AgentRunExecutor {
  execute(input: AgentRunExecutorInput): Promise<AgentRunExecutorOutput>;
}

export class SafeAgentRunExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SafeAgentRunExecutorError";
    this.code = code;
  }
}

export type AgentRunProcessResult =
  | {
    status:
      | "succeeded"
      | "needs_input"
      | "failed"
      | "cancelled"
      | "waiting_approval"
      | "waiting_delegation"
      | "waiting_external"
      /**
       * 预算自主审批:审批在额度内被同事务自动批准,Run 已直接转 queued 等待
       * 重新认领恢复(不进入 waiting_approval);Worker 将其视为非终态。
       */
      | "queued";
    runId: string;
    responseMessageId: string;
  }
  | { status: "lease_lost"; runId: string; responseMessageId: string | null };

export interface AgentRunProcessorOptions {
  database: Knex;
  executor: AgentRunExecutor;
  clock?: () => number;
  idFactory?: () => string;
  stepIdFactory?: () => string;
}

export interface AgentRunProcessInput {
  claimedRun: AgentRuntimeClaimedRun;
  workerId: string;
  /** WorkerService uses this to stop and drain heartbeats before terminal CAS writes. */
  beforeFinalize?: () => Promise<void>;
}

interface RawRun {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  rootRunId: string;
  agentRole: string;
  triggerMessageId: string;
  responseMessageId: string | null;
  status: string;
  policySnapshot: string | Record<string, unknown> | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | string | null;
  attempt: number | string | null;
  version: number | string | null;
  checkpointStepSeq: number | string | null;
  sideEffectsCommitted: number | string | boolean | null;
}

interface RawThread {
  id: string;
  activeRootRunId: string | null;
  messageSeq: number | string | null;
  eventSeq: number | string | null;
  version: number | string | null;
}

interface RawMessage {
  id: string;
  threadId: string;
  runId: string | null;
  status: string;
  content: string | AgentContentPart[] | null;
  referenceRefs: string | string[] | null;
  metadata: string | Record<string, unknown> | null;
}

interface PreparedExecution {
  kind: "ready";
  cancelRequested: boolean;
  run: AgentRunExecutionContext;
  triggerMessage: AgentRunTriggerMessage;
  responseMessageId: string;
  stepId: string;
}

interface LostExecution {
  kind: "lease_lost";
  responseMessageId: string | null;
}

const GENERIC_EXECUTOR_ERROR = {
  code: "executor_failed",
  message: "Agent 运行失败",
} as const;

const CANCELLED_MESSAGE_ERROR = {
  code: "run_cancelled",
  message: "Agent 运行已取消",
} as const;

const MODEL_STEP_LEASE_LOST_ERROR = {
  code: "model_outcome_uncertain",
  message: "模型请求发出后执行租约丢失，结果需要人工核对",
} as const;

const MODEL_STEP_IDEMPOTENCY_PREFIX = "agent-model";

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
  provider: string | null;
  usage: unknown;
  costMicros: number | string | null;
  errorCategory: string | null;
  safeError: unknown;
  createdAt: number | string;
  updatedAt: number | string;
  startedAt: number | string | null;
  completedAt: number | string | null;
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function modelStepIdempotencyKey(runId: string): string {
  return `${MODEL_STEP_IDEMPOTENCY_PREFIX}:${runId}`;
}

function stableModelInputRefs(runId: string): Array<Record<string, unknown>> {
  const relayKey = `agent-run:${runId}`;
  return [
    { type: "model_dispatch_state", value: "prepared" },
    { type: "model_request_id_digest", value: hashIdempotencyRequest({ requestId: relayKey }) },
    { type: "model_idempotency_key_digest", value: hashIdempotencyRequest({ idempotencyKey: relayKey }) },
  ];
}

function withDispatchedState(value: unknown): Array<Record<string, unknown>> {
  const refs = parseArray<Record<string, unknown>>(value);
  let found = false;
  const next = refs.map((ref) => {
    if (ref?.type !== "model_dispatch_state") return ref;
    found = true;
    return { type: "model_dispatch_state", value: "dispatched" };
  });
  if (!found) next.unshift({ type: "model_dispatch_state", value: "dispatched" });
  return next;
}

function modelDispatchState(value: unknown): "prepared" | "dispatched" | null {
  const state = parseArray<Record<string, unknown>>(value)
    .find((ref) => ref?.type === "model_dispatch_state")?.value;
  return state === "prepared" || state === "dispatched" ? state : null;
}

function pinnedModelAlias(policySnapshot: Record<string, unknown>): string | null {
  const alias = typeof policySnapshot.modelAlias === "string" ? policySnapshot.modelAlias.trim() : "";
  if (!alias || alias.length > 200 || /[\u0000-\u001f\u007f]/.test(alias)) return null;
  return alias;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function asAgentStep(row: RawStep): AgentStep {
  return mapAgentStep(row);
}

function safeExecutorError(error: unknown): { code: string; message: string } {
  if (error instanceof SafeAgentRunExecutorError) {
    return {
      code: error.code.trim() || GENERIC_EXECUTOR_ERROR.code,
      message: error.message.trim() || GENERIC_EXECUTOR_ERROR.message,
    };
  }
  return { ...GENERIC_EXECUTOR_ERROR };
}

function hasLiveLease(run: RawRun, workerId: string, now: number): boolean {
  return run.leaseOwner === workerId && Number(run.leaseExpiresAt || 0) > now;
}

export class AgentRunProcessor {
  private readonly database: Knex;
  private readonly executor: AgentRunExecutor;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly stepIdFactory: () => string;

  constructor(options: AgentRunProcessorOptions) {
    this.database = options.database;
    this.executor = options.executor;
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.stepIdFactory = options.stepIdFactory ?? randomUUID;
  }

  async process(input: AgentRunProcessInput): Promise<AgentRunProcessResult> {
    const workerId = input.workerId.trim();
    if (!workerId || input.claimedRun.leaseOwner !== workerId) {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: null };
    }

    const prepared = await this.prepare(input.claimedRun, workerId, this.clock());
    if (prepared.kind === "lease_lost") {
      return {
        status: "lease_lost",
        runId: input.claimedRun.id,
        responseMessageId: prepared.responseMessageId,
      };
    }

    let execution:
      | { kind: "succeeded"; output: AgentRunExecutorOutput }
      | { kind: "failed"; error: { code: string; message: string } };
    let dispatchCheckpointUsed = false;
    if (prepared.cancelRequested) {
      execution = { kind: "succeeded", output: { content: [] } };
    } else {
      const snapshotWriter = new AgentMessageStreamSnapshotWriter({
        database: this.database,
        workspaceId: prepared.run.workspaceId,
        threadId: prepared.run.threadId,
        runId: prepared.run.id,
        messageId: prepared.responseMessageId,
        clock: this.clock,
      });
      try {
        const output = await this.executor.execute({
          run: prepared.run,
          triggerMessage: prepared.triggerMessage,
          responseMessageId: prepared.responseMessageId,
          stepId: prepared.stepId,
          workerId,
          onAssistantDelta: (delta) => {
            snapshotWriter.append(delta);
            publishAgentMessageDelta({
              threadId: prepared.run.threadId,
              runId: prepared.run.id,
              messageId: prepared.responseMessageId,
              turn: 1,
              delta,
              createdAt: this.clock(),
            });
          },
          checkpointExternalDispatch: async () => {
            if (dispatchCheckpointUsed) {
              throw new SafeAgentRunExecutorError(
                "model_dispatch_checkpoint_reused",
                "同一次执行只能发起一次模型请求",
              );
            }
            dispatchCheckpointUsed = true;
            await this.checkpointExternalDispatch({
              runId: prepared.run.id,
              workspaceId: prepared.run.workspaceId,
              attempt: prepared.run.attempt,
              workerId,
              stepId: prepared.stepId,
              now: this.clock(),
            });
          },
        });
        if (!output || !Array.isArray(output.content)) throw new Error("Executor 返回格式无效");
        execution = { kind: "succeeded", output };
      } catch (error) {
        execution = { kind: "failed", error: safeExecutorError(error) };
      } finally {
        await snapshotWriter.close();
      }
    }

    // Heartbeats intentionally run only while the executor is active. Draining
    // them before finalization prevents a heartbeat version bump racing the
    // terminal Run compare-and-swap.
    await input.beforeFinalize?.();

    return this.finalize({
      runId: prepared.run.id,
      workspaceId: prepared.run.workspaceId,
      attempt: prepared.run.attempt,
      workerId,
      responseMessageId: prepared.responseMessageId,
      stepId: prepared.stepId,
      execution,
      now: this.clock(),
    });
  }

  private async prepare(
    claimedRun: AgentRuntimeClaimedRun,
    workerId: string,
    now: number,
  ): Promise<PreparedExecution | LostExecution> {
    return this.database.transaction(async (trx) => {
      const run = (await (trx as any)("o_agent_run").where({ id: claimedRun.id }).first()) as RawRun | undefined;
      if (
        !run ||
        !["running", "cancelling"].includes(run.status) ||
        Number(run.attempt || 0) !== claimedRun.attempt ||
        !hasLiveLease(run, workerId, now)
      ) {
        return { kind: "lease_lost", responseMessageId: run?.responseMessageId ?? null };
      }

      const trigger = (await (trx as any)("o_agent_message")
        .where({
          id: run.triggerMessageId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
        })
        .first()) as RawMessage | undefined;
      if (!trigger) throw new Error(`Run ${run.id} 的触发消息不存在`);

      const thread = (await (trx as any)("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .select("id", "activeRootRunId", "messageSeq", "eventSeq", "version")
        .first()) as RawThread | undefined;
      if (!thread) throw new Error(`Run ${run.id} 对应的 Thread 不存在`);

      let responseMessageId = run.responseMessageId;
      let createsResponse = false;
      if (responseMessageId) {
        const response = (await (trx as any)("o_agent_message")
          .where({
            id: responseMessageId,
            workspaceId: run.workspaceId,
            threadId: run.threadId,
            runId: run.id,
            role: "assistant",
          })
          .first()) as RawMessage | undefined;
        if (!response || response.status !== "pending") {
          throw new Error(`Run ${run.id} 的响应消息状态无效`);
        }
      } else {
        responseMessageId = this.idFactory();
        createsResponse = true;
      }

      const policySnapshot = parseObject(run.policySnapshot);
      const stepKey = modelStepIdempotencyKey(run.id);
      let rawStep = (await (trx as any)("o_agent_step")
        .where({ runId: run.id, idempotencyKey: stepKey })
        .first()) as RawStep | undefined;
      const createsStep = !rawStep;
      if (rawStep) {
        const validScope = rawStep.workspaceId === run.workspaceId
          && Number(rawStep.projectId) === Number(run.projectId)
          && rawStep.threadId === run.threadId
          && rawStep.runId === run.id
          && rawStep.agentRole === run.agentRole
          && rawStep.kind === "model"
          && rawStep.toolName == null;
        if (!validScope || rawStep.status !== "running" || modelDispatchState(rawStep.inputRefs) === null) {
          throw new SafeAgentRunExecutorError("model_step_invalid", "Run 的模型 Step 状态无效，已拒绝重复执行");
        }
        if (modelDispatchState(rawStep.inputRefs) === "dispatched" || booleanValue(run.sideEffectsCommitted)) {
          throw new SafeAgentRunExecutorError("model_step_already_dispatched", "模型请求已经发出，禁止重复执行");
        }
      } else {
        const maxStep = await (trx as any)("o_agent_step").where({ runId: run.id }).max({ seq: "seq" }).first();
        const stepSeq = Math.max(Number(run.checkpointStepSeq || 0), Number(maxStep?.seq || 0)) + 1;
        rawStep = {
          id: this.stepIdFactory(),
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          parentStepId: null,
          seq: stepSeq,
          agentRole: run.agentRole,
          kind: "model",
          status: "running",
          toolName: null,
          argumentsDigest: null,
          inputRefs: stableModelInputRefs(run.id),
          outputRefs: [],
          idempotencyKey: stepKey,
          resolvedModel: pinnedModelAlias(policySnapshot),
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
      }

      if (createsResponse || createsStep) {
        const runVersion = Number(run.version || 0);
        const runPatch: Record<string, unknown> = {
          version: runVersion + 1,
          updatedAt: now,
        };
        if (createsResponse) runPatch.responseMessageId = responseMessageId;
        if (createsStep) runPatch.checkpointStepSeq = Number(rawStep.seq);
        const runQuery = (trx as any)("o_agent_run")
          .where({
            id: run.id,
            workspaceId: run.workspaceId,
            status: run.status,
            leaseOwner: workerId,
            attempt: Number(run.attempt || 0),
            version: runVersion,
          })
          .andWhere("leaseExpiresAt", ">", now);
        if (createsResponse) runQuery.whereNull("responseMessageId");
        const runUpdated = await runQuery.update(runPatch);
        if (affectedRows(runUpdated) !== 1) {
          return { kind: "lease_lost", responseMessageId: createsResponse ? null : responseMessageId };
        }
      }

      const eventCount = (createsResponse ? 2 : 0) + (createsStep ? 1 : 0);
      const messageSeq = Number(thread.messageSeq || 0) + (createsResponse ? 1 : 0);
      let eventSeq = Number(thread.eventSeq || 0);
      if (eventCount > 0) {
        const threadVersion = Number(thread.version || 0);
        const threadPatch: Record<string, unknown> = {
          eventSeq: eventSeq + eventCount,
          version: threadVersion + 1,
          updatedAt: now,
        };
        if (createsResponse) {
          threadPatch.messageSeq = messageSeq;
          threadPatch.lastMessageAt = now;
        }
        const threadUpdated = await (trx as any)("o_agent_thread")
          .where({ id: run.threadId, workspaceId: run.workspaceId, version: threadVersion })
          .update(threadPatch);
        if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 准备模型 Step 时 Thread 版本冲突`);
      }

      if (createsResponse) {
        await (trx as any)("o_agent_message").insert({
          id: responseMessageId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          replyToId: trigger.id,
          clientMessageId: null,
          seq: messageSeq,
          role: "assistant",
          agentRole: run.agentRole,
          visibility: "user",
          status: "pending",
          content: JSON.stringify([]),
          referenceRefs: JSON.stringify([]),
          createdBy: null,
          error: null,
          metadata: JSON.stringify({ source: "agent-runtime-preview" }),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          seq: ++eventSeq,
          type: "message.created",
          payload: { messageId: responseMessageId, seq: messageSeq, role: "assistant", status: "pending" },
          createdAt: now,
        });
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          seq: ++eventSeq,
          type: "run.started",
          payload: { runId: run.id, status: "running", agentRole: run.agentRole, attempt: Number(run.attempt || 0) },
          createdAt: now,
        });
      }

      if (createsStep) {
        await (trx as any)("o_agent_step").insert({
          ...rawStep,
          inputRefs: JSON.stringify(rawStep.inputRefs),
          outputRefs: JSON.stringify(rawStep.outputRefs),
          usage: JSON.stringify(rawStep.usage),
          safeError: null,
        });
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: responseMessageId,
          stepId: rawStep.id,
          seq: ++eventSeq,
          type: "step.started",
          payload: { step: toAgentStepDto(asAgentStep(rawStep)) },
          createdAt: now,
        });
      }

      return {
        kind: "ready",
        cancelRequested: run.status === "cancelling",
        run: {
          id: run.id,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          rootRunId: run.rootRunId,
          agentRole: run.agentRole,
          attempt: Number(run.attempt || 0),
          policySnapshot,
        },
        triggerMessage: {
          id: trigger.id,
          threadId: trigger.threadId,
          content: parseArray<AgentContentPart>(trigger.content),
          referenceRefs: parseArray<string>(trigger.referenceRefs),
        },
        responseMessageId,
        stepId: rawStep.id,
      };
    });
  }

  private async checkpointExternalDispatch(input: {
    runId: string;
    workspaceId: string;
    attempt: number;
    workerId: string;
    stepId: string;
    now: number;
  }): Promise<void> {
    await this.database.transaction(async (trx) => {
      const run = (await (trx as any)("o_agent_run")
        .where({ id: input.runId, workspaceId: input.workspaceId })
        .first()) as RawRun | undefined;
      const step = (await (trx as any)("o_agent_step")
        .where({
          id: input.stepId,
          runId: input.runId,
          workspaceId: input.workspaceId,
          kind: "model",
        })
        .first()) as RawStep | undefined;
      if (!run || !step || step.status !== "running") {
        throw new SafeAgentRunExecutorError("model_dispatch_checkpoint_invalid", "模型请求检查点不存在或状态无效");
      }

      const dispatchState = modelDispatchState(step.inputRefs);
      if (dispatchState === "dispatched" && booleanValue(run.sideEffectsCommitted)) return;
      if (dispatchState !== "prepared" || booleanValue(run.sideEffectsCommitted)) {
        throw new SafeAgentRunExecutorError("model_dispatch_checkpoint_invalid", "模型请求检查点状态不一致");
      }
      if (
        run.status !== "running"
        || Number(run.attempt || 0) !== input.attempt
        || !hasLiveLease(run, input.workerId, input.now)
      ) {
        throw new SafeAgentRunExecutorError("model_dispatch_lease_lost", "模型请求发出前执行租约已失效");
      }

      const runUpdated = await (trx as any)("o_agent_run")
        .where({
          id: run.id,
          workspaceId: run.workspaceId,
          status: "running",
          leaseOwner: input.workerId,
          attempt: input.attempt,
          sideEffectsCommitted: 0,
        })
        .andWhere("leaseExpiresAt", ">", input.now)
        .update({
          sideEffectsCommitted: 1,
          version: trx.raw("?? + 1", ["version"]),
          updatedAt: input.now,
        });
      if (affectedRows(runUpdated) !== 1) {
        throw new SafeAgentRunExecutorError("model_dispatch_lease_lost", "模型请求发出前执行租约已失效");
      }

      const stepUpdated = await (trx as any)("o_agent_step")
        .where({ id: step.id, runId: run.id, status: "running", kind: "model" })
        .update({
          inputRefs: JSON.stringify(withDispatchedState(step.inputRefs)),
          updatedAt: input.now,
        });
      if (affectedRows(stepUpdated) !== 1) {
        throw new SafeAgentRunExecutorError("model_dispatch_checkpoint_conflict", "模型请求检查点发生冲突");
      }
    });
  }

  private async finalize(input: {
    runId: string;
    workspaceId: string;
    attempt: number;
    workerId: string;
    responseMessageId: string;
    stepId: string;
    execution:
      | { kind: "succeeded"; output: AgentRunExecutorOutput }
      | { kind: "failed"; error: { code: string; message: string } };
    now: number;
  }): Promise<AgentRunProcessResult> {
    const result = await this.database.transaction(async (trx): Promise<AgentRunProcessResult> => {
      const run = (await (trx as any)("o_agent_run")
        .where({ id: input.runId, workspaceId: input.workspaceId })
        .first()) as RawRun | undefined;
      if (
        !run ||
        !["running", "cancelling"].includes(run.status) ||
        Number(run.attempt || 0) !== input.attempt ||
        run.responseMessageId !== input.responseMessageId ||
        !hasLiveLease(run, input.workerId, input.now)
      ) {
        return { status: "lease_lost", runId: input.runId, responseMessageId: input.responseMessageId };
      }

      const step = (await (trx as any)("o_agent_step")
        .where({
          id: input.stepId,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          kind: "model",
        })
        .first()) as RawStep | undefined;
      if (!step || step.status !== "running") {
        throw new Error(`Run ${run.id} 的模型 Step 状态无效`);
      }

      const response = (await (trx as any)("o_agent_message")
        .where({
          id: input.responseMessageId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
        })
        .first()) as RawMessage | undefined;
      if (!response || !["pending", "streaming"].includes(response.status)) {
        throw new Error(`Run ${run.id} 的响应消息状态无效`);
      }

      const terminalStatus: "succeeded" | "failed" | "cancelled" = run.status === "cancelling"
        ? "cancelled"
        : input.execution.kind;
      const runError =
        terminalStatus === "failed" && input.execution.kind === "failed"
          ? input.execution.error
          : null;
      const messageStatus = terminalStatus === "succeeded" ? "completed" : terminalStatus === "cancelled" ? "stopped" : "error";
      const messageError = terminalStatus === "cancelled" ? CANCELLED_MESSAGE_ERROR : runError;
      const terminalEventType = terminalStatus === "succeeded" ? "run.succeeded" : terminalStatus === "cancelled" ? "run.cancelled" : "run.failed";
      const messageEventType = messageStatus === "completed" ? "message.completed" : messageStatus === "stopped" ? "message.stopped" : "message.error";
      const stepStatus = terminalStatus === "succeeded" ? "succeeded" : terminalStatus === "cancelled" ? "cancelled" : "failed";
      const stepError = terminalStatus === "cancelled" ? CANCELLED_MESSAGE_ERROR : runError;
      const stepEventType = stepStatus === "succeeded" ? "step.completed" : stepStatus === "cancelled" ? "step.cancelled" : "step.failed";
      const runVersion = Number(run.version || 0);
      const runPolicy = parseObject(run.policySnapshot);
      const contextUsage = terminalStatus === "succeeded" && runPolicy.modelEnabled === true
        ? agentMessageContextUsageFromSnapshot(runPolicy.contextSnapshot)
        : null;

      const runUpdated = await (trx as any)("o_agent_run")
        .where({
          id: run.id,
          workspaceId: run.workspaceId,
          status: run.status,
          leaseOwner: input.workerId,
          attempt: input.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", input.now)
        .update({
          status: terminalStatus,
          error: runError ? JSON.stringify(runError) : null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt: input.now,
          version: runVersion + 1,
          updatedAt: input.now,
        });
      if (affectedRows(runUpdated) !== 1) {
        return { status: "lease_lost", runId: run.id, responseMessageId: input.responseMessageId };
      }

      const stepOutputRefs = terminalStatus === "succeeded"
        ? [{ type: "agent_message", id: input.responseMessageId }]
        : [];
      const stepUpdated = await (trx as any)("o_agent_step")
        .where({ id: step.id, runId: run.id, status: "running", kind: "model" })
        .update({
          status: stepStatus,
          outputRefs: JSON.stringify(stepOutputRefs),
          errorCategory: stepError?.code ?? null,
          safeError: stepError ? JSON.stringify(stepError) : null,
          updatedAt: input.now,
          completedAt: input.now,
        });
      if (affectedRows(stepUpdated) !== 1) throw new Error(`Run ${run.id} 的模型 Step 终态写入失败`);
      const terminalStep = asAgentStep({
        ...step,
        status: stepStatus,
        outputRefs: stepOutputRefs,
        errorCategory: stepError?.code ?? null,
        safeError: stepError,
        updatedAt: input.now,
        completedAt: input.now,
      });

      const responseUpdated = await (trx as any)("o_agent_message")
        .where({
          id: input.responseMessageId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
        })
        .whereIn("status", ["pending", "streaming"])
        .update({
          status: messageStatus,
          content:
            terminalStatus === "succeeded" && input.execution.kind === "succeeded"
              ? JSON.stringify(input.execution.output.content)
              : JSON.stringify([]),
          error: messageError ? JSON.stringify(messageError) : null,
          metadata: JSON.stringify({
            ...parseObject(response.metadata),
            ...(contextUsage ? { contextUsage } : {}),
          }),
          updatedAt: input.now,
          completedAt: input.now,
        });
      if (affectedRows(responseUpdated) !== 1) throw new Error(`Run ${run.id} 的响应消息终态写入失败`);

      const thread = (await (trx as any)("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId })
        .select("id", "activeRootRunId", "eventSeq", "version")
        .first()) as RawThread | undefined;
      if (!thread) throw new Error(`Run ${run.id} 对应的 Thread 不存在`);
      const threadVersion = Number(thread.version || 0);
      const firstEventSeq = Number(thread.eventSeq || 0) + 1;
      const threadPatch: Record<string, unknown> = {
        eventSeq: firstEventSeq + 2,
        lastMessageAt: input.now,
        version: threadVersion + 1,
        updatedAt: input.now,
      };
      if (thread.activeRootRunId === run.id) threadPatch.activeRootRunId = null;
      const threadUpdated = await (trx as any)("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, version: threadVersion })
        .update(threadPatch);
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 终态写入时 Thread 版本冲突`);

      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: input.responseMessageId,
        stepId: step.id,
        seq: firstEventSeq,
        type: stepEventType,
        payload: { step: toAgentStepDto(terminalStep) },
        createdAt: input.now,
      });
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: input.responseMessageId,
        seq: firstEventSeq + 1,
        type: messageEventType,
        payload: {
          messageId: input.responseMessageId,
          status: messageStatus,
          ...(messageError ? { code: messageError.code } : {}),
        },
        createdAt: input.now,
      });
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: input.responseMessageId,
        seq: firstEventSeq + 2,
        type: terminalEventType,
        payload: {
          runId: run.id,
          status: terminalStatus,
          ...(runError ? { code: runError.code } : {}),
        },
        createdAt: input.now,
      });

      return { status: terminalStatus, runId: run.id, responseMessageId: input.responseMessageId };
    });
    if (result.status === "lease_lost") {
      await this.markDispatchedStepUncertain({
        runId: input.runId,
        workspaceId: input.workspaceId,
        stepId: input.stepId,
        responseMessageId: input.responseMessageId,
        now: input.now,
      });
    }
    return result;
  }

  private async markDispatchedStepUncertain(input: {
    runId: string;
    workspaceId: string;
    stepId: string;
    responseMessageId: string;
    now: number;
  }): Promise<void> {
    await this.database.transaction(async (trx) => {
      const run = (await (trx as any)("o_agent_run")
        .where({ id: input.runId, workspaceId: input.workspaceId })
        .first()) as RawRun | undefined;
      const step = (await (trx as any)("o_agent_step")
        .where({ id: input.stepId, runId: input.runId, workspaceId: input.workspaceId, kind: "model" })
        .first()) as RawStep | undefined;
      if (
        !run
        || !step
        || step.status !== "running"
        || !booleanValue(run.sideEffectsCommitted)
        || modelDispatchState(step.inputRefs) !== "dispatched"
      ) {
        return;
      }

      const stepUpdated = await (trx as any)("o_agent_step")
        .where({ id: step.id, runId: run.id, status: "running", kind: "model" })
        .update({
          status: "uncertain",
          errorCategory: MODEL_STEP_LEASE_LOST_ERROR.code,
          safeError: JSON.stringify(MODEL_STEP_LEASE_LOST_ERROR),
          updatedAt: input.now,
          completedAt: input.now,
        });
      if (affectedRows(stepUpdated) !== 1) return;

      const thread = (await (trx as any)("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId })
        .select("id", "eventSeq", "version")
        .first()) as RawThread | undefined;
      if (!thread) throw new Error(`Run ${run.id} 租约丢失时 Thread 不存在`);
      const threadVersion = Number(thread.version || 0);
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadUpdated = await (trx as any)("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq, version: threadVersion + 1, updatedAt: input.now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 租约丢失时 Thread 版本冲突`);

      const uncertainStep = asAgentStep({
        ...step,
        status: "uncertain",
        errorCategory: MODEL_STEP_LEASE_LOST_ERROR.code,
        safeError: MODEL_STEP_LEASE_LOST_ERROR,
        updatedAt: input.now,
        completedAt: input.now,
      });
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: input.responseMessageId,
        stepId: step.id,
        seq: eventSeq,
        type: "step.uncertain",
        payload: { step: toAgentStepDto(uncertainStep) },
        createdAt: input.now,
      });
    });
  }
}
