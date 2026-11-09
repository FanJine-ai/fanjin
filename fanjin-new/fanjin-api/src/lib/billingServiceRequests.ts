/**
 * Identity and read adapter for billing service requests.
 *
 * Finance lifecycle transitions live exclusively in
 * billingServiceRequestFinance.ts. The legacy update entry point remains only
 * so old routes fail closed with an explicit, audited error until the central
 * route/RBAC package supplies canonical commands and verified contexts.
 */

import crypto from "node:crypto";
import { offlineCreditedAmountMicros, offlineConversionProofMatches } from "./offlinePaymentConversion";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { BillingError } from "@/lib/billing";
import {
  DEFAULT_COMMERCIAL_TENANT_ID,
  runtimeCommercialTenantById,
} from "@/lib/commercialTenant";
import {
  BillingServiceRequestFinanceError,
  billingServiceRequestFinanceSchema,
  issueServiceRequestFinance,
  recoverServiceRequestFinance,
  reviewServiceRequest,
  type VerifiedFinanceStepUpContextV1,
} from "@/lib/billingServiceRequestFinance";
import {
  legacyServiceRequestStatuses,
  serviceRequestContractVersion,
  serviceRequestTypes,
  type LegacyServiceRequestStatus,
  type ServiceRequestFinanceIssueCommandV1,
  type ServiceRequestFinanceResultV1,
  type ServiceRequestLifecycleReadProjectionV1,
  type ServiceRequestPayloadV1,
  type ServiceRequestRecordV1,
  type ServiceRequestReviewCommandV1,
  type ServiceRequestType,
} from "@/lib/sharedTypes";
import { db } from "@/utils/db";

type Row = Record<string, any>;

export const billingServiceRequestTypes = serviceRequestTypes;
export const billingServiceRequestStatuses = legacyServiceRequestStatuses;
export type BillingServiceRequestType = ServiceRequestType;
export type BillingServiceRequestStatus = LegacyServiceRequestStatus;

export class BillingServiceRequestAdapterError extends BillingError {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    status: number,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, status);
    this.name = "BillingServiceRequestAdapterError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Correct v1 create contract. Workspace and submitter are deliberately absent:
 * both come from `VerifiedServiceRequestSubmitterV1`.
 */
export interface CreateBillingServiceRequestV1Input {
  payload: ServiceRequestPayloadV1;
  submissionEvidenceId: string;
  idempotencyKey: string;
  /** Server-derived seller identity; omitted only by legacy internal callers. */
  sellerTenantId?: string | null;
  subjectName?: string | null;
  taxId?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  note?: string | null;
}

export interface VerifiedServiceRequestSubmitterV1 {
  verificationSource: "central_identity_middleware/v2";
  userId: number;
  sessionId: string;
  authorizationRevision: number;
  canonicalWorkspaceId: string;
  requestFingerprint: string;
  workspaceFingerprint: string;
  authenticatedAt: number;
  expiresAt: number;
}

/**
 * Legacy shape retained for source compatibility only. Calling create without
 * a separate verified identity context always fails closed.
 */
export interface BillingServiceRequestInput {
  workspaceId: string;
  sellerTenantId?: string | null;
  type: BillingServiceRequestType;
  amountMicros: number;
  currency?: string | null;
  subjectName?: string | null;
  taxId?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  note?: string | null;
  submittedByUserId?: number | null;
}

export interface BillingServiceRequestListInput {
  workspaceId?: string | null;
  type?: BillingServiceRequestType | null;
  status?: BillingServiceRequestStatus | null;
  pageNum?: number;
  pageSize?: number;
}

/**
 * Deprecated legacy mutation shape. It never performs a transition.
 */
export interface BillingServiceRequestUpdateInput {
  id: string;
  status: BillingServiceRequestStatus;
  reviewNote?: string | null;
  reviewedByUserId?: number | null;
}

export interface BillingServiceRequestReadEnvelopeV1 {
  id: string;
  workspaceId: string;
  sellerTenantId: string;
  type: ServiceRequestType | null;
  status: string;
  amountMicros: number;
  currency: string;
  subjectName: string | null;
  taxId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  note: string | null;
  reviewNote: string | null;
  submittedByUserId: number | null;
  reviewedByUserId: number | null;
  reviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
  revision: number | null;
  compatibility: ServiceRequestLifecycleReadProjectionV1;
  record: ServiceRequestRecordV1 | null;
}

export interface BillingServiceRequestAdapterRepository {
  readSession(sessionId: string): Promise<Row | null>;
  readUser(userId: number): Promise<Row | null>;
  readWorkspace(workspaceId: string): Promise<Row | null>;
  readMembership(workspaceId: string, userId: number): Promise<Row | null>;
  findSubmission(userId: number, idempotencyKey: string): Promise<Row | null>;
  insertRequest(row: Row): Promise<void>;
  insertAudit(row: Row): Promise<void>;
}

export interface BillingServiceRequestAdapterDependencies {
  now(): number;
  randomId(): string;
  hash(value: unknown): string;
  assertCreateSchema(): Promise<void>;
  transaction<T>(
    handler: (repository: BillingServiceRequestAdapterRepository) => Promise<T>,
  ): Promise<T>;
  listRows(input: BillingServiceRequestListInput): Promise<{
    rows: Row[];
    total: number;
    pageNum: number;
    pageSize: number;
  }>;
  readRow(requestId: string): Promise<Row | null>;
  insertDeniedMutationAudit(row: Row): Promise<void>;
  finance: {
    review: typeof reviewServiceRequest;
    issue: typeof issueServiceRequestFinance;
    recover: typeof recoverServiceRequestFinance;
  };
}

