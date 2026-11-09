import { useEffect, useState } from "react";
import { Eye, FileClock } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Button, CodeBlock, ConsolePage, DataTable, Drawer, MetricStrip, Section, Select, type DataTableColumn } from "../../ui/console";
import { formatDate, redactLogText } from "../console/ConsoleAdminShared";
import {
  developerPageSize,
  developerRequestLogCapability,
  positiveDeveloperPage,
  useDeveloperRequestLogsPage,
} from "./developerSnapshot";
import "./DeveloperConsole.css";

type LogRow = {
  id: string | number;
  time: string;
  method: string;
  path: string;
  statusCode: string | number;
  model: string;
  apiKeyPrefix: string;
  capability: string;
  metadata: string;
};

const capabilityLabels: Record<string, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  embedding: "向量",
  audio: "音频",
  rerank: "重排",
  other: "其他",
};

const baseLogColumns: DataTableColumn<LogRow>[] = [
  { id: "time", header: "时间", accessor: "time", priority: "secondary", hideable: false },
  { id: "method", header: "方法", accessor: "method", priority: "primary", hideable: false },
  { id: "path", header: "路径", accessor: "path", priority: "primary", hideable: false },
  { id: "statusCode", header: "状态码", accessor: "statusCode", priority: "primary", hideable: false },
  { id: "capability", header: "能力", accessor: "capability", priority: "secondary", hideable: false },
  { id: "model", header: "模型", accessor: "model", priority: "secondary", hideable: false },
  { id: "apiKeyPrefix", header: "Key 前缀", accessor: "apiKeyPrefix", priority: "detail", hideable: false },
];

export default function ApiLogsPage() {
  const [detailRow, setDetailRow] = useState<LogRow | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const page = positiveDeveloperPage(searchParams.get("page"));
  const pageSize = developerPageSize(searchParams.get("size"));
  const capability = developerRequestLogCapability(searchParams.get("capability"));
  const state = useDeveloperRequestLogsPage(page, pageSize, capability);

  useEffect(() => {
    if (state.effectivePageNum === page) return;
    const next = new URLSearchParams(searchParams);
    if (state.effectivePageNum <= 1) next.delete("page");
    else next.set("page", String(state.effectivePageNum));
    setSearchParams(next, { replace: true });
  }, [page, searchParams, setSearchParams, state.effectivePageNum]);

  const stats = state.data.stats || {};
  const rows: LogRow[] = state.data.items.map((item, index) => ({
    id: item.id || item.requestId || index,
    time: formatDate(item.createdAt),
    method: String(item.method || "-"),
    path: String(item.path || "-"),
    statusCode: item.statusCode || "-",
    model: String(item.model || "-"),
    apiKeyPrefix: String(item.apiKeyPrefix || "-"),
    capability: capabilityLabels[String(item.capability || "other")] || "其他",
    metadata: redactLogText(item.metadata),
  }));
  const statsTotal = Number(stats.total || 0);
  const ok = Number(stats.status2xx || 0);
  const successRate = statsTotal ? `${((ok / statsTotal) * 100).toFixed(2)}%` : "-";
  const logColumns: DataTableColumn<LogRow>[] = [
    ...baseLogColumns,
    {
      id: "metadata",
      header: "脱敏元数据",
      priority: "detail",
      hideable: false,
      cell: (row) => (
        <div className="developerLogMetadataCell">
          <code className="developerLogMetadata">{row.metadata === "-" ? "无元数据" : row.metadata}</code>
          <Button
            size="compact"
            variant="secondary"
            icon={<Eye aria-hidden="true" size={15} />}
            aria-label={`查看 ${row.method} ${row.path} 的请求详情`}
            onClick={() => setDetailRow(row)}
          >
            查看
          </Button>
        </div>
      ),
    },
  ];

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

  function updateCapability(nextCapability: string) {
    const next = new URLSearchParams(searchParams);
    next.delete("page");
    if (nextCapability) next.set("capability", nextCapability);
    else next.delete("capability");
    setSearchParams(next);
  }

  return (
    <ConsolePage
      eyebrow="Developer API"
      title="请求日志"
      description="定位失败请求、慢请求和成本异常。"
    >
      <MetricStrip metrics={[
        { id: "total", label: "请求总量", value: state.loading ? "加载中" : statsTotal.toLocaleString(), hint: "近 7 天" },
        { id: "success", label: "成功率", value: state.loading ? "加载中" : successRate, hint: "2xx / 总请求", tone: "positive" },
        { id: "average", label: "平均响应", value: state.loading ? "加载中" : (stats.avgDurationMs != null && statsTotal ? `${(Number(stats.avgDurationMs) / 1000).toFixed(2)}s` : "-"), hint: "近 7 天", tone: "warning" },
      ]} />
      <Section title="日志明细" description="按当前工作区保留最近 API Key 请求，可按文本、图片、视频、向量、音频和重排能力筛选；敏感头和值会脱敏显示。" icon={FileClock}>
        <div className="developerLogFilters">
          <label htmlFor="developer-log-capability">能力类型</label>
          <Select
            id="developer-log-capability"
            aria-label="日志能力类型"
            value={capability}
            onChange={(event) => updateCapability(event.currentTarget.value)}
          >
            <option value="">全部能力</option>
            <option value="text">文本</option>
            <option value="image">图片</option>
            <option value="video">视频</option>
            <option value="embedding">向量</option>
            <option value="audio">音频</option>
            <option value="rerank">重排</option>
            <option value="other">其他</option>
          </Select>
        </div>
        <DataTable
          rows={rows}
          columns={logColumns}
          getRowId={(row) => row.id}
          caption="当前工作区最近 API 请求日志"
          ariaLabel="开发者请求日志"
          loading={state.loading}
          error={state.error || undefined}
          onRetry={state.retry}
          emptyState="暂无请求日志；使用 API Key 发起请求后会显示在这里。"
          getRowAriaLabel={(row) => `${row.time}，${row.capability}能力，${row.method} ${row.path}，状态码 ${row.statusCode}，模型 ${row.model}，按回车查看详情`}
          onRowClick={setDetailRow}
          page={state.effectivePageNum}
          pageSize={pageSize}
          pageSizeOptions={[20, 50, 100]}
          totalRows={state.data.total}
          manualPagination
          onPageChange={updatePage}
          onPageSizeChange={updatePageSize}
          paginationLabel="开发者请求日志分页"
        />
      </Section>

      <Drawer
        open={Boolean(detailRow)}
        title="开发者请求详情"
        description="只展示已脱敏的请求元数据与定位信息。"
        size="min(620px, 100vw)"
        onOpenChange={(open) => { if (!open) setDetailRow(null); }}
        footer={<Button variant="secondary" onClick={() => setDetailRow(null)}>关闭</Button>}
      >
        {detailRow ? (
          <div className="developerLogDrawer">
            <dl className="developerLogDetailList">
              <div><dt>时间</dt><dd>{detailRow.time}</dd></div>
              <div><dt>请求</dt><dd>{detailRow.method} {detailRow.path}</dd></div>
              <div><dt>状态码</dt><dd>{detailRow.statusCode}</dd></div>
              <div><dt>模型</dt><dd>{detailRow.model}</dd></div>
              <div><dt>Key 前缀</dt><dd>{detailRow.apiKeyPrefix}</dd></div>
            </dl>
            <section aria-labelledby="developer-log-metadata-title">
              <h3 id="developer-log-metadata-title">脱敏元数据</h3>
              <CodeBlock language="json">{detailRow.metadata || "-"}</CodeBlock>
            </section>
          </div>
        ) : null}
      </Drawer>
    </ConsolePage>
  );
}
