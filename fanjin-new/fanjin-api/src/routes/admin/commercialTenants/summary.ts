import express from "express";

import {
  COMMERCIAL_CREDIT_LOT_TABLE,
  TENANT_SETTLEMENT_ACCOUNT_TABLE,
  TENANT_SETTLEMENT_LEDGER_TABLE,
  listRuntimeCommercialTenants,
  readCommercialTenantLegalProfile,
} from "@/lib/commercialTenant";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

export default router.get("/", async (_req, res) => {
  const tenants = await listRuntimeCommercialTenants(db);
  const items = await Promise.all(tenants.map(async (tenant) => {
    const [account, lotTotals, latestSettlementLedgers, legalProfile] = await Promise.all([
      db(TENANT_SETTLEMENT_ACCOUNT_TABLE).where({ tenantId: tenant.id }).first(),
      db(COMMERCIAL_CREDIT_LOT_TABLE)
        .where({ sellerTenantId: tenant.id })
        .count({ lotCount: "*" })
        .sum({ soldMicros: "amountMicros", remainingMicros: "remainingMicros", reservedMicros: "reservedMicros" })
        .first(),
      db(TENANT_SETTLEMENT_LEDGER_TABLE)
        .where({ tenantId: tenant.id })
        .orderBy("createdAt", "desc")
        .limit(20),
      readCommercialTenantLegalProfile(tenant),
    ]);
    return {
      id: tenant.id,
      name: tenant.name,
      operatorName: tenant.operatorName,
      hosts: tenant.hosts,
      icpNumber: legalProfile.icpNumber,
      valueAddedTelecomLicense: legalProfile.valueAddedTelecomLicense,
      publicSecurityRegistration: legalProfile.publicSecurityRegistration,
      legalProfileRevision: legalProfile.revision,
      legalProfileUpdatedAt: legalProfile.updatedAt,
      customerServiceEmail: tenant.customerServiceEmail,
      rechargeEnabled: tenant.rechargeEnabled,
      settlementRequired: tenant.settlementRequired,
      wholesaleRatePpm: tenant.wholesaleRatePpm,
      configurationSource: legalProfile.configurationSource,
      settlementAccount: {
        balanceMicros: Number(account?.balanceMicros || 0),
        currency: String(account?.currency || "CNY"),
        status: String(account?.status || "active"),
      },
      lots: {
        count: Number((lotTotals as any)?.lotCount || 0),
        soldMicros: Number((lotTotals as any)?.soldMicros || 0),
        remainingMicros: Number((lotTotals as any)?.remainingMicros || 0),
        reservedMicros: Number((lotTotals as any)?.reservedMicros || 0),
      },
      latestSettlementLedgers,
    };
  }));
  return res.status(200).send(success({ items }));
});
