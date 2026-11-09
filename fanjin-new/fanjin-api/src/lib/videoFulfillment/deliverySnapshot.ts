/**
 * CL2 pure delivery classification projection (section 6.2: videoFulfillment/**).
 *
 * This module deliberately does not claim the shared VideoTaskDelivery V1
 * contract.  It classifies a bounded, immutable view of delivery evidence for
 * the local API response only; persistence, billing and router wiring live in
 * their owning layers.
 *
 * v12 security properties:
 * - optional flags are absent only when undefined;
 * - hostile objects are read through one bounded descriptor snapshot;
 * - attempt history is capped at the canonical 50 entries;
 * - winner and retained-source evidence are independently bound to lineage;
 * - enhanced delivery cannot succeed without a distinct source proof;
 * - public attachment preserves safe existing fields but hides implementation
 *   details and never publishes provider error text.
 */

import { autoDLH3SupportsResolution } from "@/lib/autodlH3Manifest";
import { types as nodeUtilTypes } from "node:util";
import {
  isPublicVideoResolution,
  isUserSelectableVideoGenerationResolution,
  videoResolutionHeight,
  type InternalVideoResolution,
  type PublicVideoResolution,
  type UserSelectableVideoGenerationResolution,
} from "@/lib/videoResolutions";

type DeliveryTargetResolution = UserSelectableVideoGenerationResolution;

export const PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_VERSION =
  "relay-provider-native-delivery-authorization/v1" as const;

export interface ProviderNativeDeliveryAuthorization {
  version: typeof PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_VERSION;
  provider: "minimax" | "autodl";
  model: "MiniMax-H3" | "MiniMax-H3-Max" | "autodl-h3" | "autodl-h3-cinema";
  channelId: string;
  resolution: "480p" | "768p" | "960p";
}

export const VIDEO_TASK_PIPELINES = [
  "direct_generation",
  "generate_then_enhance",
  "user_enhance",
] as const;
export type VideoTaskPipeline = (typeof VIDEO_TASK_PIPELINES)[number];

export const VIDEO_TASK_STATUSES = [
  "queued",
  "running",
  "pending_reconcile",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type VideoTaskStatus = (typeof VIDEO_TASK_STATUSES)[number];

export const VIDEO_TASK_PHASES = [
  "queued",
  "generating",
  "enhancing",
  "finalizing",
  "reconciling",
  "terminal",
] as const;
export type VideoTaskPhase = (typeof VIDEO_TASK_PHASES)[number];

export const VIDEO_DELIVERY_STATUSES = [
  "pending",
  "delivered_native",
  "delivered_enhanced",
  "degraded_source_only",
  "pending_reconcile",
  "failed",
  "cancelled",
] as const;
export type VideoDeliveryStatus = (typeof VIDEO_DELIVERY_STATUSES)[number];

export const ENHANCEMENT_STATUSES = [
  "not_required",
  "pending",
  "running",
  "succeeded",
  "failed",
  "pending_reconcile",
  "cancelled",
] as const;
export type EnhancementStatus = (typeof ENHANCEMENT_STATUSES)[number];

export const PUBLIC_DELIVERY_ERROR_CODES = [
  "GENERATION_FAILED",
  "CONTENT_REVIEW_REJECTED",
  "UPSTREAM_TEMPORARILY_UNAVAILABLE",
  "ENHANCEMENT_FAILED",
  "RESOLUTION_MISMATCH",
  "EMPTY_OUTPUT",
  "USER_ENHANCE_FAILED",
  "CANCELLED",
  "RECONCILE_REQUIRED",
  "ALIAS_MISMATCH",
  "INVALID_PIPELINE",
  "INVALID_REQUEST",
  "EVIDENCE_INVALID",
] as const;
export type PublicDeliveryErrorCode = (typeof PUBLIC_DELIVERY_ERROR_CODES)[number];

export const DELIVERY_EVIDENCE_KINDS = [
  "generation_output",
  "generation_source",
  "native_source",
  "enhancement_output",
  "upscale_output",
  "fallback_source",
] as const;
export type DeliveryEvidenceKind = (typeof DELIVERY_EVIDENCE_KINDS)[number];

export const DELIVERY_EVIDENCE_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type DeliveryEvidenceStatus = (typeof DELIVERY_EVIDENCE_STATUSES)[number];

export const DELIVERY_EVIDENCE_PHASES = [
  "generation",
  "enhancement",
  "upscale",
  "fallback",
] as const;
export type DeliveryEvidencePhase = (typeof DELIVERY_EVIDENCE_PHASES)[number];

export const DELIVERY_DISPATCH_STATUSES = [
  "dispatched",
  "failed",
  "cancelled",
] as const;
export type DeliveryDispatchStatus = (typeof DELIVERY_DISPATCH_STATUSES)[number];

export const DELIVERY_RESULT_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type DeliveryResultStatus = (typeof DELIVERY_RESULT_STATUSES)[number];

export interface SafeVideoFailure {
  code: PublicDeliveryErrorCode;
  safeMessage: string;
}

export type ReconciliationHint =
  | { kind: "billing_reconciliation_required"; reason: "outcome_unknown" }
  | { kind: "billing_reconciliation_required"; reason: "reconciling_phase" }
  | {
      kind: "billing_reconciliation_required";
      reason: "enhancement_failed_source_retained";
    };

export interface EvidenceLineage {
  taskId: string;
  fulfillmentId: string;
  channelId: string;
}

export interface WinningEvidenceRef extends EvidenceLineage {
  evidenceId: string;
  evidenceVersion: string;
  winningAttemptId: string;
  resultAssetId: string;
  kind: "generation_output" | "enhancement_output" | "upscale_output";
}

export interface RetainedSourceEvidenceRef extends EvidenceLineage {
  evidenceId: string;
  evidenceVersion: string;
  sourceAttemptId: string;
  sourceAssetId: string;
  resolution: InternalVideoResolution;
  kind: "generation_source" | "native_source" | "fallback_source";
}

export interface DeliveryEvidenceItem {
  id?: unknown;
  evidenceVersion?: unknown;
  taskId?: unknown;
  fulfillmentId?: unknown;
  channelId?: unknown;
  winningAttemptId?: unknown;
  resultAssetId?: unknown;
  resolution?: unknown;
  trustworthy?: unknown;
  kind?: unknown;
  status?: unknown;
  phase?: unknown;
  dispatchStatus?: unknown;
  resultStatus?: unknown;
}

export interface DeliveryClassificationProjection {
  pipeline: VideoTaskPipeline;
  requestedResolution: DeliveryTargetResolution | null;
  generationResolution: InternalVideoResolution | null;
  deliveredResolution: DeliveryTargetResolution | null;
  taskStatus: VideoTaskStatus;
  phase: VideoTaskPhase;
  deliveryStatus: VideoDeliveryStatus;
  enhancementStatus: EnhancementStatus;
  metRequestedQuality: boolean;
  failure: SafeVideoFailure | null;
  internal: {
    providerErrorInternal: string | null;
    rawFinalization: string | null;
    sourceRetained: boolean;
    reconciliationHint: ReconciliationHint | null;
    winningEvidenceRef: WinningEvidenceRef | null;
    sourceEvidenceRef: RetainedSourceEvidenceRef | null;
    retainedSourceEvidenceRef: RetainedSourceEvidenceRef | null;
  };
}

/** @deprecated local alias only; this is not the shared delivery contract. */
export type DeliveryProjection = DeliveryClassificationProjection;

export type BuildDeliveryProjectionResult =
  | { ok: true; projection: DeliveryClassificationProjection }
  | {
      ok: false;
      error: {
        code: "INVALID_PIPELINE" | "INVALID_REQUEST";
        safeMessage: string;
      };
    };

export interface BuildDeliveryProjectionInput {
  pipeline?: unknown;
  requestedResolution?: unknown;
  generationResolution?: unknown;
  deliveredResolution?: unknown;
  allowProviderNativeNonPublicResolution?: unknown;
  generationFailed?: unknown;
  enhancementFailed?: unknown;
  emptyOutput?: unknown;
  cancelled?: unknown;
  outcomeUnknown?: unknown;
  sourceRetained?: unknown;
  sourceEvidence?: unknown;
  inProgressPhase?: unknown;
  providerErrorInternal?: unknown;
  rawFinalization?: unknown;
  evidence?: unknown;
  taskId?: unknown;
  fulfillmentId?: unknown;
  channelId?: unknown;
  winningAttemptId?: unknown;
  resultAssetId?: unknown;
  sourceAttemptId?: unknown;
  sourceAssetId?: unknown;
}

export const VIDEO_IN_PROGRESS_PHASES = [
  "queued",
  "generating",
  "enhancing",
  "finalizing",
  "reconciling",
] as const;
export type VideoInProgressPhase = (typeof VIDEO_IN_PROGRESS_PHASES)[number];

const MAX_ATTEMPT_HISTORY = 50;
const MAX_ID_LEN = 128;
const MAX_PLAIN_STRING_LEN = 1024;
const MAX_PLAIN_DEPTH = 8;
// Two independently bounded 50-entry histories, each with a closed 14-field
// descriptor, must fit while still rejecting unbounded graphs.
const MAX_PLAIN_NODES = 4096;
const MAX_PLAIN_KEYS = 64;
const MAX_PLAIN_ARRAY_ITEMS = 128;
const REDACTED_PROVIDER_ERROR = "PROVIDER_ERROR_REDACTED";

const SAFE_MESSAGES: Record<PublicDeliveryErrorCode, string> = {
  GENERATION_FAILED: "视频生成失败",
  CONTENT_REVIEW_REJECTED: "上游内容审核未通过",
  UPSTREAM_TEMPORARILY_UNAVAILABLE: "上游视频服务暂不可用，本次未能生成视频，请稍后重试。",
  ENHANCEMENT_FAILED: "视频增强失败",
  RESOLUTION_MISMATCH: "交付分辨率未达到请求档位",
  EMPTY_OUTPUT: "未产生有效输出",
  USER_ENHANCE_FAILED: "主动增强失败",
  CANCELLED: "任务已取消",
  RECONCILE_REQUIRED: "暂未取得上游结果，请稍后查看；费用记录可在账单中查询",
  ALIAS_MISMATCH: "请求分辨率无效",
  INVALID_PIPELINE: "无效交付管线",
  INVALID_REQUEST: "无效请求",
  EVIDENCE_INVALID: "交付证据无效或不唯一",
};

const ROOT_KEYS = new Set([
  "pipeline",
  "requestedResolution",
  "generationResolution",
  "deliveredResolution",
  "allowProviderNativeNonPublicResolution",
  "generationFailed",
  "enhancementFailed",
  "emptyOutput",
  "cancelled",
  "outcomeUnknown",
  "sourceRetained",
  "sourceEvidence",
  "inProgressPhase",
  "providerErrorInternal",
  "rawFinalization",
  "evidence",
  "taskId",
  "fulfillmentId",
  "channelId",
  "winningAttemptId",
  "resultAssetId",
  "sourceAttemptId",
  "sourceAssetId",
]);

const EVIDENCE_KEYS = new Set([
  "id",
  "evidenceVersion",
  "taskId",
  "fulfillmentId",
  "channelId",
  "winningAttemptId",
  "resultAssetId",
  "resolution",
  "trustworthy",
  "kind",
  "status",
  "phase",
  "dispatchStatus",
  "resultStatus",
]);

const PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_KEYS = new Set([
  "version",
  "provider",
  "model",
  "channelId",
  "resolution",
]);

const RAW_FINALIZATION_ALLOWLIST = new Set([
  "generation_succeeded",
  "enhancement_succeeded",
  "enhancement_failed",
  "enhancement_failed_source_retained",
  "cancelled",
  "empty_output",
  "reconcile_required",
]);

type PlainSnapshot =
  | null
  | undefined
  | string
  | number
  | boolean
  | PlainSnapshot[]
  | { [key: string]: PlainSnapshot };

interface SnapshotState {
  seen: WeakSet<object>;
  nodes: number;
  maxArrayItems: number;
}

interface ParsedEvidenceItem {
  id: string;
  evidenceVersion: string;
  taskId: string;
  fulfillmentId: string;
  channelId: string;
  winningAttemptId: string;
  resultAssetId: string;
  resolution: InternalVideoResolution;
  trustworthy: boolean;
  kind: DeliveryEvidenceKind;
  status: DeliveryEvidenceStatus;
  phase: DeliveryEvidencePhase;
  dispatchStatus: DeliveryDispatchStatus;
  resultStatus: DeliveryResultStatus;
}

function isDangerousKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function isExactStringMember<T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function readPlainRecordOnce(
  value: unknown,
  maxKeys = MAX_PLAIN_KEYS,
): { ok: true; record: Record<string, unknown> } | { ok: false } {
  try {
    if (
      value == null
      || typeof value !== "object"
      || Array.isArray(value)
      || nodeUtilTypes.isProxy(value)
    ) {
      return { ok: false };
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { ok: false };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > maxKeys || keys.some((key) => typeof key === "symbol")) {
      return { ok: false };
    }
    const record: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      if (key.length > MAX_ID_LEN || isDangerousKey(key)) return { ok: false };
      const descriptor = descriptors[key];
      if (
        !descriptor
        || !("value" in descriptor)
        || descriptor.get
        || descriptor.set
        || descriptor.enumerable !== true
      ) {
        return { ok: false };
      }
      record[key] = descriptor.value;
    }
    return { ok: true, record };
  } catch {
    return { ok: false };
  }
}

