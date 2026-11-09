import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isPlatformAdmin } from "@/middleware/permissions";
const router = express.Router();

// 获取项目概览统计
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;
    const projectQuery = u.db("o_project")
      .where({ id: projectId, deletionState: "active" });
    if (!isPlatformAdmin(req)) projectQuery.andWhere("workspaceId", (req as any).auth?.workspaceId || "default");
    const project = await projectQuery.first();
    if (!project) return res.status(404).send(error("项目不存在或无权访问"));

    const scripts = await u.db("o_script").where("projectId", projectId).select("id");
    const scriptIds = scripts.map((item: any) => item.id);

    const roleCount: any = await u.db("o_assets").where("projectId", projectId).where("type", "角色").count("* as total").first();
    const scriptCount: any = await u.db("o_script").where("projectId", projectId).count("* as total").first();
    const videoCount: any = await u.db("o_video").whereIn("scriptId", scriptIds).count("* as total").first();
    const storyboardCount: any = await u.db("o_assets").whereIn("scriptId", scriptIds).where("type", "分镜").count("* as total").first();

    const data = {
      roleCount: roleCount?.total || 0,
      scriptCount: scriptCount?.total || 0,
      videoCount: videoCount?.total || 0,
      storyboardCount: storyboardCount?.total || 0,
    };

    res.status(200).send(success(data));
  }
);
