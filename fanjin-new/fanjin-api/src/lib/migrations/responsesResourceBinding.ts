import type { Knex } from "knex";

export const RESPONSES_RESOURCE_BINDING_TABLE = "o_responses_resource_binding";

export async function upResponsesResourceBinding(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(RESPONSES_RESOURCE_BINDING_TABLE)) return;
  await trx.schema.createTable(RESPONSES_RESOURCE_BINDING_TABLE, (table) => {
    table.text("responseId").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.text("apiKeyId");
    table.text("principalId");
    table.text("provider").notNullable();
    table.text("channelId").notNullable();
    table.text("baseUrl").notNullable();
    table.text("credentialRef").notNullable();
    table.text("model").notNullable();
    table.text("upstreamModel").notNullable();
    table.bigInteger("expiresAt");
    table.bigInteger("deletedAt");
    table.bigInteger("createTime").notNullable();
    table.bigInteger("updateTime").notNullable();
    table.index(["workspaceId", "apiKeyId"], "idx_o_responses_binding_workspace_key");
    table.index(["workspaceId", "principalId"], "idx_o_responses_binding_workspace_principal");
    table.index(["channelId"], "idx_o_responses_binding_channel");
    table.index(["expiresAt"], "idx_o_responses_binding_expiry");
  });
}

export async function downResponsesResourceBinding(trx: Knex.Transaction): Promise<void> {
  void trx;
  throw new Error(
    "Migration responses_resource_binding cannot be rolled back safely because tenant ownership bindings are durable access-control evidence.",
  );
}
