import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { createRecipe } from "@/lib/videoFulfillment/recipes";
import {
  AdminFulfillmentError,
  findSimilarRecipeWarnings,
  validateRecipePayload,
} from "@/lib/videoFulfillment/adminService";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  publicModel: z.string().trim().min(1),
  targetResolution: z.string().min(1),
  name: z.string().trim().max(200).optional().default(""),
  generateChannelId: z.string().trim().min(1),
  generateResolution: z.string().min(1),
  upstreamModel: z.string().trim().optional().nullable(),
  enhanceEnabled: z.boolean().default(false),
  enhanceChannelId: z.string().trim().optional().nullable(),
  weight: z.number().int().min(0).default(100),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).send(error("参数错误", { errors: parsed.error.issues }));
  }
  try {
    const { payload, warnings } = await validateRecipePayload(db as any, parsed.data);
    const duplicateWarnings = await findSimilarRecipeWarnings(db as any, payload);
    const recipe = await createRecipe(db as any, payload);
    await writeAuditLog(req, {
      workspaceId: null,
      action: "admin.video_fulfillment.recipe_create",
      resourceType: "video_fulfillment_recipe",
      resourceId: recipe.id,
      metadata: {
        publicModel: recipe.publicModel,
        targetResolution: recipe.targetResolution,
        generateChannelId: recipe.generateChannelId,
        enhanceChannelId: recipe.enhanceChannelId,
      },
    });
    return res.status(200).send(success({ recipe, warnings: [...warnings, ...duplicateWarnings] }, "配方已创建"));
  } catch (err: any) {
    if (err instanceof AdminFulfillmentError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    const message = String(err?.message || "");
    if (message === "RECIPE_RESOLUTION_INVALID") {
      return res.status(400).send(error("配方分辨率不合法:无感目标须为公开档;开启超分时原生分辨率须低于目标", { code: message }));
    }
    if (message === "ENHANCE_CHANNEL_REQUIRED") {
      return res.status(400).send(error("开启超分时必须选择超分通道", { code: message }));
    }
    return res.status(400).send(error(err?.message || "创建失败"));
  }
});
