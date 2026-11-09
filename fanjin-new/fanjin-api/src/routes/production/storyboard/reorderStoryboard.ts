import express from "express";
import u from "@/utils";
import { db } from "@/utils/db";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { projectId, scriptId, ids } = req.body;
    if (!ids.length) return res.status(400).send(error("分镜排序不能为空"));

    const rows = await u.db("o_storyboard").where({ projectId, scriptId }).whereIn("id", ids).select("id");
    if (rows.length !== ids.length) return res.status(400).send(error("分镜排序数据不完整"));

    await db.transaction(async (trx) => {
      for (const [index, id] of ids.entries()) {
        await trx("o_storyboard")
          .where({ id, projectId, scriptId })
          .update({ index: index + 1 });
      }
    });

    res.status(200).send(success({ message: "分镜顺序已保存" }));
  },
);
