import type { Knex } from "knex";
import { isPostgresClient, quoteSqlIdentifier, rawRows } from "@/lib/dbDialect";

const PROJECT_TABLE = "o_project";
const CANVAS_TABLE = "o_workflow_graph";
const SCRIPT_TABLE = "o_script";

const PROJECT_FOREIGN_KEY = "fk_o_workflow_graph_project";
const CANVAS_PROJECT_INSERT_TRIGGER = "trg_o_workflow_graph_project_insert";
const CANVAS_PROJECT_UPDATE_TRIGGER = "trg_o_workflow_graph_project_update";
const PROJECT_CANVAS_DELETE_TRIGGER = "trg_o_project_canvas_delete";
const PROJECT_CANVAS_UPDATE_TRIGGER = "trg_o_project_canvas_update";

type LegacyCanvasScope = {
  id: unknown;
  episodesId: unknown;
};

async function unresolvedCanvasScopes(
  trx: Knex.Transaction,
  hasEpisodesId: boolean,
): Promise<LegacyCanvasScope[]> {
  const rows = await trx(`${CANVAS_TABLE} as canvas`)
    .leftJoin(`${PROJECT_TABLE} as project`, "project.id", "canvas.projectId")
    .where((builder) => {
      builder.whereNull("canvas.projectId").orWhereNull("project.id");
    })
    .select(hasEpisodesId ? ["canvas.id", "canvas.episodesId"] : ["canvas.id"]);
  return rows.map((row: any) => ({
    id: row.id,
    episodesId: hasEpisodesId ? row.episodesId : null,
  }));
}

/**
 * Historical workflow rows used `episodesId` as the script/episode key. Use
 * that durable relationship to recover the canonical project association.
 * Rows without unambiguous ownership fail the migration instead of being
 * assigned to a default workspace, which could expose a canvas cross-tenant.
 */
async function backfillLegacyCanvasProjects(trx: Knex.Transaction): Promise<void> {
  const hasEpisodesId = await trx.schema.hasColumn(CANVAS_TABLE, "episodesId");
  const unresolved = await unresolvedCanvasScopes(trx, hasEpisodesId);
  if (!unresolved.length) return;

  const canUseScripts = await trx.schema.hasTable(SCRIPT_TABLE)
    && await trx.schema.hasColumn(SCRIPT_TABLE, "id")
    && await trx.schema.hasColumn(SCRIPT_TABLE, "projectId")
    && hasEpisodesId;

  if (canUseScripts) {
    const episodeIds = Array.from(new Set<string>(
      unresolved
        .map((row) => row.episodesId)
        .filter((value) => value !== null && value !== undefined && value !== "")
        .map(String),
    ));
    if (episodeIds.length) {
      const scriptScopes = await trx(`${SCRIPT_TABLE} as script`)
        .innerJoin(`${PROJECT_TABLE} as project`, "project.id", "script.projectId")
        .whereIn("script.id", episodeIds)
        .select("script.id as episodeId", "script.projectId");
      const projectByEpisode = new Map(
        scriptScopes.map((row: any) => [String(row.episodeId), row.projectId]),
      );
      for (const canvas of unresolved) {
        const projectId = projectByEpisode.get(String(canvas.episodesId));
        if (projectId === undefined) continue;
        await trx(CANVAS_TABLE).where({ id: canvas.id }).update({ projectId });
      }
    }
  }

  const remaining = await unresolvedCanvasScopes(trx, hasEpisodesId);
  if (remaining.length) {
    const sample = remaining
      .slice(0, 20)
      .map((row) => `${String(row.id)}(episodesId=${String(row.episodesId ?? "null")})`)
      .join(", ");
    throw new Error(
      `Migration unified_project_canvas cannot associate legacy canvases with an existing project: ${sample}`,
    );
  }
}

async function ensurePostgresProjectConstraint(trx: Knex.Transaction): Promise<void> {
  const canvasTable = quoteSqlIdentifier(CANVAS_TABLE);
  const projectTable = quoteSqlIdentifier(PROJECT_TABLE);
  const projectId = quoteSqlIdentifier("projectId");
  const id = quoteSqlIdentifier("id");
  const constraint = quoteSqlIdentifier(PROJECT_FOREIGN_KEY);

  await trx.raw(
    `ALTER TABLE ${canvasTable} ALTER COLUMN ${projectId} SET NOT NULL`,
  );
  const constraintResult = await trx.raw(
    `SELECT 1
       FROM pg_catalog.pg_constraint
      WHERE conname = ?
        AND conrelid = ?::regclass
      LIMIT 1`,
    [PROJECT_FOREIGN_KEY, CANVAS_TABLE],
  );
  if (!rawRows(constraintResult).length) {
    await trx.raw(
      `ALTER TABLE ${canvasTable}
       ADD CONSTRAINT ${constraint}
       FOREIGN KEY (${projectId}) REFERENCES ${projectTable}(${id})
       ON UPDATE CASCADE ON DELETE CASCADE`,
    );
  }
}

/**
 * SQLite cannot add a foreign key or a NOT NULL flag to an existing column
 * without rebuilding the whole table (which would risk indexes and triggers).
 * These triggers are the equivalent invariant and remain active regardless of
 * the connection-level `PRAGMA foreign_keys` setting.
 */
