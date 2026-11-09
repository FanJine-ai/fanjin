export type CreativeTaskStatus = "queued" | "running" | "enhancing" | "succeeded" | "failed" | "cancelled";

export function normalizeCreativeTaskStatus(value: unknown): CreativeTaskStatus {
  const raw = String(value || "").trim().toLowerCase();
  if (["queued", "排队中", "pending", "created", "submitted"].includes(raw)) return "queued";
  if (["enhancing", "高清处理中", "upscaling", "upscale"].includes(raw)) return "enhancing";
  if (["succeeded", "success", "done", "completed", "complete", "已完成", "生成成功"].includes(raw)) return "succeeded";
  // `mocked` is a synthetic test-provider terminal state, not real output.
  // Treating it as success makes test records appear as completed user work.
  if (["failed", "failure", "error", "生成失败", "失败", "mocked"].includes(raw)) return "failed";
  if (["cancelled", "canceled", "已取消"].includes(raw)) return "cancelled";
  return "running";
}

export function creativeTaskStatusLabel(status: CreativeTaskStatus): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "生成中";
  if (status === "enhancing") return "高清处理中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  return "已取消";
}

export function creativeTaskStatusTheme(status: CreativeTaskStatus): "default" | "primary" | "success" | "warning" | "danger" {
  if (status === "queued") return "warning";
  if (status === "running" || status === "enhancing") return "primary";
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  return "default";
}

export function shouldPollCreativeTask(status: CreativeTaskStatus): boolean {
  return status === "queued" || status === "running" || status === "enhancing";
}

export function canRetryCreativeTask(status: CreativeTaskStatus): boolean {
  return status === "failed" || status === "cancelled";
}
