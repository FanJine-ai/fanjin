import express from "express";
import { z } from "zod";
import { billingPlanStatuses, BillingError, upsertBillingPlan } from "@/lib/billing";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().optional().nullable(),
  code: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(billingPlanStatuses).optional(),
  currency: z.string().optional(),
  billingPeriod: z.string().optional(),
  priceMicros: z.number().int().nonnegative().optional(),
  includedCreditsMicros: z.number().int().nonnegative().optional(),
  creditLimitMicros: z.number().int().nonnegative().optional(),
  quotas: z.record(z.string(), z.unknown()).optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function sendBillingError(res: express.Response, err: unknown) {
  if (err instanceof BillingError) return res.status(err.status).send({ message: err.message });
  throw err;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    res.status(200).send(success(await upsertBillingPlan(parsed.data)));
  } catch (err) {
    return sendBillingError(res, err);
  }
});
