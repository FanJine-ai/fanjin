import crypto, { randomUUID } from "node:crypto";
import path from "node:path";
import type { Knex } from "knex";

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
  type DurableObjectWriteResult,
} from "@/lib/durableObjectWrite";
import { insertAndReturnId, isPostgresClient } from "@/lib/dbDialect";
import { commitObjectWriteIntentInTransaction } from "@/lib/objectWriteIntent";
import {
  analyzeVideoStoryBuffer,
  type VideoStoryTechnicalAnalysis,
} from "@/lib/videoStoryAnalyzer";
import {
  parseVideoStoryAnalysisV1,
  VIDEO_STORY_ANALYSIS_VERSION,
  VIDEO_STORY_ANALYZER_VERSION,
  type VideoStoryAnalysisV1,
} from "@/lib/videoStoryAnalysisV1";
import u from "@/utils";
import { db } from "@/utils/db";

export const VIDEO_STORY_TASK_VERSION = "video-story-analysis-task.v1" as const;
export const VIDEO_STORY_TASK_RESOURCE_TYPE = "video_story_analysis_task";
const TASK_CLASS = "参考视频逐帧拉片";

type VideoStoryTaskPhase =
  | "queued"
  | "running"
  | "persisting"
  | "succeeded"
  | "failed"
  | "cancelled";

type SourceAuthority = Readonly<{
  assetId: number;
  assetVersionId: number;
  filePath: string;
  storageKey: string;
  extension: string;
}>;

export type VideoStoryTaskCheckpoint = {
  version: typeof VIDEO_STORY_TASK_VERSION;
  phase: VideoStoryTaskPhase;
  taskId: number | null;
  commandId: string | null;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  source: SourceAuthority;
  title: string;
  maximumShots: number;
  rightsConfirmedAt: string;
  retryOfTaskId: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  analysis: VideoStoryAnalysisV1 | null;
  failureCode: string | null;
  failureMessage: string | null;
};

export type VideoStoryTaskPublic = {
  taskId: number;
  projectId: number;
  state: VideoStoryTaskPhase;
  cancelAllowed: boolean;
  retryAllowed: boolean;
  sourceAssetVersionId: number;
  title: string;
  maximumShots: number;
  retryOfTaskId: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  reason: string | null;
  analysis: VideoStoryAnalysisV1 | null;
  billing: {
    billable: false;
    costGu: 0;
    status: "not_applicable";
    refundStatus: "not_applicable";
    reason: "local_ffmpeg_analysis";
  };
};

type TaskResponse = { task: VideoStoryTaskPublic };
type TaskReservation = {
  reservation: DurableCommandReservation<TaskResponse>;
  checkpoint: VideoStoryTaskCheckpoint;
};

export type BeginVideoStoryTaskResult =
  | { kind: "replay"; responseStatus: number; responseBody: TaskResponse }
  | ({ kind: "task" } & TaskReservation);

export type VideoStoryTaskDependencies = Readonly<{
  database?: Knex | Knex.Transaction | any;
  readSource?: (storageKey: string) => Promise<Buffer>;
  analyze?: (input: {
    body: Buffer;
    extension: string;
    maximumShots: number;
    signal: AbortSignal;
  }) => Promise<VideoStoryTechnicalAnalysis>;
  persistFrame?: (input: {
    workspaceId: string;
    projectId: number;
    actorUserId: number;
    taskId: number;
    shot: number;
    frame: Buffer;
    database: Knex | Knex.Transaction | any;
  }) => Promise<{ assetId: number; assetVersionId: number; url: string }>;
}>;

export class VideoStoryTaskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly task?: VideoStoryTaskPublic,
  ) {
    super(message);
    this.name = "VideoStoryTaskError";
  }
}

const activeControllers = new Map<number, AbortController>();
const activeExecutions = new Map<number, Promise<VideoStoryTaskPublic>>();
const recoveryInFlight = new Set<number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedIdempotencyKey(value: string | null | undefined) {
  const key = String(value || "").trim();
  if (!key) {
    throw new VideoStoryTaskError(400, "idempotency_key_required", "逐帧拉片必须提供 Idempotency-Key");
  }
  if (key.length > 200) {
    throw new VideoStoryTaskError(400, "idempotency_key_invalid", "Idempotency-Key 不能超过 200 字符");
  }
  return key;
}

function normalizedTitle(value: unknown) {
  const title = String(value || "参考视频拉片").trim();
  return (title || "参考视频拉片").slice(0, 500);
}