function snapshotPlainData(
  value: unknown,
  state: SnapshotState,
  depth = 0,
): { ok: true; value: PlainSnapshot } | { ok: false } {
  try {
    if (depth > MAX_PLAIN_DEPTH || state.nodes >= MAX_PLAIN_NODES) {
      return { ok: false };
    }
    state.nodes += 1;
    if (value === null || value === undefined || typeof value === "boolean") {
      return { ok: true, value };
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    if (typeof value === "string") {
      return value.length <= MAX_PLAIN_STRING_LEN
        ? { ok: true, value }
        : { ok: false };
    }
    if (typeof value !== "object" || nodeUtilTypes.isProxy(value)) {
      return { ok: false };
    }
    if (state.seen.has(value)) return { ok: false };
    state.seen.add(value);

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptorKeys = Reflect.ownKeys(descriptors);
    if (descriptorKeys.some((key) => typeof key === "symbol")) return { ok: false };

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false };
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor
        || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > state.maxArrayItems
      ) {
        return { ok: false };
      }
      const length = lengthDescriptor.value as number;
      if (descriptorKeys.length !== length + 1) return { ok: false };
      const output: PlainSnapshot[] = [];
      for (let i = 0; i < length; i += 1) {
        const descriptor = descriptors[String(i)];
        if (
          !descriptor
          || !("value" in descriptor)
          || descriptor.get
          || descriptor.set
          || descriptor.enumerable !== true
        ) {
          return { ok: false };
        }
        const item = snapshotPlainData(descriptor.value, state, depth + 1);
        if (!item.ok) return item;
        output.push(item.value);
      }
      return { ok: true, value: output };
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { ok: false };
    if (descriptorKeys.length > MAX_PLAIN_KEYS) return { ok: false };
    const output: { [key: string]: PlainSnapshot } = {};
    for (const key of descriptorKeys as string[]) {
      if (key.length > MAX_ID_LEN || isDangerousKey(key)) return { ok: false };
      const descriptor = descriptors[key];
      if (
        !descriptor
        || !("value" in descriptor)
        || descriptor.get
        || descriptor.set
        || descriptor.enumerable !== true
      ) {
        return { ok: false };
      }
      const item = snapshotPlainData(descriptor.value, state, depth + 1);
      if (!item.ok) return item;
      output[key] = item.value;
    }
    return { ok: true, value: output };
  } catch {
    return { ok: false };
  }
}

function takeBoundedSnapshot(
  value: unknown,
  maxArrayItems = MAX_PLAIN_ARRAY_ITEMS,
): { ok: true; value: PlainSnapshot } | { ok: false } {
  return snapshotPlainData(value, {
    seen: new WeakSet<object>(),
    nodes: 0,
    maxArrayItems,
  });
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function asPrimitiveId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed !== value
    || trimmed.length > MAX_ID_LEN
    || /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function canonicalResolution(value: unknown): InternalVideoResolution | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const token = String(value).trim().toLowerCase();
  const aliases: Record<string, InternalVideoResolution> = {
    "480": "480p",
    "480p": "480p",
    sd: "480p",
    "720": "720p",
    "720p": "720p",
    hd: "720p",
    "768": "768p",
    "768p": "768p",
    "960": "960p",
    "960p": "960p",
    "1080": "1080p",
    "1080p": "1080p",
    fhd: "1080p",
    "1440": "2k",
    "1440p": "2k",
    "2k": "2k",
    "2160": "4k",
    "2160p": "4k",
    "4k": "4k",
    uhd: "4k",
    ultra_hd: "4k",
  };
  return Object.prototype.hasOwnProperty.call(aliases, token) ? aliases[token] : null;
}

function deliveryTargetResolution(value: unknown): DeliveryTargetResolution | null {
  const valueCanonical = canonicalResolution(value);
  return valueCanonical && isUserSelectableVideoGenerationResolution(valueCanonical)
    ? valueCanonical
    : null;
}

export function readProviderNativeDeliveryAuthorization(
  value: unknown,
): ProviderNativeDeliveryAuthorization | null {
  const snapshot = takeBoundedSnapshot(value, 1);
  if (
    !snapshot.ok
    || snapshot.value == null
    || typeof snapshot.value !== "object"
    || Array.isArray(snapshot.value)
  ) {
    return null;
  }
  const record = snapshot.value as Record<string, unknown>;
  if (!hasOnlyKeys(record, PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_KEYS)) return null;
  const channelId = asPrimitiveId(record.channelId);
  if (
    Object.keys(record).length !== PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_KEYS.size
    || record.version !== PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_VERSION
    || !((record.provider === "minimax" && record.resolution !== "960p" && (record.model === "MiniMax-H3" || record.model === "MiniMax-H3-Max"))
      || (record.provider === "autodl" && autoDLH3SupportsResolution(record.model, record.resolution)))
    || !channelId
    || (record.resolution !== "480p" && record.resolution !== "768p" && record.resolution !== "960p")
  ) {
    return null;
  }
  return {
    version: PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_VERSION,
    provider: record.provider as ProviderNativeDeliveryAuthorization["provider"],
    model: record.model as ProviderNativeDeliveryAuthorization["model"],
    channelId,
    resolution: record.resolution,
  };
}

function publicResolution(value: unknown): PublicVideoResolution | null {
  const valueCanonical = canonicalResolution(value);
  return valueCanonical && isPublicVideoResolution(valueCanonical)
    ? valueCanonical
    : null;
}

