import type { NextFunction, Request, Response } from "express";
import { hasAuditLogWritten, writeAuditLog } from "@/lib/audit";
import {
  financeStepUpRequestFingerprint,
  financeStepUpResourceFingerprint,
  type VerifiedFinanceStepUpContextV1,
} from "@/lib/billingServiceRequestFinance";
import { error } from "@/lib/responseFormat";
import {
  authorizeReleaseArtifactMultipartDelegation,
  ReleaseArtifactMultipartUploadError,
} from "@/lib/releaseArtifactMultipartUpload";
import {
  serviceRequestIssueSchema,
  serviceRequestRecoverSchema,
  serviceRequestReviewSchema,
} from "@/lib/serviceRequestRouteSchemas";
import {
  consumeStepUpProof,
  StepUpError,
  type FinanceStepUpBindingV1,
  type StepUpScope,
} from "@/lib/stepUpAuth";
import { db } from "@/utils/db";
import {
  GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE,
  GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE_CODE,
  GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE_MESSAGE,
  isGlobalMutableContentWritePath,
  isProductionGlobalContentRuntime,
} from "@/middleware/globalMutableContentWrite";
import {
  AdminSettingPartitionError,
  assertGenericAdminSettingKeys,
} from "@/lib/adminSettingsPartition";

import { readAdminMachineIdentity } from "@/lib/adminMachineIdentity";
import { authorizeMachineFinanceOperation } from "@/lib/adminMachineFinanceAuth";
import { AdminMachineCredentialError } from "@/lib/adminMachineCredentials";

const ADMIN_PREFIX = "/api/admin/";
const OWNER_TRANSFER_PATH = "/api/workspace/owner/transfer";
const RELEASE_ARTIFACT_UPLOAD_PATH =
  "/api/admin/releases/artifacts/upload-url";
const RELEASE_ARTIFACT_DELEGATED_ACTIONS = new Set([
  "multipart_status",
  "multipart_part",
  "multipart_complete",
  "multipart_abort",
]);

export interface DeferredTransactionalStepUp {
  proof: string;
  userId: number;
  sessionId: string;
  scope: StepUpScope;
}

export function readDeferredTransactionalStepUp(
  res: Response,
): DeferredTransactionalStepUp | null {
  const value = res.locals.deferredTransactionalStepUp as
    | Partial<DeferredTransactionalStepUp>
    | undefined;
  const userId = Number(value?.userId || 0);
  const proof = String(value?.proof || "").trim();
  const sessionId = String(value?.sessionId || "").trim();
  const scope = String(value?.scope || "") as StepUpScope;
  if (!proof || !Number.isSafeInteger(userId) || userId < 1 || !sessionId || !scope) {
    return null;
  }
  return { proof, userId, sessionId, scope };
}

export function readVerifiedFinanceStepUpContext(
  res: Response,
): VerifiedFinanceStepUpContextV1 | null {
  return (
    (res.locals.verifiedFinanceStepUpContext as
      | VerifiedFinanceStepUpContextV1
      | undefined) || null
  );
}

