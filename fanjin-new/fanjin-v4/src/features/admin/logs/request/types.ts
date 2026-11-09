export type RequestLogSearchField = "path" | "requestId" | "relayTaskId" | "apiKeyPrefix";

export interface RequestLogFilters {
  query: string;
  searchField: RequestLogSearchField;
  statusCode: string;
  workspaceId: string;
  actorUserId: string;
  apiKeyPrefix: string;
  requestId: string;
  relayTaskId: string;
  startDate: string;
  endDate: string;
}

export interface RequestLogListInput {
  workspaceId?: string;
  actorUserId?: number;
  apiKeyPrefix?: string;
  requestId?: string;
  relayTaskId?: string;
  path?: string;
  statusCode?: number;
  startTime?: number;
  endTime?: number;
  pageNum: number;
  pageSize: number;
}

export type RequestLogStatsInput = Omit<RequestLogListInput, "pageNum" | "pageSize"> & { days?: number };

export interface RequestLogRecord {
  id?: string | number;
  requestId?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | string | null;
  durationMs?: number | string | null;
  workspaceId?: string | null;
  actorUserId?: number | string | null;
  apiKeyId?: string | number | null;
  apiKeyPrefix?: string | null;
  model?: string | null;
  targetResolution?: string | null;
  relayTaskId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  createdAt?: number | string | null;
  metadata?: unknown;
}

export interface RequestLogListResponse {
  items?: RequestLogRecord[];
  data?: RequestLogRecord[];
  total?: number;
  pageNum?: number;
  pageSize?: number;
}

export interface RequestLogStatsResponse {
  days?: number;
  total?: number;
  status2xx?: number;
  status4xx?: number;
  status5xx?: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
  byDay?: Array<{ date: string; total: number; errors: number; avgDurationMs: number }>;
  topPaths?: Array<{ path: string; total: number; errors: number; avgDurationMs: number }>;
}

export interface RequestLogRow {
  id: string;
  requestId: string;
  time: string;
  timestamp: number;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  duration: string;
  workspaceId: string;
  actorUserId: string;
  apiKeyPrefix: string;
  model: string;
  targetResolution: string;
  relayTaskId: string;
  errorCode: string;
  failureReason: string;
  ip: string;
  userAgent: string;
  metadata: string;
}

export interface RequestLogsState {
  listLoading: boolean;
  statsLoading: boolean;
  listError: string;
  statsError: string;
  list: RequestLogListResponse;
  stats: RequestLogStatsResponse;
}

export const emptyRequestLogFilters: RequestLogFilters = {
  query: "",
  searchField: "path",
  statusCode: "",
  workspaceId: "",
  actorUserId: "",
  apiKeyPrefix: "",
  requestId: "",
  relayTaskId: "",
  startDate: "",
  endDate: "",
};
