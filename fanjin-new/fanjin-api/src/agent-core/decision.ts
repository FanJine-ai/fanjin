/**
 * Decision：decideNext 的唯一输出。告诉 shell「下一步落库执行什么」。
 * 每个 Decision 对应 process() 里一个副作用落点，但 Decision 本身不含副作用。
 */
import type { CoreContentPart, CoreToolCall } from "./types";

/** reducer 输出的决策联合类型 */
export type Decision =
  /** 该派发一轮模型（对应 createModelStep + executeModelTurn）。 */
  | { kind: "dispatch_model"; turn: number }
  /** 该执行这些工具调用（对应 gateway.execute + recordToolResults）。 */
  | { kind: "execute_tools"; calls: readonly CoreToolCall[] }
  /** 该为某工具暂停等审批（对应 pauseForApproval）。 */
  | { kind: "pause_for_approval"; call: CoreToolCall }
  /** 该启动委派（对应 delegationCoordinator.start）。 */
  | { kind: "start_delegation"; call: CoreToolCall }
  /** 审批被拒，记录拒绝结果后继续（对应 denied 分支）。 */
  | { kind: "record_denied_approval"; approvalId: string }
  /** 模型给了终稿，成功收尾（对应 finalize 成功）。 */
  | { kind: "finalize_succeeded"; content: readonly CoreContentPart[] }
  /** 达到上限，正常收尾（exhausted，不是 error）。 */
  | { kind: "finalize_exhausted"; reason: "max_turns" | "max_tool_calls" }
  /** 模型结果不确定，禁止自动重试（对应 markModelUncertain）。 */
  | { kind: "halt_uncertain" }
  /** 取消已请求，在边界处停（对应 stopAtBoundary → cancelled）。 */
  | { kind: "halt_cancelled" };
