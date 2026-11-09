import express from "express";
import { z } from "zod";
import { BillingError } from "@/lib/billing";
import { VideoRelayProviderAdapterError } from "@/lib/videoRelayProviderAdapter";
import { relayPortraitPreparationView } from "@/lib/relayPortraitPreparation";
import {
  assertRelayTaskProjectAuthority,
  createRelayTask,
  recoverCanonicalRelayTask,
} from "@/lib/relay";
import { resolveRelaySubmissionOutcome } from "@/lib/relaySubmissionOutcome";
import {
  resolveWorkbenchModelCapability,
  type WorkbenchModelCapability,
} from "@/lib/workbenchModelCatalog";
import {
  MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST,
  MAX_WORKBENCH_VIDEO_REFERENCES_PER_TRACK,
  resolveWorkbenchVideoReferenceLimit,
  validateWorkbenchVideoInputs,
} from "@/lib/workbenchVideoCapability";
import { normalizeVideoResolution as normalizeVideoResolutionAlias } from "@/lib/videoResolutions";
import {
  GENERATION_REFERENCE_ROLES,
  GenerationReferenceError,
  resolveCanonicalGenerationReferences,
  type GenerationReference,
  type ResolvedGenerationReferences,
} from "@/lib/generationReferenceResolver";
import {
  RelayProjectBindingError,
  resolveRequiredRelayProjectId,
} from "@/lib/relayProjectBinding";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import {
  VIDEO_OPERATIONS,
  VIDEO_REFERENCE_MEDIA_TYPES,
} from "@/lib/videoGenerationContract";
import {
  buildCanonicalVideoGenerationEnvelope,
  buildLegacyVideoProviderRequestPayload,
  VideoGenerationSurfaceContractError,
} from "@/lib/videoGenerationSurfaceContract";
import {
  prepareSeedance25Request,
  type PreparedSeedance25Request,
} from "@/lib/seedance25Adapter";

const router = express.Router();

const SUBMITTABLE_CAPABILITY_STATUSES = new Set(["verified", "configured", "legacy"]);
const referenceUrlSchema = z.string().trim().url().max(8_192).refine((value) => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "参考素材 URL 必须使用 HTTP(S) 且不能包含凭据");

const imageRequestSchema = z.object({
  mediaType: z.literal("image"),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(8_000),
  quality: z.string().trim().min(1).max(20),
  ratio: z.string().regex(/^\d{1,3}:\d{1,3}$/),
  count: z.number().int().min(1).max(4),
  referenceImages: z.array(referenceUrlSchema).max(10).optional(),
}).strict();

const generationReferenceSchema = z.object({
  assetVersionId: z.string().trim().min(1).max(200),
  role: z.enum(GENERATION_REFERENCE_ROLES),
  mediaType: z.enum(VIDEO_REFERENCE_MEDIA_TYPES).optional(),
  order: z.number().int().min(0).max(MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST - 1).optional(),
  trim: z.object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().positive(),
  }).strict().optional(),
}).strict();

const videoSourceSchema = z.object({
  assetVersionId: z.string().trim().min(1).max(200),
}).strict();

const videoEditSchema = z.object({
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().positive().optional(),
  maskAssetVersionId: z.string().trim().min(1).max(200).optional(),
  instruction: z.string().trim().min(1).max(8_000),
  preserve: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
}).strict().superRefine((value, context) => {
  if ((value.startMs !== undefined || value.endMs !== undefined)
    && (value.startMs === undefined || value.endMs === undefined || value.endMs <= value.startMs)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endMs"],
      message: "片段结束时间必须晚于开始时间",
    });
  }
});

