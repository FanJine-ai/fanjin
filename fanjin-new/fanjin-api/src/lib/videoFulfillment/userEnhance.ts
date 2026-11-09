import { ceilGuChargeMicros, guChargeQuantumMicros } from "@/lib/billingUnits";
import crypto from "node:crypto";
import fs from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { v4 as uuid } from "uuid";
import type { Knex } from "knex";
import { mediaServiceTable, findMediaService, mediaKitRuntimeConfig, MEDIAKIT_STATUS_ENDPOINT, lockMediaServiceForTask } from "@/lib/mediaServices";
import { FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT } from "@/lib/fanjinValueVideoOffers";
import { isValueVideoFulfillmentPrice } from "./pricingPurpose";
import u from "@/utils";
import { db } from "@/utils/db";
import {
  canEnhanceBetween,
  isPublicVideoResolution,
  normalizeVideoResolution,
  videoResolutionHeight,
  type PublicVideoResolution,
} from "@/lib/videoResolutions";
import {
  pickWeightedRecipe,
  USER_VIDEO_ENHANCE_BILLING_SUBJECT,
} from "@/lib/videoFulfillment/recipes";
import { USER_VIDEO_ENHANCE_TASK_TABLE } from "@/lib/migrations/userVideoEnhanceTask";
import {
  billApiTask,
  BillingError,
  guMicrosPerGu,
  markApiTaskReservationDispatched,
  markApiTaskReservationPendingReconcile,
  releaseApiTaskReservation,
  settleApiTaskReservation,
} from "@/lib/billing";
import { isPostgresClient } from "@/lib/dbDialect";
import {
  providerCredentialFallbackEnvNames,
  resolveChannelApiKey,
  resolveChannelBaseUrl,
} from "@/lib/relayChannelCredential";
import { relayMockIsSuccessful } from "@/lib/relayMockPolicy";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
} from "@/lib/durableObjectWrite";
import {
  commitObjectWriteIntentInTransaction,
  createObjectWriteMediaReferenceEvidence,
  type ObjectWriteIntentClaim,
} from "@/lib/objectWriteIntent";
import {
  createUserEnhanceAssetEvidenceDescriptor,
  publicDeliveryPart,
  publishUserVideoEnhanceDelivery,
  readRelayMediaProbe,
  readUserEnhanceAssetEvidenceDescriptor,
  readUserEnhanceMediaProbe,
  USER_VIDEO_ENHANCE_RECONCILE_MARKER,
  userEnhanceSourceAssetIdentity,
} from "@/lib/videoFulfillment/deliveryConsumer";
import {
  mirrorVideoToOwnedStorage,
  probeVideoFile,
  removeMirroredVideo,
  resolveOwnedVideoLocalPath,
  resolveOwnedVideoStorageKeyLocalPath,
  sha256VideoFile,
  type SafeMirroredVideo,
} from "@/lib/videoFulfillment/safeVideoMirror";

export interface UserVideoEnhanceQuoteInput {
  sourceResolution: unknown;
  targetResolution: unknown;
  durationSeconds?: number | null;
  /** Only true when the duration came from server-owned asset metadata. */
  authoritativeDuration?: boolean;
}

export interface UserVideoEnhancePricingSnapshot {
  pricingRuleId: string;
  unit: "second";
  unitPriceMicros: number;
  currency: "GU";
}

export interface UserVideoEnhanceQuote {
  billingSubject: typeof USER_VIDEO_ENHANCE_BILLING_SUBJECT;
  sourceResolution: PublicVideoResolution;
  targetResolution: PublicVideoResolution;
  durationSeconds: number;
  authoritativeDuration: boolean;
  pricingRuleId: string | null;
  unitPriceMicros: number;
  amountMicros: number;
  unitPriceGu: number;
  amountGu: number;
  currency: "GU";
  allowed: boolean;
  reasonCode?: string;
  reason?: string;
}

function rejectedEnhanceQuote(input: {
  sourceResolution: PublicVideoResolution;
  targetResolution: PublicVideoResolution;
  durationSeconds: number;
  authoritativeDuration: boolean;
  reasonCode: string;
  reason: string;
}): UserVideoEnhanceQuote {
  return {
    billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
    sourceResolution: input.sourceResolution,
    targetResolution: input.targetResolution,
    durationSeconds: input.durationSeconds,
    authoritativeDuration: input.authoritativeDuration,
    pricingRuleId: null,
    unitPriceMicros: 0,
    amountMicros: 0,
    unitPriceGu: 0,
    amountGu: 0,
    currency: "GU",
    allowed: false,
    reasonCode: input.reasonCode,
    reason: input.reason,
  };
}

/**
 * Build an enhance quote from an explicit, server-resolved pricing snapshot.
 * Omitting the snapshot intentionally fails closed; there are no fallback or
 * placeholder prices on the billable path.
 */
export function quoteUserVideoEnhance(
  input: UserVideoEnhanceQuoteInput,
  pricing: UserVideoEnhancePricingSnapshot | null = null,
): UserVideoEnhanceQuote {
  const sourceResolution = normalizeVideoResolution(input.sourceResolution);
  const targetResolution = normalizeVideoResolution(input.targetResolution);
  const rawDuration = Number(input.durationSeconds);
  const durationSeconds = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.ceil(rawDuration) : 0;
  const authoritativeDuration = input.authoritativeDuration === true;

  if (!sourceResolution || !isPublicVideoResolution(sourceResolution)) {
    return rejectedEnhanceQuote({
      sourceResolution: "720p",
      targetResolution: "1080p",
      durationSeconds,
      authoritativeDuration,
      reasonCode: "ENHANCE_SOURCE_RESOLUTION_INVALID",
      reason: "源分辨率无效（须为公开档且 ≥720p）",
    });
  }
  if (!targetResolution || !isPublicVideoResolution(targetResolution)) {
    return rejectedEnhanceQuote({
      sourceResolution,
      targetResolution: "1080p",
      durationSeconds,
      authoritativeDuration,
      reasonCode: "ENHANCE_TARGET_RESOLUTION_INVALID",
      reason: "目标分辨率无效",
    });
  }
  if (!canEnhanceBetween(sourceResolution, targetResolution)) {
    return rejectedEnhanceQuote({
      sourceResolution,
      targetResolution,
      durationSeconds,
      authoritativeDuration,
      reasonCode: "ENHANCE_PAIR_INVALID",
      reason: "目标分辨率必须高于源分辨率",
    });
  }
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86_400) {
    return rejectedEnhanceQuote({
      sourceResolution,
      targetResolution,
      durationSeconds: 0,
      authoritativeDuration,
      reasonCode: "ENHANCE_DURATION_UNVERIFIED",
      reason: "无法确认源视频时长，请先将视频保存为资产并完成媒体信息解析",
    });
  }
  if (
    !pricing
    || !pricing.pricingRuleId
    || pricing.unit !== "second"
    || pricing.currency !== "GU"
    || !Number.isSafeInteger(pricing.unitPriceMicros)
    || pricing.unitPriceMicros <= 0
  ) {
    return rejectedEnhanceQuote({
      sourceResolution,
      targetResolution,
      durationSeconds,
      authoritativeDuration,
      reasonCode: "ENHANCE_PRICE_UNAVAILABLE",
      reason: "当前增强档位未配置可用价格",
    });
  }
  const rawAmountMicros = pricing.unitPriceMicros * durationSeconds;
  const maximumCharge = Math.floor(Number.MAX_SAFE_INTEGER / guChargeQuantumMicros) * guChargeQuantumMicros;
  if (!Number.isSafeInteger(rawAmountMicros) || rawAmountMicros <= 0 || rawAmountMicros > maximumCharge) {
    return rejectedEnhanceQuote({
      sourceResolution,
      targetResolution,
      durationSeconds,
      authoritativeDuration,
      reasonCode: "ENHANCE_PRICE_INVALID",
      reason: "增强价格超出可计费范围",
    });
  }
  const amountMicros = ceilGuChargeMicros(rawAmountMicros);
  return {
    billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
    sourceResolution,
    targetResolution,
    durationSeconds,
    authoritativeDuration,
    pricingRuleId: pricing.pricingRuleId,
    unitPriceMicros: pricing.unitPriceMicros,
    amountMicros,
    unitPriceGu: pricing.unitPriceMicros / guMicrosPerGu,
    amountGu: amountMicros / guMicrosPerGu,
    currency: "GU",
    allowed: true,
  };
}

/** Relay / developer surface must not sell enhance as a product. */
export function isRelayVideoEnhanceForbidden(): true {
  return true;
}

// ─── 路径 B:创作台用户画质增强真调度 + video_enhance 科目扣费 ────────────────
// 设计契约:docs/superpowers/specs/2026-07-19-video-fulfillment-recipes-design.md
// §5.2 / §6。链路:校验 → quote 复核 → 选超分通道(video_upscale,健康+权重)
// → 冻结(video_enhance 科目) → 提交超分通道 → 成功:新资产入库(source=
// video_enhance,保留原片)+结算;失败:释放冻结。
// 边界:不改动 relay.ts 的路径 A 增强链路;这里独立实现路径 B 的提交/轮询,
// 复用 relayChannelCredential 凭据解析；产物与任务指针在本链路事务内原子绑定。

export const USER_VIDEO_ENHANCE_TASK_KIND = "user_video_enhance";
export const USER_VIDEO_ENHANCE_ASSET_SOURCE = "video_enhance";
const userEnhanceAssetLocks = new Map<string, Promise<void>>();
const USER_ENHANCE_DISPATCH_MARKER = "INTERNAL_USER_VIDEO_ENHANCE_DISPATCH|";
const USER_ENHANCE_FINALIZATION_MARKER = "INTERNAL_USER_VIDEO_ENHANCE_FINALIZE|";

export type UserVideoEnhanceTaskStatus =
  | "created"
  | "enhancing"
  | "reconciling"
  | "succeeded"
  | "failed";

export type UserVideoEnhanceBillingReconciliationState =
  | "pending"
  | "not_billed"
  | "reserved"
  | "settlement_pending"
  | "settled"
  | "release_pending"
  | "released"
  | "unknown";

type UserEnhanceFinalizationKind = "succeeded" | "definitive_failure" | "pending_reconcile";

interface UserEnhanceOperationMarker {
  phase: "dispatch" | "finalize";
  kind: UserEnhanceFinalizationKind | null;
  leaseExpiresAt: number;
  token: string;
}

export interface UserVideoEnhanceTask {
  id: string;
  kind: string;
  workspaceId: string;
  projectId: number | null;
  userId: number | null;
  sourceAssetId: string | null;
  sourceUrl: string;
  sourceResolution: string;
  targetResolution: string;
  durationSeconds: number;
  enhanceChannelId: string | null;
  provider: string | null;
  providerTaskId: string | null;
  status: UserVideoEnhanceTaskStatus;
  quote: UserVideoEnhanceQuote;
  reservationId: string | null;
  usageRecordId: string | null;
  billingReconciliationState: UserVideoEnhanceBillingReconciliationState;
  billingReconciliationEvidence: Record<string, unknown>;
  billingReconciliationError: string | null;
  billingReconciliationUpdatedAt: number;
  finalizationLeaseOwner: string | null;
  finalizationLeaseExpiresAt: number | null;
  finalizationFence: number;
  resultAssetId: string | null;
  resultUrl: string | null;
  errorMessage: string | null;
  idempotencyKey: string | null;
  requestId: string | null;
  createdAt: number;
  updatedAt: number;
}

export class UserVideoEnhanceError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "ENHANCE_CREATE_FAILED") {
    super(message);
    this.name = "UserVideoEnhanceError";
    this.status = status;
    this.code = code;
  }
}

/** 与 relay.ts 内部增强链路一致的上游默认端点(火山 MediaKit)。 */
const DEFAULT_ENHANCE_SUBMIT_ENDPOINTS: Record<"generative" | "standard", string> = {
  generative: "https://mediakit.cn-beijing.volces.com/api/v1/tools/enhance-video-generative",
  standard: "https://mediakit.cn-beijing.volces.com/api/v1/tools/enhance-video",
};
const DEFAULT_ENHANCE_STATUS_ENDPOINT = "https://mediakit.cn-beijing.volces.com/api/v1/tasks/{taskId}";

interface EnhanceChannelRow {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  credentialRef: string | null;
  credentialCiphertext: string | null;
  config: Record<string, unknown>;
  timeoutMs: number;
  weight: number;
  priority: number;
  healthStatus: string | null;
  concurrencyLimit: number;
}

interface EnhanceChannelConfig {
  submitEndpoint: string;
  statusEndpoint: string;
  apiKey: string;
  mode: "generative" | "standard";
}

function now(): number {
  return Date.now();
}

function userEnhanceOperationLeaseMs(): number {
  const configured = Number(process.env.FANJIN_USER_VIDEO_ENHANCE_OPERATION_LEASE_MS || 15 * 60_000);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.floor(configured)
    : 15 * 60_000;
}

function createUserEnhanceOperationMarker(
  phase: "dispatch" | "finalize",
  kind: UserEnhanceFinalizationKind | null = null,
  leaseExpiresAt = now() + userEnhanceOperationLeaseMs(),
): string {
  if (phase === "dispatch") {
    return `${USER_ENHANCE_DISPATCH_MARKER}${leaseExpiresAt}|${uuid()}`;
  }
  return `${USER_ENHANCE_FINALIZATION_MARKER}${kind}|${leaseExpiresAt}|${uuid()}`;
}

function parseUserEnhanceOperationMarker(value: unknown): UserEnhanceOperationMarker | null {
  const text = typeof value === "string" ? value : "";
  if (text.startsWith(USER_ENHANCE_DISPATCH_MARKER)) {
    const [expiresRaw, token, ...extra] = text.slice(USER_ENHANCE_DISPATCH_MARKER.length).split("|");
    const leaseExpiresAt = Number(expiresRaw);
    if (
      extra.length
      || !Number.isSafeInteger(leaseExpiresAt)
      || leaseExpiresAt <= 0
      || !token
      || token.length > 128
    ) {
      return null;
    }
    return { phase: "dispatch", kind: null, leaseExpiresAt, token };
  }
  if (text.startsWith(USER_ENHANCE_FINALIZATION_MARKER)) {
    const [kindRaw, expiresRaw, token, ...extra] = text.slice(USER_ENHANCE_FINALIZATION_MARKER.length).split("|");
    const leaseExpiresAt = Number(expiresRaw);
    if (
      extra.length
      || !["succeeded", "definitive_failure", "pending_reconcile"].includes(kindRaw)
      || !Number.isSafeInteger(leaseExpiresAt)
      || leaseExpiresAt <= 0
      || !token
      || token.length > 128
    ) {
      return null;
    }
    return {
      phase: "finalize",
      kind: kindRaw as UserEnhanceFinalizationKind,
      leaseExpiresAt,
      token,
    };
  }
  return null;
}

