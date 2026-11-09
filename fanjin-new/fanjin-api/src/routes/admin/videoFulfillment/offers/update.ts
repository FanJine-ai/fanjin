import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  AdminFulfillmentError,
  updateOfferWithDisplayName,
} from "@/lib/videoFulfillment/adminService";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  publicModel: z.string().trim().min(1),
  displayName: z.string().trim().max(200).optional(),
  visibleResolutions: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

/** upsert 公开能力 offer;displayName 同步到 o_model_route(唯一真相源)。 */
export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).send(error("参数错误", { errors: parsed.error.issues }));
  }
  try {
    const { offer, updatedModelRoutes } = await updateOfferWithDisplayName(db as any, parsed.data);
    await writeAuditLog(req, {
      workspaceId: null,
      action: "admin.video_fulfillment.offer_update",
      resourceType: "video_public_offer",
      resourceId: offer.id,
      metadata: { publicModel: offer.publicModel, displayName: offer.displayName, updatedModelRoutes },
    });
    return res.status(200).send(success({ offer, updatedModelRoutes }, "已保存"));
  } catch (err: any) {
    if (err instanceof AdminFulfillmentError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    return res.status(400).send(error(err?.message || "保存失败"));
  }
});
