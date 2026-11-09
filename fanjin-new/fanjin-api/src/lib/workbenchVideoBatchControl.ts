import {
  completeDurableCommand,
  mutateDurableCommandCheckpoint,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import {
  cancelOrDeleteRelayTask,
  getRelayTask,
  type RelayTask,
} from "@/lib/relay";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import {
  parseQuickCreateVideoCheckpoint,
  parseQuickCreateVideoTaskResults,
  quickCreateVideoResultPhase,
  replaceQuickCreateVideoCheckpointTrack,
  QUICK_CREATE_VIDEO_BATCH_MAX_CONCURRENCY,
  QUICK_CREATE_VIDEO_BATCH_SCOPE,
  type QuickCreateVideoBatchPhase,
  type QuickCreateVideoCommandCheckpoint,
  type QuickCreateVideoTaskResult,
} from "@/lib/workbenchVideoBatchContract";
import { db } from "@/utils/db";

export type PublicQuickCreateVideoBatchState =
  | QuickCreateVideoBatchPhase
  | "cancellation_pending";

export type PublicQuickCreateVideoBatchItem = {
  trackId: number;
  videoId?: number;
  relayTaskId?: string;
  state: PublicQuickCreateVideoBatchState;
  queuePosition: number | null;
  cancelRequested: boolean;
  cancellable: boolean;
  errorCode?: string;
  errorReason?: string;
  billing?: { requiredGu: number; availableGu: number };
  updatedAt: number;
};

export type PublicQuickCreateVideoBatch = {
  version: "quick-create-video-batch.v1";
  projectId: number;
  total: number;
  concurrencyLimit: number;
  terminal: boolean;
  partialFailure: boolean;
  counts: Record<PublicQuickCreateVideoBatchState, number>;
  items: PublicQuickCreateVideoBatchItem[];
};

export type QuickCreateVideoBatchCancelItem = {
  trackId: number;
  cancelled: boolean;
  accepted: boolean;
  state: PublicQuickCreateVideoBatchState | "not_found";
  code:
    | "video_batch_item_cancelled"
    | "video_batch_item_cancellation_pending"
    | "video_batch_item_terminal"
    | "video_batch_item_not_found";
  message: string;
};

export class QuickCreateVideoBatchControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuickCreateVideoBatchControlError";
  }
}

type CommandRow = {
  id: string;
  status: "checkpointed" | "completed";
  responseBody: string;
  updatedAt: number;
};

type BatchAuthority = {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  idempotencyKey: string;
};

type MutableBatch = {
  reservation: Extract<DurableCommandReservation<QuickCreateVideoTaskResult[]>, { kind: "resume" }>;
  checkpoint: QuickCreateVideoCommandCheckpoint;
};

function validAuthority(input: BatchAuthority): BatchAuthority {
  const authority = {
    workspaceId: String(input.workspaceId || "").trim(),
    actorUserId: Number(input.actorUserId),
    projectId: Number(input.projectId),
    idempotencyKey: String(input.idempotencyKey || "").trim(),
  };
  if (
    !authority.workspaceId
    || !Number.isSafeInteger(authority.actorUserId)
    || authority.actorUserId < 1
    || !Number.isSafeInteger(authority.projectId)
    || authority.projectId < 1
    || !authority.idempotencyKey
    || authority.idempotencyKey.length > 200
  ) {
    throw new QuickCreateVideoBatchControlError(
      400,
      "video_batch_request_invalid",
      "视频生成批次请求缺少有效项目或幂等键",
    );
  }
  return authority;
}

