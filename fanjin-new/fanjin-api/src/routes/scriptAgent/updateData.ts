import express, { NextFunction, Request, Response } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { checkProjectPermission } from "@/middleware/projectAccess";
const router = express.Router();

async function requireAgentWorkDataPermission(req: Request, res: Response, next: NextFunction) {
  const id = Number(req.body?.id || 0);
  const row = id ? await u.db("o_agentWorkData").where({ id }).select("projectId").first() : null;
  if (!row?.projectId) return res.status(404).send({ message: "Agent 工作数据不存在" });

  const user = (req as any).auth?.user || (req as any).user || {};
  const result = await checkProjectPermission({
    projectId: Number(row.projectId),
    userId: Number(user.id || 0),
    role: user.role,
    permission: "project:write",
  });
  if (!result.allowed) return res.status(result.status).send({ message: result.message });
  return next();
}

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    data: z.object({
      storySkeleton: z.string(),
      adaptationStrategy: z.string(),
      script: z.array(
        z.object({
          id: z.number(),
          content: z.string(),
        }),
      ),
    }),
  }),
  requireAgentWorkDataPermission,
  async (req, res) => {
    const { id, data } = req.body;
    await u
      .db("o_agentWorkData")
      .where({ id: id })
      .update({
        data: JSON.stringify(data),
      });
    res.status(200).send(success("更新成功"));
  },
);
