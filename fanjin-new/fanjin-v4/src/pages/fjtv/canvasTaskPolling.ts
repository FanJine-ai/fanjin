/** A failed read says nothing about generation or settlement. Retain the task
 * handle and offer a read-only retry instead of claiming it is still running. */
export function canvasTaskQueryFailure(error: unknown, failures: number) {
  const status = Number((error as { status?: unknown } | null)?.status);
  const stop = [400, 401, 403, 404, 409].includes(status) || failures >= 6;
  return { stop, delayMs: Math.min(30_000, 2_000 * 2 ** Math.min(failures, 4)),
    message: status === 404 ? "未找到对应任务，请刷新任务状态；暂时无法确认生成结果，勿重复提交"
      : status === 401 || status === 403 ? "无法读取任务，请确认登录账号和项目权限后刷新；勿重复提交"
      : "暂时无法读取任务结果，请刷新任务状态；不会自动重新生成" };
}

/** A missing image task is a terminal stale reference, not a transient read failure. */
export function isCanvasImageTaskMissing(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown; data?: { code?: unknown } } | null;
  const status = Number(value?.status);
  const code = String(value?.code ?? value?.data?.code ?? "").trim().toUpperCase();
  return status === 404 && code === "TASK_NOT_FOUND";
}
