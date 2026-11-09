import { apiPost, toApiErrorView } from "../../../api/http";
import type {
  AuditSummary,
  OverviewSnapshot,
  ProviderHealthRecord,
  RelayTaskSummary,
  RequestStats,
  UsersSummary,
} from "./types";

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data?: unknown }).data;
  }
  return value;
}

function items<T>(value: unknown): T[] {
  const payload = unwrap(value);
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && "items" in payload) {
    const nested = (payload as { items?: unknown }).items;
    return Array.isArray(nested) ? nested as T[] : [];
  }
  return [];
}

async function settle<T>(
  key: keyof OverviewSnapshot["errors"],
  request: Promise<T>,
  fallback: T,
): Promise<{ key: keyof OverviewSnapshot["errors"]; value: T; error?: string }> {
  try {
    return { key, value: await request };
  } catch (error) {
    return { key, value: fallback, error: toApiErrorView(error).message };
  }
}

export async function loadOverviewSnapshot(): Promise<OverviewSnapshot> {
  const results = await Promise.all([
    settle("providers", apiPost<unknown>("/admin/providerChannels/list", { includeDisabled: true }).then(items<ProviderHealthRecord>), []),
    settle("requests", apiPost<RequestStats>("/admin/requestLogs/stats", { days: 7 }).then((value) => unwrap(value) as RequestStats), {}),
    settle("tasks", apiPost<RelayTaskSummary>("/admin/relayTasks/list", { pageNum: 1, pageSize: 8 }).then((value) => unwrap(value) as RelayTaskSummary), {}),
    settle("audits", apiPost<AuditSummary>("/admin/auditLogs/list", { pageNum: 1, pageSize: 8 }).then((value) => unwrap(value) as AuditSummary), {}),
    settle("users", apiPost<UsersSummary>("/admin/users/list", { pageNum: 1, pageSize: 1 }).then((value) => unwrap(value) as UsersSummary), {}),
  ]);

  const errors: OverviewSnapshot["errors"] = {};
  results.forEach((result) => {
    if (result.error) errors[result.key] = result.error;
  });

  return {
    providers: results[0].value as ProviderHealthRecord[],
    requests: results[1].value as RequestStats,
    tasks: results[2].value as RelayTaskSummary,
    audits: results[3].value as AuditSummary,
    users: results[4].value as UsersSummary,
    errors,
    loadedAt: Date.now(),
  };
}

