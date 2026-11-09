import { z } from "zod";

import type { DelegationResourceRef } from "@/agent-runtime/delegationGrantService";
import { isAgentGenerationSubmitEnabled } from "@/agent-runtime/featureFlags";
import {
  agentVideoRetryRequestId,
  relayIdempotentReplayTask,
  relayIdempotencyInProgressGatewayError,
  requireQuotedRelayProvider,
  resolveGenerationTaskRetryAuthorizationEvidence,
  verifyGenerationTaskRetryQuote,
  verifyGenerationTaskRetryQuoteForIdempotentReplay,
} from "@/agent-runtime/tools/packages/generation";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  defineAgentTool,
  type AgentToolAuthorizationContext,
} from "@/agent-runtime/tools/registry";
import {
  cancelOrDeleteRelayTask,
  createRelayTask,
  recoverCanonicalAuthorizedRelayTask,
  type RelayTask,
} from "@/lib/relay";
import { publicRelayStatus } from "@/lib/relayMockPolicy";
import { resolveRelaySubmissionOutcome } from "@/lib/relaySubmissionOutcome";
import { videoInputPricingTierForRequestPayload } from "@/lib/videoInputPricing";
import { preparePublicCanonicalVideoGeneration } from "@/lib/publicVideoGenerationContract";
import { GenerationReferenceError } from "@/lib/generationReferenceError";
import { VIDEO_GENERATION_REQUEST_VERSION, canonicalVideoGenerationRequest, videoGenerationRequestDigest, type VideoGenerationRequest } from "@/lib/videoGenerationContract";

const taskIdSchema = z.string().trim().min(1).max(200);
const publicTaskStatusSchema = z.enum([
  "queued",
  "running",
  "pending_reconcile",
  "succeeded",
  "failed",
  "cancelled",
]);
const taskStatusFilterSchema = publicTaskStatusSchema.nullable().default(null);

const generationTaskSummarySchema = z.object({
  taskId: taskIdSchema,
  projectId: z.number().int().positive(),
  generationType: z.enum(["image", "video", "video_upscale", "other"]),
  model: z.string().min(1).nullable(),
  status: publicTaskStatusSchema,
  requestId: z.string().min(1).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  message: z.string().min(1).nullable(),
}).strict();

const generationTaskAssetSchema = z.object({
  mediaAssetId: z.string().min(1),
  assetId: z.number().int().positive().nullable(),
  assetVersionId: z.number().int().positive().nullable(),
  type: z.enum(["image", "video", "audio", "file"]),
  url: z.string().min(1),
}).strict();

