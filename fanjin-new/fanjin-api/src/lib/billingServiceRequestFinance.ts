/**
 * Transactional finance runtime for the canonical service-request.v1 contract.
 *
 * This module intentionally does not migrate or repair schema. The required
 * PostgreSQL 16 schema is asserted before every operation and a missing column,
 * index, or constraint fails closed. See `billingServiceRequestFinanceSchema`
 * for the exact central migration contract.
 */

import crypto from "node:crypto";
import { offlineCreditedAmountMicros, offlineConversionPolicyVersion, offlineConversionSnapshotHash, offlineConversionProofMatches } from "./offlinePaymentConversion";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { applyAccountWalletCredit, ensureAccountWallet } from "@/lib/accountWallet";
import {
  allocateAccountWalletToWorkspaceInTransaction,
  applySetCreditLimit,
} from "@/lib/billing";
import {
  type LockedServiceRequestFinanceAuthorityV1,
  type PersistedServiceRequestFinanceIntentV1,
  type ServiceRequestFinanceIssueCommandV1,
  type ServiceRequestFinanceIssueOutcomeV1,
  type ServiceRequestFinanceResultV1,
  type ServiceRequestFinanceStateV1,
  type ServiceRequestPayloadV1,
  type ServiceRequestRecordV1,
  type ServiceRequestReviewCommandV1,
  type ServiceRequestType,
  serviceRequestContractVersion,
} from "@/lib/sharedTypes";
import { db } from "@/utils/db";

import { ADMIN_MACHINE_OPERATION_TYPE } from "@/lib/adminMachineIdentity";
import { validateAdminMachineCredential } from "@/lib/adminMachineCredentials";

type FinanceOperation =
  | "service_request_review"
  | "service_request_issue"
  | "service_request_recover";

type Row = Record<string, any>;

const REVIEW_SCOPE = "admin.billing.service_request";
const ISSUE_SCOPE = "admin.finance.case";
const STEP_UP_BINDING_VERSION = "finance-step-up/v1";
const WORKER_BINDING_VERSION = "finance-worker/v1";
const HASH_VERSION = "jcs-sha256/v1";
const COMMAND_IDEMPOTENCY_CONSTRAINT =
  "uq_billing_service_request_command_operation_idempotency";

export class BillingServiceRequestFinanceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "BillingServiceRequestFinanceError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Constructed only by central human step-up or scoped machine authorization.
 * Runtime checks compare the persisted authorization record and the current
 * actor authorization revision on every call, including idempotent replay.
 */
export interface VerifiedFinanceStepUpContextV1 {
  verificationSource: "central_step_up_middleware/v2" | "admin_machine_credential/v1";
  machineCredentialId?: string;
  proofRecordId: string;
  actorUserId: number;
  actorRole: string;
  authorizationRevision: number;
  method: "password" | "totp" | "recovery" | "machine";
  scope: typeof REVIEW_SCOPE | typeof ISSUE_SCOPE;
  operation: FinanceOperation;
  requestId: string;
  requestFingerprint: string;
  resourceType: "billing_service_request";
  resourceId: string;
  resourceFingerprint: string;
  expiresAt: number;
  consumedAt: number;
}

export interface VerifiedFinanceWorkerContextV1 {
  verificationSource: "finance_worker_registry/v1";
  credentialRecordId: string;
  workerId: string;
  operation: "service_request_watchdog";
  expiresAt: number;
}

export interface FinanceWatchdogLeaseV1 {
  leaseId: string;
  requestId: string;
  acquiredAt: number;
  expiresAt: number;
  workerId: string;
  replayed: boolean;
}

export interface FinanceRuntimeRepository {
  lockWorkspace(workspaceId: string): Promise<Row | null>;
  lockRequest(requestId: string): Promise<Row | null>;
  refreshRequest(requestId: string): Promise<Row | null>;
  lockActor(actorUserId: number): Promise<Row | null>;
  lockStepUpProof(proofRecordId: string): Promise<Row | null>;
  findCommand(operation: FinanceOperation, idempotencyKey: string): Promise<Row | null>;
  insertCommand(row: Row): Promise<void>;
  findIntent(operation: "service_request_issue", idempotencyKey: string): Promise<Row | null>;
  findIntentByRequest(requestId: string): Promise<Row | null>;
  insertIntent(row: Row): Promise<void>;
  updateIntent(financeOperationId: string, patch: Row): Promise<boolean>;
  compareAndSetRequest(requestId: string, expectedRevision: number, patch: Row): Promise<boolean>;
  insertOutbox(row: Row): Promise<void>;
  insertAudit(row: Row): Promise<void>;
  executeFinanceEffect(
    authority: LockedServiceRequestFinanceAuthorityV1,
    intent: PersistedServiceRequestFinanceIntentV1,
    actorUserId: number,
    workspaceOwnerUserId: number,
  ): Promise<
    | { state: "succeeded"; result: ServiceRequestFinanceResultV1 }
    | { state: "manual_required"; reason: string }
    | { state: "failed_retryable"; reason: string }
  >;
  verifyFinanceResult(
    requestId: string,
    financeOperationId: string,
    result: ServiceRequestFinanceResultV1,
    authority: DurableFinanceResultAuthorityV1,
  ): Promise<boolean>;
  lockWorkerCredential(credentialRecordId: string): Promise<Row | null>;
  lockWatchdogLease(requestId: string): Promise<Row | null>;
  insertWatchdogLease(row: Row): Promise<void>;
  replaceWatchdogLease(leaseId: string, expectedExpiresAt: number, patch: Row): Promise<boolean>;
}

export interface DurableFinanceResultAuthorityV1 {
  workspaceId: string;
  requestType: ServiceRequestType;
  paymentEvidenceId: string | null;
  expectedExecutionActorUserId: number | null;
}

export interface FinanceRuntimeDependencies {
  now(): number;
  randomId(): string;
  hash(value: unknown): string;
  assertSchema(): Promise<void>;
  readWorkspaceHint(requestId: string): Promise<string | null>;
  transaction<T>(handler: (repository: FinanceRuntimeRepository) => Promise<T>): Promise<T>;
}

/**
 * Exact contract for the central Schema CR. Names are fixed so runtime can
 * prove the uniqueness and lock assumptions rather than merely hope for them.
 */
const nativeServiceRequestLifecycleCheck =
  "CHECK (NOT (COALESCE(\"contractVersion\" = 'service-request.v1'::text, false) OR COALESCE(\"compatibilityStatus\" = 'native_v1'::text, false)) OR \"contractVersion\" = 'service-request.v1'::text AND \"compatibilityStatus\" = 'native_v1'::text AND type IS NOT NULL AND status IS NOT NULL AND decision IS NOT NULL AND \"financeState\" IS NOT NULL AND revision IS NOT NULL AND revision >= 0 AND revision <= '9007199254740991'::bigint AND \"submittedByUserId\" IS NOT NULL AND \"submittedByUserId\" > 0 AND \"submittedByUserId\" <= '9007199254740991'::bigint AND (type = ANY (ARRAY['invoice'::text, 'offline_payment'::text, 'credit_limit'::text])) AND (decision = 'pending'::text AND \"financeState\" = 'not_started'::text AND status = 'pending'::text AND \"financeResult\" IS NULL AND \"reviewedByUserId\" IS NULL AND \"reviewEvidenceId\" IS NULL AND \"reviewedAt\" IS NULL AND \"reviewNote\" IS NULL OR decision = 'approved'::text AND (\"financeState\" = ANY (ARRAY['not_started'::text, 'processing'::text, 'failed_retryable'::text, 'manual_required'::text])) AND status = 'pending'::text AND \"financeResult\" IS NULL AND \"reviewedByUserId\" IS NOT NULL AND \"reviewedByUserId\" > 0 AND \"reviewedByUserId\" <= '9007199254740991'::bigint AND \"reviewEvidenceId\" IS NOT NULL AND btrim(\"reviewEvidenceId\") <> ''::text AND \"reviewedAt\" IS NOT NULL AND \"reviewedAt\" > 0 AND \"reviewedAt\" <= '9007199254740991'::bigint AND \"reviewNote\" IS NULL OR decision = 'approved'::text AND \"financeState\" = 'succeeded'::text AND (type = 'invoice'::text AND status = 'issued'::text OR type <> 'invoice'::text AND status = 'approved'::text) AND \"financeResult\" IS NOT NULL AND \"reviewedByUserId\" IS NOT NULL AND \"reviewedByUserId\" > 0 AND \"reviewedByUserId\" <= '9007199254740991'::bigint AND \"reviewEvidenceId\" IS NOT NULL AND btrim(\"reviewEvidenceId\") <> ''::text AND \"reviewedAt\" IS NOT NULL AND \"reviewedAt\" > 0 AND \"reviewedAt\" <= '9007199254740991'::bigint AND \"reviewNote\" IS NULL OR decision = 'rejected'::text AND \"financeState\" = 'not_applicable'::text AND status = 'rejected'::text AND \"financeResult\" IS NULL AND \"reviewedByUserId\" IS NOT NULL AND \"reviewedByUserId\" > 0 AND \"reviewedByUserId\" <= '9007199254740991'::bigint AND \"reviewEvidenceId\" IS NOT NULL AND btrim(\"reviewEvidenceId\") <> ''::text AND \"reviewedAt\" IS NOT NULL AND \"reviewedAt\" > 0 AND \"reviewedAt\" <= '9007199254740991'::bigint AND \"reviewNote\" IS NOT NULL AND btrim(\"reviewNote\") <> ''::text OR decision = 'cancelled'::text AND \"financeState\" = 'not_applicable'::text AND status = 'cancelled'::text AND \"financeResult\" IS NULL AND \"reviewedByUserId\" IS NOT NULL AND \"reviewedByUserId\" > 0 AND \"reviewedByUserId\" <= '9007199254740991'::bigint AND \"reviewEvidenceId\" IS NOT NULL AND btrim(\"reviewEvidenceId\") <> ''::text AND \"reviewedAt\" IS NOT NULL AND \"reviewedAt\" > 0 AND \"reviewedAt\" <= '9007199254740991'::bigint AND \"reviewNote\" IS NOT NULL AND btrim(\"reviewNote\") <> ''::text))";

