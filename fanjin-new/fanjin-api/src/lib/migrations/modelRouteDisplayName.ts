import type { Knex } from "knex";

export const MODEL_ROUTE_TABLE = "o_model_route";
export const MODEL_ROUTE_DISPLAY_NAME_COLUMN = "displayName";

/**
 * Adds the operator-facing mapping name shown to end users. NULL keeps the
 * historical behavior: clients fall back to the route name / model id. The
 * super-resolution combo mapping name deliberately stays inside the
 * routeConfig JSON (`enhanceDisplayName` key) instead of a second column.
 */
export async function upModelRouteDisplayName(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(MODEL_ROUTE_TABLE))) return;
  if (await trx.schema.hasColumn(MODEL_ROUTE_TABLE, MODEL_ROUTE_DISPLAY_NAME_COLUMN)) return;
  await trx.schema.alterTable(MODEL_ROUTE_TABLE, (table) => {
    table.text(MODEL_ROUTE_DISPLAY_NAME_COLUMN);
  });
}

export async function downModelRouteDisplayName(): Promise<void> {
  // Nullable and backward-compatible with older binaries; dropping it would
  // silently erase operator-configured mapping names on every rollback.
  throw new Error(
    "Migration model_route_display_name cannot be rolled back safely because configured display names would be lost.",
  );
}
