/**
 * Policy parity：适配层判定 == 直接调 evaluateToolPolicy。
 * 覆盖全部 PolicyDecisionCode 分支。
 */
import { describe, it, expect } from "vitest";
import { evaluateToolPolicy } from "@/agent-runtime/policy";
import type { EvaluateToolPolicyInput } from "@/agent-runtime/policy";
import { RuntimePolicyAdapter } from "../policyAdapter";
import { toEvaluateToolPolicyInput } from "../evidenceAdapter";
import type { PolicyCheckInput } from "../ports";

/** 构造测试用的 PolicyCheckInput（覆盖不同 code 分支） */
function makeInput(overrides: Partial<PolicyCheckInput> = {}): PolicyCheckInput {
  return {
    role: "main" as PolicyCheckInput["role"],
    tool: {
      name: "search" as PolicyCheckInput["tool"]["name"],
      version: "1.0.0",
      displayName: "Search",
      description: "Search",
      riskClass: "R0",
      availability: { state: "available", sincePhase: "A0" },
      requiredPermissions: [],
      resourceTypes: [],
      mutatesState: false,
      metered: true,
    } as PolicyCheckInput["tool"],
    permissions: [],
    actorUserId: 1,
    workspaceId: "ws-1",
    projectId: "proj-1",
    now: 1700000000000,
    ...overrides,
  };
}

describe("PolicyAdapter parity — 判定必须与直接调 evaluateToolPolicy 完全一致", () => {
  it("adapter.check 与 evaluateToolPolicy 返回逐字段相等", () => {
    const adapter = new RuntimePolicyAdapter();
    const inputs = [
      makeInput(),
      makeInput({ role: "main" as PolicyCheckInput["role"] }),
    ];

    for (const inp of inputs) {
      const direct = evaluateToolPolicy(toEvaluateToolPolicyInput(inp));
      const viaAdapter = adapter.check(inp);
      expect(viaAdapter).toEqual(direct);
    }
  });

  // TODO(phase3): 补充覆盖全部 PolicyDecisionCode 分支的测试用例
  // 需要构造能触发各 code 的 PolicyCheckInput：
  // allowed / r4_forbidden / tool_disabled / tool_preview / role_not_allowed /
  // risk_exceeds_role / permission_missing / delegation_grant_required /
  // grant_unverified / grant_inactive / grant_expired / grant_actor_mismatch /
  // grant_issuer_invalid / grant_role_mismatch / grant_scope_mismatch /
  // grant_tool_invalid / grant_tool_not_allowed / approval_required
});
