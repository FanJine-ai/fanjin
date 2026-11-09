import { useMemo } from "react";
import {
  Activity,
  ArrowRight,
  ClipboardList,
  CloudCog,
  FileSearch,
  Gauge,
  RefreshCcw,
  Route,
  Settings2,
  TrendingUp,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  DataTable,
  Skeleton,
  type DataTableColumn,
} from "../../../ui/console";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../../../components/ui/chart";
import { useOverviewSnapshot } from "./hooks";
import { normalizedProviderStatus, providerTone, providerStatusLabel, summarizeProviderHealth } from "./providerHealth";
import type { ProviderHealthRecord, RequestTrendPoint } from "./types";
import "./overview.css";

const quickEntries = [
  { path: "/fjadmin/users", title: "用户管理", description: "处理账号、角色与状态", icon: UsersRound },
  { path: "/fjadmin/provider-channels", title: "供应商通道", description: "检查上游连接与健康", icon: CloudCog },
  { path: "/fjadmin/request-logs", title: "平台请求日志", description: "定位错误与慢请求", icon: FileSearch },
  { path: "/fjadmin/relay-tasks", title: "视频任务", description: "追踪任务与失败重试", icon: ClipboardList },
  { path: "/fjadmin/model-management", title: "模型路由", description: "维护路由规则、视频配方与画质增强", icon: Route },
  { path: "/fjadmin/system-settings", title: "平台设置", description: "审查平台开关与参数", icon: Settings2 },
];

