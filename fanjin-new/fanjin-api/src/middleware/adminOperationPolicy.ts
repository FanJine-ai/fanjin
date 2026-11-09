import type { NextFunction, Request, Response } from "express";
import {
  type AdminOperationPolicy,
  STATIC_ADMIN_OPERATION_POLICIES,
} from "@/lib/adminOperationPolicyCatalog";
import {
  AdminSettingPartitionError,
  assertGenericAdminSettingKeys,
} from "@/lib/adminSettingsPartition";
import { writeAuditLog } from "@/lib/audit";
import { containsInlineProviderSecret } from "@/lib/providerChannelSecrets";
import { error } from "@/lib/responseFormat";
import {
  getRolePermissions,
  hasExactPermission,
  resolveLiveWorkspacePermissions,
} from "@/middleware/permissions";
import { db } from "@/utils/db";

import { readAdminMachineIdentity } from "@/lib/adminMachineIdentity";

const DYNAMIC_OPERATION_KEYS = new Set([
  "POST /api/admin/providerChannels/create",
  "POST /api/admin/providerChannels/health",
  "POST /api/admin/providerChannels/update",
  "POST /api/admin/systemSettings/update",
  "POST /api/admin/users/update",
]);

function dynamicPolicy(
  policy: AdminOperationPolicy,
): Readonly<AdminOperationPolicy> {
  return Object.freeze({
    ...policy,
    permissions: Object.freeze([...policy.permissions]),
  });
}

