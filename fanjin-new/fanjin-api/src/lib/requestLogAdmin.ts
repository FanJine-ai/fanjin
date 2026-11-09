import { Knex } from "knex";
import { db } from "@/utils/db";
import { redactRequestLogScalar, redactSensitive } from "@/lib/requestLog";
import { secureCsvCell } from "@/lib/requestLogCsv";

export interface RequestLogFilters {
  workspaceId?: string | null;
  actorUserId?: number | null;
  apiKeyPrefix?: string | null;
  requestId?: string | null;
  relayTaskId?: string | null;
  path?: string | null;
  statusCode?: number | null;
  startTime?: number | null;
  endTime?: number | null;
  capability?: RequestLogCapability | null;
  /** Only externally authenticated API calls or model/task-backed product usage. */
  usageOnly?: boolean;
}

export const requestLogCapabilities = [
  "text",
  "image",
  "video",
  "embedding",
  "audio",
  "rerank",
  "other",
] as const;

export type RequestLogCapability = (typeof requestLogCapabilities)[number];

const requestLogCapabilityPatterns: Record<Exclude<RequestLogCapability, "other">, string[]> = {
  text: [
    "/v1/chat/%",
    "/v1/responses%",
    "/v1beta/%",
    // Retained pre-0.2.3 rows remain searchable after the route aliases are gone.
    "/api/v1/chat/%",
    "/api/v1/messages%",
    "/api/v1/responses%",
    "/api/v1beta/%",
    "/api/relay/chat%",
    "/api/relay/messages%",
    "/api/relay/responses%",
  ],
  image: [
    "/v1/images/%",
    "/api/v1/images/%",
    "/api/relay/image%",
    "/api/production/workbench/generateImage%",
  ],
  video: [
    "/api/relay/video%",
    "/api/v3/contents/generations%",
    "/api/production/workbench/generateVideo%",
    "/api/production/workbench/checkVideoStateList%",
  ],
  embedding: [
    "/v1/embeddings%",
    "/api/v1/embeddings%",
    "/api/relay/embeddings%",
    "/api/relay/multimodal-embeddings%",
  ],
  audio: [
    "/v1/audio/%",
    "/api/v1/audio/%",
    "/api/relay/audio%",
  ],
  rerank: [
    "/v1/rerank%",
    "/api/v1/rerank%",
    "/api/relay/rerank%",
  ],
};

function addPathPatterns(builder: Knex.QueryBuilder, patterns: readonly string[]) {
  patterns.forEach((pattern, index) => {
    if (index === 0) builder.where("path", "like", pattern);
    else builder.orWhere("path", "like", pattern);
  });
}

export function classifyRequestLogCapability(path: unknown): RequestLogCapability {
  const normalized = String(path || "");
  for (const [capability, patterns] of Object.entries(requestLogCapabilityPatterns)) {
    if (patterns.some((pattern) => {
      const prefix = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
      return normalized.startsWith(prefix);
    })) {
      return capability as RequestLogCapability;
    }
  }
  return "other";
}

export interface RequestLogListInput extends RequestLogFilters {
  pageNum?: number;
  pageSize?: number;
}

export function parseRequestLogMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function applyRequestLogFilters<T extends Knex.QueryBuilder>(query: T, filters: RequestLogFilters): T {
  if (filters.workspaceId) query.where("workspaceId", filters.workspaceId);
  if (filters.actorUserId) query.where("actorUserId", filters.actorUserId);
  if (filters.apiKeyPrefix) query.where("apiKeyPrefix", filters.apiKeyPrefix);
  if (filters.requestId) query.where("requestId", filters.requestId);
  if (filters.relayTaskId) query.where("relayTaskId", filters.relayTaskId);
  if (filters.path) query.where("path", filters.path);
  if (filters.statusCode) query.where("statusCode", filters.statusCode);
  if (filters.startTime) query.where("createdAt", ">=", filters.startTime);
  if (filters.endTime) query.where("createdAt", "<=", filters.endTime);
  if (filters.capability) {
    if (filters.capability === "other") {
      const knownPatterns = Object.values(requestLogCapabilityPatterns).flat();
      query.whereNot((builder) => addPathPatterns(builder, knownPatterns));
    } else {
      query.where((builder) => addPathPatterns(
        builder,
        requestLogCapabilityPatterns[filters.capability as Exclude<RequestLogCapability, "other">],
      ));
    }
  }
  if (filters.usageOnly) {
    query.where((builder) => {
      builder
        .whereNotNull("apiKeyId")
        .orWhereNotNull("apiKeyPrefix")
        .orWhereNotNull("model")
        .orWhereNotNull("relayTaskId");
    });
  }
  return query;
}

export function normalizeRequestLog(row: any) {
  const path = redactRequestLogScalar(row.path, 2048) || "";
  const metadata = redactSensitive(parseRequestLogMetadata(row.metadata));
  return {
    ...row,
    requestId: redactRequestLogScalar(row.requestId, 128) || "",
    path,
    model: redactRequestLogScalar(row.model),
    targetResolution: redactRequestLogScalar(row.targetResolution),
    relayTaskId: redactRequestLogScalar(row.relayTaskId),
    errorCode: redactRequestLogScalar(row.errorCode),
    ip: redactRequestLogScalar(row.ip, 128),
    userAgent: redactRequestLogScalar(row.userAgent),
    capability: classifyRequestLogCapability(path),
    actorUserId: row.actorUserId == null ? null : Number(row.actorUserId),
    statusCode: Number(row.statusCode || 0),
    durationMs: Number(row.durationMs || 0),
    createdAt: Number(row.createdAt || 0),
    metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : {},
  };
}

