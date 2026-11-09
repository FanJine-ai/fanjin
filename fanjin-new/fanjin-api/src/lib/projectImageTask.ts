import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Knex } from "knex";
import { z } from "zod";

import {
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  mutateDurableCommandCheckpoint,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import { insertAndReturnId, isPostgresClient } from "@/lib/dbDialect";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";

export const PROJECT_IMAGE_TASK_VERSION = "project-image-task.v1" as const;
export const PROJECT_IMAGE_TASK_RESOURCE_TYPE = "project_image_task";

const TASK_STATE_ACTIVE = "生成中";
const TASK_STATE_SUCCEEDED = "已完成";
const TASK_STATE_FAILED = "生成失败";
const TASK_STATE_CANCELLED = "已取消";
const DEFAULT_DISPATCH_RECONCILE_AFTER_MS = 15 * 60 * 1_000;
const RETRYABLE_PROVIDER_503_METADATA_KEY = "retryableProvider503";

export type ProjectImageTaskFlow = "storyboard" | "asset";
export type ProjectImageTaskPhase =
  | "preparing"
  | "queued"
  | "dispatching"
  | "provider_succeeded"
  | "persisting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "pending_reconcile";

export type ProjectImageProviderResult = Array<{
  url?: string;
  b64_json?: string;
}>;

export interface ProjectImageTaskCheckpoint {
  version: typeof PROJECT_IMAGE_TASK_VERSION;
  phase: ProjectImageTaskPhase;
  taskId: number | null;
  commandId: string | null;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  flow: ProjectImageTaskFlow;
  assetId: number | null;
  scriptId: number | null;
  storyboardId: number | null;
  model: string;
  prompt: string;
  finalPrompt: string;
  ratio: string;
  quality: string;
  resolution: string;
  providerIdempotencyKey: string;
  requestId: string | null;
  referenceImageIds: number[];
  referenceImageUrls: string[];
  metadata: Record<string, unknown>;
  claimToken: string | null;
  claimedAt: number | null;
  providerData: ProjectImageProviderResult | null;
  failureStatus: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  reconcileReason: string | null;
}

export interface ProjectImageTaskPublic {
  taskId: number;
  projectId: number;
  flow: ProjectImageTaskFlow;
  assetId: number | null;
  scriptId: number | null;
  storyboardId: number | null;
  phase: ProjectImageTaskPhase;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "pending_reconcile";
  cancelAllowed: boolean;
  model: string;
  reason: string | null;
  startedAt: number | null;
  response: unknown | null;
}

export type ProjectImageTaskReservation<TResponse> = {
  reservation: DurableCommandReservation<TResponse>;
  checkpoint: ProjectImageTaskCheckpoint;
};

export type BeginProjectImageTaskResult<TResponse> =
  | {
      kind: "replay";
      responseStatus: number;
      responseBody: TResponse;
    }
  | ({
      kind: "task";
    } & ProjectImageTaskReservation<TResponse>);

export type ProjectImageTaskClaim<TResponse> =
  | ({
      kind: "claimed";
      claimToken: string;
    } & ProjectImageTaskReservation<TResponse>)
  | ({
      kind: "not_claimed";
    } & ProjectImageTaskReservation<TResponse>);

export type ProjectImageTaskPersistenceClaim<TResponse> =
  | ({
      kind: "claimed";
      claimToken: string;
    } & ProjectImageTaskReservation<TResponse>)
  | ({
      kind: "not_claimed";
    } & ProjectImageTaskReservation<TResponse>);

export class ProjectImageTaskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly task?: ProjectImageTaskPublic,
  ) {
    super(message);
    this.name = "ProjectImageTaskError";
  }
}

function dispatchReconcileAfterMs(): number {
  const configured = Number(process.env.FANJIN_IMAGE_TASK_RECONCILE_AFTER_MS);
  return Number.isSafeInteger(configured) && configured >= 1_000
    ? configured
    : DEFAULT_DISPATCH_RECONCILE_AFTER_MS;
}

