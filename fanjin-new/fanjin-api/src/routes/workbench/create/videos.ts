import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { Knex } from "knex";
import u from "@/utils";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { createWorkbenchRelayVideoTask, syncWorkbenchVideoRelay } from "@/lib/workbenchVideoRelay";
import { syncVideoTaskState } from "@/lib/videoTaskState";
import { resolveRelaySubmissionOutcome } from "@/lib/relaySubmissionOutcome";
import { insertAndReturnId } from "@/lib/dbDialect";
import {
  beginDurableCommand,
  completeDurableCommand,
  type DurableCommandReservation,
  DurableCommandIdempotencyError,
  mutateDurableCommandCheckpoint,
} from "@/lib/durableCommandIdempotency";
import {
  GenerationReferenceError,
  GENERATION_REFERENCE_ROLES,
  inspectGenerationReferences,
  resolveCanonicalGenerationReferences,
  type GenerationReference,
  type ResolvedGenerationReferences,
} from "@/lib/generationReferenceResolver";
import { resolveWorkbenchModelCapability } from "@/lib/workbenchModelCatalog";
import {
  MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST,
  validateWorkbenchVideoInputs,
} from "@/lib/workbenchVideoCapability";
import { readRequiredIdempotencyKey } from "@/middleware/idempotencyKey";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { BillingError, publicBillingErrorDetails } from "@/lib/billing";
import { VideoAssetPolicyError } from "@/lib/videoAssetPolicy";
import { VideoAssetPolicyRelayBindingError } from "@/lib/videoAssetPolicyRelayBinding";
import { cancelOrDeleteRelayTask } from "@/lib/relay";
import {
  VIDEO_OPERATIONS,
  VIDEO_REFERENCE_MEDIA_TYPES,
  videoGenerationRequestDigest,
  type VideoOperation,
} from "@/lib/videoGenerationContract";
import {
  buildCanonicalVideoGenerationEnvelope,
  buildLegacyVideoProviderRequestPayload,
  VideoGenerationSurfaceContractError,
  type CanonicalVideoGenerationEnvelope,
} from "@/lib/videoGenerationSurfaceContract";
import {
  createQuickCreateVideoCheckpoint,
  parseQuickCreateVideoCheckpoint,
  quickCreateVideoCheckpointTrack as checkpointTrack,
  quickCreateVideoResultPhase,
  replaceQuickCreateVideoCheckpointTrack as replaceCheckpointTrack,
  settleOrderedServerBatch,
  QUICK_CREATE_VIDEO_BATCH_MAX_CONCURRENCY,
  QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS,
  QUICK_CREATE_VIDEO_BATCH_SCOPE,
  type QuickCreateVideoCommandCheckpoint,
  type QuickCreateVideoTaskResult,
} from "@/lib/workbenchVideoBatchContract";
import {
  cancelQuickCreateVideoBatch,
  QuickCreateVideoBatchControlError,
  readQuickCreateVideoBatch,
} from "@/lib/workbenchVideoBatchControl";
import {
  bindStructuredTimelineTracks,
  createStructuredTimelineRelayContext,
  createStructuredTimelineSubmissionBinding,
  parseStructuredThirtySecondTimeline,
  StructuredTimelineError,
  type StructuredThirtySecondTimeline,
  type StructuredTimelineSubmissionBinding,
} from "@/lib/structuredThirtySecondTimeline";
import {
  prepareSeedance25Request,
  type PreparedSeedance25Request,
} from "@/lib/seedance25Adapter";
import {
  RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HEADER,
  ReleaseFullMaintenancePrivateValidationBudgetTransportError,
  resolveReleaseFullMaintenancePrivateValidationPortraitBudgetBinding,
} from "@/lib/releaseFullMaintenancePrivateValidationBudgetTransport";
import type {
  ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
} from "@/lib/releaseFullMaintenancePrivateValidationBudget";
import {
  lockActiveQuickCreateVideoTarget,
  QuickCreateVideoMutationFenceError,
} from "@/lib/quickCreateVideoMutationFence";
import {
  issueQuickCreatePricingConfirmation,
  quickCreatePricingChallengeBody,
  QuickCreatePricingConfirmationError,
  QuickCreatePricingTokenError,
  verifyQuickCreatePricingConfirmation,
  type QuickCreatePricingAuthorization,
  type QuickCreatePricingConfirmationBinding,
} from "@/lib/quickCreatePricingConfirmation";

const router = express.Router();

const QUICK_CREATE_LIMITS = {
  maxTracks: QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS,
  // Public multi-reference recipes can exceed 4,000 characters. Keep their
  // full instructions, with the same bounded capacity as creation drafts.
  maxPromptLength: 20_000,
  maxModelLength: 100,
  maxResolutionLength: 20,
  minDuration: 1,
  maxDuration: 60,
  maxTotalReferences: QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS
    * MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST,
  maxConcurrency: QUICK_CREATE_VIDEO_BATCH_MAX_CONCURRENCY,
} as const;

const SUBMITTABLE_CAPABILITY_STATUSES = new Set(["verified", "configured", "legacy"]);

type VideoCapabilityLike = {
  id?: unknown;
  capabilityStatus?: unknown;
  canSubmit?: unknown;
  unavailableReason?: unknown;
  resolutions?: unknown;
  defaultResolution?: unknown;
  aspectRatios?: unknown;
  duration?: unknown;
  supportsGenerateAudio?: unknown;
  modes?: unknown;
  inputSlots?: unknown;
};

function canSubmitCapability(entry: VideoCapabilityLike | null | undefined): entry is VideoCapabilityLike & {
  id: string;
  capabilityStatus: string;
  canSubmit: true;
} {
  return Boolean(
    entry
    && typeof entry.id === "string"
    && entry.id.trim()
    && entry.canSubmit === true
    && SUBMITTABLE_CAPABILITY_STATUSES.has(String(entry.capabilityStatus)),
  );
}

function capabilityValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function supportsDuration(
  durationCapability: unknown,
  requestedDuration: number,
): boolean {
  if (!durationCapability || typeof durationCapability !== "object") return false;
  const duration = durationCapability as {
    min?: unknown;
    max?: unknown;
    step?: unknown;
    allowed?: unknown;
    auto?: boolean;
  };
  if (requestedDuration === -1) return duration.auto === true;
  if (Array.isArray(duration.allowed) && duration.allowed.length > 0) {
    return duration.allowed.some((item) => typeof item === "number" && item === requestedDuration);
  }

  const min = Number(duration.min);
  const max = Number(duration.max);
  const step = Number(duration.step);
  if (![min, max, step].every(Number.isFinite) || step <= 0 || requestedDuration < min || requestedDuration > max) {
    return false;
  }
  const stepsFromMin = (requestedDuration - min) / step;
  return Math.abs(stepsFromMin - Math.round(stepsFromMin)) < 1e-9;
}

const referenceSchema = z.object({
  assetVersionId: z.string().trim().min(1).max(200),
  role: z.enum(GENERATION_REFERENCE_ROLES),
  mediaType: z.enum(VIDEO_REFERENCE_MEDIA_TYPES).optional(),
  order: z.number().int().min(0).max(MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST - 1).optional(),
  trim: z.object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().positive(),
  }).strict().optional(),
}).strict();

const trackSchema = z.object({
  trackId: z.number().int().positive(),
  prompt: z.string().max(QUICK_CREATE_LIMITS.maxPromptLength),
  duration: z.union([z.literal(-1), z.number()
    .min(QUICK_CREATE_LIMITS.minDuration)
    .max(QUICK_CREATE_LIMITS.maxDuration)]),
  mode: z.string().trim().min(1).max(64).optional(),
  operation: z.enum(VIDEO_OPERATIONS).optional(),
  references: z.array(referenceSchema).max(MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST).optional().default([]),
  uploadData: z.array(z.unknown()).max(0).optional(),
});

