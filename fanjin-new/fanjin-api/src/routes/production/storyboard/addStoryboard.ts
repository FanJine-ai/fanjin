import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { insertAndReturnId, isPostgresClient } from "@/lib/dbDialect";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    prompt: z.string().trim().min(1),
    duration: z.number().positive().max(30),
    state: z.enum(["未生成", "生成中", "已完成", "生成失败"]),
    videoDesc: z.string().trim().min(1),
    shouldGenerateImage: z.union([z.literal(0), z.literal(1)]),
    src: z.string().nullable(),
    scriptId: z.number(),
    projectId: z.number(),
    track: z.string().trim().optional(),
  }),
  async (req, res) => {
    const {
      prompt,
      duration,
      state,
      src,
      scriptId,
      projectId,
      videoDesc,
      shouldGenerateImage,
      track,
    } = req.body;
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "storyboard:add",
        request: {
          prompt,
          duration,
          state,
          src,
          scriptId,
          projectId,
          videoDesc,
          shouldGenerateImage,
          track,
        },
        mutate: async (transaction) => {
          let scriptQuery = transaction("o_script")
            .where({ id: scriptId, projectId })
            .select("id");
          if (isPostgresClient(transaction)) scriptQuery = scriptQuery.forUpdate();
          const script = await scriptQuery.first();
          if (!script) {
            const missing = new Error("剧本不存在") as Error & { status?: number };
            missing.status = 404;
            throw missing;
          }

          const lastStoryboard = (await transaction("o_storyboard")
            .where({ scriptId, projectId })
            .max("index as maxIndex")
            .first()) as { maxIndex?: number | string | null } | undefined;
          const nextIndex = Number(lastStoryboard?.maxIndex || 0) + 1;
          const trackId = await insertAndReturnId(transaction, "o_videoTrack", {
            scriptId,
            projectId,
            duration,
            state: "未生成",
            prompt: videoDesc || prompt,
          });
          const id = await insertAndReturnId(transaction, "o_storyboard", {
            prompt,
            duration,
            state,
            filePath: u.replaceUrl(src),
            trackId,
            track: track || null,
            videoDesc,
            shouldGenerateImage,
            scriptId,
            projectId,
            index: nextIndex,
          });
          return { id, trackId };
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