function normalizedMaximumShots(value: unknown) {
  const maximumShots = Number(value ?? 24);
  if (!Number.isSafeInteger(maximumShots) || maximumShots < 1 || maximumShots > 40) {
    throw new VideoStoryTaskError(400, "video_story_maximum_shots_invalid", "镜头上限必须为 1-40");
  }
  return maximumShots;
}

export function parseVideoStoryTaskCheckpoint(value: unknown): VideoStoryTaskCheckpoint | null {
  if (!isRecord(value) || value.version !== VIDEO_STORY_TASK_VERSION) return null;
  const phase = String(value.phase || "") as VideoStoryTaskPhase;
  const taskId = value.taskId === null ? null : Number(value.taskId);
  const source = isRecord(value.source) ? value.source : null;
  if (
    !["queued", "running", "persisting", "succeeded", "failed", "cancelled"].includes(phase)
    || (taskId !== null && (!Number.isSafeInteger(taskId) || taskId <= 0))
    || !Number.isSafeInteger(Number(value.actorUserId))
    || Number(value.actorUserId) <= 0
    || !Number.isSafeInteger(Number(value.projectId))
    || Number(value.projectId) <= 0
    || !String(value.workspaceId || "").trim()
    || !source
    || !Number.isSafeInteger(Number(source.assetId))
    || !Number.isSafeInteger(Number(source.assetVersionId))
    || !String(source.storageKey || "").trim()
    || !String(source.filePath || "").trim()
  ) return null;
  if (value.analysis !== null) {
    const parsed = parseVideoStoryAnalysisV1(value.analysis);
    return { ...(value as unknown as VideoStoryTaskCheckpoint), analysis: parsed };
  }
  return value as unknown as VideoStoryTaskCheckpoint;
}

export function toPublicVideoStoryTask(
  checkpoint: VideoStoryTaskCheckpoint,
  reason?: string | null,
): VideoStoryTaskPublic {
  if (checkpoint.taskId === null) {
    throw new VideoStoryTaskError(500, "video_story_task_invalid", "逐帧拉片任务缺少持久任务标识");
  }
  return {
    taskId: checkpoint.taskId,
    projectId: checkpoint.projectId,
    state: checkpoint.phase,
    cancelAllowed: ["queued", "running"].includes(checkpoint.phase),
    retryAllowed: checkpoint.phase === "failed",
    sourceAssetVersionId: checkpoint.source.assetVersionId,
    title: checkpoint.title,
    maximumShots: checkpoint.maximumShots,
    retryOfTaskId: checkpoint.retryOfTaskId,
    startedAt: checkpoint.startedAt,
    finishedAt: checkpoint.finishedAt,
    reason: checkpoint.failureMessage || reason || null,
    analysis: checkpoint.analysis,
    billing: {
      billable: false,
      costGu: 0,
      status: "not_applicable",
      refundStatus: "not_applicable",
      reason: "local_ffmpeg_analysis",
    },
  };
}

function parsePublicVideoStoryTask(value: unknown): VideoStoryTaskPublic | null {
  if (!isRecord(value) || !isRecord(value.billing)) return null;
  const state = String(value.state || "") as VideoStoryTaskPhase;
  const taskId = Number(value.taskId);
  const projectId = Number(value.projectId);
  const sourceAssetVersionId = Number(value.sourceAssetVersionId);
  const maximumShots = Number(value.maximumShots);
  const retryOfTaskId = value.retryOfTaskId === null ? null : Number(value.retryOfTaskId);
  const startedAt = value.startedAt === null ? null : Number(value.startedAt);
  const finishedAt = value.finishedAt === null ? null : Number(value.finishedAt);
  if (
    !["queued", "running", "persisting", "succeeded", "failed", "cancelled"].includes(state)
    || !Number.isSafeInteger(taskId) || taskId <= 0
    || !Number.isSafeInteger(projectId) || projectId <= 0
    || !Number.isSafeInteger(sourceAssetVersionId) || sourceAssetVersionId <= 0
    || !Number.isSafeInteger(maximumShots) || maximumShots < 1 || maximumShots > 40
    || (retryOfTaskId !== null && (!Number.isSafeInteger(retryOfTaskId) || retryOfTaskId <= 0))
    || (startedAt !== null && (!Number.isSafeInteger(startedAt) || startedAt < 0))
    || (finishedAt !== null && (!Number.isSafeInteger(finishedAt) || finishedAt < 0))
    || typeof value.title !== "string" || !value.title.trim() || value.title.length > 500
    || typeof value.cancelAllowed !== "boolean"
    || typeof value.retryAllowed !== "boolean"
    || value.cancelAllowed !== ["queued", "running"].includes(state)
    || value.retryAllowed !== (state === "failed")
    || (value.reason !== null && typeof value.reason !== "string")
    || value.billing.billable !== false
    || value.billing.costGu !== 0
    || value.billing.status !== "not_applicable"
    || value.billing.refundStatus !== "not_applicable"
    || value.billing.reason !== "local_ffmpeg_analysis"
  ) return null;
  let analysis: VideoStoryAnalysisV1 | null = null;
  if (value.analysis !== null) {
    try {
      analysis = parseVideoStoryAnalysisV1(value.analysis);
    } catch {
      return null;
    }
  }
  if (state === "succeeded" && !analysis) return null;
  return {
    taskId,
    projectId,
    state,
    cancelAllowed: value.cancelAllowed,
    retryAllowed: value.retryAllowed,
    sourceAssetVersionId,
    title: value.title,
    maximumShots,
    retryOfTaskId,
    startedAt,
    finishedAt,
    reason: value.reason,
    analysis,
    billing: {
      billable: false,
      costGu: 0,
      status: "not_applicable",
      refundStatus: "not_applicable",
      reason: "local_ffmpeg_analysis",
    },
  };
}