const PRIVILEGED_STATIC_SCOPES: Readonly<Record<string, StepUpScope>> = {
  "/api/apiKeys/create": "api_key.create",
  "/api/apiKeys/update": "api_key.update",
  "/api/apiKeys/rotate": "api_key.rotate",
  "/api/apiKeys/revoke": "api_key.revoke",
  "/api/billing/chargeTask": "admin.finance.adjustment",
  "/api/billing/deduct": "admin.finance.adjustment",
  "/api/billing/freeze": "admin.finance.adjustment",
  "/api/billing/plans/assign": "admin.billing.plan",
  "/api/billing/plans/upsert": "admin.billing.plan",
  "/api/billing/recharge": "admin.finance.adjustment",
  "/api/billing/refund": "admin.finance.adjustment",
  "/api/billing/release": "admin.finance.adjustment",
  "/api/billing/topup": "admin.finance.adjustment",
  "/api/workspace/invitations/create": "workspace.member.manage",
  "/api/workspace/invitations/revoke": "workspace.member.manage",
  "/api/workspace/subaccounts/create": "workspace.member.manage",
  "/api/workspace/subaccounts/disable": "workspace.member.manage",
  "/api/workspace/subaccounts/update": "workspace.member.manage",
  "/api/workspace/owner/transfer": "workspace.owner.transfer",
  "/api/setting/vendorConfig/addVendor": "legacy.vendor_config.manage",
  "/api/setting/vendorConfig/addVendorModel": "legacy.vendor_config.manage",
  "/api/setting/vendorConfig/delVendorModel": "legacy.vendor_config.manage",
  "/api/setting/vendorConfig/deleteVendor": "legacy.vendor_config.manage",
  "/api/setting/vendorConfig/enableVendor": "legacy.vendor_config.manage",
  "/api/setting/vendorConfig/modelTest": "legacy.vendor_config.manage",
  "/api/setting/vendorConfig/upVendorModel": "legacy.vendor_config.manage",
  "/api/setting/vendorConfig/updateCode": "legacy.vendor_config.manage",
  "/api/setting/vendorConfig/updateVendorInputs": "legacy.vendor_config.manage",
  "/api/setting/agentDeploy/agentSetKey": "legacy.agent_config.manage",
  "/api/setting/agentDeploy/deployAgentModel": "legacy.agent_config.manage",
  "/api/setting/agentDeploy/updateAgentModel": "legacy.agent_config.manage",
  "/api/setting/agentDeploy/updateUseMode": "legacy.agent_config.manage",
  "/api/setting/modelMap/bindingPrompt": "legacy.model_config.manage",
  "/api/setting/modelMap/deletePrompt": "legacy.model_config.manage",
  "/api/setting/modelMap/savePrompt": "legacy.model_config.manage",
  "/api/setting/modelMap/updatePrompt": "legacy.model_config.manage",
  "/api/setting/promptManage/updatePrompt": "legacy.content_config.manage",
  "/api/setting/skillManagement/saveSkillContent": "legacy.content_config.manage",
  "/api/artStyle/addArtStyle": GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE,
  "/api/artStyle/editArtStyle": GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE,
  "/api/project/addDirectorManual": GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE,
  "/api/project/addVisualManual": GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE,
  "/api/project/editDirectorlManual": GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE,
  "/api/project/editVisualManual": GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE,
  "/api/setting/dev/updateSwitchAiDevTool": "legacy.developer_config.manage",
  "/api/setting/memoryConfig/delAllMemory": "legacy.memory_config.manage",
  "/api/setting/memoryConfig/sureMemory": "legacy.memory_config.manage",
  "/api/setting/dbConfig/clearData": "legacy.database.destructive",
  "/api/setting/dbConfig/clearTable": "legacy.database.destructive",
  "/api/setting/dbConfig/importData": "legacy.database.destructive",
  "/api/other/deleteAllData": "legacy.database.destructive",
};

const PRIVILEGED_READ_POST_PATHS = new Set([
  "/api/apiKeys/list",
  "/api/setting/vendorConfig/getVendorList",
  "/api/setting/agentDeploy/getAgentDeploy",
  "/api/setting/modelMap/getImageAndVideoModel",
  "/api/setting/modelMap/getPromptList",
  "/api/setting/promptManage/getPrompt",
]);

const LEGACY_FAIL_CLOSED_PATHS = new Set([
  "/api/setting/vendorConfig/getCodeByLink",
  "/api/setting/about/downloadApp",
  "/api/setting/fileManagement/openFolder",
]);

const PRIVILEGED_PREFIXES = [
  "/api/apiKeys/",
  "/api/agent/config/",
  "/api/setting/vendorConfig/",
  "/api/setting/agentDeploy/",
  "/api/setting/modelMap/",
] as const;