function normalizedIdempotencyKey(value: string | null | undefined): string {
  const key = String(value || "").trim();
  if (!key) {
    throw new ProjectImageTaskError(
      400,
      "idempotency_key_required",
      "图片生成任务必须提供 Idempotency-Key，才能安全恢复且避免重复扣费",
    );
  }
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function canRetryProjectImageProvider503(
  checkpoint: Pick<
    ProjectImageTaskCheckpoint,
    "phase" | "metadata" | "failureStatus" | "failureCode"
  >,
): boolean {
  if (checkpoint.phase !== "pending_reconcile") return false;
  if (checkpoint.metadata[RETRYABLE_PROVIDER_503_METADATA_KEY] === true) return true;

  // Before connection-reset recovery was introduced, a provider socket reset
  // was kept as a generic 502 pending-reconcile checkpoint. Replaying the
  // original immutable idempotency key is safe and lets those old requests
  // recover without creating a second generation or charge.
  return checkpoint.failureStatus === 502
    && checkpoint.failureCode === "image_task_pending_reconcile";
}

export function parseProjectImageTaskCheckpoint(
  value: unknown,
): ProjectImageTaskCheckpoint | null {
  if (!isRecord(value) || value.version !== PROJECT_IMAGE_TASK_VERSION) return null;
  const phase = String(value.phase || "") as ProjectImageTaskPhase;
  if (![
    "preparing",
    "queued",
    "dispatching",
    "provider_succeeded",
    "persisting",
    "succeeded",
    "failed",
    "cancelled",
    "pending_reconcile",
  ].includes(phase)) return null;
  const taskId = value.taskId === null ? null : Number(value.taskId);
  const actorUserId = Number(value.actorUserId);
  const projectId = Number(value.projectId);
  const flow = String(value.flow || "") as ProjectImageTaskFlow;
  const nullablePositiveId = (item: unknown): item is number | null => (
    item === null
    || Number.isSafeInteger(Number(item)) && Number(item) > 0
  );
  const nullableString = (item: unknown): item is string | null => (
    item === null || typeof item === "string"
  );
  const referenceImageIds = Array.isArray(value.referenceImageIds)
    ? value.referenceImageIds.map(Number)
    : null;
  const referenceImageUrls = Array.isArray(value.referenceImageUrls)
    ? value.referenceImageUrls
    : null;
  const providerData = value.providerData === null
    ? null
    : Array.isArray(value.providerData)
      ? value.providerData
      : undefined;
  if (
    (taskId !== null && (!Number.isSafeInteger(taskId) || taskId <= 0))
    || !Number.isSafeInteger(actorUserId)
    || actorUserId <= 0
    || !Number.isSafeInteger(projectId)
    || projectId <= 0
    || !["storyboard", "asset"].includes(flow)
    || typeof value.workspaceId !== "string"
    || !value.workspaceId.trim()
    || typeof value.model !== "string"
    || !value.model.trim()
    || typeof value.prompt !== "string"
    || typeof value.finalPrompt !== "string"
    || typeof value.ratio !== "string"
    || typeof value.quality !== "string"
    || typeof value.resolution !== "string"
    || typeof value.providerIdempotencyKey !== "string"
    || !value.providerIdempotencyKey.trim()
    || !nullablePositiveId(value.assetId)
    || !nullablePositiveId(value.scriptId)
    || !nullablePositiveId(value.storyboardId)
    || !nullableString(value.commandId)
    || !nullableString(value.requestId)
    || !nullableString(value.claimToken)
    || !nullableString(value.failureCode)
    || !nullableString(value.failureMessage)
    || !nullableString(value.reconcileReason)
    || (
      value.claimedAt !== null
      && (!Number.isFinite(Number(value.claimedAt)) || Number(value.claimedAt) < 0)
    )
    || (
      value.failureStatus !== null
      && !Number.isSafeInteger(Number(value.failureStatus))
    )
    || referenceImageIds === null
    || referenceImageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || referenceImageUrls === null
    || referenceImageUrls.some((url) => typeof url !== "string")
    || !isRecord(value.metadata)
    || providerData === undefined
    || providerData?.some((item) => (
      !isRecord(item)
      || (
        (typeof item.url !== "string" || !item.url.trim())
        && (typeof item.b64_json !== "string" || !item.b64_json.trim())
      )
    ))
    || (
      phase !== "preparing"
      && taskId === null
    )
    || (
      ["dispatching", "pending_reconcile"].includes(phase)
      && (
        typeof value.claimToken !== "string"
        || !value.claimToken.trim()
        || value.claimedAt === null
      )
    )
    || (
      ["provider_succeeded", "persisting"].includes(phase)
      && (!providerData || providerData.length === 0)
    )
    || (
      phase === "persisting"
      && (
        typeof value.claimToken !== "string"
        || !value.claimToken.trim()
        || value.claimedAt === null
      )
    )
  ) {
    return null;
  }
  return {
    version: PROJECT_IMAGE_TASK_VERSION,
    phase,
    taskId,
    commandId: value.commandId,
    workspaceId: value.workspaceId,
    actorUserId,
    projectId,
    flow,
    assetId: value.assetId === null ? null : Number(value.assetId),
    scriptId: value.scriptId === null ? null : Number(value.scriptId),
    storyboardId:
      value.storyboardId === null ? null : Number(value.storyboardId),
    model: value.model,
    prompt: value.prompt,
    finalPrompt: value.finalPrompt,
    ratio: value.ratio,
    quality: value.quality,
    resolution: value.resolution,
    providerIdempotencyKey: value.providerIdempotencyKey,
    requestId: value.requestId,
    referenceImageIds,
    referenceImageUrls: referenceImageUrls as string[],
    metadata: value.metadata,
    claimToken: value.claimToken,
    claimedAt: value.claimedAt === null ? null : Number(value.claimedAt),
    providerData: providerData as ProjectImageProviderResult | null,
    failureStatus:
      value.failureStatus === null ? null : Number(value.failureStatus),
    failureCode: value.failureCode,
    failureMessage: value.failureMessage,
    reconcileReason: value.reconcileReason,
  };
}

function taskDescriptor(checkpoint: ProjectImageTaskCheckpoint) {
  return {
    version: PROJECT_IMAGE_TASK_VERSION,
    commandId: checkpoint.commandId,
    workspaceId: checkpoint.workspaceId,
    projectId: checkpoint.projectId,
    flow: checkpoint.flow,
    assetId: checkpoint.assetId,
    scriptId: checkpoint.scriptId,
    storyboardId: checkpoint.storyboardId,
    type: checkpoint.flow === "storyboard" ? "分镜图片" : "资产图片",
  };
}

function publicState(phase: ProjectImageTaskPhase): ProjectImageTaskPublic["state"] {
  if (phase === "queued" || phase === "preparing") return "queued";
  if (
    phase === "dispatching"
    || phase === "provider_succeeded"
    || phase === "persisting"
  ) return "running";
  if (phase === "succeeded") return "succeeded";
  if (phase === "failed") return "failed";
  if (phase === "cancelled") return "cancelled";
  return "pending_reconcile";
}

function toPublicTask(
  checkpoint: ProjectImageTaskCheckpoint,
  row: Record<string, unknown>,
  response: unknown = null,
): ProjectImageTaskPublic {
  if (checkpoint.taskId === null) {
    throw new ProjectImageTaskError(
      500,
      "image_task_invalid",
      "图片生成任务缺少持久任务标识",
    );
  }
  return {
    taskId: checkpoint.taskId,
    projectId: checkpoint.projectId,
    flow: checkpoint.flow,
    assetId: checkpoint.assetId,
    scriptId: checkpoint.scriptId,
    storyboardId: checkpoint.storyboardId,
    phase: checkpoint.phase,
    state: publicState(checkpoint.phase),
    cancelAllowed: ["preparing", "queued"].includes(checkpoint.phase),
    model: String(row.model || checkpoint.model),
    reason: checkpoint.reconcileReason
      || checkpoint.failureMessage
      || (typeof row.reason === "string" && row.reason.trim() ? row.reason : null),
    startedAt: row.startTime == null ? null : Number(row.startTime),
    response,
  };
}

async function lockActiveProject(
  transaction: Knex.Transaction,
  workspaceId: string,
  projectId: number,
): Promise<void> {
  let query = transaction("o_project")
    .where({
      id: projectId,
      workspaceId,
      deletionState: "active",
    })
    .select("id");
  if (isPostgresClient(transaction)) query = query.forUpdate();
  if (!await query.first()) {
    throw new ProjectImageTaskError(
      409,
      "image_task_project_not_active",
      "项目正在删除或已不可用，不能启动图片生成任务",
    );
  }
}

async function lockActiveImageTarget(
  transaction: Knex.Transaction,
  checkpoint: ProjectImageTaskCheckpoint,
): Promise<void> {
  if (checkpoint.flow === "asset") {
    if (checkpoint.assetId === null) {
      throw new ProjectImageTaskError(
        409,
        "image_task_target_not_active",
        "资产生成目标已删除或不属于当前项目",
      );
    }
    let assetQuery = transaction("o_assets")
      .where({
        id: checkpoint.assetId,
        projectId: checkpoint.projectId,
        deletionState: "active",
      })
      .select("id");
    if (isPostgresClient(transaction)) assetQuery = assetQuery.forUpdate();
    if (!await assetQuery.first()) {
      throw new ProjectImageTaskError(
        409,
        "image_task_target_not_active",
        "资产生成目标已删除或不属于当前项目",
      );
    }
    return;
  }
  if (checkpoint.storyboardId === null || checkpoint.scriptId === null) {
    throw new ProjectImageTaskError(
      409,
      "image_task_target_not_active",
      "分镜生成目标已删除或归属链不完整",
    );
  }
  let storyboardQuery = transaction("o_storyboard")
    .where({
      id: checkpoint.storyboardId,
      projectId: checkpoint.projectId,
      scriptId: checkpoint.scriptId,
    })
    .select("id");
  if (isPostgresClient(transaction)) storyboardQuery = storyboardQuery.forUpdate();
  if (!await storyboardQuery.first()) {
    throw new ProjectImageTaskError(
      409,
      "image_task_target_not_active",
      "分镜生成目标已删除或归属链不完整",
    );
  }
}

export async function beginProjectImageTask<TResponse>(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  flow: ProjectImageTaskFlow;
  scope: string;
  idempotencyKey: string | null | undefined;
  request: unknown;
  assetId?: number | null;
  scriptId?: number | null;
  storyboardId?: number | null;
  model: string;
  prompt: string;
  finalPrompt: string;
  ratio: string;
  quality: string;
  resolution: string;
  requestId?: string | null;
  referenceImageIds?: number[];
  referenceImageUrls?: string[];
  metadata?: Record<string, unknown>;
}): Promise<BeginProjectImageTaskResult<TResponse>> {
  const idempotencyKey = normalizedIdempotencyKey(input.idempotencyKey);
  const initialCheckpoint: ProjectImageTaskCheckpoint = {
    version: PROJECT_IMAGE_TASK_VERSION,
    phase: "preparing",
    taskId: null,
    commandId: null,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    flow: input.flow,
    assetId: input.assetId ?? null,
    scriptId: input.scriptId ?? null,
    storyboardId: input.storyboardId ?? null,
    model: input.model,
    prompt: input.prompt,
    finalPrompt: input.finalPrompt,
    ratio: input.ratio,
    quality: input.quality,
    resolution: input.resolution,
    providerIdempotencyKey: idempotencyKey,
    requestId: String(input.requestId || "").trim() || null,
    referenceImageIds: input.referenceImageIds || [],
    referenceImageUrls: input.referenceImageUrls || [],
    metadata: input.metadata || {},
    claimToken: null,
    claimedAt: null,
    providerData: null,
    failureStatus: null,
    failureCode: null,
    failureMessage: null,
    reconcileReason: null,
  };
  let reservation: DurableCommandReservation<TResponse>;
  try {
    reservation = await beginDurableCommand<TResponse>({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      scope: input.scope,
      idempotencyKey,
      request: input.request,
      initialCheckpoint,
      resourceType: "project",
      resourceId: input.projectId,
    });
  } catch (error) {
    if (error instanceof DurableCommandIdempotencyError) {
      throw new ProjectImageTaskError(error.status, error.code, error.message);
    }
    throw error;
  }
  if (reservation.kind === "replay") return reservation;
  if (reservation.kind !== "resume") {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_missing",
      "图片生成任务未建立可恢复检查点",
    );
  }
  let checkpoint = parseProjectImageTaskCheckpoint(reservation.checkpoint);
  if (!checkpoint) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  let mutation;
  try {
    mutation = await mutateDurableCommandCheckpoint<TResponse, ProjectImageTaskCheckpoint>(
      reservation,
      async (current, transaction) => {
      const parsed = parseProjectImageTaskCheckpoint(current);
      if (!parsed) {
        throw new ProjectImageTaskError(
          500,
          "image_task_checkpoint_invalid",
          "图片生成任务恢复检查点无效",
        );
      }
      if (parsed.taskId !== null) return parsed;
      await lockActiveProject(transaction, parsed.workspaceId, parsed.projectId);
      await lockActiveImageTarget(transaction, parsed);
      const commandId = reservation.kind === "resume" ? reservation.id : null;
      const taskCheckpoint = {
        ...parsed,
        phase: "queued" as const,
        commandId,
      };
      const taskId = await insertAndReturnId(transaction, "o_tasks", {
        projectId: parsed.projectId,
        taskClass: parsed.flow === "storyboard" ? "分镜图片生成" : "资产图片生成",
        relatedObjects: JSON.stringify(taskDescriptor(taskCheckpoint)),
        model: parsed.model,
        describe: parsed.prompt,
        state: TASK_STATE_ACTIVE,
        startTime: Date.now(),
        reason: "",
      });
      if (
        parsed.flow === "storyboard"
        && parsed.storyboardId !== null
        && parsed.scriptId !== null
      ) {
        // Publish the initial storyboard state in the same transaction as the
        // durable task. The batch route must not write "生成中" later from a
        // stale checkpoint because a concurrent retry can otherwise overwrite
        // an already committed success.
        await transaction("o_storyboard")
          .where({
            id: parsed.storyboardId,
            projectId: parsed.projectId,
            scriptId: parsed.scriptId,
          })
          .update({
            state: "生成中",
            shouldGenerateImage: 1,
            reason: "",
          });
      }
      await transaction("o_agent_idempotency")
        .where({ id: reservation.id, status: "checkpointed" })
        .update({
          resourceType: PROJECT_IMAGE_TASK_RESOURCE_TYPE,
          resourceId: String(taskId),
        });
      return {
        ...taskCheckpoint,
        taskId,
      };
      },
    );
  } catch (error) {
    if (
      error instanceof ProjectImageTaskError
      && error.code === "image_task_target_not_active"
    ) {
      await completeDurableCommand(
        reservation,
        { message: error.message, code: error.code } as TResponse,
        error.status,
      );
    }
    throw error;
  }
  if (mutation.kind === "replay") return mutation;
  checkpoint = parseProjectImageTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint || checkpoint.taskId === null) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务缺少持久任务标识",
    );
  }
  return {
    kind: "task",
    reservation: {
      kind: "resume",
      id: mutation.id,
      checkpoint,
    },
    checkpoint,
  };
}

