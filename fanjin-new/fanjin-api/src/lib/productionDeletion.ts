import type { Knex } from "knex";

import { isPostgresClient } from "@/lib/dbDialect";

const TERMINAL_VIDEO_STATES = new Set([
  "已完成",
  "生成成功",
  "生成失败",
  "已取消",
]);
const TERMINAL_RELAY_STATES = new Set([
  "mocked",
  "succeeded",
  "failed",
  "cancelled",
]);
const ACTIVE_TASK_STATES = ["进行中", "生成中"];
const EDITOR_DRAFT_KEY = "workbenchEditorDraft";
const RELEVANT_COMMAND_SCOPES = [
  "production:storyboard:image",
  "production:workbench:batch-generate-video",
  "workbench:create:videos",
  "production:workbench:render-final-video",
] as const;

export class ProductionDeletionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductionDeletionError";
  }
}

function fail(status: number, code: string, message: string): never {
  throw new ProductionDeletionError(status, code, message);
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function numberSet(values: unknown[]): Set<number> {
  return new Set(values.map(positiveId).filter((value): value is number => value !== null));
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function maybeLock<T extends Knex.QueryBuilder>(
  transaction: Knex.Transaction,
  query: T,
): T {
  return isPostgresClient(transaction) ? query.forUpdate() as T : query;
}

type DeletionTargets = {
  kind: "script" | "storyboard" | "video";
  scriptIds?: Set<number>;
  storyboardIds?: Set<number>;
  trackIds?: Set<number>;
  videoIds?: Set<number>;
};

function intersects(targets: Set<number> | undefined, values: unknown[]): boolean {
  if (!targets?.size) return false;
  return values.some((value) => {
    const id = positiveId(value);
    return id !== null && targets.has(id);
  });
}

function commandScope(scopeKey: unknown): typeof RELEVANT_COMMAND_SCOPES[number] | null {
  const normalized = String(scopeKey || "");
  return RELEVANT_COMMAND_SCOPES.find((scope) =>
    normalized.startsWith(`${scope}:`)) || null;
}

function activeCommandTouchesTargets(
  row: Record<string, unknown>,
  projectId: number,
  targets: DeletionTargets,
): boolean {
  const scope = commandScope(row.scopeKey);
  if (!scope) return false;
  const checkpoint = parseRecord(row.responseBody);
  if (!checkpoint) {
    // A reservation exists before the first checkpoint contains target IDs.
    // The request body is represented only by a hash, so fail closed for the
    // project until the reservation is completed or abandoned.
    return String(row.resourceType || "") === "project"
      && String(row.resourceId || "") === String(projectId);
  }
  const checkpointProjectId = positiveId(checkpoint.projectId);
  if (checkpointProjectId !== null && checkpointProjectId !== projectId) return false;
  if (
    checkpointProjectId === null
    && !(
      String(row.resourceType || "") === "project"
      && String(row.resourceId || "") === String(projectId)
    )
  ) return false;

  const scriptMatch = () => intersects(targets.scriptIds, [checkpoint.scriptId]);

  if (scope === "production:storyboard:image") {
    if (targets.kind === "video") return false;
    if (targets.kind === "script") return scriptMatch();
    const storyboardId = positiveId(checkpoint.storyboardId);
    return storyboardId !== null
      ? intersects(targets.storyboardIds, [storyboardId])
      : scriptMatch();
  }
  if (scope === "production:workbench:render-final-video") {
    return targets.kind === "script" || targets.kind === "video";
  }
  if (
    scope === "production:workbench:batch-generate-video"
    || scope === "workbench:create:videos"
  ) {
    if (targets.kind === "script") return scriptMatch();
    const rawItems = scope === "production:workbench:batch-generate-video"
      ? checkpoint.videos
      : checkpoint.tracks;
    const items = Array.isArray(rawItems) ? rawItems : [];
    let comparable = false;
    for (const item of items) {
      const record = parseRecord(item);
      if (!record) continue;
      const trackId = positiveId(record.trackId);
      if (trackId !== null) {
        comparable = true;
        if (intersects(targets.trackIds, [trackId])) return true;
      }
      if (targets.kind === "video") {
        const videoId = positiveId(record.videoId);
        if (videoId !== null) {
          comparable = true;
          if (intersects(targets.videoIds, [videoId])) return true;
        }
      }
    }
    return comparable ? false : scriptMatch();
  }
  return true;
}

async function assertNoActiveCommands(
  transaction: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    targets: DeletionTargets;
  },
): Promise<void> {
  let query = transaction("o_agent_idempotency")
    .where({ workspaceId: input.workspaceId })
    .whereIn("status", ["reserved", "checkpointed"])
    .andWhere((builder) => {
      builder.where((scopeBuilder) => {
        for (const [index, scope] of RELEVANT_COMMAND_SCOPES.entries()) {
          const method = index === 0 ? "where" : "orWhere";
          scopeBuilder[method]("scopeKey", "like", `${scope}:%`);
        }
      });
    })
    .select(
      "id",
      "scopeKey",
      "status",
      "responseBody",
      "resourceType",
      "resourceId",
    );
  const rows = await query;
  if (rows.some((row) => activeCommandTouchesTargets(row, input.projectId, input.targets))) {
    fail(
      409,
      "PRODUCTION_DELETION_ACTIVE_COMMAND",
      "目标内容仍被可恢复的生成命令引用，请先等待任务结束或取消",
    );
  }
}

async function assertNoActiveTasks(
  transaction: Knex.Transaction,
  input: { projectId: number; targets: DeletionTargets },
): Promise<void> {
  let query = transaction("o_tasks")
    .where({ projectId: input.projectId })
    .whereIn("state", ACTIVE_TASK_STATES)
    .select("id", "taskClass", "relatedObjects", "state");
  query = maybeLock(transaction, query);
  const tasks = await query;
  for (const task of tasks) {
    const related = parseRecord(task.relatedObjects);
    const taskClass = String(task.taskClass || "");
    if (
      taskClass === "成片合成"
      && (input.targets.kind === "script" || input.targets.kind === "video")
    ) {
      fail(
        409,
        "PRODUCTION_DELETION_ACTIVE_WORK",
        "当前项目正在合成成片，请等待任务结束后再删除",
      );
    }
    if (!related) {
      if (
        taskClass === "分镜图片生成"
        && input.targets.kind !== "video"
      ) {
        fail(
          409,
          "PRODUCTION_DELETION_ACTIVE_IMAGE_WORK",
          "分镜仍有未终态图片生成任务",
        );
      }
      continue;
    }
    let touches = false;
    if (input.targets.kind === "script") {
      touches = intersects(input.targets.scriptIds, [related.scriptId]);
    } else if (input.targets.kind === "storyboard") {
      const storyboardId = positiveId(related.storyboardId);
      const trackId = positiveId(related.trackId);
      touches = storyboardId !== null
        ? intersects(input.targets.storyboardIds, [storyboardId])
        : trackId !== null
          ? intersects(input.targets.trackIds, [trackId])
          : intersects(input.targets.scriptIds, [related.scriptId]);
    } else if (!taskClass.includes("图片")) {
      const videoId = positiveId(related.videoId);
      const trackId = positiveId(related.trackId);
      touches = (
        videoId !== null && intersects(input.targets.videoIds, [videoId])
      ) || (
        trackId !== null && intersects(input.targets.trackIds, [trackId])
      ) || (
        videoId === null
        && trackId === null
        && intersects(input.targets.scriptIds, [related.scriptId])
      );
    }
    if (touches) {
      fail(
        409,
        taskClass.includes("图片")
          ? "PRODUCTION_DELETION_ACTIVE_IMAGE_WORK"
          : "PRODUCTION_DELETION_ACTIVE_WORK",
        "目标内容仍有未终态生成任务",
      );
    }
  }
}

async function assertVideosTerminal(
  transaction: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    videos: Array<Record<string, unknown>>;
  },
): Promise<void> {
  const relayIds = [...new Set(input.videos
    .map((video) => String(video.relayTaskId || "").trim())
    .filter(Boolean))];
  if (relayIds.length) {
    let query = transaction("o_relay_task")
      .whereIn("id", relayIds)
      .select("id", "workspaceId", "projectId", "status");
    query = maybeLock(transaction, query);
    const relays = await query;
    const byId = new Map(relays.map((relay) => [String(relay.id), relay]));
    for (const relayId of relayIds) {
      const relay = byId.get(relayId);
      if (
        !relay
        || String(relay.workspaceId || "") !== input.workspaceId
        || Number(relay.projectId) !== input.projectId
      ) {
        fail(
          409,
          "PRODUCTION_DELETION_AUTHORITY_CHAIN_INVALID",
          "视频与 Relay 任务的归属链不完整",
        );
      }
      if (!TERMINAL_RELAY_STATES.has(String(relay.status || ""))) {
        fail(
          409,
          "PRODUCTION_DELETION_ACTIVE_RELAY",
          "视频仍有未终态 Relay 生成任务",
        );
      }
    }
  }
  if (input.videos.some((video) =>
    !TERMINAL_VIDEO_STATES.has(String(video.state || "")))) {
    fail(
      409,
      "PRODUCTION_DELETION_VIDEO_NOT_TERMINAL",
      "只能删除已完成、已失败或已取消的视频",
    );
  }
}

