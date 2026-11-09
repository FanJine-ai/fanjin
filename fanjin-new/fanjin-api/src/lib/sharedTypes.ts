// fanjin-shared: 创作台与中转站共享的类型定义。
// 这个文件不依赖任何业务模块，只定义类型契约。
// billing.ts、relay.ts、creationBilling.ts、relayChat.ts 等都从这里导入。

// ============ C1 Identity / Service Request 公共合同 ============
export const identityContractVersion = "identity.v1" as const;
export const serviceRequestContractVersion = "service-request.v1" as const;
export const capabilityContractVersion = "capability.v1" as const;
export const videoDeliveryContractVersion = "video-delivery.v1" as const;
export const workerContractVersion = "worker.v1" as const;

export type UserId = number;
export type WorkspaceId = string;
export type ProjectId = number;
export type CanvasId = number;
export type EpochMilliseconds = number;

export const userStatuses = ["active", "disabled", "locked"] as const;
export const workspaceStatuses = ["active", "suspended"] as const;
export const workspaceMemberStatuses = ["active", "disabled"] as const;
export const workspaceInvitationStatuses = [
  "pending",
  "accepted",
  "revoked",
  "expired",
  "superseded",
] as const;

export const platformRoles = ["root", "admin", "super_admin"] as const;
export const financeRoles = ["finance_viewer", "finance_operator", "finance_manager"] as const;
export const workspaceRoles = [
  "owner",
  "workspace_admin",
  "creator",
] as const;

export type UserStatus = (typeof userStatuses)[number];
export type WorkspaceStatus = (typeof workspaceStatuses)[number];
export type WorkspaceMemberStatus = (typeof workspaceMemberStatuses)[number];
export type WorkspaceInvitationStatus = (typeof workspaceInvitationStatuses)[number];
export type PlatformRole = (typeof platformRoles)[number];
export type FinanceRole = (typeof financeRoles)[number];
export type WorkspaceRole = (typeof workspaceRoles)[number];
export type LegacyUserRole = PlatformRole | FinanceRole | WorkspaceRole | "user" | "member";

export interface IdentitySubjectV1 {
  contractVersion: typeof identityContractVersion;
  userId: UserId;
  userStatus: UserStatus;
  legacyRole: LegacyUserRole | null;
  platformRole: PlatformRole | null;
  financeRole: FinanceRole | null;
  workspaceId: WorkspaceId | null;
  workspaceStatus: WorkspaceStatus | null;
  membershipId: string | null;
  membershipStatus: WorkspaceMemberStatus | null;
  workspaceRole: WorkspaceRole | null;
  platformPermissions: readonly string[];
  financePermissions: readonly string[];
  workspacePermissions: readonly string[];
}

export interface SessionIdentityV1 {
  sessionId: string;
  userId: UserId;
  workspaceId: WorkspaceId | null;
  createdAt: EpochMilliseconds;
  lastSeenAt: EpochMilliseconds | null;
  absoluteExpiresAt: EpochMilliseconds;
  idleExpiresAt: EpochMilliseconds | null;
}

/**
 * Server-only credential binding. Never expose this shape to browser DTOs or
 * logs.
 */
export interface SessionCredentialBindingV1 {
  passwordVersion: string;
  mfaVersion: string;
}

export interface ResourceOwnershipV1 {
  workspaceId: WorkspaceId;
  ownerUserId: UserId | null;
  projectId: ProjectId | null;
  canvasId: CanvasId | null;
}

export type AuditActorV1 =
  | {
      actorType: "user";
      actorUserId: UserId;
      actorRole: LegacyUserRole | null;
      workspaceRole: WorkspaceRole | null;
      sessionId: string | null;
    }
  | {
      actorType: "api_key";
      apiKeyId: string;
      ownerUserId: UserId | null;
      workspaceId: WorkspaceId | null;
    }
  | {
      actorType: "system";
      principal: string;
    }
  | {
      actorType: "worker";
      workerId: string;
      principal: string;
    };

export interface AuditEventV1 {
  actor: AuditActorV1;
  workspaceId: WorkspaceId | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  stepUpScope: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: EpochMilliseconds;
}

export const serviceRequestTypes = ["invoice", "credit_limit", "offline_payment"] as const;
export const legacyServiceRequestStatuses = [
  "pending",
  "approved",
  "rejected",
  "issued",
  "cancelled",
] as const;
export const serviceRequestDecisions = ["pending", "approved", "rejected", "cancelled"] as const;
export const serviceRequestFinanceStates = [
  "not_applicable",
  "not_started",
  "processing",
  "succeeded",
  "failed_retryable",
  "manual_required",
] as const;
export const serviceRequestCompatibilityStatuses = [
  "native_v1",
  "legacy_unverified",
  "legacy_verified",
  "legacy_inconsistent",
] as const;

