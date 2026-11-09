import type {
  AgentRuntimeEvent,
  AgentRuntimeGenerationReceipt,
  AgentRuntimeGenerationReview,
  AgentRuntimeStep,
  AgentRuntimeStepPlan,
  AgentRuntimeStepPlanStep,
  AgentRuntimeStepStatus,
} from "./types";

export type AgentRuntimeStepUiStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting"
  | "uncertain";

const TERMINAL_STATUS_RANK: Readonly<Record<AgentRuntimeStepStatus, number>> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  cancelled: 2,
  awaiting_approval: 1,
  waiting_external: 1,
  uncertain: 2,
};

function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isStepStatus(value: unknown): value is AgentRuntimeStepStatus {
  return value === "queued"
    || value === "running"
    || value === "succeeded"
    || value === "failed"
    || value === "cancelled"
    || value === "awaiting_approval"
    || value === "waiting_external"
    || value === "uncertain";
}

function preferredStep(current: AgentRuntimeStep, candidate: AgentRuntimeStep): AgentRuntimeStep {
  if (candidate.updatedAt > current.updatedAt) return candidate;
  if (candidate.updatedAt < current.updatedAt) return current;
  const candidateRank = TERMINAL_STATUS_RANK[candidate.status];
  const currentRank = TERMINAL_STATUS_RANK[current.status];
  if (candidateRank > currentRank) return candidate;
  if (candidateRank < currentRank) return current;
  if ((candidate.completedAt ?? 0) > (current.completedAt ?? 0)) return candidate;
  return current;
}

/**
 * The database guarantees one Step per run-local seq, but replayed pages and
 * SSE reconnects can deliver the same record repeatedly. Dedupe by either
 * stable id or seq, keep the freshest lifecycle state, then sort by seq so an
 * out-of-order transport never changes the visual execution order.
 */
export function mergeAgentRuntimeSteps(
  current: readonly AgentRuntimeStep[],
  incoming: readonly AgentRuntimeStep[],
): AgentRuntimeStep[] {
  const byId = new Map<string, AgentRuntimeStep>();
  const bySeq = new Map<number, AgentRuntimeStep>();

  for (const candidate of [...current, ...incoming]) {
    if (!candidate?.id || !Number.isSafeInteger(candidate.seq) || candidate.seq < 1) continue;
    const existing = byId.get(candidate.id) || bySeq.get(candidate.seq);
    const winner = existing ? preferredStep(existing, candidate) : candidate;
    if (existing && existing.id !== winner.id) byId.delete(existing.id);
    if (existing && existing.seq !== winner.seq) bySeq.delete(existing.seq);
    byId.set(winner.id, winner);
    bySeq.set(winner.seq, winner);
  }

  return Array.from(byId.values())
    .filter((step) => bySeq.get(step.seq)?.id === step.id)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

export function agentRuntimeStepUiStatus(status: AgentRuntimeStepStatus): AgentRuntimeStepUiStatus {
  if (status === "succeeded") return "completed";
  if (status === "awaiting_approval" || status === "waiting_external") return "waiting";
  return status;
}

export function agentRuntimeStepLabel(step: AgentRuntimeStep): string {
  if (step.kind === "delegation") {
    if (step.status === "succeeded") return "专项协作：完成";
    if (step.status === "cancelled") return "专项协作：取消";
    if (step.status === "failed") return "专项协作：失败";
    return "专项协作：等待";
  }
  if (step.toolName) return step.toolName;
  if (step.kind === "model") return "生成回复";
  if (step.kind === "approval") return "等待审批";
  return step.kind === "tool" ? "执行工具" : `执行步骤 ${step.seq}`;
}

export function agentRuntimeStepDetail(step: AgentRuntimeStep): string {
  if (step.status === "failed") return step.error?.message || "执行失败";
  if (step.status === "cancelled") return "已取消";
  if (step.status === "uncertain") return "结果待核对";
  if (step.status === "awaiting_approval") return `${step.agentRole} · 等待审批`;
  if (step.status === "waiting_external") return `${step.agentRole} · 等待外部结果`;
  if (step.status === "queued") return `${step.agentRole} · 等待执行`;
  if (step.status === "running") return `${step.agentRole} · 执行中`;
  return `${step.agentRole} · 已完成`;
}

function eventStatus(type: string, value: unknown): AgentRuntimeStepStatus {
  if (isStepStatus(value)) return value;
  if (type === "step.completed") return "succeeded";
  if (type === "step.failed") return "failed";
  if (type === "step.cancelled") return "cancelled";
  if (type === "step.uncertain") return "uncertain";
  if (type === "step.awaiting_approval") return "awaiting_approval";
  if (type === "step.waiting_external") return "waiting_external";
  return "running";
}

function eventError(value: unknown, payload: Record<string, unknown>) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = value as Record<string, unknown>;
    return {
      code: safeString(error.code) || "step_failed",
      message: safeString(error.message) || "执行失败",
    };
  }
  const code = safeString(payload.code);
  const message = safeString(payload.message);
  return code || message ? { code: code || "step_failed", message: message || "执行失败" } : null;
}

