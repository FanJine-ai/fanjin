import { portraitRegistrationFailureMessage } from "@/lib/portraitRegistrationFailure";
import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { parsePortraitAssetRelayRequest } from "@/lib/portraitAssetRelayContract";
import {
  FormalCandidateCredentialRuntimeError,
} from "@/lib/formalCandidateCredentialRuntime";
import {
  FormalCandidateCredentialCapabilityError,
} from "@/lib/formalCandidateCredentialCapability";
import {
  resolvePortraitChannelCredential,
  type RelayChannelCredentialInput,
} from "@/lib/relayChannelCredential";
import { isTokenhexPortraitOrigin } from "@/lib/tokenhexPortraitChannel";
import { parseProviderChannelPortraitCredential, TOKENHEX_PORTRAIT_CREDENTIAL_VERSION, TOKENHEX_PORTRAIT_ORIGIN, type TokenhexPortraitCredential } from "@/lib/providerChannelCredentials";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  signVolcengineV4JsonPost,
  type VolcengineV4SignResult,
} from "@/lib/volcengineV4";

const ARK_HOST = "ark.cn-beijing.volcengineapi.com";
const ARK_REGION = "cn-beijing";
const ARK_SERVICE = "ark";
const ARK_VERSION = "2024-01-01";
const ARK_PATHNAME = "/";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_READ_ATTEMPTS = 3;
const MAX_READ_ATTEMPTS = 5;
const VISUAL_VALIDATE_TOKEN_TTL_MS = 30 * 60 * 1000;

const ARK_ACTIONS = [
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
] as const;

const ARK_READ_ACTIONS = new Set<VolcenginePortraitArkAction>([
  "GetAssetGroup",
  "ListAssetGroups",
  "GetVisualValidateResult",
  "GetAsset",
  "ListAssets",
]);

const ASSET_TYPES = ["Image", "Video", "Audio"] as const;
const ASSET_STATUSES = ["Processing", "Active", "Failed"] as const;
const GROUP_TYPES = ["AIGC", "LivenessFace"] as const;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type VolcenginePortraitArkAction = (typeof ARK_ACTIONS)[number];
export type VolcenginePortraitAssetType = (typeof ASSET_TYPES)[number];
export type VolcenginePortraitAssetStatus = (typeof ASSET_STATUSES)[number];
export type VolcenginePortraitAssetGroupType = (typeof GROUP_TYPES)[number];

export type VolcenginePortraitRelayResponse = Readonly<{
  ResponseMetadata?: Record<string, unknown>;
  Result: Record<string, unknown>;
}>;

const RELAY_METADATA_FIELDS = new Set([
  "Action",
  "Region",
  "RequestId",
  "Service",
  "Version",
]);
const RELAY_GROUP_FIELDS = new Set([
  "CreateTime",
  "Description",
  "GroupType",
  "Id",
  "Name",
  "ProjectName",
  "Status",
  "UpdateTime",
]);
const RELAY_ASSET_FIELDS = new Set([
  "AssetType",
  "CreateTime",
  "Error",
  "GroupId",
  "GroupType",
  "Id",
  "LastInferenceTime",
  "Name",
  "ProjectName",
  "Status",
  "UpdateTime",
  "URL",
]);
const RELAY_LIST_FIELDS = new Set([
  "AssetGroupInfos",
  "AssetGroups",
  "AssetInfos",
  "Assets",
  "Count",
  "Data",
  "Items",
  "PageNumber",
  "PageSize",
  "TotalCount",
]);
const RELAY_RESULT_FIELDS: Readonly<Record<VolcenginePortraitArkAction, ReadonlySet<string>>> = {
  CreateAssetGroup: new Set(["Id"]),
  GetAssetGroup: RELAY_GROUP_FIELDS,
  ListAssetGroups: RELAY_LIST_FIELDS,
  UpdateAssetGroup: RELAY_GROUP_FIELDS,
  DeleteAssetGroup: new Set(["Id"]),
  CreateVisualValidateSession: new Set(["BytedToken", "H5Link"]),
  GetVisualValidateResult: new Set(["GroupId", "Status"]),
  CreateAsset: new Set(["Id"]),
  GetAsset: RELAY_ASSET_FIELDS,
  ListAssets: RELAY_LIST_FIELDS,
  UpdateAsset: RELAY_ASSET_FIELDS,
  DeleteAsset: new Set(["Id"]),
};

function safeRelayScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(text)
    ? text
    : undefined;
}

function safeRelayError(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const code = safeRelayScalar(value.Code ?? value.code);
  if (typeof code !== "string") return undefined;
  return Object.freeze({ Code: safeErrorCode(code), Message: "上游素材处理失败" });
}

function sanitizeRelayItem(
  value: unknown,
  fields: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of fields) {
    if (!(key in value)) continue;
    if (key === "Error") {
      const error = safeRelayError(value[key]);
      if (error) output[key] = error;
      continue;
    }
    const scalar = safeRelayScalar(value[key]);
    if (scalar !== undefined) output[key] = scalar;
  }
  return Object.freeze(output);
}

function sanitizeRelayResult(
  action: VolcenginePortraitArkAction,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const fields = RELAY_RESULT_FIELDS[action];
  const itemFields = action === "ListAssetGroups" ? RELAY_GROUP_FIELDS : RELAY_ASSET_FIELDS;
  for (const key of fields) {
    if (!(key in value)) continue;
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      output[key] = candidate.slice(0, 100)
        .map((item) => sanitizeRelayItem(item, itemFields))
        .filter((item): item is Record<string, unknown> => Boolean(item));
      continue;
    }
    if (key === "Error") {
      const error = safeRelayError(candidate);
      if (error) output[key] = error;
      continue;
    }
    const scalar = safeRelayScalar(candidate);
    if (scalar !== undefined) output[key] = scalar;
  }
  return Object.freeze(output);
}

function sanitizeRelayMetadata(value: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of RELAY_METADATA_FIELDS) {
    const scalar = safeRelayScalar(value[key]);
    if (scalar !== undefined) output[key] = scalar;
  }
  return Object.keys(output).length ? Object.freeze(output) : undefined;
}

export type VolcenginePortraitAssetScope = Readonly<{
  channelId: string;
  providerAccountId: string;
  projectName: string;
}>;

export type VolcenginePortraitAssetGroupRef = Readonly<{
  groupId: string;
  groupType: VolcenginePortraitAssetGroupType;
  scope: VolcenginePortraitAssetScope;
}>;

export type VolcenginePortraitAssetRef = Readonly<{
  assetId: string;
  assetType: VolcenginePortraitAssetType;
  group: VolcenginePortraitAssetGroupRef;
  idempotencyKey: string;
  createdAt: number;
  sourceSha256: string;
  scope: VolcenginePortraitAssetScope;
}>;

export type VolcengineVisualValidateSession = Readonly<{
  bytedToken: string;
  callbackUrl: string;
  expiresAt: number;
  h5Link: string;
  idempotencyKey: string;
  issuedAt: number;
  scope: VolcenginePortraitAssetScope;
}>;

export type VolcengineVisualValidateCallback = Readonly<{
  algorithmBaseRespCode: string | null;
  bytedToken: string;
  reqMeasureInfoValue: string | null;
  resultCode: string;
  status: "succeeded" | "failed";
  verifyType: string | null;
}>;