function parseOptionalResolution(
  value: unknown,
  publicOnly: boolean,
  providerNativeAuthorization: ProviderNativeDeliveryAuthorization | null = null,
):
  | { ok: true; value: DeliveryTargetResolution | InternalVideoResolution | null }
  | { ok: false } {
  if (value === undefined) return { ok: true, value: null };
  const parsed = publicOnly
    ? publicResolution(value)
      ?? (
        providerNativeAuthorization
        && deliveryTargetResolution(value) === providerNativeAuthorization.resolution
          ? providerNativeAuthorization.resolution
          : null
      )
    : canonicalResolution(value);
  return parsed ? { ok: true, value: parsed } : { ok: false };
}

function parseOptionalBoolean(
  value: unknown,
): { ok: true; value: boolean } | { ok: false } {
  if (value === undefined) return { ok: true, value: false };
  if (value === true || value === false) return { ok: true, value };
  return { ok: false };
}

function parseEvidenceItem(value: unknown): ParsedEvidenceItem | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, EVIDENCE_KEYS)) return null;
  const id = asPrimitiveId(record.id);
  const evidenceVersion = asPrimitiveId(record.evidenceVersion);
  const taskId = asPrimitiveId(record.taskId);
  const fulfillmentId = asPrimitiveId(record.fulfillmentId);
  const channelId = asPrimitiveId(record.channelId);
  const winningAttemptId = asPrimitiveId(record.winningAttemptId);
  const resultAssetId = asPrimitiveId(record.resultAssetId);
  const resolution = canonicalResolution(record.resolution);
  if (
    !id
    || !evidenceVersion
    || !taskId
    || !fulfillmentId
    || !channelId
    || !winningAttemptId
    || !resultAssetId
    || !resolution
    || (record.trustworthy !== true && record.trustworthy !== false)
    || !isExactStringMember(record.kind, DELIVERY_EVIDENCE_KINDS)
    || !isExactStringMember(record.status, DELIVERY_EVIDENCE_STATUSES)
    || !isExactStringMember(record.phase, DELIVERY_EVIDENCE_PHASES)
    || !isExactStringMember(record.dispatchStatus, DELIVERY_DISPATCH_STATUSES)
    || !isExactStringMember(record.resultStatus, DELIVERY_RESULT_STATUSES)
  ) {
    return null;
  }

  const expectedPhase: Record<DeliveryEvidenceKind, DeliveryEvidencePhase> = {
    generation_output: "generation",
    generation_source: "generation",
    native_source: "generation",
    enhancement_output: "enhancement",
    upscale_output: "upscale",
    fallback_source: "fallback",
  };
  if (record.phase !== expectedPhase[record.kind]) return null;
  if (
    (record.status === "succeeded"
      && (record.dispatchStatus !== "dispatched" || record.resultStatus !== "succeeded"))
    || (record.status === "failed"
      && (
        (record.dispatchStatus !== "dispatched" && record.dispatchStatus !== "failed")
        || record.resultStatus !== "failed"
      ))
    || (record.status === "cancelled"
      && (record.dispatchStatus !== "cancelled" || record.resultStatus !== "cancelled"))
  ) {
    return null;
  }

  return {
    id,
    evidenceVersion,
    taskId,
    fulfillmentId,
    channelId,
    winningAttemptId,
    resultAssetId,
    resolution,
    trustworthy: record.trustworthy,
    kind: record.kind,
    status: record.status,
    phase: record.phase,
    dispatchStatus: record.dispatchStatus,
    resultStatus: record.resultStatus,
  };
}

function parseEvidenceArraySnapshot(
  value: PlainSnapshot,
): { ok: true; items: ParsedEvidenceItem[] } | { ok: false } {
  if (!Array.isArray(value) || value.length > MAX_ATTEMPT_HISTORY) return { ok: false };
  const items: ParsedEvidenceItem[] = [];
  for (const rawItem of value) {
    const item = parseEvidenceItem(rawItem);
    if (!item) return { ok: false };
    items.push(item);
  }
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) return { ok: false };
  return { ok: true, items };
}

function parseEvidencePair(
  evidence: unknown,
  sourceEvidence: unknown,
):
  | { ok: true; evidence: ParsedEvidenceItem[]; sourceEvidence: ParsedEvidenceItem[] }
  | { ok: false } {
  const pair = takeBoundedSnapshot(
    {
      evidence: evidence === undefined ? [] : evidence,
      sourceEvidence: sourceEvidence === undefined ? [] : sourceEvidence,
    },
    MAX_ATTEMPT_HISTORY,
  );
  if (
    !pair.ok
    || pair.value == null
    || typeof pair.value !== "object"
    || Array.isArray(pair.value)
  ) {
    return { ok: false };
  }
  const pairRecord = pair.value as { [key: string]: PlainSnapshot };
  const evidenceParsed = parseEvidenceArraySnapshot(pairRecord.evidence);
  const sourceParsed = parseEvidenceArraySnapshot(pairRecord.sourceEvidence);
  if (!evidenceParsed.ok || !sourceParsed.ok) return { ok: false };
  return {
    ok: true,
    evidence: evidenceParsed.items,
    sourceEvidence: sourceParsed.items,
  };
}

function lineageMatches(item: ParsedEvidenceItem, lineage: EvidenceLineage): boolean {
  return (
    item.taskId === lineage.taskId
    && item.fulfillmentId === lineage.fulfillmentId
    && item.channelId === lineage.channelId
  );
}

function resolveParsedWinner(
  evidence: ParsedEvidenceItem[],
  target: DeliveryTargetResolution,
  authoritativeAttemptId: string,
  authoritativeAssetId: string,
  lineage: EvidenceLineage | null,
  allowedKinds: readonly DeliveryEvidenceKind[],
):
  | { ok: true; ref: WinningEvidenceRef }
  | { ok: false; reason: "missing" | "duplicate" | "invalid" } {
  const candidates = evidence.filter(
    (item) =>
      item.trustworthy
      && item.status === "succeeded"
      && item.dispatchStatus === "dispatched"
      && item.resultStatus === "succeeded"
      && item.resolution === target
      && item.winningAttemptId === authoritativeAttemptId
      && item.resultAssetId === authoritativeAssetId
      && allowedKinds.includes(item.kind)
      && (!lineage || lineageMatches(item, lineage)),
  );
  if (candidates.length === 0) return { ok: false, reason: "missing" };
  if (candidates.length !== 1) return { ok: false, reason: "duplicate" };
  const item = candidates[0];
  if (
    item.kind !== "generation_output"
    && item.kind !== "enhancement_output"
    && item.kind !== "upscale_output"
  ) {
    return { ok: false, reason: "invalid" };
  }
  return {
    ok: true,
    ref: {
      evidenceId: item.id,
      evidenceVersion: item.evidenceVersion,
      taskId: item.taskId,
      fulfillmentId: item.fulfillmentId,
      channelId: item.channelId,
      winningAttemptId: item.winningAttemptId,
      resultAssetId: item.resultAssetId,
      kind: item.kind,
    },
  };
}

function resolveParsedSource(
  evidence: ParsedEvidenceItem[],
  lineage: EvidenceLineage | null,
  sourceAttemptId: string | null,
  sourceAssetId: string | null,
  allowedKinds: readonly DeliveryEvidenceKind[],
):
  | { ok: true; ref: RetainedSourceEvidenceRef }
  | { ok: false } {
  const candidates = evidence.filter(
    (item) =>
      item.trustworthy
      && item.status === "succeeded"
      && item.dispatchStatus === "dispatched"
      && item.resultStatus === "succeeded"
      && allowedKinds.includes(item.kind)
      && (!lineage || lineageMatches(item, lineage))
      && (!sourceAttemptId || item.winningAttemptId === sourceAttemptId)
      && (!sourceAssetId || item.resultAssetId === sourceAssetId),
  );
  if (candidates.length !== 1) return { ok: false };
  const item = candidates[0];
  if (
    item.kind !== "generation_source"
    && item.kind !== "native_source"
    && item.kind !== "fallback_source"
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    ref: {
      evidenceId: item.id,
      evidenceVersion: item.evidenceVersion,
      taskId: item.taskId,
      fulfillmentId: item.fulfillmentId,
      channelId: item.channelId,
      sourceAttemptId: item.winningAttemptId,
      sourceAssetId: item.resultAssetId,
      resolution: item.resolution,
      kind: item.kind,
    },
  };
}

function parseLineageSnapshot(
  value: PlainSnapshot,
): EvidenceLineage | null | false {
  if (value === null) return null;
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || !Object.hasOwn(record, "taskId")
    || !Object.hasOwn(record, "fulfillmentId")
    || !Object.hasOwn(record, "channelId")
  ) {
    return false;
  }
  const taskId = asPrimitiveId(record.taskId);
  const fulfillmentId = asPrimitiveId(record.fulfillmentId);
  const channelId = asPrimitiveId(record.channelId);
  return taskId && fulfillmentId && channelId
    ? { taskId, fulfillmentId, channelId }
    : false;
}

function parseWinnerKindsSnapshot(
  value: PlainSnapshot,
): Array<WinningEvidenceRef["kind"]> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;
  const parsed: Array<WinningEvidenceRef["kind"]> = [];
  for (const kind of value) {
    if (
      kind !== "generation_output"
      && kind !== "enhancement_output"
      && kind !== "upscale_output"
    ) {
      return null;
    }
    parsed.push(kind);
  }
  return new Set(parsed).size === parsed.length ? parsed : null;
}

export function hasDuplicateEvidenceIds(evidence: DeliveryEvidenceItem[]): boolean {
  try {
    const snapshot = takeBoundedSnapshot(evidence, MAX_ATTEMPT_HISTORY);
    if (!snapshot.ok) return true;
    const parsed = parseEvidenceArraySnapshot(snapshot.value);
    if (!parsed.ok) return true;
    const ids = parsed.items.map((item) => item.id);
    return new Set(ids).size !== ids.length;
  } catch {
    return true;
  }
}

