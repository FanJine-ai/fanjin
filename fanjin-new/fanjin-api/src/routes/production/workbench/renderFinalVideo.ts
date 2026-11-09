import { MembershipError } from "@/lib/membershipCatalog";
import crypto from "node:crypto";
import express from "express";
import type { Knex } from "knex";
import { z } from "zod";

import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  mutateDurableCommandCheckpoint,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
} from "@/lib/durableObjectWrite";
import { insertAndReturnId } from "@/lib/dbDialect";
import {
  commitObjectWriteIntentInTransaction,
  createObjectWriteMediaReferenceEvidence,
  getObjectWriteIntent,
  type ObjectWriteIntentClaim,
} from "@/lib/objectWriteIntent";
import { normalizeObjectKey } from "@/lib/objectStorage";
import {
  renderProjectFinalVideo,
  resolveFinalRenderDimensions,
} from "@/lib/projectFinalRender";
import { shouldQuarantineRelayArtifacts } from "@/lib/relayMockPolicy";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import u from "@/utils";
import { db } from "@/utils/db";

const router = express.Router();

const MAX_FINAL_RENDER_CLIPS = 100;
const MAX_FINAL_RENDER_SECONDS = 24 * 60 * 60;
const FINAL_RENDER_TASK_CLASS = "成片合成";
const FINAL_RENDER_MODEL = "ffmpeg";

const boundedTimelineSecondsSchema = z.number()
  .finite()
  .min(0)
  .max(MAX_FINAL_RENDER_SECONDS);

const timelineItemSchema = z.object({
  videoId: z.number().int().positive(),
  trimStartSeconds: boundedTimelineSecondsSchema.optional(),
  trimEndSeconds: boundedTimelineSecondsSchema.optional(),
  // Compatibility aliases for pre-0.0.8 callers. New clients use the
  // explicit *Seconds fields so the unit cannot be mistaken for milliseconds.
  trimStart: boundedTimelineSecondsSchema.optional(),
  trimEnd: boundedTimelineSecondsSchema.optional(),
  speed: z.number().finite().min(0.25).max(4).optional(),
  volume: z.number().finite().min(0).max(2),
}).strict().superRefine((item, context) => {
  if (item.trimStartSeconds === undefined && item.trimStart === undefined) {
    context.addIssue({
      code: "custom",
      path: ["trimStartSeconds"],
      message: "必须提供 trimStartSeconds",
    });
  }
  if (item.trimEndSeconds === undefined && item.trimEnd === undefined) {
    context.addIssue({
      code: "custom",
      path: ["trimEndSeconds"],
      message: "必须提供 trimEndSeconds",
    });
  }
});

const subtitleCueSchema = z.object({
  startSeconds: boundedTimelineSecondsSchema,
  endSeconds: boundedTimelineSecondsSchema,
  text: z.string().trim().min(1).max(500),
}).strict().superRefine((cue, context) => {
  if (cue.endSeconds <= cue.startSeconds) {
    context.addIssue({
      code: "custom",
      path: ["endSeconds"],
      message: "字幕结束时间必须晚于开始时间",
    });
  }
});

type RequestedTimelineItem = {
  videoId: number;
  trimStart: number;
  trimEnd: number;
  speed: number;
  volume: number;
};

type FinalRenderSelectionItem = {
  trackId: number;
  scriptId: number;
  videoId: number;
  filePath: string;
  state: string;
  sourceDuration: number;
  videoTime: number;
};

type FinalRenderTimelineItem = RequestedTimelineItem & {
  trackId: number;
  scriptId: number;
  sourceDuration: number;
};

type FinalRenderSubtitleCue = z.infer<typeof subtitleCueSchema>;

type FinalRenderAudioSelection = {
  assetId: number;
  assetVersionId: number;
  storageKey: string;
  state: string;
};

type FinalRenderSnapshot = {
  version: "project-final-render-selection.v3";
  projectId: number;
  workspaceId: string;
  ratio: string;
  selected: FinalRenderSelectionItem[];
  timeline: FinalRenderTimelineItem[];
  audio: FinalRenderAudioSelection | null;
  audioVolume: number;
  subtitleCues: FinalRenderSubtitleCue[];
};

type FinalRenderAuthority = {
  projectName: string;
  snapshot: FinalRenderSnapshot;
  orderedVideos: FinalRenderSelectionItem[];
};

type FinalRenderMetadata = {
  width: number;
  height: number;
  durationMs: number;
  audioIncluded: boolean;
};

type StoredFinalRenderObject = {
  url: string;
  claim: ObjectWriteIntentClaim;
};

type FinalRenderCheckpoint = {
  version: "project-final-render-command.v1";
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  snapshotHash: string;
  renderIdentity: string;
  mediaAssetId: string;
  taskId: number | null;
  object: {
    attempt: number;
    intentId: string;
    storageKey: string;
    rendered: FinalRenderMetadata | null;
    stored: StoredFinalRenderObject | null;
  };
};

type PublicFinalRenderAsset = {
  id: string;
  taskId: string;
  assetId: number;
  assetVersionId: number;
  url: string;
  width: number;
  height: number;
  durationMs: number;
  createdAt: number;
};

type FinalRenderCommandOutcome =
  | {
      kind: "success";
      data: {
        asset: PublicFinalRenderAsset;
        reused: false;
      };
    }
  | {
      kind: "error";
      code: string;
      message: string;
    };

const renderedMetadataSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  audioIncluded: z.boolean(),
}).strict();

const finalRenderCheckpointSchema = z.object({
  version: z.literal("project-final-render-command.v1"),
  workspaceId: z.string().min(1),
  actorUserId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  renderIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  mediaAssetId: z.string().uuid(),
  taskId: z.number().int().positive().nullable(),
  object: z.object({
    attempt: z.number().int().positive().max(100),
    intentId: z.string().min(1).max(200),
    storageKey: z.string().min(1).max(1024),
    rendered: renderedMetadataSchema.nullable(),
    stored: z.object({
      url: z.string().min(1).max(4096),
      claim: z.object({
        id: z.string().min(1).max(200),
        owner: z.string().min(1).max(255),
        fence: z.number().int().positive(),
      }).strict(),
    }).strict().nullable(),
  }).strict(),
}).strict();

const publicFinalRenderAssetSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  assetId: z.number().int().positive(),
  assetVersionId: z.number().int().positive(),
  url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  createdAt: z.number().int().positive(),
}).strict();

const finalRenderCommandOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    data: z.object({
      asset: publicFinalRenderAssetSchema,
      reused: z.literal(false),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
]);

class FinalRenderRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FinalRenderRequestError";
  }
}

class FinalRenderRecoveryRequiredError extends Error {
  readonly status = 503;
  readonly code = "final_render_recovery_required";

  constructor(message = "成片任务正在恢复，请使用相同 Idempotency-Key 重试") {
    super(message);
    this.name = "FinalRenderRecoveryRequiredError";
  }
}

class FinalRenderSelectionChangedError extends Error {
  readonly status = 409;
  readonly code = "final_render_selection_changed";

  constructor() {
    super("项目选片或剪辑快照已变化，请使用新的 Idempotency-Key 重新合成");
    this.name = "FinalRenderSelectionChangedError";
  }
}

function uuidFromDigest(digest: string): string {
  const value = digest.slice(0, 32).split("");
  value[12] = "4";
  value[16] = ((Number.parseInt(value[16], 16) & 0x3) | 0x8).toString(16);
  return [
    value.slice(0, 8).join(""),
    value.slice(8, 12).join(""),
    value.slice(12, 16).join(""),
    value.slice(16, 20).join(""),
    value.slice(20, 32).join(""),
  ].join("-");
}

function objectIdentity(
  projectId: number,
  renderIdentity: string,
  attempt: number,
): { intentId: string; storageKey: string } {
  const suffix = crypto
    .createHash("sha256")
    .update(`${renderIdentity}:${attempt}`)
    .digest("hex")
    .slice(0, 24);
  const intentId = `project-final-render-${suffix}`;
  return {
    intentId,
    storageKey: `${projectId}/final/${intentId}.mp4`,
  };
}

function parseCommandOutcome(value: unknown): FinalRenderCommandOutcome {
  const parsed = finalRenderCommandOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_record_invalid",
      "成片幂等响应格式无效",
    );
  }
  return parsed.data;
}

function sendCommandOutcome(
  res: express.Response,
  outcome: FinalRenderCommandOutcome,
  status: number,
) {
  if (outcome.kind === "success") {
    return res.status(status).send(success(outcome.data));
  }
  return res.status(status).send({
    code: outcome.code,
    message: outcome.message,
  });
}

function taskRelatedObjects(input: {
  snapshotHash: string;
  mediaAssetId?: string;
  assetId?: number;
  assetVersionId?: number;
}) {
  return JSON.stringify({
    version: "final-render-task.v1",
    snapshotHash: input.snapshotHash,
    ...(input.mediaAssetId ? { mediaAssetId: input.mediaAssetId } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.assetVersionId ? { assetVersionId: input.assetVersionId } : {}),
  });
}

function checkpointExpected(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  snapshotHash: string;
  renderIdentity: string;
  mediaAssetId: string;
}) {
  return input;
}

function parseCheckpoint(
  value: unknown,
  expected: ReturnType<typeof checkpointExpected>,
): FinalRenderCheckpoint {
  const parsed = finalRenderCheckpointSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.workspaceId !== expected.workspaceId
    || parsed.data.actorUserId !== expected.actorUserId
    || parsed.data.projectId !== expected.projectId
    || parsed.data.snapshotHash !== expected.snapshotHash
    || parsed.data.renderIdentity !== expected.renderIdentity
    || parsed.data.mediaAssetId !== expected.mediaAssetId
    || parsed.data.object.intentId
      !== objectIdentity(
        expected.projectId,
        expected.renderIdentity,
        parsed.data.object.attempt,
      ).intentId
    || normalizeObjectKey(parsed.data.object.storageKey)
      !== objectIdentity(
        expected.projectId,
        expected.renderIdentity,
        parsed.data.object.attempt,
      ).storageKey
    || (
      parsed.data.object.stored !== null
      && (
        parsed.data.object.rendered === null
        || parsed.data.object.stored.claim.id !== parsed.data.object.intentId
      )
    )
  ) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_checkpoint_invalid",
      "成片恢复检查点无效",
    );
  }
  return parsed.data;
}

