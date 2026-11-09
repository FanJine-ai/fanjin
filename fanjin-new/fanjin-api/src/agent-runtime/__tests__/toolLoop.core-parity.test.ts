/**
 * Phase 4 集成 parity 壳（Phase 2 建壳，Phase 4 填实）。
 * 验证 core-backed processor 与旧 toolLoopProcessor 行为逐字节一致。
 */
import { describe, it } from "vitest";

describe("[Phase4-gate] AgentToolLoopProcessor 接入 core 后 parity", () => {
  it.todo("每一步 shell 用 decideNext 的决策与旧内联判定完全一致");
  it.todo("同输入下 old-processor 与 core-backed-processor 的 Step/Event 序列逐条相等");
  it.todo("同输入下计费 settle 的 token 数完全一致");
  it.todo("审批暂停/恢复路径的 checkpoint 完全一致");
});