async function loadSourceAuthority(input: {
  database: Knex | Knex.Transaction | any;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  lock?: boolean;
}): Promise<SourceAuthority> {
  let query = input.database("o_image as version")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .where({
      "version.id": input.assetVersionId,
      "asset.projectId": input.projectId,
      "project.workspaceId": input.workspaceId,
      "version.deletionState": "active",
      "asset.deletionState": "active",
      "project.deletionState": "active",
    })
    .whereIn("version.type", ["video", "clip"])
    .whereRaw("asset.type = version.type")
    .select(
      "asset.id as assetId",
      "version.id as assetVersionId",
      "version.filePath",
      "version.storageKey",
      "version.state",
    );
  if (input.lock && isPostgresClient(input.database)) query = query.forUpdate();
  const row = await query.first();
  const filePath = String(row?.filePath || "").replace(/\\/gu, "/");
  const storageKey = String(row?.storageKey || row?.filePath || "")
    .replace(/\\/gu, "/")
    .replace(/^\/+/, "");
  if (
    !row
    || !["已完成", "生成成功"].includes(String(row.state || ""))
    || !storageKey.startsWith(`${input.projectId}/`)
  ) {
    throw new VideoStoryTaskError(
      422,
      "video_story_source_invalid",
      "参考视频不存在、跨项目、已撤回或未进入受控存储",
    );
  }
  return {
    assetId: Number(row.assetId),
    assetVersionId: Number(row.assetVersionId),
    filePath,
    storageKey,
    extension: path.extname(filePath || storageKey).replace(/^\./u, "").toLowerCase() || "mp4",
  };
}

async function lockActiveProject(transaction: Knex.Transaction, workspaceId: string, projectId: number) {
  let query = transaction("o_project")
    .where({ id: projectId, workspaceId, deletionState: "active" })
    .select("id");
  if (isPostgresClient(transaction)) query = query.forUpdate();
  if (!await query.first()) {
    throw new VideoStoryTaskError(409, "video_story_project_not_active", "项目正在删除或已不可用");
  }
}

async function updateCheckpoint(
  task: TaskReservation,
  mutate: (
    checkpoint: VideoStoryTaskCheckpoint,
    transaction: Knex.Transaction,
  ) => Promise<VideoStoryTaskCheckpoint> | VideoStoryTaskCheckpoint,
  database: Knex | Knex.Transaction | any,
): Promise<TaskReservation> {
  const mutation = await mutateDurableCommandCheckpoint<TaskResponse, VideoStoryTaskCheckpoint>(
    task.reservation,
    async (current, transaction) => {
      const checkpoint = parseVideoStoryTaskCheckpoint(current);
      if (!checkpoint) {
        throw new VideoStoryTaskError(500, "video_story_checkpoint_invalid", "逐帧拉片恢复检查点无效");
      }
      return mutate(checkpoint, transaction);
    },
    { database },
  );
  if (mutation.kind === "replay") {
    throw new VideoStoryTaskError(409, "video_story_task_completed", "逐帧拉片任务已经结束");
  }
  const checkpoint = parseVideoStoryTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint) {
    throw new VideoStoryTaskError(500, "video_story_checkpoint_invalid", "逐帧拉片恢复检查点无效");
  }
  return {
    reservation: { kind: "resume", id: mutation.id, checkpoint },
    checkpoint,
  };
}

