/**
 * DbSnapshotReader：从持久化状态读回「core reducer 需要的完全物化快照」。
 * 这是 imperative shell 的「读回」步骤：每次 core 决策前调用。
 *
 * 使用从 toolLoopProcessor 提取的只读方法：
 * - buildToolLoopTranscript
 * - findModelStep
 * - countPersistedToolCalls
 */
import type { Knex } from "knex";
import type { LoopSnapshot, CoreTranscriptItem, CoreToolMeta, CoreLoopLimits } from "@/agent-core";
import type { CoreModelStepState, CoreApprovalState } from "@/agent-core/snapshot";
import { buildToolLoopTranscript, findModelStep, countPersistedToolCalls, type AgentToolLoopTranscriptItem } from "@/agent-runtime/toolLoopSnapshot";
import type { AgentContentPart } from "@/agent-runtime/types";
import type { AgentApprovalService } from "@/agent-runtime/approvalService";

/** 从持久化状态读回 LoopSnapshot 的接口。 */
export interface CoreLoopSnapshotReader {
  /** 读取指定 Run 的完全物化快照。只读，不写。 */
  read(
    runId: string,
    turn: number,
    triggerContent: AgentContentPart[],
    toolMeta: Record<string, CoreToolMeta>,
    workerId: string,
    attempt: number,
  ): Promise<LoopSnapshot>;
}

/** DbSnapshotReader 依赖配置。 */
export interface DbSnapshotReaderOptions {
  /** Knex 数据库实例。 */
  database: Knex;
  /** Approval 服务（可选，用于读取审批状态）。 */
  approvalService?: AgentApprovalService;
  /** 环境时钟函数。 */
  clock: () => number;
  /** Loop limits 配置。 */
  limits: CoreLoopLimits;
}

/**
 * DB-backed 快照读取器。
 * 实现 CoreLoopSnapshotReader，从持久化状态构建 LoopSnapshot。
 */
export class DbSnapshotReader implements CoreLoopSnapshotReader {
  private readonly database: Knex;
  private readonly approvalService?: AgentApprovalService;
  private readonly clock: () => number;
  private readonly limits: CoreLoopLimits;

  constructor(options: DbSnapshotReaderOptions) {
    this.database = options.database;
    this.approvalService = options.approvalService;
    this.clock = options.clock;
    this.limits = options.limits;
  }

  /**
   * 读取指定 Run 的完全物化快照。
   * 供 decideNext 使用。
   */
  async read(
    runId: string,
    turn: number,
    triggerContent: AgentContentPart[],
    toolMeta: Record<string, CoreToolMeta>,
    workerId: string,
    attempt: number,
  ): Promise<LoopSnapshot> {
    // 1. 读取 Run 状态
    const run = await this.database("o_agent_run")
      .where({ id: runId })
      .first();
    
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    // 2. 读取 transcript（喂给模型的历史消息）
    const transcript = await this.buildTranscript(runId, triggerContent, turn);

    // 3. 读取当前 turn 的模型 Step
    const modelStep = await this.readModelStep(runId, turn);

    // 4. 统计已使用的工具调用数
    const persistedToolCallsUsed = await countPersistedToolCalls(this.database, runId);

    // 5. 读取审批状态（如果有 approvalId）
    const approval = await this.readApprovalState(runId, turn);

    // 6. 检查取消请求
    const cancellationRequested = run.status === "cancelling" || run.status === "cancelled";

    // 7. 构建 LoopSnapshot
    return {
      transcript,
      turn,
      persistedToolCallsUsed,
      modelStep,
      persistedToolCalls: [], // TODO: 如果需要跟踪单个 tool call 的回填状态，在此填充
      approval,
      cancellationRequested,
      toolMeta,
      limits: this.limits,
    };
  }

  /**
   * 构建对话上下文。
   * 调用已提取的 buildToolLoopTranscript。
   */
  private async buildTranscript(
    runId: string,
    triggerContent: AgentContentPart[],
    turn: number,
  ): Promise<CoreTranscriptItem[]> {
    const items = await buildToolLoopTranscript(this.database, runId, triggerContent, turn);
    return items.map(item => this.convertTranscriptItem(item));
  }

  /**
   * 转换 AgentToolLoopTranscriptItem 到 CoreTranscriptItem。
   */
  private convertTranscriptItem(item: AgentToolLoopTranscriptItem): CoreTranscriptItem {
    switch (item.role) {
      case "user":
        return { role: "user", content: item.content };
      case "assistant":
        return { role: "assistant", text: item.text, toolCalls: item.toolCalls };
      case "tool":
        return { role: "tool", callId: item.callId, name: item.name, output: item.output };
    }
  }

