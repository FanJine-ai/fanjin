import { portraitRegistrationFailureMessage } from "@/lib/portraitRegistrationFailure";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  VolcenginePortraitAssetsClient,
  VolcenginePortraitAssetsError,
  type VolcenginePortraitAsset,
  type VolcenginePortraitAssetGroupRef,
  type VolcenginePortraitAssetRef,
  type VolcenginePortraitAssetScope,
  type VolcenginePortraitAssetType,
} from "@/lib/volcenginePortraitAssets";

export const VOLCENGINE_PORTRAIT_ASSET_SYNC_STATES = [
  "queued",
  "submitting",
  "processing",
  "active",
  "failed",
  "stale",
  "revoked",
] as const;

export type VolcenginePortraitAssetSyncStatus =
  (typeof VOLCENGINE_PORTRAIT_ASSET_SYNC_STATES)[number];

export type VolcenginePortraitAssetSyncRecord = Readonly<{
  activeAt: number | null;
  asset: VolcenginePortraitAssetRef | null;
  createdAt: number;
  idempotencyKey: string;
  nextAttemptAt: number;
  providerAssetUri: string | null;
  requestHash: string;
  retryCount: number;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  scope: VolcenginePortraitAssetScope;
  sourceSha256: string;
  state: VolcenginePortraitAssetSyncStatus;
  timeoutAt: number;
  updatedAt: number;
}>;

export type VolcenginePortraitAssetSubmitInput = Readonly<{
  assetType: VolcenginePortraitAssetType;
  group: VolcenginePortraitAssetGroupRef;
  idempotencyKey: string;
  name?: string;
  signal?: AbortSignal;
  sourceSha256: string;
  url: string;
}>;

export type VolcenginePortraitAssetSyncResult = Readonly<{
  outcome: "not_due" | "submitted" | "processing" | "active" | "failed";
  record: VolcenginePortraitAssetSyncRecord;
}>;

export interface VolcenginePortraitAssetSyncPolicy {
  initialPollDelayMs?: number;
  maxPollDelayMs?: number;
  maxRetryCount?: number;
  timeoutMs?: number;
}

type ResolvedPolicy = Readonly<{
  initialPollDelayMs: number;
  maxPollDelayMs: number;
  maxRetryCount: number;
  timeoutMs: number;
}>;

const DEFAULT_POLICY: ResolvedPolicy = Object.freeze({
  initialPollDelayMs: 1_000,
  maxPollDelayMs: 30_000,
  maxRetryCount: 12,
  timeoutMs: 2 * 60 * 60 * 1000,
});

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function syncError(code: string, message: string): VolcenginePortraitAssetsError {
  return new VolcenginePortraitAssetsError({ code, message });
}

function timestamp(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw syncError("VOLC_PORTRAIT_SYNC_CLOCK_INVALID", `${name}时间无效`);
  }
  return parsed;
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw syncError("VOLC_PORTRAIT_SYNC_POLICY_INVALID", `${name}配置无效`);
  }
  return parsed;
}

function resolvePolicy(policy: VolcenginePortraitAssetSyncPolicy = {}): ResolvedPolicy {
  const resolved = Object.freeze({
    initialPollDelayMs: positiveInteger(
      policy.initialPollDelayMs ?? DEFAULT_POLICY.initialPollDelayMs,
      "首次轮询间隔",
      10 * 60 * 1000,
    ),
    maxPollDelayMs: positiveInteger(
      policy.maxPollDelayMs ?? DEFAULT_POLICY.maxPollDelayMs,
      "最大轮询间隔",
      30 * 60 * 1000,
    ),
    maxRetryCount: positiveInteger(
      policy.maxRetryCount ?? DEFAULT_POLICY.maxRetryCount,
      "最大重试次数",
      100,
    ),
    timeoutMs: positiveInteger(
      policy.timeoutMs ?? DEFAULT_POLICY.timeoutMs,
      "同步超时",
      24 * 60 * 60 * 1000,
    ),
  });
  if (resolved.initialPollDelayMs > resolved.maxPollDelayMs) {
    throw syncError("VOLC_PORTRAIT_SYNC_POLICY_INVALID", "首次轮询间隔不能大于最大轮询间隔");
  }
  return resolved;
}

