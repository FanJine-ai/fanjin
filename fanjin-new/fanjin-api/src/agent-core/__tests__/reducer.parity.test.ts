/**
 * Phase 2 parity：逐快照重放真实 Run 决策。
 * golden-step 数据来自 fixtures/golden-steps/*.json（脱敏后的真实 Run 逐步轨迹）。
 *
 * ⚠️ golden-step fixture 需要从现有 toolLoopProcessor 的集成测试场景导出。
 * 导出脚本：scripts/export-loop-golden.ts（需 Claude 先设计提取方案后生成）。
 */
import { describe, it, expect } from "vitest";
import { decideNext } from "../reducer";
import type { LoopSnapshot } from "../snapshot";
import type { Decision } from "../decision";

/** golden step：真实 Run 在某一步的「输入快照 + 实际发生的决策」。 */
interface GoldenStep {
  name: string;
  snapshot: LoopSnapshot;
  expectedDecision: Decision;
}

/** 从 fixtures 加载 golden steps（待 Claude 设计提取方案后填充）。 */
function loadGoldenSteps(): GoldenStep[] {
  // TODO(phase2): 从 fixtures/golden-steps/*.json 加载
  // 覆盖场景：纯文本 final / 1 工具 / 2 工具连续 / 撞 maxTurns / 审批暂停
  return [];
}

describe("decideNext parity — 逐快照重放真实 Run 决策", () => {
  it("每个 golden step：core 决策 == 真实决策", () => {
    const steps = loadGoldenSteps();
    for (const s of steps) {
      expect(decideNext(s.snapshot)).toEqual(s.expectedDecision);
    }
  });

  // 以下为手构边界场景（不依赖 golden fixture）

  it("turn 达上限 → finalize_exhausted(max_turns)", () => {
    const snapshot: LoopSnapshot = {
      transcript: [],
      turn: 4,
      persistedToolCallsUsed: 0,
      modelStep: { phase: "absent" },
      persistedToolCalls: [],
      approval: { present: false },
      cancellationRequested: false,
      toolMeta: {},
      limits: { maxTurns: 4, maxToolCalls: 8, maxArgumentBytes: 32768, maxResultBytes: 65536, maxFinalTextBytes: 65536 },
    };
    expect(decideNext(snapshot)).toEqual({ kind: "finalize_exhausted", reason: "max_turns" });
  });

  it("model final → finalize_succeeded，且不产出 execute_tools", () => {
    const snapshot: LoopSnapshot = {
      transcript: [],
      turn: 1,
      persistedToolCallsUsed: 0,
      modelStep: { phase: "committed", result: { kind: "final", content: [{ type: "text", text: "done" }] } },
      persistedToolCalls: [],
      approval: { present: false },
      cancellationRequested: false,
      toolMeta: {},
      limits: { maxTurns: 4, maxToolCalls: 8, maxArgumentBytes: 32768, maxResultBytes: 65536, maxFinalTextBytes: 65536 },
    };
    const decision = decideNext(snapshot);
    expect(decision.kind).toBe("finalize_succeeded");
    expect(decision.kind === "execute_tools").toBe(false);
  });

  it("dispatched 未提交 → halt_uncertain（禁止重试）", () => {
    const snapshot: LoopSnapshot = {
      transcript: [],
      turn: 1,
      persistedToolCallsUsed: 0,
      modelStep: { phase: "dispatched" },
      persistedToolCalls: [],
      approval: { present: false },
      cancellationRequested: false,
      toolMeta: {},
      limits: { maxTurns: 4, maxToolCalls: 8, maxArgumentBytes: 32768, maxResultBytes: 65536, maxFinalTextBytes: 65536 },
    };
    expect(decideNext(snapshot)).toEqual({ kind: "halt_uncertain" });
  });
});
