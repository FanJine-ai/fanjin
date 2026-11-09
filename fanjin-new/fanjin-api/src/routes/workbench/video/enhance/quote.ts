import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import {
  quoteConfiguredUserVideoEnhance,
  selectUpscaleChannel,
  UserVideoEnhanceError,
} from "@/lib/videoFulfillment/userEnhance";

const router = express.Router();

export const bodySchema = z.object({
  sourceResolution: z.string().min(1),
  targetResolution: z.string().min(1),
  durationSeconds: z.number().nonnegative().optional().nullable(),
});

/** Workbench-only estimate. Create always re-reads owned asset duration. */
export default router.post("/", requireActiveWorkspacePermission("generation:create"), async (req, res) => {
  try {
    const body = bodySchema.parse(req.body || {});
    const workspaceId = String((req as any).auth?.workspaceId || "");
    const quote = await quoteConfiguredUserVideoEnhance({ ...body, authoritativeDuration: false }, workspaceId);
    if (!quote.allowed) {
      return res.status(400).send(error(quote.reason || "无法报价", {
        code: quote.reasonCode || "ENHANCE_NOT_ALLOWED",
        quote,
      }));
    }
    const channel = await selectUpscaleChannel({
      workspaceId,
      targetResolution: quote.targetResolution,
    });
    if (!channel) {
      return res.status(503).send(error("当前没有可用的视频增强通道", {
        code: "ENHANCE_CHANNEL_UNAVAILABLE",
      }));
    }
    return res.status(200).send(success({ quote }));
  } catch (err: any) {
    if (err instanceof UserVideoEnhanceError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (err instanceof z.ZodError) {
      return res.status(400).send(error("报价参数错误", { code: "ENHANCE_QUOTE_INVALID" }));
    }
    console.error("[workbench-video-enhance] quote failed");
    return res.status(500).send(error("画质增强报价失败", { code: "ENHANCE_QUOTE_FAILED" }));
  }
});