function sourceSha256(value: unknown): string {
  const digest = cleanString(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw syncError("VOLC_PORTRAIT_SOURCE_DIGEST_INVALID", "素材源文件摘要无效");
  }
  return digest;
}

function idempotencyKey(value: unknown): string {
  const key = cleanString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/.test(key)) {
    throw syncError("VOLC_PORTRAIT_IDEMPOTENCY_INVALID", "幂等键格式无效");
  }
  return key;
}

function sameScope(left: VolcenginePortraitAssetScope, right: VolcenginePortraitAssetScope): boolean {
  return left.channelId === right.channelId
    && left.providerAccountId === right.providerAccountId
    && left.projectName === right.projectName;
}

function assertScope(left: VolcenginePortraitAssetScope, right: VolcenginePortraitAssetScope): void {
  if (!sameScope(left, right)) {
    throw syncError(
      "VOLC_PORTRAIT_SCOPE_MISMATCH",
      "火山人像资产账号、项目或供应商通道不一致",
    );
  }
}

function assertState(record: VolcenginePortraitAssetSyncRecord): void {
  if (!VOLCENGINE_PORTRAIT_ASSET_SYNC_STATES.includes(record.state)) {
    throw syncError("VOLC_PORTRAIT_SYNC_STATE_INVALID", "火山人像资产同步状态无效");
  }
  timestamp(record.createdAt, "创建");
  timestamp(record.updatedAt, "更新");
  timestamp(record.timeoutAt, "超时");
  timestamp(record.nextAttemptAt, "下次尝试");
  if (record.updatedAt < record.createdAt || record.timeoutAt <= record.createdAt) {
    throw syncError("VOLC_PORTRAIT_SYNC_STATE_INVALID", "火山人像资产同步时间线无效");
  }
  if (!Number.isSafeInteger(record.retryCount) || record.retryCount < 0) {
    throw syncError("VOLC_PORTRAIT_SYNC_STATE_INVALID", "火山人像资产重试次数无效");
  }
  sourceSha256(record.sourceSha256);
  idempotencyKey(record.idempotencyKey);
  if (!/^[a-f0-9]{64}$/.test(record.requestHash)) {
    throw syncError("VOLC_PORTRAIT_SYNC_STATE_INVALID", "火山人像资产请求摘要无效");
  }
  if (record.asset) {
    assertScope(record.scope, record.asset.scope);
    if (record.asset.sourceSha256 !== record.sourceSha256) {
      throw syncError("VOLC_PORTRAIT_SYNC_STATE_INVALID", "火山人像资产源摘要不一致");
    }
  }
  if (record.state === "active") {
    if (!record.asset || record.providerAssetUri !== `asset://${record.asset.assetId}` || !record.activeAt) {
      throw syncError("VOLC_PORTRAIT_SYNC_STATE_INVALID", "Active 素材缺少可用的 provider 绑定");
    }
  } else if (record.providerAssetUri !== null || record.activeAt !== null) {
    throw syncError("VOLC_PORTRAIT_SYNC_STATE_INVALID", "非 Active 素材不得暴露 provider URI");
  }
}

function requestFingerprint(input: Omit<VolcenginePortraitAssetSubmitInput, "signal" | "url">): unknown {
  return {
    assetType: input.assetType,
    groupId: input.group.groupId,
    groupType: input.group.groupType,
    idempotencyKey: input.idempotencyKey,
    name: input.name ?? null,
    scope: input.group.scope,
    sourceSha256: input.sourceSha256,
  };
}

