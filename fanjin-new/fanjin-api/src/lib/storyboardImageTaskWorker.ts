import type { Knex } from "knex";

import { BillingError } from "@/lib/billing";
import { WorkspaceGenerationQueued } from "./workspaceResources";
import { persistGeneratedProjectImages } from "@/lib/generatedImagePersistence";
import {
  checkpointProjectImageProviderSuccess,
  canRetryProjectImageProvider503,
  claimProjectImageTask,
  claimProjectImageTaskPersistence,
  completeProjectImageTask,
  failProjectImageTask,
  listRunnableProjectImageTasks,
  ProjectImageTaskError,
  recordProjectImageTaskPersistenceFailure,
  requeueProjectImageTask,
  type ProjectImageTaskReservation,
} from "@/lib/projectImageTask";
import {
  isRetryablePortraitProviderBindingPending,
  isUnsupportedPortraitImageReference,
  portraitProviderBindingRetrySchedule,
  PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
} from "@/lib/portraitProviderBindingRetry";
import {
  executeRelayImage,
  RelayImageError,
  shouldRetryIdempotentImageRequest,
} from "@/lib/relayImage";
import {
  resolveWorkbenchModelCapability,
  type WorkbenchModelCapability,
} from "@/lib/workbenchModelCatalog";
import { resolveVolcengineImageSize } from "@/lib/volcengineImageSize";
import {
  isRecoveryOnlyMode,
  recoveryOnlyStoryboardWorkDisposition,
} from "@/lib/recoveryOnlyMode";
import u from "@/utils";
import { db } from "@/utils/db";

const SUBMITTABLE_CAPABILITY_STATUSES = new Set([
  "verified",
  "configured",
  "legacy",
]);

export type StoryboardImageTaskResponse = {
  imageTaskId: number;
  storyboardId: number;
  state: "succeeded";
  assetId: number;
  assetVersionId: number;
};

export type StoryboardImageTaskRunResult =
  | "succeeded"
  | "failed"
  | "queued"
  | "pending_reconcile"
  | "already_running"
  | "not_runnable";

type StoryboardImageTaskRunnerRuntime = {
  database?: Knex;
  resolveCapability?: typeof resolveWorkbenchModelCapability;
  executeImage?: typeof executeRelayImage;
  persistImages?: typeof persistGeneratedProjectImages;
  readImageBase64?: (storageKey: string) => Promise<string>;
};

function capabilityValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && Boolean(item.trim()),
      )
    : [];
}

function canSubmitCapability(
  capability: WorkbenchModelCapability | null,
): capability is WorkbenchModelCapability & { canSubmit: true } {
  return Boolean(
    capability
    && capability.canSubmit === true
    && SUBMITTABLE_CAPABILITY_STATUSES.has(capability.capabilityStatus),
  );
}

function imageReferenceCapacity(inputSlots: unknown): number {
  if (!Array.isArray(inputSlots)) return 0;
  return inputSlots.reduce((total, raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return total;
    const slot = raw as Record<string, unknown>;
    const rawAccepts = Array.isArray(slot.accepts)
      ? slot.accepts
      : typeof slot.accepts === "string"
        ? slot.accepts.split(",")
        : typeof slot.accept === "string"
          ? slot.accept.split(",")
          : [];
    const acceptsImage = rawAccepts.some((item) =>
      String(item).trim().toLowerCase().startsWith("image")
    );
    if (!acceptsImage) return total;
    const maximum = Number(slot.max ?? 1);
    return total
      + (Number.isSafeInteger(maximum) && maximum > 0 ? maximum : 1);
  }, 0);
}

