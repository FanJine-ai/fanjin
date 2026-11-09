import express from "express";
import { z } from "zod";
import { createWorkspaceInvitation, WorkspaceInvitationError } from "@/lib/workspaceInvitations";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { WorkspaceLimitError } from "@/lib/workspaceLimits";
import { MembershipError } from "@/lib/membershipCatalog";
import { normalizeActorRole, type AuditContext } from "@/lib/audit";
import { WorkspaceAuthorityError } from "@/lib/workspaceAccess";

const router = express.Router();
router.use(requireWorkspacePermission("member:write"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  email: z.string().email(),
  role: z.enum(["workspace_admin", "creator"]).default("creator"),
}).strict();

function requestOrigin(req: express.Request): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol;
  return `${proto}://${req.get("host")}`;
}

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
    const data = await createWorkspaceInvitation({
      workspaceId,
      email: parsed.data.email,
      role: parsed.data.role,
      inviterUserId: Number(user.id || 0) || null,
      authenticatedWorkspaceId:
        (req as { auth?: { workspaceId?: string | null } }).auth?.workspaceId
        ?? null,
      origin: requestOrigin(req),
      auditContext,
    });
    return res.status(200).send(success(data));
  } catch (err: unknown) {
    if (err instanceof MembershipError) {
      return res.status(err.status).send({ message: err.message, code: err.code });
    }
    if (err instanceof WorkspaceLimitError) {
      return res.status(err.status).send({ message: err.message, code: err.code, details: err.details });
    }
    if (err instanceof WorkspaceAuthorityError) {
      return res.status(err.status).send({ message: err.message, code: err.code });
    }
    if (err instanceof WorkspaceInvitationError) {
      return res.status(err.status).send({ message: err.message });
    }
    throw err;
  }
});
