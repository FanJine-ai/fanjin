import express from "express";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import {
  ModelRouteGroupMutationError,
  saveModelRouteGroup,
} from "@/lib/modelRouteGroupMutation";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { modelRouteGroupDraftSchema } from "@/lib/modelRouteGroupSchemas";
import { enrichModelRouteGroupPublication } from "@/lib/modelRoutePublication";

const router = express.Router();
router.use(requirePlatformAdmin);

export default router.post("/", async (req, res) => {
  const parsed = modelRouteGroupDraftSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const rawSaved = await saveModelRouteGroup(db, parsed.data);
    const saved = (await enrichModelRouteGroupPublication(db, [rawSaved]))[0];
    await writeAuditLog(req, {
      workspaceId: saved.workspaceId,
      action: "admin.model_route_group.save",
      resourceType: "model_route_group",
      resourceId: saved.groupKey,
      metadata: {
        previousGroupKey: parsed.data.existingGroupKey || null,
        groupKey: saved.groupKey,
        endpointType: saved.endpointType,
        publicModel: saved.publicModel,
        targetIds: saved.targets.map((target) => target.id),
        targetCount: saved.targets.length,
        tiers: saved.targets.map((target) => ({ id: target.id, tier: target.tier, weight: target.trafficWeight })),
        pricingRuleId: saved.pricing?.id || null,
        unit: saved.pricing?.unit || null,
        unitPriceMicros: saved.pricing?.unitPriceMicros || null,
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
