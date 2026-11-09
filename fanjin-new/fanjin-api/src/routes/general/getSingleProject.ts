import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isPlatformAdmin } from "@/middleware/permissions";
const router = express.Router();

// 获取单个项目
export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;

    const query = u.db("o_project")
      .where({ id, deletionState: "active" })
      .select("*");
    if (!isPlatformAdmin(req)) query.andWhere("workspaceId", (req as any).auth?.workspaceId || "default");
    const project = await query.first();
    if (!project) {
      return res.status(404).send(error("项目不存在或无权访问"));
    }

    return res.status(200).send(success([project]));
  }
);
