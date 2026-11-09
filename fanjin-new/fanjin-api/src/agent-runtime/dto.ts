import { z } from "zod";
import type { AgentEvent, AgentMessage, AgentRun, AgentStep, AgentThread } from "@/agent-runtime/types";
import {
  agentMessageReferenceRefsMatchContextSnapshot,
  publicAgentMessageContextSnapshot,
  publicAgentMessageContextUsage,
} from "@/agent-runtime/messageContextSnapshot";
import {
  generationImageSubmitOutputSchema,
  generationVideoSubmitOutputSchema,
} from "@/agent-runtime/generationSubmitContract";
import { planPresentOutputSchema } from "@/agent-runtime/tools/packages/plan";

function publicError(value: Record<string, unknown> | null): { code: string; message: string } | null {
  if (!value) return null;
  const code = typeof value.code === "string" ? value.code : "agent_run_failed";
  if (["side_effect_reconciliation_required", "model_outcome_uncertain"].includes(code)) {
    return { code, message: "执行连接已中断，暂未确认结果；请查询原任务，费用记录可在账单中查看，不会重复提交" };
  }
  const message = typeof value.message === "string" ? value.message : "Agent 运行失败";
  return { code, message };
}

export function toAgentThreadDto(thread: AgentThread) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    sessionId: thread.sessionId,
    title: thread.title,
    status: thread.status,
    activeRootRunId: thread.activeRootRunId,
    messageSeq: thread.messageSeq,
    eventSeq: thread.eventSeq,
    lastMessageAt: thread.lastMessageAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
  };
}

export function toAgentMessageDto(message: AgentMessage) {
  const metadata = message.metadata
    && typeof message.metadata === "object"
    && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {};
  return {
    id: message.id,
    threadId: message.threadId,
    runId: message.runId,
    replyToId: message.replyToId,
    clientMessageId: message.clientMessageId,
    seq: message.seq,
    role: message.role,
    agentRole: message.agentRole,
    status: message.status,
    content: message.content,
    referenceRefs: message.referenceRefs,
    contextSnapshot: agentMessageReferenceRefsMatchContextSnapshot(
      message.referenceRefs,
      metadata.contextSnapshot,
    )
      ? publicAgentMessageContextSnapshot(metadata.contextSnapshot)
      : null,
    contextUsage: message.role === "assistant"
      ? publicAgentMessageContextUsage(metadata.contextUsage)
      : null,
    error: publicError(message.error),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    completedAt: message.completedAt,
  };
}

