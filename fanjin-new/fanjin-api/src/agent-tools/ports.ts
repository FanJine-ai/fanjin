/**
 * ToolPort / ToolCatalogPort 接口定义。
 * ToolPort 在 agent-core 已定义（execute(call, turn) → CoreToolResult），
 * 这里定义 runtime 侧实现所需的「执行上下文」以及目录端口。
 */
import type { CoreToolCall, CoreToolResult } from "@/agent-core";
import type { AgentToolCatalogDefinition } from "@/agent-runtime/tools/registry";

/** 执行一次工具调用所需的 shell 上下文（由 imperative shell 提供）。 */
export interface ToolExecutionContext {
  /** Run ID。 */
  readonly runId: string;
  /** 幂等键基础（与现有 toolLoopProcessor 的 idempotencyKey 派生对齐）。 */
  readonly idempotencyKey: string;
  /** 审批 ID（若该工具需要审批且已批准）。 */
  readonly approvalId?: string | null;
  /** Worker 声明（lease fencing）。 */
  readonly claimFence?: { workerId: string; attempt: number };
}

/** 角色可见工具目录端口：投影出模型能看到的工具定义（绝不含 R4）。 */
export interface ToolCatalogPort {
  /** 返回当前 Run/角色可发现的工具定义（复用 registry 的 catalog 投影）。 */
  list(): readonly AgentToolCatalogDefinition[];
}

/** 工具执行端口：执行一次工具调用。 */
export interface ToolPort {
  /**
   * 执行一次工具调用，返回 CoreToolResult。
   * 幂等键派生规则必须对齐 toolLoopProcessor 现有实现。
   */
  execute(call: CoreToolCall, turn: number): Promise<CoreToolResult>;
}
