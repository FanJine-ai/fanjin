import { Request, Response, NextFunction } from "express";
import {
  getAgentBillingReconciliationMetrics,
  resetAgentBillingReconciliationMetrics,
  type AgentBillingReconciliationMetrics,
} from "@/agent-runtime/agentBillingReconciliation";
import {
  getOperationalObservabilitySnapshot,
  OPERATIONAL_BILLING_RECONCILIATION_CATEGORIES,
  OPERATIONAL_ENDPOINT_TYPES,
  OPERATIONAL_QUEUE_NAMES,
  resetOperationalObservabilitySnapshot,
  type OperationalObservabilitySnapshot,
} from "@/lib/operationalObservability";
import {
  getCacheStorageBillingMetrics,
  resetCacheStorageBillingMetrics,
  type CacheStorageBillingMetrics,
} from "@/lib/cacheStorageBilling";

/**
 * 指标数据存储
 * 生产环境应该使用 Prometheus 或其他时序数据库
 */
export interface Metrics {
  http: {
    requests: {
      total: number;
      byMethod: Record<string, number>;
      byStatus: Record<string, number>;
      byPath: Record<string, number>;
    };
    responseTimes: {
      total: number;
      count: number;
      min: number;
      max: number;
      p50: number;
      p95: number;
      p99: number;
    };
  };
  system: {
    uptime: number;
    cpuUsage: number;
    memory: {
      heapUsed: number;
      heapTotal: number;
      external: number;
      rss: number;
    };
    eventLoop: {
      delay: number;
    };
  };
  business: {
    activeUsers: number;
    totalApiCalls: number;
    errorRate: number;
  };
  agentBillingReconciliation: AgentBillingReconciliationMetrics;
  cacheStorageBilling: CacheStorageBillingMetrics;
  operational: OperationalObservabilitySnapshot;
}

export interface PrometheusHealthChecks {
  database: boolean;
  redis: boolean;
  worker: boolean;
  web: boolean;
}

export interface PrometheusMetricsOptions {
  version: string;
  health: PrometheusHealthChecks;
}

// 存储响应时间用于计算百分位数
const responseTimeSamples: number[] = [];
const MAX_SAMPLES = 10000; // 保留最近 10000 个样本
const PROCESS_START_TIME_SECONDS = Math.floor(Date.now() / 1000 - process.uptime());
let previousCpuUsage = process.cpuUsage();
let previousCpuSampleAt = process.hrtime.bigint();

// 初始化指标
const metrics: Metrics = {
  http: {
    requests: {
      total: 0,
      byMethod: {},
      byStatus: {},
      byPath: {},
    },
    responseTimes: {
      total: 0,
      count: 0,
      min: Infinity,
      max: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    },
  },
  system: {
    uptime: 0,
    cpuUsage: 0,
    memory: {
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      rss: 0,
    },
    eventLoop: {
      delay: 0,
    },
  },
  business: {
    activeUsers: 0,
    totalApiCalls: 0,
    errorRate: 0,
  },
  agentBillingReconciliation: getAgentBillingReconciliationMetrics(),
  cacheStorageBilling: getCacheStorageBillingMetrics(),
  operational: getOperationalObservabilitySnapshot(),
};

/**
 * 计算百分位数
 */
