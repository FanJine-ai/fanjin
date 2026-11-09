import type { Knex } from "knex";
import { tableColumns } from "@/lib/dbDialect";

const USER_TABLE = "o_user";

export async function upEmailVerifiedAt(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(USER_TABLE))) return;
  const columns = await tableColumns(trx, USER_TABLE);
  if (!columns.includes("emailVerifiedAt")) {
    await trx.schema.alterTable(USER_TABLE, (table) => {
      table.bigInteger("emailVerifiedAt");
    });
  }
  // Pre-launch: do not backfill historical users. New self-service registrations keep null.
}

export async function downEmailVerifiedAt(): Promise<void> {
  throw new Error(
    "Migration email_verified_at cannot be rolled back safely because verification timestamps must not be dropped.",
  );
}
