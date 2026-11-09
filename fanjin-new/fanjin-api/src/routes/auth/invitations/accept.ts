import express from "express";
import { z } from "zod";
import { acceptWorkspaceInvitation, WorkspaceInvitationError } from "@/lib/workspaceInvitations";
import { AuthError, resolveSessionFromAuthorization } from "@/lib/auth";
import { db } from "@/utils/db";
import { WorkspaceAuthorityError } from "@/lib/workspaceAccess";
import { error, success } from "@/lib/responseFormat";
import { normalizeActorRole, type AuditContext } from "@/lib/audit";

const router = express.Router();

const bodySchema = z.object({
  token: z.string().min(16),
  password: z.string().min(8).optional().nullable(),
  displayName: z.string().optional().nullable(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const authenticatedSession = await resolveSessionFromAuthorization(
      db as unknown as Parameters<typeof resolveSessionFromAuthorization>[0],
      req.headers.authorization || "",
    );
    const authenticatedUser = authenticatedSession?.user as
      | { id?: unknown; role?: unknown; updatedAt?: unknown }
      | undefined;
    const authenticatedSessionRow = authenticatedSession?.session as
      | { id?: unknown; userId?: unknown; tokenHash?: unknown }
      | undefined;
    const isAuthenticated = Boolean(authenticatedUser);
    const auditContext: AuditContext = {
      ip: req.ip || null,
      userAgent: req.header("user-agent") || null,
      actor: {
        actorUserId: authenticatedUser
          ? Number(authenticatedUser.id) || null
          : null,
        actorRole: isAuthenticated
          ? normalizeActorRole(
              typeof authenticatedUser!.role === "string"
                ? authenticatedUser!.role
                : null,
            )
          : null,
        actorKind: isAuthenticated
          ? "authenticated"
          : "anonymous-registration",
      },
    };
    const result = (await acceptWorkspaceInvitation(
      {
        ...parsed.data,
        authenticatedUserId: authenticatedUser
          ? Number(authenticatedUser.id)
          : null,
        authenticatedSession: authenticatedUser && authenticatedSessionRow
          ? {
              id: String(authenticatedSessionRow.id || ""),
              userId: Number(authenticatedSessionRow.userId || 0),
              tokenHash: String(authenticatedSessionRow.tokenHash || ""),
              authGeneration: Number(authenticatedUser.updatedAt || 0),
            }
          : null,
        auditContext,
      },
      {
        userAgent: Array.isArray(req.headers["user-agent"])
          ? req.headers["user-agent"].join(",")
          : req.headers["user-agent"],
        ip: req.ip,
      },
    )) as { rawToken?: string } & Record<string, unknown>;
    const { rawToken, ...data } = result;
    return res.status(200).send(success(data, "已加入工作区"));
  } catch (err: unknown) {
    if (err instanceof WorkspaceAuthorityError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (err instanceof WorkspaceInvitationError) {
      return res.status(err.status).send(error(err.message));
    }
    if (err instanceof AuthError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});
