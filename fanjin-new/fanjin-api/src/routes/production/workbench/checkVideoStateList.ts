import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isRecoverableWorkbenchRelayVideo, syncWorkbenchVideoRelay, videoFileUrl } from "@/lib/workbenchVideoRelay";
import { syncVideoTaskState } from "@/lib/videoTaskState";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { projectWorkbenchRelayVideoForPublic } from "@/lib/workbenchRelayPublicProjection";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    videoIds: z.array(z.number()),
  }),
  async (req, res) => {
    const { projectId, scriptId, videoIds } = req.body;
    const pendingVideos = await u.db("o_video").whereIn("id", videoIds).where({ projectId, scriptId }).select("*");
    await Promise.all(pendingVideos.filter(isRecoverableWorkbenchRelayVideo).map(syncWorkbenchVideoRelay));

    const videoList = await u
      .db("o_video as video")
      .leftJoin("o_relay_task as relay", "relay.id", "video.relayTaskId")
      .whereIn("video.id", videoIds)
      .where({
        "video.projectId": projectId,
        "video.scriptId": scriptId,
      })
      .whereIn("video.state", ["生成成功", "生成失败"])
      .select(
        "video.id",
        "video.state",
        "video.errorReason",
        "video.filePath",
        "relay.status as relayStatus",
      );
    res.status(200).send(
      success(
        await Promise.all(
          videoList.map(async (s) => {
            const videoId = Number(s.id);
            const publicVideo = projectWorkbenchRelayVideoForPublic({
              state: s.state,
              filePath: s.filePath,
              errorReason: s.errorReason,
              relayStatus: s.relayStatus,
            });
            if (Number.isFinite(videoId) && publicVideo.state === "生成成功") {
              await syncVideoTaskState(videoId, "已完成");
            }
            if (Number.isFinite(videoId) && publicVideo.state === "生成失败") {
              await syncVideoTaskState(
                videoId,
                "生成失败",
                publicVideo.errorReason || "",
              );
            }
            return {
              ...s,
              state: publicVideo.state,
              filePath: publicVideo.filePath,
              relayStatus: publicVideo.relayStatus,
              errorReason: redactSensitiveText(publicVideo.errorReason),
              src: await videoFileUrl(publicVideo.filePath),
            };
          }),
        ),
      ),
    );
  },
);
