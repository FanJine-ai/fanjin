import { WorkspaceGenerationQueued } from "@/lib/workspaceResources";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import type { Knex } from "knex";
import {
  createAgentGenerationQuote,
  createAgentGenerationQuoteForApproval,
  resendAgentGenerationQuoteForApproval,
  verifyAgentGenerationQuoteForExecution,
  verifyAgentGenerationQuoteForIdempotentReplay,
  AGENT_GENERATION_QUOTE_APPROVAL_ANCHOR_PREFIX,
  type AgentGenerationQuoteDto,
  type AgentGenerationType,
} from "@/agent-runtime/generationQuoteService";
import { isAgentGenerationSubmitEnabled, isAgentReviewGateEnabled } from "@/agent-runtime/featureFlags";
import {
  generationImageSubmitOutputSchema,
  generationSubmitAssetSchema,
  generationVideoSubmitOutputSchema,
  type GenerationImageSubmitOutput,
  type GenerationSubmitReviewSummary,
  type GenerationVideoSubmitOutput,
} from "@/agent-runtime/generationSubmitContract";
import {
  GenerationReviewService,
  runGenerationReviewGateSafely,
  type ImageReviewAssetFacts,
} from "@/agent-runtime/generationReviewService";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import { defineAgentTool, type AgentToolAuthorizationContext } from "@/agent-runtime/tools/registry";
import { AGENT_APPROVAL_TABLE } from "@/lib/migrations/agentApprovalDelegation";
import { AGENT_GENERATION_QUOTE_TABLE } from "@/lib/migrations/agentGenerationQuote";
import { BillingError, refundWorkspace } from "@/lib/billing";
import { insertAndReturnId } from "@/lib/dbDialect";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
} from "@/lib/durableObjectWrite";
import {
  abandonDurableCommand,
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  mutateDurableCommandCheckpoint,
  checkpointDurableCommand,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import {
  commitObjectWriteIntentInTransaction,
  type ObjectWriteIntentClaim,
} from "@/lib/objectWriteIntent";
import {
  executeRelayImage,
  RelayImageError,
  type RelayImageRequest,
  type RelayImageResult,
} from "@/lib/relayImage";
import {
  isRetryablePortraitProviderBindingPending,
  isUnsupportedPortraitImageReference,
  portraitProviderBindingRetrySchedule,
  PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
} from "@/lib/portraitProviderBindingRetry";
import {
  RELAY_IMAGE_PROVIDER_READBACK_CONTRACT_VERSION,
  RELAY_IMAGE_PROVIDER_READBACK_PROOF_VERSION,
  RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_AUTHORIZATION_VERSION,
  RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_PROOF_VERSION,
  readRelayImageProviderResult,
  relayImageProviderRequestHash,
  settleRecoveredRelayImageProviderResult,
  type RelayImageProviderReadbackOutcome,
} from "@/lib/relayImageProviderReadback";
import { createRelayTask } from "@/lib/relay";
import { resolveRelaySubmissionOutcome } from "@/lib/relaySubmissionOutcome";
import {
  relayProviders,
  type RelayProvider,
} from "@/lib/sharedTypes";
import type { RelayVideoBillingAuthorizationFacts } from "@/lib/relay";
import {
  videoInputPricingTierForRequestPayload,
  type VideoInputPricingTier,
} from "@/lib/videoInputPricing";
import {
  GENERATION_REFERENCE_ROLES,
  GenerationReferenceError,
  resolveCanonicalGenerationReferences,
  type GenerationReference,
  type ResolvedGenerationReferences,
} from "@/lib/generationReferenceResolver";
import {
  resolveWorkbenchVideoReferenceLimit,
  validateWorkbenchVideoInputs,
} from "@/lib/workbenchVideoCapability";
import {
  resolveWorkbenchModelCapability,
  type WorkbenchModelCapability,
  type WorkbenchModelEndpointType,
} from "@/lib/workbenchModelCatalog";
import { resolveVolcengineImageSize } from "@/lib/volcengineImageSize";
import u from "@/utils";
import {
  VIDEO_OPERATIONS,
  VIDEO_REFERENCE_MEDIA_TYPES,
  type VideoOperation,
} from "@/lib/videoGenerationContract";
import {
  buildCanonicalVideoGenerationEnvelope,
  buildLegacyVideoProviderRequestPayload,
  type CanonicalVideoGenerationEnvelope,
} from "@/lib/videoGenerationSurfaceContract";
import {
  prepareSeedance25Request,
  Seedance25AdapterError,
  type PreparedSeedance25Request,
} from "@/lib/seedance25Adapter";

export {
  generationImageSubmitOutputSchema,
  generationVideoSubmitOutputSchema,
};
export type {
  GenerationImageSubmitOutput,
  GenerationSubmitReviewSummary,
  GenerationVideoSubmitOutput,
};

export const generationQuoteInputSchema = z.object({
  generationType: z.enum(["image", "video"]),
  model: z.string().trim().min(1).max(200),
  // Portable strict schemas omit numeric bounds. Literal alternatives retain
  // the supported image counts while video remains single-unit below.
  units: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
    z.literal(6), z.literal(7), z.literal(8), z.literal(9), z.literal(10)]).default(1),
  provider: z.string().trim().min(1).max(100).nullable().default(null),
  videoInputPricingTier: z.enum(["with_video_input", "without_video_input"])
    .default("without_video_input"),
  durationSeconds: z.union([z.literal(-1), z.number().int().min(1).max(60)]).nullable().default(null),
  resolution: z.string().trim().min(1).max(20).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.generationType === "video" && value.units !== 1) {
    context.addIssue({ code: "custom", path: ["units"], message: "视频报价每次只能包含 1 条视频" });
  }
  if (value.generationType === "image" && value.videoInputPricingTier !== "without_video_input") {
    context.addIssue({
      code: "custom",
      path: ["videoInputPricingTier"],
      message: "图片报价不能使用视频输入价格档",
    });
  }
  if (value.generationType === "image" && value.durationSeconds !== null) {
    context.addIssue({
      code: "custom",
      path: ["durationSeconds"],
      message: "图片报价不能绑定视频时长",
    });
  }
});

export const generationQuoteOutputSchema: z.ZodType<AgentGenerationQuoteDto> = z.object({
  quoteId: z.string().min(1),
  generationType: z.enum(["image", "video"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  units: z.number().int().positive(),
  unit: z.enum(["image", "task", "video", "token"]),
  currency: z.literal("GU"),
  estimatedCostMicros: z.number().int().positive(),
  maximumCostMicros: z.number().int().positive(),
  estimatedCostGu: z.number().positive(),
  maximumCostGu: z.number().positive(),
  estimatedCostYuanEquivalent: z.number().positive(),
  maximumCostYuanEquivalent: z.number().positive(),
  display: z.string().min(1),
  expiresAt: z.number().int().positive(),
}).strict();

export const GENERATION_QUOTE_TOOL = defineAgentTool({
  manifest: {
    name: "generation.quote",
    version: "1.0.0",
    displayName: "生成任务报价",
    description: "根据当前工作区的供应商路由和专属 GU 定价生成短时、可验证的报价；图片 units 为 1–10，视频 units 必须为 1。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read", "generation:create"],
    resourceTypes: ["generation_quote", "provider_route", "pricing_rule"],
    // The immutable quote row is authorization/billing evidence, not a user
    // business-state mutation. No generation task, reservation or upstream
    // side effect is created by this R0 tool.
    mutatesState: false,
    metered: false,
  },
  inputSchema: generationQuoteInputSchema,
  outputSchema: generationQuoteOutputSchema,
  async execute(input, context) {
    return createAgentGenerationQuote({
      database: context.database,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.runId,
      stepId: context.stepId,
      actorUserId: context.actorUserId,
      request: input,
      now: context.now,
    });
  },
});

// ─── R2 generation submit tools (REVAMP-PLAN 1.1 + 1.6 一期) ─────────────────
//
// propose 语义:模型调用 = 生成待确认提案;审批时刻还没有 tool Step,报价经
// createAgentGenerationQuoteForApproval 绑定到 `approval:<modelStepId>` 锚;
// 批准恢复后 execute 先 verifyAgentGenerationQuoteForExecution 实时重验路由/
// 定价,再复用 executeRelayImage(图片同步)/ createRelayTask(视频异步)。
// 供应商/计费失败一律回 `{status:"failed"}` JSON 不抛错;报价/审批类错误
// (过期、变价、锚缺失) fail-closed 抛出。

const SUBMITTABLE_CAPABILITY_STATUSES = new Set(["verified", "configured", "legacy"]);
export const AGENT_GENERATION_APPROVAL_POLICY_VERSION =
  "agent-generation-approval-v1";

function readImageUrl(item: { url?: string; b64_json?: string }): string {
  if (item.url) return item.url;
  if (item.b64_json) return item.b64_json.startsWith("data:") ? item.b64_json : `data:image/png;base64,${item.b64_json}`;
  return "";
}

// ─── 输入 Schema(coarse 边界;模型能力 clamp 在服务端 helpers 内完成) ─────────

const submitRatioSchema = z.string().trim().regex(/^\d{1,3}:\d{1,3}$/).nullable().default(null);
const submitQualitySchema = z.string().trim().min(1).max(20).nullable().default(null);
const generationReferenceSchema = z.object({
  assetVersionId: z.number().int().positive(),
  role: z.enum(GENERATION_REFERENCE_ROLES),
  // OpenAI strict function schemas require every declared property to be in
  // `required`. Keep absence explicit on the model wire and normalize null
  // back to the canonical resolver's optional representation below.
  mediaType: z.enum(VIDEO_REFERENCE_MEDIA_TYPES).nullable().default(null),
  order: z.number().int().min(0).max(49).nullable().default(null),
  trim: z.object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().positive(),
  }).strict().nullable().default(null),
}).strict();
const videoModeSchema = z.enum([
  "text_to_video",
  "image_to_video",
  "first_last_frame",
  "omni_reference",
  "image_reference",
  "reference_to_video",
  "video_extension",
  "video_edit",
]).nullable().default(null);

export const generationImageSubmitInputSchema = z.object({
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(4000),
  ratio: submitRatioSchema,
  quality: submitQualitySchema,
  units: z.number().int().min(1).max(10).default(1),
  references: z.array(generationReferenceSchema).max(4).default([]),
}).strict();

export const generationVideoSubmitInputSchema = z.object({
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().max(4000),
  ratio: z.union([z.literal("adaptive"), submitRatioSchema]).describe("普通生成使用模型目录画幅；原生 extend/edit 必须使用 adaptive，跟随原片"),
  resolution: z.string().trim().min(1).max(20).nullable().default(null),
  outputFormat: z.enum(["mp4", "mov"]).nullable().default(null),
  duration: z.union([z.literal(-1), z.number().positive().max(60)]).nullable().default(null).describe("edit 必须使用 -1 跟随原片时长；其他视频时长，模型 duration.auto=true 时可传 -1 让模型自动决定，否则使用目录内的固定秒数"),
  generateAudio: z.boolean().default(false),
  units: z.literal(1).default(1),
  mode: videoModeSchema,
  operation: z.enum(VIDEO_OPERATIONS).nullable().default(null),
  sourceAssetVersionId: z.string().trim().min(1).max(200).nullable().default(null),
  references: z.array(generationReferenceSchema).max(50).default([]),
  /** Executor V3 compatibility entrance; normalized into the generic references contract below. */
  firstFrameAssetVersionId: z.number().int().positive().nullable().default(null),
  lastFrameAssetVersionId: z.number().int().positive().nullable().default(null),
}).strict().superRefine((value, context) => {
  if (
    value.firstFrameAssetVersionId !== null
    && value.lastFrameAssetVersionId !== null
    && value.firstFrameAssetVersionId === value.lastFrameAssetVersionId
  ) {
    context.addIssue({
      code: "custom",
      path: ["lastFrameAssetVersionId"],
      message: "首帧与尾帧不能是同一资产版本",
    });
  }
  for (const [field, role] of [
    ["firstFrameAssetVersionId", "first_frame"],
    ["lastFrameAssetVersionId", "last_frame"],
  ] as const) {
    if (value[field] !== null && value.references.some((reference) => reference.role === role)) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `不能同时通过 ${field} 和 references.${role} 指定同一帧角色`,
      });
    }
  }
});

export type GenerationImageSubmitInput = z.infer<typeof generationImageSubmitInputSchema>;
export type GenerationVideoSubmitInput = z.infer<typeof generationVideoSubmitInputSchema>;

// ─── 能力归一与严格校验 ──────────────────────────────────────────────────────

export interface ClampedImageSubmitRequest {
  generationType: "image";
  model: string;
  prompt: string;
  ratio: string;
  quality: string;
  units: number;
  size: string;
  references: GenerationReference[];
}

export interface ClampedVideoSubmitRequest {
  generationType: "video";
  model: string;
  prompt: string;
  ratio: string;
  resolution: string;
  outputFormat?: "mp4" | "mov";
  duration: number;
  generateAudio: boolean;
  units: 1;
  mode: z.infer<typeof videoModeSchema>;
  operation: VideoOperation | null;
  sourceAssetVersionId?: string;
  references: GenerationReference[];
}

function capabilityStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function resolveCapabilityValue(input: {
  requested: string | null;
  allowed: string[];
  fallback: string | undefined;
  field: "quality" | "ratio" | "resolution";
  label: string;
}): string {
  if (input.allowed.length === 0) {
    throw new AgentToolGatewayError(
      "generation_capability_incomplete",
      `所选模型没有声明可执行的${input.label}能力`,
      { status: 409 },
    );
  }
  if (input.requested !== null) {
    if (input.allowed.includes(input.requested)) return input.requested;
    throw new AgentToolGatewayError(
      `generation_${input.field}_unsupported`,
      `所选模型不支持${input.label} ${input.requested}；可用值为 ${input.allowed.join("、")}`,
      { status: 422 },
    );
  }
  if (input.fallback && input.allowed.includes(input.fallback)) {
    return input.fallback;
  }
  return input.allowed[0];
}

function assertImageOutputCountSupported(
  units: number,
  capability: WorkbenchModelCapability,
): void {
  const maxOutputs = Number.isSafeInteger(capability.maxOutputs)
    && Number(capability.maxOutputs) >= 1
    ? Number(capability.maxOutputs)
    : 1;
  if (units > maxOutputs) {
    throw new AgentToolGatewayError(
      "generation_image_count_unsupported",
      `所选图片模型每次最多生成 ${maxOutputs} 张`,
      { status: 422 },
    );
  }
}

