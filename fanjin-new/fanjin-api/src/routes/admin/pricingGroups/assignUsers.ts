import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { assignUsersToPricingGroup } from "@/lib/pricingGroups";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { sendPricingGroupError } from "./handlers";

const router = express.Router();
router.use(requirePlatformAdmin);
const bodySchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(500).transform((values) => [...new Set(values)]),
  code: z.string().trim().max(48).optional().nullable(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const result = await db.transaction(async (trx) => {
      const before = await trx("o_user_commercial_profile")
        .whereIn("userId", parsed.data.userIds)
        .select("userId", "pricingGroup");
      const assigned = await assignUsersToPricingGroup(trx, parsed.data);
      await writeAuditLog(req, {
        action: "admin.pricing_group.assign_users",
        resourceType: "pricing_group",
        resourceId: assigned.code,
        required: true,
        metadata: { userIds: parsed.data.userIds, before, afterGroup: assigned.code },
      }, trx);
      return assigned;
    });
    return res.status(200).send(success(result));
  } catch (caught) {
    const response = sendPricingGroupError(res, caught);
    if (response) return response;
    throw caught;
  }
});
