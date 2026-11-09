import type { Knex } from "knex";
import { quoteSqlIdentifier, tableIndexRows } from "@/lib/dbDialect";

export const VIDEO_FULFILLMENT_RECIPE_TABLE = "o_video_fulfillment_recipe";
export const VIDEO_PUBLIC_OFFER_TABLE = "o_video_public_offer";

const RECIPE_LOOKUP_INDEX = "idx_o_video_fulfillment_recipe_model_target";
const OFFER_MODEL_INDEX = "uniq_o_video_public_offer_model";

export async function upVideoFulfillmentRecipe(trx: Knex | Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(VIDEO_PUBLIC_OFFER_TABLE))) {
    await trx.schema.createTable(VIDEO_PUBLIC_OFFER_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("publicModel").notNullable();
      table.text("displayName").notNullable();
      table.text("visibleResolutions").notNullable().defaultTo("[]");
      table.bigInteger("enabled").notNullable().defaultTo(1);
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
    });
  }

  if (!(await trx.schema.hasTable(VIDEO_FULFILLMENT_RECIPE_TABLE))) {
    await trx.schema.createTable(VIDEO_FULFILLMENT_RECIPE_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("publicModel").notNullable();
      table.text("targetResolution").notNullable();
      table.text("name").notNullable().defaultTo("");
      table.text("generateChannelId").notNullable();
      table.text("generateResolution").notNullable();
      table.text("upstreamModel");
      table.bigInteger("enhanceEnabled").notNullable().defaultTo(0);
      table.text("enhanceChannelId");
      table.bigInteger("weight").notNullable().defaultTo(100);
      table.bigInteger("priority").notNullable().defaultTo(100);
      table.bigInteger("enabled").notNullable().defaultTo(1);
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
    });
  }

  const offerIndexes = await tableIndexRows(trx, VIDEO_PUBLIC_OFFER_TABLE);
  if (!offerIndexes.some((index) => index.name === OFFER_MODEL_INDEX)) {
    await trx.raw(
      `CREATE UNIQUE INDEX ${quoteSqlIdentifier(OFFER_MODEL_INDEX)} ON ${quoteSqlIdentifier(VIDEO_PUBLIC_OFFER_TABLE)} (${quoteSqlIdentifier("publicModel")})`,
    );
  }

  const recipeIndexes = await tableIndexRows(trx, VIDEO_FULFILLMENT_RECIPE_TABLE);
  if (!recipeIndexes.some((index) => index.name === RECIPE_LOOKUP_INDEX)) {
    await trx.raw(
      `CREATE INDEX ${quoteSqlIdentifier(RECIPE_LOOKUP_INDEX)} ON ${quoteSqlIdentifier(VIDEO_FULFILLMENT_RECIPE_TABLE)} (${quoteSqlIdentifier("publicModel")}, ${quoteSqlIdentifier("targetResolution")}, ${quoteSqlIdentifier("enabled")})`,
    );
  }
}

export async function downVideoFulfillmentRecipe(): Promise<void> {
  throw new Error(
    "Migration video_fulfillment_recipe cannot be rolled back safely because it would drop fulfillment routing configuration.",
  );
}
