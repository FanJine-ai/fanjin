import type { Knex } from "knex";

export const AGENT_APPROVAL_TABLE = "o_agent_approval";
export const AGENT_DELEGATION_TABLE = "o_agent_delegation";
export const AGENT_DELEGATION_USAGE_TABLE = "o_agent_delegation_usage";

export const AGENT_APPROVAL_SCOPE_INDEX = "idx_o_agent_approval_scope_status_expire";
export const AGENT_APPROVAL_RUN_INDEX = "idx_o_agent_approval_run_created";
export const AGENT_DELEGATION_SCOPE_INDEX = "idx_o_agent_delegation_scope_status_expire";
export const AGENT_DELEGATION_PARENT_INDEX = "idx_o_agent_delegation_parent_run";
export const AGENT_DELEGATION_BOUND_RUN_INDEX = "idx_o_agent_delegation_bound_run";
export const AGENT_DELEGATION_USAGE_KEY_INDEX = "idx_o_agent_delegation_usage_key";
export const AGENT_DELEGATION_USAGE_ORDINAL_INDEX = "idx_o_agent_delegation_usage_ordinal";
export const AGENT_DELEGATION_USAGE_RUN_INDEX = "idx_o_agent_delegation_usage_run_created";

export async function upAgentApprovalDelegation(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(AGENT_APPROVAL_TABLE))) {
    await trx.schema.createTable(AGENT_APPROVAL_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("runId").notNullable();
      table.text("stepId");
      table.text("toolId").notNullable();
      table.text("toolVersion").notNullable();
      table.text("riskClass").notNullable();
      table.text("argumentsHash").notNullable();
      table.text("resourceVersions").notNullable().defaultTo("{}");
      table.text("evidenceKind").notNullable();
      table.text("quote");
      table.text("impactSummary");
      table.text("scopeHash").notNullable();
      table.text("policyVersion").notNullable();
      table.text("status").notNullable().defaultTo("pending");
      table.bigInteger("requestedBy").notNullable();
      table.bigInteger("decidedBy");
      table.bigInteger("decidedAt");
      table.bigInteger("expiresAt").notNullable();
      table.bigInteger("consumedAt");
      table.bigInteger("revokedAt");
      table.bigInteger("revokedBy");
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.index(["workspaceId", "projectId", "status", "expiresAt"], AGENT_APPROVAL_SCOPE_INDEX);
      table.index(["runId", "createdAt"], AGENT_APPROVAL_RUN_INDEX);
    });
  }

  if (!(await trx.schema.hasTable(AGENT_DELEGATION_TABLE))) {
    await trx.schema.createTable(AGENT_DELEGATION_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.bigInteger("grantVersion").notNullable().defaultTo(1);
      table.text("status").notNullable().defaultTo("active");
      table.bigInteger("actorUserId").notNullable();
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("sessionId");
      table.text("parentRunId").notNullable();
      table.text("parentStepId").notNullable();
      table.text("boundRunId");
      table.text("issuerRole").notNullable().defaultTo("main");
      table.text("granteeRole").notNullable();
      table.text("purpose").notNullable();
      table.text("objectiveHash").notNullable();
      table.text("inputRefs").notNullable().defaultTo("[]");
      table.text("outputContract").notNullable();
      table.text("allowedTools").notNullable().defaultTo("[]");
      table.text("resourceScope").notNullable().defaultTo("{}");
      table.text("limits").notNullable();
      table.text("spend").notNullable();
      table.text("approvalId");
      table.text("approvalScopeHash");
      table.text("approvalPolicyVersion");
      table.text("idempotencyPrefix").notNullable();
      table.bigInteger("canDelegate").notNullable().defaultTo(0);
      table.bigInteger("issuedAt").notNullable();
      table.bigInteger("expiresAt").notNullable();
      table.bigInteger("revokedAt");
      table.bigInteger("revokedBy");
      table.bigInteger("consumedToolCalls").notNullable().defaultTo(0);
      table.bigInteger("consumedEstimatedMicros").notNullable().defaultTo(0);
      table.bigInteger("consumedActualMicros").notNullable().defaultTo(0);
      table.text("signature").notNullable();
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("updatedAt").notNullable();
      table.index(["workspaceId", "projectId", "status", "expiresAt"], AGENT_DELEGATION_SCOPE_INDEX);
      table.index(["parentRunId"], AGENT_DELEGATION_PARENT_INDEX);
      table.unique(["boundRunId"], AGENT_DELEGATION_BOUND_RUN_INDEX);
    });
  }

  if (!(await trx.schema.hasTable(AGENT_DELEGATION_USAGE_TABLE))) {
    await trx.schema.createTable(AGENT_DELEGATION_USAGE_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("grantId").notNullable();
      table.text("runId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable();
      table.text("toolId").notNullable();
      table.text("resourceRefs").notNullable().defaultTo("[]");
      table.bigInteger("estimatedMicros").notNullable().defaultTo(0);
      table.bigInteger("actualMicros").notNullable().defaultTo(0);
      table.bigInteger("callOrdinal").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.unique(["grantId", "idempotencyKey"], AGENT_DELEGATION_USAGE_KEY_INDEX);
      table.unique(["grantId", "callOrdinal"], AGENT_DELEGATION_USAGE_ORDINAL_INDEX);
      table.index(["runId", "createdAt"], AGENT_DELEGATION_USAGE_RUN_INDEX);
    });
  }
}

export async function downAgentApprovalDelegation(): Promise<void> {
  throw new Error(
    "Migration agent_approval_delegation cannot be rolled back safely because approvals and delegation usage are security audit records.",
  );
}
