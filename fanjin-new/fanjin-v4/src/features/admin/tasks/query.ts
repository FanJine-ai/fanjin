import type { RelayTaskFilters } from "./types";

export const defaultRelayTaskPageSize = 20;

export function positivePage(value: string | null, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function relayTaskPageSize(value: string | null) {
  const parsed = Number(value);
  return [20, 50, 100].includes(parsed) ? parsed : defaultRelayTaskPageSize;
}

export function readRelayTaskFilters(params: URLSearchParams): RelayTaskFilters {
  const filters = {
    status: params.get("status") || "",
    keyword: params.get("q") || "",
    startDate: params.get("start") || "",
    endDate: params.get("end") || "",
  };
  return invalidRelayTaskDateRange(filters) ? { ...filters, startDate: "", endDate: "" } : filters;
}

export function relayTaskParams(filters: RelayTaskFilters, page = 1, pageSize = defaultRelayTaskPageSize) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.keyword.trim()) params.set("q", filters.keyword.trim());
  if (filters.startDate) params.set("start", filters.startDate);
  if (filters.endDate) params.set("end", filters.endDate);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== defaultRelayTaskPageSize) params.set("size", String(pageSize));
  return params;
}

export function invalidRelayTaskDateRange(filters: Pick<RelayTaskFilters, "startDate" | "endDate">) {
  return Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
}
