import express from "express";
import { z } from "zod";

import {
  CANVAS_CHAIN_GU_BUDGET_VERSION,
  CanvasChainGuBudgetError,
  resolveCanvasChainGuBudgetExposure,
} from "@/lib/canvasChainGuBudget";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();
const modelId = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export default router.post(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  requireProjectPermission("project:read"),
  validateFields({
    version: z.literal(CANVAS_CHAIN_GU_BUDGET_VERSION),
    projectId: z.number().int().positive(),
    imageModel: modelId,
    imageQuality: z.enum(["1K", "2K", "4K"]),
    imageCalls: z.literal(1),
    videoModel: modelId,
    videoResolution: z.enum(["720p", "1080p"]),
    videoDuration: z.number().positive().max(3_600),
    videoMode: z.literal("image_to_video"),
    generateAudio: z.literal(false),
    videoCalls: z.literal(1),
  }),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    if (!workspaceId) {
      return res.status(401).send({
        message: "工作区身份无效",
        code: "CANVAS_CHAIN_GU_WORKSPACE_REQUIRED",
      });
    }
    try {
      const exposure = await resolveCanvasChainGuBudgetExposure({
        workspaceId,
        imageModel: req.body.imageModel,
        imageQuality: req.body.imageQuality,
        videoModel: req.body.videoModel,
        videoResolution: req.body.videoResolution,
        videoDuration: req.body.videoDuration,
        videoMode: req.body.videoMode,
        generateAudio: req.body.generateAudio,
      });
      return res.status(200).send(success(exposure));
    } catch (error) {
      if (error instanceof CanvasChainGuBudgetError) {
        return res.status(error.status).send({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  },
);
