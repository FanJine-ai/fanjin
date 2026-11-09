import express from "express";
import { z } from "zod";

import { CommercialTenantError, requestCommercialTenant } from "@/lib/commercialTenant";
import { exchangeTenantAuthTransfer } from "@/lib/tenantAuthTransfer";
import { success } from "@/lib/responseFormat";

const router = express.Router();
const bodySchema = z.object({ code: z.string().trim().min(20).max(200) });

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const origin = `${req.protocol}://${req.get("host")}`;
    const result = await exchangeTenantAuthTransfer({
      code: parsed.data.code,
      requestTenantId: requestCommercialTenant(req).id,
      requestOrigin: origin,
      userAgent: req.get("user-agent") || null,
      ip: req.ip,
    });
    return res.status(200).send(success(result));
  } catch (error) {
    if (error instanceof CommercialTenantError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    throw error;
  }
});
