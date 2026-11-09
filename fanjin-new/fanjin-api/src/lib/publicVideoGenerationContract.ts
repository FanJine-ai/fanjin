import { internalModelId } from "@/lib/minimaxH3PublicIdentity";
import { normalizeVideoResolution } from "@/lib/videoResolutions";
import { projectPublicLegacyTextVideoPayload } from "@/lib/publicLegacyTextVideoPayload";
import type { Knex } from "knex";
import {
  GenerationReferenceError,
  resolveCanonicalGenerationReferences,
} from "@/lib/generationReferenceResolver";
import {
  canonicalVideoGenerationRequest,
  VIDEO_GENERATION_REQUEST_VERSION,
  videoGenerationRequestDigest,
  type VideoGenerationRequest,
} from "@/lib/videoGenerationContract";
import {
  buildCanonicalVideoGenerationEnvelope,
  buildLegacyVideoProviderRequestPayload,
  videoOperationForLegacyMode,
} from "@/lib/videoGenerationSurfaceContract";
import { resolveWorkbenchModelCapability } from "@/lib/workbenchModelCatalog";
import { validateWorkbenchVideoInputs } from "@/lib/workbenchVideoCapability";
import type { TrustedVideoAssetPolicyEvidence } from "@/lib/videoAssetPolicy";
import {
  containsLegacyVideoMediaRequest,
  PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR,
} from "@/lib/publicV3LegacyMediaAdmission";
import {
  prepareSeedance25Request,
  isSeedance25ModelId,
  type PreparedSeedance25Request,
} from "@/lib/seedance25Adapter";

export type PreparedPublicCanonicalVideoGeneration = {
  model: string;
  canonicalRequest: VideoGenerationRequest;
  canonicalDigest: string;
  requestPayload: Record<string, unknown>;
  trustedVideoAssetPolicyEvidence: TrustedVideoAssetPolicyEvidence;
  relayAdapterBinding?: PreparedSeedance25Request["relayAdapterBinding"];
};

function fail(code: string, message: string): never {
  throw new GenerationReferenceError(422, code, message);
}

function supportsDuration(
  duration: { min: number; max: number; step: number; allowed?: number[]; auto?: boolean },
  requested: number,
): boolean {
  if (requested === -1) return duration.auto === true;
  if (!Number.isFinite(requested) || requested < duration.min || requested > duration.max) return false;
  if (duration.allowed?.length) return duration.allowed.includes(requested);
  const steps = (requested - duration.min) / duration.step;
  return duration.step > 0 && Math.abs(steps - Math.round(steps)) < 1e-9;
}

/**
 * Canonical branch of the documented public v3 submit endpoint.
 *
 * The old provider-shaped body remains a compatibility branch in the route.
 * New callers that send `canonicalRequest` must use controlled asset versions,
 * the same model directory, ordered resolver and surface-neutral envelope as
 * Quick, Canvas and Agent. Relay remains the single task/billing/settlement
 * implementation after this function returns.
 */
