import { publicModelId } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import { z } from "zod";
import { getBillingOverview } from "@/lib/billing";
import { collectRequestLogs, listRequestLogs, summarizeRequestLogs } from "@/lib/requestLogAdmin";
import { formatPublicRelayTask, listRelayTasks } from "@/lib/relay";
import { success } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { isPlatformAdmin, requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
// The workspace landing page is shared by creators, billing members and
// developers. Requiring api_key:read made otherwise valid workspace roles
// fail before the overview could render.
router.use(requireWorkspacePermission("workspace:read"));

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  days: z.number().int().min(1).max(90).optional(),
});

function scopedWorkspaceId(req: express.Request, requested?: string | null): string {
  if (isPlatformAdmin(req) && requested) return requested;
  return String((req as any).auth?.workspaceId || requested || "default");
}

function countValue(row: any): number {
  return Number(row?.total || row?.count || 0);
}

function dateKey(value: number) {
  const date = new Date(Number(value || 0));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function normalizeModel(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
}

export function isDeveloperUsageRequestLog(log: any) {
  return Boolean(
    String(log?.apiKeyId || "").trim()
    || String(log?.apiKeyPrefix || "").trim()
    || String(log?.model || "").trim()
    || String(log?.relayTaskId || "").trim(),
  );
}

function makeDayKeys(days: number) {
  const keys: string[] = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  for (let index = 0; index < days; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    keys.push(day.toISOString().slice(0, 10));
  }
  return keys;
}

export function buildDeveloperAnalytics(input: { logs: any[]; usageRows: any[]; days: number }) {
  const usageLogs = input.logs.filter(isDeveloperUsageRequestLog);
  const modelMap = new Map<
    string,
    {
      model: string;
      calls: number;
      errors: number;
      durationMs: number;
      costMicros: number;
      units: number;
      lastAt: number;
    }
  >();
  const callerMap = new Map<
    string,
    {
      name: string;
      calls: number;
      errors: number;
      durationMs: number;
      lastAt: number;
    }
  >();
  const dayMap = new Map<
    string,
    {
      date: string;
      requests: number;
      errors: number;
      costMicros: number;
      units: number;
      requestModels: Record<string, number>;
      costModels: Record<string, number>;
    }
  >();
  for (const date of makeDayKeys(input.days)) {
    dayMap.set(date, { date, requests: 0, errors: 0, costMicros: 0, units: 0, requestModels: {}, costModels: {} });
  }

  const ensureModel = (model: string) => {
    const existing = modelMap.get(model);
    if (existing) return existing;
    const item = { model, calls: 0, errors: 0, durationMs: 0, costMicros: 0, units: 0, lastAt: 0 };
    modelMap.set(model, item);
    return item;
  };

  for (const log of usageLogs) {
    const model = publicModelId(normalizeModel(log.model));
    const statusCode = Number(log.statusCode || 0);
    const durationMs = Number(log.durationMs || 0);
    const createdAt = Number(log.createdAt || 0);
    if (model) {
      const modelItem = ensureModel(model);
      modelItem.calls += 1;
      modelItem.errors += statusCode >= 400 ? 1 : 0;
      modelItem.durationMs += durationMs;
      modelItem.lastAt = Math.max(modelItem.lastAt, createdAt);
    }

    const caller = log.apiKeyPrefix ? `sk-${log.apiKeyPrefix}` : log.actorUserId ? `用户 ${log.actorUserId}` : "工作区调用";
    const callerItem = callerMap.get(caller) || { name: caller, calls: 0, errors: 0, durationMs: 0, lastAt: 0 };
    callerItem.calls += 1;
    callerItem.errors += statusCode >= 400 ? 1 : 0;
    callerItem.durationMs += durationMs;
    callerItem.lastAt = Math.max(callerItem.lastAt, createdAt);
    callerMap.set(caller, callerItem);

    const day = dayMap.get(dateKey(createdAt));
    if (day) {
      day.requests += 1;
      day.errors += statusCode >= 400 ? 1 : 0;
      if (model) day.requestModels[model] = (day.requestModels[model] || 0) + 1;
    }
  }

  for (const usage of input.usageRows) {
    const model = publicModelId(normalizeModel(usage.model));
    const costMicros = Number(usage.costMicros || 0);
    const units = Number(usage.units || 0);
    const createdAt = Number(usage.createTime || 0);
    if (model) {
      const modelItem = ensureModel(model);
      modelItem.costMicros += costMicros;
      modelItem.units += units;
      modelItem.lastAt = Math.max(modelItem.lastAt, createdAt);
    }

    const day = dayMap.get(dateKey(createdAt));
    if (day) {
      day.costMicros += costMicros;
      day.units += units;
      if (model && costMicros > 0) day.costModels[model] = (day.costModels[model] || 0) + costMicros;
    }
  }

  const totalRequests = usageLogs.length;
  const totalErrors = usageLogs.filter((row) => Number(row.statusCode || 0) >= 400).length;
  const totalCostMicros = input.usageRows.reduce((sum, row) => sum + Number(row.costMicros || 0), 0);
  const totalUnits = input.usageRows.reduce((sum, row) => sum + Number(row.units || 0), 0);
  const minutes = Math.max(1, input.days * 24 * 60);
  const chartMetric = totalCostMicros > 0 ? "costMicros" : "requests";

  const byModel = Array.from(modelMap.values())
    .map((item) => ({
      model: item.model,
      calls: item.calls,
      errors: item.errors,
      successRate: item.calls ? Number((((item.calls - item.errors) / item.calls) * 100).toFixed(2)) : 100,
      avgDurationMs: item.calls ? Math.round(item.durationMs / item.calls) : 0,
      costMicros: item.costMicros,
      units: item.units,
      lastAt: item.lastAt,
    }))
    .sort((a, b) => b.costMicros - a.costMicros || b.calls - a.calls)
    .slice(0, 16);

  const byCaller = Array.from(callerMap.values())
    .map((item) => ({
      name: item.name,
      calls: item.calls,
      errors: item.errors,
      successRate: item.calls ? Number((((item.calls - item.errors) / item.calls) * 100).toFixed(2)) : 100,
      avgDurationMs: item.calls ? Math.round(item.durationMs / item.calls) : 0,
      lastAt: item.lastAt,
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 12);

  return {
    days: input.days,
    chartMetric,
    totalRequests,
    totalErrors,
    totalCostMicros,
    totalUnits,
    avgRpm: Number((totalRequests / minutes).toFixed(2)),
    avgTpm: Number((totalUnits / minutes).toFixed(2)),
    successRate: totalRequests ? Number((((totalRequests - totalErrors) / totalRequests) * 100).toFixed(2)) : 100,
    byModel,
    byCaller,
    byDay: Array.from(dayMap.values()).map((item) => ({
      date: item.date,
      requests: item.requests,
      errors: item.errors,
      costMicros: item.costMicros,
      units: item.units,
      models: chartMetric === "costMicros" ? item.costModels : item.requestModels,
    })),
  };
}

async function countRows(table: string, filters: Record<string, unknown>) {
  const row = await db(table).where(filters).count<{ total: number }[]>({ total: "*" }).first();
  return countValue(row);
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = scopedWorkspaceId(req, parsed.data.workspaceId);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const analyticsDays = Math.max(1, Math.min(Number(parsed.data.days || 30), 90));
  const analyticsStart = Date.now() - analyticsDays * 24 * 60 * 60 * 1000;

  const [totalKeys, activeKeys, members, billing, requestList, requestStats, analyticsLogs, usageRows, recentTasks, routeRows, channelRows] = await Promise.all([
    countRows("o_api_key", { scope: "workspace", workspaceId }),
    db("o_api_key")
      .where({ scope: "workspace", workspaceId, disabled: 0 })
      .whereNull("revokedAt")
      .count<{ total: number }[]>({ total: "*" })
      .first()
      .then(countValue),
    countRows("o_workspace_member", { workspaceId, status: "active" }),
    getBillingOverview(workspaceId),
    listRequestLogs({ workspaceId, startTime: monthStart.getTime(), pageNum: 1, pageSize: 6, usageOnly: true }),
    summarizeRequestLogs({ workspaceId, days: analyticsDays, usageOnly: true }),
    collectRequestLogs({ workspaceId, startTime: analyticsStart, maxRows: 5000, usageOnly: true }),
    db("o_usage_record").where({ workspaceId }).where("createTime", ">=", analyticsStart).orderBy("createTime", "asc").limit(5000),
    listRelayTasks({ workspaceId, endpointType: "video_generation", pageNum: 1, pageSize: 6 }),
    db("o_model_route").where({ disabled: 0 }).where((builder) => {
      builder.where("scope", "platform").orWhere({ scope: "workspace", workspaceId });
    }),
    db("o_provider_channel").where({ disabled: 0 }).where((builder) => {
      builder.where("scope", "platform").orWhere({ scope: "workspace", workspaceId });
    }),
  ]);

  const publicTasks = await Promise.all(
    recentTasks.items.map((task) => formatPublicRelayTask(task)),
  );
  const errors = requestStats.status4xx + requestStats.status5xx;
  const analytics = buildDeveloperAnalytics({ logs: analyticsLogs, usageRows, days: analyticsDays });

  return res.status(200).send(
    success({
      workspaceId,
      generatedAt: Date.now(),
      summary: {
        activeKeys,
        totalKeys,
        activeMembers: members,
        monthRequests: requestList.total,
        errorRate: requestStats.total ? Number((errors / requestStats.total).toFixed(4)) : 0,
        avgDurationMs: requestStats.avgDurationMs,
        p95DurationMs: requestStats.p95DurationMs,
        availableMicros: billing.account.availableMicros,
        apiQuota: billing.plan?.apiQuota || 0,
      },
      billing: {
        account: billing.account,
        plan: billing.plan,
        usage: billing.usage,
        recentLedger: billing.recentLedger.slice(0, 5),
      },
      requests: {
        stats: requestStats,
        recent: requestList.items,
      },
      analytics,
      tasks: {
        total: recentTasks.total,
        recent: publicTasks,
      },
      models: {
        totalRoutes: routeRows.length,
        videoRoutes: routeRows.filter((row: any) => row.endpointType === "video_generation").length,
        llmRoutes: routeRows.filter((row: any) => row.endpointType === "text").length,
        activeChannels: channelRows.length,
        textChannels: channelRows.filter((row: any) => row.endpointType === "text").length,
        videoChannels: channelRows.filter((row: any) => row.endpointType === "video_generation").length,
      },
      quickStart: [
        { key: "key", label: "创建 API 密钥", done: activeKeys > 0 },
        { key: "route", label: "平台配置模型路由", done: routeRows.length > 0 },
        { key: "video", label: "提交一个视频任务", done: recentTasks.total > 0 },
        { key: "logs", label: "查看请求日志", done: requestList.total > 0 },
      ],
    }),
  );
});