export function toAgentRunDto(run: AgentRun) {
  const policy = run.policySnapshot
    && typeof run.policySnapshot === "object"
    && !Array.isArray(run.policySnapshot)
    ? run.policySnapshot as Record<string, unknown>
    : {};
  const chatModel = policy.chatModel
    && typeof policy.chatModel === "object"
    && !Array.isArray(policy.chatModel)
    ? policy.chatModel as Record<string, unknown>
    : {};
  const chatModelId = typeof chatModel.id === "string"
    && chatModel.id.trim()
    && chatModel.id.trim().length <= 100
    ? chatModel.id.trim()
    : null;
  const skillRefs = Array.isArray(policy.skillRefs)
    ? policy.skillRefs.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const ref = value as Record<string, unknown>;
        const key = typeof ref.key === "string" ? ref.key.trim() : "";
        const version = typeof ref.version === "string" ? ref.version.trim() : "";
        return key && key.length <= 100 && version && version.length <= 50
          ? [{ key, version }]
          : [];
      }).slice(0, 5)
    : [];
  return {
    id: run.id,
    threadId: run.threadId,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    kind: run.kind,
    agentRole: run.agentRole,
    triggerMessageId: run.triggerMessageId,
    responseMessageId: run.responseMessageId,
    status: run.status,
    waitType: run.waitType,
    wakeAt: run.wakeAt,
    sideEffectsCommitted: run.sideEffectsCommitted,
    cancelRequestedAt: run.cancelRequestedAt,
    cancelReason: run.cancelReason,
    selectionSnapshot: {
      chatModelId,
      skillRefs,
    },
    error: publicError(run.error),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

const PLAN_PRESENT_TOOL_NAME = "plan.present";
const GENERATION_IMAGE_SUBMIT_TOOL_NAME = "generation.image.submit";
const GENERATION_VIDEO_SUBMIT_TOOL_NAME = "generation.video.submit";
const publicGenerationReviewSchema = z.object({
  reviewId: z.string().min(1),
  engine: z.string().min(1),
  verdict: z.enum(["pass", "attention"]),
}).strict().nullable();
const publicImageGenerationReceiptSchema = z.object({
  generationType: z.literal("image"),
  status: z.enum(["succeeded", "failed", "unavailable"]),
  code: z.string().min(1).nullable(),
  message: z.string().min(1).nullable(),
  quoteId: z.string().min(1).nullable(),
  model: z.string().min(1),
  units: z.number().int().positive(),
  size: z.string().min(1).nullable(),
  assets: z.array(z.object({
    mediaAssetId: z.string().min(1),
    assetId: z.number().int().positive(),
    assetVersionId: z.number().int().positive(),
    url: z.string().min(1),
    mirrored: z.boolean(),
  }).strict()).max(10),
  review: publicGenerationReviewSchema,
}).strict();
const publicVideoGenerationReceiptSchema = z.object({
  generationType: z.literal("video"),
  status: z.enum(["succeeded", "failed", "unavailable"]),
  code: z.string().min(1).nullable(),
  message: z.string().min(1).nullable(),
  quoteId: z.string().min(1).nullable(),
  model: z.string().min(1),
  units: z.literal(1),
  task: z.object({
    taskId: z.string().min(1),
    status: z.string().min(1),
  }).strict().nullable(),
  assetVersionId: z.number().int().positive().nullable(),
  review: publicGenerationReviewSchema,
}).strict();

/**
 * Whitelist exposure of the plan.present R0 echo. Everything else inside
 * Step outputRefs stays server-side; only a payload that passes the tool's
 * own output schema is exposed, and only for the plan.present tool Step.
 */
function publicPlanValue(value: unknown) {
  const parsed = planPresentOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function publicStepPlan(step: AgentStep) {
  if (step.kind !== "tool" || step.toolName !== PLAN_PRESENT_TOOL_NAME) return null;
  if (!Array.isArray(step.outputRefs)) return null;
  const inline = step.outputRefs.find((ref) => (
    ref && typeof ref === "object"
    && (ref as Record<string, unknown>).type === "inline_tool_result"
    && (ref as Record<string, unknown>).toolName === PLAN_PRESENT_TOOL_NAME
  ));
  return inline ? publicPlanValue((inline as Record<string, unknown>).value) : null;
}

type PublicGenerationReceipt =
  | z.infer<typeof publicImageGenerationReceiptSchema>
  | z.infer<typeof publicVideoGenerationReceiptSchema>;

function publicGenerationReview(value: unknown): PublicGenerationReceipt["review"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.reviewId !== "string"
    || typeof source.engine !== "string"
    || (source.verdict !== "pass" && source.verdict !== "attention")) return null;
  return {
    reviewId: source.reviewId,
    engine: source.engine,
    verdict: source.verdict,
  };
}

/**
 * Project-scoped generation proof for the authenticated Agent UI and live
 * acceptance verifier. The complete tool output remains private: this
 * projection deliberately omits provider details, upstream request ids and
 * every unrecognized field.
 */
function publicGenerationReceiptValue(
  toolName: unknown,
  value: unknown,
): PublicGenerationReceipt | null {
  if (toolName === GENERATION_IMAGE_SUBMIT_TOOL_NAME) {
    const publicValue = publicImageGenerationReceiptSchema.safeParse(value);
    if (publicValue.success) return publicValue.data;
    const parsed = generationImageSubmitOutputSchema.safeParse(value);
    if (!parsed.success) return null;
    return {
      generationType: "image",
      status: parsed.data.status,
      code: parsed.data.code,
      message: parsed.data.message,
      quoteId: parsed.data.quoteId,
      model: parsed.data.model,
      units: parsed.data.units,
      size: parsed.data.size,
      assets: parsed.data.assets.map((asset) => ({
        mediaAssetId: asset.mediaAssetId,
        assetId: asset.assetId,
        assetVersionId: asset.assetVersionId,
        url: asset.url,
        mirrored: asset.mirrored,
      })),
      review: publicGenerationReview(parsed.data.review),
    };
  }
  if (toolName === GENERATION_VIDEO_SUBMIT_TOOL_NAME) {
    const publicValue = publicVideoGenerationReceiptSchema.safeParse(value);
    if (publicValue.success) return publicValue.data;
    const parsed = generationVideoSubmitOutputSchema.safeParse(value);
    if (!parsed.success) return null;
    return {
      generationType: "video",
      status: parsed.data.status,
      code: parsed.data.code,
      message: parsed.data.message,
      quoteId: parsed.data.quoteId,
      model: parsed.data.model,
      units: parsed.data.units,
      task: parsed.data.task
        ? { taskId: parsed.data.task.taskId, status: parsed.data.task.status }
        : null,
      assetVersionId: parsed.data.assetVersionId,
      review: publicGenerationReview(parsed.data.review),
    };
  }
  return null;
}

function publicStepGenerationReceipt(step: AgentStep): PublicGenerationReceipt | null {
  if (step.kind !== "tool"
    || (step.toolName !== GENERATION_IMAGE_SUBMIT_TOOL_NAME
      && step.toolName !== GENERATION_VIDEO_SUBMIT_TOOL_NAME)
    || !Array.isArray(step.outputRefs)) return null;
  const inline = step.outputRefs.find((ref) => (
    ref && typeof ref === "object"
    && (ref as Record<string, unknown>).type === "inline_tool_result"
    && (ref as Record<string, unknown>).toolName === step.toolName
  ));
  return inline
    ? publicGenerationReceiptValue(
        step.toolName,
        (inline as Record<string, unknown>).value,
      )
    : null;
}

export function toAgentStepDto(step: AgentStep) {
  return {
    id: step.id,
    runId: step.runId,
    parentStepId: step.parentStepId,
    seq: step.seq,
    agentRole: step.agentRole,
    kind: step.kind,
    status: step.status,
    toolName: step.toolName,
    error: publicError(step.safeError),
    plan: publicStepPlan(step),
    generationReceipt: publicStepGenerationReceipt(step),
    createdAt: step.createdAt,
    updatedAt: step.updatedAt,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  };
}

const PUBLIC_EVENT_TYPES = new Set([
  "thread.created",
  "message.created",
  "message.completed",
  "message.delta",
  "message.error",
  "message.stopped",
  "run.queued",
  "run.started",
  "run.status",
  "run.requeued",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "step.started",
  "step.completed",
  "step.failed",
  "step.cancelled",
  "step.uncertain",
  "approval.requested",
  "approval.approved",
  "approval.denied",
  "approval.expired",
  "approval.revoked",
]);

function publicStepPayload(value: unknown, event: AgentEvent) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const safeError = source.error && typeof source.error === "object" && !Array.isArray(source.error)
    ? publicError(source.error as Record<string, unknown>)
    : null;
  const optionalTimestamp = (timestamp: unknown): number | null => (
    timestamp == null || !Number.isFinite(Number(timestamp)) ? null : Number(timestamp)
  );
  return {
    id: typeof source.id === "string" ? source.id : event.stepId,
    runId: typeof source.runId === "string" ? source.runId : event.runId,
    parentStepId: typeof source.parentStepId === "string" ? source.parentStepId : null,
    seq: Number.isSafeInteger(Number(source.seq)) ? Number(source.seq) : 0,
    agentRole: typeof source.agentRole === "string" ? source.agentRole : null,
    kind: typeof source.kind === "string" ? source.kind : null,
    status: typeof source.status === "string" ? source.status : null,
    toolName: typeof source.toolName === "string" ? source.toolName : null,
    error: safeError,
    plan: publicPlanValue(source.plan),
    generationReceipt: publicGenerationReceiptValue(source.toolName, source.generationReceipt),
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : event.createdAt,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : event.createdAt,
    startedAt: optionalTimestamp(source.startedAt),
    completedAt: optionalTimestamp(source.completedAt),
  };
}

