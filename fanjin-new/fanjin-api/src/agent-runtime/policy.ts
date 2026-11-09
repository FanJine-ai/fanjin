import {
  AgentRole,
  ApprovalEvidence,
  DelegationGrant,
  RiskClass,
  RolePolicy,
  ToolManifest,
} from "@/agent-runtime/contracts";
import { DEFAULT_ROLE_POLICIES } from "@/agent-runtime/defaultRolePolicies";
import {
  isR4ToolId,
  isToolId,
  isToolSelector,
  matchesToolSelector,
} from "@/agent-runtime/toolIds";
import { hasExactAgentRuntimePermission } from "@/middleware/permissions";

export { matchesToolSelector } from "@/agent-runtime/toolIds";

const riskRank: Readonly<Record<RiskClass, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

export type PolicyDecisionCode =
  | "allowed"
  | "tool_id_invalid"
  | "tool_disabled"
  | "tool_preview"
  | "r4_forbidden"
  | "role_not_allowed"
  | "risk_exceeds_role"
  | "permission_missing"
  | "delegation_grant_required"
  | "grant_unverified"
  | "grant_inactive"
  | "grant_expired"
  | "grant_actor_mismatch"
  | "grant_issuer_invalid"
  | "grant_role_mismatch"
  | "grant_scope_mismatch"
  | "grant_tool_invalid"
  | "grant_tool_not_allowed"
  | "approval_required";

export interface PolicyDecision {
  allowed: boolean;
  code: PolicyDecisionCode;
  reason: string;
  requiresApproval: boolean;
}

export interface EvaluateToolPolicyInput {
  role: AgentRole;
  tool: ToolManifest;
  permissions: readonly string[];
  actorUserId: number;
  workspaceId: string;
  projectId: string;
  grant?: DelegationGrant;
  grantVerified?: boolean;
  approval?: ApprovalEvidence;
  approvalVerificationMode?: "approved_execution" | "exact_consumed_replay";
  callScopeHash?: string;
  now?: number;
}

function denied(reason: string, code: Exclude<PolicyDecisionCode, "allowed">, requiresApproval = false): PolicyDecision {
  return { allowed: false, code, reason, requiresApproval };
}

function grantDecision(input: EvaluateToolPolicyInput, rolePolicy: RolePolicy, now: number): PolicyDecision | null {
  if (!rolePolicy.requiresDelegationGrant) return null;
  const grant = input.grant;
  if (!grant) return denied("该 Agent 角色必须持有服务端签发的 DelegationGrant。", "delegation_grant_required");
  if (input.grantVerified !== true) {
    return denied("DelegationGrant 尚未通过服务端签名与持久化状态校验。", "grant_unverified");
  }
  if (grant.status !== "active") return denied("DelegationGrant 当前不可用。", "grant_inactive");
  if (grant.issuedAt > now || (grant.revokedAt !== undefined && grant.revokedAt <= now)) {
    return denied("DelegationGrant 尚未生效或已被撤销。", "grant_inactive");
  }
  if (grant.expiresAt <= now) return denied("DelegationGrant 已过期。", "grant_expired");
  if (grant.actorUserId !== input.actorUserId) {
    return denied("DelegationGrant 不属于当前用户。", "grant_actor_mismatch");
  }
  if (grant.issuerRole !== "main") {
    return denied("DelegationGrant 必须由主 Agent 签发。", "grant_issuer_invalid");
  }
  if (grant.granteeRole !== input.role) return denied("DelegationGrant 与当前 Agent 角色不匹配。", "grant_role_mismatch");
  if (grant.workspaceId !== input.workspaceId || grant.projectId !== input.projectId) {
    return denied("DelegationGrant 不属于当前工作区或项目。", "grant_scope_mismatch");
  }
  if (!grant.allowedTools.every((selector) => isToolSelector(selector))) {
    return denied("DelegationGrant 包含未知 namespace、旧别名或无匹配项的 ToolSelector。", "grant_tool_invalid");
  }
  if (!grant.allowedTools.some((selector) => matchesToolSelector(input.tool.name, selector))) {
    return denied("DelegationGrant 未授权该工具。", "grant_tool_not_allowed");
  }
  return null;
}

function hasValidApproval(input: EvaluateToolPolicyInput, now: number): boolean {
  const approval = input.approval;
  if (!approval) return false;
  const exactConsumedReplay = approval.status === "consumed"
    && input.approvalVerificationMode === "exact_consumed_replay";
  const approvedExecution = approval.status === "approved"
    && input.approvalVerificationMode !== "exact_consumed_replay";
  if (!exactConsumedReplay && !approvedExecution) return false;
  if (approvedExecution && approval.expiresAt <= now) return false;
  if (!isToolId(approval.toolName)) return false;
  if (approval.workspaceId !== input.workspaceId || approval.projectId !== input.projectId) return false;
  if (!input.callScopeHash || approval.scopeHash !== input.callScopeHash) return false;
  if (approval.toolName !== input.tool.name || approval.toolVersion !== input.tool.version) return false;
  if (input.grant?.approval) {
    if (input.grant.approval.approvalId !== approval.id) return false;
    if (input.grant.approval.scopeHash !== approval.scopeHash) return false;
    if (input.grant.approval.policyVersion !== approval.policyVersion) return false;
  }
  return true;
}

export function evaluateToolPolicy(input: EvaluateToolPolicyInput): PolicyDecision {
  const { tool } = input;
  const now = input.now ?? Date.now();
  const rolePolicy = DEFAULT_ROLE_POLICIES[input.role];

  if (!isToolId(tool.name)) {
    return denied("工具名不是已冻结的 canonical ToolId。", "tool_id_invalid");
  }
  if (isR4ToolId(tool.name) || tool.riskClass === "R4") {
    return denied("R4 特权系统能力永不向 Agent 开放。", "r4_forbidden");
  }
  if (tool.availability.state === "disabled") {
    return denied(tool.availability.reason, "tool_disabled");
  }
  if (tool.availability.state === "preview") {
    return denied(tool.availability.reason, "tool_preview");
  }
  if (rolePolicy.deniedTools.some((selector) => matchesToolSelector(tool.name, selector))) {
    return denied("当前 Agent 角色明确禁止使用该工具。", "role_not_allowed");
  }
  if (!rolePolicy.allowedTools.some((selector) => matchesToolSelector(tool.name, selector))) {
    return denied("当前 Agent 角色未获准使用该工具。", "role_not_allowed");
  }
  if (riskRank[tool.riskClass] > riskRank[rolePolicy.maxRiskClass]) {
    return denied("工具风险等级超过当前 Agent 角色上限。", "risk_exceeds_role");
  }

  const missingPermission = tool.requiredPermissions.find(
    (permission) => !hasExactAgentRuntimePermission(input.permissions, permission),
  );
  if (missingPermission) {
    return denied(`缺少用户或工作区权限：${missingPermission}`, "permission_missing");
  }

  const invalidGrant = grantDecision(input, rolePolicy, now);
  if (invalidGrant) return invalidGrant;

  if ((tool.riskClass === "R2" || tool.riskClass === "R3") && !hasValidApproval(input, now)) {
    return denied("R2/R3 工具必须提供与当前工具、工作区和项目匹配的有效审批。", "approval_required", true);
  }

  return {
    allowed: true,
    code: "allowed",
    reason: "工具调用满足当前最小权限契约。",
    requiresApproval: false,
  };
}
