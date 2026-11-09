import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isPlatformAdmin } from "@/middleware/permissions";
import { z } from "zod";
import { publicTaskModelLabel, relayProjectId, relayStatusFilter, relayTaskCategories, TaskCenterRow, toRelayTaskCenterRow } from "@/lib/taskCenter";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import type { Knex } from "knex";
const router = express.Router();
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export function buildRelayCountQuery(query: Knex.QueryBuilder): Knex.QueryBuilder {
  return query
    .clone()
    .clearSelect()
    .clearOrder()
    .count({ total: "*" })
    .first();
}

function applyLegacyKeyword(qb: any, keyword: string) {
  const like = `%${keyword}%`;
  qb.andWhere((nested: any) => {
    nested
      .whereRaw("CAST(o_tasks.id AS TEXT) LIKE ?", [like])
      .orWhere("o_tasks.taskClass", "like", like)
      .orWhere("o_tasks.describe", "like", like)
      .orWhere("o_project.name", "like", like);
  });
}

function sanitizeTaskCenterRow<T extends TaskCenterRow>(row: T): T {
  return {
    ...row,
    model: publicTaskModelLabel(row.model),
    relatedObjects: redactSensitiveText(row.relatedObjects),
    describe: redactSensitiveText(row.describe),
    reason: row.reason ? redactSensitiveText(row.reason) : row.reason,
  };
}

function matchesPublicRelayKeyword(
  source: Record<string, unknown>,
  row: TaskCenterRow,
  keyword: string,
): boolean {
  const safe = sanitizeTaskCenterRow(row);
  const needle = keyword.toLocaleLowerCase();
  return [
    safe.id,
    safe.projectName,
    safe.taskClass,
    safe.model,
    safe.describe,
    safe.state,
    safe.reason,
    redactSensitiveText(String(source.requestId || "")),
  ].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle));
}

