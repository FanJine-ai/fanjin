import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, ClipboardList, Eye, RefreshCcw, Search, XCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAuthStore } from "../../../stores/authStore";
import { isPlatformAdmin } from "../../../utils/permissions";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  Drawer,
  FilterBar,
  Input,
  MetricStrip,
  Select,
  useToast,
  type DataTableColumn,
} from "../../../ui/console";
import { cancelRelayTask, refreshRelayTask } from "./api";
import { useRelayTasks } from "./hooks";
import {
  invalidRelayTaskDateRange,
  positivePage,
  readRelayTaskFilters,
  relayTaskPageSize,
  relayTaskParams,
} from "./query";
import type { RelayTaskFilters, RelayTaskRow } from "./types";
import {
  canCancelStatus,
  canRefreshStatus,
  dateBoundary,
  emptyRelayTaskFilters,
  formatDate,
  normalizeRelayTask,
  safeJson,
  taskStatusLabel,
  taskStatusTone,
} from "./utils";
import "./styles.css";

function StatusBadge({ status }: { status: string }) {
  const tone = taskStatusTone(status);
  const Icon = tone === "success" ? CheckCircle2 : tone === "danger" ? XCircle : tone === "warning" ? Activity : ClipboardList;
  return <Badge tone={tone} icon={<Icon size={14} />}>{taskStatusLabel(status)}</Badge>;
}

function TaskDetail({ row }: { row: RelayTaskRow }) {
  const task = row.source;
  const providerPayload = task.providerPayload as Record<string, unknown> | null;
  const requestPayload = task.requestPayload as Record<string, unknown> | null;
  const callback = providerPayload?.callback && typeof providerPayload.callback === "object" && !Array.isArray(providerPayload.callback)
    ? providerPayload.callback as Record<string, unknown>
    : null;
  const progress = typeof task.progress === "number"
    ? task.progress
    : task.progress?.progressPercent ?? task.progress?.progress;
  return (
    <div className="adminTasksDetail">
      {row.failureReason !== "-" ? (
        <section className="adminTasksFailureSection" aria-labelledby="task-failure-heading">
          <div className="adminTasksFailureHeading">
            <AlertTriangle aria-hidden="true" size={16} />
            <h3 id="task-failure-heading">失败原因</h3>
          </div>
          <p>{row.failureReason}</p>
        </section>
      ) : null}
      <section aria-labelledby="task-overview-heading">
        <h3 id="task-overview-heading">任务概况</h3>
        <dl className="adminTasksDetailList">
          <div><dt>任务 ID</dt><dd><code>{row.id}</code></dd></div>
          <div><dt>上游任务 ID</dt><dd><code>{String(task.providerTaskId || "-")}</code></dd></div>
          <div><dt>请求 ID</dt><dd><code>{String(task.requestId || "-")}</code></dd></div>
          <div><dt>模型 / 能力</dt><dd>{row.model} / {String(task.endpointType || "-")}</dd></div>
          <div><dt>供应商 / 通道</dt><dd>{row.provider} / {String(task.channel?.name || task.channelId || "-")}</dd></div>
          <div><dt>工作区</dt><dd>{row.workspace}</dd></div>
          <div><dt>状态 / 进度</dt><dd className="adminTasksStatusValue"><StatusBadge status={row.status} />{progress != null ? <span>{progress}%</span> : null}</dd></div>
          <div><dt>创建 / 更新</dt><dd>{row.createdAt} / {formatDate(task.updateTime)}</dd></div>
          <div><dt>提交 / 完成</dt><dd>{formatDate(task.submittedAt)} / {formatDate(task.completedAt)}</dd></div>
          <div><dt>成本</dt><dd>{row.cost}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="task-callback-heading">
        <h3 id="task-callback-heading">回调上下文</h3>
        <dl className="adminTasksDetailList">
          <div><dt>回调地址</dt><dd>{String(task.callbackUrl || requestPayload?.callback_url || requestPayload?.callbackUrl || "-")}</dd></div>
          <div><dt>回调状态</dt><dd>{String(task.callbackStatus || callback?.status || "-")}</dd></div>
          <div><dt>回调次数</dt><dd>{String(task.callbackAttempts ?? callback?.attempts ?? "-")}</dd></div>
        </dl>
        {callback ? <pre className="adminTasksCode">{safeJson(callback)}</pre> : null}
      </section>
      <section aria-labelledby="task-payload-heading">
        <h3 id="task-payload-heading">请求与结果</h3>
        <Accordion multiple>
          <AccordionItem value="request-payload">
            <AccordionTrigger>请求参数</AccordionTrigger>
            <AccordionContent><pre className="adminTasksCode">{safeJson(task.requestPayload)}</pre></AccordionContent>
          </AccordionItem>
          <AccordionItem value="provider-payload">
            <AccordionTrigger>上游参数</AccordionTrigger>
            <AccordionContent><pre className="adminTasksCode">{safeJson(task.providerPayload)}</pre></AccordionContent>
          </AccordionItem>
          <AccordionItem value="result-payload">
            <AccordionTrigger>结果参数</AccordionTrigger>
            <AccordionContent><pre className="adminTasksCode">{safeJson(task.resultPayload)}</pre></AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>
      <section aria-labelledby="task-billing-heading">
        <h3 id="task-billing-heading">计费与资源</h3>
        <pre className="adminTasksCode">{safeJson({ billing: task.billing, assets: task.assets, internalPlan: task.internalPlan })}</pre>
      </section>
    </div>
  );
}