const videoRequestSchema = z.object({
  mediaType: z.literal("video"),
  renderMode: z.literal("draft").optional(),
  projectId: z.unknown().optional(),
  project_id: z.unknown().optional(),
  generationAttemptId: z.string()
    .trim()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "视频生成请求编号格式错误"),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().max(8_000),
  mode: z.string().trim().min(1).max(64),
  operation: z.enum(VIDEO_OPERATIONS).optional(),
  resolution: z.string().trim().min(1).max(20),
  outputFormat: z.enum(["mp4", "mov"]).optional(),
  ratio: z.union([z.literal("adaptive"), z.string().regex(/^\d{1,3}:\d{1,3}$/)]),
  duration: z.union([z.literal(-1), z.number().positive().max(60)]),
  generateAudio: z.boolean(),
  preserveSourceAudio: z.boolean().optional().default(false),
  source: videoSourceSchema.optional(),
  edit: videoEditSchema.optional(),
  references: z.array(generationReferenceSchema)
    .max(MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST)
    .optional()
    .default([]),
}).strict();

// The public envelope admits the verified Seedance 2.5 formal contract's
// larger input set. Legacy Canvas models must retain the historical Zod
// validation response (HTTP 400 + `errors[].path === ["references"]`) at 15.
const legacyVideoReferencesSchema = z.array(generationReferenceSchema)
  .max(MAX_WORKBENCH_VIDEO_REFERENCES_PER_TRACK);

const requestSchema = z.discriminatedUnion("mediaType", [imageRequestSchema, videoRequestSchema]);

function canSubmitCapability(
  capability: WorkbenchModelCapability | null,
): capability is WorkbenchModelCapability & { canSubmit: true } {
  return Boolean(
    capability
    && capability.canSubmit === true
    && SUBMITTABLE_CAPABILITY_STATUSES.has(capability.capabilityStatus),
  );
}

function capabilityValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}

