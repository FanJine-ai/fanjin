import type { Knex } from "knex";
import { REFERENCE_MULTIPART_UPLOAD_TABLE as TABLE } from "./referenceMultipartUpload";
const constraint = "chk_o_reference_multipart_identity";
const oldTypes = '"mediaType" IN (\'image\', \'video\', \'audio\')';
const newTypes = '"mediaType" IN (\'image\', \'video\', \'audio\', \'document\')';
// Expand the type check only; keep every ownership, size, hash and terminal
// state invariant. The old migration identity is deliberately untouched.
export async function upReferenceDocumentUpload(tx: Knex.Transaction) {
  if (String(tx.client.config.client).includes("sqlite")) {
    const row = await tx("sqlite_master").where({ type: "table", name: TABLE }).first();
    if (!row?.sql?.includes(oldTypes)) throw new Error("Unexpected reference upload schema");
    const temp = `${TABLE}_documents_v61`;
    const indexes = await tx("sqlite_master").where({ tbl_name: TABLE }).whereIn("type", ["index", "trigger"]).whereNotNull("sql");
    const sql = row.sql.replace(/(CREATE TABLE\s+)([`"\[]?)o_reference_multipart_upload([`"\]]?)/i, `$1"${temp}"`).replace(oldTypes, newTypes);
    if (!sql.includes(`"${temp}"`)) throw new Error("Reference upload table rename failed");
    await tx.raw(sql);
    await tx.raw('INSERT INTO ?? SELECT * FROM ??', [temp, TABLE]);
    await tx.schema.dropTable(TABLE);
    await tx.schema.renameTable(temp, TABLE);
    for (const index of indexes) await tx.raw(index.sql);
  } else {
    const row = await tx.raw("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?", [TABLE, constraint]);
    const definition: string | undefined = row.rows?.[0]?.definition;
    if (!definition || !definition.includes("'audio'::text") || definition.includes("'document'::text")) throw new Error("Unexpected reference upload constraint");
    await tx.raw('ALTER TABLE ?? DROP CONSTRAINT ??', [TABLE, constraint]);
    await tx.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? ${definition.replace("'audio'::text", "'audio'::text, 'document'::text")}`, [TABLE, constraint]);
  }
}
export async function downReferenceDocumentUpload(): Promise<void> {
  throw new Error("Document upload records must be retained; schema downgrade is unsafe after a document upload. Use a schema-61 compatible binary.");
}
