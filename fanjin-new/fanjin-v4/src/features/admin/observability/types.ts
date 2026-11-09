export interface ObservabilityMetrics {
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
    cpuUsage: number;
    uptime: number;
    memory: {
      heapUsed: number;
      heapTotal: number;
      external: number;
      rss: number;
    };
    eventLoop: { delay: number };
  };
  business: {
    activeUsers: number;
    totalApiCalls: number;
    errorRate: number;
  };
  computed: {
    avgResponseTime: number;
    memoryUsagePercent: number;
    requestsPerSecond: number;
    errorRate: number;
  };
  timestamp: string;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  components: {
    database: { status: string; latencyMs?: number | null };
    redis: {
      status: string;
      configured?: boolean;
      required?: boolean;
      latencyMs?: number | null;
    };
    worker: { status: string; lastSeen?: number };
    web: { status: string };
  };
  timestamp: string;
}

export interface BackupSchedulerStatus {
  configured: boolean;
  localRunning: boolean;
  processRole: "all" | "api" | "worker" | "unknown";
  state:
    | "disabled"
    | "running_local"
    | "configured_external_status_unknown"
    | "configured_not_running_local";
  nextBackupTime: string | null;
}

export interface BackupListResponse {
  backups: Array<{
    id: string;
    timestamp: number;
    filename: string;
    size: number;
    verified: boolean;
    uploadedToCloud: boolean;
  }>;
  config: {
    enabled: boolean;
    schedule: string;
    retentionDays: number;
    retentionCount: number;
    uploadToCloud: boolean;
  };
  scheduler: BackupSchedulerStatus;
}