export async function beginVideoStoryAnalysisTask(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  assetVersionId: number;
  title?: string | null;
  maximumShots?: number | null;
  rightsConfirmed: boolean;
  retryOfTaskId?: number | null;
  idempotencyKey?: string | null;
}, dependencies: VideoStoryTaskDependencies = {}): Promise<BeginVideoStoryTaskResult> {
  const database = dependencies.database || db;
  if (!input.rightsConfirmed) {
    throw new VideoStoryTaskError(
      422,
      "video_story_rights_confirmation_required",
      "请确认拥有该视频的分析与再创作权利",
    );
  }
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    throw new VideoStoryTaskError(401, "video_story_actor_invalid", "登录身份无效");
  }
  const idempotencyKey = normalizedIdempotencyKey(input.idempotencyKey);
  const maximumShots = normalizedMaximumShots(input.maximumShots);
  const source = await loadSourceAuthority({
    database,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    assetVersionId: input.assetVersionId,
  });
  const retryOfTaskId = input.retryOfTaskId == null ? null : Number(input.retryOfTaskId);
  if (retryOfTaskId !== null) {
    const [previous] = await readVideoStoryAnalysisTasks({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      taskIds: [retryOfTaskId],
    }, dependencies);
    if (!previous || !previous.retryAllowed || previous.sourceAssetVersionId !== source.assetVersionId) {
      throw new VideoStoryTaskError(409, "video_story_retry_not_allowed", "只能重试同一视频的失败任务");
    }
  }
  const rightsConfirmedAt = new Date().toISOString();
  const initialCheckpoint: VideoStoryTaskCheckpoint = {
    version: VIDEO_STORY_TASK_VERSION,
    phase: "queued",
    taskId: null,
    commandId: null,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    source,
    title: normalizedTitle(input.title),
    maximumShots,
    rightsConfirmedAt,
    retryOfTaskId,
    startedAt: null,
    finishedAt: null,
    analysis: null,
    failureCode: null,
    failureMessage: null,
  };
  let reservation: DurableCommandReservation<TaskResponse>;
  try {
    reservation = await beginDurableCommand<TaskResponse>({
      database,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      scope: "workbench:video-story-analysis",
      idempotencyKey,
      request: {
        projectId: input.projectId,
        assetVersionId: source.assetVersionId,
        title: initialCheckpoint.title,
        maximumShots,
        rightsConfirmed: true,
        retryOfTaskId,
      },
      initialCheckpoint,
    });
  } catch (error) {
    if (error instanceof DurableCommandIdempotencyError) {
      throw new VideoStoryTaskError(error.status, error.code, error.message);
    }
    throw error;
  }
  if (reservation.kind === "replay") return reservation;
  if (reservation.kind !== "resume") {
    throw new VideoStoryTaskError(500, "video_story_checkpoint_missing", "逐帧拉片任务未建立恢复检查点");
  }
  const mutation = await mutateDurableCommandCheckpoint<TaskResponse, VideoStoryTaskCheckpoint>(
    reservation,
    async (current, transaction) => {
      const checkpoint = parseVideoStoryTaskCheckpoint(current);
      if (!checkpoint) throw new VideoStoryTaskError(500, "video_story_checkpoint_invalid", "逐帧拉片恢复检查点无效");
      if (checkpoint.taskId !== null) return checkpoint;
      await lockActiveProject(transaction, checkpoint.workspaceId, checkpoint.projectId);
      await loadSourceAuthority({
        database: transaction,
        workspaceId: checkpoint.workspaceId,
        projectId: checkpoint.projectId,
        assetVersionId: checkpoint.source.assetVersionId,
        lock: true,
      });
      const taskId = await insertAndReturnId(transaction, "o_tasks", {
        projectId: checkpoint.projectId,
        taskClass: TASK_CLASS,
        relatedObjects: JSON.stringify({
          version: VIDEO_STORY_TASK_VERSION,
          commandId: reservation.id,
          sourceAssetId: checkpoint.source.assetId,
          sourceAssetVersionId: checkpoint.source.assetVersionId,
          rightsConfirmedAt: checkpoint.rightsConfirmedAt,
          retryOfTaskId: checkpoint.retryOfTaskId,
        }),
        model: "ffmpeg-scene-detection",
        describe: `分析视频资产版本 ${checkpoint.source.assetVersionId}`,
        state: "排队中",
        startTime: Date.now(),
        reason: "本地 FFmpeg 技术分析，0 GU",
      });
      await transaction("o_agent_idempotency")
        .where({ id: reservation.id, status: "checkpointed" })
        .update({ resourceType: VIDEO_STORY_TASK_RESOURCE_TYPE, resourceId: String(taskId) });
      return { ...checkpoint, taskId, commandId: reservation.id };
    },
    { database },
  );
  if (mutation.kind === "replay") return mutation;
  const checkpoint = parseVideoStoryTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint || checkpoint.taskId === null) {
    throw new VideoStoryTaskError(500, "video_story_checkpoint_invalid", "逐帧拉片任务缺少持久任务标识");
  }
  return {
    kind: "task",
    reservation: { kind: "resume", id: mutation.id, checkpoint },
    checkpoint,
  };
}

