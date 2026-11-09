import type { Knex } from "knex";

export const CANVAS_ASSET_TABLE = "o_canvas_asset";
export const CANVAS_ASSET_SCOPE_INDEX = "idx_o_canvas_asset_scope_updated";
export const CANVAS_ASSET_ACTOR_INDEX = "idx_o_canvas_asset_actor_created";

/**
 * Project-scoped reusable Canvas snapshots. These are deliberately separate
 * from o_assets: a snapshot has an opaque UUID and must never be submitted to
 * Agent Runtime as a numeric project asset id.
 */
export async function upCanvasAsset(trx: Knex.Transaction): Promise<void> {
  // Operational-only test/repair databases may legitimately omit all product
  // tables. Match the unified Canvas migrations by treating that shape as a
  // no-op; every application database created by the baseline has o_project.
  if (!(await trx.schema.hasTable("o_project"))) return;
  if (await trx.schema.hasTable(CANVAS_ASSET_TABLE)) return;

  await trx.schema.createTable(CANVAS_ASSET_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable()
      .references("id")
      .inTable("o_project")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");
    table.bigInteger("createdBy").notNullable();
    table.text("name").notNullable();
    table.text("saveLocation").notNullable().defaultTo("");
    table.text("tag").notNullable().defaultTo("");
    table.text("coverUrl").notNullable().defaultTo("");
    table.text("assetType").notNullable().defaultTo("snapshot");
    table.text("referenceAssetUri");
    table.text("snapshot").notNullable().defaultTo("{}");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
    table.index(
      ["workspaceId", "projectId", "updatedAt", "id"],
      CANVAS_ASSET_SCOPE_INDEX,
    );
    table.index(
      ["workspaceId", "createdBy", "createdAt"],
      CANVAS_ASSET_ACTOR_INDEX,
    );
  });
}

export async function downCanvasAsset(): Promise<void> {
  throw new Error(
    "Migration canvas_asset cannot be rolled back safely because reusable Canvas snapshots are durable user data.",
  );
}
