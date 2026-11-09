import crypto from "node:crypto";
import { isSeedance25ModelId } from "./seedance25ModelIds";
import type { Seedance25ModelId } from "./seedance25ModelIds";

/**
 * Provider-neutral video generation contract used by Quick, Canvas and Agent.
 *
 * This module intentionally contains no provider model id, request field name,
 * price or limit. Those values may only enter through a verified capability
 * document derived from the provider's formal contract. A disabled document is
 * useful before that contract exists; it cannot be promoted into a dispatchable
 * capability by adding only a feature flag.
 */
export const VIDEO_GENERATION_CAPABILITY_VERSION =
  "provider-neutral-video-capability/v1" as const;
export const VIDEO_GENERATION_REQUEST_VERSION =
  "provider-neutral-video-request/v1" as const;
export const VIDEO_GENERATION_POLICY_VERSION =
  "provider-neutral-video-policy/v1" as const;
export const SEEDANCE_25_CONTRACT_FAMILY = "seedance-2.5" as const;

export const VIDEO_OPERATIONS = ["generate", "extend", "edit"] as const;
export const VIDEO_REFERENCE_MEDIA_TYPES = ["image", "video", "audio"] as const;
export const VIDEO_REFERENCE_ROLES = [
  "subject",
  "style",
  "storyboard",
  "first_frame",
  "last_frame",
  "source_video",
] as const;

export type VideoOperation = (typeof VIDEO_OPERATIONS)[number];
export type VideoReferenceMediaType = (typeof VIDEO_REFERENCE_MEDIA_TYPES)[number];
export type VideoReferenceRole = (typeof VIDEO_REFERENCE_ROLES)[number];
export type VideoCapabilityState = "disabled" | "configured" | "verified";

export type VideoInputSlot = {
  id: string;
  label: string;
  mediaType: VideoReferenceMediaType;
  roles: VideoReferenceRole[];
  operations: VideoOperation[];
  min: number;
  max: number;
  allowDuplicateAsset: boolean;
  supportsTrim: boolean;
};

export type VideoOperationCapability = {
  operation: VideoOperation;
  enabled: boolean;
  durationSeconds: {
    min: number;
    max: number;
    step: number;
    allowed?: number[];
    auto?: boolean;
  };
  nativeResolutions: string[];
  fulfillmentResolutions: string[];
};

export type ProviderNeutralVideoCapability = {
  version: typeof VIDEO_GENERATION_CAPABILITY_VERSION;
  contractFamily: string;
  state: VideoCapabilityState;
  unavailableReason: string | null;
  providerContractVersion: string | null;
  providerSchemaSha256: string | null;
  adapterMappingVersion: string | null;
  pricingRevision: string | null;
  compliancePolicyVersion: string | null;
  featureFlagEnabled: boolean;
  operations: VideoOperationCapability[];
  inputSlots: VideoInputSlot[];
  totalInputLimit: number;
  mediaTypeLimits: Record<VideoReferenceMediaType, number>;
  supportsGenerateAudio: boolean;
  supportsPreserveSourceAudio: boolean;
  supportsMask: boolean;
  supportsTimeRange: boolean;
  supportsSourceTaskContinuation: boolean;
};

export type VideoGenerationInput = {
  assetVersionId: string;
  mediaType: VideoReferenceMediaType;
  role: VideoReferenceRole;
  order: number;
  trim?: { startMs: number; endMs: number };
};