export type ServiceRequestType = (typeof serviceRequestTypes)[number];
export type LegacyServiceRequestStatus = (typeof legacyServiceRequestStatuses)[number];
export type ServiceRequestDecisionV1 = (typeof serviceRequestDecisions)[number];
export type ServiceRequestFinanceStateV1 = (typeof serviceRequestFinanceStates)[number];
export type ServiceRequestCompatibilityStatusV1 =
  (typeof serviceRequestCompatibilityStatuses)[number];
export type ServiceRequestConsistentCompatibilityStatusV1 = Exclude<
  ServiceRequestCompatibilityStatusV1,
  "legacy_inconsistent"
>;

type ServiceRequestLifecycleAxesV1 =
  | {
      decision: "pending";
      financeState: "not_started";
    }
  | {
      decision: "approved";
      financeState:
        | "not_started"
        | "processing"
        | "succeeded"
        | "failed_retryable"
        | "manual_required";
    }
  | {
      decision: "rejected" | "cancelled";
      financeState: "not_applicable";
    };

type ServiceRequestLifecycleAxesByCompatibilityV1 = {
  native_v1: ServiceRequestLifecycleAxesV1;
  legacy_unverified: {
    decision: "pending";
    financeState: "not_started";
  };
  legacy_verified:
    | {
        decision: "approved";
        financeState: "succeeded";
      }
    | {
        decision: "rejected" | "cancelled";
        financeState: "not_applicable";
      };
};

export type ServiceRequestLifecycleForCompatibilityV1<
  TCompatibilityStatus extends
    ServiceRequestConsistentCompatibilityStatusV1 = ServiceRequestConsistentCompatibilityStatusV1,
> = TCompatibilityStatus extends TCompatibilityStatus
  ? {
      /**
       * Read-only adapter diagnosis. It is not a transition input and must
       * never drive a finance mutation.
       */
      readonly compatibilityStatus: TCompatibilityStatus;
    } & ServiceRequestLifecycleAxesByCompatibilityV1[TCompatibilityStatus]
  : never;

export type ServiceRequestLifecycleV1 = ServiceRequestLifecycleForCompatibilityV1;

type ServiceRequestConsistentLifecycleReadProjectionV1<
  TCompatibilityStatus extends ServiceRequestConsistentCompatibilityStatusV1,
> = TCompatibilityStatus extends TCompatibilityStatus
  ? {
      readonly compatibilityStatus: TCompatibilityStatus;
      lifecycle: ServiceRequestLifecycleForCompatibilityV1<TCompatibilityStatus>;
      financeMutationAllowed: TCompatibilityStatus extends "native_v1" ? boolean : false;
      warningCode: null;
    }
  : never;

/**
 * Read-adapter result for native and legacy rows. An inconsistent legacy row
 * deliberately has no lifecycle and can never authorize a finance mutation.
 */
export type ServiceRequestLifecycleReadProjectionV1 =
  | ServiceRequestConsistentLifecycleReadProjectionV1<ServiceRequestConsistentCompatibilityStatusV1>
  | {
      readonly compatibilityStatus: "legacy_inconsistent";
      lifecycle: null;
      financeMutationAllowed: false;
      warningCode: "SERVICE_REQUEST_LEGACY_INCONSISTENT";
    };

export type ServiceRequestPayloadV1 =
  | {
      type: "invoice";
      invoiceAmountMicros: number;
      invoiceCurrency: "CNY";
      invoiceProfileHash: string;
    }
  | {
      type: "offline_payment";
      paidAmountMicros: number;
      paidCurrency: "CNY";
      paymentEvidenceId: string;
    }
  | {
      type: "credit_limit";
      requestedCreditLimitMicros: number;
      currency: "GU";
      reason: string;
    };

export type ServiceRequestFinanceResultV1 =
  | {
      kind: "invoice_issued";
      financeOperationId: string;
      invoiceBatchId: string;
      documentAmountMicros: number;
      documentCurrency: "CNY";
    }
  | {
      kind: "offline_payment_credited";
      financeOperationId: string;
      incomeRecordId: string;
      targetOwnerUserId: UserId;
      ownerWalletLedgerId: string;
      workspaceProjectionLedgerId: string;
      tenderAmountMicros: number;
      tenderCurrency: "CNY";
      creditedAmountMicros: number;
      creditedCurrency: "GU";
      conversionPolicyVersion: "cny-gu/v1" | "cny-gu/v2";
      conversionSnapshotHash: string;
    }
  | {
      kind: "credit_limit_applied";
      financeOperationId: string;
      targetOwnerUserId: UserId;
      ownerWalletLedgerId: string;
      workspaceProjectionLedgerId: string;
      previousLimitMicros: number;
      newLimitMicros: number;
      currency: "GU";
    };

interface ServiceRequestRecordBaseV1 {
  contractVersion: typeof serviceRequestContractVersion;
  id: string;
  workspaceId: WorkspaceId;
  amountMicros: number;
  subjectName: string | null;
  taxId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  note: string | null;
  submittedByUserId: UserId | null;
  createdAt: EpochMilliseconds;
  updatedAt: EpochMilliseconds;
}

