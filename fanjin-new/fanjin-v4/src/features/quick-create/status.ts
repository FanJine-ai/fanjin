import type { CreativeTaskStatus } from "./types";

export function normalizeCreativeTaskStatus(value: unknown): CreativeTaskStatus {
  const raw = String(value || "").trim().toLowerCase();
  if (["queued", "排队中", "pending", "created", "submitted"].includes(raw)) return "queued";
  if (["enhancing", "高清处理中", "upscaling", "upscale"].includes(raw)) return "enhancing";
  if (["pending_reconcile", "reconciliation_required", "待核对", "待核账"].includes(raw)) return "pending_reconcile";
  if (["succeeded", "success", "done", "completed", "complete", "已完成", "生成成功"].includes(raw)) return "succeeded";
  if (["failed", "failure", "error", "生成失败", "失败", "mocked"].includes(raw)) return "failed";
  if (["cancelled", "canceled", "已取消"].includes(raw)) return "cancelled";
  return "running";
}

export function taskStatusLabel(status: CreativeTaskStatus): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "生成中";
  if (status === "enhancing") return "高清处理中";
  if (status === "pending_reconcile") return "同步结果中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  return "已取消";
}

export function shouldPollTask(status: CreativeTaskStatus) {
  return status === "queued" || status === "running" || status === "enhancing" || status === "pending_reconcile";
}

export function canRetryTask(status: CreativeTaskStatus) {
  return status === "failed" || status === "cancelled";
}
