import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { VIDEO_FULFILLMENT_RECIPE_TABLE } from "@/lib/migrations/videoFulfillmentRecipe";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().trim().min(1),
});

/** 硬删除配方;停用走 recipes/update(enabled=false)。 */
export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).send(error("参数错误", { errors: parsed.error.issues }));
  }
  const { id } = parsed.data;
  try {
    const existing = await (db as any)(VIDEO_FULFILLMENT_RECIPE_TABLE).where({ id }).first();
    if (!existing) return res.status(404).send(error("配方不存在", { code: "RECIPE_NOT_FOUND" }));
    await (db as any)(VIDEO_FULFILLMENT_RECIPE_TABLE).where({ id }).delete();
    await writeAuditLog(req, {
      workspaceId: null,
      action: "admin.video_fulfillment.recipe_delete",
      resourceType: "video_fulfillment_recipe",
      resourceId: id,
      metadata: {
        publicModel: existing.publicModel,
        targetResolution: existing.targetResolution,
        name: existing.name,
      },
    });
    return res.status(200).send(success({ id }, "配方已删除"));
  } catch (err: any) {
    return res.status(400).send(error(err?.message || "删除失败"));
  }
});
