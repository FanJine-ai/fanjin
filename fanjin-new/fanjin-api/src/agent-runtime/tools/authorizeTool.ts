import type { Knex } from "knex";
import type {
  AgentApprovalService,
  PreparedAgentApprovalExecution,
} from "@/agent-runtime/approvalService";
import type { AgentRole, DelegationGrant, ToolManifest } from "@/agent-runtime/contracts";
import { DEFAULT_ROLE_POLICIES } from "@/agent-runtime/defaultRolePolicies";
import type {
  DelegationGrantService,
  PreparedDelegationGrantExecution,
} from "@/agent-runtime/delegationGrantService";
import { evaluateToolPolicy, type PolicyDecision } from "@/agent-runtime/policy";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import type { AgentToolAuthorizationEvidence } from "@/agent-runtime/tools/registry";
import { resolveLiveWorkspacePermissions } from "@/middleware/permissions";

export interface AuthorizeToolInput {
  database: Knex.Transaction;
  actorUserId: number;
  workspaceId: string;
  projectId: number;
  runId: string;
  runKind: string | null;
  delegationId: string | null;
  agentRole: AgentRole;
  manifest: ToolManifest;
  arguments: unknown;
  approvalId: string | null;
  executionStepId: string;
  authorizationEvidence: AgentToolAuthorizationEvidence;
  authorizationIdempotencyKey: string;
  mode: "execute" | "replay";
  replayStep?: {
    id: string;
    runId: string;
    idempotencyKey: string;
  };
  now: number;
  approvalService?: AgentApprovalService;
  delegationGrantService?: DelegationGrantService;
}

export interface AuthorizedToolCall {
  decision: PolicyDecision & { allowed: true };
  permissions: readonly string[];
  grant: DelegationGrant | null;
  approvalId: string | null;
}

export async function loadCurrentToolPermissions(input: {
  database: Knex.Transaction;
  actorUserId: number;
  workspaceId: string;
}): Promise<readonly string[]> {
  return (
    await resolveLiveWorkspacePermissions({
      database: input.database,
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    })
  ).permissions;
}

function requiredService(message: string, code: string): never {
  throw new AgentToolGatewayError(code, message, { status: 503 });
}

function grantForPolicy(grant: DelegationGrant, mode: "execute" | "replay"): DelegationGrant {
  // A consumed Grant can authorize only an exact persisted usage replay.  The
  // service proves that fact before this synthetic active view reaches the
  // generic policy evaluator; no new quota or side effect is possible.
  return mode === "replay" && grant.status === "consumed"
    ? { ...grant, status: "active" }
    : grant;
}

/**
 * Authoritative Tool policy and persisted evidence entry point.
 *
 * Identity/workspace/project/role/run/delegationId are derived from persisted
 * Runtime state by ToolGateway.  Only an opaque approvalId may originate at
 * the call boundary.  Grant and Approval objects are loaded, checked and
 * consumed in this existing transaction immediately before the handler.
 */
