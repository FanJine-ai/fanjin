export type ReconciliationStatus = "pending" | "leased" | "manual_required" | "resolved";

export interface ReconciliationBillingProjection {
  reservation: {
    id: string;
    status: string;
    amountMicros: number;
    remainingMicros: number;
  } | null;
  usage: {
    id: string;
    status: string;
    costMicros: number;
    units: number;
    unit: string;
  } | null;
  relatedLedgers: Array<{
    id: string;
    type: "deduct" | "release";
    status: string;
    amountMicros: number;
  }>;
  deductedMicros: number;
  releasedMicros: number;
}

export interface ReconciliationJob {
  id: string;
  dedupeKey: string;
  workspaceId: string;
  reservationId: string;
  usageRecordId: string | null;
  requestId: string | null;
  endpointType: string | null;
  provider: string | null;
  channelId: string | null;
  status: ReconciliationStatus;
  reason: string;
  evidence: Record<string, unknown>;
  decision: string | null;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  resolvedAt: number | null;
  createTime: number;
  updateTime: number;
  billingProjection?: ReconciliationBillingProjection;
}

export interface ReconciliationList {
  items: ReconciliationJob[];
  total: number;
}

export interface ReconciliationRunResult {
  claimed: number;
  processed: number;
}
