import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isRecoverableWorkbenchRelayVideo, syncWorkbenchVideoRelay, videoFileUrl } from "@/lib/workbenchVideoRelay";
import { projectWorkbenchRelayVideoForPublic } from "@/lib/workbenchRelayPublicProjection";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const storyboardList = await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
    const videoList = await u.db("o_video").whereIn(
      "videoTrackId",
      storyboardList.map((s) => s.trackId),
    );
    await Promise.all(videoList.filter(isRecoverableWorkbenchRelayVideo).map(syncWorkbenchVideoRelay));
    const refreshedVideoList = await u
      .db("o_video")
      .whereIn(
        "videoTrackId",
        storyboardList.map((s) => s.trackId),
      )
      .leftJoin("o_relay_task as relay", "relay.id", "o_video.relayTaskId")
      .select("o_video.*", "relay.status as relayStatus");
    res.status(200).send(
      success(
        await Promise.all(refreshedVideoList.map(async (s) => {
          const publicVideo = projectWorkbenchRelayVideoForPublic({
            state: s.state,
            filePath: s.filePath,
            errorReason: s.errorReason,
            relayStatus: s.relayStatus,
          });
          return {
            ...s,
            state: publicVideo.state,
            filePath: publicVideo.filePath,
            errorReason: publicVideo.errorReason,
            relayStatus: publicVideo.relayStatus,
            src: await videoFileUrl(publicVideo.filePath),
          };
        })),
      ),
    );
  },
);
