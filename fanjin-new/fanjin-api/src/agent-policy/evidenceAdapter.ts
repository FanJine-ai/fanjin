/**
 * 把 shell 物化好的原始字段，映射成现有 evaluateToolPolicy 的 EvaluateToolPolicyInput。
 * 纯函数：无 I/O。所有「从 DB 读证据」的动作发生在 shell，不在这里。
 */
import type { EvaluateToolPolicyInput } from "@/agent-runtime/policy";
import type { PolicyCheckInput } from "./ports";

/**
 * PolicyCheckInput → EvaluateToolPolicyInput 纯映射。
 *
 * 注意：projectId 在 policy.ts 里是 string，在 gateway 里是 number。
 * 本函数接收的 PolicyCheckInput.projectId 统一为 string（与 policy.ts 一致），
 * 直接透传，无需转换。
 */
export function toEvaluateToolPolicyInput(input: PolicyCheckInput): EvaluateToolPolicyInput {
  return {
    role: input.role,
    tool: input.tool,
    permissions: input.permissions,
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    grant: input.grant,
    grantVerified: input.grantVerified,
    approval: input.approval,
    approvalVerificationMode: input.approvalVerificationMode,
    callScopeHash: input.callScopeHash,
    now: input.now,
  };
}
