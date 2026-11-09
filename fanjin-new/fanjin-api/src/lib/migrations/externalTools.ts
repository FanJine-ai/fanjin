import type { Knex } from "knex";
export const TOOL_UPLOAD_TABLE = "o_external_tool_upload";
export const EXTERNAL_TOOL_TABLE = "o_external_tool_operation";
export async function upExternalTools(trx: Knex.Transaction) {
  await trx.schema.createTable(TOOL_UPLOAD_TABLE, t => {
    t.text("id").primary(); t.text("workspaceId").notNullable(); t.bigInteger("projectId").notNullable();
    t.bigInteger("userId").notNullable(); t.text("keyId").notNullable(); t.text("resumeGrant").notNullable(); t.bigInteger("createdAt").notNullable();
    t.index(["workspaceId", "keyId", "projectId"], "idx_external_tool_upload_scope");
  });
  await trx.schema.createTable(EXTERNAL_TOOL_TABLE, t => {
    t.text("id").primary(); t.text("workspaceId").notNullable(); t.text("keyId").notNullable();
    t.bigInteger("userId").notNullable(); t.bigInteger("projectId");
    t.text("kind").notNullable(); t.text("idempotencyKey").notNullable(); t.text("requestHash").notNullable();
    t.text("requestJson").notNullable(); t.text("resultJson"); t.text("status").notNullable();
    t.text("uploadId"); t.index(["workspaceId", "keyId", "uploadId"], "idx_external_tool_upload");
    t.text("errorCode"); t.text("relayTaskId"); t.text("claimedBy");
    t.bigInteger("expiresAt"); t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    t.unique(["workspaceId", "keyId", "kind", "idempotencyKey"], "uq_external_tool_request");
    t.index(["workspaceId", "keyId", "projectId", "kind", "createdAt"], "idx_external_tool_scope");
    t.index(["kind", "status", "updatedAt"], "idx_external_tool_queue");
  });
}
export async function downExternalTools(): Promise<void> {
  throw new Error("External tools cannot be rolled back safely: authorization and dispatch evidence must not be deleted.");
}