export type VideoGenerationRequest = {
  version: typeof VIDEO_GENERATION_REQUEST_VERSION;
  operation: VideoOperation;
  modelRouteId: string;
  renderMode?: "draft" | "finalize";
  /** Server-resolved parent; never copied from a client payload. */
  draftSource?: { taskId: string; providerTaskId: string; channelId: string; expiresAt: number; parentDigest: string; model?: Seedance25ModelId; outputDurationSeconds?: number };
  prompt: string;
  aspectRatio: string;
  durationSeconds: number;
  outputResolution: string;
  outputFormat?: "mp4" | "mov";
  generateAudio: boolean;
  preserveSourceAudio: boolean;
  inputs: VideoGenerationInput[];
  source?: {
    assetVersionId?: string;
    taskId?: string;
  };
  edit?: {
    startMs?: number;
    endMs?: number;
    maskAssetVersionId?: string;
    instruction: string;
    preserve: string[];
  };
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Produces the one surface-independent request representation used for quote,
 * approval and dispatch binding.  Provider field names deliberately do not
 * appear here; an adapter may consume this value only after capability
 * preflight succeeds.
 */
export function canonicalVideoGenerationRequest(
  request: VideoGenerationRequest,
): VideoGenerationRequest {
  const orderedInputs = [...request.inputs]
    .sort((left, right) => left.order - right.order)
    .map((item) => ({
      assetVersionId: token(item.assetVersionId),
      mediaType: item.mediaType,
      role: item.role,
      order: item.order,
      ...(item.trim
        ? { trim: { startMs: item.trim.startMs, endMs: item.trim.endMs } }
        : {}),
    }));
  const source = request.source
    ? {
        ...(token(request.source.assetVersionId)
          ? { assetVersionId: token(request.source.assetVersionId) }
          : {}),
        ...(token(request.source.taskId) ? { taskId: token(request.source.taskId) } : {}),
      }
    : undefined;
  const edit = request.edit
    ? {
        ...(request.edit.startMs !== undefined ? { startMs: request.edit.startMs } : {}),
        ...(request.edit.endMs !== undefined ? { endMs: request.edit.endMs } : {}),
        ...(token(request.edit.maskAssetVersionId)
          ? { maskAssetVersionId: token(request.edit.maskAssetVersionId) }
          : {}),
        instruction: token(request.edit.instruction),
        preserve: [...request.edit.preserve].map(token),
      }
    : undefined;
  return {
    version: VIDEO_GENERATION_REQUEST_VERSION,
    operation: request.operation,
    modelRouteId: token(request.modelRouteId),
    ...(request.renderMode ? { renderMode: request.renderMode } : {}),
    ...(request.draftSource ? { draftSource: { ...request.draftSource } } : {}),
    prompt: token(request.prompt),
    aspectRatio: token(request.aspectRatio),
    durationSeconds: request.durationSeconds,
    outputResolution: token(request.outputResolution),
    ...(request.outputFormat ? { outputFormat: request.outputFormat } : {}),
    generateAudio: request.generateAudio,
    preserveSourceAudio: request.preserveSourceAudio,
    inputs: orderedInputs,
    ...(source ? { source } : {}),
    ...(edit ? { edit } : {}),
  };
}

export function videoGenerationRequestDigest(request: VideoGenerationRequest): string {
  return crypto
    .createHash("sha256")
    .update(stableJson(canonicalVideoGenerationRequest(request)))
    .digest("hex");
}

export type VideoInputPolicyDecision = {
  version: typeof VIDEO_GENERATION_POLICY_VERSION;
  assetVersionId: string;
  workspaceId: string;
  projectId: string;
  allowed: boolean;
  authorizationEvidenceId: string | null;
  moderationEvidenceId: string | null;
  policyVersion: string;
  consentExpiresAt?: string | null;
  reason?: string;
};

export type VideoGenerationPreflightSuccess = {
  ok: true;
  orderedInputs: VideoGenerationInput[];
  slotAssignments: Array<{ assetVersionId: string; slotId: string }>;
  fulfillment: "native" | "quality_enhancement";
  policyEvidence: Array<{
    assetVersionId: string;
    authorizationEvidenceId: string;
    moderationEvidenceId: string;
    policyVersion: string;
  }>;
};

export type VideoGenerationPreflightFailure = {
  ok: false;
  code: string;
  message: string;
};

export type VideoGenerationPreflightResult =
  | VideoGenerationPreflightSuccess
  | VideoGenerationPreflightFailure;

const OPERATIONS = new Set<string>(VIDEO_OPERATIONS);
const MEDIA_TYPES = new Set<string>(VIDEO_REFERENCE_MEDIA_TYPES);
const ROLES = new Set<string>(VIDEO_REFERENCE_ROLES);
const SHA256 = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function token(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function safeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function strictStringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items = value.map(token);
  if (items.some((item) => !item) || new Set(items).size !== items.length) return null;
  return items;
}

function enumList<T extends string>(value: unknown, allowed: Set<string>): T[] | null {
  const items = strictStringList(value);
  return items && items.every((item) => allowed.has(item)) ? items as T[] : null;
}

function parseDuration(value: unknown): VideoOperationCapability["durationSeconds"] | null {
  if (!isRecord(value)) return null;
  const allowedKeys = ["min", "max", "step", "allowed", "auto"];
  if (value.auto !== undefined && typeof value.auto !== "boolean") return null;
  const auto = value.auto === undefined ? {} : { auto: value.auto };
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return null;
  const min = finitePositive(value.min);
  const max = finitePositive(value.max);
  const step = finitePositive(value.step);
  if (min === null || max === null || step === null || max < min) return null;
  if (value.allowed === undefined) return { min, max, step, ...auto };
  if (!Array.isArray(value.allowed) || value.allowed.length === 0) return null;
  const allowed = value.allowed.map(Number);
  if (
    allowed.some((item) => !Number.isFinite(item) || item < min || item > max)
    || new Set(allowed).size !== allowed.length
    || allowed.some((item, index) => index > 0 && item <= allowed[index - 1])
  ) return null;
  return { min, max, step, allowed, ...auto };
}

function parseOperationCapability(value: unknown): VideoOperationCapability | null {
  if (!isRecord(value) || !exactKeys(value, [
    "operation",
    "enabled",
    "durationSeconds",
    "nativeResolutions",
    "fulfillmentResolutions",
  ])) return null;
  const operation = token(value.operation);
  const durationSeconds = parseDuration(value.durationSeconds);
  const nativeResolutions = strictStringList(value.nativeResolutions);
  const fulfillmentResolutions = Array.isArray(value.fulfillmentResolutions)
    && value.fulfillmentResolutions.length === 0
    ? []
    : strictStringList(value.fulfillmentResolutions);
  if (
    !OPERATIONS.has(operation)
    || typeof value.enabled !== "boolean"
    || !durationSeconds
    || !nativeResolutions
    || !fulfillmentResolutions
    || fulfillmentResolutions.some((resolution) => nativeResolutions.includes(resolution))
  ) return null;
  return {
    operation: operation as VideoOperation,
    enabled: value.enabled,
    durationSeconds,
    nativeResolutions,
    fulfillmentResolutions,
  };
}

function parseInputSlot(value: unknown): VideoInputSlot | null {
  if (!isRecord(value) || !exactKeys(value, [
    "id",
    "label",
    "mediaType",
    "roles",
    "operations",
    "min",
    "max",
    "allowDuplicateAsset",
    "supportsTrim",
  ])) return null;
  const id = token(value.id);
  const label = token(value.label);
  const mediaType = token(value.mediaType);
  const roles = enumList<VideoReferenceRole>(value.roles, ROLES);
  const operations = enumList<VideoOperation>(value.operations, OPERATIONS);
  const min = safeInteger(value.min);
  const max = safeInteger(value.max);
  if (
    !id
    || !label
    || !MEDIA_TYPES.has(mediaType)
    || !roles
    || !operations
    || min === null
    || max === null
    || min < 0
    || max < 1
    || max < min
    || typeof value.allowDuplicateAsset !== "boolean"
    || typeof value.supportsTrim !== "boolean"
    || (value.supportsTrim && mediaType !== "audio" && mediaType !== "video")
  ) return null;
  return {
    id,
    label,
    mediaType: mediaType as VideoReferenceMediaType,
    roles,
    operations,
    min,
    max,
    allowDuplicateAsset: value.allowDuplicateAsset,
    supportsTrim: value.supportsTrim,
  };
}

function parseMediaTypeLimits(value: unknown): Record<VideoReferenceMediaType, number> | null {
  if (!isRecord(value) || !exactKeys(value, VIDEO_REFERENCE_MEDIA_TYPES)) return null;
  const entries = VIDEO_REFERENCE_MEDIA_TYPES.map((mediaType) => {
    const limit = safeInteger(value[mediaType]);
    return limit !== null && limit >= 0 ? [mediaType, limit] as const : null;
  });
  if (entries.some((entry) => !entry)) return null;
  return Object.fromEntries(
    entries as Array<readonly [VideoReferenceMediaType, number]>,
  ) as Record<VideoReferenceMediaType, number>;
}

export type VideoCapabilityCompilation =
  | { ok: true; capability: ProviderNeutralVideoCapability }
  | { ok: false; code: string; message: string };

export function compileProviderNeutralVideoCapability(value: unknown): VideoCapabilityCompilation {
  if (!isRecord(value) || !exactKeys(value, [
    "version",
    "contractFamily",
    "state",
    "unavailableReason",
    "providerContractVersion",
    "providerSchemaSha256",
    "adapterMappingVersion",
    "pricingRevision",
    "compliancePolicyVersion",
    "featureFlagEnabled",
    "operations",
    "inputSlots",
    "totalInputLimit",
    "mediaTypeLimits",
    "supportsGenerateAudio",
    "supportsPreserveSourceAudio",
    "supportsMask",
    "supportsTimeRange",
    "supportsSourceTaskContinuation",
  ])) {
    return { ok: false, code: "video_capability_schema_invalid", message: "视频能力合同字段不完整或包含未知字段" };
  }
  if (value.version !== VIDEO_GENERATION_CAPABILITY_VERSION) {
    return { ok: false, code: "video_capability_version_unsupported", message: "视频能力合同版本不受支持" };
  }
  const contractFamily = token(value.contractFamily);
  const state = token(value.state);
  const unavailableReason = value.unavailableReason === null ? null : token(value.unavailableReason);
  const providerContractVersion = value.providerContractVersion === null ? null : token(value.providerContractVersion);
  const providerSchemaSha256 = value.providerSchemaSha256 === null ? null : token(value.providerSchemaSha256).toLowerCase();
  const adapterMappingVersion = value.adapterMappingVersion === null ? null : token(value.adapterMappingVersion);
  const pricingRevision = value.pricingRevision === null ? null : token(value.pricingRevision);
  const compliancePolicyVersion = value.compliancePolicyVersion === null ? null : token(value.compliancePolicyVersion);
  const totalInputLimit = safeInteger(value.totalInputLimit);
  const mediaTypeLimits = parseMediaTypeLimits(value.mediaTypeLimits);
  const booleans = [
    value.featureFlagEnabled,
    value.supportsGenerateAudio,
    value.supportsPreserveSourceAudio,
    value.supportsMask,
    value.supportsTimeRange,
    value.supportsSourceTaskContinuation,
  ];
  if (
    !contractFamily
    || !["disabled", "configured", "verified"].includes(state)
    || (value.unavailableReason !== null && !unavailableReason)
    || (value.providerContractVersion !== null && !providerContractVersion)
    || (value.providerSchemaSha256 !== null && (!providerSchemaSha256 || !SHA256.test(providerSchemaSha256)))
    || (value.adapterMappingVersion !== null && !adapterMappingVersion)
    || (value.pricingRevision !== null && !pricingRevision)
    || (value.compliancePolicyVersion !== null && !compliancePolicyVersion)
    || totalInputLimit === null
    || totalInputLimit < 0
    || !mediaTypeLimits
    || booleans.some((item) => typeof item !== "boolean")
  ) {
    return { ok: false, code: "video_capability_value_invalid", message: "视频能力合同包含无效值" };
  }
  if (!Array.isArray(value.operations) || !Array.isArray(value.inputSlots)) {
    return { ok: false, code: "video_capability_matrix_invalid", message: "视频能力 operation 或输入槽矩阵无效" };
  }
  const operations = value.operations.map(parseOperationCapability);
  const inputSlots = value.inputSlots.map(parseInputSlot);
  if (operations.some((item) => !item) || inputSlots.some((item) => !item)) {
    return { ok: false, code: "video_capability_matrix_invalid", message: "视频能力 operation 或输入槽矩阵无效" };
  }
  const compiledOperations = operations as VideoOperationCapability[];
  const compiledSlots = inputSlots as VideoInputSlot[];
  if (
    new Set(compiledOperations.map((item) => item.operation)).size !== compiledOperations.length
    || new Set(compiledSlots.map((item) => item.id)).size !== compiledSlots.length
    || compiledSlots.some((slot) => slot.operations.some((operation) => (
      !compiledOperations.some((item) => item.operation === operation && item.enabled)
    )))
    || VIDEO_REFERENCE_MEDIA_TYPES.some((mediaType) => (
      compiledSlots
        .filter((slot) => slot.mediaType === mediaType)
        .reduce((sum, slot) => sum + slot.max, 0) < mediaTypeLimits[mediaType]
    ))
    || compiledSlots.reduce((sum, slot) => sum + slot.max, 0) < totalInputLimit
  ) {
    return { ok: false, code: "video_capability_matrix_inconsistent", message: "视频能力 operation、输入槽和数量上限不一致" };
  }

  const verified = state === "verified";
  if (verified && (
    !providerContractVersion
    || !providerSchemaSha256
    || !adapterMappingVersion
    || !pricingRevision
    || !compliancePolicyVersion
    || compiledOperations.length === 0
    || !compiledOperations.some((item) => item.enabled)
  )) {
    return { ok: false, code: "video_provider_contract_incomplete", message: "已验证视频能力缺少正式合同、Adapter、价格或合规版本" };
  }
  if (state !== "verified" && value.featureFlagEnabled === true) {
    return { ok: false, code: "video_feature_flag_requires_verified_contract", message: "视频能力未完成正式合同验证，不能启用功能开关" };
  }
  if (state === "disabled" && !unavailableReason) {
    return { ok: false, code: "video_disabled_reason_required", message: "关闭的视频能力必须提供不可用原因" };
  }

  return {
    ok: true,
    capability: {
      version: VIDEO_GENERATION_CAPABILITY_VERSION,
      contractFamily,
      state: state as VideoCapabilityState,
      unavailableReason,
      providerContractVersion,
      providerSchemaSha256,
      adapterMappingVersion,
      pricingRevision,
      compliancePolicyVersion,
      featureFlagEnabled: value.featureFlagEnabled as boolean,
      operations: compiledOperations,
      inputSlots: compiledSlots,
      totalInputLimit,
      mediaTypeLimits,
      supportsGenerateAudio: value.supportsGenerateAudio as boolean,
      supportsPreserveSourceAudio: value.supportsPreserveSourceAudio as boolean,
      supportsMask: value.supportsMask as boolean,
      supportsTimeRange: value.supportsTimeRange as boolean,
      supportsSourceTaskContinuation: value.supportsSourceTaskContinuation as boolean,
    },
  };
}

export function disabledSeedance25Foundation(reason = "等待正式供应商 API 合同、Adapter 映射、价格和合规确认"):
ProviderNeutralVideoCapability {
  return {
    version: VIDEO_GENERATION_CAPABILITY_VERSION,
    contractFamily: SEEDANCE_25_CONTRACT_FAMILY,
    state: "disabled",
    unavailableReason: reason,
    providerContractVersion: null,
    providerSchemaSha256: null,
    adapterMappingVersion: null,
    pricingRevision: null,
    compliancePolicyVersion: null,
    featureFlagEnabled: false,
    operations: [],
    inputSlots: [],
    totalInputLimit: 0,
    mediaTypeLimits: { image: 0, video: 0, audio: 0 },
    supportsGenerateAudio: false,
    supportsPreserveSourceAudio: false,
    supportsMask: false,
    supportsTimeRange: false,
    supportsSourceTaskContinuation: false,
  };
}

function failure(code: string, message: string): VideoGenerationPreflightFailure {
  return { ok: false, code, message };
}

function supportsDuration(
  capability: VideoOperationCapability["durationSeconds"],
  durationSeconds: number,
): boolean {
  if (durationSeconds === -1) return capability.auto === true;
  if (!Number.isFinite(durationSeconds) || durationSeconds < capability.min || durationSeconds > capability.max) {
    return false;
  }
  if (capability.allowed) return capability.allowed.includes(durationSeconds);
  const steps = (durationSeconds - capability.min) / capability.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function sourceIdentity(source: VideoGenerationRequest["source"]): string | null {
  if (!source) return null;
  const assetVersionId = token(source.assetVersionId);
  const taskId = token(source.taskId);
  if (Boolean(assetVersionId) === Boolean(taskId)) return null;
  return assetVersionId || taskId;
}

function validateOperationFields(
  capability: ProviderNeutralVideoCapability,
  request: VideoGenerationRequest,
): VideoGenerationPreflightFailure | null {
  const source = sourceIdentity(request.source);
  if (request.operation === "generate") {
    if (request.source || request.edit) return failure("video_generate_fields_invalid", "普通生成不能携带来源或编辑字段");
    return null;
  }
  if (!source) return failure("video_source_required", "延长或编辑操作必须且只能指定一个受控来源");
  if (request.source?.taskId && !capability.supportsSourceTaskContinuation) {
    return failure("video_source_task_unsupported", "当前能力不支持从来源任务继续生成");
  }
  if (request.operation === "extend") {
    if (request.edit) return failure("video_extend_fields_invalid", "视频延长不能携带编辑字段");
    return null;
  }
  if (!request.edit || !token(request.edit.instruction)) {
    return failure("video_edit_fields_required", "视频编辑必须提供编辑指令");
  }
  const hasTimeRange = request.edit.startMs !== undefined || request.edit.endMs !== undefined;
  if (hasTimeRange) {
    if (!capability.supportsTimeRange) return failure("video_time_range_unsupported", "当前能力不支持时间范围编辑");
    if (
      !Number.isSafeInteger(request.edit.startMs)
      || !Number.isSafeInteger(request.edit.endMs)
      || Number(request.edit.startMs) < 0
      || Number(request.edit.endMs) <= Number(request.edit.startMs)
    ) return failure("video_time_range_invalid", "视频编辑时间范围无效");
  }
  if (request.edit.maskAssetVersionId && !capability.supportsMask) {
    return failure("video_mask_unsupported", "当前能力不支持 Mask 编辑");
  }
  return null;
}

function assignInputsToSlots(
  capability: ProviderNeutralVideoCapability,
  operation: VideoOperation,
  inputs: VideoGenerationInput[],
): { assignments: Array<{ assetVersionId: string; slotId: string }> } | VideoGenerationPreflightFailure {
  const active = capability.inputSlots.filter((slot) => slot.operations.includes(operation));
  const counts = new Map(active.map((slot) => [slot.id, 0]));
  const assignments: Array<{ assetVersionId: string; slotId: string }> = [];
  const seenBySlot = new Map(active.map((slot) => [slot.id, new Set<string>()]));
  for (const input of inputs) {
    const candidates = active
      .filter((slot) => slot.mediaType === input.mediaType && slot.roles.includes(input.role))
      .sort((left, right) => {
        const leftNeedsMin = Number(counts.get(left.id) || 0) < left.min ? 0 : 1;
        const rightNeedsMin = Number(counts.get(right.id) || 0) < right.min ? 0 : 1;
        return leftNeedsMin - rightNeedsMin
          || left.roles.length - right.roles.length
          || left.max - right.max
          || left.id.localeCompare(right.id);
      });
    const target = candidates.find((slot) => (
      Number(counts.get(slot.id) || 0) < slot.max
      && (slot.allowDuplicateAsset || !seenBySlot.get(slot.id)?.has(input.assetVersionId))
    ));
    if (!target) {
      return failure("video_input_slot_rejected", `参考素材 ${input.assetVersionId} 的类型或角色不受当前 operation 支持`);
    }
    if (input.trim && !target.supportsTrim) {
      return failure("video_input_trim_unsupported", `输入槽 ${target.label} 不支持裁剪`);
    }
    counts.set(target.id, Number(counts.get(target.id) || 0) + 1);
    seenBySlot.get(target.id)?.add(input.assetVersionId);
    assignments.push({ assetVersionId: input.assetVersionId, slotId: target.id });
  }
  const missing = active.find((slot) => Number(counts.get(slot.id) || 0) < slot.min);
  if (missing) return failure("video_input_slot_required", `${missing.label} 至少需要 ${missing.min} 个素材`);
  return { assignments };
}

function validatePolicyDecisions(input: {
  request: VideoGenerationRequest;
  decisions: VideoInputPolicyDecision[];
  workspaceId: string;
  projectId: string;
  now: Date;
}): VideoGenerationPreflightFailure | VideoGenerationPreflightSuccess["policyEvidence"] {
  const decisions = new Map(input.decisions.map((decision) => [decision.assetVersionId, decision]));
  const uniqueAssets = Array.from(new Set(input.request.inputs.map((item) => item.assetVersionId)));
  if (decisions.size !== input.decisions.length || decisions.size !== uniqueAssets.length) {
    return failure("video_policy_evidence_mismatch", "素材授权/审核决策与请求不一致");
  }
  const evidence: VideoGenerationPreflightSuccess["policyEvidence"] = [];
  for (const assetVersionId of uniqueAssets) {
    const decision = decisions.get(assetVersionId);
    if (
      !decision
      || decision.version !== VIDEO_GENERATION_POLICY_VERSION
      || decision.workspaceId !== input.workspaceId
      || decision.projectId !== input.projectId
      || !decision.allowed
      || !token(decision.authorizationEvidenceId)
      || !token(decision.moderationEvidenceId)
      || !token(decision.policyVersion)
    ) {
      return failure("video_asset_policy_denied", decision?.reason || `素材 ${assetVersionId} 未通过授权与审核`);
    }
    if (decision.consentExpiresAt) {
      const expiresAt = Date.parse(decision.consentExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) {
        return failure("video_asset_consent_expired", `素材 ${assetVersionId} 的授权已失效`);
      }
    }
    evidence.push({
      assetVersionId,
      authorizationEvidenceId: decision.authorizationEvidenceId!,
      moderationEvidenceId: decision.moderationEvidenceId!,
      policyVersion: decision.policyVersion,
    });
  }
  return evidence;
}

export function preflightVideoGeneration(input: {
  capability: ProviderNeutralVideoCapability;
  request: VideoGenerationRequest;
  policyDecisions: VideoInputPolicyDecision[];
  workspaceId: string;
  projectId: string;
  now?: Date;
}): VideoGenerationPreflightResult {
  const { capability, request } = input;
  if (capability.state !== "verified" || !capability.featureFlagEnabled) {
    return failure("video_capability_not_enabled", capability.unavailableReason || "视频能力未完成正式合同验证或未启用");
  }
  if (
    !capability.providerContractVersion
    || !capability.providerSchemaSha256
    || !capability.adapterMappingVersion
    || !capability.pricingRevision
    || !capability.compliancePolicyVersion
  ) return failure("video_provider_contract_incomplete", "视频能力缺少正式合同、Adapter、价格或合规版本");
  if (request.version !== VIDEO_GENERATION_REQUEST_VERSION) {
    return failure("video_request_version_unsupported", "视频生成请求版本不受支持");
  }
  if (
    !VIDEO_OPERATIONS.includes(request.operation)
    || !token(request.modelRouteId)
    || (!token(request.prompt) && !(capability.contractFamily === SEEDANCE_25_CONTRACT_FAMILY && request.inputs.length > 0))
    || !token(request.aspectRatio)
  ) {
    return failure("video_request_invalid", "视频生成请求缺少 operation、模型路由或提示词");
  }
  const operation = capability.operations.find((item) => item.operation === request.operation);
  if (!operation?.enabled) return failure("video_operation_disabled", "当前视频 operation 未开放");
  if (!supportsDuration(operation.durationSeconds, request.durationSeconds)) {
    return failure("video_duration_unsupported", "当前视频时长不受所选 operation 支持");
  }
  const fulfillment = operation.nativeResolutions.includes(request.outputResolution)
    ? "native"
    : operation.fulfillmentResolutions.includes(request.outputResolution)
      ? "quality_enhancement"
      : null;
  if (!fulfillment) return failure("video_resolution_unsupported", "当前输出分辨率不受所选 operation 支持");
  if (request.generateAudio && !capability.supportsGenerateAudio) {
    return failure("video_generate_audio_unsupported", "当前能力不支持生成音频");
  }
  if (request.preserveSourceAudio && !capability.supportsPreserveSourceAudio) {
    return failure("video_preserve_audio_unsupported", "当前能力不支持保留来源音频");
  }
  const operationFailure = validateOperationFields(capability, request);
  if (operationFailure) return operationFailure;
  if (!Array.isArray(request.inputs) || request.inputs.length > capability.totalInputLimit) {
    return failure("video_input_total_limit", "参考素材总数超过能力上限");
  }
  const orderedInputs = [...request.inputs].sort((left, right) => left.order - right.order);
  if (orderedInputs.some((item, index) => (
    !token(item.assetVersionId)
    || !MEDIA_TYPES.has(item.mediaType)
    || !ROLES.has(item.role)
    || !Number.isSafeInteger(item.order)
    || item.order !== index
    || (item.trim !== undefined && (
      !Number.isSafeInteger(item.trim.startMs)
      || !Number.isSafeInteger(item.trim.endMs)
      || item.trim.startMs < 0
      || item.trim.endMs <= item.trim.startMs
    ))
  ))) return failure("video_input_order_or_shape_invalid", "参考素材必须使用连续唯一顺序并提供有效类型、角色和裁剪范围");
  for (const mediaType of VIDEO_REFERENCE_MEDIA_TYPES) {
    if (orderedInputs.filter((item) => item.mediaType === mediaType).length > capability.mediaTypeLimits[mediaType]) {
      return failure("video_input_type_limit", `${mediaType} 参考素材超过能力上限`);
    }
  }
  const assigned = assignInputsToSlots(capability, request.operation, orderedInputs);
  if (!("assignments" in assigned)) return assigned;
  const policyEvidence = validatePolicyDecisions({
    request,
    decisions: input.policyDecisions,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    now: input.now ?? new Date(),
  });
  if (!Array.isArray(policyEvidence)) return policyEvidence;
  return {
    ok: true,
    orderedInputs,
    slotAssignments: assigned.assignments,
    fulfillment,
    policyEvidence,
  };
}

export type Seedance25RouteGate = {
  recognized: boolean;
  dispatchable: boolean;
  reason?: string;
  capability?: ProviderNeutralVideoCapability;
  capabilityDigest?: string;
  accountModelCatalogEvidenceSha256?: string;
};

/**
 * Reads only the provider-neutral routeConfig.videoGenerationContract block.
 * The presence of either formal marker opts the route out of legacy fallback.
 * A missing, unsupported or mismatched family is always a hard deny.
 * Provider-specific request mapping remains SD25-003.
 */
export function evaluateSeedance25RouteGate(routeConfig: unknown, expectedModelId?: string): Seedance25RouteGate {
  if (!isRecord(routeConfig)) return { recognized: false, dispatchable: true };
  const hasFamilyMarker = Object.prototype.hasOwnProperty.call(routeConfig, "contractFamily");
  const hasContractMarker = Object.prototype.hasOwnProperty.call(routeConfig, "videoGenerationContract");
  if (!hasFamilyMarker && !hasContractMarker) {
    return { recognized: false, dispatchable: true };
  }
  const family = token(routeConfig.contractFamily);
  const raw = routeConfig.videoGenerationContract;
  const rawFamily = isRecord(raw) ? token(raw.contractFamily) : "";
  if ((hasFamilyMarker && !family) || (hasContractMarker && !rawFamily)) {
    return {
      recognized: true,
      dispatchable: false,
      reason: "视频能力合同缺少 contractFamily",
    };
  }
  const declaredFamilies = [family, rawFamily].filter(Boolean);
  if (new Set(declaredFamilies).size !== 1) {
    return {
      recognized: true,
      dispatchable: false,
      reason: "路由与视频能力合同的 contractFamily 不一致",
    };
  }
  if (declaredFamilies[0] !== SEEDANCE_25_CONTRACT_FAMILY) {
    return {
      recognized: true,
      dispatchable: false,
      reason: "视频能力合同 family 不受支持",
    };
  }
  const compiled = compileProviderNeutralVideoCapability(raw);
  if (!compiled.ok) {
    return { recognized: true, dispatchable: false, reason: compiled.message };
  }
  const accountEvidence = isRecord(routeConfig.accountModelCatalogEvidence)
    ? routeConfig.accountModelCatalogEvidence
    : null;
  const accountEvidenceSha256 = accountEvidence
    ? token(accountEvidence.sha256).toLowerCase()
    : "";
  const accountEvidenceVerifiedAt = accountEvidence
    ? token(accountEvidence.verifiedAt)
    : "";
  const accountEvidenceValid = Boolean(
    accountEvidence
    && exactKeys(accountEvidence, [
      "version",
      "model",
      "sha256",
      "providerAccountFingerprint",
      "verifiedAt",
    ])
    && accountEvidence.version === "seedance-2.5-account-model-catalog-evidence/v1"
    && isSeedance25ModelId(token(accountEvidence.model))
    && (!expectedModelId || token(accountEvidence.model) === expectedModelId)
    && SHA256.test(accountEvidenceSha256)
    && SHA256.test(token(accountEvidence.providerAccountFingerprint).toLowerCase())
    && Number.isFinite(Date.parse(accountEvidenceVerifiedAt))
    && Date.parse(accountEvidenceVerifiedAt) <= Date.now(),
  );
  if (compiled.capability.featureFlagEnabled && !accountEvidenceValid) {
    return {
      recognized: true,
      dispatchable: false,
      reason: "Seedance 2.5 缺少可校验的账号模型目录证据",
      capability: compiled.capability,
    };
  }
  const dispatchable = compiled.capability.state === "verified"
    && compiled.capability.featureFlagEnabled;
  return {
    recognized: true,
    dispatchable,
    ...(!dispatchable ? { reason: compiled.capability.unavailableReason || "Seedance 2.5 能力尚未通过正式合同门禁" } : {}),
    capability: compiled.capability,
    ...(accountEvidenceValid
      ? { accountModelCatalogEvidenceSha256: accountEvidenceSha256 }
      : {}),
    capabilityDigest: crypto
      .createHash("sha256")
      .update(JSON.stringify({
        capability: compiled.capability,
        accountModelCatalogEvidence: accountEvidenceValid ? accountEvidence : null,
      }))
      .digest("hex"),
  };
}