async function loadCommand(input: BatchAuthority): Promise<CommandRow> {
  const authority = validAuthority(input);
  const row = await db("o_agent_idempotency")
    .where({
      workspaceId: authority.workspaceId,
      actorUserId: authority.actorUserId,
      scopeKey: `${QUICK_CREATE_VIDEO_BATCH_SCOPE}:${authority.workspaceId}:${authority.actorUserId}`,
      idempotencyKey: authority.idempotencyKey,
      resourceType: "project",
      resourceId: String(authority.projectId),
    })
    .select("id", "status", "responseBody", "updatedAt")
    .first();
  if (!row) {
    // Deliberately use the same not-found result for another workspace,
    // another actor, another project, and an unknown key.
    throw new QuickCreateVideoBatchControlError(
      404,
      "video_batch_not_found",
      "视频生成批次不存在",
    );
  }
  const status = String(row.status || "");
  if (status !== "checkpointed" && status !== "completed") {
    throw new QuickCreateVideoBatchControlError(
      409,
      "video_batch_not_checkpointed",
      "视频生成批次尚未建立可恢复检查点",
    );
  }
  return {
    id: String(row.id),
    status,
    responseBody: String(row.responseBody || ""),
    updatedAt: Number(row.updatedAt || 0),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new QuickCreateVideoBatchControlError(
      500,
      "video_batch_record_invalid",
      "视频生成批次记录无效",
    );
  }
}

function checkpointFromRow(
  row: CommandRow,
  authority: BatchAuthority,
): MutableBatch | null {
  if (row.status !== "checkpointed") return null;
  const raw = parseJson(row.responseBody) as Record<string, unknown>;
  const checkpoint = parseQuickCreateVideoCheckpoint(raw, {
    workspaceId: authority.workspaceId,
    actorUserId: authority.actorUserId,
    projectId: authority.projectId,
    scriptId: Number(raw?.scriptId),
  });
  return {
    reservation: { kind: "resume", id: row.id, checkpoint },
    checkpoint,
  };
}

function resultsFromRow(row: CommandRow): QuickCreateVideoTaskResult[] {
  if (row.status !== "completed") return [];
  return parseQuickCreateVideoTaskResults(parseJson(row.responseBody));
}

function relayState(task: RelayTask | undefined): PublicQuickCreateVideoBatchState | null {
  const status = String(task?.status || "").trim().toLowerCase();
  if (status === "pending_reconcile") return "pending_reconcile";
  if (status === "cancelled") return "cancelled";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "queued") return "queued";
  if (["running", "submitted", "processing"].includes(status)) return "submitted";
  return null;
}

function terminalState(state: PublicQuickCreateVideoBatchState): boolean {
  return ["succeeded", "failed", "cancelled"].includes(state);
}

async function readRelayTasks(
  workspaceId: string,
  projectId: number,
  relayTaskIds: string[],
): Promise<Map<string, RelayTask>> {
  if (!relayTaskIds.length) return new Map();
  const rows = await db("o_relay_task")
    .where({ workspaceId, projectId, endpointType: "video_generation" })
    .whereIn("id", [...new Set(relayTaskIds)]);
  return new Map(rows.map((row: any) => [
    String(row.id),
    {
      ...row,
      requestPayload: typeof row.requestPayload === "string"
        ? parseJson(row.requestPayload)
        : row.requestPayload,
      providerPayload: typeof row.providerPayload === "string"
        ? parseJson(row.providerPayload)
        : row.providerPayload,
      resultPayload: typeof row.resultPayload === "string"
        ? parseJson(row.resultPayload)
        : row.resultPayload,
    } as RelayTask,
  ]));
}

function projectItem(input: {
  result: QuickCreateVideoTaskResult | null;
  phase: QuickCreateVideoBatchPhase;
  cancelRequested: boolean;
  updatedAt: number;
  trackId: number;
  videoId: number | null;
  relayTaskId: string | null;
  relayTask?: RelayTask;
}): PublicQuickCreateVideoBatchItem {
  const liveRelayState = relayState(input.relayTask);
  let state: PublicQuickCreateVideoBatchState = liveRelayState
    || (input.result ? quickCreateVideoResultPhase(input.result) : input.phase);
  if (
    input.cancelRequested
    && !terminalState(state)
    && state !== "pending_reconcile"
  ) state = "cancellation_pending";
  const errorReason = redactSensitiveText(String(input.result?.errorReason || "").trim());
  return {
    trackId: input.trackId,
    ...(input.videoId ? { videoId: input.videoId } : {}),
    ...(input.relayTaskId ? { relayTaskId: input.relayTaskId } : {}),
    state,
    queuePosition: null,
    cancelRequested: input.cancelRequested,
    cancellable: !terminalState(state),
    ...(input.result?.errorCode ? { errorCode: input.result.errorCode } : {}),
    ...(errorReason ? { errorReason } : {}),
    ...(input.result?.billing ? { billing: input.result.billing } : {}),
    updatedAt: input.updatedAt,
  };
}

