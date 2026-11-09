import type { Knex } from "knex";

export const PROJECT_FOLDER_TABLE = "o_project_folder";

export async function upProjectFolders(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(PROJECT_FOLDER_TABLE)) return;
  await trx.schema.createTable(PROJECT_FOLDER_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("createdBy").notNullable();
    table.text("name").notNullable();
    table.text("projectIds").notNullable().defaultTo("[]");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
    table.index(["workspaceId", "updatedAt"], "idx_project_folder_workspace_updated");
    table.index(["workspaceId", "createdBy"], "idx_project_folder_workspace_creator");
  });
}

export async function downProjectFolders(): Promise<void> {
  throw new Error(
    "Migration project_folders cannot be rolled back safely because folder metadata would be lost.",
  );
}
