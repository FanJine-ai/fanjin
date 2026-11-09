export type AdminOperationPolicyStatus =
  | "ACTIVE"
  | "RESERVED"
  | "OFFLINE_ONLY"
  | "LEGACY_FAIL_CLOSED"
  | "LEGACY_410"
  | "REJECT_CLASSIFIER";

export type AdminOperationHardGate =
  | "platform_root"
  | "release_publisher"
  | "release_reconciler"
  | null;

export interface AdminOperationPolicy {
  id: string;
  method: string;
  pathPattern: string;
  permissions: readonly string[];
  permissionMode: "EXACT" | "ALL";
  hardGate: AdminOperationHardGate;
  stepUpScope: string | null;
  auditAction: string;
  auditMode: "required" | "denial_only";
  status: AdminOperationPolicyStatus;
  mutates: boolean;
}

type PolicyTuple = readonly [
  method: string,
  pathPattern: string,
  id: string,
  permissions: readonly string[],
  permissionMode: "EXACT" | "ALL",
  hardGate: AdminOperationHardGate,
  stepUpScope: string | null,
  auditAction: string,
  auditMode: "required" | "denial_only",
  status: AdminOperationPolicyStatus,
  mutates: boolean,
];

/*
 * Generated projection of admin-c1-final-decision.v1. Keep this runtime-owned
 * catalog in the API bundle; production images do not contain repository-level
 * governance files.
 */
