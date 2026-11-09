import express from "express";
import { z } from "zod";

import { requestCommercialTenant } from "@/lib/commercialTenant";
import { listOnlinePaymentPage, onlinePaymentErrorResponse } from "@/lib/onlinePayment";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:read"));

export const bodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const auth = (req as any).auth || {};
    const page = await listOnlinePaymentPage({
      tenant: requestCommercialTenant(req),
      userId: Number(auth.user?.id || 0),
      workspaceId: String(parsed.data.workspaceId || auth.workspaceId || ""),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    return res.status(200).send(success(page));
  } catch (error) {
    const known = onlinePaymentErrorResponse(error);
    if (known) return res.status(known.status).send(known.body);
    throw error;
  }
});
