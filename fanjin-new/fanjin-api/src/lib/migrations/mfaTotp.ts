import type { Knex } from "knex";
import { quoteSqlIdentifier, tableColumns, tableIndexRows } from "@/lib/dbDialect";

const SECURITY_TABLE = "o_account_security";
const RECOVERY_TABLE = "o_account_mfa_recovery_code";
const RECOVERY_INDEX = "idx_o_account_mfa_recovery_user_used";

export async function upMfaTotp(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(SECURITY_TABLE))) {
    await trx.schema.createTable(SECURITY_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.bigInteger("userId").notNullable().unique();
      table.text("phone");
      table.bigInteger("mfaEnabled").notNullable().defaultTo(0);
      table.text("mfaSecret");
      table.text("mfaPendingSecret");
      table.bigInteger("mfaPendingCreatedAt");
      table.bigInteger("mfaConfiguredAt");
      table.bigInteger("loginProtectionEnabled").notNullable().defaultTo(0);
      table.bigInteger("sensitiveOperationProtectionEnabled").notNullable().defaultTo(0);
      table.text("loginIpAllowlist").notNullable().defaultTo("");
      table.text("passwordPolicy").notNullable().defaultTo("{}");
      table.text("sessionPolicy").notNullable().defaultTo("{}");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
    });
  } else {
    const columns = new Set(await tableColumns(trx, SECURITY_TABLE));
    const additions = [
      ["mfaSecret", "text"],
      ["mfaPendingSecret", "text"],
      ["mfaPendingCreatedAt", "bigInteger"],
      ["mfaConfiguredAt", "bigInteger"],
    ] as const;
    for (const [column, type] of additions) {
      if (columns.has(column)) continue;
      await trx.schema.alterTable(SECURITY_TABLE, (table) => (table as any)[type](column));
    }
  }

  if (!(await trx.schema.hasTable(RECOVERY_TABLE))) {
    await trx.schema.createTable(RECOVERY_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.bigInteger("userId").notNullable();
      table.text("codeHash").notNullable().unique();
      table.bigInteger("usedAt");
      table.bigInteger("createdAt").notNullable();
    });
  }
  const indexes = await tableIndexRows(trx, RECOVERY_TABLE);
  if (!indexes.some((index) => index.name === RECOVERY_INDEX)) {
    await trx.raw(
      `CREATE INDEX ${quoteSqlIdentifier(RECOVERY_INDEX)} ON ${quoteSqlIdentifier(RECOVERY_TABLE)} (${quoteSqlIdentifier("userId")}, ${quoteSqlIdentifier("usedAt")})`,
    );
  }
}

export async function downMfaTotp(): Promise<void> {
  throw new Error(
    "Migration mfa_totp cannot be rolled back safely because removing MFA secrets or recovery-code hashes could lock users out or weaken authentication.",
  );
}
