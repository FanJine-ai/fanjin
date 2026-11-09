import type { Knex } from "knex";
import { quoteSqlIdentifier, tableColumns, tableIndexRows } from "@/lib/dbDialect";

const USER_TABLE = "o_user";
const HISTORY_TABLE = "o_user_password_history";
const HISTORY_INDEX = "idx_o_user_password_history_user_time";

export async function upUserPasswordHistoryPolicy(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(USER_TABLE)) {
    const userColumns = await tableColumns(trx, USER_TABLE);
    if (!userColumns.includes("passwordChangedAt")) {
      await trx.schema.alterTable(USER_TABLE, (table) => table.bigInteger("passwordChangedAt"));
    }
    await trx(USER_TABLE)
      .whereNull("passwordChangedAt")
      .update({
        passwordChangedAt: trx.raw(
          `COALESCE(${quoteSqlIdentifier("updatedAt")}, ${quoteSqlIdentifier("createdAt")}, ?)`,
          [Date.now()],
        ),
      });
  }

  if (!(await trx.schema.hasTable(HISTORY_TABLE))) {
    await trx.schema.createTable(HISTORY_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.bigInteger("userId").notNullable();
      table.text("passwordHash").notNullable();
      table.bigInteger("createdAt").notNullable();
    });
  }

  const indexes = await tableIndexRows(trx, HISTORY_TABLE);
  if (!indexes.some((index) => index.name === HISTORY_INDEX)) {
    await trx.raw(
      `CREATE INDEX ${quoteSqlIdentifier(HISTORY_INDEX)} ON ${quoteSqlIdentifier(HISTORY_TABLE)} (${quoteSqlIdentifier("userId")}, ${quoteSqlIdentifier("createdAt")})`,
    );
  }
}

export async function downUserPasswordHistoryPolicy(): Promise<void> {
  throw new Error(
    "Migration user_password_history_policy cannot be rolled back safely because password history and password-change audit timestamps must not be deleted.",
  );
}
