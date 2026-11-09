import type { Knex } from "knex";

export const AGENT_GENERATION_REVIEW_TABLE = "o_agent_generation_review";
export const AGENT_GENERATION_REVIEW_SCOPE_INDEX = "idx_o_agent_generation_review_scope_created";
export const AGENT_GENERATION_REVIEW_ATTENTION_INDEX = "idx_o_agent_generation_review_attention";
export const AGENT_GENERATION_REVIEW_REPLAY_INDEX = "idx_o_agent_generation_review_replay";

/**
 * Agent 生成质量门(REVAMP-PLAN 2.3,一期规则版)的结构化审核记录。
 *
 * 与 o_agent_review_report(A4 Reviewer 报告)的关系:A4 报告只能由 running
 * 的 reviewer 委派 Run 经 `review.report.create` Tool Step 追加
 * (reviewReportService.loadReviewerAccess),规则版质量门在 generation submit
 * 工具 execute 内同步执行、没有 Reviewer Run/Step 上下文,无法合法复用 A4 写
 * 路径,故一期使用本轻量表;二期模型版走既有 A4 委派链路,两套记录按
 * subject/runId 互相关联(engine 列区分来源)。
 *
 * (runId, stepId, engine) 唯一:工具 Step 幂等重放/事务重试时重复评审安全,
 * 同一 Step 允许规则版与二期模型版各留一条记录。
 */
export async function upAgentGenerationReview(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(AGENT_GENERATION_REVIEW_TABLE)) return;
  await trx.schema.createTable(AGENT_GENERATION_REVIEW_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.text("runId").notNullable();
    table.text("stepId").notNullable();
    table.text("toolId").notNullable();
    table.text("generationType").notNullable();
    table.text("quoteId");
    table.text("engine").notNullable();
    table.text("verdict").notNullable();
    table.text("checksJson").notNullable();
    table.text("subjectJson").notNullable();
    table.bigInteger("needsHumanAttention").notNullable().defaultTo(0);
    table.bigInteger("createdAt").notNullable();
    table.index(
      ["workspaceId", "projectId", "createdAt", "id"],
      AGENT_GENERATION_REVIEW_SCOPE_INDEX,
    );
    table.index(["needsHumanAttention", "createdAt"], AGENT_GENERATION_REVIEW_ATTENTION_INDEX);
    table.unique(["runId", "stepId", "engine"], AGENT_GENERATION_REVIEW_REPLAY_INDEX);
  });
}

export async function downAgentGenerationReview(): Promise<void> {
  throw new Error(
    "Migration agent_generation_review cannot be rolled back safely because generation review records are quality audit evidence.",
  );
}