export function clampImageSubmitRequest(
  input: GenerationImageSubmitInput,
  capability: WorkbenchModelCapability,
): ClampedImageSubmitRequest {
  assertImageOutputCountSupported(input.units, capability);
  const qualities = capabilityStrings(capability.qualities);
  const aspectRatios = capabilityStrings(capability.aspectRatios);
  const quality = resolveCapabilityValue({
    requested: input.quality,
    allowed: qualities,
    fallback: capability.defaultQuality,
    field: "quality",
    label: "图片清晰度",
  });
  const ratio = resolveCapabilityValue({
    requested: input.ratio,
    allowed: aspectRatios,
    fallback: capability.defaultAspectRatio,
    field: "ratio",
    label: "图片比例",
  });
  const size = resolveVolcengineImageSize(quality, ratio);
  if (!size) {
    throw new AgentToolGatewayError(
      "generation_image_size_contract_unsupported",
      `所选图片清晰度 ${quality} 与比例 ${ratio} 没有已验证的上游尺寸映射`,
      { status: 422 },
    );
  }
  return {
    generationType: "image",
    model: capability.id,
    prompt: input.prompt,
    ratio,
    quality,
    units: input.units,
    size,
    references: input.references.map((reference) => ({
      assetVersionId: String(reference.assetVersionId),
      role: reference.role,
    })),
  };
}

function resolveVideoDuration(
  requested: number | null,
  duration: WorkbenchModelCapability["duration"],
): number {
  if (!duration) {
    throw new AgentToolGatewayError(
      "generation_capability_incomplete",
      "所选模型没有声明可执行的视频时长能力",
      { status: 409 },
    );
  }
  const allowed = Array.isArray(duration.allowed) ? duration.allowed : [];
  const fits = (value: number): boolean => value === -1 ? duration.auto === true : (allowed.length > 0
    ? allowed.includes(value)
    : value >= duration.min && value <= duration.max
      && Math.abs((value - duration.min) / duration.step - Math.round((value - duration.min) / duration.step)) < 1e-9);
  if (requested !== null) {
    if (Number.isFinite(requested) && fits(requested)) return requested;
    const range = allowed.length > 0
      ? allowed.join("、")
      : `${duration.min}–${duration.max}（步长 ${duration.step}）`;
    throw new AgentToolGatewayError(
      "generation_duration_unsupported",
      `所选模型不支持视频时长 ${requested} 秒；可用值为 ${range}`,
      { status: 422 },
    );
  }
  if (Number.isFinite(duration.default) && fits(duration.default)) {
    return duration.default;
  }
  if (allowed.length > 0) return allowed[0];
  if (Number.isFinite(duration.min) && fits(duration.min)) return duration.min;
  throw new AgentToolGatewayError(
    "generation_capability_incomplete",
    "所选模型的视频默认时长不在其能力范围内",
    { status: 409 },
  );
}

export function clampVideoSubmitRequest(
  input: GenerationVideoSubmitInput,
  capability: WorkbenchModelCapability,
): ClampedVideoSubmitRequest {
  const executorFrameReferences: GenerationReference[] = [
    ...(input.firstFrameAssetVersionId !== null
      ? [{ assetVersionId: String(input.firstFrameAssetVersionId), role: "first_frame" as const }]
      : []),
    ...(input.lastFrameAssetVersionId !== null
      ? [{ assetVersionId: String(input.lastFrameAssetVersionId), role: "last_frame" as const }]
      : []),
  ];
  const references = [
    ...input.references.map((reference, index) => ({
      assetVersionId: String(reference.assetVersionId),
      role: reference.role,
      ...(reference.mediaType !== null ? { mediaType: reference.mediaType } : {}),
      // The array order is already canonical. Model-generated ordinal labels
      // are often 1-based, while the shared resolver requires 0-based order.
      ...(reference.order !== null ? { order: index } : {}),
      ...(reference.trim !== null ? { trim: { ...reference.trim } } : {}),
    })),
    ...executorFrameReferences,
  ];
  if (!input.prompt && !(capability.videoGeneration?.contractFamily === "seedance-2.5" && references.length > 0)) {
    throw new AgentToolGatewayError("generation_prompt_required", "当前视频请求需要提示词或参考素材", { status: 422 });
  }
  const mode = input.mode ?? (
    input.firstFrameAssetVersionId !== null && input.lastFrameAssetVersionId !== null
      ? "first_last_frame"
      : executorFrameReferences.length > 0
        ? "image_to_video"
        : null
  );
  const resolutions = capabilityStrings(capability.resolutions);
  const operation = input.operation ?? (mode === "video_extension" ? "extend" : mode === "video_edit" ? "edit" : null);
  if (mode === "video_edit" && operation !== "edit" || mode === "video_extension" && operation !== "extend") {
    throw new AgentToolGatewayError("generation_operation_mode_mismatch", "视频模式与 operation 不一致", { status: 422 });
  }
  const extensionOperation = operation === "extend" || operation === "edit" ? capability.videoGeneration?.operations.find((item) => item.operation === operation && item.enabled) : undefined;
  if ((operation === "extend" || operation === "edit") && (!extensionOperation || capability.videoGeneration?.contractFamily !== "seedance-2.5")) {
    throw new AgentToolGatewayError("generation_operation_unsupported", "当前模型未开放此原生视频延长或编辑操作", { status: 422 });
  }
  const aspectRatios = extensionOperation ? ["adaptive"] : capabilityStrings(capability.aspectRatios);
  const resolution = resolveCapabilityValue({
    requested: input.resolution,
    allowed: resolutions,
    fallback: capability.defaultResolution,
    field: "resolution",
    label: "视频分辨率",
  });
  const ratio = resolveCapabilityValue({
    requested: input.ratio,
    allowed: aspectRatios,
    fallback: extensionOperation ? "adaptive" : capability.defaultAspectRatio,
    field: "ratio",
    label: "视频比例",
  });
  if (operation === "edit" && input.duration !== null && input.duration !== -1) {
    throw new AgentToolGatewayError("generation_edit_duration_required", "视频编辑的时长跟随原片，请使用 -1", { status: 422 });
  }
  const duration = operation === "edit" ? -1 : resolveVideoDuration(input.duration, extensionOperation?.duration ?? capability.duration);
  if (input.outputFormat && !capability.videoGeneration?.outputFormats?.includes(input.outputFormat)) {
    throw new AgentToolGatewayError("generation_output_format_unsupported", "所选模型不支持此视频格式", { status: 422 });
  }
  if (input.generateAudio && capability.supportsGenerateAudio !== true) {
    throw new AgentToolGatewayError(
      "generation_audio_unsupported",
      "所选模型不支持生成音频",
      { status: 422 },
    );
  }
  if (
    (capability.videoGeneration ? !capability.videoGeneration.dispatchable : false)
    || references.length > (
      capability.videoGeneration?.totalInputLimit
      ?? resolveWorkbenchVideoReferenceLimit(capability, mode)
    )
  ) {
    throw new AgentToolGatewayError(
      "generation_reference_limit_unsupported",
      "参考素材数量超过模型目录声明的动态上限",
      { status: 422 },
    );
  }
  return {
    generationType: "video",
    model: capability.id,
    prompt: input.prompt,
    ratio,
    resolution,
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    duration,
    generateAudio: input.generateAudio,
    units: 1,
    mode,
    operation,
    ...(input.sourceAssetVersionId ? { sourceAssetVersionId: input.sourceAssetVersionId } : {}),
    references,
  };
}

async function resolveAgentGenerationReferenceContent(input: {
  context: AgentToolAuthorizationContext;
  references: GenerationReference[];
}): Promise<ResolvedGenerationReferences> {
  try {
    return await resolveCanonicalGenerationReferences({
      database: input.context.database,
      workspaceId: input.context.workspaceId,
      projectId: String(input.context.projectId),
      actorUserId: input.context.actorUserId,
      references: input.references,
    });
  } catch (error) {
    if (error instanceof GenerationReferenceError) {
      throw new AgentToolGatewayError(error.code, error.message, { status: error.status });
    }
    throw error;
  }
}

type PreparedAgentVideoRequest = {
  references: ResolvedGenerationReferences;
  mode: string;
  canonical: CanonicalVideoGenerationEnvelope;
  requestPayload: Record<string, unknown>;
  relayAdapterBinding?: PreparedSeedance25Request["relayAdapterBinding"];
};

async function prepareAgentVideoRequest(input: {
  context: AgentToolAuthorizationContext;
  capability: WorkbenchModelCapability;
  clamped: ClampedVideoSubmitRequest;
}): Promise<PreparedAgentVideoRequest> {
  const references = await resolveAgentGenerationReferenceContent({
    context: input.context,
    references: input.clamped.references,
  });
  if (input.capability.videoGeneration?.contractFamily) {
    const sourceVideos = references.inputs.filter((reference) => reference.mediaType === "video");
    const sourceVideo = input.clamped.sourceAssetVersionId
      ? sourceVideos.find((reference) => reference.assetVersionId === input.clamped.sourceAssetVersionId)
      : sourceVideos.length === 1 ? sourceVideos[0] : undefined;
    if ((input.clamped.operation === "extend" || input.clamped.operation === "edit") && !sourceVideo) {
      throw new AgentToolGatewayError("generation_extension_source_required", "视频延长或编辑必须在受控视频参考中明确指定原片", { status: 422 });
    }
    const canonical = buildCanonicalVideoGenerationEnvelope({
      operation: input.clamped.operation ?? "generate",
      modelRouteId: input.capability.routeId || input.capability.id,
      prompt: input.clamped.prompt,
      aspectRatio: input.clamped.ratio,
      durationSeconds: input.clamped.duration,
      outputResolution: input.clamped.resolution,
      outputFormat: input.clamped.outputFormat,
      generateAudio: input.clamped.generateAudio,
      inputs: references.inputs,
      preparedReferenceContent: references.providerContent,
      ...(["extend", "edit"].includes(input.clamped.operation || "") ? { source: { assetVersionId: sourceVideo!.assetVersionId } } : {}),
      ...(input.clamped.operation === "edit" ? { edit: { instruction: input.clamped.prompt, preserve: [] } } : {}),
    });
    try {
      const provider = prepareSeedance25Request({
        capability: input.capability,
        request: canonical.request,
        providerContent: references.providerContent,
        policyEvidence: references.trustedPolicyEvidence,
        workspaceId: input.context.workspaceId,
        projectId: String(input.context.projectId),
      });
      return {
        references,
        mode: input.clamped.operation === "extend" ? "video_extension" : input.clamped.operation === "edit" ? "video_edit" : references.inputs.length ? "omni_reference" : "text_to_video",
        canonical,
        requestPayload: provider.requestPayload,
        relayAdapterBinding: provider.relayAdapterBinding,
      };
    } catch (error) {
      if (error instanceof Seedance25AdapterError) {
        throw new AgentToolGatewayError(error.code, error.message, { status: error.status });
      }
      throw error;
    }
  }
  const mode = validatedVideoMode(
    input.capability,
    { ...input.clamped, references: references.inputs },
    references.providerContent,
  );
  const canonical = buildCanonicalVideoGenerationEnvelope({
    operation: input.clamped.operation,
    selectedLegacyMode: mode,
    modelRouteId: input.capability.routeId || input.capability.id,
    prompt: input.clamped.prompt,
    aspectRatio: input.clamped.ratio,
    durationSeconds: input.clamped.duration,
    outputResolution: input.clamped.resolution,
    generateAudio: input.clamped.generateAudio,
    inputs: references.inputs,
      preparedReferenceContent: references.providerContent,
  });
  return {
    references,
    mode,
    canonical,
    requestPayload: buildLegacyVideoProviderRequestPayload({
      model: input.clamped.model,
      canonicalRequest: canonical.request,
      providerContent: references.providerContent,
    }),
  };
}

function referenceResourceEvidence(references: GenerationReference[]) {
  return references.map((reference) => ({
    type: "assetVersionIds" as const,
    id: reference.assetVersionId,
  }));
}

function imageReferenceUrls(content: Record<string, unknown>[]): string[] {
  return content.map((item) => {
    const imageUrl = item.type === "image_url" && item.image_url && typeof item.image_url === "object"
      ? String((item.image_url as Record<string, unknown>).url || "").trim()
      : "";
    if (!imageUrl) {
      throw new AgentToolGatewayError(
        "generation_image_reference_invalid",
        "图片生成只接受受控图片参考素材",
        { status: 422 },
      );
    }
    return imageUrl;
  });
}

function validatedVideoMode(
  capability: WorkbenchModelCapability,
  request: ClampedVideoSubmitRequest,
  referenceContent: Record<string, unknown>[],
): string {
  const validation = validateWorkbenchVideoInputs(capability, [{
    references: request.references,
    referenceContent,
    mode: request.mode,
  }]);
  // 兼容已在线的 legacy/standard 文生视频能力声明。它们在 Agent 视频工具
  // 上线前没有细分 mode/inputSlots；只允许无参考素材走原有文生视频路径，
  // 一旦携带参考素材仍必须通过严格输入槽校验。
  const declaredModes = capabilityStrings(capability.modes).map((mode) => mode.trim().toLowerCase());
  if (
    !validation.ok
    && request.references.length === 0
    && request.mode === null
    && declaredModes.length > 0
    && declaredModes.every((mode) => mode === "standard")
  ) {
    return "text_to_video";
  }
  if (!validation.ok || !validation.modes[0]) {
    throw new AgentToolGatewayError(
      "generation_video_references_invalid",
      validation.ok ? "视频生成模式无法解析" : validation.message,
      { status: 422 },
    );
  }
  return validation.modes[0];
}

async function requireSubmittableCapability(
  database: AgentToolAuthorizationContext["database"],
  workspaceId: string,
  endpointType: WorkbenchModelEndpointType,
  model: string,
): Promise<WorkbenchModelCapability> {
  // 连接注入(REVAMP-PLAN 风险 #7):能力解析是纯读,必须在 Gateway 事务
  // 连接上执行;缺省走全局 db 单例会在 SQLite pool max=1 时自锁。
  const capability = await resolveWorkbenchModelCapability({ database, workspaceId, endpointType, model });
  if (!capability || capability.canSubmit !== true || !SUBMITTABLE_CAPABILITY_STATUSES.has(capability.capabilityStatus)) {
    throw new AgentToolGatewayError(
      "generation_model_unavailable",
      capability?.unavailableReason || "所选生成模型当前不可提交",
      { status: 422 },
    );
  }
  return capability;
}

// ─── 审批锚定报价解析 ────────────────────────────────────────────────────────

type SubmitEvidencePhase = "mint" | "execute" | "replay";

