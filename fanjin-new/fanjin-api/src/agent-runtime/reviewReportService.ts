import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { REVIEWER_AGENT_ROLE } from "@/agent-runtime/contracts";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import {
  A4_REVIEW_REPORT_VERSION,
  A4ReviewReportContractError,
  createA4ReviewReport,
  normalizeA4ReviewReport,
  type A4ReviewReport,
} from "@/agent-runtime/reviewReportContracts";
import { AGENT_REVIEW_REPORT_TABLE } from "@/lib/migrations/agentReviewReport";

const IDENTIFIER_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PAGE_SIZE = 100;

export interface A4StoredReviewReport {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: number;
  readonly reviewerRunId: string;
  readonly reviewerStepId: string;
  readonly report: A4ReviewReport;
  readonly createdAt: number;
}

export interface AppendA4ReviewReportInput {
  workspaceId: string;
  projectId: number;
  reviewerRunId: string;
  reviewerStepId: string;
  /** V1 content or an already-hashed V1 report; persisted hashes are never repaired. */
  report: unknown;
}

export interface ReadA4ReviewReportInput {
  workspaceId: string;
  projectId: number;
  reviewerRunId: string;
  reportId: string;
}

export interface ListA4ReviewReportsInput {
  workspaceId: string;
  projectId: number;
  reviewerRunId: string;
  after?: string | null;
  limit?: number;
}

export interface A4ReviewReportPage {
  readonly data: readonly A4StoredReviewReport[];
  readonly nextCursor: string | null;
}

export interface A4ReviewReportServiceOptions {
  clock?: () => number;
  idFactory?: () => string;
}

interface RawReviewReportRow {
  id: string;
  workspaceId: string;
  projectId: number | string;
  reviewerRunId: string;
  reviewerStepId: string;
  reportVersion: number | string;
  canonicalHash: string;
  subjectType: string;
  subjectId: string;
  subjectVersion: string;
  reportJson: unknown;
  createdAt: number | string;
}

interface ReviewReportCursor {
  createdAt: number;
  id: string;
}

type ReviewReportOperation = "append" | "read";

interface ReviewerAccessState {
  runStatus: string;
  stepStatus: string | null;
}

function invalidInput(field: string): never {
  throw new AgentRuntimeError(400, "review_report_input_invalid", `${field} 格式无效`);
}

function cleanIdentifier(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200 || !IDENTIFIER_PATTERN.test(text)) invalidInput(field);
  return text;
}

function isCleanIdentifier(value: string): boolean {
  return Boolean(value) && value.length <= 200 && IDENTIFIER_PATTERN.test(value);
}

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) invalidInput(field);
  return number;
}

function maybePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeReportForAppend(report: unknown, projectId: number): A4ReviewReport {
  const hasCanonicalHash = Boolean(
    report
    && typeof report === "object"
    && !Array.isArray(report)
    && Object.prototype.hasOwnProperty.call(report, "canonicalHash"),
  );
  return hasCanonicalHash
    ? normalizeA4ReviewReport(report, { expectedProjectId: projectId })
    : createA4ReviewReport(report, { expectedProjectId: projectId });
}

function corruptRecord(): never {
  throw new AgentRuntimeError(500, "review_report_record_corrupt", "持久化 Reviewer 报告无效");
}

function parseReportJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return corruptRecord();
  }
}

function mapStoredReport(row: RawReviewReportRow): A4StoredReviewReport {
  const projectId = maybePositiveInteger(row.projectId);
  const createdAt = nonNegativeInteger(row.createdAt);
  if (projectId === null || createdAt === null) return corruptRecord();

  let report: A4ReviewReport;
  try {
    report = normalizeA4ReviewReport(parseReportJson(row.reportJson), { expectedProjectId: projectId });
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error;
    if (error instanceof A4ReviewReportContractError) return corruptRecord();
    return corruptRecord();
  }

  const id = String(row.id || "");
  const workspaceId = String(row.workspaceId || "");
  const reviewerRunId = String(row.reviewerRunId || "");
  const reviewerStepId = String(row.reviewerStepId || "");
  if (!isCleanIdentifier(id)
    || !isCleanIdentifier(workspaceId)
    || !isCleanIdentifier(reviewerRunId)
    || !isCleanIdentifier(reviewerStepId)
    || Number(row.reportVersion) !== A4_REVIEW_REPORT_VERSION
    || !HASH_PATTERN.test(String(row.canonicalHash || ""))
    || String(row.canonicalHash) !== report.canonicalHash
    || String(row.subjectType) !== report.subject.type
    || String(row.subjectId) !== report.subject.id
    || String(row.subjectVersion) !== report.subject.version) {
    return corruptRecord();
  }

  return Object.freeze({
    id,
    workspaceId,
    projectId,
    reviewerRunId,
    reviewerStepId,
    report,
    createdAt,
  });
}

