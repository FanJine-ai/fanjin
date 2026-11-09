import crypto from "node:crypto";
import type { VideoOperation } from "@/lib/videoGenerationContract";

export const VIDEO_GENERATION_QUOTE_VERSION = "video-generation-quote/v1" as const;
export const VIDEO_GENERATION_SETTLEMENT_VERSION = "video-generation-settlement/v1" as const;

export type VideoGenerationQuoteSnapshot = {
  version: typeof VIDEO_GENERATION_QUOTE_VERSION;
  quoteId: string;
  workspaceId: string;
  projectId: string;
  modelRouteId: string;
  operation: VideoOperation;
  providerContractVersion: string;
  pricingRevision: string;
  requestDigest: string;
  maximumGuMicros: number;
  createdAt: string;
  expiresAt: string;
};

export type VideoGenerationBillingState = {
  version: typeof VIDEO_GENERATION_SETTLEMENT_VERSION;
  quote: VideoGenerationQuoteSnapshot;
  status: "quoted" | "reserved" | "settled" | "released" | "pending_reconcile";
  reservationId: string | null;
  providerRequestId: string | null;
  providerAcceptedAt: string | null;
  usageRecordId: string | null;
  ledgerEntryId: string | null;
  actualGuMicros: number | null;
  terminalEventId: string | null;
  terminalReason: string | null;
  updatedAt: string;
};

export type VideoProviderTerminalOutcome =
  | "succeeded"
  | "cancelled"
  | "rejected"
  | "failed"
  | "unknown";

export class VideoGenerationSettlementError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VideoGenerationSettlementError";
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;

function required(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new VideoGenerationSettlementError("billing_field_required", `${name} 不能为空`);
  return normalized;
}

function instant(value: Date, name: string): string {
  if (!Number.isFinite(value.getTime())) {
    throw new VideoGenerationSettlementError("billing_time_invalid", `${name} 时间无效`);
  }
  return value.toISOString();
}

function guMicros(value: unknown, name: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new VideoGenerationSettlementError("billing_amount_invalid", `${name} GU micros 无效`);
  }
  return normalized;
}

export function createVideoGenerationQuote(input: {
  quoteId: string;
  workspaceId: string;
  projectId: string;
  modelRouteId: string;
  operation: VideoOperation;
  providerContractVersion: string;
  pricingRevision: string;
  requestDigest: string;
  maximumGuMicros: number;
  now?: Date;
  expiresAt: Date;
}): VideoGenerationQuoteSnapshot {
  const now = input.now ?? new Date();
  const createdAt = instant(now, "createdAt");
  const expiresAt = instant(input.expiresAt, "expiresAt");
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new VideoGenerationSettlementError("billing_quote_expiry_invalid", "报价过期时间无效");
  }
  const requestDigest = required(input.requestDigest, "requestDigest").toLowerCase();
  if (!SHA256.test(requestDigest)) {
    throw new VideoGenerationSettlementError("billing_request_digest_invalid", "报价请求摘要无效");
  }
  return Object.freeze({
    version: VIDEO_GENERATION_QUOTE_VERSION,
    quoteId: required(input.quoteId, "quoteId"),
    workspaceId: required(input.workspaceId, "workspaceId"),
    projectId: required(input.projectId, "projectId"),
    modelRouteId: required(input.modelRouteId, "modelRouteId"),
    operation: input.operation,
    providerContractVersion: required(input.providerContractVersion, "providerContractVersion"),
    pricingRevision: required(input.pricingRevision, "pricingRevision"),
    requestDigest,
    maximumGuMicros: guMicros(input.maximumGuMicros, "maximum"),
    createdAt,
    expiresAt,
  });
}

export function beginVideoGenerationBilling(
  quote: VideoGenerationQuoteSnapshot,
): VideoGenerationBillingState {
  return {
    version: VIDEO_GENERATION_SETTLEMENT_VERSION,
    quote,
    status: "quoted",
    reservationId: null,
    providerRequestId: null,
    providerAcceptedAt: null,
    usageRecordId: null,
    ledgerEntryId: null,
    actualGuMicros: null,
    terminalEventId: null,
    terminalReason: null,
    updatedAt: quote.createdAt,
  };
}

export function reserveVideoGenerationQuote(
  state: VideoGenerationBillingState,
  input: { reservationId: string; requestDigest: string; now?: Date },
): VideoGenerationBillingState {
  const now = input.now ?? new Date();
  if (state.status === "reserved") {
    if (state.reservationId === input.reservationId && state.quote.requestDigest === input.requestDigest) return state;
    throw new VideoGenerationSettlementError("billing_reservation_replay_conflict", "报价冻结重放发生冲突");
  }
  if (state.status !== "quoted") {
    throw new VideoGenerationSettlementError("billing_state_conflict", "当前计费状态不能冻结");
  }
  if (now.getTime() >= Date.parse(state.quote.expiresAt)) {
    throw new VideoGenerationSettlementError("billing_quote_expired", "报价已过期");
  }
  if (input.requestDigest !== state.quote.requestDigest) {
    throw new VideoGenerationSettlementError("billing_quote_request_changed", "当前请求与报价快照不一致");
  }
  return {
    ...state,
    status: "reserved",
    reservationId: required(input.reservationId, "reservationId"),
    updatedAt: instant(now, "reservedAt"),
  };
}

