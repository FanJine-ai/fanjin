import type { Knex } from "knex";

export const CREATION_SESSION_TABLE = "o_creation_session";

export async function upCreationSession(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(CREATION_SESSION_TABLE)) return;

  await trx.schema.createTable(CREATION_SESSION_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.text("goal").notNullable().defaultTo("");
    table.text("mode").notNullable().defaultTo("agent");
    table.text("inputs").notNullable().defaultTo("[]");
    table.text("parameters").notNullable().defaultTo("{}");
    table.text("selectedAssetVersionIds").notNullable().defaultTo("[]");
    table.text("canvasId");
    table.text("status").notNullable().defaultTo("active");
    table.bigInteger("version").notNullable().defaultTo(1);
    table.bigInteger("createdBy").notNullable();
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
    table.bigInteger("archivedAt");
    table.index(["workspaceId", "projectId", "updatedAt"]);
    table.index(["workspaceId", "projectId", "status"]);
  });
}

export async function downCreationSession(): Promise<void> {
  throw new Error(
    "Migration creation_session cannot be rolled back safely because Agent threads may already reference persisted creation sessions.",
  );
}
