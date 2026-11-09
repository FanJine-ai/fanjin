import type { Knex } from "knex";

export const FILE_METADATA = "o_asset_file_metadata";
export const FILE_FOLDER = "o_asset_file_folder";
export const FILE_PLACEMENT = "o_asset_file_placement";
export const HISTORY_VISIBILITY = "o_generation_history_visibility";
export const FILE_MANAGER_CONSTRAINTS = [FILE_METADATA, FILE_FOLDER, FILE_PLACEMENT, HISTORY_VISIBILITY].map(name => `table:${name}`);

export async function upAssetFileManager(trx: Knex.Transaction) {
  await trx.schema.createTable(FILE_METADATA, t => {
    t.bigInteger("assetId").primary().references("id").inTable("o_assets").onDelete("CASCADE");
    t.bigInteger("revision").notNullable().defaultTo(1);
    t.text("tags").notNullable().defaultTo("[]");
    t.bigInteger("trashedAt"); t.bigInteger("trashedBy");
    t.bigInteger("updatedAt").notNullable();
    t.index(["trashedAt", "assetId"], "idx_asset_file_trash");
  });
  await trx.schema.createTable(FILE_FOLDER, t => {
    t.text("id").primary(); t.text("workspaceId").notNullable();
    t.bigInteger("projectId").notNullable().references("id").inTable("o_project").onDelete("CASCADE");
    t.text("parentId").references("id").inTable(FILE_FOLDER).onDelete("RESTRICT");
    t.text("name").notNullable(); t.bigInteger("revision").notNullable().defaultTo(1);
    t.bigInteger("createdBy").notNullable(); t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    t.index(["workspaceId", "projectId", "parentId"], "idx_asset_file_folder_scope");
  });
  await trx.schema.createTable(FILE_PLACEMENT, t => {
    t.text("refId").primary().references("id").inTable("o_project_asset_ref").onDelete("CASCADE");
    t.text("folderId").notNullable().references("id").inTable(FILE_FOLDER).onDelete("RESTRICT");
    t.bigInteger("revision").notNullable().defaultTo(1); t.bigInteger("updatedAt").notNullable();
    t.index(["folderId"], "idx_asset_file_placement_folder");
  });
  await trx.schema.createTable(HISTORY_VISIBILITY, t => {
    t.text("workspaceId").notNullable(); t.bigInteger("userId").notNullable();
    t.text("mediaId").notNullable(); t.bigInteger("hiddenAt").notNullable();
    t.primary(["workspaceId", "userId", "mediaId"]);
  });
}

export async function downAssetFileManager(): Promise<void> {
  throw new Error("File organization and recovery metadata must be preserved; use a forward migration.");
}