export const billingServiceRequestFinanceSchema = {
  minimumPostgresVersion: 160000,
  tables: {
    o_workspace: ["id", "ownerUserId", "status"],
    o_user: ["id", "role", "status", "authorizationRevision"],
    o_auth_token: [
      "id",
      "userId",
      "workspaceId",
      "type",
      "metadata",
      "expiresAt",
      "usedAt",
      "revokedAt",
    ],
    o_billing_service_request: [
      "id",
      "workspaceId",
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
      "reviewedByUserId",
      "reviewNote",
      "reviewEvidenceId",
      "reviewedAt",
      "revision",
      "createdAt",
      "updatedAt",
    ],
    o_billing_service_request_command: [
      "id",
      "operation",
      "requestId",
      "workspaceId",
      "idempotencyKey",
      "commandHash",
      "proofRecordId",
      "outcome",
      "outcomeRevision",
      "createdAt",
    ],
    o_billing_finance_intent: [
      "id",
      "operation",
      "requestId",
      "workspaceId",
      "requestType",
      "idempotencyKey",
      "commandHash",
      "payloadHashVersion",
      "payloadHash",
      "lockedRevision",
      "durableAuditIntentId",
      "outboxIds",
      "status",
      "financeResult",
      "errorMessage",
      "committedAt",
      "createdAt",
      "updatedAt",
    ],
    o_billing_outbox: [
      "id",
      "aggregateType",
      "aggregateId",
      "eventType",
      "payload",
      "status",
      "availableAt",
      "attempts",
      "leaseOwner",
      "leaseExpiresAt",
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
    o_billing_watchdog_lease: [
      "id",
      "requestId",
      "workerId",
      "credentialRecordId",
      "acquiredAt",
      "expiresAt",
      "revision",
      "updatedAt",
    ],
    o_billing_finance_worker: [
      "id",
      "workerId",
      "bindingVersion",
      "status",
      "expiresAt",
      "revokedAt",
    ],
    o_account_wallet: [
      "id",
      "userId",
      "currency",
      "balanceMicros",
      "giftBalanceMicros",
      "cashReservedMicros",
      "giftReservedMicros",
      "creditLimitMicros",
      "creditUsedMicros",
      "creditReservedMicros",
      "status",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
    o_account_wallet_ledger: [
      "id",
      "walletId",
      "userId",
      "workspaceId",
      "workspaceLedgerId",
      "serviceRequestId",
      "incomeRecordId",
      "type",
      "direction",
      "amountMicros",
      "currency",
      "balanceBeforeMicros",
      "balanceAfterMicros",
      "requestId",
      "idempotencyKey",
      "description",
      "metadata",
      "operatorUserId",
      "createdAt",
      "updatedAt",
    ],
    o_billing_account: [
      "id",
      "workspaceId",
      "planId",
      "currency",
      "balanceMicros",
      "creditLimitMicros",
      "reservedMicros",
      "status",
      "billingMode",
      "createdAt",
      "updatedAt",
    ],
    o_billing_ledger: [
      "id",
      "accountId",
      "workspaceId",
      "type",
      "direction",
      "status",
      "amountMicros",
      "remainingMicros",
      "currency",
      "balanceBefore",
      "balanceAfter",
      "reservedBefore",
      "reservedAfter",
      "requestId",
      "idempotencyKey",
      "description",
      "metadata",
      "createdBy",
      "createdAt",
      "updatedAt",
    ],
    o_finance_income_record: [
      "id",
      "workspaceId",
      "ledgerId",
      "serviceRequestId",
      "channel",
      "method",
      "status",
      "amountMicros",
      "currency",
      "description",
      "metadata",
      "operatorUserId",
      "paymentTime",
      "confirmedAt",
      "idempotencyKey",
      "createdAt",
      "updatedAt",
    ],
  },
  indexes: [
    {
      name: COMMAND_IDEMPOTENCY_CONSTRAINT,
      table: "o_billing_service_request_command",
      unique: true,
      columns: ["operation", "idempotencyKey"],
      predicate: null,
    },
    {
      name: "uq_billing_finance_intent_operation_idempotency",
      table: "o_billing_finance_intent",
      unique: true,
      columns: ["operation", "idempotencyKey"],
      predicate: null,
    },
    {
      name: "uq_billing_finance_intent_request",
      table: "o_billing_finance_intent",
      unique: true,
      columns: ["requestId"],
      predicate: null,
    },
    {
      name: "uq_billing_watchdog_lease_request",
      table: "o_billing_watchdog_lease",
      unique: true,
      columns: ["requestId"],
      predicate: null,
    },
    {
      name: "idx_billing_outbox_status_available",
      table: "o_billing_outbox",
      unique: false,
      columns: ["status", "availableAt"],
      predicate: null,
    },
    {
      name: "idx_billing_service_request_workspace_revision",
      table: "o_billing_service_request",
      unique: false,
      columns: ["workspaceId", "revision"],
      predicate: null,
    },
    {
      name: "idx_o_account_wallet_ledger_idempotency",
      table: "o_account_wallet_ledger",
      unique: true,
      columns: ["userId", "type", "idempotencyKey"],
      predicate: "\"idempotencyKey\" IS NOT NULL",
    },
    {
      name: "idx_o_account_wallet_user",
      table: "o_account_wallet",
      unique: true,
      columns: ["userId"],
      predicate: null,
    },
    {
      name: "idx_o_billing_account_workspace",
      table: "o_billing_account",
      unique: true,
      columns: ["workspaceId"],
      predicate: null,
    },
    {
      name: "idx_o_billing_ledger_idempotency",
      table: "o_billing_ledger",
      unique: true,
      columns: ["workspaceId", "type", "idempotencyKey"],
      predicate: "\"idempotencyKey\" IS NOT NULL",
    },
    {
      name: "idx_o_finance_income_idempotency",
      table: "o_finance_income_record",
      unique: true,
      columns: ["idempotencyKey"],
      predicate: "\"idempotencyKey\" IS NOT NULL",
    },
  ],
  constraints: [
    {
      name: "ck_billing_service_request_native_lifecycle",
      table: "o_billing_service_request",
      definition: nativeServiceRequestLifecycleCheck,
    },
    {
      name: "ck_billing_finance_intent_terminal_result",
      table: "o_billing_finance_intent",
      definition:
        "CHECK (status IS NOT NULL AND COALESCE(status = 'succeeded'::text AND \"financeResult\" IS NOT NULL AND \"errorMessage\" IS NULL OR (status = ANY (ARRAY['manual_required'::text, 'failed_retryable'::text])) AND \"financeResult\" IS NULL AND \"errorMessage\" IS NOT NULL OR (status = ANY (ARRAY['persisted'::text, 'processing'::text])) AND \"financeResult\" IS NULL AND \"errorMessage\" IS NULL, false))",
    },
  ],
} as const;

function financeError(code: string, message: string, status = 409): never {
  throw new BillingServiceRequestFinanceError(code, message, status);
}

function stableJson(value: unknown): string {
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

function canonicalStringArray(value: unknown): string | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => !nonEmpty(entry))
  ) {
    return null;
  }
  return stableJson(parsed);
}

function safeDeltaMatches(after: unknown, before: unknown, expected: unknown): boolean {
  const safeAfter = nonNegativeSafeInteger(after);
  const safeBefore = nonNegativeSafeInteger(before);
  const safeExpected = nonNegativeSafeInteger(expected);
  return (
    safeAfter !== null &&
    safeBefore !== null &&
    safeExpected !== null &&
    BigInt(safeAfter) - BigInt(safeBefore) === BigInt(safeExpected)
  );
}

export function financeStepUpRequestFingerprint(value: unknown): string {
  return sha256({ bindingVersion: STEP_UP_BINDING_VERSION, request: value });
}

export function financeStepUpResourceFingerprint(requestId: string): string {
  return sha256({
    bindingVersion: STEP_UP_BINDING_VERSION,
    resourceType: "billing_service_request",
    resourceId: requestId,
  });
}

function parseObject(value: unknown, code = "FINANCE_STORED_JSON_INVALID"): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value !== "string" || !value) financeError(code, "持久化 JSON 缺失或格式错误", 500);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    return financeError(code, "持久化 JSON 缺失或格式错误", 500);
  }
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveSafeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function assertCommandBasics(
  command: ServiceRequestReviewCommandV1 | ServiceRequestFinanceIssueCommandV1,
): void {
  if (!nonEmpty(command.requestId)) financeError("FINANCE_REQUEST_ID_REQUIRED", "requestId 不能为空", 400);
  if (!nonEmpty(command.idempotencyKey)) {
    financeError("FINANCE_IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey 不能为空", 400);
  }
  if (strictNonNegativeSafeInteger(command.expectedRevision) === null) {
    financeError("FINANCE_REVISION_INVALID", "expectedRevision 必须是非负安全整数", 400);
  }
}

function expectedScope(operation: FinanceOperation): string {
  return operation === "service_request_review" ? REVIEW_SCOPE : ISSUE_SCOPE;
}

function assertContextShape(
  context: VerifiedFinanceStepUpContextV1,
  operation: FinanceOperation,
  requestId: string,
  fingerprintInput: unknown,
  timestamp: number,
): void {
  if (!["central_step_up_middleware/v2", "admin_machine_credential/v1"].includes(context?.verificationSource)) {
    financeError("FINANCE_STEP_UP_UNTRUSTED", "仅接受中央身份验证层签发的操作上下文", 401);
  }
  if (
    !nonEmpty(context.proofRecordId) ||
    !strictPositiveSafeInteger(context.actorUserId) ||
    !nonEmpty(context.actorRole) ||
    !strictPositiveSafeInteger(context.authorizationRevision)
  ) {
    financeError("FINANCE_STEP_UP_INVALID_ACTOR", "step-up proof 或 actor 绑定无效", 401);
  }
  if (context.verificationSource === "admin_machine_credential/v1"
    ? context.method !== "machine" || !nonEmpty(context.machineCredentialId)
    : !["password", "totp", "recovery"].includes(context.method)) {
    financeError("FINANCE_STEP_UP_INVALID_METHOD", "step-up method 无效", 401);
  }
  if (
    context.operation !== operation ||
    context.scope !== expectedScope(operation) ||
    context.requestId !== requestId
  ) {
    financeError("FINANCE_STEP_UP_BINDING_MISMATCH", "step-up operation/scope/request 绑定不匹配", 403);
  }
  if (
    context.resourceType !== "billing_service_request" ||
    context.resourceId !== requestId ||
    context.resourceFingerprint !== financeStepUpResourceFingerprint(requestId)
  ) {
    financeError("FINANCE_STEP_UP_RESOURCE_MISMATCH", "step-up resource 绑定不匹配", 403);
  }
  if (context.requestFingerprint !== financeStepUpRequestFingerprint(fingerprintInput)) {
    financeError("FINANCE_STEP_UP_REQUEST_MISMATCH", "step-up request fingerprint 不匹配", 403);
  }
  if (
    strictPositiveSafeInteger(context.expiresAt) === 0 ||
    context.expiresAt <= timestamp ||
    strictPositiveSafeInteger(context.consumedAt) === 0 ||
    context.consumedAt > timestamp ||
    context.consumedAt > context.expiresAt
  ) {
    financeError("FINANCE_STEP_UP_EXPIRED_OR_UNCONSUMED", "step-up proof 已过期或未被中央层消费", 401);
  }
}

async function assertStoredContext(
  repository: FinanceRuntimeRepository,
  context: VerifiedFinanceStepUpContextV1,
  workspaceId: string,
  timestamp: number,
): Promise<void> {
  // Keep the actor -> proof lock order deterministic. Holding both row locks
  // until commit makes authorization/proof revocation serialize with every
  // mutation and replay instead of racing after a plain SELECT.
  const actor = await repository.lockActor(context.actorUserId);
  const machine = context.verificationSource === "admin_machine_credential/v1";
  const key = machine ? await repository.lockStepUpProof(context.machineCredentialId!) : null;
  const proof = await repository.lockStepUpProof(context.proofRecordId);
  if (!proof || String(proof.type) !== (machine ? ADMIN_MACHINE_OPERATION_TYPE : "step_up_proof")) {
    financeError("FINANCE_STEP_UP_PROOF_NOT_FOUND", "step-up proof record 不存在", 401);
  }
  if (
    Number(proof.userId) !== context.actorUserId ||
    (proof.workspaceId != null && String(proof.workspaceId) !== workspaceId) ||
    Number(proof.expiresAt) !== context.expiresAt ||
    Number(proof.usedAt) !== context.consumedAt ||
    proof.revokedAt != null
  ) {
    financeError("FINANCE_STEP_UP_PROOF_REVOKED", "step-up proof 已撤销或持久化绑定不匹配", 401);
  }
  const metadata = parseObject(proof.metadata, "FINANCE_STEP_UP_METADATA_INVALID");
  if (machine) {
    try {
      const live = validateAdminMachineCredential(key, actor, timestamp);
      if (live.id !== metadata.machineCredentialId || live.id !== context.machineCredentialId
        || !Array.isArray(metadata.requiredPermissions) || !metadata.requiredPermissions.length
        || metadata.requiredPermissions.some((permission: string) => !live.permissions.includes(permission))) {
        throw new Error("machine scope mismatch");
      }
    } catch {
      financeError("FINANCE_MACHINE_CREDENTIAL_REVOKED", "机器凭据已撤销或不具备所需权限", 403);
    }
  }
  const bindings: Array<[unknown, unknown]> = [
    [metadata.bindingVersion, STEP_UP_BINDING_VERSION],
    [metadata.scope, context.scope],
    [metadata.method, context.method],
    [metadata.operation, context.operation],
    [metadata.requestId, context.requestId],
    [metadata.requestFingerprint, context.requestFingerprint],
    [metadata.resourceType, context.resourceType],
    [metadata.resourceId, context.resourceId],
    [metadata.resourceFingerprint, context.resourceFingerprint],
    [
      strictPositiveSafeInteger(metadata.authorizationRevision),
      context.authorizationRevision,
    ],
  ];
  if (bindings.some(([actual, expected]) => actual !== expected)) {
    financeError("FINANCE_STEP_UP_PROOF_BINDING_MISMATCH", "step-up proof 的持久化绑定不匹配", 403);
  }
  if (
    !actor ||
    String(actor.status) !== "active" ||
    String(actor.role) !== context.actorRole ||
    Number(actor.authorizationRevision) !== context.authorizationRevision
  ) {
    financeError("FINANCE_ACTOR_AUTHORITY_REVOKED", "actor 权限已撤销或版本已变化", 403);
  }
}

function assertWorkspace(workspace: Row | null, expectedWorkspaceId: string): number {
  if (!workspace || String(workspace.id) !== expectedWorkspaceId || String(workspace.status) !== "active") {
    return financeError("FINANCE_WORKSPACE_NOT_ACTIVE", "工作区不存在或不可用", 409);
  }
  const ownerUserId = positiveSafeInteger(workspace.ownerUserId);
  if (!ownerUserId) {
    return financeError("FINANCE_WORKSPACE_OWNER_REQUIRED", "工作区缺少有效 owner", 409);
  }
  return ownerUserId;
}

function assertNativeStoredRequest(row: Row): void {
  if (
    row.contractVersion !== serviceRequestContractVersion ||
    row.compatibilityStatus !== "native_v1"
  ) {
    financeError(
      "FINANCE_LEGACY_REQUEST_FORBIDDEN",
      "legacy/unverified service request 不得进入 v1 Finance runtime",
      409,
    );
  }
  if (!["invoice", "offline_payment", "credit_limit"].includes(String(row.type))) {
    financeError("FINANCE_REQUEST_TYPE_INVALID", "持久化 request type 无效", 500);
  }
  if (nonNegativeSafeInteger(row.revision) === null) {
    financeError("FINANCE_STORED_REVISION_INVALID", "持久化 revision 无效", 500);
  }
  if (!positiveSafeInteger(row.submittedByUserId)) {
    financeError("FINANCE_SUBMITTER_UNVERIFIED", "持久化 submitter 未验证", 409);
  }
}