export function resolveWinningEvidence(
  evidence: DeliveryEvidenceItem[],
  target: PublicVideoResolution,
  authoritativeAttemptId: string,
  authoritativeAssetId: string,
  expectedLineage?: EvidenceLineage,
  allowedKinds: readonly DeliveryEvidenceKind[] = [
    "generation_output",
    "enhancement_output",
    "upscale_output",
  ],
):
  | { ok: true; ref: WinningEvidenceRef }
  | { ok: false; reason: "missing" | "duplicate" | "invalid" } {
  try {
    // Snapshot the complete helper context once. In particular, lineage and
    // allowedKinds must not be re-read from caller-controlled accessors after
    // evidence validation has already succeeded.
    const snapshot = takeBoundedSnapshot({
      evidence,
      target,
      authoritativeAttemptId,
      authoritativeAssetId,
      expectedLineage: expectedLineage ?? null,
      allowedKinds,
    }, MAX_ATTEMPT_HISTORY);
    if (
      !snapshot.ok
      || snapshot.value == null
      || typeof snapshot.value !== "object"
      || Array.isArray(snapshot.value)
    ) {
      return { ok: false, reason: "invalid" };
    }
    const context = snapshot.value as Record<string, PlainSnapshot>;
    if (Object.keys(context).length !== 6) return { ok: false, reason: "invalid" };
    const parsed = parseEvidenceArraySnapshot(context.evidence);
    const lineage = parseLineageSnapshot(context.expectedLineage);
    const exactAllowedKinds = parseWinnerKindsSnapshot(context.allowedKinds);
    const attemptId = asPrimitiveId(context.authoritativeAttemptId);
    const assetId = asPrimitiveId(context.authoritativeAssetId);
    const exactTarget = publicResolution(context.target);
    if (
      !parsed.ok
      || lineage === false
      || !exactAllowedKinds
      || !attemptId
      || !assetId
      || !exactTarget
    ) {
      return { ok: false, reason: "invalid" };
    }
    return resolveParsedWinner(
      parsed.items,
      exactTarget,
      attemptId,
      assetId,
      lineage,
      exactAllowedKinds,
    );
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export function resolveTrustworthySource(
  evidence: DeliveryEvidenceItem[],
  expectedLineage?: EvidenceLineage,
  sourceAttemptId?: string,
  sourceAssetId?: string,
):
  | { ok: true; ref: RetainedSourceEvidenceRef }
  | { ok: false } {
  try {
    const snapshot = takeBoundedSnapshot({
      evidence,
      expectedLineage: expectedLineage ?? null,
      sourceAttemptId,
      sourceAssetId,
    }, MAX_ATTEMPT_HISTORY);
    if (
      !snapshot.ok
      || snapshot.value == null
      || typeof snapshot.value !== "object"
      || Array.isArray(snapshot.value)
    ) {
      return { ok: false };
    }
    const context = snapshot.value as Record<string, PlainSnapshot>;
    if (Object.keys(context).length !== 4) return { ok: false };
    const parsed = parseEvidenceArraySnapshot(context.evidence);
    const lineage = parseLineageSnapshot(context.expectedLineage);
    const attemptId =
      context.sourceAttemptId === undefined ? null : asPrimitiveId(context.sourceAttemptId);
    const assetId =
      context.sourceAssetId === undefined ? null : asPrimitiveId(context.sourceAssetId);
    if (
      !parsed.ok
      || lineage === false
      || (context.sourceAttemptId !== undefined && !attemptId)
      || (context.sourceAssetId !== undefined && !assetId)
    ) {
      return { ok: false };
    }
    return resolveParsedSource(
      parsed.items,
      lineage,
      attemptId,
      assetId,
      ["generation_source", "native_source", "fallback_source"],
    );
  } catch {
    return { ok: false };
  }
}

export function countActiveOutcomeChannels(flags: {
  generationFailed?: boolean;
  enhancementFailed?: boolean;
  emptyOutput?: boolean;
  cancelled?: boolean;
  hasInProgress?: boolean;
}): number {
  try {
    const snapshot = readPlainRecordOnce(flags, 5);
    if (!snapshot.ok) return 5;
    const values = [
      snapshot.record.generationFailed,
      snapshot.record.enhancementFailed,
      snapshot.record.emptyOutput,
      snapshot.record.cancelled,
      snapshot.record.hasInProgress,
    ];
    if (values.some((value) => value !== undefined && typeof value !== "boolean")) {
      return 5;
    }
    return values.filter((value) => value === true).length;
  } catch {
    return 5;
  }
}

export function isVideoTaskPipeline(value: unknown): value is VideoTaskPipeline {
  return isExactStringMember(value, VIDEO_TASK_PIPELINES);
}

export function isVideoInProgressPhase(value: unknown): value is VideoInProgressPhase {
  return isExactStringMember(value, VIDEO_IN_PROGRESS_PHASES);
}

export function isInProgressPhaseLegalForPipeline(
  pipeline: VideoTaskPipeline,
  phase: VideoInProgressPhase,
): boolean {
  if (!isVideoTaskPipeline(pipeline) || !isVideoInProgressPhase(phase)) return false;
  if (pipeline === "direct_generation") {
    return (
      phase === "queued"
      || phase === "generating"
      || phase === "finalizing"
      || phase === "reconciling"
    );
  }
  if (pipeline === "user_enhance") {
    return (
      phase === "queued"
      || phase === "enhancing"
      || phase === "finalizing"
      || phase === "reconciling"
    );
  }
  return true;
}

export function isSourceStrictlyBelowTarget(
  source: InternalVideoResolution,
  target: DeliveryTargetResolution | null,
): boolean {
  try {
    const exactSource = canonicalResolution(source);
    const exactTarget = publicResolution(target);
    if (!exactSource || !exactTarget) return false;
    return videoResolutionHeight(exactSource) < videoResolutionHeight(exactTarget);
  } catch {
    return false;
  }
}

/**
 * Provider exceptions are not a stable contract.  Keep only a constant
 * diagnostic marker; arbitrary upstream text is intentionally discarded.
 */
export function redactInternalProviderError(raw: unknown): string | null {
  try {
    if (typeof raw === "string") return raw.length > 0 ? REDACTED_PROVIDER_ERROR : null;
    if (typeof raw === "number") return Number.isFinite(raw) ? REDACTED_PROVIDER_ERROR : null;
    if (typeof raw === "boolean") return REDACTED_PROVIDER_ERROR;
    return null;
  } catch {
    return null;
  }
}

function safeRawFinalization(value: unknown): string | null {
  return typeof value === "string" && RAW_FINALIZATION_ALLOWLIST.has(value) ? value : null;
}

function emptyInternal(
  providerErrorInternal: string | null = null,
): DeliveryClassificationProjection["internal"] {
  return {
    providerErrorInternal,
    rawFinalization: null,
    sourceRetained: false,
    reconciliationHint: null,
    winningEvidenceRef: null,
    sourceEvidenceRef: null,
    retainedSourceEvidenceRef: null,
  };
}

function failedProjection(
  pipeline: VideoTaskPipeline,
  input: {
    requestedResolution: DeliveryTargetResolution | null;
    generationResolution: InternalVideoResolution | null;
    deliveredResolution: DeliveryTargetResolution | null;
    deliveryStatus?: VideoDeliveryStatus;
    enhancementStatus?: EnhancementStatus;
    code: PublicDeliveryErrorCode;
    providerErrorInternal?: string | null;
  },
): DeliveryClassificationProjection {
  return {
    pipeline,
    requestedResolution: input.requestedResolution,
    generationResolution: input.generationResolution,
    deliveredResolution: input.deliveredResolution,
    taskStatus: "failed",
    phase: "terminal",
    deliveryStatus: input.deliveryStatus ?? "failed",
    enhancementStatus:
      input.enhancementStatus
      ?? (pipeline === "direct_generation" ? "not_required" : "failed"),
    metRequestedQuality: false,
    failure: { code: input.code, safeMessage: SAFE_MESSAGES[input.code] },
    internal: emptyInternal(input.providerErrorInternal ?? null),
  };
}

function buildError(
  code: "INVALID_PIPELINE" | "INVALID_REQUEST",
): BuildDeliveryProjectionResult {
  return { ok: false, error: { code, safeMessage: SAFE_MESSAGES[code] } };
}

const VERIFIED_PROJECTION_INTEGRITY =
  new WeakMap<DeliveryClassificationProjection, string>();

function freezeProjection(
  projection: DeliveryClassificationProjection,
): DeliveryClassificationProjection {
  if (projection.failure) Object.freeze(projection.failure);
  if (projection.internal.reconciliationHint) {
    Object.freeze(projection.internal.reconciliationHint);
  }
  if (projection.internal.winningEvidenceRef) {
    Object.freeze(projection.internal.winningEvidenceRef);
  }
  if (projection.internal.sourceEvidenceRef) {
    Object.freeze(projection.internal.sourceEvidenceRef);
  }
  if (projection.internal.retainedSourceEvidenceRef) {
    Object.freeze(projection.internal.retainedSourceEvidenceRef);
  }
  Object.freeze(projection.internal);
  return Object.freeze(projection);
}

function projectionResult(
  projection: DeliveryClassificationProjection,
): BuildDeliveryProjectionResult {
  // Publication is deliberately tied to the exact in-memory projection built
  // by this module. The integrity snapshot also detects mutation between
  // classification and attachment; a structurally plausible caller-forged
  // object is not treated as verified delivery evidence.
  const immutableProjection = freezeProjection(projection);
  VERIFIED_PROJECTION_INTEGRITY.set(
    immutableProjection,
    JSON.stringify(immutableProjection),
  );
  return { ok: true, projection: immutableProjection };
}

function requiredLineage(
  record: Record<string, unknown>,
): EvidenceLineage | null {
  const taskId = asPrimitiveId(record.taskId);
  const fulfillmentId = asPrimitiveId(record.fulfillmentId);
  const channelId = asPrimitiveId(record.channelId);
  return taskId && fulfillmentId && channelId
    ? { taskId, fulfillmentId, channelId }
    : null;
}

export function buildDeliverySnapshot(input: unknown): BuildDeliveryProjectionResult {
  try {
    const root = readPlainRecordOnce(input);
    if (!root.ok || !hasOnlyKeys(root.record, ROOT_KEYS)) return buildError("INVALID_REQUEST");
    return buildDeliverySnapshotFromRecord(root.record);
  } catch {
    return buildError("INVALID_REQUEST");
  }
}

/** @deprecated local alias only. */
export const buildDeliveryProjection = buildDeliverySnapshot;

function buildDeliverySnapshotFromRecord(
  record: Record<string, unknown>,
): BuildDeliveryProjectionResult {
  if (!isVideoTaskPipeline(record.pipeline)) return buildError("INVALID_PIPELINE");
  const pipeline = record.pipeline;

  const rawProviderNativeAuthorization = record.allowProviderNativeNonPublicResolution;
  const providerNativeAuthorization = rawProviderNativeAuthorization === undefined
    ? null
    : readProviderNativeDeliveryAuthorization(rawProviderNativeAuthorization);
  if (rawProviderNativeAuthorization !== undefined && !providerNativeAuthorization) {
    return buildError("INVALID_REQUEST");
  }
  const requestedParsed = parseOptionalResolution(
    record.requestedResolution,
    true,
    providerNativeAuthorization,
  );
  const generationParsed = parseOptionalResolution(record.generationResolution, false);
  const deliveredParsed = parseOptionalResolution(
    record.deliveredResolution,
    true,
    providerNativeAuthorization,
  );
  const providerErrorInternal = redactInternalProviderError(record.providerErrorInternal);

  const booleans = {
    generationFailed: parseOptionalBoolean(record.generationFailed),
    enhancementFailed: parseOptionalBoolean(record.enhancementFailed),
    emptyOutput: parseOptionalBoolean(record.emptyOutput),
    cancelled: parseOptionalBoolean(record.cancelled),
    outcomeUnknown: parseOptionalBoolean(record.outcomeUnknown),
    sourceRetained: parseOptionalBoolean(record.sourceRetained),
  };
  if (
    !booleans.generationFailed.ok
    || !booleans.enhancementFailed.ok
    || !booleans.emptyOutput.ok
    || !booleans.cancelled.ok
    || !booleans.outcomeUnknown.ok
    || !booleans.sourceRetained.ok
  ) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution: requestedParsed.ok
          ? (requestedParsed.value as DeliveryTargetResolution | null)
          : null,
        generationResolution: generationParsed.ok
          ? (generationParsed.value as InternalVideoResolution | null)
          : null,
        deliveredResolution: deliveredParsed.ok
          ? (deliveredParsed.value as DeliveryTargetResolution | null)
          : null,
        code: "INVALID_REQUEST",
        providerErrorInternal,
      }),
    );
  }
  if (!requestedParsed.ok || !generationParsed.ok || !deliveredParsed.ok) {
    const badRequested = !requestedParsed.ok;
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution: null,
        generationResolution: generationParsed.ok
          ? (generationParsed.value as InternalVideoResolution | null)
          : null,
        deliveredResolution: deliveredParsed.ok
          ? (deliveredParsed.value as DeliveryTargetResolution | null)
          : null,
        code:
          badRequested
          && (typeof record.requestedResolution === "string"
            || typeof record.requestedResolution === "number")
            ? "ALIAS_MISMATCH"
            : "INVALID_REQUEST",
        providerErrorInternal,
      }),
    );
  }

  const requestedResolution = requestedParsed.value as DeliveryTargetResolution | null;
  const generationResolution = generationParsed.value as InternalVideoResolution | null;
  const deliveredResolution = deliveredParsed.value as DeliveryTargetResolution | null;
  if (
    providerNativeAuthorization
    && (
      pipeline !== "direct_generation"
      || asPrimitiveId(record.channelId) !== providerNativeAuthorization.channelId
      || requestedResolution !== providerNativeAuthorization.resolution
      || generationResolution !== providerNativeAuthorization.resolution
      || (
        deliveredResolution !== null
        && deliveredResolution !== providerNativeAuthorization.resolution
      )
    )
  ) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "INVALID_REQUEST",
        providerErrorInternal,
      }),
    );
  }
  const generationFailed = booleans.generationFailed.value;
  const enhancementFailed = booleans.enhancementFailed.value;
  const emptyOutput = booleans.emptyOutput.value;
  const cancelled = booleans.cancelled.value;
  const outcomeUnknown = booleans.outcomeUnknown.value;
  const sourceRetained = booleans.sourceRetained.value;

  let inProgressPhase: VideoInProgressPhase | null = null;
  if (record.inProgressPhase !== undefined) {
    if (!isVideoInProgressPhase(record.inProgressPhase)) {
      return projectionResult(
        failedProjection(pipeline, {
          requestedResolution,
          generationResolution,
          deliveredResolution,
          code: "INVALID_REQUEST",
          providerErrorInternal,
        }),
      );
    }
    inProgressPhase = record.inProgressPhase;
  }

  const evidence = parseEvidencePair(record.evidence, record.sourceEvidence);
  if (!evidence.ok) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "EVIDENCE_INVALID",
        providerErrorInternal,
      }),
    );
  }

  const outcomeCount = countActiveOutcomeChannels({
    generationFailed,
    enhancementFailed,
    emptyOutput,
    cancelled,
    hasInProgress: inProgressPhase !== null,
  });
  if (
    outcomeCount > 1
    || (outcomeUnknown && outcomeCount > 0)
    || (sourceRetained && !enhancementFailed)
  ) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "INVALID_REQUEST",
        providerErrorInternal,
      }),
    );
  }

  if (outcomeUnknown) {
    return projectionResult({
      pipeline,
      requestedResolution,
      generationResolution,
      deliveredResolution,
      taskStatus: "pending_reconcile",
      phase: "reconciling",
      deliveryStatus: "pending_reconcile",
      enhancementStatus: "pending_reconcile",
      metRequestedQuality: false,
      failure: {
        code: "RECONCILE_REQUIRED",
        safeMessage: SAFE_MESSAGES.RECONCILE_REQUIRED,
      },
      internal: {
        providerErrorInternal,
        rawFinalization: safeRawFinalization(record.rawFinalization),
        sourceRetained: false,
        reconciliationHint: {
          kind: "billing_reconciliation_required",
          reason: "outcome_unknown",
        },
        winningEvidenceRef: null,
        sourceEvidenceRef: null,
        retainedSourceEvidenceRef: null,
      },
    });
  }

  if (enhancementFailed && pipeline === "direct_generation") {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "INVALID_REQUEST",
        enhancementStatus: "not_required",
        providerErrorInternal,
      }),
    );
  }

  if (cancelled) {
    return projectionResult({
      pipeline,
      requestedResolution,
      generationResolution,
      deliveredResolution,
      taskStatus: "cancelled",
      phase: "terminal",
      deliveryStatus: "cancelled",
      enhancementStatus: pipeline === "direct_generation" ? "not_required" : "cancelled",
      metRequestedQuality: false,
      failure: { code: "CANCELLED", safeMessage: SAFE_MESSAGES.CANCELLED },
      internal: emptyInternal(providerErrorInternal),
    });
  }

  if (inProgressPhase) {
    if (!isInProgressPhaseLegalForPipeline(pipeline, inProgressPhase)) {
      return projectionResult(
        failedProjection(pipeline, {
          requestedResolution,
          generationResolution,
          deliveredResolution,
          code: "INVALID_REQUEST",
          providerErrorInternal,
        }),
      );
    }
    const taskStatus: VideoTaskStatus =
      inProgressPhase === "reconciling"
        ? "pending_reconcile"
        : inProgressPhase === "queued"
          ? "queued"
          : "running";
    return projectionResult({
      pipeline,
      requestedResolution,
      generationResolution,
      deliveredResolution: null,
      taskStatus,
      phase: inProgressPhase,
      deliveryStatus: inProgressPhase === "reconciling" ? "pending_reconcile" : "pending",
      enhancementStatus:
        inProgressPhase === "enhancing"
          ? "running"
          : inProgressPhase === "reconciling"
            ? "pending_reconcile"
            : pipeline === "direct_generation"
              ? "not_required"
              : "pending",
      metRequestedQuality: false,
      failure: null,
      internal: {
        providerErrorInternal,
        rawFinalization: null,
        sourceRetained: false,
        reconciliationHint:
          inProgressPhase === "reconciling"
            ? {
                kind: "billing_reconciliation_required",
                reason: "reconciling_phase",
              }
            : null,
        winningEvidenceRef: null,
        sourceEvidenceRef: null,
        retainedSourceEvidenceRef: null,
      },
    });
  }

  if (generationFailed) {
    // Classify explicit moderation refusals before replacing provider details
    // with a redaction marker. Only the fixed public code/message is exposed;
    // a review service timeout or an unknown failure must stay generic.
    const providerError = typeof record.providerErrorInternal === "string"
      ? record.providerErrorInternal.slice(0, 16_384) : "";
    const contentRejected = /\b(?:input|output)(?:text|image|video|audio)?sensitivecontentdetected\b|\bmay contain sensitive information\b|上游内容审核未通过/i.test(providerError);
    const unavailable = /video generation service is temporarily unavailable/i.test(providerError);
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution: null,
        code: contentRejected ? "CONTENT_REVIEW_REJECTED" : unavailable ? "UPSTREAM_TEMPORARILY_UNAVAILABLE" : "GENERATION_FAILED",
        enhancementStatus: "not_required",
        providerErrorInternal,
      }),
    );
  }
  if (emptyOutput) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution: null,
        code: "EMPTY_OUTPUT",
        providerErrorInternal,
      }),
    );
  }

  if (enhancementFailed) {
    if (pipeline === "user_enhance") {
      return projectionResult(
        failedProjection(pipeline, {
          requestedResolution,
          generationResolution,
          deliveredResolution,
          code: "USER_ENHANCE_FAILED",
          providerErrorInternal,
        }),
      );
    }
    if (!sourceRetained) {
      return projectionResult(
        failedProjection(pipeline, {
          requestedResolution,
          generationResolution,
          deliveredResolution: null,
          code: "ENHANCEMENT_FAILED",
          providerErrorInternal,
        }),
      );
    }
    const lineage = requiredLineage(record);
    const sourceAttemptId = asPrimitiveId(record.sourceAttemptId);
    const sourceAssetId = asPrimitiveId(record.sourceAssetId);
    const sourceProof =
      lineage && sourceAttemptId && sourceAssetId
        ? resolveParsedSource(
            evidence.sourceEvidence,
            lineage,
            sourceAttemptId,
            sourceAssetId,
            ["generation_source", "native_source", "fallback_source"],
          )
        : { ok: false as const };
    if (
      !sourceProof.ok
      || !generationResolution
      || generationResolution !== sourceProof.ref.resolution
      || !isSourceStrictlyBelowTarget(sourceProof.ref.resolution, requestedResolution)
      || (
        deliveredResolution !== null
        && deliveredResolution !== publicResolution(sourceProof.ref.resolution)
      )
    ) {
      return projectionResult(
        failedProjection(pipeline, {
          requestedResolution,
          generationResolution,
          deliveredResolution: null,
          code: "EVIDENCE_INVALID",
          providerErrorInternal,
        }),
      );
    }
    return projectionResult({
      pipeline,
      requestedResolution,
      generationResolution,
      deliveredResolution: publicResolution(sourceProof.ref.resolution),
      taskStatus: "failed",
      phase: "terminal",
      deliveryStatus: "degraded_source_only",
      enhancementStatus: "failed",
      metRequestedQuality: false,
      failure: {
        code: "ENHANCEMENT_FAILED",
        safeMessage: SAFE_MESSAGES.ENHANCEMENT_FAILED,
      },
      internal: {
        providerErrorInternal,
        rawFinalization:
          safeRawFinalization(record.rawFinalization)
          ?? "enhancement_failed_source_retained",
        sourceRetained: true,
        reconciliationHint: {
          kind: "billing_reconciliation_required",
          reason: "enhancement_failed_source_retained",
        },
        winningEvidenceRef: null,
        sourceEvidenceRef: sourceProof.ref,
        // Keep the two semantic slots value-equal but structurally distinct so
        // the bounded no-alias snapshot can verify the projection.
        retainedSourceEvidenceRef: { ...sourceProof.ref },
      },
    });
  }

  if (!requestedResolution || !deliveredResolution) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "EMPTY_OUTPUT",
        providerErrorInternal,
      }),
    );
  }
  if (deliveredResolution !== requestedResolution) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "RESOLUTION_MISMATCH",
        providerErrorInternal,
      }),
    );
  }

  const lineage = requiredLineage(record);
  const winnerAttemptId = asPrimitiveId(record.winningAttemptId);
  const winnerAssetId = asPrimitiveId(record.resultAssetId);
  if (!lineage || !winnerAttemptId || !winnerAssetId) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "EVIDENCE_INVALID",
        providerErrorInternal,
      }),
    );
  }
  const winnerKinds: readonly DeliveryEvidenceKind[] =
    pipeline === "direct_generation"
      ? ["generation_output"]
      : ["enhancement_output", "upscale_output"];
  const winner = resolveParsedWinner(
    evidence.evidence,
    requestedResolution,
    winnerAttemptId,
    winnerAssetId,
    lineage,
    winnerKinds,
  );
  if (!winner.ok) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "EVIDENCE_INVALID",
        providerErrorInternal,
      }),
    );
  }

  if (pipeline === "direct_generation") {
    if (!generationResolution || generationResolution !== requestedResolution) {
      return projectionResult(
        failedProjection(pipeline, {
          requestedResolution,
          generationResolution,
          deliveredResolution,
          code: "RESOLUTION_MISMATCH",
          enhancementStatus: "not_required",
          providerErrorInternal,
        }),
      );
    }
    return projectionResult({
      pipeline,
      requestedResolution,
      generationResolution,
      deliveredResolution,
      taskStatus: "succeeded",
      phase: "terminal",
      deliveryStatus: "delivered_native",
      enhancementStatus: "not_required",
      metRequestedQuality: true,
      failure: null,
      internal: {
        providerErrorInternal: null,
        rawFinalization: safeRawFinalization(record.rawFinalization),
        sourceRetained: false,
        reconciliationHint: null,
        winningEvidenceRef: winner.ref,
        sourceEvidenceRef: null,
        retainedSourceEvidenceRef: null,
      },
    });
  }

  const sourceAttemptId = asPrimitiveId(record.sourceAttemptId);
  const sourceAssetId = asPrimitiveId(record.sourceAssetId);
  const source = sourceAttemptId && sourceAssetId
    ? resolveParsedSource(
        evidence.sourceEvidence,
        lineage,
        sourceAttemptId,
        sourceAssetId,
        ["generation_source", "native_source"],
      )
    : { ok: false as const };
  if (
    !source.ok
    || !generationResolution
    || source.ref.resolution !== generationResolution
    || !isSourceStrictlyBelowTarget(generationResolution, requestedResolution)
    || source.ref.evidenceId === winner.ref.evidenceId
    || source.ref.sourceAttemptId === winner.ref.winningAttemptId
    || source.ref.sourceAssetId === winner.ref.resultAssetId
  ) {
    return projectionResult(
      failedProjection(pipeline, {
        requestedResolution,
        generationResolution,
        deliveredResolution,
        code: "EVIDENCE_INVALID",
        providerErrorInternal,
      }),
    );
  }

  return projectionResult({
    pipeline,
    requestedResolution,
    generationResolution,
    deliveredResolution,
    taskStatus: "succeeded",
    phase: "terminal",
    deliveryStatus: "delivered_enhanced",
    enhancementStatus: "succeeded",
    metRequestedQuality: true,
    failure: null,
    internal: {
      providerErrorInternal: null,
      rawFinalization: safeRawFinalization(record.rawFinalization),
      sourceRetained: false,
      reconciliationHint: null,
      winningEvidenceRef: winner.ref,
      sourceEvidenceRef: source.ref,
      retainedSourceEvidenceRef: null,
    },
  });
}