export async function claimProjectImageTask<TResponse>(
  task: ProjectImageTaskReservation<TResponse>,
  options: { now?: number; claimToken?: string } = {},
): Promise<ProjectImageTaskClaim<TResponse>> {
  const now = options.now ?? Date.now();
  const claimToken = options.claimToken || randomUUID();
  let claimed = false;
  const mutation = await mutateDurableCommandCheckpoint<TResponse, ProjectImageTaskCheckpoint>(
    task.reservation,
    async (current, transaction) => {
      const checkpoint = parseProjectImageTaskCheckpoint(current);
      if (!checkpoint || checkpoint.taskId === null) {
        throw new ProjectImageTaskError(
          500,
          "image_task_checkpoint_invalid",
          "图片生成任务恢复检查点无效",
        );
      }
      if (
        checkpoint.phase === "queued"
        || canRetryProjectImageProvider503(checkpoint)
      ) {
        const recoveryAvailableAt = Number(
          checkpoint.metadata.recoveryAvailableAt || 0,
        );
        if (
          checkpoint.failureCode === "portrait_provider_binding_pending"
          && Number.isFinite(recoveryAvailableAt)
          && recoveryAvailableAt > now
        ) {
          return checkpoint;
        }
        claimed = true;
        await transaction("o_tasks")
          .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
          .update({ state: TASK_STATE_ACTIVE, reason: "" });
        if (checkpoint.flow === "storyboard" && checkpoint.storyboardId !== null) {
          await transaction("o_storyboard")
            .where({
              id: checkpoint.storyboardId,
              projectId: checkpoint.projectId,
              ...(checkpoint.scriptId === null ? {} : { scriptId: checkpoint.scriptId }),
            })
            .update({ state: "生成中", reason: "" });
        }
        return {
          ...checkpoint,
          phase: "dispatching",
          claimToken,
          claimedAt: now,
          failureStatus: null,
          failureCode: null,
          failureMessage: null,
          reconcileReason: null,
          metadata: {
            ...checkpoint.metadata,
            recoveryAvailableAt: 0,
            [RETRYABLE_PROVIDER_503_METADATA_KEY]: false,
          },
        };
      }
      if (
        checkpoint.phase === "dispatching"
        && Number(checkpoint.claimedAt || 0) <= now - dispatchReconcileAfterMs()
      ) {
        const reconcileReason = "图片请求已越过上游派发边界，但未取得可确认结果，禁止自动重发";
        await transaction("o_tasks")
          .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
          .update({ state: TASK_STATE_ACTIVE, reason: reconcileReason });
        return {
          ...checkpoint,
          phase: "pending_reconcile",
          reconcileReason,
        };
      }
      return checkpoint;
    },
  );
  if (mutation.kind === "replay") {
    throw new ProjectImageTaskError(
      409,
      "image_task_already_completed",
      "图片生成任务已经完成",
    );
  }
  const checkpoint = parseProjectImageTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  const reservation: DurableCommandReservation<TResponse> = {
    kind: "resume",
    id: mutation.id,
    checkpoint,
  };
  return claimed
    ? { kind: "claimed", claimToken, reservation, checkpoint }
    : { kind: "not_claimed", reservation, checkpoint };
}

