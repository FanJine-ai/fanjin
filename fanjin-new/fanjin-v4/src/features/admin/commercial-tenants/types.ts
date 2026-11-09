export type TenantSettlementLedger = {
  id: string;
  tenantId: string;
  type: string;
  direction: "credit" | "debit" | string;
  amountMicros: number;
  currency: string;
  balanceBeforeMicros: number;
  balanceAfterMicros: number;
  sourceType: string | null;
  sourceId: string | null;
  description: string | null;
  createdAt: number;
};

export type CommercialTenantSummary = {
  id: string;
  name: string;
  operatorName: string;
  hosts: string[];
  icpNumber: string | null;
  valueAddedTelecomLicense: string | null;
  publicSecurityRegistration: string | null;
  legalProfileRevision: number;
  legalProfileUpdatedAt: number | null;
  customerServiceEmail: string | null;
  rechargeEnabled: boolean;
  settlementRequired: boolean;
  wholesaleRatePpm: number;
  configurationSource: "deployment" | string;
  settlementAccount: {
    balanceMicros: number;
    currency: string;
    status: string;
  };
  lots: {
    count: number;
    soldMicros: number;
    remainingMicros: number;
    reservedMicros: number;
  };
  latestSettlementLedgers: TenantSettlementLedger[];
};

export type CommercialTenantSummaryResponse = {
  items: CommercialTenantSummary[];
};

export type SettlementCreditResult = {
  idempotent: boolean;
  account: {
    tenantId: string;
    balanceMicros: number;
    currency: string;
    status: string;
  };
  ledger: TenantSettlementLedger;
};

export type CommercialTenantLegalProfile = {
  tenantId: string;
  icpNumber: string | null;
  valueAddedTelecomLicense: string | null;
  publicSecurityRegistration: string | null;
  revision: number;
  updatedAt: number | null;
  updatedBy: number | null;
  configurationSource: "database" | "deployment";
};