async function persistFrameDefault(input: {
  workspaceId: string;
  projectId: number;
  taskId: number;
  shot: number;
  frame: Buffer;
  database: Knex | Knex.Transaction | any;
}) {
  let durable: DurableObjectWriteResult | null = null;
  try {
    durable = await writeObjectWithDurableIntent({
      purpose: "direct_upload",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      body: input.frame,
      contentSha256: crypto.createHash("sha256").update(input.frame).digest("hex"),
      storageKey: (intentId) => `${input.projectId}/assets/references/${intentId}.jpg`,
      writerIdPrefix: "video-story-keyframe",
    }, { database: input.database });
    const createdAt = Date.now();
    const result = await input.database.transaction(async (transaction: Knex.Transaction) => {
      const assetId = await insertAndReturnId(transaction, "o_assets", {
        type: "image",
        projectId: input.projectId,
        name: `拉片任务 ${input.taskId} 镜头 ${input.shot} 关键帧`.slice(0, 80),
        describe: `由参考视频逐帧拉片任务 ${input.taskId} 提取`,
        startTime: createdAt,
      });
      const filePath = `/${durable!.storageKey}`;
      const assetVersionId = await insertAndReturnId(transaction, "o_image", {
        filePath,
        storageKey: durable!.storageKey,
        type: "image",
        assetsId: assetId,
        model: "ffmpeg-frame-extract",
        state: "已完成",
      });
      await transaction("o_assets")
        .where({ id: assetId, projectId: input.projectId })
        .update({ imageId: assetVersionId });
      await commitObjectWriteIntentInTransaction(transaction, durable!.claim, {
        version: "object-write-reference.v1",
        table: "o_image",
        rowId: String(assetVersionId),
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        storageKey: durable!.storageKey,
      });
      return { assetId, assetVersionId };
    });
    return {
      ...result,
      url: `/api/assets/getReferenceFile?id=${result.assetId}&disposition=inline`,
    };
  } catch (error) {
    if (durable) {
      await queueDurableObjectWriteCompensation(durable.claim, error, { database: input.database })
        .catch((queueError) => console.error("[video-story-analysis] keyframe compensation queue failed", {
          taskId: input.taskId,
          shot: input.shot,
          message: queueError instanceof Error ? queueError.message : String(queueError),
        }));
    }
    throw error;
  }
}

function editablePlaceholder() {
  return "待人工补充";
}

function failureFor(error: unknown) {
  const code = error instanceof Error ? error.message : "video_story_analysis_failed";
  if (code === "video_story_media_tool_unavailable") {
    return { code, message: "当前服务未配置 FFmpeg/ffprobe，逐帧拉片不可用" };
  }
  if (code === "video_story_source_size_invalid") {
    return { code, message: "参考视频文件无效或超过 256 MiB" };
  }
  if (code === "video_story_video_unsupported") {
    return { code, message: "参考视频时长、尺寸或编码超出本地分析范围" };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "video_story_task_cancelled", message: "逐帧拉片已取消" };
  }
  return { code: "video_story_analysis_failed", message: "逐帧拉片失败，请检查视频后重试" };
}

async function finishTask(
  task: TaskReservation,
  phase: "succeeded" | "failed",
  database: Knex | Knex.Transaction | any,
) {
  const next = await updateCheckpoint(task, async (checkpoint, transaction) => {
    const failureMessage = phase === "failed" ? checkpoint.failureMessage || "逐帧拉片失败" : null;
    await transaction("o_tasks")
      .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
      .update({
        state: phase === "succeeded" ? "已完成" : "生成失败",
        reason: failureMessage || "本地 FFmpeg 技术分析已完成，0 GU",
      });
    return { ...checkpoint, phase, finishedAt: Date.now(), failureMessage };
  }, database);
  const publicTask = toPublicVideoStoryTask(next.checkpoint);
  await completeDurableCommand(next.reservation, { task: publicTask }, 200, { database });
  return publicTask;
}

