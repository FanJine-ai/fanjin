import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string().trim().min(1, "项目名称不能为空").max(255),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    directorManual: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    projectType: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
  }),
  async (req, res) => {
    const { id, name, intro, type, artStyle, videoRatio, directorManual, imageModel, videoModel, imageQuality, projectType, mode } = req.body;

    const user = (req as any).auth?.user || {};
    const access = await checkProjectPermission({
      projectId: id,
      userId: Number(user.id || 0),
      role: user.role,
      permission: "project:write",
    });
    if (!access.allowed) return res.status(access.status).send(error(access.message));

    await u.db("o_project").where("id", id).update({
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      directorManual,
      imageModel,
      videoModel,
      imageQuality,
      projectType,
      mode,
      revision: db.raw("?? + 1", ["revision"]),
      updatedAt: Date.now(),
    });

    res.status(200).send(success({ message: "编辑项目成功" }));
  },
);