function assertReplay(
  record: VolcenginePortraitAssetSyncRecord,
  input: VolcenginePortraitAssetSubmitInput,
): void {
  assertState(record);
  assertScope(record.scope, input.group.scope);
  if (idempotencyKey(input.idempotencyKey) !== record.idempotencyKey) {
    throw syncError("VOLC_PORTRAIT_IDEMPOTENCY_CONFLICT", "同步记录幂等键不一致");
  }
  const incomingHash = hashIdempotencyRequest(requestFingerprint({
    assetType: input.assetType,
    group: input.group,
    idempotencyKey: input.idempotencyKey,
    name: input.name,
    sourceSha256: sourceSha256(input.sourceSha256),
  }));
  if (incomingHash !== record.requestHash) {
    throw syncError("VOLC_PORTRAIT_IDEMPOTENCY_CONFLICT", "相同幂等键已绑定到不同素材请求");
  }
}

function retryDelay(policy: ResolvedPolicy, retryCount: number): number {
  return Math.min(
    policy.maxPollDelayMs,
    policy.initialPollDelayMs * (2 ** Math.max(0, retryCount - 1)),
  );
}

function withFailure(
  record: VolcenginePortraitAssetSyncRecord,
  now: number,
  code: string,
  message: string,
): VolcenginePortraitAssetSyncRecord {
  return Object.freeze({
    ...record,
    activeAt: null,
    nextAttemptAt: now,
    providerAssetUri: null,
    safeErrorCode: code,
    safeErrorMessage: message,
    state: "failed" as const,
    updatedAt: now,
  });
}

function scheduleRetry(
  record: VolcenginePortraitAssetSyncRecord,
  now: number,
  policy: ResolvedPolicy,
  code: string,
): VolcenginePortraitAssetSyncRecord {
  const retryCount = record.retryCount + 1;
  if (now >= record.timeoutAt || retryCount > policy.maxRetryCount) {
    return withFailure(
      record,
      now,
      now >= record.timeoutAt
        ? "VOLC_PORTRAIT_SYNC_TIMEOUT"
        : "VOLC_PORTRAIT_SYNC_RETRY_EXHAUSTED",
      now >= record.timeoutAt ? "素材同步超时" : "素材同步重试次数已用尽",
    );
  }
  return Object.freeze({
    ...record,
    nextAttemptAt: Math.min(record.timeoutAt, now + retryDelay(policy, retryCount)),
    retryCount,
    safeErrorCode: code,
    safeErrorMessage: "上游暂不可用，等待安全重试",
    state: record.asset ? "processing" as const : "queued" as const,
    updatedAt: now,
  });
}

export function createQueuedVolcenginePortraitAssetSync(input: {
  now: number;
  policy?: VolcenginePortraitAssetSyncPolicy;
  request: VolcenginePortraitAssetSubmitInput;
}): VolcenginePortraitAssetSyncRecord {
  const now = timestamp(input.now, "创建");
  const policy = resolvePolicy(input.policy);
  const digest = sourceSha256(input.request.sourceSha256);
  const key = idempotencyKey(input.request.idempotencyKey);
  const requestHash = hashIdempotencyRequest(requestFingerprint({
    assetType: input.request.assetType,
    group: input.request.group,
    idempotencyKey: key,
    name: input.request.name,
    sourceSha256: digest,
  }));
  return Object.freeze({
    activeAt: null,
    asset: null,
    createdAt: now,
    idempotencyKey: key,
    nextAttemptAt: now,
    providerAssetUri: null,
    requestHash,
    retryCount: 0,
    safeErrorCode: null,
    safeErrorMessage: null,
    scope: Object.freeze({ ...input.request.group.scope }),
    sourceSha256: digest,
    state: "queued",
    timeoutAt: now + policy.timeoutMs,
    updatedAt: now,
  });
}

/** Persist this transition before starting the non-idempotent provider POST. */
export function markVolcenginePortraitAssetSubmitting(input: {
  now: number;
  record: VolcenginePortraitAssetSyncRecord;
  request: VolcenginePortraitAssetSubmitInput;
}): VolcenginePortraitAssetSyncRecord {
  assertReplay(input.record, input.request);
  const now = timestamp(input.now, "更新");
  if (input.record.state !== "queued") {
    throw syncError("VOLC_PORTRAIT_SYNC_TRANSITION_INVALID", "只有 Queued 素材可以进入 Submitting");
  }
  if (now < input.record.nextAttemptAt) {
    throw syncError("VOLC_PORTRAIT_SYNC_NOT_DUE", "素材尚未到提交时间");
  }
  if (now >= input.record.timeoutAt) {
    return withFailure(input.record, now, "VOLC_PORTRAIT_SYNC_TIMEOUT", "素材同步超时");
  }
  return Object.freeze({
    ...input.record,
    safeErrorCode: null,
    safeErrorMessage: null,
    state: "submitting",
    updatedAt: now,
  });
}

