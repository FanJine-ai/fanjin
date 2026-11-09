import { apiPost } from "../../../../api/http";
import type { RequestLogListInput, RequestLogListResponse, RequestLogStatsInput, RequestLogStatsResponse } from "./types";

export function fetchRequestLogs(input: RequestLogListInput, signal?: AbortSignal) {
  return apiPost<RequestLogListResponse>("/admin/requestLogs/list", { ...input }, undefined, { signal });
}

export function fetchRequestLogStats(input: RequestLogStatsInput, signal?: AbortSignal) {
  return apiPost<RequestLogStatsResponse>("/admin/requestLogs/stats", { ...input }, undefined, { signal });
}
