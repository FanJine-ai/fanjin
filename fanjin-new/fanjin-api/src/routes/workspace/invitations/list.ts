import express from "express";
import { z } from "zod";
import { listWorkspaceInvitations } from "@/lib/workspaceInvitations";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("member:read"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = parsed.data.workspaceId || (req as any).auth?.workspaceId || "default";
  return res.status(200).send(success(await listWorkspaceInvitations(workspaceId)));
});
