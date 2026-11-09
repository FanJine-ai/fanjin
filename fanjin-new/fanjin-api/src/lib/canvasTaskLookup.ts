import { db } from "@/utils/db";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { EXTERNAL_TOOL_TABLE } from "./migrations/externalTools";
import { canAccessRelayTask, getRelayTask, type RelayTask } from "./relay";

export class CanvasTaskLookupError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new CanvasTaskLookupError(status, code, message); };
const object = (value: unknown): Record<string, any> => {
  try { const v = typeof value === "string" ? JSON.parse(value) : value; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
};

/** Canvas may store either a relay id or the public MCP operation id. Resolve the
 * persisted link, then authorize the actual project. Never dispatch from a read.
 * This permission applies to result reads only, not cancellation or API-key use.
 */
export async function lookupCanvasTask(id: string, auth: any): Promise<{ task?: RelayTask; view?: Record<string, unknown> }> {
  let task = await getRelayTask(id);
  let operation: any;
  if (!task) {
    operation = await db(EXTERNAL_TOOL_TABLE).where({ id, kind: "fanjin_generation_submit" }).first();
    if (!operation) return fail(404, "TASK_NOT_FOUND", "任务不存在");
    if (!auth?.user?.id || String(operation.workspaceId) !== String(auth.workspaceId)) return fail(403, "TASK_FORBIDDEN", "无权访问该任务");
    const projectId = Number(operation.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return fail(403, "TASK_FORBIDDEN", "任务缺少可验证的项目归属");
    await requireProject(projectId, auth);
    if (operation.relayTaskId) {
      task = await getRelayTask(operation.relayTaskId);
      if (!task || String(task.workspaceId) !== String(operation.workspaceId)
        || String(task.projectId) !== String(operation.projectId) || task.apiKeyId !== operation.keyId) {
        return fail(409, "TASK_LINK_UNAVAILABLE", "任务关联暂不可用，请刷新任务状态，勿重复提交");
      }
    } else {
      const result = object(operation.resultJson);
      const notStarted = operation.status === "failed" && result.billingStatus === "not_started";
      const waiting = ["queued", "pending", "running"].includes(operation.status);
      return { view: {
        id, object: "content.generation.task", status: notStarted ? "failed" : waiting ? "queued" : "pending_reconcile",
        stage: notStarted ? "failed" : "processing", progress: 0,
        billing_state: notStarted ? "not_started" : waiting ? undefined : "pending_reconcile",
        error: notStarted ? { code: "GENERATION_NOT_DISPATCHED", message: "任务在提交生成前失败，未开始扣费；请查看任务详情" }
          : waiting ? null : { code: "TASK_LINK_PENDING", message: "任务结果正在核对，请勿重复提交" }, output: [],
      } };
    }
  }
  if (!canAccessRelayTask(task, { auth })) {
    // 登录用户按实际项目权限读取工作台或 MCP Key 创建的任务。
    // A workspace match alone must not expose another private project's results.
    if (!auth?.user?.id || !auth.workspaceId || String(task.workspaceId) !== String(auth.workspaceId)) {
      return fail(403, "TASK_FORBIDDEN", "无权访问该任务");
    }
    const projectId = Number(task.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return fail(403, "TASK_FORBIDDEN", "任务缺少可验证的项目归属");
    await requireProject(projectId, auth);
  }
  return { task };
}

async function requireProject(projectId: number, auth: any) {
  const access = await checkProjectPermission({ database: db, projectId, userId: Number(auth.user.id),
    role: auth.user.role, authWorkspaceId: String(auth.workspaceId), permission: "project:read" });
  if (!access.allowed || String(access.project?.workspaceId) !== String(auth.workspaceId)) {
    fail(403, "TASK_FORBIDDEN", "无权访问该任务所属项目");
  }
}