export async function runVideoStoryAnalysisTask(
  initialTask: TaskReservation,
  dependencies: VideoStoryTaskDependencies = {},
): Promise<VideoStoryTaskPublic> {
  const database = dependencies.database || db;
  const taskId = initialTask.checkpoint.taskId;
  if (taskId === null) throw new VideoStoryTaskError(500, "video_story_task_invalid", "逐帧拉片任务缺少标识");
  const controller = new AbortController();
  activeControllers.set(taskId, controller);
  let task = initialTask;
  try {
    task = await updateCheckpoint(task, async (checkpoint, transaction) => {
      if (checkpoint.phase !== "queued") return checkpoint;
      const source = await loadSourceAuthority({
        database: transaction,
        workspaceId: checkpoint.workspaceId,
        projectId: checkpoint.projectId,
        assetVersionId: checkpoint.source.assetVersionId,
        lock: true,
      });
      await transaction("o_tasks")
        .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
        .update({ state: "进行中", reason: "正在检测镜头切点与抽取关键帧；0 GU" });
      return { ...checkpoint, source, phase: "running", startedAt: Date.now() };
    }, database);
    if (task.checkpoint.phase !== "running") return toPublicVideoStoryTask(task.checkpoint);
    const body = await (dependencies.readSource || ((storageKey) => u.oss.getFile(storageKey)))(
      task.checkpoint.source.storageKey,
    );
    controller.signal.throwIfAborted();
    const technical = await (dependencies.analyze || ((input) => analyzeVideoStoryBuffer(input)))({
      body,
      extension: task.checkpoint.source.extension,
      maximumShots: task.checkpoint.maximumShots,
      signal: controller.signal,
    });
    task = await updateCheckpoint(task, async (checkpoint, transaction) => {
      if (checkpoint.phase !== "running") return checkpoint;
      await transaction("o_tasks")
        .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
        .update({ state: "进行中", reason: `正在持久化 ${technical.shots.length} 个关键帧；0 GU` });
      return { ...checkpoint, phase: "persisting" };
    }, database);
    if (task.checkpoint.phase !== "persisting") return toPublicVideoStoryTask(task.checkpoint);
    const rows: VideoStoryAnalysisV1["rows"] = [];
    for (let index = 0; index < technical.shots.length; index += 1) {
      const shot = technical.shots[index];
      const persisted = await (dependencies.persistFrame || persistFrameDefault)({
        workspaceId: task.checkpoint.workspaceId,
        projectId: task.checkpoint.projectId,
        actorUserId: task.checkpoint.actorUserId,
        taskId,
        shot: index + 1,
        frame: shot.frame,
        database,
      });
      rows.push({
        id: randomUUID(),
        shot: index + 1,
        startTime: shot.startTime,
        endTime: shot.endTime,
        duration: shot.duration,
        frameTime: shot.frameTime,
        sceneConfidence: shot.sceneConfidence,
        keyframeAssetId: persisted.assetId,
        keyframeAssetVersionId: persisted.assetVersionId,
        keyframeUrl: persisted.url,
        visualDescription: editablePlaceholder(),
        narrative: editablePlaceholder(),
        shotSize: editablePlaceholder(),
        cameraAngle: editablePlaceholder(),
        cameraMovement: editablePlaceholder(),
        focusDepth: editablePlaceholder(),
        lighting: editablePlaceholder(),
        backgroundMusic: editablePlaceholder(),
        voiceSound: editablePlaceholder(),
        subtitle: editablePlaceholder(),
        imagePrompt: editablePlaceholder(),
        videoMotionPrompt: editablePlaceholder(),
        keywords: "",
      });
    }
    const analysis = parseVideoStoryAnalysisV1({
      version: VIDEO_STORY_ANALYSIS_VERSION,
      analyzer: {
        id: "ffmpeg-scene-detection",
        version: VIDEO_STORY_ANALYZER_VERSION,
        semanticUnderstanding: false,
        sceneThreshold: technical.sceneThreshold,
      },
      source: {
        projectId: task.checkpoint.projectId,
        assetId: task.checkpoint.source.assetId,
        assetVersionId: task.checkpoint.source.assetVersionId,
        sha256: technical.sourceSha256,
      },
      title: task.checkpoint.title,
      duration: technical.duration,
      width: technical.width,
      height: technical.height,
      generatedAt: new Date().toISOString(),
      rights: {
        confirmed: true,
        confirmedAt: task.checkpoint.rightsConfirmedAt,
        confirmedByUserId: task.checkpoint.actorUserId,
      },
      billing: {
        billable: false,
        costGu: 0,
        status: "not_applicable",
        refundStatus: "not_applicable",
        reason: "local_ffmpeg_analysis",
      },
      rows,
    });
    task = await updateCheckpoint(task, (checkpoint) => ({ ...checkpoint, analysis }), database);
    return await finishTask(task, "succeeded", database);
  } catch (error) {
    if (error instanceof VideoStoryTaskError && error.code === "video_story_task_completed") {
      const [completed] = await readVideoStoryAnalysisTasks({
        workspaceId: initialTask.checkpoint.workspaceId,
        projectId: initialTask.checkpoint.projectId,
        taskIds: [taskId],
      }, dependencies);
      if (completed) return completed;
      throw error;
    }
    const failure = failureFor(error);
    if (failure.code === "video_story_task_cancelled") {
      const [cancelled] = await readVideoStoryAnalysisTasks({
        workspaceId: initialTask.checkpoint.workspaceId,
        projectId: initialTask.checkpoint.projectId,
        taskIds: [taskId],
      }, dependencies);
      if (cancelled?.state === "cancelled") return cancelled;
    }
    task = await updateCheckpoint(task, (checkpoint) => ({
      ...checkpoint,
      failureCode: failure.code,
      failureMessage: failure.message,
    }), database);
    return await finishTask(task, "failed", database);
  } finally {
    if (activeControllers.get(taskId) === controller) activeControllers.delete(taskId);
  }
}

