import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock3, RefreshCcw, RotateCcw, Search, ServerCrash } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  DataTable,
  Drawer,
  FilterBar,
  Input,
  MetricStrip,
  Select,
  useToast,
  type DataTableColumn,
} from "../../../../ui/console";
import { useRequestLogs } from "./useRequestLogs";
import {
  buildRequestLogFilterPayload,
  invalidRequestLogDateRange,
  positiveRequestLogInteger,
  readRequestLogFilters,
  requestLogPageSize,
  requestLogParams,
} from "./query";
import {
  emptyRequestLogFilters,
  type RequestLogFilters,
  type RequestLogListInput,
  type RequestLogRow,
  type RequestLogSearchField,
  type RequestLogStatsInput,
} from "./types";
import {
  formatRequestLogDuration,
  normalizeRequestLogRow,
  requestLogStatusTone,
} from "./utils";
import "./request-logs.css";

const searchFields: Array<{ value: RequestLogSearchField; label: string }> = [
  { value: "path", label: "请求路径" },
  { value: "requestId", label: "请求 ID" },
  { value: "relayTaskId", label: "任务 ID" },
  { value: "apiKeyPrefix", label: "Key 前缀" },
];

function StatusBadge({ statusCode }: { statusCode: number }) {
  const tone = requestLogStatusTone(statusCode);
  const Icon = tone === "success" ? CheckCircle2 : tone === "danger" ? ServerCrash : AlertTriangle;
  return <Badge tone={tone} icon={<Icon size={14} />}>{statusCode || "-"}</Badge>;
}

function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`requestLogsField ${className}`.trim()}><span>{label}</span>{children}</label>;
}

