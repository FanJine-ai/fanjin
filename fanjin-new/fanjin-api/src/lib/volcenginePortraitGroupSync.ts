import { createHash } from "node:crypto";

import {
  VolcenginePortraitAssetsClient,
  VolcenginePortraitAssetsError,
  parseVolcengineVisualValidateCallback,
  type VolcenginePortraitAssetGroupRef,
  type VolcenginePortraitAssetGroupType,
  type VolcenginePortraitAssetScope,
  type VolcengineVisualValidateCallback,
  type VolcengineVisualValidateSession,
} from "@/lib/volcenginePortraitAssets";

export const VOLCENGINE_PORTRAIT_GROUP_SYNC_STATES = [
  "queued",
  "authorizing",
  "creating",
  "active",
  "failed",
  "stale",
  "revoked",
] as const;

export const VOLCENGINE_PORTRAIT_AUTH_SESSION_STATES = [
  "created",
  "waiting_user",
  "verifying",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
] as const;

export type VolcenginePortraitGroupSyncStatus =
  (typeof VOLCENGINE_PORTRAIT_GROUP_SYNC_STATES)[number];
export type VolcenginePortraitAuthSessionStatus =
  (typeof VOLCENGINE_PORTRAIT_AUTH_SESSION_STATES)[number];

export type VolcenginePortraitGroupSyncRecord = Readonly<{
  activeAt: number | null;
  createdAt: number;
  group: VolcenginePortraitAssetGroupRef | null;
  groupType: VolcenginePortraitAssetGroupType;
  idempotencyKey: string;
  nextAttemptAt: number;
  retryCount: number;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  scope: VolcenginePortraitAssetScope;
  state: VolcenginePortraitGroupSyncStatus;
  updatedAt: number;
}>;

/**
 * This mirrors o_portrait_auth_session without retaining the raw BytedToken or
 * H5Link. The callback supplies the short-lived token again; only its digest
 * and the callback nonce digest need durable storage.
 */
export type VolcenginePortraitAuthSessionSyncRecord = Readonly<{
  bytedTokenDigest: string | null;
  callbackNonceHash: string;
  consumedAt: number | null;
  createdAt: number;
  expiresAt: number;
  providerSessionId: string | null;
  resultReceivedAt: number | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  scope: VolcenginePortraitAssetScope;
  state: VolcenginePortraitAuthSessionStatus;
  updatedAt: number;
}>;

export type VolcenginePortraitLivenessAuthorizationStart = Readonly<{
  auth: VolcenginePortraitAuthSessionSyncRecord;
  group: VolcenginePortraitGroupSyncRecord;
  session: VolcengineVisualValidateSession;
}>;

export type VolcenginePortraitLivenessAuthorizationResult = Readonly<{
  auth: VolcenginePortraitAuthSessionSyncRecord;
  callback: VolcengineVisualValidateCallback;
  group: VolcenginePortraitGroupSyncRecord;
}>;

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function error(code: string, message: string): VolcenginePortraitAssetsError {
  return new VolcenginePortraitAssetsError({ code, message });
}

function nowValue(value: unknown): number {
  const now = Number(value);
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw error("VOLC_PORTRAIT_SYNC_CLOCK_INVALID", "火山人像状态机时钟无效");
  }
  return now;
}

function keyValue(value: unknown): string {
  const key = cleanString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/.test(key)) {
    throw error("VOLC_PORTRAIT_IDEMPOTENCY_INVALID", "火山人像素材组幂等键无效");
  }
  return key;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestValue(value: unknown, name: string): string {
  const hash = cleanString(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw error("VOLC_PORTRAIT_AUTH_RECORD_INVALID", `${name}摘要无效`);
  }
  return hash;
}

function sameScope(left: VolcenginePortraitAssetScope, right: VolcenginePortraitAssetScope): boolean {
  return left.channelId === right.channelId
    && left.providerAccountId === right.providerAccountId
    && left.projectName === right.projectName;
}