function emptyCounts(): Record<PublicQuickCreateVideoBatchState, number> {
  return {
    queued: 0,
    preparing: 0,
    dispatching: 0,
    submitted: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    pending_reconcile: 0,
    cancellation_pending: 0,
  };
}

export async function readQuickCreateVideoBatch(
  rawAuthority: BatchAuthority,
): Promise<PublicQuickCreateVideoBatch> {
  const authority = validAuthority(rawAuthority);
  const row = await loadCommand(authority);
  const mutable = checkpointFromRow(row, authority);
  const results = mutable ? [] : resultsFromRow(row);
  const source = mutable
    ? mutable.checkpoint.tracks.map((track) => ({
        result: track.result,
        phase: track.phase,
        cancelRequested: track.cancelRequested,
        updatedAt: track.updatedAt || row.updatedAt,
        trackId: track.trackId,
        videoId: track.videoId,
        relayTaskId: track.relayTaskId,
      }))
    : results.map((result) => ({
        result,
        phase: quickCreateVideoResultPhase(result),
        cancelRequested: quickCreateVideoResultPhase(result) === "cancelled",
        updatedAt: row.updatedAt,
        trackId: result.trackId,
        videoId: result.videoId || null,
        relayTaskId: result.relayTaskId || null,
      }));
  const relayTasks = await readRelayTasks(
    authority.workspaceId,
    authority.projectId,
    source.flatMap((item) => item.relayTaskId ? [item.relayTaskId] : []),
  );
  const items = source.map((item) => projectItem({
    ...item,
    relayTask: item.relayTaskId
      ? relayTasks.get(item.relayTaskId)
      : undefined,
  }));
  let queuePosition = 0;
  for (const item of items) {
    if (item.state !== "queued") continue;
    queuePosition += 1;
    item.queuePosition = queuePosition;
  }
  const counts = emptyCounts();
  for (const item of items) counts[item.state] += 1;
  const terminal = items.every((item) => terminalState(item.state));
  const successful = counts.succeeded;
  const unsuccessful = counts.failed + counts.cancelled + counts.pending_reconcile;
  return {
    version: "quick-create-video-batch.v1",
    projectId: authority.projectId,
    total: items.length,
    concurrencyLimit: QUICK_CREATE_VIDEO_BATCH_MAX_CONCURRENCY,
    terminal,
    partialFailure: successful > 0 && unsuccessful > 0,
    counts,
    items,
  };
}

function cancellationResult(input: {
  trackId: number;
  videoId: number | null;
  relayTaskId: string | null;
  beforeDispatch: boolean;
}): QuickCreateVideoTaskResult {
  return {
    ...(input.videoId ? { videoId: input.videoId } : {}),
    trackId: input.trackId,
    ...(input.relayTaskId ? { relayTaskId: input.relayTaskId } : {}),
    status: "cancelled",
    state: "已取消",
    errorCode: "video_batch_item_cancelled",
    errorReason: input.beforeDispatch
      ? "任务已在上游派发前取消"
      : "视频生成任务已取消",
  };
}