export const billingServiceRequestAdapterSchema = {
  minimumPostgresVersion: 160000,
  tables: {
    o_user: ["id", "role", "status", "authorizationRevision"],
    o_user_session: [
      "id",
      "userId",
      "workspaceId",
      "expiresAt",
      "revokedAt",
    ],
    o_workspace: ["id", "ownerUserId", "status"],
    o_workspace_member: ["id", "workspaceId", "userId", "status"],
    o_billing_service_request: [
      "id",
      "workspaceId",
      "sellerTenantId",
      "contractVersion",
      "compatibilityStatus",
      "type",
      "payload",
      "status",
      "decision",
      "financeState",
      "financeResult",
      "amountMicros",
      "currency",
      "subjectName",
      "taxId",
      "contactName",
      "contactEmail",
      "contactPhone",
      "note",
      "submittedByUserId",
      "submissionEvidenceId",
      "submissionIdempotencyKey",
      "submissionPayloadHash",
      "reviewedByUserId",
      "reviewNote",
      "reviewEvidenceId",
      "reviewedAt",
      "revision",
      "createdAt",
      "updatedAt",
    ],
    o_billing_audit_log: [
      "id",
      "workspaceId",
      "requestId",
      "action",
      "actorUserId",
      "actorRole",
      "authorizationRevision",
      "authMethod",
      "scope",
      "proofRecordId",
      "requestFingerprint",
      "resourceFingerprint",
      "evidenceId",
      "idempotencyKey",
      "previousState",
      "newState",
      "metadata",
      "createdAt",
    ],
  },
  primaryKeys: {
    o_user: ["id"],
    o_user_session: ["id"],
    o_workspace: ["id"],
    // Membership rows retain their stable legacy identity. Workspace/user
    // authority is enforced by the exact unique tuple below, not by rewriting
    // the released primary-key contract.
    o_workspace_member: ["id"],
    o_billing_service_request: ["id"],
    o_billing_audit_log: ["id"],
  },
  indexes: [
    {
      name: "o_workspace_member_workspaceid_userid_unique",
      table: "o_workspace_member",
      unique: true,
      columns: ["workspaceId", "userId"],
      predicate: null,
    },
    {
      name: "uq_billing_service_request_submission_idempotency",
      table: "o_billing_service_request",
      unique: true,
      columns: ["submittedByUserId", "submissionIdempotencyKey"],
      predicate: null,
    },
  ],
  constraints: [billingServiceRequestFinanceSchema.constraints[0]],
} as const;

function adapterError(
  code: string,
  message: string,
  status: number,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new BillingServiceRequestAdapterError(code, message, status, details);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function serviceRequestSubmissionFingerprint(
  input: CreateBillingServiceRequestV1Input,
  canonicalWorkspaceId: string,
): string {
  return sha256({
    contractVersion: serviceRequestContractVersion,
    canonicalWorkspaceId,
    input,
  });
}

export function serviceRequestWorkspaceFingerprint(workspaceId: string): string {
  return sha256({
    resourceType: "workspace",
    resourceId: workspaceId,
  });
}

function cleanText(value?: string | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

async function sellerTenantIdOf(input: { sellerTenantId?: string | null }): Promise<string> {
  const tenant = await runtimeCommercialTenantById(
    db,
    cleanText(input.sellerTenantId) || DEFAULT_COMMERCIAL_TENANT_ID,
  );
  return tenant.id;
}

function parseObject(value: unknown): Row | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : null;
  } catch {
    return null;
  }
}

function positiveSafeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function strictPositiveSafeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function strictNonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function hasExactKeys(value: Row, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function normalizePayload(input: CreateBillingServiceRequestV1Input): {
  payload: ServiceRequestPayloadV1;
  type: ServiceRequestType;
  amountMicros: number;
  currency: "CNY" | "GU";
} {
  const payload = input?.payload as any;
  if (!payload || !serviceRequestTypes.includes(payload.type)) {
    return adapterError("SERVICE_REQUEST_TYPE_INVALID", "service request payload.type 无效", 400);
  }
  if (payload.type === "invoice") {
    const amountMicros = strictPositiveSafeInteger(payload.invoiceAmountMicros);
    if (
      !amountMicros ||
      payload.invoiceCurrency !== "CNY" ||
      !cleanText(payload.invoiceProfileHash)
    ) {
      return adapterError(
        "SERVICE_REQUEST_INVOICE_PAYLOAD_INVALID",
        "invoice payload 金额、币种或 profile evidence 无效",
        400,
      );
    }
    return {
      payload: {
        type: "invoice",
        invoiceAmountMicros: amountMicros,
        invoiceCurrency: "CNY",
        invoiceProfileHash: String(payload.invoiceProfileHash).trim(),
      },
      type: "invoice",
      amountMicros,
      currency: "CNY",
    };
  }
  if (payload.type === "offline_payment") {
    const amountMicros = strictPositiveSafeInteger(payload.paidAmountMicros);
    if (
      !amountMicros ||
      payload.paidCurrency !== "CNY" ||
      !cleanText(payload.paymentEvidenceId)
    ) {
      return adapterError(
        "SERVICE_REQUEST_PAYMENT_PAYLOAD_INVALID",
        "offline-payment payload 金额、币种或 payment evidence 无效",
        400,
      );
    }
    return {
      payload: {
        type: "offline_payment",
        paidAmountMicros: amountMicros,
        paidCurrency: "CNY",
        paymentEvidenceId: String(payload.paymentEvidenceId).trim(),
      },
      type: "offline_payment",
      amountMicros,
      currency: "CNY",
    };
  }
  const amountMicros = strictPositiveSafeInteger(payload.requestedCreditLimitMicros);
  if (!amountMicros || payload.currency !== "GU" || !cleanText(payload.reason)) {
    return adapterError(
      "SERVICE_REQUEST_CREDIT_PAYLOAD_INVALID",
      "credit-limit payload 金额、币种或 reason 无效",
      400,
    );
  }
  return {
    payload: {
      type: "credit_limit",
      requestedCreditLimitMicros: amountMicros,
      currency: "GU",
      reason: String(payload.reason).trim(),
    },
    type: "credit_limit",
    amountMicros,
    currency: "GU",
  };
}

function assertCreateInput(
  input: CreateBillingServiceRequestV1Input,
  identity: VerifiedServiceRequestSubmitterV1 | undefined,
  timestamp: number,
): asserts identity is VerifiedServiceRequestSubmitterV1 {
  if (identity?.verificationSource !== "central_identity_middleware/v2") {
    adapterError(
      "SERVICE_REQUEST_TRUSTED_IDENTITY_REQUIRED",
      "创建 service request 必须提供中央 identity middleware v2 的验证上下文",
      401,
    );
  }
  if (
    !strictPositiveSafeInteger(identity.userId) ||
    !cleanText(identity.sessionId) ||
    !cleanText(identity.canonicalWorkspaceId) ||
    !Number.isSafeInteger(identity.authorizationRevision) ||
    identity.authorizationRevision < 1
  ) {
    adapterError("SERVICE_REQUEST_IDENTITY_INVALID", "submitter identity 绑定无效", 401);
  }
  if (
    !Number.isSafeInteger(identity.authenticatedAt) ||
    identity.authenticatedAt <= 0 ||
    identity.authenticatedAt > timestamp ||
    !Number.isSafeInteger(identity.expiresAt) ||
    identity.expiresAt <= timestamp
  ) {
    adapterError("SERVICE_REQUEST_IDENTITY_EXPIRED", "submitter identity 已过期", 401);
  }
  if (
    identity.requestFingerprint !==
      serviceRequestSubmissionFingerprint(input, identity.canonicalWorkspaceId) ||
    identity.workspaceFingerprint !==
      serviceRequestWorkspaceFingerprint(identity.canonicalWorkspaceId)
  ) {
    adapterError(
      "SERVICE_REQUEST_IDENTITY_BINDING_MISMATCH",
      "submitter identity 与 request/workspace fingerprint 不匹配",
      403,
    );
  }
  if (!cleanText(input.submissionEvidenceId) || !cleanText(input.idempotencyKey)) {
    adapterError(
      "SERVICE_REQUEST_SUBMISSION_EVIDENCE_REQUIRED",
      "submissionEvidenceId 和 idempotencyKey 不能为空",
      400,
    );
  }
}

function nativeFinanceResultMatches(
  type: ServiceRequestType,
  amountMicros: number,
  result: Row | null,
): boolean {
  if (!result) return true;
  if (!cleanText(result.financeOperationId)) return false;
  if (type === "invoice") {
    return (
      result.kind === "invoice_issued" &&
      hasExactKeys(result, [
        "kind",
        "financeOperationId",
        "invoiceBatchId",
        "documentAmountMicros",
        "documentCurrency",
      ]) &&
      !!cleanText(result.invoiceBatchId) &&
      result.documentCurrency === "CNY" &&
      strictPositiveSafeInteger(result.documentAmountMicros) === amountMicros
    );
  }
  if (type === "offline_payment") {
    const creditedAmountMicros =
      offlineCreditedAmountMicros(amountMicros);
    return (
      result.kind === "offline_payment_credited" &&
      hasExactKeys(result, [
        "kind",
        "financeOperationId",
        "incomeRecordId",
        "targetOwnerUserId",
        "ownerWalletLedgerId",
        "workspaceProjectionLedgerId",
        "tenderAmountMicros",
        "tenderCurrency",
        "creditedAmountMicros",
        "creditedCurrency",
        "conversionPolicyVersion",
        "conversionSnapshotHash",
      ]) &&
      !!cleanText(result.incomeRecordId) &&
      !!cleanText(result.ownerWalletLedgerId) &&
      !!cleanText(result.workspaceProjectionLedgerId) &&
      !!strictPositiveSafeInteger(result.targetOwnerUserId) &&
      result.tenderCurrency === "CNY" &&
      strictPositiveSafeInteger(result.tenderAmountMicros) === amountMicros &&
      creditedAmountMicros !== null &&
      strictPositiveSafeInteger(result.creditedAmountMicros) ===
        creditedAmountMicros &&
      result.creditedCurrency === "GU" &&
      offlineConversionProofMatches(
        result.conversionPolicyVersion, result.conversionSnapshotHash,
        amountMicros, creditedAmountMicros,
      )
    );
  }
  return (
    result.kind === "credit_limit_applied" &&
    hasExactKeys(result, [
      "kind",
      "financeOperationId",
      "targetOwnerUserId",
      "ownerWalletLedgerId",
      "workspaceProjectionLedgerId",
      "previousLimitMicros",
      "newLimitMicros",
      "currency",
    ]) &&
    !!cleanText(result.ownerWalletLedgerId) &&
    !!cleanText(result.workspaceProjectionLedgerId) &&
    !!strictPositiveSafeInteger(result.targetOwnerUserId) &&
    strictNonNegativeSafeInteger(result.previousLimitMicros) !== null &&
    strictPositiveSafeInteger(result.newLimitMicros) === amountMicros &&
    result.currency === "GU"
  );
}

function nativeLifecycle(row: Row): {
  record: ServiceRequestRecordV1;
  compatibility: ServiceRequestLifecycleReadProjectionV1;
} {
  const payload = parseObject(row.payload);
  const financeResult = parseObject(row.financeResult) as ServiceRequestFinanceResultV1 | null;
  const hasStoredFinanceResult =
    row.financeResult != null && row.financeResult !== "";
  const type = String(row.type) as ServiceRequestType;
  const decision = String(row.decision);
  const financeState = String(row.financeState);
  const status = String(row.status);
  const amountMicros = positiveSafeInteger(row.amountMicros);
  const revision = nonNegativeSafeInteger(row.revision);
  const submitterUserId = positiveSafeInteger(row.submittedByUserId);
  const reviewedByUserId =
    row.reviewedByUserId == null ? null : positiveSafeInteger(row.reviewedByUserId);
  const reviewedAt = row.reviewedAt == null ? null : positiveSafeInteger(row.reviewedAt);
  const payloadMatches =
    !!payload &&
    payload.type === type &&
    ((type === "invoice" &&
      row.currency === "CNY" &&
      payload.invoiceCurrency === "CNY" &&
      strictPositiveSafeInteger(payload.invoiceAmountMicros) === amountMicros &&
      !!cleanText(payload.invoiceProfileHash)) ||
      (type === "offline_payment" &&
        row.currency === "CNY" &&
        payload.paidCurrency === "CNY" &&
        strictPositiveSafeInteger(payload.paidAmountMicros) === amountMicros &&
        !!cleanText(payload.paymentEvidenceId)) ||
      (type === "credit_limit" &&
        row.currency === "GU" &&
        payload.currency === "GU" &&
        strictPositiveSafeInteger(payload.requestedCreditLimitMicros) ===
          amountMicros &&
        !!cleanText(payload.reason)));
  const resultMatches =
    !!amountMicros &&
    serviceRequestTypes.includes(type) &&
    (!hasStoredFinanceResult ||
      (!!financeResult &&
        nativeFinanceResultMatches(type, amountMicros, financeResult)));
  const reviewEvidenceId = cleanText(row.reviewEvidenceId);
  const lifecycleValid =
    (decision === "pending" &&
      financeState === "not_started" &&
      status === "pending" &&
      !financeResult &&
      reviewedByUserId === null &&
      reviewedAt === null &&
      row.reviewEvidenceId == null &&
      row.reviewNote == null) ||
    (decision === "approved" &&
      ["not_started", "processing", "failed_retryable", "manual_required"].includes(
        financeState,
      ) &&
      status === "pending" &&
      !financeResult &&
      !!reviewedByUserId &&
      !!reviewedAt &&
      !!reviewEvidenceId &&
      row.reviewNote == null) ||
    (decision === "approved" &&
      financeState === "succeeded" &&
      ((type === "invoice" && status === "issued") ||
        (type !== "invoice" && status === "approved")) &&
      !!financeResult &&
      !!reviewedByUserId &&
      !!reviewedAt &&
      !!reviewEvidenceId &&
      row.reviewNote == null) ||
    (["rejected", "cancelled"].includes(decision) &&
      financeState === "not_applicable" &&
      status === decision &&
      !financeResult &&
      !!reviewedByUserId &&
      !!reviewedAt &&
      !!reviewEvidenceId &&
      !!cleanText(row.reviewNote));
  if (
    row.contractVersion !== serviceRequestContractVersion ||
    row.compatibilityStatus !== "native_v1" ||
    !serviceRequestTypes.includes(type) ||
    !amountMicros ||
    !submitterUserId ||
    revision === null ||
    !payloadMatches ||
    !resultMatches ||
    !lifecycleValid
  ) {
    return adapterError(
      "SERVICE_REQUEST_NATIVE_ROW_INVALID",
      "native_v1 service request 持久化 contract/lifecycle 无效",
      500,
      { requestId: String(row.id || "") },
    );
  }
  const lifecycle = {
    compatibilityStatus: "native_v1" as const,
    decision,
    financeState,
  } as any;
  const record = {
    contractVersion: serviceRequestContractVersion,
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    compatibilityStatus: "native_v1",
    type,
    status,
    decision,
    financeState,
    financeResult,
    amountMicros,
    currency: String(row.currency),
    subjectName: row.subjectName ?? null,
    taxId: row.taxId ?? null,
    contactName: row.contactName ?? null,
    contactEmail: row.contactEmail ?? null,
    contactPhone: row.contactPhone ?? null,
    note: row.note ?? null,
    submittedByUserId: submitterUserId,
    reviewedByUserId,
    reviewNote: row.reviewNote ?? null,
    reviewedAt,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  } as ServiceRequestRecordV1;
  return {
    record,
    compatibility: {
      compatibilityStatus: "native_v1",
      lifecycle,
      financeMutationAllowed:
        decision === "pending" ||
        (decision === "approved" &&
          ["not_started", "failed_retryable"].includes(financeState)),
      warningCode: null,
    },
  };
}

function legacyLifecycle(row: Row): ServiceRequestLifecycleReadProjectionV1 {
  const type = String(row.type);
  const status = String(row.status);
  const amount = Number(row.amountMicros);
  const currency = String(row.currency || (type === "credit_limit" ? "GU" : "CNY"));
  const explicitlyInconsistent =
    row.compatibilityStatus === "legacy_inconsistent" ||
    (row.compatibilityStatus === "native_v1" &&
      row.contractVersion !== serviceRequestContractVersion) ||
    (row.compatibilityStatus != null &&
      !["legacy_unverified", "legacy_verified", "legacy_inconsistent", "native_v1"].includes(
        String(row.compatibilityStatus),
      ));
  const structurallyConsistent =
    !explicitlyInconsistent &&
    serviceRequestTypes.includes(type as ServiceRequestType) &&
    legacyServiceRequestStatuses.includes(status as LegacyServiceRequestStatus) &&
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    currency === (type === "credit_limit" ? "GU" : "CNY") &&
    (status !== "issued" || type === "invoice");
  if (!structurallyConsistent) {
    return {
      compatibilityStatus: "legacy_inconsistent",
      lifecycle: null,
      financeMutationAllowed: false,
      warningCode: "SERVICE_REQUEST_LEGACY_INCONSISTENT",
    };
  }
  const decision =
    status === "rejected"
      ? "rejected"
      : status === "cancelled"
        ? "cancelled"
        : status === "pending"
          ? "pending"
          : "approved";
  const financeState =
    decision === "pending"
      ? "not_started"
      : decision === "approved"
        ? "manual_required"
        : "not_applicable";
  const compatibilityStatus =
    row.compatibilityStatus === "legacy_verified"
      ? ("legacy_verified" as const)
      : ("legacy_unverified" as const);
  return {
    compatibilityStatus,
    lifecycle: {
      compatibilityStatus,
      decision,
      financeState,
    } as any,
    financeMutationAllowed: false,
    warningCode: null,
  };
}

function normalizeReadRow(row: Row): BillingServiceRequestReadEnvelopeV1 {
  const isNative =
    row.contractVersion === serviceRequestContractVersion &&
    row.compatibilityStatus === "native_v1";
  const native = isNative ? nativeLifecycle(row) : null;
  const compatibility = native?.compatibility || legacyLifecycle(row);
  const type = serviceRequestTypes.includes(String(row.type) as ServiceRequestType)
    ? (String(row.type) as ServiceRequestType)
    : null;
  return {
    id: String(row.id || ""),
    workspaceId: String(row.workspaceId || ""),
    sellerTenantId: String(row.sellerTenantId || DEFAULT_COMMERCIAL_TENANT_ID),
    type,
    status: String(row.status || ""),
    amountMicros: Number(row.amountMicros || 0),
    currency: String(row.currency || (type === "credit_limit" ? "GU" : "CNY")),
    subjectName: row.subjectName ?? null,
    taxId: row.taxId ?? null,
    contactName: row.contactName ?? null,
    contactEmail: row.contactEmail ?? null,
    contactPhone: row.contactPhone ?? null,
    note: row.note ?? null,
    reviewNote: row.reviewNote ?? null,
    submittedByUserId:
      row.submittedByUserId == null ? null : Number(row.submittedByUserId),
    reviewedByUserId:
      row.reviewedByUserId == null ? null : Number(row.reviewedByUserId),
    reviewedAt: row.reviewedAt == null ? null : Number(row.reviewedAt),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    revision: nonNegativeSafeInteger(row.revision),
    compatibility,
    record: native?.record || null,
  };
}

function translateFinanceError(error: unknown): never {
  if (error instanceof BillingServiceRequestFinanceError) {
    return adapterError(error.code, error.message, error.status, {
      source: "billingServiceRequestFinance",
    });
  }
  throw error;
}

export function createBillingServiceRequestAdapter(
  dependencies: BillingServiceRequestAdapterDependencies,
) {
  async function createV1(
    input: CreateBillingServiceRequestV1Input | BillingServiceRequestInput,
    identity?: VerifiedServiceRequestSubmitterV1,
  ): Promise<BillingServiceRequestReadEnvelopeV1> {
    const timestamp = dependencies.now();
    if (!("payload" in input)) {
      return adapterError(
        "SERVICE_REQUEST_V1_CREATE_CONTRACT_REQUIRED",
        "legacy create contract 已禁用；必须传 canonical payload 与 verified identity",
        409,
        { centralRouteChangeRequired: true },
      );
    }
    assertCreateInput(input, identity, timestamp);
    const normalized = normalizePayload(input);
    const sellerTenantId = await sellerTenantIdOf(input);
    await dependencies.assertCreateSchema();
    const submissionPayloadHash = dependencies.hash({
      contractVersion: serviceRequestContractVersion,
      workspaceId: identity.canonicalWorkspaceId,
      sellerTenantId,
      submittedByUserId: identity.userId,
      input: {
        payload: normalized.payload,
        sellerTenantId,
        submissionEvidenceId: input.submissionEvidenceId.trim(),
        subjectName: cleanText(input.subjectName),
        taxId: cleanText(input.taxId),
        contactName: cleanText(input.contactName),
        contactEmail: cleanText(input.contactEmail),
        contactPhone: cleanText(input.contactPhone),
        note: cleanText(input.note),
      },
    });
    return await dependencies.transaction(async (repository) => {
      // Match the global mutation lock order: workspace before identity rows.
      const workspace = await repository.readWorkspace(identity.canonicalWorkspaceId);
      const session = await repository.readSession(identity.sessionId);
      const user = await repository.readUser(identity.userId);
      const membership = await repository.readMembership(
        identity.canonicalWorkspaceId,
        identity.userId,
      );
      if (
        !session ||
        Number(session.userId) !== identity.userId ||
        String(session.workspaceId || "") !== identity.canonicalWorkspaceId ||
        session.revokedAt != null ||
        Number(session.expiresAt || 0) <= timestamp
      ) {
        return adapterError(
          "SERVICE_REQUEST_SESSION_INVALID",
          "submitter session 与 canonical workspace 不匹配或已失效",
          401,
        );
      }
      if (
        !user ||
        String(user.status) !== "active" ||
        Number(user.authorizationRevision) !== identity.authorizationRevision
      ) {
        return adapterError(
          "SERVICE_REQUEST_SUBMITTER_REVOKED",
          "submitter 已停用或 authorization revision 已变化",
          403,
        );
      }
      if (!workspace || String(workspace.status) !== "active") {
        return adapterError(
          "SERVICE_REQUEST_WORKSPACE_INVALID",
          "canonical workspace 不存在或不可用",
          409,
        );
      }
      const isOwner = Number(workspace.ownerUserId) === identity.userId;
      const isActiveMember =
        !!membership &&
        Number(membership.userId) === identity.userId &&
        String(membership.workspaceId) === identity.canonicalWorkspaceId &&
        String(membership.status) === "active";
      if (!isOwner && !isActiveMember) {
        return adapterError(
          "SERVICE_REQUEST_WORKSPACE_MEMBERSHIP_REQUIRED",
          "submitter 不是 canonical workspace 的 active member/owner",
          403,
        );
      }

      const existing = await repository.findSubmission(
        identity.userId,
        input.idempotencyKey.trim(),
      );
      if (existing) {
        if (
          String(existing.workspaceId) !== identity.canonicalWorkspaceId ||
          String(existing.submissionPayloadHash) !== submissionPayloadHash
        ) {
          return adapterError(
            "SERVICE_REQUEST_IDEMPOTENCY_CONFLICT",
            "submission idempotency key 已被不同 payload 使用",
            409,
          );
        }
        return normalizeReadRow(existing);
      }

      const requestId = dependencies.randomId();
      const row = {
        id: requestId,
        workspaceId: identity.canonicalWorkspaceId,
        sellerTenantId,
        contractVersion: serviceRequestContractVersion,
        compatibilityStatus: "native_v1",
        type: normalized.type,
        payload: stableJson(normalized.payload),
        status: "pending",
        decision: "pending",
        financeState: "not_started",
        financeResult: null,
        amountMicros: normalized.amountMicros,
        currency: normalized.currency,
        subjectName: cleanText(input.subjectName),
        taxId: cleanText(input.taxId),
        contactName: cleanText(input.contactName),
        contactEmail: cleanText(input.contactEmail),
        contactPhone: cleanText(input.contactPhone),
        note: cleanText(input.note),
        submittedByUserId: identity.userId,
        submissionEvidenceId: input.submissionEvidenceId.trim(),
        submissionIdempotencyKey: input.idempotencyKey.trim(),
        submissionPayloadHash,
        reviewedByUserId: null,
        reviewNote: null,
        reviewEvidenceId: null,
        reviewedAt: null,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await repository.insertRequest(row);
      await repository.insertAudit({
        id: dependencies.randomId(),
        workspaceId: identity.canonicalWorkspaceId,
        requestId,
        action: "service_request.submitted",
        actorUserId: identity.userId,
        actorRole: String(user.role || "user"),
        authorizationRevision: identity.authorizationRevision,
        authMethod: "session",
        scope: "billing.service_request.create",
        proofRecordId: identity.sessionId,
        requestFingerprint: identity.requestFingerprint,
        resourceFingerprint: identity.workspaceFingerprint,
        evidenceId: input.submissionEvidenceId.trim(),
        idempotencyKey: input.idempotencyKey.trim(),
        previousState: null,
        newState: stableJson({
          decision: "pending",
          financeState: "not_started",
          revision: 0,
        }),
        metadata: stableJson({
          contractVersion: serviceRequestContractVersion,
          sellerTenantId,
          submissionPayloadHash,
        }),
        createdAt: timestamp,
      });
      return normalizeReadRow(row);
    });
  }

  async function list(
    input: BillingServiceRequestListInput = {},
  ): Promise<{
    items: BillingServiceRequestReadEnvelopeV1[];
    total: number;
    pageNum: number;
    pageSize: number;
  }> {
    if (input.type && !serviceRequestTypes.includes(input.type)) {
      return adapterError("SERVICE_REQUEST_TYPE_INVALID", "申请类型无效", 400);
    }
    if (input.status && !legacyServiceRequestStatuses.includes(input.status)) {
      return adapterError("SERVICE_REQUEST_STATUS_INVALID", "申请状态无效", 400);
    }
    const result = await dependencies.listRows(input);
    return {
      items: result.rows.map(normalizeReadRow),
      total: result.total,
      pageNum: result.pageNum,
      pageSize: result.pageSize,
    };
  }

  async function review(
    command: ServiceRequestReviewCommandV1,
    context: VerifiedFinanceStepUpContextV1,
  ) {
    try {
      return await dependencies.finance.review(command, context);
    } catch (error) {
      return translateFinanceError(error);
    }
  }

  async function issue(
    command: ServiceRequestFinanceIssueCommandV1,
    context: VerifiedFinanceStepUpContextV1,
  ) {
    try {
      return await dependencies.finance.issue(command, context);
    } catch (error) {
      return translateFinanceError(error);
    }
  }

  async function recover(
    requestId: string,
    expectedRevision: number,
    idempotencyKey: string,
    recoveryEvidenceId: string,
    context: VerifiedFinanceStepUpContextV1,
  ) {
    try {
      return await dependencies.finance.recover(
        requestId,
        expectedRevision,
        idempotencyKey,
        recoveryEvidenceId,
        context,
      );
    } catch (error) {
      return translateFinanceError(error);
    }
  }

  /**
   * Compatibility-only endpoint. It never calls Finance core because the
   * legacy shape lacks evidence, expected revision, idempotency and step-up.
   */
  async function denyLegacyUpdate(
    input: BillingServiceRequestUpdateInput,
  ): Promise<BillingServiceRequestReadEnvelopeV1> {
    const requestId = cleanText(input?.id);
    if (!requestId) {
      return adapterError("SERVICE_REQUEST_ID_REQUIRED", "service request id 不能为空", 400);
    }
    const row = await dependencies.readRow(requestId);
    if (!row) return adapterError("SERVICE_REQUEST_NOT_FOUND", "财务申请不存在", 404);
    const read = normalizeReadRow(row);
    const timestamp = dependencies.now();
    try {
      await dependencies.insertDeniedMutationAudit({
        id: dependencies.randomId(),
        workspaceId: read.workspaceId,
        requestId: read.id,
        action: "service_request.legacy_mutation_denied",
        actorUserId: null,
        actorRole: null,
        authorizationRevision: null,
        authMethod: null,
        scope: null,
        proofRecordId: null,
        requestFingerprint: null,
        resourceFingerprint: null,
        evidenceId: null,
        idempotencyKey: null,
        previousState: stableJson({
          status: read.status,
          compatibilityStatus: read.compatibility.compatibilityStatus,
        }),
        newState: null,
        metadata: stableJson({
          attemptedStatus: input.status,
          reason:
            "missing canonical command/evidence/revision/idempotency/verified-step-up",
          centralRouteChangeRequired: true,
        }),
        createdAt: timestamp,
      });
    } catch {
      return adapterError(
        "SERVICE_REQUEST_DENIAL_AUDIT_FAILED",
        "legacy mutation 已拒绝，但拒绝审计写入失败",
        503,
        { requestId },
      );
    }
    if (read.compatibility.compatibilityStatus !== "native_v1") {
      return adapterError(
        "SERVICE_REQUEST_LEGACY_FINANCE_FORBIDDEN",
        "legacy/unverified service request 不得进入 v1 Finance mutation",
        409,
        {
          requestId,
          compatibilityStatus: read.compatibility.compatibilityStatus,
          auditWritten: true,
        },
      );
    }
    return adapterError(
      "SERVICE_REQUEST_V1_MUTATION_CONTEXT_REQUIRED",
      "必须使用 canonical review/issue API，并提供 evidence、revision、idempotency 与 verified step-up",
      409,
      { requestId, auditWritten: true, centralRouteChangeRequired: true },
    );
  }

  return {
    create: createV1,
    list,
    review,
    issue,
    recover,
    denyLegacyUpdate,
  };
}

function normalizeSqlDefinition(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export async function assertPostgres16ServiceRequestAdapterSchema(
  database: Knex = db as unknown as Knex,
): Promise<void> {
  const configuredClient = String((database as any)?.client?.config?.client || "");
  if (!configuredClient.includes("pg")) {
    return adapterError(
      "SERVICE_REQUEST_POSTGRES_16_REQUIRED",
      "service-request.v1 create 只允许 PostgreSQL 16+",
      503,
    );
  }
  let versionNumber = 0;
  try {
    const versionResult: any = await database.raw("SHOW server_version_num");
    versionNumber = Number(versionResult?.rows?.[0]?.server_version_num || 0);
  } catch {
    return adapterError(
      "SERVICE_REQUEST_POSTGRES_VERSION_UNVERIFIED",
      "无法验证 PostgreSQL server_version_num",
      503,
    );
  }
  if (versionNumber < billingServiceRequestAdapterSchema.minimumPostgresVersion) {
    return adapterError(
      "SERVICE_REQUEST_POSTGRES_16_REQUIRED",
      "service-request.v1 create 要求 PostgreSQL 16+",
      503,
    );
  }

  const tableNames = Object.keys(billingServiceRequestAdapterSchema.tables);
  const catalogResult: any = await database.raw(
    `select cls.relname as "tableName", att.attname as "columnName"
       from pg_catalog.pg_class cls
       join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
       join pg_catalog.pg_attribute att on att.attrelid = cls.oid
      where nsp.nspname = current_schema()
        and cls.relkind in ('r', 'p')
        and cls.relname = any(?::text[])
        and att.attnum > 0
        and not att.attisdropped`,
    [tableNames],
  );
  const catalog = new Map<string, Set<string>>();
  for (const row of catalogResult?.rows || []) {
    const tableName = String(row.tableName);
    const columns = catalog.get(tableName) || new Set<string>();
    columns.add(String(row.columnName));
    catalog.set(tableName, columns);
  }
  for (const [tableName, columns] of Object.entries(
    billingServiceRequestAdapterSchema.tables,
  )) {
    const storedColumns = catalog.get(tableName);
    if (!storedColumns) {
      return adapterError(
        "SERVICE_REQUEST_SCHEMA_MISSING",
        `缺少 service-request.v1 表 ${tableName}`,
        503,
      );
    }
    for (const column of columns) {
      if (!storedColumns.has(column)) {
        return adapterError(
          "SERVICE_REQUEST_SCHEMA_MISSING",
          `缺少 service-request.v1 列 ${tableName}.${column}`,
          503,
        );
      }
    }
  }

  const primaryKeyResult: any = await database.raw(
    `select tbl.relname as "tableName",
            array_agg(att.attname::text order by key_column.ordinality)::text[] as columns
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class tbl on tbl.oid = con.conrelid
       join pg_catalog.pg_namespace nsp on nsp.oid = tbl.relnamespace
       join lateral unnest(con.conkey) with ordinality key_column(attnum, ordinality)
         on true
       join pg_catalog.pg_attribute att
         on att.attrelid = tbl.oid and att.attnum = key_column.attnum
      where nsp.nspname = current_schema()
        and con.contype = 'p'
        and tbl.relname = any(?::text[])
      group by tbl.relname`,
    [tableNames],
  );
  const primaryKeys = new Map<string, string[]>();
  for (const row of primaryKeyResult?.rows || []) {
    primaryKeys.set(
      String(row.tableName),
      Array.isArray(row.columns) ? row.columns.map(String) : [],
    );
  }
  for (const [tableName, expectedColumns] of Object.entries(
    billingServiceRequestAdapterSchema.primaryKeys,
  )) {
    if (
      stableJson(primaryKeys.get(tableName) || []) !==
      stableJson(expectedColumns)
    ) {
      return adapterError(
        "SERVICE_REQUEST_SCHEMA_PRIMARY_KEY_DRIFT",
        `service-request.v1 primary key 定义不匹配 ${tableName}`,
        503,
      );
    }
  }

  const indexNames = billingServiceRequestAdapterSchema.indexes.map((index) => index.name);
  const indexResult: any = await database.raw(
    `select idx.relname as "indexName",
            tbl.relname as "tableName",
            ind.indisunique as "isUnique",
            ind.indisvalid as "isValid",
            ind.indisready as "isReady",
            array(
              select pg_get_indexdef(ind.indexrelid, ordinal, true)
                from generate_series(1, ind.indnkeyatts) ordinal
               order by ordinal
            ) as columns,
            pg_get_expr(ind.indpred, ind.indrelid, true) as predicate
       from pg_catalog.pg_index ind
       join pg_catalog.pg_class idx on idx.oid = ind.indexrelid
       join pg_catalog.pg_class tbl on tbl.oid = ind.indrelid
       join pg_catalog.pg_namespace nsp on nsp.oid = tbl.relnamespace
      where nsp.nspname = current_schema()
        and idx.relname = any(?::text[])`,
    [indexNames],
  );
  const indexes = new Map<string, Row>();
  for (const row of indexResult?.rows || []) {
    indexes.set(String(row.indexName), row);
  }
  for (const expected of billingServiceRequestAdapterSchema.indexes) {
    const actual = indexes.get(expected.name);
    const actualColumns = Array.isArray(actual?.columns)
      ? actual.columns.map((column: unknown) => String(column).replaceAll('"', ""))
      : [];
    if (
      !actual ||
      String(actual.tableName) !== expected.table ||
      Boolean(actual.isUnique) !== expected.unique ||
      actual.isValid !== true ||
      actual.isReady !== true ||
      stableJson(actualColumns) !== stableJson(expected.columns) ||
      normalizeSqlDefinition(actual.predicate) !== normalizeSqlDefinition(expected.predicate)
    ) {
      return adapterError(
        "SERVICE_REQUEST_SCHEMA_INDEX_DRIFT",
        `service-request.v1 index 定义不匹配 ${expected.name}`,
        503,
      );
    }
  }

  const constraintNames = billingServiceRequestAdapterSchema.constraints.map(
    (constraint) => constraint.name,
  );
  const constraintResult: any = await database.raw(
    `select con.conname as "constraintName",
            tbl.relname as "tableName",
            con.contype as "constraintType",
            con.convalidated as "isValidated",
            pg_get_constraintdef(con.oid, true) as definition
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class tbl on tbl.oid = con.conrelid
       join pg_catalog.pg_namespace nsp on nsp.oid = tbl.relnamespace
      where nsp.nspname = current_schema()
        and con.conname = any(?::text[])`,
    [constraintNames],
  );
  const constraints = new Map<string, Row>();
  for (const row of constraintResult?.rows || []) {
    constraints.set(String(row.constraintName), row);
  }
  for (const expected of billingServiceRequestAdapterSchema.constraints) {
    const actual = constraints.get(expected.name);
    if (
      !actual ||
      String(actual.tableName) !== expected.table ||
      actual.constraintType !== "c" ||
      actual.isValidated !== true ||
      normalizeSqlDefinition(actual.definition) !== normalizeSqlDefinition(expected.definition)
    ) {
      return adapterError(
        "SERVICE_REQUEST_SCHEMA_CONSTRAINT_DRIFT",
        `service-request.v1 constraint 定义不匹配 ${expected.name}`,
        503,
      );
    }
  }
}

class KnexAdapterRepository implements BillingServiceRequestAdapterRepository {
  constructor(private readonly trx: Knex.Transaction) {}

  async readSession(sessionId: string): Promise<Row | null> {
    return (
      (await this.trx("o_user_session").where({ id: sessionId }).forShare().first()) || null
    );
  }

  async readUser(userId: number): Promise<Row | null> {
    return (await this.trx("o_user").where({ id: userId }).forUpdate().first()) || null;
  }

  async readWorkspace(workspaceId: string): Promise<Row | null> {
    return (
      (await this.trx("o_workspace").where({ id: workspaceId }).forShare().first()) || null
    );
  }

  async readMembership(workspaceId: string, userId: number): Promise<Row | null> {
    return (
      (await this.trx("o_workspace_member")
        .where({ workspaceId, userId })
        .forShare()
        .first()) || null
    );
  }

  async findSubmission(userId: number, idempotencyKey: string): Promise<Row | null> {
    return (
      (await this.trx("o_billing_service_request")
        .where({
          submittedByUserId: userId,
          submissionIdempotencyKey: idempotencyKey,
        })
        .forUpdate()
        .first()) || null
    );
  }

  async insertRequest(row: Row): Promise<void> {
    await this.trx("o_billing_service_request").insert(row);
  }

  async insertAudit(row: Row): Promise<void> {
    await this.trx("o_billing_audit_log").insert(row);
  }
}

function applyListFilters(query: Knex.QueryBuilder, input: BillingServiceRequestListInput) {
  if (input.workspaceId) query.where("workspaceId", input.workspaceId);
  if (input.type) query.where("type", input.type);
  if (input.status) query.where("status", input.status);
  return query;
}

export function createPostgresBillingServiceRequestAdapterDependencies(
  database: Knex,
  overrides: Partial<
    Pick<BillingServiceRequestAdapterDependencies, "now" | "randomId" | "hash">
  > & {
    finance?: BillingServiceRequestAdapterDependencies["finance"];
  } = {},
): BillingServiceRequestAdapterDependencies {
  return {
    now: overrides.now || (() => Date.now()),
    randomId: overrides.randomId || (() => uuid()),
    hash: overrides.hash || sha256,
    assertCreateSchema: async () =>
      await assertPostgres16ServiceRequestAdapterSchema(database),
    async transaction<T>(
      handler: (repository: BillingServiceRequestAdapterRepository) => Promise<T>,
    ): Promise<T> {
      return await database.transaction(
        async (trx) => await handler(new KnexAdapterRepository(trx)),
      );
    },
    async listRows(input) {
      const pageNum = Math.max(1, Math.trunc(Number(input.pageNum || 1)));
      const pageSize = Math.max(1, Math.min(Number(input.pageSize || 50), 200));
      if (!Number.isSafeInteger(pageNum) || !Number.isSafeInteger((pageNum - 1) * pageSize)) return adapterError("SERVICE_REQUEST_PAGE_INVALID", "页码无效", 400);
      const query = applyListFilters(database("o_billing_service_request"), input);
      const countRow = await query.clone().count({ total: "*" }).first();
      const rows = await query
        .clone()
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(pageSize)
        .offset((pageNum - 1) * pageSize);
      return {
        rows,
        total: Number((countRow as any)?.total || 0),
        pageNum,
        pageSize,
      };
    },
    async readRow(requestId) {
      return (
        (await database("o_billing_service_request").where({ id: requestId }).first()) ||
        null
      );
    },
    async insertDeniedMutationAudit(row) {
      await database("o_billing_audit_log").insert(row);
    },
    finance:
      overrides.finance || {
        review: reviewServiceRequest,
        issue: issueServiceRequestFinance,
        recover: recoverServiceRequestFinance,
      },
  };
}

const defaultDependencies = createPostgresBillingServiceRequestAdapterDependencies(
  db as unknown as Knex,
);

const defaultAdapter = createBillingServiceRequestAdapter(defaultDependencies);

export async function createBillingServiceRequest(
  input: CreateBillingServiceRequestV1Input,
  identity: VerifiedServiceRequestSubmitterV1,
): Promise<BillingServiceRequestReadEnvelopeV1>;
export async function createBillingServiceRequest(
  input: BillingServiceRequestInput,
): Promise<BillingServiceRequestReadEnvelopeV1>;
export async function createBillingServiceRequest(
  input: CreateBillingServiceRequestV1Input | BillingServiceRequestInput,
  identity?: VerifiedServiceRequestSubmitterV1,
): Promise<BillingServiceRequestReadEnvelopeV1> {
  return await defaultAdapter.create(input, identity);
}

export async function listBillingServiceRequests(
  input: BillingServiceRequestListInput = {},
) {
  return await defaultAdapter.list(input);
}

export async function reviewBillingServiceRequestV1(
  command: ServiceRequestReviewCommandV1,
  context: VerifiedFinanceStepUpContextV1,
) {
  return await defaultAdapter.review(command, context);
}

export async function issueBillingServiceRequestFinanceV1(
  command: ServiceRequestFinanceIssueCommandV1,
  context: VerifiedFinanceStepUpContextV1,
) {
  return await defaultAdapter.issue(command, context);
}

export async function recoverBillingServiceRequestFinanceV1(
  requestId: string,
  expectedRevision: number,
  idempotencyKey: string,
  recoveryEvidenceId: string,
  context: VerifiedFinanceStepUpContextV1,
) {
  return await defaultAdapter.recover(
    requestId,
    expectedRevision,
    idempotencyKey,
    recoveryEvidenceId,
    context,
  );
}

export async function updateBillingServiceRequest(
  input: BillingServiceRequestUpdateInput,
): Promise<BillingServiceRequestReadEnvelopeV1> {
  return await defaultAdapter.denyLegacyUpdate(input);
}
