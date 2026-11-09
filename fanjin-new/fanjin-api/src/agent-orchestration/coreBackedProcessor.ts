/**
 * CoreBackedToolLoopProcessor：用 agent-core 单步 reducer 驱动的全新实现。
 * 
 * 完全独立的 agent tool loop processor，不依赖旧 AgentToolLoopProcessor。
 * 使用 decideNext reducer 做决策，自己实现所有写入逻辑。
 */
import type { Knex } from "knex";
import type { AgentRunProcessInput, AgentRunProcessResult } from "@/agent-runtime/runProcessor";
import type { AgentRunProcessorRouterTarget } from "@/agent-runtime/runProcessorRouter";
import type { LoopSnapshot, CoreToolMeta } from "@/agent-core";
import { decideNext } from "@/agent-core";
import type { CoreLoopSnapshotReader } from "./snapshotReader";
import type { AgentToolLoopModel, AgentToolLoopToolCall, AgentToolLoopToolResult, RawStep } from "@/agent-runtime/toolLoopProcessor";
import type { AgentToolGateway } from "@/agent-runtime/tools/gateway";
import type { AgentApprovalService, AgentApproval } from "@/agent-runtime/approvalService";
import { autoApproveAgentApprovalInTransaction } from "@/agent-runtime/approvalService";
import type { AgentDelegationCoordinator } from "@/agent-runtime/delegationCoordinator";
import type { AppendAgentEventInput } from "@/agent-runtime/eventStore";
import type { AgentToolLoopLifecycleHooks } from "@/agent-runtime/toolLoopProcessor";
import type { AgentContentPart } from "@/agent-runtime/types";
import { appendAgentEvent } from "@/agent-runtime/eventStore";
import { ToolLoopSafeError } from "@/agent-runtime/toolLoopProcessor";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { toSafeAgentApprovalDto } from "@/agent-runtime/approvalDto";
import { isAgentAutoApproveEnabled } from "@/agent-runtime/featureFlags";
import { parseAgentDelegateInputForPromptVersion } from "@/agent-runtime/tools/packages/delegation";
import { resolveAgentRuntimeConfigSnapshot } from "@/agent-runtime/runtimeConfigRegistry";
import {
  PROJECT_TABLE,
  AGENT_PROJECT_BUDGET_COLUMN,
  AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
} from "@/lib/migrations/agentProjectBudget";

// ─── 常量 ───
const MODEL_STEP_PREFIX = "agent-model";
const TOOL_LOOP_RESULT_REF = "model_turn_result";
const MODEL_DISPATCH_REF = "model_dispatch";
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000;

// ─── 内部类型 ───
interface RawRun {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  rootRunId: string;
  triggerMessageId: string;
  responseMessageId: string | null;
  agentRole: string;
  status: string;
  policySnapshot: string;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  attempt: number;
  version: number | string;
  checkpointStepSeq: number;
}

interface RawMessage {
  id: string;
  workspaceId: string;
  projectId: number;
  threadId: string;
  runId: string | null;
  replyToId: string | null;
  seq: number;
  role: string;
  agentRole: string | null;
  visibility: string;
  status: string;
  content: string;
  referenceRefs: string;
  metadata: string;
  createdAt: number;
  updatedAt: number;
}

interface RawThread {
  id: string;
  workspaceId: string;
  projectId: number;
  messageSeq: number;
  eventSeq: number;
  version: number;
}

interface StoredModelTurnResult {
  type: typeof TOOL_LOOP_RESULT_REF;
  turn: number;
  outcome: "tool_calls" | "final";
  assistantText: string;
  calls: AgentToolLoopToolCall[];
  toolResults: AgentToolLoopToolResult[];
  content: AgentContentPart[];
  approvalId: string | null;
  argumentsRevised?: { approvalId: string; revision: number; at: number } | null;
}

