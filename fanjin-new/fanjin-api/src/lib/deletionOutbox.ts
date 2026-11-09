import crypto from "node:crypto";
import type { Knex } from "knex";

export const DELETION_OUTBOX_TABLE = "o_deletion_outbox";
export const DELETION_OUTBOX_INSERT_CHUNK_SIZE = 500;
export const CONDITIONAL_DELETION_PROVIDER_CONTRACT =
  "conditional-storage-delete.v1" as const;
const LEGACY_DISPATCH_IDEMPOTENCY_DOMAIN =
  "conditional-storage-delete/idempotency/v1" as const;
const CURRENT_DISPATCH_IDEMPOTENCY_DOMAIN =
  "conditional-storage-delete/idempotency/v2" as const;

type DispatchBoundaryProtocol = "legacy-v1" | "current-v2" | "unknown";

export type DeletionType = "file" | "prefix";
export type DeletionOutboxStatus =
  | "pending"
  | "leased"
  | "dispatching"
  | "pending_reconcile"
  | "failed_retryable"
  | "completed"
  | "dead";

export type DeletionOutboxErrorCode =
  | "storage_access_denied"
  | "storage_authentication_failed"
  | "storage_rate_limited"
  | "storage_request_timeout"
  | "storage_service_unavailable"
  | "storage_transport_failed"
  | "storage_delete_failed"
  | "lease_expired"
  | "lease_fence_exhausted"
  | "row_invalid"
  | "dispatch_outcome_unknown";

const DELETION_ERROR_CODES = new Set<DeletionOutboxErrorCode>([
  "storage_access_denied",
  "storage_authentication_failed",
  "storage_rate_limited",
  "storage_request_timeout",
  "storage_service_unavailable",
  "storage_transport_failed",
  "storage_delete_failed",
  "lease_expired",
  "lease_fence_exhausted",
  "row_invalid",
  "dispatch_outcome_unknown",
]);

export interface DeletionOutboxItem {
  resourceType: string;
  resourceId: string;
  bucket: string;
  objectKey: string;
  deleteType: DeletionType;
  targetGeneration: string;
  conditionalToken: string;
  /**
   * Retries permitted after the first attempt. Zero means one total attempt.
   */
  maxRetries?: number;
}

export interface DeletionOutboxRecord {
  id: string;
  operationId: string;
  dedupeKey: string;
  payloadHash: string;
  resourceType: string;
  resourceId: string;
  bucket: string;
  objectKey: string;
  deleteType: DeletionType;
  targetGeneration: string;
  conditionalToken: string;
  status: DeletionOutboxStatus;
  errorCode: DeletionOutboxErrorCode | null;
  retryCount: number;
  maxRetries: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  leaseFence: number;
  reconcileOwner: string | null;
  reconcileExpiresAt: number | null;
  reconcileFence: number;
  reconcileRetryCount: number;
  dispatchProviderId: string | null;
  dispatchIdempotencyKey: string | null;
  dispatchTargetFingerprint: string | null;
  dispatchMarkedAt: number | null;
  providerDispatchAt: number | null;
  providerReceiptOutcome: "deleted" | "target_already_absent" | null;
  providerReceiptCode: "TARGET_DELETED" | "TARGET_ALREADY_ABSENT" | null;
  providerRequestId: string | null;
  providerReceiptAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type ClaimedDeletionOutboxRecord = Omit<
  DeletionOutboxRecord,
  "status" | "leaseOwner" | "leaseExpiresAt"
> & {
  status: "leased";
  leaseOwner: string;
  leaseExpiresAt: number;
};

export type DispatchedDeletionOutboxRecord = Omit<
  DeletionOutboxRecord,
  | "status"
  | "leaseOwner"
  | "leaseExpiresAt"
  | "dispatchProviderId"
  | "dispatchIdempotencyKey"
  | "dispatchTargetFingerprint"
  | "dispatchMarkedAt"
> & {
  status: "dispatching";
  leaseOwner: string;
  leaseExpiresAt: number;
  dispatchProviderId: string;
  dispatchIdempotencyKey: string;
  dispatchTargetFingerprint: string;
  dispatchMarkedAt: number;
};

type InvokedDeletionOutboxRecord = Omit<
  DispatchedDeletionOutboxRecord,
  "providerDispatchAt"
> & {
  providerDispatchAt: number;
};

export type ClaimedDeletionReconciliationRecord = Omit<
  DeletionOutboxRecord,
  | "status"
  | "reconcileOwner"
  | "reconcileExpiresAt"
  | "dispatchProviderId"
  | "dispatchIdempotencyKey"
  | "dispatchTargetFingerprint"
  | "dispatchMarkedAt"
> & {
  status: "pending_reconcile";
  reconcileOwner: string;
  reconcileExpiresAt: number;
  dispatchProviderId: string;
  dispatchIdempotencyKey: string;
  dispatchTargetFingerprint: string;
  dispatchMarkedAt: number;
};

export interface EnqueueDeletionOperationInput {
  operationId: string;
  items: readonly DeletionOutboxItem[];
}

export interface EnqueueDeletionOperationResult {
  operationId: string;
  payloadHash: string;
  idempotent: boolean;
  records: DeletionOutboxRecord[];
}

export interface AppendDeletionOperationResult {
  operationId: string;
  payloadHash: string;
  idempotent: boolean;
  addedRecords: DeletionOutboxRecord[];
  records: DeletionOutboxRecord[];
}

export interface AppendDeletionManifestChunkInput
  extends EnqueueDeletionOperationInput {
  contentHash: string;
}

export interface DeletionOutboxOperationSummary {
  operationId: string;
  total: number;
  completed: number;
  dead: number;
  incomplete: number;
}

export interface ClaimDueDeletionsInput {
  workerId: string;
  leaseMs?: number;
  limit?: number;
}

export type ClaimDueReconciliationsInput = ClaimDueDeletionsInput;

export interface DeletionLeaseInput {
  id: string;
  workerId: string;
  leaseFence: number;
}

export interface DeletionReconciliationLeaseInput {
  id: string;
  workerId: string;
  reconcileFence: number;
}

export interface FailDeletionInput extends DeletionLeaseInput {
  error: unknown;
  retryable?: boolean;
  retryDelayMs?: number;
}

export interface ProcessClaimedDeletionInput {
  claim: ClaimedDeletionOutboxRecord;
  provider: ConditionalDeletionProviderV1;
  retryable?: boolean;
  retryDelayMs?: number;
  providerTimeoutMs?: number;
}

export interface ProcessDeletionReconciliationInput {
  claim: ClaimedDeletionReconciliationRecord;
  provider: ConditionalDeletionProviderV1;
  retryDelayMs?: number;
  providerTimeoutMs?: number;
}

export interface ConditionalDeletionContextV1 {
  contractVersion: typeof CONDITIONAL_DELETION_PROVIDER_CONTRACT;
  operationId: string;
  outboxRecordId: string;
  dedupeKey: string;
  idempotencyKey: string;
  bucket: string;
  objectKey: string;
  deleteType: DeletionType;
  resourceType: string;
  resourceId: string;
  targetGeneration: string;
  conditionalToken: string;
  targetFingerprint: string;
}

export interface ConditionalDeletionCapabilityProofV1 {
  contractVersion: typeof CONDITIONAL_DELETION_PROVIDER_CONTRACT;
  providerId: string;
  targetFingerprint: string;
  conditionalDelete: true;
  idempotentByIdempotencyKey: true;
  contextualAlreadyAbsent: true;
}

export interface ConditionalDeletionProviderOperationV1 {
  deadlineAt: number;
  signal: AbortSignal;
}

export interface ConditionalDeletionDispatchEvidenceV1 {
  contractVersion: typeof CONDITIONAL_DELETION_PROVIDER_CONTRACT;
  providerId: string;
  idempotencyKey: string;
  targetFingerprint: string;
  dispatchMarkedAt: number;
  providerDispatchAt: number | null;
}

export type ConditionalDeletionResultV1 =
  | {
      outcome: "deleted";
      code: "TARGET_DELETED";
      targetFingerprint: string;
      idempotencyKey: string;
      providerRequestId: string;
    }
  | {
      outcome: "target_already_absent";
      code: "TARGET_ALREADY_ABSENT";
      targetFingerprint: string;
      idempotencyKey: string;
      providerRequestId: string;
    };

export interface ConditionalDeletionProviderV1 {
  contractVersion: typeof CONDITIONAL_DELETION_PROVIDER_CONTRACT;
  providerId: string;
  conditionalDelete: true;
  idempotentByIdempotencyKey: true;
  contextualAlreadyAbsent: true;
  /**
   * The repository persists its dispatch marker before invoking either
   * provider hook. Preparation may inspect capabilities but cannot create a
   * second worker dispatch while the marker is unresolved.
   */
  prepareConditionalDelete(
    context: ConditionalDeletionContextV1,
    operation: ConditionalDeletionProviderOperationV1,
  ): Promise<ConditionalDeletionCapabilityProofV1>;
  deleteConditional(
    context: ConditionalDeletionContextV1,
    proof: ConditionalDeletionCapabilityProofV1,
    operation: ConditionalDeletionProviderOperationV1,
  ): Promise<ConditionalDeletionResultV1>;
  /**
   * Reconcile an invocation whose result was not durably acknowledged. The
   * provider must query or replay by the persisted idempotency key and return
   * the same typed receipt; it must not perform an unkeyed delete.
   */
  reconcileConditionalDelete(
    context: ConditionalDeletionContextV1,
    evidence: ConditionalDeletionDispatchEvidenceV1,
    operation: ConditionalDeletionProviderOperationV1,
  ): Promise<ConditionalDeletionResultV1>;
}

export interface DeletionOutboxRepositoryOptions {
  tableName?: string;
  idFactory?: () => string;
  clock?: () => number;
  defaultMaxRetries?: number;
  defaultLeaseMs?: number;
  defaultProviderTimeoutMs?: number;
  dispatchHeartbeatMs?: number;
  requireDispatchableParentOperation?: boolean;
}

export class DeletionOutboxError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "DeletionOutboxError";
    this.code = code;
    this.status = status;
  }
}

type RawRow = Record<string, unknown>;

interface NormalizedDeletionItem {
  resourceType: string;
  resourceId: string;
  bucket: string;
  objectKey: string;
  deleteType: DeletionType;
  targetGeneration: string;
  conditionalToken: string;
  maxRetries: number;
}

interface PreparedDeletionOperation {
  operationId: string;
  payloadHash: string;
  items: Array<NormalizedDeletionItem & { dedupeKey: string }>;
}

function inputError(message: string): never {
  throw new DeletionOutboxError(message, "DELETION_OUTBOX_INPUT_INVALID", 400);
}

function payloadConflict(): never {
  throw new DeletionOutboxError(
    "同一删除 operationId 已绑定不同的删除清单",
    "DELETION_OUTBOX_PAYLOAD_CONFLICT",
    409,
  );
}

function leaseLost(): never {
  throw new DeletionOutboxError(
    "删除任务租约已过期、转移或 fencing token 不匹配",
    "DELETION_OUTBOX_LEASE_LOST",
    409,
  );
}

function rowInvalid(): never {
  throw new DeletionOutboxError(
    "删除 outbox 持久化记录无效",
    "DELETION_OUTBOX_ROW_INVALID",
    500,
  );
}

function databaseUnavailable(): never {
  throw new DeletionOutboxError(
    "删除 outbox 持久层暂不可用",
    "DELETION_OUTBOX_STORAGE_UNAVAILABLE",
    503,
  );
}

function providerCapabilityRequired(): never {
  throw new DeletionOutboxError(
    "删除 Provider 未证明条件删除与幂等能力",
    "DELETION_OUTBOX_PROVIDER_CAPABILITY_REQUIRED",
    503,
  );
}

function providerProofInvalid(): never {
  throw new DeletionOutboxError(
    "删除 Provider 返回的条件删除证明无效",
    "DELETION_OUTBOX_PROVIDER_PROOF_INVALID",
    503,
  );
}

function providerReceiptRequired(): never {
  throw new DeletionOutboxError(
    "删除任务必须通过持久化 dispatch 标记与 Provider 回执完成",
    "DELETION_OUTBOX_PROVIDER_RECEIPT_REQUIRED",
    409,
  );
}

