import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { createPricingGroup } from "@/lib/pricingGroups";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { sendPricingGroupError } from "./handlers";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  code: z.string().trim().min(1).max(48),
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(300).optional().nullable(),
  sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const group = await db.transaction(async (trx) => {
      const saved = await createPricingGroup(trx, {
        ...parsed.data,
        actorUserId: Number((req as any).auth?.user?.id || 0),
      });
      await writeAuditLog(req, {
        action: "admin.pricing_group.create",
        resourceType: "pricing_group",
        resourceId: saved.id,
        required: true,
        metadata: { after: saved },
      }, trx);
      return saved;
    });
    return res.status(200).send(success(group));
  } catch (caught) {
    const response = sendPricingGroupError(res, caught);
    if (response) return response;
    throw caught;
  }
});
