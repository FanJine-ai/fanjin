import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

import {
  type VolcenginePortraitArkAction,
  type VolcenginePortraitIdempotencyClaim,
  type VolcenginePortraitIdempotencyRecord,
  type VolcenginePortraitIdempotencyState,
  type VolcenginePortraitIdempotencyStore,
} from "@/lib/volcenginePortraitAssets";
import { db } from "@/utils/db";

const TABLE = "o_agent_idempotency";
const SCOPE_PREFIX = "volcengine-portrait-assets:v1";
const NEVER_AUTO_EXPIRE_AT = Number.MAX_SAFE_INTEGER;
const MAX_REPLAY_BODY_BYTES = 64 * 1024;
const SENSITIVE_RECEIPT_ACTIONS = new Set<VolcenginePortraitArkAction>([
  "CreateVisualValidateSession",
]);

const STATUS_BY_STATE: Readonly<Record<VolcenginePortraitIdempotencyState, string>> = {
  completed: "volc_portrait_completed",
  failed: "volc_portrait_failed",
  in_progress: "volc_portrait_in_progress",
  outcome_unknown: "volc_portrait_outcome_unknown",
};

const STATE_BY_STATUS = new Map<string, VolcenginePortraitIdempotencyState>(
  Object.entries(STATUS_BY_STATE).map(([state, status]) => [
    status,
    state as VolcenginePortraitIdempotencyState,
  ]),
);

type StoredReceipt =
  | Readonly<{
    action: VolcenginePortraitArkAction;
    kind: "reservation" | "sensitive_receipt";
  }>
  | Readonly<{
    action: VolcenginePortraitArkAction;
    errorCode: string;
    kind: "terminal_error";
  }>
  | Readonly<{
    action: VolcenginePortraitArkAction;
    kind: "replayable";
    result: unknown;
  }>;

export class VolcenginePortraitIdempotencyStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VolcenginePortraitIdempotencyStoreError";
    this.code = code;
  }
}

export interface KnexVolcenginePortraitIdempotencyStoreOptions {
  actorUserId: number;
  database?: Knex | Knex.Transaction;
  workspaceId: string;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeErrorCode(value: unknown): string {
  const code = cleanString(value);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(code)
    ? code
    : "VOLC_PORTRAIT_UPSTREAM_ERROR";
}

function isUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = cleanString(candidate?.code).toUpperCase();
  const message = cleanString(candidate?.message).toLowerCase();
  return code === "23505"
    || code === "SQLITE_CONSTRAINT"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || message.includes("unique constraint");
}

function actionFromResourceType(value: unknown): VolcenginePortraitArkAction {
  const resourceType = cleanString(value);
  const prefix = "volc_portrait_action:";
  const action = resourceType.startsWith(prefix) ? resourceType.slice(prefix.length) : "";
  if (![
    "CreateAssetGroup",
    "GetAssetGroup",
    "ListAssetGroups",
    "UpdateAssetGroup",
    "DeleteAssetGroup",
    "CreateVisualValidateSession",
    "GetVisualValidateResult",
    "CreateAsset",
    "GetAsset",
    "ListAssets",
    "UpdateAsset",
    "DeleteAsset",
  ].includes(action)) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_RECORD_INVALID",
      "火山人像资产幂等记录缺少有效操作类型",
    );
  }
  return action as VolcenginePortraitArkAction;
}

function parseReceipt(value: unknown, action: VolcenginePortraitArkAction): StoredReceipt {
  if (typeof value !== "string" || !value.trim()) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_RECORD_INVALID",
      "火山人像资产幂等记录缺少安全回执",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_RECORD_INVALID",
      "火山人像资产幂等回执格式无效",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_RECORD_INVALID",
      "火山人像资产幂等回执格式无效",
    );
  }
  const receipt = parsed as Record<string, unknown>;
  if (receipt.action !== action || !["reservation", "sensitive_receipt", "terminal_error", "replayable"].includes(String(receipt.kind))) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_RECORD_INVALID",
      "火山人像资产幂等回执与操作不一致",
    );
  }
  return receipt as StoredReceipt;
}

function serializeReceipt(receipt: StoredReceipt): string {
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPLAY_BODY_BYTES) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_RESULT_TOO_LARGE",
      "火山人像资产幂等结果超过安全大小限制",
    );
  }
  return serialized;
}

