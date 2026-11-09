import express from "express";
import { z } from "zod";

import { requestCommercialTenant } from "@/lib/commercialTenant";
import { createOnlinePayment, onlinePaymentErrorResponse } from "@/lib/onlinePayment";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:request:create"));

export const bodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  channelKey: z.string().trim().min(1).max(64),
  amountMicros: z.number().int().positive(),
  packageId: z.string().trim().min(1).max(64).optional(),
  membership: z.object({ planId: z.string().max(64), months: z.number().int(), seedanceShare: z.number().int(), version: z.string().max(80) }).strict().optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  returnUrl: z.string().trim().url().max(2048).optional().nullable(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const auth = (req as any).auth || {};
    const item = await createOnlinePayment({
      tenant: requestCommercialTenant(req),
      userId: Number(auth.user?.id || 0),
      workspaceId: String(parsed.data.workspaceId || auth.workspaceId || ""),
      channelKey: parsed.data.channelKey,
      amountMicros: parsed.data.amountMicros,
      packageId: parsed.data.packageId,
      membership: parsed.data.membership,
      idempotencyKey: parsed.data.idempotencyKey,
      returnUrl: parsed.data.returnUrl,
    });
    return res.status(200).send(success(item));
  } catch (error) {
    const known = onlinePaymentErrorResponse(error);
    if (known) return res.status(known.status).send(known.body);
    throw error;
  }
});
