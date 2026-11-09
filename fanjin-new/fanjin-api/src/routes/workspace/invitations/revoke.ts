import express from "express";
import { z } from "zod";
import { revokeWorkspaceInvitation, WorkspaceInvitationError } from "@/lib/workspaceInvitations";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { normalizeActorRole, type AuditContext } from "@/lib/audit";
import { WorkspaceAuthorityError } from "@/lib/workspaceAccess";

const router = express.Router();
router.use(requireWorkspacePermission("member:write"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  invitationId: z.string().min(1),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId =
    parsed.data.workspaceId ||
    (req as { auth?: { workspaceId?: string } }).auth?.workspaceId ||
    "default";
  const user =
    (req as { auth?: { user?: { id?: unknown; role?: unknown } } }).auth?.user ||
    {};
  const userRole = typeof user.role === "string" ? user.role : null;
  try {
    const auditContext: AuditContext = {
      ip: req.ip || null,
      userAgent: req.header("user-agent") || null,
      workspaceId,
      actor: {
        actorUserId: Number(user.id || 0) || null,
        actorRole: normalizeActorRole(userRole),
        actorKind: "authenticated",
      },
    };
    const data = await revokeWorkspaceInvitation({
      workspaceId,
      invitationId: parsed.data.invitationId,
      actorUserId: Number(user.id || 0) || null,
      authenticatedWorkspaceId:
        (req as { auth?: { workspaceId?: string | null } }).auth?.workspaceId
        ?? null,
      auditContext,
    });
    return res.status(200).send(success(data));
  } catch (err: unknown) {
    if (err instanceof WorkspaceAuthorityError) {
      return res.status(err.status).send({ message: err.message, code: err.code });
    }
    if (err instanceof WorkspaceInvitationError) return res.status(err.status).send({ message: err.message });
    throw err;
  }
});
