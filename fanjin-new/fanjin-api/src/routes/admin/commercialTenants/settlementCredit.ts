import express from "express";
import { z } from "zod";

import {
  CommercialTenantError,
  creditTenantSettlement,
} from "@/lib/commercialTenant";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  tenantId: z.string().trim().min(2).max(64),
  amountMicros: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const operatorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0) || null;
    const result = await creditTenantSettlement({
      ...parsed.data,
      operatorUserId,
    });
    await writeAuditLog(req, {
      action: "commercial_tenant.settlement.credit",
      resourceType: "tenant_settlement_ledger",
      resourceId: result.ledger.id,
      metadata: {
        tenantId: parsed.data.tenantId.trim().toUpperCase(),
        amountMicros: parsed.data.amountMicros,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
    return res.status(200).send(success(result));
  } catch (error) {
    if (error instanceof CommercialTenantError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    throw error;
  }
});
