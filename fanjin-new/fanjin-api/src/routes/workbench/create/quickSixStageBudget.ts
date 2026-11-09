import express from "express";
import { z } from "zod";

import {
  QUICK_SIX_STAGE_GU_BUDGET_VERSION,
  QuickSixStageGuBudgetError,
  resolveQuickSixStageGuBudgetExposure,
} from "@/lib/quickSixStageGuBudget";
import {
  buildDirectorPlanPrompt,
  normalizeDirectorInput,
} from "@/lib/quickCreate";
import { resolveRelayPrincipalId } from "@/lib/relayUtils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

const modelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const directorSchema = z.object({
  brief: z.string().min(1).max(12_000),
  style: z.string().min(1).max(1_000),
  targetType: z.literal("广告视频"),
  ratio: z.literal("16:9"),
  duration: z.number().positive().max(3_600),
  shotCount: z.literal(1),
});

export default router.post(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  requireProjectPermission("project:read"),
  validateFields({
    version: z.literal(QUICK_SIX_STAGE_GU_BUDGET_VERSION),
    projectId: z.number().int().positive(),
    textModel: modelId,
    imageModel: modelId,
    imageQuality: z.enum(["1K", "2K", "4K"]),
    videoModel: modelId,
    videoDuration: z.number().positive().max(3_600),
    director: directorSchema,
  }),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    if (!workspaceId) {
      return res.status(401).send({
        message: "工作区身份无效",
        code: "QUICK_SIX_STAGE_GU_WORKSPACE_REQUIRED",
      });
    }
    if (Number(req.body.videoDuration) !== Number(req.body.director.duration)) {
      return res.status(422).send({
        message: "导演计划与视频生成时长必须一致",
        code: "QUICK_SIX_STAGE_GU_DURATION_MISMATCH",
      });
    }
    const director = normalizeDirectorInput({
      ...req.body.director,
      projectId: req.body.projectId,
    });
    const principal = resolveRelayPrincipalId(req) || "workspace";
    try {
      const exposure = await resolveQuickSixStageGuBudgetExposure({
        workspaceId,
        textModel: req.body.textModel,
        imageModel: req.body.imageModel,
        imageQuality: req.body.imageQuality,
        videoModel: req.body.videoModel,
        videoDuration: req.body.videoDuration,
        textMaxOutputTokens: 4_096,
        textRequestPayload: {
          model: req.body.textModel,
          messages: [{
            role: "user",
            content: buildDirectorPlanPrompt(director),
          }],
          temperature: 0.3,
          max_tokens: 4_096,
          stream: false,
          user: `quick-create-director:${principal}`,
        },
      });
      return res.status(200).send(success(exposure));
    } catch (error) {
      if (error instanceof QuickSixStageGuBudgetError) {
        return res.status(error.status).send({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  },
);
