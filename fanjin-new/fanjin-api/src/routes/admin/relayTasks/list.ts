import express from "express";
import { z } from "zod";
import { getRelayTaskProgress, parseRelayTask, relayEndpointTypes, relayProviders, type RelayTask } from "@/lib/relay";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  adminRelayTaskResponse,
  redactServerOnlyRelayMetadata,
} from "@/lib/relayResponseRedaction";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  endpointType: z.enum(relayEndpointTypes).optional().nullable(),
  status: z.string().optional().nullable(),
  provider: z.enum(relayProviders).optional().nullable(),
  channelId: z.string().optional().nullable(),
  workspaceId: z.string().optional().nullable(),
  apiKeyId: z.string().optional().nullable(),
  taskId: z.string().optional().nullable(),
  providerTaskId: z.string().optional().nullable(),
  requestId: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  keyword: z.string().trim().max(200).optional().nullable(),
  startTime: z.number().int().nonnegative().optional().nullable(),
  endTime: z.number().int().nonnegative().optional().nullable(),
  pageNum: z.number().int().optional(),
  pageSize: z.number().int().optional(),
}).superRefine((data, context) => {
  if (data.startTime != null && data.endTime != null && data.startTime > data.endTime) {
    context.addIssue({ code: "custom", path: ["endTime"], message: "endTime 不能早于 startTime" });
  }
});

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pickFirst(obj: any, paths: string[]): unknown {
  for (const path of paths) {
    const value = path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function internalPlan(task: RelayTask): Record<string, unknown> {
  const requestPayload = task.requestPayload || {};
  const resultPayload = task.resultPayload || {};
  return {
    requestedResolution: pickFirst(resultPayload, ["internal.requestedResolution"]) ?? requestPayload.resolution ?? null,
    generationResolution: pickFirst(resultPayload, ["internal.generationResolution"]) ?? null,
    finalResolution: pickFirst(resultPayload, ["internal.finalResolution"]) ?? requestPayload.resolution ?? null,
    hasInternalProcessing: Boolean(pickFirst(resultPayload, ["enhancement.taskId", "enhancement.task_id", "enhancement.payload"])),
  };
}

function compactPayload(payload: Record<string, unknown>, limit = 1200): Record<string, unknown> {
  const text = JSON.stringify(payload || {});
  if (text.length <= limit) return payload || {};
  return {
    truncated: true,
    preview: `${text.slice(0, limit)}...`,
  };
}

async function assetsByTask(taskIds: string[]): Promise<Record<string, any[]>> {
  if (!taskIds.length) return {};
  const rows = await db("o_media_asset").whereIn("taskId", taskIds).orderBy("createTime", "asc");
  return rows.reduce((acc: Record<string, any[]>, row: any) => {
    const item = {
      ...row,
      metadata: parseJsonObject(row.metadata),
    };
    acc[row.taskId] = acc[row.taskId] || [];
    acc[row.taskId].push(item);
    return acc;
  }, {});
}

function compactLedger(row: any) {
  const rawMetadata = parseJsonObject(row.metadata);
  const metadata = redactServerOnlyRelayMetadata(
    rawMetadata,
  ) as Record<string, unknown>;
  return {
    id: row.id,
    type: row.type,
    status: row.status ?? metadata.status ?? null,
    amountMicros: Number(row.amountMicros || 0),
    remainingMicros: Number(row.remainingMicros ?? metadata.remainingMicros ?? 0),
    currency: row.currency || "GU",
    relatedLedgerId: row.relatedLedgerId ?? metadata.relatedLedgerId ?? null,
    usageRecordId: row.relatedUsageId ?? metadata.usageRecordId ?? null,
    idempotencyKey: row.idempotencyKey ?? metadata.idempotencyKey ?? null,
    description: row.description ?? null,
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || row.createdAt || 0),
    metadata,
  };
}

async function billingByTask(taskIds: string[]): Promise<Record<string, any>> {
  if (!taskIds.length) return {};
  const [ledgerRows, usageRows] = await Promise.all([
    db("o_billing_ledger")
      .where((builder) => {
        builder.whereIn("relatedTaskId", taskIds).orWhereIn("taskId", taskIds);
      })
      .orderBy("createdAt", "asc"),
    db("o_usage_record").whereIn("taskId", taskIds).orderBy("createTime", "asc"),
  ]);

  const billingMap: Record<string, { ledgers: any[]; usage: any[] }> = {};
  for (const row of ledgerRows) {
    const metadata = parseJsonObject(row.metadata);
    const taskId = row.relatedTaskId || row.taskId || metadata.taskId;
    if (!taskId) continue;
    billingMap[taskId] = billingMap[taskId] || { ledgers: [], usage: [] };
    billingMap[taskId].ledgers.push(compactLedger(row));
  }
  for (const row of usageRows) {
    if (!row.taskId) continue;
    billingMap[row.taskId] = billingMap[row.taskId] || { ledgers: [], usage: [] };
    billingMap[row.taskId].usage.push({
      id: row.id,
      status: row.status,
      costMicros: Number(row.costMicros || 0),
      units: Number(row.units || 0),
      unit: row.unit || "task",
      currency: row.currency || "GU",
      createTime: Number(row.createTime || 0),
    });
  }

  return Object.fromEntries(
    Object.entries(billingMap).map(([taskId, data]) => {
      const reservation = [...data.ledgers].reverse().find((row) => row.type === "freeze") || null;
      const settlement = [...data.ledgers].reverse().find((row) => ["deduct", "release", "refund"].includes(row.type)) || null;
      const remainingMicros = Number(reservation?.remainingMicros || 0);
      const state = settlement?.type === "deduct" ? "captured" : settlement?.type === "release" ? "released" : reservation ? "reserved" : "unbilled";
      return [
        taskId,
        {
          state,
          reservation,
          settlement,
          remainingMicros,
          usage: data.usage,
          ledgers: data.ledgers,
        },
      ];
    }),
  );
}

async function relatedMaps(tasks: RelayTask[]) {
  const channelIds = Array.from(new Set(tasks.map((task) => task.channelId).filter(Boolean))) as string[];
  const apiKeyIds = Array.from(new Set(tasks.map((task) => task.apiKeyId).filter(Boolean))) as string[];
  const workspaceIds = Array.from(new Set(tasks.map((task) => task.workspaceId).filter(Boolean))) as string[];

  const [channels, apiKeys, workspaces] = await Promise.all([
    channelIds.length ? db("o_provider_channel").whereIn("id", channelIds) : [],
    apiKeyIds.length ? db("o_api_key").whereIn("id", apiKeyIds) : [],
    workspaceIds.length ? db("o_workspace").whereIn("id", workspaceIds) : [],
  ]);

  return {
    channels: Object.fromEntries(channels.map((row: any) => [row.id, row])),
    apiKeys: Object.fromEntries(apiKeys.map((row: any) => [row.id, row])),
    workspaces: Object.fromEntries(workspaces.map((row: any) => [row.id, row])),
  };
}

function applyFilters(query: any, filters: z.infer<typeof bodySchema>) {
  if (filters.endpointType) query.where("endpointType", filters.endpointType);
  if (filters.status) query.where("status", filters.status);
  if (filters.provider) query.where("provider", filters.provider);
  if (filters.channelId) query.where("channelId", filters.channelId);
  if (filters.workspaceId) query.where("workspaceId", filters.workspaceId);
  if (filters.apiKeyId) query.where("apiKeyId", filters.apiKeyId);
  if (filters.taskId) query.where("id", filters.taskId);
  if (filters.providerTaskId) query.where("providerTaskId", filters.providerTaskId);
  if (filters.requestId) query.where("requestId", filters.requestId);
  if (filters.model) query.where("model", "like", `%${filters.model}%`);
  if (filters.startTime != null) query.where("createTime", ">=", filters.startTime);
  if (filters.endTime != null) query.where("createTime", "<=", filters.endTime);

  const keyword = filters.keyword?.trim().toLowerCase();
  if (keyword) {
    const pattern = `%${keyword}%`;
    query.where((builder: any) => {
      for (const column of ["id", "requestId", "providerTaskId", "model", "provider", "channelId", "workspaceId", "errorMessage"]) {
        builder.orWhereRaw(`LOWER(COALESCE(CAST(?? AS TEXT), '')) LIKE ?`, [column, pattern]);
      }
      builder
        .orWhereIn(
          "workspaceId",
          db("o_workspace")
            .select("id")
            .whereRaw(`LOWER(COALESCE(CAST(?? AS TEXT), '')) LIKE ?`, ["name", pattern]),
        )
        .orWhereIn(
          "channelId",
          db("o_provider_channel")
            .select("id")
            .where((channelBuilder: any) => {
              channelBuilder
                .whereRaw(`LOWER(COALESCE(CAST(?? AS TEXT), '')) LIKE ?`, ["name", pattern])
                .orWhereRaw(`LOWER(COALESCE(CAST(?? AS TEXT), '')) LIKE ?`, ["provider", pattern]);
            }),
        );
    });
  }
  return query;
}

async function statusSummary(filters: z.infer<typeof bodySchema>) {
  const query = db("o_relay_task").select("status").count<{ status: string; count: number }[]>({ count: "*" }).groupBy("status");
  applyFilters(query, {
    ...filters,
    status: null,
  });
  const rows = await query;
  return rows.reduce((acc: Record<string, number>, row: any) => {
    acc[row.status || "unknown"] = Number(row.count || 0);
    return acc;
  }, {});
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const filters = parsed.data;
  const pageNum = Math.max(1, Math.min(Number(filters.pageNum || 1), 500));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 30), 200));
  const query = applyFilters(db("o_relay_task"), filters);

  const countRow = await query.clone().count({ total: "*" }).first();
  const rows = await query
    .clone()
    .orderBy("createTime", "desc")
    .orderBy("id", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);

  const tasks: RelayTask[] = rows.map((row: any) => parseRelayTask(row));
  const taskIds = tasks.map((task) => task.id);
  const [assetMap, billingMap, maps, summary] = await Promise.all([assetsByTask(taskIds), billingByTask(taskIds), relatedMaps(tasks), statusSummary(filters)]);

  return res.status(200).send(
    success({
      items: tasks.map((task) => {
        const safeTask = adminRelayTaskResponse(task);
        const channel = task.channelId ? maps.channels[task.channelId] : null;
        const apiKey = task.apiKeyId ? maps.apiKeys[task.apiKeyId] : null;
        const workspace = task.workspaceId ? maps.workspaces[task.workspaceId] : null;
        return {
          ...safeTask,
          progress: getRelayTaskProgress(task),
          internalPlan: internalPlan(task),
          requestPayload: compactPayload(task.requestPayload),
          providerPayload: compactPayload(safeTask.providerPayload),
          resultPayload: compactPayload(task.resultPayload),
          assets: assetMap[task.id] || [],
          billing: billingMap[task.id] || {
            state: task.quotaReserved > 0 ? "reserved" : task.costMicros > 0 ? "captured" : "unbilled",
            reservation: null,
            settlement: null,
            remainingMicros: task.quotaReserved || 0,
            usage: [],
            ledgers: [],
          },
          channel: channel
            ? {
                id: channel.id,
                name: channel.name,
                provider: channel.provider,
                endpointType: channel.endpointType,
                disabled: channel.disabled,
              }
            : null,
          apiKey: apiKey
            ? {
                id: apiKey.id,
                name: apiKey.name,
                keyPrefix: apiKey.keyPrefix,
                scope: apiKey.scope,
                disabled: apiKey.disabled,
              }
            : null,
          workspace: workspace
            ? {
                id: workspace.id,
                name: workspace.name,
                slug: workspace.slug,
                status: workspace.status,
              }
            : null,
        };
      }),
      summary,
      total: Number((countRow as any)?.total || 0),
      pageNum,
      pageSize,
    }),
  );
});