const STATIC_SCOPES: Readonly<Record<string, StepUpScope>> = {
  "/api/admin/users/create": "admin.user.create",
  "/api/admin/billing/plans/create": "admin.billing.plan",
  "/api/admin/billing/plans/update": "admin.billing.plan",
  "/api/admin/billing/membership/configure": "admin.billing.plan",
  "/api/admin/billing/membership/retry": "admin.billing.plan",
  "/api/admin/billing/reconciliation/run": "admin.billing.reconciliation",
  "/api/admin/billing/reconciliation/resolve": "admin.billing.reconciliation",
  "/api/admin/billing/serviceRequests/update": "admin.billing.service_request",
  "/api/admin/finance/cases/update": "admin.finance.case",
  "/api/admin/finance/gift-grants/revoke": "admin.finance.gift_grant",
  "/api/admin/finance/adjustments/create": "admin.finance.adjustment",
  "/api/admin/commercialTenants/settlementCredit": "admin.finance.adjustment",
  "/api/admin/commercialTenants/legalProfile": "admin.system_settings",
  "/api/admin/modelRoutes/create": "admin.model_route",
  "/api/admin/modelRoutes/delete": "admin.model_route",
  "/api/admin/modelRoutes/update": "admin.model_route",
  "/api/admin/modelRouteGroups/save": "admin.model_route",
  "/api/admin/modelRouteGroups/updatePrice": "admin.pricing_rule",
  "/api/admin/portraitAssetRelay/action": "admin.portrait_asset_relay",
  "/api/admin/portraitAssetRelay/liveness": "admin.portrait_asset_relay",
  "/api/admin/portraitAssets/manual-review/claim": "admin.portrait_review",
  "/api/admin/portraitAssets/manual-review/decide": "admin.portrait_review",
  "/api/admin/portraitAssets/manual-review/release": "admin.portrait_review",
  "/api/admin/pricingRules/create": "admin.pricing_rule",
  "/api/admin/pricingRules/delete": "admin.pricing_rule",
  "/api/admin/pricingRules/update": "admin.pricing_rule",
  "/api/admin/pricingGroups/create": "admin.pricing_rule",
  "/api/admin/pricingGroups/update": "admin.pricing_rule",
  "/api/admin/pricingGroups/delete": "admin.pricing_rule",
  "/api/admin/pricingGroups/assignUsers": "admin.user.commercial",
  "/api/admin/providerChannels/create": "admin.provider_channel",
  "/api/admin/providerChannels/delete": "admin.provider_channel",
  "/api/admin/providerChannels/health": "admin.provider_channel",
  "/api/admin/providerChannels/models": "admin.provider_channel",
  "/api/admin/providerChannels/update": "admin.provider_channel",
  "/api/admin/mediaServices/save": "admin.media_service",
  "/api/admin/mediaServices/check": "admin.media_service",
  "/api/admin/redemption/generate": "admin.redemption",
  "/api/admin/relayTasks/cancel": "admin.relay_task",
  "/api/admin/relayTasks/refresh": "admin.relay_task",
  "/api/admin/releases/community-update": "admin.deployment",
  "/api/admin/releases/archive": "admin.release",
  "/api/admin/releases/artifacts/upload-url": "admin.deployment",
  "/api/admin/releases/artifacts/ready": "admin.deployment",
  "/api/admin/releases/artifacts/register": "admin.deployment",
  "/api/admin/releases/create": "admin.release",
  "/api/admin/releases/deployments/cancel": "admin.deployment",
  "/api/admin/releases/deployments/reconcile": "admin.deployment",
  "/api/admin/releases/deployments/start": "admin.deployment",
  "/api/admin/releases/publish": "admin.release",
  "/api/admin/releases/update": "admin.release",
  "/api/admin/backup/create": "admin.backup.manage",
  // Cleanup can delete many backups, so it shares the MFA-enforced deletion
  // scope rather than the lower-risk create scope.
  "/api/admin/backup/cleanup": "admin.backup.delete",
  "/api/admin/backup/restore": "admin.backup.restore",
  "/api/admin/requestLogs/export": "admin.request_log.export",
  "/api/admin/requestLogs/purge": "admin.request_log.purge",
  "/api/admin/videoFulfillment/offers/update": "admin.video_fulfillment",
  "/api/admin/videoFulfillment/recipes/create": "admin.video_fulfillment",
  "/api/admin/videoFulfillment/recipes/update": "admin.video_fulfillment",
  "/api/admin/videoFulfillment/recipes/delete": "admin.video_fulfillment",
  "/api/admin/videoFulfillment/enhance/pricing/update": "admin.pricing_rule",
};

