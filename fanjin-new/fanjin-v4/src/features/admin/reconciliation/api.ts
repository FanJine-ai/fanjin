import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type { ReconciliationJob, ReconciliationList, ReconciliationRunResult, ReconciliationStatus } from "./types";

export async function listReconciliationJobs(input: {
  workspaceId?: string | null;
  status?: ReconciliationStatus | null;
  limit?: number;
}): Promise<ReconciliationList> {
  const result = await apiPost<ReconciliationList>("/admin/billing/reconciliation/list", input);
  return {
    items: Array.isArray(result?.items) ? result.items : [],
    total: Number(result?.total || 0),
  };
}

export function runReconciliationBatch() {
  return apiPostWithStepUp<ReconciliationRunResult>(
    "/admin/billing/reconciliation/run",
    {},
    "admin.billing.reconciliation",
    "执行计费自动对账",
  );
}

export function resolveReconciliationJob(input: {
  jobId: string;
  action: "settle" | "release" | "platform_absorb_release";
  scriptAssetCommandId?: string;
  actualCostMicros?: number;
  units?: number;
  unit?: string;
  resolutionNote: string;
}) {
  return apiPostWithStepUp<ReconciliationJob>(
    "/admin/billing/reconciliation/resolve",
    input,
    "admin.billing.reconciliation",
    "人工处理计费对账任务",
  );
}
