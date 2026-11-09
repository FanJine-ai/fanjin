import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { updatePricingGroup } from "@/lib/pricingGroups";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { sendPricingGroupError } from "./handlers";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  code: z.string().trim().min(1).max(48),
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(300).optional().nullable(),
  status: z.enum(["active", "disabled"]).optional(),
  sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "code"), {
  message: "至少提供一个需要修改的字段",
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const group = await db.transaction(async (trx) => {
      const before = await trx("o_pricing_group").where({ code: parsed.data.code.trim().toLowerCase() }).first();
      const saved = await updatePricingGroup(trx, {
        ...parsed.data,
        actorUserId: Number((req as any).auth?.user?.id || 0),
      });
      await writeAuditLog(req, {
        action: "admin.pricing_group.update",
        resourceType: "pricing_group",
        resourceId: saved.id,
        required: true,
        metadata: { before: before || null, after: saved },
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
