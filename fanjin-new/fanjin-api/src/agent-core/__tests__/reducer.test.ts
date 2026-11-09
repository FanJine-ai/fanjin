import { describe, it, expect } from "vitest";
import { decideNext } from "../reducer";
import type { LoopSnapshot } from "../snapshot";
import type { CoreToolCall, CoreToolMeta, CoreLoopLimits } from "../types";

/** 构造默认 limits */
const limits: CoreLoopLimits = {
  maxTurns: 4,
  maxToolCalls: 8,
  maxArgumentBytes: 32_768,
  maxResultBytes: 65_536,
  maxFinalTextBytes: 65_536,
};

/** 构造默认空快照 */
function baseSnapshot(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    transcript: [],
    turn: 1,
    persistedToolCallsUsed: 0,
    modelStep: { phase: "absent" },
    persistedToolCalls: [],
    approval: { present: false },
    cancellationRequested: false,
    toolMeta: {},
    limits,
    ...overrides,
  };
}

/** 快捷构造工具元数据 */
function toolMeta(entries: Array<{ name: string; riskClass: CoreToolMeta["riskClass"]; mutatesState?: boolean; metered?: boolean }>): Record<string, CoreToolMeta> {
  const map: Record<string, CoreToolMeta> = {};
  for (const e of entries) {
    map[e.name] = {
      name: e.name,
      riskClass: e.riskClass,
      mutatesState: e.mutatesState ?? false,
      metered: e.metered ?? false,
    };
  }
  return map;
}

