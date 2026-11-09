import type { Knex } from "knex";
import { isPostgresClient, quoteSqlIdentifier } from "@/lib/dbDialect";

export const AGENT_REVIEW_REPORT_TABLE = "o_agent_review_report";
export const AGENT_REVIEW_REPORT_SCOPE_INDEX = "idx_o_agent_review_report_scope_created";
export const AGENT_REVIEW_REPORT_RUN_INDEX = "idx_o_agent_review_report_run_created";
export const AGENT_REVIEW_REPORT_SUBJECT_INDEX = "idx_o_agent_review_report_subject_created";
export const AGENT_REVIEW_REPORT_REPLAY_INDEX = "idx_o_agent_review_report_replay";

const AGENT_REVIEW_REPORT_NO_UPDATE_TRIGGER = "trg_o_agent_review_report_no_update";
const AGENT_REVIEW_REPORT_NO_DELETE_TRIGGER = "trg_o_agent_review_report_no_delete";
const AGENT_REVIEW_REPORT_IMMUTABLE_FUNCTION = "fanjin_reject_agent_review_report_mutation";

/**
 * Installs database-level guards so application mistakes cannot turn an
 * immutable Reviewer report into an updateable business object.
 */
export async function ensureAgentReviewReportAppendOnlyGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  const table = quoteSqlIdentifier(AGENT_REVIEW_REPORT_TABLE);
  if (isPostgresClient(database)) {
    const trigger = quoteSqlIdentifier(AGENT_REVIEW_REPORT_NO_UPDATE_TRIGGER);
    const fn = quoteSqlIdentifier(AGENT_REVIEW_REPORT_IMMUTABLE_FUNCTION);
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${fn}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION '${AGENT_REVIEW_REPORT_TABLE} is append-only' USING ERRCODE = '55000';
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

  const updateTrigger = quoteSqlIdentifier(AGENT_REVIEW_REPORT_NO_UPDATE_TRIGGER);
  const deleteTrigger = quoteSqlIdentifier(AGENT_REVIEW_REPORT_NO_DELETE_TRIGGER);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
    BEFORE UPDATE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${AGENT_REVIEW_REPORT_TABLE} is append-only');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${deleteTrigger}
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${AGENT_REVIEW_REPORT_TABLE} is append-only');
    END
  `);
}

export async function upAgentReviewReport(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(AGENT_REVIEW_REPORT_TABLE))) {
    await trx.schema.createTable(AGENT_REVIEW_REPORT_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("reviewerRunId").notNullable();
      table.text("reviewerStepId").notNullable();
      table.bigInteger("reportVersion").notNullable();
      table.text("canonicalHash").notNullable();
      table.text("subjectType").notNullable();
      table.text("subjectId").notNullable();
      table.text("subjectVersion").notNullable();
      table.text("reportJson").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.index(
        ["workspaceId", "projectId", "createdAt", "id"],
        AGENT_REVIEW_REPORT_SCOPE_INDEX,
      );
      table.index(["reviewerRunId", "createdAt", "id"], AGENT_REVIEW_REPORT_RUN_INDEX);
      table.index(
        ["workspaceId", "projectId", "subjectType", "subjectId", "subjectVersion", "createdAt"],
        AGENT_REVIEW_REPORT_SUBJECT_INDEX,
      );
      // A Tool Step may append exactly one immutable report. Exact replay is
      // returned by the service; changed content for the same Step conflicts.
      table.unique(["reviewerStepId"], AGENT_REVIEW_REPORT_REPLAY_INDEX);
    });
  }
  await ensureAgentReviewReportAppendOnlyGuards(trx);
}

export async function downAgentReviewReport(): Promise<void> {
  throw new Error(
    "Migration agent_review_report cannot be rolled back safely because Reviewer reports are immutable audit evidence.",
  );
}
