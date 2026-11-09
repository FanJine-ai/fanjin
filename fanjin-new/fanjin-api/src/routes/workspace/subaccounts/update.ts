import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  assertWorkspaceRoleAssignment,
  assertWorkspaceMemberMutation,
  requireLiveWorkspaceAuthority,
  revokeWorkspaceMemberAccess,
  WorkspaceAuthorityError,
} from "@/lib/workspaceAccess";
import { assertWorkspaceMemberLimit, WorkspaceLimitError } from "@/lib/workspaceLimits";
import { assertMembershipFeature } from "@/lib/membership";
import { MembershipError } from "@/lib/membershipCatalog";

const router = express.Router();
router.use(requireWorkspacePermission("member:write"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  userId: z.number().int().positive(),
  role: z.enum(["workspace_admin", "creator"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  quotaLimit: z.number().int().nonnegative().optional().nullable(),
  rateLimitPerMinute: z.number().int().nonnegative().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const data = parsed.data;
  const workspaceId = data.workspaceId || (req as any).auth?.workspaceId || "default";
  const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
  const authenticatedWorkspaceId = (req as any).auth?.workspaceId || null;
  try {
    const result = await db.transaction(async (trx) => {
      const { workspace, lockedUsers, role: actorRole } = await requireLiveWorkspaceAuthority({
        database: trx,
        actorUserId,
        additionalUserIds: [data.userId],
        additionalMemberUserIds: [data.userId],
        authenticatedWorkspaceId,
        workspaceId,
        permission: "member:write",
      });
      const member = await trx("o_workspace_member")
        .where({ workspaceId, userId: data.userId })
        .forUpdate()
        .first();
      if (!member) throw new Error("WORKSPACE_MEMBER_NOT_FOUND");
      const targetUser = lockedUsers.find(
        (row: any) => Number(row.id) === data.userId,
      );
      if (!targetUser) throw new Error("WORKSPACE_MEMBER_ACCOUNT_NOT_FOUND");
      if (data.status === "active" && targetUser.status !== "active") {
        throw new Error("WORKSPACE_MEMBER_ACCOUNT_UNAVAILABLE");
      }
      if (
        member.role === "owner"
        || Number(workspace.ownerUserId || 0) === data.userId
      ) {
        throw new Error("WORKSPACE_OWNER_TRANSFER_UNAVAILABLE");
      }

      assertWorkspaceMemberMutation({
        actorUserId,
        ownerUserId: workspace.ownerUserId,
        actorRole,
        targetUserId: data.userId,
        targetRole: member.role,
        changesAuthority: ["role", "status", "quotaLimit", "rateLimitPerMinute"]
          .some((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field)),
      });

      if (data.role !== undefined) {
        assertWorkspaceRoleAssignment({ actorUserId, ownerUserId: workspace.ownerUserId,
          actorRole, targetUserId: data.userId, targetRole: member.role, role: data.role });
      }

      const now = Date.now();
      const ceiling = (v: unknown) => Number(v || 0) > 0 ? Number(v) : Infinity;
      if ((data.quotaLimit !== undefined && ceiling(data.quotaLimit) > ceiling(member.quotaLimit))
        || (data.rateLimitPerMinute !== undefined && ceiling(data.rateLimitPerMinute) > ceiling(member.rateLimitPerMinute))) {
        await assertMembershipFeature(workspaceId, "teamBudget", trx);
      }
      if (member.status !== "active" && data.status === "active") {
        await assertMembershipFeature(workspaceId, "shared", trx);
        await assertWorkspaceMemberLimit(workspaceId, 1, trx, now);
      }
      const memberPatch: Record<string, unknown> = {
        updatedAt: now,
      };
      if (data.role) memberPatch.role = data.role;
      if (data.status) memberPatch.status = data.status;
      if (data.quotaLimit !== undefined) memberPatch.quotaLimit = data.quotaLimit;
      if (data.rateLimitPerMinute !== undefined) memberPatch.rateLimitPerMinute = data.rateLimitPerMinute;
      if (data.notes !== undefined) memberPatch.notes = data.notes || null;
      await trx("o_workspace_member").where({ id: member.id }).update(memberPatch);

      const authorityReduced = (
        (data.status !== undefined && data.status !== member.status)
        || (data.role !== undefined && data.role !== member.role)
      );
      const revoked = authorityReduced
        ? await revokeWorkspaceMemberAccess({
          workspaceId,
          userId: data.userId,
          database: trx,
        })
        : null;
      await writeAuditLog(req, {
        workspaceId,
        action: "workspace.member.update",
        resourceType: "workspace_member",
        resourceId: data.userId,
        required: true,
        metadata: {
          before: {
            role: member.role,
            status: member.status,
            permissionsConfigured: member.permissions !== null && member.permissions !== undefined,
          },
          patch: memberPatch,
          revoked,
        },
      }, trx);
      return { memberPatch, revoked };
    });

    return res.status(200).send(success({
      workspaceId,
      userId: data.userId,
      ...result.memberPatch,
      revoked: result.revoked,
    }));
  } catch (err: unknown) {
    if (err instanceof MembershipError) return res.status(err.status).send(error(err.message, { code: err.code }));
    if (err instanceof WorkspaceAuthorityError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (err instanceof WorkspaceLimitError) {
      return res.status(err.status).send({
        message: err.message,
        code: err.code,
        details: err.details,
      });
    }
    const message = String((err as Error)?.message || "");
    if (message === "WORKSPACE_INACTIVE") {
      return res.status(403).send(error("工作区不可用", { code: "WORKSPACE_INACTIVE" }));
    }
    if (message === "WORKSPACE_MEMBER_NOT_FOUND") {
      return res.status(404).send(error("子账号不存在"));
    }
    if (message === "WORKSPACE_MEMBER_ACCOUNT_NOT_FOUND") {
      return res.status(409).send(error("子账号关联的全局账号不存在", {
        code: "WORKSPACE_MEMBER_ACCOUNT_NOT_FOUND",
      }));
    }
    if (message === "WORKSPACE_MEMBER_ACCOUNT_UNAVAILABLE") {
      return res.status(409).send(error("全局账号不可用，不能启用工作区成员", {
        code: "WORKSPACE_MEMBER_ACCOUNT_UNAVAILABLE",
      }));
    }
    if (message === "WORKSPACE_OWNER_TRANSFER_UNAVAILABLE") {
      return res.status(403).send(error(
        "通用成员接口不支持 owner 变更",
        { code: "WORKSPACE_OWNER_TRANSFER_UNAVAILABLE" },
      ));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，成员未更新", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
