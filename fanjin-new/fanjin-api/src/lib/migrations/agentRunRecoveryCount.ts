import type { Knex } from "knex";

export const AGENT_RUN_TABLE = "o_agent_run";

/**
 * Separates the monotonic claim fence (`attempt`) from the lease-recovery
 * budget. Existing Runs start with no recorded recovery failures.
 */
export async function upAgentRunRecoveryCount(trx: Knex.Transaction): Promise<void> {
  // Some legacy installations predate the optional Agent Runtime tables. A
  // later baseline/fixDB creation already includes this column, so absence is
  // an idempotent no-op rather than a partially applied schema error.
  if (!(await trx.schema.hasTable(AGENT_RUN_TABLE))) return;
  if (!(await trx.schema.hasColumn(AGENT_RUN_TABLE, "recoveryCount"))) {
    await trx.schema.alterTable(AGENT_RUN_TABLE, (table) => {
      table.bigInteger("recoveryCount").notNullable().defaultTo(0);
    });
    return;
  }

  // fixDB historically adds missing legacy columns as nullable. Normalize
  // that intermediate shape before recording v14 as applied.
  await trx(AGENT_RUN_TABLE).whereNull("recoveryCount").update({ recoveryCount: 0 });
  const column = (await trx(AGENT_RUN_TABLE).columnInfo()).recoveryCount;
  const normalizedDefault = String(column?.defaultValue ?? "").replaceAll("'", "").trim();
  if (column?.nullable === false && /^0(?:::[a-z0-9_ ]+)?$/i.test(normalizedDefault)) return;
  await trx.schema.alterTable(AGENT_RUN_TABLE, (table) => {
    table.bigInteger("recoveryCount").notNullable().defaultTo(0).alter();
  });
}

export async function downAgentRunRecoveryCount(): Promise<void> {
  throw new Error(
    "Migration agent_run_recovery_count cannot be rolled back safely because recovery counts are durable lease-failure evidence.",
  );
}