/**
 * Returns a dispatch claim to the same durable task after a provider portrait
 * binding was found to be not-yet-Active. This transition is only valid for a
 * pre-provider boundary error owned by `claimToken`; callers must never use it
 * for an ambiguous provider outcome.
 */
export async function requeueProjectImageTask<TResponse>(
  task: ProjectImageTaskReservation<TResponse>,
  claimToken: string,
  input: {
    status: number;
    code: string;
    message: string;
    retryAttempt: number;
    retryAvailableAt: number;
  },
): Promise<ProjectImageTaskReservation<TResponse>> {
  const mutation = await mutateDurableCommandCheckpoint<
    TResponse,
    ProjectImageTaskCheckpoint
  >(
    task.reservation,
    async (current, transaction) => {
      const checkpoint = parseProjectImageTaskCheckpoint(current);
      if (!checkpoint || checkpoint.taskId === null) {
        throw new ProjectImageTaskError(
          500,
          "image_task_checkpoint_invalid",
          "图片生成任务恢复检查点无效",
        );
      }
      if (
        checkpoint.phase !== "dispatching"
        || checkpoint.claimToken !== claimToken
      ) {
        throw new ProjectImageTaskError(
          409,
          "image_task_claim_lost",
          "图片生成任务派发权已变化，不能返回等待队列",
        );
      }
      await transaction("o_tasks")
        .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
        .update({ state: TASK_STATE_ACTIVE, reason: input.message });
      if (checkpoint.flow === "storyboard" && checkpoint.storyboardId !== null) {
        await transaction("o_storyboard")
          .where({
            id: checkpoint.storyboardId,
            projectId: checkpoint.projectId,
            ...(checkpoint.scriptId === null
              ? {}
              : { scriptId: checkpoint.scriptId }),
          })
          .update({ state: "生成中", reason: input.message });
      }
      return {
        ...checkpoint,
        phase: "queued",
        claimToken: null,
        claimedAt: null,
        failureStatus: input.status,
        failureCode: input.code,
        failureMessage: input.message,
        reconcileReason: null,
        metadata: {
          ...checkpoint.metadata,
          bindingRetryAttempt: input.retryAttempt,
          recoveryAvailableAt: input.retryAvailableAt,
        },
      };
    },
  );
  if (mutation.kind === "replay") {
    throw new ProjectImageTaskError(
      409,
      "image_task_already_completed",
      "图片生成任务已经完成",
    );
  }
  const checkpoint = parseProjectImageTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  return {
    reservation: {
      kind: "resume",
      id: mutation.id,
      checkpoint,
    },
    checkpoint,
  };
}

