import { useMemo } from "react";
import {
  Activity,
  ArrowRight,
  CircleAlert,
  ClipboardList,
  CloudCog,
  FileSearch,
  Gauge,
  RefreshCcw,
  Scale,
  ServerCog,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  DataTable,
  EmptyState,
  MetricStrip,
  Section,
  Skeleton,
} from "../../../ui/console";
import { useOverviewSnapshot } from "../overview/hooks";
import type { ProviderHealthRecord } from "../overview/types";
import "./styles.css";

function providerStatus(provider: ProviderHealthRecord) {
  if (provider.disabled) return "disabled";
  return String(provider.healthStatus || provider.health?.status || "unknown").toLowerCase();
}

function providerTone(status: string) {
  if (/^ok$|healthy|success|online/.test(status)) return "success" as const;
  if (/error|failed|down|unhealthy/.test(status)) return "danger" as const;
  if (/checking|pending|degraded|warning/.test(status)) return "warning" as const;
  return "neutral" as const;
}

function providerLabel(status: string) {
  if (status === "disabled") return "已停用";
  if (/^ok$|healthy|success|online/.test(status)) return "健康";
  if (/error|failed|down|unhealthy/.test(status)) return "异常";
  if (/checking|pending/.test(status)) return "检查中";
  if (/degraded|warning/.test(status)) return "性能下降";
  return "未检查";
}

function formatDate(value: unknown) {
  if (!value) return "未检查";
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) && numeric < 10_000_000_000 ? numeric * 1000 : value as string | number);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function metricValue(loading: boolean, value: string) {
  return loading ? <Skeleton width="5.5rem" height="1.55rem" /> : value;
}

function RuntimeCard({
  icon: Icon,
  title,
  status,
  tone,
  summary,
  detail,
  action,
}: {
  icon: typeof Activity;
  title: string;
  status: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  summary: string;
  detail: string;
  action: () => void;
}) {
  return (
    <article className="operationsRuntimeCard">
      <header>
        <span className="operationsRuntimeIcon"><Icon size={17} aria-hidden="true" /></span>
        <div><h3>{title}</h3><p>{summary}</p></div>
        <Badge tone={tone}>{status}</Badge>
      </header>
      <p className="operationsRuntimeDetail">{detail}</p>
      <Button variant="ghost" onClick={action}>查看详情<ArrowRight size={15} aria-hidden="true" /></Button>
    </article>
  );
}

