import type {
  ReleaseDeploymentStatus,
  ReleaseDeploymentTargetRole,
  ReleaseDeploymentTargetStatus,
} from "./types";

export const DEPLOYMENT_POLL_INTERVAL_MS = 2_000;

export const deploymentStatusLabels: Record<ReleaseDeploymentStatus, string> = {
  queued: "等待执行",
  running: "发布中",
  cancelling: "正在停止",
  rolling_back: "自动回滚中",
  succeeded: "发布成功",
  failed: "发布失败",
  cancelled: "已停止",
  rolled_back: "已自动回滚",
  degraded_manual: "需要人工介入",
};

export const targetStatusLabels: Record<ReleaseDeploymentTargetStatus, string> = {
  pending: "等待处理",
  draining: "摘流排空",
  deploying: "升级中",
  verifying: "就绪校验",
  rolling_back: "回滚中",
  succeeded: "已恢复流量",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已停止",
  rolled_back: "已回滚",
};

const workerTargetStatusLabels: Record<ReleaseDeploymentTargetStatus, string> = {
  pending: "等待处理",
  draining: "停止接单并排空",
  deploying: "升级中",
  verifying: "心跳验活",
  rolling_back: "回滚中",
  succeeded: "已恢复接单",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已停止",
  rolled_back: "已回滚",
};

export const targetRoleLabels: Record<ReleaseDeploymentTargetRole, string> = {
  api: "API",
  worker: "Worker",
};

const activeStatuses = new Set<ReleaseDeploymentStatus>([
  "queued",
  "running",
  "cancelling",
  "rolling_back",
]);

export function isDeploymentActive(status: ReleaseDeploymentStatus | null | undefined) {
  return Boolean(status && activeStatuses.has(status));
}

export function isManualReconciliationInProgress(phase: string | null | undefined) {
  return phase === "manual-reconcile-queued" || phase === "manual-reconcile-verifying";
}

export function shouldPollDeployment(
  status: ReleaseDeploymentStatus | null | undefined,
  phase: string | null | undefined,
) {
  return isDeploymentActive(status) || (status === "degraded_manual" && isManualReconciliationInProgress(phase));
}

export function canRequestManualReconciliation(
  status: ReleaseDeploymentStatus | null | undefined,
  phase: string | null | undefined,
  role: string | null | undefined,
) {
  return status === "degraded_manual"
    && !isManualReconciliationInProgress(phase)
    && String(role || "").trim().toLowerCase() === "root";
}

export function deploymentStatusTone(status: ReleaseDeploymentStatus) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed" || status === "degraded_manual") return "danger" as const;
  if (status === "rolling_back" || status === "rolled_back" || status === "cancelling") return "warning" as const;
  if (status === "running" || status === "queued") return "info" as const;
  return "neutral" as const;
}

export function targetStatusTone(status: ReleaseDeploymentTargetStatus) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "rolling_back" || status === "rolled_back") return "warning" as const;
  if (status === "draining" || status === "deploying" || status === "verifying") return "info" as const;
  return "neutral" as const;
}

export function deploymentProgress(completed: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export const targetStageLabels = ["等待", "摘流", "升级", "校验", "恢复流量"] as const;

const workerTargetStageLabels = ["等待", "停止接单并排空", "升级", "心跳验活", "恢复接单"] as const;

export function targetStatusLabel(
  status: ReleaseDeploymentTargetStatus,
  role: ReleaseDeploymentTargetRole,
) {
  return role === "worker" ? workerTargetStatusLabels[status] : targetStatusLabels[status];
}

export function targetStageLabelsForRole(role: ReleaseDeploymentTargetRole) {
  return role === "worker" ? workerTargetStageLabels : targetStageLabels;
}

export function targetStageState(status: ReleaseDeploymentTargetStatus, stageIndex: number) {
  const activeIndex: Partial<Record<ReleaseDeploymentTargetStatus, number>> = {
    pending: 0,
    draining: 1,
    deploying: 2,
    verifying: 3,
    succeeded: 4,
  };
  if (status === "succeeded") return stageIndex <= 4 ? "done" as const : "idle" as const;
  if (status === "failed") return stageIndex === 4 ? "failed" as const : "done" as const;
  if (status === "rolling_back") return stageIndex === 4 ? "rollback" as const : "done" as const;
  if (status === "rolled_back") return stageIndex === 4 ? "rolled-back" as const : "done" as const;
  if (status === "cancelled" || status === "skipped") return stageIndex === 0 ? "stopped" as const : "idle" as const;
  const currentIndex = activeIndex[status] ?? 0;
  if (stageIndex < currentIndex) return "done" as const;
  if (stageIndex === currentIndex) return "current" as const;
  return "idle" as const;
}

export function phaseLabel(phase: string) {
  const labels: Record<string, string> = {
    queued: "等待控制器接管",
    preflight: "发布前检查",
    stage: "向全部 API 与 Worker 预铺制品",
    "worker-rolling": "逐台排空、升级并验活 Worker",
    rolling: "逐台摘流、升级并恢复 API 流量",
    "public-smoke": "公网链路验证",
    rollback: "自动恢复上一版本",
    success: "发布完成",
    failed: "发布失败",
    cancelling: "正在安全停止",
    cancelled: "已安全停止",
    // Legacy aliases retained for old persisted events and older API builds.
    staging: "向全部受管节点预铺制品",
    draining: "从负载均衡摘流并排空连接",
    activating: "激活新版本",
    verifying: "检查节点就绪状态",
    restoring: "恢复负载均衡流量",
    public_smoke: "公网链路验证",
    rolling_back: "自动恢复上一版本",
    completed: "发布完成",
    "manual-reconcile-queued": "人工收敛请求等待控制器接管",
    "manual-reconcile-verifying": "正在核验并收敛全部 API 与 Worker",
    "manual-reconcile-failed": "人工收敛核验失败，生产锁继续保留",
    "reconciled-target": "已收敛到本次目标版本",
    "reconciled-previous": "已收敛到上一正式版本",
    "lease-lost-manual": "控制器失去租约，等待 Root 人工收敛",
  };
  return labels[phase] || phase || "等待状态更新";
}
