import { z } from "zod";

import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import {
  parseStructuredTimelineSubmissionBinding,
  structuredTimelineSubmissionBindingSchema,
  type StructuredTimelineSubmissionBinding,
} from "@/lib/structuredThirtySecondTimeline";

export const QUICK_CREATE_VIDEO_BATCH_SCOPE = "workbench:create:videos";
export const QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS = 10;
export const QUICK_CREATE_VIDEO_BATCH_MAX_CONCURRENCY = 5;

export const QUICK_CREATE_VIDEO_BATCH_PHASES = [
  "queued",
  "preparing",
  "dispatching",
  "submitted",
  "succeeded",
  "failed",
  "cancelled",
  "pending_reconcile",
] as const;

export type QuickCreateVideoBatchPhase =
  (typeof QUICK_CREATE_VIDEO_BATCH_PHASES)[number];

export type QuickCreateVideoTaskResult = {
  videoId?: number;
  trackId: number;
  relayTaskId?: string;
  status?: string;
  preparationStage?: "portrait_registration" | null;
  statusMessage?: string | null;
  state?: string;
  errorCode?: string;
  errorReason?: string;
  billing?: {
    requiredGu: number;
    availableGu: number;
  };
};

export type QuickCreateVideoTrackCheckpoint = {
  trackId: number;
  videoId: number | null;
  relayTaskId: string | null;
  result: QuickCreateVideoTaskResult | null;
  phase: QuickCreateVideoBatchPhase;
  cancelRequested: boolean;
  updatedAt: number;
};

export type QuickCreateVideoCommandCheckpoint = {
  version: "quick-create-video-command.v1";
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  scriptId: number;
  structuredTimelineBinding: StructuredTimelineSubmissionBinding | null;
  tracks: QuickCreateVideoTrackCheckpoint[];
};

const safeBillingSchema = z.object({
  requiredGu: z.number().finite().nonnegative(),
  availableGu: z.number().finite().nonnegative(),
}).strict();

const taskResultSchema = z.object({
  videoId: z.number().int().positive().optional(),
  trackId: z.number().int().positive(),
  relayTaskId: z.string().trim().min(1).max(200).optional(),
  status: z.string().trim().min(1).max(80).optional(),
  preparationStage: z.literal("portrait_registration").nullable().optional(),
  statusMessage: z.string().trim().min(1).max(1_000).nullable().optional(),
  state: z.string().trim().min(1).max(80).optional(),
  errorCode: z.string().trim().min(1).max(120).optional(),
  errorReason: z.string().trim().min(1).max(1_000).optional(),
  billing: safeBillingSchema.optional(),
}).strict();

const persistedTrackSchema = z.object({
  trackId: z.number().int().positive(),
  videoId: z.number().int().positive().nullable(),
  relayTaskId: z.string().trim().min(1).max(200).nullable(),
  result: taskResultSchema.nullable(),
  // 0.0.8 checkpoints did not persist lifecycle fields. They remain readable
  // and are normalized below so a 0.0.9 rollout can resume them safely.
  phase: z.enum(QUICK_CREATE_VIDEO_BATCH_PHASES).optional(),
  cancelRequested: z.boolean().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
}).strict();

const persistedCheckpointSchema = z.object({
  version: z.literal("quick-create-video-command.v1"),
  workspaceId: z.string().trim().min(1).max(200),
  actorUserId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  scriptId: z.number().int().positive(),
  // Optional preserves read compatibility with 0.0.8 checkpoints. A 0.0.9
  // request carrying a timeline still requires an exact binding match below.
  structuredTimelineBinding: structuredTimelineSubmissionBindingSchema
    .nullable()
    .optional(),
  tracks: z.array(persistedTrackSchema)
    .min(1)
    .max(QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS),
}).strict();

function invalidCheckpoint(message: string): DurableCommandIdempotencyError {
  return new DurableCommandIdempotencyError(
    500,
    "idempotency_checkpoint_invalid",
    message,
  );
}