function RequestLogsContent() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const paramsKey = searchParams.toString();
  const activeFilters = useMemo(() => readRequestLogFilters(searchParams), [paramsKey]);
  const [draft, setDraft] = useState<RequestLogFilters>(activeFilters);
  const page = positiveRequestLogInteger(searchParams.get("page")) || 1;
  const pageSize = requestLogPageSize(searchParams.get("size"));
  const [detailRow, setDetailRow] = useState<RequestLogRow | null>(null);

  useEffect(() => setDraft(activeFilters), [paramsKey]);

  const filterPayload = useMemo(() => buildRequestLogFilterPayload(activeFilters), [paramsKey]);
  const listInput = useMemo<RequestLogListInput>(() => ({ ...filterPayload, pageNum: page, pageSize }), [filterPayload, page, pageSize]);
  const statsInput = useMemo<RequestLogStatsInput>(() => ({ ...filterPayload, ...(!filterPayload.startTime ? { days: 7 } : {}) }), [filterPayload]);
  const requestState = useRequestLogs(listInput, statsInput);

  useEffect(() => {
    if (requestState.effectivePageNum === page) return;
    const next = new URLSearchParams(paramsKey);
    if (requestState.effectivePageNum <= 1) next.delete("page");
    else next.set("page", String(requestState.effectivePageNum));
    setSearchParams(next, { replace: true });
  }, [page, paramsKey, requestState.effectivePageNum, setSearchParams]);

  const items = Array.isArray(requestState.list.items) ? requestState.list.items : Array.isArray(requestState.list.data) ? requestState.list.data : [];
  const rows = useMemo(() => items.map(normalizeRequestLogRow), [items]);
  const totalRows = Number(requestState.list.total ?? rows.length);
  const statsTotal = Number(requestState.stats.total ?? 0);
  const successRate = statsTotal ? `${((Number(requestState.stats.status2xx || 0) / statsTotal) * 100).toFixed(1)}%` : "-";
  const advancedCount = [activeFilters.workspaceId, activeFilters.actorUserId, activeFilters.apiKeyPrefix, activeFilters.requestId, activeFilters.relayTaskId, activeFilters.startDate, activeFilters.endDate].filter(Boolean).length;

  function updateDraft<K extends keyof RequestLogFilters>(key: K, value: RequestLogFilters[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function applyFilters() {
    if (invalidRequestLogDateRange(draft)) {
      toast({ title: "时间范围无效", message: "开始日期不能晚于结束日期。", tone: "danger" });
      return;
    }
    setSearchParams(requestLogParams(draft, pageSize));
    toast({ title: "筛选条件已应用", message: "列表与统计将按新条件刷新。", tone: "success" });
  }

  function clearFilters() {
    setDraft(emptyRequestLogFilters);
    const next = new URLSearchParams();
    if (pageSize !== 20) next.set("size", String(pageSize));
    setSearchParams(next);
    toast({ title: "筛选条件已清除", tone: "info" });
  }

  function updatePage(nextPage: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("page"); else next.set("page", String(nextPage));
    setSearchParams(next);
  }

  function updatePageSize(nextPageSize: number) {
    const next = new URLSearchParams(searchParams);
    next.delete("page");
    if (nextPageSize === 20) next.delete("size"); else next.set("size", String(nextPageSize));
    setSearchParams(next);
  }

  const columns = useMemo<DataTableColumn<RequestLogRow>[]>(() => [
    {
      id: "request", header: "请求", priority: "primary", minWidth: "260px", hideable: false,
      cell: (row) => <div className="requestLogsRequestCell"><strong><span>{row.method}</span> {row.path}</strong><span>{row.time} · Key {row.apiKeyPrefix}</span></div>,
      sortValue: (row) => row.timestamp, sortable: true,
    },
    { id: "statusCode", header: "状态", priority: "primary", width: "96px", accessor: "statusCode", cell: (row) => <StatusBadge statusCode={row.statusCode} />, sortable: true },
    { id: "duration", header: "耗时", priority: "secondary", width: "112px", align: "end", accessor: "duration", sortValue: (row) => row.durationMs, sortable: true },
    { id: "workspaceId", header: "工作区", priority: "secondary", minWidth: "160px", accessor: "workspaceId" },
    { id: "model", header: "模型", priority: "detail", minWidth: "140px", accessor: "model" },
    { id: "requestId", header: "请求 ID", priority: "detail", minWidth: "180px", accessor: "requestId", defaultVisible: false },
    { id: "errorCode", header: "错误码", priority: "detail", minWidth: "140px", accessor: "errorCode", defaultVisible: false },
  ], []);

  return (
    <ConsolePage
      title="平台请求日志"
      description="查询平台请求、错误与耗时，完整上下文在脱敏详情抽屉中查看。"
      primaryAction={<Button variant="secondary" icon={<RefreshCcw size={17} />} loading={requestState.listLoading} onClick={() => { requestState.retryAll(); toast({ title: "正在刷新请求日志", tone: "info" }); }}>刷新</Button>}
      layoutWidth="dashboard"
    >

      <MetricStrip metrics={[
        { id: "total", label: "请求总量", value: requestState.statsLoading ? "…" : requestState.statsError ? "-" : statsTotal.toLocaleString(), hint: requestState.statsError ? "统计读取失败" : filterPayload.startTime ? "所选时间范围" : "近 7 天" },
        { id: "success", label: "成功率", value: requestState.statsLoading || requestState.statsError ? "-" : successRate, hint: requestState.statsError ? "统计读取失败" : "2xx / 总请求", tone: "positive" },
        { id: "average", label: "平均响应", value: requestState.statsLoading || requestState.statsError ? "-" : statsTotal ? formatRequestLogDuration(requestState.stats.avgDurationMs) : "-", hint: requestState.statsError ? "统计读取失败" : "平均耗时", tone: "info" },
        { id: "p95", label: "P95 响应", value: requestState.statsLoading || requestState.statsError ? "-" : statsTotal ? formatRequestLogDuration(requestState.stats.p95DurationMs) : "-", hint: requestState.statsError ? "统计读取失败" : "95% 请求不超过此值", tone: "warning" },
      ]} />

      {requestState.statsError && <Alert className="requestLogsStatsAlert" tone="danger" title="统计读取失败"><span>{requestState.statsError}</span><Button variant="secondary" size="compact" icon={<RotateCcw size={15} />} onClick={requestState.retryStats}>重试统计</Button></Alert>}

      <section className="requestLogsWorkbench" aria-label="平台请求日志工作台">
        <form noValidate onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
          <FilterBar
            ariaLabel="平台请求日志筛选"
            activeAdvancedCount={advancedCount}
            advanced={<>
              <Field label="工作区 ID"><Input value={draft.workspaceId} onChange={(event) => updateDraft("workspaceId", event.target.value)} /></Field>
              <Field label="用户 ID"><Input inputMode="numeric" value={draft.actorUserId} onChange={(event) => updateDraft("actorUserId", event.target.value.replace(/\D/g, ""))} /></Field>
              <Field label="API Key 前缀"><Input value={draft.apiKeyPrefix} onChange={(event) => updateDraft("apiKeyPrefix", event.target.value)} /></Field>
              <Field label="请求 ID"><Input value={draft.requestId} onChange={(event) => updateDraft("requestId", event.target.value)} /></Field>
              <Field label="任务 ID"><Input value={draft.relayTaskId} onChange={(event) => updateDraft("relayTaskId", event.target.value)} /></Field>
              <Field label="开始日期"><Input type="date" value={draft.startDate} max={draft.endDate || undefined} onChange={(event) => updateDraft("startDate", event.target.value)} /></Field>
              <Field label="结束日期"><Input type="date" value={draft.endDate} min={draft.startDate || undefined} onChange={(event) => updateDraft("endDate", event.target.value)} /></Field>
            </>}
            actions={<><Button type="button" variant="ghost" onClick={clearFilters}>清除</Button><Button type="submit" icon={<Search size={17} />} data-testid="admin-request-log-filter-submit">查询</Button></>}
          >
            <Field label="搜索字段" className="requestLogsField--searchType"><Select value={draft.searchField} onChange={(event) => updateDraft("searchField", event.target.value as RequestLogSearchField)}>{searchFields.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></Field>
            <Field label="搜索内容" className="requestLogsField--query"><Input startIcon={<Search size={16} />} value={draft.query} onChange={(event) => updateDraft("query", event.target.value)} placeholder={draft.searchField === "path" ? "/api/v3/contents/generations/tasks" : "输入精确标识"} data-testid="admin-request-log-path-filter" /></Field>
            <Field label="状态码" className="requestLogsField--status"><Input inputMode="numeric" value={draft.statusCode} onChange={(event) => updateDraft("statusCode", event.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="例如 500" data-testid="admin-request-log-status-filter" /></Field>
          </FilterBar>
        </form>

        <div data-testid="admin-request-log-table">
          <DataTable
            ariaLabel="平台请求日志"
            caption="平台请求日志列表；点击或聚焦行后按 Enter 查看脱敏详情"
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            getRowAriaLabel={(row) => `${row.method} ${row.path}，状态 ${row.statusCode}，耗时 ${row.duration}，按 Enter 查看详情`}
            onRowClick={setDetailRow}
            loading={requestState.listLoading}
            error={requestState.listError ? `请求日志读取失败：${requestState.listError}` : undefined}
            onRetry={requestState.retryList}
            emptyState={activeFilters.query || advancedCount || activeFilters.statusCode ? "没有符合当前筛选条件的请求，请调整条件后重试。" : "暂无请求日志；平台收到请求后会显示在这里。"}
            page={requestState.effectivePageNum}
            pageSize={pageSize}
            pageSizeOptions={[20, 50, 100]}
            totalRows={totalRows}
            manualPagination
            onPageChange={updatePage}
            onPageSizeChange={updatePageSize}
            paginationLabel="请求日志分页"
          />
        </div>
      </section>

      <Drawer
        open={Boolean(detailRow)}
        title="请求日志详情"
        description="敏感字段已再次脱敏；表格仅保留定位问题所需的核心信息。"
        size="min(640px, 100vw)"
        onOpenChange={(open) => { if (!open) setDetailRow(null); }}
        contentClassName="requestLogsDrawerContent"
        footer={<Button variant="secondary" onClick={() => setDetailRow(null)}>关闭</Button>}
      >
        {detailRow && <>
          {(detailRow.statusCode >= 400 || detailRow.failureReason !== "-") && (
            <section className="requestLogsFailureSection" aria-labelledby="request-log-failure-title">
              <div className="requestLogsFailureHeading">
                <AlertTriangle aria-hidden="true" size={16} />
                <h3 id="request-log-failure-title">失败上下文</h3>
              </div>
              <p>{detailRow.failureReason !== "-" ? detailRow.failureReason : `HTTP ${detailRow.statusCode}，服务端未记录具体失败原因。`}</p>
            </section>
          )}
          <section className="requestLogsDetailSection" aria-labelledby="request-log-overview-title">
            <h3 id="request-log-overview-title">请求概况</h3>
            <dl className="requestLogsDetailList">
              <div><dt>时间</dt><dd>{detailRow.time}</dd></div>
              <div><dt>请求</dt><dd>{detailRow.method} {detailRow.path}</dd></div>
              <div><dt>状态码</dt><dd><StatusBadge statusCode={detailRow.statusCode} /></dd></div>
              <div><dt>耗时</dt><dd><Clock3 size={15} aria-hidden="true" /> {detailRow.duration}</dd></div>
              <div><dt>请求 ID</dt><dd>{detailRow.requestId}</dd></div>
              <div><dt>任务 ID</dt><dd>{detailRow.relayTaskId}</dd></div>
              <div><dt>工作区</dt><dd>{detailRow.workspaceId}</dd></div>
              <div><dt>用户 ID</dt><dd>{detailRow.actorUserId}</dd></div>
              <div><dt>Key 前缀</dt><dd>{detailRow.apiKeyPrefix}</dd></div>
              <div><dt>模型</dt><dd>{detailRow.model}</dd></div>
              <div><dt>目标分辨率</dt><dd>{detailRow.targetResolution}</dd></div>
              <div><dt>错误码</dt><dd>{detailRow.errorCode}</dd></div>
              <div><dt>来源 IP</dt><dd>{detailRow.ip}</dd></div>
              <div><dt>User-Agent</dt><dd>{detailRow.userAgent}</dd></div>
            </dl>
          </section>
          <section className="requestLogsDetailSection" aria-labelledby="request-log-metadata-title"><h3 id="request-log-metadata-title">脱敏元数据</h3><pre className="requestLogsMetadata"><code>{detailRow.metadata || "-"}</code></pre></section>
        </>}
      </Drawer>
    </ConsolePage>
  );
}

export default function RequestLogsPage() {
  return <RequestLogsContent />;
}
