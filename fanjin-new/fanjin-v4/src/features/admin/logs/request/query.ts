import {
  type RequestLogFilters,
  type RequestLogListInput,
  type RequestLogSearchField,
} from "./types";

const searchFieldValues: RequestLogSearchField[] = ["path", "requestId", "relayTaskId", "apiKeyPrefix"];

export const defaultRequestLogPageSize = 20;

export function positiveRequestLogInteger(value: string | null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function requestLogPageSize(value: string | null) {
  const parsed = Number(value);
  return [20, 50, 100].includes(parsed) ? parsed : defaultRequestLogPageSize;
}

export function requestLogDateBoundary(value: string, edge: "start" | "end") {
  if (!value) return undefined;
  const suffix = edge === "start" ? "T00:00:00.000" : "T23:59:59.999";
  const timestamp = new Date(`${value}${suffix}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function readRequestLogFilters(params: URLSearchParams): RequestLogFilters {
  const searchField = params.get("field");
  const filters: RequestLogFilters = {
    query: params.get("q") || "",
    searchField: searchFieldValues.includes(searchField as RequestLogSearchField) ? searchField as RequestLogSearchField : "path",
    statusCode: params.get("status") || "",
    workspaceId: params.get("workspace") || "",
    actorUserId: params.get("actor") || "",
    apiKeyPrefix: params.get("key") || "",
    requestId: params.get("request") || "",
    relayTaskId: params.get("task") || "",
    startDate: params.get("from") || "",
    endDate: params.get("to") || "",
  };
  return invalidRequestLogDateRange(filters) ? { ...filters, startDate: "", endDate: "" } : filters;
}

function appendParam(params: URLSearchParams, key: string, value: string) {
  const normalized = value.trim();
  if (normalized) params.set(key, normalized);
}

export function requestLogParams(filters: RequestLogFilters, pageSize = defaultRequestLogPageSize, page = 1) {
  const params = new URLSearchParams();
  appendParam(params, "q", filters.query);
  if (filters.query.trim() && filters.searchField !== "path") params.set("field", filters.searchField);
  appendParam(params, "status", filters.statusCode);
  appendParam(params, "workspace", filters.workspaceId);
  appendParam(params, "actor", filters.actorUserId);
  appendParam(params, "key", filters.apiKeyPrefix);
  appendParam(params, "request", filters.requestId);
  appendParam(params, "task", filters.relayTaskId);
  appendParam(params, "from", filters.startDate);
  appendParam(params, "to", filters.endDate);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== defaultRequestLogPageSize) params.set("size", String(pageSize));
  return params;
}

export function buildRequestLogFilterPayload(filters: RequestLogFilters) {
  const payload: Omit<RequestLogListInput, "pageNum" | "pageSize"> = {};
  const query = filters.query.trim();
  if (query) payload[filters.searchField] = query;
  if (filters.workspaceId.trim()) payload.workspaceId = filters.workspaceId.trim();
  if (filters.apiKeyPrefix.trim()) payload.apiKeyPrefix = filters.apiKeyPrefix.trim();
  if (filters.requestId.trim()) payload.requestId = filters.requestId.trim();
  if (filters.relayTaskId.trim()) payload.relayTaskId = filters.relayTaskId.trim();
  const actorUserId = positiveRequestLogInteger(filters.actorUserId);
  const statusCode = positiveRequestLogInteger(filters.statusCode);
  const startTime = requestLogDateBoundary(filters.startDate, "start");
  const endTime = requestLogDateBoundary(filters.endDate, "end");
  if (actorUserId) payload.actorUserId = actorUserId;
  if (statusCode) payload.statusCode = statusCode;
  if (startTime) payload.startTime = startTime;
  if (endTime) payload.endTime = endTime;
  return payload;
}

export function invalidRequestLogDateRange(filters: Pick<RequestLogFilters, "startDate" | "endDate">) {
  return Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
}
