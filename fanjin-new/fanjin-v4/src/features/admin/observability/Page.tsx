import { useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle,
  Database,
  Gauge,
  HardDrive,
  RefreshCcw,
  Server,
  Zap,
} from "lucide-react";
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
  type DataTableColumn,
} from "../../../ui/console";
import { useObservabilityMetrics, useHealthCheck, useBackupList } from "./hooks";
import type { BackupSchedulerStatus } from "./types";
import "./styles.css";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days} 天 ${hours % 24} 小时`;
  }
  return `${hours} 小时 ${minutes} 分钟`;
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeMetric(value: unknown): number | null {
  const number = finiteMetric(value);
  return number !== null && number >= 0 ? number : null;
}

function metricValue(loading: boolean, value: string | null) {
  if (loading) return <Skeleton width="5.5rem" height="1.55rem" />;
  return value ?? "—";
}

function HealthStatusCard({
  component,
  status,
  latency,
  lastSeen,
}: {
  component: string;
  status?: string | null;
  latency?: number | null;
  lastSeen?: number;
}) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const isUnavailable = !normalizedStatus || normalizedStatus === "unknown" || normalizedStatus === "unavailable";
  const isHealthy = normalizedStatus === "healthy" || normalizedStatus === "ok" || normalizedStatus === "ready";
  const isDegraded = normalizedStatus === "degraded" || normalizedStatus === "warning";
  const isUnconfigured = normalizedStatus === "disabled" || normalizedStatus === "unconfigured" || normalizedStatus === "not_configured";
  const tone = isUnavailable || isUnconfigured ? "neutral" : isHealthy ? "success" : isDegraded ? "warning" : "danger";
  const Icon = isUnavailable || isUnconfigured ? Server : isHealthy ? CheckCircle : AlertTriangle;
  const label = isUnavailable ? "不可用" : isUnconfigured ? "未配置" : isHealthy ? "健康" : isDegraded ? "降级" : "异常";

  let detail = isUnavailable ? "未返回状态" : "";
  if (!isUnavailable && typeof latency === "number" && Number.isFinite(latency)) {
    detail = `延迟: ${latency}ms`;
  } else if (!isUnavailable && lastSeen !== undefined && Number.isFinite(lastSeen)) {
    const ago = Date.now() - lastSeen;
    detail = `上次心跳: ${Math.floor(ago / 1000)}s 前`;
  }

  return (
    <article className="observabilityHealthCard">
      <header>
        <span className="observabilityHealthIcon">
          <Icon size={17} aria-hidden="true" />
        </span>
        <div>
          <h3>{component}</h3>
          {detail && <p className="observabilityHealthDetail">{detail}</p>}
        </div>
        <Badge tone={tone}>{label}</Badge>
      </header>
    </article>
  );
}

function backupSchedulerPresentation(scheduler: BackupSchedulerStatus) {
  if (!scheduler.configured) {
    return {
      tone: "neutral" as const,
      title: "自动备份未配置",
      detail: "请在环境变量中配置 FANJIN_BACKUP_ENABLED=1 启用自动备份。",
    };
  }
  if (scheduler.localRunning) {
    return {
      tone: "success" as const,
      title: "自动备份调度器正在当前进程运行",
      detail: scheduler.nextBackupTime
        ? `下次备份时间: ${new Date(scheduler.nextBackupTime).toLocaleString("zh-CN")}`
        : "已确认本进程调度器正在运行，暂未获得下次执行时间。",
    };
  }
  if (scheduler.processRole === "api") {
    return {
      tone: "info" as const,
      title: "自动备份已配置",
      detail: "当前 API 进程不运行调度器，无法据此断言 Worker 的运行状态；请结合 Worker 健康状态确认。",
    };
  }
  return {
    tone: "warning" as const,
    title: "自动备份已配置，但调度器未在当前进程运行",
    detail: "请检查 Worker 日志和 Cron 配置。",
  };
}

export default function ObservabilityPage() {
  const { data: metrics, loading: metricsLoading, error: metricsError, reload: reloadMetrics } = useObservabilityMetrics(true, 5000);
  const { data: health, loading: healthLoading, error: healthError, reload: reloadHealth } = useHealthCheck(true, 10000);
  const { data: backups, loading: backupsLoading, error: backupsError, reload: reloadBackups } = useBackupList();

  const loading = metricsLoading || healthLoading;

  // 计算关键指标
  const metricsAvailable = Boolean(metrics) && !metricsError;
  const healthAvailable = Boolean(health) && !healthError;
  const backupsAvailable = Boolean(backups) && !backupsError;
  const totalRequests = metricsAvailable ? nonNegativeMetric(metrics?.http?.requests?.total) : null;
  const rawStatusCounts = metricsAvailable && metrics?.http?.requests?.byStatus
    && typeof metrics.http.requests.byStatus === "object"
    ? metrics.http.requests.byStatus
    : null;
  const statusCounts = rawStatusCounts
    && Object.values(rawStatusCounts).every((count) => nonNegativeMetric(count) !== null)
    && (totalRequests === 0 || Object.keys(rawStatusCounts).length > 0)
    ? rawStatusCounts
    : null;
  const errorCount = statusCounts
    ? Object.entries(statusCounts)
      .filter(([status]) => Number(status) >= 400)
      .reduce((total, [, count]) => total + count, 0)
    : null;
  const errorRate = totalRequests !== null && errorCount !== null
    ? totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0
    : null;
  const avgResponseTime = metricsAvailable ? nonNegativeMetric(metrics?.computed?.avgResponseTime) : null;
  const memoryUsagePercent = metricsAvailable ? nonNegativeMetric(metrics?.computed?.memoryUsagePercent) : null;
  const requestsPerSecond = metricsAvailable ? nonNegativeMetric(metrics?.computed?.requestsPerSecond) : null;
  const uptime = metricsAvailable ? nonNegativeMetric(metrics?.system?.uptime) : null;
  const heapUsed = metricsAvailable ? nonNegativeMetric(metrics?.system?.memory?.heapUsed) : null;
  const heapTotal = metricsAvailable ? nonNegativeMetric(metrics?.system?.memory?.heapTotal) : null;
  const cpuUsage = metricsAvailable ? nonNegativeMetric(metrics?.system?.cpuUsage) : null;
  const responseSampleCount = metricsAvailable ? nonNegativeMetric(metrics?.http?.responseTimes?.count) : null;
  const responseP50 = metricsAvailable ? nonNegativeMetric(metrics?.http?.responseTimes?.p50) : null;
  const responseP95 = metricsAvailable ? nonNegativeMetric(metrics?.http?.responseTimes?.p95) : null;
  const responseP99 = metricsAvailable ? nonNegativeMetric(metrics?.http?.responseTimes?.p99) : null;
  const hasRequests = totalRequests !== null && totalRequests > 0;
  const hasResponseSamples = responseSampleCount !== null && responseSampleCount > 0;
  const memoryMetricsAvailable = memoryUsagePercent !== null
    && heapUsed !== null
    && heapTotal !== null
    && heapTotal > 0;
  const metricsIncomplete = metricsAvailable && [
    totalRequests,
    avgResponseTime,
    memoryUsagePercent,
    requestsPerSecond,
    uptime,
    heapUsed,
    heapTotal,
    cpuUsage,
    responseSampleCount,
    responseP50,
    responseP95,
    responseP99,
  ].some((value) => value === null);
  const performanceMetricsAvailable = [
    totalRequests,
    avgResponseTime,
    uptime,
    heapUsed,
    cpuUsage,
    responseSampleCount,
    responseP50,
    responseP95,
    responseP99,
  ].some((value) => value !== null);
  const loadErrors = [
    metricsError ? `指标：${metricsError.message}` : null,
    healthError ? `健康检查：${healthError.message}` : null,
    backupsError ? `备份：${backupsError.message}` : null,
  ].filter((message): message is string => Boolean(message));
  const schedulerPresentation = backupsAvailable && backups?.scheduler
    ? backupSchedulerPresentation(backups.scheduler)
    : null;

  // 备份列表列定义
  const backupColumns: DataTableColumn<any>[] = useMemo(
    () => [
      {
        id: "timestamp",
        header: "创建时间",
        cell: (row) => formatTimestamp(row.timestamp),
      },
      {
        id: "filename",
        header: "文件名",
        cell: (row) => row.filename,
      },
      {
        id: "size",
        header: "大小",
        cell: (row) => formatBytes(row.size),
      },
      {
        id: "verified",
        header: "已验证",
        cell: (row) => (
          <Badge tone={row.verified ? "success" : "neutral"}>
            {row.verified ? "是" : "否"}
          </Badge>
        ),
      },
      {
        id: "cloud",
        header: "云存储",
        cell: (row) => (
          <Badge tone={row.uploadedToCloud ? "info" : "neutral"}>
            {row.uploadedToCloud ? "已上传" : "本地"}
          </Badge>
        ),
      },
    ],
    [],
  );

  // 状态码分布数据
  const statusCodeRows = useMemo(() => {
    if (!metricsAvailable || !statusCounts || totalRequests === null) return [];
    return Object.entries(statusCounts)
      .map(([code, count]) => ({
        code,
        count,
        percentage: totalRequests > 0 ? ((count / totalRequests) * 100).toFixed(1) : null,
      }))
      .sort((a, b) => b.count - a.count);
  }, [metricsAvailable, statusCounts, totalRequests]);

  const statusColumns: DataTableColumn<any>[] = useMemo(
    () => [
      {
        id: "code",
        header: "状态码",
        cell: (row) => <code>{row.code}</code>,
      },
      {
        id: "count",
        header: "请求数",
        cell: (row) => row.count.toLocaleString(),
      },
      {
        id: "percentage",
        header: "占比",
        cell: (row) => row.percentage === null ? "—" : `${row.percentage}%`,
      },
    ],
    [],
  );

  return (
    <ConsolePage
      className="observabilityPage"
      breadcrumbs={[{ label: "系统治理" }, { label: "可观测性" }]}
      title="可观测性监控"
      description="实时监控系统性能指标、健康状态和数据备份，为生产环境提供全方位的可观测性支持。"
      primaryAction={
        <Button
          variant="secondary"
          icon={<RefreshCcw size={17} />}
          loading={loading}
          onClick={() => {
            void reloadMetrics();
            void reloadHealth();
          }}
        >
          刷新数据
        </Button>
      }
      layoutWidth="dashboard"
    >
      {loadErrors.length > 0 && (
        <Alert tone="danger" title="部分监控数据加载失败">
          {loadErrors.join("；")}
        </Alert>
      )}
      {!metricsLoading && metricsIncomplete ? (
        <Alert tone="neutral" title="部分指标不可用">
          指标接口未返回完整数据，缺失项已显示为“—”，不会按零值或健康状态展示。
        </Alert>
      ) : null}

      {/* 关键指标卡片 */}
      <MetricStrip
        metrics={[
          {
            id: "total-requests",
            label: "总请求数",
            value: metricValue(metricsLoading, totalRequests === null ? null : totalRequests.toLocaleString()),
            hint: totalRequests === null ? "请求指标不可用" : "过去统计周期的总请求量",
            tone: "neutral",
          },
          {
            id: "avg-response",
            label: "平均响应时间",
            value: metricValue(
              metricsLoading,
              totalRequests === 0
                ? "暂无请求"
                : !hasResponseSamples || avgResponseTime === null ? null : `${avgResponseTime.toFixed(1)} ms`,
            ),
            hint: totalRequests === 0
              ? "统计周期内暂无请求"
              : !hasResponseSamples || avgResponseTime === null ? "响应时间指标不可用" : "所有成功请求的平均响应时间",
            tone: !hasRequests || !hasResponseSamples || avgResponseTime === null ? "neutral" : avgResponseTime > 100 ? "warning" : "positive",
            trend:
              hasRequests && hasResponseSamples && avgResponseTime !== null && avgResponseTime < 50 ? (
                <span style={{ color: "var(--cui-success-text)" }}>
                  <ArrowDown size={14} /> 优秀
                </span>
              ) : hasRequests && hasResponseSamples && avgResponseTime !== null && avgResponseTime > 100 ? (
                <span style={{ color: "var(--cui-danger-text)" }}>
                  <ArrowUp size={14} /> 需优化
                </span>
              ) : undefined,
          },
          {
            id: "error-rate",
            label: "错误率",
            value: metricValue(
              metricsLoading,
              totalRequests === 0 ? "暂无请求" : errorRate === null ? null : `${errorRate.toFixed(2)}%`,
            ),
            hint: totalRequests === 0
              ? "统计周期内暂无请求"
              : errorCount === null ? "错误请求指标不可用" : `${errorCount.toLocaleString()} 次错误请求`,
            tone: !hasRequests || errorRate === null ? "neutral" : errorRate > 1 ? "danger" : errorRate > 0.5 ? "warning" : "positive",
          },
          {
            id: "memory-usage",
            label: "内存使用率",
            value: metricValue(metricsLoading, memoryMetricsAvailable ? `${memoryUsagePercent.toFixed(1)}%` : null),
            hint: memoryMetricsAvailable ? formatBytes(heapUsed) : "内存指标不可用",
            tone: !memoryMetricsAvailable ? "neutral" : memoryUsagePercent > 85 ? "danger" : memoryUsagePercent > 70 ? "warning" : "positive",
          },
          {
            id: "qps",
            label: "请求速率",
            value: metricValue(metricsLoading, requestsPerSecond === null ? null : `${requestsPerSecond.toFixed(1)} req/s`),
            hint: requestsPerSecond === null ? "请求速率指标不可用" : "当前每秒请求数（QPS）",
            tone: requestsPerSecond === null ? "neutral" : "info",
          },
          {
            id: "uptime",
            label: "运行时间",
            value: metricValue(metricsLoading, uptime === null ? null : formatUptime(uptime)),
            hint: uptime === null ? "运行时间指标不可用" : "自上次启动以来的持续时间",
            tone: "neutral",
          },
        ]}
      />

      {/* 系统健康状态 */}
      <Section
        title="系统健康状态"
        description="关键组件的实时健康检查"
        icon={Activity}
        surface="flat"
      >
        {healthLoading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "1rem" }}>
            <Skeleton height="80px" />
            <Skeleton height="80px" />
            <Skeleton height="80px" />
            <Skeleton height="80px" />
          </div>
        ) : healthAvailable && health ? (
          <div className="observabilityHealthGrid">
            <HealthStatusCard
              component="数据库"
              status={health.components?.database?.status}
              latency={health.components?.database?.latencyMs}
            />
            <HealthStatusCard
              component="Redis 缓存"
              status={health.components?.redis?.status}
              latency={health.components?.redis?.latencyMs}
            />
            <HealthStatusCard
              component="后台 Worker"
              status={health.components?.worker?.status}
              lastSeen={health.components?.worker?.lastSeen}
            />
            <HealthStatusCard
              component="API 服务"
              status={health.components?.web?.status}
            />
          </div>
        ) : (
          <EmptyState
            icon={AlertTriangle}
            title={healthError ? "健康状态加载失败" : "健康状态不可用"}
            description={healthError?.message || "接口未返回组件健康状态。"}
          />
        )}
      </Section>

      {/* 性能指标详情 */}
      <Section
        title="性能指标详情"
        description="HTTP 请求的详细性能分析"
        icon={Gauge}
        surface="flat"
      >
        {metricsLoading ? (
          <Skeleton height="190px" />
        ) : !metricsAvailable || !performanceMetricsAvailable ? (
          <EmptyState
            icon={AlertTriangle}
            title={metricsError ? "性能指标加载失败" : "性能指标不可用"}
            description={metricsError?.message || "接口未返回性能指标。"}
          />
        ) : (
          <div className="observabilityMetricsGrid">
            <article className="observabilityMetricCard">
              <header>
                <Zap size={20} aria-hidden="true" />
                <h3>响应时间分布</h3>
              </header>
              <dl>
                <div>
                  <dt>P50 (中位数)</dt>
                  <dd>{totalRequests === 0 ? "暂无请求" : !hasResponseSamples || responseP50 === null ? "—" : `${responseP50.toFixed(1)} ms`}</dd>
                </div>
                <div>
                  <dt>P95</dt>
                  <dd>{totalRequests === 0 ? "暂无请求" : !hasResponseSamples || responseP95 === null ? "—" : `${responseP95.toFixed(1)} ms`}</dd>
                </div>
                <div>
                  <dt>P99</dt>
                  <dd>{totalRequests === 0 ? "暂无请求" : !hasResponseSamples || responseP99 === null ? "—" : `${responseP99.toFixed(1)} ms`}</dd>
                </div>
              </dl>
            </article>

            <article className="observabilityMetricCard">
              <header>
                <Server size={20} aria-hidden="true" />
                <h3>系统资源</h3>
              </header>
              <dl>
                <div>
                  <dt>CPU 使用率</dt>
                  <dd>{cpuUsage === null ? "—" : `${cpuUsage.toFixed(1)}%`}</dd>
                </div>
                <div>
                  <dt>内存占用</dt>
                  <dd>{heapUsed === null ? "—" : formatBytes(heapUsed)}</dd>
                </div>
                <div>
                  <dt>运行时长</dt>
                  <dd>{uptime === null ? "—" : formatUptime(uptime)}</dd>
                </div>
              </dl>
            </article>
          </div>
        )}
      </Section>

      {/* HTTP 状态码分布 */}
      <Section
        title="HTTP 状态码分布"
        description="请求响应的状态码统计"
        icon={Activity}
        surface="subtle"
      >
        {metricsLoading ? (
          <Skeleton height="200px" />
        ) : !metricsAvailable || totalRequests === null || !statusCounts ? (
          <EmptyState
            icon={AlertTriangle}
            title={metricsError ? "状态码统计加载失败" : "状态码统计不可用"}
            description={metricsError?.message || "接口未返回 HTTP 状态码统计。"}
          />
        ) : statusCodeRows.length > 0 ? (
          <DataTable 
            columns={statusColumns} 
            rows={statusCodeRows}
            getRowId={(row) => row.code}
          />
        ) : (
          <EmptyState
            icon={Activity}
            title="暂无请求数据"
            description="统计周期内尚未收集到 HTTP 请求。"
          />
        )}
      </Section>

      {/* 数据备份状态 */}
      <Section
        title="数据备份"
        description="自动备份任务和备份文件列表"
        icon={Database}
        surface="subtle"
        action={
          <Button
            variant="secondary"
            size="compact"
            icon={<RefreshCcw size={15} />}
            loading={backupsLoading}
            onClick={() => void reloadBackups()}
          >
            刷新
          </Button>
        }
      >
        {schedulerPresentation && (
          <Alert
            tone={schedulerPresentation.tone}
            title={schedulerPresentation.title}
          >
            {schedulerPresentation.detail}
          </Alert>
        )}
        {backupsAvailable && !backups?.scheduler ? (
          <Alert tone="neutral" title="备份调度状态不可用">
            接口未返回自动备份调度器状态。
          </Alert>
        ) : null}

        {backupsLoading ? (
          <Skeleton height="200px" />
        ) : !backupsAvailable ? (
          <EmptyState
            icon={AlertTriangle}
            title={backupsError ? "备份数据加载失败" : "备份数据不可用"}
            description={backupsError?.message || "接口未返回备份数据。"}
          />
        ) : backups && Array.isArray(backups.backups) && backups.backups.length > 0 ? (
          <DataTable 
            columns={backupColumns} 
            rows={backups.backups}
            getRowId={(row) => row.id}
          />
        ) : (
          <EmptyState
            icon={HardDrive}
            title={backups && Array.isArray(backups.backups) ? "暂无备份" : "备份列表不可用"}
            description={backups && Array.isArray(backups.backups) ? "尚未创建任何数据库备份" : "接口未返回备份文件列表。"}
          />
        )}
      </Section>
    </ConsolePage>
  );
}