function providerOperationTimedOut(): Error & { code: "ETIMEDOUT" } {
  return Object.assign(new Error("删除 Provider 操作超过截止时间"), {
    name: "DeletionProviderTimeoutError",
    code: "ETIMEDOUT" as const,
  });
}

function nonEmptyText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") inputError(`${name} 必须是字符串`);
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    inputError(`${name} 无效`);
  }
  return normalized;
}

function persistedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") rowInvalid();
  const normalized = value.trim();
  if (
    !normalized
    || normalized !== value
    || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    rowInvalid();
  }
  return normalized;
}

const STORAGE_KEY_SECRET_SENTINELS = [
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "ID_TOKEN",
  "SESSION_TOKEN",
  "SECURITY_TOKEN",
  "API_KEY",
  "APIKEY",
  "SECRET_ACCESS_KEY",
  "AWSACCESSKEYID",
  "AUTHORIZATION",
  "BEARER",
  "CREDENTIAL",
  "SIGNATURE=",
  "X-AMZ-SIGNATURE",
  "X-AMZ-CREDENTIAL",
  "X-GOOG-SIGNATURE",
  "X-GOOG-CREDENTIAL",
  "GOOG4-RSA-SHA256",
  "AKLT",
] as const;

function containsCredentialSentinel(value: string): boolean {
  const upper = value.toUpperCase();
  return STORAGE_KEY_SECRET_SENTINELS.some((sentinel) => upper.includes(sentinel));
}

function validateCanonicalObjectKey(
  value: unknown,
  deleteType: DeletionType,
  invalid: () => never,
): string {
  if (typeof value !== "string") invalid();
  if (
    !value
    || value.length > 4096
    || value !== value.trim()
    || /[\u0000-\u001f\u007f\\?#]/u.test(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|23|25|2e|2f|3a|3f|5c)/iu.test(value)
    || value.startsWith("/")
    || value.includes("//")
    || containsCredentialSentinel(value)
  ) {
    invalid();
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    invalid();
  }
  if (
    decoded !== value
    && (
      /[\u0000-\u001f\u007f\\?#]/u.test(decoded)
      || /^[a-z][a-z0-9+.-]*:/iu.test(decoded)
      || decoded.startsWith("/")
      || containsCredentialSentinel(decoded)
    )
  ) {
    invalid();
  }
  const normalizedSegments = value.endsWith("/") ? value.slice(0, -1).split("/") : value.split("/");
  const decodedSegments = decoded.endsWith("/") ? decoded.slice(0, -1).split("/") : decoded.split("/");
  if (
    normalizedSegments.length === 0
    || normalizedSegments.some((segment) => !segment || segment === "." || segment === "..")
    || decodedSegments.some((segment) => !segment || segment === "." || segment === "..")
    || (deleteType === "prefix" && !value.endsWith("/"))
    || (deleteType === "file" && value.endsWith("/"))
  ) {
    invalid();
  }
  return value;
}

function inputObjectKey(value: unknown, deleteType: DeletionType): string {
  return validateCanonicalObjectKey(value, deleteType, () => inputError("objectKey 无效"));
}

function persistedObjectKey(value: unknown, deleteType: DeletionType): string {
  return validateCanonicalObjectKey(value, deleteType, rowInvalid);
}

function canonicalBucket(value: unknown, invalid: () => never): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (
    normalized !== value
    || normalized.length < 1
    || normalized.length > 255
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(normalized)
    || /^https?:/iu.test(normalized)
    || containsCredentialSentinel(normalized)
  ) {
    invalid();
  }
  return normalized;
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    inputError(`${name} 必须是有效正整数`);
  }
  return number;
}

function boundedNonNegativeInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    inputError(`${name} 必须是有效非负整数`);
  }
  return number;
}

function persistedNonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) rowInvalid();
  return number;
}

function optionalTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return persistedNonNegativeInteger(value);
}

function optionalPersistedText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  return persistedText(value, maxLength);
}

function checkedAdd(left: number, right: number, invalid: () => never): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) invalid();
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) invalid();
  return result;
}

function checkedIncrement(value: number, invalid: () => never): number {
  return checkedAdd(value, 1, invalid);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function itemIdentity(item: NormalizedDeletionItem): string {
  return JSON.stringify([
    item.resourceType,
    item.resourceId,
    item.bucket,
    item.objectKey,
    item.deleteType,
    item.targetGeneration,
    item.conditionalToken,
  ]);
}

function normalizeItems(
  items: readonly DeletionOutboxItem[],
  defaultMaxRetries: number,
): NormalizedDeletionItem[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > 10_000) {
    inputError("items 必须包含 1-10000 个删除目标");
  }
  const unique = new Map<string, NormalizedDeletionItem>();
  for (const item of items) {
    if (!item || typeof item !== "object") inputError("删除目标无效");
    const deleteType = item.deleteType;
    if (deleteType !== "file" && deleteType !== "prefix") inputError("deleteType 无效");
    const normalized: NormalizedDeletionItem = {
      resourceType: nonEmptyText(item.resourceType, "resourceType", 100),
      resourceId: nonEmptyText(item.resourceId, "resourceId", 255),
      bucket: canonicalBucket(item.bucket, () => inputError("bucket 无效")),
      objectKey: inputObjectKey(item.objectKey, deleteType),
      deleteType,
      targetGeneration: nonEmptyText(item.targetGeneration, "targetGeneration", 512),
      conditionalToken: nonEmptyText(item.conditionalToken, "conditionalToken", 2048),
      maxRetries: boundedNonNegativeInteger(
        item.maxRetries ?? defaultMaxRetries,
        "maxRetries",
        100,
      ),
    };
    const identity = itemIdentity(normalized);
    const duplicate = unique.get(identity);
    if (duplicate && duplicate.maxRetries !== normalized.maxRetries) {
      inputError("同一删除目标不能声明不同的 maxRetries");
    }
    unique.set(identity, normalized);
  }
  return [...unique.values()].sort((left, right) => {
    const leftIdentity = itemIdentity(left);
    const rightIdentity = itemIdentity(right);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
}

function prepareOperation(
  input: EnqueueDeletionOperationInput,
  defaultMaxRetries: number,
): PreparedDeletionOperation {
  const operationId = nonEmptyText(input.operationId, "operationId", 255);
  const items = normalizeItems(input.items, defaultMaxRetries);
  const canonicalPayload = JSON.stringify({
    version: "deletion-outbox/v1",
    operationId,
    items: items.map((item) => ({
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      bucket: item.bucket,
      objectKey: item.objectKey,
      deleteType: item.deleteType,
      targetGeneration: item.targetGeneration,
      conditionalToken: item.conditionalToken,
      maxRetries: item.maxRetries,
    })),
  });
  const payloadHash = sha256(canonicalPayload);
  return {
    operationId,
    payloadHash,
    items: items.map((item, index) => ({
      ...item,
      // Ordinal identity makes every replay of an operation collide on the
      // same UNIQUE key, including a replay whose payload has changed.
      dedupeKey: sha256(`deletion-outbox/item/v1\0${operationId}\0${index}`),
    })),
  };
}

function prepareAppendOperation(
  input: EnqueueDeletionOperationInput,
  defaultMaxRetries: number,
): PreparedDeletionOperation {
  const operationId = nonEmptyText(input.operationId, "operationId", 255);
  const items = normalizeItems(input.items, defaultMaxRetries);
  const canonicalPayload = JSON.stringify({
    version: "deletion-outbox/append/v1",
    operationId,
    items: items.map((item) => ({
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      bucket: item.bucket,
      objectKey: item.objectKey,
      deleteType: item.deleteType,
      targetGeneration: item.targetGeneration,
      conditionalToken: item.conditionalToken,
      maxRetries: item.maxRetries,
    })),
  });
  const payloadHash = sha256(canonicalPayload);
  return {
    operationId,
    payloadHash,
    items: items.map((item) => ({
      ...item,
      // Append batches must converge on the same durable row even when two
      // finalizers discover the same generation concurrently.
      dedupeKey: sha256(
        `deletion-outbox/append-item/v1\0${operationId}\0${itemIdentity(item)}`,
      ),
    })),
  };
}

function mapRecord(row: RawRow): DeletionOutboxRecord {
  const status = String(row.status || "") as DeletionOutboxStatus;
  if (![
    "pending",
    "leased",
    "dispatching",
    "pending_reconcile",
    "failed_retryable",
    "completed",
    "dead",
  ].includes(status)) rowInvalid();
  const deleteType = String(row.deleteType || "") as DeletionType;
  if (deleteType !== "file" && deleteType !== "prefix") rowInvalid();
  const errorCode = row.errorCode === null || row.errorCode === undefined
    ? null
    : String(row.errorCode) as DeletionOutboxErrorCode;
  if (errorCode !== null && !DELETION_ERROR_CODES.has(errorCode)) rowInvalid();
  const retryCount = persistedNonNegativeInteger(row.retryCount, 101);
  const maxRetries = persistedNonNegativeInteger(row.maxRetries, 100);
  const leaseFence = persistedNonNegativeInteger(row.leaseFence);
  const reconcileFence = persistedNonNegativeInteger(row.reconcileFence);
  const reconcileRetryCount = persistedNonNegativeInteger(row.reconcileRetryCount, 101);
  const nextAttemptAt = persistedNonNegativeInteger(row.nextAttemptAt);
  const createdAt = persistedNonNegativeInteger(row.createdAt);
  const updatedAt = persistedNonNegativeInteger(row.updatedAt);
  const leaseExpiresAt = optionalTimestamp(row.leaseExpiresAt);
  const reconcileExpiresAt = optionalTimestamp(row.reconcileExpiresAt);
  const completedAt = optionalTimestamp(row.completedAt);
  const leaseOwner = row.leaseOwner === null || row.leaseOwner === undefined
    ? null
    : persistedText(row.leaseOwner, 255);
  const reconcileOwner = optionalPersistedText(row.reconcileOwner, 255);
  const dispatchProviderId = optionalPersistedText(row.dispatchProviderId, 255);
  const dispatchIdempotencyKey = optionalPersistedText(row.dispatchIdempotencyKey, 64);
  const dispatchTargetFingerprint = optionalPersistedText(row.dispatchTargetFingerprint, 64);
  const dispatchMarkedAt = optionalTimestamp(row.dispatchMarkedAt);
  const providerDispatchAt = optionalTimestamp(row.providerDispatchAt);
  const providerReceiptOutcome = row.providerReceiptOutcome === null
      || row.providerReceiptOutcome === undefined
    ? null
    : String(row.providerReceiptOutcome) as DeletionOutboxRecord["providerReceiptOutcome"];
  const providerReceiptCode = row.providerReceiptCode === null
      || row.providerReceiptCode === undefined
    ? null
    : String(row.providerReceiptCode) as DeletionOutboxRecord["providerReceiptCode"];
  const providerRequestId = optionalPersistedText(row.providerRequestId, 512);
  const providerReceiptAt = optionalTimestamp(row.providerReceiptAt);
  const maximumTerminalRetryCount = checkedAdd(maxRetries, 1, rowInvalid);
  const maximumTerminalReconcileRetryCount = checkedAdd(maxRetries, 1, rowInvalid);
  const hasDispatchEvidenceCore = dispatchIdempotencyKey !== null
    && dispatchTargetFingerprint !== null
    && dispatchMarkedAt !== null;
  const hasAnyDispatchEvidenceCore = dispatchIdempotencyKey !== null
    || dispatchTargetFingerprint !== null
    || dispatchMarkedAt !== null;
  const hasBoundDispatchEvidence = dispatchProviderId !== null
    && hasDispatchEvidenceCore;
  const hasAnyDispatchEvidence = dispatchProviderId !== null
    || hasAnyDispatchEvidenceCore;
  const hasReceipt = providerReceiptOutcome !== null
    && providerReceiptCode !== null
    && providerRequestId !== null
    && providerReceiptAt !== null;
  const hasAnyReceipt = providerReceiptOutcome !== null
    || providerReceiptCode !== null
    || providerRequestId !== null
    || providerReceiptAt !== null;
  const receiptPairValid =
    providerReceiptOutcome === "deleted" && providerReceiptCode === "TARGET_DELETED"
    || providerReceiptOutcome === "target_already_absent"
      && providerReceiptCode === "TARGET_ALREADY_ABSENT";
  const reconcileLeaseComplete =
    reconcileOwner === null && reconcileExpiresAt === null
    || reconcileOwner !== null && reconcileExpiresAt !== null;
  const dispatchLeaseComplete =
    leaseOwner === null && leaseExpiresAt === null
    || leaseOwner !== null && leaseExpiresAt !== null;
  if (
    (status === "dead" ? retryCount > maximumTerminalRetryCount : retryCount > maxRetries)
    || (status === "dead"
      ? reconcileRetryCount > maximumTerminalReconcileRetryCount
      : reconcileRetryCount > maxRetries)
    || (status === "pending" && (retryCount !== 0 || errorCode !== null))
    || !dispatchLeaseComplete
    || ((status === "leased" || status === "dispatching") && (!leaseOwner || leaseExpiresAt === null))
    // D4 briefly persisted pending_reconcile while retaining the dispatch
    // lease. Accept that complete legacy pair only long enough for the
    // reconciliation claim transition to clear it atomically.
    || (!["leased", "dispatching", "pending_reconcile"].includes(status)
      && (leaseOwner !== null || leaseExpiresAt !== null))
    || !reconcileLeaseComplete
    || (status !== "pending_reconcile" && (reconcileOwner !== null || reconcileExpiresAt !== null))
    || (status === "completed" && completedAt === null)
    || (status !== "completed" && completedAt !== null)
    || (status === "completed" && errorCode !== null)
    || (["failed_retryable", "dead"].includes(status) && errorCode === null)
    || (status === "failed_retryable" && retryCount === 0)
    || (status === "dispatching" && errorCode !== null)
    || (status === "pending_reconcile" && errorCode !== "dispatch_outcome_unknown")
    || (hasAnyDispatchEvidenceCore !== hasDispatchEvidenceCore)
    || (hasAnyDispatchEvidence !== hasBoundDispatchEvidence)
    || (["pending", "leased", "failed_retryable"].includes(status)
      && hasAnyDispatchEvidence)
    || (hasDispatchEvidenceCore && (
      !/^[a-f0-9]{64}$/u.test(dispatchIdempotencyKey!)
      || !/^[a-f0-9]{64}$/u.test(dispatchTargetFingerprint!)
    ))
    || (providerDispatchAt !== null && (
      !hasDispatchEvidenceCore
      || providerDispatchAt < dispatchMarkedAt!
    ))
    || (hasAnyReceipt !== hasReceipt)
    || (hasReceipt && (
      status !== "completed"
      || !hasBoundDispatchEvidence
      || providerDispatchAt === null
      || !receiptPairValid
      || providerReceiptAt! < providerDispatchAt
    ))
    || (!hasReceipt && hasAnyReceipt)
  ) {
    rowInvalid();
  }
  const dedupeKey = persistedText(row.dedupeKey, 64);
  const payloadHash = persistedText(row.payloadHash, 64);
  if (!/^[a-f0-9]{64}$/u.test(dedupeKey) || !/^[a-f0-9]{64}$/u.test(payloadHash)) rowInvalid();
  return {
    id: persistedText(row.id, 255),
    operationId: persistedText(row.operationId, 255),
    dedupeKey,
    payloadHash,
    resourceType: persistedText(row.resourceType, 100),
    resourceId: persistedText(row.resourceId, 255),
    bucket: canonicalBucket(row.bucket, rowInvalid),
    objectKey: persistedObjectKey(row.objectKey, deleteType),
    deleteType,
    targetGeneration: persistedText(row.targetGeneration, 512),
    conditionalToken: persistedText(row.conditionalToken, 2048),
    status,
    errorCode,
    retryCount,
    maxRetries,
    nextAttemptAt,
    leaseOwner,
    leaseExpiresAt,
    leaseFence,
    reconcileOwner,
    reconcileExpiresAt,
    reconcileFence,
    reconcileRetryCount,
    dispatchProviderId,
    dispatchIdempotencyKey,
    dispatchTargetFingerprint,
    dispatchMarkedAt,
    providerDispatchAt,
    providerReceiptOutcome,
    providerReceiptCode,
    providerRequestId,
    providerReceiptAt,
    createdAt,
    updatedAt,
    completedAt,
  };
}

function asClaimed(row: RawRow): ClaimedDeletionOutboxRecord {
  const record = mapRecord(row);
  if (record.status !== "leased" || !record.leaseOwner || record.leaseExpiresAt === null) rowInvalid();
  return record as ClaimedDeletionOutboxRecord;
}

function asDispatched(row: RawRow): DispatchedDeletionOutboxRecord {
  const record = mapRecord(row);
  if (
    record.status !== "dispatching"
    || !record.leaseOwner
    || record.leaseExpiresAt === null
    || !record.dispatchProviderId
    || !record.dispatchIdempotencyKey
    || !record.dispatchTargetFingerprint
    || record.dispatchMarkedAt === null
  ) {
    rowInvalid();
  }
  const dispatched = record as DispatchedDeletionOutboxRecord;
  assertDispatchEvidenceMatches(dispatched);
  return dispatched;
}

function asClaimedReconciliation(row: RawRow): ClaimedDeletionReconciliationRecord {
  const record = mapRecord(row);
  if (
    record.status !== "pending_reconcile"
    || !record.reconcileOwner
    || record.reconcileExpiresAt === null
    || record.leaseOwner !== null
    || record.leaseExpiresAt !== null
    || !record.dispatchProviderId
    || !record.dispatchIdempotencyKey
    || !record.dispatchTargetFingerprint
    || record.dispatchMarkedAt === null
  ) {
    rowInvalid();
  }
  const reconciliation = record as ClaimedDeletionReconciliationRecord;
  assertDispatchEvidenceMatches(reconciliation);
  return reconciliation;
}

function assertCallerTransaction(transaction: Knex.Transaction): void {
  if (!(transaction as unknown as { isTransaction?: boolean }).isTransaction) {
    throw new DeletionOutboxError(
      "删除 outbox 必须写入调用方提供的 transaction",
      "DELETION_OUTBOX_TRANSACTION_REQUIRED",
      500,
    );
  }
}

function isPostgres(database: Knex): boolean {
  const client = String((database.client.config as { client?: unknown }).client || "").toLowerCase();
  return client === "pg" || client.includes("postgres");
}

function isSqliteContention(error: unknown): boolean {
  const code = error && typeof error === "object"
    ? String((error as { code?: unknown }).code || "").toUpperCase()
    : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function briefContentionBackoff(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(20, 2 ** attempt));
  });
}