async function scrubEditorDraftVideoReferences(
  transaction: Knex.Transaction,
  projectId: number,
  videoIds: Set<number>,
): Promise<number> {
  if (!videoIds.size) return 0;
  let query = transaction("o_agentWorkData")
    .where({ projectId, key: EDITOR_DRAFT_KEY })
    .select("id", "data");
  query = maybeLock(transaction, query);
  const rows = await query;
  let removed = 0;
  const now = Date.now();
  for (const row of rows) {
    const draft = parseRecord(row.data);
    if (!draft) {
      fail(
        409,
        "PRODUCTION_DELETION_EDITOR_DRAFT_INVALID",
        "剪辑草稿数据异常，请先重新保存草稿后再删除视频",
      );
    }
    if (draft.timeline === undefined) continue;
    if (!Array.isArray(draft.timeline)) {
      fail(
        409,
        "PRODUCTION_DELETION_EDITOR_DRAFT_INVALID",
        "剪辑草稿时间线数据异常",
      );
    }
    const timeline = draft.timeline.filter((item) => {
      const record = parseRecord(item);
      const id = positiveId(record?.videoId);
      const shouldRemove = id !== null && videoIds.has(id);
      if (shouldRemove) removed += 1;
      return !shouldRemove;
    });
    if (timeline.length === draft.timeline.length) continue;
    await transaction("o_agentWorkData")
      .where({ id: row.id, projectId, key: EDITOR_DRAFT_KEY })
      .update({
        data: JSON.stringify({ ...draft, timeline, savedAt: now }),
        updateTime: now,
      });
  }
  return removed;
}