export async function checkpointProjectImageProviderSuccess<TResponse>(
  task: ProjectImageTaskReservation<TResponse>,
  claimToken: string,
  providerData: ProjectImageProviderResult,
): Promise<ProjectImageTaskReservation<TResponse>> {
  const mutation = await mutateDurableCommandCheckpoint<TResponse, ProjectImageTaskCheckpoint>(
    task.reservation,
    async (current, transaction) => {
      const checkpoint = parseProjectImageTaskCheckpoint(current);
      if (!checkpoint || checkpoint.taskId === null) {
        throw new ProjectImageTaskError(
          500,
          "image_task_checkpoint_invalid",
          "图片生成任务恢复检查点无效",
        );
      }
      if (
        !["dispatching", "pending_reconcile"].includes(checkpoint.phase)
        || checkpoint.claimToken !== claimToken
      ) {
        throw new ProjectImageTaskError(
          409,
          "image_task_claim_lost",
          "图片生成任务派发权已变化，不能写入上游结果",
        );
      }
      await transaction("o_tasks")
        .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
        .update({ state: TASK_STATE_ACTIVE, reason: "" });
      return {
        ...checkpoint,
        phase: "provider_succeeded",
        providerData,
        reconcileReason: null,
      };
    },
  );
  if (mutation.kind === "replay") {
    throw new ProjectImageTaskError(
      409,
      "image_task_already_completed",
      "图片生成任务已经完成",
    );
  }
  const checkpoint = parseProjectImageTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  return {
    reservation: {
      kind: "resume",
      id: mutation.id,
      checkpoint,
    },
    checkpoint,
  };
}

export async function claimProjectImageTaskPersistence<TResponse>(
  task: ProjectImageTaskReservation<TResponse>,
  options: { now?: number; claimToken?: string } = {},
): Promise<ProjectImageTaskPersistenceClaim<TResponse>> {
  const now = options.now ?? Date.now();
  const claimToken = options.claimToken || randomUUID();
  let claimed = false;
  const mutation = await mutateDurableCommandCheckpoint<TResponse, ProjectImageTaskCheckpoint>(
    task.reservation,
    async (current, transaction) => {
      const checkpoint = parseProjectImageTaskCheckpoint(current);
      if (!checkpoint || checkpoint.taskId === null) {
        throw new ProjectImageTaskError(
          500,
          "image_task_checkpoint_invalid",
          "图片生成任务恢复检查点无效",
        );
      }
      const stalePersistenceClaim = checkpoint.phase === "persisting"
        && Number(checkpoint.claimedAt || 0) <= now - dispatchReconcileAfterMs();
      if (checkpoint.phase === "provider_succeeded" || stalePersistenceClaim) {
        claimed = true;
        await transaction("o_tasks")
          .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
          .update({
            state: TASK_STATE_ACTIVE,
            reason: stalePersistenceClaim ? "正在恢复图片结果保存" : "",
          });
        return {
          ...checkpoint,
          phase: "persisting",
          claimToken,
          claimedAt: now,
        };
      }
      return checkpoint;
    },
  );
  if (mutation.kind === "replay") {
    throw new ProjectImageTaskError(
      409,
      "image_task_already_completed",
      "图片生成任务已经完成",
    );
  }
  const checkpoint = parseProjectImageTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  const reservation: DurableCommandReservation<TResponse> = {
    kind: "resume",
    id: mutation.id,
    checkpoint,
  };
  return claimed
    ? { kind: "claimed", claimToken, reservation, checkpoint }
    : { kind: "not_claimed", reservation, checkpoint };
}