function cleanReconciliationHint(value: unknown): ReconciliationHint | null | false {
  if (value === null) return null;
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || record.kind !== "billing_reconciliation_required"
    || (
      record.reason !== "outcome_unknown"
      && record.reason !== "reconciling_phase"
      && record.reason !== "enhancement_failed_source_retained"
    )
  ) {
    return false;
  }
  return {
    kind: "billing_reconciliation_required",
    reason: record.reason,
  };
}

function cleanWinningRef(value: unknown): WinningEvidenceRef | null | false {
  if (value === null) return null;
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const evidenceId = asPrimitiveId(record.evidenceId);
  const evidenceVersion = asPrimitiveId(record.evidenceVersion);
  const taskId = asPrimitiveId(record.taskId);
  const fulfillmentId = asPrimitiveId(record.fulfillmentId);
  const channelId = asPrimitiveId(record.channelId);
  const winningAttemptId = asPrimitiveId(record.winningAttemptId);
  const resultAssetId = asPrimitiveId(record.resultAssetId);
  if (
    !evidenceId
    || !evidenceVersion
    || !taskId
    || !fulfillmentId
    || !channelId
    || !winningAttemptId
    || !resultAssetId
    || (
      record.kind !== "generation_output"
      && record.kind !== "enhancement_output"
      && record.kind !== "upscale_output"
    )
  ) {
    return false;
  }
  return {
    evidenceId,
    evidenceVersion,
    taskId,
    fulfillmentId,
    channelId,
    winningAttemptId,
    resultAssetId,
    kind: record.kind,
  };
}

