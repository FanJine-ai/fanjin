import express from "express";
import { z } from "zod";

import { CommercialTenantError, requestCommercialTenant } from "@/lib/commercialTenant";
import { createTenantAuthTransfer } from "@/lib/tenantAuthTransfer";
import { success } from "@/lib/responseFormat";

const router = express.Router();
const bodySchema = z.object({
  targetOrigin: z.string().url(),
  targetTenantId: z.string().trim().min(2).max(64).optional().nullable(),
  redirectPath: z.string().max(1500).optional().nullable(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const userId = Number((req as any).auth?.user?.id || 0);
    const result = await createTenantAuthTransfer({
      ...parsed.data,
      userId,
      sourceTenantId: requestCommercialTenant(req).id,
    });
    return res.status(200).send(success(result));
  } catch (error) {
    if (error instanceof CommercialTenantError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    throw error;
  }
});
