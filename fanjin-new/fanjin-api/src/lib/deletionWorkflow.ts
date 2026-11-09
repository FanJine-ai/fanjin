import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  DELETION_OUTBOX_TABLE,
  DeletionOutboxRepository,
  type DeletionOutboxItem,
  type DeletionOutboxRecord,
} from "@/lib/deletionOutbox";
import {
  captureStorageDeletionTarget,
  captureStorageKeyDeletionTargets,
  captureStoragePrefixDeletionTargetPage,
  type CapturedStorageDeletionTarget,
} from "@/lib/objectStorageDeletion";
import { normalizeObjectKey } from "@/lib/objectStorage";
import {
  DELETION_OPERATION_TABLE,
  DELETION_RESOURCE_ALIAS_TABLE,
} from "@/lib/migrations/deletionWorkflow";
import {
  DELETION_CHECKPOINT_TABLE,
} from "@/lib/migrations/deletionChunkStore";
import {
  advanceDeletionChunkCheckpointInTransaction,
  advanceDeletionAuditTableInTransaction,
  appendDeletionAuditChunkInTransaction,
  appendDeletionManifestChunkInTransaction,
  initializeDeletionChunkCheckpointInTransaction,
  readDeletionChunkCheckpointInTransaction,
  type DeletionChunkCheckpoint,
  type DeletionStorageMarker,
} from "@/lib/deletionChunkStore";
import {
  firstProjectDeletionFinalizerCursor,
  PROJECT_DELETION_FINALIZER_RETAINED_TABLES,
  PROJECT_DELETION_FINALIZER_STEPS,
  runProjectDeletionFinalizerBatchInTransaction,
  type ProjectDeletionFinalizerPosition,
} from "@/lib/projectDeletionChunkFinalizer";
import { OBJECT_WRITE_INTENT_TABLE } from "@/lib/migrations/objectWriteIntent";
import type { ProjectPermissionResult } from "@/middleware/projectAccess";
import { protectedAccountAssetStorageKeysForProject } from "@/lib/accountWorkspaceAssetLibrary";

export type DeletionOperationKind = "image" | "asset" | "project";
export type DeletionOperationStatus =
  | "preparing"
  | "deleting"
  | "completed"
  | "blocked";

export interface DeletionOperationRecord {
  id: string;
  operationKey: string;
  kind: DeletionOperationKind;
  workspaceId: string;
  projectId: number;
  resourceId: string;
  status: DeletionOperationStatus;
  requestHash: string;
  manifestHash: string | null;
  manifestRevision: number;
  expectedItemCount: number | null;
  requestedBy: number;
  requestedAt: number;
  finalizedAt: number | null;
  auditSnapshot: string | null;
  auditSnapshotHash: string | null;
  errorCode: string | null;
  coordinatorLeaseOwner: string | null;
  coordinatorLeaseExpiresAt: number | null;
  coordinatorFence: number;
  retryCount: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface DeletionActor {
  userId: number;
  role?: string | null;
  authWorkspaceId?: string | null;
}

export type ClaimedDeletionOperation = DeletionOperationRecord & {
  status: "preparing" | "deleting";
  coordinatorLeaseOwner: string;
  coordinatorLeaseExpiresAt: number;
};

export interface ClaimDeletionOperationsInput {
  workerId: string;
  leaseMs?: number;
  limit?: number;
}

export interface DeletionOperationLease {
  operationId: string;
  workerId: string;
  coordinatorFence: number;
}

export interface RenewDeletionOperationClaimInput
  extends DeletionOperationLease {
  status: "preparing" | "deleting";
  leaseMs?: number;
}

export interface RequestImageDeletionInput extends DeletionActor {
  imageId: number;
}

export interface RequestAssetDeletionInput extends DeletionActor {
  assetId: number;
  /**
   * When a media UUID delegates to its authoritative numeric asset, require
   * that this exact media row is still part of the locked asset manifest.
   */
  expectedMediaAssetId?: string;
}

export interface RequestMediaAssetDeletionInput extends DeletionActor {
  mediaAssetId: string;
}

export interface RequestProjectDeletionInput extends DeletionActor {
  projectId: number;
}

interface ProjectAuthorizationInput {
  projectId: number;
  userId: number;
  role?: string | null;
  authWorkspaceId?: string | null;
  permission: "project:delete";
  allowDeleting?: boolean;
  database?: Knex | Knex.Transaction;
  lock?: boolean;
}

export interface DeletionWorkflowRuntime {
  database?: Knex;
  clock?: () => number;
  idFactory?: () => string;
  signal?: AbortSignal;
  beforeClaimedOperationCommit?: (
    claim: DeletionOperationLease,
  ) => Promise<void>;
  authorizeProject?: (
    input: ProjectAuthorizationInput,
  ) => Promise<ProjectPermissionResult>;
  captureTarget?: typeof captureStorageDeletionTarget;
  captureKeyTargets?: typeof captureStorageKeyDeletionTargets;
  capturePrefixTargetPage?:
    typeof captureStoragePrefixDeletionTargetPage;
}

interface ResolvedDeletionWorkflowRuntime {
  database: Knex;
  clock: () => number;
  idFactory: () => string;
  signal?: AbortSignal;
  beforeClaimedOperationCommit?: (
    claim: DeletionOperationLease,
  ) => Promise<void>;
  authorizeProject: (
    input: ProjectAuthorizationInput,
  ) => Promise<ProjectPermissionResult>;
  captureTarget: typeof captureStorageDeletionTarget;
  captureKeyTargets: typeof captureStorageKeyDeletionTargets;
  capturePrefixTargetPage:
    typeof captureStoragePrefixDeletionTargetPage;
}

interface ImageAuthoritySnapshot {
  imageId: number;
  assetId: number;
  assetImageId: number | null;
  projectId: number;
  workspaceId: string;
  storageKey: string | null;
  filePath: string | null;
  imageDeletionState: string;
  imageDeletionOperationId: string | null;
  assetDeletionState: string;
  projectDeletionState: string;
}

interface AssetImageSnapshot {
  id: number;
  assetId: number;
  filePath: string | null;
  storageKey: string | null;
  state: string | null;
  deletionState: string;
  deletionOperationId: string | null;
}

interface AssetMediaSnapshot {
  id: string;
  taskId: string;
  workspaceId: string;
  projectId: number;
  source: string;
  metadata: string;
  localPath: string | null;
  storageKey: string | null;
  deletionState: string;
  deletionOperationId: string | null;
}

interface AssetTaskSnapshot {
  id: number;
  state: string;
  relatedObjects: string | null;
}

interface AssetDeletionSource {
  rootAssetId: number;
  projectId: number;
  workspaceId: string;
  projectDeletionState: string;
  assets: Array<{
    id: number;
    parentAssetId: number | null;
    imageId: number | null;
    flowId: number | null;
    deletionState: string;
    deletionOperationId: string | null;
  }>;
  images: AssetImageSnapshot[];
  mediaAssets: AssetMediaSnapshot[];
  producerTasks: AssetTaskSnapshot[];
  storageKeys: string[];
  sourceHash: string;
}

interface MediaDeletionSource {
  mediaAsset: AssetMediaSnapshot;
  projectDeletionState: string;
  storageKeys: string[];
  sourceHash: string;
}

interface DeletionResourceAuthority {
  projectId: number;
  workspaceId: string;
}

export class DeletionWorkflowError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "DeletionWorkflowError";
    this.code = code;
    this.status = status;
  }
}

function workflowError(
  message: string,
  code: string,
  status: number,
): never {
  throw new DeletionWorkflowError(message, code, status);
}

function defaultDeletionDatabase(): Knex {
  const databaseModule = require("@/utils/db") as typeof import("@/utils/db");
  return databaseModule.db as unknown as Knex;
}

async function defaultProjectAuthorization(
  input: ProjectAuthorizationInput,
): Promise<ProjectPermissionResult> {
  const { checkProjectPermission } =
    await import("@/middleware/projectAccess");
  return await checkProjectPermission(input);
}

function runtime(
  input: DeletionWorkflowRuntime = {},
): ResolvedDeletionWorkflowRuntime {
  return {
    database: input.database ?? defaultDeletionDatabase(),
    clock: input.clock ?? (() => Date.now()),
    idFactory: input.idFactory ?? (() => crypto.randomUUID()),
    signal: input.signal,
    beforeClaimedOperationCommit: input.beforeClaimedOperationCommit,
    authorizeProject:
      input.authorizeProject ?? defaultProjectAuthorization,
    captureTarget: input.captureTarget ?? captureStorageDeletionTarget,
    captureKeyTargets: input.captureKeyTargets
      ?? (input.captureTarget
        ? async (key, captureRuntime) => {
            const captured = captureRuntime
              ? await input.captureTarget!(key, captureRuntime)
              : await input.captureTarget!(key);
            return captured ? [captured] : [];
          }
        : captureStorageKeyDeletionTargets),
    capturePrefixTargetPage:
      input.capturePrefixTargetPage
      ?? captureStoragePrefixDeletionTargetPage,
  };
}

function positiveId(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    workflowError(`${name} 必须是正安全整数`, "DELETION_INPUT_INVALID", 400);
  }
  return value;
}

function boundedPositiveInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number <= 0
    || number > maximum
  ) {
    workflowError(`${name} 无效`, "DELETION_INPUT_INVALID", 400);
  }
  return number;
}

function nonEmptyText(
  value: unknown,
  name: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    workflowError(`${name} 无效`, "DELETION_INPUT_INVALID", 400);
  }
  return value;
}

function now(runtimeValue: ResolvedDeletionWorkflowRuntime): number {
  const value = runtimeValue.clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    workflowError("删除工作流时钟无效", "DELETION_WORKFLOW_CLOCK_INVALID", 500);
  }
  return value;
}

function assertWorkflowNotAborted(
  runtimeValue: ResolvedDeletionWorkflowRuntime,
): void {
  if (!runtimeValue.signal?.aborted) return;
  const reason = runtimeValue.signal.reason;
  if (reason instanceof DeletionWorkflowError) throw reason;
  workflowError(
    "删除 operation 已中止，禁止继续提交",
    "DELETION_OPERATION_ABORTED",
    409,
  );
}

