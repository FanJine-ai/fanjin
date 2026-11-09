export type RelayTaskStatus =
  | "queued"
  | "pending"
  | "running"
  | "enhancing"
  | "succeeded"
  | "success"
  | "completed"
  | "failed"
  | "cancelled"
  | string;

export interface RelayTaskRecord {
  id?: string;
  taskId?: string;
  providerTaskId?: string | null;
  requestId?: string | null;
  endpointType?: string | null;
  model?: string | null;
  provider?: string | null;
  channelId?: string | null;
  workspaceId?: string | null;
  status?: RelayTaskStatus;
  state?: RelayTaskStatus;
  progress?: number | { progress?: number; progressPercent?: number; stage?: string; stageLabel?: string } | null;
  costMicros?: number | null;
  quotaReserved?: number | null;
  errorMessage?: string | null;
  callbackUrl?: string | null;
  callbackStatus?: string | null;
  callbackAttempts?: number | null;
  createTime?: number | string | null;
  updateTime?: number | string | null;
  submittedAt?: number | string | null;
  completedAt?: number | string | null;
  requestPayload?: Record<string, unknown> | null;
  providerPayload?: Record<string, unknown> | null;
  resultPayload?: Record<string, unknown> | null;
  internalPlan?: Record<string, unknown> | null;
  billing?: Record<string, unknown> | null;
  assets?: unknown[];
  channel?: { id?: string; name?: string; provider?: string; endpointType?: string } | null;
  workspace?: { id?: string; name?: string; slug?: string; status?: string } | null;
  [key: string]: unknown;
}

export interface RelayTaskListResponse {
  items?: RelayTaskRecord[];
  data?: RelayTaskRecord[];
  summary?: Record<string, number>;
  total?: number;
  pageNum?: number;
  pageSize?: number;
}

export interface RelayTaskFilters {
  status: string;
  keyword: string;
  startDate: string;
  endDate: string;
}

export interface RelayTaskRow {
  id: string;
  source: RelayTaskRecord;
  model: string;
  provider: string;
  status: string;
  workspace: string;
  cost: string;
  createdAt: string;
  createdTimestamp: number;
  failureReason: string;
}