export async function recordProjectImageTaskPersistenceFailure<TResponse>(
  task: ProjectImageTaskReservation<TResponse>,
  claimToken: string,
  message: string,
): Promise<ProjectImageTaskReservation<TResponse>> {
  const mutation = await mutateDurableCommandCheckpoint<TResponse, ProjectImageTaskCheckpoint>(
    task.reservation,
    async (current, transaction) => {
      const checkpoint = parseProjectImageTaskCheckpoint(current);
      if (!checkpoint || checkpoint.taskId === null) {
        throw new ProjectImageTaskError(
          500,
          "image_task_checkpoint_invalid",
          "图片生成任务恢复检查点无效",
        );
      }
      if (
        checkpoint.phase !== "persisting"
        || checkpoint.claimToken !== claimToken
      ) {
        throw new ProjectImageTaskError(
          409,
          "image_task_claim_lost",
          "图片生成任务保存权已变化，不能写入失败状态",
        );
      }
      await transaction("o_tasks")
        .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
        .update({ state: TASK_STATE_ACTIVE, reason: message });
      if (checkpoint.flow === "storyboard" && checkpoint.storyboardId !== null) {
        await transaction("o_storyboard")
          .where({
            id: checkpoint.storyboardId,
            projectId: checkpoint.projectId,
            ...(checkpoint.scriptId === null ? {} : { scriptId: checkpoint.scriptId }),
          })
          .update({ state: "生成中", reason: message });
      }
      return {
        ...checkpoint,
        failureStatus: 500,
        failureCode: "image_task_persistence_retryable",
        failureMessage: message,
      };
    },
  );
  if (mutation.kind === "replay") {
    throw new ProjectImageTaskError(
      409,
      "image_task_already_completed",
      "图片生成任务已经完成",
    );
  }
  const checkpoint = parseProjectImageTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  return {
    reservation: {
      kind: "resume",
      id: mutation.id,
      checkpoint,
    },
    checkpoint,
  };
}

export async function failProjectImageTask<TResponse>(
  task: ProjectImageTaskReservation<TResponse>,
  input: {
    status: number;
    code: string;
    message: string;
    pendingReconcile?: boolean;
    retryableProvider503?: boolean;
  },
): Promise<ProjectImageTaskReservation<TResponse>> {
  const mutation = await mutateDurableCommandCheckpoint<TResponse, ProjectImageTaskCheckpoint>(
    task.reservation,
    async (current, transaction) => {
      const checkpoint = parseProjectImageTaskCheckpoint(current);
      if (!checkpoint || checkpoint.taskId === null) {
        throw new ProjectImageTaskError(
          500,
          "image_task_checkpoint_invalid",
          "图片生成任务恢复检查点无效",
        );
      }
      const pendingReconcile = input.pendingReconcile === true
        || checkpoint.phase === "pending_reconcile";
      await transaction("o_tasks")
        .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
        .update({
          state: pendingReconcile ? TASK_STATE_ACTIVE : TASK_STATE_FAILED,
          reason: input.message,
        });
      if (checkpoint.flow === "storyboard" && checkpoint.storyboardId !== null) {
        await transaction("o_storyboard")
          .where({
            id: checkpoint.storyboardId,
            projectId: checkpoint.projectId,
            ...(checkpoint.scriptId === null ? {} : { scriptId: checkpoint.scriptId }),
          })
          .update({
            state: pendingReconcile ? "生成中" : "生成失败",
            reason: input.message,
            ...(pendingReconcile ? {} : { filePath: "" }),
          });
      }
      return {
        ...checkpoint,
        phase: pendingReconcile ? "pending_reconcile" : "failed",
        failureStatus: input.status,
        failureCode: input.code,
        failureMessage: input.message,
        reconcileReason: pendingReconcile ? input.message : null,
        metadata: {
          ...checkpoint.metadata,
          [RETRYABLE_PROVIDER_503_METADATA_KEY]:
            pendingReconcile && input.retryableProvider503 === true,
        },
      };
    },
  );
  if (mutation.kind === "replay") {
    throw new ProjectImageTaskError(
      409,
      "image_task_already_completed",
      "图片生成任务已经完成",
    );
  }
  const checkpoint = parseProjectImageTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  return {
    reservation: {
      kind: "resume",
      id: mutation.id,
      checkpoint,
    },
    checkpoint,
  };
}

export async function completeProjectImageTask<TResponse>(
  task: ProjectImageTaskReservation<TResponse>,
  responseBody: TResponse,
  options: {
    responseStatus?: number;
    database?: Knex | Knex.Transaction;
  } = {},
): Promise<void> {
  if (task.checkpoint.taskId === null) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务缺少持久任务标识",
    );
  }
  const database = options.database || db;
  await database("o_tasks")
    .where({
      id: task.checkpoint.taskId,
      projectId: task.checkpoint.projectId,
    })
    .update({
      state: TASK_STATE_SUCCEEDED,
      reason: "",
    });
  await completeDurableCommand(
    task.reservation,
    responseBody,
    options.responseStatus ?? 200,
    { database: database as typeof db },
  );
}