export type VolcenginePortraitAsset = Readonly<{
  assetId: string;
  assetType: VolcenginePortraitAssetType;
  createTime: string | null;
  error: Readonly<{ code: string; message: string }> | null;
  group: VolcenginePortraitAssetGroupRef;
  lastInferenceTime: string | null;
  name: string | null;
  projectName: string;
  scope: VolcenginePortraitAssetScope;
  status: VolcenginePortraitAssetStatus;
  updateTime: string | null;
  url: string | null;
}>;

export type VolcenginePortraitIdempotencyState =
  | "in_progress"
  | "completed"
  | "failed"
  | "outcome_unknown";

export interface VolcenginePortraitIdempotencyRecord {
  action: VolcenginePortraitArkAction;
  errorCode?: string;
  idempotencyKey: string;
  leaseToken: string;
  requestHash: string;
  result?: unknown;
  scopeKey: string;
  state: VolcenginePortraitIdempotencyState;
  updatedAt: number;
}

export type VolcenginePortraitIdempotencyClaim =
  | { kind: "claimed"; record: VolcenginePortraitIdempotencyRecord }
  | { kind: "existing"; record: VolcenginePortraitIdempotencyRecord };

/**
 * The repository is deliberately storage-agnostic. A production caller can
 * provide a transaction-backed implementation without coupling this client to
 * a route or a database schema. A durable implementation must atomically make
 * scopeKey unique, compare requestHash on replay, fence complete/fail with the
 * leaseToken, encrypt sensitive completed results (notably BytedToken/H5Link),
 * and retain outcome_unknown records until an operator reconciles them. It
 * must never turn an expired in_progress/outcome_unknown write into an
 * automatic provider replay. The in-memory implementation below is useful for
 * tests and non-production single-process tooling only and is rejected when
 * NODE_ENV=prod.
 */
export interface VolcenginePortraitIdempotencyStore {
  readonly durability: "durable" | "memory";
  claim(input: VolcenginePortraitIdempotencyRecord): Promise<VolcenginePortraitIdempotencyClaim>;
  complete(input: {
    leaseToken: string;
    result: unknown;
    scopeKey: string;
    updatedAt: number;
  }): Promise<void>;
  fail(input: {
    errorCode: string;
    leaseToken: string;
    outcomeUnknown: boolean;
    scopeKey: string;
    updatedAt: number;
  }): Promise<void>;
}

export class InMemoryVolcenginePortraitIdempotencyStore
implements VolcenginePortraitIdempotencyStore {
  readonly durability = "memory" as const;
  private readonly records = new Map<string, VolcenginePortraitIdempotencyRecord>();

  async claim(input: VolcenginePortraitIdempotencyRecord): Promise<VolcenginePortraitIdempotencyClaim> {
    const existing = this.records.get(input.scopeKey);
    if (existing) return { kind: "existing", record: cloneRecord(existing) };
    const record = cloneRecord(input);
    this.records.set(input.scopeKey, record);
    return { kind: "claimed", record: cloneRecord(record) };
  }

  async complete(input: {
    leaseToken: string;
    result: unknown;
    scopeKey: string;
    updatedAt: number;
  }): Promise<void> {
    const record = this.requireLease(input.scopeKey, input.leaseToken);
    this.records.set(input.scopeKey, {
      ...record,
      result: structuredClone(input.result),
      state: "completed",
      updatedAt: input.updatedAt,
    });
  }

  async fail(input: {
    errorCode: string;
    leaseToken: string;
    outcomeUnknown: boolean;
    scopeKey: string;
    updatedAt: number;
  }): Promise<void> {
    const record = this.requireLease(input.scopeKey, input.leaseToken);
    this.records.set(input.scopeKey, {
      ...record,
      errorCode: input.errorCode,
      state: input.outcomeUnknown ? "outcome_unknown" : "failed",
      updatedAt: input.updatedAt,
    });
  }

  private requireLease(scopeKey: string, leaseToken: string): VolcenginePortraitIdempotencyRecord {
    const record = this.records.get(scopeKey);
    if (!record || record.state !== "in_progress" || record.leaseToken !== leaseToken) {
      throw new Error("VOLC_PORTRAIT_IDEMPOTENCY_LEASE_LOST");
    }
    return record;
  }
}

export interface VolcenginePortraitProviderChannel extends RelayChannelCredentialInput {
  id: string;
  provider: string;
  configJson?: unknown;
  baseUrl?: string | null;
}

export type VolcenginePortraitAssetsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Opens a portrait credential only for the synchronous work performed by
 * `use`. Callers should back this with the formal FD6 capability in release
 * runtimes; the callback result itself must remain non-thenable.
 */
export type VolcenginePortraitCredentialDispatcher = <T>(
  use: (credentialEnvelope: string) => T,
) => T;

export type VolcenginePortraitUnsignedAttempt = Readonly<{
  action: VolcenginePortraitArkAction;
  at: Date;
  body: string;
  signal: AbortSignal;
}>;

export type VolcenginePortraitStartedAttempt = Readonly<{
  response: Promise<Response>;
}>;

export type VolcenginePortraitStartAttempt = (
  attempt: VolcenginePortraitUnsignedAttempt,
) => VolcenginePortraitStartedAttempt;

export type VolcenginePortraitAssetsLogEvent = Readonly<{
  action: VolcenginePortraitArkAction;
  attempt: number;
  code?: string;
  event: "request_attempt" | "request_succeeded" | "request_failed";
  httpStatus?: number;
  idempotencyDigest?: string;
  requestId?: string;
  scopeDigest: string;
}>;

export interface VolcenginePortraitAssetsClientOptions {
  fetch?: VolcenginePortraitAssetsFetch;
  idempotencyStore: VolcenginePortraitIdempotencyStore;
  logger?: (event: VolcenginePortraitAssetsLogEvent) => void;
  maxReadAttempts?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

type ErrorDispatchState = "not_dispatched" | "response_received" | "outcome_unknown";

export class VolcenginePortraitAssetsError extends Error {
  readonly code: string;
  readonly dispatchState: ErrorDispatchState;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    dispatchState?: ErrorDispatchState;
    httpStatus?: number;
    requestId?: string;
    message: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "VolcenginePortraitAssetsError";
    this.code = safeErrorCode(input.code);
    this.dispatchState = input.dispatchState ?? "not_dispatched";
    this.httpStatus = input.httpStatus;
    this.requestId = safeRequestId(input.requestId);
    this.retryable = input.retryable ?? false;
  }
}

export interface VolcengineArkJsonPostSignInput {
  accessKeyId: string;
  at: Date;
  body: string;
  host?: string;
  query: Readonly<Record<string, string>>;
  region?: string;
  secretAccessKey: string;
  service?: string;
  sessionToken?: string;
}

export type VolcengineArkJsonPostSignResult = VolcengineV4SignResult;

type ResolvedCredential = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}> | TokenhexPortraitCredential;

type ArkResponse = Readonly<{
  metadata: Record<string, unknown> | null;
  requestId?: string;
  result: Record<string, unknown>;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cloneRecord(record: VolcenginePortraitIdempotencyRecord): VolcenginePortraitIdempotencyRecord {
  return structuredClone(record);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeToken(value: unknown, name: string, maximum = 256): string {
  const text = cleanString(value);
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw clientError("VOLC_PORTRAIT_CONFIG_INVALID", `火山人像资产${name}配置无效`);
  }
  return text;
}

function safeErrorCode(value: unknown): string {
  const code = cleanString(value);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(code) ? code : "VOLC_PORTRAIT_UPSTREAM_ERROR";
}

function safeRequestId(value: unknown): string | undefined {
  const requestId = cleanString(value);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) ? requestId : undefined;
}