describe("decideNext", () => {
  // ── 不变式 1：取消优先 ──
  describe("不变式 1：cancellationRequested → halt_cancelled", () => {
    it("即使 modelStep 是 final，取消也优先", () => {
      const snap = baseSnapshot({
        cancellationRequested: true,
        modelStep: { phase: "committed", result: { kind: "final", content: [{ type: "text", text: "done" }] } },
      });
      expect(decideNext(snap)).toEqual({ kind: "halt_cancelled" });
    });

    it("即使 modelStep 是 tool_calls，取消也优先", () => {
      const snap = baseSnapshot({
        cancellationRequested: true,
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [{ id: "c1", name: "search", arguments: {} }] } },
      });
      expect(decideNext(snap)).toEqual({ kind: "halt_cancelled" });
    });
  });

  // ── 不变式 2：uncertain / dispatched 硬点 ──
  describe("不变式 2：uncertain / dispatched → halt_uncertain", () => {
    it("uncertain → halt_uncertain", () => {
      const snap = baseSnapshot({ modelStep: { phase: "uncertain" } });
      expect(decideNext(snap)).toEqual({ kind: "halt_uncertain" });
    });

    it("dispatched → halt_uncertain（禁止自动重试）", () => {
      const snap = baseSnapshot({ modelStep: { phase: "dispatched" } });
      expect(decideNext(snap)).toEqual({ kind: "halt_uncertain" });
    });
  });

  // ── 不变式 3：turn 上限 ──
  describe("不变式 3：turn >= maxTurns → finalize_exhausted(max_turns)", () => {
    it("turn 恰好等于 maxTurns → exhausted", () => {
      const snap = baseSnapshot({ turn: 4, modelStep: { phase: "absent" } });
      expect(decideNext(snap)).toEqual({ kind: "finalize_exhausted", reason: "max_turns" });
    });

    it("turn 超过 maxTurns → exhausted", () => {
      const snap = baseSnapshot({ turn: 10, modelStep: { phase: "absent" } });
      expect(decideNext(snap)).toEqual({ kind: "finalize_exhausted", reason: "max_turns" });
    });

    it("turn < maxTurns → dispatch_model", () => {
      const snap = baseSnapshot({ turn: 1, modelStep: { phase: "absent" } });
      expect(decideNext(snap)).toEqual({ kind: "dispatch_model", turn: 1 });
    });
  });

  // ── 不变式 4：工具上限 ──
  describe("不变式 4：toolCalls 超限 → finalize_exhausted(max_tool_calls)", () => {
    it("恰好超限 → exhausted", () => {
      const calls: CoreToolCall[] = [
        { id: "c1", name: "search", arguments: {} },
        { id: "c2", name: "calc", arguments: {} },
      ];
      const snap = baseSnapshot({
        persistedToolCallsUsed: 7,
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls } },
      });
      // 7 + 2 = 9 > 8
      expect(decideNext(snap)).toEqual({ kind: "finalize_exhausted", reason: "max_tool_calls" });
    });

    it("恰好不超限 → 正常执行", () => {
      const calls: CoreToolCall[] = [{ id: "c1", name: "search", arguments: {} }];
      const snap = baseSnapshot({
        persistedToolCallsUsed: 7,
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls } },
        toolMeta: toolMeta([{ name: "search", riskClass: "R0" }]),
      });
      // 7 + 1 = 8 == maxToolCalls，不超限
      expect(decideNext(snap)).toEqual({ kind: "execute_tools", calls });
    });
  });

  // ── 不变式 5：final 即停 ──
  describe("不变式 5：model final → finalize_succeeded", () => {
    it("final 内容正确传递", () => {
      const content = [{ type: "text", text: "答案" }];
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "final", content } },
      });
      expect(decideNext(snap)).toEqual({ kind: "finalize_succeeded", content });
    });
  });

  // ── 不变式 6：tool_calls 分类 ──
  describe("不变式 6：tool_calls 按风险分类", () => {
    it("R0 普通工具 → execute_tools", () => {
      const calls: CoreToolCall[] = [{ id: "c1", name: "search", arguments: {} }];
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls } },
        toolMeta: toolMeta([{ name: "search", riskClass: "R0" }]),
      });
      expect(decideNext(snap)).toEqual({ kind: "execute_tools", calls });
    });

    it("R1 普通工具 → execute_tools", () => {
      const calls: CoreToolCall[] = [{ id: "c1", name: "code_exec", arguments: {} }];
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls } },
        toolMeta: toolMeta([{ name: "code_exec", riskClass: "R1" }]),
      });
      expect(decideNext(snap)).toEqual({ kind: "execute_tools", calls });
    });

    it("R2 工具无审批 → pause_for_approval", () => {
      const call: CoreToolCall = { id: "c1", name: "deploy", arguments: {} };
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [call] } },
        toolMeta: toolMeta([{ name: "deploy", riskClass: "R2", mutatesState: true }]),
        approval: { present: false },
      });
      expect(decideNext(snap)).toEqual({ kind: "pause_for_approval", call });
    });

    it("R3 工具无审批 → pause_for_approval", () => {
      const call: CoreToolCall = { id: "c1", name: "delete_data", arguments: {} };
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [call] } },
        toolMeta: toolMeta([{ name: "delete_data", riskClass: "R3", mutatesState: true }]),
        approval: { present: false },
      });
      expect(decideNext(snap)).toEqual({ kind: "pause_for_approval", call });
    });

    it("委派调用 → start_delegation", () => {
      const call: CoreToolCall = { id: "c1", name: "agent.delegate", arguments: { task: "research" } };
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [call] } },
        toolMeta: toolMeta([{ name: "agent.delegate", riskClass: "R1", mutatesState: true }]),
      });
      expect(decideNext(snap)).toEqual({ kind: "start_delegation", call });
    });

    it("混合风险：R2 + R0 → R2 先暂停（pause_for_approval）", () => {
      const callR2: CoreToolCall = { id: "c1", name: "deploy", arguments: {} };
      const callR0: CoreToolCall = { id: "c2", name: "search", arguments: {} };
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [callR2, callR0] } },
        toolMeta: toolMeta([
          { name: "deploy", riskClass: "R2", mutatesState: true },
          { name: "search", riskClass: "R0" },
        ]),
      });
      // R2 先被发现，返回 pause_for_approval
      expect(decideNext(snap)).toEqual({ kind: "pause_for_approval", call: callR2 });
    });

    it("无 toolMeta 信息的工具 → execute_tools（默认 R0）", () => {
      const calls: CoreToolCall[] = [{ id: "c1", name: "unknown_tool", arguments: {} }];
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls } },
        toolMeta: {},
      });
      expect(decideNext(snap)).toEqual({ kind: "execute_tools", calls });
    });
  });

  // ── 不变式 7：审批分支 ──
  describe("不变式 7：审批状态分支", () => {
    const call: CoreToolCall = { id: "c1", name: "deploy", arguments: {} };
    const meta = toolMeta([{ name: "deploy", riskClass: "R2", mutatesState: true }]);

    it("approved → execute_tools", () => {
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [call] } },
        toolMeta: meta,
        approval: { present: true, status: "approved" },
      });
      expect(decideNext(snap)).toEqual({ kind: "execute_tools", calls: [call] });
    });

    it("consumed → execute_tools", () => {
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [call] } },
        toolMeta: meta,
        approval: { present: true, status: "consumed" },
      });
      expect(decideNext(snap)).toEqual({ kind: "execute_tools", calls: [call] });
    });

    it("denied → record_denied_approval", () => {
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [call] } },
        toolMeta: meta,
        approval: { present: true, status: "denied" },
      });
      expect(decideNext(snap)).toEqual({ kind: "record_denied_approval", approvalId: "" });
    });

    it("expired → halt_uncertain", () => {
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [call] } },
        toolMeta: meta,
        approval: { present: true, status: "expired" },
      });
      expect(decideNext(snap)).toEqual({ kind: "halt_uncertain" });
    });

    it("pending → pause_for_approval", () => {
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "tool_calls", calls: [call] } },
        toolMeta: meta,
        approval: { present: true, status: "pending" },
      });
      expect(decideNext(snap)).toEqual({ kind: "pause_for_approval", call });
    });
  });

  // ── 不变式 8：turn 语义 ──
  describe("不变式 8：reducer 不自增 turn", () => {
    it("turn=1 dispatch_model 输出 turn=1（不 +1）", () => {
      const snap = baseSnapshot({ turn: 1, modelStep: { phase: "absent" } });
      expect(decideNext(snap)).toEqual({ kind: "dispatch_model", turn: 1 });
    });

    it("turn=3 dispatch_model 输出 turn=3", () => {
      const snap = baseSnapshot({ turn: 3, modelStep: { phase: "absent" } });
      expect(decideNext(snap)).toEqual({ kind: "dispatch_model", turn: 3 });
    });
  });

  // ── 不变式 9：纯粹性（编译期由 CI 守卫保证，运行时验证无副作用）──
  describe("不变式 9：纯函数", () => {
    it("同一 snapshot 多次调用返回同一 Decision", () => {
      const snap = baseSnapshot({
        modelStep: { phase: "committed", result: { kind: "final", content: [{ type: "text", text: "ok" }] } },
      });
      const r1 = decideNext(snap);
      const r2 = decideNext(snap);
      const r3 = decideNext(snap);
      expect(r1).toEqual(r2);
      expect(r2).toEqual(r3);
    });
  });

  // ── 不变式 10：读回驱动（snapshot 是唯一输入）──
  describe("不变式 10：只依赖 snapshot", () => {
    it("absent + turn=1 + 无审批 → dispatch_model", () => {
      expect(decideNext(baseSnapshot({ turn: 1 }))).toEqual({ kind: "dispatch_model", turn: 1 });
    });

    it("committed final → finalize_succeeded（不管 transcript 长度）", () => {
      const content = [{ type: "text", text: "done" }];
      const snap = baseSnapshot({
        transcript: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", text: "thinking", toolCalls: [] },
          { role: "tool", callId: "c1", name: "search", output: "data" },
        ],
        modelStep: { phase: "committed", result: { kind: "final", content } },
      });
      expect(decideNext(snap)).toEqual({ kind: "finalize_succeeded", content });
    });
  });
});
