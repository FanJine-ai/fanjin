import express from "express";
import { z } from "zod";
import { previewWorkspaceInvitation, WorkspaceInvitationError } from "@/lib/workspaceInvitations";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

const bodySchema = z.object({
  token: z.string().min(16),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    return res.status(200).send(success(await previewWorkspaceInvitation(parsed.data.token)));
  } catch (err: any) {
    if (err instanceof WorkspaceInvitationError) return res.status(err.status).send(error(err.message));
    throw err;
  }
});
