/**
 * 把 core 的 ToolPort.execute 委托给现有 AgentToolGateway.execute。
 * 不自造事务、不自造幂等、不自造审批——全部由 gateway 内部完成。
 */
import type { CoreToolCall, CoreToolResult } from "@/agent-core";
import type { AgentToolGateway } from "@/agent-runtime/tools/gateway";
import type { ToolExecutionContext, ToolPort } from "./ports";

/** ToolPort 实现：委托 gateway.execute，幂等键组合对齐现有规则。 */
export class GatewayToolAdapter implements ToolPort {
  constructor(
    private readonly gateway: AgentToolGateway,
    private readonly ctx: ToolExecutionContext,
  ) {}

  async execute(call: CoreToolCall, turn: number): Promise<CoreToolResult> {
    // 幂等键派生：对齐 toolLoopProcessor 的现有规则
    // 现有规则：`${baseIdempotencyKey}:tool:${call.id}`
    const idempotencyKey = `${this.ctx.idempotencyKey}:tool:${call.id}`;
    const result = await this.gateway.execute({
      runId: this.ctx.runId,
      toolName: call.name,
      arguments: call.arguments,
      approvalId: this.ctx.approvalId,
      idempotencyKey,
      claimFence: this.ctx.claimFence,
    });
    return {
      callId: call.id,
      name: call.name,
      stepId: result.stepId,
      output: result.output,
    };
  }
}