export async function listRequestLogs(input: RequestLogListInput = {}) {
  const pageNum = Math.max(1, Math.min(Number(input.pageNum || 1), 500));
  const pageSize = Math.max(1, Math.min(Number(input.pageSize || 50), 200));
  const query = applyRequestLogFilters(db("o_request_log"), input);
  const countRow = await query.clone().count<{ total: number }[]>({ total: "*" }).first();
  const rows = await query
    .clone()
    .orderBy("createdAt", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);
  return {
    items: rows.map(normalizeRequestLog),
    total: Number((countRow as any)?.total || 0),
    pageNum,
    pageSize,
  };
}

function formatTime(value?: number) {
  if (!value) return "";
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function metadataText(value: unknown) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
}

export async function collectRequestLogs(input: RequestLogFilters & { maxRows?: number }) {
  const maxRows = Math.max(1, Math.min(Number(input.maxRows || 5000), 20_000));
  const rows = await applyRequestLogFilters(db("o_request_log"), input)
    .orderBy("createdAt", "desc")
    .limit(maxRows);
  return rows.map(normalizeRequestLog);
}

export function requestLogsToCsv(rows: any[]) {
  const header = [
    "时间",
    "请求ID",
    "方法",
    "路径",
    "状态码",
    "耗时(ms)",
    "工作区ID",
    "用户ID",
    "API Key ID",
    "API Key 前缀",
    "模型",
    "目标分辨率",
    "任务ID",
    "错误码",
    "IP",
    "User-Agent",
    "脱敏元数据",
    "日志ID",
  ];
  const body = rows.map((row) =>
    [
      formatTime(row.createdAt),
      row.requestId,
      row.method,
      row.path,
      row.statusCode,
      row.durationMs,
      row.workspaceId,
      row.actorUserId,
      row.apiKeyId,
      row.apiKeyPrefix,
      row.model,
      row.targetResolution,
      row.relayTaskId,
      row.errorCode,
      row.ip,
      row.userAgent,
      metadataText(row.metadata),
      row.id,
    ].map(secureCsvCell).join(","),
  );
  return `\uFEFF${[header.map(secureCsvCell).join(","), ...body].join("\n")}\n`;
}

export async function summarizeRequestLogs(input: RequestLogFilters & { days?: number }) {
  const days = Math.max(1, Math.min(Number(input.days || 7), 90));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = await applyRequestLogFilters(db("o_request_log"), {
    ...input,
    startTime: input.startTime || since,
  }).orderBy("createdAt", "asc");

  const durations = rows.map((row: any) => Number(row.durationMs || 0)).sort((a, b) => a - b);
  const total = rows.length;
  const status2xx = rows.filter((row: any) => Number(row.statusCode || 0) >= 200 && Number(row.statusCode || 0) < 300).length;
  const status4xx = rows.filter((row: any) => Number(row.statusCode || 0) >= 400 && Number(row.statusCode || 0) < 500).length;
  const status5xx = rows.filter((row: any) => Number(row.statusCode || 0) >= 500).length;
  const avgDurationMs = total ? Math.round(durations.reduce((sum, value) => sum + value, 0) / total) : 0;
  const p95DurationMs = total ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0;
  const byDay = new Map<string, { date: string; total: number; errors: number; durationMs: number }>();
  const byPath = new Map<string, { path: string; total: number; errors: number; durationMs: number }>();

  for (const row of rows as any[]) {
    const date = new Date(Number(row.createdAt || 0)).toISOString().slice(0, 10);
    const statusCode = Number(row.statusCode || 0);
    const durationMs = Number(row.durationMs || 0);
    const day = byDay.get(date) || { date, total: 0, errors: 0, durationMs: 0 };
    day.total += 1;
    day.errors += statusCode >= 400 ? 1 : 0;
    day.durationMs += durationMs;
    byDay.set(date, day);

    const path = String(row.path || "-");
    const pathItem = byPath.get(path) || { path, total: 0, errors: 0, durationMs: 0 };
    pathItem.total += 1;
    pathItem.errors += statusCode >= 400 ? 1 : 0;
    pathItem.durationMs += durationMs;
    byPath.set(path, pathItem);
  }

  return {
    days,
    total,
    status2xx,
    status4xx,
    status5xx,
    avgDurationMs,
    p95DurationMs,
    byDay: Array.from(byDay.values()).map((item) => ({
      date: item.date,
      total: item.total,
      errors: item.errors,
      avgDurationMs: item.total ? Math.round(item.durationMs / item.total) : 0,
    })),
    topPaths: Array.from(byPath.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
      .map((item) => ({
        path: item.path,
        total: item.total,
        errors: item.errors,
        avgDurationMs: item.total ? Math.round(item.durationMs / item.total) : 0,
      })),
  };
}

export async function purgeRequestLogs(input: { olderThanDays: number; dryRun?: boolean }) {
  const olderThanDays = Math.max(1, Math.min(Number(input.olderThanDays || 90), 3650));
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const query = db("o_request_log").where("createdAt", "<", cutoff);
  const countRow = await query.clone().count<{ total: number }[]>({ total: "*" }).first();
  const total = Number((countRow as any)?.total || 0);
  if (!input.dryRun && total > 0) await query.clone().delete();
  return {
    olderThanDays,
    cutoff,
    dryRun: input.dryRun !== false,
    deleted: input.dryRun === false ? total : 0,
    matched: total,
  };
}