/**
 * Validates the whitelisted plan echo carried by `step.*` SSE payloads. The
 * backend already gates it through the plan.present output schema, so anything
 * that does not match the DTO projection exactly is dropped to null; the next
 * authoritative Step snapshot remains the fallback.
 */
function eventPlan(value: unknown): AgentRuntimeStepPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = value as Record<string, unknown>;
  const title = safeString(plan.title);
  if (!title) return null;
  if (plan.summary !== null && typeof plan.summary !== "string") return null;
  if (plan.estimatedTotal !== null && typeof plan.estimatedTotal !== "string") return null;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return null;
  const steps: AgentRuntimeStepPlanStep[] = [];
  for (const item of plan.steps) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const step = item as Record<string, unknown>;
    const stepTitle = safeString(step.title);
    if (!stepTitle) return null;
    if (step.detail !== null && typeof step.detail !== "string") return null;
    steps.push({ title: stepTitle, detail: typeof step.detail === "string" ? step.detail : null });
  }
  return {
    title,
    summary: typeof plan.summary === "string" ? plan.summary : null,
    steps,
    estimatedTotal: typeof plan.estimatedTotal === "string" ? plan.estimatedTotal : null,
  };
}

function eventGenerationReview(value: unknown): AgentRuntimeGenerationReview {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const review = value as Record<string, unknown>;
  const reviewId = safeString(review.reviewId);
  const engine = safeString(review.engine);
  if (!reviewId || !engine || (review.verdict !== "pass" && review.verdict !== "attention")) return null;
  return { reviewId, engine, verdict: review.verdict };
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return safeString(value) ?? undefined;
}

