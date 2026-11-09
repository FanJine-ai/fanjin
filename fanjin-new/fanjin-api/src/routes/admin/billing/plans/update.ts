import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";

const router = express.Router();

const bodySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  currency: z.literal("GU").optional(),
  monthlyFeeMicros: z.number().int().nonnegative().optional(),
  includedCreditsMicros: z.number().int().nonnegative().optional(),
  apiQuota: z.number().int().nonnegative().optional().nullable(),
  memberLimit: z.number().int().nonnegative().optional().nullable(),
  keyLimit: z.number().int().nonnegative().optional().nullable(),
  status: z.enum(["active", "archived"]).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).strict();

router.use(requirePlatformAdmin);

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const { id, metadata, ...rest } = parsed.data;
  const updateData: Record<string, unknown> = { ...rest, updatedAt: Date.now() };
  if (metadata !== undefined) updateData.metadata = JSON.stringify(metadata);

  const count = await db("o_billing_plan").where({ id }).update(updateData);
  if (!count) return res.status(404).send(error("套餐不存在"));
  await writeAuditLog(req, {
    action: "admin.billing_plan.update",
    resourceType: "billing_plan",
    resourceId: id,
    metadata: updateData,
  });
  res.status(200).send(success({ id, ...updateData }));
});
