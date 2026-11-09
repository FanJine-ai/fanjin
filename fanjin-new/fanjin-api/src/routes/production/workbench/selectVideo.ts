import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { shouldQuarantineRelayArtifacts } from "@/lib/relayMockPolicy";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: z.number(),
    trackId: z.number(),
    videoId: z.number(),
  }),
  async (req, res) => {
    const { projectId, trackId, videoId } = req.body;
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "production:workbench:select-video",
        request: { projectId, trackId, videoId },
        mutate: async (transaction) => {
          const [track, video] = await Promise.all([
            transaction("o_videoTrack")
              .where({ id: trackId, projectId })
              .select("id", "projectId")
              .first(),
            transaction("o_video as video")
              .leftJoin("o_relay_task as relay", "relay.id", "video.relayTaskId")
              .where({
                "video.id": videoId,
                "video.videoTrackId": trackId,
                "video.projectId": projectId,
              })
              .select(
                "video.id",
                "video.state",
                "video.filePath",
                "relay.status as relayStatus",
              )
              .first(),
          ]);
          if (!track || !video) {
            const missing = new Error("视频或分镜不存在") as Error & {
              status?: number;
            };
            missing.status = 404;
            throw missing;
          }
          if (
            !["已完成", "生成成功"].includes(String(video.state || ""))
            || !String(video.filePath || "").trim()
            || shouldQuarantineRelayArtifacts(video.relayStatus)
          ) {
            const unavailable = new Error(
              "只有已完成且可交付的视频可以设为成片",
            ) as Error & { status?: number };
            unavailable.status = 409;
            throw unavailable;
          }
          await transaction("o_videoTrack")
            .where({ id: trackId, projectId })
            .update({ videoId });
          return { message: "视频选择成功" };
        },
      });
      return res
        .status(result.responseStatus)
        .send(success(result.data));
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  },
);
