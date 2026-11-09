import type { Knex } from "knex";

import {
  isPostgresClient,
  quoteSqlIdentifier,
} from "@/lib/dbDialect";

export const ACTIVE_PROJECT_WRITE_GUARD_FUNCTION =
  "fanjin_require_active_project";

export const ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_TARGETS = Object.freeze([
  Object.freeze({
    table: "o_media_asset",
    trigger: "trg_media_asset_active_project_write",
    requiredColumns: Object.freeze(["projectId", "workspaceId"]),
  }),
  Object.freeze({
    table: "o_user_video_enhance_task",
    trigger: "trg_user_video_enhance_task_active_project_write",
    requiredColumns: Object.freeze(["projectId", "workspaceId", "status"]),
  }),
] as const);

const REQUIRED_PROJECT_COLUMNS = Object.freeze([
  "id",
  "workspaceId",
  "deletionState",
  "deletionOperationId",
  "deletionRequestedAt",
  "deletionFinalizeFence",
] as const);

const REQUIRED_OPERATION_COLUMNS = Object.freeze([
  "id",
  "kind",
  "workspaceId",
  "projectId",
  "resourceId",
  "requestedAt",
  "status",
  "coordinatorLeaseOwner",
  "coordinatorFence",
  "coordinatorLeaseExpiresAt",
] as const);

async function requireColumns(
  trx: Knex.Transaction,
  tableName: string,
  columns: readonly string[],
): Promise<void> {
  if (!(await trx.schema.hasTable(tableName))) {
    throw new Error(
      `Migration active_project_trigger_row_shape_repair requires table ${tableName}`,
    );
  }
  for (const columnName of columns) {
    if (!(await trx.schema.hasColumn(tableName, columnName))) {
      throw new Error(
        `Migration active_project_trigger_row_shape_repair requires column ${tableName}.${columnName}`,
      );
    }
  }
}

/**
 * PostgreSQL compiles a trigger function against each trigger row type.
 * Keeping NEW.status behind a PL/pgSQL IF block scoped to the enhance-task
 * table prevents media-asset rows (which have no status column) from failing
 * with SQLSTATE 42703. This is intentionally an immutable copy of the v37
 * repair body rather than a call back into the already-applied v35 migration.
 */