function applyDuePredicate(query: Knex.QueryBuilder, now: number): Knex.QueryBuilder {
  return query
    .where((eligible) => {
      eligible
        .where((due) => {
          due
            .whereIn("status", ["pending", "failed_retryable"])
            .andWhere("nextAttemptAt", "<=", now);
        })
        .orWhere((expired) => {
          expired
            .whereIn("status", ["leased", "dispatching"])
            .andWhere("leaseExpiresAt", "<=", now);
        });
    })
    .andWhereRaw("?? <= ??", ["retryCount", "maxRetries"]);
}

function applyDueReconciliationPredicate(
  query: Knex.QueryBuilder,
  now: number,
): Knex.QueryBuilder {
  return query
    .where({ status: "pending_reconcile" })
    .andWhere((dispatchLeaseEligible) => {
      dispatchLeaseEligible
        .where((unleased) => {
          unleased
            .whereNull("leaseOwner")
            .whereNull("leaseExpiresAt");
        })
        .orWhere((expired) => {
          expired
            .whereNotNull("leaseOwner")
            .whereNotNull("leaseExpiresAt")
            .andWhere("leaseExpiresAt", "<=", now);
        });
    })
    .andWhere((eligible) => {
      eligible
        .where((due) => {
          due
            .whereNull("reconcileOwner")
            .whereNull("reconcileExpiresAt")
            .andWhere("nextAttemptAt", "<=", now);
        })
        .orWhere((expired) => {
          expired
            .whereNotNull("reconcileOwner")
            .whereNotNull("reconcileExpiresAt")
            .andWhere("reconcileExpiresAt", "<=", now);
        });
    })
    .andWhereRaw("?? <= ??", ["reconcileRetryCount", "maxRetries"]);
}

export function deletionOutboxErrorCode(error: unknown): DeletionOutboxErrorCode {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown }
    : {};
  const code = String(candidate.code || candidate.name || "").trim().toUpperCase();
  const name = String(candidate.name || "").trim().toUpperCase();
  const status = Number(candidate.statusCode ?? candidate.status);
  if (status === 401) return "storage_authentication_failed";
  if (status === 403 || code === "EACCES" || code === "EPERM" || code === "ACCESSDENIED") {
    return "storage_access_denied";
  }
  if (
    status === 408
    || name === "ABORTERROR"
    || code === "ETIMEDOUT"
    || code === "ESOCKETTIMEDOUT"
  ) {
    return "storage_request_timeout";
  }
  if (status === 425 || status === 429 || code === "THROTTLING" || code === "SLOWDOWN") {
    return "storage_rate_limited";
  }
  if (status >= 500 && status <= 599) return "storage_service_unavailable";
  if (["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(code)) {
    return "storage_transport_failed";
  }
  return "storage_delete_failed";
}

function retryDelayMs(retryCount: number): number {
  return Math.min(6 * 60 * 60_000, 1_000 * 2 ** Math.min(20, Math.max(0, retryCount - 1)));
}

function targetFingerprint(record: DeletionOutboxRecord): string {
  return sha256(JSON.stringify({
    version: CONDITIONAL_DELETION_PROVIDER_CONTRACT,
    operationId: record.operationId,
    bucket: record.bucket,
    objectKey: record.objectKey,
    deleteType: record.deleteType,
    targetGeneration: record.targetGeneration,
    conditionalToken: record.conditionalToken,
  }));
}

function dispatchIdempotencyKeyForDomain(
  record: DeletionOutboxRecord,
  domain: typeof LEGACY_DISPATCH_IDEMPOTENCY_DOMAIN
    | typeof CURRENT_DISPATCH_IDEMPOTENCY_DOMAIN,
): string {
  return sha256(
    `${domain}\0${record.dedupeKey}\0${record.targetGeneration}`,
  );
}

function currentDispatchIdempotencyKey(record: DeletionOutboxRecord): string {
  return dispatchIdempotencyKeyForDomain(record, CURRENT_DISPATCH_IDEMPOTENCY_DOMAIN);
}

function dispatchBoundaryProtocol(record: DeletionOutboxRecord): DispatchBoundaryProtocol {
  if (
    record.dispatchIdempotencyKey
    === dispatchIdempotencyKeyForDomain(record, CURRENT_DISPATCH_IDEMPOTENCY_DOMAIN)
  ) {
    return "current-v2";
  }
  if (
    record.dispatchIdempotencyKey
    === dispatchIdempotencyKeyForDomain(record, LEGACY_DISPATCH_IDEMPOTENCY_DOMAIN)
  ) {
    return "legacy-v1";
  }
  return "unknown";
}

function providerContext(
  record:
    | ClaimedDeletionOutboxRecord
    | DispatchedDeletionOutboxRecord
    | ClaimedDeletionReconciliationRecord,
): ConditionalDeletionContextV1 {
  const idempotencyKey = record.dispatchIdempotencyKey
    ?? currentDispatchIdempotencyKey(record);
  if (
    record.dispatchIdempotencyKey !== null
    && dispatchBoundaryProtocol(record) === "unknown"
  ) {
    rowInvalid();
  }
  return Object.freeze({
    contractVersion: CONDITIONAL_DELETION_PROVIDER_CONTRACT,
    operationId: record.operationId,
    outboxRecordId: record.id,
    dedupeKey: record.dedupeKey,
    // Existing N-1 evidence must keep its original provider idempotency
    // identity. New claims use the v2 key as a durable pre-call boundary.
    idempotencyKey,
    bucket: record.bucket,
    objectKey: record.objectKey,
    deleteType: record.deleteType,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    targetGeneration: record.targetGeneration,
    conditionalToken: record.conditionalToken,
    targetFingerprint: targetFingerprint(record),
  });
}