const READ_ONLY_POST_PATHS = new Set([
  "/api/admin/auditLogs/list",
  "/api/admin/billing/plans/list",
  "/api/admin/billing/membership/status",
  "/api/admin/billing/membership/contract",
  "/api/admin/billing/reconciliation/list",
  "/api/admin/billing/serviceRequests/list",
  "/api/admin/finance/overview",
  "/api/admin/finance/cases/list",
  "/api/admin/finance/accounts/list",
  "/api/admin/finance/gift-grants/list",
  "/api/admin/finance/ledger/list",
  "/api/admin/finance/income/list",
  "/api/admin/finance/reconciliation/list",
  "/api/admin/modelRoutes/list",
  "/api/admin/modelPool/list",
  "/api/admin/modelRouteGroups/list",
  "/api/admin/modelRouteGroups/preflight",
  "/api/admin/modelRouteGroups/simulate",
  "/api/admin/portraitAssetRelay/query",
  "/api/admin/portraitAssets/manual-review/detail",
  "/api/admin/portraitAssets/manual-review/preview/grant",
  "/api/admin/portraitAssets/list",
  "/api/admin/pricingRules/list",
  "/api/admin/pricingGroups/list",
  "/api/admin/providerChannels/list",
  "/api/admin/relayTasks/list",
  "/api/admin/releases/list",
  "/api/admin/releases/deployments/events",
  "/api/admin/releases/deployments/get",
  "/api/admin/releases/deployments/list",
  "/api/admin/releases/deployments/preview",
  "/api/admin/requestLogs/list",
  "/api/admin/requestLogs/stats",
  "/api/admin/systemSettings/list",
  "/api/admin/users/list",
]);

export class AdminStepUpPolicyError extends Error {
  status: number;
  code: string;
  auditAction: string | null;
  auditMetadata: Record<string, unknown> | null;

