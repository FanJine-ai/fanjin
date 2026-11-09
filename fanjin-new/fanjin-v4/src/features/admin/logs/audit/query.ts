import type { AuditLogFilters } from "./types";

export const defaultAuditLogPageSize = 20;

export function positiveAuditLogInteger(value: string | null, fallback?: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function auditLogPageSize(value: string | null) {
  const parsed = Number(value);
  return [20, 50, 100].includes(parsed) ? parsed : defaultAuditLogPageSize;
}

export function readAuditLogFilters(params: URLSearchParams): AuditLogFilters {
  const filters = {
    keyword: params.get("q") || "",
    action: params.get("action") || "",
    resourceType: params.get("resource") || "",
    actorUserId: params.get("actor") || "",
    workspaceId: params.get("workspace") || "",
    startDate: params.get("from") || "",
    endDate: params.get("to") || "",
  };
  return invalidAuditLogDateRange(filters) ? { ...filters, startDate: "", endDate: "" } : filters;
}

export function auditLogParams(filters: AuditLogFilters, page = 1, pageSize = defaultAuditLogPageSize) {
  const params = new URLSearchParams();
  if (filters.keyword.trim()) params.set("q", filters.keyword.trim());
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.resourceType.trim()) params.set("resource", filters.resourceType.trim());
  if (filters.actorUserId.trim()) params.set("actor", filters.actorUserId.trim());
  if (filters.workspaceId.trim()) params.set("workspace", filters.workspaceId.trim());
  if (filters.startDate) params.set("from", filters.startDate);
  if (filters.endDate) params.set("to", filters.endDate);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== defaultAuditLogPageSize) params.set("size", String(pageSize));
  return params;
}

export function invalidAuditLogDateRange(filters: Pick<AuditLogFilters, "startDate" | "endDate">) {
  return Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
}