export default function OperationsPage() {
  const navigate = useNavigate();
  const { data, loading, reload } = useOverviewSnapshot();
  const providers = data.providers;
  const requestTotal = Number(data.requests.total || 0);
  const requestErrors = Number(data.requests.status4xx || 0) + Number(data.requests.status5xx || 0);
  const successRate = requestTotal ? (Number(data.requests.status2xx || 0) / requestTotal) * 100 : null;
  const taskSummary = data.tasks.summary || {};
  const pendingTasks = Object.entries(taskSummary)
    .filter(([status]) => /pending|running|queued|processing/i.test(status))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const failedTasks = Object.entries(taskSummary)
    .filter(([status]) => /fail|error|cancel/i.test(status))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const enabledProviders = providers.filter((provider) => !provider.disabled);
  const unhealthyProviders = enabledProviders.filter((provider) => providerTone(providerStatus(provider)) === "danger");
  const uncheckedProviders = enabledProviders.filter((provider) => providerTone(providerStatus(provider)) === "neutral");
  const degradedSources = Object.entries(data.errors);

  const providerRows = useMemo(
    () => [...providers].sort((left, right) => {
      const rank = { danger: 0, warning: 1, neutral: 2, success: 3 };
      return rank[providerTone(providerStatus(left))] - rank[providerTone(providerStatus(right))];
    }),
    [providers],
  );

  const requestTone = requestTotal === 0 ? "neutral" : requestErrors > 0 ? "warning" : "success";
  const workerTone = failedTasks > 0 ? "danger" : pendingTasks > 0 ? "warning" : "success";
  const providerRuntimeTone = unhealthyProviders.length > 0 ? "danger" : uncheckedProviders.length > 0 ? "warning" : enabledProviders.length > 0 ? "success" : "neutral";

  return (
    <ConsolePage
      className="operationsPage"
      breadcrumbs={[{ label: "系统治理" }, { label: "运维总览" }]}
      title="运维总览"
      description="汇总平台请求、任务队列和供应商通道的真实运行状态，为值班排查提供统一入口。"
      primaryAction={<Button variant="secondary" icon={<RefreshCcw size={17} />} loading={loading} onClick={() => void reload()}>刷新状态</Button>}
      layoutWidth="dashboard"
    >
      {degradedSources.length ? (
        <Alert tone="warning" title="部分运行数据暂不可用">
          {degradedSources.map(([source, message]) => `${source}: ${message}`).join("；")}。其余指标仍来自实时接口。
        </Alert>
      ) : null}

      <MetricStrip metrics={[
        {
          id: "success-rate",
          label: "近 7 天请求成功率",
          value: metricValue(loading, successRate == null ? "-" : `${successRate.toFixed(1)}%`),
          hint: requestTotal ? `${requestTotal.toLocaleString()} 次请求 · ${requestErrors.toLocaleString()} 次错误` : "暂无请求样本",
          tone: requestErrors ? "warning" : requestTotal ? "positive" : "neutral",
        },
        {
          id: "p95",
          label: "请求 P95",
          value: metricValue(loading, data.requests.p95DurationMs == null ? "-" : `${Math.round(data.requests.p95DurationMs)} ms`),
          hint: data.requests.avgDurationMs == null ? "暂无耗时样本" : `平均 ${Math.round(data.requests.avgDurationMs)} ms`,
          tone: "info",
        },
        {
          id: "queue",
          label: "排队与执行中",
          value: metricValue(loading, pendingTasks.toLocaleString()),
          hint: `${failedTasks.toLocaleString()} 个失败或取消任务`,
          tone: failedTasks ? "danger" : pendingTasks ? "warning" : "neutral",
        },
        {
          id: "providers",
          label: "异常供应商通道",
          value: metricValue(loading, unhealthyProviders.length.toLocaleString()),
          hint: `${enabledProviders.length} 个启用 · ${uncheckedProviders.length} 个未检查`,
          tone: unhealthyProviders.length ? "danger" : "positive",
        },
      ]} />

      <Section title="运行时服务状态" description="状态完全由现有请求、任务与通道接口推导；缺少样本时明确显示未知。" icon={ServerCog}>
        <div className="operationsRuntimeGrid">
          <RuntimeCard
            icon={Activity}
            title="平台请求日志"
            status={requestTotal ? (requestErrors ? "存在错误" : "运行正常") : "样本不足"}
            tone={requestTone}
            summary={requestTotal ? `近 7 天 ${requestTotal.toLocaleString()} 次请求` : "暂无请求统计"}
            detail={requestTotal ? `4xx ${Number(data.requests.status4xx || 0).toLocaleString()} · 5xx ${Number(data.requests.status5xx || 0).toLocaleString()}` : "当前无法根据真实数据判断请求链路健康度。"}
            action={() => navigate("/fjadmin/request-logs")}
          />
          <RuntimeCard
            icon={ClipboardList}
            title="视频任务 Worker"
            status={failedTasks ? "需要排查" : pendingTasks ? "正在处理" : "队列空闲"}
            tone={workerTone}
            summary={`${pendingTasks.toLocaleString()} 个排队或执行中`}
            detail={`${failedTasks.toLocaleString()} 个失败或取消；总任务 ${Number(data.tasks.total || 0).toLocaleString()}。`}
            action={() => navigate("/fjadmin/relay-tasks")}
          />
          <RuntimeCard
            icon={CloudCog}
            title="供应商通道"
            status={unhealthyProviders.length ? "存在异常" : enabledProviders.length ? "未发现异常" : "尚未配置"}
            tone={providerRuntimeTone}
            summary={`${enabledProviders.length} 个启用通道`}
            detail={`${unhealthyProviders.length} 个异常 · ${uncheckedProviders.length} 个未检查。`}
            action={() => navigate("/fjadmin/provider-channels")}
          />
        </div>
      </Section>

      <Section
        title="供应商服务健康"
        description="异常与性能下降通道优先显示；延迟为最近一次真实健康检查结果。"
        icon={Gauge}
        action={<Button variant="secondary" onClick={() => navigate("/fjadmin/provider-channels")}>管理通道</Button>}
      >
        <DataTable<ProviderHealthRecord>
          className="operationsProviderTable"
          ariaLabel="供应商服务健康列表"
          caption="供应商服务健康"
          rows={providerRows}
          getRowId={(row, index) => String(row.id ?? `${row.provider}-${index}`)}
          loading={loading}
          emptyState={<EmptyState icon={CloudCog} title="暂无供应商通道" description="配置供应商通道后，这里会显示真实健康检查结果。" />}
          columns={[
            {
              id: "channel",
              header: "通道",
              priority: "primary",
              minWidth: "220px",
              cell: (row) => <span className="operationsPrimary"><strong>{row.name || row.channelName || row.id || "未命名通道"}</strong><span>{row.provider || "未知供应商"} · {row.endpointType || "未标注能力"}</span></span>,
            },
            { id: "status", header: "健康状态", priority: "primary", cell: (row) => { const status = providerStatus(row); return <Badge tone={providerTone(status)}>{providerLabel(status)}</Badge>; } },
            { id: "latency", header: "最近延迟", priority: "secondary", align: "end", cell: (row) => { const latency = row.lastHealthLatencyMs ?? row.health?.latencyMs; return latency == null ? "-" : `${Math.round(latency)} ms`; } },
            { id: "checked", header: "最后检查", priority: "secondary", cell: (row) => formatDate(row.lastHealthCheckAt ?? row.health?.checkedAt) },
            { id: "error", header: "最近错误", priority: "detail", cell: (row) => row.lastHealthError || row.health?.errorMessage || "-" },
          ]}
        />
      </Section>

      <Section title="值班与排查入口" description="按问题类型直接进入保留筛选能力的明细页面。" icon={CircleAlert}>
        <div className="operationsQuickLinks">
          <button type="button" onClick={() => navigate("/fjadmin/request-logs?status=500")}><FileSearch size={17} aria-hidden="true" /><span><strong>服务端错误</strong><small>检查 5xx 与慢请求</small></span><ArrowRight size={15} aria-hidden="true" /></button>
          <button type="button" onClick={() => navigate("/fjadmin/relay-tasks")}><ClipboardList size={17} aria-hidden="true" /><span><strong>失败任务</strong><small>查看失败原因与上游上下文</small></span><ArrowRight size={15} aria-hidden="true" /></button>
          <button type="button" onClick={() => navigate("/fjadmin/reconciliation")}><Scale size={17} aria-hidden="true" /><span><strong>计费异常</strong><small>处理冻结与结算不一致</small></span><ArrowRight size={15} aria-hidden="true" /></button>
        </div>
      </Section>
    </ConsolePage>
  );
}