function cleanSourceRef(value: unknown): RetainedSourceEvidenceRef | null | false {
  if (value === null) return null;
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const evidenceId = asPrimitiveId(record.evidenceId);
  const evidenceVersion = asPrimitiveId(record.evidenceVersion);
  const taskId = asPrimitiveId(record.taskId);
  const fulfillmentId = asPrimitiveId(record.fulfillmentId);
  const channelId = asPrimitiveId(record.channelId);
  const sourceAttemptId = asPrimitiveId(record.sourceAttemptId);
  const sourceAssetId = asPrimitiveId(record.sourceAssetId);
  const resolution = canonicalResolution(record.resolution);
  if (
    !evidenceId
    || !evidenceVersion
    || !taskId
    || !fulfillmentId
    || !channelId
    || !sourceAttemptId
    || !sourceAssetId
    || !resolution
    || (
      record.kind !== "generation_source"
      && record.kind !== "native_source"
      && record.kind !== "fallback_source"
    )
  ) {
    return false;
  }
  return {
    evidenceId,
    evidenceVersion,
    taskId,
    fulfillmentId,
    channelId,
    sourceAttemptId,
    sourceAssetId,
    resolution,
    kind: record.kind,
  };
}

function sameLineage(left: EvidenceLineage, right: EvidenceLineage): boolean {
  return (
    left.taskId === right.taskId
    && left.fulfillmentId === right.fulfillmentId
    && left.channelId === right.channelId
  );
}

