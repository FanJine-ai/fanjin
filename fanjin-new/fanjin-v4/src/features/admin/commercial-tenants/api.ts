import { apiGet } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type {
  CommercialTenantLegalProfile,
  CommercialTenantSummaryResponse,
  SettlementCreditResult,
} from "./types";

export function listCommercialTenants() {
  return apiGet<CommercialTenantSummaryResponse>("/admin/commercialTenants/summary");
}

export function creditTenantSettlement(input: {
  tenantId: string;
  amountMicros: number;
  idempotencyKey: string;
  description: string;
}) {
  return apiPostWithStepUp<SettlementCreditResult>(
    "/admin/commercialTenants/settlementCredit",
    input,
    "admin.finance.adjustment",
    `为商业租户 ${input.tenantId} 增加结算金`,
  );
}

export function updateCommercialTenantLegalProfile(input: {
  tenantId: string;
  expectedRevision: number;
  icpNumber: string | null;
  valueAddedTelecomLicense: string | null;
  publicSecurityRegistration: string | null;
}) {
  return apiPostWithStepUp<CommercialTenantLegalProfile>(
    "/admin/commercialTenants/legalProfile",
    input,
    "admin.system_settings",
    `更新商业租户 ${input.tenantId} 的合规公示资料`,
  );
}
