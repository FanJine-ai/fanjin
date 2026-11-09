// @db-hash 0862fc8d69d77b6bfc565a7350eaba6f
//该文件由脚本自动生成，请勿手动修改

export interface memories {
  'content': string;
  'createTime': number;
  'embedding'?: string | null;
  'id'?: string;
  'isolationKey': string;
  'name'?: string | null;
  'relatedMessageIds'?: string | null;
  'role'?: string | null;
  'summarized'?: number | null;
  'type': string;
}
export interface o_account_gift_grant {
  'amountMicros'?: number;
  'campaignName'?: string | null;
  'createdAt': number;
  'currency'?: string;
  'description'?: string | null;
  'expiresAt'?: number | null;
  'id'?: string;
  'metadata'?: string;
  'operatorUserId'?: number | null;
  'remainingMicros'?: number;
  'reservedMicros'?: number;
  'status'?: string;
  'updatedAt': number;
  'userId': number;
}
export interface o_account_mfa_recovery_code {
  'codeHash': string;
  'createdAt': number;
  'id'?: string;
  'usedAt'?: number | null;
  'userId': number;
}
export interface o_account_security {
  'createdAt': number;
  'id'?: string;
  'loginIpAllowlist'?: string;
  'loginProtectionEnabled'?: number;
  'mfaConfiguredAt'?: number | null;
  'mfaEnabled'?: number;
  'mfaPendingCreatedAt'?: number | null;
  'mfaPendingSecret'?: string | null;
  'mfaSecret'?: string | null;
  'passwordPolicy'?: string;
  'phone'?: string | null;
  'sensitiveOperationProtectionEnabled'?: number;
  'sessionPolicy'?: string;
  'updatedAt': number;
  'userId': number;
}
export interface o_account_verification {
  'approvedAt'?: number | null;
  'companyName'?: string | null;
  'contactPhone'?: string | null;
  'createdAt': number;
  'id'?: string;
  'idNumberMasked'?: string | null;
  'legalRepresentative'?: string | null;
  'metadata'?: string;
  'rejectedReason'?: string | null;
  'status'?: string;
  'subjectName'?: string | null;
  'submittedAt'?: number | null;
  'type': string;
  'unifiedSocialCreditCode'?: string | null;
  'updatedAt': number;
  'userId': number;
  'workspaceId'?: string | null;
}
export interface o_account_wallet {
  'balanceMicros'?: number;
  'cashReservedMicros'?: number;
  'createdAt': number;
  'creditLimitMicros'?: number;
  'creditReservedMicros'?: number;
  'creditUsedMicros'?: number;
  'currency'?: string;
  'giftBalanceMicros'?: number;
  'giftReservedMicros'?: number;
  'id'?: string;
  'metadata'?: string;
  'status'?: string;
  'updatedAt': number;
  'userId': number;
}
export interface o_account_wallet_ledger {
  'amountMicros'?: number;
  'balanceAfterMicros'?: number;
  'balanceBeforeMicros'?: number;
  'createdAt': number;
  'currency'?: string;
  'description'?: string | null;
  'direction': string;
  'id'?: string;
  'idempotencyKey'?: string | null;
  'incomeRecordId'?: string | null;
  'metadata'?: string;
  'operatorUserId'?: number | null;
  'requestId'?: string | null;
  'serviceRequestId'?: string | null;
  'type': string;
  'updatedAt': number;
  'userId': number;
  'walletId': string;
  'workspaceId'?: string | null;
  'workspaceLedgerId'?: string | null;
}
export interface o_agent_approval {
  'argumentsHash': string;
  'argumentsSummary'?: string | null;
  'budgetReservedMicros'?: number | null;
  'consumedAt'?: number | null;
  'consumedStepId'?: string | null;
  'createdAt': number;
  'decidedAt'?: number | null;
  'decidedBy'?: number | null;
  'evidenceKind': string;
  'expiresAt': number;
  'id'?: string;
  'impactSummary'?: string | null;
  'policyVersion': string;
  'projectId': number;
  'quote'?: string | null;
  'requestedBy': number;
  'resourceVersions'?: string;
  'revision'?: number;
  'revokedAt'?: number | null;
  'revokedBy'?: number | null;
  'riskClass': string;
  'runId': string;
  'scopeHash': string;
  'status'?: string;
  'stepId'?: string | null;
  'toolId': string;
  'toolVersion': string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_agent_delegation {
  'actorUserId': number;
  'allowedTools'?: string;
  'approvalId'?: string | null;
  'approvalPolicyVersion'?: string | null;
  'approvalScopeHash'?: string | null;
  'boundRunId'?: string | null;
  'canDelegate'?: number;
  'completedAt'?: number | null;
  'consumedActualMicros'?: number;
  'consumedEstimatedMicros'?: number;
  'consumedToolCalls'?: number;
  'expiresAt': number;
  'granteeRole': string;
  'grantVersion'?: number;
  'id'?: string;
  'idempotencyPrefix': string;
  'inputRefs'?: string;
  'issuedAt': number;
  'issuerRole'?: string;
  'limits': string;
  'objectiveHash': string;
  'outputContract': string;
  'parentRunId': string;
  'parentStepId': string;
  'projectId': number;
  'purpose': string;
  'resourceScope'?: string;
  'resultHash'?: string | null;
  'resultJson'?: string | null;
  'resultMessageId'?: string | null;
  'revision'?: number;
  'revokedAt'?: number | null;
  'revokedBy'?: number | null;
  'safeError'?: string | null;
  'sessionId'?: string | null;
  'signature': string;
  'spend': string;
  'startedAt'?: number | null;
  'status'?: string;
  'taskHash'?: string | null;
  'taskJson'?: string | null;
  'taskStatus'?: string | null;
  'taskVersion'?: number | null;
  'updatedAt': number;
  'workspaceId': string;
  'writeTargets'?: string | null;
}
export interface o_agent_delegation_usage {
  'actualMicros'?: number;
  'callOrdinal': number;
  'createdAt': number;
  'estimatedMicros'?: number;
  'grantId': string;
  'id'?: string;
  'idempotencyKey': string;
  'projectId': number;
  'requestHash': string;
  'resourceRefs'?: string;
  'runId': string;
  'toolId': string;
  'workspaceId': string;
}
export interface o_agent_event {
  'createdAt': number;
  'expiresAt'?: number | null;
  'id'?: string;
  'messageId'?: string | null;
  'payload'?: string;
  'projectId': number;
  'runId'?: string | null;
  'seq': number;
  'stepId'?: string | null;
  'threadId': string;
  'type': string;
  'workspaceId': string;
}
export interface o_agent_generation_quote {
  'actorUserId': number;
  'bindingDigest': string;
  'createdAt': number;
  'currency': string;
  'endpointType': string;
  'estimatedCostMicros': number;
  'expiresAt': number;
  'generationType': string;
  'id'?: string;
  'maximumCostMicros': number;
  'model': string;
  'pricingDigest': string;
  'pricingRuleId': string;
  'pricingRuleUpdatedAt': number;
  'pricingSnapshot': string;
  'projectId': number;
  'provider': string;
  'requestDigest': string;
  'runId': string;
  'stepId': string;
  'unit': string;
  'units': number;
  'workspaceId': string;
}
export interface o_agent_generation_review {
  'checksJson': string;
  'createdAt': number;
  'engine': string;
  'generationType': string;
  'id'?: string;
  'needsHumanAttention'?: number;
  'projectId': number;
  'quoteId'?: string | null;
  'runId': string;
  'stepId': string;
  'subjectJson': string;
  'toolId': string;
  'verdict': string;
  'workspaceId': string;
}
export interface o_agent_idempotency {
  'actorUserId': number;
  'createdAt': number;
  'expiresAt': number;
  'id'?: string;
  'idempotencyKey': string;
  'requestHash': string;
  'resourceId'?: string | null;
  'resourceType'?: string | null;
  'responseBody'?: string | null;
  'responseStatus'?: number | null;
  'scopeKey': string;
  'status'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_agent_message {
  'agentRole'?: string | null;
  'clientMessageId'?: string | null;
  'completedAt'?: number | null;
  'content'?: string;
  'createdAt': number;
  'createdBy'?: number | null;
  'error'?: string | null;
  'id'?: string;
  'metadata'?: string;
  'projectId': number;
  'referenceRefs'?: string;
  'replyToId'?: string | null;
  'role': string;
  'runId'?: string | null;
  'seq': number;
  'status'?: string;
  'threadId': string;
  'updatedAt': number;
  'visibility'?: string;
  'workspaceId': string;
}
export interface o_agent_review_report {
  'canonicalHash': string;
  'createdAt': number;
  'id'?: string;
  'projectId': number;
  'reportJson': string;
  'reportVersion': number;
  'reviewerRunId': string;
  'reviewerStepId': string;
  'subjectId': string;
  'subjectType': string;
  'subjectVersion': string;
  'workspaceId': string;
}
export interface o_agent_role_config {
  'enabled'?: boolean;
  'maxOutputTokens': number;
  'modelAliasOverride'?: string | null;
  'modelProfileKey': string;
  'modelProfileVersion': string;
  'promptKey': string;
  'promptVersion': string;
  'revision'?: number;
  'role'?: string;
  'skillRefs'?: string;
  'temperatureMilli': number;
  'updatedAt': number;
  'updatedBy': number;
}
export interface o_agent_run {
  'actualSpendMicros'?: number;
  'agentRole': string;
  'attempt'?: number;
  'blockedByRunId'?: string | null;
  'cancelReason'?: string | null;
  'cancelRequestedAt'?: number | null;
  'cancelRequestedBy'?: number | null;
  'checkpointStepSeq'?: number;
  'completedAt'?: number | null;
  'contextVersion'?: number;
  'createdAt': number;
  'delegationId'?: string | null;
  'error'?: string | null;
  'heartbeatAt'?: number | null;
  'id'?: string;
  'kind': string;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'maxAttempts'?: number;
  'parentRunId'?: string | null;
  'policySnapshot'?: string;
  'projectId': number;
  'recoveryCount'?: number;
  'responseMessageId'?: string | null;
  'rootRunId': string;
  'sideEffectsCommitted'?: number;
  'spendLimitMicros'?: number;
  'startedAt'?: number | null;
  'status'?: string;
  'threadId': string;
  'triggerMessageId': string;
  'updatedAt': number;
  'version'?: number;
  'waitRef'?: string | null;
  'waitType'?: string | null;
  'wakeAt'?: number | null;
  'workspaceId': string;
}
export interface o_agent_step {
  'agentRole': string;
  'argumentsDigest'?: string | null;
  'completedAt'?: number | null;
  'costMicros'?: number;
  'createdAt': number;
  'errorCategory'?: string | null;
  'id'?: string;
  'idempotencyKey'?: string | null;
  'inputRefs'?: string;
  'kind': string;
  'outputRefs'?: string;
  'parentStepId'?: string | null;
  'projectId': number;
  'provider'?: string | null;
  'resolvedModel'?: string | null;
  'runId': string;
  'safeError'?: string | null;
  'seq': number;
  'startedAt'?: number | null;
  'status'?: string;
  'threadId': string;
  'toolName'?: string | null;
  'updatedAt': number;
  'usage'?: string;
  'workspaceId': string;
}
export interface o_agent_thread {
  'activeRootRunId'?: string | null;
  'archivedAt'?: number | null;
  'createdAt': number;
  'createdBy': number;
  'eventSeq'?: number;
  'id'?: string;
  'lastMessageAt'?: number | null;
  'messageSeq'?: number;
  'metadata'?: string;
  'projectId': number;
  'sessionId'?: string | null;
  'status'?: string;
  'title'?: string;
  'updatedAt': number;
  'version'?: number;
  'workspaceId': string;
}
export interface o_agentDeploy {
  'desc'?: string | null;
  'disabled'?: boolean | null;
  'id'?: number;
  'key'?: string | null;
  'maxOutputTokens'?: number | null;
  'model'?: string | null;
  'modelName'?: string | null;
  'name'?: string | null;
  'temperature'?: number | null;
  'type'?: string | null;
  'vendorId'?: string | null;
}
export interface o_agentWorkData {
  'createTime'?: number | null;
  'data'?: string | null;
  'episodesId'?: number | null;
  'id'?: number;
  'key'?: string | null;
  'projectId'?: number | null;
  'updateTime'?: number | null;
}
export interface o_api_key {
  'createTime': number;
  'disabled'?: number;
  'expiresAt'?: number | null;
  'id'?: string;
  'ipAllowlist'?: string | null;
  'keyHash': string;
  'keyPrefix': string;
  'lastUsedAt'?: number | null;
  'modelAllowlist'?: string | null;
  'name': string;
  'ownerUserId'?: number | null;
  'permissions'?: string;
  'quotaLimit'?: number | null;
  'quotaReserved'?: number;
  'quotaUnit'?: string;
  'quotaUsed'?: number;
  'rateLimitPerMinute'?: number | null;
  'revokedAt'?: number | null;
  'scope'?: string;
  'updateTime': number;
  'workspaceId'?: string | null;
}
export interface o_api_key_quota_reservation {
  'apiKeyId': string;
  'createTime': number;
  'expiresAt': number;
  'id'?: string;
  'requestId': string;
  'responseStatus'?: number | null;
  'status'?: string;
  'units'?: number;
  'updateTime': number;
}
export interface o_api_key_rate_limit {
  'apiKeyId'?: string;
  'count'?: number;
  'createTime': number;
  'updateTime': number;
  'windowStart'?: number;
}
export interface o_artStyle {
  'fileUrl'?: string | null;
  'id'?: number;
  'label'?: string | null;
  'name'?: string | null;
  'prompt'?: string | null;
}
export interface o_asset_file_folder {
  'createdAt': number;
  'createdBy': number;
  'id'?: string | null;
  'name': string;
  'parentId'?: string | null;
  'projectId': number;
  'revision'?: number;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_asset_file_metadata {
  'assetId'?: number | null;
  'revision'?: number;
  'tags'?: string;
  'trashedAt'?: number | null;
  'trashedBy'?: number | null;
  'updatedAt': number;
}
export interface o_asset_file_placement {
  'folderId': string;
  'refId'?: string | null;
  'revision'?: number;
  'updatedAt': number;
}
export interface o_asset_grant {
  'activeKey'?: string | null;
  'assetId': number;
  'canManage'?: boolean;
  'canUse'?: boolean;
  'canView'?: boolean;
  'createdAt': number;
  'createdBy': number;
  'granteeType': string;
  'granteeUserId'?: number | null;
  'id'?: string;
  'revision'?: number;
  'revokedAt'?: number | null;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_asset_library_audit {
  'action': string;
  'actorUserId': number;
  'assetId': number;
  'createdAt': number;
  'detailsHash': string;
  'detailsJson'?: string;
  'id'?: string;
  'idempotencyKey': string;
  'workspaceId': string;
}
export interface o_asset_ownership {
  'assetId'?: number;
  'createdAt': number;
  'createdBy': number;
  'ownerType': string;
  'ownerUserId'?: number | null;
  'ownerWorkspaceId'?: string | null;
  'revision'?: number;
  'sourceWorkspaceId': string;
  'updatedAt': number;
}
export interface o_assets {
  'assetsId'?: number | null;
  'audioBindState'?: number | null;
  'deletionFinalizeFence'?: number | null;
  'deletionOperationId'?: string | null;
  'deletionRequestedAt'?: number | null;
  'deletionState'?: string;
  'describe'?: string | null;
  'flowId'?: number | null;
  'id'?: number;
  'imageId'?: number | null;
  'name'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'promptErrorReason'?: string | null;
  'promptState'?: string | null;
  'remark'?: string | null;
  'scriptId'?: number | null;
  'startTime'?: number | null;
  'type'?: string | null;
}
export interface o_assets2Storyboard {
  'assetId'?: number;
  'sortOrder'?: number;
  'storyboardId'?: number;
}
export interface o_assetsRole2Audio {
  'assetsAudioId'?: number;
  'assetsRoleId'?: number;
}
export interface o_audit_log {
  'action': string;
  'actorRole'?: string | null;
  'actorUserId'?: number | null;
  'createdAt': number;
  'id'?: string;
  'ip'?: string | null;
  'metadata'?: string;
  'resourceId'?: string | null;
  'resourceType': string;
  'userAgent'?: string | null;
  'workspaceId'?: string | null;
}
export interface o_auth_login_state {
  'failedCount'?: number;
  'identityHash'?: string;
  'lastFailedAt'?: number | null;
  'lockedUntil'?: number | null;
  'updatedAt': number;
  'userId'?: number | null;
  'windowStartedAt': number;
}
export interface o_auth_token {
  'createdAt': number;
  'expiresAt': number;
  'id'?: string;
  'metadata'?: string | null;
  'revokedAt'?: number | null;
  'tokenHash': string;
  'type': string;
  'usedAt'?: number | null;
  'userId'?: number | null;
  'workspaceId'?: string | null;
}
export interface o_billing_account {
  'balanceMicros'?: number;
  'billingMode'?: string;
  'createdAt': number;
  'creditLimitMicros'?: number;
  'currency'?: string;
  'id'?: string;
  'planId'?: string | null;
  'reservedMicros'?: number;
  'status'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_billing_audit_log {
  'action': string;
  'actorRole': string;
  'actorUserId': number;
  'authMethod': string;
  'authorizationRevision': number;
  'createdAt': number;
  'evidenceId'?: string | null;
  'id'?: string;
  'idempotencyKey': string;
  'metadata': string;
  'newState': string;
  'previousState'?: string | null;
  'proofRecordId': string;
  'requestFingerprint': string;
  'requestId': string;
  'resourceFingerprint': string;
  'scope': string;
  'workspaceId': string;
}
export interface o_billing_finance_intent {
  'commandHash': string;
  'committedAt': number;
  'createdAt': number;
  'durableAuditIntentId': string;
  'errorMessage'?: string | null;
  'financeResult'?: string | null;
  'id'?: string;
  'idempotencyKey': string;
  'lockedRevision': number;
  'operation': string;
  'outboxIds': string;
  'payloadHash': string;
  'payloadHashVersion': string;
  'requestId': string;
  'requestType': string;
  'status': string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_billing_finance_worker {
  'bindingVersion': string;
  'expiresAt': number;
  'id'?: string;
  'revokedAt'?: number | null;
  'status': string;
  'workerId': string;
}
export interface o_billing_ledger {
  'accountId': string;
  'amountMicros'?: number;
  'apiKeyId'?: string | null;
  'balanceAfter'?: number;
  'balanceBefore'?: number;
  'createdAt': number;
  'createdBy'?: number | null;
  'currency'?: string;
  'description'?: string | null;
  'direction': string;
  'id'?: string;
  'idempotencyKey'?: string | null;
  'metadata'?: string;
  'relatedLedgerId'?: string | null;
  'relatedTaskId'?: string | null;
  'relatedUsageId'?: string | null;
  'remainingMicros'?: number;
  'requestId'?: string | null;
  'reservedAfter'?: number;
  'reservedBefore'?: number;
  'status'?: string;
  'taskId'?: string | null;
  'type': string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_billing_outbox {
  'aggregateId': string;
  'aggregateType': string;
  'attempts': number;
  'availableAt': number;
  'createdAt': number;
  'eventType': string;
  'id'?: string;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'payload': string;
  'status': string;
  'updatedAt': number;
}
export interface o_billing_plan {
  'apiQuota'?: number | null;
  'code': string;
  'createdAt': number;
  'currency'?: string;
  'id'?: string;
  'includedCreditsMicros'?: number;
  'keyLimit'?: number | null;
  'memberLimit'?: number | null;
  'metadata'?: string;
  'monthlyFeeMicros'?: number;
  'name': string;
  'status'?: string;
  'updatedAt': number;
}
export interface o_billing_reconcile_job {
  'attempts'?: number;
  'channelId'?: string | null;
  'createTime': number;
  'decision'?: string | null;
  'dedupeKey': string;
  'endpointType'?: string | null;
  'evidence'?: string;
  'id'?: string;
  'lastError'?: string | null;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'nextAttemptAt': number;
  'provider'?: string | null;
  'reason': string;
  'requestId'?: string | null;
  'reservationId': string;
  'resolvedAt'?: number | null;
  'status'?: string;
  'updateTime': number;
  'usageRecordId'?: string | null;
  'workspaceId': string;
}
export interface o_billing_service_request {
  'amountMicros'?: number;
  'compatibilityStatus'?: string | null;
  'contactEmail'?: string | null;
  'contactName'?: string | null;
  'contactPhone'?: string | null;
  'contractVersion'?: string | null;
  'createdAt': number;
  'currency'?: string;
  'decision'?: string | null;
  'financeResult'?: string | null;
  'financeState'?: string | null;
  'id'?: string;
  'note'?: string | null;
  'payload'?: string | null;
  'reviewedAt'?: number | null;
  'reviewedByUserId'?: number | null;
  'reviewEvidenceId'?: string | null;
  'reviewNote'?: string | null;
  'revision'?: number | null;
  'sellerTenantId'?: string;
  'status'?: string;
  'subjectName'?: string | null;
  'submissionEvidenceId'?: string | null;
  'submissionIdempotencyKey'?: string | null;
  'submissionPayloadHash'?: string | null;
  'submittedByUserId'?: number | null;
  'taxId'?: string | null;
  'type': string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_billing_service_request_command {
  'commandHash': string;
  'createdAt': number;
  'id'?: string;
  'idempotencyKey': string;
  'operation': string;
  'outcome': string;
  'outcomeRevision': number;
  'proofRecordId': string;
  'requestId': string;
  'workspaceId': string;
}
export interface o_billing_watchdog_lease {
  'acquiredAt': number;
  'credentialRecordId': string;
  'expiresAt': number;
  'id'?: string;
  'requestId': string;
  'revision': number;
  'updatedAt': number;
  'workerId': string;
}
export interface o_cache_storage_accrual {
  'apiKeyId'?: string | null;
  'billedMicros'?: number;
  'billedThroughAt': number;
  'cacheWriteTokens': number;
  'channelId': string;
  'chargeCount'?: number;
  'closedAt'?: number | null;
  'contractVersion': string;
  'createdAt': number;
  'expiresAt': number;
  'fence'?: number;
  'id'?: string;
  'lastChargeLedgerId'?: string | null;
  'lastChargeUsageRecordId'?: string | null;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'manualReason'?: string | null;
  'model': string;
  'nextBillAt': number;
  'priceMicrosPerMTokenHour': number;
  'pricingRuleId': string;
  'processingDeltaMicros'?: number | null;
  'processingIdempotencyKey'?: string | null;
  'processingThroughAt'?: number | null;
  'processingTotalMicros'?: number | null;
  'provider': string;
  'reconcileJobId'?: string | null;
  'requestId'?: string | null;
  'sourceReservationId': string;
  'sourceUsageRecordId': string;
  'startedAt': number;
  'status'?: string;
  'ttlSeconds': number;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_canvas_asset {
  'assetType'?: string;
  'coverStorageKey'?: string | null;
  'coverUrl'?: string;
  'createdAt': number;
  'createdBy': number;
  'id'?: string;
  'name': string;
  'projectId': number;
  'referenceAssetUri'?: string | null;
  'saveLocation'?: string;
  'saveStorageKey'?: string | null;
  'snapshot'?: string;
  'tag'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_canvas_command_mutation {
  'actorUserId': number;
  'afterSnapshot': string;
  'baseRevision': number;
  'baseVersion': string;
  'beforeSnapshot': string;
  'canvasId': number;
  'commandSetJson': string;
  'createdAt': number;
  'id'?: string;
  'idempotencyKey': string;
  'newRevision': number;
  'newVersion': string;
  'projectId': number;
  'requestHash': string;
  'resultJson': string;
  'workspaceId': string;
}
export interface o_canvas_share {
  'canvasId': number;
  'createdAt': number;
  'createdBy': number;
  'expiresAt'?: number | null;
  'id'?: string;
  'idempotencyKey': string;
  'projectId': number;
  'revision'?: number;
  'revokedAt'?: number | null;
  'slug': string;
  'snapshotHash': string;
  'snapshotJson': string;
  'snapshotRevision': number;
  'status'?: string;
  'title': string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_canvas_workflow_template {
  'coverNodeId'?: string | null;
  'coverUrl'?: string;
  'createdAt': number;
  'createdBy': number;
  'groupSnapshot': string;
  'id'?: string;
  'name': string;
  'note'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_commercial_consumption_allocation {
  'capturedAt': number;
  'chargedGuMicros': number;
  'collectorTenantId'?: string | null;
  'createdAt': number;
  'creditLotId'?: string | null;
  'id'?: string;
  'idempotencyKey': string;
  'ledgerId'?: string | null;
  'ownerTenantIdSnapshot': string;
  'pricingRuleId'?: string | null;
  'pricingRuleRevision'?: number | null;
  'registeredTenantIdSnapshot': string;
  'requestId'?: string | null;
  'retailPortionMicros'?: number;
  'settlementMode': string;
  'sourceId'?: string | null;
  'sourceType'?: string | null;
  'spendSource': string;
  'taskId'?: string | null;
  'usageId'?: string | null;
  'userId': number;
  'wholesaleAccrualMicros'?: number;
  'wholesaleRatePpm'?: number;
  'workspaceId'?: string | null;
}
export interface o_commercial_credit_lot {
  'accountWalletLedgerId': string;
  'amountMicros'?: number;
  'collectorTenantId'?: string | null;
  'createdAt': number;
  'currency'?: string;
  'id'?: string;
  'idempotencyKey': string;
  'metadata'?: string;
  'remainingMicros'?: number;
  'reservedMicros'?: number;
  'retailAmountMicros'?: number;
  'sellerTenantId': string;
  'sourceId'?: string | null;
  'sourceType': string;
  'status'?: string;
  'updatedAt': number;
  'userId': number;
  'wholesaleAmountMicros'?: number;
  'wholesaleRatePpm'?: number;
}
export interface o_commercial_tenant {
  'configRevision'?: number;
  'configurationSource'?: string;
  'createdAt': number;
  'createdByUserId'?: number | null;
  'defaultDomainId'?: string | null;
  'deletedAt'?: number | null;
  'id'?: string;
  'legalProfile'?: string;
  'name': string;
  'operatorName': string;
  'rechargeEnabled'?: boolean;
  'settlementRequired'?: boolean;
  'status'?: string;
  'updatedAt': number;
  'updatedByUserId'?: number | null;
  'wholesaleRatePpm'?: number;
}
export interface o_creation_session {
  'archivedAt'?: number | null;
  'canvasId'?: string | null;
  'createdAt': number;
  'createdBy': number;
  'goal'?: string;
  'id'?: string;
  'inputs'?: string;
  'mode'?: string;
  'parameters'?: string;
  'projectId': number;
  'selectedAssetVersionIds'?: string;
  'status'?: string;
  'updatedAt': number;
  'version'?: number;
  'workspaceId': string;
}
export interface o_creation_session_mutation {
  'actorUserId': number;
  'afterSnapshot': string;
  'baseVersion': number;
  'beforeSnapshot': string;
  'changedFields'?: string;
  'createdAt': number;
  'mutationId'?: string;
  'newVersion': number;
  'operation': string;
  'projectId': number;
  'runId': string;
  'sessionId': string;
  'stepId': string;
  'undoneByMutationId'?: string | null;
  'undoOfMutationId'?: string | null;
  'workspaceId': string;
}
export interface o_deletion_audit_chunk {
  'chainHash': string;
  'chunkHash': string;
  'createdAt': number;
  'epoch'?: number;
  'inputAuditCursorHash': string;
  'inputAuditCursorJson': string;
  'inputCursorHash': string;
  'operationId'?: string;
  'ordinal'?: number;
  'outputAuditCursorHash': string;
  'outputAuditCursorJson': string;
  'outputCursorHash': string;
  'previousChainHash': string;
  'rowCount': number;
  'rowsHash': string;
  'tableName': string;
  'tableOrdinal'?: number;
}
export interface o_deletion_manifest_chunk {
  'bucket': string;
  'chainHash': string;
  'chunkHash': string;
  'contentHash': string;
  'createdAt': number;
  'epoch'?: number;
  'inputCursorHash': string;
  'inputKeyMarker'?: string | null;
  'inputVersionIdMarker'?: string | null;
  'itemCount': number;
  'objectPrefix': string;
  'operationId'?: string;
  'ordinal'?: number;
  'outputCursorHash': string;
  'outputKeyMarker'?: string | null;
  'outputVersionIdMarker'?: string | null;
  'phase': string;
  'previousChainHash': string;
  'providerFingerprint': string;
  'providerId': string;
}
export interface o_deletion_operation {
  'auditSnapshot'?: string | null;
  'auditSnapshotHash'?: string | null;
  'coordinatorFence'?: number;
  'coordinatorLeaseExpiresAt'?: number | null;
  'coordinatorLeaseOwner'?: string | null;
  'createdAt': number;
  'errorCode'?: string | null;
  'expectedItemCount'?: number | null;
  'finalizedAt'?: number | null;
  'id'?: string;
  'kind': string;
  'manifestHash'?: string | null;
  'manifestRevision'?: number;
  'nextAttemptAt': number;
  'operationKey': string;
  'projectId': number;
  'requestedAt': number;
  'requestedBy': number;
  'requestHash': string;
  'resourceId': string;
  'retryCount'?: number;
  'status'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_deletion_operation_checkpoint {
  'auditChainHash': string;
  'auditCursorHash'?: string | null;
  'auditCursorJson'?: string | null;
  'auditRowCount': number;
  'auditTableName'?: string | null;
  'auditTableOrdinal': number;
  'bucket': string;
  'createdAt': number;
  'cursorHash': string;
  'epoch': number;
  'keyMarker'?: string | null;
  'leaseFence': number;
  'leaseOwner': string;
  'manifestChainHash': string;
  'manifestItemCount': number;
  'nextAuditChunkOrdinal': number;
  'nextManifestChunkOrdinal': number;
  'objectPrefix': string;
  'operationId'?: string;
  'phase': string;
  'providerFingerprint': string;
  'providerId': string;
  'updatedAt': number;
  'versionIdMarker'?: string | null;
}
export interface o_deletion_outbox {
  'bucket': string;
  'completedAt'?: number | null;
  'conditionalToken': string;
  'createdAt': number;
  'dedupeKey': string;
  'deleteType': string;
  'dispatchIdempotencyKey'?: string | null;
  'dispatchMarkedAt'?: number | null;
  'dispatchProviderId'?: string | null;
  'dispatchTargetFingerprint'?: string | null;
  'errorCode'?: string | null;
  'id'?: string;
  'leaseExpiresAt'?: number | null;
  'leaseFence': number;
  'leaseOwner'?: string | null;
  'maxRetries': number;
  'nextAttemptAt': number;
  'objectKey': string;
  'operationId': string;
  'payloadHash': string;
  'providerDispatchAt'?: number | null;
  'providerReceiptAt'?: number | null;
  'providerReceiptCode'?: string | null;
  'providerReceiptOutcome'?: string | null;
  'providerRequestId'?: string | null;
  'reconcileExpiresAt'?: number | null;
  'reconcileFence'?: number;
  'reconcileOwner'?: string | null;
  'reconcileRetryCount'?: number;
  'resourceId': string;
  'resourceType': string;
  'retryCount': number;
  'status': string;
  'targetGeneration': string;
  'updatedAt': number;
}
export interface o_deletion_resource_alias {
  'createdAt': number;
  'operationId': string;
  'projectId': number;
  'resourceId'?: string;
  'resourceType'?: string;
  'workspaceId': string;
}
export interface o_domain_verification {
  'attemptCount'?: number;
  'createdAt': number;
  'domainId': string;
  'expiresAt': number;
  'id'?: string;
  'lastAttemptAt'?: number | null;
  'method'?: string;
  'recordName': string;
  'recordType'?: string;
  'state'?: string;
  'tokenHash': string;
  'updatedAt': number;
  'valueHint': string;
  'verifiedDnsAnswers'?: string;
}
export interface o_event {
  'createTime'?: number | null;
  'detail'?: string | null;
  'id'?: number;
  'name'?: string | null;
}
export interface o_eventChapter {
  'eventId'?: number | null;
  'id'?: number;
  'novelId'?: number | null;
}
export interface o_external_tool_operation {
  'claimedBy'?: string | null;
  'createdAt': number;
  'errorCode'?: string | null;
  'expiresAt'?: number | null;
  'id'?: string | null;
  'idempotencyKey': string;
  'keyId': string;
  'kind': string;
  'projectId'?: number | null;
  'relayTaskId'?: string | null;
  'requestHash': string;
  'requestJson': string;
  'resultJson'?: string | null;
  'status': string;
  'updatedAt': number;
  'uploadId'?: string | null;
  'userId': number;
  'workspaceId': string;
}
export interface o_external_tool_upload {
  'createdAt': number;
  'id'?: string | null;
  'keyId': string;
  'projectId': number;
  'resumeGrant': string;
  'userId': number;
  'workspaceId': string;
}
export interface o_finance_income_record {
  'amountMicros'?: number;
  'channel': string;
  'channelName'?: string | null;
  'confirmedAt'?: number | null;
  'createdAt': number;
  'currency'?: string;
  'description'?: string | null;
  'id'?: string;
  'idempotencyKey'?: string | null;
  'ledgerId'?: string | null;
  'metadata'?: string;
  'method'?: string | null;
  'operatorUserId'?: number | null;
  'payerName'?: string | null;
  'paymentTime'?: number | null;
  'serviceRequestId'?: string | null;
  'status'?: string;
  'subjectName'?: string | null;
  'tradeNo'?: string | null;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_fjtv_publication {
  'canvasId': number;
  'coverUrl'?: string | null;
  'createdAt': number;
  'description'?: string;
  'id'?: string;
  'idempotencyKey': string;
  'moderatedAt'?: number | null;
  'moderatedBy'?: number | null;
  'moderationReason'?: string | null;
  'projectId': number;
  'publishedAt'?: number | null;
  'revision'?: number;
  'slug': string;
  'snapshotHash': string;
  'snapshotJson': string;
  'snapshotRevision': number;
  'status'?: string;
  'submittedBy': number;
  'title': string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_generation_history_visibility {
  'hiddenAt': number;
  'mediaId'?: string;
  'userId'?: number;
  'workspaceId'?: string;
}
export interface o_image {
  'assetsId'?: number | null;
  'deletionFinalizeFence'?: number | null;
  'deletionOperationId'?: string | null;
  'deletionRequestedAt'?: number | null;
  'deletionState'?: string;
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'resolution'?: string | null;
  'state'?: string | null;
  'storageKey'?: string | null;
  'type'?: string | null;
}
export interface o_imageFlow {
  'flowData': string;
  'id'?: number;
}
export interface o_ingress_cluster {
  'createdAt': number;
  'credentialRef'?: string | null;
  'defaultServerGroupId'?: string | null;
  'edition'?: string | null;
  'environment'?: string;
  'httpListenerId'?: string | null;
  'httpsListenerId'?: string | null;
  'id'?: string;
  'loadBalancerId'?: string | null;
  'metadata'?: string;
  'name': string;
  'networkType'?: string | null;
  'provider'?: string;
  'region'?: string;
  'sniQuota'?: number;
  'sniUsed'?: number;
  'status'?: string;
  'updatedAt': number;
}
export interface o_invitation_record {
  'createTime'?: number | null;
  'id'?: string | null;
  'invitationCode': string;
  'inviteeRewardMicros'?: number | null;
  'inviteeUserId': number;
  'inviterRewardMicros'?: number | null;
  'inviterUserId': number;
  'status'?: string | null;
}
export interface o_media_asset {
  'assetType': string;
  'createTime': number;
  'deletionFinalizeFence'?: number | null;
  'deletionOperationId'?: string | null;
  'deletionRequestedAt'?: number | null;
  'deletionState'?: string;
  'durationMs'?: number | null;
  'height'?: number | null;
  'id'?: string;
  'localPath'?: string | null;
  'metadata'?: string;
  'mimeType'?: string | null;
  'projectId'?: number | null;
  'source'?: string;
  'storageKey'?: string | null;
  'taskId': string;
  'url'?: string | null;
  'width'?: number | null;
  'workspaceId'?: string | null;
}
export interface o_media_service {
  'baseUrl'?: string | null;
  'concurrencyLimit'?: number | null;
  'configJson'?: string;
  'createTime': number;
  'credentialCiphertext'?: string | null;
  'credentialRef'?: string | null;
  'disabled'?: number;
  'endpointType': string;
  'healthMessage'?: string | null;
  'healthStatus'?: string | null;
  'id'?: string | null;
  'kind': string;
  'lastHealthCheckAt'?: number | null;
  'legacyChannelId'?: string | null;
  'modelNames'?: string;
  'name': string;
  'priority'?: number;
  'provider'?: string;
  'scope'?: string;
  'timeoutMs'?: number;
  'updateTime': number;
  'weight'?: number;
  'workspaceId'?: string | null;
}
export interface o_membership_control {
  'authorizationEnabled'?: boolean;
  'fundingRules'?: string;
  'salesEnabled'?: boolean;
  'tenantId'?: string | null;
  'updatedAt': number;
  'version': string;
}
export interface o_membership_period {
  'dueAt': number;
  'grantedAt'?: number | null;
  'grantIds'?: string;
  'id'?: string | null;
  'lastError'?: string | null;
  'periodIndex': number;
  'status'?: string;
  'subscriptionId': string;
  'updatedAt': number;
}
export interface o_membership_product {
  'configuration': string;
  'enabled'?: boolean;
  'id'?: string | null;
  'updatedAt': number;
  'version': string;
}
export interface o_membership_subscription {
  'createdAt': number;
  'endsAt': number;
  'id'?: string | null;
  'ownerUserId': number;
  'payerUserId': number;
  'paymentOrderId': string;
  'planId': string;
  'quote': string;
  'startsAt': number;
  'status'?: string;
  'tenantId': string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_model_route {
  'channelId'?: string | null;
  'createTime': number;
  'disabled'?: number;
  'displayName'?: string | null;
  'endpointType': string;
  'fallbackOrder'?: number;
  'id'?: string;
  'model': string;
  'name': string;
  'priority'?: number;
  'provider'?: string | null;
  'routeConfig'?: string;
  'scope'?: string;
  'updateTime': number;
  'workspaceId'?: string | null;
}
export interface o_model_route_certification {
  'batchId': string;
  'billingCurrency': string;
  'billingDimension': string;
  'certifiedAt': number;
  'certifiedByUserId': number;
  'createdAt': number;
  'id'?: string;
  'operationKey': string;
  'priceCheckedAt': number;
  'priceSourceDigest': string;
  'priceSourceUrl': string;
  'pricingRuleId': string;
  'pricingSnapshotHash': string;
  'releaseId'?: string | null;
  'revokedAt'?: number | null;
  'revokedByUserId'?: number | null;
  'revokeReason'?: string | null;
  'routeId': string;
  'routeSnapshotHash': string;
  'sourceCommit'?: string | null;
  'taskEvidenceId': string;
  'updatedAt': number;
  'upstreamCurrency': string;
  'upstreamUnitPriceMicros': number;
  'usageEvidenceId': string;
  'validUntil': number;
}
export interface o_model_route_certification_batch {
  'actorUserId': number;
  'appliedAt': number;
  'batchDigest': string;
  'batchId'?: string;
  'createdAt': number;
  'entryCount': number;
  'releaseId': string;
  'sourceCommit': string;
}
export interface o_modelPrompt {
  'fileName'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'path'?: string | null;
  'vendorId'?: string | null;
}
export interface o_novel {
  'chapter'?: string | null;
  'chapterData'?: string | null;
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'errorReason'?: string | null;
  'event'?: string | null;
  'eventState'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'reel'?: string | null;
}
export interface o_object_write_absence_reconciliation {
  'afterRowsJson': string;
  'authorizationJson': string;
  'beforeRowsJson': string;
  'completedAt': number;
  'evidenceJson': string;
  'operationId'?: string | null;
  'planJson': string;
  'receiptJson': string;
  'receiptSha256': string;
  'requestSha256': string;
}
export interface o_object_write_intent {
  'bucket': string;
  'committedAt'?: number | null;
  'compensatedAt'?: number | null;
  'compensationEvidenceHash'?: string | null;
  'compensationEvidenceJson'?: string | null;
  'createdAt': number;
  'endpoint': string;
  'errorCode'?: string | null;
  'expectedSha256': string;
  'expectedSize': number;
  'forcePathStyle': boolean;
  'id'?: string;
  'keyPrefix': string;
  'leaseExpiresAt'?: number | null;
  'leaseFence': number;
  'leaseOwner'?: string | null;
  'maxRetries': number;
  'nextAttemptAt': number;
  'objectKey': string;
  'projectId': number;
  'provider': string;
  'providerFingerprint': string;
  'purpose': string;
  'putCompletedAt'?: number | null;
  'referenceHash'?: string | null;
  'referenceJson'?: string | null;
  'region': string;
  'requestHash': string;
  'retryCount': number;
  'status': string;
  'updatedAt': number;
  'workspaceId': string;
  'writeReceiptHash'?: string | null;
  'writeReceiptJson'?: string | null;
}
export interface o_payment_event {
  'createdAt': number;
  'eventKey': string;
  'eventType': string;
  'id'?: string;
  'metadata'?: string;
  'orderId': string;
  'payloadDigest': string;
  'processedAt'?: number | null;
  'status': string;
}
export interface o_payment_order {
  'amountMicros': number;
  'channelKey': string;
  'clientReturnUrl'?: string | null;
  'collectorTenantId'?: string | null;
  'createdAt': number;
  'creditedGuMicros': number;
  'creditLotId'?: string | null;
  'currency'?: string;
  'description': string;
  'expiresAt': number;
  'id'?: string;
  'idempotencyKey': string;
  'metadata'?: string;
  'outTradeNo': string;
  'ownerTenantIdSnapshot'?: string | null;
  'paidAt'?: number | null;
  'protocol': string;
  'providerOrderId'?: string | null;
  'providerPayloadDigest'?: string | null;
  'refundedAmountMicros'?: number;
  'refundedAt'?: number | null;
  'registeredTenantIdSnapshot'?: string | null;
  'revision'?: number;
  'sellerTenantId': string;
  'status'?: string;
  'updatedAt': number;
  'userId': number;
  'walletLedgerId'?: string | null;
  'workspaceId': string;
}
export interface o_platform_release {
  'archivedAt'?: number | null;
  'archivedByUserId'?: number | null;
  'channel': string;
  'createdAt': number;
  'createdByUserId'?: number | null;
  'id'?: string;
  'publishedAt'?: number | null;
  'publishedByUserId'?: number | null;
  'releaseNotes': string;
  'revision'?: number;
  'status'?: string;
  'summary': string;
  'title': string;
  'updatedAt': number;
  'updatedByUserId'?: number | null;
  'version': string;
}
export interface o_portrait_admission {
  'assetId': number;
  'assetVersionId': number;
  'complianceState'?: string;
  'createdAt': number;
  'currentConsentId'?: string | null;
  'currentImageXReviewJobId'?: string | null;
  'currentManualReviewId'?: string | null;
  'currentProviderAssetBindingId'?: string | null;
  'declarationState'?: string;
  'declarationVersion'?: string | null;
  'declaredAt'?: number | null;
  'declaredByUserId'?: number | null;
  'detectorConfidence'?: number | null;
  'detectorEvidenceHash'?: string | null;
  'detectorEvidenceJson'?: string;
  'detectorName'?: string | null;
  'detectorVersion'?: string | null;
  'faceCount'?: number | null;
  'faceScanCoverage'?: string;
  'faceScanState'?: string;
  'id'?: string;
  'identityId'?: string | null;
  'manualReviewDecision'?: string | null;
  'manualReviewedAt'?: number | null;
  'manualReviewedByUserId'?: number | null;
  'manualReviewEvidenceHash'?: string | null;
  'manualReviewPolicyVersion'?: string | null;
  'manualReviewState'?: string;
  'mediaType': string;
  'moderationEvidenceHash'?: string | null;
  'moderationPolicyVersion'?: string | null;
  'moderationReasonCode'?: string | null;
  'moderationState'?: string;
  'moderationUpdatedAt'?: number | null;
  'preferredProviderChannelId'?: string | null;
  'projectId': number;
  'providerSyncState'?: string;
  'revision'?: number;
  'safeErrorCode'?: string | null;
  'safeErrorMessage'?: string | null;
  'sourceRecoveryAttempts'?: number;
  'sourceRecoveryFailureCode'?: string | null;
  'sourceRecoveryFailureMessage'?: string | null;
  'sourceRecoveryLeaseExpiresAt'?: number | null;
  'sourceRecoveryLeaseOwner'?: string | null;
  'sourceRecoveryNextAttemptAt'?: number;
  'sourceRecoveryObjectIdentityJson'?: string | null;
  'sourceRecoveryState'?: string;
  'sourceSha256'?: string | null;
  'subjectKind'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_portrait_auth_session {
  'admissionId': string;
  'bytedTokenDigest'?: string | null;
  'callbackNonceHash': string;
  'channelId': string;
  'consumedAt'?: number | null;
  'createdAt': number;
  'expiresAt': number;
  'groupBindingId': string;
  'id'?: string;
  'identityId': string;
  'providerSessionId'?: string | null;
  'resultReceivedAt'?: number | null;
  'safeErrorCode'?: string | null;
  'safeErrorMessage'?: string | null;
  'state'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_portrait_consent {
  'actorUserId': number;
  'admissionId': string;
  'consentType': string;
  'createdAt': number;
  'evidenceHash': string;
  'expiresAt'?: number | null;
  'grantedAt': number;
  'id'?: string;
  'identityId'?: string | null;
  'revokedAt'?: number | null;
  'revokeReason'?: string | null;
  'scopeJson': string;
  'status'?: string;
  'termsVersion': string;
  'workspaceId': string;
}
export interface o_portrait_identity {
  'activeConsentId'?: string | null;
  'createdAt': number;
  'id'?: string;
  'kind': string;
  'label': string;
  'ownerUserId': number;
  'revision'?: number;
  'state'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_portrait_imagex_review_job {
  'admissionId': string;
  'assetVersionId': number;
  'channelId': string;
  'completedAt'?: number | null;
  'createdAt': number;
  'credentialGeneration': number;
  'dataId': string;
  'id'?: string;
  'lastPolledAt'?: number | null;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'policyVersion': string;
  'pollMarkerCiphertext'?: string | null;
  'pollMarkerHash'?: string | null;
  'projectId': number;
  'requestEvidenceHash': string;
  'resultEvidenceHash'?: string | null;
  'revision'?: number;
  'safeReasonCode'?: string | null;
  'sourceSha256': string;
  'sourceUrlHash': string;
  'state'?: string;
  'submittedAt'?: number | null;
  'taskIdCiphertext'?: string | null;
  'taskIdHash'?: string | null;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_portrait_manual_review {
  'admissionId': string;
  'admissionRevisionAtCreate': number;
  'assetVersionId': number;
  'attestationHash'?: string | null;
  'claimLeaseExpiresAt'?: number | null;
  'claimOwnerUserId'?: number | null;
  'claimSessionHash'?: string | null;
  'createdAt': number;
  'decision'?: string | null;
  'id'?: string;
  'idempotencyKey': string;
  'policyVersion'?: string | null;
  'projectId': number;
  'releasedAt'?: number | null;
  'reviewedAt'?: number | null;
  'revision'?: number;
  'sampleEvidenceHash': string;
  'sourceSha256': string;
  'state'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_portrait_provider_asset {
  'activeAt'?: number | null;
  'admissionId': string;
  'channelId': string;
  'createdAt': number;
  'groupBindingId': string;
  'id'?: string;
  'idempotencyKey': string;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'nextAttemptAt': number;
  'providerAssetId'?: string | null;
  'providerAssetUri'?: string | null;
  'retryCount'?: number;
  'safeErrorCode'?: string | null;
  'safeErrorMessage'?: string | null;
  'sourceSha256': string;
  'state'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_portrait_provider_group {
  'activeAt'?: number | null;
  'channelId': string;
  'createdAt': number;
  'groupType': string;
  'id'?: string;
  'idempotencyKey': string;
  'identityId': string;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'nextAttemptAt': number;
  'projectName': string;
  'provider': string;
  'providerAccountFingerprint': string;
  'providerGroupId'?: string | null;
  'retryCount'?: number;
  'safeErrorCode'?: string | null;
  'safeErrorMessage'?: string | null;
  'state'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_pricing_group {
  'code': string;
  'createdAt': number;
  'createdByUserId'?: number | null;
  'description'?: string | null;
  'id'?: string;
  'name': string;
  'sortOrder'?: number;
  'status'?: string;
  'updatedAt': number;
  'updatedByUserId'?: number | null;
}
export interface o_pricing_rule {
  'createTime': number;
  'currency'?: string;
  'disabled'?: number;
  'endpointType': string;
  'id'?: string;
  'model'?: string | null;
  'name': string;
  'provider'?: string | null;
  'ruleConfig'?: string;
  'scope'?: string;
  'unit'?: string;
  'unitPriceMicros'?: number;
  'updateTime': number;
  'workspaceId'?: string | null;
}
export interface o_project {
  'agentBudgetMicros'?: number | null;
  'agentBudgetReservedMicros'?: number;
  'artStyle'?: string | null;
  'coverImageUrl'?: string | null;
  'coverStorageKey'?: string | null;
  'createTime'?: number | null;
  'deletionFinalizeFence'?: number | null;
  'deletionOperationId'?: string | null;
  'deletionRequestedAt'?: number | null;
  'deletionState'?: string;
  'directorManual'?: string | null;
  'id'?: number;
  'imageModel'?: string | null;
  'imageQuality'?: string | null;
  'intro'?: string | null;
  'mode'?: string | null;
  'name'?: string | null;
  'projectType'?: string | null;
  'revision'?: number;
  'type'?: string | null;
  'updatedAt'?: number;
  'userId'?: number | null;
  'videoModel'?: string | null;
  'videoRatio'?: string | null;
  'workspaceId'?: string;
}
export interface o_project_asset_ref {
  'activeKey'?: string | null;
  'assetId': number;
  'assetVersionId': string;
  'createdAt': number;
  'createdBy': number;
  'id'?: string;
  'projectId': number;
  'removedAt'?: number | null;
  'revision'?: number;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_project_folder {
  'createdAt': number;
  'createdBy': number;
  'id'?: string;
  'name': string;
  'projectIds'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_project_mutation {
  'actorUserId': number;
  'afterSnapshot': string;
  'baseRevision': number;
  'beforeSnapshot': string;
  'changedFields'?: string;
  'createdAt': number;
  'mutationId'?: string;
  'newRevision': number;
  'operation': string;
  'projectId': number;
  'runId': string;
  'stepId': string;
  'undoneByMutationId'?: string | null;
  'undoOfMutationId'?: string | null;
  'workspaceId': string;
}
export interface o_prompt {
  'data'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'type'?: string | null;
  'useData'?: string | null;
}
export interface o_provider_channel {
  'baseUrl'?: string | null;
  'concurrencyLimit'?: number | null;
  'configJson'?: string;
  'createTime': number;
  'credentialRef'?: string | null;
  'disabled'?: number;
  'endpointType': string;
  'failedCount'?: number;
  'healthStatus'?: string | null;
  'id'?: string;
  'lastHealthCheckAt'?: number | null;
  'lastHealthError'?: string | null;
  'lastHealthLatencyMs'?: number | null;
  'lastHealthPayload'?: string;
  'modelNames'?: string;
  'name': string;
  'priority'?: number;
  'provider': string;
  'scope'?: string;
  'timeoutMs'?: number;
  'updateTime': number;
  'weight'?: number;
  'workspaceId'?: string | null;
}
export interface o_provider_channel_slot {
  'channelId': string;
  'createTime': number;
  'id'?: string;
  'leaseExpiresAt': number;
  'slotIndex': number;
  'updateTime': number;
}
export interface o_provider_cost_ledger {
  'billingPeriod'?: string | null;
  'channel'?: string | null;
  'createdAt': number;
  'currency'?: string;
  'differenceMicros'?: number | null;
  'estimatedCostMicros'?: number;
  'id'?: string;
  'invoiceId'?: string | null;
  'metadata'?: string;
  'model'?: string | null;
  'officialCostMicros'?: number | null;
  'provider': string;
  'providerPriceRevision'?: number | null;
  'requestId'?: string | null;
  'state'?: string;
  'updatedAt': number;
  'usageId'?: string | null;
}
export interface o_redemption_code {
  'amountMicros': number;
  'batchId'?: string | null;
  'batchNote'?: string | null;
  'code': string;
  'createdBy'?: number | null;
  'createTime'?: number | null;
  'currency'?: string | null;
  'expiresAt'?: number | null;
  'id'?: string | null;
  'redeemedAt'?: number | null;
  'redeemedBy'?: number | null;
  'status'?: string | null;
  'updateTime'?: number | null;
}
export interface o_reference_multipart_upload {
  'abortedAt'?: number | null;
  'abortRequestId'?: string | null;
  'actorUserId': number;
  'actualSha256'?: string | null;
  'assetId'?: number | null;
  'assetVersionId'?: number | null;
  'completedAt'?: number | null;
  'completionEtag'?: string | null;
  'completionRequestId'?: string | null;
  'completionVersionId'?: string | null;
  'createdAt': number;
  'declaredByteSize': number;
  'declaredMimeType': string;
  'declaredSha256': string;
  'detectedMimeType'?: string | null;
  'errorCode'?: string | null;
  'expiresAt': number;
  'failedAt'?: number | null;
  'fileName': string;
  'id'?: string;
  'idempotencyKey': string;
  'mediaType': string;
  'partCount': number;
  'partSize': number;
  'probeJson'?: string | null;
  'projectId': number;
  'providerInitiateRequestId': string;
  'requestHash': string;
  'resumeGrantHash': string;
  'revision'?: number;
  'status'?: string;
  'storageBucket': string;
  'storageEndpoint': string;
  'storageForcePathStyle'?: boolean;
  'storageKey': string;
  'storageKeyPrefix'?: string;
  'storageProvider': string;
  'storageRegion': string;
  'updatedAt': number;
  'uploadIdCiphertext': string;
  'workspaceId': string;
}
export interface o_relay_callback_delivery {
  'attempts'?: number;
  'callbackUrl': string;
  'createTime': number;
  'deliveredAt'?: number | null;
  'event'?: string;
  'id'?: string;
  'lastError'?: string | null;
  'lastHttpStatus'?: number | null;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'nextAttemptAt': number;
  'payload': string;
  'payloadHash': string;
  'secretCiphertext'?: string | null;
  'status'?: string;
  'taskId': string;
  'updateTime': number;
}
export interface o_relay_task {
  'apiKeyId'?: string | null;
  'apiQuotaReserved'?: number;
  'attemptCount'?: number;
  'channelId'?: string | null;
  'completedAt'?: number | null;
  'costMicros'?: number;
  'createTime': number;
  'endpointType': string;
  'errorMessage'?: string | null;
  'heartbeatAt'?: number | null;
  'id'?: string;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'model'?: string | null;
  'projectId'?: number | null;
  'provider'?: string | null;
  'providerPayload'?: string;
  'providerTaskId'?: string | null;
  'quotaReserved'?: number;
  'requestId'?: string | null;
  'requestPayload'?: string;
  'resultPayload'?: string;
  'status'?: string;
  'submittedAt'?: number | null;
  'updateTime': number;
  'workspaceId'?: string | null;
}
export interface o_release_artifact {
  'byteSize'?: number | null;
  'createdAt': number;
  'createdByUserId'?: number | null;
  'fileName'?: string | null;
  'format'?: string | null;
  'id'?: string;
  'idempotencyKey': string;
  'manifestJson'?: string;
  'mediaType'?: string | null;
  'rejectionReason'?: string | null;
  'releaseId': string;
  'requestHash': string;
  'revision'?: number;
  'sha256': string;
  'sourceCommit'?: string | null;
  'status'?: string;
  'storageBucket'?: string | null;
  'storageCapturedAt'?: number | null;
  'storageEndpoint'?: string | null;
  'storageEtag'?: string | null;
  'storageForcePathStyle'?: boolean | null;
  'storageKey': string;
  'storageKeyPrefix'?: string | null;
  'storageProvider'?: string | null;
  'storageRegion'?: string | null;
  'storageRequestId'?: string | null;
  'storageVersionId'?: string | null;
  'updatedAt': number;
  'uploadReservationId'?: string | null;
  'verifiedAt'?: number | null;
}
export interface o_release_artifact_multipart_upload {
  'abortedAt'?: number | null;
  'abortRequestId'?: string | null;
  'completedAt'?: number | null;
  'completionEtag'?: string | null;
  'completionRequestId'?: string | null;
  'completionVersionId'?: string | null;
  'createdAt': number;
  'declaredSha256': string;
  'expiredAt'?: number | null;
  'expiresAt': number;
  'id'?: string;
  'operatorSessionHash': string;
  'operatorUserId': number;
  'partCount': number;
  'partSize': number;
  'providerInitiateRequestId': string;
  'releaseId': string;
  'reservationId': string;
  'resumeGrantHash': string;
  'revision'?: number;
  'status'?: string;
  'updatedAt': number;
  'uploadIdCiphertext': string;
}
export interface o_release_artifact_upload_reservation {
  'contentType': string;
  'createdAt': number;
  'declaredByteSize': number;
  'expiresAt': number;
  'fileName': string;
  'finalizedArtifactId'?: string | null;
  'finalizedAt'?: number | null;
  'id'?: string;
  'idempotencyKey': string;
  'operatorUserId': number;
  'releaseId': string;
  'requestHash': string;
  'revision'?: number;
  'status'?: string;
  'storageBucket': string;
  'storageEndpoint': string;
  'storageForcePathStyle': boolean;
  'storageKey': string;
  'storageKeyPrefix': string;
  'storageProvider': string;
  'storageRegion': string;
  'updatedAt': number;
}
export interface o_release_deployment {
  'activeScope'?: string | null;
  'artifactId': string;
  'cancelReason'?: string | null;
  'cancelRequestedAt'?: number | null;
  'cancelRequestedByUserId'?: number | null;
  'checkpointJson'?: string;
  'completedAt'?: number | null;
  'completedTargetCount'?: number;
  'createdAt': number;
  'drainTimeoutMs'?: number;
  'environment'?: string;
  'errorCode'?: string | null;
  'failedTargetCount'?: number;
  'fencingToken'?: number;
  'id'?: string;
  'idempotencyKey': string;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'manualInterventionRequired'?: number;
  'maxUnavailable'?: number;
  'minHealthyTargets'?: number;
  'phase'?: string;
  'planJson'?: string;
  'previousArtifactId'?: string | null;
  'previousReleaseId'?: string | null;
  'readinessTimeoutMs'?: number;
  'releaseId': string;
  'requestedByUserId'?: number | null;
  'requestHash': string;
  'revision'?: number;
  'rollbackOnFailure'?: number;
  'safeError'?: string | null;
  'startedAt'?: number | null;
  'status'?: string;
  'strategy'?: string;
  'succeededTargetCount'?: number;
  'targetCount': number;
  'updatedAt': number;
}
export interface o_release_deployment_event {
  'actor'?: string;
  'actorUserId'?: number | null;
  'createdAt': number;
  'deploymentId': string;
  'eventType': string;
  'id'?: string;
  'level'?: string;
  'message': string;
  'payloadJson'?: string;
  'phase': string;
  'requestId'?: string | null;
  'sequence': number;
  'targetId'?: string | null;
}
export interface o_release_deployment_reconciliation {
  'activeDeploymentId'?: string | null;
  'completedAt'?: number | null;
  'createdAt': number;
  'deploymentId': string;
  'errorCode'?: string | null;
  'evidenceJson'?: string;
  'fencingToken'?: number;
  'id'?: string;
  'idempotencyKey': string;
  'intent': string;
  'leaseExpiresAt'?: number | null;
  'leaseOwner'?: string | null;
  'reason': string;
  'requestedByUserId': number;
  'requestedDeploymentRevision': number;
  'requestHash': string;
  'revision'?: number;
  'safeError'?: string | null;
  'startedAt'?: number | null;
  'status'?: string;
  'updatedAt': number;
}
export interface o_release_deployment_target {
  'attempt'?: number;
  'completedAt'?: number | null;
  'createdAt': number;
  'deploymentId': string;
  'deployStartedAt'?: number | null;
  'drainStartedAt'?: number | null;
  'errorCode'?: string | null;
  'id'?: string;
  'observedArtifactId'?: string | null;
  'observedVersion'?: string | null;
  'ordinal': number;
  'previousArtifactId'?: string | null;
  'previousReleaseId'?: string | null;
  'revision'?: number;
  'role': string;
  'safeError'?: string | null;
  'status'?: string;
  'targetKey': string;
  'targetLabel': string;
  'targetMetadataJson'?: string;
  'updatedAt': number;
  'verifiedAt'?: number | null;
}
export interface o_request_log {
  'actorUserId'?: number | null;
  'apiKeyId'?: string | null;
  'apiKeyPrefix'?: string | null;
  'createdAt': number;
  'durationMs': number;
  'errorCode'?: string | null;
  'id'?: string;
  'ip'?: string | null;
  'metadata'?: string;
  'method': string;
  'model'?: string | null;
  'path': string;
  'relayTaskId'?: string | null;
  'requestId': string;
  'statusCode': number;
  'targetResolution'?: string | null;
  'userAgent'?: string | null;
  'workspaceId'?: string | null;
}
export interface o_responses_resource_binding {
  'apiKeyId'?: string | null;
  'baseUrl': string;
  'channelId': string;
  'createTime': number;
  'credentialRef': string;
  'deletedAt'?: number | null;
  'expiresAt'?: number | null;
  'model': string;
  'principalId'?: string | null;
  'provider': string;
  'responseId'?: string;
  'updateTime': number;
  'upstreamModel': string;
  'workspaceId': string;
}
export interface o_schema_migration {
  'appliedAt': number;
  'checksum': string;
  'name': string;
  'version'?: number;
}
export interface o_schema_migration_lock {
  'id'?: number;
  'touchedAt': number;
}
export interface o_schema_migration_run {
  'afterSchemaFingerprint'?: string | null;
  'backupCheckpointId'?: string | null;
  'beforeSchemaFingerprint'?: string | null;
  'checksumChain': string;
  'durationMs'?: number | null;
  'eventOrdinal': number;
  'evidenceId'?: string;
  'failedVersion'?: number | null;
  'failureCode'?: string | null;
  'finishedAt'?: number | null;
  'fromVersion': number;
  'operatorIdentity': string;
  'runId': string;
  'safeError'?: string | null;
  'sourceCommit': string;
  'startedAt': number;
  'status': string;
  'toVersion': number;
}
export interface o_script {
  'content'?: string | null;
  'createTime'?: number | null;
  'errorReason'?: string | null;
  'extractState'?: number | null;
  'id'?: number;
  'name'?: string | null;
  'projectId'?: number | null;
}
export interface o_scriptAssets {
  'assetId'?: number;
  'scriptId'?: number;
}
export interface o_setting {
  'key'?: string | null;
  'value'?: string | null;
}
export interface o_skillAttribution {
  'attribution'?: string;
  'skillId'?: string;
}
export interface o_skillList {
  'createTime': number;
  'description': string;
  'embedding'?: string | null;
  'id'?: string;
  'md5': string;
  'name': string;
  'path': string;
  'state': number;
  'type': string;
  'updateTime': number;
}
export interface o_storyboard {
  'createTime'?: number | null;
  'duration'?: string | null;
  'filePath'?: string | null;
  'flowId'?: number | null;
  'id'?: number;
  'index'?: number | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'reason'?: string | null;
  'scriptId'?: number | null;
  'shouldGenerateImage'?: number | null;
  'state'?: string | null;
  'storageKey'?: string | null;
  'track'?: string | null;
  'trackId'?: number | null;
  'videoDesc'?: string | null;
}
export interface o_tasks {
  'describe'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'projectId'?: number | null;
  'reason'?: string | null;
  'relatedObjects'?: string | null;
  'startTime'?: number | null;
  'state'?: string | null;
  'taskClass'?: string | null;
}
export interface o_tenant_auth_transfer {
  'codeHash': string;
  'createdAt': number;
  'expiresAt': number;
  'id'?: string;
  'redirectPath'?: string;
  'sourceTenantId': string;
  'targetOrigin': string;
  'targetTenantId': string;
  'usedAt'?: number | null;
  'userId': number;
}
export interface o_tenant_certificate {
  'commonName'?: string | null;
  'createdAt': number;
  'createdByUserId'?: number | null;
  'failureCode'?: string | null;
  'failureMessage'?: string | null;
  'fingerprintSha256'?: string | null;
  'id'?: string;
  'issuer'?: string | null;
  'keyAlgorithm'?: string | null;
  'keySize'?: number | null;
  'lastCheckedAt'?: number | null;
  'metadata'?: string;
  'notAfter'?: number | null;
  'notBefore'?: number | null;
  'provider'?: string | null;
  'providerCertificateId'?: string | null;
  'renewalMode'?: string;
  'replacesCertificateId'?: string | null;
  'sans'?: string;
  'serialNumber'?: string | null;
  'source': string;
  'status'?: string;
  'tenantId': string;
  'updatedAt': number;
  'updatedByUserId'?: number | null;
}
export interface o_tenant_domain {
  'activatedAt'?: number | null;
  'certificateId'?: string | null;
  'createdAt': number;
  'createdByUserId'?: number | null;
  'deletedAt'?: number | null;
  'desiredRevision'?: number;
  'displayHostname'?: string | null;
  'failureCode'?: string | null;
  'failureMessage'?: string | null;
  'hostname': string;
  'icpState'?: string;
  'id'?: string;
  'ingressBindingId'?: string | null;
  'isPrimary'?: boolean;
  'lastVerifiedAt'?: number | null;
  'lifecycleState'?: string;
  'metadata'?: string;
  'nextVerifyAt'?: number | null;
  'observedRevision'?: number;
  'ownershipState'?: string;
  'purpose'?: string;
  'suspendedAt'?: number | null;
  'tenantId': string;
  'updatedAt': number;
  'updatedByUserId'?: number | null;
}
export interface o_tenant_domain_operation {
  'approvedByUserId'?: number | null;
  'attemptCount'?: number;
  'createdAt': number;
  'currentStep'?: string | null;
  'domainId'?: string | null;
  'errorCode'?: string | null;
  'errorMessage'?: string | null;
  'finishedAt'?: number | null;
  'id'?: string;
  'idempotencyKey': string;
  'nextAttemptAt'?: number | null;
  'operationType': string;
  'requestedByUserId'?: number | null;
  'requestedRevision': number;
  'result'?: string | null;
  'startedAt'?: number | null;
  'state'?: string;
  'tenantId': string;
  'updatedAt': number;
}
export interface o_tenant_ingress_binding {
  'certificateId'?: string | null;
  'createdAt': number;
  'desiredState'?: string;
  'domainId': string;
  'id'?: string;
  'ingressClusterId': string;
  'lastReconciledAt'?: number | null;
  'metadata'?: string;
  'observedState'?: string;
  'providerDomainExtensionId'?: string | null;
  'providerRuleId'?: string | null;
  'serverGroupId'?: string | null;
  'updatedAt': number;
}
export interface o_tenant_settlement_account {
  'balanceMicros'?: number;
  'createdAt': number;
  'currency'?: string;
  'metadata'?: string;
  'status'?: string;
  'tenantId'?: string;
  'updatedAt': number;
}
export interface o_tenant_settlement_ledger {
  'amountMicros'?: number;
  'balanceAfterMicros'?: number;
  'balanceBeforeMicros'?: number;
  'createdAt': number;
  'creditLotId'?: string | null;
  'currency'?: string;
  'description'?: string | null;
  'direction': string;
  'id'?: string;
  'idempotencyKey': string;
  'metadata'?: string;
  'operatorUserId'?: number | null;
  'sourceId'?: string | null;
  'sourceType'?: string | null;
  'tenantId': string;
  'type': string;
  'updatedAt': number;
}
export interface o_tenant_settlement_period {
  'closedAt'?: number | null;
  'closedByUserId'?: number | null;
  'createdAt': number;
  'id'?: string;
  'metadata'?: string;
  'periodKey': string;
  'preflightResult'?: string | null;
  'settlementPolicyId'?: string | null;
  'settlementPolicyRevision'?: number | null;
  'status'?: string;
  'updatedAt': number;
}
export interface o_usage_record {
  'apiKeyId'?: string | null;
  'channelId'?: string | null;
  'costMicros'?: number;
  'createTime': number;
  'currency'?: string;
  'endpointType': string;
  'id'?: string;
  'model'?: string | null;
  'provider'?: string | null;
  'status'?: string;
  'taskId'?: string | null;
  'unit'?: string;
  'units'?: number;
  'workspaceId'?: string | null;
}
export interface o_user {
  'authorizationRevision'?: number;
  'createdAt'?: number | null;
  'currentWorkspaceId'?: string | null;
  'defaultWorkspaceId'?: string | null;
  'displayName'?: string | null;
  'email'?: string | null;
  'emailVerifiedAt'?: number | null;
  'id'?: number;
  'invitationCode'?: string | null;
  'lastLoginAt'?: number | null;
  'name'?: string | null;
  'password'?: string | null;
  'passwordChangedAt'?: number | null;
  'role'?: string | null;
  'status'?: string | null;
  'updatedAt'?: number | null;
}
export interface o_user_commercial_profile {
  'accountType'?: string;
  'billingMode'?: string;
  'commercialGroup'?: string;
  'createdAt': number;
  'id'?: string;
  'notes'?: string | null;
  'ownerTenantChangedAt'?: number | null;
  'ownerTenantChangedByUserId'?: number | null;
  'ownerTenantChangeReason'?: string | null;
  'ownerTenantId'?: string | null;
  'ownerTenantRevision'?: number;
  'pricingGroup'?: string | null;
  'rechargeDiscountBps'?: number;
  'registeredTenantId'?: string | null;
  'registrationHostname'?: string | null;
  'registrationSource'?: string | null;
  'settlementType'?: string;
  'updatedAt': number;
  'userId': number;
}
export interface o_user_feedback {
  'appOrigin': string;
  'createdAt': number;
  'description': string;
  'feedbackNo': string;
  'id'?: string | null;
  'lastSyncError'?: string | null;
  'nextSyncAt': number;
  'pageTitle': string;
  'pageUrl': string;
  'processingStartedAt'?: number | null;
  'syncAttempts'?: number;
  'syncedAt'?: number | null;
  'syncStatus'?: string;
  'updatedAt': number;
  'userId': number;
  'userLabel': string;
  'workspaceId': string;
}
export interface o_user_feedback_attachment {
  'createdAt': number;
  'feedbackId': string;
  'fileName': string;
  'id'?: string | null;
  'mimeType': string;
  'sha256': string;
  'sizeBytes': number;
  'storageKey': string;
}
export interface o_user_oauth_identity {
  'avatarUrl'?: string | null;
  'createdAt': number;
  'displayName'?: string | null;
  'id'?: string;
  'openId': string;
  'provider': string;
  'rawProfile'?: string | null;
  'unionId'?: string | null;
  'updatedAt': number;
  'userId': number;
}
export interface o_user_password_history {
  'createdAt': number;
  'id'?: string;
  'passwordHash': string;
  'userId': number;
}
export interface o_user_session {
  'createdAt': number;
  'expiresAt': number;
  'id'?: string;
  'ip'?: string | null;
  'lastSeenAt'?: number | null;
  'revokedAt'?: number | null;
  'tokenHash': string;
  'updatedAt': number;
  'userAgent'?: string | null;
  'userId': number;
  'workspaceId'?: string | null;
}
export interface o_user_tenant_attribution_history {
  'createdAt': number;
  'fromTenantId': string;
  'id'?: string;
  'metadata'?: string;
  'operatorUserId'?: number | null;
  'reason': string;
  'revision': number;
  'toTenantId': string;
  'userId': number;
}
export interface o_user_video_enhance_task {
  'billingReconciliationError'?: string | null;
  'billingReconciliationEvidenceJson'?: string;
  'billingReconciliationState'?: string;
  'billingReconciliationUpdatedAt'?: number;
  'createdAt': number;
  'durationSeconds'?: number;
  'enhanceChannelId'?: string | null;
  'errorMessage'?: string | null;
  'finalizationFence'?: number;
  'finalizationLeaseExpiresAt'?: number | null;
  'finalizationLeaseOwner'?: string | null;
  'id'?: string;
  'idempotencyKey'?: string | null;
  'kind'?: string;
  'projectId'?: number | null;
  'provider'?: string | null;
  'providerTaskId'?: string | null;
  'quoteJson'?: string;
  'requestId'?: string | null;
  'reservationId'?: string | null;
  'resultAssetId'?: string | null;
  'resultUrl'?: string | null;
  'sourceAssetId'?: string | null;
  'sourceResolution': string;
  'sourceUrl': string;
  'status'?: string;
  'targetResolution': string;
  'updatedAt': number;
  'usageRecordId'?: string | null;
  'userId'?: number | null;
  'workspaceId': string;
}
export interface o_vendorConfig {
  'enable'?: number | null;
  'id'?: string;
  'inputValues'?: string | null;
  'models'?: string | null;
}
export interface o_video {
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'id'?: number;
  'projectId'?: number | null;
  'relayTaskId'?: string | null;
  'scriptId'?: number | null;
  'state'?: string | null;
  'storageKey'?: string | null;
  'time'?: number | null;
  'videoTrackId'?: number | null;
}
export interface o_video_fulfillment_recipe {
  'createdAt': number;
  'enabled'?: number;
  'enhanceChannelId'?: string | null;
  'enhanceEnabled'?: number;
  'generateChannelId': string;
  'generateResolution': string;
  'id'?: string;
  'name'?: string;
  'priority'?: number;
  'publicModel': string;
  'targetResolution': string;
  'updatedAt': number;
  'upstreamModel'?: string | null;
  'weight'?: number;
}
export interface o_video_public_offer {
  'createdAt': number;
  'displayName': string;
  'enabled'?: number;
  'id'?: string;
  'publicModel': string;
  'updatedAt': number;
  'visibleResolutions'?: string;
}
export interface o_videoTrack {
  'duration'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'reason'?: string | null;
  'scriptId'?: number | null;
  'selectVideoId'?: number | null;
  'state'?: string | null;
  'videoId'?: number | null;
}
export interface o_worker_heartbeat {
  'acceptingWork'?: number | null;
  'activeTaskCount'?: number | null;
  'artifactSha256'?: string | null;
  'controlRevision'?: number | null;
  'createdAt': number;
  'drainOperationId'?: string | null;
  'heartbeatAt': number;
  'hostname': string;
  'id'?: string;
  'incarnationId'?: string | null;
  'nodeId'?: string | null;
  'processId': number;
  'releaseId'?: string | null;
  'role': string;
  'schemaVersion'?: number | null;
  'startedAt': number;
  'updatedAt': number;
}
export interface o_worker_release_control {
  'createdAt': number;
  'desiredState'?: string;
  'nodeId'?: string;
  'operationId'?: string | null;
  'requestedAt'?: number | null;
  'revision'?: number;
  'updatedAt': number;
}
export interface o_workflow_graph {
  'coverImageUrl'?: string | null;
  'coverStorageKey'?: string | null;
  'createTime'?: number | null;
  'edges'?: string | null;
  'episodesId'?: number | null;
  'groups'?: string;
  'id'?: number;
  'name'?: string | null;
  'nodes'?: string | null;
  'projectId'?: number | null;
  'revision'?: number;
  'updateTime'?: number | null;
  'viewport'?: string | null;
}
export interface o_workspace {
  'createdAt': number;
  'id'?: string;
  'name': string;
  'ownerUserId': number;
  'slug': string;
  'status': string;
  'updatedAt': number;
}
export interface o_workspace_execution {
  'createdAt': number;
  'endpointType': string;
  'id'?: string | null;
  'releaseProof'?: string | null;
  'state': string;
  'storageBytes': number;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_workspace_invitation {
  'acceptedAt'?: number | null;
  'createdAt': number;
  'email': string;
  'expiresAt': number;
  'id'?: string;
  'inviterUserId'?: number | null;
  'role': string;
  'status': string;
  'tokenHash': string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_workspace_member {
  'createdAt': number;
  'id'?: string;
  'notes'?: string | null;
  'permissions'?: string | null;
  'quotaLimit'?: number | null;
  'rateLimitPerMinute'?: number | null;
  'role': string;
  'status': string;
  'updatedAt': number;
  'userId': number;
  'workspaceId': string;
}
export interface o_workspace_owner_transfer_command {
  'action': string;
  'actorUserId': number;
  'createdAt': number;
  'formerOwnerRole': string;
  'formerOwnerUserId': number;
  'id'?: string;
  'idempotencyKey': string;
  'payloadHash': string;
  'resultJson': string;
  'targetUserId': number;
  'workspaceId': string;
}
export interface o_workspace_plan_subscription {
  'cancelAt'?: number | null;
  'createdAt': number;
  'currentPeriodEnd'?: number | null;
  'currentPeriodStart'?: number | null;
  'id'?: string;
  'metadata'?: string;
  'planId': string;
  'status'?: string;
  'updatedAt': number;
  'workspaceId': string;
}
export interface o_workspace_resource_account {
  'inventoryEvidence'?: string;
  'inventoryReady'?: boolean;
  'updatedAt': number;
  'workspaceId'?: string | null;
}
export interface o_workspace_storage {
  'bytes': number;
  'createdAt': number;
  'evidence': string;
  'id'?: string | null;
  'objectKey': string;
  'providerFingerprint': string;
  'state': string;
  'temporary'?: boolean;
  'updatedAt': number;
  'versionId'?: string | null;
  'workspaceId': string;
}

export interface DB {
  "memories": memories;
  "o_account_gift_grant": o_account_gift_grant;
  "o_account_mfa_recovery_code": o_account_mfa_recovery_code;
  "o_account_security": o_account_security;
  "o_account_verification": o_account_verification;
  "o_account_wallet": o_account_wallet;
  "o_account_wallet_ledger": o_account_wallet_ledger;
  "o_agent_approval": o_agent_approval;
  "o_agent_delegation": o_agent_delegation;
  "o_agent_delegation_usage": o_agent_delegation_usage;
  "o_agent_event": o_agent_event;
  "o_agent_generation_quote": o_agent_generation_quote;
  "o_agent_generation_review": o_agent_generation_review;
  "o_agent_idempotency": o_agent_idempotency;
  "o_agent_message": o_agent_message;
  "o_agent_review_report": o_agent_review_report;
  "o_agent_role_config": o_agent_role_config;
  "o_agent_run": o_agent_run;
  "o_agent_step": o_agent_step;
  "o_agent_thread": o_agent_thread;
  "o_agentDeploy": o_agentDeploy;
  "o_agentWorkData": o_agentWorkData;
  "o_api_key": o_api_key;
  "o_api_key_quota_reservation": o_api_key_quota_reservation;
  "o_api_key_rate_limit": o_api_key_rate_limit;
  "o_artStyle": o_artStyle;
  "o_asset_file_folder": o_asset_file_folder;
  "o_asset_file_metadata": o_asset_file_metadata;
  "o_asset_file_placement": o_asset_file_placement;
  "o_asset_grant": o_asset_grant;
  "o_asset_library_audit": o_asset_library_audit;
  "o_asset_ownership": o_asset_ownership;
  "o_assets": o_assets;
  "o_assets2Storyboard": o_assets2Storyboard;
  "o_assetsRole2Audio": o_assetsRole2Audio;
  "o_audit_log": o_audit_log;
  "o_auth_login_state": o_auth_login_state;
  "o_auth_token": o_auth_token;
  "o_billing_account": o_billing_account;
  "o_billing_audit_log": o_billing_audit_log;
  "o_billing_finance_intent": o_billing_finance_intent;
  "o_billing_finance_worker": o_billing_finance_worker;
  "o_billing_ledger": o_billing_ledger;
  "o_billing_outbox": o_billing_outbox;
  "o_billing_plan": o_billing_plan;
  "o_billing_reconcile_job": o_billing_reconcile_job;
  "o_billing_service_request": o_billing_service_request;
  "o_billing_service_request_command": o_billing_service_request_command;
  "o_billing_watchdog_lease": o_billing_watchdog_lease;
  "o_cache_storage_accrual": o_cache_storage_accrual;
  "o_canvas_asset": o_canvas_asset;
  "o_canvas_command_mutation": o_canvas_command_mutation;
  "o_canvas_share": o_canvas_share;
  "o_canvas_workflow_template": o_canvas_workflow_template;
  "o_commercial_consumption_allocation": o_commercial_consumption_allocation;
  "o_commercial_credit_lot": o_commercial_credit_lot;
  "o_commercial_tenant": o_commercial_tenant;
  "o_creation_session": o_creation_session;
  "o_creation_session_mutation": o_creation_session_mutation;
  "o_deletion_audit_chunk": o_deletion_audit_chunk;
  "o_deletion_manifest_chunk": o_deletion_manifest_chunk;
  "o_deletion_operation": o_deletion_operation;
  "o_deletion_operation_checkpoint": o_deletion_operation_checkpoint;
  "o_deletion_outbox": o_deletion_outbox;
  "o_deletion_resource_alias": o_deletion_resource_alias;
  "o_domain_verification": o_domain_verification;
  "o_event": o_event;
  "o_eventChapter": o_eventChapter;
  "o_external_tool_operation": o_external_tool_operation;
  "o_external_tool_upload": o_external_tool_upload;
  "o_finance_income_record": o_finance_income_record;
  "o_fjtv_publication": o_fjtv_publication;
  "o_generation_history_visibility": o_generation_history_visibility;
  "o_image": o_image;
  "o_imageFlow": o_imageFlow;
  "o_ingress_cluster": o_ingress_cluster;
  "o_invitation_record": o_invitation_record;
  "o_media_asset": o_media_asset;
  "o_media_service": o_media_service;
  "o_membership_control": o_membership_control;
  "o_membership_period": o_membership_period;
  "o_membership_product": o_membership_product;
  "o_membership_subscription": o_membership_subscription;
  "o_model_route": o_model_route;
  "o_model_route_certification": o_model_route_certification;
  "o_model_route_certification_batch": o_model_route_certification_batch;
  "o_modelPrompt": o_modelPrompt;
  "o_novel": o_novel;
  "o_object_write_absence_reconciliation": o_object_write_absence_reconciliation;
  "o_object_write_intent": o_object_write_intent;
  "o_payment_event": o_payment_event;
  "o_payment_order": o_payment_order;
  "o_platform_release": o_platform_release;
  "o_portrait_admission": o_portrait_admission;
  "o_portrait_auth_session": o_portrait_auth_session;
  "o_portrait_consent": o_portrait_consent;
  "o_portrait_identity": o_portrait_identity;
  "o_portrait_imagex_review_job": o_portrait_imagex_review_job;
  "o_portrait_manual_review": o_portrait_manual_review;
  "o_portrait_provider_asset": o_portrait_provider_asset;
  "o_portrait_provider_group": o_portrait_provider_group;
  "o_pricing_group": o_pricing_group;
  "o_pricing_rule": o_pricing_rule;
  "o_project": o_project;
  "o_project_asset_ref": o_project_asset_ref;
  "o_project_folder": o_project_folder;
  "o_project_mutation": o_project_mutation;
  "o_prompt": o_prompt;
  "o_provider_channel": o_provider_channel;
  "o_provider_channel_slot": o_provider_channel_slot;
  "o_provider_cost_ledger": o_provider_cost_ledger;
  "o_redemption_code": o_redemption_code;
  "o_reference_multipart_upload": o_reference_multipart_upload;
  "o_relay_callback_delivery": o_relay_callback_delivery;
  "o_relay_task": o_relay_task;
  "o_release_artifact": o_release_artifact;
  "o_release_artifact_multipart_upload": o_release_artifact_multipart_upload;
  "o_release_artifact_upload_reservation": o_release_artifact_upload_reservation;
  "o_release_deployment": o_release_deployment;
  "o_release_deployment_event": o_release_deployment_event;
  "o_release_deployment_reconciliation": o_release_deployment_reconciliation;
  "o_release_deployment_target": o_release_deployment_target;
  "o_request_log": o_request_log;
  "o_responses_resource_binding": o_responses_resource_binding;
  "o_schema_migration": o_schema_migration;
  "o_schema_migration_lock": o_schema_migration_lock;
  "o_schema_migration_run": o_schema_migration_run;
  "o_script": o_script;
  "o_scriptAssets": o_scriptAssets;
  "o_setting": o_setting;
  "o_skillAttribution": o_skillAttribution;
  "o_skillList": o_skillList;
  "o_storyboard": o_storyboard;
  "o_tasks": o_tasks;
  "o_tenant_auth_transfer": o_tenant_auth_transfer;
  "o_tenant_certificate": o_tenant_certificate;
  "o_tenant_domain": o_tenant_domain;
  "o_tenant_domain_operation": o_tenant_domain_operation;
  "o_tenant_ingress_binding": o_tenant_ingress_binding;
  "o_tenant_settlement_account": o_tenant_settlement_account;
  "o_tenant_settlement_ledger": o_tenant_settlement_ledger;
  "o_tenant_settlement_period": o_tenant_settlement_period;
  "o_usage_record": o_usage_record;
  "o_user": o_user;
  "o_user_commercial_profile": o_user_commercial_profile;
  "o_user_feedback": o_user_feedback;
  "o_user_feedback_attachment": o_user_feedback_attachment;
  "o_user_oauth_identity": o_user_oauth_identity;
  "o_user_password_history": o_user_password_history;
  "o_user_session": o_user_session;
  "o_user_tenant_attribution_history": o_user_tenant_attribution_history;
  "o_user_video_enhance_task": o_user_video_enhance_task;
  "o_vendorConfig": o_vendorConfig;
  "o_video": o_video;
  "o_video_fulfillment_recipe": o_video_fulfillment_recipe;
  "o_video_public_offer": o_video_public_offer;
  "o_videoTrack": o_videoTrack;
  "o_worker_heartbeat": o_worker_heartbeat;
  "o_worker_release_control": o_worker_release_control;
  "o_workflow_graph": o_workflow_graph;
  "o_workspace": o_workspace;
  "o_workspace_execution": o_workspace_execution;
  "o_workspace_invitation": o_workspace_invitation;
  "o_workspace_member": o_workspace_member;
  "o_workspace_owner_transfer_command": o_workspace_owner_transfer_command;
  "o_workspace_plan_subscription": o_workspace_plan_subscription;
  "o_workspace_resource_account": o_workspace_resource_account;
  "o_workspace_storage": o_workspace_storage;
}