function sameSourceRef(
  left: RetainedSourceEvidenceRef,
  right: RetainedSourceEvidenceRef,
): boolean {
  return (
    sameLineage(left, right)
    && left.evidenceId === right.evidenceId
    && left.evidenceVersion === right.evidenceVersion
    && left.sourceAttemptId === right.sourceAttemptId
    && left.sourceAssetId === right.sourceAssetId
    && left.resolution === right.resolution
    && left.kind === right.kind
  );
}

function hasNoEvidenceRefs(
  internal: DeliveryClassificationProjection["internal"],
): boolean {
  return (
    internal.winningEvidenceRef === null
    && internal.sourceEvidenceRef === null
    && internal.retainedSourceEvidenceRef === null
  );
}

function projectionStateIsConsistent(
  projection: DeliveryClassificationProjection,
): boolean {
  const internal = projection.internal;

  if (projection.taskStatus === "succeeded") {
    const winner = internal.winningEvidenceRef;
    if (
      projection.phase !== "terminal"
      || !projection.metRequestedQuality
      || projection.failure !== null
      || projection.requestedResolution === null
      || projection.deliveredResolution !== projection.requestedResolution
      || winner === null
      || internal.providerErrorInternal !== null
      || internal.sourceRetained
      || internal.reconciliationHint !== null
      || internal.retainedSourceEvidenceRef !== null
    ) {
      return false;
    }
    if (projection.deliveryStatus === "delivered_native") {
      return (
        projection.pipeline === "direct_generation"
        && projection.enhancementStatus === "not_required"
        && projection.generationResolution === projection.requestedResolution
        && winner.kind === "generation_output"
        && internal.sourceEvidenceRef === null
      );
    }
    if (
      projection.deliveryStatus !== "delivered_enhanced"
      || projection.pipeline === "direct_generation"
      || projection.enhancementStatus !== "succeeded"
      || projection.generationResolution === null
      || (winner.kind !== "enhancement_output" && winner.kind !== "upscale_output")
    ) {
      return false;
    }
    const source = internal.sourceEvidenceRef;
    return (
      source !== null
      && (source.kind === "generation_source" || source.kind === "native_source")
      && source.resolution === projection.generationResolution
      && isSourceStrictlyBelowTarget(
        projection.generationResolution,
        projection.requestedResolution,
      )
      && sameLineage(winner, source)
      && winner.evidenceId !== source.evidenceId
      && winner.winningAttemptId !== source.sourceAttemptId
      && winner.resultAssetId !== source.sourceAssetId
    );
  }

  if (projection.taskStatus === "failed") {
    if (
      projection.phase !== "terminal"
      || projection.metRequestedQuality
      || projection.failure === null
      || internal.winningEvidenceRef !== null
    ) {
      return false;
    }
    if (projection.deliveryStatus === "degraded_source_only") {
      const source = internal.sourceEvidenceRef;
      const retained = internal.retainedSourceEvidenceRef;
      return (
        projection.pipeline === "generate_then_enhance"
        && projection.enhancementStatus === "failed"
        && projection.failure.code === "ENHANCEMENT_FAILED"
        && projection.requestedResolution !== null
        && projection.generationResolution !== null
        && internal.sourceRetained
        && source !== null
        && retained !== null
        && sameSourceRef(source, retained)
        && source.resolution === projection.generationResolution
        && projection.deliveredResolution === publicResolution(source.resolution)
        && isSourceStrictlyBelowTarget(
          source.resolution,
          projection.requestedResolution,
        )
        && internal.reconciliationHint?.kind === "billing_reconciliation_required"
        && internal.reconciliationHint.reason === "enhancement_failed_source_retained"
      );
    }
    return (
      projection.deliveryStatus === "failed"
      && projection.failure.code !== "CANCELLED"
      && projection.failure.code !== "RECONCILE_REQUIRED"
      && !internal.sourceRetained
      && internal.reconciliationHint === null
      && internal.rawFinalization === null
      && hasNoEvidenceRefs(internal)
      && (
        projection.pipeline === "direct_generation"
          ? projection.enhancementStatus === "not_required"
          : projection.enhancementStatus === "not_required"
            || projection.enhancementStatus === "failed"
      )
    );
  }

  if (projection.taskStatus === "cancelled") {
    return (
      projection.phase === "terminal"
      && projection.deliveryStatus === "cancelled"
      && !projection.metRequestedQuality
      && projection.failure?.code === "CANCELLED"
      && !internal.sourceRetained
      && internal.reconciliationHint === null
      && internal.rawFinalization === null
      && hasNoEvidenceRefs(internal)
      && (
        projection.pipeline === "direct_generation"
          ? projection.enhancementStatus === "not_required"
          : projection.enhancementStatus === "cancelled"
      )
    );
  }

  if (projection.taskStatus === "queued") {
    return (
      projection.phase === "queued"
      && projection.deliveryStatus === "pending"
      && projection.deliveredResolution === null
      && !projection.metRequestedQuality
      && projection.failure === null
      && !internal.sourceRetained
      && internal.reconciliationHint === null
      && internal.rawFinalization === null
      && hasNoEvidenceRefs(internal)
      && (
        projection.pipeline === "direct_generation"
          ? projection.enhancementStatus === "not_required"
          : projection.enhancementStatus === "pending"
      )
    );
  }

  if (projection.taskStatus === "running") {
    const expectedEnhancementStatus: EnhancementStatus =
      projection.phase === "enhancing"
        ? "running"
        : projection.pipeline === "direct_generation"
          ? "not_required"
          : "pending";
    return (
      projection.phase !== "queued"
      && projection.phase !== "reconciling"
      && projection.phase !== "terminal"
      && isInProgressPhaseLegalForPipeline(projection.pipeline, projection.phase)
      && projection.deliveryStatus === "pending"
      && projection.deliveredResolution === null
      && projection.enhancementStatus === expectedEnhancementStatus
      && !projection.metRequestedQuality
      && projection.failure === null
      && !internal.sourceRetained
      && internal.reconciliationHint === null
      && internal.rawFinalization === null
      && hasNoEvidenceRefs(internal)
    );
  }

  if (projection.taskStatus === "pending_reconcile") {
    const common =
      projection.phase === "reconciling"
      && projection.deliveryStatus === "pending_reconcile"
      && projection.enhancementStatus === "pending_reconcile"
      && !projection.metRequestedQuality
      && !internal.sourceRetained
      && hasNoEvidenceRefs(internal)
      && internal.reconciliationHint?.kind === "billing_reconciliation_required";
    if (!common) return false;
    if (projection.failure === null) {
      return (
        projection.deliveredResolution === null
        && internal.rawFinalization === null
        && internal.reconciliationHint?.reason === "reconciling_phase"
      );
    }
    return (
      projection.failure.code === "RECONCILE_REQUIRED"
      && internal.reconciliationHint?.reason === "outcome_unknown"
    );
  }

  return false;
}

function cleanProjection(
  value: PlainSnapshot,
): DeliveryClassificationProjection | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !isExactStringMember(record.pipeline, VIDEO_TASK_PIPELINES)
    || !isExactStringMember(record.taskStatus, VIDEO_TASK_STATUSES)
    || !isExactStringMember(record.phase, VIDEO_TASK_PHASES)
    || !isExactStringMember(record.deliveryStatus, VIDEO_DELIVERY_STATUSES)
    || !isExactStringMember(record.enhancementStatus, ENHANCEMENT_STATUSES)
    || typeof record.metRequestedQuality !== "boolean"
  ) {
    return null;
  }
  const requestedResolution =
    record.requestedResolution === null ? null : deliveryTargetResolution(record.requestedResolution);
  const generationResolution =
    record.generationResolution === null ? null : canonicalResolution(record.generationResolution);
  const deliveredResolution =
    record.deliveredResolution === null ? null : deliveryTargetResolution(record.deliveredResolution);
  if (
    (record.requestedResolution !== null && !requestedResolution)
    || (record.generationResolution !== null && !generationResolution)
    || (record.deliveredResolution !== null && !deliveredResolution)
  ) {
    return null;
  }

  let failure: SafeVideoFailure | null = null;
  if (record.failure !== null) {
    if (
      record.failure == null
      || typeof record.failure !== "object"
      || Array.isArray(record.failure)
    ) {
      return null;
    }
    const failureRecord = record.failure as Record<string, unknown>;
    if (
      !isExactStringMember(failureRecord.code, PUBLIC_DELIVERY_ERROR_CODES)
      || failureRecord.safeMessage !== SAFE_MESSAGES[failureRecord.code]
    ) {
      return null;
    }
    failure = {
      code: failureRecord.code,
      safeMessage: SAFE_MESSAGES[failureRecord.code],
    };
  }

  if (record.internal == null || typeof record.internal !== "object" || Array.isArray(record.internal)) {
    return null;
  }
  const internal = record.internal as Record<string, unknown>;
  const reconciliationHint = cleanReconciliationHint(internal.reconciliationHint);
  const winningEvidenceRef = cleanWinningRef(internal.winningEvidenceRef);
  const sourceEvidenceRef = cleanSourceRef(internal.sourceEvidenceRef);
  const retainedSourceEvidenceRef = cleanSourceRef(internal.retainedSourceEvidenceRef);
  if (
    reconciliationHint === false
    || winningEvidenceRef === false
    || sourceEvidenceRef === false
    || retainedSourceEvidenceRef === false
    || typeof internal.sourceRetained !== "boolean"
    || (
      internal.providerErrorInternal !== null
      && internal.providerErrorInternal !== REDACTED_PROVIDER_ERROR
    )
    || (
      internal.rawFinalization !== null
      && (
        typeof internal.rawFinalization !== "string"
        || !RAW_FINALIZATION_ALLOWLIST.has(internal.rawFinalization)
      )
    )
  ) {
    return null;
  }

  const cleaned: DeliveryClassificationProjection = {
    pipeline: record.pipeline,
    requestedResolution,
    generationResolution,
    deliveredResolution,
    taskStatus: record.taskStatus,
    phase: record.phase,
    deliveryStatus: record.deliveryStatus,
    enhancementStatus: record.enhancementStatus,
    metRequestedQuality: record.metRequestedQuality,
    failure,
    internal: {
      providerErrorInternal: internal.providerErrorInternal as string | null,
      rawFinalization: internal.rawFinalization as string | null,
      sourceRetained: internal.sourceRetained,
      reconciliationHint,
      winningEvidenceRef,
      sourceEvidenceRef,
      retainedSourceEvidenceRef,
    },
  };
  return projectionStateIsConsistent(cleaned) ? cleaned : null;
}