type ServiceRequestTypeFieldsV1 =
  | {
      type: "invoice";
      currency: "CNY";
    }
  | {
      type: "offline_payment";
      currency: "CNY";
    }
  | {
      type: "credit_limit";
      currency: "GU";
    };

type ServiceRequestIncompleteProjectionV1 =
  | {
      status: "pending";
      decision: "pending";
      financeState: "not_started";
      financeResult: null;
      reviewedByUserId: null;
      reviewNote: null;
      reviewedAt: null;
    }
  | {
      status: "pending";
      decision: "approved";
      financeState: "not_started" | "processing" | "failed_retryable" | "manual_required";
      financeResult: null;
      reviewedByUserId: UserId;
      reviewNote: string | null;
      reviewedAt: EpochMilliseconds;
    }
  | {
      status: "rejected";
      decision: "rejected";
      financeState: "not_applicable";
      financeResult: null;
      reviewedByUserId: UserId;
      reviewNote: string;
      reviewedAt: EpochMilliseconds;
    }
  | {
      status: "cancelled";
      decision: "cancelled";
      financeState: "not_applicable";
      financeResult: null;
      reviewedByUserId: UserId;
      reviewNote: string;
      reviewedAt: EpochMilliseconds;
    };

type ServiceRequestSucceededProjectionV1 =
  | {
      type: "invoice";
      currency: "CNY";
      status: "issued";
      decision: "approved";
      financeState: "succeeded";
      financeResult: Extract<ServiceRequestFinanceResultV1, { kind: "invoice_issued" }>;
      reviewedByUserId: UserId;
      reviewNote: string | null;
      reviewedAt: EpochMilliseconds;
    }
  | {
      type: "offline_payment";
      currency: "CNY";
      status: "approved";
      decision: "approved";
      financeState: "succeeded";
      financeResult: Extract<ServiceRequestFinanceResultV1, { kind: "offline_payment_credited" }>;
      reviewedByUserId: UserId;
      reviewNote: string | null;
      reviewedAt: EpochMilliseconds;
    }
  | {
      type: "credit_limit";
      currency: "GU";
      status: "approved";
      decision: "approved";
      financeState: "succeeded";
      financeResult: Extract<ServiceRequestFinanceResultV1, { kind: "credit_limit_applied" }>;
      reviewedByUserId: UserId;
      reviewNote: string | null;
      reviewedAt: EpochMilliseconds;
    };

type ServiceRequestValidProjectionV1 =
  | (ServiceRequestTypeFieldsV1 & ServiceRequestIncompleteProjectionV1)
  | ServiceRequestSucceededProjectionV1;

type ServiceRequestLegacyUnverifiedProjectionV1 =
  ServiceRequestTypeFieldsV1 &
    Extract<ServiceRequestIncompleteProjectionV1, { decision: "pending" }>;

type ServiceRequestLegacyVerifiedProjectionV1 =
  | ServiceRequestSucceededProjectionV1
  | (ServiceRequestTypeFieldsV1 &
      Extract<ServiceRequestIncompleteProjectionV1, { decision: "rejected" | "cancelled" }>);

/**
 * The legacy status is a compatibility projection. The union deliberately
 * makes invalid lifecycle/status/result/compatibility combinations
 * unrepresentable. Legacy-unverified rows are pending-only; legacy-verified
 * rows require a proven success or a legacy terminal reject/cancel.
 */
export type ServiceRequestRecordV1 = ServiceRequestRecordBaseV1 & (
  | ({ readonly compatibilityStatus: "native_v1" } & ServiceRequestValidProjectionV1)
  | ({ readonly compatibilityStatus: "legacy_unverified" } &
      ServiceRequestLegacyUnverifiedProjectionV1)
  | ({ readonly compatibilityStatus: "legacy_verified" } &
      ServiceRequestLegacyVerifiedProjectionV1)
);

export type ServiceRequestReviewCommandV1 =
  | {
      operation: "service_request_review";
      requestId: string;
      targetDecision: "approved";
      reason: null;
      reviewEvidenceId: string;
      expectedRevision: number;
      idempotencyKey: string;
    }
  | {
      operation: "service_request_review";
      requestId: string;
      targetDecision: "rejected" | "cancelled";
      reason: string;
      reviewEvidenceId: string;
      expectedRevision: number;
      idempotencyKey: string;
    };

type LockedServiceRequestReviewLifecycleV1 =
  | {
      currentDecision: "pending";
      currentFinanceState: "not_started";
    }
  | {
      currentDecision: "approved";
      currentFinanceState:
        | "not_started"
        | "processing"
        | "succeeded"
        | "failed_retryable"
        | "manual_required";
    }
  | {
      currentDecision: "rejected" | "cancelled";
      currentFinanceState: "not_applicable";
    };

/**
 * Authoritative review state loaded under the same database lock used for the
 * revision update. Client-supplied status/decision values never satisfy this
 * proof.
 */