export async function authorizeTool(input: AuthorizeToolInput): Promise<AuthorizedToolCall> {
  const scopedProject = await input.database("o_project")
    .where({ id: input.projectId, workspaceId: input.workspaceId })
    .select("id")
    .first();
  if (!scopedProject) {
    throw new AgentToolGatewayError("project_scope_invalid", "项目不存在或不属于当前工作区", { status: 404 });
  }

  const permissions = await loadCurrentToolPermissions(input);
  const rolePolicy = DEFAULT_ROLE_POLICIES[input.agentRole];
  let preparedGrant: PreparedDelegationGrantExecution | null = null;
  let verifiedGrant: DelegationGrant | null = null;

  if (rolePolicy.requiresDelegationGrant) {
    if (input.runKind !== "delegated") {
      throw new AgentToolGatewayError("delegated_run_kind_invalid", "专项 Agent 必须运行在 delegated Run 中", { status: 403 });
    }
    if (!input.delegationId) {
      throw new AgentToolGatewayError("delegation_grant_required", "专项 Run 缺少持久化 DelegationGrant", { status: 403 });
    }
    const grants = input.delegationGrantService
      ?? requiredService("DelegationGrant 校验服务当前不可用", "delegation_service_unavailable");
    const grantInput = {
      grantId: input.delegationId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      actorUserId: input.actorUserId,
      agentRole: input.agentRole,
      toolId: input.manifest.name,
      resourceRefs: input.authorizationEvidence.resourceRefs,
      estimatedMicros: input.authorizationEvidence.estimatedMicros,
      actualMicros: input.authorizationEvidence.actualMicros,
      idempotencyKey: input.authorizationIdempotencyKey,
    };
    if (input.mode === "execute") {
      preparedGrant = await grants.prepareToolExecutionInTransaction(input.database, grantInput, input.now);
      verifiedGrant = preparedGrant.grant;
    } else {
      verifiedGrant = await grants.verifyToolReplayInTransaction(input.database, grantInput, input.now);
    }
  } else if (input.agentRole !== "main" || input.runKind === "delegated" || input.delegationId) {
    throw new AgentToolGatewayError(
      "run_role_scope_invalid",
      "非委派角色不能使用 delegated Run 或 DelegationGrant",
      { status: 403 },
    );
  }

  let preparedApproval: PreparedAgentApprovalExecution | null = null;
  const requiresApproval = input.manifest.riskClass === "R2" || input.manifest.riskClass === "R3";
  if (requiresApproval) {
    if (!input.approvalId) {
      throw new AgentToolGatewayError("approval_required", "R2/R3 工具必须提供持久化审批 ID", { status: 403 });
    }
    const approvals = input.approvalService
      ?? requiredService("Approval 校验服务当前不可用", "approval_service_unavailable");
    const grantApproval = verifiedGrant?.approval;
    if (grantApproval && grantApproval.approvalId !== input.approvalId) {
      throw new AgentToolGatewayError("approval_action_mismatch", "审批 ID 与 DelegationGrant 不匹配", { status: 409 });
    }
    preparedApproval = await approvals.prepareToolExecutionInTransaction(input.database, {
      approvalId: input.approvalId,
      actorUserId: input.actorUserId,
      executionStepId: input.executionStepId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: grantApproval ? verifiedGrant!.parentRunId : input.runId,
      toolId: input.manifest.name,
      toolVersion: input.manifest.version,
      riskClass: input.manifest.riskClass as "R2" | "R3",
      arguments: input.arguments,
      resourceVersions: input.authorizationEvidence.resourceVersions,
      quote: input.authorizationEvidence.quote,
      impactSummary: input.authorizationEvidence.impactSummary,
      policyVersion: input.authorizationEvidence.policyVersion as string,
      ...(input.mode === "replay" ? { exactReplayStep: input.replayStep } : {}),
    }, {
      now: input.now,
      mode: input.mode === "replay" ? "exact_consumed_replay" : "execute",
    });
  } else if (input.approvalId) {
    throw new AgentToolGatewayError("approval_not_applicable", "R0/R1 工具不能携带 Approval", { status: 400 });
  }

  const policyGrant = verifiedGrant ? grantForPolicy(verifiedGrant, input.mode) : undefined;
  const decision = evaluateToolPolicy({
    role: input.agentRole,
    tool: input.manifest,
    permissions,
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    projectId: String(input.projectId),
    grant: policyGrant,
    grantVerified: verifiedGrant !== null,
    approval: preparedApproval?.evidence,
    approvalVerificationMode: preparedApproval?.verificationMode,
    callScopeHash: preparedApproval?.evidence.scopeHash,
    now: input.now,
  });
  if (!decision.allowed) {
    throw new AgentToolGatewayError(decision.code, decision.reason, { status: 403 });
  }

  if (input.mode === "execute") {
    // Both rows were locked and fully validated above.  The updates occur in
    // the same Gateway transaction, after policy and before the domain handler.
    if (preparedGrant) {
      await input.delegationGrantService!.consumePreparedToolExecutionInTransaction(
        input.database,
        preparedGrant,
        input.now,
      );
    }
    if (preparedApproval) {
      await input.approvalService!.consumePreparedToolExecutionInTransaction(
        input.database,
        preparedApproval,
        input.executionStepId,
        input.now,
      );
    }
  }

  return {
    decision: decision as PolicyDecision & { allowed: true },
    permissions,
    grant: policyGrant ?? null,
    approvalId: preparedApproval?.approval.id ?? null,
  };
}
