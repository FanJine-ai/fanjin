import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { BillingError } from "@/lib/billing";
import {
  persistGeneratedProjectImages,
  persistGeneratedWorkspaceImages,
} from "@/lib/generatedImagePersistence";
import { ensureInspirationWorkspaceProject } from "@/lib/inspirationWorkspaceProject";
import { executeRelayImage, RelayImageError, type RelayImageRequest } from "@/lib/relayImage";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import {
  isRetryablePortraitProviderBindingPending,
  isUnsupportedPortraitImageReference,
  portraitProviderBindingRetrySchedule,
  PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
} from "@/lib/portraitProviderBindingRetry";
import type { RelayTask } from "@/lib/relay";
import { db } from "@/utils/db";
import {
  parseSeedream45CertificationProbeTaskBinding,
  type Seedream45CertificationProbeTaskBinding,
} from "@/lib/seedream45CertificationProbe";

export type QuickCreateImageAsset = {
  id: string;
  mediaAssetId: string;
  assetId: number | null;
  assetVersionId: number | null;
  taskId: string;
  url: string;
  assetType: "image";
  model: string;
  prompt: string;
  createdAt: number;
};

export type QuickCreateImageTaskResult = {
  taskId: string;
  requestId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  model: string;
  count: number;
  assets: QuickCreateImageAsset[];
  errorReason?: string;
};