function assertScope(left: VolcenginePortraitAssetScope, right: VolcenginePortraitAssetScope): void {
  if (!sameScope(left, right)) {
    throw error(
      "VOLC_PORTRAIT_SCOPE_MISMATCH",
      "火山人像资产账号、项目或供应商通道不一致",
    );
  }
}

function assertGroupRecord(record: VolcenginePortraitGroupSyncRecord): void {
  if (!VOLCENGINE_PORTRAIT_GROUP_SYNC_STATES.includes(record.state)) {
    throw error("VOLC_PORTRAIT_GROUP_STATE_INVALID", "火山人像素材组状态无效");
  }
  nowValue(record.createdAt);
  nowValue(record.updatedAt);
  nowValue(record.nextAttemptAt);
  keyValue(record.idempotencyKey);
  if (!Number.isSafeInteger(record.retryCount) || record.retryCount < 0) {
    throw error("VOLC_PORTRAIT_GROUP_STATE_INVALID", "火山人像素材组重试次数无效");
  }
  if (record.group) {
    assertScope(record.scope, record.group.scope);
    if (record.group.groupType !== record.groupType) {
      throw error("VOLC_PORTRAIT_GROUP_STATE_INVALID", "火山人像素材组类型不一致");
    }
  }
  if (record.state === "active") {
    if (!record.group || !record.activeAt) {
      throw error("VOLC_PORTRAIT_GROUP_STATE_INVALID", "Active 素材组缺少 provider 绑定");
    }
  } else if (record.activeAt !== null) {
    throw error("VOLC_PORTRAIT_GROUP_STATE_INVALID", "非 Active 素材组不得包含 activeAt");
  }
}

function assertAuthRecord(record: VolcenginePortraitAuthSessionSyncRecord): void {
  if (!VOLCENGINE_PORTRAIT_AUTH_SESSION_STATES.includes(record.state)) {
    throw error("VOLC_PORTRAIT_AUTH_STATE_INVALID", "火山真人认证会话状态无效");
  }
  nowValue(record.createdAt);
  nowValue(record.updatedAt);
  nowValue(record.expiresAt);
  if (record.expiresAt <= record.createdAt) {
    throw error("VOLC_PORTRAIT_AUTH_STATE_INVALID", "真人认证会话有效期无效");
  }
  digestValue(record.callbackNonceHash, "回调 nonce");
  if (record.bytedTokenDigest !== null) digestValue(record.bytedTokenDigest, "BytedToken");
  if (record.state === "succeeded") {
    if (!record.consumedAt || !record.resultReceivedAt || !record.bytedTokenDigest) {
      throw error("VOLC_PORTRAIT_AUTH_STATE_INVALID", "成功的真人认证会话缺少完成证据");
    }
  }
}

function groupFailure(
  record: VolcenginePortraitGroupSyncRecord,
  now: number,
  code: string,
  message: string,
): VolcenginePortraitGroupSyncRecord {
  return Object.freeze({
    ...record,
    activeAt: null,
    nextAttemptAt: now,
    safeErrorCode: code,
    safeErrorMessage: message,
    state: "failed",
    updatedAt: now,
  });
}

function authFailure(
  record: VolcenginePortraitAuthSessionSyncRecord,
  now: number,
  code: string,
  message: string,
): VolcenginePortraitAuthSessionSyncRecord {
  return Object.freeze({
    ...record,
    safeErrorCode: code,
    safeErrorMessage: message,
    state: "failed",
    updatedAt: now,
  });
}

export function createQueuedVolcenginePortraitGroupSync(input: {
  groupType: VolcenginePortraitAssetGroupType;
  idempotencyKey: string;
  now: number;
  scope: VolcenginePortraitAssetScope;
}): VolcenginePortraitGroupSyncRecord {
  const now = nowValue(input.now);
  if (input.groupType !== "AIGC" && input.groupType !== "LivenessFace") {
    throw error("VOLC_PORTRAIT_GROUP_TYPE_INVALID", "火山人像素材组类型无效");
  }
  return Object.freeze({
    activeAt: null,
    createdAt: now,
    group: null,
    groupType: input.groupType,
    idempotencyKey: keyValue(input.idempotencyKey),
    nextAttemptAt: now,
    retryCount: 0,
    safeErrorCode: null,
    safeErrorMessage: null,
    scope: Object.freeze({ ...input.scope }),
    state: "queued",
    updatedAt: now,
  });
}

