import express from "express";
import { z } from "zod";
import { BillingError } from "@/lib/billing";
import { updateBillingServiceRequest } from "@/lib/billingServiceRequests";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { CommercialTenantError } from "@/lib/commercialTenant";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "approved", "rejected", "issued", "cancelled"]),
  reviewNote: z.string().optional().nullable(),
});

function operatorUserIdOf(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

function sendBillingError(res: express.Response, err: unknown) {
  if (err instanceof BillingError) return res.status(err.status).send({ message: err.message });
  if (err instanceof CommercialTenantError) return res.status(err.status).send({ message: err.message, code: err.code });
  throw err;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const item = await updateBillingServiceRequest({
      ...parsed.data,
      reviewedByUserId: operatorUserIdOf(req),
    });
    return res.status(200).send(success(item));
  } catch (err) {
    return sendBillingError(res, err);
  }
});