function calculatePercentile(samples: number[], percentile: number): number {
  if (samples.length === 0) return 0;
  
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * 更新响应时间统计
 */
function updateResponseTimeStats() {
  if (responseTimeSamples.length === 0) return;
  
  metrics.http.responseTimes.p50 = calculatePercentile(responseTimeSamples, 50);
  metrics.http.responseTimes.p95 = calculatePercentile(responseTimeSamples, 95);
  metrics.http.responseTimes.p99 = calculatePercentile(responseTimeSamples, 99);
}

/**
 * 记录 HTTP 请求指标
 */
export function recordHttpMetrics(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
) {
  // 更新请求计数
  metrics.http.requests.total++;
  metrics.http.requests.byMethod[method] = (metrics.http.requests.byMethod[method] || 0) + 1;
  metrics.http.requests.byStatus[statusCode] = (metrics.http.requests.byStatus[statusCode] || 0) + 1;
  
  // 对路径进行归一化（去掉动态参数）
  const normalizedPath = normalizePath(path);
  metrics.http.requests.byPath[normalizedPath] = (metrics.http.requests.byPath[normalizedPath] || 0) + 1;
  
  // 更新响应时间统计
  metrics.http.responseTimes.total += durationMs;
  metrics.http.responseTimes.count++;
  metrics.http.responseTimes.min = Math.min(metrics.http.responseTimes.min, durationMs);
  metrics.http.responseTimes.max = Math.max(metrics.http.responseTimes.max, durationMs);
  
  // 保存样本用于计算百分位数
  responseTimeSamples.push(durationMs);
  if (responseTimeSamples.length > MAX_SAMPLES) {
    responseTimeSamples.shift(); // 移除最旧的样本
  }
  
  // 定期更新百分位数（每 100 个请求更新一次）
  if (metrics.http.requests.total % 100 === 0) {
    updateResponseTimeStats();
  }
}

/**
 * 路径归一化：将动态参数替换为占位符
 * 例如：/api/users/123 -> /api/users/:id
 */
function normalizePath(path: string): string {
  // 跳过健康检查等静态路径
  if (["/health", "/healthz", "/ready", "/readiness", "/api/health", "/api/ready"].includes(path)) {
    return path;
  }
  
  // UUID 模式
  const uuidRegex = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  path = path.replace(uuidRegex, "/:id");
  
  // 数字 ID 模式
  const numericIdRegex = /\/\d+/g;
  path = path.replace(numericIdRegex, "/:id");
  
  return path;
}

/**
 * 更新系统指标
 */
export function updateSystemMetrics() {
  const cpuSampleAt = process.hrtime.bigint();
  const elapsedMicros = Number(cpuSampleAt - previousCpuSampleAt) / 1_000;
  const cpuDelta = process.cpuUsage(previousCpuUsage);
  metrics.system.cpuUsage = elapsedMicros > 0
    ? Math.max(0, Math.min(100, ((cpuDelta.user + cpuDelta.system) / elapsedMicros) * 100))
    : 0;
  previousCpuUsage = process.cpuUsage();
  previousCpuSampleAt = cpuSampleAt;
  metrics.system.uptime = process.uptime();
  
  const mem = process.memoryUsage();
  metrics.system.memory.heapUsed = mem.heapUsed;
  metrics.system.memory.heapTotal = mem.heapTotal;
  metrics.system.memory.external = mem.external;
  metrics.system.memory.rss = mem.rss;
  
  // 测量事件循环延迟
  const start = process.hrtime.bigint();
  setImmediate(() => {
    const delay = Number(process.hrtime.bigint() - start) / 1_000_000; // 转换为毫秒
    metrics.system.eventLoop.delay = delay;
  });
}

/**
 * 更新业务指标
 */
export function updateBusinessMetrics(updates: Partial<Metrics["business"]>) {
  Object.assign(metrics.business, updates);
}

/**
 * 获取当前指标
 */
export function getMetrics(): Metrics {
  updateSystemMetrics();
  updateResponseTimeStats();
  
  // 计算错误率
  const total = metrics.http.requests.total;
  const errors = Object.entries(metrics.http.requests.byStatus)
    .filter(([status]) => parseInt(status) >= 400)
    .reduce((sum, [_, count]) => sum + count, 0);
  
  metrics.business.errorRate = total > 0 ? errors / total : 0;
  metrics.business.totalApiCalls = total;
  metrics.agentBillingReconciliation = getAgentBillingReconciliationMetrics();
  metrics.cacheStorageBilling = getCacheStorageBillingMetrics();
  metrics.operational = getOperationalObservabilitySnapshot();
  
  return metrics;
}

function finiteMetricValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function escapePrometheusLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function appendMetricHeader(lines: string[], name: string, help: string, type: "counter" | "gauge" | "summary") {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

/**
 * Export the in-memory metrics using the Prometheus text exposition format.
 * JSON consumers continue to use getMetrics() through /api/metrics and the
 * authenticated admin observability endpoint.
 */
export function getPrometheusMetrics(options: PrometheusMetricsOptions): string {
  const snapshot = getMetrics();
  const lines: string[] = [];

  appendMetricHeader(lines, "fanjin_http_requests_total", "Total HTTP requests handled by this process.", "counter");
  lines.push(`fanjin_http_requests_total ${finiteMetricValue(snapshot.http.requests.total)}`);

  appendMetricHeader(lines, "fanjin_http_requests_by_method_total", "HTTP requests grouped by method.", "counter");
  for (const [method, count] of Object.entries(snapshot.http.requests.byMethod).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`fanjin_http_requests_by_method_total{method="${escapePrometheusLabel(method)}"} ${finiteMetricValue(count)}`);
  }

  appendMetricHeader(lines, "fanjin_http_requests_by_status_total", "HTTP requests grouped by response status code.", "counter");
  for (const [status, count] of Object.entries(snapshot.http.requests.byStatus).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`fanjin_http_requests_by_status_total{status="${escapePrometheusLabel(status)}"} ${finiteMetricValue(count)}`);
  }

  appendMetricHeader(lines, "fanjin_http_requests_by_path_total", "HTTP requests grouped by normalized path.", "counter");
  for (const [path, count] of Object.entries(snapshot.http.requests.byPath).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`fanjin_http_requests_by_path_total{path="${escapePrometheusLabel(path)}"} ${finiteMetricValue(count)}`);
  }

  appendMetricHeader(lines, "fanjin_http_response_time_seconds", "HTTP response time summary in seconds.", "summary");
  lines.push(`fanjin_http_response_time_seconds{quantile="0.5"} ${finiteMetricValue(snapshot.http.responseTimes.p50 / 1000)}`);
  lines.push(`fanjin_http_response_time_seconds{quantile="0.95"} ${finiteMetricValue(snapshot.http.responseTimes.p95 / 1000)}`);
  lines.push(`fanjin_http_response_time_seconds{quantile="0.99"} ${finiteMetricValue(snapshot.http.responseTimes.p99 / 1000)}`);
  lines.push(`fanjin_http_response_time_seconds_sum ${finiteMetricValue(snapshot.http.responseTimes.total / 1000)}`);
  lines.push(`fanjin_http_response_time_seconds_count ${finiteMetricValue(snapshot.http.responseTimes.count)}`);

  appendMetricHeader(lines, "fanjin_process_uptime_seconds", "Process uptime in seconds.", "gauge");
  lines.push(`fanjin_process_uptime_seconds ${finiteMetricValue(snapshot.system.uptime)}`);

  appendMetricHeader(lines, "fanjin_start_time_seconds", "Process start time as Unix time in seconds.", "gauge");
  lines.push(`fanjin_start_time_seconds ${PROCESS_START_TIME_SECONDS}`);

  appendMetricHeader(lines, "fanjin_cpu_usage_percent", "Process CPU usage over the latest sampling window.", "gauge");
  lines.push(`fanjin_cpu_usage_percent ${finiteMetricValue(snapshot.system.cpuUsage)}`);

  appendMetricHeader(lines, "fanjin_memory_heap_used_bytes", "Node.js heap memory currently used in bytes.", "gauge");
  lines.push(`fanjin_memory_heap_used_bytes ${finiteMetricValue(snapshot.system.memory.heapUsed)}`);

  appendMetricHeader(lines, "fanjin_memory_heap_total_bytes", "Node.js total allocated heap memory in bytes.", "gauge");
  lines.push(`fanjin_memory_heap_total_bytes ${finiteMetricValue(snapshot.system.memory.heapTotal)}`);

  appendMetricHeader(lines, "fanjin_memory_external_bytes", "Node.js external memory in bytes.", "gauge");
  lines.push(`fanjin_memory_external_bytes ${finiteMetricValue(snapshot.system.memory.external)}`);

  appendMetricHeader(lines, "fanjin_memory_rss_bytes", "Process resident set size in bytes.", "gauge");
  lines.push(`fanjin_memory_rss_bytes ${finiteMetricValue(snapshot.system.memory.rss)}`);

  appendMetricHeader(lines, "fanjin_event_loop_delay_seconds", "Latest observed event loop delay in seconds.", "gauge");
  lines.push(`fanjin_event_loop_delay_seconds ${finiteMetricValue(snapshot.system.eventLoop.delay / 1000)}`);

  appendMetricHeader(lines, "fanjin_active_users", "Current active-user estimate.", "gauge");
  lines.push(`fanjin_active_users ${finiteMetricValue(snapshot.business.activeUsers)}`);

  appendMetricHeader(lines, "fanjin_api_calls_total", "Total API calls tracked by the business metrics view.", "counter");
  lines.push(`fanjin_api_calls_total ${finiteMetricValue(snapshot.business.totalApiCalls)}`);

  appendMetricHeader(lines, "fanjin_error_rate", "Fraction of HTTP requests with a 4xx or 5xx response.", "gauge");
  lines.push(`fanjin_error_rate ${finiteMetricValue(snapshot.business.errorRate)}`);

  const agentBilling = snapshot.agentBillingReconciliation;
  appendMetricHeader(lines, "fanjin_agent_billing_reconciliation_alert_active", "Whether the latest Agent billing scan requires operator attention.", "gauge");
  lines.push(`fanjin_agent_billing_reconciliation_alert_active ${agentBilling.alertActive ? 1 : 0}`);
  appendMetricHeader(lines, "fanjin_agent_billing_reconciliation_last_scan_success", "Whether the latest Agent billing scan completed successfully.", "gauge");
  lines.push(`fanjin_agent_billing_reconciliation_last_scan_success ${agentBilling.lastScanSucceeded ? 1 : 0}`);
  appendMetricHeader(lines, "fanjin_agent_billing_reconciliation_last_scan_timestamp_seconds", "Unix timestamp of the latest Agent billing scan attempt.", "gauge");
  lines.push(`fanjin_agent_billing_reconciliation_last_scan_timestamp_seconds ${finiteMetricValue(agentBilling.lastScanAt / 1000)}`);
  appendMetricHeader(lines, "fanjin_agent_billing_reconciliation_failures_total", "Total Agent billing scan failures in this process.", "counter");
  lines.push(`fanjin_agent_billing_reconciliation_failures_total ${finiteMetricValue(agentBilling.failuresTotal)}`);
  appendMetricHeader(lines, "fanjin_agent_billing_reconciliation_findings", "Latest read-only Agent billing reconciliation facts by category.", "gauge");
  const agentBillingFindings = {
    overcharge: agentBilling.overcharge,
    missing_billing_flow: agentBilling.missingBillingFlow,
    missing_usage: agentBilling.missingUsage,
    open_reservation: agentBilling.openReservation,
    pending_reconcile: agentBilling.pendingReconcile,
  };
  for (const [category, count] of Object.entries(agentBillingFindings)) {
    lines.push(`fanjin_agent_billing_reconciliation_findings{category="${category}"} ${finiteMetricValue(count)}`);
  }
  appendMetricHeader(lines, "fanjin_agent_billing_reconciliation_oldest_pending_age_seconds", "Age in seconds of the oldest pending_reconcile fact in the latest scan.", "gauge");
  lines.push(`fanjin_agent_billing_reconciliation_oldest_pending_age_seconds ${finiteMetricValue(agentBilling.oldestPendingReconcileAgeMs / 1000)}`);

  const cacheStorage = snapshot.cacheStorageBilling;
  appendMetricHeader(lines, "fanjin_cache_storage_billing_last_run_success", "Whether the latest cache-storage billing batch completed successfully.", "gauge");
  lines.push(`fanjin_cache_storage_billing_last_run_success ${cacheStorage.lastRunSucceeded ? 1 : 0}`);
  appendMetricHeader(lines, "fanjin_cache_storage_billing_last_run_timestamp_seconds", "Unix timestamp of the latest cache-storage billing batch.", "gauge");
  lines.push(`fanjin_cache_storage_billing_last_run_timestamp_seconds ${finiteMetricValue(cacheStorage.lastRunAt / 1000)}`);
  appendMetricHeader(lines, "fanjin_cache_storage_billing_accruals", "Durable cache-storage accruals by bounded state.", "gauge");
  lines.push(`fanjin_cache_storage_billing_accruals{state="active"} ${finiteMetricValue(cacheStorage.active)}`);
  lines.push(`fanjin_cache_storage_billing_accruals{state="processing"} ${finiteMetricValue(cacheStorage.processing)}`);
  lines.push(`fanjin_cache_storage_billing_accruals{state="manual_required"} ${finiteMetricValue(cacheStorage.manualRequired)}`);
  appendMetricHeader(lines, "fanjin_cache_storage_billing_events_total", "Cache-storage billing process events by bounded result.", "counter");
  const cacheStorageEvents = {
    created: cacheStorage.createdTotal,
    charge_attempt: cacheStorage.chargeAttemptsTotal,
    charge_success: cacheStorage.chargeSuccessTotal,
    charge_failure: cacheStorage.chargeFailuresTotal,
    insufficient_balance: cacheStorage.insufficientBalanceTotal,
    manual_required: cacheStorage.manualRequiredTotal,
    expired_processing_recovered: cacheStorage.recoveredExpiredProcessingTotal,
    database_failure: cacheStorage.databaseFailuresTotal,
  };
  for (const [result, count] of Object.entries(cacheStorageEvents)) {
    lines.push(`fanjin_cache_storage_billing_events_total{result="${result}"} ${finiteMetricValue(count)}`);
  }
  appendMetricHeader(lines, "fanjin_cache_storage_billing_oldest_due_age_seconds", "Age of the oldest due active cache-storage accrual.", "gauge");
  lines.push(`fanjin_cache_storage_billing_oldest_due_age_seconds ${finiteMetricValue(cacheStorage.oldestDueAgeSeconds)}`);

  const operational = snapshot.operational;
  appendMetricHeader(lines, "fanjin_operational_collection_success", "Whether the latest bounded operational metrics collection completed successfully.", "gauge");
  lines.push(`fanjin_operational_collection_success ${operational.collection.succeeded ? 1 : 0}`);
  appendMetricHeader(lines, "fanjin_operational_collection_last_run_timestamp_seconds", "Unix timestamp of the latest bounded operational metrics collection attempt.", "gauge");
  lines.push(`fanjin_operational_collection_last_run_timestamp_seconds ${finiteMetricValue(operational.collection.lastRunAt / 1000)}`);
  appendMetricHeader(lines, "fanjin_operational_collection_last_success_timestamp_seconds", "Unix timestamp of the latest successful bounded operational metrics collection.", "gauge");
  lines.push(`fanjin_operational_collection_last_success_timestamp_seconds ${finiteMetricValue(operational.collection.lastSuccessAt / 1000)}`);
  appendMetricHeader(lines, "fanjin_operational_collection_failures_total", "Total bounded operational metrics collection failures in this process.", "counter");
  lines.push(`fanjin_operational_collection_failures_total ${finiteMetricValue(operational.collection.failuresTotal)}`);

  appendMetricHeader(lines, "fanjin_agent_surface_synthetic_success", "Whether the latest read-only post-auth Agent surface synthetic check succeeded.", "gauge");
  lines.push(`fanjin_agent_surface_synthetic_success ${operational.synthetic.succeeded ? 1 : 0}`);
  appendMetricHeader(lines, "fanjin_agent_surface_synthetic_zero_gu", "Invariant that the Agent surface synthetic uses read models only and spends zero GU.", "gauge");
  lines.push(`fanjin_agent_surface_synthetic_zero_gu ${operational.synthetic.zeroGu ? 1 : 0}`);
  appendMetricHeader(lines, "fanjin_agent_surface_synthetic_last_run_timestamp_seconds", "Unix timestamp of the latest read-only Agent surface synthetic attempt.", "gauge");
  lines.push(`fanjin_agent_surface_synthetic_last_run_timestamp_seconds ${finiteMetricValue(operational.synthetic.lastRunAt / 1000)}`);
  appendMetricHeader(lines, "fanjin_agent_surface_synthetic_last_success_timestamp_seconds", "Unix timestamp of the latest successful read-only Agent surface synthetic check.", "gauge");
  lines.push(`fanjin_agent_surface_synthetic_last_success_timestamp_seconds ${finiteMetricValue(operational.synthetic.lastSuccessAt / 1000)}`);
  appendMetricHeader(lines, "fanjin_agent_surface_synthetic_failures_total", "Total read-only Agent surface synthetic failures in this process.", "counter");
  lines.push(`fanjin_agent_surface_synthetic_failures_total ${finiteMetricValue(operational.synthetic.failuresTotal)}`);

  appendMetricHeader(lines, "fanjin_agent_worker_heartbeat_records", "Agent worker heartbeat availability using bounded state labels.", "gauge");
  lines.push(`fanjin_agent_worker_heartbeat_records{state="fresh"} ${finiteMetricValue(operational.database.agentWorker.freshCount)}`);
  lines.push(`fanjin_agent_worker_heartbeat_records{state="stale"} ${operational.database.agentWorker.stale ? 1 : 0}`);
  appendMetricHeader(lines, "fanjin_agent_worker_latest_heartbeat_age_seconds", "Age of the latest Agent worker heartbeat in seconds.", "gauge");
  lines.push(`fanjin_agent_worker_latest_heartbeat_age_seconds ${finiteMetricValue(operational.database.agentWorker.latestHeartbeatAgeSeconds)}`);

  appendMetricHeader(lines, "fanjin_model_catalog_can_submit", "User-visible models that currently pass canSubmit by fixed endpoint type.", "gauge");
  appendMetricHeader(lines, "fanjin_model_catalog_can_submit_missing", "Whether a required endpoint type has no user-visible canSubmit model.", "gauge");
  appendMetricHeader(lines, "fanjin_model_catalog_degraded", "User-visible models that currently fail canSubmit by fixed endpoint type.", "gauge");
  for (const endpointType of OPERATIONAL_ENDPOINT_TYPES) {
    const canSubmit = operational.catalog.canSubmit[endpointType];
    lines.push(`fanjin_model_catalog_can_submit{endpoint_type="${endpointType}"} ${finiteMetricValue(canSubmit)}`);
    lines.push(`fanjin_model_catalog_can_submit_missing{endpoint_type="${endpointType}"} ${canSubmit > 0 ? 0 : 1}`);
    lines.push(`fanjin_model_catalog_degraded{endpoint_type="${endpointType}"} ${finiteMetricValue(operational.catalog.degraded[endpointType])}`);
  }

  appendMetricHeader(lines, "fanjin_queue_backlog", "Pending work by fixed queue name.", "gauge");
  appendMetricHeader(lines, "fanjin_queue_oldest_age_seconds", "Age of the oldest pending item by fixed queue name.", "gauge");
  for (const queue of OPERATIONAL_QUEUE_NAMES) {
    lines.push(`fanjin_queue_backlog{queue="${queue}"} ${finiteMetricValue(operational.database.queues[queue].backlog)}`);
    lines.push(`fanjin_queue_oldest_age_seconds{queue="${queue}"} ${finiteMetricValue(operational.database.queues[queue].oldestAgeSeconds)}`);
  }

  appendMetricHeader(lines, "fanjin_billing_open_reservations", "Open GU freeze reservations with remaining value.", "gauge");
  lines.push(`fanjin_billing_open_reservations ${finiteMetricValue(operational.database.reservations.open)}`);
  appendMetricHeader(lines, "fanjin_billing_aged_open_reservations", "Open GU freeze reservations older than the configured maximum age.", "gauge");
  lines.push(`fanjin_billing_aged_open_reservations ${finiteMetricValue(operational.database.reservations.aged)}`);
  appendMetricHeader(lines, "fanjin_billing_oldest_open_reservation_age_seconds", "Age of the oldest open GU freeze reservation.", "gauge");
  lines.push(`fanjin_billing_oldest_open_reservation_age_seconds ${finiteMetricValue(operational.database.reservations.oldestAgeSeconds)}`);

  const operationalBilling = operational.billingReconciliation;
  appendMetricHeader(lines, "fanjin_billing_reconciliation_last_scan_success", "Whether the latest API-visible read-only billing reconciliation scan succeeded.", "gauge");
  lines.push(`fanjin_billing_reconciliation_last_scan_success ${operationalBilling.succeeded ? 1 : 0}`);
  appendMetricHeader(lines, "fanjin_billing_reconciliation_last_scan_timestamp_seconds", "Unix timestamp of the latest API-visible read-only billing reconciliation attempt.", "gauge");
  lines.push(`fanjin_billing_reconciliation_last_scan_timestamp_seconds ${finiteMetricValue(operationalBilling.lastRunAt / 1000)}`);
  appendMetricHeader(lines, "fanjin_billing_reconciliation_last_success_timestamp_seconds", "Unix timestamp of the latest successful API-visible read-only billing reconciliation scan.", "gauge");
  lines.push(`fanjin_billing_reconciliation_last_success_timestamp_seconds ${finiteMetricValue(operationalBilling.lastSuccessAt / 1000)}`);
  appendMetricHeader(lines, "fanjin_billing_reconciliation_failures_total", "Total API-visible read-only billing reconciliation scan failures.", "counter");
  lines.push(`fanjin_billing_reconciliation_failures_total ${finiteMetricValue(operationalBilling.failuresTotal)}`);
  appendMetricHeader(lines, "fanjin_billing_reconciliation_findings", "Latest API-visible read-only billing reconciliation facts by fixed category.", "gauge");
  for (const category of OPERATIONAL_BILLING_RECONCILIATION_CATEGORIES) {
    lines.push(`fanjin_billing_reconciliation_findings{category="${category}"} ${finiteMetricValue(operationalBilling.findings[category])}`);
  }
  appendMetricHeader(lines, "fanjin_billing_reconciliation_oldest_pending_age_seconds", "Age in seconds of the oldest pending reconciliation fact in the API-visible scan.", "gauge");
  lines.push(`fanjin_billing_reconciliation_oldest_pending_age_seconds ${finiteMetricValue(operationalBilling.oldestPendingAgeSeconds)}`);

  appendMetricHeader(lines, "fanjin_version_info", "Fanjin API build version information.", "gauge");
  lines.push(`fanjin_version_info{version="${escapePrometheusLabel(options.version)}"} 1`);

  appendMetricHeader(lines, "fanjin_health_check", "Whether a required runtime component is healthy (1) or unhealthy (0).", "gauge");
  for (const [component, healthy] of Object.entries(options.health).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`fanjin_health_check{component="${escapePrometheusLabel(component)}"} ${healthy ? 1 : 0}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * 重置指标（用于测试）
 */
export function resetMetrics() {
  metrics.http.requests.total = 0;
  metrics.http.requests.byMethod = {};
  metrics.http.requests.byStatus = {};
  metrics.http.requests.byPath = {};
  metrics.http.responseTimes.total = 0;
  metrics.http.responseTimes.count = 0;
  metrics.http.responseTimes.min = Infinity;
  metrics.http.responseTimes.max = 0;
  metrics.http.responseTimes.p50 = 0;
  metrics.http.responseTimes.p95 = 0;
  metrics.http.responseTimes.p99 = 0;
  metrics.system.cpuUsage = 0;
  previousCpuUsage = process.cpuUsage();
  previousCpuSampleAt = process.hrtime.bigint();
  responseTimeSamples.length = 0;
  resetAgentBillingReconciliationMetrics();
  resetCacheStorageBillingMetrics();
  resetOperationalObservabilitySnapshot();
  metrics.agentBillingReconciliation = getAgentBillingReconciliationMetrics();
  metrics.cacheStorageBilling = getCacheStorageBillingMetrics();
}

/**
 * Express 中间件：自动记录 HTTP 指标
 */
export function metricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    
    // 监听响应完成事件
    res.on("finish", () => {
      const duration = Date.now() - startTime;
      recordHttpMetrics(req.method, req.path, res.statusCode, duration);
    });
    
    next();
  };
}

// 定期更新系统指标（每 30 秒）
setInterval(updateSystemMetrics, 30_000);

// 初始化系统指标
updateSystemMetrics();