export const generationTaskListInputSchema = z.object({
  status: taskStatusFilterSchema,
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

export const generationTaskListOutputSchema = z.object({
  items: z.array(generationTaskSummarySchema).max(50),
}).strict();

export const generationTaskGetInputSchema = z.object({
  taskId: taskIdSchema,
}).strict();

export const generationTaskGetOutputSchema = generationTaskSummarySchema.extend({
  assets: z.array(generationTaskAssetSchema).max(100),
}).strict();

export const generationTaskCancelInputSchema = generationTaskGetInputSchema;
export const generationTaskCancelOutputSchema = generationTaskGetOutputSchema;

export const generationTaskRetryInputSchema = generationTaskGetInputSchema;
export const generationTaskRetryOutputSchema = z.object({
  retriedFromTaskId: taskIdSchema,
  quoteId: z.string().min(1),
  provider: z.string().min(1),
  task: generationTaskSummarySchema,
}).strict();

type TaskListInput = z.infer<typeof generationTaskListInputSchema>;
type TaskGetInput = z.infer<typeof generationTaskGetInputSchema>;
type TaskRetryInput = z.infer<typeof generationTaskRetryInputSchema>;
type PublicTaskStatus = z.infer<typeof publicTaskStatusSchema>;

type RelayTaskRow = {
  id: unknown;
  workspaceId: unknown;
  projectId: unknown;
  endpointType: unknown;
  model: unknown;
  status: unknown;
  requestId: unknown;
  requestPayload: unknown;
  providerPayload: unknown;
  resultPayload?: unknown;
  createTime: unknown;
  updateTime: unknown;
  completedAt: unknown;
  errorMessage: unknown;
};

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveProjectId(value: unknown): number {
  const projectId = Number(value);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new AgentToolGatewayError(
      "generation_task_record_invalid",
      "生成任务缺少有效项目归属",
      { status: 409 },
    );
  }
  return projectId;
}

function timestamp(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function generationType(endpointType: unknown): "image" | "video" | "video_upscale" | "other" {
  if (endpointType === "image_generation") return "image";
  if (endpointType === "video_generation") return "video";
  if (endpointType === "video_upscale") return "video_upscale";
  return "other";
}

function hasPendingReconcileEvidence(row: RelayTaskRow): boolean {
  const providerPayload = parseObject(row.providerPayload);
  const submission = parseObject(providerPayload.submission);
  const state = String(submission.state || "").toLowerCase();
  return state.includes("pending_reconcile") || state.includes("pending_persist");
}

function publicStatus(row: RelayTaskRow): PublicTaskStatus {
  const raw = String(row.status || "").trim().toLowerCase();
  // A cancellation/failure can be locally terminal while its provider
  // cancellation or GU reservation is still unresolved. Surface the
  // reconciliation state until the persisted submission marker is closed;
  // otherwise the Agent could claim that cancellation released GU and retry
  // the same work while the original attempt remains potentially billable.
  if (raw !== "succeeded" && hasPendingReconcileEvidence(row)) {
    return "pending_reconcile";
  }
  const normalized = publicRelayStatus(raw);
  if (normalized === "enhancing") return "running";
  if (publicTaskStatusSchema.options.includes(normalized as PublicTaskStatus)) {
    return normalized as PublicTaskStatus;
  }
  return ["succeeded", "completed", "success"].includes(normalized)
    ? "succeeded"
    : "failed";
}

function retryPublicModel(row: RelayTaskRow): string | null {
  const payload = parseObject(row.requestPayload);
  const publicModel = typeof payload.model === "string"
    ? payload.model.trim()
    : "";
  if (publicModel) return publicModel;
  return typeof row.model === "string" && row.model.trim()
    ? row.model.trim()
    : null;
}

async function prepareRetryVideoRequest(row: RelayTaskRow, context: AgentToolAuthorizationContext, model: string) {
  const stored = parseObject(parseObject(parseObject(row.resultPayload).internal).canonicalVideoGeneration);
  if (!stored.request || typeof stored.digest !== "string") {
    throw new AgentToolGatewayError("generation_task_canonical_request_missing",
      "原任务缺少规范化视频请求，无法安全重试。请重新选择原素材并创建新的生成请求。", { status: 409 });
  }
  let request: VideoGenerationRequest;
  try {
    // Check the persisted version before normalization replaces it with the current one.
    if (parseObject(stored.request).version !== VIDEO_GENERATION_REQUEST_VERSION) {
      throw new Error("canonical version mismatch");
    }
    request = canonicalVideoGenerationRequest(stored.request as VideoGenerationRequest);
    if (videoGenerationRequestDigest(request) !== stored.digest) throw new Error("canonical digest mismatch");
  } catch {
    throw new AgentToolGatewayError("generation_task_canonical_request_invalid",
      "原任务的规范化视频请求校验失败，无法安全重试。请重新创建生成请求。", { status: 409 });
  }
  try {
    // The shared preparer re-checks current actor permissions, policy, URLs and
    // the selected adapter on the Gateway connection. Never copy old bindings.
    return await preparePublicCanonicalVideoGeneration({ workspaceId: context.workspaceId,
      projectId: context.projectId, database: context.database, actorUserId: context.actorUserId, model, request });
  } catch (error) {
    if (error instanceof GenerationReferenceError) {
      throw new AgentToolGatewayError(error.code, error.message, { status: error.status });
    }
    throw error;
  }
}

function safeMessage(row: RelayTaskRow, status: PublicTaskStatus): string | null {
  if (status === "failed") return "生成任务执行失败";
  if (status === "cancelled") return "生成任务已取消";
  if (status === "pending_reconcile") return "生成结果正在核对，请勿重复提交";
  return null;
}

function taskSummary(row: RelayTaskRow) {
  const status = publicStatus(row);
  return {
    taskId: String(row.id),
    projectId: positiveProjectId(row.projectId),
    generationType: generationType(row.endpointType),
    model: retryPublicModel(row),
    status,
    requestId: typeof row.requestId === "string" && row.requestId.trim()
      ? row.requestId.trim()
      : null,
    createdAt: timestamp(row.createTime),
    updatedAt: timestamp(row.updateTime),
    completedAt: row.completedAt == null ? null : timestamp(row.completedAt),
    message: safeMessage(row, status),
  };
}

async function taskRows(
  context: AgentToolAuthorizationContext,
  input: TaskListInput,
): Promise<RelayTaskRow[]> {
  const rows = await context.database("o_relay_task")
    .where({
      workspaceId: context.workspaceId,
      projectId: context.projectId,
    })
    .orderBy("createTime", "desc")
    .limit(Math.max(input.limit * 4, 50));
  const filtered = input.status
    ? rows.filter((row) => publicStatus(row as RelayTaskRow) === input.status)
    : rows;
  return filtered.slice(0, input.limit) as RelayTaskRow[];
}

async function requireTaskRow(
  context: AgentToolAuthorizationContext,
  taskId: string,
): Promise<RelayTaskRow> {
  const row = await context.database("o_relay_task")
    .where({
      id: taskId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
    })
    .first();
  if (!row) {
    throw new AgentToolGatewayError(
      "generation_task_not_found",
      "生成任务不存在或不属于当前项目",
      { status: 404 },
    );
  }
  positiveProjectId(row.projectId);
  return row as RelayTaskRow;
}

function taskRefs(rows: readonly RelayTaskRow[]): DelegationResourceRef[] {
  return rows.map((row) => ({
    type: "taskIds",
    id: String(row.id),
  }));
}

async function taskAssets(
  context: AgentToolAuthorizationContext,
  taskId: string,
) {
  const rows = await context.database("o_media_asset")
    .where({
      taskId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
    })
    .orderBy("createTime", "asc")
    .limit(100);
  return rows.flatMap((row) => {
    const type = String(row.assetType || "");
    const url = String(row.url || "").trim();
    if (!["image", "video", "audio", "file"].includes(type) || !url) return [];
    const metadata = parseObject(row.metadata);
    const projectAsset = parseObject(metadata.projectAsset);
    const assetId = Number(projectAsset.assetId ?? metadata.assetId);
    const assetVersionId = Number(projectAsset.assetVersionId ?? metadata.assetVersionId);
    return [{
      mediaAssetId: String(row.id),
      assetId: Number.isSafeInteger(assetId) && assetId > 0 ? assetId : null,
      assetVersionId: Number.isSafeInteger(assetVersionId) && assetVersionId > 0
        ? assetVersionId
        : null,
      type: type as "image" | "video" | "audio" | "file",
      url,
    }];
  });
}

function relayTaskFromRow(row: RelayTaskRow): RelayTask {
  return {
    id: String(row.id),
    apiKeyId: null,
    workspaceId: String(row.workspaceId || "") || null,
    projectId: positiveProjectId(row.projectId),
    requestId: typeof row.requestId === "string" ? row.requestId : null,
    endpointType: String(row.endpointType) as RelayTask["endpointType"],
    provider: null,
    channelId: null,
    model: typeof row.model === "string" ? row.model : null,
    status: String(row.status) as RelayTask["status"],
    requestPayload: parseObject(row.requestPayload),
    providerPayload: parseObject(row.providerPayload),
    providerTaskId: null,
    resultPayload: parseObject(row.resultPayload),
    errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : null,
    quotaReserved: 0,
    apiQuotaReserved: 0,
    costMicros: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    heartbeatAt: null,
    createTime: timestamp(row.createTime),
    updateTime: timestamp(row.updateTime),
    submittedAt: null,
    completedAt: row.completedAt == null ? null : timestamp(row.completedAt),
  };
}

function relayTaskRow(task: RelayTask): RelayTaskRow {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    endpointType: task.endpointType,
    model: task.model,
    status: task.status,
    requestId: task.requestId,
    requestPayload: task.requestPayload,
    providerPayload: task.providerPayload,
    resultPayload: task.resultPayload,
    createTime: task.createTime,
    updateTime: task.updateTime,
    completedAt: task.completedAt,
    errorMessage: task.errorMessage,
  };
}

async function taskDetail(
  context: AgentToolAuthorizationContext,
  row: RelayTaskRow,
) {
  return {
    ...taskSummary(row),
    assets: await taskAssets(context, String(row.id)),
  };
}

export const GENERATION_TASK_LIST_TOOL = defineAgentTool({
  manifest: {
    name: "generation.task.list",
    version: "1.0.0",
    displayName: "列出生成任务",
    description: "读取当前项目真实生成任务及持久化状态；用于恢复轮询，不能据此重复提交 pending_reconcile 任务。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A3" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["generation_task"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: generationTaskListInputSchema,
  outputSchema: generationTaskListOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    return { resourceRefs: taskRefs(await taskRows(context, input)) };
  },
  async execute(input, context) {
    return { items: (await taskRows(context, input)).map(taskSummary) };
  },
});

export const GENERATION_TASK_GET_TOOL = defineAgentTool({
  manifest: {
    name: "generation.task.get",
    version: "1.0.0",
    displayName: "读取生成任务",
    description: "读取当前项目指定生成任务、真实状态和已持久化资产；pending_reconcile 必须继续等待。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A3" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["generation_task", "media_asset", "asset"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: generationTaskGetInputSchema,
  outputSchema: generationTaskGetOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    return { resourceRefs: taskRefs([await requireTaskRow(context, input.taskId)]) };
  },
  async execute(input, context) {
    return taskDetail(context, await requireTaskRow(context, input.taskId));
  },
});

export const GENERATION_TASK_CANCEL_TOOL = defineAgentTool({
  manifest: {
    name: "generation.task.cancel",
    version: "1.0.0",
    displayName: "取消生成任务",
    description: "取消当前项目仍在排队、生成或增强中的真实任务，并按正式计费状态释放或结算 GU。",
    riskClass: "R2",
    availability: { state: "available", sincePhase: "A3" },
    requiredPermissions: ["project:read", "generation:create"],
    resourceTypes: ["generation_task", "billing_ledger"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: generationTaskCancelInputSchema,
  outputSchema: generationTaskCancelOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const row = await requireTaskRow(context, input.taskId);
    const status = publicStatus(row);
    if (!["queued", "running"].includes(status)) {
      throw new AgentToolGatewayError(
        "generation_task_not_cancellable",
        status === "pending_reconcile"
          ? "任务正在核对，暂不能重复取消"
          : "当前任务状态不支持取消",
        { status: 409 },
      );
    }
    return { resourceRefs: taskRefs([row]) };
  },
  async execute(input, context) {
    await requireTaskRow(context, input.taskId);
    const result = await cancelOrDeleteRelayTask(input.taskId, { actorUserId: context.actorUserId });
    if (!result.cancelled || !result.task) {
      throw new AgentToolGatewayError(
        "generation_task_not_cancellable",
        "当前任务状态不支持取消或取消尚未完成",
        { status: 409 },
      );
    }
    return taskDetail(context, relayTaskRow(result.task));
  },
});

export const GENERATION_TASK_RETRY_TOOL = defineAgentTool({
  manifest: {
    name: "generation.task.retry",
    version: "1.0.0",
    displayName: "重试生成任务",
    description: "在用户批准新报价后，为当前项目失败或已取消的视频任务创建一次新的真实任务；原任务保持可审计。",
    riskClass: "R2",
    availability: { state: "available", sincePhase: "A3" },
    requiredPermissions: ["project:read", "generation:create"],
    resourceTypes: ["generation_quote", "generation_task", "billing_ledger"],
    mutatesState: true,
    metered: true,
  },
  inputSchema: generationTaskRetryInputSchema,
  outputSchema: generationTaskRetryOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const row = await requireTaskRow(context, input.taskId);
    const summary = taskSummary(row);
    if (summary.generationType !== "video" || !["failed", "cancelled"].includes(summary.status)) {
      throw new AgentToolGatewayError(
        "generation_task_not_retryable",
        "只有失败或已取消的视频任务可以重试",
        { status: 409 },
      );
    }
    const model = retryPublicModel(row);
    if (!model) {
      throw new AgentToolGatewayError(
        "generation_task_record_invalid",
        "原任务缺少模型信息，不能安全重试",
        { status: 409 },
      );
    }
    const prepared = await prepareRetryVideoRequest(row, context, model);
    const videoInputPricingTier = videoInputPricingTierForRequestPayload(prepared.requestPayload);
    const durationSeconds = Number(prepared.requestPayload.duration);
    const quoteEvidence = await resolveGenerationTaskRetryAuthorizationEvidence({
      model: prepared.model,
      parsedArguments: input,
      context,
      videoInputPricingTier,
      durationSeconds: Number.isSafeInteger(durationSeconds) ? durationSeconds : null,
      resolution: String(prepared.requestPayload.resolution || "") || null,
    });
    return {
      ...quoteEvidence,
      resourceRefs: [...taskRefs([row]), ...prepared.canonicalRequest.inputs.map(reference => ({
        type: "assetVersionIds" as const, id: reference.assetVersionId,
      }))],
    };
  },
  async execute(input: TaskRetryInput, context) {
    if (!isAgentGenerationSubmitEnabled()) {
      throw new AgentToolGatewayError(
        "generation_submit_disabled",
        "Agent 付费生成提交能力当前未开放",
        { status: 503 },
      );
    }
    const row = await requireTaskRow(context, input.taskId);
    const summary = taskSummary(row);
    if (summary.generationType !== "video" || !["failed", "cancelled"].includes(summary.status)) {
      throw new AgentToolGatewayError(
        "generation_task_not_retryable",
        "只有失败或已取消的视频任务可以重试",
        { status: 409 },
      );
    }
    const model = retryPublicModel(row);
    if (!model) {
      throw new AgentToolGatewayError(
        "generation_task_record_invalid",
        "原任务缺少模型信息，不能安全重试",
        { status: 409 },
      );
    }
    const prepared = await prepareRetryVideoRequest(row, context, model);
    const videoInputPricingTier = videoInputPricingTierForRequestPayload(prepared.requestPayload);
    const durationSeconds = Number(prepared.requestPayload.duration);
    const trustedBindings = {
      trustedCanonicalVideoGeneration: { request: prepared.canonicalRequest, digest: prepared.canonicalDigest },
      trustedVideoAssetPolicyEvidence: prepared.trustedVideoAssetPolicyEvidence,
      ...(prepared.relayAdapterBinding ? { trustedVideoProviderAdapter: prepared.relayAdapterBinding } : {}),
    };
    let quote = await verifyGenerationTaskRetryQuoteForIdempotentReplay({
      model: prepared.model,
      parsedArguments: input,
      context,
      videoInputPricingTier,
      durationSeconds: Number.isSafeInteger(durationSeconds) ? durationSeconds : null,
      resolution: String(prepared.requestPayload.resolution || "") || null,
    });
    const relayInput = {
      endpointType: "video_generation" as const,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      actorUserId: context.actorUserId,
      principalId: `agent:${context.actorUserId}`,
      provider: requireQuotedRelayProvider(quote.provider),
      requestId: agentVideoRetryRequestId(quote.quoteId),
      model: prepared.model,
      requestPayload: prepared.requestPayload,
    };
    const relayOptions = () => ({
      ...trustedBindings,
      trustedVideoBillingAuthorization: { ...quote.videoBillingAuthorization, operation: "retry" as const },
    });
    let task;
    try {
      const replay = await recoverCanonicalAuthorizedRelayTask(relayInput, relayOptions());
      if (replay) {
        task = relayIdempotentReplayTask(replay);
      } else {
        quote = await verifyGenerationTaskRetryQuote({
          model: prepared.model,
          parsedArguments: input,
          context,
          videoInputPricingTier,
          durationSeconds: Number.isSafeInteger(durationSeconds) ? durationSeconds : null,
          resolution: String(prepared.requestPayload.resolution || "") || null,
        });
        try {
          ({ task } = await createRelayTask(relayInput, relayOptions()));
        } catch (error) {
          // Another executor can persist this quote after the read-only lookup.
          // Recover its immutable request (including the first signed URLs),
          // but never replay a create or relax request-wide idempotency checks.
          if ((error as { code?: string })?.code !== "idempotency_conflict") throw error;
          const raced = await recoverCanonicalAuthorizedRelayTask(relayInput, relayOptions());
          if (!raced) throw error;
          task = relayIdempotentReplayTask(raced);
        }
      }
    } catch (error) {
      const inProgress = relayIdempotencyInProgressGatewayError(error);
      if (inProgress) throw inProgress;
      throw error;
    }
    const outcome = resolveRelaySubmissionOutcome({
      status: task.status,
      providerPayload: task.providerPayload,
    });
    if (!outcome.accepted && !outcome.succeeded) {
      throw new AgentToolGatewayError(
        outcome.code || "generation_task_retry_failed",
        outcome.message || "生成任务重试未进入上游队列",
        { status: 502 },
      );
    }
    return {
      retriedFromTaskId: input.taskId,
      quoteId: quote.quoteId,
      provider: quote.provider,
      task: taskSummary({
        ...relayTaskRow(task),
        status: outcome.status,
      }),
    };
  },
});

export const GENERATION_TASK_TOOLS = [
  GENERATION_TASK_LIST_TOOL,
  GENERATION_TASK_GET_TOOL,
  GENERATION_TASK_CANCEL_TOOL,
  GENERATION_TASK_RETRY_TOOL,
] as const;