  /**
   * 读取指定 turn 的模型 Step 状态。
   * 调用已提取的 findModelStep。
   */
  private async readModelStep(runId: string, turn: number): Promise<CoreModelStepState> {
    const step = await findModelStep(this.database, runId, turn);
    
    if (!step) {
      return { phase: "absent" };
    }

    // 解析 Step 状态
    if (step.status === "uncertain") {
      return { phase: "uncertain" };
    }

    if (step.status === "running") {
      // 检查是否已 dispatch（通过 inputRefs）
      const inputRefs = this.parseJsonArray(step.inputRefs);
      const dispatchRef = inputRefs.find((ref: any) => ref?.type === "model_dispatch");
      if (dispatchRef?.value === "dispatched") {
        return { phase: "dispatched" };
      }
      // 如果是 running 但未 dispatched，视为 absent（需要 dispatch）
      return { phase: "absent" };
    }

    if (step.status === "succeeded") {
      // 解析 outputRefs 获取 result
      const result = this.parseStoredResult(step);
      if (!result) {
        return { phase: "absent" };
      }
      return { phase: "committed", result };
    }

    // 其他状态（failed, cancelled 等）视为 absent
    return { phase: "absent" };
  }

  /**
   * 从 Step.outputRefs 解析 StoredModelTurnResult。
   */
  private parseStoredResult(step: any): any {
    const outputRefs = this.parseJsonArray(step.outputRefs);
    const ref = outputRefs.find((item: any) => item?.type === "model_turn_result");
    if (!ref) return null;

    const turn = Number(ref.turn);
    const outcome = ref.outcome;
    if (!Number.isSafeInteger(turn) || turn <= 0 || (outcome !== "tool_calls" && outcome !== "final")) {
      return null;
    }

    return {
      type: "model_turn_result",
      turn,
      outcome,
      assistantText: typeof ref.assistantText === "string" ? ref.assistantText : "",
      calls: Array.isArray(ref.calls) ? ref.calls : [],
      toolResults: Array.isArray(ref.toolResults) ? ref.toolResults : [],
      content: Array.isArray(ref.content) ? ref.content : [],
    };
  }

  /**
   * 读取审批状态。
   */
  private async readApprovalState(
    runId: string,
    turn: number,
  ): Promise<CoreApprovalState> {
    if (!this.approvalService) {
      return { present: false };
    }

    try {
      // 从 Step.outputRefs 解析 approvalId
      const approvalId = await this.extractApprovalId(runId, turn);
      if (!approvalId) {
        return { present: false };
      }

      // 读取 Run 信息
      const run = await this.database("o_agent_run")
        .where({ id: runId })
        .select("workspaceId", "projectId")
        .first();
      
      if (!run) {
        return { present: false };
      }

      const approval = await this.approvalService.get({
        workspaceId: run.workspaceId,
        projectId: Number(run.projectId),
        approvalId,
      });

      if (!approval) {
        return { present: false };
      }

      // 映射状态
      let status: "pending" | "approved" | "denied" | "expired" | "consumed";
      switch (approval.status) {
        case "pending":
          status = "pending";
          break;
        case "approved":
          status = "approved";
          break;
        case "denied":
          status = "denied";
          break;
        case "consumed":
          status = "consumed";
          break;
        case "expired":
          status = "expired";
          break;
        default:
          status = "pending";
      }

      return { present: true, status };
    } catch (error) {
      // 如果读取失败，返回未决状态
      console.warn(`Failed to read approval for run ${runId}:`, error);
      return { present: false };
    }
  }

  /**
   * 从 Step.outputRefs 提取 approvalId。
   */
  private async extractApprovalId(runId: string, turn: number): Promise<string | null> {
    const step = await findModelStep(this.database, runId, turn);
    if (!step) return null;

    const outputRefs = this.parseJsonArray(step.outputRefs);
    const ref = outputRefs.find((item: any) => item?.type === "model_turn_result");
    if (!ref) return null;

    return typeof ref.approvalId === "string" && ref.approvalId ? ref.approvalId : null;
  }

  /**
   * 解析 JSON 数组，失败返回空数组。
   */
  private parseJsonArray(value: unknown): any[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || !value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

/**
 * 便捷函数：创建 DbSnapshotReader。
 */
export function createDbSnapshotReader(options: DbSnapshotReaderOptions): DbSnapshotReader {
  return new DbSnapshotReader(options);
}

/**
 * 骨架实现：返回最小有效快照。
 * 保留向后兼容性。
 */
export class StubSnapshotReader implements CoreLoopSnapshotReader {
  async read(_runId: string): Promise<LoopSnapshot> {
    // 骨架实现：返回一个安全的空快照
    return {
      transcript: [],
      turn: 1,
      persistedToolCallsUsed: 0,
      modelStep: { phase: "absent" },
      persistedToolCalls: [],
      approval: { present: false },
      cancellationRequested: false,
      toolMeta: {},
      limits: {
        maxTurns: 4,
        maxToolCalls: 8,
        maxArgumentBytes: 32_768,
        maxResultBytes: 65_536,
        maxFinalTextBytes: 65_536,
      },
    };
  }
}

/**
 * 便捷函数：创建 CoreLoopSnapshotReader。
 * Phase 4 完整实现时替换为真正的 DB-backed reader。
 */
export function readCoreLoopSnapshot(runId: string): Promise<LoopSnapshot> {
  const reader = new StubSnapshotReader();
  return reader.read(runId);
}
