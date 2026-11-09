import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type { RelayTaskListResponse, RelayTaskRecord } from "./types";

export interface RelayTaskListInput {
  pageNum: number;
  pageSize: number;
  status?: string;
  keyword?: string;
  startTime?: number;
  endTime?: number;
}

export function listRelayTasks(input: RelayTaskListInput, signal?: AbortSignal) {
  return apiPost<RelayTaskListResponse>("/admin/relayTasks/list", { ...input }, undefined, { signal });
}

export function refreshRelayTask(id: string) {
  return apiPostWithStepUp<RelayTaskRecord, { id: string }>("/admin/relayTasks/refresh", { id }, "admin.relay_task");
}

export function cancelRelayTask(id: string) {
  return apiPostWithStepUp<RelayTaskRecord, { id: string }>("/admin/relayTasks/cancel", { id }, "admin.relay_task");
}