/**
 * `generationPreferences` is a server-confirmed Run fact, not model input.
 * The initial proposal must match it exactly before any quote/Approval can be
 * created. A human revision may change only the fields exposed as editable by
 * AgentApprovalCard (prompt/ratio/quality); model and count stay immutable.
 */
function assertImageGenerationPreferences(
  request: ClampedImageSubmitRequest,
  context: AgentToolAuthorizationContext,
  phase: SubmitEvidencePhase,
): void {
  const preferences = context.generationPreferences;
  if (!preferences) return;
  if (preferences.generationType !== "image") {
    throw new AgentToolGatewayError(
      "generation_preferences_tool_mismatch",
      "已确认的创作类型与图片生成工具不一致",
      { status: 409 },
    );
  }
  const immutableMismatch = preferences.model !== request.model
    || preferences.count !== request.units;
  const initialProposalMismatch = phase === "mint"
    && !context.approvalDecisionRevision
    && (
      preferences.ratio !== request.ratio
      || preferences.quality !== request.quality
    );
  if (immutableMismatch || initialProposalMismatch) {
    throw new AgentToolGatewayError(
      "generation_preferences_mismatch",
      "图片生成提案与本轮已确认的模型、比例、清晰度或张数不一致",
      { status: 409 },
    );
  }
}

/**
 * Gateway 在审批准备期把 model stepId 传入 evidence;执行期传入新鲜 tool
 * Step(running);重放期传入已 succeeded 的原 tool Step。三种相位只由持久化
 * Step 事实区分,模型与调用方无法伪造。
 */
async function detectSubmitEvidencePhase(
  context: AgentToolAuthorizationContext,
): Promise<SubmitEvidencePhase> {
  const step = await context.database("o_agent_step")
    .where({
      id: context.stepId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.runId,
    })
    .select("kind", "status")
    .first();
  if (step && String(step.kind) === "model" && String(step.status) === "succeeded") return "mint";
  if (step && String(step.kind) === "tool" && String(step.status) === "succeeded") return "replay";
  return "execute";
}

interface LocatedApprovalQuote {
  quoteId: string;
  provider: string;
  estimatedCostMicros: number;
  maximumCostMicros: number;
  expiresAt: number;
}

/**
 * 执行/重放相位:经持久化审批行(argumentsHash 精确匹配)找回
 * `approval:<modelStepId>` 锚定报价,绝不接受模型传入的 quoteId。
 */
async function locateApprovalAnchoredQuote(
  context: AgentToolAuthorizationContext,
  toolId: "generation.image.submit" | "generation.video.submit" | "generation.task.retry",
  parsedArguments: unknown,
): Promise<LocatedApprovalQuote> {
  const argumentsHash = hashIdempotencyRequest(parsedArguments);
  const approval = await context.database(AGENT_APPROVAL_TABLE)
    .where({
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.runId,
      toolId,
      argumentsHash,
    })
    .whereIn("status", ["approved", "consumed"])
    .orderBy("createdAt", "desc")
    .first();
  const modelStepId = approval?.stepId == null ? "" : String(approval.stepId);
  if (!approval || !modelStepId) {
    throw new AgentToolGatewayError("generation_quote_not_found", "未找到绑定该调用的审批锚定报价", { status: 404 });
  }
  const row = await context.database(AGENT_GENERATION_QUOTE_TABLE)
    .where({
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.runId,
      stepId: `${AGENT_GENERATION_QUOTE_APPROVAL_ANCHOR_PREFIX}${modelStepId}`,
    })
    .first();
  if (!row) {
    throw new AgentToolGatewayError("generation_quote_not_found", "审批锚定报价不存在", { status: 404 });
  }
  const estimatedCostMicros = Number(row.estimatedCostMicros);
  const maximumCostMicros = Number(row.maximumCostMicros);
  const expiresAt = Number(row.expiresAt);
  const provider = String(row.provider || "");
  if (!provider || !Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros <= 0
    || !Number.isSafeInteger(maximumCostMicros) || maximumCostMicros < estimatedCostMicros
    || !Number.isSafeInteger(expiresAt)) {
    throw new AgentToolGatewayError("generation_quote_record_corrupt", "持久化报价记录无效", { status: 500 });
  }
  return { quoteId: String(row.id), provider, estimatedCostMicros, maximumCostMicros, expiresAt };
}

function replayQuoteEvidence(located: LocatedApprovalQuote) {
  // 精确重放:报价可能在首次执行后已过期,此相位只重建与消费审批时一致的
  // 持久化事实;scopeHash 不一致会被 approvalService fail-closed 拒绝。
  return {
    quoteId: located.quoteId,
    currency: "GU" as const,
    estimatedCostMicros: located.estimatedCostMicros,
    maximumCostMicros: located.maximumCostMicros,
    expiresAt: located.expiresAt,
  };
}

async function resolveSubmitAuthorizationEvidence(
  generationType: AgentGenerationType,
  toolId: "generation.image.submit" | "generation.video.submit" | "generation.task.retry",
  clamped: { model: string; units: number },
  input: unknown,
  context: AgentToolAuthorizationContext,
  videoInputPricingTier: VideoInputPricingTier = "without_video_input",
  durationSeconds: number | null = null,
  resolution: string | null = null,
) {
  const phase = await detectSubmitEvidencePhase(context);
  if (phase === "mint") {
    const anchorInput = {
      database: context.database,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.runId,
      modelStepId: context.stepId,
      actorUserId: context.actorUserId,
      request: {
        generationType,
        model: clamped.model,
        units: clamped.units,
        provider: null as string | null,
        videoInputPricingTier,
        durationSeconds,
        resolution,
      },
      now: context.now,
    };
    // decide 修订批准重算证据时必须严格替换锚定报价(resend,报价缺失
    // fail-closed 404);常规审批准备期走 upsert(首次铸价/重解析重入)。
    const quote = context.approvalDecisionRevision
      ? await resendAgentGenerationQuoteForApproval(anchorInput)
      : await createAgentGenerationQuoteForApproval(anchorInput);
    return {
      quote: {
        quoteId: quote.quoteId,
        currency: "GU" as const,
        estimatedCostMicros: quote.estimatedCostMicros,
        maximumCostMicros: quote.maximumCostMicros,
        expiresAt: quote.expiresAt,
      },
      estimatedMicros: quote.maximumCostMicros,
      policyVersion: AGENT_GENERATION_APPROVAL_POLICY_VERSION,
    };
  }
  const located = await locateApprovalAnchoredQuote(context, toolId, input);
  if (phase === "replay") {
    const quote = replayQuoteEvidence(located);
    return {
      quote,
      estimatedMicros: quote.maximumCostMicros,
      policyVersion: AGENT_GENERATION_APPROVAL_POLICY_VERSION,
    };
  }
  const verified = await verifyAgentGenerationQuoteForExecution({
    database: context.database,
    quoteId: located.quoteId,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    runId: context.runId,
    expected: { generationType, provider: located.provider, model: clamped.model, units: clamped.units },
    videoInputPricingTier,
    durationSeconds,
    resolution,
    now: context.now,
  });
  return {
    quote: verified.approvalQuote,
    estimatedMicros: verified.approvalQuote.maximumCostMicros,
    policyVersion: AGENT_GENERATION_APPROVAL_POLICY_VERSION,
  };
}

export async function resolveGenerationTaskRetryAuthorizationEvidence(
  input: {
    model: string;
    parsedArguments: unknown;
    context: AgentToolAuthorizationContext;
    videoInputPricingTier?: VideoInputPricingTier;
    durationSeconds?: number | null;
    resolution?: string | null;
  },
) {
  return resolveSubmitAuthorizationEvidence(
    "video",
    "generation.task.retry",
    { model: input.model, units: 1 },
    input.parsedArguments,
    input.context,
    input.videoInputPricingTier,
    input.durationSeconds,
    input.resolution,
  );
}

interface VerifiedGenerationTaskRetryQuote {
  quoteId: string;
  provider: string;
  videoBillingAuthorization: RelayVideoBillingAuthorizationFacts;
}

async function verifyGenerationTaskRetryQuoteWithMode(
  input: {
    model: string;
    parsedArguments: unknown;
    context: AgentToolAuthorizationContext;
    videoInputPricingTier?: VideoInputPricingTier;
    durationSeconds?: number | null;
    resolution?: string | null;
  },
  mode: "execution" | "idempotent-replay",
): Promise<VerifiedGenerationTaskRetryQuote> {
  const located = await locateApprovalAnchoredQuote(
    input.context,
    "generation.task.retry",
    input.parsedArguments,
  );
  const verify = mode === "execution"
    ? verifyAgentGenerationQuoteForExecution
    : verifyAgentGenerationQuoteForIdempotentReplay;
  const verified = await verify({
    database: input.context.database,
    quoteId: located.quoteId,
    workspaceId: input.context.workspaceId,
    projectId: input.context.projectId,
    runId: input.context.runId,
    expected: {
      generationType: "video",
      provider: located.provider,
      model: input.model,
      units: 1,
    },
    videoInputPricingTier: input.videoInputPricingTier,
    durationSeconds: input.durationSeconds,
    resolution: input.resolution,
    now: input.context.now,
  });
  if (!verified.videoBillingAuthorization) {
    throw new AgentToolGatewayError(
      "generation_quote_record_corrupt",
      "视频报价缺少计费授权快照",
      { status: 500 },
    );
  }
  return {
    quoteId: verified.quote.quoteId,
    provider: verified.quote.provider,
    videoBillingAuthorization: verified.videoBillingAuthorization,
  };
}

export async function verifyGenerationTaskRetryQuote(
  input: {
    model: string;
    parsedArguments: unknown;
    context: AgentToolAuthorizationContext;
    videoInputPricingTier?: VideoInputPricingTier;
    durationSeconds?: number | null;
    resolution?: string | null;
  },
): Promise<VerifiedGenerationTaskRetryQuote> {
  return verifyGenerationTaskRetryQuoteWithMode(input, "execution");
}

export async function verifyGenerationTaskRetryQuoteForIdempotentReplay(
  input: {
    model: string;
    parsedArguments: unknown;
    context: AgentToolAuthorizationContext;
    videoInputPricingTier?: VideoInputPricingTier;
    durationSeconds?: number | null;
    resolution?: string | null;
  },
): Promise<VerifiedGenerationTaskRetryQuote> {
  return verifyGenerationTaskRetryQuoteWithMode(input, "idempotent-replay");
}

/**
 * A paid video side effect is anchored to the immutable quote, not to the
 * transient Tool Step that happens to execute it. Gateway recovery may assign
 * a fresh stepId after a response is lost; keeping the quote in the Relay
 * request id makes createRelayTask return the original task and billing
 * reservation instead of creating a second provider attempt.
 */
export function agentVideoSubmitRequestId(quoteId: string): string {
  return `agent-video-submit:${quoteId}`;
}

export function agentVideoRetryRequestId(quoteId: string): string {
  return `agent-video-retry:${quoteId}`;
}

export function requireQuotedRelayProvider(provider: string): RelayProvider {
  const normalized = String(provider || "").trim();
  if ((relayProviders as readonly string[]).includes(normalized)) {
    return normalized as RelayProvider;
  }
  throw new AgentToolGatewayError(
    "generation_quote_provider_unsupported",
    "报价绑定的供应商不受视频中继支持",
    { status: 409 },
  );
}

export function relayIdempotencyInProgressGatewayError(
  error: unknown,
): AgentToolGatewayError | null {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && String((error as { code?: unknown }).code) === "idempotency_in_progress"
  ) {
    return new AgentToolGatewayError(
      "idempotency_in_progress",
      "相同生成任务仍在完成计费预扣，请稍后重试",
      { status: 409 },
    );
  }
  return null;
}

export function relayIdempotentReplayTask<T>(
  result: { task: T; channel: unknown },
): T {
  if (result.channel !== null) {
    throw new AgentToolGatewayError(
      "relay_idempotent_replay_protocol_invalid",
      "视频幂等恢复返回了新的通道分配，已拒绝把它当作既有任务",
      { status: 500 },
    );
  }
  return result.task;
}

// ─── 失败 JSON 与灰度输出 ────────────────────────────────────────────────────

function publicRelayImageErrorMessage(status: number): string {
  if (status === 429) return "图片生成请求过于频繁,请稍后重试";
  if ([400, 413, 415, 422].includes(status)) return "图片生成参数不受支持";
  if ([401, 403].includes(status)) return "图片生成服务认证失败";
  if (status === 404) return "图片生成服务不可用";
  if (status === 409) return "图片生成请求冲突,请刷新后重试";
  return "图片生成服务暂时不可用";
}

function publicSubmitFailure(error: unknown): { code: string; message: string } {
  if (error instanceof BillingError) {
    return { code: "generation_billing_failed", message: error.message || "生成计费失败" };
  }
  if (error instanceof RelayImageError) {
    if (isUnsupportedPortraitImageReference(error)) {
      return {
        code: error.reconcileReason!,
        message: error.message,
      };
    }
    return { code: "image_upstream_failed", message: publicRelayImageErrorMessage(error.statusCode || 502) };
  }
  const candidate = error as { code?: unknown; status?: unknown } | null;
  if (candidate?.code === "invalid_resolution" || Number(candidate?.status) === 400) {
    return { code: "generation_request_invalid", message: "生成参数不受当前模型支持" };
  }
  if (candidate?.code === "agent_image_persistence_failed") {
    return { code: "image_persistence_failed", message: "图片生成结果保存失败,请稍后重试" };
  }
  return { code: "generation_submit_failed", message: "生成服务暂时不可用" };
}

function unavailableImageOutput(input: GenerationImageSubmitInput): GenerationImageSubmitOutput {
  return {
    status: "unavailable",
    code: "generation_submit_disabled",
    message: "Agent 生成提交能力未开放(FANJIN_AGENT_GENERATION_SUBMIT_ENABLED 默认关闭)",
    generationType: "image",
    quoteId: null,
    provider: null,
    model: input.model,
    units: input.units,
    size: null,
    assets: [],
    review: null,
  };
}

function unavailableVideoOutput(input: GenerationVideoSubmitInput): GenerationVideoSubmitOutput {
  return {
    status: "unavailable",
    code: "generation_submit_disabled",
    message: "Agent 生成提交能力未开放(FANJIN_AGENT_GENERATION_SUBMIT_ENABLED 默认关闭)",
    generationType: "video",
    quoteId: null,
    provider: null,
    model: input.model,
    units: 1,
    task: null,
    assetVersionId: null,
    review: null,
  };
}

