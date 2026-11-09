import type React from "react";
import { Alert, Button, DataTable, MetricStrip, type DataTableColumn } from "../../ui/console";
import { useWorkspaceSnapshot } from "./developerSnapshot";

type SummaryRow = {
  id: string;
  name: string;
  count: number | string;
  description: string;
  path: string;
};

const summaryColumns: DataTableColumn<SummaryRow>[] = [
  { id: "name", header: "对象", accessor: "name", priority: "primary", hideable: false },
  { id: "count", header: "数量", accessor: "count", priority: "primary", hideable: false, align: "end" },
  { id: "description", header: "说明", accessor: "description", priority: "secondary", hideable: false },
  { id: "path", header: "路径", accessor: "path", priority: "detail", hideable: false },
];

export function DeveloperMetricGrid() {
  const { loading, error, data, retry } = useWorkspaceSnapshot();
  const successTasks = data.tasks.filter((task) => /success|succeeded|完成|已完成/i.test(String(task.state || task.status || ""))).length;
  const failedTasks = data.tasks.filter((task) => /fail|失败|error/i.test(String(task.state || task.status || ""))).length;
  const totalFinished = successTasks + failedTasks;
  const successRate = totalFinished ? `${Math.round((successTasks / totalFinished) * 100)}%` : "-";
  const value = (available: boolean, fallback: React.ReactNode) => (
    loading ? "加载中" : available ? fallback : "不可用"
  );
  return (
    <>
      {error ? (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}，只展示已读取到的开发者数据。</span>
            <Button variant="secondary" size="compact" onClick={retry}>重试</Button>
          </div>
        </Alert>
      ) : null}
      <MetricStrip metrics={[
        { id: "keys", label: "API 密钥", value: value(data.availability.overview, data.apiKeyCount), hint: "未包含已撤销密钥" },
        { id: "success", label: "任务成功率", value: value(data.availability.tasks, successRate), hint: "基于当前任务列表", tone: "positive" },
        { id: "tasks", label: "任务总数", value: value(data.availability.tasks, data.tasks.length), hint: "来自任务接口", tone: "warning" },
        {
          id: "models",
          label: "模型能力",
          value: value(data.availability.models, `${data.modelSummary.active}/${data.modelSummary.total}`),
          hint: data.availability.models
            ? `${data.modelSummary.unavailable} 个暂不可用`
            : "模型目录读取失败",
          tone: "info",
        },
      ]} />
    </>
  );
}

export function DeveloperLiveSummary() {
  const { loading, error, data, retry } = useWorkspaceSnapshot();
  const rows: SummaryRow[] = [
    { id: "tasks", name: "任务", count: data.availability.tasks ? data.tasks.length : "不可用", description: "当前任务接口返回数量", path: "/developer/api/tasks" },
    {
      id: "models",
      name: "模型",
      count: data.availability.models ? data.modelSummary.total : "不可用",
      description: data.availability.models
        ? `${data.modelSummary.active} active / ${data.modelSummary.unavailable} unavailable`
        : "当前模型目录读取失败",
      path: "/developer/api/models",
    },
    { id: "keys", name: "密钥", count: data.availability.overview ? data.apiKeyCount : "不可用", description: "开发者概览中的有效密钥数量", path: "/developer/api/keys" },
  ];
  const allUnavailable = !data.availability.overview
    && !data.availability.tasks
    && !data.availability.models;
  return (
    <DataTable
      rows={rows}
      columns={summaryColumns}
      getRowId={(row) => row.id}
      caption="开发者任务、模型与密钥实时摘要"
      ariaLabel="开发者实时摘要"
      loading={loading}
      error={error && allUnavailable ? `开发者数据读取失败：${error}` : undefined}
      onRetry={retry}
      emptyState="暂无开发者摘要数据"
      getRowAriaLabel={(row) => `${row.name}，数量 ${row.count}，路径 ${row.path}`}
      defaultPageSize={20}
    />
  );
}