/** Persist the returned provider id before scheduling the first status poll. */
export function applyVolcenginePortraitAssetSubmitted(input: {
  asset: VolcenginePortraitAssetRef;
  now: number;
  policy?: VolcenginePortraitAssetSyncPolicy;
  record: VolcenginePortraitAssetSyncRecord;
}): VolcenginePortraitAssetSyncRecord {
  assertState(input.record);
  const now = timestamp(input.now, "更新");
  const policy = resolvePolicy(input.policy);
  if (input.record.state !== "submitting") {
    throw syncError("VOLC_PORTRAIT_SYNC_TRANSITION_INVALID", "只有 Submitting 素材可以登记 provider ID");
  }
  assertScope(input.record.scope, input.asset.scope);
  if (
    input.asset.sourceSha256 !== input.record.sourceSha256
    || input.asset.idempotencyKey !== input.record.idempotencyKey
  ) {
    throw syncError("VOLC_PORTRAIT_SCOPE_MISMATCH", "创建结果与素材源或幂等请求不一致");
  }
  return Object.freeze({
    ...input.record,
    asset: input.asset,
    nextAttemptAt: Math.min(input.record.timeoutAt, now + policy.initialPollDelayMs),
    retryCount: 0,
    safeErrorCode: null,
    safeErrorMessage: null,
    state: "processing",
    updatedAt: now,
  });
}

export function applyVolcenginePortraitAssetSubmitFailure(input: {
  error: VolcenginePortraitAssetsError;
  now: number;
  policy?: VolcenginePortraitAssetSyncPolicy;
  record: VolcenginePortraitAssetSyncRecord;
}): VolcenginePortraitAssetSyncRecord {
  assertState(input.record);
  const now = timestamp(input.now, "更新");
  const policy = resolvePolicy(input.policy);
  if (input.record.state !== "submitting") {
    throw syncError("VOLC_PORTRAIT_SYNC_TRANSITION_INVALID", "只有 Submitting 素材可以登记提交失败");
  }
  if (input.error.code === "VOLC_PORTRAIT_OUTCOME_UNKNOWN" || input.error.dispatchState === "outcome_unknown") {
    return withFailure(
      input.record,
      now,
      "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
      "上游创建结果不确定，需要人工核对",
    );
  }
  if (input.error.retryable && input.error.dispatchState === "not_dispatched") {
    return scheduleRetry(input.record, now, policy, input.error.code);
  }
  return withFailure(input.record, now, input.error.code,
    portraitRegistrationFailureMessage(input.error.code) ?? "素材提交失败");
}

export function markVolcenginePortraitAssetSyncStale(input: {
  now: number;
  record: VolcenginePortraitAssetSyncRecord;
}): VolcenginePortraitAssetSyncRecord {
  assertState(input.record);
  const now = timestamp(input.now, "更新");
  if (input.record.state !== "active") {
    throw syncError("VOLC_PORTRAIT_SYNC_TRANSITION_INVALID", "只有 Active 素材可标记为 Stale");
  }
  return Object.freeze({
    ...input.record,
    activeAt: null,
    nextAttemptAt: now,
    providerAssetUri: null,
    safeErrorCode: "VOLC_PORTRAIT_ASSET_STALE",
    safeErrorMessage: "上游素材绑定已失效，需要重建",
    state: "stale",
    updatedAt: now,
  });
}

