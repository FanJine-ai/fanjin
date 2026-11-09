import express from "express";
import { z } from "zod";
import { requestCommercialTenant } from "@/lib/commercialTenant";
import { MEMBERSHIP_PLANS, MEMBERSHIP_VERSION, MembershipError } from "@/lib/membershipCatalog";
import { quotePurchasableMembership, readWorkspaceMembership } from "@/lib/membership";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { success } from "@/lib/responseFormat";

const router = express.Router();
router.use(requireActiveWorkspacePermission("billing:read"));
router.post("/status", async (req, res) => {
  const tenant = requestCommercialTenant(req);
  const state = await readWorkspaceMembership(String((req as any).auth?.workspaceId || ""), tenant.id);
  return res.send(success({ ...state, plans: MEMBERSHIP_PLANS, version: MEMBERSHIP_VERSION }));
});
router.post("/quote", requireActiveWorkspacePermission("billing:request:create"), async (req, res) => {
  const parsed = z.object({ planId: z.string(), months: z.number().int(), seedanceShare: z.number().int(), version: z.string(), workspaceId: z.string().optional() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "会员报价参数无效" });
  try {
    return res.send(success(await quotePurchasableMembership({ ...parsed.data, tenantId: requestCommercialTenant(req).id,
      workspaceId: String((req as any).auth?.workspaceId || ""), userId: Number((req as any).auth?.user?.id) })));
  } catch (error) {
    if (error instanceof MembershipError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
export default router;
