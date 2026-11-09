import type { Request } from "express";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";

export interface AgentRequestActor {
  userId: number;
  role: string;
  workspaceId: string;
}

export function getAgentRequestActor(req: Request): AgentRequestActor {
  const auth = (req as any).auth;
  const user = auth?.user || (req as any).user || {};
  const userId = Number(user.id || 0);
  const workspaceId = String(auth?.workspaceId || user.workspaceId || "");
  if (!userId) throw new AgentRuntimeError(401, "unauthenticated", "未登录");
  if (!workspaceId) {
    throw new AgentRuntimeError(403, "workspace_context_required", "缺少工作区上下文");
  }
  return { userId, role: String(user.role || ""), workspaceId };
}

export async function assertAgentProjectAccess(
  req: Request,
  projectId: number,
  permission: "project:read" | "project:write",
) {
  const actor = getAgentRequestActor(req);
  const scopedProject = await db("o_project")
    .where({
      id: projectId,
      workspaceId: actor.workspaceId,
      deletionState: "active",
    })
    .first();
  if (!scopedProject) {
    throw new AgentRuntimeError(404, "project_not_found", "项目不存在");
  }
  const result = await checkProjectPermission({
    projectId,
    userId: actor.userId,
    role: actor.role,
    permission,
  });
  if (!result.allowed) {
    throw new AgentRuntimeError(result.status, "project_access_denied", result.message);
  }

  return { actor, project: result.project, workspaceId: actor.workspaceId };
}