function encodeCursor(cursor: ReviewReportCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): ReviewReportCursor {
  if (!value || value.length > 500) {
    throw new AgentRuntimeError(400, "review_report_cursor_invalid", "Reviewer 报告分页游标无效");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ReviewReportCursor>;
    const createdAt = nonNegativeInteger(parsed.createdAt);
    if (createdAt === null) throw new TypeError("invalid createdAt");
    return { createdAt, id: cleanIdentifier(parsed.id, "cursor.id") };
  } catch {
    throw new AgentRuntimeError(400, "review_report_cursor_invalid", "Reviewer 报告分页游标无效");
  }
}

async function loadReviewerAccess(
  trx: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    reviewerRunId: string;
    reviewerStepId?: string;
    operation: ReviewReportOperation;
  },
): Promise<ReviewerAccessState> {
  let runQuery = trx("o_agent_run")
    .where({ id: input.reviewerRunId, workspaceId: input.workspaceId })
    .select("projectId", "agentRole", "kind", "status");
  if (input.operation === "append") runQuery = runQuery.forUpdate();
  const run = await runQuery.first();
  const forbiddenCode = input.operation === "read"
    ? "review_report_reader_forbidden"
    : "review_report_writer_forbidden";
  if (!run
    || String(run.agentRole) !== REVIEWER_AGENT_ROLE
    || String(run.kind) !== "delegated") {
    throw new AgentRuntimeError(403, forbiddenCode, "只有 Reviewer Run 可以访问不可变审核报告");
  }
  if (Number(run.projectId) !== input.projectId) {
    throw new AgentRuntimeError(403, "review_report_project_scope_forbidden", "Reviewer Run 与报告项目范围不匹配");
  }

  if (!input.reviewerStepId) {
    return { runStatus: String(run.status || ""), stepStatus: null };
  }
  let stepQuery = trx("o_agent_step")
    .where({
      id: input.reviewerStepId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.reviewerRunId,
    })
    .select("agentRole", "kind", "toolName", "status");
  if (input.operation === "append") stepQuery = stepQuery.forUpdate();
  const step = await stepQuery.first();
  if (!step
    || String(step.agentRole) !== REVIEWER_AGENT_ROLE
    || String(step.kind) !== "tool"
    || String(step.toolName) !== "review.report.create") {
    throw new AgentRuntimeError(403, forbiddenCode, "Reviewer 报告只能由对应的 create Tool Step 追加");
  }
  return { runStatus: String(run.status || ""), stepStatus: String(step.status || "") };
}

function assertNewAppendState(state: ReviewerAccessState): void {
  if (state.runStatus !== "running" || state.stepStatus !== "running") {
    throw new AgentRuntimeError(
      409,
      "review_report_writer_inactive",
      "只有 running Reviewer Run 与 running create Tool Step 可以追加新报告",
    );
  }
}

function assertExactReplayState(state: ReviewerAccessState): void {
  const replayable = new Set(["running", "succeeded"]);
  if (!replayable.has(state.runStatus) || !state.stepStatus || !replayable.has(state.stepStatus)) {
    throw new AgentRuntimeError(
      409,
      "review_report_replay_inactive",
      "当前 Reviewer Run 或 Step 状态不允许重放报告",
    );
  }
}

function assertSameReplay(
  stored: A4StoredReviewReport,
  input: AppendA4ReviewReportInput,
  report: A4ReviewReport,
): void {
  if (stored.workspaceId !== input.workspaceId
    || stored.projectId !== input.projectId
    || stored.reviewerRunId !== input.reviewerRunId
    || stored.reviewerStepId !== input.reviewerStepId
    || stored.report.canonicalHash !== report.canonicalHash) {
    throw new AgentRuntimeError(
      409,
      "review_report_replay_conflict",
      "Reviewer 报告 Step 已绑定不同内容",
    );
  }
}

/**
 * Persistence boundary for A4 Reviewer reports. It exposes append and
 * reviewer-authenticated reads only; update/delete are additionally rejected
 * by database triggers installed with the table migration.
 */