const pricingConfirmationSchema = z.object({
  token: z.string().trim().min(1).max(16_384).optional(),
  acceptedUnitMaximumCostMicros: z.number().int().positive()
    .max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

type QuickCreateVideoTrack = {
  trackId: number;
  prompt: string;
  duration: number;
  mode?: string;
  operation?: VideoOperation;
  references?: GenerationReference[];
};

type QuickCreateReplayResponse = {
  responseStatus: number;
  responseBody: QuickCreateVideoTaskResult[];
};

class QuickCreateCommandReplayError extends Error {
  constructor(readonly replay: QuickCreateReplayResponse) {
    super("视频生成命令已由并发请求完成");
    this.name = "QuickCreateCommandReplayError";
  }
}

class QuickCreateBillingStopError extends Error {
  constructor(readonly body: {
    message: string;
    code: "video_task_insufficient_balance";
    data?: { requiredGu: number; availableGu: number };
  }) {
    super(body.message);
    this.name = "QuickCreateBillingStopError";
  }
}

type QuickCreateTrackPreparationInput = {
  workspaceId: string;
  projectId: number;
  scriptId: number;
  trackData: QuickCreateVideoTrack[];
};

async function assertQuickCreateTracks(
  input: QuickCreateTrackPreparationInput,
): Promise<void> {
  if (input.trackData.length > QUICK_CREATE_LIMITS.maxTracks) {
    throw new GenerationReferenceError(400, "batch_too_large", `单次最多提交 ${QUICK_CREATE_LIMITS.maxTracks} 个镜头`);
  }

  const trackIds = input.trackData.map((track) => track.trackId);
  if (new Set(trackIds).size !== trackIds.length) {
    throw new GenerationReferenceError(400, "duplicate_track", "镜头不能重复提交");
  }

  const totalReferences = input.trackData.reduce(
    (sum, track) => sum + (track.references?.length || 0),
    0,
  );
  if (totalReferences > QUICK_CREATE_LIMITS.maxTotalReferences) {
    throw new GenerationReferenceError(
      400,
      "too_many_references",
      `所有镜头的参考素材总数不能超过 ${QUICK_CREATE_LIMITS.maxTotalReferences} 个`,
    );
  }

  const rows = await u.db("o_videoTrack")
    .where({ projectId: input.projectId, scriptId: input.scriptId })
    .whereIn("id", trackIds)
    .select("id");
  const found = new Set(rows.map((row: any) => Number(row.id)));
  if (found.size !== trackIds.length || trackIds.some((id) => !found.has(id))) {
    throw new GenerationReferenceError(404, "track_not_found", "镜头不存在");
  }
}

async function inspectQuickCreateTracks(input: QuickCreateTrackPreparationInput) {
  return await Promise.all(input.trackData.map(async (track) => {
    const inspectedReferences = await inspectGenerationReferences({
      workspaceId: input.workspaceId,
      projectId: String(input.projectId),
      references: track.references || [],
    });
    return {
      ...track,
      references: inspectedReferences.inputs,
      referenceContent: inspectedReferences.providerContent,
    };
  }));
}

async function prepareQuickCreateTracks(input: QuickCreateTrackPreparationInput) {
  return await Promise.all(input.trackData.map(async (track) => {
    const resolvedReferences = await resolveCanonicalGenerationReferences({
      workspaceId: input.workspaceId,
      projectId: String(input.projectId),
      references: track.references || [],
    });
    return {
      ...track,
      references: resolvedReferences.inputs,
      referenceContent: resolvedReferences.providerContent,
      resolvedReferences,
    };
  }));
}

router.post(
  "/",
  requireProjectPermission("generation:create"),
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(trackSchema).min(1).max(QUICK_CREATE_LIMITS.maxTracks),
    model: z.string().max(QUICK_CREATE_LIMITS.maxModelLength).optional().nullable(),
    resolution: z.string().max(QUICK_CREATE_LIMITS.maxResolutionLength).optional().nullable(),
    ratio: z.union([z.literal("adaptive"), z.string().regex(/^\d{1,3}:\d{1,3}$/)]).optional(),
    outputFormat: z.enum(["mp4", "mov"]).optional(),
    audio: z.boolean().optional(),
    structuredTimeline: z.unknown().optional(),
    pricingConfirmation: pricingConfirmationSchema.optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackData } = req.body as {
      projectId: number;
      scriptId: number;
      trackData: QuickCreateVideoTrack[];
      model?: string | null;
      resolution?: string | null;
      ratio?: string;
      outputFormat?: "mp4" | "mov";
      audio?: boolean;
      structuredTimeline?: unknown;
      pricingConfirmation?: {
        token?: string;
        acceptedUnitMaximumCostMicros?: number;
      };
    };

    let structuredTimeline: StructuredThirtySecondTimeline | null = null;
    try {
      if (Object.prototype.hasOwnProperty.call(req.body, "structuredTimeline")) {
        structuredTimeline = parseStructuredThirtySecondTimeline(req.body.structuredTimeline);
        // Reject any hidden prompt/duration/reference/trim mutation before
        // resolving provider URLs or reserving a durable command.
        bindStructuredTimelineTracks({ timeline: structuredTimeline, tracks: trackData });
      }
    } catch (error) {
      if (error instanceof StructuredTimelineError) {
        return res.status(422).send({ message: error.message, code: error.code });
      }
      throw error;
    }

    const requestedModel = typeof req.body.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : undefined;
    const project = (req as any).project;
    const workspaceId = String(project?.workspaceId || (req as any).auth?.workspaceId || "");
    const capability = await resolveWorkbenchModelCapability({
      workspaceId,
      endpointType: "video_generation",
      model: requestedModel,
    });
    if (!canSubmitCapability(capability)) {
      if (!requestedModel) {
        return res.status(503).send({ message: "当前工作区没有可用的默认视频模型" });
      }
      return res.status(422).send({
        message: typeof capability?.unavailableReason === "string" && capability.unavailableReason.trim()
          ? capability.unavailableReason
          : "所选视频模型当前不可提交",
      });
    }
    const model = capability.id;
    const resolutions = capabilityValues(capability.resolutions);
    const aspectRatios = capabilityValues(capability.aspectRatios);
    const requestedResolution = typeof req.body.resolution === "string" && req.body.resolution
      ? req.body.resolution
      : undefined;
    const defaultResolution = typeof capability.defaultResolution === "string"
      ? capability.defaultResolution
      : undefined;
    const resolution = requestedResolution || defaultResolution;
    const ratio = typeof req.body.ratio === "string" ? req.body.ratio
      : typeof project?.videoRatio === "string" ? project.videoRatio : "";
    const outputFormat = req.body.outputFormat as "mp4" | "mov" | undefined;
    if (outputFormat && !capability.videoGeneration?.outputFormats?.includes(outputFormat)) {
      return res.status(422).send({ message: "所选视频模型不支持此成片格式" });
    }
    const audio = req.body.audio ?? false;

    if (!resolution || !resolutions.includes(resolution)) {
      return res.status(requestedResolution ? 422 : 503).send({
        message: requestedResolution ? "所选视频分辨率不受当前模型支持" : "视频模型缺少可用的默认分辨率",
      });
    }
    if (!ratio || !aspectRatios.includes(ratio)) {
      return res.status(422).send({ message: "项目画幅比例不受当前视频模型支持" });
    }
    if (typeof capability.supportsGenerateAudio !== "boolean") {
      return res.status(422).send({ message: "视频模型缺少音频生成能力声明" });
    }
    if (audio && !capability.supportsGenerateAudio) {
      return res.status(422).send({ message: "当前视频模型不支持生成音频" });
    }
    if (trackData.some((track) => !supportsDuration(capability.duration, track.duration))) {
      return res.status(422).send({ message: "一个或多个镜头时长不受当前视频模型支持" });
    }
    if (capability.videoGeneration && !capability.videoGeneration.dispatchable) {
      return res.status(422).send({ message: "参考素材数量超过模型目录声明的动态上限" });
    }

    let preparedTracks: Array<QuickCreateVideoTrack & {
      references: GenerationReference[];
      referenceContent: Record<string, unknown>[];
      resolvedReferences: ResolvedGenerationReferences;
      canonical: CanonicalVideoGenerationEnvelope;
      selectedMode: string;
      requestPayload: Record<string, unknown>;
      relayAdapterBinding?: PreparedSeedance25Request["relayAdapterBinding"];
    }>;
    try {
      const preparationInput = {
        workspaceId,
        projectId,
        scriptId,
        trackData,
      };
      await assertQuickCreateTracks(preparationInput);
      const formalContract = Boolean(capability.videoGeneration?.contractFamily);
      if (!formalContract && trackData.some((track) => !track.prompt.trim())) {
        return res.status(422).send({ message: "所选视频模型需要提示词" });
      }
      if (!formalContract) {
        const inspectedTracks = await inspectQuickCreateTracks(preparationInput);
        const structuralValidation = validateWorkbenchVideoInputs(capability, inspectedTracks);
        if (!structuralValidation.ok) {
          return res.status(422).send({ message: structuralValidation.message });
        }
      }
      const resolvedTracks = await prepareQuickCreateTracks({
        ...preparationInput,
      });
      if (formalContract) {
        preparedTracks = resolvedTracks.map((track) => {
          const canonical = buildCanonicalVideoGenerationEnvelope({
            operation: track.operation ?? "generate",
            modelRouteId: capability.routeId || capability.id,
            prompt: track.prompt,
            aspectRatio: ratio,
            durationSeconds: track.duration,
            outputResolution: resolution,
            outputFormat,
            generateAudio: audio,
            inputs: track.resolvedReferences.inputs,
            preparedReferenceContent: track.referenceContent,
          });
          const provider = prepareSeedance25Request({
            capability,
            request: canonical.request,
            providerContent: track.referenceContent,
            policyEvidence: track.resolvedReferences.trustedPolicyEvidence,
            workspaceId,
            projectId: String(projectId),
          });
          return {
            ...track,
            selectedMode: track.references.length ? "omni_reference" : "text_to_video",
            canonical,
            requestPayload: provider.requestPayload,
            relayAdapterBinding: provider.relayAdapterBinding,
          };
        });
      } else {
        const inputValidation = validateWorkbenchVideoInputs(capability, resolvedTracks);
        if (!inputValidation.ok) {
          return res.status(422).send({ message: inputValidation.message });
        }
        preparedTracks = resolvedTracks.map((track, index) => {
          const selectedMode = inputValidation.modes[index];
          const canonical = buildCanonicalVideoGenerationEnvelope({
            operation: track.operation,
            selectedLegacyMode: selectedMode,
            modelRouteId: capability.routeId || capability.id,
            prompt: track.prompt,
            aspectRatio: ratio,
            durationSeconds: track.duration,
            outputResolution: resolution,
            outputFormat,
            generateAudio: audio,
            inputs: track.resolvedReferences.inputs,
            preparedReferenceContent: track.referenceContent,
          });
          return {
            ...track,
            selectedMode,
            canonical,
            requestPayload: buildLegacyVideoProviderRequestPayload({
              model: capability.id,
              canonicalRequest: canonical.request,
              providerContent: track.referenceContent,
            }),
          };
        });
      }
    } catch (error) {
      if (error instanceof GenerationReferenceError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      if (error instanceof VideoGenerationSurfaceContractError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      return res.status(500).send({ message: "参考素材校验失败" });
    }
    let structuredTimelineBinding: StructuredTimelineSubmissionBinding | null = null;
    try {
      structuredTimelineBinding = structuredTimeline
        ? createStructuredTimelineSubmissionBinding({
          timeline: structuredTimeline,
          tracks: trackData,
          canonicalRequestDigests: preparedTracks.map((track) => (
            videoGenerationRequestDigest(track.canonical.request)
          )),
          workspaceId,
          projectId,
          scriptId,
          model,
          resolution,
          audio,
        })
        : null;
    } catch (error) {
      if (error instanceof StructuredTimelineError) {
        return res.status(422).send({ message: error.message, code: error.code });
      }
      throw error;
    }
    const idempotencyKey = readRequiredIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const commandRequest = {
      projectId,
      scriptId,
      model,
      resolution,
      audio,
      trackData,
      ...(structuredTimeline ? { structuredTimeline } : {}),
    };
    const pricingBinding: QuickCreatePricingConfirmationBinding = {
      kind: "video_batch",
      workspaceId,
      actorUserId,
      projectId,
      idempotencyKey,
      requestHash: hashIdempotencyRequest(commandRequest),
    };
    const pricingItemKeys = preparedTracks.map((track) => `track:${track.trackId}`);
    const pricingAuthorizations = new Map<number, QuickCreatePricingAuthorization>();
    const pricingContext = req.body.pricingConfirmation as {
      token?: string;
      acceptedUnitMaximumCostMicros?: number;
    } | undefined;
    if (pricingContext?.token) {
      try {
        const verified = verifyQuickCreatePricingConfirmation({
          token: pricingContext.token,
          binding: pricingBinding,
          expectedItemKeys: pricingItemKeys,
        });
        for (const track of preparedTracks) {
          pricingAuthorizations.set(track.trackId, {
            maximumCostMicros:
              verified.itemMaximumCostMicros[`track:${track.trackId}`] ?? null,
            expiresAt: verified.expiresAt,
          });
        }
      } catch (error) {
        if (error instanceof QuickCreatePricingTokenError) {
          return res.status(error.status).send({ message: error.message, code: error.code });
        }
        throw error;
      }
    } else {
      for (const track of preparedTracks) {
        pricingAuthorizations.set(track.trackId, {
          maximumCostMicros: pricingContext?.acceptedUnitMaximumCostMicros ?? null,
          expiresAt: null,
        });
      }
    }
    let privateValidationBudget: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding | null = null;
    try {
      privateValidationBudget = resolveReleaseFullMaintenancePrivateValidationPortraitBudgetBinding({
        header: req.headers[RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_HEADER],
        remoteAddress: req.socket.remoteAddress,
        workspaceId,
        projectId,
        actorUserId,
        idempotencyKey,
        body: req.body,
      });
      if (privateValidationBudget && preparedTracks.length !== 1) {
        throw new ReleaseFullMaintenancePrivateValidationBudgetTransportError(
          "private_validation_budget_transport_batch_forbidden",
          "私有验证预算只允许一个精确 Workbench 任务",
          409,
        );
      }
    } catch (error) {
      if (error instanceof ReleaseFullMaintenancePrivateValidationBudgetTransportError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }
    const checkpointExpected = {
      workspaceId,
      actorUserId,
      projectId,
      scriptId,
      trackIds: preparedTracks.map((track) => track.trackId),
      structuredTimelineBinding,
    };
    const initialCheckpoint = createQuickCreateVideoCheckpoint(checkpointExpected);
    let commandReservation: DurableCommandReservation<QuickCreateVideoTaskResult[]>;
    try {
      commandReservation = await beginDurableCommand<QuickCreateVideoTaskResult[]>({
        workspaceId,
        actorUserId,
        scope: QUICK_CREATE_VIDEO_BATCH_SCOPE,
        idempotencyKey,
        request: commandRequest,
        initialCheckpoint,
        resourceType: "project",
        resourceId: projectId,
      });
      if (commandReservation.kind === "replay") {
        if (commandReservation.responseStatus >= 400) {
          return res
            .status(commandReservation.responseStatus)
            .send(commandReservation.responseBody);
        }
        return res
          .status(commandReservation.responseStatus)
          .send(success(commandReservation.responseBody));
      }
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }

    if (
      commandReservation.kind === "reserved"
      || commandReservation.kind === "disabled"
    ) {
      return res.status(500).send({
        code: "idempotency_checkpoint_invalid",
        message: "视频生成命令未建立恢复检查点",
      });
    }
    const durableReservation = commandReservation;
    parseQuickCreateVideoCheckpoint(
      durableReservation.checkpoint,
      checkpointExpected,
    );

    type AdvanceResult =
      | { kind: "checkpoint"; checkpoint: QuickCreateVideoCommandCheckpoint }
      | { kind: "replay"; replay: QuickCreateReplayResponse };
    const advanceCheckpoint = async (
      mutate: (
        current: QuickCreateVideoCommandCheckpoint,
        transaction: Knex.Transaction,
      ) => Promise<QuickCreateVideoCommandCheckpoint>,
    ): Promise<AdvanceResult> => {
      const advanced = await mutateDurableCommandCheckpoint<
        QuickCreateVideoTaskResult[],
        QuickCreateVideoCommandCheckpoint
      >(durableReservation, async (current, transaction) => {
        const validated = parseQuickCreateVideoCheckpoint(current, checkpointExpected);
        return await mutate(validated, transaction);
      });
      if (advanced.kind === "replay") {
        return {
          kind: "replay",
          replay: {
            responseStatus: advanced.responseStatus,
            responseBody: advanced.responseBody,
          },
        };
      }
      return {
        kind: "checkpoint",
        checkpoint: parseQuickCreateVideoCheckpoint(
          advanced.checkpoint,
          checkpointExpected,
        ),
      };
    };
    const checkpointOrReplay = (advanced: AdvanceResult) => {
      if (advanced.kind === "replay") {
        throw new QuickCreateCommandReplayError(advanced.replay);
      }
      return advanced.checkpoint;
    };
    const sendReplay = (replay: QuickCreateReplayResponse) => (
      replay.responseStatus >= 400
        ? res.status(replay.responseStatus).send(replay.responseBody)
        : res.status(replay.responseStatus).send(success(replay.responseBody))
    );

    // Validate the whole batch under the shared project lock before any
    // worker can create a local video or dispatch Relay work. Once this
    // succeeds, the active durable checkpoint itself fences deletion of all
    // listed tracks until the command reaches a terminal response.
    try {
      const fenced = await advanceCheckpoint(async (current, transaction) => {
        for (const track of [...preparedTracks]
          .sort((left, right) => left.trackId - right.trackId)) {
          await lockActiveQuickCreateVideoTarget(transaction, {
            workspaceId,
            projectId,
            scriptId,
            trackId: track.trackId,
          });
        }
        return current;
      });
      if (fenced.kind === "replay") return sendReplay(fenced.replay);
    } catch (error) {
      if (error instanceof QuickCreateVideoMutationFenceError) {
        const body = { message: error.message, code: error.code };
        await completeDurableCommand(durableReservation, body as any, error.status);
        return res.status(error.status).send(body);
      }
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }

    try {
      const settled = await settleOrderedServerBatch({
        items: preparedTracks,
        concurrency: QUICK_CREATE_LIMITS.maxConcurrency,
        worker: async (track): Promise<QuickCreateVideoTaskResult> => {
        let nextCheckpoint = checkpointOrReplay(await advanceCheckpoint(async (current, transaction) => {
          await lockActiveQuickCreateVideoTarget(transaction, {
            workspaceId,
            projectId,
            scriptId,
            trackId: track.trackId,
          });
          const stored = checkpointTrack(current, track.trackId);
          if (stored.result) return current;
          if (stored.cancelRequested && stored.phase !== "dispatching") {
            const cancellation: QuickCreateVideoTaskResult = {
              ...(stored.videoId ? { videoId: stored.videoId } : {}),
              trackId: track.trackId,
              status: "cancelled",
              state: "已取消",
              errorCode: "video_batch_item_cancelled",
              errorReason: "任务已在上游派发前取消",
            };
            if (stored.videoId) {
              await transaction("o_video")
                .where({
                  id: stored.videoId,
                  projectId,
                  scriptId,
                  videoTrackId: track.trackId,
                })
                .update({
                  state: "已取消",
                  errorReason: cancellation.errorReason,
                });
            }
            return replaceCheckpointTrack(current, track.trackId, (item) => ({
              ...item,
              phase: "cancelled",
              cancelRequested: true,
              result: cancellation,
              updatedAt: Date.now(),
            }));
          }
          if (stored.videoId) {
            const video = await transaction("o_video")
              .where({
                id: stored.videoId,
                projectId,
                scriptId,
                videoTrackId: track.trackId,
              })
              .forUpdate()
              .select("id", "relayTaskId")
              .first();
            if (!video) {
              throw new DurableCommandIdempotencyError(
                409,
                "idempotency_checkpoint_invalid",
                "视频生成恢复检查点引用的本地任务不存在",
              );
            }
            const boundRelayTaskId = String(video.relayTaskId || "").trim();
            if (
              stored.relayTaskId
              && boundRelayTaskId
              && stored.relayTaskId !== boundRelayTaskId
            ) {
              throw new DurableCommandIdempotencyError(
                409,
                "idempotency_checkpoint_invalid",
                "视频生成恢复检查点与本地 Relay 绑定不一致",
              );
            }
            if (!stored.relayTaskId && boundRelayTaskId) {
              const relay = await transaction("o_relay_task")
                .where({
                  id: boundRelayTaskId,
                  workspaceId,
                  projectId,
                  endpointType: "video_generation",
                })
                .select("id", "requestId")
                .first();
              const requestPrefix = `quick-create:${projectId}:${scriptId}:${track.trackId}:${stored.videoId}:`;
              if (!relay || !String(relay.requestId || "").startsWith(requestPrefix)) {
                throw new DurableCommandIdempotencyError(
                  409,
                  "idempotency_checkpoint_invalid",
                  "本地视频绑定了不属于本次命令的 Relay 任务",
                );
              }
              return replaceCheckpointTrack(current, track.trackId, (item) => ({
                ...item,
                relayTaskId: boundRelayTaskId,
                phase: "submitted",
                updatedAt: Date.now(),
              }));
            }
            if (stored.phase === "queued") {
              return replaceCheckpointTrack(current, track.trackId, (item) => ({
                ...item,
                phase: "preparing",
                updatedAt: Date.now(),
              }));
            }
            return current;
          }
          // A different client key must not create a second local/Relay
          // identity while this semantic track submission is waiting for
          // its upstream result. Rebind the new durable command to the already
          // persisted video; createRelayTask will then replay the original
          // deterministic requestId instead of reserving GU again.
          const pendingVideo = await transaction("o_video")
            .where({
              projectId,
              scriptId,
              videoTrackId: track.trackId,
            })
            .whereNotNull("relayTaskId")
            .where("errorReason", "like", "%请勿重复提交%")
            .orderBy("time", "desc")
            .select("id", "relayTaskId")
            .first();
          if (pendingVideo) {
            return replaceCheckpointTrack(current, track.trackId, (item) => ({
              ...item,
              videoId: Number(pendingVideo.id),
              relayTaskId: String(pendingVideo.relayTaskId),
              phase: "pending_reconcile",
              updatedAt: Date.now(),
            }));
          }
          const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
          const videoId = await insertAndReturnId(transaction, "o_video", {
            filePath: videoPath,
            time: Date.now(),
            state: "生成中",
            scriptId,
            projectId,
            videoTrackId: track.trackId,
          });
          return replaceCheckpointTrack(current, track.trackId, (item) => ({
            ...item,
            videoId,
            phase: "preparing",
            updatedAt: Date.now(),
          }));
        }));
        let currentTrack = checkpointTrack(nextCheckpoint, track.trackId);
        if (currentTrack.result) return currentTrack.result;
        const videoId = Number(currentTrack.videoId);
        if (!Number.isSafeInteger(videoId) || videoId <= 0) {
          throw new DurableCommandIdempotencyError(
            500,
            "idempotency_checkpoint_invalid",
            "视频生成恢复检查点缺少本地任务",
          );
        }

        nextCheckpoint = checkpointOrReplay(await advanceCheckpoint(async (current, transaction) => {
          const stored = checkpointTrack(current, track.trackId);
          if (stored.result) return current;
          if (stored.videoId !== videoId) {
            throw new DurableCommandIdempotencyError(
              409,
              "idempotency_checkpoint_invalid",
              "视频生成恢复检查点的本地任务已变化",
            );
          }
          // Once dispatching is durable, an upstream acceptance may already
          // exist. A concurrent cancel must discover the deterministic Relay
          // identity and cancel that task rather than claiming a false local
          // cancellation.
          if (
            stored.cancelRequested
            && !stored.relayTaskId
            && stored.phase !== "dispatching"
          ) {
            const cancellation: QuickCreateVideoTaskResult = {
              videoId,
              trackId: track.trackId,
              status: "cancelled",
              state: "已取消",
              errorCode: "video_batch_item_cancelled",
              errorReason: "任务已在上游派发前取消",
            };
            await transaction("o_video")
              .where({
                id: videoId,
                projectId,
                scriptId,
                videoTrackId: track.trackId,
              })
              .update({
                state: "已取消",
                errorReason: cancellation.errorReason,
              });
            return replaceCheckpointTrack(current, track.trackId, (item) => ({
              ...item,
              phase: "cancelled",
              result: cancellation,
              updatedAt: Date.now(),
            }));
          }
          if (stored.relayTaskId || stored.phase === "dispatching") return current;
          return replaceCheckpointTrack(current, track.trackId, (item) => ({
            ...item,
            phase: "dispatching",
            updatedAt: Date.now(),
          }));
        }));
        currentTrack = checkpointTrack(nextCheckpoint, track.trackId);
        if (currentTrack.result) return currentTrack.result;

        let taskResult: QuickCreateVideoTaskResult;
        try {
          // The request id inside createWorkbenchRelayVideoTask is derived from
          // this checkpointed videoId. Retrying after an ambiguous provider
          // response therefore resolves the same Relay row and never submits a
          // second upstream task.
          const relayTask = await createWorkbenchRelayVideoTask({
            actorUserId,
            projectId,
            scriptId,
            videoId,
            trackId: track.trackId,
            uploadData: [],
            referenceContent: track.referenceContent,
            prompt: track.canonical.request.prompt,
            model,
            mode: track.selectedMode,
            canonicalRequest: track.canonical.request,
            trustedVideoAssetPolicyEvidence: track.resolvedReferences.trustedPolicyEvidence,
            ...(privateValidationBudget
              ? { trustedPrivateValidationBudget: privateValidationBudget }
              : {}),
            ...(structuredTimelineBinding
              ? {
                structuredTimelineContext: createStructuredTimelineRelayContext({
                  binding: structuredTimelineBinding,
                  trackId: track.trackId,
                  canonicalRequestDigest: videoGenerationRequestDigest(track.canonical.request),
                }),
              }
              : {}),
            duration: track.canonical.request.durationSeconds,
            resolution: track.canonical.request.outputResolution,
            audio: track.canonical.request.generateAudio,
            requestIdPrefix: "quick-create",
            requireQuickCreatePricingConfirmation: true,
            trustedQuickCreatePricingAuthorization:
              pricingAuthorizations.get(track.trackId) ?? null,
          }, {
            workspaceId,
            model,
            requestPayload: track.requestPayload,
            relayAdapterBinding: track.relayAdapterBinding,
          });
          nextCheckpoint = checkpointOrReplay(await advanceCheckpoint(async (current, transaction) => {
            const stored = checkpointTrack(current, track.trackId);
            if (stored.result) return current;
            if (stored.videoId !== videoId) {
              throw new DurableCommandIdempotencyError(
                409,
                "idempotency_checkpoint_invalid",
                "视频生成恢复检查点的本地任务已变化",
              );
            }
            if (stored.relayTaskId && stored.relayTaskId !== relayTask.id) {
              throw new DurableCommandIdempotencyError(
                409,
                "idempotency_checkpoint_invalid",
                "视频生成恢复检查点的 Relay 任务已变化",
              );
            }
            const video = await transaction("o_video")
              .where({
                id: videoId,
                projectId,
                scriptId,
                videoTrackId: track.trackId,
              })
              .forUpdate()
              .select("id", "relayTaskId")
              .first();
            if (!video) {
              throw new DurableCommandIdempotencyError(
                409,
                "idempotency_checkpoint_invalid",
                "待绑定的本地视频任务不存在",
              );
            }
            const existingRelayTaskId = String(video.relayTaskId || "").trim();
            if (existingRelayTaskId && existingRelayTaskId !== relayTask.id) {
              throw new DurableCommandIdempotencyError(
                409,
                "idempotency_checkpoint_invalid",
                "本地视频已绑定其他 Relay 任务",
              );
            }
            if (!existingRelayTaskId) {
              const updated = await transaction("o_video")
                .where({
                  id: videoId,
                  projectId,
                  scriptId,
                  videoTrackId: track.trackId,
                })
                .whereNull("relayTaskId")
                .update({ relayTaskId: relayTask.id });
              if (Number(updated) !== 1) {
                throw new DurableCommandIdempotencyError(
                  409,
                  "idempotency_checkpoint_conflict",
                  "本地视频与 Relay 任务绑定发生竞争",
                );
              }
            }
            return replaceCheckpointTrack(current, track.trackId, (item) => ({
              ...item,
              relayTaskId: relayTask.id,
              phase: "submitted",
              updatedAt: Date.now(),
            }));
          }));

          currentTrack = checkpointTrack(nextCheckpoint, track.trackId);
          let relayTaskForOutcome = relayTask;
          if (currentTrack.cancelRequested) {
            const cancellation = await cancelOrDeleteRelayTask(relayTask.id, {
              actorUserId: Number((req as any).auth?.user?.id || 0),
            });
            if (cancellation.task) relayTaskForOutcome = cancellation.task;
          }

          const synced = await syncWorkbenchVideoRelay({
            id: videoId,
            state: "生成中",
            relayTaskId: relayTask.id,
          });
          const outcome = resolveRelaySubmissionOutcome({
            status: (synced as any).relayStatus || relayTaskForOutcome.status,
            billingState: (synced as any).relayBillingState,
            providerPayload: relayTaskForOutcome.providerPayload,
          });
          const syncedState = String((synced as any).state || "");
          if (!outcome.accepted && !outcome.succeeded) {
            const publicReason = outcome.message || "视频生成任务创建失败，请稍后重试";
            const executionState = outcome.status === "pending_reconcile" ? "生成中" : "生成失败";
            if (syncedState !== executionState || outcome.status === "pending_reconcile") {
              await u.db("o_video").where({
                id: videoId,
                projectId,
                scriptId,
                videoTrackId: track.trackId,
                relayTaskId: relayTask.id,
              }).update({
                state: executionState,
                errorReason: publicReason,
              });
              if (executionState === "生成失败") await syncVideoTaskState(videoId, executionState, publicReason);
            }
            taskResult = {
              videoId,
              trackId: track.trackId,
              relayTaskId: relayTask.id,
              status: outcome.status,
              state: executionState,
              errorCode: outcome.code || "relay_task_failed",
              errorReason: publicReason,
            };
          } else if (syncedState === "生成失败") {
            taskResult = {
              videoId,
              trackId: track.trackId,
              relayTaskId: relayTask.id,
              status: "failed",
              state: syncedState,
              errorCode: "relay_task_delivery_missing",
              errorReason: "生成任务成功但未返回视频地址",
            };
          } else if (outcome.succeeded) {
            taskResult = {
              videoId,
              trackId: track.trackId,
              relayTaskId: relayTask.id,
              status: outcome.status,
              state: syncedState || "生成成功",
            };
          } else {
            taskResult = {
              videoId,
              trackId: track.trackId,
              relayTaskId: relayTask.id,
              preparationStage: (synced as any).preparationStage ?? null,
              statusMessage: (synced as any).statusMessage ?? null,
            };
          }
        } catch (error) {
          if (error instanceof QuickCreatePricingConfirmationError) throw error;
          if (error instanceof VideoAssetPolicyError || error instanceof VideoAssetPolicyRelayBindingError) {
            // Keep the checkpoint and the original client key. Admission is
            // checked before a new Relay task or billing reservation exists;
            // an expected preparation delay is not an ambiguous provider POST.
            throw new DurableCommandIdempotencyError(
              error.status,
              error.code,
              error.code === "portrait_provider_binding_pending"
                ? "参考人物素材正在准备，完成后可继续生成，请稍后重试"
                : error.message,
            );
          }
          if (error instanceof BillingError && error.status === 402) {
            const details = publicBillingErrorDetails(error);
            const body = {
              message: error.message,
              code: "video_task_insufficient_balance" as const,
              ...(details
                ? { data: details }
                : {}),
            };
            await u.db("o_video").where({
              id: videoId,
              projectId,
              scriptId,
              videoTrackId: track.trackId,
            }).update({ state: "生成失败", errorReason: error.message });
            await syncVideoTaskState(videoId, "生成失败", error.message);
            if (preparedTracks.length === 1) throw new QuickCreateBillingStopError(body);
            taskResult = {
              videoId,
              trackId: track.trackId,
              status: "failed",
              state: "生成失败",
              errorCode: body.code,
              errorReason: body.message,
              ...(details ? { billing: details } : {}),
            };
          } else {
            if (
              error instanceof DurableCommandIdempotencyError
              || error instanceof QuickCreateCommandReplayError
            ) throw error;
            console.error("[workbench.create.videos] relay submission failed", {
              name: error instanceof Error ? error.name : "unknown",
              code: error && typeof error === "object" && "code" in error
                ? String((error as { code?: unknown }).code || "")
                : "",
              status: error && typeof error === "object" && "status" in error
                ? Number((error as { status?: unknown }).status || 0)
                : 0,
            });
            throw new DurableCommandIdempotencyError(
              503,
              "video_submission_recovery_required",
              "视频任务提交状态暂时无法确认，请稍后刷新任务状态",
            );
          }
        }

        nextCheckpoint = checkpointOrReplay(await advanceCheckpoint(async (current) => {
          const stored = checkpointTrack(current, track.trackId);
          if (stored.result) return current;
          if (
            stored.videoId !== taskResult.videoId
            || (
              taskResult.relayTaskId != null
              && stored.relayTaskId !== taskResult.relayTaskId
            )
          ) {
            throw new DurableCommandIdempotencyError(
              409,
              "idempotency_checkpoint_invalid",
              "视频生成结果与恢复检查点不一致",
            );
          }
          return replaceCheckpointTrack(current, track.trackId, (item) => ({
            ...item,
            result: taskResult,
            phase: quickCreateVideoResultPhase(taskResult),
            updatedAt: Date.now(),
          }));
        }));
        const storedResult = checkpointTrack(nextCheckpoint, track.trackId).result;
        if (!storedResult) {
          throw new DurableCommandIdempotencyError(
            500,
            "idempotency_checkpoint_invalid",
            "视频生成恢复检查点缺少任务结果",
          );
        }
        return storedResult;
        },
      });

      const replayFailure = settled.find(
        (entry) => entry.status === "rejected"
          && entry.reason instanceof QuickCreateCommandReplayError,
      );
      if (
        replayFailure?.status === "rejected"
        && replayFailure.reason instanceof QuickCreateCommandReplayError
      ) {
        return sendReplay(replayFailure.reason.replay);
      }
      const pricingFailures = settled.flatMap((entry, index) => (
        entry.status === "rejected"
        && entry.reason instanceof QuickCreatePricingConfirmationError
          ? [{ index, error: entry.reason }]
          : []
      ));
      if (pricingFailures.length > 0) {
        // Relay resolves the final provider/time-window price before it writes
        // a Relay task or freezes GU. Remove the local placeholder created for
        // each rejected item as well, so a consent challenge never leaves a
        // user-visible generation task behind. Confirmed retries recreate the
        // same semantic item under the unchanged durable command.
        const reset = await advanceCheckpoint(async (current, transaction) => {
          let next = current;
          for (const { index } of pricingFailures) {
            const track = preparedTracks[index];
            const stored = checkpointTrack(next, track.trackId);
            if (stored.result || stored.relayTaskId) {
              throw new DurableCommandIdempotencyError(
                409,
                "idempotency_checkpoint_invalid",
                "价格确认失败的镜头已经绑定生成任务",
              );
            }
            if (stored.videoId) {
              const deleted = await transaction("o_video")
                .where({
                  id: stored.videoId,
                  projectId,
                  scriptId,
                  videoTrackId: track.trackId,
                })
                .whereNull("relayTaskId")
                .del();
              if (deleted !== 1) {
                throw new DurableCommandIdempotencyError(
                  409,
                  "idempotency_checkpoint_invalid",
                  "价格确认失败的本地视频任务不能安全回收",
                );
              }
            }
            next = replaceCheckpointTrack(next, track.trackId, (item) => ({
              ...item,
              videoId: null,
              phase: "queued",
              updatedAt: Date.now(),
            }));
          }
          return next;
        });
        if (reset.kind === "replay") return sendReplay(reset.replay);
        const requiredByIndex = new Map(
          pricingFailures.map(({ index, error }) => [index, error.requiredCostMicros]),
        );
        const itemMaximumCostMicros = Object.fromEntries(
          preparedTracks.map((track, index) => [
            `track:${track.trackId}`,
            requiredByIndex.get(index)
              ?? pricingAuthorizations.get(track.trackId)?.maximumCostMicros
              ?? 0,
          ]),
        );
        const challenge = issueQuickCreatePricingConfirmation({
          binding: pricingBinding,
          itemMaximumCostMicros,
        });
        return res.status(409).send(quickCreatePricingChallengeBody(challenge));
      }
      const billingFailure = settled.find(
        (entry) => entry.status === "rejected"
          && entry.reason instanceof QuickCreateBillingStopError,
      );
      if (
        billingFailure?.status === "rejected"
        && billingFailure.reason instanceof QuickCreateBillingStopError
      ) {
        await completeDurableCommand(
          durableReservation,
          billingFailure.reason.body as any,
          402,
        );
        return res.status(402).send(billingFailure.reason.body);
      }
      const firstFailure = settled.find((entry) => entry.status === "rejected");
      if (firstFailure?.status === "rejected") throw firstFailure.reason;

      // Re-read the locked checkpoint after every worker settles. This makes
      // response ordering deterministic and includes any queued cancellation
      // that won before command completion.
      const finalCheckpoint = checkpointOrReplay(await advanceCheckpoint(async (current) => current));
      const tasks = preparedTracks.map((track) => {
        const result = checkpointTrack(finalCheckpoint, track.trackId).result;
        if (!result) {
          throw new DurableCommandIdempotencyError(
            500,
            "idempotency_checkpoint_invalid",
            "视频生成批次缺少逐项结果",
          );
        }
        return result;
      });

      await completeDurableCommand(durableReservation, tasks);
      return res.status(200).send(success(tasks));
    } catch (error) {
      if (error instanceof QuickCreateVideoMutationFenceError) {
        const body = { message: error.message, code: error.code };
        await completeDurableCommand(durableReservation, body as any, error.status);
        return res.status(error.status).send(body);
      }
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }
  },
);

const batchAuthorityFields = {
  projectId: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
};

router.post(
  "/batch/status",
  requireProjectPermission("project:read"),
  validateFields(batchAuthorityFields),
  async (req, res) => {
    try {
      const batch = await readQuickCreateVideoBatch({
        workspaceId: String(
          (req as any).project?.workspaceId
          || (req as any).auth?.workspaceId
          || "",
        ),
        actorUserId: Number((req as any).auth?.user?.id || 0),
        projectId: Number(req.body.projectId),
        idempotencyKey: String(req.body.idempotencyKey || ""),
      });
      return res.status(200).send(success(batch));
    } catch (error) {
      if (error instanceof QuickCreateVideoBatchControlError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }
  },
);

router.post(
  "/batch/cancel",
  requireProjectPermission("generation:create"),
  validateFields({
    ...batchAuthorityFields,
    trackIds: z.array(z.number().int().positive())
      .max(QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS)
      .refine((items) => new Set(items).size === items.length, {
        message: "取消镜头不能重复",
      })
      .optional(),
  }),
  async (req, res) => {
    try {
      const result = await cancelQuickCreateVideoBatch({
        workspaceId: String(
          (req as any).project?.workspaceId
          || (req as any).auth?.workspaceId
          || "",
        ),
        actorUserId: Number((req as any).auth?.user?.id || 0),
        projectId: Number(req.body.projectId),
        idempotencyKey: String(req.body.idempotencyKey || ""),
        ...(Array.isArray(req.body.trackIds)
          ? { trackIds: req.body.trackIds.map(Number) }
          : {}),
      });
      return res.status(200).send(success(result));
    } catch (error) {
      if (error instanceof QuickCreateVideoBatchControlError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }
  },
);

export default router;
