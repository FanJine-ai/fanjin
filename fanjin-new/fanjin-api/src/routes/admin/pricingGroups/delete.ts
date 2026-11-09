import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { deletePricingGroup } from "@/lib/pricingGroups";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { sendPricingGroupError } from "./handlers";

const router = express.Router();
router.use(requirePlatformAdmin);
const bodySchema = z.object({ code: z.string().trim().min(1).max(48) }).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    await db.transaction(async (trx) => {
      const code = parsed.data.code.toLowerCase();
      const before = await trx("o_pricing_group").where({ code }).first();
      await deletePricingGroup(trx, code);
      await writeAuditLog(req, {
        action: "admin.pricing_group.delete",
        resourceType: "pricing_group",
        resourceId: before?.id || code,
        required: true,
        metadata: { before: before || null },
      }, trx);
    });
    return res.status(200).send(success({ deleted: true, code: parsed.data.code.toLowerCase() }));
  } catch (caught) {
    const response = sendPricingGroupError(res, caught);
    if (response) return response;
    throw caught;
  }
});