export function scheduleVideoStoryAnalysisTask(
  task: TaskReservation,
  dependencies: VideoStoryTaskDependencies = {},
): Promise<VideoStoryTaskPublic> {
  const taskId = task.checkpoint.taskId;
  if (taskId === null) {
    return Promise.reject(new VideoStoryTaskError(
      500,
      "video_story_task_invalid",
      "逐帧拉片任务缺少持久任务标识",
    ));
  }
  const existing = activeExecutions.get(taskId);
  if (existing) return existing;
  const execution = runVideoStoryAnalysisTask(task, dependencies);
  activeExecutions.set(taskId, execution);
  void execution.then(
    () => {
      if (activeExecutions.get(taskId) === execution) activeExecutions.delete(taskId);
    },
    () => {
      if (activeExecutions.get(taskId) === execution) activeExecutions.delete(taskId);
    },
  );
  return execution;
}

export async function resumeVideoStoryAnalysisTask(input: {
  workspaceId: string;
  projectId: number;
  taskId: number;
}, dependencies: VideoStoryTaskDependencies = {}): Promise<VideoStoryTaskPublic | null> {
  if (activeExecutions.has(input.taskId)) return null;
  if (recoveryInFlight.has(input.taskId)) return null;
  recoveryInFlight.add(input.taskId);
  try {
    const database = dependencies.database || db;
    const command = await database("o_agent_idempotency")
      .where({
        workspaceId: input.workspaceId,
        resourceType: VIDEO_STORY_TASK_RESOURCE_TYPE,
        resourceId: String(input.taskId),
        status: "checkpointed",
      })
      .first();
    if (!command) return null;
    const checkpoint = parseVideoStoryTaskCheckpoint(JSON.parse(String(command.responseBody || "")));
    if (!checkpoint || checkpoint.projectId !== input.projectId || checkpoint.taskId !== input.taskId) {
      return null;
    }
    const task: TaskReservation = {
      reservation: { kind: "resume", id: String(command.id), checkpoint },
      checkpoint,
    };
    if (checkpoint.phase === "queued" || checkpoint.phase === "running") {
      return await scheduleVideoStoryAnalysisTask(task, dependencies);
    }
    if (checkpoint.phase === "persisting") {
      const interrupted = await updateCheckpoint(task, async (value, transaction) => {
        if (value.phase !== "persisting") return value;
        await transaction("o_tasks")
          .where({ id: input.taskId, projectId: input.projectId })
          .update({
            state: "生成失败",
            reason: "服务重启中断关键帧持久化；原视频和既有分镜未修改，可重试",
          });
        return {
          ...value,
          failureCode: "video_story_persistence_interrupted",
          failureMessage: "服务重启中断关键帧持久化；原视频和既有分镜未修改，可重试",
        };
      }, database);
      return await finishTask(interrupted, "failed", database);
    }
    return toPublicVideoStoryTask(checkpoint);
  } finally {
    recoveryInFlight.delete(input.taskId);
  }
}