const FORBIDDEN_PUBLIC_KEY =
  /(?:pipeline|enhancement|provider|channel|source.?retained|reconciliation|evidence|authorization|token|credential|password|secret|cookie|signature|api.?key)/iu;
const SENSITIVE_PUBLIC_MARKERS = [
  "deliveredenhanced",
  "authorization",
  "bearer",
  "accesstoken",
  "password",
  "credential",
  "cookie",
  "signature",
  "apikey",
  "token",
  "secret",
] as const;
const SENSITIVE_PUBLIC_MARKER_PATTERNS = SENSITIVE_PUBLIC_MARKERS.map((marker) => {
  const compactMarker = marker.replace(/[^a-z0-9]/gu, "");
  const separatedMarker = [...compactMarker].join("[^a-z0-9]*");
  // A marker may be escaped or punctuation-split, but it must end at an
  // alphanumeric boundary. A malformed percent triplet is treated as one
  // opaque boundary, so "%ZZBearer" remains closed without turning ordinary
  // words such as "secretary" or "api-keyboard" into markers.
  return new RegExp(
    `(?:^|[^a-z0-9]|%[a-z0-9]{2})${separatedMarker}(?![a-z0-9])`,
    "u",
  );
});

function decodeValidPercentRuns(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)));
    }
  });
}

function normalizeSensitiveText(
  value: string,
): { value: string; converged: boolean } {
  let normalized = value.normalize("NFKC").toLowerCase();
  // Every successful escape/percent decode shortens the bounded input. Using
  // input length + one stable pass therefore supports every representable
  // nesting depth without an attacker-controlled unbounded loop.
  const maxPasses = Math.min(MAX_PLAIN_STRING_LEN + 1, value.length + 1);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const decodedEscapes = normalized
      .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex: string) => {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
      })
      .replace(/\\u([0-9a-f]{4})/giu, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/giu, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)));
    const next = decodeValidPercentRuns(decodedEscapes)
      .normalize("NFKC")
      .toLowerCase();
    if (next.length > MAX_PLAIN_STRING_LEN) {
      return { value: next, converged: false };
    }
    if (next === normalized) return { value: next, converged: true };
    normalized = next;
  }
  return { value: normalized, converged: false };
}

function containsSensitivePublicMarker(value: string): boolean {
  if (value.length > MAX_PLAIN_STRING_LEN) return true;
  const normalized = normalizeSensitiveText(value);
  if (!normalized.converged) return true;
  return SENSITIVE_PUBLIC_MARKER_PATTERNS.some((pattern) =>
    pattern.test(normalized.value));
}

function cleanPublicUrl(value: PlainSnapshot): string | null {
  if (typeof value !== "string" || containsSensitivePublicMarker(value)) return null;
  if (
    value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("?")
    && !value.includes("#")
    && !value.split("/").includes("..")
  ) {
    return value;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
    )
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function preserveAllowedPublicFields(
  value: { [key: string]: PlainSnapshot },
): { [key: string]: PlainSnapshot } {
  const output: { [key: string]: PlainSnapshot } = {};
  if (Object.prototype.hasOwnProperty.call(value, "video_url")) {
    const url = cleanPublicUrl(value.video_url);
    if (url) output.video_url = url;
  }
  if (Object.prototype.hasOwnProperty.call(value, "resolution")) {
    const resolution = publicResolution(value.resolution);
    if (resolution) output.resolution = resolution;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "caption")
    && typeof value.caption === "string"
    && !containsSensitivePublicMarker(value.caption)
  ) {
    output.caption = value.caption;
  }
  return output;
}

function publicDeliveryStatus(status: VideoDeliveryStatus):
  | "pending"
  | "delivered"
  | "degraded"
  | "failed"
  | "cancelled" {
  if (status === "delivered_native" || status === "delivered_enhanced") return "delivered";
  if (status === "degraded_source_only") return "degraded";
  if (status === "pending" || status === "pending_reconcile") return "pending";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

/**
 * Preserve an explicit allowlist of bounded public fields while replacing the
 * formal delivery slice. Internal implementation facts stay internal.
 * Arbitrary public error/header wrappers are dropped instead of regex-scrubbed
 * so split arrays and escaped credential markers cannot cross the boundary.
 */
export function attachPublicDeliverySlice(
  resultPayload: Record<string, unknown>,
  projection: DeliveryClassificationProjection,
): Record<string, unknown> {
  try {
    const expectedProjectionIntegrity = VERIFIED_PROJECTION_INTEGRITY.get(projection);
    if (!expectedProjectionIntegrity) return { public: {}, internal: {} };
    const payloadSnapshot = takeBoundedSnapshot(resultPayload);
    const projectionSnapshot = takeBoundedSnapshot(projection);
    if (
      !payloadSnapshot.ok
      || !projectionSnapshot.ok
      || payloadSnapshot.value == null
      || typeof payloadSnapshot.value !== "object"
      || Array.isArray(payloadSnapshot.value)
    ) {
      return { public: {}, internal: {} };
    }
    if (JSON.stringify(projectionSnapshot.value) !== expectedProjectionIntegrity) {
      return { public: {}, internal: {} };
    }
    const clean = cleanProjection(projectionSnapshot.value);
    if (!clean) return { public: {}, internal: {} };

    const payload = payloadSnapshot.value as { [key: string]: PlainSnapshot };
    const rawPublic =
      payload.public && typeof payload.public === "object" && !Array.isArray(payload.public)
        ? payload.public as { [key: string]: PlainSnapshot }
        : {};
    const publicPart = preserveAllowedPublicFields(rawPublic);
    const internalPart =
      payload.internal && typeof payload.internal === "object" && !Array.isArray(payload.internal)
        ? payload.internal as { [key: string]: PlainSnapshot }
        : {};

    const nextPublic: Record<string, unknown> = {
      ...publicPart,
      delivery: {
        requestedResolution: clean.requestedResolution,
        deliveredResolution: clean.deliveredResolution,
        taskStatus: clean.taskStatus,
        deliveryStatus: publicDeliveryStatus(clean.deliveryStatus),
        metRequestedQuality: clean.metRequestedQuality,
        failure: clean.failure,
      },
      metRequestedQuality: clean.metRequestedQuality,
    };

    // Deliberate add-then-delete boundary: legacy callers cannot retain stale
    // internal fields on the public object after the formal slice is attached.
    for (const key of Object.keys(nextPublic)) {
      if (FORBIDDEN_PUBLIC_KEY.test(key)) delete nextPublic[key];
    }

    const nextInternal: Record<string, unknown> = {
      ...internalPart,
      deliveryClassification: clean.internal,
      reconciliationHint: clean.internal.reconciliationHint,
      winningEvidenceRef: clean.internal.winningEvidenceRef,
      sourceEvidenceRef: clean.internal.sourceEvidenceRef,
      retainedSourceEvidenceRef: clean.internal.retainedSourceEvidenceRef,
    };
    const requestId =
      typeof payload.requestId === "string"
      && !containsSensitivePublicMarker(payload.requestId)
        ? asPrimitiveId(payload.requestId)
        : null;
    return {
      ...(requestId ? { requestId } : {}),
      public: nextPublic,
      internal: nextInternal,
    };
  } catch {
    return { public: {}, internal: {} };
  }
}

export function isLegacyEnhancementFailedFallback(resultPayload: unknown): boolean {
  try {
    const snapshot = takeBoundedSnapshot(resultPayload);
    if (
      !snapshot.ok
      || snapshot.value == null
      || typeof snapshot.value !== "object"
      || Array.isArray(snapshot.value)
    ) {
      return false;
    }
    const internal = snapshot.value.internal;
    return (
      internal != null
      && typeof internal === "object"
      && !Array.isArray(internal)
      && internal.finalization === "enhancement_failed_fallback"
    );
  } catch {
    return false;
  }
}