async function loadFinalRenderAuthority(
  database: Knex | Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    requestedTimeline: RequestedTimelineItem[] | null;
    audioAssetVersionId: number | null;
    audioVolume: number;
    subtitleCues: FinalRenderSubtitleCue[];
    lock?: boolean;
  },
): Promise<FinalRenderAuthority> {
  let projectQuery = database("o_project")
    .where({
      id: input.projectId,
      workspaceId: input.workspaceId,
    })
    .select("id", "name", "videoRatio", "deletionState");
  if (input.lock) projectQuery = projectQuery.forUpdate();
  const project = await projectQuery.first();
  if (!project) {
    throw new FinalRenderRequestError(404, "project_not_found", "项目不存在");
  }
  if (String(project.deletionState || "active") !== "active") {
    throw new FinalRenderRequestError(
      409,
      "project_not_active",
      "项目正在删除或已不可用",
    );
  }

  let trackQuery = database("o_videoTrack")
    .where({ projectId: input.projectId })
    .select("id", "videoId", "duration", "scriptId")
    .orderBy("scriptId", "asc")
    .orderBy("id", "asc");
  if (input.lock) trackQuery = trackQuery.forUpdate();
  const tracks = await trackQuery;
  if (!tracks.length) {
    throw new FinalRenderRequestError(
      409,
      "final_render_tracks_empty",
      "项目暂无视频轨道，无法合成成片",
    );
  }
  if (tracks.length > MAX_FINAL_RENDER_CLIPS) {
    throw new FinalRenderRequestError(
      422,
      "final_render_too_many_clips",
      `单次成片最多支持 ${MAX_FINAL_RENDER_CLIPS} 个镜头`,
    );
  }
  const selectedVideoIds = tracks
    .map((track) => Number(track.videoId || 0))
    .filter(Boolean);
  if (selectedVideoIds.length !== tracks.length) {
    throw new FinalRenderRequestError(
      409,
      "final_render_selection_incomplete",
      `还有 ${tracks.length - selectedVideoIds.length} 个镜头未设为成片`,
    );
  }
  if (new Set(selectedVideoIds).size !== selectedVideoIds.length) {
    throw new FinalRenderRequestError(
      409,
      "final_render_selection_invalid",
      "同一视频不能同时作为多个镜头的成片",
    );
  }

  let videoQuery = database("o_video")
    .where({ projectId: input.projectId })
    .whereIn("id", selectedVideoIds)
    .select(
      "id",
      "videoTrackId",
      "filePath",
      "state",
      "time",
      "relayTaskId",
    );
  if (input.lock) videoQuery = videoQuery.forUpdate();
  const storedVideos = await videoQuery;
  const relayTaskIds = Array.from(new Set(
    storedVideos
      .map((video: any) => String(video.relayTaskId || "").trim())
      .filter(Boolean),
  ));
  let relayQuery = relayTaskIds.length
    ? database("o_relay_task")
      .whereIn("id", relayTaskIds)
      .select("id", "status")
    : null;
  if (input.lock && relayQuery) relayQuery = relayQuery.forUpdate();
  const relayRows = relayQuery ? await relayQuery : [];
  // Relay projects a public playback URL into o_video. The controlled object
  // key belongs to its persisted media receipt, not to that presentation URL.
  let mediaQuery = relayTaskIds.length ? database("o_media_asset")
    .where({ workspaceId: input.workspaceId, projectId: input.projectId, assetType: "video", deletionState: "active" })
    .whereIn("taskId", relayTaskIds)
    .select("taskId", "url", "storageKey") : null;
  if (input.lock && mediaQuery) mediaQuery = mediaQuery.forUpdate();
  const mediaRows = mediaQuery ? await mediaQuery : [];
  const relayStatusByTaskId = new Map(
    relayRows.map((relay: any) => [
      String(relay.id),
      String(relay.status || ""),
    ]),
  );
  const videoById = new Map(storedVideos.map((video: any) => [
    Number(video.id),
    {
      ...video,
      relayStatus: relayStatusByTaskId.get(
        String(video.relayTaskId || ""),
      ),
    },
  ]));
  const selected: FinalRenderSelectionItem[] = tracks.map((track: any) => {
    const videoId = Number(track.videoId);
    const video = videoById.get(videoId);
    const sourceDuration = Number(track.duration || 0);
    const rawFilePath = String(video?.filePath || "").trim();
    const storedMedia = mediaRows.find((media: any) => (
      String(media.taskId) === String(video?.relayTaskId)
      && String(media.url) === rawFilePath
    ));
    let filePath = "";
    try {
      const storedKey = String(storedMedia?.storageKey || rawFilePath);
      filePath = storedKey ? normalizeObjectKey(storedKey) : "";
    } catch {
      filePath = "";
    }
    if (
      !video
      || Number(video.videoTrackId) !== Number(track.id)
      || !["已完成", "生成成功"].includes(String(video.state || ""))
      || shouldQuarantineRelayArtifacts(video.relayStatus)
      || !filePath
      || !filePath.startsWith(`${input.projectId}/`)
      || !Number.isFinite(sourceDuration)
      || sourceDuration <= 0
      || sourceDuration > MAX_FINAL_RENDER_SECONDS
    ) {
      throw new FinalRenderRequestError(
        409,
        "final_render_clip_not_ready",
        "有已选镜头尚未完成受控存储，暂不能合成",
      );
    }
    return {
      trackId: Number(track.id),
      scriptId: Number(track.scriptId),
      videoId,
      filePath,
      state: String(video.state),
      sourceDuration,
      videoTime: Number(video.time || 0),
    };
  });
  const selectedByVideoId = new Map(selected.map((item) => [
    item.videoId,
    item,
  ]));
  const requestedTimeline = input.requestedTimeline ?? selected.map((item) => ({
    videoId: item.videoId,
    trimStart: 0,
    trimEnd: item.sourceDuration,
    speed: 1,
    volume: 1,
  }));
  if (
    requestedTimeline.length !== selected.length
    || new Set(requestedTimeline.map((item) => item.videoId)).size
      !== requestedTimeline.length
    || requestedTimeline.some((item) => !selectedByVideoId.has(item.videoId))
  ) {
    throw new FinalRenderRequestError(
      409,
      "final_render_selection_changed",
      "剪辑时间线与当前选片不一致，请刷新后使用新的 Idempotency-Key",
    );
  }
  const timeline: FinalRenderTimelineItem[] = requestedTimeline.map((item) => {
    const selectedVideo = selectedByVideoId.get(item.videoId)!;
    if (
      item.trimStart >= item.trimEnd
      || item.trimEnd > selectedVideo.sourceDuration
    ) {
      throw new FinalRenderRequestError(
        422,
        "final_render_trim_invalid",
        `视频 ${item.videoId} 的裁剪范围必须满足 0 ≤ 开始 < 结束 ≤ ${selectedVideo.sourceDuration}`,
      );
    }
    return {
      ...item,
      trackId: selectedVideo.trackId,
      scriptId: selectedVideo.scriptId,
      sourceDuration: selectedVideo.sourceDuration,
    };
  });
  const renderedDurationSeconds = timeline.reduce(
    (total, item) => total + (item.trimEnd - item.trimStart) / item.speed,
    0,
  );
  if (renderedDurationSeconds > MAX_FINAL_RENDER_SECONDS) {
    throw new FinalRenderRequestError(
      422,
      "final_render_duration_invalid",
      "变速后的成片时长超过 24 小时上限",
    );
  }
  const subtitleCues = input.subtitleCues.map((cue, index) => {
    if (cue.endSeconds > renderedDurationSeconds + 0.05) {
      throw new FinalRenderRequestError(
        422,
        "final_render_subtitle_invalid",
        `字幕 ${index + 1} 超出成片时长 ${renderedDurationSeconds.toFixed(2)} 秒`,
      );
    }
    return {
      startSeconds: cue.startSeconds,
      endSeconds: Math.min(cue.endSeconds, renderedDurationSeconds),
      text: cue.text,
    };
  });

  let audio: FinalRenderAudioSelection | null = null;
  if (input.audioAssetVersionId !== null) {
    let audioQuery = database("o_image as image")
      .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
      .where({
        "image.id": input.audioAssetVersionId,
        "image.type": "audio",
        "image.state": "已完成",
        "image.deletionState": "active",
        "asset.projectId": input.projectId,
        "asset.type": "audio",
        "asset.deletionState": "active",
      })
      .select(
        "image.id as assetVersionId",
        "image.assetsId as assetId",
        "image.storageKey",
        "image.state",
      );
    if (input.lock) audioQuery = audioQuery.forUpdate();
    const row = await audioQuery.first();
    const storageKey = String(row?.storageKey || "").trim();
    let normalizedStorageKey = "";
    try {
      normalizedStorageKey = storageKey ? normalizeObjectKey(storageKey) : "";
    } catch {
      normalizedStorageKey = "";
    }
    if (
      !row
      || !normalizedStorageKey
      || !normalizedStorageKey.startsWith(`${input.projectId}/`)
    ) {
      throw new FinalRenderRequestError(
        422,
        "final_render_audio_invalid",
        "配乐版本不存在、跨项目或未进入受控存储",
      );
    }
    audio = {
      assetId: Number(row.assetId),
      assetVersionId: Number(row.assetVersionId),
      storageKey: normalizedStorageKey,
      state: String(row.state),
    };
  } else if (input.audioVolume !== 1) {
    throw new FinalRenderRequestError(
      422,
      "final_render_audio_volume_without_asset",
      "未选择配乐时不能设置配乐音量",
    );
  }

  const snapshot: FinalRenderSnapshot = {
    version: "project-final-render-selection.v3",
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    ratio: String(project.videoRatio || "16:9"),
    selected,
    timeline,
    audio,
    audioVolume: input.audioVolume,
    subtitleCues,
  };
  return {
    projectName: String(project.name || "项目"),
    snapshot,
    orderedVideos: timeline.map((item) => selectedByVideoId.get(item.videoId)!),
  };
}

