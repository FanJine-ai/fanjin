import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { db } from "@/utils/db";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    prompt: z.string().trim().min(1),
    videoDesc: z.string().trim().min(1),
    duration: z.number().positive().max(30).optional(),
    shouldGenerateImage: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
  async (req, res) => {
    const { id, prompt, videoDesc, duration, shouldGenerateImage } = req.body;
    const workspaceId = String(
      (req as any).project?.workspaceId
      || (req as any).auth?.workspaceId
      || "",
    ).trim();
    const result = await db.transaction(async (transaction) => {
      const storyboard = await transaction("o_storyboard as storyboard")
        .innerJoin("o_project as project", "project.id", "storyboard.projectId")
        .where({
          "storyboard.id": id,
          "project.workspaceId": workspaceId,
          "project.deletionState": "active",
        })
        .forUpdate()
        .select(
          "storyboard.id",
          "storyboard.projectId",
          "storyboard.scriptId",
          "storyboard.trackId",
        )
        .first();
      if (!storyboard) return null;

      const trackId = Number(storyboard.trackId || 0);
      const projectId = Number(storyboard.projectId || 0);
      const scriptId = Number(storyboard.scriptId || 0);
      if (!trackId || !projectId || !scriptId) return null;

      const track = await transaction("o_videoTrack")
        .where({
          id: trackId,
          projectId,
          scriptId,
        })
        .forUpdate()
        .select("id")
        .first();
      if (!track) return null;

      const updateData: Record<string, unknown> = {
        prompt,
        videoDesc,
      };
      if (duration !== undefined) updateData.duration = duration;
      if (shouldGenerateImage !== undefined) {
        updateData.shouldGenerateImage = shouldGenerateImage;
      }
      const updated = await transaction("o_storyboard")
        .where({
          id,
          projectId,
          scriptId,
          trackId,
        })
        .update(updateData);
      if (Number(updated) !== 1) return null;

      // A track may contain more than one storyboard in legacy/batch-created
      // projects. Rebuild the provider-facing values from every bound
      // storyboard so editing one shot cannot leave production with stale
      // prompt or duration data.
      const boundStoryboards = await transaction("o_storyboard")
        .where({
          projectId,
          scriptId,
          trackId,
        })
        .orderBy("index", "asc")
        .orderBy("id", "asc")
        .select("prompt", "videoDesc", "duration");
      const trackPrompt = boundStoryboards
        .map((item) => String(item.videoDesc || item.prompt || "").trim())
        .filter(Boolean)
        .join("\n");
      const trackDuration = boundStoryboards.reduce(
        (sum, item) => sum + Number(item.duration || 0),
        0,
      );
      if (!trackPrompt || !Number.isFinite(trackDuration) || trackDuration <= 0) {
        throw new Error("分镜绑定的生产轨道缺少有效提示词或时长");
      }
      const trackUpdated = await transaction("o_videoTrack")
        .where({
          id: trackId,
          projectId,
          scriptId,
        })
        .update({
          prompt: trackPrompt,
          duration: trackDuration,
        });
      if (Number(trackUpdated) !== 1) return null;

      return {
        message: "更新提示词成功",
        storyboardId: id,
        trackId,
        trackPrompt,
        trackDuration,
      };
    });
    if (!result) {
      return res.status(404).send({ message: "分镜不存在" });
    }
    return res.status(200).send(success(result));
  },
);