function validateAccessKeyId(value: unknown): string {
  const accessKeyId = safeToken(value, "Access Key ID", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(accessKeyId)) {
    throw clientError("VOLC_PORTRAIT_CREDENTIAL_INVALID", "火山人像资产通道凭据无效");
  }
  return accessKeyId;
}

function validateSecretAccessKey(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) {
    throw clientError("VOLC_PORTRAIT_CREDENTIAL_INVALID", "火山人像资产通道凭据无效");
  }
  return value;
}

function validateProjectName(value: unknown): string {
  const projectName = cleanString(value) || "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(projectName)) {
    throw clientError("VOLC_PORTRAIT_PROJECT_INVALID", "火山人像资产项目配置无效");
  }
  return projectName;
}

function validateProviderAccountId(value: unknown): string {
  const accountId = cleanString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(accountId)) {
    throw clientError("VOLC_PORTRAIT_ACCOUNT_INVALID", "火山人像资产账号绑定缺失或无效");
  }
  return accountId;
}

function validateId(value: unknown, name: string): string {
  const id = cleanString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) {
    throw clientError("VOLC_PORTRAIT_RESPONSE_INVALID", `火山人像资产返回的${name}无效`);
  }
  return id;
}

function validateIdempotencyKey(value: unknown): string {
  const key = cleanString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    throw clientError("VOLC_PORTRAIT_IDEMPOTENCY_INVALID", "幂等键格式无效");
  }
  return key;
}

function validateAssetType(value: unknown): VolcenginePortraitAssetType {
  if (!ASSET_TYPES.includes(value as VolcenginePortraitAssetType)) {
    throw clientError("VOLC_PORTRAIT_ASSET_TYPE_INVALID", "火山素材类型无效");
  }
  return value as VolcenginePortraitAssetType;
}

function validateAssetStatus(value: unknown): VolcenginePortraitAssetStatus {
  if (!ASSET_STATUSES.includes(value as VolcenginePortraitAssetStatus)) {
    throw clientError("VOLC_PORTRAIT_RESPONSE_INVALID", "火山素材状态无效");
  }
  return value as VolcenginePortraitAssetStatus;
}

function validateSourceSha256(value: unknown): string {
  const digest = cleanString(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw clientError("VOLC_PORTRAIT_SOURCE_DIGEST_INVALID", "素材源文件摘要无效");
  }
  return digest;
}

function validateGroupType(value: unknown): VolcenginePortraitAssetGroupType {
  if (!GROUP_TYPES.includes(value as VolcenginePortraitAssetGroupType)) {
    throw clientError("VOLC_PORTRAIT_GROUP_TYPE_INVALID", "火山素材组类型无效");
  }
  return value as VolcenginePortraitAssetGroupType;
}

function validateOptionalName(value: unknown, maximum = 64): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const name = cleanString(value);
  if (!name || [...name].length > maximum || /[\u0000-\u001f\u007f]/.test(name)) {
    throw clientError("VOLC_PORTRAIT_NAME_INVALID", "火山人像资产名称无效");
  }
  return name;
}

function validateDescription(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const description = cleanString(value);
  if (!description || [...description].length > 300 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw clientError("VOLC_PORTRAIT_DESCRIPTION_INVALID", "火山素材组描述无效");
  }
  return description;
}