async function requestCheckpointCancellation(input: {
  authority: BatchAuthority;
  mutable: MutableBatch;
  trackIds: Set<number>;
}): Promise<MutableBatch | QuickCreateVideoTaskResult[]> {
  const advanced = await mutateDurableCommandCheckpoint<
    QuickCreateVideoTaskResult[],
    QuickCreateVideoCommandCheckpoint
  >(input.mutable.reservation, async (raw, transaction) => {
    let checkpoint = parseQuickCreateVideoCheckpoint(raw, {
      workspaceId: input.authority.workspaceId,
      actorUserId: input.authority.actorUserId,
      projectId: input.authority.projectId,
      scriptId: input.mutable.checkpoint.scriptId,
    });
    for (const track of checkpoint.tracks) {
      if (!input.trackIds.has(track.trackId) || track.result) continue;
      const canCancelLocally = (
        !track.relayTaskId
        && track.phase !== "dispatching"
        && track.phase !== "pending_reconcile"
      );
      if (canCancelLocally) {
        const result = cancellationResult({
          trackId: track.trackId,
          videoId: track.videoId,
          relayTaskId: null,
          beforeDispatch: true,
        });
        if (track.videoId) {
          await transaction("o_video")
            .where({
              id: track.videoId,
              projectId: input.authority.projectId,
              scriptId: checkpoint.scriptId,
              videoTrackId: track.trackId,
            })
            .update({ state: "已取消", errorReason: result.errorReason });
        }
        checkpoint = replaceQuickCreateVideoCheckpointTrack(
          checkpoint,
          track.trackId,
          (item) => ({
            ...item,
            cancelRequested: true,
            phase: "cancelled",
            result,
            updatedAt: Date.now(),
          }),
        );
      } else {
        checkpoint = replaceQuickCreateVideoCheckpointTrack(
          checkpoint,
          track.trackId,
          (item) => ({
            ...item,
            cancelRequested: true,
            updatedAt: Date.now(),
          }),
        );
      }
    }
    return checkpoint;
  });
  if (advanced.kind === "replay") return advanced.responseBody;
  return {
    reservation: {
      kind: "resume",
      id: advanced.id,
      checkpoint: advanced.checkpoint,
    },
    checkpoint: advanced.checkpoint,
  };
}

async function cancelRelayForTrack(input: {
  authority: BatchAuthority;
  relayTaskId: string;
}): Promise<{ cancelled: boolean; terminal: boolean }> {
  const task = await getRelayTask(input.relayTaskId);
  if (
    !task
    || String(task.workspaceId || "") !== input.authority.workspaceId
    || Number(task.projectId) !== input.authority.projectId
    || String(task.endpointType || "") !== "video_generation"
  ) {
    return { cancelled: false, terminal: false };
  }
  if (task.status === "cancelled") return { cancelled: true, terminal: true };
  if (["succeeded", "failed"].includes(task.status)) {
    return { cancelled: false, terminal: true };
  }
  const result = await cancelOrDeleteRelayTask(task.id, { internal: true });
  return {
    cancelled: Boolean(result.cancelled && result.task),
    terminal: Boolean(result.task && ["succeeded", "failed", "cancelled"].includes(result.task.status)),
  };
}

async function persistRelayCancellations(input: {
  authority: BatchAuthority;
  mutable: MutableBatch;
  cancelledRelayIds: Set<string>;
}): Promise<MutableBatch | QuickCreateVideoTaskResult[]> {
  if (!input.cancelledRelayIds.size) return input.mutable;
  const advanced = await mutateDurableCommandCheckpoint<
    QuickCreateVideoTaskResult[],
    QuickCreateVideoCommandCheckpoint
  >(input.mutable.reservation, async (raw, transaction) => {
    let checkpoint = parseQuickCreateVideoCheckpoint(raw, {
      workspaceId: input.authority.workspaceId,
      actorUserId: input.authority.actorUserId,
      projectId: input.authority.projectId,
      scriptId: input.mutable.checkpoint.scriptId,
    });
    for (const track of checkpoint.tracks) {
      if (
        track.result
        || !track.relayTaskId
        || !input.cancelledRelayIds.has(track.relayTaskId)
      ) continue;
      const result = cancellationResult({
        trackId: track.trackId,
        videoId: track.videoId,
        relayTaskId: track.relayTaskId,
        beforeDispatch: false,
      });
      if (track.videoId) {
        await transaction("o_video")
          .where({
            id: track.videoId,
            projectId: input.authority.projectId,
            scriptId: checkpoint.scriptId,
            videoTrackId: track.trackId,
            relayTaskId: track.relayTaskId,
          })
          .update({ state: "已取消", errorReason: result.errorReason });
      }
      checkpoint = replaceQuickCreateVideoCheckpointTrack(
        checkpoint,
        track.trackId,
        (item) => ({
          ...item,
          cancelRequested: true,
          phase: "cancelled",
          result,
          updatedAt: Date.now(),
        }),
      );
    }
    return checkpoint;
  });
  if (advanced.kind === "replay") return advanced.responseBody;
  return {
    reservation: {
      kind: "resume",
      id: advanced.id,
      checkpoint: advanced.checkpoint,
    },
    checkpoint: advanced.checkpoint,
  };
}