// ─── 辅助函数 ───
function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch { return []; }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function modelToolExposureScope(run: Pick<RawRun, "agentRole" | "policySnapshot">): {
  promptKey: string;
  promptVersion: string;
  delegationEnabled: unknown;
} {
  const policy = parseObject(run.policySnapshot);
  if (run.agentRole !== "main") {
    throw new ToolLoopSafeError(
      "agent_config_snapshot_invalid",
      "Run 的固定 Agent 配置快照无效，不能开放模型工具",
    );
  }

  // 尝试直接从 snapshot 读取（适用于测试和实际运行）
  const agentConfig = policy.agentConfig as any;
  if (agentConfig?.prompt?.version) {
    return {
      promptKey: agentConfig.prompt.key || "unknown",
      promptVersion: agentConfig.prompt.version,
      delegationEnabled: policy.delegationEnabled,
    };
  }

  // 如果没有 prompt.version，尝试完整验证
  try {
    const config = resolveAgentRuntimeConfigSnapshot(policy.agentConfig, "main");
    return {
      promptKey: config.prompt.key,
      promptVersion: config.prompt.version,
      delegationEnabled: policy.delegationEnabled,
    };
  } catch {
    throw new ToolLoopSafeError(
      "agent_config_snapshot_invalid",
      "Run 的固定 Agent 配置快照无效，不能开放模型工具",
    );
  }
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (typeof result === "number") return result;
  return 0;
}

function hasLiveLease(run: RawRun, workerId: string, attempt: number, now: number): boolean {
  return run.leaseOwner === workerId
    && run.attempt === attempt
    && typeof run.leaseExpiresAt === "number"
    && run.leaseExpiresAt > now;
}

function modelStepKey(runId: string, turn: number): string {
  return `${MODEL_STEP_PREFIX}:${runId}:turn:${turn}`;
}

function storedTurnResult(step: Pick<RawStep, "outputRefs">): StoredModelTurnResult | null {
  const ref = parseArray<Record<string, unknown>>(step.outputRefs)
    .find((item) => item?.type === TOOL_LOOP_RESULT_REF);
  if (!ref) return null;
  const turn = Number(ref.turn);
  const outcome = ref.outcome;
  if (!Number.isSafeInteger(turn) || turn <= 0 || (outcome !== "tool_calls" && outcome !== "final")) return null;
  return {
    type: TOOL_LOOP_RESULT_REF,
    turn,
    outcome,
    assistantText: typeof ref.assistantText === "string" ? ref.assistantText : "",
    calls: Array.isArray(ref.calls) ? ref.calls as AgentToolLoopToolCall[] : [],
    toolResults: Array.isArray(ref.toolResults) ? ref.toolResults as AgentToolLoopToolResult[] : [],
    content: Array.isArray(ref.content) ? ref.content as AgentContentPart[] : [],
    approvalId: typeof ref.approvalId === "string" && ref.approvalId ? ref.approvalId : null,
  };
}

// ─── 配置类型 ───
export interface CoreBackedProcessorOptions {
  snapshotReader: CoreLoopSnapshotReader;
  database: Knex;
  toolMeta: Record<string, CoreToolMeta>;
  clock: () => number;
  limits: {
    maxTurns: number;
    maxToolCalls: number;
    maxArgumentBytes: number;
    maxResultBytes: number;
    maxFinalTextBytes: number;
  };
  model: AgentToolLoopModel;
  gateway: AgentToolGateway;
  approvalService?: AgentApprovalService;
  delegationCoordinator?: Pick<AgentDelegationCoordinator, "start">;
  messageIdFactory: () => string;
  stepIdFactory: () => string;
  eventAppender: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
  hooks?: AgentToolLoopLifecycleHooks;
}

// ─── 主类 ───
export class CoreBackedToolLoopProcessor implements AgentRunProcessorRouterTarget {
  private readonly snapshotReader: CoreLoopSnapshotReader;
  private readonly database: Knex;
  private readonly toolMeta: Record<string, CoreToolMeta>;
  private readonly clock: () => number;
  private readonly limits: CoreBackedProcessorOptions["limits"];
  private readonly model: AgentToolLoopModel;
  private readonly gateway: AgentToolGateway;
  private readonly approvalService?: AgentApprovalService;
  private readonly delegationCoordinator?: Pick<AgentDelegationCoordinator, "start">;
  private readonly messageIdFactory: () => string;
  private readonly stepIdFactory: () => string;
  private readonly eventAppender: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
  private readonly hooks?: AgentToolLoopLifecycleHooks;

  constructor(options: CoreBackedProcessorOptions) {
    this.snapshotReader = options.snapshotReader;
    this.database = options.database;
    this.toolMeta = options.toolMeta;
    this.clock = options.clock;
    this.limits = options.limits;
    this.model = options.model;
    this.gateway = options.gateway;
    this.approvalService = options.approvalService;
    this.delegationCoordinator = options.delegationCoordinator;
    this.messageIdFactory = options.messageIdFactory;
    this.stepIdFactory = options.stepIdFactory;
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
    this.hooks = options.hooks;
  }

