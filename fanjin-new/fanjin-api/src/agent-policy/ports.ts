/**
 * PolicyPort：单步 reducer 在决定「这次工具调用能否执行」时调用。
 * core 只问「allow / require_approval / deny」，不关心底层如何判定。
 */
import type { PolicyDecision } from "@/agent-runtime/policy";
import type { ToolManifest, AgentRole, DelegationGrant, ApprovalEvidence } from "@/agent-runtime/contracts";

/** core 侧看到的授权判定输入（已由 shell 物化，纯数据，无 DB 句柄）。 */
export interface PolicyCheckInput {
  /** 角色（main / writer / visual / executor / ...）。 */
  readonly role: AgentRole;
  /** 工具 manifest（含 riskClass / mutatesState / requiredPermissions 等）。 */
  readonly tool: ToolManifest;
  /** 当前角色的权限列表。 */
  readonly permissions: readonly string[];
  /** 操作者用户 ID。 */
  readonly actorUserId: number;
  /** 工作区 ID。 */
  readonly workspaceId: string;
  /** 项目 ID（policy.ts 里是 string，gateway 里是 number——本接口统一用 string）。 */
  readonly projectId: string;
  /** 委派授权（可选）。 */
  readonly grant?: DelegationGrant;
  /** 委派授权是否已验证。 */
  readonly grantVerified?: boolean;
  /** 审批证据（可选）。 */
  readonly approval?: ApprovalEvidence;
  /** 审批验证模式。 */
  readonly approvalVerificationMode?: "approved_execution" | "exact_consumed_replay";
  /** 调用作用域哈希。 */
  readonly callScopeHash?: string;
  /** 当前时间戳（由 shell 传入，禁止在此 Date.now()）。 */
  readonly now?: number;
}

/** core 需要的授权端口接口。 */
export interface PolicyPort {
  /** 返回现有 evaluateToolPolicy 的判定结果，不做任何修改。 */
  check(input: PolicyCheckInput): PolicyDecision;
}
