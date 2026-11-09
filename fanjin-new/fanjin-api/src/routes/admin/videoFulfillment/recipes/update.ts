import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { VIDEO_FULFILLMENT_RECIPE_TABLE } from "@/lib/migrations/videoFulfillmentRecipe";
import {
  AdminFulfillmentError,
  findSimilarRecipeWarnings,
  validateRecipePayload,
} from "@/lib/videoFulfillment/adminService";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().trim().min(1),
  // 全量编辑:除 publicModel/targetResolution 由既有行提供外,其余字段均可改;
  // 行内编辑(权重/次序/启用)也只传这几个字段。
  name: z.string().trim().max(200).optional(),
  generateChannelId: z.string().trim().min(1).optional(),
  generateResolution: z.string().min(1).optional(),
  upstreamModel: z.string().trim().optional().nullable(),
  enhanceEnabled: z.boolean().optional(),
  enhanceChannelId: z.string().trim().optional().nullable(),
  weight: z.number().int().min(0).optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).send(error("参数错误", { errors: parsed.error.issues }));
  }
  const { id, ...patch } = parsed.data;
  try {
    const existing = await (db as any)(VIDEO_FULFILLMENT_RECIPE_TABLE).where({ id }).first();
    if (!existing) return res.status(404).send(error("配方不存在", { code: "RECIPE_NOT_FOUND" }));

    const enhanceEnabled = patch.enhanceEnabled ?? Boolean(Number(existing.enhanceEnabled || 0));
    const { payload, warnings } = await validateRecipePayload(db as any, {
      publicModel: String(existing.publicModel),
      targetResolution: String(existing.targetResolution),
      name: patch.name ?? String(existing.name || ""),
      generateChannelId: patch.generateChannelId ?? String(existing.generateChannelId),
      generateResolution: patch.generateResolution ?? String(existing.generateResolution),
      upstreamModel: patch.upstreamModel !== undefined ? patch.upstreamModel : existing.upstreamModel,
      enhanceEnabled,
      enhanceChannelId: patch.enhanceChannelId !== undefined ? patch.enhanceChannelId : existing.enhanceChannelId,
      weight: patch.weight ?? Number(existing.weight || 0),
      priority: patch.priority ?? Number(existing.priority || 100),
      enabled: patch.enabled ?? Boolean(Number(existing.enabled || 0)),
    });
    const duplicateWarnings = await findSimilarRecipeWarnings(db as any, payload, id);

    await (db as any)(VIDEO_FULFILLMENT_RECIPE_TABLE).where({ id }).update({
      name: payload.name,
      generateChannelId: payload.generateChannelId,
      generateResolution: payload.generateResolution,
      upstreamModel: payload.upstreamModel,
      enhanceEnabled: payload.enhanceEnabled ? 1 : 0,
      enhanceChannelId: payload.enhanceChannelId,
      weight: payload.weight,
      priority: payload.priority,
      enabled: payload.enabled ? 1 : 0,
      updatedAt: Date.now(),
    });
    const recipe = await (db as any)(VIDEO_FULFILLMENT_RECIPE_TABLE).where({ id }).first();

    await writeAuditLog(req, {
      workspaceId: null,
      action: "admin.video_fulfillment.recipe_update",
      resourceType: "video_fulfillment_recipe",
      resourceId: id,
      metadata: { patch: parsed.data },
    });
    return res.status(200).send(success({ recipe, warnings: [...warnings, ...duplicateWarnings] }, "已更新"));
  } catch (err: any) {
    if (err instanceof AdminFulfillmentError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    return res.status(400).send(error(err?.message || "更新失败"));
  }
});
