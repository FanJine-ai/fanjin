import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { AuthError, switchWorkspace } from "@/lib/auth";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

const bodySchema = z.object({
  workspaceId: z.string().min(1),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const userId = Number((req as any).auth?.user?.id || 0);
    const sessionId = (req as any).auth?.session?.id || (req as any).auth?.user?.sid || null;
    if (!userId) throw new AuthError("未登录", 401);
    const profile = await switchWorkspace(db as any, userId, parsed.data.workspaceId, sessionId);
    return res.status(200).send(success(profile, "工作区已切换"));
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 500;
    return res.status(status).send(error(err?.message || "切换工作区失败"));
  }
});