export async function cancelQuickCreateVideoBatch(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  idempotencyKey: string;
  trackIds?: number[];
}): Promise<{
  partial: boolean;
  items: QuickCreateVideoBatchCancelItem[];
  batch: PublicQuickCreateVideoBatch;
}> {
  const authority = validAuthority(input);
  const row = await loadCommand(authority);
  let mutable = checkpointFromRow(row, authority);
  let completedResults = mutable ? [] : resultsFromRow(row);
  const knownTrackIds = new Set(
    mutable
      ? mutable.checkpoint.tracks.map((track) => track.trackId)
      : completedResults.map((result) => result.trackId),
  );
  const requestedIds = input.trackIds?.length
    ? [...new Set(input.trackIds)]
    : [...knownTrackIds];
  const selectedKnown = new Set(requestedIds.filter((id) => knownTrackIds.has(id)));

  if (mutable && selectedKnown.size) {
    const requested = await requestCheckpointCancellation({
      authority,
      mutable,
      trackIds: selectedKnown,
    });
    if (Array.isArray(requested)) {
      mutable = null;
      completedResults = requested;
    } else {
      mutable = requested;
    }
  }

  const relayTargets = (mutable
    ? mutable.checkpoint.tracks.map((track) => ({
        trackId: track.trackId,
        relayTaskId: track.relayTaskId,
      }))
    : completedResults.map((result) => ({
        trackId: result.trackId,
        relayTaskId: result.relayTaskId || null,
      })))
    .filter((item) => selectedKnown.has(item.trackId) && item.relayTaskId);
  const cancelledRelayIds = new Set<string>();
  for (const target of relayTargets) {
    const result = await cancelRelayForTrack({
      authority,
      relayTaskId: String(target.relayTaskId),
    });
    if (result.cancelled) cancelledRelayIds.add(String(target.relayTaskId));
  }

  if (mutable && cancelledRelayIds.size) {
    const persisted = await persistRelayCancellations({
      authority,
      mutable,
      cancelledRelayIds,
    });
    if (Array.isArray(persisted)) {
      mutable = null;
      completedResults = persisted;
    } else {
      mutable = persisted;
    }
  }
  if (mutable && mutable.checkpoint.tracks.every((track) => track.result)) {
    const response = mutable.checkpoint.tracks.map((track) => track.result!);
    await completeDurableCommand(mutable.reservation, response);
    mutable = null;
    completedResults = response;
  }

  const batch = await readQuickCreateVideoBatch(authority);
  const byTrackId = new Map(batch.items.map((item) => [item.trackId, item]));
  const items = requestedIds.map((trackId): QuickCreateVideoBatchCancelItem => {
    const item = byTrackId.get(trackId);
    if (!item) {
      return {
        trackId,
        cancelled: false,
        accepted: false,
        state: "not_found",
        code: "video_batch_item_not_found",
        message: "镜头不属于该视频生成批次",
      };
    }
    if (item.state === "cancelled") {
      return {
        trackId,
        cancelled: true,
        accepted: true,
        state: item.state,
        code: "video_batch_item_cancelled",
        message: "视频生成任务已取消",
      };
    }
    if (terminalState(item.state)) {
      return {
        trackId,
        cancelled: false,
        accepted: false,
        state: item.state,
        code: "video_batch_item_terminal",
        message: "视频生成任务已终态，不能取消",
      };
    }
    return {
      trackId,
      cancelled: false,
      accepted: true,
      state: item.state,
      code: "video_batch_item_cancellation_pending",
      message: item.state === "pending_reconcile"
        ? "上游状态待核对，不会重复提交"
        : "取消请求已记录，正在逐项处理",
    };
  });
  return {
    partial: items.some((item) => item.cancelled)
      && items.some((item) => !item.cancelled),
    items,
    batch,
  };
}