export function quickCreateVideoResultPhase(
  result: QuickCreateVideoTaskResult,
): QuickCreateVideoBatchPhase {
  const status = String(result.status || "").trim().toLowerCase();
  if (status === "pending_reconcile") return "pending_reconcile";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "succeeded" || result.state === "生成成功") return "succeeded";
  if (
    status === "failed"
    || result.state === "生成失败"
    || Boolean(result.errorCode)
    || Boolean(result.errorReason)
  ) return "failed";
  return "submitted";
}

function normalizeTrack(
  track: z.infer<typeof persistedTrackSchema>,
): QuickCreateVideoTrackCheckpoint {
  const phase = track.phase
    || (track.result
      ? quickCreateVideoResultPhase(track.result)
      : track.relayTaskId
        ? "submitted"
        : track.videoId
          ? "preparing"
          : "queued");
  return {
    ...track,
    phase,
    cancelRequested: track.cancelRequested
      ?? phase === "cancelled",
    updatedAt: track.updatedAt ?? 0,
  };
}

export function parseQuickCreateVideoTaskResults(
  value: unknown,
): QuickCreateVideoTaskResult[] {
  const parsed = z.array(taskResultSchema)
    .min(1)
    .max(QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS)
    .safeParse(value);
  if (!parsed.success) {
    throw invalidCheckpoint("视频生成批次的已完成响应无效");
  }
  const trackIds = parsed.data.map((item) => item.trackId);
  if (new Set(trackIds).size !== trackIds.length) {
    throw invalidCheckpoint("视频生成批次的已完成响应包含重复镜头");
  }
  return parsed.data;
}

function assertCheckpointIntegrity(
  checkpoint: QuickCreateVideoCommandCheckpoint,
): void {
  const trackIds = checkpoint.tracks.map((track) => track.trackId);
  if (new Set(trackIds).size !== trackIds.length) {
    throw invalidCheckpoint("视频生成恢复检查点包含重复镜头");
  }
  for (const track of checkpoint.tracks) {
    if (track.result) {
      if (track.result.trackId !== track.trackId) {
        throw invalidCheckpoint("视频生成结果与镜头检查点不一致");
      }
      if (
        track.result.videoId !== undefined
        && track.result.videoId !== track.videoId
      ) {
        throw invalidCheckpoint("视频生成结果与本地任务检查点不一致");
      }
      if (
        track.result.relayTaskId !== undefined
        && track.result.relayTaskId !== track.relayTaskId
      ) {
        throw invalidCheckpoint("视频生成结果与 Relay 检查点不一致");
      }
      if (
        track.result.videoId === undefined
        && quickCreateVideoResultPhase(track.result) !== "cancelled"
        && track.phase !== "failed"
      ) {
        throw invalidCheckpoint("非取消的视频生成结果缺少本地任务");
      }
    }
    // An upstream adapter may return an immediate terminal `cancelled`
    // outcome even when the user did not request cancellation. The separate
    // cancelRequested flag records user intent and must not be inferred from
    // every provider-owned terminal state.
  }
}

export function createQuickCreateVideoCheckpoint(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  scriptId: number;
  trackIds: number[];
  structuredTimelineBinding?: StructuredTimelineSubmissionBinding | null;
  now?: number;
}): QuickCreateVideoCommandCheckpoint {
  const now = input.now ?? Date.now();
  const checkpoint: QuickCreateVideoCommandCheckpoint = {
    version: "quick-create-video-command.v1",
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    scriptId: input.scriptId,
    structuredTimelineBinding: input.structuredTimelineBinding
      ? parseStructuredTimelineSubmissionBinding(input.structuredTimelineBinding)
      : null,
    tracks: input.trackIds.map((trackId) => ({
      trackId,
      videoId: null,
      relayTaskId: null,
      result: null,
      phase: "queued",
      cancelRequested: false,
      updatedAt: now,
    })),
  };
  assertCheckpointIntegrity(checkpoint);
  return checkpoint;
}