async function cleanupOrphanFlows(
  transaction: Knex.Transaction,
  flowIds: Set<number>,
): Promise<void> {
  for (const flowId of [...flowIds].sort((left, right) => left - right)) {
    let flowQuery = transaction("o_imageFlow").where({ id: flowId }).select("id");
    flowQuery = maybeLock(transaction, flowQuery);
    if (!await flowQuery.first()) continue;
    const [assetReference, storyboardReference] = await Promise.all([
      transaction("o_assets").where({ flowId }).select("id").first(),
      transaction("o_storyboard").where({ flowId }).select("id").first(),
    ]);
    if (!assetReference && !storyboardReference) {
      await transaction("o_imageFlow").where({ id: flowId }).delete();
    }
  }
}

async function reindexScriptStoryboards(
  transaction: Knex.Transaction,
  projectId: number,
  scriptIds: Set<number>,
): Promise<void> {
  for (const scriptId of [...scriptIds].sort((left, right) => left - right)) {
    const rows = await transaction("o_storyboard")
      .where({ projectId, scriptId })
      .orderBy("index", "asc")
      .orderBy("id", "asc")
      .select("id", "index");
    for (const [position, row] of rows.entries()) {
      const nextIndex = position + 1;
      if (Number(row.index) === nextIndex) continue;
      await transaction("o_storyboard")
        .where({ id: row.id, projectId, scriptId })
        .update({ index: nextIndex });
    }
  }
}