function initialCheckpoint(input: ReturnType<typeof checkpointExpected>): FinalRenderCheckpoint {
  const object = objectIdentity(input.projectId, input.renderIdentity, 1);
  return {
    version: "project-final-render-command.v1",
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    snapshotHash: input.snapshotHash,
    renderIdentity: input.renderIdentity,
    mediaAssetId: input.mediaAssetId,
    taskId: null,
    object: {
      attempt: 1,
      ...object,
      rendered: null,
      stored: null,
    },
  };
}

function renderMetadata(input: {
  width: number;
  height: number;
  audioIncluded: boolean;
  timeline: FinalRenderTimelineItem[];
}): FinalRenderMetadata {
  return {
    width: input.width,
    height: input.height,
    durationMs: Math.max(1, Math.round(input.timeline.reduce(
      (sum, item) => sum + (
        (item.trimEnd - item.trimStart) / item.speed
      ) * 1_000,
      0,
    ))),
    audioIncluded: input.audioIncluded,
  };
}

async function completeFailedCommand(input: {
  reservation: DurableCommandReservation<FinalRenderCommandOutcome>;
  expected: ReturnType<typeof checkpointExpected>;
  status: number;
  code: string;
  message: string;
}): Promise<{ outcome: FinalRenderCommandOutcome; status: number }> {
  if (input.reservation.kind !== "resume") {
    throw new FinalRenderRecoveryRequiredError();
  }
  const reservation = input.reservation;
  const outcome: FinalRenderCommandOutcome = {
    kind: "error",
    code: input.code,
    message: input.message,
  };
  return await db.transaction(async (transaction) => {
    const row = await transaction("o_agent_idempotency")
      .where({ id: reservation.id })
      .forUpdate()
      .select("status", "responseStatus", "responseBody")
      .first();
    if (!row) throw new FinalRenderRecoveryRequiredError();
    if (String(row.status) === "completed") {
      return {
        outcome: parseCommandOutcome(JSON.parse(String(row.responseBody || ""))),
        status: Number(row.responseStatus || 200),
      };
    }
    const checkpoint = parseCheckpoint(
      JSON.parse(String(row.responseBody || "")),
      input.expected,
    );
    if (checkpoint.taskId) {
      const task = await transaction("o_tasks")
        .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
        .forUpdate()
        .select("id", "state")
        .first();
      if (!task) throw new FinalRenderRecoveryRequiredError();
      if (String(task.state) === "进行中") {
        const updated = await transaction("o_tasks")
          .where({
            id: checkpoint.taskId,
            projectId: checkpoint.projectId,
            state: "进行中",
          })
          .update({
            state: "生成失败",
            reason: input.message,
          });
        if (Number(updated) !== 1) {
          throw new FinalRenderRecoveryRequiredError();
        }
      } else if (String(task.state) !== "生成失败") {
        throw new FinalRenderRecoveryRequiredError();
      }
    }
    await completeDurableCommand(
      {
        kind: "resume",
        id: reservation.id,
        checkpoint,
      },
      outcome,
      input.status,
      { database: transaction as any },
    );
    return { outcome, status: input.status };
  });
}

async function terminalizeChangedSelectionCommand(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  idempotencyKey: string;
}): Promise<void> {
  if (
    !input.workspaceId
    || !Number.isSafeInteger(input.actorUserId)
    || input.actorUserId <= 0
    || !input.idempotencyKey
  ) {
    return;
  }
  const scopeKey = [
    "production:workbench:render-final-video",
    input.workspaceId,
    input.actorUserId,
  ].join(":");
  const command = await db("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      scopeKey,
      idempotencyKey: input.idempotencyKey,
      status: "checkpointed",
    })
    .select("id", "responseBody")
    .first();
  if (!command) return;
  let checkpoint: FinalRenderCheckpoint;
  try {
    const parsed = finalRenderCheckpointSchema.safeParse(
      JSON.parse(String(command.responseBody || "")),
    );
    if (
      !parsed.success
      || parsed.data.workspaceId !== input.workspaceId
      || parsed.data.actorUserId !== input.actorUserId
      || parsed.data.projectId !== input.projectId
    ) {
      return;
    }
    checkpoint = parsed.data;
  } catch {
    return;
  }

  // Stop or hand off every possible writer before completing the command.
  // If no intent exists, a concurrent renderer will observe the completed
  // command at its next atomic checkpoint and cannot start a PUT.
  let intent;
  try {
    intent = await getObjectWriteIntent(checkpoint.object.intentId, {
      database: db,
    });
  } catch {
    return;
  }
  if (intent?.status === "committed") return;
  if (
    intent
    && ["prepared", "stored"].includes(intent.status)
    && intent.leaseOwner
    && intent.leaseExpiresAt
    && intent.leaseExpiresAt > Date.now()
  ) {
    try {
      await queueDurableObjectWriteCompensation(
        {
          id: intent.id,
          owner: intent.leaseOwner,
          fence: intent.leaseFence,
        },
        Object.assign(new Error("final render selection changed"), {
          code: "FINAL_RENDER_SELECTION_CHANGED",
        }),
        { database: db },
      );
    } catch {
      const current = await getObjectWriteIntent(checkpoint.object.intentId, {
        database: db,
      }).catch(() => null);
      if (
        !current
        || ![
          "compensation_pending",
          "compensating",
          "compensated",
          "dead",
        ].includes(current.status)
      ) {
        return;
      }
    }
  }

  const outcome: FinalRenderCommandOutcome = {
    kind: "error",
    code: "final_render_selection_changed",
    message: "项目选片或剪辑快照已变化，请使用新的 Idempotency-Key 重新合成",
  };
  await db.transaction(async (transaction) => {
    const currentRow = await transaction("o_agent_idempotency")
      .where({ id: String(command.id) })
      .forUpdate()
      .select("status", "responseBody")
      .first();
    if (!currentRow || String(currentRow.status) !== "checkpointed") return;
    const current = finalRenderCheckpointSchema.safeParse(
      JSON.parse(String(currentRow.responseBody || "")),
    );
    if (
      !current.success
      || current.data.workspaceId !== input.workspaceId
      || current.data.actorUserId !== input.actorUserId
      || current.data.projectId !== input.projectId
    ) {
      return;
    }
    if (current.data.taskId) {
      const task = await transaction("o_tasks")
        .where({
          id: current.data.taskId,
          projectId: input.projectId,
          taskClass: FINAL_RENDER_TASK_CLASS,
        })
        .forUpdate()
        .select("state")
        .first();
      if (!task || !["进行中", "生成失败"].includes(String(task.state || ""))) {
        return;
      }
      if (String(task.state) === "进行中") {
        const updated = await transaction("o_tasks")
          .where({
            id: current.data.taskId,
            projectId: input.projectId,
            state: "进行中",
          })
          .update({
            state: "生成失败",
            reason: outcome.message,
          });
        if (Number(updated) !== 1) return;
      }
    }
    await completeDurableCommand(
      {
        kind: "resume",
        id: String(command.id),
        checkpoint: current.data,
      },
      outcome,
      409,
      { database: transaction as any },
    );
  });
}