export function parseQuickCreateVideoCheckpoint(
  value: unknown,
  expected: {
    workspaceId: string;
    actorUserId: number;
    projectId: number;
    scriptId: number;
    trackIds?: number[];
    structuredTimelineBinding?: StructuredTimelineSubmissionBinding | null;
  },
): QuickCreateVideoCommandCheckpoint {
  const parsed = persistedCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidCheckpoint("视频生成恢复检查点格式无效");
  }
  const checkpoint: QuickCreateVideoCommandCheckpoint = {
    ...parsed.data,
    structuredTimelineBinding: parsed.data.structuredTimelineBinding
      ? parseStructuredTimelineSubmissionBinding(parsed.data.structuredTimelineBinding)
      : null,
    tracks: parsed.data.tracks.map(normalizeTrack),
  };
  if (
    checkpoint.workspaceId !== expected.workspaceId
    || checkpoint.actorUserId !== expected.actorUserId
    || checkpoint.projectId !== expected.projectId
    || checkpoint.scriptId !== expected.scriptId
    || (
      expected.trackIds
      && (
        checkpoint.tracks.length !== expected.trackIds.length
        || checkpoint.tracks.some(
          (track, index) => track.trackId !== expected.trackIds?.[index],
        )
      )
    )
  ) {
    throw invalidCheckpoint("视频生成恢复检查点与当前工作区或项目不一致");
  }
  if (
    Object.prototype.hasOwnProperty.call(expected, "structuredTimelineBinding")
    && JSON.stringify(checkpoint.structuredTimelineBinding)
      !== JSON.stringify(expected.structuredTimelineBinding ?? null)
  ) {
    throw invalidCheckpoint("视频生成恢复检查点与当前 30 秒时间线不一致");
  }
  assertCheckpointIntegrity(checkpoint);
  return checkpoint;
}

export function replaceQuickCreateVideoCheckpointTrack(
  checkpoint: QuickCreateVideoCommandCheckpoint,
  trackId: number,
  update: (
    track: QuickCreateVideoTrackCheckpoint,
  ) => QuickCreateVideoTrackCheckpoint,
): QuickCreateVideoCommandCheckpoint {
  let found = false;
  const tracks = checkpoint.tracks.map((track) => {
    if (track.trackId !== trackId) return track;
    found = true;
    return update(track);
  });
  if (!found) {
    throw invalidCheckpoint("视频生成恢复检查点缺少镜头");
  }
  const next = { ...checkpoint, tracks };
  assertCheckpointIntegrity(next);
  return next;
}

export function quickCreateVideoCheckpointTrack(
  checkpoint: QuickCreateVideoCommandCheckpoint,
  trackId: number,
): QuickCreateVideoTrackCheckpoint {
  const track = checkpoint.tracks.find((item) => item.trackId === trackId);
  if (!track) {
    throw invalidCheckpoint("视频生成恢复检查点缺少镜头");
  }
  return track;
}

export type OrderedBatchSettlement<TResult> =
  | { status: "fulfilled"; value: TResult }
  | { status: "rejected"; reason: unknown };

/**
 * Runs every item with a hard server-owned concurrency ceiling. Results keep
 * input order and one rejection never suppresses another item's durable
 * settlement. Callers decide which rejected errors are recoverable command
 * failures after every already-started worker has reached a safe checkpoint.
 */
export async function settleOrderedServerBatch<TItem, TResult>(input: {
  items: readonly TItem[];
  concurrency?: number;
  worker: (item: TItem, index: number) => Promise<TResult>;
}): Promise<Array<OrderedBatchSettlement<TResult>>> {
  if (input.items.length < 1 || input.items.length > QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS) {
    throw new DurableCommandIdempotencyError(
      400,
      "batch_size_invalid",
      `每批必须包含 1-${QUICK_CREATE_VIDEO_BATCH_MAX_ITEMS} 个镜头`,
    );
  }
  const requested = Number(input.concurrency ?? QUICK_CREATE_VIDEO_BATCH_MAX_CONCURRENCY);
  const concurrency = Math.min(
    QUICK_CREATE_VIDEO_BATCH_MAX_CONCURRENCY,
    Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 1),
  );
  const results = new Array<OrderedBatchSettlement<TResult>>(input.items.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, input.items.length) },
    async () => {
      while (cursor < input.items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = {
            status: "fulfilled",
            value: await input.worker(input.items[index], index),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  ));
  return results;
}