function stableUserEnhanceHash(value: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function userEnhanceIdempotencyRequestHash(input: {
  workspaceId: string;
  sourceAssetId?: string | null;
  sourceUrl?: string | null;
  sourceResolution: unknown;
  targetResolution: unknown;
}): string {
  return stableUserEnhanceHash({
    version: "user-video-enhance-idempotency/v1",
    workspaceId: input.workspaceId,
    sourceAssetId: String(input.sourceAssetId || "").trim() || null,
    sourceUrl: String(input.sourceUrl || "").trim() || null,
    sourceResolution: normalizeVideoResolution(input.sourceResolution) || String(input.sourceResolution || ""),
    targetResolution: normalizeVideoResolution(input.targetResolution) || String(input.targetResolution || ""),
  });
}

function taskRequestId(taskId: string, requestHash: string): string {
  return `${enhanceBillingKey(taskId)}:${requestHash}`;
}

function requestHashFromTask(task: UserVideoEnhanceTask): string | null {
  const match = String(task.requestId || "").match(/:([a-f0-9]{64})$/);
  return match?.[1] ?? null;
}

function assertIdempotentRequestMatch(task: UserVideoEnhanceTask, requestHash: string): void {
  if (requestHashFromTask(task) !== requestHash) {
    throw new UserVideoEnhanceError(
      "同一 idempotencyKey 对应的增强请求参数不一致",
      409,
      "ENHANCE_IDEMPOTENCY_MISMATCH",
    );
  }
}

function enhanceBillingMutationFence(
  task: UserVideoEnhanceTask,
  phase: "dispatch" | "finalize",
  finalizationClaim?: UserVideoEnhanceFinalizationClaim,
) {
  if (phase === "finalize") {
    if (
      !finalizationClaim
      || finalizationClaim.taskId !== task.id
      || finalizationClaim.leaseExpiresAt <= now()
      || task.finalizationLeaseOwner !== finalizationClaim.owner
      || task.finalizationFence !== finalizationClaim.fence
      || task.finalizationLeaseExpiresAt !== finalizationClaim.leaseExpiresAt
      || task.status !== "reconciling"
    ) {
      throw new UserVideoEnhanceError(
        "增强任务 DB claim/fence 已失效",
        409,
        "ENHANCE_BILLING_FENCE_LOST",
      );
    }
    return {
      kind: "user_video_enhance_operation/v1" as const,
      phase: "finalize" as const,
      taskId: task.id,
      workspaceId: task.workspaceId,
      owner: finalizationClaim.owner,
      fence: finalizationClaim.fence,
      leaseExpiresAt: finalizationClaim.leaseExpiresAt,
    };
  }
  const marker = parseUserEnhanceOperationMarker(task.errorMessage);
  if (marker?.phase !== "dispatch" || marker.leaseExpiresAt <= now()) {
    throw new UserVideoEnhanceError(
      "增强任务计费写入 lease/fence 已失效",
      409,
      "ENHANCE_BILLING_FENCE_LOST",
    );
  }
  return {
    kind: "user_video_enhance_operation/v1" as const,
    phase: "dispatch" as const,
    taskId: task.id,
    workspaceId: task.workspaceId,
    marker: String(task.errorMessage),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pricingRuleMatchesPair(
  row: any,
  sourceResolution: PublicVideoResolution,
  targetResolution: PublicVideoResolution,
): boolean {
  const config = parseJsonObject(row.ruleConfig);
  return normalizeVideoResolution(config.sourceResolution) === sourceResolution
    && normalizeVideoResolution(config.targetResolution) === targetResolution;
}

function pricingSnapshotFromRow(row: any): UserVideoEnhancePricingSnapshot | null {
  const unitPriceMicros = Number(row.unitPriceMicros);
  if (
    String(row.unit || "").trim() !== "second"
    || String(row.currency || "").trim().toUpperCase() !== "GU"
    || !Number.isSafeInteger(unitPriceMicros)
    || unitPriceMicros <= 0
  ) {
    return null;
  }
  return {
    pricingRuleId: String(row.id),
    unit: "second",
    unitPriceMicros,
    currency: "GU",
  };
}

/**
 * Resolve the exact source→target `video_enhance` rule configured by admin.
 * Workspace rules shadow platform rules for the same pair. An invalid
 * workspace override fails closed instead of silently falling back to a
 * cheaper/different platform contract.
 */
export async function quoteConfiguredUserVideoEnhance(
  input: UserVideoEnhanceQuoteInput,
  workspaceId?: string | null,
): Promise<UserVideoEnhanceQuote> {
  const validation = quoteUserVideoEnhance(input, null);
  if (validation.reasonCode !== "ENHANCE_PRICE_UNAVAILABLE") return validation;

  const sourceResolution = validation.sourceResolution;
  const targetResolution = validation.targetResolution;
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const rows = await db("o_pricing_rule")
    .where({ endpointType: USER_VIDEO_ENHANCE_BILLING_SUBJECT, disabled: 0 })
    .where((builder) => {
      builder.where((platform) => platform.where({ scope: "platform" }).whereNull("workspaceId"));
      if (normalizedWorkspaceId) {
        builder.orWhere({ scope: "workspace", workspaceId: normalizedWorkspaceId });
      }
    })
    .orderBy("updateTime", "desc")
    .orderBy("id", "asc");

  const pairRows = rows.filter((row: any) =>
    !isValueVideoFulfillmentPrice(row)
    && pricingRuleMatchesPair(row, sourceResolution, targetResolution)
    && !String(row.provider || "").trim()
    && !String(row.model || "").trim());
  const workspaceRows = normalizedWorkspaceId
    ? pairRows.filter((row: any) => String(row.scope) === "workspace" && String(row.workspaceId) === normalizedWorkspaceId)
    : [];
  const selectedScopeRows = workspaceRows.length > 0
    ? workspaceRows
    : pairRows.filter((row: any) => String(row.scope) === "platform");
  const pricing = selectedScopeRows.map(pricingSnapshotFromRow).find(Boolean) || null;
  if (!pricing) {
    throw new UserVideoEnhanceError(
      `当前未配置 ${sourceResolution}→${targetResolution} 的可用增强价格`,
      503,
      "ENHANCE_PRICE_UNAVAILABLE",
    );
  }

  const quote = quoteUserVideoEnhance(input, pricing);
  if (!quote.allowed) {
    throw new UserVideoEnhanceError(
      quote.reason || "增强价格配置无效",
      503,
      quote.reasonCode || "ENHANCE_PRICE_INVALID",
    );
  }
  return quote;
}

function readByPath(obj: any, pathExpr: string): unknown {
  return pathExpr.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function pickFirst(obj: any, paths: string[]): unknown {
  for (const pathExpr of paths) {
    const value = readByPath(obj, pathExpr);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function cleanEndpoint(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function redactEnhanceText(value: unknown): string {
  return redactSensitiveText(String(value ?? ""))
    .replace(/([?&](?:x-amz-signature|signature|token|api[-_]?key|apikey|access[-_]?key|security-token|credential)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[REDACTED]");
}

function extractVideoUrl(payload: Record<string, unknown>): string | null {
  const value =
    pickFirst(payload, [
      "content.video_url",
      "content.video.url",
      "video_url",
      "video.url",
      "output.video_url",
      "output.url",
      "data.content.video_url",
      "data.output.video_url",
      "data.output.url",
      "data.video_url",
      "data.url",
      "result.video_url",
      "result.url",
    ]) || (Array.isArray((payload as any).output) ? (payload as any).output[0]?.url || (payload as any).output[0]?.video_url : null);
  return value ? String(value) : null;
}

function extractProviderTaskId(payload: Record<string, unknown>): string | null {
  const value = pickFirst(payload, ["id", "task_id", "taskId", "data.id", "data.task_id", "data.taskId", "result.id"]);
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function responseErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  return redactEnhanceText(
    pickFirst(payload, ["error.message", "error", "message", "msg", "data.error.message", "data.message", "result.error.message"]) ||
      fallback,
  );
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { data: parsed };
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function parseTaskRow(row: any): UserVideoEnhanceTask {
  return {
    id: String(row.id),
    kind: String(row.kind || USER_VIDEO_ENHANCE_TASK_KIND),
    workspaceId: String(row.workspaceId),
    projectId: Number.isSafeInteger(Number(row.projectId))
      && Number(row.projectId) > 0
      ? Number(row.projectId)
      : null,
    userId: row.userId == null ? null : Number(row.userId),
    sourceAssetId: row.sourceAssetId == null ? null : String(row.sourceAssetId),
    sourceUrl: String(row.sourceUrl || ""),
    sourceResolution: String(row.sourceResolution || ""),
    targetResolution: String(row.targetResolution || ""),
    durationSeconds: Number(row.durationSeconds || 0),
    enhanceChannelId: row.enhanceChannelId == null ? null : String(row.enhanceChannelId),
    provider: row.provider == null ? null : String(row.provider),
    providerTaskId: row.providerTaskId == null ? null : String(row.providerTaskId),
    status: (["created", "enhancing", "reconciling", "succeeded", "failed"].includes(String(row.status))
      ? String(row.status)
      : "created") as UserVideoEnhanceTaskStatus,
    quote: parseJsonObject(row.quoteJson) as unknown as UserVideoEnhanceQuote,
    reservationId: row.reservationId == null ? null : String(row.reservationId),
    usageRecordId: row.usageRecordId == null ? null : String(row.usageRecordId),
    billingReconciliationState: ([
      "pending",
      "not_billed",
      "reserved",
      "settlement_pending",
      "settled",
      "release_pending",
      "released",
      "unknown",
    ].includes(String(row.billingReconciliationState))
      ? String(row.billingReconciliationState)
      : "unknown") as UserVideoEnhanceBillingReconciliationState,
    billingReconciliationEvidence: parseJsonObject(
      row.billingReconciliationEvidenceJson,
    ),
    billingReconciliationError:
      row.billingReconciliationError == null
        ? null
        : String(row.billingReconciliationError),
    billingReconciliationUpdatedAt: Number(
      row.billingReconciliationUpdatedAt || 0,
    ),
    finalizationLeaseOwner:
      row.finalizationLeaseOwner == null
        ? null
        : String(row.finalizationLeaseOwner),
    finalizationLeaseExpiresAt:
      row.finalizationLeaseExpiresAt == null
        ? null
        : Number(row.finalizationLeaseExpiresAt),
    finalizationFence: Number(row.finalizationFence || 0),
    resultAssetId: row.resultAssetId == null ? null : String(row.resultAssetId),
    resultUrl: row.resultUrl == null ? null : String(row.resultUrl),
    errorMessage: row.errorMessage == null ? null : String(row.errorMessage),
    idempotencyKey: row.idempotencyKey == null ? null : String(row.idempotencyKey),
    requestId: row.requestId == null ? null : String(row.requestId),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

export async function readUserVideoEnhanceTask(
  taskId: string,
  workspaceId: string,
): Promise<UserVideoEnhanceTask | null> {
  const row = await db(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({ id: String(taskId), workspaceId: String(workspaceId), kind: USER_VIDEO_ENHANCE_TASK_KIND })
    .first();
  return row ? parseTaskRow(row) : null;
}

async function followActiveUserVideoEnhanceFinalization(
  fallback: UserVideoEnhanceTask,
): Promise<UserVideoEnhanceTask> {
  let task = (await readUserVideoEnhanceTask(
    fallback.id,
    fallback.workspaceId,
  )) || fallback;
  const deadline = now() + 2_000;
  while (
    task.status === "reconciling"
    && task.finalizationLeaseExpiresAt != null
    && task.finalizationLeaseExpiresAt > now()
    && now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    task = (await readUserVideoEnhanceTask(
      fallback.id,
      fallback.workspaceId,
    )) || task;
  }
  return task;
}

export interface UserVideoEnhanceFinalizationClaim {
  taskId: string;
  owner: string;
  fence: number;
  leaseExpiresAt: number;
}

function enhanceFinalizationLeaseMs(): number {
  const configured = Number(
    process.env.FANJIN_VIDEO_ENHANCE_FINALIZATION_LEASE_MS || 15 * 60_000,
  );
  return Number.isSafeInteger(configured)
    && configured >= 30_000
    && configured <= 60 * 60_000
    ? configured
    : 15 * 60_000;
}

function finalizationLeaseLost(): UserVideoEnhanceError {
  return new UserVideoEnhanceError(
    "视频增强终结租约已失效",
    409,
    "ENHANCE_FINALIZATION_LEASE_LOST",
  );
}

async function updateTask(
  taskId: string,
  patch: Record<string, unknown>,
  claim?: UserVideoEnhanceFinalizationClaim,
): Promise<void> {
  let query = db(USER_VIDEO_ENHANCE_TASK_TABLE).where({ id: taskId });
  if (claim) {
    query = query.where({
      finalizationLeaseOwner: claim.owner,
      finalizationFence: claim.fence,
      status: "reconciling",
    }).where("finalizationLeaseExpiresAt", ">", now());
  }
  const updated = await query.update({ ...patch, updatedAt: now() });
  if (claim && Number(updated) !== 1) throw finalizationLeaseLost();
}

export async function claimUserVideoEnhanceFinalization(
  input: {
    taskId: string;
    workspaceId: string;
    owner?: string;
    now?: number;
    leaseMs?: number;
    kind?: UserEnhanceFinalizationKind;
  },
  database: Knex = db,
): Promise<{
  claim: UserVideoEnhanceFinalizationClaim;
  task: UserVideoEnhanceTask;
} | null> {
  const timestamp = input.now ?? now();
  const leaseMs = input.leaseMs ?? enhanceFinalizationLeaseMs();
  const owner = String(input.owner || crypto.randomUUID()).trim();
  if (!owner || owner.length > 255) {
    throw new UserVideoEnhanceError(
      "视频增强终结 owner 无效",
      500,
      "ENHANCE_FINALIZATION_OWNER_INVALID",
    );
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new UserVideoEnhanceError(
      "视频增强终结租约时长无效",
      500,
      "ENHANCE_FINALIZATION_LEASE_INVALID",
    );
  }

  const snapshot = await database(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: input.taskId,
      workspaceId: input.workspaceId,
    })
    .whereIn("billingReconciliationState", [
      "reserved",
      "settlement_pending",
    ])
    .where((builder) => {
      builder.whereIn("status", ["created", "enhancing"]).orWhere((expired) => {
        expired
          .where("status", "reconciling")
          .andWhere((lease) => {
            lease
              .whereNull("finalizationLeaseOwner")
              .orWhereNull("finalizationLeaseExpiresAt")
              .orWhere("finalizationLeaseExpiresAt", "<=", timestamp);
          });
      });
    })
    .select("finalizationFence")
    .first();
  if (!snapshot) return null;
  const expectedFence = Number(snapshot.finalizationFence || 0);
  const leaseExpiresAt = timestamp + leaseMs;
  const finalizationMarker = createUserEnhanceOperationMarker(
    "finalize",
    input.kind ?? "succeeded",
    leaseExpiresAt,
  );
  const updated = await database(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: input.taskId,
      workspaceId: input.workspaceId,
      finalizationFence: expectedFence,
    })
    .whereIn("billingReconciliationState", [
      "reserved",
      "settlement_pending",
    ])
    .where((builder) => {
      builder.whereIn("status", ["created", "enhancing"]).orWhere((expired) => {
        expired
          .where("status", "reconciling")
          .andWhere((lease) => {
            lease
              .whereNull("finalizationLeaseOwner")
              .orWhereNull("finalizationLeaseExpiresAt")
              .orWhere("finalizationLeaseExpiresAt", "<=", timestamp);
          });
      });
    })
    .update({
      status: "reconciling",
      finalizationLeaseOwner: owner,
      finalizationLeaseExpiresAt: leaseExpiresAt,
      finalizationFence: expectedFence + 1,
      errorMessage: finalizationMarker,
      updatedAt: timestamp,
    });
  if (Number(updated) !== 1) return null;
  const row = await database(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: input.taskId,
      workspaceId: input.workspaceId,
      finalizationLeaseOwner: owner,
      finalizationFence: expectedFence + 1,
    })
    .first();
  if (!row) throw finalizationLeaseLost();
  return {
    claim: {
      taskId: input.taskId,
      owner,
      fence: expectedFence + 1,
      leaseExpiresAt,
    },
    task: parseTaskRow(row),
  };
}

export async function assertUserVideoEnhanceFinalizationClaim(
  claim: UserVideoEnhanceFinalizationClaim,
  database: Knex | Knex.Transaction = db,
  timestamp = now(),
): Promise<void> {
  const row = await database(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: claim.taskId,
      status: "reconciling",
      finalizationLeaseOwner: claim.owner,
      finalizationFence: claim.fence,
    })
    .where("finalizationLeaseExpiresAt", ">", timestamp)
    .select("id")
    .first();
  if (!row) throw finalizationLeaseLost();
}

async function renewUserVideoEnhanceFinalization(
  claim: UserVideoEnhanceFinalizationClaim,
): Promise<UserVideoEnhanceFinalizationClaim> {
  const timestamp = now();
  const leaseExpiresAt = timestamp + enhanceFinalizationLeaseMs();
  const current = await db(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: claim.taskId,
      status: "reconciling",
      finalizationLeaseOwner: claim.owner,
      finalizationFence: claim.fence,
      finalizationLeaseExpiresAt: claim.leaseExpiresAt,
    })
    .where("finalizationLeaseExpiresAt", ">", timestamp)
    .first("errorMessage");
  if (!current) throw finalizationLeaseLost();
  const marker = parseUserEnhanceOperationMarker(current.errorMessage);
  const updated = await db(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: claim.taskId,
      status: "reconciling",
      finalizationLeaseOwner: claim.owner,
      finalizationFence: claim.fence,
      finalizationLeaseExpiresAt: claim.leaseExpiresAt,
    })
    .where("finalizationLeaseExpiresAt", ">", timestamp)
    .update({
      finalizationLeaseExpiresAt: leaseExpiresAt,
      ...(marker?.phase === "finalize" && marker.kind
        ? {
            errorMessage: createUserEnhanceOperationMarker(
              "finalize",
              marker.kind,
              leaseExpiresAt,
            ),
          }
        : {}),
      updatedAt: timestamp,
    });
  if (Number(updated) !== 1) throw finalizationLeaseLost();
  return { ...claim, leaseExpiresAt };
}

function billingReconciliationEvidence(input: {
  task: UserVideoEnhanceTask;
  outcome: UserVideoEnhanceBillingReconciliationState;
  observedAt: number;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    version: "user-video-enhance-billing-reconciliation.v1",
    taskId: input.task.id,
    billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
    outcome: input.outcome,
    reservationId: input.task.reservationId,
    usageRecordId: input.task.usageRecordId,
    observedAt: input.observedAt,
    ...(input.details || {}),
  };
}

async function persistBillingReconciliation(
  task: UserVideoEnhanceTask,
  state: UserVideoEnhanceBillingReconciliationState,
  input: {
    error?: string | null;
    details?: Record<string, unknown>;
    status?: UserVideoEnhanceTaskStatus;
    extra?: Record<string, unknown>;
    finalizationClaim?: UserVideoEnhanceFinalizationClaim;
    releaseFinalizationClaim?: boolean;
  } = {},
): Promise<UserVideoEnhanceTask> {
  const observedAt = now();
  const error = input.error
    ? redactEnhanceText(input.error).slice(0, 500)
    : null;
  const evidence = billingReconciliationEvidence({
    task,
    outcome: state,
    observedAt,
    details: input.details,
  });
  const releasePatch = input.releaseFinalizationClaim
    ? {
        finalizationLeaseOwner: null,
        finalizationLeaseExpiresAt: null,
      }
    : {};
  await updateTask(task.id, {
    ...(input.extra || {}),
    ...releasePatch,
    ...(input.status ? { status: input.status } : {}),
    billingReconciliationState: state,
    billingReconciliationEvidenceJson: JSON.stringify(evidence),
    billingReconciliationError: error,
    billingReconciliationUpdatedAt: observedAt,
  }, input.finalizationClaim);
  return {
    ...task,
    ...(input.extra || {}),
    ...releasePatch,
    ...(input.status ? { status: input.status } : {}),
    billingReconciliationState: state,
    billingReconciliationEvidence: evidence,
    billingReconciliationError: error,
    billingReconciliationUpdatedAt: observedAt,
  } as UserVideoEnhanceTask;
}

async function markEnhanceBillingUnknown(
  task: UserVideoEnhanceTask,
  message: string,
  details: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
  finalizationClaim?: UserVideoEnhanceFinalizationClaim,
): Promise<UserVideoEnhanceTask> {
  const safeMessage = redactEnhanceText(message || "增强账务结果未知").slice(
    0,
    500,
  );
  return await persistBillingReconciliation(task, "unknown", {
    error: safeMessage,
    details,
    status: "reconciling",
    extra: {
      ...extra,
      errorMessage: "账务结果待核对，任务尚未完成",
    },
    finalizationClaim,
    releaseFinalizationClaim: Boolean(finalizationClaim),
  });
}

async function compareAndSetTask(
  task: UserVideoEnhanceTask,
  patch: Record<string, unknown>,
): Promise<{ updated: boolean; task: UserVideoEnhanceTask }> {
  const timestamp = now();
  const query = db(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: task.id,
      workspaceId: task.workspaceId,
      kind: USER_VIDEO_ENHANCE_TASK_KIND,
      status: task.status,
      updatedAt: task.updatedAt,
    });
  if (task.errorMessage == null) query.whereNull("errorMessage");
  else query.where({ errorMessage: task.errorMessage });
  const affected = await query.update({ ...patch, updatedAt: timestamp });
  const latest = await readUserVideoEnhanceTask(task.id, task.workspaceId);
  if (!latest) throw new UserVideoEnhanceError("增强任务不存在", 404, "ENHANCE_TASK_NOT_FOUND");
  return { updated: Number(affected || 0) === 1, task: latest };
}

async function updateClaimedTask(
  task: UserVideoEnhanceTask,
  patch: Record<string, unknown>,
): Promise<UserVideoEnhanceTask> {
  const marker = parseUserEnhanceOperationMarker(task.errorMessage);
  if (marker?.phase !== "finalize" || marker.leaseExpiresAt <= now()) {
    const latest = await readUserVideoEnhanceTask(task.id, task.workspaceId);
    if (!latest) throw new UserVideoEnhanceError("增强任务不存在", 404, "ENHANCE_TASK_NOT_FOUND");
    return latest;
  }
  const affected = await db(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: task.id,
      workspaceId: task.workspaceId,
      kind: USER_VIDEO_ENHANCE_TASK_KIND,
      status: "enhancing",
      errorMessage: task.errorMessage,
    })
    .update({ ...patch, updatedAt: now() });
  const latest = await readUserVideoEnhanceTask(task.id, task.workspaceId);
  if (!latest) throw new UserVideoEnhanceError("增强任务不存在", 404, "ENHANCE_TASK_NOT_FOUND");
  if (Number(affected || 0) !== 1) return latest;
  return latest;
}

async function renewClaimedTask(
  task: UserVideoEnhanceTask,
  expectedKind: UserEnhanceFinalizationKind,
): Promise<{ owned: boolean; task: UserVideoEnhanceTask }> {
  const marker = parseUserEnhanceOperationMarker(task.errorMessage);
  if (
    marker?.phase !== "finalize"
    || marker.kind !== expectedKind
    || marker.leaseExpiresAt <= now()
  ) {
    const latest = await readUserVideoEnhanceTask(task.id, task.workspaceId);
    if (!latest) throw new UserVideoEnhanceError("增强任务不存在", 404, "ENHANCE_TASK_NOT_FOUND");
    return { owned: false, task: latest };
  }
  const renewedMarker = createUserEnhanceOperationMarker("finalize", expectedKind);
  const affected = await db(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({
      id: task.id,
      workspaceId: task.workspaceId,
      kind: USER_VIDEO_ENHANCE_TASK_KIND,
      status: "enhancing",
      errorMessage: task.errorMessage,
    })
    .update({ errorMessage: renewedMarker, updatedAt: now() });
  const latest = await readUserVideoEnhanceTask(task.id, task.workspaceId);
  if (!latest) throw new UserVideoEnhanceError("增强任务不存在", 404, "ENHANCE_TASK_NOT_FOUND");
  return { owned: Number(affected || 0) === 1, task: latest };
}

function parseChannelRow(row: any): EnhanceChannelRow {
  return {
    id: String(row.id),
    name: String(row.name || ""),
    provider: String(row.provider || ""),
    baseUrl: row.baseUrl ?? null,
    credentialRef: row.credentialRef ?? null,
    credentialCiphertext: row.credentialCiphertext ?? null,
    config: parseJsonObject(row.configJson),
    timeoutMs: Number(row.timeoutMs || 600000),
    weight: Math.max(0, Number(row.weight || 0)),
    priority: Number(row.priority || 100),
    healthStatus: row.healthStatus == null ? null : String(row.healthStatus),
    concurrencyLimit: Number(row.concurrencyLimit || 0),
  };
}

/** 通道声明支持目标档:config.supportedResolutions 存在时必须包含目标。 */
function channelSupportsTarget(channel: EnhanceChannelRow, targetResolution: PublicVideoResolution): boolean {
  if (!["720p", "1080p", "2k"].includes(targetResolution)) return false;
  const declared = channel.config.supportedResolutions ?? channel.config.resolutions;
  if (!Array.isArray(declared) || declared.length === 0) return true;
  const normalized = declared
    .map((item) => normalizeVideoResolution(item))
    .filter((item): item is string => Boolean(item));
  return normalized.includes(targetResolution);
}

async function channelHasCapacity(channel: EnhanceChannelRow): Promise<boolean> {
  const limit = Number(channel.concurrencyLimit || 0);
  if (!Number.isFinite(limit) || limit <= 0) return true;
  const timestamp = now();
  await db("o_provider_channel_slot").where({ channelId: channel.id }).where("leaseExpiresAt", "<", timestamp).del();
  const [slotRow, taskRow] = await Promise.all([
    db("o_provider_channel_slot").where({ channelId: channel.id }).where("leaseExpiresAt", ">", timestamp).count({ total: "*" }).first(),
    db(USER_VIDEO_ENHANCE_TASK_TABLE).where({ enhanceChannelId: channel.id }).whereIn("status", ["created", "enhancing"]).count({ total: "*" }).first(),
  ]);
  return Number((slotRow as any)?.total || 0) + Number((taskRow as any)?.total || 0) < limit;
}

/**
 * 选超分通道:endpointType=video_upscale、未禁用、平台/本工作区 scope;
 * 健康优先(failed 仅在无健康候选时兜底)、凭据齐备、声明支持目标档,
 * 最后按权重加权随机(权重全零退化为 priority 顺序)。
 */
export async function selectUpscaleChannel(input: {
  workspaceId: string;
  targetResolution: PublicVideoResolution;
}): Promise<EnhanceChannelRow | null> {
  const workspaceId = String(input.workspaceId || "").trim();
  const rows = await (db as Knex)(await mediaServiceTable(db as any))
    .where({ endpointType: "video_upscale", disabled: 0 })
    .where((builder) => {
      builder.where((platformBuilder) => platformBuilder.where("scope", "platform").whereNull("workspaceId"));
      if (workspaceId) builder.orWhere({ scope: "workspace", workspaceId });
    })
    .orderBy("priority", "asc")
    .orderBy("weight", "desc")
    .limit(50);

  const candidates = rows.filter((row) => row.kind !== "mediakit" || mediaKitRuntimeConfig(row, input.targetResolution)).map(parseChannelRow).filter((channel) => {
    if (!channelSupportsTarget(channel, input.targetResolution)) return false;
    return Boolean(
      resolveChannelApiKey(
        channel,
        [],
      ),
    );
  });
  if (!candidates.length) return null;

  const hasNonFailed = candidates.some((channel) => channel.healthStatus !== "failed");
  const healthy = hasNonFailed ? candidates.filter((channel) => channel.healthStatus !== "failed") : candidates;
  const healthRank = (channel: EnhanceChannelRow) =>
    channel.healthStatus === "ok" ? 0 : channel.healthStatus == null || channel.healthStatus === "" ? 1 : channel.healthStatus === "degraded" ? 2 : 3;
  const bestRank = Math.min(...healthy.map(healthRank));
  const pool = healthy.filter((channel) => healthRank(channel) === bestRank);

  const withCapacity: EnhanceChannelRow[] = [];
  for (const channel of pool) {
    if (await channelHasCapacity(channel)) withCapacity.push(channel);
  }
  if (!withCapacity.length) return null;
  return pickWeightedRecipe(withCapacity) || null;
}

/** 与 relay resolveVideoEnhanceConfigForPlan 相同的端点推导,但面向路径 B 选中通道。 */
function resolveEnhanceConfig(channel: EnhanceChannelRow): EnhanceChannelConfig | null {
  const apiKey = resolveChannelApiKey(
    channel,
    [],
  );
  const mode = "generative" as const;
  const submitEndpoint = FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT;
  const statusEndpoint = MEDIAKIT_STATUS_ENDPOINT;
  if (!apiKey || !submitEndpoint) return null;
  return { submitEndpoint, statusEndpoint, apiKey, mode };
}

function optionalEnvNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildEnhanceRequestBody(input: {
  taskId: string;
  sourceUrl: string;
  targetResolution: PublicVideoResolution;
  channelConfig: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    video_url: input.sourceUrl,
    resolution: input.targetResolution,
  };
  const scene = input.channelConfig.scene ?? process.env.VOLCANO_VIDEO_ENHANCE_SCENE;
  const toolVersion = input.channelConfig.tool_version ?? process.env.VOLCANO_VIDEO_ENHANCE_TOOL_VERSION;
  const fps = optionalEnvNumber(String(input.channelConfig.fps ?? process.env.VOLCANO_VIDEO_ENHANCE_FPS ?? ""));
  const bitrateLevel = input.channelConfig.bitrate_level ?? process.env.VOLCANO_VIDEO_ENHANCE_BITRATE_LEVEL;
  if (scene) body.scene = scene;
  if (toolVersion) body.tool_version = toolVersion;
  if (fps !== undefined) body.fps = fps;
  if (bitrateLevel) body.bitrate_level = bitrateLevel;
  if (process.env.VOLCANO_VIDEO_ENHANCE_CLIENT_TOKEN === "task_id") body.client_token = input.taskId;
  return body;
}

function buildPublicMediaUrl(relativeUrl: string): string {
  const base = process.env.FANJIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "";
  if (!base) return relativeUrl;
  return `${base.replace(/\/+$/, "")}${relativeUrl.startsWith("/") ? relativeUrl : `/${relativeUrl}`}`;
}

type MediaUrlPurpose = "source" | "output";

function mediaUrlError(purpose: MediaUrlPurpose, message: string): UserVideoEnhanceError {
  return new UserVideoEnhanceError(
    message,
    purpose === "source" ? 400 : 502,
    purpose === "source" ? "ENHANCE_SOURCE_URL_FORBIDDEN" : "ENHANCE_OUTPUT_URL_FORBIDDEN",
  );
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function mappedIpv4FromIpv6(address: string): string | null {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith("::ffff:")) return null;
  const tail = normalized.slice("::ffff:".length);
  if (tail.includes(".")) return tail;
  const parts = tail.split(":");
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateOrSpecialIp(rawAddress: string): boolean {
  const address = rawAddress.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;
  const mapped = mappedIpv4FromIpv6(address);
  if (mapped) return isPrivateIpv4(mapped);
  return address === "::"
    || address === "::1"
    || /^f[cd]/.test(address)
    || /^fe[89ab]/.test(address)
    || /^fe[c-f]/.test(address)
    || address.startsWith("ff")
    || address.startsWith("100:")
    || address.startsWith("64:ff9b:")
    || address.startsWith("2001:0:")
    || address.startsWith("2001:2:")
    || address.startsWith("2001:db8:")
    || address.startsWith("2002:");
}

function isForbiddenMediaHostname(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname) return true;
  if (isIP(hostname)) return isPrivateOrSpecialIp(hostname);
  return hostname === "localhost"
    || hostname === "metadata"
    || hostname === "metadata.google.internal"
    || hostname === "instance-data"
    || hostname === "kubernetes.default"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
    || hostname.endsWith(".lan");
}

function allowPrivateMediaUrlsForTests(): boolean {
  return process.env.NODE_ENV === "test" && process.env.FANJIN_TEST_ALLOW_PRIVATE_MEDIA_URLS === "1";
}

/** Reject SSRF-sensitive schemes, credentials, hostnames and DNS results. */
export async function validatePublicMediaUrl(rawUrl: string, purpose: MediaUrlPurpose): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw mediaUrlError(purpose, purpose === "source" ? "源视频地址无效" : "增强结果地址无效");
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.username || parsed.password) {
    throw mediaUrlError(purpose, purpose === "source" ? "源视频地址必须是无凭据的 HTTP(S) 公网地址" : "增强结果地址必须是无凭据的 HTTP(S) 公网地址");
  }
  if (allowPrivateMediaUrlsForTests()) return parsed.toString();
  if (isForbiddenMediaHostname(parsed.hostname)) {
    throw mediaUrlError(purpose, purpose === "source" ? "源视频地址不能指向本地、内网或云元数据服务" : "增强结果地址不能指向本地、内网或云元数据服务");
  }
  try {
    const results = await lookup(parsed.hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true });
    if (!results.length || results.some((result) => isPrivateOrSpecialIp(result.address))) {
      throw mediaUrlError(purpose, purpose === "source" ? "源视频地址解析到了非公网地址" : "增强结果地址解析到了非公网地址");
    }
  } catch (err) {
    if (err instanceof UserVideoEnhanceError) throw err;
    throw mediaUrlError(purpose, purpose === "source" ? "源视频公网地址无法解析" : "增强结果公网地址无法解析");
  }
  return parsed.toString();
}

/** 源片地址:超分通道需要可公网访问的 http(s) URL。 */
async function resolveProviderSourceUrl(rawUrl: string): Promise<string> {
  const value = String(rawUrl || "").trim();
  if (/^https?:\/\//i.test(value)) return await validatePublicMediaUrl(value, "source");
  if (value.startsWith("/oss/")) {
    const base = process.env.FANJIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "";
    if (base) return await validatePublicMediaUrl(buildPublicMediaUrl(value), "source");
  }
  throw new UserVideoEnhanceError(
    "源视频地址不可公网访问,请配置 FANJIN_PUBLIC_BASE_URL 或使用可公开访问的源地址",
    400,
    "ENHANCE_SOURCE_NOT_PUBLIC",
  );
}

interface SourceAssetInfo {
  assetId: string;
  projectId: number;
  url: string;
  width: number;
  height: number | null;
  durationMs: number | null;
}

const SOURCE_ASSET_COLUMNS = [
  "asset.id as id",
  "asset.assetType as assetType",
  "asset.url as url",
  "asset.localPath as localPath",
  "asset.mimeType as mimeType",
  "asset.width as width",
  "asset.height as height",
  "asset.durationMs as durationMs",
  "asset.metadata as metadata",
  "asset.workspaceId as workspaceId",
  "asset.projectId as projectId",
  "task.workspaceId as taskWorkspaceId",
  "project.workspaceId as projectWorkspaceId",
  "project.deletionState as projectDeletionState",
] as const;

function applyOwnedAssetScope(query: any, workspaceId: string): void {
  query.where((owner: any) => {
    owner.where("asset.workspaceId", workspaceId).orWhere((legacy: any) => {
      legacy.whereNull("asset.workspaceId").where("task.workspaceId", workspaceId);
    });
  });
  if (!relayMockIsSuccessful()) {
    query.andWhere((realOutput: any) => {
      realOutput.whereNull("task.status").orWhereNot("task.status", "mocked");
    });
  }
}

function sourceAssetUrlCandidates(rawUrl: string): string[] {
  const value = String(rawUrl || "").trim();
  const candidates = new Set<string>();
  if (value) candidates.add(value);
  try {
    const parsed = new URL(value);
    candidates.add(parsed.toString());
    if (parsed.pathname.startsWith("/oss/")) candidates.add(parsed.pathname);
  } catch {
    if (value.startsWith("/oss/")) {
      const publicUrl = buildPublicMediaUrl(value);
      if (publicUrl) candidates.add(publicUrl);
    }
  }
  return [...candidates];
}

async function sourceAssetInfoFromRow(row: any): Promise<SourceAssetInfo> {
  if (String(row.assetType || "") !== "video") {
    throw new UserVideoEnhanceError("源资产不是视频", 400, "ENHANCE_SOURCE_NOT_VIDEO");
  }
  const projectId = Number(row.projectId);
  if (
    !Number.isSafeInteger(projectId)
    || projectId <= 0
    || String(row.projectDeletionState || "") !== "active"
  ) {
    throw new UserVideoEnhanceError(
      "源视频未绑定可用项目",
      409,
      "ENHANCE_PROJECT_NOT_ACTIVE",
    );
  }
  const metadata = parseJsonObject(row.metadata);
  const mediaProbe =
    readRelayMediaProbe(metadata.mediaProbe)
    || readUserEnhanceMediaProbe(metadata.mediaProbe);
  const width = Number(row.width);
  const height = Number(row.height);
  const durationMs = Number(row.durationMs);
  const mimeType = String(row.mimeType || "");
  if (
    !mediaProbe
    || width !== mediaProbe.width
    || height !== mediaProbe.height
    || durationMs !== mediaProbe.durationMs
    || mimeType !== mediaProbe.mimeType
  ) {
    throw new UserVideoEnhanceError(
      "源视频资产缺少可信媒体探测证明，请先完成媒体信息回填",
      422,
      "ENHANCE_SOURCE_MEDIA_UNVERIFIED",
    );
  }
  const declaredLocalPath = String(row.localPath || "").trim();
  if (declaredLocalPath) {
    const canonicalLocalPath = resolveOwnedVideoLocalPath(String(row.url || ""), declaredLocalPath);
    if (!canonicalLocalPath) {
      throw new UserVideoEnhanceError(
        "源视频托管路径与公开地址不一致",
        422,
        "ENHANCE_SOURCE_MEDIA_UNVERIFIED",
      );
    }
    let currentProbe: Awaited<ReturnType<typeof probeVideoFile>>;
    let currentSha256: string;
    try {
      [currentProbe, currentSha256] = await Promise.all([
        probeVideoFile(canonicalLocalPath),
        sha256VideoFile(canonicalLocalPath),
      ]);
    } catch {
      throw new UserVideoEnhanceError(
        "源视频当前文件无法通过媒体复验",
        422,
        "ENHANCE_SOURCE_MEDIA_UNVERIFIED",
      );
    }
    if (
      currentProbe.width !== mediaProbe.width
      || currentProbe.height !== mediaProbe.height
      || currentProbe.durationMs !== mediaProbe.durationMs
      || currentSha256 !== mediaProbe.contentSha256
    ) {
      throw new UserVideoEnhanceError(
        "源视频媒体证明与当前文件不一致",
        422,
        "ENHANCE_SOURCE_MEDIA_UNVERIFIED",
      );
    }
  }
  return {
    assetId: String(row.id),
    projectId,
    url: await resolveProviderSourceUrl(String(row.url || "")),
    width,
    height,
    durationMs,
  };
}

async function resolveSourceAsset(input: {
  workspaceId: string;
  sourceAssetId?: string | null;
  sourceUrl?: string | null;
}): Promise<SourceAssetInfo> {
  if (input.sourceAssetId) {
    const query = db("o_media_asset as asset")
      .leftJoin("o_relay_task as task", "task.id", "asset.taskId")
      .innerJoin("o_project as project", "project.id", "asset.projectId")
      .where({ "asset.id": String(input.sourceAssetId) })
      .where({
        "project.workspaceId": input.workspaceId,
        "project.deletionState": "active",
      })
      .select(...SOURCE_ASSET_COLUMNS);
    applyOwnedAssetScope(query, input.workspaceId);
    const row = await query.first();
    if (!row) {
      throw new UserVideoEnhanceError("源视频资产不存在", 404, "ENHANCE_SOURCE_NOT_FOUND");
    }
    return await sourceAssetInfoFromRow(row);
  }
  if (input.sourceUrl) {
    // Validate the caller URL first, then resolve it back to an owned asset.
    // Canvas callers historically only send `videoUrl`; exact and /oss/
    // normalized matching preserves that path without trusting their duration.
    await resolveProviderSourceUrl(String(input.sourceUrl));
    const candidates = sourceAssetUrlCandidates(String(input.sourceUrl));
    const query = db("o_media_asset as asset")
      .leftJoin("o_relay_task as task", "task.id", "asset.taskId")
      .innerJoin("o_project as project", "project.id", "asset.projectId")
      .where({ "asset.assetType": "video" })
      .whereIn("asset.url", candidates)
      .where({
        "project.workspaceId": input.workspaceId,
        "project.deletionState": "active",
      })
      .select(...SOURCE_ASSET_COLUMNS)
      .orderBy("asset.createTime", "desc");
    applyOwnedAssetScope(query, input.workspaceId);
    const row = await query.first();
    if (!row) {
      throw new UserVideoEnhanceError(
        "源视频必须先保存为当前工作区资产，才能由服务端确认时长并计费",
        422,
        "ENHANCE_SOURCE_ASSET_REQUIRED",
      );
    }
    return await sourceAssetInfoFromRow(row);
  }
  throw new UserVideoEnhanceError("需要 sourceAssetId 或 sourceUrl", 400, "ENHANCE_SOURCE_REQUIRED");
}

/** 以源资产实测短边校准源档位(取不超过实测短边的最高公开档)。 */
function deriveSourceResolution(assetWidth: number, assetHeight: number | null): unknown {
  const shortEdge = Math.min(Number(assetWidth), Number(assetHeight));
  if (!Number.isFinite(shortEdge) || shortEdge <= 0) return "480p";
  const tiers: PublicVideoResolution[] = ["720p", "1080p", "2k", "4k"];
  let derived: PublicVideoResolution | null = null;
  for (const tier of tiers) {
    if (videoResolutionHeight(tier) <= shortEdge) derived = tier;
  }
  // 实测低于 720:返回占位低值,交给 quote 统一拒绝(源须 ≥720p)。
  return derived || "480p";
}

interface MirroredEnhanceOutput extends SafeMirroredVideo {
  url: string;
  localPath: string | null;
  storageKey: string | null;
  writeIntentClaim: ObjectWriteIntentClaim | null;
  mirrored: boolean;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  contentSha256: string | null;
}

function videoExtensionForMimeType(mimeType: string): string {
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/x-matroska") return "mkv";
  if (mimeType === "video/mpeg") return "mpeg";
  return "mp4";
}

export function userVideoEnhanceOutputStorageKey(input: {
  taskId: string;
  projectId: number;
  body: Uint8Array;
  mimeType: string;
  intentId?: string;
}): string {
  const taskId = String(input.taskId || "").trim();
  if (
    !taskId
    || !Number.isSafeInteger(input.projectId)
    || input.projectId <= 0
  ) {
    throw new Error("ENHANCE_OUTPUT_STORAGE_AUTHORITY_INVALID");
  }
  const taskKey = crypto
    .createHash("sha256")
    .update(taskId)
    .digest("hex");
  const contentHash = crypto
    .createHash("sha256")
    .update(input.body)
    .digest("hex");
  const extension = videoExtensionForMimeType(input.mimeType);
  if (input.intentId !== undefined) {
    const intentId = String(input.intentId || "").trim();
    if (
      !intentId
      || intentId.length > 255
      || /[\u0000-\u001f\u007f/\\]/u.test(intentId)
    ) {
      throw new Error("ENHANCE_OUTPUT_WRITE_INTENT_INVALID");
    }
    return `${input.projectId}/video-enhance/${taskKey}/${contentHash}/`
      + `${intentId}.${extension}`;
  }
  return `${input.projectId}/video-enhance/${taskKey}/${contentHash}.${extension}`;
}

async function mirrorEnhancedVideoToServer(
  taskId: string,
  workspaceId: string,
  projectId: number,
  rawUrl: string,
  targetResolution: unknown,
  database: Knex,
  beforeStorageWrite?: () => Promise<void>,
): Promise<MirroredEnhanceOutput> {
  let mirrored: SafeMirroredVideo | null = null;
  try {
    mirrored = await mirrorVideoToOwnedStorage(taskId, rawUrl);
    const normalizedTarget = normalizeVideoResolution(targetResolution);
    if (!normalizedTarget || !isPublicVideoResolution(normalizedTarget)) {
      throw mediaUrlError("output", "增强任务目标档无效");
    }
    const targetHeight = videoResolutionHeight(normalizedTarget);
    if (
      !Number.isSafeInteger(mirrored.width)
      || Number(mirrored.width) <= 0
      || !Number.isSafeInteger(mirrored.height)
      || Number(mirrored.height) <= 0
      || !Number.isSafeInteger(mirrored.durationMs)
      || Number(mirrored.durationMs) <= 0
      || Math.min(Number(mirrored.width), Number(mirrored.height)) < targetHeight
      || !/^[a-f0-9]{64}$/.test(String(mirrored.contentSha256 || ""))
    ) {
      throw mediaUrlError("output", "增强结果实测画面尺寸、时长或内容摘要不符合目标档要求");
    }
    if (!mirrored.mirrored) {
      return {
        ...mirrored,
        storageKey: null,
        writeIntentClaim: null,
      };
    }
    if (!mirrored.localPath || !mirrored.contentSha256) {
      throw mediaUrlError("output", "增强结果未保留可验证的托管文件");
    }
    if (beforeStorageWrite) await beforeStorageWrite();
    const body = await fs.promises.readFile(mirrored.localPath);
    const durable = await writeObjectWithDurableIntent({
      purpose: "video_enhance",
      workspaceId,
      projectId,
      body,
      contentSha256: mirrored.contentSha256,
      storageKey: (intentId) => userVideoEnhanceOutputStorageKey({
        taskId,
        projectId,
        body,
        mimeType: mirrored!.mimeType,
        intentId,
      }),
      writerIdPrefix: "video-enhance",
    }, {
      database,
      writer: u.oss,
    });
    const durableLocalPath = durable.receipt === null
      ? resolveOwnedVideoStorageKeyLocalPath(
          durable.url,
          durable.storageKey,
          durable.storageKey,
        )
      : null;
    if (durable.receipt === null && !durableLocalPath) {
      throw mediaUrlError("output", "增强结果 durable 本地对象无法解析到托管文件");
    }
    return {
      url: durable.url,
      localPath: durableLocalPath,
      storageKey: durable.storageKey,
      writeIntentClaim: durable.claim,
      mirrored: true,
      mimeType: mirrored.mimeType,
      width: mirrored.width,
      height: mirrored.height,
      durationMs: mirrored.durationMs,
      videoCodec: mirrored.videoCodec,
      bitrateBps: mirrored.bitrateBps,
      audioTrackCount: mirrored.audioTrackCount,
      audioCodecs: mirrored.audioCodecs ? [...mirrored.audioCodecs] : null,
      contentLengthBytes: mirrored.contentLengthBytes,
      contentSha256: mirrored.contentSha256,
    };
  } catch (err) {
    if (err instanceof UserVideoEnhanceError) throw err;
    console.warn(
      "[user-video-enhance] mirror/probe failed",
      redactEnhanceText((err as any)?.message || err),
    );
    const failure = mediaUrlError(
      "output",
      "增强结果未通过可信媒体探测或 durable object write",
    ) as UserVideoEnhanceError & {
      cause?: unknown;
    };
    failure.cause = err;
    throw failure;
  } finally {
    if (mirrored?.mirrored) removeMirroredVideo(mirrored);
  }
}

interface EnhanceAssetAuthority {
  task: UserVideoEnhanceTask;
  workspaceId: string;
  projectId: number;
}

async function resolveEnhanceAssetAuthority(
  client: Knex | Knex.Transaction,
  taskId: string,
  options: { lock?: boolean } = {},
): Promise<EnhanceAssetAuthority> {
  const initialTask = await client(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({ id: taskId })
    .first();
  const projectId = Number(initialTask?.projectId);
  const workspaceId = String(initialTask?.workspaceId || "").trim();
  if (
    !initialTask
    || !Number.isSafeInteger(projectId)
    || projectId <= 0
    || !workspaceId
  ) {
    throw new UserVideoEnhanceError(
      "增强任务缺少权威项目归属",
      409,
      "ENHANCE_PROJECT_OWNERSHIP_INVALID",
    );
  }

  let projectQuery = client("o_project")
    .where({
      id: projectId,
      workspaceId,
      deletionState: "active",
    })
    .select("id", "workspaceId", "deletionState");
  if (options.lock && isPostgresClient(client)) {
    projectQuery = projectQuery.forUpdate();
  }
  const project = await projectQuery.first();
  if (!project) {
    throw new UserVideoEnhanceError(
      "增强任务所属项目正在删除或已不可用",
      409,
      "ENHANCE_PROJECT_NOT_ACTIVE",
    );
  }

  let taskRow = initialTask;
  if (options.lock) {
    let taskQuery = client(USER_VIDEO_ENHANCE_TASK_TABLE)
      .where({ id: taskId });
    if (isPostgresClient(client)) taskQuery = taskQuery.forUpdate();
    taskRow = await taskQuery.first();
    if (
      !taskRow
      || Number(taskRow.projectId) !== projectId
      || String(taskRow.workspaceId || "").trim() !== workspaceId
    ) {
      throw new UserVideoEnhanceError(
        "增强任务项目归属已变化",
        409,
        "ENHANCE_PROJECT_OWNERSHIP_CHANGED",
      );
    }
  }

  return {
    task: parseTaskRow(taskRow),
    workspaceId,
    projectId,
  };
}

/** 新资产入库:source=video_enhance,taskId=增强任务 id;原片资产不动。 */
export async function storeEnhancedAsset(
  task: UserVideoEnhanceTask,
  providerUrl: string,
  database: Knex = db,
  finalizationClaim?: UserVideoEnhanceFinalizationClaim,
): Promise<{ assetId: string | null; url: string }> {
  if (finalizationClaim) {
    await assertUserVideoEnhanceFinalizationClaim(
      finalizationClaim,
      database,
    );
  }
  const initialAuthority = await resolveEnhanceAssetAuthority(
    database,
    task.id,
  );
  const mirrored = await mirrorEnhancedVideoToServer(
    initialAuthority.task.id,
    initialAuthority.workspaceId,
    initialAuthority.projectId,
    providerUrl,
    initialAuthority.task.targetResolution,
    database,
    finalizationClaim
      ? async () => {
          const renewedClaim = await renewUserVideoEnhanceFinalization(
            finalizationClaim!,
          );
          // The caller and this storage phase share the same fence object.
          // Mutate it in place so the post-storage settlement does not try
          // to renew the superseded lease expiry and falsely lose ownership.
          Object.assign(finalizationClaim!, renewedClaim);
        }
      : undefined,
  );
  try {
    const assetId = await database.transaction(async (transaction) => {
      if (finalizationClaim) {
        await assertUserVideoEnhanceFinalizationClaim(
          finalizationClaim,
          transaction,
        );
      }
      const authority = await resolveEnhanceAssetAuthority(
        transaction,
        task.id,
        { lock: true },
      );
      if (
        authority.projectId !== initialAuthority.projectId
        || authority.workspaceId !== initialAuthority.workspaceId
      ) {
        throw new UserVideoEnhanceError(
          "增强任务项目归属已变化",
          409,
          "ENHANCE_PROJECT_OWNERSHIP_CHANGED",
        );
      }
      const authoritativeTask = authority.task;
      if (
        authoritativeTask.enhanceChannelId !== task.enhanceChannelId
        || authoritativeTask.providerTaskId !== task.providerTaskId
      ) {
        throw new UserVideoEnhanceError(
          "增强结果来自已失效的供应商尝试",
          409,
          "ENHANCE_PROVIDER_ATTEMPT_STALE",
        );
      }
      if (
        authoritativeTask.resultAssetId
        || authoritativeTask.resultUrl
      ) {
        throw new UserVideoEnhanceError(
          "增强任务已绑定结果资产",
          409,
          "ENHANCE_RESULT_ALREADY_BOUND",
        );
      }
      const referencedAssetId = uuid();
      const sourceAssetId = userEnhanceSourceAssetIdentity({
        taskId: authoritativeTask.id,
        sourceAssetId: authoritativeTask.sourceAssetId,
        sourceUrl: authoritativeTask.sourceUrl,
      });
      const deliveryAssetEvidence = createUserEnhanceAssetEvidenceDescriptor({
        taskId: authoritativeTask.id,
        workspaceId: authority.workspaceId,
        channelId: authoritativeTask.enhanceChannelId || "",
        providerTaskId: authoritativeTask.providerTaskId,
        sourceAssetId,
        resultAssetId: referencedAssetId,
        resultUrl: mirrored.url,
        sourceResolution: authoritativeTask.sourceResolution,
        targetResolution: authoritativeTask.targetResolution,
      });
      if (!deliveryAssetEvidence) {
        throw new UserVideoEnhanceError(
          "增强结果交付证据无法建立",
          409,
          "ENHANCE_RESULT_EVIDENCE_INVALID",
        );
      }
      const mediaProbe = {
        version: "user-video-enhance-media-probe/v1" as const,
        width: Number(mirrored.width),
        height: Number(mirrored.height),
        durationMs: Number(mirrored.durationMs),
        mimeType: mirrored.mimeType,
        contentSha256: String(mirrored.contentSha256),
      };
      const metadata = {
        billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
        sourceAssetId: authoritativeTask.sourceAssetId,
        sourceResolution: authoritativeTask.sourceResolution,
        targetResolution: authoritativeTask.targetResolution,
        durationSeconds: authoritativeTask.durationSeconds,
        enhanceChannelId: authoritativeTask.enhanceChannelId,
        mirrored: mirrored.mirrored,
        width: mirrored.width,
        height: mirrored.height,
        durationMs: mirrored.durationMs,
        mediaProbe,
        deliveryAssetEvidence,
      };
      const existingRows = await transaction("o_media_asset")
        .where({
          taskId: authoritativeTask.id,
          source: USER_VIDEO_ENHANCE_ASSET_SOURCE,
        })
        .select("*");
      if (existingRows.length > 1) {
        throw new UserVideoEnhanceError(
          "增强任务存在重复结果资产",
          409,
          "ENHANCE_RESULT_ASSET_DUPLICATE",
        );
      }
      const existing = existingRows[0];
      if (
        existing
        && (
          (existing.projectId != null
            && Number(existing.projectId) !== authority.projectId)
          || String(existing.workspaceId || "") !== authority.workspaceId
        )
      ) {
        throw new UserVideoEnhanceError(
          "增强结果资产归属冲突",
          409,
          "ENHANCE_RESULT_ASSET_OWNERSHIP_INVALID",
        );
      }
      const patch = {
        workspaceId: authority.workspaceId,
        projectId: authority.projectId,
        assetType: "video",
        url: mirrored.url,
        localPath: mirrored.localPath,
        storageKey: mirrored.storageKey,
        mimeType: mirrored.mimeType,
        width: mirrored.width,
        height: mirrored.height,
        durationMs: mirrored.durationMs,
        metadata: JSON.stringify(metadata),
        createTime: now(),
      };
      if (existing) {
        throw new UserVideoEnhanceError(
          "增强结果资产存在但任务未建立原子绑定",
          409,
          "ENHANCE_RESULT_BINDING_INCOMPLETE",
        );
      }
      await transaction("o_media_asset").insert({
        id: referencedAssetId,
        taskId: authoritativeTask.id,
        source: USER_VIDEO_ENHANCE_ASSET_SOURCE,
        ...patch,
      });
      if (finalizationClaim) {
        const bound = await transaction(USER_VIDEO_ENHANCE_TASK_TABLE)
          .where({
            id: authoritativeTask.id,
            workspaceId: authority.workspaceId,
            status: "reconciling",
            finalizationLeaseOwner: finalizationClaim.owner,
            finalizationFence: finalizationClaim.fence,
          })
          .where("finalizationLeaseExpiresAt", ">", now())
          .update({
            resultAssetId: referencedAssetId,
            resultUrl: mirrored.url,
            updatedAt: now(),
          });
        if (Number(bound) !== 1) throw finalizationLeaseLost();
      }
      if (mirrored.writeIntentClaim && mirrored.storageKey) {
        await commitObjectWriteIntentInTransaction(
          transaction,
          mirrored.writeIntentClaim,
          createObjectWriteMediaReferenceEvidence({
            rowId: referencedAssetId,
            workspaceId: authority.workspaceId,
            projectId: authority.projectId,
            storageKey: mirrored.storageKey,
            publicUrl: mirrored.url,
          }),
        );
      }
      return referencedAssetId;
    });
    return { assetId, url: mirrored.url };
  } catch (error) {
    if (mirrored.writeIntentClaim) {
      try {
        await queueDurableObjectWriteCompensation(
          mirrored.writeIntentClaim,
          error,
          { database },
        );
      } catch (queueError) {
        const failure = new UserVideoEnhanceError(
          "增强结果落库失败且 durable compensation 无法入队",
          500,
          "ENHANCE_RESULT_ASSET_COMPENSATION_QUEUE_FAILED",
        ) as UserVideoEnhanceError & {
          cause?: unknown;
          queueCause?: unknown;
        };
        failure.cause = error;
        failure.queueCause = queueError;
        throw failure;
      }
    }
    throw error;
  }
}

function enhanceBillingKey(taskId: string): string {
  return `user-video-enhance:${taskId}`;
}

function quoteCostMicros(quote: UserVideoEnhanceQuote): number {
  if (quote.authoritativeDuration !== true) {
    throw new UserVideoEnhanceError(
      "增强报价缺少服务端权威时长",
      500,
      "ENHANCE_QUOTE_NOT_AUTHORITATIVE",
    );
  }
  const micros = Number(quote.amountMicros);
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new UserVideoEnhanceError("增强报价金额无效", 500, "ENHANCE_QUOTE_INVALID");
  }
  return micros;
}

function enhanceBillingRequestHash(task: UserVideoEnhanceTask): string {
  return stableUserEnhanceHash({
    version: "user-video-enhance-billing/v1",
    taskId: task.id,
    workspaceId: task.workspaceId,
    sourceAssetId: task.sourceAssetId,
    sourceUrl: task.sourceUrl,
    sourceResolution: task.sourceResolution,
    targetResolution: task.targetResolution,
    durationSeconds: task.durationSeconds,
    channelId: task.enhanceChannelId,
    provider: task.provider,
    pricingRuleId: task.quote.pricingRuleId,
    amountMicros: quoteCostMicros(task.quote),
  });
}

/** video_enhance 科目冻结(预扣)。金额取服务端复核后的 quote,不信客户端。 */
async function freezeEnhanceBilling(
  task: UserVideoEnhanceTask,
  channel: EnhanceChannelRow,
): Promise<{ reservationId: string; usageRecordId: string }> {
  const billingKey = enhanceBillingKey(task.id);
  const costMicros = quoteCostMicros(task.quote);
  const result = await billApiTask({
    workspaceId: task.workspaceId,
    endpointType: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
    provider: channel.provider || null,
    channelId: channel.id,
    units: Math.max(1, task.quote.durationSeconds),
    unit: "second",
    costMicros,
    currency: "GU",
    chargeMode: "reserve",
    taskId: task.id,
    idempotencyKey: `${billingKey}:reserve`,
    requestId: task.requestId || billingKey,
    description: `创作台视频画质增强 ${task.quote.sourceResolution}→${task.quote.targetResolution}`,
    metadata: {
      billingKey,
      billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
      billingLifecycleState: "reserved",
      taskId: task.id,
      businessTaskKind: USER_VIDEO_ENHANCE_TASK_KIND,
      requestHash: enhanceBillingRequestHash(task),
      sourceResolution: task.quote.sourceResolution,
      targetResolution: task.quote.targetResolution,
      durationSeconds: task.quote.durationSeconds,
      priceSnapshot: {
        billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
        pricingRuleId: task.quote.pricingRuleId,
        sourceResolution: task.quote.sourceResolution,
        targetResolution: task.quote.targetResolution,
        unitPriceMicros: task.quote.unitPriceMicros,
        amountMicros: task.quote.amountMicros,
        unitPriceGu: task.quote.unitPriceGu,
        amountGu: task.quote.amountGu,
        costMicros,
        currency: "GU",
      },
    },
    operatorUserId: task.userId,
  });
  if (!result.ledger) {
    throw new UserVideoEnhanceError("增强预扣未生成冻结流水", 500, "ENHANCE_BILLING_RESERVE_FAILED");
  }
  return { reservationId: result.ledger.id, usageRecordId: result.usage.id };
}

async function settleEnhanceBilling(
  task: UserVideoEnhanceTask,
  finalizationClaim: UserVideoEnhanceFinalizationClaim,
) {
  if (!task.reservationId) throw new UserVideoEnhanceError("增强任务缺少冻结流水,无法结算", 500, "ENHANCE_BILLING_SETTLE_FAILED");
  const billingKey = enhanceBillingKey(task.id);
  return await settleApiTaskReservation({
    workspaceId: task.workspaceId,
    reservationId: task.reservationId,
    actualCostMicros: quoteCostMicros(task.quote),
    units: Math.max(1, task.quote.durationSeconds),
    unit: "second",
    provider: task.provider,
    channelId: task.enhanceChannelId,
    requestId: task.requestId || billingKey,
    idempotencyKey: billingKey,
    description: `创作台视频画质增强结算 ${task.quote.sourceResolution}→${task.quote.targetResolution}`,
    metadata: {
      billingKey,
      billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
      businessTaskKind: USER_VIDEO_ENHANCE_TASK_KIND,
      taskId: task.id,
      requestHash: enhanceBillingRequestHash(task),
      settlementEvidenceComplete: true,
      settlementUnit: "second",
      priceSnapshot: {
        pricingRuleId: task.quote.pricingRuleId,
        unitPriceMicros: task.quote.unitPriceMicros,
        amountMicros: task.quote.amountMicros,
        currency: task.quote.currency,
      },
    },
    operatorUserId: task.userId,
    mutationFence: enhanceBillingMutationFence(
      task,
      "finalize",
      finalizationClaim,
    ),
  });
}

async function markEnhanceBillingDispatched(task: UserVideoEnhanceTask): Promise<void> {
  if (!task.reservationId) {
    throw new UserVideoEnhanceError(
      "增强任务缺少冻结流水，禁止调用上游",
      500,
      "ENHANCE_BILLING_DISPATCH_FAILED",
    );
  }
  await markApiTaskReservationDispatched({
    workspaceId: task.workspaceId,
    reservationId: task.reservationId,
    provider: task.provider,
    channelId: task.enhanceChannelId,
    requestId: task.requestId,
    mutationFence: enhanceBillingMutationFence(task, "dispatch"),
  });
}

async function markEnhanceBillingPending(
  task: UserVideoEnhanceTask,
  reason: string,
  evidence: Record<string, unknown> = {},
  finalizationClaim?: UserVideoEnhanceFinalizationClaim,
): Promise<void> {
  if (!task.reservationId) {
    throw new UserVideoEnhanceError(
      "增强任务缺少冻结流水，无法进入待核账",
      500,
      "ENHANCE_BILLING_RECONCILE_FAILED",
    );
  }
  const settlementEvidenceComplete = reason === "settlement_failed";
  await markApiTaskReservationPendingReconcile({
    workspaceId: task.workspaceId,
    reservationId: task.reservationId,
    units: Math.max(1, task.quote.durationSeconds),
    unit: "second",
    actualCostMicros: quoteCostMicros(task.quote),
    provider: task.provider,
    channelId: task.enhanceChannelId,
    reason,
    metadata: {
      billingKey: enhanceBillingKey(task.id),
      billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
      businessTaskKind: USER_VIDEO_ENHANCE_TASK_KIND,
      taskId: task.id,
      requestHash: enhanceBillingRequestHash(task),
      settlementEvidenceComplete,
      settlementUnit: "second",
      priceSnapshot: {
        pricingRuleId: task.quote.pricingRuleId,
        unitPriceMicros: task.quote.unitPriceMicros,
        amountMicros: task.quote.amountMicros,
        currency: task.quote.currency,
      },
      ...evidence,
    },
    ...(finalizationClaim
      ? {
          mutationFence: enhanceBillingMutationFence(
            task,
            "finalize",
            finalizationClaim,
          ),
        }
      : {}),
  });
}

async function releaseEnhanceBilling(
  task: UserVideoEnhanceTask,
  reason: string,
  releaseProof: "not_dispatched" | "definitive_not_billable",
) {
  if (!task.reservationId) return;
  const billingKey = enhanceBillingKey(task.id);
  return await releaseApiTaskReservation({
    workspaceId: task.workspaceId,
    reservationId: task.reservationId,
    requestId: task.requestId || billingKey,
    idempotencyKey: billingKey,
    provider: task.provider,
    channelId: task.enhanceChannelId,
    description: reason,
    metadata: { billingKey, billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT, taskId: task.id, reason },
    releaseProof,
    operatorUserId: task.userId,
  });
}

type SubmitOutcome =
  | { kind: "succeeded"; url: string; payload: Record<string, unknown> }
  | { kind: "accepted"; providerTaskId: string; payload: Record<string, unknown> }
  | { kind: "uncertain"; message: string; payload: Record<string, unknown>; reason: string };

async function submitEnhanceToChannel(
  task: UserVideoEnhanceTask,
  channel: EnhanceChannelRow,
  config: EnhanceChannelConfig,
): Promise<SubmitOutcome> {
  const response = await fetchWithTimeout(
    config.submitEndpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(
        buildEnhanceRequestBody({
          taskId: task.id,
          sourceUrl: task.sourceUrl,
          targetResolution: task.quote.targetResolution,
          channelConfig: channel.config,
        }),
      ),
    },
    Number(process.env.FANJIN_VIDEO_ENHANCE_TIMEOUT_MS || channel.timeoutMs || 600000),
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message = responseErrorMessage(payload, response.statusText || "超分通道调用失败");
    return {
      kind: "uncertain",
      message,
      payload,
      reason: `submit_http_${response.status}`,
    };
  }
  const finalUrl = extractVideoUrl(payload);
  if (finalUrl) return { kind: "succeeded", url: finalUrl, payload };
  const providerTaskId = extractProviderTaskId(payload);
  if (providerTaskId) return { kind: "accepted", providerTaskId, payload };
  return {
    kind: "uncertain",
    message: "超分通道返回成功状态但未返回有效结果或任务号",
    payload,
    reason: "submit_invalid_2xx",
  };
}

function normalizeEnhanceProviderStatus(status: unknown): "succeeded" | "failed" | "running" {
  const value = String(status || "").trim().toLowerCase();
  if (["succeeded", "success", "succeed", "done", "completed", "complete", "finished"].includes(value)) return "succeeded";
  if (["failed", "failure", "error", "cancelled", "canceled", "expired", "rejected"].includes(value)) return "failed";
  return "running";
}

async function failTaskWithRelease(
  task: UserVideoEnhanceTask,
  message: string,
  releaseProof: "not_dispatched" | "definitive_not_billable",
): Promise<UserVideoEnhanceTask> {
  const safeMessage = redactEnhanceText(message || "视频增强失败").slice(0, 500);
  task = await persistBillingReconciliation(task, "release_pending", {
    details: { reason: safeMessage, releaseProof },
  });
  try {
    const released = await releaseEnhanceBilling(
      task,
      safeMessage,
      releaseProof,
    );
    if (!released?.ledger?.id) {
      throw new UserVideoEnhanceError(
        "增强预扣释放缺少可验证流水",
        500,
        "ENHANCE_BILLING_RELEASE_EVIDENCE_MISSING",
      );
    }
    return await persistBillingReconciliation(task, "released", {
      details: {
        reason: safeMessage,
        releaseProof,
        releaseLedgerId: released.ledger.id,
        idempotent: released.idempotent,
      },
      status: "failed",
      extra: { errorMessage: safeMessage },
    });
  } catch (err) {
    // 释放失败不能吞掉,但也不能把数据库/账户内部错误暴露给用户。
    console.error("[user-video-enhance] release failed", task.id, redactEnhanceText((err as any)?.message || err));
    return await markEnhanceBillingUnknown(task, "预扣释放结果未知", {
      reason: safeMessage,
      releaseProof,
    });
  }
}

async function readClaimedEnhancedAsset(
  task: UserVideoEnhanceTask,
  finalizationClaim: UserVideoEnhanceFinalizationClaim,
): Promise<{ assetId: string; url: string } | null> {
  await assertUserVideoEnhanceFinalizationClaim(finalizationClaim);
  const rows = await db("o_media_asset")
    .where({
      taskId: task.id,
      source: USER_VIDEO_ENHANCE_ASSET_SOURCE,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
    })
    .select("*");
  if (rows.length > 1) {
    throw new UserVideoEnhanceError(
      "增强任务存在重复结果资产",
      409,
      "ENHANCE_RESULT_ASSET_DUPLICATE",
    );
  }
  const row = rows[0];
  if (!row) {
    if (task.resultAssetId || task.resultUrl) {
      throw new UserVideoEnhanceError(
        "增强任务绑定的结果资产不存在",
        409,
        "ENHANCE_BOUND_RESULT_MISSING",
      );
    }
    return null;
  }
  const assetId = String(row.id);
  const url = String(row.url || "").trim();
  if (
    !url
    || task.resultAssetId !== assetId
    || task.resultUrl !== url
  ) {
    throw new UserVideoEnhanceError(
      "增强任务结果指针与资产不一致",
      409,
      "ENHANCE_BOUND_RESULT_MISMATCH",
    );
  }
  const metadata = parseJsonObject(row.metadata);
  const evidence = readUserEnhanceAssetEvidenceDescriptor(
    metadata.deliveryAssetEvidence,
  );
  const probe = readUserEnhanceMediaProbe(metadata.mediaProbe);
  const expectedEvidence = createUserEnhanceAssetEvidenceDescriptor({
    taskId: task.id,
    workspaceId: task.workspaceId,
    channelId: task.enhanceChannelId || "",
    providerTaskId: task.providerTaskId,
    sourceAssetId: userEnhanceSourceAssetIdentity({
      taskId: task.id,
      sourceAssetId: task.sourceAssetId,
      sourceUrl: task.sourceUrl,
    }),
    resultAssetId: assetId,
    resultUrl: url,
    sourceResolution: task.sourceResolution,
    targetResolution: task.targetResolution,
  });
  const targetHeight = videoResolutionHeight(task.targetResolution);
  if (
    !expectedEvidence
    || JSON.stringify(evidence) !== JSON.stringify(expectedEvidence)
    || !probe
    || Number(row.width) !== probe.width
    || Number(row.height) !== probe.height
    || Number(row.durationMs) !== probe.durationMs
    || String(row.mimeType || "") !== probe.mimeType
    || targetHeight <= 0
    || Math.min(probe.width, probe.height) < targetHeight
  ) {
    throw new UserVideoEnhanceError(
      "增强任务结果资产证据不完整或不一致",
      409,
      "ENHANCE_BOUND_RESULT_EVIDENCE_INVALID",
    );
  }
  const localPath = resolveOwnedVideoLocalPath(url, row.localPath);
  if (localPath) {
    const [actualProbe, actualSha256] = await Promise.all([
      probeVideoFile(localPath),
      sha256VideoFile(localPath),
    ]);
    if (
      actualProbe.width !== probe.width
      || actualProbe.height !== probe.height
      || actualProbe.durationMs !== probe.durationMs
      || actualSha256 !== probe.contentSha256
    ) {
      throw new UserVideoEnhanceError(
        "增强任务结果文件与持久证据不一致",
        409,
        "ENHANCE_BOUND_RESULT_FILE_INVALID",
      );
    }
  } else {
    const storageKey = String(row.storageKey || "").trim();
    const intent = storageKey
      ? await db("o_object_write_intent")
          .where({
            purpose: "video_enhance",
            workspaceId: task.workspaceId,
            projectId: task.projectId,
            objectKey: storageKey,
            expectedSha256: probe.contentSha256,
            status: "committed",
          })
          .first("referenceJson")
      : null;
    const reference = parseJsonObject(intent?.referenceJson);
    if (
      !intent
      || reference.table !== "o_media_asset"
      || String(reference.rowId || "") !== assetId
      || String(reference.storageKey || "") !== storageKey
    ) {
      throw new UserVideoEnhanceError(
        "增强任务远程对象缺少已提交的精确写入证明",
        409,
        "ENHANCE_BOUND_RESULT_OBJECT_EVIDENCE_INVALID",
      );
    }
  }
  return { assetId, url };
}

async function finalizeTaskSuccessOnce(
  task: UserVideoEnhanceTask,
  providerUrl: string,
  finalizationClaim: UserVideoEnhanceFinalizationClaim,
): Promise<UserVideoEnhanceTask> {
  const latestAfterLeaseLoss = async (error: unknown) => {
    if (
      error instanceof UserVideoEnhanceError
      && error.code === "ENHANCE_FINALIZATION_LEASE_LOST"
    ) {
      return await readUserVideoEnhanceTask(task.id, task.workspaceId);
    }
    return null;
  };
  let asset: { assetId: string | null; url: string };
  try {
    const existing = await readClaimedEnhancedAsset(
      task,
      finalizationClaim,
    );
    asset = existing
      || await storeEnhancedAsset(task, providerUrl, db, finalizationClaim);
  } catch (err) {
    const latest = await latestAfterLeaseLoss(err);
    if (latest) return latest;
    // 上游已报告成功,不能证明其不可计费,所以不自动释放预扣。
    // 结果未通过 URL/类型/大小校验时不落资产,转人工核账且只回安全文案。
    console.error("[user-video-enhance] output rejected", task.id, redactEnhanceText((err as any)?.message || err));
    return await persistPendingReconcileWithClaim(
      task,
      "output_rejected",
      {
        providerOutcome: "succeeded",
        outputAccepted: false,
        validationError: redactEnhanceText((err as any)?.message || err),
      },
      finalizationClaim,
      "failed",
    );
  }
  try {
    finalizationClaim = await renewUserVideoEnhanceFinalization(
      finalizationClaim,
    );
    task = (await readUserVideoEnhanceTask(task.id, task.workspaceId)) || task;
    task = await persistBillingReconciliation(task, "settlement_pending", {
      details: {
        providerOutcome: "succeeded",
        resultAssetId: asset.assetId,
      },
      finalizationClaim,
    });
    await assertUserVideoEnhanceFinalizationClaim(finalizationClaim);
    const settlement = await settleEnhanceBilling(
      task,
      finalizationClaim,
    );
    return await persistBillingReconciliation(task, "settled", {
      details: {
        providerOutcome: "succeeded",
        resultAssetId: asset.assetId,
        captureLedgerId: settlement.captureLedger?.id || null,
        releaseLedgerId: settlement.releaseLedger?.id || null,
        idempotent: settlement.idempotent,
      },
      status: "succeeded",
      extra: {
        resultAssetId: asset.assetId,
        resultUrl: asset.url,
        errorMessage: null,
      },
      finalizationClaim,
      releaseFinalizationClaim: true,
    });
  } catch (err) {
    const latest = await latestAfterLeaseLoss(err);
    if (latest) return latest;
    // 上游已成功产出但账务结果未知时，不能向调用方误报任务成功。
    console.error("[user-video-enhance] settle failed", task.id, redactEnhanceText((err as any)?.message || err));
    return await persistPendingReconcileWithClaim(
      task,
      "settlement_failed",
      {
        providerOutcome: "succeeded",
        resultAssetId: asset.assetId,
        resultUrl: asset.url,
        settlementError: redactEnhanceText((err as any)?.message || err),
      },
      finalizationClaim,
      "reconciling",
      {
        resultAssetId: asset.assetId,
        resultUrl: asset.url,
      },
    );
  }
}

async function persistPendingReconcileWithClaim(
  task: UserVideoEnhanceTask,
  reason: string,
  evidence: Record<string, unknown>,
  finalizationClaim: UserVideoEnhanceFinalizationClaim,
  status: UserVideoEnhanceTaskStatus = "failed",
  extra: Record<string, unknown> = {},
): Promise<UserVideoEnhanceTask> {
  await assertUserVideoEnhanceFinalizationClaim(finalizationClaim);
  await markEnhanceBillingPending(
    task,
    reason,
    evidence,
    finalizationClaim,
  );
  return await persistBillingReconciliation(task, "unknown", {
    error: reason,
    details: {
      pendingReconcileReason: reason,
      ...evidence,
    },
    status,
    extra: {
      ...extra,
      errorMessage: `${USER_VIDEO_ENHANCE_RECONCILE_MARKER}${reason}`,
    },
    finalizationClaim,
    releaseFinalizationClaim: true,
  });
}

async function finalizeTaskSuccess(
  task: UserVideoEnhanceTask,
  providerUrl: string,
): Promise<UserVideoEnhanceTask> {
  if (["succeeded", "failed"].includes(task.status)) return task;
  const legacyMarker = parseUserEnhanceOperationMarker(task.errorMessage);
  if (
    task.status === "enhancing"
    && legacyMarker?.phase === "finalize"
    && legacyMarker.leaseExpiresAt > now()
    && !task.finalizationLeaseOwner
  ) {
    return task;
  }
  const claimed = await claimUserVideoEnhanceFinalization({
    taskId: task.id,
    workspaceId: task.workspaceId,
    kind: "succeeded",
  });
  if (!claimed) {
    return await followActiveUserVideoEnhanceFinalization(task);
  }
  return await finalizeTaskSuccessOnce(
    claimed.task,
    providerUrl,
    claimed.claim,
  );
}

async function finalizePendingReconcile(
  task: UserVideoEnhanceTask,
  reason: string,
  evidence: Record<string, unknown> = {},
): Promise<UserVideoEnhanceTask> {
  if (["succeeded", "failed"].includes(task.status)) return task;
  const claimed = await claimUserVideoEnhanceFinalization({
    taskId: task.id,
    workspaceId: task.workspaceId,
    kind: "pending_reconcile",
  });
  if (!claimed) {
    return (await readUserVideoEnhanceTask(task.id, task.workspaceId)) || task;
  }
  try {
    return await persistPendingReconcileWithClaim(
      claimed.task,
      reason,
      evidence,
      claimed.claim,
      "failed",
    );
  } catch (error) {
    console.error(
      "[user-video-enhance] pending reconcile persistence failed",
      task.id,
      redactEnhanceText((error as any)?.message || error),
    );
    return (await readUserVideoEnhanceTask(task.id, task.workspaceId))
      || claimed.task;
  }
}

async function persistEnhanceReservation(
  task: UserVideoEnhanceTask,
  channel: EnhanceChannelRow,
): Promise<UserVideoEnhanceTask> {
  if (
    task.reservationId
    && task.usageRecordId
    && task.billingReconciliationState === "reserved"
  ) {
    return task;
  }
  if (task.reservationId || task.usageRecordId) {
    throw new UserVideoEnhanceError(
      "增强任务计费冻结指针不完整，已停止自动派发",
      409,
      "ENHANCE_BILLING_RESERVATION_INCOMPLETE",
    );
  }
  const reservation = await freezeEnhanceBilling(task, channel);
  const current = await readUserVideoEnhanceTask(task.id, task.workspaceId);
  if (!current) throw new UserVideoEnhanceError("增强任务不存在", 404, "ENHANCE_TASK_NOT_FOUND");
  if (
    current.reservationId
    && current.usageRecordId
    && current.billingReconciliationState === "reserved"
  ) {
    return current;
  }
  if (
    current.status !== "created"
    || current.billingReconciliationState !== "pending"
    || current.reservationId
    || current.usageRecordId
  ) {
    throw new UserVideoEnhanceError(
      "增强任务状态已变化，冻结流水等待人工核对",
      409,
      "ENHANCE_BILLING_RESERVATION_RACE",
    );
  }
  const observedAt = now();
  const reconciliationEvidence = billingReconciliationEvidence({
    task: {
      ...current,
      ...reservation,
    },
    outcome: "reserved",
    observedAt,
    details: { reservationOutcome: "reserved" },
  });
  const persisted = await compareAndSetTask(current, {
    ...reservation,
    billingReconciliationState: "reserved",
    billingReconciliationEvidenceJson: JSON.stringify(
      reconciliationEvidence,
    ),
    billingReconciliationError: null,
    billingReconciliationUpdatedAt: observedAt,
  });
  if (persisted.updated) return persisted.task;
  if (
    persisted.task.reservationId === reservation.reservationId
    && persisted.task.usageRecordId === reservation.usageRecordId
  ) {
    return persisted.task;
  }
  throw new UserVideoEnhanceError(
    "增强冻结流水未能绑定任务，已停止自动派发",
    409,
    "ENHANCE_BILLING_RESERVATION_RACE",
  );
}

async function beginEnhanceDispatch(task: UserVideoEnhanceTask): Promise<{
  claimed: boolean;
  task: UserVideoEnhanceTask;
}> {
  const current = await readUserVideoEnhanceTask(task.id, task.workspaceId);
  if (!current) throw new UserVideoEnhanceError("增强任务不存在", 404, "ENHANCE_TASK_NOT_FOUND");
  if (current.status !== "created" || !current.reservationId || !current.usageRecordId) {
    return { claimed: false, task: current };
  }
  const marker = createUserEnhanceOperationMarker("dispatch");
  const result = await compareAndSetTask(current, {
    status: "enhancing",
    errorMessage: marker,
  });
  return { claimed: result.updated, task: result.task };
}

async function acceptEnhanceProviderTask(
  task: UserVideoEnhanceTask,
  providerTaskId: string,
): Promise<UserVideoEnhanceTask> {
  const marker = parseUserEnhanceOperationMarker(task.errorMessage);
  if (marker?.phase !== "dispatch") {
    return await finalizePendingReconcile(
      task,
      "accepted_task_without_dispatch_lease",
      { providerTaskId },
    );
  }
  const result = await compareAndSetTask(task, {
    status: "enhancing",
    providerTaskId,
    errorMessage: null,
  });
  if (result.updated) return result.task;
  return await finalizePendingReconcile(
    result.task,
    "accepted_task_persistence_race",
    { providerTaskId },
  );
}

async function dispatchReservedEnhanceTask(
  task: UserVideoEnhanceTask,
  channel: EnhanceChannelRow,
  config: EnhanceChannelConfig,
): Promise<UserVideoEnhanceTask> {
  const dispatch = await beginEnhanceDispatch(task);
  if (!dispatch.claimed) return dispatch.task;
  task = dispatch.task;

  try {
    await markEnhanceBillingDispatched(task);
  } catch (err: any) {
    return await finalizePendingReconcile(
      task,
      "dispatch_marker_persistence_failed",
      { dispatchError: redactEnhanceText(err?.message || err) },
    );
  }

  let outcome: SubmitOutcome;
  try {
    outcome = await submitEnhanceToChannel(task, channel, config);
  } catch (err: any) {
    return await finalizePendingReconcile(
      task,
      /timed out|abort/i.test(String(err?.message || ""))
        ? "submit_timeout"
        : "submit_network_error",
      { errorClass: String(err?.name || "Error") },
    );
  }

  if (outcome.kind === "uncertain") {
    return await finalizePendingReconcile(task, outcome.reason);
  }
  if (outcome.kind === "succeeded") {
    return await finalizeTaskSuccess(task, outcome.url);
  }
  return await acceptEnhanceProviderTask(task, outcome.providerTaskId);
}

async function resumeUserVideoEnhanceTask(task: UserVideoEnhanceTask): Promise<UserVideoEnhanceTask> {
  if (task.status === "succeeded" || task.status === "failed") return task;
  const marker = parseUserEnhanceOperationMarker(task.errorMessage);
  if (task.status === "enhancing") {
    if (marker && marker.leaseExpiresAt > now()) return task;
    if (marker?.phase === "dispatch") {
      return await finalizePendingReconcile(task, "submit_recovery_without_provider_task_id");
    }
    if (marker?.phase === "finalize") {
      if (marker.kind === "succeeded" && task.resultAssetId && task.resultUrl) {
        return await finalizeTaskSuccess(task, task.resultUrl);
      }
      if (marker.kind === "definitive_failure") {
        return await finalizePendingReconcile(task, "legacy_failure_without_authenticated_billing_proof");
      }
      return await finalizePendingReconcile(task, "finalization_lease_expired");
    }
    if (task.providerTaskId) return task;
    if (task.resultAssetId && task.resultUrl) {
      return await finalizeTaskSuccess(task, task.resultUrl);
    }
    return await finalizePendingReconcile(task, "active_task_without_dispatch_evidence");
  }

  const channelRow = task.enhanceChannelId
    ? await findMediaService(db as any, task.enhanceChannelId, "mediakit")
    : null;
  if (!channelRow) {
    // No upstream call has happened. Only a proven pre-dispatch reservation
    // may be released automatically.
    if (task.reservationId) {
      return await failTaskWithRelease(
        task,
        "增强通道不存在，释放未派发预扣",
        "not_dispatched",
      );
    }
    return await persistBillingReconciliation(task, "not_billed", {
      details: { reason: "enhance_channel_unavailable" },
      status: "failed",
      extra: { errorMessage: "视频增强通道不可用" },
    });
  }
  const channel = parseChannelRow(channelRow);
  const config = resolveEnhanceConfig(channel);
  if (!config) {
    if (task.reservationId) {
      return await failTaskWithRelease(
        task,
        "增强通道配置失效，释放未派发预扣",
        "not_dispatched",
      );
    }
    return await persistBillingReconciliation(task, "not_billed", {
      details: { reason: "enhance_channel_misconfigured" },
      status: "failed",
      extra: { errorMessage: "视频增强通道配置不可用" },
    });
  }

  task = await persistEnhanceReservation(task, channel);
  return await dispatchReservedEnhanceTask(task, channel, config);
}

export interface CreateUserVideoEnhanceInput {
  workspaceId: string;
  userId?: number | null;
  sourceAssetId?: string | null;
  sourceUrl?: string | null;
  sourceResolution: unknown;
  targetResolution: unknown;
  durationSeconds?: number | null;
  idempotencyKey: string;
}

async function insertUserVideoEnhanceTaskForActiveProject(
  source: SourceAssetInfo,
  workspaceId: string,
  row: Record<string, unknown>,
  channel: EnhanceChannelRow,
): Promise<void> {
  await db.transaction(async (transaction) => {
    await lockMediaServiceForTask(transaction, channel.id, String(row.targetResolution), resolveEnhanceConfig(channel)?.apiKey);
    let projectQuery = transaction("o_project")
      .where({
        id: source.projectId,
        workspaceId,
        deletionState: "active",
      })
      .select("id", "deletionState");
    if (isPostgresClient(transaction)) projectQuery = projectQuery.forShare();
    const project = await projectQuery.first();
    if (!project) {
      throw new UserVideoEnhanceError(
        "源视频所属项目正在删除或已不可用",
        409,
        "ENHANCE_PROJECT_NOT_ACTIVE",
      );
    }
    const lockedSource = await transaction("o_media_asset")
      .where({
        id: source.assetId,
        workspaceId,
        projectId: source.projectId,
      })
      .select("id")
      .first();
    if (!lockedSource) {
      throw new UserVideoEnhanceError(
        "源视频资产归属已变化",
        409,
        "ENHANCE_SOURCE_CHANGED",
      );
    }
    await transaction(USER_VIDEO_ENHANCE_TASK_TABLE).insert(row);
  });
}

export interface CreateUserVideoEnhanceResult {
  task: UserVideoEnhanceTask;
  quote: UserVideoEnhanceQuote;
  idempotent: boolean;
}

/**
 * 创作台画质增强创建(真调度):校验 → quote 复核 → 选超分通道 → 冻结
 * (video_enhance) → 提交超分通道 → 同步结果处理(成功:资产+结算 / 失败:
 * 释放 / 异步:enhancing,由 getUserVideoEnhanceTask 轮询收口)。
 */
export async function createUserVideoEnhanceTask(
  input: CreateUserVideoEnhanceInput,
): Promise<CreateUserVideoEnhanceResult> {
  const workspaceId = String(input.workspaceId || "").trim();
  if (!workspaceId) throw new UserVideoEnhanceError("缺少工作区上下文", 403, "ENHANCE_WORKSPACE_REQUIRED");
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!idempotencyKey) {
    throw new UserVideoEnhanceError(
      "画质增强任务必须提供幂等键",
      400,
      "ENHANCE_IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const requestHash = userEnhanceIdempotencyRequestHash({
    workspaceId,
    sourceAssetId: input.sourceAssetId,
    sourceUrl: input.sourceUrl,
    sourceResolution: input.sourceResolution,
    targetResolution: input.targetResolution,
  });

  // Resolve an exact replay from the immutable request snapshot before
  // consulting mutable source metadata, pricing, or channel health. A deleted
  // source or later price change must not make the original task unreachable.
  const existing = await db(USER_VIDEO_ENHANCE_TASK_TABLE)
    .where({ workspaceId, idempotencyKey, kind: USER_VIDEO_ENHANCE_TASK_KIND })
    .first();
  if (existing) {
    let task = parseTaskRow(existing);
    assertIdempotentRequestMatch(task, requestHash);
    task = await resumeUserVideoEnhanceTask(task);
    return { task, quote: task.quote, idempotent: true };
  }

  // 1) 源校验:归属当前工作区 + 可公网访问 + 实测分辨率/时长校准。
  // durationSeconds 是旧客户端兼容字段,绝不参与权威计费。
  const source = await resolveSourceAsset({
    workspaceId,
    sourceAssetId: input.sourceAssetId ?? null,
    sourceUrl: input.sourceUrl ?? null,
  });
  const effectiveSource = deriveSourceResolution(source.width, source.height);
  const authoritativeDurationMs = Number(source.durationMs);
  if (
    !Number.isSafeInteger(authoritativeDurationMs)
    || authoritativeDurationMs <= 0
    || authoritativeDurationMs > 86_400_000
  ) {
    throw new UserVideoEnhanceError(
      "源视频资产缺少可验证的时长，请等待媒体信息解析完成后重试",
      422,
      "ENHANCE_DURATION_UNVERIFIED",
    );
  }
  const durationSeconds = Math.ceil(authoritativeDurationMs / 1000);

  // 2) quote 复核:精确读取管理员配置的 video_enhance source→target
  // 秒价;缺失/停用/无效价目一律失败,不使用占位或默认价。
  const quote = await quoteConfiguredUserVideoEnhance(
    {
      sourceResolution: effectiveSource,
      targetResolution: input.targetResolution,
      durationSeconds,
      authoritativeDuration: true,
    },
    workspaceId,
  );
  if (!quote.allowed) {
    const durationUnverified = quote.reasonCode === "ENHANCE_DURATION_UNVERIFIED";
    throw new UserVideoEnhanceError(
      quote.reason || "无法创建增强任务",
      durationUnverified ? 422 : 400,
      durationUnverified ? "ENHANCE_DURATION_UNVERIFIED" : "ENHANCE_NOT_ALLOWED",
    );
  }

  // 3) 选超分通道(video_upscale,健康+权重,声明支持目标档)。
  const channel = await selectUpscaleChannel({
    workspaceId,
    targetResolution: quote.targetResolution,
  });
  if (!channel) {
    throw new UserVideoEnhanceError("当前没有可用的视频增强通道", 503, "ENHANCE_CHANNEL_UNAVAILABLE");
  }
  const config = resolveEnhanceConfig(channel);
  if (!config) {
    throw new UserVideoEnhanceError("视频增强通道未配置端点或密钥", 503, "ENHANCE_CHANNEL_MISCONFIGURED");
  }

  // 4) 任务行(kind=user_video_enhance;幂等键唯一索引兜底并发重放)。
  const taskId = uuid();
  const timestamp = now();
  const requestId = taskRequestId(taskId, requestHash);
  try {
    await insertUserVideoEnhanceTaskForActiveProject(source, workspaceId, {
      id: taskId,
      kind: USER_VIDEO_ENHANCE_TASK_KIND,
      workspaceId,
      projectId: source.projectId,
      userId: input.userId ?? null,
      sourceAssetId: source.assetId || null,
      sourceUrl: source.url,
      sourceResolution: quote.sourceResolution,
      targetResolution: quote.targetResolution,
      durationSeconds: quote.durationSeconds,
      enhanceChannelId: channel.id,
      provider: channel.provider || null,
      providerTaskId: null,
      status: "created",
      quoteJson: JSON.stringify(quote),
      reservationId: null,
      usageRecordId: null,
      billingReconciliationState: "pending",
      billingReconciliationEvidenceJson: JSON.stringify({
        version: "user-video-enhance-billing-reconciliation.v1",
        taskId,
        billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
        outcome: "pending",
        reservationId: null,
        usageRecordId: null,
        observedAt: timestamp,
      }),
      billingReconciliationError: null,
      billingReconciliationUpdatedAt: timestamp,
      finalizationLeaseOwner: null,
      finalizationLeaseExpiresAt: null,
      finalizationFence: 0,
      resultAssetId: null,
      resultUrl: null,
      errorMessage: null,
      idempotencyKey,
      requestId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, channel);
  } catch (err: any) {
    const message = String(err?.message || "");
    if (idempotencyKey && (/UNIQUE/i.test(message) || String((err as any)?.code || "") === "23505")) {
      const existing = await db(USER_VIDEO_ENHANCE_TASK_TABLE)
        .where({ workspaceId, idempotencyKey, kind: USER_VIDEO_ENHANCE_TASK_KIND })
        .first();
      if (existing) {
        let task = parseTaskRow(existing);
        assertIdempotentRequestMatch(task, requestHash);
        task = await resumeUserVideoEnhanceTask(task);
        return { task, quote: task.quote, idempotent: true };
      }
    }
    throw err;
  }

  let task: UserVideoEnhanceTask = {
    id: taskId,
    kind: USER_VIDEO_ENHANCE_TASK_KIND,
    workspaceId,
    projectId: source.projectId,
    userId: input.userId ?? null,
    sourceAssetId: source.assetId || null,
    sourceUrl: source.url,
    sourceResolution: quote.sourceResolution,
    targetResolution: quote.targetResolution,
    durationSeconds: quote.durationSeconds,
    enhanceChannelId: channel.id,
    provider: channel.provider || null,
    providerTaskId: null,
    status: "created",
    quote,
    reservationId: null,
    usageRecordId: null,
    billingReconciliationState: "pending",
    billingReconciliationEvidence: {
      version: "user-video-enhance-billing-reconciliation.v1",
      taskId,
      billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
      outcome: "pending",
      reservationId: null,
      usageRecordId: null,
      observedAt: timestamp,
    },
    billingReconciliationError: null,
    billingReconciliationUpdatedAt: timestamp,
    finalizationLeaseOwner: null,
    finalizationLeaseExpiresAt: null,
    finalizationFence: 0,
    resultAssetId: null,
    resultUrl: null,
    errorMessage: null,
    idempotencyKey,
    requestId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    task = await resumeUserVideoEnhanceTask(task);
  } catch (err: any) {
    // A reserve transaction is idempotent and recoverable by replay. Do not
    // turn an ambiguous reserve→task-pointer crash into a false terminal row.
    if (err instanceof BillingError && err.status < 500) {
      task = await persistBillingReconciliation(task, "not_billed", {
        error: err.message,
        details: { reservationOutcome: "not_created" },
        status: "failed",
        extra: {
          errorMessage: redactEnhanceText(err.message).slice(0, 500),
        },
      });
    }
    throw err;
  }
  return { task, quote, idempotent: false };
}

/**
 * 任务读取 + 异步收口:enhancing 状态下轮询超分通道,成功则资产入库 +
 * 结算,失败则释放冻结(幂等;终态任务直接返回)。
 */
export async function getUserVideoEnhanceTask(input: {
  taskId: string;
  workspaceId: string;
}): Promise<UserVideoEnhanceTask | null> {
  let task = await readUserVideoEnhanceTask(input.taskId, input.workspaceId);
  if (!task) return null;
  if (task.status === "created") {
    task = await resumeUserVideoEnhanceTask(task);
  } else if (task.status === "reconciling") {
    if (
      task.finalizationLeaseExpiresAt != null
      && task.finalizationLeaseExpiresAt > now()
    ) {
      // Another worker owns the durable finalization fence. Give the normal
      // fast path a short chance to converge so concurrent readers do not
      // observe the internal `reconciling` row as a false terminal failure.
      // The database lease remains the sole authority; this is only a
      // follower/read optimization and never performs a competing mutation.
      task = await followActiveUserVideoEnhanceFinalization(task);
      if (
        task.status === "reconciling"
        && task.finalizationLeaseExpiresAt != null
        && task.finalizationLeaseExpiresAt > now()
      ) {
        return task;
      }
    }
    if (task.status !== "reconciling") {
      return task;
    } else if (task.resultAssetId && task.resultUrl) {
      task = await finalizeTaskSuccess(task, task.resultUrl);
    } else {
      task = await finalizePendingReconcile(
        task,
        "finalization_lease_expired",
      );
    }
  } else if (task.status === "enhancing") {
    const marker = parseUserEnhanceOperationMarker(task.errorMessage);
    if (marker) {
      task = await resumeUserVideoEnhanceTask(task);
      if (parseUserEnhanceOperationMarker(task.errorMessage)) return task;
    } else if (task.resultAssetId && task.resultUrl) {
      task = await finalizeTaskSuccess(task, task.resultUrl);
    } else if (!task.providerTaskId) {
      task = await resumeUserVideoEnhanceTask(task);
    }
  }
  if (task.status !== "enhancing") return task;
  if (parseUserEnhanceOperationMarker(task.errorMessage)) return task;
  if (!task.providerTaskId || !task.enhanceChannelId) return task;

  const channelRow = await findMediaService(db as any, task.enhanceChannelId, "mediakit");
  if (!channelRow) return task;
  const channel = parseChannelRow(channelRow);
  const config = resolveEnhanceConfig(channel);
  if (!config || !config.statusEndpoint) return task;

  const encoded = encodeURIComponent(task.providerTaskId);
  const url = config.statusEndpoint.replace("{taskId}", encoded).replace("{task_id}", encoded);
  let payload: Record<string, unknown>;
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
      Number(process.env.FANJIN_VIDEO_ENHANCE_TIMEOUT_MS || channel.timeoutMs || 600000),
    );
    payload = await readJsonResponse(response);
    if (!response.ok) {
      return await finalizePendingReconcile(
        task,
        `poll_http_${response.status}`,
        { httpStatus: response.status },
      );
    }
  } catch (err: any) {
    // 查询结果不可知，不能释放冻结，也不能让多个实例继续竞争终态。
    console.warn("[user-video-enhance] poll failed", task.id, redactEnhanceText((err as any)?.message || err));
    return await finalizePendingReconcile(task, "poll_network_error", {
      errorClass: String(err?.name || "Error"),
    });
  }

  const providerStatus = normalizeEnhanceProviderStatus(pickFirst(payload, ["status", "data.status", "result.status"]));
  if (providerStatus === "succeeded") {
    const finalUrl = extractVideoUrl(payload);
    if (!finalUrl) {
      return await finalizePendingReconcile(task, "provider_success_without_output");
    }
    return await finalizeTaskSuccess(task, finalUrl);
  }
  if (providerStatus === "failed") {
    return await finalizePendingReconcile(task, "provider_terminal_failed_billability_unknown", {
      providerStatus: "failed",
    });
  }
  return task;
}

/** 面向创作台的任务视图(不暴露通道凭据/端点)。 */
export async function toPublicUserVideoEnhanceTask(
  task: UserVideoEnhanceTask,
): Promise<Record<string, unknown>> {
  const [assets, usage] = await Promise.all([
    db("o_media_asset")
      .where({
        taskId: task.id,
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        source: USER_VIDEO_ENHANCE_ASSET_SOURCE,
      })
      .orderBy("createTime", "asc"),
    task.usageRecordId
      ? db("o_usage_record").where({ id: task.usageRecordId }).first()
      : Promise.resolve(null),
  ]);
  const reconcileReason = String(task.errorMessage || "").startsWith(USER_VIDEO_ENHANCE_RECONCILE_MARKER)
    ? String(task.errorMessage).slice(USER_VIDEO_ENHANCE_RECONCILE_MARKER.length)
    : null;
  const activeFinalizationMarker = parseUserEnhanceOperationMarker(
    task.errorMessage,
  );
  // Billing settlement failure does not revoke an already validated delivery.
  // Conversely, rejected output is a delivery failure even though its billing
  // reservation remains pending. Keep those dimensions independent.
  const deliveryTask =
    reconcileReason === "settlement_failed"
      ? { ...task, status: "succeeded" as const, errorMessage: null }
      : reconcileReason === "reservation_release_failed"
        ? { ...task, errorMessage: null }
        : task.status === "reconciling"
          && activeFinalizationMarker?.phase === "finalize"
          && activeFinalizationMarker.leaseExpiresAt > now()
          ? { ...task, status: "enhancing" as const, errorMessage: null }
          : task;
  const publication = publishUserVideoEnhanceDelivery(deliveryTask, assets);
  const deliveryPublic = publicDeliveryPart(publication);
  const deliveryFailure = publication.projection?.failure ?? null;
  const usageStatus = String(usage?.status || "");
  const billingState =
    usageStatus === "pending_reconcile"
      ? "pending_reconcile"
      : ["charged", "free"].includes(usageStatus)
        ? "captured"
        : usageStatus === "released"
          ? "released"
          : "reserved";
  return {
    id: task.id,
    kind: task.kind,
    status:
      reconcileReason === "settlement_failed"
      && task.status === "reconciling"
        ? "reconciling"
        : publication.projection?.taskStatus ?? "failed",
    billingReconciliationState: task.billingReconciliationState,
    billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
    billingState,
    billingReconciliationRequired: billingState === "pending_reconcile",
    sourceAssetId: task.sourceAssetId,
    sourceResolution: task.sourceResolution,
    targetResolution: task.targetResolution,
    durationSeconds: task.durationSeconds,
    resultUrl:
      typeof deliveryPublic.video_url === "string"
        ? deliveryPublic.video_url
        : null,
    delivery: deliveryPublic.delivery ?? null,
    metRequestedQuality: deliveryPublic.metRequestedQuality ?? false,
    errorCode: deliveryFailure?.code ?? null,
    errorMessage: deliveryFailure?.safeMessage ?? null,
    idempotencyKey: task.idempotencyKey,
    quote: task.quote,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