export async function deleteStoryboardsInTransaction(
  transaction: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    storyboardIds: number[];
  },
) {
  let storyboardQuery = transaction("o_storyboard")
    .where({ projectId: input.projectId })
    .whereIn("id", input.storyboardIds)
    .select("id", "scriptId", "trackId", "flowId");
  storyboardQuery = maybeLock(transaction, storyboardQuery);
  const storyboards = await storyboardQuery;
  if (storyboards.length !== input.storyboardIds.length) {
    fail(404, "PRODUCTION_DELETION_NOT_FOUND", "分镜不存在或不属于当前项目");
  }
  const storyboardIds = numberSet(storyboards.map((row) => row.id));
  const scriptIds = numberSet(storyboards.map((row) => row.scriptId));
  const trackIds = numberSet(storyboards.map((row) => row.trackId));
  if (storyboardIds.size !== storyboards.length || !scriptIds.size || !trackIds.size) {
    fail(409, "PRODUCTION_DELETION_AUTHORITY_CHAIN_INVALID", "分镜归属链不完整");
  }
  let trackQuery = transaction("o_videoTrack")
    .where({ projectId: input.projectId })
    .whereIn("id", [...trackIds])
    .select("id", "scriptId", "videoId", "selectVideoId");
  trackQuery = maybeLock(transaction, trackQuery);
  const tracks = await trackQuery;
  if (
    tracks.length !== trackIds.size
    || tracks.some((track) => !scriptIds.has(Number(track.scriptId)))
  ) {
    fail(409, "PRODUCTION_DELETION_AUTHORITY_CHAIN_INVALID", "分镜与生产轨道的归属链不完整");
  }

  await assertNoActiveTasks(transaction, {
    projectId: input.projectId,
    targets: { kind: "storyboard", storyboardIds, scriptIds, trackIds },
  });
  await assertNoActiveCommands(transaction, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    targets: { kind: "storyboard", storyboardIds, scriptIds, trackIds },
  });
  let videoQuery = transaction("o_video")
    .where({ projectId: input.projectId })
    .whereIn("videoTrackId", [...trackIds])
    .select("id");
  videoQuery = maybeLock(transaction, videoQuery);
  const videos = await videoQuery;
  if (
    videos.length
    || tracks.some((track) => positiveId(track.videoId) || positiveId(track.selectVideoId))
  ) {
    fail(
      409,
      "PRODUCTION_DELETION_TRACK_HAS_VIDEO",
      "分镜轨道仍有视频，请先删除该轨道的视频",
    );
  }

  const flowIds = numberSet(storyboards.map((row) => row.flowId));
  await transaction("o_assets2Storyboard")
    .whereIn("storyboardId", [...storyboardIds])
    .delete();
  const deleted = await transaction("o_storyboard")
    .where({ projectId: input.projectId })
    .whereIn("id", [...storyboardIds])
    .delete();
  if (Number(deleted) !== storyboardIds.size) {
    fail(409, "PRODUCTION_DELETION_CONFLICT", "分镜在删除期间发生了变化");
  }

  for (const track of tracks) {
    const trackId = Number(track.id);
    const scriptId = Number(track.scriptId);
    const remaining = await transaction("o_storyboard")
      .where({ projectId: input.projectId, scriptId, trackId })
      .orderBy("index", "asc")
      .orderBy("id", "asc")
      .select("prompt", "videoDesc", "duration");
    if (!remaining.length) {
      await transaction("o_videoTrack")
        .where({ id: trackId, projectId: input.projectId, scriptId })
        .delete();
      continue;
    }
    const prompt = remaining
      .map((item) => String(item.videoDesc || item.prompt || "").trim())
      .filter(Boolean)
      .join("\n");
    const duration = remaining.reduce((sum, item) =>
      sum + Number(item.duration || 0), 0);
    if (!prompt || !Number.isFinite(duration) || duration <= 0) {
      fail(409, "PRODUCTION_DELETION_TRACK_INVALID", "剩余分镜无法重建生产轨道");
    }
    await transaction("o_videoTrack")
      .where({ id: trackId, projectId: input.projectId, scriptId })
      .update({ prompt, duration });
  }
  await reindexScriptStoryboards(transaction, input.projectId, scriptIds);
  await cleanupOrphanFlows(transaction, flowIds);
  return {
    deletedStoryboardIds: [...storyboardIds].sort((left, right) => left - right),
  };
}