export const DYNAMIC_ADMIN_OPERATION_POLICIES = Object.freeze({
  OP038a: dynamicPolicy({
    id: "OP038a", method: "POST", pathPattern: "/api/admin/providerChannels/create",
    permissions: ["fjadmin:providers:channels:write"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.provider_channel",
    auditAction: "admin.provider_channel.create", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP038b: dynamicPolicy({
    id: "OP038b", method: "POST", pathPattern: "/api/admin/providerChannels/create",
    permissions: ["fjadmin:providers:channels:write", "fjadmin:providers:channels:secrets"],
    permissionMode: "ALL", hardGate: null, stepUpScope: "admin.provider_channel",
    auditAction: "admin.provider_channel.create", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP040a: dynamicPolicy({
    id: "OP040a", method: "POST", pathPattern: "/api/admin/providerChannels/health",
    permissions: ["fjadmin:providers:channels:execute"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.provider_channel",
    auditAction: "admin.provider_channel.draft_configuration_check",
    auditMode: "required", status: "ACTIVE", mutates: false,
  }),
  OP040b: dynamicPolicy({
    id: "OP040b", method: "POST", pathPattern: "/api/admin/providerChannels/health",
    permissions: ["fjadmin:providers:channels:execute"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.provider_channel",
    auditAction: "admin.provider_channel.draft_health_check",
    auditMode: "required", status: "ACTIVE", mutates: false,
  }),
  OP040c: dynamicPolicy({
    id: "OP040c", method: "POST", pathPattern: "/api/admin/providerChannels/health",
    permissions: ["fjadmin:providers:channels:execute"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.provider_channel",
    auditAction: "admin.provider_channel.configuration_check",
    auditMode: "required", status: "ACTIVE", mutates: false,
  }),
  OP040d: dynamicPolicy({
    id: "OP040d", method: "POST", pathPattern: "/api/admin/providerChannels/health",
    permissions: ["fjadmin:providers:channels:execute"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.provider_channel",
    auditAction: "admin.provider_channel.health_check",
    auditMode: "required", status: "ACTIVE", mutates: true,
  }),
  OP044a: dynamicPolicy({
    id: "OP044a", method: "POST", pathPattern: "/api/admin/providerChannels/update",
    permissions: ["fjadmin:providers:channels:write"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.provider_channel",
    auditAction: "admin.provider_channel.update", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP044b: dynamicPolicy({
    id: "OP044b", method: "POST", pathPattern: "/api/admin/providerChannels/update",
    permissions: ["fjadmin:providers:channels:write", "fjadmin:providers:channels:secrets"],
    permissionMode: "ALL", hardGate: null, stepUpScope: "admin.provider_channel",
    auditAction: "admin.provider_channel.update", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP071a: dynamicPolicy({
    id: "OP071a", method: "POST", pathPattern: "/api/admin/systemSettings/update",
    permissions: ["fjadmin:settings:general:write"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.system_settings",
    auditAction: "admin.system_settings.update", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP071b: dynamicPolicy({
    id: "OP071b", method: "POST", pathPattern: "/api/admin/systemSettings/update",
    permissions: [], permissionMode: "EXACT", hardGate: null, stepUpScope: null,
    auditAction: "admin.system_settings.cross_domain_rejected",
    auditMode: "required", status: "REJECT_CLASSIFIER", mutates: false,
  }),
  OP074a: dynamicPolicy({
    id: "OP074a", method: "POST", pathPattern: "/api/admin/users/update",
    permissions: ["fjadmin:identity:users:write"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.user.profile",
    auditAction: "admin.user.profile.update", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP074b: dynamicPolicy({
    id: "OP074b", method: "POST", pathPattern: "/api/admin/users/update",
    permissions: ["fjadmin:identity:users:status"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.user.status",
    auditAction: "admin.user.status.update", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP074c: dynamicPolicy({
    id: "OP074c", method: "POST", pathPattern: "/api/admin/users/update",
    permissions: ["fjadmin:identity:users:role"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.user.role",
    auditAction: "admin.user.role.update", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP074d: dynamicPolicy({
    id: "OP074d", method: "POST", pathPattern: "/api/admin/users/update",
    permissions: ["fjadmin:identity:users:role"], permissionMode: "EXACT",
    hardGate: "platform_root", stepUpScope: "admin.user.role",
    auditAction: "admin.user.root_role.update", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
  OP074e: dynamicPolicy({
    id: "OP074e", method: "POST", pathPattern: "/api/admin/users/update",
    permissions: ["fjadmin:identity:users:commercial"], permissionMode: "EXACT",
    hardGate: null, stepUpScope: "admin.user.commercial",
    auditAction: "admin.user.commercial.update", auditMode: "required",
    status: "ACTIVE", mutates: true,
  }),
});

/**
 * 0.1.0 additions are kept separate from the frozen 0.0.9 C1 projection.
 * They reuse reviewed finance permission leaves and step-up scopes without
 * rewriting the historical 99-row contract.
 */
export const V010_ADMIN_OPERATION_POLICIES: readonly Readonly<AdminOperationPolicy>[] = Object.freeze([
  dynamicPolicy({
    id: "V010-PORTRAIT-ASSETS-READ",
    method: "POST",
    pathPattern: "/api/admin/portraitAssets/list",
    permissions: ["fjadmin:models:routes:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.portrait_asset.list",
    auditMode: "required",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V010-TENANT-READ",
    method: "GET",
    pathPattern: "/api/admin/commercialTenants/summary",
    permissions: ["fjadmin:finance:overview:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.commercial_tenant.summary.read",
    auditMode: "required",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V010-TENANT-CREDIT",
    method: "POST",
    pathPattern: "/api/admin/commercialTenants/settlementCredit",
    permissions: ["fjadmin:finance:adjustments:create"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.finance.adjustment",
    auditAction: "admin.commercial_tenant.settlement_credit",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
]);

export const MEDIA_SERVICE_ADMIN_OPERATION_POLICIES: readonly Readonly<AdminOperationPolicy>[] = Object.freeze([
  dynamicPolicy({
    id: "MEDIA-SERVICE-LIST", method: "GET", pathPattern: "/api/admin/mediaServices",
    permissions: ["fjadmin:providers:channels:read"], permissionMode: "EXACT", hardGate: null,
    stepUpScope: null, auditAction: "admin.media_service.list", auditMode: "denial_only", status: "ACTIVE", mutates: false,
  }),
  dynamicPolicy({
    id: "MEDIA-SERVICE-SAVE", method: "POST", pathPattern: "/api/admin/mediaServices/save",
    permissions: ["fjadmin:providers:channels:write", "fjadmin:providers:channels:secrets"], permissionMode: "ALL", hardGate: null,
    stepUpScope: "admin.media_service", auditAction: "admin.media_service.save", auditMode: "required", status: "ACTIVE", mutates: true,
  }),
  dynamicPolicy({
    id: "MEDIA-SERVICE-CHECK", method: "POST", pathPattern: "/api/admin/mediaServices/check",
    permissions: ["fjadmin:providers:channels:execute"], permissionMode: "EXACT", hardGate: null,
    stepUpScope: "admin.media_service", auditAction: "admin.media_service.check", auditMode: "required", status: "ACTIVE", mutates: true,
  }),
]);

export const V015_ADMIN_OPERATION_POLICIES: readonly Readonly<AdminOperationPolicy>[] = Object.freeze([
  dynamicPolicy({
    id: "V015-PORTRAIT-ASSET-RELAY-QUERY",
    method: "POST",
    pathPattern: "/api/admin/portraitAssetRelay/query",
    permissions: ["fjadmin:providers:portrait_assets:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.portrait_asset_relay.query",
    auditMode: "required",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V015-PORTRAIT-ASSET-RELAY-ACTION",
    method: "POST",
    pathPattern: "/api/admin/portraitAssetRelay/action",
    permissions: ["fjadmin:providers:portrait_assets:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.portrait_asset_relay",
    auditAction: "admin.portrait_asset_relay.action",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V015-PORTRAIT-ASSET-RELAY-LIVENESS",
    method: "POST",
    pathPattern: "/api/admin/portraitAssetRelay/liveness",
    permissions: ["fjadmin:providers:portrait_assets:liveness"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.portrait_asset_relay",
    auditAction: "admin.portrait_asset_relay.liveness",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
]);

export const V012_ADMIN_OPERATION_POLICIES: readonly Readonly<AdminOperationPolicy>[] = Object.freeze([
  dynamicPolicy({
    id: "V012-FJTV-MODERATION-LIST",
    method: "GET",
    pathPattern: "/api/admin/fjtv",
    permissions: ["fjadmin:settings:general:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.fjtv.moderation.list",
    auditMode: "required",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V012-FJTV-PUBLICATION-REVIEW",
    method: "POST",
    pathPattern: "/api/admin/fjtv/:publicationId/review",
    permissions: ["fjadmin:settings:general:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.system_settings",
    auditAction: "admin.fjtv.publication.review",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V012-TENANT-LEGAL-PROFILE-UPDATE",
    method: "POST",
    pathPattern: "/api/admin/commercialTenants/legalProfile",
    permissions: ["fjadmin:settings:general:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.system_settings",
    auditAction: "admin.commercial_tenant.legal_profile.update",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
]);

/**
 * 0.1.4 adds the user commercial-attribution lane (registered/owner tenant)
 * and the tenant reconciliation read lane. All new routes stay fail-closed
 * until mapped here.
 */
export const V014_ADMIN_OPERATION_POLICIES: readonly Readonly<AdminOperationPolicy>[] = Object.freeze([
  dynamicPolicy({
    id: "V014-USER-ATTRIBUTION-READ",
    method: "GET",
    pathPattern: "/api/admin/users/:userId/commercial-attribution",
    permissions: ["fjadmin:identity:users:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.user.commercial_attribution.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-USER-ATTRIBUTION-CHANGE-OWNER",
    method: "POST",
    pathPattern: "/api/admin/users/:userId/commercial-attribution/change-owner",
    permissions: ["fjadmin:identity:users:commercial"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.user.attribution",
    auditAction: "admin.user.commercial_attribution.change_owner",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-USER-ATTRIBUTION-HISTORY",
    method: "GET",
    pathPattern: "/api/admin/users/:userId/commercial-attribution/history",
    permissions: ["fjadmin:identity:users:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.user.commercial_attribution.history.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-READ",
    method: "GET",
    pathPattern: "/api/admin/tenantDirectory",
    permissions: ["fjadmin:tenants:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_directory.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-CREATE",
    method: "POST",
    pathPattern: "/api/admin/tenantDirectory",
    permissions: ["fjadmin:tenants:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_directory.create",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-UPDATE",
    method: "POST",
    pathPattern: "/api/admin/tenantDirectory/update",
    permissions: ["fjadmin:tenants:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_directory.update",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-IMPORT",
    method: "POST",
    pathPattern: "/api/admin/tenantDirectory/import",
    permissions: ["fjadmin:tenants:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_directory.import",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAINS-LIST",
    method: "GET",
    pathPattern: "/api/admin/tenantDomains",
    permissions: ["fjadmin:tenant_domains:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_domain.list",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAINS-CREATE",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains",
    permissions: ["fjadmin:tenant_domains:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_domain.create",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-DETAIL",
    method: "GET",
    pathPattern: "/api/admin/tenantDomains/:domainId",
    permissions: ["fjadmin:tenant_domains:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_domain.detail.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-VERIFICATION-START",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/verification",
    permissions: ["fjadmin:tenant_domains:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_domain.verification.start",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-VERIFICATION-CHECK",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/verification/check",
    permissions: ["fjadmin:tenant_domains:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_domain.verification.check",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-PREFLIGHT",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/preflight",
    permissions: ["fjadmin:tenant_domains:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_domain.preflight",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-PUBLISH",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/publish",
    permissions: ["fjadmin:tenant_ingress:publish"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_domain.publish",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-SUSPEND",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/suspend",
    permissions: ["fjadmin:tenant_ingress:publish"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_domain.suspend",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-ABORT",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/abort",
    permissions: ["fjadmin:tenant_ingress:publish"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_domain.abort",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-RESTORE",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/restore",
    permissions: ["fjadmin:tenant_ingress:publish"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_domain.restore",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-ICP",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/icp",
    permissions: ["fjadmin:tenant_domains:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_domain.icp.update",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-DELETE",
    method: "DELETE",
    pathPattern: "/api/admin/tenantDomains/:domainId",
    permissions: ["fjadmin:tenant_domains:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_domain.delete",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-CERTIFICATES-LIST",
    method: "GET",
    pathPattern: "/api/admin/tenantCertificates",
    permissions: ["fjadmin:tenant_certificates:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_certificate.list",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-CERTIFICATE-IMPORT",
    method: "POST",
    pathPattern: "/api/admin/tenantCertificates/import",
    permissions: ["fjadmin:tenant_certificates:import"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_certificate",
    auditAction: "admin.tenant_certificate.import",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-CERTIFICATE-REFERENCE",
    method: "POST",
    pathPattern: "/api/admin/tenantCertificates/reference",
    permissions: ["fjadmin:tenant_certificates:import"],
    permissionMode: "EXACT",
    hardGate: "platform_root",
    stepUpScope: "admin.tenant_certificate",
    auditAction: "admin.tenant_certificate.reference",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-CERTIFICATE-DETAIL",
    method: "GET",
    pathPattern: "/api/admin/tenantCertificates/:certificateId",
    permissions: ["fjadmin:tenant_certificates:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_certificate.detail.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-CERTIFICATE-VALIDATE",
    method: "POST",
    pathPattern: "/api/admin/tenantCertificates/:certificateId/validate",
    permissions: ["fjadmin:tenant_certificates:import"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_certificate",
    auditAction: "admin.tenant_certificate.validate",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-CERTIFICATE-DELETE",
    method: "DELETE",
    pathPattern: "/api/admin/tenantCertificates/:certificateId",
    permissions: ["fjadmin:tenant_certificates:import"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_certificate",
    auditAction: "admin.tenant_certificate.delete",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-CERTIFICATE-BIND",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/certificates/bind",
    permissions: ["fjadmin:tenant_certificates:import"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_certificate",
    auditAction: "admin.tenant_domain.certificate.bind",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DOMAIN-CERTIFICATE-ROTATE",
    method: "POST",
    pathPattern: "/api/admin/tenantDomains/:domainId/certificates/rotate",
    permissions: ["fjadmin:tenant_certificates:import"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_certificate",
    auditAction: "admin.tenant_domain.certificate.rotate",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-SUMMARY",
    method: "GET",
    pathPattern: "/api/admin/tenantReconciliation/summary",
    permissions: ["fjadmin:tenant_reconciliation:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_reconciliation.summary.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-PAYMENT-ORDERS",
    method: "GET",
    pathPattern: "/api/admin/tenantReconciliation/payment-orders",
    permissions: ["fjadmin:tenant_reconciliation:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_reconciliation.payment_orders.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-ALLOCATIONS",
    method: "GET",
    pathPattern: "/api/admin/tenantReconciliation/consumption-allocations",
    permissions: ["fjadmin:tenant_reconciliation:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_reconciliation.allocations.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-PROVIDER-COSTS",
    method: "GET",
    pathPattern: "/api/admin/tenantReconciliation/provider-costs",
    permissions: ["fjadmin:tenant_reconciliation:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_reconciliation.provider_costs.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-INVOICE-IMPORT",
    method: "POST",
    pathPattern: "/api/admin/tenantReconciliation/provider-invoices/import",
    permissions: ["fjadmin:tenant_reconciliation:close"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_reconciliation",
    auditAction: "admin.tenant_reconciliation.provider_invoice.import",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-PERIODS-LIST",
    method: "GET",
    pathPattern: "/api/admin/tenantReconciliation/periods",
    permissions: ["fjadmin:tenant_reconciliation:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_reconciliation.periods.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-PERIOD-PREFLIGHT",
    method: "POST",
    pathPattern: "/api/admin/tenantReconciliation/periods/:period/preflight",
    permissions: ["fjadmin:tenant_reconciliation:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_reconciliation.period.preflight",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-PERIOD-CLOSE",
    method: "POST",
    pathPattern: "/api/admin/tenantReconciliation/periods/:period/close",
    permissions: ["fjadmin:tenant_reconciliation:close"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_reconciliation",
    auditAction: "admin.tenant_reconciliation.period.close",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-PERIOD-EXPORT",
    method: "GET",
    pathPattern: "/api/admin/tenantReconciliation/periods/:period/export",
    permissions: ["fjadmin:tenant_reconciliation:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_reconciliation.period.export",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-SUSPEND",
    method: "POST",
    pathPattern: "/api/admin/tenantDirectory/suspend",
    permissions: ["fjadmin:tenant_ingress:publish"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_directory.suspend",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-ACTIVATE",
    method: "POST",
    pathPattern: "/api/admin/tenantDirectory/activate",
    permissions: ["fjadmin:tenant_ingress:publish"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_directory.activate",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-RESUME",
    method: "POST",
    pathPattern: "/api/admin/tenantDirectory/resume",
    permissions: ["fjadmin:tenant_ingress:publish"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_directory.resume",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-ARCHIVE",
    method: "POST",
    pathPattern: "/api/admin/tenantDirectory/archive",
    permissions: ["fjadmin:tenant_ingress:publish"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_directory.archive",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-BRAND-READ",
    method: "GET",
    pathPattern: "/api/admin/tenantDirectory/brand",
    permissions: ["fjadmin:tenants:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_directory.brand.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-DIRECTORY-BRAND-UPDATE",
    method: "POST",
    pathPattern: "/api/admin/tenantDirectory/brand",
    permissions: ["fjadmin:tenants:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_directory.brand.update",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-OPERATIONS-CAPACITY-READ",
    method: "GET",
    pathPattern: "/api/admin/tenantOperations/capacity",
    permissions: ["fjadmin:tenant_ingress:reconcile"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_operations.capacity.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-OPERATIONS-CAPACITY-REFRESH",
    method: "POST",
    pathPattern: "/api/admin/tenantOperations/capacity/refresh",
    permissions: ["fjadmin:tenant_ingress:reconcile"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_domain",
    auditAction: "admin.tenant_operations.capacity.refresh",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-OPERATIONS-DRIFT-READ",
    method: "GET",
    pathPattern: "/api/admin/tenantOperations/drift",
    permissions: ["fjadmin:tenant_ingress:reconcile"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_operations.drift.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-OPERATIONS-DRIFT-RECONCILE",
    method: "POST",
    pathPattern: "/api/admin/tenantOperations/drift/reconcile",
    permissions: ["fjadmin:tenant_ingress:reconcile"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.tenant_ingress",
    auditAction: "admin.tenant_operations.drift.reconcile",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
  dynamicPolicy({
    id: "V014-TENANT-OPERATIONS-CERT-ALERTS",
    method: "GET",
    pathPattern: "/api/admin/tenantOperations/certificate-alerts",
    permissions: ["fjadmin:tenant_certificates:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_operations.certificate_alerts.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-OPERATIONS-VALIDATE-CALLBACKS",
    method: "POST",
    pathPattern: "/api/admin/tenantOperations/validate-callbacks",
    permissions: ["fjadmin:tenant_domains:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_operations.validate_callbacks",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-OPERATIONS-MEDIA-CORS",
    method: "GET",
    pathPattern: "/api/admin/tenantOperations/media-cors",
    permissions: ["fjadmin:tenant_domains:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_operations.media_cors.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-OPERATIONS-MAIL-DNS-GUIDANCE",
    method: "GET",
    pathPattern: "/api/admin/tenantOperations/mail-dns-guidance",
    permissions: ["fjadmin:tenant_domains:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.tenant_operations.mail_dns_guidance.read",
    auditMode: "denial_only",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V014-TENANT-RECONCILIATION-PERIOD-REOPEN",
    method: "POST",
    pathPattern: "/api/admin/tenantReconciliation/periods/:period/reopen",
    permissions: ["fjadmin:tenant_reconciliation:close"],
    permissionMode: "EXACT",
    hardGate: "platform_root",
    stepUpScope: "admin.tenant_reconciliation",
    auditAction: "admin.tenant_reconciliation.period.reopen",
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  }),
]);

/**
 * 0.1.1 adds a claimant-bound full-film review lane for uncertain videos.
 * Keep these policies separate from the frozen C1 projection and the 0.1.0
 * read-only portrait inventory so every new route remains fail-closed.
 */
export const V011_ADMIN_OPERATION_POLICIES: readonly Readonly<AdminOperationPolicy>[] = Object.freeze([
  dynamicPolicy({
    id: "V011-PORTRAIT-REVIEW-DETAIL",
    method: "POST",
    pathPattern: "/api/admin/portraitAssets/manual-review/detail",
    permissions: ["fjadmin:models:routes:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.portrait_manual_review.detail",
    auditMode: "required",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V011-PORTRAIT-REVIEW-PREVIEW",
    method: "GET",
    pathPattern: "/api/admin/portraitAssets/manual-review/preview",
    permissions: ["fjadmin:models:routes:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.portrait_manual_review.preview",
    auditMode: "required",
    status: "ACTIVE",
    mutates: false,
  }),
  dynamicPolicy({
    id: "V011-PORTRAIT-REVIEW-PREVIEW-GRANT",
    method: "POST",
    pathPattern: "/api/admin/portraitAssets/manual-review/preview/grant",
    permissions: ["fjadmin:models:routes:read"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: null,
    auditAction: "admin.portrait_manual_review.preview_grant",
    auditMode: "required",
    status: "ACTIVE",
    // This issues only a short-lived read capability; it does not change the
    // review/admission business state and therefore has no write step-up.
    mutates: false,
  }),
  ...(["claim", "release", "decide"] as const).map((operation) => dynamicPolicy({
    id: `V011-PORTRAIT-REVIEW-${operation.toUpperCase()}`,
    method: "POST",
    pathPattern: `/api/admin/portraitAssets/manual-review/${operation}`,
    permissions: ["fjadmin:models:routes:write"],
    permissionMode: "EXACT",
    hardGate: null,
    stepUpScope: "admin.portrait_review",
    auditAction: `admin.portrait_manual_review.${operation}`,
    auditMode: "required",
    status: "ACTIVE",
    mutates: true,
  })),
]);

/** Runtime catalog shared with the authenticated admin CLI/MCP gateway. */
export function listAdminOperationPolicies(): readonly AdminOperationPolicy[] {
  return [
    ...Object.values(DYNAMIC_ADMIN_OPERATION_POLICIES),
    ...MEDIA_SERVICE_ADMIN_OPERATION_POLICIES, ...V015_ADMIN_OPERATION_POLICIES,
    ...V014_ADMIN_OPERATION_POLICIES, ...V012_ADMIN_OPERATION_POLICIES,
    ...V011_ADMIN_OPERATION_POLICIES, ...V010_ADMIN_OPERATION_POLICIES,
    ...STATIC_ADMIN_OPERATION_POLICIES,
  ];
}

function normalizePath(value: unknown): string {
  const path = String(value || "/").split("?", 1)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function patternMatches(pattern: string, actualPath: string): boolean {
  const patternParts = normalizePath(pattern).split("/");
  const actualParts = normalizePath(actualPath).split("/");
  return patternParts.length === actualParts.length
    && patternParts.every((part, index) => (
      part.startsWith(":") ? Boolean(actualParts[index]) : part === actualParts[index]
    ));
}

function hasSubmittedSecret(body: Record<string, unknown>): boolean {
  const directCredentialFields = [
    "apiKey",
    "credentialRef",
    "portraitAccessKeyId",
    "portraitSecretAccessKey",
    "portraitSessionToken",
    "imagexServiceId",
    "imagexAccessKeyId",
    "imagexSecretAccessKey",
    "imagexSessionToken",
  ] as const;
  if (directCredentialFields.some((field) => (
    typeof body[field] === "string" && Boolean(body[field].trim())
  ))) return true;
  if (body.configJson && typeof body.configJson === "object") {
    return containsInlineProviderSecret(body.configJson);
  }
  return false;
}

function classifyProviderHealth(body: Record<string, unknown>): AdminOperationPolicy | null {
  const draft = Boolean(body.draft);
  const id = typeof body.id === "string" && Boolean(body.id.trim());
  if (draft === id) return null;
  const live = body.live === undefined ? true : body.live === true;
  if (draft) {
    return live
      ? DYNAMIC_ADMIN_OPERATION_POLICIES.OP040b
      : DYNAMIC_ADMIN_OPERATION_POLICIES.OP040a;
  }
  return live
    ? DYNAMIC_ADMIN_OPERATION_POLICIES.OP040d
    : DYNAMIC_ADMIN_OPERATION_POLICIES.OP040c;
}

function classifySettings(body: Record<string, unknown>): AdminOperationPolicy {
  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return DYNAMIC_ADMIN_OPERATION_POLICIES.OP071b;
  }
  try {
    assertGenericAdminSettingKeys(Object.keys(settings));
    return DYNAMIC_ADMIN_OPERATION_POLICIES.OP071a;
  } catch (caught) {
    if (caught instanceof AdminSettingPartitionError) {
      return DYNAMIC_ADMIN_OPERATION_POLICIES.OP071b;
    }
    throw caught;
  }
}

async function classifyUserUpdate(
  body: Record<string, unknown>,
): Promise<AdminOperationPolicy | null> {
  const categories = [
    body.role !== undefined ? "role" : null,
    body.status !== undefined ? "status" : null,
    body.commercial !== undefined ? "commercial" : null,
    body.displayName !== undefined || body.email !== undefined ? "profile" : null,
  ].filter((value): value is string => Boolean(value));
  const unique = [...new Set(categories)];
  if (unique.length > 1) return null;
  const category = unique[0] || "profile";
  if (category === "status") return DYNAMIC_ADMIN_OPERATION_POLICIES.OP074b;
  if (category === "commercial") return DYNAMIC_ADMIN_OPERATION_POLICIES.OP074e;
  if (category === "profile") return DYNAMIC_ADMIN_OPERATION_POLICIES.OP074a;
  if (String(body.role || "") === "root") {
    return DYNAMIC_ADMIN_OPERATION_POLICIES.OP074d;
  }

  const targetUserId = Number(body.userId || 0);
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) return null;
  const target = await db("o_user").where({ id: targetUserId }).select("role").first();
  if (!target) return DYNAMIC_ADMIN_OPERATION_POLICIES.OP074c;
  return String(target.role || "") === "root" || String(body.role || "") === "root"
    ? DYNAMIC_ADMIN_OPERATION_POLICIES.OP074d
    : DYNAMIC_ADMIN_OPERATION_POLICIES.OP074c;
}

export async function classifyAdminOperation(input: {
  method: string;
  path: string;
  body?: Record<string, unknown> | null;
}): Promise<AdminOperationPolicy | null> {
  const method = String(input.method || "GET").toUpperCase();
  const path = normalizePath(input.path);
  const body = input.body || {};
  const operationKey = `${method} ${path}`;

  if (operationKey === "POST /api/admin/providerChannels/create") {
    return hasSubmittedSecret(body)
      ? DYNAMIC_ADMIN_OPERATION_POLICIES.OP038b
      : DYNAMIC_ADMIN_OPERATION_POLICIES.OP038a;
  }
  if (operationKey === "POST /api/admin/providerChannels/update") {
    return hasSubmittedSecret(body)
      ? DYNAMIC_ADMIN_OPERATION_POLICIES.OP044b
      : DYNAMIC_ADMIN_OPERATION_POLICIES.OP044a;
  }
  if (operationKey === "POST /api/admin/providerChannels/health") {
    return classifyProviderHealth(body);
  }
  if (operationKey === "POST /api/admin/systemSettings/update") {
    return classifySettings(body);
  }
  if (operationKey === "POST /api/admin/users/update") {
    return await classifyUserUpdate(body);
  }

  const matches = (policy: AdminOperationPolicy) => (
    policy.method === method && patternMatches(policy.pathPattern, path)
  );
  return MEDIA_SERVICE_ADMIN_OPERATION_POLICIES.find(matches)
    || V015_ADMIN_OPERATION_POLICIES.find(matches)
    || V014_ADMIN_OPERATION_POLICIES.find(matches)
    || V012_ADMIN_OPERATION_POLICIES.find(matches)
    || V011_ADMIN_OPERATION_POLICIES.find(matches)
    || V010_ADMIN_OPERATION_POLICIES.find(matches)
    || STATIC_ADMIN_OPERATION_POLICIES.find(matches)
    || null;
}

function isGovernedPath(method: string, path: string): boolean {
  const operationKey = `${method.toUpperCase()} ${normalizePath(path)}`;
  return normalizePath(path).startsWith("/api/admin/")
    || DYNAMIC_OPERATION_KEYS.has(operationKey)
    || operationKey === "POST /api/billing/serviceRequests/submit";
}

async function auditDenial(
  req: Request,
  policy: AdminOperationPolicy | null,
  code: string,
  options: {
    resourceType?: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<boolean> {
  try {
    await writeAuditLog(req, {
      workspaceId: (req as any).auth?.workspaceId ?? null,
      action: policy?.auditAction || "admin.operation.unmapped",
      resourceType: options.resourceType || "admin_operation",
      resourceId: options.resourceId === undefined
        ? policy?.id || null
        : options.resourceId,
      required: true,
      metadata: {
        policyId: policy?.id || null,
        method: req.method,
        path: normalizePath(req.path),
        outcome: "denied",
        denialCode: code,
        ...(options.metadata || {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}

function sendPolicyError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return res.status(status).send(error(message, { code, ...details }));
}

function settingsPartitionRejectionDetails(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return {};
  }
  try {
    assertGenericAdminSettingKeys(Object.keys(settings));
  } catch (caught) {
    if (caught instanceof AdminSettingPartitionError) {
      return {
        reasonCode: caught.reasonCode,
        key: caught.key,
      };
    }
  }
  return {};
}

export async function adminOperationPolicyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const method = String(req.method || "GET").toUpperCase();
  const path = normalizePath(req.path);
  if (!isGovernedPath(method, path)) return next();

  let policy: AdminOperationPolicy | null;
  try {
    policy = await classifyAdminOperation({
      method,
      path,
      body: req.body && typeof req.body === "object" ? req.body : {},
    });
  } catch (caught) {
    return next(caught);
  }

  if (!policy) {
    const audited = await auditDenial(req, null, "FJADMIN_OPERATION_UNMAPPED");
    if (!audited) {
      return sendPolicyError(res, 503, "FJADMIN_AUDIT_UNAVAILABLE", "安全审计暂不可用");
    }
    return sendPolicyError(res, 503, "FJADMIN_OPERATION_UNMAPPED", "管理员操作未映射");
  }

  if (policy.status !== "ACTIVE") {
    const code = policy.status === "LEGACY_410"
      ? "FJADMIN_LEGACY_OPERATION_GONE"
      : policy.status === "REJECT_CLASSIFIER"
        ? "FJADMIN_SETTINGS_KEY_REJECTED"
        : "FJADMIN_OPERATION_NOT_RUNTIME_ACTIVE";
    const status = policy.status === "LEGACY_410"
      ? 410
      : policy.status === "REJECT_CLASSIFIER"
        ? 403
        : 503;
    const rejectionDetails = policy.id === "OP071b"
      ? settingsPartitionRejectionDetails(
          req.body && typeof req.body === "object" ? req.body : {},
        )
      : {};
    const audited = await auditDenial(
      req,
      policy,
      code,
      policy.id === "OP071b"
        ? {
            resourceType: "system_settings",
            resourceId: "platform",
            metadata: {
              ...(rejectionDetails.key
                ? { rejectedKey: rejectionDetails.key }
                : {}),
              ...(rejectionDetails.reasonCode
                ? { reasonCode: rejectionDetails.reasonCode }
                : {}),
            },
          }
        : {},
    );
    if (!audited) {
      return sendPolicyError(res, 503, "FJADMIN_AUDIT_UNAVAILABLE", "安全审计暂不可用");
    }
    return sendPolicyError(
      res,
      status,
      code,
      "管理员操作已安全拒绝",
      rejectionDetails,
    );
  }

  const role = String((req as any).auth?.user?.role || "").trim().toLowerCase();
  let permissions = getRolePermissions(role);
  const machine = readAdminMachineIdentity(req);
  if (machine) permissions = permissions.filter(permission => machine.permissions.includes(permission));
  if (policy.id === "SRV001") {
    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const workspaceId = String((req as any).auth?.workspaceId || "");
    const resolved = await resolveLiveWorkspacePermissions({
      database: db,
      actorUserId,
      workspaceId,
    });
    permissions = [...resolved.permissions];
  }

  const permissionAllowed = policy.permissions.every((permission) => (
    hasExactPermission(permissions, permission)
  ));
  if (!permissionAllowed) {
    const audited = await auditDenial(req, policy, "FJADMIN_PERMISSION_REQUIRED");
    if (!audited) {
      return sendPolicyError(res, 503, "FJADMIN_AUDIT_UNAVAILABLE", "安全审计暂不可用");
    }
    return sendPolicyError(res, 403, "FJADMIN_PERMISSION_REQUIRED", "缺少管理员操作权限");
  }

  if (policy.hardGate && role !== "root") {
    const audited = await auditDenial(req, policy, "FJADMIN_HARD_GATE_REQUIRED");
    if (!audited) {
      return sendPolicyError(res, 503, "FJADMIN_AUDIT_UNAVAILABLE", "安全审计暂不可用");
    }
    return sendPolicyError(res, 403, "FJADMIN_HARD_GATE_REQUIRED", "服务器硬门禁未满足");
  }

  res.locals.fjadminOperationPolicy = policy;
  (req as any).fjadminOperationPolicy = policy;
  return next();
}