// ─── Reviewer 质量门(REVAMP-PLAN 2.3,一期规则版) ────────────────────────────
//
// 执行成功后触发:图片审核读取 durable root 中已提交资产并固定首次
// operationStepId，视频审核仍读取 Gateway 事务内任务事实。门自身异常
// fail-open(只记日志),不改变工具成功语义;attention 结论=Run 结果需人工
// 注意,不自动重试。

interface ReviewGateToolContext {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  runId: string;
  stepId: string;
}

async function reviewImageSubmissionGate(input: {
  context: ReviewGateToolContext;
  clamped: ClampedImageSubmitRequest;
  quoteId: string;
  assets: GenerationImageSubmitOutput["assets"];
}): Promise<GenerationSubmitReviewSummary> {
  if (!isAgentReviewGateEnabled()) return null;
  // 事务内回读三表事实:评审只信持久化状态,不信执行过程中的内存对象。
  const facts: ImageReviewAssetFacts[] = [];
  for (const asset of input.assets) {
    const [mediaAssetRow, assetRow, assetVersionRow] = await Promise.all([
      input.context.database("o_media_asset").where({ id: asset.mediaAssetId }).first("id", "url"),
      input.context.database("o_assets").where({ id: asset.assetId }).first("id", "imageId"),
      input.context.database("o_image").where({ id: asset.assetVersionId }).first("id", "assetsId", "resolution", "state"),
    ]);
    facts.push({
      mediaAssetId: asset.mediaAssetId,
      assetId: asset.assetId,
      assetVersionId: asset.assetVersionId,
      mediaAssetRow: mediaAssetRow
        ? { id: String(mediaAssetRow.id), url: mediaAssetRow.url == null ? null : String(mediaAssetRow.url) }
        : null,
      assetRow: assetRow
        ? { id: Number(assetRow.id), imageId: assetRow.imageId == null ? null : Number(assetRow.imageId) }
        : null,
      assetVersionRow: assetVersionRow
        ? {
            id: Number(assetVersionRow.id),
            assetsId: assetVersionRow.assetsId == null ? null : Number(assetVersionRow.assetsId),
            resolution: assetVersionRow.resolution == null ? null : String(assetVersionRow.resolution),
            state: assetVersionRow.state == null ? null : String(assetVersionRow.state),
          }
        : null,
    });
  }
  const stored = await runGenerationReviewGateSafely({
    service: new GenerationReviewService(input.context.database),
    review: {
      workspaceId: input.context.workspaceId,
      projectId: input.context.projectId,
      runId: input.context.runId,
      stepId: input.context.stepId,
      toolId: "generation.image.submit",
      quoteId: input.quoteId,
      review: {
        generationType: "image",
        request: {
          prompt: input.clamped.prompt,
          model: input.clamped.model,
          size: input.clamped.size,
          units: input.clamped.units,
        },
        assets: facts,
      },
    },
  });
  return stored ? { reviewId: stored.id, engine: stored.engine, verdict: stored.verdict } : null;
}

/**
 * 读取持久化 relay 任务行的实际提交时长(o_relay_task.requestPayload.duration)。
 * createRelayTask 走全局连接独立提交(见 execute 内注释),任务行对事务连接
 * 可读;读不到(表缺失/行缺失/载荷异常)时回退为 clamped 值,由规则判定。
 */
async function readPersistedSubmittedDuration(
  database: ReviewGateToolContext["database"],
  taskId: string | null,
): Promise<number | null> {
  if (!taskId) return null;
  try {
    const row = await database("o_relay_task").where({ id: taskId }).first("requestPayload");
    if (!row) return null;
    const payload = typeof row.requestPayload === "string"
      ? JSON.parse(row.requestPayload)
      : row.requestPayload;
    const duration = Number(payload?.duration);
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

async function reviewVideoSubmissionGate(input: {
  context: ReviewGateToolContext;
  clamped: ClampedVideoSubmitRequest;
  quoteId: string;
  task: { taskId: string | null; status: string | null };
}): Promise<GenerationSubmitReviewSummary> {
  if (!isAgentReviewGateEnabled()) return null;
  const persistedDuration = await readPersistedSubmittedDuration(input.context.database, input.task.taskId);
  const stored = await runGenerationReviewGateSafely({
    service: new GenerationReviewService(input.context.database),
    review: {
      workspaceId: input.context.workspaceId,
      projectId: input.context.projectId,
      runId: input.context.runId,
      stepId: input.context.stepId,
      toolId: "generation.video.submit",
      quoteId: input.quoteId,
      review: {
        generationType: "video",
        request: {
          prompt: input.clamped.prompt,
          model: input.clamped.model,
          duration: input.clamped.duration,
          resolution: input.clamped.resolution,
        },
        task: {
          taskId: input.task.taskId,
          status: input.task.status,
          submittedDuration: input.task.taskId
            ? persistedDuration ?? input.clamped.duration
            : null,
        },
      },
    },
  });
  return stored ? { reviewId: stored.id, engine: stored.engine, verdict: stored.verdict } : null;
}

// ─── 图片镜像(FANJIN_MIRROR_RELAY_MEDIA 对齐 relay.ts:605) ───────────────────

interface MirroredAgentImage {
  filePath: string;
  storageKey: string;
  url: string;
  writeIntentClaim: ObjectWriteIntentClaim;
}

async function mirrorAgentImageIfEnabled(input: {
  durableDatabase: Knex;
  workspaceId: string;
  projectId: number;
  item: { url?: string; b64_json?: string };
}): Promise<MirroredAgentImage | null> {
  if (process.env.FANJIN_MIRROR_RELAY_MEDIA !== "1") return null;
  const raw = readImageUrl(input.item);
  if (!raw || raw.startsWith("/oss/")) {
    throw Object.assign(
      new Error("agent image mirror source is missing or unverified"),
      { code: "agent_image_persistence_failed" },
    );
  }
  let buffer: Buffer;
  try {
    if (input.item.b64_json) {
      buffer = Buffer.from(input.item.b64_json.replace(/^data:[^;]+;base64,/, ""), "base64");
    } else {
      const response = await fetch(raw, {
        signal: AbortSignal.timeout(Number(process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600000)),
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`agent image download failed with status ${response.status}`),
          { code: "agent_image_download_failed" },
        );
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }
  } catch (error) {
    throw agentImagePersistenceError(error, []);
  }
  if (buffer.length === 0) {
    throw agentImagePersistenceError(
      Object.assign(
        new Error("agent image download returned an empty body"),
        { code: "agent_image_download_empty" },
      ),
      [],
    );
  }
  try {
    const durable = await writeObjectWithDurableIntent({
      purpose: "agent_generation",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      body: buffer,
      storageKey: (intentId) =>
        `${input.projectId}/agent/${intentId}.png`,
      writerIdPrefix: "agent-generation",
    }, {
      database: input.durableDatabase,
      writer: u.oss,
    });
    return {
      filePath: durable.storageKey,
      storageKey: durable.storageKey,
      url: durable.url,
      writeIntentClaim: durable.claim,
    };
  } catch (error) {
    throw agentImagePersistenceError(error, []);
  }
}

interface StagedAgentImage {
  index: number;
  url: string;
  mirrored: MirroredAgentImage | null;
}

const AGENT_IMAGE_COMMAND_SCOPE =
  "agent-runtime:generation:image-submit:v1";
const AGENT_IMAGE_COMMAND_VERSION =
  "agent-generation-image-command.v1" as const;
const AGENT_IMAGE_TEST_FAILPOINT_ENV =
  "FANJIN_TEST_AGENT_IMAGE_COMMAND_FAILPOINT";
const DEFAULT_AGENT_IMAGE_READBACK_AFTER_MS = 15 * 60 * 1_000;

function agentImageReadbackAfterMs(): number {
  const configured = Number(
    process.env.FANJIN_AGENT_IMAGE_READBACK_AFTER_MS,
  );
  return Number.isSafeInteger(configured) && configured >= 1_000
    ? configured
    : DEFAULT_AGENT_IMAGE_READBACK_AFTER_MS;
}

type AgentImageTestFailpoint =
  | "after_prepared_checkpoint"
  | "after_readback_checkpoint"
  | "after_readback_settlement"
  | "after_upstream_checkpoint"
  | "inside_asset_transaction"
  | "after_assets_checkpoint"
  | "after_completion";

class AgentImageCommandInjectedCrash extends Error {
  readonly code = "agent_image_test_crash";

  constructor(readonly failpoint: AgentImageTestFailpoint) {
    super(`injected agent image command crash: ${failpoint}`);
    this.name = "AgentImageCommandInjectedCrash";
  }
}

function throwAgentImageTestCrash(
  failpoint: AgentImageTestFailpoint,
): void {
  if (
    process.env.NODE_ENV === "test"
    && process.env[AGENT_IMAGE_TEST_FAILPOINT_ENV] === failpoint
  ) {
    throw new AgentImageCommandInjectedCrash(failpoint);
  }
}

function isAgentImageTestCrash(
  error: unknown,
): error is AgentImageCommandInjectedCrash {
  return error instanceof AgentImageCommandInjectedCrash;
}

const checkpointClampedImageSchema = z.object({
  generationType: z.literal("image"),
  model: z.string().min(1),
  prompt: z.string().min(1),
  ratio: z.string(),
  quality: z.string(),
  units: z.number().int().min(1).max(10),
  size: z.string().min(1),
  references: z.array(z.object({
    assetVersionId: z.string().min(1),
    role: z.enum(GENERATION_REFERENCE_ROLES),
  }).strict()).max(4),
}).strict();

const checkpointRelayImageRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(10),
  size: z.string().min(1),
  response_format: z.literal("url"),
  image: z.array(z.string().min(1)).max(4).optional(),
}).strict();

const checkpointRelayImageResultSchema = z.object({
  created: z.number().int().nonnegative(),
  data: z.array(z.object({
    url: z.string().optional(),
    b64_json: z.string().optional(),
  // Provider-compatible responses may add metadata such as `size` or a
  // revised prompt. Persist only the URL/base64 allowlist; rejecting an
  // otherwise valid paid result here would strand a durable recovery after
  // the upstream charge has already settled.
  }).strip()).min(1).max(10),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    image_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).strip().optional(),
}).strip();

const checkpointProviderReadbackBindingSchema = z.object({
  contractVersion: z.literal(RELAY_IMAGE_PROVIDER_READBACK_PROOF_VERSION),
  provider: z.string().min(1),
  providerRequestId: z.string().min(1),
  model: z.string().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  adapterVersion: z.string().min(1),
  observedAt: z.number().int().nonnegative(),
  providerRecordId: z.string().min(1),
  providerDisposition: z.enum([
    "accepted_unknown",
    "definitively_not_accepted",
    "recovered_result",
  ]),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const checkpointProviderReadbackSettlementAuthorizationSchema = z.object({
  contractVersion: z.literal(
    RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_AUTHORIZATION_VERSION,
  ),
  policy: z.literal("authoritative_required"),
  readiness: z.literal("ready"),
  workspaceId: z.string().min(1),
  reservationId: z.string().min(1),
  usageRecordId: z.string().min(1),
  provider: z.string().min(1),
  channelId: z.string().min(1),
  providerRequestId: z.string().min(1),
  model: z.string().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  adapterVersion: z.string().min(1),
  billingKey: z.string().min(1),
  units: z.number().int().positive().max(10),
  unit: z.literal("image"),
  actualCostMicros: z.number().int().positive(),
}).strict();

const checkpointProviderReadbackSettlementProofSchema = z.object({
  contractVersion: z.literal(
    RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_PROOF_VERSION,
  ),
  authorizationContractVersion: z.literal(
    RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_AUTHORIZATION_VERSION,
  ),
  workspaceId: z.string().min(1),
  reservationId: z.string().min(1),
  usageRecordId: z.string().min(1),
  provider: z.string().min(1),
  channelId: z.string().min(1),
  providerRequestId: z.string().min(1),
  model: z.string().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  billingKey: z.string().min(1),
  units: z.number().int().positive().max(10),
  unit: z.literal("image"),
  actualCostMicros: z.number().int().positive(),
  captureLedgerId: z.string().min(1),
  idempotent: z.boolean(),
}).strict();

const checkpointProviderReadbackSchema = z.object({
  contractVersion: z.literal(RELAY_IMAGE_PROVIDER_READBACK_CONTRACT_VERSION),
  state: z.enum([
    "accepted_unknown",
    "definitively_not_accepted",
    "recovered_result",
    "unsupported",
  ]),
  provider: z.string().min(1),
  providerRequestId: z.string().min(1),
  model: z.string().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.number().int().nonnegative(),
  automaticRedispatchAllowed: z.literal(false),
  automaticReleaseAllowed: z.literal(false),
  reason: z.string().min(1).nullable(),
  adapterVersion: z.string().min(1).nullable(),
  binding: checkpointProviderReadbackBindingSchema.nullable(),
  result: checkpointRelayImageResultSchema.nullable(),
  settlementAuthorization:
    checkpointProviderReadbackSettlementAuthorizationSchema.nullable()
      .default(null),
  mayMaterializeAssets: z.boolean(),
  maySettleBilling: z.boolean(),
}).strict().superRefine((value, context) => {
  const recovered = value.state === "recovered_result";
  const authorized = recovered && Boolean(value.settlementAuthorization);
  if (
    recovered !== Boolean(value.result)
    || recovered !== Boolean(value.binding?.resultHash)
    || authorized !== value.mayMaterializeAssets
    || authorized !== value.maySettleBilling
    || recovered !== (value.reason === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "图片上游回查状态与恢复证据不一致",
    });
  }
  if (!recovered && value.settlementAuthorization !== null) {
    context.addIssue({
      code: "custom",
      message: "非恢复结果不得携带计费授权",
    });
  }
  const authorization = value.settlementAuthorization;
  if (
    authorization
    && (
      authorization.provider !== value.provider
      || authorization.providerRequestId !== value.providerRequestId
      || authorization.model !== value.model
      || authorization.requestHash !== value.requestHash
      || authorization.resultHash !== value.binding?.resultHash
      || authorization.adapterVersion !== value.adapterVersion
      || authorization.units !== value.result?.data.length
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "图片上游回查计费授权与恢复证据不一致",
    });
  }
  if (
    value.state === "unsupported"
    && (
      value.adapterVersion !== null
      || value.binding !== null
      || value.reason === null
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "图片上游未支持回查时不得携带适配器证明",
    });
  }
  if (
    value.binding
    && value.binding.providerDisposition !== value.state
  ) {
    context.addIssue({
      code: "custom",
      message: "图片上游回查证明与状态不一致",
    });
  }
  if (
    value.state === "definitively_not_accepted"
    && (!value.adapterVersion || !value.binding)
  ) {
    context.addIssue({
      code: "custom",
      message: "图片上游明确未接受结论缺少适配器证明",
    });
  }
});

