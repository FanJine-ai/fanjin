import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { getAuthProfile } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";
import { error, success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";
import {
  requireLiveWorkspaceAuthority,
  WorkspaceAuthorityError,
} from "@/lib/workspaceAccess";

const router = express.Router();
router.use(requireWorkspacePermission("workspace:write"));

export const bodySchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(64),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const userId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
    if (!userId) return res.status(401).send(error("未登录"));

    const workspaceId = parsed.data.workspaceId;
    const name = parsed.data.name.trim();
    await db.transaction(async (trx) => {
      const { workspace: existing } = await requireLiveWorkspaceAuthority({
        database: trx,
        actorUserId: userId,
        authenticatedWorkspaceId: (req as any).auth?.workspaceId || null,
        workspaceId,
        permission: "workspace:write",
      });

      await trx("o_workspace").where({ id: workspaceId }).update({
        name,
        updatedAt: Date.now(),
      });
      await writeAuditLog(req, {
        workspaceId,
        action: "workspace.update",
        resourceType: "workspace",
        resourceId: workspaceId,
        required: true,
        metadata: {
          before: { name: existing.name },
          after: { name },
        },
      }, trx);
    });

    return res.status(200).send(success(await getAuthProfile(db as any, userId), "工作区已更新"));
  } catch (err: any) {
    if (err instanceof WorkspaceAuthorityError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    const message = String(err?.message || "");
    if (message === "WORKSPACE_NOT_FOUND") {
      return res.status(404).send(error("工作区不存在"));
    }
    if (message === "WORKSPACE_INACTIVE") {
      return res.status(403).send(error("工作区不可用", {
        code: "WORKSPACE_INACTIVE",
      }));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，工作区未更新", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    return res.status(500).send(error(err?.message || "更新工作区失败"));
  }
});