function validateHttpsUrl(value: unknown, name: string): string {
  const text = cleanString(value);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw clientError("VOLC_PORTRAIT_URL_INVALID", `${name}必须是 HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash
    || !parsed.hostname
  ) {
    throw clientError("VOLC_PORTRAIT_URL_INVALID", `${name}必须是 HTTPS URL`);
  }
  return parsed.toString();
}

function timeoutMs(value: unknown): number {
  const parsed = value === undefined ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS) {
    throw clientError("VOLC_PORTRAIT_TIMEOUT_INVALID", "火山人像资产请求超时配置无效");
  }
  return parsed;
}

function readAttempts(value: unknown): number {
  const parsed = value === undefined ? DEFAULT_READ_ATTEMPTS : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_READ_ATTEMPTS) {
    throw clientError("VOLC_PORTRAIT_RETRY_INVALID", "火山人像资产重试配置无效");
  }
  return parsed;
}

function clientError(code: string, message: string): VolcenginePortraitAssetsError {
  return new VolcenginePortraitAssetsError({ code, message });
}

function mutationResponseError(caught: unknown): VolcenginePortraitAssetsError {
  if (caught instanceof VolcenginePortraitAssetsError) {
    return new VolcenginePortraitAssetsError({
      code: caught.code,
      dispatchState: "outcome_unknown",
      httpStatus: caught.httpStatus,
      message: caught.message,
    });
  }
  return new VolcenginePortraitAssetsError({
    code: "VOLC_PORTRAIT_RESPONSE_INVALID",
    dispatchState: "outcome_unknown",
    message: "火山人像资产创建响应无效",
  });
}

function assertNoInlineCredential(config: Record<string, unknown>): void {
  for (const forbidden of ["secretAccessKey", "secretKey", "sessionToken", "securityToken"]) {
    if (cleanString(config[forbidden])) {
      throw clientError(
        "VOLC_PORTRAIT_INLINE_SECRET_FORBIDDEN",
        "火山人像资产凭据必须通过供应商通道凭据注入",
      );
    }
  }
}

function resolveCredential(
  channel: VolcenginePortraitProviderChannel,
  config: Record<string, unknown>,
): ResolvedCredential {
  assertNoInlineCredential(config);
  const resolved = resolvePortraitChannelCredential({
    ...channel,
    config,
  });
  if (!resolved.value || !["request", "stored"].includes(resolved.source)) {
    throw clientError(
      "VOLC_PORTRAIT_CREDENTIAL_MISSING",
      "火山人像资产供应商通道未配置 AK/SK 凭据",
    );
  }
  return parseResolvedCredentialEnvelope(resolved.value);
}

function parseResolvedCredentialEnvelope(value: string): ResolvedCredential {
  const envelope = parseProviderChannelPortraitCredential(value);
  if (!envelope) {
    throw clientError("VOLC_PORTRAIT_CREDENTIAL_INVALID", "火山人像资产通道凭据无效");
  }
  if (envelope.version === TOKENHEX_PORTRAIT_CREDENTIAL_VERSION) return envelope;
  const accessKeyId = validateAccessKeyId(envelope.accessKeyId);
  const secretAccessKey = validateSecretAccessKey(envelope.secretAccessKey);
  const sessionToken = envelope.sessionToken === undefined
    ? undefined
    : safeToken(envelope.sessionToken, "临时安全令牌", 768);
  return Object.freeze({ accessKeyId, secretAccessKey, sessionToken });
}

function idempotencyScope(scope: VolcenginePortraitAssetScope): Readonly<{
  projectName: string;
  providerAccountId: string;
}> {
  // Channel rows are replaceable configuration. The provider account and
  // ProjectName are the durable upstream namespace, so a channel rotation must
  // not make an already-used idempotency key dispatchable again.
  return Object.freeze({
    projectName: scope.projectName,
    providerAccountId: scope.providerAccountId,
  });
}

function scopeKey(scope: VolcenginePortraitAssetScope, action: VolcenginePortraitArkAction, key: string): string {
  const stableScope = idempotencyScope(scope);
  return [stableScope.providerAccountId, stableScope.projectName, action, key]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function scopeDigest(scope: VolcenginePortraitAssetScope): string {
  return sha256Hex(JSON.stringify(scope)).slice(0, 20);
}

function idempotencyDigest(value: string): string {
  return sha256Hex(value).slice(0, 20);
}

function sameScope(left: VolcenginePortraitAssetScope, right: VolcenginePortraitAssetScope): boolean {
  return left.channelId === right.channelId
    && left.providerAccountId === right.providerAccountId
    && left.projectName === right.projectName;
}

function assertScope(
  expected: VolcenginePortraitAssetScope,
  received: VolcenginePortraitAssetScope,
): void {
  if (!sameScope(expected, received)) {
    throw clientError(
      "VOLC_PORTRAIT_SCOPE_MISMATCH",
      "火山人像资产账号、项目或供应商通道不一致",
    );
  }
}

function responseRequestId(metadata: Record<string, unknown> | null): string | undefined {
  return safeRequestId(metadata?.RequestId ?? metadata?.requestId);
}

function providerErrorFromMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  const candidate = metadata?.Error ?? metadata?.error;
  return isPlainObject(candidate) ? candidate : null;
}

function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function retryDelayMs(attempt: number): number {
  return Math.min(2_000, 100 * (2 ** Math.max(0, attempt - 1)));
}

function constantTimeStringEquals(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

async function boundedResponseText(response: Response): Promise<string> {
  const responseTooLarge = () => new VolcenginePortraitAssetsError({
    code: "VOLC_PORTRAIT_RESPONSE_TOO_LARGE",
    // A successful or transient response does not prove that an upstream
    // mutation failed. Preserve the no-retry fence for that idempotency key.
    dispatchState: response.ok || isTransientHttpStatus(response.status)
      ? "outcome_unknown"
      : "response_received",
    httpStatus: response.status,
    message: "火山人像资产响应超过安全大小限制",
    retryable: isTransientHttpStatus(response.status),
  });
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw responseTooLarge();
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

/**
 * Minimal Volcengine V4 signer for the Ark JSON POST surface. This is kept
 * separate from release-controller/volcengineOpenApi.ts, whose audited public
 * contract intentionally supports only CLB GET calls.
 */
export function signVolcengineArkJsonPost(
  input: VolcengineArkJsonPostSignInput,
): VolcengineArkJsonPostSignResult {
  const accessKeyId = validateAccessKeyId(input.accessKeyId);
  const secretAccessKey = validateSecretAccessKey(input.secretAccessKey);
  const host = safeToken(input.host ?? ARK_HOST, "API Host", 255).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw clientError("VOLC_PORTRAIT_CONFIG_INVALID", "火山人像资产 API Host 配置无效");
  }
  const region = safeToken(input.region ?? ARK_REGION, "区域", 64);
  const service = safeToken(input.service ?? ARK_SERVICE, "服务", 64);
  if (!(input.at instanceof Date) || !Number.isFinite(input.at.getTime())) {
    throw clientError("VOLC_PORTRAIT_CLOCK_INVALID", "火山人像资产签名时钟无效");
  }
  const sessionToken = input.sessionToken === undefined
    ? undefined
    : safeToken(input.sessionToken, "临时安全令牌", 8_192);
  return signVolcengineV4JsonPost({
    accessKeyId,
    at: input.at,
    body: input.body,
    host,
    pathname: ARK_PATHNAME,
    query: input.query,
    region,
    secretAccessKey,
    service,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  });
}

function validateProviderChannelClientInput(
  channel: VolcenginePortraitProviderChannel,
  options: VolcenginePortraitAssetsClientOptions,
): Readonly<{
  config: Record<string, unknown>;
  scope: VolcenginePortraitAssetScope;
}> {
  if (process.env.NODE_ENV === "prod" && options.idempotencyStore.durability !== "durable") {
    throw clientError(
      "VOLC_PORTRAIT_DURABLE_IDEMPOTENCY_REQUIRED",
      "生产环境必须使用持久化的火山人像资产幂等存储",
    );
  }
  const config = {
    ...parseProviderChannelConfig(channel.configJson),
    ...(channel.config ?? {}),
  };
  assertNoInlineCredential(config);
  const channelId = safeToken(channel.id, "供应商通道 ID", 256);
  if (cleanString(channel.provider).toLowerCase() !== "volcano") {
    throw clientError("VOLC_PORTRAIT_PROVIDER_INVALID", "人像资产通道必须使用 Volcano provider");
  }
  return Object.freeze({
    config,
    scope: Object.freeze({
      channelId,
      providerAccountId: validateProviderAccountId(
        config.providerAccountId ?? config.volcengineAccountId ?? config.accountId,
      ),
      projectName: validateProjectName(
        config.assetsProjectName ?? config.projectName,
      ),
    }),
  });
}

function startSignedFetchWithResolvedCredential(input: {
  attempt: VolcenginePortraitUnsignedAttempt;
  credential: ResolvedCredential;
  fetch: VolcenginePortraitAssetsFetch;
  baseUrl?: string | null;
}): VolcenginePortraitStartedAttempt {
  const tokenhex = "bearerToken" in input.credential;
  if (tokenhex !== isTokenhexPortraitOrigin(input.baseUrl)) {
    throw clientError("VOLC_PORTRAIT_CREDENTIAL_PROTOCOL_MISMATCH", "人像资产凭据与通道协议不一致");
  }
  if ("bearerToken" in input.credential) {
    // The Tokenhex account is identified by the same Bearer key as generation.
    // ProjectName is local isolation metadata, not part of its wire contract.
    const body = JSON.parse(input.attempt.body) as Record<string, unknown>;
    delete body.ProjectName;
    const response = input.fetch(`${TOKENHEX_PORTRAIT_ORIGIN}/ark/api/v1/assets/${input.attempt.action}`, {
      body: JSON.stringify(body), cache: "no-store", credentials: "omit",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.credential.bearerToken}` },
      method: "POST", redirect: "error", signal: input.attempt.signal,
    });
    return Object.freeze({ response });
  }
  const query = { Action: input.attempt.action, Version: ARK_VERSION };
  const signed = signVolcengineArkJsonPost({
    accessKeyId: input.credential.accessKeyId,
    at: input.attempt.at,
    body: input.attempt.body,
    query,
    secretAccessKey: input.credential.secretAccessKey,
    sessionToken: input.credential.sessionToken,
  });
  const url = `https://${ARK_HOST}${ARK_PATHNAME}?${signed.canonicalQuery}`;
  // `fetch` is invoked before this function returns. The returned holder is
  // deliberately non-thenable and contains neither the credential envelope
  // nor reusable AK/SK material.
  const response = input.fetch(url, {
    body: input.attempt.body,
    cache: "no-store",
    credentials: "omit",
    headers: signed.headers,
    method: "POST",
    redirect: "error",
    signal: input.attempt.signal,
  });
  return Object.freeze({ response });
}

export function startVolcenginePortraitSignedFetch(input: {
  attempt: VolcenginePortraitUnsignedAttempt;
  credentialEnvelope: string;
  fetch: VolcenginePortraitAssetsFetch;
  baseUrl?: string | null;
}): VolcenginePortraitStartedAttempt {
  return startSignedFetchWithResolvedCredential({
    attempt: input.attempt,
    credential: parseResolvedCredentialEnvelope(input.credentialEnvelope),
    fetch: input.fetch,
    baseUrl: input.baseUrl,
  });
}

export class VolcenginePortraitAssetsClient {
  readonly scope: VolcenginePortraitAssetScope;

  private readonly idempotencyStore: VolcenginePortraitIdempotencyStore;
  private readonly logger?: (event: VolcenginePortraitAssetsLogEvent) => void;
  private readonly maxReadAttempts: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly startAttempt: VolcenginePortraitStartAttempt;
  private readonly requestTimeoutMs: number;
  private readonly tokenhex: boolean;

