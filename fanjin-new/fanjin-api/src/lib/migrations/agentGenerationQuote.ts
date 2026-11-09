import type { Knex } from "knex";

export const AGENT_GENERATION_QUOTE_TABLE = "o_agent_generation_quote";
export const AGENT_GENERATION_QUOTE_SCOPE_INDEX = "idx_o_agent_generation_quote_scope_expire";
export const AGENT_GENERATION_QUOTE_RUN_INDEX = "idx_o_agent_generation_quote_run_created";
export const AGENT_GENERATION_QUOTE_STEP_INDEX = "idx_o_agent_generation_quote_step";

export async function upAgentGenerationQuote(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(AGENT_GENERATION_QUOTE_TABLE)) return;
  await trx.schema.createTable(AGENT_GENERATION_QUOTE_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.text("runId").notNullable();
    table.text("stepId").notNullable();
    table.bigInteger("actorUserId").notNullable();
    table.text("generationType").notNullable();
    table.text("endpointType").notNullable();
    table.text("provider").notNullable();
    table.text("model").notNullable();
    table.bigInteger("units").notNullable();
    table.text("unit").notNullable();
    table.text("currency").notNullable();
    table.bigInteger("estimatedCostMicros").notNullable();
    table.bigInteger("maximumCostMicros").notNullable();
    table.text("pricingRuleId").notNullable();
    table.bigInteger("pricingRuleUpdatedAt").notNullable();
    table.text("requestDigest").notNullable();
    table.text("bindingDigest").notNullable();
    table.text("pricingDigest").notNullable();
    table.text("pricingSnapshot").notNullable();
    table.bigInteger("expiresAt").notNullable();
    table.bigInteger("createdAt").notNullable();
    table.index(["workspaceId", "projectId", "expiresAt"], AGENT_GENERATION_QUOTE_SCOPE_INDEX);
    table.index(["runId", "createdAt"], AGENT_GENERATION_QUOTE_RUN_INDEX);
    table.unique(["stepId"], AGENT_GENERATION_QUOTE_STEP_INDEX);
  });
}

export async function downAgentGenerationQuote(): Promise<void> {
  throw new Error(
    "Migration agent_generation_quote cannot be rolled back safely because quotes are approval and billing evidence.",
  );
}
