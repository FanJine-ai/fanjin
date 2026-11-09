import type { Knex } from "knex";
import { quoteSqlIdentifier, tableIndexRows } from "@/lib/dbDialect";

export const USER_OAUTH_IDENTITY_TABLE = "o_user_oauth_identity";
const PROVIDER_OPENID_INDEX = "uniq_o_user_oauth_identity_provider_openid";
const USER_PROVIDER_INDEX = "uniq_o_user_oauth_identity_user_provider";
const USER_INDEX = "idx_o_user_oauth_identity_user";

export async function upUserOauthIdentity(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(USER_OAUTH_IDENTITY_TABLE))) {
    await trx.schema.createTable(USER_OAUTH_IDENTITY_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.bigInteger("userId").notNullable();
      table.text("provider").notNullable();
      table.text("openId").notNullable();
      table.text("unionId");
      table.text("displayName");
      table.text("avatarUrl");
      table.text("rawProfile");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
    });
  }

  const indexes = await tableIndexRows(trx, USER_OAUTH_IDENTITY_TABLE);
  const hasIndex = (name: string) => indexes.some((index) => index.name === name);

  if (!hasIndex(PROVIDER_OPENID_INDEX)) {
    await trx.raw(
      `CREATE UNIQUE INDEX ${quoteSqlIdentifier(PROVIDER_OPENID_INDEX)} ON ${quoteSqlIdentifier(USER_OAUTH_IDENTITY_TABLE)} (${quoteSqlIdentifier("provider")}, ${quoteSqlIdentifier("openId")})`,
    );
  }
  if (!hasIndex(USER_PROVIDER_INDEX)) {
    await trx.raw(
      `CREATE UNIQUE INDEX ${quoteSqlIdentifier(USER_PROVIDER_INDEX)} ON ${quoteSqlIdentifier(USER_OAUTH_IDENTITY_TABLE)} (${quoteSqlIdentifier("userId")}, ${quoteSqlIdentifier("provider")})`,
    );
  }
  if (!hasIndex(USER_INDEX)) {
    await trx.raw(
      `CREATE INDEX ${quoteSqlIdentifier(USER_INDEX)} ON ${quoteSqlIdentifier(USER_OAUTH_IDENTITY_TABLE)} (${quoteSqlIdentifier("userId")})`,
    );
  }
}

export async function downUserOauthIdentity(): Promise<void> {
  throw new Error(
    "Migration user_oauth_identity cannot be rolled back safely because dropping linked identities would lock users out of third-party login.",
  );
}