  private constructor(input: {
    options: VolcenginePortraitAssetsClientOptions;
    scope: VolcenginePortraitAssetScope;
    startAttempt: VolcenginePortraitStartAttempt;
    tokenhex: boolean;
  }) {
    this.tokenhex = input.tokenhex;
    this.idempotencyStore = input.options.idempotencyStore;
    this.logger = input.options.logger;
    this.maxReadAttempts = readAttempts(input.options.maxReadAttempts);
    this.now = input.options.now ?? (() => Date.now());
    this.sleep = input.options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
    this.startAttempt = input.startAttempt;
    this.requestTimeoutMs = timeoutMs(input.options.timeoutMs);
    this.scope = Object.freeze({ ...input.scope });
  }

  static fromProviderChannel(
    channel: VolcenginePortraitProviderChannel,
    options: VolcenginePortraitAssetsClientOptions,
  ): VolcenginePortraitAssetsClient {
    const { config, scope } = validateProviderChannelClientInput(channel, options);
    const credential = resolveCredential(channel, config);
    const fetchFn = options.fetch ?? fetch;
    return new VolcenginePortraitAssetsClient({
      options,
      scope,
      tokenhex: isTokenhexPortraitOrigin(channel.baseUrl),
      startAttempt: (attempt) => startSignedFetchWithResolvedCredential({
        attempt,
        credential,
        fetch: fetchFn,
        baseUrl: channel.baseUrl,
      }),
    });
  }

  static fromProviderChannelCredentialDispatcher(
    channel: VolcenginePortraitProviderChannel,
    options: VolcenginePortraitAssetsClientOptions,
    credentialDispatcher: VolcenginePortraitCredentialDispatcher,
  ): VolcenginePortraitAssetsClient {
    const { scope } = validateProviderChannelClientInput(channel, options);
    if (typeof credentialDispatcher !== "function" || cleanString(channel.credentialPlaintext)) {
      throw clientError(
        "VOLC_PORTRAIT_CREDENTIAL_INVALID",
        "火山人像资产凭据分发方式无效",
      );
    }
    const fetchFn = options.fetch ?? fetch;
    return new VolcenginePortraitAssetsClient({
      options,
      scope,
      tokenhex: isTokenhexPortraitOrigin(channel.baseUrl),
      startAttempt: (attempt) => credentialDispatcher((credentialEnvelope) => (
        startVolcenginePortraitSignedFetch({
          attempt,
          credentialEnvelope,
          fetch: fetchFn,
          baseUrl: channel.baseUrl,
        })
      )),
    });
  }