export async function readVideoStoryAnalysisTasks(input: {
  workspaceId: string;
  projectId: number;
  taskIds?: number[];
}, dependencies: VideoStoryTaskDependencies = {}): Promise<VideoStoryTaskPublic[]> {
  const database = dependencies.database || db;
  const project = await database("o_project")
    .where({ id: input.projectId, workspaceId: input.workspaceId, deletionState: "active" })
    .first();
  if (!project) throw new VideoStoryTaskError(404, "video_story_project_not_found", "项目不存在或已不可用");
  let query = database("o_tasks")
    .where({ projectId: input.projectId, taskClass: TASK_CLASS })
    .orderBy("id", "desc");
  if (input.taskIds?.length) query = query.whereIn("id", input.taskIds);
  else query = query.limit(50);
  const rows = await query;
  if (!rows.length) return [];
  const commands = await database("o_agent_idempotency")
    .where({ workspaceId: input.workspaceId, resourceType: VIDEO_STORY_TASK_RESOURCE_TYPE })
    .whereIn("resourceId", rows.map((row: any) => String(row.id)));
  const commandByTask = new Map(commands.map((row: any) => [String(row.resourceId), row]));
  const tasks: VideoStoryTaskPublic[] = [];
  for (const row of rows) {
    const command: any = commandByTask.get(String(row.id));
    if (!command) continue;
    try {
      if (String(command.status) === "completed") {
        const body = JSON.parse(String(command.responseBody || ""));
        const checkpointTask = parsePublicVideoStoryTask(body?.task);
        if (
          checkpointTask?.taskId === Number(row.id)
          && checkpointTask.projectId === input.projectId
        ) tasks.push(checkpointTask);
      } else {
        const checkpoint = parseVideoStoryTaskCheckpoint(JSON.parse(String(command.responseBody || "")));
        if (checkpoint) tasks.push(toPublicVideoStoryTask(checkpoint, row.reason));
      }
    } catch {
      // Corrupted durable evidence is fail-closed and not exposed as a usable task.
    }
  }
  return tasks;
}

export async function cancelVideoStoryAnalysisTask(input: {
  workspaceId: string;
  projectId: number;
  taskId: number;
}, dependencies: VideoStoryTaskDependencies = {}): Promise<{ cancelled: boolean; task: VideoStoryTaskPublic }> {
  const database = dependencies.database || db;
  const [current] = await readVideoStoryAnalysisTasks({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    taskIds: [input.taskId],
  }, dependencies);
  if (!current) throw new VideoStoryTaskError(404, "video_story_task_not_found", "逐帧拉片任务不存在");
  if (!current.cancelAllowed) return { cancelled: false, task: current };
  const command = await database("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      resourceType: VIDEO_STORY_TASK_RESOURCE_TYPE,
      resourceId: String(input.taskId),
      status: "checkpointed",
    })
    .first();
  if (!command) return { cancelled: false, task: current };
  const checkpoint = parseVideoStoryTaskCheckpoint(JSON.parse(String(command.responseBody || "")));
  if (!checkpoint) throw new VideoStoryTaskError(500, "video_story_checkpoint_invalid", "逐帧拉片恢复检查点无效");
  const active: TaskReservation = {
    reservation: { kind: "resume", id: String(command.id), checkpoint },
    checkpoint,
  };
  let cancelled = false;
  const next = await updateCheckpoint(active, async (value, transaction) => {
    if (!["queued", "running"].includes(value.phase)) return value;
    cancelled = true;
    await transaction("o_tasks")
      .where({ id: input.taskId, projectId: input.projectId })
      .update({ state: "已取消", reason: "本地分析已取消；未产生模型费用" });
    return {
      ...value,
      phase: "cancelled",
      finishedAt: Date.now(),
      failureCode: "video_story_task_cancelled",
      failureMessage: "本地分析已取消；未产生模型费用",
    };
  }, database);
  const task = toPublicVideoStoryTask(next.checkpoint);
  if (cancelled) {
    activeControllers.get(input.taskId)?.abort();
    await completeDurableCommand(next.reservation, { task }, 200, { database });
  }
  return { cancelled, task };
}
