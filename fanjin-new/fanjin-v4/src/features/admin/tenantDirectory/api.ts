import { apiGet, apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";

export interface TenantDirectoryEntry {
  id: string;
  name: string;
  operatorName: string;
  status: "draft" | "active" | "suspended" | "archived";
  rechargeEnabled: boolean;
  settlementRequired: boolean;
  wholesaleRatePpm: number;
  configRevision: number;
  configurationSource: string;
  createdAt: number;
  updatedAt: number;
}

export interface TenantDirectoryPayload {
  mode: string;
  items: TenantDirectoryEntry[];
  envView: Array<{ id: string; name: string; hosts: string[] }>;
  diff: { dbOnly: string[]; envOnly: string[] };
}

export interface TenantBrandConfig {
  theme: string | null;
  logoUrl: string | null;
  customerServiceEmail: string | null;
  customerServiceUrl: string | null;
  agreementVersion: string | null;
  alertContacts: string[];
}

export interface TenantLifecycleBlocker {
  code: string;
  detail: string;
  count: number;
}

export function fetchTenantDirectory() {
  return apiGet<TenantDirectoryPayload>("/admin/tenantDirectory");
}

export function createTenant(input: { tenantId: string; name: string; operatorName: string }) {
  return apiPostWithStepUp("/admin/tenantDirectory", input, "admin.tenant_domain", `创建商业租户 ${input.tenantId}`);
}

export function suspendTenant(input: { tenantId: string; expectedRevision: number; reason: string }) {
  return apiPostWithStepUp<{ tenant: TenantDirectoryEntry; domainsSuspended: number }>(
    "/admin/tenantDirectory/suspend",
    input,
    "admin.tenant_ingress",
    `暂停租户 ${input.tenantId} 的入口与充值`,
  );
}

export function resumeTenant(input: { tenantId: string; expectedRevision: number; reason: string }) {
  return apiPostWithStepUp<TenantDirectoryEntry>(
    "/admin/tenantDirectory/resume",
    input,
    "admin.tenant_ingress",
    `恢复已暂停租户 ${input.tenantId}`,
  );
}

export function archiveTenant(input: { tenantId: string; expectedRevision: number; reason: string }) {
  return apiPostWithStepUp<{ tenant: TenantDirectoryEntry; blockers: TenantLifecycleBlocker[] }>(
    "/admin/tenantDirectory/archive",
    input,
    "admin.tenant_ingress",
    `归档租户 ${input.tenantId}（退租流程，不删除全局用户数据）`,
  );
}

export function fetchTenantBrand(tenantId: string) {
  return apiGet<{ tenantId: string; brand: TenantBrandConfig }>(`/admin/tenantDirectory/brand?tenantId=${encodeURIComponent(tenantId)}`);
}

export function updateTenantBrand(input: {
  tenantId: string;
  expectedRevision: number;
  theme?: string | null;
  logoUrl?: string | null;
  customerServiceEmail?: string | null;
  customerServiceUrl?: string | null;
  agreementVersion?: string | null;
  alertContacts?: string[];
}) {
  return apiPostWithStepUp<{ tenant: TenantDirectoryEntry; brand: TenantBrandConfig }>(
    "/admin/tenantDirectory/brand",
    input,
    "admin.tenant_domain",
    `更新租户 ${input.tenantId} 的品牌与告警联系人`,
  );
}

export function importTenantDirectory() {
  return apiPostWithStepUp<{ created: string[]; updated: string[]; unchanged: string[]; envOnlyIds: string[] }>(
    "/admin/tenantDirectory/import",
    {},
    "admin.tenant_domain",
    "从环境变量导入租户目录（幂等）",
  );
}