function metadataNumberArray(
  metadata: Record<string, unknown>,
  key: string,
): number[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .map(Number)
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

async function assertRunnableStoryboard(
  task: ProjectImageTaskReservation<unknown>,
  database: Knex,
): Promise<void> {
  const checkpoint = task.checkpoint;
  const project = await database("o_project")
    .where({
      id: checkpoint.projectId,
      workspaceId: checkpoint.workspaceId,
      deletionState: "active",
    })
    .select("id")
    .first();
  if (!project) {
    throw new ProjectImageTaskError(
      409,
      "image_task_project_not_active",
      "项目正在删除或已不可用，图片任务已停止",
    );
  }
  if (checkpoint.storyboardId === null || checkpoint.scriptId === null) {
    throw new ProjectImageTaskError(
      500,
      "image_task_storyboard_invalid",
      "分镜图片任务缺少分镜或剧本标识",
    );
  }
  const storyboard = await database("o_storyboard")
    .where({
      id: checkpoint.storyboardId,
      projectId: checkpoint.projectId,
      scriptId: checkpoint.scriptId,
    })
    .select("id")
    .first();
  if (!storyboard) {
    throw new ProjectImageTaskError(
      409,
      "image_task_storyboard_not_active",
      "分镜已不存在，图片任务已停止",
    );
  }
}

async function loadOwnedReferenceImages(
  task: ProjectImageTaskReservation<unknown>,
  database: Knex,
  readImageBase64: (storageKey: string) => Promise<string>,
): Promise<Array<{ type: "image"; base64: string }>> {
  const ids = task.checkpoint.referenceImageIds;
  if (!ids.length) return [];
  const rows = await database("o_image as image")
    .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
    .where("asset.projectId", task.checkpoint.projectId)
    .where("asset.deletionState", "active")
    .whereIn("image.id", ids)
    .select("image.id", "image.filePath", "image.storageKey");
  const pathById = new Map<number, string>();
  for (const row of rows) {
    const storageKey = String(row.storageKey || row.filePath || "").trim();
    if (storageKey) pathById.set(Number(row.id), storageKey);
  }
  const references: Array<{ type: "image"; base64: string }> = [];
  for (const id of ids) {
    const storageKey = pathById.get(id);
    if (!storageKey) {
      throw new ProjectImageTaskError(
        422,
        "image_task_reference_invalid",
        "分镜参考图不存在或不属于当前项目",
      );
    }
    const base64 = await readImageBase64(storageKey);
    if (!base64) {
      throw new ProjectImageTaskError(
        422,
        "image_task_reference_invalid",
        "分镜参考图无法读取",
      );
    }
    references.push({ type: "image", base64 });
  }
  return references;
}

function providerFailure(error: unknown): {
  status: number;
  code: string;
  message: string;
  pendingReconcile: boolean;
} {
  const pendingReconcile = error instanceof RelayImageError
    ? error.upstreamMayHaveAccepted
    : !(error instanceof BillingError);
  const status = error instanceof BillingError
    ? error.status
    : error instanceof RelayImageError
      ? error.statusCode || 502
      : 502;
  let message = "图片请求已派发上游，但未取得可确认结果";
  if (error instanceof BillingError) {
    message = error.message || "分镜图片计费失败";
  } else if (error instanceof RelayImageError) {
    if (isUnsupportedPortraitImageReference(error)) {
      message = error.message;
    } else if (error.statusCode === 402) {
      message = "工作区余额不足，请充值后重试";
    } else {
      message = pendingReconcile
        ? "图片请求已派发上游，正在等待结果核对"
        : "分镜图片服务拒绝了当前请求";
    }
  }
  const code = pendingReconcile
    ? "image_task_pending_reconcile"
    : isUnsupportedPortraitImageReference(error)
      ? error.reconcileReason!
      : error instanceof BillingError
        ? "image_task_billing_failed"
        : "image_task_upstream_rejected";
  return {
    status,
    code,
    message,
    pendingReconcile,
  };
}

export async function runStoryboardImageTask(
  initialTask: ProjectImageTaskReservation<unknown>,
  runtime: StoryboardImageTaskRunnerRuntime = {},
): Promise<StoryboardImageTaskRunResult> {
  const database = runtime.database || db;
  const resolveCapability =
    runtime.resolveCapability || resolveWorkbenchModelCapability;
  const executeImage = runtime.executeImage || executeRelayImage;
  const persistImages =
    runtime.persistImages || persistGeneratedProjectImages;
  const readImageBase64 =
    runtime.readImageBase64 || ((storageKey: string) =>
      u.oss.getImageBase64(storageKey));
  let task = initialTask;

  if (task.checkpoint.flow !== "storyboard") return "not_runnable";
  if (
    isRecoveryOnlyMode()
    && recoveryOnlyStoryboardWorkDisposition(task.checkpoint).action === "skip"
  ) {
    return "not_runnable";
  }
  if (["succeeded", "failed", "cancelled"].includes(task.checkpoint.phase)) {
    return task.checkpoint.phase === "failed"
      ? "failed"
      : "not_runnable";
  }
  if (
    task.checkpoint.phase === "pending_reconcile"
    && !canRetryProjectImageProvider503(task.checkpoint)
  ) {
    return "pending_reconcile";
  }

  // Once the dispatch claim exists, another worker must never terminalize the
  // task based on mutable project context while the provider call may still be
  // in flight. It may only observe the claim or move an expired claim to the
  // explicit reconciliation state.
  if (task.checkpoint.phase === "dispatching") {
    const claimed = await claimProjectImageTask(task);
    return claimed.checkpoint.phase === "pending_reconcile"
      ? "pending_reconcile"
      : "already_running";
  }

  try {
    await assertRunnableStoryboard(task, database);
  } catch (error) {
    const failure = error instanceof ProjectImageTaskError
      ? error
      : new ProjectImageTaskError(
          500,
          "image_task_storyboard_invalid",
          "分镜图片任务上下文校验失败",
        );
    await failProjectImageTask(task, {
      status: failure.status,
      code: failure.code,
      message: failure.message,
    });
    return "failed";
  }

  if (task.checkpoint.phase === "queued") {
    let capability: WorkbenchModelCapability | null = null;
    let references: Array<{ type: "image"; base64: string }> = [];
    try {
      capability = await resolveCapability({
        workspaceId: task.checkpoint.workspaceId,
        endpointType: "image_generation",
        model: task.checkpoint.model,
      });
      if (!canSubmitCapability(capability)) {
        throw new ProjectImageTaskError(
          422,
          "image_task_model_unavailable",
          capability?.unavailableReason || "项目图片模型当前不可提交",
        );
      }
      if (
        !capabilityValues(capability.qualities).includes(
          task.checkpoint.quality,
        )
      ) {
        throw new ProjectImageTaskError(
          422,
          "image_task_quality_unsupported",
          "项目图片清晰度不受当前模型支持",
        );
      }
      if (
        !capabilityValues(capability.aspectRatios).includes(
          task.checkpoint.ratio,
        )
      ) {
        throw new ProjectImageTaskError(
          422,
          "image_task_ratio_unsupported",
          "项目画面比例不受当前图片模型支持",
        );
      }
      const expectedResolution = resolveVolcengineImageSize(
        task.checkpoint.quality,
        task.checkpoint.ratio,
      );
      if (
        !expectedResolution
        || task.checkpoint.resolution !== expectedResolution
      ) {
        throw new ProjectImageTaskError(
          422,
          "image_task_size_contract_invalid",
          "分镜图片任务缺少已验证的上游尺寸映射，请重新提交",
        );
      }
      references = await loadOwnedReferenceImages(
        task,
        database,
        readImageBase64,
      );
      const referenceCapacity = imageReferenceCapacity(capability.inputSlots);
      if (references.length > referenceCapacity) {
        throw new ProjectImageTaskError(
          422,
          "image_task_reference_invalid",
          referenceCapacity === 0
            ? "当前图片模型未声明参考图能力，无法保持角色和场景一致性"
            : `当前图片模型最多支持 ${referenceCapacity} 张参考图`,
        );
      }
    } catch (error) {
      const failure = error instanceof ProjectImageTaskError
        ? error
        : new ProjectImageTaskError(
            422,
            "image_task_reference_invalid",
            u.error(error).message,
          );
      await failProjectImageTask(task, {
        status: failure.status,
        code: failure.code,
        message: failure.message,
      });
      return "failed";
    }

    const claim = await claimProjectImageTask(task);
    task = claim;
    if (claim.kind !== "claimed") {
      return claim.checkpoint.phase === "pending_reconcile"
        ? "pending_reconcile"
        : "already_running";
    }
    try {
      const result = await executeImage(
        {
          model: capability.id,
          prompt: task.checkpoint.finalPrompt,
          n: 1,
          size: task.checkpoint.resolution,
          response_format: "url",
          ...(references.length
            ? { image: references.map((reference) => reference.base64) }
            : {}),
        },
        {
          workspaceId: task.checkpoint.workspaceId,
          apiKeyId: null,
          principalId: String(task.checkpoint.actorUserId),
          requestId: task.checkpoint.requestId,
          taskId: `project-image:${task.checkpoint.taskId}`,
          idempotencyKey: task.checkpoint.providerIdempotencyKey,
          ...(task.checkpoint.referenceImageIds.length
            ? {
                portraitReferenceScope: {
                  projectId: String(task.checkpoint.projectId),
                  orderedAssetVersionIds: task.checkpoint.referenceImageIds.map(String),
                  requiresPortraitAdmission: false,
                },
              }
            : {}),
        },
      );
      task = await checkpointProjectImageProviderSuccess(
        task,
        claim.claimToken,
        result.data,
      );
    } catch (error) {
      if (error instanceof WorkspaceGenerationQueued) {
        await requeueProjectImageTask(task, claim.claimToken, { status: 202, code: error.code, message: error.message,
          retryAttempt: Number(task.checkpoint.metadata.bindingRetryAttempt || 0) + 1, retryAvailableAt: Date.now() + error.retryAfterMs });
        return "queued";
      }
      if (isRetryablePortraitProviderBindingPending(error)) {
        const schedule = portraitProviderBindingRetrySchedule({
          previousAttempt: Number(
            task.checkpoint.metadata.bindingRetryAttempt || 0,
          ),
        });
        task = await requeueProjectImageTask(task, claim.claimToken, {
          status: error.statusCode || 409,
          code: PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
          message: "图片参考的人像资产正在准备，任务会自动重试",
          retryAttempt: schedule.attempt,
          retryAvailableAt: schedule.retryAvailableAt,
        });
        return "queued";
      }
      console.warn("[storyboard-image-worker] provider request failed", {
        taskId: task.checkpoint.taskId,
        storyboardId: task.checkpoint.storyboardId,
        model: task.checkpoint.model,
        referenceImageCount: task.checkpoint.referenceImageIds.length,
        statusCode: error instanceof RelayImageError ? error.statusCode : null,
        upstreamMayHaveAccepted:
          error instanceof RelayImageError ? error.upstreamMayHaveAccepted : null,
        message: error instanceof Error ? error.message : String(error),
      });
      const failure = providerFailure(error);
      task = await failProjectImageTask(task, {
        ...failure,
        retryableProvider503: error instanceof RelayImageError
          && shouldRetryIdempotentImageRequest(error),
      });
      return task.checkpoint.phase === "pending_reconcile"
        ? "pending_reconcile"
        : "failed";
    }
  }

  if (
    !["provider_succeeded", "persisting"].includes(task.checkpoint.phase)
  ) {
    return "not_runnable";
  }
  const persistenceClaim = await claimProjectImageTaskPersistence(task);
  task = persistenceClaim;
  if (persistenceClaim.kind !== "claimed") return "already_running";
  const providerData = task.checkpoint.providerData;
  if (!providerData?.length) {
    await failProjectImageTask(task, {
      status: 500,
      code: "image_task_provider_result_missing",
      message: "分镜图片任务缺少可恢复的上游结果",
    });
    return "failed";
  }

  const storyboardId = task.checkpoint.storyboardId!;
  const scriptId = task.checkpoint.scriptId!;
  const trackId = Number(task.checkpoint.metadata.trackId || 0) || null;
  const referenceAssetIds = metadataNumberArray(
    task.checkpoint.metadata,
    "referenceAssetIds",
  );
  try {
    const [persisted] = await persistImages({
      workspaceId: task.checkpoint.workspaceId,
      projectId: task.checkpoint.projectId,
      source: "storyboard",
      prompt: task.checkpoint.prompt,
      finalPrompt: task.checkpoint.finalPrompt,
      model: task.checkpoint.model,
      ratio: task.checkpoint.ratio,
      quality: task.checkpoint.quality,
      resolution: task.checkpoint.resolution,
      taskIdPrefix: "storyboard-image",
      taskId: `project-image:${task.checkpoint.taskId}`,
      items: providerData,
      metadata: {
        scriptId,
        storyboardId,
        relatedObjects: {
          prompt: task.checkpoint.finalPrompt,
          size: task.checkpoint.quality,
          aspectRatio: task.checkpoint.ratio,
          projectId: task.checkpoint.projectId,
          scriptId,
          storyboardId,
          trackId,
          type: "分镜图片",
        },
        referenceAssetIds,
        projectImageTaskId: task.checkpoint.taskId,
      },
    }, {
      database,
      onBeforeCommit: async (transaction, pendingAssets) => {
        const pending = pendingAssets[0];
        if (!pending) {
          throw new Error("分镜图片生成成功但未返回可持久化结果");
        }
        const updated = await transaction("o_storyboard")
          .where({
            id: storyboardId,
            projectId: task.checkpoint.projectId,
            scriptId,
          })
          .update({
            filePath: pending.storageKey,
            storageKey: pending.storageKey,
            state: "已完成",
            reason: "",
          });
        if (Number(updated) !== 1) {
          throw new Error("分镜图片生成结果写入失败");
        }
        await completeProjectImageTask<StoryboardImageTaskResponse>(
          task as ProjectImageTaskReservation<StoryboardImageTaskResponse>,
          {
            imageTaskId: task.checkpoint.taskId!,
            storyboardId,
            state: "succeeded",
            assetId: pending.assetId,
            assetVersionId: pending.assetVersionId,
          },
          { database: transaction },
        );
      },
    });
    if (!persisted) {
      throw new Error("分镜图片生成成功但未返回可持久化结果");
    }
    return "succeeded";
  } catch (error) {
    const message = `图片已生成，结果保存待恢复：${u.error(error).message}`;
    try {
      await recordProjectImageTaskPersistenceFailure(
        task,
        persistenceClaim.claimToken,
        message,
      );
    } catch (recordError) {
      if (!(recordError instanceof ProjectImageTaskError)) throw recordError;
    }
    return "already_running";
  }
}

let workerTimer: NodeJS.Timeout | null = null;
let workerRun: Promise<void> | null = null;
let workerStopping = false;
const activeBatches = new Set<Promise<void>>();

/** HTTP accepts durable tasks before executing them; retain their lifetime so
 * a source reload cannot exit while a synchronous provider response is pending. */
export function runStoryboardImageTaskBatch(
  tasks: ProjectImageTaskReservation<unknown>[],
  concurrency: number,
  runtime: StoryboardImageTaskRunnerRuntime = {},
): Promise<void> {
  if (workerStopping) return Promise.resolve();
  const width = Math.max(1, Math.floor(concurrency));
  const batch = (async () => {
    for (let index = 0; index < tasks.length && !workerStopping; index += width) {
      const settled = await Promise.allSettled(tasks.slice(index, index + width).map((task) => runStoryboardImageTask(task, runtime)));
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    }
  })();
  activeBatches.add(batch);
  void batch.finally(() => activeBatches.delete(batch)).catch(() => undefined);
  return batch;
}

export async function drainStoryboardImageTaskBatches(): Promise<void> {
  await Promise.allSettled([...activeBatches]);
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function runStoryboardImageTaskWorkerTick(): Promise<void> {
  if (workerRun) return workerRun;
  const limit = positiveInteger(
    process.env.FANJIN_STORYBOARD_IMAGE_WORKER_BATCH_SIZE,
    10,
    100,
  );
  const concurrency = positiveInteger(
    process.env.FANJIN_STORYBOARD_IMAGE_WORKER_CONCURRENCY,
    3,
    20,
  );
  workerRun = (async () => {
    const recoveryOnly = isRecoveryOnlyMode();
    const tasks = await listRunnableProjectImageTasks({
      flow: "storyboard",
      ...(recoveryOnly
        ? { phases: ["provider_succeeded", "persisting"] as const }
        : {}),
      limit,
    });
    for (let index = 0; index < tasks.length; index += concurrency) {
      const batch = tasks.slice(index, index + concurrency);
      await Promise.all(batch.map(async (task) => {
        try {
          await runStoryboardImageTask(task);
        } catch (error) {
          console.warn("[storyboard-image-worker] task failed", {
            taskId: task.checkpoint.taskId,
            phase: task.checkpoint.phase,
            error:
              error instanceof ProjectImageTaskError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "UNKNOWN_ERROR",
          });
        }
      }));
    }
  })().finally(() => {
    workerRun = null;
  });
  void workerRun.catch((error) => {
    console.warn(
      "[storyboard-image-worker] tick failed",
      error instanceof Error ? error.name : "UNKNOWN_ERROR",
    );
  });
  return workerRun;
}

export function startStoryboardImageTaskWorker(): void {
  if (
    workerTimer
    || process.env.FANJIN_DISABLE_STORYBOARD_IMAGE_GENERATION === "1"
  ) {
    return;
  }
  workerStopping = false;
  void runStoryboardImageTaskWorkerTick();
  const intervalMs = positiveInteger(
    process.env.FANJIN_STORYBOARD_IMAGE_WORKER_INTERVAL_MS,
    2_000,
    60_000,
  );
  workerTimer = setInterval(() => {
    if (!workerStopping) void runStoryboardImageTaskWorkerTick();
  }, intervalMs);
  workerTimer.unref?.();
}

export async function stopStoryboardImageTaskWorker(): Promise<void> {
  workerStopping = true;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await Promise.all([
    workerRun?.catch(() => undefined),
    drainStoryboardImageTaskBatches(),
  ]);
}