export type LockedServiceRequestReviewAuthorityV1 = {
  authoritySource: "locked_service_request_record";
  requestId: string;
  workspaceId: WorkspaceId;
  readonly compatibilityStatus: ServiceRequestCompatibilityStatusV1;
  revision: number;
  lockedAt: EpochMilliseconds;
} & LockedServiceRequestReviewLifecycleV1;

export const serviceRequestReviewTransitionErrorCodes = [
  "SERVICE_REQUEST_REVIEW_TARGET_MISMATCH",
  "SERVICE_REQUEST_REVIEW_REVISION_MISMATCH",
  "SERVICE_REQUEST_REVIEW_COMPATIBILITY_NOT_NATIVE",
  "SERVICE_REQUEST_REVIEW_TRANSITION_NOT_ALLOWED",
] as const;

export type ServiceRequestReviewTransitionErrorCodeV1 =
  (typeof serviceRequestReviewTransitionErrorCodes)[number];

export type ServiceRequestReviewTransitionResultV1 =
  | {
      ok: true;
      code: "SERVICE_REQUEST_REVIEW_ALLOWED";
      authoritySource: "locked_service_request_record";
      requestId: string;
      revision: number;
      fromDecision: "pending";
      toDecision: ServiceRequestReviewCommandV1["targetDecision"];
    }
  | {
      ok: false;
      code: ServiceRequestReviewTransitionErrorCodeV1;
      status: 409;
    };

/**
 * Evaluate the frozen review transition against locked server authority.
 * In particular, an approved/rejected/cancelled record can never be rewritten
 * by a later reject/cancel command, even when the caller supplies a matching
 * revision.
 */
export function evaluateServiceRequestReviewTransitionV1(
  authority: LockedServiceRequestReviewAuthorityV1,
  command: ServiceRequestReviewCommandV1,
): ServiceRequestReviewTransitionResultV1 {
  if (authority.requestId !== command.requestId) {
    return {
      ok: false,
      code: "SERVICE_REQUEST_REVIEW_TARGET_MISMATCH",
      status: 409,
    };
  }
  if (authority.revision !== command.expectedRevision) {
    return {
      ok: false,
      code: "SERVICE_REQUEST_REVIEW_REVISION_MISMATCH",
      status: 409,
    };
  }
  if (authority.compatibilityStatus !== "native_v1") {
    return {
      ok: false,
      code: "SERVICE_REQUEST_REVIEW_COMPATIBILITY_NOT_NATIVE",
      status: 409,
    };
  }
  if (
    authority.currentDecision !== "pending"
    || authority.currentFinanceState !== "not_started"
  ) {
    return {
      ok: false,
      code: "SERVICE_REQUEST_REVIEW_TRANSITION_NOT_ALLOWED",
      status: 409,
    };
  }
  return {
    ok: true,
    code: "SERVICE_REQUEST_REVIEW_ALLOWED",
    authoritySource: "locked_service_request_record",
    requestId: authority.requestId,
    revision: authority.revision,
    fromDecision: "pending",
    toDecision: command.targetDecision,
  };
}

/**
 * Finance issue accepts only the canonical request id. Workspace, request
 * type, amount and currency must be loaded from the locked record below.
 */