export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: z.number().int().positive(),
    timeline: z.array(timelineItemSchema)
      .min(1)
      .max(MAX_FINAL_RENDER_CLIPS)
      .optional()
      .nullable(),
    audioAssetVersionId: z.number().int().positive().optional().nullable(),
    subtitleCues: z.array(subtitleCueSchema).max(300).optional(),
    soundtrackVolume: z.number().finite().min(0).max(2).optional(),
    // Compatibility alias for clients built before the 0.0.8 workbench.
    audioVolume: z.number().finite().min(0).max(2).optional(),
  }),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const workspaceId = String(
      (req as any).project?.workspaceId
      || (req as any).auth?.workspaceId
      || "",
    ).trim();
    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const idempotencyKey = String(req.header("idempotency-key") || "").trim();
    const requestedTimeline = Array.isArray(req.body.timeline)
      ? req.body.timeline.map((item: any): RequestedTimelineItem => ({
          videoId: Number(item.videoId),
          trimStart: Number(item.trimStartSeconds ?? item.trimStart),
          trimEnd: Number(item.trimEndSeconds ?? item.trimEnd),
          speed: Number(item.speed ?? 1),
          volume: Number(item.volume),
        }))
      : null;
    const audioAssetVersionId = req.body.audioAssetVersionId == null
      ? null
      : Number(req.body.audioAssetVersionId);
    const audioVolume = req.body.soundtrackVolume == null
      ? req.body.audioVolume == null
        ? 1
        : Number(req.body.audioVolume)
      : Number(req.body.soundtrackVolume);
    const subtitleCues = Array.isArray(req.body.subtitleCues)
      ? req.body.subtitleCues as FinalRenderSubtitleCue[]
      : [];
    const objectWriterIdPrefix = `project-final-render-${crypto.randomUUID()}`;

    let authority: FinalRenderAuthority;
    try {
      authority = await loadFinalRenderAuthority(db, {
        workspaceId,
        projectId,
        requestedTimeline,
        audioAssetVersionId,
        audioVolume,
        subtitleCues,
      });
    } catch (error) {
      if (error instanceof FinalRenderRequestError) {
        if (
          error.code === "final_render_selection_changed"
          && idempotencyKey
        ) {
          try {
            await terminalizeChangedSelectionCommand({
              workspaceId,
              actorUserId,
              projectId,
              idempotencyKey,
            });
            const scopeKey = [
              "production:workbench:render-final-video",
              workspaceId,
              actorUserId,
            ].join(":");
            const command = await db("o_agent_idempotency")
              .where({
                workspaceId,
                actorUserId,
                scopeKey,
                idempotencyKey,
              })
              .select("status", "responseStatus", "responseBody")
              .first();
            if (!command) {
              return res.status(error.status).send({
                code: error.code,
                message: error.message,
              });
            }
            if (String(command.status) === "completed") {
              return sendCommandOutcome(
                res,
                parseCommandOutcome(JSON.parse(String(command.responseBody || ""))),
                Number(command.responseStatus || error.status),
              );
            }
          } catch {
            // A command row may still need recovery. Never claim a terminal
            // selection conflict unless the durable replay was confirmed.
          }
          return res.status(503).send({
            code: "final_render_recovery_required",
            message: "成片快照变更状态待恢复，请使用相同 Idempotency-Key 重试",
          });
        }
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    if (!idempotencyKey) {
      return res.status(400).send({
        code: "idempotency_key_required",
        message: "成片合成必须提供 Idempotency-Key，以便中断后安全恢复",
      });
    }

    const snapshotHash = hashIdempotencyRequest(authority.snapshot);
    const renderIdentity = crypto
      .createHash("sha256")
      .update(`${workspaceId}:${actorUserId}:${projectId}:${idempotencyKey}`)
      .digest("hex");
    const mediaAssetId = uuidFromDigest(
      crypto
        .createHash("sha256")
        .update(`${renderIdentity}:media-asset`)
        .digest("hex"),
    );
    const expected = checkpointExpected({
      workspaceId,
      actorUserId,
      projectId,
      snapshotHash,
      renderIdentity,
      mediaAssetId,
    });
    const firstCheckpoint = initialCheckpoint(expected);
    const idempotencyRequest = {
      projectId,
      snapshot: authority.snapshot,
    };
    let reservation: DurableCommandReservation<FinalRenderCommandOutcome>;
    try {
      reservation = await beginDurableCommand<FinalRenderCommandOutcome>({
        workspaceId,
        actorUserId,
        scope: "production:workbench:render-final-video",
        idempotencyKey,
        request: idempotencyRequest,
        initialCheckpoint: firstCheckpoint,
        resourceType: "project",
        resourceId: projectId,
      });
      if (reservation.kind === "replay") {
        return sendCommandOutcome(
          res,
          parseCommandOutcome(reservation.responseBody),
          reservation.responseStatus,
        );
      }
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    if (reservation.kind !== "resume") {
      return res.status(500).send({
        code: "idempotency_checkpoint_invalid",
        message: "成片命令未建立恢复检查点",
      });
    }
    let checkpoint = parseCheckpoint(reservation.checkpoint, expected);

    type ReplayedCommand = {
      outcome: FinalRenderCommandOutcome;
      status: number;
    };
    const advanceCheckpoint = async (
      mutate: (
        current: FinalRenderCheckpoint,
        transaction: Knex.Transaction,
      ) => Promise<FinalRenderCheckpoint>,
    ): Promise<ReplayedCommand | null> => {
      if (reservation.kind !== "resume") {
        throw new FinalRenderRecoveryRequiredError();
      }
      const advanced = await mutateDurableCommandCheckpoint<
        FinalRenderCommandOutcome,
        FinalRenderCheckpoint
      >(reservation, async (current, transaction) => {
        return await mutate(parseCheckpoint(current, expected), transaction);
      });
      if (advanced.kind === "replay") {
        return {
          outcome: parseCommandOutcome(advanced.responseBody),
          status: advanced.responseStatus,
        };
      }
      reservation = advanced;
      checkpoint = parseCheckpoint(advanced.checkpoint, expected);
      return null;
    };

    try {
      const replay = await advanceCheckpoint(async (current, transaction) => {
        let lockedAuthority: FinalRenderAuthority;
        try {
          lockedAuthority = await loadFinalRenderAuthority(transaction, {
            workspaceId,
            projectId,
            requestedTimeline,
            audioAssetVersionId,
            audioVolume,
            subtitleCues,
            lock: true,
          });
        } catch (error) {
          if (error instanceof FinalRenderRequestError) {
            throw new FinalRenderRequestError(
              409,
              "final_render_selection_changed",
              "项目选片或剪辑快照已变化，请使用新的 Idempotency-Key 重新合成",
            );
          }
          throw error;
        }
        if (hashIdempotencyRequest(lockedAuthority.snapshot) !== snapshotHash) {
          throw new FinalRenderRequestError(
            409,
            "final_render_selection_changed",
            "项目选片或剪辑快照已变化，请使用新的 Idempotency-Key 重新合成",
          );
        }
        if (current.taskId) {
          const task = await transaction("o_tasks")
            .where({
              id: current.taskId,
              projectId,
              taskClass: FINAL_RENDER_TASK_CLASS,
            })
            .forUpdate()
            .select("id", "state", "relatedObjects")
            .first();
          let related: Record<string, unknown> = {};
          try {
            related = JSON.parse(String(task?.relatedObjects || "{}"));
          } catch {
            related = {};
          }
          if (
            !task
            || String(related.snapshotHash || "") !== snapshotHash
            || !["进行中", "已完成", "生成失败"].includes(String(task.state || ""))
          ) {
            throw new DurableCommandIdempotencyError(
              409,
              "final_render_task_conflict",
              "成片任务恢复记录与项目不一致",
            );
          }
          return current;
        }
        const taskId = await insertAndReturnId(transaction, "o_tasks", {
          projectId,
          taskClass: FINAL_RENDER_TASK_CLASS,
          relatedObjects: taskRelatedObjects({ snapshotHash }),
          model: FINAL_RENDER_MODEL,
          describe: `${authority.projectName} · 项目成片合成`,
          state: "进行中",
          startTime: Date.now(),
          reason: null,
        });
        const linked = await transaction("o_agent_idempotency")
          .where({
            id: reservation.kind === "resume" ? reservation.id : "",
            status: "checkpointed",
          })
          .update({
            resourceType: "project_final_render_task",
            resourceId: String(taskId),
            updatedAt: Date.now(),
          });
        if (Number(linked) !== 1) {
          throw new DurableCommandIdempotencyError(
            409,
            "final_render_task_conflict",
            "成片任务与恢复命令绑定失败",
          );
        }
        return { ...current, taskId };
      });
      if (replay) {
        return sendCommandOutcome(res, replay.outcome, replay.status);
      }
    } catch (error) {
      if (
        error instanceof FinalRenderRequestError
        && error.code === "final_render_selection_changed"
      ) {
        try {
          await terminalizeChangedSelectionCommand({
            workspaceId,
            actorUserId,
            projectId,
            idempotencyKey,
          });
          const terminal = reservation.kind === "resume"
            ? await db("o_agent_idempotency")
                .where({ id: reservation.id, status: "completed" })
                .select("responseStatus", "responseBody")
                .first()
            : null;
          if (terminal) {
            return sendCommandOutcome(
              res,
              parseCommandOutcome(JSON.parse(String(terminal.responseBody || ""))),
              Number(terminal.responseStatus || error.status),
            );
          }
        } catch {
          // Fall through to a retryable response while the durable command is
          // still unresolved; never claim a terminal 409 without its replay.
        }
        return res.status(503).send({
          code: "final_render_recovery_required",
          message: "成片快照变更状态待恢复，请使用相同 Idempotency-Key 重试",
        });
      }
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      return res.status(503).send({
        code: "final_render_recovery_required",
        message: "成片任务初始化待恢复，请使用相同 Idempotency-Key 重试",
      });
    }

    const terminalFailure = async (
      status: number,
      code: string,
      message: string,
    ) => {
      try {
        const completed = await completeFailedCommand({
          reservation,
          expected,
          status,
          code,
          message,
        });
        return sendCommandOutcome(res, completed.outcome, completed.status);
      } catch {
        return res.status(503).send({
          code: "final_render_recovery_required",
          message: "成片失败状态待恢复，请使用相同 Idempotency-Key 重试",
        });
      }
    };

    let storedObject = checkpoint.object.stored;
    if (!storedObject) {
      let existingIntent;
      try {
        existingIntent = await getObjectWriteIntent(
          checkpoint.object.intentId,
          { database: db },
        );
      } catch {
        return res.status(503).send({
          code: "final_render_recovery_required",
          message: "成片对象状态读取失败，请使用相同 Idempotency-Key 重试",
        });
      }
      if (existingIntent?.status === "stored") {
        if (
          !checkpoint.object.rendered
          || existingIntent.objectKey !== checkpoint.object.storageKey
          || !existingIntent.leaseOwner
          || !existingIntent.leaseExpiresAt
          || existingIntent.leaseExpiresAt <= Date.now()
        ) {
          return res.status(503).send({
            code: "final_render_recovery_required",
            message: "成片对象正在等待安全恢复，请稍后使用相同 Idempotency-Key 重试",
          });
        }
        try {
          const url = await u.oss.getFileUrl(checkpoint.object.storageKey);
          const recovered: StoredFinalRenderObject = {
            url,
            claim: {
              id: existingIntent.id,
              owner: existingIntent.leaseOwner,
              fence: existingIntent.leaseFence,
            },
          };
          const replay = await advanceCheckpoint(async (current) => ({
            ...current,
            object: {
              ...current.object,
              stored: recovered,
            },
          }));
          if (replay) {
            return sendCommandOutcome(res, replay.outcome, replay.status);
          }
          storedObject = checkpoint.object.stored;
        } catch {
          return res.status(503).send({
            code: "final_render_recovery_required",
            message: "成片对象恢复检查点写入失败，请使用相同 Idempotency-Key 重试",
          });
        }
      } else if (existingIntent?.status === "compensated") {
        try {
          const replay = await advanceCheckpoint(async (current) => {
            const attempt = current.object.attempt + 1;
            if (attempt > 100) {
              throw new DurableCommandIdempotencyError(
                500,
                "final_render_attempts_exhausted",
                "成片对象恢复次数已达上限",
              );
            }
            return {
              ...current,
              object: {
                attempt,
                ...objectIdentity(projectId, renderIdentity, attempt),
                rendered: null,
                stored: null,
              },
            };
          });
          if (replay) {
            return sendCommandOutcome(res, replay.outcome, replay.status);
          }
        } catch (error) {
          if (error instanceof DurableCommandIdempotencyError) {
            return res.status(error.status).send({
              code: error.code,
              message: error.message,
            });
          }
          return res.status(503).send({
            code: "final_render_recovery_required",
            message: "成片对象重试检查点写入失败，请使用相同 Idempotency-Key 重试",
          });
        }
      } else if (existingIntent) {
        return res.status(503).send({
          code: "final_render_recovery_required",
          message: "成片对象仍在写入或清理，请稍后使用相同 Idempotency-Key 重试",
        });
      }
    }

    if (!storedObject) {
      let rendered;
      try {
        const [clips, soundtrackBody] = await Promise.all([
          Promise.all(authority.orderedVideos.map((video) =>
            u.oss.getFile(video.filePath))),
          authority.snapshot.audio
            ? u.oss.getFile(authority.snapshot.audio.storageKey)
            : Promise.resolve(null),
        ]);
        rendered = await renderProjectFinalVideo({
          clips,
          ratio: authority.snapshot.ratio,
          clipDurationsSeconds: authority.snapshot.timeline.map(
            (item) => item.sourceDuration,
          ),
          clipEdits: authority.snapshot.timeline.map((item) => ({
            trimStartSeconds: item.trimStart,
            trimEndSeconds: item.trimEnd,
            speed: item.speed,
            volume: item.volume,
          })),
          soundtrack: soundtrackBody
            ? {
                body: soundtrackBody,
                volume: authority.snapshot.audioVolume,
              }
            : null,
          strictClipEdits: true,
          subtitleCues: authority.snapshot.subtitleCues,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("ENOENT") || message.includes("NoSuchKey")) {
          return await terminalFailure(
            409,
            "final_render_source_missing",
            "已选镜头或配乐文件不存在，请重新选择后再合成",
          );
        }
        if (message.includes("FINAL_RENDER_TIMEOUT")) {
          return await terminalFailure(
            504,
            "final_render_timeout",
            "成片合成超时，请减少镜头数量后重试",
          );
        }
        if (message.includes("FINAL_RENDER_PROBE_FAILED")) {
          return await terminalFailure(
            422,
            "final_render_source_unreadable",
            "已选镜头文件无法读取，请重新生成或选择后再合成",
          );
        }
        return await terminalFailure(
          500,
          "final_render_failed",
          "成片合成失败，请检查镜头和配乐文件格式后重试",
        );
      }

      const metadata = renderMetadata({
        width: rendered.dimensions.width,
        height: rendered.dimensions.height,
        audioIncluded: rendered.audioIncluded,
        timeline: authority.snapshot.timeline,
      });
      if (
        checkpoint.object.rendered
        && JSON.stringify(checkpoint.object.rendered) !== JSON.stringify(metadata)
      ) {
        return await terminalFailure(
          409,
          "final_render_output_changed",
          "相同成片快照产生了不一致的输出参数，请使用新的 Idempotency-Key",
        );
      }
      try {
        const replay = await advanceCheckpoint(async (current) => ({
          ...current,
          object: {
            ...current.object,
            rendered: metadata,
          },
        }));
        if (replay) {
          return sendCommandOutcome(res, replay.outcome, replay.status);
        }
      } catch {
        return res.status(503).send({
          code: "final_render_recovery_required",
          message: "成片渲染结果待恢复，请使用相同 Idempotency-Key 重试",
        });
      }

      let durable;
      try {
        durable = await writeObjectWithDurableIntent({
          purpose: "relay_final",
          acceptedGeneration: false,
          workspaceId,
          projectId,
          body: rendered.body,
          storageKey: () => checkpoint.object.storageKey,
          writerIdPrefix: objectWriterIdPrefix,
          putTimeoutMs: 30 * 60_000,
        }, {
          database: db,
          idFactory: () => checkpoint.object.intentId,
          writer: u.oss,
        });
      } catch (error) {
        if (error instanceof MembershipError) return res.status(error.status).send({ code: error.code, message: error.message });
        // A concurrent retry may have won the deterministic object-intent
        // claim. Keep the command checkpointed: the winner will either commit
        // it, or the object-intent reconciler will compensate it so a later
        // retry can safely advance to the next attempt.
        return res.status(503).send({
          code: "final_render_recovery_required",
          message: "成片对象正在写入或恢复，请使用相同 Idempotency-Key 重试",
        });
      }
      try {
        const stored: StoredFinalRenderObject = {
          url: durable.url,
          claim: durable.claim,
        };
        const replay = await advanceCheckpoint(async (current) => ({
          ...current,
          object: {
            ...current.object,
            stored,
          },
        }));
        if (replay) {
          return sendCommandOutcome(res, replay.outcome, replay.status);
        }
        storedObject = checkpoint.object.stored;
      } catch {
        return res.status(503).send({
          code: "final_render_recovery_required",
          message: "成片对象已保存，正在恢复资产登记，请使用相同 Idempotency-Key 重试",
        });
      }
    }

    if (
      !storedObject
      || !checkpoint.object.rendered
      || !checkpoint.taskId
      || reservation.kind !== "resume"
    ) {
      return res.status(503).send({
        code: "final_render_recovery_required",
        message: "成片交付检查点不完整，请使用相同 Idempotency-Key 重试",
      });
    }

    try {
      const finalized = await db.transaction(async (transaction) => {
        const commandRow = await transaction("o_agent_idempotency")
          .where({ id: reservation.kind === "resume" ? reservation.id : "" })
          .forUpdate()
          .select("status", "responseStatus", "responseBody")
          .first();
        if (!commandRow) throw new FinalRenderRecoveryRequiredError();
        if (String(commandRow.status) === "completed") {
          return {
            outcome: parseCommandOutcome(
              JSON.parse(String(commandRow.responseBody || "")),
            ),
            status: Number(commandRow.responseStatus || 200),
          };
        }
        const current = parseCheckpoint(
          JSON.parse(String(commandRow.responseBody || "")),
          expected,
        );
        if (
          !current.taskId
          || !current.object.rendered
          || !current.object.stored
        ) {
          throw new FinalRenderRecoveryRequiredError();
        }
        const currentAuthority = await loadFinalRenderAuthority(transaction, {
          workspaceId,
          projectId,
          requestedTimeline,
          audioAssetVersionId,
          audioVolume,
          subtitleCues,
          lock: true,
        });
        if (hashIdempotencyRequest(currentAuthority.snapshot) !== snapshotHash) {
          throw new FinalRenderSelectionChangedError();
        }

        const createdAt = Date.now();
        const assetId = await insertAndReturnId(transaction, "o_assets", {
          type: "clip",
          projectId,
          name: `${authority.projectName} 成片`.slice(0, 80),
          prompt: null,
          startTime: createdAt,
        });
        const assetVersionId = await insertAndReturnId(
          transaction,
          "o_image",
          {
            filePath: current.object.storageKey,
            storageKey: current.object.storageKey,
            type: "clip",
            assetsId: assetId,
            model: FINAL_RENDER_MODEL,
            resolution: `${current.object.rendered.width}x${current.object.rendered.height}`,
            state: "已完成",
          },
        );
        const linked = await transaction("o_assets")
          .where({ id: assetId, projectId })
          .update({ imageId: assetVersionId });
        if (Number(linked) !== 1) {
          throw new FinalRenderRecoveryRequiredError();
        }

        const metadata = {
          version: "project-final-render.v3",
          controlledStorage: true,
          projectId,
          ratio: authority.snapshot.ratio,
          selectedVideoIds: authority.snapshot.selected.map(
            (item) => item.videoId,
          ),
          timeline: authority.snapshot.timeline,
          audioAssetVersionId:
            authority.snapshot.audio?.assetVersionId ?? null,
          audioVolume: authority.snapshot.audioVolume,
          audioIncluded: current.object.rendered.audioIncluded,
          subtitleCues: authority.snapshot.subtitleCues,
          objectIntentId: current.object.intentId,
          snapshotHash,
          taskId: current.taskId,
          assetId,
          assetVersionId,
        };
        await transaction("o_media_asset").insert({
          id: current.mediaAssetId,
          taskId: String(current.taskId),
          workspaceId,
          projectId,
          assetType: "video",
          source: "project-final-render",
          url: current.object.stored.url,
          localPath: current.object.storageKey,
          storageKey: current.object.storageKey,
          mimeType: "video/mp4",
          width: current.object.rendered.width,
          height: current.object.rendered.height,
          durationMs: current.object.rendered.durationMs,
          metadata: JSON.stringify(metadata),
          createTime: createdAt,
        });
        await commitObjectWriteIntentInTransaction(
          transaction,
          current.object.stored.claim,
          createObjectWriteMediaReferenceEvidence({
            rowId: current.mediaAssetId,
            workspaceId,
            projectId,
            storageKey: current.object.storageKey,
            publicUrl: current.object.stored.url,
          }),
        );
        const taskUpdated = await transaction("o_tasks")
          .where({
            id: current.taskId,
            projectId,
            taskClass: FINAL_RENDER_TASK_CLASS,
            state: "进行中",
          })
          .update({
            state: "已完成",
            reason: null,
            relatedObjects: taskRelatedObjects({
              snapshotHash,
              mediaAssetId: current.mediaAssetId,
              assetId,
              assetVersionId,
            }),
          });
        if (Number(taskUpdated) !== 1) {
          throw new FinalRenderRecoveryRequiredError();
        }

        const asset: PublicFinalRenderAsset = {
          id: current.mediaAssetId,
          taskId: String(current.taskId),
          assetId,
          assetVersionId,
          url: current.object.stored.url,
          width: current.object.rendered.width,
          height: current.object.rendered.height,
          durationMs: current.object.rendered.durationMs,
          createdAt,
        };
        const outcome: FinalRenderCommandOutcome = {
          kind: "success",
          data: {
            asset,
            reused: false,
          },
        };
        await completeDurableCommand(
          {
            kind: "resume",
            id: reservation.kind === "resume" ? reservation.id : "",
            checkpoint: current,
          },
          outcome,
          200,
          { database: transaction as any },
        );
        return { outcome, status: 200 };
      });
      return sendCommandOutcome(res, finalized.outcome, finalized.status);
    } catch (error) {
      if (error instanceof FinalRenderSelectionChangedError) {
        try {
          await queueDurableObjectWriteCompensation(
            storedObject.claim,
            error,
            { database: db },
          );
        } catch {
          return res.status(503).send({
            code: "final_render_recovery_required",
            message: "旧成片对象等待清理，请稍后使用相同 Idempotency-Key 重试",
          });
        }
        return await terminalFailure(error.status, error.code, error.message);
      }
      return res.status(503).send({
        code: "final_render_recovery_required",
        message: "成片资产登记待恢复，请使用相同 Idempotency-Key 重试",
      });
    }
  },
);
