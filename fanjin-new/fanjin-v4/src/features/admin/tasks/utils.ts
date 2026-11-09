import { formatGuMicros } from "@/utils/billingUnits";
import type { BadgeTone } from "../../../ui/console";
import type { RelayTaskFilters, RelayTaskRecord, RelayTaskRow } from "./types";

export const emptyRelayTaskFilters: RelayTaskFilters = { status: "", keyword: "", startDate: "", endDate: "" };

export function dateBoundary(value: string, edge: "start" | "end") {
  if (!value) return undefined;
  const suffix = edge === "start" ? "T00:00:00.000" : "T23:59:59.999";
  const timestamp = new Date(`${value}${suffix}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function displayValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}

export function formatDate(value: unknown) {
  if (!value) return "-";
  const date = new Date(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value as string | number);
  if (Number.isNaN(date.getTime())) return displayValue(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatGu(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? formatGuMicros(typeof value === "string" ? value : amount) : "-";
}

export function taskStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: "排队中", pending: "待处理", running: "执行中", enhancing: "高清处理中",
    succeeded: "已完成", success: "已完成", completed: "已完成", failed: "失败", cancelled: "已取消",
  };
  return labels[status.toLowerCase()] ?? (status || "未知");
}

export function taskStatusTone(status: string): BadgeTone {
  const normalized = status.toLowerCase();
  if (["succeeded", "success", "completed"].includes(normalized)) return "success";
  if (["failed", "error"].includes(normalized)) return "danger";
  if (["queued", "pending", "running", "enhancing"].includes(normalized)) return "warning";
  return "neutral";
}

export function canCancelStatus(status: string) {
  return ["queued", "pending", "running", "enhancing"].includes(status.toLowerCase());
}

export function canRefreshStatus(status: string) {
  return ["queued", "pending", "running", "enhancing"].includes(status.toLowerCase());
}

export function normalizeRelayTask(item: RelayTaskRecord, index: number): RelayTaskRow {
  const status = String(item.status || item.state || "pending");
  const timestamp = Number(item.createTime || 0);
  const billingRemaining = Number((item.billing as Record<string, unknown> | null)?.remainingMicros);
  return {
    id: String(item.id || item.taskId || index),
    source: item,
    model: displayValue(item.model || (item.requestPayload as Record<string, unknown> | null)?.model),
    provider: displayValue(item.provider || item.channel?.provider || item.channel?.name),
    status,
    workspace: displayValue(item.workspace?.name || item.workspaceId),
    cost: item.costMicros != null ? formatGu(item.costMicros) : Number.isFinite(billingRemaining) ? formatGu(billingRemaining) : "-",
    createdAt: formatDate(item.createTime),
    createdTimestamp: Number.isFinite(timestamp) ? timestamp : 0,
    failureReason: displayValue(item.errorMessage || (item.resultPayload as Record<string, unknown> | null)?.error || (item.providerPayload as Record<string, unknown> | null)?.error),
  };
}

export function safeJson(value: unknown) {
  if (value === undefined || value === null) return "-";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