export function markVolcenginePortraitGroupCreating(input: {
  now: number;
  record: VolcenginePortraitGroupSyncRecord;
}): VolcenginePortraitGroupSyncRecord {
  assertGroupRecord(input.record);
  const now = nowValue(input.now);
  if (input.record.groupType !== "AIGC" || input.record.state !== "queued") {
    throw error("VOLC_PORTRAIT_GROUP_TRANSITION_INVALID", "只有 Queued AIGC 素材组可以进入 Creating");
  }
  return Object.freeze({
    ...input.record,
    safeErrorCode: null,
    safeErrorMessage: null,
    state: "creating",
    updatedAt: now,
  });
}

export function markVolcenginePortraitGroupAuthorizing(input: {
  now: number;
  record: VolcenginePortraitGroupSyncRecord;
}): VolcenginePortraitGroupSyncRecord {
  assertGroupRecord(input.record);
  const now = nowValue(input.now);
  if (input.record.groupType !== "LivenessFace" || input.record.state !== "queued") {
    throw error(
      "VOLC_PORTRAIT_GROUP_TRANSITION_INVALID",
      "只有 Queued LivenessFace 素材组可以进入 Authorizing",
    );
  }
  return Object.freeze({
    ...input.record,
    safeErrorCode: null,
    safeErrorMessage: null,
    state: "authorizing",
    updatedAt: now,
  });
}

export function applyVolcenginePortraitGroupActive(input: {
  group: VolcenginePortraitAssetGroupRef;
  now: number;
  record: VolcenginePortraitGroupSyncRecord;
}): VolcenginePortraitGroupSyncRecord {
  assertGroupRecord(input.record);
  const now = nowValue(input.now);
  const expectedState = input.record.groupType === "AIGC" ? "creating" : "authorizing";
  if (input.record.state !== expectedState || input.group.groupType !== input.record.groupType) {
    throw error("VOLC_PORTRAIT_GROUP_TRANSITION_INVALID", "素材组创建结果与状态或类型不一致");
  }
  assertScope(input.record.scope, input.group.scope);
  return Object.freeze({
    ...input.record,
    activeAt: now,
    group: input.group,
    nextAttemptAt: now,
    safeErrorCode: null,
    safeErrorMessage: null,
    state: "active",
    updatedAt: now,
  });
}

export function markVolcenginePortraitGroupStale(input: {
  now: number;
  record: VolcenginePortraitGroupSyncRecord;
}): VolcenginePortraitGroupSyncRecord {
  assertGroupRecord(input.record);
  const now = nowValue(input.now);
  if (input.record.state !== "active") {
    throw error("VOLC_PORTRAIT_GROUP_TRANSITION_INVALID", "只有 Active 素材组可以标记为 Stale");
  }
  return Object.freeze({
    ...input.record,
    activeAt: null,
    nextAttemptAt: now,
    safeErrorCode: "VOLC_PORTRAIT_GROUP_STALE",
    safeErrorMessage: "上游素材组绑定已失效",
    state: "stale",
    updatedAt: now,
  });
}

export function revokeVolcenginePortraitGroup(input: {
  now: number;
  record: VolcenginePortraitGroupSyncRecord;
}): VolcenginePortraitGroupSyncRecord {
  assertGroupRecord(input.record);
  const now = nowValue(input.now);
  if (input.record.state === "revoked") return input.record;
  return Object.freeze({
    ...input.record,
    activeAt: null,
    nextAttemptAt: now,
    safeErrorCode: "VOLC_PORTRAIT_GROUP_REVOKED",
    safeErrorMessage: "人像素材组授权已撤销",
    state: "revoked",
    updatedAt: now,
  });
}

