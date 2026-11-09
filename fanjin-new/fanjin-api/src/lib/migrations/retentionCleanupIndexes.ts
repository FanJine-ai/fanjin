import type { Knex } from "knex";
import { quoteSqlIdentifier, tableIndexRows } from "@/lib/dbDialect";

export const RETENTION_INDEXES = [
  {
    name: "idx_o_request_log_created_at",
    table: "o_request_log",
    columns: ["createdAt"],
  },
  {
    name: "idx_o_relay_callback_delivery_status_delivered",
    table: "o_relay_callback_delivery",
    columns: ["status", "deliveredAt"],
  },
] as const;

export async function upRetentionCleanupIndexes(trx: Knex.Transaction): Promise<void> {
  for (const definition of RETENTION_INDEXES) {
    if (!(await trx.schema.hasTable(definition.table))) continue;
    const indexes = await tableIndexRows(trx, definition.table);
    if (indexes.some((index) => index.name === definition.name)) continue;
    await trx.raw(
      `CREATE INDEX ${quoteSqlIdentifier(definition.name)} ON ${quoteSqlIdentifier(definition.table)} (${definition.columns
        .map(quoteSqlIdentifier)
        .join(", ")})`,
    );
  }
}

export async function downRetentionCleanupIndexes(trx: Knex.Transaction): Promise<void> {
  for (const definition of [...RETENTION_INDEXES].reverse()) {
    await trx.raw(`DROP INDEX IF EXISTS ${quoteSqlIdentifier(definition.name)}`);
  }
}
