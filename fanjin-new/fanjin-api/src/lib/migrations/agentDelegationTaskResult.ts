import type { Knex } from "knex";
import { quoteSqlIdentifier, tableIndexRows } from "@/lib/dbDialect";
import { AGENT_DELEGATION_TABLE } from "@/lib/migrations/agentApprovalDelegation";

export const AGENT_RUN_TABLE = "o_agent_run";

export const AGENT_DELEGATION_PARENT_STEP_STATUS_INDEX =
  "idx_o_agent_delegation_parent_step_status";
export const AGENT_RUN_DELEGATION_INDEX = "idx_o_agent_run_delegation";
export const AGENT_RUN_PARENT_STATUS_INDEX = "idx_o_agent_run_parent_status";
export const AGENT_RUN_ROOT_KIND_STATUS_INDEX = "idx_o_agent_run_root_kind_status";

export const AGENT_DELEGATION_TASK_RESULT_COLUMNS = [
  "taskVersion",
  "taskJson",
  "taskHash",
  "writeTargets",
  "taskStatus",
  "resultJson",
  "resultHash",
  "resultMessageId",
  "startedAt",
  "completedAt",
  "safeError",
] as const;

type DelegationTaskResultColumn = (typeof AGENT_DELEGATION_TASK_RESULT_COLUMNS)[number];

async function addDelegationColumn(
  trx: Knex.Transaction,
  column: DelegationTaskResultColumn,
): Promise<void> {
  if (await trx.schema.hasColumn(AGENT_DELEGATION_TABLE, column)) return;
  await trx.schema.alterTable(AGENT_DELEGATION_TABLE, (table) => {
    if (column === "taskVersion" || column === "startedAt" || column === "completedAt") {
      table.bigInteger(column);
      return;
    }
    table.text(column);
  });
}

async function createIndex(input: {
  trx: Knex.Transaction;
  name: string;
  table: string;
  columns: readonly string[];
  unique?: boolean;
  whereNotNull?: string;
}): Promise<void> {
  const indexes = await tableIndexRows(input.trx, input.table);
  if (indexes.some((index) => index.name === input.name)) return;
  const unique = input.unique ? "UNIQUE " : "";
  const where = input.whereNotNull
    ? ` WHERE ${quoteSqlIdentifier(input.whereNotNull)} IS NOT NULL`
    : "";
  await input.trx.raw(
    `CREATE ${unique}INDEX ${quoteSqlIdentifier(input.name)} ON ${quoteSqlIdentifier(input.table)} (${input.columns
      .map(quoteSqlIdentifier)
      .join(", ")})${where}`,
  );
}

/**
 * Adds the durable AgentTask / AgentTaskResult lifecycle without inventing
 * task data for legacy Grant-only rows. NULL therefore means "issued before
 * the A4 task protocol"; the future Coordinator must populate every task
 * field for newly created delegated Runs.
 */
export async function upAgentDelegationTaskResult(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(AGENT_DELEGATION_TABLE))) {
    throw new Error("Migration agent_delegation_task_result requires o_agent_delegation");
  }
  if (!(await trx.schema.hasTable(AGENT_RUN_TABLE))) {
    throw new Error("Migration agent_delegation_task_result requires o_agent_run");
  }

  for (const column of AGENT_DELEGATION_TASK_RESULT_COLUMNS) {
    await addDelegationColumn(trx, column);
  }

  await createIndex({
    trx,
    name: AGENT_DELEGATION_PARENT_STEP_STATUS_INDEX,
    table: AGENT_DELEGATION_TABLE,
    columns: ["parentStepId", "taskStatus"],
  });
  await createIndex({
    trx,
    name: AGENT_RUN_DELEGATION_INDEX,
    table: AGENT_RUN_TABLE,
    columns: ["delegationId"],
    unique: true,
    whereNotNull: "delegationId",
  });
  await createIndex({
    trx,
    name: AGENT_RUN_PARENT_STATUS_INDEX,
    table: AGENT_RUN_TABLE,
    columns: ["parentRunId", "status"],
  });
  await createIndex({
    trx,
    name: AGENT_RUN_ROOT_KIND_STATUS_INDEX,
    table: AGENT_RUN_TABLE,
    columns: ["rootRunId", "kind", "status"],
  });
}

export async function downAgentDelegationTaskResult(): Promise<void> {
  throw new Error(
    "Migration agent_delegation_task_result cannot be rolled back safely because AgentTask and AgentTaskResult records are durable orchestration audit evidence.",
  );
}
