import { readPaidMembership } from "@/lib/onlinePayment";
import { readWorkspaceMembership } from "@/lib/membership";
import { MEMBERSHIP_PLANS, MEMBERSHIP_VERSION } from "@/lib/membershipCatalog";
import { CREDIT_PACKAGES, resolveCreditPackage } from "@/lib/commercialPricingPolicy";
import express from "express";
import { z } from "zod";

import { requestCommercialTenant } from "@/lib/commercialTenant";
import { success } from "@/lib/responseFormat";
import {
  PaymentConfigError,
  publicPaymentChannel,
  resolveTenantPaymentConfiguration,
} from "@/lib/tenantPaymentConfig";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:read"));

const bodySchema = z.object({ workspaceId: z.string().optional().nullable() });

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const tenant = requestCommercialTenant(req);
    const config = await resolveTenantPaymentConfiguration(tenant);
    const membershipState = await readWorkspaceMembership(String((req as any).auth?.workspaceId || ""), tenant.id);
    return res.status(200).send(success({
      ...config,
      membershipState: { ...membershipState, plans: MEMBERSHIP_PLANS, version: MEMBERSHIP_VERSION },
      membership: await readPaidMembership(Number((req as any).auth?.user?.id || 0), tenant.id),
      packages: tenant.id === "FANJIN" && config.gatewayEnabled && tenant.rechargeEnabled ? CREDIT_PACKAGES.map((pack) => resolveCreditPackage(pack.id)).filter((pack) => pack.priceYuan >= config.minTopupYuan) : [],
      rechargeEnabled: tenant.rechargeEnabled,
      sellerTenantId: tenant.id,
      sellerTenantName: tenant.name,
      operatorName: tenant.operatorName,
      channels: config.channels.map(publicPaymentChannel),
    }));
  } catch (error) {
    if (error instanceof PaymentConfigError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    throw error;
  }
});
