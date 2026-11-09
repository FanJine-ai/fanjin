import type { Knex } from "knex";

export const CANVAS_WORKFLOW_TEMPLATE_TABLE = "o_canvas_workflow_template";

export const CANVAS_WORKFLOW_TEMPLATE_INDEXES = {
  ownerUpdated: "idx_o_canvas_workflow_template_owner_updated",
  workspaceCreator: "idx_o_canvas_workflow_template_workspace_creator",
} as const;

export const CANVAS_WORKFLOW_TEMPLATE_REQUIRED_CONSTRAINTS = [
  `table:${CANVAS_WORKFLOW_TEMPLATE_TABLE}`,
  `column:${CANVAS_WORKFLOW_TEMPLATE_TABLE}.workspaceId`,
  `column:${CANVAS_WORKFLOW_TEMPLATE_TABLE}.createdBy`,
  `column:${CANVAS_WORKFLOW_TEMPLATE_TABLE}.groupSnapshot`,
  `index:${CANVAS_WORKFLOW_TEMPLATE_TABLE}.${CANVAS_WORKFLOW_TEMPLATE_INDEXES.ownerUpdated}`,
  `index:${CANVAS_WORKFLOW_TEMPLATE_TABLE}.${CANVAS_WORKFLOW_TEMPLATE_INDEXES.workspaceCreator}`,
] as const;

export function buildCanvasWorkflowTemplateTable(
  table: Knex.CreateTableBuilder,
): void {
  table.text("id").notNullable().primary();
  table.text("workspaceId").notNullable()
    .references("id")
    .inTable("o_workspace")
    .onUpdate("CASCADE")
    .onDelete("CASCADE");
  table.bigInteger("createdBy").notNullable()
    .references("id")
    .inTable("o_user")
    .onUpdate("CASCADE")
    .onDelete("CASCADE");
  table.text("name").notNullable();
  table.text("coverUrl").notNullable().defaultTo("");
  table.text("coverNodeId");
  table.text("note").notNullable().defaultTo("");
  table.text("groupSnapshot").notNullable();
  table.bigInteger("createdAt").notNullable();
  table.bigInteger("updatedAt").notNullable();
  table.index(
    ["workspaceId", "createdBy", "updatedAt", "id"],
    CANVAS_WORKFLOW_TEMPLATE_INDEXES.ownerUpdated,
  );
  table.index(
    ["workspaceId", "createdBy"],
    CANVAS_WORKFLOW_TEMPLATE_INDEXES.workspaceCreator,
  );
}

/**
 * User-owned reusable Canvas workflow templates.
 *
 * Workspace and creator foreign keys intentionally cascade: account/workspace
 * deletion cannot leave workflow rows orphaned, while normal reads and writes
 * still require both values as an explicit authority boundary.
 */
export async function upCanvasWorkflowTemplate(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(CANVAS_WORKFLOW_TEMPLATE_TABLE)) return;
  for (const requiredTable of ["o_workspace", "o_user"]) {
    if (!(await trx.schema.hasTable(requiredTable))) {
      throw new Error(
        `Migration canvas_workflow_template requires table ${requiredTable}`,
      );
    }
  }
  await trx.schema.createTable(
    CANVAS_WORKFLOW_TEMPLATE_TABLE,
    buildCanvasWorkflowTemplateTable,
  );
}

export async function downCanvasWorkflowTemplate(): Promise<void> {
  throw new Error(
    "Migration canvas_workflow_template cannot be rolled back safely because reusable Canvas workflows are durable user data.",
  );
}
