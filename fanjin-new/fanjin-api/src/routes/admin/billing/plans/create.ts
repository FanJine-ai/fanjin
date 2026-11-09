import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";

const router = express.Router();

const bodySchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  currency: z.literal("GU").default("GU"),
  monthlyFeeMicros: z.number().int().nonnegative().default(0),
  includedCreditsMicros: z.number().int().nonnegative().default(0),
  apiQuota: z.number().int().nonnegative().optional().nullable(),
  memberLimit: z.number().int().nonnegative().optional().nullable(),
  keyLimit: z.number().int().nonnegative().optional().nullable(),
  status: z.enum(["active", "archived"]).default("active"),
  metadata: z.record(z.string(), z.any()).default({}),
}).strict();

router.use(requirePlatformAdmin);

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const now = Date.now();
  const id = uuid();
  const data = parsed.data;
  await db("o_billing_plan").insert({
    id,
    code: data.code,
    name: data.name,
    currency: data.currency,
    monthlyFeeMicros: data.monthlyFeeMicros,
    includedCreditsMicros: data.includedCreditsMicros,
    apiQuota: data.apiQuota ?? null,
    memberLimit: data.memberLimit ?? null,
    keyLimit: data.keyLimit ?? null,
    status: data.status,
    metadata: JSON.stringify(data.metadata),
    createdAt: now,
    updatedAt: now,
  });

  await writeAuditLog(req, {
    action: "admin.billing_plan.create",
    resourceType: "billing_plan",
    resourceId: id,
    metadata: data,
  });

  res.status(200).send(success({ id, ...data, createdAt: now, updatedAt: now }));
});