const STATIC_POLICY_TUPLES: readonly PolicyTuple[] = [
  ["GET", "/api/admin/releases/community-update", "COMMUNITY_UPDATE_STATUS", ["fjadmin:operations:releases:read"], "EXACT", "platform_root", null, "admin.community_update.status", "required", "ACTIVE", false],
  ["POST", "/api/admin/releases/community-update", "COMMUNITY_UPDATE_OPEN", ["fjadmin:operations:releases:deploy"], "EXACT", "platform_root", "admin.deployment", "admin.community_update.open", "required", "ACTIVE", true],
  ["GET", "/api/admin/agentTools/roles", "MCP_ROLE_LIST", ["fjadmin:agents:overview:read"], "EXACT", null, null, "admin.agent_runtime_config.list", "required", "ACTIVE", false],
  ["GET", "/api/admin/agentTools/roles/:role", "MCP_ROLE_GET", ["fjadmin:agents:overview:read"], "EXACT", null, null, "admin.agent_runtime_config.get", "required", "ACTIVE", false],
  ["PUT", "/api/admin/agentTools/roles/:role", "MCP_ROLE_SAVE", ["fjadmin:settings:general:write"], "EXACT", null, "admin.agent_runtime_config", "admin.agent_runtime_config.update", "required", "ACTIVE", true],
  ["POST", "/api/admin/agentTools/prompts", "MCP_PROMPT_LIST", ["fjadmin:agents:prompts:read"], "EXACT", null, null, "admin.prompt.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/agentTools/prompts/update", "MCP_PROMPT_SAVE", ["fjadmin:settings:general:write"], "EXACT", null, "legacy.content_config.manage", "admin.prompt.update", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/membership/status", "MEM_STATUS", ["fjadmin:finance:plans:read"], "EXACT", null, null, "admin.membership.status", "required", "ACTIVE", false],
  ["POST", "/api/admin/billing/membership/contract", "MEM_CONTRACT", ["fjadmin:finance:plans:read"], "EXACT", null, null, "admin.membership.contract", "required", "ACTIVE", false],
  ["POST", "/api/admin/billing/membership/configure", "MEM_CONFIGURE", ["fjadmin:finance:plans:write"], "EXACT", null, "admin.billing.plan", "admin.membership.configure", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/membership/retry", "MEM_RETRY", ["fjadmin:finance:plans:write"], "EXACT", null, "admin.billing.plan", "admin.membership.retry", "required", "ACTIVE", true],
  ["POST", "/api/admin/agent/reconciliation/report", "OP001", [], "EXACT", null, null, "admin.agent.reconciliation.report", "required", "RESERVED", false],
  ["POST", "/api/admin/auditLogs/list", "OP002", ["fjadmin:security:audit_logs:read"], "EXACT", null, null, "admin.audit_logs.list", "required", "ACTIVE", false],
  ["GET", "/api/admin/backup/list", "OP003", ["fjadmin:operations:backups:read"], "EXACT", null, null, "admin.backup.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/backup/create", "OP004", ["fjadmin:operations:backups:create"], "EXACT", "platform_root", "admin.backup.manage", "admin.backup.create", "required", "ACTIVE", true],
  ["POST", "/api/admin/backup/restore", "OP005", ["fjadmin:operations:backups:restore"], "EXACT", "platform_root", null, "admin.backup.restore_offline_required", "required", "OFFLINE_ONLY", false],
  ["DELETE", "/api/admin/backup/delete/:id", "OP006", ["fjadmin:operations:backups:delete"], "EXACT", "platform_root", "admin.backup.delete", "admin.backup.delete", "required", "ACTIVE", true],
  ["POST", "/api/admin/backup/cleanup", "OP007", ["fjadmin:operations:backups:delete"], "EXACT", "platform_root", "admin.backup.delete", "admin.backup.cleanup", "required", "ACTIVE", true],
  ["GET", "/api/admin/backup/config", "OP008", ["fjadmin:operations:backups:read"], "EXACT", null, null, "admin.backup.config.read", "required", "ACTIVE", false],
  ["POST", "/api/admin/billing/plans/create", "OP009", ["fjadmin:finance:plans:write"], "EXACT", null, "admin.billing.plan", "admin.billing_plan.create", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/plans/list", "OP010", ["fjadmin:finance:plans:read"], "EXACT", null, null, "admin.billing_plan.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/billing/plans/update", "OP011", ["fjadmin:finance:plans:write"], "EXACT", null, "admin.billing.plan", "admin.billing_plan.update", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/reconciliation/list", "OP012", ["fjadmin:finance:reconciliation:read"], "EXACT", null, null, "admin.billing.reconciliation.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/billing/reconciliation/run", "OP013", ["fjadmin:finance:reconciliation:execute"], "EXACT", null, "admin.billing.reconciliation", "admin.billing.reconciliation.run", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/reconciliation/resolve", "OP014", ["fjadmin:finance:reconciliation:resolve"], "EXACT", null, "admin.billing.reconciliation", "admin.billing.reconciliation.resolve", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/serviceRequests/list", "OP015", ["fjadmin:identity:service_requests:read"], "EXACT", null, null, "admin.billing.service_request.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/billing/serviceRequests/update", "OP016", [], "EXACT", null, null, "admin.billing.service_request.legacy_update_blocked", "required", "LEGACY_FAIL_CLOSED", false],
  ["POST", "/api/admin/finance/overview", "OP017", ["fjadmin:finance:overview:read"], "EXACT", null, null, "finance.overview.read", "required", "ACTIVE", false],
  ["POST", "/api/admin/finance/cases/list", "OP018", ["fjadmin:identity:service_requests:read"], "EXACT", null, null, "finance.case.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/finance/cases/update", "OP019", [], "EXACT", null, null, "finance.case.legacy_update_blocked", "required", "LEGACY_FAIL_CLOSED", false],
  ["POST", "/api/admin/finance/accounts/list", "OP020", ["fjadmin:finance:accounts:read"], "EXACT", null, null, "finance.account.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/finance/gift-grants/list", "OP021", ["fjadmin:finance:gift_grants:read"], "EXACT", null, null, "finance.gift_grant.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/finance/gift-grants/revoke", "OP022", ["fjadmin:finance:gift_grants:revoke"], "EXACT", null, "admin.finance.gift_grant", "finance.gift_grant.revoke", "required", "ACTIVE", true],
  ["POST", "/api/admin/finance/ledger/list", "OP023", ["fjadmin:finance:ledger:read"], "EXACT", null, null, "finance.ledger.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/finance/income/list", "OP024", ["fjadmin:finance:income:read"], "EXACT", null, null, "finance.income.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/finance/reconciliation/list", "OP025", ["fjadmin:finance:reconciliation:read"], "EXACT", null, null, "finance.reconciliation.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/finance/adjustments/create", "OP026", ["fjadmin:finance:adjustments:create"], "EXACT", null, "admin.finance.adjustment", "finance.adjustment.create", "required", "ACTIVE", true],
  ["POST", "/api/admin/redemption/generate", "OP045", ["fjadmin:finance:redemption:write"], "EXACT", null, "admin.redemption", "admin.redemption.generate", "required", "ACTIVE", true],
  ["GET", "/api/admin/redemption/list", "OP046", ["fjadmin:finance:redemption:read"], "EXACT", null, null, "admin.redemption.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/redemption/:id/disable", "OP047", ["fjadmin:finance:redemption:write"], "EXACT", null, "admin.redemption", "admin.redemption.disable", "required", "ACTIVE", true],
  ["POST", "/api/admin/modelRoutes/create", "OP027", ["fjadmin:models:routes:write"], "EXACT", null, "admin.model_route", "admin.model_route.create", "required", "ACTIVE", true],
  ["POST", "/api/admin/modelRoutes/delete", "OP028", ["fjadmin:models:routes:write"], "EXACT", null, "admin.model_route", "admin.model_route.disable", "required", "ACTIVE", true],
  ["POST", "/api/admin/modelRoutes/list", "OP029", ["fjadmin:models:routes:read"], "EXACT", null, null, "admin.model_route.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/modelRoutes/update", "OP030", ["fjadmin:models:routes:write"], "EXACT", null, "admin.model_route", "admin.model_route.update", "required", "ACTIVE", true],
  ["GET", "/api/admin/observability/health", "OP031", ["fjadmin:operations:observability:read"], "EXACT", null, null, "admin.observability.health.read", "denial_only", "ACTIVE", false],
  ["GET", "/api/admin/observability/logs", "OP032", ["fjadmin:operations:observability:read"], "EXACT", null, null, "admin.observability.logs.read", "required", "ACTIVE", false],
  ["GET", "/api/admin/observability/metrics", "OP033", ["fjadmin:operations:observability:read"], "EXACT", null, null, "admin.observability.metrics.read", "denial_only", "ACTIVE", false],
  ["POST", "/api/admin/pricingRules/create", "OP034", ["fjadmin:finance:pricing:write"], "EXACT", null, "admin.pricing_rule", "admin.pricing_rule.create", "required", "ACTIVE", true],
  ["POST", "/api/admin/pricingRules/delete", "OP035", ["fjadmin:finance:pricing:write"], "EXACT", null, "admin.pricing_rule", "admin.pricing_rule.disable", "required", "ACTIVE", true],
  ["POST", "/api/admin/pricingRules/list", "OP036", ["fjadmin:finance:pricing:read"], "EXACT", null, null, "admin.pricing_rule.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/pricingRules/update", "OP037", ["fjadmin:finance:pricing:write"], "EXACT", null, "admin.pricing_rule", "admin.pricing_rule.update", "required", "ACTIVE", true],
  ["POST", "/api/admin/providerChannels/delete", "OP039", ["fjadmin:providers:channels:write"], "EXACT", null, "admin.provider_channel", "admin.provider_channel.disable", "required", "ACTIVE", true],
  ["POST", "/api/admin/providerChannels/list", "OP041", ["fjadmin:providers:channels:read"], "EXACT", null, null, "admin.provider_channel.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/providerChannels/models", "OP042", ["fjadmin:providers:channels:execute"], "EXACT", null, "admin.provider_channel", "admin.provider_channel.model_discovery", "required", "ACTIVE", false],
  ["POST", "/api/admin/providerChannels/test/:id/test", "OP043", ["fjadmin:providers:channels:execute"], "EXACT", null, "admin.provider_channel", "admin.provider_channel.test", "required", "ACTIVE", false],
  ["POST", "/api/admin/relayTasks/cancel", "OP048", ["fjadmin:operations:tasks:cancel"], "EXACT", null, "admin.relay_task", "relay_task.cancel", "required", "ACTIVE", true],
  ["POST", "/api/admin/relayTasks/list", "OP049", ["fjadmin:operations:tasks:read"], "EXACT", null, null, "relay_task.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/relayTasks/refresh", "OP050", ["fjadmin:operations:tasks:refresh"], "EXACT", null, "admin.relay_task", "relay_task.refresh", "required", "ACTIVE", true],
  ["POST", "/api/admin/releases/archive", "OP051", ["fjadmin:operations:releases:write"], "EXACT", null, "admin.release", "admin.platform_release.archive", "required", "ACTIVE", true],
  ["POST", "/api/admin/releases/artifacts/ready", "OP052", ["fjadmin:operations:releases:deploy"], "EXACT", "release_publisher", "admin.deployment", "admin.release_artifact.ready", "required", "ACTIVE", true],
  ["GET", "/api/admin/releases/artifacts/ready/status/:jobId", "OP052a", ["fjadmin:operations:releases:read"], "EXACT", "release_publisher", null, "admin.release_artifact.ready_status", "required", "ACTIVE", false],
  ["POST", "/api/admin/releases/artifacts/register", "OP053", ["fjadmin:operations:releases:deploy"], "EXACT", "release_publisher", "admin.deployment", "admin.release_artifact.register", "required", "ACTIVE", true],
  ["POST", "/api/admin/releases/artifacts/upload-url", "OP054", ["fjadmin:operations:releases:deploy"], "EXACT", "release_publisher", "admin.deployment", "admin.release_artifact.upload_url", "required", "ACTIVE", true],
  ["POST", "/api/admin/releases/create", "OP055", ["fjadmin:operations:releases:write"], "EXACT", null, "admin.release", "admin.platform_release.create", "required", "ACTIVE", true],
  ["POST", "/api/admin/releases/deployments/cancel", "OP056", ["fjadmin:operations:releases:deploy"], "EXACT", "release_publisher", "admin.deployment", "admin.release_deployment.cancel", "required", "ACTIVE", true],
  ["POST", "/api/admin/releases/deployments/events", "OP057", ["fjadmin:operations:releases:read"], "EXACT", "release_publisher", null, "admin.release_deployment.events", "required", "ACTIVE", false],
  ["POST", "/api/admin/releases/deployments/get", "OP058", ["fjadmin:operations:releases:read"], "EXACT", "release_publisher", null, "admin.release_deployment.get", "required", "ACTIVE", false],
  ["POST", "/api/admin/releases/deployments/list", "OP059", ["fjadmin:operations:releases:read"], "EXACT", "release_publisher", null, "admin.release_deployment.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/releases/deployments/preview", "OP060", ["fjadmin:operations:releases:read"], "EXACT", "release_publisher", null, "admin.release_deployment.preview", "required", "ACTIVE", false],
  ["POST", "/api/admin/releases/deployments/reconcile", "OP061", ["fjadmin:operations:releases:reconcile"], "EXACT", "release_reconciler", "admin.deployment", "admin.release_deployment.reconcile_requested", "required", "ACTIVE", true],
  ["POST", "/api/admin/releases/deployments/start", "OP062", ["fjadmin:operations:releases:deploy"], "EXACT", "release_publisher", "admin.deployment", "admin.release_deployment.start", "required", "ACTIVE", true],
  ["POST", "/api/admin/releases/list", "OP063", ["fjadmin:operations:releases:read"], "EXACT", null, null, "admin.platform_release.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/releases/publish", "OP064", ["fjadmin:operations:releases:publish"], "EXACT", "release_publisher", null, "admin.platform_release.legacy_publish_disabled", "required", "LEGACY_410", false],
  ["POST", "/api/admin/releases/update", "OP065", ["fjadmin:operations:releases:write"], "EXACT", null, "admin.release", "admin.platform_release.update", "required", "ACTIVE", true],
  ["POST", "/api/admin/requestLogs/export", "OP066", ["fjadmin:operations:request_logs:export"], "EXACT", null, "admin.request_log.export", "admin.request_log.export", "required", "ACTIVE", false],
  ["POST", "/api/admin/requestLogs/list", "OP067", ["fjadmin:operations:request_logs:read"], "EXACT", null, null, "admin.request_log.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/requestLogs/purge", "OP068", ["fjadmin:operations:request_logs:purge"], "EXACT", null, "admin.request_log.purge", "admin.request_log.purge", "required", "ACTIVE", true],
  ["POST", "/api/admin/requestLogs/stats", "OP069", ["fjadmin:operations:request_logs:read"], "EXACT", null, null, "admin.request_log.stats", "required", "ACTIVE", false],
  ["POST", "/api/admin/systemSettings/list", "OP070", ["fjadmin:settings:general:read"], "EXACT", null, null, "admin.system_settings.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/users/create", "OP072", ["fjadmin:identity:users:write"], "EXACT", null, "admin.user.create", "admin.user.create", "required", "ACTIVE", true],
  ["POST", "/api/admin/users/list", "OP073", ["fjadmin:identity:users:read"], "EXACT", null, null, "admin.user.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/videoFulfillment/enhance/pricing/update", "OP075", ["fjadmin:finance:pricing:write"], "EXACT", null, "admin.pricing_rule", "admin.video_fulfillment.enhance_pricing_update", "required", "ACTIVE", true],
  ["GET", "/api/admin/videoFulfillment/meta", "OP076", ["fjadmin:models:video_delivery:read"], "EXACT", null, null, "admin.video_fulfillment.meta.read", "denial_only", "ACTIVE", false],
  ["GET", "/api/admin/videoFulfillment/offers", "OP077", ["fjadmin:models:video_delivery:read"], "EXACT", null, null, "admin.video_fulfillment.offers.read", "required", "ACTIVE", false],
  ["GET", "/api/admin/videoFulfillment/recipes", "OP078", ["fjadmin:models:video_delivery:read"], "EXACT", null, null, "admin.video_fulfillment.recipes.read", "required", "ACTIVE", false],
  ["GET", "/api/admin/videoFulfillment/channels", "OP079", ["fjadmin:models:video_delivery:read"], "EXACT", null, null, "admin.video_fulfillment.channels.read", "required", "ACTIVE", false],
  ["GET", "/api/admin/videoFulfillment/enhance/overview", "OP080", ["fjadmin:models:video_delivery:read"], "EXACT", null, null, "admin.video_fulfillment.enhance_overview.read", "required", "ACTIVE", false],
  ["POST", "/api/admin/videoFulfillment/offers/update", "OP081", ["fjadmin:models:video_delivery:publish"], "EXACT", null, "admin.video_fulfillment", "admin.video_fulfillment.offer_update", "required", "ACTIVE", true],
  ["POST", "/api/admin/videoFulfillment/recipes/create", "OP082", ["fjadmin:models:video_delivery:write"], "EXACT", null, "admin.video_fulfillment", "admin.video_fulfillment.recipe_create", "required", "ACTIVE", true],
  ["POST", "/api/admin/videoFulfillment/recipes/delete", "OP083", ["fjadmin:models:video_delivery:write"], "EXACT", null, "admin.video_fulfillment", "admin.video_fulfillment.recipe_delete", "required", "ACTIVE", true],
  ["POST", "/api/admin/videoFulfillment/recipes/update", "OP084", ["fjadmin:models:video_delivery:write"], "EXACT", null, "admin.video_fulfillment", "admin.video_fulfillment.recipe_update", "required", "ACTIVE", true],
  ["POST", "/api/admin/modelPool/list", "OP085", ["fjadmin:providers:channels:read", "fjadmin:models:routes:read"], "ALL", null, null, "admin.model_pool.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/modelRouteGroups/list", "OP086", ["fjadmin:models:routes:read", "fjadmin:finance:pricing:read"], "ALL", null, null, "admin.model_route_group.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/modelRouteGroups/preflight", "OP087", ["fjadmin:models:routes:read", "fjadmin:finance:pricing:read"], "ALL", null, null, "admin.model_route_group.preflight", "required", "ACTIVE", false],
  ["POST", "/api/admin/modelRouteGroups/save", "OP088", ["fjadmin:models:routes:write", "fjadmin:finance:pricing:write"], "ALL", null, "admin.model_route", "admin.model_route_group.save", "required", "ACTIVE", true],
  ["POST", "/api/admin/modelRouteGroups/simulate", "OP089", ["fjadmin:models:routes:read"], "EXACT", null, null, "admin.model_route_group.simulate", "required", "ACTIVE", false],
  ["POST", "/api/admin/modelRouteGroups/updatePrice", "OP090", ["fjadmin:models:routes:write", "fjadmin:finance:pricing:write"], "ALL", null, "admin.pricing_rule", "admin.model_route_group.price_update", "required", "ACTIVE", true],
  ["POST", "/api/admin/pricingGroups/list", "OP091", ["fjadmin:finance:pricing:read"], "EXACT", null, null, "admin.pricing_group.list", "required", "ACTIVE", false],
  ["POST", "/api/admin/pricingGroups/create", "OP092", ["fjadmin:finance:pricing:write"], "EXACT", null, "admin.pricing_rule", "admin.pricing_group.create", "required", "ACTIVE", true],
  ["POST", "/api/admin/pricingGroups/update", "OP093", ["fjadmin:finance:pricing:write"], "EXACT", null, "admin.pricing_rule", "admin.pricing_group.update", "required", "ACTIVE", true],
  ["POST", "/api/admin/pricingGroups/delete", "OP094", ["fjadmin:finance:pricing:write"], "EXACT", null, "admin.pricing_rule", "admin.pricing_group.delete", "required", "ACTIVE", true],
  ["POST", "/api/admin/pricingGroups/assignUsers", "OP095", ["fjadmin:identity:users:commercial"], "EXACT", null, "admin.user.commercial", "admin.pricing_group.assign_users", "required", "ACTIVE", true],
  ["POST", "/api/billing/serviceRequests/submit", "SRV001", ["billing:request:create"], "EXACT", null, null, "billing.service_request.submit", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/serviceRequests/:id/review", "SRV002", ["fjadmin:identity:service_requests:review"], "EXACT", null, "admin.billing.service_request", "admin.billing.service_request.review", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/serviceRequests/:id/issue", "SRV003", ["fjadmin:identity:service_requests:review", "fjadmin:finance:service_requests:approve"], "ALL", null, "admin.finance.case", "admin.billing.service_request.issue", "required", "ACTIVE", true],
  ["POST", "/api/admin/billing/serviceRequests/:id/recover", "SRV004", ["fjadmin:finance:service_requests:approve"], "EXACT", null, "admin.finance.case", "admin.billing.service_request.recover", "required", "ACTIVE", true],
];

export const STATIC_ADMIN_OPERATION_POLICIES: readonly AdminOperationPolicy[] =
  STATIC_POLICY_TUPLES.map(([
    method,
    pathPattern,
    id,
    permissions,
    permissionMode,
    hardGate,
    stepUpScope,
    auditAction,
    auditMode,
    status,
    mutates,
  ]) => Object.freeze({
    id,
    method,
    pathPattern,
    permissions: Object.freeze([...permissions]),
    permissionMode,
    hardGate,
    stepUpScope,
    auditAction,
    auditMode,
    status,
    mutates,
  }));