export function createVolcenginePortraitAuthSessionRecord(input: {
  callbackNonce: string;
  expiresAt: number;
  now: number;
  scope: VolcenginePortraitAssetScope;
}): VolcenginePortraitAuthSessionSyncRecord {
  const now = nowValue(input.now);
  const expiresAt = nowValue(input.expiresAt);
  const callbackNonce = cleanString(input.callbackNonce);
  if (!/^[A-Za-z0-9._~-]{16,256}$/.test(callbackNonce)) {
    throw error("VOLC_PORTRAIT_CALLBACK_NONCE_INVALID", "真人认证回调 nonce 无效");
  }
  if (expiresAt <= now) {
    throw error("VOLC_PORTRAIT_AUTH_STATE_INVALID", "真人认证会话有效期无效");
  }
  return Object.freeze({
    bytedTokenDigest: null,
    callbackNonceHash: digest(callbackNonce),
    consumedAt: null,
    createdAt: now,
    expiresAt,
    providerSessionId: null,
    resultReceivedAt: null,
    safeErrorCode: null,
    safeErrorMessage: null,
    scope: Object.freeze({ ...input.scope }),
    state: "created",
    updatedAt: now,
  });
}

export function applyVolcenginePortraitAuthSessionCreated(input: {
  now: number;
  record: VolcenginePortraitAuthSessionSyncRecord;
  session: VolcengineVisualValidateSession;
}): VolcenginePortraitAuthSessionSyncRecord {
  assertAuthRecord(input.record);
  const now = nowValue(input.now);
  if (input.record.state !== "created") {
    throw error("VOLC_PORTRAIT_AUTH_TRANSITION_INVALID", "只有 Created 会话可以等待用户认证");
  }
  assertScope(input.record.scope, input.session.scope);
  if (input.session.expiresAt !== input.record.expiresAt || now >= input.record.expiresAt) {
    throw error("VOLC_PORTRAIT_AUTH_STATE_INVALID", "真人认证令牌有效期与会话不一致");
  }
  return Object.freeze({
    ...input.record,
    bytedTokenDigest: digest(input.session.bytedToken),
    safeErrorCode: null,
    safeErrorMessage: null,
    state: "waiting_user",
    updatedAt: now,
  });
}

export function applyVolcenginePortraitAuthCallback(input: {
  callbackNonce: string;
  callbackUrl: string;
  now: number;
  record: VolcenginePortraitAuthSessionSyncRecord;
  session: VolcengineVisualValidateSession;
}): Readonly<{
  callback: VolcengineVisualValidateCallback;
  record: VolcenginePortraitAuthSessionSyncRecord;
}> {
  assertAuthRecord(input.record);
  const now = nowValue(input.now);
  if (input.record.state !== "waiting_user") {
    throw error("VOLC_PORTRAIT_AUTH_TRANSITION_INVALID", "当前会话不能接收真人认证回调");
  }
  if (now >= input.record.expiresAt) {
    return Object.freeze({
      callback: Object.freeze({
        algorithmBaseRespCode: null,
        bytedToken: "",
        reqMeasureInfoValue: null,
        resultCode: "expired",
        status: "failed",
        verifyType: null,
      }),
      record: Object.freeze({
        ...input.record,
        safeErrorCode: "VOLC_PORTRAIT_BYTED_TOKEN_EXPIRED",
        safeErrorMessage: "真人认证会话已过期",
        state: "expired",
        updatedAt: now,
      }),
    });
  }
  assertScope(input.record.scope, input.session.scope);
  if (
    digest(cleanString(input.callbackNonce)) !== input.record.callbackNonceHash
    || digest(input.session.bytedToken) !== input.record.bytedTokenDigest
  ) {
    throw error("VOLC_PORTRAIT_CALLBACK_TOKEN_MISMATCH", "真人认证回调证据与会话不一致");
  }
  const callback = parseVolcengineVisualValidateCallback({
    callbackUrl: input.callbackUrl,
    now,
    session: input.session,
  });
  if (callback.status === "failed") {
    return Object.freeze({
      callback,
      record: authFailure(
        input.record,
        now,
        "VOLC_PORTRAIT_VISUAL_VALIDATE_FAILED",
        "真人认证未通过",
      ),
    });
  }
  return Object.freeze({
    callback,
    record: Object.freeze({
      ...input.record,
      safeErrorCode: null,
      safeErrorMessage: null,
      state: "verifying",
      updatedAt: now,
    }),
  });
}

