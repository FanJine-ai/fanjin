import express from "express";

import { requestCommercialTenant } from "@/lib/commercialTenant";
import { onlinePaymentErrorResponse, queryOnlinePayment } from "@/lib/onlinePayment";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router({ mergeParams: true });
router.use(requireWorkspacePermission("billing:read"));

export default router.post("/", async (req, res) => {
  try {
    const auth = (req as any).auth || {};
    const item = await queryOnlinePayment({
      tenant: requestCommercialTenant(req),
      orderId: String((req.params as any).id || ""),
      userId: Number(auth.user?.id || 0),
      workspaceId: String(auth.workspaceId || ""),
    });
    return res.status(200).send(success(item));
  } catch (error) {
    const known = onlinePaymentErrorResponse(error);
    if (known) return res.status(known.status).send(known.body);
    throw error;
  }
});