function formatDate(value: unknown) {
  if (!value) return "未检查";
  const numeric = Number(value);
  const date = new Date(
    Number.isFinite(numeric)
      ? numeric < 10_000_000_000
        ? numeric * 1000
        : numeric
      : (value as string | number),
  );
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

const chartConfig = {
  total: {
    label: "总请求",
    color: "var(--cui-chart-request, hsl(var(--chart-1)))",
  },
  errors: {
    label: "错误",
    color: "var(--cui-chart-error, hsl(var(--chart-3)))",
  },
} satisfies ChartConfig;

function TrendChart({ points }: { points: RequestTrendPoint[] }) {
  if (!points.length) {
    return (
      <div className="overviewEmptyState">
        <Gauge aria-hidden="true" size={24} strokeWidth={1.5} />
        <strong>暂无请求趋势</strong>
        <span>近 7 天没有可用请求统计，图表不会使用估算值。</span>
      </div>
    );
  }

  const totalRequests = points.reduce((sum, point) => sum + Number(point.total || 0), 0);
  const totalErrors = points.reduce((sum, point) => sum + Number(point.errors || 0), 0);
  const peakRequests = Math.max(0, ...points.map((point) => Number(point.total || 0)));
  const chartData = points.map((point) => ({
    date: point.date.slice(5),
    total: Number(point.total || 0),
    errors: Number(point.errors || 0),
  }));

  return (
    <div className="overviewTrend">
      <dl className="overviewTrendSummary" aria-label="请求趋势摘要">
        <div><dt>7 天请求</dt><dd>{totalRequests.toLocaleString()}</dd></div>
        <div data-tone={totalErrors ? "danger" : "neutral"}><dt>错误请求</dt><dd>{totalErrors.toLocaleString()}</dd></div>
        <div><dt>单日峰值</dt><dd>{peakRequests.toLocaleString()}</dd></div>
      </dl>
      <p id="overview-trend-description" className="cuiVisuallyHidden">
        按日期展示总请求与错误请求趋势。错误序列使用虚线区分，完整数据见图表后的请求趋势明细表。
      </p>
      <div className="overviewTrendPlot">
        <div className="overviewTrendLegend" role="list" aria-label="请求趋势图例">
          <span role="listitem"><i data-series="total" aria-hidden="true" />总请求</span>
          <span role="listitem"><i data-series="errors" aria-hidden="true" />错误</span>
        </div>
        <ChartContainer
          config={chartConfig}
          className="overviewTrendChart"
          initialDimension={{ width: 760, height: 270 }}
          role="group"
          aria-label={`近 ${points.length} 天请求趋势`}
          aria-describedby="overview-trend-description"
        >
          <AreaChart data={chartData} accessibilityLayer margin={{ left: 0, right: 10, top: 12, bottom: 0 }}>
            <defs>
              <linearGradient id="overviewFillTotal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="4%" stopColor="var(--color-total)" stopOpacity={0.3} />
                <stop offset="96%" stopColor="var(--color-total)" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="overviewFillErrors" x1="0" y1="0" x2="0" y2="1">
                <stop offset="4%" stopColor="var(--color-errors)" stopOpacity={0.2} />
                <stop offset="96%" stopColor="var(--color-errors)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--cui-border-subtle)" strokeDasharray="3 5" vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              minTickGap={20}
              tickFormatter={(value: string) => value.replace("-", "/")}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={52}
              tickFormatter={(value: number) => value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value)}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--cui-border-strong)", strokeWidth: 1 }}
              content={<ChartTooltipContent indicator="line" />}
            />
            <Area
              type="monotone"
              dataKey="total"
              stroke="var(--color-total)"
              fill="url(#overviewFillTotal)"
              strokeWidth={2}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="errors"
              stroke="var(--color-errors)"
              fill="url(#overviewFillErrors)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      </div>
      <table className="cuiVisuallyHidden">
        <caption>请求趋势明细</caption>
        <thead><tr><th>日期</th><th>请求</th><th>错误</th><th>平均耗时</th></tr></thead>
        <tbody>{points.map((point) => <tr key={point.date}><td>{point.date}</td><td>{point.total}</td><td>{point.errors}</td><td>{Math.round(point.avgDurationMs || 0)} ms</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export default function AdminOverviewPage() {
  const navigate = useNavigate();
  const { data, loading, reload } = useOverviewSnapshot();
  const providers = data.providers;
  const requestTotal = Number(data.requests.total || 0);
  const requestErrors = Number(data.requests.status4xx || 0) + Number(data.requests.status5xx || 0);
  const requestSuccessRate = requestTotal
    ? `${((Number(data.requests.status2xx || 0) / requestTotal) * 100).toFixed(1)}%`
    : "-";
  const providerHealth = summarizeProviderHealth(providers, Boolean(data.errors.providers));
  const enabledProviders = providerHealth.enabled;
  const taskSummary = data.tasks.summary || {};
  const failedTasks = Object.entries(taskSummary)
    .filter(([status]) => /fail|error|cancel/i.test(status))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const pendingTasks = Object.entries(taskSummary)
    .filter(([status]) => /pending|running|queued|processing/i.test(status))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const errorSources = Object.entries(data.errors);
  const userTotal = Number(data.users.summary?.total ?? data.users.total ?? 0);

  const metrics = [
    {
      id: "requests",
      label: "近 7 天请求成功率",
      value: data.errors.requests ? "—" : requestSuccessRate,
      hint: data.errors.requests ? "请求统计暂不可用" : `${requestTotal.toLocaleString()} 次请求 · ${requestErrors.toLocaleString()} 次错误`,
      tone: requestErrors ? "warning" : "positive",
      icon: TrendingUp,
    },
    {
      id: "providers",
      label: "启用供应商",
      value: data.errors.providers ? "—" : `${enabledProviders} / ${providers.length}`,
      hint: data.errors.providers ? "通道数据暂不可用" : `${providerHealth.healthy} 个健康 · ${providerHealth.attention} 个需关注`,
      tone: "neutral",
      icon: CloudCog,
    },
    {
      id: "users",
      label: "平台用户",
      value: data.errors.users ? "—" : userTotal.toLocaleString(),
      hint: "全部注册用户",
      tone: "neutral",
      icon: UsersRound,
    },
  ];

  const todos = useMemo(
    () => [
      { id: "providers", label: "需关注通道", context: "最近检查", value: data.errors.providers ? null : providerHealth.attention, path: "/fjadmin/provider-channels", tone: providerHealth.tone },
      { id: "server-errors", label: "服务端错误", context: "近 7 天累计", value: data.errors.requests ? null : Number(data.requests.status5xx || 0), path: "/fjadmin/request-logs", tone: Number(data.requests.status5xx || 0) ? "warning" : "neutral" },
      { id: "failed-tasks", label: "失败 / 取消任务", context: "任务状态汇总", value: data.errors.tasks ? null : failedTasks, path: "/fjadmin/relay-tasks", tone: failedTasks ? "warning" : "neutral" },
      { id: "pending-tasks", label: "进行中与排队任务", context: "任务状态汇总", value: data.errors.tasks ? null : pendingTasks, path: "/fjadmin/relay-tasks", tone: "neutral" },
    ],
    [data.errors, data.requests.status5xx, failedTasks, pendingTasks, providerHealth.attention],
  );

  const providerColumns = useMemo<DataTableColumn<ProviderHealthRecord>[]>(
    () => [
      {
        id: "channel",
        header: "通道",
        priority: "primary",
        minWidth: "220px",
        hideable: false,
        cell: (row) => (
          <div className="overviewPrimaryCell">
            <strong>{row.name || row.channelName || row.id || "未命名通道"}</strong>
            <span>{row.provider || "未知供应商"} · {row.endpointType || "未标注能力"}</span>
          </div>
        ),
      },
      {
        id: "health",
        header: "健康状态",
        priority: "primary",
        width: "120px",
        cell: (row) => {
          const status = normalizedProviderStatus(row);
          return <Badge tone={providerTone(status)}>{providerStatusLabel(status)}</Badge>;
        },
      },
      {
        id: "latency",
        header: "延迟",
        priority: "secondary",
        align: "end",
        width: "112px",
        cell: (row) => {
          const latency = row.lastHealthLatencyMs ?? row.health?.latencyMs;
          return latency == null ? "-" : `${Number(latency).toLocaleString()} ms`;
        },
      },
      {
        id: "checked",
        header: "最近检查",
        priority: "detail",
        minWidth: "144px",
        cell: (row) => formatDate(row.lastHealthCheckAt || row.health?.checkedAt),
      },
    ],
    [],
  );

  return (
    <ConsolePage
      className="overviewPage"
      layoutWidth="dashboard"
      breadcrumbs={[{ label: "概览" }, { label: "平台概览" }]}
      title="平台概览"
      description="查看平台运行状态，关注请求趋势与待处理事项。"
      primaryAction={(
        <Button
          variant="secondary"
          icon={<RefreshCcw size={17} />}
          loading={loading}
          onClick={() => void reload()}
        >
          刷新状态
        </Button>
      )}
    >

      {errorSources.length ? (
        <Alert tone="warning" title="部分数据暂不可用">
          {errorSources.map(([key]) => ({ providers: "供应商", requests: "请求统计", tasks: "任务", audits: "审计", users: "用户" })[key as keyof typeof data.errors]).join("、")} 加载失败，请稍后刷新。
        </Alert>
      ) : null}

      <section className="overviewHealthFocus" data-tone={providerHealth.tone} aria-label="通道运行状态">
        <span className="overviewHealthIcon"><Activity size={22} strokeWidth={1.6} aria-hidden="true" /></span>
        <div className="overviewHealthCopy">
          <span>通道运行状态 · 最近检查结果</span>
          <h2>{loading ? "正在读取通道状态…" : providerHealth.label}</h2>
          <p>{data.errors.providers ? "暂时无法确认通道状态，请刷新后重试。" : loading ? "正在读取各通道最近一次检查记录。" : `${providerHealth.failed} 个异常 · ${providerHealth.degraded} 个性能下降 · ${providerHealth.unknown} 个待确认`}</p>
        </div>
        <Button variant="secondary" icon={<ArrowRight size={16} />} iconPosition="end" onClick={() => navigate("/fjadmin/provider-channels")}>查看通道</Button>
      </section>

      <div className="overviewMetricDeck" role="group" aria-label="平台关键指标">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <article className="overviewMetric" data-tone={metric.tone} key={metric.id}>
              <div className="overviewMetricHeader">
                <span>{metric.label}</span>
                <span className="overviewMetricIcon"><Icon size={17} strokeWidth={1.6} aria-hidden="true" /></span>
              </div>
              {loading ? <Skeleton width="7rem" height="2.2rem" /> : <strong>{metric.value}</strong>}
              <small>{metric.hint}</small>
            </article>
          );
        })}
      </div>

      <div className="overviewDashboardGrid">
        <Card className="overviewCard overviewTrendCard">
          <CardHeader className="overviewCardHeader">
            <div>
              <CardTitle role="heading" aria-level={2}>请求趋势</CardTitle>
              <CardDescription>近 7 天请求量与错误分布</CardDescription>
            </div>
            <Gauge size={19} strokeWidth={1.6} aria-hidden="true" />
          </CardHeader>
          <CardContent className="overviewCardContent">
            {loading ? (
              <div className="overviewChartSkeleton"><Skeleton width="100%" height="320px" /></div>
            ) : (
              <TrendChart points={data.requests.byDay || []} />
            )}
          </CardContent>
        </Card>

        <div className="overviewSideStack">
          <Card className="overviewCard overviewAttentionCard">
            <CardHeader className="overviewCardHeader">
              <div>
                <CardTitle role="heading" aria-level={2}>运营关注</CardTitle>
                <CardDescription>检查通道，追踪错误与任务</CardDescription>
              </div>
              <Activity size={19} strokeWidth={1.6} aria-hidden="true" />
            </CardHeader>
            <CardContent className="overviewCardContent overviewTodoList">
              {todos.map((item) => (
                <button key={item.id} type="button" onClick={() => navigate(item.path)}>
                  <span className="overviewTodoValue" data-tone={item.tone}>{loading || item.value == null ? "—" : item.value.toLocaleString()}</span>
                  <span className="overviewTodoCopy">{item.label}<small>{item.context}</small></span>
                  <ArrowRight size={16} strokeWidth={1.6} aria-hidden="true" />
                </button>
              ))}
            </CardContent>
          </Card>

          <Card className="overviewCard">
            <CardHeader className="overviewCardHeader">
              <div>
                <CardTitle role="heading" aria-level={2}>快捷入口</CardTitle>
                <CardDescription>进入高频运营模块</CardDescription>
              </div>
              <WalletCards size={19} strokeWidth={1.6} aria-hidden="true" />
            </CardHeader>
            <CardContent className="overviewCardContent overviewQuickGrid">
              {quickEntries.map((entry) => {
                const Icon = entry.icon;
                return (
                  <button key={entry.path} type="button" onClick={() => navigate(entry.path)}>
                    <span className="overviewQuickIcon"><Icon size={17} strokeWidth={1.6} aria-hidden="true" /></span>
                    <span className="overviewQuickCopy"><strong>{entry.title}</strong><small>{entry.description}</small></span>
                    <ArrowRight size={15} strokeWidth={1.6} aria-hidden="true" />
                  </button>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="overviewCard overviewProviderCard">
        <CardHeader className="overviewCardHeader">
          <div>
            <CardTitle role="heading" aria-level={2}>供应商健康</CardTitle>
            <CardDescription>异常优先，展示最近检查结果</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="compact"
            icon={<ArrowRight size={15} />}
            iconPosition="end"
            onClick={() => navigate("/fjadmin/provider-channels")}
          >
            查看全部
          </Button>
        </CardHeader>
        <CardContent className="overviewProviderContent">
          <DataTable
            ariaLabel="供应商健康列表"
            rows={[...providers]
              .sort(
                (left, right) =>
                  ({ danger: 3, warning: 2, success: 1, neutral: 0 })[providerTone(normalizedProviderStatus(right))]
                  - ({ danger: 3, warning: 2, success: 1, neutral: 0 })[providerTone(normalizedProviderStatus(left))],
              )
              .slice(0, 6)}
            columns={providerColumns}
            getRowId={(row, index) => row.id ?? index}
            loading={loading}
            emptyState={(
              <div className="overviewEmptyState overviewEmptyStateCompact">
                <CloudCog aria-hidden="true" size={22} strokeWidth={1.5} />
                <strong>暂无供应商数据</strong>
                <span>尚未配置通道，或供应商接口当前不可用。</span>
              </div>
            )}
            defaultPageSize={6}
            pageSizeOptions={[6]}
          />
        </CardContent>
      </Card>
    </ConsolePage>
  );
}