  /**
   * Schema-neutral relay for the official Ark Action surface. The caller owns
   * request-shape validation; this boundary still pins every request to the
   * channel's server-side ProjectName and applies durable idempotency to all
   * provider mutations.
   */
  async executeAction(input: {
    action: VolcenginePortraitArkAction;
    body: Record<string, unknown>;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<VolcenginePortraitRelayResponse> {
    if (!ARK_ACTIONS.includes(input.action)) {
      throw clientError("VOLC_PORTRAIT_ACTION_UNSUPPORTED", "火山人像资产操作不受支持");
    }
    const parsedBody = parsePortraitAssetRelayRequest(input.action, input.body);
    const requestedProjectName = validateProjectName(parsedBody.ProjectName);
    if (requestedProjectName !== this.scope.projectName) {
      throw clientError("VOLC_PORTRAIT_SCOPE_MISMATCH", "火山人像资产 ProjectName 与工作区通道不一致");
    }
    const body = structuredClone(parsedBody);
    const operation = async (): Promise<VolcenginePortraitRelayResponse> => {
      const response = await this.request(input.action, body, {
        readOnly: ARK_READ_ACTIONS.has(input.action),
        signal: input.signal,
      });
      if (!ARK_READ_ACTIONS.has(input.action)) {
        try {
          if (input.action === "CreateAssetGroup" || input.action === "CreateAsset") {
            validateId(response.result.Id ?? response.result.id, "创建结果 ID");
          }
          if (input.action === "CreateVisualValidateSession") {
            safeToken(
              response.result.BytedToken ?? response.result.bytedToken,
              "真人认证令牌",
              4_096,
            );
            const h5Link = validateHttpsUrl(
              response.result.H5Link ?? response.result.h5Link,
              "真人认证 H5Link",
            );
            if (new URL(h5Link).hostname !== "ark.volcengine.com") {
              throw clientError(
                "VOLC_PORTRAIT_RESPONSE_INVALID",
                "火山真人认证 H5Link 来源无效",
              );
            }
          }
        } catch {
          // A provider mutation may already have succeeded even when its 2xx
          // response is malformed. Fence the key as outcome_unknown so the
          // caller cannot create the same upstream resource a second time.
          throw new VolcenginePortraitAssetsError({
            code: "VOLC_PORTRAIT_RESPONSE_INVALID",
            dispatchState: "outcome_unknown",
            message: "火山人像资产创建响应无效",
          });
        }
      }
      const metadata = sanitizeRelayMetadata(response.metadata);
      return Object.freeze({
        ...(metadata
          ? { ResponseMetadata: metadata }
          : {}),
        Result: sanitizeRelayResult(input.action, response.result),
      });
    };
    if (ARK_READ_ACTIONS.has(input.action)) return await operation();
    return await this.mutate(
      input.action,
      input.idempotencyKey ?? "",
      body,
      input.signal,
      operation,
    );
  }

  async createAigcAssetGroup(input: {
    description?: string;
    idempotencyKey: string;
    name: string;
    signal?: AbortSignal;
  }): Promise<VolcenginePortraitAssetGroupRef> {
    const name = validateOptionalName(input.name);
    if (!name) throw clientError("VOLC_PORTRAIT_NAME_INVALID", "火山素材组名称不能为空");
    const description = validateDescription(input.description);
    const body = {
      Name: name,
      ...(description ? { Description: description } : {}),
      // The public method accepts no GroupType. The only group type the
      // official CreateAssetGroup API currently permits is hard-coded here.
      GroupType: "AIGC",
      ProjectName: this.scope.projectName,
    } as const;
    return this.mutate("CreateAssetGroup", input.idempotencyKey, body, input.signal, async () => {
      const response = await this.request("CreateAssetGroup", body, {
        readOnly: false,
        signal: input.signal,
      });
      try {
        return Object.freeze({
          groupId: validateId(response.result.Id ?? response.result.id, "素材组 ID"),
          groupType: "AIGC" as const,
          scope: this.scope,
        });
      } catch (caught) {
        // A 2xx response can still omit the identifier after the provider has
        // created the resource. Treat response-shape failures as ambiguous and
        // never turn them into an automatic second POST.
        throw mutationResponseError(caught);
      }
    });
  }

  async createVisualValidateSession(input: {
    callbackUrl: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<VolcengineVisualValidateSession> {
    const callbackUrl = validateHttpsUrl(input.callbackUrl, "真人认证 CallbackURL");
    const body = {
      CallbackURL: callbackUrl,
      ProjectName: this.scope.projectName,
    } as const;
    return this.mutate(
      "CreateVisualValidateSession",
      input.idempotencyKey,
      body,
      input.signal,
      async () => {
        const response = await this.request("CreateVisualValidateSession", body, {
          readOnly: false,
          signal: input.signal,
        });
        try {
          const bytedToken = safeToken(
            response.result.BytedToken ?? response.result.bytedToken,
            "真人认证令牌",
            4_096,
          );
          const h5Link = validateHttpsUrl(
            response.result.H5Link ?? response.result.h5Link,
            "真人认证 H5Link",
          );
          const h5Url = new URL(h5Link);
          if (h5Url.hostname !== "ark.volcengine.com") {
            throw clientError("VOLC_PORTRAIT_RESPONSE_INVALID", "火山真人认证 H5Link 来源无效");
          }
          const responseCallback = response.result.CallbackURL ?? response.result.callbackUrl;
          if (responseCallback !== undefined) {
            const normalizedResponseCallback = validateHttpsUrl(responseCallback, "真人认证 CallbackURL");
            if (normalizedResponseCallback !== callbackUrl) {
              throw clientError("VOLC_PORTRAIT_SCOPE_MISMATCH", "火山真人认证回调地址不一致");
            }
          }
          const issuedAt = this.clock();
          return Object.freeze({
            bytedToken,
            callbackUrl,
            expiresAt: issuedAt + (this.tokenhex ? 120_000 : VISUAL_VALIDATE_TOKEN_TTL_MS),
            h5Link,
            idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
            issuedAt,
            scope: this.scope,
          });
        } catch (caught) {
          throw mutationResponseError(caught);
        }
      },
    );
  }

  async getVisualValidateResult(input: {
    session: VolcengineVisualValidateSession;
    signal?: AbortSignal;
  }): Promise<VolcenginePortraitAssetGroupRef> {
    assertScope(this.scope, input.session.scope);
    if (this.clock() >= input.session.expiresAt) {
      throw clientError("VOLC_PORTRAIT_BYTED_TOKEN_EXPIRED", "真人认证令牌已超过 30 分钟有效期");
    }
    const body = {
      BytedToken: safeToken(input.session.bytedToken, "真人认证令牌", 4_096),
      ProjectName: this.scope.projectName,
    } as const;
    const response = await this.request("GetVisualValidateResult", body, {
      readOnly: true,
      retryDeadline: input.session.expiresAt,
      signal: input.signal,
    });
    return Object.freeze({
      groupId: validateId(response.result.GroupId ?? response.result.groupId, "真人素材组 ID"),
      // LivenessFace is derived from the official verification result path;
      // callers never submit a free-form GroupType.
      groupType: "LivenessFace" as const,
      scope: this.scope,
    });
  }

  async createAsset(input: {
    assetType: VolcenginePortraitAssetType;
    group: VolcenginePortraitAssetGroupRef;
    idempotencyKey: string;
    name?: string;
    signal?: AbortSignal;
    sourceSha256: string;
    url: string;
  }): Promise<VolcenginePortraitAssetRef> {
    assertScope(this.scope, input.group.scope);
    const groupType = validateGroupType(input.group.groupType);
    const groupId = validateId(input.group.groupId, "素材组 ID");
    const assetType = validateAssetType(input.assetType);
    const name = validateOptionalName(input.name);
    const sourceSha256 = validateSourceSha256(input.sourceSha256);
    const url = validateHttpsUrl(input.url, "素材 URL");
    const body = {
      AssetType: assetType,
      GroupId: groupId,
      ...(name ? { Name: name } : {}),
      ProjectName: this.scope.projectName,
      URL: url,
    } as const;
    return this.mutate("CreateAsset", input.idempotencyKey, {
      AssetType: assetType,
      GroupId: groupId,
      ...(name ? { Name: name } : {}),
      ProjectName: this.scope.projectName,
      SourceSha256: sourceSha256,
    }, input.signal, async () => {
      const response = await this.request("CreateAsset", body, {
        readOnly: false,
        signal: input.signal,
      });
      try {
        const createdAt = this.clock();
        const normalizedGroup: VolcenginePortraitAssetGroupRef = Object.freeze({
          groupId,
          groupType,
          scope: this.scope,
        });
        return Object.freeze({
          assetId: validateId(response.result.Id ?? response.result.id, "素材 ID"),
          assetType,
          createdAt,
          group: normalizedGroup,
          idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
          sourceSha256,
          scope: this.scope,
        });
      } catch (caught) {
        throw mutationResponseError(caught);
      }
    });
  }

  async getAsset(input: {
    asset: VolcenginePortraitAssetRef;
    signal?: AbortSignal;
  }): Promise<VolcenginePortraitAsset> {
    assertScope(this.scope, input.asset.scope);
    assertScope(this.scope, input.asset.group.scope);
    const assetId = validateId(input.asset.assetId, "素材 ID");
    const groupId = validateId(input.asset.group.groupId, "素材组 ID");
    const groupType = validateGroupType(input.asset.group.groupType);
    const body = { Id: assetId, ProjectName: this.scope.projectName } as const;
    const response = await this.request("GetAsset", body, {
      readOnly: true,
      signal: input.signal,
    });
    // Tokenhex's live GetAsset response may contain empty AssetId/GroupId.
    // The authenticated request targets the immutable ID returned by CreateAsset;
    // every non-empty echoed alias must still agree with that creation record.
    const tokenhexId = (keys: string[], expected: string, label: string) => {
      for (const key of keys) {
        const value = response.result[key];
        if (value === undefined || value === null || value === "") continue;
        if (validateId(value, label) !== expected) {
          throw clientError("VOLC_PORTRAIT_SCOPE_MISMATCH", "Tokenhex 素材响应与创建绑定不一致");
        }
      }
      return expected;
    };
    const responseAssetId = this.tokenhex
      ? tokenhexId(["Id", "id", "AssetId"], assetId, "素材 ID")
      : validateId(response.result.Id ?? response.result.id, "素材 ID");
    const responseGroupId = this.tokenhex
      ? tokenhexId(["GroupId", "groupId"], groupId, "素材组 ID")
      : validateId(response.result.GroupId ?? response.result.groupId, "素材组 ID");
    const responseProject = validateProjectName(
      response.result.ProjectName ?? response.result.projectName ?? (this.tokenhex ? this.scope.projectName : undefined),
    );
    if (
      responseAssetId !== assetId
      || responseGroupId !== groupId
      || responseProject !== this.scope.projectName
    ) {
      throw clientError(
        "VOLC_PORTRAIT_SCOPE_MISMATCH",
        "火山人像资产响应不属于请求的账号、项目、通道或素材组",
      );
    }
    const status = validateAssetStatus(response.result.Status ?? response.result.status);
    const responseAssetType = validateAssetType(
      // Tokenhex documents only Id/Status/URL for GetAsset. Missing optional
      // metadata comes from this immutable creation record; returned values
      // are still checked and Status is never invented or taken from a list.
      response.result.AssetType ?? response.result.assetType ?? (this.tokenhex ? input.asset.assetType : undefined),
    );
    if (responseAssetType !== input.asset.assetType) {
      throw clientError("VOLC_PORTRAIT_SCOPE_MISMATCH", "火山素材类型与创建记录不一致");
    }
    const upstreamError = isPlainObject(response.result.Error)
      ? response.result.Error
      : isPlainObject(response.result.error)
        ? response.result.error
        : null;
    const upstreamErrorCode = safeErrorCode(upstreamError?.Code ?? upstreamError?.code);
    const error = status === "Failed"
      ? Object.freeze({
        code: upstreamErrorCode,
        // Upstream text may contain URLs or credentials. Preserve the stable
        // code and expose a fixed local message instead.
        message: "上游素材处理失败",
      })
      : null;
    return Object.freeze({
      assetId,
      assetType: responseAssetType,
      createTime: cleanString(response.result.CreateTime ?? response.result.createTime) || null,
      error,
      group: Object.freeze({ groupId, groupType, scope: this.scope }),
      lastInferenceTime: cleanString(
        response.result.LastInferenceTime ?? response.result.lastInferenceTime,
      ) || null,
      name: cleanString(response.result.Name ?? response.result.name) || null,
      projectName: responseProject,
      scope: this.scope,
      status,
      updateTime: cleanString(response.result.UpdateTime ?? response.result.updateTime) || null,
      url: cleanString(response.result.URL ?? response.result.url) || null,
    });
  }

  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw clientError("VOLC_PORTRAIT_CLOCK_INVALID", "火山人像资产时钟无效");
    }
    return now;
  }

  private emit(event: VolcenginePortraitAssetsLogEvent): void {
    if (!this.logger) return;
    try {
      this.logger(Object.freeze({ ...event }));
    } catch {
      // Observability is best effort and must never alter provider outcomes.
    }
  }

  private async mutate<T>(
    action: VolcenginePortraitArkAction,
    rawIdempotencyKey: string,
    request: unknown,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new VolcenginePortraitAssetsError({
        code: "VOLC_PORTRAIT_ABORTED",
        message: "火山人像资产请求已取消",
      });
    }
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const requestHash = hashIdempotencyRequest({
      action,
      request,
      scope: idempotencyScope(this.scope),
    });
    const key = scopeKey(this.scope, action, idempotencyKey);
    const now = this.clock();
    const claim = await this.idempotencyStore.claim({
      action,
      idempotencyKey,
      leaseToken: randomUUID(),
      requestHash,
      scopeKey: key,
      state: "in_progress",
      updatedAt: now,
    });
    if (claim.record.requestHash !== requestHash) {
      throw clientError(
        "VOLC_PORTRAIT_IDEMPOTENCY_CONFLICT",
        "相同幂等键已绑定到不同的火山人像资产请求",
      );
    }
    if (claim.kind === "existing") {
      if (claim.record.state === "completed") {
        if (claim.record.result === undefined) {
          throw clientError(
            "VOLC_PORTRAIT_SENSITIVE_REPLAY_UNAVAILABLE",
            "敏感真人认证会话不提供持久化响应重放，请创建新的认证会话",
          );
        }
        return structuredClone(claim.record.result) as T;
      }
      if (claim.record.state === "in_progress") {
        throw clientError("VOLC_PORTRAIT_OPERATION_IN_PROGRESS", "相同幂等请求正在执行");
      }
      if (claim.record.state === "outcome_unknown") {
        throw clientError(
          "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
          "此前请求的上游结果不确定，禁止自动重复创建",
        );
      }
      throw clientError(
        claim.record.errorCode ?? "VOLC_PORTRAIT_IDEMPOTENT_OPERATION_FAILED",
        "此前相同幂等请求已明确失败",
      );
    }

    try {
      const result = await operation();
      try {
        await this.idempotencyStore.complete({
          leaseToken: claim.record.leaseToken,
          result,
          scopeKey: key,
          updatedAt: this.clock(),
        });
      } catch {
        try {
          await this.idempotencyStore.fail({
            errorCode: "VOLC_PORTRAIT_IDEMPOTENCY_COMMIT_FAILED",
            leaseToken: claim.record.leaseToken,
            outcomeUnknown: true,
            scopeKey: key,
            updatedAt: this.clock(),
          });
        } catch {
          // The caller still receives the fail-closed outcome below.
        }
        throw new VolcenginePortraitAssetsError({
          code: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
          dispatchState: "outcome_unknown",
          message: "火山请求成功但幂等结果未能安全登记，禁止自动重放",
        });
      }
      return result;
    } catch (caught) {
      const error = caught instanceof VolcenginePortraitAssetsError
        ? caught
        : clientError("VOLC_PORTRAIT_REQUEST_FAILED", "火山人像资产请求失败");
      const outcomeUnknown = error.dispatchState === "outcome_unknown"
        || (error.dispatchState === "response_received" && error.retryable);
      try {
        await this.idempotencyStore.fail({
          errorCode: error.code,
          leaseToken: claim.record.leaseToken,
          outcomeUnknown,
          scopeKey: key,
          updatedAt: this.clock(),
        });
      } catch {
        // A lost lease is itself ambiguous. Never retry the provider write.
      }
      throw error;
    }
  }

  private async request(
    action: VolcenginePortraitArkAction,
    bodyValue: Record<string, unknown>,
    options: {
      readOnly: boolean;
      retryDeadline?: number;
      signal?: AbortSignal;
    },
  ): Promise<ArkResponse> {
    if (!ARK_ACTIONS.includes(action)) {
      throw clientError("VOLC_PORTRAIT_ACTION_UNSUPPORTED", "火山人像资产操作不受支持");
    }
    const body = JSON.stringify(bodyValue);
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      throw clientError("VOLC_PORTRAIT_REQUEST_TOO_LARGE", "火山人像资产请求超过安全大小限制");
    }
    const attempts = options.readOnly ? this.maxReadAttempts : 1;
    let lastError: VolcenginePortraitAssetsError | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (options.signal?.aborted) {
        throw new VolcenginePortraitAssetsError({
          code: "VOLC_PORTRAIT_ABORTED",
          message: "火山人像资产请求已取消",
        });
      }
      const now = this.clock();
      if (options.retryDeadline !== undefined && now >= options.retryDeadline) {
        throw clientError("VOLC_PORTRAIT_BYTED_TOKEN_EXPIRED", "真人认证令牌已超过 30 分钟有效期");
      }
      this.emit({
        action,
        attempt,
        event: "request_attempt",
        scopeDigest: scopeDigest(this.scope),
      });
      try {
        const response = await this.requestAttempt(action, body, options.signal);
        this.emit({
          action,
          attempt,
          event: "request_succeeded",
          requestId: response.requestId,
          scopeDigest: scopeDigest(this.scope),
        });
        return response;
      } catch (caught) {
        const error = caught instanceof VolcenginePortraitAssetsError
          ? caught
          : new VolcenginePortraitAssetsError({
            code: "VOLC_PORTRAIT_REQUEST_FAILED",
            dispatchState: "outcome_unknown",
            message: "火山人像资产请求失败",
            retryable: true,
          });
        lastError = error;
        this.emit({
          action,
          attempt,
          code: error.code,
          event: "request_failed",
          httpStatus: error.httpStatus,
          requestId: error.requestId,
          scopeDigest: scopeDigest(this.scope),
        });
        if (!options.readOnly || !error.retryable || attempt >= attempts) throw error;
        const delay = retryDelayMs(attempt);
        if (options.retryDeadline !== undefined && this.clock() + delay >= options.retryDeadline) {
          throw clientError("VOLC_PORTRAIT_BYTED_TOKEN_EXPIRED", "真人认证令牌已超过 30 分钟有效期");
        }
        await this.sleep(delay);
      }
    }
    throw lastError ?? clientError("VOLC_PORTRAIT_REQUEST_FAILED", "火山人像资产请求失败");
  }

  private async requestAttempt(
    action: VolcenginePortraitArkAction,
    body: string,
    callerSignal?: AbortSignal,
  ): Promise<ArkResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const onCallerAbort = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const started = this.startAttempt({
        action,
        at: new Date(this.clock()),
        body,
        signal: controller.signal,
      });
      if (
        !started
        || typeof started !== "object"
        || typeof (started as { then?: unknown }).then === "function"
        || !started.response
        || typeof started.response.then !== "function"
      ) {
        throw clientError(
          "VOLC_PORTRAIT_DISPATCH_INVALID",
          "火山人像资产请求分发器返回无效",
        );
      }
      const response = await started.response;
      const text = await boundedResponseText(response);
      // Ark returns structured Error/RequestId metadata on non-2xx responses too.
      // Parse the bounded body before falling back to an HTTP-only error, without
      // exposing the upstream Message (which may contain signed source URLs).
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new VolcenginePortraitAssetsError({
            code: "VOLC_PORTRAIT_RESPONSE_INVALID",
            dispatchState: "outcome_unknown",
            httpStatus: response.status,
            message: "火山人像资产响应不是有效 JSON",
          });
        }
      }
      const metadata = isPlainObject(payload) && isPlainObject(payload.ResponseMetadata)
        ? payload.ResponseMetadata
        : isPlainObject(payload) && isPlainObject(payload.responseMetadata)
          ? payload.responseMetadata
          : null;
      const providerError = providerErrorFromMetadata(metadata);
      const requestId = responseRequestId(metadata);
      if (providerError) {
        const code = safeErrorCode(providerError.Code ?? providerError.code);
        throw new VolcenginePortraitAssetsError({
          code,
          dispatchState: "response_received",
          httpStatus: response.status,
          requestId,
          message: portraitRegistrationFailureMessage(code) ?? "火山人像资产服务拒绝了请求",
          retryable: isTransientHttpStatus(response.status)
            || /(?:Internal|Throttl|Limit|Timeout|Unavailable)/i.test(code),
        });
      }
      if (!response.ok) {
        throw new VolcenginePortraitAssetsError({
          code: `VOLC_PORTRAIT_HTTP_${response.status}`,
          dispatchState: "response_received",
          httpStatus: response.status,
          requestId,
          message: `火山人像资产请求返回 HTTP ${response.status}`,
          retryable: isTransientHttpStatus(response.status),
        });
      }
      if (!isPlainObject(payload)) {
        throw new VolcenginePortraitAssetsError({
          code: "VOLC_PORTRAIT_RESPONSE_INVALID",
          dispatchState: "outcome_unknown",
          httpStatus: response.status,
          message: "火山人像资产响应格式无效",
        });
      }
      const result = isPlainObject(payload.Result)
        ? payload.Result
        : isPlainObject(payload.result)
          ? payload.result
          : payload;
      return Object.freeze({
        metadata,
        requestId: responseRequestId(metadata),
        result,
      });
    } catch (caught) {
      if (caught instanceof VolcenginePortraitAssetsError) throw caught;
      if (
        caught instanceof FormalCandidateCredentialRuntimeError
        || caught instanceof FormalCandidateCredentialCapabilityError
      ) {
        // FD6 scope/expiry/exhaustion failures occur before the synchronous
        // credential callback can sign or invoke fetch. They are a definite
        // local availability failure, not an ambiguous upstream mutation.
        throw new VolcenginePortraitAssetsError({
          code: "VOLC_PORTRAIT_CREDENTIAL_CAPABILITY_UNAVAILABLE",
          dispatchState: "not_dispatched",
          httpStatus: 503,
          message: "火山人像资产正式运行凭据暂不可用",
        });
      }
      if (callerSignal?.aborted && !timedOut) {
        throw new VolcenginePortraitAssetsError({
          code: "VOLC_PORTRAIT_ABORTED",
          dispatchState: "outcome_unknown",
          message: "火山人像资产请求已取消",
        });
      }
      if (timedOut || isAbortError(caught)) {
        throw new VolcenginePortraitAssetsError({
          code: "VOLC_PORTRAIT_TIMEOUT",
          dispatchState: "outcome_unknown",
          message: "火山人像资产请求超时",
          retryable: true,
        });
      }
      throw new VolcenginePortraitAssetsError({
        code: "VOLC_PORTRAIT_TRANSPORT_FAILED",
        dispatchState: "outcome_unknown",
        message: "无法连接火山人像资产服务",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

export function createVolcenginePortraitAssetsClient(
  channel: VolcenginePortraitProviderChannel,
  options: VolcenginePortraitAssetsClientOptions,
): VolcenginePortraitAssetsClient {
  return VolcenginePortraitAssetsClient.fromProviderChannel(channel, options);
}

export function createVolcenginePortraitAssetsClientForCredentialDispatch(
  channel: VolcenginePortraitProviderChannel,
  options: VolcenginePortraitAssetsClientOptions,
  credentialDispatcher: VolcenginePortraitCredentialDispatcher,
): VolcenginePortraitAssetsClient {
  return VolcenginePortraitAssetsClient.fromProviderChannelCredentialDispatcher(
    channel,
    options,
    credentialDispatcher,
  );
}

export function parseVolcengineVisualValidateCallback(input: {
  callbackUrl: string;
  now?: number;
  session: VolcengineVisualValidateSession;
}): VolcengineVisualValidateCallback {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw clientError("VOLC_PORTRAIT_CLOCK_INVALID", "火山人像资产时钟无效");
  }
  if (now >= input.session.expiresAt) {
    throw clientError("VOLC_PORTRAIT_BYTED_TOKEN_EXPIRED", "真人认证令牌已超过 30 分钟有效期");
  }
  const expected = new URL(validateHttpsUrl(input.session.callbackUrl, "真人认证 CallbackURL"));
  const received = new URL(validateHttpsUrl(input.callbackUrl, "真人认证回调 URL"));
  if (expected.origin !== received.origin || expected.pathname !== received.pathname) {
    throw clientError("VOLC_PORTRAIT_CALLBACK_MISMATCH", "真人认证回调地址与会话不一致");
  }
  for (const [key, value] of expected.searchParams) {
    if (received.searchParams.get(key) !== value) {
      throw clientError("VOLC_PORTRAIT_CALLBACK_MISMATCH", "真人认证回调地址与会话不一致");
    }
  }
  const bytedToken = cleanString(received.searchParams.get("bytedToken"));
  if (!bytedToken || !constantTimeStringEquals(bytedToken, input.session.bytedToken)) {
    throw clientError("VOLC_PORTRAIT_CALLBACK_TOKEN_MISMATCH", "真人认证回调令牌与会话不一致");
  }
  const resultCode = cleanString(received.searchParams.get("resultCode"));
  if (!/^\d{1,16}$/.test(resultCode)) {
    throw clientError("VOLC_PORTRAIT_CALLBACK_INVALID", "真人认证回调缺少有效结果码");
  }
  const optionalCode = (name: string): string | null => {
    const value = cleanString(received.searchParams.get(name));
    if (!value) return null;
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
      throw clientError("VOLC_PORTRAIT_CALLBACK_INVALID", "真人认证回调参数无效");
    }
    return value;
  };
  return Object.freeze({
    algorithmBaseRespCode: optionalCode("algorithmBaseRespCode"),
    bytedToken,
    reqMeasureInfoValue: optionalCode("reqMeasureInfoValue"),
    resultCode,
    status: resultCode === "10000" ? "succeeded" : "failed",
    verifyType: optionalCode("verify_type"),
  });
}

export function describeVolcenginePortraitAssetScope(
  scope: VolcenginePortraitAssetScope,
): Readonly<{ scopeDigest: string }> {
  return Object.freeze({ scopeDigest: scopeDigest(scope) });
}

export function describeVolcenginePortraitIdempotencyKey(
  idempotencyKey: string,
): Readonly<{ idempotencyDigest: string }> {
  return Object.freeze({ idempotencyDigest: idempotencyDigest(validateIdempotencyKey(idempotencyKey)) });
}