/** Revalidates the narrow public generation receipt carried by step.* SSE. */
function eventGenerationReceipt(value: unknown): AgentRuntimeGenerationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const status = receipt.status;
  if (status !== "succeeded" && status !== "failed" && status !== "unavailable") return null;
  const code = nullableString(receipt.code);
  const message = nullableString(receipt.message);
  const quoteId = nullableString(receipt.quoteId);
  const model = safeString(receipt.model);
  if (code === undefined || message === undefined || quoteId === undefined || !model) return null;
  const review = eventGenerationReview(receipt.review);
  if (receipt.review !== null && review === null) return null;

  if (receipt.generationType === "image") {
    const units = safeNumber(receipt.units);
    const size = nullableString(receipt.size);
    if (!units || size === undefined || !Array.isArray(receipt.assets) || receipt.assets.length > 10) return null;
    const assets: Extract<AgentRuntimeGenerationReceipt, { generationType: "image" }>["assets"] = [];
    for (const value of receipt.assets) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const asset = value as Record<string, unknown>;
      const mediaAssetId = safeString(asset.mediaAssetId);
      const assetId = safeNumber(asset.assetId);
      const assetVersionId = safeNumber(asset.assetVersionId);
      const url = safeString(asset.url);
      if (!mediaAssetId || !assetId || !assetVersionId || !url || typeof asset.mirrored !== "boolean") return null;
      assets.push({ mediaAssetId, assetId, assetVersionId, url, mirrored: asset.mirrored });
    }
    return {
      generationType: "image",
      status,
      code,
      message,
      quoteId,
      model,
      units,
      size,
      assets,
      review,
    };
  }

  if (receipt.generationType === "video" && receipt.units === 1) {
    const assetVersionId = receipt.assetVersionId === null ? null : safeNumber(receipt.assetVersionId);
    if (assetVersionId === null && receipt.assetVersionId !== null) return null;
    let task: Extract<AgentRuntimeGenerationReceipt, { generationType: "video" }>["task"] = null;
    if (receipt.task !== null) {
      if (!receipt.task || typeof receipt.task !== "object" || Array.isArray(receipt.task)) return null;
      const source = receipt.task as Record<string, unknown>;
      const taskId = safeString(source.taskId);
      const taskStatus = safeString(source.status);
      if (!taskId || !taskStatus) return null;
      task = { taskId, status: taskStatus };
    }
    return {
      generationType: "video",
      status,
      code,
      message,
      quoteId,
      model,
      units: 1,
      task,
      assetVersionId,
      review,
    };
  }

  return null;
}

/** Accepts both the preferred `{ step: StepDto }` SSE payload and the compact legacy shape. */
export function agentRuntimeStepFromEvent(
  event: AgentRuntimeEvent,
  expectedRunId: string,
  current: readonly AgentRuntimeStep[],
): AgentRuntimeStep | null {
  if (!event.type.startsWith("step.")) return null;
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const nested = payload.step && typeof payload.step === "object" && !Array.isArray(payload.step)
    ? payload.step as Record<string, unknown>
    : payload;
  const id = safeString(nested.id) || safeString(nested.stepId) || safeString(event.stepId);
  if (!id) return null;
  const existing = current.find((step) => step.id === id);
  const runId = safeString(nested.runId) || safeString(event.runId) || expectedRunId;
  if (runId !== expectedRunId) return null;
  const seq = safeNumber(nested.seq) ?? safeNumber(nested.stepSeq);
  // Compact legacy events without a run-local seq must trigger an
  // authoritative snapshot refresh; the thread event seq is not a Step seq.
  if (seq === null || seq < 1) return null;
  const createdAt = safeNumber(nested.createdAt) ?? existing?.createdAt ?? safeNumber(event.createdAt) ?? 0;
  const updatedAt = safeNumber(nested.updatedAt) ?? safeNumber(event.createdAt) ?? existing?.updatedAt ?? createdAt;
  const status = eventStatus(event.type, nested.status);

  return {
    id,
    runId,
    parentStepId: safeString(nested.parentStepId) ?? existing?.parentStepId ?? null,
    seq,
    agentRole: safeString(nested.agentRole) || existing?.agentRole || "main",
    kind: safeString(nested.kind) || existing?.kind || (safeString(nested.toolName) ? "tool" : "runtime"),
    status,
    toolName: safeString(nested.toolName) ?? existing?.toolName ?? null,
    error: status === "failed" ? eventError(nested.error, payload) : null,
    // The preferred `{ step: StepDto }` payload always carries the whitelisted
    // plan key (null for non-plan Steps); compact legacy events may omit it,
    // in which case the previously merged plan is kept.
    plan: nested.plan === undefined ? (existing?.plan ?? null) : eventPlan(nested.plan),
    generationReceipt: nested.generationReceipt === undefined
      ? (existing?.generationReceipt ?? null)
      : eventGenerationReceipt(nested.generationReceipt),
    createdAt,
    updatedAt,
    startedAt: safeNumber(nested.startedAt) ?? existing?.startedAt ?? (status === "running" ? updatedAt : null),
    completedAt: safeNumber(nested.completedAt) ?? existing?.completedAt ?? (TERMINAL_STATUS_RANK[status] === 2 ? updatedAt : null),
  };
}