function storedPayload(row: Row): ServiceRequestPayloadV1 {
  assertNativeStoredRequest(row);
  const payload = parseObject(row.payload, "FINANCE_STORED_PAYLOAD_INVALID");
  const amount = positiveSafeInteger(row.amountMicros);
  if (!amount) financeError("FINANCE_AMOUNT_INVALID", "持久化金额必须是正整数 micros", 500);
  if (payload.type !== row.type) {
    financeError("FINANCE_STORED_PAYLOAD_MISMATCH", "payload.type 与 request.type 不一致", 500);
  }
  switch (row.type as ServiceRequestType) {
    case "invoice": {
      if (
        row.currency !== "CNY" ||
        payload.invoiceCurrency !== "CNY" ||
        strictPositiveSafeInteger(payload.invoiceAmountMicros) !== amount ||
        !nonEmpty(payload.invoiceProfileHash)
      ) {
        financeError("FINANCE_STORED_PAYLOAD_MISMATCH", "invoice payload 与持久化 authority 不一致", 500);
      }
      return {
        type: "invoice",
        invoiceAmountMicros: amount,
        invoiceCurrency: "CNY",
        invoiceProfileHash: String(payload.invoiceProfileHash),
      };
    }
    case "offline_payment": {
      if (
        row.currency !== "CNY" ||
        payload.paidCurrency !== "CNY" ||
        strictPositiveSafeInteger(payload.paidAmountMicros) !== amount ||
        !nonEmpty(payload.paymentEvidenceId)
      ) {
        financeError("FINANCE_STORED_PAYLOAD_MISMATCH", "offline-payment payload 与持久化 authority 不一致", 500);
      }
      return {
        type: "offline_payment",
        paidAmountMicros: amount,
        paidCurrency: "CNY",
        paymentEvidenceId: String(payload.paymentEvidenceId),
      };
    }
    case "credit_limit": {
      if (
        row.currency !== "GU" ||
        payload.currency !== "GU" ||
        strictPositiveSafeInteger(payload.requestedCreditLimitMicros) !== amount ||
        !nonEmpty(payload.reason)
      ) {
        financeError("FINANCE_STORED_PAYLOAD_MISMATCH", "credit-limit payload 与持久化 authority 不一致", 500);
      }
      return {
        type: "credit_limit",
        requestedCreditLimitMicros: amount,
        currency: "GU",
        reason: String(payload.reason),
      };
    }
  }
}

function parseFinanceResult(row: Row): ServiceRequestFinanceResultV1 | null {
  if (row.financeResult == null || row.financeResult === "") return null;
  const result = parseObject(row.financeResult, "FINANCE_RESULT_INVALID") as ServiceRequestFinanceResultV1;
  const requestAmountMicros = positiveSafeInteger(row.amountMicros);
  const expectedCreditedAmountMicros =
    row.type === "offline_payment"
      ? offlineCreditedAmountMicros(requestAmountMicros)
      : null;
  const expectedKind =
    row.type === "invoice"
      ? "invoice_issued"
      : row.type === "offline_payment"
        ? "offline_payment_credited"
        : "credit_limit_applied";
  if (
    result.kind !== expectedKind ||
    !nonEmpty(result.financeOperationId) ||
    (result.kind === "invoice_issued" &&
      (!hasExactKeys(result, [
        "kind",
        "financeOperationId",
        "invoiceBatchId",
        "documentAmountMicros",
        "documentCurrency",
      ]) ||
        !nonEmpty(result.invoiceBatchId) ||
        result.documentCurrency !== "CNY" ||
        strictPositiveSafeInteger(result.documentAmountMicros) !== requestAmountMicros)) ||
    (result.kind === "offline_payment_credited" &&
      (!hasExactKeys(result, [
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
      ]) ||
        !nonEmpty(result.incomeRecordId) ||
        !nonEmpty(result.ownerWalletLedgerId) ||
        !nonEmpty(result.workspaceProjectionLedgerId) ||
        !strictPositiveSafeInteger(result.targetOwnerUserId) ||
        result.tenderCurrency !== "CNY" ||
        strictPositiveSafeInteger(result.tenderAmountMicros) !== requestAmountMicros ||
        expectedCreditedAmountMicros === null ||
        strictPositiveSafeInteger(result.creditedAmountMicros) !== expectedCreditedAmountMicros ||
        result.creditedCurrency !== "GU" ||
        !offlineConversionProofMatches(
          result.conversionPolicyVersion, result.conversionSnapshotHash,
          requestAmountMicros, expectedCreditedAmountMicros || 0,
        ))) ||
    (result.kind === "credit_limit_applied" &&
      (!hasExactKeys(result, [
        "kind",
        "financeOperationId",
        "targetOwnerUserId",
        "ownerWalletLedgerId",
        "workspaceProjectionLedgerId",
        "previousLimitMicros",
        "newLimitMicros",
        "currency",
      ]) ||
        !nonEmpty(result.ownerWalletLedgerId) ||
        !nonEmpty(result.workspaceProjectionLedgerId) ||
        !strictPositiveSafeInteger(result.targetOwnerUserId) ||
        strictNonNegativeSafeInteger(result.previousLimitMicros) === null ||
        strictPositiveSafeInteger(result.newLimitMicros) !== requestAmountMicros ||
        result.currency !== "GU"))
  ) {
    financeError("FINANCE_RESULT_INVALID", "持久化 financeResult 与 request 不一致", 500);
  }
  return result;
}

function assertLifecycle(row: Row): void {
  const decision = String(row.decision);
  const state = String(row.financeState);
  const status = String(row.status);
  const result = parseFinanceResult(row);
  const reviewedByUserId =
    row.reviewedByUserId == null ? null : positiveSafeInteger(row.reviewedByUserId);
  const reviewedAt = row.reviewedAt == null ? null : positiveSafeInteger(row.reviewedAt);
  const reviewEvidenceId = nonEmpty(row.reviewEvidenceId);
  const pendingReviewFields =
    row.reviewedByUserId == null &&
    row.reviewedAt == null &&
    row.reviewEvidenceId == null &&
    row.reviewNote == null;
  const approvedReviewFields =
    !!reviewedByUserId &&
    !!reviewedAt &&
    !!reviewEvidenceId &&
    row.reviewNote == null;
  const deniedReviewFields =
    !!reviewedByUserId &&
    !!reviewedAt &&
    !!reviewEvidenceId &&
    !!nonEmpty(row.reviewNote);
  const valid =
    (decision === "pending" &&
      state === "not_started" &&
      status === "pending" &&
      result === null &&
      pendingReviewFields) ||
    (decision === "approved" &&
      ["not_started", "processing", "failed_retryable", "manual_required"].includes(state) &&
      status === "pending" &&
      result === null &&
      approvedReviewFields) ||
    (decision === "approved" &&
      state === "succeeded" &&
      ((row.type === "invoice" && status === "issued") ||
        (row.type !== "invoice" && status === "approved")) &&
      result !== null &&
      approvedReviewFields) ||
    (decision === "rejected" &&
      state === "not_applicable" &&
      status === "rejected" &&
      result === null &&
      deniedReviewFields) ||
    (decision === "cancelled" &&
      state === "not_applicable" &&
      status === "cancelled" &&
      result === null &&
      deniedReviewFields);
  if (!valid) financeError("FINANCE_STORED_LIFECYCLE_INVALID", "持久化 lifecycle 组合无效", 500);
}

function toCanonicalRecord(row: Row): ServiceRequestRecordV1 {
  assertNativeStoredRequest(row);
  storedPayload(row);
  assertLifecycle(row);
  return {
    contractVersion: serviceRequestContractVersion,
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    compatibilityStatus: "native_v1",
    type: row.type,
    amountMicros: Number(row.amountMicros),
    currency: row.currency,
    status: row.status,
    decision: row.decision,
    financeState: row.financeState,
    financeResult: parseFinanceResult(row),
    subjectName: row.subjectName ?? null,
    taxId: row.taxId ?? null,
    contactName: row.contactName ?? null,
    contactEmail: row.contactEmail ?? null,
    contactPhone: row.contactPhone ?? null,
    note: row.note ?? null,
    submittedByUserId: row.submittedByUserId == null ? null : Number(row.submittedByUserId),
    reviewedByUserId: row.reviewedByUserId == null ? null : Number(row.reviewedByUserId),
    reviewNote: row.reviewNote ?? null,
    reviewedAt: row.reviewedAt == null ? null : Number(row.reviewedAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  } as ServiceRequestRecordV1;
}

function buildAuthority(row: Row, timestamp: number): LockedServiceRequestFinanceAuthorityV1 {
  assertNativeStoredRequest(row);
  assertLifecycle(row);
  if (
    row.decision !== "approved" ||
    !["not_started", "failed_retryable"].includes(String(row.financeState))
  ) {
    financeError("FINANCE_STORED_AUTHORITY_DENIED", "锁内 lifecycle 不允许执行 Finance", 409);
  }
  const payload = storedPayload(row);
  return {
    authoritySource: "locked_service_request_record",
    requestId: String(row.id),
    workspaceId: String(row.workspaceId),
    decision: "approved",
    financeState: row.financeState,
    compatibilityStatus: "native_v1",
    revision: Number(row.revision),
    lockedAt: timestamp,
    requestType: row.type,
    payload,
  } as LockedServiceRequestFinanceAuthorityV1;
}

function issueOutcome(
  outcome: "executed" | "exact_replay",
  result: ServiceRequestFinanceResultV1,
): ServiceRequestFinanceIssueOutcomeV1 {
  return outcome === "executed"
    ? { outcome, replayed: false, httpStatus: 200, financeResult: result }
    : { outcome, replayed: true, httpStatus: 200, financeResult: result };
}

function conflictOutcome(): ServiceRequestFinanceIssueOutcomeV1 {
  return {
    outcome: "payload_mismatch",
    replayed: false,
    httpStatus: 409,
    code: "BILLING_IDEMPOTENCY_CONFLICT",
    financeResult: null,
  };
}

function manualOutcome(replayed = false): ServiceRequestFinanceIssueOutcomeV1 {
  return {
    outcome: "manual_required",
    replayed,
    httpStatus: 202,
    code: "BILLING_RECONCILIATION_REQUIRED",
    financeResult: null,
  };
}

function isCommandIdempotencyUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown } | null;
  return (
    candidate?.code === "23505" &&
    candidate.constraint === COMMAND_IDEMPOTENCY_CONSTRAINT
  );
}

function intentPersistenceFailed(): ServiceRequestFinanceIssueOutcomeV1 {
  return {
    outcome: "intent_persistence_failed",
    replayed: false,
    httpStatus: 500,
    code: "BILLING_INVARIANT_FAILED",
    externalSideEffectAllowed: false,
    financeResult: null,
  };
}