export async function listRunnableProjectImageTasks(input: {
  flow?: ProjectImageTaskFlow;
  phases?: readonly ProjectImageTaskPhase[];
  limit?: number;
  database?: Knex;
  now?: number;
} = {}): Promise<Array<ProjectImageTaskReservation<unknown>>> {
  const database = input.database || db;
  const now = input.now ?? Date.now();
  const requestedLimit = Number(input.limit ?? 25);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(100, Math.max(1, requestedLimit))
    : 25;
  const tasks: Array<ProjectImageTaskReservation<unknown>> = [];
  const requestedPhases = input.phases?.length
    ? new Set(input.phases)
    : null;
  const pageSize = Math.max(100, limit * 4);
  let offset = 0;
  while (tasks.length < limit) {
    const rows = await database("o_agent_idempotency")
      .where({
        resourceType: PROJECT_IMAGE_TASK_RESOURCE_TYPE,
        status: "checkpointed",
      })
      .select("id", "responseBody")
      .orderBy("updatedAt", "asc")
      .orderBy("id", "asc")
      .limit(pageSize)
      .offset(offset);
    if (!rows.length) break;
    offset += rows.length;
    for (const row of rows) {
      let checkpoint: ProjectImageTaskCheckpoint | null = null;
      try {
        checkpoint = parseProjectImageTaskCheckpoint(
          JSON.parse(String(row.responseBody || "")),
        );
      } catch {
        checkpoint = null;
      }
      if (
        !checkpoint
        || checkpoint.taskId === null
        || input.flow && checkpoint.flow !== input.flow
        || ![
          "queued",
          "dispatching",
          "provider_succeeded",
          "persisting",
        ].includes(checkpoint.phase)
        || requestedPhases && !requestedPhases.has(checkpoint.phase)
      ) {
        continue;
      }
      const recoveryAvailableAt = Number(
        checkpoint.metadata.recoveryAvailableAt || 0,
      );
      if (
        checkpoint.phase === "queued"
        && Number.isFinite(recoveryAvailableAt)
        && recoveryAvailableAt > now
      ) {
        continue;
      }
      tasks.push({
        reservation: {
          kind: "resume",
          id: String(row.id),
          checkpoint,
        },
        checkpoint,
      });
      if (tasks.length >= limit) break;
    }
    if (rows.length < pageSize) break;
  }
  return tasks;
}

async function readProjectImageTasks(input: {
  workspaceId: string;
  projectId: number;
  taskIds?: number[];
}): Promise<ProjectImageTaskPublic[]> {
  const project = await db("o_project")
    .where({
      id: input.projectId,
      workspaceId: input.workspaceId,
      deletionState: "active",
    })
    .select("id")
    .first();
  if (!project) {
    throw new ProjectImageTaskError(
      404,
      "image_task_project_not_found",
      "项目不存在或已不可用",
    );
  }
  let query = db("o_tasks")
    .where({
      projectId: input.projectId,
    })
    .whereIn("taskClass", ["分镜图片生成", "资产图片生成"])
    .select("*")
    .orderBy("id", "desc");
  if (input.taskIds?.length) query = query.whereIn("id", input.taskIds);
  const rows = await query;
  if (!rows.length) return [];
  const commandRows = await db("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      resourceType: PROJECT_IMAGE_TASK_RESOURCE_TYPE,
    })
    .whereIn("resourceId", rows.map((row) => String(row.id)))
    .select("id", "resourceId", "status", "responseBody");
  const commandByTaskId = new Map(
    commandRows.map((row) => [String(row.resourceId), row]),
  );
  const result: ProjectImageTaskPublic[] = [];
  for (const row of rows) {
    const command = commandByTaskId.get(String(row.id));
    let checkpoint: ProjectImageTaskCheckpoint | null = null;
    let response: unknown = null;
    if (command?.status === "checkpointed") {
      try {
        checkpoint = parseProjectImageTaskCheckpoint(JSON.parse(String(command.responseBody || "")));
      } catch {
        checkpoint = null;
      }
    } else if (command?.status === "completed") {
      try {
        response = JSON.parse(String(command.responseBody || ""));
      } catch {
        response = null;
      }
      let descriptor: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(row.relatedObjects || ""));
        descriptor = isRecord(parsed) ? parsed : {};
      } catch {
        descriptor = {};
      }
      checkpoint = {
        version: PROJECT_IMAGE_TASK_VERSION,
        phase: String(row.state || "") === TASK_STATE_CANCELLED ? "cancelled" : "succeeded",
        taskId: Number(row.id),
        commandId: command.id == null ? null : String(command.id),
        workspaceId: input.workspaceId,
        actorUserId: 1,
        projectId: input.projectId,
        flow: descriptor.flow === "storyboard" ? "storyboard" : "asset",
        assetId: descriptor.assetId == null ? null : Number(descriptor.assetId),
        scriptId: descriptor.scriptId == null ? null : Number(descriptor.scriptId),
        storyboardId: descriptor.storyboardId == null ? null : Number(descriptor.storyboardId),
        model: String(row.model || ""),
        prompt: String(row.describe || ""),
        finalPrompt: "",
        ratio: "",
        quality: "",
        resolution: "",
        providerIdempotencyKey: "completed",
        requestId: null,
        referenceImageIds: [],
        referenceImageUrls: [],
        metadata: {},
        claimToken: null,
        claimedAt: null,
        providerData: null,
        failureStatus: null,
        failureCode: null,
        failureMessage: null,
        reconcileReason: null,
      };
    }
    if (checkpoint) result.push(toPublicTask(checkpoint, row, response));
  }
  return result;
}

