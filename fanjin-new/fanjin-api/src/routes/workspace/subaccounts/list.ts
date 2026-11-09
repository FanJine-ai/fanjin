import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import { getEffectiveWorkspacePermissions, getRegisteredWorkspaceRoles, hasExactPermission, roleHasDefaultPermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("member:read"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = parsed.data.workspaceId || (req as any).auth?.workspaceId || "default";
  const workspace = await db("o_workspace")
    .where({ id: workspaceId, status: "active" })
    .select("ownerUserId")
    .first();
  if (!workspace) return res.status(403).send({ message: "工作区不可用" });
  const rows = await db("o_workspace_member")
    .leftJoin("o_user", "o_workspace_member.userId", "o_user.id")
    .where("o_workspace_member.workspaceId", workspaceId)
    .select(
      "o_workspace_member.id",
      "o_workspace_member.workspaceId",
      "o_workspace_member.userId",
      "o_workspace_member.role",
      "o_workspace_member.status",
      "o_workspace_member.permissions",
      "o_workspace_member.quotaLimit",
      "o_workspace_member.rateLimitPerMinute",
      "o_workspace_member.notes",
      "o_workspace_member.createdAt",
      "o_workspace_member.updatedAt",
      "o_user.name",
      "o_user.email",
      "o_user.displayName",
      "o_user.lastLoginAt",
    )
    .orderBy("o_workspace_member.createdAt", "asc");

  const members = rows.map((row: any) => {
    const authoritativeOwner = Number(row.userId || 0) === Number(workspace.ownerUserId || 0);
    const consistentRole = getConsistentWorkspaceRole({
      userId: row.userId,
      memberRole: row.role,
      ownerUserId: workspace.ownerUserId,
    });
    return {
      ...row,
      isWorkspaceOwner: authoritativeOwner,
      ownerInvariantValid: consistentRole !== null,
      effectiveRole: consistentRole,
      canManageMembers: Boolean(consistentRole && roleHasDefaultPermission(consistentRole, "member:write")),
    };
  });
  const auth = (req as any).auth || {};
  const actorUserId = Number(auth.user?.id || (req as any).user?.id || 0);
  const platformRole = String(auth.user?.role || (req as any).user?.role || "").toLowerCase();
  const actor = rows.find((row: any) => Number(row.userId) === actorUserId);
  const actorRole = actor ? getConsistentWorkspaceRole({
    userId: actor.userId,
    memberRole: actor.role,
    ownerUserId: workspace.ownerUserId,
  }) : null;
  const actorCanManage = ["root", "admin", "super_admin"].includes(platformRole)
    || Boolean(actor && actor.status === "active" && actorRole && hasExactPermission(
      getEffectiveWorkspacePermissions({ ...actor, role: actorRole }),
      "member:write",
    ));
  const isOwner = actorUserId === Number(workspace.ownerUserId || 0);
  const registeredRoles = getRegisteredWorkspaceRoles().filter((role) => role !== "owner");
  const assignableRoles = !actorCanManage ? [] : registeredRoles.filter((role) => (
    isOwner
      || ["root", "admin", "super_admin"].includes(platformRole)
      || !roleHasDefaultPermission(role, "member:write")
  ));
  res.status(200).send(success({ members, assignableRoles }));
});