export function revokeVolcenginePortraitAssetSync(input: {
  now: number;
  record: VolcenginePortraitAssetSyncRecord;
}): VolcenginePortraitAssetSyncRecord {
  assertState(input.record);
  const now = timestamp(input.now, "更新");
  if (input.record.state === "revoked") return input.record;
  return Object.freeze({
    ...input.record,
    activeAt: null,
    nextAttemptAt: now,
    providerAssetUri: null,
    safeErrorCode: "VOLC_PORTRAIT_ASSET_REVOKED",
    safeErrorMessage: "素材授权已撤销",
    state: "revoked",
    updatedAt: now,
  });
}

export function requeueVolcenginePortraitAssetSync(input: {
  now: number;
  record: VolcenginePortraitAssetSyncRecord;
}): VolcenginePortraitAssetSyncRecord {
  assertState(input.record);
  const now = timestamp(input.now, "更新");
  if (input.record.state !== "failed" && input.record.state !== "stale") {
    throw syncError("VOLC_PORTRAIT_SYNC_TRANSITION_INVALID", "只有 Failed 或 Stale 素材可重新排队");
  }
  if (input.record.safeErrorCode === "VOLC_PORTRAIT_OUTCOME_UNKNOWN") {
    throw syncError(
      "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
      "上游创建结果不确定，必须人工核对后才能重新提交",
    );
  }
  return Object.freeze({
    ...input.record,
    asset: null,
    nextAttemptAt: now,
    retryCount: 0,
    safeErrorCode: null,
    safeErrorMessage: null,
    state: "queued",
    updatedAt: now,
  });
}

export function applyVolcenginePortraitAssetObservation(input: {
  now: number;
  observation: VolcenginePortraitAsset;
  policy?: VolcenginePortraitAssetSyncPolicy;
  record: VolcenginePortraitAssetSyncRecord;
}): VolcenginePortraitAssetSyncRecord {
  assertState(input.record);
  const now = timestamp(input.now, "更新");
  const policy = resolvePolicy(input.policy);
  if (!input.record.asset || (input.record.state !== "processing" && input.record.state !== "submitting")) {
    throw syncError("VOLC_PORTRAIT_SYNC_TRANSITION_INVALID", "当前状态不能接收素材轮询结果");
  }
  assertScope(input.record.scope, input.observation.scope);
  if (
    input.observation.assetId !== input.record.asset.assetId
    || input.observation.group.groupId !== input.record.asset.group.groupId
  ) {
    throw syncError("VOLC_PORTRAIT_SCOPE_MISMATCH", "轮询结果与素材绑定不一致");
  }
  if (input.observation.status === "Active") {
    return Object.freeze({
      ...input.record,
      activeAt: now,
      nextAttemptAt: now,
      providerAssetUri: `asset://${input.record.asset.assetId}`,
      safeErrorCode: null,
      safeErrorMessage: null,
      state: "active",
      updatedAt: now,
    });
  }
  if (input.observation.status === "Failed") {
    return withFailure(
      input.record,
      now,
      input.observation.error?.code ?? "VOLC_PORTRAIT_ASSET_FAILED",
      portraitRegistrationFailureMessage(input.observation.error?.code) ?? "上游素材处理失败",
    );
  }
  return scheduleRetry(input.record, now, policy, "VOLC_PORTRAIT_ASSET_PROCESSING");
}