export async function cancelProjectImageTask(input: {
  workspaceId: string;
  projectId: number;
  taskId: number;
}): Promise<{
  cancelled: boolean;
  task: ProjectImageTaskPublic;
}> {
  const [task] = await readProjectImageTasks({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    taskIds: [input.taskId],
  });
  if (!task) {
    throw new ProjectImageTaskError(
      404,
      "image_task_not_found",
      "图片生成任务不存在",
    );
  }
  const command = await db("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      resourceType: PROJECT_IMAGE_TASK_RESOURCE_TYPE,
      resourceId: String(input.taskId),
      status: "checkpointed",
    })
    .select("id", "responseBody")
    .first();
  if (!command) {
    return {
      cancelled: task.phase === "cancelled",
      task,
    };
  }
  let checkpoint: ProjectImageTaskCheckpoint | null = null;
  try {
    checkpoint = parseProjectImageTaskCheckpoint(JSON.parse(String(command.responseBody || "")));
  } catch {
    checkpoint = null;
  }
  if (!checkpoint) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  const reservation: DurableCommandReservation<unknown> = {
    kind: "resume",
    id: String(command.id),
    checkpoint,
  };
  let cancelled = false;
  const mutation = await mutateDurableCommandCheckpoint<unknown, ProjectImageTaskCheckpoint>(
    reservation,
    async (current, transaction) => {
      const currentCheckpoint = parseProjectImageTaskCheckpoint(current);
      if (!currentCheckpoint || currentCheckpoint.taskId !== input.taskId) {
        throw new ProjectImageTaskError(
          409,
          "image_task_checkpoint_conflict",
          "图片生成任务状态已变化",
        );
      }
      if (["preparing", "queued"].includes(currentCheckpoint.phase)) {
        cancelled = true;
        await transaction("o_tasks")
          .where({ id: input.taskId, projectId: input.projectId })
          .update({ state: TASK_STATE_CANCELLED, reason: "任务已在上游派发前取消" });
        if (
          currentCheckpoint.flow === "storyboard"
          && currentCheckpoint.storyboardId !== null
        ) {
          await transaction("o_storyboard")
            .where({
              id: currentCheckpoint.storyboardId,
              projectId: currentCheckpoint.projectId,
              ...(currentCheckpoint.scriptId === null
                ? {}
                : { scriptId: currentCheckpoint.scriptId }),
            })
            .update({ state: "未生成", reason: "任务已取消" });
        }
        return {
          ...currentCheckpoint,
          phase: "cancelled",
          failureStatus: 409,
          failureCode: "image_task_cancelled",
          failureMessage: "任务已在上游派发前取消",
        };
      }
      if (currentCheckpoint.phase === "dispatching") {
        const reconcileReason = "图片请求已派发上游，无法安全撤回；任务进入待核对状态";
        await transaction("o_tasks")
          .where({ id: input.taskId, projectId: input.projectId })
          .update({ state: TASK_STATE_ACTIVE, reason: reconcileReason });
        return {
          ...currentCheckpoint,
          phase: "pending_reconcile",
          reconcileReason,
        };
      }
      return currentCheckpoint;
    },
  );
  if (mutation.kind === "replay") {
    const [current] = await readProjectImageTasks({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      taskIds: [input.taskId],
    });
    const replayedTask = current || task;
    return {
      cancelled: replayedTask.phase === "cancelled",
      task: replayedTask,
    };
  }
  const next = parseProjectImageTaskCheckpoint(mutation.checkpoint);
  if (!next) {
    throw new ProjectImageTaskError(
      500,
      "image_task_checkpoint_invalid",
      "图片生成任务恢复检查点无效",
    );
  }
  if (cancelled) {
    await completeDurableCommand(
      {
        kind: "resume",
        id: mutation.id,
        checkpoint: next,
      },
      {
        code: "image_task_cancelled",
        message: "任务已在上游派发前取消",
        taskId: input.taskId,
        state: "cancelled",
      },
      409,
    );
  }
  const [current] = await readProjectImageTasks({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    taskIds: [input.taskId],
  });
  if (!current) {
    throw new ProjectImageTaskError(
      404,
      "image_task_not_found",
      "图片生成任务不存在",
    );
  }
  return { cancelled, task: current };
}

const statusFields = {
  projectId: z.number().int().positive(),
  taskIds: z.array(z.number().int().positive()).max(100).optional(),
};

const cancelFields = {
  projectId: z.number().int().positive(),
  taskId: z.number().int().positive(),
};

export const projectImageTaskStatusHandlers: RequestHandler[] = [
  requireProjectPermission("project:read"),
  validateFields(statusFields),
  async (req, res) => {
    try {
      const tasks = await readProjectImageTasks({
        workspaceId: String((req as any).auth?.workspaceId || "").trim(),
        projectId: Number(req.body.projectId),
        taskIds: req.body.taskIds,
      });
      return res.status(200).send({ code: 0, data: tasks });
    } catch (error) {
      if (error instanceof ProjectImageTaskError) {
        return res.status(error.status).send({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  },
];

export const projectImageTaskCancelHandlers: RequestHandler[] = [
  requireProjectPermission("generation:create"),
  validateFields(cancelFields),
  async (req, res) => {
    try {
      const result = await cancelProjectImageTask({
        workspaceId: String((req as any).auth?.workspaceId || "").trim(),
        projectId: Number(req.body.projectId),
        taskId: Number(req.body.taskId),
      });
      return res.status(result.cancelled ? 200 : 409).send({
        code: result.cancelled ? 0 : "image_task_not_cancelled",
        data: result,
        message: result.cancelled
          ? "图片生成任务已取消"
          : result.task.phase === "pending_reconcile"
            ? "图片请求已派发上游，无法安全撤回，正在等待核对"
            : "图片生成任务当前不能取消",
      });
    } catch (error) {
      if (error instanceof ProjectImageTaskError) {
        return res.status(error.status).send({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  },
];