function publicApprovalQuote(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.currency !== "GU"
    || !Number.isSafeInteger(source.estimatedCostMicros)
    || !Number.isSafeInteger(source.maximumCostMicros)) return null;
  return {
    currency: "GU",
    estimatedCostMicros: Number(source.estimatedCostMicros),
    maximumCostMicros: Number(source.maximumCostMicros),
    ...(typeof source.quoteId === "string" ? { quoteId: source.quoteId } : {}),
    ...(Number.isSafeInteger(source.expiresAt) ? { expiresAt: Number(source.expiresAt) } : {}),
  };
}

function publicApprovalImpactSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.summary !== "string"
    || typeof source.destructive !== "boolean"
    || !Array.isArray(source.affectedResourceRefs)) return null;
  return {
    summary: source.summary,
    affectedResourceRefs: source.affectedResourceRefs.filter((item): item is string => typeof item === "string"),
    destructive: source.destructive,
  };
}

function publicApprovalPayload(value: unknown, event: AgentEvent) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawApproval = source.approval && typeof source.approval === "object" && !Array.isArray(source.approval)
    ? source.approval as Record<string, unknown>
    : {};
  const timestamp = (item: unknown): number | null => Number.isSafeInteger(item) ? Number(item) : null;
  return {
    approval: {
      id: typeof rawApproval.id === "string" ? rawApproval.id : null,
      runId: typeof rawApproval.runId === "string" ? rawApproval.runId : event.runId,
      stepId: typeof rawApproval.stepId === "string" ? rawApproval.stepId : null,
      toolId: typeof rawApproval.toolId === "string" ? rawApproval.toolId : null,
      toolVersion: typeof rawApproval.toolVersion === "string" ? rawApproval.toolVersion : null,
      riskClass: rawApproval.riskClass === "R2" || rawApproval.riskClass === "R3" ? rawApproval.riskClass : null,
      status: typeof rawApproval.status === "string" ? rawApproval.status : null,
      quote: publicApprovalQuote(rawApproval.quote),
      impactSummary: publicApprovalImpactSummary(rawApproval.impactSummary),
      expiresAt: timestamp(rawApproval.expiresAt),
      revision: timestamp(rawApproval.revision),
      decidedAt: timestamp(rawApproval.decidedAt),
      createdAt: timestamp(rawApproval.createdAt),
      updatedAt: timestamp(rawApproval.updatedAt),
    },
  };
}

