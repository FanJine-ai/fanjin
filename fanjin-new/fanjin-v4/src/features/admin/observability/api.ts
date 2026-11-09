import { apiGet } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type { ObservabilityMetrics, HealthCheckResponse, BackupListResponse } from "./types";

export async function fetchObservabilityMetrics(): Promise<ObservabilityMetrics> {
  return apiGet<ObservabilityMetrics>("/admin/observability/metrics");
}

export async function fetchHealthCheck(): Promise<HealthCheckResponse> {
  return apiGet<HealthCheckResponse>("/admin/observability/health");
}

export async function fetchBackupList(): Promise<BackupListResponse> {
  return apiGet<BackupListResponse>("/admin/backup/list");
}

export async function createBackup(): Promise<void> {
  await apiPostWithStepUp(
    "/admin/backup/create",
    {},
    "admin.backup.manage",
    "立即创建数据库备份",
  );
}
