import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

import u from "@/utils";
import { db } from "@/utils/db";
import {
  beginDurableCommand,
  checkpointDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import { insertAndReturnId } from "@/lib/dbDialect";
import {
  buildDirectorTrackConstraint,
  loadDirectorSceneV1,
} from "@/lib/directorSceneV1";
import {
  GENERATION_REFERENCE_ROLES,
  GenerationReferenceError,
} from "@/lib/generationReferenceResolver";
import { getRelayTask, type RelayTask } from "@/lib/relay";
import { resolveRelaySubmissionOutcome } from "@/lib/relaySubmissionOutcome";
import { success } from "@/lib/responseFormat";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { bindProductionVideoReferences } from "@/lib/productionVideoReferences";
import { canonicalVideoGenerationRequest, type VideoGenerationRequest } from "@/lib/videoGenerationContract";
import { syncVideoTaskState } from "@/lib/videoTaskState";
import {
  createWorkbenchRelayVideoTask,
  prepareWorkbenchRelayVideoTask,
  syncWorkbenchVideoRelay,
  type PreparedWorkbenchRelayVideoTask,
  type WorkbenchRelayInput,
} from "@/lib/workbenchVideoRelay";
import { readRequiredIdempotencyKey } from "@/middleware/idempotencyKey";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

const COMMAND_SCOPE = "production:workbench:batch-generate-video";
const COMMAND_CHECKPOINT_VERSION = "production-workbench-video-command.v1";
const RESERVED_COMMAND_STALE_AFTER_MS = 30_000;
const PUBLIC_SUBMISSION_FAILURE = "视频生成任务创建失败，请稍后重试";
const PUBLIC_RECOVERY_REQUIRED = "视频任务提交状态待核对，请使用相同 Idempotency-Key 重试";

type ProductionTrackInput = {
  uploadData: {
    id: number;
    sources: string;
    role?: "subject" | "style" | "storyboard" | "first_frame" | "last_frame";
  }[];
  trackId: number;
  prompt: string;
  duration: number;
};

export async function loadAuthoritativeProductionTrackData(input: {
  projectId: number;
  scriptId: number;
  trackData: ProductionTrackInput[];
}): Promise<ProductionTrackInput[]> {
  const directorScene = await loadDirectorSceneV1(db, input.projectId);
  const requestedTrackIds = [
    ...new Set(input.trackData.map((track) => Number(track.trackId))),
  ];
  const rows = requestedTrackIds.length
    ? await db("o_videoTrack")
        .where({
          projectId: input.projectId,
          scriptId: input.scriptId,
        })
        .whereIn("id", requestedTrackIds)
        .select("id", "prompt", "duration")
    : [];
  const byId = new Map(rows.map((row: any) => [Number(row.id), row]));
  if (
    byId.size !== requestedTrackIds.length
    || requestedTrackIds.some((trackId) => !byId.has(trackId))
  ) {
    throw new GenerationReferenceError(
      404,
      "video_track_not_found",
      "剧本或镜头不存在",
    );
  }
  return input.trackData.map((requested) => {
    const row = byId.get(Number(requested.trackId));
    const prompt = String(row?.prompt || "").trim();
    const duration = Number(row?.duration || 0);
    if (!prompt || !Number.isFinite(duration) || duration <= 0) {
      throw new GenerationReferenceError(
        409,
        "video_track_not_ready",
        "生产轨道缺少有效提示词或时长，请先保存分镜编辑",
      );
    }
    const directorConstraint = directorScene
      ? buildDirectorTrackConstraint(
          directorScene,
          input.scriptId,
          Number(requested.trackId),
        )
      : null;
    return {
      ...requested,
      // Prompt/duration are production authority. Never trust a stale browser
      // snapshot after storyboard edits have updated the bound track.
      prompt: directorConstraint
        ? `${prompt}\n\n${directorConstraint.text}`
        : prompt,
      duration,
    };
  });
}

type ProductionVideoCommandResult = {
  videoId: number;
  trackId: number;
  relayTaskId?: string;
  errorReason?: string;
};

type ProductionVideoCheckpoint = {
  version: typeof COMMAND_CHECKPOINT_VERSION;
  workspaceId: string;
  projectId: number;
  scriptId: number;
  videos: Array<{
    videoId: number;
    trackId: number;
    canonicalRequest?: VideoGenerationRequest;
    preparedRelayTask?: Pick<
      PreparedWorkbenchRelayVideoTask,
      "workspaceId" | "model" | "requestPayload"
    >;
  }>;
};

type ProductionVideoCommandReservation =
  DurableCommandReservation<ProductionVideoCommandResult[]>;

const checkpointSchema = z.object({
  version: z.literal(COMMAND_CHECKPOINT_VERSION),
  workspaceId: z.string().trim().min(1),
  projectId: z.number().int().positive(),
  scriptId: z.number().int().positive(),
  videos: z.array(z.object({
    videoId: z.number().int().positive(),
    trackId: z.number().int().positive(),
    canonicalRequest: z.custom<VideoGenerationRequest>((value) => {
      try { canonicalVideoGenerationRequest(value as VideoGenerationRequest); return true; } catch { return false; }
    }).optional(),
    preparedRelayTask: z.object({
      workspaceId: z.string().trim().min(1),
      model: z.string().trim().min(1),
      requestPayload: z.record(z.string(), z.unknown()),
    }).optional(),
  })),
});

type ProductionVideoFailpoint =
  | "after_reservation"
  | "after_checkpoint"
  | "after_relay_task"
  | "after_relay_binding"
  | "after_completion";

class ProductionVideoCommandFailpointError extends Error {
  constructor(stage: ProductionVideoFailpoint) {
    super(`FANJIN_TEST_PRODUCTION_VIDEO_COMMAND_FAILPOINT:${stage}`);
    this.name = "ProductionVideoCommandFailpointError";
  }
}

function throwProductionVideoCommandFailpoint(stage: ProductionVideoFailpoint): void {
  if (
    process.env.NODE_ENV === "test"
    && process.env.FANJIN_TEST_PRODUCTION_VIDEO_COMMAND_FAILPOINT === stage
  ) {
    throw new ProductionVideoCommandFailpointError(stage);
  }
}

function invalidCheckpoint(message: string): DurableCommandIdempotencyError {
  return new DurableCommandIdempotencyError(
    500,
    "idempotency_checkpoint_invalid",
    message,
  );
}

function parseProductionVideoCheckpoint(input: {
  checkpoint: unknown;
  workspaceId: string;
  projectId: number;
  scriptId: number;
  relayInputs: WorkbenchRelayInput[];
}): ProductionVideoCheckpoint {
  const parsed = checkpointSchema.safeParse(input.checkpoint);
  if (!parsed.success) {
    throw invalidCheckpoint("视频生成恢复检查点格式无效");
  }
  const checkpoint = parsed.data;
  if (
    checkpoint.workspaceId !== input.workspaceId
    || checkpoint.projectId !== input.projectId
    || checkpoint.scriptId !== input.scriptId
    || checkpoint.videos.length !== input.relayInputs.length
    || checkpoint.videos.some(
      (video, index) => video.trackId !== input.relayInputs[index]?.trackId,
    )
    || checkpoint.videos.some(
      (video) => video.preparedRelayTask
        && video.preparedRelayTask.workspaceId !== input.workspaceId,
    )
  ) {
    throw invalidCheckpoint("视频生成恢复检查点与当前项目或镜头不一致");
  }
  return checkpoint;
}

async function reserveProductionVideoRows(input: {
  reservation: ProductionVideoCommandReservation;
  workspaceId: string;
  projectId: number;
  scriptId: number;
  relayInputs: WorkbenchRelayInput[];
  preparedRelayTasks: PreparedWorkbenchRelayVideoTask[];
}): Promise<{
  reservation: ProductionVideoCommandReservation;
  checkpoint: ProductionVideoCheckpoint;
}> {
  return await db.transaction(async (transaction) => {
    if (input.preparedRelayTasks.length !== input.relayInputs.length) {
      throw invalidCheckpoint("视频生成预检快照与镜头数量不一致");
    }
    const project = await transaction("o_project")
      .where({
        id: input.projectId,
        workspaceId: input.workspaceId,
      })
      .forUpdate()
      .select("id", "workspaceId", "deletionState")
      .first();
    if (!project) {
      throw new GenerationReferenceError(
        404,
        "project_not_found",
        "项目不存在或不属于当前工作区",
      );
    }
    if (String(project.deletionState || "") !== "active") {
      throw new GenerationReferenceError(
        409,
        "project_not_active",
        "项目正在删除，不能创建视频任务",
      );
    }

    const requestedTrackIds = [
      ...new Set(input.relayInputs.map((relayInput) => relayInput.trackId)),
    ];
    const trackRows = requestedTrackIds.length
      ? await transaction("o_videoTrack")
          .where({
            projectId: input.projectId,
            scriptId: input.scriptId,
          })
          .whereIn("id", requestedTrackIds)
          .select("id")
      : [];
    const foundTrackIds = new Set(trackRows.map((row: any) => Number(row.id)));
    if (
      foundTrackIds.size !== requestedTrackIds.length
      || requestedTrackIds.some((trackId) => !foundTrackIds.has(trackId))
    ) {
      throw new GenerationReferenceError(
        404,
        "video_track_not_found",
        "剧本或镜头不存在",
      );
    }

    const videos: ProductionVideoCheckpoint["videos"] = [];
    for (let index = 0; index < input.relayInputs.length; index += 1) {
      const relayInput = input.relayInputs[index];
      const preparedRelayTask = input.preparedRelayTasks[index];
      if (
        !relayInput
        || !preparedRelayTask
        || preparedRelayTask.workspaceId !== input.workspaceId
      ) {
        throw invalidCheckpoint("视频生成预检快照不属于当前工作区");
      }
      const videoId = await insertAndReturnId(transaction, "o_video", {
        filePath: `/${input.projectId}/video/${uuidv4()}.mp4`,
        time: Date.now(),
        // The row is only a durable local reservation until a Relay task is
        // bound. Keeping it retryable avoids a crash leaving a false
        // "生成中" task with no cancellable/upstream identity.
        state: "未生成",
        scriptId: input.scriptId,
        projectId: input.projectId,
        videoTrackId: relayInput.trackId,
      });
      videos.push({
        videoId,
        trackId: relayInput.trackId,
        canonicalRequest: relayInput.canonicalRequest,
        preparedRelayTask: {
          workspaceId: preparedRelayTask.workspaceId,
          model: preparedRelayTask.model,
          requestPayload: preparedRelayTask.requestPayload,
        },
      });
    }

    const checkpoint: ProductionVideoCheckpoint = {
      version: COMMAND_CHECKPOINT_VERSION,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      scriptId: input.scriptId,
      videos,
    };
    const reservation = await checkpointDurableCommand(
      input.reservation,
      checkpoint,
      { database: transaction as typeof db },
    );
    return { reservation, checkpoint };
  });
}

async function loadCheckpointVideo(input: {
  checkpointVideo: ProductionVideoCheckpoint["videos"][number];
  projectId: number;
  scriptId: number;
}) {
  const video = await u.db("o_video")
    .where({
      id: input.checkpointVideo.videoId,
      projectId: input.projectId,
      scriptId: input.scriptId,
      videoTrackId: input.checkpointVideo.trackId,
    })
    .select(
      "id",
      "projectId",
      "scriptId",
      "videoTrackId",
      "state",
      "errorReason",
      "relayTaskId",
    )
    .first();
  if (!video) {
    throw invalidCheckpoint("视频生成恢复检查点对应的任务记录不存在");
  }
  return video;
}

function assertRelayTaskAuthority(input: {
  task: RelayTask;
  relayTaskId?: string | null;
  workspaceId: string;
  projectId: number;
}) {
  if (!String(input.task.id || "").trim()) {
    throw invalidCheckpoint("Relay 任务缺少有效标识");
  }
  if (input.relayTaskId && input.task.id !== input.relayTaskId) {
    throw invalidCheckpoint("视频任务与 Relay 绑定不一致");
  }
  if (String(input.task.workspaceId || "") !== input.workspaceId) {
    throw invalidCheckpoint("Relay 任务不属于当前工作区");
  }
  if (Number(input.task.projectId) !== input.projectId) {
    throw invalidCheckpoint("Relay 任务不属于当前项目");
  }
}

async function bindRelayTaskToVideo(input: {
  videoId: number;
  trackId: number;
  relayTaskId: string;
  workspaceId: string;
  projectId: number;
  scriptId: number;
}): Promise<void> {
  await db.transaction(async (transaction) => {
    const project = await transaction("o_project")
      .where({
        id: input.projectId,
        workspaceId: input.workspaceId,
      })
      .forUpdate()
      .select("id", "deletionState")
      .first();
    if (!project || String(project.deletionState || "") !== "active") {
      throw new GenerationReferenceError(
        409,
        "project_not_active",
        "项目正在删除，不能绑定视频任务",
      );
    }
    const video = await transaction("o_video")
      .where({
        id: input.videoId,
        projectId: input.projectId,
        scriptId: input.scriptId,
        videoTrackId: input.trackId,
      })
      .forUpdate()
      .select("id", "relayTaskId")
      .first();
    if (!video) {
      throw invalidCheckpoint("待绑定的视频任务不存在");
    }
    const currentRelayTaskId = String(video.relayTaskId || "").trim();
    if (currentRelayTaskId && currentRelayTaskId !== input.relayTaskId) {
      throw invalidCheckpoint("视频任务已经绑定了其他 Relay 任务");
    }
    if (!currentRelayTaskId) {
      const updated = await transaction("o_video")
        .where({
          id: input.videoId,
          projectId: input.projectId,
          scriptId: input.scriptId,
          videoTrackId: input.trackId,
        })
        .whereNull("relayTaskId")
        .update({
          relayTaskId: input.relayTaskId,
          state: "生成中",
          errorReason: null,
        });
      if (Number(updated) !== 1) {
        throw invalidCheckpoint("视频与 Relay 任务绑定发生竞争，请使用原请求重试");
      }
    }
  });
}

async function markProductionVideoFailed(input: {
  videoId: number;
  projectId: number;
  reason: string;
}): Promise<void> {
  await u.db("o_video")
    .where({
      id: input.videoId,
      projectId: input.projectId,
    })
    .update({
      state: "生成失败",
      errorReason: input.reason,
    });
  await syncVideoTaskState(input.videoId, "生成失败", input.reason);
}

async function abandonUncheckpointedProductionCommand(
  reservation: ProductionVideoCommandReservation,
): Promise<void> {
  if (reservation.kind !== "reserved") return;
  await db("o_agent_idempotency")
    .where({ id: reservation.id, status: "reserved" })
    .del();
}

async function processProductionVideo(input: {
  reservation: ProductionVideoCommandReservation;
  checkpointVideo: ProductionVideoCheckpoint["videos"][number];
  relayInput: WorkbenchRelayInput;
  workspaceId: string;
  projectId: number;
  scriptId: number;
}): Promise<ProductionVideoCommandResult> {
  let video = await loadCheckpointVideo({
    checkpointVideo: input.checkpointVideo,
    projectId: input.projectId,
    scriptId: input.scriptId,
  });
  let relayTask: RelayTask;
  const boundRelayTaskId = String(video.relayTaskId || "").trim();

  if (boundRelayTaskId) {
    const existingRelayTask = await getRelayTask(boundRelayTaskId);
    if (!existingRelayTask) {
      throw invalidCheckpoint(
        "视频已绑定的 Relay 任务不存在，已阻止重复创建上游任务",
      );
    }
    assertRelayTaskAuthority({
      task: existingRelayTask,
      relayTaskId: boundRelayTaskId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    });
    relayTask = existingRelayTask;
  } else {
    try {
      const boundInput = await bindProductionVideoReferences({
        ...input.relayInput,
        videoId: input.checkpointVideo.videoId,
      }, input.checkpointVideo.canonicalRequest);
      const frozenPayload = input.checkpointVideo.preparedRelayTask?.requestPayload;
      if (Array.isArray(frozenPayload?.content)) {
        boundInput.referenceContent = frozenPayload.content.filter((entry: any) => entry?.type !== "text") as Record<string, unknown>[];
      }
      // Recreate trusted policy/adapter bindings on recovery; never deserialize them from JSON.
      const prepared = await prepareWorkbenchRelayVideoTask(boundInput);
      relayTask = await createWorkbenchRelayVideoTask(boundInput, {
        ...prepared,
        ...(input.checkpointVideo.preparedRelayTask || {}),
        relayAdapterBinding: prepared.relayAdapterBinding,
      });
    } catch (error) {
      if (error instanceof ProductionVideoCommandFailpointError) throw error;
      console.error("[production-video] relay creation failed", {
        projectId: input.projectId,
        videoId: input.checkpointVideo.videoId,
        code: String((error as any)?.code || "video_submission_failed"),
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      });
      if (input.reservation.kind !== "disabled") {
        await markProductionVideoFailed({
          videoId: input.checkpointVideo.videoId,
          projectId: input.projectId,
          reason: PUBLIC_RECOVERY_REQUIRED,
        });
        throw new DurableCommandIdempotencyError(
          503,
          "video_submission_recovery_required",
          PUBLIC_RECOVERY_REQUIRED,
        );
      }
      await markProductionVideoFailed({
        videoId: input.checkpointVideo.videoId,
        projectId: input.projectId,
        reason: PUBLIC_SUBMISSION_FAILURE,
      });
      return {
        videoId: input.checkpointVideo.videoId,
        trackId: input.checkpointVideo.trackId,
        errorReason: PUBLIC_SUBMISSION_FAILURE,
      };
    }
    assertRelayTaskAuthority({
      task: relayTask,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    });
    throwProductionVideoCommandFailpoint("after_relay_task");
    await bindRelayTaskToVideo({
      videoId: input.checkpointVideo.videoId,
      trackId: input.checkpointVideo.trackId,
      relayTaskId: relayTask.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      scriptId: input.scriptId,
    });
  }

  throwProductionVideoCommandFailpoint("after_relay_binding");
  video = await loadCheckpointVideo({
    checkpointVideo: input.checkpointVideo,
    projectId: input.projectId,
    scriptId: input.scriptId,
  });
  let synced;
  try {
    synced = await syncWorkbenchVideoRelay({
      ...video,
      id: input.checkpointVideo.videoId,
      state: String(video.state || "生成中"),
      relayTaskId: relayTask.id,
    });
  } catch (error) {
    if (error instanceof ProductionVideoCommandFailpointError) throw error;
    if (input.reservation.kind !== "disabled") {
      throw new DurableCommandIdempotencyError(
        503,
        "video_submission_recovery_required",
        PUBLIC_RECOVERY_REQUIRED,
      );
    }
    synced = video;
  }

  const outcome = resolveRelaySubmissionOutcome({
    status: relayTask.status === "cancelled"
      ? "cancelled"
      : (synced as any).relayStatus || relayTask.status,
    billingState: (synced as any).relayBillingState,
    providerPayload: relayTask.providerPayload,
  });
  const syncedState = String((synced as any).state || video.state || "");
  const syncedError = String((synced as any).errorReason || "").trim();
  if (!outcome.accepted && !outcome.succeeded) {
    const reason = outcome.message || PUBLIC_SUBMISSION_FAILURE;
    if (syncedState !== "生成失败" || syncedError !== reason) {
      await markProductionVideoFailed({
        videoId: input.checkpointVideo.videoId,
        projectId: input.projectId,
        reason,
      });
    }
    return {
      videoId: input.checkpointVideo.videoId,
      trackId: input.checkpointVideo.trackId,
      relayTaskId: relayTask.id,
      errorReason: reason,
    };
  }
  if (syncedState === "生成失败") {
    return {
      videoId: input.checkpointVideo.videoId,
      trackId: input.checkpointVideo.trackId,
      relayTaskId: relayTask.id,
      errorReason: syncedError || PUBLIC_SUBMISSION_FAILURE,
    };
  }
  return {
    videoId: input.checkpointVideo.videoId,
    trackId: input.checkpointVideo.trackId,
    relayTaskId: relayTask.id,
  };
}

export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(
      z.object({
        uploadData: z.array(
          z.object({
            id: z.number(),
            sources: z.string(),
            role: z.enum(GENERATION_REFERENCE_ROLES).optional(),
          }),
        ),
        trackId: z.number(),
        prompt: z.string(),
        duration: z.number(),
      }),
    ),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      scriptId,
      projectId,
      trackData,
      model,
      mode,
      resolution,
      audio,
    } = req.body as {
      scriptId: number;
      projectId: number;
      trackData: ProductionTrackInput[];
      model: string;
      mode: string;
      resolution: string;
      audio?: boolean;
    };
    const workspaceId = String(
      (req as any).project?.workspaceId
      || (req as any).auth?.workspaceId
      || "",
    );
    let authoritativeTrackData: ProductionTrackInput[];
    try {
      authoritativeTrackData = await loadAuthoritativeProductionTrackData({
        projectId,
        scriptId,
        trackData,
      });
    } catch (error) {
      if (error instanceof GenerationReferenceError) {
        return res.status(error.status).send({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
    const idempotencyKey = readRequiredIdempotencyKey(req, res);
    if (!idempotencyKey) return;
    const relayInputs = authoritativeTrackData.map((track): WorkbenchRelayInput => ({
      actorUserId: Number((req as any).auth?.user?.id || 0),
      projectId,
      scriptId,
      videoId: 0,
      trackId: track.trackId,
      uploadData: track.uploadData,
      prompt: track.prompt,
      model,
      mode,
      duration: track.duration,
      resolution,
      audio,
    }));

    let commandReservation: ProductionVideoCommandReservation;
    try {
      commandReservation = await beginDurableCommand<ProductionVideoCommandResult[]>({
        workspaceId,
        actorUserId: Number((req as any).auth?.user?.id || 0),
        scope: COMMAND_SCOPE,
        idempotencyKey,
        request: {
          projectId,
          scriptId,
          model,
          mode,
          resolution,
          audio: audio ?? false,
          trackData,
        },
        resourceType: "project",
        resourceId: projectId,
        reservationStaleAfterMs: RESERVED_COMMAND_STALE_AFTER_MS,
      });
      if (commandReservation.kind === "replay") {
        return commandReservation.responseStatus >= 400
          ? res
              .status(commandReservation.responseStatus)
              .send(commandReservation.responseBody)
          : res
              .status(commandReservation.responseStatus)
              .send(success(commandReservation.responseBody));
      }
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }

    try {
      throwProductionVideoCommandFailpoint("after_reservation");
      let checkpoint: ProductionVideoCheckpoint;
      if (commandReservation.kind === "resume") {
        checkpoint = parseProductionVideoCheckpoint({
          checkpoint: commandReservation.checkpoint,
          workspaceId,
          projectId,
          scriptId,
          relayInputs,
        });
      } else {
        let preparedRelayTasks: PreparedWorkbenchRelayVideoTask[];
        try {
          // Resolve provider-facing media URLs once. This exact payload is
          // checkpointed with the video IDs so a retry cannot conflict merely
          // because a signed URL or mutable model configuration changed.
          preparedRelayTasks = await Promise.all(
            relayInputs.map(async (relayInput, index) => {
              relayInputs[index] = await bindProductionVideoReferences(relayInput);
              return prepareWorkbenchRelayVideoTask(relayInputs[index]);
            }),
          );
        } catch (error) {
          await abandonUncheckpointedProductionCommand(commandReservation);
          if (error instanceof GenerationReferenceError) {
            return res.status(error.status).send({
              message: error.message,
              code: error.code,
            });
          }
          throw error;
        }
        const reserved = await reserveProductionVideoRows({
          reservation: commandReservation,
          workspaceId,
          projectId,
          scriptId,
          relayInputs,
          preparedRelayTasks,
        });
        commandReservation = reserved.reservation;
        checkpoint = reserved.checkpoint;
      }
      throwProductionVideoCommandFailpoint("after_checkpoint");

      const responseTasks: ProductionVideoCommandResult[] = [];
      // A batch stays backwards compatible, while each checkpointed video is
      // recovered independently and uses its stable videoId as Relay requestId.
      for (let index = 0; index < relayInputs.length; index += 1) {
        responseTasks.push(await processProductionVideo({
          reservation: commandReservation,
          checkpointVideo: checkpoint.videos[index],
          relayInput: relayInputs[index],
          workspaceId,
          projectId,
          scriptId,
        }));
      }

      await completeDurableCommand(commandReservation, responseTasks);
      throwProductionVideoCommandFailpoint("after_completion");
      return res.status(200).send(success(responseTasks));
    } catch (error) {
      if (error instanceof ProductionVideoCommandFailpointError) throw error;
      await abandonUncheckpointedProductionCommand(commandReservation);
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      if (error instanceof GenerationReferenceError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }
  },
);