export function markVideoProviderAccepted(
  state: VideoGenerationBillingState,
  input: { providerRequestId: string; now?: Date },
): VideoGenerationBillingState {
  const now = input.now ?? new Date();
  if (state.status !== "reserved") {
    throw new VideoGenerationSettlementError("billing_state_conflict", "上游接收前必须已完成 GU 冻结");
  }
  const providerRequestId = required(input.providerRequestId, "providerRequestId");
  if (state.providerRequestId) {
    if (state.providerRequestId === providerRequestId) return state;
    throw new VideoGenerationSettlementError("billing_provider_request_conflict", "上游请求 ID 已变更");
  }
  return {
    ...state,
    providerRequestId,
    providerAcceptedAt: instant(now, "providerAcceptedAt"),
    updatedAt: instant(now, "updatedAt"),
  };
}

export function settleVideoGenerationOutcome(
  state: VideoGenerationBillingState,
  input: {
    terminalEventId: string;
    outcome: VideoProviderTerminalOutcome;
    providerRequestId?: string | null;
    chargeKnown: boolean;
    actualGuMicros?: number | null;
    usageRecordId?: string | null;
    ledgerEntryId?: string | null;
    reason?: string;
    now?: Date;
  },
): VideoGenerationBillingState {
  const now = input.now ?? new Date();
  const terminalEventId = required(input.terminalEventId, "terminalEventId");
  if (["settled", "released", "pending_reconcile"].includes(state.status)) {
    if (state.terminalEventId === terminalEventId) return state;
    throw new VideoGenerationSettlementError("billing_terminal_replay_conflict", "计费终态已由其他事件确定");
  }
  if (state.status !== "reserved" || !state.reservationId) {
    throw new VideoGenerationSettlementError("billing_state_conflict", "未冻结 GU 的任务不能结算");
  }
  const providerRequestId = input.providerRequestId ? required(input.providerRequestId, "providerRequestId") : null;
  if (state.providerRequestId && providerRequestId && state.providerRequestId !== providerRequestId) {
    throw new VideoGenerationSettlementError("billing_provider_request_conflict", "结算引用的上游请求 ID 不一致");
  }
  const accepted = Boolean(state.providerRequestId || providerRequestId);
  const charge = input.actualGuMicros == null ? null : guMicros(input.actualGuMicros, "actual");
  if (charge !== null && charge > state.quote.maximumGuMicros) {
    throw new VideoGenerationSettlementError("billing_charge_exceeds_reservation", "实际计费超过冻结上限，必须待核");
  }
  const reason = String(input.reason ?? "").trim() || null;
  const updatedAt = instant(now, "settledAt");
  const terminal = {
    ...state,
    providerRequestId: state.providerRequestId || providerRequestId,
    terminalEventId,
    terminalReason: reason,
    updatedAt,
  };

  // Confirmed terminal failure with no billable charge returns the frozen GU.
  // Unknown charge on failure is treated as non-billable (platform absorbs any
  // later provider invoice) so users are not locked out of resubmitting.
  // A known non-zero charge on failure still falls through to reconciliation.
  const terminalFailure = ["rejected", "failed", "cancelled"].includes(input.outcome);
  const noBillableCharge = !input.chargeKnown || (charge ?? 0) === 0;
  const shouldRelease = terminalFailure && noBillableCharge;
  if (shouldRelease) {
    return {
      ...terminal,
      status: "released",
      actualGuMicros: 0,
      usageRecordId: input.usageRecordId ? required(input.usageRecordId, "usageRecordId") : null,
      ledgerEntryId: required(input.ledgerEntryId, "ledgerEntryId"),
    };
  }

  // Never auto-charge a terminal failure: a non-zero quote on failed/cancelled
  // requires human reconciliation before funds leave the reservation.
  const shouldSettle = !terminalFailure
    && input.chargeKnown
    && charge !== null
    && (input.outcome === "succeeded" || accepted);
  if (shouldSettle) {
    return {
      ...terminal,
      status: "settled",
      actualGuMicros: charge,
      usageRecordId: required(input.usageRecordId, "usageRecordId"),
      ledgerEntryId: required(input.ledgerEntryId, "ledgerEntryId"),
    };
  }

  return {
    ...terminal,
    status: "pending_reconcile",
    actualGuMicros: charge,
    usageRecordId: input.usageRecordId ? required(input.usageRecordId, "usageRecordId") : null,
    ledgerEntryId: input.ledgerEntryId ? required(input.ledgerEntryId, "ledgerEntryId") : null,
  };
}

export function videoGenerationQuoteDigest(quote: VideoGenerationQuoteSnapshot): string {
  return crypto.createHash("sha256").update(JSON.stringify(quote)).digest("hex");
}