export function applyVolcenginePortraitAuthSucceeded(input: {
  group: VolcenginePortraitAssetGroupRef;
  now: number;
  record: VolcenginePortraitAuthSessionSyncRecord;
}): VolcenginePortraitAuthSessionSyncRecord {
  assertAuthRecord(input.record);
  const now = nowValue(input.now);
  if (input.record.state !== "verifying" || input.group.groupType !== "LivenessFace") {
    throw error("VOLC_PORTRAIT_AUTH_TRANSITION_INVALID", "真人认证结果与会话状态不一致");
  }
  assertScope(input.record.scope, input.group.scope);
  return Object.freeze({
    ...input.record,
    consumedAt: now,
    resultReceivedAt: now,
    safeErrorCode: null,
    safeErrorMessage: null,
    state: "succeeded",
    updatedAt: now,
  });
}

export function cancelVolcenginePortraitAuthSession(input: {
  now: number;
  record: VolcenginePortraitAuthSessionSyncRecord;
}): VolcenginePortraitAuthSessionSyncRecord {
  assertAuthRecord(input.record);
  const now = nowValue(input.now);
  if (["succeeded", "failed", "expired", "cancelled"].includes(input.record.state)) {
    return input.record;
  }
  return Object.freeze({
    ...input.record,
    safeErrorCode: "VOLC_PORTRAIT_AUTH_CANCELLED",
    safeErrorMessage: "真人认证已取消",
    state: "cancelled",
    updatedAt: now,
  });
}

export async function createVolcengineAigcPortraitGroup(input: {
  client: VolcenginePortraitAssetsClient;
  description?: string;
  name: string;
  now?: () => number;
  record: VolcenginePortraitGroupSyncRecord;
  signal?: AbortSignal;
}): Promise<VolcenginePortraitGroupSyncRecord> {
  assertGroupRecord(input.record);
  assertScope(input.client.scope, input.record.scope);
  const clock = input.now ?? (() => Date.now());
  const creating = input.record.state === "creating"
    ? input.record
    : markVolcenginePortraitGroupCreating({ now: nowValue(clock()), record: input.record });
  try {
    const group = await input.client.createAigcAssetGroup({
      description: input.description,
      idempotencyKey: creating.idempotencyKey,
      name: input.name,
      signal: input.signal,
    });
    return applyVolcenginePortraitGroupActive({
      group,
      now: nowValue(clock()),
      record: creating,
    });
  } catch (caught) {
    const failure = caught instanceof VolcenginePortraitAssetsError
      ? caught
      : error("VOLC_PORTRAIT_REQUEST_FAILED", "火山素材组创建失败");
    return groupFailure(
      creating,
      nowValue(clock()),
      failure.code === "VOLC_PORTRAIT_OUTCOME_UNKNOWN" || failure.dispatchState === "outcome_unknown"
        ? "VOLC_PORTRAIT_OUTCOME_UNKNOWN"
        : failure.code,
      failure.dispatchState === "outcome_unknown"
        ? "上游创建结果不确定，需要人工核对"
        : "火山素材组创建失败",
    );
  }
}