function outboxRow(
  id: string,
  requestId: string,
  eventType: string,
  payload: unknown,
  timestamp: number,
): Row {
  return {
    id,
    aggregateType: "billing_service_request",
    aggregateId: requestId,
    eventType,
    payload: stableJson(payload),
    status: "pending",
    availableAt: timestamp,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function auditRow(
  id: string,
  request: Row,
  context: VerifiedFinanceStepUpContextV1,
  action: string,
  evidenceId: string | null,
  idempotencyKey: string,
  previousState: unknown,
  newState: unknown,
  metadata: unknown,
  timestamp: number,
): Row {
  return {
    id,
    workspaceId: request.workspaceId,
    requestId: request.id,
    action,
    actorUserId: context.actorUserId,
    actorRole: context.actorRole,
    authorizationRevision: context.authorizationRevision,
    authMethod: context.method,
    scope: context.scope,
    proofRecordId: context.proofRecordId,
    requestFingerprint: context.requestFingerprint,
    resourceFingerprint: context.resourceFingerprint,
    evidenceId,
    idempotencyKey,
    previousState: stableJson(previousState),
    newState: stableJson(newState),
    metadata: stableJson(context.verificationSource === "admin_machine_credential/v1"
      ? { ...(metadata as Record<string, unknown>), verificationSource: context.verificationSource, machineCredentialId: context.machineCredentialId }
      : metadata),
    createdAt: timestamp,
  };
}

async function lockAuthorityRows(
  repository: FinanceRuntimeRepository,
  requestId: string,
  workspaceHint: string,
): Promise<{ request: Row; workspace: Row; ownerUserId: number }> {
  const workspace = await repository.lockWorkspace(workspaceHint);
  const ownerUserId = assertWorkspace(workspace, workspaceHint);
  const request = await repository.lockRequest(requestId);
  if (!request) financeError("FINANCE_REQUEST_NOT_FOUND", "service request 不存在", 404);
  if (String(request.workspaceId) !== workspaceHint) {
    financeError("FINANCE_WORKSPACE_AUTHORITY_CHANGED", "request workspace 在加锁期间发生变化", 409);
  }
  assertNativeStoredRequest(request);
  return { request, workspace: workspace!, ownerUserId };
}

function resultFromIntent(intent: Row): ServiceRequestFinanceResultV1 | null {
  if (!intent.financeResult) return null;
  return parseObject(intent.financeResult, "FINANCE_RESULT_INVALID") as ServiceRequestFinanceResultV1;
}

function assertResultAgainstStoredAuthority(
  result: ServiceRequestFinanceResultV1,
  request: Row,
  financeOperationId: string,
  expectedExecutionOwnerUserId: number | null,
): void {
  const parsedFromRequest = parseFinanceResult({
    ...request,
    financeResult: stableJson(result),
  });
  if (!parsedFromRequest || result.financeOperationId !== financeOperationId) {
    financeError("FINANCE_RESULT_AUTHORITY_MISMATCH", "financeResult operation 绑定不匹配", 500);
  }
  if (
    expectedExecutionOwnerUserId !== null &&
    result.kind !== "invoice_issued" &&
    result.targetOwnerUserId !== expectedExecutionOwnerUserId
  ) {
    financeError(
      "FINANCE_OWNER_AUTHORITY_CHANGED",
      "financeResult target owner 与当前锁内 workspace owner 不一致",
      409,
    );
  }
}

async function assertDurableFinanceResult(
  repository: FinanceRuntimeRepository,
  result: ServiceRequestFinanceResultV1,
  request: Row,
  financeOperationId: string,
  expectedExecutionOwnerUserId: number | null,
  expectedExecutionActorUserId: number | null,
): Promise<void> {
  assertResultAgainstStoredAuthority(
    result,
    request,
    financeOperationId,
    expectedExecutionOwnerUserId,
  );
  const payload = storedPayload(request);
  if (
    !(await repository.verifyFinanceResult(
      String(request.id),
      financeOperationId,
      result,
      {
        workspaceId: String(request.workspaceId),
        requestType: request.type as ServiceRequestType,
        paymentEvidenceId:
          payload.type === "offline_payment" ? payload.paymentEvidenceId : null,
        expectedExecutionActorUserId,
      },
    ))
  ) {
    financeError(
      "FINANCE_RESULT_DURABILITY_MISMATCH",
      "financeResult 与持久化资金凭证不一致",
      500,
    );
  }
}

function assertExactReviewReplay(
  stored: Row | null,
  request: Row,
  command: ServiceRequestReviewCommandV1,
  commandHash: string,
): void {
  const expectedFinanceState =
    command.targetDecision === "approved" ? "not_started" : "not_applicable";
  const outcome = stored
    ? parseObject(stored.outcome, "FINANCE_REVIEW_OUTCOME_INVALID")
    : null;
  if (
    !stored ||
    stored.operation !== "service_request_review" ||
    stored.idempotencyKey !== command.idempotencyKey ||
    stored.requestId !== command.requestId ||
    stored.workspaceId !== request.workspaceId ||
    stored.commandHash !== commandHash ||
    nonNegativeSafeInteger(stored.outcomeRevision) !==
      nonNegativeSafeInteger(request.revision) ||
    !outcome ||
    !hasExactKeys(outcome, ["decision", "financeState"]) ||
    outcome?.decision !== command.targetDecision ||
    outcome?.financeState !== expectedFinanceState ||
    request.decision !== command.targetDecision ||
    request.financeState !== expectedFinanceState ||
    request.reviewEvidenceId !== command.reviewEvidenceId ||
    (request.reviewNote ?? null) !== command.reason
  ) {
    financeError(
      "FINANCE_IDEMPOTENCY_CONFLICT",
      "review idempotency replay 不匹配",
      409,
    );
  }
  assertLifecycle(request);
}

function issuePayloadHash(
  hash: FinanceRuntimeDependencies["hash"],
  request: Row,
): string {
  const payload = storedPayload(request);
  return hash({
    operation: "service_request_issue",
    workspaceId: request.workspaceId,
    requestId: request.id,
    requestType: request.type,
    payload,
  });
}

async function resolveExactIssueReplay(
  repository: FinanceRuntimeRepository,
  stored: Row,
  request: Row,
  command: ServiceRequestFinanceIssueCommandV1,
  commandHash: string,
  payloadHash: string,
): Promise<ServiceRequestFinanceIssueOutcomeV1> {
  if (
    !nonEmpty(stored.id) ||
    stored.operation !== "service_request_issue" ||
    stored.idempotencyKey !== command.idempotencyKey ||
    stored.requestId !== command.requestId ||
    stored.workspaceId !== request.workspaceId ||
    stored.requestType !== request.type ||
    stored.commandHash !== commandHash ||
    stored.payloadHashVersion !== HASH_VERSION ||
    stored.payloadHash !== payloadHash ||
    nonNegativeSafeInteger(stored.lockedRevision) !== command.expectedRevision
  ) {
    return conflictOutcome();
  }

  assertLifecycle(request);
  const result = resultFromIntent(stored);
  const requestResult = parseFinanceResult(request);
  if (result) {
    await assertDurableFinanceResult(
      repository,
      result,
      request,
      String(stored.id),
      null,
      null,
    );
  }
  if (
    stored.status === "succeeded" &&
    request.financeState === "succeeded" &&
    result &&
    requestResult &&
    stableJson(result) === stableJson(requestResult)
  ) {
    return issueOutcome("exact_replay", result);
  }
  if (
    ["manual_required", "failed_retryable", "processing"].includes(
      String(stored.status),
    ) &&
    String(stored.status) === String(request.financeState) &&
    result === null &&
    requestResult === null
  ) {
    return manualOutcome(true);
  }
  financeError(
    "FINANCE_TERMINAL_REPLAY_CONFLICT",
    "Finance replay 与持久化终态不一致",
    409,
  );
}

export function createBillingServiceRequestFinanceRuntime(dependencies: FinanceRuntimeDependencies) {
  async function reviewServiceRequest(
    command: ServiceRequestReviewCommandV1,
    context: VerifiedFinanceStepUpContextV1,
  ): Promise<{ record: ServiceRequestRecordV1; revision: number; replayed: boolean }> {
    if ((command as Row)?.operation !== "service_request_review") {
      financeError("FINANCE_OPERATION_INVALID", "review 入口只接受 service_request_review", 400);
    }
    assertCommandBasics(command);
    if (!nonEmpty(command.reviewEvidenceId)) {
      financeError("FINANCE_REVIEW_EVIDENCE_REQUIRED", "reviewEvidenceId 不能为空", 400);
    }
    if (!["approved", "rejected", "cancelled"].includes(command.targetDecision)) {
      financeError("FINANCE_REVIEW_DECISION_INVALID", "targetDecision 无效", 400);
    }
    if (
      (command.targetDecision === "approved" && command.reason !== null) ||
      (command.targetDecision !== "approved" && !nonEmpty(command.reason))
    ) {
      financeError("FINANCE_REVIEW_REASON_INVALID", "review reason 与 targetDecision 不匹配", 400);
    }
    const startedAt = dependencies.now();
    assertContextShape(context, "service_request_review", command.requestId, command, startedAt);
    await dependencies.assertSchema();
    const workspaceHint = await dependencies.readWorkspaceHint(command.requestId);
    if (!workspaceHint) financeError("FINANCE_REQUEST_NOT_FOUND", "service request 不存在", 404);
    const commandHash = dependencies.hash(command);
    let callbackCompleted = false;
    try {
      return await dependencies.transaction(async (repository) => {
        const { request } = await lockAuthorityRows(
          repository,
          command.requestId,
          workspaceHint,
        );
        await assertStoredContext(repository, context, String(request.workspaceId), dependencies.now());
        const existing = await repository.findCommand(
          "service_request_review",
          command.idempotencyKey,
        );
        if (existing) {
          assertExactReviewReplay(existing, request, command, commandHash);
          callbackCompleted = true;
          return {
            record: toCanonicalRecord(request),
            revision: Number(request.revision),
            replayed: true,
          };
        }
        assertLifecycle(request);
        if (request.decision !== "pending") {
          financeError("FINANCE_TERMINAL_REPLAY_CONFLICT", "request 已进入不同终态", 409);
        }
        if (Number(request.revision) !== command.expectedRevision) {
          financeError("FINANCE_REVISION_CONFLICT", "expectedRevision 与锁内 revision 不匹配", 409);
        }
        const timestamp = dependencies.now();
        const revision = Number(request.revision) + 1;
        const financeState: ServiceRequestFinanceStateV1 =
          command.targetDecision === "approved" ? "not_started" : "not_applicable";
        const status =
          command.targetDecision === "approved" ? "pending" : command.targetDecision;
        await repository.insertCommand({
          id: dependencies.randomId(),
          operation: "service_request_review",
          requestId: command.requestId,
          workspaceId: request.workspaceId,
          idempotencyKey: command.idempotencyKey,
          commandHash,
          proofRecordId: context.proofRecordId,
          outcome: stableJson({ decision: command.targetDecision, financeState }),
          outcomeRevision: revision,
          createdAt: timestamp,
        });
        const updated = await repository.compareAndSetRequest(
          command.requestId,
          command.expectedRevision,
          {
            status,
            decision: command.targetDecision,
            financeState,
            financeResult: null,
            reviewedByUserId: context.actorUserId,
            reviewNote: command.reason,
            reviewEvidenceId: command.reviewEvidenceId,
            reviewedAt: timestamp,
            revision,
            updatedAt: timestamp,
          },
        );
        if (!updated) financeError("FINANCE_REVISION_CONFLICT", "review revision CAS 失败", 409);
        await repository.insertAudit(
          auditRow(
            dependencies.randomId(),
            request,
            context,
            `service_request.review.${command.targetDecision}`,
            command.reviewEvidenceId,
            command.idempotencyKey,
            {
              decision: request.decision,
              financeState: request.financeState,
              revision: Number(request.revision),
            },
            { decision: command.targetDecision, financeState, revision },
            { commandHash },
            timestamp,
          ),
        );
        const refreshed = await repository.refreshRequest(command.requestId);
        if (!refreshed) financeError("FINANCE_REQUEST_NOT_FOUND", "review 后 request 丢失", 500);
        callbackCompleted = true;
        return { record: toCanonicalRecord(refreshed), revision, replayed: false };
      });
    } catch (error) {
      if (
        !callbackCompleted &&
        !isCommandIdempotencyUniqueViolation(error)
      ) {
        throw error;
      }
      return await dependencies.transaction(async (repository) => {
        const { request } = await lockAuthorityRows(
          repository,
          command.requestId,
          workspaceHint,
        );
        await assertStoredContext(repository, context, String(request.workspaceId), dependencies.now());
        const stored = await repository.findCommand(
          "service_request_review",
          command.idempotencyKey,
        );
        assertExactReviewReplay(stored, request, command, commandHash);
        return {
          record: toCanonicalRecord(request),
          revision: Number(request.revision),
          replayed: true,
        };
      });
    }
  }

  async function issueServiceRequestFinance(
    command: ServiceRequestFinanceIssueCommandV1,
    context: VerifiedFinanceStepUpContextV1,
  ): Promise<ServiceRequestFinanceIssueOutcomeV1> {
    if ((command as Row)?.operation !== "service_request_issue") {
      financeError("FINANCE_OPERATION_INVALID", "issue 入口只接受 service_request_issue", 400);
    }
    assertCommandBasics(command);
    const startedAt = dependencies.now();
    assertContextShape(context, "service_request_issue", command.requestId, command, startedAt);
    await dependencies.assertSchema();
    const workspaceHint = await dependencies.readWorkspaceHint(command.requestId);
    if (!workspaceHint) financeError("FINANCE_REQUEST_NOT_FOUND", "service request 不存在", 404);
    const commandHash = dependencies.hash(command);
    let callbackCompleted = false;
    try {
      return await dependencies.transaction(async (repository) => {
        const { request, ownerUserId } = await lockAuthorityRows(
          repository,
          command.requestId,
          workspaceHint,
        );
        await assertStoredContext(repository, context, String(request.workspaceId), dependencies.now());
        const payloadHash = issuePayloadHash(dependencies.hash, request);
        const existing = await repository.findIntent(
          "service_request_issue",
          command.idempotencyKey,
        );
        if (existing) {
          const replay = await resolveExactIssueReplay(
            repository,
            existing,
            request,
            command,
            commandHash,
            payloadHash,
          );
          callbackCompleted = true;
          return replay;
        }
        assertLifecycle(request);
        if (
          request.financeState === "succeeded" ||
          request.financeState === "manual_required" ||
          request.financeState === "processing"
        ) {
          financeError("FINANCE_TERMINAL_REPLAY_CONFLICT", "request 已进入不可直接 issue 的终态", 409);
        }
        if (request.decision !== "approved") {
          financeError("FINANCE_NOT_APPROVED", "锁内 decision 未批准", 409);
        }
        if (Number(request.revision) !== command.expectedRevision) {
          financeError("FINANCE_REVISION_CONFLICT", "expectedRevision 与锁内 revision 不匹配", 409);
        }
        const priorIntent = await repository.findIntentByRequest(command.requestId);
        if (priorIntent) {
          callbackCompleted = true;
          return conflictOutcome();
        }

        const timestamp = dependencies.now();
        const financeOperationId = dependencies.randomId();
        const durableAuditIntentId = dependencies.randomId();
        const outboxId = dependencies.randomId();
        const intent: PersistedServiceRequestFinanceIntentV1 = {
          intentState: "persisted",
          operation: "service_request_issue",
          financeOperationId,
          uniqueScope: {
            operation: "service_request_issue",
            workspaceId: String(request.workspaceId),
            requestId: command.requestId,
            requestType: request.type,
          },
          payloadHashVersion: HASH_VERSION,
          payloadHash,
          lockedRevision: Number(request.revision),
          durableAuditIntentId,
          outboxIds: [outboxId],
          committedAt: timestamp,
        };
        await repository.insertIntent({
          id: financeOperationId,
          operation: "service_request_issue",
          requestId: command.requestId,
          workspaceId: request.workspaceId,
          requestType: request.type,
          idempotencyKey: command.idempotencyKey,
          commandHash,
          payloadHashVersion: HASH_VERSION,
          payloadHash,
          lockedRevision: Number(request.revision),
          durableAuditIntentId,
          outboxIds: stableJson(intent.outboxIds),
          status: "persisted",
          financeResult: null,
          errorMessage: null,
          committedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await repository.insertAudit(
          auditRow(
            durableAuditIntentId,
            request,
            context,
            "service_request.finance.intent_persisted",
            null,
            command.idempotencyKey,
            {
              financeState: request.financeState,
              revision: Number(request.revision),
            },
            { intentState: "persisted", financeOperationId },
            { payloadHashVersion: HASH_VERSION, payloadHash, outboxIds: [outboxId] },
            timestamp,
          ),
        );

        const authority = buildAuthority(request, timestamp);
        const effect = await repository.executeFinanceEffect(
          authority,
          intent,
          context.actorUserId,
          ownerUserId,
        );
        if (effect.state === "succeeded") {
          await assertDurableFinanceResult(
            repository,
            effect.result,
            request,
            financeOperationId,
            ownerUserId,
            context.actorUserId,
          );
        }
        const revision = Number(request.revision) + 1;
        const requestStatus =
          effect.state === "succeeded"
            ? request.type === "invoice"
              ? "issued"
              : "approved"
            : "pending";
        const requestResult = effect.state === "succeeded" ? effect.result : null;
        const updated = await repository.compareAndSetRequest(
          command.requestId,
          command.expectedRevision,
          {
            status: requestStatus,
            financeState: effect.state,
            financeResult: requestResult ? stableJson(requestResult) : null,
            revision,
            updatedAt: timestamp,
          },
        );
        if (!updated) financeError("FINANCE_REVISION_CONFLICT", "issue revision CAS 失败", 409);
        if (
          !(await repository.updateIntent(financeOperationId, {
            status: effect.state,
            financeResult: requestResult ? stableJson(requestResult) : null,
            errorMessage: effect.state === "succeeded" ? null : effect.reason,
            updatedAt: timestamp,
          }))
        ) {
          financeError("FINANCE_INTENT_UPDATE_FAILED", "durable intent 更新失败", 500);
        }
        const eventType =
          effect.state === "succeeded"
            ? "service_request.finance.succeeded"
            : effect.state === "manual_required"
              ? "service_request.finance.manual_required"
              : "service_request.finance.retry_required";
        await repository.insertOutbox(
          outboxRow(
            outboxId,
            command.requestId,
            eventType,
            {
              financeOperationId,
              requestType: request.type,
              financeState: effect.state,
              financeResult: requestResult,
              reason: effect.state === "succeeded" ? null : effect.reason,
            },
            timestamp,
          ),
        );
        await repository.insertAudit(
          auditRow(
            dependencies.randomId(),
            request,
            context,
            `service_request.finance.${effect.state}`,
            null,
            command.idempotencyKey,
            {
              financeState: request.financeState,
              revision: Number(request.revision),
            },
            { financeState: effect.state, revision },
            { financeOperationId, financeResult: requestResult },
            timestamp,
          ),
        );
        callbackCompleted = true;
        return effect.state === "succeeded"
          ? issueOutcome("executed", effect.result)
          : manualOutcome();
      });
    } catch (error: any) {
      if (!callbackCompleted) {
        if (error?.code === "23505") return conflictOutcome();
        throw error;
      }
      return await dependencies.transaction(async (repository) => {
        const { request } = await lockAuthorityRows(
          repository,
          command.requestId,
          workspaceHint,
        );
        await assertStoredContext(repository, context, String(request.workspaceId), dependencies.now());
        const stored = await repository.findIntent(
          "service_request_issue",
          command.idempotencyKey,
        );
        if (!stored) {
          const priorIntent = await repository.findIntentByRequest(
            command.requestId,
          );
          if (priorIntent) return conflictOutcome();
          return intentPersistenceFailed();
        }
        return await resolveExactIssueReplay(
          repository,
          stored,
          request,
          command,
          commandHash,
          issuePayloadHash(dependencies.hash, request),
        );
      });
    }
  }

  async function recoverServiceRequestFinance(
    requestId: string,
    expectedRevision: number,
    idempotencyKey: string,
    recoveryEvidenceId: string,
    context: VerifiedFinanceStepUpContextV1,
  ): Promise<{ record: ServiceRequestRecordV1; revision: number; replayed: boolean; outboxIds: string[] }> {
    const command = {
      operation: "service_request_recover" as const,
      requestId,
      expectedRevision,
      idempotencyKey,
      recoveryEvidenceId,
    };
    if (
      !nonEmpty(requestId) ||
      strictNonNegativeSafeInteger(expectedRevision) === null ||
      !nonEmpty(idempotencyKey) ||
      !nonEmpty(recoveryEvidenceId)
    ) {
      financeError("FINANCE_RECOVERY_COMMAND_INVALID", "recovery command 不完整", 400);
    }
    const startedAt = dependencies.now();
    assertContextShape(context, command.operation, requestId, command, startedAt);
    await dependencies.assertSchema();
    const workspaceHint = await dependencies.readWorkspaceHint(requestId);
    if (!workspaceHint) financeError("FINANCE_REQUEST_NOT_FOUND", "service request 不存在", 404);
    const commandHash = dependencies.hash(command);
    let callbackCompleted = false;
    try {
      return await dependencies.transaction(async (repository) => {
        const { request } = await lockAuthorityRows(repository, requestId, workspaceHint);
        await assertStoredContext(repository, context, String(request.workspaceId), dependencies.now());
        const existing = await repository.findCommand(command.operation, idempotencyKey);
        if (existing) {
          if (
            existing.requestId !== requestId ||
            existing.commandHash !== commandHash ||
            Number(existing.outcomeRevision) !== Number(request.revision)
          ) {
            financeError("FINANCE_IDEMPOTENCY_CONFLICT", "recovery idempotency replay 不匹配", 409);
          }
          callbackCompleted = true;
          return {
            record: toCanonicalRecord(request),
            revision: Number(request.revision),
            replayed: true,
            outboxIds: parseObject(existing.outcome).outboxIds || [],
          };
        }
        assertLifecycle(request);
        if (request.decision !== "approved" || request.financeState !== "failed_retryable") {
          financeError("FINANCE_RECOVERY_STATE_INVALID", "仅 failed_retryable request 可恢复", 409);
        }
        if (Number(request.revision) !== expectedRevision) {
          financeError("FINANCE_REVISION_CONFLICT", "expectedRevision 与锁内 revision 不匹配", 409);
        }
        const intent = await repository.findIntentByRequest(requestId);
        if (!intent || !["failed_retryable", "persisted"].includes(String(intent.status))) {
          financeError("FINANCE_RECOVERY_INTENT_INVALID", "缺少可恢复的 durable intent", 409);
        }
        const timestamp = dependencies.now();
        const revision = Number(request.revision) + 1;
        const outboxId = dependencies.randomId();
        await repository.insertCommand({
          id: dependencies.randomId(),
          operation: command.operation,
          requestId,
          workspaceId: request.workspaceId,
          idempotencyKey,
          commandHash,
          proofRecordId: context.proofRecordId,
          outcome: stableJson({ financeState: "processing", outboxIds: [outboxId] }),
          outcomeRevision: revision,
          createdAt: timestamp,
        });
        if (
          !(await repository.compareAndSetRequest(requestId, expectedRevision, {
            financeState: "processing",
            revision,
            updatedAt: timestamp,
          }))
        ) {
          financeError("FINANCE_REVISION_CONFLICT", "recovery revision CAS 失败", 409);
        }
        if (
          !(await repository.updateIntent(String(intent.id), {
            status: "processing",
            errorMessage: null,
            updatedAt: timestamp,
          }))
        ) {
          financeError("FINANCE_INTENT_UPDATE_FAILED", "recovery intent 更新失败", 500);
        }
        await repository.insertOutbox(
          outboxRow(
            outboxId,
            requestId,
            "service_request.finance.recovery_requested",
            { financeOperationId: intent.id, recoveryEvidenceId },
            timestamp,
          ),
        );
        await repository.insertAudit(
          auditRow(
            dependencies.randomId(),
            request,
            context,
            "service_request.finance.recovery_requested",
            recoveryEvidenceId,
            idempotencyKey,
            {
              financeState: request.financeState,
              revision: Number(request.revision),
            },
            { financeState: "processing", revision },
            { financeOperationId: intent.id, outboxIds: [outboxId] },
            timestamp,
          ),
        );
        const refreshed = await repository.refreshRequest(requestId);
        if (!refreshed) financeError("FINANCE_REQUEST_NOT_FOUND", "recovery 后 request 丢失", 500);
        callbackCompleted = true;
        return {
          record: toCanonicalRecord(refreshed),
          revision,
          replayed: false,
          outboxIds: [outboxId],
        };
      });
    } catch (error) {
      const uniqueConflict = isCommandIdempotencyUniqueViolation(error);
      if (!callbackCompleted && !uniqueConflict) throw error;
      return await dependencies.transaction(async (repository) => {
        const { request } = await lockAuthorityRows(repository, requestId, workspaceHint);
        await assertStoredContext(repository, context, String(request.workspaceId), dependencies.now());
        const stored = await repository.findCommand(command.operation, idempotencyKey);
        if (
          !stored ||
          stored.commandHash !== commandHash ||
          stored.requestId !== requestId ||
          Number(stored.outcomeRevision) !== Number(request.revision)
        ) {
          if (uniqueConflict) {
            financeError(
              "FINANCE_IDEMPOTENCY_CONFLICT",
              "recovery idempotency replay 不匹配",
              409,
            );
          }
          throw error;
        }
        return {
          record: toCanonicalRecord(request),
          revision: Number(request.revision),
          replayed: true,
          outboxIds: parseObject(stored.outcome).outboxIds || [],
        };
      });
    }
  }

  async function acquireWatchdogLease(
    requestId: string,
    context: VerifiedFinanceWorkerContextV1,
    leaseDurationMs = 30_000,
  ): Promise<FinanceWatchdogLeaseV1 | null> {
    const timestamp = dependencies.now();
    if (
      context?.verificationSource !== "finance_worker_registry/v1" ||
      context.operation !== "service_request_watchdog" ||
      !nonEmpty(context.credentialRecordId) ||
      !nonEmpty(context.workerId) ||
      !Number.isSafeInteger(context.expiresAt) ||
      context.expiresAt <= timestamp
    ) {
      financeError("FINANCE_WORKER_CONTEXT_INVALID", "watchdog worker context 无效", 401);
    }
    if (!nonEmpty(requestId) || leaseDurationMs < 1_000 || leaseDurationMs > 300_000) {
      financeError("FINANCE_WATCHDOG_ARGUMENT_INVALID", "watchdog lease 参数无效", 400);
    }
    await dependencies.assertSchema();
    const workspaceHint = await dependencies.readWorkspaceHint(requestId);
    if (!workspaceHint) financeError("FINANCE_REQUEST_NOT_FOUND", "service request 不存在", 404);
    return await dependencies.transaction(async (repository) => {
      const { request } = await lockAuthorityRows(repository, requestId, workspaceHint);
      assertLifecycle(request);
      if (
        request.decision !== "approved" ||
        !["processing", "failed_retryable", "manual_required"].includes(String(request.financeState))
      ) {
        financeError("FINANCE_WATCHDOG_STATE_INVALID", "request 当前不允许 watchdog lease", 409);
      }
      const credential = await repository.lockWorkerCredential(context.credentialRecordId);
      if (
        !credential ||
        credential.bindingVersion !== WORKER_BINDING_VERSION ||
        credential.workerId !== context.workerId ||
        credential.status !== "active" ||
        credential.revokedAt != null ||
        Number(credential.expiresAt) !== context.expiresAt
      ) {
        financeError("FINANCE_WORKER_REVOKED", "watchdog worker credential 已撤销", 401);
      }
      const existing = await repository.lockWatchdogLease(requestId);
      if (existing && Number(existing.expiresAt) > timestamp) {
        if (
          existing.workerId === context.workerId &&
          existing.credentialRecordId === context.credentialRecordId
        ) {
          return {
            leaseId: String(existing.id),
            requestId,
            workerId: context.workerId,
            acquiredAt: Number(existing.acquiredAt),
            expiresAt: Number(existing.expiresAt),
            replayed: true,
          };
        }
        return null;
      }
      const leaseId = dependencies.randomId();
      const expiresAt = Math.min(timestamp + leaseDurationMs, context.expiresAt);
      if (existing) {
        const replaced = await repository.replaceWatchdogLease(
          String(existing.id),
          Number(existing.expiresAt),
          {
            id: leaseId,
            workerId: context.workerId,
            credentialRecordId: context.credentialRecordId,
            acquiredAt: timestamp,
            expiresAt,
            revision: Number(existing.revision || 0) + 1,
            updatedAt: timestamp,
          },
        );
        if (!replaced) return null;
      } else {
        await repository.insertWatchdogLease({
          id: leaseId,
          requestId,
          workerId: context.workerId,
          credentialRecordId: context.credentialRecordId,
          acquiredAt: timestamp,
          expiresAt,
          revision: 1,
          updatedAt: timestamp,
        });
      }
      return {
        leaseId,
        requestId,
        workerId: context.workerId,
        acquiredAt: timestamp,
        expiresAt,
        replayed: false,
      };
    });
  }

  return {
    reviewServiceRequest,
    issueServiceRequestFinance,
    recoverServiceRequestFinance,
    acquireWatchdogLease,
  };
}

function normalizeSqlDefinition(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export async function assertPostgres16FinanceSchema(
  database: Knex = db as unknown as Knex,
): Promise<void> {
  const configuredClient = String((database as any)?.client?.config?.client || "");
  if (!configuredClient.includes("pg")) {
    financeError("FINANCE_POSTGRES_16_REQUIRED", "Finance runtime v2 只允许 PostgreSQL 16+", 503);
  }
  let versionNumber = 0;
  try {
    const versionResult: any = await database.raw("SHOW server_version_num");
    versionNumber = Number(versionResult?.rows?.[0]?.server_version_num || 0);
  } catch {
    financeError("FINANCE_POSTGRES_VERSION_UNVERIFIED", "无法验证 PostgreSQL server_version_num", 503);
  }
  if (versionNumber < billingServiceRequestFinanceSchema.minimumPostgresVersion) {
    financeError("FINANCE_POSTGRES_16_REQUIRED", "Finance runtime v2 要求 PostgreSQL 16+", 503);
  }

  const tableNames = Object.keys(billingServiceRequestFinanceSchema.tables);
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
  for (const [tableName, columns] of Object.entries(billingServiceRequestFinanceSchema.tables)) {
    const storedColumns = catalog.get(tableName);
    if (!storedColumns) {
      financeError("FINANCE_SCHEMA_MISSING", `缺少 Finance runtime 表 ${tableName}`, 503);
    }
    for (const column of columns) {
      if (!storedColumns.has(column)) {
        financeError("FINANCE_SCHEMA_MISSING", `缺少 Finance runtime 列 ${tableName}.${column}`, 503);
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
  for (const tableName of tableNames) {
    if (stableJson(primaryKeys.get(tableName) || []) !== stableJson(["id"])) {
      financeError(
        "FINANCE_SCHEMA_PRIMARY_KEY_DRIFT",
        `Finance runtime primary key 定义不匹配 ${tableName}`,
        503,
      );
    }
  }

  const indexNames = billingServiceRequestFinanceSchema.indexes.map((index) => index.name);
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
  for (const expected of billingServiceRequestFinanceSchema.indexes) {
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
      financeError(
        "FINANCE_SCHEMA_INDEX_DRIFT",
        `Finance runtime index 定义不匹配 ${expected.name}`,
        503,
      );
    }
  }

  const constraintNames = billingServiceRequestFinanceSchema.constraints.map(
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
  for (const expected of billingServiceRequestFinanceSchema.constraints) {
    const actual = constraints.get(expected.name);
    if (
      !actual ||
      String(actual.tableName) !== expected.table ||
      actual.constraintType !== "c" ||
      actual.isValidated !== true ||
      normalizeSqlDefinition(actual.definition) !== normalizeSqlDefinition(expected.definition)
    ) {
      financeError(
        "FINANCE_SCHEMA_CONSTRAINT_DRIFT",
        `Finance runtime constraint 定义不匹配 ${expected.name}`,
        503,
      );
    }
  }
}

function requireSafeMoney(value: unknown, field: string): number {
  const parsed = nonNegativeSafeInteger(value);
  if (parsed === null) {
    financeError(
      "FINANCE_UNSAFE_PERSISTED_MONEY",
      `${field} 必须是非负安全整数`,
      500,
    );
  }
  return parsed;
}

function checkedMoneySum(left: number, right: number, field: string): number {
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    financeError("FINANCE_MONEY_OVERFLOW", `${field} 超出安全整数`, 500);
  }
  return Number(result);
}

function assertOwnerWalletArithmetic(
  wallet: Row | null | undefined,
  expectedOwnerUserId: number,
  pendingCreditMicros: number,
): void {
  if (
    !wallet ||
    Number(wallet.userId) !== expectedOwnerUserId ||
    String(wallet.status) !== "active" ||
    String(wallet.currency) !== "GU"
  ) {
    financeError("FINANCE_OWNER_WALLET_INVALID", "owner wallet 不可用", 409);
  }
  const balanceMicros = requireSafeMoney(wallet.balanceMicros, "wallet.balanceMicros");
  const giftBalanceMicros = requireSafeMoney(
    wallet.giftBalanceMicros,
    "wallet.giftBalanceMicros",
  );
  const cashReservedMicros = requireSafeMoney(
    wallet.cashReservedMicros,
    "wallet.cashReservedMicros",
  );
  const giftReservedMicros = requireSafeMoney(
    wallet.giftReservedMicros,
    "wallet.giftReservedMicros",
  );
  const creditLimitMicros = requireSafeMoney(
    wallet.creditLimitMicros,
    "wallet.creditLimitMicros",
  );
  const creditUsedMicros = requireSafeMoney(
    wallet.creditUsedMicros,
    "wallet.creditUsedMicros",
  );
  const creditReservedMicros = requireSafeMoney(
    wallet.creditReservedMicros,
    "wallet.creditReservedMicros",
  );
  const balanceAfterMicros = checkedMoneySum(
    balanceMicros,
    pendingCreditMicros,
    "wallet.balanceMicros + credit",
  );
  const cashAvailable = BigInt(balanceAfterMicros) - BigInt(cashReservedMicros);
  const giftAvailable = BigInt(giftBalanceMicros) - BigInt(giftReservedMicros);
  const creditAvailable =
    BigInt(creditLimitMicros) -
    BigInt(creditUsedMicros) -
    BigInt(creditReservedMicros);
  const availableTotal =
    (cashAvailable > 0n ? cashAvailable : 0n) +
    (giftAvailable > 0n ? giftAvailable : 0n) +
    (creditAvailable > 0n ? creditAvailable : 0n);
  if (
    cashAvailable < -BigInt(Number.MAX_SAFE_INTEGER) ||
    giftAvailable < -BigInt(Number.MAX_SAFE_INTEGER) ||
    creditAvailable < -BigInt(Number.MAX_SAFE_INTEGER) ||
    availableTotal > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    financeError(
      "FINANCE_WALLET_ARITHMETIC_UNSAFE",
      "owner wallet 可用额度计算超出安全整数",
      500,
    );
  }
}

function assertWorkspaceAccountArithmetic(
  account: Row | null | undefined,
  expectedWorkspaceId: string,
  pendingCreditMicros: number,
): void {
  if (!account) return;
  if (
    String(account.workspaceId) !== expectedWorkspaceId ||
    String(account.status) !== "active" ||
    String(account.currency) !== "GU"
  ) {
    financeError("FINANCE_WORKSPACE_ACCOUNT_INVALID", "workspace billing account 不可用", 409);
  }
  const balanceMicros = requireSafeMoney(
    account.balanceMicros,
    "workspaceAccount.balanceMicros",
  );
  requireSafeMoney(
    account.creditLimitMicros,
    "workspaceAccount.creditLimitMicros",
  );
  requireSafeMoney(account.reservedMicros, "workspaceAccount.reservedMicros");
  checkedMoneySum(
    balanceMicros,
    pendingCreditMicros,
    "workspaceAccount.balanceMicros + credit",
  );
}

class KnexFinanceRepository implements FinanceRuntimeRepository {
  constructor(private readonly trx: Knex.Transaction) {}

  async lockWorkspace(workspaceId: string): Promise<Row | null> {
    return (await this.trx("o_workspace").where({ id: workspaceId }).forUpdate().first()) || null;
  }

  async lockRequest(requestId: string): Promise<Row | null> {
    return (
      (await this.trx("o_billing_service_request").where({ id: requestId }).forUpdate().first()) ||
      null
    );
  }

  async refreshRequest(requestId: string): Promise<Row | null> {
    return (await this.trx("o_billing_service_request").where({ id: requestId }).first()) || null;
  }

  async lockActor(actorUserId: number): Promise<Row | null> {
    return (
      (await this.trx("o_user").where({ id: actorUserId }).forUpdate().first()) || null
    );
  }

  async lockStepUpProof(proofRecordId: string): Promise<Row | null> {
    return (
      (await this.trx("o_auth_token").where({ id: proofRecordId }).forUpdate().first()) ||
      null
    );
  }

  async findCommand(operation: FinanceOperation, idempotencyKey: string): Promise<Row | null> {
    return (
      (await this.trx("o_billing_service_request_command")
        .where({ operation, idempotencyKey })
        .forUpdate()
        .first()) || null
    );
  }

  async insertCommand(row: Row): Promise<void> {
    await this.trx("o_billing_service_request_command").insert(row);
  }

  async findIntent(
    operation: "service_request_issue",
    idempotencyKey: string,
  ): Promise<Row | null> {
    return (
      (await this.trx("o_billing_finance_intent")
        .where({ operation, idempotencyKey })
        .forUpdate()
        .first()) || null
    );
  }

  async findIntentByRequest(requestId: string): Promise<Row | null> {
    return (
      (await this.trx("o_billing_finance_intent").where({ requestId }).forUpdate().first()) || null
    );
  }

  async insertIntent(row: Row): Promise<void> {
    await this.trx("o_billing_finance_intent").insert(row);
  }

  async updateIntent(financeOperationId: string, patch: Row): Promise<boolean> {
    return (
      Number(
        await this.trx("o_billing_finance_intent")
          .where({ id: financeOperationId })
          .update(patch),
      ) === 1
    );
  }

  async compareAndSetRequest(
    requestId: string,
    expectedRevision: number,
    patch: Row,
  ): Promise<boolean> {
    return (
      Number(
        await this.trx("o_billing_service_request")
          .where({ id: requestId, revision: expectedRevision })
          .update(patch),
      ) === 1
    );
  }

  async insertOutbox(row: Row): Promise<void> {
    await this.trx("o_billing_outbox").insert(row);
  }

  async insertAudit(row: Row): Promise<void> {
    await this.trx("o_billing_audit_log").insert(row);
  }

  async executeFinanceEffect(
    authority: LockedServiceRequestFinanceAuthorityV1,
    intent: PersistedServiceRequestFinanceIntentV1,
    actorUserId: number,
    workspaceOwnerUserId: number,
  ): Promise<
    | { state: "succeeded"; result: ServiceRequestFinanceResultV1 }
    | { state: "manual_required"; reason: string }
    | { state: "failed_retryable"; reason: string }
  > {
    if (authority.requestType === "invoice") {
      return {
        state: "manual_required",
        reason: "INVOICE_PROVIDER_NOT_CONNECTED",
      };
    }
    try {
      return await this.trx.transaction(async (effectTrx) => {
        if (authority.requestType === "offline_payment") {
          const creditedAmountMicros = offlineCreditedAmountMicros(
            authority.payload.paidAmountMicros,
          );
          if (creditedAmountMicros === null) {
            financeError("FINANCE_CONVERSION_OVERFLOW", "CNY/GU conversion 超出安全整数", 500);
          }
          await ensureAccountWallet(effectTrx, workspaceOwnerUserId, "GU");
          const ownerIdempotencyKey = `${intent.financeOperationId}:owner-credit`;
          const existingOwnerLedger = await effectTrx("o_account_wallet_ledger")
            .where({
              userId: workspaceOwnerUserId,
              type: "manual_credit",
              idempotencyKey: ownerIdempotencyKey,
            })
            .forUpdate()
            .first();
          const wallet = await effectTrx("o_account_wallet")
            .where({ userId: workspaceOwnerUserId })
            .forUpdate()
            .first();
          assertOwnerWalletArithmetic(
            wallet,
            workspaceOwnerUserId,
            existingOwnerLedger ? 0 : creditedAmountMicros,
          );
          const workspaceIdempotencyKey =
            `workspace:${intent.financeOperationId}:projection`;
          const existingWorkspaceLedger = await effectTrx("o_billing_ledger")
            .where({
              workspaceId: authority.workspaceId,
              type: "recharge",
              idempotencyKey: workspaceIdempotencyKey,
            })
            .forUpdate()
            .first();
          const workspaceAccount = await effectTrx("o_billing_account")
            .where({ workspaceId: authority.workspaceId })
            .forUpdate()
            .first();
          assertWorkspaceAccountArithmetic(
            workspaceAccount,
            authority.workspaceId,
            existingWorkspaceLedger ? 0 : creditedAmountMicros,
          );
          const ownerCredit = await applyAccountWalletCredit(effectTrx, {
            userId: workspaceOwnerUserId,
            amountMicros: creditedAmountMicros,
            currency: "GU",
            type: "manual_credit",
            workspaceId: authority.workspaceId,
            serviceRequestId: authority.requestId,
            requestId: authority.requestId,
            idempotencyKey: ownerIdempotencyKey,
            description: "线下付款确认入账",
            metadata: {
              source: "billing_service_request.v1",
              financeOperationId: intent.financeOperationId,
              paymentEvidenceId: authority.payload.paymentEvidenceId,
              tenderAmountMicros: authority.payload.paidAmountMicros,
              tenderCurrency: "CNY",
              conversionPolicyVersion: offlineConversionPolicyVersion,
            },
            operatorUserId: actorUserId,
          });
          const projection = await allocateAccountWalletToWorkspaceInTransaction(effectTrx, {
            userId: workspaceOwnerUserId,
            workspaceId: authority.workspaceId,
            amountMicros: creditedAmountMicros,
            idempotencyKey: `${intent.financeOperationId}:projection`,
            description: "线下付款工作区额度投影",
            metadata: {
              source: "billing_service_request.v1",
              financeOperationId: intent.financeOperationId,
              serviceRequestId: authority.requestId,
              ownerWalletLedgerId: ownerCredit.ledger.id,
              paymentEvidenceId: authority.payload.paymentEvidenceId,
              tenderAmountMicros: authority.payload.paidAmountMicros,
              tenderCurrency: "CNY",
              conversionPolicyVersion: offlineConversionPolicyVersion,
            },
            operatorUserId: actorUserId,
          });
          const incomeIdempotencyKey = `${intent.financeOperationId}:income`;
          let income = await effectTrx("o_finance_income_record")
            .where({ idempotencyKey: incomeIdempotencyKey })
            .first();
          if (income) {
            if (
              String(income.workspaceId) !== authority.workspaceId ||
              Number(income.amountMicros) !== authority.payload.paidAmountMicros ||
              String(income.serviceRequestId) !== authority.requestId
            ) {
              financeError("FINANCE_IDEMPOTENCY_CONFLICT", "income idempotency payload 不匹配", 409);
            }
          } else {
            const timestamp = authority.lockedAt;
            income = {
              id: uuid(),
              workspaceId: authority.workspaceId,
              ledgerId: projection.workspaceLedger.id,
              serviceRequestId: authority.requestId,
              channel: "offline_payment",
              method: "manual_review",
              status: "confirmed",
              amountMicros: authority.payload.paidAmountMicros,
              currency: "CNY",
              description: "线下付款经财务复核确认",
              metadata: stableJson({
                financeOperationId: intent.financeOperationId,
                paymentEvidenceId: authority.payload.paymentEvidenceId,
                creditedAmountMicros,
                conversionPolicyVersion: offlineConversionPolicyVersion,
              }),
              operatorUserId: actorUserId,
              paymentTime: timestamp,
              confirmedAt: timestamp,
              idempotencyKey: incomeIdempotencyKey,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
            await effectTrx("o_finance_income_record").insert(income);
          }
          await effectTrx("o_account_wallet_ledger")
            .where({ id: ownerCredit.ledger.id })
            .update({
              workspaceLedgerId: projection.workspaceLedger.id,
              incomeRecordId: income.id,
              updatedAt: authority.lockedAt,
            });
          const conversionSnapshotHash = offlineConversionSnapshotHash(
            authority.payload.paidAmountMicros,
            creditedAmountMicros,
          );
          return {
            state: "succeeded" as const,
            result: {
              kind: "offline_payment_credited" as const,
              financeOperationId: intent.financeOperationId,
              incomeRecordId: String(income.id),
              targetOwnerUserId: workspaceOwnerUserId,
              ownerWalletLedgerId: ownerCredit.ledger.id,
              workspaceProjectionLedgerId: projection.workspaceLedger.id,
              tenderAmountMicros: authority.payload.paidAmountMicros,
              tenderCurrency: "CNY" as const,
              creditedAmountMicros,
              creditedCurrency: "GU" as const,
              conversionPolicyVersion: offlineConversionPolicyVersion,
              conversionSnapshotHash,
            },
          };
        }

        await ensureAccountWallet(effectTrx, workspaceOwnerUserId, "GU");
        const wallet = await effectTrx("o_account_wallet")
          .where({ userId: workspaceOwnerUserId })
          .forUpdate()
          .first();
        assertOwnerWalletArithmetic(wallet, workspaceOwnerUserId, 0);
        const ownerIdempotencyKey = `${intent.financeOperationId}:owner-credit-limit`;
        let ownerLedger = await effectTrx("o_account_wallet_ledger")
          .where({
            userId: workspaceOwnerUserId,
            type: "credit_set",
            idempotencyKey: ownerIdempotencyKey,
          })
          .forUpdate()
          .first();
        const previousLimitMicros = requireSafeMoney(
          wallet.creditLimitMicros,
          "wallet.creditLimitMicros",
        );
        const newLimitMicros = positiveSafeInteger(
          authority.payload.requestedCreditLimitMicros,
        );
        if (!newLimitMicros) {
          financeError("FINANCE_AMOUNT_INVALID", "授信额度必须是正安全整数", 500);
        }
        const walletBalanceMicros = requireSafeMoney(
          wallet.balanceMicros,
          "wallet.balanceMicros",
        );
        const limitDeltaMicros = Number(
          BigInt(newLimitMicros) >= BigInt(previousLimitMicros)
            ? BigInt(newLimitMicros) - BigInt(previousLimitMicros)
            : BigInt(previousLimitMicros) - BigInt(newLimitMicros),
        );
        if (!ownerLedger) {
          const affected = await effectTrx("o_account_wallet")
            .where({
              id: wallet.id,
              creditLimitMicros: previousLimitMicros,
              updatedAt: wallet.updatedAt,
            })
            .update({ creditLimitMicros: newLimitMicros, updatedAt: authority.lockedAt });
          if (Number(affected) !== 1) {
            financeError("FINANCE_OWNER_WALLET_CAS_FAILED", "owner wallet credit-limit CAS 失败", 409);
          }
          const timestamp = authority.lockedAt;
          ownerLedger = {
            id: uuid(),
            walletId: wallet.id,
            userId: workspaceOwnerUserId,
            workspaceId: authority.workspaceId,
            workspaceLedgerId: null,
            serviceRequestId: authority.requestId,
            incomeRecordId: null,
            type: "credit_set",
            direction: newLimitMicros >= previousLimitMicros ? "credit" : "debit",
            amountMicros: limitDeltaMicros,
            currency: "GU",
            balanceBeforeMicros: walletBalanceMicros,
            balanceAfterMicros: walletBalanceMicros,
            requestId: authority.requestId,
            idempotencyKey: ownerIdempotencyKey,
            description: `账号授信额度：${previousLimitMicros} -> ${newLimitMicros}`,
            metadata: stableJson({
              source: "billing_service_request.v1",
              financeOperationId: intent.financeOperationId,
              previousCreditLimitMicros: previousLimitMicros,
              creditLimitMicros: newLimitMicros,
            }),
            operatorUserId: actorUserId,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await effectTrx("o_account_wallet_ledger").insert(ownerLedger);
        }
        const workspaceAccount = await effectTrx("o_billing_account")
          .where({ workspaceId: authority.workspaceId })
          .forUpdate()
          .first();
        assertWorkspaceAccountArithmetic(
          workspaceAccount,
          authority.workspaceId,
          0,
        );
        const workspaceCredit = await applySetCreditLimit(effectTrx, {
          workspaceId: authority.workspaceId,
          creditLimitMicros: newLimitMicros,
          currency: "GU",
          requestId: authority.requestId,
          idempotencyKey: `${intent.financeOperationId}:workspace-credit-limit`,
          description: "服务申请授信额度投影",
          metadata: {
            source: "billing_service_request.v1",
            financeOperationId: intent.financeOperationId,
            requestId: authority.requestId,
            ownerWalletLedgerId: ownerLedger.id,
          },
          operatorUserId: actorUserId,
        });
        await effectTrx("o_account_wallet_ledger")
          .where({ id: ownerLedger.id })
          .update({
            workspaceLedgerId: workspaceCredit.ledger.id,
            updatedAt: authority.lockedAt,
          });
        return {
          state: "succeeded" as const,
          result: {
            kind: "credit_limit_applied" as const,
            financeOperationId: intent.financeOperationId,
            targetOwnerUserId: workspaceOwnerUserId,
            ownerWalletLedgerId: String(ownerLedger.id),
            workspaceProjectionLedgerId: workspaceCredit.ledger.id,
            previousLimitMicros,
            newLimitMicros,
            currency: "GU" as const,
          },
        };
      });
    } catch (error: any) {
      const code = String(error?.code || "");
      const retryable =
        code === "40P01" ||
        code === "40001" ||
        code === "55P03" ||
        /deadlock|serialization|lock timeout/i.test(String(error?.message || ""));
      const reason =
        code === "40P01"
          ? "FINANCE_EFFECT_RETRYABLE_DEADLOCK"
          : code === "40001"
            ? "FINANCE_EFFECT_RETRYABLE_SERIALIZATION"
            : code === "55P03"
              ? "FINANCE_EFFECT_RETRYABLE_LOCK_UNAVAILABLE"
              : retryable
                ? "FINANCE_EFFECT_RETRYABLE_LOCK_CONFLICT"
                : error instanceof BillingServiceRequestFinanceError
                  ? error.code
                  : "FINANCE_EFFECT_FAILED";
      return {
        state: retryable ? "failed_retryable" : "manual_required",
        reason,
      };
    }
  }

  async verifyFinanceResult(
    requestId: string,
    financeOperationId: string,
    result: ServiceRequestFinanceResultV1,
    authority: DurableFinanceResultAuthorityV1,
  ): Promise<boolean> {
    // Invoice issuance is deliberately manual until the central invoice
    // provider CR supplies an independently verifiable durable receipt.
    if (result.kind === "invoice_issued") return false;
    if (
      result.financeOperationId !== financeOperationId ||
      !strictPositiveSafeInteger(result.targetOwnerUserId) ||
      !nonEmpty(authority.workspaceId) ||
      (authority.expectedExecutionActorUserId !== null &&
        !strictPositiveSafeInteger(authority.expectedExecutionActorUserId)) ||
      (result.kind === "offline_payment_credited" &&
        authority.requestType !== "offline_payment") ||
      (result.kind === "credit_limit_applied" &&
        authority.requestType !== "credit_limit")
    ) {
      return false;
    }

    const intent = await this.trx("o_billing_finance_intent")
      .where({ id: financeOperationId })
      .forShare()
      .first();
    const intentStatus = String(intent?.status);
    const intentLockedRevision = nonNegativeSafeInteger(intent?.lockedRevision);
    const intentCommittedAt = positiveSafeInteger(intent?.committedAt);
    const intentOutboxIds = canonicalStringArray(intent?.outboxIds);
    if (
      !intent ||
      String(intent.operation) !== "service_request_issue" ||
      String(intent.requestId) !== requestId ||
      String(intent.workspaceId) !== authority.workspaceId ||
      String(intent.requestType) !== authority.requestType ||
      String(intent.payloadHashVersion) !== HASH_VERSION ||
      !nonEmpty(intent.payloadHash) ||
      !nonEmpty(intent.commandHash) ||
      !nonEmpty(intent.idempotencyKey) ||
      !nonEmpty(intent.durableAuditIntentId) ||
      !["persisted", "succeeded"].includes(intentStatus) ||
      (authority.expectedExecutionActorUserId === null
        ? intentStatus !== "succeeded"
        : intentStatus !== "persisted") ||
      intentLockedRevision === null ||
      !intentCommittedAt ||
      !intentOutboxIds
    ) {
      return false;
    }
    const intentAudit = await this.trx("o_billing_audit_log")
      .where({ id: intent.durableAuditIntentId })
      .forShare()
      .first();
    if (!intentAudit) return false;
    let auditPreviousState: Row;
    let auditNewState: Row;
    let auditMetadata: Row;
    try {
      auditPreviousState = parseObject(intentAudit.previousState);
      auditNewState = parseObject(intentAudit.newState);
      auditMetadata = parseObject(intentAudit.metadata);
    } catch {
      return false;
    }
    const historicalActorUserId = positiveSafeInteger(intentAudit.actorUserId);
    const auditCreatedAt = positiveSafeInteger(intentAudit.createdAt);
    const auditOutboxIds = canonicalStringArray(auditMetadata.outboxIds);
    if (
      !historicalActorUserId ||
      (authority.expectedExecutionActorUserId !== null &&
        historicalActorUserId !== authority.expectedExecutionActorUserId) ||
      String(intentAudit.workspaceId) !== authority.workspaceId ||
      String(intentAudit.requestId) !== requestId ||
      String(intentAudit.action) !== "service_request.finance.intent_persisted" ||
      String(intentAudit.scope) !== ISSUE_SCOPE ||
      !nonEmpty(intentAudit.actorRole) ||
      !positiveSafeInteger(intentAudit.authorizationRevision) ||
      !(String(intentAudit.authMethod) === "machine"
        ? auditMetadata.verificationSource === "admin_machine_credential/v1" && nonEmpty(auditMetadata.machineCredentialId)
        : ["password", "totp", "recovery"].includes(String(intentAudit.authMethod))) ||
      !nonEmpty(intentAudit.proofRecordId) ||
      !nonEmpty(intentAudit.requestFingerprint) ||
      String(intentAudit.resourceFingerprint) !==
        financeStepUpResourceFingerprint(requestId) ||
      String(intentAudit.idempotencyKey) !== String(intent.idempotencyKey) ||
      !auditCreatedAt ||
      auditCreatedAt !== intentCommittedAt ||
      !["not_started", "failed_retryable"].includes(
        String(auditPreviousState.financeState),
      ) ||
      strictNonNegativeSafeInteger(auditPreviousState.revision) !==
        intentLockedRevision ||
      auditNewState.intentState !== "persisted" ||
      auditNewState.financeOperationId !== financeOperationId ||
      auditMetadata.payloadHashVersion !== HASH_VERSION ||
      auditMetadata.payloadHash !== intent.payloadHash ||
      !auditOutboxIds ||
      auditOutboxIds !== intentOutboxIds
    ) {
      return false;
    }

    const ownerLedger = await this.trx("o_account_wallet_ledger")
      .where({ id: result.ownerWalletLedgerId })
      .forShare()
      .first();
    const workspaceLedger = await this.trx("o_billing_ledger")
      .where({ id: result.workspaceProjectionLedgerId })
      .forShare()
      .first();
    if (!ownerLedger || !workspaceLedger) return false;
    const ownerWallet = await this.trx("o_account_wallet")
      .where({ id: ownerLedger.walletId })
      .forShare()
      .first();
    const workspaceAccount = await this.trx("o_billing_account")
      .where({ id: workspaceLedger.accountId })
      .forShare()
      .first();
    if (
      !ownerWallet ||
      !workspaceAccount ||
      Number(ownerWallet.userId) !== result.targetOwnerUserId ||
      String(ownerWallet.currency) !== "GU" ||
      String(workspaceAccount.workspaceId) !== authority.workspaceId ||
      String(workspaceAccount.currency) !== "GU"
    ) {
      return false;
    }

    let ownerMetadata: Row;
    let workspaceMetadata: Row;
    try {
      ownerMetadata = parseObject(ownerLedger.metadata);
      workspaceMetadata = parseObject(workspaceLedger.metadata);
    } catch {
      return false;
    }
    const sharedOwnerProof =
      Number(ownerLedger.userId) === result.targetOwnerUserId &&
      String(ownerLedger.workspaceId) === authority.workspaceId &&
      String(workspaceLedger.workspaceId) === authority.workspaceId &&
      String(ownerLedger.serviceRequestId) === requestId &&
      String(ownerLedger.requestId) === requestId &&
      String(ownerLedger.workspaceLedgerId) === String(workspaceLedger.id) &&
      String(ownerLedger.currency) === "GU" &&
      Number(ownerLedger.operatorUserId) === historicalActorUserId &&
      Number(workspaceLedger.createdBy) === historicalActorUserId &&
      ownerMetadata.source === "billing_service_request.v1" &&
      ownerMetadata.financeOperationId === financeOperationId &&
      workspaceMetadata.source === "billing_service_request.v1" &&
      workspaceMetadata.financeOperationId === financeOperationId;
    if (!sharedOwnerProof) return false;

    if (result.kind === "offline_payment_credited") {
      const expectedCreditedAmountMicros = offlineCreditedAmountMicros(
        result.tenderAmountMicros,
      );
      if (
        expectedCreditedAmountMicros === null ||
        result.creditedAmountMicros !== expectedCreditedAmountMicros ||
        !offlineConversionProofMatches(
          result.conversionPolicyVersion, result.conversionSnapshotHash,
          result.tenderAmountMicros, expectedCreditedAmountMicros,
        ) ||
        !nonEmpty(authority.paymentEvidenceId)
      ) {
        return false;
      }
      const income = await this.trx("o_finance_income_record")
        .where({ id: result.incomeRecordId })
        .forShare()
        .first();
      if (!income) return false;
      let incomeMetadata: Row;
      try {
        incomeMetadata = parseObject(income.metadata);
      } catch {
        return false;
      }
      return (
        String(ownerLedger.type) === "manual_credit" &&
        String(ownerLedger.direction) === "credit" &&
        String(ownerLedger.idempotencyKey) === `${financeOperationId}:owner-credit` &&
        positiveSafeInteger(ownerLedger.amountMicros) === result.creditedAmountMicros &&
        safeDeltaMatches(
          ownerLedger.balanceAfterMicros,
          ownerLedger.balanceBeforeMicros,
          result.creditedAmountMicros,
        ) &&
        String(ownerLedger.incomeRecordId) === result.incomeRecordId &&
        ownerMetadata.paymentEvidenceId === authority.paymentEvidenceId &&
        strictPositiveSafeInteger(ownerMetadata.tenderAmountMicros) ===
          result.tenderAmountMicros &&
        ownerMetadata.tenderCurrency === "CNY" &&
        ownerMetadata.conversionPolicyVersion === result.conversionPolicyVersion &&
        String(workspaceLedger.type) === "recharge" &&
        String(workspaceLedger.direction) === "credit" &&
        String(workspaceLedger.status) === "succeeded" &&
        String(workspaceLedger.currency) === "GU" &&
        String(workspaceLedger.idempotencyKey) ===
          `workspace:${financeOperationId}:projection` &&
        workspaceMetadata.serviceRequestId === requestId &&
        workspaceMetadata.ownerWalletLedgerId === String(ownerLedger.id) &&
        workspaceMetadata.paymentEvidenceId === authority.paymentEvidenceId &&
        strictPositiveSafeInteger(workspaceMetadata.tenderAmountMicros) ===
          result.tenderAmountMicros &&
        workspaceMetadata.tenderCurrency === "CNY" &&
        workspaceMetadata.conversionPolicyVersion === result.conversionPolicyVersion &&
        positiveSafeInteger(workspaceLedger.amountMicros) ===
          result.creditedAmountMicros &&
        safeDeltaMatches(
          workspaceLedger.balanceAfter,
          workspaceLedger.balanceBefore,
          result.creditedAmountMicros,
        ) &&
        nonNegativeSafeInteger(workspaceLedger.reservedBefore) !== null &&
        nonNegativeSafeInteger(workspaceLedger.reservedAfter) !== null &&
        Number(workspaceLedger.reservedAfter) ===
          Number(workspaceLedger.reservedBefore) &&
        String(income.workspaceId) === authority.workspaceId &&
        String(income.ledgerId) === String(workspaceLedger.id) &&
        String(income.serviceRequestId) === requestId &&
        String(income.channel) === "offline_payment" &&
        String(income.method) === "manual_review" &&
        String(income.status) === "confirmed" &&
        positiveSafeInteger(income.amountMicros) === result.tenderAmountMicros &&
        String(income.currency) === "CNY" &&
        Number(income.operatorUserId) === historicalActorUserId &&
        String(income.idempotencyKey) === `${financeOperationId}:income` &&
        incomeMetadata.financeOperationId === financeOperationId &&
        incomeMetadata.paymentEvidenceId === authority.paymentEvidenceId &&
        strictPositiveSafeInteger(incomeMetadata.creditedAmountMicros) ===
          result.creditedAmountMicros &&
        incomeMetadata.conversionPolicyVersion === result.conversionPolicyVersion
      );
    }

    const previousLimitMicros = strictNonNegativeSafeInteger(
      result.previousLimitMicros,
    );
    const newLimitMicros = strictPositiveSafeInteger(result.newLimitMicros);
    if (previousLimitMicros === null || !newLimitMicros) return false;
    const limitDelta = Number(
      BigInt(newLimitMicros) >= BigInt(previousLimitMicros)
        ? BigInt(newLimitMicros) - BigInt(previousLimitMicros)
        : BigInt(previousLimitMicros) - BigInt(newLimitMicros),
    );
    return (
      String(ownerLedger.type) === "credit_set" &&
      String(ownerLedger.direction) ===
        (newLimitMicros >= previousLimitMicros ? "credit" : "debit") &&
      String(ownerLedger.idempotencyKey) === `${financeOperationId}:owner-credit-limit` &&
      nonNegativeSafeInteger(ownerLedger.amountMicros) === limitDelta &&
      nonNegativeSafeInteger(ownerLedger.balanceBeforeMicros) !== null &&
      nonNegativeSafeInteger(ownerLedger.balanceAfterMicros) !== null &&
      Number(ownerLedger.balanceAfterMicros) ===
        Number(ownerLedger.balanceBeforeMicros) &&
      strictNonNegativeSafeInteger(ownerMetadata.previousCreditLimitMicros) ===
        previousLimitMicros &&
      strictPositiveSafeInteger(ownerMetadata.creditLimitMicros) === newLimitMicros &&
      String(workspaceLedger.type) === "credit_set" &&
      String(workspaceLedger.status) === "succeeded" &&
      String(workspaceLedger.currency) === "GU" &&
      String(workspaceLedger.idempotencyKey) ===
        `${financeOperationId}:workspace-credit-limit` &&
      workspaceMetadata.requestId === requestId &&
      workspaceMetadata.ownerWalletLedgerId === String(ownerLedger.id) &&
      positiveSafeInteger(workspaceLedger.amountMicros) === newLimitMicros &&
      nonNegativeSafeInteger(workspaceLedger.balanceBefore) !== null &&
      nonNegativeSafeInteger(workspaceLedger.balanceAfter) !== null &&
      Number(workspaceLedger.balanceAfter) === Number(workspaceLedger.balanceBefore) &&
      nonNegativeSafeInteger(workspaceLedger.reservedBefore) !== null &&
      nonNegativeSafeInteger(workspaceLedger.reservedAfter) !== null &&
      Number(workspaceLedger.reservedAfter) === Number(workspaceLedger.reservedBefore)
    );
  }

  async lockWorkerCredential(credentialRecordId: string): Promise<Row | null> {
    return (
      (await this.trx("o_billing_finance_worker")
        .where({ id: credentialRecordId })
        .forUpdate()
        .first()) ||
      null
    );
  }

  async lockWatchdogLease(requestId: string): Promise<Row | null> {
    return (
      (await this.trx("o_billing_watchdog_lease")
        .where({ requestId })
        .forUpdate()
        .first()) || null
    );
  }

  async insertWatchdogLease(row: Row): Promise<void> {
    await this.trx("o_billing_watchdog_lease").insert(row);
  }

  async replaceWatchdogLease(
    leaseId: string,
    expectedExpiresAt: number,
    patch: Row,
  ): Promise<boolean> {
    return (
      Number(
        await this.trx("o_billing_watchdog_lease")
          .where({ id: leaseId, expiresAt: expectedExpiresAt })
          .update(patch),
      ) === 1
    );
  }
}

export function createPostgresFinanceRuntimeDependencies(
  database: Knex,
  primitives: Partial<
    Pick<FinanceRuntimeDependencies, "now" | "randomId" | "hash">
  > = {},
): FinanceRuntimeDependencies {
  return {
    now: primitives.now || (() => Date.now()),
    randomId: primitives.randomId || (() => uuid()),
    hash: primitives.hash || sha256,
    assertSchema: async () => await assertPostgres16FinanceSchema(database),
    async readWorkspaceHint(requestId: string): Promise<string | null> {
      const row = await database("o_billing_service_request")
        .where({ id: requestId })
        .select("workspaceId")
        .first();
      return row?.workspaceId ? String(row.workspaceId) : null;
    },
    async transaction<T>(
      handler: (repository: FinanceRuntimeRepository) => Promise<T>,
    ): Promise<T> {
      return await database.transaction(
        async (trx) => await handler(new KnexFinanceRepository(trx)),
      );
    },
  };
}

const defaultDependencies = createPostgresFinanceRuntimeDependencies(
  db as unknown as Knex,
);

const defaultRuntime = createBillingServiceRequestFinanceRuntime(defaultDependencies);

export const reviewServiceRequest = defaultRuntime.reviewServiceRequest;
export const issueServiceRequestFinance = defaultRuntime.issueServiceRequestFinance;
export const recoverServiceRequestFinance = defaultRuntime.recoverServiceRequestFinance;
export const acquireWatchdogLease = defaultRuntime.acquireWatchdogLease;