export async function preparePublicCanonicalVideoGeneration(input: {
  workspaceId: string;
  projectId: number;
  model: string;
  request: VideoGenerationRequest;
  database?: Knex | Knex.Transaction;
  actorUserId?: number;
}): Promise<PreparedPublicCanonicalVideoGeneration> {
  const request = canonicalVideoGenerationRequest(input.request);
  const capability = await resolveWorkbenchModelCapability({
    workspaceId: input.workspaceId,
    endpointType: "video_generation",
    model: input.model,
    ...(input.database ? { database: input.database } : {}),
  });
  const directory = capability?.videoGeneration;
  if (!capability?.canSubmit || !directory?.dispatchable) {
    fail(
      "video_model_unavailable",
      capability?.unavailableReason || "所选视频模型当前不可提交",
    );
  }
  const routeId = capability.routeId || capability.id;
  if (isSeedance25ModelId(capability.id) && !directory.contractFamily) {
    fail("seedance25_formal_route_required", "Seedance 2.5 精确模型缺少正式模型目录与 Adapter 合同");
  }
  if (directory.contractFamily && !isSeedance25ModelId(capability.id)) {
    fail("seedance25_model_id_mismatch", "Seedance 2.5 路由必须使用官方精确模型 ID");
  }
  // Public catalogs expose the model id, not the workspace-selected internal
  // route row. Accept that exact public identity while retaining explicit
  // route compatibility; never reinterpret a different/stale route as this model.
  if (request.modelRouteId !== routeId && internalModelId(request.modelRouteId) !== capability.id) {
    fail("video_model_route_mismatch", "统一视频请求与模型目录路由不一致");
  }
  // Bind before adapter validation and digesting so every surface, billing
  // audit and idempotent retry uses the same authoritative canonical request.
  request.modelRouteId = routeId;
  const operation = directory.operations.find((item) => (
    item.enabled && item.operation === request.operation
  ));
  if (!operation) fail("video_operation_unsupported", "所选模型未开放当前视频 operation");
  if (request.operation !== "generate" && directory.contractFamily === "seedance-2.5"
    ? request.aspectRatio !== "adaptive"
    : !capability.aspectRatios.includes(request.aspectRatio)) {
    fail("video_ratio_unsupported", request.operation !== "generate" ? "视频延长或编辑的画幅必须跟随原片，请使用 adaptive" : "所选视频画幅比例不受当前模型支持");
  }
  if (!supportsDuration(operation.duration, request.durationSeconds)) {
    fail("video_duration_unsupported", "所选视频时长不受当前 operation 支持");
  }
  if (
    !operation.nativeResolutions.includes(request.outputResolution)
    && !operation.fulfillmentResolutions.includes(request.outputResolution)
  ) {
    fail("video_resolution_unsupported", "所选视频分辨率没有原生或履约路径");
  }
  if (request.generateAudio && !directory.supportsGenerateAudio) {
    fail("video_audio_unsupported", "当前视频模型不支持生成音频");
  }
  if (request.outputFormat && !directory.outputFormats?.includes(request.outputFormat)) {
    fail("video_output_format_unsupported", "当前模型不支持此成片格式");
  }
  if (request.preserveSourceAudio && !directory.supportsPreserveSourceAudio) {
    fail("video_source_audio_unsupported", "当前视频模型不支持保留源音频");
  }
  if (request.inputs.length > directory.totalInputLimit) {
    fail("video_reference_limit_exceeded", "参考素材超过模型目录声明的总上限");
  }
  for (const mediaType of ["image", "video", "audio"] as const) {
    if (request.inputs.filter((item) => item.mediaType === mediaType).length > directory.mediaTypeLimits[mediaType]) {
      fail("video_reference_media_limit_exceeded", `${mediaType} 参考素材超过模型目录声明的上限`);
    }
  }

  const resolved = await resolveCanonicalGenerationReferences({
    workspaceId: input.workspaceId,
    projectId: String(input.projectId),
    references: request.inputs,
    ...(input.database ? { database: input.database } : {}),
    ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
  });
  if (directory.contractFamily) {
    const prepared = prepareSeedance25Request({
      capability,
      request,
      providerContent: resolved.providerContent,
      policyEvidence: resolved.trustedPolicyEvidence,
      workspaceId: input.workspaceId,
      projectId: String(input.projectId),
    });
    return {
      model: capability.id,
      canonicalRequest: request,
      canonicalDigest: videoGenerationRequestDigest(request),
      trustedVideoAssetPolicyEvidence: resolved.trustedPolicyEvidence,
      requestPayload: prepared.requestPayload,
      relayAdapterBinding: prepared.relayAdapterBinding,
    };
  }
  if (request.source || request.edit) {
    fail("video_provider_adapter_unavailable", "来源、续写或编辑字段尚未接入已验证的供应商 Adapter");
  }
  const validation = validateWorkbenchVideoInputs(capability, [{
    references: resolved.inputs,
    referenceContent: resolved.providerContent,
  }]);
  if (!validation.ok || validation.modes.length !== 1) {
    fail("video_mode_unsupported", validation.ok ? "视频生成 mode 无法唯一解析" : validation.message);
  }
  const selectedLegacyMode = validation.modes[0];
  if (videoOperationForLegacyMode(selectedLegacyMode) !== request.operation) {
    fail("video_operation_mode_mismatch", "视频 operation 与模型目录解析的 mode 不一致");
  }
  const canonical = buildCanonicalVideoGenerationEnvelope({
    operation: request.operation,
    selectedLegacyMode,
    modelRouteId: routeId,
    prompt: request.prompt,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    outputResolution: request.outputResolution,
    outputFormat: request.outputFormat,
    generateAudio: request.generateAudio,
    preserveSourceAudio: request.preserveSourceAudio,
    inputs: resolved.inputs,
    preparedReferenceContent: resolved.providerContent,
    providerAdapterSupportsTrim: false,
  });

  return {
    model: capability.id,
    canonicalRequest: canonical.request,
    canonicalDigest: canonical.digest,
    trustedVideoAssetPolicyEvidence: resolved.trustedPolicyEvidence,
    requestPayload: buildLegacyVideoProviderRequestPayload({
      model: capability.id,
      canonicalRequest: canonical.request,
      providerContent: resolved.providerContent,
    }),
  };
}

/**
 * The documented text-only compatibility path also needs a server canonical
 * checkpoint when asset-policy enforcement is enabled. It contains no asset
 * references; keep legacy provider controls and Relay's existing route/pricing
 * validation instead of adding the workbench catalog's admission requirements.
 */
