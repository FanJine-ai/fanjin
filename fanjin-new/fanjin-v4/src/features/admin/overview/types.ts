export interface ProviderHealthRecord {
  id?: string | number;
  name?: string | null;
  channelName?: string | null;
  provider?: string | null;
  endpointType?: string | null;
  disabled?: boolean | number | null;
  healthStatus?: string | null;
  lastHealthCheckAt?: string | number | null;
  lastHealthLatencyMs?: number | null;
  lastHealthError?: string | null;
  health?: {
    status?: string | null;
    checkedAt?: string | number | null;
    latencyMs?: number | null;
    errorMessage?: string | null;
  } | null;
}

export interface RequestTrendPoint {
  date: string;
  total: number;
  errors: number;
  avgDurationMs: number;
}

export interface RequestStats {
  days?: number;
  total?: number;
  status2xx?: number;
  status4xx?: number;
  status5xx?: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
  byDay?: RequestTrendPoint[];
}

export interface RelayTaskSummary {
  items?: Array<Record<string, unknown>>;
  total?: number;
  summary?: Record<string, number>;
}

export interface AuditSummary {
  items?: Array<Record<string, unknown>>;
  total?: number;
}

export interface UsersSummary {
  total?: number;
  summary?: {
    total?: number;
    active?: number;
    personal?: number;
    enterprise?: number;
  };
}

export interface OverviewSnapshot {
  providers: ProviderHealthRecord[];
  requests: RequestStats;
  tasks: RelayTaskSummary;
  audits: AuditSummary;
  users: UsersSummary;
  errors: Partial<Record<"providers" | "requests" | "tasks" | "audits" | "users", string>>;
  loadedAt: number;
}