export default router.post(
  "/",
  validateFields({
    state: z.string().optional().nullable(),
    taskClass: z.string().optional().nullable(),
    projectId: z.number().optional().nullable(),
    keyword: z.string().optional().nullable(),
    startTimeFrom: timestampSchema.optional().nullable(),
    startTimeTo: timestampSchema.optional().nullable(),
    page: z.number(),
    limit: z.number(),
  }),
  async (req, res) => {
    const {
      taskClass,
      state,
      projectId,
      startTimeFrom,
      startTimeTo,
      page = 1,
      limit = 10,
    }: any = req.body;
    if (startTimeFrom != null && startTimeTo != null && startTimeFrom > startTimeTo) {
      return res.status(400).send({
        message: "参数错误",
        errors: ["字段 startTimeTo 不能早于 startTimeFrom"],
      });
    }
    const keyword = String(req.body?.keyword || "").trim();
    const workspaceId = (req as any).auth?.workspaceId || "default";
    const offset = (page - 1) * limit;
    const windowSize = offset + limit;
    const dataQuery = u
      .db("o_tasks")
      .leftJoin("o_project", "o_project.id", "o_tasks.projectId")
      .andWhere((qb) => {
        if (taskClass) {
          qb.andWhere("o_tasks.taskClass", taskClass);
        }
        if (state) {
          qb.andWhere("o_tasks.state", state);
        }
        if (projectId) {
          qb.andWhere("o_tasks.projectId", projectId);
        }
        if (startTimeFrom != null) {
          qb.andWhere("o_tasks.startTime", ">=", startTimeFrom);
        }
        if (startTimeTo != null) {
          qb.andWhere("o_tasks.startTime", "<=", startTimeTo);
        }
      })
      .select(
        "o_tasks.id as id",
        "o_tasks.projectId as projectId",
        "o_tasks.taskClass as taskClass",
        "o_tasks.relatedObjects as relatedObjects",
        "o_tasks.model as model",
        "o_tasks.describe as describe",
        "o_tasks.state as state",
        "o_tasks.startTime as startTime",
        "o_tasks.reason as reason",
        "o_project.name as projectName",
        "o_project.workspaceId as workspaceId",
      )
      .limit(windowSize)
      .orderBy("o_tasks.id", "desc");

    if (keyword) applyLegacyKeyword(dataQuery, keyword);
    if (!isPlatformAdmin(req)) dataQuery.andWhere("o_project.workspaceId", workspaceId);
    const legacyRows = (await dataQuery) as TaskCenterRow[];

    const totalQueryBuilder = u
      .db("o_tasks")
      .leftJoin("o_project", "o_project.id", "o_tasks.projectId")
      .andWhere((qb) => {
        if (taskClass) {
          qb.andWhere("o_tasks.taskClass", taskClass);
        }
        if (projectId) {
          qb.andWhere("o_tasks.projectId", projectId);
        }
        if (state) {
          qb.andWhere("o_tasks.state", state);
        }
        if (startTimeFrom != null) {
          qb.andWhere("o_tasks.startTime", ">=", startTimeFrom);
        }
        if (startTimeTo != null) {
          qb.andWhere("o_tasks.startTime", "<=", startTimeTo);
        }
      })
      .count("* as total")
      .first();
    if (keyword) applyLegacyKeyword(totalQueryBuilder, keyword);
    if (!isPlatformAdmin(req)) totalQueryBuilder.andWhere("o_project.workspaceId", workspaceId);
    const totalQuery = (await totalQueryBuilder) as any;

    const relayStatus = relayStatusFilter(state);
    const includeRelayByState = relayStatus === null || relayStatus.length > 0;
    const includeRelayByClass = !taskClass || relayTaskCategories.includes(taskClass);
    let relayRows: TaskCenterRow[] = [];
    let relayTotal = 0;

    if (includeRelayByState && includeRelayByClass) {
      const relayQuery = u.db("o_relay_task").select("*");
      if (!isPlatformAdmin(req)) relayQuery.where("workspaceId", workspaceId);
      if (relayStatus?.length) relayQuery.whereIn("status", relayStatus);
      if (startTimeFrom != null) relayQuery.andWhere("createTime", ">=", startTimeFrom);
      if (startTimeTo != null) relayQuery.andWhere("createTime", "<=", startTimeTo);
      if (taskClass === "API 视频生成") {
        relayQuery.where("endpointType", "video_generation").andWhere((qb) => {
          qb.whereNull("requestId").orWhere((nested) => {
            nested
              .whereNot("requestId", "like", "workbench:%")
              .andWhereNot("requestId", "like", "quick-create:%")
              .andWhereNot("requestId", "like", "canvas-video:%")
              .andWhereNot("requestId", "like", "agent-video-submit:%")
              .andWhereNot("requestId", "like", "agent-video-retry:%");
          });
        });
      }
      if (taskClass === "快速创作视频生成") relayQuery.where("requestId", "like", "quick-create:%");
      if (taskClass === "创作台视频生成") relayQuery.where("requestId", "like", "workbench:%");
      if (taskClass === "Canvas 视频生成") relayQuery.where("requestId", "like", "canvas-video:%");
      if (taskClass === "Agent 视频生成") {
        relayQuery.where((qb) => {
          qb.where("requestId", "like", "agent-video-submit:%")
            .orWhere("requestId", "like", "agent-video-retry:%");
        });
      }
      if (taskClass === "API 视频增强") relayQuery.where("endpointType", "video_upscale");
      if (taskClass === "API 图片生成") relayQuery.where("endpointType", "image_generation");
      if (projectId) {
        const canonicalProjectId = Number(projectId);
        relayQuery.andWhere((qb) => {
          qb.where("projectId", canonicalProjectId)
            .orWhere((legacy) => {
              legacy.whereNull("projectId").andWhere((fallback) => {
                fallback
                  .where("requestId", "like", `workbench:${canonicalProjectId}:%`)
                  .orWhere("requestId", "like", `quick-create:${canonicalProjectId}:%`)
                  .orWhere("requestPayload", "like", `%"projectId":${canonicalProjectId}%`)
                  .orWhere("requestPayload", "like", `%"projectId":"${canonicalProjectId}"%`);
              });
            });
        });
      }

      if (!keyword) {
        const relayCountRow = (await buildRelayCountQuery(relayQuery)) as any;
        relayTotal = Number(relayCountRow?.total || 0);
      }
      // Keyword matching happens against the same sanitized fields returned
      // by this endpoint. Raw request/provider/result payloads must never act
      // as a boolean oracle for credentials, signed URLs or server metadata.
      const relayCandidateQuery = relayQuery.clone().orderBy("createTime", "desc");
      if (!keyword) relayCandidateQuery.limit(windowSize);
      const relayCandidateRows = await relayCandidateQuery as unknown as Array<Record<string, unknown>>;
      const relayProjectIds = Array.from(new Set(relayCandidateRows.map(relayProjectId).filter(Boolean) as number[]));
      const projects = relayProjectIds.length ? await u.db("o_project").whereIn("id", relayProjectIds).select("id", "name") : [];
      const projectNameMap = new Map<number, string>(projects.map((item: any) => [Number(item.id), String(item.name || "")]));
      const publicRelayRows = relayCandidateRows
        .map((source: Record<string, unknown>) => ({
          source,
          row: toRelayTaskCenterRow(source, projectNameMap),
        }))
        .filter(({ row }: { row: TaskCenterRow }) => (
          !taskClass || row.taskClass === taskClass
        ))
        .filter(({ source, row }: { source: Record<string, unknown>; row: TaskCenterRow }) => (
          !keyword || matchesPublicRelayKeyword(source, row, keyword)
        ));
      if (keyword) relayTotal = publicRelayRows.length;
      relayRows = publicRelayRows.slice(0, windowSize).map(({ row }) => row);
    }

    const data = [...legacyRows.map((row) => ({ ...row, source: "legacy" as const, origin: null })), ...relayRows]
      .sort((a, b) => Number(b.startTime || 0) - Number(a.startTime || 0))
      .slice(offset, offset + limit)
      .map(sanitizeTaskCenterRow);
    const legacyTotal = Number(totalQuery?.total || 0);
    res.status(200).send(success({ data, total: legacyTotal + relayTotal }));
  },
);
