import express from "express";

import {
  DurableCommandIdempotencyError,
  readDurableCommandStatus,
} from "@/lib/durableCommandIdempotency";
import { success } from "@/lib/responseFormat";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();

const ALLOWED_SCOPES = new Set([
  "workbench:create:director-plan",
  "workbench:create:materialize",
  "asset:add",
  "workbench:create:asset-image",
  "production:storyboard:image",
  "production:workbench:batch-generate-video",
  "production:workbench:select-video",
  "production:workbench:render-final-video",
]);
const DRAFT_SCOPE = /^workbench-editor-draft:save:-?\d{1,12}$/;
const LINKED_TASK_CLASS_BY_RESOURCE = new Map([
  ["project_image_task", new Set(["资产图片生成", "分镜图片生成"])],
  ["project_final_render_task", new Set(["成片合成"])],
]);

function header(req: express.Request, name: string): string {
  return String(req.header(name) || "").trim();
}

export default router.get(
  "/",
  requireActiveWorkspacePermission("project:read"),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const idempotencyKey = header(req, "idempotency-key");
    const scope = header(req, "x-fanjin-command-scope");
    const projectId = Number(header(req, "x-fanjin-project-id"));
    if (
      !idempotencyKey
      || idempotencyKey.length > 200
      || (!ALLOWED_SCOPES.has(scope) && !DRAFT_SCOPE.test(scope))
      || !Number.isSafeInteger(projectId)
      || projectId <= 0
    ) {
      return res.status(400).send({
        code: "command_status_request_invalid",
        message: "命令状态查询缺少有效的作用域、幂等键或项目绑定",
      });
    }
    const project = await db("o_project")
      .where({
        id: projectId,
        workspaceId,
        deletionState: "active",
      })
      .select("id")
      .first();
    if (!project) {
      return res.status(404).send({
        code: "command_status_not_found",
        message: "命令状态不存在",
      });
    }
    try {
      const status = await readDurableCommandStatus({
        workspaceId,
        actorUserId,
        scope,
        idempotencyKey,
        resourceType: "project",
        resourceId: projectId,
        authorizeLinkedResource: async ({ database, authority, stored }) => {
          if (authority.resourceType !== "project") return false;
          const allowedTaskClasses = LINKED_TASK_CLASS_BY_RESOURCE.get(
            stored.resourceType,
          );
          const taskId = Number(stored.resourceId);
          if (
            !allowedTaskClasses
            || !Number.isSafeInteger(taskId)
            || taskId <= 0
          ) {
            return false;
          }
          const task = await database("o_tasks")
            .where({
              id: taskId,
              projectId: Number(authority.resourceId),
            })
            .whereIn("taskClass", [...allowedTaskClasses])
            .select("id")
            .first();
          return Boolean(task);
        },
      });
      if (status.kind === "not_found") {
        return res.status(404).send({
          code: "command_status_not_found",
          message: "命令状态不存在",
        });
      }
      return res.status(200).send(success({
        state: status.state,
        responseStatus: status.responseStatus,
        terminal: status.terminal,
        checkpointed: status.checkpointed,
        updatedAt: status.updatedAt,
      }));
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  },
);