export class A4ReviewReportService {
  private readonly clock: () => number;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: Knex,
    options: A4ReviewReportServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `review_${randomUUID()}`);
  }

  async append(input: AppendA4ReviewReportInput): Promise<A4StoredReviewReport> {
    return this.database.transaction((trx) => this.appendInTransaction(trx, input));
  }

  async appendInTransaction(
    trx: Knex.Transaction,
    input: AppendA4ReviewReportInput,
  ): Promise<A4StoredReviewReport> {
    const normalized = {
      workspaceId: cleanIdentifier(input.workspaceId, "workspaceId"),
      projectId: positiveInteger(input.projectId, "projectId"),
      reviewerRunId: cleanIdentifier(input.reviewerRunId, "reviewerRunId"),
      reviewerStepId: cleanIdentifier(input.reviewerStepId, "reviewerStepId"),
    };
    const report = normalizeReportForAppend(input.report, normalized.projectId);
    const access = await loadReviewerAccess(trx, { ...normalized, operation: "append" });

    const existing = await trx<RawReviewReportRow>(AGENT_REVIEW_REPORT_TABLE)
      .where({ reviewerStepId: normalized.reviewerStepId })
      .first();
    if (existing) {
      const stored = mapStoredReport(existing);
      assertSameReplay(stored, { ...input, ...normalized }, report);
      assertExactReplayState(access);
      return stored;
    }
    assertNewAppendState(access);

    const id = cleanIdentifier(this.idFactory(), "reportId");
    const createdAt = nonNegativeInteger(this.clock());
    if (createdAt === null) invalidInput("createdAt");
    await trx(AGENT_REVIEW_REPORT_TABLE)
      .insert({
        id,
        workspaceId: normalized.workspaceId,
        projectId: normalized.projectId,
        reviewerRunId: normalized.reviewerRunId,
        reviewerStepId: normalized.reviewerStepId,
        reportVersion: report.version,
        canonicalHash: report.canonicalHash,
        subjectType: report.subject.type,
        subjectId: report.subject.id,
        subjectVersion: report.subject.version,
        reportJson: JSON.stringify(report),
        createdAt,
      })
      .onConflict("reviewerStepId")
      .ignore();

    const row = await trx<RawReviewReportRow>(AGENT_REVIEW_REPORT_TABLE)
      .where({ reviewerStepId: normalized.reviewerStepId })
      .first();
    if (!row) {
      throw new AgentRuntimeError(500, "review_report_save_failed", "Reviewer 报告保存后无法读取");
    }
    const stored = mapStoredReport(row);
    assertSameReplay(stored, { ...input, ...normalized }, report);
    return stored;
  }

  /**
   * Internal Reviewer-Runtime read seam. `reviewerRunId` must come from a
   * server-owned execution context; it is not an authorization token and this
   * method must not be exposed as a client-selected user API.
   */
  async get(input: ReadA4ReviewReportInput): Promise<A4StoredReviewReport> {
    const normalized = {
      workspaceId: cleanIdentifier(input.workspaceId, "workspaceId"),
      projectId: positiveInteger(input.projectId, "projectId"),
      reviewerRunId: cleanIdentifier(input.reviewerRunId, "reviewerRunId"),
      reportId: cleanIdentifier(input.reportId, "reportId"),
    };
    return this.database.transaction(async (trx) => {
      await loadReviewerAccess(trx, { ...normalized, operation: "read" });
      const row = await trx<RawReviewReportRow>(AGENT_REVIEW_REPORT_TABLE)
        .where({
          id: normalized.reportId,
          workspaceId: normalized.workspaceId,
          projectId: normalized.projectId,
        })
        .first();
      if (!row) throw new AgentRuntimeError(404, "review_report_not_found", "Reviewer 报告不存在");
      return mapStoredReport(row);
    });
  }

  /** Same internal-only authorization boundary as get(). */
  async list(input: ListA4ReviewReportsInput): Promise<A4ReviewReportPage> {
    const normalized = {
      workspaceId: cleanIdentifier(input.workspaceId, "workspaceId"),
      projectId: positiveInteger(input.projectId, "projectId"),
      reviewerRunId: cleanIdentifier(input.reviewerRunId, "reviewerRunId"),
    };
    const rawLimit = input.limit ?? 50;
    const limit = positiveInteger(rawLimit, "limit");
    if (limit > MAX_PAGE_SIZE) invalidInput("limit");
    const cursor = input.after ? decodeCursor(input.after) : null;

    return this.database.transaction(async (trx) => {
      await loadReviewerAccess(trx, { ...normalized, operation: "read" });
      const query = trx<RawReviewReportRow>(AGENT_REVIEW_REPORT_TABLE)
        .where({ workspaceId: normalized.workspaceId, projectId: normalized.projectId })
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc")
        .limit(limit + 1);
      if (cursor) {
        query.andWhere(function (this: Knex.QueryBuilder) {
          this.where("createdAt", ">", cursor.createdAt).orWhere(function (this: Knex.QueryBuilder) {
            this.where("createdAt", cursor.createdAt).andWhere("id", ">", cursor.id);
          });
        });
      }
      const rows = await query;
      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit).map(mapStoredReport);
      return Object.freeze({
        data: Object.freeze(data),
        nextCursor: hasMore && data.length
          ? encodeCursor({ createdAt: data[data.length - 1].createdAt, id: data[data.length - 1].id })
          : null,
      });
    });
  }
}
