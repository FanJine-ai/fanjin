import crypto from "crypto";
import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { hashPassword } from "@/lib/auth";
import { success } from "@/lib/responseFormat";
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
import { insertAndReturnId } from "@/lib/dbDialect";
import { DEFAULT_PASSWORD_POLICY, validatePasswordAgainstPolicy } from "@/lib/accountSecurity";

const router = express.Router();
router.use(requireWorkspacePermission("member:write"));

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  name: z.string().trim().min(1).max(64),
  role: z.enum(["workspace_admin", "creator"]).default("creator"),
  password: z.string().min(8).optional().nullable(),
  quotaLimit: z.number().int().nonnegative().optional().nullable(),
  rateLimitPerMinute: z.number().int().nonnegative().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const data = parsed.data;
    const workspaceId = data.workspaceId || (req as any).auth?.workspaceId || "default";
    const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
    const authenticatedWorkspaceId = (req as any).auth?.workspaceId || null;
    const temporaryPassword = data.password || `Tmp-${crypto.randomBytes(12).toString("base64url")}aA1!`;
    const passwordError = validatePasswordAgainstPolicy(temporaryPassword, DEFAULT_PASSWORD_POLICY);
    if (passwordError) return res.status(400).send({ message: passwordError });
    const passwordHash = await hashPassword(temporaryPassword);
    const candidateExistingUser = await db("o_user")
      .where("name", data.name)
      .select("id")
      .first();
    const candidateExistingUserId = Number(candidateExistingUser?.id || 0);

    const result = await db.transaction(async (trx) => {
      const { workspace, role: actorRole } = await requireLiveWorkspaceAuthority({
        database: trx,
        actorUserId,
        additionalUserIds: candidateExistingUserId
          ? [candidateExistingUserId]
          : [],
        additionalMemberUserIds: candidateExistingUserId
          ? [candidateExistingUserId]
          : [],
        authenticatedWorkspaceId,
        workspaceId,
        permission: "member:write",
      });
      await assertMembershipFeature(workspaceId, "shared", trx);
      const now = Date.now();
      const existingUser = await trx("o_user")
        .where("name", data.name)
        .forUpdate()
        .first();
      if (
        existingUser
        && Number(existingUser.id || 0) !== candidateExistingUserId
      ) {
        throw new Error("WORKSPACE_TARGET_IDENTITY_CHANGED");
      }
      let userId = existingUser?.id ? Number(existingUser.id) : 0;
      if (userId && Number(workspace.ownerUserId || 0) === userId) {
        throw new Error("WORKSPACE_OWNER_TRANSFER_UNAVAILABLE");
      }
      const existingMember = userId
        ? await trx("o_workspace_member").where({ workspaceId, userId }).forUpdate().first()
        : null;
      if (existingMember?.role === "owner") {
        throw new Error("WORKSPACE_OWNER_TRANSFER_UNAVAILABLE");
      }
      if (existingMember) {
        assertWorkspaceMemberMutation({
          actorUserId,
          ownerUserId: workspace.ownerUserId,
          actorRole,
          targetUserId: userId,
          targetRole: existingMember.role,
          changesAuthority: true,
        });
      }
      assertWorkspaceRoleAssignment({ actorUserId, ownerUserId: workspace.ownerUserId,
        actorRole, targetUserId: userId, targetRole: existingMember?.role, role: data.role });
      if (!existingMember || existingMember.status !== "active") {
        await assertWorkspaceMemberLimit(workspaceId, 1, trx, now);
      }

      if (!existingUser) {
        userId = await insertAndReturnId(trx, "o_user", {
          name: data.name,
          email: null,
          displayName: data.name,
          password: passwordHash,
          passwordChangedAt: now,
          emailVerifiedAt: null,
          role: "member",
          status: "active",
          currentWorkspaceId: workspaceId,
          defaultWorkspaceId: workspaceId,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: null,
        });
        if (!userId) throw new Error("USER_CREATE_FAILED");
      }

      if (existingMember) {
        // Reactivation and role replacement never revive credentials issued
        // before this deliberate membership change.
        await revokeWorkspaceMemberAccess({ workspaceId, userId, database: trx });
        await trx("o_workspace_member").where({ id: existingMember.id }).update({
          role: data.role,
          status: "active",
          permissions: null,
          quotaLimit: data.quotaLimit ?? null,
          rateLimitPerMinute: data.rateLimitPerMinute ?? null,
          notes: data.notes || null,
          updatedAt: now,
        });
      } else {
        await trx("o_workspace_member").insert({
          id: uuid(),
          workspaceId,
          userId,
          role: data.role,
          status: "active",
          permissions: null,
          quotaLimit: data.quotaLimit ?? null,
          rateLimitPerMinute: data.rateLimitPerMinute ?? null,
          notes: data.notes || null,
          createdAt: now,
          updatedAt: now,
        });
      }

      await writeAuditLog(req, {
        workspaceId,
        action: "workspace.member.create",
        resourceType: "workspace_member",
        resourceId: userId,
        required: true,
        metadata: {
          name: data.name,
          role: data.role,
          existingUser: Boolean(existingUser),
        },
      }, trx);
      return { userId, existingUser: Boolean(existingUser) };
    });

    return res.status(200).send(
      success({
        userId: result.userId,
        workspaceId,
        name: data.name,
        role: data.role,
        temporaryPassword: result.existingUser || data.password ? null : temporaryPassword,
      }),
    );
  } catch (err: any) {
    if (err instanceof MembershipError) {
      return res.status(err.status).send({ message: err.message, code: err.code });
    }
    if (err instanceof WorkspaceAuthorityError) {
      return res.status(err.status).send({ message: err.message, code: err.code });
    }
    if (err instanceof WorkspaceLimitError) {
      return res.status(err.status).send({ message: err.message, code: err.code, details: err.details });
    }
    if (String(err?.message || "") === "WORKSPACE_INACTIVE") {
      return res.status(403).send({ message: "工作区不可用", code: "WORKSPACE_INACTIVE" });
    }
    if (String(err?.message || "") === "USER_CREATE_FAILED") {
      return res.status(500).send({ message: "用户创建失败" });
    }
    if (String(err?.message || "") === "WORKSPACE_TARGET_IDENTITY_CHANGED") {
      return res.status(409).send({
        message: "目标账号状态已变化，请重试",
        code: "WORKSPACE_TARGET_IDENTITY_CHANGED",
      });
    }
    if (String(err?.message || "") === "WORKSPACE_OWNER_TRANSFER_UNAVAILABLE") {
      return res.status(403).send({
        message: "通用成员接口不支持 owner 变更",
        code: "WORKSPACE_OWNER_TRANSFER_UNAVAILABLE",
      });
    }
    if (String(err?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send({
        message: "审计写入失败，成员未创建",
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      });
    }
    throw err;
  }
});