export async function preparePublicLegacyTextVideoGeneration(input: {
  workspaceId: string;
  projectId: number;
  model: string;
  requestPayload: Record<string, unknown>;
}): Promise<PreparedPublicCanonicalVideoGeneration> {
  // Scan the original request before projecting fields: an unknown media
  // extension must retain the controlled-asset upgrade error.
  const originalPayload = input.requestPayload;
  // The route has already sealed the callback secret; it is a server control,
  // not a provider media locator. Scan every caller-controlled extension.
  const { callback_secret_ciphertext: _callbackSecret, ...legacyPayload } = originalPayload;
  if (containsLegacyVideoMediaRequest(legacyPayload)) {
    throw new GenerationReferenceError(409,
      PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR.code,
      PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR.message);
  }
  if (isSeedance25ModelId(input.model)) {
    throw new GenerationReferenceError(409, "seedance25_canonical_request_required",
      "Seedance 2.5 精确模型必须提交 canonicalRequest 并通过正式 Adapter 预检");
  }
  const payload = projectPublicLegacyTextVideoPayload(originalPayload);
  const content = Array.isArray(payload.content) ? payload.content : [];
  if (!content.length || content.some((item) => (
    !item || typeof item !== "object" || Array.isArray(item)
    || !["text", "input_text"].includes(String(item.type))
    || typeof item.text !== "string"
    || Object.keys(item).some((key) => !["type", "text"].includes(key))
  ))) {
    throw new GenerationReferenceError(400, "legacy_video_text_required", "旧版视频请求仅支持 text 内容");
  }
  const controls: Record<string, unknown> = {};
  const aliases: Record<string, string> = {
    duration: "duration", dur: "duration", ratio: "ratio", rt: "ratio",
    resolution: "resolution", rs: "resolution", audio: "generate_audio", generate_audio: "generate_audio",
  };
  const invalidControl = () => new GenerationReferenceError(400, "legacy_video_control_invalid",
    "视频画幅、清晰度、时长或音频参数无效或冲突");
  const bindControl = (key: string, value: unknown) => {
    if (key === "resolution") {
      if (typeof value !== "string" && typeof value !== "number") throw invalidControl();
      value = normalizeVideoResolution(value);
    }
    if ((key === "duration" && (typeof value !== "number" || !Number.isFinite(value)))
      || (key === "ratio" && (typeof value !== "string" || !value.trim()))
      || (key === "generate_audio" && typeof value !== "boolean")) throw invalidControl();
    if (controls[key] !== undefined && controls[key] !== value) throw invalidControl();
    controls[key] = value;
  };
  for (const key of ["ratio", "aspect_ratio", "duration", "resolution", "generate_audio", "audio"]) {
    if (payload[key] !== undefined) {
      const canonicalKey = key === "aspect_ratio" ? "ratio" : key === "audio" ? "generate_audio" : key;
      const value = typeof payload[key] === "string"
        ? String(payload[key]).trim().toLowerCase() : payload[key];
      bindControl(canonicalKey, value);
    }
  }
  // Ark's legacy prompt suffixes must agree with the explicit checkpoint.
  // Extract these controls rather than overriding them with new defaults.
  const prompt = content.map((item) => String(item.text)).join("\n").replace(
    /(^|\s)--(duration|dur|ratio|rt|resolution|rs|generate_audio|audio)(?:\s+|=)([^\s]+)/g,
    (_match, space: string, alias: string, raw: string) => {
      const key = aliases[alias];
      const value = key === "duration" ? Number(raw)
        : key === "generate_audio" ? raw === "true" ? true : raw === "false" ? false : raw
        : raw.trim().toLowerCase();
      bindControl(key, value);
      return space;
    },
  ).trim();
  if (!prompt) throw new GenerationReferenceError(400, "content_required", "content 至少需要一条文本内容");
  const ratio = controls.ratio ?? "16:9";
  const resolution = controls.resolution ?? "720p";
  const duration = controls.duration ?? 5;
  // Preserve the Ark-compatible endpoint's documented implicit audio default.
  const audio = controls.generate_audio ?? true;
  if (typeof ratio !== "string" || !ratio.trim()
    || typeof resolution !== "string" || !resolution.trim()
    || typeof duration !== "number" || !Number.isFinite(duration) || (duration <= 0 && duration !== -1)
    || typeof audio !== "boolean"
    || (payload.output_format !== undefined && (typeof payload.output_format !== "string"
      || !["mp4", "mov"].includes(payload.output_format)))) {
    throw invalidControl();
  }
  const request = canonicalVideoGenerationRequest({
    version: VIDEO_GENERATION_REQUEST_VERSION,
    operation: "generate",
    modelRouteId: internalModelId(input.model),
    prompt,
    aspectRatio: ratio,
    durationSeconds: duration,
    outputResolution: resolution.toLowerCase(),
    ...(payload.output_format !== undefined ? { outputFormat: payload.output_format as "mp4" | "mov" } : {}),
    generateAudio: audio,
    preserveSourceAudio: false,
    inputs: [],
  });
  const resolved = await resolveCanonicalGenerationReferences({
    workspaceId: input.workspaceId,
    projectId: String(input.projectId),
    references: [],
  });
  return {
    model: internalModelId(input.model),
    canonicalRequest: request,
    canonicalDigest: videoGenerationRequestDigest(request),
    trustedVideoAssetPolicyEvidence: resolved.trustedPolicyEvidence,
    requestPayload: {
      ...payload,
      model: internalModelId(input.model),
      content: [{ type: "text", text: request.prompt }],
      ratio: request.aspectRatio,
      duration: request.durationSeconds,
      resolution: request.outputResolution,
      generate_audio: request.generateAudio,
    },
  };
}