function supportsDuration(capability: unknown, requested: number): boolean {
  if (!capability || typeof capability !== "object") return false;
  const duration = capability as { min?: unknown; max?: unknown; step?: unknown; auto?: boolean; allowed?: unknown };
  if (requested === -1) return duration.auto === true;
  if (Array.isArray(duration.allowed) && duration.allowed.length > 0) {
    return duration.allowed.some((value) => typeof value === "number" && value === requested);
  }
  const min = Number(duration.min);
  const max = Number(duration.max);
  const step = Number(duration.step);
  if (![min, max, step].every(Number.isFinite) || step <= 0 || requested < min || requested > max) return false;
  const steps = (requested - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function normalizeVideoResolution(value: string): string {
  // 新契约(v31):2K 独立档、4K 规范存储 "4k";别名归一委托 lib,无法识别原样返回。
  return normalizeVideoResolutionAlias(value) ?? "";
}

function requestPrincipalId(req: express.Request): string | null {
  const id = (req as any).auth?.user?.id;
  return id == null || String(id).trim() === "" ? null : String(id);
}

function requestWorkspaceId(req: express.Request): string {
  return String((req as any).auth?.workspaceId || "").trim();
}

function canvasVideoRequestId(
  req: express.Request,
  generationAttemptId: string,
): string {
  const principalId = requestPrincipalId(req) || "session";
  return `canvas-video:${principalId}:${generationAttemptId}`;
}

type PreparedVideoInputs = {
  references: GenerationReference[];
  referenceContent: Record<string, unknown>[];
  resolved: ResolvedGenerationReferences;
};

async function prepareVideoInputs(input: {
  actorUserId?: number;
  workspaceId: string;
  projectId: number;
  references: GenerationReference[];
}): Promise<PreparedVideoInputs> {
  const resolved = await resolveCanonicalGenerationReferences({
      workspaceId: input.workspaceId,
      projectId: String(input.projectId),
      references: input.references,
      actorUserId: input.actorUserId,
  });
  return {
    references: resolved.inputs,
    referenceContent: resolved.providerContent,
    resolved,
  };
}

async function generateVideo(
  req: express.Request,
  res: express.Response,
  body: z.infer<typeof videoRequestSchema>,
  workspaceId: string,
  projectId: number,
) {
  try {
    // Keep foreign/nonexistent projects indistinguishable and fail before
    // capability routing, pricing, quota, or provider work.
    await assertRelayTaskProjectAuthority({
      endpointType: "video_generation",
      workspaceId,
      projectId,
    });
  } catch (error: any) {
    const candidate = Number(error?.statusCode ?? error?.status);
    const status = Number.isInteger(candidate) && candidate >= 400 && candidate < 500
      ? candidate
      : 500;
    return res.status(status).send({
      message: status === 409
        ? "视频生成请求冲突"
        : "视频生成任务创建失败",
    });
  }
  const capability = await resolveWorkbenchModelCapability({
    workspaceId,
    endpointType: "video_generation",
    model: body.model,
  });
  if (!canSubmitCapability(capability)) {
    return res.status(422).send({ message: capability?.unavailableReason || "所选视频模型当前不可提交" });
  }
  const requestedOperation = body.operation ?? "generate";
  if (body.mode === "video_edit" && requestedOperation !== "edit" || body.mode === "video_extension" && requestedOperation !== "extend") {
    return res.status(422).send({ message: "视频模式与 operation 不一致，不能退回普通生成" });
  }
  const operationCapability = capability.videoGeneration?.operations.find((operation) => (
    operation.operation === requestedOperation && operation.enabled === true
  ));
  if (!operationCapability) {
    return res.status(422).send({ message: "所选视频模型未声明当前 operation" });
  }
  if (requestedOperation === "edit") {
    if (!body.source || !body.edit) {
      return res.status(422).send({ message: "视频编辑必须提供受控来源和编辑指令" });
    }
    if ((body.edit.startMs !== undefined || body.edit.endMs !== undefined) && capability.videoGeneration?.supportsTimeRange !== true) {
      return res.status(422).send({ message: "当前视频模型未验证时间范围编辑能力" });
    }
    if (body.edit.maskAssetVersionId && capability.videoGeneration?.supportsMask !== true) {
      return res.status(422).send({ message: "当前视频模型未验证遮罩编辑能力" });
    }
  } else if (requestedOperation === "extend") {
    if (!capability.videoGeneration?.contractFamily || !body.source?.assetVersionId || body.edit) {
      return res.status(422).send({ message: "视频延长必须提供已验证模型和受控原片，且不能携带编辑字段" });
    }
  } else if (body.source || body.edit) {
    return res.status(422).send({ message: "普通视频生成不能携带来源或编辑字段" });
  }
  if (body.preserveSourceAudio && capability.videoGeneration?.supportsPreserveSourceAudio !== true) {
    return res.status(422).send({ message: "当前视频模型未验证保留原音能力" });
  }
  if (body.outputFormat && !capability.videoGeneration?.outputFormats?.includes(body.outputFormat)) {
    return res.status(422).send({ message: "所选视频模型不支持此成片格式" });
  }
  if (!body.prompt && (!capability.videoGeneration?.contractFamily || !body.references?.length)) {
    return res.status(422).send({ message: "当前视频请求需要提示词或参考素材" });
  }
  if (!capability.videoGeneration?.contractFamily) {
    const legacyReferences = legacyVideoReferencesSchema.safeParse(body.references);
    if (!legacyReferences.success) {
      return res.status(400).send({
        message: "Canvas 生成参数错误",
        errors: legacyReferences.error.issues.map((issue) => ({
          ...issue,
          path: ["references", ...issue.path],
        })),
      });
    }
  }
  const resolution = normalizeVideoResolution(body.resolution);
  if (body.renderMode && (capability.videoGeneration?.draft?.enabled !== true || resolution !== "480p")) {
    return res.status(422).send({ message: "样片仅支持已开放的 Seedance 2.5 通道和 480p 输出" });
  }
  if (!(body.renderMode === "draft" && resolution === "480p") && !capabilityValues(capability.resolutions).includes(resolution)) {
    return res.status(422).send({ message: "所选视频分辨率不受当前模型支持" });
  }
  if (requestedOperation !== "generate" && capability.videoGeneration?.contractFamily === "seedance-2.5" ? body.ratio !== "adaptive" : !capabilityValues(capability.aspectRatios).includes(body.ratio)) {
    return res.status(422).send({ message: requestedOperation !== "generate" ? "视频延长或编辑的画幅必须跟随原片，请使用 adaptive" : "所选视频比例不受当前模型支持" });
  }
  if (!supportsDuration(operationCapability.duration, body.duration)) {
    return res.status(422).send({ message: "所选视频时长不受当前模型支持" });
  }
  if (typeof capability.supportsGenerateAudio !== "boolean") {
    return res.status(422).send({ message: "视频模型缺少音频生成能力声明" });
  }
  if (body.generateAudio && !capability.supportsGenerateAudio) {
    return res.status(422).send({ message: "当前视频模型不支持生成音频" });
  }
  if (
    (capability.videoGeneration ? !capability.videoGeneration.dispatchable : false)
    || body.references.length > (
      capability.videoGeneration?.totalInputLimit
      ?? resolveWorkbenchVideoReferenceLimit(capability, body.mode)
    )
  ) {
    return res.status(422).send({ message: "参考素材数量超过模型目录声明的动态上限" });
  }
  let prepared: PreparedVideoInputs;
  try {
    prepared = await prepareVideoInputs({
      actorUserId: Number(requestPrincipalId(req)),
      workspaceId,
      projectId,
      references: body.references,
    });
  } catch (error) {
    if (error instanceof GenerationReferenceError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    return res.status(500).send({ message: "参考素材校验失败" });
  }
  if (body.source && !prepared.resolved.inputs.some((input) => (
    input.assetVersionId === body.source?.assetVersionId && input.mediaType === "video"
  ))) {
    return res.status(422).send({ message: "原片必须同时作为当前项目的受控视频参考素材提交" });
  }
  if (body.edit?.maskAssetVersionId && !prepared.resolved.inputs.some((input) => (
    input.assetVersionId === body.edit?.maskAssetVersionId && input.mediaType === "image"
  ))) {
    return res.status(422).send({ message: "编辑遮罩必须同时作为当前项目的受控图片参考素材提交" });
  }
  let canonical;
  let requestPayload: Record<string, unknown>;
  let relayAdapterBinding: PreparedSeedance25Request["relayAdapterBinding"] | undefined;
  try {
    if (capability.videoGeneration?.contractFamily) {
      canonical = buildCanonicalVideoGenerationEnvelope({
        operation: requestedOperation,
        renderMode: body.renderMode,
        modelRouteId: capability.routeId || capability.id,
        prompt: body.prompt,
        aspectRatio: body.ratio,
        durationSeconds: body.duration,
        outputResolution: resolution,
        outputFormat: body.outputFormat,
        generateAudio: body.generateAudio,
        preserveSourceAudio: body.preserveSourceAudio,
        inputs: prepared.resolved.inputs,
        preparedReferenceContent: prepared.referenceContent,
        source: body.source,
        edit: body.edit,
      });
      const provider = prepareSeedance25Request({
        capability,
        request: canonical.request,
        providerContent: prepared.referenceContent,
        policyEvidence: prepared.resolved.trustedPolicyEvidence,
        workspaceId,
        projectId: String(projectId),
      });
      requestPayload = provider.requestPayload;
      relayAdapterBinding = provider.relayAdapterBinding;
    } else {
      const inputValidation = validateWorkbenchVideoInputs(capability, [{
        mode: body.mode,
        references: prepared.references,
        referenceContent: prepared.referenceContent,
      }]);
      if (!inputValidation.ok) {
        return res.status(422).send({ message: inputValidation.message });
      }
      canonical = buildCanonicalVideoGenerationEnvelope({
        operation: body.operation,
        selectedLegacyMode: inputValidation.modes[0],
        modelRouteId: capability.routeId || capability.id,
        prompt: body.prompt,
        aspectRatio: body.ratio,
        durationSeconds: body.duration,
        outputResolution: resolution,
        outputFormat: body.outputFormat,
        generateAudio: body.generateAudio,
        preserveSourceAudio: body.preserveSourceAudio,
        inputs: prepared.resolved.inputs,
        preparedReferenceContent: prepared.referenceContent,
        source: body.source,
        edit: body.edit,
      });
      requestPayload = buildLegacyVideoProviderRequestPayload({
        model: capability.id,
        canonicalRequest: canonical.request,
        providerContent: prepared.referenceContent,
      });
    }
  } catch (error) {
    if (error instanceof GenerationReferenceError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    if (error instanceof VideoGenerationSurfaceContractError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    throw error;
  }

  const relayInput = {
      endpointType: "video_generation",
      workspaceId,
      projectId,
      actorUserId: Number((req as any).auth?.user?.id || 0),
      apiKeyId: null,
      principalId: requestPrincipalId(req),
      requestId: canvasVideoRequestId(req, body.generationAttemptId),
      model: capability.id,
      requestPayload,
    } as const;
  const relayOptions = {
      trustedCanonicalVideoGeneration: {
        request: canonical.request,
        digest: canonical.digest,
      },
      trustedVideoAssetPolicyEvidence: prepared.resolved.trustedPolicyEvidence,
      ...(relayAdapterBinding
        ? { trustedVideoProviderAdapter: relayAdapterBinding }
        : {}),
    };
  try {
    const { task } = await createRelayTask(relayInput, relayOptions);
    const outcome = resolveRelaySubmissionOutcome({
      status: task.status,
      providerPayload: task.providerPayload,
    });
    if (!outcome.accepted && !outcome.succeeded) {
      return res.status(200).send({
        taskId: task.id,
        status: outcome.status,
        ...relayPortraitPreparationView(task),
        model: capability.id,
        resolution,
        code: outcome.code,
        message: outcome.message,
      });
    }
    return res.status(200).send({
      taskId: task.id,
      status: outcome.accepted ? "processing" : outcome.status,
      ...relayPortraitPreparationView(task),
      model: capability.id,
      resolution,
    });
  } catch (error: any) {
    if (error instanceof BillingError) {
      return res.status(error.status).send({ message: error.message || "视频计费失败" });
    }
    if (error instanceof VideoRelayProviderAdapterError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    const candidate = Number(error?.statusCode ?? error?.status);
    const status = Number.isInteger(candidate) && candidate >= 400 && candidate < 500 ? candidate : 500;
    const code = typeof error?.code === "string" && error.code ? error.code : undefined;
    // Same generationAttemptId after a transport-uncertain submit must recover
    // the existing task instead of dead-ending on a generic 409.
    if (status === 409 && code === "idempotency_conflict") {
      try {
        // Recovery is scoped and read-only. The central helper rechecks the
        // canonical request, current policy and adapter; only signed media
        // URL renewal may differ from the persisted provider payload.
        const existing = await recoverCanonicalRelayTask(relayInput, relayOptions);
        if (existing) {
          const recovered = existing.task;
          const outcome = resolveRelaySubmissionOutcome({
            status: recovered.status,
            providerPayload: recovered.providerPayload,
          });
          return res.status(200).send({
            taskId: String(recovered.id),
            status: outcome.succeeded ? "succeeded" : outcome.accepted ? "processing" : outcome.status,
            ...relayPortraitPreparationView(recovered),
            model: capability.id,
            resolution,
            recovered: true,
            code: "idempotent_replay",
            message: "已找到同一请求编号的既有任务，正在查询或复用结果",
          });
        }
      } catch {
        // fall through to the conflict response
      }
    }
    return res.status(status).send({
      message: status === 409
        ? (typeof error?.message === "string" && error.message && error.message !== "Idempotency key conflict"
          ? error.message
          : "同一请求编号已存在但内容不一致；请改用新的生成请求，或在历史中查看该任务")
        : "视频生成任务创建失败",
      code: code || (status === 409 ? "video_submit_conflict" : "video_submit_failed"),
    });
  }
}

export default router.post(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  async (req, res) => {
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).send({ message: "Canvas 生成参数错误", errors: parsed.error.issues });
    }
    const workspaceId = requestWorkspaceId(req);
    if (!workspaceId || !requestPrincipalId(req)) {
      return res.status(403).send({ message: "缺少可信工作区上下文" });
    }
    if (parsed.data.mediaType === "image") {
      return res.status(410).send({
        code: "canvas_image_generation_moved",
        message: "Canvas 图片生成必须通过项目绑定的持久化接口提交",
        endpoint: "/api/workbench/create/images",
      });
    }
    let projectId: number;
    try {
      projectId = resolveRequiredRelayProjectId(parsed.data);
    } catch (error) {
      if (error instanceof RelayProjectBindingError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    return await generateVideo(req, res, parsed.data, workspaceId, projectId);
  },
);
