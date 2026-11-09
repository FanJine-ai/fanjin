export interface AuditLogRecord {
  id?: string;
  workspaceId?: string | null;
  actorUserId?: number | string | null;
  actorRole?: string | null;
  action?: string | null;
  resourceType?: string | null;
  resourceId?: string | number | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | string | null;
  createdAt?: number | string | null;
  [key: string]: unknown;
}
export interface AuditLogListResponse {
  items?: AuditLogRecord[];
  data?: AuditLogRecord[];
  total?: number;
  pageNum?: number;
  pageSize?: number;
}

export interface AuditLogFilters {
  keyword: string;
  action: string;
  resourceType: string;
  actorUserId: string;
  workspaceId: string;
  startDate: string;
  endDate: string;
}

export interface AuditLogRow {
  id: string;
  source: AuditLogRecord;
  action: string;
  resourceType: string;
  resourceId: string;
  actorUserId: string;
  actorRole: string;
  workspaceId: string;
  ip: string;
  userAgent: string;
  timestamp: number;
  time: string;
  metadata: Record<string, unknown>;
}

export interface AuditLogListInput {
  pageNum: number;
  pageSize: number;
  keyword?: string;
  action?: string;
  resourceType?: string;
  actorUserId?: number;
  workspaceId?: string;
  startTime?: number;
  endTime?: number;
}
