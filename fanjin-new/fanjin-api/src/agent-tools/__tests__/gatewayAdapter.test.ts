import { describe, it, expect, vi } from "vitest";
import { GatewayToolAdapter } from "../gatewayAdapter";
import type { AgentToolGateway } from "@/agent-runtime/tools/gateway";

/** 构造 fake gateway */
function fakeGateway() {
  return {
    execute: vi.fn().mockResolvedValue({ stepId: "step-1", output: { result: "ok" }, replayed: false }),
  } as unknown as AgentToolGateway;
}

describe("GatewayToolAdapter", () => {
  const ctx = {
    runId: "run-1",
    idempotencyKey: "idem-base",
    approvalId: null,
    claimFence: { workerId: "w-1", attempt: 1 },
  };

  it("execute 委托 gateway.execute 并映射结果", async () => {
    const gw = fakeGateway();
    const adapter = new GatewayToolAdapter(gw, ctx);
    const call = { id: "call-1", name: "search", arguments: { q: "test" } };
    const result = await adapter.execute(call, 1);

    expect(result.callId).toBe("call-1");
    expect(result.name).toBe("search");
    expect(result.stepId).toBe("step-1");
    expect(result.output).toEqual({ result: "ok" });
  });

  it("幂等键派生规则：base + :tool: + callId", async () => {
    const gw = fakeGateway();
    const adapter = new GatewayToolAdapter(gw, ctx);
    await adapter.execute({ id: "call-abc", name: "calc", arguments: {} }, 1);

    expect(gw.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "idem-base:tool:call-abc",
      }),
    );
  });

  it("runId / approvalId / claimFence 正确透传", async () => {
    const gw = fakeGateway();
    const adapter = new GatewayToolAdapter(gw, ctx);
    await adapter.execute({ id: "c1", name: "t", arguments: {} }, 1);

    expect(gw.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        approvalId: null,
        claimFence: { workerId: "w-1", attempt: 1 },
      }),
    );
  });

  it("gateway 抛错时原样上抛", async () => {
    const gw = {
      execute: vi.fn().mockRejectedValue(new Error("gateway failed")),
    } as unknown as AgentToolGateway;
    const adapter = new GatewayToolAdapter(gw, ctx);
    await expect(adapter.execute({ id: "c1", name: "t", arguments: {} }, 1))
      .rejects.toThrow("gateway failed");
  });
});