export async function upActiveProjectTriggerRowShapeRepair(
  trx: Knex.Transaction,
): Promise<void> {
  if (!isPostgresClient(trx)) return;

  await requireColumns(trx, "o_project", REQUIRED_PROJECT_COLUMNS);
  await requireColumns(
    trx,
    "o_deletion_operation",
    REQUIRED_OPERATION_COLUMNS,
  );
  for (const target of ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_TARGETS) {
    await requireColumns(trx, target.table, target.requiredColumns);
  }

  const writeFunction = quoteSqlIdentifier(
    ACTIVE_PROJECT_WRITE_GUARD_FUNCTION,
  );
  const operationTable = quoteSqlIdentifier("o_deletion_operation");
  await trx.raw(`
    CREATE OR REPLACE FUNCTION ${writeFunction}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      project_state text;
      project_workspace_id text;
      target_project_id bigint;
      target_workspace_id text;
      project_finalizer_live boolean;
    BEGIN
      target_project_id := CASE
        WHEN TG_OP = 'DELETE' THEN OLD."projectId"
        ELSE NEW."projectId"
      END;
      IF TG_NARGS > 0 AND TG_ARGV[0] = 'workspace' THEN
        target_workspace_id := CASE
          WHEN TG_OP = 'DELETE' THEN OLD."workspaceId"
          ELSE NEW."workspaceId"
        END;
      END IF;
      IF TG_TABLE_NAME = 'o_user_video_enhance_task' THEN
        IF (
          (TG_OP = 'INSERT' AND NEW."projectId" IS NULL)
          OR (
            TG_OP = 'UPDATE'
            AND NEW."projectId" IS NULL
            AND NEW."status" IN ('created', 'enhancing')
          )
        ) THEN
          RAISE EXCEPTION 'active user enhance task requires project ownership'
            USING ERRCODE = '55000';
        END IF;
      END IF;
      IF target_project_id IS NOT NULL THEN
        project_state := NULL;
        project_workspace_id := NULL;
        project_finalizer_live := FALSE;
        SELECT
          project."deletionState",
          project."workspaceId",
          (
            project."deletionState" <> 'finalizing'
            OR EXISTS (
              SELECT 1
              FROM ${operationTable} AS operation
              WHERE operation."id" = project."deletionOperationId"
                AND operation."kind" = 'project'
                AND operation."workspaceId" = project."workspaceId"
                AND operation."projectId" = project."id"
                AND operation."resourceId" = project."id"::text
                AND operation."requestedAt" =
                  project."deletionRequestedAt"
                AND operation."status" = 'deleting'
                AND operation."coordinatorLeaseOwner" IS NOT NULL
                AND operation."coordinatorFence" =
                  project."deletionFinalizeFence"
                AND operation."coordinatorLeaseExpiresAt"
                  > floor(
                    extract(epoch FROM clock_timestamp()) * 1000
                  )
            )
          )
        INTO
          project_state,
          project_workspace_id,
          project_finalizer_live
        FROM "o_project" AS project
        WHERE project."id" = target_project_id
        FOR SHARE OF project;
        IF TG_NARGS > 0
          AND TG_ARGV[0] = 'workspace'
          AND target_workspace_id IS DISTINCT FROM project_workspace_id
        THEN
          RAISE EXCEPTION 'project workspace ownership mismatch'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF project_state IS NULL
            OR project_state NOT IN ('active', 'finalizing')
            OR (
              project_state = 'finalizing'
              AND NOT project_finalizer_live
            )
          THEN
            RAISE EXCEPTION 'project is not active'
              USING ERRCODE = '55000';
          END IF;
        ELSIF TG_OP = 'INSERT' AND project_state IS DISTINCT FROM 'active' THEN
          RAISE EXCEPTION 'project is not active' USING ERRCODE = '55000';
        ELSIF TG_OP = 'UPDATE'
          AND (
            project_state IS NULL
            OR project_state NOT IN ('active', 'finalizing')
            OR (
              project_state = 'finalizing'
              AND NOT project_finalizer_live
            )
          )
        THEN
          RAISE EXCEPTION 'project is not active' USING ERRCODE = '55000';
        END IF;
      END IF;
      IF (
        TG_OP = 'UPDATE'
        AND OLD."projectId" IS NOT NULL
        AND OLD."projectId" IS DISTINCT FROM NEW."projectId"
      ) THEN
        project_state := NULL;
        project_finalizer_live := FALSE;
        SELECT
          project."deletionState",
          (
            project."deletionState" <> 'finalizing'
            OR EXISTS (
              SELECT 1
              FROM ${operationTable} AS operation
              WHERE operation."id" = project."deletionOperationId"
                AND operation."kind" = 'project'
                AND operation."workspaceId" = project."workspaceId"
                AND operation."projectId" = project."id"
                AND operation."resourceId" = project."id"::text
                AND operation."requestedAt" =
                  project."deletionRequestedAt"
                AND operation."status" = 'deleting'
                AND operation."coordinatorLeaseOwner" IS NOT NULL
                AND operation."coordinatorFence" =
                  project."deletionFinalizeFence"
                AND operation."coordinatorLeaseExpiresAt"
                  > floor(
                    extract(epoch FROM clock_timestamp()) * 1000
                  )
            )
          )
        INTO project_state, project_finalizer_live
        FROM "o_project" AS project
        WHERE project."id" = OLD."projectId"
        FOR SHARE OF project;
        IF project_state IS NULL
          OR project_state NOT IN ('active', 'finalizing')
          OR (
            project_state = 'finalizing'
            AND NOT project_finalizer_live
          )
        THEN
          RAISE EXCEPTION 'project is not active' USING ERRCODE = '55000';
        END IF;
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$
  `);

  for (const target of ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_TARGETS) {
    const table = quoteSqlIdentifier(target.table);
    const trigger = quoteSqlIdentifier(target.trigger);
    await trx.raw(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    await trx.raw(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${writeFunction}('workspace')
    `);
  }
}

export async function downActiveProjectTriggerRowShapeRepair(): Promise<void> {
  throw new Error(
    "Migration active_project_trigger_row_shape_repair cannot be rolled back safely because restoring the old trigger function reintroduces PostgreSQL row-shape failures.",
  );
}
