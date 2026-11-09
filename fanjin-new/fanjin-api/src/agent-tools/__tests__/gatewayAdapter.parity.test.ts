/**
 * GatewayToolAdapter parity：委托结果与直接调 gateway.execute 一致。
 * 用注入的 fake gateway 验证参数派生与结果映射。
 */
import { describe, it, expect, vi } from "vitest";
import { GatewayToolAdapter } from "../gatewayAdapter";
import type { AgentToolGateway, AgentToolGatewayExecuteInput, AgentToolGatewayExecuteResult } from "@/agent-runtime/tools/gateway";

describe("GatewayToolAdapter parity — 委托结果与直接调 gateway 一致", () => {
  it("adapter 传给 gateway 的参数逐字段正确，且结果原样映射", async () => {
    const capturedInputs: AgentToolGatewayExecuteInput[] = [];
    const fakeResult: AgentToolGatewayExecuteResult = { stepId: "step-99", output: { data: "test" }, replayed: false };
    const gw = {
      execute: vi.fn().mockImplementation(async (input: AgentToolGatewayExecuteInput) => {
        capturedInputs.push(input);
        return fakeResult;
      }),
    } as unknown as AgentToolGateway;

    const adapter = new GatewayToolAdapter(gw, {
      runId: "run-42",
      idempotencyKey: "idem-base-42",
      approvalId: "appr-1",
      claimFence: { workerId: "w-7", attempt: 3 },
    });

    const result = await adapter.execute({ id: "call-x", name: "deploy", arguments: { env: "prod" } }, 2);

    // 验证传给 gateway 的参数
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].runId).toBe("run-42");
    expect(capturedInputs[0].toolName).toBe("deploy");
    expect(capturedInputs[0].arguments).toEqual({ env: "prod" });
    expect(capturedInputs[0].approvalId).toBe("appr-1");
    expect(capturedInputs[0].idempotencyKey).toBe("idem-base-42:tool:call-x");
    expect(capturedInputs[0].claimFence).toEqual({ workerId: "w-7", attempt: 3 });

    // 验证结果映射
    expect(result.callId).toBe("call-x");
    expect(result.name).toBe("deploy");
    expect(result.stepId).toBe("step-99");
    expect(result.output).toEqual({ data: "test" });
  });

  it("幂等键组合对齐现有规则", async () => {
    const captured: AgentToolGatewayExecuteInput[] = [];
    const gw = {
      execute: vi.fn().mockImplementation(async (input: AgentToolGatewayExecuteInput) => {
        captured.push(input);
        return { stepId: "s", output: null, replayed: false };
      }),
    } as unknown as AgentToolGateway;

    const adapter = new GatewayToolAdapter(gw, {
      runId: "r1",
      idempotencyKey: "base-key",
    });

    await adapter.execute({ id: "call-abc-123", name: "tool", arguments: {} }, 1);
    expect(captured[0].idempotencyKey).toBe("base-key:tool:call-abc-123");
  });
});
