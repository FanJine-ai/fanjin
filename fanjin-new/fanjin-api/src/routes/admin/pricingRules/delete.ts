import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { isLogicalModelManagedPricingRule } from "@/lib/modelRouteGroups";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().min(1),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const rule = await db("o_pricing_rule").where({ id: parsed.data.id }).first();
  if (!rule) return res.status(404).send(error("Pricing rule 不存在"));
  if (isLogicalModelManagedPricingRule(rule)) {
    return res.status(409).send({
      message: "该价格属于逻辑模型，请在模型定价页统一维护",
      code: "managed_logical_price_requires_group_api",
    });
  }

  const count = await db("o_pricing_rule").where({ id: parsed.data.id }).update({
    disabled: 1,
    updateTime: Date.now(),
  });

  if (!count) return res.status(404).send(error("Pricing rule 不存在"));
  await writeAuditLog(req, {
    action: "admin.pricing_rule.disable",
    resourceType: "pricing_rule",
    resourceId: parsed.data.id,
    metadata: { disabled: 1 },
  });
  res.status(200).send(success({ id: parsed.data.id, disabled: 1 }));
});
