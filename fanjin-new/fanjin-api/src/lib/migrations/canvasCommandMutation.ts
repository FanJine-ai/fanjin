import type { Knex } from "knex";
import { isPostgresClient, quoteSqlIdentifier } from "@/lib/dbDialect";

export const CANVAS_COMMAND_CANVAS_TABLE = "o_workflow_graph";
export const CANVAS_COMMAND_MUTATION_TABLE = "o_canvas_command_mutation";

export const CANVAS_COMMAND_MUTATION_SCOPE_KEY_INDEX =
  "uq_o_canvas_cmd_mutation_scope_key";
export const CANVAS_COMMAND_MUTATION_SCOPE_REVISION_INDEX =
  "idx_o_canvas_cmd_mutation_scope_rev";
export const CANVAS_COMMAND_MUTATION_ACTOR_INDEX =
  "idx_o_canvas_cmd_mutation_actor";

const CANVAS_COMMAND_MUTATION_NO_UPDATE_TRIGGER =
  "trg_o_canvas_cmd_mutation_no_update";
const CANVAS_COMMAND_MUTATION_NO_DELETE_TRIGGER =
  "trg_o_canvas_cmd_mutation_no_delete";
const CANVAS_COMMAND_MUTATION_IMMUTABLE_FUNCTION =
  "fanjin_reject_canvas_cmd_mutation";

export async function ensureCanvasCommandMutationAppendOnlyGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  const table = quoteSqlIdentifier(CANVAS_COMMAND_MUTATION_TABLE);
  if (isPostgresClient(database)) {
    const trigger = quoteSqlIdentifier(CANVAS_COMMAND_MUTATION_NO_UPDATE_TRIGGER);
    const fn = quoteSqlIdentifier(CANVAS_COMMAND_MUTATION_IMMUTABLE_FUNCTION);
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${fn}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION '${CANVAS_COMMAND_MUTATION_TABLE} is append-only' USING ERRCODE = '55000';
      END;
      $$
    `);
    await database.raw(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    await database.raw(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${fn}()
    `);
    return;
  }

  const updateTrigger = quoteSqlIdentifier(CANVAS_COMMAND_MUTATION_NO_UPDATE_TRIGGER);
  const deleteTrigger = quoteSqlIdentifier(CANVAS_COMMAND_MUTATION_NO_DELETE_TRIGGER);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
    BEFORE UPDATE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${CANVAS_COMMAND_MUTATION_TABLE} is append-only');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${deleteTrigger}
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${CANVAS_COMMAND_MUTATION_TABLE} is append-only');
    END
  `);
}

/**
 * Adds the optimistic-concurrency fence used by structured Canvas commands
 * and an immutable-by-API mutation journal containing bounded undo evidence.
 */
export async function upCanvasCommandMutation(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(CANVAS_COMMAND_CANVAS_TABLE))) {
    throw new Error("Migration canvas_command_mutation requires o_workflow_graph");
  }

  if (!(await trx.schema.hasColumn(CANVAS_COMMAND_CANVAS_TABLE, "revision"))) {
    await trx.schema.alterTable(CANVAS_COMMAND_CANVAS_TABLE, (table) => {
      table.bigInteger("revision").notNullable().defaultTo(1);
    });
  }

  await trx(CANVAS_COMMAND_CANVAS_TABLE)
    .whereNull("revision")
    .orWhere("revision", "<", 1)
    .update({ revision: 1 });

  if (!(await trx.schema.hasTable(CANVAS_COMMAND_MUTATION_TABLE))) {
    await trx.schema.createTable(CANVAS_COMMAND_MUTATION_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.bigInteger("canvasId").notNullable();
      table.bigInteger("actorUserId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable();
      table.bigInteger("baseRevision").notNullable();
      table.bigInteger("newRevision").notNullable();
      table.text("baseVersion").notNullable();
      table.text("newVersion").notNullable();
      table.text("commandSetJson").notNullable();
      table.text("beforeSnapshot").notNullable();
      table.text("afterSnapshot").notNullable();
      table.text("resultJson").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.unique(
        ["workspaceId", "projectId", "canvasId", "idempotencyKey"],
        CANVAS_COMMAND_MUTATION_SCOPE_KEY_INDEX,
      );
      table.index(
        ["workspaceId", "projectId", "canvasId", "newRevision"],
        CANVAS_COMMAND_MUTATION_SCOPE_REVISION_INDEX,
      );
      table.index(
        ["workspaceId", "actorUserId", "createdAt"],
        CANVAS_COMMAND_MUTATION_ACTOR_INDEX,
      );
    });
  }
  await ensureCanvasCommandMutationAppendOnlyGuards(trx);
}

export async function downCanvasCommandMutation(): Promise<void> {
  throw new Error(
    "Migration canvas_command_mutation cannot be rolled back safely because Canvas revisions and undo audit evidence are durable concurrency records.",
  );
}