export async function startVolcengineLivenessAuthorization(input: {
  auth: VolcenginePortraitAuthSessionSyncRecord;
  callbackUrl: string;
  client: VolcenginePortraitAssetsClient;
  group: VolcenginePortraitGroupSyncRecord;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<VolcenginePortraitLivenessAuthorizationStart> {
  assertGroupRecord(input.group);
  assertAuthRecord(input.auth);
  assertScope(input.client.scope, input.group.scope);
  assertScope(input.client.scope, input.auth.scope);
  const clock = input.now ?? (() => Date.now());
  const group = input.group.state === "authorizing"
    ? input.group
    : markVolcenginePortraitGroupAuthorizing({ now: nowValue(clock()), record: input.group });
  if (input.auth.state !== "created") {
    throw error("VOLC_PORTRAIT_AUTH_TRANSITION_INVALID", "当前认证会话不能拉起 H5");
  }
  const session = await input.client.createVisualValidateSession({
    callbackUrl: input.callbackUrl,
    idempotencyKey: group.idempotencyKey,
    signal: input.signal,
  });
  const auth = applyVolcenginePortraitAuthSessionCreated({
    now: nowValue(clock()),
    record: input.auth,
    session,
  });
  return Object.freeze({ auth, group, session });
}

export async function completeVolcengineLivenessAuthorization(input: {
  auth: VolcenginePortraitAuthSessionSyncRecord;
  callbackNonce: string;
  callbackUrl: string;
  client: VolcenginePortraitAssetsClient;
  group: VolcenginePortraitGroupSyncRecord;
  now?: () => number;
  session: VolcengineVisualValidateSession;
  signal?: AbortSignal;
}): Promise<VolcenginePortraitLivenessAuthorizationResult> {
  assertGroupRecord(input.group);
  assertAuthRecord(input.auth);
  assertScope(input.client.scope, input.group.scope);
  assertScope(input.client.scope, input.auth.scope);
  if (input.group.state !== "authorizing" || input.group.groupType !== "LivenessFace") {
    throw error("VOLC_PORTRAIT_GROUP_TRANSITION_INVALID", "当前素材组不能完成真人认证");
  }
  const clock = input.now ?? (() => Date.now());
  const callbackResult = applyVolcenginePortraitAuthCallback({
    callbackNonce: input.callbackNonce,
    callbackUrl: input.callbackUrl,
    now: nowValue(clock()),
    record: input.auth,
    session: input.session,
  });
  if (callbackResult.record.state !== "verifying") {
    return Object.freeze({
      auth: callbackResult.record,
      callback: callbackResult.callback,
      group: groupFailure(
        input.group,
        nowValue(clock()),
        callbackResult.record.safeErrorCode ?? "VOLC_PORTRAIT_VISUAL_VALIDATE_FAILED",
        "真人认证未通过",
      ),
    });
  }
  try {
    const providerGroup = await input.client.getVisualValidateResult({
      session: input.session,
      signal: input.signal,
    });
    const now = nowValue(clock());
    return Object.freeze({
      auth: applyVolcenginePortraitAuthSucceeded({
        group: providerGroup,
        now,
        record: callbackResult.record,
      }),
      callback: callbackResult.callback,
      group: applyVolcenginePortraitGroupActive({
        group: providerGroup,
        now,
        record: input.group,
      }),
    });
  } catch (caught) {
    const failure = caught instanceof VolcenginePortraitAssetsError
      ? caught
      : error("VOLC_PORTRAIT_REQUEST_FAILED", "真人认证结果查询失败");
    const now = nowValue(clock());
    return Object.freeze({
      auth: authFailure(callbackResult.record, now, failure.code, "真人认证结果查询失败"),
      callback: callbackResult.callback,
      group: groupFailure(input.group, now, failure.code, "真人认证结果查询失败"),
    });
  }
}

export function volcenginePortraitCallbackNonceHash(callbackNonce: string): string {
  const nonce = cleanString(callbackNonce);
  if (!/^[A-Za-z0-9._~-]{16,256}$/.test(nonce)) {
    throw error("VOLC_PORTRAIT_CALLBACK_NONCE_INVALID", "真人认证回调 nonce 无效");
  }
  return digest(nonce);
}

export function volcenginePortraitBytedTokenDigest(bytedToken: string): string {
  const token = cleanString(bytedToken);
  if (!token || token.length > 4_096 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw error("VOLC_PORTRAIT_BYTED_TOKEN_INVALID", "真人认证令牌无效");
  }
  return digest(token);
}