export default function AdminRelayTasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsKey = searchParams.toString();
  const activeFilters = useMemo(() => readRelayTaskFilters(searchParams), [paramsKey]);
  const [draft, setDraft] = useState(activeFilters);
  const page = positivePage(searchParams.get("page"));
  const pageSize = relayTaskPageSize(searchParams.get("size"));
  const startTime = dateBoundary(activeFilters.startDate, "start");
  const endTime = dateBoundary(activeFilters.endDate, "end");
  const state = useRelayTasks({
    pageNum: page,
    pageSize,
    ...(activeFilters.status.trim() ? { status: activeFilters.status.trim() } : {}),
    ...(activeFilters.keyword.trim() ? { keyword: activeFilters.keyword.trim() } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
  });
  const rows = useMemo(() => {
    const items = Array.isArray(state.data.items) ? state.data.items : Array.isArray(state.data.data) ? state.data.data : [];
    return items.map(normalizeRelayTask);
  }, [state.data]);
  const summary = state.data.summary || {};
  const total = Number(state.data.total || 0);
  const running = Object.entries(summary).filter(([status]) => canRefreshStatus(status)).reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const failed = Object.entries(summary).filter(([status]) => /fail|error/i.test(status)).reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const [detailRow, setDetailRow] = useState<RelayTaskRow | null>(null);
  const [cancelRow, setCancelRow] = useState<RelayTaskRow | null>(null);
  const [actionId, setActionId] = useState("");
  const actionInFlight = useRef(false);
  const { toast } = useToast();
  const user = useAuthStore((store) => store.user);
  const workspace = useAuthStore((store) => store.currentWorkspace);
  const canMutate = isPlatformAdmin({ user, workspace });

  useEffect(() => setDraft(activeFilters), [paramsKey]);

  function writeParams(filters: RelayTaskFilters, nextPage = 1, nextSize = pageSize) {
    setSearchParams(relayTaskParams(filters, nextPage, nextSize));
  }

  function applyFilters() {
    if (invalidRelayTaskDateRange(draft)) {
      toast({ title: "时间范围无效", message: "开始日期不能晚于结束日期。", tone: "danger" });
      return;
    }
    writeParams(draft);
  }

  async function handleRefresh(row: RelayTaskRow) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionId(row.id);
    try {
      await refreshRelayTask(row.id);
      toast({ title: "任务已重新同步", message: `已请求更新任务 ${row.id} 的上游状态。`, tone: "success" });
      state.reload();
    } catch (error) {
      toast({ title: "任务同步失败", message: error instanceof Error ? error.message : "请稍后重试。", tone: "danger" });
    } finally {
      actionInFlight.current = false;
      setActionId("");
    }
  }

  async function handleCancel() {
    if (!cancelRow || actionInFlight.current) return false;
    actionInFlight.current = true;
    setActionId(cancelRow.id);
    try {
      await cancelRelayTask(cancelRow.id);
      toast({ title: "任务已取消", message: `任务 ${cancelRow.id} 不会继续执行。`, tone: "success" });
      if (detailRow?.id === cancelRow.id) setDetailRow(null);
      state.reload();
      return true;
    } catch (error) {
      toast({ title: "取消失败", message: error instanceof Error ? error.message : "请稍后重试。", tone: "danger" });
      return false;
    } finally {
      actionInFlight.current = false;
      setActionId("");
    }
  }

  const columns = useMemo<DataTableColumn<RelayTaskRow>[]>(() => [
    { id: "task", header: "任务", priority: "primary", minWidth: "210px", cell: (row) => <div className="adminTasksIdentity"><strong>{row.model}</strong><code>{row.id}</code></div> },
    { id: "provider", header: "供应商", accessor: "provider", priority: "secondary", sortable: true },
    { id: "status", header: "状态", priority: "primary", cell: (row) => <StatusBadge status={row.status} /> },
    { id: "workspace", header: "工作区", accessor: "workspace", priority: "secondary" },
    { id: "cost", header: "成本", accessor: "cost", priority: "detail", align: "end" },
    { id: "created", header: "创建时间", priority: "secondary", sortable: true, sortValue: (row) => row.createdTimestamp, cell: (row) => row.createdAt },
    { id: "actions", header: "操作", headerLabel: "行操作", priority: "primary", hideable: false, cell: (row) => <Button size="compact" variant="secondary" icon={<Eye size={16} />} onClick={() => setDetailRow(row)}>查看</Button> },
  ], []);

  return (
    <ConsolePage
      title="视频任务"
      description="集中排查平台视频任务、上游状态、失败原因、回调与计费上下文。"
      primaryAction={<Button variant="secondary" icon={<RefreshCcw size={17} />} loading={state.loading} onClick={state.reload}>刷新</Button>}
      layoutWidth="dashboard"
    >
      <MetricStrip metrics={[
        { id: "total", label: "任务总数", value: state.loading ? "加载中" : state.error ? "-" : total.toLocaleString(), hint: state.error ? "读取失败" : "当前筛选范围" },
        { id: "running", label: "处理中", value: state.loading || state.error ? "-" : running.toLocaleString(), hint: state.error ? "读取失败" : "排队、执行与高清处理", tone: "warning" },
        { id: "failed", label: "失败任务", value: state.loading || state.error ? "-" : failed.toLocaleString(), hint: state.error ? "读取失败" : failed ? "需要排查" : "当前无失败", tone: failed ? "danger" : "positive" },
      ]} />
      <section className="adminTasksWorkbench" aria-label="视频任务工作台">
        <FilterBar actions={<div className="adminTasksActions"><Button icon={<Search size={16} />} onClick={applyFilters}>查询</Button><Button variant="ghost" onClick={() => { setDraft(emptyRelayTaskFilters); writeParams(emptyRelayTaskFilters); }}>清除</Button></div>}>
          <label className="adminTasksField adminTasksField--keyword"><span>关键词</span><Input value={draft.keyword} onChange={(event) => setDraft((current) => ({ ...current, keyword: event.target.value }))} placeholder="任务、请求、模型或供应商" onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }} /></label>
          <label className="adminTasksField"><span>状态</span><Select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}><option value="">全部状态</option><option value="queued">排队中</option><option value="running">执行中</option><option value="enhancing">高清处理中</option><option value="succeeded">已完成</option><option value="failed">失败</option><option value="cancelled">已取消</option></Select></label>
          <label className="adminTasksField"><span>开始日期</span><Input type="date" value={draft.startDate} max={draft.endDate || undefined} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} /></label>
          <label className="adminTasksField"><span>结束日期</span><Input type="date" value={draft.endDate} min={draft.startDate || undefined} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} /></label>
        </FilterBar>
        <DataTable columns={columns} rows={rows} getRowId={(row) => row.id} caption="平台视频任务列表" loading={state.loading} error={state.error || undefined} onRetry={state.reload} emptyState="当前条件下暂无视频任务" onRowClick={setDetailRow} getRowAriaLabel={(row) => `查看任务 ${row.id} 详情`} page={page} pageSize={pageSize} totalRows={total} manualPagination onPageChange={(nextPage) => writeParams(activeFilters, nextPage)} onPageSizeChange={(nextSize) => writeParams(activeFilters, 1, nextSize)} />
      </section>
      <Drawer open={Boolean(detailRow)} title={detailRow ? `任务详情 · ${detailRow.id}` : "任务详情"} description="失败原因、回调、请求结果和计费信息集中在此查看。" size="min(760px, 100vw)" onOpenChange={(open) => { if (!open && !actionId) setDetailRow(null); }} loading={Boolean(actionId)} footer={detailRow && canMutate && (canRefreshStatus(detailRow.status) || canCancelStatus(detailRow.status)) ? <div className="adminTasksDrawerActions">{canRefreshStatus(detailRow.status) ? <Button variant="secondary" icon={<RefreshCcw size={16} />} loading={actionId === detailRow.id} onClick={() => void handleRefresh(detailRow)}>重试 / 同步</Button> : null}{canCancelStatus(detailRow.status) ? <Button variant="danger" icon={<AlertTriangle size={16} />} disabled={Boolean(actionId)} onClick={() => setCancelRow(detailRow)}>取消任务</Button> : null}</div> : undefined}>
        {detailRow ? <TaskDetail row={detailRow} /> : null}
      </Drawer>
      <ConfirmDialog open={Boolean(cancelRow)} title="取消视频任务？" description={cancelRow ? `将取消任务 ${cancelRow.id}。上游已提交或已结算的费用可能无法自动退回，请确认已理解影响。` : undefined} confirmLabel="确认取消" tone="danger" loading={Boolean(actionId)} onCancel={() => { if (!actionId) setCancelRow(null); }} onConfirm={handleCancel} />
    </ConsolePage>
  );
}