type CheckpointProviderReadback = z.infer<
  typeof checkpointProviderReadbackSchema
>;

const checkpointProviderRecoverySchema = z.object({
  readback: checkpointProviderReadbackSchema,
  settlement: checkpointProviderReadbackSettlementProofSchema,
}).strict().superRefine((value, context) => {
  const authorization = value.readback.settlementAuthorization;
  if (
    value.readback.state !== "recovered_result"
    || !authorization
    || value.settlement.authorizationContractVersion
      !== authorization.contractVersion
    || value.settlement.workspaceId !== authorization.workspaceId
    || value.settlement.reservationId !== authorization.reservationId
    || value.settlement.usageRecordId !== authorization.usageRecordId
    || value.settlement.provider !== authorization.provider
    || value.settlement.channelId !== authorization.channelId
    || value.settlement.providerRequestId !== authorization.providerRequestId
    || value.settlement.model !== authorization.model
    || value.settlement.requestHash !== authorization.requestHash
    || value.settlement.resultHash !== authorization.resultHash
    || value.settlement.billingKey !== authorization.billingKey
    || value.settlement.units !== authorization.units
    || value.settlement.unit !== authorization.unit
    || value.settlement.actualCostMicros !== authorization.actualCostMicros
  ) {
    context.addIssue({
      code: "custom",
      message: "图片上游恢复结算证明与授权不一致",
    });
  }
});

function checkpointProviderReadback(
  outcome: RelayImageProviderReadbackOutcome,
): CheckpointProviderReadback {
  const parsed = checkpointProviderReadbackSchema.safeParse(outcome);
  if (parsed.success) return parsed.data;
  throw new DurableCommandIdempotencyError(
    500,
    "generation_image_readback_checkpoint_invalid",
    "图片上游回查结果不能写入恢复检查点",
  );
}

const checkpointMirroredAgentImageSchema = z.object({
  filePath: z.string().min(1),
  storageKey: z.string().min(1),
  url: z.string().min(1),
  writeIntentClaim: z.object({
    id: z.string().min(1),
    owner: z.string().min(1),
    fence: z.number().int().positive(),
  }).strict(),
}).strict();

const checkpointStagedAgentImageSchema = z.object({
  index: z.number().int().nonnegative(),
  url: z.string().min(1),
  mirrored: checkpointMirroredAgentImageSchema.nullable(),
}).strict();

const agentImageCommandCheckpointBaseSchema = z.object({
  version: z.literal(AGENT_IMAGE_COMMAND_VERSION),
  workspaceId: z.string().min(1),
  projectId: z.number().int().positive(),
  runId: z.string().min(1),
  actorUserId: z.number().int().positive(),
  quoteId: z.string().min(1),
  provider: z.string().min(1),
  operationStepId: z.string().min(1),
  taskId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  clamped: checkpointClampedImageSchema,
  providerRequest: checkpointRelayImageRequestSchema,
  bindingRetryAttempt: z.number().int().positive().optional(),
}).strict();

const agentImageCommandCheckpointSchema = z.discriminatedUnion("state", [
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("prepared"),
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("binding_retry_wait"),
    bindingRetryAttempt: z.number().int().positive(),
    bindingRetryAvailableAt: z.number().int().nonnegative(),
    bindingRetryCode: z.enum([PORTRAIT_PROVIDER_BINDING_PENDING_CODE, "WORKSPACE_GENERATION_QUEUED"]),
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("submitting"),
    dispatchClaimId: z.string().min(1),
    dispatchClaimedAt: z.number().int().nonnegative(),
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("readback_querying"),
    dispatchClaimId: z.string().min(1),
    dispatchClaimedAt: z.number().int().nonnegative(),
    readbackClaimId: z.string().min(1),
    readbackClaimedAt: z.number().int().nonnegative(),
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("pending_reconcile"),
    dispatchClaimId: z.string().min(1),
    dispatchClaimedAt: z.number().int().nonnegative(),
    readback: checkpointProviderReadbackSchema,
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("provider_recovered"),
    dispatchClaimId: z.string().min(1),
    dispatchClaimedAt: z.number().int().nonnegative(),
    readback: checkpointProviderReadbackSchema,
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("upstream_succeeded"),
    result: checkpointRelayImageResultSchema,
    providerRecovery: checkpointProviderRecoverySchema.optional(),
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("staging"),
    result: checkpointRelayImageResultSchema,
    providerRecovery: checkpointProviderRecoverySchema.optional(),
    stagingClaimId: z.string().min(1),
    stagingClaimedAt: z.number().int().nonnegative(),
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("staged"),
    result: checkpointRelayImageResultSchema,
    providerRecovery: checkpointProviderRecoverySchema.optional(),
    staged: z.array(checkpointStagedAgentImageSchema).min(1).max(10),
  }),
  agentImageCommandCheckpointBaseSchema.extend({
    state: z.literal("assets_persisted"),
    result: checkpointRelayImageResultSchema,
    providerRecovery: checkpointProviderRecoverySchema.optional(),
    staged: z.array(checkpointStagedAgentImageSchema).min(1).max(10),
    assets: z.array(generationSubmitAssetSchema).min(1).max(10),
  }),
]);

type AgentImageCommandCheckpoint =
  z.infer<typeof agentImageCommandCheckpointSchema>;

function parseAgentImageCommandCheckpoint(
  value: unknown,
): AgentImageCommandCheckpoint {
  const parsed = agentImageCommandCheckpointSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new DurableCommandIdempotencyError(
    500,
    "generation_image_checkpoint_invalid",
    "图片生成命令的恢复检查点无效",
  );
}

function assertAgentImageCommandScope(input: {
  checkpoint: AgentImageCommandCheckpoint;
  context: AgentToolAuthorizationContext;
  quoteId: string;
  provider: string;
}): void {
  const checkpoint = input.checkpoint;
  if (
    checkpoint.workspaceId !== input.context.workspaceId
    || checkpoint.projectId !== input.context.projectId
    || checkpoint.runId !== input.context.runId
    || checkpoint.actorUserId !== input.context.actorUserId
    || checkpoint.quoteId !== input.quoteId
    || checkpoint.provider !== input.provider
  ) {
    throw new DurableCommandIdempotencyError(
      409,
      "generation_image_scope_conflict",
      "图片生成命令的项目、工作区或报价范围不一致",
    );
  }
}

function agentImageProviderRequestId(quoteId: string): string {
  return `agent-image:${quoteId}`;
}

function agentImagePendingReconcileError(
  outcome: Pick<CheckpointProviderReadback, "state">,
): DurableCommandIdempotencyError {
  const message = outcome.state === "recovered_result"
    ? "图片上游结果已按请求标识恢复，但计费与资产回填尚未闭合，禁止重复派发"
    : outcome.state === "definitively_not_accepted"
      ? "图片上游回查确认未接受请求，仍需完成独立计费核账后才能关闭"
      : "图片上游请求结果无法确认，已转入待核账且禁止重复派发或自动释放";
  return new DurableCommandIdempotencyError(
    409,
    "generation_image_pending_reconcile",
    message,
  );
}

function agentImagePortraitBindingPendingError(
  retryAvailableAt: number,
  code: string = PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
): DurableCommandIdempotencyError {
  const retryAfterMs = Math.max(0, retryAvailableAt - Date.now());
  return new DurableCommandIdempotencyError(
    409,
    code,
    code === "WORKSPACE_GENERATION_QUEUED" ? "工作区生成名额已满，任务排队中，将自动继续" : retryAfterMs > 0
      ? `图片参考的人像资产正在准备，请在 ${Math.ceil(retryAfterMs / 1_000)} 秒后重试同一报价`
      : "图片参考的人像资产正在准备，请重试同一报价",
  );
}

type AgentImageReadbackMutation =
  | { kind: "replay"; output: GenerationImageSubmitOutput }
  | {
      kind: "pending";
      reservation: DurableCommandReservation<GenerationImageSubmitOutput>;
      checkpoint: AgentImageCommandCheckpoint;
      outcome: CheckpointProviderReadback;
    }
  | {
      kind: "recovered";
      reservation: DurableCommandReservation<GenerationImageSubmitOutput>;
      checkpoint: Extract<
        AgentImageCommandCheckpoint,
        { state: "provider_recovered" }
      >;
    };

async function checkpointAgentImageProviderReadback(input: {
  reservation: DurableCommandReservation<GenerationImageSubmitOutput>;
  checkpoint: AgentImageCommandCheckpoint;
  context: AgentToolAuthorizationContext;
  quoteId: string;
  provider: string;
  durableDatabase: Knex;
}): Promise<AgentImageReadbackMutation> {
  if (input.checkpoint.state === "pending_reconcile") {
    return {
      kind: "pending",
      reservation: input.reservation,
      checkpoint: input.checkpoint,
      outcome: input.checkpoint.readback,
    };
  }
  if (input.checkpoint.state === "provider_recovered") {
    return {
      kind: "recovered",
      reservation: input.reservation,
      checkpoint: input.checkpoint,
    };
  }
  if (
    input.checkpoint.state !== "submitting"
    && input.checkpoint.state !== "readback_querying"
  ) {
    throw new DurableCommandIdempotencyError(
      409,
      "generation_image_readback_state_conflict",
      "图片生成命令尚未进入可回查的上游状态",
    );
  }
  const dispatchClaimId = input.checkpoint.dispatchClaimId;
  const providerRequestId = agentImageProviderRequestId(
    input.checkpoint.quoteId,
  );
  let reservation = input.reservation;
  let checkpoint: AgentImageCommandCheckpoint = input.checkpoint;
  let ownedReadbackClaimId: string | null = null;

  const claimReadback = async (): Promise<{
    reservation: DurableCommandReservation<GenerationImageSubmitOutput>;
    checkpoint: AgentImageCommandCheckpoint;
  }> => {
    const claimId = uuid();
    const advanced = await mutateDurableCommandCheckpoint<
      GenerationImageSubmitOutput,
      AgentImageCommandCheckpoint
    >(reservation, (rawCheckpoint) => {
      const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
      assertAgentImageCommandScope({
        checkpoint: current,
        context: input.context,
        quoteId: input.quoteId,
        provider: input.provider,
      });
      if (
        current.state === "submitting"
        && current.dispatchClaimId === dispatchClaimId
      ) {
        ownedReadbackClaimId = claimId;
        return {
          ...current,
          state: "readback_querying",
          readbackClaimId: claimId,
          readbackClaimedAt: Date.now(),
        };
      }
      if (
        current.state === "readback_querying"
        && current.dispatchClaimId === dispatchClaimId
        && current.readbackClaimedAt
          <= Date.now() - agentImageReadbackAfterMs()
      ) {
        ownedReadbackClaimId = claimId;
        return {
          ...current,
          readbackClaimId: claimId,
          readbackClaimedAt: Date.now(),
        };
      }
      return current;
    }, { database: input.durableDatabase });
    if (advanced.kind === "replay") {
      throw new DurableCommandIdempotencyError(
        409,
        "generation_image_readback_state_conflict",
        "图片生成命令已由其他恢复流程完成",
      );
    }
    return {
      reservation: advanced,
      checkpoint: parseAgentImageCommandCheckpoint(advanced.checkpoint),
    };
  };

  if (checkpoint.state === "submitting") {
    const claimed = await claimReadback();
    reservation = claimed.reservation;
    checkpoint = claimed.checkpoint;
  }
  if (
    checkpoint.state === "readback_querying"
    && !ownedReadbackClaimId
    && checkpoint.readbackClaimedAt
      <= Date.now() - agentImageReadbackAfterMs()
  ) {
    const claimed = await claimReadback();
    reservation = claimed.reservation;
    checkpoint = claimed.checkpoint;
  }
  if (checkpoint.state === "pending_reconcile") {
    return {
      kind: "pending",
      reservation,
      checkpoint,
      outcome: checkpoint.readback,
    };
  }
  if (checkpoint.state === "provider_recovered") {
    return { kind: "recovered", reservation, checkpoint };
  }
  if (
    checkpoint.state !== "readback_querying"
    || !ownedReadbackClaimId
    || checkpoint.readbackClaimId !== ownedReadbackClaimId
  ) {
    throw new DurableCommandIdempotencyError(
      409,
      "idempotency_in_progress",
      "相同图片生成请求正在执行权威上游回查，请稍后刷新",
    );
  }

  const outcome = await readRelayImageProviderResult({
    provider: checkpoint.provider,
    providerRequestId,
    request: checkpoint.providerRequest,
    expectedCount: checkpoint.clamped.units,
    production: { database: input.durableDatabase },
  });
  const readback = checkpointProviderReadback(outcome);
  if (
    readback.provider !== checkpoint.provider
    || readback.providerRequestId !== providerRequestId
    || readback.model !== checkpoint.clamped.model
    || readback.requestHash
      !== relayImageProviderRequestHash(checkpoint.providerRequest)
  ) {
    throw new DurableCommandIdempotencyError(
      409,
      "generation_image_readback_binding_conflict",
      "图片上游回查结果与原始派发请求不一致",
    );
  }
  const advanced = await mutateDurableCommandCheckpoint<
    GenerationImageSubmitOutput,
    AgentImageCommandCheckpoint
  >(reservation, (rawCheckpoint) => {
    const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
    assertAgentImageCommandScope({
      checkpoint: current,
      context: input.context,
      quoteId: input.quoteId,
      provider: input.provider,
    });
    if (
      current.state === "pending_reconcile"
      || current.state === "provider_recovered"
    ) {
      return current;
    }
    if (
      current.state !== "readback_querying"
      || current.dispatchClaimId !== dispatchClaimId
      || current.readbackClaimId !== ownedReadbackClaimId
      || relayImageProviderRequestHash(current.providerRequest)
        !== readback.requestHash
    ) {
      throw new DurableCommandIdempotencyError(
        409,
        "generation_image_readback_binding_conflict",
        "图片生成命令的派发归属或请求摘要已变化",
      );
    }
    if (
      readback.state === "recovered_result"
      && readback.settlementAuthorization
      && readback.mayMaterializeAssets
      && readback.maySettleBilling
    ) {
      const {
        readbackClaimId: _readbackClaimId,
        readbackClaimedAt: _readbackClaimedAt,
        ...dispatchCheckpoint
      } = current;
      return {
        ...dispatchCheckpoint,
        state: "provider_recovered",
        readback,
      };
    }
    const {
      readbackClaimId: _readbackClaimId,
      readbackClaimedAt: _readbackClaimedAt,
      ...dispatchCheckpoint
    } = current;
    return { ...dispatchCheckpoint, state: "pending_reconcile", readback };
  }, { database: input.durableDatabase });
  if (advanced.kind === "replay") {
    return {
      kind: "replay",
      output: parseAgentImageReplayOutput(advanced.responseBody),
    };
  }
  const advancedCheckpoint = parseAgentImageCommandCheckpoint(
    advanced.checkpoint,
  );
  if (advancedCheckpoint.state === "provider_recovered") {
    throwAgentImageTestCrash("after_readback_checkpoint");
    return {
      kind: "recovered",
      reservation: advanced,
      checkpoint: advancedCheckpoint,
    };
  }
  if (advancedCheckpoint.state !== "pending_reconcile") {
    throw new DurableCommandIdempotencyError(
      409,
      "generation_image_readback_state_conflict",
      "图片生成命令已由其他恢复流程推进",
    );
  }
  return {
    kind: "pending",
    reservation: advanced,
    checkpoint: advancedCheckpoint,
    outcome: advancedCheckpoint.readback,
  };
}

