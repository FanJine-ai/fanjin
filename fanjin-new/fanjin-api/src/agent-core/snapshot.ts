/**
 * LoopSnapshot：喂给 decideNext 的「当前这一步的完全物化快照」。
 *
 * 核心约束：snapshot 里的每个字段都必须是「已经从持久层读出来、物化成普通值」的东西。
 * reducer 不许在运行时再去查库——所有它需要的事实，shell 必须先读好放进 snapshot。
 */
import type {
  CoreModelResult,
  CoreToolCall,
  CoreToolMeta,
  CoreTranscriptItem,
  CoreLoopLimits,
} from "./types";

/** 当前 turn 的模型 Step 的持久状态（物化自 findModelStep + storedTurnResult）。 */
export type CoreModelStepState =
  | { phase: "absent" }
  | { phase: "dispatched" }
  | { phase: "committed"; result: CoreModelResult }
  | { phase: "uncertain" };

/** 某个 tool_call 在持久层的回填状态（物化自已落库的 toolResults）。 */
export interface CorePersistedToolCall {
  callId: string;
  recorded: boolean;
}

/** 审批的持久状态（物化自 approvalService.get），仅当上一步产出了 approvalId 时存在。 */
export type CoreApprovalState =
  | { present: false }
  | { present: true; status: "pending" | "approved" | "denied" | "expired" | "consumed" };

/**
 * 完全物化快照。reducer 只看这个，不看别的。
 * shell 负责在每次循环开始时，从最新持久状态把这些字段全部填好。
 */
export interface LoopSnapshot {
  /** 已落库、可作为下一轮模型输入的对话轨迹（来自 buildTranscript）。 */
  transcript: readonly CoreTranscriptItem[];
  /** 当前 turn 序号（与 createModelStep(runId, turn) 的 turn 一致）。 */
  turn: number;
  /** 已持久化的工具调用累计数（来自 countPersistedToolCalls）。 */
  persistedToolCallsUsed: number;
  /** 当前 turn 模型 Step 的持久状态。 */
  modelStep: CoreModelStepState;
  /** 若模型请求了工具，各 call 的持久回填状态。 */
  persistedToolCalls: readonly CorePersistedToolCall[];
  /** 审批持久状态（用于 approvalId 分支）。 */
  approval: CoreApprovalState;
  /** 取消是否已被请求（物化自 run 状态）。 */
  cancellationRequested: boolean;
  /** 本次可见工具的元数据表（name → meta），reducer 用它分类工具风险。 */
  toolMeta: Readonly<Record<string, CoreToolMeta>>;
  /** 上限配置。 */
  limits: CoreLoopLimits;
}
