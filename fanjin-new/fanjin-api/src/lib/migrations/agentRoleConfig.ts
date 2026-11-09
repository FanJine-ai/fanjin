import type { Knex } from "knex";

export const AGENT_ROLE_CONFIG_TABLE = "o_agent_role_config";
export const AGENT_ROLE_CONFIG_UPDATED_INDEX = "idx_o_agent_role_config_enabled_updated";

export async function upAgentRoleConfig(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(AGENT_ROLE_CONFIG_TABLE)) return;

  await trx.schema.createTable(AGENT_ROLE_CONFIG_TABLE, (table) => {
    table.text("role").notNullable().primary();
    table.text("promptKey").notNullable();
    table.text("promptVersion").notNullable();
    table.text("skillRefs").notNullable().defaultTo("[]");
    table.text("modelProfileKey").notNullable();
    table.text("modelProfileVersion").notNullable();
    table.text("modelAliasOverride");
    table.bigInteger("temperatureMilli").notNullable();
    table.bigInteger("maxOutputTokens").notNullable();
    table.boolean("enabled").notNullable().defaultTo(true);
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("updatedBy").notNullable();
    table.bigInteger("updatedAt").notNullable();
    table.index(["enabled", "updatedAt"], AGENT_ROLE_CONFIG_UPDATED_INDEX);
  });
}

export async function downAgentRoleConfig(): Promise<void> {
  throw new Error(
    "Migration agent_role_config cannot be rolled back safely because persisted Agent role overrides may be active.",
  );
}