type AgentImageRecoveredSettlementMutation =
  | { kind: "replay"; output: GenerationImageSubmitOutput }
  | {
      kind: "advanced";
      reservation: DurableCommandReservation<GenerationImageSubmitOutput>;
      checkpoint: AgentImageCommandCheckpoint;
    };

function relayReadbackOutcomeFromCheckpoint(
  readback: CheckpointProviderReadback,
): RelayImageProviderReadbackOutcome {
  // The strict checkpoint schema and its cross-field superRefine implement
  // the same discriminants as RelayImageProviderReadbackOutcome. Reparse at
  // this trust boundary so a legacy/manual JSON edit cannot gain authority.
  const parsed: unknown = checkpointProviderReadbackSchema.parse(readback);
  return parsed as RelayImageProviderReadbackOutcome;
}

async function settleCheckpointedAgentImageProviderRecovery(input: {
  reservation: DurableCommandReservation<GenerationImageSubmitOutput>;
  checkpoint: Extract<
    AgentImageCommandCheckpoint,
    { state: "provider_recovered" }
  >;
  context: AgentToolAuthorizationContext;
  quoteId: string;
  provider: string;
  durableDatabase: Knex;
}): Promise<AgentImageRecoveredSettlementMutation> {
  const readback = relayReadbackOutcomeFromCheckpoint(
    input.checkpoint.readback,
  );
  if (
    readback.state !== "recovered_result"
    || !readback.settlementAuthorization
  ) {
    throw new DurableCommandIdempotencyError(
      409,
      "generation_image_recovery_authorization_invalid",
      "图片上游恢复检查点缺少权威计费授权",
    );
  }
  const settlement = await settleRecoveredRelayImageProviderResult(readback);
  const recovery = checkpointProviderRecoverySchema.parse({
    readback: input.checkpoint.readback,
    settlement,
  });
  throwAgentImageTestCrash("after_readback_settlement");

  const advanced = await mutateDurableCommandCheckpoint<
    GenerationImageSubmitOutput,
    AgentImageCommandCheckpoint
  >(input.reservation, (rawCheckpoint) => {
    const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
    assertAgentImageCommandScope({
      checkpoint: current,
      context: input.context,
      quoteId: input.quoteId,
      provider: input.provider,
    });
    if (
      current.state === "upstream_succeeded"
      || current.state === "staging"
      || current.state === "staged"
      || current.state === "assets_persisted"
    ) {
      return current;
    }
    if (
      current.state !== "provider_recovered"
      || current.readback.requestHash !== recovery.readback.requestHash
      || current.readback.binding?.resultHash
        !== recovery.readback.binding?.resultHash
      || current.readback.settlementAuthorization?.reservationId
        !== recovery.settlement.reservationId
    ) {
      throw new DurableCommandIdempotencyError(
        409,
        "generation_image_recovery_settlement_conflict",
        "图片上游恢复检查点在结算期间发生变化",
      );
    }
    const result = current.readback.result;
    if (!result) {
      throw new DurableCommandIdempotencyError(
        500,
        "generation_image_recovery_result_missing",
        "图片上游恢复检查点缺少可写入结果",
      );
    }
    return {
      version: current.version,
      state: "upstream_succeeded",
      workspaceId: current.workspaceId,
      projectId: current.projectId,
      runId: current.runId,
      actorUserId: current.actorUserId,
      quoteId: current.quoteId,
      provider: current.provider,
      operationStepId: current.operationStepId,
      taskId: current.taskId,
      createdAt: current.createdAt,
      clamped: current.clamped,
      providerRequest: current.providerRequest,
      result,
      providerRecovery: recovery,
    };
  }, { database: input.durableDatabase });
  if (advanced.kind === "replay") {
    return {
      kind: "replay",
      output: parseAgentImageReplayOutput(advanced.responseBody),
    };
  }
  return {
    kind: "advanced",
    reservation: advanced,
    checkpoint: parseAgentImageCommandCheckpoint(advanced.checkpoint),
  };
}

function parseAgentImageReplayOutput(
  value: unknown,
): GenerationImageSubmitOutput {
  const parsed = generationImageSubmitOutputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new DurableCommandIdempotencyError(
    500,
    "generation_image_replay_invalid",
    "图片生成命令缺少可重放结果",
  );
}

function agentImagePersistenceError(
  primary: unknown,
  queueFailures: unknown[],
): Error & { code: string; cause?: unknown; queueFailures?: unknown[] } {
  const error = queueFailures.length > 0
    ? new AggregateError(
      [primary, ...queueFailures],
      "agent image DB write failed and durable compensation could not be fully queued",
    )
    : new Error("agent image DB write failed; durable compensation is queued");
  return Object.assign(error, {
    code: "agent_image_persistence_failed",
    cause: primary,
    ...(queueFailures.length > 0 ? { queueFailures } : {}),
  });
}

async function queueStagedAgentImageCompensations(
  stagedImages: StagedAgentImage[],
  primary: unknown,
  durableDatabase: Knex,
): Promise<unknown[]> {
  const queueFailures: unknown[] = [];
  for (const staged of stagedImages) {
    if (!staged.mirrored) continue;
    try {
      await queueDurableObjectWriteCompensation(
        staged.mirrored.writeIntentClaim,
        primary,
        { database: durableDatabase },
      );
    } catch (queueError) {
      queueFailures.push(queueError);
    }
  }
  return queueFailures;
}

async function persistAgentImageResultsInTransaction(input: {
  transaction: Knex.Transaction;
  workspaceId: string;
  projectId: number;
  runId: string;
  stepId: string;
  now: number;
  taskId: string;
  quoteId: string;
  clamped: ClampedImageSubmitRequest;
  staged: StagedAgentImage[];
}): Promise<GenerationImageSubmitOutput["assets"]> {
  const project = await input.transaction("o_project")
    .where({ id: input.projectId })
    .select("id", "workspaceId", "deletionState")
    .forUpdate()
    .first();
  if (
    !project
    || String(project.workspaceId || "") !== input.workspaceId
    || String(project.deletionState || "active") !== "active"
  ) {
    throw Object.assign(
      new Error("agent image project scope is no longer active"),
      { code: "agent_image_persistence_failed" },
    );
  }

  const assets: GenerationImageSubmitOutput["assets"] = [];
  for (const staged of input.staged) {
    const baseMetadata = {
      prompt: input.clamped.prompt,
      model: input.clamped.model,
      ratio: input.clamped.ratio,
      quality: input.clamped.quality,
      size: input.clamped.size,
      index: staged.index,
      quoteId: input.quoteId,
      runId: input.runId,
      stepId: input.stepId,
      mirrored: Boolean(staged.mirrored),
    };
    const mediaAssetId = uuid();
    await input.transaction("o_media_asset").insert({
      id: mediaAssetId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetType: "image",
      source: "agent",
      url: staged.url,
      localPath: staged.mirrored?.filePath ?? null,
      storageKey: staged.mirrored?.storageKey ?? null,
      mimeType: "image/png",
      width: null,
      height: null,
      durationMs: null,
      metadata: JSON.stringify(baseMetadata),
      createTime: input.now + staged.index,
    });
    const assetId = await insertAndReturnId(input.transaction, "o_assets", {
      type: "image",
      projectId: input.projectId,
      name: input.clamped.prompt.slice(0, 80),
      prompt: input.clamped.prompt,
      startTime: input.now + staged.index,
    });
    const assetVersionId = await insertAndReturnId(
      input.transaction,
      "o_image",
      {
        filePath: staged.mirrored?.filePath ?? staged.url,
        storageKey: staged.mirrored?.storageKey ?? null,
        type: "image",
        assetsId: assetId,
        model: input.clamped.model,
        resolution: input.clamped.size,
        state: "已完成",
      },
    );
    await input.transaction("o_assets")
      .where({ id: assetId })
      .update({ imageId: assetVersionId });
    await input.transaction("o_media_asset")
      .where({ id: mediaAssetId })
      .update({
        metadata: JSON.stringify({
          ...baseMetadata,
          assetId,
          assetVersionId,
        }),
      });
    if (staged.mirrored) {
      await commitObjectWriteIntentInTransaction(
        input.transaction,
        staged.mirrored.writeIntentClaim,
        {
          version: "object-write-reference.v1",
          table: "o_media_asset",
          rowId: mediaAssetId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          storageKey: staged.mirrored.storageKey,
        },
      );
    }
    assets.push({
      mediaAssetId,
      assetId,
      assetVersionId,
      url: staged.url,
      mirrored: Boolean(staged.mirrored),
    });
    if (assets.length === 1) {
      throwAgentImageTestCrash("inside_asset_transaction");
    }
  }
  return assets;
}

// ─── GENERATION_IMAGE_SUBMIT_TOOL ────────────────────────────────────────────

