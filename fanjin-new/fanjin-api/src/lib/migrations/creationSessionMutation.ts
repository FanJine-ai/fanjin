import type { Knex } from "knex";

export const CREATION_SESSION_MUTATION_TABLE = "o_creation_session_mutation";

export const CREATION_SESSION_MUTATION_SCOPE_INDEX =
  "idx_o_creation_session_mutation_scope_version";
export const CREATION_SESSION_MUTATION_RUN_INDEX =
  "idx_o_creation_session_mutation_run_step";
export const CREATION_SESSION_MUTATION_UNDO_INDEX =
  "idx_o_creation_session_mutation_undo_of";

/**
 * Immutable R1 mutation journal for CreationSession updates and one-time undo.
 * Session data already has a version column; this migration only adds durable
 * recovery evidence without changing legacy session rows.
 */
export async function upCreationSessionMutation(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable("o_creation_session"))) {
    throw new Error("Migration creation_session_mutation requires o_creation_session");
  }
  if (await trx.schema.hasTable(CREATION_SESSION_MUTATION_TABLE)) return;

  await trx.schema.createTable(CREATION_SESSION_MUTATION_TABLE, (table) => {
    table.text("mutationId").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.text("sessionId").notNullable();
    table.text("runId").notNullable();
    table.text("stepId").notNullable();
    table.bigInteger("actorUserId").notNullable();
    table.text("operation").notNullable();
    table.bigInteger("baseVersion").notNullable();
    table.bigInteger("newVersion").notNullable();
    table.text("changedFields").notNullable().defaultTo("[]");
    table.text("beforeSnapshot").notNullable();
    table.text("afterSnapshot").notNullable();
    table.text("undoOfMutationId");
    table.text("undoneByMutationId");
    table.bigInteger("createdAt").notNullable();
    table.index(
      ["workspaceId", "projectId", "sessionId", "newVersion"],
      CREATION_SESSION_MUTATION_SCOPE_INDEX,
    );
    table.unique(["runId", "stepId"], CREATION_SESSION_MUTATION_RUN_INDEX);
    table.index(["undoOfMutationId"], CREATION_SESSION_MUTATION_UNDO_INDEX);
  });
}

export async function downCreationSessionMutation(): Promise<void> {
  throw new Error(
    "Migration creation_session_mutation cannot be rolled back safely because session undo audit records are durable concurrency evidence.",
  );
}
