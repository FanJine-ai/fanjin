import type { Knex } from "knex";

export const PROJECT_TABLE = "o_project";
export const PROJECT_MUTATION_TABLE = "o_project_mutation";

export const PROJECT_MUTATION_SCOPE_INDEX = "idx_o_project_mutation_scope_revision";
export const PROJECT_MUTATION_RUN_INDEX = "idx_o_project_mutation_run_step";
export const PROJECT_MUTATION_UNDO_INDEX = "idx_o_project_mutation_undo_of";

async function addProjectColumn(
  trx: Knex.Transaction,
  column: "revision" | "updatedAt",
  builder: (table: Knex.AlterTableBuilder) => void,
): Promise<void> {
  if (await trx.schema.hasColumn(PROJECT_TABLE, column)) return;
  await trx.schema.alterTable(PROJECT_TABLE, builder);
}

/**
 * Adds optimistic concurrency metadata to legacy projects and an immutable
 * Agent mutation journal. The defaults keep old insert paths safe while all
 * application edit paths move the revision forward atomically.
 */
export async function upProjectRevision(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(PROJECT_TABLE))) {
    throw new Error("Migration project_revision requires o_project");
  }

  await addProjectColumn(trx, "revision", (table) => {
    table.bigInteger("revision").notNullable().defaultTo(1);
  });
  await addProjectColumn(trx, "updatedAt", (table) => {
    table.bigInteger("updatedAt").notNullable().defaultTo(0);
  });

  await trx(PROJECT_TABLE)
    .whereNull("revision")
    .orWhere("revision", "<", 1)
    .update({ revision: 1 });

  const fallbackNow = Date.now();
  const hasCreateTime = await trx.schema.hasColumn(PROJECT_TABLE, "createTime");
  await trx(PROJECT_TABLE)
    .whereNull("updatedAt")
    .orWhere("updatedAt", "<=", 0)
    .update({
      updatedAt: hasCreateTime
        ? trx.raw("CASE WHEN ?? IS NOT NULL AND ?? > 0 THEN ?? ELSE ? END", [
            "createTime",
            "createTime",
            "createTime",
            fallbackNow,
          ])
        : fallbackNow,
    });

  if (!(await trx.schema.hasTable(PROJECT_MUTATION_TABLE))) {
    await trx.schema.createTable(PROJECT_MUTATION_TABLE, (table) => {
      table.text("mutationId").notNullable().primary();
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("runId").notNullable();
      table.text("stepId").notNullable();
      table.bigInteger("actorUserId").notNullable();
      table.text("operation").notNullable();
      table.bigInteger("baseRevision").notNullable();
      table.bigInteger("newRevision").notNullable();
      table.text("changedFields").notNullable().defaultTo("[]");
      table.text("beforeSnapshot").notNullable();
      table.text("afterSnapshot").notNullable();
      table.text("undoOfMutationId");
      table.text("undoneByMutationId");
      table.bigInteger("createdAt").notNullable();
      table.index(
        ["workspaceId", "projectId", "newRevision"],
        PROJECT_MUTATION_SCOPE_INDEX,
      );
      table.unique(["runId", "stepId"], PROJECT_MUTATION_RUN_INDEX);
      table.index(["undoOfMutationId"], PROJECT_MUTATION_UNDO_INDEX);
    });
  }
}

export async function downProjectRevision(): Promise<void> {
  throw new Error(
    "Migration project_revision cannot be rolled back safely because project revisions and undo audit records are durable concurrency evidence.",
  );
}