  constructor(
    message: string,
    status: number,
    code: string,
    audit?: {
      action: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "AdminStepUpPolicyError";
    this.status = status;
    this.code = code;
    this.auditAction = audit?.action || null;
    this.auditMetadata = audit?.metadata || null;
  }
}

function normalizePath(raw: string): string {
  const path = String(raw || "").split("?", 1)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function userUpdateScope(body: Record<string, unknown>): StepUpScope {
  const categories = new Set<StepUpScope>();
  if (body.role !== undefined) categories.add("admin.user.role");
  if (body.status !== undefined) categories.add("admin.user.status");
  if (body.commercial !== undefined) categories.add("admin.user.commercial");
  if (body.displayName !== undefined || body.email !== undefined) categories.add("admin.user.profile");
  if (!categories.size) categories.add("admin.user.profile");
  if (categories.size !== 1) {
    throw new AdminStepUpPolicyError(
      "管理员用户更新一次只能提交一个敏感类别，请拆分角色、状态、商业资料或基础资料变更",
      400,
      "ADMIN_STEP_UP_SCOPE_AMBIGUOUS",
    );
  }
  return [...categories][0];
}

function systemSettingsUpdateScope(
  body: Record<string, unknown>,
): StepUpScope | null {
  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return null;
  }
  try {
    assertGenericAdminSettingKeys(Object.keys(settings));
  } catch (err) {
    if (err instanceof AdminSettingPartitionError) {
      throw new AdminStepUpPolicyError(
        err.message,
        err.status,
        err.code,
        {
          action: "admin.system_settings.cross_domain_rejected",
          metadata: {
            rejectedKey: err.key,
            reasonCode: err.reasonCode,
          },
        },
      );
    }
    throw err;
  }
  return "admin.system_settings";
}

function billingAccountScope(
  body: Record<string, unknown>,
): StepUpScope | null {
  const creditLimitMicros = body.creditLimitMicros;
  return typeof creditLimitMicros === "number"
    && Number.isSafeInteger(creditLimitMicros)
    && creditLimitMicros >= 0
    ? "admin.finance.adjustment"
    : null;
}

export function resolveAdminStepUpScope(input: {
  method: string;
  path: string;
  body?: Record<string, unknown> | null;
}): StepUpScope | null {
  const method = String(input.method || "GET").toUpperCase();
  const originalPath = normalizePath(input.path);
  // Admin MCP aliases retain every step-up and production-write restriction
  // of their canonical handlers. Never make a privileged POST a free alias.
  const path = originalPath === "/api/admin/agentTools/prompts/update"
    ? "/api/setting/promptManage/updatePrompt"
    : originalPath === "/api/admin/agentTools/prompts"
      ? "/api/setting/promptManage/getPrompt"
      : originalPath.replace(/^\/api\/admin\/agentTools\/roles(?=\/|$)/, "/api/agent/config/roles");
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return null;
  if (
    isGlobalMutableContentWritePath(path)
    && isProductionGlobalContentRuntime()
  ) {
    throw new AdminStepUpPolicyError(
      GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE_MESSAGE,
      503,
      GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE_CODE,
    );
  }
  if (method === "POST" && PRIVILEGED_READ_POST_PATHS.has(path)) return null;
  if (LEGACY_FAIL_CLOSED_PATHS.has(path)) {
    throw new AdminStepUpPolicyError(
      "此 legacy 特权操作的产品与运行时边界尚未完成安全设计，已拒绝执行",
      403,
      "LEGACY_PRIVILEGED_OPERATION_NOT_AVAILABLE",
    );
  }
  if (/^\/api\/setting\/vendorConfig\/modelTest(?:\/[^/]+)?$/.test(path)) {
    return "legacy.vendor_config.manage";
  }
  if (method === "PUT" && /^\/api\/agent\/config\/roles\/[^/]+$/.test(path)) {
    return "admin.agent_runtime_config";
  }
  if (
    method === "POST"
    && (
      /^\/api\/releaseControl\/human\/plans\/[^/]+\/authorizations$/.test(path)
      || /^\/api\/releaseControl\/human\/executions\/[^/]+\/cancel$/.test(path)
      || /^\/api\/releaseControl\/human\/release-candidates\/[^/]+\/authorizations$/.test(path)
      || /^\/api\/releaseControl\/human\/release-candidates\/[^/]+\/fast-track$/.test(path)
      || /^\/api\/releaseControl\/human\/modular\/plans\/[^/]+\/authorizations$/.test(path)
      || /^\/api\/releaseControl\/human\/modular\/executions\/[^/]+\/(?:cancel|rollback)$/.test(path)
    )
  ) {
    return "admin.deployment";
  }
  if (path === "/api/billing/account") {
    return billingAccountScope(input.body || {});
  }
  const privilegedScope = PRIVILEGED_STATIC_SCOPES[path];
  if (privilegedScope) return privilegedScope;
  if (PRIVILEGED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new AdminStepUpPolicyError(
      "此特权写操作尚未建立 step-up scope，已安全拒绝",
      503,
      "PRIVILEGED_STEP_UP_SCOPE_NOT_MAPPED",
    );
  }
  if (!path.startsWith(ADMIN_PREFIX)) return null;
  if (method === "POST" && READ_ONLY_POST_PATHS.has(path)) return null;
  if (path === "/api/admin/systemSettings/update") {
    return systemSettingsUpdateScope(input.body || {});
  }
  if (path === "/api/admin/users/update") return userUpdateScope(input.body || {});
  if (/^\/api\/admin\/billing\/serviceRequests\/[^/]+\/review$/.test(path)) {
    return "admin.billing.service_request";
  }
  if (
    /^\/api\/admin\/billing\/serviceRequests\/[^/]+\/(?:issue|recover)$/.test(
      path,
    )
  ) {
    return "admin.finance.case";
  }
  if (/^\/api\/admin\/providerChannels\/test\/[^/]+\/test$/.test(path)) return "admin.provider_channel";
  if (/^\/api\/admin\/fjtv\/[^/]+\/review$/.test(path)) return "admin.system_settings";
  if (/^\/api\/admin\/redemption\/[^/]+\/disable$/.test(path)) return "admin.redemption";
  if (method === "DELETE" && /^\/api\/admin\/backup\/delete\/[^/]+$/.test(path)) return "admin.backup.delete";
  // 0.1.4 用户所属租户修改：独立 step-up scope（MFA 二次认证）。
  if (/^\/api\/admin\/users\/[^/]+\/commercial-attribution\/change-owner$/.test(path)) {
    return "admin.user.attribution";
  }
  // 0.1.4 租户目录写操作。
  if (path === "/api/admin/tenantDirectory" && method === "POST") return "admin.tenant_domain";
  if (path === "/api/admin/tenantDirectory/update") return "admin.tenant_domain";
  if (path === "/api/admin/tenantDirectory/import") return "admin.tenant_domain";
  // MT-P1-01/04/06/10：生命周期与品牌配置。
  if (path === "/api/admin/tenantDirectory/suspend") return "admin.tenant_ingress";
  if (path === "/api/admin/tenantDirectory/activate") return "admin.tenant_ingress";
  if (path === "/api/admin/tenantDirectory/resume") return "admin.tenant_ingress";
  if (path === "/api/admin/tenantDirectory/archive") return "admin.tenant_ingress";
  if (path === "/api/admin/tenantDirectory/brand") return "admin.tenant_domain";
  // MT-P1-08/09：容量刷新与受控漂移修复。
  if (path === "/api/admin/tenantOperations/capacity/refresh") return "admin.tenant_domain";
  if (path === "/api/admin/tenantOperations/drift/reconcile") return "admin.tenant_ingress";
  // MT-P1-05 回调校验是只读验证，不需要 proof。
  if (path === "/api/admin/tenantOperations/validate-callbacks") return null;
  // 0.1.4 域名登记与验证。
  if (path === "/api/admin/tenantDomains" && method === "POST") return "admin.tenant_domain";
  if (/^\/api\/admin\/tenantDomains\/[^/]+\/verification(?:\/check)?$/.test(path)) {
    return "admin.tenant_domain";
  }
  if (/^\/api\/admin\/tenantDomains\/[^/]+\/icp$/.test(path)) return "admin.tenant_domain";
  if (method === "DELETE" && /^\/api\/admin\/tenantDomains\/[^/]+$/.test(path)) {
    return "admin.tenant_domain";
  }
  // 域名预检是只读操作，不需要 step-up。
  if (/^\/api\/admin\/tenantDomains\/[^/]+\/preflight$/.test(path)) return null;
  // 0.1.4 入口发布/中止/暂停/恢复：更高的入口变更 scope。
  if (/^\/api\/admin\/tenantDomains\/[^/]+\/(?:publish|abort|suspend|restore)$/.test(path)) {
    return "admin.tenant_ingress";
  }
  // 0.1.4 证书导入/引用/校验/删除与域名证书绑定/轮换。
  if (path === "/api/admin/tenantCertificates/import") return "admin.tenant_certificate";
  if (path === "/api/admin/tenantCertificates/reference") return "admin.tenant_certificate";
  if (/^\/api\/admin\/tenantCertificates\/[^/]+\/validate$/.test(path)) return "admin.tenant_certificate";
  if (method === "DELETE" && /^\/api\/admin\/tenantCertificates\/[^/]+$/.test(path)) {
    return "admin.tenant_certificate";
  }
  if (/^\/api\/admin\/tenantDomains\/[^/]+\/certificates\/(?:bind|rotate)$/.test(path)) {
    return "admin.tenant_certificate";
  }
  // 0.1.4 对账中心账期关账与账单导入（预检/导出为只读，不需要 proof）。
  if (/^\/api\/admin\/tenantReconciliation\/periods\/[^/]+\/preflight$/.test(path)) {
    return null;
  }
  if (/^\/api\/admin\/tenantReconciliation\/periods\/[^/]+\/close$/.test(path)) {
    return "admin.tenant_reconciliation";
  }
  // MT-P1-03 账期重开审批（Root + MFA）。
  if (/^\/api\/admin\/tenantReconciliation\/periods\/[^/]+\/reopen$/.test(path)) {
    return "admin.tenant_reconciliation";
  }
  if (path === "/api/admin/tenantReconciliation/provider-invoices/import") {
    return "admin.tenant_reconciliation";
  }
  const scope = STATIC_SCOPES[path];
  if (scope) return scope;
  throw new AdminStepUpPolicyError(
    "此管理员写操作尚未建立 step-up scope，已安全拒绝",
    503,
    "ADMIN_STEP_UP_SCOPE_NOT_MAPPED",
  );
}

function proofFrom(req: Request): string {
  const value = req.headers["x-fanjin-step-up"];
  return String(Array.isArray(value) ? value[0] || "" : value || "").trim();
}

export function resolveFinanceStepUpBinding(
  path: string,
  body: Record<string, unknown>,
): {
  binding: FinanceStepUpBindingV1;
  command: Record<string, unknown>;
} | null {
  const match = path.match(
    /^\/api\/admin\/billing\/serviceRequests\/([^/]+)\/(review|issue|recover)$/,
  );
  if (!match) return null;
  let requestId: string;
  try {
    requestId = decodeURIComponent(match[1] || "").trim();
  } catch {
    throw new AdminStepUpPolicyError(
      "service request id 编码无效",
      400,
      "FINANCE_REQUEST_ID_INVALID",
    );
  }
  if (!requestId) {
    throw new AdminStepUpPolicyError(
      "service request id 不能为空",
      400,
      "FINANCE_REQUEST_ID_REQUIRED",
    );
  }
  const action = match[2] as "review" | "issue" | "recover";
  const operation = `service_request_${action}` as
    FinanceStepUpBindingV1["operation"];
  let command: Record<string, unknown>;
  if (action === "review") {
    const parsed = serviceRequestReviewSchema.safeParse(body);
    if (!parsed.success) {
      throw new AdminStepUpPolicyError(
        "service request review 参数无效",
        400,
        "SERVICE_REQUEST_REVIEW_INVALID",
      );
    }
    command = { operation, requestId, ...parsed.data };
  } else if (action === "issue") {
    const parsed = serviceRequestIssueSchema.safeParse(body);
    if (!parsed.success) {
      throw new AdminStepUpPolicyError(
        "service request issue 参数无效",
        400,
        "SERVICE_REQUEST_ISSUE_INVALID",
      );
    }
    command = { operation, requestId, ...parsed.data };
  } else {
    const parsed = serviceRequestRecoverSchema.safeParse(body);
    if (!parsed.success) {
      throw new AdminStepUpPolicyError(
        "service request recover 参数无效",
        400,
        "SERVICE_REQUEST_RECOVER_INVALID",
      );
    }
    command = { operation, requestId, ...parsed.data };
  }
  return {
    command,
    binding: {
      bindingVersion: "finance-step-up/v1",
      operation,
      requestId,
      requestFingerprint: financeStepUpRequestFingerprint(command),
      resourceType: "billing_service_request",
      resourceId: requestId,
      resourceFingerprint: financeStepUpResourceFingerprint(requestId),
    },
  };
}

function registerPrivilegedAudit(req: Request, res: Response, scope: StepUpScope) {
  if (req.path.startsWith(ADMIN_PREFIX)) return;
  const startedAt = Date.now();
  const path = req.path;
  const isAgentRuntimeConfig = scope === "admin.agent_runtime_config";
  res.on("finish", () => {
    if (hasAuditLogWritten(req)) return;
    void writeAuditLog(req, {
      action: `privileged.${scope}`,
      resourceType: scope.startsWith("api_key.")
        ? "api_key"
        : scope.startsWith("workspace.member.")
          ? "workspace_member"
        : isAgentRuntimeConfig
          ? "agent_runtime_config"
          : "legacy_setting",
      resourceId: isAgentRuntimeConfig ? path.split("/").filter(Boolean).at(-1) ?? null : null,
      metadata: {
        method: req.method,
        path,
        statusCode: res.statusCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        stepUpScope: scope,
      },
    });
  });
}

export async function adminStepUpMiddleware(req: Request, res: Response, next: NextFunction) {
  let scope: StepUpScope | null;
  try {
    scope = resolveAdminStepUpScope({
      method: req.method,
      path: req.path,
      body: req.body && typeof req.body === "object" ? req.body : {},
    });
  } catch (err) {
    if (err instanceof AdminStepUpPolicyError) {
      if (err.auditAction) {
        try {
          await writeAuditLog(req, {
            action: err.auditAction,
            resourceType: "system_settings",
            resourceId: "platform",
            required: true,
            metadata: err.auditMetadata || {},
          });
        } catch {
          return res.status(503).send(error(
            "安全审计暂不可用，设置请求已拒绝且未执行",
            { code: "FJADMIN_AUDIT_UNAVAILABLE" },
          ));
        }
      }
      return res.status(err.status).send(error(err.message, {
        code: err.code,
        ...(err.auditMetadata?.reasonCode
          ? { reasonCode: String(err.auditMetadata.reasonCode) }
          : {}),
        ...(err.auditMetadata?.rejectedKey
          ? { key: String(err.auditMetadata.rejectedKey) }
          : {}),
      }));
    }
    return next(err);
  }
  if (!scope) return next();

  const machine = readAdminMachineIdentity(req);
  if (machine) {
    const policy = (req as any).fjadminOperationPolicy;
    if (!policy || policy.status !== "ACTIVE" || !req.path.startsWith(ADMIN_PREFIX)
      || policy.permissions.some((permission: string) => !machine.permissions.includes(permission))) {
      return res.status(403).send(error("机器凭据缺少操作权限", { code: "ADMIN_MACHINE_SCOPE_INVALID" }));
    }
    try {
      const finance = resolveFinanceStepUpBinding(normalizePath(req.path), req.body ?? {});
      if (finance) res.locals.verifiedFinanceStepUpContext = await authorizeMachineFinanceOperation(machine, scope, finance.binding, policy.permissions);
      (req as any).adminStepUpScope = scope;
      res.locals.adminStepUpScope = scope;
      registerPrivilegedAudit(req, res, scope);
      return next();
    } catch (caught) {
      if (caught instanceof AdminMachineCredentialError || caught instanceof AdminStepUpPolicyError) return res.status(caught.status).send(error(caught.message, { code: caught.code }));
      return next(caught);
    }
  }

  const userId = Number((req as any).auth?.user?.id || 0);
  const sessionId = String((req as any).auth?.session?.id || "");
  if (!userId || !sessionId) return res.status(401).send(error("未登录"));
  const path = normalizePath(req.path);
  const delegatedAction = String(
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>).action || ""
      : "",
  );
  if (
    path === RELEASE_ARTIFACT_UPLOAD_PATH
    && scope === "admin.deployment"
    && RELEASE_ARTIFACT_DELEGATED_ACTIONS.has(delegatedAction)
  ) {
    try {
      const delegated = await authorizeReleaseArtifactMultipartDelegation({
        sessionId: String((req.body as Record<string, unknown>).sessionId || ""),
        resumeGrant: String((req.body as Record<string, unknown>).resumeGrant || ""),
        operatorUserId: userId,
        operatorSessionId: sessionId,
      });
      (req as any).adminStepUpScope = scope;
      res.locals.adminStepUpScope = scope;
      res.locals.releaseArtifactMultipartDelegation = {
        scope,
        action: delegatedAction,
        sessionId: delegated.sessionId,
        expiresAt: delegated.expiresAt,
      };
      registerPrivilegedAudit(req, res, scope);
      return next();
    } catch (caught) {
      if (caught instanceof ReleaseArtifactMultipartUploadError) {
        return res.status(caught.status).send(error(caught.message, {
          code: caught.code,
        }));
      }
      return next(caught);
    }
  }
  if (path === OWNER_TRANSFER_PATH && scope === "workspace.owner.transfer") {
    const proof = proofFrom(req);
    if (!proof) {
      return res.status(401).send(error("敏感操作需要 step-up proof", {
        code: "STEP_UP_REQUIRED",
      }));
    }
    // Owner transfer is the one canonical route whose proof must be consumed
    // by the same transaction that changes owner authority and writes the
    // required audit row. All other routes keep the existing eager behavior.
    res.locals.deferredTransactionalStepUp = {
      proof,
      userId,
      sessionId,
      scope,
    } satisfies DeferredTransactionalStepUp;
    (req as any).adminStepUpScope = scope;
    res.locals.adminStepUpScope = scope;
    registerPrivilegedAudit(req, res, scope);
    return next();
  }
  try {
    const finance = resolveFinanceStepUpBinding(
      path,
      req.body && typeof req.body === "object" ? req.body : {},
    );
    const consumed = await consumeStepUpProof(db, {
      proof: proofFrom(req),
      userId,
      sessionId,
      scope,
      ...(finance ? { financeBinding: finance.binding } : {}),
    });
    (req as any).adminStepUpScope = scope;
    res.locals.adminStepUpScope = scope;
    if (finance) {
      res.locals.verifiedFinanceStepUpContext = {
        verificationSource: "central_step_up_middleware/v2",
        proofRecordId: consumed.proofRecordId,
        actorUserId: userId,
        actorRole: consumed.actorRole,
        authorizationRevision: consumed.authorizationRevision,
        method: consumed.method,
        scope:
          finance.binding.operation === "service_request_review"
            ? "admin.billing.service_request"
            : "admin.finance.case",
        operation: finance.binding.operation,
        requestId: finance.binding.requestId,
        requestFingerprint: finance.binding.requestFingerprint,
        resourceType: finance.binding.resourceType,
        resourceId: finance.binding.resourceId,
        resourceFingerprint: finance.binding.resourceFingerprint,
        expiresAt: consumed.expiresAt,
        consumedAt: consumed.consumedAt,
      } satisfies VerifiedFinanceStepUpContextV1;
    }
    registerPrivilegedAudit(req, res, scope);
    return next();
  } catch (err) {
    if (err instanceof StepUpError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (err instanceof AdminStepUpPolicyError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    return next(err);
  }
}
