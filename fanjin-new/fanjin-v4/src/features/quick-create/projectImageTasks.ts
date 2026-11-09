import { ApiError, apiPost } from "../../api/http";

export const STORYBOARD_IMAGE_TASK_API =
  "/production/storyboard/batchGenerateImage/tasks" as const;
export const CORNER_IMAGE_TASK_API =
  "/workbench/create/images/tasks" as const;

export type ProjectImageTaskApiBase =
  | typeof STORYBOARD_IMAGE_TASK_API
  | typeof CORNER_IMAGE_TASK_API;

export type ProjectImageTaskFlow = "storyboard" | "asset";
export type ProjectImageTaskPhase =
  | "preparing"
  | "queued"
  | "dispatching"
  | "provider_succeeded"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "pending_reconcile";
export type ProjectImageTaskState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "pending_reconcile";

export type ProjectImageTask = {
  taskId: number;
  projectId: number;
  flow: ProjectImageTaskFlow;
  assetId: number | null;
  scriptId: number | null;
  storyboardId: number | null;
  phase: ProjectImageTaskPhase;
  state: ProjectImageTaskState;
  cancelAllowed: boolean;
  model: string;
  reason: string | null;
  startedAt: number | null;
  response: unknown | null;
};

export type ProjectImageTaskCancelResult = {
  cancelled: boolean;
  task: ProjectImageTask;
};

const PHASES = new Set<ProjectImageTaskPhase>([
  "preparing",
  "queued",
  "dispatching",
  "provider_succeeded",
  "succeeded",
  "failed",
  "cancelled",
  "pending_reconcile",
]);

const STATES = new Set<ProjectImageTaskState>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "pending_reconcile",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nullablePositiveInteger(value: unknown): number | null {
  return value == null ? null : positiveInteger(value);
}

function expectedTaskState(phase: ProjectImageTaskPhase): ProjectImageTaskState {
  if (phase === "preparing" || phase === "queued") return "queued";
  if (phase === "dispatching" || phase === "provider_succeeded") return "running";
  return phase;
}

export function normalizeProjectImageTask(value: unknown): ProjectImageTask {
  const source = record(value);
  const taskId = positiveInteger(source?.taskId);
  const projectId = positiveInteger(source?.projectId);
  const flow = String(source?.flow || "") as ProjectImageTaskFlow;
  const phase = String(source?.phase || "") as ProjectImageTaskPhase;
  const state = String(source?.state || "") as ProjectImageTaskState;
  const assetId = nullablePositiveInteger(source?.assetId);
  const scriptId = nullablePositiveInteger(source?.scriptId);
  const storyboardId = nullablePositiveInteger(source?.storyboardId);
  if (
    !source
    || taskId === null
    || projectId === null
    || !["storyboard", "asset"].includes(flow)
    || !PHASES.has(phase)
    || !STATES.has(state)
    || state !== expectedTaskState(phase)
    || typeof source.cancelAllowed !== "boolean"
    || typeof source.model !== "string"
    || (flow === "asset" && assetId === null)
    || (flow === "storyboard" && (storyboardId === null || scriptId === null))
  ) {
    throw new Error("图片任务状态响应格式无效");
  }
  const startedAt = source.startedAt == null ? null : Number(source.startedAt);
  if (startedAt !== null && (!Number.isFinite(startedAt) || startedAt <= 0)) {
    throw new Error("图片任务状态响应格式无效");
  }
  return {
    taskId,
    projectId,
    flow,
    assetId,
    scriptId,
    storyboardId,
    phase,
    state,
    cancelAllowed: source.cancelAllowed,
    model: source.model,
    reason: typeof source.reason === "string" && source.reason.trim()
      ? source.reason.trim()
      : null,
    startedAt,
    response: source.response ?? null,
  };
}

export function normalizeProjectImageTasks(value: unknown): ProjectImageTask[] {
  if (!Array.isArray(value)) throw new Error("图片任务列表响应格式无效");
  return value.map(normalizeProjectImageTask);
}

export function normalizeProjectImageTaskCancelResult(
  value: unknown,
  expectedTaskId: number,
): ProjectImageTaskCancelResult {
  const source = record(value);
  const task = normalizeProjectImageTask(source?.task);
  if (
    typeof source?.cancelled !== "boolean"
    || task.taskId !== expectedTaskId
  ) {
    throw new Error("图片任务取消响应格式无效");
  }
  return { cancelled: source.cancelled, task };
}

export function isProjectImageTaskActive(task: ProjectImageTask): boolean {
  return ["queued", "running", "pending_reconcile"].includes(task.state);
}

export function projectImageTaskResourceId(task: ProjectImageTask): number | null {
  return task.flow === "storyboard" ? task.storyboardId : task.assetId;
}

export function latestProjectImageTasksByResource(
  tasks: ProjectImageTask[],
  flow: ProjectImageTaskFlow,
): Map<number, ProjectImageTask> {
  const result = new Map<number, ProjectImageTask>();
  tasks.forEach((task) => {
    if (task.flow !== flow) return;
    const resourceId = projectImageTaskResourceId(task);
    if (resourceId === null) return;
    const current = result.get(resourceId);
    if (
      !current
      || (
        isProjectImageTaskActive(task)
        && !isProjectImageTaskActive(current)
      )
      || (
        isProjectImageTaskActive(task) === isProjectImageTaskActive(current)
        && task.taskId > current.taskId
      )
    ) {
      result.set(resourceId, task);
    }
  });
  return result;
}

export function projectImageTaskLabel(task: ProjectImageTask): string {
  if (task.state === "pending_reconcile") return "待核对";
  if (task.state === "queued") return "排队中";
  if (task.phase === "provider_succeeded") return "保存中";
  if (task.state === "running") return "生成中";
  if (task.state === "succeeded") return "已完成";
  if (task.state === "cancelled") return "已取消";
  return "生成失败";
}

export function shouldRetainProjectImageAttempt(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return new Set([
    "idempotency_in_progress",
    "image_task_in_progress",
    "image_task_not_dispatchable",
    "image_task_pending_reconcile",
    "image_task_persistence_retryable",
    "image_task_provider_result_missing",
  ]).has(String(error.code || ""));
}

export async function fetchProjectImageTasks(
  apiBase: ProjectImageTaskApiBase,
  projectId: number,
  signal?: AbortSignal,
): Promise<ProjectImageTask[]> {
  const response = await apiPost<unknown>(
    `${apiBase}/status`,
    { projectId },
    undefined,
    { signal },
  );
  const tasks = normalizeProjectImageTasks(response);
  if (tasks.some((task) => task.projectId !== projectId)) {
    throw new Error("图片任务状态与当前项目不一致");
  }
  return tasks;
}

export async function cancelProjectImageTask(
  apiBase: ProjectImageTaskApiBase,
  projectId: number,
  taskId: number,
): Promise<ProjectImageTaskCancelResult> {
  const normalizeResult = (value: unknown) => {
    const result = normalizeProjectImageTaskCancelResult(value, taskId);
    if (result.task.projectId !== projectId) {
      throw new Error("图片任务取消响应与当前项目不一致");
    }
    return result;
  };
  try {
    const response = await apiPost<unknown>(
      `${apiBase}/cancel`,
      { projectId, taskId },
    );
    return normalizeResult(response);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.details) {
      return normalizeResult(error.details);
    }
    throw error;
  }
}