export async function submitVolcenginePortraitAssetSync(input: {
  client: VolcenginePortraitAssetsClient;
  now?: () => number;
  policy?: VolcenginePortraitAssetSyncPolicy;
  record: VolcenginePortraitAssetSyncRecord;
  request: VolcenginePortraitAssetSubmitInput;
}): Promise<VolcenginePortraitAssetSyncResult> {
  assertReplay(input.record, input.request);
  assertScope(input.client.scope, input.record.scope);
  const now = input.now ?? (() => Date.now());
  const at = timestamp(now(), "更新");
  const policy = resolvePolicy(input.policy);
  if (input.record.state === "active") return Object.freeze({ outcome: "active", record: input.record });
  if (input.record.state === "failed" || input.record.state === "revoked") {
    return Object.freeze({ outcome: "failed", record: input.record });
  }
  if (input.record.state !== "queued" && input.record.state !== "submitting") {
    throw syncError("VOLC_PORTRAIT_SYNC_TRANSITION_INVALID", "当前状态不能提交素材");
  }
  if (input.record.state === "queued" && at < input.record.nextAttemptAt) {
    return Object.freeze({ outcome: "not_due", record: input.record });
  }
  if (at >= input.record.timeoutAt) {
    return Object.freeze({
      outcome: "failed",
      record: withFailure(input.record, at, "VOLC_PORTRAIT_SYNC_TIMEOUT", "素材同步超时"),
    });
  }
  const submitting = input.record.state === "submitting"
    ? input.record
    : markVolcenginePortraitAssetSubmitting({
      now: at,
      record: input.record,
      request: input.request,
    });
  try {
    const asset = await input.client.createAsset(input.request);
    const completedAt = timestamp(now(), "更新");
    return Object.freeze({
      outcome: "submitted",
      record: applyVolcenginePortraitAssetSubmitted({
        asset,
        now: completedAt,
        policy,
        record: submitting,
      }),
    });
  } catch (caught) {
    const failedAt = timestamp(now(), "更新");
    const error = caught instanceof VolcenginePortraitAssetsError
      ? caught
      : syncError("VOLC_PORTRAIT_REQUEST_FAILED", "火山人像资产请求失败");
    const record = applyVolcenginePortraitAssetSubmitFailure({
      error,
      now: failedAt,
      policy,
      record: submitting,
    });
    return Object.freeze({
      outcome: record.state === "failed" ? "failed" : "processing",
      record,
    });
  }
}

export async function pollVolcenginePortraitAssetSync(input: {
  client: VolcenginePortraitAssetsClient;
  now?: () => number;
  policy?: VolcenginePortraitAssetSyncPolicy;
  record: VolcenginePortraitAssetSyncRecord;
  signal?: AbortSignal;
}): Promise<VolcenginePortraitAssetSyncResult> {
  assertState(input.record);
  assertScope(input.client.scope, input.record.scope);
  const now = input.now ?? (() => Date.now());
  const at = timestamp(now(), "更新");
  const policy = resolvePolicy(input.policy);
  if (input.record.state === "active") return Object.freeze({ outcome: "active", record: input.record });
  if (input.record.state === "failed" || input.record.state === "revoked") {
    return Object.freeze({ outcome: "failed", record: input.record });
  }
  if (input.record.state !== "processing" || !input.record.asset) {
    throw syncError("VOLC_PORTRAIT_SYNC_TRANSITION_INVALID", "当前状态不能轮询素材");
  }
  if (at < input.record.nextAttemptAt) return Object.freeze({ outcome: "not_due", record: input.record });
  if (at >= input.record.timeoutAt) {
    return Object.freeze({
      outcome: "failed",
      record: withFailure(input.record, at, "VOLC_PORTRAIT_SYNC_TIMEOUT", "素材同步超时"),
    });
  }
  try {
    const observation = await input.client.getAsset({
      asset: input.record.asset,
      signal: input.signal,
    });
    const record = applyVolcenginePortraitAssetObservation({
      now: timestamp(now(), "更新"),
      observation,
      policy,
      record: input.record,
    });
    return Object.freeze({
      outcome: record.state === "active"
        ? "active"
        : record.state === "failed"
          ? "failed"
          : "processing",
      record,
    });
  } catch (caught) {
    const failedAt = timestamp(now(), "更新");
    const error = caught instanceof VolcenginePortraitAssetsError
      ? caught
      : syncError("VOLC_PORTRAIT_REQUEST_FAILED", "火山人像资产请求失败");
    if (error.retryable) {
      const record = scheduleRetry(input.record, failedAt, policy, error.code);
      return Object.freeze({
        outcome: record.state === "failed" ? "failed" : "processing",
        record,
      });
    }
    return Object.freeze({
      outcome: "failed",
      record: withFailure(input.record, failedAt, error.code, "素材状态查询失败"),
    });
  }
}