export async function deleteTerminalVideoInTransaction(
  transaction: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    videoId: number;
  },
) {
  let videoQuery = transaction("o_video")
    .where({ id: input.videoId, projectId: input.projectId })
    .select("id", "scriptId", "videoTrackId", "relayTaskId", "state");
  videoQuery = maybeLock(transaction, videoQuery);
  const video = await videoQuery.first();
  if (!video) {
    fail(404, "PRODUCTION_DELETION_NOT_FOUND", "视频不存在或不属于当前项目");
  }
  const scriptId = positiveId(video.scriptId);
  const trackId = positiveId(video.videoTrackId);
  if (!scriptId || !trackId) {
    fail(409, "PRODUCTION_DELETION_AUTHORITY_CHAIN_INVALID", "视频归属链不完整");
  }
  let trackQuery = transaction("o_videoTrack")
    .where({ id: trackId, projectId: input.projectId, scriptId })
    .select("id", "videoId", "selectVideoId");
  trackQuery = maybeLock(transaction, trackQuery);
  const track = await trackQuery.first();
  if (!track) {
    fail(409, "PRODUCTION_DELETION_AUTHORITY_CHAIN_INVALID", "视频与生产轨道的归属链不完整");
  }
  let siblingQuery = transaction("o_video")
    .where({
      projectId: input.projectId,
      scriptId,
      videoTrackId: trackId,
    })
    .whereNot({ id: input.videoId })
    .select("id", "scriptId", "videoTrackId", "relayTaskId", "state");
  siblingQuery = maybeLock(transaction, siblingQuery);
  const siblings = await siblingQuery;
  const trackVideoIds = numberSet([
    input.videoId,
    ...siblings.map((sibling) => sibling.id),
  ]);
  const targets: DeletionTargets = {
    kind: "video",
    scriptIds: new Set([scriptId]),
    trackIds: new Set([trackId]),
    // A video projection cannot be deleted independently from active work on
    // another projection of the same production track. Include every sibling
    // ID so tasks/checkpoints that recorded only a videoId still serialize
    // with this track mutation.
    videoIds: trackVideoIds,
  };
  await assertNoActiveTasks(transaction, { projectId: input.projectId, targets });
  await assertNoActiveCommands(transaction, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    targets,
  });
  if (siblings.some((sibling) =>
    !TERMINAL_VIDEO_STATES.has(String(sibling.state || "")))) {
    fail(
      409,
      "PRODUCTION_DELETION_TRACK_HAS_ACTIVE_VIDEO",
      "同一轨道仍有未终态视频，请等待生成结束后再删除",
    );
  }
  await assertVideosTerminal(transaction, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    videos: [video, ...siblings],
  });
  const draftReferencesRemoved = await scrubEditorDraftVideoReferences(
    transaction,
    input.projectId,
    new Set([input.videoId]),
  );
  const trackPatch: Record<string, unknown> = {};
  if (Number(track.videoId) === input.videoId) trackPatch.videoId = null;
  if (Number(track.selectVideoId) === input.videoId) trackPatch.selectVideoId = null;
  if (Object.keys(trackPatch).length) {
    await transaction("o_videoTrack")
      .where({ id: trackId, projectId: input.projectId, scriptId })
      .update(trackPatch);
  }
  const deleted = await transaction("o_video")
    .where({ id: input.videoId, projectId: input.projectId, scriptId, videoTrackId: trackId })
    .delete();
  if (Number(deleted) !== 1) {
    fail(409, "PRODUCTION_DELETION_CONFLICT", "视频在删除期间发生了变化");
  }
  return { deletedVideoId: input.videoId, draftReferencesRemoved };
}

