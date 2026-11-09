import {
  canonicalVideoGenerationRequest,
  videoGenerationRequestDigest,
  VIDEO_GENERATION_REQUEST_VERSION,
  type VideoGenerationInput,
  type VideoGenerationRequest,
  type VideoOperation,
} from "@/lib/videoGenerationContract";
import { hasPreparedReferenceTrim } from "./referenceMediaTrimProof";

const LEGACY_MODE_OPERATIONS: Readonly<Record<string, VideoOperation>> = {
  text_to_video: "generate",
  image_to_video: "generate",
  first_last_frame: "generate",
  omni_reference: "generate",
  image_reference: "generate",
  reference_to_video: "generate",
  // The provider-shaped legacy relay has no verified source continuation or
  // edit mapping. Preserve those historical mode labels as reference-based
  // generate requests; only a formal contract may expose extend/edit.
  video_extension: "generate",
  video_edit: "generate",
  standard: "generate",
};

export class VideoGenerationSurfaceContractError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "VideoGenerationSurfaceContractError";
    this.status = status;
    this.code = code;
  }
}

export function videoOperationForLegacyMode(mode: unknown): VideoOperation | null {
  const normalized = typeof mode === "string"
    ? mode.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
  return LEGACY_MODE_OPERATIONS[normalized] ?? null;
}

export type CanonicalVideoGenerationEnvelope = {
  request: VideoGenerationRequest;
  digest: string;
};

/** One provider-shaped legacy projection shared by every canonical surface. */
export function buildLegacyVideoProviderRequestPayload(input: {
  model: string;
  canonicalRequest: VideoGenerationRequest;
  providerContent: Record<string, unknown>[];
}): Record<string, unknown> {
  const request = canonicalVideoGenerationRequest(input.canonicalRequest);
  return {
    model: input.model.trim(),
    content: [{ type: "text", text: request.prompt }, ...input.providerContent],
    generate_audio: request.generateAudio,
    ratio: request.aspectRatio,
    duration: request.durationSeconds,
    resolution: request.outputResolution,
    watermark: false,
  };
}

/**
 * Final surface-neutral assembly point. Quick, Canvas and Agent must call this
 * after resolving controlled assets and capability-selected legacy modes.
 */
export function buildCanonicalVideoGenerationEnvelope(input: {
  operation?: VideoOperation | null;
  selectedLegacyMode?: string | null;
  modelRouteId: string;
  renderMode?: "draft";
  prompt: string;
  aspectRatio: string;
  durationSeconds: number;
  outputResolution: string;
  outputFormat?: "mp4" | "mov";
  generateAudio: boolean;
  preserveSourceAudio?: boolean;
  inputs: VideoGenerationInput[];
  source?: VideoGenerationRequest["source"];
  edit?: VideoGenerationRequest["edit"];
  /** Remains false on the provider-shaped legacy resolver. */
  providerAdapterSupportsTrim?: boolean;
  preparedReferenceContent?: readonly Record<string, unknown>[];
}): CanonicalVideoGenerationEnvelope {
  const legacyOperation = videoOperationForLegacyMode(input.selectedLegacyMode);
  const operation = input.operation ?? legacyOperation;
  if (!operation) {
    throw new VideoGenerationSurfaceContractError(
      "video_operation_missing",
      "模型目录未声明可执行的视频 operation",
    );
  }
  if (input.operation && legacyOperation && input.operation !== legacyOperation) {
    throw new VideoGenerationSurfaceContractError(
      "video_operation_mode_mismatch",
      "视频 operation 与模型目录选择的 mode 不一致",
    );
  }
  if (input.providerAdapterSupportsTrim !== true && input.inputs.some((item, index) => (
    item.trim && !hasPreparedReferenceTrim(item, input.preparedReferenceContent?.[index])
  ))) {
    throw new VideoGenerationSurfaceContractError(
      "video_trim_adapter_unverified",
      "参考素材时间段尚未处理完成，请重新提交；若仍失败，请重新选择该素材",
    );
  }
  const request = canonicalVideoGenerationRequest({
    version: VIDEO_GENERATION_REQUEST_VERSION,
    operation,
    modelRouteId: input.modelRouteId,
    ...(input.renderMode ? { renderMode: input.renderMode } : {}),
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    durationSeconds: input.durationSeconds,
    outputResolution: input.outputResolution,
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    generateAudio: input.generateAudio,
    preserveSourceAudio: input.preserveSourceAudio ?? false,
    inputs: input.inputs,
    ...(input.source ? { source: input.source } : {}),
    ...(input.edit ? { edit: input.edit } : {}),
  });
  return { request, digest: videoGenerationRequestDigest(request) };
}
