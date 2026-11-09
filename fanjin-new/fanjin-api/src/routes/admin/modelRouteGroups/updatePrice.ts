import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import {
  ModelRouteGroupMutationError,
  updateLogicalModelPrice,
} from "@/lib/modelRouteGroupMutation";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { logicalPriceSchema } from "@/lib/modelRouteGroupSchemas";
import { enrichModelRouteGroupPublication } from "@/lib/modelRoutePublication";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  groupKey: z.string().trim().min(1),
  pricing: logicalPriceSchema,
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const rawSaved = await updateLogicalModelPrice(db, parsed.data);
    const saved = (await enrichModelRouteGroupPublication(db, [rawSaved]))[0];
    await writeAuditLog(req, {
      workspaceId: saved.workspaceId,
      action: "admin.model_route_group.price_update",
      resourceType: "model_route_group",
      resourceId: saved.groupKey,
      metadata: {
        pricingRuleId: saved.pricing?.id || null,
        unit: saved.pricing?.unit || null,
        unitPriceMicros: saved.pricing?.unitPriceMicros || null,
        mirroredProviders: [...new Set(saved.targets.map((target) => target.provider))],
        publicationStatus: saved.publication.status,
      },
    });
    return res.status(200).send(success(saved));
  } catch (caught) {
    if (caught instanceof ModelRouteGroupMutationError) {
      return res.status(caught.statusCode).send({ message: caught.message, code: caught.code, errors: caught.issues });
    }
    throw caught;
  }
});