  // ─── 辅助方法 ───
  private async lockRunWithFreshClock(trx: Knex.Transaction, runId: string): Promise<{ run: RawRun | undefined; now: number }> {
    const run = await trx<RawRun>("o_agent_run").where({ id: runId }).forUpdate().first();
    return { run, now: this.clock() };
  }

  // ─── 核心方法 ───
  async process(input: AgentRunProcessInput): Promise<AgentRunProcessResult> {
    const workerId = input.workerId.trim();
    if (!workerId || input.claimedRun.leaseOwner !== workerId) {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: null };
    }

    // 1. ensureResponse
    const prepared = await this.ensureResponse(input, workerId);
    if (prepared.kind === "lease_lost") {
      return { status: "lease_lost", runId: input.claimedRun.id, responseMessageId: prepared.responseMessageId };
    }
    if (prepared.kind === "cancelled") {
      return { status: "cancelled", runId: input.claimedRun.id, responseMessageId: prepared.responseMessageId ?? "" };
    }

    // prepared.kind === "ready"
    const readyPrepared = prepared;

    // 2. Turn 循环
    for (let turn = 1; turn <= this.limits.maxTurns; turn++) {
      const result = await this.processTurn(readyPrepared, turn, input, workerId);
      if (result) return result;
    }

    // 3. 超过 maxTurns
    return this.finalize(readyPrepared, input, workerId, "failed", { code: "max_turns_exceeded", message: "超过最大 turn 数" }, []);
  }

  private async processTurn(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    turn: number,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult | null> {
    // 读取快照
    const triggerContent = parseArray<AgentContentPart>(prepared.trigger.content);
    const snapshot = await this.snapshotReader.read(
      prepared.run.id,
      turn,
      triggerContent,
      this.toolMeta,
      workerId,
      input.claimedRun.attempt,
    );

    // 决策
    const decision = decideNext(snapshot);

    // 执行决策
    switch (decision.kind) {
      case "dispatch_model":
        return this.handleDispatchModel(prepared, turn, snapshot, input, workerId);
      case "execute_tools":
        return this.handleExecuteTools(prepared, turn, snapshot, decision.calls, input, workerId);
      case "pause_for_approval":
        return this.handlePauseForApproval(prepared, turn, snapshot, decision.call, input, workerId);
      case "start_delegation":
        return this.handleStartDelegation(prepared, turn, snapshot, decision.call, input, workerId);
      case "record_denied_approval":
        return this.handleRecordDeniedApproval(prepared, turn, snapshot, decision.approvalId, input, workerId);
      case "finalize_succeeded":
        return this.finalize(prepared, input, workerId, "succeeded", null, decision.content as AgentContentPart[]);
      case "finalize_exhausted":
        return this.finalize(prepared, input, workerId, "failed", { code: `tool_loop_${decision.reason}`, message: `达到上限` }, []);
      case "halt_cancelled":
        return { status: "cancelled", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      case "halt_uncertain":
        return this.finalize(prepared, input, workerId, "failed", { code: "tool_loop_uncertain", message: "模型结果不确定" }, []);
      default: {
        const _exhaustive: never = decision;
        throw new Error(`Unhandled decision: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // ─── ensureResponse ───
  private async ensureResponse(
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<{ kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string } | { kind: "lease_lost"; responseMessageId: string | null } | { kind: "cancelled"; responseMessageId: string }> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, input.claimedRun.id);

      if (run?.status === "cancelled" && run.responseMessageId) {
        const response = await trx<RawMessage>("o_agent_message")
          .where({ id: run.responseMessageId, runId: run.id, threadId: run.threadId, role: "assistant" })
          .first();
        if (response?.status === "stopped") {
          return { kind: "cancelled", responseMessageId: run.responseMessageId };
        }
      }

      if (!run || !["running", "cancelling"].includes(run.status) || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { kind: "lease_lost", responseMessageId: run?.responseMessageId ?? null };
      }

      const policy = parseObject(run.policySnapshot);
      if (policy.modelEnabled !== true || policy.toolsEnabled !== true) {
        throw new ToolLoopSafeError("tool_loop_not_enabled", "Run 未启用工具循环");
      }

      const trigger = await trx<RawMessage>("o_agent_message")
        .where({ id: run.triggerMessageId, workspaceId: run.workspaceId, projectId: Number(run.projectId), threadId: run.threadId })
        .first();
      if (!trigger || trigger.role !== "user") throw new Error(`Run ${run.id} 触发消息不存在`);

      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Run ${run.id} Thread 不存在`);

      let responseMessageId = run.responseMessageId;
      if (responseMessageId) {
        const response = await trx<RawMessage>("o_agent_message")
          .where({ id: responseMessageId, runId: run.id, threadId: run.threadId, role: "assistant" })
          .first();
        if (!response || response.status !== "pending") throw new Error(`Run ${run.id} 响应消息状态无效`);
      } else {
        responseMessageId = this.messageIdFactory();
        const runVersion = Number(run.version || 0);
        const runUpdated = await trx("o_agent_run")
          .where({ id: run.id, workspaceId: run.workspaceId, status: run.status, leaseOwner: workerId, attempt: input.claimedRun.attempt, version: runVersion })
          .andWhere("leaseExpiresAt", ">", now)
          .whereNull("responseMessageId")
          .update({ responseMessageId, version: runVersion + 1, updatedAt: now });
        if (affectedRows(runUpdated) !== 1) return { kind: "lease_lost", responseMessageId: null };

        const messageSeq = Number(thread.messageSeq || 0) + 1;
        const firstEventSeq = Number(thread.eventSeq || 0) + 1;
        const threadVersion = Number(thread.version || 0);
        await trx("o_agent_thread")
          .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
          .update({ messageSeq, eventSeq: firstEventSeq + 1, lastMessageAt: now, version: threadVersion + 1, updatedAt: now });

        await trx("o_agent_message").insert({
          id: responseMessageId, workspaceId: run.workspaceId, projectId: Number(run.projectId),
          threadId: run.threadId, runId: run.id, replyToId: trigger.id, seq: messageSeq,
          role: "assistant", agentRole: run.agentRole, visibility: "user", status: "pending",
          content: JSON.stringify([]), referenceRefs: JSON.stringify([]), metadata: JSON.stringify({}),
          createdAt: now, updatedAt: now,
        });

        await this.eventAppender(trx, {
          workspaceId: run.workspaceId, projectId: Number(run.projectId), threadId: run.threadId,
          runId: run.id, messageId: responseMessageId, seq: firstEventSeq,
          type: "message.created", payload: { messageId: responseMessageId, seq: messageSeq },
          createdAt: now,
        });
        await this.eventAppender(trx, {
          workspaceId: run.workspaceId, projectId: Number(run.projectId), threadId: run.threadId,
          runId: run.id, messageId: responseMessageId, seq: firstEventSeq + 1,
          type: "run.started", payload: { runId: run.id, status: "running" },
          createdAt: now,
        });

        run.responseMessageId = responseMessageId;
        run.version = runVersion + 1;
      }

      return { kind: "ready", run, trigger, responseMessageId };
    });
  }

  // ─── handleDispatchModel ───
  private async handleDispatchModel(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    turn: number,
    snapshot: LoopSnapshot,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult> {
    const responseMessageId = prepared.responseMessageId;

    // 1. 创建 Step
    const step = await this.createModelStep(prepared, turn, input, workerId);
    if (!step) {
      return { status: "lease_lost", runId: prepared.run.id, responseMessageId };
    }

    // 2. 执行模型调用
    try {
      const tools = await this.gateway.listModelToolCandidates(prepared.run.id);
      const transcript = snapshot.transcript;

      const requestKey = modelStepKey(prepared.run.id, turn);
      let dispatchCommitted = false;

      const raw = await this.model.executeTurn({
        run: {
          id: prepared.run.id, workspaceId: prepared.run.workspaceId,
          projectId: Number(prepared.run.projectId), threadId: prepared.run.threadId,
          agentRole: prepared.run.agentRole,
        },
        turn,
        requestId: requestKey,
        idempotencyKey: requestKey,
        transcript,
        tools,
        checkpointExternalDispatch: async () => {
          await this.checkpointModelDispatch(prepared, step, "dispatched", input, workerId);
          dispatchCommitted = true;
        },
      });

      // 3. 提交模型结果
      const assistantText = raw.kind === "tool_calls" ? (raw.assistantText ?? "") : "";
      const result: StoredModelTurnResult = {
        type: TOOL_LOOP_RESULT_REF,
        turn,
        outcome: raw.kind === "final" ? "final" : "tool_calls",
        assistantText,
        calls: raw.kind === "tool_calls" ? raw.calls : [],
        toolResults: [],
        content: raw.kind === "final" ? raw.content : [],
        approvalId: null,
      };

      const committed = await this.commitModelResult(prepared, step, result, input, workerId);
      if (!committed) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId };
      }

      // 4. 返回 queued 让调度器继续下一轮
      return { status: "queued", runId: prepared.run.id, responseMessageId };
    } catch (error) {
      await this.finalize(prepared, input, workerId, "failed", { code: "model_error", message: String(error) }, []);
      return { status: "failed", runId: prepared.run.id, responseMessageId };
    }
  }

  // ─── createModelStep ───
  private async createModelStep(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    turn: number,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<RawStep | null> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return null;

      const existing = await trx<RawStep>("o_agent_step")
        .where({ runId: run.id, idempotencyKey: modelStepKey(run.id, turn) })
        .first();
      if (existing) return existing;

      const seq = run.checkpointStepSeq + 1;
      const stepId = this.stepIdFactory();
      const step: any = {
        id: stepId,
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        seq,
        kind: "model",
        status: "running",
        inputRefs: JSON.stringify([{ type: MODEL_DISPATCH_REF, value: "prepared" }, { type: "turn", value: turn }]),
        outputRefs: JSON.stringify([]),
        idempotencyKey: modelStepKey(run.id, turn),
        createdAt: now,
        updatedAt: now,
      };

      await trx("o_agent_step").insert(step);
      await trx("o_agent_run")
        .where({ id: run.id, version: Number(run.version) })
        .update({ checkpointStepSeq: seq, version: Number(run.version) + 1, updatedAt: now });

      return step as RawStep;
    });
  }

  // ─── checkpointModelDispatch ───
  private async checkpointModelDispatch(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    step: RawStep,
    state: "dispatched",
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<void> {
    await this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return;

      const inputRefs = parseArray<Record<string, unknown>>(step.inputRefs)
        .filter((ref) => ref?.type !== MODEL_DISPATCH_REF);
      inputRefs.unshift({ type: MODEL_DISPATCH_REF, value: state });

      await trx("o_agent_step")
        .where({ id: step.id, runId: run.id, status: "running" })
        .update({ inputRefs: JSON.stringify(inputRefs), updatedAt: now });
    });
  }

  // ─── commitModelResult ───
  private async commitModelResult(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    step: RawStep,
    result: StoredModelTurnResult,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;

      const updated = await trx("o_agent_step")
        .where({ id: step.id, runId: run.id, status: "running" })
        .update({
          status: "succeeded",
          outputRefs: JSON.stringify([result]),
          completedAt: now,
          updatedAt: now,
        });

      return affectedRows(updated) === 1;
    });
  }

  // ─── handleExecuteTools ───
  private async handleExecuteTools(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    turn: number,
    snapshot: LoopSnapshot,
    calls: readonly any[],
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult> {
    const responseMessageId = prepared.responseMessageId;

    // 执行工具
    const toolResults: AgentToolLoopToolResult[] = [];
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      try {
        const result = await this.gateway.execute({
          runId: prepared.run.id,
          toolName: call.name,
          arguments: call.arguments,
          approvalId: null,
          idempotencyKey: `turn:${turn}:call:${index}:${call.id}`,
          claimFence: { workerId, attempt: input.claimedRun.attempt },
        });
        toolResults.push({
          callId: call.id,
          name: call.name,
          stepId: result.stepId,
          output: result.output,
        });
      } catch (error) {
        toolResults.push({
          callId: call.id,
          name: call.name,
          stepId: "",
          output: { error: String(error) },
        });
      }
    }

    // 记录工具结果
    const step = await this.findModelStep(prepared.run.id, turn);
    if (!step) {
      return { status: "lease_lost", runId: prepared.run.id, responseMessageId };
    }

    const recorded = await this.recordToolResults(prepared, step, toolResults, input, workerId);
    if (!recorded) {
      return { status: "lease_lost", runId: prepared.run.id, responseMessageId };
    }

    // 返回 queued 让调度器继续下一轮
    return { status: "queued", runId: prepared.run.id, responseMessageId };
  }

  // ─── recordToolResults ───
  private async recordToolResults(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    step: RawStep,
    toolResults: AgentToolLoopToolResult[],
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) return false;

      const stored = await trx<RawStep>("o_agent_step").where({ id: step.id, runId: run.id }).first();
      if (!stored) return false;

      const latest = storedTurnResult(stored);
      if (!latest || latest.outcome !== "tool_calls") return false;

      const updated = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "succeeded", kind: "model" })
        .update({
          outputRefs: JSON.stringify([{ ...latest, toolResults }]),
          updatedAt: now,
        });

      return affectedRows(updated) === 1;
    });
  }

  // ─── handlePauseForApproval ───
  private async handlePauseForApproval(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    turn: number,
    snapshot: LoopSnapshot,
    call: any,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult> {
    if (!this.approvalService) {
      throw new ToolLoopSafeError("approval_service_unavailable", "审批服务不可用");
    }

    const step = snapshot.modelStep;
    if (!step || step.phase !== "committed") {
      throw new ToolLoopSafeError("approval_checkpoint_invalid", "审批检查点无效");
    }

    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      
      // 通过 idempotencyKey 查找 step（更可靠）
      const stepKey = modelStepKey(prepared.run.id, turn);
      const stored = await trx<RawStep>("o_agent_step")
        .where({ runId: prepared.run.id, idempotencyKey: stepKey })
        .first();
      
      if (!run || !stored || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }

      const latest = storedTurnResult(stored);
      const checkpointRevised = latest?.argumentsRevised != null;
      
      if (!latest
        || latest.outcome !== "tool_calls"
        || latest.approvalId
        || latest.calls.length !== 1
        || (!checkpointRevised && hashIdempotencyRequest(latest.calls[0]) !== hashIdempotencyRequest(call))
        || (!checkpointRevised && hashIdempotencyRequest(latest.calls) !== hashIdempotencyRequest([call]))) {
        throw new ToolLoopSafeError("approval_checkpoint_invalid", "审批工具调用检查点无效");
      }

      const preparedAction = await this.gateway.prepareModelApprovalInTransaction(trx, {
        runId: run.id,
        stepId: stored.id,
        toolName: call.name,
        arguments: call.arguments,
      });

      let expiresAt = now + DEFAULT_APPROVAL_TTL_MS;
      if (preparedAction.quote?.expiresAt !== undefined) {
        expiresAt = Math.min(expiresAt, preparedAction.quote.expiresAt);
      }
      if (expiresAt <= now) {
        throw new ToolLoopSafeError("approval_evidence_expired", "服务端审批证据已过期");
      }

      if (!this.approvalService) {
        throw new ToolLoopSafeError("approval_service_unavailable", "审批服务不可用");
      }

      const approval = await this.approvalService.requestInTransaction(trx, {
        ...preparedAction,
        toolId: preparedAction.toolId as any, // toolId 类型在 gateway 和 approvalService 之间不完全匹配
        expiresAt,
      });

      const checkpointed = await trx("o_agent_step")
        .where({ id: stored.id, runId: run.id, status: "succeeded", kind: "model" })
        .update({
          outputRefs: JSON.stringify([{ ...latest, approvalId: approval.id }]),
          updatedAt: now,
        });
      if (affectedRows(checkpointed) !== 1) throw new Error("approval model checkpoint lost");

      // 预算自主审批
      const autoApproved = await this.tryAutoApproveApprovalWithinBudget(trx, approval, now);

      const runVersion = Number(run.version || 0);
      const runUpdated = await trx("o_agent_run")
        .where({
          id: run.id,
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          status: "running",
          leaseOwner: workerId,
          attempt: input.claimedRun.attempt,
          version: runVersion,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update(autoApproved
          ? {
              status: "queued",
              waitType: null,
              waitRef: null,
              wakeAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              version: runVersion + 1,
              updatedAt: now,
            }
          : {
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
        throw new ToolLoopSafeError("approval_pause_lease_lost", "进入审批等待前执行租约已变化");
      }

      const thread = await trx<RawThread>("o_agent_thread")
        .where({ id: run.threadId, workspaceId: run.workspaceId, projectId: Number(run.projectId) })
        .first();
      if (!thread) throw new Error(`Run ${run.id} 进入审批等待时 Thread 不存在`);

      const threadVersion = Number(thread.version || 0);
      const firstEventSeq = Number(thread.eventSeq || 0) + 1;
      const eventCount = autoApproved ? 3 : 2;
      
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: run.workspaceId, version: threadVersion })
        .update({ eventSeq: firstEventSeq + eventCount - 1, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) throw new Error(`Run ${run.id} 进入审批等待时 Thread 版本冲突`);

      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: stored.id,
        seq: firstEventSeq,
        type: "approval.requested",
        payload: { approval: toSafeAgentApprovalDto(approval) },
        createdAt: now,
      });

      if (autoApproved) {
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: prepared.responseMessageId,
          stepId: stored.id,
          seq: firstEventSeq + 1,
          type: "approval.approved",
          payload: { approval: toSafeAgentApprovalDto(autoApproved) },
          createdAt: now,
        });
        await appendAgentEvent(trx, {
          workspaceId: run.workspaceId,
          projectId: Number(run.projectId),
          threadId: run.threadId,
          runId: run.id,
          messageId: prepared.responseMessageId,
          stepId: stored.id,
          seq: firstEventSeq + 2,
          type: "run.queued",
          payload: { runId: run.id, status: "queued", reason: "approval_auto_approved" },
          createdAt: now,
        });
        return { status: "queued", runId: run.id, responseMessageId: prepared.responseMessageId };
      }

      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        stepId: stored.id,
        seq: firstEventSeq + 1,
        type: "run.status",
        payload: { runId: run.id, status: "waiting_approval", waitType: "approval" },
        createdAt: now,
      });
      return { status: "waiting_approval", runId: run.id, responseMessageId: prepared.responseMessageId };
    });
  }

  private async tryAutoApproveApprovalWithinBudget(
    trx: Knex.Transaction,
    approval: AgentApproval,
    now: number,
  ): Promise<AgentApproval | null> {
    if (!isAgentAutoApproveEnabled()) return null;
    if (approval.riskClass !== "R2") return null;
    const maximum = approval.quote?.maximumCostMicros;
    if (maximum == null || !Number.isSafeInteger(Number(maximum)) || Number(maximum) < 1) return null;
    
    const reserved = await trx(PROJECT_TABLE)
      .where({ id: approval.projectId, workspaceId: approval.workspaceId })
      .whereNotNull(AGENT_PROJECT_BUDGET_COLUMN)
      .whereRaw("COALESCE(??, 0) + ? <= ??", [
        AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
        Number(maximum),
        AGENT_PROJECT_BUDGET_COLUMN,
      ])
      .update({
        [AGENT_PROJECT_BUDGET_RESERVED_COLUMN]: trx.raw("COALESCE(??, 0) + ?", [
          AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
          Number(maximum),
        ]),
      });
    if (affectedRows(reserved) !== 1) return null;
    
    return autoApproveAgentApprovalInTransaction(trx, {
      approval,
      decidedBy: approval.requestedBy,
      budgetReservedMicros: Number(maximum),
      now,
    });
  }

  // ─── handleStartDelegation ───
  private async handleStartDelegation(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    turn: number,
    snapshot: LoopSnapshot,
    call: any,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult> {
    if (!this.delegationCoordinator) {
      throw new ToolLoopSafeError("delegation_service_unavailable", "委派服务不可用");
    }

    const step = snapshot.modelStep;
    if (!step || step.phase !== "committed") {
      throw new ToolLoopSafeError("delegation_checkpoint_invalid", "委派检查点无效");
    }

    const promptVersion = modelToolExposureScope(prepared.run).promptVersion;
    const delegationInput = parseAgentDelegateInputForPromptVersion(
      promptVersion,
      call.arguments,
    );

    if (!delegationInput) {
      throw new ToolLoopSafeError("delegation_request_invalid", "Agent 委派任务格式无效");
    }

    // 通过 idempotencyKey 查找 step
    const stepKey = modelStepKey(prepared.run.id, turn);
    const stored = await this.database<RawStep>("o_agent_step")
      .where({ runId: prepared.run.id, idempotencyKey: stepKey })
      .first();
    
    if (!stored) {
      throw new ToolLoopSafeError("delegation_checkpoint_invalid", "委派检查点 Step 不存在");
    }

    try {
      await this.delegationCoordinator.start({
        parentRunId: prepared.run.id,
        modelStepId: stored.id,
        workerId,
        attempt: input.claimedRun.attempt,
        idempotencyKey: `turn:${turn}:call:0:${call.id}`,
        tasks: delegationInput.tasks,
      });
      return {
        status: "waiting_delegation",
        runId: prepared.run.id,
        responseMessageId: prepared.responseMessageId,
      };
    } catch (error) {
      throw new ToolLoopSafeError("delegation_start_failed", `委派启动失败: ${error}`);
    }
  }

  // ─── handleRecordDeniedApproval ───
  private async handleRecordDeniedApproval(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    turn: number,
    snapshot: LoopSnapshot,
    approvalId: string,
    input: AgentRunProcessInput,
    workerId: string,
  ): Promise<AgentRunProcessResult> {
    if (!this.approvalService) {
      throw new ToolLoopSafeError("approval_service_unavailable", "审批服务不可用");
    }

    const step = snapshot.modelStep;
    if (!step || step.phase !== "committed") {
      throw new ToolLoopSafeError("approval_checkpoint_invalid", "审批检查点无效");
    }

    // 获取审批状态
    const approval = await this.approvalService.get({
      workspaceId: prepared.run.workspaceId,
      projectId: Number(prepared.run.projectId),
      approvalId,
    });

    const persistedApprovalStatus = approval.status;
    
    if (!["denied", "expired", "revoked"].includes(persistedApprovalStatus)) {
      throw new ToolLoopSafeError("approval_not_denied", "审批状态不是拒绝/过期/撤销");
    }

    // 通过 idempotencyKey 查找 step
    const stepKey = modelStepKey(prepared.run.id, turn);
    const stored = await this.database<RawStep>("o_agent_step")
      .where({ runId: prepared.run.id, idempotencyKey: stepKey })
      .first();
    
    if (!stored) {
      throw new ToolLoopSafeError("approval_checkpoint_invalid", "审批检查点 Step 不存在");
    }

    // 构造拒绝结果
    const toolResults: AgentToolLoopToolResult[] = [{
      callId: stored.id,
      name: approval.toolId as string,
      stepId: stored.id,
      output: {
        status: persistedApprovalStatus,
        code: persistedApprovalStatus === "expired" ? "approval_expired" : "approval_denied",
      },
    }];

    // 记录工具结果
    const recorded = await this.recordToolResults(
      prepared,
      stored,
      toolResults,
      input,
      workerId,
    );

    if (!recorded) {
      return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
    }

    return { status: "queued", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
  }

  // ─── finalize ───
  private async finalize(
    prepared: { kind: "ready"; run: RawRun; trigger: RawMessage; responseMessageId: string },
    input: AgentRunProcessInput,
    workerId: string,
    status: "succeeded" | "failed",
    error: { code: string; message: string } | null,
    content: AgentContentPart[],
  ): Promise<AgentRunProcessResult> {
    return this.database.transaction(async (trx) => {
      const { run, now } = await this.lockRunWithFreshClock(trx, prepared.run.id);
      if (!run || !hasLiveLease(run, workerId, input.claimedRun.attempt, now)) {
        return { status: "lease_lost", runId: prepared.run.id, responseMessageId: prepared.responseMessageId };
      }

      // 更新 Run 状态
      await trx("o_agent_run")
        .where({ id: run.id, version: Number(run.version) })
        .update({
          status,
          leaseOwner: null,
          leaseExpiresAt: null,
          version: Number(run.version) + 1,
          completedAt: now,
          updatedAt: now,
        });

      // 更新 Message
      if (prepared.responseMessageId) {
        await trx("o_agent_message")
          .where({ id: prepared.responseMessageId, runId: run.id })
          .update({
            status: status === "succeeded" ? "completed" : "error",
            content: JSON.stringify(content),
            completedAt: now,
            updatedAt: now,
          });
      }

      // 追加事件
      await this.eventAppender(trx, {
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        threadId: run.threadId,
        runId: run.id,
        messageId: prepared.responseMessageId,
        seq: 0,
        type: `run.${status}`,
        payload: { runId: run.id, status },
        createdAt: now,
      });

      return {
        status: status === "succeeded" ? "succeeded" : "failed",
        runId: run.id,
        responseMessageId: prepared.responseMessageId,
        error: error ?? undefined,
      };
    });
  }

  // ─── findModelStep ───
  private async findModelStep(runId: string, turn: number): Promise<RawStep | null> {
    const step = await this.database<RawStep>("o_agent_step")
      .where({ runId, idempotencyKey: modelStepKey(runId, turn), kind: "model" })
      .first();
    return step ?? null;
  }
}