export const GENERATION_IMAGE_SUBMIT_TOOL = defineAgentTool({
  manifest: {
    name: "generation.image.submit",
    version: "1.0.0",
    displayName: "提交图片生成",
    description: "提交一个待确认的图片生成提案(R2,需用户批准报价后才真实执行,成功后写入项目资产库)。"
      + "正例:用户说「生成一张 16:9 的 2K 海报」且你已准备好模型与提示词;"
      + "负例:只想询价时不要调用(改用 generation.quote);要生成视频时不要调用(改用 generation.video.submit);"
      + "不要在用户尚未批准报价前期待图片已经生成;显式比例/清晰度不在模型能力内时请求会被拒绝，不会静默降级。",
    riskClass: "R2",
    availability: { state: "available", sincePhase: "A3" },
    requiredPermissions: ["project:read", "generation:create"],
    resourceTypes: ["generation_quote", "generation_task", "media_asset", "asset", "provider_route", "pricing_rule"],
    mutatesState: true,
    metered: true,
  },
  inputSchema: generationImageSubmitInputSchema,
  outputSchema: generationImageSubmitOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const capability = await requireSubmittableCapability(context.database, context.workspaceId, "image_generation", input.model);
    const clamped = clampImageSubmitRequest(input, capability);
    const phase = await detectSubmitEvidencePhase(context);
    assertImageGenerationPreferences(clamped, context, phase);
    const referenceContent = await resolveAgentGenerationReferenceContent({ context, references: clamped.references });
    imageReferenceUrls(referenceContent.providerContent);
    const evidence = await resolveSubmitAuthorizationEvidence("image", "generation.image.submit", clamped, input, context);
    return { ...evidence, resourceRefs: referenceResourceEvidence(clamped.references) };
  },
  async execute(input, context): Promise<GenerationImageSubmitOutput> {
    if (!isAgentGenerationSubmitEnabled()) return unavailableImageOutput(input);
    const located = await locateApprovalAnchoredQuote(context, "generation.image.submit", input);
    if (!context.durableDatabase) {
      return {
        status: "failed",
        code: "image_persistence_failed",
        message: "图片持久化服务尚未就绪",
        generationType: "image",
        quoteId: located.quoteId,
        provider: located.provider,
        model: input.model,
        units: input.units,
        size: null,
        assets: [],
        review: null,
      };
    }
    const durableDatabase = context.durableDatabase;
    let reservation = await beginDurableCommand<GenerationImageSubmitOutput>({
      database: durableDatabase,
      workspaceId: context.workspaceId,
      actorUserId: context.actorUserId,
      scope: AGENT_IMAGE_COMMAND_SCOPE,
      idempotencyKey: located.quoteId,
      request: {
        version: AGENT_IMAGE_COMMAND_VERSION,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        runId: context.runId,
        actorUserId: context.actorUserId,
        quoteId: located.quoteId,
        arguments: input,
      },
    });
    if (reservation.kind === "replay") {
      return parseAgentImageReplayOutput(reservation.responseBody);
    }
    if (reservation.kind === "disabled") {
      throw new DurableCommandIdempotencyError(
        500,
        "generation_image_idempotency_disabled",
        "图片生成命令未建立稳定幂等键",
      );
    }

    let checkpoint: AgentImageCommandCheckpoint;
    if (reservation.kind === "reserved") {
      try {
        const capability = await requireSubmittableCapability(
          context.database,
          context.workspaceId,
          "image_generation",
          input.model,
        );
        const clamped = clampImageSubmitRequest(input, capability);
        const referenceContent = await resolveAgentGenerationReferenceContent({
          context,
          references: clamped.references,
        });
        const referenceUrls = imageReferenceUrls(referenceContent.providerContent);
        const verified = await verifyAgentGenerationQuoteForExecution({
          database: context.database,
          quoteId: located.quoteId,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          runId: context.runId,
          expected: {
            generationType: "image",
            provider: located.provider,
            model: clamped.model,
            units: clamped.units,
          },
          now: context.now,
        });
        const providerRequest: RelayImageRequest = {
          model: clamped.model,
          prompt: clamped.prompt,
          n: clamped.units,
          size: clamped.size,
          response_format: "url",
          ...(referenceUrls.length ? { image: referenceUrls } : {}),
        };
        checkpoint = parseAgentImageCommandCheckpoint({
          version: AGENT_IMAGE_COMMAND_VERSION,
          state: "prepared",
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          runId: context.runId,
          actorUserId: context.actorUserId,
          quoteId: verified.quote.quoteId,
          provider: verified.quote.provider,
          operationStepId: context.stepId,
          taskId: `agent-image:${verified.quote.quoteId}`,
          createdAt: context.now,
          clamped,
          providerRequest,
        });
        reservation = await checkpointDurableCommand<
          GenerationImageSubmitOutput,
          AgentImageCommandCheckpoint
        >(reservation, checkpoint, { database: durableDatabase });
      } catch (error) {
        await abandonDurableCommand(reservation, {
          database: durableDatabase,
        }).catch(() => undefined);
        throw error;
      }
    } else {
      checkpoint = parseAgentImageCommandCheckpoint(reservation.checkpoint);
    }
    assertAgentImageCommandScope({
      checkpoint,
      context,
      quoteId: located.quoteId,
      provider: located.provider,
    });
    assertImageGenerationPreferences(checkpoint.clamped, context, "execute");

    const failureBase = {
      generationType: "image" as const,
      quoteId: checkpoint.quoteId,
      provider: checkpoint.provider,
      model: checkpoint.clamped.model,
      units: checkpoint.clamped.units,
      size: checkpoint.clamped.size,
      assets: [] as GenerationImageSubmitOutput["assets"],
      review: null as GenerationSubmitReviewSummary,
    };
    const completeOutput = async (
      output: GenerationImageSubmitOutput,
    ): Promise<GenerationImageSubmitOutput> => {
      await completeDurableCommand(reservation, output, 200, {
        database: durableDatabase,
      });
      throwAgentImageTestCrash("after_completion");
      return output;
    };

    throwAgentImageTestCrash("after_prepared_checkpoint");

    let ownedDispatchClaimId: string | null = null;
    if (
      checkpoint.state === "binding_retry_wait"
      && checkpoint.bindingRetryAvailableAt > Date.now()
    ) {
      throw agentImagePortraitBindingPendingError(
        checkpoint.bindingRetryAvailableAt, checkpoint.bindingRetryCode,
      );
    }
    if (
      checkpoint.state === "prepared"
      || checkpoint.state === "binding_retry_wait"
    ) {
      const claimId = uuid();
      const advanced = await mutateDurableCommandCheckpoint<
        GenerationImageSubmitOutput,
        AgentImageCommandCheckpoint
      >(reservation, (rawCheckpoint) => {
        const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
        assertAgentImageCommandScope({
          checkpoint: current,
          context,
          quoteId: located.quoteId,
          provider: located.provider,
        });
        if (current.state === "prepared") {
          ownedDispatchClaimId = claimId;
          return {
            ...current,
            state: "submitting",
            dispatchClaimId: claimId,
            dispatchClaimedAt: Date.now(),
          };
        }
        if (current.state === "binding_retry_wait") {
          if (current.bindingRetryAvailableAt > Date.now()) {
            throw agentImagePortraitBindingPendingError(
              current.bindingRetryAvailableAt, current.bindingRetryCode,
            );
          }
          const {
            bindingRetryAvailableAt: _bindingRetryAvailableAt,
            bindingRetryCode: _bindingRetryCode,
            ...retryable
          } = current;
          ownedDispatchClaimId = claimId;
          return {
            ...retryable,
            state: "submitting",
            dispatchClaimId: claimId,
            dispatchClaimedAt: Date.now(),
          };
        }
        if (current.state === "submitting") {
          throw new DurableCommandIdempotencyError(
            409,
            "idempotency_in_progress",
            "相同图片生成请求正在调用上游，请稍后刷新",
          );
        }
        return current;
      }, { database: durableDatabase });
      if (advanced.kind === "replay") {
        return parseAgentImageReplayOutput(advanced.responseBody);
      }
      reservation = advanced;
      checkpoint = parseAgentImageCommandCheckpoint(advanced.checkpoint);
    }

    if (
      checkpoint.state === "pending_reconcile"
      || checkpoint.state === "readback_querying"
    ) {
      const readback = await checkpointAgentImageProviderReadback({
        reservation,
        checkpoint,
        context,
        quoteId: located.quoteId,
        provider: located.provider,
        durableDatabase,
      });
      if (readback.kind === "replay") return readback.output;
      reservation = readback.reservation;
      checkpoint = readback.checkpoint;
      if (readback.kind === "pending") {
        throw agentImagePendingReconcileError(readback.outcome);
      }
    }

    if (checkpoint.state === "provider_recovered") {
      const settled = await settleCheckpointedAgentImageProviderRecovery({
        reservation,
        checkpoint,
        context,
        quoteId: located.quoteId,
        provider: located.provider,
        durableDatabase,
      });
      if (settled.kind === "replay") return settled.output;
      reservation = settled.reservation;
      checkpoint = settled.checkpoint;
      throwAgentImageTestCrash("after_upstream_checkpoint");
    }

    if (
      checkpoint.state === "submitting"
      && (
        !ownedDispatchClaimId
        || checkpoint.dispatchClaimId !== ownedDispatchClaimId
      )
    ) {
      if (
        checkpoint.dispatchClaimedAt
        <= Date.now() - agentImageReadbackAfterMs()
      ) {
        const readback = await checkpointAgentImageProviderReadback({
          reservation,
          checkpoint,
          context,
          quoteId: located.quoteId,
          provider: located.provider,
          durableDatabase,
        });
        if (readback.kind === "replay") return readback.output;
        reservation = readback.reservation;
        checkpoint = readback.checkpoint;
        if (readback.kind === "pending") {
          throw agentImagePendingReconcileError(readback.outcome);
        }
      } else {
        throw new DurableCommandIdempotencyError(
          409,
          "idempotency_in_progress",
          "该图片生成请求已进入上游调用，正在等待结果或人工核对",
        );
      }
    }

    if (checkpoint.state === "provider_recovered") {
      const settled = await settleCheckpointedAgentImageProviderRecovery({
        reservation,
        checkpoint,
        context,
        quoteId: located.quoteId,
        provider: located.provider,
        durableDatabase,
      });
      if (settled.kind === "replay") return settled.output;
      reservation = settled.reservation;
      checkpoint = settled.checkpoint;
      throwAgentImageTestCrash("after_upstream_checkpoint");
    }

    if (checkpoint.state === "submitting") {
      let result: RelayImageResult | null = null;
      let pendingProviderRequestCheckpoint: {
        reservation: DurableCommandReservation<GenerationImageSubmitOutput>;
        checkpoint: AgentImageCommandCheckpoint;
      } | null = null;
      try {
        // quoteId 同时固定 provider requestId 与计费 Idempotency-Key。
        // Gateway 事务/Step 回滚后即使分配了新 stepId，也不能产生第二次
        // 上游调用或第二笔 GU 预扣。
        result = await executeRelayImage(checkpoint.providerRequest, {
          workspaceId: checkpoint.workspaceId,
          apiKeyId: null,
          principalId: `agent:${checkpoint.actorUserId}`,
          provider: checkpoint.provider,
          requestId: agentImageProviderRequestId(checkpoint.quoteId),
          idempotencyKey: `agent-image-submit:${checkpoint.quoteId}`,
          database: context.database,
          ...(checkpoint.clamped.references.length
            ? {
                portraitReferenceScope: {
                  projectId: String(checkpoint.projectId),
                  orderedAssetVersionIds: checkpoint.clamped.references.map(
                    (reference) => String(reference.assetVersionId),
                  ),
                  requiresPortraitAdmission: false,
                },
                // Persist the exact URL/Base64 image wire request in the same
                // transaction as the billing dispatch fence. Managed portrait
                // references fail closed before this hook because the image
                // provider protocol does not publish asset:// support.
                onBeforeProviderDispatchCommit: async (
                  _boundary,
                  transaction,
                  providerRequest,
                ) => {
                  if (!providerRequest) {
                    throw new DurableCommandIdempotencyError(
                      500,
                      "generation_image_dispatch_request_missing",
                      "图片生成命令缺少实际供应商请求",
                    );
                  }
                  const advanced = await mutateDurableCommandCheckpoint<
                    GenerationImageSubmitOutput,
                    AgentImageCommandCheckpoint
                  >(reservation, (rawCheckpoint) => {
                    const current = parseAgentImageCommandCheckpoint(
                      rawCheckpoint,
                    );
                    assertAgentImageCommandScope({
                      checkpoint: current,
                      context,
                      quoteId: located.quoteId,
                      provider: located.provider,
                    });
                    if (
                      current.state !== "submitting"
                      || current.dispatchClaimId !== ownedDispatchClaimId
                    ) {
                      throw new DurableCommandIdempotencyError(
                        409,
                        "generation_image_dispatch_conflict",
                        "图片生成命令的上游调用归属已变化",
                      );
                    }
                    return parseAgentImageCommandCheckpoint({
                      ...current,
                      providerRequest,
                    });
                  }, { database: transaction });
                  if (advanced.kind === "replay") {
                    throw new DurableCommandIdempotencyError(
                      409,
                      "generation_image_dispatch_conflict",
                      "图片生成命令已由其他请求完成",
                    );
                  }
                  pendingProviderRequestCheckpoint = {
                    reservation: advanced,
                    checkpoint: parseAgentImageCommandCheckpoint(
                      advanced.checkpoint,
                    ),
                  };
                },
                onProviderDispatchCommitted: () => {
                  if (!pendingProviderRequestCheckpoint) return;
                  reservation = pendingProviderRequestCheckpoint.reservation;
                  checkpoint = pendingProviderRequestCheckpoint.checkpoint;
                  pendingProviderRequestCheckpoint = null;
                },
              }
            : {}),
        });
      } catch (error) {
        if (error instanceof WorkspaceGenerationQueued || isRetryablePortraitProviderBindingPending(error)) {
          const schedule = portraitProviderBindingRetrySchedule({
            previousAttempt: checkpoint.bindingRetryAttempt || 0,
          });
          const advanced = await mutateDurableCommandCheckpoint<
            GenerationImageSubmitOutput,
            AgentImageCommandCheckpoint
          >(reservation, (rawCheckpoint) => {
            const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
            assertAgentImageCommandScope({
              checkpoint: current,
              context,
              quoteId: located.quoteId,
              provider: located.provider,
            });
            if (
              current.state === "binding_retry_wait"
              && current.bindingRetryAttempt >= schedule.attempt
            ) {
              return current;
            }
            if (
              current.state !== "submitting"
              || current.dispatchClaimId !== ownedDispatchClaimId
            ) {
              throw new DurableCommandIdempotencyError(
                409,
                "generation_image_dispatch_conflict",
                "图片生成命令的人像资产等待状态已变化",
              );
            }
            const {
              dispatchClaimId: _dispatchClaimId,
              dispatchClaimedAt: _dispatchClaimedAt,
              ...retryable
            } = current;
            return {
              ...retryable,
              state: "binding_retry_wait",
              bindingRetryAttempt: schedule.attempt,
              bindingRetryAvailableAt: schedule.retryAvailableAt,
              bindingRetryCode: error instanceof WorkspaceGenerationQueued ? "WORKSPACE_GENERATION_QUEUED" : PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
            };
          }, { database: durableDatabase });
          if (advanced.kind === "replay") {
            return parseAgentImageReplayOutput(advanced.responseBody);
          }
          reservation = advanced;
          checkpoint = parseAgentImageCommandCheckpoint(advanced.checkpoint);
          if (checkpoint.state !== "binding_retry_wait") {
            throw new DurableCommandIdempotencyError(
              409,
              "generation_image_dispatch_conflict",
              "图片生成命令未能进入人像资产等待队列",
            );
          }
          throw agentImagePortraitBindingPendingError(
            checkpoint.bindingRetryAvailableAt, checkpoint.bindingRetryCode,
          );
        }
        if (
          error instanceof RelayImageError
          && error.upstreamMayHaveAccepted !== false
        ) {
          const readback = await checkpointAgentImageProviderReadback({
            reservation,
            checkpoint,
            context,
            quoteId: located.quoteId,
            provider: located.provider,
            durableDatabase,
          });
          if (readback.kind === "replay") return readback.output;
          reservation = readback.reservation;
          checkpoint = readback.checkpoint;
          if (readback.kind === "pending") {
            throw agentImagePendingReconcileError(readback.outcome);
          }
          if (checkpoint.state === "provider_recovered") {
            const settled = await settleCheckpointedAgentImageProviderRecovery({
              reservation,
              checkpoint,
              context,
              quoteId: located.quoteId,
              provider: located.provider,
              durableDatabase,
            });
            if (settled.kind === "replay") return settled.output;
            reservation = settled.reservation;
            checkpoint = settled.checkpoint;
            throwAgentImageTestCrash("after_upstream_checkpoint");
            if (
              checkpoint.state === "upstream_succeeded"
              || checkpoint.state === "staging"
              || checkpoint.state === "staged"
              || checkpoint.state === "assets_persisted"
            ) {
              result = checkpoint.result;
            }
          }
        }
        if (!result) {
          const failure = publicSubmitFailure(error);
          return completeOutput({
            status: "failed",
            code: failure.code,
            message: failure.message,
            ...failureBase,
          });
        }
      }
      if (!result) {
        throw new DurableCommandIdempotencyError(
          500,
          "generation_image_result_missing",
          "图片生成命令缺少可继续写入的上游结果",
        );
      }
      const advanced = await mutateDurableCommandCheckpoint<
        GenerationImageSubmitOutput,
        AgentImageCommandCheckpoint
      >(reservation, (rawCheckpoint) => {
        const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
        assertAgentImageCommandScope({
          checkpoint: current,
          context,
          quoteId: located.quoteId,
          provider: located.provider,
        });
        if (
          current.state === "submitting"
          && current.dispatchClaimId === ownedDispatchClaimId
        ) {
          return {
            version: current.version,
            state: "upstream_succeeded",
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            runId: current.runId,
            actorUserId: current.actorUserId,
            quoteId: current.quoteId,
            provider: current.provider,
            operationStepId: current.operationStepId,
            taskId: current.taskId,
            createdAt: current.createdAt,
            clamped: current.clamped,
            providerRequest: current.providerRequest,
            result,
          };
        }
        if (
          current.state === "upstream_succeeded"
          || current.state === "staging"
          || current.state === "staged"
          || current.state === "assets_persisted"
        ) {
          return current;
        }
        throw new DurableCommandIdempotencyError(
          409,
          "generation_image_dispatch_conflict",
          "图片生成命令的上游调用归属已变化",
        );
      }, { database: durableDatabase });
      if (advanced.kind === "replay") {
        return parseAgentImageReplayOutput(advanced.responseBody);
      }
      reservation = advanced;
      checkpoint = parseAgentImageCommandCheckpoint(advanced.checkpoint);
      throwAgentImageTestCrash("after_upstream_checkpoint");
    }

    let ownedStagingClaimId: string | null = null;
    if (checkpoint.state === "upstream_succeeded") {
      const claimId = uuid();
      const advanced = await mutateDurableCommandCheckpoint<
        GenerationImageSubmitOutput,
        AgentImageCommandCheckpoint
      >(reservation, (rawCheckpoint) => {
        const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
        assertAgentImageCommandScope({
          checkpoint: current,
          context,
          quoteId: located.quoteId,
          provider: located.provider,
        });
        if (current.state === "upstream_succeeded") {
          ownedStagingClaimId = claimId;
          return {
            ...current,
            state: "staging",
            stagingClaimId: claimId,
            stagingClaimedAt: Date.now(),
          };
        }
        if (current.state === "staging") {
          throw new DurableCommandIdempotencyError(
            409,
            "idempotency_in_progress",
            "相同图片生成结果正在写入受控存储，请稍后刷新",
          );
        }
        if (
          current.state === "staged"
          || current.state === "assets_persisted"
        ) {
          return current;
        }
        throw new DurableCommandIdempotencyError(
          409,
          "generation_image_staging_conflict",
          "图片生成命令的结果暂存状态已变化",
        );
      }, { database: durableDatabase });
      if (advanced.kind === "replay") {
        return parseAgentImageReplayOutput(advanced.responseBody);
      }
      reservation = advanced;
      checkpoint = parseAgentImageCommandCheckpoint(advanced.checkpoint);
    }

    if (checkpoint.state === "staging") {
      if (
        !ownedStagingClaimId
        || checkpoint.stagingClaimId !== ownedStagingClaimId
      ) {
        throw new DurableCommandIdempotencyError(
          409,
          "idempotency_in_progress",
          "该图片生成结果正在写入受控存储，正在等待结果或人工核对",
        );
      }
      const staged: StagedAgentImage[] = [];
      try {
        for (const [index, item] of checkpoint.result.data.entries()) {
          const mirrored = await mirrorAgentImageIfEnabled({
            durableDatabase,
            workspaceId: checkpoint.workspaceId,
            projectId: checkpoint.projectId,
            item,
          });
          const url = mirrored?.url ?? readImageUrl(item);
          if (!url) continue;
          staged.push({ index, url, mirrored });
        }
      } catch (error) {
        const queueFailures = await queueStagedAgentImageCompensations(
          staged,
          error,
          durableDatabase,
        );
        const failure = publicSubmitFailure(
          agentImagePersistenceError(error, queueFailures),
        );
        return completeOutput({
          status: "failed",
          code: failure.code,
          message: failure.message,
          ...failureBase,
        });
      }
      if (staged.length === 0) {
        return completeOutput({
          status: "failed",
          code: "image_result_empty",
          message: "图片上游未返回可用结果",
          ...failureBase,
        });
      }
      const advanced = await mutateDurableCommandCheckpoint<
        GenerationImageSubmitOutput,
        AgentImageCommandCheckpoint
      >(reservation, (rawCheckpoint) => {
        const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
        assertAgentImageCommandScope({
          checkpoint: current,
          context,
          quoteId: located.quoteId,
          provider: located.provider,
        });
        if (
          current.state === "staging"
          && current.stagingClaimId === ownedStagingClaimId
        ) {
          return {
            version: current.version,
            state: "staged",
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            runId: current.runId,
            actorUserId: current.actorUserId,
            quoteId: current.quoteId,
            provider: current.provider,
            operationStepId: current.operationStepId,
            taskId: current.taskId,
            createdAt: current.createdAt,
            clamped: current.clamped,
            providerRequest: current.providerRequest,
            result: current.result,
            staged,
          };
        }
        if (
          current.state === "staged"
          || current.state === "assets_persisted"
        ) {
          return current;
        }
        throw new DurableCommandIdempotencyError(
          409,
          "generation_image_staging_conflict",
          "图片生成命令的结果暂存状态已变化",
        );
      }, { database: durableDatabase });
      if (advanced.kind === "replay") {
        return parseAgentImageReplayOutput(advanced.responseBody);
      }
      reservation = advanced;
      checkpoint = parseAgentImageCommandCheckpoint(advanced.checkpoint);
    }

    if (checkpoint.state === "staged") {
      const stagedForPersistence = checkpoint.staged;
      try {
        const advanced = await mutateDurableCommandCheckpoint<
          GenerationImageSubmitOutput,
          AgentImageCommandCheckpoint
        >(reservation, async (rawCheckpoint, transaction) => {
          const current = parseAgentImageCommandCheckpoint(rawCheckpoint);
          assertAgentImageCommandScope({
            checkpoint: current,
            context,
            quoteId: located.quoteId,
            provider: located.provider,
          });
          if (current.state === "assets_persisted") return current;
          if (current.state !== "staged") {
            throw new DurableCommandIdempotencyError(
              409,
              "generation_image_asset_conflict",
              "图片生成命令的资产持久化状态已变化",
            );
          }
          const assets = await persistAgentImageResultsInTransaction({
            transaction,
            workspaceId: current.workspaceId,
            projectId: current.projectId,
            runId: current.runId,
            stepId: current.operationStepId,
            now: current.createdAt,
            taskId: current.taskId,
            quoteId: current.quoteId,
            clamped: current.clamped,
            staged: current.staged,
          });
          return {
            ...current,
            state: "assets_persisted",
            assets,
          };
        }, { database: durableDatabase });
        if (advanced.kind === "replay") {
          return parseAgentImageReplayOutput(advanced.responseBody);
        }
        reservation = advanced;
        checkpoint = parseAgentImageCommandCheckpoint(advanced.checkpoint);
      } catch (error) {
        if (isAgentImageTestCrash(error)) throw error;
        const queueFailures = await queueStagedAgentImageCompensations(
          stagedForPersistence,
          error,
          durableDatabase,
        );
        const failure = publicSubmitFailure(
          agentImagePersistenceError(error, queueFailures),
        );
        return completeOutput({
          status: "failed",
          code: failure.code,
          message: failure.message,
          ...failureBase,
        });
      }
      throwAgentImageTestCrash("after_assets_checkpoint");
    }

    if (checkpoint.state !== "assets_persisted") {
      throw new DurableCommandIdempotencyError(
        409,
        "generation_image_checkpoint_conflict",
        "图片生成命令尚未到达可完成状态",
      );
    }
    // 质量门读取 durable 资产事实，并固定使用首次执行的 operationStepId。
    // 因而 Gateway 分配新 Step 重放时不会新增第二条审核记录。
    const review = await reviewImageSubmissionGate({
      context: {
        database: durableDatabase,
        workspaceId: checkpoint.workspaceId,
        projectId: checkpoint.projectId,
        runId: checkpoint.runId,
        stepId: checkpoint.operationStepId,
      },
      clamped: checkpoint.clamped,
      quoteId: checkpoint.quoteId,
      assets: checkpoint.assets,
    });
    return completeOutput({
      status: "succeeded",
      code: null,
      message: null,
      ...failureBase,
      assets: checkpoint.assets,
      review,
    });
  },
});