function dispatchEvidence(
  record: DispatchedDeletionOutboxRecord | ClaimedDeletionReconciliationRecord,
): ConditionalDeletionDispatchEvidenceV1 {
  return Object.freeze({
    contractVersion: CONDITIONAL_DELETION_PROVIDER_CONTRACT,
    providerId: record.dispatchProviderId,
    idempotencyKey: record.dispatchIdempotencyKey,
    targetFingerprint: record.dispatchTargetFingerprint,
    dispatchMarkedAt: record.dispatchMarkedAt,
    providerDispatchAt: record.providerDispatchAt,
  });
}

function assertDispatchEvidenceMatches(
  record:
    | DispatchedDeletionOutboxRecord
    | ClaimedDeletionReconciliationRecord,
): void {
  const context = providerContext(record);
  if (
    dispatchBoundaryProtocol(record) === "unknown"
    || record.dispatchIdempotencyKey !== context.idempotencyKey
    || record.dispatchTargetFingerprint !== context.targetFingerprint
  ) {
    rowInvalid();
  }
}

function validateProvider(provider: unknown): asserts provider is ConditionalDeletionProviderV1 {
  const candidate = provider && typeof provider === "object"
    ? provider as Partial<ConditionalDeletionProviderV1>
    : null;
  if (
    !candidate
    || candidate.contractVersion !== CONDITIONAL_DELETION_PROVIDER_CONTRACT
    || typeof candidate.providerId !== "string"
    || !candidate.providerId.trim()
    || candidate.providerId !== candidate.providerId.trim()
    || candidate.providerId.length > 255
    || /[\u0000-\u001f\u007f]/u.test(candidate.providerId)
    || containsCredentialSentinel(candidate.providerId)
    || candidate.conditionalDelete !== true
    || candidate.idempotentByIdempotencyKey !== true
    || candidate.contextualAlreadyAbsent !== true
    || typeof candidate.prepareConditionalDelete !== "function"
    || typeof candidate.deleteConditional !== "function"
    || typeof candidate.reconcileConditionalDelete !== "function"
  ) {
    providerCapabilityRequired();
  }
}

function validateCapabilityProof(
  proof: ConditionalDeletionCapabilityProofV1,
  provider: ConditionalDeletionProviderV1,
  record: DeletionOutboxRecord,
): void {
  if (
    !proof
    || proof.contractVersion !== CONDITIONAL_DELETION_PROVIDER_CONTRACT
    || proof.providerId !== provider.providerId
    || proof.targetFingerprint !== targetFingerprint(record)
    || proof.conditionalDelete !== true
    || proof.idempotentByIdempotencyKey !== true
    || proof.contextualAlreadyAbsent !== true
  ) {
    providerProofInvalid();
  }
}

function validateDeletionResult(
  result: ConditionalDeletionResultV1,
  expectedContext: ConditionalDeletionContextV1,
): void {
  const validOutcome = result?.outcome === "deleted" && result.code === "TARGET_DELETED"
    || result?.outcome === "target_already_absent" && result.code === "TARGET_ALREADY_ABSENT";
  if (
    !validOutcome
    || result.targetFingerprint !== expectedContext.targetFingerprint
    || result.idempotencyKey !== expectedContext.idempotencyKey
    || typeof result.providerRequestId !== "string"
    || !result.providerRequestId.trim()
    || result.providerRequestId !== result.providerRequestId.trim()
    || result.providerRequestId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(result.providerRequestId)
    || containsCredentialSentinel(result.providerRequestId)
  ) {
    providerProofInvalid();
  }
}

export class DeletionOutboxRepository {
  private readonly tableName: string;
  private readonly idFactory: () => string;
  private readonly clock: () => number;
  private readonly defaultMaxRetries: number;
  private readonly defaultLeaseMs: number;
  private readonly defaultProviderTimeoutMs: number;
  private readonly dispatchHeartbeatMs: number;
  private readonly requireDispatchableParentOperation: boolean;
  private lastObservedNow = -1;

  constructor(
    private readonly database: Knex,
    options: DeletionOutboxRepositoryOptions = {},
  ) {
    this.tableName = options.tableName || DELETION_OUTBOX_TABLE;
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.clock = options.clock || (() => Date.now());
    this.defaultMaxRetries = boundedNonNegativeInteger(
      options.defaultMaxRetries ?? 5,
      "defaultMaxRetries",
      100,
    );
    this.defaultLeaseMs = positiveInteger(options.defaultLeaseMs ?? 60_000, "defaultLeaseMs", 24 * 60 * 60_000);
    this.defaultProviderTimeoutMs = positiveInteger(
      options.defaultProviderTimeoutMs ?? 30_000,
      "defaultProviderTimeoutMs",
      24 * 60 * 60_000,
    );
    this.dispatchHeartbeatMs = positiveInteger(
      options.dispatchHeartbeatMs
        ?? Math.max(1, Math.floor(this.defaultLeaseMs / 3)),
      "dispatchHeartbeatMs",
      this.defaultLeaseMs,
    );
    this.requireDispatchableParentOperation =
      options.requireDispatchableParentOperation === true;
  }

  private now(): number {
    const observed = Number(this.clock());
    if (
      !Number.isSafeInteger(observed)
      || observed < 0
      || observed < this.lastObservedNow
    ) {
      throw new DeletionOutboxError(
        "删除 outbox 时钟无效或发生倒退",
        "DELETION_OUTBOX_CLOCK_INVALID",
        500,
      );
    }
    this.lastObservedNow = observed;
    return observed;
  }

  manifestChunkContentHash(
    input: EnqueueDeletionOperationInput,
  ): string {
    const operationId = nonEmptyText(
      input.operationId,
      "operationId",
      255,
    );
    if (!Array.isArray(input.items) || input.items.length > 500) {
      inputError("manifest chunk items 必须包含 0-500 个删除目标");
    }
    if (input.items.length === 0) {
      return sha256(JSON.stringify({
        version: "deletion-outbox/append/v1",
        operationId,
        items: [],
      }));
    }
    return prepareAppendOperation(
      { operationId, items: input.items },
      this.defaultMaxRetries,
    ).payloadHash;
  }

