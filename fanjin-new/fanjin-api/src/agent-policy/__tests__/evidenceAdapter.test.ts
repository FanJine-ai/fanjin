import { describe, it, expect } from "vitest";
import { toEvaluateToolPolicyInput } from "../evidenceAdapter";
import type { PolicyCheckInput } from "../ports";
import type { ToolManifest, AgentRole } from "@/agent-runtime/contracts";

const mockTool: ToolManifest = {
  name: "search" as ToolManifest["name"],
  version: "1.0.0",
  displayName: "Search",
  description: "Search the web",
  riskClass: "R0",
  availability: { state: "available", sincePhase: "A0" },
  requiredPermissions: [],
  resourceTypes: [],
  mutatesState: false,
  metered: true,
};

const baseInput: PolicyCheckInput = {
  role: "main" as AgentRole,
  tool: mockTool,
  permissions: ["search.use"],
  actorUserId: 123,
  workspaceId: "ws-1",
  projectId: "proj-456",
  now: 1700000000000,
};

describe("toEvaluateToolPolicyInput", () => {
  it("基本字段映射正确", () => {
    const result = toEvaluateToolPolicyInput(baseInput);
    expect(result.role).toBe("main");
    expect(result.tool).toBe(mockTool);
    expect(result.permissions).toEqual(["search.use"]);
    expect(result.actorUserId).toBe(123);
    expect(result.workspaceId).toBe("ws-1");
    expect(result.projectId).toBe("proj-456");
    expect(result.now).toBe(1700000000000);
  });

  it("projectId 直接透传（string → string，无需转换）", () => {
    const result = toEvaluateToolPolicyInput(baseInput);
    expect(result.projectId).toBe("proj-456");
    expect(typeof result.projectId).toBe("string");
  });

  it("可选字段透传", () => {
    const withOptionals: PolicyCheckInput = {
      ...baseInput,
      grant: { id: "g1" } as PolicyCheckInput["grant"],
      grantVerified: true,
      approval: { id: "a1" } as PolicyCheckInput["approval"],
      approvalVerificationMode: "approved_execution",
      callScopeHash: "hash123",
    };
    const result = toEvaluateToolPolicyInput(withOptionals);
    expect(result.grant).toEqual({ id: "g1" });
    expect(result.grantVerified).toBe(true);
    expect(result.approval).toEqual({ id: "a1" });
    expect(result.approvalVerificationMode).toBe("approved_execution");
    expect(result.callScopeHash).toBe("hash123");
  });

  it("未传可选字段为 undefined", () => {
    const result = toEvaluateToolPolicyInput(baseInput);
    expect(result.grant).toBeUndefined();
    expect(result.grantVerified).toBeUndefined();
    expect(result.approval).toBeUndefined();
    expect(result.approvalVerificationMode).toBeUndefined();
    expect(result.callScopeHash).toBeUndefined();
  });
});
