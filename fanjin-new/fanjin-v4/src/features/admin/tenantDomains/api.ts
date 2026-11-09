import { apiGet, apiPost, apiDelete } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";

export type TenantDomainLifecycleState =
  | "draft"
  | "ownership_pending"
  | "verified"
  | "certificate_pending"
  | "ready"
  | "activating"
  | "active"
  | "expiring"
  | "suspending"
  | "suspended"
  | "failed"
  | "archived";

export interface TenantDomainRecord {
  id: string;
  tenantId: string;
  hostname: string;
  displayHostname: string | null;
  purpose: string;
  isPrimary: boolean;
  lifecycleState: TenantDomainLifecycleState;
  ownershipState: string;
  icpState: string;
  certificateId: string | null;
  desiredRevision: number;
  observedRevision: number;
  lastVerifiedAt: number | null;
  activatedAt: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DomainOperationRecord {
  id: string;
  tenantId: string;
  domainId: string | null;
  operationType: string;
  requestedRevision: number;
  state: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface DomainVerificationRecord {
  id: string;
  recordName: string;
  recordType: string;
  valueHint: string;
  state: string;
  expiresAt: number;
  attemptCount: number;
  createdAt: number;
}

export interface DomainListPayload {
  items: TenantDomainRecord[];
  recentOperations: DomainOperationRecord[];
}

export interface DomainDetailPayload {
  domain: TenantDomainRecord;
  verifications: DomainVerificationRecord[];
}

export interface DomainPreflightPayload {
  domain: TenantDomainRecord;
  passed: boolean;
  blockers: string[];
  checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
}

export interface TenantCertificateRecord {
  id: string;
  tenantId: string;
  source: string;
  provider: string | null;
  providerCertificateId: string | null;
  commonName: string | null;
  sans: string[];
  fingerprintSha256: string | null;
  status: string;
  notBefore: number | null;
  notAfter: number | null;
  createdAt: number;
}

export function listTenantDomains(filters: { tenantId?: string } = {}) {
  const query = filters.tenantId ? `?tenantId=${encodeURIComponent(filters.tenantId)}` : "";
  return apiGet<DomainListPayload>(`/admin/tenantDomains${query}`);
}

export function fetchTenantDomain(domainId: string) {
  return apiGet<DomainDetailPayload>(`/admin/tenantDomains/${domainId}`);
}

export function createTenantDomain(input: { tenantId: string; hostname: string; purpose?: string; isPrimary?: boolean }) {
  return apiPostWithStepUp("/admin/tenantDomains", input, "admin.tenant_domain", `为租户 ${input.tenantId} 登记域名 ${input.hostname}`);
}

export function startDomainVerification(domainId: string) {
  return apiPostWithStepUp<{ recordName: string; token: string; valueHint: string; expiresAt: number }>(
    `/admin/tenantDomains/${domainId}/verification`,
    {},
    "admin.tenant_domain",
    `为域名生成 TXT 所有权验证记录`,
  );
}

export function checkDomainVerification(domainId: string) {
  return apiPostWithStepUp<{ state: string; reason: string | null; domain: TenantDomainRecord }>(
    `/admin/tenantDomains/${domainId}/verification/check`,
    {},
    "admin.tenant_domain",
    `检查域名 TXT 验证结果`,
  );
}

export function preflightTenantDomain(domainId: string) {
  return apiPost<DomainPreflightPayload>(`/admin/tenantDomains/${domainId}/preflight`, {});
}

export function updateDomainIcpState(domainId: string, icpState: string) {
  return apiPostWithStepUp<TenantDomainRecord>(
    `/admin/tenantDomains/${domainId}/icp`,
    { icpState },
    "admin.tenant_domain",
    `更新域名备案门禁状态为 ${icpState}`,
  );
}

export function publishTenantDomain(domainId: string) {
  return apiPostWithStepUp<{ domain: TenantDomainRecord; pendingCloudSteps: string[] }>(
    `/admin/tenantDomains/${domainId}/publish`,
    {},
    "admin.tenant_ingress",
    `发布域名入口（预检通过后生效）`,
  );
}

export function suspendTenantDomain(domainId: string) {
  return apiPostWithStepUp<TenantDomainRecord>(
    `/admin/tenantDomains/${domainId}/suspend`,
    {},
    "admin.tenant_ingress",
    `暂停域名入口`,
  );
}

export function restoreTenantDomain(domainId: string) {
  return apiPostWithStepUp<TenantDomainRecord>(
    `/admin/tenantDomains/${domainId}/restore`,
    {},
    "admin.tenant_ingress",
    `恢复已暂停的域名入口`,
  );
}

export function deleteTenantDomain(domainId: string) {
  return apiDelete<TenantDomainRecord>(`/admin/tenantDomains/${domainId}`);
}

export function bindDomainCertificate(domainId: string, certificateId: string) {
  return apiPostWithStepUp<{ domainId: string; certificateId: string; desiredRevision: number }>(
    `/admin/tenantDomains/${domainId}/certificates/bind`,
    { certificateId },
    "admin.tenant_certificate",
    `为域名绑定证书`,
  );
}

export function listTenantCertificates(tenantId?: string) {
  const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  return apiGet<{ items: TenantCertificateRecord[] }>(`/admin/tenantCertificates${query}`);
}

export function importTenantCertificate(input: {
  tenantId: string;
  certificateChain: string;
  privateKey: string;
  hostnames: string[];
  name?: string;
}) {
  return apiPostWithStepUp<TenantCertificateRecord>(
    "/admin/tenantCertificates/import",
    input,
    "admin.tenant_certificate",
    `上传租户证书（私钥仅本次提交，上传后不可查看）`,
  );
}

export function fetchTenantDirectory() {
  return apiGet<{ mode: string; items: Array<{ id: string; name: string; status: string; configRevision: number }>; diff: { dbOnly: string[]; envOnly: string[] } }>("/admin/tenantDirectory");
}