  private async withDatabaseBoundary<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DeletionOutboxError) throw error;
      databaseUnavailable();
    }
  }

  private applyDispatchableParentPredicate(
    query: Knex.QueryBuilder,
    phase: "dispatch" | "reconcile",
  ): Knex.QueryBuilder {
    if (!this.requireDispatchableParentOperation) return query;
    const operationTable = "o_deletion_operation";
    const checkpointTable = "o_deletion_operation_checkpoint";
    const parent = query.client
      .queryBuilder()
      .select(query.client.raw("1"))
      .from({ parentOperation: operationTable })
      .whereRaw("?? = ??", [
        "parentOperation.id",
        `${this.tableName}.operationId`,
      ])
      .whereIn(
        "parentOperation.status",
        phase === "dispatch"
          ? ["deleting"]
          : ["deleting", "blocked"],
      )
      .andWhere((kind) => {
        kind
          .whereIn("parentOperation.kind", ["image", "asset"])
          .orWhere((project) => {
            project
              .where("parentOperation.kind", "project")
              .whereExists(
                query.client
                  .queryBuilder()
                  .select(query.client.raw("1"))
                  .from({ checkpoint: checkpointTable })
                  .whereRaw("?? = ??", [
                    "checkpoint.operationId",
                    "parentOperation.id",
                  ])
                  .whereIn("checkpoint.phase", [
                    "dispatch",
                    "verify",
                  ])
                  .whereRaw("?? = ??", [
                    "checkpoint.manifestItemCount",
                    "parentOperation.expectedItemCount",
                  ])
                  .whereRaw("?? = ??", [
                    "checkpoint.manifestChainHash",
                    "parentOperation.manifestHash",
                  ]),
              );
          });
      });
    return query.whereExists(
      parent
    );
  }

  private dispatchDueQuery(
    query: Knex.QueryBuilder,
    currentTime: number,
  ): Knex.QueryBuilder {
    return this.applyDispatchableParentPredicate(
      applyDuePredicate(query, currentTime),
      "dispatch",
    );
  }

  private reconciliationDueQuery(
    query: Knex.QueryBuilder,
    currentTime: number,
  ): Knex.QueryBuilder {
    return this.applyDispatchableParentPredicate(
      applyDueReconciliationPredicate(query, currentTime),
      "reconcile",
    );
  }

  async enqueueInTransaction(
    transaction: Knex.Transaction,
    input: EnqueueDeletionOperationInput,
  ): Promise<EnqueueDeletionOperationResult> {
    assertCallerTransaction(transaction);
    const prepared = prepareOperation(input, this.defaultMaxRetries);
    const now = this.now();

    // A savepoint prevents a caller that intentionally catches a payload
    // conflict from accidentally committing rows inserted before detection.
    return this.withDatabaseBoundary(() => transaction.transaction(async (savepoint) => {
      const existing = await savepoint(this.tableName)
        .where({ operationId: prepared.operationId })
        .orderBy("dedupeKey", "asc");
      if (existing.length > 0) return this.replay(prepared, existing, true);

      const rows = prepared.items.map((item) => ({
        id: this.idFactory(),
        operationId: prepared.operationId,
        dedupeKey: item.dedupeKey,
        payloadHash: prepared.payloadHash,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        bucket: item.bucket,
        objectKey: item.objectKey,
        deleteType: item.deleteType,
        targetGeneration: item.targetGeneration,
        conditionalToken: item.conditionalToken,
        status: "pending",
        errorCode: null,
        retryCount: 0,
        maxRetries: item.maxRetries,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseFence: 0,
        reconcileOwner: null,
        reconcileExpiresAt: null,
        reconcileFence: 0,
        reconcileRetryCount: 0,
        dispatchProviderId: null,
        dispatchIdempotencyKey: null,
        dispatchTargetFingerprint: null,
        dispatchMarkedAt: null,
        providerDispatchAt: null,
        providerReceiptOutcome: null,
        providerReceiptCode: null,
        providerRequestId: null,
        providerReceiptAt: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }));

      for (
        let offset = 0;
        offset < rows.length;
        offset += DELETION_OUTBOX_INSERT_CHUNK_SIZE
      ) {
        await savepoint(this.tableName)
          .insert(rows.slice(
            offset,
            offset + DELETION_OUTBOX_INSERT_CHUNK_SIZE,
          ))
          .onConflict("dedupeKey")
          .ignore();
      }

      const persisted = await savepoint(this.tableName)
        .where({ operationId: prepared.operationId })
        .orderBy("dedupeKey", "asc");
      const replayed = this.replay(prepared, persisted, false);
      const expectedIds = new Set(rows.map((row) => row.id));
      const allCreatedByThisCall = replayed.records.every((row) => expectedIds.has(row.id));
      const noneCreatedByThisCall = replayed.records.every((row) => !expectedIds.has(row.id));
      if (!allCreatedByThisCall && !noneCreatedByThisCall) payloadConflict();
      return { ...replayed, idempotent: noneCreatedByThisCall };
    }));
  }

  async findManifestChunkItemsInTransaction(
    transaction: Knex.Transaction,
    input: EnqueueDeletionOperationInput,
  ): Promise<DeletionOutboxRecord[]> {
    assertCallerTransaction(transaction);
    const prepared = prepareAppendOperation(
      input,
      this.defaultMaxRetries,
    );
    if (prepared.items.length > 500) {
      inputError("manifest chunk items 不能超过 500");
    }
    return this.withDatabaseBoundary(async () => {
      const rows = (
        await transaction(this.tableName)
          .where({ operationId: prepared.operationId })
          .whereIn(
            "dedupeKey",
            prepared.items.map((item) => item.dedupeKey),
          )
      ).map(mapRecord);
      const byDedupeKey = new Map(
        rows.map((record) => [record.dedupeKey, record]),
      );
      const result: DeletionOutboxRecord[] = [];
      for (const item of prepared.items) {
        const record = byDedupeKey.get(item.dedupeKey);
        if (!record) continue;
        if (
          record.operationId !== prepared.operationId
          || itemIdentity(record) !== itemIdentity(item)
          || record.maxRetries !== item.maxRetries
        ) {
          payloadConflict();
        }
        result.push(record);
      }
      return result;
    });
  }

  /**
   * Append one provider page without reading the operation's historical
   * outbox. The chunk store caller must compare the aggregate count with its
   * current checkpoint before and after invoking this method in the same
   * transaction.
   */
  async appendManifestChunkInTransaction(
    transaction: Knex.Transaction,
    input: AppendDeletionManifestChunkInput,
  ): Promise<AppendDeletionOperationResult> {
    assertCallerTransaction(transaction);
    const prepared = prepareAppendOperation(
      input,
      this.defaultMaxRetries,
    );
    if (prepared.items.length > 500) {
      inputError("manifest chunk items 不能超过 500");
    }
    const contentHash = nonEmptyText(
      input.contentHash,
      "contentHash",
      64,
    );
    if (
      !/^[a-f0-9]{64}$/u.test(contentHash)
      || contentHash !== prepared.payloadHash
    ) {
      payloadConflict();
    }
    const now = this.now();

    return this.withDatabaseBoundary(() =>
      transaction.transaction(async (savepoint) => {
        const existing = await this.findManifestChunkItemsInTransaction(
          savepoint,
          {
            operationId: prepared.operationId,
            items: input.items,
          },
        );
        const existingKeys = new Set(
          existing.map((record) => record.dedupeKey),
        );
        const rows = prepared.items
          .filter((item) => !existingKeys.has(item.dedupeKey))
          .map((item) => ({
            id: this.idFactory(),
            operationId: prepared.operationId,
            dedupeKey: item.dedupeKey,
            payloadHash: prepared.payloadHash,
            resourceType: item.resourceType,
            resourceId: item.resourceId,
            bucket: item.bucket,
            objectKey: item.objectKey,
            deleteType: item.deleteType,
            targetGeneration: item.targetGeneration,
            conditionalToken: item.conditionalToken,
            status: "pending",
            errorCode: null,
            retryCount: 0,
            maxRetries: item.maxRetries,
            nextAttemptAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            leaseFence: 0,
            reconcileOwner: null,
            reconcileExpiresAt: null,
            reconcileFence: 0,
            reconcileRetryCount: 0,
            dispatchProviderId: null,
            dispatchIdempotencyKey: null,
            dispatchTargetFingerprint: null,
            dispatchMarkedAt: null,
            providerDispatchAt: null,
            providerReceiptOutcome: null,
            providerReceiptCode: null,
            providerRequestId: null,
            providerReceiptAt: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
          }));
        if (rows.length) {
          await savepoint(this.tableName)
            .insert(rows)
            .onConflict("dedupeKey")
            .ignore();
        }
        const records = await this.findManifestChunkItemsInTransaction(
          savepoint,
          {
            operationId: prepared.operationId,
            items: input.items,
          },
        );
        if (records.length !== prepared.items.length) payloadConflict();
        for (const record of records) {
          if (record.payloadHash !== prepared.payloadHash) {
            payloadConflict();
          }
        }
        const insertedIds = new Set(rows.map((row) => row.id));
        const addedRecords = records.filter((record) =>
          insertedIds.has(record.id));
        if (
          addedRecords.length !== 0
          && addedRecords.length !== rows.length
        ) {
          payloadConflict();
        }
        return {
          operationId: prepared.operationId,
          payloadHash: prepared.payloadHash,
          idempotent: addedRecords.length === 0,
          addedRecords,
          records,
        };
      }));
  }

  /**
   * Append newly discovered immutable generations to an existing operation.
   *
   * This is intentionally separate from enqueueInTransaction: the initial
   * enqueue freezes one exact payload, while a project finalizer may discover
   * generations created before the write barrier became visible. The caller
   * must hold the deletion-operation row lock while invoking this method.
   */
  async appendInTransaction(
    transaction: Knex.Transaction,
    input: EnqueueDeletionOperationInput,
  ): Promise<AppendDeletionOperationResult> {
    assertCallerTransaction(transaction);
    const prepared = prepareAppendOperation(input, this.defaultMaxRetries);
    const now = this.now();

    return this.withDatabaseBoundary(() => transaction.transaction(async (savepoint) => {
      const persistedBefore = (
        await savepoint(this.tableName)
          .where({ operationId: prepared.operationId })
          .orderBy("dedupeKey", "asc")
      ).map(mapRecord);
      const byIdentity = new Map<string, DeletionOutboxRecord>();
      for (const record of persistedBefore) {
        const identity = itemIdentity(record);
        if (byIdentity.has(identity)) payloadConflict();
        byIdentity.set(identity, record);
      }

      const rows: RawRow[] = [];
      for (const item of prepared.items) {
        const existing = byIdentity.get(itemIdentity(item));
        if (existing) {
          if (existing.maxRetries !== item.maxRetries) payloadConflict();
          continue;
        }
        rows.push({
          id: this.idFactory(),
          operationId: prepared.operationId,
          dedupeKey: item.dedupeKey,
          payloadHash: prepared.payloadHash,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          bucket: item.bucket,
          objectKey: item.objectKey,
          deleteType: item.deleteType,
          targetGeneration: item.targetGeneration,
          conditionalToken: item.conditionalToken,
          status: "pending",
          errorCode: null,
          retryCount: 0,
          maxRetries: item.maxRetries,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseFence: 0,
          reconcileOwner: null,
          reconcileExpiresAt: null,
          reconcileFence: 0,
          reconcileRetryCount: 0,
          dispatchProviderId: null,
          dispatchIdempotencyKey: null,
          dispatchTargetFingerprint: null,
          dispatchMarkedAt: null,
          providerDispatchAt: null,
          providerReceiptOutcome: null,
          providerReceiptCode: null,
          providerRequestId: null,
          providerReceiptAt: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
      }

      if (rows.length) {
        for (
          let offset = 0;
          offset < rows.length;
          offset += DELETION_OUTBOX_INSERT_CHUNK_SIZE
        ) {
          await savepoint(this.tableName)
            .insert(rows.slice(
              offset,
              offset + DELETION_OUTBOX_INSERT_CHUNK_SIZE,
            ))
            .onConflict("dedupeKey")
            .ignore();
        }
      }

      const persistedAfter = (
        await savepoint(this.tableName)
          .where({ operationId: prepared.operationId })
          .orderBy("dedupeKey", "asc")
      ).map(mapRecord);
      const afterByIdentity = new Map<string, DeletionOutboxRecord>();
      for (const record of persistedAfter) {
        const identity = itemIdentity(record);
        if (afterByIdentity.has(identity)) payloadConflict();
        afterByIdentity.set(identity, record);
      }
      const requestedRecords = prepared.items.map((item) => {
        const record = afterByIdentity.get(itemIdentity(item));
        if (
          !record
          || record.operationId !== prepared.operationId
          || record.resourceType !== item.resourceType
          || record.resourceId !== item.resourceId
          || record.bucket !== item.bucket
          || record.objectKey !== item.objectKey
          || record.deleteType !== item.deleteType
          || record.targetGeneration !== item.targetGeneration
          || record.conditionalToken !== item.conditionalToken
          || record.maxRetries !== item.maxRetries
        ) {
          payloadConflict();
        }
        return record;
      });
      const insertedIds = new Set(rows.map((row) => String(row.id)));
      const addedRecords = requestedRecords.filter((record) =>
        insertedIds.has(record.id));
      return {
        operationId: prepared.operationId,
        payloadHash: prepared.payloadHash,
        idempotent: addedRecords.length === 0,
        addedRecords,
        records: requestedRecords,
      };
    }));
  }

  private replay(
    prepared: PreparedDeletionOperation,
    rawRows: RawRow[],
    idempotent: boolean,
  ): EnqueueDeletionOperationResult {
    const records = rawRows.map(mapRecord);
    if (records.length !== prepared.items.length) payloadConflict();
    const byDedupeKey = new Map(records.map((record) => [record.dedupeKey, record]));
    for (const item of prepared.items) {
      const record = byDedupeKey.get(item.dedupeKey);
      if (
        !record
        || record.operationId !== prepared.operationId
        || record.payloadHash !== prepared.payloadHash
        || record.resourceType !== item.resourceType
        || record.resourceId !== item.resourceId
        || record.bucket !== item.bucket
        || record.objectKey !== item.objectKey
        || record.deleteType !== item.deleteType
        || record.targetGeneration !== item.targetGeneration
        || record.conditionalToken !== item.conditionalToken
        || record.maxRetries !== item.maxRetries
      ) {
        payloadConflict();
      }
    }
    return {
      operationId: prepared.operationId,
      payloadHash: prepared.payloadHash,
      idempotent,
      records: prepared.items.map((item) => byDedupeKey.get(item.dedupeKey)!),
    };
  }

  async listByOperation(
    operationId: string,
  ): Promise<DeletionOutboxRecord[]> {
    const normalizedOperationId = nonEmptyText(
      operationId,
      "operationId",
      255,
    );
    return this.withDatabaseBoundary(async () => (
      await this.database(this.tableName)
        .where({ operationId: normalizedOperationId })
        .orderBy("dedupeKey", "asc")
    ).map(mapRecord));
  }

  async listByOperationInTransaction(
    transaction: Knex.Transaction,
    operationId: string,
  ): Promise<DeletionOutboxRecord[]> {
    assertCallerTransaction(transaction);
    const normalizedOperationId = nonEmptyText(
      operationId,
      "operationId",
      255,
    );
    return this.withDatabaseBoundary(async () => (
      await transaction(this.tableName)
        .where({ operationId: normalizedOperationId })
        .orderBy("dedupeKey", "asc")
    ).map(mapRecord));
  }

  async summarizeByOperation(
    operationId: string,
  ): Promise<DeletionOutboxOperationSummary> {
    const normalizedOperationId = nonEmptyText(
      operationId,
      "operationId",
      255,
    );
    return this.withDatabaseBoundary(() => this.summarizeByOperationQuery(
      this.database,
      normalizedOperationId,
    ));
  }

  async summarizeByOperationInTransaction(
    transaction: Knex.Transaction,
    operationId: string,
  ): Promise<DeletionOutboxOperationSummary> {
    assertCallerTransaction(transaction);
    const normalizedOperationId = nonEmptyText(
      operationId,
      "operationId",
      255,
    );
    return this.withDatabaseBoundary(() => this.summarizeByOperationQuery(
      transaction,
      normalizedOperationId,
    ));
  }

  private async summarizeByOperationQuery(
    client: Knex | Knex.Transaction,
    operationId: string,
  ): Promise<DeletionOutboxOperationSummary> {
    const count = async (
      status?: DeletionOutboxStatus,
    ): Promise<number> => {
      let query = client(this.tableName).where({ operationId });
      if (status) query = query.where({ status });
      const row = await query.count({ count: "*" }).first();
      const value = Number(row?.count ?? 0);
      if (!Number.isSafeInteger(value) || value < 0) rowInvalid();
      return value;
    };
    const [total, completed, dead] = await Promise.all([
      count(),
      count("completed"),
      count("dead"),
    ]);
    const incomplete = total - completed - dead;
    if (!Number.isSafeInteger(incomplete) || incomplete < 0) rowInvalid();
    return {
      operationId,
      total,
      completed,
      dead,
      incomplete,
    };
  }

  async claimDue(input: ClaimDueDeletionsInput): Promise<ClaimedDeletionOutboxRecord[]> {
    const workerId = nonEmptyText(input.workerId, "workerId", 255);
    const now = this.now();
    const leaseMs = positiveInteger(input.leaseMs ?? this.defaultLeaseMs, "leaseMs", 24 * 60 * 60_000);
    const limit = positiveInteger(input.limit ?? 20, "limit", 100);
    return this.withDatabaseBoundary(() => {
      if (isPostgres(this.database)) {
        return this.claimDuePostgres({ workerId, now, leaseMs, limit });
      }
      return this.claimDueWithAtomicCompareAndSwap({ workerId, now, leaseMs, limit });
    });
  }

  private async claimDuePostgres(input: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedDeletionOutboxRecord[]> {
    return this.database.transaction(async (transaction) => {
      const claimed: ClaimedDeletionOutboxRecord[] = [];
      let remainingAttempts = input.limit * 4 + 8;
      while (claimed.length < input.limit && remainingAttempts > 0) {
        remainingAttempts -= 1;
        const raw = await this.dispatchDueQuery(
          transaction(this.tableName),
          input.now,
        )
          .orderBy("nextAttemptAt", "asc")
          .orderBy("createdAt", "asc")
          .orderBy("id", "asc")
          .forUpdate()
          .skipLocked()
          .first();
        if (!raw) break;
        const current = await this.mapOrQuarantineInvalidCandidate(
          transaction,
          raw as RawRow,
          input.now,
        );
        if (!current) continue;
        const claim = await this.claimCandidate(transaction, current, input);
        if (claim) claimed.push(claim);
      }
      return claimed;
    });
  }

  private async claimDueWithAtomicCompareAndSwap(input: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedDeletionOutboxRecord[]> {
    for (let contentionAttempt = 0; contentionAttempt < 6; contentionAttempt += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          const claimed: ClaimedDeletionOutboxRecord[] = [];
          let remainingAttempts = input.limit * 4 + 8;
          while (claimed.length < input.limit && remainingAttempts > 0) {
            remainingAttempts -= 1;
            const candidate = await this.dispatchDueQuery(
              transaction(this.tableName),
              input.now,
            )
              .orderBy("nextAttemptAt", "asc")
              .orderBy("createdAt", "asc")
              .orderBy("id", "asc")
              .first();
            if (!candidate) break;
            const current = await this.mapOrQuarantineInvalidCandidate(
              transaction,
              candidate,
              input.now,
            );
            if (!current) continue;
            const claim = await this.claimCandidate(transaction, current, input);
            if (claim) claimed.push(claim);
          }
          return claimed;
        });
      } catch (error) {
        if (!isSqliteContention(error) || contentionAttempt === 5) throw error;
        await briefContentionBackoff(contentionAttempt);
      }
    }
    return [];
  }

  private async mapOrQuarantineInvalidCandidate(
    transaction: Knex.Transaction,
    raw: RawRow,
    currentTime: number,
  ): Promise<DeletionOutboxRecord | null> {
    try {
      return mapRecord(raw);
    } catch (error) {
      if (
        !(error instanceof DeletionOutboxError)
        || error.code !== "DELETION_OUTBOX_ROW_INVALID"
      ) {
        throw error;
      }
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const status = String(raw.status || "");
    const maxRetries = Number(raw.maxRetries);
    if (
      !id
      || id !== raw.id
      || !Number.isSafeInteger(maxRetries)
      || maxRetries < 0
      || maxRetries > 100
      || ![
        "pending",
        "leased",
        "dispatching",
        "pending_reconcile",
        "failed_retryable",
      ].includes(status)
    ) {
      rowInvalid();
    }
    const affected = await transaction(this.tableName)
      .where({ id, status })
      .update({
        status: "dead",
        errorCode: "row_invalid",
        retryCount: maxRetries + 1,
        reconcileRetryCount: maxRetries + 1,
        nextAttemptAt: currentTime,
        leaseOwner: null,
        leaseExpiresAt: null,
        reconcileOwner: null,
        reconcileExpiresAt: null,
        completedAt: null,
        updatedAt: currentTime,
      });
    if (Number(affected || 0) > 1) rowInvalid();
    return null;
  }

  private async claimCandidate(
    transaction: Knex.Transaction,
    current: DeletionOutboxRecord,
    input: {
      workerId: string;
      now: number;
      leaseMs: number;
    },
  ): Promise<ClaimedDeletionOutboxRecord | null> {
    if (current.status === "dispatching") {
      const commonWhere = {
        id: current.id,
        status: "dispatching",
        leaseOwner: current.leaseOwner,
        leaseExpiresAt: current.leaseExpiresAt,
        leaseFence: current.leaseFence,
        retryCount: current.retryCount,
        dispatchProviderId: current.dispatchProviderId,
        dispatchIdempotencyKey: current.dispatchIdempotencyKey,
        dispatchTargetFingerprint: current.dispatchTargetFingerprint,
        dispatchMarkedAt: current.dispatchMarkedAt,
        providerDispatchAt: current.providerDispatchAt,
      };
      const hasBoundDispatchEvidence =
        current.dispatchProviderId !== null
        && current.dispatchIdempotencyKey !== null
        && current.dispatchTargetFingerprint !== null
        && current.dispatchMarkedAt !== null;
      const dispatchProtocol = hasBoundDispatchEvidence
        ? dispatchBoundaryProtocol(current)
        : "unknown";
      const hasTrustedDispatchEvidence = hasBoundDispatchEvidence
        && dispatchProtocol !== "unknown"
        && current.dispatchTargetFingerprint === targetFingerprint(current);

      // An N-1 dispatching row has no durable call-boundary evidence. It
      // cannot be rebound to whichever provider a worker happens to present,
      // and it cannot be retried because the old process may already have
      // called the provider. Keep it in a durable manual reconciliation hold.
      if (!hasTrustedDispatchEvidence) {
        const affected = await this.dispatchDueQuery(
          transaction(this.tableName).where(commonWhere),
          input.now,
        ).update({
          status: "pending_reconcile",
          errorCode: "dispatch_outcome_unknown",
          nextAttemptAt: Number.MAX_SAFE_INTEGER,
          leaseOwner: null,
          leaseExpiresAt: null,
          reconcileOwner: null,
          reconcileExpiresAt: null,
          updatedAt: input.now,
        });
        if (Number(affected || 0) > 1) rowInvalid();
        return null;
      }

      // Only a v2 marker with a null providerDispatchAt proves that the
      // current runtime never crossed the provider-call boundary. N-1 v1
      // wrote this marker before prepareConditionalDelete, so the identical
      // null shape is ambiguous and must reconcile under its original key.
      if (
        current.providerDispatchAt === null
        && dispatchProtocol === "current-v2"
      ) {
        const nextRetryCount = checkedIncrement(current.retryCount, rowInvalid);
        const nextStatus: DeletionOutboxStatus =
          nextRetryCount <= current.maxRetries ? "failed_retryable" : "dead";
        const affected = await this.dispatchDueQuery(
          transaction(this.tableName).where(commonWhere),
          input.now,
        ).update({
          status: nextStatus,
          errorCode: "lease_expired",
          retryCount: nextRetryCount,
          nextAttemptAt: input.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          dispatchProviderId: null,
          dispatchIdempotencyKey: null,
          dispatchTargetFingerprint: null,
          dispatchMarkedAt: null,
          providerDispatchAt: null,
          updatedAt: input.now,
        });
        if (Number(affected || 0) > 1) rowInvalid();
        return null;
      }

      const affected = await this.dispatchDueQuery(
        transaction(this.tableName).where(commonWhere),
        input.now,
      ).update({
        status: "pending_reconcile",
        errorCode: "dispatch_outcome_unknown",
        nextAttemptAt: input.now,
        leaseOwner: null,
        leaseExpiresAt: null,
        reconcileOwner: null,
        reconcileExpiresAt: null,
        updatedAt: input.now,
      });
      if (Number(affected || 0) > 1) rowInvalid();
      return null;
    }

    const expiredLease = current.status === "leased";
    const retryCount = expiredLease
      ? checkedIncrement(current.retryCount, rowInvalid)
      : current.retryCount;
    const commonWhere = {
      id: current.id,
      status: current.status,
      leaseOwner: current.leaseOwner,
      leaseFence: current.leaseFence,
      retryCount: current.retryCount,
    };
    const cannotRetryExpiredLease = expiredLease && retryCount > current.maxRetries;
    const fenceExhausted = current.leaseFence === Number.MAX_SAFE_INTEGER;
    if (cannotRetryExpiredLease || fenceExhausted) {
      const affected = await this.dispatchDueQuery(
        transaction(this.tableName).where(commonWhere),
        input.now,
      ).update({
        status: "dead",
        errorCode: fenceExhausted ? "lease_fence_exhausted" : "lease_expired",
        retryCount,
        nextAttemptAt: input.now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      });
      if (Number(affected || 0) > 1) rowInvalid();
      return null;
    }

    const nextFence = checkedIncrement(current.leaseFence, rowInvalid);
    const leaseExpiresAt = checkedAdd(input.now, input.leaseMs, rowInvalid);
    const affected = await this.dispatchDueQuery(
      transaction(this.tableName).where(commonWhere),
      input.now,
    ).update({
      status: "leased",
      errorCode: expiredLease ? "lease_expired" : current.errorCode,
      retryCount,
      leaseOwner: input.workerId,
      leaseExpiresAt,
      leaseFence: nextFence,
      updatedAt: input.now,
    });
    if (Number(affected || 0) !== 1) return null;
    const updated = await transaction(this.tableName)
      .where({
        id: current.id,
        status: "leased",
        leaseOwner: input.workerId,
        leaseFence: nextFence,
      })
      .first();
    if (!updated) leaseLost();
    return asClaimed(updated);
  }

  async claimDueReconciliations(
    input: ClaimDueReconciliationsInput,
  ): Promise<ClaimedDeletionReconciliationRecord[]> {
    const workerId = nonEmptyText(input.workerId, "workerId", 255);
    const now = this.now();
    const leaseMs = positiveInteger(
      input.leaseMs ?? this.defaultLeaseMs,
      "leaseMs",
      24 * 60 * 60_000,
    );
    const limit = positiveInteger(input.limit ?? 20, "limit", 100);
    return this.withDatabaseBoundary(() => {
      if (isPostgres(this.database)) {
        return this.claimDueReconciliationsPostgres({ workerId, now, leaseMs, limit });
      }
      return this.claimDueReconciliationsWithAtomicCompareAndSwap({
        workerId,
        now,
        leaseMs,
        limit,
      });
    });
  }

  private async claimDueReconciliationsPostgres(input: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedDeletionReconciliationRecord[]> {
    return this.database.transaction(async (transaction) => {
      const claimed: ClaimedDeletionReconciliationRecord[] = [];
      let remainingAttempts = input.limit * 4 + 8;
      while (claimed.length < input.limit && remainingAttempts > 0) {
        remainingAttempts -= 1;
        const raw = await this.reconciliationDueQuery(
          transaction(this.tableName),
          input.now,
        )
          .orderBy("nextAttemptAt", "asc")
          .orderBy("createdAt", "asc")
          .orderBy("id", "asc")
          .forUpdate()
          .skipLocked()
          .first();
        if (!raw) break;
        const current = await this.mapOrQuarantineInvalidCandidate(
          transaction,
          raw as RawRow,
          input.now,
        );
        if (!current) continue;
        const claim = await this.claimReconciliationCandidate(
          transaction,
          current,
          input,
        );
        if (claim) claimed.push(claim);
      }
      return claimed;
    });
  }

  private async claimDueReconciliationsWithAtomicCompareAndSwap(input: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedDeletionReconciliationRecord[]> {
    for (let contentionAttempt = 0; contentionAttempt < 6; contentionAttempt += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          const claimed: ClaimedDeletionReconciliationRecord[] = [];
          let remainingAttempts = input.limit * 4 + 8;
          while (claimed.length < input.limit && remainingAttempts > 0) {
            remainingAttempts -= 1;
            const raw = await this.reconciliationDueQuery(
              transaction(this.tableName),
              input.now,
            )
              .orderBy("nextAttemptAt", "asc")
              .orderBy("createdAt", "asc")
              .orderBy("id", "asc")
              .first();
            if (!raw) break;
            const current = await this.mapOrQuarantineInvalidCandidate(
              transaction,
              raw as RawRow,
              input.now,
            );
            if (!current) continue;
            const claim = await this.claimReconciliationCandidate(
              transaction,
              current,
              input,
            );
            if (claim) claimed.push(claim);
          }
          return claimed;
        });
      } catch (error) {
        if (!isSqliteContention(error) || contentionAttempt === 5) throw error;
        await briefContentionBackoff(contentionAttempt);
      }
    }
    return [];
  }

  private async claimReconciliationCandidate(
    transaction: Knex.Transaction,
    current: DeletionOutboxRecord,
    input: {
      workerId: string;
      now: number;
      leaseMs: number;
    },
  ): Promise<ClaimedDeletionReconciliationRecord | null> {
    if (current.status !== "pending_reconcile") rowInvalid();
    // D4 could retain a dispatch lease while making reconciliation due.
    // An active dispatch owner wins until its lease expires; never erase an
    // active lease merely because a reconciler observed the row.
    if (
      current.leaseOwner !== null
      && current.leaseExpiresAt !== null
      && current.leaseExpiresAt > input.now
    ) {
      return null;
    }
    const expiredLease = current.reconcileOwner !== null;
    const reconcileRetryCount = expiredLease
      ? checkedIncrement(current.reconcileRetryCount, rowInvalid)
      : current.reconcileRetryCount;
    const commonWhere = {
      id: current.id,
      status: "pending_reconcile",
      leaseOwner: current.leaseOwner,
      leaseExpiresAt: current.leaseExpiresAt,
      reconcileOwner: current.reconcileOwner,
      reconcileExpiresAt: current.reconcileExpiresAt,
      reconcileFence: current.reconcileFence,
      reconcileRetryCount: current.reconcileRetryCount,
      dispatchProviderId: current.dispatchProviderId,
      dispatchIdempotencyKey: current.dispatchIdempotencyKey,
      dispatchTargetFingerprint: current.dispatchTargetFingerprint,
      dispatchMarkedAt: current.dispatchMarkedAt,
      providerDispatchAt: current.providerDispatchAt,
      updatedAt: current.updatedAt,
    };
    if (current.dispatchProviderId === null) {
      const affected = await this.reconciliationDueQuery(
        transaction(this.tableName).where(commonWhere),
        input.now,
      ).update({
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        leaseOwner: null,
        leaseExpiresAt: null,
        reconcileOwner: null,
        reconcileExpiresAt: null,
        updatedAt: input.now,
      });
      if (Number(affected || 0) > 1) rowInvalid();
      return null;
    }
    const retriesExhausted = expiredLease
      && reconcileRetryCount > current.maxRetries;
    const fenceExhausted = current.reconcileFence === Number.MAX_SAFE_INTEGER;
    if (retriesExhausted || fenceExhausted) {
      const affected = await this.reconciliationDueQuery(
        transaction(this.tableName).where(commonWhere),
        input.now,
      ).update({
        status: "dead",
        errorCode: fenceExhausted ? "lease_fence_exhausted" : "lease_expired",
        reconcileRetryCount,
        nextAttemptAt: input.now,
        leaseOwner: null,
        leaseExpiresAt: null,
        reconcileOwner: null,
        reconcileExpiresAt: null,
        updatedAt: input.now,
      });
      if (Number(affected || 0) > 1) rowInvalid();
      return null;
    }

    const nextFence = checkedIncrement(current.reconcileFence, rowInvalid);
    const reconcileExpiresAt = checkedAdd(input.now, input.leaseMs, rowInvalid);
    const affected = await this.reconciliationDueQuery(
      transaction(this.tableName).where(commonWhere),
      input.now,
    ).update({
      // Normalize D4 rows that retained the old dispatch lease. The
      // reconciliation fence is the only active lease after this write.
      leaseOwner: null,
      leaseExpiresAt: null,
      reconcileOwner: input.workerId,
      reconcileExpiresAt,
      reconcileFence: nextFence,
      reconcileRetryCount,
      updatedAt: input.now,
    });
    if (Number(affected || 0) !== 1) return null;
    const updated = await transaction(this.tableName)
      .where({
        id: current.id,
        status: "pending_reconcile",
        reconcileOwner: input.workerId,
        reconcileFence: nextFence,
      })
      .first();
    if (!updated) leaseLost();
    return asClaimedReconciliation(updated);
  }

  async renewLease(
    input: DeletionLeaseInput & { leaseMs?: number },
  ): Promise<ClaimedDeletionOutboxRecord> {
    const normalized = this.normalizeLeaseInput(input);
    const leaseMs = positiveInteger(input.leaseMs ?? this.defaultLeaseMs, "leaseMs", 24 * 60 * 60_000);
    const now = this.now();
    const leaseExpiresAt = checkedAdd(now, leaseMs, rowInvalid);
    return this.withDatabaseBoundary(async () => {
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "leased",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          leaseExpiresAt: this.database.raw(
            "CASE WHEN ?? > ? THEN ?? ELSE ? END",
            ["leaseExpiresAt", leaseExpiresAt, "leaseExpiresAt", leaseExpiresAt],
          ),
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const row = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "leased",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .first();
      if (!row) leaseLost();
      return asClaimed(row);
    });
  }

  async complete(input: DeletionLeaseInput): Promise<DeletionOutboxRecord> {
    const normalized = this.normalizeLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const row = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "leased",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .first();
      if (!row) leaseLost();
      asClaimed(row);
      providerReceiptRequired();
    });
  }

  async fail(input: FailDeletionInput): Promise<DeletionOutboxRecord> {
    const normalized = this.normalizeLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const currentRow = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "leased",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .first();
      if (!currentRow) leaseLost();
      const current = asClaimed(currentRow);
      const nextRetryCount = checkedIncrement(current.retryCount, rowInvalid);
      const retryable = input.retryable !== false;
      const nextStatus: DeletionOutboxStatus =
        retryable && nextRetryCount <= current.maxRetries ? "failed_retryable" : "dead";
      const requestedDelay = input.retryDelayMs === undefined
        ? retryDelayMs(nextRetryCount)
        : boundedNonNegativeInteger(
          input.retryDelayMs,
          "retryDelayMs",
          24 * 60 * 60_000,
        );
      const nextAttemptAt = nextStatus === "failed_retryable"
        ? checkedAdd(now, requestedDelay, rowInvalid)
        : now;
      const errorCode = deletionOutboxErrorCode(input.error);
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "leased",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
          retryCount: current.retryCount,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: nextStatus,
          errorCode,
          retryCount: nextRetryCount,
          nextAttemptAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const row = await this.database(this.tableName).where({ id: normalized.id }).first();
      if (!row) rowInvalid();
      return mapRecord(row);
    });
  }

  private async beginDispatch(
    input: DeletionLeaseInput,
    provider: ConditionalDeletionProviderV1,
    context: ConditionalDeletionContextV1,
  ): Promise<DispatchedDeletionOutboxRecord> {
    const normalized = this.normalizeLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "leased",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: "dispatching",
          errorCode: null,
          dispatchProviderId: provider.providerId,
          dispatchIdempotencyKey: context.idempotencyKey,
          dispatchTargetFingerprint: context.targetFingerprint,
          dispatchMarkedAt: now,
          providerDispatchAt: null,
          providerReceiptOutcome: null,
          providerReceiptCode: null,
          providerRequestId: null,
          providerReceiptAt: null,
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const row = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "dispatching",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .first();
      if (!row) leaseLost();
      return asDispatched(row);
    });
  }

  private async markProviderInvocation(
    input: DeletionLeaseInput,
  ): Promise<InvokedDeletionOutboxRecord> {
    const normalized = this.normalizeLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "dispatching",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .whereNull("providerDispatchAt")
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          providerDispatchAt: now,
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const row = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "dispatching",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .first();
      if (!row) leaseLost();
      const invoked = asDispatched(row);
      if (invoked.providerDispatchAt === null) rowInvalid();
      return invoked as InvokedDeletionOutboxRecord;
    });
  }

  private async markPendingReconcile(
    input: DeletionLeaseInput,
    expected: InvokedDeletionOutboxRecord,
  ): Promise<DeletionOutboxRecord> {
    const normalized = this.normalizeLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "dispatching",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
          dispatchProviderId: expected.dispatchProviderId,
          dispatchIdempotencyKey: expected.dispatchIdempotencyKey,
          dispatchTargetFingerprint: expected.dispatchTargetFingerprint,
          dispatchMarkedAt: expected.dispatchMarkedAt,
          providerDispatchAt: expected.providerDispatchAt,
        })
        .whereNotNull("providerDispatchAt")
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: "pending_reconcile",
          errorCode: "dispatch_outcome_unknown",
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          reconcileOwner: null,
          reconcileExpiresAt: null,
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const row = await this.database(this.tableName).where({ id: normalized.id }).first();
      if (!row) rowInvalid();
      return mapRecord(row);
    });
  }

  private async completeDispatched(
    input: DeletionLeaseInput,
    expected: InvokedDeletionOutboxRecord,
    result: ConditionalDeletionResultV1,
  ): Promise<DeletionOutboxRecord> {
    const normalized = this.normalizeLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "dispatching",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
          dispatchProviderId: expected.dispatchProviderId,
          dispatchIdempotencyKey: expected.dispatchIdempotencyKey,
          dispatchTargetFingerprint: expected.dispatchTargetFingerprint,
          dispatchMarkedAt: expected.dispatchMarkedAt,
          providerDispatchAt: expected.providerDispatchAt,
        })
        .whereNotNull("dispatchProviderId")
        .whereNotNull("dispatchIdempotencyKey")
        .whereNotNull("dispatchTargetFingerprint")
        .whereNotNull("dispatchMarkedAt")
        .whereNotNull("providerDispatchAt")
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          status: "completed",
          errorCode: null,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          reconcileOwner: null,
          reconcileExpiresAt: null,
          providerReceiptOutcome: result.outcome,
          providerReceiptCode: result.code,
          providerRequestId: result.providerRequestId,
          providerReceiptAt: now,
          completedAt: now,
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const row = await this.database(this.tableName).where({ id: normalized.id }).first();
      if (!row) rowInvalid();
      return mapRecord(row);
    });
  }

  async processClaim(input: ProcessClaimedDeletionInput): Promise<DeletionOutboxRecord> {
    const providerTimeoutMs = positiveInteger(
      input.providerTimeoutMs ?? this.defaultProviderTimeoutMs,
      "providerTimeoutMs",
      24 * 60 * 60_000,
    );
    const activeClaim = await this.readActiveClaim({
      id: input.claim.id,
      workerId: input.claim.leaseOwner,
      leaseFence: input.claim.leaseFence,
    });
    const leaseInput = {
      id: activeClaim.id,
      workerId: activeClaim.leaseOwner,
      leaseFence: activeClaim.leaseFence,
    };
    try {
      validateProvider(input.provider);
    } catch (error) {
      return this.fail({
        ...leaseInput,
        error,
        retryable: input.retryable,
        retryDelayMs: input.retryDelayMs,
      });
    }

    const initialContext = providerContext(activeClaim);
    await this.beginDispatch(
      leaseInput,
      input.provider,
      initialContext,
    );
    // Persist the call boundary before entering either provider hook. A
    // rejection from prepareConditionalDelete is not a proven pre-call
    // failure: the implementation may already have contacted its provider.
    const invoked = await this.markProviderInvocation(leaseInput);
    const context = providerContext(invoked);
    let result: ConditionalDeletionResultV1;
    try {
      const proof = await this.runDispatchProviderOperation(
        leaseInput,
        providerTimeoutMs,
        (operation) => input.provider.prepareConditionalDelete(context, operation),
      );
      validateCapabilityProof(proof, input.provider, invoked);
      result = await this.runDispatchProviderOperation(
        leaseInput,
        providerTimeoutMs,
        (operation) => input.provider.deleteConditional(context, proof, operation),
      );
      validateDeletionResult(result, context);
    } catch (error) {
      if (this.mustPropagateWorkerStateError(error)) throw error;
      return this.markPendingReconcile(leaseInput, invoked);
    }
    return this.completeDispatched(leaseInput, invoked, result);
  }

  async processReconciliation(
    input: ProcessDeletionReconciliationInput,
  ): Promise<DeletionOutboxRecord> {
    const providerTimeoutMs = positiveInteger(
      input.providerTimeoutMs ?? this.defaultProviderTimeoutMs,
      "providerTimeoutMs",
      24 * 60 * 60_000,
    );
    const activeClaim = await this.readActiveReconciliation({
      id: input.claim.id,
      workerId: input.claim.reconcileOwner,
      reconcileFence: input.claim.reconcileFence,
    });
    const leaseInput = {
      id: activeClaim.id,
      workerId: activeClaim.reconcileOwner,
      reconcileFence: activeClaim.reconcileFence,
    };
    validateProvider(input.provider);
    if (input.provider.providerId !== activeClaim.dispatchProviderId) {
      providerProofInvalid();
    }
    const context = providerContext(activeClaim);
    try {
      const result = await this.runReconciliationProviderOperation(
        leaseInput,
        providerTimeoutMs,
        (operation) => input.provider.reconcileConditionalDelete(
          context,
          dispatchEvidence(activeClaim),
          operation,
        ),
      );
      validateDeletionResult(result, context);
      return this.completeReconciliation(leaseInput, activeClaim, result);
    } catch (error) {
      if (this.mustPropagateWorkerStateError(error)) throw error;
      return this.rescheduleReconciliation({
        ...leaseInput,
        error,
        retryDelayMs: input.retryDelayMs,
      });
    }
  }

  private async completeReconciliation(
    input: DeletionReconciliationLeaseInput,
    expected: ClaimedDeletionReconciliationRecord,
    result: ConditionalDeletionResultV1,
  ): Promise<DeletionOutboxRecord> {
    const normalized = this.normalizeReconciliationLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "pending_reconcile",
          reconcileOwner: normalized.workerId,
          reconcileFence: normalized.reconcileFence,
          dispatchProviderId: expected.dispatchProviderId,
          dispatchIdempotencyKey: expected.dispatchIdempotencyKey,
          dispatchTargetFingerprint: expected.dispatchTargetFingerprint,
          dispatchMarkedAt: expected.dispatchMarkedAt,
          providerDispatchAt: expected.providerDispatchAt,
        })
        .whereNotNull("dispatchProviderId")
        .whereNotNull("dispatchIdempotencyKey")
        .whereNotNull("dispatchTargetFingerprint")
        .whereNotNull("dispatchMarkedAt")
        .whereNull("leaseOwner")
        .whereNull("leaseExpiresAt")
        .andWhere("reconcileExpiresAt", ">", now)
        .update({
          status: "completed",
          errorCode: null,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          reconcileOwner: null,
          reconcileExpiresAt: null,
          providerDispatchAt: this.database.raw(
            "COALESCE(??, ?)",
            ["providerDispatchAt", now],
          ),
          providerReceiptOutcome: result.outcome,
          providerReceiptCode: result.code,
          providerRequestId: result.providerRequestId,
          providerReceiptAt: now,
          completedAt: now,
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const row = await this.database(this.tableName).where({ id: normalized.id }).first();
      if (!row) rowInvalid();
      return mapRecord(row);
    });
  }

  private async rescheduleReconciliation(
    input: DeletionReconciliationLeaseInput & {
      error: unknown;
      retryDelayMs?: number;
    },
  ): Promise<DeletionOutboxRecord> {
    const normalized = this.normalizeReconciliationLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const currentRow = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "pending_reconcile",
          reconcileOwner: normalized.workerId,
          reconcileFence: normalized.reconcileFence,
        })
        .whereNull("leaseOwner")
        .whereNull("leaseExpiresAt")
        .andWhere("reconcileExpiresAt", ">", now)
        .first();
      if (!currentRow) leaseLost();
      const current = asClaimedReconciliation(currentRow);
      const nextRetryCount = checkedIncrement(current.reconcileRetryCount, rowInvalid);
      const nextStatus: DeletionOutboxStatus =
        nextRetryCount <= current.maxRetries ? "pending_reconcile" : "dead";
      const requestedDelay = input.retryDelayMs === undefined
        ? retryDelayMs(nextRetryCount)
        : boundedNonNegativeInteger(
          input.retryDelayMs,
          "retryDelayMs",
          24 * 60 * 60_000,
        );
      const nextAttemptAt = nextStatus === "pending_reconcile"
        ? checkedAdd(now, requestedDelay, rowInvalid)
        : now;
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "pending_reconcile",
          reconcileOwner: normalized.workerId,
          reconcileFence: normalized.reconcileFence,
          reconcileRetryCount: current.reconcileRetryCount,
          dispatchProviderId: current.dispatchProviderId,
          dispatchIdempotencyKey: current.dispatchIdempotencyKey,
          dispatchTargetFingerprint: current.dispatchTargetFingerprint,
          dispatchMarkedAt: current.dispatchMarkedAt,
          providerDispatchAt: current.providerDispatchAt,
        })
        .whereNull("leaseOwner")
        .whereNull("leaseExpiresAt")
        .andWhere("reconcileExpiresAt", ">", now)
        .update({
          status: nextStatus,
          errorCode: nextStatus === "pending_reconcile"
            ? "dispatch_outcome_unknown"
            : deletionOutboxErrorCode(input.error),
          reconcileRetryCount: nextRetryCount,
          nextAttemptAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          reconcileOwner: null,
          reconcileExpiresAt: null,
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const row = await this.database(this.tableName).where({ id: normalized.id }).first();
      if (!row) rowInvalid();
      return mapRecord(row);
    });
  }

  private mustPropagateWorkerStateError(error: unknown): boolean {
    return error instanceof DeletionOutboxError && [
      "DELETION_OUTBOX_LEASE_LOST",
      "DELETION_OUTBOX_ROW_INVALID",
      "DELETION_OUTBOX_STORAGE_UNAVAILABLE",
      "DELETION_OUTBOX_CLOCK_INVALID",
    ].includes(error.code);
  }

  private async runDispatchProviderOperation<T>(
    input: DeletionLeaseInput,
    requestedTimeoutMs: number | undefined,
    operation: (options: ConditionalDeletionProviderOperationV1) => Promise<T>,
  ): Promise<T> {
    return this.runProviderOperation(
      () => this.renewDispatchLease(input),
      requestedTimeoutMs,
      operation,
    );
  }

  private async runReconciliationProviderOperation<T>(
    input: DeletionReconciliationLeaseInput,
    requestedTimeoutMs: number | undefined,
    operation: (options: ConditionalDeletionProviderOperationV1) => Promise<T>,
  ): Promise<T> {
    return this.runProviderOperation(
      () => this.renewReconciliationLease(input),
      requestedTimeoutMs,
      operation,
    );
  }

  private async runProviderOperation<T>(
    heartbeat: () => Promise<void>,
    requestedTimeoutMs: number | undefined,
    operation: (options: ConditionalDeletionProviderOperationV1) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = positiveInteger(
      requestedTimeoutMs ?? this.defaultProviderTimeoutMs,
      "providerTimeoutMs",
      24 * 60 * 60_000,
    );
    // Renew synchronously before handing control to provider code. A stale
    // fence therefore cannot reach an external side effect.
    await heartbeat();

    const controller = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    const options = Object.freeze({
      deadlineAt,
      signal: controller.signal,
    });
    let finished = false;
    let heartbeatRunning = false;
    let rejectHeartbeat!: (error: unknown) => void;
    const heartbeatFailure = new Promise<never>((_resolve, reject) => {
      rejectHeartbeat = reject;
    });
    const heartbeatTimer = setInterval(() => {
      if (finished || heartbeatRunning) return;
      heartbeatRunning = true;
      void heartbeat()
        .catch((error) => {
          if (!finished) {
            rejectHeartbeat(error);
            controller.abort();
          }
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    }, this.dispatchHeartbeatMs);
    let timeoutTimer: ReturnType<typeof setTimeout>;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(providerOperationTimedOut());
        controller.abort();
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(options)),
        timeoutFailure,
        heartbeatFailure,
      ]);
    } finally {
      finished = true;
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer!);
    }
  }

  private async renewDispatchLease(input: DeletionLeaseInput): Promise<void> {
    const normalized = this.normalizeLeaseInput(input);
    const now = this.now();
    const leaseExpiresAt = checkedAdd(now, this.defaultLeaseMs, rowInvalid);
    return this.withDatabaseBoundary(async () => {
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "dispatching",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .update({
          leaseExpiresAt: this.database.raw(
            "CASE WHEN ?? > ? THEN ?? ELSE ? END",
            ["leaseExpiresAt", leaseExpiresAt, "leaseExpiresAt", leaseExpiresAt],
          ),
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
    });
  }

  private async renewReconciliationLease(
    input: DeletionReconciliationLeaseInput,
  ): Promise<void> {
    const normalized = this.normalizeReconciliationLeaseInput(input);
    const now = this.now();
    const reconcileExpiresAt = checkedAdd(now, this.defaultLeaseMs, rowInvalid);
    return this.withDatabaseBoundary(async () => {
      const affected = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "pending_reconcile",
          reconcileOwner: normalized.workerId,
          reconcileFence: normalized.reconcileFence,
        })
        .whereNull("leaseOwner")
        .whereNull("leaseExpiresAt")
        .andWhere("reconcileExpiresAt", ">", now)
        .update({
          reconcileExpiresAt: this.database.raw(
            "CASE WHEN ?? > ? THEN ?? ELSE ? END",
            [
              "reconcileExpiresAt",
              reconcileExpiresAt,
              "reconcileExpiresAt",
              reconcileExpiresAt,
            ],
          ),
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
    });
  }

  private async readActiveClaim(input: DeletionLeaseInput): Promise<ClaimedDeletionOutboxRecord> {
    const normalized = this.normalizeLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(async () => {
      const row = await this.database(this.tableName)
        .where({
          id: normalized.id,
          status: "leased",
          leaseOwner: normalized.workerId,
          leaseFence: normalized.leaseFence,
        })
        .andWhere("leaseExpiresAt", ">", now)
        .first();
      if (!row) leaseLost();
      return asClaimed(row);
    });
  }

  private async readActiveReconciliation(
    input: DeletionReconciliationLeaseInput,
  ): Promise<ClaimedDeletionReconciliationRecord> {
    const normalized = this.normalizeReconciliationLeaseInput(input);
    const now = this.now();
    return this.withDatabaseBoundary(() => this.database.transaction(async (transaction) => {
      const row = await transaction(this.tableName)
        .where({
          id: normalized.id,
          status: "pending_reconcile",
          reconcileOwner: normalized.workerId,
          reconcileFence: normalized.reconcileFence,
        })
        .andWhere("reconcileExpiresAt", ">", now)
        .first();
      if (!row) leaseLost();
      const current = mapRecord(row);
      if (current.leaseOwner === null && current.leaseExpiresAt === null) {
        return asClaimedReconciliation(row);
      }
      if (
        current.leaseOwner === null
        || current.leaseExpiresAt === null
        || current.leaseExpiresAt > now
      ) {
        leaseLost();
      }

      // Normalize only an expired D4 dispatch lease, guarded by both lease
      // fences and the active reconciliation lease. This CAS completes
      // before any Provider callback is reachable.
      const affected = await transaction(this.tableName)
        .where({
          id: normalized.id,
          status: "pending_reconcile",
          leaseOwner: current.leaseOwner,
          leaseExpiresAt: current.leaseExpiresAt,
          leaseFence: current.leaseFence,
          reconcileOwner: normalized.workerId,
          reconcileExpiresAt: current.reconcileExpiresAt,
          reconcileFence: normalized.reconcileFence,
          updatedAt: current.updatedAt,
        })
        .andWhere("leaseExpiresAt", "<=", now)
        .andWhere("reconcileExpiresAt", ">", now)
        .update({
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        });
      if (Number(affected || 0) !== 1) leaseLost();
      const normalizedRow = await transaction(this.tableName)
        .where({
          id: normalized.id,
          status: "pending_reconcile",
          reconcileOwner: normalized.workerId,
          reconcileFence: normalized.reconcileFence,
        })
        .whereNull("leaseOwner")
        .whereNull("leaseExpiresAt")
        .andWhere("reconcileExpiresAt", ">", now)
        .first();
      if (!normalizedRow) leaseLost();
      return asClaimedReconciliation(normalizedRow);
    }));
  }

  private normalizeLeaseInput(input: DeletionLeaseInput): DeletionLeaseInput {
    return {
      id: nonEmptyText(input.id, "id", 255),
      workerId: nonEmptyText(input.workerId, "workerId", 255),
      leaseFence: positiveInteger(input.leaseFence, "leaseFence", Number.MAX_SAFE_INTEGER),
    };
  }

  private normalizeReconciliationLeaseInput(
    input: DeletionReconciliationLeaseInput,
  ): DeletionReconciliationLeaseInput {
    return {
      id: nonEmptyText(input.id, "id", 255),
      workerId: nonEmptyText(input.workerId, "workerId", 255),
      reconcileFence: positiveInteger(
        input.reconcileFence,
        "reconcileFence",
        Number.MAX_SAFE_INTEGER,
      ),
    };
  }
}