export async function deleteScriptsInTransaction(
  transaction: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    scriptIds: number[];
  },
) {
  let scriptQuery = transaction("o_script")
    .where({ projectId: input.projectId })
    .whereIn("id", input.scriptIds)
    .select("id");
  scriptQuery = maybeLock(transaction, scriptQuery);
  const scripts = await scriptQuery;
  if (scripts.length !== input.scriptIds.length) {
    fail(404, "PRODUCTION_DELETION_NOT_FOUND", "剧本不存在或不属于当前项目");
  }
  const scriptIds = numberSet(scripts.map((row) => row.id));
  let storyboardQuery = transaction("o_storyboard")
    .where({ projectId: input.projectId })
    .whereIn("scriptId", [...scriptIds])
    .select("id", "scriptId", "trackId", "flowId");
  storyboardQuery = maybeLock(transaction, storyboardQuery);
  const storyboards = await storyboardQuery;
  const storyboardIds = numberSet(storyboards.map((row) => row.id));
  let trackQuery = transaction("o_videoTrack")
    .where({ projectId: input.projectId })
    .whereIn("scriptId", [...scriptIds])
    .select("id", "scriptId");
  trackQuery = maybeLock(transaction, trackQuery);
  const tracks = await trackQuery;
  const trackIds = numberSet(tracks.map((row) => row.id));
  if (
    storyboards.some((row) => !trackIds.has(Number(row.trackId)))
    || tracks.some((row) => !scriptIds.has(Number(row.scriptId)))
  ) {
    fail(409, "PRODUCTION_DELETION_AUTHORITY_CHAIN_INVALID", "剧本生产结构的归属链不完整");
  }
  let videoQuery = transaction("o_video")
    .where({ projectId: input.projectId })
    .andWhere((builder) => {
      builder.whereIn("scriptId", [...scriptIds]);
      if (trackIds.size) builder.orWhereIn("videoTrackId", [...trackIds]);
    })
    .select("id", "scriptId", "videoTrackId", "relayTaskId", "state");
  videoQuery = maybeLock(transaction, videoQuery);
  const videos = await videoQuery;
  if (videos.some((video) =>
    !scriptIds.has(Number(video.scriptId))
    || !trackIds.has(Number(video.videoTrackId)))) {
    fail(409, "PRODUCTION_DELETION_AUTHORITY_CHAIN_INVALID", "剧本视频结构的归属链不完整");
  }
  const videoIds = numberSet(videos.map((row) => row.id));
  const targets: DeletionTargets = {
    kind: "script",
    scriptIds,
    storyboardIds,
    trackIds,
    videoIds,
  };
  await assertNoActiveTasks(transaction, { projectId: input.projectId, targets });
  await assertNoActiveCommands(transaction, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    targets,
  });
  await assertVideosTerminal(transaction, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    videos,
  });
  const draftReferencesRemoved = await scrubEditorDraftVideoReferences(
    transaction,
    input.projectId,
    videoIds,
  );
  const flowIds = numberSet(storyboards.map((row) => row.flowId));

  if (storyboardIds.size) {
    await transaction("o_assets2Storyboard")
      .whereIn("storyboardId", [...storyboardIds])
      .delete();
  }
  await transaction("o_scriptAssets").whereIn("scriptId", [...scriptIds]).delete();
  await transaction("o_assets")
    .where({ projectId: input.projectId })
    .whereIn("scriptId", [...scriptIds])
    .update({ scriptId: null });
  await transaction("o_agentWorkData")
    .where({ projectId: input.projectId })
    .whereIn("episodesId", [...scriptIds])
    .delete();
  await transaction("o_workflow_graph")
    .where({ projectId: input.projectId })
    .whereIn("episodesId", [...scriptIds])
    .delete();
  if (storyboardIds.size) {
    await transaction("o_storyboard")
      .where({ projectId: input.projectId })
      .whereIn("id", [...storyboardIds])
      .delete();
  }
  if (videoIds.size) {
    await transaction("o_video")
      .where({ projectId: input.projectId })
      .whereIn("id", [...videoIds])
      .delete();
  }
  if (trackIds.size) {
    await transaction("o_videoTrack")
      .where({ projectId: input.projectId })
      .whereIn("id", [...trackIds])
      .delete();
  }
  const deleted = await transaction("o_script")
    .where({ projectId: input.projectId })
    .whereIn("id", [...scriptIds])
    .delete();
  if (Number(deleted) !== scriptIds.size) {
    fail(409, "PRODUCTION_DELETION_CONFLICT", "剧本在删除期间发生了变化");
  }
  await cleanupOrphanFlows(transaction, flowIds);
  return {
    deletedScriptIds: [...scriptIds].sort((left, right) => left - right),
    draftReferencesRemoved,
  };
}
