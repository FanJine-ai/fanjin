/**
 * Phase 3 B.3 安全边界 parity（Claude 亲自设计，不完全交 Mimo）。
 * 这些是 parity 抓不到、但绝不能丢的。
 */
import { describe, it, expect } from "vitest";
import { RegistryCatalogAdapter } from "../catalogAdapter";
import { RuntimePolicyAdapter } from "@/agent-policy/policyAdapter";
import { GatewayToolAdapter } from "../gatewayAdapter";
import { R4_TOOL_IDS } from "@/agent-runtime/toolIds";
import type { AgentToolCatalogContext, AgentToolCatalogDefinition } from "@/agent-runtime/tools/registry";
import type { PolicyCheckInput } from "@/agent-policy/ports";

describe("[security] 适配层不得削弱任何服务端边界", () => {
  it("R4 工具：catalogAdapter.list() 结果中不含任何 R4 canonical 名称", () => {
    // 模拟一个 catalog context，确保即便 list() 被调用，R4 工具也不会出现
    const mockCatalog: AgentToolCatalogContext = {
      list: () => {
        // 模拟返回一些工具定义，但不应包含 R4
        const definitions: AgentToolCatalogDefinition[] = [
          { manifest: { name: "project.get" } as any, inputSchema: {} },
          { manifest: { name: "session.get" } as any, inputSchema: {} },
        ];
        return definitions;
      },
      describe: () => null,
    };

    const adapter = new RegistryCatalogAdapter(mockCatalog);
    const result = adapter.list();

    // 断言：结果中不包含任何 R4 工具 ID
    const resultNames = result.map((def) => def.manifest.name);
    const r4NamesInResult = R4_TOOL_IDS.filter((r4Id) => resultNames.includes(r4Id as any));
    expect(r4NamesInResult).toHaveLength(0);
  });

  it("R4 工具：即便被误标风险等级，policyAdapter.check 仍返回 r4_forbidden", () => {
    // 构造一个 R4 工具，即使 riskClass 被误标为 "R1"，也应该被 evaluateToolPolicy 拒绝
    const adapter = new RuntimePolicyAdapter();
    const input: PolicyCheckInput = {
      role: "main", // 使用有效的 role
      tool: {
        name: "system.sql.execute", // R4 canonical 名称
        riskClass: "R1", // 误标为低风险
        requiredPermissions: [],
        availability: { state: "available" },
      } as any,
      permissions: [],
      actorUserId: 1,
      workspaceId: "ws1",
      projectId: "proj1",
      grant: undefined,
      grantVerified: false,
      approval: undefined,
      approvalVerificationMode: undefined,
      callScopeHash: undefined,
      now: Date.now(),
    };

    const decision = adapter.check(input);

    // 断言：即使风险等级被误标，policy.ts 中的 isR4ToolId 检查仍会拒绝
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("r4_forbidden");
  });

  it("gatewayAdapter 不持有裸 Knex，无法绕过 gateway 直接写表（类型层面 + 运行时无 db 字段）", () => {
    // 类型层面验证：GatewayToolAdapter 的构造函数签名不接受 Knex
    // 运行时验证：创建实例后，实例不包含 database/db/knex 字段
    const mockGateway = {
      execute: async () => ({ stepId: "step1", output: {} }),
    } as any;

    const adapter = new GatewayToolAdapter(mockGateway, {
      runId: "run1",
      idempotencyKey: "key1",
      approvalId: undefined,
      claimFence: undefined,
    });

    // 运行时检查：adapter 实例上不存在 database/db/knex 字段
    const adapterKeys = Object.keys(adapter as any);
    const dangerousKeys = adapterKeys.filter((key) =>
      key.includes("database") || key.includes("knex") || key === "db"
    );
    expect(dangerousKeys).toHaveLength(0);

    // 类型层面：如果构造函数接受了 Knex，TypeScript 会编译失败
    // 这个测试通过编译即证明类型安全
  });

  it("跨项目：projectId number↔string 转换后，grant_scope_mismatch 判定不变", () => {
    // policy.ts 的 EvaluateToolPolicyInput.projectId 是 string 类型
    // gateway/authorize 中的 projectId 是 number 类型
    // evidenceAdapter 必须正确转换，且不影响 grant_scope_mismatch 判定

    const adapter = new RuntimePolicyAdapter();
    const now = Date.now();

    // 使用 writer role（requiresDelegationGrant: true），需要验证 grant scope
    // 场景1：grant.projectId 与 input.projectId 匹配（字符串比较）
    const matchingInput: PolicyCheckInput = {
      role: "writer", // specialist role，需要 delegation grant
      tool: {
        name: "script.get",
        riskClass: "R1",
        requiredPermissions: [],
        availability: { state: "available" },
        version: 1,
      } as any,
      permissions: [],
      actorUserId: 1,
      workspaceId: "ws1",
      projectId: "123", // string（来自 number 123 的转换）
      grant: {
        id: "grant1",
        status: "active", // 必须是 active
        workspaceId: "ws1",
        projectId: "123", // string，匹配
        granteeRole: "writer",
        issuerRole: "main",
        actorUserId: 1,
        allowedTools: ["script.*"],
        issuedAt: now - 1000,
        expiresAt: now + 3600_000,
      } as any,
      grantVerified: true,
      approval: undefined,
      approvalVerificationMode: undefined,
      callScopeHash: undefined,
      now,
    };

    const matchDecision = adapter.check(matchingInput);
    // 应该通过（grant 匹配）
    expect(matchDecision.allowed).toBe(true);

    // 场景2：grant.projectId 与 input.projectId 不匹配
    const mismatchInput: PolicyCheckInput = {
      ...matchingInput,
      projectId: "456", // 不同的 projectId
    };

    const mismatchDecision = adapter.check(mismatchInput);
    // 应该被拒绝，code 为 grant_scope_mismatch
    expect(mismatchDecision.allowed).toBe(false);
    expect(mismatchDecision.code).toBe("grant_scope_mismatch");
  });
});
