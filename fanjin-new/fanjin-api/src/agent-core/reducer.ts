/**
 * decideNext：core 唯一的决策函数。纯函数。
 * 输入完全物化的 LoopSnapshot，输出一个 Decision。
 * 无 I/O、无事务、无 Date.now、无 Math.random。
 *
 * 判定优先级严格对齐 toolLoopProcessor.process()（712-1090 行）：
 *   取消 > uncertain/dispatched > 上限 > final > tool_calls 分类 > 审批分支
 */
import type { LoopSnapshot } from "./snapshot";
import type { Decision } from "./decision";
import type { CoreToolCall, CoreToolMeta } from "./types";

/** 判定工具是否为委派类调用（agent.delegate）。 */
function isDelegationCall(call: CoreToolCall): boolean {
  return call.name === "agent.delegate";
}

/**
 * 对 tool_calls 里的单个 call 按风险分类，产出对应的 Decision。
 * R2/R3 且无审批 → pause_for_approval
 * 委派类 → start_delegation
 * R0/R1 普通 → execute_tools
 *
 * 注意：真实 process() 对「一批 calls 里混合风险」的处理是按顺序逐个分类。
 * 高风险 call 需要先暂停，普通的才执行。这里按相同逻辑处理。
 */
function classifyToolCalls(
  calls: readonly CoreToolCall[],
  toolMeta: Readonly<Record<string, CoreToolMeta>>,
  approval: { present: boolean; status?: string },
): Decision {
  // 真实 process()：R2/R3 单独审批、委派类单独处理、R0/R1 批量执行
  // 按优先级逐个检查 call
  for (const call of calls) {
    const meta = toolMeta[call.name];

    // 委派类调用
    if (isDelegationCall(call)) {
      return { kind: "start_delegation", call };
    }

    // R2/R3 需要审批
    if (meta && (meta.riskClass === "R2" || meta.riskClass === "R3")) {
      // 若已有审批状态，按 status 处理
      if (approval.present) {
        // 已 approved/consumed → 继续执行（不 return，走到底部 execute_tools）
        if (approval.status === "approved" || approval.status === "consumed") {
          continue;
        }
        // denied → record_denied_approval
        if (approval.status === "denied") {
          return { kind: "record_denied_approval", approvalId: "" };
        }
        // expired → halt（真实代码可能重新报价，这里先 halt）
        if (approval.status === "expired") {
          return { kind: "halt_uncertain" };
        }
        // pending → pause
        return { kind: "pause_for_approval", call };
      }
      // 无审批 → 需要暂停等审批
      return { kind: "pause_for_approval", call };
    }

    // R4 工具：真实代码会在此前就被 policy 拒绝，reducer 不做 R4 判定
    // （R4 判定在 policy 层，不在 reducer）
  }

  // 所有 call 都是 R0/R1 普通工具 → 批量执行
  return { kind: "execute_tools", calls };
}

/**
 * 纯决策函数。同一 snapshot 多次调用返回同一 Decision。
 */
export function decideNext(snapshot: LoopSnapshot): Decision {
  const { modelStep, limits, turn, persistedToolCallsUsed, cancellationRequested, approval } = snapshot;

  // ── 1. 取消优先 ──
  // 来源：process() stopAtBoundary 在多处的前置检查
  if (cancellationRequested) {
    return { kind: "halt_cancelled" };
  }

  // ── 2. uncertain / dispatched 硬点 ──
  // 来源：process() 753-777 行，uncertain 或 dispatched 未提交 → 禁止自动重试
  if (modelStep.phase === "uncertain") {
    return { kind: "halt_uncertain" };
  }
  if (modelStep.phase === "dispatched") {
    return { kind: "halt_uncertain" };
  }

  // ── 3. absent：需要派发模型 ──
  // 来源：process() 741-751 行
  if (modelStep.phase === "absent") {
    if (turn >= limits.maxTurns) {
      return { kind: "finalize_exhausted", reason: "max_turns" };
    }
    return { kind: "dispatch_model", turn };
  }

  // ── 4. committed：读取结果并决策 ──
  // 来源：process() 779-1092 行
  const { result } = modelStep;

  // ── 4a. final → 成功收尾 ──
  // 来源：process() 794-796 行
  if (result.kind === "final") {
    return { kind: "finalize_succeeded", content: result.content };
  }

  // ── 4b. tool_calls → 分类处理 ──
  // 来源：process() 798-1074 行
  const { calls } = result;

  // 工具上限检查
  // 来源：process() 800-805 行
  if (persistedToolCallsUsed + calls.length > limits.maxToolCalls) {
    return { kind: "finalize_exhausted", reason: "max_tool_calls" };
  }

  // 按 toolMeta 分类每个 call
  return classifyToolCalls(calls, snapshot.toolMeta, approval);
}
