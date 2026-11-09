import { useEffect, useMemo, useState } from "react";
import { ClipboardList, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Badge, Button, ConsolePage, DataTable, Input, Section, type DataTableColumn } from "../../ui/console";
import {
  developerPageSize,
  formatDate,
  positiveDeveloperPage,
  statusLabel,
  statusTone,
  useDeveloperTasksPage,
} from "./developerSnapshot";

type TaskRow = {
  id: string | number;
  requestId: string;
  providerTaskId: string;
  model: string;
  status: string;
  progress: string;
  time: string;
};

const taskColumns: DataTableColumn<TaskRow>[] = [
  {
    id: "id",
    header: "任务标识",
    priority: "primary",
    hideable: false,
    cell: (row) => (
      <div className="flex max-w-[360px] flex-col gap-0.5 font-mono text-xs">
        <strong className="truncate text-[var(--cui-text)]" title={String(row.id)}>任务：{row.id}</strong>
        {row.requestId !== "-" ? <span className="truncate text-[var(--cui-text-muted)]" title={row.requestId}>请求：{row.requestId}</span> : null}
        {row.providerTaskId !== "-" ? <span className="truncate text-[var(--cui-text-muted)]" title={row.providerTaskId}>上游：{row.providerTaskId}</span> : null}
      </div>
    ),
  },
  { id: "model", header: "模型", accessor: "model", priority: "primary", hideable: false },
  { id: "status", header: "状态", priority: "primary", hideable: false, cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge> },
  { id: "progress", header: "进度 / 阶段", accessor: "progress", priority: "secondary", hideable: false, align: "end" },
  { id: "time", header: "开始时间", accessor: "time", priority: "secondary", hideable: false },
];

export default function ApiTasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = positiveDeveloperPage(searchParams.get("page"));
  const pageSize = developerPageSize(searchParams.get("size"));
  const identifier = String(searchParams.get("identifier") || "").trim();
  const [identifierInput, setIdentifierInput] = useState(identifier);
  const filters = useMemo(() => identifier ? { identifier } : undefined, [identifier]);
  const state = useDeveloperTasksPage(page, pageSize, filters);

  useEffect(() => setIdentifierInput(identifier), [identifier]);

  useEffect(() => {
    if (state.effectivePageNum === page) return;
    const next = new URLSearchParams(searchParams);
    if (state.effectivePageNum <= 1) next.delete("page");
    else next.set("page", String(state.effectivePageNum));
    setSearchParams(next, { replace: true });
  }, [page, searchParams, setSearchParams, state.effectivePageNum]);

  const rows: TaskRow[] = state.data.items.map((task, index) => {
    const progress = Number(task.progress_percent ?? task.progress);
    const progressLabel = Number.isFinite(progress) ? `${Math.max(0, Math.min(100, Math.round(progress)))}%` : "-";
    const stageLabel = String(task.stage_label || task.stage || "").trim();
    return {
    id: task.id ?? task.taskId ?? index,
    requestId: String(task.requestId || "-"),
    providerTaskId: String(task.providerTaskId || "-"),
    model: String(task.model || task.modelName || "-"),
    status: String(task.state || task.status || "-"),
      progress: stageLabel ? `${progressLabel} · ${stageLabel}` : progressLabel,
      time: formatDate(task.created_at ?? task.startTime ?? task.createdAt ?? task.createTime),
    };
  });

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

  function applyIdentifierSearch() {
    const next = new URLSearchParams(searchParams);
    next.delete("page");
    const value = identifierInput.trim();
    if (value) next.set("identifier", value); else next.delete("identifier");
    setSearchParams(next);
  }

  return (
    <ConsolePage
      eyebrow="Developer API"
      title="API 任务"
      description="追踪调用任务的状态、阶段、模型和开始时间。"
    >
      <Section title="任务列表" icon={ClipboardList}>
        <form
          className="developerTaskFilters"
          onSubmit={(event) => { event.preventDefault(); applyIdentifierSearch(); }}
        >
          <Input
            value={identifierInput}
            onChange={(event) => setIdentifierInput(event.target.value)}
            placeholder="输入任务 ID、requestId 或上游 taskId 精确查询"
            aria-label="任务标识查询"
          />
          <Button type="submit" icon={<Search size={15} />}>查询</Button>
          {identifier ? <Button type="button" variant="secondary" onClick={() => { setIdentifierInput(""); const next = new URLSearchParams(searchParams); next.delete("identifier"); next.delete("page"); setSearchParams(next); }}>清除</Button> : null}
        </form>
        <DataTable
          rows={rows}
          columns={taskColumns}
          getRowId={(row) => row.id}
          caption="当前工作区 API 任务列表"
          ariaLabel="API 任务列表"
          loading={state.loading}
          error={state.error ? `任务读取失败：${state.error}` : undefined}
          onRetry={state.retry}
          emptyState="暂无 API 任务；创建真实 API 任务后会出现在这里。"
          getRowAriaLabel={(row) => `任务 ${row.id}，模型 ${row.model}，状态 ${statusLabel(row.status)}，进度 ${row.progress}`}
          page={state.effectivePageNum}
          pageSize={pageSize}
          pageSizeOptions={[20, 50, 100]}
          totalRows={state.data.total}
          manualPagination
          onPageChange={updatePage}
          onPageSizeChange={updatePageSize}
          paginationLabel="API 任务分页"
        />
      </Section>
    </ConsolePage>
  );
}
