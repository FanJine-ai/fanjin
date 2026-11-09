import type { Knex } from "knex";
import { AGENT_APPROVAL_TABLE } from "@/lib/migrations/agentApprovalDelegation";

export const PROJECT_TABLE = "o_project";
export const AGENT_PROJECT_BUDGET_COLUMN = "agentBudgetMicros";
export const AGENT_PROJECT_BUDGET_RESERVED_COLUMN = "agentBudgetReservedMicros";
export const AGENT_APPROVAL_BUDGET_RESERVED_COLUMN = "budgetReservedMicros";

/**
 * 项目级 Agent GU 预算(预算自主审批):
 * - o_project.agentBudgetMicros:用户设置的预算上限;NULL = 未设置 = 全部人工审批。
 * - o_project.agentBudgetReservedMicros:已被自动批准占用(预留)的额度,随审批
 *   consumed/expired/denied/revoked 终态在同事务回滚;对账任务列后续。
 * - o_agent_approval.budgetReservedMicros:该审批当前持有的预留金额。非 NULL 即
 *   "预算内自动批准"的持久化标记,同时记录精确的待释放金额;释放时在同一状态 CAS
 *   内清零,保证并发/重放下释放幂等。
 */
export async function upAgentProjectBudget(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(PROJECT_TABLE)) {
    if (!(await trx.schema.hasColumn(PROJECT_TABLE, AGENT_PROJECT_BUDGET_COLUMN))) {
      await trx.schema.alterTable(PROJECT_TABLE, (table) => {
        table.bigInteger(AGENT_PROJECT_BUDGET_COLUMN);
      });
    }
    if (!(await trx.schema.hasColumn(PROJECT_TABLE, AGENT_PROJECT_BUDGET_RESERVED_COLUMN))) {
      await trx.schema.alterTable(PROJECT_TABLE, (table) => {
        table.bigInteger(AGENT_PROJECT_BUDGET_RESERVED_COLUMN).notNullable().defaultTo(0);
      });
    }
    await trx(PROJECT_TABLE)
      .whereNull(AGENT_PROJECT_BUDGET_RESERVED_COLUMN)
      .update({ [AGENT_PROJECT_BUDGET_RESERVED_COLUMN]: 0 });
  }

  if (await trx.schema.hasTable(AGENT_APPROVAL_TABLE)) {
    if (!(await trx.schema.hasColumn(AGENT_APPROVAL_TABLE, AGENT_APPROVAL_BUDGET_RESERVED_COLUMN))) {
      await trx.schema.alterTable(AGENT_APPROVAL_TABLE, (table) => {
        table.bigInteger(AGENT_APPROVAL_BUDGET_RESERVED_COLUMN);
      });
    }
  }
}

export async function downAgentProjectBudget(): Promise<void> {
  // 预算与预留是资金审计事实;删除列可能撞上进行中的自动批准/释放写入。
  throw new Error(
    "Migration agent_project_budget cannot be rolled back safely because budget and reservation columns carry live accounting data.",
  );
}
