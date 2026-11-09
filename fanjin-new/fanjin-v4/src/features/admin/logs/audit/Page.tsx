import { useEffect, useMemo, useState } from "react";
import { Copy, Eye, RefreshCcw, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  Badge,
  Button,
  ConsolePage,
  DataTable,
  Drawer,
  FilterBar,
  Input,
  MetricStrip,
  useToast,
  type DataTableColumn,
} from "../../../../ui/console";
import {
  auditLogPageSize,
  auditLogParams,
  invalidAuditLogDateRange,
  positiveAuditLogInteger,
  readAuditLogFilters,
} from "./query";
import type { AuditLogFilters, AuditLogListInput, AuditLogRow } from "./types";
import { useAuditLogs } from "./useAuditLogs";
import {
  actionTone,
  auditDiff,
  dateBoundary,
  emptyAuditLogFilters,
  normalizeAuditLog,
  safeJson,
} from "./utils";
import "./audit-logs.css";

function ActionBadge({ action }: { action: string }) {
  return <Badge tone={actionTone(action)} icon={<ShieldCheck size={14} />}>{action}</Badge>;
}

function AuditDetail({ row }: { row: AuditLogRow }) {
  const diff = auditDiff(row.metadata);
  return (
    <div className="auditLogsDetail">
      <section aria-labelledby="audit-overview-heading">
        <h3 id="audit-overview-heading">事件概况</h3>
        <dl className="auditLogsDetailList">
          <div><dt>事件 ID</dt><dd><code>{row.id}</code></dd></div>
          <div><dt>动作</dt><dd><ActionBadge action={row.action} /></dd></div>
          <div><dt>资源</dt><dd>{row.resourceType} / <code>{row.resourceId}</code></dd></div>
          <div><dt>操作者</dt><dd>{row.actorUserId} / {row.actorRole}</dd></div>
          <div><dt>工作区</dt><dd><code>{row.workspaceId}</code></dd></div>
          <div><dt>发生时间</dt><dd>{row.time}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="audit-request-heading">
        <h3 id="audit-request-heading">请求上下文</h3>
        <dl className="auditLogsDetailList">
          <div><dt>IP（脱敏）</dt><dd>{row.ip}</dd></div>
          <div><dt>User-Agent</dt><dd>{row.userAgent}</dd></div>
        </dl>
      </section>
      {diff.hasDiff ? (
        <section aria-labelledby="audit-diff-heading">
          <h3 id="audit-diff-heading">变更差异（脱敏）</h3>
          {diff.changes !== undefined ? <div><h4>Changes / Diff</h4><pre className="auditLogsCode">{safeJson(diff.changes)}</pre></div> : null}
          {(diff.before !== undefined || diff.after !== undefined) ? <div className="auditLogsDiff">
            <div><h4>变更前</h4><pre className="auditLogsCode">{safeJson(diff.before)}</pre></div>
            <div><h4>变更后</h4><pre className="auditLogsCode">{safeJson(diff.after)}</pre></div>
          </div> : null}
        </section>
      ) : null}
      <section aria-labelledby="audit-metadata-heading">
        <h3 id="audit-metadata-heading">完整上下文（脱敏）</h3>
        <pre className="auditLogsCode">{safeJson(row.metadata)}</pre>
      </section>
    </div>
  );
}

