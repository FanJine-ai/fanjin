import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isPlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";
const router = express.Router();

// 修改项目
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    intro: z.string().optional().nullable(),
    type: z.string().optional().nullable(),
    artStyle: z.string().optional().nullable(),
    videoRatio: z.string().optional().nullable(),
    projectType: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { id, intro, type, artStyle, videoRatio, projectType } = req.body;

    const query = u.db("o_project").where("id", id);
    if (!isPlatformAdmin(req)) query.andWhere("workspaceId", (req as any).auth?.workspaceId || "default");

    await query.update({
      intro,
      type,
      artStyle,
      videoRatio,
      projectType,
      revision: db.raw("?? + 1", ["revision"]),
      updatedAt: Date.now(),
    });

    res.status(200).send(success({ message: "修改成功" }));
  },
);
