import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Clock3,
  Cpu,
  RefreshCcw,
  RotateCcw,
  Server,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Drawer,
  FormField,
  Skeleton,
  useToast,
} from "../../../ui/console";
import { useFinanceQuery } from "../finance/hooks";
import { useAuthStore } from "../../../stores/authStore";
import {
  cancelReleaseDeployment,
  getReleaseDeployment,
  listReleaseDeploymentEvents,
} from "./api";
import {
  DEPLOYMENT_POLL_INTERVAL_MS,
  deploymentProgress,
  deploymentStatusLabels,
  deploymentStatusTone,
  canRequestManualReconciliation,
  isManualReconciliationInProgress,
  phaseLabel,
  shouldPollDeployment,
  targetStageLabelsForRole,
  targetStageState,
  targetStatusLabel,
  targetStatusTone,
} from "./deploymentState";
import { ManualReconcileDialog } from "./ManualReconcileDialog";
import type {
  ReleaseDeploymentDetail,
  ReleaseDeploymentEvent,
  ReleaseDeploymentEventPage,
  ReleaseDeploymentReconciliationRecord,
} from "./types";

const emptyEventPage: ReleaseDeploymentEventPage = { items: [] };

function formatDate(value: number | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function DeploymentNotice({
  deployment,
  isRoot,
}: {
  deployment: ReleaseDeploymentDetail;
  isRoot: boolean;
}) {
  if (deployment.manualInterventionRequired || deployment.status === "degraded_manual") {
    if (isManualReconciliationInProgress(deployment.phase)) {
      return (
        <Alert tone="warning">
          <strong>Root 人工收敛请求已入队，生产发布锁继续保留。</strong>
          <span>控制器正在重新核验全部 API、Worker、制品身份与公网链路。全部通过后才会释放锁。</span>
        </Alert>
      );
    }
    return (
      <Alert tone="danger">
        <strong>自动恢复未能完成，需要人工介入。</strong>
        <span>{isRoot
          ? "故障节点已保持隔离，生产发布锁仍被占用。请核对现场后发起 Root 人工收敛，禁止直接挂回或绕过锁。"
          : "故障节点已保持隔离，生产发布锁仍被占用。仅 Root 可在完成 MFA 二次验证后发起人工收敛。"}</span>
      </Alert>
    );
  }
  if (deployment.status === "rolling_back") {
    return (
      <Alert tone="warning">
        <strong>节点校验失败，系统正在自动回滚。</strong>
        <span>控制器已停止后续升级，正在恢复上一版本、API 原负载均衡权重与 Worker 接单状态。</span>
      </Alert>
    );
  }
  if (deployment.status === "rolled_back") {
    return (
      <Alert tone="warning">
        <strong>发布未完成，所有受影响节点已恢复上一版本。</strong>
        <span>{deployment.safeError || "请根据事件记录修复制品或环境问题后重新发布。"}</span>
      </Alert>
    );
  }
  if (deployment.status === "failed") {
    return (
      <Alert tone="danger">
        <strong>发布失败。</strong>
        <span>{deployment.safeError || "控制器已停止执行，请检查事件记录。"}</span>
      </Alert>
    );
  }
  if (deployment.status === "succeeded") {
    return <Alert tone="success">全部受管 API 与 Worker 已运行目标制品，公网链路检查通过，版本已正式发布。</Alert>;
  }
  if (deployment.status === "cancelling") {
    return <Alert tone="warning">停止请求已受理。控制器会先恢复当前节点，再结束发布任务。</Alert>;
  }
  if (deployment.status === "cancelled") {
    return <Alert tone="info">发布任务已安全停止，未完成节点没有接收新版流量。</Alert>;
  }
  return null;
}

function EventItem({ event }: { event: ReleaseDeploymentEvent }) {
  const actorLabels = { operator: "管理员", orchestrator: "发布控制器", target: "目标节点" } as const;
  return (
    <li className={`releaseDeploymentEvent is-${event.level}`}>
      <span className="releaseDeploymentEvent__marker" aria-hidden="true" />
      <div>
        <div className="releaseDeploymentEvent__meta">
          <span>{formatDate(event.createdAt)}</span>
          <span>{actorLabels[event.actor]}</span>
          <span>{phaseLabel(event.phase)}</span>
        </div>
        <p>{event.message}</p>
      </div>
    </li>
  );
}

export function DeploymentDrawer({
  open,
  deploymentId,
  releaseVersion,
  initialDeployment,
  onOpenChange,
  onDeploymentChanged,
}: {
  open: boolean;
  deploymentId: string | null;
  releaseVersion?: string;
  initialDeployment?: ReleaseDeploymentDetail | null;
  onOpenChange: (open: boolean) => void;
  onDeploymentChanged?: () => void;
}) {
  const { toast } = useToast();
  const currentUserRole = useAuthStore((state) => state.user?.role);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const deploymentQuery = useFinanceQuery<ReleaseDeploymentDetail | null>(
    () => deploymentId ? getReleaseDeployment(deploymentId) : Promise.resolve(null),
    deploymentId || "no-deployment",
    initialDeployment || null,
  );
  const eventQuery = useFinanceQuery<ReleaseDeploymentEventPage>(
    () => deploymentId
      ? listReleaseDeploymentEvents({ deploymentId, afterSeq: 0, limit: 200 })
      : Promise.resolve(emptyEventPage),
    deploymentId || "no-deployment-events",
    emptyEventPage,
  );
  const deployment = deploymentQuery.data || initialDeployment || null;
  const isRoot = String(currentUserRole || "").trim().toLowerCase() === "root";
  const events = useMemo(
    () => [...(eventQuery.data.items || [])].sort((left, right) => left.sequence - right.sequence).slice(-80),
    [eventQuery.data.items],
  );

  useEffect(() => {
    if (!open || !deployment || !shouldPollDeployment(deployment.status, deployment.phase) || deploymentQuery.loading || eventQuery.loading) return;
    const timer = window.setTimeout(() => {
      void Promise.all([deploymentQuery.reload(), eventQuery.reload()]);
    }, DEPLOYMENT_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [
    deployment?.id,
    deployment?.phase,
    deployment?.status,
    deployment?.updatedAt,
    deploymentQuery.loading,
    deploymentQuery.reload,
    eventQuery.loading,
    eventQuery.reload,
    open,
  ]);

  useEffect(() => {
    if (!deployment || shouldPollDeployment(deployment.status, deployment.phase)) return;
    onDeploymentChanged?.();
  }, [deployment?.id, deployment?.phase, deployment?.status, onDeploymentChanged]);

  async function confirmCancel() {
    if (!deployment || cancelling) return;
    if (cancelReason.trim().length < 3) {
      setCancelError("请填写至少 3 个字符的停止原因。");
      return;
    }
    setCancelling(true);
    setCancelError("");
    try {
      await cancelReleaseDeployment(deployment, cancelReason.trim());
      setCancelOpen(false);
      setCancelReason("");
      toast({ title: "停止请求已提交", message: "发布控制器将安全恢复当前节点后结束任务。", tone: "warning" });
      await Promise.all([deploymentQuery.reload(), eventQuery.reload()]);
      onDeploymentChanged?.();
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "停止发布失败，请重试。");
    } finally {
      setCancelling(false);
    }
  }

  function handleReconciliationRequested(result: ReleaseDeploymentReconciliationRecord) {
    toast({
      title: "人工收敛请求已入队",
      message: result.intent === "previous"
        ? "控制器将核验并收敛到上一正式版本，生产锁在验证完成前继续保留。"
        : "控制器将核验并收敛到本次目标版本，生产锁在验证完成前继续保留。",
      tone: "warning",
      duration: 6000,
    });
    void Promise.all([deploymentQuery.reload(), eventQuery.reload()]);
    onDeploymentChanged?.();
  }

  const progress = deployment
    ? deploymentProgress(deployment.completedTargetCount, deployment.targetCount)
    : 0;
  const canCancel = deployment && (deployment.status === "queued" || deployment.status === "running");
  const canReconcile = deployment
    ? canRequestManualReconciliation(deployment.status, deployment.phase, currentUserRole)
    : false;
  const reconciliationInProgress = Boolean(deployment && isManualReconciliationInProgress(deployment.phase));
  const apiTargets = deployment?.targets.filter((target) => target.role === "api") || [];
  const workerTargets = deployment?.targets.filter((target) => target.role === "worker") || [];
  const executionTargets = workerTargets.length
    ? [workerTargets[0], ...apiTargets, ...workerTargets.slice(1)]
    : apiTargets;
  const targetGroups = [
    {
      key: "worker-bridge",
      role: "worker" as const,
      title: "① 新版 Worker 兼容桥",
      description: "先建立一台可接单的新版 Worker，为随后 API 跨版本滚动保留匹配执行端。",
      icon: Cpu,
      targets: workerTargets.slice(0, 1),
    },
    {
      key: "api-fleet",
      role: "api" as const,
      title: "② API 节点",
      description: "逐台从 CLB 摘流并排空连接；直连和 CLB 健康检查通过后恢复原权重。",
      icon: Server,
      targets: apiTargets,
    },
    {
      key: "worker-converge",
      role: "worker" as const,
      title: "③ 剩余 Worker",
      description: "全部 API 升级后，再逐台停接新任务、等待在途归零、升级并恢复接单。",
      icon: Cpu,
      targets: workerTargets.slice(1),
    },
  ];

  return (
    <>
      <Drawer
        open={open}
        title={releaseVersion ? `${releaseVersion} 发布进度` : "滚动发布进度"}
        description={deployment ? `任务 ${deployment.id}` : "读取发布任务状态。"}
        size="780px"
        onOpenChange={onOpenChange}
        contentClassName="releaseDeploymentDrawerContent"
        footer={(
          <div className="releaseDeploymentDrawerFooter">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>关闭</Button>
            <Button
              variant="secondary"
              icon={<RefreshCcw size={16} />}
              loading={deploymentQuery.loading && Boolean(deployment)}
              onClick={() => void Promise.all([deploymentQuery.reload(), eventQuery.reload()])}
            >
              刷新状态
            </Button>
            {canCancel ? (
              <Button variant="danger" icon={<Ban size={16} />} onClick={() => { setCancelError(""); setCancelOpen(true); }}>
                停止发布
              </Button>
            ) : null}
            {canReconcile ? (
              <Button variant="danger" icon={<ShieldAlert size={16} />} onClick={() => setReconcileOpen(true)}>
                Root 人工收敛
              </Button>
            ) : isRoot && reconciliationInProgress ? (
              <Button variant="danger" icon={<ShieldAlert size={16} />} disabled>
                人工收敛中
              </Button>
            ) : null}
          </div>
        )}
      >
        {deploymentQuery.loading && !deployment ? (
          <div className="releaseDeploymentSkeleton" aria-label="正在读取发布进度">
            <Skeleton height="88px" />
            <Skeleton height="180px" />
            <Skeleton height="220px" />
          </div>
        ) : deploymentQuery.error && !deployment ? (
          <Alert tone="danger">
            <span>{deploymentQuery.error}</span>
            <Button size="compact" variant="secondary" onClick={() => void deploymentQuery.reload()}>重试</Button>
          </Alert>
        ) : deployment ? (
          <div className="releaseDeploymentDetail">
            <DeploymentNotice deployment={deployment} isRoot={isRoot} />

            <section className="releaseDeploymentOverview" aria-labelledby="release-deployment-overview-title">
              <div className="releaseDeploymentOverview__head">
                <div>
                  <span className="releaseDeploymentOverview__icon" aria-hidden="true">
                    {deployment.status === "succeeded" ? <CheckCircle2 size={20} /> : deployment.status === "rolling_back" || deployment.status === "rolled_back" ? <RotateCcw size={20} /> : deployment.status === "degraded_manual" || deployment.status === "failed" ? <TriangleAlert size={20} /> : <Server size={20} />}
                  </span>
                  <div>
                    <h3 id="release-deployment-overview-title">{phaseLabel(deployment.phase)}</h3>
                    <span>{deployment.completedTargetCount} / {deployment.targetCount} 台受管节点处理完成，包含 {apiTargets.length} API 与 {workerTargets.length} Worker</span>
                  </div>
                </div>
                <Badge tone={deploymentStatusTone(deployment.status)}>
                  {reconciliationInProgress ? "人工收敛中" : deploymentStatusLabels[deployment.status]}
                </Badge>
              </div>
              <div className="releaseDeploymentProgress" role="progressbar" aria-label="服务器发布进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                <span style={{ width: `${progress}%` }} />
              </div>
              <dl>
                <div><dt>发布环境</dt><dd>{deployment.environment}</dd></div>
                <div><dt>受管拓扑</dt><dd>{apiTargets.length} API / {workerTargets.length} Worker</dd></div>
                <div><dt>发布策略</dt><dd>Worker 桥接式逐台滚动，API 最多摘流 {deployment.maxUnavailable} 台</dd></div>
                <div><dt>开始时间</dt><dd>{formatDate(deployment.startedAt || deployment.createdAt)}</dd></div>
              </dl>
            </section>

            <section className="releaseDeploymentTargets" aria-labelledby="release-deployment-targets-title">
              <div className="releaseSectionHeading">
                <div>
                  <h3 id="release-deployment-targets-title">节点阶段</h3>
                  <p>执行顺序为新版 Worker 桥、全部 API、剩余 Worker；当前节点恢复服务后才会继续。</p>
                </div>
                {shouldPollDeployment(deployment.status, deployment.phase) ? (
                  <span className="releaseLiveRefresh"><Clock3 size={14} aria-hidden="true" />活动任务每 2 秒更新</span>
                ) : null}
              </div>
              <div className="releaseDeploymentTargetGroups">
                {targetGroups.map((group) => {
                  const GroupIcon = group.icon;
                  return (
                    <section className={`releaseDeploymentTargetGroup is-${group.role}`} key={group.key} aria-labelledby={`release-target-group-${group.key}`}>
                      <header>
                        <div>
                          <GroupIcon size={16} aria-hidden="true" />
                          <span><strong id={`release-target-group-${group.key}`}>{group.title}</strong><small>{group.description}</small></span>
                        </div>
                        <Badge tone={group.targets.length ? "info" : "warning"}>{group.targets.length} 台</Badge>
                      </header>
                      {group.targets.length ? (
                        <ol>
                          {group.targets.map((target) => {
                            const stageLabels = targetStageLabelsForRole(target.role);
                            const statusLabel = targetStatusLabel(target.status, target.role);
                            return (
                              <li key={target.id} className="releaseDeploymentTarget">
                                <div className="releaseDeploymentTarget__head">
                                  <div>
                                    <span className="releaseDeploymentTarget__order">{executionTargets.indexOf(target) + 1}</span>
                                    <div><strong>{target.targetLabel}</strong><span>{target.targetKey}{target.attempt ? ` / 第 ${target.attempt} 次尝试` : ""}</span></div>
                                  </div>
                                  <Badge tone={targetStatusTone(target.status)}>{statusLabel}</Badge>
                                </div>
                                <div className={`releaseTargetStages is-${target.role}`} aria-label={`${target.targetLabel} 当前阶段：${statusLabel}`}>
                                  {stageLabels.map((label, index) => (
                                    <span key={label} className={`is-${targetStageState(target.status, index)}`}>
                                      <i aria-hidden="true" />{label}
                                    </span>
                                  ))}
                                </div>
                                {target.safeError ? <p className="releaseTargetError">{target.safeError}</p> : null}
                              </li>
                            );
                          })}
                        </ol>
                      ) : (
                        <p className="releaseEmptyTargetGroup">此发布任务没有{group.title}。</p>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>

            <section className="releaseDeploymentEvents" aria-labelledby="release-deployment-events-title">
              <div className="releaseSectionHeading">
                <div>
                  <h3 id="release-deployment-events-title">执行记录</h3>
                  <p>记录控制器、节点和管理员的关键动作，便于故障定位和审计。</p>
                </div>
                {eventQuery.error ? <Badge tone="warning">事件刷新失败</Badge> : null}
              </div>
              {events.length ? (
                <ol>{events.map((event) => <EventItem key={event.id || event.sequence} event={event} />)}</ol>
              ) : eventQuery.loading ? (
                <div className="releaseEventSkeleton"><Skeleton height="46px" /><Skeleton height="46px" /></div>
              ) : (
                <p className="releaseEmptyEvents">控制器接管任务后，执行记录会显示在这里。</p>
              )}
            </section>
          </div>
        ) : null}
      </Drawer>

      <Dialog
        open={cancelOpen}
        title="停止滚动发布"
        description="控制器会停止处理后续节点，并安全恢复当前节点。已经出现故障时可能进入自动回滚。"
        size="sm"
        loading={cancelling}
        onOpenChange={(nextOpen) => { if (!cancelling) setCancelOpen(nextOpen); }}
        footer={({ requestClose, pending }) => (
          <div className="releaseCancelFooter">
            <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>继续发布</Button>
            <Button variant="danger" loading={cancelling} disabled={cancelReason.trim().length < 3} onClick={() => void confirmCancel()}>确认停止</Button>
          </div>
        )}
      >
        <FormField label="停止原因" required optionalLabel={null} error={cancelError} help="原因会写入发布事件和审计日志。">
          <textarea rows={4} maxLength={500} value={cancelReason} onChange={(event) => { setCancelReason(event.target.value); setCancelError(""); }} placeholder="说明停止本次发布的原因" />
        </FormField>
      </Dialog>

      <ManualReconcileDialog
        open={reconcileOpen}
        deployment={deployment}
        releaseVersion={releaseVersion}
        onOpenChange={setReconcileOpen}
        onRequested={handleReconciliationRequested}
      />
    </>
  );
}