async function beforeClaimedOperationCommit(
  runtimeValue: ResolvedDeletionWorkflowRuntime,
  claim?: DeletionOperationLease,
): Promise<void> {
  assertWorkflowNotAborted(runtimeValue);
  if (claim && runtimeValue.beforeClaimedOperationCommit) {
    // A finalizer cannot renew through a second connection after its
    // transaction holds this operation's row lock. The worker hook therefore
    // stops periodic heartbeats and performs one last CAS renewal here,
    // before the final transaction starts. Once locked, the row itself
    // prevents fence takeover until commit/rollback.
    await runtimeValue.beforeClaimedOperationCommit(claim);
  }
  assertWorkflowNotAborted(runtimeValue);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function persistedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function persistedInteger(value: unknown, nullable = false): number | null {
  if (nullable && (value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    workflowError(
      "删除 operation 持久化记录无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  return number;
}

function mapOperation(row: Record<string, unknown>): DeletionOperationRecord {
  const kind = row.kind;
  const status = row.status;
  if (
    kind !== "image"
    && kind !== "asset"
    && kind !== "project"
  ) {
    workflowError(
      "删除 operation kind 无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  if (
    status !== "preparing"
    && status !== "deleting"
    && status !== "completed"
    && status !== "blocked"
  ) {
    workflowError(
      "删除 operation status 无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  const record = {
    id: persistedString(row.id),
    operationKey: persistedString(row.operationKey),
    kind,
    workspaceId: persistedString(row.workspaceId),
    projectId: persistedInteger(row.projectId),
    resourceId: persistedString(row.resourceId),
    status,
    requestHash: persistedString(row.requestHash),
    manifestHash: persistedString(row.manifestHash),
    manifestRevision: persistedInteger(row.manifestRevision),
    expectedItemCount: persistedInteger(row.expectedItemCount, true),
    requestedBy: persistedInteger(row.requestedBy),
    requestedAt: persistedInteger(row.requestedAt),
    finalizedAt: persistedInteger(row.finalizedAt, true),
    auditSnapshot: persistedString(row.auditSnapshot),
    auditSnapshotHash: persistedString(row.auditSnapshotHash),
    errorCode: persistedString(row.errorCode),
    coordinatorLeaseOwner: persistedString(row.coordinatorLeaseOwner),
    coordinatorLeaseExpiresAt: persistedInteger(
      row.coordinatorLeaseExpiresAt,
      true,
    ),
    coordinatorFence: persistedInteger(row.coordinatorFence),
    retryCount: persistedInteger(row.retryCount),
    nextAttemptAt: persistedInteger(row.nextAttemptAt),
    createdAt: persistedInteger(row.createdAt),
    updatedAt: persistedInteger(row.updatedAt),
  };
  if (
    !record.id
    || !record.operationKey
    || !record.workspaceId
    || !record.resourceId
    || !record.requestHash
    || record.projectId === null
    || record.projectId <= 0
    || record.requestedBy === null
    || record.requestedBy <= 0
    || record.manifestRevision === null
    || record.coordinatorFence === null
    || record.retryCount === null
    || record.nextAttemptAt === null
    || record.requestedAt === null
    || record.createdAt === null
    || record.updatedAt === null
    || (
      (record.coordinatorLeaseOwner === null)
      !== (record.coordinatorLeaseExpiresAt === null)
    )
    || (
      record.coordinatorLeaseOwner !== null
      && !["preparing", "deleting"].includes(record.status)
    )
    || (
      record.kind === "project"
      && record.status === "completed"
      && (
        record.auditSnapshot === null
        || record.auditSnapshotHash === null
        || sha256(record.auditSnapshot) !== record.auditSnapshotHash
      )
    )
    || (
      !(record.kind === "project" && record.status === "completed")
      && (
        record.auditSnapshot !== null
        || record.auditSnapshotHash !== null
      )
    )
  ) {
    workflowError(
      "删除 operation 持久化记录无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  return record as DeletionOperationRecord;
}

async function readOperation(
  client: Knex | Knex.Transaction,
  operationId: string,
): Promise<DeletionOperationRecord | null> {
  const row = await client(DELETION_OPERATION_TABLE)
    .where({ id: operationId })
    .first();
  return row ? mapOperation(row) : null;
}

export async function getDeletionOperation(
  operationId: string,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<DeletionOperationRecord | null> {
  const normalized = String(operationId || "").trim();
  if (!normalized || normalized.length > 255) {
    workflowError(
      "删除 operationId 无效",
      "DELETION_INPUT_INVALID",
      400,
    );
  }
  return readOperation(runtime(runtimeInput).database, normalized);
}

export async function getAuthorizedDeletionOperation(
  input: DeletionActor & { operationId: string },
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  const userId = positiveId(input.userId, "userId");
  const operation = await getDeletionOperation(
    input.operationId,
    runtimeValue,
  );
  if (!operation) {
    workflowError(
      "删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  await requireAuthorization(runtimeValue, {
    projectId: operation.projectId,
    userId,
    role: input.role,
    authWorkspaceId: input.authWorkspaceId,
    permission: "project:delete",
    allowDeleting: true,
  });
  return operation;
}

function isPostgres(database: Knex): boolean {
  const client = String(
    (database.client.config as { client?: unknown }).client || "",
  ).toLowerCase();
  return client === "pg" || client.includes("postgres");
}

function applyOperationClaimEligibility(
  query: Knex.QueryBuilder,
  currentTime: number,
): Knex.QueryBuilder {
  return query
    .whereIn("status", ["preparing", "deleting"])
    .andWhere("nextAttemptAt", "<=", currentTime)
    .andWhere((lease) => {
      lease
        .where((unleased) => {
          unleased
            .whereNull("coordinatorLeaseOwner")
            .whereNull("coordinatorLeaseExpiresAt");
        })
        .orWhere((expired) => {
          expired
            .whereNotNull("coordinatorLeaseOwner")
            .whereNotNull("coordinatorLeaseExpiresAt")
            .andWhere("coordinatorLeaseExpiresAt", "<=", currentTime);
        });
    });
}

export async function claimDueDeletionOperations(
  input: ClaimDeletionOperationsInput,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<ClaimedDeletionOperation[]> {
  const runtimeValue = runtime(runtimeInput);
  const workerId = nonEmptyText(input.workerId, "workerId", 255);
  const leaseMs = boundedPositiveInteger(
    input.leaseMs ?? 5 * 60_000,
    "leaseMs",
    24 * 60 * 60_000,
  );
  const limit = boundedPositiveInteger(input.limit ?? 20, "limit", 100);
  const claimedAt = now(runtimeValue);
  const expiresAt = claimedAt + leaseMs;
  if (!Number.isSafeInteger(expiresAt)) {
    workflowError(
      "删除 operation 租约时间溢出",
      "DELETION_OPERATION_CLOCK_INVALID",
      500,
    );
  }

  return runtimeValue.database.transaction(async (transaction) => {
    let candidateQuery = applyOperationClaimEligibility(
      transaction(DELETION_OPERATION_TABLE),
      claimedAt,
    )
      .orderBy("nextAttemptAt", "asc")
      .orderBy("createdAt", "asc")
      .limit(limit);
    if (isPostgres(runtimeValue.database)) {
      candidateQuery = candidateQuery.forUpdate().skipLocked();
    }
    const candidates = await candidateQuery;
    const claimed: ClaimedDeletionOperation[] = [];
    for (const candidate of candidates) {
      let mapped: DeletionOperationRecord;
      try {
        mapped = mapOperation(candidate);
      } catch (error) {
        if (
          !(error instanceof DeletionWorkflowError)
          || error.code !== "DELETION_OPERATION_ROW_INVALID"
        ) {
          throw error;
        }
        const quarantined = await transaction(DELETION_OPERATION_TABLE)
          .where({
            id: candidate.id,
            status: candidate.status,
          })
          .whereIn("status", ["preparing", "deleting"])
          .update({
            status: "blocked",
            errorCode: "DELETION_OPERATION_ROW_INVALID",
            coordinatorLeaseOwner: null,
            coordinatorLeaseExpiresAt: null,
            nextAttemptAt: claimedAt,
            updatedAt: claimedAt,
          });
        if (Number(quarantined) > 1) {
          workflowError(
            "删除 operation 隔离失败",
            "DELETION_OPERATION_ROW_INVALID",
            500,
          );
        }
        continue;
      }
      if (mapped.coordinatorFence >= Number.MAX_SAFE_INTEGER) {
        await transaction(DELETION_OPERATION_TABLE)
          .where({
            id: mapped.id,
            status: mapped.status,
            coordinatorFence: mapped.coordinatorFence,
          })
          .update({
            status: "blocked",
            errorCode: "DELETION_OPERATION_FENCE_EXHAUSTED",
            coordinatorLeaseOwner: null,
            coordinatorLeaseExpiresAt: null,
            nextAttemptAt: claimedAt,
            updatedAt: claimedAt,
          });
        continue;
      }
      const nextFence = mapped.coordinatorFence + 1;
      let updateQuery = transaction(DELETION_OPERATION_TABLE)
        .where({
          id: mapped.id,
          status: mapped.status,
          coordinatorFence: mapped.coordinatorFence,
        });
      updateQuery = applyOperationClaimEligibility(updateQuery, claimedAt);
      const affected = await updateQuery.update({
        coordinatorLeaseOwner: workerId,
        coordinatorLeaseExpiresAt: expiresAt,
        coordinatorFence: nextFence,
        updatedAt: claimedAt,
      });
      if (Number(affected) !== 1) continue;
      const row = await transaction(DELETION_OPERATION_TABLE)
        .where({ id: mapped.id })
        .first();
      const record = row ? mapOperation(row) : null;
      if (
        !record
        || (record.status !== "preparing" && record.status !== "deleting")
        || record.coordinatorLeaseOwner !== workerId
        || record.coordinatorLeaseExpiresAt !== expiresAt
        || record.coordinatorFence !== nextFence
      ) {
        workflowError(
          "删除 operation 租约持久化失败",
          "DELETION_OPERATION_ROW_INVALID",
          500,
        );
      }
      claimed.push(record as ClaimedDeletionOperation);
    }
    return claimed;
  });
}

export async function renewDeletionOperationClaim(
  input: RenewDeletionOperationClaimInput,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<ClaimedDeletionOperation> {
  const runtimeValue = runtime(runtimeInput);
  const operationId = nonEmptyText(
    input.operationId,
    "operationId",
    255,
  );
  const owner = nonEmptyText(input.workerId, "workerId", 255);
  const fence = boundedPositiveInteger(
    input.coordinatorFence,
    "coordinatorFence",
    Number.MAX_SAFE_INTEGER,
  );
  const leaseMs = boundedPositiveInteger(
    input.leaseMs ?? 5 * 60_000,
    "leaseMs",
    24 * 60 * 60_000,
  );
  if (input.status !== "preparing" && input.status !== "deleting") {
    workflowError(
      "删除 operation 续租状态无效",
      "DELETION_INPUT_INVALID",
      400,
    );
  }
  const renewedAt = now(runtimeValue);
  const currentRow = await runtimeValue.database(DELETION_OPERATION_TABLE)
    .where({ id: operationId })
    .first();
  if (!currentRow) {
    workflowError(
      "删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  const current = mapOperation(currentRow);
  if (
    current.status !== input.status
    || current.coordinatorLeaseOwner !== owner
    || current.coordinatorFence !== fence
    || current.coordinatorLeaseExpiresAt === null
    || current.coordinatorLeaseExpiresAt <= renewedAt
  ) {
    workflowError(
      "删除 operation 租约已过期、转移或 fencing token 不匹配",
      "DELETION_OPERATION_LEASE_LOST",
      409,
    );
  }
  if (renewedAt < current.updatedAt) {
    workflowError(
      "删除 operation 续租时钟发生回退",
      "DELETION_OPERATION_CLOCK_INVALID",
      500,
    );
  }
  const requestedExpiry = renewedAt + leaseMs;
  const strictExtension = current.coordinatorLeaseExpiresAt + 1;
  const expiresAt = Math.max(requestedExpiry, strictExtension);
  if (
    !Number.isSafeInteger(requestedExpiry)
    || !Number.isSafeInteger(strictExtension)
    || !Number.isSafeInteger(expiresAt)
  ) {
    workflowError(
      "删除 operation 续租时间溢出",
      "DELETION_OPERATION_CLOCK_INVALID",
      500,
    );
  }
  const affected = await runtimeValue.database(DELETION_OPERATION_TABLE)
    .where({
      id: operationId,
      status: input.status,
      coordinatorLeaseOwner: owner,
      coordinatorLeaseExpiresAt: current.coordinatorLeaseExpiresAt,
      coordinatorFence: fence,
    })
    .andWhere("coordinatorLeaseExpiresAt", ">", renewedAt)
    .update({
      coordinatorLeaseExpiresAt: expiresAt,
      updatedAt: renewedAt,
    });
  if (Number(affected) !== 1) {
    workflowError(
      "删除 operation 租约已过期、转移或 fencing token 不匹配",
      "DELETION_OPERATION_LEASE_LOST",
      409,
    );
  }
  const renewedRow = await runtimeValue.database(DELETION_OPERATION_TABLE)
    .where({ id: operationId })
    .first();
  const renewed = renewedRow ? mapOperation(renewedRow) : null;
  if (
    !renewed
    || renewed.status !== input.status
    || renewed.coordinatorLeaseOwner !== owner
    || renewed.coordinatorLeaseExpiresAt !== expiresAt
    || renewed.coordinatorFence !== fence
  ) {
    workflowError(
      "删除 operation 续租持久化失败",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  return renewed as ClaimedDeletionOperation;
}

function claimWhere(
  query: Knex.QueryBuilder,
  claim: DeletionOperationLease,
): Knex.QueryBuilder {
  return query.where({
    id: claim.operationId,
    coordinatorLeaseOwner: claim.workerId,
    coordinatorFence: claim.coordinatorFence,
  });
}

function assertActiveClaim(
  operation: DeletionOperationRecord,
  claim: DeletionOperationLease,
  currentTime: number,
): void {
  if (
    operation.id !== claim.operationId
    || operation.coordinatorLeaseOwner !== claim.workerId
    || operation.coordinatorFence !== claim.coordinatorFence
    || operation.coordinatorLeaseExpiresAt === null
    || operation.coordinatorLeaseExpiresAt <= currentTime
  ) {
    workflowError(
      "删除 operation 租约已过期、转移或 fencing token 不匹配",
      "DELETION_OPERATION_LEASE_LOST",
      409,
    );
  }
}

export async function releaseDeletionOperationClaim(
  claim: DeletionOperationLease,
  delayMs = 1_000,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  const normalizedDelay = boundedPositiveInteger(
    delayMs,
    "delayMs",
    24 * 60 * 60_000,
  );
  const releasedAt = now(runtimeValue);
  const nextAttemptAt = releasedAt + normalizedDelay;
  const affected = await claimWhere(
    runtimeValue.database(DELETION_OPERATION_TABLE),
    claim,
  )
    .whereIn("status", ["preparing", "deleting"])
    .andWhere("coordinatorLeaseExpiresAt", ">", releasedAt)
    .update({
      coordinatorLeaseOwner: null,
      coordinatorLeaseExpiresAt: null,
      nextAttemptAt,
      updatedAt: releasedAt,
    });
  if (Number(affected) !== 1) {
    workflowError(
      "删除 operation 租约已过期、转移或 fencing token 不匹配",
      "DELETION_OPERATION_LEASE_LOST",
      409,
    );
  }
  const operation = await readOperation(
    runtimeValue.database,
    claim.operationId,
  );
  if (!operation) {
    workflowError(
      "删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  return operation;
}

function operationKey(
  kind: DeletionOperationKind,
  workspaceId: string,
  resourceId: string,
): string {
  return `${kind}:${sha256(stableJson([workspaceId, resourceId]))}`;
}

function requestHash(input: {
  kind: DeletionOperationKind;
  workspaceId: string;
  projectId: number;
  resourceId: string;
}): string {
  return sha256(stableJson({
    version: "deletion-workflow-request.v1",
    ...input,
  }));
}

async function requireAuthorization(
  runtimeValue: ResolvedDeletionWorkflowRuntime,
  input: ProjectAuthorizationInput,
): Promise<void> {
  const result = await runtimeValue.authorizeProject(input);
  if (!result.allowed) {
    workflowError(
      result.message,
      result.status === 404
        ? "DELETION_RESOURCE_NOT_FOUND"
        : "DELETION_PERMISSION_DENIED",
      result.status,
    );
  }
}

function safeOwnedStorageKey(input: {
  storageKey: unknown;
  legacyValue: unknown;
  field: string;
  allowLegacyRelative: boolean;
  projectId: number;
}): string | null {
  const authoritative = persistedString(input.storageKey);
  const legacy = persistedString(input.legacyValue);
  const candidate = authoritative
    ?? (input.allowLegacyRelative ? legacy : null);
  if (!candidate) {
    if (!legacy || /^https?:\/\//iu.test(legacy)) return null;
    workflowError(
      `${input.field} 缺少服务端权威 storageKey，必须人工修复后才能删除`,
      "DELETION_AUTHORITATIVE_STORAGE_KEY_REQUIRED",
      409,
    );
  }
  let normalized: string;
  try {
    normalized = normalizeObjectKey(candidate);
  } catch {
    workflowError(
      `${input.field} 的 storageKey 无效`,
      "DELETION_AUTHORITATIVE_STORAGE_KEY_INVALID",
      409,
    );
  }
  const isCanonicalAuthoritative = authoritative !== null
    && normalized === authoritative
    && normalized.startsWith(`${input.projectId}/`);
  const isProjectScopedLegacy = authoritative === null
    && input.allowLegacyRelative
    && (legacy === normalized || legacy === `/${normalized}`)
    && normalized.startsWith(`${input.projectId}/`);
  if (
    (!isCanonicalAuthoritative && !isProjectScopedLegacy)
    || candidate.includes("\\")
    || candidate.includes("?")
    || candidate.includes("#")
    || /^[a-z][a-z0-9+.-]*:/iu.test(candidate)
  ) {
    workflowError(
      `${input.field} 不是可证明归属的对象存储 key`,
      "DELETION_AUTHORITATIVE_STORAGE_KEY_REQUIRED",
      409,
    );
  }
  return normalized;
}

async function loadImageAuthority(
  client: Knex | Knex.Transaction,
  imageId: number,
  lock = false,
): Promise<ImageAuthoritySnapshot | null> {
  let query = client("o_image as image")
    .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .where("image.id", imageId)
    .select({
      imageId: "image.id",
      assetId: "asset.id",
      assetImageId: "asset.imageId",
      projectId: "project.id",
      workspaceId: "project.workspaceId",
      storageKey: "image.storageKey",
      filePath: "image.filePath",
      imageDeletionState: "image.deletionState",
      imageDeletionOperationId: "image.deletionOperationId",
      assetDeletionState: "asset.deletionState",
      projectDeletionState: "project.deletionState",
    });
  if (lock) query = query.forUpdate();
  const row = await query.first();
  if (!row) return null;
  const snapshot: ImageAuthoritySnapshot = {
    imageId: Number(row.imageId),
    assetId: Number(row.assetId),
    assetImageId: row.assetImageId == null ? null : Number(row.assetImageId),
    projectId: Number(row.projectId),
    workspaceId: String(row.workspaceId || ""),
    storageKey: persistedString(row.storageKey),
    filePath: persistedString(row.filePath),
    imageDeletionState: String(row.imageDeletionState || "active"),
    imageDeletionOperationId: persistedString(row.imageDeletionOperationId),
    assetDeletionState: String(row.assetDeletionState || "active"),
    projectDeletionState: String(row.projectDeletionState || "active"),
  };
  if (
    snapshot.imageId !== imageId
    || !Number.isSafeInteger(snapshot.assetId)
    || snapshot.assetId <= 0
    || !Number.isSafeInteger(snapshot.projectId)
    || snapshot.projectId <= 0
    || !snapshot.workspaceId
  ) {
    workflowError(
      "图片归属链无效",
      "DELETION_AUTHORITY_CHAIN_INVALID",
      404,
    );
  }
  return snapshot;
}

async function assertImageReferencesOwnedByProject(
  client: Knex | Knex.Transaction,
  imageId: number,
  projectId: number,
  lock = false,
): Promise<number[]> {
  let query = client("o_assets")
    .where({ imageId })
    .select("id", "projectId");
  if (lock) query = query.forUpdate();
  const references = await query;
  if (references.some((row) => Number(row.projectId) !== projectId)) {
    workflowError(
      "图片被其他项目引用，无法证明删除权限",
      "DELETION_AUTHORITY_CHAIN_INVALID",
      409,
    );
  }
  return safeNumericIds(references, "id");
}

async function assertImageStorageKeyExclusive(
  client: Knex | Knex.Transaction,
  input: {
    imageId: number;
    projectId: number;
    storageKey: string | null;
    lock?: boolean;
  },
): Promise<void> {
  if (!input.storageKey) return;
  const key = input.storageKey;
  const legacyKeys = [key, `/${key}`];
  const first = async (
    query: Knex.QueryBuilder,
  ): Promise<Record<string, unknown> | undefined> => {
    const locked = input.lock ? query.forUpdate() : query;
    return locked.first();
  };
  const withLegacyKey = (
    query: Knex.QueryBuilder,
    authoritativeColumn: string,
    legacyColumn: string,
  ): Knex.QueryBuilder => query.andWhere((where) => {
    where.where(authoritativeColumn, key).orWhere((legacy) => {
      legacy
        .whereNull(authoritativeColumn)
        .whereIn(legacyColumn, legacyKeys);
    });
  });

  const imageConflict = await first(withLegacyKey(
    client("o_image as candidate")
      .innerJoin("o_assets as owner", "owner.id", "candidate.assetsId")
      .where("owner.projectId", input.projectId)
      .whereNot("candidate.id", input.imageId)
      .select("candidate.id"),
    "candidate.storageKey",
    "candidate.filePath",
  ));
  if (imageConflict) {
    workflowError(
      "对象存储 key 仍被同项目的其他图片引用",
      "DELETION_STORAGE_KEY_SHARED",
      409,
    );
  }

  const directReferences: Array<{
    name: string;
    query: Knex.QueryBuilder;
  }> = [
    {
      name: "项目封面",
      query: client("o_project")
        .where({ id: input.projectId, coverStorageKey: key })
        .select("id"),
    },
    {
      name: "分镜",
      query: withLegacyKey(
        client("o_storyboard")
          .where({ projectId: input.projectId })
          .select("id"),
        "storageKey",
        "filePath",
      ),
    },
    {
      name: "视频",
      query: withLegacyKey(
        client("o_video")
          .where({ projectId: input.projectId })
          .select("id"),
        "storageKey",
        "filePath",
      ),
    },
    {
      name: "工作流封面",
      query: client("o_workflow_graph")
        .where({
          projectId: input.projectId,
          coverStorageKey: key,
        })
        .select("id"),
    },
    {
      name: "画布资源",
      query: client("o_canvas_asset")
        .where({ projectId: input.projectId })
        .andWhere((where) => {
          where
            .where("coverStorageKey", key)
            .orWhere("saveStorageKey", key);
        })
        .select("id"),
    },
    {
      name: "媒体资源",
      query: withLegacyKey(
        client("o_media_asset")
          .where({ projectId: input.projectId })
          .select("id"),
        "storageKey",
        "localPath",
      ),
    },
  ];
  for (const reference of directReferences) {
    if (await first(reference.query)) {
      workflowError(
        `对象存储 key 仍被同项目的${reference.name}引用`,
        "DELETION_STORAGE_KEY_SHARED",
        409,
      );
    }
  }
}

interface TaskProducerEvidence {
  assetId: number | null;
  imageId: number | null;
  outputStorageKey: string | null;
}

function parseTaskProducerEvidence(
  relatedObjects: unknown,
): TaskProducerEvidence {
  if (typeof relatedObjects !== "string" || !relatedObjects.trim()) {
    return { assetId: null, imageId: null, outputStorageKey: null };
  }
  try {
    const parsed = JSON.parse(relatedObjects) as unknown;
    if (
      parsed === null
      || typeof parsed !== "object"
      || Array.isArray(parsed)
    ) {
      return { assetId: null, imageId: null, outputStorageKey: null };
    }
    const value = parsed as Record<string, unknown>;
    const assetId = Number(value.assetId ?? value.id);
    const imageId = Number(value.imageId);
    return {
      assetId: Number.isSafeInteger(assetId) && assetId > 0
        ? assetId
        : null,
      imageId: Number.isSafeInteger(imageId) && imageId > 0
        ? imageId
        : null,
      outputStorageKey: persistedString(value.outputStorageKey),
    };
  } catch {
    return { assetId: null, imageId: null, outputStorageKey: null };
  }
}

function taskOutputStorageKeys(
  tasks: Array<Record<string, unknown>>,
  input: {
    projectId: number;
    imageId?: number;
  },
): string[] {
  const keys = new Set<string>();
  for (const task of tasks) {
    const evidence = parseTaskProducerEvidence(task.relatedObjects);
    if (
      input.imageId !== undefined
      && evidence.imageId !== input.imageId
    ) continue;
    if (!evidence.outputStorageKey) continue;
    const key = safeOwnedStorageKey({
      storageKey: evidence.outputStorageKey,
      legacyValue: null,
      field: `o_tasks(${String(task.id)}).relatedObjects.outputStorageKey`,
      allowLegacyRelative: false,
      projectId: input.projectId,
    });
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

async function loadImageProducerStorageKeys(
  client: Knex | Knex.Transaction,
  input: {
    imageId: number;
    projectId: number;
    lock?: boolean;
  },
): Promise<string[]> {
  if (!(await client.schema.hasTable("o_tasks"))) return [];
  let query = client("o_tasks")
    .where({ projectId: input.projectId })
    .select("id", "relatedObjects", "state");
  if (input.lock) query = query.forUpdate();
  return taskOutputStorageKeys(await query, input);
}

async function assertNoActiveImageWork(
  client: Knex | Knex.Transaction,
  input: {
    imageId: number;
    projectId: number;
    lock?: boolean;
  },
): Promise<void> {
  if (!(await client.schema.hasTable("o_tasks"))) return;
  let query = client("o_tasks")
    .where({ projectId: input.projectId })
    .whereIn("state", ["进行中", "生成中"])
    .select("id", "relatedObjects", "state");
  if (input.lock) query = query.forUpdate();
  const activeTasks = await query;
  if (activeTasks.some((row) =>
    parseTaskProducerEvidence(row.relatedObjects).imageId
      === input.imageId)) {
    workflowError(
      "图片仍有未终态生成任务，删除请求必须等待其停止",
      "DELETION_IMAGE_ACTIVE_WORK",
      409,
    );
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null
        && typeof parsed === "object"
        && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function linkedNumericAsset(
  metadata: unknown,
): { assetId: number; assetVersionId: number | null } | null {
  const parsed = parseJsonRecord(metadata);
  if (!parsed) return null;
  const assetId = Number(parsed.assetId);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) return null;
  const rawVersionId = parsed.assetVersionId;
  const assetVersionId = rawVersionId == null
    ? null
    : Number(rawVersionId);
  if (
    assetVersionId !== null
    && (!Number.isSafeInteger(assetVersionId) || assetVersionId <= 0)
  ) return null;
  return { assetId, assetVersionId };
}

function mediaResourceId(mediaAssetId: string): string {
  return `media:${mediaAssetId}`;
}

function mediaIdFromResourceId(resourceId: string): string | null {
  return resourceId.startsWith("media:")
    ? resourceId.slice("media:".length)
    : null;
}

function validatedMediaAssetId(value: unknown): string {
  const id = nonEmptyText(value, "mediaAssetId", 200);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(id)
  ) {
    workflowError(
      "mediaAssetId 无效",
      "DELETION_INPUT_INVALID",
      400,
    );
  }
  return id;
}

const TERMINAL_PROJECT_TASK_STATES = new Set([
  "已完成",
  "生成失败",
]);
const TERMINAL_RELAY_TASK_STATES = new Set([
  "mocked",
  "succeeded",
  "failed",
  "cancelled",
]);
const TERMINAL_ENHANCE_TASK_STATES = new Set([
  "succeeded",
  "failed",
]);
const TERMINAL_ENHANCE_BILLING_STATES = new Set([
  "not_billed",
  "settled",
  "released",
]);
const UNRESOLVED_BILLING_RECONCILIATION_STATES = [
  "pending",
  "leased",
  "manual_required",
] as const;
const VALID_BILLING_RECONCILIATION_STATES = new Set<string>([
  ...UNRESOLVED_BILLING_RECONCILIATION_STATES,
  "resolved",
]);

interface RelayBillingTaskEvidence {
  id: string;
  providerPayload: unknown;
}

type RelayBillingMarker =
  | { kind: "legacy" }
  | { kind: "declared"; reservationId: string }
  | { kind: "invalid" };

function readRelayBillingMarker(providerPayload: unknown): RelayBillingMarker {
  let payload: Record<string, unknown> | null = null;
  if (typeof providerPayload === "string") {
    payload = parseJsonRecord(providerPayload);
  } else if (
    providerPayload !== null
    && typeof providerPayload === "object"
    && !Array.isArray(providerPayload)
  ) {
    payload = providerPayload as Record<string, unknown>;
  }
  if (!payload) return { kind: "invalid" };
  if (!Object.prototype.hasOwnProperty.call(payload, "billing")) {
    return { kind: "legacy" };
  }
  const billing = payload.billing;
  if (
    billing === null
    || typeof billing !== "object"
    || Array.isArray(billing)
  ) {
    return { kind: "invalid" };
  }
  const reservationId =
    (billing as Record<string, unknown>).reservationId;
  if (
    typeof reservationId !== "string"
    || !reservationId
    || reservationId !== reservationId.trim()
  ) {
    return { kind: "invalid" };
  }
  return { kind: "declared", reservationId };
}

function relayBillingDeletionPending(input: {
  projectDeletion?: boolean;
  invalidEvidence?: boolean;
}): never {
  workflowError(
    input.invalidEvidence
      ? input.projectDeletion
        ? "项目 Relay 视频账务证据不完整，禁止删除"
        : "Relay 视频账务证据不完整，禁止删除其交付资产"
      : input.projectDeletion
        ? "项目仍有未核清的 Relay 视频账务，删除请求必须等待结算或释放确认"
        : "Relay 视频账务尚未核清，禁止删除其交付资产",
    input.projectDeletion
      ? "DELETION_PROJECT_BILLING_RECONCILIATION_PENDING"
      : "DELETION_ASSET_BILLING_RECONCILIATION_PENDING",
    409,
  );
}

async function assertRelayBillingResolved(
  client: Knex | Knex.Transaction,
  input: {
    tasks: RelayBillingTaskEvidence[];
    workspaceId: string;
    lock?: boolean;
    projectDeletion?: boolean;
  },
): Promise<void> {
  if (input.tasks.length === 0) return;
  const tasks = [...new Map(input.tasks.map((task) => [
    String(task.id),
    {
      id: String(task.id),
      providerPayload: task.providerPayload,
      marker: readRelayBillingMarker(task.providerPayload),
    },
  ])).values()].sort((left, right) => left.id.localeCompare(right.id));
  const taskIds = tasks.map((task) => task.id);
  const declaredReservationIds = [...new Set(tasks.flatMap((task) =>
    task.marker.kind === "declared"
      ? [task.marker.reservationId]
      : []))]
    .sort();
  const invalidMarker = tasks.some((task) => task.marker.kind === "invalid");
  const [hasLedger, hasJobs] = await Promise.all([
    client.schema.hasTable("o_billing_ledger"),
    client.schema.hasTable("o_billing_reconcile_job"),
  ]);
  // Old installations without either billing table cannot contain the
  // authoritative relation. A partially migrated relation fails closed.
  if (!hasLedger && !hasJobs) {
    if (
      invalidMarker
      || declaredReservationIds.length > 0
    ) {
      relayBillingDeletionPending({
        projectDeletion: input.projectDeletion,
        invalidEvidence: true,
      });
    }
    return;
  }
  if (!hasLedger || !hasJobs) {
    relayBillingDeletionPending({
      projectDeletion: input.projectDeletion,
      invalidEvidence: true,
    });
  }

  let ledgerQuery = client("o_billing_ledger")
    .where({ type: "freeze" })
    .andWhere((query) => {
      query.whereIn("relatedTaskId", taskIds);
      if (declaredReservationIds.length > 0) {
        query.orWhereIn("id", declaredReservationIds);
      }
    })
    .orderBy("id", "asc")
    .select(
      "id",
      "workspaceId",
      "relatedTaskId",
      "remainingMicros",
    );
  if (input.lock) ledgerQuery = ledgerQuery.forUpdate();
  const ledgers = await ledgerQuery;
  const invalidLedgerRelation = ledgers.some((ledger) => {
    const ledgerId = ledger.id;
    return (
      typeof ledgerId !== "string"
      || ledgerId.length === 0
      || ledgerId !== ledgerId.trim()
      || (
        taskIds.includes(String(ledger.relatedTaskId || ""))
        && String(ledger.workspaceId || "") !== input.workspaceId
      )
    );
  });
  const invalidLedgerAmount = ledgers.some((ledger) => {
    const raw = ledger.remainingMicros;
    if (
      raw === null
      || raw === undefined
      || typeof raw === "string" && !raw.trim()
      || !["number", "string"].includes(typeof raw)
    ) {
      return true;
    }
    const amount = Number(raw);
    return !Number.isSafeInteger(amount) || amount < 0;
  });
  const markerMismatch =
    invalidMarker
    || invalidLedgerRelation
    || invalidLedgerAmount
    || tasks.some((task) => {
    if (task.marker.kind !== "declared") return false;
    const reservationId = task.marker.reservationId;
    return ledgers.filter((ledger) =>
      String(ledger.id || "") === reservationId
      && String(ledger.workspaceId || "") === input.workspaceId
      && String(ledger.relatedTaskId || "") === task.id)
      .length !== 1;
  });
  if (markerMismatch) {
    relayBillingDeletionPending({
      projectDeletion: input.projectDeletion,
      invalidEvidence: true,
    });
  }
  const openFreeze = ledgers.find((ledger) =>
    Number(ledger.remainingMicros) > 0);
  const reservationIds = ledgers.map((ledger) => String(ledger.id));
  let billingJobs: Record<string, unknown>[] = [];
  if (reservationIds.length > 0) {
    let jobQuery = client("o_billing_reconcile_job")
      .whereIn("reservationId", reservationIds)
      .orderBy("id", "asc")
      .select("id", "workspaceId", "reservationId", "status");
    if (input.lock) jobQuery = jobQuery.forUpdate();
    billingJobs = await jobQuery;
  }
  if (billingJobs.some((job) =>
    String(job.workspaceId || "") !== input.workspaceId
    || !VALID_BILLING_RECONCILIATION_STATES.has(
      String(job.status || ""),
    ))) {
    relayBillingDeletionPending({
      projectDeletion: input.projectDeletion,
      invalidEvidence: true,
    });
  }
  const unresolvedJob = billingJobs.find((job) =>
    UNRESOLVED_BILLING_RECONCILIATION_STATES.includes(
      String(job.status || "") as typeof UNRESOLVED_BILLING_RECONCILIATION_STATES[number],
    ));
  if (openFreeze || unresolvedJob) {
    relayBillingDeletionPending({
      projectDeletion: input.projectDeletion,
    });
  }
}

async function lockRelayBillingForDeletion(
  transaction: Knex.Transaction,
  input: {
    candidateTaskIds: string[];
    workspaceId: string;
  },
): Promise<void> {
  const candidateTaskIds = [...new Set(input.candidateTaskIds
    .map((taskId) => String(taskId || "").trim())
    .filter(Boolean))]
    .sort();
  if (
    candidateTaskIds.length === 0
    || !(await transaction.schema.hasTable("o_relay_task"))
  ) {
    return;
  }
  // Billing mutation paths use the canonical task -> freeze ledger ->
  // reconciliation job lock order. Acquire the task fence before any media or
  // asset row so finalization and deletion cannot deadlock each other.
  const relayTasks = await transaction("o_relay_task")
    .where({ workspaceId: input.workspaceId })
    .whereIn("id", candidateTaskIds)
    .orderBy("id", "asc")
    .select("id", "providerPayload")
    .forUpdate();
  await assertRelayBillingResolved(transaction, {
    tasks: relayTasks.map((task) => ({
      id: String(task.id),
      providerPayload: task.providerPayload,
    })),
    workspaceId: input.workspaceId,
    lock: true,
  });
}

async function assertMediaProducerTerminal(
  client: Knex | Knex.Transaction,
  media: AssetMediaSnapshot,
  options: {
    lock?: boolean;
    linkedNumericAsset: boolean;
  },
): Promise<void> {
  const lock = <T extends Knex.QueryBuilder>(query: T): T =>
    options.lock ? query.forUpdate() as T : query;
  const relayExists = await client.schema.hasTable("o_relay_task");
  const relay = relayExists
    ? await lock(client("o_relay_task")
      .where({ id: media.taskId })
      .select(
        "id",
        "workspaceId",
        "projectId",
        "status",
        "providerPayload",
      ))
      .first()
    : null;
  if (relay) {
    if (
      String(relay.workspaceId || "") !== media.workspaceId
      || Number(relay.projectId) !== media.projectId
    ) {
      workflowError(
        "媒体任务与项目归属不一致",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
    if (!TERMINAL_RELAY_TASK_STATES.has(String(relay.status || ""))) {
      workflowError(
        "媒体仍有未终态 Relay 生产任务",
        "DELETION_ASSET_ACTIVE_WORK",
        409,
      );
    }
    if (await client.schema.hasTable("o_relay_callback_delivery")) {
      const callback = await lock(client("o_relay_callback_delivery")
        .where({ taskId: media.taskId })
        .whereIn("status", ["pending", "leased"])
        .select("id", "status"))
        .first();
      if (callback) {
        workflowError(
          "媒体仍有未终态回调投递",
          "DELETION_ASSET_ACTIVE_WORK",
          409,
        );
      }
    }
    await assertRelayBillingResolved(client, {
      tasks: [{
        id: String(relay.id),
        providerPayload: relay.providerPayload,
      }],
      workspaceId: media.workspaceId,
      lock: options.lock,
    });
    return;
  }

  const enhanceExists = await client.schema.hasTable(
    "o_user_video_enhance_task",
  );
  const enhance = enhanceExists
    ? await lock(client("o_user_video_enhance_task")
      .where({ id: media.taskId })
      .select(
        "id",
        "workspaceId",
        "projectId",
        "status",
        "billingReconciliationState",
        "sourceAssetId",
        "resultAssetId",
      ))
      .first()
    : null;
  if (enhance) {
    if (
      String(enhance.workspaceId || "") !== media.workspaceId
      || Number(enhance.projectId) !== media.projectId
      || (
        String(enhance.sourceAssetId || "") !== media.id
        && String(enhance.resultAssetId || "") !== media.id
      )
    ) {
      workflowError(
        "增强任务与媒体归属链不一致",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
    if (
      !TERMINAL_ENHANCE_TASK_STATES.has(String(enhance.status || ""))
    ) {
      workflowError(
        "媒体仍有未终态增强任务",
        "DELETION_ASSET_ACTIVE_WORK",
        409,
      );
    }
    if (
      !TERMINAL_ENHANCE_BILLING_STATES.has(
        String(enhance.billingReconciliationState || ""),
      )
    ) {
      workflowError(
        "媒体增强账务尚未核清",
        "DELETION_ASSET_BILLING_RECONCILIATION_PENDING",
        409,
      );
    }
    return;
  }

  if (media.source === "quick-create") {
    // Quick-create only inserts this row after the synchronous upstream and
    // billing call returns. Its UUID is the terminal durable result identity.
    return;
  }
  if (media.source === "image-flow-upload") {
    // Image-flow uploads are synchronously persisted through a durable object
    // write intent before this project-owned media row is committed.
    return;
  }
  if (media.source === "agent" && options.linkedNumericAsset) {
    const metadata = parseJsonRecord(media.metadata);
    const stepId = persistedString(metadata?.stepId);
    if (!stepId || !(await client.schema.hasTable("o_agent_step"))) {
      workflowError(
        "Agent 媒体缺少可核验的终态 step",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
    const step = await lock(client("o_agent_step")
      .where({
        id: stepId,
        workspaceId: media.workspaceId,
        projectId: media.projectId,
      })
      .select("id", "status"))
      .first();
    if (
      !step
      || !["succeeded", "failed", "cancelled", "uncertain"].includes(
        String(step.status || ""),
      )
    ) {
      workflowError(
        "Agent 媒体仍有未终态生产 step",
        "DELETION_ASSET_ACTIVE_WORK",
        409,
      );
    }
    return;
  }
  workflowError(
    "媒体缺少可核验的终态生产任务",
    "DELETION_AUTHORITY_CHAIN_INVALID",
    409,
  );
}

function assetOperationOwnsAsset(
  asset: AssetDeletionSource["assets"][number],
  rootAssetId: number,
): boolean {
  return asset.id === rootAssetId || asset.parentAssetId === rootAssetId;
}

async function loadAssetDeletionAuthority(
  client: Knex | Knex.Transaction,
  assetId: number,
): Promise<DeletionResourceAuthority | null> {
  const row = await client("o_assets as asset")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .where("asset.id", assetId)
    .select({
      projectId: "project.id",
      workspaceId: "project.workspaceId",
    })
    .first();
  if (!row) return null;
  const projectId = Number(row.projectId);
  const workspaceId = String(row.workspaceId || "");
  if (
    !Number.isSafeInteger(projectId)
    || projectId <= 0
    || !workspaceId
  ) return null;
  return { projectId, workspaceId };
}

async function loadMediaDeletionAuthority(
  client: Knex | Knex.Transaction,
  mediaAssetId: string,
): Promise<DeletionResourceAuthority | null> {
  const row = await client("o_media_asset as media")
    .innerJoin("o_project as project", "project.id", "media.projectId")
    .where("media.id", mediaAssetId)
    .select({
      projectId: "project.id",
      workspaceId: "project.workspaceId",
    })
    .first();
  if (!row) return null;
  const projectId = Number(row.projectId);
  const workspaceId = String(row.workspaceId || "");
  if (
    !Number.isSafeInteger(projectId)
    || projectId <= 0
    || !workspaceId
  ) return null;
  return { projectId, workspaceId };
}

async function loadAssetDeletionSource(
  client: Knex | Knex.Transaction,
  assetId: number,
  options: { lock?: boolean } = {},
): Promise<AssetDeletionSource | null> {
  const maybeLock = <T extends Knex.QueryBuilder>(query: T): T =>
    options.lock ? query.forUpdate() as T : query;
  const root = await maybeLock(client("o_assets as asset")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .where("asset.id", assetId)
    .select({
      id: "asset.id",
      parentAssetId: "asset.assetsId",
      imageId: "asset.imageId",
      flowId: "asset.flowId",
      deletionState: "asset.deletionState",
      deletionOperationId: "asset.deletionOperationId",
      projectId: "project.id",
      workspaceId: "project.workspaceId",
      projectDeletionState: "project.deletionState",
    }))
    .first();
  if (!root) return null;
  const projectId = Number(root.projectId);
  const workspaceId = String(root.workspaceId || "");
  if (
    !Number.isSafeInteger(projectId)
    || projectId <= 0
    || !workspaceId
  ) {
    workflowError(
      "资产项目归属链无效",
      "DELETION_AUTHORITY_CHAIN_INVALID",
      404,
    );
  }

  const childRows = await maybeLock(client("o_assets")
    .where({ assetsId: assetId })
    .select(
      "id",
      "assetsId as parentAssetId",
      "imageId",
      "flowId",
      "projectId",
      "deletionState",
      "deletionOperationId",
    ))
    .orderBy("id", "asc");
  if (childRows.some((child) => Number(child.projectId) !== projectId)) {
    workflowError(
      "派生资产跨越项目归属",
      "DELETION_AUTHORITY_CHAIN_INVALID",
      409,
    );
  }
  const childIds = safeNumericIds(childRows, "id");
  if (childIds.length) {
    const grandchild = await maybeLock(client("o_assets")
      .whereIn("assetsId", childIds)
      .select("id", "assetsId", "projectId"))
      .first();
    if (grandchild) {
      workflowError(
        "资产派生层级超过安全删除模型",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
  }
  const assets: AssetDeletionSource["assets"] = [
    {
      id: assetId,
      parentAssetId: root.parentAssetId == null
        ? null
        : Number(root.parentAssetId),
      imageId: root.imageId == null ? null : Number(root.imageId),
      flowId: root.flowId == null ? null : Number(root.flowId),
      deletionState: String(root.deletionState || "active"),
      deletionOperationId: persistedString(root.deletionOperationId),
    },
    ...childRows.map((child) => ({
      id: Number(child.id),
      parentAssetId: child.parentAssetId == null
        ? null
        : Number(child.parentAssetId),
      imageId: child.imageId == null ? null : Number(child.imageId),
      flowId: child.flowId == null ? null : Number(child.flowId),
      deletionState: String(child.deletionState || "active"),
      deletionOperationId: persistedString(child.deletionOperationId),
    })),
  ];
  if (assets.some((asset) =>
    !Number.isSafeInteger(asset.id)
    || asset.id <= 0
    || !assetOperationOwnsAsset(asset, assetId))) {
    workflowError(
      "资产派生归属链无效",
      "DELETION_AUTHORITY_CHAIN_INVALID",
      409,
    );
  }
  const assetIds = assets.map((asset) => asset.id);
  const imageRows = await maybeLock(client("o_image")
    .whereIn("assetsId", assetIds)
    .select(
      "id",
      "assetsId",
      "filePath",
      "storageKey",
      "state",
      "deletionState",
      "deletionOperationId",
    ))
    .orderBy("id", "asc");
  const images: AssetImageSnapshot[] = imageRows.map((image) => ({
    id: Number(image.id),
    assetId: Number(image.assetsId),
    filePath: persistedString(image.filePath),
    storageKey: persistedString(image.storageKey),
    state: persistedString(image.state),
    deletionState: String(image.deletionState || "active"),
    deletionOperationId: persistedString(image.deletionOperationId),
  }));
  if (images.some((image) =>
    !Number.isSafeInteger(image.id)
    || image.id <= 0
    || !assetIds.includes(image.assetId))) {
    workflowError(
      "资产图片版本归属链无效",
      "DELETION_AUTHORITY_CHAIN_INVALID",
      409,
    );
  }
  const imageIds = images.map((image) => image.id);
  if (imageIds.length) {
    const foreignImageReference = await maybeLock(client("o_assets")
      .whereIn("imageId", imageIds)
      .whereNotIn("id", assetIds)
      .select("id", "projectId", "imageId"))
      .first();
    if (foreignImageReference) {
      workflowError(
        "资产图片仍被删除范围外的资产引用",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
  }

  const mediaCandidates = await maybeLock(client("o_media_asset")
    .where("metadata", "like", "%assetId%")
    .select(
      "id",
      "taskId",
      "workspaceId",
      "projectId",
      "source",
      "metadata",
      "localPath",
      "storageKey",
      "deletionState",
      "deletionOperationId",
    ))
    .limit(10_001);
  if (mediaCandidates.length > 10_000) {
    workflowError(
      "媒体关联候选超过安全扫描上限",
      "DELETION_MANIFEST_TOO_LARGE",
      409,
    );
  }
  const imageIdSet = new Set(imageIds);
  const assetIdSet = new Set(assetIds);
  const mediaAssets: AssetMediaSnapshot[] = [];
  for (const media of mediaCandidates) {
    const link = linkedNumericAsset(media.metadata);
    if (!link) continue;
    const linkedByAsset = assetIdSet.has(link.assetId);
    const linkedByVersion = link.assetVersionId !== null
      && imageIdSet.has(link.assetVersionId);
    if (!linkedByAsset && !linkedByVersion) continue;
    if (
      !linkedByAsset
      || (
        link.assetVersionId !== null
        && !linkedByVersion
      )
      || String(media.workspaceId || "") !== workspaceId
      || Number(media.projectId) !== projectId
    ) {
      workflowError(
        "媒体 metadata 跨越资产或工作区归属",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
    const snapshot: AssetMediaSnapshot = {
      id: String(media.id || ""),
      taskId: String(media.taskId || ""),
      workspaceId: String(media.workspaceId || ""),
      projectId: Number(media.projectId),
      source: String(media.source || ""),
      metadata: String(media.metadata || ""),
      localPath: persistedString(media.localPath),
      storageKey: persistedString(media.storageKey),
      deletionState: String(media.deletionState || "active"),
      deletionOperationId: persistedString(media.deletionOperationId),
    };
    if (!snapshot.id || !snapshot.taskId) {
      workflowError(
        "媒体持久化身份无效",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
    await assertMediaProducerTerminal(client, snapshot, {
      lock: options.lock,
      linkedNumericAsset: true,
    });
    mediaAssets.push(snapshot);
  }
  mediaAssets.sort((left, right) => left.id.localeCompare(right.id));

  const projectTasks = await maybeLock(client("o_tasks")
    .where({ projectId })
    .select("id", "state", "relatedObjects"))
    .limit(10_001);
  if (projectTasks.length > 10_000) {
    workflowError(
      "项目任务超过安全扫描上限",
      "DELETION_MANIFEST_TOO_LARGE",
      409,
    );
  }
  const producerTasks: AssetTaskSnapshot[] = [];
  for (const task of projectTasks) {
    const evidence = parseTaskProducerEvidence(task.relatedObjects);
    if (
      !assetIdSet.has(Number(evidence.assetId))
      && !imageIdSet.has(Number(evidence.imageId))
    ) continue;
    const state = String(task.state || "");
    if (!TERMINAL_PROJECT_TASK_STATES.has(state)) {
      workflowError(
        "资产仍有未终态生成任务",
        "DELETION_ASSET_ACTIVE_WORK",
        409,
      );
    }
    producerTasks.push({
      id: Number(task.id),
      state,
      relatedObjects: persistedString(task.relatedObjects),
    });
  }
  producerTasks.sort((left, right) => left.id - right.id);
  if (images.some((image) => ["进行中", "生成中"].includes(
    String(image.state || ""),
  ))) {
    workflowError(
      "资产仍有生成中的图片版本",
      "DELETION_ASSET_ACTIVE_WORK",
      409,
    );
  }

  const keys = new Set<string>();
  for (const image of images) {
    const key = safeOwnedStorageKey({
      storageKey: image.storageKey,
      legacyValue: image.filePath,
      field: `o_image(${image.id}).filePath`,
      allowLegacyRelative: true,
      projectId,
    });
    if (key) keys.add(key);
  }
  for (const media of mediaAssets) {
    const key = safeOwnedStorageKey({
      storageKey: media.storageKey,
      legacyValue: media.localPath,
      field: `o_media_asset(${media.id}).localPath`,
      allowLegacyRelative: true,
      projectId,
    });
    if (key) keys.add(key);
  }
  for (const task of producerTasks) {
    const evidence = parseTaskProducerEvidence(task.relatedObjects);
    if (!evidence.outputStorageKey) continue;
    const key = safeOwnedStorageKey({
      storageKey: evidence.outputStorageKey,
      legacyValue: null,
      field: `o_tasks(${task.id}).relatedObjects.outputStorageKey`,
      allowLegacyRelative: false,
      projectId,
    });
    if (key) keys.add(key);
  }

  const sourceEvidence = {
    rootAssetId: assetId,
    projectId,
    workspaceId,
    projectDeletionState: String(root.projectDeletionState || "active"),
    assets,
    images,
    mediaAssets,
    producerTasks,
    storageKeys: [...keys].sort(),
  };
  return {
    ...sourceEvidence,
    sourceHash: sha256(stableJson(sourceEvidence)),
  };
}

async function loadMediaDeletionSource(
  client: Knex | Knex.Transaction,
  mediaAssetId: string,
  options: { lock?: boolean } = {},
): Promise<MediaDeletionSource | null> {
  let query = client("o_media_asset as media")
    .innerJoin("o_project as project", "project.id", "media.projectId")
    .where("media.id", mediaAssetId)
    .select({
      id: "media.id",
      taskId: "media.taskId",
      workspaceId: "media.workspaceId",
      projectId: "media.projectId",
      source: "media.source",
      metadata: "media.metadata",
      localPath: "media.localPath",
      storageKey: "media.storageKey",
      deletionState: "media.deletionState",
      deletionOperationId: "media.deletionOperationId",
      projectWorkspaceId: "project.workspaceId",
      projectDeletionState: "project.deletionState",
    });
  if (options.lock) query = query.forUpdate();
  const row = await query.first();
  if (!row) return null;
  const media: AssetMediaSnapshot = {
    id: String(row.id || ""),
    taskId: String(row.taskId || ""),
    workspaceId: String(row.workspaceId || ""),
    projectId: Number(row.projectId),
    source: String(row.source || ""),
    metadata: String(row.metadata || ""),
    localPath: persistedString(row.localPath),
    storageKey: persistedString(row.storageKey),
    deletionState: String(row.deletionState || "active"),
    deletionOperationId: persistedString(row.deletionOperationId),
  };
  if (
    !media.id
    || !media.taskId
    || !media.workspaceId
    || !Number.isSafeInteger(media.projectId)
    || media.projectId <= 0
    || String(row.projectWorkspaceId || "") !== media.workspaceId
  ) {
    workflowError(
      "媒体项目/工作区归属链无效",
      "DELETION_AUTHORITY_CHAIN_INVALID",
      404,
    );
  }
  const link = linkedNumericAsset(media.metadata);
  await assertMediaProducerTerminal(client, media, {
    lock: options.lock,
    linkedNumericAsset: link !== null,
  });
  const storageKey = safeOwnedStorageKey({
    storageKey: media.storageKey,
    legacyValue: media.localPath,
    field: `o_media_asset(${media.id}).localPath`,
    allowLegacyRelative: true,
    projectId: media.projectId,
  });
  const sourceEvidence = {
    mediaAsset: media,
    projectDeletionState: String(row.projectDeletionState || "active"),
    storageKeys: storageKey ? [storageKey] : [],
  };
  return {
    ...sourceEvidence,
    sourceHash: sha256(stableJson(sourceEvidence)),
  };
}

async function assertAssetRelationsOwned(
  client: Knex | Knex.Transaction,
  source: AssetDeletionSource,
  lock = false,
): Promise<void> {
  const assetIds = source.assets.map((asset) => asset.id);
  const first = async (query: Knex.QueryBuilder) =>
    (lock ? query.forUpdate() : query).first();
  if (await client.schema.hasTable("o_scriptAssets")) {
    const foreign = await first(client("o_scriptAssets as relation")
      .leftJoin("o_script as script", "script.id", "relation.scriptId")
      .whereIn("relation.assetId", assetIds)
      .andWhere((where) => {
        where.whereNull("script.id").orWhereNot(
          "script.projectId",
          source.projectId,
        );
      })
      .select("relation.assetId", "relation.scriptId"));
    if (foreign) {
      workflowError(
        "资产被其他项目或悬挂剧本关系引用",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
  }
  if (await client.schema.hasTable("o_assets2Storyboard")) {
    const foreign = await first(client("o_assets2Storyboard as relation")
      .leftJoin(
        "o_storyboard as storyboard",
        "storyboard.id",
        "relation.storyboardId",
      )
      .whereIn("relation.assetId", assetIds)
      .andWhere((where) => {
        where.whereNull("storyboard.id").orWhereNot(
          "storyboard.projectId",
          source.projectId,
        );
      })
      .select("relation.assetId", "relation.storyboardId"));
    if (foreign) {
      workflowError(
        "资产被其他项目或悬挂分镜关系引用",
        "DELETION_AUTHORITY_CHAIN_INVALID",
        409,
      );
    }
  }
  if (await client.schema.hasTable("o_assetsRole2Audio")) {
    const relationRows = await (lock
      ? client("o_assetsRole2Audio")
        .whereIn("assetsRoleId", assetIds)
        .orWhereIn("assetsAudioId", assetIds)
        .select("*")
        .forUpdate()
      : client("o_assetsRole2Audio")
        .whereIn("assetsRoleId", assetIds)
        .orWhereIn("assetsAudioId", assetIds)
        .select("*"));
    const relatedIds = [...new Set(relationRows.flatMap((row) => [
      Number(row.assetsRoleId),
      Number(row.assetsAudioId),
    ]).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (relatedIds.length) {
      const related = await client("o_assets")
        .whereIn("id", relatedIds)
        .select("id", "projectId");
      if (
        related.length !== relatedIds.length
        || related.some((asset) =>
          Number(asset.projectId) !== source.projectId)
      ) {
        workflowError(
          "资产音频关系跨越项目或存在悬挂引用",
          "DELETION_AUTHORITY_CHAIN_INVALID",
          409,
        );
      }
    }
  }
}

async function assertAssetStorageKeysExclusive(
  client: Knex | Knex.Transaction,
  source: AssetDeletionSource | MediaDeletionSource,
  lock = false,
): Promise<void> {
  const isAssetSource = "assets" in source;
  const allowedImageIds = new Set(
    isAssetSource ? source.images.map((image) => image.id) : [],
  );
  const allowedMediaIds = new Set(
    isAssetSource
      ? source.mediaAssets.map((media) => media.id)
      : [source.mediaAsset.id],
  );
  const allowedTaskIds = new Set(
    isAssetSource
      ? source.producerTasks.map((task) => task.id)
      : [],
  );
  const projectId = isAssetSource
    ? source.projectId
    : source.mediaAsset.projectId;
  const firstRows = async (query: Knex.QueryBuilder) =>
    lock ? query.forUpdate() : query;
  for (const key of source.storageKeys) {
    const legacy = [key, `/${key}`];
    const images = await firstRows(client("o_image")
      .where((where) => {
        where.where("storageKey", key).orWhere((fallback) => {
          fallback.whereNull("storageKey").whereIn("filePath", legacy);
        });
      })
      .select("id", "assetsId"));
    if (images.some((image: { id: unknown }) =>
      !allowedImageIds.has(Number(image.id)))) {
      workflowError(
        "对象存储 key 被删除范围外的图片引用",
        "DELETION_STORAGE_KEY_SHARED",
        409,
      );
    }
    const media = await firstRows(client("o_media_asset")
      .where((where) => {
        where.where("storageKey", key).orWhere((fallback) => {
          fallback.whereNull("storageKey").whereIn("localPath", legacy);
        });
      })
      .select("id"));
    if (media.some((entry: { id: unknown }) =>
      !allowedMediaIds.has(String(entry.id)))) {
      workflowError(
        "对象存储 key 被删除范围外的媒体引用",
        "DELETION_STORAGE_KEY_SHARED",
        409,
      );
    }
    const directQueries = [
      client("o_project").where({ coverStorageKey: key }).select("id"),
      client("o_storyboard").where((where) => {
        where.where("storageKey", key).orWhere((fallback) => {
          fallback.whereNull("storageKey").whereIn("filePath", legacy);
        });
      }).select("id"),
      client("o_video").where((where) => {
        where.where("storageKey", key).orWhere((fallback) => {
          fallback.whereNull("storageKey").whereIn("filePath", legacy);
        });
      }).select("id"),
      client("o_workflow_graph").where({ coverStorageKey: key }).select("id"),
      client("o_canvas_asset").where((where) => {
        where.where("coverStorageKey", key).orWhere("saveStorageKey", key);
      }).select("id"),
    ];
    for (const query of directQueries) {
      if (await (lock ? query.forUpdate() : query).first()) {
        workflowError(
          "对象存储 key 被其他项目内容引用",
          "DELETION_STORAGE_KEY_SHARED",
          409,
        );
      }
    }
    if (await client.schema.hasTable("o_tasks")) {
      const candidateTasks = await (lock
        ? client("o_tasks")
          .where("relatedObjects", "like", `%${key}%`)
          .select("id", "projectId", "relatedObjects")
          .forUpdate()
        : client("o_tasks")
          .where("relatedObjects", "like", `%${key}%`)
          .select("id", "projectId", "relatedObjects"));
      for (const task of candidateTasks) {
        const evidence = parseTaskProducerEvidence(task.relatedObjects);
        if (evidence.outputStorageKey !== key) continue;
        if (
          Number(task.projectId) !== projectId
          || !allowedTaskIds.has(Number(task.id))
        ) {
          workflowError(
            "对象存储 key 被删除范围外的任务证据引用",
            "DELETION_STORAGE_KEY_SHARED",
            409,
          );
        }
      }
    }
  }
}

function targetToItem(
  target: CapturedStorageDeletionTarget,
  input: {
    resourceType: string;
    resourceId: string;
  },
): DeletionOutboxItem {
  return {
    ...target,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    maxRetries: 10,
  };
}

function captureKeyTargets(
  runtimeValue: ResolvedDeletionWorkflowRuntime,
  key: string,
): Promise<CapturedStorageDeletionTarget[]> {
  return runtimeValue.captureKeyTargets(key, {
    database: runtimeValue.database,
    ...(runtimeValue.signal ? { signal: runtimeValue.signal } : {}),
  });
}

function targetIdentity(
  target: Pick<
    DeletionOutboxItem,
    | "bucket"
    | "objectKey"
    | "deleteType"
    | "targetGeneration"
    | "conditionalToken"
  >,
): string {
  return stableJson([
    target.bucket,
    target.objectKey,
    target.deleteType,
    target.targetGeneration,
    target.conditionalToken,
  ]);
}

function uniqueTargets(
  targets: readonly CapturedStorageDeletionTarget[],
): CapturedStorageDeletionTarget[] {
  const unique = new Map<string, CapturedStorageDeletionTarget>();
  for (const target of targets) unique.set(targetIdentity(target), target);
  const result = [...unique.values()].sort((left, right) =>
    targetIdentity(left).localeCompare(targetIdentity(right)));
  if (result.length > 10_000) {
    workflowError(
      "项目删除 manifest 超过 10000 个精确 generation，必须分批治理",
      "DELETION_MANIFEST_TOO_LARGE",
      409,
    );
  }
  return result;
}

function emptyManifestHash(): string {
  return manifestHashForItems([]);
}

function manifestHashForItems(
  items: readonly Pick<
    DeletionOutboxItem,
    | "resourceType"
    | "resourceId"
    | "bucket"
    | "objectKey"
    | "deleteType"
    | "targetGeneration"
    | "conditionalToken"
  >[],
): string {
  const canonical = items
    .map((item) => ({
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      bucket: item.bucket,
      objectKey: item.objectKey,
      deleteType: item.deleteType,
      targetGeneration: item.targetGeneration,
      conditionalToken: item.conditionalToken,
    }))
    .sort((left, right) =>
      stableJson(left).localeCompare(stableJson(right)));
  return sha256(stableJson({
    version: "deletion-workflow-manifest.v1",
    items: canonical,
  }));
}

async function insertOperation(
  transaction: Knex.Transaction,
  input: {
    id: string;
    operationKey: string;
    kind: DeletionOperationKind;
    workspaceId: string;
    projectId: number;
    resourceId: string;
    status: "preparing" | "deleting";
    requestHash: string;
    manifestHash: string | null;
    expectedItemCount: number | null;
    requestedBy: number;
    now: number;
  },
): Promise<void> {
  await transaction(DELETION_OPERATION_TABLE).insert({
    id: input.id,
    operationKey: input.operationKey,
    kind: input.kind,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    resourceId: input.resourceId,
    status: input.status,
    requestHash: input.requestHash,
    manifestHash: input.manifestHash,
    manifestRevision: input.status === "deleting" ? 1 : 0,
    expectedItemCount: input.expectedItemCount,
    requestedBy: input.requestedBy,
    requestedAt: input.now,
    finalizedAt: null,
    auditSnapshot: null,
    auditSnapshotHash: null,
    errorCode: null,
    coordinatorLeaseOwner: null,
    coordinatorLeaseExpiresAt: null,
    coordinatorFence: 0,
    retryCount: 0,
    nextAttemptAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

type DeletionResourceAliasType = "asset" | "media_asset";

async function insertDeletionResourceAliases(
  transaction: Knex.Transaction,
  input: {
    operationId: string;
    workspaceId: string;
    projectId: number;
    createdAt: number;
    resources: Array<{
      resourceType: DeletionResourceAliasType;
      resourceId: string;
    }>;
  },
): Promise<void> {
  const resources = [...new Map(input.resources.map((resource) => [
    `${resource.resourceType}:${resource.resourceId}`,
    resource,
  ])).values()];
  if (!resources.length) return;
  await transaction(DELETION_RESOURCE_ALIAS_TABLE).insert(
    resources.map((resource) => ({
      ...resource,
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      createdAt: input.createdAt,
    })),
  );
}

export async function requestImageDeletion(
  input: RequestImageDeletionInput,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  const imageId = positiveId(input.imageId, "imageId");
  const userId = positiveId(input.userId, "userId");
  const authority = await loadImageAuthority(runtimeValue.database, imageId);
  if (!authority) {
    const replayRow = await runtimeValue.database(DELETION_OPERATION_TABLE)
      .where({ kind: "image", resourceId: String(imageId) })
      .orderBy("requestedAt", "desc")
      .first();
    if (replayRow) {
      const replay = mapOperation(replayRow);
      await requireAuthorization(runtimeValue, {
        projectId: replay.projectId,
        userId,
        role: input.role,
        authWorkspaceId: input.authWorkspaceId,
        permission: "project:delete",
        allowDeleting: true,
      });
      return replay;
    }
    workflowError(
      "图片不存在或无法证明项目归属",
      "DELETION_RESOURCE_NOT_FOUND",
      404,
    );
  }
  await requireAuthorization(runtimeValue, {
    projectId: authority.projectId,
    userId,
    role: input.role,
    authWorkspaceId: input.authWorkspaceId,
    permission: "project:delete",
  });
  if (
    authority.assetDeletionState !== "active"
    || authority.projectDeletionState !== "active"
  ) {
    workflowError(
      "资产或项目正在删除",
      "DELETION_PARENT_NOT_ACTIVE",
      409,
    );
  }
  if (
    authority.imageDeletionState === "deleting"
    && authority.imageDeletionOperationId
  ) {
    const replay = await readOperation(
      runtimeValue.database,
      authority.imageDeletionOperationId,
    );
    if (replay) return replay;
    workflowError(
      "图片删除 tombstone 缺少 operation",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  await assertNoActiveImageWork(runtimeValue.database, {
    imageId,
    projectId: authority.projectId,
  });
  const producerStorageKeys = await loadImageProducerStorageKeys(
    runtimeValue.database,
    {
      imageId,
      projectId: authority.projectId,
    },
  );
  await assertImageReferencesOwnedByProject(
    runtimeValue.database,
    imageId,
    authority.projectId,
  );

  const storageKey = safeOwnedStorageKey({
    storageKey: authority.storageKey,
    legacyValue: authority.filePath,
    field: "o_image.filePath",
    allowLegacyRelative: true,
    projectId: authority.projectId,
  });
  for (const keyToDelete of new Set([
    ...(storageKey ? [storageKey] : []),
    ...producerStorageKeys,
  ])) {
    await assertImageStorageKeyExclusive(runtimeValue.database, {
      imageId,
      projectId: authority.projectId,
      storageKey: keyToDelete,
    });
  }
  const capturedByKey = await mapWithConcurrency(
    [...new Set([
      ...(storageKey ? [storageKey] : []),
      ...producerStorageKeys,
    ])],
    8,
    (key) => captureKeyTargets(runtimeValue, key),
    runtimeValue.signal,
  );
  assertWorkflowNotAborted(runtimeValue);
  const targets = uniqueTargets(capturedByKey.flat());
  const items = targets.map((entry) =>
    targetToItem(entry, {
      resourceType: "image",
      resourceId: String(imageId),
    }));
  const id = runtimeValue.idFactory();
  const key = operationKey(
    "image",
    authority.workspaceId,
    String(imageId),
  );
  const hash = requestHash({
    kind: "image",
    workspaceId: authority.workspaceId,
    projectId: authority.projectId,
    resourceId: String(imageId),
  });
  const requestedAt = now(runtimeValue);
  return runtimeValue.database.transaction(async (transaction) => {
    const locked = await loadImageAuthority(transaction, imageId, true);
    if (!locked) {
      workflowError(
        "图片不存在或无法证明项目归属",
        "DELETION_RESOURCE_NOT_FOUND",
        404,
      );
    }
    await requireAuthorization(runtimeValue, {
      projectId: locked.projectId,
      userId,
      role: input.role,
      authWorkspaceId: input.authWorkspaceId,
      permission: "project:delete",
      database: transaction,
      lock: true,
    });
    const referenceAssetIds = await assertImageReferencesOwnedByProject(
      transaction,
      imageId,
      locked.projectId,
      true,
    );
    const lockedProducerStorageKeys =
      await loadImageProducerStorageKeys(transaction, {
        imageId,
        projectId: locked.projectId,
        lock: true,
      });
    await assertNoActiveImageWork(transaction, {
      imageId,
      projectId: locked.projectId,
      lock: true,
    });
    if (
      stableJson(lockedProducerStorageKeys)
      !== stableJson(producerStorageKeys)
    ) {
      workflowError(
        "图片生产者对象证据在 capture 后发生变化",
        "DELETION_SOURCE_CHANGED",
        409,
      );
    }
    for (const keyToDelete of new Set([
      ...(storageKey ? [storageKey] : []),
      ...lockedProducerStorageKeys,
    ])) {
      await assertImageStorageKeyExclusive(transaction, {
        imageId,
        projectId: locked.projectId,
        storageKey: keyToDelete,
        lock: true,
      });
    }
    if (
      locked.imageDeletionState === "deleting"
      && locked.imageDeletionOperationId
    ) {
      const replay = await readOperation(
        transaction,
        locked.imageDeletionOperationId,
      );
      if (replay) return replay;
      workflowError(
        "图片删除 tombstone 缺少 operation",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    if (
      locked.workspaceId !== authority.workspaceId
      || locked.projectId !== authority.projectId
      || locked.assetId !== authority.assetId
      || locked.assetImageId !== authority.assetImageId
      || locked.storageKey !== authority.storageKey
      || locked.filePath !== authority.filePath
      || locked.imageDeletionState !== "active"
      || locked.assetDeletionState !== "active"
      || locked.projectDeletionState !== "active"
    ) {
      workflowError(
        "图片归属或对象 key 在 capture 后发生变化",
        "DELETION_SOURCE_CHANGED",
        409,
      );
    }
    await insertOperation(transaction, {
      id,
      operationKey: key,
      kind: "image",
      workspaceId: authority.workspaceId,
      projectId: authority.projectId,
      resourceId: String(imageId),
      status: "deleting",
      requestHash: hash,
      manifestHash: manifestHashForItems(items),
      expectedItemCount: items.length,
      requestedBy: userId,
      now: requestedAt,
    });
    const manifestHash = manifestHashForItems(items);
    if (items.length) {
      await new DeletionOutboxRepository(
        runtimeValue.database,
        { clock: runtimeValue.clock },
      ).enqueueInTransaction(transaction, {
        operationId: id,
        items,
      });
    }
    const marked = await transaction("o_image")
      .where({
        id: imageId,
        assetsId: authority.assetId,
        deletionState: "active",
      })
      .whereNull("deletionOperationId")
      .update({
        deletionState: "deleting",
        deletionOperationId: id,
        deletionRequestedAt: requestedAt,
      });
    if (Number(marked) !== 1) {
      workflowError(
        "图片删除状态竞争",
        "DELETION_SOURCE_CHANGED",
        409,
      );
    }
    if (referenceAssetIds.length) {
      await transaction("o_assets")
        .whereIn("id", referenceAssetIds)
        .where({ imageId, deletionState: "active" })
        .update({ imageId: null });
    }
    const operation = await readOperation(transaction, id);
    if (!operation || operation.manifestHash !== manifestHash) {
      workflowError(
        "图片删除 operation 未持久化",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    return operation;
  });
}

async function replayMissingAssetOperation(
  runtimeValue: ResolvedDeletionWorkflowRuntime,
  input: DeletionActor & {
    resourceType: DeletionResourceAliasType;
    resourceId: string;
    legacyOperationResourceId: string;
  },
): Promise<DeletionOperationRecord | null> {
  const alias = await runtimeValue.database(DELETION_RESOURCE_ALIAS_TABLE)
    .where({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    })
    .first("operationId", "workspaceId", "projectId");
  let replay: DeletionOperationRecord | null = null;
  if (alias) {
    const projectId = persistedInteger(alias.projectId);
    if (projectId === null || projectId <= 0) return null;
    // The alias itself contains only the minimum authority needed to perform
    // the ownership check. Do not inspect or validate the durable operation
    // before authorization: otherwise a corrupt private alias/operation pair
    // could be distinguished from a genuinely missing resource.
    await requireAuthorization(runtimeValue, {
      projectId,
      userId: input.userId,
      role: input.role,
      authWorkspaceId: input.authWorkspaceId,
      permission: "project:delete",
      allowDeleting: true,
    });
    replay = await readOperation(
      runtimeValue.database,
      persistedString(alias.operationId) || "",
    );
    if (
      !replay
      || replay.kind !== "asset"
      || replay.workspaceId !== persistedString(alias.workspaceId)
      || replay.projectId !== persistedInteger(alias.projectId)
    ) {
      workflowError(
        "删除资源别名缺少有效 operation",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
  } else {
    const replayRow = await runtimeValue.database(DELETION_OPERATION_TABLE)
      .where({
        kind: "asset",
        resourceId: input.legacyOperationResourceId,
      })
      .orderBy("requestedAt", "desc")
      .first();
    if (!replayRow) return null;
    const projectId = persistedInteger(replayRow.projectId);
    if (projectId === null || projectId <= 0) return null;
    // Legacy rows predate the durable alias table. Apply the same minimum
    // authority-first rule before parsing the rest of their evidence.
    await requireAuthorization(runtimeValue, {
      projectId,
      userId: input.userId,
      role: input.role,
      authWorkspaceId: input.authWorkspaceId,
      permission: "project:delete",
      allowDeleting: true,
    });
    replay = mapOperation(replayRow);
  }
  return replay;
}

function replayFromAssetSource(
  source: AssetDeletionSource,
): string | null {
  const operationIds = [...new Set(source.assets
    .map((asset) => asset.deletionOperationId)
    .filter((value): value is string => value !== null))];
  if (
    operationIds.length === 1
    && source.assets.every((asset) =>
      ["deleting", "finalizing"].includes(asset.deletionState)
      && asset.deletionOperationId === operationIds[0])
    && source.images.every((image) =>
      ["deleting", "finalizing"].includes(image.deletionState)
      && image.deletionOperationId === operationIds[0])
    && source.mediaAssets.every((media) =>
      ["deleting", "finalizing"].includes(media.deletionState)
      && media.deletionOperationId === operationIds[0])
  ) return operationIds[0];
  return null;
}

export async function requestAssetDeletion(
  input: RequestAssetDeletionInput,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  const assetId = positiveId(input.assetId, "assetId");
  const userId = positiveId(input.userId, "userId");
  const expectedMediaAssetId = input.expectedMediaAssetId === undefined
    ? null
    : validatedMediaAssetId(input.expectedMediaAssetId);
  const authority = await loadAssetDeletionAuthority(
    runtimeValue.database,
    assetId,
  );
  if (!authority) {
    const replay = await replayMissingAssetOperation(runtimeValue, {
      resourceType: "asset",
      resourceId: String(assetId),
      legacyOperationResourceId: String(assetId),
      userId,
      role: input.role,
      authWorkspaceId: input.authWorkspaceId,
    });
    if (replay) return replay;
    workflowError(
      "资产不存在或无法证明项目归属",
      "DELETION_RESOURCE_NOT_FOUND",
      404,
    );
  }
  await requireAuthorization(runtimeValue, {
    projectId: authority.projectId,
    userId,
    role: input.role,
    authWorkspaceId: input.authWorkspaceId,
    permission: "project:delete",
  });
  const source = await loadAssetDeletionSource(
    runtimeValue.database,
    assetId,
  );
  if (
    !source
    || source.projectId !== authority.projectId
    || source.workspaceId !== authority.workspaceId
  ) {
    workflowError(
      "资产归属在授权后发生变化",
      "DELETION_SOURCE_CHANGED",
      409,
    );
  }
  const replayOperationId = replayFromAssetSource(source);
  if (replayOperationId) {
    const replay = await readOperation(
      runtimeValue.database,
      replayOperationId,
    );
    if (replay) return replay;
    workflowError(
      "资产删除 tombstone 缺少 operation",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  if (
    source.projectDeletionState !== "active"
    || source.assets.some((asset) => asset.deletionState !== "active")
    || source.images.some((image) => image.deletionState !== "active")
    || source.mediaAssets.some((media) => media.deletionState !== "active")
  ) {
    workflowError(
      "资产、派生版本或项目正在删除",
      "DELETION_PARENT_NOT_ACTIVE",
      409,
    );
  }
  if (
    expectedMediaAssetId
    && !source.mediaAssets.some((media) => media.id === expectedMediaAssetId)
  ) {
    workflowError(
      "媒体 metadata 未形成同一资产删除边界",
      "DELETION_AUTHORITY_CHAIN_INVALID",
      409,
    );
  }
  await assertAssetRelationsOwned(runtimeValue.database, source);
  await assertAssetStorageKeysExclusive(runtimeValue.database, source);

  const captured = await mapWithConcurrency(
    source.storageKeys,
    8,
    (key) => captureKeyTargets(runtimeValue, key),
    runtimeValue.signal,
  );
  assertWorkflowNotAborted(runtimeValue);
  const targets = uniqueTargets(captured.flat());
  const items = targets.map((entry) =>
    targetToItem(entry, {
      resourceType: "asset",
      resourceId: String(assetId),
    }));
  const operationId = runtimeValue.idFactory();
  const operationKeyValue = operationKey(
    "asset",
    source.workspaceId,
    String(assetId),
  );
  const hash = requestHash({
    kind: "asset",
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    resourceId: String(assetId),
  });
  const requestedAt = now(runtimeValue);
  const manifestHash = manifestHashForItems(items);

  return runtimeValue.database.transaction(async (transaction) => {
    await requireAuthorization(runtimeValue, {
      projectId: source.projectId,
      userId,
      role: input.role,
      authWorkspaceId: input.authWorkspaceId,
      permission: "project:delete",
      database: transaction,
      lock: true,
    });
    await lockRelayBillingForDeletion(transaction, {
      candidateTaskIds: source.mediaAssets.map((media) => media.taskId),
      workspaceId: source.workspaceId,
    });
    const locked = await loadAssetDeletionSource(
      transaction,
      assetId,
      { lock: true },
    );
    if (!locked) {
      workflowError(
        "资产不存在或无法证明项目归属",
        "DELETION_RESOURCE_NOT_FOUND",
        404,
      );
    }
    const lockedReplayId = replayFromAssetSource(locked);
    if (lockedReplayId) {
      const replay = await readOperation(transaction, lockedReplayId);
      if (replay) return replay;
      workflowError(
        "资产删除 tombstone 缺少 operation",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    if (
      locked.sourceHash !== source.sourceHash
      || locked.projectDeletionState !== "active"
      || locked.assets.some((asset) => asset.deletionState !== "active")
      || locked.images.some((image) => image.deletionState !== "active")
      || locked.mediaAssets.some((media) => media.deletionState !== "active")
      || (
        expectedMediaAssetId
        && !locked.mediaAssets.some((media) =>
          media.id === expectedMediaAssetId)
      )
    ) {
      workflowError(
        "资产归属或删除 manifest 在 capture 后发生变化",
        "DELETION_SOURCE_CHANGED",
        409,
      );
    }
    await assertAssetRelationsOwned(transaction, locked, true);
    await assertAssetStorageKeysExclusive(transaction, locked, true);

    await insertOperation(transaction, {
      id: operationId,
      operationKey: operationKeyValue,
      kind: "asset",
      workspaceId: source.workspaceId,
      projectId: source.projectId,
      resourceId: String(assetId),
      status: "deleting",
      requestHash: hash,
      manifestHash,
      expectedItemCount: items.length,
      requestedBy: userId,
      now: requestedAt,
    });
    await insertDeletionResourceAliases(transaction, {
      operationId,
      workspaceId: source.workspaceId,
      projectId: source.projectId,
      createdAt: requestedAt,
      resources: [
        ...locked.assets.map((asset) => ({
          resourceType: "asset" as const,
          resourceId: String(asset.id),
        })),
        ...locked.mediaAssets.map((media) => ({
          resourceType: "media_asset" as const,
          resourceId: media.id,
        })),
      ],
    });
    if (items.length) {
      await new DeletionOutboxRepository(
        runtimeValue.database,
        { clock: runtimeValue.clock },
      ).enqueueInTransaction(transaction, {
        operationId,
        items,
      });
    }
    const assetIds = locked.assets.map((asset) => asset.id);
    const markedAssets = await transaction("o_assets")
      .whereIn("id", assetIds)
      .where({ deletionState: "active" })
      .whereNull("deletionOperationId")
      .whereNull("deletionFinalizeFence")
      .update({
        deletionState: "deleting",
        deletionOperationId: operationId,
        deletionRequestedAt: requestedAt,
      });
    if (Number(markedAssets) !== assetIds.length) {
      workflowError(
        "资产 tombstone 写入发生竞争",
        "DELETION_SOURCE_CHANGED",
        409,
      );
    }
    const imageIds = locked.images.map((image) => image.id);
    if (imageIds.length) {
      const markedImages = await transaction("o_image")
        .whereIn("id", imageIds)
        .where({ deletionState: "active" })
        .whereNull("deletionOperationId")
        .whereNull("deletionFinalizeFence")
        .update({
          deletionState: "deleting",
          deletionOperationId: operationId,
          deletionRequestedAt: requestedAt,
        });
      if (Number(markedImages) !== imageIds.length) {
        workflowError(
          "资产图片 tombstone 写入发生竞争",
          "DELETION_SOURCE_CHANGED",
          409,
        );
      }
    }
    const mediaIds = locked.mediaAssets.map((media) => media.id);
    if (mediaIds.length) {
      const markedMedia = await transaction("o_media_asset")
        .whereIn("id", mediaIds)
        .where({ deletionState: "active" })
        .whereNull("deletionOperationId")
        .whereNull("deletionFinalizeFence")
        .update({
          deletionState: "deleting",
          deletionOperationId: operationId,
          deletionRequestedAt: requestedAt,
        });
      if (Number(markedMedia) !== mediaIds.length) {
        workflowError(
          "关联媒体 tombstone 写入发生竞争",
          "DELETION_SOURCE_CHANGED",
          409,
        );
      }
    }
    const operation = await readOperation(transaction, operationId);
    if (!operation || operation.manifestHash !== manifestHash) {
      workflowError(
        "资产删除 operation 未持久化",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    return operation;
  });
}

export async function requestMediaAssetDeletion(
  input: RequestMediaAssetDeletionInput,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  const mediaAssetId = validatedMediaAssetId(input.mediaAssetId);
  const userId = positiveId(input.userId, "userId");
  const authority = await loadMediaDeletionAuthority(
    runtimeValue.database,
    mediaAssetId,
  );
  if (!authority) {
    const replay = await replayMissingAssetOperation(runtimeValue, {
      resourceType: "media_asset",
      resourceId: mediaAssetId,
      legacyOperationResourceId: mediaResourceId(mediaAssetId),
      userId,
      role: input.role,
      authWorkspaceId: input.authWorkspaceId,
    });
    if (replay) return replay;
    workflowError(
      "媒体不存在或无法证明项目归属",
      "DELETION_RESOURCE_NOT_FOUND",
      404,
    );
  }
  await requireAuthorization(runtimeValue, {
    projectId: authority.projectId,
    userId,
    role: input.role,
    authWorkspaceId: input.authWorkspaceId,
    permission: "project:delete",
  });
  const source = await loadMediaDeletionSource(
    runtimeValue.database,
    mediaAssetId,
  );
  if (
    !source
    || source.mediaAsset.projectId !== authority.projectId
    || source.mediaAsset.workspaceId !== authority.workspaceId
  ) {
    workflowError(
      "媒体归属在授权后发生变化",
      "DELETION_SOURCE_CHANGED",
      409,
    );
  }
  if (
    ["deleting", "finalizing"].includes(
      source.mediaAsset.deletionState,
    )
    && source.mediaAsset.deletionOperationId
  ) {
    const replay = await readOperation(
      runtimeValue.database,
      source.mediaAsset.deletionOperationId,
    );
    if (replay) return replay;
    workflowError(
      "媒体删除 tombstone 缺少 operation",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  const numericLink = linkedNumericAsset(source.mediaAsset.metadata);
  if (numericLink) {
    return requestAssetDeletion({
      assetId: numericLink.assetId,
      expectedMediaAssetId: mediaAssetId,
      userId,
      role: input.role,
      authWorkspaceId: input.authWorkspaceId,
    }, runtimeValue);
  }
  if (
    source.projectDeletionState !== "active"
    || source.mediaAsset.deletionState !== "active"
  ) {
    workflowError(
      "媒体或项目正在删除",
      "DELETION_PARENT_NOT_ACTIVE",
      409,
    );
  }
  await assertAssetStorageKeysExclusive(runtimeValue.database, source);
  const captured = await mapWithConcurrency(
    source.storageKeys,
    8,
    (key) => captureKeyTargets(runtimeValue, key),
    runtimeValue.signal,
  );
  assertWorkflowNotAborted(runtimeValue);
  const targets = uniqueTargets(captured.flat());
  const resourceId = mediaResourceId(mediaAssetId);
  const items = targets.map((entry) =>
    targetToItem(entry, {
      resourceType: "media_asset",
      resourceId: mediaAssetId,
    }));
  const operationId = runtimeValue.idFactory();
  const operationKeyValue = operationKey(
    "asset",
    source.mediaAsset.workspaceId,
    resourceId,
  );
  const hash = requestHash({
    kind: "asset",
    workspaceId: source.mediaAsset.workspaceId,
    projectId: source.mediaAsset.projectId,
    resourceId,
  });
  const requestedAt = now(runtimeValue);
  const manifestHash = manifestHashForItems(items);
  return runtimeValue.database.transaction(async (transaction) => {
    await requireAuthorization(runtimeValue, {
      projectId: source.mediaAsset.projectId,
      userId,
      role: input.role,
      authWorkspaceId: input.authWorkspaceId,
      permission: "project:delete",
      database: transaction,
      lock: true,
    });
    await lockRelayBillingForDeletion(transaction, {
      candidateTaskIds: [source.mediaAsset.taskId],
      workspaceId: source.mediaAsset.workspaceId,
    });
    const locked = await loadMediaDeletionSource(
      transaction,
      mediaAssetId,
      { lock: true },
    );
    if (!locked) {
      workflowError(
        "媒体不存在或无法证明项目归属",
        "DELETION_RESOURCE_NOT_FOUND",
        404,
      );
    }
    if (
      locked.sourceHash !== source.sourceHash
      || locked.projectDeletionState !== "active"
      || locked.mediaAsset.deletionState !== "active"
      || linkedNumericAsset(locked.mediaAsset.metadata) !== null
    ) {
      workflowError(
        "媒体归属或删除 manifest 在 capture 后发生变化",
        "DELETION_SOURCE_CHANGED",
        409,
      );
    }
    await assertAssetStorageKeysExclusive(transaction, locked, true);
    await insertOperation(transaction, {
      id: operationId,
      operationKey: operationKeyValue,
      kind: "asset",
      workspaceId: source.mediaAsset.workspaceId,
      projectId: source.mediaAsset.projectId,
      resourceId,
      status: "deleting",
      requestHash: hash,
      manifestHash,
      expectedItemCount: items.length,
      requestedBy: userId,
      now: requestedAt,
    });
    await insertDeletionResourceAliases(transaction, {
      operationId,
      workspaceId: source.mediaAsset.workspaceId,
      projectId: source.mediaAsset.projectId,
      createdAt: requestedAt,
      resources: [{
        resourceType: "media_asset",
        resourceId: mediaAssetId,
      }],
    });
    if (items.length) {
      await new DeletionOutboxRepository(
        runtimeValue.database,
        { clock: runtimeValue.clock },
      ).enqueueInTransaction(transaction, {
        operationId,
        items,
      });
    }
    const marked = await transaction("o_media_asset")
      .where({
        id: mediaAssetId,
        deletionState: "active",
      })
      .whereNull("deletionOperationId")
      .whereNull("deletionFinalizeFence")
      .update({
        deletionState: "deleting",
        deletionOperationId: operationId,
        deletionRequestedAt: requestedAt,
      });
    if (Number(marked) !== 1) {
      workflowError(
        "媒体 tombstone 写入发生竞争",
        "DELETION_SOURCE_CHANGED",
        409,
      );
    }
    const operation = await readOperation(transaction, operationId);
    if (!operation || operation.manifestHash !== manifestHash) {
      workflowError(
        "媒体删除 operation 未持久化",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    return operation;
  });
}

const UNRESOLVED_OBJECT_WRITE_INTENT_STATUSES = [
  "prepared",
  "stored",
  "compensation_pending",
  "compensating",
  "dead",
] as const;

function safeNumericIds(rows: Array<Record<string, unknown>>, field: string): number[] {
  return [...new Set(rows
    .map((row) => Number(row[field]))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

async function assertProjectStoragePrefixInvariant(
  transaction: Knex.Transaction,
  input: {
    projectId: number;
    workspaceId: string;
  },
): Promise<void> {
  const prefix = `${input.projectId}/`;
  const legacyPrefix = `/${prefix}`;
  const hasTable = async (tableName: string) =>
    transaction.schema.hasTable(tableName);
  const invalidAuthoritative = async (
    query: Knex.QueryBuilder,
    column: string,
  ): Promise<boolean> => Boolean(await query
    .whereNotNull(column)
    .andWhere((invalid) => {
      invalid
        .whereRaw("trim(??) <> ??", [column, column])
        .orWhereRaw("?? NOT LIKE ?", [column, `${prefix}%`])
        .orWhereRaw("?? LIKE ?", [column, "%\\%"])
        .orWhereRaw("?? LIKE ?", [column, "%?%"])
        .orWhereRaw("?? LIKE ?", [column, "%#%"])
        .orWhereRaw("?? LIKE ?", [column, "%//%"])
        .orWhereRaw("?? LIKE ?", [column, "%/./%"])
        .orWhereRaw("?? LIKE ?", [column, "%/../%"])
        .orWhereRaw("?? LIKE ?", [column, "%/."])
        .orWhereRaw("?? LIKE ?", [column, "%/.."]);
    })
    .select(column)
    .first());
  const invalidLegacyWithoutAuthoritative = async (
    query: Knex.QueryBuilder,
    authoritativeColumn: string,
    legacyColumn: string,
    allowProjectRelative: boolean,
  ): Promise<boolean> => Boolean(await query
    .whereNull(authoritativeColumn)
    .whereNotNull(legacyColumn)
    .whereRaw("trim(??) <> ''", [legacyColumn])
    .whereRaw("lower(??) NOT LIKE 'http://%'", [legacyColumn])
    .whereRaw("lower(??) NOT LIKE 'https://%'", [legacyColumn])
    .modify((candidate) => {
      if (!allowProjectRelative) return;
      candidate
        .whereRaw("?? NOT LIKE ?", [legacyColumn, `${prefix}%`])
        .whereRaw("?? NOT LIKE ?", [legacyColumn, `${legacyPrefix}%`]);
    })
    .select(legacyColumn)
    .first());
  const directScopes = [
    {
      table: "o_project",
      alias: "scoped",
      scope: { "scoped.id": input.projectId },
      keys: [["coverStorageKey", "coverImageUrl", false]] as const,
    },
    {
      table: "o_storyboard",
      alias: "scoped",
      scope: { "scoped.projectId": input.projectId },
      keys: [["storageKey", "filePath", true]] as const,
    },
    {
      table: "o_video",
      alias: "scoped",
      scope: { "scoped.projectId": input.projectId },
      keys: [["storageKey", "filePath", true]] as const,
    },
    {
      table: "o_workflow_graph",
      alias: "scoped",
      scope: { "scoped.projectId": input.projectId },
      keys: [["coverStorageKey", "coverImageUrl", false]] as const,
    },
    {
      table: "o_canvas_asset",
      alias: "scoped",
      scope: { "scoped.projectId": input.projectId },
      keys: [
        ["coverStorageKey", "coverUrl", false],
        ["saveStorageKey", "saveLocation", false],
      ] as const,
    },
    {
      table: "o_media_asset",
      alias: "scoped",
      scope: {
        "scoped.projectId": input.projectId,
        "scoped.workspaceId": input.workspaceId,
      },
      keys: [["storageKey", "localPath", true]] as const,
    },
  ] as const;
  for (const target of directScopes) {
    if (!(await hasTable(target.table))) continue;
    for (const [authoritative, legacy, allowProjectRelative] of target.keys) {
      if (
        !(await transaction.schema.hasColumn(target.table, authoritative))
        || !(await transaction.schema.hasColumn(target.table, legacy))
      ) {
        continue;
      }
      const authoritativeColumn = `${target.alias}.${authoritative}`;
      const legacyColumn = `${target.alias}.${legacy}`;
      const scoped = () =>
        transaction({ [target.alias]: target.table }).where(target.scope);
      if (
        await invalidAuthoritative(scoped(), authoritativeColumn)
        || await invalidLegacyWithoutAuthoritative(
          scoped(),
          authoritativeColumn,
          legacyColumn,
          allowProjectRelative,
        )
      ) {
        workflowError(
          "项目存在 prefix 外或非权威对象存储引用，必须在删除前治理",
          "DELETION_AUTHORITATIVE_STORAGE_KEY_REQUIRED",
          409,
        );
      }
    }
  }
  if (await hasTable("o_image")) {
    const scopedImage = () => transaction("o_image as image")
      .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
      .where("asset.projectId", input.projectId);
    if (
      await invalidAuthoritative(scopedImage(), "image.storageKey")
      || await invalidLegacyWithoutAuthoritative(
        scopedImage(),
        "image.storageKey",
        "image.filePath",
        true,
      )
    ) {
      workflowError(
        "项目图片存在 prefix 外或非权威对象存储引用，必须在删除前治理",
        "DELETION_AUTHORITATIVE_STORAGE_KEY_REQUIRED",
        409,
      );
    }
  }
  if (
    await hasTable(OBJECT_WRITE_INTENT_TABLE)
    && await invalidAuthoritative(
      transaction(OBJECT_WRITE_INTENT_TABLE).where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      }),
      "objectKey",
    )
  ) {
    workflowError(
      "项目对象写入证据超出权威 prefix，必须在删除前治理",
      "DELETION_MANIFEST_SOURCE_INVALID",
      409,
    );
  }
  if (await hasTable("o_tasks")) {
    let taskCursor = 0;
    while (true) {
      const rows = await transaction("o_tasks")
        .where({ projectId: input.projectId })
        .andWhere("id", ">", taskCursor)
        .orderBy("id", "asc")
        .select("id", "relatedObjects")
        .limit(500);
      if (!rows.length) break;
      for (const row of rows) {
        const id = Number(row.id);
        if (
          !Number.isSafeInteger(id)
          || id <= taskCursor
        ) {
          workflowError(
            "项目任务对象证据游标无效",
            "DELETION_MANIFEST_SOURCE_INVALID",
            409,
          );
        }
        taskCursor = id;
        const evidence = parseTaskProducerEvidence(
          row.relatedObjects,
        );
        if (!evidence.outputStorageKey) continue;
        safeOwnedStorageKey({
          storageKey: evidence.outputStorageKey,
          legacyValue: null,
          field:
            `o_tasks(${String(row.id)}).relatedObjects.outputStorageKey`,
          allowLegacyRelative: false,
          projectId: input.projectId,
        });
      }
      if (rows.length < 500) break;
    }
  }
}

async function assertNoActiveProjectWork(
  transaction: Knex.Transaction,
  input: {
    projectId: number;
    workspaceId: string;
  },
): Promise<void> {
  const has = async (tableName: string) =>
    transaction.schema.hasTable(tableName);
  const activeAgentRun = await has("o_agent_run")
    ? await transaction("o_agent_run")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .whereNotIn("status", ["succeeded", "failed", "cancelled"])
      .select("id", "status")
      .first()
    : null;
  if (activeAgentRun) {
    workflowError(
      "项目仍有未终态 Agent run，删除请求必须等待其停止",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
  const activeAgentStep = await has("o_agent_step")
    ? await transaction("o_agent_step")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .whereNotIn("status", ["succeeded", "failed", "cancelled", "uncertain"])
      .select("id", "status")
      .first()
    : null;
  if (activeAgentStep) {
    workflowError(
      "项目仍有未终态 Agent step，删除请求必须等待其停止",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
  const effectiveApproval = await has("o_agent_approval")
    ? await transaction("o_agent_approval")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .whereIn("status", ["pending", "approved"])
      .select("id", "status")
      .first()
    : null;
  if (effectiveApproval) {
    workflowError(
      "项目仍有待决或有效审批，删除请求必须等待其撤销或终结",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
  const activeDelegation = await has("o_agent_delegation")
    ? await transaction("o_agent_delegation")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .andWhere((query) => {
        query
          .where("status", "active")
          .orWhereIn("taskStatus", ["queued", "running"]);
      })
      .select("id", "status", "taskStatus")
      .first()
    : null;
  if (activeDelegation) {
    workflowError(
      "项目仍有有效委派，删除请求必须等待其撤销或终结",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
  const activeTask = await has("o_tasks")
    ? await transaction("o_tasks")
      .where({ projectId: input.projectId })
      .whereIn("state", ["进行中", "生成中"])
      .select("id", "state")
      .first()
    : null;
  if (activeTask) {
    workflowError(
      "项目仍有未终态生成任务，删除请求必须等待其停止",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
  const unresolvedObjectWrite = await has(OBJECT_WRITE_INTENT_TABLE)
    ? await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .whereIn("status", [...UNRESOLVED_OBJECT_WRITE_INTENT_STATUSES])
      .select("id", "status")
      .forUpdate()
      .first()
    : null;
  if (unresolvedObjectWrite) {
    const status = String(unresolvedObjectWrite.status || "");
    workflowError(
      status === "dead"
        ? "项目存在已阻断的对象写入补偿，必须人工修复后才能删除"
        : "项目仍有未终态对象写入或补偿，删除请求必须等待其完成",
      status === "dead"
        ? "DELETION_PROJECT_OBJECT_WRITE_DEAD"
        : "DELETION_PROJECT_OBJECT_WRITE_UNRESOLVED",
      409,
    );
  }
  const activeChildDeletion = await has("o_assets")
    ? await transaction("o_assets as asset")
      .leftJoin("o_image as image", "image.assetsId", "asset.id")
      .where("asset.projectId", input.projectId)
      .andWhere((query) => {
        query
          .whereNot("asset.deletionState", "active")
          .orWhereNot("image.deletionState", "active");
      })
      .select(
        "asset.id as assetId",
        "asset.deletionState as assetDeletionState",
        "image.id as imageId",
        "image.deletionState as imageDeletionState",
      )
      .first()
    : null;
  if (activeChildDeletion) {
    workflowError(
      "项目仍有子资产删除 operation 未终结",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
  const activeMediaDeletion = await has("o_media_asset")
    ? await transaction("o_media_asset")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .whereNot("deletionState", "active")
      .select("id", "deletionState", "deletionOperationId")
      .first()
    : null;
  if (activeMediaDeletion) {
    workflowError(
      "项目仍有媒体删除 operation 未终结",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }

  const relayTaskTableExists = await has("o_relay_task");
  const activeRelayTask = relayTaskTableExists
    ? await transaction("o_relay_task")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .whereIn("status", ["queued", "running", "enhancing"])
      .select("id", "status")
      .first()
    : null;
  if (activeRelayTask) {
    workflowError(
      "项目仍有未终态 Relay task，删除请求必须等待其停止",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
  const projectRelayTasks = relayTaskTableExists
    ? await transaction("o_relay_task")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .orderBy("id", "asc")
      .select("id", "providerPayload")
      .forUpdate()
    : [];
  await assertRelayBillingResolved(transaction, {
    tasks: projectRelayTasks.map((task) => ({
      id: String(task.id),
      providerPayload: task.providerPayload,
    })),
    workspaceId: input.workspaceId,
    lock: true,
    projectDeletion: true,
  });
  const callbackTableExists = relayTaskTableExists
    && await has("o_relay_callback_delivery");
  const activeCallback = callbackTableExists
    ? await transaction("o_relay_callback_delivery as callback")
      .innerJoin(
        "o_relay_task as relay",
        "relay.id",
        "callback.taskId",
      )
      .where({
        "relay.projectId": input.projectId,
        "relay.workspaceId": input.workspaceId,
      })
      .whereIn("callback.status", ["pending", "leased"])
      .select("callback.id", "callback.status")
      .first()
    : null;
  if (activeCallback) {
    workflowError(
      "项目仍有未终态 Relay callback，删除请求必须等待其完成",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
  const enhanceTaskTableExists = await has("o_user_video_enhance_task");
  const unresolvedEnhanceBilling = enhanceTaskTableExists
    ? await transaction("o_user_video_enhance_task")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .whereNotIn("billingReconciliationState", [
        "not_billed",
        "settled",
        "released",
      ])
      .select("id", "status", "billingReconciliationState")
      .first()
    : null;
  if (unresolvedEnhanceBilling) {
    workflowError(
      "项目仍有未核清的视频增强账务，删除请求必须等待结算或释放确认",
      "DELETION_PROJECT_BILLING_RECONCILIATION_PENDING",
      409,
    );
  }
  const activeEnhanceTask = enhanceTaskTableExists
    ? await transaction("o_user_video_enhance_task")
      .where({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      })
      .whereIn("status", ["created", "enhancing", "reconciling"])
      .select("id", "status")
      .first()
    : null;
  if (activeEnhanceTask) {
    workflowError(
      "项目仍有未终态视频增强任务，删除请求必须等待其停止",
      "DELETION_PROJECT_ACTIVE_WORK",
      409,
    );
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        signal?.throwIfAborted();
        const index = cursor;
        cursor += 1;
        result[index] = await mapper(values[index]);
        signal?.throwIfAborted();
      }
    },
  );
  await Promise.all(workers);
  return result;
}

export async function prepareProjectDeletionOperation(
  operationId: string,
  runtimeInput: DeletionWorkflowRuntime = {},
  claim?: DeletionOperationLease,
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  if (!claim) {
    workflowError(
      "项目删除 preparation 必须持有 operation 租约",
      "DELETION_OPERATION_LEASE_LOST",
      409,
    );
  }
  const initialOperation = await readOperation(
    runtimeValue.database,
    operationId,
  );
  if (!initialOperation) {
    workflowError(
      "项目删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  if (initialOperation.status !== "preparing") return initialOperation;
  if (initialOperation.kind !== "project") {
    workflowError(
      "项目删除 operation 类型无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  const project = await runtimeValue.database("o_project")
    .where({
      id: initialOperation.projectId,
      workspaceId: initialOperation.workspaceId,
      deletionState: "deleting",
      deletionOperationId: initialOperation.id,
    })
    .select("id")
    .first();
  if (!project) {
    workflowError(
      "项目删除 tombstone 与 operation 不一致",
      "DELETION_PROJECT_TOMBSTONE_INVALID",
      409,
    );
  }
  const existingCheckpoint = await runtimeValue.database.transaction(
    (transaction) => readDeletionChunkCheckpointInTransaction(
      transaction,
      operationId,
    ),
  );
  if (
    existingCheckpoint
    && existingCheckpoint.phase !== "storage_scan"
  ) {
    workflowError(
      "项目删除 preparation checkpoint 阶段无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  const inputMarker: DeletionStorageMarker | null =
    existingCheckpoint?.keyMarker
    && existingCheckpoint.versionIdMarker
      ? {
          keyMarker: existingCheckpoint.keyMarker,
          versionIdMarker: existingCheckpoint.versionIdMarker,
        }
      : null;
  const prefix = `${initialOperation.projectId}/`;
  const protectedStorageKeys = await protectedAccountAssetStorageKeysForProject({
    database: runtimeValue.database,
    workspaceId: initialOperation.workspaceId,
    projectId: initialOperation.projectId,
  });
  const protectedStorageKeySet = new Set(protectedStorageKeys);
  const page = await runtimeValue.capturePrefixTargetPage(
    prefix,
    {
      maximumObjects: 500,
      keyMarker: inputMarker?.keyMarker,
      versionIdMarker: inputMarker?.versionIdMarker,
      timeoutMs: 15_000,
    },
    { signal: runtimeValue.signal },
  );
  assertWorkflowNotAborted(runtimeValue);
  const outputMarker: DeletionStorageMarker | null = page.truncated
    ? {
        keyMarker: nonEmptyText(
          page.keyMarker,
          "storage key marker",
          4_096,
        ),
        versionIdMarker: nonEmptyText(
          page.versionIdMarker,
          "storage version marker",
          4_096,
        ),
      }
    : null;
  if (
    page.objectPrefix !== prefix
    || page.targets.length > 500
    || (page.truncated
      && (!page.keyMarker || !page.versionIdMarker))
    || (!page.truncated
      && (page.keyMarker !== null || page.versionIdMarker !== null))
  ) {
    workflowError(
      "项目删除对象存储分页证据无效",
      "DELETION_MANIFEST_SOURCE_CHANGED",
      502,
    );
  }
  const deletionTargets = page.targets.filter(
    (target) => !protectedStorageKeySet.has(String(target.objectKey)),
  );
  const items = deletionTargets.map((target) =>
    targetToItem(target, {
      resourceType: "project",
      resourceId: String(initialOperation.projectId),
    }));
  const repository = new DeletionOutboxRepository(
    runtimeValue.database,
    { clock: runtimeValue.clock },
  );
  const contentHash = repository.manifestChunkContentHash({
    operationId,
    items,
  });
  await beforeClaimedOperationCommit(runtimeValue, claim);
  return runtimeValue.database.transaction(async (transaction) => {
    const operationRow = await transaction(DELETION_OPERATION_TABLE)
      .where({ id: operationId })
      .forUpdate()
      .first();
    if (!operationRow) {
      workflowError(
        "项目删除 operation 不存在",
        "DELETION_OPERATION_NOT_FOUND",
        404,
      );
    }
    const operation = mapOperation(operationRow);
    if (operation.status !== "preparing") return operation;
    const preparedAt = now(runtimeValue);
    assertActiveClaim(operation, claim, preparedAt);
    const lockedProject = await transaction("o_project")
      .where({
        id: operation.projectId,
        workspaceId: operation.workspaceId,
        deletionState: "deleting",
        deletionOperationId: operation.id,
      })
      .forUpdate()
      .select("id")
      .first();
    if (!lockedProject) {
      workflowError(
        "项目删除 tombstone 与 operation 不一致",
        "DELETION_PROJECT_TOMBSTONE_INVALID",
        409,
      );
    }
    const protectedStorageKeysAfterLock = await protectedAccountAssetStorageKeysForProject({
      database: transaction,
      workspaceId: operation.workspaceId,
      projectId: operation.projectId,
    });
    if (JSON.stringify(protectedStorageKeysAfterLock) !== JSON.stringify(protectedStorageKeys)) {
      workflowError(
        "项目删除期间账号资产的存储保护集合发生变化",
        "DELETION_MANIFEST_SOURCE_CHANGED",
        409,
      );
    }
    let checkpoint = await readDeletionChunkCheckpointInTransaction(
      transaction,
      operationId,
    );
    const lease = {
      operationId,
      owner: claim.workerId,
      fence: claim.coordinatorFence,
      now: preparedAt,
    };
    if (!checkpoint) {
      checkpoint = (
        await initializeDeletionChunkCheckpointInTransaction(
          transaction,
          {
            lease,
            phase: "storage_scan",
            epoch: 0,
            providerId: page.providerId,
            providerFingerprint: page.providerFingerprint,
            bucket: page.bucket,
            objectPrefix: prefix,
            marker: inputMarker,
          },
        )
      ).checkpoint;
    }
    if (
      checkpoint.phase !== "storage_scan"
      || checkpoint.providerId !== page.providerId
      || checkpoint.providerFingerprint !== page.providerFingerprint
      || checkpoint.bucket !== page.bucket
      || checkpoint.objectPrefix !== prefix
      || checkpoint.keyMarker !== inputMarker?.keyMarker
        && !(checkpoint.keyMarker === null && inputMarker === null)
      || checkpoint.versionIdMarker !== inputMarker?.versionIdMarker
        && !(checkpoint.versionIdMarker === null && inputMarker === null)
    ) {
      workflowError(
        "项目删除对象存储游标或 Provider 在分页期间发生变化",
        "DELETION_MANIFEST_SOURCE_CHANGED",
        409,
      );
    }
    const appended = await appendDeletionManifestChunkInTransaction(
      transaction,
      {
        lease,
        phase: "storage_scan",
        epoch: checkpoint.epoch,
        ordinal: checkpoint.nextManifestChunkOrdinal,
        inputCursorHash: checkpoint.cursorHash,
        inputMarker,
        outputMarker,
        itemCount: items.length,
        contentHash,
      },
      async (savepoint, context) => {
        const before = await repository
          .summarizeByOperationInTransaction(
            savepoint,
            operationId,
          );
        if (before.total !== context.currentCheckpoint.manifestItemCount) {
          workflowError(
            "项目删除 outbox 与当前分块 checkpoint 数量不一致",
            "DELETION_OUTBOX_CARDINALITY_MISMATCH",
            500,
          );
        }
        if (items.length) {
          const existing = await repository
            .findManifestChunkItemsInTransaction(savepoint, {
              operationId,
              items,
            });
          if (existing.length) {
            workflowError(
              "项目删除对象存储分页返回了重复 generation",
              "DELETION_OUTBOX_PAYLOAD_CONFLICT",
              500,
            );
          }
          await repository.appendManifestChunkInTransaction(
            savepoint,
            {
              operationId,
              items,
              contentHash: context.chunk.contentHash,
            },
          );
        }
        const after = await repository
          .summarizeByOperationInTransaction(
            savepoint,
            operationId,
          );
        if (after.total !== context.nextCheckpoint.manifestItemCount) {
          workflowError(
            "项目删除 outbox 与下一分块 checkpoint 数量不一致",
            "DELETION_OUTBOX_CARDINALITY_MISMATCH",
            500,
          );
        }
      },
    );
    checkpoint = appended.checkpoint;
    if (page.truncated) {
      await updateClaimedOperation(
        transaction,
        operation,
        claim,
        {
          errorCode: null,
          coordinatorLeaseOwner: null,
          coordinatorLeaseExpiresAt: null,
          nextAttemptAt: preparedAt,
          updatedAt: preparedAt,
        },
      );
    } else {
      checkpoint = await advanceDeletionChunkCheckpointInTransaction(
        transaction,
        {
          lease,
          expectedPhase: "storage_scan",
          expectedEpoch: checkpoint.epoch,
          expectedCursorHash: checkpoint.cursorHash,
          nextPhase: "dispatch",
        },
      );
      await updateClaimedOperation(
        transaction,
        operation,
        claim,
        {
          status: "deleting",
          manifestHash: checkpoint.manifestChainHash,
          manifestRevision: 1,
          expectedItemCount: checkpoint.manifestItemCount,
          errorCode: null,
          coordinatorLeaseOwner: null,
          coordinatorLeaseExpiresAt: null,
          nextAttemptAt: preparedAt,
          updatedAt: preparedAt,
        },
      );
    }
    const result = await readOperation(transaction, operationId);
    if (!result) {
      workflowError(
        "项目删除 operation 未持久化",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    return result;
  });
}

function validateOutboxManifest(
  operation: DeletionOperationRecord,
  records: readonly DeletionOutboxRecord[],
): void {
  if (
    operation.expectedItemCount === null
    || records.length !== operation.expectedItemCount
  ) {
    workflowError(
      "删除 operation 的 outbox 数量与 manifest 不一致",
      "DELETION_OUTBOX_CARDINALITY_MISMATCH",
      500,
    );
  }
  if (
    operation.manifestHash === null
    || manifestHashForItems(records) !== operation.manifestHash
  ) {
    workflowError(
      "删除 operation 的 outbox 内容与 manifestHash 不一致",
      "DELETION_OUTBOX_MANIFEST_MISMATCH",
      500,
    );
  }
}

interface DispatchManifestAuthorization {
  manifestRevision: number;
  manifestHash: string;
  expectedItemCount: number;
  outboxIds: ReadonlySet<string>;
  lastUsedAt: number;
}

const DISPATCH_MANIFEST_AUTHORIZATION_MAX_OPERATIONS = 64;
const DISPATCH_MANIFEST_AUTHORIZATION_TTL_MS = 5 * 60_000;
const dispatchManifestAuthorizations = new WeakMap<
  object,
  Map<string, DispatchManifestAuthorization>
>();

function dispatchManifestAuthorizationMap(
  database: Knex,
): Map<string, DispatchManifestAuthorization> {
  const key = database as unknown as object;
  const existing = dispatchManifestAuthorizations.get(key);
  if (existing) return existing;
  const created = new Map<string, DispatchManifestAuthorization>();
  dispatchManifestAuthorizations.set(key, created);
  return created;
}

function pruneDispatchManifestAuthorizations(
  authorizations: Map<string, DispatchManifestAuthorization>,
  currentTime: number,
): void {
  for (const [operationId, authorization] of authorizations) {
    if (
      currentTime - authorization.lastUsedAt
      > DISPATCH_MANIFEST_AUTHORIZATION_TTL_MS
    ) {
      authorizations.delete(operationId);
    }
  }
  while (
    authorizations.size
    >= DISPATCH_MANIFEST_AUTHORIZATION_MAX_OPERATIONS
  ) {
    const leastRecentlyUsed = authorizations.keys().next().value;
    if (typeof leastRecentlyUsed !== "string") break;
    authorizations.delete(leastRecentlyUsed);
  }
}

function authorizationMatchesOperation(
  authorization: DispatchManifestAuthorization | undefined,
  operation: DeletionOperationRecord,
): authorization is DispatchManifestAuthorization {
  return Boolean(
    authorization
    && operation.manifestHash !== null
    && operation.expectedItemCount !== null
    && authorization.manifestRevision === operation.manifestRevision
    && authorization.manifestHash === operation.manifestHash
    && authorization.expectedItemCount === operation.expectedItemCount,
  );
}

export async function assertDeletionOutboxManifestBeforeProviderCall(
  input: {
    operationId: string;
    outboxId: string;
    phase?: "dispatch" | "reconcile";
  },
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<void> {
  const runtimeValue = runtime(runtimeInput);
  const authorizations = dispatchManifestAuthorizationMap(
    runtimeValue.database,
  );
  const authorizationTime = Date.now();
  pruneDispatchManifestAuthorizations(authorizations, authorizationTime);
  await runtimeValue.database.transaction(async (transaction) => {
    let operationQuery = transaction(DELETION_OPERATION_TABLE)
      .where({ id: input.operationId });
    if (isPostgres(runtimeValue.database)) {
      operationQuery = operationQuery.forShare();
    }
    const operationRow = await operationQuery.first();
    if (!operationRow) {
      workflowError(
        "删除 outbox 缺少所属 operation",
        "DELETION_OPERATION_NOT_FOUND",
        404,
      );
    }
    const operation = mapOperation(operationRow);
    const phase = input.phase ?? "dispatch";
    if (
      operation.status !== "deleting"
      && !(phase === "reconcile" && operation.status === "blocked")
    ) {
      authorizations.delete(operation.id);
      workflowError(
        "删除 outbox 所属 operation 不允许调用存储服务",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    const claimedRow = await transaction(DELETION_OUTBOX_TABLE)
      .where({
        id: input.outboxId,
        operationId: operation.id,
      })
      .select("id")
      .first();
    if (!claimedRow) {
      workflowError(
        "删除 outbox claim 不属于 operation",
        "DELETION_OUTBOX_MANIFEST_MISMATCH",
        500,
      );
    }
    if (operation.kind === "project") {
      const checkpoint = await transaction(DELETION_CHECKPOINT_TABLE)
        .where({ operationId: operation.id })
        .select(
          "phase",
          "manifestChainHash",
          "manifestItemCount",
        )
        .first();
      const manifestItemCount = Number(checkpoint?.manifestItemCount);
      if (
        !checkpoint
        || !["dispatch", "verify", "db_finalize"].includes(
          String(checkpoint.phase || ""),
        )
        || operation.manifestRevision < 1
        || operation.manifestHash === null
        || operation.manifestHash !== String(
          checkpoint.manifestChainHash || "",
        )
        || operation.expectedItemCount === null
        || !Number.isSafeInteger(manifestItemCount)
        || manifestItemCount < 0
        || operation.expectedItemCount !== manifestItemCount
      ) {
        workflowError(
          "项目删除 outbox 缺少完整的分块 manifest 授权",
          "DELETION_OUTBOX_MANIFEST_MISMATCH",
          500,
        );
      }
      const summary = await new DeletionOutboxRepository(
        runtimeValue.database,
        { clock: runtimeValue.clock },
      ).summarizeByOperationInTransaction(
        transaction,
        operation.id,
      );
      if (summary.total !== manifestItemCount) {
        workflowError(
          "项目删除 outbox 数量与分块 manifest 不一致",
          "DELETION_OUTBOX_CARDINALITY_MISMATCH",
          500,
        );
      }
      return;
    }
    const cached = authorizations.get(operation.id);
    if (authorizationMatchesOperation(cached, operation)) {
      cached.lastUsedAt = authorizationTime;
      authorizations.delete(operation.id);
      authorizations.set(operation.id, cached);
      if (!cached.outboxIds.has(input.outboxId)) {
        workflowError(
          "删除 outbox claim 不属于已授权 manifest",
          "DELETION_OUTBOX_MANIFEST_MISMATCH",
          500,
        );
      }
      return;
    }
    authorizations.delete(operation.id);
    const records = await new DeletionOutboxRepository(
      runtimeValue.database,
      { clock: runtimeValue.clock },
    ).listByOperationInTransaction(transaction, operation.id);
    validateOutboxManifest(operation, records);
    if (!records.some((record) => record.id === input.outboxId)) {
      workflowError(
        "删除 outbox claim 不属于 operation manifest",
        "DELETION_OUTBOX_MANIFEST_MISMATCH",
        500,
      );
    }
    authorizations.set(operation.id, {
      manifestRevision: operation.manifestRevision,
      manifestHash: operation.manifestHash!,
      expectedItemCount: operation.expectedItemCount!,
      outboxIds: new Set(records.map((record) => record.id)),
      lastUsedAt: authorizationTime,
    });
  });
}

function projectDeletionFinalizerPosition(
  checkpoint: DeletionChunkCheckpoint,
): ProjectDeletionFinalizerPosition {
  if (
    checkpoint.phase !== "db_finalize"
    || checkpoint.auditTableName === null
    || checkpoint.auditCursorJson === null
    || checkpoint.auditCursorHash === null
  ) {
    workflowError(
      "项目删除 DB checkpoint 缺少审计游标",
      "DELETION_PROJECT_AUDIT_INVALID",
      500,
    );
  }
  const step = PROJECT_DELETION_FINALIZER_STEPS[
    checkpoint.auditTableOrdinal
  ];
  if (!step || step.name !== checkpoint.auditTableName) {
    workflowError(
      "项目删除 DB checkpoint 与稳定步骤目录不匹配",
      "DELETION_PROJECT_AUDIT_INVALID",
      500,
    );
  }
  let cursor: unknown;
  try {
    cursor = JSON.parse(checkpoint.auditCursorJson);
  } catch {
    workflowError(
      "项目删除 DB checkpoint 审计游标无法解析",
      "DELETION_PROJECT_AUDIT_INVALID",
      500,
    );
  }
  if (
    !cursor
    || typeof cursor !== "object"
    || Array.isArray(cursor)
    || Object.keys(cursor).length !== 1
    || !Object.prototype.hasOwnProperty.call(cursor, "batch")
    || !Number.isSafeInteger(
      (cursor as { batch?: unknown }).batch,
    )
    || Number((cursor as { batch: number }).batch) < 0
  ) {
    workflowError(
      "项目删除 DB checkpoint 审计游标无效",
      "DELETION_PROJECT_AUDIT_INVALID",
      500,
    );
  }
  return {
    tableOrdinal: step.ordinal,
    tableName: step.name,
    cursor: {
      batch: Number((cursor as { batch: number }).batch),
    },
  };
}

function projectAuditSnapshot(
  operation: DeletionOperationRecord,
  checkpoint: DeletionChunkCheckpoint,
  finalizedAt: number,
): { auditSnapshot: string; auditSnapshotHash: string } {
  if (
    checkpoint.phase !== "completed"
    || checkpoint.operationId !== operation.id
    || checkpoint.manifestChainHash !== operation.manifestHash
    || checkpoint.manifestItemCount !== operation.expectedItemCount
    || checkpoint.auditTableOrdinal
      !== PROJECT_DELETION_FINALIZER_STEPS.length - 1
    || checkpoint.auditTableName
      !== PROJECT_DELETION_FINALIZER_STEPS.at(-1)?.name
    || !/^[a-f0-9]{64}$/u.test(checkpoint.auditChainHash)
    || !Number.isSafeInteger(checkpoint.auditRowCount)
    || checkpoint.auditRowCount < 0
  ) {
    workflowError(
      "项目删除审计 checkpoint 无效",
      "DELETION_PROJECT_AUDIT_INVALID",
      500,
    );
  }
  const auditSnapshot = stableJson({
    version: "project-deletion-completion.v2",
    operation: {
      id: operation.id,
      workspaceId: operation.workspaceId,
      projectId: operation.projectId,
      requestedBy: operation.requestedBy,
      requestedAt: operation.requestedAt,
      finalizedAt,
      requestHash: operation.requestHash,
      manifestHash: operation.manifestHash,
      manifestRevision: operation.manifestRevision,
      expectedItemCount: operation.expectedItemCount,
    },
    storageManifest: {
      providerId: checkpoint.providerId,
      providerFingerprint: checkpoint.providerFingerprint,
      bucket: checkpoint.bucket,
      objectPrefix: checkpoint.objectPrefix,
      epoch: checkpoint.epoch,
      chunkCount: checkpoint.nextManifestChunkOrdinal,
      itemCount: checkpoint.manifestItemCount,
      chainHash: checkpoint.manifestChainHash,
    },
    databaseFinalizer: {
      catalogVersion: "project-deletion-finalizer.v2",
      finalTableOrdinal: checkpoint.auditTableOrdinal,
      finalTableName: checkpoint.auditTableName,
      finalCursorHash: checkpoint.auditCursorHash,
      finalCheckpointHash: checkpoint.cursorHash,
      finalTableChunkCount: checkpoint.nextAuditChunkOrdinal,
      rowCount: checkpoint.auditRowCount,
      chainHash: checkpoint.auditChainHash,
      retainedEvidenceTables:
        PROJECT_DELETION_FINALIZER_RETAINED_TABLES,
    },
  });
  if (
    Buffer.byteLength(auditSnapshot, "utf8") < 2
    || Buffer.byteLength(auditSnapshot, "utf8") > 262_144
  ) {
    workflowError(
      "项目删除审计快照大小无效",
      "DELETION_PROJECT_AUDIT_INVALID",
      500,
    );
  }
  return {
    auditSnapshot,
    auditSnapshotHash: sha256(auditSnapshot),
  };
}

function outboxHasIncomplete(
  records: readonly DeletionOutboxRecord[],
): boolean {
  return records.some((record) => record.status !== "completed");
}

function outboxHasDead(
  records: readonly DeletionOutboxRecord[],
): boolean {
  return records.some((record) => record.status === "dead");
}

async function updateClaimedOperation(
  transaction: Knex.Transaction,
  operation: DeletionOperationRecord,
  claim: DeletionOperationLease | undefined,
  patch: Record<string, unknown>,
): Promise<void> {
  let query = transaction(DELETION_OPERATION_TABLE).where({
    id: operation.id,
    status: operation.status,
  });
  query = claim
    ? claimWhere(query, claim)
    : query.whereNull("coordinatorLeaseOwner");
  const affected = await query.update(patch);
  if (Number(affected) !== 1) {
    workflowError(
      "删除 operation 状态或租约发生竞争",
      "DELETION_OPERATION_LEASE_LOST",
      409,
    );
  }
}

async function blockDeletionOperationInTransaction(
  transaction: Knex.Transaction,
  operation: DeletionOperationRecord,
  errorCode: string,
  blockedAt: number,
  claim?: DeletionOperationLease,
): Promise<DeletionOperationRecord> {
  await updateClaimedOperation(transaction, operation, claim, {
    status: "blocked",
    errorCode: errorCode.slice(0, 255),
    coordinatorLeaseOwner: null,
    coordinatorLeaseExpiresAt: null,
    nextAttemptAt: blockedAt,
    updatedAt: blockedAt,
  });
  const blocked = await readOperation(transaction, operation.id);
  if (!blocked) {
    workflowError(
      "删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  return blocked;
}

async function releaseClaimInTransaction(
  transaction: Knex.Transaction,
  operation: DeletionOperationRecord,
  releasedAt: number,
  claim?: DeletionOperationLease,
): Promise<DeletionOperationRecord> {
  await updateClaimedOperation(transaction, operation, claim, {
    coordinatorLeaseOwner: null,
    coordinatorLeaseExpiresAt: null,
    nextAttemptAt: releasedAt + 1_000,
    updatedAt: releasedAt,
  });
  const released = await readOperation(transaction, operation.id);
  if (!released) {
    workflowError(
      "删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  return released;
}

function operationLeaseFromClaim(
  claim: ClaimedDeletionOperation,
): DeletionOperationLease {
  return {
    operationId: claim.id,
    workerId: claim.coordinatorLeaseOwner,
    coordinatorFence: claim.coordinatorFence,
  };
}

export async function recordDeletionOperationFailure(
  claim: ClaimedDeletionOperation,
  error: unknown,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  const failedAt = now(runtimeValue);
  const codeCandidate = error && typeof error === "object"
    ? String((error as { code?: unknown }).code || "")
    : "";
  const code = /^[A-Z0-9_]{1,255}$/u.test(codeCandidate)
    ? codeCandidate
    : "DELETION_WORKFLOW_UNAVAILABLE";
  const fatalCodes = new Set([
    "DELETION_AUTHORITATIVE_STORAGE_KEY_REQUIRED",
    "DELETION_AUTHORITATIVE_STORAGE_KEY_INVALID",
    "DELETION_AUTHORITY_CHAIN_INVALID",
    "DELETION_MANIFEST_TOO_LARGE",
    "DELETION_MANIFEST_SOURCE_INVALID",
    "DELETION_PROJECT_AUDIT_INVALID",
    "DELETION_PROJECT_AUDIT_TOO_LARGE",
    "DELETION_PROJECT_TOMBSTONE_INVALID",
    "DELETION_ASSET_TOMBSTONE_INVALID",
    "DELETION_STORAGE_KEY_SHARED",
    "DELETION_OPERATION_ROW_INVALID",
    "DELETION_OUTBOX_CARDINALITY_MISMATCH",
    "DELETION_OUTBOX_MANIFEST_MISMATCH",
    "DELETION_OUTBOX_PAYLOAD_CONFLICT",
    "DELETION_OUTBOX_ROW_INVALID",
    "DELETION_STORAGE_RECEIPT_INCONSISTENT",
    "DELETION_OPERATION_KIND_UNSUPPORTED",
    "OBJECT_STORAGE_LIST_LIMIT_EXCEEDED",
  ]);
  return runtimeValue.database.transaction(async (transaction) => {
    const row = await transaction(DELETION_OPERATION_TABLE)
      .where({ id: claim.id })
      .forUpdate()
      .first();
    if (!row) {
      workflowError(
        "删除 operation 不存在",
        "DELETION_OPERATION_NOT_FOUND",
        404,
      );
    }
    const operation = mapOperation(row);
    assertActiveClaim(
      operation,
      operationLeaseFromClaim(claim),
      failedAt,
    );
    if (fatalCodes.has(code)) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        code,
        failedAt,
        operationLeaseFromClaim(claim),
      );
    }
    const retryCount = operation.retryCount + 1;
    if (!Number.isSafeInteger(retryCount)) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_OPERATION_RETRY_EXHAUSTED",
        failedAt,
        operationLeaseFromClaim(claim),
      );
    }
    const retryDelay = Math.min(
      6 * 60 * 60_000,
      1_000 * 2 ** Math.min(20, Math.max(0, retryCount - 1)),
    );
    await updateClaimedOperation(
      transaction,
      operation,
      operationLeaseFromClaim(claim),
      {
        errorCode: code,
        retryCount,
        coordinatorLeaseOwner: null,
        coordinatorLeaseExpiresAt: null,
        nextAttemptAt: failedAt + retryDelay,
        updatedAt: failedAt,
      },
    );
    const failed = await readOperation(transaction, operation.id);
    if (!failed) {
      workflowError(
        "删除 operation 不存在",
        "DELETION_OPERATION_NOT_FOUND",
        404,
      );
    }
    return failed;
  });
}

async function finalizeImageDeletion(
  operationId: string,
  runtimeValue: ResolvedDeletionWorkflowRuntime,
  claim?: DeletionOperationLease,
): Promise<DeletionOperationRecord> {
  const initialOperation = await readOperation(
    runtimeValue.database,
    operationId,
  );
  if (!initialOperation) {
    workflowError(
      "图片删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  if (initialOperation.status !== "deleting") return initialOperation;
  const repository = new DeletionOutboxRepository(
    runtimeValue.database,
    { clock: runtimeValue.clock },
  );
  const initialRecords = await repository.listByOperation(operationId);
  validateOutboxManifest(initialOperation, initialRecords);
  if (outboxHasDead(initialRecords)) {
    await beforeClaimedOperationCommit(runtimeValue, claim);
    return runtimeValue.database.transaction(async (transaction) => {
      const row = await transaction(DELETION_OPERATION_TABLE)
        .where({ id: operationId })
        .forUpdate()
        .first();
      if (!row) {
        workflowError(
          "图片删除 operation 不存在",
          "DELETION_OPERATION_NOT_FOUND",
          404,
        );
      }
      const operation = mapOperation(row);
      if (operation.status !== "deleting") return operation;
      const blockedAt = now(runtimeValue);
      if (claim) assertActiveClaim(operation, claim, blockedAt);
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_OUTBOX_DEAD",
        blockedAt,
        claim,
      );
    });
  }
  if (outboxHasIncomplete(initialRecords)) {
    if (!claim) return initialOperation;
    await beforeClaimedOperationCommit(runtimeValue, claim);
    return releaseDeletionOperationClaim(claim, 1_000, runtimeValue);
  }

  const imageId = Number(initialOperation.resourceId);
  if (!Number.isSafeInteger(imageId) || imageId <= 0) {
    workflowError(
      "图片删除 operation resourceId 无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  const authority = await loadImageAuthority(runtimeValue.database, imageId);
  if (
    !authority
    || authority.projectId !== initialOperation.projectId
    || authority.workspaceId !== initialOperation.workspaceId
    || authority.imageDeletionState !== "deleting"
    || authority.imageDeletionOperationId !== initialOperation.id
  ) {
    workflowError(
      "图片删除 tombstone 与 operation 不一致",
      "DELETION_IMAGE_TOMBSTONE_INVALID",
      409,
    );
  }
  const storageKey = safeOwnedStorageKey({
    storageKey: authority.storageKey,
    legacyValue: authority.filePath,
    field: "o_image.filePath",
    allowLegacyRelative: true,
    projectId: authority.projectId,
  });
  const producerStorageKeys = await loadImageProducerStorageKeys(
    runtimeValue.database,
    {
      imageId,
      projectId: authority.projectId,
    },
  );
  const residualTargets = uniqueTargets(
    (await mapWithConcurrency(
      [...new Set([
        ...(storageKey ? [storageKey] : []),
        ...producerStorageKeys,
      ])],
      8,
      (key) => captureKeyTargets(runtimeValue, key),
      runtimeValue.signal,
    )).flat(),
  );
  assertWorkflowNotAborted(runtimeValue);
  await beforeClaimedOperationCommit(runtimeValue, claim);
  return runtimeValue.database.transaction(async (transaction) => {
    const row = await transaction(DELETION_OPERATION_TABLE)
      .where({ id: operationId })
      .forUpdate()
      .first();
    if (!row) {
      workflowError(
        "图片删除 operation 不存在",
        "DELETION_OPERATION_NOT_FOUND",
        404,
      );
    }
    const operation = mapOperation(row);
    if (operation.status !== "deleting") return operation;
    const finalizedAt = now(runtimeValue);
    if (!claim) {
      workflowError(
        "图片物理终结必须持有 operation 租约",
        "DELETION_OPERATION_LEASE_LOST",
        409,
      );
    }
    assertActiveClaim(operation, claim, finalizedAt);

    const project = await transaction("o_project")
      .where({
        id: operation.projectId,
        workspaceId: operation.workspaceId,
      })
      .forUpdate()
      .first();
    if (!project || String(project.deletionState || "active") !== "active") {
      return releaseClaimInTransaction(
        transaction,
        operation,
        finalizedAt,
        claim,
      );
    }
    const locked = await loadImageAuthority(transaction, imageId, true);
    if (
      !locked
      || locked.projectId !== authority.projectId
      || locked.workspaceId !== authority.workspaceId
      || locked.assetId !== authority.assetId
      || locked.storageKey !== authority.storageKey
      || locked.filePath !== authority.filePath
      || locked.imageDeletionState !== "deleting"
      || locked.imageDeletionOperationId !== operation.id
      || locked.projectDeletionState !== "active"
    ) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_IMAGE_TOMBSTONE_INVALID",
        finalizedAt,
        claim,
      );
    }

    let records = await repository.listByOperationInTransaction(
      transaction,
      operation.id,
    );
    validateOutboxManifest(operation, records);
    if (outboxHasDead(records)) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_OUTBOX_DEAD",
        finalizedAt,
        claim,
      );
    }
    if (outboxHasIncomplete(records)) {
      return releaseClaimInTransaction(
        transaction,
        operation,
        finalizedAt,
        claim,
      );
    }
    const existingByTarget = new Map<string, DeletionOutboxRecord>();
    for (const record of records) {
      const identity = targetIdentity(record);
      if (existingByTarget.has(identity)) {
        return blockDeletionOperationInTransaction(
          transaction,
          operation,
          "DELETION_OUTBOX_PAYLOAD_CONFLICT",
          finalizedAt,
          claim,
        );
      }
      existingByTarget.set(identity, record);
    }
    const repeatedCompletedTarget = residualTargets.find((target) =>
      existingByTarget.has(targetIdentity(target)));
    if (repeatedCompletedTarget) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_STORAGE_RECEIPT_INCONSISTENT",
        finalizedAt,
        claim,
      );
    }
    const missingTargets = residualTargets.filter(
      (target) => !existingByTarget.has(targetIdentity(target)),
    );
    if (missingTargets.length) {
      await repository.appendInTransaction(transaction, {
        operationId: operation.id,
        items: missingTargets.map((target) =>
          targetToItem(target, {
            resourceType: "image",
            resourceId: String(imageId),
          })),
      });
      records = await repository.listByOperationInTransaction(
        transaction,
        operation.id,
      );
      await updateClaimedOperation(transaction, operation, claim, {
        manifestHash: manifestHashForItems(records),
        manifestRevision: operation.manifestRevision + 1,
        expectedItemCount: records.length,
        errorCode: null,
        coordinatorLeaseOwner: null,
        coordinatorLeaseExpiresAt: null,
        nextAttemptAt: finalizedAt,
        updatedAt: finalizedAt,
      });
      const expanded = await readOperation(transaction, operation.id);
      if (!expanded) {
        workflowError(
          "图片删除 operation 未持久化",
          "DELETION_OPERATION_ROW_INVALID",
          500,
        );
      }
      return expanded;
    }

    const enteredFinalizer = await transaction("o_image")
      .where({
        id: imageId,
        deletionState: "deleting",
        deletionOperationId: operation.id,
      })
      .whereNull("deletionFinalizeFence")
      .update({
        deletionState: "finalizing",
        deletionFinalizeFence: operation.coordinatorFence,
      });
    if (Number(enteredFinalizer) !== 1) {
      workflowError(
        "图片 tombstone 无法进入受控终结态",
        "DELETION_IMAGE_TOMBSTONE_INVALID",
        409,
      );
    }
    const referenceAssetIds = await assertImageReferencesOwnedByProject(
      transaction,
      imageId,
      operation.projectId,
      true,
    );
    if (referenceAssetIds.length) {
      await transaction("o_assets")
        .whereIn("id", referenceAssetIds)
        .where({ imageId })
        .update({ imageId: null });
    }
    const deleted = await transaction("o_image")
      .where({
        id: imageId,
        deletionState: "finalizing",
        deletionOperationId: operation.id,
        deletionFinalizeFence: operation.coordinatorFence,
      })
      .delete();
    if (Number(deleted) !== 1) {
      workflowError(
        "图片 tombstone 在终结期间发生变化",
        "DELETION_IMAGE_TOMBSTONE_INVALID",
        409,
      );
    }
    await updateClaimedOperation(transaction, operation, claim, {
      status: "completed",
      errorCode: null,
      coordinatorLeaseOwner: null,
      coordinatorLeaseExpiresAt: null,
      finalizedAt,
      nextAttemptAt: finalizedAt,
      updatedAt: finalizedAt,
    });
    const completed = await readOperation(transaction, operation.id);
    if (!completed) {
      workflowError(
        "图片删除 operation 未持久化",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    return completed;
  });
}

async function finalizeAssetDeletion(
  operationId: string,
  runtimeValue: ResolvedDeletionWorkflowRuntime,
  claim?: DeletionOperationLease,
): Promise<DeletionOperationRecord> {
  const initialOperation = await readOperation(
    runtimeValue.database,
    operationId,
  );
  if (!initialOperation) {
    workflowError(
      "资产删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  if (initialOperation.status !== "deleting") return initialOperation;
  const repository = new DeletionOutboxRepository(
    runtimeValue.database,
    { clock: runtimeValue.clock },
  );
  const initialRecords = await repository.listByOperation(operationId);
  validateOutboxManifest(initialOperation, initialRecords);
  if (outboxHasDead(initialRecords)) {
    await beforeClaimedOperationCommit(runtimeValue, claim);
    return runtimeValue.database.transaction(async (transaction) => {
      const row = await transaction(DELETION_OPERATION_TABLE)
        .where({ id: operationId })
        .forUpdate()
        .first();
      if (!row) {
        workflowError(
          "资产删除 operation 不存在",
          "DELETION_OPERATION_NOT_FOUND",
          404,
        );
      }
      const operation = mapOperation(row);
      if (operation.status !== "deleting") return operation;
      const blockedAt = now(runtimeValue);
      if (claim) assertActiveClaim(operation, claim, blockedAt);
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_OUTBOX_DEAD",
        blockedAt,
        claim,
      );
    });
  }
  if (outboxHasIncomplete(initialRecords)) {
    if (!claim) return initialOperation;
    await beforeClaimedOperationCommit(runtimeValue, claim);
    return releaseDeletionOperationClaim(claim, 1_000, runtimeValue);
  }

  const mediaAssetId = mediaIdFromResourceId(initialOperation.resourceId);
  const numericAssetId = mediaAssetId === null
    ? Number(initialOperation.resourceId)
    : null;
  if (
    mediaAssetId === null
    && (
      !Number.isSafeInteger(numericAssetId)
      || Number(numericAssetId) <= 0
    )
  ) {
    workflowError(
      "资产删除 operation resourceId 无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  const initialSource = mediaAssetId === null
    ? await loadAssetDeletionSource(
      runtimeValue.database,
      Number(numericAssetId),
    )
    : await loadMediaDeletionSource(
      runtimeValue.database,
      mediaAssetId,
    );
  if (!initialSource) {
    workflowError(
      "资产删除 tombstone 与 operation 不一致",
      "DELETION_ASSET_TOMBSTONE_INVALID",
      409,
    );
  }
  if (
    (
      "assets" in initialSource
      && (
        initialSource.projectId !== initialOperation.projectId
        || initialSource.workspaceId !== initialOperation.workspaceId
        || initialSource.assets.some((asset) =>
          asset.deletionState !== "deleting"
          || asset.deletionOperationId !== initialOperation.id)
        || initialSource.images.some((image) =>
          image.deletionState !== "deleting"
          || image.deletionOperationId !== initialOperation.id)
        || initialSource.mediaAssets.some((media) =>
          media.deletionState !== "deleting"
          || media.deletionOperationId !== initialOperation.id)
      )
    )
    || (
      !("assets" in initialSource)
      && (
        initialSource.mediaAsset.projectId !== initialOperation.projectId
        || initialSource.mediaAsset.workspaceId
          !== initialOperation.workspaceId
        || initialSource.mediaAsset.deletionState !== "deleting"
        || initialSource.mediaAsset.deletionOperationId
          !== initialOperation.id
      )
    )
  ) {
    workflowError(
      "资产删除 tombstone 与 operation 不一致",
      "DELETION_ASSET_TOMBSTONE_INVALID",
      409,
    );
  }
  await assertAssetStorageKeysExclusive(
    runtimeValue.database,
    initialSource,
  );
  if ("assets" in initialSource) {
    await assertAssetRelationsOwned(runtimeValue.database, initialSource);
  }
  const captured = await mapWithConcurrency(
    initialSource.storageKeys,
    8,
    (key) => captureKeyTargets(runtimeValue, key),
    runtimeValue.signal,
  );
  assertWorkflowNotAborted(runtimeValue);
  const residualTargets = uniqueTargets(captured.flat());
  await beforeClaimedOperationCommit(runtimeValue, claim);
  return runtimeValue.database.transaction(async (transaction) => {
    const row = await transaction(DELETION_OPERATION_TABLE)
      .where({ id: operationId })
      .forUpdate()
      .first();
    if (!row) {
      workflowError(
        "资产删除 operation 不存在",
        "DELETION_OPERATION_NOT_FOUND",
        404,
      );
    }
    const operation = mapOperation(row);
    if (operation.status !== "deleting") return operation;
    const finalizedAt = now(runtimeValue);
    if (!claim) {
      workflowError(
        "资产物理终结必须持有 operation 租约",
        "DELETION_OPERATION_LEASE_LOST",
        409,
      );
    }
    assertActiveClaim(operation, claim, finalizedAt);
    const project = await transaction("o_project")
      .where({
        id: operation.projectId,
        workspaceId: operation.workspaceId,
      })
      .forUpdate()
      .first();
    if (!project || String(project.deletionState || "active") !== "active") {
      return releaseClaimInTransaction(
        transaction,
        operation,
        finalizedAt,
        claim,
      );
    }

    const lockedSource = mediaAssetId === null
      ? await loadAssetDeletionSource(
        transaction,
        Number(numericAssetId),
        { lock: true },
      )
      : await loadMediaDeletionSource(
        transaction,
        mediaAssetId,
        { lock: true },
      );
    if (
      !lockedSource
      || lockedSource.sourceHash !== initialSource.sourceHash
      || lockedSource.projectDeletionState !== "active"
    ) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_ASSET_TOMBSTONE_INVALID",
        finalizedAt,
        claim,
      );
    }
    if ("assets" in lockedSource) {
      if (
        lockedSource.projectId !== operation.projectId
        || lockedSource.workspaceId !== operation.workspaceId
        || lockedSource.assets.some((asset) =>
          asset.deletionState !== "deleting"
          || asset.deletionOperationId !== operation.id)
        || lockedSource.images.some((image) =>
          image.deletionState !== "deleting"
          || image.deletionOperationId !== operation.id)
        || lockedSource.mediaAssets.some((media) =>
          media.deletionState !== "deleting"
          || media.deletionOperationId !== operation.id)
      ) {
        return blockDeletionOperationInTransaction(
          transaction,
          operation,
          "DELETION_ASSET_TOMBSTONE_INVALID",
          finalizedAt,
          claim,
        );
      }
      await assertAssetRelationsOwned(transaction, lockedSource, true);
    } else if (
      lockedSource.mediaAsset.projectId !== operation.projectId
      || lockedSource.mediaAsset.workspaceId !== operation.workspaceId
      || lockedSource.mediaAsset.deletionState !== "deleting"
      || lockedSource.mediaAsset.deletionOperationId !== operation.id
    ) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_ASSET_TOMBSTONE_INVALID",
        finalizedAt,
        claim,
      );
    }
    await assertAssetStorageKeysExclusive(
      transaction,
      lockedSource,
      true,
    );

    let records = await repository.listByOperationInTransaction(
      transaction,
      operation.id,
    );
    validateOutboxManifest(operation, records);
    if (outboxHasDead(records)) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_OUTBOX_DEAD",
        finalizedAt,
        claim,
      );
    }
    if (outboxHasIncomplete(records)) {
      return releaseClaimInTransaction(
        transaction,
        operation,
        finalizedAt,
        claim,
      );
    }
    const existingByTarget = new Map<string, DeletionOutboxRecord>();
    for (const record of records) {
      const identity = targetIdentity(record);
      if (existingByTarget.has(identity)) {
        return blockDeletionOperationInTransaction(
          transaction,
          operation,
          "DELETION_OUTBOX_PAYLOAD_CONFLICT",
          finalizedAt,
          claim,
        );
      }
      existingByTarget.set(identity, record);
    }
    const repeatedCompletedTarget = residualTargets.find((target) =>
      existingByTarget.has(targetIdentity(target)));
    if (repeatedCompletedTarget) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_STORAGE_RECEIPT_INCONSISTENT",
        finalizedAt,
        claim,
      );
    }
    const missingTargets = residualTargets.filter(
      (target) => !existingByTarget.has(targetIdentity(target)),
    );
    if (missingTargets.length) {
      await repository.appendInTransaction(transaction, {
        operationId: operation.id,
        items: missingTargets.map((target) =>
          targetToItem(target, {
            resourceType: mediaAssetId === null ? "asset" : "media_asset",
            resourceId: mediaAssetId ?? String(numericAssetId),
          })),
      });
      records = await repository.listByOperationInTransaction(
        transaction,
        operation.id,
      );
      await updateClaimedOperation(transaction, operation, claim, {
        manifestHash: manifestHashForItems(records),
        manifestRevision: operation.manifestRevision + 1,
        expectedItemCount: records.length,
        errorCode: null,
        coordinatorLeaseOwner: null,
        coordinatorLeaseExpiresAt: null,
        nextAttemptAt: finalizedAt,
        updatedAt: finalizedAt,
      });
      const expanded = await readOperation(transaction, operation.id);
      if (!expanded) {
        workflowError(
          "资产删除 operation 未持久化",
          "DELETION_OPERATION_ROW_INVALID",
          500,
        );
      }
      return expanded;
    }

    if (!("assets" in lockedSource)) {
      const enteredFinalizer = await transaction("o_media_asset")
        .where({
          id: lockedSource.mediaAsset.id,
          deletionState: "deleting",
          deletionOperationId: operation.id,
        })
        .whereNull("deletionFinalizeFence")
        .update({
          deletionState: "finalizing",
          deletionFinalizeFence: operation.coordinatorFence,
        });
      if (Number(enteredFinalizer) !== 1) {
        workflowError(
          "媒体 tombstone 无法进入受控终结态",
          "DELETION_ASSET_TOMBSTONE_INVALID",
          409,
        );
      }
      const deleted = await transaction("o_media_asset")
        .where({
          id: lockedSource.mediaAsset.id,
          deletionState: "finalizing",
          deletionOperationId: operation.id,
          deletionFinalizeFence: operation.coordinatorFence,
        })
        .delete();
      if (Number(deleted) !== 1) {
        workflowError(
          "媒体 tombstone 在终结期间发生变化",
          "DELETION_ASSET_TOMBSTONE_INVALID",
          409,
        );
      }
    } else {
      const assetIds = lockedSource.assets.map((asset) => asset.id);
      const imageIds = lockedSource.images.map((image) => image.id);
      const mediaIds = lockedSource.mediaAssets.map((media) => media.id);
      const enteredAssets = await transaction("o_assets")
        .whereIn("id", assetIds)
        .where({
          deletionState: "deleting",
          deletionOperationId: operation.id,
        })
        .whereNull("deletionFinalizeFence")
        .update({
          deletionState: "finalizing",
          deletionFinalizeFence: operation.coordinatorFence,
        });
      if (Number(enteredAssets) !== assetIds.length) {
        workflowError(
          "资产 tombstone 无法进入受控终结态",
          "DELETION_ASSET_TOMBSTONE_INVALID",
          409,
        );
      }
      if (imageIds.length) {
        const enteredImages = await transaction("o_image")
          .whereIn("id", imageIds)
          .where({
            deletionState: "deleting",
            deletionOperationId: operation.id,
          })
          .whereNull("deletionFinalizeFence")
          .update({
            deletionState: "finalizing",
            deletionFinalizeFence: operation.coordinatorFence,
          });
        if (Number(enteredImages) !== imageIds.length) {
          workflowError(
            "资产图片 tombstone 无法进入受控终结态",
            "DELETION_ASSET_TOMBSTONE_INVALID",
            409,
          );
        }
      }
      if (mediaIds.length) {
        const enteredMedia = await transaction("o_media_asset")
          .whereIn("id", mediaIds)
          .where({
            deletionState: "deleting",
            deletionOperationId: operation.id,
          })
          .whereNull("deletionFinalizeFence")
          .update({
            deletionState: "finalizing",
            deletionFinalizeFence: operation.coordinatorFence,
          });
        if (Number(enteredMedia) !== mediaIds.length) {
          workflowError(
            "关联媒体 tombstone 无法进入受控终结态",
            "DELETION_ASSET_TOMBSTONE_INVALID",
            409,
          );
        }
      }

      if (await transaction.schema.hasTable("o_assets2Storyboard")) {
        await transaction("o_assets2Storyboard")
          .whereIn("assetId", assetIds)
          .delete();
      }
      if (await transaction.schema.hasTable("o_scriptAssets")) {
        await transaction("o_scriptAssets")
          .whereIn("assetId", assetIds)
          .delete();
      }
      if (await transaction.schema.hasTable("o_assetsRole2Audio")) {
        await transaction("o_assetsRole2Audio")
          .whereIn("assetsRoleId", assetIds)
          .orWhereIn("assetsAudioId", assetIds)
          .delete();
      }
      if (mediaIds.length) {
        const deletedMedia = await transaction("o_media_asset")
          .whereIn("id", mediaIds)
          .where({
            deletionState: "finalizing",
            deletionOperationId: operation.id,
            deletionFinalizeFence: operation.coordinatorFence,
          })
          .delete();
        if (Number(deletedMedia) !== mediaIds.length) {
          workflowError(
            "关联媒体 tombstone 在终结期间发生变化",
            "DELETION_ASSET_TOMBSTONE_INVALID",
            409,
          );
        }
      }
      if (imageIds.length) {
        const deletedImages = await transaction("o_image")
          .whereIn("id", imageIds)
          .where({
            deletionState: "finalizing",
            deletionOperationId: operation.id,
            deletionFinalizeFence: operation.coordinatorFence,
          })
          .delete();
        if (Number(deletedImages) !== imageIds.length) {
          workflowError(
            "资产图片 tombstone 在终结期间发生变化",
            "DELETION_ASSET_TOMBSTONE_INVALID",
            409,
          );
        }
      }
      const deletedAssets = await transaction("o_assets")
        .whereIn("id", assetIds)
        .where({
          deletionState: "finalizing",
          deletionOperationId: operation.id,
          deletionFinalizeFence: operation.coordinatorFence,
        })
        .delete();
      if (Number(deletedAssets) !== assetIds.length) {
        workflowError(
          "资产 tombstone 在终结期间发生变化",
          "DELETION_ASSET_TOMBSTONE_INVALID",
          409,
        );
      }
      const flowIds = [...new Set(lockedSource.assets
        .map((asset) => asset.flowId)
        .filter((value): value is number =>
          value !== null
          && Number.isSafeInteger(value)
          && value > 0))];
      for (const flowId of flowIds) {
        const stillReferenced = await transaction("o_assets")
          .where({ flowId })
          .first()
          ?? await transaction("o_storyboard")
            .where({ flowId })
            .first();
        if (!stillReferenced) {
          await transaction("o_imageFlow").where({ id: flowId }).delete();
        }
      }
    }

    await updateClaimedOperation(transaction, operation, claim, {
      status: "completed",
      errorCode: null,
      coordinatorLeaseOwner: null,
      coordinatorLeaseExpiresAt: null,
      finalizedAt,
      nextAttemptAt: finalizedAt,
      updatedAt: finalizedAt,
    });
    const completed = await readOperation(transaction, operation.id);
    if (!completed) {
      workflowError(
        "资产删除 operation 未持久化",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    return completed;
  });
}

async function finalizeProjectDeletion(
  operationId: string,
  runtimeValue: ResolvedDeletionWorkflowRuntime,
  claim?: DeletionOperationLease,
): Promise<DeletionOperationRecord> {
  if (!claim) {
    workflowError(
      "项目删除终结必须持有 operation 租约",
      "DELETION_OPERATION_LEASE_LOST",
      409,
    );
  }
  const initialOperation = await readOperation(
    runtimeValue.database,
    operationId,
  );
  if (!initialOperation) {
    workflowError(
      "项目删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  if (initialOperation.status !== "deleting") return initialOperation;
  const repository = new DeletionOutboxRepository(
    runtimeValue.database,
    { clock: runtimeValue.clock },
  );
  const checkpoint = await runtimeValue.database.transaction(
    (transaction) => readDeletionChunkCheckpointInTransaction(
      transaction,
      operationId,
    ),
  );
  if (!checkpoint) {
    workflowError(
      "项目删除缺少分块 checkpoint",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  const assertManifestBinding = (
    operation: DeletionOperationRecord,
    current: DeletionChunkCheckpoint,
    total: number,
  ) => {
    if (
      operation.manifestHash === null
      || operation.manifestHash !== current.manifestChainHash
      || operation.expectedItemCount === null
      || operation.expectedItemCount !== current.manifestItemCount
      || total !== current.manifestItemCount
    ) {
      workflowError(
        "项目删除 operation、checkpoint 与 outbox 不一致",
        "DELETION_OUTBOX_MANIFEST_MISMATCH",
        500,
      );
    }
  };
  const initialSummary = await repository.summarizeByOperation(operationId);
  assertManifestBinding(
    initialOperation,
    checkpoint,
    initialSummary.total,
  );
  if (initialSummary.dead > 0 || initialSummary.incomplete > 0) {
    await beforeClaimedOperationCommit(runtimeValue, claim);
    return runtimeValue.database.transaction(async (transaction) => {
      const row = await transaction(DELETION_OPERATION_TABLE)
        .where({ id: operationId })
        .forUpdate()
        .first();
      if (!row) {
        workflowError(
          "项目删除 operation 不存在",
          "DELETION_OPERATION_NOT_FOUND",
          404,
        );
      }
      const operation = mapOperation(row);
      if (operation.status !== "deleting") return operation;
      const checkedAt = now(runtimeValue);
      assertActiveClaim(operation, claim, checkedAt);
      const current = await readDeletionChunkCheckpointInTransaction(
        transaction,
        operationId,
      );
      if (!current || current.phase !== checkpoint.phase) {
        workflowError(
          "项目删除 checkpoint 在 outbox 检查期间发生变化",
          "DELETION_CHUNK_CURSOR_LOST",
          409,
        );
      }
      const summary = await repository.summarizeByOperationInTransaction(
        transaction,
        operationId,
      );
      assertManifestBinding(operation, current, summary.total);
      if (summary.dead > 0) {
        return blockDeletionOperationInTransaction(
          transaction,
          operation,
          "DELETION_OUTBOX_DEAD",
          checkedAt,
          claim,
        );
      }
      if (summary.incomplete > 0) {
        return releaseClaimInTransaction(
          transaction,
          operation,
          checkedAt,
          claim,
        );
      }
      workflowError(
        "项目删除 outbox 状态在检查期间发生变化",
        "DELETION_OPERATION_CONFLICT",
        409,
      );
    });
  }

  if (checkpoint.phase === "dispatch") {
    await beforeClaimedOperationCommit(runtimeValue, claim);
    return runtimeValue.database.transaction(async (transaction) => {
      const row = await transaction(DELETION_OPERATION_TABLE)
        .where({ id: operationId })
        .forUpdate()
        .first();
      if (!row) {
        workflowError(
          "项目删除 operation 不存在",
          "DELETION_OPERATION_NOT_FOUND",
          404,
        );
      }
      const operation = mapOperation(row);
      if (operation.status !== "deleting") return operation;
      const advancedAt = now(runtimeValue);
      assertActiveClaim(operation, claim, advancedAt);
      const current = await readDeletionChunkCheckpointInTransaction(
        transaction,
        operationId,
      );
      if (!current || current.phase !== "dispatch") {
        workflowError(
          "项目删除 dispatch checkpoint 已被推进",
          "DELETION_CHUNK_CURSOR_LOST",
          409,
        );
      }
      const summary = await repository.summarizeByOperationInTransaction(
        transaction,
        operationId,
      );
      assertManifestBinding(operation, current, summary.total);
      if (summary.dead > 0) {
        return blockDeletionOperationInTransaction(
          transaction,
          operation,
          "DELETION_OUTBOX_DEAD",
          advancedAt,
          claim,
        );
      }
      if (summary.incomplete > 0) {
        return releaseClaimInTransaction(
          transaction,
          operation,
          advancedAt,
          claim,
        );
      }
      await advanceDeletionChunkCheckpointInTransaction(transaction, {
        lease: {
          operationId,
          owner: claim.workerId,
          fence: claim.coordinatorFence,
          now: advancedAt,
        },
        expectedPhase: "dispatch",
        expectedEpoch: current.epoch,
        expectedCursorHash: current.cursorHash,
        nextPhase: "verify",
      });
      return releaseClaimInTransaction(
        transaction,
        operation,
        advancedAt,
        claim,
      );
    });
  }

  if (checkpoint.phase === "db_finalize") {
    await beforeClaimedOperationCommit(runtimeValue, claim);
    return runtimeValue.database.transaction(async (transaction) => {
      const row = await transaction(DELETION_OPERATION_TABLE)
        .where({ id: operationId })
        .forUpdate()
        .first();
      if (!row) {
        workflowError(
          "项目删除 operation 不存在",
          "DELETION_OPERATION_NOT_FOUND",
          404,
        );
      }
      const operation = mapOperation(row);
      if (operation.status !== "deleting") return operation;
      const finalizedAt = now(runtimeValue);
      assertActiveClaim(operation, claim, finalizedAt);
      const current = await readDeletionChunkCheckpointInTransaction(
        transaction,
        operationId,
      );
      if (
        !current
        || current.phase !== "db_finalize"
        || current.epoch !== checkpoint.epoch
        || current.cursorHash !== checkpoint.cursorHash
      ) {
        workflowError(
          "项目删除 DB checkpoint 已被推进",
          "DELETION_CHUNK_CURSOR_LOST",
          409,
        );
      }
      const summary = await repository.summarizeByOperationInTransaction(
        transaction,
        operationId,
      );
      assertManifestBinding(operation, current, summary.total);
      if (summary.dead > 0) {
        return blockDeletionOperationInTransaction(
          transaction,
          operation,
          "DELETION_OUTBOX_DEAD",
          finalizedAt,
          claim,
        );
      }
      if (summary.incomplete > 0) {
        return releaseClaimInTransaction(
          transaction,
          operation,
          finalizedAt,
          claim,
        );
      }

      const project = await transaction("o_project")
        .where({
          id: operation.projectId,
          workspaceId: operation.workspaceId,
        })
        .select(
          "id",
          "workspaceId",
          "deletionState",
          "deletionOperationId",
          "deletionRequestedAt",
          "deletionFinalizeFence",
        )
        .forUpdate()
        .first();
      const persistedFence = Number(project?.deletionFinalizeFence);
      if (
        !project
        || String(project.deletionState) !== "finalizing"
        || String(project.deletionOperationId) !== operation.id
        || Number(project.deletionRequestedAt) !== operation.requestedAt
        || !Number.isSafeInteger(persistedFence)
        || persistedFence <= 0
        || persistedFence > claim.coordinatorFence
      ) {
        workflowError(
          "项目 DB 终结 tombstone 与 operation 不一致",
          "DELETION_PROJECT_TOMBSTONE_INVALID",
          409,
        );
      }
      if (persistedFence < claim.coordinatorFence) {
        const adopted = await transaction("o_project")
          .where({
            id: operation.projectId,
            workspaceId: operation.workspaceId,
            deletionState: "finalizing",
            deletionOperationId: operation.id,
            deletionRequestedAt: operation.requestedAt,
            deletionFinalizeFence: persistedFence,
          })
          .update({
            deletionFinalizeFence: claim.coordinatorFence,
            updatedAt: finalizedAt,
          });
        if (Number(adopted) !== 1) {
          workflowError(
            "项目 DB 终结 fencing token 接管失败",
            "DELETION_PROJECT_TOMBSTONE_INVALID",
            409,
          );
        }
      }

      const position = projectDeletionFinalizerPosition(current);
      const lease = {
        operationId,
        owner: claim.workerId,
        fence: claim.coordinatorFence,
        now: finalizedAt,
      };
      const auditState: {
        checkpoint?: DeletionChunkCheckpoint;
      } = {};
      const result =
        await runProjectDeletionFinalizerBatchInTransaction(
          transaction,
          {
            scope: {
              projectId: operation.projectId,
              workspaceId: operation.workspaceId,
            },
            authority: {
              operationId: operation.id,
              requestedAt: operation.requestedAt,
              fence: claim.coordinatorFence,
              finalizedAt,
            },
            ...position,
            beforeApply: async (auditTransaction, audit) => {
              if (
                audit.tableOrdinal !== position.tableOrdinal
                || audit.tableName !== position.tableName
                || stableJson(audit.inputCursor)
                  !== stableJson(position.cursor)
              ) {
                workflowError(
                  "项目删除 DB 审计输入与 checkpoint 不一致",
                  "DELETION_PROJECT_AUDIT_INVALID",
                  500,
                );
              }
              auditState.checkpoint = (
                await appendDeletionAuditChunkInTransaction(
                  auditTransaction,
                  {
                    lease,
                    epoch: current.epoch,
                    tableOrdinal: audit.tableOrdinal,
                    tableName: audit.tableName,
                    ordinal: current.nextAuditChunkOrdinal,
                    inputCursorHash: current.cursorHash,
                    inputAuditCursor: audit.inputCursor,
                    outputAuditCursor: audit.outputCursor,
                    rowCount: audit.rowCount,
                    rowsHash: audit.rowsHash,
                  },
                )
              ).checkpoint;
            },
          },
        );

      if (result.kind === "applied" || result.kind === "completed") {
        const auditCheckpoint = auditState.checkpoint;
        const outputCursor = result.kind === "completed"
          ? result.audit.outputCursor
          : result.next.cursor;
        if (
          !auditCheckpoint
          || auditCheckpoint.phase !== "db_finalize"
          || auditCheckpoint.auditTableOrdinal !== result.step.ordinal
          || auditCheckpoint.auditTableName !== result.step.name
          || auditCheckpoint.auditCursorJson
            !== stableJson(outputCursor)
        ) {
          workflowError(
            "项目删除 DB 审计输出未原子推进 checkpoint",
            "DELETION_PROJECT_AUDIT_INVALID",
            500,
          );
        }
        if (result.kind === "completed") {
          if (
            result.step.ordinal
              !== PROJECT_DELETION_FINALIZER_STEPS.length - 1
            || result.step.name
              !== PROJECT_DELETION_FINALIZER_STEPS.at(-1)?.name
          ) {
            workflowError(
              "项目 tombstone 终结步骤目录无效",
              "DELETION_PROJECT_AUDIT_INVALID",
              500,
            );
          }
          const completedCheckpoint =
            await advanceDeletionChunkCheckpointInTransaction(
              transaction,
              {
                lease,
                expectedPhase: "db_finalize",
                expectedEpoch: auditCheckpoint.epoch,
                expectedCursorHash: auditCheckpoint.cursorHash,
                nextPhase: "completed",
              },
            );
          const audit = projectAuditSnapshot(
            operation,
            completedCheckpoint,
            finalizedAt,
          );
          await updateClaimedOperation(
            transaction,
            operation,
            claim,
            {
              status: "completed",
              errorCode: null,
              coordinatorLeaseOwner: null,
              coordinatorLeaseExpiresAt: null,
              finalizedAt,
              auditSnapshot: audit.auditSnapshot,
              auditSnapshotHash: audit.auditSnapshotHash,
              nextAttemptAt: finalizedAt,
              updatedAt: finalizedAt,
            },
          );
          const completed = await readOperation(transaction, operationId);
          if (!completed) {
            workflowError(
              "项目删除 operation 未持久化",
              "DELETION_OPERATION_ROW_INVALID",
              500,
            );
          }
          return completed;
        }
        return releaseClaimInTransaction(
          transaction,
          operation,
          finalizedAt,
          claim,
        );
      }

      if (result.kind === "step_complete") {
        const advanced =
          await advanceDeletionAuditTableInTransaction(
            transaction,
            {
              lease,
              expectedEpoch: current.epoch,
              expectedCursorHash: current.cursorHash,
              expectedTableOrdinal: position.tableOrdinal,
              expectedTableName: position.tableName,
              nextTableName: result.next.tableName,
              nextCursor: result.next.cursor,
            },
          );
        if (
          advanced.auditTableOrdinal !== result.next.tableOrdinal
          || advanced.auditTableName !== result.next.tableName
          || advanced.auditCursorJson !== stableJson(result.next.cursor)
        ) {
          workflowError(
            "项目删除 DB 步骤 checkpoint 推进无效",
            "DELETION_PROJECT_AUDIT_INVALID",
            500,
          );
        }
        return releaseClaimInTransaction(
          transaction,
          operation,
          finalizedAt,
          claim,
        );
      }

      workflowError(
        "项目 tombstone 终结步骤不得在未写入审计时完成",
        "DELETION_PROJECT_AUDIT_INVALID",
        500,
      );
    });
  }
  if (checkpoint.phase !== "verify") {
    workflowError(
      "项目删除 checkpoint 阶段无效",
      "DELETION_OPERATION_ROW_INVALID",
      500,
    );
  }
  const inputMarker: DeletionStorageMarker | null =
    checkpoint.keyMarker && checkpoint.versionIdMarker
      ? {
          keyMarker: checkpoint.keyMarker,
          versionIdMarker: checkpoint.versionIdMarker,
        }
      : null;
  const page = await runtimeValue.capturePrefixTargetPage(
    checkpoint.objectPrefix,
    {
      maximumObjects: 500,
      keyMarker: inputMarker?.keyMarker,
      versionIdMarker: inputMarker?.versionIdMarker,
      timeoutMs: 15_000,
    },
    { signal: runtimeValue.signal },
  );
  assertWorkflowNotAborted(runtimeValue);
  if (
    page.providerId !== checkpoint.providerId
    || page.providerFingerprint !== checkpoint.providerFingerprint
    || page.bucket !== checkpoint.bucket
    || page.objectPrefix !== checkpoint.objectPrefix
    || page.targets.length > 500
    || page.targets.some((target) => target.exists === false)
    || (page.truncated
      && (!page.keyMarker || !page.versionIdMarker))
    || (!page.truncated
      && (page.keyMarker !== null || page.versionIdMarker !== null))
  ) {
    workflowError(
      "项目删除 verify 分页证据无效",
      "DELETION_MANIFEST_SOURCE_CHANGED",
      502,
    );
  }
  const items = page.targets.map((target) =>
    targetToItem(target, {
      resourceType: "project",
      resourceId: String(initialOperation.projectId),
    }));
  const pageContentHash = repository.manifestChunkContentHash({
    operationId,
    items,
  });
  const providerOutputMarker: DeletionStorageMarker | null =
    page.truncated
      ? {
          keyMarker: nonEmptyText(
            page.keyMarker,
            "storage key marker",
            4_096,
          ),
          versionIdMarker: nonEmptyText(
            page.versionIdMarker,
            "storage version marker",
            4_096,
          ),
        }
      : null;
  await beforeClaimedOperationCommit(runtimeValue, claim);
  return runtimeValue.database.transaction(async (transaction) => {
    const row = await transaction(DELETION_OPERATION_TABLE)
      .where({ id: operationId })
      .forUpdate()
      .first();
    if (!row) {
      workflowError(
        "项目删除 operation 不存在",
        "DELETION_OPERATION_NOT_FOUND",
        404,
      );
    }
    const operation = mapOperation(row);
    if (operation.status !== "deleting") return operation;
    const verifiedAt = now(runtimeValue);
    assertActiveClaim(operation, claim, verifiedAt);
    const current = await readDeletionChunkCheckpointInTransaction(
      transaction,
      operationId,
    );
    if (
      !current
      || current.phase !== "verify"
      || current.epoch !== checkpoint.epoch
      || current.cursorHash !== checkpoint.cursorHash
      || current.keyMarker !== checkpoint.keyMarker
      || current.versionIdMarker !== checkpoint.versionIdMarker
    ) {
      workflowError(
        "项目删除 verify cursor 已被推进",
        "DELETION_CHUNK_CURSOR_LOST",
        409,
      );
    }
    const lockedProject = await transaction("o_project")
      .where({
        id: operation.projectId,
        workspaceId: operation.workspaceId,
        deletionState: "deleting",
        deletionOperationId: operation.id,
      })
      .forUpdate()
      .select("id")
      .first();
    if (!lockedProject) {
      workflowError(
        "项目删除 tombstone 与 operation 不一致",
        "DELETION_PROJECT_TOMBSTONE_INVALID",
        409,
      );
    }
    const summary = await repository.summarizeByOperationInTransaction(
      transaction,
      operationId,
    );
    assertManifestBinding(operation, current, summary.total);
    if (summary.dead > 0) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_OUTBOX_DEAD",
        verifiedAt,
        claim,
      );
    }
    if (summary.incomplete > 0) {
      return releaseClaimInTransaction(
        transaction,
        operation,
        verifiedAt,
        claim,
      );
    }
    const existing = items.length
      ? await repository.findManifestChunkItemsInTransaction(
          transaction,
          { operationId, items },
        )
      : [];
    if (existing.length > 0) {
      return blockDeletionOperationInTransaction(
        transaction,
        operation,
        "DELETION_STORAGE_RECEIPT_INCONSISTENT",
        verifiedAt,
        claim,
      );
    }
    const lease = {
      operationId,
      owner: claim.workerId,
      fence: claim.coordinatorFence,
      now: verifiedAt,
    };
    const outputMarker = items.length > 0
      ? null
      : providerOutputMarker;
    let nextCheckpoint = (
      await appendDeletionManifestChunkInTransaction(
        transaction,
        {
          lease,
          phase: "verify",
          epoch: current.epoch,
          ordinal: current.nextManifestChunkOrdinal,
          inputCursorHash: current.cursorHash,
          inputMarker,
          outputMarker,
          itemCount: items.length,
          contentHash: pageContentHash,
        },
        async (savepoint, context) => {
          const before = await repository
            .summarizeByOperationInTransaction(
              savepoint,
              operationId,
            );
          if (
            before.total
            !== context.currentCheckpoint.manifestItemCount
          ) {
            workflowError(
              "项目删除 verify 前 outbox 数量不一致",
              "DELETION_OUTBOX_CARDINALITY_MISMATCH",
              500,
            );
          }
          if (items.length) {
            const duplicate = await repository
              .findManifestChunkItemsInTransaction(savepoint, {
                operationId,
                items,
              });
            if (duplicate.length) {
              workflowError(
                "项目删除 verify generation 已存在于 manifest",
                "DELETION_STORAGE_RECEIPT_INCONSISTENT",
                409,
              );
            }
            const appendHash = repository.manifestChunkContentHash({
              operationId,
              items,
            });
            await repository.appendManifestChunkInTransaction(
              savepoint,
              { operationId, items, contentHash: appendHash },
            );
          }
          const after = await repository
            .summarizeByOperationInTransaction(
              savepoint,
              operationId,
            );
          if (
            after.total !== context.nextCheckpoint.manifestItemCount
          ) {
            workflowError(
              "项目删除 verify 后 outbox 数量不一致",
              "DELETION_OUTBOX_CARDINALITY_MISMATCH",
              500,
            );
          }
        },
      )
    ).checkpoint;
    if (!page.truncated && items.length === 0) {
      const enteredFinalizer = await transaction("o_project")
        .where({
          id: operation.projectId,
          workspaceId: operation.workspaceId,
          deletionState: "deleting",
          deletionOperationId: operation.id,
        })
        .whereNull("deletionFinalizeFence")
        .update({
          deletionState: "finalizing",
          deletionFinalizeFence: claim.coordinatorFence,
          updatedAt: verifiedAt,
        });
      if (Number(enteredFinalizer) !== 1) {
        workflowError(
          "项目 tombstone 无法进入分块终结态",
          "DELETION_PROJECT_TOMBSTONE_INVALID",
          409,
        );
      }
      nextCheckpoint =
        await advanceDeletionChunkCheckpointInTransaction(
          transaction,
          {
            lease,
            expectedPhase: "verify",
            expectedEpoch: nextCheckpoint.epoch,
            expectedCursorHash: nextCheckpoint.cursorHash,
            nextPhase: "db_finalize",
            audit: firstProjectDeletionFinalizerCursor(),
          },
        );
    }
    await updateClaimedOperation(
      transaction,
      operation,
      claim,
      {
        manifestHash: nextCheckpoint.manifestChainHash,
        manifestRevision: operation.manifestRevision + 1,
        expectedItemCount: nextCheckpoint.manifestItemCount,
        errorCode: null,
        coordinatorLeaseOwner: null,
        coordinatorLeaseExpiresAt: null,
        nextAttemptAt: verifiedAt,
        updatedAt: verifiedAt,
      },
    );
    const next = await readOperation(transaction, operationId);
    if (!next) {
      workflowError(
        "项目删除 operation 未持久化",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    return next;
  });
}

export async function finalizeDeletionOperation(
  operationId: string,
  runtimeInput: DeletionWorkflowRuntime = {},
  claim?: DeletionOperationLease,
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  const operation = await readOperation(runtimeValue.database, operationId);
  if (!operation) {
    workflowError(
      "删除 operation 不存在",
      "DELETION_OPERATION_NOT_FOUND",
      404,
    );
  }
  if (operation.status === "completed" || operation.status === "blocked") {
    return operation;
  }
  if (operation.status === "preparing") {
    if (operation.kind !== "project") {
      workflowError(
        "只有项目 operation 可以处于 preparing",
        "DELETION_OPERATION_ROW_INVALID",
        500,
      );
    }
    return prepareProjectDeletionOperation(
      operation.id,
      runtimeValue,
      claim,
    );
  }
  if (operation.kind === "image") {
    return finalizeImageDeletion(operation.id, runtimeValue, claim);
  }
  if (operation.kind === "asset") {
    return finalizeAssetDeletion(operation.id, runtimeValue, claim);
  }
  if (operation.kind === "project") {
    return finalizeProjectDeletion(operation.id, runtimeValue, claim);
  }
  workflowError("删除 operation kind 不受支持", "DELETION_OPERATION_KIND_UNSUPPORTED", 500);
}

export async function requestProjectDeletion(
  input: RequestProjectDeletionInput,
  runtimeInput: DeletionWorkflowRuntime = {},
): Promise<DeletionOperationRecord> {
  const runtimeValue = runtime(runtimeInput);
  const projectId = positiveId(input.projectId, "projectId");
  const userId = positiveId(input.userId, "userId");
  await requireAuthorization(runtimeValue, {
    projectId,
    userId,
    role: input.role,
    authWorkspaceId: input.authWorkspaceId,
    permission: "project:delete",
    allowDeleting: true,
  });
  const requestedAt = now(runtimeValue);
  return await runtimeValue.database.transaction(
    async (transaction) => {
      const project = await transaction("o_project")
        .where({ id: projectId })
        .forUpdate()
        .first();
      if (!project) {
        workflowError(
          "项目不存在",
          "DELETION_RESOURCE_NOT_FOUND",
          404,
        );
      }
      await requireAuthorization(runtimeValue, {
        projectId,
        userId,
        role: input.role,
        authWorkspaceId: input.authWorkspaceId,
        permission: "project:delete",
        allowDeleting: true,
        database: transaction,
        lock: true,
      });
      if (
        ["deleting", "deleted"].includes(
          String(project.deletionState || "active"),
        )
        && persistedString(project.deletionOperationId)
      ) {
        const replay = await readOperation(
          transaction,
          String(project.deletionOperationId),
        );
        if (replay) return replay;
        workflowError(
          "项目删除 tombstone 缺少 operation",
          "DELETION_OPERATION_ROW_INVALID",
          500,
        );
      }
      if (String(project.deletionState || "active") !== "active") {
        workflowError(
          "项目删除状态无效",
          "DELETION_PROJECT_TOMBSTONE_INVALID",
          409,
        );
      }
      const workspaceId = String(project.workspaceId || "");
      if (!workspaceId) {
        workflowError(
          "项目 workspace 归属无效",
          "DELETION_AUTHORITY_CHAIN_INVALID",
          404,
        );
      }
      await assertProjectStoragePrefixInvariant(transaction, {
        projectId,
        workspaceId,
      });
      await assertNoActiveProjectWork(transaction, {
        projectId,
        workspaceId,
      });
      const id = runtimeValue.idFactory();
      await insertOperation(transaction, {
        id,
        operationKey: operationKey(
          "project",
          workspaceId,
          String(projectId),
        ),
        kind: "project",
        workspaceId,
        projectId,
        resourceId: String(projectId),
        status: "preparing",
        requestHash: requestHash({
          kind: "project",
          workspaceId,
          projectId,
          resourceId: String(projectId),
        }),
        manifestHash: null,
        expectedItemCount: null,
        requestedBy: userId,
        now: requestedAt,
      });
      const marked = await transaction("o_project")
        .where({ id: projectId, deletionState: "active" })
        .whereNull("deletionOperationId")
        .update({
          deletionState: "deleting",
          deletionOperationId: id,
          deletionRequestedAt: requestedAt,
          updatedAt: requestedAt,
        });
      if (Number(marked) !== 1) {
        workflowError(
          "项目删除状态竞争",
          "DELETION_OPERATION_CONFLICT",
          409,
        );
      }
      const created = await readOperation(transaction, id);
      if (!created) {
        workflowError(
          "项目删除 operation 未持久化",
          "DELETION_OPERATION_ROW_INVALID",
          500,
        );
      }
      return created;
    },
  );
}

export function deletionWorkflowHttpError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof DeletionWorkflowError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
  };
  const status = Number(candidate?.status ?? candidate?.statusCode);
  const code = typeof candidate?.code === "string"
    ? candidate.code
    : "DELETION_WORKFLOW_UNAVAILABLE";
  const validStatus = Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 500;
  const configurationFailure = code.includes("CONFIGURATION")
    || code.endsWith("_PROVIDER_REQUIRED")
    || code === "OBJECT_STORAGE_LOCAL_CONDITIONAL_DELETE_FORBIDDEN"
    || code === "OBJECT_STORAGE_LOCAL_ROOT_INVALID";
  return {
    status: validStatus,
    code,
    message: configurationFailure
      ? "删除服务配置缺失或无效，请联系管理员后重试"
      : code === "OBJECT_STORAGE_GENERATION_PRECONDITION_FAILED"
        ? "资源已发生变化，未执行删除，请刷新后重试"
        : code.startsWith("OBJECT_STORAGE_") && validStatus >= 500
          ? "对象存储服务暂不可用，请稍后重试"
          : validStatus < 500
            ? String((error as Error)?.message || "删除请求失败")
            : "删除工作流暂不可用",
  };
}
