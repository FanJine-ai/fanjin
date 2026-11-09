import type { Knex } from "knex";

export const USER_FEEDBACK_TABLE = "o_user_feedback";
export const USER_FEEDBACK_ATTACHMENT_TABLE = "o_user_feedback_attachment";

export const USER_FEEDBACK_REQUIRED_CONSTRAINTS = [
  `table:${USER_FEEDBACK_TABLE}`,
  `table:${USER_FEEDBACK_ATTACHMENT_TABLE}`,
  `index:${USER_FEEDBACK_TABLE}.idx_o_user_feedback_sync_due`,
  `index:${USER_FEEDBACK_TABLE}.idx_o_user_feedback_workspace_created`,
  `index:${USER_FEEDBACK_ATTACHMENT_TABLE}.idx_o_user_feedback_attachment_feedback`,
] as const;

export async function upUserFeedback(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(USER_FEEDBACK_TABLE))) {
    await trx.schema.createTable(USER_FEEDBACK_TABLE, (table) => {
      table.text("id").primary();
      table.text("feedbackNo").notNullable().unique();
      table.bigInteger("userId").notNullable()
        .references("id").inTable("o_user").onUpdate("CASCADE").onDelete("RESTRICT");
      table.text("workspaceId").notNullable()
        .references("id").inTable("o_workspace").onUpdate("CASCADE").onDelete("RESTRICT");
      table.text("userLabel").notNullable();
      table.text("pageTitle").notNullable();
      table.text("pageUrl").notNullable();
      table.text("appOrigin").notNullable();
      table.text("description").notNullable();
      table.text("syncStatus").notNullable().defaultTo("pending");
      table.integer("syncAttempts").notNullable().defaultTo(0);
      table.bigInteger("nextSyncAt").notNullable();
      table.bigInteger("processingStartedAt");
      table.bigInteger("syncedAt");
      table.text("lastSyncError");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.index(["syncStatus", "nextSyncAt"], "idx_o_user_feedback_sync_due");
      table.index(["workspaceId", "createdAt"], "idx_o_user_feedback_workspace_created");
    });
  }

  if (!(await trx.schema.hasTable(USER_FEEDBACK_ATTACHMENT_TABLE))) {
    await trx.schema.createTable(USER_FEEDBACK_ATTACHMENT_TABLE, (table) => {
      table.text("id").primary();
      table.text("feedbackId").notNullable()
        .references("id").inTable(USER_FEEDBACK_TABLE).onUpdate("CASCADE").onDelete("CASCADE");
      table.text("storageKey").notNullable().unique();
      table.text("fileName").notNullable();
      table.text("mimeType").notNullable();
      table.bigInteger("sizeBytes").notNullable();
      table.text("sha256").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.index(["feedbackId", "createdAt"], "idx_o_user_feedback_attachment_feedback");
    });
  }
}

export async function downUserFeedback(): Promise<void> {
  throw new Error("Migration user_feedback cannot be rolled back safely because feedback is durable user data.");
}