function publicEventPayload(event: AgentEvent): Record<string, unknown> {
  const source = event.payload;
  if (event.type === "thread.created") {
    return { threadId: event.threadId, projectId: source.projectId };
  }
  if (event.type === "message.delta") {
    // 瞬态增量预览(REVAMP-PLAN 4.1):只对实时订阅方暴露增量文本;
    // 完整正文仍由 message.completed 后的消息快照提供。
    return {
      messageId: event.messageId,
      ...(typeof source.runId === "string" ? { runId: source.runId } : {}),
      ...(Number.isSafeInteger(source.turn) ? { turn: source.turn } : {}),
      ...(typeof source.delta === "string" ? { delta: source.delta } : {}),
    };
  }
  if (event.type.startsWith("message.")) {
    return {
      messageId: event.messageId,
      ...(typeof source.seq === "number" ? { seq: source.seq } : {}),
      ...(typeof source.role === "string" ? { role: source.role } : {}),
      ...(typeof source.status === "string" ? { status: source.status } : {}),
      ...(typeof source.code === "string" ? { code: source.code } : {}),
    };
  }
  if (event.type.startsWith("step.")) {
    return { step: publicStepPayload(source.step, event) };
  }
  if (event.type.startsWith("approval.")) {
    return publicApprovalPayload(source, event);
  }
  return {
    runId: event.runId,
    ...(typeof source.status === "string" ? { status: source.status } : {}),
    ...(typeof source.agentRole === "string" ? { agentRole: source.agentRole } : {}),
    ...(typeof source.attempt === "number" ? { attempt: source.attempt } : {}),
    ...(typeof source.code === "string" ? { code: source.code } : {}),
  };
}

export function toAgentEventDto(event: AgentEvent) {
  if (event.type.startsWith("internal.")) return null;
  if (!PUBLIC_EVENT_TYPES.has(event.type)) return null;
  return {
    id: event.id,
    threadId: event.threadId,
    runId: event.runId,
    messageId: event.messageId,
    stepId: event.stepId,
    seq: event.seq,
    type: event.type,
    payload: publicEventPayload(event),
    createdAt: event.createdAt,
  };
}

/**
 * 瞬态 message.delta 的公开 DTO(REVAMP-PLAN 4.1)。delta 不持久化、不占
 * Thread eventSeq:`seq: null` 是"非持久游标"标记,SSE 路由据此省略 id 行,
 * 保证客户端 Last-Event-ID 只跟随持久事件推进,重连回放语义不被增量污染。
 */
export function toAgentMessageDeltaEventDto(input: {
  threadId: string;
  runId: string;
  messageId: string;
  turn?: number;
  delta: string;
  snapshot?: true;
  createdAt: number;
}) {
  return {
    id: null,
    threadId: input.threadId,
    runId: input.runId,
    messageId: input.messageId,
    stepId: null,
    seq: null,
    type: "message.delta" as const,
    payload: {
      messageId: input.messageId,
      runId: input.runId,
      ...(Number.isSafeInteger(input.turn) ? { turn: input.turn } : {}),
      delta: input.delta,
      ...(input.snapshot ? { snapshot: true as const } : {}),
    },
    createdAt: input.createdAt,
  };
}
export type AgentMessageDeltaEventDto = ReturnType<typeof toAgentMessageDeltaEventDto>;