type QueueQuickCreateImageTaskInput = {
  workspaceId: string;
  principalId: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  generation: RelayImageRequest;
  metadata: {
    projectId?: number;
    prompt: string;
    finalPrompt: string;
    model: string;
    ratio: string;
    quality: string;
    subjects: unknown[];
    skills: unknown[];
    /** Server-resolved canonical order matching generation.image. */
    referenceAssetVersionIds?: string[];
    /** Server-internal only; public handlers never accept this field. */
    seedream45CertificationProbe?: Seedream45CertificationProbeTaskBinding;
  };
};

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return parseObject(value);
  try {
    return parseObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function trustedReferenceAssetVersionIds(metadata: Record<string, unknown>): string[] {
  if (!Array.isArray(metadata.referenceAssetVersionIds)) return [];
  return metadata.referenceAssetVersionIds
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function publicImageFailure(error: unknown): string {
  if (error instanceof BillingError) return error.message || "图片计费失败";
  if (error instanceof RelayImageError) {
    if (error.statusCode === 429) return "图片生成请求过于频繁，请稍后重试";
    if ([400, 413, 415, 422].includes(error.statusCode)) return "图片生成参数不受支持";
    if ([401, 403].includes(error.statusCode)) return "图片生成服务认证失败";
    if (error.statusCode === 404) return "图片生成服务不可用";
  }
  return "图片生成服务暂时不可用";
}

function taskRequestId(input: QueueQuickCreateImageTaskInput, taskId: string): string {
  if (!input.idempotencyKey) return `quick-create-image:${taskId}`;
  const digest = crypto
    .createHash("sha256")
    .update(`${input.workspaceId}\u0000${input.principalId || ""}\u0000${input.idempotencyKey}`)
    .digest("hex");
  return `quick-create-image:${digest}`;
}

export function quickCreateImageAsyncEnabled(): boolean {
  if (process.env.FANJIN_QUICK_CREATE_IMAGE_ASYNC === "0") return false;
  return process.env.NODE_ENV === "prod" || process.env.FANJIN_QUICK_CREATE_IMAGE_ASYNC === "1";
}

export async function queueQuickCreateImageTask(
  input: QueueQuickCreateImageTaskInput,
): Promise<QuickCreateImageTaskResult> {
  const taskId = uuid();
  const scopedRequestId = taskRequestId(input, taskId);
  const existing = await db("o_relay_task").where({ requestId: scopedRequestId }).first();
  if (existing) return formatQuickCreateImageTask(existing);

  const now = Date.now();
  await db("o_relay_task").insert({
    id: taskId,
    apiKeyId: null,
    workspaceId: input.workspaceId,
    projectId: input.metadata.projectId ?? null,
    requestId: scopedRequestId,
    endpointType: "image_generation",
    provider: null,
    channelId: null,
    model: input.generation.model,
    status: "queued",
    requestPayload: JSON.stringify({
      generation: input.generation,
      quickCreate: input.metadata,
    }),
    providerPayload: JSON.stringify({
      identity: {
        subject: input.principalId ? `user:${input.principalId}` : "internal",
        principalId: input.principalId,
        workspaceId: input.workspaceId,
      },
      ingressRequestId: input.requestId,
      execution: { mode: "worker", state: "queued" },
    }),
    providerTaskId: null,
    resultPayload: JSON.stringify({ assets: [] }),
    errorMessage: null,
    quotaReserved: 0,
    apiQuotaReserved: 0,
    costMicros: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    heartbeatAt: null,
    createTime: now,
    updateTime: now,
    submittedAt: null,
    completedAt: null,
  });
  return {
    taskId,
    requestId: scopedRequestId,
    status: "queued",
    model: input.generation.model,
    count: 0,
    assets: [],
  };
}

export function formatQuickCreateImageTask(row: Record<string, any>): QuickCreateImageTaskResult {
  const resultPayload = parseJson(row.resultPayload);
  const assets = Array.isArray(resultPayload.assets)
    ? resultPayload.assets.filter((item): item is QuickCreateImageAsset => Boolean(
      item && typeof item === "object" && typeof item.id === "string" && typeof item.url === "string",
    ))
    : [];
  const rawStatus = String(row.status || "queued");
  const status = rawStatus === "succeeded"
    ? "succeeded"
    : rawStatus === "failed" || rawStatus === "cancelled"
      ? "failed"
      : rawStatus === "running"
        ? "running"
        : "queued";
  return {
    taskId: String(row.id),
    requestId: row.requestId == null ? null : String(row.requestId),
    status,
    model: String(row.model || ""),
    count: assets.length,
    assets,
    ...(status === "failed" ? { errorReason: String(row.errorMessage || "图片生成失败") } : {}),
  };
}

export async function getQuickCreateImageTask(
  taskId: string,
  workspaceId: string,
): Promise<QuickCreateImageTaskResult | null> {
  const row = await db("o_relay_task").where({
    id: taskId,
    workspaceId,
    endpointType: "image_generation",
  }).first();
  if (!row) return null;
  const quickCreate = parseObject(parseJson(row.requestPayload).quickCreate);
  if (!quickCreate.model) return null;
  return formatQuickCreateImageTask(row);
}

export async function processQuickCreateImageTask(task: RelayTask): Promise<RelayTask> {
  const payload = task.requestPayload;
  const generation = parseObject(payload.generation) as unknown as RelayImageRequest;
  const metadata = parseObject(payload.quickCreate);
  const providerPayload = task.providerPayload || {};
  const identity = parseObject(providerPayload.identity);
  const priorExecution = parseObject(providerPayload.execution);
  const referenceAssetVersionIds = trustedReferenceAssetVersionIds(metadata);
  const rawCertificationProbe = metadata.seedream45CertificationProbe;
  const certificationProbe = parseSeedream45CertificationProbeTaskBinding(
    rawCertificationProbe,
  );
  const submittedAt = Date.now();

  const retryAvailableAt = Number(priorExecution.retryAvailableAt || 0);
  if (
    priorExecution.state === "retry_wait"
    && Number.isFinite(retryAvailableAt)
    && retryAvailableAt > submittedAt
  ) {
    return task;
  }

  if (!task.workspaceId || !generation.model || !generation.prompt || !metadata.model) {
    await db("o_relay_task").where({ id: task.id }).update({
      status: "failed",
      errorMessage: "图片异步任务数据不完整",
      updateTime: submittedAt,
      completedAt: submittedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: submittedAt,
    });
    return { ...task, status: "failed", errorMessage: "图片异步任务数据不完整", completedAt: submittedAt };
  }
  if (rawCertificationProbe && !certificationProbe) {
    await db("o_relay_task").where({ id: task.id }).update({
      status: "failed",
      errorMessage: "Seedream 4.5 certification probe binding is invalid",
      updateTime: submittedAt,
      completedAt: submittedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: submittedAt,
    });
    return {
      ...task,
      status: "failed",
      errorMessage: "Seedream 4.5 certification probe binding is invalid",
      completedAt: submittedAt,
    };
  }

  await db("o_relay_task").where({ id: task.id }).update({
    status: "running",
    submittedAt: task.submittedAt || submittedAt,
    providerPayload: JSON.stringify({
      ...providerPayload,
      execution: {
        ...priorExecution,
        mode: "worker",
        state: "running",
        startedAt: submittedAt,
      },
    }),
    updateTime: submittedAt,
    heartbeatAt: submittedAt,
  });

  try {
    const result = await executeRelayImage(
      { ...generation, provider: task.provider || generation.provider },
      {
        workspaceId: task.workspaceId,
        apiKeyId: null,
        principalId: identity.principalId == null ? null : String(identity.principalId),
        taskId: task.id,
        requestId: task.id,
        idempotencyKey: `quick-create-image:${task.id}`,
        ...(certificationProbe
          ? {
              seedream45CertificationProbe: certificationProbe,
              onBeforeProviderDispatchCommit: async (boundary, transaction) => {
                if (
                  boundary.provider !== certificationProbe.permit.provider
                  || boundary.channelId !== certificationProbe.permit.channelId
                  || !boundary.requestId
                ) throw new Error("SEEDREAM45_CERTIFICATION_PROBE_DISPATCH_BINDING_MISMATCH");
                const affected = await transaction("o_relay_task")
                  .where({
                    id: task.id,
                    workspaceId: task.workspaceId,
                    endpointType: "image_generation",
                    model: certificationProbe.permit.model,
                    status: "running",
                  })
                  .update({
                    provider: boundary.provider,
                    channelId: boundary.channelId,
                    // The same immutable correlation id is sent to the
                    // provider as Idempotency-Key and X-Request-Id before the
                    // POST. A succeeded task therefore carries real provider
                    // acceptance evidence without inventing an upstream id.
                    providerTaskId: boundary.requestId,
                    updateTime: boundary.dispatchStartedAt,
                  });
                if (Number(affected) !== 1) {
                  throw new Error("SEEDREAM45_CERTIFICATION_PROBE_TASK_FENCE_LOST");
                }
              },
            }
          : {}),
        ...(referenceAssetVersionIds.length
          ? {
              portraitReferenceScope: {
                projectId: String(task.projectId ?? metadata.projectId ?? ""),
                orderedAssetVersionIds: referenceAssetVersionIds,
                requiresPortraitAdmission: false,
              },
            }
          : {}),
      },
    );
    const now = Date.now();
    try {
      const projectId = Number(task.projectId ?? metadata.projectId ?? 0);
      const actorUserId = Number(identity.principalId || 0);
      const persistenceInput = {
        workspaceId: task.workspaceId,
        source: "quick-create",
        prompt: String(metadata.prompt || ""),
        finalPrompt: String(metadata.finalPrompt || generation.prompt || ""),
        model: String(metadata.model),
        ratio: String(metadata.ratio || ""),
        quality: String(metadata.quality || ""),
        resolution: String(generation.size || ""),
        taskIdPrefix: "quick-image",
        taskId: task.id,
        items: result.data,
        metadata,
        ...(Number.isSafeInteger(actorUserId) && actorUserId > 0 ? { actorUserId } : {}),
      };
      const completeTask = async (
        trx: Knex.Transaction,
        pendingAssets: Array<{
          mediaAssetId: string;
          assetId: number | null;
          assetVersionId: number | null;
          taskId: string;
          url: string;
          assetType: "image";
          model: string;
          prompt: string;
          createdAt: number;
        }>,
      ) => {
        const assets: QuickCreateImageAsset[] = pendingAssets.map((asset) => ({
          id: asset.mediaAssetId,
          mediaAssetId: asset.mediaAssetId,
          assetId: asset.assetId,
          assetVersionId: asset.assetVersionId,
          taskId: asset.taskId,
          url: asset.url,
          assetType: asset.assetType,
          model: asset.model,
          prompt: asset.prompt,
          createdAt: asset.createdAt,
        }));
        await trx("o_relay_task").where({ id: task.id }).update({
          status: "succeeded",
          resultPayload: JSON.stringify({ assets, count: assets.length }),
          errorMessage: null,
          updateTime: now,
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
        });
      };
      if (Number.isSafeInteger(projectId) && projectId > 0) {
        await persistGeneratedProjectImages({
          ...persistenceInput,
          projectId,
        }, {
          database: db,
          onBeforeCommit: completeTask,
        });
      } else if (Number.isSafeInteger(actorUserId) && actorUserId > 0) {
        const inspirationProject = await ensureInspirationWorkspaceProject({
          database: db,
          workspaceId: task.workspaceId,
          userId: actorUserId,
          imageModel: String(metadata.model),
          imageQuality: String(metadata.quality || ""),
          videoRatio: String(metadata.ratio || "16:9"),
        });
        await persistGeneratedProjectImages({
          ...persistenceInput,
          projectId: inspirationProject.id,
        }, {
          database: db,
          onBeforeCommit: completeTask,
        });
      } else {
        await persistGeneratedWorkspaceImages(persistenceInput, {
          database: db,
          onBeforeCommit: completeTask,
        });
      }
    } catch (assetError) {
      console.error(
        "[quick-create-image] asset persistence failed after provider billing; no automatic refund",
        task.id,
        assetError,
      );
      throw assetError;
    }
  } catch (error) {
    const failedAt = Date.now();
    if (isRetryablePortraitProviderBindingPending(error)) {
      const schedule = portraitProviderBindingRetrySchedule({
        previousAttempt: Number(priorExecution.bindingRetryAttempt || 0),
        now: failedAt,
      });
      await db("o_relay_task").where({ id: task.id }).update({
        status: "queued",
        providerPayload: JSON.stringify({
          ...providerPayload,
          execution: {
            mode: "worker",
            state: "retry_wait",
            code: PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
            bindingRetryAttempt: schedule.attempt,
            retryAvailableAt: schedule.retryAvailableAt,
            retryAfterMs: schedule.retryAfterMs,
            queuedAt: failedAt,
          },
        }),
        errorMessage: "图片参考的人像资产正在准备，任务会自动重试",
        submittedAt: task.submittedAt,
        updateTime: failedAt,
        completedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: failedAt,
      });
      const queued = await db("o_relay_task").where({ id: task.id }).first();
      return queued ? {
        ...task,
        ...queued,
        requestPayload: parseJson(queued.requestPayload),
        providerPayload: parseJson(queued.providerPayload),
        resultPayload: parseJson(queued.resultPayload),
      } : task;
    }
    const publicMessage = publicImageFailure(error);
    await db("o_relay_task").where({ id: task.id }).update({
      status: "failed",
      providerPayload: JSON.stringify({
        ...providerPayload,
        execution: {
          mode: "worker",
          state: "failed",
          ...(isUnsupportedPortraitImageReference(error)
            ? { code: error.reconcileReason }
            : {}),
          failedAt,
          diagnostic: redactSensitiveText(String((error as any)?.message || error || "")),
        },
      }),
      errorMessage: isUnsupportedPortraitImageReference(error)
        ? error.message
        : publicMessage,
      updateTime: failedAt,
      completedAt: failedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: failedAt,
    });
  }
  const row = await db("o_relay_task").where({ id: task.id }).first();
  return row ? {
    ...task,
    ...row,
    requestPayload: parseJson(row.requestPayload),
    providerPayload: parseJson(row.providerPayload),
    resultPayload: parseJson(row.resultPayload),
  } : task;
}
