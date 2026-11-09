import express from "express";
import { z } from "zod";
import { BillingError } from "@/lib/billing";
import { createBillingServiceRequest } from "@/lib/billingServiceRequests";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { CommercialTenantError, requestCommercialTenant } from "@/lib/commercialTenant";

const router = express.Router();
router.use(requireWorkspacePermission("billing:request:create"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  type: z.enum(["invoice", "credit_limit", "offline_payment"]),
  amountMicros: z.number().int().nonnegative(),
  currency: z.string().optional().nullable(),
  subjectName: z.string().optional().nullable(),
  taxId: z.string().optional().nullable(),
  contactName: z.string().optional().nullable(),
  contactEmail: z.string().optional().nullable(),
  contactPhone: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});

function workspaceIdOf(req: express.Request, workspaceId?: string | null): string {
  return workspaceId || (req as any).auth?.workspaceId || "default";
}

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
    const item = await createBillingServiceRequest({
      ...parsed.data,
      workspaceId: workspaceIdOf(req, parsed.data.workspaceId),
      sellerTenantId: requestCommercialTenant(req).id,
      submittedByUserId: operatorUserIdOf(req),
    });
    return res.status(200).send(success(item));
  } catch (err) {
    return sendBillingError(res, err);
  }
});