// ─── GENERATION_VIDEO_SUBMIT_TOOL ────────────────────────────────────────────

export const GENERATION_VIDEO_SUBMIT_TOOL = defineAgentTool({
  manifest: {
    name: "generation.video.submit",
    version: "1.0.0",
    displayName: "提交视频生成",
    description: "提交一个待确认的视频生成提案(R2,需用户批准报价后创建异步任务,不会立即返回成片)。"
      + "正例:用户确认要「用 1080p 16:9 生成一段 5 秒视频」;"
      + "负例:只想询价时不要调用(改用 generation.quote);要生成图片时不要调用(改用 generation.image.submit);"
      + "消息上下文中的视频附件没有被解析；仅当所选模型的 inputSlots 明确接受 video 时，才可把其 assetVersionId 作为 references 受控传给上游;"
      + "不要用本工具轮询任务进度(改用 generation.task.get);任务完成后成片会异步写入项目资产库,提交时 assetVersionId 恒为 null;"
      + "显式分辨率/比例/时长/音频不在模型能力内时请求会被拒绝，不会静默降级。",
    riskClass: "R2",
    availability: { state: "available", sincePhase: "A3" },
    requiredPermissions: ["project:read", "generation:create"],
    resourceTypes: ["generation_quote", "generation_task", "provider_route", "pricing_rule"],
    mutatesState: true,
    metered: true,
  },
  inputSchema: generationVideoSubmitInputSchema,
  outputSchema: generationVideoSubmitOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const capability = await requireSubmittableCapability(context.database, context.workspaceId, "video_generation", input.model);
    const clamped = clampVideoSubmitRequest(input, capability);
    const prepared = await prepareAgentVideoRequest({ context, capability, clamped });
    const videoInputPricingTier = videoInputPricingTierForRequestPayload(prepared.requestPayload);
    const evidence = await resolveSubmitAuthorizationEvidence(
      "video",
      "generation.video.submit",
      clamped,
      input,
      context,
      videoInputPricingTier,
      clamped.duration,
      clamped.resolution,
    );
    return { ...evidence, resourceRefs: referenceResourceEvidence(clamped.references) };
  },
  async execute(input, context): Promise<GenerationVideoSubmitOutput> {
    if (!isAgentGenerationSubmitEnabled()) return unavailableVideoOutput(input);
    const capability = await requireSubmittableCapability(context.database, context.workspaceId, "video_generation", input.model);
    const clamped = clampVideoSubmitRequest(input, capability);
    const prepared = await prepareAgentVideoRequest({ context, capability, clamped });
    const videoInputPricingTier = videoInputPricingTierForRequestPayload(prepared.requestPayload);
    const located = await locateApprovalAnchoredQuote(context, "generation.video.submit", input);
    let verified = await verifyAgentGenerationQuoteForIdempotentReplay({
      database: context.database,
      quoteId: located.quoteId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.runId,
      expected: { generationType: "video", provider: located.provider, model: clamped.model, units: 1 },
      videoInputPricingTier,
      durationSeconds: clamped.duration,
      resolution: clamped.resolution,
      now: context.now,
    });
    if (!verified.videoBillingAuthorization) {
      throw new AgentToolGatewayError(
        "generation_quote_record_corrupt",
        "视频报价缺少计费授权快照",
        { status: 500 },
      );
    }
    const relayInput = {
      endpointType: "video_generation" as const,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      actorUserId: context.actorUserId,
      principalId: `agent:${context.actorUserId}`,
      provider: requireQuotedRelayProvider(verified.quote.provider),
      model: clamped.model,
      requestId: agentVideoSubmitRequestId(verified.quote.quoteId),
      requestPayload: prepared.requestPayload,
    };
    try {
      // createRelayTask 无法注入 Gateway 长事务连接(架构约束,详见 relay.ts
      // createRelayTask 头部注释):内部含通道槽位租约、独立原子计费预扣与异步
      // 任务行创建,生命周期独立于 Agent Run。SQLite 下 Gateway 已在调用
      // handler 前提交 metered-detached prepare，因此这里必须继续使用 root DB。
      let task;
      try {
        const replay = await createRelayTask(relayInput, {
          trustedVideoBillingAuthorization: {
            ...verified.videoBillingAuthorization,
            operation: "submit",
          },
          trustedCanonicalVideoGeneration: {
            request: prepared.canonical.request,
            digest: prepared.canonical.digest,
          },
          trustedVideoAssetPolicyEvidence: prepared.references.trustedPolicyEvidence,
          ...(prepared.relayAdapterBinding
            ? { trustedVideoProviderAdapter: prepared.relayAdapterBinding }
            : {}),
          idempotentReplayOnly: true,
        });
        task = relayIdempotentReplayTask(replay);
      } catch (error) {
        if (
          !error
          || typeof error !== "object"
          || !("code" in error)
          || String((error as { code?: unknown }).code) !== "relay_idempotent_replay_not_found"
        ) {
          throw error;
        }
        verified = await verifyAgentGenerationQuoteForExecution({
          database: context.database,
          quoteId: located.quoteId,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          runId: context.runId,
          expected: {
            generationType: "video",
            provider: located.provider,
            model: clamped.model,
            units: 1,
          },
          videoInputPricingTier,
          durationSeconds: clamped.duration,
          resolution: clamped.resolution,
          now: context.now,
        });
        if (!verified.videoBillingAuthorization) {
          throw new AgentToolGatewayError(
            "generation_quote_record_corrupt",
            "视频报价缺少计费授权快照",
            { status: 500 },
          );
        }
        ({ task } = await createRelayTask(relayInput, {
          trustedVideoBillingAuthorization: {
            ...verified.videoBillingAuthorization,
            operation: "submit",
          },
          trustedCanonicalVideoGeneration: {
            request: prepared.canonical.request,
            digest: prepared.canonical.digest,
          },
          trustedVideoAssetPolicyEvidence: prepared.references.trustedPolicyEvidence,
          ...(prepared.relayAdapterBinding
            ? { trustedVideoProviderAdapter: prepared.relayAdapterBinding }
            : {}),
        }));
      }
      const outcome = resolveRelaySubmissionOutcome({
        status: task.status,
        providerPayload: task.providerPayload,
      });
      const taskOutput = {
        taskId: task.id,
        status: outcome.status,
        requestId: task.requestId ?? null,
      };
      if (!outcome.accepted && !outcome.succeeded) {
        return {
          status: "failed",
          code: outcome.code,
          message: outcome.message,
          generationType: "video",
          quoteId: verified.quote.quoteId,
          provider: verified.quote.provider,
          model: clamped.model,
          units: 1,
          task: taskOutput,
          assetVersionId: null,
          review: null,
        };
      }
      // 2.3 质量门(一期规则版):校验任务已创建/时长与请求一致/prompt 非空;
      // 成片资产级校验(时长/分辨率)待 relay 终态回写,列二期。
      const review = await reviewVideoSubmissionGate({
        context,
        clamped,
        quoteId: verified.quote.quoteId,
        task: { taskId: String(task.id), status: outcome.status },
      });
      return {
        status: "succeeded",
        code: null,
        message: null,
        generationType: "video",
        quoteId: verified.quote.quoteId,
        provider: verified.quote.provider,
        model: clamped.model,
        units: 1,
        task: taskOutput,
        assetVersionId: null,
        review,
      };
    } catch (error) {
      const inProgress = relayIdempotencyInProgressGatewayError(error);
      if (inProgress) throw inProgress;
      const failure = publicSubmitFailure(error);
      return {
        status: "failed",
        code: failure.code,
        message: failure.message,
        generationType: "video",
        quoteId: verified.quote.quoteId,
        provider: verified.quote.provider,
        model: clamped.model,
        units: 1,
        task: null,
        assetVersionId: null,
        review: null,
      };
    }
  },
});

export const GENERATION_SUBMIT_TOOLS = [GENERATION_IMAGE_SUBMIT_TOOL, GENERATION_VIDEO_SUBMIT_TOOL] as const;