function validateRecord(input: VolcenginePortraitIdempotencyRecord): void {
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_REQUEST_HASH_INVALID",
      "火山人像资产幂等请求摘要无效",
    );
  }
  if (!input.scopeKey || input.scopeKey.length > 2_048) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_SCOPE_INVALID",
      "火山人像资产幂等作用域无效",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/.test(input.idempotencyKey)) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_KEY_INVALID",
      "火山人像资产幂等键无效",
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(input.leaseToken)) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_LEASE_INVALID",
      "火山人像资产幂等租约无效",
    );
  }
}

function recordFromRow(row: Record<string, unknown>): VolcenginePortraitIdempotencyRecord {
  const action = actionFromResourceType(row.resourceType);
  const state = STATE_BY_STATUS.get(cleanString(row.status));
  if (!state) {
    throw new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_RECORD_INVALID",
      "火山人像资产幂等状态无效",
    );
  }
  const receipt = parseReceipt(row.responseBody, action);
  const result = state === "completed" && receipt.kind === "replayable"
    ? receipt.result
    : undefined;
  const errorCode = (state === "failed" || state === "outcome_unknown")
    && receipt.kind === "terminal_error"
    ? safeErrorCode(receipt.errorCode)
    : undefined;
  return {
    action,
    ...(errorCode ? { errorCode } : {}),
    idempotencyKey: cleanString(row.idempotencyKey),
    leaseToken: cleanString(row.resourceId),
    requestHash: cleanString(row.requestHash),
    ...(result === undefined ? {} : { result }),
    scopeKey: cleanString(row.scopeKey).replace(/^.*?:scope:/, ""),
    state,
    updatedAt: Number(row.updatedAt),
  };
}

/**
 * Durable adapter over the existing o_agent_idempotency table.
 *
 * - `scopeKey + idempotencyKey` is the atomic uniqueness fence.
 * - `resourceId` stores the opaque lease token and is included in every
 *   terminal update predicate.
 * - rows never auto-expire; outcome_unknown must be reconciled explicitly.
 * - CreateVisualValidateSession stores only a receipt. Raw BytedToken/H5Link
 *   values are never serialized into responseBody and therefore cannot be
 *   replayed across processes.
 */