export default function AdminAuditLogsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsKey = searchParams.toString();
  const activeFilters = useMemo(() => readAuditLogFilters(searchParams), [paramsKey]);
  const [draft, setDraft] = useState(activeFilters);
  const page = positiveAuditLogInteger(searchParams.get("page"), 1) || 1;
  const pageSize = auditLogPageSize(searchParams.get("size"));
  const actorUserId = positiveAuditLogInteger(activeFilters.actorUserId);
  const startTime = dateBoundary(activeFilters.startDate, "start");
  const endTime = dateBoundary(activeFilters.endDate, "end");
  const input = useMemo<AuditLogListInput>(() => ({
    pageNum: page,
    pageSize,
    ...(activeFilters.keyword.trim() ? { keyword: activeFilters.keyword.trim() } : {}),
    ...(activeFilters.action.trim() ? { action: activeFilters.action.trim() } : {}),
    ...(activeFilters.resourceType.trim() ? { resourceType: activeFilters.resourceType.trim() } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(activeFilters.workspaceId.trim() ? { workspaceId: activeFilters.workspaceId.trim() } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
  }), [activeFilters.action, activeFilters.keyword, activeFilters.resourceType, activeFilters.workspaceId, actorUserId, endTime, page, pageSize, startTime]);
  const state = useAuditLogs(input);
  const rows = useMemo(() => {
    const items = Array.isArray(state.data.items) ? state.data.items : Array.isArray(state.data.data) ? state.data.data : [];
    return items.map(normalizeAuditLog);
  }, [state.data]);
  const total = Number(state.data.total || 0);
  const uniqueActors = new Set(rows.map((row) => row.actorUserId).filter((value) => value !== "-")).size;
  const uniqueResources = new Set(rows.map((row) => row.resourceType).filter((value) => value !== "-")).size;
  const advancedCount = [activeFilters.actorUserId, activeFilters.workspaceId, activeFilters.startDate, activeFilters.endDate].filter(Boolean).length;
  const [detailRow, setDetailRow] = useState<AuditLogRow | null>(null);
  const { toast } = useToast();

  useEffect(() => setDraft(activeFilters), [paramsKey]);

  function writeParams(filters: AuditLogFilters, nextPage = 1, nextSize = pageSize) {
    setSearchParams(auditLogParams(filters, nextPage, nextSize));
  }

  function applyFilters() {
    if (draft.actorUserId.trim() && !positiveAuditLogInteger(draft.actorUserId)) {
      toast({ title: "操作者 ID 无效", message: "请输入大于 0 的整数用户 ID。", tone: "danger" });
      return;
    }
    if (invalidAuditLogDateRange(draft)) {
      toast({ title: "时间范围无效", message: "开始日期不能晚于结束日期。", tone: "danger" });
      return;
    }
    writeParams(draft);
    toast({ title: "筛选条件已应用", tone: "success" });
  }

  function clearFilters() {
    setDraft(emptyAuditLogFilters);
    writeParams(emptyAuditLogFilters);
    toast({ title: "筛选条件已清除", tone: "info" });
  }

  async function copyContext() {
    if (!detailRow) return;
    try {
      await navigator.clipboard.writeText(safeJson({
        id: detailRow.id,
        action: detailRow.action,
        resourceType: detailRow.resourceType,
        resourceId: detailRow.resourceId,
        actorUserId: detailRow.actorUserId,
        actorRole: detailRow.actorRole,
        workspaceId: detailRow.workspaceId,
        time: detailRow.time,
        metadata: detailRow.metadata,
      }));
      toast({ title: "脱敏上下文已复制", tone: "success" });
    } catch {
      toast({ title: "复制失败", message: "浏览器未允许访问剪贴板。", tone: "danger" });
    }
  }

  const columns = useMemo<DataTableColumn<AuditLogRow>[]>(() => [
    { id: "action", header: "动作", priority: "primary", minWidth: "190px", sortable: true, sortValue: (row) => row.action, cell: (row) => <ActionBadge action={row.action} /> },
    { id: "resource", header: "资源", priority: "primary", minWidth: "190px", cell: (row) => <div className="auditLogsIdentity"><strong>{row.resourceType}</strong><code>{row.resourceId}</code></div> },
    { id: "actor", header: "操作者", priority: "secondary", sortable: true, sortValue: (row) => row.actorUserId, cell: (row) => <div className="auditLogsIdentity"><strong>{row.actorUserId}</strong><span className="auditLogsMuted">{row.actorRole}</span></div> },
    { id: "workspace", header: "工作区", priority: "detail", accessor: "workspaceId" },
    { id: "time", header: "时间", priority: "secondary", sortable: true, sortValue: (row) => row.timestamp, accessor: "time" },
    { id: "actions", header: "操作", headerLabel: "行操作", priority: "primary", hideable: false, cell: (row) => <Button size="compact" variant="secondary" icon={<Eye size={16} />} onClick={() => setDetailRow(row)}>查看</Button> },
  ], []);

  return (
    <ConsolePage
      title="审计日志"
      description="追踪平台敏感操作、操作者和资源变更；上下文与差异均以脱敏形式展示。"
      primaryAction={<Button variant="secondary" icon={<RefreshCcw size={17} />} loading={state.loading} onClick={state.reload}>刷新</Button>}
      layoutWidth="dashboard"
    >
      <MetricStrip metrics={[
        { id: "total", label: "审计事件", value: state.loading ? "加载中" : state.error ? "-" : total.toLocaleString(), hint: state.error ? "读取失败" : "服务端筛选总数" },
        { id: "actors", label: "操作者", value: state.loading || state.error ? "-" : uniqueActors.toLocaleString(), hint: state.error ? "读取失败" : "当前页去重", tone: "info" },
        { id: "resources", label: "资源类型", value: state.loading || state.error ? "-" : uniqueResources.toLocaleString(), hint: state.error ? "读取失败" : "当前页去重", tone: "warning" },
      ]} />
      <section className="auditLogsWorkbench" aria-label="审计日志工作台">
        <FilterBar activeAdvancedCount={advancedCount} advanced={<>
          <label className="auditLogsField"><span>操作者 ID</span><Input inputMode="numeric" value={draft.actorUserId} onChange={(event) => setDraft((current) => ({ ...current, actorUserId: event.target.value }))} placeholder="精确用户 ID" /></label>
          <label className="auditLogsField"><span>工作区 ID</span><Input value={draft.workspaceId} onChange={(event) => setDraft((current) => ({ ...current, workspaceId: event.target.value }))} placeholder="精确工作区 ID" /></label>
          <label className="auditLogsField"><span>开始日期</span><Input type="date" value={draft.startDate} max={draft.endDate || undefined} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} /></label>
          <label className="auditLogsField"><span>结束日期</span><Input type="date" value={draft.endDate} min={draft.startDate || undefined} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} /></label>
        </>} actions={<div className="auditLogsActions"><Button icon={<Search size={16} />} onClick={applyFilters}>查询</Button><Button variant="ghost" icon={<RotateCcw size={16} />} onClick={clearFilters}>清除</Button></div>}>
          <label className="auditLogsField auditLogsField--keyword"><span>关键词</span><Input value={draft.keyword} onChange={(event) => setDraft((current) => ({ ...current, keyword: event.target.value }))} placeholder="事件、资源、操作者或上下文" onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }} /></label>
          <label className="auditLogsField"><span>动作</span><Input value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))} placeholder="例如 admin.model_route.update" /></label>
          <label className="auditLogsField"><span>资源类型</span><Input value={draft.resourceType} onChange={(event) => setDraft((current) => ({ ...current, resourceType: event.target.value }))} placeholder="例如 model_route" /></label>
        </FilterBar>
        <DataTable columns={columns} rows={rows} getRowId={(row) => row.id} caption="平台审计日志列表" loading={state.loading} error={state.error || undefined} onRetry={state.reload} emptyState="当前条件下暂无审计事件" onRowClick={setDetailRow} getRowAriaLabel={(row) => `查看审计事件 ${row.action} 详情`} page={page} pageSize={pageSize} totalRows={total} manualPagination onPageChange={(nextPage) => writeParams(activeFilters, nextPage)} onPageSizeChange={(nextSize) => writeParams(activeFilters, 1, nextSize)} />
      </section>
      <Drawer open={Boolean(detailRow)} title={detailRow ? `审计事件 · ${detailRow.action}` : "审计事件"} description="查看脱敏后的资源、请求上下文和变更差异。" size="min(760px, 100vw)" onOpenChange={(open) => { if (!open) setDetailRow(null); }} footer={detailRow ? <div className="auditLogsActions"><Button variant="secondary" icon={<Copy size={16} />} onClick={() => void copyContext()}>复制脱敏上下文</Button></div> : undefined}>
        {detailRow ? <AuditDetail row={detailRow} /> : null}
      </Drawer>
    </ConsolePage>
  );
}
