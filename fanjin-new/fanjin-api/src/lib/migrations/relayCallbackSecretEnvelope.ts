import type { Knex } from "knex";
import { quoteSqlIdentifier, tableColumns, tableIndexRows } from "@/lib/dbDialect";

const TABLE = "o_relay_callback_delivery";
const TASK_INDEX = "idx_o_relay_callback_delivery_task";
const DUE_INDEX = "idx_o_relay_callback_delivery_due";
const LEASE_INDEX = "idx_o_relay_callback_delivery_lease";

async function ensureIndex(
  trx: Knex.Transaction,
  name: string,
  columns: string[],
  unique = false,
): Promise<void> {
  const indexes = await tableIndexRows(trx, TABLE);
  if (indexes.some((index) => index.name === name)) return;
  const uniqueSql = unique ? "UNIQUE " : "";
  await trx.raw(
    `CREATE ${uniqueSql}INDEX ${quoteSqlIdentifier(name)} ON ${quoteSqlIdentifier(TABLE)} (${columns
      .map(quoteSqlIdentifier)
      .join(", ")})`,
  );
}

/**
 * Idempotent v2 migration body. A fresh baseline already creates the final
 * table, while databases that applied v1 earlier need the envelope column.
 */
export async function upRelayCallbackSecretEnvelope(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(TABLE))) {
    await trx.schema.createTable(TABLE, (table) => {
      table.text("id").notNullable();
      table.text("taskId").notNullable();
      table.text("event").notNullable().defaultTo("relay.task.terminal");
      table.text("callbackUrl").notNullable();
      table.text("secretCiphertext");
      table.text("payload").notNullable();
      table.text("payloadHash").notNullable();
      table.text("status").notNullable().defaultTo("pending");
      table.bigInteger("attempts").notNullable().defaultTo(0);
      table.bigInteger("nextAttemptAt").notNullable();
      table.text("leaseOwner");
      table.bigInteger("leaseExpiresAt");
      table.bigInteger("lastHttpStatus");
      table.text("lastError");
      table.bigInteger("deliveredAt");
      table.bigInteger("createTime").notNullable();
      table.bigInteger("updateTime").notNullable();
      table.primary(["id"]);
    });
  } else {
    const columns = await tableColumns(trx, TABLE);
    if (!columns.includes("secretCiphertext")) {
      await trx.schema.alterTable(TABLE, (table) => table.text("secretCiphertext"));
    }
  }

  await ensureIndex(trx, TASK_INDEX, ["taskId"], true);
  await ensureIndex(trx, DUE_INDEX, ["status", "nextAttemptAt"]);
  await ensureIndex(trx, LEASE_INDEX, ["status", "leaseExpiresAt"]);
}

export async function downRelayCallbackSecretEnvelope(): Promise<void> {
  // v1 is a legacy baseline whose implementation creates the latest schema on
  // fresh databases. We cannot distinguish whether v2 created this table/column
  // or merely verified it, and ciphertext may be required by pending deliveries.
  // Refuse instead of risking an irreversible loss of callback signing keys.
  throw new Error(
    "Migration relay_callback_secret_envelope cannot be rolled back safely; drain callback deliveries and restore from a reviewed backup migration.",
  );
}
