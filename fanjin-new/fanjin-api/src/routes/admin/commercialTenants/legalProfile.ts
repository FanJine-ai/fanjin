import express from "express";
import { z } from "zod";

import {
  CommercialTenantError,
  updateCommercialTenantLegalProfile,
} from "@/lib/commercialTenant";
import { writeAuditLog } from "@/lib/audit";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const optionalLegalValue = z.string().trim().max(500).nullable().optional();
const bodySchema = z.object({
  tenantId: z.string().trim().min(2).max(64),
  expectedRevision: z.number().int().min(0),
  icpNumber: optionalLegalValue,
  valueAddedTelecomLicense: optionalLegalValue,
  publicSecurityRegistration: optionalLegalValue,
}).strict().refine((value) => (
  value.icpNumber !== undefined
  || value.valueAddedTelecomLicense !== undefined
  || value.publicSecurityRegistration !== undefined
), { message: "至少提交一项合规资料" });

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  }
  const operatorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0) || null;
  try {
    const profile = await updateCommercialTenantLegalProfile({
      ...parsed.data,
      operatorUserId,
      audit: async (updated, trx) => {
        await writeAuditLog(req, {
          action: "admin.commercial_tenant.legal_profile.update",
          resourceType: "commercial_tenant_legal_profile",
          resourceId: updated.tenantId,
          required: true,
          metadata: {
            revision: updated.revision,
            changedFields: [
              parsed.data.icpNumber !== undefined ? "icpNumber" : null,
              parsed.data.valueAddedTelecomLicense !== undefined ? "valueAddedTelecomLicense" : null,
              parsed.data.publicSecurityRegistration !== undefined ? "publicSecurityRegistration" : null,
            ].filter(Boolean),
          },
        }, trx);
      },
    });
    return res.status(200).send(success(profile));
  } catch (error) {
    if (error instanceof CommercialTenantError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    throw error;
  }
});