export class KnexVolcenginePortraitIdempotencyStore
implements VolcenginePortraitIdempotencyStore {
  readonly durability = "durable" as const;

  private readonly actorUserId: number;
  private readonly database: Knex | Knex.Transaction;
  private readonly workspaceId: string;

  constructor(options: KnexVolcenginePortraitIdempotencyStoreOptions) {
    const workspaceId = cleanString(options.workspaceId);
    if (!workspaceId || workspaceId.length > 255) {
      throw new VolcenginePortraitIdempotencyStoreError(
        "VOLC_PORTRAIT_IDEMPOTENCY_AUTHORITY_INVALID",
        "火山人像资产幂等存储缺少工作区权限边界",
      );
    }
    if (!Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0) {
      throw new VolcenginePortraitIdempotencyStoreError(
        "VOLC_PORTRAIT_IDEMPOTENCY_AUTHORITY_INVALID",
        "火山人像资产幂等存储缺少操作人权限边界",
      );
    }
    this.actorUserId = options.actorUserId;
    this.database = options.database ?? db;
    this.workspaceId = workspaceId;
  }

  async claim(input: VolcenginePortraitIdempotencyRecord): Promise<VolcenginePortraitIdempotencyClaim> {
    validateRecord(input);
    const scopeKey = this.storedScopeKey(input.scopeKey);
    const reservationReceipt = serializeReceipt({ action: input.action, kind: "reservation" });
    try {
      await this.database(TABLE).insert({
        actorUserId: this.actorUserId,
        createdAt: input.updatedAt,
        expiresAt: NEVER_AUTO_EXPIRE_AT,
        id: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        resourceId: input.leaseToken,
        resourceType: `volc_portrait_action:${input.action}`,
        responseBody: reservationReceipt,
        responseStatus: null,
        scopeKey,
        status: STATUS_BY_STATE.in_progress,
        updatedAt: input.updatedAt,
        workspaceId: this.workspaceId,
      });
      return { kind: "claimed", record: { ...input, scopeKey: input.scopeKey } };
    } catch (caught) {
      if (!isUniqueConstraintError(caught)) throw caught;
      const existing = await this.read(scopeKey, input.idempotencyKey);
      if (!existing) throw caught;
      if (existing.requestHash !== input.requestHash) {
        throw new VolcenginePortraitIdempotencyStoreError(
          "VOLC_PORTRAIT_IDEMPOTENCY_CONFLICT",
          "相同幂等键已绑定到不同的火山人像资产请求",
        );
      }
      if (existing.action !== input.action) {
        throw new VolcenginePortraitIdempotencyStoreError(
          "VOLC_PORTRAIT_IDEMPOTENCY_CONFLICT",
          "相同幂等键已绑定到不同的火山人像资产操作",
        );
      }
      return { kind: "existing", record: { ...existing, scopeKey: input.scopeKey } };
    }
  }

  async complete(input: {
    leaseToken: string;
    result: unknown;
    scopeKey: string;
    updatedAt: number;
  }): Promise<void> {
    const storedScopeKey = this.storedScopeKey(input.scopeKey);
    const current = await this.read(storedScopeKey, undefined, input.leaseToken);
    if (!current) throw this.leaseLost();
    const receipt: StoredReceipt = SENSITIVE_RECEIPT_ACTIONS.has(current.action)
      ? { action: current.action, kind: "sensitive_receipt" }
      : { action: current.action, kind: "replayable", result: input.result };
    const responseBody = serializeReceipt(receipt);
    const updated = await this.database(TABLE)
      .where({
        resourceId: input.leaseToken,
        scopeKey: storedScopeKey,
        status: STATUS_BY_STATE.in_progress,
        workspaceId: this.workspaceId,
      })
      .update({
        expiresAt: NEVER_AUTO_EXPIRE_AT,
        responseBody,
        responseStatus: 200,
        status: STATUS_BY_STATE.completed,
        updatedAt: input.updatedAt,
      });
    if (Number(updated) === 1) return;
    const terminal = await this.read(storedScopeKey, undefined, input.leaseToken);
    if (terminal?.state === "completed") return;
    throw this.leaseLost();
  }

  async fail(input: {
    errorCode: string;
    leaseToken: string;
    outcomeUnknown: boolean;
    scopeKey: string;
    updatedAt: number;
  }): Promise<void> {
    const storedScopeKey = this.storedScopeKey(input.scopeKey);
    const current = await this.read(storedScopeKey, undefined, input.leaseToken);
    if (!current) throw this.leaseLost();
    const state: VolcenginePortraitIdempotencyState = input.outcomeUnknown
      ? "outcome_unknown"
      : "failed";
    const errorCode = safeErrorCode(input.errorCode);
    const responseBody = serializeReceipt({
      action: current.action,
      errorCode,
      kind: "terminal_error",
    });
    const updated = await this.database(TABLE)
      .where({
        resourceId: input.leaseToken,
        scopeKey: storedScopeKey,
        status: STATUS_BY_STATE.in_progress,
        workspaceId: this.workspaceId,
      })
      .update({
        expiresAt: NEVER_AUTO_EXPIRE_AT,
        responseBody,
        responseStatus: input.outcomeUnknown ? 409 : 422,
        status: STATUS_BY_STATE[state],
        updatedAt: input.updatedAt,
      });
    if (Number(updated) === 1) return;
    const terminal = await this.read(storedScopeKey, undefined, input.leaseToken);
    if (terminal?.state === state && terminal.errorCode === errorCode) return;
    throw this.leaseLost();
  }

  private storedScopeKey(scopeKey: string): string {
    const value = cleanString(scopeKey);
    if (!value || value.length > 2_048) {
      throw new VolcenginePortraitIdempotencyStoreError(
        "VOLC_PORTRAIT_IDEMPOTENCY_SCOPE_INVALID",
        "火山人像资产幂等作用域无效",
      );
    }
    // actorUserId is audit attribution for the first claimant, not part of the
    // upstream write identity. Admin/API-key rotation inside one workspace
    // must continue to hit the same durable fence.
    return `${SCOPE_PREFIX}:${this.workspaceId}:scope:${value}`;
  }

  private async read(
    storedScopeKey: string,
    idempotencyKey?: string,
    leaseToken?: string,
  ): Promise<VolcenginePortraitIdempotencyRecord | null> {
    const query = this.database(TABLE).where({
      scopeKey: storedScopeKey,
      workspaceId: this.workspaceId,
    });
    if (idempotencyKey) query.andWhere({ idempotencyKey });
    if (leaseToken) query.andWhere({ resourceId: leaseToken });
    const row = await query.first();
    return row ? recordFromRow(row as Record<string, unknown>) : null;
  }

  private leaseLost(): VolcenginePortraitIdempotencyStoreError {
    return new VolcenginePortraitIdempotencyStoreError(
      "VOLC_PORTRAIT_IDEMPOTENCY_LEASE_LOST",
      "火山人像资产幂等租约已变化",
    );
  }
}
