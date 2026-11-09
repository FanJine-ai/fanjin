import type { Knex } from "knex";
import { isPostgresClient } from "@/lib/dbDialect";

const TABLES = ["o_portrait_identity", "o_portrait_admission"] as const;

// Add a routing-only state without rewriting prior user declarations or their
// evidence. Historical migration identities and checksums are unchanged.
export async function upPortraitAutomaticRegistration(trx: Knex.Transaction): Promise<void> {
  const postgres = isPostgresClient(trx);
  const originalDeferral = postgres ? null : (await trx.raw("PRAGMA defer_foreign_keys"))[0]?.defer_foreign_keys;
  for (const table of TABLES) {
    const constraint = table === "o_portrait_identity" ? "chk_o_portrait_identity_state" : "chk_o_portrait_admission_state";
    if (postgres) {
      const result = await trx.raw(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?`, [table, constraint]);
      const definition = String(result.rows[0]?.definition || "");
      if (!definition.includes("'virtual_person'::text")) throw new Error("PORTRAIT_ROUTING_CONSTRAINT_MISSING");
      if (definition.includes("'detected_person'::text")) continue;
      const revised = definition.replace("'virtual_person'::text", "'virtual_person'::text, 'detected_person'::text");
      await trx.raw(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}", ADD CONSTRAINT "${constraint}" ${revised}`);
    } else {
      const row = await trx("sqlite_master").where({ type: "table", name: table }).first("sql");
      const sql = String(row?.sql || "");
      if (!sql.includes("'virtual_person'")) throw new Error("PORTRAIT_ROUTING_CONSTRAINT_MISSING");
      if (sql.includes("'detected_person'")) continue;
      const replacement = `${table}_routing_v55`;
      const retained = await trx("sqlite_master").where({ tbl_name: table }).whereIn("type", ["index", "trigger"]).whereNotNull("sql");
      const revised = sql.replace("'virtual_person'", "'virtual_person', 'detected_person'")
        .replace(/^CREATE TABLE (?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_]\w*)/iu, `CREATE TABLE "${replacement}"`);
      if (!revised.startsWith(`CREATE TABLE "${replacement}"`)) throw new Error("PORTRAIT_ROUTING_TABLE_SHAPE_INVALID");
      await trx.raw("PRAGMA defer_foreign_keys = ON");
      await trx.raw(revised);
      await trx.raw(`INSERT INTO "${replacement}" SELECT * FROM "${table}"`);
      await trx.raw(`DROP TABLE "${table}"`);
      await trx.raw(`ALTER TABLE "${replacement}" RENAME TO "${table}"`);
      for (const item of retained) await trx.raw(String(item.sql));
    }
  }
  if (!postgres) {
    const violations = await trx.raw("PRAGMA foreign_key_check");
    if (violations.length) throw new Error("PORTRAIT_ROUTING_FOREIGN_KEY_INVALID");
    // SQLite retains a deferred violation counter when a referenced table is
    // rebuilt. Reset it only after independently checking the complete graph.
    await trx.raw("PRAGMA defer_foreign_keys = OFF");
    if (originalDeferral) await trx.raw("PRAGMA defer_foreign_keys = ON");
  }
}

export async function downPortraitAutomaticRegistration(): Promise<void> {
  throw new Error("Automatic portrait registration rows require schema 55; restore the database backup to revert this migration.");
}
