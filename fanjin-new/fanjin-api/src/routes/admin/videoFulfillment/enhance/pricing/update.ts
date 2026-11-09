import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  AdminFulfillmentError,
  upsertEnhancePricingRule,
} from "@/lib/videoFulfillment/adminService";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  sourceResolution: z.string().min(1),
  targetResolution: z.string().min(1),
  unitPriceMicros: z.number().int().min(0),
  unit: z.string().trim().optional(),
  disabled: z.boolean().optional(),
  name: z.string().trim().max(200).optional(),
});

/** video_enhance 价目 upsert(o_pricing_rule,endpointType=video_enhance)。 */
export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).send(error("参数错误", { errors: parsed.error.issues }));
  }
  try {
    const rule = await upsertEnhancePricingRule(db as any, parsed.data);
    await writeAuditLog(req, {
      workspaceId: null,
      action: "admin.video_fulfillment.enhance_pricing_update",
      resourceType: "pricing_rule",
      resourceId: rule.id,
      metadata: {
        endpointType: "video_enhance",
        sourceResolution: rule.sourceResolution,
        targetResolution: rule.targetResolution,
        unitPriceMicros: rule.unitPriceMicros,
        disabled: rule.disabled,
      },
    });
    return res.status(200).send(success({ rule }, "价目已保存"));
  } catch (err: any) {
    if (err instanceof AdminFulfillmentError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    return res.status(400).send(error(err?.message || "保存失败"));
  }
});
