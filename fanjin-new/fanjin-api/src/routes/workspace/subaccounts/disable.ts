import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  requireLiveWorkspaceAuthority,
  assertWorkspaceMemberMutation,
  revokeWorkspaceMemberAccess,
  WorkspaceAuthorityError,
} from "@/lib/workspaceAccess";

const router = express.Router();
router.use(requireWorkspacePermission("member:write"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  userId: z.number().int().positive(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = parsed.data.workspaceId || (req as any).auth?.workspaceId || "default";
  const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
  const authenticatedWorkspaceId = (req as any).auth?.workspaceId || null;
  try {
    const revoked = await db.transaction(async (trx) => {
      const { workspace, role: actorRole } = await requireLiveWorkspaceAuthority({
        database: trx,
        actorUserId,
        additionalUserIds: [parsed.data.userId],
        additionalMemberUserIds: [parsed.data.userId],
        authenticatedWorkspaceId,
        workspaceId,
        permission: "member:write",
      });
      const member = await trx("o_workspace_member")
        .where({ workspaceId, userId: parsed.data.userId })
        .forUpdate()
        .first();
      if (!member) throw new Error("WORKSPACE_MEMBER_NOT_FOUND");
      if (
        member.role === "owner"
        || Number(workspace.ownerUserId || 0) === parsed.data.userId
      ) {
        throw new Error("WORKSPACE_OWNER_TRANSFER_UNAVAILABLE");
      }
      assertWorkspaceMemberMutation({
        actorUserId,
        ownerUserId: workspace.ownerUserId,
        actorRole,
        targetUserId: parsed.data.userId,
        targetRole: member.role,
        changesAuthority: true,
      });
      const now = Date.now();
      await trx("o_workspace_member")
        .where({ id: member.id })
        .update({ status: "disabled", updatedAt: now });
      const revokedAccess = await revokeWorkspaceMemberAccess({
        workspaceId,
        userId: parsed.data.userId,
        database: trx,
      });
      await writeAuditLog(req, {
        workspaceId,
        action: "workspace.member.disable",
        resourceType: "workspace_member",
        resourceId: parsed.data.userId,
        required: true,
        metadata: {
          before: { role: member.role, status: member.status },
          after: { role: member.role, status: "disabled" },
          revoked: revokedAccess,
        },
      }, trx);
      return revokedAccess;
    });
    return res.status(200).send(success({
      workspaceId,
      userId: parsed.data.userId,
      status: "disabled",
      ...revoked,
    }));
  } catch (err: unknown) {
    if (err instanceof WorkspaceAuthorityError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    const message = String((err as Error)?.message || "");
    if (message === "WORKSPACE_INACTIVE") {
      return res.status(403).send(error("工作区不可用", { code: "WORKSPACE_INACTIVE" }));
    }
    if (message === "WORKSPACE_MEMBER_NOT_FOUND") {
      return res.status(404).send(error("子账号不存在"));
    }
    if (message === "WORKSPACE_OWNER_TRANSFER_UNAVAILABLE") {
      return res.status(403).send(error(
        "通用成员接口不支持 owner 变更",
        { code: "WORKSPACE_OWNER_TRANSFER_UNAVAILABLE" },
      ));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，成员未停用", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
