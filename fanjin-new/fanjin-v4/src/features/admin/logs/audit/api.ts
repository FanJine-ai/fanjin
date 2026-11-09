import { apiPost } from "../../../../api/http";
import type { AuditLogListInput, AuditLogListResponse } from "./types";

export function listAuditLogs(input: AuditLogListInput, signal?: AbortSignal) {
  return apiPost<AuditLogListResponse>("/admin/auditLogs/list", input as unknown as Record<string, unknown>, undefined, { signal });
}