export interface ServiceRequestFinanceIssueCommandV1 {
  operation: "service_request_issue";
  requestId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

type LockedServiceRequestFinanceAuthorityBaseV1 = {
  authoritySource: "locked_service_request_record";
  requestId: string;
  workspaceId: WorkspaceId;
  decision: "approved";
  financeState: "not_started" | "failed_retryable";
  readonly compatibilityStatus: "native_v1";
  revision: number;
  lockedAt: EpochMilliseconds;
};

export type LockedServiceRequestFinanceAuthorityV1 =
  LockedServiceRequestFinanceAuthorityBaseV1 &
    (
      | {
          requestType: "invoice";
          payload: Extract<ServiceRequestPayloadV1, { type: "invoice" }>;
        }
      | {
          requestType: "offline_payment";
          payload: Extract<ServiceRequestPayloadV1, { type: "offline_payment" }>;
        }
      | {
          requestType: "credit_limit";
          payload: Extract<ServiceRequestPayloadV1, { type: "credit_limit" }>;
        }
    );

export interface PersistedServiceRequestFinanceIntentV1 {
  intentState: "persisted";
  operation: "service_request_issue";
  financeOperationId: string;
  uniqueScope: {
    operation: "service_request_issue";
    workspaceId: WorkspaceId;
    requestId: string;
    requestType: ServiceRequestType;
  };
  payloadHashVersion: "jcs-sha256/v1";
  payloadHash: string;
  lockedRevision: number;
  durableAuditIntentId: string;
  outboxIds: readonly string[];
  committedAt: EpochMilliseconds;
}

export type ServiceRequestFinanceDispatchGateV1 =
  | {
      durableIntent: PersistedServiceRequestFinanceIntentV1;
      externalSideEffectAllowed: true;
    }
  | {
      durableIntent: null;
      externalSideEffectAllowed: false;
    };

export type ServiceRequestFinanceIssueOutcomeV1 =
  | {
      outcome: "executed";
      replayed: false;
      httpStatus: 200;
      financeResult: ServiceRequestFinanceResultV1;
    }
  | {
      outcome: "exact_replay";
      replayed: true;
      httpStatus: 200;
      financeResult: ServiceRequestFinanceResultV1;
    }
  | {
      outcome: "payload_mismatch";
      replayed: false;
      httpStatus: 409;
      code: "BILLING_IDEMPOTENCY_CONFLICT";
      financeResult: null;
    }
  | {
      outcome: "manual_required";
      replayed: boolean;
      httpStatus: 202;
      code: "BILLING_RECONCILIATION_REQUIRED";
      financeResult: null;
    }
  | {
      outcome: "intent_persistence_failed";
      replayed: false;
      httpStatus: 500;
      code: "BILLING_INVARIANT_FAILED";
      externalSideEffectAllowed: false;
      financeResult: null;
    };

// ============ C1 Capability / Delivery / Worker 公共合同 ============
export const providerEndpointTypesV1 = [
  "video_generation",
  "video_upscale",
  "image_generation",
  "text",
  "embedding",
  "multimodal_embedding",
  "tts",
  "rerank",
  "transcription",
] as const;
export const videoProviderEndpointTypesV1 = ["video_generation", "video_upscale"] as const;
export const productCapabilityKeysV1 = ["video.generation", "video.enhance"] as const;
export const videoProductBillingSubjectsV1 = [
  "video_generation",
  "video_enhance",
] as const;
export const publicVideoResolutionsV1 = ["720p", "1080p", "2k", "4k"] as const;
export const internalVideoResolutionsV1 = ["480p", ...publicVideoResolutionsV1] as const;
export const videoGenerationExecutionModesV1 = [
  "direct_generation",
  "generate_then_enhance",
] as const;
export const videoTaskPipelinesV1 = [
  ...videoGenerationExecutionModesV1,
  "user_enhance",
] as const;
export const capabilityAvailabilitiesV1 = [
  "available",
  "degraded",
  "unavailable",
] as const;

export type ProviderEndpointTypeV1 = (typeof providerEndpointTypesV1)[number];
export type VideoProviderEndpointTypeV1 = (typeof videoProviderEndpointTypesV1)[number];
export type ProductCapabilityKeyV1 = (typeof productCapabilityKeysV1)[number];
export type VideoProductBillingSubjectV1 =
  (typeof videoProductBillingSubjectsV1)[number];
export type PublicVideoResolutionV1 = (typeof publicVideoResolutionsV1)[number];
export type InternalVideoResolutionV1 = (typeof internalVideoResolutionsV1)[number];
export type VideoGenerationExecutionModeV1 =
  (typeof videoGenerationExecutionModesV1)[number];
export type VideoTaskPipelineV1 = (typeof videoTaskPipelinesV1)[number];
export type CapabilityAvailabilityV1 = (typeof capabilityAvailabilitiesV1)[number];
export type ProviderHealthV1 = "ok" | "degraded" | "failed" | "disabled" | null;

export interface PublicDeveloperModelProjectionV1 {
  contractVersion: typeof capabilityContractVersion;
  publicModelId: string;
  displayName: string;
  endpointType: Exclude<ProviderEndpointTypeV1, "video_upscale">;
  availability: CapabilityAvailabilityV1;
  canSubmit: boolean;
  modalities: readonly string[];
  output: string;
  resolutions: readonly PublicVideoResolutionV1[];
  defaultResolution: PublicVideoResolutionV1 | null;
  qualities: readonly string[];
  defaultQuality: string | null;
  apiStyle: string;
}

export interface VideoFulfillmentCapabilityV1 {
  contractVersion: typeof capabilityContractVersion;
  recipeId: string;
  publicModelId: string;
  targetResolution: PublicVideoResolutionV1;
  generateResolution: InternalVideoResolutionV1;
  executionMode: VideoGenerationExecutionModeV1;
  generateChannelId: string;
  enhanceChannelId: string | null;
  upstreamModel: string | null;
  priority: number;
  weight: number;
  enabled: boolean;
}

export const videoTaskKindsV1 = ["video_generation", "video_enhance"] as const;
export const videoTaskStatusesV1 = [
  "queued",
  "running",
  "pending_reconcile",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const videoTaskPhasesV1 = [
  "queued",
  "generating",
  "enhancing",
  "finalizing",
  "reconciling",
  "terminal",
] as const;
export const videoDeliveryStatusesV1 = [
  "pending",
  "delivered_native",
  "delivered_enhanced",
  "degraded_source_only",
  "pending_reconcile",
  "failed",
  "cancelled",
] as const;
export const enhancementStatusesV1 = [
  "not_required",
  "pending",
  "running",
  "succeeded",
  "failed",
  "pending_reconcile",
  "cancelled",
] as const;
export const usageBillingStatesV1 = [
  "reserved",
  "captured",
  "partially_refunded",
  "refunded",
  "released",
  "pending_reconcile",
] as const;

export type VideoTaskKindV1 = (typeof videoTaskKindsV1)[number];
export type VideoTaskStatusV1 = (typeof videoTaskStatusesV1)[number];
export type VideoTaskPhaseV1 = (typeof videoTaskPhasesV1)[number];
export type VideoDeliveryStatusV1 = (typeof videoDeliveryStatusesV1)[number];
export type EnhancementStatusV1 = (typeof enhancementStatusesV1)[number];
export type UsageBillingStateV1 = (typeof usageBillingStatesV1)[number];

export interface UsageBillingProjectionV1 {
  capturedMicros: number;
  refundedMicros: number;
  netCapturedMicros: number;
  billingState: UsageBillingStateV1;
}

export interface SafeVideoFailureV1 {
  code: string;
  safeMessage: string;
}

export interface VideoAssetRefsV1 {
  sourceAssetId: string | null;
  resultAssetId: string | null;
  fallbackAssetId: string | null;
}

export interface VideoTaskDeliveryV1 {
  contractVersion: typeof videoDeliveryContractVersion;
  taskId: string;
  productRequestId: string;
  workspaceId: WorkspaceId;
  taskKind: VideoTaskKindV1;
  pipeline: VideoTaskPipelineV1;
  publicModelId: string | null;
  requestedResolution: PublicVideoResolutionV1;
  sourceResolution: InternalVideoResolutionV1 | null;
  generationResolution: InternalVideoResolutionV1 | null;
  deliveredResolution: InternalVideoResolutionV1 | null;
  taskStatus: VideoTaskStatusV1;
  phase: VideoTaskPhaseV1;
  deliveryStatus: VideoDeliveryStatusV1;
  enhancementStatus: EnhancementStatusV1;
  metRequestedQuality: boolean;
  currentAttemptId: string | null;
  attemptCount: number;
  winningAttemptId: string | null;
  assets: VideoAssetRefsV1;
  failure: SafeVideoFailureV1 | null;
  createdAt: EpochMilliseconds;
  updatedAt: EpochMilliseconds;
  completedAt: EpochMilliseconds | null;
}

export const attemptDispatchStatesV1 = [
  "not_started",
  "marker_persisted",
  "provider_accepted",
  "outcome_known",
  "pending_reconcile",
  "closed_not_billable",
] as const;
export type AttemptDispatchStateV1 = (typeof attemptDispatchStatesV1)[number];

export interface VideoTaskAttemptV1 {
  taskId: string;
  attemptId: string;
  attemptOrdinal: number;
  leaseFenceToken: string;
  dispatchState: AttemptDispatchStateV1;
  dispatchMarkerId: string | null;
  providerRequestId: string | null;
  startedAt: EpochMilliseconds;
  updatedAt: EpochMilliseconds;
}

export const billingAttemptStatesV1 = [
  "allocated",
  "marker_persisted",
  "provider_accepted",
  "outcome_known",
  "pending_reconcile",
  "closed_not_billable",
  "closed_billable",
] as const;
export type BillingAttemptStateV1 = (typeof billingAttemptStatesV1)[number];

export interface BillingAttemptV1 {
  attemptId: string;
  reservationId: string;
  productRequestId: string;
  taskId: string;
  attemptOrdinal: number;
  provider: string;
  channelId: string;
  fulfillmentPlanHash: string;
  requestFingerprint: string;
  state: BillingAttemptStateV1;
  providerRequestId: string | null;
  billability: "unknown" | "not_dispatched" | "definitive_not_billable" | "billable";
  revision: number;
}

export interface MarkDispatchInputV1 {
  reservationId: string;
  productRequestId: string;
  taskId: string;
  attemptId: string;
  attemptOrdinal: number;
  provider: string;
  channelId: string;
  fulfillmentPlanHash: string;
  requestFingerprint: string;
  leaseFenceToken: string;
  idempotencyKey: string;
}

export interface BindProviderAcceptanceInputV1 {
  reservationId: string;
  attemptId: string;
  providerRequestId: string;
  authenticatedResponseEvidenceId: string;
  leaseFenceToken: string;
  idempotencyKey: string;
}

export const workerLivenessStatesV1 = ["fresh", "stale", "absent", "invalid"] as const;
export const workerAdmissionStatesV1 = [
  "starting",
  "accepting",
  "draining",
  "drained",
] as const;
export const workerHealthStatesV1 = ["healthy", "degraded", "unhealthy"] as const;
export const observedMetricSupportLevelsV1 = ["exact", "derived", "unsupported"] as const;
export const workerQueueAccuraciesV1 = ["exact", "derived", "unavailable"] as const;

export type WorkerLivenessV1 = (typeof workerLivenessStatesV1)[number];
export type WorkerAdmissionV1 = (typeof workerAdmissionStatesV1)[number];
export type WorkerHealthV1 = (typeof workerHealthStatesV1)[number];
export type ObservedMetricSupportV1 = (typeof observedMetricSupportLevelsV1)[number];
export type WorkerQueueAccuracyV1 = (typeof workerQueueAccuraciesV1)[number];

export type ObservedMetricV1<T> =
  | {
      value: T;
      support: Exclude<ObservedMetricSupportV1, "unsupported">;
      source: string;
    }
  | {
      value: null;
      support: "unsupported";
      source: string;
    };

export interface WorkerNodeSnapshotV1 {
  contractVersion: typeof workerContractVersion;
  workerId: string | null;
  nodeId: string | null;
  incarnationId: string | null;
  role: "background" | null;
  hostname: string | null;
  processId: number | null;
  startedAt: EpochMilliseconds | null;
  heartbeatAt: EpochMilliseconds | null;
  snapshotAt: EpochMilliseconds;
  heartbeatAgeMs: number | null;
  liveness: WorkerLivenessV1;
  admission: WorkerAdmissionV1 | null;
  health: WorkerHealthV1;
  acceptingWork: boolean | null;
  releaseId: string | null;
  artifactSha256: string | null;
  schemaVersion: number | null;
  controlRevision: number | null;
  drainOperationId: string | null;
  capacity: {
    inFlight: ObservedMetricV1<number>;
    maxConcurrent: ObservedMetricV1<number>;
    available: ObservedMetricV1<number>;
  };
  drainOutstanding: ObservedMetricV1<boolean>;
}

export type WorkerQueueTaskKindV1 =
  | VideoTaskKindV1
  | "agent_run"
  | "relay_callback"
  | "billing_reconciliation"
  | "release_deployment";

interface WorkerQueueSnapshotBaseV1 {
  contractVersion: typeof workerContractVersion;
  queueKey: string;
  taskKind: WorkerQueueTaskKindV1;
  snapshotAt: EpochMilliseconds;
  source: string;
}

type UnavailableWorkerQueueMetricsV1 = {
  depth: null;
  leasedCount: null;
  oldestWaitMs: null;
  consumerCount: null;
  accuracy: "unavailable";
};

type AvailableWorkerQueueMetricsV1 = {
  depth: number | null;
  leasedCount: number | null;
  oldestWaitMs: number | null;
  consumerCount: number | null;
  accuracy: Exclude<WorkerQueueAccuracyV1, "unavailable">;
};

export type WorkerQueueSnapshotV1 = WorkerQueueSnapshotBaseV1 &
  (
    | ({
        supported: false;
      } & UnavailableWorkerQueueMetricsV1)
    | ({
        supported: true;
      } & (AvailableWorkerQueueMetricsV1 | UnavailableWorkerQueueMetricsV1))
  );

export type WorkerLeaseTaskKindV1 = VideoTaskKindV1 | "agent_run" | "relay_callback";

export interface WorkerLeaseSnapshotV1 {
  contractVersion: typeof workerContractVersion;
  queueKey: string;
  taskId: string;
  taskKind: WorkerLeaseTaskKindV1;
  workerId: string | null;
  ownerToken: string | null;
  attemptId: string | null;
  attemptOrdinal: number | null;
  leaseFenceToken: string | null;
  acquiredAt: EpochMilliseconds | null;
  heartbeatAt: EpochMilliseconds | null;
  expiresAt: EpochMilliseconds;
  renewCount: number | null;
  status: "active" | "expired";
  snapshotAt: EpochMilliseconds;
}

// ============ Relay 类型（中转站定义，创作台也用） ============
export const relayScopes = ["platform", "workspace"] as const;
export const relayProviders = ["volcano", "minimax", "autodl", "custom", "openai", "anthropic", "codex", "gemini", "azure"] as const;
export const relayEndpointTypes = [
  "video_generation",
  "video_upscale",
  "image_generation",
  "text",
  "embedding",
  "multimodal_embedding",
  "tts",
  "rerank",
  "transcription",
] as const;

export type RelayScope = (typeof relayScopes)[number];
export type RelayProvider = (typeof relayProviders)[number];
export type RelayEndpointType = (typeof relayEndpointTypes)[number];
export type RelayTaskStatus = "queued" | "running" | "enhancing" | "mocked" | "succeeded" | "failed" | "cancelled";

// ============ Billing 类型（共享计费层） ============
export const billingLedgerTypes = [
  "recharge",
  "deduct",
  "refund",
  "freeze",
  "release",
  "adjust",
  "allocate_to_workspace",
  "auto_allocate_to_default_workspace",
] as const;

export const billingLedgerStatuses = ["pending", "succeeded", "failed", "frozen", "released", "captured"] as const;

export const billingPlanStatuses = ["active", "retired", "draft"] as const;

export const billingSubscriptionStatuses = ["active", "expired", "cancelled", "pending"] as const;

export const apiTaskChargeModes = ["charge", "reserve", "none"] as const;

export type BillingLedgerType = (typeof billingLedgerTypes)[number];
export type BillingLedgerStatus = (typeof billingLedgerStatuses)[number];
export type BillingPlanStatus = (typeof billingPlanStatuses)[number];
export type BillingSubscriptionStatus = (typeof billingSubscriptionStatuses)[number];
export type ApiTaskChargeMode = (typeof apiTaskChargeModes)[number];

export interface BillingAccount {
  workspaceId: string;
  currency: string;
  balanceMicros: number;
  creditLimitMicros: number;
  frozenMicros: number;
  availableMicros: number;
  status: string;
  updateTime: number;
}

export interface BillingLedger {
  id: string;
  workspaceId: string;
  type: BillingLedgerType;
  amountMicros: number;
  status: BillingLedgerStatus;
  description: string;
  operatorUserId: number | null;
  metadata: any;
  createdAt: number;
}

export interface UsageRecord {
  id: string;
  workspaceId: string;
  endpointType: RelayEndpointType;
  model: string;
  units: number;
  unit: string;
  costMicros: number;
  status: string;
  apiKeyId: string | null;
  channelId: string | null;
  createdAt: number;
}

export interface BillingPlan {
  id: string;
  name: string;
  status: BillingPlanStatus;
  priceMicros: number;
  currency: string;
  billingCycle: string;
  quotaMicros: number;
}

export interface WorkspacePlanSubscription {
  id: string;
  workspaceId: string;
  planId: string;
  status: BillingSubscriptionStatus;
  startAt: number;
  expireAt: number | null;
}

export interface PricingRule {
  id: string;
  name: string;
  scope: RelayScope;
  workspaceId: string | null;
  endpointType: RelayEndpointType;
  provider: RelayProvider | null;
  model: string | null;
  unit: string;
  unitPriceMicros: number;
  currency: string;
  ruleConfig: any;
  disabled: number;
}

// ============ 计费操作输入类型 ============
export interface MoneyOperationInput {
  workspaceId: string;
  amountMicros: number;
  description: string;
  operatorUserId?: number | null;
  metadata?: any;
  idempotencyKey?: string;
}

export interface DeductWorkspaceInput extends MoneyOperationInput {
  reservationId?: string;
}

export interface ReleaseWorkspaceInput extends MoneyOperationInput {
  reservationId?: string;
}

export interface SetWorkspaceCreditLimitInput {
  workspaceId: string;
  creditLimitMicros: number;
}

export interface RecordUsageInput {
  workspaceId: string;
  endpointType: RelayEndpointType;
  model: string;
  units: number;
  unit: string;
  costMicros: number;
  status: string;
  apiKeyId?: string | null;
  channelId?: string | null;
  description?: string;
  operatorUserId?: number | null;
  metadata?: any;
}

export interface ResolvePricingInput {
  endpointType: RelayEndpointType;
  model: string;
  workspaceId: string;
}

export interface ApiTaskChargeInput extends ResolvePricingInput {
  units: number;
  unit: string;
  costMicros?: number;
  chargeMode: ApiTaskChargeMode;
  apiKeyId?: string | null;
  channelId?: string | null;
  description?: string;
  operatorUserId?: number | null;
  metadata?: any;
}

export interface ApiTaskChargeResult {
  usageRecordId: string;
  ledgerId: string;
  costMicros: number;
  status: string;
}

export interface BillingState {
  account: BillingAccount;
  recentLedger: BillingLedger[];
  subscriptions: WorkspacePlanSubscription[];
}

export interface VideoRouteConfig {
  /** Canonical route capability name used by the model catalog. */
  resolutions?: string[];
  /** Backward-compatible explicit native capability name. */
  nativeResolutions?: string[];
  maxNativeResolution?: string | null;
  /**
   * 超分组合映射名(增强链路成片的用户可见名称)。只存 routeConfig JSON,
   * 不单独建列;普通映射名走 o_model_route.displayName 列。
   */
  enhanceDisplayName?: string;
}

// ============ Relay Channel 类型 ============
export interface RelayChannel {
  id: string;
  name: string;
  provider: RelayProvider;
  endpointType: RelayEndpointType;
  baseUrl: string | null;
  credentialRef: string | null;
  credentialCiphertext?: string | null;
  config: Record<string, unknown>;
  timeoutMs: number;
  routeConfig?: VideoRouteConfig | null;
}

export interface CreateRelayTaskInput {
  endpointType: RelayEndpointType;
  requestPayload: Record<string, unknown>;
  apiKeyId?: string | null;
  /** Trusted server-side actor identity; never copy this from request bodies. */
  principalId?: string | null;
  /** 可信的实际提交用户 ID；只允许服务端调用方注入。 */
  actorUserId?: number | null;
  workspaceId?: string | null;
  projectId?: number | null;
  requestId?: string | null;
  model?: string | null;
  provider?: RelayProvider | null;
}
