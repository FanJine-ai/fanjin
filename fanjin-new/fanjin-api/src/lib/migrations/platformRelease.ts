import type { Knex } from "knex";

export const PLATFORM_RELEASE_TABLE = "o_platform_release";

/** Additive release-history storage shared by SQLite and PostgreSQL. */
export async function upPlatformRelease(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(PLATFORM_RELEASE_TABLE)) return;

  await trx.schema.createTable(PLATFORM_RELEASE_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("version").notNullable().unique();
    table.text("title").notNullable();
    table.text("channel").notNullable();
    table.text("summary").notNullable();
    table.text("releaseNotes").notNullable();
    table.text("status").notNullable().defaultTo("draft");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdByUserId");
    table.bigInteger("updatedByUserId");
    table.bigInteger("publishedByUserId");
    table.bigInteger("archivedByUserId");
    table.bigInteger("publishedAt");
    table.bigInteger("archivedAt");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
    table.index(["status", "updatedAt"], "idx_o_platform_release_status_updated");
    table.index(["channel", "status", "publishedAt"], "idx_o_platform_release_channel_published");
  });
}

export async function downPlatformRelease(): Promise<void> {
  throw new Error(
    "Migration platform_release cannot be rolled back safely because release history and operator attribution must be retained.",
  );
}