async function ensureSqliteProjectConstraint(trx: Knex.Transaction): Promise<void> {
  const canvasTable = quoteSqlIdentifier(CANVAS_TABLE);
  const projectTable = quoteSqlIdentifier(PROJECT_TABLE);
  const insertTrigger = quoteSqlIdentifier(CANVAS_PROJECT_INSERT_TRIGGER);
  const updateTrigger = quoteSqlIdentifier(CANVAS_PROJECT_UPDATE_TRIGGER);
  const deleteTrigger = quoteSqlIdentifier(PROJECT_CANVAS_DELETE_TRIGGER);
  const projectUpdateTrigger = quoteSqlIdentifier(PROJECT_CANVAS_UPDATE_TRIGGER);

  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${insertTrigger}
    BEFORE INSERT ON ${canvasTable}
    FOR EACH ROW
    WHEN NEW."projectId" IS NULL
      OR NOT EXISTS (SELECT 1 FROM ${projectTable} WHERE "id" = NEW."projectId")
    BEGIN
      SELECT RAISE(ABORT, '${CANVAS_TABLE}.projectId must reference an existing ${PROJECT_TABLE}');
    END
  `);
  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
    BEFORE UPDATE OF "projectId" ON ${canvasTable}
    FOR EACH ROW
    WHEN NEW."projectId" IS NULL
      OR NOT EXISTS (SELECT 1 FROM ${projectTable} WHERE "id" = NEW."projectId")
    BEGIN
      SELECT RAISE(ABORT, '${CANVAS_TABLE}.projectId must reference an existing ${PROJECT_TABLE}');
    END
  `);
  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${deleteTrigger}
    BEFORE DELETE ON ${projectTable}
    FOR EACH ROW
    BEGIN
      DELETE FROM ${canvasTable} WHERE "projectId" = OLD."id";
    END
  `);
  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${projectUpdateTrigger}
    AFTER UPDATE OF "id" ON ${projectTable}
    FOR EACH ROW
    WHEN NEW."id" <> OLD."id"
    BEGIN
      UPDATE ${canvasTable} SET "projectId" = NEW."id" WHERE "projectId" = OLD."id";
    END
  `);
}

export async function upUnifiedProjectCanvas(trx: Knex.Transaction): Promise<void> {
  const hasProjects = await trx.schema.hasTable(PROJECT_TABLE);
  const hasCanvases = await trx.schema.hasTable(CANVAS_TABLE);
  if (hasCanvases && !hasProjects) {
    throw new Error(`Migration unified_project_canvas requires ${PROJECT_TABLE}`);
  }

  if (hasProjects) {
    if (!(await trx.schema.hasColumn(PROJECT_TABLE, "coverImageUrl"))) {
      await trx.schema.alterTable(PROJECT_TABLE, (table) => {
        table.text("coverImageUrl");
      });
    }
  }

  if (hasCanvases) {
    if (!(await trx.schema.hasColumn(CANVAS_TABLE, "projectId"))) {
      await trx.schema.alterTable(CANVAS_TABLE, (table) => {
        table.bigInteger("projectId");
      });
    }
    if (!(await trx.schema.hasColumn(CANVAS_TABLE, "coverImageUrl"))) {
      await trx.schema.alterTable(CANVAS_TABLE, (table) => {
        table.text("coverImageUrl");
      });
    }
    if (!(await trx.schema.hasColumn(CANVAS_TABLE, "groups"))) {
      await trx.schema.alterTable(CANVAS_TABLE, (table) => {
        table.text("groups").notNullable().defaultTo("[]");
      });
    }

  }
}

/**
 * Follow-up invariant migration for installations that already applied the
 * original unified-project schema migration. Keep this separate from
 * `upUnifiedProjectCanvas`: migration 23 has shipped and its checksum must
 * remain immutable.
 */
export async function upEnforceUnifiedProjectCanvas(trx: Knex.Transaction): Promise<void> {
  const hasProjects = await trx.schema.hasTable(PROJECT_TABLE);
  const hasCanvases = await trx.schema.hasTable(CANVAS_TABLE);
  if (hasCanvases && !hasProjects) {
    throw new Error(`Migration enforce_unified_project_canvas requires ${PROJECT_TABLE}`);
  }
  if (!hasCanvases) return;
  if (!(await trx.schema.hasColumn(CANVAS_TABLE, "projectId"))) {
    throw new Error(`Migration enforce_unified_project_canvas requires ${CANVAS_TABLE}.projectId`);
  }

  await backfillLegacyCanvasProjects(trx);
  if (isPostgresClient(trx)) {
    await ensurePostgresProjectConstraint(trx);
  } else {
    await ensureSqliteProjectConstraint(trx);
  }
}

export async function downUnifiedProjectCanvas(): Promise<void> {
  throw new Error(
    "Migration unified_project_canvas cannot be rolled back safely after project covers or canvas groups have been saved.",
  );
}

export async function downEnforceUnifiedProjectCanvas(): Promise<void> {
  throw new Error(
    "Migration enforce_unified_project_canvas cannot be rolled back safely after project relationships have been enforced.",
  );
}
